# 功能与验收规则

功能要求、入口、归属、批次、状态和证据只维护在[机器矩阵](feature-parity.json)，不再复制52行表格。F01–F44、D01–D08保留52项契约标识，新增项使用明确的supplemental ID；当前执行门禁按下方范围备忘判定，移出部分不重标为passed。

矩阵schemaVersion 2使用contexts共享revision/environment，features保存逐行要求和contextRef；通过tools/acceptance-matrix.mjs的decodeFeatureMatrix读取、encodeFeatureMatrix写回。兼容旧数组输入，写回保持共享上下文。F类要求在acceptance字段；D类旧记录的验收要求仍在legacyEntry字段，不将空acceptance视为无要求。

历史批次schemaVersion 2使用recordDefaults和checks共享重复事实，records中的checkRefs按原顺序展开；decodeEvidenceBundle/encodeEvidenceBundle保证内容往返一致。证据路径使用records.json#featureId。七份原baseline记录已归并为一个records.json，原始manifest及每条记录的结论、来源与日期保留。未来bind-acceptance-evidence同样只写一份记录集，不再生成每项一份JSON。

当前状态见[SLICE](SLICE_20261002.md)，历史结果见[HISTORY](HISTORY_202610.md#qualification)。本文件是验收方法，不是通过报告。局部检查、历史批次和新修订的整行验收分别记录。

证据类型：U领域/组件、B独立浏览器、N真实Windows/WebView2、V视觉/动效、M人工输入与辅助技术、D隔离磁盘/数据库、R真实模型。mock不替代N/D，fixture模型不替代R。

固定哈希门禁已解除。夹具以生成规则和语义校验为准，摘要只标识实际输入；证据检查校验记录、路径和成功结果，不把旧摘要与当前文件强行匹配。输入变化后是否需要复验取决于实际影响，不能继承旧通过或自动升级矩阵。


<a id="scope-notes"></a>
## 范围备忘

2026-10-22用户要求暂移出当前契约门禁：F07/F08/F15/F33/F36/F38/F39/F40/F41/F42/D08的真人输入/设备、真实模型、跨账户DPAPI及独立复核/远程CI剩余验收；Browser全兼容性、其他平台完整宿主不列当前待办。自动更新器已于2026-10-24重新纳入优化接力并实现本地闭环；生产更新源、生产签名及正式交付仍未完成，见 plan。VM/外部测试机、代码及更新签名要求已取消。只在本段保留范围备忘，未经用户重新纳入不执行或等待材料；已实现产品行为与自动回归保留。机器矩阵11条旧pending标记`pendingAcceptanceScope: parked`，保留原ID、状态与证据供追溯，既不阻塞当前任务，也不等于通过；历史证据不追改。

2026-10-23用户明确停止处理PERF01内存增长：固定负载平台期仍未通过，保留未解决结论；不再安排定位、重建或长测，未经重新授权不恢复为待办。按钮监听器生命周期修复已入本地提交`a6ce1eb`，浏览器专项通过，已于2026-10-24构建进release并通过[局部自动专项](evidence/development-baseline-20261024.json)，但未完成修复后三轮内存资格，不据此宣称内存平台期或无泄漏；[实际诊断与局部修复证据](evidence/maintenance-20261022/perf01-button-listeners-20261023.json)保留，机器矩阵45 passed/11 pending不变。

## 最小场景组合

基础fixture至少包含：空白；短1页；恰好页尾；刚超1页；2页；5页；全部十模块；长经历跨页；头像；CJK/Latin/emoji/长URL；每个富文本mark和嵌套列表；隐藏模块有内容；同名不同ID；旧未知模板；1000提交分支图。数据全部虚构，固定时间与随机种子。

模板至少覆盖三内置版式×三density，并对布局参数做边界/代表性交叉，避免无价值全笛卡尔积。页面几何在1440×900、1920×1080及最小支持窗口检查；DPI100/125/150/200%、20/100/200%预览缩放做代表性组合，跨页命中和导出再跑极值。

迁移fixture包含浏览器全包、只有版本JSON、主损坏备份有效、同ID不同内容、同内容不同提交、缺图片、未来schema、损坏账户、凭据不可解密、不同账户会话。每类记录源hash、实体计数、关系检查、字段映射/未知项、重复执行结果与事务中断点。

导入质量逐字段/逐段落标注golden：保留字符率、顺序正确率、字段映射、图片覆盖和不支持项。不要只用单一OCR置信分数证明质量；引擎A/B须同输入、同资源/线程预算。当前不支持的文档特性明确提示，不编造恢复结果。

模型协议的本地合成服务覆盖聊天、structured提议、拒绝/冲突、取消、错误返回与确认后重启恢复；测试凭据和合成输入不进入真实用户库。

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

最终检查当前执行范围内的F01–F44、D01–D08与新增补充项，范围内pending/failed/blocked不能标完成。`parked`只移出当前执行门禁，不删行、不改历史状态，不可据此宣称全部56行100%通过。
