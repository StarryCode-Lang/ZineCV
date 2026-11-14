# 当前任务

历史与验收结论集中 docs/HISTORY_202610.md（2026-11-06 前的任务流水已蒸馏归档，原文见 Git 历史的 plan.md 版本）；本文件只维护当前状态、待办与用户侧边界。

2026-11-12 构建产物无压缩减容轮（已实测收束，未提交；5GiB 目标未达成）：

- **最终保留方案**：dev/test 第三方依赖 `debug=0`，构建脚本/proc-macro `debug=0 + strip=symbols`；本项目行号与 dev 增量保留，test 增量关闭。正式 release 的 `opt-level=3 + fat LTO + codegen-units=1 + panic=abort + strip=symbols` 未变。hooks 改独立 `zinecv-desktop-hooks.exe`，复用 release 依赖且不覆盖正式 EXE。原生链按阶段记录未压缩逻辑字节，超预算使整轮最终失败但不跳过行为测试；daily 不做整盘扫描。新建 debug/release deps 均未启用 NTFS 压缩。
- **空间结论**：同口径 All 从原始 10.381GiB 降至 7.936GiB（-23.5%）；完整 hooks/引擎示例/专项并清理本轮隔离数据后，项目为 10.880GiB（debug 7.030、release 3.390、其余约 0.46），**未达到 5GiB**。正式 EXE 仍为 76,815,360 字节，当前 SHA-256 `d6772448feb53060bb56a8d84b4072392ed6bd0f3421691a154eb6f0470770ad`；hooks EXE 76,812,800 字节，SHA-256 `dfd7b54ebc7e64318382ee3077a0bb629e10dfbdb1c2dce1b6e685a1f4a87da1`。外置实验备份、临时索引和隔离数据已删除，有效 target、收据和热缓存保留；不靠移出/归档/删除有效缓存宣称达标。
- **构建与热性能**：优化后干净 Native `2026-11-12T17-25-52-797Z-41532` 全绿 14m21.583s，check:native 403.753s、test:native 400.467s（原始两项合计 1514.149s，现 804.220s）；热 All `2026-11-12T18-15-40-445Z-18056` 所有行为阶段通过、仅预算失败，总时长 5m21.853s（原始 7m20.404s），check:native 22.081s、test:native 69.725s、browser 54.244s、WebView2 145.933s，release 收据复用。
- **真实运行基准**：5 页导出 `pdf-export-2026-11-12T19-41-47-992Z` 通过，p50 1021.3ms、p95 1114.8ms（原始 1238.8/1270.4ms）；1000 次提交 `commit-snapshots-2026-11-12T19-42-08-570Z` 通过，commit p50 6.2ms、p95 8.6ms、总耗时 17.325s（原始 6.8/10.1ms、19.879s）。
- **覆盖与前存问题**：Rust Native、hooks、fit/export、migration/publication/fit-faults/worker hooks/权限均通过；engine-parity 9/9 通过。完整 Full 不是全绿资格：preview 2 项、source-layout 2 项、fonts 1 项在原始基线 EXE 上同样失败，visual-parity 另有同类 668/676 几何差异；未修改测试、golden 或超时。预算门禁与行为结果在 run.json 中分开记录，不拼接独立结果冒充 full passed。
- **否决实验与剩余取舍**：第三方 `opt-level="s"` 虽将 Native 后体积降至 5.080GiB，但 check/test 冷编译约翻倍，已回退。要达到 5GiB 必须另行授权清理有效 debug/test 缓存、外置缓存或重做依赖/工具链边界；这些与本轮硬约束冲突，未执行。未替换 Typst/Tauri 核心、未默认构建 WASM/OHOS、未提交/推送/发布。

2026-11-12 底层性能/稳定性优化轮（未提交，待用户验收授权）：

- **验证结论**：全 workspace `cargo clippy --all-targets -D warnings` 干净 + Rust 416 测试 0 失败；`npm run check` 全套 8.4s PASS（check:ts 增量 + unit 220 + contracts/fixtures/licenses）。全程以 14s 级 daily 套件回归，符合秒级~分钟级验收约束。未动 IPC 契约、未动测试阈值、未动迁移/备份安全语义（升级与恢复路径保持完整校验）。
- **storage（启动与热路径）**：`open_once` 正常路径改 `prepare_assuming_validated`，同一次打开不再重复 2 次 integrity_check + 1 次全资源重哈希；`migrate` 按 COUNT 全集 + marker 短路（正常打开零写事务；`restores_v1_backup…` 测试证明 MAX 短路不够，已按全集校验）；`recover_interrupted_agent_runs` 先只读预检再开写事务；`apply_command` 文档/receipt 序列化 4→2 次（哈希复用已序列化字节，值不变）；`save_draft`/`acquire_lease`/`collect_unreferenced`/identity 写路径 deferred→IMMEDIATE（消 WAL 升级 BUSY_SNAPSHOT 竞态）；热循环接入 `prepare_cached`（资源引用/agent 会话持久化/版本详情）；`load_version_graph_detailed` 图+详情收敛单一读快照（消竞态误报 Corrupt）+ snapshot 校验 parse 去重；`document_meta` 单条查询替代全表扫描；identity 失败闸 Mutex 中毒自愈；`list_agent_proposals` 无过期时走读事务不再每次拿写锁；legacy 导入 `missing_origins`/head 查找 O(B×C)→索引，每提交少 1 次整文档克隆+1 次序列化（domain 新增 `validate_resume_document` 借用校验）。
- **宿主（src-tauri）**：41 个重命令加 `#[tauri::command(async)]`（documents/versions/imports/proposals/jobs/avatar/provider 账户/agent sessions），SQLite、备份恢复、导入迁移等不再冻结 WebView2 UI 线程（107 命令中同步在 UI 线程执行的问题收敛；轻命令保留同步）；渲染成功但租约释放失败不再丢弃 90 秒渲染结果（TTL 兜底+诊断输出）；`read_avatar_asset` 的 ~11MB base64 编码移出全局 Store 锁；渲染 manifest 发送改借用序列化视图（消每次渲染整份文档深拷贝，JSON 形状不变）；启动时 settings/文档元数据读错误不再静默降级为默认文档。
- **engine/agent**：`DocumentWorld` 头像字节预转 `Bytes`（Arc 共享，编译期多次供给不再复制 MB 级缓冲）；**agent 流式修复**——reqwest Client 45s 总超时会掐断首 token/生成超 45s 的慢速流，改为不设总超时 + 30s 读空闲，总时长仍由外层 90s 预算与取消 watch 兜底（agent 21 测试全过）。
- **platform（TS）**：`flushEditorBuffers` 在页面隐藏时退回 setTimeout（rAF 节流曾使关窗前 flush 永久挂起——关窗丢数据类修复）；`COMMAND_LIMIT` 64→256（合计条目 >64 时「清空简历」永久保存失败的容量修复，仍是有限步保护）；`NativeDocumentClient` 新增 cursor/hostEpoch 廉价访问器，内部读游标不再深拷整份文档；`retryFailed` 并发重入防护。
- **已识别暂缓（记录待立案）**：前端键击热路径 3 遍 DOMParser+6 次 canonical 序列化（需 HTML 缓存+早退比较+可选防抖，涉等价性验证）；agent 每调用新建 reqwest Client/DNS（需自定义 resolver 保 SSRF 语义）；SSE 对 usage-only 帧与缺 [DONE] 的兼容放宽（需 provider 清单确认）；TextMap 逐字形堆分配重构；Typst warning 即失败的分级；导出管线 decode/哈希重复 4-6 次合并（涉票据独立防线）；AvatarAsset 改 Arc（公共 API）；`load_agent_session` 单会话直取（涉校验语义）；worker stderr 采集与握手超时可重试；`synchronous=FULL→NORMAL`（断电持久性取舍需产品决策）。

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
- 后续可选项（需另行授权立案，非本轮）：单测常驻模块图 + 线程池运行器（预计 unit 10s→4-6s，需重验隔离语义）、浏览器套件常驻 vite 服务复用（预计 -10-15s）。


## 用户侧边界（非开发待办）

- 实际 PDF 编辑器（Acrobat 等）人工编辑抽查：工具级证据齐全（文本对象/字体嵌入/提取顺序/遮盖零残留），由用户按需抽查。
- R02 许可清单仍 review-required（人工审查未完成）；WonderCV 图标为有许可替代字形，不称像素一致。
- `D:\Desktop\resume DIY` 的删除由用户手动执行（删除安全性结论见 HISTORY 2026-11-06）。
