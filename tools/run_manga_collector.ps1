[CmdletBinding()]
param(
  [string]$LibraryRoot = $(if ($env:FANHAO_MANGA_ROOT) { $env:FANHAO_MANGA_ROOT } else { 'E:\https-smtt6-com-man-hua-yue' }),
  [string]$SourcesFile = 'smtt6_sources.txt',
  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]]$CollectorArguments
)

$resolvedProjectRoot = Split-Path -Parent $PSScriptRoot
$collectorPath = Join-Path $resolvedProjectRoot 'tools\manga_collector.py'
$resolvedLibraryRoot = [System.IO.Path]::GetFullPath($LibraryRoot)
$resolvedSources = if ([System.IO.Path]::IsPathRooted($SourcesFile)) {
  [System.IO.Path]::GetFullPath($SourcesFile)
} else {
  Join-Path $resolvedLibraryRoot $SourcesFile
}
$databasePath = Join-Path $resolvedLibraryRoot 'manga.sqlite'

if (-not (Test-Path -LiteralPath $resolvedLibraryRoot -PathType Container)) {
  New-Item -ItemType Directory -Path $resolvedLibraryRoot | Out-Null
}

$arguments = @(
  $collectorPath
  '--sources', $resolvedSources
  '--database', $databasePath
)
if ($CollectorArguments) { $arguments += $CollectorArguments }

Push-Location -LiteralPath $resolvedLibraryRoot
try {
  & python @arguments
  exit $LASTEXITCODE
} finally {
  Pop-Location
}
