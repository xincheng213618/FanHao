$ErrorActionPreference = 'Stop'
$fixtureId = [Guid]::NewGuid().ToString('N')
$fixtureSource = [IO.Path]::GetFullPath((Join-Path ([IO.Path]::GetTempPath()) "fanhao-shell-move-$fixtureId"))
$fixtureDestination = [IO.Path]::GetFullPath("E:\fanhao-shell-move-$fixtureId")
try {
  if (Test-Path -LiteralPath $fixtureDestination) { throw 'Fixture destination already exists.' }
  New-Item -ItemType Directory -Path $fixtureSource | Out-Null
  $longDirectory = $fixtureSource
  for ($index=0; $index -lt 6; $index++) { $longDirectory = Join-Path $longDirectory ('a' * 45) }
  New-Item -ItemType Directory -Path $longDirectory -Force | Out-Null
  $shortFile = Join-Path $fixtureSource '视频[fixture].txt'
  $longFile = Join-Path $longDirectory '长路径.txt'
  Set-Content -LiteralPath $shortFile -Value 'unicode-content' -Encoding utf8
  Set-Content -LiteralPath $longFile -Value 'long-path-content' -Encoding utf8
  $sourceHash = (Get-FileHash -LiteralPath $longFile).Hash
  . (Join-Path $PSScriptRoot 'windows_folder_move.ps1')
  Invoke-WindowsFolderMove -Source $fixtureSource -Destination $fixtureDestination
  if (Test-Path -LiteralPath $fixtureSource) { throw 'Source folder was not moved.' }
  $longTarget = Join-Path $fixtureDestination ([IO.Path]::GetRelativePath($fixtureSource,$longFile))
  if ((Get-FileHash -LiteralPath $longTarget).Hash -ne $sourceHash) { throw 'File hash mismatch.' }
  if ((Get-Content -LiteralPath (Join-Path $fixtureDestination '视频[fixture].txt') -Raw).Trim() -ne 'unicode-content') { throw 'Unicode filename/content changed.' }
  # A large synthetic baseline exercises the Int64 progress arithmetic without
  # creating large files. A partial destination verifies interrupted cut resume.
  New-Item -ItemType Directory -Path $fixtureSource | Out-Null
  Set-Content -LiteralPath (Join-Path $fixtureSource '视频[fixture].txt') -Value 'unicode-content' -Encoding utf8
  Set-Content -LiteralPath (Join-Path $fixtureSource 'partial.txt') -Value 'complete-original' -Encoding utf8
  Set-Content -LiteralPath (Join-Path $fixtureDestination 'partial.txt') -Value 'partial' -Encoding utf8
  Invoke-WindowsFolderMove -Source $fixtureSource -Destination $fixtureDestination -Resume -ExpectedFiles 428840 -ExpectedBytes 689446885971
  if (Test-Path -LiteralPath $fixtureSource) { throw 'Resume did not remove the emptied source.' }
  if ((Get-Content -LiteralPath (Join-Path $fixtureDestination 'partial.txt') -Raw).Trim() -ne 'complete-original') { throw 'Partial copy was not restored from its source.' }
  Write-Host 'windows-folder-move: ok (whole folder, cross-volume, Unicode names, long paths, file hashes)'
} finally {
  foreach ($fixturePath in @($fixtureSource,$fixtureDestination)) {
    $resolved = [IO.Path]::GetFullPath($fixturePath)
    if ($resolved -notin @($fixtureSource,$fixtureDestination) -or (Split-Path -Leaf $resolved) -ne "fanhao-shell-move-$fixtureId") { throw 'Unsafe fixture cleanup target.' }
    if (Test-Path -LiteralPath $resolved) { Remove-Item -LiteralPath $resolved -Recurse -Force }
  }
}
