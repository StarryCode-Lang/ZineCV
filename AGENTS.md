# 项目维护边界

- `.data/versions.json` 是用户的版本库，`.data/versions.backup.json` 是上一份文件备份。它们不是构建产物或测试数据，任何开发、重构和清理任务都必须保留，除非用户明确要求删除自己的版本数据。
- 开发及本地预览默认使用 `http://127.0.0.1:5173`，端口占用时直接报错，不能静默换地址。不要随意清理用户浏览器网站数据。
- 浏览器测试必须使用独立上下文；文件持久化测试必须传入独立测试数据目录，禁止使用用户 `.data` 或正在使用的 5173 页面。
- 普通静态托管只有浏览器缓存；通过 `npm run dev` 或 `npm run preview` 才提供项目文件存储。不要将“浏览器缓存成功”描述为“项目文件保存成功”。
- 清理可以删除已检查的 `.artifacts`、`.audit`、`dist`、`*.tsbuildinfo`，不能删除源代码引用的字体、配置、有效测试脚本或用户数据。`.data` 必须独立于这些目录。
- 简历正文渲染与排版改动仍需验证 A4；版本管理改动需运行 `npm run test:versions`。

## 右侧预览锁定维护边界

- 当前状态和验证入口以 `docs/maintenance-status.md` 为准。右侧简易预览必须与基线保持一致：不得改变字体文件、字体族、字重、字号、图标字形、标题、正文对齐、颜色、行高、字距、边距、模块间距、纸张尺寸、分页规则、内容顺序、导出画面、纸张位置、显示尺寸或缩放。
- 唯一允许新增的预览视觉是纸张之外的临时模块悬停/键盘聚焦轮廓。它不得进入文档流、移动正文或图标、参与分页、写入简历数据，也不得出现在 PDF、PNG、打印或导出克隆中；交互结束后预览必须恢复原样。
- 保持“左侧编辑、右侧预览”的空间关系，不执行中央 A4、右侧编辑器或独立 A4 版式旧方案；相同输入、浏览器、视口、DPR、分栏和滚动位置下，预览几何必须不变。
- 冻结 `src/styles/preview.css`、`src/components/preview/PreviewHeader.tsx`、`src/components/preview/PreviewSections.tsx`、`src/components/preview/PreviewSummary.tsx`、`src/components/preview/ResumePreview.tsx`、`src/components/WebsiteMark.tsx`、`src/app/useResumePagination.ts`、`src/services/resume-pagination.ts`、`src/services/resume-export.ts`、`src/domain/initial-resume.ts`、`src/domain/resume-model.ts` 和 `public/fonts/`；除计划明确的 ref/事件接线外，不改预览正文树或其排版计算。
- `.data/versions.json` 和 `.data/versions.backup.json` 是用户数据，禁止为满足测试而修改、清空、恢复或删除；浏览器测试须使用独立上下文，持久化测试须使用独立数据目录，不能触碰用户当前 5173 页面。
- 涉及右侧预览时，先记录入口、最小改动文件、基线和保护边界，再实施和验证；右侧预览出现非交互层差异、必须修改冻结文件、覆盖用户数据或更换字体/分页/导出算法时，停止当前批并保留证据。延期项不得标记为完成。

## Codex 代码智能工具

- 本项目的主 Agent 为 Codex。涉及跨文件定位、调用链、影响范围、重构或回归边界时，优先参考已配置的 GitNexus MCP/Skills；可用能力包括 `context`、`impact`、`trace`、`detect_changes`、`check` 和 `query`。先确认索引新鲜度，再把图谱结果当作导航证据；仍必须读取实际源码并运行与改动相关的验证。索引为空、过期或无法解析时，不得把“没有结果”当作“没有影响”，应回退到源码搜索、ast-grep 和测试。
- 结构化 TypeScript/TSX/JavaScript 搜索优先使用 npm 安装的 `ast-grep`（必要时使用 `ast-grep --pattern ... --lang ts/tsx`）；进行 rewrite/codemod 前先预览匹配并检查 diff，不对冻结的预览正文、分页、导出、字体和用户版本数据做批量重写。
- 需要表达架构、工作流、时序、数据流、生命周期或变更前后对比时，使用已配置的 Archify Skill。Archify 只用于分析和文档表达，不替代测试、不推断运行时影响，也不修改右侧 A4 预览；临时产物放在 `.artifacts/`，除非用户明确要求保留，否则任务结束时按清理规则处理。
- GitNexus、ast-grep 和 Archify 的结果都不是修改授权。任何工具给出的关系、影响或图表结论，都要与当前源码、维护状态文档、保护边界和回归结果交叉核对。
- 发布门禁：每次准备 `git push` 前，必须在最后一次修改之后刷新 GitNexus 索引并检查 `status`、循环和变更范围；用 npm 安装的 `ast-grep` 对本次涉及的 TS/TSX/JS 结构做一次只读扫描；重新校验并交付 `docs/architecture.archify.json` 对应的 Archify 图（若架构规格未变也要确认校验通过）。三项结果、相关测试和 `git diff --check` 全部通过后才能推送；Archify 的 visual-check sidecar 和其他临时产物不得进入提交。

<!-- gitnexus:start -->
# GitNexus — Code Intelligence

This project is indexed by GitNexus as **resume-diy** (3227 symbols, 7944 relationships, 223 execution flows).

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
| `gitnexus://repo/resume-diy/context` | Codebase overview, check index freshness |
| `gitnexus://repo/resume-diy/clusters` | All functional areas |
| `gitnexus://repo/resume-diy/processes` | All execution flows |
| `gitnexus://repo/resume-diy/process/{name}` | Step-by-step execution trace |

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
