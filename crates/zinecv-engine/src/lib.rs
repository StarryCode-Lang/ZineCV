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

struct ComputedEntry {
    meta: String,
    inline_meta: String,
    range: String,
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

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RenderedPdf {
    pub bytes: Vec<u8>,
    pub page_count: usize,
}

mod text_map;
pub use text_map::{render_text_map, TextCluster, TextMap};
pub mod export;
pub mod fit;

#[cfg(test)]
mod tests;

#[path = "document_source.rs"]
mod document_source;
use document_source::*;

pub use document_source::{bundled_font_bytes, native_font_bytes, template_source_bytes};
#[path = "rendering.rs"]
mod rendering;
use rendering::layout_json;
pub use rendering::{
    render_document_pdf, render_document_pdf_with_resources, render_document_svg, render_page_png,
    render_paged, render_paged_page_png, render_paged_with_resources,
    render_preview_with_resources,
};
