# 2026-10-18 延后自动验收报告

用户手动批次 `.artifacts/acceptance-runs/2026-10-17T23-22-32.766Z/` 最终 `passed`，16个顶层阶段全部exit0。北京时间2026-10-18 07:22:32—10:07:51，约2小时45分钟。

## 真实范围

- coverageMode=`remaining-only`。延后19项加共享正式构建依赖共20阶段全部通过，4个构建阶段经收据复用；不是一次full34/完整资格。
- WASM检查、平台参考、Web构建、Web核心、Web产品、Native/WASM结构与栅格对照通过。
- Windows NSIS打包通过；bundle-restore确认原exe与恢复后SHA-256均为`b337f8f1593cff76ea11c533f53912da8177343fe4b75c5880db20845bcddbf8`。
- standard三轮实际120.072/121.143/121.094秒；extended三轮实际1801.131/1800.011/1802.522秒，各轮passed。长测行为通过不等于固定负载内存趋势已闭合或证明无泄漏。
- 四份执行前/后源码快照摘要相同：`e8205721d512d294ed6ec93d919dfc5aef1c7d6129dd582865398fd29fd9a8aa`，冻结HEAD `3eb37acb6cee5bdc2cd0c513d2949692620b162b`。

## 证据与边界

受控目录 `docs/evidence/remaining-qualification-20261018/` 保存批次/运行记录、源码清单、阶段日志、两份测量driver、六份原始采样文件的路径/字节数/SHA-256，以及56行关联记录（53项检查，32行有关联通过）。约130MB测量原始数据仍完整保存在原批次内，未复制进Git，也未删除。

此前常用15阶段基于另一份冻结输入，本轮明确排除且不导入其通过。两份记录可分别审查，不能直接相加标成一次full通过。原PNG失败批次仍保持失败。

矩阵所有状态保持：7 passed / 45 pending / 2 in_progress / 2 blocked。原7个passed行保留历史修订和受控证明，最新关联记录另列。逐条acceptance、人工与外部资格尚未完成；后续文档/目录整理不追改原始验收结果。产品源码、API、IPC及编译输入未因本轮文档更新改变。

## 剩余

见 `../plan.md`。真人步骤参考 `../fixtures/remaining/manual-scenarios.md`：输入法、设备/辅助技术/视觉、原生文件操作、干净VM安装、签名/更新/回退、真实模型与DPAPI、许可/公开样例、第二执行者。其他Browser及非Windows平台仍有独立开发与验收工作。
