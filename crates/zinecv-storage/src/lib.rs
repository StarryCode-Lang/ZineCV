//! ZineCV 存储语义 crate（C+ P3）。
//!
//! P3a：`migration` 模块（legacy 迁移检查/试运行/提交状态机）。
//! P3b：`storage` 模块（Store/事务/CAS/版本图/备份恢复/资源/提案持久化）
//! 与 `identity` 模块（账户/秘密 DPAPI、scrypt、provider 凭据）。全部自
//! `src-tauri/src/{storage.rs,storage/*,identity.rs}` 原样迁入，仅做
//! `crate::domain::`→`zinecv_contracts::`/`zinecv_domain::`、
//! `crate::engine::`→`zinecv_engine::`、`crate::gateway::chat_endpoint`→
//! `zinecv_contracts::chat_endpoint` 路径映射，机械 diff 逐字验证。
//!
//! 注意：`storage` 子模块文件镜像放在 `src/storage/` 下（与原布局一致，
//! 模块声明零改动）；`identity` 的 DPAPI 分支为 `#[cfg(windows)]`，
//! 非平台环境编译时秘密计数路径按既有 not(windows) 分支降级。

pub mod identity;
pub mod migration;
pub mod storage;
