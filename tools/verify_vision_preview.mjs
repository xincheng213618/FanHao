import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const root = path.resolve(import.meta.dirname, "..");
const nativeRoot = path.join(root, "android-client/android/app/src/main/java/local/fanhao/library");
const fixtures = path.join(root, "tools/fixtures/vision-preview");
const javaHome = String(process.env.JAVA_HOME || "").trim();
const executable = (name) => javaHome && fs.existsSync(path.join(javaHome, "bin", `${name}.exe`))
  ? path.join(javaHome, "bin", `${name}.exe`) : name;
const activity = fs.readFileSync(path.join(nativeRoot, "NativeVisionExplorationActivity.java"), "utf8").replace(/\r\n/g, "\n");
const decoder = fs.readFileSync(path.join(nativeRoot, "VisionPreviewDecoder.java"), "utf8").replace(/\r\n/g, "\n");
const extractMethod = (source, name) => source.match(new RegExp(`  private [\\w.]+ ${name}\\([^]*?\\) \\{[^]*?\\n  \\}`))?.[0];
const method = (name) => extractMethod(activity, name);
// Review widget creation is not executed. Guard only its production decoder and
// failure-message wiring; actual Android ImageView/rendering remains unverified.
function verifyPreviewWiring(source) {
  assert.ok(extractMethod(source, "decodePreview")?.includes("return VisionPreviewDecoder.decode(file, maxWidth);"), "Activity preview wrapper must delegate file and requested width to bounded decoder");
  assert.ok(extractMethod(source, "confirmCapturedDocument")?.includes("preview = decodePreview(file, 1100);"), "captured-document confirmation must use bounded preview path");
  const review = extractMethod(source, "showArchivedSession");
  for (const required of ["Bitmap preview = decodePreview(imageFile, 1400);", "if (preview == null) {", "image.setImageBitmap(preview);", "暂时无法生成照片预览，原文件未改动。"]) {
    assert.ok(review?.includes(required), "review preview and null fallback must stay wired to the bounded decoder");
  }
}
verifyPreviewWiring(activity);
const wiringMutants = [
  ["return VisionPreviewDecoder.decode(file, maxWidth);", "return null;"],
  ["preview = decodePreview(file, 1100);", "preview = null;"],
  ["Bitmap preview = decodePreview(imageFile, 1400);", "Bitmap preview = null;"],
  ["暂时无法生成照片预览，原文件未改动。", ""],
  ["image.setImageBitmap(preview);", ""]
];
for (const [from, to] of wiringMutants) {
  assert.ok(activity.includes(from), `missing targeted preview wiring mutation: ${from}`);
  assert.throws(() => verifyPreviewWiring(activity.replace(from, to)), undefined, "disconnected preview wiring must be detected");
}
const methods = ["decodePreview", "confirmCapturedDocument"].map((name) => {
  const body = method(name); assert.ok(body, `missing production preview method: ${name}`);
  return body.replace(/^  private /, "  final ");
}).join("\n");
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "fanhao-vision-preview-"));

// Deterministic Java production-method checks. Bitmap/codec/EXIF are observable
// doubles: no native codec, image pixels from disk, camera, or actual photo is used.
try {
  const harness = fs.readFileSync(path.join(fixtures, "VisionPreviewHarness.java"), "utf8")
    .replace("  /* PRODUCTION_METHODS */", methods);
  const generated = path.join(temporary, "VisionPreviewHarness.java"); fs.writeFileSync(generated, harness);
  const sources = fs.globSync("**/*.java", { cwd: fixtures }).filter((name) => !name.endsWith("VisionPreviewHarness.java")).map((name) => path.join(fixtures, name));
  const compile = spawnSync(executable("javac"), ["-encoding", "UTF-8", "-d", temporary, ...sources,
    path.join(nativeRoot, "VisionPreviewDecoder.java"), path.join(nativeRoot, "VisionCaptureLifecycle.java"), generated], { encoding: "utf8", timeout: 30000 });
  assert.equal(compile.status, 0, compile.error?.message || `${compile.stdout}\n${compile.stderr}`);
  const run = spawnSync(executable("java"), ["-cp", temporary, "local.fanhao.library.VisionPreviewHarness"], { encoding: "utf8", timeout: 15000 });
  assert.equal(run.status, 0, run.error?.message || `${run.stdout}\n${run.stderr}`); process.stdout.write(run.stdout);
  const regressions = ["tall", "mirror2", "mirror4", "mirror5", "mirror7", "bounds-oom", "decode-oom", "rotate-oom", "quality"];
  for (const scenario of regressions) {
    const failed = spawnSync(executable("java"), ["-cp", temporary, "local.fanhao.library.VisionPreviewHarness", scenario], { encoding: "utf8", timeout: 15000 });
    assert.notEqual(failed.status, 0, `old preview unexpectedly passed safety regression ${scenario}`);
    assert.match(failed.stderr, /AssertionError: old (preview|confirmation) must/, `old ${scenario} failed for unrelated reason`);
  }
  process.stdout.write(`vision-preview-legacy-red-controls: ${regressions.length} compiled old-source safety regressions rejected\n`);
  const decoderMutants = [
    ["missing-height-bound", "&& height <= MAX_EDGE", "", /memory predicate handles both edges/],
    ["missing-pixel-bound", "&& (long) width * height <= MAX_PIXELS", "", /memory predicate handles both edges/],
    ["floor-sampling", "(long) edge + sample - 1L", "(long) edge", /sampling is the smallest/],
    ["swapped-transpose", "matrix.setRotate(90f); matrix.postScale(-1f, 1f);", "matrix.setRotate(270f); matrix.postScale(-1f, 1f);", /EXIF transform matches independent/],
    ["missing-input-allocation-check", " && fitsBitmap(owned)", "", /oversized decoded allocation is rejected before/],
    ["missing-output-allocation-check", "if (fitsBitmap(owned)) {", "if (fitsMemory(owned.getWidth(), owned.getHeight())) {", /actual decoded\/transformed geometry or allocation beyond budget/],
    ["missing-owned-release", "if (owned != null) owned.recycle();", "", /every allocated non-output bitmap is released/],
    ["excessive-allocation-retries", "MAX_ATTEMPTS = 3", "MAX_ATTEMPTS = 4", /decode\/transform OOM retries are bounded/]
  ];
  for (const [name, from, to, expected] of decoderMutants) {
    assert.ok(decoder.includes(from), `missing targeted decoder mutation: ${name}`);
    const output = path.join(temporary, name); fs.mkdirSync(output);
    const source = path.join(output, "VisionPreviewDecoder.java"); fs.writeFileSync(source, decoder.replace(from, to));
    const compileMutant = spawnSync(executable("javac"), ["-encoding", "UTF-8", "-cp", temporary, "-d", output, source], { encoding: "utf8", timeout: 30000 });
    assert.equal(compileMutant.status, 0, compileMutant.error?.message || `${compileMutant.stdout}\n${compileMutant.stderr}`);
    const failed = spawnSync(executable("java"), ["-cp", [output, temporary].join(path.delimiter), "local.fanhao.library.VisionPreviewHarness"], { encoding: "utf8", timeout: 15000 });
    assert.notEqual(failed.status, 0, `decoder mutant ${name} incorrectly passed`);
    assert.match(failed.stderr, expected, `decoder mutant ${name} failed for unrelated reason`);
  }
  process.stdout.write(`vision-preview-negative-controls: ${decoderMutants.length} full decoder mutants and ${wiringMutants.length} static Activity wiring mutants rejected\n`);
} finally {
  const resolved = fs.realpathSync(temporary), tempParent = fs.realpathSync(os.tmpdir());
  assert.equal(path.dirname(resolved).toLowerCase(), tempParent.toLowerCase());
  assert.ok(path.basename(resolved).startsWith("fanhao-vision-preview-"));
  if (process.platform === "win32") {
    const cleanup = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `Remove-Item -LiteralPath '${resolved.replaceAll("'", "''")}' -Recurse -Force`], { encoding: "utf8", timeout: 15000 });
    assert.equal(cleanup.status, 0, cleanup.stderr);
  } else fs.rmSync(resolved, { recursive: true, force: true });
}
