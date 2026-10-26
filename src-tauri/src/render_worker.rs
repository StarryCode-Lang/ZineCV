use std::collections::{HashMap, HashSet};
use std::io::{self, BufRead, BufReader, BufWriter, Read, Write};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::{mpsc, Arc, Mutex, OnceLock};
use std::thread;
use std::time::{Duration, Instant};

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine as _;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use typst::foundations::Bytes;

use crate::domain::{AuthorityCursor, ExportProduct, ResumeDocument};
use crate::engine::{self, AvatarAsset, RenderFontBytes, RenderedPdf};
use crate::render_scheduler::{RenderLane, RenderScheduler, SubmitResult};

pub const PROTOCOL_VERSION: u16 = 1;
pub const RESOURCE_VERSION: u16 = 1;
pub const ENGINE_VERSION: &str = "zinecv-typst-0.15.1-engine-2";
pub const WORKER_SWITCH: &str = "--zinecv-render-worker";
pub const WORKER_MEMORY_LIMIT_BYTES: usize = 1536 * 1024 * 1024;
pub const RENDER_TIMEOUT: Duration = Duration::from_secs(90);
const STARTUP_TIMEOUT: Duration = Duration::from_secs(10);
const MAX_DOCUMENT_BYTES: usize = 8 * 1024 * 1024;
const MAX_RESOURCE_BYTES: usize = 32 * 1024 * 1024;
const MAX_PDF_BYTES: usize = 48 * 1024 * 1024;
const MAX_PROTOCOL_LINE_BYTES: usize = 68 * 1024 * 1024;
const MAX_ERROR_CHARS: usize = 4096;
const MAX_PAGE_COUNT: usize = 200;
const REFERENCE_DATE: &str = "2026-09-28";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Ord, PartialOrd, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
enum ResourceRole {
    BodyFontRegular,
    BodyFontHeavy,
    IconFont,
    HeadingFontRegular,
    HeadingFontBold,
    SelectedBodyRegular,
    SelectedBodyBold,
    Avatar,
}

#[derive(Debug, Clone)]
struct ResourceMaterial {
    role: ResourceRole,
    hash: String,
    mime: String,
    bytes: Bytes,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ResourceDescriptor {
    role: ResourceRole,
    hash: String,
    size_bytes: usize,
    mime: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
enum RenderFormat {
    Pdf,
    Preview,
    Fit,
    Export,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RenderManifest {
    protocol_version: u16,
    engine_version: String,
    resource_version: u16,
    generation: u64,
    request_id: u64,
    render_key: String,
    template_sha256: String,
    cursor: AuthorityCursor,
    document: ResumeDocument,
    reference_date: String,
    format: RenderFormat,
    resources: Vec<ResourceDescriptor>,
    /// 导出产物选择（仅 Export 格式消费）；缺省即 Bundle = 完整产物，
    /// 与不含该字段的旧消息保持兼容。
    #[serde(default)]
    product: Option<ExportProduct>,
    /// 1-based 页码选择（仅 Export + Pdf 产物消费）；缺省 None = 不选页。
    #[serde(default)]
    selected_pages: Option<Vec<u32>>,
    /// PNG output resolution; absent preserves the historical 192 DPI default.
    #[serde(default)]
    dpi: Option<u16>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    content = "payload",
    rename_all = "camelCase",
    deny_unknown_fields
)]
enum HostMessage {
    Render {
        manifest: Box<RenderManifest>,
    },
    ResourceBytes {
        request_id: u64,
        generation: u64,
        role: ResourceRole,
        hash: String,
        size_bytes: usize,
        mime: String,
        data_base64: String,
    },
}

/// 资源响应的借用序列化视图：JSON 形状与 `HostMessage::ResourceBytes` 完全
/// 一致（含字段命名——原协议 struct variant 字段保持 snake_case），但允许
/// 直接借用按 hash 缓存的 base64 载荷——命中内置字体缓存时零复制发送，
/// 不再每次响应重新编码 ~29MB。
#[derive(serde::Serialize)]
#[serde(tag = "kind", content = "payload", rename_all = "camelCase")]
enum HostMessageRef<'a> {
    ResourceBytes(ResourceBytesRef<'a>),
}

#[derive(serde::Serialize)]
struct ResourceBytesRef<'a> {
    request_id: u64,
    generation: u64,
    role: ResourceRole,
    hash: &'a str,
    size_bytes: usize,
    mime: &'a str,
    data_base64: &'a str,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    content = "payload",
    rename_all = "camelCase",
    deny_unknown_fields
)]
enum WorkerMessage {
    Hello {
        protocol_version: u16,
        engine_version: String,
        resource_version: u16,
        generation: u64,
    },
    ResourceRequest {
        request_id: u64,
        generation: u64,
        role: ResourceRole,
        hash: String,
    },
    Rendered {
        request_id: u64,
        generation: u64,
        render_key: String,
        pdf_sha256: String,
        pdf_base64: String,
        page_count: usize,
    },
    Failed {
        request_id: u64,
        generation: u64,
        code: String,
        message: String,
    },
}

#[derive(Debug, Serialize)]
struct RenderKeyInput<'a> {
    protocol_version: u16,
    engine_version: &'a str,
    resource_version: u16,
    template_sha256: String,
    cursor: &'a AuthorityCursor,
    document: &'a ResumeDocument,
    reference_date: &'a str,
    format: RenderFormat,
    resources: &'a [ResourceDescriptor],
}

/// 内置字体是编译期常量：宿主侧只保留一份材料（含 SHA-256 身份哈希）与
/// 预编码的 base64 载荷。每次渲染只克隆 `Bytes` 的引用计数与浅拷贝条目；
/// 资源响应直接复用按 hash 缓存的编码，不再每次请求重算 ~22MB 的 SHA-256
/// 与重新编码 ~29MB 的 base64。
struct BundledFontMaterial {
    material: ResourceMaterial,
    encoded_base64: String,
}

/// worker 一次 generation 内已验证的字体字节缓存：仅限三个固定字体角色，
/// 每个角色至多一条（新身份替换旧条目，禁止无界收集任意资源）；命中要求
/// (hash, size, mime, resourceVersion) 完全一致。缓存随 `worker_loop` 的
/// 局部状态存活——worker 进程重启后自然重新初始化资源状态。
#[derive(Default)]
struct FontResourceCache {
    entries: HashMap<ResourceRole, CachedFontBytes>,
}

struct CachedFontBytes {
    hash: String,
    size_bytes: usize,
    mime: String,
    resource_version: u16,
    bytes: Bytes,
}

impl FontResourceCache {
    fn lookup(
        &self,
        role: ResourceRole,
        hash: &str,
        size_bytes: usize,
        mime: &str,
        resource_version: u16,
    ) -> Option<&Bytes> {
        let cached = self.entries.get(&role)?;
        (cached.hash == hash
            && cached.size_bytes == size_bytes
            && cached.mime == mime
            && cached.resource_version == resource_version)
            .then_some(&cached.bytes)
    }

    fn store(
        &mut self,
        role: ResourceRole,
        hash: &str,
        size_bytes: usize,
        mime: &str,
        resource_version: u16,
        bytes: Bytes,
    ) {
        self.entries.insert(
            role,
            CachedFontBytes {
                hash: hash.to_owned(),
                size_bytes,
                mime: mime.to_owned(),
                resource_version,
                bytes,
            },
        );
    }
}

struct WorkerProcess {
    child: Child,
    input: BufWriter<ChildStdin>,
    messages: mpsc::Receiver<io::Result<WorkerMessage>>,
    generation: u64,
    broken: bool,
    retryable_crash: bool,
    #[cfg(windows)]
    job: WindowsJob,
}

impl WorkerProcess {
    fn start(generation: u64) -> Result<Self, String> {
        let executable = std::env::current_exe()
            .map_err(|error| format!("cannot locate application executable: {error}"))?;
        let mut command = Command::new(executable);
        command
            .arg(WORKER_SWITCH)
            .arg(generation.to_string())
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .env_remove("ZINECV_DATA_DIR");
        #[cfg(windows)]
        use std::os::windows::process::CommandExt;
        #[cfg(windows)]
        command.creation_flags(windows_sys::Win32::System::Threading::CREATE_NO_WINDOW);
        let mut child = command
            .spawn()
            .map_err(|error| format!("cannot start render worker: {error}"))?;
        #[cfg(windows)]
        let job = match WindowsJob::assign(&child) {
            Ok(job) => job,
            Err(error) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(error);
            }
        };
        let input = child
            .stdin
            .take()
            .ok_or("render worker stdin was not created")?;
        let output = child
            .stdout
            .take()
            .ok_or("render worker stdout was not created")?;
        let (sender, messages) = mpsc::channel();
        thread::Builder::new()
            .name(format!("zinecv-render-reader-{generation}"))
            .spawn(move || {
                let mut reader = BufReader::new(output);
                loop {
                    let result = read_message(&mut reader);
                    let done = result.is_err();
                    if sender.send(result).is_err() || done {
                        break;
                    }
                }
            })
            .map_err(|error| format!("cannot start render protocol reader: {error}"))?;
        let mut worker = Self {
            child,
            input: BufWriter::new(input),
            messages,
            generation,
            broken: false,
            retryable_crash: false,
            #[cfg(windows)]
            job,
        };
        let hello = worker.receive(STARTUP_TIMEOUT)?;
        match hello {
            WorkerMessage::Hello {
                protocol_version,
                engine_version,
                resource_version,
                generation: hello_generation,
            } if protocol_version == PROTOCOL_VERSION
                && engine_version == ENGINE_VERSION
                && resource_version == RESOURCE_VERSION
                && hello_generation == generation =>
            {
                Ok(worker)
            }
            _ => {
                worker.broken = true;
                Err("render worker version handshake failed".into())
            }
        }
    }

    fn receive(&mut self, timeout: Duration) -> Result<WorkerMessage, String> {
        match self.messages.recv_timeout(timeout) {
            Ok(Ok(message)) => Ok(message),
            Ok(Err(error)) => {
                self.broken = true;
                self.retryable_crash = error.kind() == io::ErrorKind::UnexpectedEof;
                Err(format!("render worker protocol error: {error}"))
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {
                self.broken = true;
                Err("render worker hard timeout".into())
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                self.broken = true;
                self.retryable_crash = true;
                Err("render worker exited without a response".into())
            }
        }
    }

    fn render(
        &mut self,
        manifest: &RenderManifest,
        resources: &[ResourceMaterial],
    ) -> Result<RenderedPdf, String> {
        let deadline = Instant::now() + render_timeout(manifest.format);
        write_message(
            &mut self.input,
            &HostMessage::Render {
                manifest: Box::new(manifest.clone()),
            },
        )
        .map_err(|error| {
            self.broken = true;
            format!("cannot send render manifest: {error}")
        })?;
        let mut sent = HashSet::new();
        loop {
            let now = Instant::now();
            if now >= deadline {
                self.broken = true;
                return Err(format!(
                    "render worker exceeded the {} second hard timeout",
                    render_timeout(manifest.format).as_secs()
                ));
            }
            let response = self.receive(deadline.saturating_duration_since(now))?;
            match response {
                WorkerMessage::ResourceRequest {
                    request_id,
                    generation,
                    role,
                    hash,
                } => {
                    if request_id != manifest.request_id
                        || generation != self.generation
                        || !sent.insert(role)
                    {
                        self.broken = true;
                        return Err("worker requested a stale or duplicate resource".into());
                    }
                    let descriptor = manifest
                        .resources
                        .iter()
                        .find(|item| item.role == role && item.hash == hash)
                        .ok_or_else(|| {
                            self.broken = true;
                            "worker requested an undeclared resource".to_owned()
                        })?;
                    let resource = resources
                        .iter()
                        .find(|item| item.role == role && item.hash == hash)
                        .ok_or_else(|| {
                            self.broken = true;
                            format!("host has no frozen bytes for resource {role:?}")
                        })?;
                    // 完整性判定直接比对材料创建时缓存的身份哈希（内置字体
                    // 每进程只算一次、avatar 每次冻结时算一次），不再对每次
                    // 资源响应重算 ~22MB 的 SHA-256。
                    if resource.bytes.len() != descriptor.size_bytes
                        || resource.hash != descriptor.hash
                    {
                        self.broken = true;
                        return Err(format!("host resource integrity check failed for {role:?}"));
                    }
                    // 内置字体命中编码缓存时零复制借用；avatar 保持按内容
                    // 编码的现行语义。
                    let data_base64 = match bundled_encoded_payload(role, &hash) {
                        Some(encoded) => std::borrow::Cow::Borrowed(encoded),
                        None => std::borrow::Cow::Owned(BASE64.encode(&resource.bytes)),
                    };
                    let response = HostMessageRef::ResourceBytes(ResourceBytesRef {
                        request_id,
                        generation,
                        role,
                        hash: &hash,
                        size_bytes: resource.bytes.len(),
                        mime: &resource.mime,
                        data_base64: &data_base64,
                    });
                    write_message(&mut self.input, &response).map_err(|error| {
                        self.broken = true;
                        format!("cannot send frozen resource bytes: {error}")
                    })?;
                }
                WorkerMessage::Rendered {
                    request_id,
                    generation,
                    render_key,
                    pdf_sha256,
                    pdf_base64,
                    page_count,
                } => {
                    if request_id != manifest.request_id
                        || generation != self.generation
                        || render_key != manifest.render_key
                        || !valid_output_page_count(manifest.format, page_count)
                    {
                        self.broken = true;
                        return Err("render result failed request, generation, renderKey, or page-count validation".into());
                    }
                    let bytes = BASE64.decode(pdf_base64).map_err(|_| {
                        self.broken = true;
                        "worker returned invalid PDF base64".to_owned()
                    })?;
                    if bytes.len() > MAX_PDF_BYTES || sha256(&bytes) != pdf_sha256 {
                        self.broken = true;
                        return Err("worker PDF failed size or SHA-256 validation".into());
                    }
                    return Ok(RenderedPdf { bytes, page_count });
                }
                WorkerMessage::Failed {
                    request_id,
                    generation,
                    code,
                    message,
                } => {
                    if request_id != manifest.request_id || generation != self.generation {
                        self.broken = true;
                        return Err("worker failure belongs to a stale request".into());
                    }
                    if code == "workerProtocol"
                        || code == "invalidManifest"
                        || code == "resourceHashMismatch"
                    {
                        self.broken = true;
                    }
                    return Err(format!("render worker {code}: {message}"));
                }
                WorkerMessage::Hello { .. } => {
                    self.broken = true;
                    return Err("render worker repeated its startup handshake".into());
                }
            }
        }
    }
}

impl Drop for WorkerProcess {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
        #[cfg(windows)]
        let _ = &self.job;
    }
}

#[derive(Default)]
struct WorkerSupervisor {
    worker: Option<WorkerProcess>,
    next_generation: u64,
    next_request_id: u64,
    scheduler: RenderScheduler,
}

impl WorkerSupervisor {
    fn ensure_worker(&mut self) -> Result<u64, String> {
        if let Some(worker) = self.worker.as_mut() {
            if !worker.broken
                && worker
                    .child
                    .try_wait()
                    .map_err(|error| error.to_string())?
                    .is_none()
            {
                return Ok(worker.generation);
            }
        }
        self.worker.take();
        self.next_generation = self.next_generation.saturating_add(1).max(1);
        let worker = WorkerProcess::start(self.next_generation)?;
        self.scheduler.set_generation(self.next_generation);
        self.worker = Some(worker);
        Ok(self.next_generation)
    }

    // 渲染分发同时绑定身份、文档、头像、格式、通道、产物、页选与分辨率，
    // 全部必要参数；为压 clippy 计数打包成结构体只会多一层搬运。
    #[allow(clippy::too_many_arguments)]
    fn render_output(
        &mut self,
        cursor: AuthorityCursor,
        document: ResumeDocument,
        avatar: AvatarAsset,
        format: RenderFormat,
        lane: RenderLane,
        product: Option<ExportProduct>,
        selected_pages: Option<Vec<u32>>,
        dpi: Option<u16>,
    ) -> Result<(String, RenderedPdf), String> {
        if dpi.is_some_and(|dpi| !(72..=300).contains(&dpi)) {
            return Err("Export DPI must be between 72 and 300".into());
        }
        let resources = host_resources(&document.presentation.font_set_id, avatar)?;
        let generation = self.ensure_worker()?;
        self.next_request_id = self.next_request_id.saturating_add(1).max(1);
        let manifest = build_manifest(
            cursor,
            document,
            &resources,
            generation,
            self.next_request_id,
            format,
            product,
            selected_pages,
            dpi,
        )?;
        let key = manifest.render_key.clone();
        let ticket = match self.scheduler.submit(lane, manifest.render_key.clone()) {
            SubmitResult::Started(ticket) => ticket,
            other => {
                return Err(format!(
                    "render scheduler did not start frozen export: {other:?}"
                ))
            }
        };
        let (result, retryable_crash) = self.execute_export(&ticket, &manifest, &resources)?;
        if result.is_err() && retryable_crash {
            self.next_request_id = self.next_request_id.saturating_add(1).max(1);
            let generation = self.ensure_worker()?;
            let mut retry_manifest = manifest;
            retry_manifest.generation = generation;
            retry_manifest.request_id = self.next_request_id;
            let retry_ticket = match self
                .scheduler
                .submit(lane, retry_manifest.render_key.clone())
            {
                SubmitResult::Started(ticket) => ticket,
                other => {
                    return Err(format!(
                        "render scheduler did not start frozen crash retry: {other:?}"
                    ))
                }
            };
            let (retry_result, _) =
                self.execute_export(&retry_ticket, &retry_manifest, &resources)?;
            return retry_result.map(|rendered| (key, rendered));
        }
        result.map(|rendered| (key, rendered))
    }

    fn execute_export(
        &mut self,
        ticket: &crate::render_scheduler::RenderTicket,
        manifest: &RenderManifest,
        resources: &[ResourceMaterial],
    ) -> Result<(Result<RenderedPdf, String>, bool), String> {
        let worker = self
            .worker
            .as_mut()
            .ok_or("render worker was not initialized")?;
        let result = worker.render(manifest, resources);
        let retryable_crash = worker.retryable_crash;
        let broken = worker.broken;
        let _ = self.scheduler.complete(ticket.id, ticket.generation);
        if broken {
            self.worker.take();
        }
        Ok((result, retryable_crash))
    }
}

/// Cloneable Tauri state. The mutex serializes use of the one persistent worker.
#[derive(Clone, Default)]
pub struct WorkerManager(Arc<Mutex<WorkerSupervisor>>);

impl WorkerManager {
    /// 按需导出产物：`product = Pdf` 可附 1-based 页码选择；`None` 等价于
    /// `ExportProduct::Bundle`（现行完整产物，向后兼容）。
    #[allow(clippy::too_many_arguments)]
    pub fn render_export_selection(
        &self,
        cursor: AuthorityCursor,
        document: ResumeDocument,
        avatar: AvatarAsset,
        product: Option<ExportProduct>,
        selected_pages: Option<Vec<u32>>,
        dpi: Option<u16>,
    ) -> Result<crate::domain::ExportResult, String> {
        let (render_key, rendered) = self
            .0
            .lock()
            .map_err(|_| "render supervisor lock failed".to_owned())?
            .render_output(
                cursor.clone(),
                document,
                avatar,
                RenderFormat::Export,
                RenderLane::Export,
                product,
                selected_pages.clone(),
                dpi,
            )?;
        let data: crate::domain::ExportData = serde_json::from_slice(&rendered.bytes)
            .map_err(|error| format!("worker export payload is invalid: {error}"))?;
        let requested_product = product.unwrap_or(ExportProduct::Bundle);
        validate_export_envelope(
            &data,
            rendered.page_count,
            requested_product,
            &selected_pages,
            dpi.unwrap_or(engine::export::DEFAULT_DPI),
        )?;
        Ok(crate::domain::ExportResult {
            cursor,
            render_key,
            data,
        })
    }

    pub fn fit_document(
        &self,
        cursor: AuthorityCursor,
        document: ResumeDocument,
        avatar: AvatarAsset,
    ) -> Result<crate::domain::FitResult, String> {
        let (render_key, rendered) = self
            .0
            .lock()
            .map_err(|_| "render supervisor lock failed".to_owned())?
            .render_output(
                cursor.clone(),
                document.clone(),
                avatar,
                RenderFormat::Fit,
                RenderLane::Fit,
                None,
                None,
                None,
            )?;
        let plan: crate::domain::FitPlan = serde_json::from_slice(&rendered.bytes)
            .map_err(|error| format!("worker fit payload is invalid: {error}"))?;
        engine::fit::validate_plan(&document, &plan).map_err(|error| error.to_string())?;
        if plan
            .attempts
            .last()
            .map_or(0, |attempt| attempt.page_count as usize)
            != rendered.page_count
        {
            return Err("worker fit page-count envelope does not match its plan".into());
        }
        Ok(crate::domain::FitResult {
            cursor,
            render_key,
            plan,
        })
    }

    pub fn render_pdf(
        &self,
        cursor: AuthorityCursor,
        document: ResumeDocument,
        avatar: AvatarAsset,
    ) -> Result<Vec<u8>, String> {
        self.0
            .lock()
            .map_err(|_| "render supervisor lock failed".to_owned())?
            .render_output(
                cursor,
                document,
                avatar,
                RenderFormat::Pdf,
                RenderLane::Export,
                None,
                None,
                None,
            )
            .map(|(_, rendered)| rendered.bytes)
    }

    pub fn render_preview(
        &self,
        cursor: AuthorityCursor,
        document: ResumeDocument,
        avatar: AvatarAsset,
    ) -> Result<crate::domain::PreviewResult, String> {
        let (render_key, rendered) = self
            .0
            .lock()
            .map_err(|_| "render supervisor lock failed".to_owned())?
            .render_output(
                cursor.clone(),
                document,
                avatar,
                RenderFormat::Preview,
                RenderLane::Preview,
                None,
                None,
                None,
            )?;
        let data: crate::domain::PreviewData = serde_json::from_slice(&rendered.bytes)
            .map_err(|error| format!("worker preview payload is invalid: {error}"))?;
        if data.pages.len() != rendered.page_count
            || data.pages.iter().any(|page| {
                sha256(page.svg.as_bytes()) != page.page_hash
                    || !page.width_pt.is_finite()
                    || !page.height_pt.is_finite()
                    || page.width_pt <= 0.0
                    || page.height_pt <= 0.0
            })
        {
            return Err("worker preview page hash or dimensions are invalid".into());
        }
        Ok(crate::domain::PreviewResult {
            cursor,
            render_key,
            data,
        })
    }
}

#[cfg(windows)]
struct WindowsJob(windows_sys::Win32::Foundation::HANDLE);

// The handle is owned by the serialized render supervisor and is only closed
// after the child process has been reaped.
#[cfg(windows)]
unsafe impl Send for WindowsJob {}

#[cfg(windows)]
impl WindowsJob {
    fn assign(child: &Child) -> Result<Self, String> {
        use std::mem::size_of;
        use std::os::windows::io::AsRawHandle;
        use std::ptr::null;
        use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
        use windows_sys::Win32::System::JobObjects::{
            AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
            SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
            JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, JOB_OBJECT_LIMIT_PROCESS_MEMORY,
        };

        unsafe {
            let handle = CreateJobObjectW(null(), null());
            if handle.is_null() {
                return Err("cannot create Windows render job object".into());
            }
            let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
            limits.BasicLimitInformation.LimitFlags =
                JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | JOB_OBJECT_LIMIT_PROCESS_MEMORY;
            limits.ProcessMemoryLimit = WORKER_MEMORY_LIMIT_BYTES;
            if SetInformationJobObject(
                handle,
                JobObjectExtendedLimitInformation,
                &limits as *const _ as *const _,
                size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            ) == 0
            {
                CloseHandle(handle);
                return Err("cannot set render worker memory and lifetime limits".into());
            }
            if AssignProcessToJobObject(handle, child.as_raw_handle() as HANDLE) == 0 {
                CloseHandle(handle);
                return Err("cannot assign render worker to its Windows job object".into());
            }
            Ok(Self(handle))
        }
    }
}

#[cfg(windows)]
impl Drop for WindowsJob {
    fn drop(&mut self) {
        unsafe { windows_sys::Win32::Foundation::CloseHandle(self.0) };
    }
}

#[cfg(test)]
#[path = "render_worker/tests.rs"]
mod tests;

// test-hooks 注入钩子的进程内验证。宿主侧的 90 秒超时、1.5GiB Job Object
// 终止与同冻结输入重放需要真实父子进程，安全扫描不允许在产品代码里放
// 可执行文件覆盖入口，这些仍在 WebView2/集成层验收（见 execution-status）。
#[cfg(all(test, feature = "test-hooks"))]
#[path = "render_worker/hooks_tests.rs"]
mod hooks_tests;

#[path = "render_worker/protocol.rs"]
mod protocol;
use protocol::*;
#[path = "render_worker/render.rs"]
mod render;
pub use render::run_worker_mode;
use render::validate_export_envelope;

#[cfg(all(test, feature = "test-hooks"))]
use render::test_hooks_before_render;

#[cfg(test)]
use render::worker_loop;
