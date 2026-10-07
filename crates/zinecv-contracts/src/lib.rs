//! ZineCV 跨端契约（C+ Phase 1a，自 `src-tauri/src/domain.rs` 原样抽取）。
//!
//! 全部跨 IPC / 跨端的 serde schema 与 ts-rs 绑定类型：领域文档、命令信封、
//! 权限游标、导入草稿、Agent 提案、预览/导出载荷与备份 JSON。类型体、serde
//! 属性与 ts-rs 绑定输出与抽取前逐字节一致；绑定仍生成到
//! `src-tauri/src/domain/bindings/`，SHA 清单 `contracts/ts-bindings-sha256.json`
//! 不变（见 `docs/EXECUTION_PLAN_20261006-cplus.md`）。
//!
//! 依赖刻意最小（serde/serde_json/ts-rs/sha2/getrandom），不依赖 Tauri、
//! rusqlite 或 Typst，保证未来可平移到 wasm32 目标。

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256 as Sha256Hasher};
use ts_rs::TS;
use url::{Host, Url};

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

// ---------------------------------------------------------------------------
// Agent 传输契约（P3b，自 src-tauri/src/gateway.rs 原样迁入）：模型端点
// URL 校验是安全边界（拒绝用户信息/查询参数、强制 HTTPS 或带端口本机
// HTTP、拒绝内网直连目标），gateway 与迁移身份检查双侧单源消费。
// ---------------------------------------------------------------------------

pub fn chat_endpoint(base_url: &str) -> Result<Url, String> {
    let mut url = Url::parse(base_url).map_err(|_| "模型连接地址无效".to_string())?;
    if !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err("模型连接地址不能包含用户信息、查询参数或片段".into());
    }
    let local = match url.host() {
        Some(Host::Domain("localhost")) => true,
        Some(Host::Ipv4(ip)) => ip.is_loopback(),
        Some(Host::Ipv6(ip)) => ip.is_loopback(),
        _ => false,
    };
    if url.scheme() != "https" && !(url.scheme() == "http" && local && url.port().is_some()) {
        return Err("模型连接地址必须是 HTTPS 或带端口的本机 HTTP".into());
    }
    let path = url.path().trim_end_matches('/');
    let endpoint = if path.ends_with("/chat/completions") {
        path.to_string()
    } else {
        format!("{path}/chat/completions")
    };
    url.set_path(&endpoint);
    Ok(url)
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
}
