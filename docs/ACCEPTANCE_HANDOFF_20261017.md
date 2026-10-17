# 当前回归与剩余验收交接

2026-10-17，正式源码基线 `78d779430910c8cf35309df47be5d9c586ecf875`。本轮没有修改产品实现、API、IPC 或数据格式。

## 已完成的本机自动验证

`npm run check:regression` 实际执行 **15/15 阶段通过**，不是 full34 或完整资格验收。时间为北京时间 22:30:22—22:53:56。

| 范围 | 实际结果 |
| --- | --- |
| 类型、契约、fixture、许可清单 | 4 项通过 |
| 单元测试 | 74/74 |
| 测量工具自身测试 | 5/5；不是实际长测 |
| 浏览器行为测试 | 23/23；本机 Chromium，不等于所有 Browser 兼容性 |
| 正式 release 构建 | 成功重建并生成收据 |
| 正式宿主主套件 | 3/3：基础字段/十模块、富文本/历史/排序/18版式组合等 |
| 预览与交互 | 6/6：布局、键盘/权限、导入/OCR、覆盖、多页等 |
| 字体 | 2/2 |
| 补充交互 | 1/1 |
| Agent | 2/2；隔离模拟模型，不是真实供应商资格 |
| 持久化 | 1/1 |
| 提议资源 | 1/1 |

可执行文件：`src-tauri/target/release/zinecv-desktop.exe`，74,535,424 字节，SHA-256：`b337f8f1593cff76ea11c533f53912da8177343fe4b75c5880db20845bcddbf8`。

可移植记录、阶段 stdout/stderr、构建收据和源码清单位于 `docs/evidence/current-regression-20261017/`。原始运行记录保留于 `.artifacts/verification-runs/2026-10-17T14-30-22-635Z-17200/`。源码摘要为 `2808b5a4f69523812973488a8ebd3fc63b37b394517eb8a126873e849b7ad64a`。

绑定依据是运行开始记录的干净 HEAD、结束归档前仍干净的工作区，以及 474 份源码/配置/测试输入的逐文件哈希。观察快照是在浏览器/轻量阶段期间、正式构建之前采集；没有把它伪装成执行前快照。正式编译输入与编译器身份另由成功构建收据绑定。后续只有证据、矩阵和文档整理。

## 56 行证据整理

288 条失效历史路径与 123 条历史说明完整保存在 `reference-audit.json`，不再作为矩阵的活动证明入口。每行均有新的当前范围记录：49 行包含相关通过套件，7 行属于本轮未执行的外部资格。套件关联只证明明确记录的行为，不自动证明整行 acceptance。

矩阵保持 **7 passed / 45 pending / 2 in_progress / 2 blocked**。原 7 个 passed 行保留历史修订和受控证据；其当前回归记录另在审计索引中列出，不用历史 passed 冒充当前整行通过。旧 remainingIssues 原文保留待逐条复核，不因相关套件通过而抹去未证需求。

## 你运行的一个命令

在 PowerShell 中执行：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File "D:\Desktop\ZineCV\tools\run-remaining-checks.ps1"
```

此入口运行 5 项安全预检、旧 full 中延后的 19 项及所需共享构建依赖、WASM/Browser 核心与产品/平台对照、Windows 打包，以及 standard 120秒×3、extended 30分钟×3。仅测量预算为 96 分钟，hooks/示例编译另计；保留有效缓存并继续校验收据。结果写入 `.artifacts/acceptance-runs/`。

入口已用 `-Plan` 实际核对，范围为 remaining-only，不导入本轮结果来冒称一次完整 full 通过。运行期间不要修改源码。若明确需要单轮完整资格，才使用同一入口的 `-Complete`，它会再次运行常用回归。

## 仍需真人或外部条件

按 `fixtures/remaining/manual-scenarios.md` 的步骤操作，使用新隔离 profile 和合成输入；记录当前 exe/安装包哈希、环境、操作人及结果。该历史步骤文档是操作参考，不是当前通过记录。

- [ ] 真实中文输入法、触控/设备、辅助技术、视觉与减少动态效果（IME-01、UI-01、VIS-01、MOTION-01）。
- [ ] 原生对话框与受控权限/占用/空间不足、取消及恢复（NATIVE-01、FILE-01）。
- [ ] 无开发环境的干净 VM 在线/离线安装、升级中断、卸载留数据、签名/更新/回退（INSTALL-01）；本机 NSIS 打包成功不能代替。
- [ ] 已授权真实模型端到端，以及跨账户/机器 DPAPI 保护边界；只记录供应商/模型/能力和结果，不记录 Key（REAL-MODEL-01）。
- [ ] 资源再分发授权、公开合成样例、独立 PDF 阅读体验与第二执行者复现（LICENSE-01、RELEASE-01）。

Browser 其他浏览器兼容性及 macOS/Linux/Android/iOS/HarmonyOS 的后续实现仍是独立开发与验收任务，不能由上述 Windows 命令完成。OCR 夹具解耦、固定负载内存趋势复核继续作为可选事项。

## 逐行当前范围索引

“相关通过”仅为部分套件证据；“待阶段”保留尚未运行的相关专项。详细断言范围、失效历史引用和外部条件均在对应 JSON 中。

| ID | 状态保留 | 相关通过 | 待阶段 | 当前记录 |
| --- | --- | --- | --- | --- |
| F01 | pending | test:webview, test:webview-persistence | test:native, test:webview-publication | [范围](evidence/current-regression-20261017/F01.json) |
| F02 | pending | test:webview | test:native | [范围](evidence/current-regression-20261017/F02.json) |
| F03 | pending | test:browser | test:native | [范围](evidence/current-regression-20261017/F03.json) |
| F04 | pending | test:webview | test:native | [范围](evidence/current-regression-20261017/F04.json) |
| F05 | pending | test:browser, test:unit, test:webview | 详见剩余条款 | [范围](evidence/current-regression-20261017/F05.json) |
| F06 | pending | test:browser, test:unit | 详见剩余条款 | [范围](evidence/current-regression-20261017/F06.json) |
| F07 | pending | test:browser, test:unit | 详见剩余条款 | [范围](evidence/current-regression-20261017/F07.json) |
| F08 | pending | test:browser, test:unit, test:webview | 详见剩余条款 | [范围](evidence/current-regression-20261017/F08.json) |
| F09 | pending | test:browser, test:unit | 详见剩余条款 | [范围](evidence/current-regression-20261017/F09.json) |
| F10 | pending | test:webview-preview, test:browser, test:webview | test:native | [范围](evidence/current-regression-20261017/F10.json) |
| F11 | pending | test:webview, test:webview-fonts | test:native | [范围](evidence/current-regression-20261017/F11.json) |
| F12 | pending | test:webview-preview | test:native | [范围](evidence/current-regression-20261017/F12.json) |
| F13 | pending | test:unit | test:native, test:webview-fit, test:webview-fit-faults | [范围](evidence/current-regression-20261017/F13.json) |
| F14 | pending | test:unit, test:webview, test:webview-preview, test:browser | 详见剩余条款 | [范围](evidence/current-regression-20261017/F14.json) |
| F15 | pending | test:webview-preview, test:browser | test:native | [范围](evidence/current-regression-20261017/F15.json) |
| F16 | pending | test:webview | test:native | [范围](evidence/current-regression-20261017/F16.json) |
| F17 | pending | test:browser | test:native | [范围](evidence/current-regression-20261017/F17.json) |
| F18 | pending | test:browser, test:webview | 详见剩余条款 | [范围](evidence/current-regression-20261017/F18.json) |
| F19 | pending | test:webview | test:native | [范围](evidence/current-regression-20261017/F19.json) |
| F20 | pending | test:webview | test:native | [范围](evidence/current-regression-20261017/F20.json) |
| F21 | pending | test:browser | 详见剩余条款 | [范围](evidence/current-regression-20261017/F21.json) |
| F22 | pending | test:browser | 详见剩余条款 | [范围](evidence/current-regression-20261017/F22.json) |
| F23 | pending | test:browser | 详见剩余条款 | [范围](evidence/current-regression-20261017/F23.json) |
| F24 | in_progress | test:webview, test:webview-persistence, test:unit | test:native, test:webview-publication | [范围](evidence/current-regression-20261017/F24.json) |
| F25 | in_progress | test:webview, test:unit | test:native | [范围](evidence/current-regression-20261017/F25.json) |
| F26 | pending | test:webview | test:native | [范围](evidence/current-regression-20261017/F26.json) |
| F27 | pending | test:webview | 详见剩余条款 | [范围](evidence/current-regression-20261017/F27.json) |
| F28 | pending | test:webview, test:webview-persistence | test:native, test:webview-publication | [范围](evidence/current-regression-20261017/F28.json) |
| F29 | pending | test:webview, test:webview-persistence | test:native, test:webview-publication | [范围](evidence/current-regression-20261017/F29.json) |
| F30 | pending | test:webview, test:browser | test:native, test:webview-migration | [范围](evidence/current-regression-20261017/F30.json) |
| F31 | pending | test:webview | test:native, test:webview-migration | [范围](evidence/current-regression-20261017/F31.json) |
| F32 | pending | test:webview | test:native, test:webview-migration | [范围](evidence/current-regression-20261017/F32.json) |
| F33 | pending | test:webview | test:native | [范围](evidence/current-regression-20261017/F33.json) |
| F34 | pending | test:webview, test:webview-agent-ui | 详见剩余条款 | [范围](evidence/current-regression-20261017/F34.json) |
| F35 | passed | test:webview, test:webview-agent-ui | test:native, test:webview-migration | [范围](evidence/current-regression-20261017/F35.json) |
| F36 | pending | test:webview-proposal-assets, test:webview-agent-ui | test:native | [范围](evidence/current-regression-20261017/F36.json) |
| F37 | pending | test:webview | test:native | [范围](evidence/current-regression-20261017/F37.json) |
| F38 | pending | test:webview, test:webview-proposal-assets | test:native | [范围](evidence/current-regression-20261017/F38.json) |
| F39 | pending | test:webview, test:webview-proposal-assets | test:native | [范围](evidence/current-regression-20261017/F39.json) |
| F40 | pending | test:webview, test:webview-proposal-assets | test:native, test:webview-migration, test:webview-migration-crash | [范围](evidence/current-regression-20261017/F40.json) |
| F41 | pending | test:browser | 详见剩余条款 | [范围](evidence/current-regression-20261017/F41.json) |
| F42 | pending | test:browser, test:webview | 详见剩余条款 | [范围](evidence/current-regression-20261017/F42.json) |
| F43 | passed | test:webview | test:native | [范围](evidence/current-regression-20261017/F43.json) |
| F44 | pending | 本轮未执行行为资格 | 详见剩余条款 | [范围](evidence/current-regression-20261017/F44.json) |
| D01 | pending | 本轮未执行行为资格 | 详见剩余条款 | [范围](evidence/current-regression-20261017/D01.json) |
| D02 | pending | 本轮未执行行为资格 | 详见剩余条款 | [范围](evidence/current-regression-20261017/D02.json) |
| D03 | pending | 本轮未执行行为资格 | 详见剩余条款 | [范围](evidence/current-regression-20261017/D03.json) |
| D04 | blocked | 本轮未执行行为资格 | 详见剩余条款 | [范围](evidence/current-regression-20261017/D04.json) |
| D05 | blocked | 本轮未执行行为资格 | 详见剩余条款 | [范围](evidence/current-regression-20261017/D05.json) |
| D06 | pending | test:webview | test:native, test:native-hooks, test:webview-hooks | [范围](evidence/current-regression-20261017/D06.json) |
| D07 | passed | test:webview | 详见剩余条款 | [范围](evidence/current-regression-20261017/D07.json) |
| D08 | pending | 本轮未执行行为资格 | 详见剩余条款 | [范围](evidence/current-regression-20261017/D08.json) |
| S-SMART-SORT | passed | test:webview-supplemental | 详见剩余条款 | [范围](evidence/current-regression-20261017/S-SMART-SORT.json) |
| S-CLEAR-RESUME | passed | test:webview-supplemental | 详见剩余条款 | [范围](evidence/current-regression-20261017/S-CLEAR-RESUME.json) |
| S-PANE-RESIZE | passed | test:webview-supplemental | 详见剩余条款 | [范围](evidence/current-regression-20261017/S-PANE-RESIZE.json) |
| S-OVERFLOW-WARNING | passed | test:webview-supplemental | 详见剩余条款 | [范围](evidence/current-regression-20261017/S-OVERFLOW-WARNING.json) |
