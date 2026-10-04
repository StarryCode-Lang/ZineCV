//! 引擎对照工具的 CLI 渲染入口：读取 ResumeDocument JSON，输出单页 PNG。
//! 用法：engine_render <document.json> <out.png> [page=0] [pixel_per_pt=1.33333] [avatar_path] [--textmap <out.json>]
//! 仅供 tools/engine-parity.mjs 等本机验收工具使用，不进入正式应用入口。
use std::path::PathBuf;

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
    let remaining: Vec<String> = args.collect();
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
    let paged = zinecv_desktop_lib::engine::render_paged(&document, avatar.clone())
        .unwrap_or_else(|error| panic!("render failed: {error}"));
    let png = zinecv_desktop_lib::engine::render_paged_page_png(&paged, page, pixel_per_pt)
        .unwrap_or_else(|error| panic!("render failed: {error}"));
    std::fs::write(&output_path, png).expect("write output png");
    println!("wrote {}", output_path.display());
    println!(
        "ENGINE_RENDER {}",
        serde_json::json!({ "pageCount": paged.pages().len() })
    );
    if let Some(path) = textmap_path {
        let map = zinecv_desktop_lib::engine::render_text_map(&document, avatar)
            .unwrap_or_else(|error| panic!("text map failed: {error}"));
        let json = serde_json::to_string_pretty(&map).expect("serialize text map");
        std::fs::write(&path, json).expect("write text map json");
        println!("wrote {}", path.display());
    }
}
