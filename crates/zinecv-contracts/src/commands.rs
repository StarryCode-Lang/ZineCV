use super::*;

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
    WriteClipboardText,
    AppUpdateState,
    AppUpdateCheck,
    AppUpdateDownload,
    AppUpdateCancelDownload,
    AppUpdateInstall,
}

/// 更新目标的展示元数据。`notes` 是远端发布说明，渲染时视为不可信输入
/// （前端必须以纯文本呈现，不得作为 HTML 注入）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../src/domain/bindings/")]
#[serde(rename_all = "camelCase")]
pub struct UpdaterTargetInfo {
    pub version: String,
    pub notes: Option<String>,
    pub pub_date: Option<String>,
    /// true 表示目标包已在本地缓存（下载会复用本地字节并重新验签）。
    pub cached: bool,
}

/// 桌面更新器的权威阶段状态（Rust 侧推进，经 updater-state-changed 事件
/// 与 app_update_state 命令发布）。阶段只描述流程位置；动作错误经各命令
/// 的 AppError 返回，不在此建模。字节数以 f64 传输：ts-rs 会把 u64 生成为
/// bigint，而 IPC JSON 实际是 number，更新包体积（<2^53 字节）用 f64 避免
/// 形态分裂。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../src/domain/bindings/")]
#[serde(
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    tag = "phase"
)]
pub enum UpdaterStatus {
    /// 未配置更新端点或公钥：更新功能不可用，不是错误。
    Unconfigured {
        current_version: String,
    },
    Idle {
        current_version: String,
    },
    Checking {
        current_version: String,
    },
    UpToDate {
        current_version: String,
    },
    Available {
        current_version: String,
        target: UpdaterTargetInfo,
    },
    /// `total` 为 None 表示服务器未报告内容长度（未知下载长度）。
    Downloading {
        current_version: String,
        target: UpdaterTargetInfo,
        received: f64,
        total: Option<f64>,
    },
    ReadyToInstall {
        current_version: String,
        target: UpdaterTargetInfo,
        received: f64,
    },
    /// 安装器即将启动且应用进程将退出；启动安装器不等于更新成功，
    /// 成功以重启后版本号变化为准。
    Installing {
        current_version: String,
        target: UpdaterTargetInfo,
    },
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
