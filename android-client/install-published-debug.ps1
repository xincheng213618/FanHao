param(
  [AllowEmptyString()][string]$Serial = ""
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$ProjectDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoRoot = [IO.Path]::GetFullPath((Join-Path $ProjectDir ".."))
$PublishDir = Join-Path $RepoRoot "data\android-update\debug"
$ManifestPath = Join-Path $PublishDir "latest.json"
$PublishModule = Join-Path $ProjectDir "scripts\FanHaoAndroidPublish.psm1"
Import-Module -Name $PublishModule -Force

function Invoke-CapturedNative {
  param(
    [Parameter(Mandatory = $true)][string]$Command,
    [Parameter(Mandatory = $true)][string[]]$CommandArguments,
    [Parameter(Mandatory = $true)][string]$FailureMessage
  )

  $savedErrorActionPreference = $ErrorActionPreference
  try {
    $ErrorActionPreference = "Continue"
    $output = @(& $Command @CommandArguments 2>&1)
    $exitCode = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $savedErrorActionPreference
  }
  if ($exitCode -ne 0) {
    throw "$FailureMessage (exit $exitCode)`n$($output -join [Environment]::NewLine)"
  }
  return @($output | ForEach-Object { $_.ToString() })
}

$manifest = Read-FanHaoUpdateManifest -Path $ManifestPath
$apkFileProperty = $manifest.PSObject.Properties["apkFile"]
if ($null -eq $apkFileProperty -or $apkFileProperty.Value -isnot [string]) {
  throw "Published debug manifest is missing apkFile: $ManifestPath"
}
$apkFile = $apkFileProperty.Value
if ([IO.Path]::GetFileName($apkFile) -cne $apkFile) {
  throw "Published debug manifest apkFile must be a direct file name: $ManifestPath"
}
$apkPath = Join-Path $PublishDir $apkFile
$apkInspector = { param($Path) Get-FanHaoApkIdentity -Path $Path }
$identity = Assert-FanHaoUpdateManifest -Manifest $manifest -Channel "debug" -ApkPath $apkPath -ExpectedApkFileName $apkFile -ApkInspector $apkInspector -SourcePath $ManifestPath

$sdkRoot = Get-FanHaoAndroidSdkRoot
$adb = Join-Path $sdkRoot "platform-tools\adb.exe"
if (-not (Test-Path -LiteralPath $adb -PathType Leaf)) {
  throw "Android SDK platform-tools adb.exe was not found: $adb"
}

$deviceOutput = Invoke-CapturedNative -Command $adb -CommandArguments @("devices", "-l") -FailureMessage "ADB device query failed"
$authorizedSerials = @($deviceOutput | ForEach-Object {
  $match = [regex]::Match($_, '^(?<serial>\S+)\s+device(?:\s|$)')
  if ($match.Success) { $match.Groups["serial"].Value }
} | Sort-Object -Unique)
if ($authorizedSerials.Count -eq 0) {
  throw "No authorized Android device found. Enable USB debugging and accept the authorization prompt."
}

$requestedSerial = $Serial.Trim()
if ($requestedSerial) {
  if ($requestedSerial -notmatch '^[A-Za-z0-9._:-]+$') {
    throw "ADB serial contains unsupported characters."
  }
  if ($authorizedSerials -cnotcontains $requestedSerial) {
    throw "Requested ADB device is not authorized: $requestedSerial"
  }
  $targetSerial = $requestedSerial
} else {
  if ($authorizedSerials.Count -ne 1) {
    throw "Multiple authorized Android devices found; pass -Serial with the exact target."
  }
  $targetSerial = $authorizedSerials[0]
}

Write-Host "Published APK verified: $($identity.PackageName) $($identity.VersionCode) / $($identity.VersionName)"
Write-Host "  APK: $apkPath"
Write-Host "  Bytes: $($identity.Size)"
Write-Host "  SHA-256: $($identity.Sha256)"
Write-Host "  Signer SHA-256: $($identity.SignerSha256)"
Write-Host "Installing on authorized device: $targetSerial"

$installOutput = Invoke-CapturedNative -Command $adb -CommandArguments @("-s", $targetSerial, "install", "-r", $apkPath) -FailureMessage "ADB install failed"
if (-not ($installOutput | Where-Object { $_ -ceq "Success" })) {
  throw "ADB did not confirm a successful install.`n$($installOutput -join [Environment]::NewLine)"
}

$packageOutput = Invoke-CapturedNative -Command $adb -CommandArguments @("-s", $targetSerial, "shell", "dumpsys", "package", $identity.PackageName) -FailureMessage "ADB package verification failed"
$installedVersionCode = @($packageOutput | ForEach-Object {
  $match = [regex]::Match($_, '^\s*versionCode=(?<code>\d+)(?:\s|$)')
  if ($match.Success) { [long]$match.Groups["code"].Value }
} | Sort-Object -Unique)
$installedVersionName = @($packageOutput | ForEach-Object {
  $match = [regex]::Match($_, '^\s*versionName=(?<name>.*)$')
  if ($match.Success) { $match.Groups["name"].Value.Trim() }
} | Sort-Object -Unique)
if ($installedVersionCode.Count -ne 1 -or $installedVersionCode[0] -ne $identity.VersionCode -or
    $installedVersionName.Count -ne 1 -or $installedVersionName[0] -cne $identity.VersionName) {
  throw "Installed package identity does not match the published manifest."
}

$installOutput | ForEach-Object { Write-Host $_ }
Write-Host "Published debug install verified: $targetSerial -> $($identity.VersionCode) / $($identity.VersionName)"
