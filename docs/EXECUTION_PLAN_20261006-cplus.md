# C+ 分阶段实施

架构依据[ARCHITECTURE_TARGET_CPLUS](ARCHITECTURE_TARGET_CPLUS.md)，当前状态见[SLICE](SLICE_20261002.md)，剩余任务见[plan](../plan.md)。本文件只保留阶段、依赖和实现注意点；逐次会话记录合并至[HISTORY](HISTORY_202610.md)，不复制旧执行日志。

## 阶段与历史里程碑

以下状态描述对应阶段当时的实现和验证，不代表当前修订或完整跨平台资格。历史raw运行目录已删除；路径只作历史指针，不要求恢复。

| 阶段 | 内容 | 退出判据 | 状态 |
| --- | --- | --- | --- |
| **P0 决策落档** | C+ 定案写入 `docs/ARCHITECTURE_TARGET_CPLUS.md`；本计划落档 | 两文档在库，设计记录在库 | ✅ 2026-10-06 |
| **P1a contracts/domain 第一批** | 新建 `crates/zinecv-contracts`（`domain.rs` 全部 76 个导出类型 + `AppError` 全实现 + `canonical_hash`）与 `crates/zinecv-domain`（`DocumentContext`、`validate_*`、`default_resume_document` 及其测试）；`src-tauri/src/domain.rs` 变纯再出口垫片；`with-msvc.ps1` 的 bindings/check/test/fmt 覆盖新 crate | cargo check/test（src-tauri + 两 crate）全绿；clippy `-D warnings` 全绿；绑定当时绑定一致 | ✅ 2026-10-06 |
| **P1b contracts 第二批** | `migration.rs` 25 个 + `storage.rs` 5 个导出类型并入 `zinecv-contracts`（`LegacyMigrationCounts::add_assign` 随迁转 pub；两文件改为再出口垫片并清理失效 serde/TS 导入）；`with-msvc.ps1` bindings 任务收敛为 contracts 单出口 | 同上；绑定仍 106 个一致性已核对；migration/storage 瘦身约 420 行 | ✅ 2026-10-06 |
| **P2 engine 抽取** | `engine.rs` + `engine/*` + `templates.typ`（3,948 行）→ `crates/zinecv-engine`；glob 再出口垫片；`FONT_*` 静态转 pub；`impl From<EngineError> for AppError` 因孤儿规则迁入 engine crate；storage 资源指纹 include 改指新位置；fixture 工具模板路径更新并重生成清单；src-tauri 移除 tiny-skia/ttf-parser/unicode-bidi | clippy `-D warnings` 四 crate 绿；304 测试守恒（149+109+9+37）；绑定一致性已核对；**engine-parity geometry_and_text_passed、visual-parity pass**（dist 按清理指令重建后复删）；release 收据双份落档 | ✅ 2026-10-07 |
| **P3a storage 首批（migration）** | `migration.rs`（3,734 行）→ `crates/zinecv-storage`，子代理纯转写 + 机械 diff 逐字验证（仅 2 处 `crate::domain::`→`zinecv_*::` 路径替换）；`supported_image_bytes` pub(crate)→pub；storage crate 依赖 contracts+domain+rusqlite | clippy 五 crate 绿；304 测试守恒（139+109+9+37+10）；绑定一致性已核对 | ✅ 2026-10-07 |
| **P3b storage 主体（Store）** | storage/identity/migration 全部迁入 `zinecv-storage`；SecretProvider 注入，Windows DPAPI 放入 `zinecv-native`；恢复暂存库继承秘密能力；hooks 同时验证宿主与 storage | 306 原生测试、106 绑定一致性已核对；备份/恢复/迁移/事务中断 WebView2 通过 | ✅ 2026-10-07 Windows 收口 |
| **P4 agent 抽取** | agent/context/gateway 迁入 `zinecv-agent`；AgentTransport 注入、NativeTransport 保留 HTTP/SSE；移除 crate 的 Tauri 测试依赖，Web fetch 实现留 P6 | 原生策略及注入测试、Agent UI 与提案资源 WebView2 通过 | ✅ 2026-10-07 Windows 收口 |
| **P5 host 瘦身** | 宿主保留 56 IPC、窗口/原生能力装配、render_worker/scheduler、export_io、font_protocol；核心模块再出口，无 storage/agent 重复实现。PlatformCapabilities 随实际 P6 消费方引入 | full 34 个阶段分批通过，视觉两视口 0px；不代表全平台验收 | ✅ 2026-10-07 Windows 收口 |
| **P6 Web 腿** | 同步 JS 桥 POC 已通过；产品使用 SQLite 编进 WASM + Rust OPFS VFS，复用同一 Store。WASM facade、Typst、Web fetch、WebCrypto、Worker/PWA 和共享 React 接线已落地 | Windows Chromium 产品行为通过；Native/WASM 9 组 Gate A/B、两组 Fit 和同平台 PDF 复现通过；备份互通与最新完整 Windows 回归见HISTORY对应记录 | ✅ 实现与本机门禁；浏览器全兼容性未验 |
| **P7 鸿蒙腿** | OpenHarmony 公共 native SDK 6.0.0.47 Beta1/API20，ARM64 原生 Store/Typst + NAPI 注册 .so 已交叉编译；Windows 探针 1 项通过 | 原生编译淘汰判据已闭合；完整 ArkTS/ArkWeb Host、平台安全存储/网络、HAP 与真机运行未完成，需要官方完整工具链和设备 | 🔶 核心 POC 完成；宿主未完成 |
| **P8 移动端 + 门禁扩展** | Windows 可运行的 Native/WASM 结构、栅格、备份互通门禁已新增。Android 缺 SDK/NDK/JDK17+（工具链和设备尚未验收）；iOS/macOS 构建需要 Apple 工具链 | 移动真机基准独立冻结，不沿用桌面数字 | 🔶 共享门禁落地；移动编译/设备待条件 |


## 依赖与实现边界

P1先确定contracts/domain；P2 engine依赖公共类型；P3 storage依赖版本图DTO；P4 Agent依赖Store与能力接口；P6/P7依赖P3/P4的trait化。每步保持桌面可用，失败可独立暂停；回退只处理已确认的本次修改，保留原有工作树与用户数据，不能用整路径checkout覆盖用户改动。

- contracts是schema来源，ts-rs仍输出宿主bindings。绑定无固定SHA锁，检查结构与严格类型；重新生成会带入Rust文档注释，统一TS_RS_EXPORT_DIR避免跨crate导入路径错误。
- SecretProvider注入Store及恢复暂存库，DPAPI留native；chat_endpoint的安全规则位于contracts，网络经AgentTransport注入。storage资源指纹现从轻量assets读取字体静态字节，engine再出口原路径；PDF集成测试仍经dev-dependency使用engine，不以图中空结果判定可删。
- Browser产品使用SQLite编入WASM与Rust OPFS VFS复用Store；同步JS桥仍是路线POC，不能混成第二套产品存储。WASM的getrandom需特性及目标cfg配合，原生配置保持独立。
- OHOS的.so/NAPI与Windows探针只证明核心POC；ArkTS Host、HAP、安全存储、网络、真机及移动工具链仍待独立实现/验证。Native/WASM结构与栅格对照不能代替所有浏览器或移动设备验收。

## 验证与记录

按实际修改选择fmt/clippy、领域/存储/Agent、绑定/IPC、原生UI或平台对照；预算与完整范围以AGENTS及verify-project为准。日常不自动追加release/full/长测；构建期间输入一致性、被测exe身份及独立测试数据继续校验。

2026-10-20已解除持久字节冻结：夹具按场景校验、绑定按结构/类型校验、许可按可编辑来源盘点、字体参考可替换；历史摘要不锁当前文件。通过状态和历史结论不自动升级。

阶段完成时只更新当前状态、必要证据及剩余任务，同步相关分析；不新增流水账、同义报告或完整可生成夹具。提交/推送/发布须用户授权。
