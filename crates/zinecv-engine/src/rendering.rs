use super::*;

/// 按旧版 CSS（preview.css + 两个模板覆盖）逐项换算版式参数。
/// px → pt 固定 ×0.75。
///
/// 行盒：Chromium 行布局用整数像素化的 hhea 度量（ascent/descent 按字号
/// round，半行距 floor），基线距行盒顶 = ascent + 半行距；多字体行取各
/// 行内盒调整后 ascent/descent 的最大值。该模型已由 engine-parity 探针
/// 逐元素实测校准（canvas fontBoundingBox + range rect + 字形轮廓），
/// 下行全部按 (基线偏移, 行盒高) 换算成该文本字号下的 top/bottom-edge，
/// 不能改回连续 em 近似（半行距取整造成最多 0.5px 的系统性偏差）。
/// 不能用负 leading 表达 line-height —— 负 leading 会让 Typst 整篇只出一页
/// （B07 实测定位，见 typst_poc 的 pagination_structure_variants 证据）。
pub(super) fn layout_json(
    document: &ResumeDocument,
    theme: &str,
    mode: &str,
    metrics: FontVerticalMetrics,
    has_avatar: bool,
    _reference_date: (i32, u8, u8),
) -> Result<serde_json::Value, EngineError> {
    let pres = &document.presentation;
    let px = |v: f64| v * 0.75;
    let fs_pt = pres.font_size_pt as f64;
    let lh_pt = pres.line_height_pt as f64;
    let em = |factor: f64, base_pt: f64| factor * base_pt;

    let (sh_asc, sh_desc) = metrics.body;
    let (ic_asc, ic_desc) = metrics.icon;
    let heading_strut = if mode == "clear" {
        metrics.heading.unwrap_or(metrics.bundled_body)
    } else {
        (sh_asc, sh_desc)
    };

    // Chromium 行盒：整数化 ascent/descent + 向下取整的半行距。
    let strut_offset = |asc_em: f64, desc_em: f64, font_px: f64, line_px: f64| -> f64 {
        let ascent = (asc_em * font_px).round();
        let descent = (-desc_em * font_px).round();
        ascent + ((line_px - ascent - descent) / 2.0).floor()
    };
    // (基线偏移, 行盒高) → Typst top/bottom-edge（em，相对该文本字号；
    // bottom-edge 传 top − extent，Typst 内部取负还原为基线下行距）。
    let edges = |offset_px: f64, extent_px: f64, font_px: f64| -> (f64, f64) {
        let top = offset_px / font_px;
        (top, top - extent_px / font_px)
    };

    let fs_px = fs_pt / 0.75;
    let lh_px = lh_pt / 0.75;
    // 正文与继承行高的一切文本（联系行文字、条目头、正文、列表）。
    let body_offset = strut_offset(sh_asc, sh_desc, fs_px, lh_px);
    let (text_top_em, text_bottom_em) = edges(body_offset, lh_px, fs_px);

    let (paper_color, title_strong_color, head_strong_color, contact_color, meta_color, rich_color) =
        match mode {
            "clear" => (
                "#28221e", "#251f1b", "#302923", "#504842", "#625952", "#37302b",
            ),
            "compact" => (
                "#252525", "#252525", "#252525", "#000000", "#252525", "#000000",
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
    // h1 行高与字号同比（三模板 line-height 均为 1），strut 按 clear 的
    // Georgia 栈首字体模拟。
    let h1_offset = strut_offset(heading_strut.0, heading_strut.1, h1_px, h1_px);
    let (h1_top_em, h1_bottom_em) = edges(h1_offset, h1_px, h1_px);

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

    // 节标题条：CSS 是 border-box（min-height 含 padding 与边框）。
    // lineBox 只放内容盒；Typst 的 block stroke 不占布局高度，因此
    // padding-bottom + 边框一起作为 inset，流高才与 border-box 一致。
    let strip_border_px = if title_border.is_some() { 1.0 } else { 0.0 };
    let strip_content_px = strip_px - title_pad_bottom_px - strip_border_px;
    let title_center_pt = px((strip_content_px - 13.0) / 2.0);
    let after_line_dy_pt = px((strip_content_px - 0.75) / 2.0);
    let title_bottom_inset_pt = px(title_pad_bottom_px + strip_border_px);

    // 节标题 strong：18px 字号固定，行盒 13px（.preview-title strong）。
    let strong_px = 18.0;
    let strong_line_px = 13.0;
    let strong_offset = strut_offset(heading_strut.0, heading_strut.1, strong_px, strong_line_px);
    let (strong_top_em, strong_bottom_em) = edges(strong_offset, strong_line_px, strong_px);

    // 条目头行：flex 基线对齐 → 行基线取两侧 strut 偏移的最大值；标题格
    // 为对齐基线向下延伸（clear 的 Georgia strut 偏移比日期格小 1px）。
    let head_title_offset = strut_offset(heading_strut.0, heading_strut.1, fs_px, lh_px);
    let head_dates_offset = strut_offset(sh_asc, sh_desc, fs_px, lh_px);
    let head_row_offset = head_title_offset.max(head_dates_offset);
    let head_title_extent_px = head_row_offset + (lh_px - head_title_offset.min(head_dates_offset));
    let (head_title_top_em, head_title_bottom_em) =
        edges(head_row_offset, head_title_extent_px, fs_px);
    let (head_dates_top_em, head_dates_bottom_em) = edges(head_row_offset, lh_px, fs_px);

    // iconfont 行内盒：联系行（字号固定 13px，行高继承正文）与站点/节
    // 标题的 13px 定高盒（13px 行高）。节标题图标 18px 字号在 13px 行盒。
    let contact_icon_px = 13.0;
    let contact_icon_offset = strut_offset(ic_asc, ic_desc, contact_icon_px, lh_px);
    let (contact_icon_top_em, contact_icon_bottom_em) =
        edges(contact_icon_offset, lh_px, contact_icon_px);
    let site_icon_offset = strut_offset(ic_asc, ic_desc, contact_icon_px, contact_icon_px);
    let (site_icon_top_em, site_icon_bottom_em) =
        edges(site_icon_offset, contact_icon_px, contact_icon_px);
    let strip_icon_offset = strut_offset(ic_asc, ic_desc, strong_px, strong_line_px);
    let (strip_icon_top_em, strip_icon_bottom_em) =
        edges(strip_icon_offset, strong_line_px, strong_px);
    let icon_cap_pt = px(strong_line_px);

    // clear 的 header-main 是真正的 grid（3px 行距）且 sites 有 1px 顶距；
    // legacy/compact 的 header-main 是块布局，gap 声明不生效。
    let header_row_gap_pt = if mode == "clear" { px(3.0) } else { 0.0 };
    let sites_top_gap_pt = if mode == "clear" { px(1.0) } else { 0.0 };

    // header 底边：padding-bottom + 边框作为 inset（stroke 不占布局高度）。
    let header_border_px = header_border
        .as_ref()
        .map(|border| border["sizePt"].as_f64().unwrap_or(0.0) * 4.0 / 3.0)
        .unwrap_or(0.0);
    let header_bottom_inset_pt = px(header_pad_bottom_px + header_border_px);

    // ul 圆点：直径 0.34em，文本缩进 1.15em；ol 左缩进 20px。
    let ul_marker_pt = em(0.34, fs_pt);
    let ul_indent_pt = em(1.15, fs_pt) - em(0.82, fs_pt);
    let ul_body_indent_pt = em(1.15, fs_pt) - ul_indent_pt - ul_marker_pt;
    let ol_pad_pt = px(20.0);

    let layout = serde_json::json!({
        "mode": mode,
        "bodyFont": [metrics.body_family, "Source Han Serif", "Noto Sans Hebrew"],
        "headingFont": if mode == "clear" { vec![metrics.heading_family.unwrap_or("Source Han Serif"), "Source Han Serif", "Noto Sans Hebrew"] } else { vec![metrics.body_family, "Source Han Serif", "Noto Sans Hebrew"] },
        "headingTrackingPt": if mode == "clear" { -0.01 * f64::from(pres.heading_size_pt) } else { 0.0 },
        "accent": theme,
        "paperColor": paper_color,
        "titleStrongColor": title_strong_color,
        "headStrongColor": head_strong_color,
        "contactColor": contact_color,
        "metaColor": meta_color,
        "inlineMetaColor": meta_color,
        "dateColor": if mode == "clear" { "#625952" } else { paper_color },
        "richColor": rich_color,
        "fontExtentEm": sh_asc - sh_desc,
        "textTopEm": text_top_em,
        "textBottomEm": text_bottom_em,
        "h1TopEm": h1_top_em,
        "h1BottomEm": h1_bottom_em,
        "strongTopEm": strong_top_em,
        "strongBottomEm": strong_bottom_em,
        "titleCenterPt": title_center_pt,
        "afterLineDyPt": after_line_dy_pt,
        "headTitleTopEm": head_title_top_em,
        "headTitleBottomEm": head_title_bottom_em,
        "headDatesTopEm": head_dates_top_em,
        "headDatesBottomEm": head_dates_bottom_em,
        "datesPadRightPt": px(1.0),
        "contactIconTopEm": contact_icon_top_em,
        "contactIconBottomEm": contact_icon_bottom_em,
        "siteIconTopEm": site_icon_top_em,
        "siteIconBottomEm": site_icon_bottom_em,
        "stripIconTopEm": strip_icon_top_em,
        "stripIconBottomEm": strip_icon_bottom_em,
        "iconCapPt": icon_cap_pt,
        "headerRowGapPt": header_row_gap_pt,
        "sitesTopGapPt": sites_top_gap_pt,
        "fsPt": fs_pt,
        "moduleGapPt": pres.module_gap_pt,
        "paraGapPt": pres.paragraph_gap_pt,
        "listGapPt": pres.list_gap_pt,
        "h1SizePt": h1_pt,
        "h1LineHpt": px(if mode == "legacy" { 21.0 } else { h1_px }),
        "h1MarginBottomPt": px(h1_mb_px),
        "h1TrackingPt": h1_tracking_em * h1_pt,
        "headerPadBottomPt": px(header_pad_bottom_px),
        "headerBottomInsetPt": header_bottom_inset_pt,
        "headerBorder": header_border,
        "stripContentPt": px(strip_content_px),
        "titleBottomInsetPt": title_bottom_inset_pt,
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

/// 编译当前文档为分页结果；编译警告按错误处理，避免静默降级。
pub fn render_paged(
    document: &ResumeDocument,
    avatar: AvatarAsset,
) -> Result<PagedDocument, EngineError> {
    render_paged_with_resources(
        document,
        avatar,
        &native_font_bytes(document)?,
        DEFAULT_REFERENCE_DATE,
    )
}

/// Compile using the immutable resource bytes and reference date frozen by the host.
pub fn render_paged_with_resources(
    document: &ResumeDocument,
    avatar: AvatarAsset,
    font_bytes: &RenderFontBytes,
    reference_date: (i32, u8, u8),
) -> Result<PagedDocument, EngineError> {
    let world = DocumentWorld::new(document, avatar, font_bytes, reference_date)?;
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

/// Produce a PDF and its page count from one frozen compile.
pub fn render_document_pdf_with_resources(
    document: &ResumeDocument,
    avatar: AvatarAsset,
    font_bytes: &RenderFontBytes,
    reference_date: (i32, u8, u8),
) -> Result<RenderedPdf, EngineError> {
    let paged = render_paged_with_resources(document, avatar, font_bytes, reference_date)?;
    let page_count = paged.pages().len();
    let bytes = typst_pdf::pdf(&paged, &Default::default())
        .map_err(|errors| EngineError::Compile(format!("{errors:?}")))?;
    Ok(RenderedPdf { bytes, page_count })
}

/// 排版当前文档并输出矢量 PDF。
pub fn render_document_pdf(
    document: &ResumeDocument,
    avatar: AvatarAsset,
) -> Result<Vec<u8>, EngineError> {
    Ok(render_document_pdf_with_resources(
        document,
        avatar,
        &native_font_bytes(document)?,
        DEFAULT_REFERENCE_DATE,
    )?
    .bytes)
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

/// SVG pages and selectable text share the same immutable compile.
pub fn render_preview_with_resources(
    document: &ResumeDocument,
    avatar: AvatarAsset,
    font_bytes: &RenderFontBytes,
    reference_date: (i32, u8, u8),
) -> Result<zinecv_contracts::PreviewData, EngineError> {
    use sha2::{Digest, Sha256};
    let paged = render_paged_with_resources(document, avatar, font_bytes, reference_date)?;
    let text_map = text_map::text_map_from_paged(document, &paged, reference_date)?;
    let pages = paged
        .pages()
        .iter()
        .map(|page| {
            let svg = typst_svg::svg(page, &Default::default());
            zinecv_contracts::PreviewPage {
                page_hash: format!("{:x}", Sha256::digest(svg.as_bytes())),
                width_pt: page.frame.size().x.to_pt(),
                height_pt: page.frame.size().y.to_pt(),
                svg,
            }
        })
        .collect();
    Ok(zinecv_contracts::PreviewData { pages, text_map })
}

/// 渲染单页 PNG（像素对照与预览栅格用）。pixel_per_pt 控制 DPI。
pub fn render_page_png(
    document: &ResumeDocument,
    avatar: AvatarAsset,
    page_index: usize,
    pixel_per_pt: f32,
) -> Result<Vec<u8>, EngineError> {
    if !pixel_per_pt.is_finite() || !(0.1..=8.0).contains(&pixel_per_pt) {
        return Err(EngineError::Validation(
            "Raster scale must be finite and within 0.1..=8".into(),
        ));
    }
    let paged = render_paged(document, avatar)?;
    render_paged_page_png(&paged, page_index, pixel_per_pt)
}

/// Rasterize a previously compiled page without a second layout pass.
pub fn render_paged_page_png(
    paged: &PagedDocument,
    page_index: usize,
    pixel_per_pt: f32,
) -> Result<Vec<u8>, EngineError> {
    if !pixel_per_pt.is_finite() || !(0.1..=8.0).contains(&pixel_per_pt) {
        return Err(EngineError::Validation("Invalid raster scale".into()));
    }
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
