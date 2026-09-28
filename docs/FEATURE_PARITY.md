# ZineCV 2.0 功能与验收矩阵

研究基线：`5b88a9148a793217802955a1eb4b029473e6562a`；整理日期：2026-09-26。

本文件是开发验收清单，**不是已通过的测试报告**。所有2.0状态初始为 pending。实施B00须通过实际操作、源码与已有测试补全遗漏，新增功能行不得被本表44项上限限制。若现有功能尚有缺陷，分别记录“旧版已知问题”和“2.0目标行为”，不能把bug原样照搬当兼容。

证据分为 U（领域/组件）、B（独立浏览器）、N（真实Windows exe/WebView2）、V（固定输入视觉/动效）、M（原生输入/人工辅助技术）、D（隔离磁盘/数据库）、R（真实模型）。mock IPC不能充当N或D，fixture模型不能充当R。

## 全功能清单

| ID  | 既有功能/保护行为                             | 现有入口                                   | 2.0归属                          | 必须验证的场景与证据                                                                                                                   | 批次        |
| --- | --------------------------------------------- | ------------------------------------------ | -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ----------- |
| F01 | 首次空白简历与已保存草稿恢复                  | `App.tsx`、`initial-resume.ts`、持久化hook | shell/domain/storage             | 新profile空白；已有草稿不被默认值覆盖；重启恢复；B/N/D                                                                                 | B00/B05/B06 |
| F02 | 全部基本信息、年龄/生日、头像                 | `BasicInfoEditor.tsx`、`resume-model.ts`   | editor/domain/assets             | 所有BasicInfo字段round-trip；头像添加/替换/移除；中文/长联系方式；U/N/V                                                                | B04/B06     |
| F03 | 十种模块与summary、增删经历                   | `ResumeEditor.tsx`、`useResumeEditing.ts`  | editor/domain                    | 不只实现教育/工作；隐藏再显示保留内容；空条目/最后一条；U/B/N                                                                          | B04/B06     |
| F04 | 模块名、summary标题、简历标题                 | domain/App/editor                          | domain/editor                    | 修改、恢复历史、模板切换；同名不同ID不串数据；U/N/D                                                                                    | B04/B06     |
| F05 | 富文本全部工具                                | `RichEditor.tsx`                           | Tiptap/AST adapter               | 粗体/斜体/下划线/删除线/无序和有序列表/链接/清格式；选区不丢；U/B/N/V                                                                  | B03/B06     |
| F06 | 富文本撤销重做、粘贴与链接弹层                | `RichEditor.tsx`                           | editor local history             | 富/纯文本粘贴、恶意HTML拒绝、链接选区恢复、Esc；历史载入后undo不跨文档；B/N                                                            | B03/B06     |
| F07 | 中文输入法与真实文本编辑                      | rich editor/basic inputs                   | editor buffer                    | 微软拼音候选、回车确认、取消、中文标点、emoji、组合输入后保存；N/M                                                                     | B03/B06/B13 |
| F08 | 模块/经历排序、快速拖拽、折叠                 | editor/AnimatedCollapse                    | editor UI + Move command         | 指针/触控适用路径、快速松手、同帧撤回、边缘滚动、键盘、折叠焦点；B/N/V                                                                 | B03/B06     |
| F09 | 章节导航、复制简历、工具栏操作                | useEditorNavigation/resume-copy/App        | editor/shell                     | 定位正确、复制全文与顺序/换行、原生剪贴板失败提示；B/N                                                                                 | B06         |
| F10 | 左编辑右预览、固定A4、多页                    | preview/pagination                         | Typst+page UI                    | 所有模板1/2/5页、头像/长条目/页尾；210×297mm；无裁切或缺字；U/N/V                                                                      | B02/B07     |
| F11 | 字体、字号、行高、间距、边距                  | layout settings/registry                   | presentation+Typst               | 逐项变化和恢复；现有值单位映射；字号/字重与fallback稳定；U/N/V                                                                         | B02/B07     |
| F12 | 主题、日期、单双行标题、分隔符、对齐          | template-model/preview                     | presentation+Typst               | 控件组合、长日期/职位、两端对齐、列表；保存与导出一致；U/N/V                                                                           | B02/B07     |
| F13 | 智能一页与失败回滚                            | `useResumePagination.ts`                   | fit solver                       | 不改正文/顺序；成功真实1页；不可适配恢复原值；重复启用幂等；U/N/V                                                                      | B02/B07     |
| F14 | 预览缩放、分栏、滚动与全屏                    | ResumePreviewPane/usePaneResize            | shell/preview                    | 原20%–200%范围，指针锚点/连续resize、不同DPR、退出全屏；N/V                                                                            | B06/B07     |
| F15 | 预览点击/键盘定位与模块轮廓；已有纸面选字行为 | PreviewInteractionLayer/预览DOM            | hit regions + overlay/textMap    | Tab/Enter/Esc/hover、跨页条目、相邻框不越界、焦点恢复；B00确认现有选字范围，需要时验收中英跨行/跨页复制、链接、缩放与阅读顺序；U/N/V/M | B00/B02/B07 |
| F16 | PDF导出                                       | `resume-export.ts`                         | Typst PDF                        | 预览同revision/页数/内容；可搜索中英文字；链接/字体/顺序；无overlay；N/V                                                               | B02/B07     |
| F17 | 高清PNG、多页纵向长图                         | `resume-export.ts`                         | raster export                    | 保留默认长图；尺寸/背景/页序；DPI选择；超限/取消/磁盘满；无overlay；N/V                                                                | B07         |
| F18 | 导入PDF原图覆盖与退出覆盖                     | ImportedSourcePreviewOverlay/App           | imported-source view             | 首屏原图、编辑/布局变化退出、重复打开状态、导出语义明确；B/N/V                                                                         | B00/B07/B09 |
| F19 | 三内置模板及density/overrides                 | `templates/registry.ts`                    | template revisions               | legacy/clear/compact；切换不改正文；未知版本保留元数据并提示；U/N/V                                                                    | B07/B08     |
| F20 | 模板收藏、最近使用、命名与删除                | template-library/TemplateWorkspace         | templates/storage                | 状态持久化；同名不同ID；删除不破坏历史模板依赖；N/D/V                                                                                  | B08         |
| F21 | PDF导入与内容映射                             | template-import/recognition                | import adapter                   | 文本、多页、双栏、缺ToUnicode、加密、损坏；段落顺序与人工校正；N/U                                                                     | B09         |
| F22 | DOCX导入、预览和内容识别                      | template-import/renderWord                 | import adapter+isolated renderer | 表格/列表/文本框/浮图/页眉脚；原图/提取分别验证；HTML消毒；N/V                                                                         | B09         |
| F23 | 图片OCR、离线识别与低置信度                   | template-import/recognition                | OCR adapter                      | 中文/英文、旋转、低清、扫描PDF栅格；低质量告警、不编造事实、取消；N/U                                                                  | B09         |
| F24 | 版本提交、未提交变化、分支创建                | useResumeVersions/version-model            | domain/storage+versions          | 全快照；创建分支生成提交并切换；无变化/空消息按旧契约；U/N/D                                                                           | B05/B08     |
| F25 | 切分支、跳转head、历史载入                    | useResumeVersions                          | domain/storage                   | 未提交改动确认；取消不变；载入历史只改草稿不移动head；N/D                                                                              | B05/B08     |
| F26 | 删除提交/分支与祖先保留                       | version graph helpers/useResumeVersions    | graph operations                 | 默认分支不可删；重接parent/head；其他分支祖先保留；事务失败不半删；U/N/D                                                               | B05/B08     |
| F27 | 历史列表、分支树及图交互                      | VersionControlPanel/BranchTree             | versions UI                      | 列表树同源、节点选择、指针中心缩放、拖动、键盘、空图；N/V                                                                              | B08         |
| F28 | 备份、恢复与版本库替换                        | version-backup/version-storage             | storage/backup UI                | 备份完整、损坏拒绝、旧schema兼容；替换版本库不自动替换当前草稿；U/N/D                                                                  | B05/B08     |
| F29 | 重启恢复、冲突与存储错误                      | server/version-storage                     | SQLite writer                    | 双窗口CAS、权限/磁盘满、强杀、WAL恢复；ack丢失重试不回退状态；draft头像GC后重启保留；错误不视为空库；N/D                               | B05/B13     |
| F30 | 各模板编辑上下文、旧数据迁移                  | useImportedTemplates/persistence           | drafts/import mapping            | A来源编辑→B→A→重启草稿不串改；各类数据对账；原包重复/源新增提交/importer升级重导不重复整库；同ID冲突不覆盖；N/D                        | B08/B10     |
| F31 | 本机账户注册、登录、退出                      | local-agent-accounts/AgentOverlay          | identity+UI                      | 旧scrypt兼容、错密限流、切账户清理活动状态、匿名编辑仍可用；U/N/D                                                                      | B10/B11     |
| F32 | provider配置/Key保存/模型建议                 | agent-gateway/AgentOverlay                 | Rust provider/SecretStore        | 新设Key、重启恢复、删除、更换、凭据失效；UI不可读回；本地账户隔离；N/D                                                                 | B11         |
| F33 | 模型能力探测、聊天与流式                      | agent-gateway/stream                       | provider transport               | chat-only/structured、UTF-8跨chunk、多行SSE、断网、超时、取消；U/N/R                                                                   | B11/B12     |
| F34 | Re:me Bot/composer/chat三形态                 | AgentOverlay/CSS                           | agent UI                         | 外观、展开收起、拖动/尺寸/定位、焦点、窗口边缘、缩放；N/V                                                                              | B06/B12     |
| F35 | 三工作区共享会话与会话管理                    | agent/sessions                             | agent runtime/storage/UI         | 切页不重建run、会话切换/持久化、账户归属、消息标题；N/D                                                                                | B12         |
| F36 | 显式引用、同名辨识、上下文预算                | agent/context/skills                       | context builder                  | @基本字段/经历/模块/模板/版本/分支；ID稳定；不发未选联系方式；U/N/R                                                                    | B12         |
| F37 | 本地只读技能与版本比较                        | agent/runtime/skills                       | tool registry                    | 无模型时可用的本地流程仍可用；比较不改草稿；未知工具拒绝；U/N                                                                          | B12         |
| F38 | 改写/删除/模板/保存版本提议                   | agent/types/App proposal handlers          | Rust proposal transaction        | before/revision/branch/HEAD一致、用户确认、拒绝、多条原子、重复确认幂等；U/N/D/R                                                       | B12         |
| F39 | 撤回、取消、预算、迟到结果保护                | runtime/App undo                           | runtime/domain                   | after值冲突拒绝撤回；run取消迟到不写；6/12等预算；切页target不变；U/N/R                                                                | B12         |
| F40 | 隐私、会话/账户/Key迁移                       | storage/context/accounts                   | migration+security               | 原JSON字节不变；账户/会话/Key状态分别报告；DPAPI密文跨机不可解密时保留配置提示重输；不上传全库，不公开真实fixture；N/D                 | B10/B11/B14 |
| F41 | 减少动态效果、动画中断与拖拽反馈              | motion/AnimatedCollapse                    | motion policy                    | 系统开关、WAAPI显式关闭/调整、快速切换、不影响正文；N/V/M                                                                              | B03/B06/B13 |
| F42 | 弹层、键盘、焦点与窗口适配                    | overlays/menu-keyboard/styles              | shell/a11y                       | Tab循环/Esc/外部点击/焦点恢复、可读对比、滚动边界、不同DPI；B/N/M/V                                                                    | B06/B13     |
| F43 | 本地存储状态及原生文件交互                    | storage/notice/export                      | shell/platform                   | 不把缓存叫文件保存；对话框取消无写；中文路径/文件被占用/磁盘满；N/D                                                                    | B01/B06/B14 |
| F44 | 完整视觉、许可、空白公开示例                  | styles/fonts/maintenance-status            | visual/release gates             | 固定同输入对比UI及A4；无个人数据/未授权素材；历史失败保留；V/N                                                                         | B00/B13/B14 |

## 必须新增的桌面产品验收

这些不是声称旧版本已有的功能，而是让2.0真正能分发所需的新能力。

| ID  | 新验收             | 完成证据                                                                                                                    | 批次        |
| --- | ------------------ | --------------------------------------------------------------------------------------------------------------------------- | ----------- |
| D01 | 无开发环境安装     | 干净Win10/Win11，没有Node/Rust/Typst/SQLite，安装并运行                                                                     | B01/B14     |
| D02 | WebView2在线与离线 | 无Runtime在线安装；断网离线安装后首次运行/模板/OCR可用                                                                      | B14         |
| D03 | 包内资源与字体     | 资源manifest/hash/许可；无CDN依赖；缺资源给明确错误                                                                         | B02/B09/B14 |
| D04 | 安装/卸载生命周期  | 非管理员、中文路径、升级保留数据、卸载默认保留用户数据                                                                      | B14         |
| D05 | 签名、更新与回退   | Windows签名/更新签名分别验证，坏签名拒绝，数据库兼容回退实测                                                                | B14         |
| D06 | 进程与权限         | 安装目录worker启动、父进程退出清理、超时/内存上限、旧generation拒收、升级无旧worker、未授权窗口IPC拒绝、生产无测试debug入口 | B02/B11/B14 |
| D07 | 可搜索PDF          | CJK/英文全文提取、文字复制、链接与结构标签；非截图PDF                                                                       | B07/B13     |
| D08 | 可重复交付         | 干净克隆/锁文件/CI/产物hash/安装说明可由另一执行者复现                                                                      | B15         |

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
