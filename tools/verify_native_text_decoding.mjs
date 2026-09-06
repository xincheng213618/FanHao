import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const root = path.resolve(import.meta.dirname, "..");
const nativeRoot = path.join(root, "android-client/android/app/src/main/java/local/fanhao/library");
const fixtures = path.join(root, "tools/fixtures/native-text-decoding");
const javaHome = String(process.env.JAVA_HOME || "").trim();
const executable = (name) => javaHome && fs.existsSync(path.join(javaHome, "bin", `${name}.exe`)) ? path.join(javaHome, "bin", `${name}.exe`) : name;
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "fanhao-native-text-decoding-"));
const regressions = ["utf8-bom-truncated-payload", "utf8-bom-illegal-continuation", "utf8-bom-surrogate", "utf16le-odd-payload", "utf16be-odd-payload", "utf16le-unpaired-high", "utf16le-unpaired-low", "utf16be-unpaired-high", "utf16be-unpaired-low", "gb18030-unfinished-lead", "gb18030-unfinished-four-byte", "gb18030-illegal-trail", "utf32le-bom"];

function execute(directory, ...args) {
  return spawnSync(executable("java"), ["-cp", directory, "local.fanhao.library.NativeTextDecodingHarness", ...args], { encoding: "utf8", timeout: 20000 });
}
function method(source, name) {
  const found = new RegExp(`^  (?:(?:private|public|protected|static|final) )*[\\w.<>]+ ${name}\\(`, "m").exec(source);
  assert.ok(found, `method missing: ${name}`);
  const start = found.index, body = source.indexOf("{", start);
  let depth = 0, quote = null, line = false, block = false;
  for (let index = body; index < source.length; index++) {
    const char = source[index], next = source[index + 1];
    if (line) { if (char === "\n") line = false; continue; }
    if (block) { if (char === "*" && next === "/") { block = false; index++; } continue; }
    if (quote) { if (char === "\\") index++; else if (char === quote) quote = null; continue; }
    if (char === "/" && next === "/") { line = true; index++; continue; }
    if (char === "/" && next === "*") { block = true; index++; continue; }
    if (char === "\"" || char === "'") { quote = char; continue; }
    if (char === "{") depth++;
    if (char === "}" && --depth === 0) return source.slice(start, index + 1);
  }
  throw new Error(`method body unclosed: ${name}`);
}
function compile(directory, decoderSource, pluginMethod) {
  fs.mkdirSync(directory, { recursive: true });
  const template = fs.readFileSync(path.join(fixtures, "NativeTextDecodingHarness.java"), "utf8");
  const generated = path.join(directory, "NativeTextDecodingHarness.java"), decoder = path.join(directory, "NativeTextDecoder.java");
  const harness = template.replace("/* PLUGIN_HOST */", `class PluginDecodeHost {\n${pluginMethod.replace("private ", "")}\n}`)
    .replace("/* PLUGIN_CHECKS */", `
    PluginDecodeHost plugin = new PluginDecodeHost();
    NativeTextDecoder.Result delegated = plugin.decodeText(hex("EF BB BF 41 E4 B8 AD F0 9F 98 80"));
    check(delegated.encoding.equals("utf-8-sig") && delegated.text.equals("A中😀"), "actual plugin decoder delegates exact helper result");
    reject(() -> plugin.decodeText(hex("EF BB BF 41 E2 82")), "actual plugin decoder forwards strict error");
    `);
  fs.writeFileSync(generated, harness); fs.writeFileSync(decoder, decoderSource);
  const result = spawnSync(executable("javac"), ["-encoding", "UTF-8", "-d", directory, path.join(fixtures, "LegacyNativeTextDecoder.java"), decoder, generated], { encoding: "utf8", timeout: 30000 });
  assert.equal(result.status, 0, result.error?.message || `${result.stdout}\n${result.stderr}`);
}
function verifyWiring(plugin, decoder) {
  const delegated = method(plugin, "decodeText");
  assert.match(delegated, /private NativeTextDecoder\.Result decodeText\(byte\[\] bytes\)/, "decoder result type must stay shared");
  assert.match(delegated, /return NativeTextDecoder\.decode\(bytes\);/, "plugin must delegate unchanged bytes to strict helper");
  assert.doesNotMatch(delegated, /new String|catch\s*\(/, "plugin must not replace or swallow strict decoder errors");
  assert.doesNotMatch(plugin, /\bDecodedText\b/, "legacy replacement decoder class must not remain wired");
  for (const name of ["readScannedTextFile", "readPickedTextFile", "textDocumentPickerResult", "readIntentText"]) {
    const source = method(plugin, name);
    assert.match(source, /NativeTextDecoder\.Result decoded = decodeText\(bytes\);/, `${name} must use strict decoding`);
    assert.match(source, /decoded\.encoding\s*,\s*decoded\.text/, `${name} must return the exact decoder result`);
  }
  for (const name of ["exportTextFile", "exportTextFileResult"]) {
    const source = method(plugin, name), validation = source.indexOf("NativeTextDecoder.utf8Size("), allocation = source.indexOf(".getBytes(");
    assert.ok(validation >= 0, `${name} must validate Unicode and byte budget`);
    assert.match(source, /NativeTextDecoder\.utf8Size\(text, MAX_TEXT_BYTES\)/, `${name} must keep the bounded UTF8 budget`);
    assert.ok(allocation < 0 || validation < allocation, `${name} must validate before allocating encoded bytes`);
  }
  const inline = method(plugin, "readIntentText");
  assert.ok(inline.indexOf("NativeTextDecoder.utf8Size(") >= 0 && inline.indexOf("NativeTextDecoder.utf8Size(") < inline.indexOf('textResult("shared-text.txt"'), "inline share must size before success");
  assert.match(inline, /long sizeBytes = NativeTextDecoder\.utf8Size\(sharedText, MAX_TEXT_BYTES\);/, "inline share must count actual UTF8 bytes");
  assert.match(inline, /textResult\("shared-text\.txt", "text\/plain", "utf-8", sharedText, sizeBytes, ""\)/, "inline result must expose byte count, not UTF16 length");
  assert.ok(inline.indexOf("BoundedTextReader.requireAllowedKnownSize(text.length(), MAX_TEXT_BYTES)") >= 0
    && inline.indexOf("BoundedTextReader.requireAllowedKnownSize(text.length(), MAX_TEXT_BYTES)") < inline.indexOf("text.toString()"), "inline share must bound CharSequence before copying");
  assert.doesNotMatch(method(decoder, "utf8Size"), /getBytes\s*\(|new byte\s*\[|ByteBuffer/, "UTF8 preflight must not allocate encoded byte arrays");
  assert.match(method(decoder, "decodeStrict"), /onMalformedInput\(CodingErrorAction\.REPORT\)/, "strict decoder must report malformed bytes");
  assert.match(method(decoder, "decodeStrict"), /onUnmappableCharacter\(CodingErrorAction\.REPORT\)/, "strict decoder must report unmappable bytes");
}
try {
  const decoder = fs.readFileSync(path.join(nativeRoot, "NativeTextDecoder.java"), "utf8");
  const plugin = fs.readFileSync(path.join(nativeRoot, "FanHaoNovelPlugin.java"), "utf8");
  const pluginMethod = method(plugin, "decodeText");
  verifyWiring(plugin, decoder);
  compile(temporary, decoder, pluginMethod);
  const positive = execute(temporary); assert.equal(positive.status, 0, positive.error?.message || `${positive.stdout}\n${positive.stderr}`); process.stdout.write(positive.stdout);
  for (const regression of regressions) {
    const negative = execute(temporary, regression);
    assert.notEqual(negative.status, 0, `old decoder unexpectedly passed safety assertion: ${regression}`);
    assert.match(negative.stderr, /AssertionError: old decoder must reject/, `unrelated legacy failure: ${negative.stderr}`);
  }
  process.stdout.write(`native-text-decoding-legacy-red-controls: ${regressions.length} compiled old decoder failures reproduced\n`);
  const behavioral = [
    ["replacement-instead-of-report", ".onMalformedInput(CodingErrorAction.REPORT)", ".onMalformedInput(CodingErrorAction.REPLACE)"],
    ["lenient-gb-fallback", 'decodeStrict(bytes, 0, Charset.forName("GB18030"))', 'new String(bytes, Charset.forName("GB18030"))'],
    ["lenient-bom-utf8", "decodeStrict(bytes, 3, StandardCharsets.UTF_8)", "new String(bytes, 3, bytes.length - 3, StandardCharsets.UTF_8)"],
    ["wrong-utf16-endian", "decodeStrict(bytes, 2, StandardCharsets.UTF_16LE)", "decodeStrict(bytes, 2, StandardCharsets.UTF_16BE)"],
    ["utf32-falls-through-to-utf16", "startsWith(bytes, 0xff, 0xfe, 0x00, 0x00) || startsWith(bytes, 0x00, 0x00, 0xfe, 0xff)", "false"],
    ["strip-literal-replacement-character", "this.text = text;", 'this.text = text.replace("\\uFFFD", "");'],
    ["retain-leading-bom", "decodeStrict(bytes, 3, StandardCharsets.UTF_8)", "decodeStrict(bytes, 0, StandardCharsets.UTF_8)"],
    ["prefer-gb-over-valid-utf8", 'new Result("utf-8", decodeStrict(bytes, 0, StandardCharsets.UTF_8))', 'new Result("utf-8", decodeStrict(bytes, 0, Charset.forName("GB18030")))'],
    ["supplementary-counts-three", "width = 4;", "width = 3;"],
    ["do-not-consume-surrogate-pair", "index += 1;\n        width = 4;", "index += 0;\n        width = 4;"],
    ["accept-isolated-low-surrogate", "else if (Character.isLowSurrogate(value))", "else if (false)"],
    ["accept-invalid-size-limit", "maximumBytes < 1L", "false"],
    ["ignore-size-budget", "size > maximumBytes - width", "false"],
    ["reject-inclusive-byte-limit", "size > maximumBytes - width", "size >= maximumBytes - width"],
    ["return-utf16-length", "return size;", "return text.length();"],
  ];
  const normalizedDecoder = decoder.replaceAll("\r\n", "\n");
  for (const [name, from, to] of behavioral) {
    assert.ok(normalizedDecoder.includes(from), `behavior mutation missing: ${name}`);
    const destination = path.join(temporary, name);
    compile(destination, normalizedDecoder.replace(from, to), pluginMethod);
    const result = execute(destination);
    assert.notEqual(result.status, 0, `full decoder mutant unexpectedly passed: ${name}`);
    assert.match(result.stderr, /AssertionError:/, `unrelated decoder mutant failure ${name}: ${result.stderr}`);
  }
  process.stdout.write(`native-text-decoding-behavior-mutants: ${behavioral.length} complete compiled helper regressions rejected\n`);
  const wiring = [];
  const mutateMethod = (name, from, to) => {
    const target = method(plugin, name); assert.ok(target.includes(from), `wiring mutation target missing: ${name}/${from}`);
    return plugin.replace(target, target.replace(from, to));
  };
  for (const name of ["readScannedTextFile", "readPickedTextFile", "textDocumentPickerResult", "readIntentText"])
    wiring.push([`${name}-decode-disconnected`, mutateMethod(name, "decodeText(bytes)", "null"), decoder]);
  for (const name of ["exportTextFile", "exportTextFileResult"])
    wiring.push([`${name}-preflight-disconnected`, mutateMethod(name, "NativeTextDecoder.utf8Size(text, MAX_TEXT_BYTES)", "NativeTextDecoder.utf8Size(text, Long.MAX_VALUE)"), decoder]);
  wiring.push(["inline-byte-size-disconnected", mutateMethod("readIntentText", "NativeTextDecoder.utf8Size(sharedText, MAX_TEXT_BYTES)", "sharedText.length()"), decoder]);
  wiring.push(["inline-response-uses-char-count", mutateMethod("readIntentText", "sharedText, sizeBytes", "sharedText, sharedText.length()"), decoder]);
  wiring.push(["inline-copy-before-size-bound", mutateMethod("readIntentText", "BoundedTextReader.requireAllowedKnownSize(text.length(), MAX_TEXT_BYTES);", "/* missing pre-copy bound */"), decoder]);
  wiring.push(["plugin-helper-disconnected", mutateMethod("decodeText", "NativeTextDecoder.decode(bytes)", "NativeTextDecoder.decode(new byte[0])"), decoder]);
  wiring.push(["preflight-allocates-byte-array", plugin, decoder.replace("return size;", "return text.getBytes(StandardCharsets.UTF_8).length;")]);
  wiring.push(["unmappable-replacement-enabled", plugin, decoder.replace("onUnmappableCharacter(CodingErrorAction.REPORT)", "onUnmappableCharacter(CodingErrorAction.REPLACE)")]);
  for (const [name, changedPlugin, changedDecoder] of wiring)
    assert.throws(() => verifyWiring(changedPlugin, changedDecoder), { name: "AssertionError" }, `static wiring mutant unexpectedly passed: ${name}`);
  process.stdout.write(`native-text-decoding-wiring-mutants: ${wiring.length} static integration regressions rejected\n`);
} finally {
  const resolved = fs.realpathSync(temporary), parent = fs.realpathSync(os.tmpdir());
  assert.equal(path.dirname(resolved).toLowerCase(), parent.toLowerCase());
  assert.ok(path.basename(resolved).startsWith("fanhao-native-text-decoding-"));
  if (process.platform === "win32") {
    const cleaned = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `Remove-Item -LiteralPath '${resolved.replaceAll("'", "''")}' -Recurse -Force`], { encoding: "utf8", timeout: 15000 });
    assert.equal(cleaned.status, 0, cleaned.stderr);
  } else fs.rmSync(resolved, { recursive: true, force: true });
}
