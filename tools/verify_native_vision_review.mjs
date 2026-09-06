import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const root = path.resolve(import.meta.dirname, "..");
const nativeRoot = path.join(root, "android-client/android/app/src/main/java/local/fanhao/library");
const fixtures = path.join(root, "tools/fixtures");
const javaHome = String(process.env.JAVA_HOME || "").trim();
const executable = (name) => javaHome && fs.existsSync(path.join(javaHome, "bin", `${name}.exe`))
  ? path.join(javaHome, "bin", `${name}.exe`) : name;
const activity = fs.readFileSync(path.join(nativeRoot, "NativeVisionExplorationActivity.java"), "utf8").replace(/\r\n/g, "\n");
const extractMethod = (source, name) => source.match(new RegExp(`  (?:private|protected) [\\w.]+ ${name}\\([^]*?\\) \\{[^]*?\\n  \\}`))?.[0];
const method = (name) => extractMethod(activity, name);
// Static entry/registry/widget wiring only. The chooser wrapper and platform URI
// grant transfer remain Android boundaries, not behavior proven by these stubs.
function verifyReviewWiring(source) {
  const create = extractMethod(source, "onCreate");
  const initializeAt = create?.indexOf("initializeCaptureState(savedInstanceState);") ?? -1;
  const reviewBranchAt = create?.indexOf("if (MODE_REVIEW.equals(mode)) {") ?? -1;
  assert.ok(initializeAt >= 0 && reviewBranchAt > initializeAt, "onCreate must initialize saved state before the review early-return branch");
  assert.ok(extractMethod(source, "initializeCaptureState")?.includes("initializeReviewState(savedInstanceState);"), "Activity initialization must restore review state");
  assert.ok(extractMethod(source, "onSaveInstanceState")?.includes("saveReviewState(outState);"), "Activity saved state must persist review operation intent");
  assert.match(source, /ActivityResultLauncher<Intent> archiveShareLauncher = registerForActivityResult\(\s*new ActivityResultContracts\.StartActivityForResult\(\),\s*result -> onArchiveShareResult\(\)\s*\)/, "chooser launcher registry must deliver its result to the review gate");
  const share = extractMethod(source, "shareArchivedSession");
  assert.ok(share?.includes("archiveShareLauncher.launch(Intent.createChooser(share,") && !share.includes("startActivity("), "share must use the tracked launcher, not an untracked Activity start");
  assert.equal([...source.matchAll(/archiveShareLauncher\.launch\(/g)].length, 1, "tracked chooser dispatch must have one production entry point");
  const page = extractMethod(source, "showArchivedSession");
  for (const required of ["String sessionId = reviewSessionId;", "reviewExportButton = export;", "reviewDeleteButton = delete;",
    "export.setOnClickListener(view -> shareArchivedSession(sessionId));", "delete.setOnClickListener(view -> confirmDeleteArchivedSession(sessionId));"]) {
    assert.ok(page?.includes(required), `review widgets must retain selected-session wiring: ${required}`);
  }
}
verifyReviewWiring(activity);
const wiringMutants = [
  ["    initializeCaptureState(savedInstanceState);", ""],
  ["initializeReviewState(savedInstanceState);", ""],
  ["saveReviewState(outState);", ""],
  ["result -> onArchiveShareResult()", "result -> {}"],
  ["archiveShareLauncher.launch(Intent.createChooser(share,", "startActivity(Intent.createChooser(share,"],
  ["String sessionId = reviewSessionId;", "String sessionId = getIntent().getStringExtra(EXTRA_SESSION_ID);"],
  ["reviewExportButton = export;", ""],
  ["reviewDeleteButton = delete;", ""],
  ["export.setOnClickListener(view -> shareArchivedSession(sessionId));", "export.setOnClickListener(view -> shareArchivedSession(\"stale-id\"));"],
  ["delete.setOnClickListener(view -> confirmDeleteArchivedSession(sessionId));", "delete.setOnClickListener(view -> confirmDeleteArchivedSession(\"stale-id\"));"]
];
for (const [from, to] of wiringMutants) {
  assert.ok(activity.includes(from), `missing targeted review wiring mutation: ${from}`);
  assert.throws(() => verifyReviewWiring(activity.replace(from, to)), undefined, "disconnected review wiring must be detected");
}
const methodNames = [
  "shareArchivedSession", "confirmDeleteArchivedSession", "finishReview", "initializeReviewState", "saveReviewState",
  "canReviewUi", "canStartReviewAction", "updateReviewActions", "presentReviewDialog", "cancelReviewDelete",
  "dismissReviewExportError", "deleteReviewedSession", "onArchiveShareResult", "canUseUi", "canControlCapture",
  "dismissCaptureDialog", "suspendCapture", "onPause", "onResume", "onDestroy", "showFatal", "presentPendingDialog",
  "finishAfterError", "resumeAfterExitConfirmation"
];
const productionMethods = methodNames.map((name) => {
  const body = method(name); assert.ok(body, `missing production review method: ${name}`);
  return body.replace(/^  private /, "  final ");
}).join("\n");

// Only Java production method bodies plus the production lifecycle helper execute.
// Android widgets, Store, FileProvider and chooser intents are test-only doubles;
// no actual file/photo/provider, device, external app, or platform chooser is used.
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "fanhao-native-vision-review-"));
try {
  const harness = fs.readFileSync(path.join(fixtures, "NativeVisionReviewHarness.java"), "utf8")
    .replace("  /* PRODUCTION_METHODS */", productionMethods);
  const generated = path.join(temporary, "NativeVisionReviewHarness.java");
  fs.writeFileSync(generated, harness);
  const compile = spawnSync(executable("javac"), ["-encoding", "UTF-8", "-d", temporary,
    path.join(nativeRoot, "VisionCaptureLifecycle.java"), path.join(fixtures, "LegacyNativeVisionReviewHost.java"), generated],
    { encoding: "utf8", timeout: 30000 });
  assert.equal(compile.status, 0, compile.error?.message || `${compile.stdout}\n${compile.stderr}`);
  const run = spawnSync(executable("java"), ["-cp", temporary, "local.fanhao.library.NativeVisionReviewHarness"],
    { encoding: "utf8", timeout: 15000 });
  assert.equal(run.status, 0, run.error?.message || `${run.stdout}\n${run.stderr}`);
  process.stdout.write(run.stdout);
  const oldRegressions = ["background-share", "destroyed-share", "paused-delete", "destroyed-delete", "repeated-delete", "finished-delete"];
  for (const name of oldRegressions) {
    const failed = spawnSync(executable("java"), ["-cp", temporary, "local.fanhao.library.NativeVisionReviewHarness", name],
      { encoding: "utf8", timeout: 15000 });
    assert.notEqual(failed.status, 0, `frozen old review incorrectly passed safety regression: ${name}`);
    assert.match(failed.stderr, /AssertionError: old review must/, `legacy ${name} failed for an unrelated reason`);
  }
  process.stdout.write(`native-vision-review-legacy-red-controls: ${oldRegressions.length} compiled old-source safety regressions rejected\n`);
  process.stdout.write(`native-vision-review-wiring: ${wiringMutants.length} static disconnected-entry mutants rejected\n`);
} finally {
  const resolved = fs.realpathSync(temporary), tempParent = fs.realpathSync(os.tmpdir());
  assert.equal(path.dirname(resolved).toLowerCase(), tempParent.toLowerCase());
  assert.ok(path.basename(resolved).startsWith("fanhao-native-vision-review-"));
  if (process.platform === "win32") {
    const cleanup = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
      `Remove-Item -LiteralPath '${resolved.replaceAll("'", "''")}' -Recurse -Force`], { encoding: "utf8", timeout: 15000 });
    assert.equal(cleanup.status, 0, cleanup.stderr);
  } else fs.rmSync(resolved, { recursive: true, force: true });
}
