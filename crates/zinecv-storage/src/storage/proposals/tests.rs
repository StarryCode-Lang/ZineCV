use super::*;

use zinecv_contracts::{
    AgentProposalDraftItem, BasicPatch, ConfirmProposalRequest, RejectAgentProposalRequest,
    UndoConfirmedProposalRequest,
};
use zinecv_domain::default_resume_document;

const ACCOUNT: &str = "proposal-account-a";
const RUN: &str = "proposal-run-fixture";
const DOCUMENT: &str = "proposal-document-fixture";
const CONTEXT: &str = "proposal-context-fixture";

fn store_with_run(reference_ids: &[&str]) -> (Store, AuthorityCursor) {
    let mut store = Store::open_in_memory().expect("isolated SQLite store");
    store
        .connection
        .execute(
            "INSERT INTO accounts(id, email, salt, password_hash)
                 VALUES (?1, 'proposal@example.invalid', 'synthetic-salt', 'synthetic-hash')",
            [ACCOUNT],
        )
        .expect("synthetic account");
    let document = default_resume_document(DOCUMENT).expect("synthetic document");
    store
        .initialize_document(&document, CONTEXT)
        .expect("initialize synthetic document");
    let cursor = store
        .load_cursor(DOCUMENT, CONTEXT)
        .expect("load cursor")
        .expect("active cursor");
    store
        .connection
        .execute(
            "INSERT INTO agent_runs(
                   id, account_id, session_id, document_id, context_id, revision,
                   branch_id, head_id, reference_ids_json, status, started_at
                 ) VALUES (?1, ?2, 'proposal-session', ?3, ?4, ?5, ?6, ?7, ?8, 'completed', 0)",
            params![
                RUN,
                ACCOUNT,
                DOCUMENT,
                CONTEXT,
                cursor.revision,
                cursor.branch_id,
                cursor.head_id,
                serde_json::to_string(reference_ids).expect("references")
            ],
        )
        .expect("synthetic completed run");
    (store, cursor)
}

fn name_draft(proposal_id: &str, proposed_name: &str) -> AgentProposalDraft {
    AgentProposalDraft {
        id: proposal_id.into(),
        explanation: "只用于事务回归的合成提议".into(),
        items: vec![AgentProposalDraftItem {
            id: format!("{proposal_id}-item-1"),
            summary: "更新姓名字段".into(),
            reference_id: "basic:name".into(),
            change: ProposalChange::UpdateBasic {
                patch: BasicPatch {
                    name: Some(proposed_name.into()),
                    ..BasicPatch::default()
                },
            },
        }],
    }
}

fn create_one(
    store: &mut Store,
    cursor: &AuthorityCursor,
    proposal_id: &str,
) -> AgentProposalRecord {
    store
        .create_agent_proposals(ACCOUNT, RUN, cursor, &[name_draft(proposal_id, "建议姓名")])
        .expect("persist pending proposal")
        .into_iter()
        .next()
        .expect("one proposal")
}

fn confirm_request(record: &AgentProposalRecord, command_id: &str) -> ConfirmProposalRequest {
    ConfirmProposalRequest {
        command_id: command_id.into(),
        cursor: record.cursor.clone(),
        proposal_id: record.id.clone(),
        accepted_item_ids: record.items.iter().map(|item| item.id.clone()).collect(),
    }
}

fn avatar_draft(id: &str, hash: &str) -> AgentProposalDraft {
    AgentProposalDraft {
        id: id.into(),
        explanation: "合成头像提议".into(),
        items: vec![AgentProposalDraftItem {
            id: format!("{id}-avatar"),
            summary: "更新已选头像".into(),
            reference_id: "basic:avatar".into(),
            change: ProposalChange::UpdateBasic {
                patch: BasicPatch {
                    avatar_asset_id: Some(hash.into()),
                    ..BasicPatch::default()
                },
            },
        }],
    }
}

fn candidate_avatar(store: &Store) -> String {
    use base64::Engine;
    use sha2::{Digest, Sha256};
    let bytes = base64::engine::general_purpose::STANDARD.decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jM90AAAAASUVORK5CYII=").unwrap();
    let hash = format!("{:x}", Sha256::digest(&bytes));
    store
        .put_resource(&hash, "image/png", &bytes, None)
        .unwrap();
    hash
}

#[test]
fn avatar_proposal_retains_pending_and_undo_assets_through_gc() {
    use base64::Engine;
    use sha2::{Digest, Sha256};
    let (mut store, cursor) = store_with_run(&["basic:avatar"]);
    let old_bytes = base64::engine::general_purpose::STANDARD.decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=").unwrap();
    let old_hash = format!("{:x}", Sha256::digest(&old_bytes));
    store
        .put_resource(&old_hash, "image/png", &old_bytes, None)
        .unwrap();
    let result = store
        .apply_command(
            ACCOUNT,
            CommandEnvelope {
                protocol_version: 1,
                command_id: "avatar-initial-fixture".into(),
                document_id: DOCUMENT.into(),
                context_id: CONTEXT.into(),
                expected_revision: cursor.revision,
                expected_branch_id: cursor.branch_id,
                expected_head_id: cursor.head_id,
                payload: DomainCommand::UpdateBasic {
                    patch: BasicPatch {
                        avatar_asset_id: Some(old_hash.clone()),
                        ..BasicPatch::default()
                    },
                },
            },
        )
        .unwrap();
    let cursor = result.cursor;
    store
        .connection
        .execute(
            "UPDATE agent_runs SET revision=?1 WHERE id=?2",
            params![cursor.revision, RUN],
        )
        .unwrap();
    let hash = candidate_avatar(&store);
    let record = store
        .create_agent_proposals(ACCOUNT, RUN, &cursor, &[avatar_draft("avatar-gc", &hash)])
        .unwrap()
        .remove(0);
    assert_eq!(store.collect_unreferenced_resources().unwrap(), 0);
    assert_eq!(
        store
            .load_current(DOCUMENT, CONTEXT)
            .unwrap()
            .unwrap()
            .1
            .basic
            .avatar_asset_id
            .as_deref(),
        Some(old_hash.as_str())
    );
    let receipt = store
        .confirm_agent_proposal(ACCOUNT, &confirm_request(&record, "avatar-confirm"))
        .unwrap();
    assert_eq!(
        store
            .load_current(DOCUMENT, CONTEXT)
            .unwrap()
            .unwrap()
            .1
            .basic
            .avatar_asset_id
            .as_deref(),
        Some(hash.as_str())
    );
    let owners: i64 = store
        .connection
        .query_row(
            "SELECT COUNT(*) FROM resource_refs WHERE resource_hash=?1 AND owner_kind='draft'",
            [&hash],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(owners, 1);
    assert_eq!(store.collect_unreferenced_resources().unwrap(), 0);
    store
        .undo_agent_proposal(
            ACCOUNT,
            &UndoConfirmedProposalRequest {
                command_id: "avatar-undo".into(),
                cursor: receipt.cursor,
                receipt_id: receipt.id,
            },
        )
        .unwrap();
    assert_eq!(
        store
            .load_current(DOCUMENT, CONTEXT)
            .unwrap()
            .unwrap()
            .1
            .basic
            .avatar_asset_id
            .as_deref(),
        Some(old_hash.as_str())
    );
    assert_eq!(store.collect_unreferenced_resources().unwrap(), 1);
}

#[test]
fn avatar_proposal_missing_assets_and_cross_context_do_not_write() {
    let (mut store, cursor) = store_with_run(&["basic:avatar"]);
    assert!(store
        .create_agent_proposals(
            ACCOUNT,
            RUN,
            &cursor,
            &[avatar_draft("avatar-missing", &"a".repeat(64))]
        )
        .is_err());
    assert!(store
        .list_agent_proposals(ACCOUNT)
        .unwrap()
        .pending
        .is_empty());
    let hash = candidate_avatar(&store);
    let record = store
        .create_agent_proposals(
            ACCOUNT,
            RUN,
            &cursor,
            &[avatar_draft("avatar-context", &hash)],
        )
        .unwrap()
        .remove(0);
    let mut request = confirm_request(&record, "avatar-wrong-context");
    request.cursor.context_id = "another-context".into();
    assert!(matches!(
        store.confirm_agent_proposal(ACCOUNT, &request),
        Err(StorageError::Conflict(_))
    ));
    assert_eq!(store.collect_unreferenced_resources().unwrap(), 0);
    store
        .connection
        .execute(
            "UPDATE agent_proposals SET expires_at='2000-01-01T00:00:00.000Z' WHERE id=?1",
            [&record.id],
        )
        .unwrap();
    assert!(store
        .confirm_agent_proposal(ACCOUNT, &confirm_request(&record, "avatar-expired"))
        .is_err());
    assert_eq!(store.collect_unreferenced_resources().unwrap(), 1);
    assert_eq!(
        store
            .load_current(DOCUMENT, CONTEXT)
            .unwrap()
            .unwrap()
            .1
            .basic
            .avatar_asset_id,
        None
    );
}

#[test]
fn avatar_confirm_cancel_race_has_one_durable_winner_after_reopen() {
    let (store, cursor) = store_with_run(&["basic:avatar"]);
    let hash = candidate_avatar(&store);
    let mut store = store;
    let record = store
        .create_agent_proposals(ACCOUNT, RUN, &cursor, &[avatar_draft("avatar-race", &hash)])
        .unwrap()
        .remove(0);
    let path = std::env::temp_dir().join(format!(
        "zinecv-avatar-race-{}-{}.db",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    store.backup_to(&path).unwrap();
    drop(store);
    // Open connections before the barrier: initialization may acquire a
    // SQLite write lock and must not strand the other thread on failure.
    let mut confirm_store = Store::open(&path).unwrap();
    let mut cancel_store = Store::open(&path).unwrap();
    let barrier = std::sync::Arc::new(std::sync::Barrier::new(2));
    let confirm_barrier = barrier.clone();
    let request = confirm_request(&record, "avatar-race-confirm");
    let confirm = std::thread::spawn(move || {
        confirm_barrier.wait();
        confirm_store.confirm_agent_proposal(ACCOUNT, &request)
    });
    let proposal_id = record.id;
    let cancel = std::thread::spawn(move || {
        barrier.wait();
        cancel_store.reject_agent_proposal(
            ACCOUNT,
            &RejectAgentProposalRequest {
                command_id: "avatar-race-cancel".into(),
                proposal_id,
            },
        )
    });
    let results = [confirm.join().unwrap(), cancel.join().unwrap()];
    assert_eq!(results.iter().filter(|result| result.is_ok()).count(), 1);
    let winner = results.into_iter().find_map(Result::ok).unwrap();
    let mut store = Store::open(&path).unwrap();
    assert!(store
        .list_agent_proposals(ACCOUNT)
        .unwrap()
        .pending
        .is_empty());
    let document = store.load_current(DOCUMENT, CONTEXT).unwrap().unwrap().1;
    assert_eq!(
        document.basic.avatar_asset_id.is_some(),
        winner.status == AgentProposalStatus::Confirmed
    );
    // The verified backup carries a short resource lease. A cancelled
    // proposal must still respect that lease before ordinary GC resumes.
    assert_eq!(store.collect_unreferenced_resources().unwrap(), 0);
    store
        .connection
        .execute("UPDATE resource_leases SET expires_at=0", [])
        .unwrap();
    assert_eq!(
        store.collect_unreferenced_resources().unwrap(),
        usize::from(winner.status == AgentProposalStatus::Rejected)
    );
    drop(store);
    let _ = std::fs::remove_file(&path);
    let _ = std::fs::remove_file(path.with_extension("db-wal"));
    let _ = std::fs::remove_file(path.with_extension("db-shm"));
}

#[test]
fn proposal_confirm_is_atomic_idempotent_and_undoable() {
    let (mut store, cursor) = store_with_run(&["basic:name"]);
    let record = create_one(&mut store, &cursor, "proposal-same-name-id-a");
    assert_eq!(record.status, AgentProposalStatus::Pending);
    assert_eq!(record.items[0].before_value, json!({"name":""}));
    assert_eq!(record.items[0].after_value, json!({"name":"建议姓名"}));
    let other_inbox = store
        .list_agent_proposals("another-account")
        .expect("other account listing");
    assert!(other_inbox.pending.is_empty());
    assert!(other_inbox.undoable.is_empty());

    let request = confirm_request(&record, "proposal-confirm-command-a");
    let receipt = store
        .confirm_agent_proposal(ACCOUNT, &request)
        .expect("confirm proposal");
    assert_eq!(receipt.status, AgentProposalStatus::Confirmed);
    assert!(!receipt.idempotent_replay);
    let replay = store
        .confirm_agent_proposal(ACCOUNT, &request)
        .expect("repeat confirmation");
    assert!(replay.idempotent_replay);
    assert_eq!(replay.id, receipt.id);
    let (confirmed_revision, confirmed) = store
        .load_current(DOCUMENT, CONTEXT)
        .expect("load confirmed draft")
        .expect("document exists");
    assert_eq!(confirmed.basic.name, "建议姓名");
    assert_eq!(confirmed_revision, 1);
    let inbox = store
        .list_agent_proposals(ACCOUNT)
        .expect("account proposal inbox");
    assert!(inbox.pending.is_empty());
    assert_eq!(inbox.undoable.len(), 1);
    assert_eq!(inbox.undoable[0].receipt_id, receipt.id);
    assert_eq!(inbox.undoable[0].session_id, record.session_id);
    let confirmed_cursor = store
        .load_cursor(DOCUMENT, CONTEXT)
        .expect("load confirmed cursor")
        .expect("confirmed cursor exists");

    let undo = UndoConfirmedProposalRequest {
        command_id: "proposal-undo-command-a".into(),
        cursor: confirmed_cursor,
        receipt_id: receipt.id,
    };
    let undone = store
        .undo_agent_proposal(ACCOUNT, &undo)
        .expect("undo proposal");
    assert_eq!(undone.status, AgentProposalStatus::Undone);
    let (after_undo_revision, after_undo) = store
        .load_current(DOCUMENT, CONTEXT)
        .expect("load undone draft")
        .expect("document exists");
    assert_eq!(after_undo.basic.name, "");
    assert_eq!(after_undo_revision, 2);
    assert!(store
        .list_agent_proposals(ACCOUNT)
        .expect("proposal inbox after undo")
        .undoable
        .is_empty());
    let replay = store
        .undo_agent_proposal(ACCOUNT, &undo)
        .expect("repeat undo");
    assert!(replay.idempotent_replay);
    assert_eq!(replay.id, undone.id);
}

#[test]
fn proposal_undo_refuses_to_overwrite_a_later_manual_edit() {
    let (mut store, cursor) = store_with_run(&["basic:name"]);
    let record = create_one(&mut store, &cursor, "proposal-manual-edit");
    let receipt = store
        .confirm_agent_proposal(
            ACCOUNT,
            &confirm_request(&record, "proposal-confirm-manual-edit"),
        )
        .expect("confirm");
    let manual = store
        .apply_command(
            "local-anonymous",
            CommandEnvelope {
                protocol_version: 1,
                command_id: "proposal-manual-command".into(),
                document_id: receipt.cursor.document_id.clone(),
                context_id: receipt.cursor.context_id.clone(),
                expected_revision: receipt.cursor.revision.clone(),
                expected_branch_id: receipt.cursor.branch_id.clone(),
                expected_head_id: receipt.cursor.head_id.clone(),
                payload: DomainCommand::UpdateBasic {
                    patch: BasicPatch {
                        name: Some("手工后续编辑".into()),
                        ..BasicPatch::default()
                    },
                },
            },
        )
        .expect("manual edit");
    let error = store
        .undo_agent_proposal(
            ACCOUNT,
            &UndoConfirmedProposalRequest {
                command_id: "proposal-undo-manual-edit".into(),
                cursor: manual.cursor,
                receipt_id: receipt.id,
            },
        )
        .expect_err("undo must conflict after a target edit");
    assert!(matches!(error, StorageError::Conflict(_)));
    assert_eq!(
        store
            .load_current(DOCUMENT, CONTEXT)
            .expect("load manual draft")
            .expect("document exists")
            .1
            .basic
            .name,
        "手工后续编辑"
    );
}

#[test]
fn failed_second_item_rolls_back_the_whole_confirmation() {
    let (mut store, cursor) = store_with_run(&["basic:name", "summary"]);
    let mut draft = name_draft("proposal-rollback", "不能半写入");
    draft.items.push(AgentProposalDraftItem {
        id: "proposal-rollback-item-2".into(),
        summary: "替换自我评价".into(),
        reference_id: "summary".into(),
        change: ProposalChange::SetSummaryBody {
            section_id: "legacy-section:summary".into(),
            body: vec![zinecv_contracts::RichBlock::Paragraph {
                children: vec![zinecv_contracts::Inline::Text {
                    text: "有效建议".into(),
                    marks: Vec::new(),
                }],
            }],
        },
    });
    let record = store
        .create_agent_proposals(ACCOUNT, RUN, &cursor, &[draft])
        .expect("persist valid two-item proposal")
        .remove(0);

    let mut tampered = record.items.clone();
    tampered[1].change = ProposalChange::SetSummaryBody {
        section_id: "legacy-section:summary".into(),
        body: vec![zinecv_contracts::RichBlock::Paragraph {
            children: vec![zinecv_contracts::Inline::Link {
                href: "javascript:alert(1)".into(),
                children: vec![zinecv_contracts::Inline::Text {
                    text: "invalid".into(),
                    marks: Vec::new(),
                }],
            }],
        }],
    };
    store
        .connection
        .execute(
            "UPDATE agent_proposals SET items_json = ?2 WHERE id = ?1",
            params![
                record.id,
                serde_json::to_string(&tampered).expect("serialize fixture")
            ],
        )
        .expect("install invalid synthetic second item");

    let error = store
        .confirm_agent_proposal(
            ACCOUNT,
            &ConfirmProposalRequest {
                command_id: "proposal-rollback-confirm".into(),
                cursor: cursor.clone(),
                proposal_id: record.id.clone(),
                accepted_item_ids: record.items.iter().map(|item| item.id.clone()).collect(),
            },
        )
        .expect_err("invalid second item must reject the whole transaction");
    assert!(matches!(error, StorageError::Domain(_)));
    let (unchanged_revision, unchanged) = store
        .load_current(DOCUMENT, CONTEXT)
        .expect("read unchanged document")
        .expect("document exists");
    assert_eq!(unchanged_revision, 0);
    assert_eq!(unchanged.basic.name, "");
    assert_eq!(
        store
            .connection
            .query_row(
                "SELECT status FROM agent_proposals WHERE id = ?1",
                [&record.id],
                |row| row.get::<_, String>(0),
            )
            .expect("proposal state"),
        "pending"
    );
    assert_eq!(
        store
            .connection
            .query_row("SELECT COUNT(*) FROM agent_proposal_receipts", [], |row| {
                row.get::<_, i64>(0)
            })
            .expect("receipt count"),
        0
    );
}

#[test]
fn rejecting_a_proposal_is_account_scoped_idempotent_and_does_not_edit_document() {
    let (mut store, cursor) = store_with_run(&["basic:name"]);
    let record = create_one(&mut store, &cursor, "proposal-reject");
    let request = RejectAgentProposalRequest {
        command_id: "proposal-reject-command".into(),
        proposal_id: record.id.clone(),
    };
    let receipt = store
        .reject_agent_proposal(ACCOUNT, &request)
        .expect("reject proposal");
    assert_eq!(receipt.status, AgentProposalStatus::Rejected);
    assert!(store
        .confirm_agent_proposal(
            "another-account",
            &confirm_request(&record, "cross-account")
        )
        .is_err());
    let replay = store
        .reject_agent_proposal(ACCOUNT, &request)
        .expect("repeat rejection");
    assert!(replay.idempotent_replay);
    let (current_revision, current) = store
        .load_current(DOCUMENT, CONTEXT)
        .expect("load document")
        .expect("document exists");
    assert_eq!(current_revision, 0);
    assert_eq!(current.basic.name, "");
}

fn single_item_draft(
    proposal_id: &str,
    reference_id: &str,
    change: ProposalChange,
    summary: &str,
) -> AgentProposalDraft {
    AgentProposalDraft {
        id: proposal_id.into(),
        explanation: "只用于事务回归的合成提议".into(),
        items: vec![AgentProposalDraftItem {
            id: format!("{proposal_id}-item-1"),
            summary: summary.into(),
            reference_id: reference_id.into(),
            change,
        }],
    }
}

#[test]
fn delete_entry_proposal_is_atomic_and_undoable() {
    use zinecv_contracts::{CommandEnvelope, DomainCommand, Entry};
    let (mut store, cursor) = store_with_run(&["entry:entry-1"]);
    // 默认文档各模块条目为空：先用领域命令加入一条经历，再提议删除它。
    let added = store
        .apply_command(
            "local-anonymous",
            CommandEnvelope {
                protocol_version: 1,
                command_id: "delete-entry-fixture-add".into(),
                document_id: cursor.document_id.clone(),
                context_id: cursor.context_id.clone(),
                expected_revision: cursor.revision.clone(),
                expected_branch_id: cursor.branch_id.clone(),
                expected_head_id: cursor.head_id.clone(),
                payload: DomainCommand::AddEntry {
                    section_id: "legacy-section:work".into(),
                    entry: Entry {
                        id: "entry-1".into(),
                        title: "工程师".into(),
                        role: String::new(),
                        department: String::new(),
                        city: String::new(),
                        start: "2024".into(),
                        end: String::new(),
                        college: None,
                        mode: None,
                        body: Vec::new(),
                    },
                },
            },
        )
        .expect("add fixture entry");
    store
        .connection
        .execute(
            "UPDATE agent_runs SET revision = ?1, head_id = ?2 WHERE id = ?3",
            rusqlite::params![added.cursor.revision, added.cursor.head_id, RUN],
        )
        .expect("sync run cursor to the advanced revision");
    let cursor = added.cursor.clone();
    let draft = single_item_draft(
        "proposal-delete-entry",
        "entry:entry-1",
        ProposalChange::DeleteEntry {
            entry_id: "entry-1".into(),
        },
        "删除已选经历",
    );
    let record = store
        .create_agent_proposals(ACCOUNT, RUN, &cursor, &[draft])
        .expect("persist delete proposal")
        .into_iter()
        .next()
        .expect("one proposal");
    let receipt = store
        .confirm_agent_proposal(ACCOUNT, &confirm_request(&record, "delete-entry-confirm"))
        .expect("confirm delete");
    let (_, after_delete) = store
        .load_current(DOCUMENT, CONTEXT)
        .expect("load after delete")
        .expect("document exists");
    assert!(after_delete.sections.iter().all(|section| match section {
        zinecv_contracts::Section::Entry(entry) => {
            entry.entries.iter().all(|entry| entry.id != "entry-1")
        }
        zinecv_contracts::Section::Summary(_) => true,
    }));
    let undo = UndoConfirmedProposalRequest {
        command_id: "delete-entry-undo".into(),
        cursor: receipt.cursor.clone(),
        receipt_id: receipt.id,
    };
    store
        .undo_agent_proposal(ACCOUNT, &undo)
        .expect("undo delete");
    let (_, after_undo) = store
        .load_current(DOCUMENT, CONTEXT)
        .expect("load after undo")
        .expect("document exists");
    assert!(after_undo.sections.iter().any(|section| match section {
        zinecv_contracts::Section::Entry(entry) => {
            entry.entries.iter().any(|entry| entry.id == "entry-1")
        }
        zinecv_contracts::Section::Summary(_) => false,
    }));
}

#[test]
fn apply_template_proposal_swaps_only_the_template_and_undo_reverts_it() {
    let (mut store, cursor) = store_with_run(&["template:legacy-v1"]);
    let (_, before) = store
        .load_current(DOCUMENT, CONTEXT)
        .expect("load before")
        .expect("document exists");
    let original_template = before.presentation.template_id.clone();
    let target = if original_template == "legacy-v1" {
        "clear-single-v1"
    } else {
        "legacy-v1"
    };
    let draft = single_item_draft(
        "proposal-apply-template",
        "template:legacy-v1",
        ProposalChange::ApplyTemplate {
            template_id: target.into(),
        },
        "切换到已选模板",
    );
    let record = store
        .create_agent_proposals(ACCOUNT, RUN, &cursor, &[draft])
        .expect("persist template proposal")
        .into_iter()
        .next()
        .expect("one proposal");
    let receipt = store
        .confirm_agent_proposal(ACCOUNT, &confirm_request(&record, "template-confirm"))
        .expect("confirm template switch");
    let (_, switched) = store
        .load_current(DOCUMENT, CONTEXT)
        .expect("load switched")
        .expect("document exists");
    assert_eq!(switched.presentation.template_id, target);
    assert_eq!(switched.basic.name, before.basic.name);
    let undo = UndoConfirmedProposalRequest {
        command_id: "template-undo".into(),
        cursor: receipt.cursor.clone(),
        receipt_id: receipt.id,
    };
    store
        .undo_agent_proposal(ACCOUNT, &undo)
        .expect("undo template switch");
    let (_, reverted) = store
        .load_current(DOCUMENT, CONTEXT)
        .expect("load reverted")
        .expect("document exists");
    assert_eq!(reverted.presentation.template_id, original_template);
}

#[test]
fn commit_version_side_effect_lands_in_the_same_transaction_and_survives_undo() {
    let (mut store, cursor) = store_with_run(&["basic:name", "draft:main"]);
    let name_draft = name_draft("proposal-version", "版本确认姓名");
    let mut combined = AgentProposalDraft {
        id: name_draft.id.clone(),
        explanation: name_draft.explanation.clone(),
        items: name_draft.items.clone(),
    };
    combined.items.push(AgentProposalDraftItem {
        id: "proposal-version-item-2".into(),
        summary: "确认后保存版本".into(),
        reference_id: "draft:main".into(),
        change: ProposalChange::CommitVersion {
            message: " 提议确认并保存版本 ".into(),
        },
    });
    let record = store
        .create_agent_proposals(ACCOUNT, RUN, &cursor, &[combined])
        .expect("persist combined proposal")
        .into_iter()
        .next()
        .expect("one proposal");
    let commits_before: i64 = store
        .connection
        .query_row("SELECT COUNT(*) FROM commits", [], |row| row.get(0))
        .expect("commit count");
    let receipt = store
        .confirm_agent_proposal(ACCOUNT, &confirm_request(&record, "version-confirm"))
        .expect("confirm with version side effect");
    let commits_after: i64 = store
        .connection
        .query_row("SELECT COUNT(*) FROM commits", [], |row| row.get(0))
        .expect("commit count after");
    assert_eq!(commits_after, commits_before + 1);
    assert!(receipt.cursor.head_id.is_some());
    let (_, committed) = store
        .load_current(DOCUMENT, CONTEXT)
        .expect("load committed draft")
        .expect("document exists");
    assert_eq!(committed.basic.name, "版本确认姓名");
    let draft_rows: i64 = store
        .connection
        .query_row(
            "SELECT COUNT(*) FROM drafts WHERE document_id = ?1",
            [DOCUMENT],
            |row| row.get(0),
        )
        .expect("draft rows");
    assert_eq!(draft_rows, 0);
    let undo = UndoConfirmedProposalRequest {
        command_id: "version-undo".into(),
        cursor: receipt.cursor.clone(),
        receipt_id: receipt.id,
    };
    store
        .undo_agent_proposal(ACCOUNT, &undo)
        .expect("undo content of versioned proposal");
    let (_, restored) = store
        .load_current(DOCUMENT, CONTEXT)
        .expect("load after undo")
        .expect("document exists");
    assert_eq!(restored.basic.name, "");
    let commits_final: i64 = store
        .connection
        .query_row("SELECT COUNT(*) FROM commits", [], |row| row.get(0))
        .expect("commit count final");
    assert_eq!(commits_final, commits_after);
}
