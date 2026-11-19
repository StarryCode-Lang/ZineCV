# 当前任务

历史与验收结论集中 docs/HISTORY_202610.md（2026-11-06 前的任务流水已蒸馏归档，原文见 Git 历史的 plan.md 版本）；本文件只维护当前状态、待办与用户侧边界。

2026-11-19 原版式逐框像素保真轮（真实 PDF + 两份合成可编辑 PDF，已实测收束）：

- **修复（字号被误缩）**：PDF 行框宽是**墨迹宽**（不含左右侧边距），文字 advance 天然比框宽大 2%~12%。旧 `fitFontSize` 拿新文字直接和框宽比较，同字符数替换也会缩字号（真实样例 59 框中 14 框中招，最严重缩到 89.6%）。现在以“原文字实测宽度 + 4% 字号余量”为下限，并允许用到同一行右侧最近文本框之前；只有真正超出可用横向空间才缩，且单行补丁禁止换行。逐框实测：59/59 框字号与行高保持原值。
- **修复（擦除越界）**：外扩底色 3px 会盖掉相邻行的抗锯齿（“个人简历 / Personal Resume”两行墨迹几乎相接，改大字标题会削掉下一行顶部）；补丁自身行盒的白色底也比受控擦除范围更高，会擦掉下一行。外扩改为横向 2px、上沿 1px、下沿按“基线 + 降部（无降部字母/标点时 0.06em）+1px”收口，并由下一行文本框上沿兜底；补丁底色改为透明，只由外扩底色负责擦除。
- **逐框验收（不是抽样）**：真实中文 PDF 59 框、合成双栏 PDF 26 框、合成高密度中文 PDF 39 框，共 124 框全部逐框做“同宽替换”（交换相邻异字符/等宽候选）。每框对比 预览截图、144dpi PNG 导出、Chromium 打印 PDF 三种产物：基线两次渲染逐字节一致；编辑后差异像素 0 落在被编辑框/新文字墨迹之外，0 落在其他文本框的墨迹内；补丁计算字号、行高、字体族与源框一致。导出 PDF 仍为 1 页且文字层包含修改值。
- **回归**：新增浏览器用例“同宽编辑 ink-width PDF 框不缩字号且擦除不越过下一行”；`node --test tests/browser/source-layout.test.mjs` 14/14；`npm run check` PASS（unit 226/226）；release 构建收据 `74bc770c…`，真实 EXE 原版式导出 UI 链（模板激活→投递检查→PDF/PNG 写盘回执→取消）通过。`test:webview-source-layout-dev` 仍按既有口径需要 dev 宿主（动态 import `/src`），release EXE 上失败属该用例的宿主约束，不影响 UI 链结论。GitNexus `impact ImportedLayoutPaper` 为 HIGH（共享预览组件，调用方 ResumePreviewPane/source-layout-render/source-layout-print 均已由上述三产物覆盖），`detect-changes --scope all` 4 文件/18 符号/0 受影响流程/low；`audit:ast` 已刷新（12 类查询）。`docs/target.archify.json` 无模块结构变化，未改。
- **CI 回归（导出文字核对）**：上一轮的兼容汉字折叠把 `\u2F800-\u2FA1F` 直接写进字符类；JS 只取 4 位十六进制，实际解析成 `\u2F80` + 字符 `0`，字符类被扩成 `0-\u2FA1`，连 ASCII 字母都被 `CJK_CHAR` 判为汉字。结果是**任意等长文字的 PDF 都能通过导出核对**（GitHub Windows verification 连续两轮在 `export-output` 用例失败）。改用 `\u{2F800}-\u{2FA1F}` 码点转义，并补充注释；本地 `npm run test:browser` 63/63 通过；GitHub Windows verification run `44484153958` 全绿（14m59s，Fast browser + Native checks）。workflow 的三个 action 同步升到 `checkout@v5`、`setup-node@v5`、`upload-artifact@v6`（Node 24 运行时），消除 Node 20 弃用告警。
- **清理**：删除空 `.screenshots` 与本地逐框审计脚本/截图/合成 PDF（均在忽略目录）；`.gitignore` 增加 `.screenshots/`、`Thumbs.db`、`Desktop.ini`、`.DS_Store`、`*.tmp`。远端 master 跟踪树无临时二进制或个人简历文件；保留 `docs/evidence` 受控证据。

2026-11-19 模板无损编辑轮（真实 release EXE + WebView2，已实测收束）：

- **修复（PDF 版式）**：同一基线上的左右栏/独立字段此前被拼成一个宽文本框（如 CET-6 与普通话、公司名与职位、民族与学历、学校与学位），修改一侧会带着另一侧重排。新增 `splitHorizontalSegments`：按 ≥0.5em（至少 4px）的横向空白切段，正常词距不切；PDF/Word 导入默认勾选“同时提取原版式（推荐）”。
- **修复（导入编辑器）**：页眉判定用数组第一项的 y 当栏顶，而 PDF 框序可能从页尾长 bullet 开始，导致正文被塞进“基本信息”页眉组；改为取所有窄栏框的最小 y 作为栏顶。导入后左侧从“个人简历/姓名”开始分组。
- **实测三模板全流程**：真实中文 PDF（59 个唯一框）、合成双栏 PDF（9 框）、DOCX（8 框）均走完 导入→应用→逐框编辑姓名/证书/学院→PNG 导出→PDF 导出→提交版本；三份模板的基线 PNG 两次导出逐像素一致，编辑后 PNG 与基线的差异 0 像素落在被编辑框之外；PDF 均 1 页，导出文字包含修改值与未修改字段；提交后 59/9/8 个字段与修改值完整恢复。真实 PDF 预览截图与源文件版式一致（未编辑时补丁数为 0）。
- **检查**：`npm run check` PASS（unit 226/226）；release 构建收据 `6b2baa1d…`。本轮结束后提交并推送。
- **仍属字体子集限制**：PDF 文字层可能把部分汉字写成康熙部首/兼容字（视觉与版面不受影响，导出检查按等价字符处理）。

2026-11-19 全交互巡检续轮（真实 release EXE + WebView2，已实测收束）：

- **修复（原生）**：版本备份“替换当前版本库”对刚提交、没有 durable draft 的正常干净状态报 “Stored data could not be read or verified”，实际底层为 `Corrupt("Current durable draft is missing")`；现在无草稿时回退当前分支 head 快照并校验其修订/哈希。替换还按备份的“新→旧”顺序插提交，`commit_links.visible_parent_id` 外键会指向尚未插入的父提交；改为先落全部提交、再统一写父链。新增 2 个 storage 回归测试（干净状态、父链倒序）。
- **修复（UI）**：版本库替换成功后“已读取版本备份/替换当前版本库”面板仍残留，看起来像操作未完成；版本库对象更新后自动撤下预览。确认框对“载入/恢复/替换/跳转”等非删除动作也显示垃圾桶图标，改为回转图标；隐藏用 EyeOff，删除/清空/移除才用 Trash2。
- **实测通过**：字体宋体↔雅黑、字号 13↔18px、正文行距 24px、模块间距 12px、页距 30px 即时生效且预览无溢出；智能排序把甲大学(2022)→乙大学(2028) 正确重排并提示；预览缩放 63→83→63、83% 时纸张宽度=预览区宽度、全屏进入/Escape 退出；导出菜单四项、PNG 300 DPI、复制文本 toast；窗口最大化↔还原；DOCX 导入→收藏→已收藏筛选→取消收藏空态→最近使用→应用；模块隐藏（确认）→预览减少→恢复→改名“核心技能”同步编辑区/按钮→上移下移；指令面板 22/23 条、搜索“版型”回车跳转、Esc 关闭；模板审阅导入 6 条候选、校正输入、确认应用后编辑区 6 模块；取消审阅不改动简历；版本备份导出→三次提交→替换回三条提交（4→3）、面板撤下、toast“版本库已替换，当前工作内容未自动变更”；“载入”确认框图标为 RefreshCw；完整数据库备份→导出→改名→恢复，恢复后的工作区回到备份内容，pre-restore 备份文件真实存在，toast 报告 schema 与副本路径；PDF 导出 21,957 字节 `%PDF-`，PNG 导出 66,090 字节签名 `89504e47`；清空简历取消保留、确认后清空。
- **编辑区细节**：模块收起/展开、条目收起/展开、删除经历确认（取消保留/确认移除且预览同步）、`＋身高` 展开填写后预览显示“170cm”、删除版本确认（取消后仍为 2 个提交，Trash2 图标）、窗口最小化后经 Win32 恢复且页面继续可操作。
- **补充链路**：条目拖动把手的 ArrowDown/ArrowUp 键盘换序真实生效并可还原；版本备份勾选“附带当前未提交草稿”后，导入预览显示“以及 1 份未提交草稿”，“载入此草稿”变为“草稿已载入”并恢复内容；旧版数据入口选择非旧版 JSON 时提示“缺少 branches/commits 结构”，版本库不受影响。
- **检查**：`npm run check` PASS（unit 225/225）；storage 147/147 + clippy/fmt 干净；release 构建收据 `384f3fc8…`。未提交/推送。
- **已修复**：PDF 左右栏被提取器并入同一宽文本框的问题已在同日“模板无损编辑轮”按横向空白拆段解决；模板库“我的当前模板”卡片仍只作当前版式说明，不提供从导入模板回到内置模板的入口。

2026-11-18 版本/模板/导出巡检轮（真实 release EXE + WebView2，已实测收束）：

- **修复**：模板库删除“当前正在使用”的导入模板无确认、无提示，编辑区会静默退回内置编辑器（右侧仍显示原版式，逐框修改失去绑定）——删除活动模板改为明确报错并保留；删除非活动模板新增确认框，说明“使用该模板的其他简历会退回内置版式，此操作无法撤销”。
- **实测通过**：模板收藏/已收藏筛选/重命名/重新应用/删除确认（取消保留 2 张，确认后剩 1 张且活动模板仍在）；版本提交、新建分支、分支内修改与提交、切回 main 恢复主分支内容、再切回分支恢复分支内容、删除分支（取消/确认）、版本备份、完整数据库备份（遮罩+toast）、跳转到当前分支；预览缩放 63→73→63、恢复默认；普通简历 PDF（修订 12，21KB）与 PNG（63KB）导出成功，PDF 在 WebView2 查看器中字体/排版/分页正确（pdfjs+canvas 全 tofu 属渲染器限制，文字层提取正常）；清空简历确认文案与取消保留；旧版归档空状态弹窗、更新面板、文档空白新建/切回/归档/恢复、ZineBot 展开/最小化/模型设置/新建对话、智能一页（页距调整后仍为 1 页）；长自我评价生成 2 页后“上一页/下一页”1/2→2/2→1/2 且第 2 页无裁切；年龄/生日切换后预览显示“2000.03 出生”；隐藏/恢复自我评价时预览即时增减且确认文案正确。
- **导入对话框修复**：图片文件也显示“同时提取原版式”，但图片只映射为可编辑模块、忽略该选项；识别中两个按钮还同时显示“正在识别文字 11%”。现在图片改为说明“只会识别为可编辑模块，不保留源文件外观”，进度只保留在主按钮，次按钮保持静态文案。
- **DOCX/图片链路**：生成含姓名/联系方式/教育/工作/技能的 DOCX，导入后 9 个字段全部可编辑，改名后导出 PNG 仅文字变化；65 秒完成图片 OCR 并生成可编辑模块（96 字符，映射为留白单栏），编辑区与普通简历一致。
- **版本图与 Agent**：版本节点“载入”弹窗提示“未提交修改不会被保存”，确认后工作内容回到所选版本（版本乙→版本甲）；导入模板重命名后编辑页标题同步为“活动改名模板”；本机账户注册（audit@example.invalid）成功，模型连接表单（连接名称/Base URL/API Key/模型 ID/测试连接/保存连接）完整渲染。
- **检查**：`npm run check` PASS（unit 225/225）；release 构建收据 `34c2faed…`。

2026-11-18 导入模板端到端巡检轮（真实 release EXE + WebView2，已实测收束）：

- **修复**：导入原版式后编辑器把 50 个文本框渲染成 52 个输入（宽页眉行同时落进左右栏，`p1-b46/b48` 重复）——`groupBoxes` 先从列里剔除页眉再前置；新识别模板应用时用的是写库前对象，文档身份缺 `revisionHash`，原版式 PNG/PDF 导出被修订校验拒绝——改为应用本机目录写回后的模板；PDF 输出检查把字体子集写出的康熙部首/异体字（⾼→高、户→戶）判为文字不一致而阻断导出——增加兼容折叠与“同位汉字”容差；打印路径对所有未编辑框重复绘制文字和补丁底色，导出 PDF 出现色条与重影——打印时未编辑框只输出 1% 透明文字层、不画遮盖，画面完全来自原图。
- **实测链路**：上传 PDF→识别并勾选原版式→应用（50/50 唯一字段、身份含修订号）→返回编辑→改名（仅文字变化、62px 原字号、单补丁）→改正文→投递前检查→PNG/PDF 导出（修订 30）→提交版本→重启后文字与修订保留并再次导出成功。核心编辑器：富文本加粗/撤销/重做、自我评价、模块下移/上移、文档空白新建与切回、提交与新建分支均通过。`npm run check` PASS（unit 225）。
- **已知限制**：该样例 PDF 有 2 处左右栏文字被提取器并进同一宽文本框（如“健身… A score…”），编辑这类框会把两栏当成一行重排；按 DOM 字符间隙与背景墨迹间隙的两种拆分在真实数据上均被证伪后回退，未保留推测性代码。返回模板库后不会自动跳回编辑页，需点“返回编辑”。

2026-11-18 UI 全量巡检轮（真实 release EXE + WebView2，已实测收束）：

- **修复**：93%/150% 预览放大后左缘被裁且无法滚回（`safe center`，实测纸张左缘 = 预览区 +16px）；窄分栏预览标题截成 “LI…”（预览区容器查询，1050 宽隐藏标题）；WebView2 按 Escape 不退出全屏（补键盘退出）；手动“保存”无可见反馈（toast“草稿已保存”）；模块“隐藏”确认文案/按钮/toast 仍写“删除”且配垃圾桶图标（改“隐藏整个模块？/隐藏模块/模块已隐藏”与 EyeOff）；确认框内指针事件不再被顶栏浮层当作外部点击（防御性保留，实际面板由 `requestConfirmation` 主动关闭）；1024 断点被后置 `:root` 覆盖的级联问题（桌面 minWidth 1050 不可达，仅修正）。
- **新构建回归**：模块隐藏→取消保留内容→确认隐藏→模块管理中恢复，文案/图标/状态方向均正确；`＋身高` 展开填写后同步到预览；头像非法文件提示“请选择图片文件”、上传后编辑区与预览一致、移除同步；四个排版面板（字体/字号/行距/颜色）即时生效；清空简历确认取消后内容保留（`确认清空` 文案正确）；章节下拉跳转、富文本链接拒绝 `javascript:` 并插入 https 链接、导出“复制简历文本”toast、版本档案馆切换与返回均正常。
- **验证**：`npm run check` PASS（unit 225/225）；release 构建 `BUILD_RECEIPT 3147afd9…` 成功。未运行全量 All 套件，未提交/推送。

2026-11-12 构建产物无压缩减容轮（已实测收束，已随 9d8855a 提交；5GiB 目标未达成）：

- **最终保留方案**：dev/test 第三方依赖 `debug=0`，构建脚本/proc-macro `debug=0 + strip=symbols`；本项目行号与 dev 增量保留，test 增量关闭。正式 release 的 `opt-level=3 + fat LTO + codegen-units=1 + panic=abort + strip=symbols` 未变。hooks 改独立 `zinecv-desktop-hooks.exe`，复用 release 依赖且不覆盖正式 EXE。原生链按阶段记录未压缩逻辑字节，超预算使整轮最终失败但不跳过行为测试；daily 不做整盘扫描。新建 debug/release deps 均未启用 NTFS 压缩。
- **空间结论**：同口径 All 从原始 10.381GiB 降至 7.936GiB（-23.5%）；完整 hooks/引擎示例/专项并清理本轮隔离数据后，项目为 10.880GiB（debug 7.030、release 3.390、其余约 0.46），**未达到 5GiB**。正式 EXE 仍为 76,815,360 字节，当前 SHA-256 `d6772448feb53060bb56a8d84b4072392ed6bd0f3421691a154eb6f0470770ad`；hooks EXE 76,812,800 字节，SHA-256 `dfd7b54ebc7e64318382ee3077a0bb629e10dfbdb1c2dce1b6e685a1f4a87da1`。外置实验备份、临时索引和隔离数据已删除，有效 target、收据和热缓存保留；不靠移出/归档/删除有效缓存宣称达标。
- **构建与热性能**：优化后干净 Native `2026-11-12T17-25-52-797Z-41532` 全绿 14m21.583s，check:native 403.753s、test:native 400.467s（原始两项合计 1514.149s，现 804.220s）；热 All `2026-11-12T18-15-40-445Z-18056` 所有行为阶段通过、仅预算失败，总时长 5m21.853s（原始 7m20.404s），check:native 22.081s、test:native 69.725s、browser 54.244s、WebView2 145.933s，release 收据复用。
- **真实运行基准**：5 页导出 `pdf-export-2026-11-12T19-41-47-992Z` 通过，p50 1021.3ms、p95 1114.8ms（原始 1238.8/1270.4ms）；1000 次提交 `commit-snapshots-2026-11-12T19-42-08-570Z` 通过，commit p50 6.2ms、p95 8.6ms、总耗时 17.325s（原始 6.8/10.1ms、19.879s）。
- **覆盖与前存问题**：Rust Native、hooks、fit/export、migration/publication/fit-faults/worker hooks/权限均通过；engine-parity 9/9 通过。完整 Full 不是全绿资格：preview 2 项、source-layout 2 项、fonts 1 项在原始基线 EXE 上同样失败，visual-parity 另有同类 668/676 几何差异；未修改测试、golden 或超时。预算门禁与行为结果在 run.json 中分开记录，不拼接独立结果冒充 full passed。
- **否决实验与剩余取舍**：第三方 `opt-level="s"` 虽将 Native 后体积降至 5.080GiB，但 check/test 冷编译约翻倍，已回退。要达到 5GiB 必须另行授权清理有效 debug/test 缓存、外置缓存或重做依赖/工具链边界；这些与本轮硬约束冲突，未执行。未替换 Typst/Tauri 核心、未默认构建 WASM/OHOS、未发布。

2026-11-12 底层性能/稳定性优化轮（已随 9d8855a 提交）：

- **验证结论**：全 workspace `cargo clippy --all-targets -D warnings` 干净 + Rust 416 测试 0 失败；`npm run check` 全套 8.4s PASS（check:ts 增量 + unit 220 + contracts/fixtures/licenses）。全程以 14s 级 daily 套件回归，符合秒级~分钟级验收约束。未动 IPC 契约、未动测试阈值、未动迁移/备份安全语义（升级与恢复路径保持完整校验）。
- **storage（启动与热路径）**：`open_once` 正常路径改 `prepare_assuming_validated`，同一次打开不再重复 2 次 integrity_check + 1 次全资源重哈希；`migrate` 按 COUNT 全集 + marker 短路（正常打开零写事务；`restores_v1_backup…` 测试证明 MAX 短路不够，已按全集校验）；`recover_interrupted_agent_runs` 先只读预检再开写事务；`apply_command` 文档/receipt 序列化 4→2 次（哈希复用已序列化字节，值不变）；`save_draft`/`acquire_lease`/`collect_unreferenced`/identity 写路径 deferred→IMMEDIATE（消 WAL 升级 BUSY_SNAPSHOT 竞态）；热循环接入 `prepare_cached`（资源引用/agent 会话持久化/版本详情）；`load_version_graph_detailed` 图+详情收敛单一读快照（消竞态误报 Corrupt）+ snapshot 校验 parse 去重；`document_meta` 单条查询替代全表扫描；identity 失败闸 Mutex 中毒自愈；`list_agent_proposals` 无过期时走读事务不再每次拿写锁；legacy 导入 `missing_origins`/head 查找 O(B×C)→索引，每提交少 1 次整文档克隆+1 次序列化（domain 新增 `validate_resume_document` 借用校验）。
- **宿主（src-tauri）**：41 个重命令加 `#[tauri::command(async)]`（documents/versions/imports/proposals/jobs/avatar/provider 账户/agent sessions），SQLite、备份恢复、导入迁移等不再冻结 WebView2 UI 线程（75 命令中同步在 UI 线程执行的问题收敛；轻命令保留同步）；渲染成功但租约释放失败不再丢弃 90 秒渲染结果（TTL 兜底+诊断输出）；`read_avatar_asset` 的 ~11MB base64 编码移出全局 Store 锁；渲染 manifest 发送改借用序列化视图（消每次渲染整份文档深拷贝，JSON 形状不变）；启动时 settings/文档元数据读错误不再静默降级为默认文档。
- **engine/agent**：`DocumentWorld` 头像字节预转 `Bytes`（Arc 共享，编译期多次供给不再复制 MB 级缓冲）；**agent 流式修复**——reqwest Client 45s 总超时会掐断首 token/生成超 45s 的慢速流，改为不设总超时 + 30s 读空闲，总时长仍由外层 90s 预算与取消 watch 兜底（agent 21 测试全过）。
- **platform（TS）**：`flushEditorBuffers` 在页面隐藏时退回 setTimeout（rAF 节流曾使关窗前 flush 永久挂起——关窗丢数据类修复）；`COMMAND_LIMIT` 64→256（合计条目 >64 时「清空简历」永久保存失败的容量修复，仍是有限步保护）；`NativeDocumentClient` 新增 cursor/hostEpoch 廉价访问器，内部读游标不再深拷整份文档；`retryFailed` 并发重入防护。
- **已识别暂缓（记录待立案）**：清单 9 项已于 2026-11-18 收口，逐项结论与实测见下节；仍未执行：`synchronous=FULL→NORMAL`（断电持久性取舍需产品决策）、5GiB 减容（需另行授权清理有效缓存）。

2026-11-18 暂缓清单 9 项收口（一轮一项、可独立回退；阈值/预算未改）：

- **前端键击热路径**：`stripHtml` 加 Map 缓存（上限 200，超限整体清空避免无界增长）、展开态省两次 DOMParser、顶层文档 canonical 加 WeakMap + 同引用早退。同 fixture（3 遍 DOMParser + 6 次 canonical）实测 30.92→19.75ms。等价性：缓存仅以 HTML 字符串为键、同输入同输出；unit 225/225 与 `npm run check` 通过。
- **agent Client/DNS**：`ClientKey{host,port,timeout_ms,idle_ms,addresses}` + 上限 8 的有界缓存；每次请求仍解析、校验并钉扎 DNS（自定义 resolver 保持 SSRF 语义），只复用连接池。实测重复流式请求服务端 accept=1；新增 `repeated_streams_reuse_the_pooled_connection`。
- **SSE usage-only / 缺 `[DONE]`**：**保持现状，不放宽**。依据：本端不请求 `stream_options.include_usage`，合规 provider 不会发 usage-only 帧；缺 `[DONE]` 提前结束是截断防线，放宽会掩盖真实截断。provider 文档因登录拦截无法取得，按「无法确认则保持现状」记录。
- **TextMap 逐字形堆分配**：`RawCluster` 改 `run_text: Arc<str>` + `text_range: Range<usize>`，共享 run 文本而非每字形独立 String。实测 6386→5421 allocs/run（−15%）；engine 44/44。
- **Typst warning 分级**：新增 `BENIGN_TYPST_WARNINGS` 白名单与 `is_benign_typst_warning`，仅非良性 warning 判失败，其余 warning 仍按原规则失败；`warning_policy_tests` 覆盖两侧。
- **导出 decode/hash 合并**：release 实测 4 页 / 6 产物 / 6.49MB base64：decode+hash 单趟 5.43ms（debug 同测 ≈152ms，含 ≈96ms hash），同进程额外 in-memory hash 2.85ms。只合并两处同进程重复（票据写入复用 `prepare_write` 摘要；原版式 PNG 注册复用 `validate_source_png` artifacts）；**磁盘重读的 `verify_export_file` 独立防线保留**，跨进程重复不合并。
- **AvatarAsset 改 Arc**：`AvatarBytes(Arc<(String, Vec<u8>)>)` 交给 `Bytes::new` 零拷贝；`ExportSnapshot` 仍为 `Option<(String, Vec<u8>)>`，边界一次 `From`。8MiB 头像 16 次 clone 实测 42.467→0.000ms。engine 44/44、desktop 61/61、clippy 干净；wasm 调用点已同步（独立 workspace，按静态核对）。
- **`load_agent_session` 单会话直取**：只取目标会话与消息，另以聚合 SQL（`CASE` 保护畸形 JSON）复现全店校验语义（会话数、header、单会话消息数、总消息、active 存在）。实测 29.637→8.165ms（约 3.6×）；storage 146/146。
- **worker stderr 与握手重试**：stderr 有界尾部（8KiB 环切到 char 边界，错误信息内截 ≤2000 字符）；`StartFailure{retryable}` 区分永久/瞬时，握手超时等瞬时失败自动重试一次并被 generation 记录；运行期崩溃与硬超时语义不变。desktop 61/61，含 `handshake_failures_retry_only_when_transient`、`stderr_tail_is_bounded_and_keeps_the_end`。
- 验证收口：`check -Package zinecv-engine/storage/desktop/agent` 全绿；`npm run check` PASS（unit 225）。临时测量测试与脚本已删除。

2026-11-06 迁移收束（前端迁移与数据交接）：

- 旧版逐框编辑归档只读恢复入口完成：`list_legacy_edit_archives` IPC（主窗只读，分块数量/连续性/身份摘要校验，损坏显式报错）+ 命令面板「查看旧版逐框编辑归档」+ LegacyArchivesDialog（复制文字/原始 JSON，原始归档不改动）。
- 原版式 PDF 链接收束：源 PDF 注记链接（HTTP/HTTPS/mailto）随导入保留为旋转页坐标，宿主从持久模板修订独立校验 URL/页码/坐标；TextMap 可选 pageLinks，输出检查对实际 PDF 核对目标/数量/矩形（2pt 容差）；不支持动作标记不完整并阻止 PDF 导出，旧模板无注记时保持原 TextMap 表示并在投递检查提示。
- 正式库恢复与实机验收：发现 2026-11-05 已恢复的候选在两个会话之间被回滚为 schema-17 旧状态（回滚机制未定论；旧状态字节与 app 自建 pre-upgrade 备份均留档）。以哈希核验候选 `.migration-private/reconcile-candidate-staged-20261105`（SHA-256 `0df4e4d8…`）重新恢复：恢复前双备份 `live-rolledback-before-restore-20261106.*`；恢复后实机 release EXE 经命令面板打开归档弹窗（2 条目、键前缀 `resume-diy-imported-text-v1:`、内容节点非空），应用自带「关闭窗口」正常退出 exitCode=0，退出后 integrity_check 通过且 3 文档/4 草稿/12 提交/9 分支/194 归档键/2 逐框归档与候选逐项一致。
- 统一回归（冻结源码各一次全绿）：UI 链 8 阶段（check:ts、unit 220、contracts/fixtures/licenses、browser 62、build:native 收据复用、webview 4/4，run `2026-11-05T15-46-46Z`；首跑 webview boot 测试因后台负载 90s 超时，单独复测通过后整链复跑全绿）；Native 链 4 阶段（check:native、test:native、test:bindings，run `15-51-30Z`）。boundaries 13、绑定 136、IPC 75。
- 大清理：删除 `.artifacts` 根 12 个一次性脚本、清空 runtime-tmp（约 399MB 合成数据/隔离 profile）与 tmp、移除 `%APPDATA%` pre-upgrade bak 的 0 字节旁文件（防再次误读备份为主库）；回执 `.artifacts/maintenance/cleanup-20261106.json`。保留 releases/maintenance/analysis/verification-runs 与 `.migration-private` 全部证据。
- 三分析工具同步与提交推送见 HISTORY 2026-11-06 条目；CI 以 GitHub 实际运行为准。

## 唯一开发待办：回归验收 ≥10× 提速（覆盖不减）

用户指令（2026-11-06）：在都可以测试到位的前提下，所有测试/回归/验收任务运行时间至少缩短到原来的十分之一。前史：同覆盖日常检查 53.549→28.274s（1/5 目标 ≤10.710s）未达成。

2026-11-07 续轮（全量验收合并 + 顶栏/侧栏修复轮实测）：

- 已落地：`check:ts` 加 `--incremental`（tsbuildinfo 存 `node_modules/.cache`，热跑 14.2s→3.9s；CI 无缓存时退化为现状全量）。日常检查直启口径 18.3s→13.2s 中位（≈1.4×），相对 `npm run check` 28.274s 基线 ≈2.1×。
- 已落地：`all` 套件一条命令全量验收——`powershell -File tools/run-checks.ps1 -Scope All`（= 类型/单元/契约/夹具/许可 + 浏览器 62 项 + check:native + test:native + 绑定 + build:native + webview 4 项），安全阶段只跑一次、浏览器与原生链两 worker 并行调度、收据命中时 build:native 直接复用。实测：重构建轮 757s（构建占 508s），**收据热轮 ≈250s（约 4 分钟）**；对照此前 UI+Native 分开跑（含重复安全阶段与多次调用开销）≈520s+，同覆盖节省约一半。
- 物理下限结算（同覆盖不可绕过）：热轮 250s 中 test:webview ≈145s（5 次真实 app 冷启动，单次 8–15s）、test:native ≈48s、browser ≈31s（并行调度下）；10×（25s）等价于取消真实浏览器/宿主覆盖，与「测试到位」互斥。test:unit 10s 级（32 文件进程模型 + 220 项真实断言）与 webview 启动次数即覆盖本身。
- 已实测并否决：test:unit 单进程 `--experimental-test-isolation=none`（23.1s，比并发更慢）、并发 8→16（波动无稳定收益）；unit 已启用 V8 编译缓存。
- 后续可选项（需另行授权立案，非本轮）：单测常驻模块图 + 线程池运行器（预计 unit 10s→4-6s，需重验隔离语义）、浏览器套件常驻 vite 服务复用（预计 -10-15s）。两项均已于 2026-11-17 执行，实测见下。

2026-11-17 两项候选落地与实测（用户授权本轮执行；覆盖不减，阈值/预算未改）：

- 单测常驻模块图 + 线程池：`test:unit` 改为 `node tools/unit-runner.mjs`，新增 `tools/unit-runner-worker.mjs`。26 个 `tests/unit/*.test.mjs` 仍全量自动发现、文件内用例串行，实测始终 225 项 / 225 通过 / 0 失败，与旧入口一致；断言、阈值、预算均未改动。交错 A/B 3 对（同场同机）：旧 `node --test --test-concurrency=8` 10.62/9.72/10.31s（中位 10.31s）→ 新 7.57/7.62/7.75s（中位 7.62s），≈−26%。**预估 4–6s 未达成**：`verification.test.mjs`≈7.6s、`import-quality-cli.test.mjs`≈5.6s 为子进程/真实 CLI 墙钟，已超过预估总量，模块加载只是其中一部分；线程内并行的上限由这些用例自身决定。
- 分片与隔离语义：worker 间为独立 isolate（模块图、V8 编译缓存、TypeScript loader 常驻但不跨 worker 共享），分片内文件串行，与本套件既有 `test:unit-serial` 单进程模型同级。动态 `beforeExit` 分片方案实测只登记 63/225 项且退出码 0（`node:test` 在根 suite 结束后注册的用例不会执行），已回退为静态分片；失败路径复验 worker 非零退出使整轮 exit 1。分片权重取 `.artifacts/unit-timings.json`（忽略目录缓存），首跑无缓存时轮转，实测 10.06s，与旧入口持平，不做首跑性能承诺。
- 日常检查（`npm run check`，同口径 5 阶段）：14.53s（unit 阶段 12.83s）→ 11.55s（unit 9.85s），两次均 PASS、unit 225/225。
- `-Scope All` 热轮：363.59s → 351.83s，但该差值处于单次运行噪声内，不能归因于本次改动：unit 阶段 11.95→11.00s，browser 48.76→55.03s（两次均 62 项通过），test:webview 191.97→170.59s（真实宿主冷启动波动），其余阶段 ±3s。同一改动下真正可归因的只有 unit 阶段（交错 A/B 支撑）。注意 `package.json` 是 `build:native` 收据输入，切换 `test:unit` 入口会触发一次真实重建（该轮 963s 构建、总 1279s），收据重录后再次命中恢复热轮；这是收据设计的一次性代价，不是每轮成本。
- 浏览器常驻 vite 复用：共享 vite 服务与共享 Chromium 已在 ce15ff1 落地（`enableSharedBrowserTestServers`，per-test `close()` 为空操作）。实测共享服务首建 2455ms、同 root 后续 0ms；仅 `sourceOverrides` 的 3 个服务器按隔离要求不共享（首个因依赖重优化 3078ms，后续 58ms）。全部服务器启动成本合计 ≈5.6s，占浏览器套件 ≈48.8s 的约 11%，继续合并只能再省 ≤3s 且需打破 override 隔离；**预估 −10–15s 不成立**，故不改代码（无改动可回退）。
- 体积预算：两轮 All 的 `check:native`/`test:native` 记录 9.26–9.28GiB，超 5GiB 预算使整轮为 partial（行为阶段全部 PASS）；此为既有 `src-tauri/target` 体积状态，与本轮改动无关，未调整预算。


## 用户侧边界（非开发待办）

- 实际 PDF 编辑器（Acrobat 等）人工编辑抽查：工具级证据齐全（文本对象/字体嵌入/提取顺序/遮盖零残留），由用户按需抽查。
- R02 许可清单仍 review-required（人工审查未完成）；WonderCV 图标为有许可替代字形，不称像素一致。
- `D:\Desktop\resume DIY` 的删除由用户手动执行（删除安全性结论见 HISTORY 2026-11-06）。
