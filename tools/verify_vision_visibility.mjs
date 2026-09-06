import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const root = path.resolve(import.meta.dirname, "..");
const production = path.join(root, "android-client/android/app/src/main/java/local/fanhao/library/VisionCaptureLifecycle.java");
const source = fs.readFileSync(production, "utf8").replace(/\r\n/g, "\n");
const verifier = path.join(root, "tools/fixtures/VisionVisibilityVerifier.java");
const legacy = fs.readFileSync(path.join(root, "tools/fixtures/vision-capture-before-visibility.java.txt"), "utf8");
const javaHome = String(process.env.JAVA_HOME || "").trim()
  || (process.platform === "win32" ? "C:\\Program Files\\Android\\openjdk\\jdk-21.0.8" : "");
assert(javaHome, "Set JAVA_HOME to the existing JDK 21; this verifier never downloads a runtime");
const executable = (name) => path.join(javaHome, "bin", process.platform === "win32" ? `${name}.exe` : name);
const environment = { ...process.env, JAVA_HOME: javaHome };
for (const name of ["java", "javac"]) {
  assert(fs.existsSync(executable(name)), `Missing JDK 21 executable: ${executable(name)}`);
  const version = spawnSync(executable(name), ["-version"], { encoding: "utf8", timeout: 10000, env: environment });
  assert.equal(version.status, 0, version.error?.message || version.stderr);
  const output = `${version.stdout}\n${version.stderr}`;
  assert(name === "javac" ? /javac 21(?:\.|\s|$)/.test(output) : /version "21(?:\.|"|\s)/.test(output),
    `Visibility verification requires JAVA_HOME 21, received ${output.trim()}`);
}

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "fanhao-vision-visibility-"));

function compile(helper, output, extra = verifier) {
  fs.mkdirSync(output, { recursive: true });
  const result = spawnSync(executable("javac"), ["--release", "21", "-encoding", "UTF-8", "-d", output, helper, extra],
    { encoding: "utf8", timeout: 30000, env: environment });
  assert.equal(result.status, 0, result.error?.message || `${result.stdout}\n${result.stderr}`);
}

function run(output, main = "local.fanhao.library.VisionVisibilityVerifier", args = []) {
  return spawnSync(executable("java"), ["-cp", output, main, ...args],
    { encoding: "utf8", timeout: 30000, env: environment });
}

function replaceOnce(text, before, after, name) {
  assert.equal(text.split(before).length - 1, 1, `Negative control ${name} requires exactly one matching source boundary`);
  return text.replace(before, after);
}

function methodMutation(name, before, after) {
  const expression = new RegExp(`  synchronized boolean ${name}\\([^]*?\\n  \\}`);
  const match = source.match(expression)?.[0];
  assert(match, `Expected the complete ${name} method for a bounded negative control`);
  return source.replace(match, replaceOnce(match, before, after, name));
}

const mutants = [
  { name: "missing-suspend-generation", scenario: "reason-edges", evidence: "suspend edge must increment generation",
    build: () => methodMutation("suspend", "    generation++;", "") },
  { name: "missing-resume-generation", scenario: "reason-edges", evidence: "resume edge must increment generation",
    build: () => methodMutation("resume", "    generation++;", "") },
  { name: "release-clears-all-owners", scenario: "overlap-orders", evidence: "resume must not clear another owner's reason",
    build: () => methodMutation("resume", "    suspensionReasons &= ~reason;", "    suspensionReasons = 0;") },
  { name: "accepts-ignores-suspension", scenario: "reason-edges", evidence: "paused accepts must reject even the current token",
    build: () => replaceOnce(source, "return isAlive() && suspensionReasons == 0 && generation == token;", "return isAlive() && generation == token;", "accepts") },
  { name: "completion-ignores-suspension", scenario: "paused-completion", evidence: "markCompleted must be rejected while paused",
    build: () => methodMutation("markCompleted", " || suspensionReasons != 0", "") },
  { name: "delivery-ignores-suspension", scenario: "paused-completion", evidence: "deliver must be rejected while paused",
    build: () => methodMutation("deliver", " || suspensionReasons != 0", "") },
  { name: "duplicate-suspend-changes-state", scenario: "reason-edges", evidence: "duplicate suspend must report no change",
    build: () => methodMutation("suspend", " || (suspensionReasons & reason) != 0", "") },
  { name: "duplicate-resume-changes-state", scenario: "reason-edges", evidence: "duplicate resume must report no change",
    build: () => methodMutation("resume", " || (suspensionReasons & reason) == 0", "") }
];

try {
  const current = path.join(temporary, "current");
  // Compile the entire actual production file directly, not extracted methods.
  compile(production, current);
  if (!process.argv.includes("--negative-only")) {
    const result = run(current);
    assert.equal(result.status, 0, result.error?.message || `${result.stdout}\n${result.stderr}`);
    process.stdout.write(result.stdout);
  }

  // Historical proof is intentionally only an API capability check. The old full
  // helper compiles, but has no pause ownership API; no compile error is counted
  // as behavioral proof and no unavailable old method is called by the new tests.
  assert(!legacy.includes("suspend(int reason)"), "Frozen legacy source unexpectedly already supports pause ownership");
  const oldDirectory = path.join(temporary, "legacy"); fs.mkdirSync(oldDirectory);
  const oldHelper = path.join(oldDirectory, "VisionCaptureLifecycle.java"); fs.writeFileSync(oldHelper, legacy);
  const probe = path.join(oldDirectory, "VisibilityApiProbe.java");
  fs.writeFileSync(probe, `package local.fanhao.library;
public final class VisibilityApiProbe {
  public static void main(String[] args) throws Exception {
    Class<?> type = VisionCaptureLifecycle.class;
    int missing = 0;
    for (String field : new String[] { "BACKGROUND", "EXIT_CONFIRMATION", "FATAL_ERROR" }) {
      try { type.getDeclaredField(field); } catch (NoSuchFieldException expected) { missing++; }
    }
    for (String method : new String[] { "suspend", "resume", "isSuspended" }) {
      try { type.getDeclaredMethod(method, int.class); } catch (NoSuchMethodException expected) { missing++; }
    }
    for (String method : new String[] { "isAlive", "isSuspended" }) {
      try { type.getDeclaredMethod(method); } catch (NoSuchMethodException expected) { missing++; }
    }
    if (missing != 8) throw new AssertionError("Legacy capability baseline changed: " + missing);
    System.out.println("LEGACY capability proof: 8 pause-ownership API members absent; old full helper compiled successfully");
  }
}
`);
  compile(oldHelper, path.join(oldDirectory, "classes"), probe);
  const oldResult = run(path.join(oldDirectory, "classes"), "local.fanhao.library.VisibilityApiProbe");
  assert.equal(oldResult.status, 0, oldResult.error?.message || `${oldResult.stdout}\n${oldResult.stderr}`);
  assert(oldResult.stdout.includes("8 pause-ownership API members absent"));
  process.stdout.write(oldResult.stdout);

  let controls = 0;
  for (const mutant of mutants) {
    const directory = path.join(temporary, mutant.name); fs.mkdirSync(directory);
    const helper = path.join(directory, "VisionCaptureLifecycle.java");
    fs.writeFileSync(helper, mutant.build());
    compile(helper, path.join(directory, "classes"));
    const result = run(path.join(directory, "classes"), "local.fanhao.library.VisionVisibilityVerifier", [mutant.scenario]);
    assert.notEqual(result.status, 0, `Negative control unexpectedly passed: ${mutant.name}`);
    assert(!result.error && !result.signal, `Negative control must fail by a behavioral assertion, not timeout/crash: ${mutant.name}`);
    assert(result.stderr.includes("java.lang.AssertionError") && result.stderr.includes(mutant.evidence),
      `Negative control failed for the wrong reason: ${mutant.name}\n${result.stdout}\n${result.stderr}`);
    controls++;
    console.log(`CONTROL ${mutant.name}: ${mutant.evidence}`);
  }
  console.log(`Vision visibility verification: JDK 21; ${controls} targeted behavioral mutations rejected; 1 separate legacy API capability proof; 0 failures.`);
} finally {
  const resolved = fs.realpathSync(temporary);
  const parent = fs.realpathSync(os.tmpdir());
  assert.equal(path.dirname(resolved).toLowerCase(), parent.toLowerCase(), "cleanup must remain directly within system temp");
  assert(path.basename(resolved).startsWith("fanhao-vision-visibility-"), "cleanup must target only this verifier's private temporary directory");
  if (process.platform === "win32") {
    const cleanup = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
      `Remove-Item -LiteralPath '${resolved.replaceAll("'", "''")}' -Recurse -Force`], { encoding: "utf8", timeout: 15000 });
    assert.equal(cleanup.status, 0, cleanup.stderr);
  } else fs.rmSync(resolved, { recursive: true, force: true });
}
