# ZineCV 当前进度与剩余任务

核对日期：2026-10-24；当前 HEAD 为 `a0e98c9`，优化接力产品改动尚未提交；历史产品基线为 `d808bd8`。当前状态以[SLICE](docs/SLICE_20261002.md)和[Windows复核](docs/evidence/windows-closeout-20261022/review.json)为准。本文件是唯一活动待办，不从旧会话todo或忽略目录的旧状态文件恢复任务。当前授权（2026-10-24 第二轮）：完成正式产物同步、线上更新、全仓审查、独立复核补验、Git 收口与发布；版本推进 2.0.0-alpha.1。

## 五项收口实施（2026-10-24，当前授权）

phase=五项收口执行；owner=ZCode GLM-5.3；status=审查与修复完成，进入构建/提交/发布/e2e。用户已明确授权完成正式产物同步、线上更新、全仓逐行审查、独立复核/补验、Git 收口及发布；此前“未授权提交/发布”只描述上一轮边界。本轮保留所有 GLM 成果与有效开发缓存。

- [x] 全仓手写代码覆盖收口：中断会话 audit（platform 44+rust 风险模块）+ 独立审查 Agent（agent/preview 15 文件）+ 主线程逐行（tauri-rest 13、contracts、versioning/templates 5）+ 15 个修改文件全量 diff 复核；updater 4 项缺陷（RUST-UPD-01..04）已修复并有回归；F-AP-01 等 3 项新修复。剩余缺口如实记录：styles（纯 CSS、未修改）与部分 tools/tests 清单级。记录在 .artifacts/analysis/final-audit-20261024/。
- [x] 生产签名密钥（DPAPI 口令保护、仓库外）+ 生产公钥嵌入 tauri.conf.json + GitHub HTTPS 更新源 + release-windows.ps1 可复现构建/签名/收据链。
- [x] 多页 OCR 复用已有断言（local-ocr-assets 3/3）；Agent IPC 补验（webview-agent-ui）与正式构建/收据执行中。
- [ ] 生产签名包在线检查/下载/安装/重启与数据保留闭环（发布后执行）。
- [ ] 本地提交、推送 master→main（快进）、gh 预发布 v2.0.0-alpha.1 与最终清理（执行中）。

已核实：本地原先无 remote；GitHub 的 StarryCode-Lang/ZineCV 是同项目旧 React 0.1.0 仓库（无 releases）。本轮已添加 origin 并 fetch main，不强推、不丢弃远端历史。三个独立审查 Agent 分管前端、原生、工具/测试；主 Agent负责集成、生产配置、构建与串行验证。新增审查结果在 .artifacts/analysis/final-audit-20261024/，最终有效结论归并到现有受控记录。

## 自动更新与优化接力：核对结论（2026-10-24）

phase=收口核对；owner=Codex；status=核对与主体清理完成，末批临时文件删除被自动审批拦截。源码成果保留，当前任务不新增产品功能、不提交、不推送、不发布。原始四轮记录、逐项处置理由与本轮纠正统一见[受控记录](docs/evidence/optimization-20261024.json)。

| 阶段 | 实际模型 | 已完成范围与边界 |
| --- | --- | --- |
| F1 | GLM-5.3-Flash | 重点源码逐行审查、68 个 UI 文件审查与全仓盘点；其他部分仅抽查/清单检查，不能认定完成全仓逐行审查 |
| G1 | GLM-5.3 | 自动更新器全栈、62 IPC、G1-1…10、真实隔离 A→B 更新；后续缺陷由 F2/G2 修复 |
| F2 | GLM-5.3-Flash | delta 持久化聚合、OCR worker 复用、确定性优化、updater 独立复核及负面测试；check 热态中位 10.82→8.98 秒；低收益候选明确存档 |
| G2 | GLM-5.3 | 安装前哈希复核、并发 gate、安装失败回退、版本绑定签名、hooks 构建限制、导出收束；隔离更新主链和负面路径通过。独立复核未成功，主 Agent 自查替代 |

### 尚未完成或未取得证据

- [ ] 正式发布产物同步：最新 A/B 安装器为 UpdTest 测试版，正式 alpha.0 安装器未重建。当前 `target/release/zinecv-desktop.exe` 实际也是 **UpdTest alpha.2**，与正式构建收据不匹配；不能当作最新正式 EXE。后续正式交付需正确配置下重新构建并生成有效收据。
- [ ] 线上自动更新：缺生产 HTTPS 更新源、生产签名密钥/公钥与编译期配置，尚无生产签名、上线及线上安装闭环。版本绑定签名已强制，旧无版本注释签名不能使用。
- [ ] 全仓逐文件/逐有效行审查：尚无完整覆盖证明。F1 对 migration/proposals/resources/identity 等仅抽查；templates/versioning/styles、部分 platform、tests/tools 的完整审查仍有缺口。
- [ ] 最终独立复核及针对性补验：G2 子 Agent 复核未成功；F2 变更后的真实合成 Agent IPC 专项、多页 OCR 复用尚缺明确重跑证据。既有单元/浏览器/updater 检查不替代这些边界。
- [ ] Git 收口、正式发布：G1/F2/G2 产品改动仍未提交；当前没有新的提交或发布授权。

这些剩余项不阻止使用 `npm run dev` 继续开发。本轮只核对、同步文档和清理，不自动执行正式构建、上线、补全全仓审查或旧完整资格链。PERF01、11 项真人/设备/真实模型等旧资格仍按[范围备忘](docs/FEATURE_PARITY.md#scope-notes)停放；OPT-07、OPT-16 和 S 系列存档候选保留处置理由，不重开为待办。

### 本轮清理与开发能力

当前开发构建已验证缓存全命中，日常检查 5/5（88 单元）通过，隔离真实桌面 UI 和原生保存已通过。仅删除可确认过期的本地编译变体、隔离 profile、可再生图数据库与一次性维护脚本；保留 node_modules、dist、有效 debug/release/hooks 缓存、源码、许可、测试、受控证据、安装器及用户数据。清理后真实桌面启动通过（Cargo 完成约 4.8 秒、没有 Rust 重新编译、原生保存正常）；已删除 88 个目标、约 2.29 GiB 逻辑字节；最后约 1.25 MiB 临时脚本/合并前记录副本因自动审批拒绝而保留，具体清单与体积见同一受控记录，不把历史通过升级为当前完整资格。

## 本轮已完成

- [x] Windows窗口抖动、DPR变化写文档、原生剪贴板占用误报修复。
- [x] 图标替换、项目归属、依赖许可/MPL源码、字体与安装资源交付。
- [x] 当前冻结输入full34、离线23项及助手窗口10项。
- [x] 在线/离线NSIS、中文路径实际安装/更新/兼容DB与备份回退/卸载；真实数据不变。
- [x] standard120秒×3及extended30分钟×3；实际采样、内存趋势和纸面图像复核。
- [x] 功能矩阵逐条证据整理完成；状态保留实际结论，当前执行范围只在FEATURE_PARITY范围备忘维护。

## 历史未完成项：当前版本已解决

以下是会话遗留任务的核对结果，不是本次新运行的测试。共同证据为[full34](docs/evidence/windows-closeout-20261022/full-verifier.json)、[安装链](docs/evidence/windows-closeout-20261022/installation-lifecycle.json)、[复核](docs/evidence/windows-closeout-20261022/review.json)；架构阶段见[C+执行计划](docs/EXECUTION_PLAN_20261006-cplus.md)。

| 历史事项 | 当前结论与边界 |
| --- | --- |
| college/mode/空姓名、React与Rust权威存储接线 | 已实现；正式编辑/持久化及原生回归覆盖，旧前身副本不作为现状 |
| B12 Agent网关、上下文、提议事务、取消 | 本地实现及合成服务专项已完成 |
| P01 worker超时、Job Object限制、崩溃重放 | hooks及真实父子进程专项已完成，不沿用旧会话“只写feature未验证”的状态 |
| C+ contracts/domain/engine/storage/agent抽取与宿主收敛 | Windows核心P1–P5已完成 |
| TextMap、跨页、智能一页、预览几何 | 实现及自动门禁已完成；正式DOM交互预览是当前架构选择，不强制重开旧“默认SVG切换”建议 |
| 保存对话框/导出挂起、concurrent_connections失败 | 当前导出和原生回归已通过；后者在当前native日志第312行为ok，不继续沿用早期环境失败 |
| 窗口/DPR自动写文档、分栏恢复、剪贴板假成功 | 当前修复及专项已完成 |
| full34、在线/离线NSIS、中文路径安装/更新/回退/卸载、两档长测 | 当前同一冻结输入链已完成；更新范围是手动安装器，不是自动更新器 |
| 图标/字体许可、归属、依赖声明/MPL源码、公开合成PDF | 已交付并检查 |
| 固定字节锁、重复文档/夹具/证据、测试目录迁移 | 已改为结构/语义检查并合并；历史缺失raw目录不重建、不追改旧结论 |
| 快速开发、workspace/共享锁、storage与重排版依赖解耦 | 已完成，当时四项构建收据匹配；当前构建状态见2026-10-24受控基线，正式release保留fat LTO |
| Git收口、旧Cargo产物、三工具图/查询生成 | 产品成果已入d808bd8，旧Cargo清理363项约4.69GiB；AST/Archify已复核，GitNexus全文搜索已由本轮完整重建恢复 |

## 本轮处理

当前剩余任务及实际完成边界见上方核对结论。此前授权三项已完成：精简删除2232个目标，22.051→10.395GiB；更新正式EXE并核对当前收据；6项浏览器、2项真实WebView2回归及1项默认DOM预览定位专项通过。重新构建release后约13.00GiB，保留有效开发缓存；[受控基线](docs/evidence/development-baseline-20261024.json)记录准确字节、哈希和验收边界。GitNexus全文搜索修复已完成并实际查询验证。暂不执行事项仅保留在[范围备忘](docs/FEATURE_PARITY.md#scope-notes)，未经用户重新纳入不启动。

## 本轮维护收口

- [x] 逐项核销历史已解决与当前待处理事项；矩阵只收拢执行范围，不改历史通过状态。
- [x] 纠正Windows交接和开发反馈中的过期“未重跑/无收据/图陈旧”描述。
- [x] 退役三份旧活动状态、清理7个临时交接脚本，补分类体积快照；逻辑文件约21.07GiB，保留有效缓存，见`.artifacts/maintenance/history-reconciliation-20261022.json`及`final-closeout-20261022.json`。
- [x] 上轮契约、差异空白、AST与两份Archify检查通过；本轮按实际改动补测，历次提交授权仅限当时任务；本轮仅核对 Git 状态，不提交。

## 进度与上下文纪律

先读AGENTS、SLICE与本文件，再核当前Git和证据修订；会话、模型记忆、工具生成图和旧`.artifacts`状态仅是线索，不能覆盖当前来源。发现冲突先核实，不能把旧pending重新当成未实现，也不能凭旧通过升级当前资格。

每个后续任务在本表更新状态、实际证据和剩余项，必要时同步SLICE/相关契约；当前文档不追加历史流水账。只处理当前授权范围，本地提交按用户授权执行，不推送、不发布。结束前检查差异、移除自有临时文件/过时状态、保留有效缓存与用户数据，并确认Git状态；发现其他Agent改动时保留并核对，不覆盖或一并提交未知改动。

## 下一版本维护起点

普通PowerShell运行`npm run dev`。保留当前有效缓存，Rust修改后正常增量编译。测试范围按实际改动选择，不重复未受影响的完整资格链。后续执行范围以[范围备忘](docs/FEATURE_PARITY.md#scope-notes)及用户新授权为准。
