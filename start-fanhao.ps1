param(
  [int]$Port = 29998,
  [string]$HostName = "0.0.0.0",
  [int]$DownloadManagerPort = 8765,
  [switch]$Restart,
  [switch]$RestartDownloadManager,
  [switch]$SkipDownloadManager,
  [switch]$Foreground,
  [ValidateRange(5, 600)]
  [int]$StartupTimeoutSeconds = 120
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
  param(
    [int]$HealthPort,
    [ValidateRange(1, 30000)]
    [int]$TimeoutMilliseconds = 5000
  )

  $request = $null
  $response = $null
  try {
    $request = [System.Net.HttpWebRequest]::Create("http://127.0.0.1:$HealthPort/api/health")
    $request.Method = "GET"
    $request.Timeout = $TimeoutMilliseconds
    $request.ReadWriteTimeout = $TimeoutMilliseconds
    $response = $request.GetResponse()
    $reader = New-Object System.IO.StreamReader($response.GetResponseStream())
    try {
      $health = ConvertFrom-Json $reader.ReadToEnd()
    } finally {
      $reader.Dispose()
    }
    return [bool]$health.ok
  } catch {
    return $false
  } finally {
    if ($null -ne $response) { $response.Dispose() }
    if ($null -ne $request) { $request.Abort() }
  }
}

function Write-FanhaoLogTail {
  param([int]$Tail = 40)

  foreach ($log in @(
    @{ Label = "stdout"; Path = $OutLog },
    @{ Label = "stderr"; Path = $ErrLog }
  )) {
    Write-Host ""
    Write-Host "Last $($log.Label) log lines ($($log.Path)):"
    if (Test-Path -LiteralPath $log.Path -PathType Leaf) {
      Get-Content -LiteralPath $log.Path -Tail $Tail
    } else {
      Write-Host "  <log file not created>"
    }
  }
}

function Stop-FanhaoStartupProcess {
  param([Parameter(Mandatory = $true)][System.Diagnostics.Process]$Process)

  if (-not $Process.HasExited) {
    try {
      $Process.Kill()
      $Process.WaitForExit(5000) | Out-Null
    } catch {}
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
  Write-Host "FanHao failed to start before opening its port (PID $($process.Id))."
  Write-FanhaoLogTail
  exit 1
}

$ready = $false
$listenerObserved = $false
$startupTimer = [System.Diagnostics.Stopwatch]::StartNew()
$startupBudgetMilliseconds = [double]$StartupTimeoutSeconds * 1000
while ($startupTimer.Elapsed.TotalMilliseconds -lt $startupBudgetMilliseconds) {
  if ($process.HasExited) {
    Write-Host "FanHao failed to start before opening its port (PID $($process.Id))."
    Write-FanhaoLogTail
    exit 1
  }

  $readyProcessId = Get-ListeningProcessId -LocalPort $Port
  if ($readyProcessId -eq $process.Id) {
    $listenerObserved = $true
    $remainingMilliseconds = $startupBudgetMilliseconds - $startupTimer.Elapsed.TotalMilliseconds
    if ($remainingMilliseconds -gt 0) {
      $healthTimeoutMilliseconds = [Math]::Max(1, [Math]::Min(1000, [int][Math]::Floor($remainingMilliseconds)))
      if (Test-FanhaoHealth -HealthPort $Port -TimeoutMilliseconds $healthTimeoutMilliseconds) {
        $ready = $true
        break
      }
    }
  }

  $remainingMilliseconds = $startupBudgetMilliseconds - $startupTimer.Elapsed.TotalMilliseconds
  if ($remainingMilliseconds -le 0) { break }
  $sleepMilliseconds = [Math]::Max(1, [Math]::Min(250, [int][Math]::Floor($remainingMilliseconds)))
  Start-Sleep -Milliseconds $sleepMilliseconds
}
$startupTimer.Stop()

if (-not $ready) {
  Stop-FanhaoStartupProcess -Process $process
  $readiness = if ($listenerObserved) { "its /api/health endpoint did not become healthy" } else { "it did not listen on port $Port" }
  Write-Host "FanHao startup timed out after $StartupTimeoutSeconds seconds: $readiness (PID $($process.Id))."
  Write-Host "Only the startup process created by this invocation was stopped."
  Write-FanhaoLogTail
  exit 2
}

Write-Host "FanHao started: http://127.0.0.1:$Port (PID $($process.Id))"
Write-Host "Logs:"
Write-Host "  $OutLog"
Write-Host "  $ErrLog"
