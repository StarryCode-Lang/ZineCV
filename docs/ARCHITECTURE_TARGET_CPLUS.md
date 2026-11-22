# C+ 架构与设计不变量

React 共享交互，Rust Core 共享产品语义；Tauri、ArkTS/ArkWeb、Browser 是能力宿主。安装端编译原生核心，Browser 编译 WASM。开发命令见 [README](../README.md)，IPC 边界见 [contract](public-ipc-contract-v1.md)。

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

平台差异经 AgentTransport、SecretProvider、存储/文件/时钟/随机数等能力注入；不在Host重复编辑、排版、版本或提议规则。macOS/iOS使用Keychain，Linux使用Secret Service，Android/Harmony使用平台秘密适配，Browser使用WebCrypto；各宿主通过能力注入保持同一业务语义。桌面commands按业务职责分组；storage按连接/事务/版本/迁移分组；React工作区和助手入口保留状态与hook顺序，操作和视图分别放在workspace/overlay子目录。

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
- 导入PDF/DOCX/OCR按需加载，返回候选、provenance、原图、警告与不支持项，经确认后事务写入。PDF worker 保留逐页文字与栅格图像信息；逐页补做无文字或仅少量文字的扫描页 OCR，未覆盖图像文字及混合片段冲突明确告警。图片识别输入独立于预览缩略图，透明背景先合成白底，识别画布沿用 PDF 的 2000 万像素上界，来源仍限制 4000 万像素。复杂DOCX留在受限DOM预览；限制文件、页数、像素、ZIP、链接和超时，120 秒涵盖哈希与草稿准备。失败/取消不改正文，不由模型补造低置信字段。
- 保留默认DOM预览、三模板/density/overrides、主题、布局和未知版本提示；不通过换字体、删OCR、缩短动画或放宽现有阈值制造优化。

## Agent与秘密

会话跨Bot/composer/chat与工作区保持run/target。模型只读或提出受限commands，用户确认后由Rust检查账户、文档/context/branch/head/revision、scope、before值、有效期和幂等；多条一次事务，撤回检查after值。只发送显式选择且脱敏的内容，不上传全库；文档内指令不扩大权限。

沿用6次模型调用、12次工具调用、生产90秒预算及取消/迟到保护；断线保留收到的文本，不自动重放工具。Native校验端点/重定向/DNS，Web受CORS限制；UI根据PlatformCapabilities而非平台名称猜测能力。不为不支持的Provider伪造兼容。

匿名编辑不强制注册。本机账户隔离助手状态，保留旧scrypt兼容；Current-user DPAPI保护密文而非整库，跨账户/机器解密失败保留配置和密文并提示重输；不把秘密明文持久化或写入测试/公开日志。

## 平台与一致性

原生端沿用Rust→rusqlite→SQLite；Browser产品使用SQLite编进WASM和Rust OPFS VFS，共用Store语义。可靠锁不具备时显式单writer，降级存储必须提示能力/备份，不能静默分出两套事实源。

跨端ABI为DomainCommand、Backup JSON、冻结排版输入与Agent事件schema；保留migration和高版本拒绝，不另造Web备份格式。结构/文本/几何、同输入视觉、同引擎/字体/平台/架构二进制分别比较，跨OS/CPU的PDF hash仅作诊断。移动端不沿用桌面性能数字。

平台替代路径：同步JS存储桥不可行则保留Rust domain/engine并使用明确的浏览器存储适配；OHOS原生SQLite或Typst WASM受限时可隔离平台实现，不改变上层数据契约。

性能和规模使用同内容/字体/输入对照，记录p50/p95/max及环境；候选预算与合成场景以fixtures/remaining.mjs和脚本为准，不把目标当结果。验证与执行隔离规则见 [README](../README.md) 与测试脚本。

