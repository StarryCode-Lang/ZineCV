<#
  process-tree-sampler.ps1 — long-lived process-tree memory sampler.

  Used by tools/lightweight/measure-memory.mjs. Nothing here starts the application;
  it only observes processes the Node driver already started.

  Three problems this file solves:

  1) Sample cost. A full Win32_Process CIM query costs ~100-200 ms per call on this machine,
     which would push the sample interval past the required <=200 ms. So the per-tick work
     uses only cheap native calls (Add-Type helper over OpenProcess + GetProcessMemoryInfo +
     NtQueryInformationProcess + GetProcessTimes): working set, private bytes, peak working
     set, pagefile peak, parent pid, creation time and CPU time for every candidate process,
     in well under a millisecond per process. CIM is used only for command lines and is off by
     default in the hot loop (-TopologyEveryN 0); the driver collects command lines from a
     one-shot -Once snapshot taken while the whole tree is still alive.

  2) Sampler start-up latency. PowerShell + Add-Type warm-up costs seconds, which would hide
     the host's cold-start window. So the driver starts this sampler BEFORE the host, this
     script warms up and emits {"kind":"ready"}, then waits for the root pid in -RootPidFile
     and samples from that instant (a few ms after the host is spawned).

  3) If Add-Type is unavailable the sampler degrades to the CIM-only path and says so
     (topologySource = "cim"); the driver's selftest then fails its cadence check.

  Output: one JSON object per line (JSONL) on stdout, flushed per line:
    {"kind":"ready","atEpochMs":..,"warmupMs":..,"helperAvailable":true}
    {"kind":"attached","atEpochMs":..,"rootPid":..,"waitedMs":..}
    {"kind":"sample","index":0,"atEpochMs":..,"deltaMs":..,"fastMs":..,"cimMs":..,
     "topologySource":"native","rootPid":..,"inTreeCount":N,"outsideCount":M,
     "procs":[{"pid":..,"ppid":..,"name":..,"cmd":..,"ws":..,"priv":..,"peakWs":..,
               "peakPageFile":..,"threads":..,"createMs":..,"cpuSeconds":..,"present":true}]}
    {"kind":"meta", ...}    at exit: sampler footprint, tracked pids, lifetime peaks.
    {"kind":"error", ...}   non-fatal diagnostics.

  Membership: fixpoint over ParentProcessId from the root pid, recomputed every tick from
  live data and unioned with the persistent set, so a member stays tracked until it exits.

  Termination: -StopFile exists (checked after each sample, so at least one sample is always
  produced), or -MaxSamples reached, or the tracked tree has been empty for 40 consecutive
  samples (orphan guard, so a crashed driver cannot leak this sampler).
#>
param(
  [int]$RootPid = 0,
  [string]$RootPidFile = '',
  [int]$IntervalMs = 150,
  [string]$StopFile = '',
  [switch]$Once,
  [switch]$AllProcesses,
  [int]$MaxSamples = 0,
  # In-loop CIM command-line refreshes: 0 disables them (default). The native fast path already
  # yields parent pid, working set, private bytes, peak working set, peak pagefile, creation
  # time and CPU time every tick; command lines are then taken from the driver's one-shot
  # -Once snapshot while the whole tree is still alive, so the hot loop stays free of WMI cost.
  [int]$TopologyEveryN = 0,
  [int]$RootWaitMs = 120000,
  # Comma-separated executable names to watch. The default is the ZineCV tree; the driver's
  # selftest overrides it to validate sampling without starting a host.
  [string]$ProcessNames = 'zinecv-desktop.exe,msedgewebview2.exe'
)

$ErrorActionPreference = 'Stop'
$nameList = @($ProcessNames.Split(',') | ForEach-Object { $_.Trim() } | Where-Object { $_ })
$nameFilter = (@($nameList | ForEach-Object { "Name='$_'" }) -join ' OR ')
$selectQuery = "SELECT ProcessId,ParentProcessId,Name,WorkingSetSize,PrivatePageCount,PeakWorkingSetSize,PeakPageFileUsage,ThreadCount,CreationDate,CommandLine FROM Win32_Process WHERE $nameFilter"
$fastNames = @($nameList | ForEach-Object { [System.IO.Path]::GetFileNameWithoutExtension($_) })
$epoch = [DateTime]::Parse('1970-01-01T00:00:00Z').ToUniversalTime()

$tree = New-Object 'System.Collections.Generic.HashSet[int]'
$commandLines = @{}      # pid -> command line (from the periodic CIM refresh)
$cimRows = @{}           # pid -> CIM row values (used by -AllProcesses snapshot mode)
$lastPeaks = @{}         # pid -> ordered dict, retained after exit (OS counters are monotonic)
if ($RootPid -gt 0) { [void]$tree.Add($RootPid) }
$sampleIndex = 0
$emptyStreak = 0
$tick = 0
$lastAtEpochMs = 0
$cimSession = $null
$helperAvailable = $false
$warmupError = ''
$topologySource = 'cim'

$nativeSource = @'
using System;
using System.Runtime.InteropServices;

public static class ZinecvProc
{
    [StructLayout(LayoutKind.Sequential)]
    private struct MEMORY_COUNTERS_EX
    {
        public uint cb;
        public uint PageFaultCount;
        public IntPtr PeakWorkingSetSize;
        public IntPtr WorkingSetSize;
        public IntPtr QuotaPeakPagedPoolUsage;
        public IntPtr QuotaPagedPoolUsage;
        public IntPtr QuotaPeakNonPagedPoolUsage;
        public IntPtr QuotaNonPagedPoolUsage;
        public IntPtr PagefileUsage;
        public IntPtr PeakPagefileUsage;
        public IntPtr PrivateUsage;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct BASIC_INFORMATION
    {
        public IntPtr Reserved1;
        public IntPtr PebBaseAddress;
        public IntPtr Reserved2a;
        public IntPtr Reserved2b;
        public IntPtr UniqueProcessId;
        public IntPtr InheritedFromUniqueProcessId;
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr OpenProcess(uint access, bool inheritHandle, int processId);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CloseHandle(IntPtr handle);

    [DllImport("psapi.dll", SetLastError = true)]
    private static extern bool GetProcessMemoryInfo(IntPtr handle, out MEMORY_COUNTERS_EX counters, uint size);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetProcessTimes(IntPtr handle, out long creation, out long exit, out long kernel, out long user);

    [DllImport("ntdll.dll")]
    private static extern int NtQueryInformationProcess(IntPtr handle, int infoClass, ref BASIC_INFORMATION info, int length, out int returned);

    // [0]=ok [1]=ppid [2]=ws [3]=peakWs [4]=privateBytes [5]=pagefile [6]=peakPagefile
    // [7]=createEpochMs [8]=cpuMs   (all zero when unavailable)
    public static long[] Snapshot(int processId)
    {
        long[] result = new long[9];
        IntPtr handle = OpenProcess(0x1000, false, processId); // PROCESS_QUERY_LIMITED_INFORMATION
        if (handle == IntPtr.Zero) { return result; }
        try
        {
            MEMORY_COUNTERS_EX counters = new MEMORY_COUNTERS_EX();
            counters.cb = (uint)Marshal.SizeOf(typeof(MEMORY_COUNTERS_EX));
            if (GetProcessMemoryInfo(handle, out counters, counters.cb))
            {
                result[0] = 1;
                result[2] = counters.WorkingSetSize.ToInt64();
                result[3] = counters.PeakWorkingSetSize.ToInt64();
                result[4] = counters.PrivateUsage.ToInt64();
                result[5] = counters.PagefileUsage.ToInt64();
                result[6] = counters.PeakPagefileUsage.ToInt64();
            }
            BASIC_INFORMATION basic = new BASIC_INFORMATION();
            int returned;
            if (NtQueryInformationProcess(handle, 0, ref basic, Marshal.SizeOf(typeof(BASIC_INFORMATION)), out returned) == 0)
            {
                result[1] = basic.InheritedFromUniqueProcessId.ToInt64();
            }
            long creation, exitTime, kernel, user;
            if (GetProcessTimes(handle, out creation, out exitTime, out kernel, out user))
            {
                result[7] = (creation / 10000L) - 11644473600000L;
                result[8] = (kernel + user) / 10000L;
            }
        }
        finally { CloseHandle(handle); }
        return result;
    }
}
'@

function Get-EpochMs { [int64](([DateTime]::UtcNow - $epoch).TotalMilliseconds) }

function Write-Line([object]$payload) {
  [Console]::Out.WriteLine(($payload | ConvertTo-Json -Compress -Depth 6))
  [Console]::Out.Flush()
}

function Get-CimSessionHandle {
  if (-not $script:cimSession) { $script:cimSession = New-CimSession }
  return $script:cimSession
}

# Per-tick fast path: name-filtered .NET enumeration + one native snapshot per candidate.
function Get-FastSnapshot {
  $live = @{}
  $failed = $null
  try {
    foreach ($proc in [System.Diagnostics.Process]::GetProcesses()) {
      try {
        if ($script:fastNames -notcontains $proc.ProcessName) { continue }
        $procId = $proc.Id
        $threads = -1
        try { $threads = [int]$proc.Threads.Count } catch { }
        $row = $null
        if ($script:helperAvailable) { try { $row = [ZinecvProc]::Snapshot($procId) } catch { $row = $null } }
        $fullName = "$($proc.ProcessName).exe"
        if ($row -and $row[0] -eq 1) {
          $live[$procId] = [ordered]@{
            pid = $procId; name = $fullName; ppid = [int]$row[1]; ws = $row[2]; peakWs = $row[3]
            priv = $row[4]; pagefile = $row[5]; peakPagefile = $row[6]; createMs = $row[7]; cpuMs = $row[8]; threads = $threads
          }
        } else {
          $live[$procId] = [ordered]@{
            pid = $procId; name = $fullName; ppid = -1; ws = [int64]$proc.WorkingSet64; peakWs = 0
            priv = [int64]$proc.PrivateMemorySize64; pagefile = 0; peakPagefile = 0; createMs = 0; cpuMs = -1; threads = $threads
          }
        }
      } finally { $proc.Dispose() }
    }
  } catch { $failed = $_.Exception.Message }
  return @{ live = $live; failed = $failed }
}

# Periodic slow path: command lines (and a peak cross-check) for the tracked tree.
function Invoke-TopologyRefresh {
  $start = Get-EpochMs
  try {
    if ($AllProcesses) { $rows = @(Get-CimInstance Win32_Process -CimSession (Get-CimSessionHandle) -ErrorAction Stop) }
    else { $rows = @(Get-CimInstance -Query $script:selectQuery -CimSession (Get-CimSessionHandle) -ErrorAction Stop) }
  } catch {
    Write-Line ([ordered]@{ kind = 'error'; atEpochMs = (Get-EpochMs); message = "cim refresh failed: $($_.Exception.Message)" })
    return (Get-EpochMs) - $start
  }
  $grew = $true
  while ($grew) {
    $grew = $false
    foreach ($row in $rows) {
      $candidate = [int]$row.ProcessId
      if ($tree.Contains($candidate)) { continue }
      if ($tree.Contains([int]$row.ParentProcessId)) { [void]$tree.Add($candidate); $grew = $true }
    }
  }
  foreach ($row in $rows) {
    $procId = [int]$row.ProcessId
    if (-not $tree.Contains($procId)) { continue }
    $cmd = [string]$row.CommandLine
    if ($cmd.Length -gt 320) { $cmd = $cmd.Substring(0, 320) }
    $commandLines[$procId] = $cmd
    $peakWs = [int64]$row.PeakWorkingSetSize
    $peakPf = [int64]$row.PeakPageFileUsage
    $createMs = 0
    if ($row.CreationDate) { $createMs = [int64]((([DateTime]$row.CreationDate).ToUniversalTime() - $epoch).TotalMilliseconds) }
    # Kept so -AllProcesses (snapshot) mode can report names/values without a fast path.
    $cimRows[$procId] = [ordered]@{
      pid = $procId; name = [string]$row.Name; ppid = [int]$row.ParentProcessId; ws = [int64]$row.WorkingSetSize
      priv = [int64]$row.PrivatePageCount; peakWs = $peakWs; peakPagefile = $peakPf
      threads = [int]$row.ThreadCount; createMs = $createMs; cpuMs = -1
    }
    if ($lastPeaks.ContainsKey($procId)) {
      if ($peakWs -gt $lastPeaks[$procId].peakWs) { $lastPeaks[$procId].peakWs = $peakWs }
      if ($peakPf -gt $lastPeaks[$procId].peakPageFile) { $lastPeaks[$procId].peakPageFile = $peakPf }
    } else { $lastPeaks[$procId] = [ordered]@{ pid = $procId; peakWs = $peakWs; peakPageFile = $peakPf } }
  }
  return (Get-EpochMs) - $start
}

function Invoke-Sample {
  $fastStart = Get-EpochMs
  $live = @{}
  $fastFailed = $null
  $cimMs = 0
  $refreshed = $false

  if ($AllProcesses) {
    # Snapshot mode for the unexpected-descendant scan: CIM only, no fast path.
    $cimMs = Invoke-TopologyRefresh
    $refreshed = $true
  } else {
    $fast = Get-FastSnapshot
    $live = $fast.live
    $fastFailed = $fast.failed

    # Membership fixpoint from this tick's parent pids, unioned with the persistent set.
    $fresh = New-Object 'System.Collections.Generic.HashSet[int]'
    if ($RootPid -gt 0) { [void]$fresh.Add($RootPid) }
    $grew = $true
    while ($grew) {
      $grew = $false
      foreach ($entry in $live.Values) {
        if ($fresh.Contains($entry.pid)) { continue }
        if ($entry.ppid -gt 0 -and $fresh.Contains($entry.ppid)) { [void]$fresh.Add($entry.pid); $grew = $true }
      }
    }
    foreach ($candidate in $fresh) { [void]$tree.Add($candidate) }
    # Drop members that are no longer alive (name-filtered live set is authoritative).
    foreach ($known in @($tree)) { if (-not $live.ContainsKey($known)) { [void]$tree.Remove($known) } }
  }
  $fastMs = (Get-EpochMs) - $fastStart

  if (-not $AllProcesses -and ($Once -or ($TopologyEveryN -gt 0 -and ($tick % $TopologyEveryN) -eq 0))) {
    $cimMs = Invoke-TopologyRefresh
    $refreshed = $true
  }

  # Track lifetime peaks from the native counters every tick (monotonic, retained after exit).
  # Only tree members: the fast path sees every same-named process on the machine (other
  # WebView2 apps included) and their peaks must not leak into this run's evidence.
  foreach ($entry in $live.Values) {
    if (-not $tree.Contains($entry.pid)) { continue }
    if (-not $lastPeaks.ContainsKey($entry.pid)) {
      $lastPeaks[$entry.pid] = [ordered]@{ pid = $entry.pid; peakWs = [int64]$entry.peakWs; peakPageFile = [int64]$entry.peakPagefile }
    } else {
      if ($entry.peakWs -gt $lastPeaks[$entry.pid].peakWs) { $lastPeaks[$entry.pid].peakWs = [int64]$entry.peakWs }
      if ($entry.peakPagefile -gt $lastPeaks[$entry.pid].peakPageFile) { $lastPeaks[$entry.pid].peakPageFile = [int64]$entry.peakPagefile }
    }
  }

  $procs = New-Object System.Collections.ArrayList
  foreach ($procId in @($tree)) {
    $entry = if ($live.ContainsKey($procId)) { $live[$procId] } elseif ($cimRows.ContainsKey($procId)) { $cimRows[$procId] } else { $null }
    if (-not $entry) { continue }
    $peaks = $lastPeaks[$procId]
    [void]$procs.Add([ordered]@{
      pid          = $procId
      ppid         = $entry.ppid
      name         = $entry.name
      cmd          = if ($commandLines.ContainsKey($procId)) { $commandLines[$procId] } else { '' }
      ws           = [int64]$entry.ws
      priv         = [int64]$entry.priv
      peakWs       = if ($peaks) { [int64]$peaks.peakWs } else { [int64]$entry.peakWs }
      peakPageFile = if ($peaks) { [int64]$peaks.peakPageFile } else { [int64]$entry.peakPagefile }
      threads      = $entry.threads
      createMs     = [int64]$entry.createMs
      cpuSeconds   = if ($entry.cpuMs -ge 0) { [math]::Round($entry.cpuMs / 1000.0, 3) } else { -1 }
      present      = $true
    })
  }

  $outside = 0
  foreach ($procId in $live.Keys) { if (-not $tree.Contains($procId)) { $outside++ } }

  $at = Get-EpochMs
  return [ordered]@{
    kind              = 'sample'
    index             = $sampleIndex
    atEpochMs         = $at
    deltaMs           = if ($lastAtEpochMs -gt 0) { $at - $script:lastAtEpochMs } else { 0 }
    fastMs            = $fastMs
    cimMs             = $cimMs
    topologyRefreshed = $refreshed
    topologySource    = $topologySource
    fastFailed        = $fastFailed
    rootPid           = $RootPid
    processNames      = $nameList
    intervalMs        = $IntervalMs
    allProcesses      = [bool]$AllProcesses
    inTreeCount       = $procs.Count
    outsideCount      = $outside
    procs             = @($procs)
  }
}

try {
  # Warm up before anything is measured: Add-Type compilation plus the CIM session.
  $warmStart = Get-EpochMs
  try {
    Add-Type -TypeDefinition $nativeSource -Language CSharp -ErrorAction Stop
    $helperAvailable = $true
    $topologySource = 'native(psapi+NtQueryInformationProcess)'
  } catch {
    $helperAvailable = $false
    $warmupError = $_.Exception.Message
    Write-Line ([ordered]@{ kind = 'error'; atEpochMs = (Get-EpochMs); message = "Add-Type helper unavailable, falling back to CIM-only sampling: $warmupError" })
  }
  $null = Get-CimSessionHandle
  $null = Get-FastSnapshot
  $null = Invoke-TopologyRefresh
  # Warm the JSON serializer and console path too: the first large ConvertTo-Json call costs
  # hundreds of ms, which would otherwise land in the first measured interval.
  $warmSample = Invoke-Sample
  $warmSample.kind = 'warmupSample'
  Write-Line $warmSample
  $warmupMs = (Get-EpochMs) - $warmStart

  if ($RootPid -le 0 -and $RootPidFile -and -not $Once) {
    Write-Line ([ordered]@{ kind = 'ready'; atEpochMs = (Get-EpochMs); warmupMs = $warmupMs; helperAvailable = $helperAvailable; pid = $PID })

    $waitStart = Get-EpochMs
    while ($RootPid -le 0) {
      if (Test-Path -LiteralPath $RootPidFile) {
        $raw = (Get-Content -LiteralPath $RootPidFile -ErrorAction SilentlyContinue | Select-Object -First 1)
        if ($raw -and $raw.Trim() -match '^\d+$') { $RootPid = [int]$raw.Trim() }
      }
      if ($RootPid -le 0) {
        if ($StopFile -and (Test-Path -LiteralPath $StopFile)) {
          Write-Line ([ordered]@{ kind = 'error'; atEpochMs = (Get-EpochMs); message = 'stop requested before the root pid appeared; sampler exits without samples' })
          throw 'stop requested before root pid appeared'
        }
        if (((Get-EpochMs) - $waitStart) -gt $RootWaitMs) {
          Write-Line ([ordered]@{ kind = 'error'; atEpochMs = (Get-EpochMs); message = "root pid file never appeared: $RootPidFile" })
          throw 'root pid file never appeared'
        }
        Start-Sleep -Milliseconds 20
      }
    }
    [void]$tree.Add($RootPid)
    Write-Line ([ordered]@{ kind = 'attached'; atEpochMs = (Get-EpochMs); rootPid = $RootPid; waitedMs = (Get-EpochMs) - $waitStart })
  }

  while ($true) {
    $loopStart = Get-EpochMs
    $sample = Invoke-Sample
    Write-Line $sample
    $sampleIndex++
    $tick++
    $script:lastAtEpochMs = $sample.atEpochMs

    if ($Once) { break }
    if ($StopFile -and (Test-Path -LiteralPath $StopFile)) { break }
    if ($MaxSamples -gt 0 -and $sampleIndex -ge $MaxSamples) { break }

    if ($sample.inTreeCount -eq 0) { $emptyStreak++ } else { $emptyStreak = 0 }
    if ($emptyStreak -ge 40) {
      Write-Line ([ordered]@{ kind = 'error'; atEpochMs = (Get-EpochMs); message = 'tracked tree empty for 40 samples; sampler exits' })
      break
    }
    $elapsed = (Get-EpochMs) - $loopStart
    $wait = $IntervalMs - $elapsed
    if ($wait -gt 0) { Start-Sleep -Milliseconds $wait }
  }
} catch {
  Write-Line ([ordered]@{ kind = 'error'; atEpochMs = (Get-EpochMs); message = "sampler aborted: $($_.Exception.Message)" })
} finally {
  if ($script:cimSession) { try { $script:cimSession | Remove-CimSession } catch { } }
  $self = Get-Process -Id $PID -ErrorAction SilentlyContinue
  Write-Line ([ordered]@{
    kind            = 'meta'
    atEpochMs       = (Get-EpochMs)
    samples         = $sampleIndex
    pid             = $PID
    cpuSeconds      = if ($self) { [double]$self.CPU } else { -1 }
    ws              = if ($self) { [int64]$self.WorkingSet64 } else { -1 }
    intervalMs      = $IntervalMs
    helperAvailable = $helperAvailable
    topologySource  = $topologySource
    warmupMs        = $warmupMs
    trackedPids     = @($tree)
    processNames    = $nameList
    lifetimePeaks   = @($lastPeaks.Values)
  })
}
