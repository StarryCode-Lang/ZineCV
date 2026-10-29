# M2 契约设计稿：文档与契约（vNext）

2026-10-28 · 设计稿 · 对应 [NEXT_MAJOR_VERSION_PLAN.md](../NEXT_MAJOR_VERSION_PLAN.md) §5/§8 的 M2 阶段（文档元数据、activeDocument、岗位关联、迁移与隔离）。

## 0. 结论（先读）

1. **存储层已经是多文档参数化的，缺口只在桌面宿主与前端。** 所有按 `document_id` 组织的表与查询均已存在（`crates/zinecv-storage/src/storage/drafts.rs:4` `load_active_document(document_id)`、`drafts.rs:48` `switch_editing_context`、`drafts.rs:256` `initialize_document`）；桌面命令层用 `verify_default_document`（`src-tauri/src/commands/session.rs:228`）与硬编码 `DEFAULT_DOCUMENT_ID`（`src-tauri/src/lib.rs:41`）把入口全部锁死在单文档。M2 的主体工作是**新增宿主 activeDocument 状态 + 把约 20 个命令入口的文档校验从"必须等于 DEFAULT"改为"必须等于宿主 active"**，而不是重写存储。
2. **与计划假设的两处现状冲突（如实记录）：**
   - `import_drafts` 表（schema v12，`crates/zinecv-storage/src/storage/migrations.rs:277-294`）**没有 `target_document_id` 列**，导入草稿目前不持久绑定目标文档，只在 `apply_import` 时经 `request.cursor` 校验（`crates/zinecv-storage/src/storage/imports.rs:203-219`）。"草稿持久绑定原目标"需要 schema 变更。
   - `store_avatar_asset` 在解绑旧头像时硬编码 `DEFAULT_DOCUMENT_ID`（`src-tauri/src/commands/rendering.rs:42`），多文档下会解绑错误文档的 avatar 资源引用；本设计一并修正。
3. **epoch 机制有三个已存在的前身，M2 沿用同一模式而非新造**：前端 `NativeDocumentClient.sessionEpoch`（`src/platform/NativeDocumentClient.ts:37`，切换时 `++` 于 :123，所有响应按 epoch 拒绝过期结果 :76/:92/:237/:287）；宿主 agent run epoch（schema v14 `agent_run_lifecycle.epoch`，`migrations.rs:332-351`，运行时原子计数 `src-tauri/src/commands/agent_run.rs:39-44`）；数据库代计数 `AgentRuns.1`（`src-tauri/src/lib.rs:48-53`，恢复成功 `fetch_add` 于 `src-tauri/src/commands/versions.rs:164`，agent 发起校验于 `agent_run.rs:77-83`）。M2 新增**宿主进程内 activeDocument epoch**，并把它接到前端既有 `sessionEpoch` 上。
4. 新增 IPC 11 个（`document_create/list/archive/restore/switch_active_document` + 岗位材料 5 个），改造现有命令 20 个；基线 62 IPC（`src-tauri/src/lib.rs:172-235` 与 `crates/zinecv-contracts/src/commands.rs:241-304` 的 union、`src-tauri/capabilities/default.json` 三处相等由 `tools/verify-contracts.mjs:4-12` 强制），M2 后 73。
5. schema 17 → 18 一次迁移完成：documents 表加 6 个元数据列、import_drafts 加目标绑定列、新建 job_materials 三表；沿用既有自动备份迁移链（`crates/zinecv-storage/src/storage/connection.rs:70-88` 升级前验证备份，失败回滚原库并写诊断文件 :101-117）。旧程序拒开未来 schema 已有实现（`storage/schema.rs:142-148` → `storage.rs:52-56` `UnsupportedSchema`），M2 只需补测试。

---

## 1. 现状盘点（引用真实代码）

### 1.1 三种身份的现有落点

| 身份 | 现有实现 | 证据 |
| --- | --- | --- |
| 独立简历（文档） | `documents` 表 + `ResumeDocument.document_id` | v1 迁移 `migrations.rs:5-11`；`default_resume_document` 接受任意 id（`crates/zinecv-domain/src/lib.rs:540`） |
| 来源上下文（editing context） | `editing_contexts` 表，`document_id` + `source_kind` + `source_id`；同文档内切换 | v1 迁移 `migrations.rs:12-19`；`switch_editing_context` `drafts.rs:48-254`（CAS 于 documents 行 :229-244）；来源上下文 ID 稳定派生 `storage/validation.rs:33-49` |
| 分支/提交（版本） | `branches`/`commits`/`drafts` 均带 `document_id`；分支 ID 含文档身份 `main:{document_id}` | v1 迁移 `migrations.rs:20-40`；`storage/validation.rs:22-24` |

草稿持久化按 `(document_id, context_id, branch_id)` 三元组主键（v1 迁移 `migrations.rs:37`），因此**每个文档天然持有独立草稿、独立版本图**。

### 1.2 宿主命令层的单文档锁（现状缺口）

`DEFAULT_DOCUMENT_ID = "workspace-default-document"`（`lib.rs:41`），启动时初始化默认文档与上下文（`lib.rs:136-145`）。以下入口全部只放行该 ID：

| 位置 | 命令 | 限制方式 |
| --- | --- | --- |
| `src-tauri/src/commands/documents.rs:11` | `document_state` | 硬编码 `load_active_document(DEFAULT_DOCUMENT_ID)` |
| `documents.rs:55,68` | `version_graph_detailed` / `version_commit_detail` | 硬编码 |
| `documents.rs:80-86` | `apply_document_command` | `envelope.document_id != DEFAULT` 拒绝 |
| `session.rs:228-237` + 各调用点 | `switch_editing_context`、全部版本命令、渲染/导出/fit/agent | `verify_default_document(cursor)` |
| `src-tauri/src/commands/versions.rs:11,25,41,57,73,88,106` | `commit_version`、`create_version_branch`、`switch_version_branch`、`load_history_commit`、`delete_version_commit`、`delete_version_branch`、`replace_version_store` | cursor 校验 |
| `src-tauri/src/commands/rendering.rs:12,93,122,255,280` | `store_avatar_asset`、`fit_document_one_page`、`render_document_export`、`render_document_preview`、`export_document_pdf` | cursor 校验 |
| `rendering.rs:42` | `store_avatar_asset` 解绑旧头像 | **硬编码**（冲突点，见 §0.2） |
| `src-tauri/src/commands/imports.rs:40,101` | `inspect_legacy_identity_conflicts`、`apply_import` | `target_document_id`/cursor 校验 |
| `src-tauri/src/commands/agent_run.rs:29`、`src-tauri/src/commands/preferences.rs:153` | `agent_chat`、`agent_selected_context` | cursor 校验 |

### 1.3 前端单文档假设

- `NativeDocumentClient` 是单实例单文档客户端（`src/platform/workspace.ts:10` 单例），持有 `current: DocumentState` 与 `sessionEpoch`；`submit` 在排队时从 `this.current.cursor` 捕获完整身份构造 envelope（`NativeDocumentClient.ts:159-171`），`applyImport` 同样在队列内校验 `sameCursor`（:206-208）——plan.md:22 要求的"保存排队时捕获完整身份"**已满足，设计保留**。
- 三处 `"workspace-default-document"` 字符串兜底需在 M2 移除（改为 fail-fast）：`src/platform/useNativeResumePersistence.ts:79-81`、`src/platform/useNativeResumeVersions.ts:171`、`src/platform/legacyImport.ts:155`。
- flush 前置已有雏形：`flushDraft` 失败即"已取消切换"（`useNativeResumePersistence.ts:119-132`），版本动作前 `flushDraftBeforeVersionAction`（`workspace.ts:33-38`）；文档切换沿用同一闸门。

### 1.4 迁移/备份机制现状（M2 直接复用）

- 打开库：完整性检查 → `check_schema_compatibility`（未来 schema 拒开：`storage/schema.rs:142-148` 抛 `UnsupportedSchema`）→ 需要升级时**先写验证过的 pre-upgrade 备份**（`connection.rs:85-88`）→ 事务内跑 `MIGRATIONS`（`schema.rs:317-347`）→ 失败回滚原库 + 写诊断文件（`connection.rs:101-117`）。
- 全库备份/恢复：`backup.rs:86-129` 导出（128 MiB 上限）、`backup.rs:131-155` 恢复（staging 中先迁移校验再 Backup API 发布，`restore_database_backup` 落 pre-restore 备份）。
- 迁移清单：`MIGRATIONS: [(i64, &str); 17]`（`migrations.rs:1`），每版 SHA-256 校验（`schema.rs:150-154`）。新增 schema 必须同步扩 `check_schema_compatibility` 的表存在性检查（`schema.rs:166-312` 按版本枚举）。

### 1.5 与计划冲突/需修正的现状汇总

1. `import_drafts` 无目标绑定列（§0.2.1）。
2. `rendering.rs:42` avatar 解绑硬编码 DEFAULT。
3. `inspect_legacy_identity_conflicts` 仅放行 DEFAULT（`imports.rs:40`）。
4. `crates/zinecv-wasm/src/dispatch.rs:9` 与 `agent_host.rs:105` 也常量 DEFAULT；WASM/OHOS 独立根不在本轮授权，仅记录，不随 M2 改。
5. `document_state` 响应缺文档元数据与 epoch（`lib.rs:78-83` `DocumentState` 只有 cursor+document）。

---

## 2. 新增/修改的 Rust 类型草案（ts-rs 导出）

全部新增类型放 `crates/zinecv-contracts/src/`（新文件 `documents.rs`、`jobs.rs`），在 `lib.rs` 的 `pub use` 出口（`crates/zinecv-contracts/src/lib.rs:33-47`）登记；每个类型带 `#[derive(..., TS)]` + `#[ts(export, export_to = "../src/domain/bindings/")]`，与现有模式一致（`commands.rs:3-4`）。绑定仍由 `cargo test --manifest-path crates/zinecv-contracts/Cargo.toml --locked export_bindings` 经共享 `TS_RS_EXPORT_DIR` 生成到 `src-tauri/src/domain/bindings/`（`tools/with-msvc.ps1:18,86-88`）。`deny_unknown_fields` 沿用现有请求结构约定（`docs/public-ipc-contract-v1.md:121-123`）。

### 2.1 文档元数据（contracts/documents.rs 新文件）

```rust
/// 列表页/宿主元数据。与 documents 表新列一一对应，不复制简历内容。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../src/domain/bindings/")]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DocumentMeta {
    pub document_id: Id,
    pub title: String,
    pub origin_kind: DocumentOriginKind,
    pub archived: bool,
    pub archived_at: Option<String>,
    pub sort_order: i64,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../src/domain/bindings/")]
#[serde(rename_all = "snake_case")]
pub enum DocumentOriginKind {
    Blank,            // M3 空白新建
    Imported,         // M3 从已确认导入内容新建
    Duplicated,       // M3 复制
    MigratedDefault,  // 升级时原默认简历（仅升迁写入一次）
}

/// document_state 的扩展响应（替换 lib.rs:78-83 的宿主私有 DocumentState，
/// 新字段追加，cursor/document 字段名与形状不变）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../src/domain/bindings/")]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ActiveDocumentState {
    pub cursor: AuthorityCursor,
    pub document: ResumeDocument,
    pub meta: DocumentMeta,
    pub epoch: u64,
}

pub struct DocumentListResult {
    pub documents: Vec<DocumentMeta>,        // archived 过滤由参数决定
    pub active_document_id: Option<Id>,      // 宿主当前文档；None 仅在异常状态
}
```

### 2.2 activeDocument 切换（contracts/documents.rs）

```rust
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SwitchActiveDocumentRequest {
    pub expected_epoch: u64,          // 宿主当前 epoch；不符即 Conflict（防双窗口竞态）
    pub expected_current_id: Option<Id>, // 可选：调用方眼中的当前文档，宿主一致性校验
    pub target_document_id: Id,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct SwitchActiveDocumentResult {
    pub document_id: Id,
    pub cursor: AuthorityCursor,      // 目标文档的 load_active_document 结果
    pub document: ResumeDocument,
    pub meta: DocumentMeta,
    pub epoch: u64,                   // 递增后的宿主 epoch
}

/// document_create：一次 IPC 完成"创建 + 切换 active"。调用前必须已 flush 当前文档。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum CreateDocumentPayload {
    Blank { initial_title: String },
    Duplicate { source_document_id: Id, initial_title: Option<String> },
}

pub struct CreateDocumentRequest {
    pub command_id: Id,               // 幂等收据，沿用 command_receipts
    pub payload: CreateDocumentPayload,
}
// 响应复用 SwitchActiveDocumentResult（新文档即成为 active）。

pub struct ArchiveDocumentRequest {
    pub command_id: Id,
    pub target_document_id: Id,
    pub expected_archived: bool,      // 期望的当前归档态，幂等/竞态防护
}
pub struct RestoreDocumentRequest { /* 同 ArchiveDocumentRequest 字段 */ }
// archive/restore 响应复用 DocumentListResult。
```

要点：

- 归档/恢复**不是** `DomainCommand`（不进简历内容 hash、不推进 `documents.revision`），独立命令 + `command_receipts` 幂等。
- 复制语义按计划 §5（`NEXT_MAJOR_VERSION_PLAN.md:156`）：复制当前草稿内容与布局、新文档独立初始版本（复用 `initialize_document` `drafts.rs:256-332` 的 initial commit 路径），不复制助手会话、待审提议与历史；资源按 hash 内容寻址天然共享（`resources.hash` 主键，v1 迁移 `migrations.rs:65-71`）。

### 2.3 岗位材料（contracts/jobs.rs 新文件；M2 建契约与表，M4 消费）

```rust
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct JobMaterial {
    pub id: Id,
    pub document_id: Id,          // 归属一份简历
    pub title: String,            // 岗位名称
    pub company: String,
    pub job_description: String,  // 用户粘贴的职位描述（本地材料）
    pub source_note: String,      // 来源备注
    pub revision: u32,            // 从 1 起，每次修改 +1
    pub created_at: String,
    pub updated_at: String,
}

pub struct UpsertJobMaterialRequest {
    pub command_id: Id,
    pub job_material: Option<JobMaterial>, // None=新建（id 由宿主派生）；Some=更新（id+revision 必须匹配最新）
    pub title: String,
    pub company: String,
    pub job_description: String,
    pub source_note: String,
}

pub struct DocumentJobLink {
    pub id: Id,
    pub document_id: Id,
    pub job_material_id: Id,
    pub job_material_revision: u32,  // 建议能说明依据的职位描述版本（计划 §6）
    pub branch_id: Id,               // 该 document 的岗位分支
    pub created_at: String,
}

pub struct LinkJobMaterialRequest {
    pub command_id: Id,
    pub cursor: AuthorityCursor,     // 绑定目标文档当前状态；宿主校验 active
    pub job_material_id: Id,
    pub job_material_revision: u32,
    pub branch_id: Id,
}
```

岗位材料修订表在每次 upsert 时插入新行（修订保留，不覆盖）；链接记录 `job_material_revision`，M4 的"材料过期提示"以修订号比较实现。

---

## 3. IPC 契约：新增命令与现有命令改造

新增/变更需四处同步（`docs/public-ipc-contract-v1.md:30-32`）：`NativeIpcCommandName` union、`generate_handler!`（`lib.rs:172-235`）、`src-tauri/capabilities/default.json` 的 `allow-*` 列表、`docs/public-ipc-contract-v1.md` 契约描述；`tools/verify-contracts.mjs` 校验前三处相等。

### 3.1 新增命令（11 个）

| 命令 | payload → 响应 | capability | 说明 |
| --- | --- | --- | --- |
| `document_list` | `{ include_archived: bool }` → `DocumentListResult` | `allow-document-list` | 列表页；按需载入，不带正文 |
| `document_create` | `CreateDocumentRequest` → `SwitchActiveDocumentResult` | `allow-document-create` | 空白/复制；创建即切换 |
| `document_archive` | `ArchiveDocumentRequest` → `DocumentListResult` | `allow-document-archive` | 归档，不删数据 |
| `document_restore` | `RestoreDocumentRequest` → `DocumentListResult` | `allow-document-restore` | 恢复归档 |
| `switch_active_document` | `SwitchActiveDocumentRequest` → `SwitchActiveDocumentResult` | `allow-switch-active-document` | 宿主 epoch 递增点；见 §5 |
| `job_material_save` | `UpsertJobMaterialRequest` → `JobMaterial` | `allow-job-material-save` | 修订保留 |
| `job_material_list` | `{ document_id: Id }` → `Vec<JobMaterial>` | `allow-job-material-list` | 只读 |
| `job_material_delete` | `{ command_id, job_material_id }` → `()` | `allow-job-material-delete` | 幂等收据 |
| `job_material_link` | `LinkJobMaterialRequest` → `DocumentJobLink` | `allow-job-material-link` | 关联分支 |
| `job_material_unlink` | `{ command_id, link_id }` → `()` | `allow-job-material-unlink` | 幂等收据 |
| （可选合并项）`document_search` | 不新增 | — | 搜索在 `document_list` 结果上前端过滤即可，不加命令 |

M2 后基线 62 → 72~73（是否合并 `document_restore` 进 `document_archive` 由实施定；契约稿按 73 计）。

### 3.2 改造为携带文档身份的现有命令（逐个列出）

统一规则：新增宿主入口 helper

```rust
// src-tauri/src/commands/session.rs（扩展 verify_default_document 的位置）
fn require_active_document(
    active: &State<ActiveDocumentHost>,
    document_id: &str,
) -> Result<u64, AppError> {
    // 返回当前 epoch；document_id != active.document_id 时返回
    // ErrorCode::Conflict（"Document is no longer active"），不可重试。
}
```

替换 `verify_default_document` 的全部调用点（`session.rs:228-237` 保留函数但改语义或删除）：

| 命令 | 现校验 | M2 校验 | 位置 |
| --- | --- | --- | --- |
| `document_state` | 无参数、读 DEFAULT | 无参数，读宿主 active；响应扩展为 `ActiveDocumentState` | `documents.rs:4-15` |
| `switch_editing_context` | `expected_cursor == DEFAULT` | `expected_cursor.document_id == active`；**语义不变**（同文档内来源上下文切换，不推进宿主 epoch） | `documents.rs:18-45` |
| `version_graph_detailed` | 硬编码 DEFAULT | 读宿主 active 的 `document_id` | `documents.rs:48-57` |
| `version_commit_detail` | 硬编码 DEFAULT | 同上（detail 归属 active 文档；跨文档 detail 由前端先切换） | `documents.rs:60-71` |
| `apply_document_command` | `envelope.document_id == DEFAULT` | `envelope.document_id == active`（宿主层）；存储层 CAS 不变 | `documents.rs:74-92` |
| `commit_version` | cursor == DEFAULT | `cursor.document_id == active` | `versions.rs:11` |
| `create_version_branch` | 同上 | 同上 | `versions.rs:25` |
| `switch_version_branch` | 同上 | 同上 | `versions.rs:41` |
| `load_history_commit` | 同上 | 同上 | `versions.rs:57` |
| `delete_version_commit` | 同上 | 同上 | `versions.rs:73` |
| `delete_version_branch` | 同上 | 同上 | `versions.rs:88` |
| `replace_version_store` | 同上 | 同上；成功后宿主 epoch 递增（版本图整体被替换） | `versions.rs:98-130` |
| `export_database_backup` | 无 | 不变（全库操作） | `versions.rs:133-141` |
| `restore_database_backup` | 无 | 成功后：宿主 epoch 递增 + active 从 settings 重读 + 前端强制 reload（既有 `requires_relogin` 路径） | `versions.rs:144-191` |
| `store_avatar_asset` | cursor == DEFAULT | `cursor.document_id == active`；`unlink_resource` 改用 `cursor.document_id`（修 `rendering.rs:42` 硬编码） | `rendering.rs:4-51` |
| `read_avatar_asset` | 无 | 不变（hash 全局寻址） | `rendering.rs:54-83` |
| `fit_document_one_page` | cursor == DEFAULT | `cursor.document_id == active`；**发起时校验，在途冻结快照不中止**（见 §6.5） | `rendering.rs:86-105` |
| `render_document_preview` | 同上 | 同上 | `rendering.rs:248-267` |
| `render_document_export` / `export_document_pdf` | 同上 | 同上 | `rendering.rs:109-143,270-292` |
| `pick_export_path` / `pick_export_directory` / `write_export_file` | 无文档身份 | 不变（无状态文件交付，`docs/public-ipc-contract-v1.md:155-178`） | `rendering.rs:146-245` |
| `create_import_draft` | 无目标绑定 | `CreateImportDraftRequest` 新增必填 `target_document_id`，必须 == active；写入草稿持久绑定 | `imports.rs:4-14` |
| `get_import_draft` | 无 | 不变（按 draft_id 读；UI 只展示属于当前文档的草稿） | `imports.rs:69-79` |
| `transition_import_draft` | 无 | 不变（不改绑定列） | `imports.rs:82-92` |
| `apply_import` | cursor == DEFAULT | `request.cursor.document_id == active` **且** `== import_drafts.target_document_id`（双校验） | `imports.rs:95-107` |
| `commit_legacy_migration` | cursor == DEFAULT | `cursor.document_id == active` | `imports.rs:54-66` |
| `inspect_legacy_identity_conflicts` | `target_document_id == DEFAULT` | `== active`（放开 DEFAULT 限制） | `imports.rs:35-51` |
| `agent_chat` | `target_cursor == DEFAULT` | `target_cursor.document_id == active`；运行中既有 `validate_active_cursor` 检查（`agent_run.rs:239-252`）与 `stale_target` 提案拦截（`agent_run.rs:336-337`）保留 | `agent_run.rs:7-29` |
| `agent_selected_context` | cursor == DEFAULT | `expected_cursor.document_id == active` | `preferences.rs:148-167` |
| `confirm_proposal` / `undo_confirmed_proposal` | 仅存储层 `record.cursor == request.cursor`（`crates/zinecv-storage/src/storage/proposals/inbox.rs:335-358`） | 入口加 `request.cursor.document_id == active`；提案持久绑定原目标文档（`agent_proposals.document_id`，v15 迁移 `migrations.rs:361`），切换后确认被拒 → 提示返回原目标 | `proposals.rs:16-52` |
| `reject_proposal` | 无 cursor | 不变（不写正文，`docs/public-ipc-contract-v1.md:92-93`） | `proposals.rs:29-39` |
| `list_agent_proposals` / `list_agent_runs` / `cancel_agent_run` | 账号域 | 不变（inbox 记录已含 `document_id`，`crates/zinecv-contracts/src/agent.rs:119-132`，UI 按当前文档过滤或提示） | `proposals.rs:4-13,55-68` |
| 偏好/账户/模板/会话/更新/剪贴板（`read_setting` 等 24 个） | 无文档身份 | 不变 | `preferences.rs`、`providers.rs` 等 |

---

## 4. 存储层 schema 变更草案（v18）与迁移

### 4.1 v18 迁移 SQL 草案（追加到 `MIGRATIONS[17]`，`migrations.rs:1`）

```sql
-- v18: 多文档元数据、导入草稿目标绑定、岗位材料
ALTER TABLE documents ADD COLUMN origin_kind TEXT NOT NULL DEFAULT 'migrated_default'
  CHECK(origin_kind IN ('blank','imported','duplicated','migrated_default'));
ALTER TABLE documents ADD COLUMN archived INTEGER NOT NULL DEFAULT 0 CHECK(archived IN (0,1));
ALTER TABLE documents ADD COLUMN archived_at TEXT;
ALTER TABLE documents ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0;
ALTER TABLE documents ADD COLUMN created_at TEXT NOT NULL
  DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'));   -- 存量行为升级时刻，一次性近似，可接受
ALTER TABLE documents ADD COLUMN updated_at TEXT NOT NULL
  DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'));
CREATE INDEX idx_documents_list ON documents(archived, sort_order, updated_at);

ALTER TABLE import_drafts ADD COLUMN target_document_id TEXT REFERENCES documents(id);
UPDATE import_drafts SET target_document_id = 'workspace-default-document'
  WHERE status IN ('queued','running','review_required');   -- 存量未完结草稿绑定原默认文档
CREATE INDEX idx_import_drafts_target ON import_drafts(target_document_id, updated_at);

CREATE TABLE job_materials (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL,
  title TEXT NOT NULL,
  company TEXT NOT NULL DEFAULT '',
  job_description TEXT NOT NULL DEFAULT '',
  source_note TEXT NOT NULL DEFAULT '',
  revision INTEGER NOT NULL CHECK(revision >= 1),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  FOREIGN KEY(document_id) REFERENCES documents(id)
);
CREATE INDEX idx_job_materials_document ON job_materials(document_id, updated_at);
CREATE TABLE job_material_revisions (
  job_material_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY(job_material_id, revision),
  FOREIGN KEY(job_material_id) REFERENCES job_materials(id)
);
CREATE TABLE document_job_links (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL,
  job_material_id TEXT NOT NULL,
  job_material_revision INTEGER NOT NULL,
  branch_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  FOREIGN KEY(document_id) REFERENCES documents(id),
  FOREIGN KEY(job_material_id) REFERENCES job_materials(id),
  FOREIGN KEY(branch_id) REFERENCES branches(id)
);
CREATE INDEX idx_document_job_links_document ON document_job_links(document_id);
CREATE UNIQUE INDEX idx_document_job_links_unique
  ON document_job_links(document_id, branch_id, job_material_id);
```

补充说明：

- `archived_at TEXT` 无 NOT NULL DEFAULT：SQLite 的 `ALTER TABLE ADD COLUMN` 不允许非常量默认，改为可空列。
- `import_drafts.target_document_id` 对 `committed/failed/cancelled` 存量行为 NULL（历史草稿无绑定必要）；新写入路径强制必填。
- **不做**的事：不向 `job_materials` 复制简历内容（计划 §8：`NEXT_MAJOR_VERSION_PLAN.md:211`）；不给 `documents` 加"当前 active"列——active 是宿主会话状态，持久化进既有 `settings` 表（key `active-document-id`，v3 迁移 `migrations.rs:106-113`），重启后宿主校验该文档存在且未归档，否则回退 `workspace-default-document`。

### 4.2 schema version 递增与兼容检查

- 版本一次性 17 → 18（单条迁移，半途无中间版本；事务保证原子，`schema.rs:317-347`）。
- `check_schema_compatibility` 同步追加（`schema.rs:269` 后按模式添加）：`applied_versions.contains(&18)` 时校验 `job_materials`、`job_material_revisions`、`document_job_links` 三表存在；基础表检查（`schema.rs:166-177`）不变。
- 未来 schema 拒开：现有逻辑 `version > latest → UnsupportedSchema`（`schema.rs:142-148`），错误映射 `storage.rs:52-56`。**无需新代码，只需测试**（§9-T6）。

### 4.3 迁移步骤与验证点

1. 升级前备份：`Store::open` 内自动完成（`connection.rs:85-88` `write_verified_backup`，文件名 `zinecv.sqlite3.pre-upgrade-{pid}-{nanos}.bak`，`schema.rs:26-42`），备份经 `validate_connection` 校验后落盘。
2. 迁移执行：单事务 + SHA 校验（`schema.rs:326-343`）；失败回滚原库并写 `*.upgrade-diagnostic.txt`（`connection.rs:101-117`）——原库保持 schema 17 可被旧版打开。
3. 验证点（实施时逐一断言）：
   - 17 库升级后：`migration_versions()` 含 18（`schema.rs:355-363`）；默认文档 `archived=0`、`origin_kind='migrated_default'`；存量 `review_required` 草稿的 `target_document_id` 已回填。
   - 幂等：同一 18 库重复 open 不再改写（`migrate` 按版本跳过，`schema.rs:327-336`）。
   - 失败注入：用 `test-hooks` 的 `publication_test_hook`（`storage/validation.rs:5-20`）或人为坏 SQL 验证回滚 + 备份可用。
   - 旧程序拒开：schema 18 库交给不含 v18 迁移的旧二进制打开 → `UnsupportedSchema`。
   - 全库备份恢复：`restore_database_backup`（`backup.rs:131-141`）在 staging 中完成 17→18 迁移后发布；恢复后 `active-document-id` 设置若指向不存在/已归档文档，宿主回退默认文档。

---

## 5. activeDocument 宿主机制

### 5.1 状态放哪

```rust
// src-tauri/src/lib.rs（新增 managed state，与 ActiveSession/AgentRuns 并列 :146-151）
#[derive(Default)]
struct ActiveDocumentHost {
    // Mutex 保证"读 epoch + 读 document_id"原子；epoch 从 1 起，0 表示未初始化
    inner: Mutex<Option<ActiveDocumentInner>>,
}
struct ActiveDocumentInner {
    document_id: String,
    epoch: u64,
}
```

- 进程内状态，不持久化 epoch（跨重启的 IPC 连接已断，无迟到响应风险）。
- `active-document-id` 持久化进 `settings` 表，供重启恢复与"上次文档"语义。
- 启动序列（`lib.rs:120-151` setup）：现有 `initialize_document(DEFAULT...)` 保留（原位纳入列表，满足计划 §5 `NEXT_MAJOR_VERSION_PLAN.md:158`）；随后读 settings 决定初始 active（校验存在且未归档，否则回退 DEFAULT）。

### 5.2 切换协议（flush → epoch 递增 → 绑定校验）

**前端（先于 IPC）：**

1. `flushEditorBuffers()`（`editorBuffers.ts:20-27`）——输入法缓冲落值。
2. `flushDraft()`（`useNativeResumePersistence.ts:119-132`）——`serializePersistAction` 串行队列（:43-49）内完成保存命令；失败（含 conflict）→ **阻止切换**，UI 保持原文档并显示既有失败标签。这满足计划"保存失败保留内容并阻止切换"（`NEXT_MAJOR_VERSION_PLAN.md:160`）。
3. `nativeClient.flush()`（`NativeDocumentClient.ts:223-228`）等待命令 tail 排空且 `saveStatus != "failed"`。
4. 调 `switch_active_document`。

**宿主（`switch_active_document` handler）：**

1. 读 `ActiveDocumentHost`，校验 `request.expected_epoch == current.epoch`（不符 → `Conflict`，双窗口/竞态防护）；`expected_current_id` 一致性校验。
2. `store.load_active_document(&request.target_document_id)`（`drafts.rs:4-26`）——目标必须存在且有草稿/头快照；已归档文档拒绝直接切换（先恢复）。
3. epoch += 1；更新 `ActiveDocumentHost` 与 settings。
4. 返回 `SwitchActiveDocumentResult`（含目标 cursor/document/meta/新 epoch）。

**前端（响应后）：**

5. `NativeDocumentClient` 新增 `switchDocument(request)`：复用 tail 串行；`epoch = ++this.sessionEpoch` **在发出前递增**（与 `switchEditingContext` :123 同模式），使一切在途响应立刻过期（:127-129、:237、:287 的既有 epoch 检查全部自动生效）；响应经 `validateState`（:329-337，已校验 cursor.documentId == document.documentId）后替换 `current`。
6. `sessionEpoch` 语义扩展：文档切换与来源上下文切换共用同一计数器（现状已是如此，`switch_editing_context` 路径 :123）。

### 5.3 保存排队捕获完整身份（保留现状 + 收紧）

- 前端：`submit` 在队列内从 `this.current.cursor` 构造完整 envelope（`NativeDocumentClient.ts:159-171`）——切换后 `current` 已指向新文档，旧命令不可能再入队；epoch 机制使旧响应被丢弃而非覆盖 `current`。
- 宿主：`apply_command` 存储层 CAS（`drafts.rs:426-457` 权威校验 + :488-502 行级 CAS）保证即使恶意/迟到 envelope 携带旧文档 ID 也只会命中旧文档或被 `Stale authority cursor` 拒绝；宿主层再叠加 §5.4 的 active 校验，实现"切换后旧页面的保存和提议不得写入新文档"。
- 移除三处 DEFAULT 兜底（§1.3），`current` 为空时 fail-fast，防止静默写默认文档。

### 5.4 迟到写入拒绝点（逐路径列出，全部经 `require_active_document`）

| # | 迟到写入路径 | 校验点 | 时机 |
| --- | --- | --- | --- |
| 1 | **保存**（草稿命令） | `apply_document_command` 入口：`envelope.document_id == active` | IPC 入口（`documents.rs:74`） |
| 2 | **保存重试**（失败信封重放） | 同上；且前端 `retryFailed`（`NativeDocumentClient.ts:179-194`）重放时 envelope 身份不变——若已切文档，宿主直接拒绝，内容保留在 UI 失败态 | IPC 入口 |
| 3 | **提议应用**（`confirm_proposal`/`undo_confirmed_proposal`） | 入口 `request.cursor.document_id == active`；提案本体持久绑定原目标（`agent_proposals.document_id`），宿主拒绝后 UI 提示"返回原目标或重新发起"（计划 §5 `NEXT_MAJOR_VERSION_PLAN.md:162`） | IPC 入口 + 存储层既有 `record.cursor` 校验（`proposals/inbox.rs:335-358`） |
| 4 | **提议生成**（agent 运行中） | 既有：`tool.started` 时 `validate_active_cursor(target_cursor)`（`agent_run.rs:239-252`）→ `stale_target` → 提案不落库（`agent_run.rs:336-337`）；M2 追加：该检查语义升级为"target == 宿主 active"（storage 层校验的是文档内 cursor，宿主层校验文档选择） | 运行中回调 |
| 5 | **导入确认**（`apply_import`） | 入口 `request.cursor.document_id == active` **且** `== import_drafts.target_document_id` | IPC 入口 + 存储层（`imports.rs:203-219` cursor CAS 保留） |
| 6 | **导入进行/草稿流转**（`create_import_draft`） | `target_document_id == active`；草稿绑定列写入后不可变 | IPC 入口 |
| 7 | **fit / preview / export 发起** | 入口 `cursor.document_id == active`；**冻结后不中止**——`run_frozen_render`（`session.rs:157-212`）的 `freeze_export` 已在发起时捕获完整身份+资源租约，切换后照常完成原简历文件（满足"已冻结的导出可以继续完成原简历文件，提示必须标明原目标"，`NEXT_MAJOR_VERSION_PLAN.md:162`）；UI 端 preview 已有"superseded 响应不可替换新 cursor"规则（`docs/public-ipc-contract-v1.md:71-74`） | IPC 入口 |
| 8 | **导出写盘**（`write_export_file`） | 无文档身份（文件交付），不校验 active；产物归属由 UI 提示层标注原目标 | — |
| 9 | **版本操作**（提交/分支/历史载入/删除/替换） | 入口 `cursor.document_id == active`（§3.2 清单） | IPC 入口 |
| 10 | **avatar 资产** | `store_avatar_asset`：cursor == active + unlink 用 `cursor.document_id`（修 `rendering.rs:42`）；`read_avatar_asset` 保持全局 | IPC 入口 |
| 11 | **legacy 迁移** | `commit_legacy_migration` cursor == active；`inspect_legacy_identity_conflicts` target == active | IPC 入口 |
| 12 | **agent 上下文选择**（`agent_selected_context`） | `expected_cursor.document_id == active` | IPC 入口 |
| 13 | **数据库恢复** | `restore_database_backup` 成功 → 宿主 epoch 递增 + active 重读；既有 `AgentRuns.1` generation 检查（`agent_run.rs:77-83`）保留 | 恢复成功路径（`versions.rs:164` 附近追加） |

拒绝错误统一 `ErrorCode::Conflict` + 明确文案（"目标文档已不是当前文档"），`retryable=false`；前端据此引导"返回原目标或重新发起"，不静默丢弃用户内容。

---

## 6. 归档语义与资源回收边界

- **归档是列表层概念**：`documents.archived=1` + `archived_at`。不触碰 `drafts`/`branches`/`commits`/`snapshots`/`editing_contexts`/`agent_proposals`/`import_drafts`；`documents.revision` 不推进。
- **归档不回收共享资源**：资源回收唯一入口是 `collect_unreferenced_resources`（`resource_links.rs:54-57` → `resources.rs:765+`），仅删除无任何 `resource_refs` 引用的资源；归档文档的 draft/snapshot/avatar 引用全部保留，因此其资源不被回收。归档也**不**删除 `resource_refs` 行（`sync_draft_resource_owner` 的删除只发生在草稿内容变化时，`resources.rs:589-643`）。
- **归档文档的提案/运行**：已持久化提案保留（按 `document_id` 归属），恢复后可继续确认；运行中的 agent 不因归档取消（与现状 `cancel_agent_run` 由用户显式触发一致）。
- **恢复**：清 `archived` 标志；若 settings 中的 active 指向它则可直接切换。
- **永久删除不在 M2/M3 范围**（计划 §5：`NEXT_MAJOR_VERSION_PLAN.md:154`），届时才需要"删除对象不得回收其他文档正在使用的资源"的成套设计（计划 §8 `NEXT_MAJOR_VERSION_PLAN.md:213`）；M2 只落实"归档零回收"。

---

## 7. 62 IPC 影响面与兼容策略

- **基线**：62 个命令 = `generate_handler!`（`lib.rs:172-235`）= `NativeIpcCommandName` 62 变体（`contracts/commands.rs:241-304`）= capability `allow-*` 62 项（`src-tauri/capabilities/default.json`）；三处相等由 `tools/verify-contracts.mjs:4-12` 强制。
- **语义收紧（约 20 个）**：从"仅 DEFAULT"到"仅宿主 active"。对现有 UI 零感知（当前只有默认文档，恒为 active）；对第三方/测试直接 invoke 是破坏性收紧——契约文档需在 `docs/public-ipc-contract-v1.md` "Active host contract" 节（:9-45）新增 activeDocument 与 epoch 段落。
- **响应扩展（1 个）**：`document_state` 追加 `meta`/`epoch` 字段（追加字段向后兼容；`ActiveDocumentState` 前端类型同步）。
- **请求破坏性变更（1 个）**：`CreateImportDraftRequest` 新增必填 `target_document_id`。桌面宿主与 webview 同包升级，允许 breaking；`serde(deny_unknown_fields)` 只约束未知字段，新增必填字段使旧 webview 调用被 `Validation` 拒绝——可接受（同包发布不存在旧 webview）。
- **schema 携带项**：全库备份 `DatabaseBackupPayload.schema_version` 为 u32 透传（`contracts/commands.rs:369-380`），18 版库备份在旧版程序上被 `UnsupportedSchema` 拒绝恢复——行为正确，写入发布说明。
- **`replace_version_store`**：保持 graph-only（`docs/public-ipc-contract-v1.md:286-289`），仅把 cursor 校验换成 active；成功后 epoch 递增（版本图被整体替换，等价于一次切换级变更）。
- **不动的 24 个**：偏好、账户、provider、模板目录/活跃度、agent 会话、更新器、剪贴板——无文档身份。

---

## 8. 实施任务分解（依赖排序）

| # | 任务 | 涉及文件 | 验收方式 |
| --- | --- | --- | --- |
| T1 | contracts 类型定稿：§2 全部类型 + `CreateImportDraftRequest.target_document_id`；union 加 11 变体 | `crates/zinecv-contracts/src/documents.rs`（新）、`jobs.rs`（新）、`imports.rs`、`commands.rs`（union）、`lib.rs` 出口 | `cargo test -p zinecv-contracts`；`tools/with-msvc.ps1 bindings` 重新导出；`npm run check`（绑定一致性） |
| T2 | storage v18 迁移 + 多文档存储方法 | `crates/zinecv-storage/src/storage/migrations.rs`（v18）、`schema.rs`（兼容检查）、`drafts.rs`（`list_documents`/`set_document_archived`/`create_document_from` 复制）、`imports.rs`（绑定列读写 + `apply_import` 双校验）、`validation.rs` | `cargo test -p zinecv-storage`：升级/幂等/回滚/绑定回填/归档不改 cursor/复制独立版本图（`storage/tests.rs` 既有模式） |
| T3 | 宿主 activeDocument 状态 + 校验 helper + 现有命令改造（§3.2 全表） | `src-tauri/src/lib.rs`（`ActiveDocumentHost`、setup）、`commands/session.rs`（`require_active_document` 替换 `verify_default_document`）、`commands/{documents,versions,imports,rendering,agent_run,preferences,proposals}.rs` | `verify:contracts` 三处相等（改造不新增命令时已通过）；`session_boundary_tests.rs` 扩展：非 active 文档在每个入口被拒、epoch 不符被拒；`cargo test -p zinecv` |
| T4 | 新增 11 个 IPC handler + capability + 契约文档 | `commands/documents.rs`（文档命令）、`commands/jobs.rs`（新）、`lib.rs`（handler 注册）、`capabilities/default.json`、`docs/public-ipc-contract-v1.md` | `verify:contracts` 62→73 相等；幂等收据测试（`command_receipts` 重放） |
| T5 | 前端切换协议 + 兜底移除 | `src/platform/NativeDocumentClient.ts`（`switchDocument`）、`workspace.ts`、`useNativeResumePersistence.ts:79-81`、`useNativeResumeVersions.ts:171`、`legacyImport.ts:155` | 浏览器单测：切换后旧响应 epoch 拒绝、保存失败阻止切换、`flush` 串行（`tests/browser/` 既有 client 测试模式） |
| T6 | 迁移与隔离验证（M2 出口） | `tests/`（新增 native 隔离场景） | 原生隔离验证：17→18 升级含备份、未来 schema 拒开、备份恢复后 active 回退；迟到写入注入五路径（保存/提议/导入/fit/导出——用 `publication_test_hook` `storage/validation.rs:5-20` 在事务中途制造切换）；升级后默认简历原位可用（保留 document ID、草稿、来源上下文、分支、提交身份——用既有 `imported_source_contexts_keep` 测试类推，`storage/tests/imported_source_contexts_keep.rs`） |

依赖链：T1 → T2 → T3 → T4 → T5 → T6。T2 可与 T1 并行启动（SQL 草案先行）；T3/T4 之间 T3 先行（新命令复用 helper）。M2 完成后 M3（简历工作区 UI）只消费 T4 的命令面，不再动契约。

---

## 9. 风险与开放问题

1. **最大风险：20 个入口的语义收紧遗漏任一即留下串写路径。** 缓解：单一 `require_active_document` helper + `session_boundary_tests.rs` 枚举全部文档类命令的拒绝矩阵 + `verify-contracts` 强制 union/handler/capability 相等；实施 T3 时以 §3.2 表格逐行打勾。
2. **存量 `review_required` 导入草稿的绑定回填**假设升级时只有默认文档（现状成立，`imports.rs:40` 锁死 DEFAULT）；若未来出现其他文档后再次升级，回填语句不得覆盖已有绑定列（v18 是首次引入，安全）。
3. **fit/导出"发起校验 + 在途不中止"** 与"切换阻止"的边界要在 UI 文案中区分：在途产物标明原目标（计划 §5），不因切换取消——避免实现成"导出中锁死切换"造成不必要阻塞。
4. **WASM 侧 `dispatch.rs:9` 常量**未同步——共享核心的多文档 dispatch 属 WASM 独立根工作，留待其自身周期，不阻塞 M2（桌面契约先行）。
5. 开放问题（实施前定稿）：`document_create` 复制路径是否复制隐藏模块与 legacyExtensions（建议：整体复制草稿 JSON，与 `initialize_document` 的 initial commit 一致）；归档文档在 `document_list` 默认排序位置；`settings.active-document-id` 在恢复旧备份（无该 key）时的回退提示文案。
