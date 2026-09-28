param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('check', 'test', 'poc-test', 'bindings', 'build', 'bundle', 'poc', 'poc-release')]
  [string]$Task
)

$ErrorActionPreference = 'Stop'
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
  'check' { 'cargo fmt --manifest-path src-tauri\Cargo.toml --all -- --check && cargo clippy --manifest-path src-tauri\Cargo.toml --locked --all-targets -- -D warnings' }
  'test' { 'cargo test --manifest-path src-tauri\Cargo.toml --locked' }
  'poc-test' { 'cargo test --manifest-path src-tauri\Cargo.toml --locked --example typst_poc' }
  'bindings' { 'cargo test --manifest-path src-tauri\Cargo.toml --locked domain::export_bindings' }
  'build' { 'node_modules\.bin\tauri.cmd build --no-bundle' }
  'bundle' { 'node_modules\.bin\tauri.cmd build' }
  'poc' { 'cargo run --manifest-path src-tauri\Cargo.toml --locked --example typst_poc' }
  'poc-release' { 'cargo build --manifest-path src-tauri\Cargo.toml --locked --release --example typst_poc' }
}

& cmd.exe /d /s /c "call `"$vcvars`" >nul && $command"
exit $LASTEXITCODE
