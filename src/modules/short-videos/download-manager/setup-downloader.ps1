[CmdletBinding()]
param(
  [string]$DownloaderRoot = "",
  [string]$PythonExecutable = "python"
)

$ErrorActionPreference = "Stop"

$ModuleDir = Split-Path -Parent $MyInvocation.MyCommand.Path
if ([string]::IsNullOrWhiteSpace($DownloaderRoot)) {
  $DownloaderRoot = if ([string]::IsNullOrWhiteSpace($env:DOUYIN_DOWNLOADER_ROOT)) {
    Join-Path $ModuleDir "downloader"
  } else {
    $env:DOUYIN_DOWNLOADER_ROOT
  }
}
$DownloaderRoot = [System.IO.Path]::GetFullPath($DownloaderRoot)

$BundledExecutable = Join-Path $DownloaderRoot "douyin-downloader.exe"
if (Test-Path -LiteralPath $BundledExecutable -PathType Leaf) {
  Write-Host "Bundled Douyin downloader is ready: $BundledExecutable"
  return
}

$RunFile = Join-Path $DownloaderRoot "run.py"
$ProjectFile = Join-Path $DownloaderRoot "pyproject.toml"
$RequirementsFile = Join-Path $DownloaderRoot "requirements.txt"
foreach ($required in @($DownloaderRoot, $RunFile, $ProjectFile, $RequirementsFile)) {
  if (-not (Test-Path -LiteralPath $required)) {
    throw "Required downloader source was not found: $required"
  }
}

$VenvDir = Join-Path $DownloaderRoot ".venv"
$VenvPython = Join-Path $VenvDir "Scripts\python.exe"
$FingerprintFile = Join-Path $VenvDir ".fanhao-serve-dependencies.sha256"
$DependencyFiles = @($ProjectFile, $RequirementsFile)

$fingerprintParts = @("fanhao-douyin-downloader-serve-v4", "host-wheelhouse-plus-server-extra")
foreach ($dependencyFile in $DependencyFiles) {
  $dependencyHash = (Get-FileHash -LiteralPath $dependencyFile -Algorithm SHA256).Hash
  $fingerprintParts += "$([System.IO.Path]::GetFileName($dependencyFile))=$dependencyHash"
}
$fingerprintBytes = [System.Text.Encoding]::UTF8.GetBytes(($fingerprintParts -join "`n"))
$sha256 = [System.Security.Cryptography.SHA256]::Create()
try {
  $DependencyFingerprint = [System.BitConverter]::ToString(
    $sha256.ComputeHash($fingerprintBytes)
  ).Replace("-", "").ToLowerInvariant()
} finally {
  $sha256.Dispose()
}

$InstalledFingerprint = ""
if (Test-Path -LiteralPath $FingerprintFile -PathType Leaf) {
  $InstalledFingerprint = (Get-Content -LiteralPath $FingerprintFile -Raw).Trim()
}
$NeedsInstall = -not (Test-Path -LiteralPath $VenvPython -PathType Leaf) -or
  -not $InstalledFingerprint.Equals($DependencyFingerprint, [System.StringComparison]::OrdinalIgnoreCase)

$VerificationCode = @"
import aiofiles, aiohttp, aiosqlite, dateutil, fastapi, gmssl, httpx
import imageio_ffmpeg, pydantic, rich, uvicorn, yaml
from server.app import run_server
"@

function Test-DownloaderDependencies {
  param([int]$TimeoutSeconds = 30)

  $verificationFile = Join-Path $VenvDir ".fanhao-verify-dependencies.py"
  $verificationOut = Join-Path $VenvDir ".fanhao-verify-$PID.out.log"
  $verificationError = Join-Path $VenvDir ".fanhao-verify-$PID.err.log"
  Set-Content -LiteralPath $verificationFile -Value $VerificationCode -Encoding UTF8
  $process = Start-Process -FilePath $VenvPython `
    -ArgumentList @("`"$verificationFile`"") `
    -WorkingDirectory $DownloaderRoot `
    -RedirectStandardOutput $verificationOut `
    -RedirectStandardError $verificationError `
    -WindowStyle Hidden `
    -PassThru
  if (-not $process.WaitForExit($TimeoutSeconds * 1000)) {
    $taskkill = Join-Path $env:SystemRoot "System32\taskkill.exe"
    & $taskkill /PID $process.Id /T /F *> $null
    throw "Downloader dependency verification timed out after $TimeoutSeconds seconds"
  }
  if ($process.ExitCode -eq 0) {
    return $true
  }
  $errorText = if (Test-Path -LiteralPath $verificationError -PathType Leaf) {
    (Get-Content -LiteralPath $verificationError -Tail 20) -join "`n"
  } else {
    "Dependency verification exited without an error log."
  }
  Write-Warning "Downloader dependency verification failed: $errorText"
  return $false
}

function Test-DownloaderDependencyFiles {
  $sitePackages = Join-Path $VenvDir "Lib\site-packages"
  foreach ($moduleName in @(
    "aiofiles", "aiohttp", "aiosqlite", "dateutil", "fastapi", "gmssl", "httpx",
    "imageio_ffmpeg", "pydantic", "rich", "uvicorn", "yaml"
  )) {
    $moduleDirectory = Join-Path $sitePackages $moduleName
    $moduleFile = Join-Path $sitePackages "$moduleName.py"
    if (-not (Test-Path -LiteralPath $moduleDirectory) -and
        -not (Test-Path -LiteralPath $moduleFile -PathType Leaf)) {
      return $false
    }
  }
  return (Test-Path -LiteralPath (Join-Path $DownloaderRoot "server\app.py") -PathType Leaf)
}

if (-not $NeedsInstall) {
  $NeedsInstall = -not (Test-DownloaderDependencyFiles)
}

if ($NeedsInstall) {
  $pythonCommand = Get-Command $PythonExecutable -ErrorAction SilentlyContinue
  if (-not $pythonCommand) {
    throw "Python was not found: $PythonExecutable"
  }
  & $pythonCommand.Source -c "import sys; raise SystemExit(0 if sys.version_info >= (3, 10) else 1)"
  if ($LASTEXITCODE -ne 0) {
    throw "Python 3.10 or newer is required to set up the embedded Douyin downloader."
  }
  if (-not (Test-Path -LiteralPath $VenvPython -PathType Leaf)) {
    Write-Host "Creating downloader virtual environment: $VenvDir"
    & $pythonCommand.Source -m venv $VenvDir
    if ($LASTEXITCODE -ne 0) {
      throw "Creating the downloader virtual environment failed with exit code $LASTEXITCODE"
    }
  }

  $WheelhouseDir = Join-Path $VenvDir ".fanhao-wheelhouse"
  New-Item -ItemType Directory -Force -Path $WheelhouseDir | Out-Null
  $ServerDependencies = @("fastapi>=0.100", "uvicorn>=0.23", "pydantic>=2.0")
  $BuildDependencies = @("setuptools>=68", "wheel")
  $DownloadArguments = @(
    "-m", "pip", "download", "--disable-pip-version-check", "--no-input",
    "--timeout", "30", "--retries", "3", "--dest", $WheelhouseDir,
    "--requirement", $RequirementsFile
  ) + $BuildDependencies + $ServerDependencies
  Write-Host "Downloading downloader dependencies with the host Python..."
  & $pythonCommand.Source @DownloadArguments
  if ($LASTEXITCODE -ne 0) {
    throw "Downloading downloader dependencies failed with exit code $LASTEXITCODE"
  }

  Write-Host "Installing downloader REST-service dependencies from the local wheelhouse..."
  & $VenvPython -m pip install --disable-pip-version-check --no-input `
    --no-index --find-links $WheelhouseDir $BuildDependencies
  if ($LASTEXITCODE -ne 0) {
    throw "Installing downloader build dependencies failed with exit code $LASTEXITCODE"
  }
  & $VenvPython -m pip install --disable-pip-version-check --no-input `
    --no-index --find-links $WheelhouseDir --requirement $RequirementsFile $ServerDependencies
  if ($LASTEXITCODE -ne 0) {
    throw "Installing downloader dependencies failed with exit code $LASTEXITCODE"
  }

  if (-not (Test-DownloaderDependencies)) {
    throw "Downloader REST-service dependency verification failed"
  }
  Set-Content -LiteralPath $FingerprintFile -Value $DependencyFingerprint -Encoding Ascii -NoNewline
}

Write-Host "Douyin downloader runtime is ready: $VenvPython"
