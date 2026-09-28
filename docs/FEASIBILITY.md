# ZineCV 2.0：架构可行性与取舍

调研日期：2026-09-25至2026-09-26。范围：Windows 优先；保留全部现有功能，整体前端视觉大体不变；不以开发成本或工期否决方案。本次只交付研究和开发计划，没有实现或发布 2.0。

执行入口：[完整开发计划](DEVELOPMENT_PLAN.md)；逐项核对：[功能与验收矩阵](FEATURE_PARITY.md)；目标核心链路：[Archify 规格](target.archify.json)。

## 结论

**方案可行，值得作为 2.0 主路线，但应采用“文档引擎、领域核心、界面分别验证”的实施方式。推荐目标为 Tauri 2 + Svelte 5/Vite + Rust 命令核心 + rusqlite/SQLite + Typst。** 这不是已经证明最优的组合；最大的确定性收益是把本地安装、版本事务和排版输出建立在明确的系统边界上。实际代码减少、响应更快、内存更低仍必须用本项目的等价功能样片证明。

原方案中“普通用户不用安装 Node/Rust/Typst/数据库服务器”基本成立，但前提是发布者把依赖、字体、模板、OCR 模型和资源正确打包，并解决 WebView2。首发应交付 NSIS 安装包，不把裸 exe 宣传为完全自包含的便携产品。[R01][R02][R03]

Typst 可作为 Rust 库编译文档并输出页面，适合替代主文档的 DOM 测量与截图 PDF；但定位点不是完整点击框，SVG 字形不是天然可选文本层，增量编译不等于端到端延迟保证。三项都是前置验证关卡，而非留给收尾阶段的“小问题”。[R12–R20]

Svelte 是推荐的界面实现，不是升级成立的前提。应保留 React 对照样片；若 Svelte 在视觉、输入法、拖拽或维护指标上无法通过门禁，保留 React + Vite 并不妨碍 Tauri/Rust/SQLite/Typst 的主要收益。如果 Typst 本身不能满足纸面兼容标准，则保留旧引擎作为可运行回退，同时记录主路线未完成；不能把回退成果冒充完整 Typst 版 2.0。

## 1. 项目事实与旧调研纠偏 [High：当前源码直接证据]

本次基于 `main` 的 `5b88a9148a793217802955a1eb4b029473e6562a`。开始时 Git 工作区干净。GitNexus `status --repo .` 返回注册索引信息，**该模式不证明工作区新鲜度**；进一步核对索引 `lastCommit` 与 HEAD 一致，158 个已索引文件的 SHA-256 全部匹配。通过 `query versions`、`context useResumeVersions`、`query agent` 定位，再读实际源码。未刷新生产索引、未改现有函数，因此本次没有实施影响分析或运行全套应用回归的需要。

本次是重点链路核查，不声称逐行读完所有源码。阅读范围涵盖维护状态、版本与模板模型、富文本编辑器、导入/导出、版本操作、Agent runtime/session/账户及相关 UI 入口。附件 `D:/Desktop/session-ses_f276.md` 作为历史论证材料；其中“直接执行”“不生成文件”“删除 OCR/字体”等旧请求不构成本次指令，其统计和结论也不视为已验证事实。

| 当前范围      | Git 跟踪文件数 | 物理行数 | 口径                                 |
| ------------- | -------------: | -------: | ------------------------------------ |
| `src/`        |            100 |   27,194 | TS/TSX/JS/MJS/CJS/CSS，包含空行注释  |
| `src/styles/` |             27 |    9,566 | 已包含在上行，不可重复相加           |
| `server/`     |              5 |    1,526 | 同样按代码文本扩展统计               |
| `scripts/`    |             30 |   11,125 | 回归与工程脚本，不能全部当作无用成本 |

以上不是 SLOC，也不是生产压缩体积。`AgentOverlay.tsx` 为 3702 行，`App.tsx` 为 1365 行，`agent-overlay.css` 为 1311 行。它们说明职责集中值得检查，不证明拆成更多文件或换框架就会减少业务复杂度。附件“src 约 13k、CSS 约 6.5k、测试 27 个、体积可降至 4 MB”等数字不能作为本次收益基线。

当前已有 `ResumeState`、`ResumeLayout`、`ResumeVersionSnapshot`，并非以 DOM 作为全部业务事实源。`useResumeVersions.ts` 的 `commitVersion` 已经复制完整 `workingSnapshot`；不存在必须先消除的 Git 式 delta 存储。新方案应保留这些正确思想，解决跨 UI、浏览器缓存、项目文件、Agent 提议、分页测量之间的重复协调。

`resume-export.ts` 确实以 html2canvas 2x 渲染可见 A4，再用 jsPDF 写图像型 PDF，多页 PNG 纵向拼接。但是 `template-import.ts` 的 `renderWord` **也依赖 docx-preview + html2canvas + Mammoth**。把主导出换成 Typst 不能直接删掉 html2canvas；导入缩略图还需替代实现或低频隔离保留。

`version-model.ts` 和 `useResumeVersions.ts` 表明版本行为比“保存 JSON”多：创建分支时生成初始提交、载入历史只更新草稿、删除提交重接父子、删除分支保留他分支祖先、版本库恢复不自动替换当前工作区。2.0 必须逐项保留。

账户也不是可以默认删除的未来功能。`server/local-agent-accounts.mjs` 已有本机邮箱账户、scrypt 密码校验、会话与 provider 存储；`src/agent/sessions.ts` 按账户保存会话。旧架构文档仍写 Key 仅内存，而当前维护状态和账户代码显示已存在本机账户持久化路径。本计划依据当前源码，保留账户体验，并把新秘密存储移入 Rust 凭据边界。

维护文档仍列出：固定历史 A4 基线失败、真实模型联调待配置、字体/iconfont 再分发证据不齐。这些是当前文档记录的未关闭项，本次未重跑验证，不能宣称已复现或已修复。新 2.0 基线必须与这些遗留项分别记录，不能覆盖历史证据。

## 2. 主要架构判断 [Medium：官方能力明确，项目收益待实测]

### 2.1 桌面容器与本地核心

Windows 桌面分发与项目的本地文件、版本库、AI 配置需求匹配。Tauri 把 JS 界面与 Rust command 连接起来，允许以 Channel 发送流式结果；SQLite bundled 免去用户安装数据库。Rust 适合掌握文件、事务、导出和网络请求，但不会自动替应用解决错误恢复与并发。UI 仍应即时维护输入、选区、展开状态和拖拽候选，不能每次按键都等待数据库往返。[R11][R32]

推荐 Rust 唯一执行领域 command；Svelte 保存它的投影与短暂编辑 buffer。避免一套 TS reducer 加一套 Rust reducer：这会制造新的双状态问题。共享契约从 Rust 类型生成 TS binding，运行时边界仍校验输入、schema 和修订号。tauri-specta 等工具可作为实现候选，不能误以为生成类型就是运行时校验。[R31]

桌面化会增加 Rust crate、IPC、安装器和系统测试，因此“文件总数必然更少”并不成立。减少重复业务规则和排版机制的收益，比为了少文件把所有服务塞进同一个 Rust 模块更重要。仍以总手写代码量、重复规则、修改扩散范围、测试时间与用户可测响应为优化结果。

### 2.2 Typst：合适的排版引擎，需要受控宿主

官方 crate 暴露编译过程，`World` 提供源文件、字体、资源等能力。宿主需要缓存这些资源并正确失效。增量求值和排版能复用工作，但冷字体加载、整份 JSON 更新、重新分页、SVG 序列化、IPC 和 WebView 绘制仍可能占用大量时间。故必须测量“输入事件到新页面实际可见”，不能只报告 `compile()` 耗时。[R12][R13][R14]

当前公开 `compile` 入口是同步函数，参数没有 cancellation token。Rust 异步任务包装或 `spawn_blocking` 不代表正在进行的计算可硬取消。推荐常驻、版本锁定的文档 worker：对普通编辑采用合并和过期结果丢弃；对死循环、超时、内存超限使用进程级终止和重建。该 worker 是安装包自带的应用组件，不是用户安装的 Typst CLI。是否采用同一 exe 的内部 worker 模式或 sidecar，由 PoC 在 Windows 打包与进程限制实测后定案。[R14]

使用 JSON/内存数据文件把结构化内容交给受控模板，不把简历字符串拼进可执行 Typst 源码。Typst 仍需模板代码和 AST 到内容的映射；“支持 JSON”并不消灭模板开发。为重现历史渲染，应锁定引擎、模板修订、字体字节、图片字节、布局参数、语言与时间输入。固定文档与环境下可追求稳定布局，但不默认承诺 PDF 字节永久一致；元数据时间、编译器升级可能影响二进制输出。

### 2.3 定位、文本选择与辅助功能

`location.position()` 只提供 page/x/y，不能直接实现“跨页经历整块悬停边框”。需要模板标记及 frame/fragment 提取适配层，返回多矩形，并在缩放、DPR、分页、列表和头像场景验收。它是整个迁移的技术风险之一。[R15]

当前 SVG exporter 以字形轮廓/图像及 `<use>` 等表达视觉文字。由源码可推断不能把普通 SVG 输出当作 DOM 文本层。左侧可访问编辑器可以提供语义，但若现有纸面选字复制行为被列入兼容契约，必须做文本层或经过验证的替代，不能静默丢掉。PDF 可搜索文字与预览可选文字也不是同一个验收项。[R16]

Typst PDF 支持标签与 PDF/UA-1，并不自动证明所有模板符合完整无障碍要求。标题、列表、语言、阅读顺序、图片替代文本需由模板提供，并实际检查中英文搜索复制与阅读顺序。文本 PDF 是明确的产品升级，但不能宣传为保证 ATS 通过。[R17][R18]

### 2.4 视觉保持与字体

工作区 UI 可继续沿用现有设计 token、图标、间距、分栏和动画。纸面样式则需从 CSS 翻译为 Typst 的段落、字形与分页规则；相同 font-size 并不自动产生相同换行。项目原 A4 像素常量是近似值，新引擎采用 210×297 mm 时，也必须明确旧 px 到 pt/mm 的转换和允许误差，不能把单位换算视为视觉验证。[R19][R20]

字体需要按真实文件和字重确定，不依赖用户机器的同名字体。Typst 的 fallback、缺字、CJK 混排和段落优化选项都可能改变布局。不能只按当前样例汉字子集化后宣称支持任意用户简历。优先固定有明确授权的完整中文字体/合理分区资源，再测包体；若旧素材授权不能补齐，替换字体或图标须提交可审查视觉差异，不可以减少文件量为理由直接更换。

模板包的许可独立于引擎。离线首次编译需要预置所有允许的包与资源；不得让正常预览隐式从网络下载包。受控 `World` 只供给显式资源，禁止任意路径、网络、用户数据库和账户文件。插件隔离不等于 CPU/内存限额。[R21][R22][R44]

### 2.5 Svelte：推荐而非神化

Svelte 5 runes 可抽离共享响应式逻辑，scoped CSS 可降低无意跨组件影响。但 scoped 选择器会增加特异性，旧全局 CSS 的覆盖关系可能变化；迁移时应先复刻现有表现，再消除重复规则，不要同时重新设计。[R23][R24]

内置 transition 和 animate 可以替代部分接线，但不能自动复现 Motion 的所有弹簧、中断、布局共享与拖拽行为。Svelte transition 使用 Web Animations API，全局 CSS 的 reduced-motion 归零不会自动关掉它；必须显式接入 motion policy。`animate:flip` 只覆盖特定 keyed list 重排，不是完整拖拽系统。[R25][R26][R27]

富文本应保留粗斜体、下划线、删除线、列表、链接、清格式、撤销重做、粘贴与 IME。推荐 Tiptap Core/ProseMirror 的最小扩展集，沿用现在工具栏样式。引入成熟编辑器可能增加依赖字节，但减少选区、历史和输入法的自维护逻辑；不能用依赖数量一票否决。官方有 Svelte 集成，但仍需真实 Windows 微软拼音测试。[R28]

### 2.6 SQLite：事务提升，不是另造版本控制系统

保持完整快照，不上 CRDT、事件溯源或 delta 压缩。WAL 改善读写并发但同一时刻仍只有一个 writer；采用短事务和单写队列。`synchronous=FULL` 是建议的持久化策略，不把 NORMAL 的掉电行为说成相同。每条“已保存”提示都必须对应已提交的持久结果。[R32][R33][R34]

不可变快照与“删除版本后重接关系”可以共存：正文 snapshot 不改，用户可见提交图由单独的关系/可见性记录维护，删除时原子重接；不要把整个 commit graph 都定义为绝对不可变后又偷偷改 parent。历史恢复还必须冻结模板修订和资产依赖。

简历规模下图片等资产优先 SQLite BLOB，方便同事务、备份和恢复。若原始 PDF/DOCX 很大，先明确限制和按需留存，不自动把所有原文件永久存入版本。外置资源只在测量证明必要时引入，并承认数据库事务不覆盖文件系统 rename。

活跃 WAL 数据库不能仅复制主 `.db` 当完整备份，使用 SQLite Backup API。恢复需验证完整性、外键、资源哈希与 schema，再切换数据库；损坏不能解释为“首次启动空库”。canonical hash 要定义格式与版本，不能对两个语言默认 JSON 序列化结果直接比较。[R33][R35][R36]

### 2.7 导入：模块隔离优先于语言纯度

PDF.js、Mammoth、Tesseract.js 是已存在链路，可以先经统一接口隔离为延迟加载 worker；涉及 `docx-preview` 的 DOM 缩略图不能硬塞进没有 DOM 的 Web Worker，需要无特权、无网络的隔离 WebView 或其他渲染适配器。新核心只接受导入候选与资源，不依赖这些库。[R38][R39][R40]

PDF 文本提取不等于正确段落顺序，扫描图像不等于恢复可编辑模板。Mammoth 追求语义 HTML，不忠实保留所有排版，且输出不自动消毒。Tesseract.js 不直接读取 PDF，须先栅格化。Rust `docx-rs` 当前有读取能力，但不是完整 Word 引擎；PDFium wrapper 也有本地库与线程约束。采用 Rust 替代前，必须拿同一复杂语料证明质量、性能、离线和错误恢复至少等价。[R39–R43]

这也纠正附件中“导入 OCR 可砍”的旧建议：本次用户要求全部功能，OCR 和导入原始页面预览都属于兼容范围。所谓降本增效不能来自删功能。

## 3. Windows 分发、安全与测试 [Medium]

首发产品支持目标建议设为 Windows 10 22H2 x64 和受支持的 Windows 11 x64；正式构建时重核工具链和 WebView2 支持状态。当前 Microsoft 文档说明 Win10 22H2 的 Edge/WebView2 更新至少持续至 2028-10，这是运行时支持信息，不等于替操作系统整体支持作担保。[R45]

默认 NSIS + Evergreen WebView2 在线安装；额外提供离线安装包并验证无网络首次启动。离线 Runtime 增加的体积随版本变化，不把“127 MB”写成固定承诺。没有管理员权限、中文路径、安装失败、磁盘满、升级中断和卸载保留用户数据都纳入测试。[R01][R02]

Tauri capability 不是全部命令自动默认拒绝：官方文档说明 `invoke_handler` 注册的应用命令默认所有窗口可调用，需要 AppManifest 声明并配合权限收口。CSP 也必须实际配置。前端只获得业务级 IPC，不能获得任意 SQL、shell、文件路径读写或读取 API Key 的通道。[R04][R05]

Stronghold 是可选的 vault 实现，不自动提供产品的密码获取、解锁、轮换和恢复方案。Windows首版推荐Current-user DPAPI加密后存SQLite BLOB，置于Rust `SecretStore`接口后：不额外要求vault密码，配置与密文可同事务保存。默认仅相同Windows用户通常在原机器可解密，漫游profile有例外；不能设置允许其他本机用户解密的machine范围，也不保证跨机恢复。若改用Stronghold，解锁秘密和恢复策略必须先定义。无论实现为何，用户输入 Key 只在设置提交时短暂经过前端，之后不读回、不进入持久 JS 状态。不能声称 Key 从来没经过 JS，也不能将“数据库本地”误称为“数据库已加密”。[R06][R46]

Updater 的更新签名与 Windows Authenticode 是两套不同责任。更新插件不自动解决数据库降级或回滚；发布要保护签名私钥、迁移前备份，并测试新版启动失败恢复。签名不保证 SmartScreen 从不提示。[R07][R08]

Vitest 和 Playwright 可以替代散落脚本的重复基础设施，不能替代其断言。普通 Chromium/Vite 测试不证明真正 WebView2、Tauri IPC 或文件保存。当前 Tauri 文档推荐 WDIO tauri-service 并区分 embedded/native/browser provider；Playwright 也有真实 WebView2 CDP 附加方式。选一种桌面 E2E 主方案，避免同时养两套同义桌面测试；安装器与实际输入法另测。[R09][R10][R29][R30]

## 4. 候选方案比较与明确取舍

| 方案                                   | 得到什么                           | 仍需承担什么                            | 本次取舍                                 |
| -------------------------------------- | ---------------------------------- | --------------------------------------- | ---------------------------------------- |
| Tauri + Svelte + Rust + SQLite + Typst | 明确本地核心与统一排版，界面可重整 | 富文本、纸面复刻、命中框、IPC、打包测试 | 推荐主路线，先过风险样片                 |
| Tauri + React + Rust + SQLite + Typst  | 同样具备主要桌面/排版收益          | 需整理 React 状态边界                   | Svelte 门禁失败时首选备选                |
| React + react-pdf                      | 客户端结构化 PDF 可行              | 与现有 DOM 预览和桌面能力仍需整合       | 可作为导出替代评估，不是本次首选         |
| Svelte + 原 DOM 截图                   | UI 组织可变化                      | 原测量、分页、截图问题仍存在            | 不能独立证明大版本跃升                   |
| Electron + Web UI                      | 统一 Chromium 运行环境             | 随附运行时与另一套系统边界              | 仅在 WebView2/系统集成存在阻断证据时重评 |
| 桌面 + Web/WASM 同时建设               | 双平台访问                         | 双存储、密钥、编译部署和回归矩阵        | 不进入首发；保留纯领域边界即可           |

比较表是工程判断，不是独立 benchmark。这里没有以迁移工期否决任何方案，也没有根据竞品星数推断本项目最佳框架。用户目标“完整功能、整体视觉保留、复杂度下降”优先于技术栈纯度。

## 5. 尚未由证据解决的关卡

1. Typst 对三个内置模板、中英文断行、图标与“智能一页”的兼容程度。
2. 可定位到模块/条目的跨页多矩形及纸面选字的完整实现。
3. 两个框架在同功能样片上的真实代码、延迟、内存及可维护性差异。
4. 原字体与 iconfont 的可再分发证据，以及必要替代后的视觉差异。
5. 旧浏览器当前未提交草稿、模板与会话能否全部从原 profile 导出；新应用不会自动看见它们。[R37]
6. 真实供应商流式、工具调用和取消行为；fixture 不能替代用户配置后的真服务验收。

以上不是继续研究几篇文档就能确定的事实，开发计划以可运行 PoC 和验收关卡解决。未通过时保留数据和旧应用，不强行宣布升级完成。

## 6. 方法与证据等级

采用 deep-research 深度模式：四条并行检索线（排版、桌面、安全/存储导入、界面与测试），一轮主检索、对十条高影响断言单独抽查、一次反方综合，再补查Windows DPAPI秘密存储。最终由两条独立技术审阅核对数据和渲染契约，补齐草稿上下文、资源GC根、跨批次迁移幂等、命令cursor、PoC前置协议与worker生命周期。关键领域已被多个来源覆盖，剩余缺口属于本项目运行验证，因此没有为凑数量追加广泛检索。调研采用官方文档、标准及原始项目源码；同一组织的不同网页不算独立实证，单项官方能力标 Medium，本地直接源码事实标 High，未经 benchmark 的性能收益不赋予 High。

结构从“技术栈介绍”调整为“项目纠偏—能力与边界—取舍—执行门禁”，未改变研究目标。未进行 Tauri/Typst 安装、编译或性能 PoC，未跑旧应用全套回归，未访问用户浏览器或读取真实 `.data` 内容。没有测量就没有宣称速度提升百分比、安装包大小或绝对 LOC 减少。

引用抽查纠正了三处表述：SVG 的部分字形可能是图像而非全部 path；Stronghold 的密钥管理结论是 API 责任推论；“不可只拷贝 DB”限定为活跃 WAL/未建立一致状态。也核实了 Tauri WebDriver 2026-06-29 文档的更新，避免重复旧版平台限制。Typst 架构旧文档局部内容与新 API 不一致，最终以当前 API 文档和源码为准，不把旧文档的全部描述照抄。

R01–R45访问日期为2026-09-25，补充DPAPI证据R46为2026-09-26。动态 `latest`/`main` 链接用于研究，不是可复现依赖锁定；实施批次必须把选择写入 Cargo.lock/package lock、字体/模板 hash、已核验文档版本记录。RFC/SQLite 的长期基础文档保留为 foundational；没有以旧 benchmark 推断当前性能。

## 7. 来源与摘录索引

下表是释义摘要，不是逐字引用。Tier 1 为官方文档/标准，Tier 2 为所选第三方集成项目的维护者资料；所有来源都只支持其能力范围，不支持 ZineCV 已实现或已达性能目标。

| ID  | 来源                                                                                                                   | Tier | 支持的事实与限制摘要                                        |
| --- | ---------------------------------------------------------------------------------------------------------------------- | ---- | ----------------------------------------------------------- |
| R01 | [Tauri Windows Installer](https://v2.tauri.app/distribute/windows-installer/)                                          | 1    | NSIS/MSI、WebView2 安装选项；安装包不等于便携单 exe         |
| R02 | [Microsoft WebView2 distribution](https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/distribution)     | 1    | Evergreen/Fixed、离线分发和宿主责任                         |
| R03 | [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/)                                                       | 1    | Windows 开发工具链与系统依赖                                |
| R04 | [Tauri capabilities](https://v2.tauri.app/security/capabilities/)                                                      | 1    | 自定义命令默认范围、AppManifest 与 capability               |
| R05 | [Tauri CSP](https://v2.tauri.app/security/csp/)                                                                        | 1    | CSP 需配置；远程脚本与本地资源限制                          |
| R06 | [Tauri Stronghold](https://v2.tauri.app/plugin/stronghold/)                                                            | 1    | vault/password/hash API；应用仍负责秘密生命周期             |
| R07 | [Tauri updater](https://v2.tauri.app/plugin/updater/)                                                                  | 1    | 强制更新签名、密钥与更新策略，不是 DB 回滚协议              |
| R08 | [Tauri Windows signing](https://v2.tauri.app/distribute/sign/windows/)                                                 | 1    | Authenticode、SmartScreen 声誉限制                          |
| R09 | [Tauri WebDriver](https://v2.tauri.app/develop/tests/webdriver/)                                                       | 1    | embedded/native/browser 测试范围不同                        |
| R10 | [Playwright WebView2](https://playwright.dev/docs/webview2)                                                            | 1    | CDP 附加真实 WebView2、隔离 profile                         |
| R11 | [Calling Rust / channels](https://v2.tauri.app/develop/calling-rust/)                                                  | 1    | command IPC、Channel 流式数据                               |
| R12 | [Typst Rust crate](https://docs.rs/typst/latest/typst/)                                                                | 1    | Rust 编译入口、分页文档与导出链路                           |
| R13 | [Typst World](https://docs.rs/typst/latest/typst/trait.World.html)                                                     | 1    | 宿主资源缓存与失效责任                                      |
| R14 | [Typst compile](https://docs.rs/typst/latest/typst/fn.compile.html)                                                    | 1    | 当前公开同步入口无 cancel token 参数                        |
| R15 | [Typst location](https://typst.app/docs/reference/introspection/location/)                                             | 1    | 页号/x/y 定位，不直接提供完整 bbox                          |
| R16 | [Typst SVG text implementation](https://github.com/typst/typst/blob/main/crates/typst-svg/src/text.rs)                 | 1    | glyph/use/path/image；选字限制是源码推论                    |
| R17 | [Typst PDF reference](https://typst.app/docs/reference/pdf/)                                                           | 1    | tagged PDF、PDF/UA 支持及检查限制                           |
| R18 | [Typst accessibility](https://typst.app/docs/guides/accessibility/)                                                    | 1    | 作者语义、替代文本、外部验证仍必要                          |
| R19 | [Typst text](https://typst.app/docs/reference/text/text/)                                                              | 1    | 字体、fallback、语言与 CJK 属性                             |
| R20 | [Typst paragraph](https://typst.app/docs/reference/model/par/)                                                         | 1    | 段落优化与换行算法，非 CSS 行盒                             |
| R21 | [Typst paths](https://typst.app/docs/reference/foundations/path/)                                                      | 1    | 根路径边界；嵌入宿主须实现资源限制                          |
| R22 | [Typst packages](https://github.com/typst/packages/blob/main/README.md)                                                | 1    | 包版本、缓存与按需下载规则                                  |
| R23 | [Svelte reactive modules](https://svelte.dev/docs/svelte/svelte-js-files)                                              | 1    | runes 模块及导出限制                                        |
| R24 | [Svelte scoped styles](https://svelte.dev/docs/svelte/scoped-styles)                                                   | 1    | scoped hash 与 specificity 增加                             |
| R25 | [Svelte transition](https://svelte.dev/docs/svelte/transition)                                                         | 1    | WAAPI、退出保留 DOM、reduced-motion 注意点                  |
| R26 | [Svelte motion](https://svelte.dev/docs/svelte/svelte-motion)                                                          | 1    | motion primitives 与 prefersReducedMotion                   |
| R27 | [Svelte animate](https://svelte.dev/docs/svelte/animate)                                                               | 1    | keyed each 重排机制，不等于完整拖拽                         |
| R28 | [Tiptap Svelte](https://tiptap.dev/docs/editor/getting-started/install/svelte)                                         | 1    | Svelte 集成存在，完整行为仍需本项目验收                     |
| R29 | [Svelte testing](https://svelte.dev/docs/svelte/testing)                                                               | 1    | Vitest、组件/响应式与 Playwright 测试                       |
| R30 | [Vitest browser mode](https://vitest.dev/guide/browser/)                                                               | 1    | 真实浏览器 provider 与模拟测试区别                          |
| R31 | [tauri-specta](https://github.com/specta-rs/tauri-specta)                                                              | 2    | Rust 到 TS command/event 类型绑定候选                       |
| R32 | [rusqlite](https://github.com/rusqlite/rusqlite)                                                                       | 1    | bundled SQLite 与 backup feature                            |
| R33 | [SQLite WAL](https://sqlite.org/wal.html)                                                                              | 1    | 单 writer、checkpoint、WAL 属于持久状态；foundational       |
| R34 | [SQLite PRAGMA](https://www.sqlite.org/pragma.html)                                                                    | 1    | foreign_keys、synchronous、integrity_check 等；foundational |
| R35 | [SQLite backup](https://sqlite.org/backup.html)                                                                        | 1    | 在线一致性备份 API；foundational                            |
| R36 | [RFC 8785 JCS](https://www.rfc-editor.org/rfc/rfc8785.html)                                                            | 1    | JSON canonicalization，不自动规范化 Unicode；foundational   |
| R37 | [MDN same-origin policy](https://developer.mozilla.org/en-US/docs/Web/Security/Defenses/Same-origin_policy)            | 1    | 存储 origin 隔离，新桌面 profile 不等于旧浏览器             |
| R38 | [PDF.js getting started](https://mozilla.github.io/pdf.js/getting_started/)                                            | 1    | worker 与解析渲染资源                                       |
| R39 | [Mammoth](https://github.com/mwilliamson/mammoth.js)                                                                   | 1    | 语义 DOCX 转换、非忠实版式、无自动消毒                      |
| R40 | [Tesseract.js FAQ](https://github.com/naptha/tesseract.js/blob/master/docs/faq.md)                                     | 1    | OCR 使用与不直接支持 PDF                                    |
| R41 | [docx-rs](https://github.com/bokuweb/docx-rs)                                                                          | 1    | Rust 读写能力，OOXML 覆盖不穷尽                             |
| R42 | [pdfium-render](https://github.com/ajrcarey/pdfium-render)                                                             | 2    | PDFium wrapper、本地库/线程边界                             |
| R43 | [MuPDF license](https://mupdf.readthedocs.io/en/1.27.1/license.html)                                                   | 1    | AGPL/商业授权，需按所选依赖审核                             |
| R44 | [Typst package licensing](https://github.com/typst/packages/blob/main/docs/licensing.md)                               | 1    | 模板、包与引擎许可不能混同                                  |
| R45 | [Microsoft Edge supported OS](https://learn.microsoft.com/en-us/deployedge/microsoft-edge-supported-operating-systems) | 1    | Windows/WebView2 当前支持信息，发布时重核                   |
| R46 | [Microsoft CryptProtectData](https://learn.microsoft.com/en-us/windows/win32/api/dpapi/nf-dpapi-cryptprotectdata)      | 1    | Current-user保护、机器/漫游边界与machine范围限制            |

### 本地证据入口

`README.md`、`AGENTS.md`、`docs/maintenance-status.md`、`docs/version-storage.md`、`docs/third-party-assets.md`；`src/domain/{resume-model,version-model,template-model,imported-template,template-library}.ts`；`src/templates/registry.ts`；`src/app/{App,useResumeVersions,useResumePagination}.tsx/ts`；`src/components/editor/RichEditor.tsx`；`src/services/{template-import,resume-export}.ts`；`src/agent/{types,runtime,sessions}.ts`；`server/local-agent-accounts.mjs`。以本报告开头的提交号及实施时重新读取的源码为准。

### 目标架构图交付记录

Archify图只表达目标核心链路，省略的导入、Agent网络和身份细节以开发计划为准；它不是现有源码关系图，也不证明2.0已实现。

- 类型：architecture；specification：`target.archify.json`。
- specification SHA-256：`b7f1cef2428193dea43af7780c747fff4080b9fa509de88c7ec7f661ba64b90d`；1923 bytes。
- HTML SHA-256：`18aa73b98a7cf39143692ac57ca9a888223109cccb2dc76a2600d91934cdbd4c`；803223 bytes。
- deterministic delivery：9/9 showcase，0 errors，0 warnings。
- automated browser evidence：passed；1440×900、1600×1000、1920×1080、2048×1320无横纵溢出。
- perceptual review：passed；已查看浅色大屏与深色普通屏实际截图，节点、连线、标签与信息卡清晰无重叠。
- correction_rounds：1。临时校验副本在交付后清理，最终HTML与浏览器证据位于Codex可视化输出目录，不加入源码提交。
