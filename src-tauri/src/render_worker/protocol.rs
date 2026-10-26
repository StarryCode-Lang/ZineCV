use super::*;

pub(super) fn render_timeout(format: RenderFormat) -> Duration {
    #[cfg(feature = "test-hooks")]
    {
        let disabled = std::env::var_os("ZINECV_TEST_WORKER_RESET_FILE")
            .is_some_and(|path| std::path::Path::new(&path).exists());
        let milliseconds = if disabled {
            None
        } else {
            std::env::var("ZINECV_TEST_RENDER_TIMEOUT_MS").ok()
        };
        configured_render_timeout(format, milliseconds.as_deref())
    }
    #[cfg(not(feature = "test-hooks"))]
    configured_render_timeout(format, None)
}

pub(super) fn configured_render_timeout(
    format: RenderFormat,
    _test_milliseconds: Option<&str>,
) -> Duration {
    // Only the fault-injection executable accepts one bounded test deadline.
    // Production neither reads the environment nor compiles this override.
    #[cfg(feature = "test-hooks")]
    if format == RenderFormat::Pdf && _test_milliseconds == Some("3000") {
        return Duration::from_millis(3000);
    }
    match format {
        RenderFormat::Fit => Duration::from_secs(10),
        RenderFormat::Pdf | RenderFormat::Preview | RenderFormat::Export => RENDER_TIMEOUT,
    }
}

pub(super) fn valid_output_page_count(format: RenderFormat, page_count: usize) -> bool {
    page_count <= MAX_PAGE_COUNT && (page_count > 0 || format == RenderFormat::Fit)
}

pub(super) fn sha256(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

// template_source_bytes 是编译期常量；冻结输入下每次渲染重复哈希同一份
// 模板源纯属浪费，进程内缓存一次即可。
pub(super) fn template_sha256() -> String {
    static CACHE: OnceLock<String> = OnceLock::new();
    CACHE
        .get_or_init(|| sha256(engine::template_source_bytes()))
        .clone()
}

pub(super) fn render_key(
    cursor: &AuthorityCursor,
    document: &ResumeDocument,
    reference_date: &str,
    format: RenderFormat,
    resources: &[ResourceDescriptor],
) -> Result<String, String> {
    let input = RenderKeyInput {
        protocol_version: PROTOCOL_VERSION,
        engine_version: ENGINE_VERSION,
        resource_version: RESOURCE_VERSION,
        template_sha256: template_sha256(),
        cursor,
        document,
        reference_date,
        format,
        resources,
    };
    let bytes = serde_json::to_vec(&input).map_err(|error| error.to_string())?;
    Ok(sha256(&bytes))
}

pub(super) fn manifest_render_key(manifest: &RenderManifest) -> Result<String, String> {
    let base = render_key(
        &manifest.cursor,
        &manifest.document,
        &manifest.reference_date,
        manifest.format,
        &manifest.resources,
    )?;
    if manifest.format != RenderFormat::Export {
        return Ok(base);
    }
    let product = manifest.product.unwrap_or(ExportProduct::Bundle);
    let selection = match (product, manifest.selected_pages.as_ref()) {
        (ExportProduct::Pdf, Some(pages)) if !pages.is_empty() => {
            let mut pages = pages.clone();
            pages.sort_unstable();
            pages.dedup();
            Some(pages)
        }
        _ => None,
    };
    let bytes = serde_json::to_vec(&(
        base,
        product,
        selection,
        manifest.dpi.unwrap_or(engine::export::DEFAULT_DPI),
    ))
    .map_err(|error| error.to_string())?;
    Ok(sha256(&bytes))
}

pub(super) fn validate_reference_date(value: &str) -> Result<(i32, u8, u8), String> {
    let bytes = value.as_bytes();
    if bytes.len() != 10
        || bytes[4] != b'-'
        || bytes[7] != b'-'
        || !bytes[..4].iter().all(u8::is_ascii_digit)
        || !bytes[5..7].iter().all(u8::is_ascii_digit)
        || !bytes[8..10].iter().all(u8::is_ascii_digit)
    {
        return Err("referenceDate must use YYYY-MM-DD".into());
    }
    let year = value[0..4]
        .parse::<i32>()
        .map_err(|_| "referenceDate year is invalid")?;
    let month = value[5..7]
        .parse::<u8>()
        .map_err(|_| "referenceDate month is invalid")?;
    let day = value[8..10]
        .parse::<u8>()
        .map_err(|_| "referenceDate day is invalid")?;
    if typst::foundations::Datetime::from_ymd(year, month, day).is_none() {
        return Err("referenceDate is not a calendar date".into());
    }
    Ok((year, month, day))
}

pub(super) fn material(role: ResourceRole, mime: &str, bytes: Bytes) -> ResourceMaterial {
    let hash = sha256(&bytes);
    ResourceMaterial {
        role,
        hash,
        mime: mime.to_owned(),
        bytes,
    }
}

pub(super) fn bundled_font_materials() -> &'static [BundledFontMaterial; 3] {
    static FONTS: OnceLock<[BundledFontMaterial; 3]> = OnceLock::new();
    FONTS.get_or_init(|| {
        let fonts = engine::bundled_font_bytes();
        [
            material(ResourceRole::BodyFontRegular, "font/otf", fonts.regular),
            material(ResourceRole::BodyFontHeavy, "font/ttf", fonts.heavy),
            material(ResourceRole::IconFont, "font/ttf", fonts.icon),
        ]
        .map(|font| BundledFontMaterial {
            encoded_base64: BASE64.encode(font.bytes.as_slice()),
            material: font,
        })
    })
}

/// 内置字体的编码载荷缓存命中：role 与 hash 都匹配才复用（零复制借用）。
pub(super) fn bundled_encoded_payload(role: ResourceRole, hash: &str) -> Option<&'static str> {
    bundled_font_materials()
        .iter()
        .find(|font| font.material.role == role && font.material.hash == hash)
        .map(|font| font.encoded_base64.as_str())
}

pub(super) fn host_resources(
    font_set_id: &str,
    avatar: AvatarAsset,
) -> Result<Vec<ResourceMaterial>, String> {
    let mut resources: Vec<ResourceMaterial> = bundled_font_materials()
        .iter()
        .map(|font| font.material.clone())
        .collect();
    static HEADINGS: OnceLock<Vec<ResourceMaterial>> = OnceLock::new();
    let headings = HEADINGS.get_or_init(|| match engine::system_fonts::installed() {
        Some(fonts) => vec![
            material(ResourceRole::HeadingFontRegular, "font/ttf", fonts.regular),
            material(ResourceRole::HeadingFontBold, "font/ttf", fonts.bold),
        ],
        None => Vec::new(),
    });
    resources.extend(headings.iter().cloned());
    // One selected pair only; switching fonts replaces the previous cache entry.
    type SelectedFonts = Option<(String, Vec<ResourceMaterial>)>;
    static SELECTED: OnceLock<Mutex<SelectedFonts>> = OnceLock::new();
    let mut selected = SELECTED
        .get_or_init(|| Mutex::new(None))
        .lock()
        .map_err(|_| "Selected font cache poisoned")?;
    if selected.as_ref().is_none_or(|(id, _)| id != font_set_id) {
        let fonts = match engine::body_fonts::installed(font_set_id)? {
            Some(fonts) => vec![
                material(ResourceRole::SelectedBodyRegular, "font/ttf", fonts.regular),
                material(ResourceRole::SelectedBodyBold, "font/ttf", fonts.bold),
            ],
            None => Vec::new(),
        };
        *selected = Some((font_set_id.to_owned(), fonts));
    }
    resources.extend(
        selected
            .as_ref()
            .expect("initialized selected font cache")
            .1
            .iter()
            .cloned(),
    );
    if let Some((mime, bytes)) = avatar {
        resources.push(material(ResourceRole::Avatar, &mime, Bytes::new(bytes)));
    }
    Ok(resources)
}

#[allow(clippy::too_many_arguments)]
pub(super) fn build_manifest(
    cursor: AuthorityCursor,
    document: ResumeDocument,
    resources: &[ResourceMaterial],
    generation: u64,
    request_id: u64,
    format: RenderFormat,
    product: Option<ExportProduct>,
    selected_pages: Option<Vec<u32>>,
    dpi: Option<u16>,
) -> Result<RenderManifest, String> {
    if cursor.document_id != document.document_id {
        return Err("Frozen cursor and document IDs do not match".into());
    }
    let avatar = document.basic.avatar_asset_id.as_deref();
    let supplied_avatar = resources
        .iter()
        .find(|resource| resource.role == ResourceRole::Avatar);
    match (avatar, supplied_avatar) {
        (Some(asset_id), Some(resource)) if asset_id == resource.hash => {}
        (Some(_), Some(_)) => return Err("Frozen avatar hash does not match its asset ID".into()),
        (Some(_), None) => return Err("Frozen avatar bytes are missing".into()),
        (None, Some(_)) => return Err("Unexpected avatar bytes were supplied".into()),
        (None, None) => {}
    }
    let mut descriptors: Vec<_> = resources
        .iter()
        .map(|resource| ResourceDescriptor {
            role: resource.role,
            hash: resource.hash.clone(),
            size_bytes: resource.bytes.len(),
            mime: resource.mime.clone(),
        })
        .collect();
    descriptors.sort_by_key(|descriptor| descriptor.role);
    validate_descriptors(&descriptors, avatar.is_some())?;
    // render_key 按调用方给出的最终 format/product/pages/dpi 一次成形；
    // 先以 Pdf 占位再改写会造成整份文档的重复序列化与哈希。
    let mut manifest = RenderManifest {
        protocol_version: PROTOCOL_VERSION,
        engine_version: ENGINE_VERSION.to_owned(),
        resource_version: RESOURCE_VERSION,
        generation,
        request_id,
        render_key: String::new(),
        template_sha256: template_sha256(),
        cursor,
        document,
        reference_date: REFERENCE_DATE.to_owned(),
        format,
        resources: descriptors,
        product,
        selected_pages,
        dpi,
    };
    manifest.render_key = manifest_render_key(&manifest)?;
    let encoded = serde_json::to_vec(&manifest).map_err(|error| error.to_string())?;
    if encoded.len() > MAX_DOCUMENT_BYTES {
        return Err("Frozen render manifest exceeds the 8 MiB limit".into());
    }
    Ok(manifest)
}

pub(super) fn validate_descriptors(
    descriptors: &[ResourceDescriptor],
    has_avatar: bool,
) -> Result<(), String> {
    let mut roles = HashSet::new();
    for descriptor in descriptors {
        if !roles.insert(descriptor.role) {
            return Err("Resource manifest contains a duplicate role".into());
        }
        if descriptor.size_bytes == 0 || descriptor.size_bytes > MAX_RESOURCE_BYTES {
            return Err(format!(
                "Resource {:?} has an invalid size",
                descriptor.role
            ));
        }
        if descriptor.hash.len() != 64
            || !descriptor.hash.bytes().all(|byte| byte.is_ascii_hexdigit())
        {
            return Err(format!(
                "Resource {:?} has an invalid SHA-256",
                descriptor.role
            ));
        }
        if descriptor.mime.len() > 128
            || descriptor.mime.bytes().any(|byte| byte.is_ascii_control())
        {
            return Err(format!(
                "Resource {:?} has an invalid MIME type",
                descriptor.role
            ));
        }
    }
    for role in [
        ResourceRole::BodyFontRegular,
        ResourceRole::BodyFontHeavy,
        ResourceRole::IconFont,
    ] {
        if !roles.contains(&role) {
            return Err(format!("Required resource {role:?} is missing"));
        }
    }
    if roles.contains(&ResourceRole::Avatar) != has_avatar {
        return Err("Avatar manifest does not match the frozen document".into());
    }
    let has_heading = roles.contains(&ResourceRole::HeadingFontRegular);
    if roles.contains(&ResourceRole::HeadingFontBold) != has_heading {
        return Err("System heading font styles must be supplied together".into());
    }
    let has_selected = roles.contains(&ResourceRole::SelectedBodyRegular);
    if roles.contains(&ResourceRole::SelectedBodyBold) != has_selected {
        return Err("Selected body font styles must be supplied together".into());
    }
    if roles.len()
        != (if has_avatar { 4 } else { 3 })
            + (if has_heading { 2 } else { 0 })
            + (if has_selected { 2 } else { 0 })
    {
        return Err("Resource manifest contains an unsupported resource role".into());
    }
    Ok(())
}

pub(super) fn write_message(writer: &mut impl Write, message: &impl Serialize) -> io::Result<()> {
    let mut bytes = serde_json::to_vec(message)
        .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))?;
    bytes.push(b'\n');
    if bytes.len() > MAX_PROTOCOL_LINE_BYTES {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "protocol line exceeds limit",
        ));
    }
    writer.write_all(&bytes)?;
    writer.flush()
}

pub(super) fn read_message<T: for<'de> Deserialize<'de>>(
    reader: &mut impl BufRead,
) -> io::Result<T> {
    let mut bytes = Vec::new();
    let read = reader
        .take((MAX_PROTOCOL_LINE_BYTES + 1) as u64)
        .read_until(b'\n', &mut bytes)?;
    if read == 0 {
        return Err(io::Error::new(
            io::ErrorKind::UnexpectedEof,
            "worker protocol stream closed",
        ));
    }
    if bytes.len() > MAX_PROTOCOL_LINE_BYTES || bytes.last() != Some(&b'\n') {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "protocol line exceeds limit or is unterminated",
        ));
    }
    serde_json::from_slice(&bytes[..bytes.len() - 1])
        .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))
}

pub(super) fn failed(
    request_id: u64,
    generation: u64,
    code: &str,
    message: impl Into<String>,
) -> WorkerMessage {
    let mut message = message.into();
    message.truncate(MAX_ERROR_CHARS);
    WorkerMessage::Failed {
        request_id,
        generation,
        code: code.to_owned(),
        message,
    }
}

/// 资源校验失败时向宿主回发结构化 resourceHashMismatch 并结束本轮请求。
pub(super) fn reject_resource(
    writer: &mut impl Write,
    request_id: u64,
    generation: u64,
    message: &str,
) -> Result<(), String> {
    write_message(
        writer,
        &failed(request_id, generation, "resourceHashMismatch", message),
    )
    .map_err(|error| error.to_string())
}

/// Seven fixed font roles may be cached; avatars are never cached.
pub(super) fn fixed_font_role(role: ResourceRole) -> Option<ResourceRole> {
    match role {
        ResourceRole::BodyFontRegular
        | ResourceRole::BodyFontHeavy
        | ResourceRole::IconFont
        | ResourceRole::HeadingFontRegular
        | ResourceRole::HeadingFontBold
        | ResourceRole::SelectedBodyRegular
        | ResourceRole::SelectedBodyBold => Some(role),
        ResourceRole::Avatar => None,
    }
}

/// 已验证清单里某字体角色的身份哈希（validate_descriptors 保证三个字体
/// 角色必在，缺省值仅是类型层的兜底）。
pub(super) fn font_descriptor_hash(
    descriptors: &[ResourceDescriptor],
    role: ResourceRole,
) -> String {
    descriptors
        .iter()
        .find(|descriptor| descriptor.role == role)
        .map(|descriptor| descriptor.hash.clone())
        .unwrap_or_default()
}

/// 按原协议请求一个资源并完成请求/身份级校验（request_id、generation、
/// role/hash/size/mime 一致 + base64 合法）；SHA-256 与尺寸的最终判定仍由
/// 调用方完成，以保持 resourceHashMismatch 的响应语义。
pub(super) fn receive_resource<R: BufRead, W: Write>(
    reader: &mut R,
    writer: &mut W,
    request_id: u64,
    generation: u64,
    descriptor: &ResourceDescriptor,
) -> Result<Vec<u8>, String> {
    write_message(
        writer,
        &WorkerMessage::ResourceRequest {
            request_id,
            generation,
            role: descriptor.role,
            hash: descriptor.hash.clone(),
        },
    )
    .map_err(|error| error.to_string())?;
    let response: HostMessage = read_message(reader).map_err(|error| error.to_string())?;
    let HostMessage::ResourceBytes {
        request_id: response_id,
        generation: response_generation,
        role,
        hash,
        size_bytes,
        mime,
        data_base64,
    } = response
    else {
        return Err("worker expected a read-only resource response".into());
    };
    if response_id != request_id || response_generation != generation || role != descriptor.role {
        return Err("resource response belongs to a different request or generation".into());
    }
    if hash != descriptor.hash || size_bytes != descriptor.size_bytes || mime != descriptor.mime {
        return Err("resource response does not match the manifest".into());
    }
    BASE64
        .decode(data_base64.as_bytes())
        .map_err(|_| "resource bytes are not valid base64".to_string())
}
