# ZineCV 剩余计划

更新：2026-10-18。整体当前状态以 `docs/SLICE_20261002.md` 文末为准；架构决策保持。产品 API、IPC、数据格式、测试预算与矩阵状态不因文档收口改变。

## 已完成

- [x] 本地Git收口：5026920、78d7794、f1435c8；PNG边界输入修复3eb37ac。保留master与历史，无远程推送。
- [x] 源码换行与哈希资源属性、六份GitNexus技能例外、必要受控证据归档完成。
- [x] 常用回归15/15和正式release构建通过（2026-10-17，独立冻结输入）；富文本、排序/边缘滚动、18版式、导入/OCR、数据与Agent已有对应套件记录。
- [x] 56行证据入口清点；288条失效路径和123条历史说明保留在历史审计中；本轮增加53项关联检查证据，未自动升级任何行。
- [x] 用户延后批次16/16顶层阶段通过：延后19项及依赖共20阶段、WASM/Browser与平台对照、Windows打包、standard120秒×3和extended30分钟×3。
- [x] 源码前后摘要一致；打包原exe还原哈希一致。此前失败批次保留为失败。
- [x] 活动文档更新，临时缓存清理与历史日志归档；有效target/dist/node_modules、工具与验收数据保留。三工具同步记录见`.artifacts/remaining/docs-cleanup-20261018/`。

## 剩余任务

- [ ] 对56行完整acceptance逐条审核：相关套件通过不等于整行签收；矩阵仍为7 passed / 45 pending / 2 in_progress / 2 blocked。
- [ ] 真人验收：输入法、设备/触控、辅助技术、视觉与原生文件操作。
- [ ] 干净VM的在线/离线安装、签名/更新/回退、真实模型及跨账户/机器DPAPI、资源再分发许可/公开样例、第二执行者复现。
- [ ] 其他Browser兼容性与macOS/Linux/Android/iOS/HarmonyOS后续实现及验收；OHOS核心POC不是完整宿主。
- [ ] 可选：OCR夹具解耦、固定负载内存趋势复核。长测行为门禁通过不等于内存优化或无泄漏证明。

## 继续工作

本轮自动验收已完成，无需为了收尾重跑。后续修改默认`npm run check`，按影响选择专项；显式整轮完整资格才使用`powershell -NoProfile -ExecutionPolicy Bypass -File tools/run-remaining-checks.ps1 -Complete`。默认不加Complete为remaining-only，不能导入旧常用通过冒称新full。

证据范围与人工交接见 `docs/QUALIFICATION_20261018.md`；清理明细见 `docs/CLEANUP_20261018.md`。四份冻结依据、许可正文与fixture保持原始字节；原始报告按历史日期保留。
