# C+ 架构落地执行计划（2026-10-06 启动）

> 2026-10-18 状态同步：下文保留C+迁移的历史阶段与约束。当前日常验证按AGENTS.md最新效率规则选择范围，不在每次收尾重复整链；常用15阶段与延后批次分别通过，完整剩余事项见 `../plan.md`。

依据 `docs/ARCHITECTURE_TARGET_CPLUS.md`（唯一目标架构，已签字定案）。本计划是 C+ 迁移的活动工作文档：每阶段追加会话记录与证据；阶段完成后按惯例把有效事实合并回 `docs/SLICE_20261002.md`。

## 铁律（每个阶段都适用）

1. **Windows RC 全绿**：每一步结束时 `check:native` / `test:native`（历史基线 304 项，本轮新增 2 项接口行为测试后为 306）/ `test:bindings`（106 绑定零漂移）/ `verify:contracts` 必须全过；不把局部通过记成整体通过。
2. **绑定零漂移**：ts-rs 绑定仍生成到 `src-tauri/src/domain/bindings/`，SHA 清单 `contracts/ts-bindings-sha256.json` 不变；抽取只搬家不改 serde 形状。
3. **调用方零改动优先**：抽取期间用 `crate::domain` 再出口垫片保留既有引用路径；调用方改直接依赖 crate 属于后续瘦身阶段。
4. **不推送、不发布、不提交**：本地提交需用户明确授权。
5. 构建运行期间不改仓库任何文件（收据拒绝）；native 编译一律经 `tools/with-msvc.ps1`。

## 阶段划分

| 阶段 | 内容 | 退出判据 | 状态 |
| --- | --- | --- | --- |
| **P0 决策落档** | C+ 定案写入 `docs/ARCHITECTURE_TARGET_CPLUS.md`；本计划落档 | 两文档在库，四份保护文档未动 | ✅ 2026-10-06 |
| **P1a contracts/domain 第一批** | 新建 `crates/zinecv-contracts`（`domain.rs` 全部 76 个导出类型 + `AppError` 全实现 + `canonical_hash`）与 `crates/zinecv-domain`（`DocumentContext`、`validate_*`、`default_resume_document` 及其测试）；`src-tauri/src/domain.rs` 变纯再出口垫片；`with-msvc.ps1` 的 bindings/check/test/fmt 覆盖新 crate | cargo check/test（src-tauri + 两 crate）全绿；clippy `-D warnings` 全绿；绑定逐字节零漂移 | ✅ 2026-10-06 |
| **P1b contracts 第二批** | `migration.rs` 25 个 + `storage.rs` 5 个导出类型并入 `zinecv-contracts`（`LegacyMigrationCounts::add_assign` 随迁转 pub；两文件改为再出口垫片并清理失效 serde/TS 导入）；`with-msvc.ps1` bindings 任务收敛为 contracts 单出口 | 同上；绑定仍 106 个零漂移；migration/storage 瘦身约 420 行 | ✅ 2026-10-06 |
| **P2 engine 抽取** | `engine.rs` + `engine/*` + `templates.typ`（3,948 行）→ `crates/zinecv-engine`；glob 再出口垫片；`FONT_*` 静态转 pub；`impl From<EngineError> for AppError` 因孤儿规则迁入 engine crate；storage 资源指纹 include 改指新位置；fixture 工具模板路径更新并重生成清单；src-tauri 移除 tiny-skia/ttf-parser/unicode-bidi | clippy `-D warnings` 四 crate 绿；304 测试守恒（149+109+9+37）；绑定零漂移；**engine-parity geometry_and_text_passed、visual-parity pass**（dist 按清理指令重建后复删）；release 收据双份落档 | ✅ 2026-10-07 |
| **P3a storage 首批（migration）** | `migration.rs`（3,734 行）→ `crates/zinecv-storage`，子代理纯转写 + 机械 diff 逐字验证（仅 2 处 `crate::domain::`→`zinecv_*::` 路径替换）；`supported_image_bytes` pub(crate)→pub；storage crate 依赖 contracts+domain+rusqlite | clippy 五 crate 绿；304 测试守恒（139+109+9+37+10）；绑定零漂移 | ✅ 2026-10-07 |
| **P3b storage 主体（Store）** | storage/identity/migration 全部迁入 `zinecv-storage`；SecretProvider 注入，Windows DPAPI 放入 `zinecv-native`；恢复暂存库继承秘密能力；hooks 同时验证宿主与 storage | 306 原生测试、106 绑定零漂移；备份/恢复/迁移/事务中断 WebView2 通过 | ✅ 2026-10-07 Windows 收口 |
| **P4 agent 抽取** | agent/context/gateway 迁入 `zinecv-agent`；AgentTransport 注入、NativeTransport 保留 HTTP/SSE；移除 crate 的 Tauri 测试依赖，Web fetch 实现留 P6 | 原生策略及注入测试、Agent UI 与提案资源 WebView2 通过 | ✅ 2026-10-07 Windows 收口 |
| **P5 host 瘦身** | 宿主保留 56 IPC、窗口/原生能力装配、render_worker/scheduler、export_io、font_protocol；核心模块再出口，无 storage/agent 重复实现。PlatformCapabilities 随实际 P6 消费方引入 | full 34 个阶段分批通过，视觉两视口 0px；不代表全平台验收 | ✅ 2026-10-07 Windows 收口 |
| **P6 Web 腿** | 同步 JS 桥 POC 已通过；产品使用 SQLite 编进 WASM + Rust OPFS VFS，复用同一 Store。WASM facade、Typst、Web fetch、WebCrypto、Worker/PWA 和共享 React 接线已落地 | Windows Chromium 产品行为通过；Native/WASM 9 组 Gate A/B、两组 Fit 和同平台 PDF 复现通过；备份互通与最新完整 Windows 回归见本轮报告 | ✅ 实现与本机门禁；浏览器全兼容性未验 |
| **P7 鸿蒙腿** | OpenHarmony 公共 native SDK 6.0.0.47 Beta1/API20，ARM64 原生 Store/Typst + NAPI 注册 .so 已交叉编译；Windows 探针 1 项通过 | 原生编译淘汰判据已闭合；完整 ArkTS/ArkWeb Host、平台安全存储/网络、HAP 与真机运行未完成，需要官方完整工具链和设备 | 🔶 核心 POC 完成；宿主未完成 |
| **P8 移动端 + 门禁扩展** | Windows 可运行的 Native/WASM 结构、栅格、备份互通门禁已新增。Android 缺 SDK/NDK/JDK17+（安装与 SDK 协议授权待答复）；iOS/macOS 构建需要 Apple 工具链 | 移动真机基准独立冻结，不沿用桌面数字 | 🔶 共享门禁落地；移动编译/设备待条件 |

依赖约束：P2 依赖 P1（engine 消费 contracts 类型）；P3 依赖 P1b（版本图 DTO 进 contracts）；P6/P7 依赖 P3/P4 的 trait 化。P1→P5 每步桌面 RC 保持可用，任何一步可独立暂停。

## 回滚方式

每个阶段全部为未提交工作树改动（提交需用户授权）；回滚 = `git checkout -- <涉及路径>`（crates/ 新目录直接删除）。绑定 SHA 清单是"抽取未改变 serde 形状"的机器判据，任何漂移立即停下排查而不是更新清单。

## 会话记录

| 日期 | 会话 | 完成内容 | 证据 |
| --- | --- | --- | --- |
| 2026-10-06 | C+ 落地启动 | P0 + P1a：决策记录、本计划、`crates/zinecv-contracts`（76 类型 + AppError + canonical_hash）、`crates/zinecv-domain`（DocumentContext/校验/默认文档）、`src-tauri/src/domain.rs` 纯垫片、`with-msvc.ps1` bindings/check/test/fmt 扩展 | 见下方本轮验证记录 |

### 2026-10-06 本轮验证记录（P0+P1a）

- GitNexus 影响分析先行：`default_resume_document`/`canonical_hash` 上游 51 调用点（CRITICAL）——以再出口垫片保持调用方零改动，并以全量原生测试兜底（见铁律 3）。
- 三 crate 编译、`cargo fmt`、clippy `-D warnings` 全绿；全量测试 **304 项（src-tauri 216 + contracts 79 = 76 导出+3 单元，+ domain 9）与抽取前总数精确守恒、零失败**。
- **绑定零漂移**：106 个 ts-rs 绑定与 SHA 清单逐字节一致；`verify-bindings`（含 tsc 严格编译）通过；`verify:contracts`（52 required + 4 supplemental + poc 契约 + 56 IPC）与 `check:ts` 全绿。
- 三分析工具刷新：ast-grep 结构命中 43/16/1 与基线一致；GitNexus 重索引 8,684 节点/24,058 边/712 流程；Archify 现架构图候选重新校验 9/9 artifact checks、0 issue。
- **抽取中发现并修复**：跨 crate 后 ts-rs 的相对导入由 `diff_paths(dep输出路径, 导入方父目录)` 计算，两侧基准目录不一致（各自 crate cwd 下的相对 `./bindings` 且含 `..`）会把 `./X` 算成多级上跳的错误路径（实际漂移 6 个绑定）。修复 = 两个 crate 的 export_bindings 测试共用同一**绝对** `TS_RS_EXPORT_DIR` 基准，落点在 `with-msvc.ps1`（与 CARGO_TARGET_DIR 同一设置点）；contracts 的 `export_to` 保持与抽取前逐字一致；根 `.cargo/config.toml` 不变。**因此绑定导出必须经 with-msvc 入口，裸 `cargo test` 的再生成会写坏跨 crate 导入路径。**

## P3b 原执行设计（2026-10-07 历史方案，现已落地，以后文结果为准）

搬迁对象（六个文件 ≈15.5k 行，沿用"子代理纯转写 + 机械 diff 逐字验证 + 全量门禁"的 P3a 模式）：`storage/proposals.rs`、`storage/migrations.rs`、`storage/legacy_identity.rs`、`storage/resources.rs`、`storage/tests.rs`、`storage.rs`（最后迁，改垫片）。

先落四处 seam（机械搬迁之前完成，各自独立可验证）：

1. **`normalize_email`**（identity.rs:139，纯字符串校验，返回 `StorageError`）→ 迁入 `zinecv-storage`（身份规范化属迁移/账户语义）；identity.rs 宿主侧改走 `crate::storage::` 垫片路径。
2. **`chat_endpoint`**（gateway.rs:99，`url` 解析纯函数，含回环地址校验）→ 迁入 `zinecv-contracts`（加 `url = "=2.5.8"` 依赖），gateway 与 storage 双侧消费；安全校验逻辑必须单源。
3. **DPAPI 秘密探针**（identity.rs:25 `unavailable_secret_count_from`，Windows 专属）：zinecv-storage 的备份/恢复 API 增加 `impl Fn(&[u8]) -> bool` 探针参数，lib.rs 注入 `dpapi_unprotect` 包装——对齐 C+ §9 SecretProvider 方向，避免 Windows 依赖进入 storage crate。
4. **`FONT_*` 字节常量**（resources.rs 资源指纹用）：zinecv-storage 暂依赖 zinecv-engine 仅取三个静态常量（文档化的边界妥协；WebStore 路径不含 rusqlite/resources，不受影响）。备选：engine_identities() 上移宿主注入（零签名改动vs依赖方向，执行时定）。

另需核对：`test-hooks` feature（publication_test_hook 随 storage.rs 迁入，storage crate 加同名 feature，`with-msvc.ps1` hooks-test 同步双 crate 开启）；迁移完成后 304 测试计数守恒、绑定零漂移、`build:native-hooks` 收据流程复验。

### 2026-10-07 会话：P2 完成 + P3a + P6 里程碑 1（用户令"完成后续的所有任务"）

- **P2 engine 抽取完成**：3,948 行（engine.rs 1,123 + 五个子模块 + templates.typ 336）迁入 `crates/zinecv-engine`。调整清单：字体/模板 include 路径 +1 级；`FONT_*` 静态 pub(crate)→pub（宿主资源清单/协议共享）；`#![recursion_limit="512"]` 随 layout_json 的 json! 宏迁入；`impl From<EngineError> for AppError` 因两侧类型均成外部类型触发孤儿规则，迁入 engine crate（语义逐字保持）；storage/resources.rs 的引擎来源指纹 include 改指新 crate（identity 仅动态比较，无锁值测试）；fixture 工具模板路径更新并 `--write` 重生成清单。src-tauri 移除 tiny-skia/ttf-parser/unicode-bidi（typst 系保留给受保护示例与 worker 的 Bytes/Datetime）。**gate 全绿**：clippy 四 crate、304 守恒（149+109+9+37）、绑定零漂移、engine-parity geometry_and_text_passed、visual-parity pass（两工具均服务预构建 dist，按清理指令重建后复删——非回归）。release 收据双份（build:engine-poc + build:engine-render，25m58s）。
- **P3a migration 迁入完成**：3,734 行，子代理纯转写 + 机械 diff 逐字验证（仅 2 处 `crate::domain::`→`zinecv_*::`，其中 `DocumentContext`/`default_resume_document` 属 zinecv-domain）；`supported_image_bytes` pub(crate)→pub。**gate 全绿**：clippy 五 crate、304 守恒（139+109+9+37+10）、绑定零漂移。
- **P6 里程碑 1 达成**：`rustup target wasm32-unknown-unknown` 就绪；`zinecv-contracts` 与 `zinecv-domain` 编译通过。唯一阻塞点 = getrandom 0.3（AppError 诊断 ID 的 CSPRNG）：需 contracts 新增 `wasm` 特性（`getrandom/wasm_js`）+ `.cargo/config.toml` 目标级 `--cfg getrandom_backend="wasm_js"` 双启用（仅特性开关不够，实测确认）。native 构建不受影响。
- **诚实边界**：P3b/P4 未执行（设计已备好见上节；P4 硬依赖 P3b 的 Store）；P7（OHOS SDK）与 P8（iOS/Android 工具链）不在本机，淘汰判据计时未开始；release 构建有一条 zinecv-desktop lib warning（dev clippy -D warnings 全绿，内容待下会话探查）。
- 未提交，等用户授权。

### 2026-10-06 本轮验证记录（P1b）

- 全量测试 **304 项精确守恒（src-tauri 186 + contracts 109 = 106 导出 + 3 单元 + domain 9）**，零失败；clippy `-D warnings` 三 crate 全绿。
- 绑定 106 个由 contracts 单源生成、**逐字节零漂移**（`verify-bindings` 含 tsc 严格编译通过）；`verify:contracts` 与 `check:ts` 全绿；ast-grep 43/16/1 与基线一致；GitNexus 重索引 8,828 节点/24,009 边/712 流程。
- 新增一条迁移判据：**ts-rs 会把 Rust `///` 文档注释转成绑定里的 `/** */`**——搬家时降级为普通注释即产生漂移（`VersionCommitDetailed` 实际发生并已归零恢复）。P1b 抽取清单以此实现"逐字节一致"验收。
- migration.rs 测试模块中的绑定冒烟测试（`export_to_string` 遍历）随再出口继续生效，仅需在测试模块内补 `use ts_rs::TS;`。

### 2026-10-07 续作：Windows P3b/P4/P5 收口与轻量化

基线 HEAD `ce15ff1d61e34cfcb79674f34f30b4cf3af307b6` 已包含 storage/agent 的机械迁移；本轮完成能力接口、宿主装配、测试及文档对齐，而非再次搬迁。SecretProvider 放在 contracts，Windows DPAPI 实现放在 native crate；Store 与恢复暂存库注入能力，缺能力时不伪装安全存储。AgentTransport 隔离策略和传输，原 HTTP/SSE 网络安全逻辑保留，Web fetch 尚未实现。旧设计中的 chat_endpoint 实际已位于 contracts，资源指纹/FONT 常量仍由 storage 消费 engine（记录此边界妥协）。

Windows full 34 个阶段分批通过，原生 306、hooks 宿主 27 + storage 107、绑定 106 零漂移、单元 59、界面 18；视觉两视口 0px、引擎 9/9 结构/文本/几何通过，人工引擎视觉复核仍待完成。原始失败（矩阵旧路径、缺 dist、新增测试辅助函数名称冲突）及修复后的通过记录均保留，不冒充一次全过。完整证据映射为 `.artifacts/remaining/cplus-20261007/stage-coverage.json`，报告为同目录 `REPORT.md`。

构建收据覆盖 crates 源/manifest/lock；hooks 检查同时覆盖 storage；矩阵仅 19 处实现路径同步，状态仍 9/45/2；license inventory 来源路径修正。快速 shell 测试改用现有源码 fixture，删除 dist 后 18/18 通过，没有新增用户浏览器运行入口。

target/dist、可重建解析缓存与本轮临时 helper 按清单清理；桌面独立 `src-tauri` 仅有 106 份 hash-identical 生成绑定，已移除。源码、依赖、有效证据、用户数据与四份保护文档保留。采用回收站删除，最终体积见 `cleanup-after.json`。Archify/ast-grep/GitNexus 更新到实际 Windows 架构，详细工具收据见报告。

**P6–P8 仍未完成**：按本轮用户要求不测试 Windows 以外的平台。同步桥与引擎 WASM 的路线先取决于定案 POC 判据；OHOS SDK、移动工具链/真机及跨端门禁尚未闭合。前会话 WASM 记录仅作为历史记录，不能扩展为本轮验证。四份保护文档不改，本轮未提交、未推送、未发布。

### 2026-10-08 续作：Windows 可完成的 Browser 与 OHOS 核心

用户范围调整为完成本机 Windows 可执行的剩余工作，因此 Browser/WASM 与 OHOS 交叉编译纳入本轮。产品存储选择定案附件①允许的“SQLite 编进 WASM + Rust VFS”路线，避免另写一份 TS 事务/版本/迁移业务。官方 SQLite 同步 JS 桥 POC 仍保留为路线证据，不混作产品 Store。

Browser 已覆盖编辑持久化/刷新、版本提交、PDF 导出、WebCrypto 不可导出密钥与密文 SQLite、同源密钥恢复与异源拒绝、单写者 Web Lock、Provider 模型列表/结构化探针/持久 Agent、离线 PWA，以及超过初始 16 槽的连续恢复。恢复前既有 Rust SQLite 快照，也有共享 UI 触发的 Backup JSON 下载，后者经真实按钮验证。Provider 使用隔离本地 mock，不代表真实模型验收。

Native/WASM Gate A/B 的 9 组页数、正文/TextMap/HitRegion/几何及 raster 对照通过，栅格差异 0；两端重复 PDF 各自 hash 可复现，跨端 PDF hash 本次也相同（跨端 hash 仍只作诊断）。空白 fixture 的空标题不满足公共文档入口校验，测试副本补合法标题并记录原始/输入 hash，原文件不改。Fit 对照覆盖 alreadyFits 与 noFit，不夸大为所有 solver 状态均验证。

最新原生七 crate 检查与 309 项测试通过（26+109+9+37+110+18）；OHOS Windows 探针另 1 项，不把历史/示例计数混入该数。当前 full 34 阶段验证、备份双向互通与最终清理结果由 `.artifacts/remaining/windows-capable-20261007/REPORT.md` 记录。

OHOS .so 含 NAPI 构造注册，链接 ace_napi.z 与 libc；这只证明公共 SDK 原生编译路线，不证明商业 HarmonyOS SDK、ArkTS Host、HAP 或真机运行。Android SDK 协议授权与 HarmonyOS 官方完整工具链路径已询问用户，未收到回复时不伪记安装/通过。四份保护文档未修改；矩阵状态仍 9/45/2，未提交、推送、发布。

### 2026-10-09 当前执行范围与完成条件

用户后续明确排除 Linux、Android、Harmony/OHOS、Apple 和先前移出事项，本轮继续 Windows 与本机 Browser/WASM；不再等待移动工具链答复，也不重复 OHOS POC。完成条件为：逐条复核全部 56 行的本轮 Windows 可执行要求；冻结最新源的 full 34；Browser/WASM 与原生互通；真实三轮 standard 和独立三轮 extended 内存测量；本机交付包核验；文档/Archify/AST-grep/GitNexus 同步；最终产物与临时文件清理。

目前已完成的修复、专项结果与仍待验证项见现状切片 §12 和 `.artifacts/remaining/closure-optimization-20261008/STATE.md`。正式程序的 12 组多页完整正文检查通过；最终引擎颜色专项两组通过，不能替代九组与 full。内存首批第三轮导出超时，保留失败并重测，不记为优化达标。旧全量、旧平台对照和旧清理数据只能说明对应历史修订。

2026-10-09 19:09 本轮续验：无序列表标记基线修复及新增1 CSS px门禁九组通过（文字最大0.667，圆点最大1），原图片负例九组均拒绝6–7px偏移；正式版/hooks构建成功。智能一页重复幂等、晚返回保护及最终真实10秒超时后完整排版/正文保护均有通过复验；最后故障夹具使用11500ms延迟，不变更Fit生产10秒或PDF/Preview/Export生产90秒预算。当前进入重新冻结full34、Browser/WASM11、standard/extended RAM、Windows包；56行Windows范围逐条复核、RAM改善结论、包内容、最终文档同步与清理仍待。不把历史29/34或局部通过升级整体通过，不设置任何定时任务。

2026-10-09 20:00 续验：`unified-3` 在相同源码前后摘要下完成 **31/34**，失败为两份模板哈希清单未更新及生产故障测试过早取启动修订号。清单仅同步当前模板 SHA/字节数，许可状态不变，两检查通过；测试改等首次草稿真正保存完成，生产和超时预算不变，正式版两次导出与同一 PDF 哈希复验通过。已启动 `unified-4` 一次性后台验收，冻结摘要 `456cd3784f3652efe3e065c2df5b623e8ff50608e4ed8d4a8aa0fc9bd8467bb0`，完成后仍须逐条功能复核、RAM趋势判定、包内容检查与清理。旧失败和本次专项证据保留，不拼接为完整通过；没有定时任务或 heartbeat。字体控件值/持久化通过不等于五种字体原生导出全部匹配；该项及已记录的希伯来缺字尚需核对，不宣称全部任务结束。

2026-10-09 21:30 续作：旧 unified-4 同源完整34/34、standard120秒×3、Browser/WASM/11对照实际通过；因发现五字体导出固定宋体，安全停止尚未完成的extended，旧batch保留原字节旁本并准确标为interrupted，不假记长测通过。已补受控本机字体快照/哈希/缓存身份、worker资源配对验证、真实字体选择、Noto Sans Hebrew OFL回退；Browser明确只提供内置宋体，保留原存储字体设置。Engine release 41/41和平台TypeScript通过，正式宿主字体导出仍待复验。
按用户要求优化验收结构：廉价预检前置，完整34/Browser/包先于测量；失败后只做带依赖的诊断重跑，最后保留独立完整full；不删原用例、不放宽阈值、不缩短资格长测。调度器17/17通过，包括未执行标记、失败重跑不冒充full、依赖展开、并发排他及真实耗时统计。此前测量前置仅standard已耗439.447秒，重排可避免在功能失败的批次重复浪费这段时间；成功路径尚无新实测提速结论。新增真实5字体PDF及希伯来检查、Native/WASM第12对照，覆盖增加。
索引初次刷新因本机commit容量耗尽终止，已仅停止本任务进程；GITNEXUS_MEMORY=off、NODE_OPTIONS=--max-old-space-size=512、GITNEXUS_LBUG_BUFFER_POOL_SIZE=134217728下37秒成功刷新9208节点/27121边/365cluster/796flows，截断仍为导航限制。调度器影响LOW，accept入口UNKNOWN由README真实CLI引用确认。随后工具修改需最终再刷新。未改系统分页设置/用户应用，未设置任何定时或heartbeat。
剩余：同步三工具与清单后冻结，正式宿主与hooks构建、五字体实际导出、最终34/Browser12/standard/extended趋势/包内容/56条criteria证据绑定、最终docs与全部target/dist/wasm-bindings清理。本轮未完成，不挪用旧源通过。
