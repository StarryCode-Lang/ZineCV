# ZineCV

Tauri 2 + React + Rust/Typst + SQLite 本地简历编辑器，提供 A4 预览、三套模板、版本与分支、PDF/PNG 导出、PDF/DOCX/离线 OCR 导入、Agent 助手和签名自动更新。简历保存在本地，助手请求用户配置的模型服务。

## 开发与检查

Windows 使用 Node 24、Rust/MSVC Build Tools。缺少依赖时运行 `npm ci`，已有有效依赖与缓存直接保留。

- `npm run dev`：完整桌面开发，自动启动 Vite；React/CSS 热更新，Rust 修改增量编译。
- `npm run check`：日常五项轻量检查；浏览器行为按需补 `npm run check:fast`。
- `powershell -File tools/run-checks.ps1 -Only test:webview-agent-ui -Plan`：预览专项及依赖；去掉 `-Plan` 执行。失败重试用 `-RetryFailed <run.json>`。
- 独立 EXE、安装包和完整验证仅按需运行，见[开发指南](docs/DEVELOPMENT_FEEDBACK.md)。

## 文档入口

| 文档 | 职责 |
| --- | --- |
| [当前状态](docs/SLICE_20261002.md)、[plan](plan.md) | 已交付版本与活动任务 |
| [架构与不变量](docs/ARCHITECTURE_TARGET_CPLUS.md) | 模块边界、数据安全和历史研究来源 |
| [IPC 契约](docs/public-ipc-contract-v1.md) | 类型、权限、版本/导出/提议/更新/备份协议 |
| [功能规则](docs/FEATURE_PARITY.md) | 功能矩阵和证据格式 |
| [历史](docs/HISTORY_202610.md)、docs/evidence/ | 对应输入的历史结果，不作当前待办 |
| [来源与权属](docs/PROJECT_OWNERSHIP.md)、docs/licenses/ | 项目来源与第三方许可 |

正式 UI 在 `src/ui`，平台边界在 `src/platform`，宿主在 `src-tauri`，共享核心在 `crates`。WASM/OHOS 按需开发，不默认构建。保留有效 node_modules、dist 和 Cargo 缓存，不通过清空开发环境减重。
