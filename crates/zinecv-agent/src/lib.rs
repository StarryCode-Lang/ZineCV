//! ZineCV Agent 语义 crate（C+ P4）。
//!
//! `agent`（Provider 协议/流式会话/Proposal 生成）、`agent_context`
//! （引用目录与上下文组装）、`gateway`（模型端点传输与 URL 安全校验）
//! 自 `src-tauri/src/{agent,agent_context,gateway}.rs` 原样迁入，仅做
//! `crate::domain::`→`zinecv_contracts::`（例外：default_resume_document
//! →`zinecv_domain::`）与 `crate::storage::`→`zinecv_storage::` 路径映射，
//! 机械 diff 逐字验证。运行时代码零 Tauri 依赖。

pub mod agent;
pub mod agent_context;
pub mod gateway;
