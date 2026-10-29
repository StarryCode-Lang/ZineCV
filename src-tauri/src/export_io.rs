//! Native save dialogs and durable file writes for unified engine exports.
//!
//! The webview never receives raw file-system paths to write on its own: the
//! dialog result comes back through the host, and every write is bounded,
//! error-mapped to domain [`ErrorCode`]s, and checksummed.
use crate::domain::{AppError, ErrorCode};
use base64::{engine::general_purpose::STANDARD, Engine as _};
use sha2::{Digest, Sha256};
use std::io::{ErrorKind, Write};
use std::path::Path;
use tauri::{AppHandle, Manager};

/// Export bundles are capped at 48 MiB encoded; allow headroom for the
/// decoded payload plus future small metadata, but nothing unbounded.
pub const MAX_EXPORT_WRITE_BYTES: usize = 64 * 1024 * 1024;

pub use zinecv_contracts::ExportWriteOutcome;

/// Map a real OS write error onto a user-actionable domain error.
pub fn map_write_error(error: &std::io::Error) -> AppError {
    // Win32 sharing/lock violations are PermissionDenied at the std layer,
    // but retrying after closing the other application is actionable.
    #[cfg(windows)]
    if matches!(error.raw_os_error(), Some(32 | 33)) {
        return AppError::new(
            ErrorCode::Permission,
            "目标文件正被其他程序占用，请关闭后重试",
            true,
        );
    }
    let message = error.to_string();
    match error.kind() {
        ErrorKind::StorageFull => AppError::new(
            ErrorCode::StorageFull,
            "目标磁盘空间不足，请清理后重试",
            true,
        ),
        ErrorKind::PermissionDenied => AppError::new(
            ErrorCode::Permission,
            format!("目标位置拒绝写入：{message}"),
            false,
        ),
        ErrorKind::NotFound => AppError::new(
            ErrorCode::NotFound,
            format!("目标文件夹不存在：{message}"),
            false,
        ),
        ErrorKind::InvalidInput => AppError::new(
            ErrorCode::Validation,
            format!("导出路径无效：{message}"),
            false,
        ),
        _ => AppError::new(
            ErrorCode::Validation,
            format!("导出文件写入失败：{message}"),
            true,
        ),
    }
}

/// Strip filesystem-reserved characters and control characters while keeping
/// CJK and other Unicode text (Chinese file names must survive verbatim).
pub fn sanitize_export_file_name(raw: &str) -> Result<String, AppError> {
    let cleaned: String = raw
        .chars()
        .filter(|character| !character.is_control())
        .map(|character| {
            if matches!(
                character,
                '\\' | '/' | ':' | '*' | '?' | '"' | '<' | '>' | '|'
            ) {
                '-'
            } else {
                character
            }
        })
        .collect();
    let cleaned = cleaned.trim().trim_matches('.').to_string();
    if cleaned.chars().count() > 120 {
        return Err(AppError::new(
            ErrorCode::Validation,
            "导出文件名过长（最多 120 个字符）",
            false,
        ));
    }
    if cleaned.is_empty() {
        return Err(AppError::new(
            ErrorCode::Validation,
            "导出文件名为空",
            false,
        ));
    }
    Ok(cleaned)
}

pub fn decode_export_payload(data_base64: &str) -> Result<Vec<u8>, AppError> {
    // Reject oversized payloads before decoding to bound allocation.
    if data_base64.len() > (MAX_EXPORT_WRITE_BYTES / 3) * 4 {
        return Err(AppError::new(
            ErrorCode::ResourceLimit,
            "导出数据超出写入预算",
            false,
        ));
    }
    STANDARD.decode(data_base64).map_err(|error| {
        AppError::new(
            ErrorCode::Validation,
            format!("导出数据无效：{error}"),
            false,
        )
    })
}

pub fn validate_export_target(path: &str) -> Result<&Path, AppError> {
    let target = Path::new(path);
    if !target.is_absolute() {
        return Err(AppError::new(
            ErrorCode::Validation,
            "导出路径必须是绝对路径",
            false,
        ));
    }
    if target.is_dir() {
        return Err(AppError::new(
            ErrorCode::Validation,
            "导出目标是一个文件夹，请选择文件",
            false,
        ));
    }
    Ok(target)
}

/// Write the decoded bytes durably: create a temp file in the same folder,
/// write, force the data to the disk, then rename it over the target so a
/// crash or power loss cannot leave a half-written export or destroy an
/// existing file with the same name. Temp cleanup happens on every failure
/// path so aborted exports do not litter the folder.
pub fn write_export_bytes(target: &Path, bytes: &[u8]) -> Result<ExportWriteOutcome, AppError> {
    let written = write_export_bytes_with(
        target,
        bytes,
        |file, bytes| {
            #[cfg(feature = "test-hooks")]
            match export_test_fault().as_deref() {
                Some("permission") => return Err(ErrorKind::PermissionDenied.into()),
                Some("storage-full") => {
                    file.write_all(&bytes[..bytes.len().min(17)])?;
                    return Err(ErrorKind::StorageFull.into());
                }
                Some("interrupted") => {
                    file.write_all(&bytes[..bytes.len().min(17)])?;
                    return Err(ErrorKind::Interrupted.into());
                }
                Some("sync") => {
                    file.write_all(bytes)?;
                    return Err(std::io::Error::other("injected sync failure"));
                }
                _ => {}
            }
            file.write_all(bytes)?;
            file.sync_all()
        },
        |temp, target| {
            #[cfg(all(windows, feature = "test-hooks"))]
            if export_test_fault().as_deref() == Some("occupied") {
                return Err(std::io::Error::from_raw_os_error(32));
            }
            std::fs::rename(temp, target)
        },
    )?;
    verify_export_file(target, &written)
}

/// Verify the current file with a bounded streaming read. This is deliberately
/// separate from hashing the buffer passed to write_all.
pub fn verify_export_file(
    target: &Path,
    expected: &ExportWriteOutcome,
) -> Result<ExportWriteOutcome, AppError> {
    use std::io::Read;
    let mut file = std::fs::File::open(target)
        .map_err(|error| map_write_error(&error).with_context("文件回读验证失败"))?;
    let length = file
        .metadata()
        .map_err(|error| map_write_error(&error).with_context("文件回读验证失败"))?
        .len();
    if length != expected.bytes as u64 || length > MAX_EXPORT_WRITE_BYTES as u64 {
        return Err(AppError::new(
            ErrorCode::Conflict,
            "导出文件长度与冻结产物不符",
            false,
        ));
    }
    let mut hash = Sha256::new();
    let mut count = 0usize;
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let read = file
            .read(&mut buffer)
            .map_err(|error| map_write_error(&error).with_context("文件回读验证失败"))?;
        if read == 0 {
            break;
        }
        count = count
            .checked_add(read)
            .filter(|value| *value <= MAX_EXPORT_WRITE_BYTES)
            .ok_or_else(|| {
                AppError::new(ErrorCode::ResourceLimit, "导出文件超出验证预算", false)
            })?;
        hash.update(&buffer[..read]);
    }
    let sha256 = format!("{:x}", hash.finalize());
    if count != expected.bytes || sha256 != expected.sha256 {
        return Err(AppError::new(
            ErrorCode::Conflict,
            "导出文件摘要与冻结产物不符",
            false,
        ));
    }
    Ok(ExportWriteOutcome {
        bytes: count,
        sha256,
        receipt: None,
        recording_error: None,
    })
}

// Test-only, bounded fault control. No disk filling or public IPC hooks.
#[cfg(feature = "test-hooks")]
fn export_test_fault() -> Option<String> {
    let path = std::env::var_os("ZINECV_TEST_EXPORT_FAULT_FILE")?;
    let mut file = std::fs::File::open(path).ok()?;
    let mut contents = String::new();
    use std::io::Read;
    Read::by_ref(&mut file)
        .take(64)
        .read_to_string(&mut contents)
        .ok()?;
    Some(contents.trim().to_owned())
}

fn write_export_bytes_with(
    target: &Path,
    bytes: &[u8],
    write: impl FnOnce(&mut std::fs::File, &[u8]) -> std::io::Result<()>,
    replace: impl FnOnce(&Path, &Path) -> std::io::Result<()>,
) -> Result<ExportWriteOutcome, AppError> {
    let parent = target
        .parent()
        .ok_or_else(|| AppError::new(ErrorCode::Validation, "导出路径无效：缺少父目录", false))?;
    let name = target
        .file_name()
        .ok_or_else(|| AppError::new(ErrorCode::Validation, "导出路径无效：缺少文件名", false))?;
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_nanos())
        .unwrap_or_default();
    let temp = parent.join(format!(".{}.{}.zinecv-part", name.to_string_lossy(), stamp));
    let write_temp = || -> Result<ExportWriteOutcome, AppError> {
        let mut file = std::fs::File::create(&temp).map_err(|error| map_write_error(&error))?;
        write(&mut file, bytes).map_err(|error| map_write_error(&error))?;
        Ok(ExportWriteOutcome {
            bytes: bytes.len(),
            sha256: format!("{:x}", Sha256::digest(bytes)),
            receipt: None,
            recording_error: None,
        })
    };
    match write_temp() {
        Ok(outcome) => match replace(&temp, target) {
            Ok(()) => Ok(outcome),
            Err(error) => {
                let _ = std::fs::remove_file(&temp);
                Err(map_write_error(&error))
            }
        },
        Err(error) => {
            let _ = std::fs::remove_file(&temp);
            Err(error)
        }
    }
}

fn dialog_filters(kind: &str) -> Result<(&'static str, &'static [&'static str]), AppError> {
    match kind {
        "pdf" => Ok(("PDF 文件", &["pdf"])),
        "png" => Ok(("PNG 图片", &["png"])),
        _ => Err(AppError::new(
            ErrorCode::Validation,
            "不支持的导出类型，仅支持 pdf 或 png",
            false,
        )),
    }
}

/// Show a modal save dialog on the main thread and block the calling worker
/// until the user picks a path or cancels (None).
pub fn show_save_dialog(
    app: &AppHandle,
    kind: &str,
    default_name: String,
) -> Result<Option<String>, AppError> {
    let (title, extensions) = dialog_filters(kind)?;
    let (sender, receiver) = std::sync::mpsc::channel();
    let app_handle = app.clone();
    app.run_on_main_thread(move || {
        let mut dialog = rfd::FileDialog::new()
            .set_title("导出简历")
            .add_filter(title, extensions)
            .set_file_name(&default_name);
        if let Some(window) = app_handle.get_webview_window("main") {
            dialog = dialog.set_parent(&window);
        }
        let _ = sender.send(
            dialog
                .save_file()
                .map(|path| path.to_string_lossy().into_owned()),
        );
    })
    .map_err(|error| {
        AppError::new(
            ErrorCode::EngineFailure,
            format!("无法打开保存对话框：{error}"),
            false,
        )
    })?;
    receiver.recv().map_err(|error| {
        AppError::new(
            ErrorCode::EngineFailure,
            format!("保存对话框已中断：{error}"),
            false,
        )
    })
}

pub fn show_folder_dialog(app: &AppHandle) -> Result<Option<String>, AppError> {
    let (sender, receiver) = std::sync::mpsc::channel();
    let app_handle = app.clone();
    app.run_on_main_thread(move || {
        let mut dialog = rfd::FileDialog::new().set_title("选择导出文件夹");
        if let Some(window) = app_handle.get_webview_window("main") {
            dialog = dialog.set_parent(&window);
        }
        let _ = sender.send(
            dialog
                .pick_folder()
                .map(|path| path.to_string_lossy().into_owned()),
        );
    })
    .map_err(|error| {
        AppError::new(
            ErrorCode::EngineFailure,
            format!("无法打开文件夹选择对话框：{error}"),
            false,
        )
    })?;
    receiver.recv().map_err(|error| {
        AppError::new(
            ErrorCode::EngineFailure,
            format!("文件夹选择对话框已中断：{error}"),
            false,
        )
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sanitize_keeps_chinese_and_replaces_reserved_characters() {
        assert_eq!(
            sanitize_export_file_name("张三-产品 简历").unwrap(),
            "张三-产品 简历"
        );
        assert_eq!(
            sanitize_export_file_name("a/b\\c:d*e?f\"g<h>i|j").unwrap(),
            "a-b-c-d-e-f-g-h-i-j"
        );
        assert_eq!(sanitize_export_file_name("  名字。 ").unwrap(), "名字。");
        assert!(sanitize_export_file_name("..").is_err());
        assert!(sanitize_export_file_name("").is_err());
        assert!(sanitize_export_file_name("a\u{0007}b").is_ok());
        assert_eq!(sanitize_export_file_name("a\u{0007}b").unwrap(), "ab");
    }

    #[test]
    fn write_errors_map_to_actionable_domain_codes() {
        let disk_full = map_write_error(&std::io::Error::from(ErrorKind::StorageFull));
        assert_eq!(disk_full.code, ErrorCode::StorageFull);
        assert!(disk_full.retryable);
        let denied = map_write_error(&std::io::Error::from(ErrorKind::PermissionDenied));
        assert_eq!(denied.code, ErrorCode::Permission);
        assert!(!denied.retryable);
        let missing = map_write_error(&std::io::Error::from(ErrorKind::NotFound));
        assert_eq!(missing.code, ErrorCode::NotFound);
        let other = map_write_error(&std::io::Error::other("device error"));
        assert_eq!(other.code, ErrorCode::Validation);
        assert!(other.retryable);
        let interrupted = map_write_error(&std::io::Error::from(ErrorKind::Interrupted));
        assert_eq!(interrupted.code, ErrorCode::Validation);
        assert!(interrupted.retryable);
        #[cfg(windows)]
        for code in [32, 33] {
            let occupied = map_write_error(&std::io::Error::from_raw_os_error(code));
            assert_eq!(occupied.code, ErrorCode::Permission);
            assert!(occupied.retryable);
            assert!(occupied.message.contains("占用"));
        }
    }

    #[test]
    fn failed_writes_preserve_target_clean_partials_and_allow_retry() {
        for kind in [
            ErrorKind::StorageFull,
            ErrorKind::PermissionDenied,
            ErrorKind::Interrupted,
            ErrorKind::Other,
        ] {
            let directory = std::env::temp_dir().join(format!(
                "zinecv-export-fault-{}-{kind:?}",
                std::process::id()
            ));
            std::fs::create_dir_all(&directory).unwrap();
            let target = directory.join("existing.pdf");
            std::fs::write(&target, b"original").unwrap();
            let result = write_export_bytes_with(
                &target,
                b"replacement",
                |file, bytes| {
                    file.write_all(&bytes[..3])?;
                    Err(kind.into())
                },
                |temp, target| std::fs::rename(temp, target),
            );
            let error = result.unwrap_err();
            assert_eq!(
                error.code,
                map_write_error(&std::io::Error::from(kind)).code
            );
            assert_eq!(std::fs::read(&target).unwrap(), b"original");
            assert_eq!(
                std::fs::read_dir(&directory).unwrap().count(),
                1,
                "failed partial must be removed"
            );
            write_export_bytes(&target, b"replacement").unwrap();
            assert_eq!(std::fs::read(&target).unwrap(), b"replacement");
            std::fs::remove_file(target).unwrap();
            std::fs::remove_dir(directory).unwrap();
        }
    }

    #[test]
    fn failed_replace_preserves_existing_target_and_cleans_synced_temp() {
        let directory =
            std::env::temp_dir().join(format!("zinecv-export-replace-{}", std::process::id()));
        std::fs::create_dir_all(&directory).unwrap();
        let target = directory.join("existing.pdf");
        std::fs::write(&target, b"original").unwrap();
        let result = write_export_bytes_with(
            &target,
            b"replacement",
            |file, bytes| {
                file.write_all(bytes)?;
                file.sync_all()
            },
            |_, _| Err(ErrorKind::PermissionDenied.into()),
        );
        assert_eq!(result.unwrap_err().code, ErrorCode::Permission);
        assert_eq!(std::fs::read(&target).unwrap(), b"original");
        assert_eq!(std::fs::read_dir(&directory).unwrap().count(), 1);
        write_export_bytes(&target, b"replacement").unwrap();
        std::fs::remove_file(target).unwrap();
        std::fs::remove_dir(directory).unwrap();
    }

    #[test]
    fn payload_decode_is_bounded_and_validating() {
        assert!(decode_export_payload("!!!not base64!!!").is_err());
        assert_eq!(
            decode_export_payload(&STANDARD.encode(b"%PDF-1.4")).unwrap(),
            b"%PDF-1.4"
        );
        let oversized = "A".repeat((MAX_EXPORT_WRITE_BYTES / 3) * 4 + 8);
        assert!(decode_export_payload(&oversized).is_err());
    }

    #[test]
    fn export_target_must_be_absolute_and_not_a_directory() {
        assert!(validate_export_target("relative/out.png").is_err());
        assert!(validate_export_target("C:\\some\\dir\\out.png").is_ok());
        assert!(validate_export_target(env!("CARGO_MANIFEST_DIR")).is_err());
    }

    #[test]
    fn durable_write_reports_bytes_and_checksum() {
        let directory =
            std::env::temp_dir().join(format!("zinecv-export-io-{}", std::process::id()));
        std::fs::create_dir_all(&directory).unwrap();
        let target = directory.join("中文 路径.png");
        let outcome = write_export_bytes(&target, b"binary\0payload").unwrap();
        assert_eq!(outcome.bytes, 14);
        assert_eq!(
            outcome.sha256,
            format!("{:x}", Sha256::digest(b"binary\0payload"))
        );
        assert_eq!(std::fs::read(&target).unwrap(), b"binary\0payload");
        std::fs::remove_file(&target).unwrap();
        std::fs::remove_dir(&directory).unwrap();
    }

    #[test]
    fn dialog_filters_reject_unknown_kinds() {
        assert!(dialog_filters("pdf").is_ok());
        assert!(dialog_filters("png").is_ok());
        assert!(dialog_filters("exe").is_err());
    }
}
