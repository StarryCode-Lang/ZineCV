//! Browser host assembly. Store/engine rules are never reimplemented here.
use super::store::WebStore;
use base64::Engine;
use serde::{de::DeserializeOwned, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use wasm_bindgen::prelude::*;
use zinecv_contracts::{AppError, AuthorityCursor, ErrorCode};
const DOCUMENT: &str = "workspace-default-document";

fn invalid(message: impl Into<String>) -> JsValue {
    super::error(AppError::new(ErrorCode::Validation, message, false))
}
fn field<T: DeserializeOwned>(args: &Value, key: &str) -> Result<T, JsValue> {
    serde_json::from_value(args[key].clone()).map_err(|error| invalid(format!("{key}: {error}")))
}
fn value<T: Serialize>(result: T) -> Result<Value, JsValue> {
    serde_json::to_value(result).map_err(|error| invalid(error.to_string()))
}

#[wasm_bindgen]
impl WebStore {
    pub fn invoke(&mut self, command: &str, args: &str) -> Result<String, JsValue> {
        let args: Value = serde_json::from_str(args).map_err(|error| invalid(error.to_string()))?;
        if command == "restore_database_backup" {
            let result = self.restore(&args["payload"].to_string())?;
            self.token = None;
            let values: (u32, u32) =
                serde_json::from_str(&result).map_err(|error| invalid(error.to_string()))?;
            return Ok(json!({ "schemaVersion": values.0, "unavailableSecretCount": values.1, "requiresRelogin": true,
                "preRestoreBackupPath": format!("OPFS {}", self.last_restore_snapshot.as_deref().unwrap_or_default()) }).to_string());
        }
        let store = self.store.as_mut().ok_or_else(|| invalid("Store closed"))?;
        let token = self.token.clone().unwrap_or_default();
        let account = store.session_account(&token).map_err(super::error)?;
        let actor = account
            .as_ref()
            .map(|account| format!("account:{}", account.id))
            .unwrap_or_else(|| "local-user".into());
        let account_id = || {
            account
                .as_ref()
                .map(|value| value.id.as_str())
                .ok_or_else(|| {
                    super::error(AppError::new(
                        ErrorCode::Permission,
                        "请先登录本机账户",
                        false,
                    ))
                })
        };
        macro_rules! result {
            ($call:expr) => {
                value($call.map_err(super::error)?)?
            };
        }
        macro_rules! text {
            ($key:expr) => {
                field::<String>(&args, $key)?
            };
        }
        let output = match command {
            "document_state" => {
                let (cursor, document) = store
                    .load_active_document(DOCUMENT)
                    .map_err(super::error)?
                    .ok_or_else(|| invalid("Document missing"))?;
                json!({ "cursor": cursor, "document": document })
            }
            "apply_document_command" => {
                result!(store.apply_command(&actor, field(&args, "envelope")?))
            }
            "version_graph_detailed" => result!(store.load_version_graph_detailed(DOCUMENT)),
            "version_commit_detail" => {
                result!(store.load_commit_detail(DOCUMENT, &text!("commitId")))
            }
            "commit_version" => {
                result!(store.commit_draft(&field(&args, "cursor")?, &text!("message")))
            }
            "create_version_branch" => {
                result!(store.create_branch_from_current(&field(&args, "cursor")?, &text!("name")))
            }
            "switch_version_branch" => result!(store.switch_branch(
                &field(&args, "cursor")?,
                &text!("branchId"),
                field(&args, "discardUncommitted")?
            )),
            "load_history_commit" => result!(store.load_commit_into_draft(
                &field(&args, "cursor")?,
                &text!("commitId"),
                field(&args, "confirmed")?
            )),
            "delete_version_commit" => result!(store.delete_commit(
                &field(&args, "cursor")?,
                &text!("commitId"),
                field(&args, "confirmed")?
            )),
            "delete_version_branch" => result!(store.delete_branch(
                &field(&args, "cursor")?,
                &text!("branchId"),
                field(&args, "confirmed")?
            )),
            "replace_version_store" => {
                let replacement = &args["replacement"];
                let branches: Vec<zinecv_storage::storage::ReplaceBranch> =
                    field(replacement, "branches")?;
                let commits: Vec<zinecv_storage::storage::ReplaceCommit> =
                    field(replacement, "commits")?;
                result!(store.replace_version_store(
                    &field(&args, "cursor")?,
                    &field::<String>(replacement, "currentBranchId")?,
                    &branches,
                    &commits
                ))
            }
            "switch_editing_context" => {
                let request: zinecv_contracts::SwitchEditingContextRequest =
                    field(&args, "request")?;
                result!(store.switch_editing_context(
                    &request.expected_cursor,
                    request.source_kind,
                    &request.source_id,
                    request.initial_document.as_ref()
                ))
            }
            "export_database_backup" => result!(store.export_database_backup()),
            "read_setting" => result!(store.read_setting(&text!("key"))),
            "write_setting" => result!(store.write_setting(
                &text!("key"),
                field::<Option<String>>(&args, "value")?.as_deref()
            )),
            "read_imported_template_catalog" => result!(store.read_imported_template_catalog()),
            "write_imported_template_catalog" => result!(store.write_imported_template_catalog(
                &text!("payloadJson"),
                field(&args, "expectedRevision")?
            )),
            "bootstrap_template_activity" => {
                result!(store.bootstrap_template_activity(&text!("legacyJson")))
            }
            "update_template_activity" => {
                result!(store.update_template_activity(&text!("id"), &text!("action")))
            }
            "register_account" => {
                result!(store.register_account(&text!("email"), &text!("password")))
            }
            "login_account" => {
                let new_token = store
                    .login_account(&text!("email"), &text!("password"))
                    .map_err(super::error)?;
                let result = result!(store.session_account(&new_token));
                if !token.is_empty() {
                    store.logout_account(&token).map_err(super::error)?;
                }
                self.token = Some(new_token);
                result
            }
            "logout_account" => {
                if !token.is_empty() {
                    store.logout_account(&token).map_err(super::error)?;
                }
                self.token = None;
                Value::Null
            }
            "current_account" => value(account.as_ref())?,
            "store_provider_key" => result!(store.store_provider_key(
                &token,
                "primary",
                &text!("name"),
                &text!("baseUrl"),
                &text!("model"),
                &text!("key")
            )),
            "provider_profile" => result!(store.provider_profile(&token, "primary")),
            "clear_provider" => result!(store.clear_provider(&token, "primary")),
            "bootstrap_agent_sessions" => {
                result!(store.bootstrap_agent_sessions(account_id()?, &text!("legacyJson")))
            }
            "replace_agent_sessions" => result!(store.replace_agent_sessions(
                account_id()?,
                field(&args, "expectedRevision")?,
                &text!("payloadJson")
            )),
            "list_agent_runs" => result!(store.list_agent_runs(account_id()?)),
            #[cfg(feature = "agent")]
            "agent_selected_context" => {
                account_id()?;
                result!(zinecv_agent::agent_context::selected_context(
                    store,
                    &field(&args, "expectedCursor")?,
                    &field::<Vec<String>>(&args, "referenceIds")?
                ))
            }
            "create_import_draft" => result!(store.create_import_draft(&field(&args, "request")?)),
            "get_import_draft" => result!(store.read_import_draft(&text!("draftId"))),
            "transition_import_draft" => {
                result!(store.transition_import_draft(&field(&args, "request")?))
            }
            "apply_import" => result!(store.apply_import(&actor, &field(&args, "request")?)),
            "inspect_legacy_migration" => value(zinecv_storage::migration::inspect(&field(
                &args, "request",
            )?))?,
            "dry_run_legacy_migration" => value(zinecv_storage::migration::dry_run(&field(
                &args, "request",
            )?))?,
            "commit_legacy_migration" => {
                result!(store.commit_legacy_migration(&actor, &field(&args, "request")?))
            }
            "inspect_legacy_identity_conflicts" => {
                result!(store.inspect_legacy_identity_conflicts(&field(&args, "request")?))
            }
            "list_agent_proposals" => result!(store.list_agent_proposals(account_id()?)),
            "confirm_proposal" => {
                result!(store.confirm_agent_proposal(account_id()?, &field(&args, "request")?))
            }
            "reject_proposal" => {
                result!(store.reject_agent_proposal(account_id()?, &field(&args, "request")?))
            }
            "undo_confirmed_proposal" => {
                result!(store.undo_agent_proposal(account_id()?, &field(&args, "request")?))
            }
            "store_avatar_asset" => {
                let cursor: AuthorityCursor = field(&args, "cursor")?;
                store
                    .validate_active_cursor(&cursor)
                    .map_err(super::error)?;
                let data_url = text!("dataUrl");
                let (mime, encoded) = data_url
                    .strip_prefix("data:")
                    .and_then(|value| value.split_once(";base64,"))
                    .ok_or_else(|| invalid("Avatar must be a data URL"))?;
                if encoded.len() > 8 * 1024 * 1024 || !mime.starts_with("image/") {
                    return Err(invalid("Invalid avatar size or type"));
                }
                let bytes = base64::engine::general_purpose::STANDARD
                    .decode(encoded)
                    .map_err(|_| invalid("Invalid avatar encoding"))?;
                let hash = format!("{:x}", Sha256::digest(&bytes));
                store
                    .put_resource(&hash, mime, &bytes, None)
                    .map_err(super::error)?;
                store
                    .create_resource_lease(std::slice::from_ref(&hash), 300)
                    .map_err(super::error)?;
                json!({ "hash": hash, "mime": mime, "dataUrl": data_url })
            }
            "read_avatar_asset" => {
                let hash = text!("hash");
                let (mime, bytes) = store
                    .read_resource_bytes(&hash)
                    .map_err(super::error)?
                    .ok_or_else(|| invalid("Avatar missing"))?;
                store
                    .create_resource_lease(std::slice::from_ref(&hash), 300)
                    .map_err(super::error)?;
                json!({ "hash": hash, "mime": mime, "dataUrl": format!("data:{mime};base64,{}", base64::engine::general_purpose::STANDARD.encode(bytes)) })
            }
            #[cfg(feature = "engine")]
            "render_document_preview"
            | "render_document_export"
            | "export_document_pdf"
            | "fit_document_one_page" => {
                let cursor: AuthorityCursor = field(&args, "cursor")?;
                let (document, avatar) = store.freeze_export(&cursor).map_err(super::error)?;
                let fonts = zinecv_engine::bundled_font_bytes();
                let date = zinecv_engine::DEFAULT_REFERENCE_DATE;
                let resource_hashes = [
                    zinecv_engine::FONT_REGULAR_BYTES,
                    zinecv_engine::FONT_HEAVY_BYTES,
                    zinecv_engine::FONT_ICON_BYTES,
                    zinecv_engine::FONT_HEBREW_BYTES,
                    zinecv_engine::template_source_bytes(),
                ]
                .map(|bytes| format!("{:x}", Sha256::digest(bytes)));
                let render_key = zinecv_contracts::canonical_hash(&json!({ "protocolVersion": 1, "engineVersion": "zinecv-typst-0.15.1-engine-2", "document": document, "cursor": cursor, "resources": resource_hashes, "date": date,
                    "operation": command, "product": args["product"], "selectedPages": args["selectedPages"], "dpi": args["dpi"] })).map_err(super::error)?;
                match command {
                    "render_document_preview" => {
                        json!({ "cursor": cursor, "renderKey": render_key, "data": zinecv_engine::render_preview_with_resources(&document, avatar, &fonts, date).map_err(super::error)? })
                    }
                    "fit_document_one_page" => {
                        json!({ "cursor": cursor, "renderKey": render_key, "plan": zinecv_engine::fit::solve_one_page(&document, avatar, &fonts, date, || false).map_err(super::error)? })
                    }
                    _ => {
                        let selected: Option<Vec<u32>> = field(&args, "selectedPages")?;
                        let product = if command == "export_document_pdf" {
                            Some(zinecv_contracts::ExportProduct::Pdf)
                        } else {
                            field(&args, "product")?
                        };
                        let export = zinecv_engine::export::render_frozen_export(
                            &document,
                            avatar,
                            &fonts,
                            date,
                            selected.as_deref(),
                            field::<Option<u16>>(&args, "dpi")?.unwrap_or(192),
                            product,
                        )
                        .map_err(super::error)?
                        .into_payload();
                        json!({ "cursor": cursor, "renderKey": render_key, "data": export })
                    }
                }
            }
            _ => {
                return Err(super::error(AppError::new(
                    ErrorCode::Permission,
                    format!("当前浏览器不提供该能力：{command}"),
                    false,
                )))
            }
        };
        serde_json::to_string(&output).map_err(|error| invalid(error.to_string()))
    }
}
