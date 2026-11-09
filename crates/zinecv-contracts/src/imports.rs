use super::*;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../src/domain/bindings/")]
#[serde(rename_all = "snake_case")]
pub enum ImportSourceKind {
    Pdf,
    Docx,
    Image,
    LegacyJson,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../src/domain/bindings/")]
#[serde(rename_all = "snake_case")]
pub enum ImportDraftStatus {
    Queued,
    Running,
    ReviewRequired,
    Committed,
    Failed,
    Cancelled,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../src/domain/bindings/")]
#[serde(rename_all = "camelCase")]
pub enum ImportBasicField {
    Name,
    Phone,
    Email,
    City,
    Wechat,
    Birth,
    Website,
    Linkedin,
    Gender,
    Height,
    Weight,
    Ethnicity,
    Birthplace,
    PoliticalStatus,
    MaritalStatus,
    Zodiac,
    Mbti,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../src/domain/bindings/")]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ImportFieldEvidence {
    pub page: Option<u32>,
    pub excerpt: String,
    pub source_field: Option<String>,
    pub confidence: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../src/domain/bindings/")]
#[serde(tag = "type", rename_all = "camelCase", deny_unknown_fields)]
pub enum ImportCandidateValue {
    BasicField {
        field: ImportBasicField,
        value: String,
    },
    SectionEntries {
        kind: ModuleKind,
        title: String,
        entries: Vec<Entry>,
    },
    SummaryBody {
        title: String,
        body: Vec<RichBlock>,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../src/domain/bindings/")]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ImportCandidate {
    pub id: Id,
    pub label: String,
    pub value: ImportCandidateValue,
    pub evidence: ImportFieldEvidence,
}

/// A user-reviewed value for one persisted candidate. The host checks the
/// original candidate identity/type and generates imported entry identities.
/// Source evidence and unselected candidates are never replaced by this input.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../src/domain/bindings/")]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ImportCandidateCorrection {
    pub candidate_id: Id,
    pub value: ImportCandidateValue,
}

/// Sanitized import state. Source file bytes and filesystem paths stay in the
/// parser; only the bounded preview resource and reviewable candidates persist.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../src/domain/bindings/")]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ImportDraft {
    pub id: Id,
    pub source_kind: ImportSourceKind,
    pub display_name: String,
    pub source_hash: Sha256,
    pub created_at: String,
    pub status: ImportDraftStatus,
    pub preview_asset_id: Option<Sha256>,
    pub candidates: Vec<ImportCandidate>,
    pub warnings: Vec<String>,
    pub unsupported_features: Vec<String>,
    /// Full extracted source text, retained separately from corrected values.
    /// Older drafts have no source-text resource and explicitly return None.
    #[serde(default)]
    pub extracted_text: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../src/domain/bindings/")]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CreateImportDraftRequest {
    pub draft_id: Id,
    pub expected_epoch: u64,
    /// M2：导入草稿持久绑定目标文档；必须等于宿主 active 文档。
    pub target_document_id: Id,
    pub source_kind: ImportSourceKind,
    pub display_name: String,
    pub source_hash: Sha256,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../src/domain/bindings/")]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TransitionImportDraftRequest {
    pub draft_id: Id,
    pub expected_status: ImportDraftStatus,
    pub next_status: ImportDraftStatus,
    pub candidates: Option<Vec<ImportCandidate>>,
    pub warnings: Option<Vec<String>>,
    pub unsupported_features: Option<Vec<String>>,
    pub preview_data_url: Option<String>,
    /// Only accepted when entering review; bounded with the candidate payload.
    #[serde(default)]
    #[ts(optional)]
    pub extracted_text: Option<String>,
}

/* ==== 原 jobs.rs ====
 * M2 岗位材料契约（设计稿 docs/m2-contract-design.md §2.3；M2 建契约与表，M4 消费）。
 * 修订保留：每次 upsert 向 job_material_revisions 插入新行，不覆盖；
 * 链接记录 job_material_revision，M4 的"材料过期提示"以修订号比较实现。
 * 不向岗位材料复制简历内容（计划 §8）。 */

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::commands::AuthorityCursor;
use crate::document::Id;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../src/domain/bindings/")]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct JobMaterial {
    pub id: Id,
    pub document_id: Id,
    pub title: String,
    pub company: String,
    pub job_description: String,
    pub source_note: String,
    pub revision: u32,
    pub created_at: String,
    pub updated_at: String,
}

/// None = 新建（id 由宿主派生，document_id 归属）；Some = 更新（id + revision 必须匹配最新，
/// 且 document_id 必须与既有材料一致）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../src/domain/bindings/")]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UpsertJobMaterialRequest {
    pub command_id: Id,
    pub document_id: Id,
    pub expected_epoch: u64,
    pub job_material: Option<JobMaterial>,
    pub title: String,
    pub company: String,
    pub job_description: String,
    pub source_note: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../src/domain/bindings/")]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DocumentJobLink {
    pub id: Id,
    pub document_id: Id,
    pub job_material_id: Id,
    pub job_material_revision: u32,
    pub branch_id: Id,
    pub created_at: String,
}

/// 绑定目标文档当前状态；宿主校验 active。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../src/domain/bindings/")]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LinkJobMaterialRequest {
    pub command_id: Id,
    pub cursor: AuthorityCursor,
    pub job_material_id: Id,
    pub job_material_revision: u32,
    pub branch_id: Id,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../src/domain/bindings/")]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DeleteJobMaterialRequest {
    pub command_id: Id,
    pub document_id: Id,
    pub expected_epoch: u64,
    pub job_material_id: Id,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../src/domain/bindings/")]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UnlinkJobMaterialRequest {
    pub command_id: Id,
    pub document_id: Id,
    pub expected_epoch: u64,
    pub link_id: Id,
}

/// `revisions` contains only historical material versions referenced by links;
/// current versions are in `materials`. Every item belongs to this document.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../src/domain/bindings/")]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct JobMaterialListResult {
    pub materials: Vec<JobMaterial>,
    pub links: Vec<DocumentJobLink>,
    pub revisions: Vec<JobMaterial>,
}
