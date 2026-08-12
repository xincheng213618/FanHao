import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "fanhao-native-actions-"));
const bundledJavaHome = "C:\\Program Files\\Android\\openjdk\\jdk-21.0.8";
const javaHome = String(process.env.JAVA_HOME || "").trim() || bundledJavaHome;
const javac = path.join(javaHome, "bin", "javac.exe");
const java = path.join(javaHome, "bin", "java.exe");

function findAndroidJar() {
  const sdkRoots = [
    process.env.ANDROID_HOME,
    process.env.ANDROID_SDK_ROOT,
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, "Android", "Sdk") : "",
    "C:\\Program Files (x86)\\Android\\android-sdk"
  ].filter(Boolean);
  for (const sdkRoot of sdkRoots) {
    const platforms = path.join(sdkRoot, "platforms");
    if (!fs.existsSync(platforms)) continue;
    const candidates = fs.readdirSync(platforms, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(platforms, entry.name, "android.jar"))
      .filter((candidate) => fs.existsSync(candidate))
      .sort((left, right) => right.localeCompare(left, undefined, { numeric: true }));
    if (candidates.length > 0) return candidates[0];
  }
  return "";
}

function findOrgJsonJar() {
  const gradleHome = String(process.env.GRADLE_USER_HOME || "").trim()
    || path.join(os.homedir(), ".gradle");
  const moduleRoot = path.join(gradleHome, "caches", "modules-2", "files-2.1", "org.json", "json");
  if (!fs.existsSync(moduleRoot)) return "";
  const versions = fs.readdirSync(moduleRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort((left, right) => right.localeCompare(left, undefined, { numeric: true }));
  for (const version of versions) {
    const versionRoot = path.join(moduleRoot, version);
    for (const hash of fs.readdirSync(versionRoot, { withFileTypes: true })) {
      if (!hash.isDirectory()) continue;
      const jar = fs.readdirSync(path.join(versionRoot, hash.name))
        .find((name) => /^json-.+\.jar$/u.test(name));
      if (jar) return path.join(versionRoot, hash.name, jar);
    }
  }
  return "";
}

try {
  const source = path.join(root, "android-client", "android", "app", "src", "main", "java", "local", "fanhao", "library", "NativeShortVideoActionState.java");
  const snapshots = path.join(root, "android-client", "android", "app", "src", "main", "java", "local", "fanhao", "library", "NativeShortVideoActionSnapshots.java");
  const activityResult = path.join(root, "android-client", "android", "app", "src", "main", "java", "local", "fanhao", "library", "NativeShortVideoActionResult.java");
  const activityResultDecoder = path.join(root, "android-client", "android", "app", "src", "main", "java", "local", "fanhao", "library", "NativeShortVideoActionResultDecoder.java");
  const preferences = path.join(root, "android-client", "android", "app", "src", "main", "java", "local", "fanhao", "library", "NativeShortVideoActionPreferences.java");
  const stateHarness = path.join(root, "tools", "fixtures", "NativeShortVideoActionStateHarness.java");
  const preferencesHarness = path.join(root, "tools", "fixtures", "NativeShortVideoActionPreferencesHarness.java");
  const androidJar = findAndroidJar();
  const orgJsonJar = findOrgJsonJar();
  assert(androidJar, "native action preferences harness requires a locally installed Android platform android.jar");
  assert(orgJsonJar, "native action preferences harness requires the cached org.json runtime jar");
  const dependencies = [orgJsonJar, androidJar].join(path.delimiter);
  const compiled = spawnSync(javac, [
    "-encoding", "UTF-8",
    "-cp", dependencies,
    "-d", tempRoot,
    source,
    snapshots,
    activityResult,
    activityResultDecoder,
    preferences,
    stateHarness,
    preferencesHarness
  ], { cwd: root, encoding: "utf8" });
  assert.equal(compiled.status, 0, `native action harnesses must compile:\n${compiled.stderr || compiled.stdout}`);
  const runtimeClasspath = [tempRoot, orgJsonJar, androidJar].join(path.delimiter);
  for (const harness of [
    "local.fanhao.library.NativeShortVideoActionStateHarness",
    "local.fanhao.library.NativeShortVideoActionPreferencesHarness"
  ]) {
    const executed = spawnSync(java, ["-cp", runtimeClasspath, harness], { cwd: root, encoding: "utf8" });
    assert.equal(executed.status, 0, `${harness} must pass:\n${executed.stderr || executed.stdout}`);
    process.stdout.write(executed.stdout);
  }
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true });
}
