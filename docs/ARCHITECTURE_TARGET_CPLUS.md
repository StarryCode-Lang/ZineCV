# ZineCV 全平台目标架构（C+）— 架构决策记录

| 项 | 内容 |
| --- | --- |
| 状态 | **已签字定案（2026-10-06，用户逐节确认）** |
| 性质 | 唯一目标架构：后续开发计划、Archify 目标架构图、Agent 执行提示词的共同架构依据 |
| 执行计划 | `docs/EXECUTION_PLAN_20261006-cplus.md`（分阶段落地，每步 Windows RC 保持全绿） |
| 与既有文档关系 | 与 `DEVELOPMENT_PLAN.md`、`FEATURE_PARITY.md`、`FEASIBILITY.md`、`target.archify.json` 并列，不修改四者；仓库现状以 `docs/SLICE_20261002.md` 为准 |
| 迁移纪律 | 沿 `src/platform` 接缝平行生长；crates 按 contracts/domain → engine → storage → agent 增量抽取；不推送、不发布；本地提交需用户明确授权 |

以下为定案全文（§1–§15 与最终架构定义），§16 为定案时一并签字的执行纪律附件。

---

## 1. 架构目标

核心原则一句话：

> **React 负责跨平台 UI，Rust Core 负责真正的产品能力；六个安装端将同一套 Rust Core 编译为目标平台原生机器码，只有浏览器编译为 WASM。Tauri、ArkTS 和 Web 都只是 Host，不拥有业务核心。**

| 层 | 原则 |
|---|---|
| UI | React 一套代码，桌面 / 移动 / 鸿蒙 / Web 共用 |
| 核心 | Domain、Engine、Storage 语义、Agent 语义全部 Rust 单源 |
| Native | Win/macOS/Linux/iOS/Android/HarmonyOS 编译原生机器码 |
| Web | Rust Core → WASM，浏览器平台能力通过 Adapter 注入 |
| 壳层 | Tauri / ArkTS / Browser 只处理平台能力 |
| 数据 | SQLite 为统一数据模型，Backup JSON 为跨端交换契约 |
| 排版 | 官方 Typst Rust crates，自持 Engine |
| 验收 | 结构 + 视觉 + 同环境二进制三级门禁 |

---

## 2. 总体架构

```text
┌──────────────────────────────────────────────────────────────────────┐
│                         ZineCV Shared UI                             │
│                                                                      │
│ React + TypeScript                                                   │
│ 编辑器 / DOM 交互预览 / Agent UI / 模板 / 设置 / 版本 / 响应式布局    │
│                                                                      │
│                    src/ui  —— 全平台共用                              │
└───────────────────────────────┬──────────────────────────────────────┘
                                │
                       Typed Platform API
                                │
┌───────────────────────────────▼──────────────────────────────────────┐
│                         Platform Facade                              │
│                                                                      │
│ EngineClient                                                         │
│ StorageClient                                                        │
│ AgentTransport                                                       │
│ SecretStore                                                          │
│ FileDialog / Share / Update / Clipboard / OS Capability              │
│                                                                      │
│                运行时能力探测 + 编译期平台装配                        │
└───────────────────────────────┬──────────────────────────────────────┘
                                │
                                ▼
╔══════════════════════════════════════════════════════════════════════╗
║                        ZineCV Rust Core                              ║
║                                                                      ║
║  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐                   ║
║  │ Contracts   │  │   Domain    │  │   Engine    │                   ║
║  │ serde/schema│  │ command/CAS │  │ Typst       │                   ║
║  │ Backup JSON │  │ version tree│  │ TextMap     │                   ║
║  └─────────────┘  └─────────────┘  │ Fit/PDF/PNG │                   ║
║                                     └─────────────┘                  ║
║                                                                      ║
║  ┌────────────────────┐      ┌────────────────────┐                  ║
║  │ Storage Core       │      │ Agent Core         │                  ║
║  │ migration          │      │ provider protocol  │                  ║
║  │ transaction/CAS    │      │ stream/proposal    │                  ║
║  │ backup/restore     │      │ cancel/context     │                  ║
║  └────────────────────┘      └────────────────────┘                  ║
║                                                                      ║
╚═══════════════╤══════════════════════════════╤═══════════════════════╝
                │                              │
       Native compilation                 WASM compilation
                │                              │
     ┌──────────┼───────────┐                  │
     │          │           │                  │
     ▼          ▼           ▼                  ▼
 Desktop     Mobile      HarmonyOS          Browser
 Tauri       Tauri       ArkTS Host         Web/PWA
 Win/Mac/    iOS/        + ArkWeb           Web Worker
 Linux       Android     + ohrs/NAPI        + wasm-bindgen
     │          │           │                  │
 Native       Native      Native              WASM
 SQLite       SQLite      SQLite              sqlite3-wasm
```

这里最关键的是：**Host 不再等于 Backend。** Tauri 不拥有业务逻辑，ArkTS 不拥有业务逻辑，JavaScript 也不拥有第二套业务逻辑。它们只是把平台能力提供给 Rust Core。

---

## 3. Rust Core 的最终边界

最终拆成五个核心域：

| Core | 职责 | 是否跨平台单源 |
|---|---|---:|
| `zinecv-contracts` | Command、DTO、Schema、Backup JSON | 是 |
| `zinecv-domain` | 编辑命令、CAS、版本树、业务规则 | 是 |
| `zinecv-engine` | Typst、模板、TextMap、一页求解、导出 | 是 |
| `zinecv-storage` | migration、事务、CAS、备份恢复语义 | 是 |
| `zinecv-agent` | Provider、流式协议、Proposal、取消、上下文 | 是 |

平台差异不进入这些模块内部到处 `if windows / if web`，统一通过 Trait / Adapter 注入：

```text
EngineRuntime / StorageBackend / AgentTransport / SecretProvider
FileSystemCapability / Clock / Random / PlatformInfo
```

这样以后换 Tauri、换鸿蒙壳，甚至将来出现新的平台，都不会重新实现 ZineCV 本身。

---

## 4. 七种运行形态

六个安装端全部 Native Core：

| 平台 | UI Host | Rust Core | Engine | Storage |
|---|---|---|---|---|
| Windows | Tauri WebView2 | Native x64/arm64 | Native Typst | rusqlite |
| macOS | Tauri WKWebView | Native x64/arm64 | Native Typst | rusqlite |
| Linux | Tauri WebKitGTK | Native x64/arm64 | Native Typst | rusqlite |
| iOS | Tauri Mobile | Native arm64 | Native Typst | rusqlite |
| Android | Tauri Mobile | Native arm64/x64 | Native Typst | rusqlite |
| HarmonyOS | ArkTS + ArkWeb | Native `.so` | Native Typst | Native SQLite |
| Browser | Browser/PWA | WASM | Typst WASM | sqlite3-wasm |

因此真正需要承担 WASM 性能和兼容性风险的只有 **Browser**。鸿蒙不再进入 WASM 路线。

---

## 5. Engine 最终结构

不再以 `typst.ts` 作为架构依赖：

```text
                zinecv-engine
                     │
          Official Typst Rust crates
                     │
        ┌────────────┴────────────┐
        ▼                         ▼
 Native target                wasm32 target
 Windows/mac/Linux            wasm-bindgen
 iOS/Android/Harmony             │
        │                        ▼
        ▼                    Web Worker
 Native Engine
```

ZineCV 自己持有：模板、字体装配、冻结文档模型、TextMap、HitRegion、分页、一页求解、SVG、PDF、PNG、导出规则、RenderKey、缓存策略。Typst 升级、WASM 工具链变化或未来替换部分 renderer，都不改变上层契约。

---

## 6. Storage 最终结构

> **统一的是 Storage 语义，而不是强迫所有平台使用同一个底层 VFS 实现。**

```text
                 zinecv-storage
                       │
       Migration / Transaction / CAS
       Version Graph / Backup / Restore
                       │
               Store Backend Trait
              ┌────────┴────────┐
              │                 │
          NativeStore        WebStore
              │                 │
          rusqlite          wasm bridge
              │                 │
        SQLite native       sqlite3-wasm
                                │
                    ┌───────────┼────────────┐
                    ▼           ▼            ▼
                  OPFS       sahpool      IndexedDB
                    │                         │
                    └────────── fallback ─────┘
```

Native 六端：`Rust → rusqlite → SQLite → 平台文件系统`，现有 migration / CAS / transaction 体系直接延续。

Browser 不重新实现 Domain，第一版路线：

```text
Rust WASM Core → wasm-bindgen → Web Storage Adapter
              → official sqlite3-wasm → VFS
```

浏览器 VFS 由运行时能力决定：`opfs / opfs-wl → opfs-sahpool → IndexedDB-compatible fallback → memory → 强制提示导出 Backup`。这也是整个 C+ 最值得优先 POC 的部分。

---

## 7. 多标签页并发

浏览器不能偷偷降低现有 CAS 语义。目标：

```text
Tab A/B/C ─ Web Locks / supported OPFS locking
          → transaction → CAS → version graph
```

不支持可靠并发的平台环境，明确退化成 **Single Writer Mode**，而不是静默制造两个数据库事实源。

---

## 8. Agent 架构

**逻辑单源，Transport 平台化。** `zinecv-agent` 持有 Provider / Context / Proposal / Cancel；`AgentTransport` 分 Native（Host HTTP bridge → 任意模型端点）与 Web（browser fetch → CORS 允许端点）。不支持浏览器直连的 Provider 直接显示"当前 Web 版本不支持该 Provider"，不做假的兼容层。

---

## 9. Secret / Identity

安全存储放在 Capability 层，业务代码永远只面对 `trait SecretProvider`：

```text
Windows → DPAPI；macOS/iOS → Keychain；Linux → Secret Service
Android → Keystore；Harmony → 平台安全存储 Adapter；Browser → WebCrypto + non-exportable key
```

---

## 10. Host 层应该有多薄

### Tauri Host
窗口生命周期、WebView、native bridge、文件选择、分享、剪贴板、系统菜单、自动更新、协议注册、安全权限、平台 Secret Store、进程/Worker 生命周期。

### Harmony Host
UIAbility 生命周期、ArkWeb、React 静态资源、ohrs/NAPI bridge、文件/分享、平台 Secret Store、平台网络、安装包生命周期。

### Browser Host
PWA、Service Worker、Web Worker、OPFS、Web Locks、WebCrypto、File System API、浏览器 Capability detection。

**任何简历编辑、版本、Agent Proposal、排版规则都不应该进入 Host。**

---

## 11. 推荐最终仓库

```text
ZineCV/
├─ src/
│  ├─ ui/                         # React Shared UI
│  ├─ platform/
│  │  ├─ capability.ts / engine.ts / storage.ts / agent.ts / secrets.ts / host.ts
│  └─ main-*.tsx
├─ crates/
│  ├─ zinecv-contracts/  zinecv-domain/  zinecv-engine/  zinecv-storage/  zinecv-agent/
│  ├─ zinecv-native/
│  ├─ zinecv-wasm/                # wasm-bindgen facade
│  └─ zinecv-ohos/                # ohrs / NAPI facade
├─ src-tauri/{desktop,mobile}/
├─ harmony/{entry,arkts,native}/
├─ web/{manifest,service-worker,hosting,storage-runtime}
├─ fixtures/{engine,domain,migration,cross-platform}/
└─ tools/{verify-project,verify-engine-parity,verify-platform,verify-backup-parity}.mjs
```

注意不是立即一次性重构。迁移顺序：

```text
现有 Windows RC → contracts/domain → engine → storage → agent → platform host 瘦身
```

每一步 Windows RC 都保持绿色。

---

## 12. 跨端数据契约

真正跨端的长期稳定 ABI 不是内部 Rust struct，而是：

```text
DomainCommand schema / Backup JSON schema / Engine frozen input schema / Agent event schema
```

最终实现 Windows → macOS → iPhone → Android → HarmonyOS → Browser 任意两端互导，并保持 `schemaVersion`、migration、forward compatibility、unsupported schema rejection。现有备份格式继续演进，不另造第二个 Web 格式。

---

## 13. Engine 三级一致性门禁

- **Gate A — Semantic / Structural（必须一致）**：页数、正文、Section 顺序、链接、TextMap、HitRegion、分页结果、一页求解结果、geometry。
- **Gate B — Visual**：同一 fixture 在 Native reference 与 Web WASM / Harmony / Android / iOS / macOS / Linux 之间做 raster diff、geometry tolerance、anchor tolerance、font fallback check（现有 `engine-parity` 方法直接扩展）。
- **Gate C — Binary**：Engine version、Font bytes、Typst version、Platform、Architecture 相同时要求 hash 可复现；跨 CPU/OS 的 PDF byte hash 作为诊断信号，不作为唯一失败条件。

---

## 14. Capability Detection

所有平台启动时形成明确能力表 `PlatformCapabilities`（nativeCore、nativeSQLite、wasm、opfs、opfsLocks、webLocks、fileSystemAccess、secureSecrets、nativeDialogs、share、autoUpdate、modelDirectFetch、workerIsolation 等）。UI 不自己猜 `isSafari/isHarmony`，只消费 `capabilities.storage.concurrentWriters` 这类语义位，避免平台判断屎山。

---

## 15. POC 架构验证

两周 POC 只选三个代表端：

```text
Windows（Native Core + Native SQLite + Native Engine）
        ├── HarmonyOS（Native Core + Native SQLite + Native Engine）
        └── Browser（WASM Core + sqlite3-wasm + Typst WASM）
```

统一跑通：创建简历 → 编辑 → 持久化 → 关闭/重开 → 历史版本 → 导出 PDF → 结构门禁 → 视觉门禁 → Backup JSON → 跨端恢复。三个代表端跑通即证明架构最危险的部分。

## 最终架构定义

> **ZineCV 是一个以 Rust Core 为产品核心、React 为共享交互层的跨平台本地优先应用。Domain、Document Engine、Storage 语义和 Agent 逻辑采用单一 Rust 实现；Windows、macOS、Linux、iOS、Android 与 HarmonyOS 将其编译为对应平台原生机器码，Browser 将同一核心编译为 WebAssembly。Tauri 负责桌面与移动 Host，ArkTS + ArkWeb + ohrs 负责 HarmonyOS Host，浏览器通过 Web Platform Adapter 提供持久化及系统能力。所有平台共享统一领域契约、Typst 排版逻辑、SQLite 数据模型和 Backup JSON 格式，并通过结构、视觉与二进制三级验证体系保证跨平台行为一致性。**

---

## 16. 定案附件：执行纪律（同日签字）

**① POC 淘汰判据（kill criteria）**——到点即触发，不再讨论：

- **Browser 腿**：若"wasm core 经 wasm-bindgen 同步驱动 sqlite3-wasm（sahpool/opfs-wl）"无法同时满足同步调用语义 + 持久化可靠 → 回退为"Rust core 只承载 domain/engine，浏览器存储用 TS 适配器复用命令语义"（原 C 的浏览器腿），架构其余不变。
- **鸿蒙腿**：若 `rusqlite bundled` 的 OHOS 交叉编译（cc-rs 工具链）超过一周未通 → 鸿蒙临时降级为 wasm 腿（原 C 方案），native 排到二期。
- **引擎 wasm**：若 typst 0.15 crates 在 `wasm32-unknown-unknown` 上有不可绕过的阻塞依赖 → 引擎 wasm 单独降级，先交付"浏览器编辑+持久化，导出走桌面"的过渡形态。

有这三条梯子，POC 的任何结果都是可接受的产出，不存在"白做"。

**② POC 第一天的第一个实验**：Rust core 的 storage trait 目前是同步语义（rusqlite 同步），而 sqlite3-wasm 的 JS API 多为 Promise 形态。`opfs-sahpool` 的卖点是同步可用（无需 SAB/COOP/COEP），但"wasm-bindgen → JS 同步桥"的可行性要作为首个实验，它决定 WebStore 走"JS 桥"还是"SQLite 编进 wasm + Rust VFS"那条更尖端的路。

**③ 移动端基准**：iOS/Android native rusqlite + native typst 成立（两者都是纯 Rust，bundled SQLite 移动端交叉编译成熟），但 P13 时代的 bench 阈值不得直接搬到移动端——移动 WebView + 原生核心组合要重新冻结基准，不能沿用桌面数字宣称"性能一致"。
