import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const clientDir = path.resolve(scriptDir, "..");
const repoDir = path.resolve(clientDir, "..");
const androidPrefix = "android-client/android/";

function isTrackedAndroidGradleConfig(filePath) {
  if (!filePath.startsWith(androidPrefix)) return false;
  const fileName = path.posix.basename(filePath);
  return fileName.endsWith(".gradle") || fileName.endsWith(".gradle.kts") || fileName.endsWith(".properties");
}

function proxyViolations(text) {
  const violations = [];
  const propertySeparator = String.raw`(?:[ \t\f]*[=:][ \t\f]*|[ \t\f]+)`;
  const proxyProperty = new RegExp(String.raw`(?:^|[\r\n])[ \t\f]*(?:systemProp\.)?(?:http|https|ftp|socks)\.proxy(?:host|port|user|password|nonproxyhosts)?${propertySeparator}`, "i");
  const namedProxySetting = new RegExp(String.raw`(?:^|[\r\n])[ \t\f]*[A-Za-z][\w.-]*proxy(?:url|host|port|user|password)?${propertySeparator}`, "i");
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
  return proxyViolations(fs.readFileSync(absolutePath, "utf8")).map((reason) => `${filePath}: ${reason}`);
});
assert.deepEqual(failures, [], `tracked Android Gradle configuration must be machine-neutral:\n${failures.join("\n")}`);

console.log(`Android Gradle proxy hygiene passed (${files.length} tracked configuration files checked).`);
