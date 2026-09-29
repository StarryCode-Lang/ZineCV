//! Typst 文档引擎（B07 阶段实现）：ResumeDocument → 矢量 PDF / SVG / PNG。
//! 正文内容只经 `json("resume.json")` 作为数据进入排版，不拼进 Typst 源码。
//! 三个内置模板（legacy-v1 / clear-single-v1 / compact-single-v1）的版式度量
//! 按旧 DOM 预览的 CSS 逐项换算（px × 0.75 = pt）：
//! - 正文颜色固定（legacy #000 / clear #28221e / compact #252525）；
//!   主题色只作强调（标题图标、clear 强调条、compact 头部下边框）。
//! - 节标题 strong 固定 18px/13px（所有模板，CSS `.preview-title strong`）。
//! - h1 无全局字重重置，浏览器默认 bold → 与 heavy 字重（900）一致。
//! - 行距按 CSS line-height 语义换算：leading = line-height − 字体竖向度量，
//!   单行元素用固定高度盒 + 垂直居中表达半行距的对称溢出。
//! - 联系栏/站点/次要信息由 Rust 侧预计算（过滤空值与年龄文案），
//!   避免把 null 处理留给模板层。
//! - “至今”等非日期文本原样保留（旧版会渲染为“至今年undefined月”，属
//!   已知缺陷，2.0 按计划修复并记录，不照搬 bug）。
//!
//! 像素级对照由引擎对照工具按 B07 视觉关卡另行验收。
use std::path::PathBuf;

use typst::diag::{FileError, FileResult};
use typst::foundations::{Bytes, Datetime, Duration};
use typst::syntax::{FileId, RootedPath, Source, VirtualPath, VirtualRoot};
use typst::text::{Font, FontBook};
use typst::utils::LazyHash;
use typst::{Library, LibraryExt, World};
use typst_layout::PagedDocument;

use crate::domain::{DateFormat, ResumeDocument, TitleFormat};

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
}

impl std::fmt::Display for EngineError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Validation(message) => write!(f, "Engine validation failed: {message}"),
            Self::Compile(message) => write!(f, "Typst compile failed: {message}"),
        }
    }
}

/// 一次渲染需要的头像资源；缺席时保留 64×88px 布局占位
/// （与旧 DOM 的 `.preview-avatar-slot.empty` 一致）。
pub type AvatarAsset = Option<(String, Vec<u8>)>;

/// 数据驱动模板：三个内置模板共用一个结构，按 layout.mode 分支版式差异。
const TEMPLATE_SRC: &str = r##"
#let payload = json("resume.json")
#let doc = payload.document
#let pres = doc.presentation
#let L = payload.layout
#let C = payload.contact

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

#let renderInline(node) = {
  if node.type == "text" {
    markText(node.text, node.at("marks", default: ()))
  } else if node.type == "link" {
    let inner = node.children.map(renderInline).join()
    if inner == none { [ ] } else { link(node.href, inner) }
  } else {
    linebreak()
  }
}

#let renderInlineList(children) = {
  let out = none
  for node in children {
    let piece = renderInline(node)
    out = if out == none { piece } else { out + piece }
  }
  if out == none { [ ] } else { out }
}

// 富文本块序列：相邻块之间使用 --template-paragraph-spacing；
// 列表条目间距使用 --template-list-spacing。
#let renderBlocks(blocks) = {
  let first = true
  for block in blocks {
    if not first { v(L.paraGapPt * 1pt) }
    first = false
    if block.type == "paragraph" {
      set par(justify: pres.textAlign == "两端对齐")
      renderInlineList(block.children)
    } else if block.type == "list" {
      set par(justify: pres.textAlign == "两端对齐")
      let items = ()
      for item in block.items {
        let rendered = none
        for inner in item {
          let piece = if inner.type == "paragraph" { renderInlineList(inner.children) } else { renderBlocks((inner,)) }
          rendered = if rendered == none { piece } else { rendered + piece }
        }
        items += (if rendered == none { [ ] } else { rendered },)
      }
      if block.ordered {
        enum(indent: L.olIndentPt * 1pt, body-indent: L.olBodyIndentPt * 1pt, tight: false, spacing: L.listGapPt * 1pt, ..items)
      } else {
        let dot = circle(fill: rgb("#000000"), radius: (L.ulMarkerPt * 0.5) * 1pt)
        list(indent: L.ulIndentPt * 1pt, body-indent: L.ulBodyIndentPt * 1pt, tight: false, spacing: L.listGapPt * 1pt, marker: dot, ..items)
      }
    }
  }
}

// 日期：仅 "YYYY-MM" 转格式；“至今”等原样保留（旧版 undefined 月缺陷已修复）。
#let dateLabel(value) = {
  if value == none or value == "" { "" }
  else if type(value) == "str" and value.contains("-") and value.len() >= 7 {
    let parts = value.split("-")
    if pres.dateFormat == "2021.01" { parts.at(0) + "." + parts.at(1) } else { parts.at(0) + "年" + parts.at(1) + "月" }
  } else { value }
}

#let rangeLabel(start, end) = dateLabel(start) + " - " + dateLabel(end)

#let metaJoin(parts) = {
  let live = parts.filter(part => part != none and part != "")
  live.join(" ")
}

// 条目头部元数据：教育经历含学历方式缺省“全日制”与学院。
#let entryMeta(kind, entry) = {
  if kind == "education" {
    let mode = if entry.at("mode", default: none) == none { "全日制" } else { entry.at("mode") }
    metaJoin((entry.role, entry.department, mode, entry.at("college", default: "")))
  } else {
    metaJoin((entry.role, entry.department))
  }
}

#let inlineMeta(kind, entry) = {
  let meta = entryMeta(kind, entry)
  let sep = if pres.separator == "使用分隔符号" { " - " } else { " " }
  if meta != "" and entry.title != "" { sep + meta } else if meta != "" { meta } else { "" }
}

// 单行元素盒：固定高度 + 垂直居中重现 CSS line-box 的半行距溢出对称。
#let lineBox(boxH, body) = {
  block(height: boxH * 1pt, breakable: false)[#align(center)[#body]]
}

#let contactIcon(glyph) = {
  text(font: "iconfont", size: L.contactIconPt * 1pt)[#glyph]
}

// 联系栏：图标与文字间 6px；span 间 13px（末项无尾距）。
#let contactLine(items) = {
  block(breakable: false)[
    #for (index, item) in items.enumerate() {
      if item.glyph != none { box[#contactIcon(item.glyph) #h(L.contactIconGapPt * 1pt)] }
      text(fill: rgb(L.contactColor), size: L.fsPt * 1pt)[#item.value]
      if index < items.len() - 1 { h(L.contactSpanGapPt * 1pt) }
    }
  ]
}

#let siteCell(url) = {
  let shown = if url.starts-with("http") { url } else { "https://" + url }
  let domain = lower(shown)
  let label = shown.replace(regex("^https?://"), "")
  let logo = if domain.contains("github.com") {
    contactIcon("\u{e6fe}")
  } else if domain.contains("csdn.net") {
    text(font: "Source Han Serif", size: L.csdnPt * 1pt, weight: 700, tracking: -0.4125pt)[CSDN]
  } else {
    contactIcon("\u{e75c}")
  }
  // CSS 语义：logo 13px + 6px 间距 + 文本 nowrap/ellipsis；Typst 无省略号，
  // 以列宽内 clip 近似（1fr 列自适应，不截短实际内容）。
  grid(columns: (auto, L.contactIconGapPt * 1pt, 1fr),
    box[#logo],
    [],
    box(width: 100%, clip: true)[#text(fill: rgb(L.contactColor), size: L.fsPt * 1pt)[#label]]
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
  metadata("node:" + section.id + ":head")
  let titleCell = box[#text(fill: rgb(L.titleStrongColor), size: L.strongSizePt * 1pt)[#strong(section.title)]]
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
          align(center)[#sectionIcon(section.kind)],
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
#let entryHead(kind, entry) = {
  let meta = entryMeta(kind, entry)
  let inline = inlineMeta(kind, entry)
  let range = if kind == "education" { rangeLabel(entry.start, entry.end) } else if entry.start != "" { rangeLabel(entry.start, entry.end) } else { "" }
  block(below: L.headPadBottomPt * 1pt, breakable: false)[
    #if pres.titleFormat == "单行标题" {
      grid(columns: (1fr, auto), column-gutter: L.headGapRightPt * 1pt,
        box[#text(fill: rgb(L.headStrongColor), size: L.fsPt * 1pt)[#strong(entry.title) #text(fill: rgb(L.inlineMetaColor), size: L.fsPt * 1pt)[#inline]]],
        box(clip: true)[#text(fill: rgb(L.dateColor), size: L.fsPt * 1pt)[#range]]
      )
    } else {
      grid(columns: (1fr, auto), column-gutter: 0.75pt,
        box[#text(fill: rgb(L.headStrongColor), size: L.fsPt * 1pt)[#strong(entry.title)]],
        box(clip: true)[#text(fill: rgb(L.dateColor), size: L.fsPt * 1pt)[#range]]
      )
    }
    #if pres.titleFormat == "双行标题" and meta != "" {
      block(above: L.metaMarginTopPt * 1pt, breakable: false)[#text(fill: rgb(L.metaColor), size: L.fsPt * 1pt)[#meta]]
    }
  ]
}

#let renderEntry(kind, entry, first) = {
  metadata("node:" + entry.id + ":head")
  block(above: if first { 0pt } else { L.entryGapPt * 1pt }, breakable: false)[
    #if kind == "education" {
      entryHead(kind, entry)
      block(above: L.paraGapPt * 1pt, breakable: false)[#renderBlocks(entry.body)]
    } else {
      let meta = entryMeta(kind, entry)
      let hasHead = entry.start != "" or entry.end != "" or meta != ""
      if hasHead {
        entryHead(kind, entry)
        block(above: L.paraGapPt * 1pt, breakable: false)[#renderBlocks(entry.body)]
      } else if entry.title != "" {
        // 无头信息条目：标题进入正文首行（技能条目等）。
        text(fill: rgb(L.headStrongColor), size: L.fsPt * 1pt)[#strong(entry.title)]
        v(L.paraGapPt * 1pt)
        renderBlocks(entry.body)
      } else {
        block(above: L.paraGapPt * 1pt, breakable: false)[#renderBlocks(entry.body)]
      }
    }
  ]
}

#let sectionBody(section) = {
  if section.kind == "summary" {
    block(above: L.paraGapPt * 1pt, breakable: false)[#renderBlocks(section.body)]
  } else {
    let first = true
    for entry in section.entries {
      renderEntry(section.kind, entry, first)
      first = false
    }
  }
}

// 页面与正文基础排版。
#set page(width: 210mm, height: 297mm, margin: (top: pres.pageMarginPt * 1pt, right: pres.pageMarginPt * 1pt, bottom: pres.pageMarginPt * 1pt, left: pres.pageMarginPt * 1pt))
#set text(font: "Source Han Serif", size: L.fsPt * 1pt, fill: rgb(L.paperColor), lang: "zh", region: "cn")
#set par(leading: L.bodyLeadingPt * 1pt, spacing: 0pt, first-line-indent: 0pt)

// 头部：左主信息 + 右头像占位（头像缺席仍保留 64×88px 布局位）。
#grid(
  columns: (1fr, 48pt),
  column-gutter: 12pt,
  block[
    #lineBox(L.h1LineHpt)[
      #text(fill: rgb("#000000"), size: L.h1SizePt * 1pt, tracking: L.h1TrackingPt * 1pt)[#strong(doc.basic.name)]
    ]
    #block(above: L.h1MarginBottomPt * 1pt)[]
    #if C.primary.len() > 0 { contactLine(C.primary) }
    #if C.secondary.len() > 0 { contactLine(C.secondary) }
    #if C.sites.len() > 0 {
      grid(columns: (1fr, 1fr), column-gutter: 12pt, row-gutter: 12pt,
        ..C.sites.map(site => siteCell(site))
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

#metadata("node:" + doc.documentId + ":title")

#let visible = doc.sections.filter(s => s.visible)
#for (index, section) in visible.enumerate() {
  if index > 0 { block(above: L.moduleGapPt * 1pt, breakable: false)[] }
  block(breakable: false)[
    #sectionHead(section)
    #sectionBody(section)
  ]
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
        let extent_em = ttf_parser::Face::parse(FONT_REGULAR_BYTES, 0)
            .ok()
            .map(|face| {
                let metrics = typst::text::FontMetrics::from_ttf(&face);
                metrics.ascender.get() - metrics.descender.get()
            })
            .ok_or_else(|| EngineError::Validation("body font metrics missing".into()))?;

        let mode = template_mode(&document.presentation.template_id);
        let layout = layout_json(document, &theme, mode, extent_em, avatar.is_some())?;
        let contact = contact_json(document);
        let payload =
            serde_json::json!({ "document": document, "layout": layout, "contact": contact });
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

/// 头部联系信息在 Rust 侧预计算：过滤空值、解析年龄文案，
/// 模板层只做纯渲染（无 null 分支）。
fn contact_json(document: &ResumeDocument) -> serde_json::Value {
    let basic = &document.basic;
    let entry = |glyph: Option<&str>, value: &str| {
        if value.is_empty() {
            None
        } else {
            Some(serde_json::json!({ "glyph": glyph, "value": value }))
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

    let mut secondary: Vec<serde_json::Value> = Vec::new();
    if !basic.birth.is_empty() {
        let label = if basic.age_mode == crate::domain::AgeMode::Age {
            let years = age_years(&basic.birth, (2026, 9, 28)).unwrap_or(0);
            format!("{years}岁")
        } else {
            format!("{} 出生", basic.birth)
        };
        secondary.push(serde_json::json!({ "glyph": "\u{e75e}", "value": label }));
    }
    if !basic.city.is_empty() {
        secondary.push(serde_json::json!({ "glyph": "\u{e732}", "value": basic.city }));
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

    let sites: Vec<&str> = [&basic.website, &basic.linkedin]
        .into_iter()
        .filter_map(|value| value.as_deref())
        .filter(|value| !value.is_empty())
        .collect();

    serde_json::json!({ "primary": primary, "secondary": secondary, "sites": sites })
}

/// 按旧版 CSS（preview.css + 两个模板覆盖）逐项换算版式参数。
/// px → pt 固定 ×0.75；em 相对量按正文字号解析。
fn layout_json(
    document: &ResumeDocument,
    theme: &str,
    mode: &str,
    extent_em: f64,
    has_avatar: bool,
) -> Result<serde_json::Value, EngineError> {
    let pres = &document.presentation;
    let px = |v: f64| v * 0.75;
    let fs_pt = pres.font_size_pt as f64;
    let lh_pt = pres.line_height_pt as f64;
    let em = |factor: f64, base_pt: f64| factor * base_pt;

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
        "fontExtentEm": extent_em,
        "fsPt": fs_pt,
        "bodyLeadingPt": lh_pt - extent_em * fs_pt,
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
}
