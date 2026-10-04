param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('fmt', 'check', 'test', 'hooks-test', 'hooks-build', 'poc-test', 'bindings', 'dev', 'build', 'bundle', 'poc', 'poc-release', 'engine-render-release')]
  [string]$Task
)

$ErrorActionPreference = 'Stop'
$projectRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
Set-Location -LiteralPath $projectRoot
$targetDirectory = Join-Path $projectRoot 'src-tauri\target'
New-Item -ItemType Directory -Path $targetDirectory -Force | Out-Null
$env:CARGO_TARGET_DIR = [System.IO.Path]::GetFullPath($targetDirectory)
$taskTempRoot = Join-Path $projectRoot '.artifacts\runtime-tmp'
New-Item -ItemType Directory -Path $taskTempRoot -Force | Out-Null
$env:TEMP = $taskTempRoot
$env:TMP = $taskTempRoot
# Native bundles borrow engine font bytes; browser/dev fixtures keep public fonts.
if ($Task -in @('build', 'bundle', 'hooks-build')) {
  $env:ZINECV_RELEASE_FONTS = 'engine'
} else {
  Remove-Item Env:ZINECV_RELEASE_FONTS -ErrorAction SilentlyContinue
}
$vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
if (-not (Test-Path -LiteralPath $vswhere)) {
  throw 'Visual Studio Build Tools discovery (vswhere.exe) is missing.'
}
$candidates = @(& $vswhere -latest -products '*' -property installationPath)
$visualStudioRoot = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio'
if (Test-Path -LiteralPath $visualStudioRoot) {
  $candidates += @(Get-ChildItem -LiteralPath $visualStudioRoot -Directory | ForEach-Object {
    Get-ChildItem -LiteralPath $_.FullName -Directory | Select-Object -ExpandProperty FullName
  })
}
$vcvars = $null
foreach ($candidate in $candidates) {
  if ([string]::IsNullOrWhiteSpace($candidate)) { continue }
  $possible = Join-Path $candidate 'VC\Auxiliary\Build\vcvars64.bat'
  if (Test-Path -LiteralPath $possible) {
    $vcvars = $possible
    break
  }
}
if (-not $vcvars) { throw 'MSVC x64 Build Tools (vcvars64.bat) are required for the Windows desktop build.' }

$command = switch ($Task) {
  'fmt' { 'cargo fmt --manifest-path src-tauri\Cargo.toml --all' }
  'check' { 'cargo fmt --manifest-path src-tauri\Cargo.toml --all -- --check && cargo clippy --manifest-path src-tauri\Cargo.toml --locked --all-targets -- -D warnings' }
  'test' { 'cargo test --manifest-path src-tauri\Cargo.toml --locked' }
  'hooks-test' { 'cargo clippy --manifest-path src-tauri\Cargo.toml --locked --all-targets --features test-hooks -- -D warnings && cargo test --manifest-path src-tauri\Cargo.toml --locked --features test-hooks' }
  'hooks-build' { 'node tools\build-receipt.mjs --run build:native-hooks' }
  'poc-test' { 'cargo test --manifest-path src-tauri\Cargo.toml --locked --example typst_poc' }
  'bindings' { 'cargo test --manifest-path src-tauri\Cargo.toml --locked domain::export_bindings' }
  'dev' { 'node_modules\.bin\tauri.cmd dev' }
  'build' { 'node tools\build-receipt.mjs --run build:native' }
  'bundle' { 'node_modules\.bin\tauri.cmd build' }
  'poc' { 'cargo run --manifest-path src-tauri\Cargo.toml --locked --example typst_poc' }
  'poc-release' { 'node tools\build-receipt.mjs --run build:engine-poc' }
  'engine-render-release' { 'node tools\build-receipt.mjs --run build:engine-render' }
}

& cmd.exe /d /s /c "call `"$vcvars`" >nul && $command"
exit $LASTEXITCODE
