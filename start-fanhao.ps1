param(
  [int]$Port = 29998,
  [string]$HostName = "0.0.0.0",
  [int]$DownloadManagerPort = 8765,
  [switch]$Restart,
  [switch]$RestartDownloadManager,
  [switch]$SkipDownloadManager,
  [switch]$Foreground
)

$ErrorActionPreference = "Stop"

$ProjectDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ServerFile = Join-Path $ProjectDir "server.js"
$ShortVideoBuildScript = Join-Path $ProjectDir "tools\build_short_video_web.mjs"
$DownloadManagerScript = Join-Path $ProjectDir "src\modules\short-videos\download-manager\run.ps1"
$LogDir = Join-Path $ProjectDir "logs"
$OutLog = Join-Path $LogDir "fanhao.out.log"
$ErrLog = Join-Path $LogDir "fanhao.err.log"

function Test-FanhaoHealth {
  param([int]$HealthPort)

  try {
    $health = Invoke-RestMethod -Uri "http://127.0.0.1:$HealthPort/api/health" -TimeoutSec 5
    return [bool]$health.ok
  } catch {
    return $false
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

function Start-DownloadManagerInBackground {
  if ($SkipDownloadManager) { return }
  if (-not (Test-Path -LiteralPath $DownloadManagerScript -PathType Leaf)) {
    throw "Douyin Download Manager launcher not found: $DownloadManagerScript"
  }

  if (-not $RestartDownloadManager) {
    $health = $null
    try {
      $health = Invoke-RestMethod -Uri "http://127.0.0.1:$DownloadManagerPort/api/health" -TimeoutSec 1
    } catch {}
    if ($health.ok) {
      $expectedBase = [System.IO.Path]::GetFullPath((Split-Path -Parent $DownloadManagerScript))
      $runningBase = [System.IO.Path]::GetFullPath([string]$health.paths.base)
      if (-not $runningBase.Equals($expectedBase, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Port $DownloadManagerPort is served by another download-manager installation: $runningBase"
      }
      Write-Host "Douyin Download Manager is ready: http://127.0.0.1:$DownloadManagerPort"
      return
    }

    try {
      # Compatibility with a manager process started before /api/health existed.
      $state = Invoke-RestMethod -Uri "http://127.0.0.1:$DownloadManagerPort/api/state" -TimeoutSec 2
      if ($state) {
        $expectedBase = [System.IO.Path]::GetFullPath((Split-Path -Parent $DownloadManagerScript))
        $runningBase = [System.IO.Path]::GetFullPath([string]$state.paths.base)
        if (-not $runningBase.Equals($expectedBase, [System.StringComparison]::OrdinalIgnoreCase)) {
          throw "Port $DownloadManagerPort is served by another download-manager installation: $runningBase"
        }
        Write-Host "Douyin Download Manager is ready: http://127.0.0.1:$DownloadManagerPort"
        return
      }
    } catch {
      if ($_.Exception.Message -like "Port $DownloadManagerPort is served by another download-manager installation:*") { throw }
    }
  }

  $downloadManagerArgs = @(
    "-NoProfile",
    "-ExecutionPolicy", "Bypass",
    "-File", ('"{0}"' -f $DownloadManagerScript),
    "-Port", [string]$DownloadManagerPort
  )
  if ($RestartDownloadManager) { $downloadManagerArgs += "-Restart" }
  $launcher = Start-Process -FilePath "powershell.exe" `
    -ArgumentList $downloadManagerArgs `
    -WorkingDirectory $ProjectDir `
    -WindowStyle Hidden `
    -PassThru
  Write-Host "Douyin Download Manager is starting independently on port $DownloadManagerPort (launcher PID $($launcher.Id))."
}

New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

$listenerProcessId = Get-ListeningProcessId -LocalPort $Port
if ($null -ne $listenerProcessId) {
  $healthy = Test-FanhaoHealth -HealthPort $Port
  if ($healthy -and -not $Restart) {
    Start-DownloadManagerInBackground
    Write-Host "FanHao is already running on http://127.0.0.1:$Port (PID $listenerProcessId, healthy)."
    exit 0
  }

  $owner = Get-Process -Id $listenerProcessId -ErrorAction SilentlyContinue
  $ownerName = if ($owner) { $owner.ProcessName } else { "unknown" }
  if (-not $Restart) {
    throw "Port $Port is already in use by PID $listenerProcessId ($ownerName), but /api/health is not healthy. Use -Restart only if this is the FanHao Node process."
  }
  if (-not $healthy -and $ownerName -ne "node") {
    throw "Port $Port is already in use by PID $listenerProcessId ($ownerName). Refusing to stop a non-FanHao process."
  }

  Write-Host "Stopping existing FanHao process on port $Port (PID $listenerProcessId)."
  Stop-Process -Id $listenerProcessId -Force

  for ($i = 0; $i -lt 20; $i++) {
    Start-Sleep -Milliseconds 500
    $stillListeningProcessId = Get-ListeningProcessId -LocalPort $Port
    if ($null -eq $stillListeningProcessId) { break }
  }

  $listenerAfterStopProcessId = Get-ListeningProcessId -LocalPort $Port
  if ($null -ne $listenerAfterStopProcessId) {
    throw "Port $Port is still in use by PID $listenerAfterStopProcessId after the restart attempt."
  }
}

Start-DownloadManagerInBackground

if (-not (Test-Path -LiteralPath $ServerFile)) {
  throw "server.js not found in $ProjectDir"
}

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  throw "Node.js was not found in PATH. Install Node.js 20+ or add node.exe to PATH."
}

if (-not (Test-Path -LiteralPath $ShortVideoBuildScript)) {
  throw "Short-video web build script not found: $ShortVideoBuildScript"
}

Write-Host "Preparing FanHao web assets..."
Push-Location $ProjectDir
try {
  & node $ShortVideoBuildScript
  if ($LASTEXITCODE -ne 0) {
    throw "Short-video web build failed. Exit code: $LASTEXITCODE"
  }
} finally {
  Pop-Location
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

Write-Host "Starting FanHao on port $Port (PID $($process.Id))..."

if ($process.HasExited) {
  Write-Host "FanHao failed to start. Exit code: $($process.ExitCode)"
  if (Test-Path -LiteralPath $ErrLog) {
    Write-Host ""
    Write-Host "Last error log lines:"
    Get-Content -LiteralPath $ErrLog -Tail 40
  }
  exit 1
}

$ready = $false
for ($i = 0; $i -lt 60; $i++) {
  Start-Sleep -Milliseconds 500
  if ($process.HasExited) { break }

  $readyProcessId = Get-ListeningProcessId -LocalPort $Port
  if ($readyProcessId -eq $process.Id) {
    $ready = $true
    break
  }
}

if (-not $ready) {
  if (-not $process.HasExited) {
    Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
  }
  Write-Host "FanHao process started (PID $($process.Id)), but port $Port is not listening yet."
  Write-Host "The stalled startup process has been stopped."
  Write-Host "Logs:"
  Write-Host "  $OutLog"
  Write-Host "  $ErrLog"
  exit 2
}

Write-Host "FanHao started: http://127.0.0.1:$Port (PID $($process.Id))"
Write-Host "Logs:"
Write-Host "  $OutLog"
Write-Host "  $ErrLog"
