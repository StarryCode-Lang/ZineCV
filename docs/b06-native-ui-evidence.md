# B06 桌面 UI 接线证据（进行中）

状态：`in_progress`。本文件记录"旧 React 工作区 + Rust 权威核心"接线的实现范围与已验证证据。按 `adr-ui.md` 的回退决策，正式桌面 UI 以旧版 React 组件为迁移输入；本轮把它接上了 SQLite 权威存储。这不是 B06 完成：真实 IME、完整指针取消矩阵仍在进行。

## 2026-09-28 第三轮补充（B07 模板矩阵 + B10 项目 JSON + B11 身份基础）

- **B07 模板矩阵**：引擎测试新增三套内置模板参数集（legacy/clear/compact，参数取自旧版 registry 默认值 px→pt 换算）+ 双行标题路径，全部编译出 A4 PDF；`%PDF-` 头校验。三个模板的差别完全由 presentation 参数承载，引擎按参数渲染——即 PDF 导出已覆盖全部三模板。
- **B10 项目 versions.json**：`parseLegacyProjectVersions` 接受旧 `.data/versions.json`（裸 ResumeVersionStore，head 快照过 `documentFromSnapshot` 预校验）；版本面板"导入旧版数据"入口自动识别两种格式（浏览器导出包 / 项目 JSON）；项目导入后工作区切到当前分支 head（对齐旧版首次启用项目版本库的行为）。
- **B08 补全**：导入模板目录（`resume-diy-imported-templates-v1`）也镜像到 SQLite settings；至此模板收藏/最近使用、分栏宽度、导入模板目录三类工作区偏好均双写。
- **B11 身份基础（Rust 层完成，UI 接线属 B12）**：
  - migration v4：`accounts`/`account_sessions`/`provider_profiles`/`secrets` 四表。
  - `identity.rs`：账户注册/登录（scrypt 参数与旧 Node 版逐项一致：`scrypt(password, salt字符串字节, 64)`、N=16384/r=8/p=1，hex 存储；测试含旧版手工构造哈希兼容验证）；会话令牌；登录失败 5 次锁 30 秒（进程内计数，桌面单用户边界已记录）；错误文案不区分账户存在性。
  - DPAPI SecretStore：`CryptProtectData`（无 LOCAL_MACHINE 标志）加密 Key 存 SQLite BLOB，连接配置与密文同事务；状态查询只返回脱敏尾串（前2+后2），明文仅 `reveal_provider_secret` 网关路径可取（B12 使用）；连接地址白名单（https 或本机 http）。
  - IPC：`register_account`/`login_account`/`logout_account`/`store_provider_key`/`provider_key_status`。
- **B14 产物**：NSIS 安装包重新构建成功：`ZineCV_2.0.0-alpha.0_x64-setup.exe`（42.8 MB，含 Typst 引擎与双字体），SHA-256 `D918D9D24E3BA4CA93A90A4C786BEDBF02FD7C2E9CFD1FD21DA3FB604E61E5E8`。未签名、未做干净 VM 安装验收（release-blocked 项保持）。

### 第三轮验证记录

- Rust **85/85**（新增 identity 3 项：注册登录会话 round-trip + 旧 scrypt 兼容、限流、DPAPI 密钥脱敏/明文路径）；迁移断言更新为 [1,2,3,4]，未来 schema 改为 5。
- clippy（fmt + -D warnings）0 错误；`npm run test:unit` 4/4；`npm run test:browser` 7/7；`npm run test:webview` 1/1（含 Typst PDF 导出与 PyMuPDF 中文文本提取）；视觉对照 0 差异 ×2 视口。
- 诚实说明：盐/会话令牌随机源使用 OS CSPRNG（`getrandom` crate，`getrandom::fill`），DPAPI 密文只在本机同一 Windows 用户可解密。账户/密钥 UI 尚未接线（AgentOverlay 仍指旧 HTTP 网关，登录会得到明确失败提示），B12 接入。

## 2026-09-28 第二轮补充（B07/B08/B10 阶段性接线 + 视觉等价）

- **视觉等价对照（`tools/visual-parity.mjs` + `visual-parity-fixture.mjs`）**：同一虚构简历夹具分别注入旧版 dist 与桌面版 dist（`addInitScript` 首帧前注入，绕开旧版 pagehide flush 的覆盖），同一 Chromium 1440×900 / 1920×1080 截取 `.paper-frame` 逐像素比较（pixelmatch，threshold 0.1）。**两视口差异像素均为 0**。这证明"同一输入在两套构建里的 A4 排版输出逐像素一致"；WebView2 宿主滚动条差异属宿主层，已由真实 exe 验收覆盖。夹具中"至今"类日期值在两边共享代码渲染为"至今undefined月"（旧版固有行为），对照夹具改用具体日期，该固有缺陷另册记录。
- **B07 Typst 引擎接入主程序**：`src-tauri/src/engine.rs`——ResumeDocument → 数据驱动 legacy-v1 模板（正文经 `json("resume.json")` 进排版，用户文本不拼入 Typst 源码；富文本 marks/链接/有序无序列表/软换行渲染；主题色白名单校验；参考日期冻结）。Rust 测试验证 A4 页面尺寸（595.28×841.89pt）、PDF 头、编译警告即失败。新增 `export_document_pdf` IPC；前端 PDF 导出改为 Typst 矢量输出（先 flush 草稿队列保证导出内容 = 已保存内容），PNG 仍走旧 html2canvas 长图。
- **B08 settings 持久化**：SQLite migration v3 新增 `settings(key, value, updated_at)`；`read_setting`/`write_setting` IPC（4MiB 上限、空值删除语义）；前端 `platform/settings.ts` KV 镜像——localStorage 保持同步首屏读取（组件不改异步），桌面模式写时镜像到 SQLite。已接模板收藏/最近使用（`resume-diy-template-library-v1`）与分栏宽度（`resume-diy-editor-pane-width`）。Rust 测试覆盖 round-trip/覆盖/删除/重开持久。
- **B10 旧浏览器数据导入**：版本面板新增"导入旧版浏览器数据"按钮（桌面模式显示）；`platform/legacyImport.ts` 解析 `zinecv-legacy-browser-export` 格式 → 恢复工作区快照（复用 normalize/migratePersonalSites）+ 整库替换版本图（快照提前过 documentFromSnapshot 校验，缺快照中止而非半写）；会话数据计数报告（迁移延后到 B12）。旧 origin 主动导出页 `public/legacy-export.html` 沿用。

### 第二轮验证记录

- `npm run test:native`：Rust **81/81**（新增 settings round-trip、引擎 PDF/A4/非法主题拒绝）；迁移版本断言更新为 [1,2,3]，"未来 schema"改为 4。
- `npm run test:unit` **4/4**；`npm run test:browser` **7/7**；`node tools/visual-parity.mjs` **1/1（0 差异像素 ×2 视口）**。
- `npm run build:native` + `npm run test:webview`：真实 WebView2 E2E 扩展为——渲染 → 标题编辑 → durable 保存 → 重启恢复 → 展开基本信息填姓名 → durable 保存 → Typst PDF 导出下载 → `%PDF-` 头 + PyMuPDF 提取文本含"王测试/自我评价" → 版本面板显示"初始版本"。全程 4.7s。
- `npm run check:native`（fmt + clippy -D warnings）：0 错误。

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

- F01–F09、F24–F30 的完整验收项：逐项操作矩阵、真实中文 IME（微软拼音）人工验收、拖拽/折叠指针取消矩阵仍未执行；视觉等价已有逐像素 0 差异证据（见上），但仅覆盖 legacy-v1 模板 + 本轮夹具，clear/compact 模板与 density 交叉矩阵仍待验收。
- Typst 引擎（B07）仅接通 PDF 导出与 legacy-v1 基线版式：预览仍是旧 DOM 渲染（逐像素一致），SVG 预览切换、命中区域、可选中文字层、clear-single/compact-single 模板、智能一页求解器未实现。
- 模板收藏/分栏宽度已入 SQLite settings，但 Agent 会话、导入模板目录仍在 localStorage（B12/B10 范围）。
- Agent 网关离线：AgentOverlay 可见，模型请求会得到明确失败提示（B11/B12 范围）。
- 旧浏览器 origin 数据迁移：导出页 + 桌面导入入口已通（工作区 + 版本库），账户/会话/密钥迁移未做。
- 安装器 E2E、干净 VM、签名（B14）未开始。
