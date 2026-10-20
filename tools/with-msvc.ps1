param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('dev-build', 'fmt', 'check', 'test', 'hooks-test', 'hooks-build', 'poc-test', 'bindings', 'dev', 'build', 'bundle', 'poc', 'poc-release', 'engine-render-release', 'wasm-build', 'wasm-check', 'platform-reference', 'ohos-build', 'ohos-test')]
  [string]$Task,
  [ValidateSet('zinecv-desktop', 'zinecv-contracts', 'zinecv-domain', 'zinecv-engine', 'zinecv-storage', 'zinecv-agent', 'zinecv-native', 'zinecv-assets')]
  [string]$Package
)

$ErrorActionPreference = 'Stop'
$projectRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
Set-Location -LiteralPath $projectRoot
$targetDirectory = Join-Path $projectRoot 'src-tauri\target'
New-Item -ItemType Directory -Path $targetDirectory -Force | Out-Null
$env:CARGO_TARGET_DIR = [System.IO.Path]::GetFullPath($targetDirectory)
# ts-rs 绑定导出基准（C+ Phase 1a）：contracts 与 src-tauri 两个 crate 的 export_bindings
# 测试必须共用同一绝对基准目录，否则跨类型相对导入会被 diff_paths 算错层级。
$env:TS_RS_EXPORT_DIR = [System.IO.Path]::GetFullPath((Join-Path $projectRoot 'src-tauri\bindings'))
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

if ($Task -in @('wasm-build', 'wasm-check')) {
  if (-not $env:CC_wasm32_unknown_unknown) {
    $wasmCompiler = Join-Path $env:LOCALAPPDATA 'Codex\toolchains\llvm-23.1.3\clang+llvm-23.1.3-x86_64-pc-windows-msvc\bin\clang.exe'
    if (-not (Test-Path -LiteralPath $wasmCompiler)) { throw 'WASM SQLite needs LLVM with wasm32 support. Set CC_wasm32_unknown_unknown and AR_wasm32_unknown_unknown to the external toolchain.' }
    $env:CC_wasm32_unknown_unknown = $wasmCompiler
    $env:AR_wasm32_unknown_unknown = Join-Path (Split-Path $wasmCompiler) 'llvm-ar.exe'
  }
}
if ($Task -eq 'ohos-build') {
  $ohosSdk = $env:ZINECV_OHOS_NATIVE
  if (-not $ohosSdk) { $ohosSdk = Join-Path $env:LOCALAPPDATA 'Codex\toolchains\openharmony-6.0.0.47\sdk\native' }
  $ohosClang = Join-Path $ohosSdk 'llvm\bin\clang.exe'
  if (-not (Test-Path -LiteralPath $ohosClang)) { throw 'OpenHarmony native SDK missing; set ZINECV_OHOS_NATIVE to native SDK outside the project.' }
  $ohosSysroot = Join-Path $ohosSdk 'sysroot'
  $ohosLinker = Join-Path $taskTempRoot 'ohos-clang.cmd'
  $ohosLinkText = '@echo off' + [Environment]::NewLine + '"' + $ohosClang + '" --target=aarch64-linux-ohos --sysroot="' + $ohosSysroot + '" -D__MUSL__ %*' + [Environment]::NewLine
  [IO.File]::WriteAllText($ohosLinker, $ohosLinkText, [Text.Encoding]::ASCII)
  $env:CARGO_TARGET_AARCH64_UNKNOWN_LINUX_OHOS_LINKER = $ohosLinker
  $env:CC_aarch64_unknown_linux_ohos = $ohosClang
  $env:AR_aarch64_unknown_linux_ohos = Join-Path $ohosSdk 'llvm\bin\llvm-ar.exe'
  $env:CC_SHELL_ESCAPED_FLAGS = '1'
  $env:CFLAGS_aarch64_unknown_linux_ohos = '--target=aarch64-linux-ohos --sysroot="' + $ohosSysroot + '" -D__MUSL__'
}
if ($Package -and $Task -notin @('check', 'test', 'fmt')) { throw '-Package is only supported for check, test, and fmt.' }
$cargoSelection = if ($Package) { '--package ' + $Package } else { '--workspace' }
$fmtSelection = if ($Package) { '--package ' + $Package } else { '--all' }
$command = switch ($Task) {
  # C+ Phase 1a：领域 schema/逻辑已抽到 crates/zinecv-contracts 与 crates/zinecv-domain，
  # 三处任务对其做同强度 fmt/clippy/test 门禁；绑定仍统一生成到 src-tauri/src/domain/bindings。
  'fmt' { "cargo fmt $fmtSelection" }
  'check' { "cargo fmt $fmtSelection -- --check && cargo clippy --locked $cargoSelection --all-targets -- -D warnings" }
  'test' { "cargo test --locked $cargoSelection --lib --bins" }
  'hooks-test' { 'cargo clippy --manifest-path src-tauri\Cargo.toml --locked --all-targets --features test-hooks -- -D warnings && cargo test --manifest-path src-tauri\Cargo.toml --locked --features test-hooks && cargo clippy --manifest-path crates\zinecv-storage\Cargo.toml --locked --all-targets --features test-hooks -- -D warnings && cargo test --manifest-path crates\zinecv-storage\Cargo.toml --locked --features test-hooks' }
  'hooks-build' { 'node tools\build-receipt.mjs --run build:native-hooks' }
  'poc-test' { 'cargo test --manifest-path src-tauri\Cargo.toml --locked --example typst_poc' }
  # C+ P1b：全部 106 个 ts-rs 导出类型集中于 crates/zinecv-contracts，绑定由该
  # crate 的 export_bindings 测试统一生成（经上方共享绝对 TS_RS_EXPORT_DIR 基准）。
  'bindings' { 'cargo test --manifest-path crates\zinecv-contracts\Cargo.toml --locked export_bindings' }
  'dev-build' { 'cargo build --manifest-path src-tauri\Cargo.toml --locked --bin zinecv-desktop' }
  'dev' { 'node_modules\.bin\tauri.cmd dev' }
  'build' { 'node tools\build-receipt.mjs --run build:native' }
  'bundle' { 'node_modules\.bin\tauri.cmd build' }
  'poc' { 'cargo run --manifest-path src-tauri\Cargo.toml --locked --example typst_poc' }
  'poc-release' { 'node tools\build-receipt.mjs --run build:engine-poc' }
  'engine-render-release' { 'node tools\build-receipt.mjs --run build:engine-render' }
  # Windows hosts the WASM toolchain and its native build scripts; output shares
  # the existing target root and is removed with the other rebuildable products.
  'ohos-build' { 'cargo build --manifest-path crates\zinecv-ohos\Cargo.toml --locked --release --target aarch64-unknown-linux-ohos' }
  'ohos-test' { 'cargo clippy --manifest-path crates\zinecv-ohos\Cargo.toml --locked --all-targets -- -D warnings && cargo test --manifest-path crates\zinecv-ohos\Cargo.toml --locked' }
  'platform-reference' { 'cargo build --manifest-path crates\zinecv-engine\Cargo.toml --locked --release --example platform_reference && cargo build --manifest-path crates\zinecv-storage\Cargo.toml --locked --release --example platform_backup' }
  'wasm-check' { 'cargo fmt --manifest-path crates\zinecv-wasm\Cargo.toml --all -- --check && cargo clippy --manifest-path crates\zinecv-wasm\Cargo.toml --locked --release --target wasm32-unknown-unknown -- -D warnings' }
  'wasm-build' { 'cargo build --manifest-path crates\zinecv-wasm\Cargo.toml --locked --release --target wasm32-unknown-unknown' }
}

& cmd.exe /d /s /c "call `"$vcvars`" >nul && $command"
exit $LASTEXITCODE
