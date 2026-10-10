# tools/lightweight — 运行内存 / 启动足迹实测工具

本目录只做一件事：**用真实进程数据测量 ZineCV 桌面宿主的运行内存与启动足迹**，不估算、不推算。
它不会构建任何东西：release 二进制由 Lead 构建，本工具只负责启动、采样、记录、清理。

```
tools/lightweight/
  measure-memory.mjs        驱动：启动真实宿主 → 检查点 → 采样 → 证据 JSON → 彻底清理
  process-tree-sampler.ps1  常驻采样器：按 ≤200ms 采真实进程计数器（JSONL，原生快路径 + 可选 CIM）
  classify.mjs              角色分类 / 口径聚合 / 窗口计算的唯一实现（live 与离线重算共用）
  reclassify.mjs            离线重算：用同一批原始采样重算角色与口径，不启动任何进程
  summarize.mjs             汇总：读取 run-*.json（有 .classified.json 时优先）→ summary.json + 对照表
  stop-tree.ps1             清理：按记录到的 pid 强制结束并验证已消失
  host-count.ps1            机器级进程普查：zinecv-desktop.exe / msedgewebview2.exe 的计数与 pid 列表
```

## 为什么是这套结构

采样必须又准又不打扰被测量的进程。实测（本机、编译负载下）：

| 方式 | 单次耗时 | 结论 |
| --- | --- | --- |
| `Get-CimInstance Win32_Process`（默认） | 冷 1.5s，热 120–165ms | 每 tick 用会把采样间隔顶到 200ms 以上 |
| 持久 CIM session + `SELECT` 指定属性 | 80–110ms | 只适合低频取命令行 |
| `[System.Diagnostics.Process]::GetProcesses()` 过滤进程名 | 9–15ms | 快，但没有父进程/峰值 |
| **psapi + NtQueryInformationProcess（本工具采用）** | **每进程亚毫秒** | 每 tick 可拿父进程、工作集、私有字节、峰值工作集、峰值页面文件、创建时间、CPU 时间 |

因此采样器每个 tick 只做「.NET 按名枚举 + 原生快照」，命令行等低频信息由驱动在**进程树仍存活时**做一次
`-Once` CIM 快照取得（默认 `--topology-every-n 0`，热循环里完全不碰 WMI）。`topologySource` 字段会写明
本次用的是 `native(psapi+NtQueryInformationProcess)` 还是退化的 `cim`（Add-Type 失败时）。

采样器还要解决**自身启动延迟**：PowerShell 冷启动 + Add-Type 编译要数百毫秒到数秒，足以吞掉宿主的冷启动窗口。
所以驱动**先启动采样器**（等待其 `ready`，包含热机），**再启动宿主**，随后把宿主 pid 写进 pid 文件，
采样器收到后立即开始采样（实测 attach 延迟约 120ms 内）。

启动宿主时注入的隔离环境与 `tests/native/host-fixture.mjs` 完全同构（改这里前先读那个文件）：

| 变量 | 值 | 作用 |
| --- | --- | --- |
| `APPDATA` / `LOCALAPPDATA` | `<profile>/Roaming` / `<profile>/Local` | 隔离 Windows 漫游与本地数据 |
| `ZINECV_DATA_DIR` | `<profile>/Data` | 隔离 SQLite 与文档数据 |
| `WEBVIEW2_USER_DATA_FOLDER` | `<profile>/WebView2` | 隔离 WebView2 用户数据 |
| `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS` | `--remote-debugging-port=<free> --disable-backgrounding-occluded-windows --disable-renderer-backgrounding --disable-background-timer-throttling` | CDP 接入 + 等同 webview 测试的防节流参数 |

`<profile>` 是 `--out` 目录下的 `tmp/` 临时目录，运行结束（含失败路径）会被删除。

## 用法

`--diagnostics` 在持续交互期间每分钟记录 JavaScript 堆和 DOM 数量，帮助区分历史数据增长与其他内存增长；不强制垃圾回收，不改变原有交互、采样或长测资格判据。诊断记录保存在每轮 `soak.diagnostics`。

`soak.exportAttempts` 记录每次 PDF 导出的菜单打开、格式选择、等待结果和文件读取阶段。界面明确报告暂停、失败或取消时保存原提示并判为失败；只有实际保存提示和落盘 PDF 校验同时成立才通过。超时与失败记录保留，不能并入成功的三轮统计。

```powershell
# 旧口径检查点测量：两次运行；显式关闭持续交互窗口
node tools/lightweight/measure-memory.mjs --soak-ms 0 --runs 2 --label run `
  --out .artifacts/remaining/lightweight-20261003/measure

# 只采样一个已存在进程的整棵树（不启动宿主，不需要串行窗口）
node tools/lightweight/measure-memory.mjs --sample-pid 1234

# 只记录测量环境（OS/CPU/内存/WebView2 版本/机器级基线），不启动任何进程
node tools/lightweight/measure-memory.mjs --machine-info `
  --out .artifacts/remaining/lightweight-20261003/measure

# 自测：采样器快路径 / pid 文件接管 / CIM 一次性快照 / 应用缺失错误路径（都不启动宿主）
node tools/lightweight/measure-memory.mjs --selftest `
  --out .artifacts/remaining/lightweight-20261003/measure

# 汇总两次运行（读证据，不启动任何东西），生成 summary.json 与对照表
node tools/lightweight/reclassify.mjs --out .artifacts/remaining/lightweight-20261003/measure --runs 2
node tools/lightweight/summarize.mjs --out .artifacts/remaining/lightweight-20261003/measure `
  --runs 2 --expect-sha256 <被测 exe 的 SHA256>
```

常用参数：`--app <exe>`、`--runs <n>`、`--interval-ms <20..200>`、`--topology-every-n <n>`、
`--idle-settle-ms`、`--preview-settle-ms`、`--export-settle-ms`、`--boot-timeout-ms`、
`--step-timeout-ms`、`--total-timeout-ms`、`--keep-profile`、`--allow-preexisting-host`。完整列表见 `--help`。

退出码：`0` 成功；`1` 有运行失败（证据仍会写出）；`2` 参数/应用缺失等前置错误（明确报错、立即返回、不挂起）；
`3` 已有 `zinecv-desktop.exe` 在运行（归属会混淆），需要先停掉或显式 `--allow-preexisting-host`。

## 检查点与时间线

### 按预算持续交互（B4）

本轮默认采用 `quick`，用户要求缩短回归与测量时间，旧计划的 3 × 30 分钟不再作为强制默认。
三档保留相同动作和断言，只改变持续时间与重复轮数：

| preset | 每轮真实交互预算 | 轮数 | 用途 |
| --- | --- | --- | --- |
| `quick`（默认） | 20 秒 | 1 | 快速检查交互和测量链路 |
| `standard` | 120 秒 | 3 | 较短的三轮统计比较 |
| `extended` | 30 分钟 | 3 | 按需补充长时间稳定性证据 |

```powershell
node tools/lightweight/measure-memory.mjs --preset quick --label quick `
  --out .artifacts/remaining/remaining-20261004/measure-quick

node tools/lightweight/measure-memory.mjs --preset standard --label standard `
  --out .artifacts/remaining/remaining-20261004/measure-standard

node tools/lightweight/measure-memory.mjs --preset extended --label soak `
  --out .artifacts/remaining/audit-plan-20261003/run-exec-20261003/soak
```

`--soak-ms` 和 `--runs` 分别覆盖 preset 的对应预算，与参数顺序无关；`--soak-ms 0` 保留旧检查点模式。
同一二进制串行运行，每轮在原有 idle/preview/export 检查点后开始真实交互；
总 watchdog 自动保留额外 5 分钟启动与检查点预算。最后一个已开始的完整循环必须执行所有动作，
因此实际交互时长可略超预算，启动、固定测量窗口与清理时间另计，不把 20 秒描述为整个工具的总耗时。
每轮隔离数据目录，通过 IPC 创建两个合成导入模板，再刷新页面开始测量。循环由真实 React UI 执行：
姓名编辑和持久保存、两个模板上下文交替切换、真实指针拖动分栏、提交版本、载入上一个历史版本。
每分钟通过真实导出菜单导出 PDF 并校验落盘签名与 SHA256；仅原生保存路径选择由驱动提供，
其余渲染、写盘和提示均走生产 UI。IPC 读取只用于确认持久状态。两模板使用相同 `legacy-v1` 排版，
验证模板上下文切换；不把不同排版设计或真人长时使用计入覆盖。

`soak.cycles` 保留逐步耗时、结果、提交/历史 ID、拖动前后宽度；失败立即结束本轮并保存截图与错误。
`soak.actualMs`、`completedCycles`、`failures`、`exports` 记录真实执行量。
`soak.memory` 和 `soak.memoryWindows`（5 分钟窗口）分别给出 host/renderWorker/WebView2/other/整树
工作集及私有字节的 p50/p95/max，统一按同一时刻进程求和，再按最近秩法计算百分位。
空采样返回 `null`；整段原始采样仍保存在 `rawSamples`，可以复核时序及内存增长，统计不自动宣称不存在泄漏。
各轮摘要也写入 `<label>-driver.json`；`measurementBudget` 报告 preset 与最终请求预算，
`soakComparison.actualInteractionTotalMs` 记录实际累计交互时间。
独立 `longSoakQualification` 分别报告请求预算资格、实际长测资格和是否完成 3 × 30 分钟：
短档成功也始终不能被标记为长测通过，失败、缺采样、缺导出、清理未验证或二进制变化同样不能通过。
退出与临时文件清理沿用原测量流程。

交互步骤等待真实持久状态与 UI 完成；循环保留最多 250ms 调度让步，防止空转，
不再每轮固定冷却 5 秒。下一轮宿主在上一轮进程退出、普查与 profile 删除完成后立即启动，
删除额外 2 秒等待；idle/preview/export 的明确采样窗口保留，避免改变原测量口径。

纯统计/参数验证（不启动桌面或 WebView2）：`node --test tools/lightweight/measure-memory.test.mjs`。

一次运行内的固定顺序（每一步都记录相对 `hostSpawned` 的毫秒数）：

1. `samplerReady` → 采样器热机完成（此时宿主还没启动）
2. `hostSpawned` → 进程创建（时间线零点）；紧接着 `pidFileWritten` → 采样器接管
3. `cdpConnected` → WebView2 暴露 CDP
4. `pageAttached` / `appShellVisible` → 页面与 `.app-shell` 就绪
5. `draftReady` → `.save-state` 出现「草稿已保存 / 已从本地数据库恢复」
6. `firstIpcOk` → 自动化侧第一次 `document_state` IPC 成功（首个可靠 IPC 观测点）
7. `idleCheckpoint` → 冷启动后静置 `--idle-settle-ms`（默认 3s）的稳定态
8. `contentPrepDone` → 写入确定性内容（`PREP_TEXT × 200`，强制多页），使预览/导出是真排版
9. `previewRendered` / `previewCheckpoint` → `render_document_preview` 完成，且页面把每一页 SVG 解码成 `<img>`（等同真实预览路径），静置后取检查点
10. `exportRendered` / `exportCheckpoint` → `render_document_export` 完成，并把 PDF 与长图写入隔离 profile 内的中文目录，bundle 仍被页面持有（等同真实导出路径）
11. `finalSnapshot` → **在所有进程仍存活时**的一次性 CIM 快照（命令行 + OS 生命周期峰值）
12. `teardownStarted` → `hostExited` → `cleanupDone`

## 证据 JSON 字段

顶层（`run-<n>.json`，`schema = zinecv.lightweight.memory.v1`）：

| 字段 | 含义 |
| --- | --- |
| `binary.before` / `binary.after` | 被测 exe 的 `sizeBytes` / `mtimeIso` / `sha256`；`stableAcrossRun` 说明整轮测量期间二进制没被替换 |
| `host.environment` | 实际注入的隔离环境（profile 路径被折叠成 `<profile>`） |
| `timeline.marks` | 每个里程碑的 `tMs`（相对进程创建）与绝对 `iso` |
| `checkpoints.*` | 每步 IPC 的返回值摘要（渲染键、页数、页哈希、PDF SHA256、写出字节数等），用于证明渲染真的发生了 |
| `checkpoints.finalSnapshot` | 清理前的进程数与整树内存（此时命令行仍可读） |
| `checkpoints.unexpectedDescendants` | 全量后代扫描中**不属于** `zinecv-desktop.exe` / `msedgewebview2.exe` 的进程（应为空） |
| `samplerControl` | 采样器的 `ready`（热机耗时、原生 helper 是否可用）与 `attached`（接管延迟、宿主 pid） |
| `memory.sampleIntervalMs` / `sampleCount` / `observedSpanMs` | 采样密度证据 |
| `memory.meanSampleIntervalMs` / `maxSampleDeltaMs` / `deltasOver200ms` | 实际采样间隔：均值、最大、以及超过 200ms 的个数（应关注是否为 0） |
| `memory.maxFastPathMs` / `maxCimRefreshMs` / `topologyRefreshCount` | 每个 tick 的原生快照耗时与（可选的）CIM 刷新耗时 |
| `memory.peak.treeWorkingSetBytes` / `treePrivateBytes` | 整棵树在全部采样中的峰值（同时刻求和），`atMs` 是峰值出现时间 |
| `memory.windows.{coldBoot,idle,contentPrep,preview,export,whole}` | 每个窗口内按角色分解的 `max*/last*` 内存：`host` / `renderWorker` / `webview2Browser|Renderer|Gpu|Utility|Crashpad` 等 |
| `processes.inventory` | 每个 pid 的角色、命令行、首末出现时间、`osPeak*`（OS 生命周期峰值） |
| `processes.firstWorkerSeenMs` | render worker 首次出现的时刻（用于判断 idle 检查点是否已包含 worker） |
| `processes.lifetimePeakSum*` | 各进程生命周期峰值之和，**上界**（峰值并不同时出现） |
| `cleanup` | 采样器退出、宿主退出码、按 pid 强杀结果、`leftoverCheck`（清理后的机器级普查）、`ownPidsStillAlive`（我们见过的所有 pid 与清理后普查的交集）、`newWebview2PidsAfterCleanup`、`cleanupVerified`、profile 是否删除 |
| `host.preRunHostCount` / `host.preRunWebview2Pids` | 本轮开始前的机器级基线（计数 + pid 列表），用于判断清理后是否真的回到基线 |
| `rawSamples` | 原始采样（每次每个进程的 `ws` / `priv` / `peakWs` / `peakPageFile` / `threads` / `cpuSeconds` / `deltaMs`），便于复核 |
| `rawSamplerMeta` | 采样器自身的 CPU 秒数、工作集、热机耗时、跟踪到的 pid 与生命周期峰值 |
| `limitations` | 本次测量的可信度限制（自动生成） |

`run-<n>-driver.json` 是多轮运行的汇总；`summary.json`（由 `summarize.mjs` 生成）是两次运行的对照，
其 `comparison` 字段给出可比性判据（同一二进制、同数量级、采样间隔是否全部 ≤200ms、profile 是否删除、
自有 pid 是否零残留、是否有意外后代进程）。

## 口径说明

- **四个口径**：`host`（宿主 exe）/ `renderWorker`（宿主的同 exe 子进程，首次渲染时惰性拉起、随宿主退出）/
  `webview2`（本树内的 `msedgewebview2.exe`，含浏览器进程与其 renderer/gpu/utility 子进程）/ `other`；
  `整树` = 四者同时刻求和。每个窗口都同时给出 `roles`（细分角色）与 `scopes`（四口径）。
- **角色分类是结构性的**（`classify.mjs`）：`pid === 宿主 pid` → host；同 exe 且不是宿主 → renderWorker；
  父进程不是 WebView2 的 `msedgewebview2.exe` → webview2Browser，其余 → webview2Child。热循环不采命令行
  （WMI 太慢），命令行只在清理前的一次性快照里采集，用于把子进程细分为 `webview2Renderer/Gpu/Utility/Crashpad`
  并核验 worker 的 `--zinecv-render-worker`（`checkpoints.finalSnapshot.workerCommandLines`、
  `processes.workerEvidence`）。命令行为空时 `workerCommandLineVerified` 为 `null`（未知），不是 `false`。
- `ws` = 工作集（`GetProcessMemoryInfo.WorkingSetSize`，含共享页）；`priv` = 私有提交内存（`PrivateUsage`）。
  整树求和时工作集会把共享页重复计算，**私有内存更适合相加**，两者都给出。
- `peakWs` / `peakPageFile` 是 OS 维护的进程生命周期峰值，随进程消失而不可读；采样器每个 tick 读取并保留最大值
  （只对本树进程），清理前还会再做一次快照。**峰值数字不依赖采样间隔**，采样曲线只是佐证。
- 渲染 worker 由宿主在首次渲染时惰性启动并复用；`processes.firstWorkerSeenMs` 说明它出现的时刻
  （±1 个采样间隔的分辨率）。
- 预览检查点包含页面里解码后的预览图，导出检查点包含页面持有的导出 bundle；检查点之后才释放。
- **二进制稳定性三档判据**：exe 不是位级可复现的（PE COFF `TimeDateStamp` 每次构建都会变），所以除了
  `stableAcrossRun`（SHA 逐字节一致）还记录 `sizeStableAcrossRun` + `layoutStableAcrossRun`（大小与 6 个节区
  raw 大小一致）与 `stabilityVerdict`。跨构建比较请用大小 + `pe.sectionSignature`，不要只看 SHA256。

## 自测覆盖（`--selftest`，不启动宿主）

| 检查 | 内容 |
| --- | --- |
| `samplerFastPath` | 100ms 目标间隔下采样自身进程树；每个采样都能看到自己与采样器的 PowerShell 子进程（验证父子闭包），最大间隔 ≤200ms |
| `pidFileAttach` | 生产路径：先热机 → `ready` → 写入 pid 文件 → `attached` → 采样到该 pid 的真实工作集 |
| `cimOnceSnapshot` | `-Once -AllProcesses` CIM 快照路径（真实运行取命令行与扫描意外后代时使用） |
| `stopTreeCleanup` | `stop-tree.ps1` 真的杀掉了给定 pid 并确认其已消失 |
| `hostCountCensus` | 机器级普查给出真实整数并与 pid 列表长度互校；**普查失败时必须是 `unknown` + `null`，绝不能是 0 或 −1**（用 `ZINECV_MEASURE_CENSUS_FAIL=1` 强制失败路径验证） |
| `missingApp` | 应用不存在时明确报错、退出码 2、不挂起 |

### 「未知」与「0」的口径

机器级普查只有两种状态：拿到真实数字（`unknown: false`，计数与 pid 列表长度互校），或者
**明确未知**（`unknown: true`，所有计数为 `null`，`cleanupVerified: false`，并写入 `limitations`）。
任何情况下都不会用 0 代表「无法测量」。相关字段：`cleanup.leftoverCheck.unknown`、
`cleanup.cleanupVerified`、`cleanup.ownPidsStillAlive`（数组或 `null`）。
真实运行时还会记录 `host.preRunWebview2Pids` 基线，并在清理后计算 `newWebview2PidsAfterCleanup`：
机器上本来就存在的 `msedgewebview2.exe`（例如其它 WebView2 应用）由 pid 闭包归属排除，
不会被算作我们的进程，也不会让「零残留」这一结论失真。

## 清理与串行约束

- 运行前若发现已有 `zinecv-desktop.exe`，默认拒绝（退出码 3）。
- 运行前若发现已有 `msedgewebview2.exe`（且无宿主），默认只提示并记录基线，不拒绝——它们属于机器上其它
  WebView2 应用，pid 闭包归属会把它们排除在外；需要绝对干净的环境时用 `--require-no-webview2` 改为拒绝。
- 清理顺序：停宿主 → 关 CDP → 停采样器 → 按记录到的所有 pid 强杀 → 校验 → 删 profile。
- 采样器自带兜底：被跟踪进程树连续 40 次采样为空就自行退出；等待 pid 文件期间也会响应停止请求，
  驱动崩溃不会留下常驻采样器。
- **本工具会启动真实 WebView2**：正式测量前必须先向 Lead 确认没有其它 WebView2 测试在跑，跑完再告知一次。
