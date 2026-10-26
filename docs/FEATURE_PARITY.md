# 功能与证据规则

[feature-parity.json](feature-parity.json) 保存52项必需契约（F01–F44、D01–D08）及补充项，供自动检查使用；不重复维护功能表。类型、实现入口和自动测试能力保留。

<a id="scope-notes"></a>
## 测试归属

人工体验由用户自行测试，不维护人工验收待办或等待材料清单。矩阵中的 `acceptanceOwner: user` 表示该归属；历史状态保留原值，不改成虚假通过，也不作为 Agent 活动任务。当前 Agent 任务只见 [plan](../plan.md)。

## 数据格式

- 矩阵 schemaVersion 2：`contexts` 共享 revision/environment，`features` 保存场景。统一用 `tools/acceptance-matrix.mjs` 的 decodeFeatureMatrix/encodeFeatureMatrix 读取和写回；D 类旧要求在 legacyEntry。
- 历史证据 schemaVersion 2：`recordDefaults/checks/records` 与 checkRefs 共享事实，使用 decodeEvidenceBundle/encodeEvidenceBundle 展开；引用形式为 `records.json#featureId`。
- 检查记录绑定实际修订、输入、环境、命令和退出码；局部检查与完整链分开，历史结果不自动升级。旧摘要不冻结当前文件。
- 夹具由 `fixtures/remaining.mjs` 生成，保留空白/长文、多语言与富文本、模板/密度、版本图、迁移/恢复、导入/OCR和模型协议场景；覆盖规则与限额以生成器、测试和唯一阶段表为准。
- 数据和 WebView2 测试使用隔离合成输入；不公开真实简历、Key 或 profile。检查方法与入口见[开发指南](DEVELOPMENT_FEEDBACK.md)。
