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

Windows 本轮统一验收入口：`node tools/accept-project.mjs`。先做类型、契约、fixture、许可清单及单元预检，再复用匹配的构建收据执行完整 34 阶段、WASM/Browser、12 组 Native 对照及安装包构建；这些门禁通过后才执行独立的三轮 120 秒测量和三轮 30 分钟长测。原有全部用例、视觉阈值与测量资格保留，增加五字体真实导出及希伯来回退核对。轻量检查最多两项并行；原生/WebView2/测量保持串行。结果集中保存到新的 `.artifacts/acceptance-runs/<时间>/batch.json` 及阶段日志；失败即停，未执行阶段明确记录，不覆盖旧记录。可用 `ZINECV_CLOSURE_BATCH_OUT_DIR` 指定新的项目内结果目录。运行期间不得修改源码；功能条款复核、内存趋势解释、包内资源检查与最终清理仍须据实完成，入口成功本身不代表这些条款已验收。

修复循环使用 `node tools/verify-project.mjs --retry-failed <旧 run.json> --plan` 查看最小重跑范围，去掉 `--plan` 执行。它补齐失败/未执行项的构建依赖并重新验证收据，保留旧记录哈希；**专项重跑不导入旧通过结果，不属于 full**。修复收敛后仍执行一次冻结源码的完整验收。直接运行 full 默认收集全部失败；`--fail-fast` 可在当前轻量并行组结束后停止后续工作，并将剩余项标为 `not_run_after_failure`。每轮 `run.json` 包含耗时最高的六个阶段，用于识别实际瓶颈。改变生产超时、删用例、放宽视觉阈值或用短测替代长测均不属于这套优化。

```text
快速检查   npm run check:ts / verify:contracts / verify:fixtures / verify:licenses
原生链     npm run check:native / test:native / test:bindings
套件       node tools/verify-project.mjs --suite fast|regression|full（34 阶段，--plan 查看）
```

历史 2026-10-07 状态：Windows full 的 34 个阶段分批验证通过（保留前次失败与修复记录，非一次全过）；原生 306 测试、106 个绑定零漂移、visual-parity 两视口 0px、engine-parity 9/9（最大锚点偏差 1px，人工视觉复核仍待完成）。C+ Windows P1–P5 已收口；该历史 full 不覆盖随后新增的源码。矩阵 52 required + 4 supplemental 保持 `9 passed / 45 pending / 2 blocked`。真人、VM、签名、真实模型、素材授权与第二执行者事项仍待验收；详情见切片 §10 及 `.artifacts/remaining/cplus-20261007/REPORT.md`。

## 文档

| 文件 | 用途 |
| --- | --- |
| docs/SLICE_20261002.md | 唯一当前切片：架构、构建陷阱、验证状态、缺口 |
| docs/feature-parity.json | 52+4 验收矩阵，verify:contracts 消费 |
| docs/public-ipc-contract-v1.md | 宿主 IPC 与导出/提议/备份契约 |
| docs/DEVELOPMENT_PLAN.md、FEATURE_PARITY.md、FEASIBILITY.md、target.archify.json | 四份原始依据，保护不改 |
| docs/licenses/ + resource-license-inventory-20260930.json | 第三方许可与盘点；license 文本是构建输入 |

2026-10-08 最新进展：Browser 共享 Rust Store/Typst/Agent 与 React 接线、WebCrypto/OPFS/单写者/恢复前备份/离线启动已通过本机 Chromium 行为检查；Native/WASM 九组结构与栅格对照通过（差异 0），两端 PDF 各自可复现；Backup JSON 双向互通通过。原生七 crate 309 项测试、OHOS Windows 核心探针 1 项通过；OHOS ARM64 原生 .so 交叉编译成功。最新完整 Windows 回归与清理收据见 `.artifacts/remaining/windows-capable-20261007/REPORT.md`。完整 HarmonyOS 宿主、Android 工具链/协议、Apple 平台和移动真机仍有独立条件，未假记完成。
续跑时可设置 ZINECV_ACCEPT_REUSE_STANDARD_BATCH 指向前次结果目录；仅当三轮完整通过、程序哈希和全部产品/测量输入匹配且清理验证通过时复用短测。旧批次的失败仍保留，新的 full 必须独立完成。
