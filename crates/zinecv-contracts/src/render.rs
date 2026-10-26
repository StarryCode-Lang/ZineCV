use super::*;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../src/domain/bindings/")]
#[serde(rename_all = "lowercase")]
pub enum RenderFormat {
    Pdf,
    Png,
    Svg,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../src/domain/bindings/")]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RenderRequest {
    pub request_id: Id,
    pub cursor: AuthorityCursor,
    pub format: RenderFormat,
    pub dpi: Option<u16>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../src/domain/bindings/")]
#[serde(rename_all = "camelCase")]
pub struct RenderResult {
    pub request_id: Id,
    pub cursor: AuthorityCursor,
    pub format: RenderFormat,
    pub page_count: u32,
    pub content_hash: Sha256,
    pub bytes: Vec<u8>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../src/domain/bindings/")]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PreviewPage {
    pub page_hash: Sha256,
    pub width_pt: f64,
    pub height_pt: f64,
    pub svg: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../src/domain/bindings/")]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PreviewData {
    pub pages: Vec<PreviewPage>,
    pub text_map: TextMap,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../src/domain/bindings/")]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PreviewResult {
    pub cursor: AuthorityCursor,
    pub render_key: Sha256,
    pub data: PreviewData,
}

/// TextMap 协议版本 1 的字形簇。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../src/domain/bindings/")]
#[serde(rename_all = "camelCase")]
pub struct TextCluster {
    pub source_node_id: String,
    pub start_utf16: u32,
    pub end_utf16: u32,
    pub logical_order: u32,
    pub page: u32,
    pub x_pt: f64,
    pub y_pt: f64,
    pub width_pt: f64,
    pub height_pt: f64,
    #[serde(default)]
    pub rtl: bool,
}

/// 正式 TextMap：逻辑文本 + 全部字形簇（按 logicalOrder 即阅读顺序排序）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../src/domain/bindings/")]
#[serde(rename_all = "camelCase")]
pub struct TextMap {
    pub version: u8,
    pub logical_text: String,
    pub clusters: Vec<TextCluster>,
    pub hit_regions: Vec<HitRegion>,
    #[serde(default)]
    pub links: Vec<TextLink>,
}

/// Domain link destinations bound to the same logical leaf ranges as rendered glyphs.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../src/domain/bindings/")]
#[serde(rename_all = "camelCase")]
pub struct TextLink {
    pub source_node_id: String,
    pub start_utf16: u32,
    pub end_utf16: u32,
    pub href: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../src/domain/bindings/")]
#[serde(rename_all = "camelCase")]
pub enum FitStatus {
    AlreadyFits,
    Fitted,
    NoFit,
    Unreadable,
    Cancelled,
    TimedOut,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../src/domain/bindings/")]
#[serde(rename_all = "camelCase")]
pub struct FitAttempt {
    pub candidate_index: u8,
    pub page_count: u32,
}

/// A read-only fit proposal; applying it still requires the frozen authority cursor.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../src/domain/bindings/")]
#[serde(rename_all = "camelCase")]
pub struct FitPlan {
    pub status: FitStatus,
    pub semantic_hash: String,
    pub original_presentation: Presentation,
    pub fitted_presentation: Option<Presentation>,
    pub attempts: Vec<FitAttempt>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../src/domain/bindings/")]
#[serde(rename_all = "camelCase")]
pub struct FitResult {
    pub cursor: AuthorityCursor,
    pub render_key: String,
    pub plan: FitPlan,
}

/// 同一领域节点的可命中片段；不把跨行/跨页空白合并成一个大矩形。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../src/domain/bindings/")]
#[serde(rename_all = "camelCase")]
pub struct HitFragment {
    pub page: u32,
    pub start_utf16: u32,
    pub end_utf16: u32,
    pub x_pt: f64,
    pub y_pt: f64,
    pub width_pt: f64,
    pub height_pt: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../src/domain/bindings/")]
#[serde(rename_all = "camelCase")]
pub struct HitRegion {
    pub source_node_id: String,
    pub semantic_order: u32,
    pub fragments: Vec<HitFragment>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../src/domain/bindings/")]
#[serde(rename_all = "camelCase")]
pub struct ExportPng {
    pub page: u32,
    pub width: u32,
    pub height: u32,
    pub sha256: String,
    pub data_base64: String,
}

/// 导出产物选择：`bundle` = PDF+PNG+TextMap 完整包（缺省值，等于现行完整
/// 行为并保持向后兼容）；`pdf` = 仅 PDF（可附 1-based 页码选择）；`png` =
/// 仅 PNG 页图与长图。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../src/domain/bindings/")]
#[serde(rename_all = "snake_case")]
pub enum ExportProduct {
    Bundle,
    Pdf,
    Png,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../src/domain/bindings/")]
#[serde(rename_all = "camelCase")]
pub struct ExportData {
    pub pdf_base64: String,
    pub pdf_sha256: String,
    pub page_count: u32,
    pub text_map: TextMap,
    pub png_pages: Vec<ExportPng>,
    pub long_png: Option<ExportPng>,
    pub long_image_limited: bool,
    pub dpi: u16,
    /// 本次导出的产物选择；缺省（None）按 Bundle 解释，向后兼容旧载荷。
    #[serde(default)]
    pub product: Option<ExportProduct>,
    /// `product = pdf` 且非空时生效的 1-based 页码选择（已排序去重）；
    /// 其余产物为 None。
    #[serde(default)]
    pub selected_pages: Option<Vec<u32>>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../src/domain/bindings/")]
#[serde(rename_all = "camelCase")]
pub struct ExportResult {
    pub cursor: AuthorityCursor,
    pub render_key: String,
    pub data: ExportData,
}
