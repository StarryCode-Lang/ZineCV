# TASK 20261004 — 全面审核、功能补齐与终验（audit-parity-performance）

> 执行计划：`docs/EXECUTION_PLAN_20261003-audit-parity-performance.md`。本文是该任务的过程交代与验收摘要；原始证据在 `.artifacts/remaining/audit-plan-20261003/run-exec-20261003/`。HEAD 基线 `07a874b`（master）+ 未提交工作树；未提交、未推送、未发布。

## 1. 阶段 A：全仓审核（完成）

- **A0 基线**：397 工作树文件 + 536 证据文件 SHA-256 清单；release exe/NSIS 基线副本（binaries/）；GitNexus 索引重建（7,763 节点，绑定 `07a874b`）；四项快速门禁 0 问题。
- **A1 需求审计**：15 份文档全读；52 行矩阵 188 个证据引用 0 缺失但 **0 行符合 passed schema**（50 pending / 2 blocked 不变）；B/R/P→F/D 全量映射 + 五层标注；backlog 24 条（P1×8）。
- **A2/A3 逐行审核**：231 文件（226 full）359 发现（P1×1、P2×22、P3×89、P4×247）+ 九条生产链路问答；B0 参考项目对照 56 项能力 0 uncovered、建议 S01–S04。
- 证据：`review-coverage.json`、`findings-index.json`、`requirements-audit.json`、`backlog.md`、`reviews/review-*.json`。

## 2. 修复实施（D1/D2/IPC/存储/导入/许可 + 工具链）

| 项 | 内容 | 验证 |
| --- | --- | --- |
| D1 | worker 字体按身份缓存 + 宿主编码载荷缓存（消除 ≈66MB SHA + 88MB 编码/渲染） | typst-worker 协议测试 + 四套件 |
| D2 | ExportProduct {bundle,pdf,png} + selected_pages；PDF 不受 PNG 预算连坐 | engine 测试 + webview-export |
| IPC | 34 处窗口校验 + write_export_file 收紧 | 主回归（含未授权窗口语义保持） |
| 存储 | delete_branch 泄漏修复；版本图结构全量 + 物化上限 1000；索引 migration 17 | test:native 292/292 |
| 导入 | 页码 provenance 贯穿；取消语义（AbortSignal/waitWithAbort） | import-provenance 单测 ×4 |
| 工具链 | verify:project full=31 stage；bench 状态化退出码；许可清单 15 包 | --plan / bench passed / --check |

首波由 workflow 多 Agent 并行实施（经历 bigmodel 网络故障、Ark 过期、最终回 Start Plan 单并发）；门禁与集成由主会话串行收口（修 3 处编译 + 3 处 clippy + fmt）。

## 3. 过程中的回归与处置（不隐瞒）

1. **主回归 provider 阶段失败**：定位为既有页面反复重载（基线 exe 复现 ~12 次导航）× 挂载回填竞态。处置：断言改按值轮询稳定等待；**回退前端热点 agent 的 AgentOverlay 接线**（去抖 API 保留未接线，重做要求见 EXECUTION_PLAN §A1）。
2. **D4 截断破坏 R24**：默认 500 截断丢提交 → 重设计"结构全量 + 物化上限 1000 + head 必含"，前端空快照守卫。
3. **check:ts 管道吞退出码**：GraphPayload 类型未同步 → 已修复并复验（教训：验证命令退出码不得经管道取值）。

## 4. 终验（冻结源码，两次运行）

- 第一次 29/31（check:ts 类型漏检 + engine-parity）；修复后第二次 **30/31**（`.artifacts/verification-runs/2026-10-03T21-44-25-218Z-4308/`）。唯一失败 engine-parity = 几何门禁 0/9（字体许可阻塞，既有外部 blocker）。
- bench ×30：模板切换 p95=79ms（阈 500）、PDF 导出 p95=1198ms（阈 2000）。
- 产物：release exe 87,564,800 B + NSIS 安装器；基线对比副本在 run 目录 binaries/。

## 5. 清理

删除：`src-tauri/target/{debug,hooks}`（16.9GB + 3.2GB，重建代价 test:native ≈7min / build:native-hooks ≈6min）、`.artifacts/webview-e2e`（396MB 测试遗留 profile）、`.artifacts/runtime-tmp`（5.4MB）、根目录 `NUL` 垃圾文件。保留：release 交付代、`.artifacts/remaining/` 全部证据、engine-parity-runs 失败证据、verification-runs 三次 run 记录、`.gitnexus` 新鲜索引、dist/、node_modules。

## 6. 移交

剩余工作与分阶段计划：`docs/EXECUTION_PLAN_20261004-remaining.md`。当前切片：`docs/SLICE_20261002.md` §16。
