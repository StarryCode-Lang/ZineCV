# Windows 功能验收；默认补集，-Complete 跑完整34项。-Plan 仅查看。
# 其他平台加 -Platforms；内存专项加 -Measurements，保留120s x3和30min x3。
param([string]$OutDir = "", [switch]$Complete, [switch]$Plan, [switch]$Platforms, [switch]$Measurements)
$ErrorActionPreference = 'Stop'
$projectRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
Set-Location -LiteralPath $projectRoot
if (-not $Complete) { $env:ZINECV_ACCEPT_REMAINING = '1' }
else { Remove-Item Env:ZINECV_ACCEPT_REMAINING -ErrorAction SilentlyContinue }
$acceptArguments = @()
if ($Platforms) { $acceptArguments += '--platforms' }
if ($Measurements) { $acceptArguments += '--measurements' }
if ($Plan) {
  node tools/accept-project.mjs @acceptArguments --plan
  exit $LASTEXITCODE
}

if ($Platforms) {
# 项目外 wasm 工具链只在显式跨平台验收时准备。
$clang = 'D:\tmp\llvm\bin\clang.exe'
if (Test-Path -LiteralPath $clang) {
  $env:CC_wasm32_unknown_unknown = $clang
  $env:AR_wasm32_unknown_unknown = 'D:\tmp\llvm\bin\llvm-ar.exe'
} else {
  Write-Warning "wasm clang missing at $clang; wasm/web stages will fail"
}
$bindgen = Join-Path $env:USERPROFILE '.cargo\bin\wasm-bindgen.exe'
if (Test-Path -LiteralPath $bindgen) {
  $env:ZINECV_WASM_BINDGEN = $bindgen
} else {
  Write-Warning "wasm-bindgen missing at $bindgen; web stages will fail"
}

}

if ($OutDir -ne "") {
  $env:ZINECV_CLOSURE_BATCH_OUT_DIR = (Join-Path $projectRoot $OutDir)
}

node tools/accept-project.mjs @acceptArguments
exit $LASTEXITCODE
