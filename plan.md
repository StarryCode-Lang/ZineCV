# 当前任务

历史与验收结论集中 docs/HISTORY_202610.md（2026-11-06 前的任务流水已蒸馏归档，原文见 Git 历史的 plan.md 版本）；本文件只维护当前状态、待办与用户侧边界。

2026-11-06 迁移收束（前端迁移与数据交接）：

- 旧版逐框编辑归档只读恢复入口完成：`list_legacy_edit_archives` IPC（主窗只读，分块数量/连续性/身份摘要校验，损坏显式报错）+ 命令面板「查看旧版逐框编辑归档」+ LegacyArchivesDialog（复制文字/原始 JSON，原始归档不改动）。
- 原版式 PDF 链接收束：源 PDF 注记链接（HTTP/HTTPS/mailto）随导入保留为旋转页坐标，宿主从持久模板修订独立校验 URL/页码/坐标；TextMap 可选 pageLinks，输出检查对实际 PDF 核对目标/数量/矩形（2pt 容差）；不支持动作标记不完整并阻止 PDF 导出，旧模板无注记时保持原 TextMap 表示并在投递检查提示。
- 正式库恢复与实机验收：发现 2026-11-05 已恢复的候选在两个会话之间被回滚为 schema-17 旧状态（回滚机制未定论；旧状态字节与 app 自建 pre-upgrade 备份均留档）。以哈希核验候选 `.migration-private/reconcile-candidate-staged-20261105`（SHA-256 `0df4e4d8…`）重新恢复：恢复前双备份 `live-rolledback-before-restore-20261106.*`；恢复后实机 release EXE 经命令面板打开归档弹窗（2 条目、键前缀 `resume-diy-imported-text-v1:`、内容节点非空），应用自带「关闭窗口」正常退出 exitCode=0，退出后 integrity_check 通过且 3 文档/4 草稿/12 提交/9 分支/194 归档键/2 逐框归档与候选逐项一致。
- 统一回归（冻结源码各一次全绿）：UI 链 8 阶段（check:ts、unit 220、contracts/fixtures/licenses、browser 62、build:native 收据复用、webview 4/4，run `2026-11-05T15-46-46Z`；首跑 webview boot 测试因后台负载 90s 超时，单独复测通过后整链复跑全绿）；Native 链 4 阶段（check:native、test:native、test:bindings，run `15-51-30Z`）。boundaries 13、绑定 136、IPC 75。
- 大清理：删除 `.artifacts` 根 12 个一次性脚本、清空 runtime-tmp（约 399MB 合成数据/隔离 profile）与 tmp、移除 `%APPDATA%` pre-upgrade bak 的 0 字节旁文件（防再次误读备份为主库）；回执 `.artifacts/maintenance/cleanup-20261106.json`。保留 releases/maintenance/analysis/verification-runs 与 `.migration-private` 全部证据。
- 三分析工具同步与提交推送见 HISTORY 2026-11-06 条目；CI 以 GitHub 实际运行为准。

## 唯一开发待办：回归验收 ≥10× 提速（覆盖不减）

用户指令（2026-11-06）：在都可以测试到位的前提下，所有测试/回归/验收任务运行时间至少缩短到原来的十分之一。前史：同覆盖日常检查 53.549→28.274s（1/5 目标 ≤10.710s）未达成。

2026-11-06 首轮实测与落地（同覆盖、同断言、全部真实执行）：

- 已落地：`check:ts` 加 `--incremental`（tsbuildinfo 存 `node_modules/.cache`，CI 无缓存时退化为现状全量检查）。日常检查（`node tools/verify-project.mjs --suite daily` 直启口径）改动前实测 15.5/15.9/20.7/21.9s（中位 18.3s），改动后 12.8/13.2/13.2/14.5s（中位 13.2s）——稳定约 1.4×，方差显著收窄；相对记录在案的 `npm run check` 28.274s 口径 ≈ 2.1×。
- 已实测并否决：test:unit 单进程 `--experimental-test-isolation=none` 23.1s（比并发进程 16-18s 更慢，220 项顺序执行得不偿失）；并发 8→16 无稳定收益（13.7/17.6s 波动，宿主后台负载主导）。unit 已启用 V8 编译缓存（register-ts-resolve.mjs），无进一步免费收益。
- 物理下限结算（同覆盖不可绕过）：日常检查 ≈13s 中，test:unit 占 ~10s（32 文件×node 进程+模块图实例化+220 项真实断言）；10× 目标（≤2.83s）在当前架构下不可达。UI 链 286s 中 test:webview 166s（4+1 次真实 app 冷启动，单次启动 10–20s）+ test:browser 84s（62 项真实交互 ≈1.35s/项）——10×（28.6s）等价于取消真实浏览器/宿主覆盖，与「测试到位」互斥；同覆盖理论下限 ≈150–180s。extended 30 分钟×3 观察预算与 10× 总耗时的冲突在 2026-10-30 已明确告知。
- 后续可选项（需另行授权立案，非本轮）：单测常驻模块图 + 线程池自定义运行器（预计 unit 10s→4-6s，需重验隔离语义）、浏览器套件常驻 vite 服务复用（预计 -10-15s）、WebView2 测试保持现状（启动次数即覆盖本身）。


## 用户侧边界（非开发待办）

- 实际 PDF 编辑器（Acrobat 等）人工编辑抽查：工具级证据齐全（文本对象/字体嵌入/提取顺序/遮盖零残留），由用户按需抽查。
- R02 许可清单仍 review-required（人工审查未完成）；WonderCV 图标为有许可替代字形，不称像素一致。
- `D:\Desktop\resume DIY` 的删除由用户手动执行（删除安全性结论见 HISTORY 2026-11-06）。
