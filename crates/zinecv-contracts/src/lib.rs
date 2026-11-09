//! ZineCV 跨端契约（C+ Phase 1a，自 `src-tauri/src/domain.rs` 原样抽取）。
//!
//! 全部跨 IPC / 跨端的 serde schema 与 ts-rs 绑定类型：领域文档、命令信封、
//! 权限游标、导入草稿、Agent 提案、预览/导出载荷与备份 JSON。类型体、serde
//! 属性与 ts-rs 绑定输出与抽取前逐字节一致；绑定仍生成到
//! `src-tauri/src/domain/bindings/`，SHA 清单 `contracts/ts-bindings-sha256.json`
//! 不变（见 `docs/ARCHITECTURE_TARGET_CPLUS.md`）。
//!
//! 依赖刻意最小（serde/serde_json/ts-rs/sha2/getrandom），不依赖 Tauri、
//! rusqlite 或 Typst，保证未来可平移到 wasm32 目标。

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256 as Sha256Hasher};
use ts_rs::TS;
use url::{Host, Url};

pub mod capability;

#[cfg(test)]
#[path = "tests.rs"]
mod tests;

#[path = "document.rs"]
mod document;
pub use document::{
    canonical_hash, ActiveDocumentState, AgeMode, ArchiveDocumentRequest, BasicInfo,
    CreateDocumentPayload, CreateDocumentReceipt, CreateDocumentRequest, CreateDocumentResult,
    DateFormat, Density, DocumentListResult, DocumentMeta, DocumentOriginKind, Entry, EntrySection,
    Id, Inline, InlineMark, ModuleKind, Presentation, RestoreDocumentRequest, ResumeDocument,
    Revision, RichBlock, Section, Separator, Sha256, SourceRef, SummarySection,
    SwitchActiveDocumentRequest, SwitchActiveDocumentResult, TextAlign, TitleFormat,
};

#[path = "commands.rs"]
mod commands;
pub use commands::{
    AppError, AuthorityCursor, BasicField, BasicPatch, CommandEnvelope, CommandResult,
    DatabaseBackupPayload, DatabaseRestoreResult, DomainCommand, EditingContextSourceKind,
    EditorContext, ErrorCode, NativeIpcCommandName, SwitchEditingContextRequest,
    SwitchEditingContextResult, UpdaterStatus, UpdaterTargetInfo, VersionBranch, VersionCommit,
    VersionCommitDetailed, VersionGraph, VersionGraphDetailed,
};

#[path = "imports.rs"]
mod imports;
pub use imports::{
    CreateImportDraftRequest, DeleteJobMaterialRequest, DocumentJobLink, ImportBasicField,
    ImportCandidate, ImportCandidateCorrection, ImportCandidateValue, ImportDraft,
    ImportDraftStatus, ImportFieldEvidence, ImportSourceKind, JobMaterial, JobMaterialListResult,
    LinkJobMaterialRequest, TransitionImportDraftRequest, UnlinkJobMaterialRequest,
    UpsertJobMaterialRequest,
};

#[path = "agent.rs"]
mod agent;
pub use agent::{
    chat_endpoint, AgentProposalDraft, AgentProposalDraftItem, AgentProposalInbox,
    AgentProposalItem, AgentProposalReceipt, AgentProposalRecord, AgentProposalStatus,
    AgentProposalUndoRecord, ApplyImportRequest, ApplyTemplateRequest, BuiltinTemplateId,
    ConfirmProposalRequest, Proposal, ProposalChange, ProposalItem, RejectAgentProposalRequest,
    UndoConfirmedProposalRequest,
};

#[path = "render.rs"]
mod render;
pub use render::{
    ExportData, ExportPng, ExportProduct, ExportResult, FitAttempt, FitPlan, FitResult, FitStatus,
    HitFragment, HitRegion, LegacyEditArchive, PreviewData, PreviewPage, PreviewResult,
    RenderFormat, RenderRequest, RenderResult, SourcePageLink, TextCluster, TextLink, TextMap,
};

mod native_exports;
pub use native_exports::{
    ExportArtifact, ExportFileFormat, ExportReceipt, ExportWriteOutcome, FrozenExportSource,
    NativeExportResult,
};

#[path = "migration.rs"]
mod migration;
pub use migration::{
    CommitLegacyMigrationRequest, DryRunLegacyMigrationRequest,
    InspectLegacyIdentityConflictsRequest, InspectLegacyMigrationRequest,
    LegacyMigrationCommitReceipt, LegacyMigrationConflict, LegacyMigrationConflictKind,
    LegacyMigrationConvertedDocument, LegacyMigrationCounts, LegacyMigrationDocumentKind,
    LegacyMigrationDryRun, LegacyMigrationExpectedHash, LegacyMigrationFieldEvidence,
    LegacyMigrationIdentityConflict, LegacyMigrationIssue, LegacyMigrationPreference,
    LegacyMigrationReport, LegacyMigrationSeverity, LegacyMigrationSourceInput,
    LegacyMigrationSourceKind, LegacyMigrationSourceReport, LegacyMigrationTemplates,
    LegacyMigrationVersionBranch, LegacyMigrationVersionCommit, LegacyMigrationVersionGraph,
};
