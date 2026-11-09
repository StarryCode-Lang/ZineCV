use super::*;

pub type Id = String;
pub type Revision = String;
pub type Sha256 = String;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../src/domain/bindings/")]
#[serde(rename_all = "lowercase")]
pub enum ModuleKind {
    Education,
    Skills,
    Work,
    Projects,
    Orgs,
    Research,
    Awards,
    Other,
    Portfolio,
    Custom,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../src/domain/bindings/")]
#[serde(rename_all = "lowercase")]
pub enum AgeMode {
    Age,
    Birthday,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../src/domain/bindings/")]
#[serde(rename_all = "lowercase")]
pub enum InlineMark {
    Bold,
    Italic,
    Underline,
    Strike,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../src/domain/bindings/")]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum Inline {
    Text {
        text: String,
        marks: Vec<InlineMark>,
    },
    Link {
        href: String,
        children: Vec<Inline>,
    },
    Break,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../src/domain/bindings/")]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum RichBlock {
    Paragraph {
        children: Vec<Inline>,
    },
    List {
        ordered: bool,
        start: Option<u32>,
        items: Vec<Vec<RichBlock>>,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../src/domain/bindings/")]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub id: Id,
    pub title: String,
    pub role: String,
    pub department: String,
    pub city: String,
    pub start: String,
    pub end: String,
    pub college: Option<String>,
    pub mode: Option<String>,
    pub body: Vec<RichBlock>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../src/domain/bindings/")]
#[serde(rename_all = "camelCase")]
pub struct EntrySection {
    pub id: Id,
    pub kind: ModuleKind,
    pub title: String,
    pub visible: bool,
    pub entries: Vec<Entry>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../src/domain/bindings/")]
#[serde(rename_all = "camelCase")]
pub struct SummarySection {
    pub id: Id,
    pub kind: String,
    pub title: String,
    pub visible: bool,
    pub body: Vec<RichBlock>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../src/domain/bindings/")]
#[serde(untagged)]
pub enum Section {
    Entry(EntrySection),
    Summary(SummarySection),
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../src/domain/bindings/")]
#[serde(rename_all = "camelCase")]
pub struct BasicInfo {
    pub name: String,
    pub phone: String,
    pub email: String,
    pub city: String,
    pub wechat: String,
    pub birth: String,
    pub age_mode: AgeMode,
    pub website: Option<String>,
    pub linkedin: Option<String>,
    pub gender: Option<String>,
    pub height: Option<String>,
    pub weight: Option<String>,
    pub ethnicity: Option<String>,
    pub birthplace: Option<String>,
    pub political_status: Option<String>,
    pub marital_status: Option<String>,
    pub zodiac: Option<String>,
    pub mbti: Option<String>,
    pub avatar_asset_id: Option<Id>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../src/domain/bindings/")]
#[serde(rename_all = "lowercase")]
pub enum Density {
    Comfortable,
    Standard,
    Compact,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../src/domain/bindings/")]
pub enum DateFormat {
    #[serde(rename = "2021年1月")]
    Chinese,
    #[serde(rename = "2021.01")]
    Dotted,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../src/domain/bindings/")]
pub enum TitleFormat {
    #[serde(rename = "双行标题")]
    DoubleLine,
    #[serde(rename = "单行标题")]
    SingleLine,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../src/domain/bindings/")]
pub enum Separator {
    #[serde(rename = "使用分隔符号")]
    Enabled,
    #[serde(rename = "不使用分隔符号")]
    Disabled,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../src/domain/bindings/")]
pub enum TextAlign {
    #[serde(rename = "系统默认")]
    Default,
    #[serde(rename = "两端对齐")]
    Justify,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../src/domain/bindings/")]
#[serde(rename_all = "camelCase")]
pub struct Presentation {
    pub template_id: Id,
    pub template_revision: Id,
    pub density: Density,
    pub font_set_id: Id,
    pub font_size_pt: f32,
    pub line_height_pt: f32,
    pub module_gap_pt: f32,
    pub page_margin_pt: f32,
    pub heading_size_pt: f32,
    pub paragraph_gap_pt: f32,
    pub list_gap_pt: f32,
    pub theme: String,
    pub date_format: DateFormat,
    pub title_format: TitleFormat,
    pub separator: Separator,
    pub text_align: TextAlign,
    #[ts(type = "Record<string, string | number>")]
    pub legacy_overrides: BTreeMap<String, serde_json::Value>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../src/domain/bindings/")]
#[serde(rename_all = "camelCase")]
pub struct ResumeDocument {
    #[ts(type = "2")]
    pub schema_version: u8,
    pub document_id: Id,
    pub title: String,
    pub basic: BasicInfo,
    pub sections: Vec<Section>,
    pub presentation: Presentation,
    pub source_ref: Option<SourceRef>,
    #[ts(type = "Record<string, unknown>")]
    pub legacy_extensions: BTreeMap<String, serde_json::Value>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../src/domain/bindings/")]
#[serde(rename_all = "camelCase")]
pub struct SourceRef {
    pub import_id: Id,
    pub preview_asset_id: Option<Id>,
}

/// 规范化 JSON 序列化后的 SHA-256：命令幂等键、快照哈希与 CAS 的统一基础。
pub fn canonical_hash<T: Serialize>(value: &T) -> Result<Sha256, AppError> {
    let bytes = serde_json::to_vec(value).map_err(|_| {
        AppError::new(
            ErrorCode::Validation,
            "Value cannot be canonicalized",
            false,
        )
    })?;
    Ok(format!("{:x}", Sha256Hasher::digest(bytes)))
}

/* ==== 原 documents.rs ====
 * M2 文档元数据与 activeDocument 契约（设计稿 docs/m2-contract-design.md §2）。
 * 归档/恢复不是 DomainCommand：不进简历内容 hash、不推进 documents.revision，
 * 走独立命令 + command_receipts 幂等。active 是宿主会话状态，不写入 documents 表。 */

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::commands::AuthorityCursor;

/// 文档来源。migrated_default 仅由 schema 18 迁移对存量默认文档写入一次。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../src/domain/bindings/")]
#[serde(rename_all = "snake_case")]
pub enum DocumentOriginKind {
    Blank,
    Imported,
    Duplicated,
    MigratedDefault,
}

/// 列表页/宿主元数据，与 documents 表 v18 新列一一对应，不复制简历内容。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../src/domain/bindings/")]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DocumentMeta {
    pub document_id: Id,
    pub title: String,
    pub origin_kind: DocumentOriginKind,
    pub archived: bool,
    pub archived_at: Option<String>,
    pub sort_order: i64,
    pub created_at: String,
    pub updated_at: String,
}

/// document_state 的扩展响应：追加 meta/epoch，cursor/document 字段形状不变。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../src/domain/bindings/")]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ActiveDocumentState {
    pub cursor: AuthorityCursor,
    pub document: ResumeDocument,
    pub meta: DocumentMeta,
    pub epoch: u64,
    #[serde(default)]
    pub recent_exports: Vec<crate::ExportReceipt>,
    #[serde(default)]
    pub pending_import_count: u32,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../src/domain/bindings/")]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DocumentListResult {
    pub documents: Vec<DocumentMeta>,
    pub active_document_id: Option<Id>,
}

/// 切换请求：expected_epoch 防双窗口竞态；不符即 Conflict。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../src/domain/bindings/")]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SwitchActiveDocumentRequest {
    pub expected_epoch: u64,
    pub expected_current_id: Option<Id>,
    pub target_document_id: Id,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../src/domain/bindings/")]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SwitchActiveDocumentResult {
    pub document_id: Id,
    pub cursor: AuthorityCursor,
    pub document: ResumeDocument,
    pub meta: DocumentMeta,
    pub epoch: u64,
}

/// document_create：一次 IPC 完成"创建 + 切换 active"；调用前必须已 flush 当前文档。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../src/domain/bindings/")]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum CreateDocumentPayload {
    Blank {
        initial_title: String,
    },
    Duplicate {
        source_document_id: Id,
        initial_title: Option<String>,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../src/domain/bindings/")]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CreateDocumentRequest {
    pub command_id: Id,
    pub expected_current_id: Id,
    pub expected_epoch: u64,
    pub payload: CreateDocumentPayload,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../src/domain/bindings/")]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CreateDocumentReceipt {
    pub command_id: Id,
    pub document_id: Id,
}

/// Replaying creation acknowledges the original document without selecting it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../src/domain/bindings/")]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CreateDocumentResult {
    pub receipt: CreateDocumentReceipt,
    pub active_state: Option<ActiveDocumentState>,
}

/// 归档/恢复共用请求形状：expected_archived 做幂等/竞态防护。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../src/domain/bindings/")]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ArchiveDocumentRequest {
    pub command_id: Id,
    pub target_document_id: Id,
    pub expected_archived: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../src/domain/bindings/")]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RestoreDocumentRequest {
    pub command_id: Id,
    pub target_document_id: Id,
    pub expected_archived: bool,
}
