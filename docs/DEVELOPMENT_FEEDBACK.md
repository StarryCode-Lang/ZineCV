# 快速开发与验收

日常小改不默认更新独立发布 exe。正式 release 使用 fat LTO，前端被嵌入 exe，UI 更新也会触发耗时原生链接；不能承诺冷构建、正式发布、完整资格及原预算长测五分钟完成。

## 编译缓存与磁盘占用

桌面与共享核心统一根 `Cargo.toml` / `Cargo.lock`，默认只构建桌面宿主。WASM/OHOS 排除在该 workspace 外，保留独立锁文件及发布配置，按需执行。当前桌面库只输出 rlib，避免额外 staticlib/cdylib 链接与归档；未来 Android/iOS 宿主需显式配置对应 ABI 输出。输出共用 `src-tauri/target`，开发/测试保持行号调试信息与增量编译。字体静态字节由零依赖 `zinecv-assets` 提供，engine 再出口原名称；storage 的正常依赖不再包含排版引擎，已有 PDF 渲染集成测试仍会带入 engine。

- `npm run dev`：完整 Tauri 开发环境，前端热更新；Rust/依赖/原生配置变更仍需增量编译。
- `npm run build:dev`：仅准备同一 debug 宿主；运行 UI 时仍需要 `npm run dev` 启动的 Vite 服务。不是独立发布 exe。
- `powershell -NoProfile -File tools/with-msvc.ps1 check -Package zinecv-agent`：模块定向检查；`test` / `fmt` 同样支持 `-Package`。不指定 Package 时覆盖整个桌面 workspace。test 显式执行 lib/bins 单元测试，不隐式链接引擎示例；示例由 test:engine-poc、build:engine-poc、build:engine-render 等已有专项入口覆盖。
- `npm run build:native`：正式 release，沿用 fat LTO；仅交付独立 exe 时执行。

保留 node_modules、dist、debug deps/build/incremental 和对应工具链才能复用；不要在每次开发前运行 cargo clean 或删除增量缓存。不设置并行任务专用 target，不为日常 UI 小改生成 release/hooks/WASM/OHOS。Cargo 下载缓存与 target 是不同缓存，移动目录不减少总占用。当前 jobs=2，先保留以控制16GB机器的内存峰值。Windows NTFS 上已对 debug/deps 应用系统透明压缩（普通NTFS压缩，非归档），路径与使用方式不变；新增依赖产物继承压缩，频繁写入的 incremental 目录未压缩。它是本机文件系统状态，不随Git传播。压缩后已复核开发构建与真实窗口启动均未触发Rust编译。

日常开发缓存与最小源码包是不同目标：本工作区优先避免重复冷编译，不删除有效 debug 中间产物换取表面体积。空间不足时先测量实际目录，停止对应进程后仅清理过期构建模式和不再需要的隔离测试输出；保留发布副本、源码、锁文件、用户数据和受控证据。release/hooks 清理会使宿主收据失效。workspace 根 Cargo.toml/Cargo.lock 已纳入构建收据和 CSS 工作台输入检查。

后续环境/工具链或功能变更会触发正常增量构建；定向检查不替代当前执行范围内的完整功能验收。

## 开发入口

| 改动 | 开发与检查 |
| --- | --- |
| CSS 外观 | `npm run dev:css` 打开隔离数据的真实原生窗口，保存 CSS 后自动重建样式并应用；退出用 Ctrl+C。`npm run check:css` 做类型检查、最新 CSS 加载、真实原生 IPC、导出菜单检查后退出。 |
| React、功能代码、原生代码 | `npm run dev`，由 Tauri 启动 Vite，前端热更新。首次原生开发构建可能超过五分钟；不要每次改 UI 都转去 release。日常 `npm run check`；按改动选择已有定向测试。 |
| 正式交付独立 exe | 明确执行 `npm run build:native`；更新 target/release 中的 exe，需要原生链接。CSS 快速窗口不会更新这个文件。 |
| 广覆盖、剩余或完整资格 | 原有 `check:regression`、`check:remaining`、`accept:full` 保留原用例、阈值和测量预算；只在明确需要时运行。 |

CSS 通道验证已成功构建收据及 exe 哈希，比较 Rust、契约、权限、配置、非 CSS 源码、公共资源、锁文件；不匹配则拒绝复用。每次刷新也重新校验这些输入。生产 dist、exe、原生配置与发布收据均不修改，开发数据及输出位于忽略目录 `.artifacts/ui-workbench/`。CSS 通道是开发/定向检查证据，不能冒充新 release 或完整验收。

2026-10-18历史实测：CSS 重建、真实宿主、原生数据和导出菜单检查约3.6秒，含类型检查命令约9秒。原记录`.artifacts/ui-workbench/check.json`已在2026-10-20清理，数字仅作历史观察。当前已准备 Windows debug 开发宿主；直接 `npm run dev` 支持 CSS/React 热更新。2026-10-22正式release/hooks及两项引擎构建收据曾生成并核对匹配；2026-10-24优化接力后源码与 release 产物身份已变化，旧收据不能当作当前匹配。CSS工作台启动时仍须核对当时的release收据，不能用debug或历史成功冒充。原生测试宿主初始化会先载入旧内嵌 UI，再覆盖最新 CSS；因此非 CSS 改动必须使用 dev 模式。代码或数据依赖发生变化时按实际范围重新验证；不重复已经通过且未受影响的检查。


夹具、绑定、许可和字体参考的持久字节锁已解除；相关检查仍验证结构、类型、来源差异和视觉结果，运行期间的构建/宿主输入一致性检查继续保留。无依赖时可单独做绑定结构检查，不能标成严格TS/Rust重生成通过。

## 自动回归耗时与输出

2026-10-25 按影响范围执行，保留全部场景的入口：日常用 `npm run check`，普通浏览器行为变化用 `npm run check:fast`。某一专项变化时用 `powershell -NoProfile -File tools/run-checks.ps1 -Only test:webview-agent-ui -Plan` 先核计划，去掉 `-Plan` 才执行；多个阶段可用 PowerShell 数组传给 `-Only`，构建依赖由唯一阶段表补齐并去重。失败后用 `-RetryFailed <run.json>` 只重试失败/未完成阶段及必要依赖，不重复已通过阶段；它与 `-Only` 互斥。定向或失败重试始终是局部验证，不冒充完整资格。Full/remaining、安装链和长测保留按需执行，不作为每次修改的默认流程。有效构建收据仅复用同输入产物，不缓存测试通过来掩盖新变化。

日常先用 `npm run check`；需要普通浏览器行为覆盖用 `npm run check:fast`，包含原有6个阶段。2026-10-20本机暖缓存对照：优化前41.233秒；优化后三次17.863、18.214、18.438秒，中位数18.214秒，减少55.83%。每阶段均实际执行，未复用历史通过。当前88项单元、24项浏览器测试全部通过，另定向通过318项Rust单元测试。原23项浏览器用例全部保留，新增隔离与调度保护；完整资格矩阵不升级。

轻量阶段使用两个工作槽及时补位；普通Chromium测试默认最多4个文件并行，共享浏览器进程但每个用例使用独立BrowserContext，存储和Cookie隔离，单个租约关闭不影响其他用例。受限机器可设置 `ZINECV_BROWSER_CONCURRENCY=1` 定位问题。原生/WebView2/bench/soak仍串行。直接执行package脚本减少npm重复启动，存在生命周期钩子或npm环境变量依赖时回退npm。

每阶段保留一个完整合并日志（stdout和stderr均保留），6阶段日志由12份变6份；报告新增logPath/logFormat，旧stdoutPath/stderrPath均指向该完整日志。测试源码约0.70MiB，文件拆分本身不是大体积来源，不为减少数量删除场景。阶段清单、断言、视觉阈值、失败传播与正式验收入口不变。完整链standard和extended合计96分钟固定观察预算保持，不能将上述56%推广为完整资格或原生测试链减半。

实测摘要：`.artifacts/analysis/test-optimization/result.json`。保留对照、最终和原生测试记录，中间试跑在保存摘要后清理。

开发启动直接运行项目内Vite入口，避免npm exec重复启动和用户allow-scripts配置冲突。ts-rs使用官方no-serde-warnings处理不支持的Serde属性提示；Rust的deny_unknown_fields仍生效，已通过109项契约测试，106份生成绑定保持不变。当前MSVC中文“正在创建库”仍会被Rust 1.97.1列为一条linker_messages警告，属于正常进度，未关闭真实编译/链接诊断。记录见`.artifacts/analysis/dev-warnings.json`。
