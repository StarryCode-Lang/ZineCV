# B03 Svelte 等价交互样片证据

状态：`in_progress`。样片入口为 `/dist/index.html?sample=interaction`，源码 `src/InteractionSample.svelte`；默认 `/` 仍显示 B01 桌面开发状态页。样片只覆盖可迁移交互的风险验证，不是正式编辑器或右侧 A4 预览。

已覆盖的行为：

- 富文本：粗体、插入链接对话框、contenteditable 输入同步。测试选中尾部两个字符后触发工具命令，结果为局部 `<b>` 标记。
- 模块：折叠/展开、键盘上下移、指针拖拽与放置顺序。
- 分栏：slider 语义、键盘 ArrowRight 增宽 16px、指针拖拽入口。
- Agent：浮标/提议/会话三种形态的按钮与 `aria-pressed` 状态。

`npm run build`：退出码 0，Svelte 检查 0 error / 0 warning。当前样片 bundle 为 `dist/assets/index-*.js` 53.02 kB（20.98 kB gzip）。该数字只表示本样片产物，不能与旧 React 应用整包或相同功能集直接比较。

初版 `npm run test:browser`：退出码 0；B03 样片使用 Playwright 独立上下文、1280×800、reduced motion，并检查无 page error。当时真实指针拖拽通过，但富文本工具、模块键盘重排与折叠按钮通过 DOM `click()` 验证，未覆盖实际指针按下的焦点路径；后续增量见下。

2026-09-27 增量：把富文本工具、链接、模块上下移与折叠的测试改为真实 Playwright 指针点击后，首次暴露模块容器抢占所有指针导致粗体命令失效。拖拽事件现只绑定手柄，真实指针点击通过；分栏拖动改为以按下时宽度为基准，键盘调整后继续拖动不再跳回 560px。普通输入后等待折叠动画完整卸载再展开，曾复现文本回到初始值；输入事件现在从实际编辑节点同步状态，重建后内容保留。新增手柄快速松手不重排、分栏 `pointercancel` 恢复宽度检查。`npm run build` 0 error/0 warning，`npm run test:browser` 2 tests 退出码 0。取消测试只覆盖分栏合成 `pointercancel`，未覆盖真实系统指针取消、中文真人 IME 或旧版视觉等价；ADR-UI 仍未定案。

同日 React 原界面原生容器实验：在**忽略的本机实验配置**中让 Tauri 2 暂时嵌入当前 React `dist`，使用独立 AppData、WebView2 profile 和 `ZINECV_DATA_DIR` 启动 release exe。真实 WebView2 能显示完整旧版外壳、左编辑/右预览纸张与悬浮助手，`pageerror` 为空；`1440×820`、DPR 2 下预览 pane 的 CSS rect 为 `(706,65,734,755)`。同一静态构建在 Headless Edge 154 中 pane rect 相同；纸张显示宽度分别为 WebView2 672px 与 Headless Edge 682px。探针测得两者滚动条宽度为 15px 与 0，符合现有预览自适应公式对实体滚动条的扣减。截图及数据在忽略的 `.artifacts/react-poc-webview.{png,json}` 和 `.artifacts/react-poc-browser.{png,json}`；该实验不修改受保护预览源码。React 页面仍显示“浏览器草稿”而非 Rust durable ack，版本/API 服务尚未移植，因此**不能**把实验构建当桌面成品或完成视觉等价。实验后重建默认 Svelte release exe，`npm run test:webview` 1 test 通过。ADR-UI 需要等价功能与持久化接线、实际输入/焦点/内存对照后再定案。

2026-09-28 决策：`adr-ui.md` 按 B03 失败回退条款选择 React 适配。Svelte 样片仍为三个虚构条目、简化富文本和预览占位，不能满足同 fixture 视觉等价与完整输入条件；其较小 bundle 不能当成等价资源收益。该决策不等于 B03 完成：React 全界面持久化、视觉与真人 IME 等待验收。
