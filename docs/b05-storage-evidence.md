# B05 SQLite 基础进展证据

状态：`in_progress`。实现入口为 `src-tauri/src/storage.rs`，数据库使用 `rusqlite` 0.40.2 的 bundled SQLite。测试只使用内存库和系统临时目录文件库，未使用用户 `.data`、原工作区或正在使用的 5173 页面。

已验证：

- migration v1 建立文档、editing context、branch、draft、immutable snapshot、commit、visible commit link、resource、resource reference 和 command receipt 表；migration 记录版本与 SHA-256 checksum。
- 连接开启 `foreign_keys`、WAL、`synchronous=FULL`、`busy_timeout=5000` 和内存 temp store。
- `save_draft`/`load_draft` round-trip 使用 Rust domain canonical hash。
- `Store::apply_command` 先查持久 receipt，再读取 document/branch/head 和草稿或头快照；成功后在同一事务更新 revision、草稿并写入 receipt。同 ID 同请求返回原 receipt，同 ID 不同请求拒绝。
- 打开数据库前先执行 `PRAGMA integrity_check`，`NotADatabase` / `DatabaseCorrupt` 映射为 `Corrupt`。
- 恢复备份前先对备份源执行完整 SQLite Online Backup API 前的 `integrity_check`；损坏备份拒绝且当前库保持不变。有效备份复制后恢复会重设外键/WAL/FULL/busy timeout。恢复后外键/WAL/FULL/busy timeout 重新设置。测试验证先备份、再写入第二个文档、恢复后旧草稿仍在且新草稿消失。
- 同一内容提交两次产生两个 commit 身份，但只产生一个 snapshot；每次提交记录可见父链并在提交后清掉该 context/branch 的 draft。
- 资源以 BLOB 存储，写入前核对 SHA-256；有 draft 引用时 GC 不清理，删除引用后 GC 清理。
- 真实临时文件库完成迁移、写入和读取；测试后删除 db/WAL/SHM。
- 两个独立文件库连接同时打开同一数据库；第一个写入后，第二个使用旧 revision 返回 CONFLICT，使用新 revision 才能成功。
- 新文档的默认 branch ID 与 commit ID 按 document ID 区分，第二文档可独立初始化、存草稿与提交；旧 SQLite v1 的 `main` branch 仍按原 ID 读写，且能与新文档共存。`npm run test:native` 45 tests passed；尚未进行正式多文档 UI 验收。
- 打开数据库与恢复备份前校验迁移版本、checksum 和必要表；高于程序支持版本的 schema 拒绝打开，且测试中源库字节未变。恢复源以只读模式打开，缺失路径不会生成空库；无迁移记录、记录为空或缺少必要表的备份都在覆盖当前库之前拒绝，当前草稿保留。当前 `npm run test:native` 48 tests passed，release 构建及隔离 WebView2 测试通过，默认 AppData 数据库主文件/WAL/SHM 测试前后哈希未变。
- 对照旧版首次建立“初始版本”的行为，新文档初始化时同步建立主分支基线；无 head 的既有文档在首次创建分支时补基线，避免默认分支变成空入口。新建分支使用立即事务检查 cursor、名称、草稿 hash，提交当前内容并切换；旧分支 head 保留，新提交的可见 parent 指向旧 head，冲突失败不写入。`npm run test:native` 50 tests passed，旧版 `npm run test:versions`、release 构建和隔离 WebView2 测试通过。当前只是存储层动作，切分支、历史载入、删除重接、正式 UI 与 F24–F29 验收仍未完成。
- 新增 `Store::switch_branch`：同一立即事务中检查 cursor、当前/目标 head、草稿与快照 hash，未提交改动只有显式确认后才会被丢弃；目标分支若存在不同于 head 的待保存草稿则拒绝，以免误删。切换后文档标题和修订号同步更新，已提交内容往返可读，过期 cursor 不生效。`npm run test:native` 53 tests、旧版 `npm run test:versions` 通过；桌面正式版本 UI 尚未调用此方法，F25 不算通过。
- 新增 `Store::load_commit_into_draft`：只有确认且 cursor 新鲜时，才从所属文档的指定提交载入并校验快照；更新工作草稿与文档修订，不移动分支 head。真实临时 SQLite 文件库的关闭重开验证草稿留存，随后再提交的可见 parent 仍指向载入前的 head；跨文档提交被拒绝。`npm run test:native` 55 tests、旧版 `npm run test:versions` 通过；正式 UI/WebView2 尚未接线，F25 仍待验收。
- 版本提交改为 `commit_draft(expected_cursor, message)`：立即事务内核对活动文档/上下文/分支/head/草稿修订，空说明及内容无变化时拒绝；使用随机提交 ID 避免将来删除后按计数重用身份，成功后递增权威修订。创建新分支可产生与已有提交同内容但不同身份的提交，snapshot 仍共享。`npm run test:native` 56 tests 和旧版 `npm run test:versions` 通过；正式 UI 尚未接线，F24 与 F26 仍待验收。
- `delete_commit(expected_cursor, commit_id, confirmed)` 使用立即事务重接子节点 parent 和所有分支 head；删除当前 head 前保留正在编辑的正文为草稿，已有草稿同步 revision。取消、跨文档、过期 cursor 均不删除。`npm run test:native` 58 tests、旧版 `npm run test:versions` 通过；分支删除及被删来源标记、正式 UI 尚未实现，F26 仍 pending。
- migration v2 增加 `branch_tombstones`，分支来源行保留供祖先提交外键引用。`delete_branch` 保护默认分支，墓碑化目标，删除只属于该分支的不可达提交；其他分支祖先可达时保留且可通过墓碑识别已删除来源。删除当前分支切回主分支并恢复其已提交正文，删除其他分支保留当前草稿；文件库关闭重开后仍拒绝切入墓碑。旧 v1 备份先在内存暂存库迁移，再复制到当前库；原备份不变。`npm run test:native` 62 tests、旧版 `npm run test:versions`、release 构建和隔离 WebView2 smoke 均通过。正式版本 UI 与双窗口删除验收仍待完成，F26 pending。
- `load_version_graph` 在一项只读 SQLite 事务中取得 cursor、活动分支和完整提交关系；保留祖先的来源墓碑转换为 `originDeleted`，缺失提交 link 报错。TS 绑定由 Rust 生成，Tauri `version_graph` 命令在独立 WebView2 profile 中读到初始 1 分支/1 提交。`npm run test:native` 66 tests、`npm run test:browser`、release 构建及 `npm run test:webview` 通过；这仍是只读契约与样片，正式版本界面未完成。
- SQLite 错误注入覆盖提交的 snapshot、commit、visible link、branch head、draft 删除、document revision 六个写入边界，以及领域命令的 draft 与 receipt 两个边界。每次由临时 trigger 中止写入，验证草稿、head、revision、commit/snapshot 数量或 receipt 保持原状；移除 trigger 后同一请求或 cursor 可重试成功。`npm run test:native` 68 tests、旧版 `npm run test:versions` 通过。该检查只证明 SQLite 事务回滚，不模拟磁盘满、权限拒绝、进程强杀或掉电。
- `backup_to` 不再直接写目标文件：先在目标同目录独占创建暂存库，用 SQLite Online Backup API 完整复制，再检查完整性/schema、同步文件并发布。若目标已存在则明确拒绝覆盖，避免中途失败破坏上一份备份。隔离目录用例确认首次备份可读、源库改动后原备份字节不变、新路径备份包含新标题、无残留暂存文件；`npm run test:native` 69 tests 通过。覆盖既有备份的产品交互仍需定义，当前接口要求使用新路径；这不证明掉电时目录项持久性或真实备份并发安全。
- 并发备份补证：两个独立文件库连接共享 WAL 数据库，一方在未提交事务中同时修改文档标题和资源表，另一方调用 `backup_to`。只读检查备份的 `integrity_check` 与标题/资源组合，结果只能是完整旧状态或完整新状态；`npm run test:native` 70 tests 通过。这是单次受控并发写入，不覆盖连续写入饥饿、长期锁等待或进程崩溃。
- `npm run check:native` 和 `npm run test:native`（backup/restore 与 CAS 加入后）退出码 0，38 tests passed。

当前限制：

- `documents.current_branch_id` 到 `branches(id)` 没有外键，因为 document/branch 初始插入存在循环依赖；分支表的 `document_id` 外键保留，该值属于应用层不变量，后续需要用 deferred FK 或重构迁移补强。
- 备份路径校验、连续写入下的备份并发与长期锁等待、多连接读写池、两窗口并发 CAS、磁盘满/权限/kill 故障注入、版本删除的持久化与完整 UI 验收、template revisions、imports/legacy map、账户/Provider/Agent 表。当前注入只覆盖 SQLite 报错，不应算作这些环境故障通过。
- 尚未迁移旧版 `localStorage` 或 `.data/versions.json`；本批不是 B05 完成，F24–F29 保持 pending。
