param(
  [int]$VersionCode = 0,
  [string]$VersionName = "",
  [string]$Notes = "调试版更新",
  [switch]$Install
)

$ErrorActionPreference = "Stop"

$ProjectDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoDir = Split-Path -Parent $ProjectDir
$BuildScript = Join-Path $ProjectDir "build-debug.ps1"
$ApkPath = Join-Path $ProjectDir "android\app\build\outputs\apk\debug\app-debug.apk"
$UpdateDir = Join-Path $RepoDir "data\android-update\debug"
$LatestPath = Join-Path $UpdateDir "latest.json"

if ($VersionCode -le 0) {
  $dateBase = [int](Get-Date -Format "yyMMdd00")
  $previousCode = 0
  if (Test-Path -LiteralPath $LatestPath) {
    try {
      $previous = Get-Content -LiteralPath $LatestPath -Raw | ConvertFrom-Json
      if ($null -ne $previous.versionCode) {
        $previousCode = [int]$previous.versionCode
      }
    } catch {
      $previousCode = 0
    }
  }
  $VersionCode = [Math]::Max($dateBase, $previousCode + 1)
}

if (-not $VersionName) {
  $VersionName = "0.1.$VersionCode-debug"
}

$buildArgs = @{
  VersionCode = $VersionCode
  VersionName = $VersionName
}
if ($Install) {
  $buildArgs.Install = $true
}

& $BuildScript @buildArgs

if (-not (Test-Path -LiteralPath $ApkPath)) {
  throw "APK was not produced: $ApkPath"
}

New-Item -ItemType Directory -Path $UpdateDir -Force | Out-Null

$fileName = "fanhao-debug-$VersionCode.apk"
$targetApk = Join-Path $UpdateDir $fileName
Copy-Item -LiteralPath $ApkPath -Destination $targetApk -Force

$item = Get-Item -LiteralPath $targetApk
$hash = Get-FileHash -LiteralPath $targetApk -Algorithm SHA256
$noteList = @()
if ($Notes) {
  $noteList = @($Notes)
}

$manifest = [ordered]@{
  channel = "debug"
  versionCode = $VersionCode
  versionName = $VersionName
  apkFile = $fileName
  notes = $noteList
  updatedAt = (Get-Date).ToUniversalTime().ToString("o")
  size = $item.Length
  sha256 = $hash.Hash.ToLowerInvariant()
}

$manifest | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $LatestPath -Encoding UTF8

Write-Host "Debug update published:"
Write-Host "  APK: $targetApk"
Write-Host "  Manifest: $LatestPath"
Write-Host "  API: /api/android/update?channel=debug"
