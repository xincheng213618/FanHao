import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const root = path.resolve(import.meta.dirname, "..");
const nativeRoot = path.join(root, "android-client/android/app/src/main/java/local/fanhao/library");
const fixtureRoot = path.join(root, "tools/fixtures/vision-capture-callbacks");
const activity = fs.readFileSync(path.join(nativeRoot, "NativeVisionExplorationActivity.java"), "utf8").replace(/\r\n/g, "\n");
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "fanhao-vision-capture-callbacks-"));
const javaHome = String(process.env.JAVA_HOME || "").trim();
const executable = (name) => javaHome && fs.existsSync(path.join(javaHome, "bin", `${name}.exe`))
  ? path.join(javaHome, "bin", `${name}.exe`) : name;
function method(name) {
  const body = activity.match(new RegExp(`  private [\\w.]+ ${name}\\([^]*?\\) \\{[^]*?\\n  \\}`))?.[0];
  assert.ok(body, `missing production method ${name}`);
  return body.replace(/^  private /, "  ");
}
const selected = ["takePicture", "captureVerifiedFace", "retryFaceCapture"];
const shared = ["canUseUi", "postCaptureUi", "resetFaceTracking"];
const production = selected.map(method).join("\n");
const harness = fs.readFileSync(path.join(fixtureRoot, "VisionCaptureCallbacksHarness.java"), "utf8")
  .replace("  /* SHARED_PRODUCTION_METHODS */", shared.map(method).join("\n"))
  .replace("/* PRODUCTION_HOST */", `final class ProductionVisionCaptureHost extends CaptureHostBase {\n${production}\n}`);

// Executes the unmodified production method bodies, plus the full real lifecycle
// helper. Only Java visibility changes. CameraX request delivery, UI scheduling,
// and archive completion/fatal presentation are explicit synthetic boundaries.
// The test does not claim real Android/CameraX executor behavior or model/hardware.
try {
  const source = path.join(temporary, "VisionCaptureCallbacksHarness.java");
  fs.writeFileSync(source, harness);
  const compile = spawnSync(executable("javac"), ["-encoding", "UTF-8", "-d", temporary,
    path.join(nativeRoot, "VisionCaptureLifecycle.java"), path.join(fixtureRoot, "LegacyVisionCaptureHost.java"), source],
  { encoding: "utf8", timeout: 30000 });
  assert.equal(compile.status, 0, compile.error?.message || `${compile.stdout}\n${compile.stderr}`);
  const run = (scenario, legacy = false, extraClassPath = null) => {
    const files = path.join(temporary, `${legacy ? "legacy" : "current"}-${scenario}-${extraClassPath ? path.basename(extraClassPath) : "baseline"}`);
    fs.mkdirSync(files);
    return spawnSync(executable("java"), ["-cp", extraClassPath ? [extraClassPath, temporary].join(path.delimiter) : temporary,
      "local.fanhao.library.VisionCaptureCallbacksHarness", files, scenario, legacy ? "legacy" : "current"],
    { encoding: "utf8", timeout: 15000 });
  };
  const positive = run("all");
  assert.equal(positive.status, 0, positive.error?.message || `${positive.stdout}\n${positive.stderr}`);
  process.stdout.write(positive.stdout);
  const legacyScenarios = ["duplicate-success", "duplicate-failure", "options", "launch-oom", "retained-launch", "success-then-throw",
    "success-handler", "face-ui", "face-retry", "queued-post", "face-commit-oom", "invalid-entry"];
  for (const scenario of legacyScenarios) {
    const red = run(scenario, true);
    assert.notEqual(red.status, 0, `frozen unsafe source incorrectly passed ${scenario}`);
    assert.match(red.stderr, /AssertionError: callback safety:/, `legacy ${scenario} failed for unrelated reason: ${red.stderr}`);
  }
  process.stdout.write(`vision-capture-callbacks-legacy-red: ${legacyScenarios.length} compiled frozen-source scenarios rejected\n`);
  const mutations = [
    ["repeat-success", "if (!requestOutcome.compareAndSet(0, 1)) {", "if (false) {", "duplicate-success"],
    ["delete-success-owned-input", "if (requestOutcome.get() == 2) VisionCaptureLifecycle.discardTemporary(output);", "VisionCaptureLifecycle.discardTemporary(output);", "duplicate-success"],
    ["repeat-error", "if (!requestOutcome.compareAndSet(0, 2)) return;", "", "duplicate-failure"],
    ["revive-failed-launch", "if (requestOutcome.get() == 2) VisionCaptureLifecycle.discardTemporary(output);", "if (requestOutcome.get() == 2) success.run();", "retained-launch"],
    ["reverse-success-on-throw", "if (outcome == null || outcome.compareAndSet(0, 2)) {", "if (true) {", "success-then-throw"],
    ["ignore-launch-oom", "} catch (RuntimeException | OutOfMemoryError error) {", "} catch (RuntimeException error) {", "launch-oom"],
    ["retain-face-gate-on-retry", "    faceCaptureStarted = false;", "", "face-retry"],
    ["revive-abandoned-ui", "if (!uiAttempt.compareAndSet(true, false)) return;", "", "queued-post"],
    ["skip-full-action-reset", "    resetFaceTracking(message);", "    stableFrames = 0;", "face-retry"],
    ["success-handler-ignores-oom", "catch (Exception | OutOfMemoryError error)", "catch (Exception error)", "face-commit-oom"]
  ];
  for (const [name, from, to, scenario] of mutations) {
    assert.ok(harness.includes(from), `missing targeted callback mutation ${name}`);
    const directory = path.join(temporary, name); fs.mkdirSync(directory);
    const changed = path.join(directory, "VisionCaptureCallbacksHarness.java"); fs.writeFileSync(changed, harness.replace(from, to));
    const built = spawnSync(executable("javac"), ["-encoding", "UTF-8", "-cp", temporary, "-d", directory, changed],
      { encoding: "utf8", timeout: 30000 });
    assert.equal(built.status, 0, built.error?.message || `${built.stdout}\n${built.stderr}`);
    const rejected = run(scenario, false, directory);
    assert.notEqual(rejected.status, 0, `${name} incorrectly passed callback safety checks`);
    assert.match(rejected.stderr, /AssertionError: callback safety:/, `${name} failed for unrelated reason: ${rejected.stderr}`);
  }
  process.stdout.write(`vision-capture-callbacks-negative-controls: ${mutations.length} production-body mutants rejected\n`);
} finally {
  const resolved = fs.realpathSync(temporary), parent = fs.realpathSync(os.tmpdir());
  assert.equal(path.dirname(resolved).toLowerCase(), parent.toLowerCase());
  assert.ok(path.basename(resolved).startsWith("fanhao-vision-capture-callbacks-"));
  if (process.platform === "win32") {
    const cleanup = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
      `Remove-Item -LiteralPath '${resolved.replaceAll("'", "''")}' -Recurse -Force`], { encoding: "utf8", timeout: 15000 });
    assert.equal(cleanup.status, 0, cleanup.stderr);
  } else fs.rmSync(resolved, { recursive: true, force: true });
}
