//! Typst 文档引擎（B07 阶段实现）：ResumeDocument → 矢量 PDF / SVG / PNG。
//! 正文内容只经 `json("resume.json")` 作为数据进入排版，不拼进 Typst 源码。
//! 三个内置模板（legacy-v1 / clear-single-v1 / compact-single-v1）的版式度量
//! 按旧 DOM 预览的 CSS 逐项换算（px × 0.75 = pt）：
//! - 正文颜色固定（legacy #000 / clear #28221e / compact #252525）；
//!   主题色只作强调（标题图标、clear 强调条、compact 头部下边框）。
//! - 节标题 strong 固定 18px/13px（所有模板，CSS `.preview-title strong`）。
//! - h1 无全局字重重置，浏览器默认 bold → 与 heavy 字重（900）一致。
//! - 行距按 CSS line-height 语义换算：以 text(top-edge/bottom-edge) 的 em
//!   相对量表达半行距对称溢出，leading 归零（负 leading 会破坏 Typst
//!   分页——lineHeight 小于字体竖向度量时整篇只出一页，B07 实测定位）。
//!   单行元素另用固定高度盒 + 垂直居中。
//! - 联系栏/站点/次要信息由 Rust 侧预计算（过滤空值与年龄文案），
//!   避免把 null 处理留给模板层。
//! - “至今”等非日期文本原样保留（旧版会渲染为“至今年undefined月”，属
//!   已知缺陷，2.0 按计划修复并记录，不照搬 bug）。
//!
//! 像素级对照由引擎对照工具按 B07 视觉关卡另行验收。

// layout_json 的版式参数表用单条 serde_json::json! 展开 ~50 个字段，
// 超过宏默认递归深度；此处仅放宽宏展开上限，不改变运行时行为。
#![recursion_limit = "512"]

use std::path::PathBuf;
use std::sync::OnceLock;

use typst::diag::{FileError, FileResult};
use typst::foundations::{Bytes, Datetime, Duration};
use typst::syntax::{FileId, RootedPath, Source, VirtualPath, VirtualRoot};
use typst::text::{Font, FontBook};
use typst::utils::LazyHash;
use typst::{Library, LibraryExt, World};
use typst_layout::PagedDocument;
pub mod body_fonts;
pub mod system_fonts;

use zinecv_contracts::{
    DateFormat, Entry, ModuleKind, Presentation, ResumeDocument, RichBlock, Section, Separator,
    TitleFormat,
};

// Preserve the public engine API while storage uses the lightweight asset crate.
pub use zinecv_assets::{FONT_HEAVY_BYTES, FONT_HEBREW_BYTES, FONT_ICON_BYTES, FONT_REGULAR_BYTES};

// lucide（ISC 授权，lucide-react 1.47 内置）Award / FileText 的原始路径数据，
// 在 Rust 侧按文档主题色着色后作为 SVG 资源供给模板。
const LUCIDE_AWARD_PATHS: &str = r#"<path d="m15.477 12.89 1.515 8.526a.5.5 0 0 1-.81.47l-3.58-2.687a1 1 0 0 0-1.197 0l-3.586 2.686a.5.5 0 0 1-.81-.469l1.514-8.526"/><circle cx="12" cy="8" r="6"/>"#;
const LUCIDE_FILE_TEXT_PATHS: &str = r#"<path d="M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z"/><path d="M14 2v5a1 1 0 0 0 1 1h5"/><path d="M10 9H8"/><path d="M16 13H8"/><path d="M16 17H8"/>"#;

#[derive(Debug)]
pub enum EngineError {
    Validation(String),
    Compile(String),
    /// TextMap 提取/校验失败：模板标记缺失或簇无法回切逻辑文本。
    TextMap(String),
}

impl std::fmt::Display for EngineError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Validation(message) => write!(f, "Engine validation failed: {message}"),
            Self::Compile(message) => write!(f, "Typst compile failed: {message}"),
            Self::TextMap(message) => write!(f, "TextMap extraction failed: {message}"),
        }
    }
}

// 引擎错误统一映射为宿主错误码（原实现在 src-tauri/src/lib.rs；引擎迁出后
// 两侧类型均为外部类型，孤儿规则要求该 impl 落在 EngineError 的定义 crate）。
impl From<EngineError> for zinecv_contracts::AppError {
    fn from(error: EngineError) -> Self {
        zinecv_contracts::AppError::new(
            zinecv_contracts::ErrorCode::EngineFailure,
            error.to_string(),
            false,
        )
    }
}

/// 一次渲染需要的头像资源；缺席时保留 64×88px 布局占位
/// （与旧 DOM 的 `.preview-avatar-slot.empty` 一致）。
pub type AvatarAsset = Option<(String, Vec<u8>)>;

/// Font bytes are supplied by the render host and checked against the manifest
/// before Typst sees them. Installed heading fonts are optional; bundled body
/// and icon fonts remain the deterministic fallback.
///
/// `Bytes` 以 `Arc` 共享底层缓冲：内置字体直接借用 `'static` 常量（零拷贝），
/// worker 从 IPC 收到的 `Vec<u8>` 也由 `Bytes::new` 原样接管。这样每次渲染不再
/// 复制 22MB 字体数据（一页求解最多调用 16 次）。
#[derive(Debug, Clone)]
pub struct RenderFontBytes {
    pub regular: Bytes,
    pub heavy: Bytes,
    pub icon: Bytes,
    pub heading: Option<system_fonts::HeadingFonts>,
    pub selected_body: Option<body_fonts::BodyFonts>,
    /// 已验证的资源身份（宿主清单里校验过的 SHA-256）；`None` 表示进程内
    /// 内置常量路径（`Bytes` 直接借用 `'static` 字节）。
    pub identity: Option<FontIdentity>,
}

/// 字体资源的已验证身份：worker 路径由资源清单哈希携带，进程内路径按需
/// 从内容派生。身份相同即复用同一次字体解析结果。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FontIdentity {
    pub regular: String,
    pub heavy: String,
    pub icon: String,
    pub heading_regular: Option<String>,
    pub heading_bold: Option<String>,
    pub selected_regular: Option<String>,
    pub selected_bold: Option<String>,
}

impl FontIdentity {
    /// 无宿主身份时按内容哈希派生（一次性成本，之后按身份缓存复用）。
    pub(crate) fn from_sha(font_bytes: &RenderFontBytes) -> Self {
        use sha2::{Digest, Sha256};
        Self {
            regular: format!("{:x}", Sha256::digest(font_bytes.regular.as_slice())),
            heavy: format!("{:x}", Sha256::digest(font_bytes.heavy.as_slice())),
            icon: format!("{:x}", Sha256::digest(font_bytes.icon.as_slice())),
            heading_regular: font_bytes
                .heading
                .as_ref()
                .map(|fonts| format!("{:x}", Sha256::digest(fonts.regular.as_slice()))),
            selected_regular: font_bytes
                .selected_body
                .as_ref()
                .map(|fonts| format!("{:x}", Sha256::digest(fonts.regular.as_slice()))),
            selected_bold: font_bytes
                .selected_body
                .as_ref()
                .map(|fonts| format!("{:x}", Sha256::digest(fonts.bold.as_slice()))),
            heading_bold: font_bytes
                .heading
                .as_ref()
                .map(|fonts| format!("{:x}", Sha256::digest(fonts.bold.as_slice()))),
        }
    }
}

impl Default for RenderFontBytes {
    fn default() -> Self {
        let mut fonts = bundled_font_bytes();
        fonts.heading = system_fonts::installed();
        fonts
    }
}

pub const DEFAULT_REFERENCE_DATE: (i32, u8, u8) = (2026, 9, 28);

/// Return the only font resources the production host may expose to a worker.
pub fn bundled_font_bytes() -> RenderFontBytes {
    RenderFontBytes {
        regular: Bytes::new(FONT_REGULAR_BYTES),
        heavy: Bytes::new(FONT_HEAVY_BYTES),
        icon: Bytes::new(FONT_ICON_BYTES),
        heading: None,
        selected_body: None,
        identity: None,
    }
}

pub fn template_source_bytes() -> &'static [u8] {
    TEMPLATE_SRC.as_bytes()
}

pub fn native_font_bytes(document: &ResumeDocument) -> Result<RenderFontBytes, EngineError> {
    Ok(RenderFontBytes {
        selected_body: body_fonts::installed(&document.presentation.font_set_id)
            .map_err(EngineError::Validation)?,
        ..RenderFontBytes::default()
    })
}

fn parse_font_bundle(font_bytes: &RenderFontBytes) -> (FontBook, Vec<Font>) {
    let mut book = FontBook::new();
    let mut fonts = Vec::new();
    // `Bytes` 克隆只增加引用计数，字体数据本身不再被复制。
    for bytes in [
        font_bytes.regular.clone(),
        font_bytes.heavy.clone(),
        font_bytes.icon.clone(),
    ]
    .into_iter()
    .chain(std::iter::once(Bytes::new(FONT_HEBREW_BYTES)))
    .chain(
        font_bytes
            .selected_body
            .iter()
            .flat_map(|body| [body.regular.clone(), body.bold.clone()]),
    )
    .chain(
        font_bytes
            .heading
            .iter()
            .flat_map(|heading| [heading.regular.clone(), heading.bold.clone()]),
    ) {
        for font in Font::iter(bytes) {
            book.push(font.info().clone());
            fonts.push(font);
        }
    }
    (book, fonts)
}

/// 字体解析缓存键：按已验证资源身份（含可选标题字体哈希）区分，纯内置常量路径用
/// 指针等价判定。hash 变更即键变更，旧解析结果随之失效。
#[derive(Debug, Clone, PartialEq, Eq)]
enum FontCacheKey {
    /// 进程内内置常量（`'static` 字节指针等价）。
    Bundled,
    /// 已验证的资源身份；字节变更（hash 不同）即失效。
    Verified(FontIdentity),
}

/// 行盒换算用的字体竖向度量（em；descender 为负值）。
#[derive(Debug, Clone, Copy)]
struct FontVerticalMetrics {
    /// 正文（Source Han Serif regular）hhea 度量。
    body: (f64, f64),
    body_family: &'static str,
    bundled_body: (f64, f64),
    /// iconfont 的 hhea 度量。
    icon: (f64, f64),
    heading: Option<(f64, f64)>,
    heading_family: Option<&'static str>,
}

/// 同一字体身份只解析一次：缓存 FontBook/Font 与行盒换算用的竖向度量。
/// 单槽即可——一个进程内字体集只有一种，身份变化时替换条目，不无界收集。
type ParsedFonts = (FontBook, Vec<Font>, FontVerticalMetrics);
type FontCacheEntry = Option<(FontCacheKey, ParsedFonts)>;
fn parsed_fonts(font_bytes: &RenderFontBytes) -> Result<ParsedFonts, EngineError> {
    static FONT_CACHE: OnceLock<std::sync::Mutex<FontCacheEntry>> = OnceLock::new();
    let key = match &font_bytes.identity {
        Some(identity) => FontCacheKey::Verified(identity.clone()),
        None => {
            let bundled = font_bytes.heading.is_none()
                && font_bytes.selected_body.is_none()
                && std::ptr::eq(
                    font_bytes.regular.as_slice().as_ptr(),
                    FONT_REGULAR_BYTES.as_ptr(),
                )
                && std::ptr::eq(
                    font_bytes.heavy.as_slice().as_ptr(),
                    FONT_HEAVY_BYTES.as_ptr(),
                )
                && std::ptr::eq(
                    font_bytes.icon.as_slice().as_ptr(),
                    FONT_ICON_BYTES.as_ptr(),
                );
            if bundled {
                FontCacheKey::Bundled
            } else {
                FontCacheKey::Verified(FontIdentity::from_sha(font_bytes))
            }
        }
    };
    let cache = FONT_CACHE.get_or_init(|| std::sync::Mutex::new(None));
    let mut guard = cache.lock().expect("font parse cache must not be poisoned");
    if let Some((cached, parsed)) = guard.as_ref() {
        if *cached == key {
            return Ok(parsed.clone());
        }
    }
    let (book, fonts) = parse_font_bundle(font_bytes);
    if fonts.is_empty() {
        return Err(EngineError::Validation(
            "Bundled fonts were rejected by Typst".into(),
        ));
    }
    // 字体竖向度量（em）：CSS 行盒换算的核心参数。Chromium 的行布局使用
    // hhea 度量并按字号四舍五入为整数像素（engine-parity 探针：canvas
    // fontBoundingBox 与 range rect 实测），Typst 的 FontMetrics::from_ttf
    // 偏偏取 OS/2 typo 度量；因此这里直接读 hhea，不按 family 名匹配。
    // iconfont 的 hhea 与 typo 一致，但为对称起见同样显式解析。
    fn hhea_metrics(bytes: &Bytes) -> Option<(f64, f64)> {
        let face = ttf_parser::Face::parse(bytes, 0).ok()?;
        let upm = f64::from(face.units_per_em());
        Some((
            f64::from(face.ascender()) / upm,
            f64::from(face.descender()) / upm,
        ))
    }
    let body = hhea_metrics(
        font_bytes
            .selected_body
            .as_ref()
            .map(|fonts| &fonts.regular)
            .unwrap_or(&font_bytes.regular),
    )
    .ok_or_else(|| EngineError::Validation("body font metrics missing".into()))?;
    let icon = hhea_metrics(&font_bytes.icon)
        .ok_or_else(|| EngineError::Validation("icon font metrics missing".into()))?;
    let heading = font_bytes
        .heading
        .as_ref()
        .map(|fonts| {
            hhea_metrics(&fonts.regular)
                .ok_or_else(|| EngineError::Validation("heading font metrics missing".into()))
        })
        .transpose()?;
    let heading_family = font_bytes.heading.as_ref().map(|fonts| fonts.family);
    let parsed = (
        book,
        fonts,
        FontVerticalMetrics {
            body,
            bundled_body: hhea_metrics(&font_bytes.regular)
                .ok_or_else(|| EngineError::Validation("bundled body metrics missing".into()))?,
            body_family: font_bytes
                .selected_body
                .as_ref()
                .map_or("Source Han Serif", |fonts| fonts.family),
            icon,
            heading,
            heading_family,
        },
    );
    *guard = Some((key, parsed.clone()));
    Ok(parsed)
}

/// 数据驱动模板：三个内置模板共用一个结构，按 layout.mode 分支版式差异。
///
/// TextMap（正式文本层）约定：
/// - 每个可选中文本叶子前放置 `metadata("node:<稳定节点ID>")` 标记；
///   节点 ID 由稳定领域 ID 派生（basic:<field> /
///   section:<id>:head / entry:<id>:title|:imeta|:meta|:dates /
///   entry|section:<id>:b<i>[:i<j>:b<k>…]:l<n>）。
/// - 装饰性文字（图标字形、CSDN 字样、有序列表编号）前放置
///   `metadata("node:!deco")`，提取层跳过，不进入可选文本。
/// - 日期/元数据/站点标签等渲染字符串全部由 Rust 侧预计算
///   （payload.computed / payload.contact），模板只做纯渲染，
///   保证 Rust 能逐字重建纸面文本。
const TEMPLATE_SRC: &str = include_str!("templates.typ");

fn fixture_id(name: &str) -> FileId {
    RootedPath::new(
        VirtualRoot::Project,
        VirtualPath::new(name).expect("static template path"),
    )
    .intern()
}

struct DocumentWorld {
    library: LazyHash<Library>,
    book: LazyHash<FontBook>,
    fonts: Vec<Font>,
    main: FileId,
    data_id: FileId,
    avatar_id: FileId,
    award_id: FileId,
    file_text_id: FileId,
    source: Source,
    data: Bytes,
    avatar: AvatarAsset,
    award_svg: Bytes,
    file_text_svg: Bytes,
    reference_date: (i32, u8, u8),
}

/// 由模板 ID 推导渲染模式：未知 ID 回退 legacy（F19：元数据保留，界面另行提示）。
fn template_mode(template_id: &str) -> &'static str {
    match template_id {
        "clear-single-v1" => "clear",
        "compact-single-v1" => "compact",
        _ => "legacy",
    }
}

fn sanitize_hex(theme: &str) -> Result<String, EngineError> {
    let theme = theme.trim();
    if !theme.starts_with('#')
        || theme.len() != 7
        || !theme[1..].bytes().all(|byte| byte.is_ascii_hexdigit())
    {
        return Err(EngineError::Validation(format!(
            "Theme color {theme} is not a #rrggbb value"
        )));
    }
    Ok(theme.to_ascii_lowercase())
}

fn lucide_svg(paths: &str, color: &str) -> Bytes {
    Bytes::new(
        format!(
            "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"24\" height=\"24\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"{color}\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\">{paths}</svg>"
        )
        .into_bytes(),
    )
}

/// 计算周岁年龄（与旧版 calculateAge 一致，参考日期为冻结值）。
fn age_years(birth: &str, reference: (i32, u8, u8)) -> Option<u32> {
    let mut parts = birth.splitn(2, '-');
    let year: i32 = parts.next()?.parse().ok()?;
    let month: u32 = parts.next()?.parse().ok()?;
    Some((reference.0 - year - ((reference.1 as u32) < month) as i32).max(0) as u32)
}

impl DocumentWorld {
    fn new(
        document: &ResumeDocument,
        avatar: AvatarAsset,
        font_bytes: &RenderFontBytes,
        reference_date: (i32, u8, u8),
    ) -> Result<Self, EngineError> {
        let theme = sanitize_hex(&document.presentation.theme)?;
        if !matches!(
            document.presentation.date_format,
            DateFormat::Chinese | DateFormat::Dotted
        ) || !matches!(
            document.presentation.title_format,
            TitleFormat::SingleLine | TitleFormat::DoubleLine
        ) {
            return Err(EngineError::Validation(
                "Presentation format fields are outside the supported set".into(),
            ));
        }
        // 字体解析缓存：按已验证资源身份复用 FontBook/Font 与正文竖向度量——
        // 一次 worker generation 内同字体只解析一次，字节变更（hash 不同）
        // 即失效；进程内内置常量路径用指针等价快速判定，替代原先每次
        // 约 66MB 的内容 memcmp。
        let (book, fonts, metrics) = parsed_fonts(font_bytes)?;

        let mode = template_mode(&document.presentation.template_id);
        let layout = layout_json(
            document,
            &theme,
            mode,
            metrics,
            avatar.is_some(),
            reference_date,
        )?;
        let contact = contact_json(&contact_layout_for_date(document, reference_date));
        let computed = computed_json(document);
        let payload = serde_json::json!({
            "document": document,
            "layout": layout,
            "contact": contact,
            "computed": computed,
        });
        let data = Bytes::from_string(
            serde_json::to_string(&payload)
                .map_err(|error| EngineError::Validation(error.to_string()))?,
        );
        let main = fixture_id("/main.typ");
        Ok(Self {
            library: LazyHash::new(Library::default()),
            book: LazyHash::new(book),
            fonts,
            main,
            data_id: fixture_id("/resume.json"),
            avatar_id: fixture_id("/avatar.png"),
            award_id: fixture_id("/award.svg"),
            file_text_id: fixture_id("/file-text.svg"),
            source: Source::new(main, TEMPLATE_SRC.into()),
            data,
            avatar,
            award_svg: lucide_svg(LUCIDE_AWARD_PATHS, &theme),
            file_text_svg: lucide_svg(LUCIDE_FILE_TEXT_PATHS, &theme),
            reference_date,
        })
    }
}

/// 头部联系信息的预计算结构：过滤空值、解析年龄文案与站点标签，
/// 模板层只做纯渲染（无 null 分支）。同一结构也是 TextMap 逻辑
/// 文本的唯一事实源，保证 Rust 能逐字重建纸面内容。
struct ContactItem {
    node_id: String,
    glyph: Option<String>,
    value: String,
}

struct SiteItem {
    node_id: String,
    url: String,
    label: String,
}

struct ContactLayout {
    primary: Vec<ContactItem>,
    secondary: Vec<ContactItem>,
    sites: Vec<SiteItem>,
}

/// 站点显示标签：与旧 CSS 语义一致，仅剥离协议前缀
/// （模板原为 `shown.replace(regex("^https?://"), "")`）。
fn site_label(url: &str) -> String {
    let shown = if url.starts_with("http") {
        url.to_owned()
    } else {
        format!("https://{url}")
    };
    shown
        .strip_prefix("https://")
        .or_else(|| shown.strip_prefix("http://"))
        .unwrap_or(&shown)
        .to_owned()
}

fn contact_layout_for_date(
    document: &ResumeDocument,
    reference_date: (i32, u8, u8),
) -> ContactLayout {
    let basic = &document.basic;
    let entry = |field: &str, glyph: Option<&str>, value: &str| {
        if value.is_empty() {
            None
        } else {
            Some(ContactItem {
                node_id: format!("basic:{field}"),
                glyph: glyph.map(str::to_owned),
                value: value.to_owned(),
            })
        }
    };
    let primary: Vec<_> = [
        entry("phone", Some("\u{e75b}"), &basic.phone),
        entry("email", Some("\u{e74a}"), &basic.email),
        entry("wechat", Some("\u{e73e}"), &basic.wechat),
    ]
    .into_iter()
    .flatten()
    .collect();

    let mut secondary: Vec<ContactItem> = Vec::new();
    if !basic.birth.is_empty() {
        let label = if basic.age_mode == zinecv_contracts::AgeMode::Age {
            let years = age_years(&basic.birth, reference_date).unwrap_or(0);
            format!("{years}岁")
        } else {
            format!("{} 出生", basic.birth)
        };
        secondary.push(ContactItem {
            node_id: "basic:birth".into(),
            glyph: Some("\u{e75e}".into()),
            value: label,
        });
    }
    if !basic.city.is_empty() {
        secondary.push(ContactItem {
            node_id: "basic:city".into(),
            glyph: Some("\u{e732}".into()),
            value: basic.city.clone(),
        });
    }
    let optional = [
        ("gender", &basic.gender),
        ("height", &basic.height),
        ("weight", &basic.weight),
        ("ethnicity", &basic.ethnicity),
        ("birthplace", &basic.birthplace),
        ("politicalStatus", &basic.political_status),
        ("maritalStatus", &basic.marital_status),
        ("zodiac", &basic.zodiac),
        ("mbti", &basic.mbti),
    ];
    for (field, value) in optional {
        if let Some(item) = value.as_deref().and_then(|value| entry(field, None, value)) {
            secondary.push(item);
        }
    }

    let sites: Vec<SiteItem> = [("website", &basic.website), ("linkedin", &basic.linkedin)]
        .into_iter()
        .filter_map(|(field, value)| value.as_deref().map(|value| (field, value)))
        .filter(|(_, value)| !value.is_empty())
        .map(|(field, url)| SiteItem {
            node_id: format!("basic:{field}"),
            url: url.to_owned(),
            label: site_label(url),
        })
        .collect();

    ContactLayout {
        primary,
        secondary,
        sites,
    }
}

fn contact_json(contact: &ContactLayout) -> serde_json::Value {
    let item = |entry: &ContactItem| serde_json::json!({ "nodeId": entry.node_id, "glyph": entry.glyph, "value": entry.value });
    let primary: Vec<_> = contact.primary.iter().map(item).collect();
    let secondary: Vec<_> = contact.secondary.iter().map(item).collect();
    let sites: Vec<_> = contact
        .sites
        .iter()
        .map(|site| serde_json::json!({ "nodeId": site.node_id, "url": site.url, "label": site.label }))
        .collect();
    serde_json::json!({ "primary": primary, "secondary": secondary, "sites": sites })
}

/// 日期标签：仅 "YYYY-MM…" 转格式；"至今"等原样保留
/// （旧版"至今年undefined月"缺陷已修复，不照搬 bug）。
/// 与原模板 dateLabel 逐字等价：含 "-" 且码点数 >= 7 才转换。
fn date_label(value: &str, format: DateFormat) -> String {
    if value.is_empty() {
        return String::new();
    }
    if value.contains('-') && value.chars().count() >= 7 {
        let mut parts = value.split('-');
        let year = parts.next().unwrap_or("");
        let month = parts.next().unwrap_or("");
        match format {
            DateFormat::Dotted => format!("{year}.{month}"),
            DateFormat::Chinese => format!("{year}年{month}月"),
        }
    } else {
        value.to_owned()
    }
}

fn range_label(start: &str, end: &str, format: DateFormat) -> String {
    format!(
        "{} - {}",
        date_label(start, format),
        date_label(end, format)
    )
}

fn meta_join(parts: &[&str]) -> String {
    parts
        .iter()
        .filter(|part| !part.is_empty())
        .copied()
        .collect::<Vec<_>>()
        .join(" ")
}

/// 条目头部元数据：教育经历含学历方式缺省"全日制"与学院。
fn entry_meta(kind: &ModuleKind, entry: &Entry) -> String {
    if matches!(kind, ModuleKind::Education) {
        let mode = entry.mode.as_deref().unwrap_or("全日制");
        meta_join(&[
            &entry.role,
            &entry.department,
            mode,
            entry.college.as_deref().unwrap_or(""),
        ])
    } else {
        meta_join(&[&entry.role, &entry.department])
    }
}

/// 单行标题的内联元数据（含分隔符前缀语义）。
fn inline_meta(meta: &str, title: &str, separator: Separator) -> String {
    if meta.is_empty() {
        String::new()
    } else if title.is_empty() {
        meta.to_owned()
    } else {
        let sep = match separator {
            Separator::Enabled => " - ",
            Separator::Disabled => " ",
        };
        format!("{sep}{meta}")
    }
}

/// 条目日期区间：教育经历始终渲染；其余仅当 start 非空。
fn entry_range(kind: &ModuleKind, entry: &Entry, format: DateFormat) -> String {
    if matches!(kind, ModuleKind::Education) || !entry.start.is_empty() {
        range_label(&entry.start, &entry.end, format)
    } else {
        String::new()
    }
}

struct ComputedEntry {
    meta: String,
    inline_meta: String,
    range: String,
}

fn computed_entry(kind: &ModuleKind, entry: &Entry, presentation: &Presentation) -> ComputedEntry {
    let meta = entry_meta(kind, entry);
    ComputedEntry {
        inline_meta: inline_meta(&meta, &entry.title, presentation.separator),
        range: entry_range(kind, entry, presentation.date_format),
        meta,
    }
}

/// 条目级预计算载荷（与 doc.sections 按索引对齐；summary 节为空数组）。
fn computed_json(document: &ResumeDocument) -> serde_json::Value {
    let sections: Vec<_> = document
        .sections
        .iter()
        .map(|section| match section {
            Section::Entry(section) => {
                let entries: Vec<_> = section
                    .entries
                    .iter()
                    .map(|entry| {
                        let computed = computed_entry(&section.kind, entry, &document.presentation);
                        serde_json::json!({
                            "meta": computed.meta,
                            "inlineMeta": computed.inline_meta,
                            "range": computed.range,
                        })
                    })
                    .collect();
                serde_json::json!({ "entries": entries })
            }
            Section::Summary(_) => serde_json::json!({ "entries": [] }),
        })
        .collect();
    serde_json::json!({ "sections": sections })
}

/// 按旧版 CSS（preview.css + 两个模板覆盖）逐项换算版式参数。
/// px → pt 固定 ×0.75。
///
/// 行盒：Chromium 行布局用整数像素化的 hhea 度量（ascent/descent 按字号
/// round，半行距 floor），基线距行盒顶 = ascent + 半行距；多字体行取各
/// 行内盒调整后 ascent/descent 的最大值。该模型已由 engine-parity 探针
/// 逐元素实测校准（canvas fontBoundingBox + range rect + 字形轮廓），
/// 下行全部按 (基线偏移, 行盒高) 换算成该文本字号下的 top/bottom-edge，
/// 不能改回连续 em 近似（半行距取整造成最多 0.5px 的系统性偏差）。
/// 不能用负 leading 表达 line-height —— 负 leading 会让 Typst 整篇只出一页
/// （B07 实测定位，见 typst_poc 的 pagination_structure_variants 证据）。
fn layout_json(
    document: &ResumeDocument,
    theme: &str,
    mode: &str,
    metrics: FontVerticalMetrics,
    has_avatar: bool,
    _reference_date: (i32, u8, u8),
) -> Result<serde_json::Value, EngineError> {
    let pres = &document.presentation;
    let px = |v: f64| v * 0.75;
    let fs_pt = pres.font_size_pt as f64;
    let lh_pt = pres.line_height_pt as f64;
    let em = |factor: f64, base_pt: f64| factor * base_pt;

    let (sh_asc, sh_desc) = metrics.body;
    let (ic_asc, ic_desc) = metrics.icon;
    let heading_strut = if mode == "clear" {
        metrics.heading.unwrap_or(metrics.bundled_body)
    } else {
        (sh_asc, sh_desc)
    };

    // Chromium 行盒：整数化 ascent/descent + 向下取整的半行距。
    let strut_offset = |asc_em: f64, desc_em: f64, font_px: f64, line_px: f64| -> f64 {
        let ascent = (asc_em * font_px).round();
        let descent = (-desc_em * font_px).round();
        ascent + ((line_px - ascent - descent) / 2.0).floor()
    };
    // (基线偏移, 行盒高) → Typst top/bottom-edge（em，相对该文本字号；
    // bottom-edge 传 top − extent，Typst 内部取负还原为基线下行距）。
    let edges = |offset_px: f64, extent_px: f64, font_px: f64| -> (f64, f64) {
        let top = offset_px / font_px;
        (top, top - extent_px / font_px)
    };

    let fs_px = fs_pt / 0.75;
    let lh_px = lh_pt / 0.75;
    // 正文与继承行高的一切文本（联系行文字、条目头、正文、列表）。
    let body_offset = strut_offset(sh_asc, sh_desc, fs_px, lh_px);
    let (text_top_em, text_bottom_em) = edges(body_offset, lh_px, fs_px);

    let (paper_color, title_strong_color, head_strong_color, contact_color, meta_color, rich_color) =
        match mode {
            "clear" => (
                "#28221e", "#251f1b", "#302923", "#504842", "#625952", "#37302b",
            ),
            "compact" => (
                "#252525", "#252525", "#252525", "#000000", "#252525", "#000000",
            ),
            _ => (
                "#000000", "#000000", "#000000", "#000000", "#000000", "#000000",
            ),
        };

    // 头部 h1：legacy 21px / clear 220% / compact 190%（相对正文字号）。
    let (h1_px, h1_mb_px, h1_tracking_em) = match mode {
        "clear" => (2.2 * fs_pt / 0.75, 9.0, -0.035),
        "compact" => (1.9 * fs_pt / 0.75, 4.0, -0.025),
        _ => (21.0, 10.0, 0.0),
    };
    let h1_pt = px(h1_px);
    // h1 行高与字号同比（三模板 line-height 均为 1），strut 按 clear 的
    // Georgia 栈首字体模拟。
    let h1_offset = strut_offset(heading_strut.0, heading_strut.1, h1_px, h1_px);
    let (h1_top_em, h1_bottom_em) = edges(h1_offset, h1_px, h1_px);

    let (strip_px, title_mb_px, title_pad_bottom_px, title_border) = match mode {
        "clear" => (
            25.0,
            7.0,
            4.0,
            Some(serde_json::json!({ "sizePt": 0.75, "color": "#d5cec7" })),
        ),
        "compact" => (
            20.0,
            3.0,
            2.0,
            Some(serde_json::json!({ "sizePt": 0.75, "color": "#777777" })),
        ),
        _ => (13.0, 6.5, 0.0, None),
    };

    let (header_pad_bottom_px, header_border) = match mode {
        "clear" => (
            12.0,
            Some(serde_json::json!({ "sizePt": 0.75, "color": "#564c45" })),
        ),
        "compact" => (
            7.0,
            Some(serde_json::json!({ "sizePt": 1.5, "color": theme })),
        ),
        _ => (0.0, None),
    };

    let (entry_gap_px, head_pad_bottom_px) = match mode {
        "clear" => (7.0, 2.0),
        "compact" => (3.0, 0.0),
        _ => (2.5, 2.5),
    };

    // 节标题条：CSS 是 border-box（min-height 含 padding 与边框）。
    // lineBox 只放内容盒；Typst 的 block stroke 不占布局高度，因此
    // padding-bottom + 边框一起作为 inset，流高才与 border-box 一致。
    let strip_border_px = if title_border.is_some() { 1.0 } else { 0.0 };
    let strip_content_px = strip_px - title_pad_bottom_px - strip_border_px;
    let title_center_pt = px((strip_content_px - 13.0) / 2.0);
    let after_line_dy_pt = px((strip_content_px - 0.75) / 2.0);
    let title_bottom_inset_pt = px(title_pad_bottom_px + strip_border_px);

    // 节标题 strong：18px 字号固定，行盒 13px（.preview-title strong）。
    let strong_px = 18.0;
    let strong_line_px = 13.0;
    let strong_offset = strut_offset(heading_strut.0, heading_strut.1, strong_px, strong_line_px);
    let (strong_top_em, strong_bottom_em) = edges(strong_offset, strong_line_px, strong_px);

    // 条目头行：flex 基线对齐 → 行基线取两侧 strut 偏移的最大值；标题格
    // 为对齐基线向下延伸（clear 的 Georgia strut 偏移比日期格小 1px）。
    let head_title_offset = strut_offset(heading_strut.0, heading_strut.1, fs_px, lh_px);
    let head_dates_offset = strut_offset(sh_asc, sh_desc, fs_px, lh_px);
    let head_row_offset = head_title_offset.max(head_dates_offset);
    let head_title_extent_px = head_row_offset + (lh_px - head_title_offset.min(head_dates_offset));
    let (head_title_top_em, head_title_bottom_em) =
        edges(head_row_offset, head_title_extent_px, fs_px);
    let (head_dates_top_em, head_dates_bottom_em) = edges(head_row_offset, lh_px, fs_px);

    // iconfont 行内盒：联系行（字号固定 13px，行高继承正文）与站点/节
    // 标题的 13px 定高盒（13px 行高）。节标题图标 18px 字号在 13px 行盒。
    let contact_icon_px = 13.0;
    let contact_icon_offset = strut_offset(ic_asc, ic_desc, contact_icon_px, lh_px);
    let (contact_icon_top_em, contact_icon_bottom_em) =
        edges(contact_icon_offset, lh_px, contact_icon_px);
    let site_icon_offset = strut_offset(ic_asc, ic_desc, contact_icon_px, contact_icon_px);
    let (site_icon_top_em, site_icon_bottom_em) =
        edges(site_icon_offset, contact_icon_px, contact_icon_px);
    let strip_icon_offset = strut_offset(ic_asc, ic_desc, strong_px, strong_line_px);
    let (strip_icon_top_em, strip_icon_bottom_em) =
        edges(strip_icon_offset, strong_line_px, strong_px);
    let icon_cap_pt = px(strong_line_px);

    // clear 的 header-main 是真正的 grid（3px 行距）且 sites 有 1px 顶距；
    // legacy/compact 的 header-main 是块布局，gap 声明不生效。
    let header_row_gap_pt = if mode == "clear" { px(3.0) } else { 0.0 };
    let sites_top_gap_pt = if mode == "clear" { px(1.0) } else { 0.0 };

    // header 底边：padding-bottom + 边框作为 inset（stroke 不占布局高度）。
    let header_border_px = header_border
        .as_ref()
        .map(|border| border["sizePt"].as_f64().unwrap_or(0.0) * 4.0 / 3.0)
        .unwrap_or(0.0);
    let header_bottom_inset_pt = px(header_pad_bottom_px + header_border_px);

    // ul 圆点：直径 0.34em，文本缩进 1.15em；ol 左缩进 20px。
    let ul_marker_pt = em(0.34, fs_pt);
    let ul_indent_pt = em(1.15, fs_pt) - em(0.82, fs_pt);
    let ul_body_indent_pt = em(1.15, fs_pt) - ul_indent_pt - ul_marker_pt;
    let ol_pad_pt = px(20.0);

    let layout = serde_json::json!({
        "mode": mode,
        "bodyFont": [metrics.body_family, "Source Han Serif", "Noto Sans Hebrew"],
        "headingFont": if mode == "clear" { vec![metrics.heading_family.unwrap_or("Source Han Serif"), "Source Han Serif", "Noto Sans Hebrew"] } else { vec![metrics.body_family, "Source Han Serif", "Noto Sans Hebrew"] },
        "headingTrackingPt": if mode == "clear" { -0.01 * f64::from(pres.heading_size_pt) } else { 0.0 },
        "accent": theme,
        "paperColor": paper_color,
        "titleStrongColor": title_strong_color,
        "headStrongColor": head_strong_color,
        "contactColor": contact_color,
        "metaColor": meta_color,
        "inlineMetaColor": meta_color,
        "dateColor": if mode == "clear" { "#625952" } else { paper_color },
        "richColor": rich_color,
        "fontExtentEm": sh_asc - sh_desc,
        "textTopEm": text_top_em,
        "textBottomEm": text_bottom_em,
        "h1TopEm": h1_top_em,
        "h1BottomEm": h1_bottom_em,
        "strongTopEm": strong_top_em,
        "strongBottomEm": strong_bottom_em,
        "titleCenterPt": title_center_pt,
        "afterLineDyPt": after_line_dy_pt,
        "headTitleTopEm": head_title_top_em,
        "headTitleBottomEm": head_title_bottom_em,
        "headDatesTopEm": head_dates_top_em,
        "headDatesBottomEm": head_dates_bottom_em,
        "datesPadRightPt": px(1.0),
        "contactIconTopEm": contact_icon_top_em,
        "contactIconBottomEm": contact_icon_bottom_em,
        "siteIconTopEm": site_icon_top_em,
        "siteIconBottomEm": site_icon_bottom_em,
        "stripIconTopEm": strip_icon_top_em,
        "stripIconBottomEm": strip_icon_bottom_em,
        "iconCapPt": icon_cap_pt,
        "headerRowGapPt": header_row_gap_pt,
        "sitesTopGapPt": sites_top_gap_pt,
        "fsPt": fs_pt,
        "moduleGapPt": pres.module_gap_pt,
        "paraGapPt": pres.paragraph_gap_pt,
        "listGapPt": pres.list_gap_pt,
        "h1SizePt": h1_pt,
        "h1LineHpt": px(if mode == "legacy" { 21.0 } else { h1_px }),
        "h1MarginBottomPt": px(h1_mb_px),
        "h1TrackingPt": h1_tracking_em * h1_pt,
        "headerPadBottomPt": px(header_pad_bottom_px),
        "headerBottomInsetPt": header_bottom_inset_pt,
        "headerBorder": header_border,
        "stripContentPt": px(strip_content_px),
        "titleBottomInsetPt": title_bottom_inset_pt,
        "titleMarginBottomPt": px(title_mb_px),
        "titlePadBottomPt": px(title_pad_bottom_px),
        "titleBorder": title_border,
        "strongSizePt": px(18.0),
        "iconShown": mode != "clear",
        "iconSizePt": px(18.0),
        "iconBoxPt": px(18.0),
        "iconGapPt": px(8.0),
        "afterLinePt": 0.75,
        "bar": if mode == "clear" {
            serde_json::json!({ "widthPt": px(4.0), "heightPt": px(15.0), "gapPt": px(7.0), "skewDeg": -13, "radiusPt": 0.75 })
        } else { serde_json::Value::Null },
        "entryGapPt": px(entry_gap_px),
        "headPadBottomPt": px(head_pad_bottom_px),
        "metaMarginTopPt": px(2.0),
        "headGapRightPt": px(10.0),
        "contactIconPt": px(13.0),
        "contactIconGapPt": px(6.0),
        "contactSpanGapPt": px(13.0),
        "csdnPt": px(7.0),
        "hasAvatar": has_avatar,
        "ulMarkerPt": ul_marker_pt,
        "ulIndentPt": ul_indent_pt,
        "ulBodyIndentPt": ul_body_indent_pt,
        "olIndentPt": (ol_pad_pt - 0.85 * fs_pt).max(0.0),
        "olBodyIndentPt": 0.85 * fs_pt,
    });
    Ok(layout)
}

impl World for DocumentWorld {
    fn library(&self) -> &LazyHash<Library> {
        &self.library
    }
    fn book(&self) -> &LazyHash<FontBook> {
        &self.book
    }
    fn main(&self) -> FileId {
        self.main
    }
    fn source(&self, id: FileId) -> FileResult<Source> {
        if id == self.main {
            Ok(self.source.clone())
        } else {
            Err(FileError::NotSource)
        }
    }
    fn file(&self, id: FileId) -> FileResult<Bytes> {
        if id == self.data_id {
            Ok(self.data.clone())
        } else if id == self.main {
            Ok(Bytes::from_string(self.source.text().to_owned()))
        } else if id == self.avatar_id {
            match &self.avatar {
                Some((_, bytes)) => Ok(Bytes::new(bytes.clone())),
                None => Err(FileError::NotFound(PathBuf::from("/avatar.png"))),
            }
        } else if id == self.award_id {
            Ok(self.award_svg.clone())
        } else if id == self.file_text_id {
            Ok(self.file_text_svg.clone())
        } else {
            Err(FileError::NotFound(PathBuf::from(format!("{id:?}"))))
        }
    }
    fn font(&self, index: usize) -> Option<Font> {
        self.fonts.get(index).cloned()
    }
    // 年龄/日期渲染的参考时间冻结为固定值，避免历史快照随墙钟悄悄变化。
    fn today(&self, _offset: Option<Duration>) -> Option<Datetime> {
        Datetime::from_ymd(
            self.reference_date.0,
            self.reference_date.1,
            self.reference_date.2,
        )
    }
}

/// 编译当前文档为分页结果；编译警告按错误处理，避免静默降级。
pub fn render_paged(
    document: &ResumeDocument,
    avatar: AvatarAsset,
) -> Result<PagedDocument, EngineError> {
    render_paged_with_resources(
        document,
        avatar,
        &native_font_bytes(document)?,
        DEFAULT_REFERENCE_DATE,
    )
}

/// Compile using the immutable resource bytes and reference date frozen by the host.
pub fn render_paged_with_resources(
    document: &ResumeDocument,
    avatar: AvatarAsset,
    font_bytes: &RenderFontBytes,
    reference_date: (i32, u8, u8),
) -> Result<PagedDocument, EngineError> {
    let world = DocumentWorld::new(document, avatar, font_bytes, reference_date)?;
    let result = typst::compile::<PagedDocument>(&world);
    let paged = result
        .output
        .map_err(|errors| EngineError::Compile(format!("{errors:?}")))?;
    if !result.warnings.is_empty() {
        return Err(EngineError::Compile(format!("{:?}", result.warnings)));
    }
    if paged.pages().is_empty() {
        return Err(EngineError::Compile(
            "Compiled document has no pages".into(),
        ));
    }
    Ok(paged)
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RenderedPdf {
    pub bytes: Vec<u8>,
    pub page_count: usize,
}

/// Produce a PDF and its page count from one frozen compile.
pub fn render_document_pdf_with_resources(
    document: &ResumeDocument,
    avatar: AvatarAsset,
    font_bytes: &RenderFontBytes,
    reference_date: (i32, u8, u8),
) -> Result<RenderedPdf, EngineError> {
    let paged = render_paged_with_resources(document, avatar, font_bytes, reference_date)?;
    let page_count = paged.pages().len();
    let bytes = typst_pdf::pdf(&paged, &Default::default())
        .map_err(|errors| EngineError::Compile(format!("{errors:?}")))?;
    Ok(RenderedPdf { bytes, page_count })
}

/// 排版当前文档并输出矢量 PDF。
pub fn render_document_pdf(
    document: &ResumeDocument,
    avatar: AvatarAsset,
) -> Result<Vec<u8>, EngineError> {
    Ok(render_document_pdf_with_resources(
        document,
        avatar,
        &native_font_bytes(document)?,
        DEFAULT_REFERENCE_DATE,
    )?
    .bytes)
}

/// 逐页输出 SVG（预览与命中区域数据用）。
pub fn render_document_svg(
    document: &ResumeDocument,
    avatar: AvatarAsset,
) -> Result<Vec<String>, EngineError> {
    let paged = render_paged(document, avatar)?;
    Ok(paged
        .pages()
        .iter()
        .map(|page| typst_svg::svg(page, &Default::default()))
        .collect())
}

/// SVG pages and selectable text share the same immutable compile.
pub fn render_preview_with_resources(
    document: &ResumeDocument,
    avatar: AvatarAsset,
    font_bytes: &RenderFontBytes,
    reference_date: (i32, u8, u8),
) -> Result<zinecv_contracts::PreviewData, EngineError> {
    use sha2::{Digest, Sha256};
    let paged = render_paged_with_resources(document, avatar, font_bytes, reference_date)?;
    let text_map = text_map::text_map_from_paged(document, &paged, reference_date)?;
    let pages = paged
        .pages()
        .iter()
        .map(|page| {
            let svg = typst_svg::svg(page, &Default::default());
            zinecv_contracts::PreviewPage {
                page_hash: format!("{:x}", Sha256::digest(svg.as_bytes())),
                width_pt: page.frame.size().x.to_pt(),
                height_pt: page.frame.size().y.to_pt(),
                svg,
            }
        })
        .collect();
    Ok(zinecv_contracts::PreviewData { pages, text_map })
}

/// 渲染单页 PNG（像素对照与预览栅格用）。pixel_per_pt 控制 DPI。
pub fn render_page_png(
    document: &ResumeDocument,
    avatar: AvatarAsset,
    page_index: usize,
    pixel_per_pt: f32,
) -> Result<Vec<u8>, EngineError> {
    if !pixel_per_pt.is_finite() || !(0.1..=8.0).contains(&pixel_per_pt) {
        return Err(EngineError::Validation(
            "Raster scale must be finite and within 0.1..=8".into(),
        ));
    }
    let paged = render_paged(document, avatar)?;
    render_paged_page_png(&paged, page_index, pixel_per_pt)
}

/// Rasterize a previously compiled page without a second layout pass.
pub fn render_paged_page_png(
    paged: &PagedDocument,
    page_index: usize,
    pixel_per_pt: f32,
) -> Result<Vec<u8>, EngineError> {
    if !pixel_per_pt.is_finite() || !(0.1..=8.0).contains(&pixel_per_pt) {
        return Err(EngineError::Validation("Invalid raster scale".into()));
    }
    let page = paged
        .pages()
        .get(page_index)
        .ok_or_else(|| EngineError::Validation(format!("Page {page_index} is out of range")))?;
    let pixmap = typst_render::render(
        page,
        &typst_render::RenderOptions {
            pixel_per_pt: typst::utils::Scalar::new(pixel_per_pt as f64),
            ..Default::default()
        },
    );
    pixmap
        .encode_png()
        .map_err(|error| EngineError::Compile(format!("PNG encode failed: {error}")))
}

mod text_map;
pub use text_map::{render_text_map, TextCluster, TextMap};
pub mod export;
pub mod fit;

#[cfg(test)]
mod tests;
