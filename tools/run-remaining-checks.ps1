# 一次性完整验收入口：在项目目录下执行
#   powershell -NoProfile -ExecutionPolicy Bypass -File tools\run-remaining-checks.ps1 -Complete
# 可选：-OutDir <相对目录> 指定结果目录（默认 .artifacts\acceptance-runs\<时间戳>）
# 链路：预检 -> 原生构建 -> full 34 -> wasm -> Browser/WASM 对照 -> NSIS 打包
#       -> standard 120s x3 -> extended 30min x3；仅测量预算就96分钟，冷编译另计。
# 默认使用常用回归的补集，-Complete 执行兼容完整链；-Plan 只显示计划，不创建验收批次。
param([string]$OutDir = "", [switch]$Complete, [switch]$Plan)
$ErrorActionPreference = 'Stop'
$projectRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
Set-Location -LiteralPath $projectRoot
if (-not $Complete) { $env:ZINECV_ACCEPT_REMAINING = '1' }
else { Remove-Item Env:ZINECV_ACCEPT_REMAINING -ErrorAction SilentlyContinue }
if ($Plan) {
  node tools/accept-project.mjs --plan
  exit $LASTEXITCODE
}

# 项目外 wasm 工具链（缺失时 wasm/web 阶段会失败；桌面阶段不受影响）。
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

if ($OutDir -ne "") {
  $env:ZINECV_CLOSURE_BATCH_OUT_DIR = (Join-Path $projectRoot $OutDir)
}

node tools/accept-project.mjs
exit $LASTEXITCODE
