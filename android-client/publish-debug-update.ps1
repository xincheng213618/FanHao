param(
  $VersionCode = $null,
  [AllowNull()][AllowEmptyString()][string]$VersionName = $null,
  [string]$Notes = "Debug update",
  [string]$PublishRoot = "",
  [switch]$Install,
  [switch]$PlanOnly
)

$ErrorActionPreference = "Stop"

$ProjectDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoDir = Split-Path -Parent $ProjectDir
$BuildScript = Join-Path $ProjectDir "build-debug.ps1"
$PublishModule = Join-Path $ProjectDir "scripts\FanHaoAndroidPublish.psm1"
$ApkPath = Join-Path $ProjectDir "android\app\build\outputs\apk\debug\app-debug.apk"
$LocalOnlyMarkerPath = "$ApkPath.local-only.json"
$VersionCodeWasSpecified = $PSBoundParameters.ContainsKey("VersionCode")
$VersionNameWasSpecified = $PSBoundParameters.ContainsKey("VersionName")

Import-Module -Name $PublishModule -Force

if ($VersionNameWasSpecified -and [string]::IsNullOrWhiteSpace($VersionName)) {
  throw "Explicit versionName must be non-empty after trimming."
}
if ([string]::IsNullOrWhiteSpace($PublishRoot)) {
  $PublishRoot = Join-Path $RepoDir "data\android-update"
}
$PublishRoot = [IO.Path]::GetFullPath($PublishRoot)
$UpdateDir = Join-Path $PublishRoot "debug"

if (-not (Test-Path -LiteralPath $PublishRoot)) {
  $null = New-Item -ItemType Directory -Path $PublishRoot -Force
}
$publishRootItem = Get-Item -LiteralPath $PublishRoot -Force
if (-not $publishRootItem.PSIsContainer -or ($publishRootItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
  throw "Publish root must be a real directory, not a reparse point: $PublishRoot"
}

$lockPath = Join-Path $PublishRoot ".fanhao-android-publish.lock"
try {
  $lockStream = [IO.File]::Open($lockPath, [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
} catch {
  throw "Another Android publish is already running for $PublishRoot"
}

try {
  $requestedCode = if ($null -eq $VersionCode) { 0L } else { $VersionCode }
  $requestedName = if ($VersionNameWasSpecified) { $VersionName } else { $null }
  $plan = Get-FanHaoDebugPublishPlan `
    -PublishRoot $PublishRoot `
    -TargetApkPath $ApkPath `
    -HasRequestedVersionCode $VersionCodeWasSpecified `
    -RequestedVersionCode $requestedCode `
    -RequestedVersionName $requestedName

  Write-Host "Android debug publish high-water mark: $($plan.HistoryMaximum)"
  Write-Host "Selected publish identity: $($plan.VersionCode) / $($plan.VersionName)"
  if ($PlanOnly) { return $plan }

  $buildArgs = @{
    VersionCode = $plan.VersionCode
    VersionName = $plan.VersionName
  }
  if ($Install) { $buildArgs.Install = $true }

  & $BuildScript @buildArgs
  if ($LASTEXITCODE -ne 0) {
    throw "Android debug build failed (exit $LASTEXITCODE)"
  }
  if (-not (Test-Path -LiteralPath $ApkPath)) {
    throw "APK was not produced: $ApkPath"
  }
  if (Test-Path -LiteralPath $LocalOnlyMarkerPath) {
    throw "The built APK is marked local-only and cannot be published: $LocalOnlyMarkerPath"
  }

  $historyOnlyTarget = "$ApkPath.publish-history-excluded-$([Guid]::NewGuid().ToString('N'))"
  $preCommitPlan = Get-FanHaoDebugPublishPlan `
    -PublishRoot $PublishRoot `
    -TargetApkPath $historyOnlyTarget `
    -HasRequestedVersionCode $true `
    -RequestedVersionCode $plan.VersionCode `
    -RequestedVersionName $plan.VersionName
  if ($preCommitPlan.VersionCode -ne $plan.VersionCode -or $preCommitPlan.VersionName -cne $plan.VersionName) {
    throw "Android publish identity changed during the build; refusing to commit."
  }

  $noteList = if ($Notes) { @($Notes) } else { @() }
  $published = Publish-FanHaoDebugArtifact `
    -SourceApkPath $ApkPath `
    -UpdateDir $UpdateDir `
    -VersionCode $plan.VersionCode `
    -VersionName $plan.VersionName `
    -Notes $noteList

  Write-Host "Debug update published atomically:"
  Write-Host "  APK: $($published.ApkPath)"
  Write-Host "  Manifest: $($published.ManifestPath)"
  Write-Host "  Package: $($published.PackageName)"
  Write-Host "  Signer SHA-256: $($published.SignerSha256)"
  Write-Host "  API: /api/android/update?channel=debug"
} finally {
  if ($null -ne $lockStream) { $lockStream.Dispose() }
}
