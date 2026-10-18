# ZineCV（zinecv-desktop）

Tauri 2 + React + Rust/Typst + SQLite 的本地简历编辑器：编辑、A4 实时预览、内置三模板排版引擎（Typst 冻结编译）、版本树与分支、PDF/高清长图导出、PDF/DOCX/图片导入（含离线 OCR）、本机账户与本地模型连接的 Agent 助手。全程本地运行，无云端依赖。

项目现状、验证边界与待验收项以 **`docs/SLICE_20261002.md`** 为唯一入口。C+ 目标见 `docs/ARCHITECTURE_TARGET_CPLUS.md`，活动计划见 `docs/EXECUTION_PLAN_20261006-cplus.md`。

## 架构

```text
src/main-desktop.tsx → src/ui/app/App.tsx → src/platform/ipc.ts
                                        → src-tauri/src/lib.rs
                                          ├─ crates/{contracts,domain,engine,storage,agent}
                                          └─ render_worker / 原生能力（zinecv-native）
```

| 目录 | 职责 |
| --- | --- |
| src/ui/ | 正式 React 编辑/DOM 预览/模板/版本/Agent 与样式 |
| src/preview/ | 独立的引擎 SVG 预览、TextMap 选字/链接/RTL（受几何门禁约束） |
| src/platform/ | 类型化 IPC、权威文档客户端、持久化、版本、设置、旧数据导入、字体协议 |
| src-tauri/src/ | 56 个业务 IPC、窗口与能力装配、渲染 worker、字体共享协议 |
| crates/zinecv-{contracts,domain,engine,storage,agent}/ | 单源契约、命令/CAS、Typst/TextMap/导出、SQLite/迁移/备份、Agent 策略与上下文 |
| crates/zinecv-native/ | 平台能力；Windows Current-user DPAPI 注入 SecretProvider |
| src/main-web.tsx + src/platform/browser/ | Browser Worker、OPFS/Web Lock/WebCrypto、CORS、文件下载和 PWA 装配 |
| crates/zinecv-wasm/ | 共享 Rust Core 的 WASM facade、OPFS VFS 与秘密/网络能力接线 |
| crates/zinecv-ohos/ | OHOS 原生存储/排版与 NAPI 编译 POC，尚非完整宿主 |

106 个 `src-tauri/src/domain/bindings/` 类型由 ts-rs 生成，不手改。

## 构建与运行

1. `npm ci`（Node `>=24 <25`，Rust ≥1.88，Windows + MSVC Build Tools）。
2. `npm run dev`：完整桌面开发（包装器自动准备 MSVC 并启动 Tauri）。
3. `npm run build:native`：Vite + Rust release；`npm run package:windows`：在线 NSIS 安装器。

### Browser / OHOS 开发者构建

`npm run build:web` 构建同一 Rust Core 的 WASM 与共享 React，产物 `dist/web.html` 需 HTTPS/localhost 静态托管；需要 Rust WASM target、项目外 LLVM 和匹配的 wasm-bindgen。`check:wasm`、`test:web-core`、`test:web-product`、`test:platform-parity` 验证浏览器核心、产品行为与 Native/WASM 对照。`npm run build:ohos-core` 使用项目外 OpenHarmony native SDK（可设置 `ZINECV_OHOS_NATIVE`），目前为原生核心/NAPI POC，完整 HarmonyOS 宿主未完成。工具和环境详情见当前切片 §11。

## 验证

日常开发使用 `npm run check`（5项）：类型、契约、fixture、许可清单和单元测试，不启动浏览器或原生编译。需要较广行为覆盖时使用 `npm run check:regression`。

| 层级 | 命令 | 范围 |
| --- | --- | --- |
| 日常反馈 | `npm run check` | 5项轻量检查 |
| 常用回归 | `npm run check:regression` | 15阶段，浏览器、正式桌面编辑/富文本/排序/18版式导出组合、导入/OCR、分页/字体、Agent、持久化、提议资源和测量工具自身测试 |
| 一键补齐其余自动验收 | `powershell -File tools/run-remaining-checks.ps1` | 旧full中余下19阶段，加共享正式构建依赖校验、WASM/Browser与平台对照、Windows打包、standard120秒×3和extended30分钟×3 |

常用回归只需要正式宿主，构建收据匹配时复用；不隐式引入整组Rust检查/测试、hooks冷编译、引擎示例构建。剩余清单由旧full34减去常用回归自动生成：15+19覆盖全部原阶段，没有删除用例或放宽阈值。正常PDF/PNG已在常用版式、预览与字体测试中覆盖，保存故障/取消等深检仍在剩余入口。

手动补齐入口先做5项轻量安全预检，再运行延后阶段和发布资格；不会重跑常用UI/浏览器套件，所需共享构建仍验证收据。它明确报告remaining-only，不导入前次常用结果，不把不同源码的两轮拼成full通过。源码改变后应重新运行相关回归。

只看计划而不执行：

```powershell
powershell -File tools/run-checks.ps1 -Scope Regression -Plan
powershell -File tools/run-remaining-checks.ps1 -Plan
```

现有UI/Native/Agent/Recovery定向入口仍兼容；更小范围可用 `node tools/verify-project.mjs --only <阶段> --fail-fast`，自动补齐依赖。完整手动入口统一为 `tools/run-remaining-checks.ps1 -Complete`（可加 `-Plan` 预览），旧 `run-acceptance.ps1` 已合并移除。旧 `-Scope Full` 34阶段和 `npm run accept:full` 完整16阶段仍保留供显式整轮资格验证，日常收尾不自动追加。

原生/WebView2/测量仍串行；完整资格运行期间冻结源码。长测预算、生产超时、视觉阈值和所有原用例不变，延后验收仍可能因冷编译和90分钟长测耗时很久。真人IME、设备触控、辅助技术、视觉体验、安装环境及许可等人工/外部资格另行记录，手动脚本不代替人类验收。

保留有效target/dist/node_modules，避免反复冷编译；只清理确认过期的临时文件。结果保存在 `.artifacts/verification-runs` 和 `.artifacts/acceptance-runs`，不覆盖失败/中止记录。

最新核验（2026-10-18）：用户手动执行的 remaining-only 批次 **16/16 顶层阶段通过**，内含延后19项及共享构建依赖共20阶段、WASM/Browser与平台对照、Windows打包、standard120秒×3、extended30分钟×3。批次从北京时间07:22:32运行至10:07:51，源码前后摘要一致，打包后原exe哈希正确还原。详情见 [本轮报告](docs/QUALIFICATION_20261018.md)。

此前常用回归15/15是另一份冻结源码记录；两轮结果分别保留，不合并宣称一次full通过。56行矩阵仍为7 passed / 45 pending / 2 in_progress / 2 blocked。人工、VM、签名、真实模型、许可及第二执行者仍待验收；后续平台实现见plan.md。日常无需重复延后链与长测。

## 文档

| 文件 | 用途 |
| --- | --- |
| docs/SLICE_20261002.md | 唯一当前切片：架构、构建陷阱、验证状态、缺口 |
| docs/feature-parity.json | 52+4 验收矩阵，verify:contracts 消费 |
| docs/public-ipc-contract-v1.md | 宿主 IPC 与导出/提议/备份契约 |
| docs/DEVELOPMENT_PLAN.md、FEATURE_PARITY.md、FEASIBILITY.md、target.archify.json | 四份原始依据，保护不改 |
| docs/licenses/ + resource-license-inventory-20260930.json | 第三方许可与盘点；license 文本是构建输入 |


最新状态入口：[当前切片](docs/SLICE_20261002.md)、[剩余计划](plan.md)、[延后验收报告](docs/QUALIFICATION_20261018.md)、[清理记录](docs/CLEANUP_20261018.md)。历史Git收口和PNG修复报告保留原结论。
