use super::*;

pub(super) fn worker_render<R: BufRead, W: Write>(
    manifest: RenderManifest,
    worker_generation: u64,
    reader: &mut R,
    writer: &mut W,
    font_cache: &mut FontResourceCache,
) -> Result<(), String> {
    let request_id = manifest.request_id;
    let generation = manifest.generation;
    let validation = (|| {
        if generation != worker_generation {
            return Err("stale worker generation".to_owned());
        }
        if manifest.protocol_version != PROTOCOL_VERSION
            || manifest.resource_version != RESOURCE_VERSION
            || manifest.engine_version != ENGINE_VERSION
        {
            return Err("worker protocol, engine, or resource version mismatch".to_owned());
        }
        if manifest.template_sha256 != sha256(engine::template_source_bytes()) {
            return Err("template resource hash does not match this engine".to_owned());
        }
        if manifest.cursor.document_id != manifest.document.document_id {
            return Err("frozen cursor does not identify this document".to_owned());
        }
        validate_reference_date(&manifest.reference_date)?;
        if manifest.dpi.is_some_and(|dpi| !(72..=300).contains(&dpi))
            || (manifest.format != RenderFormat::Export && manifest.dpi.is_some())
        {
            return Err("Export DPI must be between 72 and 300".to_owned());
        }
        validate_descriptors(
            &manifest.resources,
            manifest.document.basic.avatar_asset_id.is_some(),
        )?;
        if manifest
            .resources
            .iter()
            .any(|resource| resource.role == ResourceRole::SelectedBodyRegular)
            != engine::body_fonts::is_installed_selection(
                &manifest.document.presentation.font_set_id,
            )
        {
            return Err("Selected font resources do not match the frozen document".into());
        }
        if manifest_render_key(&manifest)? != manifest.render_key {
            return Err("renderKey does not match the frozen manifest".to_owned());
        }
        Ok(())
    })();
    if let Err(message) = validation {
        write_message(
            writer,
            &failed(request_id, generation, "invalidManifest", message),
        )
        .map_err(|error| error.to_string())?;
        return Ok(());
    }

    let mut received = HashSet::<ResourceRole>::new();
    let mut fonts = HashMap::<ResourceRole, Bytes>::new();
    let mut avatar_bytes: Option<Vec<u8>> = None;
    for descriptor in &manifest.resources {
        if !received.insert(descriptor.role) {
            return Err("duplicate resource response".into());
        }
        if let Some(role) = fixed_font_role(descriptor.role) {
            // 字体：按完整 (hash, size, mime, resourceVersion) 命中已验证缓存
            // 时不再发起 ResourceRequest；未命中按原协议请求并完整校验。
            if let Some(bytes) = font_cache.lookup(
                descriptor.role,
                &descriptor.hash,
                descriptor.size_bytes,
                &descriptor.mime,
                manifest.resource_version,
            ) {
                fonts.insert(role, bytes.clone());
                continue;
            }
            let bytes = receive_resource(reader, writer, request_id, generation, descriptor)?;
            if bytes.len() != descriptor.size_bytes
                || bytes.len() > MAX_RESOURCE_BYTES
                || sha256(&bytes) != descriptor.hash
            {
                reject_resource(
                    writer,
                    request_id,
                    generation,
                    "resource bytes failed size or SHA-256 validation",
                )?;
                return Ok(());
            }
            let verified = Bytes::new(bytes);
            font_cache.store(
                descriptor.role,
                &descriptor.hash,
                descriptor.size_bytes,
                &descriptor.mime,
                manifest.resource_version,
                verified.clone(),
            );
            fonts.insert(role, verified);
        } else {
            // avatar：保持按内容哈希核对当前冻结文档的现行语义，不进缓存。
            let bytes = receive_resource(reader, writer, request_id, generation, descriptor)?;
            if bytes.len() != descriptor.size_bytes
                || bytes.len() > MAX_RESOURCE_BYTES
                || sha256(&bytes) != descriptor.hash
            {
                reject_resource(
                    writer,
                    request_id,
                    generation,
                    "resource bytes failed size or SHA-256 validation",
                )?;
                return Ok(());
            }
            avatar_bytes = Some(bytes);
        }
    }

    // 字体字节由 `Bytes` 接管已解码的 `Vec<u8>`（不复制），后续 Typst 字体解析
    // 与求解过程共享同一份缓冲；身份由已验证的资源哈希携带，DocumentWorld
    // 按身份复用解析缓存（字节变更即失效）。
    let font_identity = engine::FontIdentity {
        regular: font_descriptor_hash(&manifest.resources, ResourceRole::BodyFontRegular),
        heavy: font_descriptor_hash(&manifest.resources, ResourceRole::BodyFontHeavy),
        icon: font_descriptor_hash(&manifest.resources, ResourceRole::IconFont),
        selected_regular: manifest
            .resources
            .iter()
            .find(|resource| resource.role == ResourceRole::SelectedBodyRegular)
            .map(|resource| resource.hash.clone()),
        selected_bold: manifest
            .resources
            .iter()
            .find(|resource| resource.role == ResourceRole::SelectedBodyBold)
            .map(|resource| resource.hash.clone()),
        heading_regular: manifest
            .resources
            .iter()
            .find(|resource| resource.role == ResourceRole::HeadingFontRegular)
            .map(|resource| resource.hash.clone()),
        heading_bold: manifest
            .resources
            .iter()
            .find(|resource| resource.role == ResourceRole::HeadingFontBold)
            .map(|resource| resource.hash.clone()),
    };
    let font_bytes = RenderFontBytes {
        regular: fonts
            .remove(&ResourceRole::BodyFontRegular)
            .ok_or("regular font missing")?,
        heavy: fonts
            .remove(&ResourceRole::BodyFontHeavy)
            .ok_or("heavy font missing")?,
        icon: fonts
            .remove(&ResourceRole::IconFont)
            .ok_or("icon font missing")?,
        identity: Some(font_identity),
        selected_body: match (
            fonts.remove(&ResourceRole::SelectedBodyRegular),
            fonts.remove(&ResourceRole::SelectedBodyBold),
        ) {
            (Some(regular), Some(bold)) => Some(engine::body_fonts::validate(
                &manifest.document.presentation.font_set_id,
                regular,
                bold,
            )?),
            (None, None) => None,
            _ => return Err("Selected body fonts are incomplete".into()),
        },
        heading: match (
            fonts.remove(&ResourceRole::HeadingFontRegular),
            fonts.remove(&ResourceRole::HeadingFontBold),
        ) {
            (Some(regular), Some(bold)) => Some(engine::system_fonts::validate(regular, bold)?),
            (None, None) => None,
            _ => return Err("System heading font styles are incomplete".into()),
        },
    };
    let avatar_mime = manifest
        .resources
        .iter()
        .find(|descriptor| descriptor.role == ResourceRole::Avatar)
        .map(|descriptor| descriptor.mime.clone());
    let avatar = avatar_bytes
        .zip(avatar_mime)
        .map(|(bytes, mime)| (mime, bytes));
    let avatar = match (manifest.document.basic.avatar_asset_id.as_ref(), avatar) {
        (Some(asset_id), Some((mime, bytes))) => {
            if sha256(&bytes) != *asset_id {
                reject_resource(
                    writer,
                    request_id,
                    generation,
                    "avatar bytes do not match the document asset ID",
                )?;
                return Ok(());
            }
            Some((mime, bytes))
        }
        (None, None) => None,
        _ => return Err("avatar bytes do not match the frozen document".into()),
    };
    let reference_date = validate_reference_date(&manifest.reference_date)?;
    let result = match manifest.format {
        RenderFormat::Pdf => engine::render_document_pdf_with_resources(
            &manifest.document,
            avatar,
            &font_bytes,
            reference_date,
        ),
        RenderFormat::Preview => engine::render_preview_with_resources(
            &manifest.document,
            avatar,
            &font_bytes,
            reference_date,
        )
        .and_then(|data| {
            let page_count = data.pages.len();
            serde_json::to_vec(&data)
                .map(|bytes| RenderedPdf { bytes, page_count })
                .map_err(|error| engine::EngineError::Compile(error.to_string()))
        }),
        RenderFormat::Export => engine::export::render_frozen_export(
            &manifest.document,
            avatar,
            &font_bytes,
            reference_date,
            manifest.selected_pages.as_deref(),
            manifest.dpi.unwrap_or(engine::export::DEFAULT_DPI),
            manifest.product,
        )
        .and_then(|output| {
            let page_count = output.page_count;
            serde_json::to_vec(&output.into_payload())
                .map(|bytes| RenderedPdf { bytes, page_count })
                .map_err(|error| engine::EngineError::Compile(error.to_string()))
        }),
        RenderFormat::Fit => engine::fit::solve_one_page(
            &manifest.document,
            avatar,
            &font_bytes,
            reference_date,
            || false,
        )
        .and_then(|plan| {
            let page_count = plan
                .attempts
                .last()
                .map_or(0, |attempt| attempt.page_count as usize);
            serde_json::to_vec(&plan)
                .map(|bytes| RenderedPdf { bytes, page_count })
                .map_err(|error| engine::EngineError::Compile(error.to_string()))
        }),
    };
    match result {
        Ok(RenderedPdf { bytes, page_count }) => {
            if bytes.len() > MAX_PDF_BYTES || !valid_output_page_count(manifest.format, page_count)
            {
                write_message(
                    writer,
                    &failed(
                        request_id,
                        generation,
                        "resourceLimit",
                        "rendered output exceeds configured output or page limit",
                    ),
                )
                .map_err(|error| error.to_string())?;
                return Ok(());
            }
            write_message(
                writer,
                &WorkerMessage::Rendered {
                    request_id,
                    generation,
                    render_key: manifest.render_key,
                    pdf_sha256: sha256(&bytes),
                    pdf_base64: BASE64.encode(bytes),
                    page_count,
                },
            )
            .map_err(|error| error.to_string())?;
        }
        Err(error) => {
            write_message(
                writer,
                &failed(request_id, generation, "engineFailure", error.to_string()),
            )
            .map_err(|error| error.to_string())?;
        }
    }
    Ok(())
}

/// 仅 test-hooks 构建存在：按环境变量在处理首个 render 前注入故障。
/// ZINECV_TEST_WORKER_DELAY_MS=毫秒（触发宿主硬超时路径；默认 90 秒）、
/// ZINECV_TEST_RENDER_TIMEOUT_MS=3000（仅 Pdf 接受该固定测试值，reset 后恢复默认）、
/// ZINECV_TEST_WORKER_ALLOC_MB=兆字节（写满页触发 Job Object 1.5GiB 上限）、
/// ZINECV_TEST_CRASH_MARKER=路径（首个 render 写入标记后 abort，验证同冻结输入重放）。
#[cfg(feature = "test-hooks")]
pub(super) fn test_hooks_before_render() {
    // The integration test disables faults after observing the failure, then
    // verifies recovery in the same host without changing its environment.
    if std::env::var_os("ZINECV_TEST_WORKER_RESET_FILE")
        .is_some_and(|path| std::path::Path::new(&path).exists())
    {
        return;
    }
    if let Ok(milliseconds) = std::env::var("ZINECV_TEST_WORKER_DELAY_MS") {
        if let Ok(milliseconds) = milliseconds.parse::<u64>() {
            std::thread::sleep(Duration::from_millis(milliseconds));
        }
    }
    if let Ok(megabytes) = std::env::var("ZINECV_TEST_WORKER_ALLOC_MB") {
        if let Ok(megabytes) = megabytes.parse::<usize>() {
            let mut buffer: Vec<u8> = Vec::with_capacity(megabytes.saturating_mul(1024 * 1024));
            buffer.resize(buffer.capacity(), 0x41);
            // 必须让指针真正物化：`Vec::with_capacity` + `resize` + `mem::forget`
            // 的缓冲从不被读取，release 级优化（opt-level=3 + lto="fat" +
            // codegen-units=1）会把整段「分配+填充+泄漏」当作死代码消除，
            // 使本注入退化为空操作、1.5GiB Job Object 上限场景静默失效
            // （2026-10-03 实测：1700MB 与 4000MB 注入都杀不死 worker）。
            // black_box 让分配结果对优化器不透明，从而保持注入语义。
            std::hint::black_box(buffer.as_mut_ptr());
            std::mem::forget(buffer);
        }
    }
    if let Ok(marker) = std::env::var("ZINECV_TEST_CRASH_MARKER") {
        if !marker.is_empty() && !std::path::Path::new(&marker).exists() {
            let _ = std::fs::write(&marker, std::process::id().to_string());
            std::process::abort();
        }
    }
}

pub(super) fn worker_loop<R: Read, W: Write>(
    input: R,
    output: W,
    generation: u64,
) -> Result<(), String> {
    if generation == 0 {
        return Err("worker generation must be positive".into());
    }
    let mut reader = BufReader::new(input);
    let mut writer = BufWriter::new(output);
    // 一次 worker generation 的资源状态：已验证字体缓存随本循环存活，
    // worker 重启（新进程、新 generation）后自然重新初始化。
    let mut font_cache = FontResourceCache::default();
    write_message(
        &mut writer,
        &WorkerMessage::Hello {
            protocol_version: PROTOCOL_VERSION,
            engine_version: ENGINE_VERSION.to_owned(),
            resource_version: RESOURCE_VERSION,
            generation,
        },
    )
    .map_err(|error| error.to_string())?;
    loop {
        let message: HostMessage = match read_message(&mut reader) {
            Ok(message) => message,
            Err(error) if error.kind() == io::ErrorKind::UnexpectedEof => return Ok(()),
            Err(error) => return Err(error.to_string()),
        };
        match message {
            HostMessage::Render { manifest } => {
                let request_id = manifest.request_id;
                #[cfg(feature = "test-hooks")]
                test_hooks_before_render();
                if let Err(error) = worker_render(
                    *manifest,
                    generation,
                    &mut reader,
                    &mut writer,
                    &mut font_cache,
                ) {
                    write_message(
                        &mut writer,
                        &failed(request_id, generation, "workerProtocol", error),
                    )
                    .map_err(|write_error| write_error.to_string())?;
                }
            }
            HostMessage::ResourceBytes {
                request_id,
                generation: message_generation,
                ..
            } => {
                write_message(
                    &mut writer,
                    &failed(
                        request_id,
                        message_generation,
                        "unexpectedResource",
                        "worker was not waiting for resource bytes",
                    ),
                )
                .map_err(|error| error.to_string())?;
            }
        }
    }
}

/// Entry point used only by the same application executable's hidden worker mode.
pub fn run_worker_mode(generation: u64) -> i32 {
    match worker_loop(io::stdin(), io::stdout(), generation) {
        Ok(()) => 0,
        Err(_) => 70,
    }
}

pub(super) fn validate_export_png(page: &crate::domain::ExportPng) -> Result<(), String> {
    let bytes = BASE64
        .decode(&page.data_base64)
        .map_err(|_| "worker export PNG base64 is invalid")?;
    if bytes.len() < 24
        || !bytes.starts_with(b"\x89PNG\r\n\x1a\n")
        || &bytes[12..16] != b"IHDR"
        || sha256(&bytes) != page.sha256
        || u32::from_be_bytes(bytes[16..20].try_into().unwrap()) != page.width
        || u32::from_be_bytes(bytes[20..24].try_into().unwrap()) != page.height
        || page.width == 0
        || page.height == 0
        || page.width > 32768
        || page.height > 32768
        || u64::from(page.width) * u64::from(page.height) > engine::export::MAX_SELECTED_PIXELS
    {
        return Err("worker export PNG integrity or dimensions are invalid".into());
    }
    Ok(())
}

/// 按请求的产物校验 worker 导出信封：Bundle 保持现行全量校验；Pdf 只允许
/// PDF（无 PNG/长图，像素预算不适用）；Png 不携带 PDF。页码选择回显必须
/// 与请求（排序去重后）一致。
pub(super) fn validate_export_envelope(
    data: &crate::domain::ExportData,
    rendered_page_count: usize,
    requested_product: ExportProduct,
    requested_selection: &Option<Vec<u32>>,
    requested_dpi: u16,
) -> Result<(), String> {
    if data.page_count as usize != rendered_page_count || data.dpi != requested_dpi {
        return Err("worker export envelope does not match its payload".into());
    }
    let reported_product = data.product.unwrap_or(ExportProduct::Bundle);
    if reported_product != requested_product {
        return Err("worker export product does not match its request".into());
    }
    let expected_selection = match (requested_product, requested_selection.as_deref()) {
        (ExportProduct::Pdf, Some(pages)) if !pages.is_empty() => {
            let mut unique = pages.to_vec();
            unique.sort_unstable();
            unique.dedup();
            Some(unique)
        }
        _ => None,
    };
    if data.selected_pages != expected_selection {
        return Err("worker export page selection does not match its request".into());
    }
    match requested_product {
        ExportProduct::Pdf => {
            if !data.png_pages.is_empty() || data.long_png.is_some() || data.long_image_limited {
                return Err("worker export envelope does not match its payload".into());
            }
            validate_export_pdf(data)
        }
        ExportProduct::Png => {
            if !data.pdf_base64.is_empty()
                || data.png_pages.len() != rendered_page_count
                || data.long_image_limited != data.long_png.is_none()
            {
                return Err("worker export envelope does not match its payload".into());
            }
            validate_export_png_pages(data)
        }
        ExportProduct::Bundle => {
            if data.png_pages.len() != rendered_page_count
                || data.long_image_limited != data.long_png.is_none()
            {
                return Err("worker export envelope does not match its payload".into());
            }
            validate_export_pdf(data)?;
            validate_export_png_pages(data)
        }
    }
}

pub(super) fn validate_export_pdf(data: &crate::domain::ExportData) -> Result<(), String> {
    let pdf = BASE64
        .decode(&data.pdf_base64)
        .map_err(|_| "worker export PDF base64 is invalid")?;
    if !pdf.starts_with(b"%PDF-") || sha256(&pdf) != data.pdf_sha256 {
        return Err("worker export PDF integrity check failed".into());
    }
    Ok(())
}

pub(super) fn validate_export_png_pages(data: &crate::domain::ExportData) -> Result<(), String> {
    for (index, page) in data.png_pages.iter().enumerate() {
        if page.page as usize != index + 1 {
            return Err("worker export PNG order is invalid".into());
        }
        validate_export_png(page)?;
    }
    if let Some(long) = &data.long_png {
        validate_export_png(long)?;
        if long.page != 0
            || long.width
                != data
                    .png_pages
                    .iter()
                    .map(|page| page.width)
                    .max()
                    .unwrap_or(0)
            || u64::from(long.height)
                != data
                    .png_pages
                    .iter()
                    .map(|page| u64::from(page.height))
                    .sum::<u64>()
        {
            return Err("worker export long PNG dimensions are invalid".into());
        }
    }
    Ok(())
}
