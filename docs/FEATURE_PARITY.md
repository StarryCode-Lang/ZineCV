# 功能与验收规则

功能要求、入口、归属、批次、状态和证据只维护在[机器矩阵](feature-parity.json)，不再复制52行表格。F01–F44、D01–D08为52项强制要求，新增项使用明确的supplemental ID；不以原表上限遗漏功能。

矩阵schemaVersion 2使用contexts共享revision/environment，features保存逐行要求和contextRef；通过tools/acceptance-matrix.mjs的decodeFeatureMatrix读取、encodeFeatureMatrix写回。兼容旧数组输入，写回保持共享上下文。F类要求在acceptance字段；D类旧记录的验收要求仍在legacyEntry字段，不将空acceptance视为无要求。

历史批次schemaVersion 2使用recordDefaults和checks共享重复事实，records中的checkRefs按原顺序展开；decodeEvidenceBundle/encodeEvidenceBundle保证内容往返一致。证据路径使用records.json#featureId。七份原baseline记录已归并为一个records.json，原始manifest及每条记录的结论、来源与日期保留。未来bind-acceptance-evidence同样只写一份记录集，不再生成每项一份JSON。

当前状态见[SLICE](SLICE_20261002.md)，历史结果见[HISTORY](HISTORY_202610.md#qualification)。本文件是验收方法，不是通过报告。局部检查、历史批次和新修订的整行验收分别记录。

证据类型：U领域/组件、B独立浏览器、N真实Windows/WebView2、V视觉/动效、M人工输入与辅助技术、D隔离磁盘/数据库、R真实模型。mock不替代N/D，fixture模型不替代R。

固定哈希门禁已解除。夹具以生成规则和语义校验为准，摘要只标识实际输入；证据检查校验记录、路径和成功结果，不把旧摘要与当前文件强行匹配。输入变化后是否需要复验取决于实际影响，不能继承旧通过或自动升级矩阵。


当前范围优先规则：2026-10-21用户范围决定：取消干净虚拟机/外部测试机、代码签名证书及更新签名方案；真实模型测试与独立复核由用户自行负责，Agent不再处理或等待这些材料。保留安装/升级/卸载、更新交付与数据库兼容回退等产品行为，以及许可事项。取消/移交不等于测试通过，历史证据不追改。

## 最小场景组合

基础fixture至少包含：空白；短1页；恰好页尾；刚超1页；2页；5页；全部十模块；长经历跨页；头像；CJK/Latin/emoji/长URL；每个富文本mark和嵌套列表；隐藏模块有内容；同名不同ID；旧未知模板；1000提交分支图。数据全部虚构，固定时间与随机种子。

模板至少覆盖三内置版式×三density，并对布局参数做边界/代表性交叉，避免无价值全笛卡尔积。页面几何在1440×900、1920×1080及最小支持窗口检查；DPI100/125/150/200%、20/100/200%预览缩放做代表性组合，跨页命中和导出再跑极值。

迁移fixture包含浏览器全包、只有版本JSON、主损坏备份有效、同ID不同内容、同内容不同提交、缺图片、未来schema、损坏账户、凭据不可解密、不同账户会话。每类记录源hash、实体计数、关系检查、字段映射/未知项、重复执行结果与事务中断点。

导入质量逐字段/逐段落标注golden：保留字符率、顺序正确率、字段映射、图片覆盖和不支持项。不要只用单一OCR置信分数证明质量；引擎A/B须同输入、同资源/线程预算。当前不支持的文档特性明确提示，不编造恢复结果。

真实模型测试只使用虚构简历，提供者凭据不写fixture。至少覆盖正常聊天、structured提议、拒绝/冲突、取消、错误返回与一次确认写入后重启恢复。离线fixture仍用于多数CI；R列由已授权真实配置补齐。

## 执行证据记录格式

```json
{
  "featureId": "F38",
  "status": "pending",
  "revision": null,
  "implementationPaths": [],
  "tests": [],
  "evidence": [],
  "environment": null,
  "knownBaselineIssues": [],
  "remainingIssues": [],
  "reviewer": null
}
```

test条目必须含命令、退出码、日期、fixture版本与执行环境；截图/录屏记录 viewport/DPR/字体/主题/缩放；数据测试记录隔离目录，真实秘密/简历不入日志。passed绑定代码提交，后续相关修改使其需复验。手工验收记录步骤、观察和验收人，不写“应该没问题”。

最终检查 F01–F44、D01–D08与新增补充项，任一强制项 pending/failed/blocked 都不能标“全部完成”。可以交付明确标识的RC或部分批次，但不得将延期项移出表格以获得100%。
