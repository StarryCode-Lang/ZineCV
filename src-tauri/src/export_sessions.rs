//! Bounded host provenance for frozen exports. Tickets contain hashes and small
//! metadata only; the webview retains output bytes. Ordinary document switches
//! do not revoke a ticket, while a full database replacement changes generation.
use crate::{export_io, storage::Store};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use zinecv_contracts::{
    AppError, ErrorCode, ExportArtifact, ExportFileFormat, ExportReceipt, ExportResult,
    ExportWriteOutcome, FrozenExportSource, NativeExportResult, ResumeDocument,
};

const SESSION_TTL: Duration = Duration::from_secs(15 * 60);
const MAX_SESSIONS: usize = 8;
const MAX_WRITES_PER_SESSION: usize = 256;

#[derive(Clone, Default)]
pub(crate) struct ExportGeneration(Arc<()>);

#[derive(Default)]
pub(crate) struct ExportSessions(Mutex<SessionState>);

#[derive(Default)]
struct SessionState {
    generation: ExportGeneration,
    sequence: u64,
    tickets: HashMap<String, Ticket>,
}

struct Ticket {
    cursor: zinecv_contracts::AuthorityCursor,
    render_key: String,
    source: FrozenExportSource,
    artifacts: Vec<ExportArtifact>,
    source_page_count: u32,
    selected_pages: Option<Vec<u32>>,
    dpi: u16,
    registered: Instant,
    writes: HashMap<String, WriteState>,
}

struct WriteState {
    path: PathBuf,
    artifact_id: String,
    in_flight: bool,
    written: Option<WrittenProof>,
}

struct WrittenProof {
    receipt: ExportReceipt,
    recorded: bool,
}

#[derive(Clone)]
pub(crate) struct PreparedExportWrite {
    export_id: String,
    write_id: String,
    generation: ExportGeneration,
    pub(crate) path: PathBuf,
    artifact: ExportArtifact,
    already_written: bool,
}

fn error(message: &str) -> AppError {
    AppError::new(ErrorCode::Conflict, message, false)
}

fn lock(sessions: &ExportSessions) -> Result<std::sync::MutexGuard<'_, SessionState>, AppError> {
    sessions
        .0
        .lock()
        .map_err(|_| AppError::new(ErrorCode::StorageCorrupt, "导出会话锁失败", false))
}

fn utc_stamp() -> String {
    let at = time::OffsetDateTime::now_utc();
    format!(
        "{}T{:02}:{:02}:{:02}.{:03}Z",
        at.date(),
        at.hour(),
        at.minute(),
        at.second(),
        at.millisecond()
    )
}

fn unix_millis() -> Result<u128, AppError> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|value| value.as_millis())
        .map_err(|_| AppError::new(ErrorCode::Validation, "系统时间无效", false))
}

pub(crate) fn frozen_source(document: &ResumeDocument, branch_name: String) -> FrozenExportSource {
    static TEMPLATE_HASH: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    FrozenExportSource {
        document_title: document.title.clone(),
        branch_name,
        template_id: document.presentation.template_id.clone(),
        template_revision: document.presentation.template_revision.clone(),
        template_source_sha256: TEMPLATE_HASH
            .get_or_init(|| {
                format!(
                    "{:x}",
                    Sha256::digest(crate::engine::template_source_bytes())
                )
            })
            .clone(),
        frozen_at: utc_stamp(),
    }
}

fn artifacts(export: &ExportResult) -> Result<Vec<ExportArtifact>, AppError> {
    let mut result = Vec::new();
    let mut add = |artifact_id: String,
                   format: ExportFileFormat,
                   page: Option<u32>,
                   encoded: &str,
                   expected: &str|
     -> Result<(), AppError> {
        let bytes = export_io::decode_export_payload(encoded)?;
        let hash = format!("{:x}", Sha256::digest(&bytes));
        if bytes.is_empty() || hash != expected {
            return Err(error("冻结导出产物摘要无效"));
        }
        result.push(ExportArtifact {
            artifact_id,
            format,
            page,
            bytes: bytes.len(),
            sha256: hash,
        });
        Ok(())
    };
    if !export.data.pdf_base64.is_empty() {
        add(
            "pdf".into(),
            ExportFileFormat::Pdf,
            None,
            &export.data.pdf_base64,
            &export.data.pdf_sha256,
        )?;
    }
    for page in &export.data.png_pages {
        add(
            format!("png:{}", page.page),
            ExportFileFormat::Png,
            Some(page.page),
            &page.data_base64,
            &page.sha256,
        )?;
    }
    if let Some(long) = &export.data.long_png {
        add(
            "png:long".into(),
            ExportFileFormat::Png,
            Some(0),
            &long.data_base64,
            &long.sha256,
        )?;
    }
    if result.is_empty() || result.len() > 202 {
        return Err(error("冻结导出产物数量无效"));
    }
    Ok(result)
}

impl Ticket {
    fn in_flight(&self) -> bool {
        self.writes.values().any(|write| write.in_flight)
    }

    fn complete(&self) -> bool {
        if self
            .writes
            .values()
            .any(|write| write.written.as_ref().is_some_and(|proof| !proof.recorded))
        {
            return false;
        }
        let written = self
            .writes
            .values()
            .filter_map(|write| write.written.as_ref().map(|_| write.artifact_id.as_str()))
            .collect::<std::collections::HashSet<_>>();
        written.contains("pdf")
            || written.contains("png:long")
            || (self
                .artifacts
                .iter()
                .any(|item| item.page.is_some_and(|page| page > 0))
                && self
                    .artifacts
                    .iter()
                    .filter(|item| item.page.is_some_and(|page| page > 0))
                    .all(|item| written.contains(item.artifact_id.as_str())))
    }
}

impl ExportSessions {
    pub(crate) fn generation(&self) -> Result<ExportGeneration, AppError> {
        Ok(lock(self)?.generation.clone())
    }

    /// Caller owns Store first, so receipt publication and database restore have
    /// the same lock order. No old in-flight render can register in the new generation.
    pub(crate) fn invalidate(&self) -> Result<(), AppError> {
        let mut inner = lock(self)?;
        inner.generation = ExportGeneration::default();
        inner.tickets.clear();
        Ok(())
    }

    pub(crate) fn register(
        &self,
        generation: &ExportGeneration,
        export: ExportResult,
        source: FrozenExportSource,
    ) -> Result<NativeExportResult, AppError> {
        let artifacts = artifacts(&export)?;
        let mut inner = lock(self)?;
        if !Arc::ptr_eq(&generation.0, &inner.generation.0) {
            return Err(error("数据库已恢复，请重新导出"));
        }
        inner
            .tickets
            .retain(|_, ticket| ticket.registered.elapsed() < SESSION_TTL || ticket.in_flight());
        if inner.tickets.len() >= MAX_SESSIONS {
            // 失败导出留下的放弃写入（未写盘且不在途）不算占用：否则几次快速
            // 失败就能在 TTL 内占满会话池，阻断后续正常导出。已有写盘证据
            // （含记录失败待重试）的票据仍按原语义保留。
            let completed = inner
                .tickets
                .iter()
                .filter(|(_, ticket)| {
                    !ticket.in_flight()
                        && (ticket.writes.is_empty()
                            || ticket
                                .writes
                                .values()
                                .all(|write| !write.in_flight && write.written.is_none())
                            || ticket.complete())
                })
                .min_by_key(|(_, ticket)| ticket.registered)
                .map(|(id, _)| id.clone());
            if let Some(id) = completed {
                inner.tickets.remove(&id);
            } else {
                return Err(AppError::new(
                    ErrorCode::ResourceLimit,
                    "待保存的导出过多，请先完成已有导出",
                    false,
                ));
            }
        }
        inner.sequence = inner
            .sequence
            .checked_add(1)
            .ok_or_else(|| error("导出会话编号已耗尽"))?;
        // Unique host identity, not an authentication secret. Only main-window
        // commands can use it, and every write must match a frozen artifact hash.
        let export_id = format!(
            "{:x}",
            Sha256::digest(
                format!(
                    "{}:{}:{}:{}",
                    std::process::id(),
                    unix_millis()?,
                    inner.sequence,
                    export.render_key
                )
                .as_bytes()
            )
        )[..32]
            .to_owned();
        inner.tickets.insert(
            export_id.clone(),
            Ticket {
                cursor: export.cursor.clone(),
                render_key: export.render_key.clone(),
                source: source.clone(),
                artifacts: artifacts.clone(),
                source_page_count: export.data.page_count,
                selected_pages: export.data.selected_pages.clone(),
                dpi: export.data.dpi,
                registered: Instant::now(),
                writes: HashMap::new(),
            },
        );
        Ok(NativeExportResult {
            export,
            export_id,
            source,
            artifacts,
        })
    }

    pub(crate) fn prepare_write(
        &self,
        export_id: &str,
        artifact_id: &str,
        write_id: &str,
        path: &Path,
        bytes: &[u8],
    ) -> Result<PreparedExportWrite, AppError> {
        if write_id.is_empty()
            || write_id.len() > 64
            || !write_id
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
        {
            return Err(AppError::new(
                ErrorCode::Validation,
                "导出写入编号无效",
                false,
            ));
        }
        let mut inner = lock(self)?;
        let generation = inner.generation.clone();
        let ticket = inner
            .tickets
            .get_mut(export_id)
            .ok_or_else(|| error("导出会话已失效，请重新导出"))?;
        if ticket.registered.elapsed() >= SESSION_TTL {
            return Err(error("导出会话已过期，请重新导出"));
        }
        let artifact = ticket
            .artifacts
            .iter()
            .find(|item| item.artifact_id == artifact_id)
            .cloned()
            .ok_or_else(|| error("产物不属于该冻结导出"))?;
        if bytes.len() != artifact.bytes
            || format!("{:x}", Sha256::digest(bytes)) != artifact.sha256
        {
            return Err(error("写入数据与冻结导出不符"));
        }
        if !ticket.writes.contains_key(write_id) && ticket.writes.len() >= MAX_WRITES_PER_SESSION {
            return Err(AppError::new(
                ErrorCode::ResourceLimit,
                "导出会话写入数量超限",
                false,
            ));
        }
        let write = ticket
            .writes
            .entry(write_id.to_owned())
            .or_insert_with(|| WriteState {
                path: path.to_owned(),
                artifact_id: artifact_id.into(),
                in_flight: false,
                written: None,
            });
        if write.path != path || write.artifact_id != artifact_id {
            return Err(error("写入编号已用于不同文件或产物"));
        }
        if write.in_flight {
            return Err(AppError::new(
                ErrorCode::Conflict,
                "该导出文件正在写入，请稍后重试",
                true,
            ));
        }
        write.in_flight = true;
        Ok(PreparedExportWrite {
            export_id: export_id.into(),
            write_id: write_id.into(),
            generation,
            path: path.to_owned(),
            artifact,
            already_written: write.written.is_some(),
        })
    }

    pub(crate) fn abandon_write(&self, prepared: &PreparedExportWrite) {
        if let Ok(mut inner) = lock(self) {
            if let Some(write) = inner
                .tickets
                .get_mut(&prepared.export_id)
                .and_then(|ticket| ticket.writes.get_mut(&prepared.write_id))
            {
                write.in_flight = false;
            }
        }
    }

    pub(crate) fn finish_write(
        &self,
        store: &mut Store,
        prepared: &PreparedExportWrite,
        mut outcome: ExportWriteOutcome,
    ) -> ExportWriteOutcome {
        let mut finish = || -> Result<ExportReceipt, AppError> {
            let mut inner = lock(self)?;
            if !Arc::ptr_eq(&prepared.generation.0, &inner.generation.0) {
                return Err(error("数据库已恢复，文件已保存但未记录到当前数据库"));
            }
            let ticket = inner
                .tickets
                .get_mut(&prepared.export_id)
                .ok_or_else(|| error("导出会话已失效，文件已保存但未记录"))?;
            let write = ticket
                .writes
                .get_mut(&prepared.write_id)
                .ok_or_else(|| error("导出写入状态已失效"))?;
            write.in_flight = false;
            if outcome.bytes != prepared.artifact.bytes
                || outcome.sha256 != prepared.artifact.sha256
            {
                return Err(error("磁盘验证结果与冻结产物不符"));
            }
            if write.written.is_none() {
                write.written = Some(WrittenProof {
                    recorded: false,
                    receipt: ExportReceipt {
                        id: format!(
                            "export:{:020}:{}:{}",
                            unix_millis()?,
                            prepared.export_id,
                            prepared.write_id
                        ),
                        export_id: prepared.export_id.clone(),
                        cursor: ticket.cursor.clone(),
                        render_key: ticket.render_key.clone(),
                        source: ticket.source.clone(),
                        artifact: prepared.artifact.clone(),
                        written_at: utc_stamp(),
                        filename: prepared
                            .path
                            .file_name()
                            .ok_or_else(|| error("导出文件名无效"))?
                            .to_string_lossy()
                            .into_owned(),
                        source_page_count: ticket.source_page_count,
                        selected_pages: ticket.selected_pages.clone(),
                        dpi: ticket.dpi,
                    },
                });
            }
            let proof = write
                .written
                .as_mut()
                .ok_or_else(|| error("导出写入凭据缺失"))?;
            let receipt = store
                .record_export_receipt(&proof.receipt)
                .map_err(AppError::from)?;
            proof.recorded = true;
            Ok(receipt)
        };
        match finish() {
            Ok(receipt) => outcome.receipt = Some(receipt),
            Err(error) => outcome.recording_error = Some(error.message),
        }
        outcome
    }
}

impl PreparedExportWrite {
    /// Replays verify the original file rather than overwriting later external edits.
    pub(crate) fn write_file(&self, bytes: &[u8]) -> Result<ExportWriteOutcome, AppError> {
        if self.already_written {
            export_io::verify_export_file(
                &self.path,
                &ExportWriteOutcome {
                    bytes: self.artifact.bytes,
                    sha256: self.artifact.sha256.clone(),
                    receipt: None,
                    recording_error: None,
                },
            )
        } else {
            export_io::write_export_bytes(&self.path, bytes)
        }
    }
}

#[cfg(test)]
#[path = "export_sessions_tests.rs"]
mod tests;
