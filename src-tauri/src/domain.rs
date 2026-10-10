//! 领域 schema 与领域逻辑已按 C+ 目标架构抽取为独立 crate（见
//! `docs/EXECUTION_PLAN_20261006-cplus.md`）：
//!
//! - `crates/zinecv-contracts`：命令、DTO、schema 类型、备份 JSON 载荷、规范化哈希
//! - `crates/zinecv-domain`：命令应用（DocumentContext）、文档校验、默认文档
//!
//! 本文件只是再出口垫片：保留 `crate::domain::*` 既有引用路径，让 lib/storage/
//! migration/engine 等 51+ 调用点零改动。后续 host 瘦身阶段让各模块直接依赖
//! crate 后删除本垫片。全部 106 个 ts-rs 类型已由 contracts 单源生成。

pub use zinecv_contracts::{
    canonical_hash, AgeMode, AgentProposalDraft, AgentProposalDraftItem, AgentProposalInbox,
    AgentProposalItem, AgentProposalReceipt, AgentProposalRecord, AgentProposalStatus,
    AgentProposalUndoRecord, AppError, ApplyImportRequest, ApplyTemplateRequest, AuthorityCursor,
    BasicField, BasicInfo, BasicPatch, BuiltinTemplateId, CommandEnvelope, CommandResult,
    ConfirmProposalRequest, CreateImportDraftRequest, DatabaseBackupPayload, DatabaseRestoreResult,
    DateFormat, Density, DomainCommand, EditingContextSourceKind, EditorContext, Entry,
    EntrySection, ErrorCode, ExportData, ExportPng, ExportProduct, ExportResult, FitAttempt,
    FitPlan, FitResult, FitStatus, HitFragment, HitRegion, Id, ImportBasicField, ImportCandidate,
    ImportCandidateValue, ImportDraft, ImportDraftStatus, ImportFieldEvidence, ImportSourceKind,
    Inline, InlineMark, ModuleKind, NativeIpcCommandName, Presentation, PreviewData, PreviewPage,
    PreviewResult, Proposal, ProposalChange, ProposalItem, RejectAgentProposalRequest,
    RenderFormat, RenderRequest, RenderResult, ResumeDocument, Revision, RichBlock, Section,
    Separator, Sha256, SourceRef, SummarySection, SwitchEditingContextRequest,
    SwitchEditingContextResult, TextAlign, TextCluster, TextLink, TextMap, TitleFormat,
    TransitionImportDraftRequest, UndoConfirmedProposalRequest,
};
pub use zinecv_domain::{default_resume_document, DocumentContext};
