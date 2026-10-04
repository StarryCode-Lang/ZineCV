# ZineCV 完整审核、功能补齐、运行效率与轻量化执行计划

编制日期：2026-10-03，Asia/Shanghai。执行仓库：`D:\Desktop\ZineCV`；唯一原始参考仓库：`D:\Desktop\resume DIY`。

本计划交给后续 Agent 直接执行。这一轮完成了日志、文档、工作树、验收矩阵与关键实现的交叉核对，**没有实施以下代码任务，也没有声称已经逐行审核完全部代码**。逐文件逐行审核是阶段 A 的明确交付，功能补齐和优化是后续实施任务。

## 1. 先读结论与当前基线

1. 项目不是没有功能的空壳：React 正式 UI、Rust/SQLite 数据层、Typst 引擎、迁移、Agent、安装器都已有实现。但“P00–P17 已实现”不等于所有产品验收完成。当前 `feature-parity.json` 的正式状态是 **50 pending、2 blocked、0 passed**；切片中“24 项本地 RC 可用、23 项 partial”等是辅助分类，不是矩阵的正式状态。
2. 可以直接推进的缺口包括：旧头像/模板资源字节迁移、PDF 字段的来源页码、复杂导入语料覆盖、导入源图与导出语义、分支删除故障回滚、Agent 取消/预算竞争、导出磁盘满/占用、未授权窗口 IPC、PDF 搜索/链接/阅读顺序与标签核查。每一项先复现再修补，不能机械地把旧 `remainingIssues` 当成仍未实现的代码。
3. 引擎 SVG 预览和一页求解已有独立能力，**正式界面仍用 DOM 预览/DOM fit**。现行决定继续保留 DOM；几何与字体门禁未过之前，不切换默认渲染器，也不删除旧生产链路。DOM 与 Typst 导出的一致性仍需验收。
4. 上轮轻量化已完成字体静态去重、共享字体字节、宿主字体材料缓存和 release 编译选项。这些不是本轮待办。下一轮优先查 **worker 重复传字体、导出生成不需要的产物、前端与引擎重复携带字体、dev/test 调试信息与重复构建**。
5. 包体还能优化，但不能承诺无证据的“几 MB”。离线 OCR、PDF/DOCX 导入、完整字体、文本型 PDF、文献引用、许可文本和故障保护都必须保留。
6. 完成定义分为“本地可实现项完成”和“所有产品/分发门禁完成”。后者仍需要真实模型连接、真人输入法/辅助技术验收、干净 Win10/11 VM、签名材料与字体授权；缺材料时精确标记受影响条目，继续完成独立任务。

### 1.1 本轮直接核对的事实

| 项目 | 本轮观测 / 适用范围 |
| --- | --- |
| Git HEAD | `07a874b994aa57287e373c95ede5a691818df7c4`；存在大量已修改和未跟踪文件，工作树才是实施基线 |
| release 主程序 | `87,507,456 B`，约 `83.45 MiB` |
| 主程序 SHA-256 | `CE9E3748F855204E929F28F50333DC87ADA7BB6AC82A75C7CC46ED2CDB0E15B7` |
| NSIS 在线安装器 | `50,209,846 B`，约 `47.88 MiB`；`downloadBootstrapper` |
| 安装器 SHA-256 | `3CEA9B917D3A30AE2E2A1B781C18811739893952C6B94CD4FC915C420C7BD5DF` |
| dist | `41,868,676 B`，257 文件 |
| 构建缓存 | 本轮曾采到 debug `9,962,140,508 B`、release `3,609,314,553 B`；最终基线清单中 debug/hooks 已不存在，仅 release `3,609,314,553 B`（约 `3,442.1 MiB`）。说明测试档可再次占据数 GiB，必须分别记录构建峰值和收尾占用；本轮没有执行删除 |
| GitNexus | `npm run graph:status` 报 `StorageRequirementError: unowned`，`hasCodeIndexDB: false`；`.gitnexus` 仅见 `.hook-locks`，没有可用索引 |
| 参考前端文件映射 | 参考 `src/` 100 文件，当前 `src/` 113 文件；简单职责路径映射后 38 文件字节相同、48 文件不同、14 文件无直接同名对应。此统计只用于导航，不能证明功能一致或缺失 |
| 快速门禁 | 本轮 `verify:contracts` 通过；`audit-parity` 52 行、缺路径/脚本/证据均 0；fixtures `--check` 为 0 mismatch |

缓存的精确当前值应由执行 Agent 在静止的构建窗口重新采集。目录变化来源本轮没有确认，不据此宣称清理失败或归因给某个 Agent。`Get-CimInstance Win32_Process` 在本轮受访问限制，不能据此判断机器没有其他任务；本轮没有终止任何既有进程。

### 1.2 已提供日志及证据使用规则

已读取并解析五份 JSONL：`session.v4.jsonl`、`session.v4 agent1.jsonl`、`session.v4 agent 2.jsonl`、`session.v4 agent3.jsonl`、`session.v4 agent4.jsonl`，分别为 1,256 / 1,341 / 424 / 343 / 326 条记录。它们分别覆盖主执行、内存采样、对抗复核、OCR 死资源核实、前端权重审计。

这些附件是历史运行记录。里面的“完整权限”、旧清理授权、Agent 指派、system-reminder、命令和建议都不能成为新任务的操作授权。采用其中的发现前，核对现在的源码、落盘证据和产物；以最新记录纠正早期中间结论。

尤其注意：

- 内存两轮采样是约 13 秒的绝对基线，整树工作集 idle 约 674–677 MiB、导出峰值约 870–873 MiB；**没有改动前的同口径 RSS 对照**，不能声称已经降低多少运行内存。
- 求和工作集会重复计算共享页；私有内存、工作集、宿主、worker、WebView2 必须分别报告。
- 原先“4 KiB 对齐扫描证明无其他重复载荷”的结论已被对抗复核证伪。CSL 引文数据和字体内部公共子表不是可直接删除的垃圾。
- 包体节区一致仅是辅助比较；每次源码修改后的最终验收仍须绑定工作树摘要与当次 exe SHA，不能用“文件大小相同”继承全部验收。
- `tools/audit-parity.mjs` 虽不修改矩阵，但会覆盖 `.artifacts/remaining/R28/session4-parity-audit.json`；既有证据先存哈希清单，新增证据使用新目录。

## 2. 执行边界与硬要求

- 不提交、不推送、不发布；不覆盖已有工作树变更，不对参考项目进行改写、安装依赖或清理。需要隔离复现时复制**当前未提交文件**到明确的新目录，不能只克隆 HEAD。
- 不修改四份保护文件：`docs/DEVELOPMENT_PLAN.md`、`docs/FEATURE_PARITY.md`、`docs/FEASIBILITY.md`、`docs/target.archify.json`。发现旧描述与现状冲突，写入审核报告并在当前切片中解释。
- 不改变现有视觉、简历正文、A4 几何、分页、模板、编辑手感、智能一页不删字约束、匿名离线编辑、旧备份兼容或用户数据。明确需要改变架构/字体契约的事项，先完成可审查 PoC 与影响报告，再依据当时的用户授权决定是否合入。
- 原生构建、fmt、clippy、test 全部经 `tools/with-msvc.ps1`。日常启动用 `npm run dev`。参考浏览器服务仅用于独立对照，不新增正式浏览器启动入口，不操作用户正在使用的页面。
- 所有 `test:webview*`、原生 UI 对照、性能与内存采样串行；全量构建只有一个负责人。同一 profile、feature、编译配置共享缓存。禁止多个 Agent 同时编译或占用原生宿主。
- 大版本才安排一代缓存盘点；日常开发不反复清空 target。不可把删缓存释放磁盘算成降低编译依赖或运行内存。
- 删除前列出绝对路径、用途、可重建证据与恢复成本；按当前授权决定是否执行。五份桌面日志、`.artifacts/remaining/`、用户 `.data`、浏览器 profile、实际 SQLite/备份、原始资源与许可证不列入清理。
- `npm ci` 会重新安装此前手工剪掉的 pdfjs 可选 canvas 包；“依赖安装可复现”和“本机 node_modules 被临时删瘦”分别记账，不能混为成果。
- 类型生成文件不得手改。IPC 变动同步领域类型、宿主注册、权限、调用侧和人类可读契约，并重新生成绑定。

## 3. 阶段顺序与交付

| 阶段 | 做什么 | 依赖 | 退出条件 |
| --- | --- | --- | --- |
| A | 锁定基线、读完所有文档、逐文件逐行审核、建立问题清单 | 无 | 手写源码审核覆盖完整；每项问题可定位、可复现或明确待验证 |
| B | 与原项目逐功能对比并补齐内部缺口 | A | 全部参考能力有当前路径与验收；可本地修补的缺口闭环 |
| C | 建立同口径运行/构建/包体基线 | A；会用到 B 的固定夹具 | 指标、采样、环境、失败与产物身份完整 |
| D | 优化 worker、导出、前端、数据库与导入热点 | B、C | 保留能力与产物契约；对应指标有重复测量收益 |
| E | 去除重复字体、优化构建档与依赖/打包成本 | C；字体 PoC 另设门禁 | 真正发布体积/编译成本改善，无离线与视觉回归 |
| F | 最终完整专项、安装态、外部门禁与收尾 | B–E | 最终同一源码快照的报告、矩阵、产物和剩余阻塞一致 |

默认顺序：A → B → C → D1/D2 → E2（构建档）→ E1（字体去重 PoC）→ D3/D4 → E3 → F。运行性能先解决已确认的大块重复搬运；包体先消除重复来源；编译先减少重复任务和调试信息，最后才调整优化等级。

每个任务都记录：输入、基线摘要、实际改动、文件/符号、最小验证、退出码、失败、证据路径、对应 F/D/S ID、剩余项。每完成一项更新短状态，不复制整份计划。

## 4. 阶段 A：彻底审核，不遗漏文件或把文档当测试

### A0. 锁定当前工作树与原始参考

**入口**：两个仓库的 `AGENTS.md`、package/lock、当前切片、任务记录、实际构建输出。

**步骤**：

1. 记录两个路径的 Git 分支/HEAD/状态。对当前受保护文档、锁文件、手写源码、夹具、全部既有 `.artifacts/remaining/` 建立 `path + bytes + SHA-256` 清单；记录时间和工具版本。只收集参考项目源码/公开夹具，不复制个人 `.data`。
2. 将本轮附带 `plan-baseline.json` 作为启动参考，再生成执行时快照。新证据根用 `.artifacts/remaining/audit-plan-20261003/<run-id>/`，不要覆盖上轮原始采样和故障证据。
3. 保留当前 release exe/安装器的单份基线副本或可恢复副本，含大小/哈希/构建配置。优化前后用这份**实际工作树产物**对比，避免再次因清空 target 丢失对照。
4. 确认没有其他任务修改相同文件或占用构建/测试机器；建立构建与 WebView2 使用约定。拿不到独占测量窗口时做静态审核，暂不跑性能结论。
5. 所有 shell 脚本检查退出码；`Tee-Object` 不能吞原生命令失败。路径均先解析到工作区内；不跨 shell 拼接删除命令。

**输出**：`baseline.json`、`existing-evidence-manifest.json`、`worktree-manifest.json`、只读的参考版本摘要。

**验收**：快照包括未跟踪源码；原有变更无丢失；两个仓库没有相互覆盖；基线二进制仍可用。

### A1. 汇总全部文档、要求与验收证据

1. 逐份读 `docs/` 全部文本/JSON、README、IPC 契约、contracts、fixtures README/人工场景、CI、tools 中的运行说明。许可证文本列入资源/授权核查。四份原始依据按“目标要求”读取，现状以切片、任务记录和源码判定。
2. 把 B00–B15、R00–R32、P00–P17 目标映射到 F01–F44 / D01–D08。分别填写 `实现完成 / 正式 UI 接入 / 自动验证 / 真人或环境验证 / 公开分发`，避免一个“完成”掩盖其他层。
3. 逐条打开矩阵引用的证据，核对日期、代码/产物身份、fixture、覆盖场景和实际退出码。区分“路径存在”“schema 正确”“运行成功”“产品满足要求”。
4. 为过时的 `remainingIssues` 找到关闭证据；找不到就保留。新增发现用 `S-...` 且 `supplemental: true`，符合 `tools/acceptance-matrix.mjs`，不能为了固定 52 行而丢弃新能力。
5. 核对切片中旧目录数、旧安装包清理状态、旧测试数与最新 §15/task 的矛盾。只更新当前摘要，不重写保护文档或历史采样。

**输出**：`requirements-audit.json`、`backlog.md`。每个 backlog 项含严重度、类别、源要求、实际入口、可复现步骤、最小改法、测试与完成条件。

**验收**：每项强制要求有结论；“实现缺失、接入缺失、测试缺失、外部阻塞、文档过时”分开统计。不得直接宣称 50 个功能未实现。

### A2. 恢复调用图与建立逐行审核覆盖

1. 先运行 `npm run graph:status`。当前已知索引不可用；检查 `.gitnexus` 的准确内容和锁的归属，然后尝试项目自带 `npm run graph:index`。不要使用 `--self-commit`，不要让工具覆盖 AGENTS/CLAUDE 正文。
2. 如果 `unowned` 阻止初始化，按安装版本的帮助/文档处理索引目录所有权；只对已证明可重建的缓存提出精确处置。禁止把无索引、锁未确认或工具失败当成“无调用关系”。必要时明确记录工具阻塞，同时完成可独立的文件审核。
3. 索引可用后，对每条生产流程做 query/context/上游影响检查，仓库绑定 `zinecv-desktop`。跨 TS/Rust/worker/Typst/CSS/静态资源边界用源码与契约补足；空图结果不能证明死代码。
4. 枚举**全部项目手写文件**：`src/`、`src-tauri/src/`、`src-tauri/examples/`、`src-tauri/build.rs`、tests/tools、root 配置、contracts、fixtures 和 CI。每个文件逐行读；Rust 内联测试与 SQL 字符串也包括在内。第三方 vendor、node_modules、target、dist 不做无意义逐行阅读，改核版本、feature、许可和运行资产。
5. 建立 `review-coverage.json`：`path、sha256、totalLines、reviewedRanges、category、flows、findings、reviewStatus`。本轮只做 inventory 的文件不能标 `reviewed`。生成的 105 个 IPC 类型以源定义/生成器/零漂移门禁审核；二进制字体/模型以完整哈希、来源、重复载荷与真实加载审核。
6. 一次读取一个模块的完整文件，跟踪状态所有者、写入口、缓存寿命、异步取消、失败回滚、资源释放、数据复制、复杂度和热路径。大文件全读后沿调用展开，不仅查 TODO 或文件长度。
7. 用 `npm run audit:ast` 做只读结构核查；检查 TODO/FIXME/stub/mock、unreachable、孤儿 import、重复校验、无界缓存、循环依赖。命中必须人工复核，不能批量重写或看到 pub 未引用就删除。
8. 文件有修改后，仅使相关已审核范围失效并重审；收尾计算 `未读手写文件数=0`、`未覆盖行区间=0`，报告因生成物/二进制/第三方排除的理由。

**当前盘点的审核导航**：UI 94 个代码文件约 28,139 非空行；platform 13 / 2,611；独立引擎预览 4 / 409；Rust/Typst 23 / 30,974（含内联测试）；tests 36 / 5,524；tools 31 / 5,906。另含 `main-desktop.tsx`、examples、build.rs、配置与文档。数字是导航范围，非审核完成证明，执行时重新枚举。

### A3. 按生产链路审核运行效率和轻量化

| 链路 | 必读入口 | 必须回答的问题 |
| --- | --- | --- |
| 启动 | `main-desktop.tsx`、`useNativeBootstrap.ts`、`lib.rs::run`、identity/storage | 可编辑前加载了哪些组件/账户/图数据？哪些操作阻塞主线程或长持有锁？ |
| 编辑与持久化 | `App.tsx`、`RichEditor.tsx`、editorBuffers、NativeDocumentClient、useNativeResumePersistence | 一次键入触发几次 normalize/clone/stringify/invoke？IME/选区是否等 ack？失败是否保留输入？ |
| DOM 预览/分页/fit | useResumePagination、resume-pagination、ResumePreviewPane、PreviewOverflowGuard | 测量 DOM 复制多少次？读写是否交错？字体就绪是否重复触发？复杂度随页数/条目数如何变化？ |
| Typst worker | render_worker、render_scheduler、engine、fit/text_map/templates | 字体传输与解析次数、编译次数、旧修订取消、锁范围、缓存键、崩溃重放、进程与内存预算是否正确？ |
| 导出 | App::downloadResume、lib IPC、engine/export、export_io | PDF 是否被无关 PNG 像素预算阻止？是否构建不用的产物？大 base64 在多少层复制？取消是否仍做大量计算？ |
| 导入 | template-import、file-parser worker、recognition worker、import-draft、sandbox | PDF/DOCX/OCR 生命周期、页码/置信度、并发/取消、object URL/worker/canvas 是否释放？ |
| 版本与迁移 | storage/migrations/resources/proposals、migration、useNativeResumeVersions、BranchTree | 快照/资产是否重复？SQL/索引/事务完整性、千版本查询/比较复杂度、CAS/回滚是否可靠？ |
| Agent | AgentOverlay、context/runtime/sessions/stream、gateway/agent/identity | 关闭或取消后监听/流是否释放？预算与迟到结果是否阻止写入？秘密是否混入 UI/出站上下文？ |
| 构建/发布 | Cargo、with-msvc、verify-project、Vite、tauri config、quality.yml | 哪个 profile/feature 生成大文件？有无重复构建、重复资源、PDB误入安装器、不可复现的手工剪枝？ |

只把经调用与测量证实的热点送入 D/E。文件很长、名称相似或没有图连边本身均不是重构/删除理由。

## 5. 阶段 B：原项目逐功能对比与补齐

### B0. 先建立行为对照，避免按文件数量判断缺功能

1. 从 `D:\Desktop\resume DIY\README.md`、旧 `src/app/App.tsx`、全部 `src/components/`、services/domain、server、30 个 scripts 中提取真实可达功能。已知旧项目没有云同步、模板市场、文本型 PDF；不把这些当成遗漏的原功能，文本型 PDF 属现有桌面新增要求。
2. 用当前 44+8 矩阵覆盖所有参考能力；发现遗漏追加 S-ID。每项记录旧入口/旧行为/旧测试、当前 UI 入口/当前权威实现/迁移替代、验证结果。
3. 对 14 个无直接同名对应的旧前端文件逐一追踪替代：persistence/versions→platform hooks，export→Rust export，initial-resume→resume-model 合并，summary/toolbar→组件内合并，snapshot equality→version-schema；`AiAssistantPanel` 等先核真实调用再判断是否为退役代码。**没有同名文件不是功能丢失。**
4. 用相同虚构文档、字体、视口、DPI、zoom 比较三工作区和三个模板；独立参考服务/浏览器 profile，端口先确认空闲。默认参考路径必须显式为 `D:\Desktop\resume DIY`，不得用旧 worktree。
5. 优先复用旧回归的用户操作与断言，而不是把 browser/server 的实现复制回桌面。涉及版本存储的旧测试适配隔离 SQLite/IPC，禁止对旧 `.data/versions.json` 写入。

### B1. 52 项功能对照的最小执行场景

| ID | 执行场景与补齐范围 | 当前入口 / 最小验证 |
| --- | --- | --- |
| F01–F04 | 新 profile 空白、已有草稿恢复；全部 basic 字段/年龄生日/头像 round-trip；十模块+summary 的空/最后条目、隐藏恢复、同名不同 ID、标题修改 | App、editing、domain、storage；unit + 真实宿主重启/持久化 |
| F05–F09 | 全富文本工具、粘贴/撤销/链接选区/Esc；微软拼音确认/取消/标点；快速拖拽/折叠/边缘滚动；导航/复制顺序与失败提示 | RichEditor、buffers、navigation、copy；browser/WebView2，IME 需真人 M |
| F10–F15 | 三模板各 1/2/5 页；全部布局控件组合；一页成功/失败回滚且不删正文；20%–200%、分栏/全屏/DPI；点击/键盘定位、纸面选字、跨页复制/链接 | 默认 DOM 与独立 engine 分开验收；visual/engine parity、preview/fit 专项；未通过几何时不替换默认 |
| F16–F19 | PDF、PNG/长图、原生保存与取消；导入原图覆盖/退出/导出语义；模板 density/overrides 与未知版本恢复 | export/WebView2、source overlay、templates；真人选路径另记 M |
| F20–F23 | 收藏/最近使用/重命名/删除后真重启；PDF 多页/双栏/损坏/加密/缺 ToUnicode；DOCX 表格/列表/文本框/浮图/页眉脚；中英 OCR/旋转/低清/取消 | template-import、workers、import-draft、sandbox；golden + packaged WebView2 本地加载 |
| F24–F30 | 提交/未提交变化/分支/历史/祖先保留；树交互；备份替换不覆盖草稿；双窗口 CAS；完整旧类别/编辑上下文/资源迁移 | native versions、storage、migration/resources；隔离数据库/故障/真重启 |
| F31–F36 | 匿名离线、账户隔离、登录退出；provider/Key 增改删重启；能力探测/流式；三形态与三工作区会话；显式引用/同名 ID/出站预算 | identity、gateway、agent_context、AgentOverlay；本地回归 + 真实模型 R + 跨用户条件 |
| F37–F40 | 本地只读技能/版本比较；全部受控提议审阅/确认/冲突/撤回；取消与预算竞争；会话/账户/Key 迁移及脱敏 | runtime/context/proposals/legacy_identity；真实宿主竞态 + 真实模型；不迁旧明文 Key |
| F41–F44 | 减少动效/中断；弹层 Tab/Esc/焦点/DPI/滚动边界；存储错误/中文文件路径；完整视觉/许可/空白公开示例 | UI + 原生文件；V/N/M，字体授权单独阻塞 |
| D01–D03 | 无 Node/Rust 的干净安装；WebView2 在线/离线首用；所有字体/OCR/PDF/许可资产安装态可用 | NSIS、offline config、installed app；VM 必须真实 |
| D04–D05 | 非管理员/中文路径/升级/卸载留数据；签名、真实更新/回退要求核对 | 安装器/runbook/签名材料；VM/证书不足保持 blocked，不能把 schema 回退当成完整更新验收 |
| D06–D08 | worker 限额/超时/重放/退出无驻留；未授权窗口 IPC 拒绝；PDF 可搜索/链接/结构顺序；另一执行者从完整源码快照干净复现 | hooks、capability、PDF 检查、verify-project 与安装态；最终产物身份必须一致 |

### B2. 优先补完整旧资产迁移（F02/F28/F30/F40）

**入口**：`migration.rs`（`avatar_asset_needs_transfer`、模板 source/assets 计数）、`storage/resources.rs`、`storage/legacy_identity.rs`、`platform/legacyImport.ts`、legacySnapshot/documentBridge。

1. 按旧导出实际类型列出：草稿、每模板编辑上下文、版本树与历史快照、头像 data URL、导入模板预览/源资产、收藏/最近使用、账户/provider/会话/秘密登记。确定哪些旧数据只保存元数据，不能捏造原文件。
2. 为头像和确实存在的模板字节实现有预算的解码、MIME/签名核查、内容哈希寻址；生成文档/历史快照的资产引用并核对引用闭包。使用已有资源事务/租约/发布恢复机制，不造第二个资产库。
3. dry-run 返回来源数、可迁移数、缺失/损坏数、需重输数、冲突及来源路径；有缺字节时提供明确报告，不能“迁移成功”却丢图。
4. 迁移确认时把领域写入、资产发布与提交收据组成恢复安全的流程；只追加 schema migration。失败不留半份新数据库，重复导入幂等，同名不同 ID 不合并，历史快照也能读到原头像。
5. 加入同资产去重、头像替换、缺模板源图、损坏 data URL、大资源预算、取消、双窗口竞争和提交前后强杀场景；真实关闭后重启、备份恢复核对哈希与图像可见。
6. 旧明文 Key 不迁入；旧 DPAPI 密文仅登记需重新输入的行为保持。跨 Windows 用户不能解密要明示，不能伪造迁移成功。

**验收**：所有可恢复旧类别按来源逐项对账；缺原始字节有明确诊断；已有迁移/强杀/提议资产/持久化专项不回归。

### B3. 补 PDF 页码证据与复杂导入（F18/F21–F23）

1. 追踪 `template-file-parser.worker.ts` 中已有 `pageNumber`/item.page，经 template-import、recognition worker 到 `import-draft.ts::candidatesFrom`。核对在哪一步降成纯文本或字段证据固定默认值。
2. 保留可定位的 `page + text/range + confidence/source`，字段映射时绑定真实证据；跨页字段记录多个来源或首个可靠来源。DOCX/图片没页码不能编造 PDF 页码。
3. 增加至少一份“目标字段只在第 2/3 页出现”的可控 fixture，assert 审阅候选、Rust 存储、重启读回、应用后来源一致；用结构化 evidence 验证，而不是仅比较显示文本。
4. 增补表格/文本框/浮图/页眉脚 DOCX、双栏/缺 ToUnicode PDF、扫描/旋转/低清图片。输出映射、置信度、低置信度需校正提示、unsupportedFeatures 和失败诊断；不承诺复杂版式 100% 自动识别。
5. 在**打包/安装态 WebView2** 用隔离 profile 验证中英 OCR，捕获 worker/core/language/PDF 资产请求，确认离线加载，无外部请求，特别补齐上轮没有完成的删除独立 wasm 后安装态链路。
6. 确认导入源图覆盖、首次打开、编辑后退出、重复打开与导出画面/标识保持原契约。不能静默以引擎重排图替代用户当前选择的源图语义；发现差距直接补齐明确行为。

**最小验证**：import-quality-golden、synthetic PDF/DOCX、sandbox、local OCR；新增安装态导入专项为计划中新任务，先实现再调用，不假装已有 npm script。

### B4. 关闭导出、版本、Agent 与权限故障缺口

1. `export_io.rs` / F17/F43：隔离目录的文件占用/无权限/写盘中断；磁盘满用已有故障 hook 或受限虚拟盘/可注入写入器，绝不填满系统盘。确认错误码、输入不丢、按钮恢复、部分文件处理和重试。
2. F16/D07：从真实最终 PDF 提取中英文文本、链接 annotation、页序、阅读顺序和字体覆盖；检查结构树/标签。若只是没验证，补证据；若实际缺失，沿 Typst 已支持的导出参数/模板语义补齐，不能给图像 PDF 加一个假文本层就宣称可访问。
3. F26：分支删除与提交删除覆盖失败回滚、祖先/其他分支共享节点保留、资源引用、重启读回；沿现有事务实现修，不重新设计版本系统。
4. F37–F39：只读技能完整 UI、预算终止、取消/确认同帧竞争、迟到流片段/工具结果、账号/会话切换与撤回；确认任何迟到结果都不能绕过 proposal/CAS 写入。
5. D06：隔离创建未授权窗口/不允许的调用来源，真实宿主证明 IPC 拒绝且无状态变化；测试路径不得降低正式 capability 或让测试权限进入 release。
6. F16/F17/F42：准备一次人工 PDF/PNG 中文路径选定并保存、焦点恢复、Tab/Esc、IME 和辅助技术验收清单。自动化定位不到系统文件名控件就保留 M 条目，不能再次把“对话框检测失败”当产品无弹窗。

**验收**：新增行为/故障有可证伪断言；本地可完成项无缺口；真人与外部条件明确列出对应 ID、所需输入、可立即复验的步骤。

### B5. 处理几何/字体门禁与默认 UI 接入

1. 用 engine-parity 重新核对三模板 × 三文档的九组合，保留历史失败和差异图；补 1/2/5 页、头像、长条目、页尾、混合列表、长链接与布局控件极值。
2. 每个失败定位为“布局参数、字体/字重/字形、密度单位、分页、TextMap/定位”之一。可在现有字体与视觉契约下修正的参数先修；授权和字形材料缺失准确阻塞。
3. Georgia/iconfont 未取得可分发授权时不擅自替换或削减字体。需要字体替代，先产出授权来源、同场景视觉差异、代价与回退方案，交用户审查。
4. 独立验证已实现的 EngineSvgPages、links/TextMap/跨页选择与 fit。明确区分方向算法通过和希伯来字形显示通过；没有字形不能伪称支持。
5. 现行保留 DOM 决定继续生效。未来若要切默认引擎，前置条件为几何/功能门禁全过、用户授权、默认 UI 全接入（缩放、定位、选字、键盘、外部链接、fit、保存）和完整对照。完成后才能讨论退役 DOM 生产链路。

## 6. 阶段 C：先测量，锁定优化判据

### C1. 冻结夹具、环境与采样协议

- 环境：Windows/WebView2/CPU/RAM/SSD、Node/Rust/MSVC、显示缩放/DPR/视口、电源与背景负载；二进制/工作树/lock/字体/template/fixture SHA。
- 场景：空白、三模板、1/2/5 页、20/100/500 条目、头像、富文本嵌套列表、长链接、1000×50 KiB 版本、PDF/DOCX/OCR 导入与渲染并发。
- 每个非冷启动场景至少 30 次，冷启动至少 10 次，3 轮；报告 p50/p95/max、失败次数、样本数与波动。脚本默认常只有 5/10 次，必须显式调参或扩展。
- 内存增加至少 30 分钟真实交互 soak，结束后等待稳定；统计私有内存增长、工作集、各角色峰值、worker/监听器/对象 URL 数量。先校准采样器开销，不把 CDP 测量环境直接当普通启动足迹。
- 构建分别测 clean、no-op、只改 UI、只改当前 Rust crate 四种场景；区分 debug/test/hooks/release、目标与 feature。记录 target 子目录、rlib/rmeta/obj/PDB/增量文件大小和 build timings。
- 对照基线和候选必须同机器、同功能、同字体、同输入、同采样器；不能通过关闭能力或降低 DPI 获得性能“收益”。

### C2. 保持既定预算并区分待校准指标

| 指标 | 既定目标 / 判据 |
| --- | --- |
| 普通键入反馈 | p95 ≤50 ms；IME 不等待 IPC |
| 1–2 页编辑至预览 | 热态端到端 p95 ≤250 ms，含 debounce/IPC/编译/绘制 |
| 5 页复杂预览 | 热态 p95 ≤750 ms，持续输入只应用最新修订 |
| 冷启动至可编辑 | release 目标 ≤2 s；引擎/助手预热另计 |
| 模板切换 | p95 ≤500 ms |
| 5 页 PDF | p95 ≤2 s；必须区分纯 engine PDF 与真实 UI `render_document_export` 路径 |
| 拖拽/折叠 | 60 Hz 下 p95 ≤16.7 ms；统计 >100 ms 卡顿，不能只报 p95 |
| 1000×50 KiB 提交 | p95 ≤150 ms；资源另外计 |
| 内存 | 30 分钟应平台化、任务结束释放；原 500 MiB 是待校准压力预算，工作集/私有口径未同一前不能假称已达标或静默改预算 |
| 轻量化 | exe/安装包/dist、target、node_modules、编译耗时/峰值 RAM 全部分开；以实际发布包实测，原始字节和 Brotli 估算只做归因 |

一般候选先做短筛选，功能与热点测试通过后对胜出方案做上述完整测量。明确收益小于噪声的改动撤回本任务 hunk，保留实验记录；不损坏别人的在途修改。

## 7. 阶段 D：运行效率优化工作包

### D1. 消除每次渲染重复字体传输和解析（最高优先）

**确认入口**：`render_worker.rs::bundled_font_materials/host_resources` 已缓存宿主材料；但 worker 渲染中每次遍历资源、发 `ResourceRequest`、解 base64、核 SHA；`engine.rs::DocumentWorld` 的字体缓存还要检查何时被命中。约 23 MB 字体每次变成约 31 MB base64 文本，宿主零拷贝不等于跨进程零传输。注意：fit 的 16 个候选在一次 worker 操作内编译，不得虚报每个候选都重新走一次管道。

**步骤**：

1. 在测试构建/基准记录每次请求的字体资源请求数、base64 字节数、编解码/哈希耗时、字体解析数和 compile 次数；release 不永久加入高频诊断。
2. 首选保持现有消息形状：worker 按完整 `role/hash/size/mime/resourceVersion` 缓存验证过的不可变字体 `Bytes`；命中则不请求字节，未命中按原协议请求/校验。缓存限定固定字体角色，按 generation 生命周期，禁止无界收集所有资源。
3. 核对同 exe worker 能否直接使用自身内嵌字体且严格验证 descriptor；若更简洁可做对照 PoC，仍必须拒绝哈希/版本/角色不符。不要为此引入共享内存、文件服务或第二套字体登记。
4. avatar 不沿用全局字体缓存策略；以内容哈希核对当前冻结文档，限制大小，保证账户/文档切换无旧图串用。
5. renderKey 保留 cursor、document、格式、模板、字体身份与日期；不得为了缓存省略身份输入。worker 重启要重新建立资源状态；崩溃重放使用同一冻结输入。
6. FONT_CACHE 若目前只匹配静态指针而实际接收字节不能命中，改为按已验证资源身份复用 FontBook/Font。一次 worker generation 同字体只能解析一次，字节变更必须失效。
7. 更新 `typst-worker-poc.test.mjs` 中必要的协议断言，保留错误版本、资源篡改、超时、内存上限、重放、生产零钩子、并发 lane、旧 generation/迟到响应测试。

**验收**：首请求后相同字体的重复请求传输量为 0；重启后正确重新初始化；预览/PDF/PNG/TextMap 与基线同字体同输入一致，符合本项目的确定性约束；实际热态耗时/私有内存不退化。最小 gate：native（含 hooks）、engine worker、WebView2 preview/fit/fit-faults/export/hooks。

### D2. 导出只计算用户需要的产物

**确认入口**：`App.tsx::downloadResume` 对 PDF 和 PNG 都调用统一 `render_document_export`；`engine/export.rs::render_frozen_export` 总是检查 PNG 像素、制作逐页/长图并输出 PDF/TextMap。PDF 路径可能承担不需要的栅格工作，甚至受 PNG 预算影响。先在真实路径复现，不能用仅 PDF 的旧命令基准替代。

1. 分解 compile、PDF 编码、TextMap、逐页栅格、长图、base64/JSON、写盘耗时和峰值内存；记录一份 5 页及一份足以触达 PNG 预算的文档。
2. 在原统一冻结编译链路增加向后兼容的产物选择：老调用默认仍完整 bundle，UI PDF 请求仅 PDF 所需数据，UI PNG 请求所需页/长图。新增类型/字段同步 public IPC 契约、绑定与调用方，不手改生成文件。
3. PDF-only 不执行 PNG 分配、编码或像素预算；PNG-only 不制造无消费者的 PDF/重复栅格。预览/导出 revision、页数、纸面参数和字体保持一致；不能恢复旧截图型 PDF。
4. 在既有像素/字节上限内逐页处理，减小同一时刻的 Pixmap/PNG/base64 副本；只在实际消费者需要时制作 TextMap，保留兼容默认返回。
5. 再核取消：可行时先选择保存路径并冻结所需状态，取消不启动昂贵导出；若会改变原生交互/修订语义则先保留现行顺序，只优化计算。不以提前保存牺牲原子性或覆盖用户文件。
6. 覆盖 PDF-only/PNG-only/完整 bundle、中文路径、取消、超像素大文档、长图回退逐页、写入错误和二次点击竞争。

**验收**：完整 bundle 能力保留；PDF-only 不被无关 PNG 限额拒绝；5 页真实 UI 路径达到原预算；PNG 默认 DPI/页序/白底/长图契约不变；保存故障反馈正确。最小 gate：export unit + bindings/contracts + WebView2 主流程/export。

### D3. 前端启动、热编辑、分页和交互

**入口**：App（约 1,957 行）、AgentOverlay（约 4,230 行）、main-desktop、motion、RichEditor、useResumePagination、ResumePreviewPane、Vite manualChunks。这些行数是审核提示，不是强行拆文件指标。

1. 用实际 release/CDP/React profiling 分开测模块加载、首次提交、状态初始化、助手挂载、首次编辑。入口 App 的 dynamic import 是立即发生，不能当作按需加载收益。
2. Agent 常驻 Bot 是现有功能；若懒加载，保留立即可见且可操作的轻量外壳，点击时无丢输入/会话/引用/焦点，错误可恢复。先识别真正重的设置、会话或提议视图，优先延后这些部分，不简单延后整个 Bot。
3. 检查 `motion domMax` 是否还有 layout/drag/特定动画能力消费者；只有全引用核查和动效回归证明无需要时才切 domAnimation。保留 reduced motion、中断和拖拽反馈。
4. 用打包 graph 与首次导入请求确认 `import-tools` 是否把 PDF、DOCX、OCR 绑定成一个大块；改为按真实导入路径分块，按需 worker 动态 import。安装态仍带齐资产；区分启动成本与安装体积。
5. 找到键入热路径中的深拷贝、全篇 normalize、重复 derived state 与 stringify；复用已有 editor buffer/权威 snapshot，在 CAS/失败恢复/账户隔离完整的前提下减少重复计算。不得通过推迟可见文本或等待 IPC 降低采样数。
6. 分页与 overflow 做测量读写分批、稳定依赖与必要的去抖/同帧合并；保留 `document.fonts.ready`、隐藏测量副本和准确页尾。连续 resize/拖拽只能按最新状态应用。
7. 加缓存前写明键、失效条件、最大条数/字节、任务结束释放。只在 profile 证明热点时加 memo/虚拟列表，不能引入第二个权威文档状态。

**验收**：实际冷启动/热编辑收益显著，A4/像素/DOM 行为无未经解释差异；富文本选区、IME、撤销、拖拽、助手三形态不退化。最小 gate：TS、unit、相关 browser、visual、真实 WebView2 主流程/Agent UI/持久化。

### D4. SQLite、版本图、Agent 与导入资源生命周期

1. 对千版本与重复资源操作计数：SQL 次数、扫描行数、完整快照读取/哈希次数、事务锁持有时间。先用现有索引与 query plan；只有证实热点时追加最小索引或分页查询。
2. BranchTree/版本比较避免每次 render 全图重复遍历；读取分页不能丢祖先/当前 head/共享节点。保持 scrypt、DPAPI、SQLite 安全事务与备份保护。
3. 数据库/worker/gateway 的 Mutex 审核：确认 async 网络/编译期间是否不必要持锁；沿现有 spawn_blocking/任务边界缩短锁范围，不造新调度框架。
4. 导入与 Agent 全生命周期核查 worker terminate、AbortController、流 reader、Tauri Channel/监听注销、document.fonts 监听、object URL revoke、sandbox iframe/canvas/PDF page cleanup。缓存只保留真实重用部分。
5. 30 分钟编辑/导入/取消/模板切换/提议/导出后，回到 idle 测私有内存与对象数；重启/关闭后 worker 无驻留，数据和草稿不丢。

**验收**：原提交预算与 CAS/回滚成立；压力后的私有内存平台化/回收有曲线与数据；不把一次 GC 波动当下降结论。

## 8. 阶段 E：包体、构建缓存与编译成本优化

### E1. 前端与引擎字体只保留一个发布字节来源

**收益是候选估计**：前端 CJK 字体已有 Brotli 压缩，历史估计再去重约 13 MiB 的 exe 资源；实际 NSIS 收益必须重建后测，不能简单将 raw/Brotli 数直接扣到安装器。

1. 核实 `responsive.css` 的 regular/heavy @font-face、iconfont CSS 的各格式，当前 Vite/Tauri 资源嵌入及 dev/browser 测试供给。引擎三份 static 字节已去重，不重复做上轮工作。
2. 首选最小 PoC：Tauri 自定义只读 URI 协议返回**既有内嵌字体字节**；固定白名单/哈希路径，正确 MIME、缓存头、method 与路径核查。Windows protocol origin、CSP font-src 与必要 CORS 按锁定 Tauri 版本确认。
3. 仅改变发布态字体获取路径；开发态/browser 对照通过受控资源映射供给相同字节。产品维持 `npm run dev`；不新建外部字体服务或云下载依赖，不放宽 CSP 为 `*`。
4. 在完全相同字体 bytes/weight/family/display 下验证 visible paper 与 hidden measurement font readiness、粗体、fallback、分页、TextMap、导出；自定义协议拒绝任意文件/用户资产读取。
5. PoC 的审查包必须包含：受影响文件/调用、CSP diff、fallback/失败行为、同输入对照图、包体实测与回退方法。若当时仍需架构变更确认，此时才请求合入授权，先完成不依赖合入的工作。
6. 获准后从 release frontendDist 排除已由协议供应的原字体文件，保留源字体文件和 licenses；不要删除引擎 `include_bytes!` 输入。必要的 fixture 资源路径变化通过生成器重生并解释每项哈希变动，不能重录视觉标准。
7. 实测 exe 节区与 NSIS 包，完整 WebView2 + visual + 安装态断网字体/OCR/PDF/DOCX 验证。只有“所有 DOM 字体确实加载、无跳字、无重分页差异”成立才能保留。

**验收**：发布二进制仅一个字体原始材料来源；前端读到的完整字节与既有字体相同；离线且不依赖源码树运行；默认 DOM 预览和 A4 合同不变。

### E2. 把“构建十几个 G”拆成可验证的根因并优化

**入口**：Cargo.toml、with-msvc、verify-project、quality.yml、target 子目录。当前 `[lib]` 同时输出 staticlib/cdylib/rlib，dev/test 默认调试信息，hooks 继承 release，native-hooks 的 Rust 单测仍在 test/debug 档；这些需分别量化，不能把 hooks-test 当成 hooks profile 构建。

1. `cargo --timings`、tree/features/duplicates 等命令由 MSVC wrapper 新增明确只读/诊断任务来执行；先检查现有 wrapper 的 ValidateSet，不能传不存在的任务。记录 crate 数与慢依赖，区分全量重新生成、链接、proc-macro 与缓存命中。
2. 建立 no-op 构建判据：无源码/配置/feature 变化时不重新编译依赖。检查脚本重复 Vite/build:native/tauri build、build.rs 输入追踪、env 变化、统一 CARGO_TARGET_DIR、锁文件与 feature 差异。
3. **先试 dev/test 调试信息**：在最小候选配置对照 `debug="line-tables-only"` / limited；必要时仅第三方 package 设 `debug=0`、自身保留可定位信息。保持 test/dev 的 unwind、debug assertions、overflow checks 等语义。完整 debug 作为明确诊断选择，不把每次开发都强迫为 fat LTO。
4. 比较开启/关闭 incremental 的“冷构建占用 + Rust 小改耗时”；不是默认关闭。只有在项目的磁盘/重建成本取舍有数据时确定配置；不反复 clean。
5. 查 Windows 桌面当前 staticlib/cdylib/rlib 的真正消费者，包含 Tauri、binding/native tests、examples/CI；确认无移动端/外部链接契约才试减少 crate-type。成功编译 + 主流程/安装态证明后保留，不能因文件后缀大就删配置。
6. release 现有 fat LTO/CGU1/panic abort/strip 保持为对照，有限比较 `opt-level=3` 与 `s`、fat 与 thin；`z` 只在前两者仍有明确收益空间时试。每次只改一个因素，胜出后组合验证，避免创建大量 full target。
7. 选项选择同时看 exe/NSIS、Typst/导出/启动/fit、冷/小改耗时/峰值 RAM；不为小包牺牲现有运行预算。panic=abort 既有语义不随意切换，测试 harness unwind 与生产 abort 需分别验证。
8. 重用已有 `verify-project` 调度而不是再造总运行器；补登记缺失的 WebView2 专项与 hooks 前置依赖，让 build:native 和 build:native-hooks 在一个冻结源码快照中各最多一次。包体不同配置实验是例外且要单独记账。
9. CI 如需缓存，按 lock/toolchain/OS/profile/features 建键；只缓存可重建产物。减少重复构建不等于少跑行为门禁，禁止靠删测试/放宽断言提速。

**验收**：给出各 profile 字节与耗时 before/after；no-op 不重编全树；日常小改复用缓存；纯测试不会被误当发布安装器；一次验收不重复生产构建。新配置可以稳定重现，不靠手工删除 node_modules。

### E3. 依赖、资源与 NSIS 的最后精简

1. 记录 Cargo 实际启用 feature 树与重复版本，不按 Cargo.lock 的名字数当运行依赖。reqwest/TLS、Typst 引文/字形、SQLite backup/serialize、Tiptap peer、html2canvas DOCX 缩略图等先证实调用。
2. 只有证明未用且所有平台/feature/test consumer 无需要时关闭 feature/移除依赖；更新 lock 后补最小有效验证。真实 HTTPS 未验收前保持 TLS 实现，不为了省编译 CMake 就切掉真实连接保障。
3. 逐项核 public/pdfjs/OCR/fonts/licenses，分别列 raw、dist 压缩、exe 实际载荷、NSIS。CDC/逐字节扫描只提供候选，字体公共子表/CSL 能力数据不能删除。
4. pdfjs cmap/standard_fonts/wasm、非 SIMD fallback、chi_sim+eng 模型保持；不得子集化中文字体、OCR/Typst 字形、关闭可搜索 PDF或改成在线下载来做零功能损失的轻量化。
5. 不把字体重封装 WOFF2 当主要安装包优化：Tauri 已压缩原字体，收益须实际包证明；任何资源格式/路径变化还要过 Typst、fixture 与许可校验。
6. 核 NSIS 实际安装布局、只含应用必需载荷，不携带 PDB、Rust 库、源码、分析图和诊断日志。在线包与内嵌 WebView2 的离线包分别比较；默认仍在线 bootstrapper，离线能力保留。
7. 只有本机 NSIS 支持且实际测量有价值才试压缩参数；报告安装包 bytes、安装时间、安装峰值 RAM、启动与 hash 链。避免 UPX 等引入解压启动/签名/AV不确定性的手段。

**验收**：所有依赖/资源变化可复现、有引用证据、安装态能力完整；没有“看起来没用”或仅 lock 名称支撑的删除。

## 9. 阶段 F：最终验收、外部门禁与交付

### F1. 建立一次冻结源码的最终验证调度

当前 `tools/verify-project.mjs` 的 `ci` 与 `full` 基本相同，仅包含通用 browser/native/worker/主 WebView2/visual。**它没有包含上轮完整 12 组 WebView2 专项，也没有覆盖全部安装/性能门禁**。修补完整调度属于验收基础设施任务；在补齐前，不能以 `verify:project --suite full` 代替完整验收。

先用下列已存在命令检查计划，不能启动重复全量任务：

```powershell
npm run verify:project -- --plan --suite full
npm run verify:project -- --plan --suite fast
```

最终构建配置确定、源码冻结后，编排：

| 组 | 必须验证的已有入口 | 前置 / 说明 |
| --- | --- | --- |
| 轻量静态 | check:ts、verify:contracts、test:unit、相关 AST、fixture `--check`、license inventory `--check` | 文档/配置变更先跑；不会提前重建整个 Rust 树 |
| 原生 | check:native、test:native、test:native-hooks、test:bindings | wrapper；确认生成器日志成功 + 105 绑定零漂移；新增类型后数量可变但必须解释 |
| 浏览器 | test:browser、test:visual-parity | 真实能力断言；固定输入/字体/视口，不重录标准过关 |
| Worker | test:engine-poc、build:engine-poc、test:engine-worker、test:native-shell | 协议变化重点；旧 export_document_pdf 仍被故障测试使用，不随意删除 |
| 正式原生构建 | build:native；必要 hooks 宿主 build:native-hooks | 同 profile 共享一次；打包同源码可复用 release，新增编译要解释原因 |
| WebView2 串行 | test:webview、test:webview-export、test:webview-migration、test:webview-migration-crash、test:webview-proposal-assets、test:webview-agent-ui、test:webview-persistence、test:webview-publication、test:webview-preview、test:webview-fit、test:webview-fit-faults、test:webview-hooks | 依赖 hooks 的 4 组以测试实际路径核实；每组结果绑定真实 exe/profile |
| 新补专项 | 页码 provenance、完整资产迁移、版本删除/预算取消/未授权 IPC、安装态 OCR、PDF结构与格式选择 | 本计划中需要新实现的测试，不假装已有 scripts |
| 纸面 | engine-parity + 旧版/DOM visual、三模板九组合与扩展页数 | engine 示例可先 build:engine-render；未过门禁必须留失败记录 |
| 性能 | template/pdf/drag/commit/import/legacy bench、启动/热预览、30min soak、构建与包体 | 串行、固定样本、3轮；命令默认样本需提高 |
| 安装态 | package:windows、在线布局/hash/启动/导入/导出、offline 配置构建、断网与升级/卸载 | 离线包只在有需要的最终验证构建一次；VM/签名另记 |

测试失败先归类产品、测试运行器、环境/竞态，保存首失败日志。CDP 页面未挂载的 `locator` 竞态应修稳定等待，不无限重试后只报告最终绿；确定性的行为回归必须修。

### F2. 精确证据与矩阵状态

1. 每个 `passed` 按现行 `verify-contracts.mjs` schema 生成 JSON：`schemaVersion:1`、`featureId`、`revision`、`recordedAt`、`checks`；每个 check 含 U/B/N/V/M/D/R、命令、退出码或人工 accepted/reviewer、fixture 路径/哈希、结构化环境。
2. 未提交工作树不能仅以 HEAD 宣称适用修订；`revision` 使用可追踪的 `HEAD + worktree digest` 标识，并确保 evidence record 与矩阵相同，另列 exe SHA/profile/lock/资源摘要。
3. 证据覆盖 `acceptance` 中全部场景、`remainingIssues=[]` 才能升 passed。局部通过只关闭对应缺口；M 不以脚本替代真人、R 不以 fixture 模型替代真实 HTTPS。
4. 区分继承的历史证据、重新验证的最终证据与因相关代码变动失效的证据；同源码的无关旧测试不重复跑，但最终关键路径要作用于实际交付产物。
5. 跑 contracts/矩阵/fixtures/license 检查，确认文件、script 和证据都可读。audit-parity 的零缺失不能证明旧证据“从未被删除”，完整基线哈希清单才能作逐文件保护核对。

### F3. 外部条件清单与接入后的步骤

| 缺少条件 | 受影响项 | 材料到位后的具体动作 |
| --- | --- | --- |
| 真实模型 connectionId/有效凭据 | F33/F36/F38，R25 | 走正式 HTTPS 能力探测/流式/取消/提议；核真实出站范围和脱敏、错误恢复；不写 Key 到日志 |
| 真人微软拼音/辅助技术验收 | F07 及 R27 关联项、F15/F42 | 依据 fixtures manual-scenarios，在原生 WebView2 录 accepted/rejected 与环境；修缺陷后复验 |
| 干净 Win10/11 VM、不同 Windows 用户 | D01/D02/D04/D06、备份/DPAPI相关项 | 无 Node/Rust/WebView2 首用；断网在线/离线分开；中文路径、非管理员、升级、中断、卸载留数据、跨用户重输 |
| Authenticode/更新签名材料 | D05 | 签最终安装器；真实安装/升级/回退路径与签名链验证，不把本机 NotSigned 当 passed |
| Georgia/iconfont 等授权证据 | F10/F11/F44/D03及相关纸面项 | 核允许用途/再分发及随包声明；如需替换先用户批准字体合同，再重跑纸面/导出门禁 |
| 另一执行者的干净复现窗口 | D08 | 从**完整当前源码快照**复现 npm/原生/安装态；锁和资产完整，非 HEAD 缺在途文件的假克隆 |

外部材料没到位时提交可审查结果与精确阻塞，不结束其他独立实施任务，不伪造许可、签名、真人或真实模型记录。

### F4. 收尾、缓存和文档

1. 保留最终 release exe/必要 PDB/NSIS 安装器这一代；最终使用过的 debug/hooks 缓存是否剪枝，根据下一步需要与现有大版本保留规则盘点决定。不能一边清 debug 一边承诺下一次 native 单测立即完成。
2. 清理本任务临时 profile、测试进程、诊断脚本和无用实验 target；仅处理本任务明确拥有的 PID/目录。不杀用户的 WebView2，不删原有证据、日志、数据、保护资源或当前架构分析。
3. 清理前后各列 target/profile/dist/node_modules/.artifacts 的 raw/MiB，另列发布体积收益；准确报告重建代价。不反复清共享缓存或把清缓存当稳定优化。
4. 产出一份 `TASK_<date>-audit-parity-performance.md`；当前切片仅更新现状、最新数字、未完成项和入口。四份主要文档及历史轻量化任务记录保持原样。
5. 最终提交清单包含：逐行审核覆盖、功能对照、完成/阻塞列表、修复与优化摘要、before/after 原始数据、实际验证矩阵、失败/波动、产物 hash、恢复办法、清理清单。没有授权不做 Git commit/push/发布。

## 10. 实施命令说明与验证成本控制

所有示例在 `D:\Desktop\ZineCV` 下执行。示例展示已有入口，不要求每个步骤都重跑整套。native debug/hooks 首次重建成本较高，先完成相关源码再共享构建。

```powershell
# 计划阶段 / 文档与契约
npm run verify:contracts
node tools/audit-parity.mjs
node tools/generate-remaining-fixtures.mjs --check
node tools/generate-resource-license-inventory.mjs --check
npm run verify:project -- --plan --suite full

# 调用关系变更前
npm run graph:status
# 索引缺失/陈旧时按 A2 恢复，然后运行
npm run graph:index
npm run audit:ast

# 功能修改后的最小范围组合，按影响选择
npm run check:ts
npm run test:unit
npm run test:browser
npm run check:native
npm run test:native
npm run test:native-hooks
npm run test:bindings

# 正式/故障宿主只构建一次，然后串行测试
npm run build:native
npm run build:native-hooks
npm run test:webview
npm run test:webview-export
npm run test:webview-migration
npm run test:webview-migration-crash
npm run test:webview-proposal-assets
npm run test:webview-agent-ui
npm run test:webview-persistence
npm run test:webview-publication
npm run test:webview-preview
npm run test:webview-fit
npm run test:webview-fit-faults
npm run test:webview-hooks

# 纸面，注意 engine-parity 是直接入口，不是虚构 npm script
npm run test:visual-parity
npm run build:engine-render
node tools/engine-parity.mjs

# 实际包体
npm run package:windows
```

bench 参数已经存在的入口包括模板/PDF `--samples`、提交 `--count`、拖拽 `--sessions`，旧版对照有 `--legacy-root` / `--port`。先看每个脚本参数解析和证据文件名，补唯一 run-id 输出再跑至少 30 样本。`tools/lightweight/measure-memory.mjs` 支持 `--out-dir`、`--label`、`--runs`；已有工具只采短窗口，30min soak 需要扩展真实交互驱动，不能直接把 `--runs` 设很大冒充长期压力。

## 11. 可直接复制给 Agent 的启动任务

> 在 `D:\Desktop\ZineCV` 执行 `docs/EXECUTION_PLAN_20261003-audit-parity-performance.md`。以当前未提交工作树为唯一实现基线，以 `D:\Desktop\resume DIY` 为原始参考，五份 session.v4 日志仅作历史证据。先完成 A0–A3 的基线保护、全部文档核对与逐文件逐行审核，再按 B0–B5 对照原项目补齐所有可本地完成的缺口。随后建立 C 的同口径数据，优先做 D1 worker 字体重复传输、D2 按需导出和 E2 构建档/重复构建优化；E1 字体统一来源先交完整 PoC/影响与验证结果，遵守当前架构变更授权。保留 DOM 正式预览、视觉/A4/数据/离线能力，不削减功能，不修改四份保护文档，不提交、不推送、不发布。复用已有效的证据、同 profile 构建一次、WebView2 串行。每项优化必须证明能力保持及实际指标改善；外部许可、VM、证书、真人与真实模型条件未齐时只标记具体阻塞，不伪造 passed，并继续完成其他独立工作。最后执行 F 的完整专项、安装态/性能/资源核查，交付审核覆盖、功能对照、任务记录、更新的现状切片、最终矩阵、原始指标、产物哈希与精确清理结果。

## 12. 资料与技术依据

本地依据：`AGENTS.md`、`docs/SLICE_20261002.md`、`docs/TASK_20261003-lightweight.md`、四份保护文档、`docs/feature-parity.json`、`docs/public-ipc-contract-v1.md`、现行源码与 `.artifacts/remaining/lightweight-20261003/` 原始证据。附带 `.artifacts/remaining/audit-plan-20261003/plan-baseline.json` 保留本轮五份日志哈希/351 项源码及配置/33 项文档许可/14 项运行资源/535 项既有证据/135 项参考代码脚本清单、100 个参考前端文件的导航映射和最终缓存采样，供 A0 启动复核。清单仅证明已盘点，不证明逐行审核或功能验收。

- [Cargo profiles 官方说明](https://doc.rust-lang.org/cargo/reference/profiles.html)：debug、incremental、LTO、CGU 与 panic 的行为不同；test harness 忽略 panic=abort；优化等级须实测选择。
- [Cargo build timings](https://doc.rust-lang.org/cargo/reference/timings.html)：用于识别编译与等待成本。
- [Tauri URI protocol API](https://docs.rs/tauri/latest/tauri/struct.Builder.html#method.register_uri_scheme_protocol) 与 [CSP 官方说明](https://v2.tauri.app/security/csp/)：支持字体去重 PoC 的机制；实现必须另查**锁定版本**源码和 Windows origin 行为，不升级依赖来迁就 latest 文档。
- [React lazy](https://react.dev/reference/react/lazy)：延迟加载组件须保持状态位置/组件声明稳定，懒加载只改变加载时机，不自动降低安装包总资源。

以上技术资料用于候选方案判断；最终收益与兼容性以本项目实际测量和门禁为准。
