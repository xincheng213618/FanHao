import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const root = path.resolve(import.meta.dirname, "..");
const nativeRoot = path.join(root, "android-client/android/app/src/main/java/local/fanhao/library");
const fixtures = path.join(root, "tools/fixtures/vision-face-tracking");
const javaHome = String(process.env.JAVA_HOME || "").trim();
const executable = (name) => javaHome && fs.existsSync(path.join(javaHome, "bin", `${name}.exe`))
  ? path.join(javaHome, "bin", `${name}.exe`) : name;
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "fanhao-vision-face-tracking-"));

function method(source, name) {
  const match = new RegExp(`^  private void ${name}\\(`, "m").exec(source);
  assert.ok(match, `missing production method ${name}`);
  const start = match.index, body = source.indexOf("{", start);
  let depth = 0, quoted = null, lineComment = false, blockComment = false;
  for (let index = body; index < source.length; index++) {
    const char = source[index], next = source[index + 1];
    if (lineComment) { if (char === "\n") lineComment = false; continue; }
    if (blockComment) { if (char === "*" && next === "/") { blockComment = false; index++; } continue; }
    if (quoted) { if (char === "\\") index++; else if (char === quoted) quoted = null; continue; }
    if (char === "/" && next === "/") { lineComment = true; index++; continue; }
    if (char === "/" && next === "*") { blockComment = true; index++; continue; }
    if (char === '"' || char === "'") { quoted = char; continue; }
    if (char === "{") depth++;
    if (char === "}" && --depth === 0) return source.slice(start, index + 1).replace("private void", "final void");
  }
  throw new Error(`unclosed production method ${name}`);
}
function compileHarness(directory, source) {
  fs.mkdirSync(directory, { recursive: true });
  const generated = path.join(directory, "VisionFaceTrackingHarness.java"); fs.writeFileSync(generated, source);
  const result = spawnSync(executable("javac"), ["-encoding", "UTF-8", "-d", directory,
    path.join(nativeRoot, "VisionCaptureLifecycle.java"), path.join(fixtures, "LegacyVisionFaceHost.java"), generated], { encoding: "utf8", timeout: 30000 });
  assert.equal(result.status, 0, result.error?.message || `${result.stdout}\n${result.stderr}`);
}
function runHarness(directory, ...args) {
  return spawnSync(executable("java"), ["-cp", directory, "local.fanhao.library.VisionFaceTrackingHarness", ...args], { encoding: "utf8", timeout: 15000 });
}

// Synthetic frame observations exercise state progression, not identity or
// liveness authentication. No image, camera, model, filesystem photo, or person.
try {
  const activity = fs.readFileSync(path.join(nativeRoot, "NativeVisionExplorationActivity.java"), "utf8");
  const template = fs.readFileSync(path.join(fixtures, "VisionFaceTrackingHarness.java"), "utf8");
  const methods = ["analyzeFace", "awaitFaceTaskCompletion", "resetFaceTracking", "processFaces"].map((name) => method(activity, name)).join("\n\n");
  const render = (body) => template.replace("/* PRODUCTION_HOST */", `class ProductionVisionFaceHost extends FaceHostBase {\n${body}\n}`);
  const harness = render(methods);
  compileHarness(temporary, harness);
  const run = runHarness(temporary);
  assert.equal(run.status, 0, run.error?.message || `${run.stdout}\n${run.stderr}`); process.stdout.write(run.stdout);
  const regressions = ["missing-face", "multiple-faces", "out-of-frame", "offscreen-action", "zero-height", "nonfinite-action", "invalid-probability", "detector-failure", "detector-cancel", "detector-sync-failure", "missing-image"];
  for (const scenario of regressions) {
    const failed = runHarness(temporary, scenario);
    assert.notEqual(failed.status, 0, `old sequence unexpectedly passed ${scenario}`);
    assert.match(failed.stderr, /AssertionError: old face sequence must not capture/, `old ${scenario} failed for unrelated reason`);
  }
  process.stdout.write(`vision-face-legacy-red-controls: ${regressions.length} compiled old-source safety sequences rejected\n`);
  // Defeat one safety contract at a time in generated Java, never production.
  // Requiring an AssertionError distinguishes detection from compiler/tool errors.
  const mutants = [
    ["retain-phase-after-interruption", "facePhase = 0;", "facePhase = facePhase;"],
    ["retain-identity-after-interruption", "activeFaceTrackingId = null;", "activeFaceTrackingId = activeFaceTrackingId;"],
    ["accept-zero-height", "box.bottom <= box.top", "box.bottom < box.top"],
    ["accept-offcenter", "if (!centered || !Float.isFinite(yaw)", "if (false || !Float.isFinite(yaw)"],
    ["accept-nonfinite-yaw", "!Float.isFinite(yaw)", "false"],
    ["accept-out-of-range-probability", "smileProbability < 0f || smileProbability > 1f", "false"],
    ["smile-without-frontal", ": frontal && smileProbability != null", ": smileProbability != null"],
    ["turn-without-level-roll", "? Math.abs(roll) < 12f && Math.abs(yaw) > 19f", "? Math.abs(yaw) > 19f"],
    ["integer-center-overflow", "((long) box.left + box.right) / 2d", "(box.left + box.right) / 2d"],
    ["neutral-six-instead-of-seven", "if (stableFrames >= 7)", "if (stableFrames >= 6)"],
    ["action-three-instead-of-four", "if (stableFrames >= 4)", "if (stableFrames >= 3)"],
    ["detection-failure-keeps-action", "else resetFaceTracking(task.isCanceled()", "else updateFaceUi(0.04f, task.isCanceled()", "? \"人脸检测已中断，请重新正对镜头\" : \"人脸检测暂时失败，请重新正对镜头\");", "? \"人脸检测已中断，请重新正对镜头\" : \"人脸检测暂时失败，请重新正对镜头\", false);"],
  ];
  for (const [name, from, to, secondFrom, secondTo] of mutants) {
    assert.ok(methods.includes(from), `mutation target missing: ${name}`);
    let changed = methods.replace(from, to);
    if (secondFrom) { assert.ok(changed.includes(secondFrom), `second mutation target missing: ${name}`); changed = changed.replace(secondFrom, secondTo); }
    const destination = path.join(temporary, name); compileHarness(destination, render(changed));
    const failed = runHarness(destination);
    assert.notEqual(failed.status, 0, `production behavior mutant unexpectedly passed: ${name}`);
    assert.match(failed.stderr, /AssertionError:/, `${name} failed for unrelated reason: ${failed.stderr}`);
  }
  process.stdout.write(`vision-face-behavior-mutants: ${mutants.length} compiled production-method regressions rejected\n`);
} finally {
  const resolved = fs.realpathSync(temporary), tempParent = fs.realpathSync(os.tmpdir());
  assert.equal(path.dirname(resolved).toLowerCase(), tempParent.toLowerCase());
  assert.ok(path.basename(resolved).startsWith("fanhao-vision-face-tracking-"));
  if (process.platform === "win32") {
    const cleanup = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `Remove-Item -LiteralPath '${resolved.replaceAll("'", "''")}' -Recurse -Force`], { encoding: "utf8", timeout: 15000 });
    assert.equal(cleanup.status, 0, cleanup.stderr);
  } else fs.rmSync(resolved, { recursive: true, force: true });
}
