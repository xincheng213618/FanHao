param(
  [string]$Source = "D:\Media\FanHao\ShortVideos\Douyin\Library",
  [string]$Destination = "D:\Media\ShortVideos",
  [ValidateSet("Copy", "Verify", "Switch")]
  [string]$Phase = "Verify"
)

$ErrorActionPreference = "Stop"
$ProjectRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$Source = [System.IO.Path]::GetFullPath($Source)
$Destination = [System.IO.Path]::GetFullPath($Destination)
$StorageRoot = Split-Path -Parent $Destination
$LogDir = Join-Path $ProjectRoot "logs"
$CopyLog = Join-Path $LogDir "short-video-storage-migration.log"

if ($Source.Equals($Destination, [System.StringComparison]::OrdinalIgnoreCase)) {
  throw "新旧媒体库路径相同。"
}
if (-not (Test-Path -LiteralPath $Source -PathType Container)) {
  throw "源媒体库不存在：$Source"
}

function Get-LibraryInventory([string]$Root) {
  if (-not (Test-Path -LiteralPath $Root -PathType Container)) {
    return [pscustomobject]@{ Files = 0L; Bytes = 0L }
  }
  $measure = Get-ChildItem -LiteralPath $Root -File -Recurse -Force -ErrorAction Stop |
    Measure-Object -Property Length -Sum
  return [pscustomobject]@{ Files = [long]$measure.Count; Bytes = [long]($measure.Sum ?? 0) }
}

function Assert-ServicesStopped {
  foreach ($port in 8765, 29998) {
    $listener = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue |
      Select-Object -First 1
    if ($listener) {
      throw "切换数据库路径前必须停止端口 $port 的服务（PID $($listener.OwningProcess)）。"
    }
  }
}

New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

if ($Phase -eq "Copy") {
  New-Item -ItemType Directory -Force -Path $Destination | Out-Null
  & robocopy $Source $Destination /E /COPY:DAT /DCOPY:DAT /Z /J /MT:16 /R:2 /W:2 /XJ /TEE "/LOG+:$CopyLog"
  $robocopyExit = $LASTEXITCODE
  if ($robocopyExit -ge 8) {
    throw "Robocopy 失败，退出码 $robocopyExit。日志：$CopyLog"
  }
}

$sourceInventory = Get-LibraryInventory $Source
$destinationInventory = Get-LibraryInventory $Destination
Write-Host "源目录：$($sourceInventory.Files) 个文件，$([math]::Round($sourceInventory.Bytes / 1GB, 2)) GB"
Write-Host "目标目录：$($destinationInventory.Files) 个文件，$([math]::Round($destinationInventory.Bytes / 1GB, 2)) GB"

if ($sourceInventory.Files -ne $destinationInventory.Files -or $sourceInventory.Bytes -ne $destinationInventory.Bytes) {
  throw "目标目录尚未完整同步；请重新执行 -Phase Copy。"
}

if ($Phase -eq "Switch") {
  Assert-ServicesStopped
  & node (Join-Path $PSScriptRoot "rebase_short_video_storage.mjs") `
    --from $Source --to $Destination --storage-root $StorageRoot --apply
  if ($LASTEXITCODE -ne 0) { throw "数据库路径切换失败。" }
  Write-Host "数据库已切换到：$Destination"
  Write-Host "旧目录仍然保留；请在 FanHao 和下载器验证正常后再手动删除。"
} else {
  Write-Host "复制校验通过。切换前停止 8765 和 29998 服务，再执行："
  Write-Host ".\tools\migrate_short_video_storage.ps1 -Phase Switch"
}
