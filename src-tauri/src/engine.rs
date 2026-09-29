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
use std::collections::HashMap;
use std::path::PathBuf;

use serde::Serialize;
use typst::diag::{FileError, FileResult};
use typst::foundations::{Bytes, Datetime, Duration, Value};
use typst::introspection::{MetadataElem, Tag};
use typst::layout::{Frame, FrameItem, Point, Transform};
use typst::syntax::{FileId, RootedPath, Source, VirtualPath, VirtualRoot};
use typst::text::{Font, FontBook};
use typst::utils::LazyHash;
use typst::{Library, LibraryExt, World};
use typst_layout::PagedDocument;

use crate::domain::{
    DateFormat, Entry, Inline, ModuleKind, Presentation, ResumeDocument, RichBlock, Section,
    Separator, TitleFormat,
};

const FONT_REGULAR_BYTES: &[u8] =
    include_bytes!("../../public/fonts/source-han-serif-cn-regular.otf");
const FONT_HEAVY_BYTES: &[u8] = include_bytes!("../../public/fonts/source-han-serif-cn-heavy.ttf");
// 由本项目自带的 wondercv-iconfont.woff2 做纯格式转换得到（字形与字体
// 文件内容不变），Typst 的字体加载器只接受 ttf/otf。
const FONT_ICON_BYTES: &[u8] = include_bytes!("../../public/fonts/wondercv-iconfont.ttf");

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

/// 一次渲染需要的头像资源；缺席时保留 64×88px 布局占位
/// （与旧 DOM 的 `.preview-avatar-slot.empty` 一致）。
pub type AvatarAsset = Option<(String, Vec<u8>)>;

/// 数据驱动模板：三个内置模板共用一个结构，按 layout.mode 分支版式差异。
///
/// TextMap（正式文本层）约定：
/// - 每个可选中文本叶子前放置 `metadata("node:<稳定节点ID>")` 标记；
///   节点 ID 由稳定领域 ID 派生（basic:name / basic:c<i> / basic:s<i> /
///   basic:site<i> / section:<id>:head / entry:<id>:title|:imeta|:meta|:dates /
///   entry|section:<id>:b<i>[:i<j>:b<k>…]:l<n>）。
/// - 装饰性文字（图标字形、CSDN 字样、有序列表编号）前放置
///   `metadata("node:!deco")`，提取层跳过，不进入可选文本。
/// - 日期/元数据/站点标签等渲染字符串全部由 Rust 侧预计算
///   （payload.computed / payload.contact），模板只做纯渲染，
///   保证 Rust 能逐字重建纸面文本。
const TEMPLATE_SRC: &str = r##"
#let payload = json("resume.json")
#let doc = payload.document
#let pres = doc.presentation
#let L = payload.layout
#let C = payload.contact
#let CM = payload.computed

#let mark(id) = metadata("node:" + id)
#let deco() = metadata("node:!deco")

#let markText(body, marks) = {
  let out = body
  for m in marks {
    if m == "bold" { out = strong(out) }
    else if m == "italic" { out = emph(out) }
    else if m == "underline" { out = underline(out) }
    else if m == "strike" { out = strike(out) }
  }
  out
}

// 把段落/链接子节点展平为带序号的文本叶子序列（break 占一个序号）。
#let flattenInlines(children, href) = {
  let leaves = ()
  for node in children {
    if node.type == "text" {
      leaves.push((text: node.text, marks: node.at("marks", default: ()), href: href))
    } else if node.type == "link" {
      leaves += flattenInlines(node.children, node.href)
    } else {
      leaves.push((brk: true, text: none, marks: (), href: none))
    }
  }
  leaves
}

#let renderInlineList(children, path) = {
  let leaves = flattenInlines(children, none)
  let out = none
  for (li, leaf) in leaves.enumerate() {
    let piece = if leaf.at("brk", default: false) {
      linebreak()
    } else {
      let body = mark(path + ":l" + str(li)) + markText(leaf.text, leaf.marks)
      if leaf.href != none { link(leaf.href, body) } else { body }
    }
    out = if out == none { piece } else { out + piece }
  }
  if out == none { [ ] } else { out }
}

// 列表块：有序/无序条目间距使用 --template-list-spacing。
// 有序编号是引擎合成文字，用 deco 括住（前后各一），不进入可选文本
// ——与旧 DOM 中 CSS marker 不可选中的行为一致。
#let renderListBlock(block, path) = {
  let items = ()
  for (ii, item) in block.items.enumerate() {
    let rendered = none
    for (bi2, inner) in item.enumerate() {
      let ipath = path + ":i" + str(ii) + ":b" + str(bi2)
      let piece = if inner.type == "paragraph" { renderInlineList(inner.children, ipath) } else { renderListBlock(inner, ipath) }
      rendered = if rendered == none { piece } else { rendered + piece }
    }
    let content = if rendered == none { [ ] } else { rendered }
    items += (content + deco(),)
  }
  deco()
  if block.ordered {
    enum(indent: L.olIndentPt * 1pt, body-indent: L.olBodyIndentPt * 1pt, tight: false, spacing: L.listGapPt * 1pt, ..items)
  } else {
    let dot = circle(fill: rgb("#000000"), radius: (L.ulMarkerPt * 0.5) * 1pt)
    list(indent: L.ulIndentPt * 1pt, body-indent: L.ulBodyIndentPt * 1pt, tight: false, spacing: L.listGapPt * 1pt, marker: dot, ..items)
  }
}

// 富文本块序列：相邻块之间使用 --template-paragraph-spacing。
#let renderBlocks(blocks, path) = {
  let first = true
  for (bi, block) in blocks.enumerate() {
    if not first { v(L.paraGapPt * 1pt) }
    first = false
    if block.type == "paragraph" {
      set par(justify: pres.textAlign == "两端对齐")
      renderInlineList(block.children, path + ":b" + str(bi))
    } else if block.type == "list" {
      set par(justify: pres.textAlign == "两端对齐")
      renderListBlock(block, path + ":b" + str(bi))
    }
  }
}

// 单行元素盒：固定高度 + 垂直居中重现 CSS line-box 的半行距溢出对称。
#let lineBox(boxH, body) = {
  block(height: boxH * 1pt, breakable: false)[#align(center)[#body]]
}

#let contactIcon(glyph) = {
  text(font: "iconfont", size: L.contactIconPt * 1pt)[#glyph]
}

// 联系栏：图标与文字间 6px；span 间 13px（末项无尾距）。
// 图标字形为装饰文字（deco），联系值为可选叶子（basic:c<i>/basic:s<i>）。
#let contactLine(items, prefix) = {
  block(breakable: false)[
    #for (index, item) in items.enumerate() {
      if item.glyph != none { box[#deco()#contactIcon(item.glyph) #h(L.contactIconGapPt * 1pt)] }
      mark(prefix + str(index))
      text(fill: rgb(L.contactColor), size: L.fsPt * 1pt)[#item.value]
      if index < items.len() - 1 { h(L.contactSpanGapPt * 1pt) }
    }
  ]
}

#let siteCell(site, index) = {
  let shown = if site.url.starts-with("http") { site.url } else { "https://" + site.url }
  let domain = lower(shown)
  let logo = if domain.contains("github.com") {
    deco() + contactIcon("\u{e6fe}")
  } else if domain.contains("csdn.net") {
    deco() + text(font: "Source Han Serif", size: L.csdnPt * 1pt, weight: 700, tracking: -0.4125pt)[CSDN]
  } else {
    deco() + contactIcon("\u{e75c}")
  }
  // CSS 语义：logo 13px + 6px 间距 + 文本 nowrap/ellipsis；Typst 无省略号，
  // 以列宽内 clip 近似（1fr 列自适应，不截短实际内容）。
  grid(columns: (auto, L.contactIconGapPt * 1pt, 1fr),
    box[#logo],
    [],
    box(width: 100%, clip: true)[#mark("basic:site" + str(index))#text(fill: rgb(L.contactColor), size: L.fsPt * 1pt)[#site.label]]
  )
}

// 节标题：图标（iconfont 或 lucide SVG）+ strong + 基线延展线 + 模板差异。
#let sectionIcon(kind) = {
  if kind == "awards" {
    image("/award.svg", width: 11.25pt, height: 11.25pt, fit: "contain")
  } else if kind == "education" {
    text(font: "iconfont", size: L.iconSizePt * 1pt)[#"\u{e76f}"]
  } else if kind == "skills" {
    text(font: "iconfont", size: L.iconSizePt * 1pt)[#"\u{e76b}"]
  } else if kind == "work" {
    text(font: "iconfont", size: L.iconSizePt * 1pt)[#"\u{e76d}"]
  } else if kind == "projects" {
    text(font: "iconfont", size: L.iconSizePt * 1pt)[#"\u{e774}"]
  } else if kind == "orgs" {
    text(font: "iconfont", size: L.iconSizePt * 1pt)[#"\u{e772}"]
  } else if kind == "summary" {
    text(font: "iconfont", size: L.iconSizePt * 1pt)[#"\u{e770}"]
  } else {
    image("/file-text.svg", width: 11.25pt, height: 11.25pt, fit: "contain")
  }
}

#let afterLine = rect(width: 100%, height: L.afterLinePt * 1pt, fill: rgb("#000000"))

#let sectionHead(section) = {
  let titleCell = box[#mark("section:" + section.id + ":head")#text(fill: rgb(L.titleStrongColor), size: L.strongSizePt * 1pt)[#strong(section.title)]]
  let lineCell = align(center)[#afterLine]
  block(below: L.titleMarginBottomPt * 1pt, breakable: false,
        stroke: if L.titleBorder != none { (bottom: L.titleBorder.sizePt * 1pt + rgb(L.titleBorder.color)) },
        inset: if L.titleBorder != none { (bottom: L.titlePadBottomPt * 1pt) } else { 0pt })[
    #lineBox(L.stripHpt)[
      #if L.bar != none {
        grid(
          columns: (L.bar.widthPt * 1pt, L.bar.gapPt * 1pt, auto, L.iconGapPt * 1pt, 1fr),
          align(top)[#skew(ax: L.bar.skewDeg * 1deg)[#rect(width: L.bar.widthPt * 1pt, height: L.bar.heightPt * 1pt, radius: L.bar.radiusPt * 1pt, fill: rgb(L.accent))]],
          [],
          titleCell,
          [],
          lineCell,
        )
      } else if L.iconShown {
        grid(
          columns: (L.iconBoxPt * 1pt, L.iconGapPt * 1pt, auto, L.iconGapPt * 1pt, 1fr),
          align(center)[#deco()#sectionIcon(section.kind)],
          [],
          titleCell,
          [],
          lineCell,
        )
      } else {
        grid(
          columns: (auto, L.iconGapPt * 1pt, 1fr),
          titleCell,
          [],
          lineCell,
        )
      }
    ]
  ]
}

// 条目头：单行（左 strong+inline 元数据 / 右日期）或双行（标题、日期、元数据三行）。
// 元数据/日期文案由 Rust 预计算（comp.meta / comp.inlineMeta / comp.range）。
#let entryHead(entry, comp) = {
  block(below: L.headPadBottomPt * 1pt, breakable: false)[
    #if pres.titleFormat == "单行标题" {
      grid(columns: (1fr, auto), column-gutter: L.headGapRightPt * 1pt,
        box[#mark("entry:" + entry.id + ":title")#text(fill: rgb(L.headStrongColor), size: L.fsPt * 1pt)[#strong(entry.title)#deco()#text(" ")#mark("entry:" + entry.id + ":imeta")#text(fill: rgb(L.inlineMetaColor), size: L.fsPt * 1pt)[#comp.inlineMeta]]],
        box(clip: true)[#mark("entry:" + entry.id + ":dates")#text(fill: rgb(L.dateColor), size: L.fsPt * 1pt)[#comp.range]]
      )
    } else {
      grid(columns: (1fr, auto), column-gutter: 0.75pt,
        box[#mark("entry:" + entry.id + ":title")#text(fill: rgb(L.headStrongColor), size: L.fsPt * 1pt)[#strong(entry.title)]],
        box(clip: true)[#mark("entry:" + entry.id + ":dates")#text(fill: rgb(L.dateColor), size: L.fsPt * 1pt)[#comp.range]]
      )
    }
    #if pres.titleFormat == "双行标题" and comp.meta != "" {
      block(above: L.metaMarginTopPt * 1pt, breakable: false)[#mark("entry:" + entry.id + ":meta")#text(fill: rgb(L.metaColor), size: L.fsPt * 1pt)[#comp.meta]]
    }
  ]
}

#let renderEntry(kind, entry, comp, first) = {
  block(above: if first { 0pt } else { L.entryGapPt * 1pt }, breakable: false)[
    #if kind == "education" {
      entryHead(entry, comp)
      block(above: L.paraGapPt * 1pt, breakable: false)[#renderBlocks(entry.body, "entry:" + entry.id)]
    } else {
      let hasHead = entry.start != "" or entry.end != "" or comp.meta != ""
      if hasHead {
        entryHead(entry, comp)
        block(above: L.paraGapPt * 1pt, breakable: false)[#renderBlocks(entry.body, "entry:" + entry.id)]
      } else if entry.title != "" {
        // 无头信息条目：标题进入正文首行（技能条目等）。
        mark("entry:" + entry.id + ":title")
        text(fill: rgb(L.headStrongColor), size: L.fsPt * 1pt)[#strong(entry.title)]
        v(L.paraGapPt * 1pt)
        renderBlocks(entry.body, "entry:" + entry.id)
      } else {
        block(above: L.paraGapPt * 1pt, breakable: false)[#renderBlocks(entry.body, "entry:" + entry.id)]
      }
    }
  ]
}

#let sectionBody(section, comp) = {
  if section.kind == "summary" {
    block(above: L.paraGapPt * 1pt, breakable: false)[#renderBlocks(section.body, "section:" + section.id)]
  } else {
    let first = true
    for (ei, entry) in section.entries.enumerate() {
      renderEntry(section.kind, entry, comp.entries.at(ei), first)
      first = false
    }
  }
}

// 页面与正文基础排版。行盒用 text(top/bottom-edge) 表达（见 layout_json 注释）。
#set page(width: 210mm, height: 297mm, margin: (top: pres.pageMarginPt * 1pt, right: pres.pageMarginPt * 1pt, bottom: pres.pageMarginPt * 1pt, left: pres.pageMarginPt * 1pt))
#set text(font: "Source Han Serif", size: L.fsPt * 1pt, fill: rgb(L.paperColor), lang: "zh", region: "cn", top-edge: L.textTopEm * 1em, bottom-edge: L.textBottomEm * 1em)
#set par(leading: 0pt, spacing: 0pt, first-line-indent: 0pt)

// 头部：左主信息 + 右头像占位（头像缺席仍保留 64×88px 布局位）。
#grid(
  columns: (1fr, 48pt),
  column-gutter: 12pt,
  block[
    #lineBox(L.h1LineHpt)[
      #mark("basic:name")#text(fill: rgb("#000000"), size: L.h1SizePt * 1pt, tracking: L.h1TrackingPt * 1pt)[#strong(doc.basic.name)]
    ]
    #block(above: L.h1MarginBottomPt * 1pt)[]
    #if C.primary.len() > 0 { contactLine(C.primary, "basic:c") }
    #if C.secondary.len() > 0 { contactLine(C.secondary, "basic:s") }
    #if C.sites.len() > 0 {
      grid(columns: (1fr, 1fr), column-gutter: 12pt, row-gutter: 12pt,
        ..C.sites.enumerate().map(((i, site)) => siteCell(site, i))
      )
    }
  ],
  box(width: 48pt, height: 66pt, radius: 2.25pt, clip: true, outset: 0pt)[
    #if L.hasAvatar {
      image("/avatar.png", width: 48pt, height: 66pt, fit: "cover")
    }
  ]
)
#block(
  above: 0pt,
  below: L.moduleGapPt * 1pt,
  outset: 0pt,
  inset: (bottom: L.headerPadBottomPt * 1pt),
  stroke: if L.headerBorder != none { (bottom: L.headerBorder.sizePt * 1pt + rgb(L.headerBorder.color)) },
  breakable: false,
)[]

#let shown = 0
#for (si, section) in doc.sections.enumerate() {
  if section.visible {
    if shown > 0 { block(above: L.moduleGapPt * 1pt, breakable: false)[] }
    shown += 1
    block(breakable: false)[
      #sectionHead(section)
      #sectionBody(section, CM.sections.at(si))
    ]
  }
}
"##;

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
fn age_years(birth: &str, reference: (i32, u32, u32)) -> Option<u32> {
    let mut parts = birth.splitn(2, '-');
    let year: i32 = parts.next()?.parse().ok()?;
    let month: u32 = parts.next()?.parse().ok()?;
    Some((reference.0 - year - (reference.1 < month) as i32).max(0) as u32)
}

impl DocumentWorld {
    fn new(document: &ResumeDocument, avatar: AvatarAsset) -> Result<Self, EngineError> {
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
        let mut book = FontBook::new();
        let mut fonts = Vec::new();
        for bytes in [FONT_REGULAR_BYTES, FONT_HEAVY_BYTES, FONT_ICON_BYTES] {
            for font in Font::iter(Bytes::new(bytes.to_vec())) {
                book.push(font.info().clone());
                fonts.push(font);
            }
        }
        if fonts.is_empty() {
            return Err(EngineError::Validation(
                "Bundled fonts were rejected by Typst".into(),
            ));
        }
        // 字体竖向度量（em）：CSS line-height 换算的核心参数。
        // 直接从 regular 字体文件解析（typographic 度量优先），
        // 不按 family 名匹配——不同来源的 name 表存在本地化差异。
        let (ascender_em, descender_em) = ttf_parser::Face::parse(FONT_REGULAR_BYTES, 0)
            .ok()
            .map(|face| {
                let metrics = typst::text::FontMetrics::from_ttf(&face);
                (metrics.ascender.get(), metrics.descender.get())
            })
            .ok_or_else(|| EngineError::Validation("body font metrics missing".into()))?;

        let mode = template_mode(&document.presentation.template_id);
        let layout = layout_json(
            document,
            &theme,
            mode,
            (ascender_em, descender_em),
            avatar.is_some(),
        )?;
        let contact = contact_json(&contact_layout(document));
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
        })
    }
}

/// 头部联系信息的预计算结构：过滤空值、解析年龄文案与站点标签，
/// 模板层只做纯渲染（无 null 分支）。同一结构也是 TextMap 逻辑
/// 文本的唯一事实源，保证 Rust 能逐字重建纸面内容。
struct ContactItem {
    glyph: Option<String>,
    value: String,
}

struct SiteItem {
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

fn contact_layout(document: &ResumeDocument) -> ContactLayout {
    let basic = &document.basic;
    let entry = |glyph: Option<&str>, value: &str| {
        if value.is_empty() {
            None
        } else {
            Some(ContactItem {
                glyph: glyph.map(str::to_owned),
                value: value.to_owned(),
            })
        }
    };
    let primary: Vec<_> = [
        entry(Some("\u{e75b}"), &basic.phone),
        entry(Some("\u{e74a}"), &basic.email),
        entry(Some("\u{e73e}"), &basic.wechat),
    ]
    .into_iter()
    .flatten()
    .collect();

    let mut secondary: Vec<ContactItem> = Vec::new();
    if !basic.birth.is_empty() {
        let label = if basic.age_mode == crate::domain::AgeMode::Age {
            let years = age_years(&basic.birth, (2026, 9, 28)).unwrap_or(0);
            format!("{years}岁")
        } else {
            format!("{} 出生", basic.birth)
        };
        secondary.push(ContactItem {
            glyph: Some("\u{e75e}".into()),
            value: label,
        });
    }
    if !basic.city.is_empty() {
        secondary.push(ContactItem {
            glyph: Some("\u{e732}".into()),
            value: basic.city.clone(),
        });
    }
    let optional = [
        &basic.gender,
        &basic.height,
        &basic.weight,
        &basic.ethnicity,
        &basic.birthplace,
        &basic.political_status,
        &basic.marital_status,
        &basic.zodiac,
        &basic.mbti,
    ];
    for value in optional.iter().filter_map(|value| value.as_deref()) {
        if let Some(item) = entry(None, value) {
            secondary.push(item);
        }
    }

    let sites: Vec<SiteItem> = [&basic.website, &basic.linkedin]
        .into_iter()
        .filter_map(|value| value.as_deref())
        .filter(|value| !value.is_empty())
        .map(|url| SiteItem {
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
    let item =
        |entry: &ContactItem| serde_json::json!({ "glyph": entry.glyph, "value": entry.value });
    let primary: Vec<_> = contact.primary.iter().map(item).collect();
    let secondary: Vec<_> = contact.secondary.iter().map(item).collect();
    let sites: Vec<_> = contact
        .sites
        .iter()
        .map(|site| serde_json::json!({ "url": site.url, "label": site.label }))
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
/// px → pt 固定 ×0.75；em 相对量按正文字号解析。
///
/// 行盒：CSS line-height 语义用 text(top-edge/bottom-edge) 的 em 相对量表达
/// （半行距上下对称溢出），leading 归零。不能用负 leading 表达
/// （lineHeight < 字体竖向度量时）——负 leading 会让 Typst 整篇只出一页
/// （B07 实测定位，见 typst_poc 的 pagination_structure_variants 证据）。
fn layout_json(
    document: &ResumeDocument,
    theme: &str,
    mode: &str,
    (ascender_em, descender_em): (f64, f64),
    has_avatar: bool,
) -> Result<serde_json::Value, EngineError> {
    let pres = &document.presentation;
    let px = |v: f64| v * 0.75;
    let fs_pt = pres.font_size_pt as f64;
    let lh_pt = pres.line_height_pt as f64;
    let em = |factor: f64, base_pt: f64| factor * base_pt;

    // CSS 半行距居中：line box = lh，基线位于 (lh + asc − desc)/2。
    // 以 em 表达，随各元素字号缩放（h1/节标题/正文共用同一相对量）。
    let lh_em = lh_pt / fs_pt;
    let text_top_em = (lh_em + ascender_em - descender_em) / 2.0;
    let text_bottom_em = (lh_em - ascender_em + descender_em) / 2.0;

    let (paper_color, title_strong_color, head_strong_color, contact_color, meta_color, rich_color) =
        match mode {
            "clear" => (
                "#28221e", "#251f1b", "#302923", "#504842", "#625952", "#37302b",
            ),
            "compact" => (
                "#252525", "#252525", "#252525", "#252525", "#252525", "#252525",
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

    // ul 圆点：直径 0.34em，文本缩进 1.15em；ol 左缩进 20px。
    let ul_marker_pt = em(0.34, fs_pt);
    let ul_indent_pt = em(1.15, fs_pt) - em(0.82, fs_pt);
    let ul_body_indent_pt = em(1.15, fs_pt) - ul_indent_pt - ul_marker_pt;
    let ol_pad_pt = px(20.0);

    let layout = serde_json::json!({
        "mode": mode,
        "accent": theme,
        "paperColor": paper_color,
        "titleStrongColor": title_strong_color,
        "headStrongColor": head_strong_color,
        "contactColor": contact_color,
        "metaColor": meta_color,
        "inlineMetaColor": meta_color,
        "dateColor": if mode == "clear" { "#625952" } else { paper_color },
        "richColor": rich_color,
        "fontExtentEm": ascender_em - descender_em,
        "textTopEm": text_top_em,
        "textBottomEm": text_bottom_em,
        "fsPt": fs_pt,
        "moduleGapPt": pres.module_gap_pt,
        "paraGapPt": pres.paragraph_gap_pt,
        "listGapPt": pres.list_gap_pt,
        "h1SizePt": h1_pt,
        "h1LineHpt": px(if mode == "legacy" { 21.0 } else { h1_px }),
        "h1MarginBottomPt": px(h1_mb_px),
        "h1TrackingPt": h1_tracking_em * h1_pt,
        "headerPadBottomPt": px(header_pad_bottom_px),
        "headerBorder": header_border,
        "stripHpt": px(strip_px),
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
        Datetime::from_ymd(2026, 9, 28)
    }
}

/// 编译当前文档为分页结果；编译警告按错误处理，避免静默降级。
pub fn render_paged(
    document: &ResumeDocument,
    avatar: AvatarAsset,
) -> Result<PagedDocument, EngineError> {
    let world = DocumentWorld::new(document, avatar)?;
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

/// 排版当前文档并输出矢量 PDF。
pub fn render_document_pdf(
    document: &ResumeDocument,
    avatar: AvatarAsset,
) -> Result<Vec<u8>, EngineError> {
    let paged = render_paged(document, avatar)?;
    typst_pdf::pdf(&paged, &Default::default())
        .map_err(|errors| EngineError::Compile(format!("{errors:?}")))
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

/// 渲染单页 PNG（像素对照与预览栅格用）。pixel_per_pt 控制 DPI。
pub fn render_page_png(
    document: &ResumeDocument,
    avatar: AvatarAsset,
    page_index: usize,
    pixel_per_pt: f32,
) -> Result<Vec<u8>, EngineError> {
    let paged = render_paged(document, avatar)?;
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

// ---------------------------------------------------------------------------
// 正式 TextMap（开发计划 §4；F15 选字/命中层的引擎侧基础）
// ---------------------------------------------------------------------------
//
// 结构：logicalText 按语义阅读顺序（文档模型顺序）拼接全部可选中文本叶子；
// clusters 是从编译后 frame 提取的字形簇矩形，startUtf16/endUtf16 指回
// logicalText 的 UTF-16 区间。每个簇在构建时强制回切校验
// （叶子文本在 sourceByteOffset 处的子串必须等于簇文本），校验失败即错误，
// 不输出静默降级的文本层。跨页叶子自然拆成同节点 ID 的多个簇。
//
// 矩形语义：水平方向取簇的光标推进区间（精确），竖直方向取所在文本 run
// 的 bbox 上下界（run 内一致）；连字/组合字符按 shaping cluster 合并。
// 装饰文字（图标字形、CSDN 字样、有序列表编号）由模板 !deco 标记排除，
// 与旧 DOM 中 CSS marker 不可选中的行为一致。

/// TextMap 协议版本 1 的字形簇。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TextCluster {
    pub source_node_id: String,
    pub start_utf16: u32,
    pub end_utf16: u32,
    pub logical_order: u32,
    pub page: u32,
    pub x_pt: f64,
    pub y_pt: f64,
    pub width_pt: f64,
    pub height_pt: f64,
}

/// 正式 TextMap：逻辑文本 + 全部字形簇（按 logicalOrder 即阅读顺序排序）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TextMap {
    pub version: u8,
    pub logical_text: String,
    pub clusters: Vec<TextCluster>,
}

/// 逻辑文本叶子项：文本叶子或软换行。
enum LeafItem {
    Text { node_id: String, text: String },
    Break,
}

impl LeafItem {
    fn text(node_id: String, text: &str) -> Self {
        Self::Text {
            node_id,
            text: text.to_owned(),
        }
    }
}

/// 与模板 flattenInlines 镜像：link 子节点并入同一叶子序号序列。
fn flatten_inlines(children: &[Inline], path: &str, out: &mut Vec<LeafItem>) {
    let mut leaf_index = 0usize;
    flatten_inlines_into(children, path, &mut leaf_index, out);
}

fn flatten_inlines_into(
    children: &[Inline],
    path: &str,
    leaf_index: &mut usize,
    out: &mut Vec<LeafItem>,
) {
    for node in children {
        match node {
            Inline::Text { text, .. } => {
                out.push(LeafItem::text(format!("{path}:l{leaf_index}"), text));
                *leaf_index += 1;
            }
            Inline::Link { children, .. } => {
                flatten_inlines_into(children, path, leaf_index, out);
            }
            Inline::Break => {
                out.push(LeafItem::Break);
                *leaf_index += 1;
            }
        }
    }
}

/// 与模板 renderListBlock 镜像的列表遍历。
fn walk_list(items: &[Vec<RichBlock>], path: &str, out: &mut Vec<LeafItem>) {
    for (item_index, item) in items.iter().enumerate() {
        for (block_index, inner) in item.iter().enumerate() {
            let inner_path = format!("{path}:i{item_index}:b{block_index}");
            match inner {
                RichBlock::Paragraph { children } => flatten_inlines(children, &inner_path, out),
                RichBlock::List { items: nested, .. } => walk_list(nested, &inner_path, out),
            }
        }
    }
}

/// 与模板 renderBlocks 镜像的块遍历。
fn walk_blocks(blocks: &[RichBlock], path: &str, out: &mut Vec<LeafItem>) {
    for (block_index, block) in blocks.iter().enumerate() {
        let block_path = format!("{path}:b{block_index}");
        match block {
            RichBlock::Paragraph { children } => flatten_inlines(children, &block_path, out),
            RichBlock::List { items, .. } => walk_list(items, &block_path, out),
        }
    }
}

/// 按语义阅读顺序收集文档全部可选中叶子（隐藏节不渲染、不进入序列）。
/// 顺序与模板渲染顺序严格一致：姓名 → 联系主行 → 次行 → 站点 →
/// 各可见节（节标题 → 各条目头 → 正文块）。
fn logical_leaf_items(document: &ResumeDocument) -> Vec<LeafItem> {
    let mut out = Vec::new();
    let basic = &document.basic;
    out.push(LeafItem::text("basic:name".into(), &basic.name));
    let contact = contact_layout(document);
    for (index, item) in contact.primary.iter().enumerate() {
        out.push(LeafItem::text(format!("basic:c{index}"), &item.value));
    }
    for (index, item) in contact.secondary.iter().enumerate() {
        out.push(LeafItem::text(format!("basic:s{index}"), &item.value));
    }
    for (index, site) in contact.sites.iter().enumerate() {
        out.push(LeafItem::text(format!("basic:site{index}"), &site.label));
    }
    for section in &document.sections {
        match section {
            Section::Entry(section) => {
                if !section.visible {
                    continue;
                }
                out.push(LeafItem::text(
                    format!("section:{}:head", section.id),
                    &section.title,
                ));
                for entry in &section.entries {
                    let computed = computed_entry(&section.kind, entry, &document.presentation);
                    let prefix = format!("entry:{}", entry.id);
                    // 与渲染视觉顺序一致：单行为 标题/内联元数据/日期；
                    // 双行为 标题/日期（首行）→ 元数据（次行）。
                    match document.presentation.title_format {
                        TitleFormat::SingleLine => {
                            out.push(LeafItem::text(format!("{prefix}:title"), &entry.title));
                            out.push(LeafItem::text(
                                format!("{prefix}:imeta"),
                                &computed.inline_meta,
                            ));
                            out.push(LeafItem::text(format!("{prefix}:dates"), &computed.range));
                        }
                        TitleFormat::DoubleLine => {
                            out.push(LeafItem::text(format!("{prefix}:title"), &entry.title));
                            out.push(LeafItem::text(format!("{prefix}:dates"), &computed.range));
                            out.push(LeafItem::text(format!("{prefix}:meta"), &computed.meta));
                        }
                    }
                    walk_blocks(&entry.body, &prefix, &mut out);
                }
            }
            Section::Summary(section) => {
                if !section.visible {
                    continue;
                }
                out.push(LeafItem::text(
                    format!("section:{}:head", section.id),
                    &section.title,
                ));
                walk_blocks(&section.body, &format!("section:{}", section.id), &mut out);
            }
        }
    }
    out
}

/// 拼接 logicalText 并记录每个非空文本叶子的 UTF-16 基址。
/// 规则：相邻两个文本叶子之间恰好一个 "\n"；软换行本身占一个 "\n"
/// （连续软换行保留空行语义）。空文本叶子不产生节点也不占位。
fn assemble_logical(items: &[LeafItem]) -> (String, HashMap<String, (String, usize)>) {
    let mut logical = String::new();
    let mut prev_text = false;
    let mut leaves: HashMap<String, (String, usize)> = HashMap::new();
    for item in items {
        match item {
            LeafItem::Break => {
                logical.push('\n');
                prev_text = false;
            }
            LeafItem::Text { node_id, text } => {
                if text.is_empty() {
                    continue;
                }
                if prev_text {
                    logical.push('\n');
                }
                let base = logical.encode_utf16().count();
                leaves.insert(node_id.clone(), (text.clone(), base));
                logical.push_str(text);
                prev_text = true;
            }
        }
    }
    (logical, leaves)
}

/// 从 frame 提取的原始簇（尚未映射到 logicalText）。
struct RawCluster {
    node_id: String,
    text: String,
    byte_offset: usize,
    page: u32,
    x_pt: f64,
    y_pt: f64,
    width_pt: f64,
    height_pt: f64,
}

/// frame 遍历中的标记状态：未标记（模板缺陷，报错）、装饰（跳过）、
/// 叶子节点（收集簇）。
#[derive(Clone)]
enum MarkerState {
    Unmarked,
    Decorative,
    Node(String),
}

fn collect_clusters(
    frame: &Frame,
    parent: Transform,
    current: &mut MarkerState,
    page: u32,
    out: &mut Vec<RawCluster>,
    problems: &mut Vec<String>,
) {
    for (position, item) in frame.items() {
        match item {
            FrameItem::Group(group) => {
                let transform = parent
                    .pre_concat(Transform::translate(position.x, position.y))
                    .pre_concat(group.transform);
                collect_clusters(&group.frame, transform, current, page, out, problems);
            }
            FrameItem::Tag(Tag::Start(content, _)) => {
                if let Some(metadata) = content.to_packed::<MetadataElem>() {
                    if let Value::Str(value) = &metadata.value {
                        if let Some(id) = value.as_str().strip_prefix("node:") {
                            *current = if id == "!deco" {
                                MarkerState::Decorative
                            } else {
                                MarkerState::Node(id.to_owned())
                            };
                        }
                    }
                }
            }
            FrameItem::Text(text) => {
                let node_id = match current {
                    MarkerState::Node(id) => id.clone(),
                    MarkerState::Decorative => continue,
                    MarkerState::Unmarked => {
                        problems.push(format!(
                            "unmarked text run on page {page}: {:?}",
                            text.text.as_str().chars().take(24).collect::<String>()
                        ));
                        continue;
                    }
                };
                let bbox = text.bbox();
                let top = bbox.min.y.min(bbox.max.y);
                let bottom = bbox.min.y.max(bbox.max.y);
                let mut cursor = Point::zero();
                for glyph in &text.glyphs {
                    let range = glyph.range();
                    if let Some(logical) = text.text.get(range.clone()) {
                        let start_cursor = cursor;
                        cursor.x += glyph.x_advance.at(text.size);
                        cursor.y -= glyph.y_advance.at(text.size);
                        let x0 = start_cursor.x.min(cursor.x);
                        let x1 = start_cursor.x.max(cursor.x);
                        let corners = [
                            Point::new(position.x + x0, position.y + start_cursor.y + top),
                            Point::new(position.x + x1, position.y + start_cursor.y + top),
                            Point::new(position.x + x0, position.y + start_cursor.y + bottom),
                            Point::new(position.x + x1, position.y + start_cursor.y + bottom),
                        ];
                        let mut min_x = f64::INFINITY;
                        let mut min_y = f64::INFINITY;
                        let mut max_x = f64::NEG_INFINITY;
                        let mut max_y = f64::NEG_INFINITY;
                        for corner in corners {
                            let point = corner.transform(parent);
                            min_x = min_x.min(point.x.to_pt());
                            min_y = min_y.min(point.y.to_pt());
                            max_x = max_x.max(point.x.to_pt());
                            max_y = max_y.max(point.y.to_pt());
                        }
                        out.push(RawCluster {
                            node_id: node_id.clone(),
                            text: logical.to_owned(),
                            byte_offset: glyph.span.1 as usize,
                            page,
                            x_pt: min_x,
                            y_pt: min_y,
                            width_pt: max_x - min_x,
                            height_pt: max_y - min_y,
                        });
                    }
                }
            }
            _ => {}
        }
    }
}

/// 原始簇 → 正式 TextMap：逐簇回切校验后映射 UTF-16 区间并按阅读顺序编号。
fn build_text_map(items: &[LeafItem], raw: Vec<RawCluster>) -> Result<TextMap, EngineError> {
    let (logical_text, leaves) = assemble_logical(items);
    let mut clusters = Vec::with_capacity(raw.len());
    for cluster in raw {
        let Some((leaf_text, base)) = leaves.get(&cluster.node_id) else {
            return Err(EngineError::TextMap(format!(
                "cluster references unknown node {}",
                cluster.node_id
            )));
        };
        let end_byte = cluster.byte_offset + cluster.text.len();
        if leaf_text.get(cluster.byte_offset..end_byte) != Some(cluster.text.as_str()) {
            return Err(EngineError::TextMap(format!(
                "cluster text mismatch on node {} at byte {}",
                cluster.node_id, cluster.byte_offset
            )));
        }
        let start = base + leaf_text[..cluster.byte_offset].encode_utf16().count();
        let end = start + cluster.text.encode_utf16().count();
        clusters.push(TextCluster {
            source_node_id: cluster.node_id,
            start_utf16: start as u32,
            end_utf16: end as u32,
            logical_order: 0,
            page: cluster.page,
            x_pt: cluster.x_pt,
            y_pt: cluster.y_pt,
            width_pt: cluster.width_pt,
            height_pt: cluster.height_pt,
        });
    }
    clusters.sort_by_key(|cluster| cluster.start_utf16);
    for (order, cluster) in clusters.iter_mut().enumerate() {
        cluster.logical_order = order as u32;
    }
    Ok(TextMap {
        version: 1,
        logical_text,
        clusters,
    })
}

/// 编译当前文档并提取正式 TextMap（F15 选字/命中层数据基础）。
/// 任何标记缺失或簇校验失败都返回错误，不输出降级文本层。
pub fn render_text_map(
    document: &ResumeDocument,
    avatar: AvatarAsset,
) -> Result<TextMap, EngineError> {
    let paged = render_paged(document, avatar)?;
    let items = logical_leaf_items(document);
    let mut raw = Vec::new();
    let mut current = MarkerState::Unmarked;
    let mut problems = Vec::new();
    for (index, page) in paged.pages().iter().enumerate() {
        collect_clusters(
            &page.frame,
            Transform::identity(),
            &mut current,
            index as u32 + 1,
            &mut raw,
            &mut problems,
        );
    }
    if !problems.is_empty() {
        return Err(EngineError::TextMap(problems.join("; ")));
    }
    build_text_map(&items, raw)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::Presentation;

    // 1×1 红色 PNG，作为测试头像资源。
    const AVATAR_PNG: &[u8] = &[
        0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x0D, 0x49, 0x48, 0x44,
        0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x02, 0x00, 0x00, 0x00, 0x90,
        0x77, 0x53, 0xDE, 0x00, 0x00, 0x00, 0x0C, 0x49, 0x44, 0x41, 0x54, 0x08, 0xD7, 0x63, 0xF8,
        0xCF, 0xC0, 0x00, 0x00, 0x03, 0x01, 0x01, 0x00, 0x18, 0xDD, 0x8D, 0xB0, 0x00, 0x00, 0x00,
        0x00, 0x49, 0x45, 0x4E, 0x44, 0xAE, 0x42, 0x60, 0x82,
    ];

    fn sample_document() -> ResumeDocument {
        let json = serde_json::json!({
          "schemaVersion":2,
          "documentId":"doc-engine",
          "title":"引擎测试",
          "basic":{"name":"张三","phone":"138-0000-0000","email":"z@example.com","city":"上海","wechat":"zs","birth":"2001-06","ageMode":"birthday","website":"https://example.com","avatarAssetId":null},
          "sections":[
            {"id":"legacy-section:education","kind":"education","title":"教育经历","visible":true,"entries":[
              {"id":"edu-1","title":"某某大学","role":"计算机科学与技术","department":"","city":"","start":"2019-09","end":"2023-06","body":[
                {"type":"paragraph","children":[{"type":"text","text":"主修课程：","marks":[]},{"type":"text","text":"编译原理","marks":["bold"]},{"type":"break"}]},
                {"type":"list","ordered":true,"items":[[{"type":"paragraph","children":[{"type":"text","text":"GPA 3.8","marks":[]}]}]]}
              ]}
            ]},
            {"id":"legacy-section:work","kind":"work","title":"工作经历","visible":true,"entries":[
              {"id":"work-1","title":"某科技公司","role":"前端工程师","department":"平台组","city":"上海","start":"2023-07","end":"至今","body":[
                {"type":"paragraph","children":[{"type":"text","text":"负责核心链路。","marks":[]}]},
                {"type":"list","ordered":false,"items":[[{"type":"paragraph","children":[{"type":"text","text":"首屏优化","marks":[]}]}],[{"type":"paragraph","children":[{"type":"text","text":"稳定性建设","marks":[]}]}]]}
              ]},
              {"id":"skill-1","title":"React 与 Rust","role":"","department":"","city":"","start":"","end":"","body":[
                {"type":"paragraph","children":[{"type":"text","text":"熟悉组件化与系统拆分。","marks":[]}]}
              ]}
            ]},
            {"id":"legacy-section:summary","kind":"summary","title":"自我评价","visible":true,"body":[
              {"type":"paragraph","children":[{"type":"link","href":"https://example.com/repo","children":[{"type":"text","text":"开源仓库","marks":["italic"]}]}]}
            ]},
            {"id":"legacy-section:awards","kind":"awards","title":"荣誉奖项","visible":false,"entries":[]}
          ],
          "presentation":{"templateId":"legacy-v1","templateRevision":"1","density":"standard","fontSetId":"legacy-font:宋体","fontSizePt":9.75,"lineHeightPt":9.75,"moduleGapPt":0,"pageMarginPt":22.5,"headingSizePt":9.75,"paragraphGapPt":0,"listGapPt":0,"theme":"#000000","dateFormat":"2021年1月","titleFormat":"单行标题","separator":"使用分隔符号","textAlign":"两端对齐","legacyOverrides":{}},
          "legacyExtensions":{}
        });
        serde_json::from_value(json).expect("engine fixture")
    }

    #[test]
    fn renders_pdf_with_pages_and_rejects_invalid_theme() {
        let document = sample_document();
        let pdf = render_document_pdf(&document, None).expect("pdf bytes");
        assert!(pdf.len() > 2_000, "pdf too small: {}", pdf.len());
        assert!(pdf.starts_with(b"%PDF"), "output is not a PDF");
        let paged = render_paged(&document, None).expect("compile again");
        let first = paged.pages().first().expect("page");
        assert!((first.frame.width().to_pt() - 595.28).abs() < 1.0);
        assert!((first.frame.height().to_pt() - 841.89).abs() < 1.0);
        let mut invalid = sample_document();
        invalid.presentation.theme = "red".into();
        assert!(matches!(
            render_document_pdf(&invalid, None),
            Err(EngineError::Validation(_))
        ));
    }

    #[test]
    fn svg_pages_carry_glyphs_and_structure() {
        let document = sample_document();
        let pages = render_document_svg(&document, None).expect("svg pages");
        assert!(!pages.is_empty());
        let joined: String = pages.concat();
        // Typst SVG 输出把文字转为字形轮廓（path），不做 <text> 输出；
        // 这里断言矢量结构：字形路径、颜色与 A4 视口。
        assert!(joined.contains("<path"), "glyph paths missing");
        assert!(joined.contains("#000000"), "ink color missing");
        assert!(joined.contains("viewBox"), "svg viewport missing");
        assert!(
            joined.len() > 4_000,
            "svg suspiciously small: {}",
            joined.len()
        );
        // 正文文本的真实提取由 PDF 文本层验收（webview E2E 的 PyMuPDF 链路）。
    }

    #[test]
    fn renders_png_page_with_avatar() {
        let mut document = sample_document();
        document.basic.avatar_asset_id = Some("avatar-hash".into());
        let png = render_page_png(
            &document,
            Some(("image/png".into(), AVATAR_PNG.to_vec())),
            0,
            2.0,
        )
        .expect("png bytes");
        assert!(png.starts_with(&[0x89, b'P', b'N', b'G']), "not a png");
        assert!(png.len() > 1_000, "png too small: {}", png.len());
    }

    #[test]
    fn avatar_slot_layout_is_reserved_without_bytes() {
        let mut document = sample_document();
        document.basic.avatar_asset_id = Some("avatar-hash".into());
        // 有 ID 但资源缺席：占位仍在，不因缺资源失败（资源层负责 MISSING 诊断）。
        let png = render_page_png(&document, None, 0, 1.0).expect("placeholder png");
        assert!(png.starts_with(&[0x89, b'P', b'N', b'G']));
    }

    #[test]
    fn renders_all_three_template_parameter_sets_and_both_title_modes() {
        let base = sample_document();
        let variants: [(&str, Presentation); 3] = [
            ("legacy-v1", base.presentation.clone()),
            (
                "clear-single-v1",
                presentation_with(
                    &base,
                    "clear-single-v1",
                    9.0,
                    12.0,
                    12.75,
                    6.0,
                    3.0,
                    1.5,
                    25.5,
                    "#ee5b2a",
                ),
            ),
            (
                "compact-single-v1",
                presentation_with(
                    &base,
                    "compact-single-v1",
                    8.25,
                    10.5,
                    10.5,
                    2.25,
                    0.75,
                    0.75,
                    18.0,
                    "#000000",
                ),
            ),
        ];
        for (template_id, presentation) in variants {
            let mut document = base.clone();
            document.presentation = presentation;
            let pdf = render_document_pdf(&document, None)
                .unwrap_or_else(|error| panic!("{template_id} compile failed: {error}"));
            assert!(
                pdf.starts_with(b"%PDF"),
                "{template_id} output is not a PDF"
            );
            let svg = render_document_svg(&document, None)
                .unwrap_or_else(|error| panic!("{template_id} svg failed: {error}"))
                .concat();
            assert!(svg.contains("<path"), "{template_id} glyph paths missing");
            match template_id {
                "clear-single-v1" => {
                    // clear 模板的强调条按主题色填充（#ee5b2a）。
                    assert!(svg.contains("#ee5b2a"), "accent color missing in clear svg")
                }
                "compact-single-v1" => {
                    // compact 头部下边框 2px 主题色（该变体主题为黑色）。
                    assert!(svg.contains("#000000"), "compact border color missing");
                }
                _ => {}
            }
        }
        // 双行标题路径：entryHead 的双行分支 + 元数据行。
        let mut double = base.clone();
        double.presentation.title_format = crate::domain::TitleFormat::DoubleLine;
        let pdf = render_document_pdf(&double, None).expect("double title pdf");
        assert!(pdf.starts_with(b"%PDF"));
        let svg = render_document_svg(&double, None)
            .expect("double title svg")
            .concat();
        // 双行标题的元数据行渲染为字形轮廓；断言矢量输出结构正常。
        assert!(svg.contains("<path"), "double-line glyph paths missing");
    }

    #[test]
    fn unknown_template_falls_back_to_legacy_layout() {
        let mut document = sample_document();
        document.presentation.template_id = "future-template-v9".into();
        let pdf = render_document_pdf(&document, None).expect("fallback pdf");
        assert!(pdf.starts_with(b"%PDF"));
    }

    #[allow(clippy::too_many_arguments)]
    fn presentation_with(
        base: &ResumeDocument,
        template_id: &str,
        font_size: f32,
        heading_size: f32,
        line_height: f32,
        module_gap: f32,
        paragraph_gap: f32,
        list_gap: f32,
        page_margin: f32,
        theme: &str,
    ) -> Presentation {
        let mut presentation = base.presentation.clone();
        presentation.template_id = template_id.into();
        presentation.font_size_pt = font_size;
        presentation.heading_size_pt = heading_size;
        presentation.line_height_pt = line_height;
        presentation.module_gap_pt = module_gap;
        presentation.paragraph_gap_pt = paragraph_gap;
        presentation.list_gap_pt = list_gap;
        presentation.page_margin_pt = page_margin;
        presentation.theme = theme.into();
        presentation
    }

    // -----------------------------------------------------------------------
    // TextMap（正式文本层）测试
    // -----------------------------------------------------------------------

    fn text_map(document: &ResumeDocument) -> TextMap {
        render_text_map(document, None).expect("text map")
    }

    fn logical_leaves(document: &ResumeDocument) -> Vec<(String, String)> {
        logical_leaf_items(document)
            .into_iter()
            .filter_map(|item| match item {
                LeafItem::Text { node_id, text } if !text.is_empty() => Some((node_id, text)),
                _ => None,
            })
            .collect()
    }

    fn cluster_text(map: &TextMap, cluster: &TextCluster) -> String {
        let units: Vec<u16> = map.logical_text.encode_utf16().collect();
        String::from_utf16(&units[cluster.start_utf16 as usize..cluster.end_utf16 as usize])
            .expect("cluster utf16 slice")
    }

    /// 每个文本叶子的簇必须按顺序无缝覆盖其 UTF-16 区间，且拼接回叶子原文。
    fn assert_full_coverage(document: &ResumeDocument, map: &TextMap) {
        let leaves = logical_leaves(document);
        assert!(!leaves.is_empty());
        for (node_id, text) in leaves {
            let mut clusters: Vec<&TextCluster> = map
                .clusters
                .iter()
                .filter(|cluster| cluster.source_node_id == node_id)
                .collect();
            assert!(!clusters.is_empty(), "node {node_id} produced no clusters");
            clusters.sort_by_key(|cluster| cluster.start_utf16);
            let mut reconstructed = String::new();
            let mut expected_start: Option<u32> = None;
            for cluster in clusters {
                if let Some(prev_end) = expected_start {
                    assert_eq!(
                        cluster.start_utf16, prev_end,
                        "node {node_id} clusters are not contiguous"
                    );
                }
                expected_start = Some(cluster.end_utf16);
                reconstructed.push_str(&cluster_text(map, cluster));
            }
            assert_eq!(reconstructed, text, "node {node_id} coverage mismatch");
        }
    }

    #[test]
    fn text_map_logical_text_orders_and_covers_sample() {
        let document = sample_document();
        let map = text_map(&document);
        assert_eq!(map.version, 1);
        // 语义顺序：姓名 → 联系主行 → 次行 → 站点 → 节标题 → 条目。
        assert!(
            map.logical_text.starts_with(
                "张三\n138-0000-0000\nz@example.com\nzs\n2001-06 出生\n上海\nexample.com\n教育经历\n"
            ),
            "unexpected logical text head: {:?}",
            &map.logical_text[..map.logical_text.len().min(120)]
        );
        assert!(map.logical_text.contains(
            "某某大学\n - 计算机科学与技术 全日制\n2019年09月 - 2023年06月\n主修课程：\n编译原理\nGPA 3.8\n工作经历"
        ));
        // 隐藏节不进入文本层；文档标题不渲染在纸面，也不进入。
        assert!(!map.logical_text.contains("荣誉奖项"));
        assert!(!map.logical_text.contains("引擎测试"));
        // “至今”原样保留（旧版 undefined 月缺陷不复现）。
        assert!(map.logical_text.contains("2023年07月 - 至今"));
        // 链接文本叶子存在且可读。
        assert!(map.logical_text.contains("开源仓库"));
        // logicalOrder 从 0 连续编号且按 startUtf16 单调。
        for (order, cluster) in map.clusters.iter().enumerate() {
            assert_eq!(cluster.logical_order as usize, order);
            if order > 0 {
                assert!(map.clusters[order - 1].start_utf16 <= cluster.start_utf16);
            }
        }
        assert_full_coverage(&document, &map);
    }

    #[test]
    fn text_map_cluster_rects_stay_within_page_bounds() {
        let document = sample_document();
        let map = text_map(&document);
        assert!(!map.clusters.is_empty());
        for cluster in &map.clusters {
            assert!(cluster.page >= 1);
            assert!(cluster.x_pt.is_finite() && cluster.y_pt.is_finite());
            assert!(cluster.width_pt.is_finite() && cluster.height_pt.is_finite());
            assert!(cluster.width_pt >= 0.0 && cluster.height_pt > 0.0);
            assert!(cluster.x_pt >= -1.0 && cluster.x_pt + cluster.width_pt <= 596.3);
            assert!(cluster.y_pt >= -1.0 && cluster.y_pt + cluster.height_pt <= 842.9);
        }
    }

    #[test]
    fn text_map_multipage_document_keeps_valid_ranges() {
        let mut document = sample_document();
        // 复制工作经历节（唯一 ID）把内容推过一页；节间允许分页。
        let work = document.sections[1].clone();
        for index in 0..8 {
            let mut extra = work.clone();
            if let crate::domain::Section::Entry(ref mut section) = extra {
                section.id = format!("legacy-section:work-dup-{index}");
                section.entries = section
                    .entries
                    .iter()
                    .map(|entry| {
                        let mut entry = entry.clone();
                        entry.id = format!("{}-dup-{index}", entry.id);
                        entry
                    })
                    .collect();
            }
            document.sections.push(extra);
        }
        let map = text_map(&document);
        let max_page = map
            .clusters
            .iter()
            .map(|cluster| cluster.page)
            .max()
            .unwrap();
        assert!(max_page >= 2, "expected content beyond page 1");
        assert_full_coverage(&document, &map);
        for cluster in &map.clusters {
            assert!(cluster.x_pt.is_finite() && cluster.width_pt >= 0.0);
        }
    }

    #[test]
    fn text_map_combining_marks_form_multi_unit_clusters() {
        let mut document = sample_document();
        let sample = "office e\u{301} 中文";
        if let crate::domain::Section::Entry(section) = &mut document.sections[1] {
            section.entries[0]
                .body
                .push(crate::domain::RichBlock::Paragraph {
                    children: vec![crate::domain::Inline::Text {
                        text: sample.into(),
                        marks: vec![],
                    }],
                });
        }
        let map = text_map(&document);
        let texts: Vec<String> = map
            .clusters
            .iter()
            .map(|cluster| cluster_text(&map, cluster))
            .collect();
        // 组合字符 e\u{301} 必须形成单个簇（1 字形 → 2 个 UTF-16 单元），
        // 证明多码点簇的 UTF-16 区间映射。连字（ffi 等）是否形成取决于
        // shaping 语言（引擎 zh 下不形成 ffi；PoC 在默认语言已验证同类机制）。
        assert!(
            texts.iter().any(|text| text == "e\u{301}"),
            "expected a combined e-accent cluster: {texts:?}"
        );
        assert_full_coverage(&document, &map);
    }

    #[test]
    fn text_map_double_line_title_exposes_meta_leaf() {
        let mut document = sample_document();
        document.presentation.title_format = crate::domain::TitleFormat::DoubleLine;
        let map = text_map(&document);
        assert!(map
            .logical_text
            .contains("某某大学\n2019年09月 - 2023年06月\n计算机科学与技术 全日制"));
        assert_full_coverage(&document, &map);
    }

    #[test]
    fn text_map_builds_for_all_three_templates() {
        let base = sample_document();
        for presentation in [
            base.presentation.clone(),
            presentation_with(
                &base,
                "clear-single-v1",
                9.0,
                12.0,
                12.75,
                6.0,
                3.0,
                1.5,
                25.5,
                "#ee5b2a",
            ),
            presentation_with(
                &base,
                "compact-single-v1",
                8.25,
                10.5,
                10.5,
                2.25,
                0.75,
                0.75,
                18.0,
                "#000000",
            ),
        ] {
            let mut document = base.clone();
            document.presentation = presentation;
            let map = render_text_map(&document, None).unwrap_or_else(|error| {
                panic!(
                    "{} text map failed: {error}",
                    document.presentation.template_id
                )
            });
            assert_full_coverage(&document, &map);
        }
    }
}
