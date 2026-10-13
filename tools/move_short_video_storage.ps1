param(
  [string]$Source = 'D:\Media',
  [string]$Destination = 'E:\Media',
  [switch]$SkipRestart,
  [switch]$Resume
)

$ErrorActionPreference = 'Stop'
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$sourceRoot = [IO.Path]::GetFullPath($Source).TrimEnd('\')
$destinationRoot = [IO.Path]::GetFullPath($Destination).TrimEnd('\')
$sourceLibrary = Join-Path $sourceRoot 'ShortVideos'
$destinationLibrary = Join-Path $destinationRoot 'ShortVideos'
$statePath = Join-Path $projectRoot 'logs\short-video-storage-move.json'
$logPath = Join-Path $projectRoot 'logs\short-video-storage-move.log'
$baseline = $null
$moveProgress = $null
$startedAt = [DateTimeOffset]::Now.ToString('o')
New-Item -ItemType Directory -Path (Split-Path -Parent $statePath) -Force | Out-Null

function Write-MoveState([string]$Phase, [string]$Message) {
  [ordered]@{ phase=$Phase; message=$Message; source=$sourceRoot; destination=$destinationRoot;
    startedAt=$startedAt; updatedAt=[DateTimeOffset]::Now.ToString('o'); baseline=$baseline; progress=$moveProgress } |
    ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $statePath -Encoding utf8
  Write-Host $Message
}

function Get-MoveInventory([string]$Root) {
  $files = 0L; $bytes = 0L
  Get-ChildItem -LiteralPath $Root -Recurse -Force -File -ErrorAction Stop | ForEach-Object {
    $files++; $bytes += $_.Length
  }
  return [pscustomobject]@{ files=$files; bytes=$bytes }
}

function Stop-OwnedServices {
  $listeners = @(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue |
    Where-Object { $_.LocalPort -in @(29998, 8765) })
  foreach ($listener in $listeners) {
    $owner = Get-CimInstance Win32_Process -Filter "ProcessId=$($listener.OwningProcess)"
    $expected = if ($listener.LocalPort -eq 29998) { Join-Path $projectRoot 'server.js' } else {
      Join-Path $projectRoot 'src\modules\short-videos\download-manager\app.py'
    }
    if (-not $owner.CommandLine.Contains($expected)) { throw "端口 $($listener.LocalPort) 不是本工作区服务，拒绝停止。" }
  }
  if ($listeners.LocalPort -contains 8765) {
    Invoke-RestMethod 'http://127.0.0.1:8765/api/app/quit' -Method Post -ContentType 'application/json' -Body '{}' -TimeoutSec 10 | Out-Null
  }
  $mainIds = @($listeners | Where-Object LocalPort -eq 29998 | Select-Object -ExpandProperty OwningProcess -Unique)
  foreach ($mainId in $mainIds) { Stop-Process -Id $mainId -ErrorAction Stop }
  $timer = [Diagnostics.Stopwatch]::StartNew()
  do {
    $remaining = @(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue |
      Where-Object { $_.LocalPort -in @(29998,8765) })
    if (-not $remaining.Count) { return }
    Start-Sleep -Milliseconds 500
  } while ($timer.Elapsed.TotalSeconds -lt 30)
  throw '服务未停止；未执行文件移动。'
}

Start-Transcript -LiteralPath $logPath -Append | Out-Null
try {
  if ($sourceRoot -ne 'D:\Media' -or $destinationRoot -ne 'E:\Media') { throw '本脚本仅执行已核定的 D:\Media -> E:\Media。' }
  if ($Resume) {
    $previous = Get-Content -LiteralPath $statePath -Raw -ErrorAction Stop | ConvertFrom-Json
    if ($previous.phase -ne 'failed' -or $previous.source -ne $sourceRoot -or $previous.destination -ne $destinationRoot -or -not $previous.baseline) {
      throw '没有匹配的失败迁移记录，拒绝续传。'
    }
    $baseline = $previous.baseline
    $startedAt = $previous.startedAt
  } elseif (Test-Path -LiteralPath $destinationRoot) { throw 'E:\Media 已存在，拒绝覆盖。' }
  if (-not (Test-Path -LiteralPath $sourceLibrary -PathType Container)) { throw '源短视频目录不存在。' }
  if ($PSVersionTable.PSVersion.Major -lt 7) { throw '请使用 PowerShell 7 的 pwsh 运行此脚本，以支持长路径。' }
  if (Get-ChildItem -LiteralPath $sourceRoot -Recurse -Force -Attributes ReparsePoint -ErrorAction Stop | Select-Object -First 1) {
    throw '源目录内存在重解析点，需要先核对其目标。'
  }
  Write-MoveState 'stopping-services' '暂停本工作区主服务和下载器。'
  Stop-OwnedServices
  if (-not $Resume) { $baseline = Get-MoveInventory $sourceRoot }
  $free = (Get-Volume -DriveLetter E -ErrorAction Stop).SizeRemaining
  if ($free -lt $baseline.bytes) { throw 'E 盘空间不足。' }
  $rebaseArgs = @((Join-Path $PSScriptRoot 'rebase_short_video_storage.mjs'),
    '--from', $sourceLibrary, '--to', $destinationLibrary, '--storage-root', $destinationRoot,
    '--no-backup', '--preserve-completed-tombstones', '--cover-db', (Join-Path $projectRoot 'data\short-video-covers.sqlite'))
  Write-MoveState 'preflight' '只读预检媒体路径；省去数据库备份。'
  & node @rebaseArgs --allow-missing-destination --check-offline --preflight-only
  if ($LASTEXITCODE -ne 0) { throw '路径预检失败；未移动文件。' }
  Write-MoveState 'moving' "正在整目录移动 $sourceRoot 到 $destinationRoot；控制台及状态文件显示进度。"
  . (Join-Path $PSScriptRoot 'windows_folder_move.ps1')
  Invoke-WindowsFolderMove -Source $sourceRoot -Destination $destinationRoot -ExpectedFiles $baseline.files -ExpectedBytes $baseline.bytes -Resume:$Resume -OnProgress {
    param($completedFiles,$completedBytes,$percent,$message)
    $script:moveProgress = @{ files=$completedFiles; bytes=$completedBytes; percent=$percent }
    Write-MoveState 'moving' $message
  }
  Write-MoveState 'verifying' '系统移动完成，核对文件数量和总字节数。'
  $actual = Get-MoveInventory $destinationRoot
  if ($actual.files -ne $baseline.files -or $actual.bytes -ne $baseline.bytes) { throw '文件数量或总字节数不符；数据库未切换。' }
  Write-MoveState 'updating-paths' '切换两个数据库的媒体路径，保留收藏、观看记录和已有封面。'
  & node @rebaseArgs --apply --offline-confirmed
  if ($LASTEXITCODE -ne 0) { throw '数据库路径切换失败；服务保持暂停。' }
  [Environment]::SetEnvironmentVariable('FANHAO_SHORT_VIDEO_STORAGE_ROOT', $destinationRoot, 'User')
  $env:FANHAO_SHORT_VIDEO_STORAGE_ROOT = $destinationRoot
  foreach ($override in @('FANHAO_SHORT_VIDEO_ROOTS','FANHAO_DOUYIN_LIKES_ROOT')) {
    foreach ($scope in @('User','Process')) {
      $value = [Environment]::GetEnvironmentVariable($override, $scope)
      if ($value) { [Environment]::SetEnvironmentVariable($override, $value.Replace($sourceLibrary,$destinationLibrary), $scope) }
    }
  }
  $sidecarPath = Join-Path $projectRoot 'src\modules\short-videos\download-manager\data\configs\sidecar.yml'
  if (Test-Path -LiteralPath $sidecarPath) {
    $content = [IO.File]::ReadAllText($sidecarPath)
    $content = $content.Replace($sourceLibrary.Replace('\','\\'),$destinationLibrary.Replace('\','\\')).Replace($sourceLibrary,$destinationLibrary)
    [IO.File]::WriteAllText($sidecarPath,$content,[Text.UTF8Encoding]::new($false))
  }
  if (-not $SkipRestart) {
    Write-MoveState 'restarting' '媒体路径已切换；恢复主服务和下载器。'
    & (Join-Path $projectRoot 'start-fanhao.ps1')
    if ($LASTEXITCODE -ne 0) { throw '迁移已完成，但服务启动失败；请查看服务日志。' }
  }
  Write-MoveState 'completed' '整目录移动及数据库路径切换完成。'
} catch {
  Write-MoveState 'failed' $_.Exception.Message
  throw
} finally {
  Stop-Transcript | Out-Null
}
