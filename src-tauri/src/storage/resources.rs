use std::collections::{BTreeMap, BTreeSet};
use std::sync::OnceLock;

use base64::Engine as _;
use rusqlite::{params, Connection, OptionalExtension, Transaction};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use super::{StorageError, StorageResult};
use crate::engine::{FONT_HEAVY_BYTES, FONT_ICON_BYTES, FONT_REGULAR_BYTES};

const MAX_TEMPLATE_PREVIEW_BYTES: usize = 32 * 1024 * 1024;
const OWNERSHIP_BACKFILL_MARKER: &str = "resource-ownership-backfilled-v1";

const ENGINE_SOURCE: &[u8] = include_bytes!("../engine.rs");
const TEMPLATE_SOURCE: &[u8] = include_bytes!("../engine/templates.typ");

fn sha256(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn engine_identities() -> &'static Value {
    static IDENTITIES: OnceLock<Value> = OnceLock::new();
    IDENTITIES.get_or_init(|| {
        let mut engine = Vec::new();
        engine.extend_from_slice(b"engine.rs\0");
        engine.extend_from_slice(ENGINE_SOURCE);
        engine.extend_from_slice(b"templates.typ\0");
        engine.extend_from_slice(TEMPLATE_SOURCE);

        let mut fonts = Vec::new();
        fonts.extend_from_slice(b"source-han-serif-cn-regular.otf\0");
        fonts.extend_from_slice(FONT_REGULAR_BYTES);
        fonts.extend_from_slice(b"source-han-serif-cn-heavy.ttf\0");
        fonts.extend_from_slice(FONT_HEAVY_BYTES);
        fonts.extend_from_slice(b"wondercv-iconfont.ttf\0");
        fonts.extend_from_slice(FONT_ICON_BYTES);

        json!({
            "engineSourceHash": sha256(&engine),
            "fontBundleHash": sha256(&fonts),
        })
    })
}

fn canonical_hash(value: &Value) -> StorageResult<String> {
    Ok(sha256(&serde_json::to_vec(value)?))
}

fn parse_preview_data_url(value: &str) -> StorageResult<Option<(String, Vec<u8>)>> {
    let Some((mime, encoded)) = value
        .strip_prefix("data:")
        .and_then(|value| value.split_once(";base64,"))
    else {
        return Ok(None);
    };
    if !mime.starts_with("image/")
        || mime.len() > 64
        || encoded.len() > MAX_TEMPLATE_PREVIEW_BYTES * 2
    {
        return Ok(None);
    }
    let Ok(bytes) = base64::engine::general_purpose::STANDARD.decode(encoded) else {
        return Ok(None);
    };
    if bytes.is_empty() || bytes.len() > MAX_TEMPLATE_PREVIEW_BYTES {
        return Ok(None);
    }
    Ok(Some((mime.to_string(), bytes)))
}

fn record_recovery(
    connection: &Connection,
    owner_kind: &str,
    owner_id: &str,
    resource_hash: Option<&str>,
    reason: &str,
) -> StorageResult<()> {
    connection.execute(
        "INSERT INTO resource_recovery_requirements(owner_kind, owner_id, resource_hash, reason)
         VALUES (?1, ?2, ?3, ?4)",
        params![owner_kind, owner_id, resource_hash, reason],
    )?;
    Ok(())
}

fn store_resource(
    connection: &Connection,
    hash: &str,
    mime: &str,
    bytes: &[u8],
) -> StorageResult<()> {
    if sha256(bytes) != hash {
        return Err(StorageError::HashMismatch);
    }
    connection.execute(
        "INSERT OR IGNORE INTO resources(hash, mime, bytes, size, license_ref)
         VALUES (?1, ?2, ?3, ?4, NULL)",
        params![hash, mime, bytes, bytes.len() as i64],
    )?;
    connection.execute(
        "DELETE FROM resource_recovery_requirements WHERE resource_hash = ?1",
        [hash],
    )?;
    Ok(())
}

fn resource_hashes_for_template(template: &Value) -> BTreeSet<String> {
    let mut hashes = BTreeSet::new();
    if let Some(hash) = template
        .get("previewAssetId")
        .and_then(Value::as_str)
        .filter(|value| value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit()))
    {
        hashes.insert(hash.to_ascii_lowercase());
    }
    if let Some(resources) = template.get("resourceIds").and_then(Value::as_array) {
        for hash in resources
            .iter()
            .filter_map(Value::as_str)
            .filter(|value| value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit()))
        {
            hashes.insert(hash.to_ascii_lowercase());
        }
    }
    hashes
}

fn immutable_template_manifest(template: &Value, resource_hashes: &BTreeSet<String>) -> Value {
    let template_id = template
        .get("id")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let source_type = template.get("sourceType").cloned().unwrap_or(Value::Null);
    let source_name = template.get("sourceName").cloned().unwrap_or(Value::Null);
    let extracted_text_hash = template
        .get("extractedText")
        .and_then(Value::as_str)
        .map(|text| sha256(text.as_bytes()));
    let analysis_hash = template
        .get("analysis")
        .and_then(Value::as_str)
        .map(|text| sha256(text.as_bytes()));
    let font_identity = json!({
        "detectedFont": template.get("detectedFont").cloned().unwrap_or(Value::Null),
        "fontSetId": template.pointer("/presentation/fontSetId").cloned().unwrap_or(Value::Null),
        "fontBundleHash": engine_identities()["fontBundleHash"].clone(),
    });
    let style = json!({
        "formatId": template.get("formatId").cloned().unwrap_or(Value::Null),
        "layout": template.get("layout").cloned().unwrap_or(Value::Null),
        "accent": template.get("accent").cloned().unwrap_or(Value::Null),
        "sideBandBackground": template.get("sideBandBackground").cloned().unwrap_or(Value::Null),
        "sideBandForeground": template.get("sideBandForeground").cloned().unwrap_or(Value::Null),
    });
    json!({
        "schemaVersion": 1,
        "templateId": template_id,
        "source": {
            "sourceType": source_type,
            "sourceName": source_name,
            "extractedTextHash": extracted_text_hash,
            "analysisHash": analysis_hash,
        },
        "fontIdentity": font_identity,
        "style": style,
        "resources": resource_hashes.iter().cloned().collect::<Vec<_>>(),
        "engineIdentity": engine_identities().clone(),
    })
}

fn insert_template_revision(
    connection: &Connection,
    template: &mut Value,
) -> StorageResult<(String, BTreeSet<String>)> {
    let template_id = template
        .get("id")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty() && value.len() <= 512)
        .ok_or_else(|| StorageError::Validation("Imported template has an invalid ID".into()))?
        .to_string();
    let manifest = immutable_template_manifest(template, &resource_hashes_for_template(template));
    let revision_hash = canonical_hash(&manifest)?;
    let manifest_json = serde_json::to_string(&manifest)?;
    let existing: Option<String> = connection
        .query_row(
            "SELECT manifest_json FROM template_revisions
             WHERE template_id = ?1 AND revision_hash = ?2",
            params![template_id, revision_hash],
            |row| row.get(0),
        )
        .optional()?;
    if existing
        .as_deref()
        .is_some_and(|value| value != manifest_json)
    {
        return Err(StorageError::Corrupt(
            "Template revision hash collision".into(),
        ));
    }
    connection.execute(
        "INSERT OR IGNORE INTO template_revisions(template_id, revision_hash, manifest_json)
         VALUES (?1, ?2, ?3)",
        params![template_id, revision_hash, manifest_json],
    )?;
    let Some(object) = template.as_object_mut() else {
        return Err(StorageError::Validation(
            "Imported template must be an object".into(),
        ));
    };
    object.insert("revisionHash".into(), Value::String(revision_hash.clone()));
    object.remove("revisionStatus");
    object.remove("knownRevisionHashes");
    object.remove("knownRevisions");
    Ok((revision_hash, resource_hashes_for_template(template)))
}

pub(super) fn normalize_catalog_for_storage(
    connection: &Connection,
    payload_json: &str,
) -> StorageResult<String> {
    let mut catalog: Value = serde_json::from_str(payload_json)?;
    let templates = catalog
        .as_array_mut()
        .ok_or_else(|| StorageError::Validation("Template catalog must be an array".into()))?;
    let mut seen = BTreeSet::new();
    let mut ownership = Vec::with_capacity(templates.len());
    for template in templates.iter_mut() {
        let id = template
            .get("id")
            .and_then(Value::as_str)
            .filter(|value| !value.trim().is_empty() && value.len() <= 512)
            .ok_or_else(|| StorageError::Validation("Imported template has an invalid ID".into()))?
            .to_string();
        if !seen.insert(id.clone()) {
            return Err(StorageError::Validation(
                "Template catalog contains duplicate IDs".into(),
            ));
        }
        let object = template.as_object_mut().ok_or_else(|| {
            StorageError::Validation("Imported template must be an object".into())
        })?;
        connection.execute(
            "DELETE FROM resource_recovery_requirements WHERE owner_kind = 'retained-template' AND owner_id = ?1",
            [&id],
        )?;
        object.remove("revisionHash");
        object.remove("revisionStatus");
        object.remove("knownRevisionHashes");
        object.remove("knownRevisions");
        object.remove("previewRecoveryWarning");

        let preview = object
            .get("previewDataUrl")
            .and_then(Value::as_str)
            .map(str::to_string);
        if let Some(data_url) = preview {
            match parse_preview_data_url(&data_url)? {
                Some((mime, bytes)) => {
                    let hash = sha256(&bytes);
                    store_resource(connection, &hash, &mime, &bytes)?;
                    object.insert("previewAssetId".into(), Value::String(hash));
                    object.remove("previewDataUrl");
                    object.remove("previewRecoveryWarning");
                }
                None => {
                    let warning = "Preview bytes are preserved in catalog metadata but could not be validated as an image asset.";
                    object.insert(
                        "previewRecoveryWarning".into(),
                        Value::String(warning.into()),
                    );
                    record_recovery(connection, "retained-template", &id, None, warning)?;
                }
            }
        }
        if let Some(preview_hash) = object
            .get("previewAssetId")
            .and_then(Value::as_str)
            .filter(|value| value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit()))
            .map(str::to_ascii_lowercase)
        {
            object.insert("previewAssetId".into(), Value::String(preview_hash));
        }
        if let Some(preview_hash) = object.get("previewAssetId").and_then(Value::as_str) {
            let exists: bool = connection.query_row(
                "SELECT EXISTS(SELECT 1 FROM resources WHERE hash = ?1)",
                [preview_hash],
                |row| row.get(0),
            )?;
            if !exists {
                object.insert(
                    "previewRecoveryWarning".into(),
                    Value::String("原始预览资源缺失；可重新导入原文件恢复。".into()),
                );
            }
        }

        let (revision_hash, hashes) = insert_template_revision(connection, template)?;
        ownership.push((id, revision_hash, hashes));
    }

    connection.execute(
        "DELETE FROM resource_refs WHERE owner_kind = 'retained-template'",
        [],
    )?;
    for (template_id, _revision_hash, hashes) in ownership {
        for hash in hashes {
            let exists: bool = connection.query_row(
                "SELECT EXISTS(SELECT 1 FROM resources WHERE hash = ?1)",
                [&hash],
                |row| row.get(0),
            )?;
            if exists {
                connection.execute(
                    "INSERT OR IGNORE INTO resource_refs(resource_hash, owner_kind, owner_id)
                     VALUES (?1, 'retained-template', ?2)",
                    params![hash, template_id],
                )?;
            } else {
                record_recovery(
                    connection,
                    "retained-template",
                    &template_id,
                    Some(&hash),
                    "Imported template preview asset is missing; reimport the original source to restore it.",
                )?;
            }
        }
    }
    Ok(serde_json::to_string(&catalog)?)
}

pub(super) fn catalog_with_revision_metadata(
    connection: &Connection,
    payload_json: &str,
) -> StorageResult<String> {
    let mut catalog: Value = serde_json::from_str(payload_json)?;
    let templates = catalog
        .as_array_mut()
        .ok_or_else(|| StorageError::Corrupt("Imported template catalog is not an array".into()))?;
    let current_engine_hash = engine_identities()["engineSourceHash"]
        .as_str()
        .map(str::to_string)
        .unwrap_or_default();
    for template in templates {
        let Some(object) = template.as_object_mut() else {
            continue;
        };
        let Some(template_id) = object.get("id").and_then(Value::as_str) else {
            continue;
        };
        let mut statement = connection.prepare(
            "SELECT revision_hash, manifest_json FROM template_revisions
             WHERE template_id = ?1 ORDER BY created_at, revision_hash",
        )?;
        let rows = statement
            .query_map([template_id], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })?
            .collect::<Result<Vec<_>, _>>()?;
        let mut known = Vec::with_capacity(rows.len());
        for (hash, manifest_json) in &rows {
            let manifest: Value = serde_json::from_str(manifest_json)?;
            let engine_hash = manifest
                .pointer("/engineIdentity/engineSourceHash")
                .and_then(Value::as_str);
            known.push(json!({
                "revisionHash": hash,
                "rendererStatus": if engine_hash == Some(current_engine_hash.as_str()) { "current" } else { "fallback" },
            }));
        }
        object.insert("knownRevisions".into(), Value::Array(known));
        if let Some(current_hash) = object.get("revisionHash").and_then(Value::as_str) {
            let current = rows.iter().find(|(hash, _)| hash == current_hash);
            let status = current
                .map(|(_, manifest)| {
                    let manifest: Value = serde_json::from_str(manifest).unwrap_or(Value::Null);
                    if manifest
                        .pointer("/engineIdentity/engineSourceHash")
                        .and_then(Value::as_str)
                        == Some(current_engine_hash.as_str())
                    {
                        "current"
                    } else {
                        "fallback"
                    }
                })
                .unwrap_or("unknown");
            object.insert("revisionStatus".into(), Value::String(status.into()));
        } else {
            object.insert("revisionStatus".into(), Value::String("unknown".into()));
        }
    }
    Ok(serde_json::to_string(&catalog)?)
}

fn document_asset_hashes(
    connection: &Connection,
    document: &Value,
) -> StorageResult<(BTreeSet<String>, bool)> {
    let mut hashes = BTreeSet::new();
    let mut missing_template_revision = false;
    for path in [
        "/basic/avatarAssetId",
        "/sourceRef/previewAssetId",
        "/legacyExtensions/importedTemplate/previewAssetId",
    ] {
        if let Some(hash) = document.pointer(path).and_then(Value::as_str) {
            if hash.len() == 64 && hash.bytes().all(|byte| byte.is_ascii_hexdigit()) {
                hashes.insert(hash.to_ascii_lowercase());
            }
        }
    }
    if let Some(imported) = document.pointer("/legacyExtensions/importedTemplate") {
        let template_id = imported.get("id").and_then(Value::as_str);
        let revision_hash = imported.get("revisionHash").and_then(Value::as_str);
        if let (Some(template_id), Some(revision_hash)) = (template_id, revision_hash) {
            let manifest: Option<String> = connection
                .query_row(
                    "SELECT manifest_json FROM template_revisions
                     WHERE template_id = ?1 AND revision_hash = ?2",
                    params![template_id, revision_hash],
                    |row| row.get(0),
                )
                .optional()?;
            if let Some(manifest) = manifest {
                let manifest: Value = serde_json::from_str(&manifest)?;
                if let Some(resources) = manifest.get("resources").and_then(Value::as_array) {
                    for hash in resources.iter().filter_map(Value::as_str) {
                        hashes.insert(hash.to_string());
                    }
                }
            } else {
                missing_template_revision = true;
            }
        }
    }
    Ok((hashes, missing_template_revision))
}

pub(super) fn sync_document_resource_owner(
    connection: &Connection,
    owner_kind: &str,
    owner_id: &str,
    document_json: &str,
) -> StorageResult<()> {
    if !matches!(owner_kind, "draft" | "snapshot") {
        return Err(StorageError::Validation(
            "Invalid durable resource owner".into(),
        ));
    }
    connection.execute(
        "DELETE FROM resource_refs WHERE owner_kind = ?1 AND owner_id = ?2",
        params![owner_kind, owner_id],
    )?;
    connection.execute(
        "DELETE FROM resource_recovery_requirements WHERE owner_kind = ?1 AND owner_id = ?2",
        params![owner_kind, owner_id],
    )?;
    let document: Value = serde_json::from_str(document_json)?;
    let (hashes, missing_template_revision) = document_asset_hashes(connection, &document)?;
    for hash in hashes {
        let exists: bool = connection.query_row(
            "SELECT EXISTS(SELECT 1 FROM resources WHERE hash = ?1)",
            [&hash],
            |row| row.get(0),
        )?;
        if exists {
            connection.execute(
                "INSERT OR IGNORE INTO resource_refs(resource_hash, owner_kind, owner_id)
                 VALUES (?1, ?2, ?3)",
                params![hash, owner_kind, owner_id],
            )?;
        } else {
            record_recovery(
                connection,
                owner_kind,
                owner_id,
                Some(&hash),
                "A document refers to an asset that is absent from this database backup; reimport the original source to restore it.",
            )?;
        }
    }
    if missing_template_revision {
        record_recovery(
            connection,
            owner_kind,
            owner_id,
            None,
            "Template revision manifest is unknown; preserve the saved presentation and use the current renderer fallback.",
        )?;
    }
    Ok(())
}

pub(super) fn reconcile_ownership_backfill(transaction: &Transaction<'_>) -> StorageResult<()> {
    let applied: bool = transaction.query_row(
        "SELECT EXISTS(SELECT 1 FROM settings WHERE key = ?1)",
        [OWNERSHIP_BACKFILL_MARKER],
        |row| row.get(0),
    )?;
    if applied {
        return Ok(());
    }
    let old_catalog: Option<(i64, String)> = transaction
        .query_row(
            "SELECT revision, payload_json FROM imported_template_catalog WHERE id = 1",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?;
    if let Some((revision, payload_json)) = old_catalog {
        let normalized = normalize_catalog_for_storage(transaction, &payload_json)?;
        transaction.execute(
            "UPDATE imported_template_catalog SET payload_json = ?1 WHERE id = 1 AND revision = ?2",
            params![normalized, revision],
        )?;
    }

    let drafts = {
        let mut statement = transaction
            .prepare("SELECT document_id, context_id, branch_id, document_json FROM drafts")?;
        let rows = statement.query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
            ))
        })?;
        rows.collect::<Result<Vec<_>, _>>()?
    };
    for (document_id, context_id, branch_id, json) in drafts {
        let owner_id = serde_json::to_string(&[document_id, context_id, branch_id])?;
        sync_document_resource_owner(transaction, "draft", &owner_id, &json)?;
    }
    let snapshots = {
        let mut statement = transaction.prepare("SELECT id, document_json FROM snapshots")?;
        let rows = statement.query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?;
        rows.collect::<Result<Vec<_>, _>>()?
    };
    for (snapshot_id, json) in snapshots {
        sync_document_resource_owner(transaction, "snapshot", &snapshot_id, &json)?;
    }
    transaction.execute(
        "INSERT INTO settings(key, value) VALUES (?1, '1')
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        [OWNERSHIP_BACKFILL_MARKER],
    )?;
    Ok(())
}

pub(super) fn acquire_lease(
    connection: &Connection,
    hashes: &[String],
    ttl_seconds: u64,
) -> StorageResult<String> {
    const MAX_LEASE_SECONDS: u64 = 15 * 60;
    if ttl_seconds == 0 || ttl_seconds > MAX_LEASE_SECONDS {
        return Err(StorageError::Validation(
            "Resource lease duration must be between 1 second and 15 minutes".into(),
        ));
    }
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|error| StorageError::Validation(error.to_string()))?
        .as_secs();
    let expiry = now
        .checked_add(ttl_seconds)
        .ok_or_else(|| StorageError::Validation("Resource lease expiry overflow".into()))?;
    let transaction = connection.unchecked_transaction()?;
    let lease_id: String =
        transaction.query_row("SELECT lower(hex(randomblob(16)))", [], |row| row.get(0))?;
    for hash in hashes.iter().collect::<BTreeSet<_>>() {
        let exists: bool = transaction.query_row(
            "SELECT EXISTS(SELECT 1 FROM resources WHERE hash = ?1)",
            [hash],
            |row| row.get(0),
        )?;
        if !exists {
            return Err(StorageError::NotFound(format!(
                "Resource {hash} is missing"
            )));
        }
        transaction.execute(
            "INSERT INTO resource_leases(lease_id, resource_hash, expires_at)
             VALUES (?1, ?2, ?3)",
            params![lease_id, hash, expiry as i64],
        )?;
    }
    transaction.commit()?;
    Ok(lease_id)
}

pub(super) fn acquire_all_resource_lease(
    connection: &Connection,
    ttl_seconds: u64,
) -> StorageResult<String> {
    let hashes = {
        let mut statement = connection.prepare("SELECT hash FROM resources ORDER BY hash")?;
        let rows = statement.query_map([], |row| row.get::<_, String>(0))?;
        rows.collect::<Result<Vec<_>, _>>()?
    };
    acquire_lease(connection, &hashes, ttl_seconds)
}

pub(super) fn release_lease(connection: &Connection, lease_id: &str) -> StorageResult<()> {
    connection.execute(
        "DELETE FROM resource_leases WHERE lease_id = ?1",
        [lease_id],
    )?;
    Ok(())
}

pub(super) fn collect_unreferenced(connection: &Connection) -> StorageResult<usize> {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|error| StorageError::Validation(error.to_string()))?
        .as_secs() as i64;
    let transaction = connection.unchecked_transaction()?;
    transaction.execute("DELETE FROM resource_leases WHERE expires_at <= ?1", [now])?;
    // Pending assets survive process restart; confirmed assets retain the
    // before-value for undo. Settled/expired proposals release these owners in
    // the same GC transaction used for ordinary durable refs and active leases.
    transaction.execute(
        "DELETE FROM resource_refs WHERE owner_kind='proposal-asset' AND NOT EXISTS (
           SELECT 1 FROM agent_proposals p WHERE p.id=resource_refs.owner_id AND
           (p.status='confirmed' OR (p.status='pending' AND p.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')))
         )", [],
    )?;
    let manifest_assets = {
        let mut statement = transaction
            .prepare("SELECT template_id, revision_hash, manifest_json FROM template_revisions")?;
        let rows = statement.query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
            ))
        })?;
        rows.collect::<Result<Vec<_>, _>>()?
    };
    let mut recovery_by_hash: BTreeMap<String, Vec<String>> = BTreeMap::new();
    for (template_id, revision_hash, manifest_json) in manifest_assets {
        let manifest: Value = serde_json::from_str(&manifest_json)?;
        if let Some(assets) = manifest.get("resources").and_then(Value::as_array) {
            for hash in assets.iter().filter_map(Value::as_str) {
                recovery_by_hash
                    .entry(hash.to_string())
                    .or_default()
                    .push(format!("{template_id}:{revision_hash}"));
            }
        }
    }
    let unreferenced = {
        let mut statement = transaction.prepare(
            "SELECT hash FROM resources
             WHERE NOT EXISTS (SELECT 1 FROM resource_refs WHERE resource_refs.resource_hash = resources.hash)
               AND NOT EXISTS (SELECT 1 FROM resource_leases WHERE resource_leases.resource_hash = resources.hash AND resource_leases.expires_at > ?1)",
        )?;
        let rows = statement.query_map([now], |row| row.get::<_, String>(0))?;
        rows.collect::<Result<Vec<_>, _>>()?
    };
    for hash in &unreferenced {
        if let Some(owners) = recovery_by_hash.get(hash) {
            for owner_id in owners {
                record_recovery(
                    &transaction,
                    "template-revision",
                    owner_id,
                    Some(hash),
                    "Asset collected after all durable owners and active leases were removed; reimport the source or restore a backup to recover it.",
                )?;
            }
        }
    }
    let deleted = transaction.execute(
        "DELETE FROM resources
         WHERE NOT EXISTS (SELECT 1 FROM resource_refs WHERE resource_refs.resource_hash = resources.hash)
           AND NOT EXISTS (SELECT 1 FROM resource_leases WHERE resource_leases.resource_hash = resources.hash AND resource_leases.expires_at > ?1)",
        [now],
    )?;
    transaction.commit()?;
    Ok(deleted)
}
