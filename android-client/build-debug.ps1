param(
  [switch]$Install,
  [switch]$NoSync,
  [int]$VersionCode = 0,
  [string]$VersionName = ""
)

$ErrorActionPreference = "Stop"

$ProjectDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$AndroidDir = Join-Path $ProjectDir "android"
$ApkPath = Join-Path $AndroidDir "app\build\outputs\apk\debug\app-debug.apk"
$PreferredJdks = @(
  "C:\Program Files\Android\openjdk\jdk-21.0.8",
  "C:\Program Files\Android\Android Studio\jbr",
  "C:\Program Files\JetBrains\PyCharm 2026.1.1\jbr",
  "C:\Program Files\JetBrains\PyCharm 2024.2.0.1\jbr"
)

function Use-PreferredJava {
  foreach ($jdkHome in $PreferredJdks) {
    $java = Join-Path $jdkHome "bin\java.exe"
    if (Test-Path -LiteralPath $java) {
      $env:JAVA_HOME = $jdkHome
      $env:Path = "$(Join-Path $jdkHome "bin");$env:Path"
      Write-Host "Using JAVA_HOME=$jdkHome"
      return
    }
  }

  Write-Warning "No preferred JDK found. Gradle will use the current PATH Java."
}

function Get-AdbPath {
  $sdkAdb = Join-Path $env:LOCALAPPDATA "Android\Sdk\platform-tools\adb.exe"
  if (Test-Path -LiteralPath $sdkAdb) {
    return $sdkAdb
  }
  return "adb"
}

Use-PreferredJava

if (-not $NoSync) {
  Push-Location $ProjectDir
  try {
    npm run sync
  } finally {
    Pop-Location
  }
}

Push-Location $AndroidDir
try {
  $gradleArgs = @("assembleDebug", "--no-daemon")
  if ($VersionCode -gt 0) {
    $gradleArgs += "-PfanhaoVersionCode=$VersionCode"
  }
  if ($VersionName) {
    $gradleArgs += "-PfanhaoVersionName=$VersionName"
  }
  .\gradlew.bat @gradleArgs
} finally {
  Pop-Location
}

if (-not (Test-Path -LiteralPath $ApkPath)) {
  throw "APK was not produced: $ApkPath"
}

Write-Host "APK built: $ApkPath"

if ($Install) {
  $adb = Get-AdbPath
  $devices = & $adb devices | Select-String -Pattern "`tdevice$"
  if (-not $devices) {
    throw "No authorized Android device found. Enable USB debugging and accept the authorization prompt."
  }

  & $adb install -r $ApkPath
}
