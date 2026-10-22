# Windows 无人值守验收交接

2026-10-21用户决定：Agent完成判断/修改与定向验证；长耗时自动步骤由用户在PowerShell运行，返回日志后再逐条复核。当前矩阵不自动签收。

## 当前结果

2026-10-22整链已完成并经Agent逐条复核；无需再次运行。矩阵状态以机器矩阵为准，当前门禁范围仅见FEATURE_PARITY范围备忘。证据见[本轮复核](evidence/windows-closeout-20261022/review.json)。该入口保留供未来显式资格运行，原预算和检查不减少。

## 执行

关闭ZineCV和npm run dev，在普通PowerShell运行（窗口标题不能有“管理员”）：

```powershell
cd D:\Desktop\ZineCV
powershell -NoProfile -ExecutionPolicy Bypass -File tools\run-windows-closeout.ps1
```

可先加 -Plan 只看计划。需要保留当前node_modules、工具链和.artifacts/kept-release中的旧安装器；预检会检查。运行时保持电脑唤醒、不改项目代码、不另开开发/测试宿主。安装器阶段可能显示系统窗口；使用隔离合成数据，不要求管理员权限。

顺序：输入快照→full34→离线与助手补充→在线NSIS→离线NSIS→本机中文路径安装/更新/卸载/兼容回退→standard120秒×3→extended30分钟×3→输入/程序哈希复核。仅测量观察至少96分钟，构建和回归另计。不构建WASM/OHOS/mobile。

每次创建独立.artifacts/windows-closeout/<时间戳-PID>。失败立即停止并保存已有输出；不继续跑长测来掩盖失败，不自动修改验收矩阵。安装测试拒绝覆盖已注册的真实ZineCV安装；保存并恢复原程序位置注册表。打包保留并恢复原EXE/PDB，并核允许的PE元数据差异和构建收据。

## 回传

成功或失败都会尽量生成send-back.zip，控制台最后显示SEND_BACK绝对路径；也可查看.artifacts/windows-closeout/latest-result.txt。将压缩包发回。ZIP只收本批日志、报告和测量JSON，不收真实用户库、浏览器profile、安装器或EXE/PDB备份。ZIP生成失败则回传同批send-back目录。

出现passed-awaiting-review仅表示自动执行通过，仍待Agent审核逐条覆盖、视觉及内存趋势；不等于所有56行签收、无泄漏证明或独立人类验收。脚本失败无需自己改代码；回传日志。若强行终止留下.active.lock，应先确认没有本批进程，再交由Agent核实，不盲删锁后并发运行。

## 已完成与保留边界

本轮针对窗口/DPI写入与剪贴板真实占用的修复已定向通过；许可、声明、可移植视觉参考和OCR夹具已整理。一页/两页合成样例在output/pdf，来自当前hooks宿主无故障注入，已渲染检查三页、核A4和可搜索姓名；是供复核的测试样例，不是最终release签收。

维护状态：AST与Archify检查通过；GitNexus全文搜索缺失索引经完整重建恢复并通过实际搜索，图不是测试通过证明。2026-10-21的索引失败、临时清理受阻与旧矩阵数字仅是[历史诊断](evidence/remaining-windows-20261021/analysis-handoff-state.json)，不能覆盖当前现状。活动任务仅见[plan](../plan.md)。

历史失败：2026-10-21T14-40-43.673Z-26992批次在CDP启动阶段中止，后续定向3/3通过不是full；原记录保持失败。2026-10-22确认提升权限PowerShell导致WebView2环境覆盖被忽略，随后普通权限下完成当前整链，见本页“当前结果”，无需再补跑旧待办。PowerShell与Node入口现于构建前拒绝高权限运行并记录Token预检，未改系统策略或开放全局调试。相关根因与实际被测输入见受控诊断及本轮复核，不把不同日期环境故障混成同一原因。
