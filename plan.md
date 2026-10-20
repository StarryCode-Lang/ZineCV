# ZineCV 剩余计划

当前状态以 [SLICE](docs/SLICE_20261002.md) 为准，历史与独立验收集中 [HISTORY](docs/HISTORY_202610.md#qualification)。不追加已完成流水账，不改架构决策、产品契约或矩阵状态。本次经用户授权优化构建并准备开发缓存；不提交/推送/发布。

- [ ] 按完整acceptance逐条审核56行；当前7 passed /45 pending /2 in_progress /2 blocked。相关套件与独立回归通过不替整行签收。
- [ ] 真人输入法、触控/设备、辅助技术、视觉/减少动态效果及原生文件操作（权限、占用、空间不足、取消/恢复）。步骤见`fixtures/remaining/manual-scenarios.md`，使用隔离合成数据并记录环境/操作者/产物哈希。
- [ ] 干净VM在线/离线安装、升级中断/卸载留数据，Authenticode与更新签名/回退；真实模型及跨账户/机器DPAPI；iconfont/项目再分发许可与Georgia方案、公开合成样例/独立PDF体验、第二执行者干净复现。以上外部资格移出本轮，但未证状态保留。
- [ ] 其他Browser兼容性与macOS/Linux/Android/iOS/HarmonyOS后续实现/验收；OHOS core/NAPI POC不等于完整宿主，当前SDK缺失。
- [ ] 可选：OCR夹具解耦、固定负载内存趋势复核。长测行为通过不是无泄漏证明。

保留本次准备的 npm 依赖、dist 和原生 debug 缓存，后续直接 `npm run dev`；仅依赖变更或缓存缺失时再安装/重建。默认check五项，按实际修改选择最小专项；无需为收尾重跑延后链或长测。完整资格仅显式运行`tools/run-remaining-checks.ps1 -Complete`；默认remaining-only不能导入旧常用通过。图数据库通常清除节省体积，图调用前经保留的`.gitnexus/run.cjs`重建。历史数据归档已按用户要求删除，保留报告、摘要与删除清单；不把旧统计当作新的原始采样证明。
