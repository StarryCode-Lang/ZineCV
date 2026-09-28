# ZineCV 2.0 执行状态

当前分支：`codex/zinecv-v2`；起点：`5b88a9148a793217802955a1eb4b029473e6562a`。工作树已迁至 `D:\Documents\Codex\zinecv-v2\resume DIY`，旧 C 盘工作树内容由用户手动删除；原路径尚有空目录。四份计划文档从原工作区原样复制到隔离 worktree；旧版 `src/`、字体、固定 A4 基线和用户 `.data` 未修改。

| 批次 | 状态 | 已取得的证据 | 剩余事项 |
| --- | --- | --- | --- |
| B00 | in_progress | 52 项验收矩阵均为 pending；旧版构建、版本 schema、Agent runtime、预览交互检查通过；固定预览历史差异复现；隔离 Chromium 的旧版多页 A4 支持跨页 DOM 选区与 Ctrl+C 复制，剪贴板换行从 LF 转为 CRLF；当前旧版的预览自比较 24 场景/29 案例通过 | 完整现状操作/视觉/动效/数据键/性能基线、跨页指针拖选与辅助技术阅读顺序；新旧实现视觉等价仍须独立对照 |
| B01 | in_progress | 隔离分支、`desktop/` Svelte/Vite/Tauri 骨架、固定 5174 端口；Svelte 构建、Rust 检查、release exe 与 NSIS 在线安装包构建通过；样片浏览器、原生进程及真实 WebView2 页面 smoke 通过 | 实际安装器 E2E、干净开发机复现、CI 与完全隔离的用户数据验证 |
| B02 | in_progress | 内存资源 World + 本地字体的 Typst 样片生成 1/2/5 页 A4 PDF/SVG/PNG，零警告；PDF 文本提取实测；单进程多请求 worker 在复制出的独立目录按宿主 manifest/hash 获取字体，损坏资源拒绝；虚构 JSON 正文直接参与排版并以段落 ID/来源字节偏移核对；非正式 `textMapSample` 从模型组成全局逻辑文字并把跨页字形簇映射到 UTF-16 范围，逆绘制顺序和 emoji 反例通过 | 完整富文本/模板/头像、正式 `TextMap` 的精确矩形/复杂阅读顺序、字体交付策略、正式 Tauri 宿主监管、真正可选中文字层、性能与故障注入、视觉等价 |
| B03 | in_progress | 隔离 `?sample=interaction` 样片实现富文本、模块折叠/拖拽/键盘重排、分栏和 Agent 形态；独立浏览器真实指针测试暴露并修复工具栏被拖拽抢占、输入折叠后丢失和分栏起点跳变，快速松手与合成取消检查通过；原 React 静态构建在隔离 WebView2 中保留左编辑/右预览和悬浮助手，原生滚动条引起约 10px 纸张显示宽度差异；`adr-ui.md` 按 B03 失败回退条款选择 React 适配 | React 原界面接 Rust 权威存储、同口径视觉/代码/资源对照、中文 IME 真人验收、完整指针取消矩阵；ADR 不代表 B03 完成 |
| B04 | in_progress | Rust schema 2 第一批类型、canonical hash、基础校验、含 SetSummaryBody 的命令与幂等/CAS 执行器；`UpdateEntryFields` 补齐 college/mode、基础姓名可清空并经 SQLite 重新读取；25 个 TS 绑定生成并 strict 检查；旧 HTML ↔ RichBlock 与旧版本快照 → ResumeDocument 的只读候选适配及共享金样见 `b04-richtext-adapter.md` | 其余命令、账户边界、UI 同契约验证、完整 HTML/布局迁移语料与差异处理；候选解析不是正式迁移 |
| B05 | in_progress | SQLite v1→v2 迁移、WAL/FULL/外键、草稿 round-trip、同内容双提交单一快照、资源 hash 与 GC、真实文件库、备份/恢复、损坏库启动、损坏备份保护和双连接 CAS 测试通过；v1 备份先在隔离库升级再恢复；命令与版本提交在立即事务内核对 cursor；新 schema、异常备份在覆盖前拒绝；初始版本、建分支、切分支、历史载入、单提交删除重接和分支删除祖先保留的事务路径已接入存储层；只读版本图同一数据库快照返回 cursor、活动分支、提交与已删除来源标记；8 个 SQLite 写入边界报错后的回滚与重试验证通过；备份同目录暂存校验后发布且拒绝覆盖旧目标，单次并发写入时得到一致快照 | 连续写入/锁等待、磁盘满/权限/强杀和完整双窗口故障注入、正式版本 UI 与确认/失败提示、双窗口删除验收、资源/导入/账户表 |
| B06 | in_progress | 隔离 WebView2 样片通过 Tauri IPC 读取 SQLite 默认文档与版本图，标题编辑经 Rust CAS 命令写入并在页面刷新后读回；浏览器样片显示明确回退；不接触旧版页面 | 正式编辑器、完整保存状态、IME、全部页面和旧版视觉/功能等价 |
| B07–B09、B11–B15 | pending | 尚无 2.0 功能验收证据 | 按计划依赖顺序执行；不能把样片或旧版测试算作 2.0 完成 |
| B10 | in_progress | 旧版原 origin 的手动浏览器数据导出页、桌面侧只读格式/hash检查、隔离下载/无改写测试见 `b10-browser-export.md`；旧快照只读候选适配见 `b04-richtext-adapter.md` | 项目 JSON/账户文件入口、逐键解析和完整实体/资源迁移、来源冲突、事务提交与收据、真实数据验收均未完成 |

领域写入边界补证：`DocumentContext::apply_command` 先在暂存副本执行，校验和 receipt 都成功后才替换内存状态；非法富文本或条目移入 summary 失败时，正文与 revision 保持原值，随后合法编辑仍可成功。新增 `SetSummaryBody` 指定 summary 模块的正文命令，SQLite 重新读取和同命令重试通过；`npm run test:native` 73 tests。SQLite 事务原有回滚边界未改；正式编辑器和全部数据迁移仍未完成。

React 回退决策与保存接线：`adr-ui.md` 记录 Svelte 样片未达到 B03 的视觉/功能完成条件，并按计划回退到旧 React UI 适配；`target.archify.json` 的 UI 节点相应更新且 showcase 9 项校验通过。`NativeDocumentClient` 已在桌面开发状态页接 Rust IPC，串行命令、缺 durable ack 阻断、同 commandId 重试的单元测试 3 项通过；`npm run test:unit` 总计 4 项、`npm run test:browser` 2 项、`npm run build:native` 和隔离 release `npm run test:webview` 1 项通过，标题刷新读回落入测试 SQLite。旧 React 编辑器尚未接此客户端，B03/B06 与 F 项仍未完成。

## 2026-09-27 数据隔离纠正

- B02 Unicode 反例与修正方向：`office e\u{301} 中文` 的 `ffi` 与组合重音分别形成跨 3/2 个 UTF-16 单元的簇；Windows 字体后备样本 `中文 שלום عربي 😀` 无编译警告，但 frame 绘制顺序拼接错误地移动了空格。Typst glyph 的来源字节偏移能与原文逐簇对应；按偏移排序后还原原文，诊断输出新增 `sourceByteOffset`。正式复制必须读取文档模型 `logicalText`，不能使用绘制顺序。系统字体的可用性、许可和一致性仍未定案。
- B02 页内簇矩形实验：诊断输出新增 A4 页框 pt 尺寸和每个 shaped glyph 簇的变换后包围矩形；两页 Rust 和 1/5 页 release worker 检查有限值、非负宽度、正高度和页内范围通过。纵向暂用整段 run 的 `bbox`，并非最终选择矩形；RTL、连字、组合字符、裁剪及真实跨页复制仍未验收。
- B02 源关联实验：虚构 Typst 模板加入四个不可见 `metadata` 源节点标记，frame 提取器把当前标记关联到文字 run/字形簇并跨页延续。两页 Rust 测试和 1/5 页 release worker 测试均确认首段/末页来源；`npm run test:engine-poc`、`npm run test:engine-worker`、`npm run check:native` 退出码 0。`npm run poc:engine` 后，改动前保留的 11 个 PNG/SVG 与改动后的 SHA-256 完全一致，页数仍为 1/2/5、零警告。仍缺正式 `TextMap` 的逻辑文本与矩形，不能签署 F15 或 B02。
- B02 文字映射样片：worker 从 Typst 页面 frame 导出非正式 `textGeometrySample`，包含逐页文字 run、UTF-16 字形簇范围与页面点坐标；`npm run test:engine-poc` 2 tests、`npm run test:engine-worker` 2 tests 通过。它不是计划中的 `TextMap`：仍缺逻辑阅读顺序和可选字矩形，也尚无浏览器跨页复制验收，F10–F18 仍 pending。迁移后首次 release 构建发现旧 Cargo 缓存引用已删除的 C 盘路径；仅清理 D 盘 `tauri` 与 `zinecv-desktop` 的 release 包缓存（457.7 MiB）后，`npm run build:engine-poc`、`npm run build:native`、隔离的 `npm run test:webview`、`npm run check:native` 全部退出码 0。该结果证明当前 D 盘样片构建和运行不依赖旧 C 盘目录，不代表剩余功能全部完成。
- B00 旧版纸面选字范围补证：`npm run test:preview-interaction` 在独立 Chromium 153.0.8010.12 / 1440×1000 / DPR 1 的虚构多页简历中建立从第一页到第二页的 DOM 选区，选中 566 字符、产生 12 个矩形；Ctrl+C 的剪贴板内容与选区在换行规范化后完全一致，原始选区使用 LF、剪贴板使用 CRLF。证据与构建/脚本 hash 见 `paper-text-selection-baseline-20260927.json`。这证明跨页键盘复制存在，要求 B02/B07 提供文本层；指针跨页拖选和辅助技术顺序仍待验收。旧版预览正文与字体未改。

- 标题编辑样片接入 Rust CAS 命令并在真实 WebView2 中验证刷新读回；`npm run build:native`、`npm run test:browser`、`npm run test:native` 通过。首次重跑 `npm run test:webview` 失败：新测试 profile 读到了上一轮的虚构标题“桌面保存测试”（修订 1），证明过去只覆盖 AppData/LocalAppData 环境变量没有隔离 Tauri 的实际 `app_data_dir()`。
- 受影响的实际路径为 `C:\Users\Administrator\AppData\Roaming\com.zinecv.desktop\zinecv.sqlite3` 及 WAL/SHM；这些文件在 2026-09-26 的本轮样片测试期间创建并写入。它们未被删除、清空或拿来作为新测试库。旧项目 `D:\Desktop\resume DIY\.data` 未触碰。
- 原生启动现支持显式的绝对路径 `ZINECV_DATA_DIR`，默认仍使用 Tauri 的应用数据目录。`test:webview` 与 `test:native-shell` 均指向各自独立测试目录，并检查该目录存在 SQLite 文件。修正后 `npm run test:webview` 退出码 0，原生页面保存标题、刷新读回修订 1；测试前后默认 ZineCV 数据库主文件、WAL、SHM 的 SHA-256 全部未变（`PROTECTED_FILES_CHANGED=0`）。这才是当前有效的 WebView2 隔离证据。
- `npm run test:native-shell` 修正后退出码 0，隔离目录内实际出现 SQLite 文件。`Store::apply_command` 的读取/receipt 检查和写入已纳入同一 SQLite 立即事务，更新再核对修订/分支/上下文；`npm run test:native` 退出码 0，41 tests，包括双连接同时争用同一修订与同一命令 ID 的测试。重新构建 release exe 后 `npm run test:webview` 退出码 0，默认应用数据库三文件的测试前后 SHA-256 再次全部未变。
- 启动路径改用 `Store::initialize_document` 的立即事务：文档已存在返回“不创建”，不再调用可覆盖草稿的 `save_draft`；两连接同时初始化只有一个创建成功。该阶段 `npm run test:native` 退出码 0，43 tests；重新构建 release exe 后 `npm run test:webview` 退出码 0，默认 ZineCV 数据库三文件的测试前后 SHA-256 均未变。
- 后续修复 SQLite v1 全局 branch/commit 主键的多文档冲突：新文档使用按 document ID 区分的默认 branch 与 commit ID，查询始终采用文档记录中的活动 branch；保留既有 `main` 数据，不迁移或覆盖旧库。`npm run test:native` 退出码 0，45 tests，新增第二文档与旧 `main` 并存用例。`npm run build:native` 与隔离的 `npm run test:webview` 退出码 0；默认 ZineCV 数据库主文件、WAL、SHM 在测试前后 SHA-256 均未变。多文档 UI、模板上下文和旧版功能等价仍待开发。
- B05 恢复安全补强：打开现有库及备份前检查迁移版本和 checksum；高于当前程序的 schema 明确拒绝。恢复源只读打开，不会因路径不存在而创建空库；无迁移记录、缺少必要表的备份在覆盖当前库前拒绝。`npm run test:native` 48 tests、`npm run build:native`、隔离 `npm run test:webview` 退出码均为 0；默认应用数据库主文件、WAL、SHM 测试前后 SHA-256 均未变。仍须完成磁盘满、权限、强杀、备份并发等故障注入。
- 对照旧版 F24 后，新增文档初始化在同一事务中写入“初始版本”快照、提交和主分支 head；旧 SQLite 文档若还没有 head，第一次创建分支时补出可回退的主分支基线。`Store::create_branch_from_current` 对预期 cursor 做 CAS，当前草稿变为新分支提交并切换，原分支 head 不移动；重复名称/过期 cursor 拒绝。`npm run test:native` 50 tests、旧版 `npm run test:versions`、`npm run build:native`、隔离 `npm run test:webview` 均退出码 0；默认应用数据库三文件测试前后哈希未变。尚未接入正式版本 UI，F24–F29 保持 pending。
- 切分支存储事务现核对预期 cursor 与目标 head；当前草稿不同于 head 时要求显式确认，确认后切换到目标 head 并更新文档标题/修订号。目标分支如果留有不同于 head 的草稿，先拒绝以免静默清掉。切换往返保留已提交内容，过期 cursor 不生效。`npm run test:native` 53 tests、旧版 `npm run test:versions` 均退出码 0；尚未重建 release exe，且正式 UI 的确认与失败提示、历史载入及删除仍待接线，F25 保持 pending。
- 历史载入存储事务要求显式确认与当前 cursor，验证所选提交归属、快照 hash 和文档结构；仅覆盖当前草稿并递增修订号，不移动当前分支 head。文件库重启后仍读到载入草稿，后续提交仍接在原 head 之后；取消、过期 cursor 和跨文档提交均不改变当前草稿。`npm run test:native` 55 tests、旧版 `npm run test:versions` 退出码 0。正式 UI 和真实 WebView2 尚未接入该动作，F25 仍为 pending。
- 为后续 F26 删除提交预先修正提交身份和并发边界：`Store::commit_draft` 现要求预期 cursor，在立即事务中验证文档/上下文/分支/head/草稿修订，拒绝空说明和内容与 head 相同的提交；ID 使用随机不可按提交数复用的形式，成功后递增权威修订。相同内容的两个提交仍可由创建分支产生并共用一份 snapshot。空消息、无变化、过期 cursor 均不清空草稿。`npm run test:native` 56 tests、旧版 `npm run test:versions` 退出码 0；正式版本 UI、删除重接和 F24/F26 验收仍未完成。
- `Store::delete_commit` 在立即事务中验证确认和当前 cursor，将子提交的可见 parent、所有指向被删提交的 branch head 接回原 parent；删除当前 head 时先把工作内容保留为草稿，已有草稿无论删除哪个提交都同步修订号，失败回滚。中间节点、当前 head、跨文档拒绝、取消和过期 cursor 用例通过；`npm run test:native` 58 tests、旧版 `npm run test:versions` 退出码 0。尚未实现分支删除与祖先来源标记，也未接正式 UI，因此 F26 仍 pending。
- SQLite v2 新增 `branch_tombstones`，保留被删来源分支行以维持历史提交的外键；分支删除在立即事务中保护主分支、切回主分支或保留当前内容、清除不可达的独占提交，并保留其他分支可达的祖先及其“已删除来源”墓碑。已删除名称可重新使用，切分支不能进入墓碑；独立文件库关闭重开后墓碑仍有效。v1 备份先复制到内存暂存库完成迁移，再覆盖当前库，原备份字节不变。`npm run test:native` 62 tests、旧版 `npm run test:versions`、`npm run build:native` 和隔离 `npm run test:webview` 均退出码 0。正式历史列表/分支树和双窗口删除验收仍待完成，F26 保持 pending。
- 新增只读 `VersionGraph`（生成 TS 绑定）和 `version_graph` Tauri IPC：在同一 SQLite 读事务内返回权威 cursor、活动分支、提交 parent、来源墓碑标记；提交缺失 link 会报损坏，不用空历史掩盖。单元测试验证被删来源祖先，真实隔离 WebView2 验证初始 1 分支/1 提交来自 IPC。`npm run test:native` 66 tests、`npm run test:browser`、`npm run build:native`、`npm run test:webview` 均通过；正式历史列表/分支树未接入，F27 仍 pending。
- 索引的 `detect-changes --scope all` 把本次原生命令链路判为 high 风险；按实际源码核对了唯一写入口、修订 CAS 和失败提示。B06 仍为 in_progress，完整功能与视觉等价不得从样片推断。

## 2026-09-26 检查记录

- worktree 从 C 盘复制到 `D:\Documents\Codex\zinecv-v2\resume DIY` 后，41,063 个文件和 17,151,307,391 字节与源目录一致，未提交的两处 Rust 修改哈希一致；`git worktree list` 仅保留 D 盘该分支。用户已手动删除旧 C 盘工作树内容；后续复查原路径只剩空目录。旧 GitNexus 本地索引保留在忽略的 `.artifacts/gitnexus-index-before-d-drive-move/`，D 盘索引已重新生成。
- D 盘本轮 `npm run check:native`、`npm run test:native`、`npm run build`、`npm run test:browser`、`npm run build:native`、`npm run test:webview` 曾均退出码 0；Rust 40 tests，浏览器 2 tests，真实 WebView2 1 test。后来发现仅设置 AppData/LocalAppData 未隔离 Tauri 的实际数据库位置；该轮 WebView2 结果不能作为数据隔离证据。已在 2026-09-27 修复并复测，见下节。
- 复核上一轮未提交修改：默认文档 ID 现通过 JSON 值编码，含引号 ID 的单测通过；当前文档读取校验活动编辑上下文，错误上下文返回 CONFLICT。源工作区的 `src/`、预览冻结文件及用户 `.data` 均未修改。
- 后续接入 `apply_document_command`：页面只提交生成的命令封套与旧修订号，Rust 通过单一 `Store::apply_command` 写入；只有返回成功才显示“已保存”。当时 `npm run test:webview` 退出码 0，标题修改、刷新与修订 1 均通过，但数据目录未真正隔离。真实关闭进程后的持久性由独立文件库单测覆盖，正式编辑器的 IME、连续键入与跨窗口冲突仍 pending。

- `npm ci --no-audit --no-fund`（旧版隔离 worktree）：退出码 0。
- `npm run build`（旧版）：退出码 0；fixture 为当前公开空白默认及构建内测试场景，Windows 11 x64 / Node 24.16.0。
- `node scripts/version-schema-regression.mjs`：退出码 0，脚本使用隔离存储；未使用用户 `.data`。
- `node scripts/agent-runtime-regression.mjs`：退出码 0，离线虚构场景；不代表真实供应商联调。
- `node scripts/preview-interaction-regression.cjs`：退出码 0，独立浏览器覆盖轮廓、点击/键盘、纸面文字选区与链接修饰键、PNG/PDF 轮廓隔离；该结果只证明旧版当前行为，不代表 2.0 SVG 已有同等选字能力。
- `PREVIEW_BASELINE_DIST=<原工作区固定基线>/dist node scripts/preview-contract.cjs`：退出码 1，首个真实失败 `avatar::1440 right preview DOM/layout changed`；24 个情景，独立浏览器上下文。固定基线未覆盖。
- `PREVIEW_BASELINE_DIST=<本 worktree 当前 dist> node scripts/preview-contract.cjs`：退出码 0，24 个场景/29 个视口案例自比较一致，故意视觉扰动自测能触发失败；脚本只补上空白默认简历中缺失教育/项目条目的虚构测试回退。结果 `current-preview-selfcheck-20260926.json`。它只证明当前构建可被稳定比较，不证明 2.0 或历史固定基线等价。
- 修复测试夹具后重新对固定历史基线运行同一命令：退出码仍为 1，首个失败仍是 `avatar::1440 right preview DOM/layout changed`，并可见纸张位置、缩放等差异。历史基线保持原样。
- `npm run build`（desktop）：退出码 0，Svelte 检查 0 error / 0 warning；仅证明隔离样片可打包。
- `cargo check --manifest-path src-tauri/Cargo.toml --locked`（MSVC Build Tools x64 环境）：退出码 0；仅证明原生骨架可编译检查。
- `npm run verify:contracts`、`npm run test:unit`、`npm run test:browser`、`npm run check:native`：退出码均为 0；浏览器使用独立上下文，检查对象只是隔离样片。
- `tauri build --no-bundle`：退出码 0，生成本地 release `zinecv-desktop.exe`；不代表完整产品。
- `npm run bundle:online`：退出码 0，生成本地 NSIS 在线安装包 `ZineCV_2.0.0-alpha.0_x64-setup.exe`，SHA-256 `0E6632E26971F88F35C82FCB0122E2597065B6666625973D8AFC2CAC3BFE5628`；尚未在干净 Windows VM 执行安装/升级。当前体积约 1.83 MB，不包含未来字体、OCR、文档引擎或离线 WebView2 资源。
- `npm run test:native-shell`：退出码 0，release exe 保持运行 3 秒；后续发现 AppData 环境变量不足以隔离实际数据库，因此该次运行不算数据隔离验收。
- `npm run test:webview`：退出码 0，Playwright 通过 WebView2 CDP 控制 release exe 并断言样片状态文案；后续发现仅隔离 WebView2 用户目录和 AppData 环境变量不足以隔离 Tauri 数据库。2026-09-27 已改用显式独立数据目录重新验证。
- `npm run poc:engine`：退出码 0，Typst 0.15.1 内存 `World` 用虚构合同和项目内字体生成短/中/长 1/2/5 页 PDF、逐页 SVG 和首张 PNG，无编译警告；PDF 用 PyMuPDF 独立抽取确认 A4、中文与页数。生成物留在忽略的 `.artifacts/typst-poc`。详见 `typst-risk-evidence.md`。
- `npm run test:engine-poc`：退出码 0；内存 World 对未声明路径及越界字体索引拒绝访问。这只验证样片资源边界，生产 worker/host 资源协议尚未实现。
- `npm run check:native` 和 `npm run test:native`（Typst 依赖加入后）：退出码均为 0；后者主程序目前只有编译性测试，没有业务单测。
- `npm run build:engine-poc`、`npm run bench`（宿主字体资源握手加入后重跑）：退出码均为 0；release 命令行夹具模式三次进程总耗时 317.29/306.10/310.52 ms，原始数据和边界见 `bench-typst-poc-20260926.json`。不能用此代替正式端到端或常驻 worker 的性能验收。
- `npm run test:engine-worker`：退出码 0；真实 release 子进程复制到独立目录运行，按 hash 获取宿主字体并拒绝损坏字节，重复渲染、校验 PDF/SVG/PNG、协议版本/generation/参数/长度拒绝、过大资源响应后受控退出。该样片未接入正式 Tauri 宿主或真实 NSIS 安装目录。\n- `npm run build`、`npm run test:browser`（B03 样片加入后）：退出码均为 0；样片覆盖富文本命令、插入链接、真实指针拖拽、键盘重排、折叠/展开、分栏键盘和 Agent 形态。证据见 `b03-interaction-evidence.md`；不等价于正式 UI。\n- `npm run check:native`、`npm run test:native`（B04 Rust 权威模块加入后）：退出码均为 0；29 tests passed。\n- `npm run test:bindings`：Rust 导出测试退出码 0，25 个绑定无 drift 且 strict TypeScript 编译通过；首次运行在绑定提交前会拒绝未跟踪文件，属预期。证据见 `b04-domain-evidence.md`。\n- `npm run check:native`、`npm run test:native`（B05 SQLite 模块加入后）：退出码均为 0；38 tests passed，新增两连接旧 revision 冲突和新 revision 成功。证据见 `b05-storage-evidence.md`。

上述安装包 hash 来自加入 Typst 依赖之前的 B01 骨架构建。当前源码已经改变，故该安装包**不是**当前源码的可交付产物；后续 B02 worker 和资源协议定案后必须重新构建与安装验证。

旧版预览与历史基线的失败属于 B00 待分析项；受影响的 UI/A4 迁移不能据此认定等价。`desktop/docs/feature-parity.json` 保持 F01–F44、D01–D08 全部 pending，任何实测通过须绑定后续提交、命令退出码、环境、fixture 和证据路径。
