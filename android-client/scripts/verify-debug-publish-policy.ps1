$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ProjectDir = Split-Path -Parent $ScriptDir
$ModulePath = Join-Path $ScriptDir "FanHaoAndroidPublish.psm1"
$BuildScript = Join-Path $ProjectDir "build-debug.ps1"
$PublishScript = Join-Path $ProjectDir "publish-debug-update.ps1"
$VersionContractPath = Join-Path $ProjectDir "version.json"
$RealBuildApk = Join-Path $ProjectDir "android\app\build\outputs\apk\debug\app-debug.apk"
Import-Module -Name $ModulePath -Force

$ExpectedPackageName = "local.fanhao.library"
$ExpectedSigner = "73ad0fa9e2d96b33e0cfc7fb1e69d3e4a6fb73cb8fe5832df2464756185fa2f0"
$OtherSigner = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
$TestRoot = Join-Path ([IO.Path]::GetTempPath()) "fanhao-android-publish-$([Guid]::NewGuid().ToString('N'))"
$script:Passed = 0

function Write-Utf8Json {
  param([string]$Path, $Value)
  $parent = Split-Path -Parent $Path
  if (-not (Test-Path -LiteralPath $parent)) { $null = New-Item -ItemType Directory -Path $parent -Force }
  $utf8NoBom = New-Object Text.UTF8Encoding($false)
  [IO.File]::WriteAllText($Path, "$(($Value | ConvertTo-Json -Depth 8))`n", $utf8NoBom)
}

function New-CaseDirectory {
  param([string]$Name)
  $path = Join-Path $TestRoot $Name
  $null = New-Item -ItemType Directory -Path $path -Force
  return $path
}

function New-FakeApk {
  param(
    [string]$Path,
    [long]$VersionCode,
    [string]$VersionName = "",
    [string]$PackageName = $ExpectedPackageName,
    [int]$SignerCount = 1,
    $SignerSha256 = $ExpectedSigner,
    [switch]$ToolFailure
  )
  if (-not $VersionName) { $VersionName = "0.1.$VersionCode-debug" }
  Write-Utf8Json -Path $Path -Value ([ordered]@{
    toolFailure = [bool]$ToolFailure
    packageName = $PackageName
    versionCode = $VersionCode
    versionName = $VersionName
    signerCount = $SignerCount
    signerSha256 = $SignerSha256
  })
  return $Path
}

$FakeInspector = {
  param([string]$Path)
  $payload = [IO.File]::ReadAllText([IO.Path]::GetFullPath($Path)) | ConvertFrom-Json -ErrorAction Stop
  if ($payload.toolFailure) { throw "simulated aapt/apksigner failure" }
  [pscustomobject]@{
    PackageName = $payload.packageName
    VersionCode = $payload.versionCode
    VersionName = $payload.versionName
    SignerCount = $payload.signerCount
    SignerSha256 = $payload.signerSha256
  }
}

function Write-ValidManifest {
  param(
    [string]$Path,
    [string]$Channel,
    [string]$ApkPath,
    [long]$VersionCode,
    [string]$VersionName = ""
  )
  if (-not $VersionName) { $VersionName = "0.1.$VersionCode-debug" }
  $item = Get-Item -LiteralPath $ApkPath
  Write-Utf8Json -Path $Path -Value ([ordered]@{
    channel = $Channel
    packageName = $ExpectedPackageName
    versionCode = $VersionCode
    versionName = $VersionName
    apkFile = [IO.Path]::GetFileName($ApkPath)
    signerSha256 = $ExpectedSigner
    notes = @("fixture")
    updatedAt = "2026-08-11T00:00:00.0000000Z"
    size = [long]$item.Length
    sha256 = (Get-FileHash -LiteralPath $ApkPath -Algorithm SHA256).Hash.ToLowerInvariant()
  })
}

function Assert-Equal {
  param($Actual, $Expected, [string]$Message)
  if ($Actual -cne $Expected) { throw "$Message. Expected '$Expected', got '$Actual'." }
}

function Assert-True {
  param([bool]$Condition, [string]$Message)
  if (-not $Condition) { throw $Message }
}

function Assert-Throws {
  param([scriptblock]$Action, [string]$Pattern, [string]$Message)
  try {
    & $Action
  } catch {
    if ($_.Exception.Message -notmatch $Pattern) {
      throw "$Message. Unexpected error: $($_.Exception.Message)"
    }
    return
  }
  throw "$Message. Expected an exception matching '$Pattern'."
}

function Assert-Fails {
  param([scriptblock]$Action, [string]$Message)
  try {
    & $Action
  } catch {
    return
  }
  throw "$Message. Expected an exception."
}

function Invoke-PolicyTest {
  param([string]$Name, [scriptblock]$Action)
  & $Action
  $script:Passed++
  Write-Host "PASS $Name"
}

function Get-FileFingerprint {
  param([string]$Path)
  if (-not (Test-Path -LiteralPath $Path)) { return "missing" }
  return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash
}

function Get-Plan {
  param(
    [string]$Root,
    [string]$Target,
    [bool]$HasCode = $false,
    $Code = 0,
    [AllowNull()][string]$Name = $null,
    [long]$DateBase = 26081100,
    [scriptblock]$Inspector = $FakeInspector,
    [string]$ContractPath = $VersionContractPath
  )
  Get-FanHaoDebugPublishPlan -PublishRoot $Root -TargetApkPath $Target -HasRequestedVersionCode $HasCode -RequestedVersionCode $Code -RequestedVersionName $Name -DateBase $DateBase -ApkInspector $Inspector -VersionContractPath $ContractPath
}

$null = New-Item -ItemType Directory -Path $TestRoot -Force
try {
  Write-Host "PowerShell runtime: $($PSVersionTable.PSVersion) ($($PSVersionTable.PSEdition))"
  Invoke-PolicyTest "tracked version contract supplies the no-history floor" {
    $case = New-CaseDirectory "no-history"
    $plan = Get-Plan -Root (Join-Path $case "publish") -Target (Join-Path $case "missing.apk")
    Assert-Equal $plan.HistoryMaximum 26081190L "contract high-water mark"
    Assert-Equal $plan.VersionCode 26081191L "automatic versionCode above the contract floor"
    Assert-Equal $plan.VersionContract.DefaultVersionName "0.1.26081190-debug" "contract default versionName"

    $badContract = Join-Path $case "bad-version.json"
    Write-Utf8Json -Path $badContract -Value ([ordered]@{
      schemaVersion = 1
      packageName = $ExpectedPackageName
      channel = "debug"
      currentVersionCode = 26081190
      highWaterVersionCode = 26081189
      defaultVersionName = "0.1.26081190-debug"
    })
    Assert-Throws {
      Get-Plan -Root (Join-Path $case "bad-publish") -Target (Join-Path $case "missing.apk") -ContractPath $badContract
    } "must advance together" "contract floor cannot diverge from its current version"
  }

  Invoke-PolicyTest "published 26073102 plus every scratch-output state stays above the contract floor" {
    $case = New-CaseDirectory "apk-history"
    $debug = Join-Path $case "publish\debug"
    $apk = New-FakeApk -Path (Join-Path $debug "fanhao-debug-26073102.apk") -VersionCode 26073102
    $script:inspectionCount = 0
    $countingInspector = {
      param($Path)
      $script:inspectionCount++
      & $FakeInspector $Path
    }
    $targets = @()
    $targets += [pscustomobject]@{ Name = "missing"; Path = (Join-Path $case "missing-target.apk"); ExpectedState = "missing-build-output" }
    $targets += [pscustomobject]@{ Name = "version-1"; Path = (New-FakeApk -Path (Join-Path $case "version-1.apk") -VersionCode 1 -VersionName "1.0"); ExpectedState = "ignored-build-output" }
    $targets += [pscustomobject]@{ Name = "stale"; Path = (New-FakeApk -Path (Join-Path $case "stale.apk") -VersionCode 26073102); ExpectedState = "ignored-build-output" }
    $malformed = Join-Path $case "malformed.apk"
    [IO.File]::WriteAllText($malformed, "not an APK fixture")
    $targets += [pscustomobject]@{ Name = "malformed"; Path = $malformed; ExpectedState = "ignored-build-output" }
    $localOnly = New-FakeApk -Path (Join-Path $case "local-only.apk") -VersionCode 100000000 -VersionName "local-only"
    $null = Write-FanHaoLocalOnlyMarker -ApkPath $localOnly -Identity (& $FakeInspector $localOnly)
    $targets += [pscustomobject]@{ Name = "local-only"; Path = $localOnly; ExpectedState = "ignored-local-only-output" }

    foreach ($targetCase in $targets) {
      $plan = Get-Plan -Root (Join-Path $case "publish") -Target $targetCase.Path -Inspector $countingInspector
      Assert-Equal $plan.HistoryMaximum 26081190L "$($targetCase.Name) target contract floor"
      Assert-Equal $plan.VersionCode 26081191L "$($targetCase.Name) target successor"
      Assert-Equal $plan.TargetState $targetCase.ExpectedState "$($targetCase.Name) target state"
    }
    Assert-Equal $script:inspectionCount $targets.Count "only the durable published APK must be inspected once per plan"
    Assert-True (Test-Path -LiteralPath $apk) "fixture APK must remain unchanged"
  }

  Invoke-PolicyTest "manifest and published APK directory use the durable global maximum" {
    $case = New-CaseDirectory "three-sources"
    $debug = Join-Path $case "publish\debug"
    $manifestApk = New-FakeApk -Path (Join-Path $debug "fanhao-debug-26081191.apk") -VersionCode 26081191
    Write-ValidManifest -Path (Join-Path $debug "latest.json") -Channel "debug" -ApkPath $manifestApk -VersionCode 26081191
    $null = New-FakeApk -Path (Join-Path $debug "fanhao-debug-26081192.apk") -VersionCode 26081192
    $target = New-FakeApk -Path (Join-Path $case "app-debug.apk") -VersionCode 26081193
    $plan = Get-Plan -Root (Join-Path $case "publish") -Target $target
    Assert-Equal $plan.HistoryMaximum 26081192L "durable historical maximum"
    Assert-Equal $plan.VersionCode 26081193L "durable history successor"
  }

  Invoke-PolicyTest "release channel participates in shared package high-water mark" {
    $case = New-CaseDirectory "release-history"
    $release = Join-Path $case "publish\release"
    $null = New-FakeApk -Path (Join-Path $release "fanhao-release-26081195.apk") -VersionCode 26081195
    $plan = Get-Plan -Root (Join-Path $case "publish") -Target (Join-Path $case "missing.apk")
    Assert-Equal $plan.VersionCode 26081196L "release-channel successor"
  }

  Invoke-PolicyTest "explicit rollback equality and invalid values fail" {
    $case = New-CaseDirectory "explicit"
    $target = New-FakeApk -Path (Join-Path $case "app-debug.apk") -VersionCode 26081190
    foreach ($code in @(26081189L, 26081190L)) {
      Assert-Throws { Get-Plan -Root (Join-Path $case "publish") -Target $target -HasCode $true -Code $code } "greater than historical maximum" "rollback/equal code $code"
    }
    foreach ($code in @(0L, -1L, 100000000L, 2100000000L, 2147483647L)) {
      Assert-Throws { Get-Plan -Root (Join-Path $case "publish") -Target $target -HasCode $true -Code $code } "positive integer|between 1 and 99999999" "out-of-policy explicit code $code"
    }
    $plan = Get-Plan -Root (Join-Path $case "publish") -Target $target -HasCode $true -Code 26081191
    Assert-Equal $plan.VersionCode 26081191L "valid explicit successor"
    Assert-Equal $plan.VersionName "0.1.26081191-debug" "default publish versionName"
  }

  Invoke-PolicyTest "publish ceiling reserves future Android version space" {
    $case = New-CaseDirectory "ceiling"
    $nearMaximum = New-FakeApk -Path (Join-Path $case "publish\debug\fanhao-debug-99999998.apk") -VersionCode 99999998 -VersionName "ceiling-1"
    $plan = Get-Plan -Root (Join-Path $case "publish") -Target (Join-Path $case "missing.apk")
    Assert-Equal $plan.VersionCode 99999999L "last project publish versionCode"
    $maximum = New-FakeApk -Path (Join-Path $case "publish\debug\fanhao-debug-99999999.apk") -VersionCode 99999999 -VersionName "ceiling"
    Assert-Throws { Get-Plan -Root (Join-Path $case "publish") -Target (Join-Path $case "missing.apk") } "No safe publish versionCode remains" "exhausted publish space"
    Assert-True ((Test-Path -LiteralPath $nearMaximum) -and (Test-Path -LiteralPath $maximum)) "ceiling fixtures must remain"
  }

  Invoke-PolicyTest "blank versionName fails before build or publish" {
    Assert-Throws { Resolve-FanHaoBuildIdentity -VersionCode 26081191 -VersionName "   " } "non-empty after trimming" "blank build versionName"
    $case = New-CaseDirectory "blank-name"
    Assert-Throws { Get-Plan -Root (Join-Path $case "publish") -Target (Join-Path $case "missing.apk") -HasCode $true -Code 26081191 -Name " `t " } "non-empty after trimming" "blank publish versionName"
  }

  Invoke-PolicyTest "entry scripts reject bad inputs before build mutation" {
    $beforeBuildApk = Get-FileFingerprint $RealBuildApk
    $savedEnvironmentCode = $env:FANHAO_VERSION_CODE
    $savedEnvironmentName = $env:FANHAO_VERSION_NAME
    try {
      Remove-Item Env:FANHAO_VERSION_CODE -ErrorAction SilentlyContinue
      Remove-Item Env:FANHAO_VERSION_NAME -ErrorAction SilentlyContinue
      $defaultIdentity = @(& $BuildScript -IdentityOnly) | Where-Object { $null -ne $_.PSObject.Properties["VersionCode"] } | Select-Object -Last 1
      Assert-Equal $defaultIdentity.VersionCode 26081190L "no-argument build versionCode from contract"
      Assert-Equal $defaultIdentity.VersionName "0.1.26081190-debug" "no-argument build versionName from contract"
      $defaultInstallIdentity = Assert-FanHaoInstallIdentity -Identity $defaultIdentity -VersionContract (Read-FanHaoVersionContract -Path $VersionContractPath)
      Assert-Equal $defaultInstallIdentity.VersionCode 26081190L "default install versionCode from contract"
      Assert-Equal $defaultInstallIdentity.VersionName "0.1.26081190-debug" "default install versionName from contract"
      Assert-Throws {
        & $BuildScript -Install -VersionCode 26081191
      } "requires the tracked Android version contract identity" "install above the tracked contract must fail before build or ADB"
      Assert-Throws {
        & $BuildScript -Install -IdentityOnly
      } "cannot be combined with -Install" "identity-only probe must not silently replace an install request"
    } finally {
      if ($null -eq $savedEnvironmentCode) { Remove-Item Env:FANHAO_VERSION_CODE -ErrorAction SilentlyContinue } else { $env:FANHAO_VERSION_CODE = $savedEnvironmentCode }
      if ($null -eq $savedEnvironmentName) { Remove-Item Env:FANHAO_VERSION_NAME -ErrorAction SilentlyContinue } else { $env:FANHAO_VERSION_NAME = $savedEnvironmentName }
    }
    Assert-Equal (Get-FileFingerprint $RealBuildApk) $beforeBuildApk "identity/install rejection tests must not build or invoke ADB"
    Assert-Throws {
      & $BuildScript -NoSync -VersionCode 26081191 -VersionName "   "
    } "non-empty after trimming" "build-debug whitespace versionName"
    Assert-Equal (Get-FileFingerprint $RealBuildApk) $beforeBuildApk "blank build versionName must not remove or replace the existing APK"

    $case = New-CaseDirectory "publish-entry-bad-manifest"
    $debug = Join-Path $case "publish\debug"
    $null = New-Item -ItemType Directory -Path $debug -Force
    $latest = Join-Path $debug "latest.json"
    Write-Utf8Json -Path $latest -Value ([pscustomobject]@{})
    $beforeManifest = Get-FileFingerprint $latest
    Assert-Throws {
      & $PublishScript -PublishRoot (Join-Path $case "publish")
    } "missing required property" "publish entry bad manifest"
    Assert-Equal (Get-FileFingerprint $latest) $beforeManifest "bad manifest must stop the entry script before build/publish mutation"
    Assert-Equal (Get-FileFingerprint $RealBuildApk) $beforeBuildApk "bad manifest must stop before rebuilding the target APK"

    $validCase = New-CaseDirectory "publish-entry-plan-only"
    $planOutput = @(& $PublishScript -PublishRoot (Join-Path $validCase "publish") -VersionCode "99999999" -VersionName "fixture-plan" -PlanOnly)
    $entryPlan = @($planOutput | Where-Object { $null -ne $_.PSObject.Properties["VersionCode"] }) | Select-Object -Last 1
    Assert-Equal $entryPlan.VersionCode 99999999L "entry script explicit versionCode must reach the policy without Nullable unwrapping"
    Assert-Equal (Get-FileFingerprint $RealBuildApk) $beforeBuildApk "plan-only entry verification must not build"
    Assert-Throws {
      & $PublishScript -PublishRoot (Join-Path $validCase "fractional") -VersionCode 1.5 -PlanOnly
    } "JSON integer" "fractional entry versionCode"
    Assert-Throws {
      & $PublishScript -PublishRoot (Join-Path $validCase "no-publish-install") -Install -PlanOnly
    } "does not install a newly selected identity" "publish entry must not install an untracked next identity"
  }

  Invoke-PolicyTest "local-only build range is explicit and cannot publish" {
    Assert-Throws { Resolve-FanHaoBuildIdentity -VersionCode 100000000 -VersionName "local" } "between 1 and 99999999" "unmarked non-publish code"
    Assert-Throws { Resolve-FanHaoBuildIdentity -VersionCode 1 -VersionName "local" -LocalOnly } "local-only versionCode must be between" "local-only namespace lower bound"
    Assert-Throws { Resolve-FanHaoBuildIdentity -VersionCode 26081190 -VersionName "local" -LocalOnly } "local-only versionCode must be between" "publishable code cannot masquerade as local-only"
    Assert-Throws { Resolve-FanHaoBuildIdentity -VersionCode 1.5 -VersionName "fraction" } "JSON integer" "fractional build versionCode"
    $identity = Resolve-FanHaoBuildIdentity -VersionCode 100000000 -VersionName "local" -LocalOnly
    Assert-Equal $identity.VersionCode 100000000L "local-only Android-range code"
    Assert-Throws { Resolve-FanHaoBuildIdentity -VersionCode 2147483647 -VersionName "too-high" -LocalOnly } "between 1 and 2100000000" "Android maximum"

    $case = New-CaseDirectory "local-only-marker"
    $target = New-FakeApk -Path (Join-Path $case "app-debug.apk") -VersionCode 100000000 -VersionName "local"
    $fakeIdentity = & $FakeInspector $target
    $pendingMarkerPath = "$target.local-only.json"
    Write-Utf8Json -Path $pendingMarkerPath -Value ([ordered]@{
      kind = "fanhao-debug-local-only-pending"
      versionCode = 100000000
      versionName = "local"
    })
    $marker = Write-FanHaoLocalOnlyMarker -ApkPath $target -Identity $fakeIdentity
    $finalMarker = [IO.File]::ReadAllText($marker) | ConvertFrom-Json
    Assert-Equal $finalMarker.kind "fanhao-debug-local-only" "pending marker must atomically become the final bound marker"
    Assert-Equal @(Get-ChildItem -LiteralPath (Split-Path -Parent $marker) -File -Filter "*.bak").Count 0 "successful marker replacement must remove its backup"
    $markerBeforeLockedReplace = Get-FileFingerprint $marker
    $lockedMarker = [IO.File]::Open($marker, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::None)
    try {
      Assert-Throws {
        Write-FanHaoLocalOnlyMarker -ApkPath $target -Identity $fakeIdentity
      } ".+" "locked local-only marker replacement"
    } finally {
      $lockedMarker.Dispose()
    }
    Assert-Equal (Get-FileFingerprint $marker) $markerBeforeLockedReplace "failed marker replacement must preserve the pending/previous marker"
    Assert-Equal @(Get-ChildItem -LiteralPath (Split-Path -Parent $marker) -File -Filter "*.tmp").Count 0 "failed marker replacement must clean its temporary file"
    $plan = Get-Plan -Root (Join-Path $case "publish") -Target $target
    Assert-Equal $plan.VersionCode 26081191L "local-only scratch output cannot lower or raise the durable floor"
    Assert-Equal $plan.TargetState "ignored-local-only-output" "local-only scratch output state"
    Assert-True (Test-Path -LiteralPath $marker) "local-only marker must remain next to its build artifact"
  }

  Invoke-PolicyTest "fully verified legacy manifest identity fields remain readable" {
    $case = New-CaseDirectory "legacy-manifest"
    $debug = Join-Path $case "publish\debug"
    $apk = New-FakeApk -Path (Join-Path $debug "fanhao-debug-26081190.apk") -VersionCode 26081190
    $latest = Join-Path $debug "latest.json"
    Write-ValidManifest -Path $latest -Channel "debug" -ApkPath $apk -VersionCode 26081190
    $legacy = [IO.File]::ReadAllText($latest) | ConvertFrom-Json
    $legacy.PSObject.Properties.Remove("packageName")
    $legacy.PSObject.Properties.Remove("signerSha256")
    Write-Utf8Json -Path $latest -Value $legacy
    $before = Get-FileFingerprint $latest
    $plan = Get-Plan -Root (Join-Path $case "publish") -Target (Join-Path $case "missing.apk")
    Assert-Equal $plan.VersionCode 26081191L "verified legacy manifest successor"
    Assert-Equal (Get-FileFingerprint $latest) $before "legacy compatibility read must not rewrite production state"

    $partial = [IO.File]::ReadAllText($latest) | ConvertFrom-Json
    $partial | Add-Member -NotePropertyName packageName -NotePropertyValue $ExpectedPackageName
    Write-Utf8Json -Path $latest -Value $partial
    Assert-Throws { Get-Plan -Root (Join-Path $case "publish") -Target (Join-Path $case "missing.apk") } "provide packageName and signerSha256 together" "partially migrated identity fields"
  }

  Invoke-PolicyTest "bad manifest schema and semantics fail closed" {
    $invalidValues = @(
      @{ Name = "empty-object"; Mutate = { param($m) [pscustomobject]@{} } },
      @{ Name = "null"; Raw = "null" },
      @{ Name = "zero-code"; Mutate = { param($m) $m.versionCode = 0; $m } },
      @{ Name = "negative-code"; Mutate = { param($m) $m.versionCode = -1; $m } },
      @{ Name = "string-code"; Mutate = { param($m) $m.versionCode = "26081190"; $m } },
      @{ Name = "null-package"; Mutate = { param($m) $m.packageName = $null; $m } },
      @{ Name = "wrong-package"; Mutate = { param($m) $m.packageName = "evil.example"; $m } },
      @{ Name = "wrong-channel"; Mutate = { param($m) $m.channel = "release"; $m } },
      @{ Name = "blank-name"; Mutate = { param($m) $m.versionName = "   "; $m } },
      @{ Name = "missing-sha"; Mutate = { param($m) $m.PSObject.Properties.Remove("sha256"); $m } },
      @{ Name = "missing-size"; Mutate = { param($m) $m.PSObject.Properties.Remove("size"); $m } }
    )
    foreach ($invalid in $invalidValues) {
      $case = New-CaseDirectory "manifest-$($invalid.Name)"
      $debug = Join-Path $case "publish\debug"
      $apk = New-FakeApk -Path (Join-Path $debug "fanhao-debug-26081190.apk") -VersionCode 26081190
      $latest = Join-Path $debug "latest.json"
      Write-ValidManifest -Path $latest -Channel "debug" -ApkPath $apk -VersionCode 26081190
      if ($invalid.ContainsKey("Raw")) {
        [IO.File]::WriteAllText($latest, $invalid.Raw, (New-Object Text.UTF8Encoding($false)))
      } else {
        $manifest = [IO.File]::ReadAllText($latest) | ConvertFrom-Json
        $manifest = & $invalid.Mutate $manifest
        Write-Utf8Json -Path $latest -Value $manifest
      }
      $beforeApk = Get-FileFingerprint $apk
      $beforeManifest = Get-FileFingerprint $latest
      Assert-Throws { Get-Plan -Root (Join-Path $case "publish") -Target (Join-Path $case "missing.apk") } ".+" "invalid manifest $($invalid.Name)"
      Assert-Equal (Get-FileFingerprint $apk) $beforeApk "invalid manifest must not mutate APK"
      Assert-Equal (Get-FileFingerprint $latest) $beforeManifest "invalid manifest must not mutate latest.json"
    }
  }

  Invoke-PolicyTest "invalid old APK and signer sets fail closed" {
    $cases = @(
      @{ Name = "tool"; ToolFailure = $true; Package = $ExpectedPackageName; Count = 1; Signers = $ExpectedSigner },
      @{ Name = "package"; ToolFailure = $false; Package = "evil.example"; Count = 1; Signers = $ExpectedSigner },
      @{ Name = "signer"; ToolFailure = $false; Package = $ExpectedPackageName; Count = 1; Signers = $OtherSigner },
      @{ Name = "multi-signer"; ToolFailure = $false; Package = $ExpectedPackageName; Count = 2; Signers = @($ExpectedSigner, $OtherSigner) }
    )
    foreach ($invalid in $cases) {
      $case = New-CaseDirectory "bad-apk-$($invalid.Name)"
      $apk = New-FakeApk -Path (Join-Path $case "publish\debug\fanhao-debug-26081190.apk") -VersionCode 26081190 -PackageName $invalid.Package -SignerCount $invalid.Count -SignerSha256 $invalid.Signers -ToolFailure:$invalid.ToolFailure
      $before = Get-FileFingerprint $apk
      Assert-Throws { Get-Plan -Root (Join-Path $case "publish") -Target (Join-Path $case "missing.apk") } ".+" "bad APK $($invalid.Name)"
      Assert-Equal (Get-FileFingerprint $apk) $before "bad APK must remain unchanged"
    }

    $case = New-CaseDirectory "bad-apk-filename"
    $apk = New-FakeApk -Path (Join-Path $case "publish\debug\fanhao-debug-26081190.apk") -VersionCode 26081189
    Assert-Throws { Get-Plan -Root (Join-Path $case "publish") -Target (Join-Path $case "missing.apk") } "versionCode identity mismatch" "file-name/internal version mismatch"
  }

  Invoke-PolicyTest "atomic artifact commit retains previous complete pair" {
    $case = New-CaseDirectory "atomic-success"
    $debug = Join-Path $case "publish\debug"
    $oldApk = New-FakeApk -Path (Join-Path $debug "fanhao-debug-26081190.apk") -VersionCode 26081190
    $latest = Join-Path $debug "latest.json"
    Write-ValidManifest -Path $latest -Channel "debug" -ApkPath $oldApk -VersionCode 26081190
    $oldApkHash = Get-FileFingerprint $oldApk
    $source = New-FakeApk -Path (Join-Path $case "app-debug.apk") -VersionCode 26081191
    $published = Publish-FanHaoDebugArtifact -SourceApkPath $source -UpdateDir $debug -VersionCode 26081191 -VersionName "0.1.26081191-debug" -Notes @("fixture") -ApkInspector $FakeInspector
    Assert-True (Test-Path -LiteralPath $oldApk) "old APK must remain available"
    Assert-Equal (Get-FileFingerprint $oldApk) $oldApkHash "old APK must not be overwritten"
    Assert-True (Test-Path -LiteralPath $published.ApkPath) "new APK must be committed"
    $committed = [IO.File]::ReadAllText($latest) | ConvertFrom-Json
    Assert-Equal $committed.versionCode 26081191 "latest.json must switch last to the new APK"
    Assert-Equal @(Get-ChildItem -LiteralPath $debug -File -Filter ".*.tmp").Count 0 "temporary publish files must be removed"
  }

  Invoke-PolicyTest "staged tool failure preserves previous pair" {
    $case = New-CaseDirectory "atomic-failure"
    $debug = Join-Path $case "publish\debug"
    $oldApk = New-FakeApk -Path (Join-Path $debug "fanhao-debug-26081190.apk") -VersionCode 26081190
    $latest = Join-Path $debug "latest.json"
    Write-ValidManifest -Path $latest -Channel "debug" -ApkPath $oldApk -VersionCode 26081190
    $source = New-FakeApk -Path (Join-Path $case "app-debug.apk") -VersionCode 26081191
    $oldApkHash = Get-FileFingerprint $oldApk
    $oldManifestHash = Get-FileFingerprint $latest
    $stageFailInspector = {
      param($Path)
      if ([IO.Path]::GetFileName($Path) -like ".*.tmp") { throw "simulated staged apksigner failure" }
      & $FakeInspector $Path
    }
    Assert-Throws {
      Publish-FanHaoDebugArtifact -SourceApkPath $source -UpdateDir $debug -VersionCode 26081191 -VersionName "0.1.26081191-debug" -ApkInspector $stageFailInspector
    } "simulated staged apksigner failure" "staged tool failure"
    Assert-Equal (Get-FileFingerprint $oldApk) $oldApkHash "failed publish must retain old APK"
    Assert-Equal (Get-FileFingerprint $latest) $oldManifestHash "failed publish must retain old manifest"
    Assert-True (-not (Test-Path -LiteralPath (Join-Path $debug "fanhao-debug-26081191.apk"))) "failed publish must not expose new APK"
    Assert-Equal @(Get-ChildItem -LiteralPath $debug -File -Filter ".*.tmp").Count 0 "failed publish must clean temporary files"
  }

  Invoke-PolicyTest "commit-stage failures roll back manifest and new APK" {
    foreach ($stage in @("BeforeManifestCommit", "AfterManifestCommit")) {
      $case = New-CaseDirectory "commit-failure-$stage"
      $debug = Join-Path $case "publish\debug"
      $oldApk = New-FakeApk -Path (Join-Path $debug "fanhao-debug-26081190.apk") -VersionCode 26081190
      $latest = Join-Path $debug "latest.json"
      Write-ValidManifest -Path $latest -Channel "debug" -ApkPath $oldApk -VersionCode 26081190
      $source = New-FakeApk -Path (Join-Path $case "app-debug.apk") -VersionCode 26081191
      $oldApkHash = Get-FileFingerprint $oldApk
      $oldManifestHash = Get-FileFingerprint $latest
      $failureHook = {
        param($CurrentStage, $TargetApk, $LatestPath)
        if ($CurrentStage -eq $stage) { throw "simulated $stage failure" }
      }
      Assert-Throws {
        Publish-FanHaoDebugArtifact -SourceApkPath $source -UpdateDir $debug -VersionCode 26081191 -VersionName "0.1.26081191-debug" -ApkInspector $FakeInspector -CommitHook $failureHook
      } "simulated $stage failure" "$stage rollback"
      Assert-Equal (Get-FileFingerprint $oldApk) $oldApkHash "$stage must retain the old APK"
      Assert-Equal (Get-FileFingerprint $latest) $oldManifestHash "$stage must restore the old manifest"
      Assert-True (-not (Test-Path -LiteralPath (Join-Path $debug "fanhao-debug-26081191.apk"))) "$stage must remove the new APK"
    }

    $case = New-CaseDirectory "first-publish-post-commit-failure"
    $debug = Join-Path $case "publish\debug"
    $source = New-FakeApk -Path (Join-Path $case "app-debug.apk") -VersionCode 26081191
    $failureHook = { param($CurrentStage) if ($CurrentStage -eq "AfterManifestCommit") { throw "simulated first publish failure" } }
    Assert-Throws {
      Publish-FanHaoDebugArtifact -SourceApkPath $source -UpdateDir $debug -VersionCode 26081191 -VersionName "0.1.26081191-debug" -ApkInspector $FakeInspector -CommitHook $failureHook
    } "simulated first publish failure" "first publish rollback"
    Assert-True (-not (Test-Path -LiteralPath (Join-Path $debug "latest.json"))) "failed first publish must remove its manifest"
    Assert-True (-not (Test-Path -LiteralPath (Join-Path $debug "fanhao-debug-26081191.apk"))) "failed first publish must remove its APK"
  }

  Invoke-PolicyTest "rollback failure preserves an explicit recovery manifest" {
    $case = New-CaseDirectory "rollback-recovery"
    $debug = Join-Path $case "publish\debug"
    $oldApk = New-FakeApk -Path (Join-Path $debug "fanhao-debug-26081190.apk") -VersionCode 26081190
    $latest = Join-Path $debug "latest.json"
    Write-ValidManifest -Path $latest -Channel "debug" -ApkPath $oldApk -VersionCode 26081190
    $source = New-FakeApk -Path (Join-Path $case "app-debug.apk") -VersionCode 26081191
    $script:lockedLatest = $null
    $lockLatestHook = {
      param($CurrentStage, $TargetApk, $LatestPath)
      if ($CurrentStage -eq "AfterManifestCommit") {
        $script:lockedLatest = [IO.File]::Open($LatestPath, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::None)
        throw "simulated post-commit failure with locked latest"
      }
    }
    try {
      Assert-Throws {
        Publish-FanHaoDebugArtifact -SourceApkPath $source -UpdateDir $debug -VersionCode 26081191 -VersionName "0.1.26081191-debug" -ApkInspector $FakeInspector -CommitHook $lockLatestHook
      } "automatic manifest rollback also failed.*Recovery manifest backup preserved" "rollback failure recovery state"
    } finally {
      if ($null -ne $script:lockedLatest) { $script:lockedLatest.Dispose() }
    }
    $backups = @(Get-ChildItem -LiteralPath $debug -File -Filter ".latest.*.bak")
    Assert-Equal $backups.Count 1 "rollback failure must preserve exactly one recovery manifest"
    Assert-True (Test-Path -LiteralPath (Join-Path $debug "fanhao-debug-26081191.apk")) "rollback failure must retain the committed APK while latest points to it"

    $failedManifest = Join-Path $debug ".failed-manifest.tmp"
    [IO.File]::Replace($backups[0].FullName, $latest, $failedManifest, $true)
    if (Test-Path -LiteralPath $failedManifest) { Remove-Item -LiteralPath $failedManifest -Force }
    Remove-Item -LiteralPath (Join-Path $debug "fanhao-debug-26081191.apk") -Force
    $recovered = [IO.File]::ReadAllText($latest) | ConvertFrom-Json
    Assert-Equal $recovered.versionCode 26081190 "preserved backup must restore the previous manifest"
  }

  Invoke-PolicyTest "successful publish tolerates a locked cleanup backup" {
    $case = New-CaseDirectory "successful-backup-cleanup"
    $debug = Join-Path $case "publish\debug"
    $oldApk = New-FakeApk -Path (Join-Path $debug "fanhao-debug-26081190.apk") -VersionCode 26081190
    $latest = Join-Path $debug "latest.json"
    Write-ValidManifest -Path $latest -Channel "debug" -ApkPath $oldApk -VersionCode 26081190
    $source = New-FakeApk -Path (Join-Path $case "app-debug.apk") -VersionCode 26081191
    $script:lockedBackup = $null
    $lockBackupHook = {
      param($CurrentStage, $TargetApk, $LatestPath)
      if ($CurrentStage -eq "AfterManifestCommit") {
        $backup = Get-ChildItem -LiteralPath (Split-Path -Parent $LatestPath) -File -Filter ".latest.*.bak" | Select-Object -First 1
        $script:lockedBackup = [IO.File]::Open($backup.FullName, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::None)
      }
    }
    try {
      $published = Publish-FanHaoDebugArtifact -SourceApkPath $source -UpdateDir $debug -VersionCode 26081191 -VersionName "0.1.26081191-debug" -ApkInspector $FakeInspector -CommitHook $lockBackupHook
    } finally {
      if ($null -ne $script:lockedBackup) { $script:lockedBackup.Dispose() }
    }
    Assert-Equal $published.VersionCode 26081191L "locked backup cleanup must not turn a committed publish into failure"
    Assert-True (Test-Path -LiteralPath $published.ApkPath) "committed APK must remain available"
    $committed = [IO.File]::ReadAllText($latest) | ConvertFrom-Json
    Assert-Equal $committed.versionCode 26081191 "committed manifest must remain current"
    $backups = @(Get-ChildItem -LiteralPath $debug -File -Filter ".latest.*.bak")
    Assert-Equal $backups.Count 1 "locked cleanup backup must be left for later housekeeping"
    Remove-Item -LiteralPath $backups[0].FullName -Force
  }

  Invoke-PolicyTest "failed first-publish move never deletes a foreign manifest" {
    $case = New-CaseDirectory "foreign-manifest-race"
    $debug = Join-Path $case "publish\debug"
    $source = New-FakeApk -Path (Join-Path $case "app-debug.apk") -VersionCode 26081191
    $foreignManifest = [ordered]@{
      channel = "debug"
      owner = "foreign-writer"
      apkFile = "foreign.apk"
    }
    $foreignHook = {
      param($CurrentStage, $TargetApk, $LatestPath)
      if ($CurrentStage -eq "BeforeManifestCommit") {
        Write-Utf8Json -Path $LatestPath -Value $foreignManifest
      }
    }
    Assert-Fails {
      Publish-FanHaoDebugArtifact -SourceApkPath $source -UpdateDir $debug -VersionCode 26081191 -VersionName "0.1.26081191-debug" -ApkInspector $FakeInspector -CommitHook $foreignHook
    } "foreign first-publish race"
    $latest = Join-Path $debug "latest.json"
    Assert-True (Test-Path -LiteralPath $latest) "foreign latest.json must survive a failed first-publish move"
    $survivor = [IO.File]::ReadAllText($latest) | ConvertFrom-Json
    Assert-Equal $survivor.owner "foreign-writer" "publish rollback must not claim foreign manifest ownership"
    Assert-True (-not (Test-Path -LiteralPath (Join-Path $debug "fanhao-debug-26081191.apk"))) "failed first-publish race must remove only its own APK"
  }

  Invoke-PolicyTest "changed existing manifest is never overwritten or rolled back" {
    $case = New-CaseDirectory "changed-existing-manifest"
    $debug = Join-Path $case "publish\debug"
    $oldApk = New-FakeApk -Path (Join-Path $debug "fanhao-debug-26081190.apk") -VersionCode 26081190
    $latest = Join-Path $debug "latest.json"
    Write-ValidManifest -Path $latest -Channel "debug" -ApkPath $oldApk -VersionCode 26081190
    $source = New-FakeApk -Path (Join-Path $case "app-debug.apk") -VersionCode 26081191
    $foreignManifest = [ordered]@{ channel = "debug"; owner = "foreign-existing-writer"; apkFile = "foreign.apk" }
    $foreignHook = {
      param($CurrentStage, $TargetApk, $LatestPath)
      if ($CurrentStage -eq "BeforeManifestCommit") { Write-Utf8Json -Path $LatestPath -Value $foreignManifest }
    }
    Assert-Throws {
      Publish-FanHaoDebugArtifact -SourceApkPath $source -UpdateDir $debug -VersionCode 26081191 -VersionName "0.1.26081191-debug" -ApkInspector $FakeInspector -CommitHook $foreignHook
    } "changed during publish" "existing manifest ownership race"
    $survivor = [IO.File]::ReadAllText($latest) | ConvertFrom-Json
    Assert-Equal $survivor.owner "foreign-existing-writer" "changed manifest must survive without rollback"
    Assert-True (-not (Test-Path -LiteralPath (Join-Path $debug "fanhao-debug-26081191.apk"))) "ownership race must remove only its own APK"
  }

  Write-Host "debug-publish-policy: $script:Passed behavior groups passed"
} finally {
  $resolvedTempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\') + '\'
  $resolvedTarget = [IO.Path]::GetFullPath($TestRoot)
  $leaf = Split-Path -Leaf $resolvedTarget
  if (
    -not $resolvedTarget.StartsWith($resolvedTempRoot, [StringComparison]::OrdinalIgnoreCase) -or
    -not $leaf.StartsWith("fanhao-android-publish-", [StringComparison]::Ordinal)
  ) {
    throw "Refusing to remove an unverified test directory: $resolvedTarget"
  }
  if (Test-Path -LiteralPath $resolvedTarget) {
    Remove-Item -LiteralPath $resolvedTarget -Recurse -Force
  }
}
