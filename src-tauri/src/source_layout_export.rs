//! Host-side identity checks for source-layout export inputs.
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use zinecv_contracts::{AppError, ErrorCode, ExportData, ExportPng, ExportProduct, ResumeDocument};

fn invalid(message: &'static str) -> AppError {
    AppError::new(ErrorCode::Validation, message, false)
}

fn decode_png(
    image: &ExportPng,
    width: u32,
    height: u32,
    total: &mut usize,
) -> Result<tiny_skia::Pixmap, AppError> {
    if image.width != width || image.height != height {
        return Err(invalid("原版式 PNG 尺寸不一致"));
    }
    let bytes = crate::export_io::decode_export_payload(&image.data_base64)?;
    *total = total
        .checked_add(bytes.len())
        .ok_or_else(|| invalid("原版式 PNG 过大"))?;
    if *total > 48 * 1024 * 1024 || format!("{:x}", Sha256::digest(&bytes)) != image.sha256 {
        return Err(invalid("原版式 PNG 摘要或大小无效"));
    }
    // Check IHDR before decoding to prevent untrusted dimensions allocating large buffers.
    if bytes.len() < 24
        || &bytes[..8] != b"\x89PNG\r\n\x1a\n"
        || &bytes[12..16] != b"IHDR"
        || u32::from_be_bytes(bytes[16..20].try_into().unwrap()) != width
        || u32::from_be_bytes(bytes[20..24].try_into().unwrap()) != height
    {
        return Err(invalid("原版式 PNG 文件头无效"));
    }
    tiny_skia::Pixmap::decode_png(&bytes).map_err(|_| invalid("原版式 PNG 无法解码"))
}

/// Decode and verify source-layout PNGs before issuing a host export ticket.
pub fn validate_source_png(data: &ExportData) -> Result<(), AppError> {
    let width = 794 * u32::from(data.dpi) / 96;
    let height = 1123 * u32::from(data.dpi) / 96;
    let count = data.page_count as usize;
    if count == 0
        || count > 50
        || data.png_pages.len() != count
        || !(72..=300).contains(&data.dpi)
        || data.product != Some(ExportProduct::Png)
        || data.selected_pages.is_some()
        || !data.pdf_base64.is_empty()
        || (count as u64) * u64::from(width) * u64::from(height) > 64_000_000
    {
        return Err(invalid("原版式 PNG 输出参数无效"));
    }
    let long_height = height
        .checked_mul(data.page_count)
        .ok_or_else(|| invalid("原版式 PNG 高度无效"))?;
    let limited = u64::from(width) * u64::from(long_height) > 32_000_000 || long_height > 32_768;
    if data.long_image_limited != limited || data.long_png.is_some() == limited {
        return Err(invalid("原版式 PNG 长图状态无效"));
    }
    let mut total = 0usize;
    let long = match &data.long_png {
        Some(image) if image.page == 0 => Some(decode_png(image, width, long_height, &mut total)?),
        Some(_) => return Err(invalid("原版式 PNG 长图编号无效")),
        None => None,
    };
    let page_bytes = (width as usize) * (height as usize) * 4;
    for (index, image) in data.png_pages.iter().enumerate() {
        if image.page as usize != index + 1 {
            return Err(invalid("原版式 PNG 页序无效"));
        }
        let decoded = decode_png(image, width, height, &mut total)?;
        if let Some(long) = &long {
            let start = index * page_bytes;
            if long.data()[start..start + page_bytes] != *decoded.data() {
                return Err(invalid("原版式 PNG 长图与分页不一致"));
            }
        }
    }
    Ok(())
}

/// Match the request against the frozen document and the current durable catalog.
/// The returned resource IDs must still be loaded and verified by the caller.
pub fn validate_source_layout(
    document: &ResumeDocument,
    catalog: &Value,
    template_id: &str,
    revision: &str,
    edits: &Value,
    page_count: usize,
) -> Result<Vec<String>, AppError> {
    if template_id.is_empty()
        || revision.len() != 64
        || !revision.bytes().all(|b| b.is_ascii_hexdigit())
    {
        return Err(invalid("原版式模板身份无效"));
    }
    let identity = document
        .legacy_extensions
        .get("importedTemplate")
        .ok_or_else(|| invalid("文档没有原版式模板"))?;
    if identity.get("id").and_then(Value::as_str) != Some(template_id)
        || identity.get("revisionHash").and_then(Value::as_str) != Some(revision)
    {
        return Err(invalid("文档的原版式模板修订不匹配"));
    }
    let empty = serde_json::json!({});
    let stored_edits = match document.legacy_extensions.get("sourceLayoutEdits") {
        Some(saved) if !saved.is_null() => {
            if saved.get("templateId").and_then(Value::as_str) != Some(template_id)
                || saved.get("revisionHash").and_then(Value::as_str) != Some(revision)
            {
                return Err(invalid("文档的原版式文字所属修订不匹配"));
            }
            saved
                .get("edits")
                .ok_or_else(|| invalid("原版式文字数据无效"))?
        }
        _ => &empty,
    };
    let requested = edits
        .as_object()
        .ok_or_else(|| invalid("原版式文字数据无效"))?;
    if stored_edits != edits || requested.len() > 10_000 {
        return Err(invalid("原版式文字与冻结文档不一致"));
    }
    let entries = catalog
        .as_array()
        .ok_or_else(|| invalid("原版式模板目录无效"))?;
    let mut matches = entries
        .iter()
        .filter(|entry| entry.get("id").and_then(Value::as_str) == Some(template_id));
    let template = matches.next().ok_or_else(|| invalid("原版式模板不存在"))?;
    if matches.next().is_some()
        || template.get("revisionHash").and_then(Value::as_str) != Some(revision)
    {
        return Err(invalid("原版式模板修订已变化"));
    }
    let layout = template
        .get("sourceLayout")
        .ok_or_else(|| invalid("原版式页面不存在"))?;
    let pages = layout
        .get("pages")
        .and_then(Value::as_array)
        .ok_or_else(|| invalid("原版式页面无效"))?;
    if pages.is_empty() || pages.len() > 50 || pages.len() != page_count {
        return Err(invalid("原版式页数不一致"));
    }
    let mut resources = Vec::with_capacity(pages.len());
    for page in pages {
        let hash = page
            .get("backgroundAssetId")
            .and_then(Value::as_str)
            .ok_or_else(|| invalid("原版式背景资源缺失"))?;
        if hash.len() != 64 || !hash.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            return Err(invalid("原版式背景资源无效"));
        }
        resources.push(hash.to_owned());
    }
    let boxes = layout
        .get("boxes")
        .and_then(Value::as_array)
        .ok_or_else(|| invalid("原版式文字框无效"))?;
    let mut ids = HashSet::new();
    for item in boxes {
        let id = item
            .get("id")
            .and_then(Value::as_str)
            .filter(|id| !id.is_empty())
            .ok_or_else(|| invalid("原版式文字框无效"))?;
        let page = item
            .get("page")
            .and_then(Value::as_u64)
            .ok_or_else(|| invalid("原版式文字框页码无效"))?;
        if !ids.insert(id) || page == 0 || page > pages.len() as u64 {
            return Err(invalid("原版式文字框无效"));
        }
    }
    if requested
        .iter()
        .any(|(id, text)| !ids.contains(id.as_str()) || !text.is_string())
    {
        return Err(invalid("原版式文字与模板不匹配"));
    }
    Ok(resources)
}

/// Build expected editable text and approximate A4 geometry from durable layout data.
pub fn source_layout_text_map(
    layout: &Value,
    edits: &Value,
) -> Result<zinecv_contracts::TextMap, AppError> {
    use zinecv_contracts::{SourcePageLink, TextCluster, TextMap};
    let pages = layout
        .get("pages")
        .and_then(Value::as_array)
        .ok_or_else(|| invalid("原版式页面无效"))?;
    let boxes = layout
        .get("boxes")
        .and_then(Value::as_array)
        .ok_or_else(|| invalid("原版式文字框无效"))?;
    let edits = edits
        .as_object()
        .ok_or_else(|| invalid("原版式文字数据无效"))?;
    let number = |item: &Value, key: &str| {
        item.get(key)
            .and_then(Value::as_f64)
            .filter(|value| value.is_finite())
            .ok_or_else(|| invalid("原版式文字框坐标无效"))
    };
    let mut logical_text = String::new();
    let mut clusters = Vec::new();
    let mut offset = 0_u32;
    for (page_index, page) in pages.iter().enumerate() {
        let width = number(page, "width")?;
        let height = number(page, "height")?;
        if width <= 0.0 || height <= 0.0 {
            return Err(invalid("原版式页面尺寸无效"));
        }
        let scale = (794.0 / width).min(1123.0 / height);
        let left = (794.0 - width * scale) / 2.0;
        let top = (1123.0 - height * scale) / 2.0;
        let mut has_text = false;
        for item in boxes
            .iter()
            .filter(|item| item.get("page").and_then(Value::as_u64) == Some(page_index as u64 + 1))
        {
            let id = item
                .get("id")
                .and_then(Value::as_str)
                .ok_or_else(|| invalid("原版式文字框无效"))?;
            let original = item
                .get("text")
                .and_then(Value::as_str)
                .ok_or_else(|| invalid("原版式文字无效"))?;
            let text = edits
                .get(id)
                .map(|value| value.as_str().ok_or_else(|| invalid("原版式修改文字无效")))
                .transpose()?
                .unwrap_or(original);
            if text.is_empty() {
                continue;
            }
            has_text |= !text.trim().is_empty();
            let length = u32::try_from(text.encode_utf16().count())
                .map_err(|_| invalid("原版式文字过长"))?;
            let end = offset
                .checked_add(length)
                .ok_or_else(|| invalid("原版式文字过长"))?;
            clusters.push(TextCluster {
                source_node_id: format!("source:{id}"),
                start_utf16: offset,
                end_utf16: end,
                logical_order: clusters.len() as u32,
                page: page_index as u32 + 1,
                x_pt: (left + number(item, "x")? * scale) * 0.75,
                y_pt: (top + number(item, "y")? * scale) * 0.75,
                width_pt: number(item, "width")? * scale * 0.75,
                height_pt: number(item, "height")? * scale * 0.75,
                rtl: false,
            });
            logical_text.push_str(text);
            offset = end;
        }
        if !has_text {
            return Err(invalid("部分页面没有可编辑文字，请先识别并核对"));
        }
    }
    let page_links = match (layout.get("sourceLinks"), layout.get("linkStatus")) {
        (None, None) => None,
        (Some(Value::Array(items)), Some(Value::String(status)))
            if status == "complete" && items.len() <= 10_000 =>
        {
            let mut result = Vec::with_capacity(items.len());
            for item in items {
                let page_number = item
                    .get("page")
                    .and_then(Value::as_u64)
                    .and_then(|value| u32::try_from(value).ok())
                    .filter(|value| *value > 0)
                    .ok_or_else(|| invalid("原版式链接页码无效"))?;
                let page = pages
                    .get((page_number - 1) as usize)
                    .ok_or_else(|| invalid("原版式链接页码无效"))?;
                let width = number(page, "width")?;
                let height = number(page, "height")?;
                let x = number(item, "x")?;
                let y = number(item, "y")?;
                let link_width = number(item, "width")?;
                let link_height = number(item, "height")?;
                if x < 0.0
                    || y < 0.0
                    || link_width <= 0.0
                    || link_height <= 0.0
                    || x + link_width > width
                    || y + link_height > height
                {
                    return Err(invalid("原版式链接坐标无效"));
                }
                let href = item
                    .get("href")
                    .and_then(Value::as_str)
                    .filter(|value| value.len() <= 2048)
                    .ok_or_else(|| invalid("原版式链接地址无效"))?;
                let url = url::Url::parse(href).map_err(|_| invalid("原版式链接地址无效"))?;
                if !matches!(url.scheme(), "http" | "https" | "mailto") {
                    return Err(invalid("原版式链接地址无效"));
                }
                let scale = (794.0 / width).min(1123.0 / height);
                let left = (794.0 - width * scale) / 2.0;
                let top = (1123.0 - height * scale) / 2.0;
                result.push(SourcePageLink {
                    page: page_number,
                    x_pt: (left + x * scale) * 0.75,
                    y_pt: (top + y * scale) * 0.75,
                    width_pt: link_width * scale * 0.75,
                    height_pt: link_height * scale * 0.75,
                    href: url.to_string(),
                });
            }
            Some(result)
        }
        _ => return Err(invalid("源 PDF 链接未完整恢复，请核对原文件")),
    };
    Ok(TextMap {
        version: 1,
        logical_text,
        clusters,
        hit_regions: vec![],
        links: vec![],
        page_links,
    })
}

pub(crate) fn freeze_source_context(
    store: &crate::storage::Store,
    cursor: &zinecv_contracts::AuthorityCursor,
    template_id: &str,
    revision: &str,
    edits: &Value,
    page_count: usize,
) -> Result<(zinecv_contracts::FrozenExportSource, Value), AppError> {
    let (document, _) = store.freeze_export(cursor).map_err(AppError::from)?;
    let graph = store
        .load_version_graph(&cursor.document_id)
        .map_err(AppError::from)?;
    if graph.cursor != *cursor {
        return Err(invalid("原版式导出目标修订已变化"));
    }
    let branch = graph
        .branches
        .iter()
        .find(|branch| branch.id == cursor.branch_id)
        .ok_or_else(|| invalid("原版式导出分支不存在"))?;
    let catalog = store
        .read_imported_template_catalog()
        .map_err(AppError::from)?
        .ok_or_else(|| invalid("原版式模板目录不存在"))?;
    let catalog: Value =
        serde_json::from_str(&catalog.payload_json).map_err(|_| invalid("原版式模板目录无效"))?;
    let resources = validate_source_layout(
        &document,
        &catalog,
        template_id,
        revision,
        edits,
        page_count,
    )?;
    for hash in resources {
        let (_, bytes) = store
            .read_resource_bytes(&hash)
            .map_err(AppError::from)?
            .ok_or_else(|| invalid("原版式背景资源不存在"))?;
        if format!("{:x}", Sha256::digest(&bytes)) != hash.to_ascii_lowercase() {
            return Err(invalid("原版式背景资源摘要不一致"));
        }
    }
    let layout = catalog
        .as_array()
        .and_then(|items| {
            items
                .iter()
                .find(|item| item.get("id").and_then(Value::as_str) == Some(template_id))
        })
        .and_then(|item| item.get("sourceLayout"))
        .ok_or_else(|| invalid("原版式模板不存在"))?;
    let layout_bytes = serde_json::to_vec(layout).map_err(|_| invalid("原版式模板无效"))?;
    let mut source = crate::export_sessions::frozen_source(&document, branch.name.clone());
    source.template_id = template_id.to_owned();
    source.template_revision = revision.to_owned();
    source.template_source_sha256 = format!("{:x}", Sha256::digest(&layout_bytes));
    Ok((source, layout.clone()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::{engine::general_purpose::STANDARD, Engine as _};
    use serde_json::json;
    use sha2::{Digest, Sha256};
    use zinecv_contracts::{ExportData, ExportPng, ExportProduct, TextMap};

    #[test]
    fn pdf_text_map_preserves_page_order_edits_and_utf16_offsets() {
        let layout = json!({"pages":[{"width":794,"height":1123},{"width":794,"height":1123}],
            "boxes":[{"id":"b","page":2,"text":"second","x":5,"y":10,"width":100,"height":20},
                     {"id":"a","page":1,"text":"first","x":5,"y":10,"width":100,"height":20}]});
        let map = source_layout_text_map(&layout, &json!({"a":"新😀"})).unwrap();
        assert_eq!(map.logical_text, "新😀second");
        assert_eq!(
            (
                map.clusters[0].page,
                map.clusters[0].start_utf16,
                map.clusters[0].end_utf16
            ),
            (1, 0, 3)
        );
        assert_eq!((map.clusters[1].page, map.clusters[1].start_utf16), (2, 3));
        assert!(source_layout_text_map(&layout, &json!({"a":""})).is_err());
    }

    #[test]
    fn source_pdf_links_are_bound_to_page_geometry_and_validated() {
        let mut layout = json!({"pages":[{"width":794,"height":1123}],
        "boxes":[{"id":"a","page":1,"text":"text","x":40,"y":50,"width":200,"height":30}],
        "linkStatus":"complete", "sourceLinks":[
          {"page":1,"x":40,"y":50,"width":200,"height":30,"href":"https://example.org/text"},
          {"page":1,"x":300,"y":400,"width":80,"height":40,"href":"mailto:hello@example.org"}
        ]});
        let map = source_layout_text_map(&layout, &json!({})).unwrap();
        let links = map.page_links.unwrap();
        assert_eq!(links.len(), 2);
        assert_eq!(
            (
                links[0].page,
                links[0].x_pt,
                links[0].y_pt,
                links[0].width_pt,
                links[0].height_pt
            ),
            (1, 30.0, 37.5, 150.0, 22.5)
        );
        assert_eq!(links[1].href, "mailto:hello@example.org");
        layout["sourceLinks"][0]["href"] = json!("javascript:alert(1)");
        assert!(source_layout_text_map(&layout, &json!({})).is_err());
        layout["sourceLinks"][0]["href"] = json!("https://example.org/text");
        layout["sourceLinks"][0]["width"] = json!(900);
        assert!(source_layout_text_map(&layout, &json!({})).is_err());
        layout["linkStatus"] = json!("incomplete");
        assert!(source_layout_text_map(&layout, &json!({})).is_err());
    }

    #[test]
    fn validates_png_bytes_pages_long_image_and_limits() {
        let mut canvas = tiny_skia::Pixmap::new(1588, 2246).unwrap();
        canvas.fill(tiny_skia::Color::WHITE);
        let bytes = canvas.encode_png().unwrap();
        let page = ExportPng {
            page: 1,
            width: 1588,
            height: 2246,
            sha256: format!("{:x}", Sha256::digest(&bytes)),
            data_base64: STANDARD.encode(&bytes),
        };
        let mut long = page.clone();
        long.page = 0;
        let mut data = ExportData {
            pdf_base64: String::new(),
            pdf_sha256: String::new(),
            page_count: 1,
            text_map: TextMap {
                version: 1,
                logical_text: String::new(),
                clusters: vec![],
                hit_regions: vec![],
                links: vec![],
                page_links: None,
            },
            png_pages: vec![page],
            long_png: Some(long),
            long_image_limited: false,
            dpi: 192,
            product: Some(ExportProduct::Png),
            selected_pages: None,
        };
        assert!(validate_source_png(&data).is_ok());
        data.png_pages[0].sha256 = "0".repeat(64);
        assert!(validate_source_png(&data).is_err());
        data.png_pages[0].sha256 = format!("{:x}", Sha256::digest(&bytes));
        data.png_pages[0].data_base64 = STANDARD.encode(b"not png");
        assert!(validate_source_png(&data).is_err());
        data.png_pages[0].data_base64 = STANDARD.encode(&bytes);
        data.long_png = None;
        assert!(validate_source_png(&data).is_err());
    }

    #[test]
    fn validates_the_real_catalog_and_durable_background_resource() {
        let mut store = crate::storage::Store::open_in_memory().unwrap();
        let template = json!({ "id":"template-a", "name":"Synthetic", "sourceName":"source.pdf",
            "sourceType":"pdf", "createdAt":"2026-10-01T00:00:00.000Z", "accent":"#224466",
            "formatId":"legacy-v1", "layout":"single-column", "analysis":"synthetic",
            "sourceLayout":{"version":1, "pages":[{"width":794,"height":1123,"background":"data:image/png;base64,AQID"}],
                "boxes":[{"id":"box", "text":"before", "page":1}],"extractedChars":6,"warnings":[]} });
        store
            .write_imported_template_catalog(&json!([template]).to_string(), 0)
            .unwrap();
        let catalog = store.read_imported_template_catalog().unwrap().unwrap();
        let catalog: Value = serde_json::from_str(&catalog.payload_json).unwrap();
        let revision = catalog[0]["revisionHash"].as_str().unwrap();
        let mut document = zinecv_domain::default_resume_document("source-doc").unwrap();
        document.legacy_extensions.insert(
            "importedTemplate".into(),
            json!({"id":"template-a", "revisionHash":revision}),
        );
        document.legacy_extensions.insert(
            "sourceLayoutEdits".into(),
            json!({"templateId":"template-a", "revisionHash":revision, "edits":{"box":"edited"}}),
        );
        let hashes = validate_source_layout(
            &document,
            &catalog,
            "template-a",
            revision,
            &json!({"box":"edited"}),
            1,
        )
        .unwrap();
        assert_eq!(
            store.read_resource_bytes(&hashes[0]).unwrap().unwrap().1,
            vec![1, 2, 3]
        );
        let mut stale = catalog.clone();
        stale[0]["revisionHash"] = json!("f".repeat(64));
        assert!(validate_source_layout(
            &document,
            &stale,
            "template-a",
            revision,
            &json!({"box":"edited"}),
            1
        )
        .is_err());
    }

    #[test]
    fn validates_saved_document_template_revision_edits_and_pages() {
        let revision = "a".repeat(64);
        let background = "b".repeat(64);
        let mut document = zinecv_domain::default_resume_document("source-doc").unwrap();
        document.legacy_extensions.insert(
            "importedTemplate".into(),
            json!({"id":"template-a", "revisionHash":revision}),
        );
        document.legacy_extensions.insert(
            "sourceLayoutEdits".into(),
            json!({"templateId":"template-a", "revisionHash":revision, "edits":{"box":"edited"}}),
        );
        let mut catalog = json!([{ "id":"template-a", "revisionHash":revision,
            "sourceLayout":{"pages":[{"backgroundAssetId":background}], "boxes":[{"id":"box", "page":1}]} }]);
        let edits = json!({"box":"edited"});
        assert_eq!(
            validate_source_layout(&document, &catalog, "template-a", &revision, &edits, 1)
                .unwrap(),
            vec![background]
        );
        assert!(validate_source_layout(
            &document,
            &catalog,
            "template-a",
            &revision,
            &json!({"box":"other"}),
            1
        )
        .is_err());
        assert!(
            validate_source_layout(&document, &catalog, "template-a", &revision, &edits, 2)
                .is_err()
        );
        assert!(
            validate_source_layout(&document, &catalog, "template-b", &revision, &edits, 1)
                .is_err()
        );
        catalog[0]["revisionHash"] = json!("c".repeat(64));
        assert!(
            validate_source_layout(&document, &catalog, "template-a", &revision, &edits, 1)
                .is_err()
        );
    }
}
