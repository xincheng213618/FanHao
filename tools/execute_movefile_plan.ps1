param([Parameter(Mandatory)][string]$Plan, [switch]$Serial, [switch]$Worker, [string]$Drive)
$ErrorActionPreference = 'Stop'
$Plan = (Resolve-Path -LiteralPath $Plan).ProviderPath
$manifest = Get-Content -LiteralPath $Plan -Raw | ConvertFrom-Json
if ($manifest.version -ne 1) { throw 'Unsupported move plan version' }
$stateRoot = Join-Path ([IO.Path]::GetDirectoryName($Plan)) ($manifest.id + '.state')
[IO.Directory]::CreateDirectory($stateRoot) | Out-Null

function Save-State($Value, [string]$Path) {
    $temporary = $Path + '.tmp'
    $Value | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $temporary -Encoding utf8
    Move-Item -LiteralPath $temporary -Destination $Path -Force
}

function Assert-Within([string]$Candidate, [string]$Root) {
    $absolute = [IO.Path]::GetFullPath($Candidate)
    $prefix = [IO.Path]::GetFullPath($Root).TrimEnd('\')
    if ($absolute -ne $prefix -and -not $absolute.StartsWith($prefix+'\', [StringComparison]::OrdinalIgnoreCase)) { throw "Path escaped move root: $absolute" }
    return $absolute
}

function Assert-NoNestedLinks([string]$Candidate, [string]$Root) {
    $current = Assert-Within $Candidate $Root
    while ($current -and $current.Length -ge $Root.Length) {
        if (Test-Path -LiteralPath $current) {
            if ((Get-Item -LiteralPath $current -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "Nested reparse point: $current" }
        }
        if ($current -eq $Root) { break }
        $current = [IO.Path]::GetDirectoryName($current)
    }
}

function Get-Fingerprint([string]$Path) {
    $stream = [IO.File]::OpenRead($Path)
    $hash = [Security.Cryptography.SHA256]::Create()
    try {
        $length = $stream.Length
        $offsets = if ($length -le 196608) { @(0L) } else { @(0L, [long][Math]::Floor($length/2), [long]($length-65536)) | Sort-Object -Unique }
        foreach ($offset in $offsets) {
            $null = $stream.Seek($offset, [IO.SeekOrigin]::Begin)
            $remaining = if ($length -le 196608) { $length } else { 65536L }
            $buffer = [byte[]]::new(65536)
            while ($remaining -gt 0) {
                $count = $stream.Read($buffer, 0, [int][Math]::Min($buffer.Length,$remaining))
                if ($count -eq 0) { throw 'Unexpected end of file' }
                $null = $hash.TransformBlock($buffer,0,$count,$buffer,0)
                $remaining -= $count
            }
        }
        $null = $hash.TransformFinalBlock([byte[]]::new(0),0,0)
        return [Convert]::ToHexString($hash.Hash).ToLowerInvariant()
    } finally { $hash.Dispose(); $stream.Dispose() }
}

function Assert-File($Entry, [string]$Path, [switch]$CheckTime) {
    $item = Get-Item -LiteralPath $Path -Force
    if ($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -or $item.Length -ne $Entry.size) { throw "File identity changed: $Path" }
    if ($CheckTime) {
        $ns = ($item.LastWriteTimeUtc.Ticks - [DateTime]::UnixEpoch.Ticks) * 100L
        if ($ns -ne [long]$Entry.mtimeNs) { throw "Source modified since preview: $Path" }
    }
    if ((Get-Fingerprint $Path) -ne $Entry.fingerprint) { throw "Content fingerprint mismatch: $Path" }
}

function Remove-EmptyTree([string]$Root, [string]$AllowedRoot) {
    $resolved = Assert-Within $Root $AllowedRoot
    if (-not (Test-Path -LiteralPath $resolved)) { return }
    foreach ($directory in @(Get-ChildItem -LiteralPath $resolved -Directory -Recurse -Force | Sort-Object { $_.FullName.Length } -Descending)) {
        $path = Assert-Within $directory.FullName $AllowedRoot
        Assert-NoNestedLinks $path $AllowedRoot
        if (@(Get-ChildItem -LiteralPath $path -Force).Count -eq 0) { Remove-Item -LiteralPath $path }
    }
    if (@(Get-ChildItem -LiteralPath $resolved -Force).Count -eq 0) { Remove-Item -LiteralPath $resolved }
}

function Claim-Directory([string]$Root) {
    if (-not (Test-Path -LiteralPath $Root)) { return }
    Assert-NoNestedLinks $Root $Root
    $marker = Join-Path $Root '.fanhao-move-plan.json'
    if (Test-Path -LiteralPath $marker) {
        $owner = Get-Content -LiteralPath $marker -Raw | ConvertFrom-Json
        if ($owner.planId -ne $manifest.id) { throw "Another move plan owns $Root" }
        return
    }
    $stream = [IO.File]::Open($marker,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
    try {
        $data = [Text.Encoding]::UTF8.GetBytes((@{planId=$manifest.id;planPath=$Plan}|ConvertTo-Json))
        $stream.Write($data,0,$data.Length)
        $stream.Flush($true)
    } finally { $stream.Dispose() }
}

function Release-Directory([string]$Root) {
    $marker = Join-Path $Root '.fanhao-move-plan.json'
    if (Test-Path -LiteralPath $marker) {
        Assert-NoNestedLinks $marker $Root
        $owner = Get-Content -LiteralPath $marker -Raw | ConvertFrom-Json
        if ($owner.planId -ne $manifest.id) { throw "Directory owner changed: $Root" }
        Remove-Item -LiteralPath $marker
    }
}

if ($Worker) {
    $tasks = @($manifest.tasks | Where-Object { [IO.Path]::GetPathRoot($_.target) -eq $Drive })
    $completed = 0; $bytes = 0L
    $statusPath = Join-Path $stateRoot (($Drive -replace '[^a-zA-Z0-9]','') + '.json')
    try {
        foreach ($task in $tasks) {
            foreach ($unit in $task.units) {
                foreach ($entry in $unit.files) {
                    $source = Assert-Within $entry.source $task.source
                    $target = Assert-Within $entry.target $task.target
                    Assert-NoNestedLinks $source $task.source
                    Assert-NoNestedLinks $target $task.target
                    if (-not (Test-Path -LiteralPath $source)) {
                        Assert-File $entry $target
                    } else {
                        Assert-File $entry $source -CheckTime
                        [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($target)) | Out-Null
                        if (-not (Test-Path -LiteralPath $target)) {
                            $physicalSource = Join-Path $task.sourcePhysical ([IO.Path]::GetRelativePath($task.source,$source))
                            $physicalTarget = Join-Path $task.targetPhysical ([IO.Path]::GetRelativePath($task.target,$target))
                            if ([IO.Path]::GetPathRoot($physicalSource) -eq [IO.Path]::GetPathRoot($physicalTarget)) {
                                # A mapped drive and a junction can address the
                                # same SMB share. Use the frozen physical paths
                                # so the server can rename instead of recopying.
                                Move-Item -LiteralPath $physicalSource -Destination $physicalTarget
                            } else {
                                $token = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($target))).Substring(0,16)
                                $partial = Join-Path ([IO.Path]::GetDirectoryName($target)) ('.fanhao-move-'+$manifest.id+'-'+$token+'.partial')
                                if (Test-Path -LiteralPath $partial) {
                                    # Only this plan owns this temporary file; the intact source is retained.
                                    Assert-NoNestedLinks $partial $task.target
                                    Remove-Item -LiteralPath $partial
                                }
                                Copy-Item -LiteralPath $source -Destination $partial
                                Assert-File $entry $partial
                                Assert-File $entry $source -CheckTime
                                Move-Item -LiteralPath $partial -Destination $target
                            }
                        }
                        Assert-File $entry $target
                        if (Test-Path -LiteralPath $source) {
                            Assert-File $entry $source -CheckTime
                            Remove-Item -LiteralPath $source
                        }
                    }
                    $completed++; $bytes += [long]$entry.size
                    Save-State @{state='running';completedFiles=$completed;completedBytes=$bytes;source=$source;target=$target} $statusPath
                    Write-Output "$Drive moved $completed files ($([Math]::Round($bytes/1GB,2)) GiB)"
                }
                if ($unit.directory) { Remove-EmptyTree $unit.source $task.source }
                if (Test-Path -LiteralPath $unit.source) { throw "Source unit has new or unexpected remaining files: $($unit.source)" }
                if ($unit.indexed -and $unit.directory) {
                    # Keep the live library usable between large units. The
                    # final metadata pass reconciles durable operation receipts
                    # if the service is offline or a response is uncertain.
                    try {
                        $body = @{personId=[string]$task.personId;sourcePath=$unit.source;targetPath=$unit.target} | ConvertTo-Json
                        $null = Invoke-RestMethod -Uri 'http://127.0.0.1:29998/api/admin/person-folder/relink' -Method Post -ContentType 'application/json' -Body $body -TimeoutSec 30
                    } catch { Write-Output "Index update deferred to metadata reconciliation: $($unit.source)" }
                }
            }
            Release-Directory $task.source
            Remove-EmptyTree $task.source $task.source
            if (Test-Path -LiteralPath $task.source) { throw "Person source directory still contains files: $($task.source)" }
        }
        Save-State @{state='completed';completedFiles=$completed;completedBytes=$bytes} $statusPath
    } catch {
        Save-State @{state='failed';completedFiles=$completed;completedBytes=$bytes;error=$_.Exception.Message} $statusPath
        throw
    }
    return
}

$drives = @($manifest.tasks | ForEach-Object { [IO.Path]::GetPathRoot($_.target) } | Sort-Object -Unique)
$jobs = @()
$executionLock = [IO.File]::Open((Join-Path $stateRoot 'execution.lock'),[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
try {
    foreach ($task in $manifest.tasks) { Claim-Directory $task.source; Claim-Directory $task.target }
    if ($Serial) {
        foreach ($targetDrive in $drives) { & $PSCommandPath -Plan $Plan -Worker -Drive $targetDrive }
    } else {
        foreach ($targetDrive in $drives) {
            $jobs += Start-ThreadJob -ArgumentList $PSCommandPath,$Plan,$targetDrive -ScriptBlock { param($script,$file,$letter); & $script -Plan $file -Worker -Drive $letter }
        }
        while (@($jobs | Where-Object State -in @('Running','NotStarted')).Count) {
            foreach ($job in $jobs) { Receive-Job -Job $job -ErrorAction Stop }
            Start-Sleep -Milliseconds 500
        }
        foreach ($job in $jobs) { Receive-Job -Job $job -ErrorAction Stop; if ($job.State -ne 'Completed') { throw 'A drive worker failed' } }
    }
    Save-State @{state='completed';planId=$manifest.id;totalFiles=$manifest.totalFiles;totalBytes=$manifest.totalBytes} (Join-Path $stateRoot 'status.json')
    foreach ($task in $manifest.tasks) { Release-Directory $task.target }
} catch {
    Save-State @{state='failed';planId=$manifest.id;error=$_.Exception.Message} (Join-Path $stateRoot 'status.json')
    throw
} finally {
    foreach ($job in $jobs) { if ($job.State -in @('Running','NotStarted')) { Stop-Job -Job $job }; Remove-Job -Job $job -Force }
    $executionLock.Dispose()
}
