# ADR-UI：桌面界面沿用 React 并接 Rust 权威核心

状态：**React 适配路线已选；B03/B06 验收仍在进行**。本决策按 `DEVELOPMENT_PLAN.md` 的 B03 失败回退条款执行，不把当前 React 静态 WebView 实验当成桌面成品。

## 决策及触发条件

用户的首要约束是保留现有前端视觉、功能和右侧 A4 预览几何。B03 原定以相同 token、图标、fixture 证明 Svelte 样片交互和视觉不退化，并测得至少一项维护或资源指标改善。当前 Svelte 样片只有三个虚构条目、简化富文本和“预览占位”，未接旧版全部模块、右侧 A4、完整编辑器或 Rust 存储。其 53 kB JS 不能与功能范围不同的 React 整包比较，也不能证明维护收益；B03 完成条件没有达到。继续以该样片扩展正式界面会先引入大面积视觉重建风险。

同一旧版 React 静态构建已在隔离的 Tauri/WebView2 release 进程显示完整左编辑、右预览和助手，页面错误为零；实测 1440×820、DPR 2 的预览 pane 为 `(706,65,734,755)`，与同一静态构建的 Headless Edge pane 相同。纸张显示宽度有 10px 差异，探针指向两种宿主 15px/0px 的滚动条宽度；这仍需按固定视口、输入和滚动位置做视觉回归，不能称为已等价。

因此新桌面正式 UI 以现有 React 组件、样式和交互为迁移输入，建立桌面专属适配层；Svelte 样片保留为实验和对照，不进入正式编辑器。受保护的旧版预览正文、分页、导出源码及字体不因本决策而修改。

## 不可省略的接入条件

- Rust `ResumeDocument`、命令、SQLite receipt 是桌面数据的单一权威；React 只保留输入法合成、光标、拖拽和富文本 undo 等瞬时 UI buffer。不得让旧 `useResumePersistence` 的浏览器缓存成功提示冒充磁盘 durable ack。
- 同一文档的命令串行发送，使用生成的 TS 绑定；失败保留输入 buffer，重试复用原 commandId/参数，导出、版本提交、切换与关闭前等待 flush。迟到响应不能覆盖较新的 cursor 或其他账户/上下文。
- 旧版原 origin 的 localStorage、项目 `.data` 和账户/秘密由 B10 只读迁移；WebView2 空白 profile 不自动拥有旧草稿。未完成迁移前不得将空白初始文档显示成“用户数据已恢复”。
- 旧浏览器预览仍是 B00 对照；正式桌面排版/导出需按 B02/B07 证明 A4、选字、分页及视觉等价。React 外壳可显示并不证明引擎完成。
- React 旧 HTTP 服务、导出和 Agent 调用需逐项替换为桌面本机接口；不能把完整静态前端直接视作离线可用的最终产品。

## 已有证据与待验收

证据见 `b03-interaction-evidence.md`、`baseline-manifest.json`、隔离的本机 `.artifacts/react-poc-webview.{png,json}`。Svelte 浏览器测试 2/2 通过，只覆盖样片行为；React WebView2 实验只覆盖静态呈现。中文真人 IME、完整指针取消、同 fixture 视觉对照、内存与维护指标、React 全字段的真实 Rust 保存、离线安装包和所有 F 项仍需验收。若 React 适配无法满足这些条件，必须重新记录阻断和方案，不能以本 ADR 代替测试。

第一段共享接线已落地：`src/bridge/NativeDocumentClient.ts` 按权威 cursor 串行发送生成类型的命令，缺少 durable ack 时保留原 envelope 并阻止后续命令，重试复用原 commandId。当前桌面开发状态页已改用它；隔离 release WebView2 的标题保存、刷新读回、SQLite 文件检查通过。它尚未接入旧 React 编辑器。`docs/zinecv-v2/target.archify.json` 的 UI 节点已按本 ADR 改为 React 工作区，Archify showcase 校验 9 项通过、0 错误/0 警告；图仍表达目标设计，不表示各节点已经实现。
