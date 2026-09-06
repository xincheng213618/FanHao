import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const root = path.resolve(import.meta.dirname, "..");
const production = path.join(root, "android-client/android/app/src/main/java/local/fanhao/library/VisionExplorationStore.java");
const productionSource = fs.readFileSync(production, "utf8");
assert(!productionSource.includes("java.nio.file"), "Android min24 store must not depend on API26 java.nio.file");
const requireCanonicalLinks = process.argv.includes("--require-canonical-links");
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "fanhao-vision-store-"));
const javaHome = String(process.env.JAVA_HOME || "").trim();
const executable = (name) => javaHome && fs.existsSync(path.join(javaHome, "bin", `${name}.exe`))
  ? path.join(javaHome, "bin", `${name}.exe`) : name;

function findOrgJsonJar() {
  const gradleHome = String(process.env.GRADLE_USER_HOME || "").trim() || path.join(os.homedir(), ".gradle");
  const modules = path.join(gradleHome, "caches/modules-2/files-2.1/org.json/json");
  if (!fs.existsSync(modules)) return "";
  const versions = fs.readdirSync(modules, { withFileTypes: true }).filter((entry) => entry.isDirectory())
    .map((entry) => entry.name).sort((left, right) => right.localeCompare(left, undefined, { numeric: true }));
  for (const version of versions) {
    const directory = path.join(modules, version);
    for (const hash of fs.readdirSync(directory, { withFileTypes: true }).filter((entry) => entry.isDirectory())) {
      const found = fs.readdirSync(path.join(directory, hash.name)).find((name) => /^json-.+\.jar$/u.test(name));
      if (found) return path.join(directory, hash.name, found);
    }
  }
  return "";
}

// These are JVM boundary doubles, not Android app implementations. The host OS
// rename uses its atomic move operation with injectable failures immediately
// before commit. Every generated class and synthetic session is verifier-owned.
const doubles = {
  "android/content/Context.java": `package android.content;
import java.io.File;
public class Context {
  private final File files;
  public Context(File files) { this.files = files; }
  public File getFilesDir() { return files; }
}`,
  "android/system/ErrnoException.java": `package android.system;
public class ErrnoException extends Exception {
  public ErrnoException(String message, Throwable cause) { super(message, cause); }
}`,
  "android/system/Os.java": `package android.system;
import java.io.IOException;
import java.nio.file.*;
public final class Os {
  public static volatile boolean failNextRename;
  public static volatile Runnable beforeRename;
  public static int renameCalls;
  public static void reset() { failNextRename = false; beforeRename = null; renameCalls = 0; }
  public static void rename(String source, String destination) throws ErrnoException {
    renameCalls++;
    Runnable hook = beforeRename;
    if (hook != null) hook.run();
    if (failNextRename) { failNextRename = false; throw new ErrnoException("synthetic rename failure", null); }
    try { Files.move(Paths.get(source), Paths.get(destination), StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING); }
    catch (IOException failure) { throw new ErrnoException("rename", failure); }
  }
}`
};

try {
  const json = findOrgJsonJar();
  assert(json, "vision-store verifier requires the existing cached org.json runtime; no dependency is downloaded");
  const generated = [];
  for (const [relative, contents] of Object.entries(doubles)) {
    const target = path.join(temporary, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, contents);
    generated.push(target);
  }
  const compile = spawnSync(executable("javac"), ["-encoding", "UTF-8", "-cp", json, "-d", temporary,
    production, path.join(path.dirname(production), "VisionCaptureLifecycle.java"), ...generated,
    path.join(root, "tools/fixtures/LegacyVisionManifestCommit.java"),
    path.join(root, "tools/fixtures/VisionStoreVerifier.java")], { encoding: "utf8", timeout: 30000 });
  assert.equal(compile.status, 0, compile.error?.message || `${compile.stdout}\n${compile.stderr}`);
  const execute = spawnSync(executable("java"), [...(requireCanonicalLinks ? ["-Dvision.store.requireCanonicalLinks=true"] : []),
    "-cp", [temporary, json].join(path.delimiter),
    "local.fanhao.library.VisionStoreVerifier", temporary], { encoding: "utf8", timeout: 30000 });
  assert.equal(execute.status, 0, execute.error?.message || `${execute.stdout}\n${execute.stderr}`);
  process.stdout.write(execute.stdout);
} finally {
  const resolved = fs.realpathSync(temporary);
  const parent = fs.realpathSync(os.tmpdir());
  assert.equal(path.dirname(resolved).toLowerCase(), parent.toLowerCase(), "cleanup must remain directly within system temp");
  assert(path.basename(resolved).startsWith("fanhao-vision-store-"), "cleanup requires the verifier-owned temporary directory");
  if (process.platform === "win32") {
    const cleanup = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
      `Remove-Item -LiteralPath '${resolved.replaceAll("'", "''")}' -Recurse -Force`], { encoding: "utf8", timeout: 15000 });
    assert.equal(cleanup.status, 0, cleanup.stderr);
  } else fs.rmSync(resolved, { recursive: true, force: true });
}
