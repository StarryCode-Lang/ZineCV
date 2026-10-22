$ErrorActionPreference='Stop'
$taskRoot=(Resolve-Path -LiteralPath '.').Path
$taskOut=Join-Path $env:ZINECV_CLOSEOUT_OUT_DIR 'installation'
if(Get-Process -Name 'zinecv-desktop' -ErrorAction SilentlyContinue){throw 'A host is running; do not install concurrently'}
if(Test-Path -LiteralPath 'HKCU:/Software/Microsoft/Windows/CurrentVersion/Uninstall/ZineCV'){throw 'An existing registered installation needs review before this isolated lifecycle test'}
New-Item -ItemType Directory -Path $taskOut -Force | Out-Null
$taskRegistry=Join-Path $taskOut 'original-program-location.reg'
& reg.exe export 'HKCU\Software\zinecv\ZineCV' $taskRegistry /y
if($LASTEXITCODE -ne 0){throw 'Cannot capture existing program location'}
$taskResult=1
try { & node 'tools/windows-closeout/install-lifecycle.mjs'; $taskResult=$LASTEXITCODE }
finally {
 $taskUninstaller=Join-Path $taskOut '中文安装/uninstall.exe'
 if(Test-Path -LiteralPath $taskUninstaller){ & $taskUninstaller /S ('_?='+ (Join-Path $taskOut '中文安装')); if($LASTEXITCODE -ne 0){Write-Warning 'Synthetic installation cleanup failed; retain for diagnosis'} }
 & reg.exe import $taskRegistry
 if($LASTEXITCODE -ne 0){throw 'Original program-location registry restoration failed; backup retained'}
}
exit $taskResult
