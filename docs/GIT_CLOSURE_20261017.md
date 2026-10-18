# Git 收口与交接（2026-10-17）

> 2026-10-18 状态同步：本文为2026-10-17的历史Git收口记录，保留原验证边界。后续延后验收已完成，见 `QUALIFICATION_20261018.md`；最新剩余任务见 `../plan.md`。

开发成果与提交完整性修正已固化为 `5026920`，本文件及 `plan.md` 随后一笔提交。继续使用 master，保留既有历史，没有配置远程或推送。

## 变更边界

第一笔包含此前 90 项未提交开发改动（含 8 个新增文件）、Git 属性/忽略规则、希伯来字体和必需证据。新增属性使三份旧索引字节与工作区不同的许可/模板文件按实际原始字节受控；不修改其内容语义。四份保护文档未改。

契约必需的 15 份历史文件原始合计 131,215 字节，复制到 `docs/evidence/contract-baseline-20261011/`。证据仅调整 fixture/sourceEvidence 引用并附来源说明，修订、哈希、coverage 和历史 provenance/legacy 引用保留。`origins.json` 记录原始路径、字节数和 SHA-256；原件仍在忽略目录。七行矩阵只迁移证据路径，不修改状态。未把 partial_unreviewed 历史材料提升为完整或当前源码验收。

## 本轮实际验证

- 日常五项全部执行通过：check:ts、verify:contracts、verify:fixtures、verify:licenses、test:unit（74/74）。记录：`.artifacts/verification-runs/2026-10-17T14-09-52-735Z-23760/run.json`。
- 从第一笔对应暂存树导出临时目录，契约检查找到全部必需证据；52 required + 4 supplemental、56 IPC 名称校验通过。导出副本 fixture 19 文件检查通过；92 份许可/fixture/字体/OCR/证据/锁文件资源逐字节匹配，所有证据 fixture/sourceEvidence SHA-256 匹配。
- 导出目录未安装依赖，许可生成器独立执行需先 npm ci；本轮许可检查在保留的开发依赖上实际通过，未把缺依赖的导出检查标为通过。
- 四份保护文档与原 HEAD 一致；六份技能文件均在树内；没有已跟踪但被忽略的文件。凭据模式仅命中 webview.test.mjs 三处本地模拟模型的固定假令牌，经上下文核对不是真实凭据。
- Git fsck exit 0；存在历史/暂存产生的 dangling 对象，无对象损坏，不删除历史对象。缓存、用户数据、私人会话、分析生成物均不提交。

## 三工具同步与影响范围

- Archify：92 个选定来源哈希刷新；当前架构拓扑未变，current.archify.json 验证/生成 9/9、零错误零警告。图形交付证明确定性产物校验，本轮未重做浏览器视觉验收。
- AST-grep：12 项只读结构查询完成，更新 `.artifacts/analysis/ast-grep.json`。
- GitNexus：ZineCV（D:\Desktop\ZineCV），重建 471 文件、9,353 节点、27,098 边、749 流程。完整 detect_changes 报告覆盖 108 个有语义差异的文件、307 符号、53 流程，CRITICAL；另外三份只改变原始换行字节的文件已由资源字节核对覆盖。全部 8 个原新增文件已暂存；纯资源/脚本不强求都有符号节点。
- detect_changes 无 partial/truncated 或查询失败。默认全库流程提取有入口/分支/深度预算限制，因此另外导出全部 5,005 条 CALLS 边并计数核对，以无深度/分支预算的去重遍历补齐变更符号上游/下游可达性：389/871 节点，partial=false、truncated=false、queryFailures=0。完整变更报告没有遗留被截断的调用可达性查询；默认流程目录仍是抽样导航，跨语言/动态调用缺边仍不可据此排除风险。

分析记录保存在忽略目录：`.artifacts/maintenance/git-closure-20261017/git-close-graph.json`、`git-close-exhaustive.json`、`git-close-index-result.json`、`git-close-tree.json`、`git-close-arch-validate.json`、`git-close-arch-deliver.json`、`git-close-ast.log`。未将生成物变成产品依赖。

## 未证范围

本轮没有重跑原生专项，也没有复用未证明输入匹配的历史通过。最新源码构建、15 阶段回归、完整资格、WASM/Browser 对照、打包和原预算长测继续待办。人工/外部资格及非 Windows 平台任务见 plan.md。提交本身不改变产品 API、IPC、数据格式、验收门槛或矩阵通过状态。
