<#
  host-count.ps1 — machine-wide process census for the two executables of interest.

  Used by tools/lightweight/measure-memory.mjs (pre-flight, per-run pre-check, post-cleanup
  verification). It only reads process state.

  Output: one JSON line. `unknown` is emitted by the caller when this script cannot be run or
  its output cannot be parsed — a missing measurement is NEVER reported as 0.

    {"kind":"hostCount","zinecvDesktop":0,"msedgewebview2":12,
     "zinecvPids":[],"webview2Pids":[2816,4196,...],
     "cimQueriesOk":true}
#>
$ErrorActionPreference = 'SilentlyContinue'
$zinecv = @(Get-CimInstance Win32_Process -Filter "Name='zinecv-desktop.exe'")
$zinecvOk = $null -ne $zinecv
$webview = @(Get-CimInstance Win32_Process -Filter "Name='msedgewebview2.exe'")
$webviewOk = $null -ne $webview

# $ErrorActionPreference='SilentlyContinue' hides failures, so prove the query works by
# counting a process class that always exists (the current process) the same way.
$self = @(Get-CimInstance Win32_Process -Filter "ProcessId=$PID")
$selfOk = @($self).Count -eq 1

[Console]::Out.WriteLine(([ordered]@{
  kind          = 'hostCount'
  zinecvDesktop = @($zinecv).Count
  msedgewebview2 = @($webview).Count
  zinecvPids    = @($zinecv | ForEach-Object { [int]$_.ProcessId })
  webview2Pids  = @($webview | ForEach-Object { [int]$_.ProcessId } | Sort-Object)
  cimQueriesOk  = [bool]$selfOk
  queriedAtEpochMs = [int64](([DateTime]::UtcNow - [DateTime]::Parse('1970-01-01T00:00:00Z').ToUniversalTime()).TotalMilliseconds)
} | ConvertTo-Json -Compress -Depth 4))
[Console]::Out.Flush()
