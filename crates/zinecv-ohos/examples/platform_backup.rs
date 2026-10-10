//! Windows-native fixture for the shared Backup JSON interchange test.
fn main() {
    let mut args = std::env::args().skip(1);
    let output = args.next().expect("output JSON path");
    let mut store = zinecv_storage::storage::Store::open_in_memory().unwrap();
    let mut document = zinecv_domain::default_resume_document("store-poc").unwrap();
    document.title = "Windows native Backup → WASM 中文".into();
    store
        .initialize_document(&document, "store-context")
        .unwrap();
    if let Some(input) = args.next() {
        let backup: zinecv_contracts::DatabaseBackupPayload =
            serde_json::from_slice(&std::fs::read(input).unwrap()).unwrap();
        store
            .restore_database_backup_with_snapshot(
                &backup,
                &mut rusqlite::Connection::open_in_memory().unwrap(),
            )
            .unwrap();
    }
    let payload = store.export_database_backup().unwrap();
    std::fs::write(output, serde_json::to_vec(&payload).unwrap()).unwrap();
}
