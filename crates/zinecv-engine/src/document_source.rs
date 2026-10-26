use super::*;

/// Return the only font resources the production host may expose to a worker.
pub fn bundled_font_bytes() -> RenderFontBytes {
    RenderFontBytes {
        regular: Bytes::new(FONT_REGULAR_BYTES),
        heavy: Bytes::new(FONT_HEAVY_BYTES),
        icon: Bytes::new(FONT_ICON_BYTES),
        heading: None,
        selected_body: None,
        identity: None,
    }
}

pub fn template_source_bytes() -> &'static [u8] {
    TEMPLATE_SRC.as_bytes()
}

pub fn native_font_bytes(document: &ResumeDocument) -> Result<RenderFontBytes, EngineError> {
    Ok(RenderFontBytes {
        selected_body: body_fonts::installed(&document.presentation.font_set_id)
            .map_err(EngineError::Validation)?,
        ..RenderFontBytes::default()
    })
}

pub(super) fn parse_font_bundle(font_bytes: &RenderFontBytes) -> (FontBook, Vec<Font>) {
    let mut book = FontBook::new();
    let mut fonts = Vec::new();
    // `Bytes` 克隆只增加引用计数，字体数据本身不再被复制。
    for bytes in [
        font_bytes.regular.clone(),
        font_bytes.heavy.clone(),
        font_bytes.icon.clone(),
    ]
    .into_iter()
    .chain(std::iter::once(Bytes::new(FONT_HEBREW_BYTES)))
    .chain(
        font_bytes
            .selected_body
            .iter()
            .flat_map(|body| [body.regular.clone(), body.bold.clone()]),
    )
    .chain(
        font_bytes
            .heading
            .iter()
            .flat_map(|heading| [heading.regular.clone(), heading.bold.clone()]),
    ) {
        for font in Font::iter(bytes) {
            book.push(font.info().clone());
            fonts.push(font);
        }
    }
    (book, fonts)
}
pub(super) fn parsed_fonts(font_bytes: &RenderFontBytes) -> Result<ParsedFonts, EngineError> {
    static FONT_CACHE: OnceLock<std::sync::Mutex<FontCacheEntry>> = OnceLock::new();
    let key = match &font_bytes.identity {
        Some(identity) => FontCacheKey::Verified(identity.clone()),
        None => {
            let bundled = font_bytes.heading.is_none()
                && font_bytes.selected_body.is_none()
                && std::ptr::eq(
                    font_bytes.regular.as_slice().as_ptr(),
                    FONT_REGULAR_BYTES.as_ptr(),
                )
                && std::ptr::eq(
                    font_bytes.heavy.as_slice().as_ptr(),
                    FONT_HEAVY_BYTES.as_ptr(),
                )
                && std::ptr::eq(
                    font_bytes.icon.as_slice().as_ptr(),
                    FONT_ICON_BYTES.as_ptr(),
                );
            if bundled {
                FontCacheKey::Bundled
            } else {
                FontCacheKey::Verified(FontIdentity::from_sha(font_bytes))
            }
        }
    };
    let cache = FONT_CACHE.get_or_init(|| std::sync::Mutex::new(None));
    let mut guard = cache.lock().expect("font parse cache must not be poisoned");
    if let Some((cached, parsed)) = guard.as_ref() {
        if *cached == key {
            return Ok(parsed.clone());
        }
    }
    let (book, fonts) = parse_font_bundle(font_bytes);
    if fonts.is_empty() {
        return Err(EngineError::Validation(
            "Bundled fonts were rejected by Typst".into(),
        ));
    }
    // 字体竖向度量（em）：CSS 行盒换算的核心参数。Chromium 的行布局使用
    // hhea 度量并按字号四舍五入为整数像素（engine-parity 探针：canvas
    // fontBoundingBox 与 range rect 实测），Typst 的 FontMetrics::from_ttf
    // 偏偏取 OS/2 typo 度量；因此这里直接读 hhea，不按 family 名匹配。
    // iconfont 的 hhea 与 typo 一致，但为对称起见同样显式解析。
    fn hhea_metrics(bytes: &Bytes) -> Option<(f64, f64)> {
        let face = ttf_parser::Face::parse(bytes, 0).ok()?;
        let upm = f64::from(face.units_per_em());
        Some((
            f64::from(face.ascender()) / upm,
            f64::from(face.descender()) / upm,
        ))
    }
    let body = hhea_metrics(
        font_bytes
            .selected_body
            .as_ref()
            .map(|fonts| &fonts.regular)
            .unwrap_or(&font_bytes.regular),
    )
    .ok_or_else(|| EngineError::Validation("body font metrics missing".into()))?;
    let icon = hhea_metrics(&font_bytes.icon)
        .ok_or_else(|| EngineError::Validation("icon font metrics missing".into()))?;
    let heading = font_bytes
        .heading
        .as_ref()
        .map(|fonts| {
            hhea_metrics(&fonts.regular)
                .ok_or_else(|| EngineError::Validation("heading font metrics missing".into()))
        })
        .transpose()?;
    let heading_family = font_bytes.heading.as_ref().map(|fonts| fonts.family);
    let parsed = (
        book,
        fonts,
        FontVerticalMetrics {
            body,
            bundled_body: hhea_metrics(&font_bytes.regular)
                .ok_or_else(|| EngineError::Validation("bundled body metrics missing".into()))?,
            body_family: font_bytes
                .selected_body
                .as_ref()
                .map_or("Source Han Serif", |fonts| fonts.family),
            icon,
            heading,
            heading_family,
        },
    );
    *guard = Some((key, parsed.clone()));
    Ok(parsed)
}

pub(super) fn fixture_id(name: &str) -> FileId {
    RootedPath::new(
        VirtualRoot::Project,
        VirtualPath::new(name).expect("static template path"),
    )
    .intern()
}

/// 由模板 ID 推导渲染模式：未知 ID 回退 legacy（F19：元数据保留，界面另行提示）。
pub(super) fn template_mode(template_id: &str) -> &'static str {
    match template_id {
        "clear-single-v1" => "clear",
        "compact-single-v1" => "compact",
        _ => "legacy",
    }
}

pub(super) fn sanitize_hex(theme: &str) -> Result<String, EngineError> {
    let theme = theme.trim();
    if !theme.starts_with('#')
        || theme.len() != 7
        || !theme[1..].bytes().all(|byte| byte.is_ascii_hexdigit())
    {
        return Err(EngineError::Validation(format!(
            "Theme color {theme} is not a #rrggbb value"
        )));
    }
    Ok(theme.to_ascii_lowercase())
}

pub(super) fn lucide_svg(paths: &str, color: &str) -> Bytes {
    Bytes::new(
        format!(
            "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"24\" height=\"24\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"{color}\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\">{paths}</svg>"
        )
        .into_bytes(),
    )
}

/// 计算周岁年龄（与旧版 calculateAge 一致，参考日期为冻结值）。
pub(super) fn age_years(birth: &str, reference: (i32, u8, u8)) -> Option<u32> {
    let mut parts = birth.splitn(2, '-');
    let year: i32 = parts.next()?.parse().ok()?;
    let month: u32 = parts.next()?.parse().ok()?;
    Some((reference.0 - year - ((reference.1 as u32) < month) as i32).max(0) as u32)
}

/// 站点显示标签：与旧 CSS 语义一致，仅剥离协议前缀
/// （模板原为 `shown.replace(regex("^https?://"), "")`）。
pub(super) fn site_label(url: &str) -> String {
    let shown = if url.starts_with("http") {
        url.to_owned()
    } else {
        format!("https://{url}")
    };
    shown
        .strip_prefix("https://")
        .or_else(|| shown.strip_prefix("http://"))
        .unwrap_or(&shown)
        .to_owned()
}

pub(super) fn contact_layout_for_date(
    document: &ResumeDocument,
    reference_date: (i32, u8, u8),
) -> ContactLayout {
    let basic = &document.basic;
    let entry = |field: &str, glyph: Option<&str>, value: &str| {
        if value.is_empty() {
            None
        } else {
            Some(ContactItem {
                node_id: format!("basic:{field}"),
                glyph: glyph.map(str::to_owned),
                value: value.to_owned(),
            })
        }
    };
    let primary: Vec<_> = [
        entry("phone", Some("\u{e75b}"), &basic.phone),
        entry("email", Some("\u{e74a}"), &basic.email),
        entry("wechat", Some("\u{e73e}"), &basic.wechat),
    ]
    .into_iter()
    .flatten()
    .collect();

    let mut secondary: Vec<ContactItem> = Vec::new();
    if !basic.birth.is_empty() {
        let label = if basic.age_mode == zinecv_contracts::AgeMode::Age {
            let years = age_years(&basic.birth, reference_date).unwrap_or(0);
            format!("{years}岁")
        } else {
            format!("{} 出生", basic.birth)
        };
        secondary.push(ContactItem {
            node_id: "basic:birth".into(),
            glyph: Some("\u{e75e}".into()),
            value: label,
        });
    }
    if !basic.city.is_empty() {
        secondary.push(ContactItem {
            node_id: "basic:city".into(),
            glyph: Some("\u{e732}".into()),
            value: basic.city.clone(),
        });
    }
    let optional = [
        ("gender", &basic.gender),
        ("height", &basic.height),
        ("weight", &basic.weight),
        ("ethnicity", &basic.ethnicity),
        ("birthplace", &basic.birthplace),
        ("politicalStatus", &basic.political_status),
        ("maritalStatus", &basic.marital_status),
        ("zodiac", &basic.zodiac),
        ("mbti", &basic.mbti),
    ];
    for (field, value) in optional {
        if let Some(item) = value.as_deref().and_then(|value| entry(field, None, value)) {
            secondary.push(item);
        }
    }

    let sites: Vec<SiteItem> = [("website", &basic.website), ("linkedin", &basic.linkedin)]
        .into_iter()
        .filter_map(|(field, value)| value.as_deref().map(|value| (field, value)))
        .filter(|(_, value)| !value.is_empty())
        .map(|(field, url)| SiteItem {
            node_id: format!("basic:{field}"),
            url: url.to_owned(),
            label: site_label(url),
        })
        .collect();

    ContactLayout {
        primary,
        secondary,
        sites,
    }
}

pub(super) fn contact_json(contact: &ContactLayout) -> serde_json::Value {
    let item = |entry: &ContactItem| serde_json::json!({ "nodeId": entry.node_id, "glyph": entry.glyph, "value": entry.value });
    let primary: Vec<_> = contact.primary.iter().map(item).collect();
    let secondary: Vec<_> = contact.secondary.iter().map(item).collect();
    let sites: Vec<_> = contact
        .sites
        .iter()
        .map(|site| serde_json::json!({ "nodeId": site.node_id, "url": site.url, "label": site.label }))
        .collect();
    serde_json::json!({ "primary": primary, "secondary": secondary, "sites": sites })
}

/// 日期标签：仅 "YYYY-MM…" 转格式；"至今"等原样保留
/// （旧版"至今年undefined月"缺陷已修复，不照搬 bug）。
/// 与原模板 dateLabel 逐字等价：含 "-" 且码点数 >= 7 才转换。
pub(super) fn date_label(value: &str, format: DateFormat) -> String {
    if value.is_empty() {
        return String::new();
    }
    if value.contains('-') && value.chars().count() >= 7 {
        let mut parts = value.split('-');
        let year = parts.next().unwrap_or("");
        let month = parts.next().unwrap_or("");
        match format {
            DateFormat::Dotted => format!("{year}.{month}"),
            DateFormat::Chinese => format!("{year}年{month}月"),
        }
    } else {
        value.to_owned()
    }
}

pub(super) fn range_label(start: &str, end: &str, format: DateFormat) -> String {
    format!(
        "{} - {}",
        date_label(start, format),
        date_label(end, format)
    )
}

pub(super) fn meta_join(parts: &[&str]) -> String {
    parts
        .iter()
        .filter(|part| !part.is_empty())
        .copied()
        .collect::<Vec<_>>()
        .join(" ")
}

/// 条目头部元数据：教育经历含学历方式缺省"全日制"与学院。
pub(super) fn entry_meta(kind: &ModuleKind, entry: &Entry) -> String {
    if matches!(kind, ModuleKind::Education) {
        let mode = entry.mode.as_deref().unwrap_or("全日制");
        meta_join(&[
            &entry.role,
            &entry.department,
            mode,
            entry.college.as_deref().unwrap_or(""),
        ])
    } else {
        meta_join(&[&entry.role, &entry.department])
    }
}

/// 单行标题的内联元数据（含分隔符前缀语义）。
pub(super) fn inline_meta(meta: &str, title: &str, separator: Separator) -> String {
    if meta.is_empty() {
        String::new()
    } else if title.is_empty() {
        meta.to_owned()
    } else {
        let sep = match separator {
            Separator::Enabled => " - ",
            Separator::Disabled => " ",
        };
        format!("{sep}{meta}")
    }
}

/// 条目日期区间：教育经历始终渲染；其余仅当 start 非空。
pub(super) fn entry_range(kind: &ModuleKind, entry: &Entry, format: DateFormat) -> String {
    if matches!(kind, ModuleKind::Education) || !entry.start.is_empty() {
        range_label(&entry.start, &entry.end, format)
    } else {
        String::new()
    }
}

pub(super) fn computed_entry(
    kind: &ModuleKind,
    entry: &Entry,
    presentation: &Presentation,
) -> ComputedEntry {
    let meta = entry_meta(kind, entry);
    ComputedEntry {
        inline_meta: inline_meta(&meta, &entry.title, presentation.separator),
        range: entry_range(kind, entry, presentation.date_format),
        meta,
    }
}

/// 条目级预计算载荷（与 doc.sections 按索引对齐；summary 节为空数组）。
pub(super) fn computed_json(document: &ResumeDocument) -> serde_json::Value {
    let sections: Vec<_> = document
        .sections
        .iter()
        .map(|section| match section {
            Section::Entry(section) => {
                let entries: Vec<_> = section
                    .entries
                    .iter()
                    .map(|entry| {
                        let computed = computed_entry(&section.kind, entry, &document.presentation);
                        serde_json::json!({
                            "meta": computed.meta,
                            "inlineMeta": computed.inline_meta,
                            "range": computed.range,
                        })
                    })
                    .collect();
                serde_json::json!({ "entries": entries })
            }
            Section::Summary(_) => serde_json::json!({ "entries": [] }),
        })
        .collect();
    serde_json::json!({ "sections": sections })
}
