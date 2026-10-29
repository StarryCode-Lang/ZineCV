//! M2 文档元数据与 activeDocument 契约（设计稿 docs/drafts/m2-contract-design.md §2）。
//!
//! 归档/恢复不是 DomainCommand：不进简历内容 hash、不推进 documents.revision，
//! 走独立命令 + command_receipts 幂等。active 是宿主会话状态，不写入 documents 表。

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::commands::AuthorityCursor;
use crate::document::{Id, ResumeDocument};

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
