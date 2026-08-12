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

try {
  const source = path.join(root, "android-client", "android", "app", "src", "main", "java", "local", "fanhao", "library", "NativeShortVideoActionState.java");
  const harness = path.join(root, "tools", "fixtures", "NativeShortVideoActionStateHarness.java");
  const compiled = spawnSync(javac, ["-encoding", "UTF-8", "-d", tempRoot, source, harness], { cwd: root, encoding: "utf8" });
  assert.equal(compiled.status, 0, `native action-state harness must compile:\n${compiled.stderr || compiled.stdout}`);
  const executed = spawnSync(java, ["-cp", tempRoot, "local.fanhao.library.NativeShortVideoActionStateHarness"], { cwd: root, encoding: "utf8" });
  assert.equal(executed.status, 0, `native action-state harness must pass:\n${executed.stderr || executed.stdout}`);
  process.stdout.write(executed.stdout);
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true });
}
