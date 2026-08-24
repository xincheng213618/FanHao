param(
  [Parameter(Mandatory = $true)]
  [string]$Mapping,
  [string]$Root = "D:\Media\ShortVideos",
  [ValidateSet("Audit", "Apply")]
  [string]$Mode = "Audit",
  [string]$Journal = "",
  [switch]$RemoveVerifiedDuplicates,
  [switch]$AllowUnmapped,
  [switch]$SkipConflictGroups,
  [string]$EffectiveMapping = ""
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

function Get-NormalizedFullPath([string]$PathValue) {
  return [System.IO.Path]::GetFullPath($PathValue).TrimEnd([char[]]@('\', '/'))
}

function Test-PathEquals([string]$Left, [string]$Right) {
  return (Get-NormalizedFullPath $Left).Equals(
    (Get-NormalizedFullPath $Right),
    [System.StringComparison]::OrdinalIgnoreCase
  )
}

function Assert-LeafName([string]$Value, [string]$Label) {
  if ([string]::IsNullOrWhiteSpace($Value) -or
      [System.IO.Path]::IsPathRooted($Value) -or
      $Value -in @('.', '..') -or
      $Value.IndexOfAny([char[]]@('\', '/')) -ge 0 -or
      [System.IO.Path]::GetFileName($Value) -ne $Value) {
    throw "$Label 不是安全的单层目录名：$Value"
  }
}

function Get-DirectChildPath([string]$RootPath, [string]$LeafName) {
  Assert-LeafName $LeafName "目录名"
  $candidate = Get-NormalizedFullPath (Join-Path $RootPath $LeafName)
  $parent = Get-NormalizedFullPath ([System.IO.Path]::GetDirectoryName($candidate))
  if (-not (Test-PathEquals $parent $RootPath)) {
    throw "路径越过媒体库一级边界：$candidate"
  }
  return $candidate
}

function Assert-PathInsideRoot([string]$PathValue, [string]$RootPath) {
  $full = Get-NormalizedFullPath $PathValue
  $prefix = (Get-NormalizedFullPath $RootPath) + [System.IO.Path]::DirectorySeparatorChar
  if (-not $full.StartsWith($prefix, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "拒绝操作媒体库以外的路径：$full"
  }
  return $full
}

function Get-RelativeFileInventory([string]$Directory) {
  $base = (Get-NormalizedFullPath $Directory) + [System.IO.Path]::DirectorySeparatorChar
  $rows = @{}
  foreach ($file in Get-ChildItem -LiteralPath $Directory -File -Recurse -Force -ErrorAction Stop) {
    $relative = $file.FullName.Substring($base.Length)
    $rows[$relative] = [pscustomobject]@{
      FullName = $file.FullName
      Length = [long]$file.Length
    }
  }
  return $rows
}

function Test-FileEqual([string]$Left, [string]$Right) {
  $leftItem = Get-Item -LiteralPath $Left -Force -ErrorAction Stop
  $rightItem = Get-Item -LiteralPath $Right -Force -ErrorAction Stop
  if ($leftItem.PSIsContainer -or $rightItem.PSIsContainer) { return $false }
  if ([long]$leftItem.Length -ne [long]$rightItem.Length) { return $false }
  $leftHash = (Get-FileHash -LiteralPath $Left -Algorithm SHA256).Hash
  $rightHash = (Get-FileHash -LiteralPath $Right -Algorithm SHA256).Hash
  return $leftHash.Equals($rightHash, [System.StringComparison]::OrdinalIgnoreCase)
}

function Test-DirectoryEqual([string]$Left, [string]$Right) {
  $leftRows = Get-RelativeFileInventory $Left
  $rightRows = Get-RelativeFileInventory $Right
  if ($leftRows.Count -ne $rightRows.Count) { return $false }
  foreach ($relative in $leftRows.Keys) {
    if (-not $rightRows.ContainsKey($relative)) { return $false }
    if ($leftRows[$relative].Length -ne $rightRows[$relative].Length) { return $false }
  }
  foreach ($relative in $leftRows.Keys) {
    if (-not (Test-FileEqual $leftRows[$relative].FullName $rightRows[$relative].FullName)) {
      return $false
    }
  }
  return $true
}

function Test-ItemEqual([string]$Left, [string]$Right) {
  $leftItem = Get-Item -LiteralPath $Left -Force -ErrorAction Stop
  $rightItem = Get-Item -LiteralPath $Right -Force -ErrorAction Stop
  if ([bool]$leftItem.PSIsContainer -ne [bool]$rightItem.PSIsContainer) { return $false }
  if ($leftItem.PSIsContainer) { return Test-DirectoryEqual $Left $Right }
  return Test-FileEqual $Left $Right
}

function Write-Journal([string]$Action, [string]$Source, [string]$Destination, [string]$State) {
  if ([string]::IsNullOrWhiteSpace($script:JournalPath)) { return }
  $entry = [ordered]@{
    recorded_at = [DateTime]::UtcNow.ToString('o')
    action = $Action
    source = $Source
    destination = $Destination
    state = $State
  }
  $line = ($entry | ConvertTo-Json -Compress) + [Environment]::NewLine
  [System.IO.File]::AppendAllText($script:JournalPath, $line, [System.Text.UTF8Encoding]::new($false))
}

$expectedRoot = Get-NormalizedFullPath "D:\Media\ShortVideos"
$resolvedRoot = Get-NormalizedFullPath $Root
if (-not (Test-PathEquals $resolvedRoot $expectedRoot)) {
  throw "本工具被限定为只处理 $expectedRoot，实际收到：$resolvedRoot"
}
if (-not (Test-Path -LiteralPath $resolvedRoot -PathType Container)) {
  throw "媒体库不存在：$resolvedRoot"
}

$mappingPath = Get-NormalizedFullPath $Mapping
if (-not (Test-Path -LiteralPath $mappingPath -PathType Leaf)) {
  throw "映射文件不存在：$mappingPath"
}
$document = Get-Content -LiteralPath $mappingPath -Raw -Encoding UTF8 | ConvertFrom-Json
if (-not $document.mappings) { throw "映射文件缺少 mappings 数组" }
if ($document.root -and -not (Test-PathEquals ([string]$document.root) $resolvedRoot)) {
  throw "映射文件根目录与实际根目录不一致：$($document.root)"
}

if ([string]::IsNullOrWhiteSpace($Journal)) {
  $Journal = Join-Path (Split-Path -Parent $mappingPath) "short-video-secuid-move-journal.jsonl"
}
$script:JournalPath = Get-NormalizedFullPath $Journal
if ($Mode -eq "Apply") {
  $journalParent = Split-Path -Parent $script:JournalPath
  if (-not (Test-Path -LiteralPath $journalParent -PathType Container)) {
    New-Item -ItemType Directory -Path $journalParent -Force | Out-Null
  }
}

$sourceTargets = @{}
$normalizedRows = New-Object System.Collections.Generic.List[object]
foreach ($row in $document.mappings) {
  $sourceName = ([string]$row.source_name).Trim()
  $targetName = ([string]$row.sec_uid).Trim()
  Assert-LeafName $sourceName "source_name"
  Assert-LeafName $targetName "sec_uid"
  if ($targetName -notmatch '^MS4wLjAB[A-Za-z0-9_-]{20,100}$') {
    throw "目标目录不是有效的 sec_uid：$targetName"
  }
  if ($sourceTargets.ContainsKey($sourceName) -and $sourceTargets[$sourceName] -ne $targetName) {
    throw "同一个源目录映射到了多个目标：$sourceName"
  }
  $sourceTargets[$sourceName] = $targetName
  $normalizedRows.Add([pscustomobject]@{
    SourceName = $sourceName
    TargetName = $targetName
    SourcePath = Get-DirectChildPath $resolvedRoot $sourceName
    TargetPath = Get-DirectChildPath $resolvedRoot $targetName
  })
}

$actualTopNames = @(Get-ChildItem -LiteralPath $resolvedRoot -Directory -Force | ForEach-Object Name)
$mappedTopNames = @{}
foreach ($row in $normalizedRows) {
  $mappedTopNames[$row.SourceName] = $true
  $mappedTopNames[$row.TargetName] = $true
}
$unmapped = @($actualTopNames | Where-Object { -not $mappedTopNames.ContainsKey($_) })
if ($unmapped.Count -gt 0) {
  $preview = ($unmapped | Select-Object -First 10) -join ', '
  if (-not $AllowUnmapped) {
    throw "存在 $($unmapped.Count) 个未映射的一级目录：$preview"
  }
  Write-Host "本轮保留 $($unmapped.Count) 个未映射一级目录：$preview"
}

$plans = New-Object System.Collections.Generic.List[object]
$conflicts = New-Object System.Collections.Generic.List[object]
$duplicateCount = 0
$duplicateFileCount = 0L
$duplicateBytes = 0L
$moveItemCount = 0
$renameCount = 0

foreach ($group in ($normalizedRows | Group-Object TargetName | Sort-Object Name)) {
  $targetName = [string]$group.Name
  $targetPath = Get-DirectChildPath $resolvedRoot $targetName
  $existingSources = @($group.Group | Where-Object { Test-Path -LiteralPath $_.SourcePath -PathType Container })
  if ($existingSources.Count -eq 0) {
    if (Test-Path -LiteralPath $targetPath -PathType Container) { continue }
    throw "映射组既没有源目录也没有目标目录：$targetName"
  }

  $baseRow = $null
  if (Test-Path -LiteralPath $targetPath -PathType Container) {
    $baseRow = $existingSources | Where-Object { Test-PathEquals $_.SourcePath $targetPath } | Select-Object -First 1
    if (-not $baseRow) {
      $baseRow = [pscustomobject]@{
        SourceName = $targetName
        TargetName = $targetName
        SourcePath = $targetPath
        TargetPath = $targetPath
      }
    }
  } else {
    $baseRow = $existingSources | Sort-Object SourceName | Select-Object -First 1
  }

  $knownItems = @{}
  foreach ($item in Get-ChildItem -LiteralPath $baseRow.SourcePath -Force -ErrorAction Stop) {
    $knownItems[$item.Name] = $item.FullName
  }

  $actions = New-Object System.Collections.Generic.List[object]
  foreach ($sourceRow in ($existingSources | Where-Object { -not (Test-PathEquals $_.SourcePath $baseRow.SourcePath) } | Sort-Object SourceName)) {
    foreach ($item in Get-ChildItem -LiteralPath $sourceRow.SourcePath -Force -ErrorAction Stop) {
      $destinationItem = Join-Path $targetPath $item.Name
      if (-not $knownItems.ContainsKey($item.Name)) {
        $actions.Add([pscustomobject]@{
          Kind = 'Move'
          Source = $item.FullName
          Destination = $destinationItem
        })
        $knownItems[$item.Name] = $item.FullName
        $moveItemCount += 1
        continue
      }

      $existingItem = [string]$knownItems[$item.Name]
      if (Test-ItemEqual $item.FullName $existingItem) {
        if ($item.PSIsContainer) {
          $duplicateMeasure = Get-ChildItem -LiteralPath $item.FullName -File -Recurse -Force -ErrorAction Stop |
            Measure-Object -Property Length -Sum
          $duplicateFileCount += [long]$duplicateMeasure.Count
          $duplicateBytes += [long]$duplicateMeasure.Sum
        } else {
          $duplicateFileCount += 1L
          $duplicateBytes += [long]$item.Length
        }
        $actions.Add([pscustomobject]@{
          Kind = 'RemoveDuplicate'
          Source = $item.FullName
          Destination = $destinationItem
        })
        $duplicateCount += 1
      } else {
        $conflicts.Add([pscustomobject]@{
          Target = $targetName
          Child = $item.Name
          Left = $existingItem
          Right = $item.FullName
        })
      }
    }
  }

  $needsRename = -not (Test-PathEquals $baseRow.SourcePath $targetPath)
  if ($needsRename) { $renameCount += 1 }
  $plans.Add([pscustomobject]@{
    TargetName = $targetName
    TargetPath = $targetPath
    BaseSourcePath = $baseRow.SourcePath
    NeedsRename = $needsRename
    Sources = $existingSources
    Actions = $actions
  })
}

Write-Host "一级目录重命名：$renameCount"
Write-Host "合并时移动二级项目：$moveItemCount"
Write-Host "哈希确认的完全相同副本：$duplicateCount"
Write-Host "完全相同副本包含：$duplicateFileCount 个文件，$([math]::Round($duplicateBytes / 1GB, 3)) GiB"
Write-Host "内容冲突：$($conflicts.Count)"

if ($conflicts.Count -gt 0) {
  $conflicts | Select-Object -First 20 | Format-Table -AutoSize | Out-String | Write-Host
  if (-not $SkipConflictGroups) {
    throw "发现 $($conflicts.Count) 个非完全相同的同名项目；未执行任何移动。"
  }
  $blockedTargets = @{}
  foreach ($conflict in $conflicts) { $blockedTargets[[string]$conflict.Target] = $true }
  $plans = @($plans | Where-Object { -not $blockedTargets.ContainsKey([string]$_.TargetName) })
  $blockedMappings = @($document.mappings | Where-Object {
    $blockedTargets.ContainsKey(([string]$_.sec_uid).Trim())
  })
  $unmapped = @($unmapped) + @($blockedMappings | ForEach-Object { [string]$_.source_name })
  $unmapped = @($unmapped | Sort-Object -Unique)
  Write-Host "本轮跳过 $($blockedTargets.Count) 个冲突目标组、$($blockedMappings.Count) 个源目录。"

  if ([string]::IsNullOrWhiteSpace($EffectiveMapping)) {
    $EffectiveMapping = Join-Path (Split-Path -Parent $mappingPath) "short-video-secuid-migration-map-effective.json"
  }
  $effectiveMappingPath = Get-NormalizedFullPath $EffectiveMapping
  $effectiveDocument = [ordered]@{
    root = $resolvedRoot
    generated_at = [DateTime]::UtcNow.ToString('o')
    source_mapping = $mappingPath
    mappings = @($document.mappings | Where-Object {
      -not $blockedTargets.ContainsKey(([string]$_.sec_uid).Trim())
    })
    unresolved = @($document.unresolved) + @($blockedMappings | ForEach-Object {
      [ordered]@{
        source_name = $_.source_name
        sec_uid = $_.sec_uid
        reason = 'non_identical_second_level_collision'
      }
    })
    skipped_conflict_targets = @($blockedTargets.Keys | Sort-Object)
  }
  $effectiveJson = $effectiveDocument | ConvertTo-Json -Depth 12
  [System.IO.File]::WriteAllText(
    $effectiveMappingPath,
    $effectiveJson + [Environment]::NewLine,
    [System.Text.UTF8Encoding]::new($false)
  )
  Write-Host "无冲突有效映射已写入：$effectiveMappingPath"
}
if ($Mode -eq 'Audit') {
  Write-Host "审计通过；未改动文件系统。"
  exit 0
}
if ($duplicateCount -gt 0 -and -not $RemoveVerifiedDuplicates) {
  throw "存在 $duplicateCount 个完全相同副本；Apply 时必须显式传入 -RemoveVerifiedDuplicates。"
}

foreach ($plan in $plans) {
  if ($plan.NeedsRename) {
    Assert-PathInsideRoot $plan.BaseSourcePath $resolvedRoot | Out-Null
    Assert-PathInsideRoot $plan.TargetPath $resolvedRoot | Out-Null
    if ((Test-Path -LiteralPath $plan.BaseSourcePath -PathType Container) -and
        -not (Test-Path -LiteralPath $plan.TargetPath)) {
      Write-Journal 'MoveAuthorDirectory' $plan.BaseSourcePath $plan.TargetPath 'planned'
      Move-Item -LiteralPath $plan.BaseSourcePath -Destination $plan.TargetPath -ErrorAction Stop
      Write-Journal 'MoveAuthorDirectory' $plan.BaseSourcePath $plan.TargetPath 'completed'
    }
  }

  foreach ($action in $plan.Actions) {
    $sourcePath = Assert-PathInsideRoot $action.Source $resolvedRoot
    $destinationPath = Assert-PathInsideRoot $action.Destination $resolvedRoot
    if ($action.Kind -eq 'Move') {
      if (-not (Test-Path -LiteralPath $sourcePath)) { continue }
      if (Test-Path -LiteralPath $destinationPath) {
        throw "移动目标在执行期间意外出现：$destinationPath"
      }
      Write-Journal 'MoveChildItem' $sourcePath $destinationPath 'planned'
      Move-Item -LiteralPath $sourcePath -Destination $destinationPath -ErrorAction Stop
      Write-Journal 'MoveChildItem' $sourcePath $destinationPath 'completed'
      continue
    }

    if (-not (Test-Path -LiteralPath $sourcePath)) { continue }
    if (-not (Test-Path -LiteralPath $destinationPath)) {
      throw "重复项的保留目标不存在：$destinationPath"
    }
    if (-not (Test-ItemEqual $sourcePath $destinationPath)) {
      throw "重复项在执行期间发生变化，拒绝删除：$sourcePath"
    }
    Write-Journal 'RemoveVerifiedDuplicate' $sourcePath $destinationPath 'planned'
    $sourceItem = Get-Item -LiteralPath $sourcePath -Force -ErrorAction Stop
    if ($sourceItem.PSIsContainer) {
      Remove-Item -LiteralPath $sourcePath -Recurse -Force -ErrorAction Stop
    } else {
      Remove-Item -LiteralPath $sourcePath -Force -ErrorAction Stop
    }
    Write-Journal 'RemoveVerifiedDuplicate' $sourcePath $destinationPath 'completed'
  }

  foreach ($sourceRow in $plan.Sources) {
    $sourcePath = Get-NormalizedFullPath $sourceRow.SourcePath
    if (Test-PathEquals $sourcePath $plan.TargetPath) { continue }
    if (-not (Test-Path -LiteralPath $sourcePath -PathType Container)) { continue }
    Assert-PathInsideRoot $sourcePath $resolvedRoot | Out-Null
    $remaining = Get-ChildItem -LiteralPath $sourcePath -Force -ErrorAction Stop | Select-Object -First 1
    if ($remaining) { throw "合并后源目录仍非空：$sourcePath" }
    Write-Journal 'RemoveEmptyAuthorDirectory' $sourcePath '' 'planned'
    Remove-Item -LiteralPath $sourcePath -Force -ErrorAction Stop
    Write-Journal 'RemoveEmptyAuthorDirectory' $sourcePath '' 'completed'
  }
}

$remainingTop = @(Get-ChildItem -LiteralPath $resolvedRoot -Directory -Force)
$invalidTop = @($remainingTop | Where-Object { $_.Name -notmatch '^MS4wLjAB[A-Za-z0-9_-]{20,100}$' })
if ($invalidTop.Count -gt 0 -and -not $AllowUnmapped) {
  throw "迁移结束后仍有 $($invalidTop.Count) 个非 sec_uid 一级目录。"
}
if ($AllowUnmapped) {
  $unmappedSet = @{}
  foreach ($name in $unmapped) { $unmappedSet[$name] = $true }
  $unexpectedInvalid = @($invalidTop | Where-Object { -not $unmappedSet.ContainsKey($_.Name) })
  $missingUnmapped = @($unmapped | Where-Object {
    -not (Test-Path -LiteralPath (Get-DirectChildPath $resolvedRoot $_) -PathType Container)
  })
  if ($unexpectedInvalid.Count -gt 0 -or $missingUnmapped.Count -gt 0) {
    throw "保留目录校验失败：unexpected=$($unexpectedInvalid.Count), missing=$($missingUnmapped.Count)"
  }
}
$secUidCount = @($remainingTop | Where-Object { $_.Name -match '^MS4wLjAB[A-Za-z0-9_-]{20,100}$' }).Count
Write-Host "文件系统迁移完成：$secUidCount 个 sec_uid 一级目录，保留 $($invalidTop.Count) 个待补齐目录。"
