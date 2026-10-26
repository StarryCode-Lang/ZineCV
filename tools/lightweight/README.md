# 运行内存测量工具

按需测量现有宿主，不构建应用，不作为日常默认验收。参数、预算和输出字段以 `node tools/lightweight/measure-memory.mjs --help` 为准；统计实现位于 classify/summarize/reclassify，采样和归属清理位于同目录PowerShell工具。

```powershell
node tools/lightweight/measure-memory.mjs --machine-info --out .artifacts/measure/current
node tools/lightweight/measure-memory.mjs --selftest --out .artifacts/measure/selftest
node tools/lightweight/measure-memory.mjs --history-mode fixed --diagnostics --preset extended --out .artifacts/measure/current
node tools/lightweight/summarize.mjs --out .artifacts/measure/current
```

quick=20秒×1，standard=120秒×3，extended=30分钟×3；短测不替长测。growing/fixed历史分别记录，不能混比。隔离APPDATA、SQLite与WebView2，固定输入/程序身份，原生工作串行，不强制GC或清缓存制造结果。

记录整树host/worker/WebView2/其他子进程，私有内存与工作集分列；共享工作集相加会重复，生命周期峰值之和不是同刻峰值。采样未知不能记为0。CDP Network记录在采样前关闭，实际UI、IPC、导出和预算不变。

退出时依次关闭宿主/CDP/采样器，仅回收确认归属的进程和本次profile；不终止其他应用。退出码0成功、1运行失败、2参数/应用缺失、3存在未允许的宿主。历史结论见HISTORY，当前任务只读plan。
