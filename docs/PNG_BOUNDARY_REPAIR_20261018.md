# PNG 导出边界用例修复

> 2026-10-18 状态同步：修复后的新延后批次已16/16通过，见 `QUALIFICATION_20261018.md`。本文的原失败批次与修复时“尚未运行”属于历史记录；保留失败证据，不用新结果改写旧批次。

2026-10-18。手动批次 `.artifacts/acceptance-runs/2026-10-17T15-07-59.825Z/` 的预检与正式构建通过，remaining-regression 在 `test:webview-export` 失败。失败点为 `webview-export-dpi.test.mjs` 的 4～7 页断言，其他 3 个导出用例通过。

当前排版将 210 段合成短文本排成 3 页。300 DPI 每页约 8.7M 像素，三页未越过 32M 长图预算，不能验证长图降级。输入改为 350 段后实际生成 5 页，处于 32M 长图预算与 64M 分页图片预算之间。

仅修改测试输入与注释；4～7 页断言、32M/64M 预算、DPI 边界、逐像素拼接、白色背景、分页图片保留、600 段超预算拒绝及输入状态不变断言全部保留。产品实现、API、IPC 与数据格式未改。

## 实际验证

- 失败用例专项 1/1 通过：72/192/300 DPI 精确拼接，350 段生成 5 页并触发长图降级，600 段触发分页像素预算拒绝。
- 日常五项通过，单元 74/74。原始记录 `.artifacts/verification-runs/2026-10-17T23-04-45-344Z-22948/`。
- 正式 exe SHA-256：`b337f8f1593cff76ea11c533f53912da8177343fe4b75c5880db20845bcddbf8`。测试修改不属于编译输入，不要求冷编译。
- 失败/成功报告、专项日志及测试文件哈希：`docs/evidence/png-boundary-repair-20261018/`。
- GitNexus File impact 为 UNKNOWN，已通过 package.json 的实际 `test:webview-export` 入口确认引用；未把空调用集作为无影响证明。三工具同步记录保存在忽略目录 `.artifacts/remaining/png-boundary-repair-20261018/`。

原批次保持失败。本次专项与旧通过不能拼成一轮 remaining/full 通过。迁移、发布、故障恢复、视觉/引擎对照以及后续平台/打包/长测仍待执行；本次没有启动完整链或长测。

## 历史复跑入口（新批次现已通过）

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File "D:\Desktop\ZineCV\tools\run-remaining-checks.ps1"
```

命令创建新批次；正式宿主、hooks 与引擎示例构建按现有收据校验复用。原批次和失败证据保留。
