# ZineCV 项目约定

默认简体中文，结论与影响在先。按当前任务优化验证结构，解除持久字节冻结，保留既有产品改动和用户数据。只运行必要检查；用户已于2026-10-20授权构建优化及开发环境准备；保留有效开发缓存。近期仅Windows开发，不默认构建WASM/OHOS或移动端。不提交、不推送、不发布。本地提交须用户明确授权。

## 权威来源与保护

- 当前状态：`docs/SLICE_20261002.md`；唯一历史汇总：`docs/HISTORY_202610.md`（延后验收为`#qualification`）；剩余任务：`plan.md`。不再追加逐次流水账。
- C+决策与阶段设计：`docs/ARCHITECTURE_TARGET_CPLUS.md`、`docs/EXECUTION_PLAN_20261006-cplus.md`。四份原依据已于2026-10-20解冻，可以修改：`docs/DEVELOPMENT_PLAN.md`、`docs/FEATURE_PARITY.md`、`docs/FEASIBILITY.md`、`docs/target.archify.json`。它们不是当前通过状态，改它们不等于验收升级。
- 机器矩阵`docs/feature-parity.json`以schemaVersion 2的contexts/features存储，统一用`tools/acceptance-matrix.mjs`展开/写回；为52 required+4 supplemental，当前7 passed/45 pending/2 in_progress/2 blocked。局部套件、历史full与当前整行acceptance严格区分，不自动升级。真人、VM、签名、真实模型、许可与第二执行者由用户另行验收，本轮不执行，不假记通过。
- 保留源码、锁文件、夹具逻辑、许可原文、`docs/evidence/` 受控记录、发布副本和用户数据。用户已要求删除历史压缩归档，相应原始大样本不再保留；清单见 `.artifacts/maintenance/discarded-history-data.json`，旧哈希与历史结论不追改。2026-10-20 另删除本地原始运行目录（remaining、acceptance-runs、verification-runs、runtime-tmp、build-receipts、ui-workbench，以及会把旧通过或旧清单读成当前状态的 analysis/maintenance 文件）。不要重建这些原始运行，不要把缺失路径当成待补的当前资格。
- 合成夹具以 `fixtures/remaining.mjs` 的生成规则为准，`--check` 校验场景结构、ID、图关系与覆盖引用；不保存固定哈希基线。清单摘要只描述当前输入。12文档、1000提交及17个人工场景保留，不落盘全套可生成JSON。
- 绑定、许可、字体参考及历史证据均无持久字节锁。绑定检查结构/类型；许可来源集中 `docs/resource-licenses.json`，差异与缺依赖明确报告，`--write` 输出忽略目录，不与旧报告比字节。字体参考可替换，测试仍比较当前字体传输、纸面几何和像素。历史证据哈希只标识当时输入，不约束当前文件；通过状态仍须有效记录，不自动升级。
- 工作区以可继续开发为目标保留 node_modules、dist 和 debug 缓存；WASM/OHOS/release/hooks 仅按需构建。桌面与共享核心统一根 Cargo.toml/Cargo.lock，WASM/OHOS 保留独立根。`.artifacts/maintenance/volume-cleanup-20261019.json` 只是 2026-10-19 清理后的体积基线，不含 2026-10-20 证据树删除。本地证据索引见 `.artifacts/README.md`。开发先 npm ci；已有有效缓存日后正常保留，显式清理或故障时才删除。GitNexus图库按需重建，保留 `.gitnexus/run.cjs`；不用陈旧索引或空结果推断代码无用。

## 开发、IPC与收据

- 正式React UI在`src/ui`，前端IPC/转换边界在`src/platform`；`src/preview`引擎消费组件及两个原生验证示例仍受门禁保护。绑定由contracts经ts-rs生成；可更新，长期schema变更优先修改Rust来源再生成，避免被后续生成覆盖；新增IPC同步domain枚举、handler、capability、公共契约、绑定五处，56 IPC保持一致。
- 后续日常完整桌面用`npm run dev`，Vite仅由Tauri内部启动，不保留独立浏览器预览脚本。小改目标五分钟：CSS用`dev:css`/`check:css`，React用dev热更新。CSS工作台隔离数据并核对宿主收据，非CSS输入变化拒绝复用，不冒充新发布exe或完整资格。见`docs/DEVELOPMENT_FEEDBACK.md`。
- 不因UI小改自动build:native/打包/full；显式更新独立exe或原生确有必要才构建。冷release约39分钟、hooks约47分钟，fat LTO/长测不承诺五分钟。原生操作经`tools/with-msvc.ps1`；构建期间不得修改仓库任何文件，否则输入收据拒绝。收据覆盖crates/Vite/锁文件/编译器，缺失或不匹配不能假复用。
- ts-rs共享绝对`TS_RS_EXPORT_DIR`，裸cargo生成可能写错跨crate相对导入；保留Rust文档注释，核真实退出码。worker可执行路径保持已验证安全形状，测试注入须真实触发Job Object限制。
- 数据/WebView2测试隔离profile与SQLite，禁止用真实库；备份JSON含密文但本身未加密，不能公开。迁移前备份，高schema旧版拒开，回退用兼容DB；worker归属按profile+PID确认，保留KILL_ON_JOB_CLOSE。
- WASM需外部LLVM与匹配wasm-bindgen；历史位置`D:\tmp\llvm`、`~/.cargo/bin/wasm-bindgen.exe`，明确CC_wasm32_unknown_unknown/AR_wasm32_unknown_unknown/ZINECV_WASM_BINDGEN；旧Codex默认路径失效。OHOS SDK缺失，POC非完整宿主。Bash的Windows PATH未转换，子进程npm/cargo经PowerShell并恢复原Windows PATH。
- 打包校验解析PE，仅允许COFF及三个调试目录TimeDateStamp与RSDS的16字节GUID变化；其余字节拒绝。原exe先落盘备份，成功/失败均finally还原并核哈希，恢复失败保留备份。结论绑定实际被测exe，不用同源不同哈希替代。

## 最小验证与分析

- 日常`npm run check`五项，不编译原生/启动浏览器；UI用check:ui，Native/Agent/Recovery由`tools/run-checks.ps1 -Scope`按修改选，先`-Plan`。regression15只用正式宿主，不隐式编译debug/hooks/引擎示例。
- 范围以verify-project.mjs单一来源；remaining为旧full34减常用集合得19项，加共享依赖校验。`tools/run-remaining-checks.ps1`默认remaining-only，`-Complete`完整链，`-Plan`只预览；旧run-acceptance已移除。Full34、accept:full16保持兼容，只显式整轮资格时执行，日常不追加。独立15与remaining16不拼成full。
- 原生/WebView2/bench/soak串行、独立数据；禁止并发两个verify-project/accept-project实例。WebView2保留disable-backgrounding等三参数；动画拦截/EPERM先核偶发证据，不据此改产品。quick20秒×1、standard120秒×3、extended30分钟×3；测试worker3秒、生产90秒，--extended保留原预算。用例/阈值/预算不放宽，短测不替长测，行为通过不证明无泄漏。
- ast-grep结构查询、audit:ast只读不重写；删除代码需入口/引用/验证证据。Archify、AST与GitNexus生成物在忽略目录，不引入产品依赖。CLAUDE.md仅链接本文件；技能仅`.agents/skills`。
- GitNexus先查索引新鲜度与上下文/影响，缺库或陈旧先重建。索引是导航；跨语言缺边、流程截断和空结果不能证明无用。具体图规则如下。

<!-- gitnexus:start -->
# GitNexus — Code Intelligence

GitNexus repo name: **ZineCV**. The database is normally removed for size; `.gitnexus/run.cjs` is retained. Rebuild before graph calls, then check freshness. To keep the runner separate from owned index storage on Windows, set `$env:GITNEXUS_STORAGE_PATH = Join-Path (Get-Location) ".artifacts/analysis/gitnexus"` before analyze. The generated index may be removed after analysis to save space. Skills are canonical under `.agents/skills`.

> Index stale? Run `node .gitnexus/run.cjs analyze --index-only` from the project root — it auto-selects an available runner. No `.gitnexus/run.cjs` yet? Bootstrap with `npx`, `bunx`, or `pnpm dlx` — e.g. `bunx gitnexus@latest analyze` (npm 11 npx crash; #1939).

## Always Do

- **MUST run impact before editing.** Use `impact({target: "symbolName", direction: "upstream"})` or `node .gitnexus/run.cjs impact "symbolName" --direction upstream --repo .`; report callers, processes, and risk. Never substitute grep for graph analysis.
- **MUST analyze graph changes before committing.** Use `detect_changes({scope: "all"})` (MCP) or `node .gitnexus/run.cjs detect-changes --scope all --repo .` (CLI fallback). `partial: true` or `truncated: true` is not a clean check — a zero means unseen, not unaffected; re-run it. For regression review: `detect_changes({scope: "compare", base_ref: "main"})` or `node .gitnexus/run.cjs detect-changes --scope compare --base-ref "main" --repo .`.
- MUST warn on HIGH/CRITICAL `risk` pre-edit; never use `riskSharedAxes` to waive a HIGH/CRITICAL `risk` warning. Compare File/symbol: MCP File omits axes; Graph-RAG expands File.
- **MUST treat `risk: UNKNOWN` as unresolved, not as low.** An empty caller set is not evidence the symbol is unused — it can also mean the callers are not resolvable by the index (plain-object property access, dynamic dispatch, cross-language calls). `impact` pairs `UNKNOWN` with a `riskNote` saying so. Confirm with a text search before treating the symbol as safe to change or delete; do not proceed on the strength of a zero.
- **MUST use `query({search_query: "concept"})` for concepts/flows, `context({name: "symbolName"})` for a named symbol, or `impact` for blast radius, on read-only callers, dependencies, imports, or execution flow.** Graph first; text search only for empty/`UNKNOWN`/literals.
- For security review, `explain({target: "fileOrSymbol"})` lists taint findings (source→sink flows; needs `analyze --pdg`).

## Never Do

- NEVER edit a function, class, or method before MCP/CLI impact analysis.
- NEVER ignore HIGH or CRITICAL risk warnings from impact analysis, and never read `UNKNOWN` as an all-clear — it means the walk could not answer, which is the one verdict that requires confirming by other means.
- NEVER rename symbols with find-and-replace — use `rename` which understands the call graph.
- NEVER commit before MCP/CLI graph change analysis.

## Resources

| Resource | Use for |
| --- | --- |
| `gitnexus://repo/ZineCV/context` | Codebase overview, check index freshness |
| `gitnexus://repo/ZineCV/clusters` | All functional areas |
| `gitnexus://repo/ZineCV/processes` | All execution flows |
| `gitnexus://repo/ZineCV/process/{name}` | Step-by-step execution trace |

## CLI

| Task | Read this skill file |
| --- | --- |
| Understand architecture / "How does X work?" | `.agents/skills/gitnexus-exploring/SKILL.md` |
| Blast radius / "What breaks if I change X?" | `.agents/skills/gitnexus-impact-analysis/SKILL.md` |
| Trace bugs / "Why is X failing?" | `.agents/skills/gitnexus-debugging/SKILL.md` |
| Rename / extract / split / refactor | `.agents/skills/gitnexus-refactoring/SKILL.md` |
| Tools, resources, schema reference | `.agents/skills/gitnexus-guide/SKILL.md` |
| Index, status, clean, wiki CLI commands | `.agents/skills/gitnexus-cli/SKILL.md` |

<!-- gitnexus:end -->
