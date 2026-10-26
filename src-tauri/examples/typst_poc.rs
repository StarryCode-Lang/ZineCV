//! B02 risk sample only. This does not replace the protected A4 preview.
use std::io::{self, BufRead, Read, Write};
use std::path::PathBuf;

use base64::Engine;
use sha2::{Digest, Sha256};
use typst::diag::{FileError, FileResult};
use typst::foundations::{Bytes, Datetime, Duration, Value};
use typst::introspection::{MetadataElem, Tag};
use typst::layout::{Frame, FrameItem, Point, Transform};
use typst::syntax::{FileId, RootedPath, Source, VirtualPath, VirtualRoot};
use typst::text::{Font, FontBook};
use typst::utils::LazyHash;
use typst::{Library, LibraryExt, World};
use typst_layout::PagedDocument;

const TEMPLATE: &str = r#"
#set page(width: 210mm, height: 297mm, margin: 24pt)
#set text(font: "Source Han Serif", size: 9.75pt)
#let payload = json("resume.json")
#let resume = payload.document
#let section = resume.sections.at(0)
#metadata("node:" + resume.documentId + ":title")
= #resume.title
#metadata("node:" + resume.documentId + ":name")
#resume.basic.name

#metadata("node:" + section.id + ":title")
== #section.title
#for i in range(0, section.body.len()) [
  #metadata("node:" + section.id + ":body:" + str(i))
  #section.body.at(i).children.at(0).text

]
"#;

struct FixtureWorld {
    library: LazyHash<Library>,
    book: LazyHash<FontBook>,
    fonts: Vec<Font>,
    main: FileId,
    data_id: FileId,
    source: Source,
    data: Bytes,
    source_fields: Vec<(String, String)>,
}

impl FixtureWorld {
    fn new(
        repeat_count: usize,
        font_bytes: &[Vec<u8>],
    ) -> Result<Self, Box<dyn std::error::Error>> {
        let mut book = FontBook::new();
        let mut fonts = Vec::new();
        for bytes in font_bytes {
            for font in Font::iter(Bytes::new(bytes.clone())) {
                book.push(font.info().clone());
                fonts.push(font);
            }
        }
        if fonts.is_empty() {
            return Err("No local fixture fonts were accepted by Typst".into());
        }
        let mut fixture: serde_json::Value =
            serde_json::from_str(include_str!("../../contracts/poc-contract-v1.json"))?;
        let body = &mut fixture["document"]["sections"][0]["body"];
        let prototype = body
            .as_array()
            .and_then(|blocks| blocks.first())
            .cloned()
            .ok_or("Fixture needs one body paragraph")?;
        *body = serde_json::Value::Array(vec![prototype; repeat_count]);
        let source_fields = fixture_text_fields(&fixture)?;
        let data = Bytes::from_string(serde_json::to_string(&fixture)?);
        let main = fixture_id("/main.typ");
        Ok(Self {
            library: LazyHash::new(Library::default()),
            book: LazyHash::new(book),
            fonts,
            main,
            data_id: fixture_id("/resume.json"),
            source: Source::new(main, TEMPLATE.into()),
            data,
            source_fields,
        })
    }
}

const FONT_NAMES: [&str; 2] = [
    "source-han-serif-cn-regular.otf",
    "source-han-serif-cn-heavy.ttf",
];

impl World for FixtureWorld {
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
    fn today(&self, _offset: Option<Duration>) -> Option<Datetime> {
        Datetime::from_ymd(2026, 9, 26)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unbreakable_blocks_paginate_between_blocks() {
        // 验证 Typst 对 block(breakable: false) 的分页语义：
        // 块内不可断，但根流上相邻块之间仍应分页。
        let fonts = repository_fixture_fonts().expect("fixture fonts");
        let mut world = FixtureWorld::new(1, &fonts).expect("fixture world");
        world.source = Source::new(
            world.main,
            "#set page(width: 210mm, height: 297mm, margin: 24pt)\n\
             #for i in range(30) { block(breakable: false)[#lorem(60)] }"
                .into(),
        );
        let result = typst::compile::<PagedDocument>(&world);
        let document = result.output.expect("layout");
        assert!(result.warnings.is_empty(), "{:?}", result.warnings);
        assert!(
            document.pages().len() > 1,
            "unbreakable blocks should paginate between blocks, got {} page(s)",
            document.pages().len()
        );
    }

    #[test]
    fn pagination_structure_variants() {
        // 引擎分页缺陷定位证据（B07）：block(breakable: false) 之间可以正常
        // 分页，但负的 par.leading 会让整篇文档只输出一页（内容压在第 1 页
        // 溢出，不产生编译警告）。修复方向是 text(top-edge/bottom-edge) 表达
        // CSS 行盒并把 leading 归零。
        let fonts = repository_fixture_fonts().expect("fixture fonts");
        let variants: [(&str, bool); 3] = [
            // 基线：不可断块之间分页正常
            (
                "#set page(width: 210mm, height: 297mm, margin: 24pt)\n\
                 #set text(font: \"Source Han Serif\", size: 9.75pt)\n\
                 #for i in range(30) { block(breakable: false)[#lorem(60)] }",
                true,
            ),
            // 反例：负 leading 单独即可破坏分页
            (
                "#set page(width: 210mm, height: 297mm, margin: 24pt)\n\
                 #set text(font: \"Source Han Serif\", size: 9.75pt)\n\
                 #set par(leading: -4.5pt, spacing: 0pt, first-line-indent: 0pt)\n\
                 #for i in range(30) { block(breakable: false)[#lorem(60)] }",
                false,
            ),
            // 修复验证：em 行盒（top/bottom-edge）+ 零 leading 恢复分页
            (
                "#set page(width: 210mm, height: 297mm, margin: 24pt)\n\
                 #set text(font: \"Source Han Serif\", size: 9.75pt, top-edge: 0.74em, bottom-edge: 0.26em)\n\
                 #set par(leading: 0pt, spacing: 0pt, first-line-indent: 0pt)\n\
                 #for i in range(30) { block(breakable: false)[#lorem(60)] }",
                true,
            ),
        ];
        let mut report = Vec::new();
        for (index, (source, expect_multi)) in variants.iter().enumerate() {
            let mut world = FixtureWorld::new(1, &fonts).expect("fixture world");
            world.source = Source::new(world.main, (*source).into());
            let result = typst::compile::<PagedDocument>(&world);
            let document = result.output.expect("layout");
            assert!(
                result.warnings.is_empty(),
                "variant {index} warnings: {:?}",
                result.warnings
            );
            report.push((index, document.pages().len(), *expect_multi));
        }
        for (index, pages, expect_multi) in &report {
            assert_eq!(
                *pages > 1,
                *expect_multi,
                "variant {index} pages={pages} (full report: {report:?})"
            );
        }
    }

    #[test]
    fn world_only_serves_declared_fixture_resources() {
        let world = FixtureWorld::new(1, &repository_fixture_fonts().expect("fixture fonts"))
            .expect("fixture World");
        assert!(world.file(fixture_id("/resume.json")).is_ok());
        assert!(world.file(fixture_id("/main.typ")).is_ok());
        assert!(world.file(fixture_id("/outside.txt")).is_err());
        assert!(world.source(fixture_id("/outside.txt")).is_err());
        assert!(world.font(world.fonts.len()).is_none());
    }

    #[test]
    fn worker_reports_text_clusters_on_each_page() {
        let fonts = repository_fixture_fonts().expect("fixture fonts");
        let response = render_worker_request(
            &serde_json::json!({
                "protocolVersion": 1,
                "generation": "fixture",
                "action": "render",
                "requestId": "text-map",
                "repeatCount": 20,
            }),
            "fixture",
            &fonts,
        )
        .expect("render fixture");
        let pages = response["textGeometrySample"]
            .as_array()
            .expect("text geometry pages");
        assert_eq!(pages.len(), 2);
        for (index, page) in pages.iter().enumerate() {
            assert_eq!(page["pageIndex"].as_u64(), Some(index as u64));
            let page_width = page["widthPt"].as_f64().expect("page width");
            let page_height = page["heightPt"].as_f64().expect("page height");
            assert!((page_width - 595.2756).abs() < 0.01);
            assert!((page_height - 841.8898).abs() < 0.01);
            let runs = page["runs"].as_array().expect("text runs");
            assert!(!runs.is_empty());
            for run in runs {
                let text = run["text"].as_str().expect("logical text");
                let clusters = run["clusters"].as_array().expect("glyph clusters");
                for cluster in clusters {
                    let start = cluster["utf16Start"].as_u64().expect("start");
                    let end = cluster["utf16End"].as_u64().expect("end");
                    assert!(start < end && end <= text.encode_utf16().count() as u64);
                    assert!(cluster["x"].as_f64().expect("x").is_finite());
                    assert!(cluster["y"].as_f64().expect("y").is_finite());
                    assert_eq!(cluster["sourceNodeId"], run["sourceNodeId"]);
                    let rect = &cluster["rect"];
                    let x = rect["xPt"].as_f64().expect("rect x");
                    let y = rect["yPt"].as_f64().expect("rect y");
                    let width = rect["widthPt"].as_f64().expect("rect width");
                    let height = rect["heightPt"].as_f64().expect("rect height");
                    assert!(x.is_finite() && y.is_finite());
                    assert!(width.is_finite() && height.is_finite());
                    assert!(width >= 0.0 && height > 0.0);
                    assert!(x >= -1.0 && x + width <= page_width + 1.0);
                    assert!(y >= -1.0 && y + height <= page_height + 1.0);
                }
            }
        }
        assert!(pages[0]["runs"]
            .as_array()
            .expect("first page runs")
            .iter()
            .any(|run| run["text"].as_str().unwrap_or_default().contains("虚构")));
        let first_page = pages[0]["runs"].as_array().expect("first page runs");
        assert!(first_page.iter().any(|run| {
            run["sourceNodeId"] == "fixture-document-1:title"
                && run["text"].as_str().unwrap_or_default().contains("虚构")
        }));
        assert!(first_page.iter().any(|run| {
            run["sourceNodeId"] == "fixture-document-1:name"
                && run["text"]
                    .as_str()
                    .unwrap_or_default()
                    .contains("样例人物")
        }));
        assert!(pages[1]["runs"]
            .as_array()
            .expect("second page runs")
            .iter()
            .all(|run| run["sourceNodeId"]
                .as_str()
                .is_some_and(|id| id.starts_with("fixture-section-1:body:"))));
        let fixture: serde_json::Value =
            serde_json::from_str(include_str!("../../contracts/poc-contract-v1.json"))
                .expect("fixture json");
        let expected = fixture["document"]["sections"][0]["body"][0]["children"][0]["text"]
            .as_str()
            .expect("body text");
        let mut by_block: std::collections::BTreeMap<String, Vec<(usize, String)>> =
            std::collections::BTreeMap::new();
        for run in pages
            .iter()
            .flat_map(|page| page["runs"].as_array().into_iter().flatten())
        {
            let Some(id) = run["sourceNodeId"].as_str() else {
                continue;
            };
            if !id.starts_with("fixture-section-1:body:") {
                continue;
            }
            for cluster in run["clusters"].as_array().expect("clusters") {
                by_block.entry(id.to_owned()).or_default().push((
                    cluster["sourceByteOffset"].as_u64().expect("source offset") as usize,
                    cluster["text"].as_str().expect("cluster text").to_owned(),
                ));
            }
        }
        assert_eq!(by_block.len(), 20);
        for index in 0..20 {
            let id = format!("fixture-section-1:body:{index}");
            let clusters = by_block.get_mut(&id).expect("body block source ID");
            clusters.sort_by_key(|(offset, _)| *offset);
            let mut reconstructed = String::new();
            for (offset, text) in clusters {
                assert_eq!(
                    expected.get(*offset..*offset + text.len()),
                    Some(text.as_str())
                );
                reconstructed.push_str(text);
            }
            assert_eq!(reconstructed, expected, "source block {index}");
        }
        let text_map = &response["textMapSample"];
        assert_eq!(text_map["version"], 1);
        let logical = text_map["logicalText"].as_str().expect("logical text");
        let logical_utf16 = logical.encode_utf16().collect::<Vec<_>>();
        let clusters = text_map["clusters"].as_array().expect("ordered clusters");
        assert!(!clusters.is_empty());
        for (order, cluster) in clusters.iter().enumerate() {
            assert_eq!(cluster["logicalOrder"].as_u64(), Some(order as u64));
            let start = cluster["startUtf16"].as_u64().expect("start") as usize;
            let end = cluster["endUtf16"].as_u64().expect("end") as usize;
            assert!(start < end && end <= logical_utf16.len());
            assert!((1..=2).contains(&cluster["page"].as_u64().expect("page")));
        }
        assert!(clusters
            .windows(2)
            .all(|pair| { pair[0]["startUtf16"].as_u64() <= pair[1]["startUtf16"].as_u64() }));
    }

    #[test]
    fn model_text_order_survives_reversed_paint_order_and_utf16_emoji() {
        let source = "中文 שלום عربي 😀";
        let emoji_offset = source.find('😀').expect("emoji");
        let hebrew_offset = source.find("שלום").expect("hebrew");
        let fields = vec![("sample:body:0".to_owned(), source.to_owned())];
        let pages = vec![serde_json::json!({
            "pageIndex": 0,
            "runs": [{
                "sourceNodeId": "sample:body:0",
                "clusters": [
                    {"text": "😀", "sourceByteOffset": emoji_offset, "rect": {"xPt": 20.0, "yPt": 1.0, "widthPt": 10.0, "heightPt": 10.0}},
                    {"text": "שלום", "sourceByteOffset": hebrew_offset, "rect": {"xPt": 1.0, "yPt": 1.0, "widthPt": 20.0, "heightPt": 10.0}}
                ]
            }]
        })];
        let map = build_text_map_sample(&fields, &pages).expect("text map sample");
        assert_eq!(map["logicalText"], source);
        let clusters = map["clusters"].as_array().expect("clusters");
        assert_eq!(clusters[0]["sourceNodeId"], "sample:body:0");
        assert_eq!(
            clusters[0]["startUtf16"],
            source[..hebrew_offset].encode_utf16().count()
        );
        assert_eq!(clusters[1]["endUtf16"], source.encode_utf16().count());
        assert_eq!(
            clusters[1]["endUtf16"].as_u64().unwrap() - clusters[1]["startUtf16"].as_u64().unwrap(),
            2
        );
    }

    #[test]
    fn unicode_sample_preserves_cluster_ranges() {
        let sample = "office e\u{301} 中文";
        let fonts = repository_fixture_fonts().expect("fixture fonts");
        let mut world = FixtureWorld::new(1, &fonts).expect("fixture world");
        world.source = Source::new(
            world.main,
            format!(
                "#set page(width: 210mm, height: 297mm, margin: 24pt)\n\
                 #set text(font: \"Source Han Serif\", size: 12pt)\n\
                 #metadata(\"node:unicode\")\n#text(\"{sample}\")"
            )
            .into(),
        );
        let result = typst::compile::<PagedDocument>(&world);
        let document = result.output.expect("unicode layout");
        assert!(result.warnings.is_empty(), "{:?}", result.warnings);
        assert_eq!(document.pages().len(), 1);
        let mut runs = Vec::new();
        let mut source_id = None;
        collect_text_runs(
            &document.pages()[0].frame,
            Transform::identity(),
            &mut source_id,
            &mut runs,
        );
        let logical = runs
            .iter()
            .filter(|run| run["sourceNodeId"] == "unicode")
            .filter_map(|run| run["text"].as_str())
            .collect::<String>();
        assert_eq!(logical, sample);
        let mut saw_ligature = false;
        let mut saw_combining_cluster = false;
        for run in runs {
            if run["sourceNodeId"] != "unicode" {
                continue;
            }
            let text = run["text"].as_str().expect("run text");
            let mut covered = vec![false; text.encode_utf16().count()];
            for cluster in run["clusters"].as_array().expect("clusters") {
                let start = cluster["utf16Start"].as_u64().expect("start") as usize;
                let end = cluster["utf16End"].as_u64().expect("end") as usize;
                assert!(start < end && end <= covered.len());
                let byte_offset = cluster["sourceByteOffset"].as_u64().expect("offset") as usize;
                let cluster_text = cluster["text"].as_str().expect("cluster text");
                assert_eq!(
                    sample.get(byte_offset..byte_offset + cluster_text.len()),
                    Some(cluster_text)
                );
                saw_ligature |= cluster["text"] == "ffi" && end - start == 3;
                saw_combining_cluster |= cluster["text"] == "e\u{301}" && end - start == 2;
                for unit in &mut covered[start..end] {
                    *unit = true;
                }
            }
            assert!(covered.into_iter().all(|unit| unit));
        }
        assert!(saw_ligature, "expected a shaped ffi ligature cluster");
        assert!(
            saw_combining_cluster,
            "expected a combined e-accent cluster"
        );
    }

    #[cfg(windows)]
    #[test]
    fn windows_fallback_sample_preserves_bidi_and_emoji_text() {
        let sample = "中文 שלום عربي 😀";
        let mut font_bytes = repository_fixture_fonts().expect("fixture fonts");
        let windows_fonts =
            PathBuf::from(std::env::var_os("WINDIR").expect("Windows directory")).join("Fonts");
        for file in ["segoeui.ttf", "seguiemj.ttf"] {
            font_bytes.push(std::fs::read(windows_fonts.join(file)).expect("Windows font"));
        }
        let mut world = FixtureWorld::new(1, &font_bytes).expect("fixture world");
        world.source = Source::new(
            world.main,
            format!(
                "#set page(width: 210mm, height: 297mm, margin: 24pt)\n\
                 #set text(font: (\"Source Han Serif\", \"Segoe UI\", \"Segoe UI Emoji\"), size: 12pt)\n\
                 #metadata(\"node:unicode-fallback\")\n#text(\"{sample}\")"
            )
            .into(),
        );
        let result = typst::compile::<PagedDocument>(&world);
        let document = result.output.expect("fallback layout");
        assert!(result.warnings.is_empty(), "{:?}", result.warnings);
        let mut runs = Vec::new();
        let mut source_id = None;
        collect_text_runs(
            &document.pages()[0].frame,
            Transform::identity(),
            &mut source_id,
            &mut runs,
        );
        let paint_order_text = runs
            .iter()
            .filter(|run| run["sourceNodeId"] == "unicode-fallback")
            .filter_map(|run| run["text"].as_str())
            .collect::<String>();
        assert_ne!(paint_order_text, sample);
        let mut clusters = runs
            .iter()
            .filter(|run| run["sourceNodeId"] == "unicode-fallback")
            .flat_map(|run| run["clusters"].as_array().into_iter().flatten())
            .collect::<Vec<_>>();
        clusters.sort_by_key(|cluster| cluster["sourceByteOffset"].as_u64().expect("offset"));
        let logical = clusters
            .iter()
            .map(|cluster| {
                let offset = cluster["sourceByteOffset"].as_u64().expect("offset") as usize;
                let text = cluster["text"].as_str().expect("cluster text");
                assert_eq!(sample.get(offset..offset + text.len()), Some(text));
                text
            })
            .collect::<String>();
        assert_eq!(logical, sample);
        assert!(clusters.iter().any(|cluster| cluster["text"] == "😀"));
    }

    #[test]
    fn json_field_clusters_map_back_to_source_text() {
        let fixture: serde_json::Value =
            serde_json::from_str(include_str!("../../contracts/poc-contract-v1.json"))
                .expect("fixture json");
        let fonts = repository_fixture_fonts().expect("fixture fonts");
        let world = FixtureWorld::new(1, &fonts).expect("fixture world");
        let result = typst::compile::<PagedDocument>(&world);
        let document = result.output.expect("fixture layout");
        assert!(result.warnings.is_empty(), "{:?}", result.warnings);
        let mut runs = Vec::new();
        let mut source_id = None;
        collect_text_runs(
            &document.pages()[0].frame,
            Transform::identity(),
            &mut source_id,
            &mut runs,
        );
        let document_id = fixture["document"]["documentId"]
            .as_str()
            .expect("document id");
        let section_id = fixture["document"]["sections"][0]["id"]
            .as_str()
            .expect("section id");
        let fields = [
            (
                format!("{document_id}:title"),
                fixture["document"]["title"].as_str().expect("title"),
            ),
            (
                format!("{document_id}:name"),
                fixture["document"]["basic"]["name"].as_str().expect("name"),
            ),
            (
                format!("{section_id}:title"),
                fixture["document"]["sections"][0]["title"]
                    .as_str()
                    .expect("section title"),
            ),
            (
                format!("{section_id}:body:0"),
                fixture["document"]["sections"][0]["body"][0]["children"][0]["text"]
                    .as_str()
                    .expect("body text"),
            ),
        ];
        for (id, expected) in fields {
            let mut clusters = runs
                .iter()
                .filter(|run| run["sourceNodeId"] == id)
                .flat_map(|run| run["clusters"].as_array().into_iter().flatten())
                .collect::<Vec<_>>();
            clusters.sort_by_key(|cluster| cluster["sourceByteOffset"].as_u64());
            let mut reconstructed = String::new();
            for cluster in clusters {
                let offset = cluster["sourceByteOffset"].as_u64().expect("offset") as usize;
                let text = cluster["text"].as_str().expect("cluster text");
                assert_eq!(expected.get(offset..offset + text.len()), Some(text));
                reconstructed.push_str(text);
            }
            assert_eq!(reconstructed, expected);
        }
    }
}

#[path = "typst_poc/protocol.rs"]
mod protocol;
use protocol::*;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut args = std::env::args().skip(1);
    if let Some(arg) = args.next() {
        if arg != "--worker" {
            return Err("Unsupported PoC argument".into());
        }
        let generation = args.next().ok_or("Missing worker generation")?;
        if generation.is_empty() || generation.len() > 64 || args.next().is_some() {
            return Err("Invalid worker generation".into());
        }
        return serve_worker(&generation);
    }
    let output = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../.artifacts/typst-poc");
    std::fs::create_dir_all(&output)?;
    let fixture_fonts = repository_fixture_fonts()?;
    for (name, repeat_count, expected_pages) in
        [("short", 1, 1), ("medium", 20, 2), ("long", 65, 5)]
    {
        let world = FixtureWorld::new(repeat_count, &fixture_fonts)?;
        let result = typst::compile::<PagedDocument>(&world);
        let document = result.output.map_err(|errors| format!("{errors:?}"))?;
        if document.pages().len() != expected_pages || !result.warnings.is_empty() {
            return Err(format!(
                "{name} produced {} pages (expected {expected_pages}) and {} warnings",
                document.pages().len(),
                result.warnings.len()
            )
            .into());
        }
        let pdf = typst_pdf::pdf(&document, &Default::default())
            .map_err(|errors| format!("{errors:?}"))?;
        std::fs::write(output.join(format!("{name}.pdf")), pdf)?;
        for (index, page) in document.pages().iter().enumerate() {
            std::fs::write(
                output.join(format!("{name}-{}.svg", index + 1)),
                typst_svg::svg(page, &Default::default()),
            )?;
        }
        let first = document.pages().first().ok_or("Typst returned no pages")?;
        let png = typst_render::render(first, &Default::default()).encode_png()?;
        std::fs::write(output.join(format!("{name}-1.png")), png)?;
        println!(
            "{name}: {} pages, {} warnings",
            document.pages().len(),
            result.warnings.len()
        );
        for warning in &result.warnings {
            eprintln!("{name} warning: {}", warning.message);
        }
    }
    Ok(())
}
