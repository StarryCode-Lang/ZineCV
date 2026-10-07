# ZineCV 桌面版（zinecv-desktop）

Tauri 2 + React + Rust/Typst + SQLite 的本地简历编辑器：编辑、A4 实时预览、内置三模板排版引擎（Typst 冻结编译）、版本树与分支、PDF/高清长图导出、PDF/DOCX/图片导入（含离线 OCR）、本机账户与本地模型连接的 Agent 助手。全程本地运行，无云端依赖。

项目现状、验证边界与待验收项以 **`docs/SLICE_20261002.md`（2026-10-06 切片）** 为唯一入口。

## 架构

```text
src/main-desktop.tsx → src/ui/app/App.tsx → src/platform/ipc.ts
                                        → src-tauri/src/lib.rs
                                          ├─ domain.rs / storage.rs / migration.rs
                                          └─ render_worker.rs / engine.rs / engine/
```

| 目录 | 职责 |
| --- | --- |
| src/ui/ | 正式 React 编辑/DOM 预览/模板/版本/Agent 与样式 |
| src/preview/ | 独立的引擎 SVG 预览、TextMap 选字/链接/RTL（受几何门禁约束） |
| src/platform/ | 类型化 IPC、权威文档客户端、持久化、版本、设置、旧数据导入、字体协议 |
| src-tauri/src/ | 56 个业务 IPC、SQLite（迁移 17）、账户/DPAPI、渲染 worker、字体共享协议 |
| src-tauri/src/engine/ | Typst 排版、TextMap、一页求解、冻结 PDF/PNG 导出 |

106 个 `src-tauri/src/domain/bindings/` 类型由 ts-rs 生成，不手改。

## 构建与运行

1. `npm ci`（Node `>=24 <25`，Rust ≥1.88，Windows + MSVC Build Tools）。
2. `npm run dev`：完整桌面开发（包装器自动准备 MSVC 并启动 Tauri）。
3. `npm run build:native`：Vite + Rust release；`npm run package:windows`：在线 NSIS 安装器。

## 验证

```text
快速检查   npm run check:ts / verify:contracts / verify:fixtures / verify:licenses
原生链     npm run check:native / test:native / test:bindings
套件       node tools/verify-project.mjs --suite fast|regression|full（34 阶段，--plan 查看）
```

2026-10-06 状态：full 套件 33/34（唯一失败 `test:webview-hooks` 为机器负载竞态，空闲复跑 4/4，见切片 §1）；原生 304 测试、绑定零漂移、visual-parity 0px、engine-parity 9/9（最大 1px）。矩阵 52 required + 4 supplemental 保持 `9 passed / 45 pending / 2 blocked`：套件通过不自动升级整行。真人验收、干净 VM、签名、真实模型凭据与素材再分发授权仍为外部待办（切片 §4/§7）。**公开仓库前注意：iconfont 字体再分发许可未闭合。**

## 文档

| 文件 | 用途 |
| --- | --- |
| docs/SLICE_20261002.md | 唯一当前切片：架构、构建陷阱、验证状态、缺口 |
| docs/feature-parity.json | 52+4 验收矩阵，verify:contracts 消费 |
| docs/public-ipc-contract-v1.md | 宿主 IPC 与导出/提议/备份契约 |
| docs/DEVELOPMENT_PLAN.md、FEATURE_PARITY.md、FEASIBILITY.md、target.archify.json | 四份原始依据，保护不改 |
| docs/licenses/ + resource-license-inventory-20260930.json | 第三方许可与盘点；license 文本是构建输入 |
