# B02 Typst 风险样片证据

状态：`in_progress`。样片入口为 `npm run poc:engine`，源码 `src-tauri/examples/typst_poc.rs`，虚构输入 `contracts/poc-contract-v1.json`，本机产物输出到忽略的 `.artifacts/typst-poc/`。固定 Typst crate 版本为 0.15.1；命令行夹具模式从仓库 `public/fonts/` 显式读取字体，worker 模式则只接收宿主提供并按大小/SHA-256 校验的字节；字体 hash 见 `baseline-manifest.json`。World 只暴露 `/main.typ` 和 `/resume.json`，请求其他路径返回 `NotFound`。固定参考日为 2026-09-26。

| 输入 | 预期页数 | 实测页数 | 编译警告 | 产物 |
| --- | ---: | ---: | ---: | --- |
| short | 1 | 1 | 0 | PDF、逐页 SVG、第一页 PNG |
| medium | 2 | 2 | 0 | 同上 |
| long | 5 | 5 | 0 | 同上 |

三个 PDF 用独立 PyMuPDF 打开后，页框均为约 595.276 × 841.89 pt（A4），可抽取到中文“虚构测试简历”。该检查证明基本排版与可提取文本，不证明全部旧版富文本语义、字体嵌入、链接、阅读顺序或无障碍结构。

`npm run build:engine-poc` 的首次 release 构建耗时 7 分 08 秒（包含依赖编译，不计入运行时）。加入宿主字体资源握手后，重新构建 release 并运行 `npm run bench`，三个独立进程分别耗时 317.29、306.10、310.52 ms；各次退出码均为 0，输出均为 1/2/5 页与零警告。机器为 Windows 11 10.0.26200、i7-11370H、约 16 GB 内存。逐次记录见 `bench-typst-poc-20260926.json`，本机原始文件在忽略的 `.artifacts/bench/typst-poc.json`。这些数字是**命令行夹具模式**，包含启动、字体加载、三份样片编译和导出；不能外推到正式 UI 输入到预览或宿主资源传输的延迟，也不是复杂简历或内存预算的验收。

`typst_poc.exe --worker <generation>` 是独立的进程协议样片。它先输出带协议版本和 generation 的握手，接收两份字体的宿主 manifest 后按 hash 索取字节，对大小与 SHA-256 再核验；普通请求限 4096 字节，资源响应限 30 MB。同一进程可处理多次请求，虚构的 1 页及 5 页输入分别返回 PDF、首张 SVG、首张 PNG。`npm run test:engine-worker` 将 release exe 复制到独立临时目录运行，验证宿主供给、损坏资源拒绝、重复调用、产物格式、错误版本、旧 generation、超限 repeatCount、过长请求、过大资源响应后受控退出；退出码 0。它还没有正式 Tauri 宿主监管、取消/超时、内存配额或**真实 NSIS 安装目录**测试，也没有完整 pageHash、regions 或可选中文字层，因此不能签署 ADR-ENGINE。

当前样片只排简单标题与重复正文，视觉上**尚不等价**于旧版右侧预览；没有头像、CJK/emoji/链接/列表全集、旧版三个模板或稳定的跨页节点定位。旧版纸面选字存在，不能用 SVG 图片冒充保留了选字和复制。B02 后续必须实现并验证对应 textMap/语义层或提出有证据的等价方案。正式 worker 模式、宿主生命周期、取消与超时、安装目录运行和性能预算尚未定案；ADR-ENGINE 暂不签署，F10–F18 仍为 pending。

2026-09-27 增量：worker 样片从 Typst 的逐页 `FrameItem::Text` 输出 `textGeometrySample`，包含文字 run、页序号、UTF-16 字形簇范围、基线位置和字形 advance；两页 Rust 测试已通过。它明确不是计划中的 `TextMap` 契约：映射按 frame 绘制顺序收集，尚无跨页逻辑阅读顺序、逐簇可点击矩形、双向文本/连字的选择策略或真实 WebView 文本层。旧版跨页选区与复制基线见 `paper-text-selection-baseline-20260927.json`；目前不能把诊断输出视为用户可选字或视觉等价的验收。

同日继续验证源关联：虚构 Typst 模板以不可见 `metadata` 标记标题、姓名、章节标题和正文；frame 遍历读取标记后给每个文字 run 与字形簇加 `sourceNodeId`，状态跨页延续。两页 Rust 样片确认首段标题/姓名 ID 和第二页正文 ID；独立 release worker 的 1/5 页请求也确认第一页标题及末页正文 ID。`npm run test:engine-poc` 2 tests、`npm run test:engine-worker` 2 tests、`npm run check:native` 均退出码 0。加入标记前保留的 1/2/5 页输出与加入后输出比较，11 个 PNG/SVG 文件 SHA-256 全部一致，页数仍是 1/2/5、零警告。这个结果只证明当前虚构模板的标记不改变纸面画面；正式 `TextMap` 仍缺全局 `logicalText`、逻辑顺序、选择矩形和复杂排版验收。

后续给诊断簇加入页面 pt 坐标矩形与 A4 页框尺寸。矩形的横向来自 shaped glyph advance，纵向暂复用整段 run 的 `bbox`，再应用嵌套 frame 变换；它是保守的样片几何，不能冒充精确可点击选字框。两页 Rust 用例逐簇确认有限值、非负宽度、正高度和页内边界；release worker 的 1/5 页用例复核同一性质。正式路线仍需逐簇字形外框、连字/组合字符、RTL、变换/裁剪及跨页复制实测。

Unicode 风险补证：受控 `office e\u{301} 中文` 样本没有编译警告，Typst 产生 `ffi`（3 个 UTF-16 单元）和 `e\u{301}`（2 个 UTF-16 单元）两个多单元 shaping 簇，簇范围合并后覆盖全部原文。Windows 专用实验由宿主从系统 `Segoe UI` 与 `Segoe UI Emoji` 读取字体字节、连同仓库思源宋体传给样片 World；`中文 שלום عربي 😀` 排版无警告。直接按 frame 绘制顺序拼接 run 得到 `中文  שלוםعربي 😀`，空格顺序错误；逐 glyph 的 Typst 来源字节偏移仍分别指向原字符串位置，按偏移排序并对照原文可完整复原 `中文 שלום عربي 😀`，包括 emoji 的 4 字节/2 UTF-16 单元。诊断输出已保留 `sourceByteOffset`。这证明不能从 SVG 或 frame 绘制顺序生成复制文本；正式 `logicalText` 必须来自文档模型，簇位置须回映模型范围。系统字体测试不等于已解决打包/许可/跨机器字体一致性，也未证明复杂嵌套富文本或跨页复制。

模型来源增量：移除模板内额外生成的 `lorem` 文本；短、中、长样片改为复制 JSON 合同中的虚构正文段落，按段落序号写入独立 `sourceNodeId`。`sourceByteOffset` 现在能将标题、姓名、章节标题和正文段落的字形簇逐一核对回 JSON 原文字节；额外用 20 段、2 页样片逐段按来源偏移复原原文，覆盖跨页分段。1/2/5 页仍为零编译警告。`npm run test:engine-poc` 5 tests、重新构建 release 后 `npm run test:engine-worker` 2 tests 均通过。正文仍只支持一个纯文本 inline 的段落原型；重复段落由测试夹具构造，尚非任意 ResumeDocument 渲染器，也不代表正式跨页 `TextMap`、视觉等价或用户可选字功能完成。

逻辑顺序增量：worker 新增诊断用 `textMapSample`。`logicalText` 从 JSON 标题、姓名、章节和每个正文段落按模型顺序组成；每个字形簇通过来源字节偏移换算到全局 UTF-16 范围，按范围排序并标注 1-based 页码。20 段跨页样片核对所有范围和顺序，另用逆绘制顺序的希伯来文与 emoji 反例验证排序和 2 个 UTF-16 单元的 emoji；`npm run test:engine-poc` 6 tests、重新构建 release 后 `npm run test:engine-worker` 2 tests、`npm run poc:engine` 的 1/2/5 页、`npm run check:native` 和 `npm run verify:contracts` 均退出码 0。矩形仍来自整段 bbox 的近似值，模型只覆盖样片的单纯文本段落；这不是可交付 `TextMap`，也没有 WebView 可选字层。
