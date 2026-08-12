[CmdletBinding()]
param(
  [string]$Python = ""
)

$ErrorActionPreference = "Stop"
Import-Module Microsoft.PowerShell.Utility -ErrorAction Stop
$ProjectRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$ModuleDir = Join-Path $ProjectRoot "src\modules\short-videos\download-manager"
$TestsDir = Join-Path $ModuleDir "tests"
$SetupDownloader = Join-Path $ModuleDir "setup-downloader.ps1"
$DownloaderDir = Join-Path $ModuleDir "downloader"
$DownloaderPython = Join-Path $DownloaderDir ".venv\Scripts\python.exe"
$DownloaderRun = Join-Path $DownloaderDir "run.py"
$ResumeContractTest = Join-Path $DownloaderDir "tests\test_download_resume_contract.py"
$HttpRangeContractTest = Join-Path $TestsDir "test_http_range_contract.py"

if ([string]::IsNullOrWhiteSpace($Python)) {
  $pythonCommand = Get-Command python -ErrorAction SilentlyContinue
  if (-not $pythonCommand) { throw "Python was not found in PATH." }
  $Python = $pythonCommand.Source
}
if (-not (Test-Path -LiteralPath $TestsDir)) {
  throw "Download-manager tests were not found: $TestsDir"
}
if (-not (Test-Path -LiteralPath $SetupDownloader -PathType Leaf)) {
  throw "Downloader setup script was not found: $SetupDownloader"
}
if (-not (Test-Path -LiteralPath $ResumeContractTest -PathType Leaf)) {
  throw "Embedded downloader resume contract test was not found: $ResumeContractTest"
}
if (-not (Test-Path -LiteralPath $HttpRangeContractTest -PathType Leaf)) {
  throw "Download-manager HTTP range contract test was not found: $HttpRangeContractTest"
}

function Get-LogTail {
  param([Parameter(Mandatory = $true)][string]$Path)
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return "" }
  return ((Get-Content -LiteralPath $Path -Tail 80 -ErrorAction SilentlyContinue) -join [Environment]::NewLine)
}

function Test-EmbeddedDownloaderSidecar {
  $resolvedDownloaderDir = [System.IO.Path]::GetFullPath($DownloaderDir)
  $downloaderPrefix = $resolvedDownloaderDir.TrimEnd('\') + '\'
  foreach ($required in @($DownloaderPython, $DownloaderRun)) {
    $resolvedRequired = [System.IO.Path]::GetFullPath($required)
    if (-not $resolvedRequired.StartsWith($downloaderPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
      throw "Embedded downloader command escaped the module directory: $resolvedRequired"
    }
    if (-not (Test-Path -LiteralPath $resolvedRequired -PathType Leaf)) {
      throw "Embedded downloader runtime is missing: $resolvedRequired. Run setup-downloader.ps1 first."
    }
  }

  $tempBase = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath()).TrimEnd('\') + '\'
  $tempRoot = Join-Path $tempBase ("fanhao-douyin-sidecar-contract-" + [guid]::NewGuid().ToString("N"))
  $tempRoot = [System.IO.Path]::GetFullPath($tempRoot)
  $tempLeaf = Split-Path $tempRoot -Leaf
  if (-not $tempRoot.StartsWith($tempBase, [System.StringComparison]::OrdinalIgnoreCase) -or
      -not $tempLeaf.StartsWith("fanhao-douyin-sidecar-contract-", [System.StringComparison]::Ordinal)) {
    throw "Unsafe sidecar contract temp path: $tempRoot"
  }

  $listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, 0)
  try {
    $listener.Start()
    $sidecarPort = ([System.Net.IPEndPoint]$listener.LocalEndpoint).Port
  } finally {
    $listener.Stop()
  }

  $sidecarProcess = $null
  $stdoutPath = Join-Path $tempRoot "sidecar.out.log"
  $stderrPath = Join-Path $tempRoot "sidecar.err.log"
  try {
    New-Item -ItemType Directory -Path $tempRoot, (Join-Path $tempRoot "media") -Force | Out-Null
    $arguments = @(
      $DownloaderRun,
      "--serve",
      "--config", (Join-Path $tempRoot "config.yml"),
      "--path", (Join-Path $tempRoot "media"),
      "--serve-host", "127.0.0.1",
      "--serve-port", [string]$sidecarPort
    )
    $sidecarProcess = Start-Process -FilePath $DownloaderPython `
      -ArgumentList $arguments `
      -WorkingDirectory $tempRoot `
      -RedirectStandardOutput $stdoutPath `
      -RedirectStandardError $stderrPath `
      -WindowStyle Hidden `
      -PassThru

    $health = $null
    $healthDeadline = [DateTime]::UtcNow.AddSeconds(120)
    while ([DateTime]::UtcNow -lt $healthDeadline) {
      Start-Sleep -Milliseconds 250
      if ($sidecarProcess.HasExited) { break }
      try {
        $health = Invoke-RestMethod -Uri "http://127.0.0.1:$sidecarPort/api/v1/health" -TimeoutSec 2
        break
      } catch {}
    }
    if (-not $health) {
      $stdout = Get-LogTail -Path $stdoutPath
      $stderr = Get-LogTail -Path $stderrPath
      throw "Embedded downloader sidecar did not become healthy on port $sidecarPort.`nstdout:`n$stdout`nstderr:`n$stderr"
    }
    if ([string]$health.status -ne "ok") {
      throw "Embedded downloader returned an unexpected health payload: $($health | ConvertTo-Json -Compress)"
    }
    $jobs = Invoke-RestMethod -Uri "http://127.0.0.1:$sidecarPort/api/v1/jobs" -TimeoutSec 2
    if (@($jobs.jobs).Count -ne 0) {
      throw "Fresh embedded downloader sidecar unexpectedly contains jobs."
    }
  } finally {
    if ($sidecarProcess -and -not $sidecarProcess.HasExited) {
      Stop-Process -Id $sidecarProcess.Id -Force -ErrorAction SilentlyContinue
      $null = $sidecarProcess.WaitForExit(5000)
    }
    if (Test-Path -LiteralPath $tempRoot) {
      Remove-Item -LiteralPath $tempRoot -Recurse -Force
    }
  }

  Write-Host "embedded downloader sidecar: ok ($DownloaderRun -> /api/v1/health)"
}

$savedPythonEnvironment = @{}
foreach ($name in @("PYTHONDONTWRITEBYTECODE", "PYTHONUTF8", "PYTHONIOENCODING", "PYTHONLEGACYWINDOWSSTDIO")) {
  $savedPythonEnvironment[$name] = [Environment]::GetEnvironmentVariable($name, "Process")
}
try {
  $env:PYTHONDONTWRITEBYTECODE = "1"
  $env:PYTHONUTF8 = "1"
  $env:PYTHONIOENCODING = "utf-8:replace"
  $env:PYTHONLEGACYWINDOWSSTDIO = "0"
  & $SetupDownloader -DownloaderRoot $DownloaderDir -PythonExecutable $Python
  Push-Location $DownloaderDir
  try {
    & $DownloaderPython -m unittest discover -s tests -p "test_download_resume_contract.py" -v
    if ($LASTEXITCODE -ne 0) {
      throw "Embedded downloader resume contract failed with exit code $LASTEXITCODE"
    }
  } finally {
    Pop-Location
  }
  & $Python -m unittest discover -s $TestsDir -p "test_*.py" -v
  if ($LASTEXITCODE -ne 0) {
    throw "Download-manager runtime characterization failed with exit code $LASTEXITCODE"
  }
  Test-EmbeddedDownloaderSidecar
} finally {
  foreach ($name in $savedPythonEnvironment.Keys) {
    $value = $savedPythonEnvironment[$name]
    if ($null -eq $value) {
      Remove-Item "Env:$name" -ErrorAction SilentlyContinue
    } else {
      Set-Item "Env:$name" $value
    }
  }
}

Write-Host "douyin-download-manager runtime: ok (isolated temp data/log, random loopback ports, embedded sidecar)"
