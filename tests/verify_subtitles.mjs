import assert from "node:assert/strict";
import { convertSubtitle, isSubtitleFile, matchSubtitleCandidates, SUBTITLE_LIMITS } from "../lib/subtitles.js";

let checks = 0;
function check(name, callback) {
  try { callback(); } catch (error) { console.error(`subtitles failed: ${name}`); throw error; }
  checks += 1;
}
const srt = "1\r\n00:00:01,250 --> 00:00:02,500\r\nHello, world!\r\n第二行\r\n\r\n2\r\n00:00:03,000 --> 00:00:04,000\r\n下一句\r\n";
const assHeader = "[Script Info]\nScriptType: v4.00+\n[V4+ Styles]\nFormat: Name, Fontname\nStyle: Default,Arial\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n";
const file = (name, id = name) => ({ id, name, path: `G:\\fixture\\${name}` });
function expectError(callback, code, statusCode = 422) {
  assert.throws(callback, (error) => error instanceof Error && error.code === code && error.statusCode === statusCode);
}

check("supported sidecars are exactly SRT ASS SSA VTT", () => {
  for (const name of ["movie.srt", "MOVIE.ASS", "a.SSA", "字幕.vtt"]) assert.equal(isSubtitleFile(name), true);
  for (const name of ["movie.srt.exe", "movie.txt", "movie.srt?x", "ass", null]) assert.equal(isSubtitleFile(name), false);
});
check("SRT timestamps, commas and multiline content", () => {
  const result = convertSubtitle(srt, { name: "movie.srt" });
  assert.equal(result.format, "srt"); assert.equal(result.encoding, "utf-8"); assert.equal(result.cueCount, 2);
  assert.match(result.vtt, /^WEBVTT\n\n1\n00:00:01\.250 --> 00:00:02\.500\nHello, world!\n第二行/);
  assert.ok(result.vtt.endsWith("下一句\n"));
  assert.equal(result.vtt.includes("\r"), false);
});
check("UTF8 BOM and typed array view do not include unrelated backing bytes", () => {
  assert.equal(convertSubtitle(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(srt)])).cueCount, 2);
  const bytes = Buffer.concat([Buffer.from([0xff]), Buffer.from(srt), Buffer.from([0xff])]);
  const view = new Uint8Array(bytes.buffer, bytes.byteOffset + 1, bytes.length - 2);
  assert.deepEqual(convertSubtitle(view), convertSubtitle(srt));
});
check("UTF16LE and UTF16BE BOM are decoded strictly", () => {
  const le = Buffer.from(srt, "utf16le"), be = Buffer.from(le).swap16();
  assert.equal(convertSubtitle(Buffer.concat([Buffer.from([0xff, 0xfe]), le])).encoding, "utf-16le");
  assert.equal(convertSubtitle(Buffer.concat([Buffer.from([0xfe, 0xff]), be])).encoding, "utf-16be");
  assert.match(convertSubtitle(Buffer.concat([Buffer.from([0xfe, 0xff]), be])).vtt, /第二行/);
  expectError(() => convertSubtitle(Buffer.from([0xff, 0xfe, 0x41])), "SUBTITLE_ENCODING");
  expectError(() => convertSubtitle(Buffer.from([0xff, 0xfe, 0, 0])), "SUBTITLE_ENCODING", 415);
  expectError(() => convertSubtitle(Buffer.from([0xef, 0xbb, 0xbf, 0xc3])), "SUBTITLE_ENCODING");
});
check("GB18030 Chinese and ShiftJIS Japanese legacy bytes", () => {
  const timing = Buffer.from("1\n00:00:01,000 --> 00:00:02,000\n");
  const chinese = convertSubtitle(Buffer.concat([timing, Buffer.from("c4e3bac3", "hex")]));
  assert.equal(chinese.encoding, "gb18030"); assert.match(chinese.vtt, /你好/);
  const japanese = convertSubtitle(Buffer.concat([timing, Buffer.from("82b182f182c982bf82cd", "hex")]));
  assert.equal(japanese.encoding, "shift_jis"); assert.match(japanese.vtt, /こんにちは/);
});
check("ASS override tags, drawing and commas preserve readable dialogue", () => {
  const result = convertSubtitle(assHeader + "Dialogue: 0,0:00:01.50,0:00:03.25,Default,,0,0,0,,{\\pos(1,2)\\b1}Hello, world!\\N第二行\\h字幕\nDialogue: 0,0:00:04.00,0:00:05.00,Default,,0,0,0,,{\\p1}m 0 0 l 20 20{\\p0}Visible {\\i1}words\nComment: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,,do not show", { name: "movie.ass" });
  assert.equal(result.format, "ass"); assert.equal(result.cueCount, 2);
  assert.match(result.vtt, /00:00:01\.500 --> 00:00:03\.250\nHello, world!\n第二行 字幕/);
  assert.match(result.vtt, /Visible words/);
  for (const hidden of ["m 0 0", "\\pos", "{\\", "do not show"]) assert.equal(result.vtt.includes(hidden), false);
});
check("SSA and nonstandard Events Format order", () => {
  const ssa = "[Script Info]\nScriptType: v4.00\n[V4 Styles]\n[Events]\nFormat: Marked, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\nDialogue: Marked=0,0:00:01.00,0:00:02.00,Default,,0,0,0,,SSA text";
  assert.equal(convertSubtitle(ssa, { name: "movie.ssa" }).format, "ssa");
  const reordered = "[Events]\nFormat: Start, End, Text, Style\nDialogue: 0:00:01.00,0:00:02.00,hello, world,Default";
  assert.match(convertSubtitle(reordered).vtt, /hello, world/);
});
check("VTT cue identifiers/settings are normalized while styles and notes are omitted", () => {
  const vtt = "WEBVTT\n\nSTYLE\n::cue { background: url(https://example.test); }\n\nNOTE private note\n<script>bad</script>\n\ncustom-id\n00:01.500 --> 00:02.750 align:start position:0%\n<b>hello</b><br>next &amp; line\n\nREGION\nid:r1\n";
  const result = convertSubtitle(vtt, { name: "movie.vtt" });
  assert.equal(result.format, "vtt"); assert.equal(result.cueCount, 1);
  assert.match(result.vtt, /00:00:01\.500 --> 00:00:02\.750\nhello\nnext &amp; line/);
  for (const hidden of ["STYLE", "NOTE", "REGION", "align:", "https:", "private note", "<b>"]) assert.equal(result.vtt.includes(hidden), false);
});
check("dangerous markup and encoded markup cannot become active VTT payload", () => {
  const unsafe = "1\n00:00:01,000 --> 00:00:02,000\n<script>alert(1)</script><img src=x onerror=bad><b>Visible</b> &lt;script&gt;bad2&lt;/script&gt; <svg>bad3</svg> &lt;3 &amp; safe";
  const result = convertSubtitle(unsafe);
  assert.match(result.vtt, /Visible.*&lt;3 &amp; safe/);
  for (const hidden of ["<script", "<img", "onerror", "alert(1)", "bad2", "bad3", "<svg"]) assert.equal(result.vtt.includes(hidden), false);
});
check("offsets clip before-zero cues, preserve milliseconds and sort cue starts", () => {
  const result = convertSubtitle(srt, { offsetSeconds: -2 });
  assert.equal(result.cueCount, 2); assert.match(result.vtt, /00:00:00\.000 --> 00:00:00\.500/);
  const later = convertSubtitle(srt, { offsetSeconds: 0.125 });
  assert.match(later.vtt, /00:00:01\.375 --> 00:00:02\.625/);
  assert.equal(convertSubtitle(srt, { offsetSeconds: -3 }).cueCount, 1);
  const afterLast = convertSubtitle(srt, { offsetSeconds: -10 });
  assert.equal(afterLast.cueCount, 0);
  assert.equal(afterLast.vtt, "WEBVTT\n\n", "seeking beyond all valid cues yields an empty track, not an invalid-source error");
  const unsorted = "1\n00:00:03,000 --> 00:00:04,000\nlater\n\n2\n00:00:01,000 --> 00:00:02,000\nearlier";
  assert.ok(convertSubtitle(unsorted).vtt.indexOf("earlier") < convertSubtitle(unsorted).vtt.indexOf("later"));
});
check("zero-length and reversed cues do not discard valid neighboring dialogue", () => {
  const mixed = "1\n00:00:01,000 --> 00:00:02,000\nkeep first\n\n2\n00:00:03,000 --> 00:00:03,000\nskip zero\n\n3\n00:00:05,000 --> 00:00:04,000\nskip reverse\n\n4\n00:00:06,000 --> 00:00:07,000\nkeep last";
  const result = convertSubtitle(mixed);
  assert.equal(result.cueCount, 2);
  assert.match(result.vtt, /keep first/);
  assert.match(result.vtt, /keep last/);
  assert.equal(result.vtt.includes("skip zero"), false);
  assert.equal(result.vtt.includes("skip reverse"), false);
  const ass = convertSubtitle(assHeader + "Dialogue: 0,0:00:01.00,0:00:01.00,Default,,0,0,0,,skip zero\nDialogue: 0,0:00:03.00,0:00:02.00,Default,,0,0,0,,skip reverse\nDialogue: 0,0:00:04.00,0:00:05.00,Default,,0,0,0,,keep ASS");
  assert.equal(ass.cueCount, 1);
  assert.match(ass.vtt, /keep ASS/);
  assert.equal(ass.vtt.includes("skip"), false);
  expectError(() => convertSubtitle("00:00:01,000 --> 00:00:01,000\nzero\n\n00:00:03,000 --> 00:00:02,000\nreverse"), "SUBTITLE_NO_CUES");
  expectError(() => convertSubtitle(assHeader + "Dialogue: 0,0:00:01.00,0:00:01.00,Default,,0,0,0,,zero"), "SUBTITLE_NO_CUES");
});
check("meaningful parse errors retain HTTP code/status", () => {
  expectError(() => convertSubtitle({}), "SUBTITLE_INVALID_INPUT", 400);
  expectError(() => convertSubtitle(srt, { offsetSeconds: Infinity }), "SUBTITLE_OFFSET", 400);
  expectError(() => convertSubtitle(Buffer.from([])), "SUBTITLE_EMPTY");
  expectError(() => convertSubtitle("not a subtitle"), "SUBTITLE_NO_CUES");
  expectError(() => convertSubtitle("\u0000" + srt), "SUBTITLE_ENCODING");
  expectError(() => convertSubtitle("1\n00:99:00,000 --> 00:99:01,000\ninvalid"), "SUBTITLE_TIME");
  expectError(() => convertSubtitle("1\n00:00:02,000 --> 00:00:01,000\nreverse"), "SUBTITLE_NO_CUES");
  expectError(() => convertSubtitle("[Events]\nFormat: Start, End\nDialogue: 0:00:01,0:00:02"), "SUBTITLE_FORMAT");
  expectError(() => convertSubtitle(assHeader + "Dialogue: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,,{\\p1}m 0 0 l 20 20"), "SUBTITLE_NO_CUES");
});
check("byte, single cue, total cue and generated output limits are enforced", () => {
  expectError(() => convertSubtitle(Buffer.alloc(SUBTITLE_LIMITS.bytes + 1)), "SUBTITLE_TOO_LARGE", 413);
  expectError(() => convertSubtitle("1\n00:00:01,000 --> 00:00:02,000\n" + "x".repeat(SUBTITLE_LIMITS.cueCharacters + 1)), "SUBTITLE_CUE_TOO_LARGE", 413);
  expectError(() => convertSubtitle(assHeader + "Dialogue: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,," + "{".repeat(SUBTITLE_LIMITS.cueCharacters * 4 + 1)), "SUBTITLE_CUE_TOO_LARGE", 413);
  const tinyCue = "00:00:01,000 --> 00:00:02,000\nx\n\n";
  expectError(() => convertSubtitle(tinyCue.repeat(SUBTITLE_LIMITS.cues + 1)), "SUBTITLE_TOO_MANY_CUES", 413);
  const escapedCue = "00:00:01,000 --> 00:00:02,000\n" + "&".repeat(10000) + "\n\n";
  expectError(() => convertSubtitle(escapedCue.repeat(300)), "SUBTITLE_OUTPUT_TOO_LARGE", 413);
});
check("exact/language/code matches are specific to current file", () => {
  const video = file("AB-123.mp4"), sidecar = file("AB-123.zh-CN.srt");
  const matches = matchSubtitleCandidates(video, [video], [file("AB-123.vtt"), sidecar, file("AB-123-4K.en.ass"), file("ZZ-999.chs.srt"), file("notes.txt")]);
  assert.deepEqual(matches.map(({ match }) => match), ["exact", "language", "code", "manual"]);
  assert.strictEqual(matches[1].file, sidecar);
  assert.equal(matches[1].autoSelect, true);
  assert.equal(matches[1].language, "zh-CN");
  assert.equal(matches[2].language, "en");
});
for (const [suffix, language] of [["zh-CN", "zh-CN"], ["chs", "zh-CN"], ["简中", "zh-CN"], ["zh-Hans", "zh-CN"], ["cht", "zh-TW"], ["zh-TW", "zh-TW"], ["繁體", "zh-TW"], ["en", "en"], ["eng", "en"], ["ja", "ja"], ["jpn", "ja"], ["日本語", "ja"]]) {
  check(`language suffix ${suffix}`, () => {
    const video = file("AB-123.mp4"), candidate = file(`AB-123.${suffix}.srt`);
    const [result] = matchSubtitleCandidates(video, [video], [candidate]);
    assert.equal(result.language, language); assert.equal(result.match, "language");
  });
}
check("forced suffix and parent directory do not distort language matching", () => {
  const video = file("AB-123.mp4");
  const [forced] = matchSubtitleCandidates(video, [video], [file("AB-123.chs.forced.srt")]);
  assert.equal(forced.language, "zh-CN"); assert.equal(forced.match, "language");
  const [unknown] = matchSubtitleCandidates(video, [video], [{ id: "other", path: "G:\\zh-CN\\AB-123.srt" }]);
  assert.equal(unknown.language, "und"); assert.equal(unknown.autoSelect, false);
});
check("split volumes are never assigned generic or different-volume tracks", () => {
  const videos = [file("AB-123-CD1.mp4"), file("AB-123-CD2.mp4")];
  const subtitles = [file("AB-123.chs.srt"), file("AB-123-CD1.chs.srt"), file("AB-123-CD2.chs.srt")];
  for (const [index, video] of videos.entries()) {
    const results = matchSubtitleCandidates(video, videos, subtitles);
    assert.equal(results.find(({ file: item }) => item.name === subtitles[0].name).match, "manual");
    assert.equal(results.find(({ file: item }) => item.name === subtitles[1 + index].name).match, "language");
    assert.equal(results.find(({ file: item }) => item.name === subtitles[2 - index].name).match, "manual");
    assert.equal(results.filter(({ autoSelect }) => autoSelect).length, 1);
  }
  assert.equal(matchSubtitleCandidates(videos[0], [videos[0]], [subtitles[0]])[0].match, "manual");
  const taggedPart = file("AB-123-CD1-1080P.mp4");
  assert.equal(matchSubtitleCandidates(taggedPart, [taggedPart], [subtitles[0]])[0].match, "manual");
});
check("bare numbered parts, version ambiguity and multiple Chinese tracks require evidence", () => {
  const parts = [file("AB-123-1.mp4"), file("AB-123-2.mp4")];
  assert.equal(matchSubtitleCandidates(parts[1], parts, [file("AB-123-1.chs.srt")])[0].match, "manual");
  assert.equal(matchSubtitleCandidates(parts[1], parts, [file("AB-123-2.chs.srt")])[0].match, "language");
  const versions = [file("AB-123-U.mp4"), file("AB-123-4K.mp4")];
  assert.equal(matchSubtitleCandidates(versions[0], versions, [file("AB-123.chs.srt")])[0].match, "manual");
  const single = file("AB-123.mp4");
  assert.ok(matchSubtitleCandidates(single, [single], [file("AB-123.chs.srt"), file("AB-123.cht.srt")]).every(({ autoSelect }) => !autoSelect));
});
check("domain-prefixed release names and glued edition tokens share normalized code", () => {
  const video = file("example.test@MIDA-744U.mp4");
  const [result] = matchSubtitleCandidates(video, [video], [file("MIDA-744.chs.srt")]);
  assert.equal(result.match, "code"); assert.equal(result.autoSelect, true);
});
check("matching does not mutate files or manufacture tracks", () => {
  const video = file("AB-123.mp4"), subtitles = [file("other.ja.ass")];
  const before = JSON.stringify({ video, subtitles });
  assert.equal(matchSubtitleCandidates(video, [video], subtitles)[0].match, "manual");
  assert.equal(JSON.stringify({ video, subtitles }), before);
  assert.deepEqual(matchSubtitleCandidates(video, [video], []), []);
});

console.log(`subtitles: ok (${checks} behavior checks: encodings, safe SRT/ASS/SSA/VTT, limits, offsets, matching and volume ambiguity)`);
