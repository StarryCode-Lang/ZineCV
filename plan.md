# 当前任务

2026-10-30 本轮：扫描当前 Windows 项目并补齐剩余项；所有测试、验收、回归按用户要求追求同覆盖耗时≤原来的10%。不得缩短 quick/standard/extended 观察预算、减少断言或用缓存结果冒充重新测试；extended 30分钟×3与总耗时压至9分钟存在物理冲突，已明确告知，未达标不记完成。

当前状态：policy5输入已冻结，72有效（60开发+12新保留）及12边界，原60份除split外不变；新12份逐页真实制备、自然折行、物理尺寸及18页/图目视核对完成，尚未识别验收。前轮48开发+12边界通过，新保留组2/12失败记录保留，全部转开发后继续修复。最新局部证据：10项真实PDF/OCR几何、元数据表/跨页/变栏回归和11项语料/CLI/目标切换检查通过；混合合并保留原生与OCR两条已知顺序，不以再次几何排序抢先后续标题；新增淡灰细长装饰线OCR副本处理、数字日期物理折行及PDF小字2.4scale（20MP/120秒/单任务上限不变）。定向10份现版实测5/10（closure-20261030-policy5-targeted），其中51/52表格归属后续已补回归修正、57/58合并顺序已修，58邮箱与60姓名OCR仍在独立诊断；不算通过。完整60开发、新12保留、当前源码完整Windows链/安装升级/extended、同条件提速实测及最终分析/清理仍待完成；未达到十分之一不记完成。

policy5实测（2026-10-30续）：读序不变量三件套修复了IQ-01..06/16/22/35/49/50共8份退化——①sectionBands带内右栏若全部为纯日期碎片且无独立行、无自带标题行（标题+日期同行）则拒绝分栏（含连字符残留剥离）；②右栏含章节标题=全高双栏页不触发记录表块；③记录表逐条带禁止自重入（绕行日期碎片不再误判为下一条记录），带内按左栏（标题+绕行）先后右栏（描述）读取。全部48项读序/识别/夹具单测55/55、语料11/11通过；真实管线60开发+12边界全部通过（closure-20261030-policy5-development-final，含进程树采样）。新保留组IQ-61..72正式gate 5/12（closure-20261030-policy5-holdout）：IQ-65/66 f1=0.96近通过，IQ-67 acc=0.86，IQ-71 acc=0.658纯文本抽取，IQ-68/70/72字段与文本双缺口；M1出口未过。按冻结规则：IQ-61..72退役为开发回归，答案/阈值不改，继续修复后需新盲保留组验收。

policy5续修（2026-10-30晚）：①phoneCandidates纳入页脚联系块（邮箱/网址行及其相邻行），页脚联系行从末节正文剥离并入header——IQ-65/66修复；②orderImageLines并排卡片分支：同基线两条日期标题时按词级gutter切卡片栏逐列递归，水平条带不再把标题带与描述带拆散交错——IQ-71修复；③右栏含章节标题=全高双栏页守卫——IQ-16/22在policy5-development复测通过。保留组gate 5/12→8/12（closure-20261030-policy5-holdout-v3），IQ-61..72退役开发回归。剩余4份为OCR字符质量类：IQ-67/68（raster-lower-crossbar装饰横线误字，IQ-68姓名"澄合成"→"Bahk"）、IQ-70（raster-work-reverse-L第二条记录整行丢失）、IQ-72（raster-turning-portfolio旋转误字"澄星合成学院"→"HAR He"）。60开发复测随每轮修复保持全绿。相关单元55/55通过。

IQ-67诊断：raster-lower-crossbar的横线吞掉Skills标题与首行，仅剩绕行碎片（"version checks, backup restoration"/"and technical writing."）挂在Work节内；IQ-68同族姓名整体误读（澄合成→Bahk）；IQ-70 reverse-L装饰吞掉第二条记录标题行；IQ-72旋转页姓名误读。四份均为OCR图像质量类，方向=clearLightRuling的横线检测阈值/分块自适应阈值与低置信ROI复核扩展（现有ROI复核只覆盖姓名/邮箱）。policy6盲保留组由隔离子Agent设计中（blind-holdout-policy6.json）。

本轮沿用的有效专项：179项单元、日常5阶段、9项测量工具曾通过（2026-10-30T02-46-55-833Z-19288），后续有产品/测试变化须从新冻结输入验证。评分器与原实现24339组字符距离、49份真实观察判定一致；六份内置PDF独立页码及跨页标注完成。窗口控制和IPC拦截器遗漏入口已补，原生导入测试新增真实重启后校正内容一致及导出正文断言，尚待新EXE。

本轮初始完整链2026-10-30T01-31-31-934Z-25064已主动中止，不是通过：175单元、37浏览器、134绑定、398原生、hooks测试、8项引擎POC测试先后通过；build:engine-poc双LLVM链接时可用RAM仅约1GB，核验归属后停止Cargo25308及Rustc6560/11272，保留已编依赖，调度器记录partial/后续skipped。取消回执 .artifacts/analysis/closure-20261030/build-cancellation.json。后续构建使用CARGO_BUILD_JOBS=1；hooks测试宿主改为无LTO、16 codegen units，正式release策略不变。此链执行期间修过测试工具/后续UI，不冒充同冻结输入全链资格。人工校正时间、真实供应商和发布后生产HTTPS升级保留外部/人工边界，不自动发布。

2026-10-30 policy 3 正式结果：开发36/36+边界12/12通过；保留组10/12，IQ-35/36需校正，故M1出口仍未通过。进入policy 4补充轮：原48份全部保留为开发回归（包括原保留组的成功及失败），不删旧样本、不改旧答案和阈值；由隔离上下文子Agent盲设计12份新保留样本、6个全新几何并冻结，主Agent不据其结果调参。现有修复后再次进行完整开发组与新保留组验收，前轮10/12报告不改写。

policy 4实测：完整开发48/48+边界12/12通过，报告closure-20261030-policy4-development-fixed；新保留组2/12通过，报告closure-20261030-policy4-holdout，M1仍未过出口。整个IQ49..60现明确退役为开发回归，原冻结JSON/失败报告保留，后续修复不再称盲验。开始policy 5独立补充12份IQ61..72，现有60份答案/支持等级/阈值均不变；不是删除失败或改分母。采样前轮最大间隔2097ms、保留组565ms，资源数据只作采样诊断，非200ms资格。安装生命周期入口修复旧alpha.0写死路径，改按当前版本与归档alpha.2对照，回退使用升级前备份、隔离保留新库，尚待当前新包真实执行。

证据更正：前轮最后的`2026-10-29T20-11-55-364Z-31644`是7阶段失败重试，`fullCoverage=false`，不能代表一次完整34阶段通过；下文前轮记录中的“全绿”以本条更正为准。当前alpha.3归档包也不自动代表后续5c9b51f源码的重新打包资格。

## 前轮实施记录（非当前验收结论）

2026-10-28：用户已授权按 [下一个版本开发大计划](docs/NEXT_MAJOR_VERSION_PLAN.md) 完成开发，目标已激活。主流程按 M0→M6 串行推进；P2 仍为计划中的选做范围，公开发布另遵当次授权。

交付文档：[下一个版本开发大计划](docs/NEXT_MAJOR_VERSION_PLAN.md)。主线为可靠导入、多份简历管理、岗位定制和投递前检查；包含样本矩阵、实施顺序、验收条件和发布边界。

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
