<#
.SYNOPSIS
    Save the LTX catalog and its published download links for offline browsing and matching.
.EXAMPLE
    .\tools\sync_ltx_catalog.ps1 -Refresh
.EXAMPLE
    .\tools\sync_ltx_catalog.ps1
#>
[CmdletBinding()]
param(
    [switch]$Refresh,
    [string]$CachePath = (Join-Path $PSScriptRoot '..\data\ltx-catalog.json')
)

$ErrorActionPreference = 'Stop'
$source = 'https://ltx.libray.workers.dev/api/items'
$cachePath = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($CachePath)

if ($Refresh) {
    $request = @{ Uri = $source; UseBasicParsing = $true; TimeoutSec = 15 }
    if ($PSVersionTable.PSVersion -ge [version]'7.4') {
        $request.OperationTimeoutSeconds = 25
    }
    $response = Invoke-WebRequest @request
    $catalog = [Text.Encoding]::UTF8.GetString($response.RawContentStream.ToArray()) | ConvertFrom-Json
    if ($catalog.items -isnot [array] -or $catalog.items.Count -eq 0) {
        throw 'LTX returned no catalog items. The local snapshot was kept.'
    }

    $items = @(foreach ($item in $catalog.items) {
        if ($item.code -isnot [string] -or [string]::IsNullOrWhiteSpace($item.code) -or $item.links -isnot [array]) {
            throw 'Unexpected LTX item format. The local snapshot was kept.'
        }
        if ($null -ne $item.pending_links -and $item.pending_links -isnot [array]) {
            throw 'Unexpected LTX pending link format. The local snapshot was kept.'
        }
        $approvedLinks = @(foreach ($link in $item.links) {
            if ($link -isnot [string] -or $link -notmatch '^(ed2k://\|file\||magnet:\?)') {
                throw 'Unexpected LTX link format. The local snapshot was kept.'
            }
            if ($link -cnotin $item.pending_links) { $link }
        })
        [ordered]@{
            code = $item.code
            title = $item.title
            title_zh = $item.title_zh
            actors = $item.actors
            maker = $item.maker
            cover = $item.cover
            added_at = $item.added_at
            date = $item.date
            score = $item.score
            votes = $item.votes
            genres = $item.genres
            pending = ($item.pending -eq $true)
            waiting = ($item.waiting -eq $true)
            missing = ($item.missing -eq $true)
            links = $approvedLinks
        }
    })
    if (-not ($items | Where-Object { $_.links.Count -gt 0 } | Select-Object -First 1)) {
        throw 'LTX returned no published links. The local snapshot was kept.'
    }

    $snapshot = [ordered]@{
        schema_version = 1
        source = $source
        fetched_at = [DateTimeOffset]::UtcNow.ToString('o')
        updated_at = $catalog.updated_at
        avatars = $catalog.avatars
        genres = $catalog.genres
        items = $items
    }

    $directory = [IO.Path]::GetDirectoryName($cachePath)
    $null = [IO.Directory]::CreateDirectory($directory)
    $temporaryPath = Join-Path $directory ('.ltx-' + [guid]::NewGuid().ToString('N') + '.tmp')
    try {
        [IO.File]::WriteAllText($temporaryPath, (ConvertTo-Json -InputObject $snapshot -Depth 6), [Text.UTF8Encoding]::new($false))
        if ([IO.File]::Exists($cachePath)) {
            [IO.File]::Replace($temporaryPath, $cachePath, [NullString]::Value)
        } else {
            [IO.File]::Move($temporaryPath, $cachePath)
        }
    } finally {
        Remove-Item -LiteralPath $temporaryPath -ErrorAction SilentlyContinue
    }
} else {
    if (-not [IO.File]::Exists($cachePath)) {
        throw "Local LTX snapshot missing at $cachePath. Run with -Refresh to create it."
    }
    $snapshot = Get-Content -LiteralPath $cachePath -Raw -Encoding UTF8 | ConvertFrom-Json
}

$links = @($snapshot.items | ForEach-Object { $_.links })
$ed2kCount = @($links -like 'ed2k:*').Count
$magnetCount = @($links -like 'magnet:*').Count
Write-Output "LTX snapshot: $cachePath"
Write-Output "Fetched at: $(([DateTimeOffset]$snapshot.fetched_at).ToUniversalTime().ToString('o'))"
$withLinks = @($snapshot.items | Where-Object { $_.links.Count -gt 0 }).Count
Write-Output "Works: $($snapshot.items.Count); works with published links: $withLinks; eD2k: $ed2kCount; magnet: $magnetCount"
