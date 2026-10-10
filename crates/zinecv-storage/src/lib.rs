//! ZineCV 存储语义 crate（C+ P3）。
//!
//! P3a：`migration` 模块（legacy 迁移检查/试运行/提交状态机）。
//! P3b：`storage` 模块（Store/事务/CAS/版本图/备份恢复/资源/提案持久化）
//! 与 `identity` 模块（账户、scrypt、provider 凭据）。主体自
//! `src-tauri/src/{storage.rs,storage/*,identity.rs}` 原样迁入，仅做
//! `crate::domain::`→`zinecv_contracts::`/`zinecv_domain::`、
//! `crate::engine::`→`zinecv_engine::`、`crate::gateway::chat_endpoint`→
//! `zinecv_contracts::chat_endpoint` 路径映射，机械 diff 逐字验证。
//!
//! `storage` 子模块仍位于 `src/storage/`。秘密操作只依赖注入的
//! `SecretProvider`；DPAPI 实现在 zinecv-native，宿主在打开 Store 后注入。
//! 缺少能力时拒绝写入秘密，备份/恢复准确报告需要重输的密钥数量。

pub mod identity;
pub mod migration;
pub mod storage;

// Browser wall/monotonic clocks use the host APIs; native code keeps std clocks.
pub(crate) mod clock {
    #[cfg(not(all(target_arch = "wasm32", target_os = "unknown")))]
    pub use std::time::{SystemTime, UNIX_EPOCH};
    #[cfg(all(target_arch = "wasm32", target_os = "unknown"))]
    pub use web_time::{SystemTime, UNIX_EPOCH};
}
