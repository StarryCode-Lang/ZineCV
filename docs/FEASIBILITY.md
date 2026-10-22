# 架构可行性与取舍

本文件保留2026-09-25至26研究的关键推论和来源，不是当前通过报告。2026-10-06已定案[C+架构](ARCHITECTURE_TARGET_CPLUS.md)：共享React、Rust Core、原生/Browser WASM平台适配；早期Svelte候选不再是执行要求。现状与资格边界以[SLICE](SLICE_20261002.md)为准。

## 可行性结论与限制

Tauri + React + Rust/SQLite + Typst可建立明确的本地文件、事务与统一排版边界。减少代码、内存、延迟或包体仍须同功能实测，不能从框架名称或别人的benchmark推定。用户无需安装开发工具不等于裸exe自包含；安装器必须处理WebView2、字体、模型与离线资源。

| 领域 | 采用理由 | 仍须验证 |
| --- | --- | --- |
| Rust Core与类型绑定 | 领域写入、事务和跨端schema单源 | UI输入buffer不等待每次IPC；生成类型不替代运行时校验 |
| Typst与受控worker | 同一文档生成预览、PDF和PNG | 冷字体/分页/IPC/绘制的端到端延迟；过期丢弃不等于硬取消 |
| TextMap/HitRegion | 补齐跨页定位、选字和语义 | page/x/y不足以表达bbox；字形SVG不自动成为可选文本；PDF可搜索不证明预览选字或PDF/UA |
| SQLite与完整快照 | 版本事务、备份和恢复边界清楚 | 单writer、durable ack、WAL一致备份、幂等与资源GC；相同内容不合并不同提交身份 |
| 现有导入适配器 | 保留复杂PDF/DOCX/OCR能力 | DOM预览隔离，HTML消毒，扫描PDF先栅格化；换主导出不能直接删html2canvas |
| React共享UI | 延续现有布局、编辑器与交互 | IME、拖拽、焦点、选区、动效和辅助技术必须实测，换框架不保证复杂度下降 |
| 平台能力注入 | 共用语义、各端接系统存储/网络/秘密 | WASM/OPFS、OHOS与移动端性能和能力分别验证；桌面数字不能直接搬用 |

保留三模板、全部富文本、版本图/历史载入/删除重接、上下文草稿、本机账户和Agent功能。字体角色、字重、fallback、断行与单位映射需同输入比对，不能为减文件未经验证地换字体、子集化中文或删OCR。模板、模型、字体、图标与引擎的授权分别核对。

## 安全与分发边界

受控World只提供显式模板/字体/资源，文档内容只作数据，不允许任意路径、网络或用户账户文件；模板沙箱不替代CPU/内存限额。worker协议有generation和资源身份，超时/异常可终止重建。资源摘要描述一次渲染身份，不冻结仓库字节。

宿主能力按窗口收口，CSP与业务权限均需实际配置，不能假设注册command天然默认拒绝。前端不能读回已保存Key，也不能任意执行SQL/shell/文件操作。Windows Current-user DPAPI可保护秘密密文，不能声称整库加密、跨机可恢复或抵御同OS用户恶意进程；配置与密文保留，不能解密时提示重输。

在线/离线NSIS、无开发工具首次启动、中文路径、非管理员、磁盘不足、升级中断和卸载留数据分别验收。更新签名和Authenticode不同，不能代替DB回退或保证SmartScreen无提示。WebView2与OS支持范围在正式交付时重新核对，不沿用旧研究日期作长期保证。

普通浏览器/mock、真实WebView2、安装包、人工IME/辅助技术与真实模型各自证明不同范围。模型只用虚构数据；凭据和用户简历不进入fixture/公开日志。结论只覆盖实际执行的环境与场景。

## 替代方案的适用条件

保留React是当前决策；Svelte只保留为历史比较对象。Electron仅在实证显示Host集成阻断时重评；纯DOM截图或客户端PDF库不能独立解决桌面事务与统一排版。Rust替换JS导入链前须同语料证明质量、离线、性能与恢复至少等价；无测量不以语言纯度重写。

Browser同步存储桥、引擎WASM和OHOS原生核心的POC淘汰条件见C+决策附件。研究与POC不是所有端正式交付，替代或过渡形态需明确标识；不能覆盖历史失败或把延期项从矩阵删除以获100%。

## 研究来源索引

以下保留原R01–R46链接与释义，访问日期为2026-09-25至26，本次未联网复核。动态latest/main链接是历史研究入口，不是依赖锁或已完成验收。官方能力资料支持机制，不证明ZineCV性能或全部功能。

| ID | 来源 | Tier | 当时支持的事实与限制 |
| --- | --- | --- | --- |
| R01 | [Tauri Windows Installer](https://v2.tauri.app/distribute/windows-installer/) | 1 | NSIS/MSI、WebView2 安装选项；安装包不等于便携单 exe |
| R02 | [Microsoft WebView2 distribution](https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/distribution) | 1 | Evergreen/Fixed、离线分发和宿主责任 |
| R03 | [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/) | 1 | Windows 开发工具链与系统依赖 |
| R04 | [Tauri capabilities](https://v2.tauri.app/security/capabilities/) | 1 | 自定义命令默认范围、AppManifest 与 capability |
| R05 | [Tauri CSP](https://v2.tauri.app/security/csp/) | 1 | CSP 需配置；远程脚本与本地资源限制 |
| R06 | [Tauri Stronghold](https://v2.tauri.app/plugin/stronghold/) | 1 | vault/password/hash API；应用仍负责秘密生命周期 |
| R07 | [Tauri updater](https://v2.tauri.app/plugin/updater/) | 1 | 强制更新签名、密钥与更新策略，不是 DB 回滚协议 |
| R08 | [Tauri Windows signing](https://v2.tauri.app/distribute/sign/windows/) | 1 | Authenticode、SmartScreen 声誉限制 |
| R09 | [Tauri WebDriver](https://v2.tauri.app/develop/tests/webdriver/) | 1 | embedded/native/browser 测试范围不同 |
| R10 | [Playwright WebView2](https://playwright.dev/docs/webview2) | 1 | CDP 附加真实 WebView2、隔离 profile |
| R11 | [Calling Rust / channels](https://v2.tauri.app/develop/calling-rust/) | 1 | command IPC、Channel 流式数据 |
| R12 | [Typst Rust crate](https://docs.rs/typst/latest/typst/) | 1 | Rust 编译入口、分页文档与导出链路 |
| R13 | [Typst World](https://docs.rs/typst/latest/typst/trait.World.html) | 1 | 宿主资源缓存与失效责任 |
| R14 | [Typst compile](https://docs.rs/typst/latest/typst/fn.compile.html) | 1 | 当前公开同步入口无 cancel token 参数 |
| R15 | [Typst location](https://typst.app/docs/reference/introspection/location/) | 1 | 页号/x/y 定位，不直接提供完整 bbox |
| R16 | [Typst SVG text implementation](https://github.com/typst/typst/blob/main/crates/typst-svg/src/text.rs) | 1 | glyph/use/path/image；选字限制是源码推论 |
| R17 | [Typst PDF reference](https://typst.app/docs/reference/pdf/) | 1 | tagged PDF、PDF/UA 支持及检查限制 |
| R18 | [Typst accessibility](https://typst.app/docs/guides/accessibility/) | 1 | 作者语义、替代文本、外部验证仍必要 |
| R19 | [Typst text](https://typst.app/docs/reference/text/text/) | 1 | 字体、fallback、语言与 CJK 属性 |
| R20 | [Typst paragraph](https://typst.app/docs/reference/model/par/) | 1 | 段落优化与换行算法，非 CSS 行盒 |
| R21 | [Typst paths](https://typst.app/docs/reference/foundations/path/) | 1 | 根路径边界；嵌入宿主须实现资源限制 |
| R22 | [Typst packages](https://github.com/typst/packages/blob/main/README.md) | 1 | 包版本、缓存与按需下载规则 |
| R23 | [Svelte reactive modules](https://svelte.dev/docs/svelte/svelte-js-files) | 1 | runes 模块及导出限制 |
| R24 | [Svelte scoped styles](https://svelte.dev/docs/svelte/scoped-styles) | 1 | scoped hash 与 specificity 增加 |
| R25 | [Svelte transition](https://svelte.dev/docs/svelte/transition) | 1 | WAAPI、退出保留 DOM、reduced-motion 注意点 |
| R26 | [Svelte motion](https://svelte.dev/docs/svelte/svelte-motion) | 1 | motion primitives 与 prefersReducedMotion |
| R27 | [Svelte animate](https://svelte.dev/docs/svelte/animate) | 1 | keyed each 重排机制，不等于完整拖拽 |
| R28 | [Tiptap Svelte](https://tiptap.dev/docs/editor/getting-started/install/svelte) | 1 | Svelte 集成存在，完整行为仍需本项目验收 |
| R29 | [Svelte testing](https://svelte.dev/docs/svelte/testing) | 1 | Vitest、组件/响应式与 Playwright 测试 |
| R30 | [Vitest browser mode](https://vitest.dev/guide/browser/) | 1 | 真实浏览器 provider 与模拟测试区别 |
| R31 | [tauri-specta](https://github.com/specta-rs/tauri-specta) | 2 | Rust 到 TS command/event 类型绑定候选 |
| R32 | [rusqlite](https://github.com/rusqlite/rusqlite) | 1 | bundled SQLite 与 backup feature |
| R33 | [SQLite WAL](https://sqlite.org/wal.html) | 1 | 单 writer、checkpoint、WAL 属于持久状态；foundational |
| R34 | [SQLite PRAGMA](https://www.sqlite.org/pragma.html) | 1 | foreign_keys、synchronous、integrity_check 等；foundational |
| R35 | [SQLite backup](https://sqlite.org/backup.html) | 1 | 在线一致性备份 API；foundational |
| R36 | [RFC 8785 JCS](https://www.rfc-editor.org/rfc/rfc8785.html) | 1 | JSON canonicalization，不自动规范化 Unicode；foundational |
| R37 | [MDN same-origin policy](https://developer.mozilla.org/en-US/docs/Web/Security/Defenses/Same-origin_policy) | 1 | 存储 origin 隔离，新桌面 profile 不等于旧浏览器 |
| R38 | [PDF.js getting started](https://mozilla.github.io/pdf.js/getting_started/) | 1 | worker 与解析渲染资源 |
| R39 | [Mammoth](https://github.com/mwilliamson/mammoth.js) | 1 | 语义 DOCX 转换、非忠实版式、无自动消毒 |
| R40 | [Tesseract.js FAQ](https://github.com/naptha/tesseract.js/blob/master/docs/faq.md) | 1 | OCR 使用与不直接支持 PDF |
| R41 | [docx-rs](https://github.com/bokuweb/docx-rs) | 1 | Rust 读写能力，OOXML 覆盖不穷尽 |
| R42 | [pdfium-render](https://github.com/ajrcarey/pdfium-render) | 2 | PDFium wrapper、本地库/线程边界 |
| R43 | [MuPDF license](https://mupdf.readthedocs.io/en/1.27.1/license.html) | 1 | AGPL/商业授权，需按所选依赖审核 |
| R44 | [Typst package licensing](https://github.com/typst/packages/blob/main/docs/licensing.md) | 1 | 模板、包与引擎许可不能混同 |
| R45 | [Microsoft Edge supported OS](https://learn.microsoft.com/en-us/deployedge/microsoft-edge-supported-operating-systems) | 1 | Windows/WebView2 当前支持信息，发布时重核 |
| R46 | [Microsoft CryptProtectData](https://learn.microsoft.com/en-us/windows/win32/api/dpapi/nf-dpapi-cryptprotectdata) | 1 | Current-user保护、机器/漫游边界与machine范围限制 |
