# B04 领域契约进展证据

状态：`in_progress`。Rust 权威模块为 `src-tauri/src/domain.rs`；TS 绑定由 `ts-rs` 12 导出到 `src-tauri/src/domain/bindings/`。当前实现只覆盖正式契约的第一批类型与命令，不能替换 B02 的 `poc-contract-v1` 用于全部样片，也不能宣称 B04 完成。

已固定并测试：

- `ResumeDocument` schema 2：BasicInfo、Inline/RichBlock、Entry、Entry/Summary Section、Presentation、SourceRef、legacyExtensions。
- canonical hash：对文档和命令 envelope 做 serde JSON 序列化后 SHA-256；测试覆盖 round-trip 稳定性。
- 校验：文档/分区/条目 ID 必填且唯一、富文本嵌套上限、链接协议白名单、标题非空。
- 命令第一批：SetDocumentTitle、RenameSection、SetSectionVisibility、MoveSection、SetEntryBody、SetSummaryBody、UpdateEntryFields、AddEntry、DeleteEntry、MoveEntry、UpdateBasic、SetLayout。SetSummaryBody 只允许改指定 summary 模块，富文本仍走领域校验；错指向经历模块会拒绝且不改变文档与修订号。
- 执行器：actor/context 非空、revision/CAS、commandId 同请求幂等返回原 receipt、同 ID 不同请求返回 CONFLICT、成功后 revision 单调递增；可从持久化 authority 恢复 revision/branch/head。
- 绑定：25 个 TS 文件导出，`ResumeDocument.ts` strict TypeScript 编译通过。

验证：

- `npm run check:native`：退出码 0。
- `npm run test:native`：退出码 0，29 tests passed。
- `npm run test:bindings`：Rust 导出测试退出码 0；随后脚本检查绑定无 git drift，并用 strict TypeScript 编译全部绑定。首次运行在绑定目录提交前会正确拒绝未跟踪文件。
- SetSummaryBody 补证：领域测试覆盖中文正文、错误模块目标；SQLite 测试覆盖重新读取和同 commandId 重试。`npm run test:native` 73 tests passed。正式编辑器尚未接入此命令。
- 旧版字段补证：`UpdateEntryFields` 已加入 `college`、`mode`，空字符串清除可选值；`UpdateBasic` 允许将姓名清空，与旧版空白草稿一致。领域测试覆盖写入/清除与修订号，SQLite 测试覆盖重新读取；`npm run test:native` 76 tests、`npm run check:native` 和桌面 `npm run build` 通过。生成的 `DomainCommand.ts` 同步新增字段。正式 React 编辑器仍未接入这些命令。

剩余：

- 缺少 CommitVersion、CreateBranch、SwitchBranch、LoadCommitToDraft、DeleteCommit、DeleteBranch、ReplaceVersionStore、ConfirmProposal、UndoConfirmedProposal、ApplyTemplate、ApplyImport。
- SQLite 侧已增加单连接持久化命令路径，但还没有多窗口 CAS、账户 epoch、并发写者隔离和完整权限作用域。
- TS 绑定尚未接入 UI，也没有“UI 测试替身与真实 Rust 同契约”的完整证明。
- canonical hash 还需交叉金样、迁移输入差异报告和 schema 拒绝策略。
