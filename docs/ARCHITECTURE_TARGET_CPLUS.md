# C+ 架构与设计不变量

2026-10-06定案：React 共享交互，Rust Core 共享产品语义；Tauri、ArkTS/ArkWeb、Browser 是能力宿主。安装端编译原生核心，Browser 编译 WASM。现状见[SLICE](SLICE_20261002.md)，操作见[开发指南](DEVELOPMENT_FEEDBACK.md)，历史见[HISTORY](HISTORY_202610.md)。

## 模块单一来源

| 入口 | 职责 |
| --- | --- |
| src/ui、src/platform | 编辑/DOM预览/模板/版本/助手；类型化平台边界与输入缓冲 |
| src/preview | SVG/TextMap、跨页选字、链接与RTL消费组件 |
| crates/zinecv-contracts | DTO、schema、命令、cursor、错误、Backup JSON；ts-rs绑定来源 |
| crates/zinecv-domain | 文档校验、默认数据、领域命令与CAS |
| crates/zinecv-engine | 官方Typst、模板/字体、冻结排版、TextMap、fit、PDF/PNG |
| crates/zinecv-storage | SQLite、migration、版本图、事务、备份恢复与资源引用 |
| crates/zinecv-agent | Provider/SSE、上下文、提议、取消和预算 |
| crates/zinecv-assets、zinecv-native | 共享字体字节；Windows DPAPI及平台能力 |
| src-tauri | 权限、窗口、IPC、受限worker、原生文件、剪贴板与更新装配 |
| zinecv-wasm、src/platform/browser | Rust/WASM、OPFS VFS、Worker、Web Lock、WebCrypto、CORS与PWA |
| zinecv-ohos | 原生核心/NAPI POC适配 |

平台差异经 AgentTransport、SecretProvider、存储/文件/时钟/随机数等能力注入；不在Host重复编辑、排版、版本或提议规则。macOS/iOS使用Keychain，Linux使用Secret Service，Android/Harmony使用平台秘密适配，Browser使用WebCrypto；这些是目标边界，不代表各宿主已交付。结构图源为 target.archify.json。桌面commands按业务职责分组；storage按连接/事务/版本/迁移分组；React工作区和助手入口保留状态与hook顺序，操作和视图分别放在workspace/overlay子目录。

## 文档、写入与资源

- 保留全部基本字段、十模块、summary、隐藏内容、稳定ID、marks、嵌套列表/起始编号、换行/链接/中文空白。输入按数据处理，不执行用户脚本或Typst；A4使用物理单位，UI与纸面分离。
- UI缓冲不等待每次IPC；composition结束后提交。durable ack才表示已保存，导出/提交/切分支/正常关闭先flush，失败保留buffer并阻止动作。强杀仅保证已确认编辑。
- 可信宿主确定账户与document/context；完整AuthorityCursor、CAS、白名单命令、幂等receipt和短事务保证写入。不得暴露任意SQL、路径、JSONPath或脚本。相同commandId不同请求冲突，迟到响应不能覆盖新状态。
- SQLite保持单writer、外键和一致快照。快照内容不可变，不同历史提交保留身份；载入历史不移动head，删除事务重接可见关系并保护共享祖先，替换版本图不替换草稿。来源context保存各自草稿。
- 资源GC覆盖草稿、快照、模板、待审导入、导出/备份lease；头像不能因未提交就丢失。备份恢复先停写/flush/保留旧库，校验schema、外键、资产和哈希后发布；未来schema拒写，不混接旧WAL。回退使用兼容DB副本。
- 迁移源只读，inspect→dryRun→审阅→commit→verify→receipt；namespace/entity/legacy ID稳定映射，重复导入幂等，同ID冲突显式处理，不迁移活动登录token，遗留run标interrupted。

## 排版、导入与交互

- 字体、模板、资源、引擎、布局、语言和参考日期进入渲染身份。预览只保留一个活跃和最新待办，旧generation拒收；异常/超限重建受限worker。World仅访问清单资源，无任意路径或网络。
- 页码1-based、几何pt；DPR不重复乘到CSS坐标。TextMap使用UTF-16 shaping cluster表达连字、组合字及双向文字，跨页fragment按语义顺序；overlay不进入正文和导出，Esc恢复焦点。
- fit只枚举有界候选，保留正文、顺序和语义hash，不假定页数单调；成功应用仍需冻结cursor/CAS。失败不改布局。导出固定调用开始的修订/资源，校验PDF文字/链接/阅读顺序及PNG像素/完整落盘；具体限额见[IPC契约](public-ipc-contract-v1.md)。
- 导入PDF/DOCX/OCR按需加载，返回候选、provenance、原图、警告与不支持项，经确认后事务写入。复杂DOCX留在受限DOM预览，扫描PDF先栅格化；限制文件、页数、像素、ZIP、链接和超时。失败/取消不改正文，不由模型补造低置信字段。
- 保留默认DOM预览、三模板/density/overrides、主题、布局和未知版本提示；不通过换字体、删OCR、缩短动画或放宽现有阈值制造优化。

## Agent与秘密

会话跨Bot/composer/chat与工作区保持run/target。模型只读或提出受限commands，用户确认后由Rust检查账户、文档/context/branch/head/revision、scope、before值、有效期和幂等；多条一次事务，撤回检查after值。只发送显式选择且脱敏的内容，不上传全库；文档内指令不扩大权限。

沿用6次模型调用、12次工具调用、生产90秒预算及取消/迟到保护；断线保留收到的文本，不自动重放工具。Native校验端点/重定向/DNS，Web受CORS限制；UI根据PlatformCapabilities而非平台名称猜测能力。不为不支持的Provider伪造兼容。

匿名编辑不强制注册。本机账户隔离助手状态，保留旧scrypt兼容；Current-user DPAPI保护密文而非整库，跨账户/机器解密失败保留配置和密文并提示重输；不把秘密明文持久化或写入测试/公开日志。

## 平台与一致性

原生端沿用Rust→rusqlite→SQLite；Browser产品使用SQLite编进WASM和Rust OPFS VFS，共用Store语义。可靠锁不具备时显式单writer，降级存储必须提示能力/备份，不能静默分出两套事实源。

跨端ABI为DomainCommand、Backup JSON、冻结排版输入与Agent事件schema；保留migration和高版本拒绝，不另造Web备份格式。结构/文本/几何、同输入视觉、同引擎/字体/平台/架构二进制分别比较，跨OS/CPU的PDF hash仅作诊断。移动端不沿用桌面性能数字。

历史POC替代路径：同步JS存储桥不可行则保留Rust domain/engine并使用明确的浏览器存储适配；OHOS原生SQLite或Typst WASM存在阻断时可隔离平台实现，不改变上层数据契约。当前实现状态以SLICE为准，不恢复旧阶段计划。

性能和规模使用同内容/字体/输入对照，记录p50/p95/max及环境；候选预算与合成场景以fixtures/remaining.mjs和脚本为准，不把目标当结果。验证与执行隔离规则只在AGENTS和开发指南维护。

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
