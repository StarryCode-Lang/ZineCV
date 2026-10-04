use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256 as Sha256Hasher};
use ts_rs::TS;

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

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../src/domain/bindings/")]
#[serde(tag = "type", rename_all = "camelCase", deny_unknown_fields)]
pub enum DomainCommand {
    SetDocumentTitle {
        title: String,
    },
    RenameSection {
        section_id: Id,
        title: String,
    },
    SetSectionVisibility {
        section_id: Id,
        visible: bool,
    },
    MoveSection {
        section_id: Id,
        index: usize,
    },
    SetEntryBody {
        entry_id: Id,
        body: Vec<RichBlock>,
    },
    SetSummaryBody {
        section_id: Id,
        body: Vec<RichBlock>,
    },
    UpdateEntryFields {
        entry_id: Id,
        title: Option<String>,
        role: Option<String>,
        department: Option<String>,
        city: Option<String>,
        start: Option<String>,
        end: Option<String>,
        college: Option<String>,
        mode: Option<String>,
    },
    AddEntry {
        section_id: Id,
        entry: Entry,
    },
    DeleteEntry {
        entry_id: Id,
    },
    MoveEntry {
        entry_id: Id,
        section_id: Id,
        index: usize,
    },
    UpdateBasic {
        patch: BasicPatch,
    },
    /// Restricted to reversible host operations so undo can restore only the
    /// fields touched by a proposal without replacing later manual edits.
    RestoreBasicFields {
        fields: Vec<BasicField>,
        values: BasicInfo,
    },
    SetLayout {
        presentation: Presentation,
    },
    /// 封存的迁移/来源元数据（不渲染、不参与排版），随版本快照保真。
    SetLegacyExtensions {
        #[ts(type = "Record<string, unknown>")]
        extensions: BTreeMap<String, serde_json::Value>,
    },
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../src/domain/bindings/")]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BasicPatch {
    pub name: Option<String>,
    pub phone: Option<String>,
    pub email: Option<String>,
    pub city: Option<String>,
    pub wechat: Option<String>,
    pub birth: Option<String>,
    pub age_mode: Option<AgeMode>,
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

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../src/domain/bindings/")]
#[serde(rename_all = "camelCase")]
pub enum BasicField {
    Name,
    Phone,
    Email,
    City,
    Wechat,
    Birth,
    AgeMode,
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
    AvatarAssetId,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../src/domain/bindings/")]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CommandEnvelope {
    #[ts(type = "1")]
    pub protocol_version: u8,
    pub command_id: Id,
    pub document_id: Id,
    pub context_id: Id,
    pub expected_revision: Revision,
    pub expected_branch_id: Id,
    pub expected_head_id: Option<Id>,
    pub payload: DomainCommand,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../src/domain/bindings/")]
#[serde(rename_all = "camelCase")]
pub struct AuthorityCursor {
    pub document_id: Id,
    pub context_id: Id,
    pub revision: Revision,
    pub branch_id: Id,
    pub head_id: Option<Id>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../src/domain/bindings/")]
#[serde(rename_all = "camelCase")]
pub struct CommandResult {
    pub command_id: Id,
    pub cursor: AuthorityCursor,
    pub durable: bool,
    pub snapshot_hash: Sha256,
    pub document: ResumeDocument,
    pub changed_ids: Vec<Id>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../src/domain/bindings/")]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ErrorCode {
    Validation,
    Conflict,
    NotFound,
    Permission,
    StorageFull,
    StorageCorrupt,
    UnsupportedSchema,
    ResourceLimit,
    Cancelled,
    EngineFailure,
    MigrationPartial,
    ProviderFailure,
    IpcFailure,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../src/domain/bindings/")]
#[serde(rename_all = "camelCase")]
pub struct AppError {
    pub code: ErrorCode,
    pub message: String,
    pub retryable: bool,
    pub diagnostic_id: Id,
}

impl AppError {
    pub fn new(code: ErrorCode, message: impl Into<String>, retryable: bool) -> Self {
        static DIAGNOSTIC_COUNTER: std::sync::atomic::AtomicU64 =
            std::sync::atomic::AtomicU64::new(0);
        let sequence = DIAGNOSTIC_COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let mut random = [0u8; 16];
        if getrandom::fill(&mut random).is_err() {
            let seed = format!(
                "{}:{}:{}",
                std::process::id(),
                sequence,
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map_or(0, |duration| duration.as_nanos())
            );
            random.copy_from_slice(&sha2::Sha256::digest(seed.as_bytes())[..16]);
        }
        let diagnostic_id = random
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
        Self {
            code,
            message: message.into(),
            retryable,
            diagnostic_id: format!("diag-{diagnostic_id}"),
        }
    }

    pub fn with_context(mut self, context: &str) -> Self {
        self.message = format!("{context}: {}", self.message);
        self
    }
}

impl From<String> for AppError {
    fn from(message: String) -> Self {
        Self::new(ErrorCode::IpcFailure, message, false)
    }
}

impl From<&str> for AppError {
    fn from(message: &str) -> Self {
        Self::new(ErrorCode::IpcFailure, message, false)
    }
}

/// A Tauri invoke endpoint currently registered by the host. This enum is the
/// Rust-owned command-name allowlist used by the typed React bridge.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../src/domain/bindings/")]
#[serde(rename_all = "snake_case")]
pub enum NativeIpcCommandName {
    DocumentState,
    VersionGraphDetailed,
    VersionCommitDetail,
    ApplyDocumentCommand,
    CommitVersion,
    CreateVersionBranch,
    SwitchVersionBranch,
    LoadHistoryCommit,
    DeleteVersionCommit,
    DeleteVersionBranch,
    ReplaceVersionStore,
    ExportDatabaseBackup,
    RestoreDatabaseBackup,
    StoreAvatarAsset,
    ReadAvatarAsset,
    ExportDocumentPdf,
    RenderDocumentPreview,
    RenderDocumentExport,
    FitDocumentOnePage,
    ReadSetting,
    WriteSetting,
    ReadImportedTemplateCatalog,
    WriteImportedTemplateCatalog,
    BootstrapTemplateActivity,
    UpdateTemplateActivity,
    BootstrapAgentSessions,
    ReplaceAgentSessions,
    AgentSelectedContext,
    RegisterAccount,
    LoginAccount,
    LogoutAccount,
    CurrentAccount,
    StoreProviderKey,
    ProviderProfile,
    ClearProvider,
    ProviderModels,
    ProviderTest,
    AgentChat,
    ListAgentRuns,
    CancelAgentRun,
    SwitchEditingContext,
    InspectLegacyMigration,
    DryRunLegacyMigration,
    CommitLegacyMigration,
    InspectLegacyIdentityConflicts,
    CreateImportDraft,
    GetImportDraft,
    TransitionImportDraft,
    ApplyImport,
    ListAgentProposals,
    ConfirmProposal,
    RejectProposal,
    UndoConfirmedProposal,
    PickExportPath,
    PickExportDirectory,
    WriteExportFile,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../src/domain/bindings/")]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DatabaseBackupPayload {
    pub format: String,
    pub format_version: u32,
    pub created_at: String,
    pub schema_version: u32,
    pub database_sha256: String,
    pub database_base64: String,
    pub unavailable_secret_count: u32,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../src/domain/bindings/")]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DatabaseRestoreResult {
    pub schema_version: u32,
    pub unavailable_secret_count: u32,
    pub requires_relogin: bool,
    pub pre_restore_backup_path: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../src/domain/bindings/")]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EditorContext {
    pub cursor: AuthorityCursor,
    pub session_epoch: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../src/domain/bindings/")]
#[serde(rename_all = "snake_case")]
pub enum EditingContextSourceKind {
    Workspace,
    ImportedTemplate,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../src/domain/bindings/")]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SwitchEditingContextRequest {
    pub expected_cursor: AuthorityCursor,
    pub source_kind: EditingContextSourceKind,
    pub source_id: String,
    pub initial_document: Option<ResumeDocument>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../src/domain/bindings/")]
#[serde(rename_all = "camelCase")]
pub struct SwitchEditingContextResult {
    pub cursor: AuthorityCursor,
    pub document: ResumeDocument,
    pub created: bool,
}

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

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../src/domain/bindings/")]
#[serde(tag = "type", rename_all = "camelCase", deny_unknown_fields)]
pub enum ProposalChange {
    SetDocumentTitle {
        title: String,
    },
    RenameSection {
        section_id: Id,
        title: String,
    },
    SetSectionVisibility {
        section_id: Id,
        visible: bool,
    },
    MoveSection {
        section_id: Id,
        index: usize,
    },
    SetEntryBody {
        entry_id: Id,
        body: Vec<RichBlock>,
    },
    SetSummaryBody {
        section_id: Id,
        body: Vec<RichBlock>,
    },
    UpdateEntryFields {
        entry_id: Id,
        title: Option<String>,
        role: Option<String>,
        department: Option<String>,
        city: Option<String>,
        start: Option<String>,
        end: Option<String>,
        college: Option<String>,
        mode: Option<String>,
    },
    AddEntry {
        section_id: Id,
        entry: Entry,
    },
    DeleteEntry {
        entry_id: Id,
    },
    MoveEntry {
        entry_id: Id,
        section_id: Id,
        index: usize,
    },
    UpdateBasic {
        patch: BasicPatch,
    },
    /// 切换内置版式：只替换 presentation.templateId，其余演示参数保持不变。
    ApplyTemplate {
        template_id: Id,
    },
    /// 版本副作用：确认通过后在同一事务内按当前正文提交一个版本。
    /// 提议值仅绑定 message，撤回不产生逆操作（历史提交不可静默回退）。
    CommitVersion {
        message: String,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../src/domain/bindings/")]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProposalItem {
    pub id: Id,
    pub summary: String,
    pub change: ProposalChange,
}

/// The owning account is attached by the host when loading this object. None
/// of the write requests below accepts an account ID from the webview.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../src/domain/bindings/")]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Proposal {
    pub id: Id,
    pub account_id: Id,
    pub cursor: AuthorityCursor,
    pub created_at: String,
    pub items: Vec<ProposalItem>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../src/domain/bindings/")]
#[serde(rename_all = "snake_case")]
pub enum AgentProposalStatus {
    Pending,
    Confirmed,
    Rejected,
    Undone,
    Expired,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../src/domain/bindings/")]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentProposalItem {
    pub id: Id,
    pub summary: String,
    pub reference_id: Id,
    pub change: ProposalChange,
    #[ts(type = "unknown")]
    pub before_value: serde_json::Value,
    #[ts(type = "unknown")]
    pub after_value: serde_json::Value,
}

/// Host-owned, durable review record. Account ownership and target scope are
/// attached by Rust; renderer inputs can only name a proposal and item IDs.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../src/domain/bindings/")]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentProposalRecord {
    pub id: Id,
    pub run_id: Id,
    pub account_id: Id,
    pub session_id: Id,
    pub document_id: Id,
    pub cursor: AuthorityCursor,
    pub scope_hash: Sha256,
    pub explanation: String,
    pub created_at: String,
    pub expires_at: String,
    pub status: AgentProposalStatus,
    pub items: Vec<AgentProposalItem>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../src/domain/bindings/")]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentProposalUndoRecord {
    pub receipt_id: Id,
    pub proposal_id: Id,
    pub session_id: Id,
    pub cursor: AuthorityCursor,
    pub accepted_item_ids: Vec<Id>,
    pub created_at: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../src/domain/bindings/")]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentProposalInbox {
    pub pending: Vec<AgentProposalRecord>,
    pub undoable: Vec<AgentProposalUndoRecord>,
}

/// In-memory host input produced from a structured model tool call. Ownership,
/// cursor, scope hash, before/after values, timestamps and status are all
/// derived by the storage authority before this is persisted.
#[derive(Debug, Clone, PartialEq)]
pub struct AgentProposalDraft {
    pub id: Id,
    pub explanation: String,
    pub items: Vec<AgentProposalDraftItem>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct AgentProposalDraftItem {
    pub id: Id,
    pub summary: String,
    pub reference_id: Id,
    pub change: ProposalChange,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../src/domain/bindings/")]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentProposalReceipt {
    pub id: Id,
    pub command_id: Id,
    pub proposal_id: Id,
    pub cursor: AuthorityCursor,
    pub status: AgentProposalStatus,
    pub accepted_item_ids: Vec<Id>,
    pub created_at: String,
    pub idempotent_replay: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../src/domain/bindings/")]
#[serde(rename_all = "kebab-case")]
pub enum BuiltinTemplateId {
    LegacyV1,
    ClearSingleV1,
    CompactSingleV1,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../src/domain/bindings/")]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ApplyTemplateRequest {
    pub command_id: Id,
    pub cursor: AuthorityCursor,
    pub template_id: BuiltinTemplateId,
    pub template_revision: Id,
    pub density: Option<Density>,
    pub font_set_id: Option<Id>,
    pub theme: Option<String>,
    pub date_format: Option<DateFormat>,
    pub title_format: Option<TitleFormat>,
    pub separator: Option<Separator>,
    pub text_align: Option<TextAlign>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../src/domain/bindings/")]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ApplyImportRequest {
    pub command_id: Id,
    pub cursor: AuthorityCursor,
    pub draft_id: Id,
    pub accepted_candidate_ids: Vec<Id>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../src/domain/bindings/")]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ConfirmProposalRequest {
    pub command_id: Id,
    pub cursor: AuthorityCursor,
    pub proposal_id: Id,
    pub accepted_item_ids: Vec<Id>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../src/domain/bindings/")]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UndoConfirmedProposalRequest {
    pub command_id: Id,
    pub cursor: AuthorityCursor,
    pub receipt_id: Id,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../src/domain/bindings/")]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RejectAgentProposalRequest {
    pub command_id: Id,
    pub proposal_id: Id,
}

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

#[derive(Debug, Clone)]
pub struct DocumentContext {
    document: ResumeDocument,
    revision: u64,
    branch_id: Id,
    head_id: Option<Id>,
    processed: BTreeMap<Id, (Sha256, CommandResult, String)>,
}

impl DocumentContext {
    pub fn new(document: ResumeDocument) -> Result<Self, AppError> {
        validate_document(&document)?;
        Ok(Self {
            revision: document_revision(&document)?,
            document,
            branch_id: "main".into(),
            head_id: None,
            processed: BTreeMap::new(),
        })
    }

    pub fn with_authority(
        document: ResumeDocument,
        revision: u64,
        branch_id: Id,
        head_id: Option<Id>,
    ) -> Result<Self, AppError> {
        validate_document(&document)?;
        document_revision(&document)?;
        Ok(Self {
            document,
            revision,
            branch_id,
            head_id,
            processed: BTreeMap::new(),
        })
    }

    pub fn document(&self) -> &ResumeDocument {
        &self.document
    }

    pub fn cursor(&self, context_id: &str) -> AuthorityCursor {
        AuthorityCursor {
            document_id: self.document.document_id.clone(),
            context_id: context_id.into(),
            revision: self.revision.to_string(),
            branch_id: self.branch_id.clone(),
            head_id: self.head_id.clone(),
        }
    }

    pub fn apply_command(
        &mut self,
        actor: &str,
        context_id: &str,
        envelope: CommandEnvelope,
    ) -> Result<CommandResult, AppError> {
        let mut staged = self.clone();
        let result = staged.apply_command_inner(actor, context_id, envelope)?;
        *self = staged;
        Ok(result)
    }

    fn apply_command_inner(
        &mut self,
        actor: &str,
        context_id: &str,
        envelope: CommandEnvelope,
    ) -> Result<CommandResult, AppError> {
        if actor.trim().is_empty() || context_id.trim().is_empty() {
            return Err(permission_error("Trusted actor and context are required"));
        }
        if envelope.protocol_version != 1 {
            return Err(validation_error("Unsupported command protocol"));
        }
        let request_hash = canonical_hash(&envelope)?;
        if let Some((stored_hash, receipt, stored_actor)) = self.processed.get(&envelope.command_id)
        {
            if *stored_hash == request_hash && stored_actor == actor {
                return Ok(receipt.clone());
            }
            return Err(conflict_error(
                "Command ID was reused with a different request",
            ));
        }

        if envelope.document_id != self.document.document_id
            || envelope.expected_branch_id != self.branch_id
            || envelope.expected_head_id != self.head_id
            || envelope.expected_revision != self.revision.to_string()
        {
            return Err(conflict_error("Stale authority cursor"));
        }

        let mut changed_ids = Vec::new();
        match envelope.payload.clone() {
            DomainCommand::SetDocumentTitle { title } => {
                if title.trim().is_empty() {
                    return Err(validation_error("Document title cannot be empty"));
                }
                self.document.title = title;
                changed_ids.push(self.document.document_id.clone());
            }
            DomainCommand::RenameSection { section_id, title } => {
                let section = section_mut(&mut self.document, &section_id)?;
                section_title_mut(section).clone_from(&title);
                changed_ids.push(section_id);
            }
            DomainCommand::SetSectionVisibility {
                section_id,
                visible,
            } => {
                let section = section_mut(&mut self.document, &section_id)?;
                section_visible_mut(section).clone_from(&visible);
                changed_ids.push(section_id);
            }
            DomainCommand::MoveSection { section_id, index } => {
                let from = self
                    .document
                    .sections
                    .iter()
                    .position(|section| section_id_of(section) == &section_id)
                    .ok_or_else(|| not_found_error("Section not found"))?;
                if index >= self.document.sections.len() {
                    return Err(validation_error("Section index out of range"));
                }
                let section = self.document.sections.remove(from);
                self.document.sections.insert(index, section);
                changed_ids.push(section_id);
            }
            DomainCommand::SetEntryBody { entry_id, body } => {
                let entry = entry_mut(&mut self.document, &entry_id)?;
                entry.body = body;
                changed_ids.push(entry_id);
            }
            DomainCommand::SetSummaryBody { section_id, body } => {
                let section = section_mut(&mut self.document, &section_id)?;
                let Section::Summary(summary) = section else {
                    return Err(validation_error(
                        "Only summary sections have a summary body",
                    ));
                };
                summary.body = body;
                changed_ids.push(section_id);
            }
            DomainCommand::UpdateEntryFields {
                entry_id,
                title,
                role,
                department,
                city,
                start,
                end,
                college,
                mode,
            } => {
                let entry = entry_mut(&mut self.document, &entry_id)?;
                if let Some(value) = title {
                    entry.title = value;
                }
                if let Some(value) = role {
                    entry.role = value;
                }
                if let Some(value) = department {
                    entry.department = value;
                }
                if let Some(value) = city {
                    entry.city = value;
                }
                if let Some(value) = start {
                    entry.start = value;
                }
                if let Some(value) = end {
                    entry.end = value;
                }
                if let Some(value) = college {
                    entry.college = if value.is_empty() { None } else { Some(value) };
                }
                if let Some(value) = mode {
                    entry.mode = if value.is_empty() { None } else { Some(value) };
                }
                changed_ids.push(entry_id);
            }
            DomainCommand::AddEntry { section_id, entry } => {
                let section = section_mut(&mut self.document, &section_id)?;
                let entries = section_entries_mut(section)
                    .ok_or_else(|| validation_error("Summary section cannot contain entries"))?;
                entries.push(entry.clone());
                changed_ids.push(entry.id);
            }
            DomainCommand::DeleteEntry { entry_id } => {
                let mut removed = false;
                for section in &mut self.document.sections {
                    if let Some(entries) = section_entries_mut(section) {
                        let before = entries.len();
                        entries.retain(|entry| entry.id != entry_id);
                        removed |= entries.len() != before;
                    }
                }
                if !removed {
                    return Err(not_found_error("Entry not found"));
                }
                changed_ids.push(entry_id);
            }
            DomainCommand::MoveEntry {
                entry_id,
                section_id,
                index,
            } => {
                let mut entry = None;
                for section in &mut self.document.sections {
                    if let Some(entries) = section_entries_mut(section) {
                        if let Some(position) = entries
                            .iter()
                            .position(|candidate| candidate.id == entry_id)
                        {
                            entry = Some(entries.remove(position));
                            break;
                        }
                    }
                }
                let mut entry = entry.ok_or_else(|| not_found_error("Entry not found"))?;
                let section = section_mut(&mut self.document, &section_id)?;
                let entries = section_entries_mut(section)
                    .ok_or_else(|| validation_error("Summary section cannot contain entries"))?;
                if index > entries.len() {
                    return Err(validation_error("Entry index out of range"));
                }
                entry.id = entry_id.clone();
                entries.insert(index, entry);
                changed_ids.push(entry_id);
            }
            DomainCommand::UpdateBasic { patch } => {
                if let Some(value) = patch.name {
                    self.document.basic.name = value;
                }
                if let Some(value) = patch.phone {
                    self.document.basic.phone = value;
                }
                if let Some(value) = patch.email {
                    self.document.basic.email = value;
                }
                if let Some(value) = patch.city {
                    self.document.basic.city = value;
                }
                if let Some(value) = patch.wechat {
                    self.document.basic.wechat = value;
                }
                if let Some(value) = patch.birth {
                    self.document.basic.birth = value;
                }
                if let Some(value) = patch.age_mode {
                    self.document.basic.age_mode = value;
                }
                if let Some(value) = patch.website {
                    self.document.basic.website = Some(value);
                }
                if let Some(value) = patch.linkedin {
                    self.document.basic.linkedin = Some(value);
                }
                if let Some(value) = patch.gender {
                    self.document.basic.gender = Some(value);
                }
                if let Some(value) = patch.height {
                    self.document.basic.height = Some(value);
                }
                if let Some(value) = patch.weight {
                    self.document.basic.weight = Some(value);
                }
                if let Some(value) = patch.ethnicity {
                    self.document.basic.ethnicity = Some(value);
                }
                if let Some(value) = patch.birthplace {
                    self.document.basic.birthplace = Some(value);
                }
                if let Some(value) = patch.political_status {
                    self.document.basic.political_status = Some(value);
                }
                if let Some(value) = patch.marital_status {
                    self.document.basic.marital_status = Some(value);
                }
                if let Some(value) = patch.zodiac {
                    self.document.basic.zodiac = Some(value);
                }
                if let Some(value) = patch.mbti {
                    self.document.basic.mbti = Some(value);
                }
                if let Some(value) = patch.avatar_asset_id {
                    // 空字符串是前端约定的“清除头像”哨兵；其余值按资产 hash 设置。
                    self.document.basic.avatar_asset_id =
                        if value.is_empty() { None } else { Some(value) };
                }
                changed_ids.push(self.document.basic.name.clone());
            }
            DomainCommand::RestoreBasicFields { fields, values } => {
                if fields.is_empty() {
                    return Err(validation_error("Basic field restore needs a target"));
                }
                for field in fields.iter().copied() {
                    match field {
                        BasicField::Name => self.document.basic.name.clone_from(&values.name),
                        BasicField::Phone => self.document.basic.phone.clone_from(&values.phone),
                        BasicField::Email => self.document.basic.email.clone_from(&values.email),
                        BasicField::City => self.document.basic.city.clone_from(&values.city),
                        BasicField::Wechat => self.document.basic.wechat.clone_from(&values.wechat),
                        BasicField::Birth => self.document.basic.birth.clone_from(&values.birth),
                        BasicField::AgeMode => self.document.basic.age_mode = values.age_mode,
                        BasicField::Website => {
                            self.document.basic.website.clone_from(&values.website)
                        }
                        BasicField::Linkedin => {
                            self.document.basic.linkedin.clone_from(&values.linkedin)
                        }
                        BasicField::Gender => self.document.basic.gender.clone_from(&values.gender),
                        BasicField::Height => self.document.basic.height.clone_from(&values.height),
                        BasicField::Weight => self.document.basic.weight.clone_from(&values.weight),
                        BasicField::Ethnicity => {
                            self.document.basic.ethnicity.clone_from(&values.ethnicity)
                        }
                        BasicField::Birthplace => self
                            .document
                            .basic
                            .birthplace
                            .clone_from(&values.birthplace),
                        BasicField::PoliticalStatus => self
                            .document
                            .basic
                            .political_status
                            .clone_from(&values.political_status),
                        BasicField::MaritalStatus => self
                            .document
                            .basic
                            .marital_status
                            .clone_from(&values.marital_status),
                        BasicField::Zodiac => self.document.basic.zodiac.clone_from(&values.zodiac),
                        BasicField::Mbti => self.document.basic.mbti.clone_from(&values.mbti),
                        BasicField::AvatarAssetId => self
                            .document
                            .basic
                            .avatar_asset_id
                            .clone_from(&values.avatar_asset_id),
                    }
                }
                changed_ids.extend(fields.iter().map(|field| format!("basic:{field:?}")));
            }
            DomainCommand::SetLayout { presentation } => {
                self.document.presentation = presentation;
                changed_ids.push(self.document.document_id.clone());
            }
            DomainCommand::SetLegacyExtensions { extensions } => {
                self.document.legacy_extensions = extensions;
                changed_ids.push(self.document.document_id.clone());
            }
        }

        validate_document(&self.document)?;
        self.revision += 1;
        let result = CommandResult {
            command_id: envelope.command_id.clone(),
            cursor: self.cursor(context_id),
            durable: true,
            snapshot_hash: canonical_hash(&self.document)?,
            document: self.document.clone(),
            changed_ids,
        };
        self.processed.insert(
            envelope.command_id,
            (request_hash, result.clone(), actor.to_string()),
        );
        Ok(result)
    }
}

fn document_revision(document: &ResumeDocument) -> Result<u64, AppError> {
    if document.schema_version != 2 {
        return Err(unsupported_error(
            "Only ResumeDocument schema version 2 is accepted",
        ));
    }
    Ok(0)
}

fn section_id_of(section: &Section) -> &Id {
    match section {
        Section::Entry(section) => &section.id,
        Section::Summary(section) => &section.id,
    }
}

fn section_title_mut(section: &mut Section) -> &mut String {
    match section {
        Section::Entry(section) => &mut section.title,
        Section::Summary(section) => &mut section.title,
    }
}

fn section_visible_mut(section: &mut Section) -> &mut bool {
    match section {
        Section::Entry(section) => &mut section.visible,
        Section::Summary(section) => &mut section.visible,
    }
}

fn section_entries_mut(section: &mut Section) -> Option<&mut Vec<Entry>> {
    match section {
        Section::Entry(section) => Some(&mut section.entries),
        Section::Summary(_) => None,
    }
}

fn section_mut<'a>(
    document: &'a mut ResumeDocument,
    id: &str,
) -> Result<&'a mut Section, AppError> {
    document
        .sections
        .iter_mut()
        .find(|section| section_id_of(section) == id)
        .ok_or_else(|| not_found_error("Section not found"))
}

fn entry_mut<'a>(document: &'a mut ResumeDocument, id: &str) -> Result<&'a mut Entry, AppError> {
    for section in &mut document.sections {
        if let Section::Entry(entry_section) = section {
            if let Some(entry) = entry_section
                .entries
                .iter_mut()
                .find(|entry| entry.id == id)
            {
                return Ok(entry);
            }
        }
    }
    Err(not_found_error("Entry not found"))
}

fn validate_document(document: &ResumeDocument) -> Result<(), AppError> {
    if document.document_id.trim().is_empty() || document.title.trim().is_empty() {
        return Err(validation_error("Document ID and title are required"));
    }
    let mut section_ids = BTreeSet::new();
    let mut entry_ids = BTreeSet::new();
    for section in &document.sections {
        let id = section_id_of(section);
        if id.trim().is_empty() || !section_ids.insert(id.clone()) {
            return Err(validation_error("Section IDs must be present and unique"));
        }
        if let Section::Entry(entry_section) = section {
            for entry in &entry_section.entries {
                if entry.id.trim().is_empty() || !entry_ids.insert(entry.id.clone()) {
                    return Err(validation_error("Entry IDs must be present and unique"));
                }
                for block in &entry.body {
                    validate_block(block, 0)?;
                }
            }
        }
        if let Section::Summary(summary) = section {
            for block in &summary.body {
                validate_block(block, 0)?;
            }
        }
    }
    Ok(())
}

fn validate_block(block: &RichBlock, depth: usize) -> Result<(), AppError> {
    if depth > 8 {
        return Err(resource_limit_error(
            "Rich text nesting exceeds the safety limit",
        ));
    }
    match block {
        RichBlock::Paragraph { children } => {
            for inline in children {
                validate_inline(inline)?;
            }
        }
        RichBlock::List { items, .. } => {
            for item in items {
                for child in item {
                    validate_block(child, depth + 1)?;
                }
            }
        }
    }
    Ok(())
}

fn validate_inline(inline: &Inline) -> Result<(), AppError> {
    if let Inline::Link { href, children } = inline {
        let allowed = href.starts_with("https://")
            || href.starts_with("http://")
            || href.starts_with("mailto:");
        if !allowed {
            return Err(validation_error("Link protocol is not allowed"));
        }
        for child in children {
            validate_inline(child)?;
        }
    }
    Ok(())
}

pub fn canonical_hash<T: Serialize>(value: &T) -> Result<Sha256, AppError> {
    let bytes =
        serde_json::to_vec(value).map_err(|_| validation_error("Value cannot be canonicalized"))?;
    Ok(format!("{:x}", Sha256Hasher::digest(bytes)))
}

fn app_error(code: ErrorCode, message: &str, retryable: bool) -> AppError {
    AppError::new(code, message, retryable)
}
fn validation_error(message: &str) -> AppError {
    app_error(ErrorCode::Validation, message, false)
}
fn conflict_error(message: &str) -> AppError {
    app_error(ErrorCode::Conflict, message, false)
}
fn not_found_error(message: &str) -> AppError {
    app_error(ErrorCode::NotFound, message, false)
}
fn permission_error(message: &str) -> AppError {
    app_error(ErrorCode::Permission, message, false)
}
fn unsupported_error(message: &str) -> AppError {
    app_error(ErrorCode::UnsupportedSchema, message, false)
}
fn resource_limit_error(message: &str) -> AppError {
    app_error(ErrorCode::ResourceLimit, message, false)
}

pub fn default_resume_document(document_id: &str) -> Result<ResumeDocument, AppError> {
    // 与旧版空白初始状态逐字段一致：标题、模块名、默认顺序、排版默认值。
    // section id 采用与 legacySnapshot 转换器相同的稳定前缀，保证首屏即可 diff。
    let module = |kind: &str, title: &str, visible: bool| {
        serde_json::json!({
            "id": format!("legacy-section:{kind}"), "kind": kind, "title": title,
            "visible": visible, "entries": []
        })
    };
    let json = serde_json::json!({
      "schemaVersion":2,
      "documentId":document_id,
      "title":"resume DIY",
      "basic":{"name":"","phone":"","email":"","city":"","wechat":"","birth":"","ageMode":"age"},
      "sections":[
        module("education", "教育经历", true),
        module("skills", "专业技能", true),
        module("work", "实习经历", true),
        module("projects", "项目经历", true),
        module("orgs", "社团和组织经历", true),
        {"id":"legacy-section:summary","kind":"summary","title":"自我评价","visible":true,"body":[]},
        module("research", "研究经历", false),
        module("awards", "荣誉奖项", false),
        module("other", "其他经历", false),
        module("portfolio", "作品集", false),
        module("custom", "自定义模块", false)
      ],
      "presentation":{"templateId":"legacy-v1","templateRevision":"1","density":"standard","fontSetId":"legacy-font:宋体","fontSizePt":9.75,"lineHeightPt":9.75,"moduleGapPt":0,"pageMarginPt":22.5,"headingSizePt":9.75,"paragraphGapPt":0,"listGapPt":0,"theme":"#000000","dateFormat":"2021年1月","titleFormat":"单行标题","separator":"使用分隔符号","textAlign":"两端对齐","legacyOverrides":{}},
      "legacyExtensions":{}
    });
    serde_json::from_value(json)
        .map_err(|error| validation_error(&format!("Invalid default document: {error}")))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn document() -> ResumeDocument {
        serde_json::from_str(r##"{
          "schemaVersion": 2,
          "documentId": "doc-1",
          "title": "测试简历",
          "basic": {"name":"样例","phone":"","email":"","city":"","wechat":"","birth":"","ageMode":"age"},
          "sections": [
            {"id":"summary-1","kind":"summary","title":"自我评价","visible":true,"body":[{"type":"paragraph","children":[{"type":"text","text":"本地","marks":[]}]}]},
            {"id":"work-1","kind":"work","title":"工作","visible":true,"entries":[{"id":"entry-1","title":"工程师","role":"","department":"","city":"","start":"2024","end":"2025","body":[{"type":"paragraph","children":[{"type":"text","text":"工作","marks":[]}]}]}]}
          ],
          "presentation": {"templateId":"legacy-v1","templateRevision":"1","density":"standard","fontSetId":"fixture","fontSizePt":9.75,"lineHeightPt":12,"moduleGapPt":8,"pageMarginPt":24,"headingSizePt":11,"paragraphGapPt":4,"listGapPt":4,"theme":"#000000","dateFormat":"2021.01","titleFormat":"双行标题","separator":"不使用分隔符号","textAlign":"系统默认","legacyOverrides":{}},
          "legacyExtensions": {"unknownField":{"safe":true}}
        }"##).expect("valid fixture")
    }

    fn envelope(payload: DomainCommand) -> CommandEnvelope {
        CommandEnvelope {
            protocol_version: 1,
            command_id: "cmd-1".into(),
            document_id: "doc-1".into(),
            context_id: "context-1".into(),
            expected_revision: "0".into(),
            expected_branch_id: "main".into(),
            expected_head_id: None,
            payload,
        }
    }

    #[test]
    fn builds_valid_default_resume_document() {
        let document = default_resume_document("doc-default").expect("default document");
        assert_eq!(document.document_id, "doc-default");
        // 默认文档与旧版空白初始状态一致：标题、11 个 section（含隐藏模块）与默认排版。
        assert_eq!(document.title, "resume DIY");
        assert_eq!(document.sections.len(), 11);
        let section_id = |index: usize| match &document.sections[index] {
            Section::Entry(entry) => entry.id.as_str(),
            Section::Summary(summary) => summary.id.as_str(),
        };
        assert_eq!(section_id(0), "legacy-section:education");
        assert_eq!(section_id(5), "legacy-section:summary");
        let hidden = document
            .sections
            .iter()
            .filter(|section| match section {
                Section::Entry(entry) => !entry.visible,
                Section::Summary(summary) => !summary.visible,
            })
            .count();
        assert_eq!(hidden, 5);
        assert!(canonical_hash(&document).is_ok());
        assert_eq!(
            default_resume_document("doc-\"quoted\"")
                .expect("escaped document ID")
                .document_id,
            "doc-\"quoted\""
        );
    }

    #[test]
    fn preserves_unknown_fields_and_hashes_stably() {
        let value = document();
        let json = serde_json::to_value(&value).expect("serialize");
        assert_eq!(json["legacyExtensions"]["unknownField"]["safe"], true);
        let first = canonical_hash(&value).expect("hash");
        let round_trip: ResumeDocument = serde_json::from_value(json).expect("deserialize");
        assert_eq!(first, canonical_hash(&round_trip).expect("hash"));
    }

    #[test]
    fn browser_rich_text_golden_deserializes_and_validates_in_rust() {
        let fixture: serde_json::Value =
            serde_json::from_str(include_str!("../../fixtures/legacy-richtext-golden.json"))
                .expect("shared fixture");
        let blocks: Vec<RichBlock> =
            serde_json::from_value(fixture["blocks"].clone()).expect("Rust rich blocks");
        for block in &blocks {
            validate_block(block, 0).expect("domain rich text validation");
        }
        assert_eq!(
            serde_json::to_value(blocks).expect("serialize"),
            fixture["blocks"]
        );
    }

    #[test]
    fn applies_title_and_returns_monotonic_cursor() {
        let mut context = DocumentContext::new(document()).expect("context");
        let result = context
            .apply_command(
                "host-actor",
                "context-1",
                envelope(DomainCommand::SetDocumentTitle {
                    title: "新标题".into(),
                }),
            )
            .expect("apply");
        assert_eq!(result.cursor.revision, "1");
        assert_eq!(result.document.title, "新标题");
        assert!(result.durable);
    }

    #[test]
    fn retries_same_command_but_rejects_reuse() {
        let mut context = DocumentContext::new(document()).expect("context");
        let command = envelope(DomainCommand::SetDocumentTitle {
            title: "第一次".into(),
        });
        let first = context
            .apply_command("host-actor", "context-1", command.clone())
            .expect("first");
        let retry = context
            .apply_command("host-actor", "context-1", command)
            .expect("retry");
        assert_eq!(first, retry);
        let reused = envelope(DomainCommand::SetDocumentTitle {
            title: "第二次".into(),
        });
        assert_eq!(
            context
                .apply_command("host-actor", "context-1", reused)
                .unwrap_err()
                .code,
            ErrorCode::Conflict
        );
    }

    #[test]
    fn rejected_commands_leave_document_and_cursor_unchanged() {
        let mut context = DocumentContext::new(document()).expect("context");
        let original = context.document().clone();
        let original_cursor = context.cursor("context-1");
        let invalid_body = vec![RichBlock::Paragraph {
            children: vec![Inline::Link {
                href: "javascript:alert(1)".into(),
                children: vec![],
            }],
        }];
        assert_eq!(
            context
                .apply_command(
                    "host-actor",
                    "context-1",
                    envelope(DomainCommand::SetEntryBody {
                        entry_id: "entry-1".into(),
                        body: invalid_body,
                    }),
                )
                .unwrap_err()
                .code,
            ErrorCode::Validation
        );
        assert_eq!(context.document(), &original);
        assert_eq!(context.cursor("context-1"), original_cursor);

        assert_eq!(
            context
                .apply_command(
                    "host-actor",
                    "context-1",
                    envelope(DomainCommand::MoveEntry {
                        entry_id: "entry-1".into(),
                        section_id: "summary-1".into(),
                        index: 0,
                    }),
                )
                .unwrap_err()
                .code,
            ErrorCode::Validation
        );
        assert_eq!(context.document(), &original);
        assert_eq!(context.cursor("context-1"), original_cursor);

        let mut valid = envelope(DomainCommand::SetDocumentTitle {
            title: "仍可编辑".into(),
        });
        valid.command_id = "cmd-after-rejection".into();
        let result = context
            .apply_command("host-actor", "context-1", valid)
            .expect("valid command after rejection");
        assert_eq!(result.cursor.revision, "1");
        assert_eq!(result.document.title, "仍可编辑");
        assert_eq!(result.document.sections, original.sections);
    }

    #[test]
    fn summary_body_command_targets_only_summary_and_validates_rich_text() {
        let mut context = DocumentContext::new(document()).expect("context");
        let body = vec![RichBlock::Paragraph {
            children: vec![Inline::Text {
                text: "中文自我评价".into(),
                marks: vec![InlineMark::Bold],
            }],
        }];
        let result = context
            .apply_command(
                "host-actor",
                "context-1",
                envelope(DomainCommand::SetSummaryBody {
                    section_id: "summary-1".into(),
                    body: body.clone(),
                }),
            )
            .expect("edit summary");
        assert_eq!(result.changed_ids, vec!["summary-1"]);
        assert_eq!(result.cursor.revision, "1");
        let Section::Summary(summary) = &result.document.sections[0] else {
            panic!("summary section");
        };
        assert_eq!(summary.body, body);
        assert_eq!(result.document.sections[1], document().sections[1]);

        let mut wrong_target = envelope(DomainCommand::SetSummaryBody {
            section_id: "work-1".into(),
            body,
        });
        wrong_target.command_id = "cmd-wrong-target".into();
        wrong_target.expected_revision = "1".into();
        assert_eq!(
            context
                .apply_command("host-actor", "context-1", wrong_target)
                .unwrap_err()
                .code,
            ErrorCode::Validation
        );
        assert_eq!(context.document(), &result.document);
        assert_eq!(context.cursor("context-1"), result.cursor);
    }

    #[test]
    fn legacy_entry_fields_and_blank_basic_name_remain_editable() {
        let mut context = DocumentContext::new(document()).expect("context");
        let edited = context
            .apply_command(
                "host-actor",
                "context-1",
                envelope(DomainCommand::UpdateEntryFields {
                    entry_id: "entry-1".into(),
                    title: None,
                    role: None,
                    department: None,
                    city: None,
                    start: None,
                    end: None,
                    college: Some("示例大学".into()),
                    mode: Some("全日制".into()),
                }),
            )
            .expect("edit legacy fields");
        assert_eq!(edited.cursor.revision, "1");
        let Section::Entry(section) = &edited.document.sections[1] else {
            panic!("entry section");
        };
        assert_eq!(section.entries[0].college.as_deref(), Some("示例大学"));
        assert_eq!(section.entries[0].mode.as_deref(), Some("全日制"));

        let mut clear_fields = envelope(DomainCommand::UpdateEntryFields {
            entry_id: "entry-1".into(),
            title: None,
            role: None,
            department: None,
            city: None,
            start: None,
            end: None,
            college: Some(String::new()),
            mode: Some(String::new()),
        });
        clear_fields.command_id = "clear-fields".into();
        clear_fields.expected_revision = "1".into();
        let cleared = context
            .apply_command("host-actor", "context-1", clear_fields)
            .expect("clear optional fields");
        let Section::Entry(section) = &cleared.document.sections[1] else {
            panic!("entry section");
        };
        assert_eq!(section.entries[0].college, None);
        assert_eq!(section.entries[0].mode, None);

        let mut clear_name = envelope(DomainCommand::UpdateBasic {
            patch: BasicPatch {
                name: Some(String::new()),
                ..BasicPatch::default()
            },
        });
        clear_name.command_id = "clear-name".into();
        clear_name.expected_revision = "2".into();
        let result = context
            .apply_command("host-actor", "context-1", clear_name)
            .expect("blank name is valid in the legacy editor");
        assert_eq!(result.document.basic.name, "");
        assert_eq!(result.cursor.revision, "3");
    }

    #[test]
    fn rejects_duplicate_sections_and_bad_links() {
        let mut duplicate = document();
        duplicate.sections.push(
            serde_json::from_str(
                r##"{"id":"summary-1","kind":"summary","title":"重复","visible":true,"body":[]}"##,
            )
            .expect("section"),
        );
        assert_eq!(
            DocumentContext::new(duplicate).unwrap_err().code,
            ErrorCode::Validation
        );

        let mut bad_link = document();
        if let Section::Summary(summary) = &mut bad_link.sections[0] {
            summary.body.push(serde_json::from_str(r##"{"type":"paragraph","children":[{"type":"link","href":"javascript:alert(1)","children":[]}]}"##).expect("inline"));
        }
        assert_eq!(
            DocumentContext::new(bad_link).unwrap_err().code,
            ErrorCode::Validation
        );
    }

    #[test]
    fn public_mutation_contract_rejects_unlisted_and_account_scoped_fields() {
        let confirm = serde_json::json!({
            "commandId": "cmd-confirm-123",
            "cursor": {
                "documentId": "doc-1",
                "contextId": "context-1",
                "revision": "0",
                "branchId": "main",
                "headId": null
            },
            "proposalId": "proposal-1",
            "acceptedItemIds": ["item-1"]
        });
        assert!(serde_json::from_value::<ConfirmProposalRequest>(confirm.clone()).is_ok());
        let mut cross_account = confirm;
        cross_account["accountId"] = serde_json::json!("attacker-account");
        assert!(serde_json::from_value::<ConfirmProposalRequest>(cross_account).is_err());

        let mut envelope = serde_json::json!({
            "protocolVersion": 1,
            "commandId": "cmd-title-123",
            "documentId": "doc-1",
            "contextId": "context-1",
            "expectedRevision": "0",
            "expectedBranchId": "main",
            "expectedHeadId": null,
            "payload": { "type": "setDocumentTitle", "title": "更新" }
        });
        assert!(serde_json::from_value::<CommandEnvelope>(envelope.clone()).is_ok());
        envelope["payload"]["accountId"] = serde_json::json!("attacker-account");
        assert!(serde_json::from_value::<CommandEnvelope>(envelope).is_err());

        let unknown_template = serde_json::json!({
            "commandId": "cmd-template-123",
            "cursor": {
                "documentId": "doc-1",
                "contextId": "context-1",
                "revision": "0",
                "branchId": "main",
                "headId": null
            },
            "templateId": "untrusted-template",
            "templateRevision": "1"
        });
        assert!(serde_json::from_value::<ApplyTemplateRequest>(unknown_template).is_err());
    }

    #[test]
    fn app_errors_have_distinct_diagnostic_ids() {
        let first = AppError::new(ErrorCode::Conflict, "stale cursor", false);
        let second = AppError::new(ErrorCode::Conflict, "stale cursor", false);
        assert_ne!(first.diagnostic_id, second.diagnostic_id);
        assert!(first.diagnostic_id.starts_with("diag-"));
    }

    #[test]
    fn unknown_document_ids_return_not_found_without_advancing_cursor() {
        let mut context = DocumentContext::new(document()).expect("context");
        let cursor = context.cursor("context-1");
        let error = context
            .apply_command(
                "host-actor",
                "context-1",
                envelope(DomainCommand::DeleteEntry {
                    entry_id: "entry-not-in-document".into(),
                }),
            )
            .unwrap_err();
        assert_eq!(error.code, ErrorCode::NotFound);
        assert_eq!(context.cursor("context-1"), cursor);
    }
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
