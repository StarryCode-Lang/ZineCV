use super::*;
use crate::domain::Inline;
use std::collections::HashMap;
use typst::foundations::Value;
use typst::introspection::{MetadataElem, Tag};
use typst::layout::{Frame, FrameItem, Point, Transform};

// ---------------------------------------------------------------------------
// 正式 TextMap（开发计划 §4；F15 选字/命中层的引擎侧基础）
// ---------------------------------------------------------------------------
//
// 结构：logicalText 按语义阅读顺序（文档模型顺序）拼接全部可选中文本叶子；
// clusters 是从编译后 frame 提取的字形簇矩形，startUtf16/endUtf16 指回
// logicalText 的 UTF-16 区间。每个簇在构建时强制回切校验
// （叶子文本在 sourceByteOffset 处的子串必须等于簇文本），校验失败即错误，
// 不输出静默降级的文本层。跨页叶子自然拆成同节点 ID 的多个簇。
//
// 矩形语义：水平方向取簇的光标推进区间（精确），竖直方向取所在文本 run
// 的 bbox 上下界（run 内一致）；连字/组合字符按 shaping cluster 合并。
// 装饰文字（图标字形、CSDN 字样、有序列表编号）由模板 !deco 标记排除，
// 与旧 DOM 中 CSS marker 不可选中的行为一致。

pub use crate::domain::{HitFragment, HitRegion, TextCluster, TextLink, TextMap};

fn hit_regions(document: &ResumeDocument, clusters: &[TextCluster]) -> Vec<HitRegion> {
    let mut roots = Vec::new();
    for section in &document.sections {
        match section {
            Section::Entry(section) => {
                roots.push(format!("section:{}", section.id));
                roots.extend(
                    section
                        .entries
                        .iter()
                        .map(|entry| format!("entry:{}", entry.id)),
                );
            }
            Section::Summary(section) => roots.push(format!("section:{}", section.id)),
        }
    }
    // Domain IDs may themselves contain colons or share a prefix.
    roots.sort_by_key(|root| std::cmp::Reverse(root.len()));
    let mut regions: Vec<HitRegion> = Vec::new();
    let mut indices = HashMap::new();
    for cluster in clusters {
        let id = roots
            .iter()
            .find(|root| {
                cluster
                    .source_node_id
                    .strip_prefix(root.as_str())
                    .is_some_and(|suffix| suffix.starts_with(':'))
            })
            .cloned()
            .unwrap_or_else(|| cluster.source_node_id.clone());
        let index = *indices.entry(id.clone()).or_insert_with(|| {
            let index = regions.len();
            regions.push(HitRegion {
                source_node_id: id,
                semantic_order: index as u32,
                fragments: Vec::new(),
            });
            index
        });
        let fragments = &mut regions[index].fragments;
        if let Some(previous) = fragments.last_mut() {
            let previous_right = previous.x_pt + previous.width_pt;
            if previous.page == cluster.page
                && previous.end_utf16 == cluster.start_utf16
                && (previous.y_pt - cluster.y_pt).abs() < 0.01
                && (previous.height_pt - cluster.height_pt).abs() < 0.01
                && (previous_right - cluster.x_pt).abs() < 0.1
            {
                let right = previous_right.max(cluster.x_pt + cluster.width_pt);
                previous.x_pt = previous.x_pt.min(cluster.x_pt);
                previous.width_pt = right - previous.x_pt;
                previous.end_utf16 = cluster.end_utf16;
                continue;
            }
        }
        fragments.push(HitFragment {
            page: cluster.page,
            start_utf16: cluster.start_utf16,
            end_utf16: cluster.end_utf16,
            x_pt: cluster.x_pt,
            y_pt: cluster.y_pt,
            width_pt: cluster.width_pt,
            height_pt: cluster.height_pt,
        });
    }
    regions
}

/// 逻辑文本叶子项：文本叶子或软换行。
pub(super) enum LeafItem {
    Text {
        node_id: String,
        text: String,
        href: Option<String>,
    },
    Break,
    Boundary,
}

impl LeafItem {
    fn text(node_id: String, text: &str) -> Self {
        Self::Text {
            node_id,
            text: text.to_owned(),
            href: None,
        }
    }
}

/// 与模板 flattenInlines 镜像：link 子节点并入同一叶子序号序列。
fn flatten_inlines(children: &[Inline], path: &str, out: &mut Vec<LeafItem>) {
    out.push(LeafItem::Boundary);
    let mut leaf_index = 0usize;
    flatten_inlines_into(children, path, &mut leaf_index, out, None);
}

fn flatten_inlines_into(
    children: &[Inline],
    path: &str,
    leaf_index: &mut usize,
    out: &mut Vec<LeafItem>,
    href: Option<&str>,
) {
    for node in children {
        match node {
            Inline::Text { text, .. } => {
                out.push(LeafItem::Text {
                    node_id: format!("{path}:l{leaf_index}"),
                    text: text.clone(),
                    href: href.map(str::to_owned),
                });
                *leaf_index += 1;
            }
            Inline::Link { children, href } => {
                flatten_inlines_into(children, path, leaf_index, out, Some(href));
            }
            Inline::Break => {
                out.push(LeafItem::Break);
                *leaf_index += 1;
            }
        }
    }
}

/// 与模板 renderListBlock 镜像的列表遍历。
fn walk_list(items: &[Vec<RichBlock>], path: &str, out: &mut Vec<LeafItem>) {
    for (item_index, item) in items.iter().enumerate() {
        for (block_index, inner) in item.iter().enumerate() {
            let inner_path = format!("{path}:i{item_index}:b{block_index}");
            match inner {
                RichBlock::Paragraph { children } => flatten_inlines(children, &inner_path, out),
                RichBlock::List { items: nested, .. } => walk_list(nested, &inner_path, out),
            }
        }
    }
}

/// 与模板 renderBlocks 镜像的块遍历。
fn walk_blocks(blocks: &[RichBlock], path: &str, out: &mut Vec<LeafItem>) {
    for (block_index, block) in blocks.iter().enumerate() {
        let block_path = format!("{path}:b{block_index}");
        match block {
            RichBlock::Paragraph { children } => flatten_inlines(children, &block_path, out),
            RichBlock::List { items, .. } => walk_list(items, &block_path, out),
        }
    }
}

/// 按语义阅读顺序收集文档全部可选中叶子（隐藏节不渲染、不进入序列）。
/// 顺序与模板渲染顺序严格一致：姓名 → 联系主行 → 次行 → 站点 →
/// 各可见节（节标题 → 各条目头 → 正文块）。
fn push_logical_leaf(out: &mut Vec<LeafItem>, leaf: LeafItem) {
    out.push(LeafItem::Boundary);
    out.push(leaf);
}

#[cfg(test)]
pub(super) fn logical_leaf_items(document: &ResumeDocument) -> Vec<LeafItem> {
    logical_leaf_items_for_date(document, DEFAULT_REFERENCE_DATE)
}

fn logical_leaf_items_for_date(
    document: &ResumeDocument,
    reference_date: (i32, u8, u8),
) -> Vec<LeafItem> {
    let mut out = Vec::new();
    let basic = &document.basic;
    push_logical_leaf(&mut out, LeafItem::text("basic:name".into(), &basic.name));
    let contact = contact_layout_for_date(document, reference_date);
    for item in &contact.primary {
        push_logical_leaf(&mut out, LeafItem::text(item.node_id.clone(), &item.value));
    }
    for item in &contact.secondary {
        push_logical_leaf(&mut out, LeafItem::text(item.node_id.clone(), &item.value));
    }
    for site in &contact.sites {
        let href = if site.url.starts_with("http") {
            site.url.clone()
        } else {
            format!("https://{}", site.url)
        };
        push_logical_leaf(
            &mut out,
            LeafItem::Text {
                node_id: site.node_id.clone(),
                text: site.label.clone(),
                href: Some(href),
            },
        );
    }
    for section in &document.sections {
        match section {
            Section::Entry(section) => {
                if !section.visible {
                    continue;
                }
                push_logical_leaf(
                    &mut out,
                    LeafItem::text(format!("section:{}:head", section.id), &section.title),
                );
                for entry in &section.entries {
                    let computed = computed_entry(&section.kind, entry, &document.presentation);
                    let prefix = format!("entry:{}", entry.id);
                    // 与渲染视觉顺序一致：单行为 标题/内联元数据/日期；
                    // 双行为 标题/日期（首行）→ 元数据（次行）。
                    match document.presentation.title_format {
                        TitleFormat::SingleLine => {
                            push_logical_leaf(
                                &mut out,
                                LeafItem::text(format!("{prefix}:title"), &entry.title),
                            );
                            push_logical_leaf(
                                &mut out,
                                LeafItem::text(format!("{prefix}:imeta"), &computed.inline_meta),
                            );
                            push_logical_leaf(
                                &mut out,
                                LeafItem::text(format!("{prefix}:dates"), &computed.range),
                            );
                        }
                        TitleFormat::DoubleLine => {
                            push_logical_leaf(
                                &mut out,
                                LeafItem::text(format!("{prefix}:title"), &entry.title),
                            );
                            push_logical_leaf(
                                &mut out,
                                LeafItem::text(format!("{prefix}:dates"), &computed.range),
                            );
                            push_logical_leaf(
                                &mut out,
                                LeafItem::text(format!("{prefix}:meta"), &computed.meta),
                            );
                        }
                    }
                    walk_blocks(&entry.body, &prefix, &mut out);
                }
            }
            Section::Summary(section) => {
                if !section.visible {
                    continue;
                }
                push_logical_leaf(
                    &mut out,
                    LeafItem::text(format!("section:{}:head", section.id), &section.title),
                );
                walk_blocks(&section.body, &format!("section:{}", section.id), &mut out);
            }
        }
    }
    out
}

/// 拼接 logicalText 并记录每个非空文本叶子的 UTF-16 基址。
/// 段落/字段边界插入换行，段内格式或链接切换保持相邻文本连续。
/// 软换行始终占一个换行（包括连续空行）；UTF-16 长度增量累加。
fn assemble_logical(items: &[LeafItem]) -> (String, HashMap<String, (String, usize)>) {
    let mut logical = String::new();
    let mut pending_boundary = false;
    let mut utf16_len = 0;
    let mut leaves: HashMap<String, (String, usize)> = HashMap::new();
    for item in items {
        match item {
            LeafItem::Boundary => pending_boundary = true,
            LeafItem::Break => {
                logical.push('\n');
                utf16_len += 1;
                pending_boundary = false;
            }
            LeafItem::Text { node_id, text, .. } => {
                if text.is_empty() {
                    continue;
                }
                if pending_boundary && !logical.is_empty() && !logical.ends_with('\n') {
                    logical.push('\n');
                    utf16_len += 1;
                }
                leaves.insert(node_id.clone(), (text.clone(), utf16_len));
                logical.push_str(text);
                utf16_len += text.encode_utf16().count();
                pending_boundary = false;
            }
        }
    }
    (logical, leaves)
}

/// 从 frame 提取的原始簇（尚未映射到 logicalText）。
struct RawCluster {
    node_id: String,
    text: String,
    byte_offset: usize,
    page: u32,
    x_pt: f64,
    y_pt: f64,
    width_pt: f64,
    height_pt: f64,
}

/// frame 遍历中的标记状态：未标记（模板缺陷，报错）、装饰（跳过）、
/// 叶子节点（收集簇）。
#[derive(Clone)]
enum MarkerState {
    Unmarked,
    Decorative,
    Node(String, usize),
}

fn collect_clusters(
    frame: &Frame,
    parent: Transform,
    current: &mut MarkerState,
    page: u32,
    out: &mut Vec<RawCluster>,
    problems: &mut Vec<String>,
) {
    for (position, item) in frame.items() {
        match item {
            FrameItem::Group(group) => {
                let transform = parent
                    .pre_concat(Transform::translate(position.x, position.y))
                    .pre_concat(group.transform);
                collect_clusters(&group.frame, transform, current, page, out, problems);
            }
            FrameItem::Tag(Tag::Start(content, _)) => {
                if let Some(metadata) = content.to_packed::<MetadataElem>() {
                    if let Value::Str(value) = &metadata.value {
                        if let Some(id) = value.as_str().strip_prefix("node:") {
                            *current = if id == "!deco" {
                                MarkerState::Decorative
                            } else {
                                MarkerState::Node(id.to_owned(), 0)
                            };
                        } else if let Some(chunk) = value.as_str().strip_prefix("chunk:") {
                            if let Some((offset, id)) = chunk.split_once(":node:") {
                                match offset.parse::<usize>() {
                                    Ok(offset) => {
                                        *current = MarkerState::Node(id.to_owned(), offset)
                                    }
                                    Err(_) => problems.push("invalid chunk byte offset".into()),
                                }
                            }
                        }
                    }
                }
            }
            FrameItem::Text(text) => {
                let (node_id, byte_base) = match current {
                    MarkerState::Node(id, byte_base) => (id.clone(), *byte_base),
                    MarkerState::Decorative => continue,
                    MarkerState::Unmarked => {
                        problems.push(format!(
                            "unmarked text run on page {page}: {:?}",
                            text.text.as_str().chars().take(24).collect::<String>()
                        ));
                        continue;
                    }
                };
                let bbox = text.bbox();
                let top = bbox.min.y.min(bbox.max.y);
                let bottom = bbox.min.y.max(bbox.max.y);
                let mut cursor = Point::zero();
                for glyph in &text.glyphs {
                    let range = glyph.range();
                    if let Some(logical) = text.text.get(range.clone()) {
                        let start_cursor = cursor;
                        cursor.x += glyph.x_advance.at(text.size);
                        cursor.y -= glyph.y_advance.at(text.size);
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
                        out.push(RawCluster {
                            node_id: node_id.clone(),
                            text: logical.to_owned(),
                            byte_offset: byte_base + glyph.span.1 as usize,
                            page,
                            x_pt: min_x,
                            y_pt: min_y,
                            width_pt: max_x - min_x,
                            height_pt: max_y - min_y,
                        });
                    }
                }
            }
            _ => {}
        }
    }
}

/// 原始簇 → 正式 TextMap：逐簇回切校验后映射 UTF-16 区间并按阅读顺序编号。
fn build_text_map(
    document: &ResumeDocument,
    items: &[LeafItem],
    raw: Vec<RawCluster>,
) -> Result<TextMap, EngineError> {
    let (logical_text, leaves) = assemble_logical(items);
    // The current templates use zh/LTR paragraph direction. Resolve embedding
    // levels across complete logical paragraphs, including rich-inline leaves.
    let bidi = unicode_bidi::BidiInfo::new(&logical_text, Some(unicode_bidi::Level::ltr()));
    let mut rtl_units = Vec::with_capacity(logical_text.encode_utf16().count());
    for (byte, character) in logical_text.char_indices() {
        rtl_units.extend(std::iter::repeat_n(
            bidi.levels[byte].is_rtl(),
            character.len_utf16(),
        ));
    }
    // Build each byte-to-UTF-16 lookup once. Recounting the entire prefix for
    // every glyph makes a large paragraph quadratic in length.
    let offsets: HashMap<_, _> = leaves
        .iter()
        .map(|(id, (text, _))| {
            let mut lookup = vec![0usize; text.len() + 1];
            let mut units = 0;
            for (byte, character) in text.char_indices() {
                lookup[byte] = units;
                units += character.len_utf16();
            }
            lookup[text.len()] = units;
            (id.clone(), lookup)
        })
        .collect();
    let mut clusters = Vec::with_capacity(raw.len());
    for cluster in raw {
        let Some((leaf_text, base)) = leaves.get(&cluster.node_id) else {
            return Err(EngineError::TextMap(format!(
                "cluster references unknown node {}",
                cluster.node_id
            )));
        };
        let end_byte = cluster.byte_offset + cluster.text.len();
        if leaf_text.get(cluster.byte_offset..end_byte) != Some(cluster.text.as_str()) {
            return Err(EngineError::TextMap(format!(
                "cluster text mismatch on node {} at byte {}",
                cluster.node_id, cluster.byte_offset
            )));
        }
        let start = base + offsets[&cluster.node_id][cluster.byte_offset];
        let end = start + cluster.text.encode_utf16().count();
        clusters.push(TextCluster {
            source_node_id: cluster.node_id,
            start_utf16: start as u32,
            end_utf16: end as u32,
            logical_order: 0,
            page: cluster.page,
            x_pt: cluster.x_pt,
            y_pt: cluster.y_pt,
            width_pt: cluster.width_pt,
            height_pt: cluster.height_pt,
            rtl: rtl_units[start],
        });
    }
    clusters.sort_by_key(|cluster| cluster.start_utf16);
    for (order, cluster) in clusters.iter_mut().enumerate() {
        cluster.logical_order = order as u32;
    }
    Ok(TextMap {
        version: 1,
        logical_text,
        hit_regions: hit_regions(document, &clusters),
        links: items
            .iter()
            .filter_map(|item| {
                let LeafItem::Text {
                    node_id,
                    href: Some(href),
                    ..
                } = item
                else {
                    return None;
                };
                let (text, start) = leaves.get(node_id)?;
                if !(href.starts_with("https://")
                    || href.starts_with("http://")
                    || href.starts_with("mailto:"))
                {
                    return None;
                }
                Some(TextLink {
                    source_node_id: node_id.clone(),
                    start_utf16: *start as u32,
                    end_utf16: (*start + text.encode_utf16().count()) as u32,
                    href: href.clone(),
                })
            })
            .collect(),
        clusters,
    })
}

/// 编译当前文档并提取正式 TextMap（F15 选字/命中层数据基础）。
/// 任何标记缺失或簇校验失败都返回错误，不输出降级文本层。
pub fn render_text_map(
    document: &ResumeDocument,
    avatar: AvatarAsset,
) -> Result<TextMap, EngineError> {
    let paged = render_paged(document, avatar)?;
    text_map_from_paged(document, &paged, DEFAULT_REFERENCE_DATE)
}

pub(super) fn text_map_from_paged(
    document: &ResumeDocument,
    paged: &PagedDocument,
    reference_date: (i32, u8, u8),
) -> Result<TextMap, EngineError> {
    let items = logical_leaf_items_for_date(document, reference_date);
    let mut raw = Vec::new();
    let mut current = MarkerState::Unmarked;
    let mut problems = Vec::new();
    for (index, page) in paged.pages().iter().enumerate() {
        collect_clusters(
            &page.frame,
            Transform::identity(),
            &mut current,
            index as u32 + 1,
            &mut raw,
            &mut problems,
        );
    }
    if !problems.is_empty() {
        return Err(EngineError::TextMap(problems.join("; ")));
    }
    build_text_map(document, &items, raw)
}
