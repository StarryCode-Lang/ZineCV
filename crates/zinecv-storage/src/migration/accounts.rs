use super::*;

pub(super) fn decode_data_url(value: &str) -> Option<Vec<u8>> {
    let (header, data) = value.split_once(',')?;
    if !header.starts_with("data:image/") || !header.ends_with(";base64") {
        return None;
    }
    base64::engine::general_purpose::STANDARD.decode(data).ok()
}

// 宿主 storage 资源导入路径复用该图片格式探测（原 pub(crate)，P3a 迁出后转 pub 经垫片可见）。
pub fn supported_image_bytes(bytes: &[u8]) -> bool {
    bytes.starts_with(b"\x89PNG\r\n\x1a\n")
        || bytes.starts_with(&[0xff, 0xd8, 0xff])
        || bytes.starts_with(b"GIF87a")
        || bytes.starts_with(b"GIF89a")
        || (bytes.len() >= 12 && bytes.starts_with(b"RIFF") && &bytes[8..12] == b"WEBP")
}

pub(super) fn scan_account_fields(
    value: &serde_json::Value,
    source_id: &str,
    path: &str,
    counts: &mut LegacyMigrationCounts,
    issues: &mut Vec<LegacyMigrationIssue>,
) {
    match value {
        serde_json::Value::Object(record) => {
            for (key, nested) in record {
                let normalized = key.to_ascii_lowercase().replace(['-', '_'], "");
                if [
                    "apikey",
                    "providerkey",
                    "secret",
                    "secretkey",
                    "encryptedblob",
                ]
                .contains(&normalized.as_str())
                    && !nested.is_null()
                    && !(nested.is_string() && nested.as_str().is_some_and(str::is_empty))
                {
                    counts.provider_secrets_need_reentry =
                        counts.provider_secrets_need_reentry.saturating_add(1);
                    add_issue(issues, source_id, "provider_secret_requires_reentry", &format!("{path}.{key}"), LegacyMigrationSeverity::Review, "A provider secret is present; this inspector never returns it and the target Windows user must re-enter or explicitly re-encrypt it.");
                }
                if [
                    "sessiontoken",
                    "accesstoken",
                    "refreshtoken",
                    "cookie",
                    "sessionid",
                ]
                .contains(&normalized.as_str())
                    && !nested.is_null()
                {
                    counts.live_session_tokens_not_migrated =
                        counts.live_session_tokens_not_migrated.saturating_add(1);
                    add_issue(
                        issues,
                        source_id,
                        "live_session_not_migrated",
                        &format!("{path}.{key}"),
                        LegacyMigrationSeverity::Info,
                        "Live authentication material is excluded from migration.",
                    );
                }
                if [
                    "provider",
                    "providers",
                    "providerprofile",
                    "providerprofiles",
                ]
                .contains(&normalized.as_str())
                {
                    let amount = if normalized == "provider" && nested.is_object() {
                        1
                    } else if nested.is_array() {
                        nested.as_array().map_or(0, Vec::len)
                    } else if nested.is_object() {
                        nested.as_object().map_or(0, serde_json::Map::len)
                    } else {
                        usize::from(!nested.is_null())
                    };
                    counts.provider_profiles =
                        counts.provider_profiles.saturating_add(amount as u32);
                }
                scan_account_fields(nested, source_id, &format!("{path}.{key}"), counts, issues);
            }
        }
        serde_json::Value::Array(items) => {
            for (index, item) in items.iter().enumerate() {
                scan_account_fields(item, source_id, &format!("{path}[{index}]"), counts, issues);
            }
        }
        _ => {}
    }
}

pub(super) fn inspect_account_json(
    value: &serde_json::Value,
    source_id: &str,
    counts: &mut LegacyMigrationCounts,
    evidence: &mut Vec<LegacyMigrationFieldEvidence>,
    issues: &mut Vec<LegacyMigrationIssue>,
    entities: &mut Vec<EntityFingerprint>,
) -> bool {
    let accounts = value
        .get("accounts")
        .or_else(|| value.get("users"))
        .or_else(|| value.as_array().map(|_| value));
    let Some(accounts) = accounts else {
        add_issue(issues, source_id, "unknown_account_schema", "accounts", LegacyMigrationSeverity::Review, "The account JSON schema is not recognized; original bytes and hash are retained without importing account fields.");
        return true;
    };
    let records: Vec<&serde_json::Value> = if let Some(array) = accounts.as_array() {
        array.iter().collect()
    } else if let Some(object) = accounts.as_object() {
        object.values().collect()
    } else {
        add_issue(
            issues,
            source_id,
            "invalid_account_records",
            "accounts",
            LegacyMigrationSeverity::Error,
            "Account records must be an array or object.",
        );
        return false;
    };
    counts.account_records = counts.account_records.saturating_add(records.len() as u32);
    if let Some(tokens) = value.get("sessions").and_then(serde_json::Value::as_array) {
        counts.live_session_tokens_not_migrated = counts
            .live_session_tokens_not_migrated
            .saturating_add(tokens.len() as u32);
        add_evidence(
            evidence,
            "accounts.sessions",
            tokens.len(),
            "excluded_live_tokens",
        );
    }
    add_evidence(evidence, "accounts", records.len(), "present");
    for (index, account) in records.iter().enumerate() {
        let path = format!("accounts[{index}]");
        let Some(record) = as_record(account) else {
            counts.damaged_account_records = counts.damaged_account_records.saturating_add(1);
            add_issue(
                issues,
                source_id,
                "damaged_account_record",
                &path,
                LegacyMigrationSeverity::Review,
                "This account record is not an object and is retained for manual recovery.",
            );
            continue;
        };
        let id =
            nonempty_string(record.get("id")).or_else(|| nonempty_string(record.get("accountId")));
        let email = nonempty_string(record.get("email"));
        if id.is_none() || email.is_none() {
            counts.damaged_account_records = counts.damaged_account_records.saturating_add(1);
            add_issue(issues, source_id, "damaged_account_record", &path, LegacyMigrationSeverity::Review, "Account ID or email is missing; account status is reported separately from other sources.");
        }
        if let Some(id) = id {
            entities.push(fingerprint_entity(source_id, "account", id, account, email));
        }
        if record.keys().any(|key| {
            matches!(
                key.as_str(),
                "passwordHash" | "password_hash" | "password_hash_hex"
            )
        }) {
            add_evidence(
                evidence,
                &format!("{path}.passwordHash"),
                1,
                "hash_present_not_migrated_without_kdf_match",
            );
        }
        scan_account_fields(account, source_id, &path, counts, issues);
    }
    true
}
