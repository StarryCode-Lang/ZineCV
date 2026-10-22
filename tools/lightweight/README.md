# 运行内存与启动测量

只启动既有宿主、采样、记录和清理，不构建应用。quick为20秒×1，standard为120秒×3，extended为30分钟×3；短测不能代替长测。历史结果见[HISTORY](../../docs/HISTORY_202610.md#qualification)，原始历史采样已删除，不宣称内存已优化或无泄漏。

## 入口

| 文件 | 职责 |
| --- | --- |
| measure-memory.mjs | 驱动、隔离宿主、检查点、持续交互与清理 |
| process-tree-sampler.ps1 | 常驻原生采样，必要时CIM回退 |
| classify.mjs / reclassify.mjs | 角色/口径唯一实现与离线重算 |
| summarize.mjs | 读本次run文件，生成汇总与可比性判断 |
| host-count.ps1 / stop-tree.ps1 | 机器级基线、按归属PID清理 |
| tests/measurement/memory.test.mjs | 预算、统计与测量规则测试 |

## 用法

先看帮助，实际测量使用隔离数据，确认没有其他原生/WebView2测试或测量占用；不需要额外向Agent申请许可。路径由本次输出目录决定，不恢复旧运行目录。

```powershell
node tools/lightweight/measure-memory.mjs --help
node tools/lightweight/measure-memory.mjs --machine-info --out .artifacts/measure/current
node tools/lightweight/measure-memory.mjs --sample-pid 1234
node tools/lightweight/measure-memory.mjs --selftest --out .artifacts/measure/selftest
node tools/lightweight/measure-memory.mjs --soak-ms 0 --runs 2 --label run --out .artifacts/measure/current
node tools/lightweight/summarize.mjs --out .artifacts/measure/current
```

常用参数包括--app、--runs、--interval-ms、--topology-every-n、--idle/preview/export-settle-ms、--boot/step/total-timeout-ms、--keep-profile、--allow-preexisting-host；精确名称/预算以--help和现行实现为准。--expect-sha256是调用者可选的本次被测exe身份，不是仓库固定字节锁。

--diagnostics在持续交互中每分钟记录JS堆与DOM，不强制GC或修改预算。soak.exportAttempts保留菜单、格式、等待和文件读取阶段；暂停/失败/取消不能计为成功，实际保存提示与落盘PDF校验必须同时成立。失败、超时不混入成功三轮统计。

默认`--history-mode growing`每轮创建新提交。固定负载复核用`--history-mode fixed --diagnostics --preset extended`：测量前给两个合成模板播种固定历史，测量窗口继续编辑、换模板、拖分栏、载入历史和每分钟导出，但不新增提交；每轮核对历史图身份与HEAD不变。两种场景分别标记，不互相冒充；extended仍是30分钟×3，短程不替代长测，不用删除历史或强制GC制造平台期。

固定负载的平台期诊断预先采用：每轮后15分钟的三个5分钟整树私有内存中位数，极差不超过其中位数的5%且不超过64MiB，首尾斜率绝对值不超过1MiB/分钟；同时要求历史图恒定、原预算完成、功能与清理通过。全部报告原始窗值/峰值，未满足则记录增长而非改口径。这个新增诊断不放宽既有用例或门禁，也不构成所有负载无泄漏证明。

退出码：0成功；1运行失败并写证据；2参数/应用缺失；3发现已有宿主而未显式允许。

## 采样与口径

采样器先热机发ready，再启动宿主并传PID；attached记录接管延迟。原生快路径读取父进程、创建时间、工作集、私有内存、OS生命周期峰值和CPU；CIM命令行主要在树仍存活时一次读取，默认热循环不调用WMI，回退来源写入topologySource。

隔离APPDATA/LOCALAPPDATA、ZINECV_DATA_DIR和WebView2 profile，CDP与三项防后台节流参数跟随host-fixture。时间线覆盖coldBoot、idle、contentPrep、preview、export和whole；预览持有解码页面，导出持有bundle，检查点后才释放。持续交互记录编辑、模板、预览、PDF及durable状态，不以计时器存活代替行为成功。

| 口径 | 解释 |
| --- | --- |
| host | 宿主PID |
| renderWorker | 同exe的内部渲染子进程，首次渲染惰性启动 |
| webview2 | 本树的browser/renderer/gpu/utility/crashpad |
| other | 其他后代，必须记录并判断是否意外 |
| 整树 | 四者同一采样时刻求和；不同进程生命周期峰值之和仅为上界 |

工作集含共享页，求和会重复计算；私有内存更适合相加，两者都记录。OS进程峰值与采样窗口峰值不同。命令行无法读取时workerCommandLineVerified为null，不能判成false或成功；普查失败时unknown=true、计数null、cleanupVerified=false，不能用0代表未知。

## 结果与清理

run-*.json记录binary before/after、隔离环境、timeline、checkpoint结果、采样ready/attached、窗口/角色峰值、实际间隔、进程inventory、cleanup、rawSamples和limitations。driver记录多轮；summary比较二进制、采样质量、profile清理、PID残留与意外后代。重新构建的PE时间戳会变，跨构建以节区/大小及实际来源判断可比性，不能凭SHA不同宣布性能退步或凭相同源码假定同一exe。

先停宿主、关CDP、停采样器，再按记录到的PID清理并机器级核对，最后删本次profile。已有WebView2只记基线并按父子闭包排除，可用--require-no-webview2要求完全空闲；不清理其他应用。采样器连续40次空树会退出，等PID期间也响应停止，不能遗留常驻进程。--selftest检查快路径、PID接管、CIM快照、清理、普查未知与缺失应用；不是宿主功能验收。
