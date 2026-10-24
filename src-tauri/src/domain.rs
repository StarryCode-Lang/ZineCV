//! 领域 schema 与领域逻辑已按 C+ 目标架构抽取为独立 crate（见
//! `docs/EXECUTION_PLAN_20261006-cplus.md`）：
//!
//! - `crates/zinecv-contracts`：命令、DTO、schema 类型、备份 JSON 载荷、规范化哈希
//! - `crates/zinecv-domain`：命令应用（DocumentContext）、文档校验、默认文档
//!
//! 本文件只是再出口垫片，仅保留宿主代码仍以 `crate::domain::` 路径引用的项；
//! 其余类型一律直接依赖 `zinecv_contracts`/`zinecv_domain`。全部 106 个
//! ts-rs 类型已由 contracts 单源生成。

pub use zinecv_contracts::{
    AgentProposalInbox, AgentProposalReceipt, AppError, ApplyImportRequest, AuthorityCursor,
    CommandEnvelope, CommandResult, ConfirmProposalRequest, CreateImportDraftRequest,
    DatabaseBackupPayload, DatabaseRestoreResult, DomainCommand, EditingContextSourceKind,
    ErrorCode, ExportData, ExportPng, ExportProduct, ExportResult, FitPlan, FitResult, HitRegion,
    ImportDraft, PreviewData, PreviewResult, Proposal, RejectAgentProposalRequest, RenderFormat,
    ResumeDocument, Sha256, SwitchEditingContextRequest, SwitchEditingContextResult, TextMap,
    TransitionImportDraftRequest, UndoConfirmedProposalRequest, UpdaterStatus, UpdaterTargetInfo,
};
pub use zinecv_domain::default_resume_document;
