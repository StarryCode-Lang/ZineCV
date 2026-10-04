# 剩余工作执行计划（2026-10-04）

编制：2026-10-04。基线：`docs/TASK_20261004-audit-parity-performance.md`（审核+修复+终验 30/31）之后的工作树；权威切片 `docs/SLICE_20261002.md` §16。参考仓库 `D:\Desktop\resume DIY` 只读。硬约束不变：不提交/推送/发布；四份保护文档不改；native 全经 `tools/with-msvc.ps1`；WebView2 串行；每项改动跑最小验证并记退出码。

## 速览：全部剩余项（按优先级）

**2026-10-04 执行范围调整（用户明确指示）**：A1–A5、B1–B4、C1 继续执行；D1 真人验收由用户自行完成，D2–D6 移出本轮执行范围，不再等待材料或作为本轮完成门禁。相关矩阵与许可记录仍保留“未验证/缺失”的事实，不将范围调整记为通过。B3 本地协议、离线字体、视觉及包体验证继续执行；外部 VM、签名与许可验收不执行。最新执行证据与限制另记在本轮 TASK 文档中。

| 编号 | 项 | 类型 | 前置 |
| --- | --- | --- | --- |
| A1 | Agent 会话写放大去抖重做（接线回退后的复刻） | 代码 | 无 |
| A2 | F43 磁盘满/文件占用注入测试 | 测试 | 无 |
| A3 | F16 PDF 结构/阅读顺序自动化 | 测试 | 无 |
| A4 | >1000 提交按需详情 IPC（version_commit_detail 命令） | 代码+契约 | 无 |
| A5 | B0 建议的 4 条 supplemental 验收行（S01–S04）入矩阵 | 簿记 | 无 |
| B1 | E2 构建档实验（dev/test debug 信息） | 实验 | 独占构建窗口 |
| B2 | E3 依赖/资源/NSIS 精简核查 | 实验 | B1 或独立 |
| B3 | E1 字体统一来源 PoC 实施 | 架构变更 | **用户授权** |
| B4 | C 阶段补全：30min soak、四场景构建计时、drag/commit bench | 测量 | 独占窗口 |
| C1 | 52 行矩阵证据簿记（F2 schema 重录 + 逐行升级） | 簿记 | A1–A5 完成后 |
| D1 | 真人 IME/辅助技术验收（F07/R27/F15/F42） | 外部 | 真人 |
| D2 | 干净 Win10/11 VM 断网/升级/卸载（D01–D04） | 外部 | VM |
| D3 | Authenticode 签名与升级链（D05） | 外部 | 证书 |
| D4 | 真实模型 connectionId 端到端（F33/F36/F38/R25） | 外部 | 凭据 |
| D5 | Georgia/iconfont 再分发许可（F10/F11/F44/D03） | 外部 | 授权文件 |
| D6 | 另一执行者干净复现（D08） | 外部 | 第二执行者 |

## A 本地代码收口（下一轮即可执行）

### A1 Agent 会话写放大去抖（重做）
- 背景：`sessions.ts` 已有 800ms trailing 去抖 API（`scheduleAgentSessionWrite`/`flushScheduledAgentSessionWrite`，带单测）但 AgentOverlay 接线因回归回退（过程见 TASK_20261004 §3.1）。
- 要求：接线必须同时覆盖 流式 delta（runState==="running" 分支）、流结束/浮层收起/卸载/账户切换 flush；`changeAccount` 内**先同步重置状态再 await flush**（顺序错会清掉挂载回填）；完成后跑 `test:unit` + `test:webview` + `test:webview-agent-ui`，任何一步红即回退并记录。
- 验收：流式期间 `replace_agent_sessions` 调用次数 ≤ 去抖窗口数；最终状态必落盘；主回归绿。

### A2 F43 磁盘满/文件占用注入
- 入口：`export_io.rs` + 现有故障 hook 模式（webview-fit-faults 的注入方式可复用）。用受限虚拟盘或可注入写入器，**禁止填满系统盘**。
- 覆盖：无权限、文件占用、写盘中断、部分文件残留、重试路径、按钮恢复。
- 验收：错误码映射断言 + 输入不丢 + webview-export 套件扩展用例。

### A3 F16 PDF 结构/阅读顺序自动化
- 入口：从 `render_document_export`（bundle）真实 PDF 用 pdfjs-dist（node 可跑）提取文本层/链接 annotation/页序；与 TextMap.logical_text 对比断言阅读顺序；检查结构树存在（tagged PDF）。
- 产出：新测试 `tests/unit/export-pdf-structure.test.mjs` + R16 证据；不通过不伪装（typst tagged 限制逐条记录）。

### A4 千版本按需详情 IPC
- 背景：物化上限 1000 之外提交的快照为空串；`load_commit_detail`（Rust）已有，无 IPC 命令。
- 步骤：lib.rs 新命令 `version_commit_detail`（主窗口校验）→ generate_handler + capabilities 登记 → `docs/public-ipc-contract-v1.md` 补条目（verify:contracts 三处名单强对齐）→ 重生绑定（test:bindings --update 并解释数量）→ platform 增 `loadCommitDetail` → `useNativeResumeVersions` 对空快照提交改为按需取回（移除 storeFromGraph 的抛错守卫）。
- 验收：`test:native`、`test:webview`、R24 千版本阶段回归；>1000 图载入历史版本可用。

### A5 supplemental 验收行
- B0 对照建议补 S01 经历智能排序、S02 清空当前简历、S03 分栏宽度拖拽、S04 预览溢出告警（代码均在，缺验收行）。按 `tools/acceptance-matrix.mjs` 结构以 `supplemental:true` 追加，配最小场景证据。

## B 测量与构建/包体（需独占机器窗口，串行）

### B1 E2 构建档实验（一次只改一个因素）
- 候选 1：`[profile.dev]`/`[profile.test]` `debug="line-tables-only"`（保 unwind/debug-assertions/overflow-checks 语义）→ 四场景计时（clean/no-op/只改 UI/只改 Rust crate）+ target 字节 before/after。
- 候选 2（仅当候选 1 收益不足）：`strip="debuginfo"`、third-party `debug=0`。
- 验收：no-op 不重编全树；test/dev 语义不变（test:native 全绿）；记录 build timings。
- 注意：改 profile 会使对应缓存失效，选无其他任务的窗口执行；与 B4 同窗口做。

### B2 E3 精简核查（只证不动）
- 逐项证实后清单化：reqwest/TLS feature、typst 引文、SQLite backup/serialize、html2canvas（DOCX 缩略图确需保留）、`staticlib/cdylib` 消费者、NSIS 载荷（不带 PDB/源码）、dist/pdfjs 全量 cmap 随包。任何删除需引用证据 + 最小验证，输出报告待授权执行。

### B3 E1 字体统一来源 PoC（待授权）
- 报告已交：`.artifacts/remaining/audit-plan-20261003/run-exec-20261003/E1-FONT-PoC-REPORT.md`（自定义 URI 协议返回引擎内嵌字体，frontendDist 排除重复，预期 exe 再减约 13.2MB brotli 后）。
- 获准后按报告门禁执行：协议白名单/CSP/dev 分流 → 全套 WebView2 + visual + 安装态断网 → 实测包体 → 用户确认数字后才排字体文件。

### B4 C 阶段测量补全
- 30min 真实交互 soak（`tools/lightweight/measure-memory.mjs` 需扩展交互驱动，不得用 --runs 冒充）；构建四场景计时（与 B1 同窗口）；bench-drag-frames/commit-snapshots ×30；同口径 3 轮记录 p50/p95/max。

## C 矩阵证据簿记（A 完成后）

1. 按 F2 schema 为每行生成证据 JSON：`schemaVersion:1`、revision=`HEAD+worktree digest`、checks 带 U/B/N/V/M/D/R、命令与退出码、fixture 哈希。
2. 分层升级：本轮已实测的行为（D1/D2/IPC/存储/导入相关行）优先补 `checks`；`M/R/D` 条目继续 blocked，精确列外部材料。
3. 每升一行跑 `verify:contracts` + `audit-parity`；52 行 required 不得减；A5 的 S 行单独计 supplemental。
4. 产出：更新 `docs/feature-parity.json` 状态与 `.artifacts/remaining/` 新证据目录；`TASK` 记录同步。

## D 外部门禁（材料到位即启）

| 项 | 材料到位后的动作 |
| --- | --- |
| D1 真人验收 | 按 `fixtures/remaining/manual-scenarios.md` IME-01/UI-01/MOTION-01 在原生 WebView2 录 accepted/rejected + 环境 |
| D2 VM | Win10 22H2/Win11 干净机：在线/离线安装、断网首用模板/导入/OCR、升级中断、卸载留数据、中文路径、非管理员 |
| D3 签名 | 证书到位 → 签安装器 → SmartScreen/AV 观察 + 真实升级/回退链 |
| D4 真实模型 | connectionId 配置 → F33/F36/F38/R25 全链（能力探测/流式/取消/提议/脱敏/取消竞争），Key 不落日志 |
| D5 字体许可 | Georgia/iconfont 授权证据 → 重跑 engine-parity（engine-parity 当前 0/9 是本项阻塞，非代码缺陷）→ 视觉门禁 |
| D6 干净复现 | 第二执行者按 §9 runbook 从完整源码快照复现并比对哈希 |

## 建议执行顺序

1. **A1 → A2 → A3 → A5**（可并行审核类任务；每项独立最小验证）。
2. **A4**（含契约登记与绑定重生，单独一轮）。
3. **B1+B4 同窗口**（构建实验 + 测量补全一次独占完成），**B2** 随后出报告。
4. **C1** 矩阵簿记（依赖 A 全部落地）。
5. **D1–D6** 随外部材料到位逐项启动；D5 完成后重跑 engine-parity 预期转绿。
6. 全部完成后：`npm run verify:project -- --suite full` 复跑 + `npm run package:windows` + 安装态抽检，更新切片与 TASK 记录。
