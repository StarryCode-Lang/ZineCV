use super::*;

// ---------------------------------------------------------------------------
// 版本图 DTO（P1b，自 src-tauri/src/storage.rs 原样迁入；仅 Serialize+TS，
// 与迁入前一致）。
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[ts(export, export_to = "../src/domain/bindings/")]
#[serde(rename_all = "camelCase")]
pub struct VersionBranch {
    pub id: String,
    pub name: String,
    pub head_commit_id: Option<String>,
    pub is_current: bool,
    pub created_at: String,
}

/// 供版本 UI 一次性取回整张图：提交按 graph 排序，附带快照 document JSON。
#[derive(Debug, Clone, PartialEq, Serialize, TS)]
#[ts(export, export_to = "../src/domain/bindings/")]
#[serde(rename_all = "camelCase")]
pub struct VersionCommitDetailed {
    #[serde(flatten)]
    pub commit: VersionCommit,
    pub snapshot_document_json: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, TS)]
#[ts(export, export_to = "../src/domain/bindings/")]
#[serde(rename_all = "camelCase")]
pub struct VersionGraphDetailed {
    pub cursor: AuthorityCursor,
    pub branches: Vec<VersionBranch>,
    pub commits: Vec<VersionCommitDetailed>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[ts(export, export_to = "../src/domain/bindings/")]
#[serde(rename_all = "camelCase")]
pub struct VersionCommit {
    pub id: String,
    pub origin_branch_id: String,
    pub origin_deleted: bool,
    pub snapshot_id: String,
    pub parent_id: Option<String>,
    pub message: String,
    pub created_at: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, TS)]
#[ts(export, export_to = "../src/domain/bindings/")]
#[serde(rename_all = "camelCase")]
pub struct VersionGraph {
    pub cursor: AuthorityCursor,
    pub branches: Vec<VersionBranch>,
    pub commits: Vec<VersionCommit>,
}
