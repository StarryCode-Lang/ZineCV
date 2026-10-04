# ZineCV 项目约定

默认使用简体中文。当前唯一权威切片为 `docs/SLICE_20261002.md`（现状、构建、陷阱、缺口与下一步入口；§16 为 2026-10-03/04 审核与修复记录）；剩余工作详细计划为 `docs/EXECUTION_PLAN_20261004-remaining.md`；最近一次任务的全过程记录为 `docs/TASK_20261004-audit-parity-performance.md`（全面审核 + 修复 + 终验，证据在 `.artifacts/remaining/audit-plan-20261003/run-exec-20261003/`）；上一轮轻量化记录为 `docs/TASK_20261003-lightweight.md`；52 行验收矩阵为 `docs/feature-parity.json`（`npm run verify:contracts` 强校验，`node tools/audit-parity.mjs` 只读审计），证据在 `.artifacts/remaining/` 矩阵引用的文件。不要把局部检查通过升级为任务整体通过。

## 保护边界

- 不推送、不发布；本地提交需要用户明确授权。保留已有工作区改动和用户数据。
- 构建产物按大版本保留一代：同一版本内复用缓存；开始下一个大版本前，盘点并清理上一代可重建的 `src-tauri/target`、`dist`、`.artifacts/webview-e2e` 和运行缓存，再只构建新版本。保留源码、依赖锁文件、测试夹具、验收证据（尤其 `.artifacts/remaining`）、当前架构分析与用户数据；不为日常构建反复清空缓存。**2026-10-03 轻量化后的当前状态**：`src-tauri/target/` 只保留 `release` 一代（exe + PDB + NSIS 安装包），测试档 `debug` 与 `hooks` 已剪枝，重建代价分别约 7 分钟（`npm run test:native`）与 6 分钟（`npm run build:native-hooks`，依赖 hooks 档的 4 个 WebView2 套件需先构建）。
- 四份主要文档不修改：`docs/DEVELOPMENT_PLAN.md`、`docs/FEATURE_PARITY.md`、`docs/FEASIBILITY.md`、`docs/target.archify.json`。
- 真实模型、真人验收、VM、签名和字体许可缺失时准确记录受影响项。
- `src/ui` 是当前正式 React UI；`src/platform` 是前端 IPC 与数据转换边界。原生验证通过 `tools/with-msvc.ps1`，数据与 WebView2 测试使用隔离配置；WebView2 测试串行运行。
- 日常启动完整桌面应用统一使用 `npm run dev`（自动准备 MSVC 并启动 Tauri）；Vite 仅由 Tauri 内部启动，不保留单独的浏览器预览脚本。

## 分析工具

- GitNexus 当前仓库名为 `zinecv-desktop`。涉及调用关系的修改先检查索引新鲜度，再查询符号上下文及影响；索引陈旧时更新。索引只提供导航证据，跨语言未关联、流程截断和空结果均不能证明代码无用。
- ast-grep 用于结构查询；`npm run audit:ast` 只读，不自动重写。删除旧代码仍需实际入口、引用和验证证据。
- 分析缓存与生成 HTML 保存在忽略目录，不能混入产品运行依赖。`CLAUDE.md` 如需提供兼容入口，仅链接本文件。

<!-- gitnexus:start -->
# GitNexus — Code Intelligence

This project is indexed by GitNexus as **zinecv-desktop** (7763 symbols, 22652 relationships, 673 execution flows).

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
| `gitnexus://repo/zinecv-desktop/context` | Codebase overview, check index freshness |
| `gitnexus://repo/zinecv-desktop/clusters` | All functional areas |
| `gitnexus://repo/zinecv-desktop/processes` | All execution flows |
| `gitnexus://repo/zinecv-desktop/process/{name}` | Step-by-step execution trace |

## CLI

| Task | Read this skill file |
| --- | --- |
| Understand architecture / "How does X work?" | `.claude/skills/gitnexus-exploring/SKILL.md` |
| Blast radius / "What breaks if I change X?" | `.claude/skills/gitnexus-impact-analysis/SKILL.md` |
| Trace bugs / "Why is X failing?" | `.claude/skills/gitnexus-debugging/SKILL.md` |
| Rename / extract / split / refactor | `.claude/skills/gitnexus-refactoring/SKILL.md` |
| Tools, resources, schema reference | `.claude/skills/gitnexus-guide/SKILL.md` |
| Index, status, clean, wiki CLI commands | `.claude/skills/gitnexus-cli/SKILL.md` |

<!-- gitnexus:end -->
