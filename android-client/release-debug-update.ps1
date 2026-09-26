param(
  $VersionCode = $null,
  [AllowNull()][AllowEmptyString()][string]$VersionName = $null,
  [string]$Notes = "Debug update",
  [string]$LocalBaseUrl = "http://127.0.0.1:29998",
  [string]$PublicBaseUrl = "http://xc213618.ddns.me:29998",
  [switch]$PlanOnly,
  [switch]$VerifyOnly
)

$ErrorActionPreference = "Stop"

$ProjectDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoDir = Split-Path -Parent $ProjectDir
$PublishScript = Join-Path $ProjectDir "publish-debug-update.ps1"
$PublishModule = Join-Path $ProjectDir "scripts\FanHaoAndroidPublish.psm1"
$PublishRoot = Join-Path $RepoDir "data\android-update"
$ManifestPath = Join-Path $PublishRoot "debug\latest.json"
$VersionCodeWasSpecified = $PSBoundParameters.ContainsKey("VersionCode")
$VersionNameWasSpecified = $PSBoundParameters.ContainsKey("VersionName")

if ($PlanOnly -and $VerifyOnly) {
  throw "-PlanOnly and -VerifyOnly cannot be used together."
}
if ($VerifyOnly -and ($VersionCodeWasSpecified -or $VersionNameWasSpecified)) {
  throw "-VerifyOnly validates the published manifest and cannot select a new identity."
}

function Get-NormalizedBaseUrl {
  param(
    [Parameter(Mandatory = $true)][string]$Value,
    [Parameter(Mandatory = $true)][string]$Label
  )

  try { $uri = [Uri]$Value } catch { throw "$Label is not a valid absolute URL: $Value" }
  if (
    -not $uri.IsAbsoluteUri -or
    $uri.Scheme -notin @("http", "https") -or
    -not [string]::IsNullOrEmpty($uri.UserInfo) -or
    ($uri.AbsolutePath -ne "/" -and -not [string]::IsNullOrEmpty($uri.AbsolutePath)) -or
    -not [string]::IsNullOrEmpty($uri.Query) -or
    -not [string]::IsNullOrEmpty($uri.Fragment)
  ) {
    throw "$Label must be an HTTP(S) origin without credentials, path, query, or fragment: $Value"
  }
  return $uri.GetLeftPart([UriPartial]::Authority).TrimEnd("/")
}

function Invoke-CheckedNative {
  param(
    [Parameter(Mandatory = $true)][string]$Command,
    [Parameter(Mandatory = $true)][string[]]$Arguments,
    [Parameter(Mandatory = $true)][string]$FailureMessage
  )

  & $Command @Arguments
  if ($LASTEXITCODE -ne 0) {
    throw "$FailureMessage (exit $LASTEXITCODE)"
  }
}

function Get-UpdatePayload {
  param(
    [Parameter(Mandatory = $true)][string]$BaseUrl,
    [Parameter(Mandatory = $true)][long]$CurrentVersionCode
  )

  $requestUrl = "$BaseUrl/api/android/update?channel=debug&currentVersionCode=$CurrentVersionCode"
  return Invoke-RestMethod -Uri $requestUrl -TimeoutSec 30
}

function Assert-DownloadUrl {
  param(
    [Parameter(Mandatory = $true)]$Payload,
    [Parameter(Mandatory = $true)][string]$BaseUrl,
    [Parameter(Mandatory = $true)][string]$ApkFile,
    [Parameter(Mandatory = $true)][string]$Label
  )

  try { $downloadUri = [Uri][string]$Payload.downloadUrl } catch { throw "$Label returned an invalid download URL." }
  $baseUri = [Uri]$BaseUrl
  $expectedPath = "/api/android/update/apk/debug/$([Uri]::EscapeDataString($ApkFile))"
  if (
    $downloadUri.GetLeftPart([UriPartial]::Authority) -cne $baseUri.GetLeftPart([UriPartial]::Authority) -or
    $downloadUri.AbsolutePath -cne $expectedPath -or
    -not [string]::IsNullOrEmpty($downloadUri.Query) -or
    -not [string]::IsNullOrEmpty($downloadUri.Fragment) -or
    -not [string]::IsNullOrEmpty($downloadUri.UserInfo)
  ) {
    throw "$Label download URL is outside the verified update origin or manifest path: $downloadUri"
  }
  return $downloadUri.AbsoluteUri
}

function Assert-UpdatePayload {
  param(
    [Parameter(Mandatory = $true)]$Payload,
    [Parameter(Mandatory = $true)]$ManifestIdentity,
    [Parameter(Mandatory = $true)][string]$BaseUrl,
    [Parameter(Mandatory = $true)][long]$CurrentVersionCode,
    [Parameter(Mandatory = $true)][bool]$ExpectedAvailable,
    [Parameter(Mandatory = $true)][string]$Label
  )

  if (
    $Payload.ok -ne $true -or
    [string]$Payload.channel -cne "debug" -or
    [bool]$Payload.available -ne $ExpectedAvailable -or
    [long]$Payload.currentVersionCode -ne $CurrentVersionCode -or
    [long]$Payload.versionCode -ne $ManifestIdentity.VersionCode -or
    [string]$Payload.versionName -cne $ManifestIdentity.VersionName -or
    [long]$Payload.size -ne $ManifestIdentity.Size -or
    [string]$Payload.sha256 -cne $ManifestIdentity.Sha256 -or
    [string]$Payload.fileName -cne $ManifestIdentity.ApkFile
  ) {
    throw "$Label update payload does not match the published debug manifest."
  }
  return Assert-DownloadUrl -Payload $Payload -BaseUrl $BaseUrl -ApkFile $ManifestIdentity.ApkFile -Label $Label
}

function Assert-HeadDownload {
  param(
    [Parameter(Mandatory = $true)][string]$DownloadUrl,
    [Parameter(Mandatory = $true)][long]$ExpectedSize,
    [Parameter(Mandatory = $true)][string]$Label
  )

  $response = Invoke-WebRequest -Uri $DownloadUrl -Method Head -TimeoutSec 30
  $contentLength = [long]($response.Headers["Content-Length"] | Select-Object -First 1)
  if ([int]$response.StatusCode -ne 200 -or $contentLength -ne $ExpectedSize) {
    throw "$Label APK HEAD verification failed: status=$([int]$response.StatusCode), bytes=$contentLength"
  }
}

function Invoke-ReleaseStage {
  param(
    [Parameter(Mandatory = $true)][ValidateSet("LocalArtifact", "LocalEndpoint", "PublicEndpoint")][string]$Stage,
    [Parameter(Mandatory = $true)][scriptblock]$Action
  )

  try {
    return & $Action
  } catch {
    $detail = $_.Exception.Message
    switch ($Stage) {
      "LocalArtifact" {
        throw "LOCAL_ARTIFACT_VERIFICATION_FAILED: the local manifest or APK could not be verified; no publication state is being claimed. $detail"
      }
      "LocalEndpoint" {
        throw "LOCAL_ENDPOINT_VERIFICATION_FAILED: the local update endpoint did not serve the verified artifact; public verification was not attempted. $detail"
      }
      "PublicEndpoint" {
        throw "PUBLIC_VERIFICATION_PENDING: the local artifact and local endpoint were verified, but public verification did not complete. Keep this version and retry with -VerifyOnly; do not publish a replacement version. $detail"
      }
    }
  }
}

function Invoke-ReleaseVerification {
  param([Parameter(Mandatory = $true)][long]$PreviousVersionCode)

  try {
    Import-Module -Name $PublishModule -Force
  } catch {
    throw "LOCAL_ARTIFACT_VERIFICATION_FAILED: the Android publish policy module could not be loaded; no publication state is being claimed. $($_.Exception.Message)"
  }

  $artifact = Invoke-ReleaseStage -Stage LocalArtifact -Action {
    $manifest = Read-FanHaoUpdateManifest -Path $ManifestPath
    $apkPath = Join-Path (Split-Path -Parent $ManifestPath) ([string]$manifest.apkFile)
    $apkInspector = { param($Path) Get-FanHaoApkIdentity -Path $Path }
    $identity = Assert-FanHaoUpdateManifest `
      -Manifest $manifest `
      -Channel debug `
      -ApkPath $apkPath `
      -ExpectedApkFileName ([string]$manifest.apkFile) `
      -ApkInspector $apkInspector `
      -SourcePath $ManifestPath
    [pscustomobject]@{ Manifest = $manifest; ApkPath = $apkPath; ApkInspector = $apkInspector; Identity = $identity }
  }
  $manifest = $artifact.Manifest
  $apkPath = $artifact.ApkPath
  $apkInspector = $artifact.ApkInspector
  $identity = $artifact.Identity

  if ($PreviousVersionCode -ge $identity.VersionCode) {
    $PreviousVersionCode = [Math]::Max(0, $identity.VersionCode - 1)
  }

  Invoke-ReleaseStage -Stage LocalEndpoint -Action {
    $localOld = Get-UpdatePayload -BaseUrl $LocalBaseUrl -CurrentVersionCode $PreviousVersionCode
    $localCurrent = Get-UpdatePayload -BaseUrl $LocalBaseUrl -CurrentVersionCode $identity.VersionCode
    $localDownload = Assert-UpdatePayload -Payload $localOld -ManifestIdentity $identity -BaseUrl $LocalBaseUrl -CurrentVersionCode $PreviousVersionCode -ExpectedAvailable $true -Label "Local old-version"
    $null = Assert-UpdatePayload -Payload $localCurrent -ManifestIdentity $identity -BaseUrl $LocalBaseUrl -CurrentVersionCode $identity.VersionCode -ExpectedAvailable $false -Label "Local current-version"
    Assert-HeadDownload -DownloadUrl $localDownload -ExpectedSize $identity.Size -Label "Local"
  }

  Write-Host "LOCAL_PUBLISH_VERIFIED versionCode=$($identity.VersionCode)"

  Invoke-ReleaseStage -Stage PublicEndpoint -Action {
    $publicOld = Get-UpdatePayload -BaseUrl $PublicBaseUrl -CurrentVersionCode $PreviousVersionCode
    $publicCurrent = Get-UpdatePayload -BaseUrl $PublicBaseUrl -CurrentVersionCode $identity.VersionCode
    $publicDownload = Assert-UpdatePayload -Payload $publicOld -ManifestIdentity $identity -BaseUrl $PublicBaseUrl -CurrentVersionCode $PreviousVersionCode -ExpectedAvailable $true -Label "Public old-version"
    $null = Assert-UpdatePayload -Payload $publicCurrent -ManifestIdentity $identity -BaseUrl $PublicBaseUrl -CurrentVersionCode $identity.VersionCode -ExpectedAvailable $false -Label "Public current-version"
    Assert-HeadDownload -DownloadUrl $publicDownload -ExpectedSize $identity.Size -Label "Public"

    $tempApk = Join-Path ([IO.Path]::GetTempPath()) "fanhao-debug-release-verify-$([Guid]::NewGuid().ToString('N')).apk"
    try {
      $curl = (Get-Command curl.exe -ErrorAction Stop).Source
      Invoke-CheckedNative -Command $curl -Arguments @(
        "--fail", "--location", "--silent", "--show-error",
        "--connect-timeout", "15", "--max-time", "300",
        "--retry", "5", "--retry-delay", "1", "--retry-all-errors",
        "--continue-at", "-", "--output", $tempApk, $publicDownload
      ) -FailureMessage "Public APK download verification failed"
      $downloadedIdentity = Assert-FanHaoUpdateManifest `
        -Manifest $manifest `
        -Channel debug `
        -ApkPath $tempApk `
        -ExpectedApkFileName ([string]$manifest.apkFile) `
        -ApkInspector $apkInspector `
        -SourcePath "public download"
      if ($downloadedIdentity.SignerSha256 -cne $identity.SignerSha256) {
        throw "Public APK signer does not match the published APK signer."
      }
    } finally {
      if (Test-Path -LiteralPath $tempApk) { [IO.File]::Delete([IO.Path]::GetFullPath($tempApk)) }
    }
  }

  Write-Host "Android debug release verified:"
  Write-Host "  Version: $($identity.VersionCode) / $($identity.VersionName)"
  Write-Host "  APK: $apkPath"
  Write-Host "  Bytes: $($identity.Size)"
  Write-Host "  SHA-256: $($identity.Sha256)"
  Write-Host "  Public update: $PublicBaseUrl/android-update"
  Write-Host "  Install: not performed"
  Write-Host "PUBLIC_VERIFICATION_SUCCEEDED versionCode=$($identity.VersionCode)"
}

$LocalBaseUrl = Get-NormalizedBaseUrl -Value $LocalBaseUrl -Label "Local base URL"
$PublicBaseUrl = Get-NormalizedBaseUrl -Value $PublicBaseUrl -Label "Public base URL"

$publishArguments = @{}
if ($VersionCodeWasSpecified) { $publishArguments.VersionCode = $VersionCode }
if ($VersionNameWasSpecified) { $publishArguments.VersionName = $VersionName }
if ($Notes) { $publishArguments.Notes = $Notes }

if ($PlanOnly) {
  $publishArguments.PlanOnly = $true
  & $PublishScript @publishArguments
  return
}

if ($VerifyOnly) {
  Invoke-ReleaseVerification -PreviousVersionCode 0
  return
}

$previousVersionCode = 0
if (Test-Path -LiteralPath $ManifestPath) {
  try { $previousVersionCode = [long](Read-FanHaoUpdateManifest -Path $ManifestPath).versionCode } catch { $previousVersionCode = 0 }
}

Push-Location $RepoDir
try {
  $npm = (Get-Command npm.cmd -ErrorAction Stop).Source
  Invoke-CheckedNative -Command $npm -Arguments @("run", "verify:android-release") -FailureMessage "Android release verification lane failed"
  & $PublishScript @publishArguments
  Write-Host "LOCAL_PUBLISH_SUCCEEDED: the manifest and APK were committed locally."
} finally {
  Pop-Location
}

Invoke-ReleaseVerification -PreviousVersionCode $previousVersionCode
