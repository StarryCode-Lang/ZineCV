param(
  [switch]$Publish,
  [switch]$SkipBuild,
  [string]$NotesPath
)

$ErrorActionPreference = 'Stop'
$taskRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
Set-Location -LiteralPath $taskRoot
$taskConfig = Get-Content -LiteralPath 'src-tauri/tauri.conf.json' -Raw | ConvertFrom-Json
$taskVersion = $taskConfig.version
$taskRepository = 'StarryCode-Lang/ZineCV'
$taskEndpoint = "https://github.com/$taskRepository/releases/download/updates/latest.json"
if ($taskConfig.productName -ne 'ZineCV' -or $taskConfig.identifier -ne 'com.zinecv.desktop' -or
    -not $taskConfig.plugins.updater.requireSignedVersion -or
    @($taskConfig.plugins.updater.endpoints).Count -ne 1 -or
    $taskConfig.plugins.updater.endpoints[0] -ne $taskEndpoint) {
  throw 'Production identity, HTTPS channel and version-bound signatures are required.'
}
foreach ($taskName in @('ZINECV_UPDATER_ENDPOINT', 'ZINECV_UPDATER_PUBKEY')) {
  if ([Environment]::GetEnvironmentVariable($taskName)) { throw "$taskName must be unset; production configuration comes from tauri.conf.json." }
}
$taskSigningRoot = Join-Path $env:USERPROFILE '.zinecv/signing'
$taskKeyPath = Join-Path $taskSigningRoot 'windows-updater.key'
$taskPasswordPath = Join-Path $taskSigningRoot 'windows-updater.password.dpapi'
if ((Get-Content -LiteralPath "$taskKeyPath.pub" -Raw).Trim() -ne $taskConfig.plugins.updater.pubkey) {
  throw 'The local signing key does not match the embedded production public key.'
}
$taskOutput = Join-Path $taskRoot ".artifacts/releases/$taskVersion"
New-Item -ItemType Directory -Path $taskOutput -Force | Out-Null
$taskPreviousKey = $env:TAURI_SIGNING_PRIVATE_KEY
$taskPreviousPassword = $env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD
$taskPreviousOutput = $env:ZINECV_CLOSEOUT_OUT_DIR
try {
  $taskSecurePassword = (Get-Content -LiteralPath $taskPasswordPath -Raw).Trim() | ConvertTo-SecureString
  $taskPasswordPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($taskSecurePassword)
  try { $env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($taskPasswordPointer) }
  finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($taskPasswordPointer) }
  $env:TAURI_SIGNING_PRIVATE_KEY = $taskKeyPath
  if (-not $SkipBuild) {
    & powershell -NoProfile -ExecutionPolicy Bypass -File tools/with-msvc.ps1 build
    if ($LASTEXITCODE -ne 0) { throw 'Production build failed.' }
    $env:ZINECV_CLOSEOUT_OUT_DIR = $taskOutput
    & node tools/windows-closeout/package-online.mjs
    if ($LASTEXITCODE -ne 0) { throw 'Installer packaging or executable restoration failed.' }
    $taskInstallerName = "ZineCV_${taskVersion}_x64-setup.exe"
    $taskInstaller = Join-Path $taskOutput $taskInstallerName
    Copy-Item -LiteralPath (Join-Path $taskRoot "src-tauri/target/release/bundle/nsis/$taskInstallerName") -Destination $taskInstaller
    Copy-Item -LiteralPath (Join-Path $taskRoot "src-tauri/target/release/bundle/nsis/$taskInstallerName.sig") -Destination "$taskInstaller.sig"
    Copy-Item -LiteralPath 'src-tauri/target/release/zinecv-desktop.exe' -Destination (Join-Path $taskOutput 'zinecv-desktop.exe')
    Copy-Item -LiteralPath '.artifacts/build-receipts/build-native.json' -Destination (Join-Path $taskOutput 'build-native.json')
    $taskMetadata = (Get-Item -LiteralPath $taskInstaller).VersionInfo
    $taskExeMetadata = (Get-Item -LiteralPath (Join-Path $taskOutput 'zinecv-desktop.exe')).VersionInfo
    if ($taskExeMetadata.ProductName -ne 'ZineCV' -or $taskExeMetadata.ProductVersion -ne $taskVersion) {
      throw 'Produced executable has the wrong production identity/version.'
    }
    $taskManifest = [ordered]@{
      version = $taskVersion
      notes = 'Windows 自动更新、安全收束与编辑性能修复。'
      pub_date = [DateTime]::UtcNow.ToString('o')
      platforms = @{ 'windows-x86_64' = @{
        signature = (Get-Content -LiteralPath "$taskInstaller.sig" -Raw).Trim()
        url = "https://github.com/$taskRepository/releases/download/v$taskVersion/$taskInstallerName"
      } }
    }
    [IO.File]::WriteAllText((Join-Path $taskOutput 'latest.json'), ($taskManifest | ConvertTo-Json -Depth 8) + "`n", [Text.UTF8Encoding]::new($false))
    $taskHashes = @($taskInstaller, "$taskInstaller.sig", (Join-Path $taskOutput 'zinecv-desktop.exe')) | ForEach-Object {
      '{0}  {1}' -f (Get-FileHash -LiteralPath $_ -Algorithm SHA256).Hash.ToLowerInvariant(), [IO.Path]::GetFileName($_)
    }
    [IO.File]::WriteAllLines((Join-Path $taskOutput 'SHA256SUMS.txt'), $taskHashes, [Text.UTF8Encoding]::new($false))
  }
  if ($Publish) {
    if (git status --porcelain) { throw 'Commit the reviewed source and evidence before publishing.' }
    if (-not $NotesPath -or -not (Test-Path -LiteralPath $NotesPath)) { throw 'Publishing requires a reviewed release-notes file.' }
    $taskTag = "v$taskVersion"
    $taskInstaller = Join-Path $taskOutput "ZineCV_${taskVersion}_x64-setup.exe"
    & gh release create $taskTag $taskInstaller "$taskInstaller.sig" (Join-Path $taskOutput 'SHA256SUMS.txt') --repo $taskRepository --target (git rev-parse HEAD) --title "ZineCV $taskVersion" --prerelease --notes-file $NotesPath
    if ($LASTEXITCODE -ne 0) { throw 'Versioned release publication failed; update channel was not changed.' }
    & gh release view updates --repo $taskRepository *> $null
    if ($LASTEXITCODE -ne 0) {
      & gh release create updates --repo $taskRepository --target (git rev-parse HEAD) --title 'Windows update channel' --prerelease --notes 'Signed Windows update manifest. Installers are attached to versioned releases.'
      if ($LASTEXITCODE -ne 0) { throw 'Unable to create update channel.' }
    }
    & gh release upload updates (Join-Path $taskOutput 'latest.json') --repo $taskRepository --clobber
    if ($LASTEXITCODE -ne 0) { throw 'Unable to publish the update manifest.' }
  }
  Write-Output "Production artifacts: $taskOutput"
} finally {
  $env:TAURI_SIGNING_PRIVATE_KEY = $taskPreviousKey
  $env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = $taskPreviousPassword
  $env:ZINECV_CLOSEOUT_OUT_DIR = $taskPreviousOutput
}
