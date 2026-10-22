param([int]$InspectProcessId = 0)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
public static class ZineCloseoutTokenProbe {
    [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr OpenProcess(uint access, bool inherit, int id);
    [DllImport("advapi32.dll", SetLastError=true)] static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
    [DllImport("advapi32.dll", SetLastError=true)] static extern bool GetTokenInformation(IntPtr token, int kind, out int value, int length, out int returned);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
    public static bool Elevated(int id) {
        IntPtr process = OpenProcess(0x1000, false, id);
        if (process == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
        try {
            IntPtr token;
            if (!OpenProcessToken(process, 8, out token)) throw new Win32Exception(Marshal.GetLastWin32Error());
            try {
                int value, returned;
                if (!GetTokenInformation(token, 20, out value, 4, out returned)) throw new Win32Exception(Marshal.GetLastWin32Error());
                return value != 0;
            } finally { CloseHandle(token); }
        } finally { CloseHandle(process); }
    }
}
'@
$taskProbeId = if ($InspectProcessId -gt 0) { $InspectProcessId } else { $PID }
$taskElevated = [ZineCloseoutTokenProbe]::Elevated($taskProbeId)
$taskResult = [ordered]@{ processId=$taskProbeId; elevated=$taskElevated; status='passed'; inspectOnly=($InspectProcessId -gt 0) }
if ($taskElevated) {
    $taskResult.status = 'rejected-elevated'
    $taskResult.message = 'Run in ordinary, non-administrator PowerShell. WebView2 150+ ignores elevated-host WEBVIEW2_* environment overrides, breaking CDP and profile isolation. No build/test has started.'
    $taskResult | ConvertTo-Json -Compress
    exit 2
}
if ($InspectProcessId -eq 0) {
    $taskProcesses = @(Get-CimInstance Win32_Process | Where-Object {
        $_.Name -eq 'zinecv-desktop.exe' -or
        ($_.Name -eq 'node.exe' -and $_.CommandLine -match 'tools[/\\](verify-project|accept-project)\.mjs')
    } | Select-Object ProcessId,Name)
    if ($taskProcesses.Count -gt 0) {
        $taskResult.status = 'rejected-active-processes'
        $taskResult.processes = $taskProcesses
        $taskResult | ConvertTo-Json -Compress
        exit 3
    }
    if (Test-Path -LiteralPath 'HKCU:/Software/Microsoft/Windows/CurrentVersion/Uninstall/ZineCV') {
        $taskResult.status = 'rejected-existing-installation'
        $taskResult.message = 'An existing registered ZineCV installation must be reviewed before the isolated installation test.'
        $taskResult | ConvertTo-Json -Compress
        exit 4
    }
}
$taskResult | ConvertTo-Json -Compress
