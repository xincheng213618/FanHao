param(
  [int]$Port = 29998,
  [string]$HostName = "0.0.0.0",
  [switch]$Restart,
  [switch]$Foreground
)

$ErrorActionPreference = "Stop"

$ProjectDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ServerFile = Join-Path $ProjectDir "server.js"
$LogDir = Join-Path $ProjectDir "logs"
$OutLog = Join-Path $LogDir "fanhao.out.log"
$ErrLog = Join-Path $LogDir "fanhao.err.log"

if (-not (Test-Path -LiteralPath $ServerFile)) {
  throw "server.js not found in $ProjectDir"
}

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  throw "Node.js was not found in PATH. Install Node.js 20+ or add node.exe to PATH."
}

New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

function Test-FanhaoHealth {
  param([int]$HealthPort)

  try {
    $health = Invoke-RestMethod -Uri "http://127.0.0.1:$HealthPort/api/health" -TimeoutSec 5
    return [bool]$health.ok
  } catch {
    return $false
  }
}

$listener = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
if ($listener) {
  $owner = Get-CimInstance Win32_Process -Filter "ProcessId = $($listener.OwningProcess)" -ErrorAction SilentlyContinue
  $commandLine = $owner.CommandLine
  if ($commandLine -and $commandLine -like "*server.js*") {
    if (-not $Restart) {
      $status = if (Test-FanhaoHealth -HealthPort $Port) { "healthy" } else { "not responding to /api/health" }
      Write-Host "FanHao is already running on http://127.0.0.1:$Port (PID $($listener.OwningProcess), $status)."
      exit 0
    }

    Write-Host "Stopping existing FanHao process on port $Port (PID $($listener.OwningProcess))."
    Stop-Process -Id $listener.OwningProcess -Force

    for ($i = 0; $i -lt 20; $i++) {
      Start-Sleep -Milliseconds 500
      $stillListening = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
      if (-not $stillListening) { break }
    }
  }

  $listenerAfterStop = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($listenerAfterStop) {
    throw "Port $Port is already in use by PID $($listenerAfterStop.OwningProcess): $commandLine"
  }
}

$env:PORT = [string]$Port
$env:HOST = $HostName

if ($Foreground) {
  Push-Location $ProjectDir
  try {
    node $ServerFile
  } finally {
    Pop-Location
  }
  exit $LASTEXITCODE
}

$process = Start-Process -FilePath "node" `
  -ArgumentList @($ServerFile) `
  -WorkingDirectory $ProjectDir `
  -RedirectStandardOutput $OutLog `
  -RedirectStandardError $ErrLog `
  -WindowStyle Hidden `
  -PassThru

if ($process.HasExited) {
  Write-Host "FanHao failed to start. Exit code: $($process.ExitCode)"
  if (Test-Path -LiteralPath $ErrLog) {
    Write-Host ""
    Write-Host "Last error log lines:"
    Get-Content -LiteralPath $ErrLog -Tail 40
  }
  exit 1
}

for ($i = 0; $i -lt 60; $i++) {
  Start-Sleep -Milliseconds 500
  if ($process.HasExited) { break }

  $ready = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue |
    Where-Object { $_.OwningProcess -eq $process.Id } |
    Select-Object -First 1

  if ($ready) { break }
}

if (-not $ready) {
  Write-Host "FanHao process started (PID $($process.Id)), but port $Port is not listening yet."
  Write-Host "Logs:"
  Write-Host "  $OutLog"
  Write-Host "  $ErrLog"
  exit 2
}

Write-Host "FanHao started: http://127.0.0.1:$Port (PID $($process.Id))"
Write-Host "Logs:"
Write-Host "  $OutLog"
Write-Host "  $ErrLog"
