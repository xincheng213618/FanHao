import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "fanhao-native-http-"));
const javaHome = String(process.env.JAVA_HOME || "").trim();
const bundledJavaHome = "C:\\Program Files\\Android\\openjdk\\jdk-21.0.8";
const javaExecutable = (name) => javaHome
  ? path.join(javaHome, "bin", `${name}.exe`)
  : fs.existsSync(path.join(bundledJavaHome, "bin", `${name}.exe`))
    ? path.join(bundledJavaHome, "bin", `${name}.exe`)
    : name;

try {
  const sources = [
    path.join(root, "android-client", "android", "app", "src", "main", "java", "local", "fanhao", "library", "NativeShortVideoHttpResponse.java"),
    path.join(root, "android-client", "android", "app", "src", "main", "java", "local", "fanhao", "library", "NativeShortVideoImageLoader.java"),
    path.join(root, "tools", "fixtures", "NativeShortVideoHttpHarness.java")
  ];
  const compiled = spawnSync(javaExecutable("javac"), ["-encoding", "UTF-8", "-d", tempRoot, ...sources], {
    cwd: root,
    encoding: "utf8"
  });
  assert.equal(compiled.status, 0, `native HTTP harness must compile:\n${compiled.stderr || compiled.stdout}`);
  const executed = spawnSync(javaExecutable("java"), ["-cp", tempRoot, "local.fanhao.library.NativeShortVideoHttpHarness"], {
    cwd: root,
    encoding: "utf8"
  });
  assert.equal(executed.status, 0, `native HTTP harness must pass:\n${executed.stderr || executed.stdout}`);
  process.stdout.write(executed.stdout);
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true });
}
