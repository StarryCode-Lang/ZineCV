use super::*;

// 归档载荷与 legacy_identity::archive_browser_entry 的写入格式一致：
// settings 键 = legacy.archive.<digest>.count / .NNNNNN，值为分块 JSON。
fn archive_entry(namespace: &str, key: &str, raw: &str) -> Vec<(String, String)> {
    let encoded = serde_json::json!({ "namespace": namespace, "key": key, "raw": raw });
    let payload = serde_json::to_string(&encoded).unwrap();
    let chars = payload.chars().collect::<Vec<_>>();
    let chunks: Vec<String> = chars
        .chunks(2048)
        .map(|part| part.iter().collect())
        .collect();
    let mut entries = vec![("count".to_string(), chunks.len().to_string())];
    entries.extend(
        chunks
            .into_iter()
            .enumerate()
            .map(|(index, value)| (format!("{index:06}"), value)),
    );
    entries
}

fn write_archive(store: &Store, namespace: &str, key: &str, raw: &str) {
    let digest = crate::migration::identity_conflict_key(
        namespace,
        "browser-archive",
        &serde_json::json!({ "namespace": namespace, "key": key, "raw": raw }).to_string(),
    );
    for (suffix, value) in archive_entry(namespace, key, raw) {
        store
            .connection
            .execute(
                "INSERT OR IGNORE INTO settings(key,value,updated_at) VALUES (?1,?2,strftime('%Y-%m-%dT%H:%M:%fZ','now'))",
                rusqlite::params![format!("legacy.archive.{digest}.{suffix}"), value],
            )
            .unwrap();
    }
}

#[test]
fn legacy_edit_archives_recover_imported_text_and_skip_other_records() {
    let store = Store::open_in_memory().unwrap();
    write_archive(
        &store,
        "ns-a",
        "resume-diy-imported-text-v1:imported-one",
        r#"{"box-1":"第一段文字","box-2":"second line","empty":""}"#,
    );
    // 空文字也必须保留，不能把它误认为没有归档。
    write_archive(
        &store,
        "ns-a",
        "resume-diy-imported-text-v1:imported-empty",
        r#"{"box-1":""}"#,
    );
    // 会话类归档（不同前缀）必须被排除。
    write_archive(
        &store,
        "ns-a",
        "resume-diy-agent-sessions-v2:session-1",
        r#"{"sessions":[]}"#,
    );
    let archives = store.read_legacy_edit_archives().unwrap();
    assert_eq!(archives.len(), 2);
    let restored = archives
        .iter()
        .find(|item| item.key.ends_with("imported-one"))
        .unwrap();
    assert_eq!(
        restored.raw,
        r#"{"box-1":"第一段文字","box-2":"second line","empty":""}"#
    );
    assert!(archives.iter().any(|item| item.raw == r#"{"box-1":""}"#));
}

#[test]
fn legacy_edit_archives_report_incomplete_chunks() {
    let store = Store::open_in_memory().unwrap();
    write_archive(
        &store,
        "ns-a",
        "resume-diy-imported-text-v1:broken",
        r#"{"box":"text"}"#,
    );
    store
        .connection
        .execute(
            "DELETE FROM settings WHERE key LIKE 'legacy.archive.%.000000'",
            [],
        )
        .unwrap();
    assert!(store.read_legacy_edit_archives().is_err());
}

#[test]
fn legacy_edit_archives_report_changed_payload_with_valid_json() {
    let store = Store::open_in_memory().unwrap();
    write_archive(
        &store,
        "ns-a",
        "resume-diy-imported-text-v1:broken",
        r#"{"box":"text"}"#,
    );
    store.connection.execute("UPDATE settings SET value = replace(value, 'text', 'xxxx') WHERE key LIKE 'legacy.archive.%.000000'", []).unwrap();
    assert!(store.read_legacy_edit_archives().is_err());
}

#[test]
fn legacy_edit_archives_is_read_only_and_idempotent() {
    let store = Store::open_in_memory().unwrap();
    write_archive(
        &store,
        "ns-a",
        "resume-diy-imported-text-v1:imported-one",
        r#"{"box-1":"keep me"}"#,
    );
    let before = store
        .connection
        .query_row("SELECT COUNT(*) FROM settings", [], |row| {
            row.get::<_, u32>(0)
        })
        .unwrap();
    let first = store.read_legacy_edit_archives().unwrap();
    let second = store.read_legacy_edit_archives().unwrap();
    assert_eq!(first, second);
    let after = store
        .connection
        .query_row("SELECT COUNT(*) FROM settings", [], |row| {
            row.get::<_, u32>(0)
        })
        .unwrap();
    assert_eq!(before, after, "reading archives must not mutate settings");
}
