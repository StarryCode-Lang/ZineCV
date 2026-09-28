# B06 桌面 UI 接线证据（进行中）

状态：`in_progress`。本文件记录"旧 React 工作区 + Rust 权威核心"接线的实现范围与已验证证据。按 `adr-ui.md` 的回退决策，正式桌面 UI 以旧版 React 组件为迁移输入；本轮把它接上了 SQLite 权威存储。这不是 B06 完成：真实 IME、完整指针取消矩阵、逐项视觉对照仍在进行。

## 实现范围

- **UI 迁移**：旧版 `src/{app,components,domain,services,styles,templates,utils,agent,motion}` 原样迁入 `src/legacy/`；入口 `src/main-desktop.tsx` 挂载同一 React 组件树（`?sample=interaction` 保留 Svelte 样片）。字体/iconfont 资产复制到 `public/fonts`。编辑器、右侧 A4 预览、工具栏、三工作区、Agent 浮层沿用旧实现，视觉与交互由同一组件保证。
- **原生持久化**（`src/platform/useNativeResumePersistence.ts`）：与旧版 `useResumePersistence` 相同的输入与 180ms 防抖、保存/重试语义；写入改为"工作区快照 → ResumeDocument（`inspectLegacySnapshot`）→ 最小命令求差（`nextDocumentCommand`）→ `NativeDocumentClient` 串行命令队列"。每条命令 durable ack 后才显示"草稿已保存"；失败保留输入并阻止后续命令，重试复用原 commandId。
- **原生版本库**（`src/platform/useNativeResumeVersions.ts`）：返回面与旧版 `useResumeVersions` 一致（提交/建分支/切分支/跳转/载入/删除/整库替换），数据来自 Rust 事务命令；版本操作前强制 flush 草稿命令队列；删除当前 head 后显式载入新 head 以对齐旧版工作区行为。
- **头像资产**：data URL → SHA-256 hash 寻址资源（8MiB 上限、mime 白名单），`document-avatar` 引用保证 GC 不回收；`UpdateBasic.avatarAssetId` 空字符串为清除哨兵。
- **Rust 新命令**：`commit_version`、`create_version_branch`、`switch_version_branch`、`load_history_commit`、`delete_version_commit`、`delete_version_branch`、`replace_version_store`（替换前 SQLite Backup API 生成 `zinecv.sqlite3.pre-replace.bak`）、`version_graph_detailed`、`store_avatar_asset`、`read_avatar_asset`、`SetLegacyExtensions` 领域命令（封存元数据随快照保真）。
- **默认文档对齐**：`default_resume_document` 与旧版空白初始状态逐字段一致（标题 "resume DIY"、11 个 section、`legacy-section:<kind>` 稳定 ID、宋体/13px/单行标题/两端对齐等默认排版），保证全新安装首屏与旧版一致。

## 证据（全部在本机隔离数据目录执行）

- `npm run test:native`：Rust **79/79** 通过（含默认文档对齐、双连接 CAS、备份/恢复、分支删除祖先保留、头像资源 GC 链接新用例）。
- `npm run test:unit`：**4/4**；`npm run test:browser`：**7/7**（React 外壳浏览器降级、Svelte 样片、旧数据导出页、富文本/快照桥接、documentBridge round-trip 与多命令 fixpoint 收敛——覆盖标题/基础字段/正文/改名/可见性/章节排序/条目增删改/排版/封存元数据全命令类型）。
- `npx tsc --noEmit -p tsconfig.platform.json`：0 错误；`npm run verify:contracts`：52 项矩阵 + poc 契约校验通过；`npm run test:bindings`：30 个绑定零漂移。
- `npm run build:native`：release exe 构建成功（嵌入新前端）。
- `npm run test:webview`：真实 WebView2 E2E 通过——`.app-shell` 渲染 → 标题改为"桌面保存测试" → `草稿已保存`（durable ack）→ 页面 reload 重新引导 → 标题从 SQLite 读回 → 版本面板显示"初始版本"；数据目录 `ZINECV_DATA_DIR` 隔离，`zinecv.sqlite3` ≥ 4KiB。运行器：Playwright CDP attach，Windows 11 x64。
- `npm run test:native-shell`：release exe 隔离目录启动冒烟通过。
- 诊断工具 `tools/webview-probe.mjs`：连接真实 exe 输出页面状态与控制台错误（用于定位首次持久化收敛失败，修复 `legacyExtensions` 无法被命令表达的问题后归零）。

## 尚未完成（保持 pending 的原因）

- F01–F09、F24–F30 的完整验收项：逐项操作矩阵、真实中文 IME（微软拼音）人工验收、拖拽/折叠指针取消矩阵、逐项视觉对照截图仍未执行；当前通过的是自动化可覆盖的核心回路。
- 模板库元数据、Agent 会话、分栏宽度仍存于 WebView2 profile 的 localStorage（随用户数据目录持久化），尚未迁入 SQLite settings（B08/B10 范围）。
- Agent 网关离线：AgentOverlay 可见，模型请求会得到明确失败提示（B11/B12 范围）。
- 预览与导出仍为旧版 DOM 渲染 + html2canvas/jsPDF（与旧版视觉逐像素一致）；Typst 引擎（B02 样片已过）替换预览/导出前必须先过 B07 视觉等价关卡。
- 旧浏览器 origin 数据迁移（B10 导出页已有，桌面端导入入口未接）。
