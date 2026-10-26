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
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../src/domain/bindings/")]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CreateImportDraftRequest {
    pub draft_id: Id,
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
}
