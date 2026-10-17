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

fn render_timeout(format: RenderFormat) -> Duration {
    #[cfg(feature = "test-hooks")]
    {
        let disabled = std::env::var_os("ZINECV_TEST_WORKER_RESET_FILE")
            .is_some_and(|path| std::path::Path::new(&path).exists());
        let milliseconds = if disabled {
            None
        } else {
            std::env::var("ZINECV_TEST_RENDER_TIMEOUT_MS").ok()
        };
        configured_render_timeout(format, milliseconds.as_deref())
    }
    #[cfg(not(feature = "test-hooks"))]
    configured_render_timeout(format, None)
}

fn configured_render_timeout(format: RenderFormat, _test_milliseconds: Option<&str>) -> Duration {
    // Only the fault-injection executable accepts one bounded test deadline.
    // Production neither reads the environment nor compiles this override.
    #[cfg(feature = "test-hooks")]
    if format == RenderFormat::Pdf && _test_milliseconds == Some("3000") {
        return Duration::from_millis(3000);
    }
    match format {
        RenderFormat::Fit => Duration::from_secs(10),
        RenderFormat::Pdf | RenderFormat::Preview | RenderFormat::Export => RENDER_TIMEOUT,
    }
}

fn valid_output_page_count(format: RenderFormat, page_count: usize) -> bool {
    page_count <= MAX_PAGE_COUNT && (page_count > 0 || format == RenderFormat::Fit)
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

fn sha256(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn render_key(
    cursor: &AuthorityCursor,
    document: &ResumeDocument,
    reference_date: &str,
    format: RenderFormat,
    resources: &[ResourceDescriptor],
) -> Result<String, String> {
    let input = RenderKeyInput {
        protocol_version: PROTOCOL_VERSION,
        engine_version: ENGINE_VERSION,
        resource_version: RESOURCE_VERSION,
        template_sha256: sha256(engine::template_source_bytes()),
        cursor,
        document,
        reference_date,
        format,
        resources,
    };
    let bytes = serde_json::to_vec(&input).map_err(|error| error.to_string())?;
    Ok(sha256(&bytes))
}

fn manifest_render_key(manifest: &RenderManifest) -> Result<String, String> {
    let base = render_key(
        &manifest.cursor,
        &manifest.document,
        &manifest.reference_date,
        manifest.format,
        &manifest.resources,
    )?;
    if manifest.format != RenderFormat::Export {
        return Ok(base);
    }
    let product = manifest.product.unwrap_or(ExportProduct::Bundle);
    let selection = match (product, manifest.selected_pages.as_ref()) {
        (ExportProduct::Pdf, Some(pages)) if !pages.is_empty() => {
            let mut pages = pages.clone();
            pages.sort_unstable();
            pages.dedup();
            Some(pages)
        }
        _ => None,
    };
    let bytes = serde_json::to_vec(&(
        base,
        product,
        selection,
        manifest.dpi.unwrap_or(engine::export::DEFAULT_DPI),
    ))
    .map_err(|error| error.to_string())?;
    Ok(sha256(&bytes))
}

fn validate_reference_date(value: &str) -> Result<(i32, u8, u8), String> {
    let bytes = value.as_bytes();
    if bytes.len() != 10
        || bytes[4] != b'-'
        || bytes[7] != b'-'
        || !bytes[..4].iter().all(u8::is_ascii_digit)
        || !bytes[5..7].iter().all(u8::is_ascii_digit)
        || !bytes[8..10].iter().all(u8::is_ascii_digit)
    {
        return Err("referenceDate must use YYYY-MM-DD".into());
    }
    let year = value[0..4]
        .parse::<i32>()
        .map_err(|_| "referenceDate year is invalid")?;
    let month = value[5..7]
        .parse::<u8>()
        .map_err(|_| "referenceDate month is invalid")?;
    let day = value[8..10]
        .parse::<u8>()
        .map_err(|_| "referenceDate day is invalid")?;
    if typst::foundations::Datetime::from_ymd(year, month, day).is_none() {
        return Err("referenceDate is not a calendar date".into());
    }
    Ok((year, month, day))
}

fn material(role: ResourceRole, mime: &str, bytes: Bytes) -> ResourceMaterial {
    let hash = sha256(&bytes);
    ResourceMaterial {
        role,
        hash,
        mime: mime.to_owned(),
        bytes,
    }
}

/// 内置字体是编译期常量：宿主侧只保留一份材料（含 SHA-256 身份哈希）与
/// 预编码的 base64 载荷。每次渲染只克隆 `Bytes` 的引用计数与浅拷贝条目；
/// 资源响应直接复用按 hash 缓存的编码，不再每次请求重算 ~22MB 的 SHA-256
/// 与重新编码 ~29MB 的 base64。
struct BundledFontMaterial {
    material: ResourceMaterial,
    encoded_base64: String,
}

fn bundled_font_materials() -> &'static [BundledFontMaterial; 3] {
    static FONTS: OnceLock<[BundledFontMaterial; 3]> = OnceLock::new();
    FONTS.get_or_init(|| {
        let fonts = engine::bundled_font_bytes();
        [
            material(ResourceRole::BodyFontRegular, "font/otf", fonts.regular),
            material(ResourceRole::BodyFontHeavy, "font/ttf", fonts.heavy),
            material(ResourceRole::IconFont, "font/ttf", fonts.icon),
        ]
        .map(|font| BundledFontMaterial {
            encoded_base64: BASE64.encode(font.bytes.as_slice()),
            material: font,
        })
    })
}

/// 内置字体的编码载荷缓存命中：role 与 hash 都匹配才复用（零复制借用）。
fn bundled_encoded_payload(role: ResourceRole, hash: &str) -> Option<&'static str> {
    bundled_font_materials()
        .iter()
        .find(|font| font.material.role == role && font.material.hash == hash)
        .map(|font| font.encoded_base64.as_str())
}

fn host_resources(font_set_id: &str, avatar: AvatarAsset) -> Result<Vec<ResourceMaterial>, String> {
    let mut resources: Vec<ResourceMaterial> = bundled_font_materials()
        .iter()
        .map(|font| font.material.clone())
        .collect();
    static HEADINGS: OnceLock<Vec<ResourceMaterial>> = OnceLock::new();
    let headings = HEADINGS.get_or_init(|| match engine::system_fonts::installed() {
        Some(fonts) => vec![
            material(ResourceRole::HeadingFontRegular, "font/ttf", fonts.regular),
            material(ResourceRole::HeadingFontBold, "font/ttf", fonts.bold),
        ],
        None => Vec::new(),
    });
    resources.extend(headings.iter().cloned());
    // One selected pair only; switching fonts replaces the previous cache entry.
    type SelectedFonts = Option<(String, Vec<ResourceMaterial>)>;
    static SELECTED: OnceLock<Mutex<SelectedFonts>> = OnceLock::new();
    let mut selected = SELECTED
        .get_or_init(|| Mutex::new(None))
        .lock()
        .map_err(|_| "Selected font cache poisoned")?;
    if selected.as_ref().is_none_or(|(id, _)| id != font_set_id) {
        let fonts = match engine::body_fonts::installed(font_set_id)? {
            Some(fonts) => vec![
                material(ResourceRole::SelectedBodyRegular, "font/ttf", fonts.regular),
                material(ResourceRole::SelectedBodyBold, "font/ttf", fonts.bold),
            ],
            None => Vec::new(),
        };
        *selected = Some((font_set_id.to_owned(), fonts));
    }
    resources.extend(
        selected
            .as_ref()
            .expect("initialized selected font cache")
            .1
            .iter()
            .cloned(),
    );
    if let Some((mime, bytes)) = avatar {
        resources.push(material(ResourceRole::Avatar, &mime, Bytes::new(bytes)));
    }
    Ok(resources)
}

fn build_manifest(
    cursor: AuthorityCursor,
    document: ResumeDocument,
    resources: &[ResourceMaterial],
    generation: u64,
    request_id: u64,
) -> Result<RenderManifest, String> {
    if cursor.document_id != document.document_id {
        return Err("Frozen cursor and document IDs do not match".into());
    }
    let avatar = document.basic.avatar_asset_id.as_deref();
    let supplied_avatar = resources
        .iter()
        .find(|resource| resource.role == ResourceRole::Avatar);
    match (avatar, supplied_avatar) {
        (Some(asset_id), Some(resource)) if asset_id == resource.hash => {}
        (Some(_), Some(_)) => return Err("Frozen avatar hash does not match its asset ID".into()),
        (Some(_), None) => return Err("Frozen avatar bytes are missing".into()),
        (None, Some(_)) => return Err("Unexpected avatar bytes were supplied".into()),
        (None, None) => {}
    }
    let mut descriptors: Vec<_> = resources
        .iter()
        .map(|resource| ResourceDescriptor {
            role: resource.role,
            hash: resource.hash.clone(),
            size_bytes: resource.bytes.len(),
            mime: resource.mime.clone(),
        })
        .collect();
    descriptors.sort_by_key(|descriptor| descriptor.role);
    validate_descriptors(&descriptors, avatar.is_some())?;
    let key = render_key(
        &cursor,
        &document,
        REFERENCE_DATE,
        RenderFormat::Pdf,
        &descriptors,
    )?;
    let manifest = RenderManifest {
        protocol_version: PROTOCOL_VERSION,
        engine_version: ENGINE_VERSION.to_owned(),
        resource_version: RESOURCE_VERSION,
        generation,
        request_id,
        render_key: key,
        template_sha256: sha256(engine::template_source_bytes()),
        cursor,
        document,
        reference_date: REFERENCE_DATE.to_owned(),
        format: RenderFormat::Pdf,
        resources: descriptors,
        product: None,
        selected_pages: None,
        dpi: None,
    };
    let encoded = serde_json::to_vec(&manifest).map_err(|error| error.to_string())?;
    if encoded.len() > MAX_DOCUMENT_BYTES {
        return Err("Frozen render manifest exceeds the 8 MiB limit".into());
    }
    Ok(manifest)
}

fn validate_descriptors(
    descriptors: &[ResourceDescriptor],
    has_avatar: bool,
) -> Result<(), String> {
    let mut roles = HashSet::new();
    for descriptor in descriptors {
        if !roles.insert(descriptor.role) {
            return Err("Resource manifest contains a duplicate role".into());
        }
        if descriptor.size_bytes == 0 || descriptor.size_bytes > MAX_RESOURCE_BYTES {
            return Err(format!(
                "Resource {:?} has an invalid size",
                descriptor.role
            ));
        }
        if descriptor.hash.len() != 64
            || !descriptor.hash.bytes().all(|byte| byte.is_ascii_hexdigit())
        {
            return Err(format!(
                "Resource {:?} has an invalid SHA-256",
                descriptor.role
            ));
        }
        if descriptor.mime.len() > 128
            || descriptor.mime.bytes().any(|byte| byte.is_ascii_control())
        {
            return Err(format!(
                "Resource {:?} has an invalid MIME type",
                descriptor.role
            ));
        }
    }
    for role in [
        ResourceRole::BodyFontRegular,
        ResourceRole::BodyFontHeavy,
        ResourceRole::IconFont,
    ] {
        if !roles.contains(&role) {
            return Err(format!("Required resource {role:?} is missing"));
        }
    }
    if roles.contains(&ResourceRole::Avatar) != has_avatar {
        return Err("Avatar manifest does not match the frozen document".into());
    }
    let has_heading = roles.contains(&ResourceRole::HeadingFontRegular);
    if roles.contains(&ResourceRole::HeadingFontBold) != has_heading {
        return Err("System heading font styles must be supplied together".into());
    }
    let has_selected = roles.contains(&ResourceRole::SelectedBodyRegular);
    if roles.contains(&ResourceRole::SelectedBodyBold) != has_selected {
        return Err("Selected body font styles must be supplied together".into());
    }
    if roles.len()
        != (if has_avatar { 4 } else { 3 })
            + (if has_heading { 2 } else { 0 })
            + (if has_selected { 2 } else { 0 })
    {
        return Err("Resource manifest contains an unsupported resource role".into());
    }
    Ok(())
}

fn write_message(writer: &mut impl Write, message: &impl Serialize) -> io::Result<()> {
    let mut bytes = serde_json::to_vec(message)
        .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))?;
    bytes.push(b'\n');
    if bytes.len() > MAX_PROTOCOL_LINE_BYTES {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "protocol line exceeds limit",
        ));
    }
    writer.write_all(&bytes)?;
    writer.flush()
}

fn read_message<T: for<'de> Deserialize<'de>>(reader: &mut impl BufRead) -> io::Result<T> {
    let mut bytes = Vec::new();
    let read = reader
        .take((MAX_PROTOCOL_LINE_BYTES + 1) as u64)
        .read_until(b'\n', &mut bytes)?;
    if read == 0 {
        return Err(io::Error::new(
            io::ErrorKind::UnexpectedEof,
            "worker protocol stream closed",
        ));
    }
    if bytes.len() > MAX_PROTOCOL_LINE_BYTES || bytes.last() != Some(&b'\n') {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "protocol line exceeds limit or is unterminated",
        ));
    }
    serde_json::from_slice(&bytes[..bytes.len() - 1])
        .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))
}

fn failed(
    request_id: u64,
    generation: u64,
    code: &str,
    message: impl Into<String>,
) -> WorkerMessage {
    let mut message = message.into();
    message.truncate(MAX_ERROR_CHARS);
    WorkerMessage::Failed {
        request_id,
        generation,
        code: code.to_owned(),
        message,
    }
}

/// 资源校验失败时向宿主回发结构化 resourceHashMismatch 并结束本轮请求。
fn reject_resource(
    writer: &mut impl Write,
    request_id: u64,
    generation: u64,
    message: &str,
) -> Result<(), String> {
    write_message(
        writer,
        &failed(request_id, generation, "resourceHashMismatch", message),
    )
    .map_err(|error| error.to_string())
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

/// Seven fixed font roles may be cached; avatars are never cached.
fn fixed_font_role(role: ResourceRole) -> Option<ResourceRole> {
    match role {
        ResourceRole::BodyFontRegular
        | ResourceRole::BodyFontHeavy
        | ResourceRole::IconFont
        | ResourceRole::HeadingFontRegular
        | ResourceRole::HeadingFontBold
        | ResourceRole::SelectedBodyRegular
        | ResourceRole::SelectedBodyBold => Some(role),
        ResourceRole::Avatar => None,
    }
}

/// 已验证清单里某字体角色的身份哈希（validate_descriptors 保证三个字体
/// 角色必在，缺省值仅是类型层的兜底）。
fn font_descriptor_hash(descriptors: &[ResourceDescriptor], role: ResourceRole) -> String {
    descriptors
        .iter()
        .find(|descriptor| descriptor.role == role)
        .map(|descriptor| descriptor.hash.clone())
        .unwrap_or_default()
}

/// 按原协议请求一个资源并完成请求/身份级校验（request_id、generation、
/// role/hash/size/mime 一致 + base64 合法）；SHA-256 与尺寸的最终判定仍由
/// 调用方完成，以保持 resourceHashMismatch 的响应语义。
fn receive_resource<R: BufRead, W: Write>(
    reader: &mut R,
    writer: &mut W,
    request_id: u64,
    generation: u64,
    descriptor: &ResourceDescriptor,
) -> Result<Vec<u8>, String> {
    write_message(
        writer,
        &WorkerMessage::ResourceRequest {
            request_id,
            generation,
            role: descriptor.role,
            hash: descriptor.hash.clone(),
        },
    )
    .map_err(|error| error.to_string())?;
    let response: HostMessage = read_message(reader).map_err(|error| error.to_string())?;
    let HostMessage::ResourceBytes {
        request_id: response_id,
        generation: response_generation,
        role,
        hash,
        size_bytes,
        mime,
        data_base64,
    } = response
    else {
        return Err("worker expected a read-only resource response".into());
    };
    if response_id != request_id || response_generation != generation || role != descriptor.role {
        return Err("resource response belongs to a different request or generation".into());
    }
    if hash != descriptor.hash || size_bytes != descriptor.size_bytes || mime != descriptor.mime {
        return Err("resource response does not match the manifest".into());
    }
    BASE64
        .decode(data_base64.as_bytes())
        .map_err(|_| "resource bytes are not valid base64".to_string())
}

fn worker_render<R: BufRead, W: Write>(
    manifest: RenderManifest,
    worker_generation: u64,
    reader: &mut R,
    writer: &mut W,
    font_cache: &mut FontResourceCache,
) -> Result<(), String> {
    let request_id = manifest.request_id;
    let generation = manifest.generation;
    let validation = (|| {
        if generation != worker_generation {
            return Err("stale worker generation".to_owned());
        }
        if manifest.protocol_version != PROTOCOL_VERSION
            || manifest.resource_version != RESOURCE_VERSION
            || manifest.engine_version != ENGINE_VERSION
        {
            return Err("worker protocol, engine, or resource version mismatch".to_owned());
        }
        if manifest.template_sha256 != sha256(engine::template_source_bytes()) {
            return Err("template resource hash does not match this engine".to_owned());
        }
        if manifest.cursor.document_id != manifest.document.document_id {
            return Err("frozen cursor does not identify this document".to_owned());
        }
        validate_reference_date(&manifest.reference_date)?;
        if manifest.dpi.is_some_and(|dpi| !(72..=300).contains(&dpi))
            || (manifest.format != RenderFormat::Export && manifest.dpi.is_some())
        {
            return Err("Export DPI must be between 72 and 300".to_owned());
        }
        validate_descriptors(
            &manifest.resources,
            manifest.document.basic.avatar_asset_id.is_some(),
        )?;
        if manifest
            .resources
            .iter()
            .any(|resource| resource.role == ResourceRole::SelectedBodyRegular)
            != engine::body_fonts::is_installed_selection(
                &manifest.document.presentation.font_set_id,
            )
        {
            return Err("Selected font resources do not match the frozen document".into());
        }
        if manifest_render_key(&manifest)? != manifest.render_key {
            return Err("renderKey does not match the frozen manifest".to_owned());
        }
        Ok(())
    })();
    if let Err(message) = validation {
        write_message(
            writer,
            &failed(request_id, generation, "invalidManifest", message),
        )
        .map_err(|error| error.to_string())?;
        return Ok(());
    }

    let mut received = HashSet::<ResourceRole>::new();
    let mut fonts = HashMap::<ResourceRole, Bytes>::new();
    let mut avatar_bytes: Option<Vec<u8>> = None;
    for descriptor in &manifest.resources {
        if !received.insert(descriptor.role) {
            return Err("duplicate resource response".into());
        }
        if let Some(role) = fixed_font_role(descriptor.role) {
            // 字体：按完整 (hash, size, mime, resourceVersion) 命中已验证缓存
            // 时不再发起 ResourceRequest；未命中按原协议请求并完整校验。
            if let Some(bytes) = font_cache.lookup(
                descriptor.role,
                &descriptor.hash,
                descriptor.size_bytes,
                &descriptor.mime,
                manifest.resource_version,
            ) {
                fonts.insert(role, bytes.clone());
                continue;
            }
            let bytes = receive_resource(reader, writer, request_id, generation, descriptor)?;
            if bytes.len() != descriptor.size_bytes
                || bytes.len() > MAX_RESOURCE_BYTES
                || sha256(&bytes) != descriptor.hash
            {
                reject_resource(
                    writer,
                    request_id,
                    generation,
                    "resource bytes failed size or SHA-256 validation",
                )?;
                return Ok(());
            }
            let verified = Bytes::new(bytes);
            font_cache.store(
                descriptor.role,
                &descriptor.hash,
                descriptor.size_bytes,
                &descriptor.mime,
                manifest.resource_version,
                verified.clone(),
            );
            fonts.insert(role, verified);
        } else {
            // avatar：保持按内容哈希核对当前冻结文档的现行语义，不进缓存。
            let bytes = receive_resource(reader, writer, request_id, generation, descriptor)?;
            if bytes.len() != descriptor.size_bytes
                || bytes.len() > MAX_RESOURCE_BYTES
                || sha256(&bytes) != descriptor.hash
            {
                reject_resource(
                    writer,
                    request_id,
                    generation,
                    "resource bytes failed size or SHA-256 validation",
                )?;
                return Ok(());
            }
            avatar_bytes = Some(bytes);
        }
    }

    // 字体字节由 `Bytes` 接管已解码的 `Vec<u8>`（不复制），后续 Typst 字体解析
    // 与求解过程共享同一份缓冲；身份由已验证的资源哈希携带，DocumentWorld
    // 按身份复用解析缓存（字节变更即失效）。
    let font_identity = engine::FontIdentity {
        regular: font_descriptor_hash(&manifest.resources, ResourceRole::BodyFontRegular),
        heavy: font_descriptor_hash(&manifest.resources, ResourceRole::BodyFontHeavy),
        icon: font_descriptor_hash(&manifest.resources, ResourceRole::IconFont),
        selected_regular: manifest
            .resources
            .iter()
            .find(|resource| resource.role == ResourceRole::SelectedBodyRegular)
            .map(|resource| resource.hash.clone()),
        selected_bold: manifest
            .resources
            .iter()
            .find(|resource| resource.role == ResourceRole::SelectedBodyBold)
            .map(|resource| resource.hash.clone()),
        heading_regular: manifest
            .resources
            .iter()
            .find(|resource| resource.role == ResourceRole::HeadingFontRegular)
            .map(|resource| resource.hash.clone()),
        heading_bold: manifest
            .resources
            .iter()
            .find(|resource| resource.role == ResourceRole::HeadingFontBold)
            .map(|resource| resource.hash.clone()),
    };
    let font_bytes = RenderFontBytes {
        regular: fonts
            .remove(&ResourceRole::BodyFontRegular)
            .ok_or("regular font missing")?,
        heavy: fonts
            .remove(&ResourceRole::BodyFontHeavy)
            .ok_or("heavy font missing")?,
        icon: fonts
            .remove(&ResourceRole::IconFont)
            .ok_or("icon font missing")?,
        identity: Some(font_identity),
        selected_body: match (
            fonts.remove(&ResourceRole::SelectedBodyRegular),
            fonts.remove(&ResourceRole::SelectedBodyBold),
        ) {
            (Some(regular), Some(bold)) => Some(engine::body_fonts::validate(
                &manifest.document.presentation.font_set_id,
                regular,
                bold,
            )?),
            (None, None) => None,
            _ => return Err("Selected body fonts are incomplete".into()),
        },
        heading: match (
            fonts.remove(&ResourceRole::HeadingFontRegular),
            fonts.remove(&ResourceRole::HeadingFontBold),
        ) {
            (Some(regular), Some(bold)) => Some(engine::system_fonts::validate(regular, bold)?),
            (None, None) => None,
            _ => return Err("System heading font styles are incomplete".into()),
        },
    };
    let avatar_mime = manifest
        .resources
        .iter()
        .find(|descriptor| descriptor.role == ResourceRole::Avatar)
        .map(|descriptor| descriptor.mime.clone());
    let avatar = avatar_bytes
        .zip(avatar_mime)
        .map(|(bytes, mime)| (mime, bytes));
    let avatar = match (manifest.document.basic.avatar_asset_id.as_ref(), avatar) {
        (Some(asset_id), Some((mime, bytes))) => {
            if sha256(&bytes) != *asset_id {
                reject_resource(
                    writer,
                    request_id,
                    generation,
                    "avatar bytes do not match the document asset ID",
                )?;
                return Ok(());
            }
            Some((mime, bytes))
        }
        (None, None) => None,
        _ => return Err("avatar bytes do not match the frozen document".into()),
    };
    let reference_date = validate_reference_date(&manifest.reference_date)?;
    let result = match manifest.format {
        RenderFormat::Pdf => engine::render_document_pdf_with_resources(
            &manifest.document,
            avatar,
            &font_bytes,
            reference_date,
        ),
        RenderFormat::Preview => engine::render_preview_with_resources(
            &manifest.document,
            avatar,
            &font_bytes,
            reference_date,
        )
        .and_then(|data| {
            let page_count = data.pages.len();
            serde_json::to_vec(&data)
                .map(|bytes| RenderedPdf { bytes, page_count })
                .map_err(|error| engine::EngineError::Compile(error.to_string()))
        }),
        RenderFormat::Export => engine::export::render_frozen_export(
            &manifest.document,
            avatar,
            &font_bytes,
            reference_date,
            manifest.selected_pages.as_deref(),
            manifest.dpi.unwrap_or(engine::export::DEFAULT_DPI),
            manifest.product,
        )
        .and_then(|output| {
            let page_count = output.page_count;
            serde_json::to_vec(&output.into_payload())
                .map(|bytes| RenderedPdf { bytes, page_count })
                .map_err(|error| engine::EngineError::Compile(error.to_string()))
        }),
        RenderFormat::Fit => engine::fit::solve_one_page(
            &manifest.document,
            avatar,
            &font_bytes,
            reference_date,
            || false,
        )
        .and_then(|plan| {
            let page_count = plan
                .attempts
                .last()
                .map_or(0, |attempt| attempt.page_count as usize);
            serde_json::to_vec(&plan)
                .map(|bytes| RenderedPdf { bytes, page_count })
                .map_err(|error| engine::EngineError::Compile(error.to_string()))
        }),
    };
    match result {
        Ok(RenderedPdf { bytes, page_count }) => {
            if bytes.len() > MAX_PDF_BYTES || !valid_output_page_count(manifest.format, page_count)
            {
                write_message(
                    writer,
                    &failed(
                        request_id,
                        generation,
                        "resourceLimit",
                        "rendered output exceeds configured output or page limit",
                    ),
                )
                .map_err(|error| error.to_string())?;
                return Ok(());
            }
            write_message(
                writer,
                &WorkerMessage::Rendered {
                    request_id,
                    generation,
                    render_key: manifest.render_key,
                    pdf_sha256: sha256(&bytes),
                    pdf_base64: BASE64.encode(bytes),
                    page_count,
                },
            )
            .map_err(|error| error.to_string())?;
        }
        Err(error) => {
            write_message(
                writer,
                &failed(request_id, generation, "engineFailure", error.to_string()),
            )
            .map_err(|error| error.to_string())?;
        }
    }
    Ok(())
}

/// 仅 test-hooks 构建存在：按环境变量在处理首个 render 前注入故障。
/// ZINECV_TEST_WORKER_DELAY_MS=毫秒（触发宿主硬超时路径；默认 90 秒）、
/// ZINECV_TEST_RENDER_TIMEOUT_MS=3000（仅 Pdf 接受该固定测试值，reset 后恢复默认）、
/// ZINECV_TEST_WORKER_ALLOC_MB=兆字节（写满页触发 Job Object 1.5GiB 上限）、
/// ZINECV_TEST_CRASH_MARKER=路径（首个 render 写入标记后 abort，验证同冻结输入重放）。
#[cfg(feature = "test-hooks")]
fn test_hooks_before_render() {
    // The integration test disables faults after observing the failure, then
    // verifies recovery in the same host without changing its environment.
    if std::env::var_os("ZINECV_TEST_WORKER_RESET_FILE")
        .is_some_and(|path| std::path::Path::new(&path).exists())
    {
        return;
    }
    if let Ok(milliseconds) = std::env::var("ZINECV_TEST_WORKER_DELAY_MS") {
        if let Ok(milliseconds) = milliseconds.parse::<u64>() {
            std::thread::sleep(Duration::from_millis(milliseconds));
        }
    }
    if let Ok(megabytes) = std::env::var("ZINECV_TEST_WORKER_ALLOC_MB") {
        if let Ok(megabytes) = megabytes.parse::<usize>() {
            let mut buffer: Vec<u8> = Vec::with_capacity(megabytes.saturating_mul(1024 * 1024));
            buffer.resize(buffer.capacity(), 0x41);
            // 必须让指针真正物化：`Vec::with_capacity` + `resize` + `mem::forget`
            // 的缓冲从不被读取，release 级优化（opt-level=3 + lto="fat" +
            // codegen-units=1）会把整段「分配+填充+泄漏」当作死代码消除，
            // 使本注入退化为空操作、1.5GiB Job Object 上限场景静默失效
            // （2026-10-03 实测：1700MB 与 4000MB 注入都杀不死 worker）。
            // black_box 让分配结果对优化器不透明，从而保持注入语义。
            std::hint::black_box(buffer.as_mut_ptr());
            std::mem::forget(buffer);
        }
    }
    if let Ok(marker) = std::env::var("ZINECV_TEST_CRASH_MARKER") {
        if !marker.is_empty() && !std::path::Path::new(&marker).exists() {
            let _ = std::fs::write(&marker, std::process::id().to_string());
            std::process::abort();
        }
    }
}

fn worker_loop<R: Read, W: Write>(input: R, output: W, generation: u64) -> Result<(), String> {
    if generation == 0 {
        return Err("worker generation must be positive".into());
    }
    let mut reader = BufReader::new(input);
    let mut writer = BufWriter::new(output);
    // 一次 worker generation 的资源状态：已验证字体缓存随本循环存活，
    // worker 重启（新进程、新 generation）后自然重新初始化。
    let mut font_cache = FontResourceCache::default();
    write_message(
        &mut writer,
        &WorkerMessage::Hello {
            protocol_version: PROTOCOL_VERSION,
            engine_version: ENGINE_VERSION.to_owned(),
            resource_version: RESOURCE_VERSION,
            generation,
        },
    )
    .map_err(|error| error.to_string())?;
    loop {
        let message: HostMessage = match read_message(&mut reader) {
            Ok(message) => message,
            Err(error) if error.kind() == io::ErrorKind::UnexpectedEof => return Ok(()),
            Err(error) => return Err(error.to_string()),
        };
        match message {
            HostMessage::Render { manifest } => {
                let request_id = manifest.request_id;
                #[cfg(feature = "test-hooks")]
                test_hooks_before_render();
                if let Err(error) = worker_render(
                    *manifest,
                    generation,
                    &mut reader,
                    &mut writer,
                    &mut font_cache,
                ) {
                    write_message(
                        &mut writer,
                        &failed(request_id, generation, "workerProtocol", error),
                    )
                    .map_err(|write_error| write_error.to_string())?;
                }
            }
            HostMessage::ResourceBytes {
                request_id,
                generation: message_generation,
                ..
            } => {
                write_message(
                    &mut writer,
                    &failed(
                        request_id,
                        message_generation,
                        "unexpectedResource",
                        "worker was not waiting for resource bytes",
                    ),
                )
                .map_err(|error| error.to_string())?;
            }
        }
    }
}

/// Entry point used only by the same application executable's hidden worker mode.
pub fn run_worker_mode(generation: u64) -> i32 {
    match worker_loop(io::stdin(), io::stdout(), generation) {
        Ok(()) => 0,
        Err(_) => 70,
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
        let mut manifest = build_manifest(
            cursor,
            document,
            &resources,
            generation,
            self.next_request_id,
        )?;
        manifest.format = format;
        manifest.product = product;
        manifest.selected_pages = selected_pages;
        manifest.dpi = dpi;
        manifest.render_key = manifest_render_key(&manifest)?;
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

fn validate_export_png(page: &crate::domain::ExportPng) -> Result<(), String> {
    let bytes = BASE64
        .decode(&page.data_base64)
        .map_err(|_| "worker export PNG base64 is invalid")?;
    if bytes.len() < 24
        || !bytes.starts_with(b"\x89PNG\r\n\x1a\n")
        || &bytes[12..16] != b"IHDR"
        || sha256(&bytes) != page.sha256
        || u32::from_be_bytes(bytes[16..20].try_into().unwrap()) != page.width
        || u32::from_be_bytes(bytes[20..24].try_into().unwrap()) != page.height
        || page.width == 0
        || page.height == 0
        || page.width > 32768
        || page.height > 32768
        || u64::from(page.width) * u64::from(page.height) > engine::export::MAX_SELECTED_PIXELS
    {
        return Err("worker export PNG integrity or dimensions are invalid".into());
    }
    Ok(())
}

/// 按请求的产物校验 worker 导出信封：Bundle 保持现行全量校验；Pdf 只允许
/// PDF（无 PNG/长图，像素预算不适用）；Png 不携带 PDF。页码选择回显必须
/// 与请求（排序去重后）一致。
fn validate_export_envelope(
    data: &crate::domain::ExportData,
    rendered_page_count: usize,
    requested_product: ExportProduct,
    requested_selection: &Option<Vec<u32>>,
    requested_dpi: u16,
) -> Result<(), String> {
    if data.page_count as usize != rendered_page_count || data.dpi != requested_dpi {
        return Err("worker export envelope does not match its payload".into());
    }
    let reported_product = data.product.unwrap_or(ExportProduct::Bundle);
    if reported_product != requested_product {
        return Err("worker export product does not match its request".into());
    }
    let expected_selection = match (requested_product, requested_selection.as_deref()) {
        (ExportProduct::Pdf, Some(pages)) if !pages.is_empty() => {
            let mut unique = pages.to_vec();
            unique.sort_unstable();
            unique.dedup();
            Some(unique)
        }
        _ => None,
    };
    if data.selected_pages != expected_selection {
        return Err("worker export page selection does not match its request".into());
    }
    match requested_product {
        ExportProduct::Pdf => {
            if !data.png_pages.is_empty() || data.long_png.is_some() || data.long_image_limited {
                return Err("worker export envelope does not match its payload".into());
            }
            validate_export_pdf(data)
        }
        ExportProduct::Png => {
            if !data.pdf_base64.is_empty()
                || data.png_pages.len() != rendered_page_count
                || data.long_image_limited != data.long_png.is_none()
            {
                return Err("worker export envelope does not match its payload".into());
            }
            validate_export_png_pages(data)
        }
        ExportProduct::Bundle => {
            if data.png_pages.len() != rendered_page_count
                || data.long_image_limited != data.long_png.is_none()
            {
                return Err("worker export envelope does not match its payload".into());
            }
            validate_export_pdf(data)?;
            validate_export_png_pages(data)
        }
    }
}

fn validate_export_pdf(data: &crate::domain::ExportData) -> Result<(), String> {
    let pdf = BASE64
        .decode(&data.pdf_base64)
        .map_err(|_| "worker export PDF base64 is invalid")?;
    if !pdf.starts_with(b"%PDF-") || sha256(&pdf) != data.pdf_sha256 {
        return Err("worker export PDF integrity check failed".into());
    }
    Ok(())
}

fn validate_export_png_pages(data: &crate::domain::ExportData) -> Result<(), String> {
    for (index, page) in data.png_pages.iter().enumerate() {
        if page.page as usize != index + 1 {
            return Err("worker export PNG order is invalid".into());
        }
        validate_export_png(page)?;
    }
    if let Some(long) = &data.long_png {
        validate_export_png(long)?;
        if long.page != 0
            || long.width
                != data
                    .png_pages
                    .iter()
                    .map(|page| page.width)
                    .max()
                    .unwrap_or(0)
            || u64::from(long.height)
                != data
                    .png_pages
                    .iter()
                    .map(|page| u64::from(page.height))
                    .sum::<u64>()
        {
            return Err("worker export long PNG dimensions are invalid".into());
        }
    }
    Ok(())
}

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
mod tests {
    use super::{
        build_manifest, host_resources, material, render_key, validate_descriptors, worker_loop,
        HostMessage, RenderFormat, RenderManifest, ResourceDescriptor, ResourceMaterial,
        ResourceRole, WorkerMessage, ENGINE_VERSION, PROTOCOL_VERSION, REFERENCE_DATE,
        RESOURCE_VERSION,
    };
    use crate::domain::{default_resume_document, AuthorityCursor};

    #[test]
    fn export_key_binds_product_normalized_selection_and_dpi() {
        use crate::domain::ExportProduct;
        let mut manifest = test_manifest(7);
        manifest.format = RenderFormat::Export;
        let default_key = super::manifest_render_key(&manifest).unwrap();
        manifest.dpi = Some(192);
        manifest.product = Some(ExportProduct::Bundle);
        assert_eq!(super::manifest_render_key(&manifest).unwrap(), default_key);
        manifest.dpi = Some(300);
        assert_ne!(super::manifest_render_key(&manifest).unwrap(), default_key);
        manifest.dpi = None;
        manifest.product = Some(ExportProduct::Pdf);
        let pdf_key = super::manifest_render_key(&manifest).unwrap();
        assert_ne!(pdf_key, default_key);
        manifest.selected_pages = Some(vec![2, 1, 2]);
        let selected_key = super::manifest_render_key(&manifest).unwrap();
        assert_ne!(selected_key, pdf_key);
        manifest.selected_pages = Some(vec![1, 2]);
        assert_eq!(super::manifest_render_key(&manifest).unwrap(), selected_key);
        manifest.selected_pages = Some(vec![1]);
        assert_ne!(super::manifest_render_key(&manifest).unwrap(), selected_key);
    }

    #[test]
    fn worker_rejects_export_dpi_before_requesting_resources() {
        for dpi in [71, 301] {
            let mut manifest = test_manifest(7);
            manifest.format = RenderFormat::Export;
            manifest.dpi = Some(dpi);
            manifest.render_key = super::manifest_render_key(&manifest).unwrap();
            let mut input = Vec::new();
            append_message(
                &mut input,
                &HostMessage::Render {
                    manifest: Box::new(manifest),
                },
            );
            let mut output = Vec::new();
            worker_loop(input.as_slice(), &mut output, 7).unwrap();
            let mut reader = Cursor::new(output);
            let _hello: WorkerMessage = super::read_message(&mut reader).unwrap();
            assert!(
                matches!(super::read_message::<WorkerMessage>(&mut reader).unwrap(), WorkerMessage::Failed { code, message, .. } if code == "invalidManifest" && message.contains("DPI"))
            );
            assert_eq!(reader.position() as usize, reader.get_ref().len());
        }
    }
    use base64::engine::general_purpose::STANDARD as BASE64;
    use base64::Engine as _;
    use std::io::Cursor;
    use typst::foundations::Bytes;

    fn test_cursor(document_id: &str) -> AuthorityCursor {
        AuthorityCursor {
            document_id: document_id.to_owned(),
            context_id: "context-test".into(),
            revision: "r1".into(),
            branch_id: "main-test".into(),
            head_id: None,
        }
    }

    #[test]
    fn test_deadline_override_is_bounded_and_absent_from_production() {
        assert_eq!(super::RENDER_TIMEOUT, std::time::Duration::from_secs(90));
        for candidate in [
            None,
            Some("0"),
            Some("1"),
            Some("2999"),
            Some("3001"),
            Some("90000"),
            Some(" 3000"),
            Some("3000ms"),
        ] {
            assert_eq!(
                super::configured_render_timeout(RenderFormat::Pdf, candidate).as_secs(),
                90
            );
        }
        let expected_ms = if cfg!(feature = "test-hooks") {
            3000
        } else {
            90_000
        };
        assert_eq!(
            super::configured_render_timeout(RenderFormat::Pdf, Some("3000")).as_millis(),
            expected_ms
        );
        assert_eq!(
            super::configured_render_timeout(RenderFormat::Fit, Some("3000")).as_secs(),
            10
        );
        for format in [RenderFormat::Preview, RenderFormat::Export] {
            assert_eq!(
                super::configured_render_timeout(format, Some("3000")).as_secs(),
                90
            );
        }
    }

    #[test]
    fn fit_has_a_separate_key_deadline_and_zero_attempt_envelope() {
        let manifest = test_manifest(7);
        let mut fit = manifest.clone();
        fit.format = RenderFormat::Fit;
        assert_ne!(
            super::manifest_render_key(&fit).unwrap(),
            manifest.render_key
        );
        fit.format = RenderFormat::Preview;
        let preview_key = super::manifest_render_key(&fit).unwrap();
        fit.format = RenderFormat::Fit;
        assert_ne!(super::manifest_render_key(&fit).unwrap(), preview_key);
        assert_eq!(super::render_timeout(RenderFormat::Fit).as_secs(), 10);
        assert_eq!(super::render_timeout(RenderFormat::Pdf).as_secs(), 90);
        assert!(super::valid_output_page_count(RenderFormat::Fit, 0));
        assert!(!super::valid_output_page_count(RenderFormat::Pdf, 0));
        assert!(!super::valid_output_page_count(RenderFormat::Preview, 0));
        assert!(!super::valid_output_page_count(RenderFormat::Fit, 201));
    }

    fn descriptors() -> Vec<ResourceDescriptor> {
        vec![
            ResourceDescriptor {
                role: ResourceRole::BodyFontRegular,
                hash: "a".repeat(64),
                size_bytes: 1,
                mime: "font/otf".into(),
            },
            ResourceDescriptor {
                role: ResourceRole::BodyFontHeavy,
                hash: "b".repeat(64),
                size_bytes: 1,
                mime: "font/ttf".into(),
            },
            ResourceDescriptor {
                role: ResourceRole::IconFont,
                hash: "c".repeat(64),
                size_bytes: 1,
                mime: "font/ttf".into(),
            },
        ]
    }

    fn fake_resources() -> Vec<ResourceMaterial> {
        vec![
            material(
                ResourceRole::BodyFontRegular,
                "font/otf",
                Bytes::new(vec![1]),
            ),
            material(ResourceRole::BodyFontHeavy, "font/ttf", Bytes::new(vec![2])),
            material(ResourceRole::IconFont, "font/ttf", Bytes::new(vec![3])),
        ]
    }

    /// 轻量化证据：内置字体材料按进程只缓存一份（含 SHA-256 身份哈希），
    /// 重复构造只克隆 `Bytes` 的引用计数；指针相同即证明没有再复制
    /// ~22MB 字体数据，也没有重复计算 22MB 的哈希。
    #[test]
    fn bundled_font_materials_are_cached_not_recopied() {
        let first = host_resources("legacy-font:宋体", None).expect("bundled resources");
        let second = host_resources("legacy-font:宋体", None).expect("bundled resources");
        let expected = if crate::engine::system_fonts::installed().is_some() {
            5
        } else {
            3
        };
        assert_eq!(first.len(), expected);
        assert_eq!(second.len(), expected);
        for (left, right) in first.iter().zip(second.iter()) {
            assert_eq!(left.role, right.role);
            assert_eq!(left.hash, right.hash, "identity hash must stay stable");
            assert_eq!(
                left.bytes.as_slice().as_ptr(),
                right.bytes.as_slice().as_ptr(),
                "font materials must share one cached buffer"
            );
        }
    }

    fn test_manifest(generation: u64) -> RenderManifest {
        build_manifest(
            test_cursor("doc-test"),
            default_resume_document("doc-test").unwrap(),
            &fake_resources(),
            generation,
            17,
        )
        .unwrap()
    }

    fn append_message(input: &mut Vec<u8>, message: &impl serde::Serialize) {
        input.extend(serde_json::to_vec(message).unwrap());
        input.push(b'\n');
    }

    #[test]
    fn render_key_binds_authoritative_cursor_document_date_format_and_resource_hashes() {
        let document = default_resume_document("doc-test").unwrap();
        let cursor = test_cursor("doc-test");
        let resources = descriptors();
        let base = render_key(
            &cursor,
            &document,
            REFERENCE_DATE,
            RenderFormat::Pdf,
            &resources,
        )
        .unwrap();
        assert_eq!(
            base,
            render_key(
                &cursor,
                &document,
                REFERENCE_DATE,
                RenderFormat::Pdf,
                &resources
            )
            .unwrap()
        );
        let mut changed = cursor.clone();
        changed.revision = "r2".into();
        assert_ne!(
            base,
            render_key(
                &changed,
                &document,
                REFERENCE_DATE,
                RenderFormat::Pdf,
                &resources
            )
            .unwrap()
        );
        assert_ne!(
            base,
            render_key(
                &cursor,
                &document,
                "2026-09-29",
                RenderFormat::Pdf,
                &resources
            )
            .unwrap()
        );
        let mut changed_resources = resources.clone();
        changed_resources[0].hash = "d".repeat(64);
        assert_ne!(
            base,
            render_key(
                &cursor,
                &document,
                REFERENCE_DATE,
                RenderFormat::Pdf,
                &changed_resources
            )
            .unwrap()
        );
    }

    #[test]
    fn resource_manifest_rejects_missing_duplicate_and_oversized_resources() {
        let mut resources = descriptors();
        assert!(validate_descriptors(&resources, false).is_ok());
        resources.pop();
        assert!(validate_descriptors(&resources, false).is_err());
        resources = descriptors();
        resources.push(resources[0].clone());
        assert!(validate_descriptors(&resources, false).is_err());
        resources = descriptors();
        resources[0].size_bytes = usize::MAX;
        assert!(validate_descriptors(&resources, false).is_err());
    }

    #[test]
    fn worker_rejects_stale_generation_and_invalid_render_key() {
        let mut input = Vec::new();
        append_message(
            &mut input,
            &HostMessage::Render {
                manifest: Box::new(test_manifest(1)),
            },
        );
        let mut output = Vec::new();
        worker_loop(input.as_slice(), &mut output, 2).unwrap();
        let mut reader = Cursor::new(output);
        assert!(matches!(
            super::read_message::<WorkerMessage>(&mut reader).unwrap(),
            WorkerMessage::Hello { generation: 2, .. }
        ));
        assert!(matches!(
            super::read_message::<WorkerMessage>(&mut reader).unwrap(),
            WorkerMessage::Failed { code, .. } if code == "invalidManifest"
        ));

        let mut manifest = test_manifest(2);
        manifest.render_key = "0".repeat(64);
        let mut input = Vec::new();
        append_message(
            &mut input,
            &HostMessage::Render {
                manifest: Box::new(manifest),
            },
        );
        let mut output = Vec::new();
        worker_loop(input.as_slice(), &mut output, 2).unwrap();
        let mut reader = Cursor::new(output);
        let _hello: WorkerMessage = super::read_message(&mut reader).unwrap();
        assert!(matches!(
            super::read_message::<WorkerMessage>(&mut reader).unwrap(),
            WorkerMessage::Failed { code, .. } if code == "invalidManifest"
        ));
    }

    #[test]
    fn worker_rejects_corrupted_resource_bytes_before_typst_compile() {
        let resources = fake_resources();
        let manifest = build_manifest(
            test_cursor("doc-test"),
            default_resume_document("doc-test").unwrap(),
            &resources,
            3,
            18,
        )
        .unwrap();
        let descriptor = manifest
            .resources
            .iter()
            .find(|item| item.role == ResourceRole::BodyFontRegular)
            .unwrap()
            .clone();
        let mut input = Vec::new();
        append_message(
            &mut input,
            &HostMessage::Render {
                manifest: Box::new(manifest),
            },
        );
        append_message(
            &mut input,
            &HostMessage::ResourceBytes {
                request_id: 18,
                generation: 3,
                role: descriptor.role,
                hash: descriptor.hash.clone(),
                size_bytes: descriptor.size_bytes,
                mime: descriptor.mime.clone(),
                data_base64: BASE64.encode([9_u8]),
            },
        );
        let mut output = Vec::new();
        worker_loop(input.as_slice(), &mut output, 3).unwrap();
        let mut reader = Cursor::new(output);
        let _hello: WorkerMessage = super::read_message(&mut reader).unwrap();
        assert!(matches!(
            super::read_message::<WorkerMessage>(&mut reader).unwrap(),
            WorkerMessage::ResourceRequest {
                generation: 3,
                request_id: 18,
                ..
            }
        ));
        assert!(matches!(
            super::read_message::<WorkerMessage>(&mut reader).unwrap(),
            WorkerMessage::Failed { code, .. } if code == "resourceHashMismatch"
        ));
    }

    #[test]
    fn worker_version_contract_is_explicit() {
        assert_eq!(PROTOCOL_VERSION, 1);
        assert_eq!(RESOURCE_VERSION, 1);
        assert_eq!(ENGINE_VERSION, "zinecv-typst-0.15.1-engine-2");
        assert!(super::validate_reference_date("２０２６-09-28").is_err());
        assert!(super::validate_reference_date("2026-02-30").is_err());
    }

    #[test]
    fn preview_format_cannot_reuse_a_pdf_manifest_key() {
        let mut manifest = test_manifest(7);
        let pdf_key = manifest.render_key.clone();
        manifest.format = RenderFormat::Preview;
        let preview_key = super::manifest_render_key(&manifest).unwrap();
        assert_ne!(preview_key, pdf_key);
        let mut input = Vec::new();
        append_message(
            &mut input,
            &HostMessage::Render {
                manifest: Box::new(manifest),
            },
        );
        let mut output = Vec::new();
        worker_loop(input.as_slice(), &mut output, 7).unwrap();
        let mut reader = Cursor::new(output);
        let _hello: WorkerMessage = super::read_message(&mut reader).unwrap();
        assert!(
            matches!(super::read_message::<WorkerMessage>(&mut reader).unwrap(),
            WorkerMessage::Failed { code, .. } if code == "invalidManifest")
        );
    }
}

// test-hooks 注入钩子的进程内验证。宿主侧的 90 秒超时、1.5GiB Job Object
// 终止与同冻结输入重放需要真实父子进程，安全扫描不允许在产品代码里放
// 可执行文件覆盖入口，这些仍在 WebView2/集成层验收（见 execution-status）。
#[cfg(all(test, feature = "test-hooks"))]
mod hooks_tests {
    use super::{
        test_hooks_before_render, worker_loop, HostMessage, RenderManifest, WorkerMessage,
    };
    use std::io::Cursor;
    use std::time::{Duration, Instant};
    use typst::foundations::Bytes;

    fn append_message(input: &mut Vec<u8>, message: &impl serde::Serialize) {
        input.extend(serde_json::to_vec(message).unwrap());
        input.push(b'\n');
    }

    fn clear_hooks() {
        std::env::remove_var("ZINECV_TEST_WORKER_DELAY_MS");
        std::env::remove_var("ZINECV_TEST_WORKER_ALLOC_MB");
        std::env::remove_var("ZINECV_TEST_CRASH_MARKER");
    }

    fn hooks_cursor(document_id: &str) -> crate::domain::AuthorityCursor {
        crate::domain::AuthorityCursor {
            document_id: document_id.to_owned(),
            context_id: "context-hooks".into(),
            revision: "r1".into(),
            branch_id: "main-hooks".into(),
            head_id: None,
        }
    }

    #[test]
    fn test_hooks_fire_before_render_in_worker_loop() {
        let manifest: RenderManifest = {
            let resources = vec![
                super::material(
                    super::ResourceRole::BodyFontRegular,
                    "font/otf",
                    Bytes::new(vec![1]),
                ),
                super::material(
                    super::ResourceRole::BodyFontHeavy,
                    "font/ttf",
                    Bytes::new(vec![2]),
                ),
                super::material(
                    super::ResourceRole::IconFont,
                    "font/ttf",
                    Bytes::new(vec![3]),
                ),
            ];
            super::build_manifest(
                hooks_cursor("doc-render-hooks"),
                crate::domain::default_resume_document("doc-render-hooks").unwrap(),
                &resources,
                7,
                91,
            )
            .unwrap()
        };
        let message = HostMessage::Render {
            manifest: Box::new(manifest),
        };

        clear_hooks();
        let mut plain_input = Vec::new();
        append_message(&mut plain_input, &message);
        let mut plain_output = Vec::new();
        let plain_started = Instant::now();
        worker_loop(plain_input.as_slice(), &mut plain_output, 7).unwrap();
        assert!(
            plain_started.elapsed() < Duration::from_millis(400),
            "baseline loop should be fast"
        );

        std::env::set_var("ZINECV_TEST_WORKER_DELAY_MS", "500");
        let mut delayed_input = Vec::new();
        append_message(&mut delayed_input, &message);
        let mut delayed_output = Vec::new();
        let delayed_started = Instant::now();
        worker_loop(delayed_input.as_slice(), &mut delayed_output, 7).unwrap();
        let delayed_elapsed = delayed_started.elapsed();
        clear_hooks();
        assert!(
            delayed_elapsed >= Duration::from_millis(500),
            "delay hook must run inside the render loop before responding: {delayed_elapsed:?}"
        );
        let mut reader = Cursor::new(delayed_output);
        assert!(matches!(
            super::read_message::<WorkerMessage>(&mut reader).unwrap(),
            WorkerMessage::Hello { generation: 7, .. }
        ));
        // The valid manifest requests its first font before the fixture's EOF
        // becomes a protocol failure; the delay must precede this request too.
        assert!(matches!(
            super::read_message::<WorkerMessage>(&mut reader).unwrap(),
            WorkerMessage::ResourceRequest {
                request_id: 91,
                generation: 7,
                ..
            }
        ));
        assert!(matches!(
            super::read_message::<WorkerMessage>(&mut reader).unwrap(),
            WorkerMessage::Failed { .. }
        ));

        std::env::set_var("ZINECV_TEST_WORKER_ALLOC_MB", "64");
        test_hooks_before_render();
        clear_hooks();
        assert!(std::env::var("ZINECV_TEST_WORKER_DELAY_MS").is_err());
        assert!(std::env::var("ZINECV_TEST_WORKER_ALLOC_MB").is_err());
        assert!(std::env::var("ZINECV_TEST_CRASH_MARKER").is_err());
    }
}
