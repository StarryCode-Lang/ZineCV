# ZineCV 开发与验收历史

本文件集中保存里程碑、验收与清理结论，不再追加开发流水账。当前状态见 [SLICE](SLICE_20261002.md)，待办见 [plan](../plan.md)。历史通过只绑定当时输入，局部复验不能覆盖失败。文中 `.artifacts/` 路径是历史指针。2026-10-20 按用户要求删除本地原始运行目录，避免后续开发 Agent 把旧通过或旧清单读成当前资格；文件已不在磁盘，不可还原，结论与哈希不追改。受控结论只以本文、SLICE 与 `docs/evidence/` 为准。

## 架构与完整链里程碑

2026-10-06定案C+架构，决策/阶段设计保留在`docs/ARCHITECTURE_TARGET_CPLUS.md`、`docs/EXECUTION_PLAN_20261006-cplus.md`。随后抽出contracts/domain/engine/storage/agent/native，106个ts-rs类型零漂移，Store/Agent注入秘密与网络能力，保留IPC、schema17和备份格式。Windows分批34/34非一次全过，见`.artifacts/remaining/cplus-20261007/REPORT.md`。

Browser/WASM实现共享Rust Core、OPFS/Web Lock/WebCrypto/Web fetch与离线PWA；本机平台对照通过不代表所有浏览器。OHOS历史ARM64 core/NAPI编译POC不等于ArkTS/ArkWeb、HAP或真机宿主。记录`.artifacts/remaining/windows-capable-20261007/`，旧截图已清理，报告结论保留。

长内容跨页/五字体/RTL与fit修复记录在`.artifacts/remaining/closure-optimization-20261008/STATE.md`；旧unified-4因字体问题中止extended，不能记长测通过。

`.artifacts/remaining/closure-final-20261011/attempt-9/` **16/16顶层通过**，内含一次**full34/34**（verifier `2026-10-11T06-40-12-921Z-7444`）、WASM/Browser、平台对照12/12、NSIS、standard120秒×3、extended30分钟×3。冻结输入`b6684c272b7d42fd6b2499aaf1c791947c5b9d87+worktree:35cec9f6d08bf1f6f1da13369cc1294d0ef4202b68287631ab717ef1099d244a`；原生318项=宿主26+contracts109+domain9+engine42+storage114+agent18。长测零失败但内存跨轮增长，没有无泄漏或RAM优化结论。attempt-1..8原中间目录按当时指令删除，失败摘要保留。

七条passed更早的原始JSON曾随旧目录删除且无法恢复，后来以attempt-9真实阶段重绑；不能声称原件从未丢失。受控来源现为`docs/evidence/contract-baseline-20261011/`。

后续fit/CAS修复与attempt-4完整16阶段/full34/两档测量通过见`.artifacts/remaining/closure-current-20261012/REPORT.md`；摘要前缀087dc894，完整值查原清单，不覆盖后续产品变化。

2026-10-15—16基本字段/头像/十模块、富文本/历史、经历排序/边缘滚动、3模板×3density×2头像共18版式的预览/PDF/PNG/重启组合通过。根为`.artifacts/remaining/closure-cleanup-20261015/`及`.artifacts/remaining/completion-20261015/`。后续完整attempt-2按用户要求在9/34后中止，318原生通过不等于整轮通过；日常改为轻量和定向验证。

<a id="handoff"></a>
## 独立常用回归

2026-10-17北京时间22:30:22—22:53:56，**15/15**通过：静态四项、unit74、测量工具自身5、Browser23及正式宿主编辑/预览/字体/Agent/持久化等专项，release重建成功。不是full34、318项Rust或真实供应商资格。

HEAD `78d779430910c8cf35309df47be5d9c586ecf875`，输入摘要`2808b5a4f69523812973488a8ebd3fc63b37b394517eb8a126873e849b7ad64a`；观察快照在构建前轻量阶段，非执行前快照。exe 74,535,424字节，SHA-256 `b337f8f1593cff76ea11c533f53912da8177343fe4b75c5880db20845bcddbf8`。受控关联`docs/evidence/current-regression-20261017/records.json`，原运行`.artifacts/verification-runs/2026-10-17T14-30-22-635Z-17200/`。

56行清点归档失效引用与历史说明；七条passed保留历史修订，关联增加不替整行签收。

<a id="git-closure"></a>
## Git收口

收口提交`5026920`、`78d7794`、`f1435c8`，PNG修正`3eb37ac`；保留master，无推送/发布。15份历史证据来源见`docs/evidence/contract-baseline-20261011/origins.json`，不提升partial_unreviewed。

导出树契约/56 IPC/92份资源字节核对通过，缺依赖的许可生成器未记通过；保护文档未改。GitNexus风险CRITICAL，查询完整仍不排除动态/跨语言缺边。证据`.artifacts/maintenance/git-closure-20261017/`。

<a id="png-boundary"></a>
## PNG边界失败与复验

`.artifacts/acceptance-runs/2026-10-17T15-07-59.825Z/`在test:webview-export失败：210段输入只有3页，未达长图降级预算。仅改为350段、实测5页；4～7页断言、32M/64M像素预算、拼接/白底/分页保留、600段拒绝/输入状态保护不变，产品未改。

专项1/1及日常5项、unit74通过，72/192/300 DPI拼接通过。根`.artifacts/remaining/png-boundary-repair-20261018/`、`.artifacts/verification-runs/2026-10-17T23-04-45-344Z-22948/`。File impact UNKNOWN另核实际入口；原失败批次保持失败，新通过另立批次。

<a id="qualification"></a>
## 2026-10-18延后验收

用户批次`.artifacts/acceptance-runs/2026-10-17T23-22-32.766Z/`北京时间07:22:32—10:07:51完成，**16/16顶层exit0**。coverageMode=`remaining-only`，延后19项加共享正式构建依赖共20阶段通过，四个构建阶段经收据复用；WASM、平台参考、Web构建/核心/产品、Native/WASM结构/栅格对照、NSIS通过。

standard各轮约120—121秒，extended约1800—1803秒，均passed，精确耗时查原报告。打包前后原exe SHA-256均为上文完整`b337f8f1…`值。四份源码快照一致：`e8205721d512d294ed6ec93d919dfc5aef1c7d6129dd582865398fd29fd9a8aa`，HEAD `3eb37acb6cee5bdc2cd0c513d2949692620b162b`。

总结/关联为`docs/evidence/remaining-qualification-20261018/qualification-summary.json`、`records.json`，采样原字节存历史归档。此前15阶段是另一冻结输入，明确不导入，**不能相加称一次full34或完整资格**。长测行为不证明无泄漏，PNG失败不覆盖。独立QUALIFICATION报告已并入本节。

<a id="cleanup"></a>
## 清理与存储

2026-10-18清理见`.artifacts/remaining/docs-cleanup-20261018/`；当时PDB不匹配，正式收据不可复用，不撤销历史结果。晚间显式删除构建/依赖/工作台缓存及无关Agent目录。258份相同证据去重233,601,971字节，映射`.artifacts/maintenance/dedup-20261018.json`。

正式exe/PDB/NSIS在`.artifacts/kept-release/`，以SHA256SUMS.txt为准；exe为74,532,864字节、`ce3631cfb9443a6b8c88e3d1b92d287146540043ada62870283efd30dad03ebb`，不同于旧回归exe，不冒充匹配旧收据。

2026-10-19样式合为studio/reference两份，生产CSS前后SHA-256均为`abe24b679611fa94aad22f8193f9bea81f5532ae16a2f685b924c3ff43784d7b`；移除未用Schema/helper、技能统一`.agents/skills`。当时日常5/5、unit74、Browser23/前端构建及后续队列/测量/富文本专项通过。记录`.artifacts/verification-runs/2026-10-19T14-34-31-257Z-7336/`、`.artifacts/analysis/slimming-*.json`；本次文档整合没有构建。

23份大JSON曾无损归档并通过全部哈希校验。随后用户明确要求删除压缩包，已删除该归档及更早的诊断ZIP/压缩采样，原始大样本不再保留；仅保留报告、阶段结论及 `.artifacts/maintenance/discarded-history-data.json` 中的删除清单与原哈希。不以历史摘要替代原始逐样本复核。

2026-10-19改用规则生成夹具，在内存返回原canonical字节，当时以17项原SHA-256核对；2026-10-20已删除固定哈希清单。12份文档、1000提交图和17个人工场景保留；可生成JSON/manifest、未用PNG和生成README已删除，仅保留规则、人工步骤、native参考PNG/metadata及根legacy JSON。历史正文集中本文件，不追改当时验收结论。

2026-10-19体积基线见`.artifacts/maintenance/volume-cleanup-20261019.json`，不包含次日证据树清理。保留源码、许可、正式发布文件；依赖和构建输出按需恢复，调用图查询先重建索引。当时未构建/编译应用、提交、推送或发布，四份设计文档亦未改；2026-10-20已解冻并按职责精简。

本轮结构清理将三组POC测试移入tests/platform并合并重复初始化，原37项断言保留；测量测试归入tests/measurement。29项离线检查、17项夹具原字节校验、102份MJS语法检查通过，320份应用源码与资源未改。原生/浏览器/WASM完整验收未重跑；PDF语义测试因缺pdfjs-dist未执行，不记通过。核对记录见`.artifacts/analysis/content-cleanup-check.json`。

2026-10-20按用户要求解除持久字节冻结：删除夹具/绑定固定SHA清单，清理生成manifest中的过时文档摘要与失效历史入口；许可盘点改为可编辑来源配置与当前扫描，字体参考可替换，历史证据摘要不再锁当前输入。历史记录及结论不追改。随后将矩阵/历史批次的重复环境、修订和检查改为共享上下文，原56行与全部历史检查展开逐项一致，七份baseline记录合一；两份完全相同许可副本已共享，来源映射与正文保留。36项定向离线检查通过，原生视觉、严格TS与Rust重生成未执行，未编译应用。
