use super::*;

pub(super) fn fixture_id(name: &str) -> FileId {
    RootedPath::new(
        VirtualRoot::Project,
        VirtualPath::new(name).expect("static fixture path"),
    )
    .intern()
}

pub(super) fn fixture_text_fields(
    fixture: &serde_json::Value,
) -> Result<Vec<(String, String)>, &'static str> {
    let document = &fixture["document"];
    let document_id = document["documentId"]
        .as_str()
        .ok_or("Missing document ID")?;
    let section = &document["sections"][0];
    let section_id = section["id"].as_str().ok_or("Missing section ID")?;
    let mut fields = vec![
        (
            format!("{document_id}:title"),
            document["title"]
                .as_str()
                .ok_or("Missing title")?
                .to_owned(),
        ),
        (
            format!("{document_id}:name"),
            document["basic"]["name"]
                .as_str()
                .ok_or("Missing name")?
                .to_owned(),
        ),
        (
            format!("{section_id}:title"),
            section["title"]
                .as_str()
                .ok_or("Missing section title")?
                .to_owned(),
        ),
    ];
    for (index, block) in section["body"]
        .as_array()
        .ok_or("Missing body blocks")?
        .iter()
        .enumerate()
    {
        fields.push((
            format!("{section_id}:body:{index}"),
            block["children"][0]["text"]
                .as_str()
                .ok_or("Missing body text")?
                .to_owned(),
        ));
    }
    Ok(fields)
}

pub(super) fn repository_fixture_fonts() -> Result<Vec<Vec<u8>>, Box<dyn std::error::Error>> {
    let font_root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../public/fonts");
    FONT_NAMES
        .iter()
        .map(|name| std::fs::read(font_root.join(name)).map_err(Into::into))
        .collect()
}

pub(super) fn read_bounded_line<R: BufRead>(
    input: &mut R,
    max_bytes: u64,
) -> io::Result<Option<Vec<u8>>> {
    let mut line = Vec::new();
    let count = input
        .by_ref()
        .take(max_bytes + 1)
        .read_until(b'\n', &mut line)?;
    if count == 0 {
        return Ok(None);
    }
    if count as u64 > max_bytes || !line.ends_with(b"\n") {
        return Err(io::Error::new(io::ErrorKind::InvalidData, "line too large"));
    }
    Ok(Some(line))
}

pub(super) fn load_host_fonts<R: BufRead, W: Write>(
    input: &mut R,
    output: &mut W,
    request: &serde_json::Value,
    generation: &str,
) -> Result<Vec<Vec<u8>>, String> {
    let resources = request["resources"].as_array().ok_or("INVALID_MANIFEST")?;
    if resources.len() != FONT_NAMES.len() {
        return Err("INVALID_MANIFEST".into());
    }
    let mut result = Vec::with_capacity(FONT_NAMES.len());
    for (index, expected_name) in FONT_NAMES.iter().enumerate() {
        let entry = &resources[index];
        let name = entry["name"].as_str().ok_or("INVALID_MANIFEST")?;
        let hash = entry["sha256"].as_str().ok_or("INVALID_MANIFEST")?;
        let size = entry["size"].as_u64().ok_or("INVALID_MANIFEST")?;
        if name != *expected_name
            || hash.len() != 64
            || !hash.bytes().all(|byte| byte.is_ascii_hexdigit())
            || !(1..=20_000_000).contains(&size)
        {
            return Err("INVALID_MANIFEST".into());
        }
        writeln!(
            output,
            "{}",
            serde_json::json!({
                "action": "resourceRequest",
                "generation": generation,
                "sha256": hash,
                "size": size,
                "name": name
            })
        )
        .map_err(|error| error.to_string())?;
        output.flush().map_err(|error| error.to_string())?;
        let line = read_bounded_line(input, 30_000_000)
            .map_err(|_| "RESOURCE_TOO_LARGE")?
            .ok_or("MISSING_RESOURCE")?;
        let response: serde_json::Value =
            serde_json::from_slice(&line).map_err(|_| "INVALID_RESOURCE_RESPONSE")?;
        if response["action"].as_str() != Some("resource")
            || response["generation"].as_str() != Some(generation)
            || response["sha256"].as_str() != Some(hash)
        {
            return Err("INVALID_RESOURCE_RESPONSE".into());
        }
        let encoded = response["base64"]
            .as_str()
            .ok_or("INVALID_RESOURCE_RESPONSE")?;
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(encoded)
            .map_err(|_| "INVALID_RESOURCE_RESPONSE")?;
        let actual_hash = format!("{:x}", Sha256::digest(&bytes));
        if bytes.len() as u64 != size || !actual_hash.eq_ignore_ascii_case(hash) {
            return Err("RESOURCE_MISMATCH".into());
        }
        result.push(bytes);
    }
    Ok(result)
}

pub(super) fn render_worker_request(
    request: &serde_json::Value,
    generation: &str,
    font_bytes: &[Vec<u8>],
) -> Result<serde_json::Value, String> {
    if request["protocolVersion"].as_u64() != Some(1) {
        return Err("UNSUPPORTED_PROTOCOL".into());
    }
    if request["generation"].as_str() != Some(generation) {
        return Err("STALE_GENERATION".into());
    }
    if request["action"].as_str() != Some("render") {
        return Err("UNKNOWN_ACTION".into());
    }
    let repeat_count = request["repeatCount"]
        .as_u64()
        .ok_or("INVALID_REPEAT_COUNT")?;
    if !(1..=65).contains(&repeat_count) {
        return Err("INVALID_REPEAT_COUNT".into());
    }
    let world =
        FixtureWorld::new(repeat_count as usize, font_bytes).map_err(|error| error.to_string())?;
    let result = typst::compile::<PagedDocument>(&world);
    let document = result.output.map_err(|errors| format!("{errors:?}"))?;
    if !result.warnings.is_empty() {
        return Err(format!("COMPILE_WARNING: {:?}", result.warnings));
    }
    let first = document.pages().first().ok_or("NO_PAGES")?;
    let pdf =
        typst_pdf::pdf(&document, &Default::default()).map_err(|errors| format!("{errors:?}"))?;
    let png = typst_render::render(first, &Default::default())
        .encode_png()
        .map_err(|error| error.to_string())?;
    let mut current_source_id = None;
    let text_geometry_sample: Vec<_> = document
        .pages()
        .iter()
        .enumerate()
        .map(|(page_index, page)| {
            let mut runs = Vec::new();
            collect_text_runs(
                &page.frame,
                Transform::identity(),
                &mut current_source_id,
                &mut runs,
            );
            serde_json::json!({
                "pageIndex": page_index,
                "widthPt": page.frame.width().to_pt(),
                "heightPt": page.frame.height().to_pt(),
                "runs": runs,
            })
        })
        .collect();
    let text_map_sample = build_text_map_sample(&world.source_fields, &text_geometry_sample)?;
    Ok(serde_json::json!({
        "protocolVersion": 1,
        "generation": generation,
        "requestId": request["requestId"],
        "pageCount": document.pages().len(),
        "pdfBase64": base64::engine::general_purpose::STANDARD.encode(pdf),
        "firstPageSvg": typst_svg::svg(first, &Default::default()),
        "firstPagePngBase64": base64::engine::general_purpose::STANDARD.encode(png),
        "textGeometrySample": text_geometry_sample,
        "textMapSample": text_map_sample,
    }))
}

// Diagnostic model-ordered text. The rectangles still come from the approximate
// geometry sample, so this is not the production TextMap/selection contract.
pub(super) fn build_text_map_sample(
    fields: &[(String, String)],
    pages: &[serde_json::Value],
) -> Result<serde_json::Value, String> {
    let mut logical_text = String::new();
    let mut starts = std::collections::HashMap::new();
    for (index, (id, value)) in fields.iter().enumerate() {
        if index > 0 {
            logical_text.push('\n');
        }
        let start = logical_text.encode_utf16().count();
        starts.insert(id.as_str(), (value.as_str(), start));
        logical_text.push_str(value);
    }
    let mut mapped = Vec::new();
    for page in pages {
        let page_number = page["pageIndex"].as_u64().ok_or("MISSING_PAGE_INDEX")? + 1;
        for run in page["runs"].as_array().ok_or("MISSING_TEXT_RUNS")? {
            let source_id = run["sourceNodeId"].as_str().ok_or("MISSING_SOURCE_ID")?;
            let (source, base) = starts.get(source_id).ok_or("UNKNOWN_SOURCE_ID")?;
            for cluster in run["clusters"].as_array().ok_or("MISSING_CLUSTERS")? {
                let offset = cluster["sourceByteOffset"]
                    .as_u64()
                    .ok_or("MISSING_SOURCE_OFFSET")? as usize;
                let text = cluster["text"].as_str().ok_or("MISSING_CLUSTER_TEXT")?;
                let prefix = source.get(..offset).ok_or("INVALID_SOURCE_OFFSET")?;
                if source.get(offset..offset + text.len()) != Some(text) {
                    return Err("CLUSTER_SOURCE_MISMATCH".into());
                }
                let start = base + prefix.encode_utf16().count();
                let rect = &cluster["rect"];
                mapped.push(serde_json::json!({
                    "sourceNodeId": source_id,
                    "startUtf16": start,
                    "endUtf16": start + text.encode_utf16().count(),
                    "logicalOrder": 0,
                    "page": page_number,
                    "xPt": rect["xPt"],
                    "yPt": rect["yPt"],
                    "widthPt": rect["widthPt"],
                    "heightPt": rect["heightPt"],
                }));
            }
        }
    }
    mapped.sort_by_key(|cluster| cluster["startUtf16"].as_u64().unwrap_or(u64::MAX));
    for (order, cluster) in mapped.iter_mut().enumerate() {
        cluster["logicalOrder"] = serde_json::json!(order);
    }
    Ok(serde_json::json!({
        "version": 1,
        "logicalText": logical_text,
        "clusters": mapped,
    }))
}

// Diagnostic geometry for the engine PoC. Frame traversal follows paint order;
// vertical bounds reuse the whole run bbox. A production selection layer must
// establish logical reading order and exact shaping-cluster hit boxes.
pub(super) fn collect_text_runs(
    frame: &Frame,
    parent: Transform,
    current_source_id: &mut Option<String>,
    runs: &mut Vec<serde_json::Value>,
) {
    for (position, item) in frame.items() {
        match item {
            FrameItem::Group(group) => {
                let transform = parent
                    .pre_concat(Transform::translate(position.x, position.y))
                    .pre_concat(group.transform);
                collect_text_runs(&group.frame, transform, current_source_id, runs);
            }
            FrameItem::Tag(Tag::Start(content, _)) => {
                if let Some(metadata) = content.to_packed::<MetadataElem>() {
                    if let Value::Str(value) = &metadata.value {
                        if let Some(id) = value.as_str().strip_prefix("node:") {
                            *current_source_id = Some(id.to_owned());
                        }
                    }
                }
            }
            FrameItem::Text(text) => {
                let origin = position.transform(parent);
                let bbox = text.bbox();
                let top = bbox.min.y.min(bbox.max.y);
                let bottom = bbox.min.y.max(bbox.max.y);
                let mut cursor = Point::zero();
                let mut clusters = Vec::with_capacity(text.glyphs.len());
                for glyph in &text.glyphs {
                    let range = glyph.range();
                    if let Some(logical) = text.text.get(range.clone()) {
                        let start = text.text[..range.start].encode_utf16().count();
                        let end = start + logical.encode_utf16().count();
                        let start_point = (*position + cursor).transform(parent);
                        let start_cursor = cursor;
                        cursor.x += glyph.x_advance.at(text.size);
                        cursor.y -= glyph.y_advance.at(text.size);
                        let end_point = (*position + cursor).transform(parent);
                        let x0 = start_cursor.x.min(cursor.x);
                        let x1 = start_cursor.x.max(cursor.x);
                        let corners = [
                            Point::new(position.x + x0, position.y + start_cursor.y + top),
                            Point::new(position.x + x1, position.y + start_cursor.y + top),
                            Point::new(position.x + x0, position.y + start_cursor.y + bottom),
                            Point::new(position.x + x1, position.y + start_cursor.y + bottom),
                        ];
                        let mut min_x = f64::INFINITY;
                        let mut min_y = f64::INFINITY;
                        let mut max_x = f64::NEG_INFINITY;
                        let mut max_y = f64::NEG_INFINITY;
                        for corner in corners {
                            let point = corner.transform(parent);
                            min_x = min_x.min(point.x.to_pt());
                            min_y = min_y.min(point.y.to_pt());
                            max_x = max_x.max(point.x.to_pt());
                            max_y = max_y.max(point.y.to_pt());
                        }
                        clusters.push(serde_json::json!({
                            "text": logical,
                            "utf16Start": start,
                            "utf16End": end,
                            "sourceNodeId": current_source_id,
                            "sourceByteOffset": glyph.span.1,
                            "x": start_point.x.to_pt(),
                            "y": start_point.y.to_pt(),
                            "advanceX": (end_point.x - start_point.x).to_pt(),
                            "advanceY": (end_point.y - start_point.y).to_pt(),
                            "rect": {
                                "xPt": min_x,
                                "yPt": min_y,
                                "widthPt": max_x - min_x,
                                "heightPt": max_y - min_y,
                            },
                        }));
                    }
                }
                runs.push(serde_json::json!({
                    "text": text.text.as_str(),
                    "x": origin.x.to_pt(),
                    "baselineY": origin.y.to_pt(),
                    "fontSizePt": text.size.to_pt(),
                    "sourceNodeId": current_source_id,
                    "clusters": clusters,
                }));
            }
            _ => {}
        }
    }
}

pub(super) fn serve_worker(generation: &str) -> Result<(), Box<dyn std::error::Error>> {
    let stdin = io::stdin();
    let mut input = stdin.lock();
    let mut output = io::BufWriter::new(io::stdout().lock());
    writeln!(
        output,
        "{}",
        serde_json::json!({
            "protocolVersion": 1,
            "generation": generation,
            "engine": "typst-0.15.1-poc",
            "action": "hello"
        })
    )?;
    output.flush()?;
    let mut host_fonts: Option<Vec<Vec<u8>>> = None;
    loop {
        let mut terminate_after_response = false;
        let line = match read_bounded_line(&mut input, 4096) {
            Ok(Some(line)) => line,
            Ok(None) => break,
            Err(_) => {
                writeln!(
                    output,
                    "{}",
                    serde_json::json!({"error": "REQUEST_TOO_LARGE"})
                )?;
                output.flush()?;
                break;
            }
        };
        let response = match serde_json::from_slice::<serde_json::Value>(&line) {
            Ok(request) => {
                let result = if request["action"].as_str() == Some("init") {
                    if request["protocolVersion"].as_u64() != Some(1) {
                        Err("UNSUPPORTED_PROTOCOL".into())
                    } else if request["generation"].as_str() != Some(generation) {
                        Err("STALE_GENERATION".into())
                    } else {
                        let loaded = load_host_fonts(&mut input, &mut output, &request, generation);
                        if loaded.as_ref().err().map(String::as_str) == Some("RESOURCE_TOO_LARGE") {
                            terminate_after_response = true;
                        }
                        loaded.map(|fonts| {
                            host_fonts = Some(fonts);
                            serde_json::json!({"action": "initOk", "generation": generation})
                        })
                    }
                } else if let Some(fonts) = host_fonts.as_ref() {
                    render_worker_request(&request, generation, fonts)
                } else {
                    Err("NOT_INITIALIZED".into())
                };
                match result {
                    Ok(value) => value,
                    Err(error) => {
                        serde_json::json!({"error": error, "requestId": request["requestId"]})
                    }
                }
            }
            Err(_) => serde_json::json!({"error": "INVALID_JSON"}),
        };
        writeln!(output, "{response}")?;
        output.flush()?;
        if terminate_after_response {
            break;
        }
    }
    Ok(())
}
