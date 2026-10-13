function Invoke-WindowsFolderMove {
  param(
    [Parameter(Mandatory)][string]$Source,
    [Parameter(Mandatory)][string]$Destination,
    [long]$ExpectedFiles,
    [long]$ExpectedBytes,
    [switch]$Resume,
    [scriptblock]$OnProgress
  )
  $resolvedSource = (Resolve-Path -LiteralPath $Source -ErrorAction Stop).ProviderPath
  $resolvedDestination = [IO.Path]::GetFullPath($Destination)
  $null = Resolve-Path -LiteralPath (Split-Path -Parent $resolvedDestination) -ErrorAction Stop
  if ((Test-Path -LiteralPath $resolvedDestination) -and -not $Resume) { throw "目标已存在，拒绝覆盖：$resolvedDestination" }
  if ((Get-Item -LiteralPath $resolvedSource).Attributes -band [IO.FileAttributes]::ReparsePoint) {
    throw '不能移动重解析点目录。'
  }
  Write-Host "整目录移动：$resolvedSource -> $resolvedDestination"
  # One directory Move-Item operation; PowerShell 7 supports the long paths
  # which Explorer's native progress dialog rejected during fixture validation.
  $job = Start-ThreadJob -ArgumentList $resolvedSource,$resolvedDestination,([bool]$Resume) -ScriptBlock {
    param($from,$to,$resumeMove)
    $ErrorActionPreference = 'Stop'
    if ([IO.Path]::GetFullPath($from) -ne $from -or [IO.Path]::GetFullPath($to) -ne $to) {
      throw '移动路径必须是已核对的绝对路径。'
    }
    if (-not $resumeMove) {
      if (Test-Path -LiteralPath $to) { throw '目标目录已存在。' }
      Move-Item -LiteralPath $from -Destination $to -Force -ErrorAction Stop
      return
    }
    function Move-RemainingDirectory([string]$oldDirectory,[string]$newDirectory) {
      if (($oldDirectory -ne $from -and -not $oldDirectory.StartsWith($from+'\',[StringComparison]::OrdinalIgnoreCase)) -or
          ($newDirectory -ne $to -and -not $newDirectory.StartsWith($to+'\',[StringComparison]::OrdinalIgnoreCase))) {
        throw '续传路径超出已核定媒体根。'
      }
      if (-not (Test-Path -LiteralPath $newDirectory)) {
        Move-Item -LiteralPath $oldDirectory -Destination $newDirectory -Force -ErrorAction Stop
        return
      }
      $targetDirectory = Get-Item -LiteralPath $newDirectory
      if (-not $targetDirectory.PSIsContainer -or ($targetDirectory.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
        throw '目标目录类型异常。'
      }
      foreach ($entry in @(Get-ChildItem -LiteralPath $oldDirectory -Force -ErrorAction Stop)) {
        if ($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw '不能续传重解析点。' }
        $target = Join-Path $newDirectory $entry.Name
        if ($entry.PSIsContainer) { Move-RemainingDirectory $entry.FullName $target; continue }
        if (Test-Path -LiteralPath $target) {
          $targetItem = Get-Item -LiteralPath $target
          if ($targetItem.PSIsContainer -or ($targetItem.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw '目标文件类型异常。' }
          if ($targetItem.Length -eq $entry.Length -and
              (Get-FileHash -LiteralPath $entry.FullName).Hash -eq (Get-FileHash -LiteralPath $target).Hash) {
            # The destination is already complete. Only remove the verified
            # identical source which an interrupted folder move left behind.
            Remove-Item -LiteralPath $entry.FullName -Force -ErrorAction Stop
            continue
          }
        }
        # Existing targets are this operation's interrupted copies. The intact
        # source remains authoritative until Move-Item succeeds.
        Move-Item -LiteralPath $entry.FullName -Destination $target -Force -ErrorAction Stop
      }
      # Non-recursive: this is allowed only after every child has moved.
      Remove-Item -LiteralPath $oldDirectory -Force -ErrorAction Stop
    }
    Move-RemainingDirectory $from $to
  }
  $timer = [Diagnostics.Stopwatch]::StartNew()
  $lastReport = -30.0
  try {
    while ($job.State -in @('NotStarted','Running')) {
      if ($timer.Elapsed.TotalSeconds - $lastReport -ge 30 -and $ExpectedBytes -gt 0) {
        $targetFiles = 0L; $targetBytes = 0L
        if (Test-Path -LiteralPath $resolvedDestination) {
          # Read-only target counts include the file currently being copied;
          # the final inventory below the caller verifies exact completeness.
          Get-ChildItem -LiteralPath $resolvedDestination -File -Recurse -Force -ErrorAction SilentlyContinue |
            ForEach-Object { $targetFiles++; $targetBytes += $_.Length }
        }
        $completedFiles = [Math]::Max([long]0,[long]$targetFiles)
        $completedBytes = [Math]::Max([long]0,[long]$targetBytes)
        $percent = [Math]::Min(99.9,100.0*$completedBytes/$ExpectedBytes)
        $message = '目标目录约 {0:N1}%  {1:N0}/{2:N0} 个文件，{3:N2}/{4:N2} GiB' -f $percent,$completedFiles,$ExpectedFiles,($completedBytes/1GB),($ExpectedBytes/1GB)
        Write-Progress -Activity 'D:\Media -> E:\Media 整目录移动' -Status $message -PercentComplete $percent
        if ($OnProgress) { & $OnProgress $completedFiles $completedBytes $percent $message }
        else { Write-Host $message }
        $lastReport = $timer.Elapsed.TotalSeconds
      }
      Start-Sleep -Milliseconds 500
    }
    Receive-Job -Job $job -ErrorAction Stop | Out-Host
    if ($job.State -ne 'Completed') { throw '整目录移动未完成；数据库路径未切换。' }
    if ((Test-Path -LiteralPath $resolvedSource) -or -not (Test-Path -LiteralPath $resolvedDestination -PathType Container)) {
      throw '源目录仍有内容或目标目录缺失；数据库路径未切换。'
    }
  } finally {
    Write-Progress -Activity '整目录移动' -Completed
    if ($job.State -in @('NotStarted','Running')) { Stop-Job -Job $job }
    Remove-Job -Job $job -Force
  }
}
