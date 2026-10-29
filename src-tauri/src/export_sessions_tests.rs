use super::*;
use base64::{engine::general_purpose::STANDARD, Engine as _};
use zinecv_contracts::{ExportData, ExportPng, ExportProduct, TextMap};

struct Sandbox(PathBuf);
impl Sandbox {
    fn new() -> Self {
        static SEQUENCE: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let sequence = SEQUENCE.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let path = std::env::temp_dir().join(format!(
            "zinecv-export-proof-{}-{nonce}-{sequence}",
            std::process::id()
        ));
        std::fs::create_dir(&path).unwrap();
        Self(path)
    }
}
impl Drop for Sandbox {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

const PDF: &[u8] = b"%PDF-1.7\nsynthetic export write-boundary fixture\n%%EOF\n";

fn store() -> Store {
    let mut store = Store::open_in_memory().unwrap();
    for id in ["export-a", "export-b"] {
        let mut document = zinecv_domain::default_resume_document(id).unwrap();
        document.title = format!("简历 {id}");
        store
            .initialize_document(&document, &format!("context-{id}"))
            .unwrap();
    }
    store
}

fn core(store: &Store, product: ExportProduct) -> (ExportResult, FrozenExportSource) {
    let (cursor, document) = store.load_active_document("export-a").unwrap().unwrap();
    let png = STANDARD.decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=").unwrap();
    let image = |page| ExportPng {
        page,
        width: 1,
        height: 1,
        sha256: format!("{:x}", Sha256::digest(&png)),
        data_base64: STANDARD.encode(&png),
    };
    let png_only = product == ExportProduct::Png;
    let export = ExportResult {
        cursor,
        render_key: "a".repeat(64),
        data: ExportData {
            pdf_base64: if png_only {
                String::new()
            } else {
                STANDARD.encode(PDF)
            },
            pdf_sha256: format!("{:x}", Sha256::digest(if png_only { &[] } else { PDF })),
            page_count: if png_only { 2 } else { 1 },
            text_map: TextMap {
                version: 1,
                logical_text: String::new(),
                clusters: Vec::new(),
                hit_regions: Vec::new(),
                links: Vec::new(),
            },
            png_pages: if png_only {
                vec![image(1), image(2)]
            } else {
                Vec::new()
            },
            long_png: None,
            long_image_limited: png_only,
            dpi: 192,
            product: Some(product),
            selected_pages: None,
        },
    };
    (export, frozen_source(&document, "岗位分支 A".into()))
}

fn ticket(sessions: &ExportSessions, store: &Store, product: ExportProduct) -> NativeExportResult {
    let generation = sessions.generation().unwrap();
    let (export, source) = core(store, product);
    sessions.register(&generation, export, source).unwrap()
}

fn write(
    sessions: &ExportSessions,
    store: &mut Store,
    export: &NativeExportResult,
    artifact: &str,
    id: &str,
    path: &Path,
    bytes: &[u8],
) -> Result<ExportWriteOutcome, AppError> {
    let prepared = sessions.prepare_write(&export.export_id, artifact, id, path, bytes)?;
    match prepared.write_file(bytes) {
        Ok(outcome) => Ok(sessions.finish_write(store, &prepared, outcome)),
        Err(error) => {
            sessions.abandon_write(&prepared);
            Err(error)
        }
    }
}

#[test]
fn frozen_export_writes_and_records_its_original_document_after_a_switch() {
    let folder = Sandbox::new();
    let sessions = ExportSessions::default();
    let mut store = store();
    let export = ticket(&sessions, &store, ExportProduct::Pdf);
    let old_cursor = export.export.cursor.clone();
    store
        .persist_active_document_transition(Some("export-a"), "export-b")
        .unwrap();
    assert!(store.validate_active_cursor(&old_cursor).is_err());
    let path = folder.0.join("中文简历.pdf");
    let outcome = write(
        &sessions,
        &mut store,
        &export,
        "pdf",
        "write-once",
        &path,
        PDF,
    )
    .unwrap();
    assert!(outcome.recording_error.is_none());
    let receipt = outcome.receipt.unwrap();
    assert_eq!(receipt.cursor, old_cursor);
    assert_eq!(receipt.source.document_title, "简历 export-a");
    assert_eq!(receipt.source.branch_name, "岗位分支 A");
    assert_eq!(receipt.source.template_id, export.source.template_id);
    assert_eq!(receipt.filename, "中文简历.pdf");
    assert_eq!(std::fs::read(&path).unwrap(), PDF);
    assert_eq!(
        receipt.artifact.sha256,
        format!("{:x}", Sha256::digest(std::fs::read(&path).unwrap()))
    );
    assert_eq!(
        store.recent_export_receipts("export-a").unwrap(),
        vec![receipt.clone()]
    );
    assert!(store.recent_export_receipts("export-b").unwrap().is_empty());
    let replay = write(
        &sessions,
        &mut store,
        &export,
        "pdf",
        "write-once",
        &path,
        PDF,
    )
    .unwrap();
    assert_eq!(replay.receipt, Some(receipt));
    assert_eq!(store.recent_export_receipts("export-a").unwrap().len(), 1);
}

#[test]
fn tampered_artifacts_reused_write_ids_and_inflight_duplicates_are_rejected_before_io() {
    let folder = Sandbox::new();
    let sessions = ExportSessions::default();
    let store = store();
    let (mut invalid, source) = core(&store, ExportProduct::Pdf);
    invalid.data.pdf_sha256 = "0".repeat(64);
    assert!(sessions
        .register(&sessions.generation().unwrap(), invalid, source)
        .is_err());
    let export = ticket(&sessions, &store, ExportProduct::Pdf);
    let path = folder.0.join("original.pdf");
    assert!(sessions
        .prepare_write(&export.export_id, "pdf", "one", &path, b"tampered")
        .is_err());
    let mut same_length_tamper = PDF.to_vec();
    same_length_tamper[8] ^= 1;
    assert!(sessions
        .prepare_write(&export.export_id, "pdf", "one", &path, &same_length_tamper)
        .is_err());
    assert!(sessions
        .prepare_write(&export.export_id, "png:1", "one", &path, PDF)
        .is_err());
    let prepared = sessions
        .prepare_write(&export.export_id, "pdf", "one", &path, PDF)
        .unwrap();
    assert!(sessions
        .prepare_write(&export.export_id, "pdf", "one", &path, PDF)
        .is_err());
    sessions.abandon_write(&prepared);
    assert!(sessions
        .prepare_write(
            &export.export_id,
            "pdf",
            "one",
            &folder.0.join("changed.pdf"),
            PDF
        )
        .is_err());
    assert!(!path.exists());
    assert!(store.recent_export_receipts("export-a").unwrap().is_empty());
}

#[test]
fn sql_recording_failure_keeps_the_verified_file_and_can_retry_without_duplicate_history() {
    let folder = Sandbox::new();
    let sessions = ExportSessions::default();
    let mut store = store();
    let export = ticket(&sessions, &store, ExportProduct::Pdf);
    store.connection().execute_batch("CREATE TRIGGER reject_export_receipt BEFORE INSERT ON command_receipts
        WHEN NEW.actor = 'host-export' BEGIN SELECT RAISE(ABORT, 'synthetic receipt failure'); END;").unwrap();
    let path = folder.0.join("saved-without-record.pdf");
    let first = write(
        &sessions,
        &mut store,
        &export,
        "pdf",
        "retry-record",
        &path,
        PDF,
    )
    .unwrap();
    assert_eq!(first.bytes, PDF.len());
    assert!(first.receipt.is_none());
    assert!(first.recording_error.is_some());
    assert_eq!(std::fs::read(&path).unwrap(), PDF);
    assert!(store.recent_export_receipts("export-a").unwrap().is_empty());
    store
        .connection()
        .execute_batch("DROP TRIGGER reject_export_receipt")
        .unwrap();
    let retry = write(
        &sessions,
        &mut store,
        &export,
        "pdf",
        "retry-record",
        &path,
        PDF,
    )
    .unwrap();
    assert!(retry.receipt.is_some());
    assert!(retry.recording_error.is_none());
    assert_eq!(store.recent_export_receipts("export-a").unwrap().len(), 1);
    // A retry must not overwrite an externally replaced file or create another receipt.
    let mut external = PDF.to_vec();
    external[8] ^= 1;
    std::fs::write(&path, &external).unwrap();
    assert!(write(
        &sessions,
        &mut store,
        &export,
        "pdf",
        "retry-record",
        &path,
        PDF
    )
    .is_err());
    assert_eq!(std::fs::read(&path).unwrap(), external);
    assert_eq!(store.recent_export_receipts("export-a").unwrap().len(), 1);
}

#[test]
fn failed_png_page_write_has_no_receipt_and_partial_delivery_retries_only_the_missing_page() {
    let folder = Sandbox::new();
    let sessions = ExportSessions::default();
    let mut store = store();
    let export = ticket(&sessions, &store, ExportProduct::Png);
    let bytes = STANDARD
        .decode(&export.export.data.png_pages[0].data_base64)
        .unwrap();
    write(
        &sessions,
        &mut store,
        &export,
        "png:1",
        "page-one",
        &folder.0.join("page-1.png"),
        &bytes,
    )
    .unwrap();
    let missing_parent = folder.0.join("not-created");
    let page_two = missing_parent.join("page-2.png");
    assert!(write(&sessions, &mut store, &export, "png:2", "page-two", &page_two, &bytes).is_err());
    let partial = store.recent_export_receipts("export-a").unwrap();
    assert_eq!(partial.len(), 1);
    assert_eq!(partial[0].artifact.page, Some(1));
    std::fs::create_dir(&missing_parent).unwrap();
    write(
        &sessions, &mut store, &export, "png:2", "page-two", &page_two, &bytes,
    )
    .unwrap();
    let receipts = store.recent_export_receipts("export-a").unwrap();
    assert_eq!(receipts.len(), 2);
    assert!(receipts
        .iter()
        .all(|receipt| receipt.export_id == export.export_id));
    assert!(receipts
        .iter()
        .any(|receipt| receipt.artifact.page == Some(2)));
}

#[test]
fn restored_database_revokes_pending_writes_inflight_recording_and_late_render_registration() {
    let folder = Sandbox::new();
    let sessions = ExportSessions::default();
    let mut store = store();
    let backup = store.export_database_backup().unwrap();
    let export = ticket(&sessions, &store, ExportProduct::Pdf);
    let generation = sessions.generation().unwrap();
    let (late_export, late_source) = core(&store, ExportProduct::Pdf);
    let mut invalid_backup = backup.clone();
    invalid_backup.database_sha256 = "0".repeat(64);
    assert!(store
        .restore_database_backup(&invalid_backup, &folder.0.join("failed-restore.db"))
        .is_err());
    let path = folder.0.join("inflight.pdf");
    let prepared = sessions
        .prepare_write(&export.export_id, "pdf", "inflight", &path, PDF)
        .unwrap();
    let written = prepared.write_file(PDF).unwrap();
    store
        .restore_database_backup(&backup, &folder.0.join("pre-restore.db"))
        .unwrap();
    sessions.invalidate().unwrap();
    let completed = sessions.finish_write(&mut store, &prepared, written);
    assert!(completed.receipt.is_none());
    assert!(completed.recording_error.is_some());
    assert_eq!(std::fs::read(&path).unwrap(), PDF);
    assert!(store.recent_export_receipts("export-a").unwrap().is_empty());
    assert!(sessions
        .prepare_write(
            &export.export_id,
            "pdf",
            "new-attempt",
            &folder.0.join("new.pdf"),
            PDF
        )
        .is_err());
    assert!(sessions
        .register(&generation, late_export, late_source)
        .is_err());
}

#[test]
fn export_session_metadata_is_bounded_and_idle_cancelled_sessions_can_be_evicted() {
    let sessions = ExportSessions::default();
    let store = store();
    let first = ticket(&sessions, &store, ExportProduct::Pdf);
    for _ in 0..MAX_SESSIONS {
        ticket(&sessions, &store, ExportProduct::Pdf);
    }
    assert_eq!(lock(&sessions).unwrap().tickets.len(), MAX_SESSIONS);
    assert!(sessions
        .prepare_write(
            &first.export_id,
            "pdf",
            "expired",
            Path::new("expired.pdf"),
            PDF
        )
        .is_err());
}

#[test]
fn concurrent_restore_and_write_completion_follow_store_then_session_lock_order() {
    let folder = Sandbox::new();
    let sessions = Arc::new(ExportSessions::default());
    let store = Arc::new(Mutex::new(store()));
    let export = ticket(&sessions, &store.lock().unwrap(), ExportProduct::Pdf);
    let backup = store.lock().unwrap().export_database_backup().unwrap();
    let path = folder.0.join("cross-restore.pdf");
    let backup_path = folder.0.join("cross-restore-before.db");
    let prepared_barrier = Arc::new(std::sync::Barrier::new(2));
    let store_held_barrier = Arc::new(std::sync::Barrier::new(2));
    let (done, results) = std::sync::mpsc::channel();
    let writer = {
        let sessions = Arc::clone(&sessions);
        let store = Arc::clone(&store);
        let prepared_barrier = Arc::clone(&prepared_barrier);
        let store_held_barrier = Arc::clone(&store_held_barrier);
        let path = path.clone();
        let done = done.clone();
        std::thread::spawn(move || {
            let prepared = sessions
                .prepare_write(&export.export_id, "pdf", "cross-restore", &path, PDF)
                .unwrap();
            let written = prepared.write_file(PDF).unwrap();
            prepared_barrier.wait();
            store_held_barrier.wait();
            let mut store = store.lock().unwrap();
            let result = sessions.finish_write(&mut store, &prepared, written);
            done.send(Some(result)).unwrap();
        })
    };
    let restorer = {
        let sessions = Arc::clone(&sessions);
        let store = Arc::clone(&store);
        std::thread::spawn(move || {
            let mut store = store.lock().unwrap();
            prepared_barrier.wait();
            store_held_barrier.wait();
            store
                .restore_database_backup(&backup, &backup_path)
                .unwrap();
            sessions.invalidate().unwrap();
            done.send(None).unwrap();
        })
    };
    let outcomes = (0..2)
        .map(|_| {
            results
                .recv_timeout(Duration::from_secs(10))
                .expect("Store→session lock order must complete")
        })
        .collect::<Vec<_>>();
    writer.join().unwrap();
    restorer.join().unwrap();
    let written = outcomes.into_iter().flatten().next().unwrap();
    assert!(written.receipt.is_none());
    assert!(written.recording_error.is_some());
    assert_eq!(std::fs::read(path).unwrap(), PDF);
    assert!(store
        .lock()
        .unwrap()
        .recent_export_receipts("export-a")
        .unwrap()
        .is_empty());
}

#[test]
fn failed_export_tickets_with_only_abandoned_writes_are_evictable() {
    let folder = Sandbox::new();
    let sessions = ExportSessions::default();
    let store = store();
    for index in 0..MAX_SESSIONS {
        let export = ticket(&sessions, &store, ExportProduct::Pdf);
        let prepared = sessions
            .prepare_write(
                &export.export_id,
                "pdf",
                &format!("abandoned-{index}"),
                &folder.0.join(format!("fail-{index}.pdf")),
                PDF,
            )
            .unwrap();
        sessions.abandon_write(&prepared);
    }
    assert_eq!(lock(&sessions).unwrap().tickets.len(), MAX_SESSIONS);
    // 全部写入均已放弃的失败票据不算占用：下一次导出必须驱逐而不是拒绝。
    let late = ticket(&sessions, &store, ExportProduct::Pdf);
    assert!(lock(&sessions)
        .unwrap()
        .tickets
        .contains_key(&late.export_id));
    assert_eq!(lock(&sessions).unwrap().tickets.len(), MAX_SESSIONS);
}
