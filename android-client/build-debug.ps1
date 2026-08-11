param(
  [switch]$Install,
  [switch]$NoSync,
  $VersionCode = $null,
  [AllowEmptyString()][string]$VersionName = "",
  [switch]$LocalOnly,
  [switch]$IdentityOnly
)

$ErrorActionPreference = "Stop"

$ProjectDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$AndroidDir = Join-Path $ProjectDir "android"
$ApkPath = Join-Path $AndroidDir "app\build\outputs\apk\debug\app-debug.apk"
$LocalOnlyMarkerPath = "$ApkPath.local-only.json"
$LocalOnlyGuardPath = Join-Path $AndroidDir "app\build\outputs\apk\app-debug.local-only.guard.json"
$PublishModule = Join-Path $ProjectDir "scripts\FanHaoAndroidPublish.psm1"
$VersionContractPath = Join-Path $ProjectDir "version.json"
$VersionCodeWasSpecified = $PSBoundParameters.ContainsKey("VersionCode")
$VersionNameWasSpecified = $PSBoundParameters.ContainsKey("VersionName")
Import-Module -Name $PublishModule -Force

if ($Install -and $LocalOnly) {
  throw "-LocalOnly is restricted to non-installing local builds and cannot be combined with -Install."
}
if ($Install -and $IdentityOnly) {
  throw "-IdentityOnly is a non-installing policy probe and cannot be combined with -Install."
}
$Jdk21Candidates = @(
  "C:\Program Files\Android\openjdk\jdk-21.0.8",
  $env:JAVA_HOME,
  "C:\Program Files\Android\Android Studio\jbr"
)

function Use-Java21 {
  foreach ($jdkHome in ($Jdk21Candidates | Where-Object { $_ } | Select-Object -Unique)) {
    $java = Join-Path $jdkHome "bin\java.exe"
    if (-not (Test-Path -LiteralPath $java)) { continue }
    $savedErrorActionPreference = $ErrorActionPreference
    try {
      $ErrorActionPreference = "Continue"
      $versionOutput = (& $java -version 2>&1 | Out-String)
      $versionExitCode = $LASTEXITCODE
    } finally {
      $ErrorActionPreference = $savedErrorActionPreference
    }
    if ($versionExitCode -ne 0 -or $versionOutput -notmatch 'version\s+"(?<major>\d+)') { continue }
    if ([int]$Matches.major -ne 21) { continue }

    $env:JAVA_HOME = $jdkHome
    $env:Path = "$(Join-Path $jdkHome "bin");$env:Path"
    Write-Host "Using JDK 21: $jdkHome"
    return
  }

  throw "JDK 21 is required. Install it at C:\Program Files\Android\openjdk\jdk-21.0.8 or set JAVA_HOME to a JDK 21 installation."
}

function Get-AdbPath {
  $sdkAdb = Join-Path $env:LOCALAPPDATA "Android\Sdk\platform-tools\adb.exe"
  if (Test-Path -LiteralPath $sdkAdb) {
    return $sdkAdb
  }
  return "adb"
}

function Test-FanHaoAuthorizedAdbDeviceLine {
  param([AllowNull()][AllowEmptyString()][string]$Line)

  return $Line -match '^\S+\s+device(?:\s|$)'
}

function Invoke-CapturedNative {
  param(
    [string]$Command,
    [string[]]$CommandArguments,
    [string]$FailureMessage
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

function Assert-NativeSucceeded {
  param([string]$FailureMessage)
  if ($LASTEXITCODE -ne 0) { throw "$FailureMessage (exit $LASTEXITCODE)" }
}

function Resolve-VersionCode {
  if ($VersionCodeWasSpecified) {
    return $VersionCode
  }
  if ($env:FANHAO_VERSION_CODE) {
    return $env:FANHAO_VERSION_CODE
  }
  return $VersionContract.CurrentVersionCode
}

function Resolve-VersionName {
  if ($VersionNameWasSpecified) { return $VersionName }
  if ($null -ne $env:FANHAO_VERSION_NAME) { return $env:FANHAO_VERSION_NAME }
  if (-not $VersionCodeWasSpecified -and [string]::IsNullOrWhiteSpace($env:FANHAO_VERSION_CODE)) {
    return $VersionContract.DefaultVersionName
  }
  return "0.1.$(Resolve-VersionCode)-debug"
}

$VersionContract = Read-FanHaoVersionContract -Path $VersionContractPath
$BuildIdentity = Resolve-FanHaoBuildIdentity -VersionCode (Resolve-VersionCode) -VersionName (Resolve-VersionName) -LocalOnly:$LocalOnly
$ResolvedVersionCode = $BuildIdentity.VersionCode
$ResolvedVersionName = $BuildIdentity.VersionName
if ($Install) { $null = Assert-FanHaoInstallIdentity -Identity $BuildIdentity -VersionContract $VersionContract }
if ($IdentityOnly) {
  return $BuildIdentity
}

Use-Java21
$AndroidSdkRoot = Get-FanHaoAndroidSdkRoot
$env:ANDROID_HOME = $AndroidSdkRoot
$env:ANDROID_SDK_ROOT = $AndroidSdkRoot
Write-Host "Using Android SDK: $AndroidSdkRoot"

$resolvedAndroidDir = [IO.Path]::GetFullPath($AndroidDir).TrimEnd('\') + '\'
$resolvedApkPath = [IO.Path]::GetFullPath($ApkPath)
if (-not $resolvedApkPath.StartsWith($resolvedAndroidDir, [StringComparison]::OrdinalIgnoreCase)) {
  throw "Refusing to remove an APK outside the Android build directory: $resolvedApkPath"
}
if (Test-Path -LiteralPath $resolvedApkPath) {
  Remove-Item -LiteralPath $resolvedApkPath -Force
}
$resolvedMarkerPath = [IO.Path]::GetFullPath($LocalOnlyMarkerPath)
if (-not $resolvedMarkerPath.StartsWith($resolvedAndroidDir, [StringComparison]::OrdinalIgnoreCase)) {
  throw "Refusing to use a marker outside the Android build directory: $resolvedMarkerPath"
}
$resolvedGuardPath = [IO.Path]::GetFullPath($LocalOnlyGuardPath)
if (-not $resolvedGuardPath.StartsWith($resolvedAndroidDir, [StringComparison]::OrdinalIgnoreCase)) {
  throw "Refusing to use a local-only guard outside the Android build directory: $resolvedGuardPath"
}

if (-not $NoSync) {
  Push-Location $ProjectDir
  try {
    npm run sync
    Assert-NativeSucceeded "Capacitor sync failed"
  } finally {
    Pop-Location
  }
}

Push-Location $AndroidDir
try {
  $gradleArgs = @(
    "assembleDebug",
    "--no-daemon",
    "-PfanhaoVersionCode=$ResolvedVersionCode",
    "-PfanhaoVersionName=$ResolvedVersionName"
  )
  if ($LocalOnly) { $gradleArgs += "-PfanhaoLocalOnly=true" }
  .\gradlew.bat @gradleArgs
  Assert-NativeSucceeded "Gradle assembleDebug failed"
} finally {
  Pop-Location
}

if (-not (Test-Path -LiteralPath $ApkPath)) {
  throw "APK was not produced: $ApkPath"
}

Write-Host "APK built: $ApkPath"
$ActualIdentity = Assert-FanHaoDebugApkIdentity -Identity (Get-FanHaoApkIdentity -Path $ApkPath) -ExpectedVersionCode $ResolvedVersionCode -ExpectedVersionName $ResolvedVersionName
Write-Host "APK identity verified: $($ActualIdentity.PackageName) $($ActualIdentity.VersionCode) / $($ActualIdentity.VersionName), signer $($ActualIdentity.SignerSha256)"

if ($LocalOnly) {
  $markerPath = Write-FanHaoLocalOnlyMarker -ApkPath $ApkPath -Identity $ActualIdentity
  if (Test-Path -LiteralPath $LocalOnlyGuardPath) { Remove-Item -LiteralPath $LocalOnlyGuardPath -Force }
  Write-Warning "Local-only APK marker written: $markerPath. This artifact cannot be published."
} elseif ((Test-Path -LiteralPath $LocalOnlyMarkerPath) -or (Test-Path -LiteralPath $LocalOnlyGuardPath)) {
  throw "Publishable APK retained a local-only marker or guard after Gradle verification."
}

if ($Install) {
  $adb = Get-AdbPath
  $deviceOutput = Invoke-CapturedNative $adb @("devices", "-l") "ADB device query failed"
  $devices = @($deviceOutput | Where-Object { Test-FanHaoAuthorizedAdbDeviceLine $_ })
  if (-not $devices) {
    throw "No authorized Android device found. Enable USB debugging and accept the authorization prompt."
  }

  $installOutput = Invoke-CapturedNative $adb @("install", "-r", $ApkPath) "ADB install failed"
  if (-not ($installOutput | Select-String -Pattern '^Success$')) {
    throw "ADB did not confirm a successful install.`n$($installOutput -join [Environment]::NewLine)"
  }
  $installOutput | ForEach-Object { Write-Host $_ }
}
