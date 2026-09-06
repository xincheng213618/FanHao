import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

// Complete production reader/decoder/claim queue; extracted real plugin read,
// picker, metadata, Intent and reply methods. Explicit Android/provider/Capacitor
// doubles, scaled 64-byte plugin limit. No external URI, device or APK build.
const root = path.resolve(import.meta.dirname, "..");
const nativeRoot = path.join(root, "android-client/android/app/src/main/java/local/fanhao/library");
const readNative = (name) => fs.readFileSync(path.join(nativeRoot, name), "utf8").replace(/\r\n/g, "\n");
const source = readNative("FanHaoNovelPlugin.java");
const names = ["capturePendingTextIntent", "consumePendingTextFile", "readIntentText", "readScannedTextFile", "readPickedTextFile",
  "textDocumentPickerResult", "readAllBytes", "decodeText", "textResult", "unavailableResult", "clearPendingIntent", "sanitizeFileName",
  "resolvePluginCall", "rejectPluginCall", "isContentUri", "isContentUriString", "isTextFileName", "isTextUri",
  "queryDocumentMetadata", "queryOptionalDocumentMetadata", "cursorLong", "cursorNull", "displayName", "queryDisplayName",
  "looksLikeTextIntent", "shouldHandleTextIntent", "unsupportedTextIntentMessage", "isTextDisplayName", "textIntentUri"];
const methodBlocks = new Map();
const methods = names.flatMap((name) => {
  const matches = [...source.matchAll(new RegExp("^  (?:private |public |protected )?(?:static )?[\\w.<>\\[\\]]+ " + name + "\\([^]*?\\n  \\}", "gm"))];
  assert.ok(matches.length, "missing production text method: " + name);
  const blocks = matches.map((match) => match[0].replace(/^  private /, "  "));
  methodBlocks.set(name, blocks); return blocks;
}).join("\n");
const template = fs.readFileSync(path.join(root, "tools/fixtures/NativeTextReadVerifier.java"), "utf8").replace(/\r\n/g, "\n");
assert.equal(template.split("  /* PRODUCTION_METHODS */").length, 2);
const actual = {
  harness: template.replace("  /* PRODUCTION_METHODS */", methods),
  reader: readNative("BoundedTextReader.java"),
  decoder: readNative("NativeTextDecoder.java"),
  queue: readNative("PendingTextImportQueue.java"),
};
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "fanhao-native-text-reads-"));
const javaHome = String(process.env.JAVA_HOME || "").trim() || "C:\\Program Files\\Android\\openjdk\\jdk-21.0.8";
const java = (name) => path.join(javaHome, "bin", name + (process.platform === "win32" ? ".exe" : ""));
let serial = 0;
function compile(bundle) {
  const directory = path.join(temporary, "case-" + serial++); fs.mkdirSync(directory);
  const files = [["NativeTextReadVerifier.java", bundle.harness], ["BoundedTextReader.java", bundle.reader],
    ["PendingTextImportQueue.java", bundle.queue]];
  if (bundle.decoder) files.push(["NativeTextDecoder.java", bundle.decoder]);
  for (const [name, contents] of files) fs.writeFileSync(path.join(directory, name), contents);
  const compiled = spawnSync(java("javac"), ["-encoding", "UTF-8", "-d", directory, ...files.map(([name]) => path.join(directory, name))],
    { encoding: "utf8", timeout: 30000 });
  assert.equal(compiled.status, 0, compiled.error?.message || compiled.stderr);
  return directory;
}
function run(directory, ...args) {
  return spawnSync(java("java"), ["-Dstdout.encoding=UTF-8", "-Dstderr.encoding=UTF-8", "-cp", directory, "local.fanhao.library.NativeTextReadVerifier", ...args],
    { encoding: "utf8", timeout: 15000 });
}
function green(result, label) { assert.equal(result.status, 0, label + "\n" + (result.error?.message || result.stderr)); }
function red(result, expected, label) {
  assert.notEqual(result.status, 0, label + " falsely passed");
  assert.ok(!result.error && result.status !== null, label + " must fail an assertion, not timeout");
  assert.match(result.stderr, /AssertionError/, label + " must fail a behavioral assertion");
  assert.match(result.stderr, expected, label + " failed an unrelated assertion\n" + result.stderr);
}
function once(text, before, after) {
  assert.equal(text.split(before).length, 2, "mutant anchor must be unique: " + before);
  return text.replace(before, after);
}
function editMethod(name, transform) {
  const blocks = methodBlocks.get(name); assert.equal(blocks.length, 1, "mutant must identify unique overload");
  const changed = transform(blocks[0]); assert.notEqual(changed, blocks[0], "mutant did not edit " + name);
  return { ...actual, harness: once(actual.harness, blocks[0], changed) };
}
function methodReplace(name, before, after) { return editMethod(name, (block) => once(block, before, after)); }
function omitOOM(name) {
  return editMethod(name, (block) => {
    const pattern = / catch \(OutOfMemoryError error\) \{\n[^\n]*\n[ ]+\}/g;
    assert.equal([...block.matchAll(pattern)].length, 1, "one OOM catch in " + name);
    return block.replace(pattern, "");
  });
}
try {
  const directory = compile(actual);
  const result = run(directory); green(result, "production"); process.stdout.write(result.stdout);

  // Immutable historical bodies/fixture frozen before the production fix.
  // Execute every original observation, then require explicit safety assertions
  // against those same compiled historical methods to fail (not compile errors).
  const frozen = JSON.parse(fs.readFileSync(path.join(root, "tools/fixtures/native-text-reads-before-fix.json"), "utf8"));
  const legacyCheck = fs.readFileSync(path.join(root, "tools/fixtures/NativeTextReadLegacyAssertions.java"), "utf8");
  const legacyHarness = frozen.fixture.replace("  /* PRODUCTION_METHODS */", frozen.methods)
    .replace("  public static void main(String[] args) throws Exception {",
      legacyCheck + "\n  public static void main(String[] args) throws Exception {\n    if (args.length > 0) { legacySafetyCheck(args[0]); return; }");
  const legacyDirectory = compile({ harness: legacyHarness, reader: frozen.boundedReader, queue: actual.queue });
  const legacy = run(legacyDirectory); green(legacy, "frozen 13 observations");
  assert.equal((legacy.stdout.match(/native-text-read-observation:/g) || []).length, 13, "all frozen observations execute");
  process.stdout.write(legacy.stdout);
  for (const mode of ["zero", "overflow", "inline-size", "inline-limit", "consume-OOM", "scanned-OOM"]) {
    red(run(legacyDirectory, mode), /legacy .* (safety|settlement) absent/, "historical " + mode);
  }
  console.log("native-text-reads: 13 frozen observations + 6 compiled historical red assertions passed");

  const mutants = [];
  const add = (label, bundle, mode, expected) => mutants.push({ label, bundle, mode, expected });
  const reader = (before, after) => ({ ...actual, reader: once(actual.reader, before, after) });
  add("read-request-ignores-remaining", reader("Math.min(buffer.length, maximumBytes - total + 1L)", "buffer.length"), "bounded", /every request obeys remaining\+1|provider reads at most/);
  add("zero-threshold-late", reader("++emptyReads >= 8", "++emptyReads >= 9"), "bounded", /exact eight-zero threshold/);
  add("zero-progress-not-reset", reader("      emptyReads = 0;", "      // missing reset"), "bounded", /progress resets zero streak|文本提供方未返回内容/);
  add("invalid-negative-read-accepted", reader("read < -1 || read > requested", "read > requested"), "bounded", /invalid provider read count -2/);
  add("invalid-large-read-accepted", reader("read < -1 || read > requested", "read < -1"), "bounded", /invalid provider read count 66/);
  add("maximum-upper-bound-missing", { ...actual, reader: actual.reader.replaceAll("maximumBytes > Integer.MAX_VALUE - 8L", "maximumBytes > Long.MAX_VALUE") }, "bounded", /invalid read maximum/);
  add("inline-counts-characters", methodReplace("readIntentText", "NativeTextDecoder.utf8Size(sharedText, MAX_TEXT_BYTES)", "sharedText.length()"), "inline", /inline reports UTF-8 bytes/);
  add("inline-limit-bypassed", methodReplace("readIntentText", "NativeTextDecoder.utf8Size(sharedText, MAX_TEXT_BYTES)", "NativeTextDecoder.utf8Size(sharedText, Long.MAX_VALUE)"), "inline", /inline limit or surrogate rejected/);
  add("inline-char-preflight-missing", methodReplace("readIntentText", "        BoundedTextReader.requireAllowedKnownSize(text.length(), MAX_TEXT_BYTES);\n", ""), "inline", /inline length preflight/);
  add("intent-content-guard-missing", methodReplace("readIntentText", "if (!isContentUri(uri))", "if (false && !isContentUri(uri))"), "inline", /invalid Intent rejected before any provider access/);
  for (const name of ["readScannedTextFile", "readPickedTextFile"]) {
    add(name + "-content-guard-missing", methodReplace(name, "if (!isContentUriString(rawUri))", "if (false && !isContentUriString(rawUri))"), "metadata", /invalid read API rejected before any provider access/);
    add(name + "-OOM-catch-missing", omitOOM(name), "oom", /worker escaped without settling/);
  }
  add("consume-OOM-catch-missing", omitOOM("consumePendingTextFile"), "oom", /consume failure never escapes/);
  add("picker-OOM-catch-missing", omitOOM("textDocumentPickerResult"), "picker", /picker worker escaped without settling/);
  add("picked-required-metadata", methodReplace("readPickedTextFile", "queryOptionalDocumentMetadata(resolver, uri)", "queryDocumentMetadata(resolver, uri)"), "metadata", /optional metadata variant/);
  add("fallback-size-discarded", methodReplace("queryOptionalDocumentMetadata", "new DocumentMetadata(sizeKnown ? cursorLong(cursor, OpenableColumns.SIZE) : -1L, sizeKnown, false)", "new DocumentMetadata(-1L, false, false)"), "metadata", /SIZE-only fallback preserves known-size rejection/);
  add("picked-virtual-ignored", methodReplace("readPickedTextFile", "if (metadata.virtual)", "if (false && metadata.virtual)"), "metadata", /virtual rejected/);
  add("picked-known-size-ignored", methodReplace("readPickedTextFile", "if (metadata.sizeKnown)", "if (false && metadata.sizeKnown)"), "metadata", /known or actual oversize rejects/);
  add("picked-reports-metadata-size", methodReplace("readPickedTextFile", "decoded.text, bytes.length,", "decoded.text, metadata.sizeBytes,"), "metadata", /stale metadata uses actual byte count/);
  add("deferred-callback-reads-eagerly", methodReplace("textDocumentPickerResult", "if (deferredRead) {", "if (false && deferredRead) {"), "picker", /picker worker escaped without settling/);
  add("deferred-protocol-key-typo", methodReplace("textDocumentPickerResult", 'getBoolean("deferredRead", false)', 'getBoolean("deferredReads", false)'), "picker", /picker worker escaped without settling/);
  add("picker-URI-dedup-removed", methodReplace("textDocumentPickerResult", "LinkedHashSet<Uri> uris = new LinkedHashSet<>();", "ArrayList<Uri> uris = new ArrayList<>();"), "picker", /deferred URI dedup/);
  add("picker-file-error-hidden", methodReplace("textDocumentPickerResult", "errors.put(failed);", "// missing per-file error"), "picker", /invalid URI\/type per-file errors|ordinary failure reported/);
  add("stream-owner-close-removed", methodReplace("readAllBytes",
    "try (InputStream input = resolver.openInputStream(uri)) {\n      return BoundedTextReader.read(input, MAX_TEXT_BYTES);\n    }",
    "InputStream input = resolver.openInputStream(uri);\n    return BoundedTextReader.read(input, MAX_TEXT_BYTES);"), "inline", /try-resources failure/);
  add("failed-claim-not-completed", methodReplace("consumePendingTextFile", "      pendingTextIntents.complete(claim);", "      // missing completion"), "oom", /failure releases claim/);
  add("consume-error-message-hidden", methodReplace("consumePendingTextFile", 'unavailableResult(message == null || message.trim().isEmpty() ? "读取本地文本失败" : message)', 'unavailableResult("")'), "oom", /consume failure message/);
  add("stale-A-clears-B", methodReplace("clearPendingIntent", "      if (activity.getIntent() != consumedIntent) return;", "      // missing identity guard"), "oom", /A cleanup preserves newer Activity fallback B/);
  for (const mutant of mutants) {
    const changedDirectory = compile(mutant.bundle);
    red(run(changedDirectory, mutant.mode), mutant.expected, mutant.label);
    console.log("native-text-reads mutant rejected: " + mutant.label);
  }
  console.log("native-text-reads: " + mutants.length + " compiled behavioral mutants rejected; " + names.length + " plugin method names (" + [...methodBlocks.values()].flat().length + " bodies) compiled");
} finally {
  const exact = fs.realpathSync(temporary), parent = fs.realpathSync(os.tmpdir());
  assert.equal(path.dirname(exact).toLowerCase(), parent.toLowerCase());
  assert.ok(path.basename(exact).startsWith("fanhao-native-text-reads-"));
  if (process.platform === "win32") {
    const clean = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
      "Remove-Item -LiteralPath '" + exact.replaceAll("'", "''") + "' -Recurse -Force"], { encoding: "utf8", timeout: 10000 });
    assert.equal(clean.status, 0, clean.stderr);
  } else fs.rmSync(exact, { recursive: true, force: true });
}
