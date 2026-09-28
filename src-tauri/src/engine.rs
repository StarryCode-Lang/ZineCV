//! Typst 文档引擎（B07 阶段实现）：ResumeDocument → 矢量 PDF。
//! 正文内容只经 `json("resume.json")` 作为数据进入排版，不拼进 Typst 源码；
//! 模板以 legacy-v1 版式为基准（标题/条目/日期/分隔线/密度参数），
//! 与旧 DOM 预览的像素等价仍是 B07 视觉关卡的待验收项。
use std::path::PathBuf;

use typst::diag::{FileError, FileResult};
use typst::foundations::{Bytes, Datetime, Duration};
use typst::syntax::{FileId, RootedPath, Source, VirtualPath, VirtualRoot};
use typst::text::{Font, FontBook};
use typst::utils::LazyHash;
use typst::{Library, LibraryExt, World};
use typst_layout::PagedDocument;

use crate::domain::ResumeDocument;

const FONT_REGULAR_BYTES: &[u8] = include_bytes!("../../public/fonts/source-han-serif-cn-regular.otf");
const FONT_HEAVY_BYTES: &[u8] = include_bytes!("../../public/fonts/source-han-serif-cn-heavy.ttf");

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

/// 数据驱动模板：三个模板中的 legacy-v1 基线版式。
const TEMPLATE_SRC: &str = r##"
#let payload = json("resume.json")
#let doc = payload.document
#let pres = doc.presentation

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

#let renderBlocks(blocks) = {
  for block in blocks {
    if block.type == "paragraph" {
      renderInlineList(block.children)
      parbreak()
    } else if block.type == "list" {
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
        enum(..items)
      } else {
        list(..items)
      }
      parbreak()
    }
  }
}

#let dateLabel(value) = {
  if value.contains("-") {
    let parts = value.split("-")
    if pres.dateFormat == "2021.01" {
      parts.at(0) + "." + parts.at(1)
    } else {
      parts.at(0) + "年" + parts.at(1) + "月"
    }
  } else {
    value
  }
}

#let rangeLabel(start, end) = {
  dateLabel(start) + " - " + dateLabel(end)
}

#let metaLine(parts) = {
  let live = parts.filter(part => part != "")
  live.join(" · ")
}

#let entryHead(entry, singleLine) = {
  if singleLine {
    grid(
      columns: (1fr, auto),
      align: (left, right),
      text(size: pres.headingSizePt * 1pt)[#strong(entry.title) #if entry.role != "" [(#entry.role)]: #metaLine((entry.department, entry.city))],
      text(size: pres.headingSizePt * 1pt)[#rangeLabel(entry.start, entry.end)],
    )
  } else {
    grid(
      columns: (1fr, auto),
      align: (left, right),
      text(size: pres.headingSizePt * 1pt)[#strong(entry.title)],
      text(size: pres.headingSizePt * 1pt)[#rangeLabel(entry.start, entry.end)],
    )
    grid(
      columns: (1fr, auto),
      align: (left, right),
      text(fill: luma(90))[#metaLine((entry.role, entry.department, entry.mode, entry.college, entry.city))],
      [],
    )
  }
}

#let sectionHead(title) = {
  block(spacing: pres.moduleGapPt * 1pt)[
    #text(size: pres.headingSizePt * 1pt)[#strong(title)]
    #v(-pres.headingSizePt * 0.4pt)
    #line(length: 100%, stroke: 0.6pt + rgb(pres.theme))
  ]
}

// 单元格内容统一按正文渲染；summary 单独走正文块。
#set page(width: 210mm, height: 297mm, margin: (top: pres.pageMarginPt * 1pt, right: pres.pageMarginPt * 1pt, bottom: pres.pageMarginPt * 1pt, left: pres.pageMarginPt * 1pt))
#set text(font: "Source Han Serif", size: pres.fontSizePt * 1pt, fill: rgb(pres.theme), lang: "zh", region: "cn")
#set par(justify: pres.textAlign == "两端对齐", spacing: pres.paragraphGapPt * 1pt, leading: pres.lineHeightPt * 1pt)

#metadata("node:" + doc.documentId + ":title")
#block(spacing: 0pt)[
  #text(size: (pres.headingSizePt * 2.4) * 1pt)[#strong(doc.basic.name)]
  #v(pres.paragraphGapPt * 1pt)
  #metaLine((doc.basic.phone, doc.basic.email, doc.basic.city, doc.basic.wechat, doc.basic.website, doc.basic.linkedin, doc.basic.gender, doc.basic.birth))
]

#for section in doc.sections {
  if section.visible {
    sectionHead(section.title)
    metadata("node:" + section.id + ":head")
    if section.kind == "summary" {
      renderBlocks(section.body)
    } else {
      for entry in section.entries {
        metadata("node:" + entry.id + ":head")
        entryHead(entry, pres.titleFormat == "单行标题")
        renderBlocks(entry.body)
        v(pres.listGapPt * 1pt)
      }
    }
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
    source: Source,
    data: Bytes,
}

impl DocumentWorld {
    fn new(document: &ResumeDocument) -> Result<Self, EngineError> {
        // 主题色必须是安全十六进制，避免进入 Typst 源码的动态值引发编译错误。
        let theme = document.presentation.theme.trim();
        if !theme.starts_with('#')
            || theme.len() != 7
            || !theme[1..].bytes().all(|byte| byte.is_ascii_hexdigit())
        {
            return Err(EngineError::Validation(format!(
                "Theme color {theme} is not a #rrggbb value"
            )));
        }
        if !matches!(
            document.presentation.date_format,
            crate::domain::DateFormat::Chinese | crate::domain::DateFormat::Dotted
        ) || !matches!(
            document.presentation.title_format,
            crate::domain::TitleFormat::SingleLine | crate::domain::TitleFormat::DoubleLine
        ) {
            return Err(EngineError::Validation(
                "Presentation format fields are outside the supported set".into(),
            ));
        }
        let mut book = FontBook::new();
        let mut fonts = Vec::new();
        for bytes in [FONT_REGULAR_BYTES, FONT_HEAVY_BYTES] {
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
        let payload = serde_json::json!({ "document": document });
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
            source: Source::new(main, TEMPLATE_SRC.into()),
            data,
        })
    }
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

/// 排版当前文档并输出矢量 PDF；编译警告按错误处理，避免静默降级。
pub fn render_document_pdf(document: &ResumeDocument) -> Result<Vec<u8>, EngineError> {
    let world = DocumentWorld::new(document)?;
    let result = typst::compile::<PagedDocument>(&world);
    let paged = result
        .output
        .map_err(|errors| EngineError::Compile(format!("{errors:?}")))?;
    if !result.warnings.is_empty() {
        return Err(EngineError::Compile(format!("{:?}", result.warnings)));
    }
    if paged.pages().is_empty() {
        return Err(EngineError::Compile("Compiled document has no pages".into()));
    }
    typst_pdf::pdf(&paged, &Default::default())
        .map_err(|errors| EngineError::Compile(format!("{errors:?}")))
}

#[cfg(test)]
mod tests {
    use super::*;
    use typst_layout::PagedDocument;

    fn sample_document() -> ResumeDocument {
        let json = serde_json::json!({
          "schemaVersion":2,
          "documentId":"doc-engine",
          "title":"引擎测试",
          "basic":{"name":"张三","phone":"138-0000-0000","email":"z@example.com","city":"上海","wechat":"zs","birth":"2001-06","ageMode":"birthday","website":"https://example.com"},
          "sections":[
            {"id":"legacy-section:education","kind":"education","title":"教育经历","visible":true,"entries":[
              {"id":"edu-1","title":"某某大学","role":"计算机科学与技术","department":"","city":"","start":"2019-09","end":"2023-06","body":[
                {"type":"paragraph","children":[{"type":"text","text":"主修课程：","marks":[]},{"type":"text","text":"编译原理","marks":["bold"]},{"type":"break"}]},
                {"type":"list","ordered":true,"items":[[{"type":"paragraph","children":[{"type":"text","text":"GPA 3.8","marks":[]}]}]]}
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
        let pdf = render_document_pdf(&document).expect("pdf bytes");
        assert!(pdf.len() > 2_000, "pdf too small: {}", pdf.len());
        assert!(pdf.starts_with(b"%PDF"), "output is not a PDF");
        // A4 尺寸经页面编译保证；这里再确认编译路径可复用并检查页数可用。
        let world = DocumentWorld::new(&document).expect("world");
        let compiled = typst::compile::<PagedDocument>(&world);
        let paged = compiled.output.expect("compile again");
        assert!(!paged.pages().is_empty());
        let first = paged.pages().first().expect("page");
        assert!((first.frame.width().to_pt() - 595.28).abs() < 1.0);
        assert!((first.frame.height().to_pt() - 841.89).abs() < 1.0);
        // 隐藏模块（awards）不进入排版结果：元数据标记数量可以粗查。
        let mut invalid = sample_document();
        invalid.presentation.theme = "red".into();
        assert!(matches!(
            render_document_pdf(&invalid),
            Err(EngineError::Validation(_))
        ));
    }
}
