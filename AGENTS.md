# ZineCV 项目约定

默认简体中文，结论与影响在先。只处理当前授权范围，运行必要检查；近期以 Windows 开发为主，不默认构建 WASM/OHOS 或移动端。不因文档维护调整产品版本或发布。

## 权威来源与保护

- 当前状态见 `docs/SLICE_20261002.md`，当前任务只维护在 `plan.md`，历史集中 `docs/HISTORY_202610.md`。旧会话、忽略目录和历史通过仅作线索，不恢复旧待办，不自动升级资格。人工测试由用户自行管理，见 `docs/FEATURE_PARITY.md#scope-notes`。
- 架构见 `docs/ARCHITECTURE_TARGET_CPLUS.md`，开发与验证入口见 `docs/DEVELOPMENT_FEEDBACK.md`，IPC 见 `docs/public-ipc-contract-v1.md`。旧阶段文档仅保留必要兼容入口，不重复维护状态。
- `docs/feature-parity.json` 为 schemaVersion 2，含52 required + 4 supplemental；统一用 `tools/acceptance-matrix.mjs` 展开和写回。保留场景 ID、历史状态及有效证据，局部检查不等于完整资格。
- 保留源码、锁文件、用户数据、许可原文、受控 `docs/evidence/`、发布副本及有效 node_modules/dist/debug 开发缓存；发布/专项构建缓存按需保留。删除过的历史原始大样本和运行目录不重建，不将缺失历史路径视为当前任务。绑定、字体、许可和历史证据没有持久字节冻结；历史哈希只标识当时输入。
- 夹具以 `fixtures/remaining.mjs` 生成规则为准，`--check` 校验结构、ID、图关系及覆盖引用；保留12文档、1000提交和17场景索引，不落盘全套可生成 JSON。许可来源集中 `docs/resource-licenses.json`，生成报告写忽略目录。
- 每个任务同步相关文档、完成必要检查并清理自有临时文件，保留其他 Agent 未确认的改动；不另建重复状态清单。提交、推送和发布遵循当次用户授权。

## 开发与安全边界

- 正式 UI 在 `src/ui`，IPC/转换边界在 `src/platform`；`src/preview` 与原生验证示例保留门禁。Rust contracts 为 schema 来源，经 ts-rs 生成绑定；共享绝对 `TS_RS_EXPORT_DIR`，核真实退出码并保留 Rust 文档注释。新增 IPC 同步 domain、handler、capability、公共契约、绑定，保持62 IPC一致。
- 完整桌面用 `npm run dev`，Vite 由 Tauri 内部启动；CSS 用 `dev:css`/`check:css`，React 热更新。CSS 工作台隔离数据、核宿主收据，非 CSS 输入变化拒绝复用，不冒充新 EXE。已有有效依赖不重复安装或清空。
- 原生操作经 `tools/with-msvc.ps1`；仅明确需要独立 EXE 或原生变更时构建，构建期间不改仓库输入。收据须匹配实际源码、工具链及产物。打包 PE 校验只允许既定时间戳及 RSDS GUID 变化；原 EXE 先备份，finally 还原核哈希，恢复失败保留备份。
- 数据/WebView2 测试隔离 profile 与 SQLite，禁止用真实库；备份 JSON 本身未加密，不公开。迁移前备份，高 schema 旧版拒开，回退用兼容 DB。worker 按 profile+PID 确认归属，保留 Job Object 的 KILL_ON_JOB_CLOSE 与真实资源限制。
- 桌面/共享核心统一根 Cargo workspace，WASM/OHOS 独立根；WASM 需匹配 LLVM/wasm-bindgen，显式配置工具路径。OHOS POC 不等于完整宿主。Windows 子进程经 PowerShell 保留原 Windows PATH。

## 最小验证与分析

- 日常 `npm run check` 不编译原生或启动浏览器；按改动选择 UI/Native/Agent/Recovery，先用 `tools/run-checks.ps1 -Plan` 看范围。唯一阶段表在 `tools/verify-project.mjs`；完整资格链仅显式需要时运行，不拼接独立结果冒充 full。
- 手写代码按职责组织，通常保持单文件低于1000行，不压缩排版凑行数。单元入口自动发现6个职责测试文件；普通浏览器共享进程、独立 BrowserContext；原生/WebView2/bench/soak 串行且独立数据，禁止并发两个 verify-project/accept-project。保留 WebView2 三个防后台参数。quick 20秒×1、standard 120秒×3、extended 30分钟×3；测试 worker 3秒、生产90秒。不得放宽阈值/预算，短测不替长测，行为通过不证明无泄漏。
- ast-grep/audit:ast 只读不重写，删除代码须入口、引用及验证证据。结构、依赖或引用变化同步相关 Archify、AST、GitNexus 分析；生成物在忽略目录，不引入产品依赖。CLAUDE.md 只链接本文件，技能在 `.agents/skills`。
- GitNexus 先核新鲜度，陈旧或缺库先重建。索引只作导航，空结果、跨语言缺边或截断不能证明代码无用。图库按需清理，保留 `.gitnexus/run.cjs`。

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
