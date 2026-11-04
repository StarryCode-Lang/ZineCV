# 当前任务

2026-11-04 Windows CI 修复：624a59e、1e6b406 和 10-30 的失败均为 policy4/5 冻结文件换行被 Git 检出转换，导致原始字节 SHA-256 校验失败；后续浏览器及原生阶段未执行。针对两份文件保留 CRLF 原始字节并禁用转换，未改变测试答案或校验值；定向 4 项及日常检查 5/5（216 单元）通过。推送后的 CI 结果以 GitHub 实际运行记录为准。

2026-11-04 全项目精简优化轮（提交 33216f9 已推送）：三重扫描（超千行文件仅2个、迁移批次未用导出零命中、新增 CSS 零引用类仅1个注释误报）证实代码层处于精简态，落地优化=①性能：ImportedLayoutPaper 量测画布模块级复用（按键渲染路径不再逐框建 canvas）；②测试提速：unit 并发 6→8，同覆盖实测 18-21s→11-12s（浏览器 51 项已共享浏览器池与服务器，无进一步安全提速空间；native 观察预算按约束不可缩）；③文档最精简：NEXT_MAJOR_VERSION_PLAN.md（306行，M0-M6 执行完毕）删除并归档结论至 HISTORY_202610.md，m2-contract-design.md 上移出 drafts（源码注释同步），链接全部修正；④产物清理（回执 .artifacts/maintenance/cleanup-20261104.json，约 12.6GB）：target hooks/release/incremental/examples（保留 deps+build 11.2GB 有效缓存，dev/test 免冷重建）、旧发布副本 alpha.1/alpha.2（GitHub 在档）、runtime-tmp、过期 dist、陈旧分析证据。验证：check 5/5（216 单元）两轮、浏览器 51/51、AST 同步、detect-changes 9 文件/22 符号无截断；Rust 代码自存储 141/141 后无变化，按约定不重复跑原生。机器后台负载（WorkBuddyAI/输入法/远程桌面）导致浏览器套件耗时波动 31s↔68s，测试全过，耗时为环境性。

2026-11-04 迁移收束：逐框编辑接入正式工作区（ResumePreviewPane 渲染 ImportedLayoutPaper、ResumeEditor 整体切换 ImportedLayoutEditor、App/renderWorkspace 绑定 sourceLayoutEdits 与激活模板版式，页数/分页/溢出按源文件页计算并停用常规溢出检测）；可选原版式提取开放到识别对话框（勾选项默认关，preserveSourceLayout 透传）。修复空头像假脏状态根因：inspectLegacySnapshot 总合成 legacyAvatar:"" 而原生端无键，alignDraftDocument 现对齐到持久层表示。真实文件全链（隔离桌面实例）：真实 PDF 原版式提取 12 框→工作区逐框编辑→纸面补丁同步→SQLite 草稿→版本提交→重启恢复→提交后 dirty 正确清除；登记 source-layout-workspace 浏览器回归。正式库迁移完成：迁移前备份 real-before-migration-20261104.sqlite3（manifest+SHA-256，恢复时清理 WAL 后核哈希）；按验证顺序四步导入（浏览器原件→机器版本历史→切换器新建第二文档→机器完整重建导出），与隔离验证库逐项一致（194 归档行/97 记录、11 提交、8 分支）；重启核对 2/2 原始草稿逐字节一致、8/8 历史原始快照、97/97 孤立记录归档、文档标题区分、命令面板真实桌面可用。导出诚实边界：源版式文档导出经内置排版引擎、逐框修改不进入导出文件，已加投递检查显式提示；像素级原版式导出需扩展原生冻结导出管线（新 IPC/契约/产物校验），属待授权专项未开工。视觉：图标字形差异保留（源 WonderCV 图标无再分发许可）；复杂 Word 不完整文本框仍按逐行核对回退内容识别。验证：日常 check 5/5（216 单元）、完整浏览器 51/51、check:ts 通过；AST（audit:ast）与 GitNexus（13795 节点，detect-changes 63 文件/39 符号无截断）已同步；check:css 按设计拒绝复用旧收据（本批含非 CSS 输入），新增 CSS 由浏览器回归覆盖。正式库已迁移，原目录 `D:\Desktop\resume DIY` 数据不再被当前版本依赖（原件备份与迁移脚本证据保留在 .migration-private）。

原版式草稿续接：逐框编辑数据绑定模板 ID 和修订，写入文档快照及版本；恢复前校验身份，跨来源新建不复制原编辑，空字符串保留，备份校验拒绝不匹配数据。隔离文件 SQLite 覆盖修改→提交→再次修改→恢复→关闭重开，存储 141/141；单元 216/216、快照双向转换及类型检查通过。该状态尚未连接逐框工作区与导出，未触及正式库；复杂 Word 回退、旧孤立逐框记录归属、真实文件全链仍待处理。

原版式提取续验：新增可选 PDF 源页提取，逐页释放画布、保留基线/空白页并沿用文件、页数、像素及取消边界；合成双页实测、空页和取消检查通过，实际查看由 PDF 生成的文字替换画面。Word 可选路径保留原隔离预览及压缩包限制，复用源文本框处理；普通合成 DOCX 成功，复杂文本框样本发现文字缺失后按逐行覆盖检查明确回退内容识别，尚未证明复杂 Word 原版式可编辑。修复跨页文本框误算重叠，定向 6 项浏览器和相关边界检查通过；可选路径尚未开放给正式工作区，编辑、版本、导出与实际多样本仍待完成。

原版式续接：复用源文字框模型、提取辅助、编辑组件和纸面补丁组件；隔离浏览器验证修改/清空只覆盖目标、避免遮挡下一行及恢复原文，并实际查看合成页面。模板目录现在把源背景页纳入事务资源和版本身份，前端能按资源引用恢复背景并对缺失资源提示；原生存储 140/140（含清理保留与错误输入回滚）、前端资源回归 2/2、相关持久化 52/52、类型检查通过。以上尚非完整功能：实际 PDF/DOCX 提取需保留现有隔离安全和识别能力，工作区编辑状态需持久化并绑定版本，原版式导出与真实文件/重启回归仍待接线，未导入正式库。

视觉续验：在隔离源应用与真实 WebView2 开发实例按 1440×900 比较，发现旧版连续章节样式与状态文案遗漏；已复用源编辑器相关样式、恢复章节状态，保留目标条目排序，并修复长文档标题溢出侧栏。再次目视左侧布局已接近源版；将纸张统一为 95% 后已核对正文，但目标仍使用许可明确的替代图标（源 WonderCV 图标字体未提供再分发许可），不称完全一致。分栏/缩放会受各自保存值和滚动条影响；原版式逐框编辑及导出尚未迁入。类型检查、排序/富文本/导航/侧栏 4 项浏览器回归通过，长标题侧栏边界有实测断言；尚待其他视图、交互及全量验收。

2026-11-03 续验：目标现有 SQLite 的隔离备份在含数据的 v1→v18 升级中暴露非常量默认值错误；保留历史迁移校验和并修复升级，存储测试 139/139。旧文档稀疏章节又触发保存失败，已增加原子章节插入、保留既有章节 ID/空值/未知元数据及未修改排版；绑定 134/134、domain 10/10、定向单元 3/3 和类型检查通过。重新从原备份复制的隔离库升级后 integrity_check=ok，原有文档的 ID、标题、基础资料、章节及排版逐项一致，保存无错误；真实库未写入。实际目视对照源版与桌面版发现编辑区宽度、卡片、预览缩放及正文排版仍有明显差异，须修复后再次目视；源版式逐框编辑、真实数据合并、最终回归/清理/三工具同步及提交推送仍未完成。

2026-11-03 浏览器原件：用户提供的导出已复制至忽略目录并核对哈希；119 项中机器状态共有 11 项相同、6 项不同。浏览器版本为 3 分支/7 提交，机器版本为 1 分支/1 提交，存在同 ID 分支内容冲突但提交 ID 不重叠；须合并并验证，不能覆盖。浏览器有两组逐框编辑、4 条非空内容，其中一组与机器数据一致，模板目录为空且版本快照不引用这些模板，尚无法恢复可编辑版式。95 份有效助手会话均无消息。原件和机器保全副本均保留，实际数据导入、源版式逐框编辑与完整回归仍未完成。

模板合并已修复首次无冲突导入后再次导入产生重复别名的问题，定向单测 3/3；版本树加载详情时核对原始提交身份，隔离浏览器测试通过。日常检查中类型、契约、夹具和许可检查通过，单元阶段因新增 6 项浏览器回归触发旧的固定计数而失败；保留旧 26 项计数并单独校验新增项后，相关边界测试 12/12 通过。此次日常全链仍记为 partial。

修复后重跑日常检查通过：197 单元、类型、契约、夹具、许可清单；许可清单仍为 review-required，并非人工许可审查通过。两份孤立逐框编辑的模板 ID 在旧项目 139 个源码/文本文件及 Git 全历史中均无匹配；此查找不证明不存在其他未纳入位置的原件。

本轮完整隔离浏览器回归 43/43 通过，覆盖新增界面测试；不等同真实桌面视觉对照、原生数据迁移或导出验收。

真实导出隔离解析：浏览器草稿与 7 份历史快照均可生成候选文档；其中一份历史含 `status`、`targetCity`、`targetRole`、`salaryMin`、`salaryMax` 五个未映射字段及一处富文本不支持的属性，8 份均有字体资源待核提示。机器草稿及 1 份历史可解析，均有同类字体提示。当前转换不保证这些未映射内容在应用内保留；须补齐后再进行真实导入。

旧版迁移准备现为每份转换文档附加独立的原始快照副本，自动保存和版本脏状态比较保留当前持久文档的该副本；不将副本当作可编辑正文。真实浏览器 8/8、机器 2/2 快照经隔离浏览器保全往返一致；定向单测含编辑保存及目标隔离共 54 项通过，类型检查通过。仍需原生预演、SQLite 提交/重启/版本恢复及备份往返；五个附加字段尚未提供可编辑入口。

当前草稿在规范化前的 `resume-diy-state` 也单独保留，避免旧字段在形成快照前丢失；不把账户或令牌键放进简历文档。已为原生迁移回归加入合成旧字段的重启断言，尚未运行该原生测试。

原生构建收据 `5f817453…`；隔离 WebView 合成迁移、SQLite 提交及重启测试通过，合成旧字段原文仍存在。真实浏览器数据原生只读预检可进入 dry-run，发现版本备份含 4 分支/7 提交：与当前 3 分支/7 提交相比多一个空分支，7 提交及其余分支一致；当前转换只读取主版本库，需合并备份并避免重复提交。预检另有 95 个空会话且无账户；现有原生提交会因缺失账户而中止，需事务内保全并如实标记待恢复。机器的两个 versions 文件字节一致，app-state 仅保存时间不同。

现已合并版本备份：真实浏览器导出为 4 分支/7 去重提交，重复快照单独参与预演核对；隔离原生 dry-run 实际暂存 15/15 份，转换错误为零，状态 requires_review。原生身份事务现保全无账户会话和逐框编辑原始记录，并保留未恢复类别；存储单测 136/136 通过，新桌面程序尚待构建和真实数据提交验证。隔离预检发现 Vite 会监听私有目录的 WebView 锁文件，导致开发服务器退出；测试 profile 已改到既有隔离运行目录，项目监听边界仍待修复。

Vite 私有目录访问和监听边界已修复，HTTP 回归验证私有备份、隔离运行文件及 Git 配置不可读取，正常源码可访问。旧版快捷命令面板及顶部入口已复用，实际工作区浏览器回归覆盖搜索、导航面板、助手、焦点与禁用状态。版本备份通过非枚举的内存关联在导出时携带原文、导入时恢复；草稿恢复保留已有归档并校验目标，相关定向测试和类型检查通过。最近日常检查 202 单元通过，早于上述备份往返修改，须最终再验。

真实数据首次隔离提交因原生仍按主库与备份重复计数而拒绝；核查批次与归档行均为零，事务未写入。原生校验现对去重图逐项核对源分支、提交关系和原始快照；篡改回归及存储包 137/137 通过，待重新构建桌面并复测真实提交。

重测已在隔离数据库提交浏览器 4 分支/7 提交与机器历史 1 分支/1 提交，8/8 原始快照和 97/97 孤立记录逐项一致。机器当前草稿另建文档时暴露跨文档来源标识碰撞，事务拒绝且首份草稿保留；现按目标文档稳定区分新映射和同源批次，兼容旧映射并验证重复重放，存储包 138/138 通过。待重新构建、导入第二份草稿并重启验证。

新桌面开发实例已将机器草稿导入第二份隔离文档，标题追加“旧机器草稿”以区分同名文档，原始标题保留在来源快照。重启后核对 2/2 原始草稿、8/8 不同来源历史快照、97/97 孤立会话及逐框原始记录一致；真实桌面命令面板可打开字体设置。以上均为隔离数据库验证，实际资料库尚未修改，孤立记录尚未恢复成可编辑模板或可用会话。

2026-11-02：迁移 `D:\Desktop\resume DIY` 的界面、功能和数据至本项目，保留两边不同模板的并集，验证后提交推送。尚未完成：工作区/编辑器/模板/版本/助手界面与导入源版式逐框编辑仍需逐项适配；旧草稿、版本和逐框编辑数据需在隔离环境核对与迁移，冲突不得覆盖。源目录 `.data` 存在主备状态、1 个分支和 1 个提交，模板目录为空但有 3 条非空逐框编辑；原目录继续保留。`.migration-private/resume-diy` 为忽略提交的保全副本：`.data`、`.test-data`、`.workbuddy`、`.artifacts` 共 228 文件逐个 SHA-256 一致，Git bundle 校验通过；并非应用内迁移。已加入预览自适应缩放入口；侧栏改为复用源项目组件结构和 CSS，并适配桌面文档/岗位入口。源展示字体按 OFL 保留名要求改名为 ZineCV Display，字形、字符映射和横向度量匹配，保留原许可。类型检查、浏览器外壳及侧栏隔离交互回归通过，许可证清单检查为 review-required；真实桌面完整视觉对照、预览缩放入口实际交互、整体验收、分析同步及推送仍待完成。

2026-11-03续：编辑简报与三页标题结构复用源组件，保留桌面版标题状态、版本操作及真实导入提示。完整浏览器回归 39/39、类型检查通过；此前富文本选区单次失败后定向与完整回归通过，仍保留波动记录。源机器状态经隔离旧版应用生成私有重建导出，15/15 项与原机器状态一致、导出哈希有效、版本图与源 versions.json 相同；该文件不是用户原浏览器完整导出。桌面解析得到当前草稿及 1 个分支/提交；两份快照均能生成文档，但均报告 fontResourcePending，源逐框编辑键未被迁入。尚未进行原生预演、实际导入或模板并集合并。

2026-11-03续二：章节目录直接复用源组件与相关 CSS，并保留桌面浮层定位；章节定位、键盘关闭、编辑排序和富文本定向检查通过。旧数据迁移准备增加模板同 ID 独立保留、草稿/历史引用重映射和重复导入复用；目录无效、重复 ID 或别名冲突时拒绝覆盖。相关合成单元 16/16 及类型检查通过；尚未用真实原生数据库验证，也未导入用户数据。此前 39 项完整浏览器回归早于本批章节目录修改，不代表本批全量通过。

2026-11-03续三：预览复用源外层布局，隔离浏览器验证居中、缩放复位与 A4 尺寸；ZineBot 图形及减少动态效果检查通过。横向泳道图已接线并通过空分支、1001 提交布局单测及隔离浏览器操作，原生 WebView 仍待验证。机器状态中的宋体为源思源宋体子集：7557 个码位在桌面 OTF 中全部存在，字形轮廓、横向度量和 unitsPerEm 均一致；这只证明字体资源对应，不等同完整排版一致。

2026-10-30 本轮：扫描当前 Windows 项目并补齐剩余项；所有测试、验收、回归按用户要求追求同覆盖耗时≤原来的10%。不得缩短 quick/standard/extended 观察预算、减少断言或用缓存结果冒充重新测试；extended 30分钟×3与总耗时压至9分钟存在物理冲突，已明确告知，未达标不记完成。

当前状态：policy5输入已冻结，72有效（60开发+12新保留）及12边界，原60份除split外不变；新12份逐页真实制备、自然折行、物理尺寸及18页/图目视核对完成，尚未识别验收。前轮48开发+12边界通过，新保留组2/12失败记录保留，全部转开发后继续修复。最新局部证据：10项真实PDF/OCR几何、元数据表/跨页/变栏回归和11项语料/CLI/目标切换检查通过；混合合并保留原生与OCR两条已知顺序，不以再次几何排序抢先后续标题；新增淡灰细长装饰线OCR副本处理、数字日期物理折行及PDF小字2.4scale（20MP/120秒/单任务上限不变）。定向10份现版实测5/10（closure-20261030-policy5-targeted），其中51/52表格归属后续已补回归修正、57/58合并顺序已修，58邮箱与60姓名OCR仍在独立诊断；不算通过。完整60开发、新12保留、当前源码完整Windows链/安装升级/extended、同条件提速实测及最终分析/清理仍待完成；未达到十分之一不记完成。

policy5实测（2026-10-30续）：读序不变量三件套修复了IQ-01..06/16/22/35/49/50共8份退化——①sectionBands带内右栏若全部为纯日期碎片且无独立行、无自带标题行（标题+日期同行）则拒绝分栏（含连字符残留剥离）；②右栏含章节标题=全高双栏页不触发记录表块；③记录表逐条带禁止自重入（绕行日期碎片不再误判为下一条记录），带内按左栏（标题+绕行）先后右栏（描述）读取。全部48项读序/识别/夹具单测55/55、语料11/11通过；真实管线60开发+12边界全部通过（closure-20261030-policy5-development-final，含进程树采样）。新保留组IQ-61..72正式gate 5/12（closure-20261030-policy5-holdout）：IQ-65/66 f1=0.96近通过，IQ-67 acc=0.86，IQ-71 acc=0.658纯文本抽取，IQ-68/70/72字段与文本双缺口；M1出口未过。按冻结规则：IQ-61..72退役为开发回归，答案/阈值不改，继续修复后需新盲保留组验收。

policy5续修（2026-10-30晚）：①phoneCandidates纳入页脚联系块（邮箱/网址行及其相邻行），页脚联系行从末节正文剥离并入header——IQ-65/66修复；②orderImageLines并排卡片分支：同基线两条日期标题时按词级gutter切卡片栏逐列递归，水平条带不再把标题带与描述带拆散交错——IQ-71修复；③右栏含章节标题=全高双栏页守卫——IQ-16/22在policy5-development复测通过。保留组gate 5/12→8/12（closure-20261030-policy5-holdout-v3），IQ-61..72退役开发回归。剩余4份为OCR字符质量类：IQ-67/68（raster-lower-crossbar装饰横线误字，IQ-68姓名"澄合成"→"Bahk"）、IQ-70（raster-work-reverse-L第二条记录整行丢失）、IQ-72（raster-turning-portfolio旋转误字"澄星合成学院"→"HAR He"）。60开发复测随每轮修复保持全绿。相关单元55/55通过。

IQ-67诊断：raster-lower-crossbar的横线吞掉Skills标题与首行，仅剩绕行碎片（"version checks, backup restoration"/"and technical writing."）挂在Work节内；IQ-68同族姓名整体误读（澄合成→Bahk）；IQ-70 reverse-L装饰吞掉第二条记录标题行；IQ-72旋转页姓名误读。四份均为OCR图像质量类，方向=clearLightRuling的横线检测阈值/分块自适应阈值与低置信ROI复核扩展（现有ROI复核只覆盖姓名/邮箱）。policy6盲保留组由隔离子Agent设计中（blind-holdout-policy6.json）。

深色规则清除实测（2026-10-31）：clearLightRuling新增深色细规则线通道（单行连续深色段≥12%宽、上下5px内无深色→白化；紧贴文字的下划线因±5px窗口保留），IQ-67 acc 0.709→0.858、IQ-72 0.606→0.924，规则线策略测试更新为「孤立规则线清除/贴字下划线保留」。保留组8/12不变。剩余4份纯OCR中文名误读：IQ-68姓名"澄合成"→"SRA EE"（f1 0.889）、IQ-72姓名→"YE人"、学院→"SAHA"、IQ-70 reverse-L记录标题行仍丢、IQ-67残差0.86。现有ROI复核（headerReviewRegions置信<60）未触发或未取胜——下一步=诊断这些姓名行的实际置信度与ROI复核行为，必要时扩展ROI触发条件（confident-misread检测：姓名行含非中文字符但版式期望中文）。

policy6冻结与接线待办（2026-10-31）：隔离子Agent已盲设计冻结 fixtures/import-quality/blind-holdout-policy6.json（IQ-73..84，6新家族：html-asymmetric-left-rail/html-banner-column-pair/html-degree-line-folio/raster-compact-column/raster-contact-sidecard/raster-date-ledger-folio；结构diff与policy5零差异，staticChecks idsUniqueAndExactly73to84）。接线两步：①corpus.mjs——policy5(blind-holdout-policy5.json,IQ-61..72)退役为development（现previousFrozenHoldout=policy4→dev、frozenHoldout=policy5→holdout的链条顺延一位：policy4/5→dev、policy6→holdout），validateCorpus的72/60/12计数改为84/72/12，import-quality.test.mjs与CLI测试的计数断言同步，import-quality-baseline.mjs的holdout gate自动跟随；②materialize.mjs——materializeFrozenHoldout的versions加6，且policy6需专属分支：其JSON为新增量（families含pageGeometries(非pageWidth/Height)、units、tokenOrder、readingOrder、sectionOrder、headingIndices、identityIndex、decorationPaths、renderRules），不能走policy4通用paragraphBoxes分支；implementationNotes明令未知布局必须抛错、不得硬编码标题索引4/7/13、raster-contact-sidecard的联系三行在栅格层且按阅读序居末。其后：84开发回归跑通→IQ-67..72残余(纯OCR中文名误读SRA EE/SAHA,ROI复核扩展为confident-misread检测)→policy6保留组gate(M1出口)→完整Windows链→安装升级→收尾三工具清理推送。

policy6接线与首次盲验（2026-10-31）：materializeFrozenHoldout的versions扩至[4,5,6]，policy6分发到几何驱动渲染器（schema与policy5同构：pageGeometries/paragraphBoxes/regions/decorationPaths/headingIndices/identityIndex，generation回执按frozen.policyVersion盖章）；corpus退役policy5（IQ-61..72→development，共72开发）并接入policy6为12份holdout（validateCorpus=84/12，计数断言与CLI测试同步更新，冻结内容哈希b5c2812c/0dfda262不变）。72开发gate：67/72+边界12/12（closure-20261030-policy6-development，失败=IQ-28/67/68/70/72已知OCR质量类）。policy6首次盲验6/12（closure-20261030-policy6-holdout）：IQ-73 acc1/f1 0.833、IQ-75/76（banner-column-pair）acc 0.59-0.72、IQ-80（compact-column）0.907/0.846、IQ-83/84（date-ledger-folio）0.88-0.96/0.846；dev残余IQ-28（账本行断裂）也属同类。诊断方向：横幅栏对（banner）、紧凑单栏（compact）、台账表格（ledger）的读序与字段归属；M1出口仍未过，按冻结规则IQ-73..84退役为开发回归、需policy7盲组验收。ROI探针（probe-roi.mjs）在worker初始化处挂起待修。

IQ-75几何已捕获（probe-holdout.mjs可指定ID复用）：banner-column-pair布局=横幅(姓名+phone/email行+网址行)→Education|Skills等宽双栏→两条工作经历通栏。pdfLines实际输出：网址行"example.invalid/resume/75"脱离横幅组、落在Ledgerline与Skills之间；双栏未按列读取，工作通栏描述与Skills行交错。诊断方向：横幅三行的分组（网址行y或x被分到别的组）+双栏区域的列读取（sectionBands对Education/Skills同排双栏的处理——fullHeadings互斥规则把两个标题都排除）。

policy6修复轮终态（2026-10-31）：读序不变量四件套（纯日期栏拒绝/右栏标题守卫/记录表禁重入/并排卡片列读）+页脚联系块+深色规则线清除落地后，72开发67/72+边界12/12（closure-20261031-policy6-dev-restored，与6fa06df态一致）；附加实验（同基线附属/塔式读序/横幅预通道）在真实语料净退步（59/72）已按证据回退，pdf-reading-order.ts回到8/12保留组态。policy6盲验6/12与dev残余5份（IQ-28/67/68/70/72）为真实产品边界：栅格OCR字符质量（中文名误读）与未见版式（banner/ledger读序）需要下一轮专项，不在本轮收敛。M1出口未过，如实记录；保留组gate随每次修复继续。诚实边界：人工校正时间基线、真实供应商结果、发布后生产HTTPS升级=外部/人工项。

并排双栏实验终态（2026-10-31）：sectionBands并行双栏分支（同基线标题对+右栏无日期行守卫）在72开发gate净退步62/72（-5）已按证据回退。结论：并排标题在语料中出现于多种语境（真双栏/记录表/横幅栏对），逐案启发式不收敛——IQ-73..84与IQ-28/67/68/70/72的残余需要版式模型层面重构（栏结构先验、逐栏条目流），作为下一专项立案而非继续启发式补丁。当前已验证最佳态：72开发67/72+边界12/12+policy6盲验6/12（closure-20261031-final-verified），全部提交推送。

本轮沿用的有效专项：179项单元、日常5阶段、9项测量工具曾通过（2026-10-30T02-46-55-833Z-19288），后续有产品/测试变化须从新冻结输入验证。评分器与原实现24339组字符距离、49份真实观察判定一致；六份内置PDF独立页码及跨页标注完成。窗口控制和IPC拦截器遗漏入口已补，原生导入测试新增真实重启后校正内容一致及导出正文断言，尚待新EXE。

本轮初始完整链2026-10-30T01-31-31-934Z-25064已主动中止，不是通过：175单元、37浏览器、134绑定、398原生、hooks测试、8项引擎POC测试先后通过；build:engine-poc双LLVM链接时可用RAM仅约1GB，核验归属后停止Cargo25308及Rustc6560/11272，保留已编依赖，调度器记录partial/后续skipped。取消回执 .artifacts/analysis/closure-20261030/build-cancellation.json。后续构建使用CARGO_BUILD_JOBS=1；hooks测试宿主改为无LTO、16 codegen units，正式release策略不变。此链执行期间修过测试工具/后续UI，不冒充同冻结输入全链资格。人工校正时间、真实供应商和发布后生产HTTPS升级保留外部/人工边界，不自动发布。

2026-10-30 policy 3 正式结果：开发36/36+边界12/12通过；保留组10/12，IQ-35/36需校正，故M1出口仍未通过。进入policy 4补充轮：原48份全部保留为开发回归（包括原保留组的成功及失败），不删旧样本、不改旧答案和阈值；由隔离上下文子Agent盲设计12份新保留样本、6个全新几何并冻结，主Agent不据其结果调参。现有修复后再次进行完整开发组与新保留组验收，前轮10/12报告不改写。

policy 4实测：完整开发48/48+边界12/12通过，报告closure-20261030-policy4-development-fixed；新保留组2/12通过，报告closure-20261030-policy4-holdout，M1仍未过出口。整个IQ49..60现明确退役为开发回归，原冻结JSON/失败报告保留，后续修复不再称盲验。开始policy 5独立补充12份IQ61..72，现有60份答案/支持等级/阈值均不变；不是删除失败或改分母。采样前轮最大间隔2097ms、保留组565ms，资源数据只作采样诊断，非200ms资格。安装生命周期入口修复旧alpha.0写死路径，改按当前版本与归档alpha.2对照，回退使用升级前备份、隔离保留新库，尚待当前新包真实执行。

证据更正：前轮最后的`2026-10-29T20-11-55-364Z-31644`是7阶段失败重试，`fullCoverage=false`，不能代表一次完整34阶段通过；下文前轮记录中的“全绿”以本条更正为准。当前alpha.3归档包也不自动代表后续5c9b51f源码的重新打包资格。

## 前轮实施记录（非当前验收结论）

2026-10-28：用户已授权按 下一个版本开发大计划（已执行，归档见 docs/HISTORY_202610.md） 完成开发，目标已激活。主流程按 M0→M6 串行推进；P2 仍为计划中的选做范围，公开发布另遵当次授权。

交付文档：下一个版本开发大计划（已执行，归档见 docs/HISTORY_202610.md）。主线为可靠导入、多份简历管理、岗位定制和投递前检查；包含样本矩阵、实施顺序、验收条件和发布边界。

当前状态：M0 评测体系冻结为 policy 3；M1 主体完成，残余栅格 OCR 行断裂限制及阶段出口测量/安装环境复核。日常检查提速成果沿用。M2 的迟到写入、恢复和幂等缺口已补齐并通过事务/边界回归。M3–M5主体已落地，继续完成真实交互、当前构建三模板和同输入集成验收；M6候选链、安装升级、资源测量、最终分析同步/文档归并/清理仍待完成。用户授权少量并行，当前上限2，原生验证串行。

2026-10-30收束批：M1候选校正收尾完成——ImportCandidateEditor接入审阅对话框（基本字段/摘要正文/经历拆分合并/模块归属下拉=模块重归属），apply仅携带已勾选且与原值不同的corrections；「原始全文」可折叠对照（extractedText，旧草稿null空态）；validate_import_command补corrections语法限制，深层语义仍在apply事务内reviewed_import_candidates强制；存储新增6项校正测试。IQ-B12的5项unit桩修复（sessionEpoch undefined系旧4参调用）。导入质量复测：IQ-34/47真实改善为「内容与结构通过」，IQ-27/28/35/36仍「需校正」（tesseract行检测边界，未放宽判据未移出分母），报告.artifacts/import-quality/ocr-retest-20261029-{dev,holdout}/report.json。docs审计与清理：修正4文档6处过时陈述；docs Markdown 11→9（删DEVELOPMENT_PLAN/EXECUTION_PLAN_20261006-cplus/drafts.codebase-audit，独有事实归档HISTORY_202610，链接修复4处）；m2-contract-design.md被contracts源码注释引用保留，PROJECT_OWNERSHIP.md被resource-licenses.json引用保留。审计更正口径：绑定实为134份（verify-bindings通过）、M2实际新增10条IPC（此前"11个"系设计稿误计）、IPC总数72、schema18。字体统一（用户新指令）：选择器5→2档（宋体=内嵌思源宋体跨机器一致、雅黑=微软雅黑），旧键黑体/楷体/仿宋值并入统一栈；引擎body_fonts只保留YaHei安装字体，legacy-font:黑体→雅黑、楷体/仿宋→内嵌衬线（selected_regular=None）；应用外壳一条黑体栈、模板衬线栈统一；webview-font-selection改为2档UI+3个旧ID映射断言（PDF身份收敛为2个）；closure-controls改2档；web-product断言旧选项不存在；CI字体步骤缩减为仅校验msyh.ttc/msyhbd.ttc；希伯来字体保留（内嵌BIDI确定性回退，非用户选项）。审计移交的plan.md未跟踪遗漏项归属：导入样本独立来源页码标注→M0/M1残余（待办）；人工校正时间基线测量→M1出口（需用户实测校正耗时，机器无法替代）；保留组--holdout --gate正式验收→M1出口（随最终冻结输入运行）；永久删除/云端识别发送范围/多人账户隔离→P2及后续周期（非本版）；code-audit候选（D2-D4预览测试挂载链、P1深拷贝、P2批量版本IPC、P3 App状态分组）→后续优化候选，不阻塞vNext。

2026-10-29续做：已核对下述其他AI落盘的提速、M2及M3切片，直接沿用；先补M2/M3安全审阅发现的缺口，不以现有38项边界通过代替未覆盖场景。宿主active校验在Store锁前存在TOCTOU，A→B→A未使旧cursor失效；前端submit在真正执行时才绑定目标，切换/创建队列之后的旧保存可写入新文档。新增5项真实NativeDocumentClient回归已复现红灯（含返回身份不一致、bigint epoch传输）。主Agent负责前端排队/持久化/恢复身份，一个独立子Agent负责宿主锁/ABA/恢复候选revision fence，原生构建与测试由主Agent串行执行。GitNexus缺库已启动重建，当前进程仍在运行，完成后再做修改前impact。原版提速任务不重做，最终完整校验、M3深化、M4–M6仍须逐项完成。

续做环境状态已恢复：原Python进程已退出，无需终止；GitNexus受限重建成功（10856节点/29507边），修改前impact已执行。恢复/版本刷新有CRITICAL、切换入口有HIGH，已明确说明并用真实回归覆盖；Rust缺边UNKNOWN仍以实际入口补核。前两次OOM仅为历史环境失败，不是当前阻塞。

2026-10-29续审与实施结果：M2安全补丁已落地：排队时捕获目标、逐段检查持久化/头像/恢复身份；Store锁内原子切换与离开文档revision推进；恢复候选revision fence及有效active规范化；创建expected active/epoch、原子创建/切换/receipt及重试不抢active；归档恢复receipt；导入创建在哈希前捕获epoch；岗位写入真实归属、cursor CAS、历史内容和全写receipt。保持schema18、72 IPC，127份绑定已生成并通过结构/严格类型校验。修复收据typed struct与Value键序不同造成的HashMismatch，首次与重放统一Value表示。M3已取消整页reload，采用保存/Agent收束→受控客户端切换→工作区重新挂载bootstrap；同步防重入，冻结编辑及portal，迟到版本图拒收，响应丢失先读取宿主实际目标，读取失败保持冻结并可重试。加入搜索，将文档/岗位入口放回实际侧栏，避免额外横向占位。

M4主体已接线：本地岗位材料增改删、历史修订与关联分支读取、创建岗位分支、材料更新提示和旧依据查看；显式选择事实并本地列出要求/线索/缺口；最多7项事实+1份材料送入助手草稿，不自动发送。Rust从SQLite解析稳定岗位引用并校验修订；job-tailor只允许基本字段/摘要/经历正文待审提议，岗位引用不授予编辑范围；材料更新阻止旧提议创建/确认，拒绝和安全撤回仍可用。无模型路径可保存材料及管理分支；真实供应商结果未验证。

最近验证：日常5阶段通过，单元160项（.artifacts/verification-runs/2026-10-29T04-36-29-398Z-35136/run.json）；完整浏览器32项通过（含原26+导入4+文档1+岗位1）；原生storage126、agent21通过；desktop45通过于M2事务批次；全workspace fmt/clippy -D warnings通过于M4主体批次。绑定127与IPC72一致。浏览器新增回归覆盖保存失败、A/B同名往返、防重入、迟到/响应丢失后恢复，以及岗位丢回执原请求重试、分支关联、历史依据和未保存修改保护；这些不是完整Windows候选资格。原检查提速成果沿用，不把新增160项测试与原143项的8.339s口径混作同覆盖新测量。

2026-10-29 M5实施：投递前内容/日期/字号/岗位证据检查、字段定位和可编辑文件名已接入导出；工作区根级检查与提示可跨文档重新挂载保留。实际冻结PDF解析文字/顺序/链接/选页页数，PNG解码核对哈希、尺寸和页序，失败不进入保存。宿主以有界元数据ticket绑定冻结身份与产物；原子写入后流式回读，再记SQLite导出receipt；同writeId重试不覆盖外部改动，恢复数据库撤销旧代际。文件保存成功但记录失败独立提示；分页后续失败保留成功计数与前页记录错误。ActiveDocumentState增加recentExports/pendingImportCount，133份绑定已生成。旧提议卡已加入目标过期提示和受控返回，撤回双端拒绝跨文档/分支；新文档origin修正为blank。

此批验证：storage129/129、desktop52/52通过；全workspace fmt/clippy -D warnings通过；导出编排5项、日期3项、岗位5项、文档目标12项定向单元通过；实际PDF/PNG浏览器检查1项通过。先前daily160/完整浏览器32为前一批证据，不能替代本批最终全量。首次storage编译漏测试类型导入已修复；desktop未使用测试导入警告已移至测试模块并由严格静态检查确认。GitNexus新一轮重建进程仍存活，尚无完成输出，不重启冒充完成。

本批集成复核：daily5阶段及169项单元全部通过（.artifacts/verification-runs/2026-10-29T10-41-11-696Z-30068/run.json），完整浏览器33项通过，133份绑定结构/严格类型校验通过，AST分析更新至.artifacts/analysis/ast-grep.json。GitNexus扫描已输出大文件排除清单，仍待完成。git diff --check仅报告ts-rs生成的CreateImportDraftRequest.ts带注释换行处行尾空格，尚未按生成流程处理；不手改绑定，不将该检查记为通过。此轮与分析重建并行的日常检查耗时不用于提速比较。

M5界面续验：检查面板展示最近20条真实写盘回读成功记录，含原文档/分支/修订、模板、时间、DPI/选页及SHA-256，说明记录不能证明此后文件未改。实际浏览器回归增加错误阻止、建议忽略、字段定位、改名、Esc取消和历史展开，定向1项通过；相关8项单元及类型复查通过。此前完整33项通过后仅此面板增量，已定向验证，不冒充再次全量。GitNexus本轮已成功重建11507节点/31363边/499簇/576流程；其跨语言缺边/流程截断提示保留，不作无影响证明。ExportReviewHost新增展示前impact为LOW、直接上游DocumentWorkspace。Archify源同步多文档/岗位/投递检查与导出记录边界，后续整体验收仍须实际Typst三模板和候选链。

真实Typst输出续验：复用受控tests/fixtures/export-pdf-structure.bundle.json.gz（隔离合成文档的既有release真实导出，不冒充当前新构建），生产检查器最初误拦第1页；定位为PDF实际提取了嵌入iconfont装饰字形，而TextMap排除装饰。现只排除确认为专用iconfont字体的PUA图标文本，不全局剥除PUA；正文PUA反例仍必须报错。新真实夹具、语义PUA反例和面板交互合并浏览器回归通过，最终类型检查通过。checkExportOutput修改前精确文件impact为LOW，上游runDownloadResume→downloadResume→App。Archify showcase验证9项全过、0错误0警告。后续仍需当前构建三模板/字体及Windows候选链；图索引在本次函数体调整后需最终同步。

本轮交互续验：复制后双方独立编辑/关闭真实磁盘Store/重开再编辑的新增回归通过，desktop53/53；浏览器真实DocumentSwitcher复制/flush/双向编辑/page.reload单文件2/2通过（宿主模拟，SQLite另证）。岗位JobWorkspace已接到真实AgentOverlay，验证仅1项显式经历+1份岗位修订进入草稿，零模型调用；材料更新到修订2后引用更新，保留用户草稿，历史修订仍可查看，单文件通过。旧卡片新增真实shell回归先复现跨文档目标名称缺失，现已通过文档列表显示原名称/撤回目标，账户generation拒收迟到列表；又复现取消勾选提议项因异步读取React事件currentTarget而崩溃，已同步捕获checked修复，正复跑。卡片入口impact HIGH已说明，类型检查通过。原生导出故障回归已适配实际投递检查确认与根级提示，并增加真实写盘history/hash断言，尚待新构建执行；不计通过。

旧卡片续验结果：文档/复制/旧卡片浏览器单文件3/3通过；旧卡片使用实际renderAgentShell→Durable/Undo映射，覆盖同名目标名称、跨doc确认/撤回禁用但拒绝可、精确原ID返回、旧revision确认禁用但undo可、context/branch隔离、逐项接受和零选中禁用。动作回调为记录桩；真实宿主授权另见原生测试，不混作模型/写盘端到端。完整Windows34阶段链即将从本次冻结产品输入启动。

完整链实测进行中：tools/run-checks.ps1 -Scope Full，运行ID 2026-10-29T11-07-57-249Z-31368，记录.artifacts/verification-runs/2026-10-29T11-07-57-249Z-31368/run.json；当前前8阶段通过（日常5项含169单元、完整浏览器35项、原生严格静态检查、133绑定），已进入test:native。执行句柄session2841仍存活；继续轮次先读原句柄/运行记录，不因观察超时重启，不把running当通过。产品输入冻结，子Agent只读审阅M0/M1资源/安装出口。

完整链最新结论：test:native已通过（agent21/contracts136/desktop53/domain9/engine42/storage129）。随后build:native-hooks首次冷编译期间，完整要求审计确认M1仍缺候选校正/模块重归属/经历拆分合并，且6个OCR失败的score.support仍是content-and-structure，不能事后降级作通过。为先补必交功能，主Agent核验cargo10324确属verify31368子树后主动停止该构建，保留依赖/编译缓存；verifier正常记FAIL build:native-hooks exit4294967295、其后skipped，运行终止exit1，整体partial，不是通过也不是测试失败导致。旧session2841已结束，勿重启此旧链。产品解冻，先补M1，再从最终冻结输入重新完整验收。既有阶段仅作为此切片证据。

剩余：保留组--holdout --gate正式验收与人工校正时间基线（后者需用户实测）；导入样本独立来源页码标注；发布后生产旧版→候选HTTPS升级最终验证与extended长测（30分钟×3）；公开发布遵当次授权。真实供应商结果未验证且没有代用户调用付费服务；本地草稿与宿主协议分别有证据。视觉审阅由用户自行管理。

2026-10-30收束与M6结果：完整Windows 34阶段链全绿——初跑15阶段（含全部release/hooks/engine构建与收据）后test:webview暴露导出挂起，诊断确认为两个真实产品缺陷并修复：①冻结输出检查的iconfont豁免未识别更名后的`ZineCVSymbols`（旧夹具PDF渲染早于更名；正则并列两代字体名）；②失败导出会话票据（放弃写入）TTL内不可驱逐，8次快速失败后正常导出被「待保存的导出过多」拒绝（允许全放弃票据驱逐+新增回归测试）。续跑经`--retry-failed`六轮逐段补齐（期间适配三处测试过期断言：closure的pendingImportCount+1、persistence的标题按钮双元素歧义、publication的expectedEpoch与恢复修订栅栏语义），最终`.artifacts/verification-runs/2026-10-29T20-11-55-364Z-31644`状态passed，34阶段全部通过（含真实Typst三模板/WebView2专项12组/视觉一致性/引擎一致性）。候选`2.0.0-alpha.3`已构建签名打包（tauri.conf/Cargo.toml/package.json同步升版+锁文件与依赖声明再生成），隔离静默安装→启动→document_state就绪→干净卸载通过；生产旧版→候选HTTPS升级受更新器安全策略限制（release拒本地端点，测试构建才允许本地闭环），未发布前只能以hooks构建做本地闭环、生产验证需发布后`--remote-manifest-url`执行。资源峰值：`bench-import-concurrency`（补M2 epoch字段后）通过；`measure-memory --preset standard`三轮全过（树峰值private 958-1005MiB，报告`.artifacts/measurement/memory-standard-20261030.json/`），extended长测未运行。收尾：AST（audit:ast）与Archify（showcase 0错误0警告）同步；GitNexus重建11576节点/31601边/515簇/572流程，detect-changes 113文件/415符号/197流程（无partial/truncated标记；整批critical风险由完整链+397原生+175单元+37浏览器+WebView2专项证据覆盖）；最终日常检查5/5通过。清理与提交遵本轮授权执行。

已完成修改（本轮会话在上一轮基础上）：

- 修复上一轮遗留的运行时崩溃：`resume-content-recognition.ts` 中 `line` 未解构导致任何带头部的输入抛 ReferenceError；此前 policy2 报告的 15 个失败样本多数是该崩溃前的中间状态。
- 提取层重写（`pdf-reading-order.ts`）：递归栏间隙切列（页面级 2 行证据+配对日期拒绝+标签栏识别+截断守卫）、列顶行序（顶行所在栏在先，平局左先）；OCR 词级框分段与栏序（`orderImageLines`，旋转样本在 OCR 正立坐标系内排序后映射回原画布）；无栏间隙时行主序排序。修复三栏面板、侧栏、账本、悬挂标签、交叉栏、仪表盘、横幅、右栏、页脚导航等版式的串栏与错序。
- 识别层（`resume-content-recognition.ts`）：行首章节别名前缀识别（含 "work experience" 多词别名）、姓名/邮箱/URL 的行内与跨行折断重接、1–3 字姓名碎片行合并、日期跨行重接的标题守卫。
- 评分规则 policy 3（`corpus.mjs`/`score.mjs`）：字符准确率空白不敏感（声明的折行规范化，数字/标点/顺序仍计差）；内置样本 `basic.website` 采用显示 label 字段覆盖（`builtin-source-answers.mjs` 的 `fields`）。语料家族 16→22：四个曾用于修复的家族转开发组，保留组换为六个全新几何（banner/right-rail/footer-nav 及其栅格版），旋转/低对比变体置于开发组。
- 边界场景：四个操作场景（超时/取消/重试/目标切换）按「操作场景执行方法」真实执行（`tests/unit/import-safety-operations.test.mjs` 5 项 + 基线操作断言）；修复 `import-quality-cli` 测试桩缺失的 `rm`/`stat` 导出与 `boundaries.test.mjs` 清单计数（26+4）。

当前验证：类型、契约（62 IPC）、单元 143 项、浏览器 30 项全部通过。开发基线 `.artifacts/import-quality/development-final2/report.json`：32/36 通过 + 12/12 边界；保留组 `holdout-policy3g`：10/12。残余失败同属一类——栅格 OCR 在账本/带状版式上的行断裂（开发 IQ-27/28/34/47，保留 IQ-35/36，表现为日期行碎片化或教育栏漏读，tesseract 行检测限制，非映射错误）；文字 PDF 全家族（html-*、内置）全部通过。这四类样本的支持等级记为「需校正」，有逐份失败明细，不静默移出分母。

policy2→policy3 对照（同输入诊断）：旧识别入口 12/36 → 当前实现 32/36；边界 4 个 pending → 4 个真实操作通过。证据 `docs/evidence/vnext-import-baseline-20261028.json` 保留 policy2 历史，policy3 报告独立成档。

M2 进展（按 docs/drafts/m2-contract-design.md 实施）：T1 契约完成——新增 contracts/documents.rs 与 jobs.rs（DocumentMeta/ActiveDocumentState/SwitchActiveDocumentRequest 等 14 个类型，均 ts-rs 导出）、CreateImportDraftRequest 增必填 targetDocumentId、union 增 10 变体，绑定已重新生成；T2 存储完成——schema 17→18 迁移（documents 六个元数据列、import_drafts 目标绑定列并回填存量、job_materials 三表）、check_schema_compatibility v18 表检查、list_documents/set_document_archived/duplicate_document/mark_document_origin、导入草稿绑定写入与 apply_import 双校验、岗位材料全套存储方法（修订保留），存储测试 116 项全过（9 项版本断言同步到 18）；T3 宿主完成——进程级 ACTIVE_DOCUMENT 状态（epoch 递增）、require_active_document 替换全部 17 处 verify_default_document（保存/版本/导入/fit/渲染/agent/偏好/legacy）、restore_database_backup 与 replace_version_store 推进 epoch、avatar 解绑改用 cursor 文档（修 rendering.rs:42 硬编码）、document_create/archive/restore/switch/list、document_state 扩展 meta+epoch；T4 完成——11 个新命令注册 + capabilities + 契约文档 activeDocument 节，verify:contracts 72 IPC 三处相等；T5 部分完成——createImportReviewDraft 接线 targetDocumentId（fail-fast，不静默写默认文档），单测 mock 已同步。测试现状：单元 143、浏览器 30、存储 116、契约 125、桌面 34 全部通过，npm run check:ts 通过。

M2-T6 边界验证完成：新增 src-tauri/src/commands/m2_boundary_tests.rs 四项（非 active 目标拒绝并返回 epoch、导入草稿绑定另一文档确认被拒而绑定文档通过、复制文档独立版本图+归档/恢复往返+来源标记、schema 19 注入后 Store::open 拒开），桌面测试 38 项全过。M3 首版切片完成：NativeDocumentClient.switchDocument/createDocument（tail 串行 + epoch 发出前递增 + 失败保持原文档）、DocumentSwitcher 组件挂载工作区栏（flush 闸门→switch→宿主持久化→整页重载进入目标文档，归档管理仅对非当前文档开放），CreateDocumentPayload 字段改 camelCase 并重出绑定；样式入 window-chrome.css；单元 143/浏览器 30 复跑全绿；check:css 按设计拒绝非 CSS 输入变化（TS 开发期属预期，dev 模式编译）。下一步：M3 深化（重载内 hydrated 切换、复制后独立编辑、快速切换回归矩阵）、M4 岗位定制（消费 job_material 命令面）、M5 投递检查、M6 Windows 候选。并行项：日常检查提速已完成——当前 check 链路（daily 5 阶段）基线中位 18.432s → 最终中位 8.339s（3 次实测 7.692/8.339/8.815s，全部 ≤10.710s 硬指标，同覆盖同阈值；手段：test:unit 每文件独立进程并发 6、check 直启 node 去掉 PowerShell 启动层、取证并行化；证据 .artifacts/verification-runs/2026-10-28T18-58-* 三份 run.json；历史 53.549s/28.274s 口径对应含浏览器 17s 的 fast 套件，不在本次链路内，如实记录）、全代码审阅方向落地（死代码 D1 export_document_pdf 已被 M2 渲染面覆盖评估、模块精简、性能优化）、运行项目视觉审阅、测试验收代码量与文档极简化归并。收尾要求：更新三个分析工具、全项目清理、提交推送。

## 前一轮维护记录

以下保留已有证据及清理结论，不构成本轮待办，也不改写为新的自动化通过。

测试与验收精简、目录整理已实施；当前debug已构建并验证真实开发启动，保留全部增量缓存。单元文件19→6，91项单元与26项浏览器全部通过；原生默认/test-hooks检查、108份绑定、623个Rust函数体与CSS规则一致性已验证，最后storage修改116项通过。三项分析已更新，GitNexus完整列出2076个变化符号/149条流程（整体critical，未截断）；不据此升级完整资格。

默认验收只跑Windows功能链，跨平台及96分钟内存观察改为显式专项，原测试与预算仍可运行，未执行项不计通过。已撤回实测变慢的调度并行。

上轮未达成的提速目标：同覆盖日常检查53.549→28.274秒，目标≤10.710秒，仍未达到五分之一；不能用缩小默认验收范围代替同覆盖五倍提速。开发宿主整段原生回归90秒超时，不计通过。当前开发源码没有重新打包发布。

2026-10-28收尾清理：删除发布构建遗留 `src-tauri/target/release`（EXE哈希与已归档alpha.2身份一致，副本在 `.artifacts/releases/2.0.0-alpha.2/`）及再生的GitNexus图库 `.artifacts/analysis/gitnexus`（保留根级 `run.cjs`，查询前重建），约89MB，回执 `.artifacts/maintenance/cleanup-20261028.json`。保留当前开发依赖、dist、全部debug增量缓存（4.0GB，已构建可直接继续开发）及两份正式发布副本。提速目标本轮未继续，不自动补跑长测或恢复历史人工任务。

2026-10-30全仓精简轮：目标"零行为变化下大幅减行"。三重独立扫描（token级函数克隆规范化指纹Rust+TS+匿名箭头、322个TS导出+1345个本地函数逐一rg、CSS零引用类与重复选择器块）证实代码库处于可安全删减的局部极小值——此前10-06收口、10-24接力、10-27职责拆分已清除死代码与复制粘贴。实际落地净减133行（18文件，363删/230增）：RichEditor/EntryEditor/BasicInfoEditor表驱动化、renderAgentShell补全选项合并、proposals提议信封与类型收敛、TemplateWorkspace待审文件脚手架提取、VersionControlPanel提交/分支锁合并与隐藏输入组件化、App/context/PreviewSections/LayoutSettingsPanel/layout类型与分支收敛、tsc --noUnusedLocals清零（死导入/死参数/depth线程删除）、storage死函数mark_document_origin删除。web-core测试桥克隆合并已实施但该文件属WASM显式专项、本环境无构建无法验证，按"宁可少删"原则还原。验证一轮：fmt/clippy全workspace、storage 135/135、日常检查5/5、浏览器37/37（首跑1例editor断言环境性抖动，rich-editor连跑3次全过排除关联）。"几千行"目标与"功能/动效/视觉零变化"约束在当前树上互斥：进一步大额减行只能删除保留功能区（src/preview SVG选字链~600-1000行、zinecv-wasm浏览器核心1063行、OHOS POC、测试覆盖缩减），需用户逐项授权。
