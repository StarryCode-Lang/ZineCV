# C+ 架构落地执行计划（2026-10-06 启动）

依据 `docs/ARCHITECTURE_TARGET_CPLUS.md`（唯一目标架构，已签字定案）。本计划是 C+ 迁移的活动工作文档：每阶段追加会话记录与证据；阶段完成后按惯例把有效事实合并回 `docs/SLICE_20261002.md`。

## 铁律（每个阶段都适用）

1. **Windows RC 全绿**：每一步结束时 `check:native` / `test:native`（304 项）/ `test:bindings`（106 绑定零漂移）/ `verify:contracts` 必须全过；不把局部通过记成整体通过。
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
| **P3b storage 主体（Store）** | `storage.rs` + `storage/*`（≈15.5k 行）迁入；先落四处 seam 设计（见下方"P3b 执行设计"）；agent crate 依赖 Store，故 P4 排在其后 | 同上；hooks 特性流程核对 | ⬜ 设计已备好 |
| **P4 agent 抽取** | `agent.rs`/`agent_context.rs` → `crates/zinecv-agent`；`AgentTransport` trait 化（Native HTTP 桥 / Web fetch 双实现点） | 同上 + Agent webview 套件 | ⬜ 待 P3b |
| **P5 host 瘦身** | src-tauri 现已收敛为：56 IPC + Store 持久层 + identity/gateway/agent + render_worker/scheduler + export_io + font_protocol；P3b/P4 落地后即达 C+ §10 薄壳形态。`PlatformCapabilities` 能力表随 P6 Web 腿引入（有真实消费方再加，避免投机代码） | fast/full 套件全绿 | ⬜ 随 P3b/P4 收敛 |
| **P6 Web 腿（POC 先行）** | **✅ 里程碑 1（2026-10-07）：wasm32-unknown-unknown 工具链就绪，`zinecv-contracts` 与 `zinecv-domain` 编译通过**。唯一阻塞点 = getrandom 0.3 的 AppError 诊断 ID CSPRNG：需 `wasm` 特性 + 目标级 `--cfg getrandom_backend="wasm_js"`（落 `.cargo/config.toml` [target.wasm32-unknown-unknown]，native 构建不受影响）。后续：sqlite3-wasm 同步桥（定案附件②）→ zinecv-wasm facade → WebStore → Typst WASM（typst 0.15 wasm 编译 = 引擎腿淘汰判据实验，需独立长会话） | 同步桥判据有结论；Gate A/B 在 Browser 端跑通 | 🔶 里程碑 1 达成 |
| **P7 鸿蒙腿** | OHOS SDK 不在本机，交叉编译判据（一周）无法开始计时；架构不受影响（rustup OHOS 目标为 Tier 2 with Host Tools，可行性已核实） | 按鸿蒙腿回退梯子 | ⬜ 待 SDK |
| **P8 移动端 + 门禁扩展** | iOS 工具链需 macOS、Android 需 NDK——均不在本机；移动端基准重冻结需真机（定案附件③） | 移动基准独立冻结 | ⬜ 待工具链/真机 |

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

## P3b 执行设计（2026-10-07 已备好，下一会话可直接执行）

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
