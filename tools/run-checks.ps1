# 日常默认只跑 fast，不触发原生编译、打包或长测。
# 按改动选择 -Scope；-Plan 只展示范围和自动补齐的依赖。
param(
  [ValidateSet('Fast', 'Regression', 'UI', 'Native', 'Agent', 'Recovery', 'Full')]
  [string]$Scope = 'Fast',
  [switch]$Plan
)
$ErrorActionPreference = 'Stop'
$projectRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
Set-Location -LiteralPath $projectRoot
$suite = if ($Scope -eq 'Fast') { 'daily' } else { $Scope.ToLowerInvariant() }
$verifyArgs = @('tools/verify-project.mjs', '--suite', $suite, '--fail-fast')
if ($Plan) { $verifyArgs += '--plan' }
node @verifyArgs
exit $LASTEXITCODE
