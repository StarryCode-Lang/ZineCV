param([switch]$Plan)
$ErrorActionPreference = 'Stop'
if (-not $Plan) {
    $taskIdentity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $taskPrincipal = [Security.Principal.WindowsPrincipal]::new($taskIdentity)
    if ($taskPrincipal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
        Write-Error '请在普通权限 PowerShell 运行验收，不要使用“以管理员身份运行”。WebView2 150+ 会忽略高权限宿主的调试与隔离环境变量，导致 CDP 连接失败。尚未开始构建或测试。'
        exit 2
    }
}
$taskRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
Push-Location -LiteralPath $taskRoot
try {
    if ($Plan) { & node tools/windows-closeout/run.mjs --plan }
    else { & node tools/windows-closeout/run.mjs }
    $taskExit = $LASTEXITCODE
} finally { Pop-Location }
exit $taskExit
