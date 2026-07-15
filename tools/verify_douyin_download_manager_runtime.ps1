[CmdletBinding()]
param(
  [string]$Python = ""
)

$ErrorActionPreference = "Stop"
$ProjectRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$TestsDir = Join-Path $ProjectRoot "src\modules\short-videos\download-manager\tests"

if ([string]::IsNullOrWhiteSpace($Python)) {
  $pythonCommand = Get-Command python -ErrorAction SilentlyContinue
  if (-not $pythonCommand) { throw "Python was not found in PATH." }
  $Python = $pythonCommand.Source
}
if (-not (Test-Path -LiteralPath $TestsDir)) {
  throw "Download-manager tests were not found: $TestsDir"
}

$previousDontWriteBytecode = $env:PYTHONDONTWRITEBYTECODE
try {
  $env:PYTHONDONTWRITEBYTECODE = "1"
  & $Python -m unittest discover -s $TestsDir -p "test_*.py" -v
  if ($LASTEXITCODE -ne 0) {
    throw "Download-manager runtime characterization failed with exit code $LASTEXITCODE"
  }
} finally {
  if ($null -eq $previousDontWriteBytecode) {
    Remove-Item Env:PYTHONDONTWRITEBYTECODE -ErrorAction SilentlyContinue
  } else {
    $env:PYTHONDONTWRITEBYTECODE = $previousDontWriteBytecode
  }
}

Write-Host "douyin-download-manager runtime: ok (isolated temp data/log, random loopback ports)"
