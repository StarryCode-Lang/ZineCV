# 开发与检查

## 日常入口

| 目的 | 命令 |
| --- | --- |
| 完整桌面开发 | `npm run dev`；Tauri 自动启动 Vite，React/CSS 热更新 |
| CSS 定向窗口/检查 | `npm run dev:css` / `npm run check:css` |
| 日常轻量检查 | `npm run check`：类型、契约、夹具、许可、单元 |
| 普通浏览器行为 | `npm run check:fast` |
| 按专项选择 | `powershell -File tools/run-checks.ps1 -Only test:webview-agent-ui -Plan`；去掉 `-Plan` 执行 |
| 失败重试 | `powershell -File tools/run-checks.ps1 -RetryFailed <run.json>`，与 `-Only` 互斥 |
| Rust 模块检查 | `powershell -File tools/with-msvc.ps1 check -Package zinecv-agent`；同样支持 test/fmt |

多个专项可向 `-Only` 传 PowerShell 数组。调度器自动补齐/去重依赖；重试或定向运行始终为局部结果。阶段清单只在 `tools/verify-project.mjs` 维护；Windows完整功能链使用 `tools/run-remaining-checks.ps1 -Complete`，先加 `-Plan` 查看；跨平台加 `-Platforms`，内存观察加 `-Measurements`。二者仍能运行原有全部专项与预算，但默认不执行，也不计通过。旧全部范围使用 `-Complete -Platforms -Measurements`。

## 缓存与隔离

- 保留 node_modules、dist 和 `src-tauri/target` 的有效 deps/build/incremental。桌面与共享核心使用根 Cargo.toml/Cargo.lock；WASM/OHOS 独立根按需构建。
- debug 保留行号信息与增量编译；当前 debug/deps 使用本机 NTFS 透明压缩，incremental 不压缩。清空缓存会造成冷构建，不能当作常规清理。
- CSS 工作台只覆盖样式，先校验 release 收据和 EXE；非CSS输入变化拒绝复用。它不更新发布 EXE，React/原生修改使用 dev。
- 单元入口由 `tests/unit/*.test.mjs` glob 自动发现（文件数不固定，随任务增减）；计划逻辑直接复用调度器，并保留真实CLI检查。
- 单元测试默认按文件独立进程并行执行（`node --test --test-concurrency=6 tests/unit/*.test.mjs`，自动发现全部 `*.test.mjs`）；文件内用例仍串行，跨文件隔离从模块作用域提升为进程边界，断言集与旧单进程入口完全一致。需要旧模型时用 `npm run test:unit-serial`（单进程串行注册/执行）。
- 普通浏览器套件共享进程、独立 BrowserContext，默认4文件并行；可设 `ZINECV_BROWSER_CONCURRENCY=1`。真实OCR按隔离页面分组，取消/恢复顺序和双页PDF单worker断言不变。原生/WebView2/测量串行，使用独立 profile、SQLite、端口与输出。
- 普通权限 PowerShell 启动；WebView2 高权限宿主可能忽略环境覆盖。原生操作经 with-msvc，ts-rs 共用绝对 TS_RS_EXPORT_DIR。MSVC 中文链接进度可能显示 linker_messages 警告，不隐藏真实错误。

## 构建与发布

仅交付独立 EXE 时运行 `npm run build:native`；release 使用 fat LTO，冷构建或链接不承诺五分钟。构建时保持输入稳定，只有输入、工具链和产物身份匹配的收据才能复用。

`powershell -File tools/release-windows.ps1` 构建、打包并签名；获准发布后使用 `-Publish -SkipBuild -NotesPath <说明文件>`。发布前必须干净 Git 工作区，并通过保存产物/收据/签名校验。生产密钥在 `%USERPROFILE%/.zinecv/signing`，公钥与 HTTPS 更新源在 tauri.conf.json；测试密钥及 test-hooks 产物不得发布。

打包只允许现有 PE 元数据白名单差异，原 EXE/PDB 在 finally 中恢复并核哈希。发布副本保留在 `.artifacts/releases/<version>`，当前状态和受控证据见 [SLICE](SLICE_20261002.md)。
