import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const clientDir = path.resolve(scriptDir, "..");
const repoDir = path.resolve(clientDir, "..");
const androidPrefix = "android-client/android/";
const wrapperLauncherFiles = new Set([
  "android-client/android/gradlew",
  "android-client/android/gradlew.bat"
]);

function isTrackedAndroidGradleConfig(filePath) {
  if (!filePath.startsWith(androidPrefix)) return false;
  if (wrapperLauncherFiles.has(filePath)) return true;
  const fileName = path.posix.basename(filePath);
  return fileName.endsWith(".gradle") || fileName.endsWith(".gradle.kts") || fileName.endsWith(".properties");
}

function contentForScanning(filePath, text) {
  if (!filePath.endsWith(".properties")) return text;
  return text.replace(/\b(https?)\\:(?=\/\/)/gi, "$1:");
}

function proxyViolations(text) {
  const violations = [];
  const propertySeparator = String.raw`(?:[ \t\f]*[=:][ \t\f]*|[ \t\f]+)`;
  const proxyProperty = new RegExp(String.raw`(?:^|[\r\n])[ \t\f]*(?:systemProp\.)?(?:http|https|ftp|socks)\.proxy(?:host|port|user|password|nonproxyhosts)?${propertySeparator}`, "i");
  const namedProxySetting = new RegExp(String.raw`(?:^|[\r\n])[ \t\f]*(?:[A-Za-z][\w.-]*)?proxy(?:url|host|port|user|password)?${propertySeparator}`, "i");
  const proxyJvmArgument = /-D(?:http|https|ftp|socks)\.proxy(?:host|port|user|password|nonproxyhosts)?=/i;
  const localEndpoint = /(?:https?:\/\/)?(?:localhost|127\.0\.0\.1)(?::\d+)?/i;
  const credentialInUrl = /https?:\/\/[^\s/@]+@/i;

  if (proxyProperty.test(text) || namedProxySetting.test(text)) violations.push("proxy setting");
  if (proxyJvmArgument.test(text)) violations.push("proxy JVM argument");
  if (localEndpoint.test(text)) violations.push("localhost or loopback endpoint");
  if (credentialInUrl.test(text)) violations.push("credential-bearing URL");
  return violations;
}

function assertFixtures() {
  assert.deepEqual(proxyViolations("org.gradle.jvmargs=-Xmx1536m\nandroid.useAndroidX=true\n"), []);
  assert(proxyViolations("systemProp.http.proxyHost=127.0.0.1").includes("proxy setting"));
  assert(proxyViolations("buildProxyUrl=https://proxy.example.test/repository").includes("proxy setting"));
  assert(proxyViolations("systemProp.https.proxyHost:proxy.example.test").includes("proxy setting"));
  assert(proxyViolations("systemProp.https.proxyPassword local-only-secret").includes("proxy setting"));
  assert(proxyViolations("org.gradle.jvmargs=-Dhttps.proxyPassword=not-a-secret").includes("proxy JVM argument"));
  assert(proxyViolations("repositories { maven { url 'http://localhost:8080/repository' } }").includes("localhost or loopback endpoint"));
  assert(proxyViolations("mavenUrl=https://user:token@proxy.example.test/repository").includes("credential-bearing URL"));
  assert(proxyViolations("mavenUrl=https://token@proxy.example.test/repository").includes("credential-bearing URL"));
  assert(proxyViolations("serviceProxyUser:fixture-user").includes("proxy setting"));
  assert(proxyViolations("customProxyPort 8080").includes("proxy setting"));
  assert.deepEqual(proxyViolations("ordinary proxy password text\n# proxyPassword=comment only\nnotProxyHelper=enabled\n"), []);
  assertTrackedFixture("android-client/android/gradlew", 'DEFAULT_JVM_OPTS="-Dhttp.proxyHost=proxy.example.test"', "proxy JVM argument");
  assertTrackedFixture("android-client/android/gradlew.bat", 'set DEFAULT_JVM_OPTS="-Dhttps.proxyPassword=local-only-secret"', "proxy JVM argument");
  assertTrackedFixture("android-client/android/gradle/wrapper/gradle-wrapper.properties", String.raw`distributionUrl=https\://token@proxy.example.test/gradle.zip`, "credential-bearing URL");
  assertTrackedFixture("android-client/android/gradle/wrapper/gradle-wrapper.properties", String.raw`distributionUrl=https\://user:token@proxy.example.test/gradle.zip`, "credential-bearing URL");
  assertTrackedFixture("android-client/android/gradle.properties", "proxyPassword=fixture-secret", "proxy setting");
  assertTrackedFixture("android-client/android/gradle.properties", "PROXYHOST:proxy.example.test", "proxy setting");
  assertTrackedFixture("android-client/android/gradle.properties", "proxyUrl https://proxy.example.test/repository", "proxy setting");
}

function assertTrackedFixture(filePath, text, expectedViolation) {
  assert.equal(legacyWouldExitZeroForFixture(filePath, text), true, `legacy scanner should have passed this fixture: ${filePath}`);
  assert.equal(isTrackedAndroidGradleConfig(filePath), true, `fixture path must be scanned: ${filePath}`);
  assert(proxyViolations(contentForScanning(filePath, text)).includes(expectedViolation), `fixture must reject ${expectedViolation}: ${filePath}`);
}

function legacyWouldExitZeroForFixture(filePath, text) {
  const fileName = path.posix.basename(filePath);
  const legacySelected = filePath.startsWith(androidPrefix) && (fileName === "gradle.properties" || fileName.endsWith(".gradle") || fileName.endsWith(".gradle.kts"));
  if (!legacySelected) return true;
  const legacyProxyJvmArgument = /-D(?:http|https|ftp|socks)\.proxy(?:host|port|user|password|nonproxyhosts)?=/i;
  const legacyCredentialInUrl = /https?:\/\/[^\s/@:]+:[^\s/@]*@/i;
  return !(legacyProxyJvmArgument.test(text) || legacyCredentialInUrl.test(text));
}

function trackedAndroidGradleConfigs() {
  const output = execFileSync("git", ["-C", repoDir, "ls-files", "--", "android-client/android"], { encoding: "utf8" });
  return output.split(/\r?\n/).filter(isTrackedAndroidGradleConfig);
}

assertFixtures();
const files = trackedAndroidGradleConfigs();
assert(files.includes("android-client/android/gradle.properties"), "tracked Android gradle.properties is required");
assert(files.includes("android-client/android/gradle/wrapper/gradle-wrapper.properties"), "tracked Gradle wrapper properties are required");

const failures = files.flatMap((filePath) => {
  const absolutePath = path.join(repoDir, ...filePath.split("/"));
  const text = fs.readFileSync(absolutePath, "utf8");
  return proxyViolations(contentForScanning(filePath, text)).map((reason) => `${filePath}: ${reason}`);
});
assert.deepEqual(failures, [], `tracked Android Gradle configuration must be machine-neutral:\n${failures.join("\n")}`);

console.log(`Android Gradle proxy hygiene passed (${files.length} tracked configuration files checked).`);
