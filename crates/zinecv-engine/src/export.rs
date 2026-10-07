//! PDF, PNG pages and a bounded white-background long image from one compile.
use super::{render_paged_with_resources, text_map, AvatarAsset, EngineError, RenderFontBytes};
use zinecv_contracts::{ExportProduct, ResumeDocument, TextMap};

pub const DEFAULT_DPI: u16 = 192;
pub const MAX_SELECTED_PIXELS: u64 = 64_000_000;
pub const MAX_LONG_PIXELS: u64 = 32_000_000;
const MAX_ENCODED_BYTES: usize = 48 * 1024 * 1024;

#[derive(Debug)]
pub struct PngPage {
    pub page: u32,
    pub width: u32,
    pub height: u32,
    pub bytes: Vec<u8>,
}

#[derive(Debug)]
pub struct FrozenExport {
    pub pdf: Vec<u8>,
    pub page_count: usize,
    pub text_map: TextMap,
    pub png_pages: Vec<PngPage>,
    pub long_png: Option<PngPage>,
    /// Consumers must offer selected pages when a long image exceeds its budget.
    pub long_image_limited: bool,
    pub dpi: u16,
    /// Echoed product selection (`None` = Bundle) so payloads stay auditable.
    pub product: Option<ExportProduct>,
    /// Sorted, deduplicated one-based page numbers when a `Pdf` selection applied.
    pub selected_pages: Option<Vec<u32>>,
}

impl FrozenExport {
    pub fn into_payload(self) -> zinecv_contracts::ExportData {
        use base64::{engine::general_purpose::STANDARD, Engine as _};
        use sha2::{Digest, Sha256};
        let image = |page: PngPage| zinecv_contracts::ExportPng {
            page: page.page,
            width: page.width,
            height: page.height,
            sha256: format!("{:x}", Sha256::digest(&page.bytes)),
            data_base64: STANDARD.encode(page.bytes),
        };
        zinecv_contracts::ExportData {
            pdf_sha256: format!("{:x}", Sha256::digest(&self.pdf)),
            pdf_base64: STANDARD.encode(self.pdf),
            page_count: self.page_count as u32,
            text_map: self.text_map,
            png_pages: self.png_pages.into_iter().map(image).collect(),
            long_png: self.long_png.map(image),
            long_image_limited: self.long_image_limited,
            dpi: self.dpi,
            product: self.product,
            selected_pages: self.selected_pages,
        }
    }
}

/// Png-only payloads carry no text layer; keep the TextMap envelope versioned
/// and empty instead of inventing a second shape.
fn empty_text_map() -> TextMap {
    TextMap {
        version: 1,
        logical_text: String::new(),
        clusters: Vec::new(),
        hit_regions: Vec::new(),
        links: Vec::new(),
    }
}

fn dimensions(width_pt: f64, height_pt: f64, dpi: u16) -> Result<(u32, u32), EngineError> {
    if !(72..=300).contains(&dpi)
        || !width_pt.is_finite()
        || !height_pt.is_finite()
        || width_pt <= 0.0
        || height_pt <= 0.0
    {
        return Err(EngineError::Validation("Invalid export size or DPI".into()));
    }
    // Preserve the old default 2 × ceil(CSS pixels), rather than rounded Typst pixels.
    let size = |pt: f64| {
        if dpi == DEFAULT_DPI {
            2.0 * (pt * 4.0 / 3.0).ceil()
        } else {
            (pt * f64::from(dpi) / 72.0).ceil()
        }
    };
    let (width, height) = (size(width_pt), size(height_pt));
    if width > 32_768.0 || height > 32_768.0 {
        return Err(EngineError::Validation(
            "PNG dimensions exceed the export budget".into(),
        ));
    }
    Ok((width as u32, height as u32))
}

fn png(canvas: &tiny_skia::Pixmap) -> Result<Vec<u8>, EngineError> {
    canvas
        .encode_png()
        .map_err(|error| EngineError::Compile(format!("PNG encode failed: {error}")))
}

/// `selected_pages` contains one-based page numbers and only applies when
/// `product` is `Pdf` with a non-empty list: it is sorted, deduplicated and
/// validated against the frozen document up front; out-of-range pages are an
/// error, never silently dropped. `product = None` behaves exactly like
/// `ExportProduct::Bundle` — the historical full pipeline (all-page PNG + long
/// image + PDF + TextMap under every budget check).
pub fn render_frozen_export(
    document: &ResumeDocument,
    avatar: AvatarAsset,
    fonts: &RenderFontBytes,
    reference_date: (i32, u8, u8),
    selected_pages: Option<&[u32]>,
    dpi: u16,
    product: Option<ExportProduct>,
) -> Result<FrozenExport, EngineError> {
    if !(72..=300).contains(&dpi) {
        return Err(EngineError::Validation(
            "Export DPI must be between 72 and 300".into(),
        ));
    }
    let pdf_only = matches!(product, Some(ExportProduct::Pdf));
    let png_only = matches!(product, Some(ExportProduct::Png));
    let paged = render_paged_with_resources(document, avatar, fonts, reference_date)?;
    let page_count = paged.pages().len();
    if page_count == 0 || page_count > 200 {
        return Err(EngineError::Validation(
            "Export page count exceeds the budget".into(),
        ));
    }
    // 页码选择：仅 product=Pdf 且非空时生效。先排序去重并整体校验 1-based
    // 范围（0 与越界页都明确报错），再逐页映射为 typst_pdf 的 one-indexed
    // 页区间。
    let (pdf_page_ranges, selected_normalized): (
        Option<typst::layout::PageRanges>,
        Option<Vec<u32>>,
    ) = match (product, selected_pages) {
        (Some(ExportProduct::Pdf), Some(pages)) if !pages.is_empty() => {
            let mut unique: Vec<u32> = pages.to_vec();
            unique.sort_unstable();
            unique.dedup();
            if unique
                .iter()
                .any(|&page| page == 0 || page as usize > page_count)
            {
                return Err(EngineError::Validation(format!(
                    "Selected export pages fall outside the frozen document's 1-{page_count} pages"
                )));
            }
            let ranges = typst::layout::PageRanges::new(
                unique
                    .iter()
                    .map(|&page| {
                        let page = std::num::NonZeroUsize::new(page as usize)
                            .expect("selected export page is nonzero");
                        Some(page)..=Some(page)
                    })
                    .collect(),
            );
            (Some(ranges), Some(unique))
        }
        _ => (None, None),
    };
    // PNG 栅格页：Pdf 产物不栅格任何页（也就没有像素预算与长图）；
    // Png 与 Bundle 栅格全部页，保持 Bundle 的现行完整行为。
    let indices: std::collections::BTreeSet<usize> = if pdf_only {
        std::collections::BTreeSet::new()
    } else {
        (0..page_count).collect()
    };
    let mut sizes = Vec::new();
    let (mut total_pixels, mut long_width, mut long_height) = (0_u64, 0_u32, 0_u32);
    for index in indices {
        let size = paged.pages()[index].frame.size();
        let (width, height) = dimensions(size.x.to_pt(), size.y.to_pt(), dpi)?;
        total_pixels += u64::from(width) * u64::from(height);
        long_width = long_width.max(width);
        long_height = long_height
            .checked_add(height)
            .ok_or_else(|| EngineError::Validation("Long PNG height overflow".into()))?;
        sizes.push((index, width, height));
    }
    if !pdf_only && total_pixels > MAX_SELECTED_PIXELS {
        return Err(EngineError::Validation(
            "PNG selection exceeds the pixel budget; select fewer pages".into(),
        ));
    }
    let long_image_limited = if pdf_only {
        false
    } else {
        u64::from(long_width) * u64::from(long_height) > MAX_LONG_PIXELS || long_height > 32_768
    };
    let mut long = if pdf_only || long_image_limited {
        None
    } else {
        Some(
            tiny_skia::Pixmap::new(long_width, long_height).ok_or_else(|| {
                EngineError::Validation("Cannot allocate bounded long PNG".into())
            })?,
        )
    };
    if let Some(canvas) = &mut long {
        canvas.fill(tiny_skia::Color::WHITE);
    }
    // PDF：Png 产物不编码 PDF；Pdf 产物可按 one-indexed 页码选择导出子集。
    let pdf = if png_only {
        Vec::new()
    } else if let Some(ranges) = &pdf_page_ranges {
        // typst-pdf 0.15 约束：tagged PDF 与 page range 互斥。整档导出保持
        // tagged 默认（可搜索/结构树契约不变）；仅页选子集导出显式关闭
        // 标签层，文本层仍可搜索复制。
        let options = typst_pdf::PdfOptions {
            page_ranges: Some(ranges.clone()),
            tagged: false,
            ..Default::default()
        };
        typst_pdf::pdf(&paged, &options)
            .map_err(|errors| EngineError::Compile(format!("{errors:?}")))?
    } else {
        typst_pdf::pdf(&paged, &Default::default())
            .map_err(|errors| EngineError::Compile(format!("{errors:?}")))?
    };
    // 正式文本层仅 Pdf/Bundle 生成；Png 产物携带空的版本化信封。
    let text_map = if png_only {
        empty_text_map()
    } else {
        text_map::text_map_from_paged(document, &paged, reference_date)?
    };
    let mut encoded_bytes = pdf.len();
    let mut png_pages = Vec::new();
    let mut offset = 0;
    for (index, width, height) in sizes {
        let raster = typst_render::render(
            &paged.pages()[index],
            &typst_render::RenderOptions {
                pixel_per_pt: typst::utils::Scalar::new(f64::from(dpi) / 72.0),
                ..Default::default()
            },
        );
        let mut canvas = tiny_skia::Pixmap::new(width, height)
            .ok_or_else(|| EngineError::Validation("Cannot allocate bounded page PNG".into()))?;
        canvas.fill(tiny_skia::Color::WHITE);
        canvas.draw_pixmap(
            0,
            0,
            raster.as_ref(),
            &Default::default(),
            tiny_skia::Transform::identity(),
            None,
        );
        if let Some(long) = &mut long {
            long.draw_pixmap(
                0,
                offset,
                canvas.as_ref(),
                &Default::default(),
                tiny_skia::Transform::identity(),
                None,
            );
        }
        offset += height as i32;
        let bytes = png(&canvas)?;
        encoded_bytes += bytes.len();
        if encoded_bytes > MAX_ENCODED_BYTES {
            return Err(EngineError::Validation(
                "Encoded export exceeds the output budget".into(),
            ));
        }
        png_pages.push(PngPage {
            page: index as u32 + 1,
            width,
            height,
            bytes,
        });
    }
    let long_png = long
        .map(|canvas| {
            png(&canvas).map(|bytes| PngPage {
                page: 0,
                width: long_width,
                height: long_height,
                bytes,
            })
        })
        .transpose()?;
    if encoded_bytes + long_png.as_ref().map_or(0, |image| image.bytes.len()) > MAX_ENCODED_BYTES {
        return Err(EngineError::Validation(
            "Encoded export exceeds the output budget".into(),
        ));
    }
    Ok(FrozenExport {
        pdf,
        page_count,
        text_map,
        png_pages,
        long_png,
        long_image_limited,
        dpi,
        product,
        selected_pages: selected_normalized,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn default_dimensions_preserve_two_times_ceil_css_and_dpi_is_explicit() {
        assert_eq!(
            dimensions(595.27, 841.89, DEFAULT_DPI).unwrap(),
            (1588, 2246)
        );
        assert_eq!(dimensions(595.27, 841.89, 72).unwrap(), (596, 842));
        assert!(dimensions(595.27, 841.89, 301).is_err());
        assert!(dimensions(f64::NAN, 841.89, DEFAULT_DPI).is_err());
    }

    #[test]
    fn same_compile_pdf_png_text_and_long_image_have_matching_page_order() {
        let mut document = crate::tests::sample_document();
        if let zinecv_contracts::Section::Summary(summary) = &mut document.sections[2] {
            summary.body = vec![zinecv_contracts::RichBlock::Paragraph {
                children: vec![zinecv_contracts::Inline::Text {
                    text: "统一导出正文顺序。".repeat(400),
                    marks: vec![],
                }],
            }];
        }
        let before = document.clone();
        let output = render_frozen_export(
            &document,
            None,
            &RenderFontBytes::default(),
            super::super::DEFAULT_REFERENCE_DATE,
            None,
            DEFAULT_DPI,
            None,
        )
        .unwrap();
        assert_eq!(document, before);
        assert!(output.pdf.starts_with(b"%PDF-"));
        assert!(output.page_count > 1);
        assert_eq!(output.png_pages.len(), output.page_count);
        assert!(output.text_map.logical_text.contains("统一导出正文顺序。"));
        let long = tiny_skia::Pixmap::decode_png(&output.long_png.unwrap().bytes).unwrap();
        assert_eq!(long.width(), 1588);
        assert_eq!(long.height(), 2246 * output.page_count as u32);
        let mut offset = 0;
        for (index, page) in output.png_pages.iter().enumerate() {
            assert_eq!(page.page as usize, index + 1);
            assert_eq!((page.width, page.height), (1588, 2246));
            let decoded = tiny_skia::Pixmap::decode_png(&page.bytes).unwrap();
            let start = offset as usize * long.width() as usize * 4;
            assert_eq!(
                &long.data()[start..start + decoded.data().len()],
                decoded.data()
            );
            offset += page.height;
        }
    }

    /// Pdf 产物：不栅格 PNG、不做长图，但仍产出完整 TextMap；1-based 页码
    /// 选择排序去重后生效，越界页必须明确报错（不得静默丢弃）。
    #[test]
    fn pdf_product_skips_png_pipeline_and_applies_one_based_selection() {
        use zinecv_contracts::ExportProduct;
        let mut document = crate::tests::sample_document();
        // sample_document 单页即可容纳；塞入重复段落到 Summary 节制造 2 页，
        // 让 [2,1,1] 的选择覆盖跨页与去重语义。
        if let zinecv_contracts::Section::Summary(summary) = &mut document.sections[2] {
            summary.body = vec![zinecv_contracts::RichBlock::Paragraph {
                children: vec![zinecv_contracts::Inline::Text {
                    text: "统一导出正文顺序。".repeat(400),
                    marks: vec![],
                }],
            }];
        }
        let fonts = RenderFontBytes::default();
        let date = super::super::DEFAULT_REFERENCE_DATE;
        assert!(
            render_frozen_export(
                &document,
                None,
                &fonts,
                date,
                Some(&[1, 99]),
                DEFAULT_DPI,
                Some(ExportProduct::Pdf),
            )
            .is_err(),
            "out-of-range pages must fail loudly"
        );
        assert!(
            render_frozen_export(
                &document,
                None,
                &fonts,
                date,
                Some(&[0, 1]),
                DEFAULT_DPI,
                Some(ExportProduct::Pdf),
            )
            .is_err(),
            "page numbers are one-based; 0 is out of range"
        );
        let output = render_frozen_export(
            &document,
            None,
            &fonts,
            date,
            Some(&[2, 1, 1]),
            DEFAULT_DPI,
            Some(ExportProduct::Pdf),
        )
        .unwrap();
        assert!(output.pdf.starts_with(b"%PDF-"));
        assert!(output.png_pages.is_empty());
        assert!(output.long_png.is_none());
        assert!(!output.long_image_limited);
        assert_eq!(output.selected_pages.as_deref(), Some(&[1_u32, 2][..]));
        assert_eq!(output.product, Some(ExportProduct::Pdf));
        // 文本层覆盖被选页：第 1 页正文与第 2 页 Summary 段落都应在逻辑文本中。
        assert!(output.text_map.logical_text.contains("某某大学"));
        assert!(output.text_map.logical_text.contains("统一导出正文顺序"));
    }

    /// Png 产物：不编码 PDF、不携带文本层，但保留全部 PNG 页与长图。
    #[test]
    fn png_product_skips_pdf_and_text_map_but_keeps_all_pages() {
        use zinecv_contracts::ExportProduct;
        let document = crate::tests::sample_document();
        let output = render_frozen_export(
            &document,
            None,
            &RenderFontBytes::default(),
            super::super::DEFAULT_REFERENCE_DATE,
            None,
            DEFAULT_DPI,
            Some(ExportProduct::Png),
        )
        .unwrap();
        assert!(output.pdf.is_empty());
        assert_eq!(output.png_pages.len(), output.page_count);
        assert!(output.text_map.logical_text.is_empty());
        assert!(output.text_map.clusters.is_empty());
        assert!(output.long_png.is_some());
        assert_eq!(output.product, Some(ExportProduct::Png));
        assert_eq!(output.selected_pages, None);
    }
}
