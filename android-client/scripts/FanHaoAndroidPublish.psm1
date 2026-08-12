Set-StrictMode -Version Latest

$script:FanHaoPackageName = "local.fanhao.library"
$script:FanHaoDebugSignerSha256 = "73ad0fa9e2d96b33e0cfc7fb1e69d3e4a6fb73cb8fe5832df2464756185fa2f0"
$script:FanHaoAndroidVersionCodeMaximum = 2100000000L
$script:FanHaoPublishVersionCodeMaximum = 99999999L
$script:FanHaoMaximumApkBytes = 536870912L
$script:FanHaoDefaultVersionContractPath = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot "..\version.json"))

function Get-FanHaoAndroidVersionLimits {
  [pscustomobject]@{
    AndroidMaximum = $script:FanHaoAndroidVersionCodeMaximum
    PublishMaximum = $script:FanHaoPublishVersionCodeMaximum
  }
}

function New-FanHaoAuthorizedDeviceCheck {
  param(
    [string]$AdbPath = "adb",
    [scriptblock]$DeviceQuery = $null
  )

  if ($null -eq $DeviceQuery) {
    if ([string]::IsNullOrWhiteSpace($AdbPath)) {
      throw "ADB path must be non-empty."
    }
    $resolvedAdbPath = $AdbPath
    $DeviceQuery = {
      $savedErrorActionPreference = $ErrorActionPreference
      try {
        $ErrorActionPreference = "Continue"
        $lines = @(& $resolvedAdbPath devices -l 2>&1)
        $exitCode = $LASTEXITCODE
      } finally {
        $ErrorActionPreference = $savedErrorActionPreference
      }
      [pscustomobject]@{
        ExitCode = $exitCode
        Lines = @($lines | ForEach-Object { $_.ToString() })
      }
    }.GetNewClosure()
  }

  $query = $DeviceQuery
  return {
    param([string[]]$ExpectedSerials = @())

    $queryResults = @(& $query)
    if ($queryResults.Count -ne 1 -or $null -eq $queryResults[0]) {
      throw "ADB device query returned an invalid result; refusing to publish."
    }
    $queryResult = $queryResults[0]
    $exitCode = [int]$queryResult.ExitCode
    if ($exitCode -ne 0) {
      throw "ADB device query failed; refusing to publish (exit $exitCode)."
    }
    $authorizedSerials = @($queryResult.Lines | ForEach-Object {
      if ($_.ToString() -match '^(?<serial>\S+)\s+device(?:\s|$)') { $Matches.serial }
    } | Sort-Object -Unique)
    if ($authorizedSerials.Count -eq 0) {
      throw "No authorized Android device is visible; refusing to publish."
    }
    if ($ExpectedSerials.Count -gt 0) {
      $expected = @($ExpectedSerials | Sort-Object -Unique)
      if (($expected -join "`n") -cne ($authorizedSerials -join "`n")) {
        throw "The authorized ADB device set changed during the publish build; refusing to commit."
      }
    }
    Write-Host "ADB publish preflight: $($authorizedSerials.Count) authorized device(s) visible; no APK will be installed by the publish command."
    return $authorizedSerials
  }.GetNewClosure()
}

function Read-FanHaoVersionContract {
  param([string]$Path = $script:FanHaoDefaultVersionContractPath)

  $resolvedPath = [IO.Path]::GetFullPath($Path)
  $contract = Read-FanHaoJsonObject -Path $resolvedPath -Label "Android version contract"
  $schemaVersion = ConvertTo-FanHaoStrictInteger -Value (Get-FanHaoRequiredProperty -Object $contract -Name "schemaVersion" -Label "Android version contract") -Label "Android version contract schemaVersion" -Maximum 1
  if ($schemaVersion -ne 1) {
    throw "Android version contract schemaVersion must be 1: $resolvedPath"
  }
  $packageName = Get-FanHaoRequiredProperty -Object $contract -Name "packageName" -Label "Android version contract"
  if ($packageName -isnot [string] -or $packageName -cne $script:FanHaoPackageName) {
    throw "Android version contract packageName must be '$script:FanHaoPackageName': $resolvedPath"
  }
  $channel = Get-FanHaoRequiredProperty -Object $contract -Name "channel" -Label "Android version contract"
  if ($channel -isnot [string] -or $channel -cne "debug") {
    throw "Android version contract channel must be 'debug': $resolvedPath"
  }
  $currentVersionCode = ConvertTo-FanHaoStrictInteger -Value (Get-FanHaoRequiredProperty -Object $contract -Name "currentVersionCode" -Label "Android version contract") -Label "Android version contract currentVersionCode" -Maximum $script:FanHaoPublishVersionCodeMaximum
  $highWaterVersionCode = ConvertTo-FanHaoStrictInteger -Value (Get-FanHaoRequiredProperty -Object $contract -Name "highWaterVersionCode" -Label "Android version contract") -Label "Android version contract highWaterVersionCode" -Maximum $script:FanHaoPublishVersionCodeMaximum
  if ($currentVersionCode -ne $highWaterVersionCode) {
    throw "Android version contract currentVersionCode and highWaterVersionCode must advance together: $resolvedPath"
  }
  $defaultVersionName = ConvertTo-FanHaoVersionName -Value (Get-FanHaoRequiredProperty -Object $contract -Name "defaultVersionName" -Label "Android version contract") -Label "Android version contract defaultVersionName" -RequireCanonical

  [pscustomobject]@{
    Path = $resolvedPath
    SchemaVersion = $schemaVersion
    PackageName = $packageName
    Channel = $channel
    CurrentVersionCode = $currentVersionCode
    HighWaterVersionCode = $highWaterVersionCode
    DefaultVersionName = $defaultVersionName
  }
}

function Get-FanHaoAndroidSdkRoot {
  $candidates = @(
    $env:ANDROID_SDK_ROOT,
    $env:ANDROID_HOME,
    (Join-Path $env:LOCALAPPDATA "Android\Sdk")
  ) | Where-Object { $_ } | Select-Object -Unique

  foreach ($candidate in $candidates) {
    if (Test-Path -LiteralPath (Join-Path $candidate "build-tools")) {
      return [IO.Path]::GetFullPath($candidate)
    }
  }
  throw "Android SDK build-tools were not found."
}

function Get-FanHaoLatestBuildToolsDir {
  param([string]$AndroidSdkRoot = (Get-FanHaoAndroidSdkRoot))

  $buildToolsRoot = Join-Path $AndroidSdkRoot "build-tools"
  $candidates = @(Get-ChildItem -LiteralPath $buildToolsRoot -Directory | Where-Object {
    (Test-Path -LiteralPath (Join-Path $_.FullName "aapt.exe")) -and
    (Test-Path -LiteralPath (Join-Path $_.FullName "apksigner.bat"))
  })
  if ($candidates.Count -eq 0) {
    throw "Android SDK aapt/apksigner tools were not found."
  }

  $ranked = @($candidates | Sort-Object -Property @(
    @{ Expression = {
      $parsed = $null
      if ([version]::TryParse($_.Name, [ref]$parsed)) { $parsed } else { [version]"0.0" }
    }; Descending = $true },
    @{ Expression = { $_.Name }; Descending = $true }
  ))
  return $ranked[0].FullName
}

function Invoke-FanHaoCapturedNative {
  param(
    [Parameter(Mandatory = $true)][string]$Command,
    [Parameter(Mandatory = $true)][string[]]$CommandArguments,
    [Parameter(Mandatory = $true)][string]$FailureMessage
  )

  $savedErrorActionPreference = $ErrorActionPreference
  try {
    $ErrorActionPreference = "Continue"
    $output = @(& $Command @CommandArguments 2>&1)
    $exitCode = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $savedErrorActionPreference
  }
  if ($exitCode -ne 0) {
    throw "$FailureMessage (exit $exitCode)`n$($output -join [Environment]::NewLine)"
  }
  return @($output | ForEach-Object { $_.ToString() })
}

function Get-FanHaoApkIdentity {
  param([Parameter(Mandatory = $true)][string]$Path)

  Assert-FanHaoRegularFile -Path $Path -Label "APK"
  $buildToolsDir = Get-FanHaoLatestBuildToolsDir
  $aapt = Join-Path $buildToolsDir "aapt.exe"
  $apkSigner = Join-Path $buildToolsDir "apksigner.bat"

  $badging = Invoke-FanHaoCapturedNative -Command $aapt -CommandArguments @("dump", "badging", $Path) -FailureMessage "aapt could not inspect the APK"
  $packageLine = $badging | Where-Object { $_ -match '^package:\s' } | Select-Object -First 1
  $packageMatch = [regex]::Match(
    [string]$packageLine,
    "name='(?<name>[^']+)'\s+versionCode='(?<code>\d+)'\s+versionName='(?<versionName>[^']*)'"
  )
  if (-not $packageMatch.Success) {
    throw "APK package identity could not be parsed: $Path"
  }

  $versionCode = ConvertTo-FanHaoStrictInteger -Value $packageMatch.Groups["code"].Value -Label "APK versionCode" -Maximum $script:FanHaoAndroidVersionCodeMaximum -AllowString
  $signatureOutput = Invoke-FanHaoCapturedNative -Command $apkSigner -CommandArguments @("verify", "--verbose", "--print-certs", $Path) -FailureMessage "APK signature verification failed"
  $signerCountLine = $signatureOutput | Where-Object { $_ -match '^Number of signers:\s*' } | Select-Object -First 1
  $signerCountMatch = [regex]::Match([string]$signerCountLine, '^Number of signers:\s*(?<count>\d+)\s*$')
  if (-not $signerCountMatch.Success) {
    throw "APK signer count could not be parsed: $Path"
  }
  $signerCount = [int]$signerCountMatch.Groups["count"].Value
  $signerDigests = @($signatureOutput | ForEach-Object {
    $match = [regex]::Match($_, '^Signer #\d+ certificate SHA-256 digest:\s*(?<digest>[0-9a-fA-F]{64})\s*$')
    if ($match.Success) { $match.Groups["digest"].Value.ToLowerInvariant() }
  } | Sort-Object -Unique)

  [pscustomobject]@{
    Path = [IO.Path]::GetFullPath($Path)
    PackageName = $packageMatch.Groups["name"].Value
    VersionCode = $versionCode
    VersionName = $packageMatch.Groups["versionName"].Value
    SignerCount = $signerCount
    SignerSha256 = if ($signerDigests.Count -eq 1) { $signerDigests[0] } else { $signerDigests }
    SignerDigests = $signerDigests
  }
}

function Resolve-FanHaoBuildIdentity {
  param(
    [Parameter(Mandatory = $true)]$VersionCode,
    [Parameter(Mandatory = $true)][AllowNull()][string]$VersionName,
    [switch]$LocalOnly
  )

  $maximum = if ($LocalOnly) {
    $script:FanHaoAndroidVersionCodeMaximum
  } else {
    $script:FanHaoPublishVersionCodeMaximum
  }
  $validatedCode = ConvertTo-FanHaoStrictInteger -Value $VersionCode -Label "versionCode" -Maximum $maximum -AllowString
  if ($LocalOnly -and $validatedCode -le $script:FanHaoPublishVersionCodeMaximum) {
    throw "local-only versionCode must be between $($script:FanHaoPublishVersionCodeMaximum + 1) and $script:FanHaoAndroidVersionCodeMaximum."
  }
  $validatedName = ConvertTo-FanHaoVersionName -Value $VersionName -Label "versionName"
  [pscustomobject]@{
    VersionCode = $validatedCode
    VersionName = $validatedName
    LocalOnly = [bool]$LocalOnly
  }
}

function Assert-FanHaoInstallIdentity {
  param(
    [Parameter(Mandatory = $true)]$Identity,
    [Parameter(Mandatory = $true)]$VersionContract
  )

  $versionCode = ConvertTo-FanHaoStrictInteger -Value (Get-FanHaoRequiredProperty -Object $Identity -Name "VersionCode" -Label "install identity") -Label "install versionCode" -Maximum $script:FanHaoPublishVersionCodeMaximum
  $versionName = ConvertTo-FanHaoVersionName -Value (Get-FanHaoRequiredProperty -Object $Identity -Name "VersionName" -Label "install identity") -Label "install versionName" -RequireCanonical
  $contractCode = ConvertTo-FanHaoStrictInteger -Value (Get-FanHaoRequiredProperty -Object $VersionContract -Name "CurrentVersionCode" -Label "Android version contract") -Label "Android version contract currentVersionCode" -Maximum $script:FanHaoPublishVersionCodeMaximum
  $contractName = ConvertTo-FanHaoVersionName -Value (Get-FanHaoRequiredProperty -Object $VersionContract -Name "DefaultVersionName" -Label "Android version contract") -Label "Android version contract defaultVersionName" -RequireCanonical
  if ($versionCode -ne $contractCode -or $versionName -cne $contractName) {
    throw "-Install requires the tracked Android version contract identity $contractCode / $contractName. Update version.json in a reviewed commit before installing a newer identity."
  }
  return $Identity
}

function Assert-FanHaoDebugApkIdentity {
  param(
    [Parameter(Mandatory = $true)]$Identity,
    [Nullable[long]]$ExpectedVersionCode = $null,
    [AllowNull()][string]$ExpectedVersionName = $null
  )

  $hasExpectedVersionCode = $PSBoundParameters.ContainsKey("ExpectedVersionCode") -and $null -ne $ExpectedVersionCode
  $hasExpectedVersionName = $PSBoundParameters.ContainsKey("ExpectedVersionName") -and $null -ne $ExpectedVersionName

  if ($null -eq $Identity) { throw "APK inspector returned no identity." }
  $packageName = Get-FanHaoRequiredProperty -Object $Identity -Name "PackageName" -Label "APK identity"
  if (-not ($packageName -is [string]) -or $packageName -ne $script:FanHaoPackageName) {
    throw "Unexpected APK packageName: $packageName"
  }

  $versionCode = ConvertTo-FanHaoStrictInteger -Value (Get-FanHaoRequiredProperty -Object $Identity -Name "VersionCode" -Label "APK identity") -Label "APK versionCode" -Maximum $script:FanHaoAndroidVersionCodeMaximum -AllowString
  $versionName = ConvertTo-FanHaoVersionName -Value (Get-FanHaoRequiredProperty -Object $Identity -Name "VersionName" -Label "APK identity") -Label "APK versionName" -RequireCanonical
  $signerCount = ConvertTo-FanHaoStrictInteger -Value (Get-FanHaoRequiredProperty -Object $Identity -Name "SignerCount" -Label "APK identity") -Label "APK signer count" -Maximum 100
  $signerValue = Get-FanHaoRequiredProperty -Object $Identity -Name "SignerSha256" -Label "APK identity"
  $signerDigests = @()
  if ($signerValue -is [string]) {
    $signerDigests = @($signerValue.ToLowerInvariant())
  } elseif ($signerValue -is [System.Collections.IEnumerable]) {
    $signerDigests = @($signerValue | ForEach-Object { ([string]$_).ToLowerInvariant() } | Sort-Object -Unique)
  }
  if ($signerCount -ne 1 -or $signerDigests.Count -ne 1) {
    throw "Debug APK must have exactly one signer."
  }
  if ($signerDigests[0] -notmatch '^[0-9a-f]{64}$' -or $signerDigests[0] -ne $script:FanHaoDebugSignerSha256) {
    throw "Debug APK signer changed; refusing to break the installed update chain."
  }

  if ($hasExpectedVersionCode -and $versionCode -ne [long]$ExpectedVersionCode) {
    throw "APK versionCode identity mismatch: expected $([long]$ExpectedVersionCode), got $versionCode"
  }
  if ($hasExpectedVersionName -and $versionName -cne $ExpectedVersionName) {
    throw "APK versionName identity mismatch: expected '$ExpectedVersionName', got '$versionName'"
  }

  [pscustomobject]@{
    PackageName = $packageName
    VersionCode = $versionCode
    VersionName = $versionName
    SignerCount = $signerCount
    SignerSha256 = $signerDigests[0]
  }
}

function Get-FanHaoDebugPublishPlan {
  param(
    [Parameter(Mandatory = $true)][string]$PublishRoot,
    [Parameter(Mandatory = $true)][string]$TargetApkPath,
    [Parameter(Mandatory = $true)][bool]$HasRequestedVersionCode,
    $RequestedVersionCode = 0,
    [AllowNull()][string]$RequestedVersionName = $null,
    [long]$DateBase = [long](Get-Date -Format "yyMMdd00"),
    [scriptblock]$ApkInspector = $null,
    [string]$VersionContractPath = $script:FanHaoDefaultVersionContractPath
  )

  if ($HasRequestedVersionCode) {
    $requestedCode = ConvertTo-FanHaoStrictInteger -Value $RequestedVersionCode -Label "requested versionCode" -Maximum $script:FanHaoPublishVersionCodeMaximum -AllowString
  } elseif ($RequestedVersionCode -ne 0) {
    throw "requested versionCode must be omitted for automatic selection."
  }
  $validatedDateBase = ConvertTo-FanHaoStrictInteger -Value $DateBase -Label "date version base" -Maximum $script:FanHaoPublishVersionCodeMaximum
  if ($null -eq $ApkInspector) {
    $ApkInspector = { param($Path) Get-FanHaoApkIdentity -Path $Path }
  }

  $history = New-Object System.Collections.Generic.List[object]
  $versionContract = Read-FanHaoVersionContract -Path $VersionContractPath
  $history.Add([pscustomobject]@{
    Source = $versionContract.Path
    VersionCode = $versionContract.HighWaterVersionCode
  })
  $resolvedPublishRoot = [IO.Path]::GetFullPath($PublishRoot)
  if (Test-Path -LiteralPath $resolvedPublishRoot) {
    Assert-FanHaoDirectory -Path $resolvedPublishRoot -Label "publish root"
  }

  foreach ($channel in @("debug", "release")) {
    $channelDir = Join-Path $resolvedPublishRoot $channel
    if (-not (Test-Path -LiteralPath $channelDir)) { continue }
    Assert-FanHaoDirectory -Path $channelDir -Label "$channel publish directory"

    $latestPath = Join-Path $channelDir "latest.json"
    if (Test-Path -LiteralPath $latestPath) {
      $manifest = Read-FanHaoUpdateManifest -Path $latestPath
      $manifestApkFile = Get-FanHaoRequiredProperty -Object $manifest -Name "apkFile" -Label "update manifest"
      if (-not ($manifestApkFile -is [string]) -or [IO.Path]::GetFileName($manifestApkFile) -cne $manifestApkFile) {
        throw "Update manifest apkFile must be a direct file name: $latestPath"
      }
      $manifestApkPath = Join-Path $channelDir $manifestApkFile
      $validatedManifest = Assert-FanHaoUpdateManifest -Manifest $manifest -Channel $channel -ApkPath $manifestApkPath -ApkInspector $ApkInspector -SourcePath $latestPath -AllowLegacyIdentityFields
      $history.Add([pscustomobject]@{ Source = $latestPath; VersionCode = $validatedManifest.VersionCode })
    }

    $publishedApks = @(Get-ChildItem -LiteralPath $channelDir -File -Filter "*.apk")
    foreach ($publishedApk in $publishedApks) {
      if (($publishedApk.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw "Published APK must not be a reparse point: $($publishedApk.FullName)"
      }
      $nameMatch = [regex]::Match($publishedApk.Name, "^fanhao-$channel-(?<code>\d+)\.apk$")
      if (-not $nameMatch.Success) {
        throw "Published APK has a non-canonical file name: $($publishedApk.FullName)"
      }
      $fileNameCode = ConvertTo-FanHaoStrictInteger -Value $nameMatch.Groups["code"].Value -Label "published APK file-name versionCode" -Maximum $script:FanHaoPublishVersionCodeMaximum -AllowString
      $identity = Assert-FanHaoDebugApkIdentity -Identity (& $ApkInspector $publishedApk.FullName) -ExpectedVersionCode $fileNameCode
      $history.Add([pscustomobject]@{ Source = $publishedApk.FullName; VersionCode = $identity.VersionCode })
    }
  }

  # app-debug.apk is scratch output. It may be absent, stale, malformed, or marked
  # local-only, so it is deliberately excluded from the durable publish history.
  # The freshly built APK is verified against the selected identity before commit.
  $targetState = if (Test-Path -LiteralPath "$TargetApkPath.local-only.json") {
    "ignored-local-only-output"
  } elseif (Test-Path -LiteralPath $TargetApkPath) {
    "ignored-build-output"
  } else {
    "missing-build-output"
  }

  $historyMaximum = 0L
  foreach ($entry in $history) {
    if ([long]$entry.VersionCode -gt $historyMaximum) { $historyMaximum = [long]$entry.VersionCode }
  }

  if ($HasRequestedVersionCode) {
    if ($requestedCode -le $historyMaximum) {
      throw "Requested versionCode $requestedCode must be greater than historical maximum $historyMaximum."
    }
    $selectedCode = $requestedCode
  } else {
    if ($historyMaximum -ge $script:FanHaoPublishVersionCodeMaximum) {
      throw "No safe publish versionCode remains above historical maximum $historyMaximum."
    }
    $selectedCode = [Math]::Max($validatedDateBase, $historyMaximum + 1L)
    if ($selectedCode -gt $script:FanHaoPublishVersionCodeMaximum) {
      throw "Automatic versionCode $selectedCode exceeds the project publish ceiling $script:FanHaoPublishVersionCodeMaximum."
    }
  }

  $selectedName = if ($null -eq $RequestedVersionName -or $RequestedVersionName.Length -eq 0) {
    "0.1.$selectedCode-debug"
  } else {
    ConvertTo-FanHaoVersionName -Value $RequestedVersionName -Label "requested versionName"
  }

  [pscustomobject]@{
    VersionCode = [long]$selectedCode
    VersionName = $selectedName
    HistoryMaximum = $historyMaximum
    History = $history.ToArray()
    PublishMaximum = $script:FanHaoPublishVersionCodeMaximum
    VersionContract = $versionContract
    TargetState = $targetState
  }
}

function Publish-FanHaoDebugArtifact {
  param(
    [Parameter(Mandatory = $true)][string]$SourceApkPath,
    [Parameter(Mandatory = $true)][string]$UpdateDir,
    [Parameter(Mandatory = $true)][long]$VersionCode,
    [Parameter(Mandatory = $true)][string]$VersionName,
    [string[]]$Notes = @(),
    [scriptblock]$ApkInspector = $null,
    [scriptblock]$CommitHook = $null
  )

  $validatedCode = ConvertTo-FanHaoStrictInteger -Value $VersionCode -Label "publish versionCode" -Maximum $script:FanHaoPublishVersionCodeMaximum
  $validatedName = ConvertTo-FanHaoVersionName -Value $VersionName -Label "publish versionName"
  if ($null -eq $ApkInspector) {
    $ApkInspector = { param($Path) Get-FanHaoApkIdentity -Path $Path }
  }
  Assert-FanHaoRegularFile -Path $SourceApkPath -Label "source APK"
  $sourceIdentity = Assert-FanHaoDebugApkIdentity -Identity (& $ApkInspector $SourceApkPath) -ExpectedVersionCode $validatedCode -ExpectedVersionName $validatedName

  if (-not (Test-Path -LiteralPath $UpdateDir)) {
    $null = New-Item -ItemType Directory -Path $UpdateDir -Force
  }
  Assert-FanHaoDirectory -Path $UpdateDir -Label "debug publish directory"

  $fileName = "fanhao-debug-$validatedCode.apk"
  $targetApk = Join-Path $UpdateDir $fileName
  $latestPath = Join-Path $UpdateDir "latest.json"
  if (Test-Path -LiteralPath $targetApk) {
    throw "Refusing to overwrite an existing published APK: $targetApk"
  }

  $token = [Guid]::NewGuid().ToString("N")
  $stagedApk = Join-Path $UpdateDir ".$fileName.$token.tmp"
  $stagedManifest = Join-Path $UpdateDir ".latest.$token.tmp"
  $manifestBackup = Join-Path $UpdateDir ".latest.$token.bak"
  $hadPreviousManifest = Test-Path -LiteralPath $latestPath
  $previousManifestSha256 = if ($hadPreviousManifest) {
    (Get-FileHash -LiteralPath $latestPath -Algorithm SHA256).Hash
  } else {
    ""
  }
  $targetApkMoved = $false
  $manifestCommitted = $false
  $publishCompleted = $false
  $preserveManifestBackup = $false
  try {
    Copy-Item -LiteralPath $SourceApkPath -Destination $stagedApk
    $stagedIdentity = Assert-FanHaoDebugApkIdentity -Identity (& $ApkInspector $stagedApk) -ExpectedVersionCode $validatedCode -ExpectedVersionName $validatedName
    $stagedItem = Get-Item -LiteralPath $stagedApk
    if ($stagedItem.Length -le 0 -or $stagedItem.Length -gt $script:FanHaoMaximumApkBytes) {
      throw "Staged APK size is outside the supported range: $($stagedItem.Length)"
    }
    $stagedHash = (Get-FileHash -LiteralPath $stagedApk -Algorithm SHA256).Hash.ToLowerInvariant()
    $noteList = @($Notes | Where-Object { $null -ne $_ } | ForEach-Object { [string]$_ })
    $manifest = [ordered]@{
      channel = "debug"
      packageName = $script:FanHaoPackageName
      versionCode = $validatedCode
      versionName = $validatedName
      apkFile = $fileName
      signerSha256 = $script:FanHaoDebugSignerSha256
      notes = $noteList
      updatedAt = (Get-Date).ToUniversalTime().ToString("o")
      size = [long]$stagedItem.Length
      sha256 = $stagedHash
    }
    $json = $manifest | ConvertTo-Json -Depth 5
    $utf8NoBom = New-Object Text.UTF8Encoding($false)
    [IO.File]::WriteAllText($stagedManifest, "$json`n", $utf8NoBom)

    $roundTrippedManifest = Read-FanHaoUpdateManifest -Path $stagedManifest
    $null = Assert-FanHaoUpdateManifest -Manifest $roundTrippedManifest -Channel "debug" -ApkPath $stagedApk -ExpectedApkFileName $fileName -ApkInspector $ApkInspector -SourcePath $stagedManifest

    [IO.File]::Move($stagedApk, $targetApk)
    $targetApkMoved = $true
    if ($null -ne $CommitHook) { $null = & $CommitHook "BeforeManifestCommit" $targetApk $latestPath }
    if ($hadPreviousManifest) {
      if (-not (Test-Path -LiteralPath $latestPath)) {
        throw "Existing latest.json disappeared during publish; refusing to claim another writer's state."
      }
      $currentManifestSha256 = (Get-FileHash -LiteralPath $latestPath -Algorithm SHA256).Hash
      if ($currentManifestSha256 -cne $previousManifestSha256) {
        throw "Existing latest.json changed during publish; refusing to overwrite another writer's state."
      }
      [IO.File]::Replace($stagedManifest, $latestPath, $manifestBackup, $true)
    } else {
      [IO.File]::Move($stagedManifest, $latestPath)
    }
    $manifestCommitted = $true
    if ($null -ne $CommitHook) { $null = & $CommitHook "AfterManifestCommit" $targetApk $latestPath }
    $publishCompleted = $true
    if (Test-Path -LiteralPath $manifestBackup) {
      try {
        Remove-Item -LiteralPath $manifestBackup -Force
      } catch {
        $preserveManifestBackup = $true
        Write-Warning "Publish committed successfully, but the previous-manifest backup could not be removed: $manifestBackup"
      }
    }

    [pscustomobject]@{
      ApkPath = $targetApk
      ManifestPath = $latestPath
      VersionCode = $validatedCode
      VersionName = $validatedName
      Size = [long]$stagedItem.Length
      Sha256 = $stagedHash
      PackageName = $sourceIdentity.PackageName
      SignerSha256 = $stagedIdentity.SignerSha256
    }
  } catch {
    $publishError = $_
    $rollbackAllowsTargetRemoval = $true
    $rollbackError = $null
    try {
      if ($manifestCommitted -and $hadPreviousManifest -and (Test-Path -LiteralPath $manifestBackup)) {
        $rollbackPath = Join-Path $UpdateDir ".rollback.$token.tmp"
        [IO.File]::Replace($manifestBackup, $latestPath, $rollbackPath, $true)
        if (Test-Path -LiteralPath $rollbackPath) { Remove-Item -LiteralPath $rollbackPath -Force }
      } elseif ($manifestCommitted -and -not $hadPreviousManifest -and (Test-Path -LiteralPath $latestPath)) {
        Remove-Item -LiteralPath $latestPath -Force
      }
    } catch {
      $rollbackAllowsTargetRemoval = $false
      $rollbackError = $_
      $preserveManifestBackup = Test-Path -LiteralPath $manifestBackup
      Write-Warning "Could not restore the previous update manifest state: $($_.Exception.Message)"
    }
    if ($targetApkMoved -and $rollbackAllowsTargetRemoval -and (Test-Path -LiteralPath $targetApk)) {
      Remove-Item -LiteralPath $targetApk -Force
    }
    if ($null -ne $rollbackError) {
      $recoveryMessage = if ($preserveManifestBackup) {
        "Recovery manifest backup preserved at $manifestBackup."
      } else {
        "No recovery manifest backup could be preserved."
      }
      throw "Publish failed and automatic manifest rollback also failed. A committed but post-commit-unverified release may still be served. $recoveryMessage Original error: $($publishError.Exception.Message) Rollback error: $($rollbackError.Exception.Message)"
    }
    throw $publishError
  } finally {
    $temporaryPaths = @($stagedApk, $stagedManifest)
    if (-not $preserveManifestBackup) { $temporaryPaths += $manifestBackup }
    foreach ($temporaryPath in $temporaryPaths) {
      if (Test-Path -LiteralPath $temporaryPath) {
        Remove-Item -LiteralPath $temporaryPath -Force
      }
    }
    if (-not $publishCompleted -and $targetApkMoved -and (Test-Path -LiteralPath $targetApk)) {
      Write-Warning "Publish did not complete; the new APK was retained only because manifest rollback could not be proven safe: $targetApk"
    }
  }
}

function Write-FanHaoLocalOnlyMarker {
  param(
    [Parameter(Mandatory = $true)][string]$ApkPath,
    [Parameter(Mandatory = $true)]$Identity
  )

  Assert-FanHaoRegularFile -Path $ApkPath -Label "local-only APK"
  $validated = Assert-FanHaoDebugApkIdentity -Identity $Identity
  $item = Get-Item -LiteralPath $ApkPath
  $hash = (Get-FileHash -LiteralPath $ApkPath -Algorithm SHA256).Hash.ToLowerInvariant()
  $marker = [ordered]@{
    kind = "fanhao-debug-local-only"
    packageName = $validated.PackageName
    versionCode = $validated.VersionCode
    versionName = $validated.VersionName
    signerSha256 = $validated.SignerSha256
    size = [long]$item.Length
    sha256 = $hash
    createdAt = (Get-Date).ToUniversalTime().ToString("o")
  }
  $markerPath = "$ApkPath.local-only.json"
  $temporaryPath = "$markerPath.$([Guid]::NewGuid().ToString('N')).tmp"
  $backupPath = "$markerPath.$([Guid]::NewGuid().ToString('N')).bak"
  $utf8NoBom = New-Object Text.UTF8Encoding($false)
  try {
    [IO.File]::WriteAllText($temporaryPath, "$(($marker | ConvertTo-Json -Depth 4))`n", $utf8NoBom)
    $roundTrip = Read-FanHaoJsonObject -Path $temporaryPath -Label "local-only marker"
    if ((Get-FanHaoRequiredProperty -Object $roundTrip -Name "kind" -Label "local-only marker") -ne "fanhao-debug-local-only") {
      throw "Local-only marker round-trip validation failed."
    }
    if (Test-Path -LiteralPath $markerPath) {
      [IO.File]::Replace($temporaryPath, $markerPath, $backupPath, $true)
    } else {
      [IO.File]::Move($temporaryPath, $markerPath)
    }
  } finally {
    if (Test-Path -LiteralPath $temporaryPath) { Remove-Item -LiteralPath $temporaryPath -Force }
    if (Test-Path -LiteralPath $backupPath) { Remove-Item -LiteralPath $backupPath -Force }
  }
  return $markerPath
}

function Assert-FanHaoLocalOnlyMarker {
  param(
    [Parameter(Mandatory = $true)][string]$MarkerPath,
    [Parameter(Mandatory = $true)][string]$ApkPath,
    [Parameter(Mandatory = $true)][scriptblock]$ApkInspector
  )

  $marker = Read-FanHaoJsonObject -Path $MarkerPath -Label "local-only marker"
  if ((Get-FanHaoRequiredProperty -Object $marker -Name "kind" -Label "local-only marker") -ne "fanhao-debug-local-only") {
    throw "Local-only marker kind is invalid: $MarkerPath"
  }
  $identity = Assert-FanHaoDebugApkIdentity -Identity (& $ApkInspector $ApkPath)
  $markerPackage = Get-FanHaoRequiredProperty -Object $marker -Name "packageName" -Label "local-only marker"
  $markerCode = ConvertTo-FanHaoStrictInteger -Value (Get-FanHaoRequiredProperty -Object $marker -Name "versionCode" -Label "local-only marker") -Label "local-only marker versionCode" -Maximum $script:FanHaoAndroidVersionCodeMaximum
  $markerName = ConvertTo-FanHaoVersionName -Value (Get-FanHaoRequiredProperty -Object $marker -Name "versionName" -Label "local-only marker") -Label "local-only marker versionName" -RequireCanonical
  $markerSigner = Get-FanHaoRequiredProperty -Object $marker -Name "signerSha256" -Label "local-only marker"
  $markerSize = ConvertTo-FanHaoStrictInteger -Value (Get-FanHaoRequiredProperty -Object $marker -Name "size" -Label "local-only marker") -Label "local-only marker size" -Maximum $script:FanHaoMaximumApkBytes
  $markerSha = ConvertTo-FanHaoSha256 -Value (Get-FanHaoRequiredProperty -Object $marker -Name "sha256" -Label "local-only marker") -Label "local-only marker sha256"
  $item = Get-Item -LiteralPath $ApkPath
  $actualSha = (Get-FileHash -LiteralPath $ApkPath -Algorithm SHA256).Hash.ToLowerInvariant()
  if (
    $markerPackage -ne $identity.PackageName -or
    $markerCode -ne $identity.VersionCode -or
    $markerName -cne $identity.VersionName -or
    $markerSigner -ne $identity.SignerSha256 -or
    $markerSize -ne $item.Length -or
    $markerSha -ne $actualSha
  ) {
    throw "Local-only marker does not match its APK: $MarkerPath"
  }
}

function Read-FanHaoUpdateManifest {
  param([Parameter(Mandatory = $true)][string]$Path)
  Read-FanHaoJsonObject -Path $Path -Label "Android update manifest"
}

function Assert-FanHaoUpdateManifest {
  param(
    [Parameter(Mandatory = $true)]$Manifest,
    [Parameter(Mandatory = $true)][ValidateSet("debug", "release")][string]$Channel,
    [Parameter(Mandatory = $true)][string]$ApkPath,
    [string]$ExpectedApkFileName = "",
    [Parameter(Mandatory = $true)][scriptblock]$ApkInspector,
    [string]$SourcePath = "manifest",
    [switch]$AllowLegacyIdentityFields
  )

  if ($null -eq $Manifest) { throw "Android update manifest must be a JSON object: $SourcePath" }
  $manifestChannel = Get-FanHaoRequiredProperty -Object $Manifest -Name "channel" -Label "update manifest"
  if (-not ($manifestChannel -is [string]) -or $manifestChannel -cne $Channel) {
    throw "Update manifest channel must be '$Channel': $SourcePath"
  }
  $packageProperty = $Manifest.PSObject.Properties["packageName"]
  $signerProperty = $Manifest.PSObject.Properties["signerSha256"]
  $legacyIdentityFields = $null -eq $packageProperty -and $null -eq $signerProperty
  if ($legacyIdentityFields -and -not $AllowLegacyIdentityFields) {
    throw "Update manifest is missing required identity fields packageName and signerSha256: $SourcePath"
  }
  if (($null -eq $packageProperty) -xor ($null -eq $signerProperty)) {
    throw "Update manifest must provide packageName and signerSha256 together: $SourcePath"
  }
  if (-not $legacyIdentityFields) {
    if ($null -eq $packageProperty.Value -or -not ($packageProperty.Value -is [string]) -or $packageProperty.Value -cne $script:FanHaoPackageName) {
      throw "Update manifest packageName is invalid: $SourcePath"
    }
    $packageName = $packageProperty.Value
    $signer = ConvertTo-FanHaoSha256 -Value $signerProperty.Value -Label "update manifest signerSha256"
    if ($signer -ne $script:FanHaoDebugSignerSha256) {
      throw "Update manifest signer identity is invalid: $SourcePath"
    }
  } else {
    $packageName = $script:FanHaoPackageName
    $signer = $script:FanHaoDebugSignerSha256
  }
  $versionCode = ConvertTo-FanHaoStrictInteger -Value (Get-FanHaoRequiredProperty -Object $Manifest -Name "versionCode" -Label "update manifest") -Label "update manifest versionCode" -Maximum $script:FanHaoPublishVersionCodeMaximum
  $versionName = ConvertTo-FanHaoVersionName -Value (Get-FanHaoRequiredProperty -Object $Manifest -Name "versionName" -Label "update manifest") -Label "update manifest versionName" -RequireCanonical
  $apkFile = Get-FanHaoRequiredProperty -Object $Manifest -Name "apkFile" -Label "update manifest"
  $canonicalName = "fanhao-$Channel-$versionCode.apk"
  if (-not ($apkFile -is [string]) -or $apkFile -cne $canonicalName) {
    throw "Update manifest apkFile must be '$canonicalName': $SourcePath"
  }
  if ($ExpectedApkFileName -and $apkFile -cne $ExpectedApkFileName) {
    throw "Update manifest apkFile does not match the staged target: $SourcePath"
  }
  $size = ConvertTo-FanHaoStrictInteger -Value (Get-FanHaoRequiredProperty -Object $Manifest -Name "size" -Label "update manifest") -Label "update manifest size" -Maximum $script:FanHaoMaximumApkBytes
  $sha256 = ConvertTo-FanHaoSha256 -Value (Get-FanHaoRequiredProperty -Object $Manifest -Name "sha256" -Label "update manifest") -Label "update manifest sha256"

  Assert-FanHaoRegularFile -Path $ApkPath -Label "manifest APK"
  $item = Get-Item -LiteralPath $ApkPath
  if ($item.Length -ne $size) {
    throw "Update manifest size does not match its APK: $SourcePath"
  }
  $actualSha = (Get-FileHash -LiteralPath $ApkPath -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($actualSha -ne $sha256) {
    throw "Update manifest SHA-256 does not match its APK: $SourcePath"
  }
  $identity = Assert-FanHaoDebugApkIdentity -Identity (& $ApkInspector $ApkPath) -ExpectedVersionCode $versionCode -ExpectedVersionName $versionName

  [pscustomobject]@{
    Channel = $manifestChannel
    PackageName = $packageName
    VersionCode = $versionCode
    VersionName = $versionName
    ApkFile = $apkFile
    SignerSha256 = $identity.SignerSha256
    Size = $size
    Sha256 = $sha256
    LegacyIdentityFields = $legacyIdentityFields
  }
}

function Read-FanHaoJsonObject {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][string]$Label
  )

  Assert-FanHaoRegularFile -Path $Path -Label $Label
  try {
    $raw = [IO.File]::ReadAllText([IO.Path]::GetFullPath($Path))
    if ([string]::IsNullOrWhiteSpace($raw)) { throw "$Label is empty." }
    $value = $raw | ConvertFrom-Json -ErrorAction Stop
  } catch {
    throw "$Label is invalid JSON: $Path`n$($_.Exception.Message)"
  }
  if ($null -eq $value -or $value -isnot [psobject] -or $value -is [System.Collections.IEnumerable]) {
    throw "$Label must be a JSON object: $Path"
  }
  return $value
}

function Get-FanHaoRequiredProperty {
  param(
    [Parameter(Mandatory = $true)]$Object,
    [Parameter(Mandatory = $true)][string]$Name,
    [Parameter(Mandatory = $true)][string]$Label
  )
  if ($null -eq $Object) { throw "$Label is missing required property '$Name'." }
  $property = $Object.PSObject.Properties[$Name]
  if ($null -eq $property -or $null -eq $property.Value) {
    throw "$Label is missing required property '$Name'."
  }
  return $property.Value
}

function ConvertTo-FanHaoStrictInteger {
  param(
    [Parameter(Mandatory = $true)]$Value,
    [Parameter(Mandatory = $true)][string]$Label,
    [Parameter(Mandatory = $true)][long]$Maximum,
    [switch]$AllowString
  )

  if ($null -eq $Value -or $Value -is [bool]) { throw "$Label must be a positive integer." }
  if ($Value -is [string]) {
    if (-not $AllowString -or $Value -notmatch '^[0-9]+$') { throw "$Label must be a JSON integer." }
  } elseif ($Value -is [double] -or $Value -is [single] -or $Value -is [decimal]) {
    throw "$Label must be a JSON integer."
  }
  $parsed = 0L
  if (-not [long]::TryParse([string]$Value, [Globalization.NumberStyles]::None, [Globalization.CultureInfo]::InvariantCulture, [ref]$parsed)) {
    throw "$Label must be a positive integer."
  }
  if ($parsed -le 0 -or $parsed -gt $Maximum) {
    throw "$Label must be between 1 and $Maximum."
  }
  return $parsed
}

function ConvertTo-FanHaoVersionName {
  param(
    [AllowNull()]$Value,
    [Parameter(Mandatory = $true)][string]$Label,
    [switch]$RequireCanonical
  )

  if ($null -eq $Value -or $Value -isnot [string]) { throw "$Label must be a string." }
  $normalized = $Value.Trim()
  if ([string]::IsNullOrWhiteSpace($normalized) -or $normalized.IndexOfAny([char[]]@("`r", "`n", [char]0)) -ge 0) {
    throw "$Label must be non-empty after trimming."
  }
  if ($RequireCanonical -and $normalized -cne $Value) {
    throw "$Label must not contain leading or trailing whitespace."
  }
  return $normalized
}

function ConvertTo-FanHaoSha256 {
  param(
    [Parameter(Mandatory = $true)]$Value,
    [Parameter(Mandatory = $true)][string]$Label
  )
  if ($Value -isnot [string] -or $Value -notmatch '^[0-9a-fA-F]{64}$') {
    throw "$Label must be a 64-character hexadecimal string."
  }
  return $Value.ToLowerInvariant()
}

function Assert-FanHaoRegularFile {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][string]$Label
  )
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { throw "$Label does not exist: $Path" }
  $item = Get-Item -LiteralPath $Path -Force
  if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
    throw "$Label must not be a reparse point: $Path"
  }
}

function Assert-FanHaoDirectory {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][string]$Label
  )
  if (-not (Test-Path -LiteralPath $Path -PathType Container)) { throw "$Label does not exist: $Path" }
  $item = Get-Item -LiteralPath $Path -Force
  if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
    throw "$Label must not be a reparse point: $Path"
  }
}

Export-ModuleMember -Function @(
  "Get-FanHaoAndroidVersionLimits",
  "New-FanHaoAuthorizedDeviceCheck",
  "Read-FanHaoVersionContract",
  "Get-FanHaoAndroidSdkRoot",
  "Get-FanHaoApkIdentity",
  "Resolve-FanHaoBuildIdentity",
  "Assert-FanHaoInstallIdentity",
  "Assert-FanHaoDebugApkIdentity",
  "Get-FanHaoDebugPublishPlan",
  "Publish-FanHaoDebugArtifact",
  "Write-FanHaoLocalOnlyMarker",
  "Read-FanHaoUpdateManifest",
  "Assert-FanHaoUpdateManifest"
)
