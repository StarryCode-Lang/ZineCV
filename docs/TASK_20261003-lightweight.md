# ZineCV 极致轻量化任务记录（2026-10-03）

> 本文档是 **2026-10-03「极致轻量化」任务的完整交代**：任务要求、基线口径、实测结果、改动清单、过程中发现并修复的回归、验证矩阵、对抗复核结论、未验证边界与下一步候选。
> 项目**当前状态**仍以 `docs/SLICE_20261002.md` 为唯一权威切片；本文档是任务记录，两者数字必须一致。
> 四份原始依据（`DEVELOPMENT_PLAN.md`、`FEATURE_PARITY.md`、`FEASIBILITY.md`、`target.archify.json`）不修改，另行对照。

---

## 1. 任务与约束

用户下达的任务与硬约束：

| 项 | 内容 |
| --- | --- |
| 目标 | 对项目做**极致轻量化** |
| 功能约束 | **不允许功能性削减**（原话：不允许做功能性削减，要极致轻量化） |
| 覆盖指标 | 发布体积（exe / NSIS 安装器）、磁盘与构建缓存、运行内存/启动、前端 dist 与依赖树 |
| 缓存授权 | 授权全量清空 `src-tauri/target`（回收 19 GB） |
| 项目约定 | 不推送、不发布；本地提交需用户明确授权（本次**未提交、未推送**）；保留已有工作区改动与用户数据 |
| 交付 | 一个文档写清本次任务（即本文档）+ 更新项目文档、删除旧版本文档 |

因此本次只允许四类手段：**去重、构建选项、零拷贝、删除已证明的死资源**。任何削减产品能力、离线能力、许可呈现或验收证据的动作一律不做。

## 2. 基线口径（重要，先读）

**基线 = 2026-10-03 14:36 的未提交工作树，不是 HEAD。**

原因：`git grep RenderFontBytes HEAD`、`git grep fontBundleHash HEAD` 均为零匹配；`src-tauri/src/storage/` 整个模块在 HEAD 中不存在（属未跟踪的在途工作）；`Cargo.toml` 相对 HEAD 的差异还包含 `test-hooks` feature 与 tiny-skia / unicode-bidi / rfd 三个依赖，那些都不是本次轻量化引入的。若按 HEAD 记账，会把上一个会话的在途工作算进本次成果。

| 基线项 | 实测值 |
| --- | --- |
| release exe | 130,975,744 B (124.91 MiB) |
| exe SHA-256 | `6D484B707680141D15C3CF614D8A8E8B476861EAF6546352A71AF2B705347BA2` |
| `.text` / `.rdata` | 39,323,648 / 89,641,472 B |
| 随附 PDB | 25,300,992 B |
| `Cargo.toml` 发布档 | **完全没有 `[profile.release]` 段** → rustc 默认（无 LTO、16 CGU、unwind、不 strip） |
| 内置字体在 exe 中的出现次数 | 每份 **2 次**（64 字节探针实测） |
| 历史 NSIS 在线安装器 | 67,229,090 B，`2.0.0-alpha.0`，NotSigned |

独立佐证：`.artifacts/verification-runs/2026-10-03T05-55-55-161Z-24088/run.json`（13:55 记录 `releaseArtifact 130975744 / 6d484b70…`，`head=07a874b`），与上表一致。基线 exe 本体已随 target 清空而消失，故基线节区值取自当时采集的 `baseline.json.txt`，非事后复算。

## 3. 实测结果

| 指标 | 改动前 | 改动后 | 变化 |
| --- | ---: | ---: | ---: |
| **release exe** | 130,975,744 B (124.91 MiB) | **87,507,456 B (83.45 MiB)** | −43,468,288 B，**−33.19%** |
| ├ `.text` | 39,323,648 B | 28,413,440 B | −10,910,208 B（−27.7%） |
| ├ `.rdata` | 89,641,472 B | 58,365,440 B | −31,276,032 B（−34.9%） |
| └ 其它节区（`.data`/`.pdata`/`.rsrc`/`.reloc`） | 2,009,600 B | 727,552 B | −1,282,048 B（−63.8%） |
| 随附 PDB | 25,300,992 B | 6,901,760 B | −72.7% |
| **NSIS 在线安装包** | 67,229,090 B (64.11 MiB) | **50,209,846 B (47.88 MiB)** | −17,019,244 B，**−25.3%** |
| debug 测试二进制 | 190,343,168 B | 143,611,904 B | −46,731,264 B（−24.6%） |
| dist | 44,724,037 B | 41,868,676 B / 257 文件 | −2,855,361 B |
| 仓库磁盘（5 大目录合计） | 19,924.1 MiB | 3,776.1 MiB | **−16,148.0 MiB（−15.77 GiB）** |

> 可复算性：6 个节区 raw 大小合计与 exe 文件大小相差 1,024 B（PE 头与节区对齐填充，不计入任何节区）。基线 130,974,720 + 1,024 = 130,975,744；改动后 87,506,432 + 1,024 = 87,507,456。

交付产物：

- `src-tauri/target/release/zinecv-desktop.exe` — 87,507,456 B，SHA-256 `CE9E3748F855204E929F28F50333DC87ADA7BB6AC82A75C7CC46ED2CDB0E15B7`
- `src-tauri/target/release/bundle/nsis/ZineCV_2.0.0-alpha.0_x64-setup.exe` — 50,209,846 B，SHA-256 `3CEA9B917D3A30AE2E2A1B781C18811739893952C6B94CD4FC915C420C7BD5DF`

体积构成（实测，非估算）：字体去重直接贡献 −22,291,872 B；其余为 fat LTO + 单代码生成单元 + `panic=abort` + `strip` 带来的代码与元数据缩减；死资源 −2,855,361 B 原始字节（dist 侧 brotli 后约 −823 KB）。

磁盘明细（MiB，实测）：

| 目录 | 初始 | 最终 | 变化 |
| --- | ---: | ---: | ---: |
| `src-tauri/target` | 19,053.4 | 3,442.1 | −15,611.3 |
| `.gitnexus` | 191.7 | 0 | −191.7 |
| `.artifacts` | 333.9 | 32.9（其中 `remaining` 证据 30.3） | −301.0 |
| `node_modules` | 302.4 | 261.2 | −41.2 |
| `dist` | 42.7 | 39.9 | −2.8 |

## 4. 改动清单（全部零功能损失）

| # | 改动 | 位置 | 手段 |
| --- | --- | --- | --- |
| 1 | 三份内置字体改为单一来源 `pub(crate) static` | `src-tauri/src/engine.rs`、`src-tauri/src/storage/resources.rs` | 去重 |
| 2 | `RenderFontBytes` 由 `Vec<u8>` 改为 `typst::foundations::Bytes` | `engine.rs`、`render_worker.rs` | 零拷贝 |
| 3 | 宿主字体材料进程内缓存（`OnceLock` + `Bytes` 共享） | `render_worker.rs` | 去重 |
| 4 | 新增 `[profile.release]`（fat LTO / 单 CGU / `panic=abort` / strip）；`[profile.hooks]` 用 thin LTO | `src-tauri/Cargo.toml` | 构建选项 |
| 5 | 删除 `public/ocr/tesseract-core-lstm.wasm` | `public/ocr/` | 删已证明死资源 |
| 6 | 两个可证伪断言测试 | `engine/tests.rs`、`render_worker.rs` | 证据 |

改动前 `Cargo.toml` **完全没有 `[profile.release]`**。需要澄清：`panic="abort"` 是**语义变更**而非纯体积选项，其不回归由 WebView2 故障注入套件实测覆盖（见 §6）。

字体去重的直接证据（64 字节探针，5 MB 偏移）：

| 文件 | 改动前 | 改动后 |
| --- | ---: | ---: |
| `source-han-serif-cn-heavy.ttf` | 2 | **1** |
| `source-han-serif-cn-regular.otf` | 2 | **1** |
| `wondercv-iconfont.ttf` | 2 | **1** |

## 5. 过程中发现并修复的真实回归

**这是本次最重要的单条发现。**

**现象**：`test:webview-hooks` 的 memory 场景（注入 1700MB 分配，期望 Job Object 1.5GiB 上限终止 worker 并产生结构化失败）实测 `firstResult.ok=true`——渲染成功返回 PDF，确定性 3/3 失败。

**定位**：用同结构探针把注入量提高到 **4000 MB**，仍然杀不死 worker，说明不是「阈值不够」，而是**注入本身不再分配内存**。

**根因**：该注入的实现是 `Vec::with_capacity` + `resize` 填充 + `mem::forget` 泄漏。缓冲从不被读取，在 `opt-level=3` + `lto="fat"` + `codegen-units=1` 下被优化器整体判定为死代码并消除，`ZINECV_TEST_WORKER_ALLOC_MB` 退化为空操作，**1.5GiB 内存上限场景静默失效**。改动前的发布档没有 `[profile.release]`（无 LTO、16 CGU），所以从未暴露。

**修复**：`std::hint::black_box(buffer.as_mut_ptr())`，让分配结果对优化器不透明。该代码位于 `#[cfg(feature = "test-hooks")]`，release 档不编译。

**修复后**：1700 MB 与 4000 MB 注入均正确杀死 worker 并走崩溃重放（`firstResult.ok=false`，`elapsedMs=10187` = 两次 5s 周期），套件 **4/4 通过**。

**教训**：构建选项即使「只影响体积」，也可能改变**测试注入语义**。任何依赖「让优化器保留某个副作用」的测试，都必须显式 `black_box` 或关闭该处优化。

同批次还修掉两个由本次改动引出的问题：

1. **`const` + `include_bytes!` 在 debug 下复制 3 份**：`const` 的具体值会在每个代码生成单元各展开一次。改为 `static` 后，debug 测试二进制每份字体由 **3 份降为 1 份**，体积 190,343,168 → 143,611,904 B。该缺陷在 release（fat LTO、单 CGU）下不可见，只在 debug 暴露。
2. **feature 门控测试代码漏改**：`render_worker.rs` 里另有一个 `#[cfg(all(test, feature = "test-hooks"))]` 的 `hooks_tests` 模块，把 `ResourceMaterial.bytes` 改为 `Bytes` 时只修了主 `tests` 模块，导致 `test:native-hooks` 编译失败（3 处 `E0308`）。已补齐。**被 feature 门控的测试代码不会被默认测试档覆盖，改类型时必须同时跑 feature 档。**

## 6. 验证矩阵（全部实跑）

| 套件 | 结果 |
| --- | --- |
| `npm run check:ts` | 通过 |
| `npm run check:native`（fmt + clippy `-D warnings`） | 通过 |
| `npm run test:native` | **286/286**（基线 284，新增 2 个证据测试） |
| `npm run test:native-hooks` | **287/287** |
| `npm run test:bindings` | `test result: ok`（75 passed）+ 105 个绑定**零漂移** |
| `npm run test:unit` | **25/25** |
| `npm run test:browser` | **16/16**（含「OCR worker / WASM core / 两种语言模型从本地资源加载」） |
| `npm run verify:contracts` | 52 个验收 ID + 55 个 IPC 名称，0 问题 |
| `node tools/audit-parity.mjs` | `{totalRows:52, rowsWithProblems:0, missingPaths:0, missingScripts:0, missingEvidence:0}` |
| `node tools/generate-remaining-fixtures.mjs --check` | `mismatches=0` |
| WebView2 串行 12 套件 | **全部通过** |

WebView2 明细：主回归 1/1、导出 2/2、迁移 1/1、迁移强杀 1/1、提议资产 1/1、Agent UI 1/1、持久化 1/1、发布点强杀 6/6、预览 1/1、一页求解 1/1、求解故障 3/3、**宿主故障注入 4/4**（90s 超时 / 1.5GiB 上限 / 崩溃重放 / 生产零钩子）。

两处需要说明的验证细节（都查清了，不是掩盖）：

- `test:webview-export` 在整轮连跑中失败过一次：`TypeError: Cannot read properties of undefined (reading 'locator')`，409 ms、发生在任何产品断言之前，是 Playwright CDP 页面尚未挂载的**运行器竞态**；单独重跑 **2/2 通过**，首轮串行整轮中也是 2/2。
- `test:native-hooks` 首次失败是编译错误（见 §5 第 2 条），不是行为回归。

## 7. 运行内存与启动足迹（实测）

用 `tools/lightweight/` 自建工具启动**真实宿主**（隔离 profile + CDP，与 `tests/native` 同构），原生快路径采样整棵进程树（宿主 + render worker + WebView2 子进程），81 次/轮，目标间隔 100ms，实测均值 161ms、最大 188ms、**超 200ms 的间隔 0 次**。

| 检查点（MiB） | run-1 | run-2 |
| --- | ---: | ---: |
| 冷启动稳定 idle（整树工作集） | 674.0 | 677.2 |
| 预览渲染后 | 773.5 | 778.5 |
| **导出后峰值（工作集 / 私有）** | **870.0 / 578.7** | **873.1 / 610.4** |
| 宿主自身（峰值） | 95.4 | 97.2 |
| render worker（峰值） | 176.2 | 174.3 |

启动时间线（相对进程创建）：CDP 699/550ms → 草稿就绪 1671/1883ms → 首次 IPC 1679/1892ms → worker 惰性拉起 4754/4982ms → 首个渲染完成 5139/5313ms → 导出完成 7581/7724ms。两次运行的预览页哈希与导出 PDF SHA-256 **逐字节一致**。

**边界（必须一起读）**：这是**新的绝对基线，不是「改动前 vs 改动后」对比**——基线 exe 已随 target 清空消失，本机无法再做改动前的同口径整树 RSS 测量。**不得据此宣称「内存下降了 X」**。与内存直接相关的改动（每次渲染省掉约 22MB 字体的拷贝与哈希、一页求解最多 16 次构造不再复制）有单元测试级的可证伪证据（§4 第 2、3 项），但没有同口径的前后 RSS 对照。

## 8. 对抗性复核结论

本次专门安排了一轮**独立对抗复核**（立场为怀疑者，只采信自己复算的结果）。20 条结论：确认 11、部分确认 3、未能验证 5、**证伪 1**。报告：`.artifacts/remaining/lightweight-20261003/verify/falsification-report.md`。

**被证伪的一条（方法论警告，重要）**：我用 4 KiB 对齐分块扫描得出「没有其它重复载荷」，但复核证明该法在本 exe 上**检出能力为 0**（整份 87.5 MB 里连 1 个重复 4 KiB 块都找不到）。改用 CDC（min 512 / avg 4K / max 16K）+ 字节级前后扩展后，实际存在 ≥64 KiB 重复 2 处共 **217,638 B**、≥8 KiB 重复 28 处共 **697,535 B**。漏检原因是两处位移（160,886 与 1,131,276）都不是 2 的幂次对齐，对齐分块**不可能**同时命中两份拷贝。

- 内容识别为 CBOR 编码的 CSL 引文样式数据（citationberg + ciborium，随 Typst 引文支持进入）。
- **不作为削减项**：去掉即削减文献引用能力，违反零功能损失。
- 反例警示：28 处里有 1 处 12,391 B 落在两份字体文件内部（公共子表），**不可回收**——「扫到重复就删」会破坏字体。
- **结论**：不得再把「分块扫描没发现重复」当作「没有重复」的证据。

**其余被点出、已如实记录的问题**：

- 我的「相对 HEAD 未变」表述不准确：`fontBundleHash`、`RenderFontBytes`、`src-tauri/src/storage/` 在 HEAD 中根本不存在，属在途工作。正确表述是「相对 HEAD 未关闭 feature、未删依赖」（此句为真），且必须在工作树口径下记账（已在 §2 修正）。
- `.artifacts/remaining/` 没有逐文件基线清单，「既有证据零删除」只能靠 `audit-parity.mjs` 的 `missingEvidence: 0` 支撑。
- 单位口径：MB 与 MiB 混用会差近 1 GB；本文档统一用 **MiB** 并标注。

## 9. 未验证 / 明确不做 / 边界

**未能验证**
- 基线 exe 已不存在，因此**基线节区值、基线字体出现次数（2 次）、基线 debug 二进制**均为当时采集值，无法事后复算。
- 删除 `public/ocr` 死文件**未做 WebView2 打包态端到端 OCR 抓包**；其零影响由静态证据链 + 浏览器套件（本地加载、零外部请求）支撑。
- `public/ocr` 整个目录在 git 中**未跟踪**（`git ls-tree HEAD -- public/ocr` 为 0），删除不入版本历史，回滚只能靠「该 `.js` 内联的 base64 段可无损还原」这一已验证路径。
- `R09/session3-hooks/*.json` 被套件重跑就地覆盖（测试固定写入该目录），上一会话的 hooks 证据已被本次结果替换。
- 真实 HTTPS 模型通路（R25）仍不可验证，故 TLS 侧一律未动。
- `tools/lightweight/` 的内存工具**未做长时 soak**、未走真实用户交互路径，单机单 WebView2 版本（154.0.4258.53），不可外推。

**明确不做（各有理由）**
- **WOFF2 重封装**：exe 内 dist 资源已由 Tauri 以 brotli 存储，实测 `regular.otf 11,257,480→7,939,300`、`heavy.ttf 11,934,568→6,193,777`，`brotli(SFNT) ≈ WOFF2`，对安装包无收益，且会破坏 `fixtures/remaining/manifest.json` 的路径哈希；Typst 亦不接受 WOFF2。
- **切换到 `ring` 取代 `aws-lc-rs`**：`reqwest` 的 `rustls` feature 硬绑定 aws-lc-rs/aws-lc-sys（cmake 构建），`quinn` 只在 lock 中被解析（`http3` 未启用）。切 ring 可省少量体积，但真实模型 HTTPS 在本机不可验证。
- **移除 pdfjs `cmaps/standard_fonts/wasm/*nowasm_fallback`、tesseract 非 SIMD 变体、OCR 语言包、字体子集化**：均属功能性削减。
- **`public/ocr` 三份 LICENSE 文本与 `docs/licenses/` 重复**（约 34 KB）：属合规呈现，未动。

## 10. 下一步候选（留待决策，均未执行）

1. **消除 dist 侧字体副本**：让 DOM 预览经 Tauri 自定义 URI scheme 读取引擎已内嵌的同一份字节，可将 exe 再减约 **13.2 MB**（brotli 压缩后的字体资源）。代价：改 CSP（`font-src`）、新增协议注册、dev/test 路径分流、更新 `visual-parity` 供给方式与 fixture 清单路径；需完整重跑 WebView2 与视觉对照。
2. **worker 资源一次性传输**：当前每次渲染都把三份字体以 base64 重新经管道发送（约 **29.7 MB 文本/次**），预览与 16 候选求解的延迟与内存主要花在这里。按 worker generation 缓存可省掉绝大部分，但属协议改动，需同步改 `typst-worker-poc` 等协议测试。
3. **前端懒加载**（几十 KB 量级）：`AgentOverlay` 改 `React.lazy`、`motion` 由 `domMax` 改 `domAnimation`、拆 `import-tools` 分块。均需浏览器 + WebView2 套件验证。

## 11. 证据索引

证据根：`.artifacts/remaining/lightweight-20261003/`

| 文件 | 说明 |
| --- | --- |
| `SUMMARY.md` | 证据汇总（与本文档数字一致） |
| `baseline.json.txt` | 基线快照（exe / 节区 / dist brotli 成本 / 磁盘 / 配置） |
| `build-release-1.log`、`build-release-final.log`、`build-release-3.log` | 三次 release 全量构建（23.5 / 11.7 / 10.2 min） |
| `build-hooks.log`、`build-hooks-2.log` | hooks 档构建（17.2 / 6.1 min） |
| `build-installer.log` | NSIS 安装包构建 |
| `test-native.log`、`test-native-2.log`、`test-native-hooks.log` | 原生单测（含 `static` 修复前后的失败/通过） |
| `webview-suite.ps1`、`final-webview-suite.ps1` | WebView2 串行运行器（陷阱：必须串行） |
| `webview-*.log`、`final-*.log` | 各套件原始输出 |
| `final-webview-summary.json` | 最终字节上的 12 套件结果 |
| `frontend/dead-asset-report.md` | 死资源复核报告（base64 还原验证、dist 组成） |
| `verify/falsification-report.md` | 对抗复核报告（20 条结论 + 复算脚本） |
| `measure/conclusion.md`、`run-1.json`、`run-2.json`、`summary.json`、`environment.json` | 内存与启动足迹原始采样与结论 |

复现命令：

```powershell
# 体积
(Get-Item src-tauri\target\release\zinecv-desktop.exe).Length

# 回归
npm run check:ts; npm run check:native; npm run test:native; npm run test:unit
npm run test:browser; npm run test:bindings; npm run verify:contracts
node tools/audit-parity.mjs; node tools/generate-remaining-fixtures.mjs --check

# WebView2（必须串行；hooks 档需先构建，约 6 分钟）
npm run build:native-hooks
powershell -NoProfile -ExecutionPolicy Bypass -File .artifacts\remaining\lightweight-20261003\final-webview-suite.ps1

# 内存与启动足迹（会启动真实宿主，需独占机器）
node tools/lightweight/measure-memory.mjs --runs 2
```

## 12. 产物一致性的测量口径

release exe **不可位级复现**：PE 头写入构建时间戳，同源码两次构建 SHA 不同，但**文件大小与全部 6 个节区 raw 大小完全一致**。`hooks_tests` 编译修复后重建的 exe 与已验证 exe 逐字节比较**仅 24 字节不同**，核对偏移与内容确认是 PE `TimeDateStamp`（`0x108`）与 CodeView `RSDS` 记录（PDB GUID / age / path，`0x528A5xx`），**不含任何代码差异**。

因此：跨构建一致性应以「**大小 + 6 个节区 raw 大小**」判断，不能用 SHA 相等论证可复现；验收结论只对当次 SHA 有效。若后续有人改源码并重建，必须按 §11 命令重跑 WebView2 套件，不能沿用本次结果。

## 13. 文档治理（本次对 docs/ 的处置）

任务要求「更新本项目的所有文档：删除以前版本的文档，只保留最新的切片」。实际处置如下，**删除前逐个核实了影响**：

**已删除**：14 个历史版本 / 旧证据文档——`adr-ui.md`、`b03-interaction-evidence.md`、`b04-domain-evidence.md`、`b04-richtext-adapter.md`、`b05-storage-evidence.md`、`b06-native-ui-evidence.md`、`b10-browser-export.md`、`baseline-manifest.json`、`bench-typst-poc-20260926.json`、`current-preview-selfcheck-20260926.json`、`execution-status.md`、`legacy-storage-inventory.md`、`paper-text-selection-baseline-20260927.json`、`typst-risk-evidence.md`。删除后 `node tools/generate-remaining-fixtures.mjs --check` 仍为 `mismatches=0`。

**保留（删除即造成实际损害，故按用户「影响大就先别删」的指示保留）**：

| 文件 | 保留理由（已实测） |
| --- | --- |
| `feature-parity.json` | `tools/verify-contracts.mjs:7` 直接读取它；删除则 `verify:contracts` 与 `audit-parity` **直接失败**，52 行矩阵失去唯一载体 |
| `licenses/`（24 文件） | `vite.config.ts:86` 将其复制为 `dist/licenses` 的**构建输入**，同时是许可证盘点依据；删除则打包产物缺失许可证呈现 |
| `resource-license-inventory-20260930.json` | `generate-resource-license-inventory.mjs --check` 的比对目标；删除需同步改工具 |
| `DEVELOPMENT_PLAN.md`、`FEATURE_PARITY.md`、`FEASIBILITY.md`、`target.archify.json` | AGENTS.md 明令不修改的四份原始依据；前两者还被 `fixtures/remaining/manifest.json` 按 SHA-256 固定校验，删除会破坏 `--check` |
| `public-ipc-contract-v1.md` | 55 个 IPC 命令的唯一人类可读契约，`README.md` 标注「接口工作必读」；`verify-contracts.mjs` **不**读取它，故无机器门禁依赖，但删除会丢失别处没有的信息 |

**已知无害残留**：`tools/generate-remaining-fixtures.mjs` 与 `fixtures/remaining/manifest.json` 的「历史指针」段仍列出部分已删文档路径；这是**容忍缺失**的历史记录段，`--check` 依然 `mismatches=0`，故未改动门禁基础设施。`docs/DEVELOPMENT_PLAN.md`（受保护，不可修改）内也有对 `execution-status.md`、`baseline-manifest.json` 的历史引用，同样保留。
