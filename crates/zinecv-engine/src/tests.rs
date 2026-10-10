use super::text_map::{logical_leaf_items, LeafItem};
use typst::layout::{Frame, FrameItem};
use zinecv_contracts::Inline;

#[test]
fn preview_pages_and_text_share_frozen_resources_and_reference_date() {
    use sha2::{Digest, Sha256};
    let mut document = sample_document();
    document.basic.birth = "2000-01".into();
    document.basic.age_mode = zinecv_contracts::AgeMode::Age;
    let fonts = RenderFontBytes::default();
    let first = render_preview_with_resources(&document, None, &fonts, (2027, 1, 1)).unwrap();
    let second = render_preview_with_resources(&document, None, &fonts, (2027, 1, 1)).unwrap();
    assert_eq!(
        first, second,
        "same frozen input produces stable page hashes and text"
    );
    assert!(first.text_map.logical_text.contains("27岁"));
    for page in &first.pages {
        assert_eq!(
            page.page_hash,
            format!("{:x}", Sha256::digest(page.svg.as_bytes()))
        );
        assert!(page.svg.starts_with("<svg"));
        assert!((page.width_pt - 595.276).abs() < 0.1);
        assert!((page.height_pt - 841.89).abs() < 0.1);
    }
    document.basic.name = "合成改名".into();
    let changed = render_preview_with_resources(&document, None, &fonts, (2027, 1, 1)).unwrap();
    assert_ne!(first.pages[0].page_hash, changed.pages[0].page_hash);
    assert!(changed.text_map.logical_text.starts_with("合成改名"));
}

#[test]
fn contact_text_nodes_keep_field_identity_when_neighbor_fields_disappear() {
    let mut document = sample_document();
    document.basic.phone = "13800000000".into();
    document.basic.email = "synthetic@example.invalid".into();
    document.basic.wechat = "synthetic-chat".into();
    document.basic.website = Some("example.invalid".into());
    document.basic.linkedin = Some("linkedin.com/in/synthetic".into());
    let first = text_map(&document);
    assert_full_coverage(&document, &first);
    document.basic.phone.clear();
    document.basic.website = None;
    let second = text_map(&document);
    assert_full_coverage(&document, &second);
    for id in ["basic:email", "basic:wechat", "basic:linkedin"] {
        let text = |map: &TextMap| {
            let units: Vec<_> = map.logical_text.encode_utf16().collect();
            map.clusters
                .iter()
                .filter(|cluster| cluster.source_node_id == id)
                .flat_map(|cluster| {
                    units[cluster.start_utf16 as usize..cluster.end_utf16 as usize]
                        .iter()
                        .copied()
                })
                .collect::<Vec<_>>()
        };
        let original = text(&first);
        assert!(!original.is_empty(), "missing field node {id}");
        assert_eq!(original, text(&second), "field identity shifted: {id}");
    }
    assert!(!second.clusters.iter().any(|cluster| matches!(
        cluster.source_node_id.as_str(),
        "basic:phone" | "basic:website"
    )));
}

#[test]
fn hit_regions_distinguish_same_named_entries_and_keep_cross_page_fragments() {
    let mut document = sample_document();
    let zinecv_contracts::Section::Entry(section) = &mut document.sections[1] else {
        panic!("fixture work section")
    };
    section.entries.truncate(1);
    section.entries[0].id = "synthetic:work:a".into();
    section.entries[0].title = "同名经历".into();
    section.entries[0].body = (0..90)
        .map(|index| zinecv_contracts::RichBlock::Paragraph {
            children: vec![Inline::Text {
                text: format!("合成跨页内容第{index}段，保持领域条目身份。"),
                marks: vec![],
            }],
        })
        .collect();
    let mut other = section.entries[0].clone();
    other.id = "synthetic:work:b".into();
    other.body.truncate(1);
    section.entries.push(other);
    let map = text_map(&document);
    assert_full_coverage(&document, &map);
    let first = map
        .hit_regions
        .iter()
        .find(|region| region.source_node_id == "entry:synthetic:work:a")
        .expect("first entry");
    let second = map
        .hit_regions
        .iter()
        .find(|region| region.source_node_id == "entry:synthetic:work:b")
        .expect("same named second entry");
    assert!(first.semantic_order < second.semantic_order);
    assert!(
        first
            .fragments
            .iter()
            .map(|fragment| fragment.page)
            .collect::<std::collections::HashSet<_>>()
            .len()
            >= 2
    );
    for region in &map.hit_regions {
        assert!(!region.fragments.is_empty());
        for fragment in &region.fragments {
            assert!(fragment.start_utf16 < fragment.end_utf16);
            assert!(fragment.width_pt >= 0.0 && fragment.height_pt > 0.0);
            assert!(fragment.page >= 1);
        }
    }
    for cluster in &map.clusters {
        assert!(map
            .hit_regions
            .iter()
            .flat_map(|region| &region.fragments)
            .any(|fragment| fragment.page == cluster.page
                && fragment.start_utf16 <= cluster.start_utf16
                && fragment.end_utf16 >= cluster.end_utf16
                && fragment.x_pt <= cluster.x_pt + 0.01
                && fragment.x_pt + fragment.width_pt >= cluster.x_pt + cluster.width_pt - 0.01));
    }
}

use super::*;
use zinecv_contracts::Presentation;

#[test]
fn long_entry_fragments_without_clipping_text() {
    let mut document = sample_document();
    if let Section::Entry(section) = &mut document.sections[1] {
        section.entries[0].body = vec![RichBlock::Paragraph {
            children: vec![Inline::Text {
                text: "长经历正文用于分页核验。".repeat(2400),
                marks: vec![],
            }],
        }];
    }
    let map = text_map(&document);
    let body: Vec<_> = map
        .clusters
        .iter()
        .filter(|c| c.source_node_id == "entry:work-1:b0:l0")
        .collect();
    assert!(body.iter().map(|c| c.page).max().unwrap() >= 5);
    for cluster in body {
        assert!(cluster.y_pt >= 0.0 && cluster.y_pt + cluster.height_pt <= 842.0);
    }
    assert_full_coverage(&document, &map);
}

#[test]
fn rich_inline_marks_and_links_do_not_break_copied_sentences() {
    let mut document = sample_document();
    if let Section::Summary(section) = &mut document.sections[2] {
        section.body = vec![RichBlock::Paragraph {
            children: vec![
                Inline::Text {
                    text: "完整".into(),
                    marks: vec![],
                },
                Inline::Text {
                    text: "句子".into(),
                    marks: vec![zinecv_contracts::InlineMark::Bold],
                },
                Inline::Link {
                    href: "https://example.com".into(),
                    children: vec![Inline::Text {
                        text: "链接".into(),
                        marks: vec![],
                    }],
                },
                Inline::Break,
                Inline::Break,
                Inline::Text {
                    text: "下行".into(),
                    marks: vec![],
                },
            ],
        }];
    }
    let map = text_map(&document);
    assert!(map.logical_text.contains("完整句子链接\n\n下行"));
    let link = map
        .links
        .iter()
        .find(|link| link.href == "https://example.com" && link.source_node_id.ends_with(":b0:l2"))
        .unwrap();
    let units: Vec<_> = map.logical_text.encode_utf16().collect();
    assert_eq!(
        String::from_utf16(&units[link.start_utf16 as usize..link.end_utf16 as usize]).unwrap(),
        "链接"
    );
    assert_full_coverage(&document, &map);
}

#[test]
fn text_links_preserve_destinations_through_nested_and_cross_page_leaves() {
    let mut document = sample_document();
    document.basic.website = Some("example.invalid".into());
    let long = "合成跨页链接内容 ".repeat(1000);
    if let Section::Summary(section) = &mut document.sections[2] {
        section.body = vec![RichBlock::Paragraph {
            children: vec![Inline::Link {
                href: "https://outer.invalid".into(),
                children: vec![
                    Inline::Text {
                        text: "同名链接".into(),
                        marks: vec![],
                    },
                    Inline::Link {
                        href: "mailto:synthetic@example.invalid".into(),
                        children: vec![Inline::Text {
                            text: "同名链接".into(),
                            marks: vec![],
                        }],
                    },
                    Inline::Break,
                    Inline::Text {
                        text: long.clone(),
                        marks: vec![],
                    },
                ],
            }],
        }];
    }
    let map = text_map(&document);
    let units: Vec<_> = map.logical_text.encode_utf16().collect();
    let text = |link: &zinecv_contracts::TextLink| {
        String::from_utf16(&units[link.start_utf16 as usize..link.end_utf16 as usize]).unwrap()
    };
    assert!(map
        .links
        .iter()
        .any(|link| link.source_node_id == "basic:website"
            && link.href == "https://example.invalid"
            && text(link) == "example.invalid"));
    let same: Vec<_> = map
        .links
        .iter()
        .filter(|link| text(link) == "同名链接")
        .collect();
    assert_eq!(same.len(), 2);
    assert_ne!(same[0].source_node_id, same[1].source_node_id);
    assert_eq!(same[0].href, "https://outer.invalid");
    assert_eq!(same[1].href, "mailto:synthetic@example.invalid");
    let cross = map.links.iter().find(|link| text(link) == long).unwrap();
    assert_eq!(cross.href, "https://outer.invalid");
    let pages: std::collections::HashSet<_> = map
        .clusters
        .iter()
        .filter(|cluster| cluster.source_node_id == cross.source_node_id)
        .map(|cluster| cluster.page)
        .collect();
    assert!(pages.len() > 1);
    assert_full_coverage(&document, &map);
}

#[test]
fn mixed_direction_clusters_keep_logical_order_and_resolved_caret_direction() {
    let mut document = sample_document();
    let sentence = "中文 A אבג 123 ד E";
    if let Section::Summary(section) = &mut document.sections[2] {
        section.body = vec![RichBlock::Paragraph {
            children: vec![Inline::Text {
                text: sentence.into(),
                marks: vec![],
            }],
        }];
    }
    let map = text_map(&document);
    assert!(map.logical_text.contains(sentence));
    assert_full_coverage(&document, &map);
    let units: Vec<_> = map.logical_text.encode_utf16().collect();
    let content = |cluster: &zinecv_contracts::TextCluster| {
        String::from_utf16(&units[cluster.start_utf16 as usize..cluster.end_utf16 as usize])
            .unwrap()
    };
    let hebrew: Vec<_> = map
        .clusters
        .iter()
        .filter(|cluster| ["א", "ב", "ג"].contains(&content(cluster).as_str()))
        .collect();
    assert_eq!(hebrew.len(), 3);
    assert!(hebrew.iter().all(|cluster| cluster.rtl));
    assert!(
        hebrew[0].x_pt > hebrew[1].x_pt && hebrew[1].x_pt > hebrew[2].x_pt,
        "compiled physical order is reversed while logical offsets remain ascending"
    );
    for cluster in &map.clusters {
        if ["A", "1", "2", "3", "E"].contains(&content(cluster).as_str()) {
            assert!(!cluster.rtl);
        }
    }
    let singleton = map
        .clusters
        .iter()
        .find(|cluster| content(cluster) == "ד")
        .unwrap();
    assert!(
        singleton.rtl,
        "one-character RTL runs need paragraph context, not neighbouring geometry guesses"
    );
}

#[test]
fn ordered_list_preserves_nondefault_start_in_rendered_glyphs() {
    let mut document = sample_document();
    if let Section::Entry(section) = &mut document.sections[0] {
        if let RichBlock::List { start, .. } = &mut section.entries[0].body[1] {
            *start = Some(7);
        }
    }
    fn text(frame: &Frame, output: &mut String) {
        for (_, item) in frame.items() {
            match item {
                FrameItem::Text(run) => output.push_str(run.text.as_str()),
                FrameItem::Group(group) => text(&group.frame, output),
                _ => {}
            }
        }
    }
    let paged = render_paged(&document, None).expect("ordered list");
    let mut output = String::new();
    for page in paged.pages() {
        text(&page.frame, &mut output);
    }
    assert!(output.contains("7."), "wrong list start: {output}");
    assert_full_coverage(&document, &text_map(&document));
}

#[test]
fn rejects_invalid_raster_scale_before_rendering() {
    for scale in [0.0, -1.0, f32::NAN, f32::INFINITY, 100.0] {
        assert!(matches!(
            render_page_png(&sample_document(), None, 0, scale),
            Err(EngineError::Validation(_))
        ));
    }
}

#[test]
fn css_line_height_maps_to_signed_typst_text_edges() {
    let mut document = sample_document();
    document.presentation.font_size_pt = 9.75;
    document.presentation.line_height_pt = 14.25;

    let layout = layout_json(
        &document,
        "#000000",
        "legacy",
        FontVerticalMetrics {
            body: (1.151, -0.286),
            body_family: "Source Han Serif",
            bundled_body: (1.151, -0.286),
            icon: (0.875, -0.125),
            heading: None,
            heading_family: None,
        },
        false,
        DEFAULT_REFERENCE_DATE,
    )
    .expect("layout mapping");
    let top = layout["textTopEm"].as_f64().expect("top edge");
    let bottom = layout["textBottomEm"].as_f64().expect("bottom edge");

    assert!(
        bottom < 0.0,
        "Typst bottom edge must stay below the baseline"
    );
    assert!(
        (top - bottom - 14.25 / 9.75).abs() < 1e-12,
        "baseline spacing must equal CSS line-height"
    );
}

// 1×1 红色 PNG，作为测试头像资源。
const AVATAR_PNG: &[u8] = &[
    0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x0D, 0x49, 0x48, 0x44, 0x52,
    0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0x53,
    0xDE, 0x00, 0x00, 0x00, 0x0C, 0x49, 0x44, 0x41, 0x54, 0x08, 0xD7, 0x63, 0xF8, 0xCF, 0xC0, 0x00,
    0x00, 0x03, 0x01, 0x01, 0x00, 0x18, 0xDD, 0x8D, 0xB0, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4E,
    0x44, 0xAE, 0x42, 0x60, 0x82,
];

pub(super) fn sample_document() -> ResumeDocument {
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
    double.presentation.title_format = zinecv_contracts::TitleFormat::DoubleLine;
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
            LeafItem::Text { node_id, text, .. } if !text.is_empty() => Some((node_id, text)),
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
    let units: Vec<u16> = map.logical_text.encode_utf16().collect();
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
            reconstructed.push_str(
                &String::from_utf16(
                    &units[cluster.start_utf16 as usize..cluster.end_utf16 as usize],
                )
                .expect("cluster utf16 slice"),
            );
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
            "某某大学\n - 计算机科学与技术 全日制\n2019年09月 - 2023年06月\n主修课程：编译原理\nGPA 3.8\n工作经历"
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
        if let zinecv_contracts::Section::Entry(ref mut section) = extra {
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
    if let zinecv_contracts::Section::Entry(section) = &mut document.sections[1] {
        section.entries[0]
            .body
            .push(zinecv_contracts::RichBlock::Paragraph {
                children: vec![zinecv_contracts::Inline::Text {
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
    document.presentation.title_format = zinecv_contracts::TitleFormat::DoubleLine;
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

/// 轻量化证据：内置字体以 `Bytes` 直接借用编译期 `'static` 常量，不再逐次复制。
/// `to_vec()` 分配的是堆内存，其地址不可能等于只读数据段中静态量的地址，
/// 因此指针相同即可证明没有发生复制。一页求解最多构造 16 次字体集合，
/// 每次省下约 22MB 的拷贝。
#[test]
fn bundled_font_bytes_are_zero_copy_static_views() {
    let fonts = RenderFontBytes::default();
    assert_eq!(
        fonts.regular.as_slice().as_ptr(),
        FONT_REGULAR_BYTES.as_ptr(),
        "regular font must alias the static bundled bytes"
    );
    assert_eq!(
        fonts.heavy.as_slice().as_ptr(),
        FONT_HEAVY_BYTES.as_ptr(),
        "heavy font must alias the static bundled bytes"
    );
    assert_eq!(
        fonts.icon.as_slice().as_ptr(),
        FONT_ICON_BYTES.as_ptr(),
        "icon font must alias the static bundled bytes"
    );
    assert_eq!(fonts.regular.as_slice().len(), FONT_REGULAR_BYTES.len());
    assert_eq!(fonts.heavy.as_slice().len(), FONT_HEAVY_BYTES.len());

    let again = RenderFontBytes::default();
    assert_eq!(
        again.regular.as_slice().as_ptr(),
        fonts.regular.as_slice().as_ptr(),
        "repeated construction must share one buffer"
    );
}

fn actual_glyph_fonts(frame: &Frame, families: &mut Vec<String>, missing: &mut usize) {
    for (_, item) in frame.items() {
        match item {
            FrameItem::Group(group) => actual_glyph_fonts(&group.frame, families, missing),
            FrameItem::Text(text) => {
                families.push(text.font.info().family.to_string());
                *missing += text.glyphs.iter().filter(|glyph| glyph.id == 0).count();
            }
            _ => {}
        }
    }
}

#[test]
fn bundled_hebrew_fallback_draws_actual_glyphs_instead_of_notdef() {
    let mut document = sample_document();
    document.basic.name = "אבג".into();
    document.sections.clear();
    let paged = render_paged_with_resources(
        &document,
        None,
        &bundled_font_bytes(),
        DEFAULT_REFERENCE_DATE,
    )
    .unwrap();
    let mut families = Vec::new();
    let mut missing = 0;
    for page in paged.pages() {
        actual_glyph_fonts(&page.frame, &mut families, &mut missing);
    }
    assert!(
        families
            .iter()
            .any(|family| family.eq_ignore_ascii_case("Noto Sans Hebrew")),
        "Hebrew needs its actual fallback glyph font"
    );
    assert_eq!(
        missing, 0,
        "Logical text coverage alone cannot prove visible glyphs"
    );
}

#[cfg(windows)]
#[test]
fn selected_body_fonts_reach_actual_glyphs_and_change_resource_identity() {
    let mut document = sample_document();
    document.basic.name = "字体选择 Sample".into();
    document.sections.clear();
    let mut identities = std::collections::HashSet::new();
    for (id, expected) in [
        ("legacy-font:雅黑", "Microsoft YaHei"),
        ("legacy-font:黑体", "SimHei"),
        ("legacy-font:楷体", "KaiTi"),
        ("legacy-font:仿宋", "FangSong"),
    ] {
        document.presentation.font_set_id = id.into();
        let fonts = native_font_bytes(&document).unwrap();
        let identity = FontIdentity::from_sha(&fonts);
        assert!(
            identities.insert(identity.selected_regular.unwrap()),
            "Different choices must not alias the old font cache"
        );
        let paged =
            render_paged_with_resources(&document, None, &fonts, DEFAULT_REFERENCE_DATE).unwrap();
        let mut families = Vec::new();
        let mut missing = 0;
        for page in paged.pages() {
            actual_glyph_fonts(&page.frame, &mut families, &mut missing);
        }
        assert!(
            families
                .iter()
                .any(|family| family.eq_ignore_ascii_case(expected)),
            "Selected font must reach real output: {id}: {families:?}"
        );
        assert_eq!(missing, 0);
    }
}
