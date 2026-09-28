# ZineCV 2.0 完整开发计划

版本：1.0 / 2026-09-26。研究开始于2026-09-25。执行对象：GPT 6 Sol（主工程与集成）、GPT 6 Luna（契约内的界面、适配、测试与文档）。

**目标：Windows 优先，保留全部现有功能与整体前端视觉，通过统一领域写入、本地事务持久化、文档引擎和测试基础设施降低维护复杂度，改善实际交互、导出与分发体验。** 不以工期或开发成本限制方案；不通过删功能、弱化数据保护、压缩可读性或放宽回归来实现“精简”。

阅读顺序：本文件 → [功能验收矩阵](FEATURE_PARITY.md) → [可行性与证据](FEASIBILITY.md)。研究来源 R01–R46 均在证据文件中提供直接链接。本文件的类型、表和目录是**待实现的目标契约**，不是现有代码或已通过的测试。

## 0. 执行边界和完成定义

正式交付平台为 Windows 10 22H2 x64、受支持的 Windows 11 x64；构建时重新核对 WebView2 支持。macOS/Linux/Web/WASM 保留可扩展边界，不进入此次正式支持矩阵。没有云同步、模板市场、协作编辑或多租户 SaaS；也不能把当前存在的本机账户误删为“不需要的登录”。

旧版继续可用。实际实施在隔离 worktree/新分支 `codex/zinecv-v2`，新应用代码置于 `desktop/`，不在当前工作区直接覆盖旧 `src/`。本计划不授权删除用户数据、覆盖历史 A4 基线、推送或发布；后续用户发出的开发/发布指令分别决定执行权限。业务源码迁移必须遵守项目 GitNexus impact、提交前 detect_changes、推送前三项门禁。

旧 `src/components/preview/`、分页/导出、模型与字体等冻结文件仍冻结。新目录采用新实现，视觉规范从旧版提取；这不表示允许任意重新设计。当前历史基线失败单独保留，新版验收依据 B00 建立的当前可复现行为与保护契约；不能通过覆盖旧基线把遗留失败变为通过。

`2.0-ready` 必须同时满足：功能矩阵全部通过；迁移完整且可恢复；UI/A4 差异已逐项处理；真实性能和维护指标有结果；安装包在干净 Windows 机器通过；字体/图标/模型依赖可分发；真实模型至少一条生产支持路径通过。没有凭据、证书或授权材料的项目标为 blocked/release-blocked，不能用 mock 填成通过。

## 1. 决策与必须守住的架构

| 决策     | 默认实现                                                   | 允许变化的条件                                             |
| -------- | ---------------------------------------------------------- | ---------------------------------------------------------- |
| 容器     | Tauri 2，单主窗口，NSIS x64                                | WebView2 存在被实测证实的阻断才重评                        |
| 界面     | Svelte 5 + Vite + TypeScript                               | B03 无等价收益或交互阻断则 ADR 改用 React；不影响核心契约  |
| 文档权威 | Rust 领域 command + SQLite 持久化                          | 不做 JS/Rust 双 reducer                                    |
| 排版     | Typst Rust library，常驻隔离 worker                        | B02 失败则暂停引擎替换，保留旧版可运行；不得称主路线完成   |
| 数据库   | rusqlite bundled，SQL migration，单写队列                  | 不同时引入前端 SQL 插件和 ORM 两条写通道                   |
| 资源     | 小型资产 BLOB + 内容哈希                                   | 大资源外置需性能证据与独立事务/备份协议                    |
| 富文本   | Tiptap Core/ProseMirror 最小扩展集                         | 只有行为等价且维护更简单的证据才替换                       |
| CSS/动画 | 沿用设计 token；Svelte scoped CSS 与 motion policy         | 必要复杂动画可保留兼容库，不为“零依赖”重造                 |
| 导入     | 统一接口；先保留经语料验证的 JS 适配器                     | 全 Rust 替换必须通过同语料 A/B 闸门                        |
| 秘密存储 | Rust `SecretStore`；Current-user DPAPI密文存SQLite BLOB    | Stronghold仅作备选；不设置machine范围，不新增固定vault密码 |
| 测试     | Rust unit/integration + Vitest + Playwright + 一条原生 E2E | 普通浏览器、mock、真实 exe 的结论分别标识                  |

将业务拆成七个清晰模块：domain、storage、document-engine、imports、agent、identity/secrets、shell/ui。初始不建十几个 workspace crate；一个核心 library crate 按模块组织，一个 Tauri host，加一个可隔离文档 worker 入口即可。没有真实复用场景不加通用插件框架、CQRS 总线、GraphQL、Redux/Zustand 镜像或第二套事件溯源存储。

### 推荐目录

```text
desktop/
  package.json / package-lock.json / vite.config.ts
  src/
    app/                # 启动、三工作区导航、错误边界
    editor/             # 基本资料、模块、富文本、拖拽
    preview/            # 页容器、SVG、文本/语义层、交互轮廓
    templates/          # 现有格式、导入模板、收藏、最近使用
    versions/           # 提交列表、分支树、恢复/删除确认
    agent/              # Bot/composer/chat、引用、提议、账户界面
    platform/           # typed IPC、资源URL、事件订阅、测试替身
    generated/          # Rust导出的TS类型；禁止手改
    styles/             # tokens/reset/全局工作区规则
  src-tauri/
    Cargo.toml / Cargo.lock / tauri.conf.json / capabilities/
    src/
      lib.rs / main.rs / commands.rs
      domain/ storage/ engine/ imports/ agent/ identity/
    migrations/
    resources/templates/ resources/fonts/ resources/ocr/
  tests/
    fixtures/           # 仅虚构数据；覆盖完整功能
    component/ browser/ native/ migration/ visual/
  tools/                # 单一构建/基准/契约生成入口
  docs/
    decisions/          # 简短ADR，只有实际决策才新增
    execution-status.md
    feature-parity.json # 从本计划矩阵落地，状态与证据路径
    benchmark.json
```

目录是职责约束，不要求预先创建空文件。不将大型生成器/测试夹具算成“零代码”，生成文件与生产手写代码分别统计。2.0 验收前旧版与新版并存是迁移成本，不伪装成最终体量；报告分别列旧版、2.0、共存总量。最后迁走旧源码须经独立归档/清理清单，不在功能开发中顺手删除。

## 2. 功能与视觉契约

矩阵中的 F01–F44 都必须映射至实现、测试与证据。新增发现的既有功能补行，不能因未出现在初稿而忽略。默认保留 UI 文案、按钮位置、三工作区、Re:me 三种形态、颜色层级、左右关系、缩放、分栏、滚动、弹层焦点和动效节奏。

视觉分两层验收。**外壳**沿用当前基线 token 和截图，除窗口原生边框及事先记录的字体抗锯齿差异外不改变布局。**简历纸面**保持字体角色、字重、字号、颜色、标题/正文对齐、间距、模块顺序、A4 页数和代表性断行；Typst 引起的显著差异必须修复，不能自动作为“新引擎特色”接受。用户要求“大体不变”不等于允许大幅换版式。

候选容差：固定窗口/视口/DPR/缩放下主要锚点几何误差 ≤1 CSS px；外壳未遮罩像素差异率 ≤0.5% 仅作报警阈值。页面按物理 pt 比较，关键块几何候选容差 ≤0.75pt；代表性 fixture 页数相同、不缺字、不溢出。这些是初始工程目标，B00/B02 将字体抗锯齿、系统 UI 与算法差异单列并固定测量方式；不能用增加遮罩覆盖正文、放宽阈值或重录基线掩盖错误。人工看图和录屏对比仍必需。

纸面截图、实际文本提取、页数和区域命中四类证据必须并存。PNG 保留现有多页纵向拼接默认行为，不能悄悄改成“多文件导出”；可新增可选逐页，但不得代替长图。PDF 改成可搜索文本是明确升级，不需要保留图像 PDF 作为唯一默认。

## 3. 数据契约：Rust 单一权威

### 3.1 ResumeDocument

以下为跨语言接口的阅读形式，正式 Rust 类型由 Sol 在 B04 固定并生成 TS。保留原字段名称和 ID 迁移映射，schema 不能靠每次反序列化“自动清洗”丢未知数据。

```ts
type Id = string;
type Revision = string; // 十进制u64字符串，避免JS整数精度问题
type Sha256 = string;
type ModuleKind =
  | "education"
  | "skills"
  | "work"
  | "projects"
  | "orgs"
  | "research"
  | "awards"
  | "other"
  | "portfolio"
  | "custom";
type BasicInfo = {
  name: string;
  phone: string;
  email: string;
  city: string;
  wechat: string;
  birth: string;
  ageMode: "age" | "birthday";
  website?: string;
  linkedin?: string;
  gender?: string;
  height?: string;
  weight?: string;
  ethnicity?: string;
  birthplace?: string;
  politicalStatus?: string;
  maritalStatus?: string;
  zodiac?: string;
  mbti?: string;
  avatarAssetId?: Id;
};
type Inline =
  | {
      type: "text";
      text: string;
      marks: Array<"bold" | "italic" | "underline" | "strike">;
    }
  | { type: "link"; href: string; children: Inline[] }
  | { type: "break" };
type RichBlock =
  | { type: "paragraph"; children: Inline[] }
  | { type: "list"; ordered: boolean; start?: number; items: RichBlock[][] };
type Entry = {
  id: Id;
  title: string;
  role: string;
  department: string;
  city: string;
  start: string;
  end: string;
  college?: string;
  mode?: string;
  body: RichBlock[];
};
type Section =
  | {
      id: Id;
      kind: ModuleKind;
      title: string;
      visible: boolean;
      entries: Entry[];
    }
  | {
      id: Id;
      kind: "summary";
      title: string;
      visible: boolean;
      body: RichBlock[];
    };
type Presentation = {
  templateId: Id;
  templateRevision: Id;
  density: "comfortable" | "standard" | "compact";
  fontSetId: Id;
  fontSizePt: number;
  lineHeightPt: number;
  moduleGapPt: number;
  pageMarginPt: number;
  headingSizePt: number;
  paragraphGapPt: number;
  listGapPt: number;
  theme: string;
  dateFormat: "2021年1月" | "2021.01";
  titleFormat: "双行标题" | "单行标题";
  separator: "使用分隔符号" | "不使用分隔符号";
  textAlign: "系统默认" | "两端对齐";
  legacyOverrides: Record<string, string | number>; // 保留未知安全覆盖，禁解释成代码
};
type ResumeDocument = {
  schemaVersion: 2;
  documentId: Id;
  title: string;
  basic: BasicInfo;
  sections: Section[];
  presentation: Presentation;
  sourceRef?: { importId: Id; previewAssetId?: Id };
  legacyExtensions: Record<string, unknown>; // 封存未知字段，不渲染、不执行
};
```

保留所有模块（含隐藏模块）的内容，`sections` 顺序是唯一顺序；从旧 `moduleOrder/moduleNames/summaryTitle` 明确映射，隐藏不等于删除。原 summary 经适配保留原文本/HTML语义；列表起始编号、嵌套、软换行、链接白名单、中文全角与空白均有金样。禁止用正则随意剥离 HTML；使用受控解析器映射 AST，未知标签/属性给出报告并封存原始迁移输入。JSON 到 Typst 只作为数据，不运行用户文本。

日期内容保持用户输入及原格式；不要把“至今”等强制转 UTC。年龄计算的参考日期属于渲染输入并冻结，避免历史快照过生日后悄悄改变导出。旧布局值按实际 CSS 使用单位逐字段转换，不能把所有字符串一律乘 0.75。页面 A4 使用精确物理单位；保存迁移前值方便对照。

### 3.2 命令、修订号、冲突与保存

```ts
type CommandEnvelope = {
  protocolVersion: 1;
  commandId: Id;
  documentId: Id;
  contextId: Id;
  expectedRevision: Revision;
  expectedBranchId: Id;
  expectedHeadId: Id | null;
  payload: DomainCommand;
};
type AuthorityCursor = {
  documentId: Id;
  contextId: Id;
  revision: Revision;
  branchId: Id;
  headId: Id | null;
};
type CommandResult = {
  commandId: Id;
  cursor: AuthorityCursor;
  durable: true;
  snapshotHash: Sha256;
  document: ResumeDocument;
  changedIds: Id[];
};
type AppError = {
  code:
    | "VALIDATION"
    | "CONFLICT"
    | "NOT_FOUND"
    | "PERMISSION"
    | "STORAGE_FULL"
    | "STORAGE_CORRUPT"
    | "UNSUPPORTED_SCHEMA"
    | "RESOURCE_LIMIT"
    | "CANCELLED"
    | "ENGINE_FAILURE"
    | "MIGRATION_PARTIAL"
    | "PROVIDER_FAILURE";
  message: string;
  retryable: boolean;
  diagnosticId: Id;
};
```

`actor/account/window` 从宿主可信会话注入，不接受模型或前端任意传入“管理员”。前端每文档串行命令队列，批量同字段输入可合并；已发出的命令不能被随意改 ID 或复用参数。Rust 持久化 commandId、可信actor/作用域、请求 hash 与结果，在同一事务中提交；相同 ID 相同请求重试返回原结果，不同请求返回冲突，返回receipt前仍重新检查当前会话权限。revision为document全局单调序列，在 DB 事务内 CAS 更新；成功响应和事件都返回完整AuthorityCursor，提交/切分支后可据此构造下一条命令。UI按会话epoch与cursor拒绝旧账户、旧context或较小revision回写；重试得到旧receipt只确认成功，不回退当前画面，必要时重新读取最新snapshot。测试“成功但ack丢失→后续编辑→重试”和“账户切换→旧响应迟到”。

`DomainCommand` 最小集合：UpdateBasic、SetEntryBody、UpdateEntryFields、AddEntry、DeleteEntry、MoveEntry、RenameSection、SetSectionVisibility、MoveSection、SetDocumentTitle、SetLayout、ApplyTemplate、ApplyImport、CommitVersion、CreateBranch、SwitchBranch、LoadCommitToDraft、DeleteCommit、DeleteBranch、ReplaceVersionStore、ConfirmProposal、UndoConfirmedProposal。字段 patch 采用白名单类型，不暴露任意 JSONPath、文件路径或 Typst 脚本。

输入法 composition 和富文本选区留在 UI。普通输入建议 100–150ms 合并，composition 结束后再提交；“未保存/保存中/已保存/失败”独立于渲染状态。导出、版本提交、分支切换、关闭窗口之前必须 `flushEditorBuffers → await durable ack → freeze revision`；失败就停止该动作并保留输入 buffer。不能先显示成功，再异步碰运气落盘。正常窗口关闭需等待或提示保存失败；进程强杀只承诺恢复已经 durable ack 的编辑，尚未发送的字符不能声称已保存。

富文本 undo/redo 在编辑器事务历史内；Agent 撤回走带 expectedAfter 的领域逆操作；版本恢复走明确命令。不建立两个互相抢 Ctrl+Z 的历史系统。模板/分支/历史载入替换编辑器内容时，按已定义边界重置或封存当前局部历史，不能跨文档撤销到别人的内容。

### 3.3 SQLite 表与不变量

| 表                                          | 核心列与用途                                                                                       |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| documents                                   | id、title、current_branch_id、active_context_id、revision；不引入新多文档 UI，但保留内部 namespace |
| editing_contexts                            | id、document_id、source_kind、source_id；稳定编辑上下文，重命名不换ID                              |
| drafts                                      | document_id + context_id + branch_id、revision、document_json、hash、updated_at；未提交内容        |
| snapshots                                   | id、schema_version、canonical_version、document_json、hash；正文不可变                             |
| commits                                     | id、document_id、origin_branch_id、snapshot_id、message、created_at；版本身份不等于内容 hash       |
| commit_links                                | commit_id、visible_parent_id；删除重接的当前可见关系，与快照内容分离                               |
| branches                                    | id、document_id、name、head_commit_id、created_at；默认分支受保护                                  |
| template_revisions                          | template_id + revision、manifest、源码/资源 hash、engine_version；历史不可变                       |
| template_activity                           | template_id、favorite、last_used_at；不进入每个简历快照                                            |
| assets / resource_refs                      | hash/id、mime、bytes、size、license_ref；引用按owner_kind/owner_id显式关联草稿、快照、模板、导入   |
| imports / legacy_entity_map                 | source_hash、importer_version、namespace、receipt、status；稳定旧实体ID映射与导入批次分开          |
| accounts / account_sessions                 | 本机身份、KDF参数/哈希、会话；与OS账户和云账户概念区分                                             |
| provider_profiles                           | account_id、connection_id、base_url、model、secret_ref、capability；无明文Key                      |
| agent_sessions / agent_messages / proposals | account_id、引用、run状态和待审提议；不混入简历版本快照                                            |
| settings                                    | 工作区偏好、分栏/缩放/Agent位置；不污染文档内容hash                                                |
| command_receipts / schema_migrations        | 幂等结果、migration ID/checksum/版本与执行记录                                                     |

foreign_keys 每连接开启，单 writer，读连接有限池，WAL/busy_timeout、重要保存 FULL；连接参数、DB 版本写入诊断但不写个人数据。B04 生成实际建表 SQL、唯一约束、索引与事务测试，不采用这个表格直接拼生产 SQL。hash 基于固定版本 canonicalization；浮点有限且有范围，ID/Revision 不跨 JS 安全整数边界。保留 `raw_source_sha256` 与语义 hash 区别，内容相同的两个历史提交不能合并丢失时间与身份。

editing_context的默认映射为工作区默认内容和各导入模板/内容来源的稳定ID。单纯在同一内容上应用三种内置版式只改presentation，不创建新内容副本；选择另一导入内容来源先flush当前context，再在事务中保存active_context并读取目标draft。已有工作区版本图仍共享，不因为新增context暗中拆分历史；快照记录来源context，历史载入恢复对应映射。分支切换仍遵守原“未提交修改确认后替换”的语义，不自动把旧branch草稿恢复成新行为。B00核对实际模板上下文，B04固定映射金样；必须验收“A导入内容未提交编辑→B编辑→A→重启”两份草稿不串改。

资产先用 BLOB；所有被保留快照、durable草稿、保留模板、待审导入引用的模板/字体/头像不得被清理，活跃导出/备份额外持有资源lease。`resource_refs`的owner类型与删除级联必须验证；垃圾回收只处理无任何持久引用且无lease的资源，不能只看snapshot引用。测试“上传头像→只保存草稿不提交版本→GC→重启头像仍在”。字体文件若授权不允许入用户备份，备份记录资源身份和缺失恢复要求，不能宣称跨机完全重现。完整备份必须同时覆盖 DB、秘密的可恢复状态及可分发资源清单；凭据默认不导出明文，界面明确恢复时需重新配置什么。

Windows默认秘密实现固定为Current-user DPAPI：`secrets(secret_id, account_id, provider_id, backend_version, encrypted_blob)`与provider配置同库事务更新。Rust调用CryptProtectData/对应解密接口，不使用`CRYPTPROTECT_LOCAL_MACHINE`，避免本机其他OS用户可解密；不硬编码额外entropy。通常需相同Windows登录凭据和原机器，漫游profile存在例外，因此不宣传绝对机器绑定。数据库备份保留密文但不保证跨机、重装或换Windows用户后能解密；恢复时逐条检测，保留旧密文并标记需重输Key。它不隔离同一OS用户的恶意进程，也不把简历数据库整体加密。[R46]

## 4. 文档引擎协议

```ts
type RenderRequest = {
  protocolVersion: 1;
  renderId: Id;
  documentId: Id;
  revision: Revision;
  document: ResumeDocument;
  snapshotHash: Sha256;
  templateHash: Sha256;
  fontSetHash: Sha256;
  assetManifestHash: Sha256;
  engineVersion: string;
  referenceDate: string;
  purpose: "preview" | "export" | "fit";
};
type HitRegion = {
  sectionId: Id;
  entryId?: Id;
  semanticOrder: number;
  fragmentId: Id;
  page: number;
  xPt: number;
  yPt: number;
  widthPt: number;
  heightPt: number;
};
type RenderResult = {
  renderId: Id;
  revision: Revision;
  renderKey: Sha256;
  workerGeneration: string;
  pages: Array<{
    page: number;
    widthPt: number;
    heightPt: number;
    assetId: Id;
    pageHash: Sha256;
  }>;
  regions: HitRegion[];
  textMap?: TextMap;
  warnings: Array<{ code: string; targetId?: Id; detail: string }>;
};
type TextMap = {
  version: 1;
  logicalText: string;
  clusters: Array<{
    sourceNodeId: Id;
    startUtf16: number;
    endUtf16: number;
    logicalOrder: number;
    page: number;
    xPt: number;
    yPt: number;
    widthPt: number;
    heightPt: number;
  }>;
};
```

页码统一 1-based。渲染坐标为 pt，UI 用页面实际显示宽度/widthPt 换算，再处理滚动与缩放；DPR 只影响栅格输出，不重复乘到 CSS 坐标。边框画在独立 overlay，不进入 SVG/文本/导出层。一个跨页条目对应多个 fragment；点击优先最具体 entry，键盘顺序按 semanticOrder，Esc 恢复焦点。轮廓不能覆盖相邻模块，空模块/空白页也有明确行为。

完整 cache key 包含 snapshot、template、font、assets、engine、layout、语言/参考日期；预览 cache 不可被过期任务覆盖。最多一个活跃普通编译加一个最新待编译快照；过期结果丢弃，长任务超时可杀 worker。并发导出读取冻结修订，不能混用“当前预览的上一版”；仅在同一worker同generation内复用 `PagedDocument`/renderKey，worker重建后用冻结输入重编译，不能把不可跨进程对象当IPC句柄，也不能另走 CSS 重新排版。

资源协议由host掌握：`ResourceManifest {hash, mime, size, role}`列出本次模板/字体/图片，worker仅能按manifest hash请求只读bytes，host核对hash与大小再供给；不接受任意路径。每次worker启动增加generation并协商engine/protocol版本，旧generation消息一律丢弃。页面SVG/PNG由host接收后写入host自有、有界的资源缓存，前端assetId指向host缓存而非worker私有文件；页面可见或导出期间持有lease。缺字节返回明确MISSING_RESOURCE诊断，host补齐后最多一次自动重试，仍失败保留上一版并显示生成失败，不能无限重启。

B00必须确定旧预览纸面选字/复制是否可用及其范围；已有行为必须保留。需要时B02产出textMap：offset指向logicalText的UTF-16区间，按shaping cluster而非“一个字一个框”，覆盖连字、组合字符、双向文本和跨页阅读顺序。UI文本层不参与Typst排版，普通复制来自logicalText，不从SVG路径OCR；命中层不得拦截文字选择或链接。若旧版确无此能力，则B02记录证据，textMap可省略，B07只做既有键盘语义定位，不能凭此宣称预览支持选字。

SVG 资源使用受控本地资源协议/只读缓存 ID，不在每次 IPC 传所有页的巨大 base64，也不允许任意文件路径。只更新 pageHash 变化页面；图片/字体缓存带容量上限并在空闲回收，导出期间引用不失效。只给受信任的引擎 SVG 进入隔离展示通道；导入 SVG/HTML 不能直接插入高权限 WebView。

模板固定三种现有 ID 的映射：`legacy-v1`、`clear-single-v1`、`compact-single-v1`；保留 density、override 与未知版本 fallback 提示。先完成最复杂长内容模板，再扩展全部；不拿空白第一页作为引擎可行证明。

“智能一页”是独立求解器，不能期待 Typst 自动完成。保持正文、条目、模块顺序、语义 hash 不变，只枚举受限布局候选，限制最小可读字号/行高/边距和最多编译次数。建议最多 16 个候选、独立超时，缓存成功参数；若无法一页则恢复原布局并提示原因。每个候选实际编译验证，不假设页数对字体/间距严格单调，不能只靠二分估算或截断隐藏内容。

导出 PNG 的默认像素规格在 B00记录现有 2x ceil 行为，再为2.0提供兼容默认；额外高DPI按明确单位计算。长图内存按宽×高×4加中间缓冲预算，超限提供逐页或有界拼接选择，不崩溃、不输出空文件。PDF文件要检查中英文文字、列表阅读顺序、超链接、嵌入字体与 A4 页面尺寸，不能只看截图。

## 5. 迁移与恢复：不丢一类数据

Tauri 的 profile 不会自动读取旧 Chrome/Edge 在 `127.0.0.1:5173` 的 localStorage。必须提供原 origin 的导出入口和手动文件导入两条路径。B10 交付独立的旧版兼容导出工具/可选小补丁，默认只读当前数据、用户主动点击下载，不扫描整个浏览器 profile，不导出无关网站。旧冻结预览文件无需修改。

迁移清单覆盖：当前正文、布局、模块名和顺序、隐藏模块、模板上下文/缩略图/识别文本、收藏最近使用、完整版本图、未提交草稿、工作区偏好、账户、provider 配置、每账户 Agent 会话和可迁移秘密状态。凭据源由用户选定，不在诊断文件输出实际 Key。旧 HTTP 登录 cookie/活跃运行 token 不迁移，要求重新登录；历史会话内容保留并标注中断运行不可续写。

流程固定为 `inspect → dryRun → user review → commit → verify → receipt`。inspect 仅读源；dryRun 在内存或独立临时 DB 校验、转换、比较计数和关系；commit 检查 source hash、目标 revision 未变，再用事务写入全部实体与 receipt。源格式不支持、字段未映射、模板缺失、凭据无法解密必须显示诊断，不能统称“导入成功”。

批次幂等键采用 source hash + importer version + source namespace；实体映射另设唯一键`(namespace, entity_kind, legacy_id)`，跨导入批次复用。namespace由首次导入登记的来源身份固定，后续源文件更新或importer升级必须选择已有来源，不能每次随机生成；来源不确定时让用户明确选择“同一旧库”或“另一份独立库”。同实体同内容跳过，不同内容产生明确冲突/更新方案；新增提交只增新实体。相同来源同版本重复导入不重复生成实体；同名不同 ID 保留；同内容不同历史版本保留。浏览器版本缓存与项目 JSON 发生同 ID 不同内容时，分别保留冲突来源，让用户选方案，不盲目以更新时间或数量最多为真。验收源新增一个提交后重导和importer升级后重导，不能整库翻倍。

`.data/versions.json`、`.data/versions.backup.json` 以及账户 JSON均只读导入，不搬走、不修复、不清空。测试用合成 fixture。正式迁移前后可本机核对 SHA-256，不能把真实数据送入研究工具或公开 CI。主文件损坏时分别展示 backup 的可恢复结果，部分恢复要写可恢复/丢失/需处理三张清单。

SQLite 在线备份使用 Backup API，先生成候选副本，验 `integrity_check`/`foreign_key_check`、资产hash与关系，再原子发布备份文件。恢复时先停写、flush、关连接并保留旧库与相关状态，再切换已验证候选；不混接旧 WAL。schema migration 在数据库备份之后执行，版本记录与 DDL/DML 尽量同事务；未来 schema 拒绝写入，不能自动删未知列继续。

应用回退与数据回退分开：失败升级保留前版应用与升级前 DB备份；旧版不能直接打开未知新 schema。rollback工具先选择兼容DB副本，再运行前版；不能只替换exe。旧版浏览器/JSON保留到2.0迁移验收和用户数据处置另行完成。

## 6. Agent、身份与导入契约

### Agent 状态与受控写入

三页共享一份会话，Bot/composer/chat只是视图，不因导航重建 runtime。保留账户注册/登录/退出、模型配置与能力探测、会话切换、引用标签、流式文本、错误恢复、提议预览与撤回。匿名编辑简历不要求强制注册；账户继续服务现有 Agent 隔离，不凭空改成所有简历按账户拆库。

状态：`idle → preparing → running → awaiting_confirmation → applying → completed`，可从运行态转 failed/cancelled；取消后所有迟到 chunk/tool/proposal 都被 runId/seq 拒收。断线保持已接收文本并提示重试，不能默认重放工具调用。现有运行预算至少保留 6 次模型调用、12 次本地工具调用、90秒等效上限；可配置增加必须有产品理由与压力验证，不能无限循环。

模型可用工具分为只读（read_selected、compare_versions、inspect_template、local_help）和 `propose_commands`。模型没有 confirm/apply/delete-file/run-shell/raw-sql 权限。只有 UI 确认通道能要求 Rust 应用提议；Rust 核对 account、document、branch、HEAD、revision、字段before值、scope、proposalId未使用和有效期。多条修改先全量验证，再一次事务全部应用；任何冲突整组失败，给用户重新预览，不应用半组。撤回也检验预期after值，防止覆盖后续手工编辑。

`Proposal` 至少包含 proposalId、runId、accountId、documentId、baseRevision、branchId、headId、selectedScopeHash、commands、beforeValues、explanation、createdAt、state。确认成功的 receipt 与命令结果同事务保存。内容发送只来自用户显式选择/脱敏字段；引用整个版本/模板不等于授权把其所有内容或整个 `.data` 上传。文档里的指令只是数据，不能扩充工具权限。

Rust provider 使用保存的 connectionId，不接受模型返回任意 URL。传输支持 SSE、跨chunk UTF-8、多行 data、结束/错误帧、超时、重试与取消；Rust请求和UI订阅生命周期明确。远程 HTTPS 与用户显式添加的本机模型 endpoint 分开验证，重定向/DNS重新检查，不因CSP存在就放弃出站校验。能力未验证的模型保持 chat-only，真实 structured工具验证通过后才启用提议。

本机账户密码沿用旧 scrypt 验证兼容，首次成功登录后可升级KDF并记录参数；不保存明文密码、不复制旧活跃session token。新provider secrets由Rust保管；迁移旧明文Key时只读源、写新SecretStore，验证成功但不删除旧文件，提醒旧副本处置是另一个用户动作。OS保护不等于抵御同用户恶意进程，本计划不将本机账号描述为强多租户安全隔离。

### 导入状态

```ts
type ImportDraft = {
  importId: Id;
  sourceHash: Sha256;
  sourceType: "pdf" | "docx" | "image" | "legacy";
  engine: string;
  engineVersion: string;
  previewAssetIds: Id[];
  candidate: ResumeDocument | null;
  fieldEvidence: Array<{
    targetId: string;
    page?: number;
    text: string;
    confidence?: number;
  }>;
  warnings: string[];
  unsupportedFeatures: string[];
};
```

状态固定 `queued/running/review_required/committed/failed/cancelled`。解析完成只生成候选；用户确认后才进入 ApplyImport。文本提取、样式/模板识别、原图预览分别验收；保留PDF首屏源图覆盖、编辑/改布局后退出覆盖的现有行为。源图不是可编辑排版，也不能让导出与用户眼前原图产生未说明的差异；B00记录原行为，B09定义明确“原文件预览/编辑后文档”标识与导出切换。

图片/PDF/DOCX按需加载，OCR模型和PDF资源本地可用。文件大小、页数、图片像素、ZIP解压量/压缩比、字体/链接和超时设上限；将超限作为可解释错误，不让解析器堵主线程。加密PDF提示密码或不支持状态，不能导入空白算成功。扫描PDF先栅格化再OCR；质量低进入人工校正，不能用模型编造内容补空字段。

## 7. 可测量的性能与复杂度目标

以下均是**候选验收预算，不是已测结果或上游承诺**。B00冻结基准机、release构建、Windows/WebView2版本、DPI与fixtures；B02/B03可以一次性用证据校准预算，之后不得为通过而反复放宽。

| 指标                      | 初始预算/比较方法                                                                                          |
| ------------------------- | ---------------------------------------------------------------------------------------------------------- |
| 普通键入响应              | 主线程输入反馈 p95 ≤50ms；不得为等IPC阻塞IME                                                               |
| 1–2页普通编辑到新预览可见 | 热态端到端p95 ≤250ms，包含debounce/IPC/编译/绘制                                                           |
| 5页复杂简历预览           | 热态p95 ≤750ms；持续输入仅最新修订生效                                                                     |
| 冷启动到可编辑            | 标准Win11+SSD release目标≤2s；引擎预热单独记录                                                             |
| 模板切换                  | 1–2页p95 ≤500ms；保留旧页面直到新结果可见但标明生成中                                                      |
| PDF导出                   | 5页目标≤2s；PNG另测DPI/长图内存，不用PDF预算混算                                                           |
| 拖拽/折叠                 | 60Hz设备p95帧时间目标≤16.7ms；无大于100ms输入卡顿                                                          |
| 内存                      | 记录主进程+WebView2子进程+worker总量；30分钟持续编辑后应平台化，任务结束回收；初始压力预算500MiB待基线校准 |
| 版本提交                  | 1000个50KiB纯文本快照时p95 ≤150ms；头像/模板资源另计                                                       |
| 自动化                    | 共享构建一次，普通PR无重复全构建；报告耗时、flaky率与覆盖，不以删除断言提速                                |
| 总维护量                  | 2.0稳定实现手写生产代码目标比旧版等价范围减少≥20%，是优化目标而非删功能硬配额                              |
| 结构复杂度                | 单一领域写入口；无循环依赖；每条校验规则单一权威；组件约400行/模块约800行作为review提示，非机械拆分命令    |
| 包体                      | 分列应用本体、字体、OCR模型、WebView2离线包；不给“几MB”营销目标                                            |

采样每个场景至少30次，冷启动至少10次，报告p50/p95/max、失败次数和环境；重复3轮观察波动，不按最好一次报。旧版对照用独立profile和独立数据目录，绝不控制用户当前5173页面。研究期未跑这些基准，执行状态初始全部pending。

性能PoC应包含空白、1页、2页、5页、20/100/500条目、头像、混合列表、长链接和1000版本；超大输入另设产品上限，不能用极小样例证明所有规模。高耗时渲染与导入同时运行时仍能取消、编辑、关闭。所有性能改善需同功能、同字体和同内容对比。

## 8. 分批实施与依赖

主顺序：B00 → B01 →（B02 与 B03 可并行）→ B04 → B05 → B06/B07 → B08/B09 → B12 → B13 → B14 → B15。B11在B04/B05之后可独立进行；B10在B05后可做非秘密迁移，但账户/Key完整迁移验收必须等待B11。B12同时依赖B06/B08/B11；B13要求B06–B12全部集成。并行仅在契约已经冻结且文件所有权不冲突时使用；两个Agent不得同时改一个公共类型、SQL migration或锁文件。

每批必须交付：具体实现、对应fixture/测试、退出码和证据、功能矩阵状态、剩余风险、当前提交号、下批入口。不允许只有截图demo、静态mock、TODO或build通过就标完成。以下“命令名称”由B01先实现为项目脚本，未实现前不得假装它们已存在。

### B00 — 当前行为、视觉和数据基线

**负责人 Sol；Luna 整理矩阵与fixture。** 输入为本计划、本仓库当前提交和维护状态。只读盘点F01–F44，补充遗漏；从现有测试提取虚构fixture、操作步骤、截图、录屏和字段金样。记录每种模板、DPR、分栏/滚动位置与导入覆盖状态；提取设计token、动画时长/曲线与控制器状态机。记录所有localStorage键、JSON schema和账户会话范围，绝不读真实内容去生成公开测试。

交付 `feature-parity.json`、`baseline-manifest.json`、hash与benchmark原始结果，新增仅必要的fixture。运行旧版相关preview/versions/agent/导入/动效检查；已有失败原样登记，不能重录历史baseline。**完成条件：每个现有入口可映射到验收案例，遗留差异与新回归可区分。** 若无法取到可靠视觉基线，停止受影响UI迁移，不停独立契约工作。

### B01 — 隔离骨架、工具链和验证入口

**Sol。** 新worktree/分支、`desktop/` Svelte+Vite+Tauri骨架；固定Rust MSVC、Node和锁文件，声明Windows支持目标、严格开发端口（旧版仍5173，桌面开发用另一个显式固定端口且strictPort）。建立CI一次构建、多测试复用；实现 `check`、`test:unit`、`test:browser`、`test:native`、`bench`、`verify:contracts` 与 Rust fmt/clippy/test/构建入口。

先生成空壳release exe和NSIS安装器，在独立临时数据目录启动，拿到WebView2 E2E样例。设置CSP、capabilities、正式包禁debugger/test插件。冻结`poc-contract-v1`最小ResumeDocument/RichBlock/RenderRequest与虚构fixtures，B02/B03共用，禁止两份不同PoC schema；这只供样片，不验收生产持久化。B04生成正式契约后重跑受影响样片，不能靠临时协议长期并存。**完成条件：干净Windows开发机可重复构建，测试确实控制桌面exe且数据隔离；没有Node运行时常驻生产依赖。** 不以浏览器dev页面代替。

### B02 — Typst 风险样片，先证明最难部分

**Sol主做；Luna制作语料与视觉对照。** 固定Typst及export crates、字体/模板hash，实现常驻worker和最小World资源供给；做三个模板中最复杂的1/2/5页文档，含全部richtext格式、CJK/emoji/链接/头像/长条目。一次编译导出SVG/PDF/PNG，验证文字提取、跨页命中框、纸面选字/语义层策略和智能一页候选原型。

测试取消/超时/worker崩溃、离线缺包、缺字、越界资源与连续键入乱序，测端到端预算。ADR-ENGINE同时定案内部exe worker模式或sidecar，用B01安装器做实际安装目录smoke test：结构化参数启动而非shell拼接、父进程退出不留worker、超限清理相关进程树、generation拒收、worker与host协议/资源版本匹配。**交付 ADR-ENGINE、兼容差异清单、可运行样片和失败反例；完成条件为F10–F18关键案例通过且B00视觉合同可满足。** 只拿到`page/x/y`或只生成PDF不算通过。失败则保留旧版引擎，记录具体阻断，不扩大重写。

### B03 — Svelte 等价交互样片

**Luna主做；Sol独立验收。** 在相同token/图标/fixture下实现一个复杂条目富文本、模块折叠/拖拽、分栏缩放、一个Agent形态切换。比较React原版与Svelte的代码、状态边界、实际输入/动画/焦点和内存；明确中文IME真人验收步骤、拖拽取消/快速松手、reduced motion、键盘路径。

**交付 ADR-UI；完成条件：样片功能视觉不退化，且至少一个预先选定维护/资源指标有明确改善，其他核心指标不显著恶化。** 默认推进Svelte；如失败由Sol保留React适配接口，不把该选择当迁移成本问题或删掉难实现交互。

### B04 — 领域类型、命令与数据规则

**Sol。** 实现本计划第3节Rust类型、schema版本、生成TS绑定、canonical hash金样、白名单command、revision/CAS与错误码；草稿/版本/模板/账户namespace规则写ADR。Luna可在冻结接口后做合法与非法payloadfixture，但不改公共类型。

验证命令纯逻辑、未知ID/字段、隐藏模块内容、富文本转换、单位映射、重复commandId/跨账户访问、原值冲突。**完成条件：UI测试替身与真实Rust返回同契约；单一领域执行器；类型生成无diff漂移；TS没有复制核心reducer。**

### B05 — SQLite、资源、版本图与恢复

**Sol。** 实现真实SQL migrations、单写者、草稿持久化、不可变snapshot、可见commit links、branches、资源关联和设置；实现backup/restore与启动损坏处理。以现有版本操作为golden，逐项对照创建分支、载入草稿、删除重接、默认分支保护、版本库恢复不替换草稿。

故障注入至少覆盖snapshot/asset/head写入前后、commit前后强杀、磁盘满、权限拒绝、两窗口CAS冲突、备份并发和新schema拒绝。**完成条件：重启只出现完整旧状态或完整新状态、无悬空资源；全部F24–F29通过；0次触碰用户 `.data`。** kill测试不是掉电证明，持久性假设记录。

### B06 — UI 外壳、编辑器与状态接线

**Luna；Sol审查IPC与保存边界。** 迁移左编辑右预览、工具栏、布局设置、导航、缩放、分栏、滚动、快捷键、基本信息/头像、全部模块、富文本、模板上下文草稿。复用设计规范，先匹配再清理CSS；不要复制旧全部全局样式后叠一层新体系。

接真实Rust command，保存状态和flush barrier，IME buffer与撤销分工，window close处理。**完成条件：F01–F09、F41–F44适用项通过，截图/录屏对照、真IME无丢字；任何保存失败不能显示已保存。** 仅UI mock可以用于局部开发，不能作为本批验收。

### B07 — 完整排版、预览、智能一页与导出

**Sol负责引擎；Luna负责预览UI与回归，目录分别拥有。** 扩展B02到全部模板/布局参数/模块与源图状态，实施pageHash增量更新、语义命中及B00确认需要的选字层、分页/多页长图、smart fit有限求解和失败回滚。

**完成条件：F10–F18全部通过；导出与冻结revision一致，预览hover/focus轮廓绝不进入导出；全文语义hash在smart fit前后不变；原始PDF覆盖与编辑后预览区分明确。** 主排版链路可移除旧DOM测量和截图依赖，导入模块仍需这些依赖时不得全局卸载。

### B08 — 模板库与版本界面

**Luna；Sol审查版本语义。** 三个内置模板、density与override、导入模板增删改名、收藏/最近使用、模板上下文，完整历史列表、分支树指针缩放/拖动/键盘/焦点、确认弹层、恢复与失败提示全部接真实数据库。

**完成条件：F19–F20、F24–F30通过；切换模板不改正文；删除模板不破坏历史快照；列表与树一致；原有历史载入/分支动作语义不变。** 不引入新的多文档产品流程替代现有模板草稿体验。

### B09 — PDF / DOCX / OCR 导入

**Luna负责适配器/UI；Sol负责隔离与安全审查。** 建立ImportDraft、资源限额和取消；先保留PDF.js/Mammoth/Tesseract实现的已知能力，按DOM依赖区分Web Worker和无特权预览WebView。全部模型、worker和CMap资源离线打包。比较Rust候选仅在契约和测试不变条件下替换。

语料至少含文本PDF、双栏、扫描、多页、旋转图、低清图、DOCX列表/表格/浮图/文本框、损坏/加密/超限文件；分别评价字段与段落顺序、缩略图、模板建议、诊断、峰值资源。**完成条件：F21–F23和F18通过；识别低置信度不静默写入；取消与失败不污染当前简历。** 不以“纯Rust”替代准确率证明。

### B10 — 旧版完整迁移与账户兼容

**Sol负责迁移器；Luna负责向导/导出工具和验收语料。** 实现旧origin迁移包导出、JSON只读导入、inspect/dryRun/commit/verify/receipt、ID映射、hash幂等与来源冲突处理；账户旧KDF兼容、会话归属、秘密迁移单独报告。B11提供实际SecretStore之后才能完成Key迁移：默认DPAPI先加密并验证可解密，再将密文/配置/receipt同SQLite事务提交，DB失败不留外部secret。若选择库外backend，须另实现secret_pending/verified/complete及幂等ID补偿，不把跨存储写入假装成SQL原子事务。恢复后Key不可解密按需重输状态报告。

覆盖主文件损坏但backup有效、仅browser缓存、仅JSON、重复导入、导入中强杀、未知模板版本、同ID冲突、图片缺失、缺Key和旧账户登录。**完成条件：F30、F40及全数据清单对账通过；源文件hash不变；重复导入3次不增重复实体；部分迁移绝不标完整成功。** 无法访问的旧浏览器数据不能伪造恢复。

### B11 — 账户、凭据与模型网关

**Sol。** 实现本机账户、错误密码限流、会话锁定/退出、SecretStore backend、模型连接配置/探测、Rust HTTP/SSE与typed channel、请求取消、URL与重定向约束、日志脱敏。沿用现有账户UI，不强迫用户每次启动输入新vault密码；若Stronghold路线需要新增交互，先通过产品/安全ADR。

**完成条件：F31–F33通过；前端不能读取已保存Key；离线可编辑；账户切换不泄漏会话/配置；真实保存重启恢复；流式拆包/UTF-8/错误/取消反例通过。** 真实供应商联调单列待用户环境配置，不能硬编码开发Key。

### B12 — Agent Runtime、共享浮层与提议

**Sol负责runtime/tool权限；Luna负责已有视觉形态、引用、会话与diff。** 在B04/B05/B11基础接入run状态机与预算，只读工具与propose_commands，显式上下文/脱敏、当前target冻结、事务确认、冲突与安全撤回。界面不能持有工具执行器和provider网络逻辑。

**完成条件：F34–F39通过；取消后迟到请求不写入；同名经历靠稳定ID区分；切页/最小化不改target；多提议原子提交；真实模型一条支持路径演示“建议→审阅→确认→保存→重启恢复”。** 若模型仅聊天能力，界面明确限制，不猜测工具能力。

### B13 — 全量兼容与性能收口

**Sol统筹；Luna独立按矩阵复测。** 统一测试runner，迁移现有断言而非逐行搬脚本，消除重复build；对全部F项给证据和状态。补真实WebView2、DPI100/125/150/200%、视口1440×900/1920×1080及当前最小窗口、键盘、屏幕阅读、真IME、持续30分钟压力。

测第7节所有指标，统计TS/Rust/Typst/SQL/测试/工具/生成物各自规模，检查循环依赖和重复状态。性能未达标先profile再优化，不减功能。**完成条件：所有强制功能pass；性能达到冻结预算或有明确未完成项；无未解释视觉差异；临时/mock路径不进入release。** 未达LOC目标必须真实报告，不能改统计口径。

### B14 — Windows 安装、升级、离线与公开发布门禁

**Sol；Luna负责安装体验和文档。** NSIS在线/离线两个channel同版本，用户级AppData路径、日志轮转、非管理员与中文路径、可选更新签名、升级前备份与rollback runbook。发布CI固定工具链、锁文件、资源manifest、SBOM/NOTICE、SHA-256和签名验证；字体/iconfont授权必须解决。

干净Win10/Win11 VM验证无Node/Rust/Typst/SQLite、无WebView2在线安装、断网离线安装、首次离线编译/导入OCR、升级中断、错误签名拒绝、新库不能被旧版破坏、卸载默认保留数据；重验engine/protocol/资源版本一致和升级后无旧worker驻留。**完成条件：实际下载的安装包验证通过，证书/发布密钥/素材证据齐全。** 缺发布材料则标release-blocked，可交付本地RC，不宣称正式发布。

### B15 — 交接、旧链路退役与最终验收

**Sol最终负责。** 交付安装包、迁移/备份指南、完整功能矩阵、基准报告、变更日志、依赖许可、故障恢复步骤与维护架构图。枚举旧链路依赖实际引用，确认2.0无生产Node网关/DOM测量/jsPDF导出路径；导入暂存html2canvas等如仍必要，明确保留原因与边界。

所有测试迁移通过后才移除重复脚本/旧适配层；旧项目、用户数据和固定基线不在自动清理范围。清理本次临时文件前解析绝对路径并检查仅处于已批准输出目录，保留复现输入、锁文件、授权、有效脚本、故障证据。**完成条件：另一执行者从干净克隆按文档构建、安装、迁移、编辑、版本、Agent、导出、恢复全部走通；只有此时可以宣布2.0开发完成。** 发布授权与开发完成分别报告。

## 9. Sol / Luna 协作与直接使用的提示词

Sol拥有公共契约、schema/migration、Cargo/package锁、Rust核心、引擎、安全与发布集成；Luna拥有已分配的UI组件、样式、适配器及测试。一个批次只有一个集成人。公共契约变更先由Sol评估所有使用者并生成新binding；Luna不得自行加第二份类型、直接绕过IPC调用数据库或为完成页面伪造后端。

每个任务限制明确允许路径、输入契约版本与矩阵ID；跨文件路径冲突先拆解。worker task只能在契约稳定后并行；同一份用户数据、同一个测试profile、同一个migration文件、同一个锁文件禁止共享并发写入。模型名称是用户指定的职责分配，不是对模型能力的无条件保证，Sol仍须独立验证Luna交付。

### 给 GPT 6 Sol 的启动指令

```text
执行 docs/zinecv-v2/DEVELOPMENT_PLAN.md，先阅读 FEASIBILITY.md、FEATURE_PARITY.md、
AGENTS.md 与 docs/maintenance-status.md。Windows优先，功能完整、整体视觉大体不变。
本轮先完成B00/B01，并准备B02/B03可审查样片；不要跳过关卡直接重写全部界面。
创建隔离worktree与codex/zinecv-v2分支，在desktop/实现，保留旧版与用户.data。
你负责契约、Rust核心、SQLite、Typst、安全、迁移与最终集成；可把独立UI/fixture任务
交给GPT 6 Luna，给出允许路径、输入版本、矩阵ID、完成条件。禁止双reducer、假后端验收。
编辑前按项目规定做GitNexus impact，提交前detect_changes；推送/发布须有用户授权。
每批记录真实命令退出码、视觉与功能证据、剩余风险、下一批入口。
没有凭据/授权/真实性能结果的项标blocked或pending，不用mock冒充完成。
持续推进所有已授权且不依赖缺失条件的批次，不为常规实现选择反复询问。
```

### 给 GPT 6 Luna 的任务模板

```text
你负责批次[Bxx]的[具体子任务]，读取DEVELOPMENT_PLAN.md及FEATURE_PARITY.md。
输入提交：[SHA]；契约版本：[protocol/schema]；允许修改：[明确目录/文件]。
必须保留：[功能矩阵ID及视觉/交互边界]；使用：[真实IPC接口或仅开发期fixture]。
不得改Rust领域契约、DB migration、锁文件、冻结预览文件或用户.data，除非任务明确授权。
输出实现+最小充分测试+对照截图/录屏+实际退出码+未完成项，不以build通过代替验收。
若接口缺失，向Sol提交精确缺口；不能自造生产mock、第二份状态或降低验收标准。
完成后给出所改路径、满足的矩阵ID、证据路径和交接注意事项。
```

状态文件仅维护目标、当前批次/提交、已确认事实、完成证据、未完成与下一步，避免复制整篇计划。状态只用 pending/in_progress/passed/blocked/failed；每个passed有测试/手工证据与适用提交，源代码相关变更后自动失效相关结果。不能把“Agent说完成”作为通过证据。

## 10. 最终发布检查与停止条件

开发侧检查建议顺序：schema/binding漂移 → Rust fmt/clippy/unit/integration → Svelte/type/lint/unit → 一次release UI build → 浏览器场景 → 真实Windows exe → 安装/升级/离线 → 数据迁移恢复 → 视觉/性能 → 许可与包体检查。全套只在集成点跑，普通小改运行受影响最小集，已通过且未改变的检查不重复跑。

如准备推送，最后一次源码变更之后刷新GitNexus索引、status/循环/影响范围、只读ast-grep扫描以及当前提交对应Archify校验交付；相关测试与 `git diff --check` 全通过再推。新Tauri/Rust目录的索引覆盖和解析能力须确认，不把UNKNOWN/空调用图当安全；回退实际源码与Rust测试。Archify sidecar不进提交。

以下情况停止相应批次并保存证据：需要改旧冻结文件才能继续；迁移出现不可解释字段/提交/资源丢失；页数/主要版式不能达到已定合同；Agent能越权写入；持久化成功提示与磁盘结果不符；正式包包含不明许可素材或测试入口；真实性能结果不支持宣称的提升。可继续独立批次，不能用延期/保留旧版冒充全部完成。

验收交付清单：

- [ ] F01–F44及实施发现的补充功能全部通过且证据可复现。
- [ ] 三个模板、所有富文本格式、A4、缩放、智能一页与PDF/PNG一致。
- [ ] 所有旧数据类别对账、幂等迁移、失败重试、备份恢复与schema升级通过。
- [ ] 真Windows IME、WebView2、原生文件、安装/升级/离线场景通过。
- [ ] Agent显式上下文、真实模型、确认/冲突/取消/撤回、账户隔离通过。
- [ ] 总代码、性能、内存、包体与测试成本有真实前后数据；不虚报减半。
- [ ] 字体、图标、模板、OCR/native库与发布签名门禁关闭。
- [ ] 干净克隆复现、维护图、runbook、无用户数据泄露与最终清理完成。

**本计划交付时，上述开发验收项全部尚未执行。研究可行不等于实现可用；真正的跃升由这套验收结果决定。**
