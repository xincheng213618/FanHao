import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "fanhao-native-feed-paging-"));
const javaHome = String(process.env.JAVA_HOME || "").trim();
const bundledJavaHome = "C:\\Program Files\\Android\\openjdk\\jdk-21.0.8";
const javac = javaHome
  ? path.join(javaHome, "bin", "javac.exe")
  : fs.existsSync(path.join(bundledJavaHome, "bin", "javac.exe"))
    ? path.join(bundledJavaHome, "bin", "javac.exe")
    : "javac";
const java = javaHome
  ? path.join(javaHome, "bin", "java.exe")
  : fs.existsSync(path.join(bundledJavaHome, "bin", "java.exe"))
    ? path.join(bundledJavaHome, "bin", "java.exe")
    : "java";

try {
  const sources = [
    path.join(root, "android-client", "android", "app", "src", "main", "java", "local", "fanhao", "library", "NativeShortVideoFeedPaging.java"),
    path.join(root, "android-client", "android", "app", "src", "main", "java", "local", "fanhao", "library", "NativeShortVideoFeedAutoAdvance.java"),
    path.join(root, "android-client", "android", "app", "src", "main", "java", "local", "fanhao", "library", "NativeShortVideoHttpResponse.java"),
    path.join(root, "android-client", "android", "app", "src", "main", "java", "local", "fanhao", "library", "NativeShortVideoFeedTransport.java"),
    path.join(root, "tools", "fixtures", "NativeShortVideoFeedPagingHarness.java")
  ];
  const compiled = spawnSync(javac, ["--add-modules", "jdk.httpserver", "-encoding", "UTF-8", "-d", tempRoot, ...sources], {
    cwd: root,
    encoding: "utf8"
  });
  assert.equal(compiled.status, 0, `native feed paging harness must compile:\n${compiled.stderr || compiled.stdout}`);
  const executed = spawnSync(java, ["--add-modules", "jdk.httpserver", "-cp", tempRoot, "local.fanhao.library.NativeShortVideoFeedPagingHarness"], {
    cwd: root,
    encoding: "utf8"
  });
  assert.equal(executed.status, 0, `native feed paging harness must pass:\n${executed.stderr || executed.stdout}`);
  process.stdout.write(executed.stdout);
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true });
}
