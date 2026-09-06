import assert from "node:assert/strict";
import fs from "node:fs";

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
  "verify:android-client",
  "verify:modules",
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
