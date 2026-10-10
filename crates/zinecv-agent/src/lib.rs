//! ZineCV Agent 语义 crate（C+ P4）。
//!
//! `agent`（Provider 协议/流式会话/Proposal 生成）、`agent_context`
//! （引用目录与上下文组装）、`gateway`（模型端点传输与 URL 安全校验）
//! 自 `src-tauri/src/{agent,agent_context,gateway}.rs` 原样迁入，仅做
//! `crate::domain::`→`zinecv_contracts::`（例外：default_resume_document
//! →`zinecv_domain::`）与 `crate::storage::`→`zinecv_storage::` 路径映射，
//! 机械 diff 逐字验证。运行时与测试均不依赖 Tauri。
//! 策略经 AgentTransport 注入传输；NativeTransport 复用 gateway 的
//! URL/DNS 校验、HTTP/SSE、预算与取消协议。浏览器 Adapter 尚未实现。

pub mod agent;
pub mod agent_context;
pub mod gateway;
pub mod transport;

#[cfg(all(target_arch = "wasm32", target_os = "unknown"))]
pub mod browser;

pub(crate) mod runtime {
    #[cfg(not(all(target_arch = "wasm32", target_os = "unknown")))]
    pub use std::time::Instant;
    #[cfg(all(target_arch = "wasm32", target_os = "unknown"))]
    pub use web_time::Instant;

    pub async fn timeout<F: std::future::Future>(
        duration: std::time::Duration,
        future: F,
    ) -> Result<F::Output, ()> {
        #[cfg(not(all(target_arch = "wasm32", target_os = "unknown")))]
        {
            tokio::time::timeout(duration, future).await.map_err(|_| ())
        }
        #[cfg(all(target_arch = "wasm32", target_os = "unknown"))]
        {
            use futures_util::future::{select, Either};
            let timer = gloo_timers::future::TimeoutFuture::new(
                duration.as_millis().min(u32::MAX as u128) as u32,
            );
            futures_util::pin_mut!(future, timer);
            match select(future, timer).await {
                Either::Left((result, _)) => Ok(result),
                Either::Right(_) => Err(()),
            }
        }
    }
}
