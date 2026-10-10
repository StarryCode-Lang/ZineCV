# ZineCV 项目约定

默认使用简体中文。唯一权威现状切片为 `docs/SLICE_20261002.md`（最新2026-10-08）；C+ 全平台目标架构（已签字定案）的唯一决策记录为 `docs/ARCHITECTURE_TARGET_CPLUS.md`，分阶段落地计划为 `docs/EXECUTION_PLAN_20261006-cplus.md`；历史plan/TASK有效事实已合并。56行机器矩阵为 `docs/feature-parity.json`（52 required+4 supplemental），本轮详细记录与证据为 `.artifacts/remaining/windows-capable-20261007/REPORT.md`，上一轮 Windows 收口为 `.artifacts/remaining/cplus-20261007/REPORT.md`。不要把局部通过升级为整体通过。

## 保护边界

- 不推送、不发布；本地提交需要用户明确授权。保留已有工作区改动和用户数据。构建产物按用户指示不保留（target/dist 全删，可由文档化命令重建）；构建收据随构建自动重建。保留源码、锁文件、fixture、许可、有效验收证据、当前分析与用户数据。首次原生源码编译需重建依赖（实测 release ≈39 分钟、hooks ≈47 分钟），构建运行期间不得改动仓库任何文件（收据会拒绝）。
- 四份主要文档不修改：`docs/DEVELOPMENT_PLAN.md`、`docs/FEATURE_PARITY.md`、`docs/FEASIBILITY.md`、`docs/target.archify.json`。
- 真人验收由用户自行完成。VM、签名、真实模型、字体许可与第二执行者已按用户指示移出本轮；仍准确记录未证事实，不假记通过。
- `src/ui` 是当前正式 React UI；`src/platform` 是前端 IPC 与数据转换边界。原生验证通过 `tools/with-msvc.ps1`，数据与 WebView2 测试使用隔离配置；WebView2 测试串行运行。
- 日常启动完整桌面应用统一使用 `npm run dev`（自动准备 MSVC 并启动 Tauri）；Vite 仅由 Tauri 内部启动，不保留单独的浏览器预览脚本。

## 回归与测量

- fast/regression为部分检查，full保留完整34阶段；原生/WebView2/bench/soak串行，独立数据。
- 测量默认 quick 20秒×1，standard 120秒×3，extended 30分钟×3为独立长测；短测不冒充长时验收。
- 测试档worker默认3秒超时预算，生产90秒不变；`--extended`保留原预算专项。

## 分析工具

- GitNexus 当前仓库名为 `zinecv-desktop`。涉及调用关系的修改先检查索引新鲜度，再查询符号上下文及影响；索引陈旧时更新。索引只提供导航证据，跨语言未关联、流程截断和空结果均不能证明代码无用。
- ast-grep 用于结构查询；`npm run audit:ast` 只读，不自动重写。删除旧代码仍需实际入口、引用和验证证据。
- 分析缓存与生成 HTML 保存在忽略目录，不能混入产品运行依赖。`CLAUDE.md` 如需提供兼容入口，仅链接本文件。

<!-- gitnexus:start -->
# GitNexus — Code Intelligence

This project is indexed by GitNexus as **zinecv-desktop** (8271 nodes, 23977 relationships, 716 execution flows; refreshed 2026-10-07).

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

## 2026-10-08 当前续作边界

用户已要求完成本机 Windows 可执行的 Browser/WASM 与 OHOS 交叉编译。最新结果见切片 §11 和 `.artifacts/remaining/windows-capable-20261007/REPORT.md`；旧“本轮不测试非 Windows”记录只属历史。Browser 共用 Rust Store/Engine/Agent 与 React；OPFS 单写者、WebCrypto 非导出密钥、CORS 和 worker 隔离为实际能力。OHOS 仅核心/NAPI 编译 POC，完整 ArkTS Host/HAP 未完成。Android SDK/NDK 的安装及协议授权、HarmonyOS 官方完整工具路径待用户答复，Apple/真机不能伪记通过。

原生七 crate 309 项与 OHOS Windows 探针 1 项分别计数；完整 34 阶段结果绑定本轮源码，见报告，不挪用旧 full。机器可用内存不足时设置 `CARGO_BUILD_JOBS=1`，保持正式 release 优化不变。复建 target/dist/wasm-bindings 后仍须按用户指令清理。
