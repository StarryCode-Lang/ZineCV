//! Compilation probe only; installed Harmony Host acceptance requires a device.
use rusqlite::Connection;
use std::ffi::{c_char, CString};
use zinecv_storage::storage::Store;
fn probe() -> Result<String, String> {
    let mut store = Store::from_platform_connection(
        Connection::open_in_memory().map_err(|e| format!("{e:?}"))?,
        None,
    )
    .map_err(|e| format!("{e:?}"))?;
    let document = zinecv_domain::default_resume_document("ohos-native-probe")
        .map_err(|e| format!("{e:?}"))?;
    store
        .initialize_document(&document, "native-context")
        .map_err(|e| format!("{e:?}"))?;
    let backup = store
        .export_database_backup()
        .map_err(|e| format!("{e:?}"))?;
    let mut snapshot = Connection::open_in_memory().map_err(|e| format!("{e:?}"))?;
    store
        .restore_database_backup_with_snapshot(&backup, &mut snapshot)
        .map_err(|e| format!("{e:?}"))?;
    let fonts = zinecv_engine::bundled_font_bytes();
    let preview = zinecv_engine::render_preview_with_resources(
        &document,
        None,
        &fonts,
        zinecv_engine::DEFAULT_REFERENCE_DATE,
    )
    .map_err(|e| format!("{e:?}"))?;
    let pdf = zinecv_engine::render_document_pdf_with_resources(
        &document,
        None,
        &fonts,
        zinecv_engine::DEFAULT_REFERENCE_DATE,
    )
    .map_err(|e| format!("{e:?}"))?;
    Ok(serde_json::json!({"schemaVersion":backup.schema_version,"restored":true,"pages":preview.pages.len(),"pdfBytes":pdf.bytes.len(),"nativeCore":true}).to_string())
}
#[no_mangle]
pub extern "C" fn zinecv_core_probe() -> *mut c_char {
    let result =
        std::panic::catch_unwind(probe).unwrap_or_else(|_| Err("Native core panic".into()));
    let json = match result {
        Ok(value) => value,
        Err(message) => serde_json::json!({"error":message}).to_string(),
    };
    CString::new(json)
        .expect("JSON contains no nul bytes")
        .into_raw()
}
/// # Safety
/// `value` must be an unfreed pointer returned by `zinecv_core_probe`.
#[no_mangle]
pub unsafe extern "C" fn zinecv_string_free(value: *mut c_char) {
    if !value.is_null() {
        drop(unsafe { CString::from_raw(value) });
    }
}
#[test]
fn native_probe_exercises_shared_store_and_engine() {
    let result: serde_json::Value = serde_json::from_str(&probe().unwrap()).unwrap();
    assert_eq!(result["schemaVersion"], 17);
    assert_eq!(result["restored"], true);
    assert!(result["pdfBytes"].as_u64().unwrap() > 100);
}
