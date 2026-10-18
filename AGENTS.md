# ZineCV 项目约定

默认使用简体中文。唯一权威现状切片为 `docs/SLICE_20261002.md`（最新状态见文末续作记录）；C+ 全平台目标架构（已签字定案）的唯一决策记录为 `docs/ARCHITECTURE_TARGET_CPLUS.md`，分阶段落地计划为 `docs/EXECUTION_PLAN_20261006-cplus.md`；历史plan/TASK有效事实已合并。56行机器矩阵为 `docs/feature-parity.json`（52 required+4 supplemental），最新自动验收记录见 `docs/QUALIFICATION_20261018.md` 与 `.artifacts/acceptance-runs/2026-10-17T23-22-32.766Z/`；Windows 旧轮记录保留在 `.artifacts/remaining/windows-capable-20261007/REPORT.md` 和 `.artifacts/remaining/cplus-20261007/REPORT.md`。不要把局部通过升级为整体通过。

## 保护边界

- 不推送、不发布；本地提交需要用户明确授权。保留已有工作区改动和用户数据。按2026-10-16用户最新效率要求，日常保留当前有效target、dist和node_modules，避免重复冷编译；仅显式彻底清理或缓存故障时删除，构建收据继续校验。保留源码、锁文件、fixture、许可、有效验收证据、当前分析与用户数据。首次原生源码编译需重建依赖（实测 release ≈39 分钟、hooks ≈47 分钟），构建运行期间不得改动仓库任何文件（收据会拒绝）。
- 四份主要文档不修改：`docs/DEVELOPMENT_PLAN.md`、`docs/FEATURE_PARITY.md`、`docs/FEASIBILITY.md`、`docs/target.archify.json`。
- 真人验收由用户自行完成。VM、签名、真实模型、字体许可与第二执行者已按用户指示移出本轮；仍准确记录未证事实，不假记通过。
- `src/ui` 是当前正式 React UI；`src/platform` 是前端 IPC 与数据转换边界。原生验证通过 `tools/with-msvc.ps1`，数据与 WebView2 测试使用隔离配置；WebView2 测试串行运行。
- 日常启动完整桌面应用统一使用 `npm run dev`（自动准备 MSVC 并启动 Tauri）；Vite 仅由 Tauri 内部启动，不保留单独的浏览器预览脚本。

## 回归与测量

- fast/regression为部分检查，full保留完整34阶段；原生/WebView2/bench/soak串行，独立数据。
- 测量默认 quick 20秒×1，standard 120秒×3，extended 30分钟×3为独立长测；短测不冒充长时验收。
- 测试档worker默认3秒超时预算，生产90秒不变；`--extended`保留原预算专项。

## 分析工具

- GitNexus 当前仓库名为 `ZineCV`。涉及调用关系的修改先检查索引新鲜度，再查询符号上下文及影响；索引陈旧时更新。索引只提供导航证据，跨语言未关联、流程截断和空结果均不能证明代码无用。
- ast-grep 用于结构查询；`npm run audit:ast` 只读，不自动重写。删除旧代码仍需实际入口、引用和验证证据。
- 分析缓存与生成 HTML 保存在忽略目录，不能混入产品运行依赖。`CLAUDE.md` 如需提供兼容入口，仅链接本文件。

<!-- gitnexus:start -->
# GitNexus — Code Intelligence

This project is indexed by GitNexus as **ZineCV** (local index metadata: `.gitnexus/meta.json`; refresh before change analysis).

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
| Understand architecture / "How does X work?" | `.claude/skills/gitnexus-exploring/SKILL.md` |
| Blast radius / "What breaks if I change X?" | `.claude/skills/gitnexus-impact-analysis/SKILL.md` |
| Trace bugs / "Why is X failing?" | `.claude/skills/gitnexus-debugging/SKILL.md` |
| Rename / extract / split / refactor | `.claude/skills/gitnexus-refactoring/SKILL.md` |
| Tools, resources, schema reference | `.claude/skills/gitnexus-guide/SKILL.md` |
| Index, status, clean, wiki CLI commands | `.claude/skills/gitnexus-cli/SKILL.md` |

<!-- gitnexus:end -->

## 2026-10-11 当前续作边界

历史全链验收（仅证明当时冻结源码）：`.artifacts/remaining/closure-final-20261011/attempt-9/`（accept-project 16 阶段全过：full 34/34、wasm-check、Browser/WASM 平台对照 12/12、NSIS 打包、standard 120s×3、extended 30min×3；详见切片 §13）。原生主测试 318 项（宿主 26 + contracts 109 + domain 9 + engine 42 + storage 114 + agent 18）。上一轮记录：`.artifacts/remaining/windows-capable-20261007/REPORT.md` 与切片 §11/§12。

- `D:\tmp\llvm`（clang 23.1.3）与 `~/.cargo/bin/wasm-bindgen.exe`（0.2.129）为项目外 wasm 工具链；运行 wasm 阶段需设 `CC_wasm32_unknown_unknown`/`AR_wasm32_unknown_unknown`/`ZINECV_WASM_BINDGEN`（with-msvc 的 Codex 默认路径已失效）。OHOS SDK 缺失，`build:ohos-core` 当前不可运行。
- 打包校验解析PE结构，仅允许COFF及3个调试目录TimeDateStamp字段与RSDS的16字节GUID变化，其他字节拒绝。旧轮“4×2字节标记”是时间戳差异长度的偶然结果。打包前将原exe落盘备份，成功或失败均在finally还原并核对哈希；恢复失败保留备份。当前链以本轮冻结源码与产物绑定为准。
- 构建/验证会话内曾出现两类偶发：WebView2 动画期点击被拦截、杀软/索引器瞬时锁报告文件（EPERM）——重跑即可，勿据此改产品。
- Bash 工具的 Windows PATH 未转换：bash 内需前缀 POSIX 路径，spawn 子进程（npm/cargo）必须经 PowerShell 并把 `$env:Path` 重置回原始 Windows PATH。

## 2026-10-15 最新续作状态

当前证据与轻量化记录见切片 §16 和 `.artifacts/remaining/closure-cleanup-20261015/REPORT.md`。正式宿主基本字段/头像补测1/1通过，56行证据清点完成但不等于全部功能通过；矩阵未升级。当时已清理构建产物、临时缓存与node_modules；当前按2026-10-16要求保留有效缓存，缺依赖时才运行`npm ci`，日常用`npm run dev`。保留所有有效/失败证据、用户数据和现有源码改动。

## 2026-10-16 当前执行状态

新增经历排序和边缘滚动，正式宿主富文本/历史/排序/18版式导出组合及基本字段/十模块专项已通过。证据根`.artifacts/remaining/completion-20261015/`，切片§17；完整验收attempt-2已按用户要求中止：9/34通过，318项原生主测试通过，不能记整体通过。后续以快速/定向回归完成开发闭环，不自动追加完整链。外部资格边界不变。

## 2026-10-16 验证效率（用户最新要求）

日常默认`npm run check`（5项，不编译原生、不启动浏览器），UI用`npm run check:ui`；`tools/run-checks.ps1 -Scope Native|Agent|Recovery`按改动明确选范围，`-Plan`先看范围。`-Scope Full`保留34项，`npm run accept:full`保留16阶段含打包/跨平台/长测；只有明确启动完整资格时执行，不在每次修复或收尾自动附加。保留现有用例/阈值/预算，快速与专项不标成full。当前有效编译/依赖缓存属于开发反馈速度所需，不再日常全删；无用临时文件仍及时清理。真人输入法/设备/视觉等由人工验收，自动化记录可重复行为与数据保护。

## 2026-10-17 回归精简（用户最新要求）

日常`npm run check`仍为5项；广覆盖常用回归统一`npm run check:regression`（15阶段，只使用正式宿主，不隐式编译debug/hooks/引擎示例）。剩余清单从旧full34自动减去常用集合生成19项，用户手动运行`powershell -File tools/run-remaining-checks.ps1`可执行延后检查及WASM/Browser/平台/打包/原预算长测，`-Plan`只看计划。共享正式构建依赖仍校验收据；remaining-only不导入旧常用通过或宣称整轮full。旧full34及完整16阶段保持兼容但不在日常追加。用例/阈值/长测预算保留。

## 2026-10-17 测试与工具清理

测试加载器、测量环境信息与安全预检清单统一复用；检查范围以verify-project.mjs为单一来源。完整验收使用run-remaining-checks.ps1 -Complete，默认仍为remaining-only；旧run-acceptance.ps1与过时的clean-generated-manual.ps1已移除。保留现有用例和预算、有效构建缓存与验收证据。清理报告见.artifacts/remaining/cleanup-tests-tools-20261017/REPORT.md。

## 2026-10-18 最新验收与清理

最新权威现状见 `docs/SLICE_20261002.md` 文末；2026-10-18 延后批次 16/16 通过，属于 remaining-only，不能与此前常用回归拼成同一轮 full。当前证据见 `docs/QUALIFICATION_20261018.md`。

用户运行的延后批次19项及共享正式构建依赖共20阶段通过，WASM/Browser/平台对照、Windows打包、standard120秒×3与extended30分钟×3通过；源码前后摘要一致，原exe还原哈希一致。此前PNG失败批次保留为失败，矩阵状态不自动升级。日常不重跑已完成的延后链或长测；后续只按实际修改选最小检查。

活动文档已同步；四份冻结依据、fixture、许可与原始验收数据保留原字节。保留当前target/dist/node_modules、wasm-bindings、分析索引和工具设置。只删除已结束隔离测试的可重建浏览器缓存，整理历史根日志。清单见`.artifacts/remaining/docs-cleanup-20261018/`。真人、VM、签名、真实模型、许可、第二执行者和后续平台实现仍待完成。
