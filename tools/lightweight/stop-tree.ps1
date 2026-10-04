<#
  stop-tree.ps1 — force-stop a recorded set of pids and verify they are gone.

  Used by tools/lightweight/measure-memory.mjs during cleanup. It never starts anything.
  Pids are the pids observed in-tree during the run (host, render worker, msedgewebview2
  children), so cleanup does not depend on parent links that may already be broken.

  Output: one JSON line: {"killed":[...],"failed":[...],"remaining":[...],"waitedMs":N}
#>
param(
  [Parameter(Mandatory = $true)][string]$Pids,
  [int]$WaitMs = 15000
)

$ErrorActionPreference = 'Stop'
$ids = @($Pids.Split(',') | Where-Object { $_ -match '^\d+$' } | ForEach-Object { [int]$_ } | Sort-Object -Unique)
$killed = New-Object System.Collections.ArrayList
$failed = New-Object System.Collections.ArrayList

foreach ($procId in $ids) {
  if ($procId -le 0) { continue }
  $proc = Get-Process -Id $procId -ErrorAction SilentlyContinue
  if (-not $proc) { continue }
  try { Stop-Process -Id $procId -Force -ErrorAction Stop; [void]$killed.Add($procId) }
  catch { [void]$failed.Add("${procId}:$($_.Exception.Message)") }
}

$start = Get-Date
$remaining = @()
while (((Get-Date) - $start).TotalMilliseconds -lt $WaitMs) {
  $remaining = @($ids | Where-Object { Get-Process -Id $_ -ErrorAction SilentlyContinue })
  if ($remaining.Count -eq 0) { break }
  Start-Sleep -Milliseconds 150
}
# One last force pass for stragglers, then final observation.
foreach ($procId in $remaining) {
  try { Stop-Process -Id $procId -Force -ErrorAction Stop } catch { }
}
Start-Sleep -Milliseconds 250
$final = @($ids | Where-Object { Get-Process -Id $_ -ErrorAction SilentlyContinue })

[Console]::Out.WriteLine(([ordered]@{
  kind      = 'stopTree'
  requested = $ids.Count
  killed    = @($killed)
  failed    = @($failed)
  remaining = @($final)
  waitedMs  = [int](((Get-Date) - $start).TotalMilliseconds)
} | ConvertTo-Json -Compress -Depth 4))
[Console]::Out.Flush()
