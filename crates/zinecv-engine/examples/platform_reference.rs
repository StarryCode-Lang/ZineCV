//! Independent bundled-font native reference for Browser Gate A/B.
use std::path::PathBuf;
fn main() {
    let mut args = std::env::args().skip(1);
    let input = PathBuf::from(args.next().expect("document JSON"));
    let output = PathBuf::from(args.next().expect("output prefix"));
    let document: zinecv_contracts::ResumeDocument =
        serde_json::from_slice(&std::fs::read(input).unwrap()).unwrap();
    let fonts = zinecv_engine::bundled_font_bytes();
    let date = zinecv_engine::DEFAULT_REFERENCE_DATE;
    let preview =
        zinecv_engine::render_preview_with_resources(&document, None, &fonts, date).unwrap();
    std::fs::write(
        output.with_extension("json"),
        serde_json::to_vec(&preview).unwrap(),
    )
    .unwrap();
    let paged = zinecv_engine::render_paged_with_resources(&document, None, &fonts, date).unwrap();
    for page in 0..preview.pages.len() {
        let png = zinecv_engine::render_paged_page_png(&paged, page, 4.0 / 3.0).unwrap();
        std::fs::write(format!("{}-{page}.png", output.display()), png).unwrap();
    }
    let pdf =
        zinecv_engine::render_document_pdf_with_resources(&document, None, &fonts, date).unwrap();
    std::fs::write(output.with_extension("pdf"), pdf.bytes).unwrap();
    if args.next().as_deref() == Some("--fit") {
        let fit =
            zinecv_engine::fit::solve_one_page(&document, None, &fonts, date, || false).unwrap();
        std::fs::write(
            output.with_extension("fit.json"),
            serde_json::to_vec(&fit).unwrap(),
        )
        .unwrap();
    }
}
