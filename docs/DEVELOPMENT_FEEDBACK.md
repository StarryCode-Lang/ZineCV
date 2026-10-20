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

后续环境/工具链或功能变更会触发正常增量构建；本次通过的检查不替代真人、VM、签名、多平台及完整资格验收。

## 开发入口

| 改动 | 开发与检查 |
| --- | --- |
| CSS 外观 | `npm run dev:css` 打开隔离数据的真实原生窗口，保存 CSS 后自动重建样式并应用；退出用 Ctrl+C。`npm run check:css` 做类型检查、最新 CSS 加载、真实原生 IPC、导出菜单检查后退出。 |
| React、功能代码、原生代码 | `npm run dev`，由 Tauri 启动 Vite，前端热更新。首次原生开发构建可能超过五分钟；不要每次改 UI 都转去 release。日常 `npm run check`；按改动选择已有定向测试。 |
| 正式交付独立 exe | 明确执行 `npm run build:native`；更新 target/release 中的 exe，需要原生链接。CSS 快速窗口不会更新这个文件。 |
| 广覆盖、剩余或完整资格 | 原有 `check:regression`、`check:remaining`、`accept:full` 保留原用例、阈值和测量预算；只在明确需要时运行。 |

CSS 通道验证已成功构建收据及 exe 哈希，比较 Rust、契约、权限、配置、非 CSS 源码、公共资源、锁文件；不匹配则拒绝复用。每次刷新也重新校验这些输入。生产 dist、exe、原生配置与发布收据均不修改，开发数据及输出位于忽略目录 `.artifacts/ui-workbench/`。CSS 通道是开发/定向检查证据，不能冒充新 release 或完整验收。

2026-10-18历史实测：CSS 重建、真实宿主、原生数据和导出菜单检查约3.6秒，含类型检查命令约9秒。原记录`.artifacts/ui-workbench/check.json`已在2026-10-20清理，数字仅作历史观察。当前已准备 Windows debug 开发宿主；直接 `npm run dev` 支持 CSS/React 热更新。独立 CSS 工作台依赖 release 收据，本次未生成该发布收据，不能用 debug 冒充。原生测试宿主初始化会先载入旧内嵌 UI，再覆盖最新 CSS；因此非 CSS 改动必须使用 dev 模式。代码或数据依赖发生变化时按实际范围重新验证；不重复已经通过且未受影响的检查。


夹具、绑定、许可和字体参考的持久字节锁已解除；相关检查仍验证结构、类型、来源差异和视觉结果，运行期间的构建/宿主输入一致性检查继续保留。无依赖时可单独做绑定结构检查，不能标成严格TS/Rust重生成通过。
