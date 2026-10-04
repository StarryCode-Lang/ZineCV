$ErrorActionPreference = 'Stop'
$root = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\..')).Path
$executable = $env:ZINECV_TEST_EXE
if ([string]::IsNullOrWhiteSpace($executable)) {
  $executable = Join-Path $root 'src-tauri\target\release\zinecv-desktop.exe'
}
if (-not (Test-Path -LiteralPath $executable)) {
  throw "Build the release desktop sample before this test: $executable"
}
$artifactRoot = Join-Path $root '.artifacts\native-shell'
New-Item -ItemType Directory -Path $artifactRoot -Force | Out-Null
$testProfile = Join-Path $artifactRoot ([guid]::NewGuid().ToString())
New-Item -ItemType Directory -Path (Join-Path $testProfile 'AppData\Roaming'), (Join-Path $testProfile 'AppData\Local') -Force | Out-Null
$oldAppData = $env:APPDATA
$oldLocalAppData = $env:LOCALAPPDATA
$oldZinecvDataDir = $env:ZINECV_DATA_DIR
$process = $null
try {
  $env:APPDATA = Join-Path $testProfile 'AppData\Roaming'
  $env:LOCALAPPDATA = Join-Path $testProfile 'AppData\Local'
  $env:ZINECV_DATA_DIR = Join-Path $testProfile 'ZineCVData'
  $process = Start-Process -FilePath $executable -PassThru -WindowStyle Hidden
  Start-Sleep -Seconds 3
  $process.Refresh()
  if ($process.HasExited) {
    throw "Release exe exited during native shell smoke test: $($process.ExitCode)"
  }
  if (-not (Test-Path -LiteralPath (Join-Path $env:ZINECV_DATA_DIR 'zinecv.sqlite3'))) {
    throw 'Release exe did not create its database in the isolated data directory'
  }
  Write-Output "PASS: release exe remained running for 3 seconds with isolated ZINECV_DATA_DIR (PID $($process.Id))."
}
finally {
  $env:APPDATA = $oldAppData
  $env:LOCALAPPDATA = $oldLocalAppData
  $env:ZINECV_DATA_DIR = $oldZinecvDataDir
  if ($process) {
    $process.Refresh()
    if (-not $process.HasExited) {
      Stop-Process -Id $process.Id -Force
      $process.WaitForExit()
    }
  }
  $resolvedRoot = [System.IO.Path]::GetFullPath($root).TrimEnd('\') + '\'
  $resolvedProfile = [System.IO.Path]::GetFullPath($testProfile).TrimEnd('\') + '\'
  if (-not $resolvedProfile.StartsWith($resolvedRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing to clean test profile outside the workspace: $resolvedProfile"
  }
  if (Test-Path -LiteralPath $testProfile) {
    Remove-Item -LiteralPath $testProfile -Recurse -Force
  }
}
