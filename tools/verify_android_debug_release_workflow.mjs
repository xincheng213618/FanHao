import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const workflow = fs.readFileSync(new URL("../android-client/release-debug-update.ps1", import.meta.url), "utf8");
const publishedInstaller = fs.readFileSync(new URL("../android-client/install-published-debug.ps1", import.meta.url), "utf8");
const packageJson = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const androidPackageJson = JSON.parse(fs.readFileSync(new URL("../android-client/package.json", import.meta.url), "utf8"));
const guide = fs.readFileSync(new URL("../docs/android-client.md", import.meta.url), "utf8");
const readme = fs.readFileSync(new URL("../android-client/README.md", import.meta.url), "utf8");

assert.match(packageJson.scripts["release:android-debug"] || "", /release-debug-update\.ps1/,
  "the root package must expose the one-command Android debug release");
assert.match(packageJson.scripts["install:android-published"] || "", /install-published-debug\.ps1/,
  "the root package must expose verified installation of the published debug APK");
assert.match(androidPackageJson.scripts["install:published"] || "", /install-published-debug\.ps1/,
  "the Android package must expose verified installation of the published debug APK");

const releaseLane = packageJson.scripts["verify:android-release"] || "";
for (const gate of [
  "verify:android-release-workflow",
  "verify:auth",
  "verify:mutation-auth",
  "verify:android-security",
  "verify:android-gradle-config",
  "verify:imports"
]) {
  assert(releaseLane.includes(`npm run ${gate}`), `Android release lane must run ${gate}`);
}

for (const required of [
  "publish-debug-update.ps1",
  "verify:android-release",
  "-VerifyOnly",
  "-PlanOnly",
  "Assert-FanHaoUpdateManifest",
  "currentVersionCode",
  "ExpectedAvailable $true",
  "ExpectedAvailable $false",
  "Invoke-WebRequest -Uri $DownloadUrl -Method Head",
  "--retry-all-errors",
  "GetLeftPart([UriPartial]::Authority)",
  "Install: not performed"
]) {
  assert(workflow.includes(required), `release workflow is missing: ${required}`);
}
assert(workflow.includes("LOCAL_PUBLISH_SUCCEEDED"), "release workflow must report that the durable local publish committed before remote checks");
assert(workflow.includes("PUBLIC_VERIFICATION_PENDING"), "release workflow must preserve a retryable public-verification failure state");
assert(workflow.includes("PUBLIC_VERIFICATION_SUCCEEDED"), "release workflow must report public verification only after it succeeds");

const releasePath = fileURLToPath(new URL("../android-client/release-debug-update.ps1", import.meta.url));
const psLiteral = (value) => `'${String(value).replaceAll("'", "''")}'`;
const stageFixture = String.raw`
$ErrorActionPreference = "Stop"
$tokens = $null
$errors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile(${psLiteral(releasePath)}, [ref]$tokens, [ref]$errors)
if ($errors.Count -gt 0) { throw "release wrapper parse failed" }
foreach ($functionName in @("Invoke-ReleaseStage", "Invoke-ReleaseVerification")) {
  $functionAst = $ast.FindAll({ param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $functionName }, $true) | Select-Object -First 1
  if ($null -eq $functionAst) { throw "$functionName was not found" }
  Invoke-Expression $functionAst.Extent.Text
}

$fixtureRoot = Join-Path ([IO.Path]::GetTempPath()) "fanhao-release-stage-$([Guid]::NewGuid().ToString('N'))"
$null = New-Item -ItemType Directory -Path $fixtureRoot
try {
  $PublishModule = Join-Path $fixtureRoot "MockPublish.psm1"
  @'
function Read-FanHaoUpdateManifest {
  param([string]$Path)
  if ($global:FixtureFailure -eq "artifact") { throw "missing manifest" }
  [pscustomobject]@{ apkFile = "fanhao-debug-42.apk" }
}
function Get-FanHaoApkIdentity { param([string]$Path) [pscustomobject]@{ Path = $Path } }
function Assert-FanHaoUpdateManifest {
  [pscustomobject]@{
    VersionCode = 42L; VersionName = "0.1.42-debug"; Size = 3L
    Sha256 = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    ApkFile = "fanhao-debug-42.apk"; SignerSha256 = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
  }
}
Export-ModuleMember -Function Read-FanHaoUpdateManifest, Get-FanHaoApkIdentity, Assert-FanHaoUpdateManifest
'@ | Set-Content -LiteralPath $PublishModule -Encoding UTF8
  $ManifestPath = Join-Path $fixtureRoot "latest.json"
  $LocalBaseUrl = "http://local.fixture"
  $PublicBaseUrl = "http://public.fixture"

  function Get-UpdatePayload {
    param([string]$BaseUrl, [long]$CurrentVersionCode)
    if ($global:FixtureFailure -eq "local" -and $BaseUrl -eq $LocalBaseUrl) { throw "local HTTP unavailable" }
    if ($global:FixtureFailure -eq "public" -and $BaseUrl -eq $PublicBaseUrl) { throw "public timeout" }
    if ($BaseUrl -eq $PublicBaseUrl) { $global:FixturePublicCalls += 1 }
    [pscustomobject]@{ BaseUrl = $BaseUrl; CurrentVersionCode = $CurrentVersionCode }
  }
  function Assert-UpdatePayload { param($Payload, $ManifestIdentity, [string]$BaseUrl) "$BaseUrl/download" }
  function Assert-HeadDownload { param([string]$DownloadUrl, [long]$ExpectedSize, [string]$Label) }
  function Get-Command { param([string]$Name) [pscustomobject]@{ Source = "mock-curl.exe" } }
  function Invoke-CheckedNative {
    param([string]$Command, [string[]]$Arguments, [string]$FailureMessage)
    $outputIndex = [Array]::IndexOf($Arguments, "--output")
    if ($outputIndex -lt 0) { throw "mock curl output missing" }
    [IO.File]::WriteAllText($Arguments[$outputIndex + 1], "apk")
    $global:FixtureNativeCalled = $true
  }

  $global:FixtureFailure = ""
  $global:FixturePublicCalls = 0
  $global:FixtureNativeCalled = $false
  Invoke-ReleaseVerification -PreviousVersionCode 41 6>$null
  if ($global:FixturePublicCalls -ne 2 -or -not $global:FixtureNativeCalled) { throw "success path did not complete public verification" }

  $cases = @(
    @{ Failure = "artifact"; Prefix = "LOCAL_ARTIFACT_VERIFICATION_FAILED:"; Forbidden = "PUBLIC_VERIFICATION_PENDING"; Detail = "missing manifest" },
    @{ Failure = "local"; Prefix = "LOCAL_ENDPOINT_VERIFICATION_FAILED:"; Forbidden = "PUBLIC_VERIFICATION_PENDING"; Detail = "local HTTP unavailable" },
    @{ Failure = "public"; Prefix = "PUBLIC_VERIFICATION_PENDING:"; Forbidden = "LOCAL_ENDPOINT_VERIFICATION_FAILED"; Detail = "public timeout" }
  )
  foreach ($case in $cases) {
    $global:FixtureFailure = $case.Failure
    try {
      Invoke-ReleaseVerification -PreviousVersionCode 41
      throw "fixture expected $($case.Failure) to fail"
    } catch {
      $message = $_.Exception.Message
      if (-not $message.StartsWith($case.Prefix, [StringComparison]::Ordinal)) { throw "wrong $($case.Failure) classification: $message" }
      if ($message.Contains($case.Forbidden, [StringComparison]::Ordinal)) { throw "misleading $($case.Failure) classification: $message" }
      if (-not $message.Contains($case.Detail, [StringComparison]::Ordinal)) { throw "missing $($case.Failure) detail: $message" }
    }
  }
  Write-Output "release-verification-fixture: ok"
} finally {
  Remove-Module MockPublish -Force -ErrorAction SilentlyContinue
  $resolvedFixtureRoot = [IO.Path]::GetFullPath($fixtureRoot)
  $resolvedTempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd([IO.Path]::DirectorySeparatorChar)
  if ([IO.Path]::GetDirectoryName($resolvedFixtureRoot).TrimEnd([IO.Path]::DirectorySeparatorChar) -cne $resolvedTempRoot -or [IO.Path]::GetFileName($resolvedFixtureRoot) -notmatch '^fanhao-release-stage-[0-9a-f]{32}$') {
    throw "refusing to clean an unexpected fixture path: $resolvedFixtureRoot"
  }
  if (Test-Path -LiteralPath $resolvedFixtureRoot) { Remove-Item -LiteralPath $resolvedFixtureRoot -Recurse -Force }
  Remove-Variable FixtureFailure -Scope Global -ErrorAction SilentlyContinue
  Remove-Variable FixturePublicCalls -Scope Global -ErrorAction SilentlyContinue
  Remove-Variable FixtureNativeCalled -Scope Global -ErrorAction SilentlyContinue
}
`;
const stageResult = spawnSync("pwsh.exe", ["-NoProfile", "-EncodedCommand", Buffer.from(stageFixture, "utf16le").toString("base64")], {
  encoding: "utf8"
});
assert.equal(stageResult.status, 0, `release stage fixture failed:\n${stageResult.stdout}\n${stageResult.stderr}`);
assert.match(stageResult.stdout, /release-verification-fixture: ok/, "release verification fixture did not complete");

for (const required of [
  "data\\android-update\\debug",
  "latest.json",
  "Read-FanHaoUpdateManifest",
  "Assert-FanHaoUpdateManifest",
  "Get-FanHaoApkIdentity",
  '"install", "-r", $apkPath',
  '"dumpsys", "package", $identity.PackageName',
  "Multiple authorized Android devices found",
  "Installed package identity does not match the published manifest"
]) {
  assert(publishedInstaller.includes(required), `published installer is missing: ${required}`);
}
assert(!publishedInstaller.includes('"install", "-r", "-d"'), "published installer must not permit version downgrade");
for (const forbidden of ["gradlew", "assembleDebug", "npm run sync", "build-debug.ps1"]) {
  assert(!publishedInstaller.includes(forbidden), `published installer must not build mutable source: ${forbidden}`);
}

assert(guide.includes("release-debug-update.ps1"), "the Android guide must document the verified release workflow");
assert(readme.includes("npm run release:android-debug"), "the Android README must show the one-command release entry");
assert(readme.includes("npm run install:android-published"), "the Android README must show verified published installation");

console.log("android-debug-release-workflow: ok (gates, atomic publish, local/public verification, explicit manifest-verified install)");
