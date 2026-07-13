[CmdletBinding()]
param(
  [ValidatePattern('^[0-9A-Za-z._-]+$')]
  [string]$Version = "0.3.0-test",
  [string]$DownloaderRoot = "",
  [string]$OutputDirectory = "",
  [string]$WorkDirectory = "",
  [switch]$KeepWorkDirectory
)

$ErrorActionPreference = "Stop"

$ProjectRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$ModuleDir = Join-Path $ProjectRoot "src\modules\short-videos\download-manager"
$PackagingDir = Join-Path $ModuleDir "packaging"
$DownloaderEntry = Join-Path $PackagingDir "downloader_entry.py"
$InstallerScript = Join-Path $PackagingDir "DouyinDownloadManager.iss"
$BuildRequirements = Join-Path $PackagingDir "requirements-build.txt"
$AutoWorkDirectory = [string]::IsNullOrWhiteSpace($WorkDirectory)

if ([string]::IsNullOrWhiteSpace($DownloaderRoot)) {
  $DownloaderRoot = Join-Path (Split-Path $ProjectRoot -Parent) "Tool\douyin-downloader"
}
if ([string]::IsNullOrWhiteSpace($OutputDirectory)) {
  $OutputDirectory = Join-Path $ProjectRoot "dist\douyin-download-manager"
}
if ($AutoWorkDirectory) {
  $stamp = Get-Date -Format "yyyyMMdd-HHmmss"
  $WorkDirectory = Join-Path $env:TEMP "fanhao-douyin-manager-$Version-$stamp"
}

$DownloaderRoot = [System.IO.Path]::GetFullPath($DownloaderRoot)
$OutputDirectory = [System.IO.Path]::GetFullPath($OutputDirectory)
$WorkDirectory = [System.IO.Path]::GetFullPath($WorkDirectory)

if (Test-Path -LiteralPath $WorkDirectory) {
  throw "Work directory already exists: $WorkDirectory"
}

function Get-RequiredCommand {
  param([Parameter(Mandatory = $true)][string]$Name)
  $command = Get-Command $Name -ErrorAction SilentlyContinue
  if (-not $command) { throw "Required command was not found: $Name" }
  return $command.Source
}

function Invoke-Checked {
  param(
    [Parameter(Mandatory = $true)][string]$FilePath,
    [Parameter(Mandatory = $true)][string[]]$ArgumentList,
    [Parameter(Mandatory = $true)][string]$Label
  )
  Write-Host "[$Label] $FilePath"
  & $FilePath @ArgumentList
  if ($LASTEXITCODE -ne 0) {
    throw "$Label failed with exit code $LASTEXITCODE"
  }
}

$PyInstaller = Get-RequiredCommand "pyinstaller"
$Python = Get-RequiredCommand "python"
$Node = Get-RequiredCommand "node"
$InnoCompiler = @(
  (Join-Path $env:LOCALAPPDATA "Programs\Inno Setup 6\ISCC.exe"),
  (Join-Path ${env:ProgramFiles(x86)} "Inno Setup 6\ISCC.exe"),
  (Join-Path $env:ProgramFiles "Inno Setup 6\ISCC.exe")
) | Where-Object { $_ -and (Test-Path -LiteralPath $_) } | Select-Object -First 1
if (-not $InnoCompiler) { throw "Inno Setup 6 compiler (ISCC.exe) was not found." }

$DownloaderSitePackages = Join-Path $DownloaderRoot ".venv\Lib\site-packages"
foreach ($required in @(
  (Join-Path $ModuleDir "app.py"),
  (Join-Path $ModuleDir "static"),
  (Join-Path $ModuleDir "node_modules\playwright-core"),
  (Join-Path $DownloaderRoot "cli"),
  $DownloaderSitePackages,
  $DownloaderEntry,
  $InstallerScript,
  $BuildRequirements
)) {
  if (-not (Test-Path -LiteralPath $required)) { throw "Required build input was not found: $required" }
}

$ManagerDist = Join-Path $WorkDirectory "dist-manager"
$ManagerWork = Join-Path $WorkDirectory "work-manager"
$DownloaderDist = Join-Path $WorkDirectory "dist-downloader"
$DownloaderWork = Join-Path $WorkDirectory "work-downloader"
$SpecDir = Join-Path $WorkDirectory "spec"
$PackageDir = Join-Path $WorkDirectory "package"
$SmokeDir = Join-Path $WorkDirectory "smoke"

New-Item -ItemType Directory -Force -Path $WorkDirectory, $OutputDirectory, $SpecDir | Out-Null

try {
  Invoke-Checked -FilePath $Python -ArgumentList @(
    "-c", "import webview; import clr; import clr_loader"
  ) -Label "desktop-runtime-check"

  $managerArgs = @(
    "--noconfirm", "--clean", "--onedir", "--windowed",
    "--name", "DouyinDownloadManager",
    "--distpath", $ManagerDist,
    "--workpath", $ManagerWork,
    "--specpath", $SpecDir,
    "--add-data", "$(Join-Path $ModuleDir 'static');static",
    "--add-data", "$(Join-Path $ModuleDir 'extract-links.mjs');.",
    "--add-data", "$(Join-Path $ModuleDir 'extract-following.mjs');.",
    "--add-data", "$(Join-Path $ModuleDir 'cookie-login.mjs');.",
    "--add-data", "$(Join-Path $ModuleDir 'node_modules');node_modules",
    "--collect-all", "webview",
    "--collect-all", "pythonnet",
    "--collect-all", "clr_loader",
    "--hidden-import", "clr",
    "--hidden-import", "webview.platforms.edgechromium",
    "--exclude-module", "PyQt5",
    "--exclude-module", "PyQt6",
    "--exclude-module", "PySide2",
    "--exclude-module", "PySide6",
    "--exclude-module", "cefpython3",
    (Join-Path $ModuleDir "app.py")
  )
  Invoke-Checked -FilePath $PyInstaller -ArgumentList $managerArgs -Label "manager"

  $downloaderArgs = @(
    "--noconfirm", "--clean", "--onedir", "--console",
    "--name", "douyin-downloader",
    "--distpath", $DownloaderDist,
    "--workpath", $DownloaderWork,
    "--specpath", $SpecDir,
    "--paths", $DownloaderRoot,
    "--paths", $DownloaderSitePackages,
    "--collect-all", "imageio_ffmpeg",
    "--exclude-module", "pytest",
    "--exclude-module", "hypothesis",
    "--exclude-module", "numpy",
    "--exclude-module", "PIL",
    "--exclude-module", "playwright",
    $DownloaderEntry
  )
  Invoke-Checked -FilePath $PyInstaller -ArgumentList $downloaderArgs -Label "downloader"

  $managerPackage = Join-Path $ManagerDist "DouyinDownloadManager"
  $downloaderPackage = Join-Path $DownloaderDist "douyin-downloader"
  New-Item -ItemType Directory -Force -Path $PackageDir, (Join-Path $PackageDir "downloader"), (Join-Path $PackageDir "runtime") | Out-Null
  Copy-Item (Join-Path $managerPackage "DouyinDownloadManager.exe") $PackageDir -Force
  Copy-Item (Join-Path $managerPackage "_internal") $PackageDir -Recurse -Force
  Copy-Item (Join-Path $downloaderPackage "*") (Join-Path $PackageDir "downloader") -Recurse -Force
  Copy-Item $Node (Join-Path $PackageDir "runtime\node.exe") -Force

  $sensitiveFiles = Get-ChildItem $PackageDir -Recurse -File | Where-Object {
    $_.Name -match '(?i)\.sqlite$|\.mp4$|custom-batch-douyin-cookies|^\.cookies\.json$'
  }
  if ($sensitiveFiles) {
    throw "Sensitive runtime files entered the package: $($sensitiveFiles.FullName -join ', ')"
  }

  Invoke-Checked -FilePath (Join-Path $PackageDir "runtime\node.exe") -ArgumentList @(
    (Join-Path $PackageDir "_internal\cookie-login.mjs"), "--help"
  ) -Label "login-helper-smoke"
  Invoke-Checked -FilePath (Join-Path $PackageDir "downloader\douyin-downloader.exe") -ArgumentList @("--help") -Label "downloader-smoke"

  New-Item -ItemType Directory -Force -Path (Join-Path $SmokeDir "data"), (Join-Path $SmokeDir "logs") | Out-Null
  $listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, 0)
  $listener.Start()
  $smokePort = ([System.Net.IPEndPoint]$listener.LocalEndpoint).Port
  $listener.Stop()
  $savedEnvironment = @{
    DOUYIN_MANAGER_PORT = $env:DOUYIN_MANAGER_PORT
    DOUYIN_MANAGER_DATA_DIR = $env:DOUYIN_MANAGER_DATA_DIR
    DOUYIN_MANAGER_LOG_DIR = $env:DOUYIN_MANAGER_LOG_DIR
    DOUYIN_MANAGER_OPEN = $env:DOUYIN_MANAGER_OPEN
    DOUYIN_MANAGER_DESKTOP = $env:DOUYIN_MANAGER_DESKTOP
  }
  $env:DOUYIN_MANAGER_PORT = [string]$smokePort
  $env:DOUYIN_MANAGER_DATA_DIR = Join-Path $SmokeDir "data"
  $env:DOUYIN_MANAGER_LOG_DIR = Join-Path $SmokeDir "logs"
  $env:DOUYIN_MANAGER_OPEN = "0"
  $env:DOUYIN_MANAGER_DESKTOP = "0"
  $managerProcess = Start-Process -FilePath (Join-Path $PackageDir "DouyinDownloadManager.exe") -WorkingDirectory $PackageDir -WindowStyle Hidden -PassThru
  try {
    $state = $null
    for ($attempt = 0; $attempt -lt 60; $attempt++) {
      Start-Sleep -Milliseconds 250
      if ($managerProcess.HasExited) { break }
      try {
        $state = Invoke-RestMethod -Uri "http://127.0.0.1:$smokePort/api/state" -TimeoutSec 2
        break
      } catch {}
    }
    if (-not $state) { throw "Packaged manager did not become ready on port $smokePort" }
    $html = (Invoke-WebRequest -Uri "http://127.0.0.1:$smokePort/#settings" -TimeoutSec 5).Content
    if ($html -notmatch "打开 Edge 登录") { throw "Packaged settings page is missing the auth controls." }
    if ($html -notmatch "已下载作品") { throw "Packaged page is missing the local library." }
  } finally {
    if ($managerProcess -and -not $managerProcess.HasExited) { Stop-Process -Id $managerProcess.Id -Force }
    foreach ($name in $savedEnvironment.Keys) {
      $value = $savedEnvironment[$name]
      if ($null -eq $value) { Remove-Item "Env:$name" -ErrorAction SilentlyContinue } else { Set-Item "Env:$name" $value }
    }
  }

  Invoke-Checked -FilePath $InnoCompiler -ArgumentList @(
    "/DAppVersion=$Version",
    "/DSourceDir=$PackageDir",
    "/DOutputDir=$OutputDirectory",
    $InstallerScript
  ) -Label "installer"

  $Installer = Join-Path $OutputDirectory "DouyinDownloadManager-Setup-x64-$Version.exe"
  if (-not (Test-Path -LiteralPath $Installer)) { throw "Installer was not generated: $Installer" }
  $hash = Get-FileHash -LiteralPath $Installer -Algorithm SHA256
  $hashFile = "$Installer.sha256"
  Set-Content -LiteralPath $hashFile -Value "$($hash.Hash.ToLowerInvariant())  $(Split-Path $Installer -Leaf)" -Encoding ascii

  [pscustomobject]@{
    Version = $Version
    Installer = $Installer
    HashFile = $hashFile
    SHA256 = $hash.Hash
    SizeBytes = (Get-Item -LiteralPath $Installer).Length
  }
} finally {
  if ($AutoWorkDirectory -and -not $KeepWorkDirectory -and (Test-Path -LiteralPath $WorkDirectory)) {
    $resolvedTemp = [System.IO.Path]::GetFullPath($env:TEMP).TrimEnd('\') + '\'
    $resolvedWork = [System.IO.Path]::GetFullPath($WorkDirectory)
    if ($resolvedWork.StartsWith($resolvedTemp, [System.StringComparison]::OrdinalIgnoreCase)) {
      Remove-Item -LiteralPath $resolvedWork -Recurse -Force
    }
  }
}
