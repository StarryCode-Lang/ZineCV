//! 引擎对照工具的 CLI 渲染入口：读取 ResumeDocument JSON，输出单页 PNG。
//! 用法：engine_render <document.json> <out.png> [page=0] [pixel_per_pt=1.33333] [avatar_path] [--textmap <out.json>]
//! 仅供 tools/engine-parity.mjs 等本机验收工具使用，不进入正式应用入口。
use std::path::PathBuf;
use typst::foundations::Value;
use typst::introspection::{MetadataElem, Tag};
use typst::layout::{Frame, FrameItem};

// Test-only raster isolation: retain positions/transforms from the compiled
// frame, and select text by the same semantic markers as TextMap.
fn isolate(frame: &Frame, target: &str, current: &mut String) -> Frame {
    let mut output = Frame::new(frame.size(), frame.kind());
    for (position, item) in frame.items() {
        match item {
            FrameItem::Group(group) => {
                let mut group = group.clone();
                group.frame = isolate(&group.frame, target, current);
                output.push(*position, FrameItem::Group(group));
            }
            FrameItem::Tag(Tag::Start(content, _)) => {
                if let Some(metadata) = content.to_packed::<MetadataElem>() {
                    if let Value::Str(value) = &metadata.value {
                        if let Some(id) = value.as_str().strip_prefix("node:") {
                            *current = id.to_owned();
                        }
                    }
                }
            }
            FrameItem::Text(_) if current == target => output.push(*position, item.clone()),
            _ => {}
        }
    }
    output
}

fn main() {
    let mut args = std::env::args().skip(1);
    let document_path = PathBuf::from(args.next().expect(
        "usage: engine_render <document.json> <out.png> [page] [ppp] [avatar] [--textmap out.json]",
    ));
    let output_path = PathBuf::from(args.next().expect(
        "usage: engine_render <document.json> <out.png> [page] [ppp] [avatar] [--textmap out.json]",
    ));
    let page: usize = args
        .next()
        .and_then(|value| value.parse().ok())
        .unwrap_or(0);
    // CSS px = pt × 4/3：paper 793.688px ↔ 595.27pt。
    let pixel_per_pt: f32 = args
        .next()
        .and_then(|value| value.parse().ok())
        .unwrap_or(4.0 / 3.0);
    let mut remaining: Vec<String> = args.collect();
    let isolated_directory = remaining
        .iter()
        .position(|value| value == "--isolated-dir")
        .map(|index| {
            let directory = PathBuf::from(remaining.remove(index + 1));
            remaining.remove(index);
            directory
        });
    let (avatar_path, textmap_path) = match remaining.as_slice() {
        [] => (None, None),
        [avatar] => (Some(PathBuf::from(avatar)), None),
        [flag, path] if flag == "--textmap" => (None, Some(PathBuf::from(path))),
        [avatar, flag, path] if flag == "--textmap" => {
            (Some(PathBuf::from(avatar)), Some(PathBuf::from(path)))
        }
        _ => panic!("expected [avatar_path] [--textmap out.json] after page and scale"),
    };

    let raw = std::fs::read_to_string(&document_path)
        .unwrap_or_else(|error| panic!("read {}: {error}", document_path.display()));
    let document: zinecv_desktop_lib::domain::ResumeDocument =
        serde_json::from_str(&raw).expect("parse ResumeDocument json");
    let avatar = avatar_path.map(|path| {
        let bytes = std::fs::read(&path)
            .unwrap_or_else(|error| panic!("read avatar {}: {error}", path.display()));
        let mime = match path.extension().and_then(|ext| ext.to_str()) {
            Some("jpg") | Some("jpeg") => "image/jpeg",
            Some("gif") => "image/gif",
            Some("svg") => "image/svg+xml",
            Some("webp") => "image/webp",
            _ => "image/png",
        };
        (mime.to_string(), bytes)
    });
    let fonts = zinecv_desktop_lib::engine::RenderFontBytes::default();
    let paged = zinecv_desktop_lib::engine::render_paged_with_resources(
        &document,
        avatar.clone(),
        &fonts,
        zinecv_desktop_lib::engine::DEFAULT_REFERENCE_DATE,
    )
    .unwrap_or_else(|error| panic!("render failed: {error}"));
    let png = zinecv_desktop_lib::engine::render_paged_page_png(&paged, page, pixel_per_pt)
        .unwrap_or_else(|error| panic!("render failed: {error}"));
    std::fs::write(&output_path, png).expect("write output png");
    println!("wrote {}", output_path.display());
    println!("ENGINE_RENDER {}", {
        use sha2::{Digest, Sha256};
        let hash =
            |bytes: &typst::foundations::Bytes| format!("{:x}", Sha256::digest(bytes.as_slice()));
        serde_json::json!({ "pageCount": paged.pages().len(), "fonts": {
                "regular": hash(&fonts.regular), "heavy": hash(&fonts.heavy), "icon": hash(&fonts.icon),
                "heading": fonts.heading.as_ref().map(|heading| serde_json::json!({
                    "family": heading.family, "regular": hash(&heading.regular), "bold": hash(&heading.bold),
                    "scope": "installed font snapshot; never bundled",
                })),
            } })
    });
    if let Some(path) = textmap_path {
        let map = zinecv_desktop_lib::engine::render_text_map(&document, avatar)
            .unwrap_or_else(|error| panic!("text map failed: {error}"));
        if let Some(directory) = isolated_directory {
            std::fs::create_dir_all(&directory).expect("create isolated directory");
            let ids: std::collections::BTreeSet<_> = map
                .clusters
                .iter()
                .map(|cluster| &cluster.source_node_id)
                .collect();
            for id in ids {
                let mut isolated_page = paged.pages()[page].clone();
                isolated_page.frame = isolate(&isolated_page.frame, id, &mut String::new());
                let png = typst_render::render(
                    &isolated_page,
                    &typst_render::RenderOptions {
                        pixel_per_pt: typst::utils::Scalar::new(pixel_per_pt as f64),
                        ..Default::default()
                    },
                )
                .encode_png()
                .expect("encode isolated PNG");
                let filename = format!("{}.png", id.replace([':', '/'], "_"));
                std::fs::write(directory.join(filename), png).expect("write isolated PNG");
            }
        }
        let json = serde_json::to_string_pretty(&map).expect("serialize text map");
        std::fs::write(&path, json).expect("write text map json");
        println!("wrote {}", path.display());
    }
}
