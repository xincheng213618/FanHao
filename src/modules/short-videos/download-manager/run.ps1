param(
  [int]$Port = 8765,
  [switch]$Restart,
  [switch]$Foreground,
  [switch]$Open
)

$ErrorActionPreference = "Stop"

$ModuleDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ProjectRoot = [System.IO.Path]::GetFullPath((Join-Path $ModuleDir "..\..\..\.."))
$AppFile = Join-Path $ModuleDir "app.py"
$SetupDownloader = Join-Path $ModuleDir "setup-downloader.ps1"
$LogDir = Join-Path $ModuleDir "logs"
$OutLog = Join-Path $LogDir "manager.out.log"
$ErrLog = Join-Path $LogDir "manager.err.log"
$HealthUrl = "http://127.0.0.1:$Port/api/health"
$StateUrl = "http://127.0.0.1:$Port/api/state"

if (-not (Test-Path -LiteralPath $AppFile)) {
  throw "app.py not found in $ModuleDir"
}
$PythonCommand = Get-Command python -ErrorAction SilentlyContinue
if (-not $PythonCommand) {
  throw "Python was not found in PATH."
}
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  throw "Node.js was not found in PATH."
}

if (-not (Test-Path -LiteralPath (Join-Path $ModuleDir "node_modules\playwright-core"))) {
  Write-Host "Installing download-manager Node dependency..."
  Push-Location $ModuleDir
  try {
    npm install --no-audit --no-fund
    if ($LASTEXITCODE -ne 0) { throw "npm install failed with exit code $LASTEXITCODE" }
  } finally {
    Pop-Location
  }
}

function Get-ManagerState {
  try {
    return Invoke-RestMethod -Uri $StateUrl -TimeoutSec 5
  } catch {
    return $null
  }
}

function Get-ManagerHealth {
  try {
    return Invoke-RestMethod -Uri $HealthUrl -TimeoutSec 2
  } catch {
    # Compatibility with a manager process started before /api/health existed.
    $legacyState = Get-ManagerState
    if (-not $legacyState) { return $null }
    return [pscustomobject]@{
      ok = $true
      paths = $legacyState.paths
      legacyState = $legacyState
    }
  }
}

function Get-ListeningProcessId {
  param([Parameter(Mandatory = $true)][int]$LocalPort)

  $netstatPath = Join-Path $env:SystemRoot "System32\netstat.exe"
  if (-not (Test-Path -LiteralPath $netstatPath -PathType Leaf)) {
    $netstatCommand = Get-Command netstat.exe -ErrorAction Stop
    $netstatPath = $netstatCommand.Source
  }

  $escapedPort = [regex]::Escape([string]$LocalPort)
  foreach ($line in (& $netstatPath -ano -p TCP 2>$null)) {
    if ($line -match "^\s*TCP\s+\S+:$escapedPort\s+\S+\s+LISTENING\s+(\d+)\s*$") {
      return [int]$Matches[1]
    }
  }

  return $null
}

$existingHealth = Get-ManagerHealth
$existingState = $existingHealth.legacyState
if ($existingHealth.ok -and -not $Restart) {
  $runningBase = [System.IO.Path]::GetFullPath([string]$existingHealth.paths.base)
  if (-not $runningBase.Equals($ModuleDir, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Port $Port is served by another download-manager installation: $runningBase"
  }
  Write-Host "Douyin Download Manager is already running on http://127.0.0.1:$Port."
  if ($Open) { Start-Process "http://localhost:$Port/#home" }
  exit 0
}

$listenerProcessId = Get-ListeningProcessId -LocalPort $Port
if ($null -ne $listenerProcessId) {
  if (-not $Restart) {
    throw "Port $Port is already in use by PID $listenerProcessId, but /api/state is not healthy."
  }
  if (-not $existingState) { $existingState = Get-ManagerState }
  $active = [bool]($existingState.download.active -or $existingState.extract.active)
  if ($active) {
    throw "The download manager is busy. Stop the active task before restarting it."
  }
  Stop-Process -Id $listenerProcessId -Force
  for ($i = 0; $i -lt 20; $i++) {
    Start-Sleep -Milliseconds 250
    $stillListeningProcessId = Get-ListeningProcessId -LocalPort $Port
    if ($null -eq $stillListeningProcessId) { break }
  }
}

if (-not (Test-Path -LiteralPath $SetupDownloader -PathType Leaf)) {
  throw "Downloader setup script was not found: $SetupDownloader"
}
& $SetupDownloader -PythonExecutable $PythonCommand.Source

New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
$env:FANHAO_PROJECT_ROOT = $ProjectRoot
$env:DOUYIN_MANAGER_PORT = [string]$Port

if ($Foreground) {
  Push-Location $ModuleDir
  try {
    & $PythonCommand.Source -u $AppFile
  } finally {
    Pop-Location
  }
  exit $LASTEXITCODE
}

$process = Start-Process -FilePath $PythonCommand.Source `
  -ArgumentList @("-u", $AppFile) `
  -WorkingDirectory $ModuleDir `
  -RedirectStandardOutput $OutLog `
  -RedirectStandardError $ErrLog `
  -WindowStyle Hidden `
  -PassThru

for ($i = 0; $i -lt 60; $i++) {
  Start-Sleep -Milliseconds 500
  if ($process.HasExited) { break }
  $health = Get-ManagerHealth
  if ($health.ok) { break }
}

if (-not $health.ok) {
  Write-Host "Douyin Download Manager failed to become ready."
  if (Test-Path -LiteralPath $ErrLog) { Get-Content -LiteralPath $ErrLog -Tail 40 }
  exit 1
}

$state = Get-ManagerState
Write-Host "Douyin Download Manager started: http://127.0.0.1:$Port (PID $($process.Id))"
Write-Host "Database: $($state.paths.database)"
if ($Open) { Start-Process "http://localhost:$Port/#home" }
