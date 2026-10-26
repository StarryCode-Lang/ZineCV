use super::*;

// ---------------------------------------------------------------------------
// 旧版迁移契约（P1b，自 src-tauri/src/migration.rs 原样迁入）。
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../src/domain/bindings/")]
#[serde(rename_all = "snake_case")]
pub enum LegacyMigrationSourceKind {
    BrowserExport,
    VersionJson,
    VersionBackupJson,
    AccountJson,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../src/domain/bindings/")]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LegacyMigrationSourceInput {
    /// Caller-assigned stable label, never a filesystem path.
    pub source_id: String,
    pub kind: LegacyMigrationSourceKind,
    pub raw_json: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../src/domain/bindings/")]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct InspectLegacyMigrationRequest {
    /// Omit until the user confirms whether these files belong to one old library.
    pub source_namespace: Option<String>,
    pub sources: Vec<LegacyMigrationSourceInput>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../src/domain/bindings/")]
#[serde(rename_all = "snake_case")]
pub enum LegacyMigrationSeverity {
    Error,
    Review,
    Info,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../src/domain/bindings/")]
#[serde(rename_all = "camelCase")]
pub struct LegacyMigrationIssue {
    pub source_id: String,
    pub code: String,
    /// A structural path only. Source values, passwords and API keys are never returned.
    pub path: String,
    pub severity: LegacyMigrationSeverity,
    pub message: String,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../src/domain/bindings/")]
#[serde(rename_all = "camelCase")]
pub struct LegacyMigrationCounts {
    pub resume_snapshots: u32,
    pub sections: u32,
    pub entries: u32,
    pub basic_fields: u32,
    pub preference_fields: u32,
    pub module_order_records: u32,
    pub module_name_records: u32,
    pub module_visibility_records: u32,
    pub imported_templates: u32,
    pub template_assets_present: u32,
    pub template_assets_missing: u32,
    pub avatar_assets_present: u32,
    pub avatar_assets_missing: u32,
    pub extracted_text_records: u32,
    pub favorite_template_records: u32,
    pub recent_template_records: u32,
    pub active_template_records: u32,
    pub template_preview_dismissals: u32,
    pub version_branches: u32,
    pub version_commits: u32,
    pub account_records: u32,
    pub damaged_account_records: u32,
    pub provider_profiles: u32,
    pub provider_secrets_need_reentry: u32,
    pub agent_sessions: u32,
    pub session_messages: u32,
    pub live_session_tokens_not_migrated: u32,
    pub running_runs_marked_interrupted: u32,
    pub unknown_items: u32,
}

impl LegacyMigrationCounts {
    pub fn add_assign(&mut self, other: &Self) {
        self.resume_snapshots = self.resume_snapshots.saturating_add(other.resume_snapshots);
        self.sections = self.sections.saturating_add(other.sections);
        self.entries = self.entries.saturating_add(other.entries);
        self.basic_fields = self.basic_fields.saturating_add(other.basic_fields);
        self.preference_fields = self
            .preference_fields
            .saturating_add(other.preference_fields);
        self.module_order_records = self
            .module_order_records
            .saturating_add(other.module_order_records);
        self.module_name_records = self
            .module_name_records
            .saturating_add(other.module_name_records);
        self.module_visibility_records = self
            .module_visibility_records
            .saturating_add(other.module_visibility_records);
        self.imported_templates = self
            .imported_templates
            .saturating_add(other.imported_templates);
        self.template_assets_present = self
            .template_assets_present
            .saturating_add(other.template_assets_present);
        self.template_assets_missing = self
            .template_assets_missing
            .saturating_add(other.template_assets_missing);
        self.avatar_assets_present = self
            .avatar_assets_present
            .saturating_add(other.avatar_assets_present);
        self.avatar_assets_missing = self
            .avatar_assets_missing
            .saturating_add(other.avatar_assets_missing);
        self.extracted_text_records = self
            .extracted_text_records
            .saturating_add(other.extracted_text_records);
        self.favorite_template_records = self
            .favorite_template_records
            .saturating_add(other.favorite_template_records);
        self.recent_template_records = self
            .recent_template_records
            .saturating_add(other.recent_template_records);
        self.active_template_records = self
            .active_template_records
            .saturating_add(other.active_template_records);
        self.template_preview_dismissals = self
            .template_preview_dismissals
            .saturating_add(other.template_preview_dismissals);
        self.version_branches = self.version_branches.saturating_add(other.version_branches);
        self.version_commits = self.version_commits.saturating_add(other.version_commits);
        self.account_records = self.account_records.saturating_add(other.account_records);
        self.damaged_account_records = self
            .damaged_account_records
            .saturating_add(other.damaged_account_records);
        self.provider_profiles = self
            .provider_profiles
            .saturating_add(other.provider_profiles);
        self.provider_secrets_need_reentry = self
            .provider_secrets_need_reentry
            .saturating_add(other.provider_secrets_need_reentry);
        self.agent_sessions = self.agent_sessions.saturating_add(other.agent_sessions);
        self.session_messages = self.session_messages.saturating_add(other.session_messages);
        self.live_session_tokens_not_migrated = self
            .live_session_tokens_not_migrated
            .saturating_add(other.live_session_tokens_not_migrated);
        self.running_runs_marked_interrupted = self
            .running_runs_marked_interrupted
            .saturating_add(other.running_runs_marked_interrupted);
        self.unknown_items = self.unknown_items.saturating_add(other.unknown_items);
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../src/domain/bindings/")]
#[serde(rename_all = "camelCase")]
pub struct LegacyMigrationFieldEvidence {
    pub field: String,
    pub records: u32,
    pub status: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../src/domain/bindings/")]
#[serde(rename_all = "camelCase")]
pub struct LegacyMigrationSourceReport {
    pub source_id: String,
    pub kind: LegacyMigrationSourceKind,
    pub source_sha256: String,
    pub schema: String,
    pub valid: bool,
    pub counts: LegacyMigrationCounts,
    pub field_evidence: Vec<LegacyMigrationFieldEvidence>,
    pub issues: Vec<LegacyMigrationIssue>,
    /// A versions-only file never implies a current draft.
    pub current_draft_present: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../src/domain/bindings/")]
#[serde(rename_all = "snake_case")]
pub enum LegacyMigrationConflictKind {
    SameIdDifferentContent,
    SameNameDifferentId,
    SameContentDifferentCommit,
    BrowserVersionConflict,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../src/domain/bindings/")]
#[serde(rename_all = "camelCase")]
pub struct LegacyMigrationConflict {
    pub kind: LegacyMigrationConflictKind,
    pub entity_kind: String,
    /// A legacy identifier or a short digest for a content-derived conflict.
    pub entity_id: String,
    pub source_ids: Vec<String>,
    pub severity: LegacyMigrationSeverity,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../src/domain/bindings/")]
#[serde(rename_all = "camelCase")]
pub struct LegacyMigrationReport {
    pub importer_version: String,
    pub source_namespace: Option<String>,
    pub namespace_decision_required: bool,
    pub status: String,
    pub ready_for_dry_run: bool,
    pub no_target_writes: bool,
    pub sources: Vec<LegacyMigrationSourceReport>,
    pub totals: LegacyMigrationCounts,
    pub conflicts: Vec<LegacyMigrationConflict>,
    pub issues: Vec<LegacyMigrationIssue>,
    pub unique_entity_identity_count: u32,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../src/domain/bindings/")]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LegacyMigrationExpectedHash {
    pub source_id: String,
    pub source_sha256: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../src/domain/bindings/")]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DryRunLegacyMigrationRequest {
    pub inspection: InspectLegacyMigrationRequest,
    pub expected_source_hashes: Vec<LegacyMigrationExpectedHash>,
    pub converted_documents: Vec<LegacyMigrationConvertedDocument>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../src/domain/bindings/")]
#[serde(rename_all = "snake_case")]
pub enum LegacyMigrationDocumentKind {
    CurrentDraft,
    VersionCommit,
    ImportedTemplate,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../src/domain/bindings/")]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LegacyMigrationConvertedDocument {
    pub source_id: String,
    pub source_sha256: String,
    pub document_kind: LegacyMigrationDocumentKind,
    pub legacy_id: String,
    pub document: ResumeDocument,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../src/domain/bindings/")]
#[serde(rename_all = "camelCase")]
pub struct LegacyMigrationDryRun {
    pub importer_version: String,
    pub batch_key: Option<String>,
    pub source_hashes_match: bool,
    pub target_database_unchanged: bool,
    pub staging_database_created: bool,
    pub conversion_complete: bool,
    pub conversion_issues: Vec<LegacyMigrationIssue>,
    pub status: String,
    pub inspection: LegacyMigrationReport,
    pub staged_identity_count: u32,
    pub staged_document_count: u32,
    pub identity_mapping_namespace: Option<String>,
    pub live_session_tokens_excluded: u32,
    pub unsupported_items_preserved_for_review: u32,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../src/domain/bindings/")]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LegacyMigrationVersionBranch {
    pub id: String,
    pub name: String,
    pub head_commit_id: Option<String>,
    pub created_at: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../src/domain/bindings/")]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LegacyMigrationVersionCommit {
    pub id: String,
    pub branch_id: String,
    pub parent_id: Option<String>,
    pub message: String,
    pub created_at: String,
    pub snapshot: ResumeDocument,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../src/domain/bindings/")]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LegacyMigrationVersionGraph {
    pub source_id: String,
    pub current_branch_id: String,
    pub branches: Vec<LegacyMigrationVersionBranch>,
    pub commits: Vec<LegacyMigrationVersionCommit>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../src/domain/bindings/")]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LegacyMigrationPreference {
    pub key: String,
    pub value: String,
}

/// 模板目录迁移：转换方（TS）把现有目录与旧版模板按稳定 ID 合并后，
/// 提交合并后的完整目录 JSON 与 CAS 基准 revision；资源提取在事务内复用
/// `normalize_catalog_for_storage`。缺失时该类别继续保留在 receipt 的
/// remaining_categories 中。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../src/domain/bindings/")]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LegacyMigrationTemplates {
    /// 目录 CAS 基准 revision，十进制字符串，与 AuthorityCursor 的 Revision 约定一致，
    /// 避免 TS bigint 跨 IPC 序列化问题。
    pub expected_revision: String,
    pub catalog_json: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../src/domain/bindings/")]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CommitLegacyMigrationRequest {
    pub command_id: String,
    pub cursor: AuthorityCursor,
    pub inspection: InspectLegacyMigrationRequest,
    pub expected_source_hashes: Vec<LegacyMigrationExpectedHash>,
    pub confirmed: bool,
    pub acknowledged_review_items: Vec<String>,
    pub accepted_identity_updates: Vec<String>,
    pub current_draft: Option<ResumeDocument>,
    pub version_graph: Option<LegacyMigrationVersionGraph>,
    #[serde(default)]
    pub preferences: Vec<LegacyMigrationPreference>,
    #[serde(default)]
    pub templates: Option<LegacyMigrationTemplates>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../src/domain/bindings/")]
#[serde(rename_all = "camelCase")]
pub struct LegacyMigrationCommitReceipt {
    pub batch_key: String,
    pub namespace: String,
    pub cursor: AuthorityCursor,
    pub current_draft_applied: bool,
    pub version_branch_count: u32,
    pub version_commit_count: u32,
    pub identity_mapping_count: u32,
    #[serde(default)]
    pub preference_count: u32,
    #[serde(default)]
    pub template_count: u32,
    #[serde(default)]
    pub account_count: u32,
    #[serde(default)]
    pub provider_count: u32,
    #[serde(default)]
    pub session_count: u32,
    #[serde(default)]
    pub secret_reentry_count: u32,
    pub completion_status: String,
    pub remaining_categories: Vec<String>,
    pub idempotent_replay: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../src/domain/bindings/")]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct InspectLegacyIdentityConflictsRequest {
    pub target_document_id: String,
    pub source_namespace: String,
    pub version_graph: LegacyMigrationVersionGraph,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../src/domain/bindings/")]
#[serde(rename_all = "camelCase")]
pub struct LegacyMigrationIdentityConflict {
    pub conflict_key: String,
    pub entity_kind: String,
    pub legacy_id: String,
    pub existing_variant_count: u32,
}
