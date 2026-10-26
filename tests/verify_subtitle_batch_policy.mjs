import assert from "node:assert/strict";
import { hasChineseFilename, looksChineseSubtitle, chooseChineseCandidates, workQuery, subtitleEditionConflict, normalizeSubtitleBatchPart } from "../lib/subtitle-batch-policy.js";

let checks = 0;
function check(name, callback) { try { callback(); checks++; } catch (error) { console.error(`subtitle batch policy failed: ${name}`); throw error; } }
const video = (name, id = name) => ({ name, id });
const file = (name, language = "zh-CN", id = name) => ({ id, name, language });
const result = (title, id = title) => ({ title, id });
const vtt = (body) => `WEBVTT\n\ncue-id\n00:00:01.000 --> 00:00:09.000\n${body}\n`;
const chinese = "这是我们为你准备的中文字幕，你可以在这里看到完整的对话和故事。";

check("actual filename Chinese markers and glued UC remain distinct", () => {
  for (const name of ["AB-123-C.mp4", "AB-123C.mp4", "AB-123.chs.mkv", "AB-123.cht.mp4", "AB-123.zh_CN.mp4", "AB-123.zh-Hant.mp4", "AB-123[中文字幕].mp4"]) assert.equal(hasChineseFilename(video(name)), true, name);
  for (const name of ["AB-123UC.mp4", "AB-123-UC.mp4", "AB-123-U.mp4", "AB-123-SUCH.mp4", "AB-123-jp.mp4"]) assert.equal(hasChineseFilename(video(name)), false, name);
});
check("online subtitle flags and unrelated metadata never make local files Chinese", () => {
  assert.equal(hasChineseFilename(video("AB-123.mp4"), { infoSummary: { tags: ["中文字幕"] }, availability: { hasSubtitles: true }, tags: ["中字"], directoryName: "中文" }), false);
  assert.equal(hasChineseFilename({ path: "G:\\中文字幕\\AB-123.mp4" }, { availability: { has_subtitles: true } }), false);
});
check("only an immediate single-video directory can supply a Chinese filename marker", () => {
  const one = video("AB-123.mp4");
  assert.equal(hasChineseFilename(one, { videos: [one], directoryName: "[A] AB-123 中文字幕" }), true);
  assert.equal(hasChineseFilename(one, { videos: [one, video("AB-123-CD2.mp4")], directoryName: "[A] 中文字幕" }), false);
  assert.equal(hasChineseFilename(one, { videos: [one], directoryName: "G:\\中文字幕\\AB-123" }), false);
  assert.equal(hasChineseFilename(one, { videoCount: 1, directoryName: "AB-123.chs" }), true);
});
check("queries prioritize actual release filename over incorrect metadata", () => {
  assert.equal(workQuery(video("site.example@MIDA-744U.mp4"), { infoSummary: { code: "人物名" }, directoryName: "人物名" }), "MIDA-744");
  assert.equal(workQuery(video("AB-123UC.mp4"), { code: "ZZ-999" }), "AB-123");
  assert.equal(workQuery(video("movie.mp4"), { infoSummary: { code: "AB-123" } }), "AB-123");
  assert.equal(workQuery(video("movie.mp4"), { infoSummary: { code: "人物名" }, code: "CD-456" }), "CD-456");
  assert.equal(workQuery(video("movie.mp4"), { directoryName: "[A] EF-789" }), "EF-789");
  assert.equal(workQuery(video("AB-123 plus CD-456.mp4"), { code: "AB-123" }), "");
});
check("Chinese recognition requires real cue dialogue rather than headers or ids", () => {
  assert.equal(looksChineseSubtitle(vtt(chinese)), true);
  assert.equal(looksChineseSubtitle(vtt("這是我們為你準備的中文字幕，你可以在這裡看到完整的對話和故事。")), true);
  assert.equal(looksChineseSubtitle(`WEBVTT ${chinese}\n\nNOTE ${chinese}\n\n${chinese}\n00:00:01.000 --> 00:00:02.000\nHello world\n`), false);
  assert.equal(looksChineseSubtitle(`WEBVTT\n\nSTYLE\n::cue { content: '${chinese}'; }\n\nREGION\n${chinese}\n\n${vtt("hello").replace("WEBVTT\n\n", "")}`), false);
  assert.equal(looksChineseSubtitle(vtt(`<b>${chinese}</b>`)), true);
});
check("empty, Japanese, Korean, sparse Han and mostly English are not accepted", () => {
  for (const text of ["", "WEBVTT\n\n", "not a subtitle", vtt("你好"), vtt("私は日本語の字幕を読んでいます。これは中国語ではありません。"), vtt("東京映画字幕作品特別編集完全版上映会"), vtt("우리는 한국어 자막을 읽고 있습니다"), vtt(`${chinese} あ`), vtt(`${chinese} ${"This is an English subtitle. ".repeat(20)}`)]) assert.equal(looksChineseSubtitle(text), false, text);
});
check("raw SRT bytes and rare retained foreign names in long Chinese dialogue are supported", () => {
  const srt = `1\n00:00:01,000 --> 00:00:09,000\n${chinese}\n`;
  assert.equal(looksChineseSubtitle(srt), true);
  assert.equal(looksChineseSubtitle(Buffer.from(srt)), true);
  assert.equal(looksChineseSubtitle(new Uint8Array(Buffer.from(srt))), true);
  const gb = Buffer.concat([Buffer.from("1\n00:00:01,000 --> 00:00:09,000\n"), Buffer.from("c4e3bac3".repeat(12), "hex")]);
  assert.equal(looksChineseSubtitle(gb), true);
  assert.equal(looksChineseSubtitle(vtt(`${chinese.repeat(60)} テスト`)), true, "isolated retained names must not reject otherwise Chinese machine translations");
});
check("candidate ranking prefers simplified, then match quality, then traditional", () => {
  const target = video("AB-123.mp4"), page = result("AB-123 release");
  const files = [file("AB-123.cht.srt", "zh-TW", "traditional"), file("AB-123-4K.chs.srt", "zh-Hans", "code"), file("AB-123.srt", "zh-CN", "exact"), file("AB-123.chs.srt", "zh-CN", "language"), file("AB-123.zh.srt", "zh", "generic")];
  const candidates = chooseChineseCandidates(target, [target], [page], new Map([[page.id, { files }]]));
  assert.deepEqual(candidates.map(({ file: item }) => item.id), ["exact", "language", "code", "traditional", "generic"]);
  assert.deepEqual(candidates.map(({ match }) => match), ["exact", "language", "code", "language", "language"]);
});
check("both title and filename must contain exactly the current release code", () => {
  const target = video("AB-123.mp4");
  const pages = [result("AB-1234"), result("AB-123 AB-124"), result("AB-123", "good")];
  const map = new Map(pages.map((page) => [page.id, { files: [file("AB-123.chs.srt"), file("AB-1234.chs.srt"), file("AB-123 CD-456.chs.srt"), file("other.srt"), file("AB-123.zh.srt", "ja"), file("AB-123.zh.srt", "zh_CN")] }]));
  const candidates = chooseChineseCandidates(target, [target], pages, map);
  assert.equal(candidates.length, 1); assert.equal(candidates[0].result.id, "good"); assert.equal(candidates[0].file.name, "AB-123.chs.srt");
});
check("split volumes reject generic and wrong parts while preserving explicit matches", () => {
  const parts = [video("AB-123-CD1.mp4"), video("AB-123-CD2.mp4")], page = result("AB-123");
  const files = [file("AB-123.chs.srt"), file("AB-123-CD1.chs.srt"), file("AB-123-CD2.chs.srt")];
  const selected = chooseChineseCandidates(parts[1], parts, [page], new Map([[page.id, { files }]]));
  assert.deepEqual(selected.map(({ file: item }) => item.name), ["AB-123-CD2.chs.srt"]);
});
check("multiple versions require exact filename evidence and do not accept generic code", () => {
  const versions = [video("AB-123-U.mp4"), video("AB-123-4K.mp4")], page = result("AB-123");
  const files = [file("AB-123.chs.srt"), file("AB-123-U.chs.srt"), file("AB-123-4K.chs.srt")];
  const selected = chooseChineseCandidates(versions[0], versions, [page], new Map([[page.id, { files }]]));
  assert.deepEqual(selected.map(({ file: item }) => item.name), ["AB-123-U.chs.srt"]);
  assert.deepEqual(chooseChineseCandidates(video("AB-123-CD1.mp4"), [video("AB-123-CD1.mp4")], [page], new Map([[page.id, { files: [files[0]] }]])), []);
});
check("selection is deterministic, deduplicated and never mutates supplied values", () => {
  const target = video("MIDA-744U.mp4"), page = result("MIDA-744"), subtitle = file("MIDA-744.chs.srt");
  const pages = [page, page], files = [subtitle, subtitle], map = new Map([[page.id, { files }]]);
  const before = JSON.stringify({ target, pages, files });
  assert.equal(chooseChineseCandidates(target, [], pages, map).length, 1);
  assert.equal(JSON.stringify({ target, pages, files }), before);
  assert.deepEqual(chooseChineseCandidates(video("AB-123 CD-456.mp4"), [], pages, map), []);
});

check("explicit opposite editions never pass same-code matching, including source pages", () => {
  const choose = (targetName, pageName, fileName) => {
    const target = video(targetName), page = result(pageName);
    return chooseChineseCandidates(target, [target], [page], new Map([[page.id, { files: [file(fileName)] }]]));
  };
  for (const [target, subtitle] of [["AB-123-U.mp4", "AB-123-CENSORED.chs.srt"], ["AB-123-CENSORED.mp4", "AB-123-UC.chs.srt"], ["AB-123UC.mp4", "AB-123-CENSORED.chs.srt"], ["AB-123-AI.mp4", "AB-123-U.chs.srt"], ["AB-123-UNCENSORED.mp4", "AB-123-AI.chs.srt"]]) {
    assert.deepEqual(choose(target, "AB-123", subtitle), [], `${target}/${subtitle}`);
  }
  assert.deepEqual(choose("AB-123-UC.mp4", "AB-123 CENSORED", "AB-123-UC.chs.srt"), []);
  assert.deepEqual(choose("AB-123.mp4", "AB-123 CENSORED", "AB-123-UC.chs.srt"), []);
  assert.equal(choose("AB-123-U.mp4", "AB-123 UNCENSORED", "AB-123-UC.chs.srt").length, 1);
  assert.equal(choose("AB-123UC.mp4", "AB-123", "AB-123-C.chs.srt").length, 1, "C is Chinese, not CENSORED");
  assert.equal(subtitleEditionConflict("AB-123UC", "AB-123-C"), false);
  assert.equal(subtitleEditionConflict("AB-123 U", "AB-123 UNCENSORED"), false);
  for (const uncensored of ["U", "UC", "UN", "UNCENSORED", "AI"]) {
    assert.equal(subtitleEditionConflict("AB-123 CENSORED", `AB-123 ${uncensored}`), true);
    assert.equal(subtitleEditionConflict(`AB-123 ${uncensored}`, "AB-123 CENSORED"), true);
  }
  assert.deepEqual(choose("AB-123-U.mp4", "AB-123 CENSORED / release", "AB-123-U.chs.srt"), []);
});
check("zero-padded parts are normalized on copies and cannot consume a whole movie", () => {
  const parts = [video("AB-123-01.mp4"), video("AB-123-02.mp4")], page = result("AB-123");
  const files = [file("AB-123.chs.srt"), file("AB-123-01.chs.srt"), file("AB-123-CD2.chs.srt"), file("AB-123-02.chs.srt")];
  const before = JSON.stringify({ parts, files });
  const selected = chooseChineseCandidates(parts[0], parts, [page], new Map([[page.id, { files }]]));
  assert.deepEqual(selected.map(({ file: item }) => item.name), ["AB-123-01.chs.srt"]);
  assert.deepEqual(chooseChineseCandidates(parts[1], parts, [page], new Map([[page.id, { files: [files[0], files[1]] }]])), []);
  assert.deepEqual(chooseChineseCandidates(parts[0], [parts[0]], [page], new Map([[page.id, { files: [files[0]] }]])), []);
  assert.equal(JSON.stringify({ parts, files }), before);
  assert.equal(normalizeSubtitleBatchPart(video("AB-001.mp4")).name, "AB-001.mp4");
  assert.equal(normalizeSubtitleBatchPart(video("AB-123-01.zh-CN.srt")).name, "AB-123-CD1.zh-CN.srt");
  assert.deepEqual(chooseChineseCandidates(video("movie.mp4"), [video("movie.mp4")], [page], new Map([[page.id, { files }]])), [], "metadata-only generic names remain manual");
});
check("bilingual Chinese dialogue across cues counts, isolated Chinese credits do not", () => {
  const cue = (index, body) => `${index}\n00:00:${String(index).padStart(2, "0")},000 --> 00:00:${String(index + 1).padStart(2, "0")},000\n${body}\n`;
  const english = "This is the English translation of the dialogue for this scene, with additional words.";
  const bilingual = ["这是我们一起回来的地方，你还记得吗？", "我知道你说的话，也请你相信我的选择。", "现在我们可以好好地说话了，这是为什么呢？", "你在这里等着我，我会为你带来好消息。"].map((line, i) => cue(i + 1, `${line}\n${english}`)).join("\n");
  assert.equal(looksChineseSubtitle(bilingual), true);
  assert.equal(looksChineseSubtitle(Array.from({ length: 12 }, (_, i) => cue(i + 1, i === 0 ? `${chinese}\n${english}` : english)).join("\n")), false);
  assert.equal(looksChineseSubtitle(bilingual.replace("这是我们", "これは日本語 这是我们")), false);
});

console.log(`subtitle-batch-policy: ok (${checks} checks: local Chinese evidence, conservative cue language, exact release matching, part/version ambiguity and candidate ranking)`);
