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
$LogDir = Join-Path $ModuleDir "logs"
$OutLog = Join-Path $LogDir "manager.out.log"
$ErrLog = Join-Path $LogDir "manager.err.log"
$StateUrl = "http://127.0.0.1:$Port/api/state"

if (-not (Test-Path -LiteralPath $AppFile)) {
  throw "app.py not found in $ModuleDir"
}
if (-not (Get-Command python -ErrorAction SilentlyContinue)) {
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

$existingState = Get-ManagerState
if ($existingState -and -not $Restart) {
  $runningBase = [System.IO.Path]::GetFullPath([string]$existingState.paths.base)
  if (-not $runningBase.Equals($ModuleDir, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Port $Port is served by another download-manager installation: $runningBase"
  }
  Write-Host "Douyin Download Manager is already running on http://127.0.0.1:$Port."
  if ($Open) { Start-Process "http://localhost:$Port/#home" }
  exit 0
}

$listener = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
if ($listener) {
  if (-not $Restart) {
    throw "Port $Port is already in use by PID $($listener.OwningProcess), but /api/state is not healthy."
  }
  $active = [bool]($existingState.download.active -or $existingState.extract.active)
  if ($active) {
    throw "The download manager is busy. Stop the active task before restarting it."
  }
  Stop-Process -Id $listener.OwningProcess -Force
  for ($i = 0; $i -lt 20; $i++) {
    Start-Sleep -Milliseconds 250
    if (-not (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)) { break }
  }
}

New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
$env:FANHAO_PROJECT_ROOT = $ProjectRoot
$env:DOUYIN_MANAGER_PORT = [string]$Port

if ($Foreground) {
  Push-Location $ModuleDir
  try {
    python -u $AppFile
  } finally {
    Pop-Location
  }
  exit $LASTEXITCODE
}

$process = Start-Process -FilePath "python" `
  -ArgumentList @("-u", $AppFile) `
  -WorkingDirectory $ModuleDir `
  -RedirectStandardOutput $OutLog `
  -RedirectStandardError $ErrLog `
  -WindowStyle Hidden `
  -PassThru

for ($i = 0; $i -lt 60; $i++) {
  Start-Sleep -Milliseconds 500
  if ($process.HasExited) { break }
  $state = Get-ManagerState
  if ($state) { break }
}

if (-not $state) {
  Write-Host "Douyin Download Manager failed to become ready."
  if (Test-Path -LiteralPath $ErrLog) { Get-Content -LiteralPath $ErrLog -Tail 40 }
  exit 1
}

Write-Host "Douyin Download Manager started: http://127.0.0.1:$Port (PID $($process.Id))"
Write-Host "Database: $($state.paths.database)"
if ($Open) { Start-Process "http://localhost:$Port/#home" }
