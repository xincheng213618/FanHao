import assert from "node:assert/strict";
import { deriveWorkTraits, matchesWorkTraitFilter, summarizeWorkTraits } from "../lib/work-traits.js";

let checks = 0;
function check(name, callback) {
  try { callback(); } catch (error) { console.error(`work-traits failed: ${name}`); throw error; }
  checks += 1;
}
function traitsForName(name, extra = {}) {
  return deriveWorkTraits({ videos: [{ name }], ...extra });
}
function activeFlags(traits) {
  return Object.keys(traits.flags).filter((key) => traits.flags[key]).sort();
}

check("merge real source fields and aliases without changing inputs", () => {
  const work = { infoSummary: { tags: ["單體作品", "眼鏡", "OL"], javdbTags: ["眼镜", "含磁鏈", "可播放"] }, tags: ["美少女電影", "恋爱"], javdbTags: ["戀愛"] };
  const metadata = { tags: ["单体作品", "秘書"], javdbTags: ["絲襪"], trait_tags: ["苗條", "蕩婦"] };
  const before = JSON.stringify({ work, metadata });
  assert.deepEqual(deriveWorkTraits(work, metadata).tags, ["单体作品", "眼镜", "OL", "恋爱", "美少女电影", "秘书", "丝袜", "苗条", "荡妇"]);
  assert.equal(JSON.stringify({ work, metadata }), before);
});

check("noise availability does not become local edition evidence", () => {
  const traits = deriveWorkTraits({ hasSubtitles: true, isStreamable: true, tags: ["含磁链", "無磁鏈", "含字幕", "有字幕", "可下載", "可在線播放", "https://example.test/tag", "has_subtitles"] });
  assert.deepEqual(traits.tags, []);
  assert.deepEqual(activeFlags(traits), []);
  assert.deepEqual(traits.editions, []);
});

check("string and JSON tag collections, atomic array values and object labels", () => {
  const traits = deriveWorkTraits({ tags: "單體作品,眼鏡；戀愛|OL\n秘書", javdbTags: '["美少女電影","OL"]' }, { tags: [{ name: "制服,眼镜" }, { label: "  自定义 标签  " }, null, 4] });
  assert.deepEqual(traits.tags, ["美少女电影", "OL", "单体作品", "眼镜", "恋爱", "秘书", "制服,眼镜", "自定义 标签"]);
});

check("case folding, width folding and whitespace normalize deduplication", () => {
  const traits = deriveWorkTraits({ tags: ["ＯＬ", "ol", " OL ", "眼鏡", "眼镜", "  自定义   标签  "] });
  assert.deepEqual(traits.tags, ["OL", "眼镜", "自定义 标签"]);
  assert.deepEqual(deriveWorkTraits({ tags: ["ol", "ｏｌ", "Ol"] }).tags, ["OL"]);
});

for (const name of ["MIDA-744-U.mp4", "ABF-158-UN.mkv", "MIDA-744UC.mp4", "MIDA-744U.mp4", "www.example.test@MIDA-744U.mp4", "[example.test]MIDA-744UC-1080P.mp4", "sample_UN_1080P.mkv", "MIDA-744.uncensored.mp4"]) {
  check(`explicit uncensored name: ${name}`, () => {
    const traits = traitsForName(name);
    assert.deepEqual(activeFlags(traits), ["uncensored"]);
    assert.deepEqual(traits.editions.map(({ key }) => key), ["uncensored"]);
    assert.match(traits.editions[0].evidence[0], /文件名/);
  });
}

for (const name of ["MIDA-744C.mp4", "MIDA-744CH.mp4", "MIDA-744-SUB.mp4", "MIDA-744.中字.mp4", "MIDA-744-中文字幕.mp4", "sample.C.mp4"]) {
  check(`explicit subtitle name: ${name}`, () => assert.deepEqual(activeFlags(traitsForName(name)), ["subtitled"]));
}

for (const name of ["MIDA-744-无码破解.mp4", "MIDA-744-AI去碼.mp4", "MIDA-744-AI-UNCENSORED.mp4", "MIDA-744-[破解].mp4"]) {
  check(`AI badge is more specific: ${name}`, () => {
    const traits = traitsForName(name);
    assert.equal(traits.flags.uncensoredAi, true);
    assert.equal(traits.flags.uncensored, true);
    assert.deepEqual(traits.editions.map(({ key }) => key), ["uncensoredAi"]);
    assert.equal(matchesWorkTraitFilter(traits, "uncensored"), true);
  });
}

for (const name of ["MIDA-744-4K.mp4", "MIDA-744-2160p.mkv", "4K.MIDA-744.mkv", "movie.2160p.mkv"]) {
  check(`explicit resolution name: ${name}`, () => assert.equal(traitsForName(name).flags.quality4k, true));
}

for (const name of ["MIDA-744.mp4", "U-123.mp4", "C-123.mp4", "UC-123.mp4", "UN-123.mp4", "SUB-123.mp4", "UNCLE-123.mp4", "MIDA-744UNCLE.mp4", "MIDA-744CHD.mp4", "MUSIC.mp4", "DOCUMENT-U-EXPERIENCE.mp4", "u.com@MIDA-744.mp4", "ABC-2160P.mp4", "4K-123.mp4", "MIDA-744-4KIDS.mp4", "MIDA-744AI.mp4", "MIDA-744-SUBWAY.mp4", "010123-001.mp4", "20261023-001.mp4", "FC2-PPV-1234567.mp4", "FC2-1234567.mp4", "N-1234.mp4", "NAME-N123456.mp4", "myheyzo-1234.mp4", "MIDA-744-无码角色扮演.mp4"]) {
  check(`ambiguous text does not become an edition: ${name}`, () => assert.deepEqual(activeFlags(traitsForName(name)), []));
}

check("never inspect synopsis, title, ancestor path or video path for edition words", () => {
  const traits = deriveWorkTraits({
    title: "无码破解 中文字幕 4K", relativePath: "G:\\无码\\4K\\sample",
    directoryName: "G:\\无码\\4K\\MIDA-744", videos: [{ name: "MIDA-744.mp4", path: "G:\\无码破解\\MIDA-744.mp4" }],
    infoSummary: { title: "HEYZO-1234 无码 中文字幕", description: "AI去码" }
  });
  assert.deepEqual(activeFlags(traits), []);
});

check("only last directory/file component is used", () => {
  assert.deepEqual(activeFlags(deriveWorkTraits({ directoryName: "G:\\uncensored\\MIDA-744" })), []);
  assert.deepEqual(activeFlags(deriveWorkTraits({ directoryName: "G:\\plain\\MIDA-744-UC\\" })), ["uncensored"]);
  assert.deepEqual(activeFlags(deriveWorkTraits({ videos: [{ name: "/uncensored/4K/MIDA-744.mp4" }] })), []);
});

check("mixed copies preserve all positive evidence but only one uncensored badge", () => {
  const traits = deriveWorkTraits({ directoryName: "MIDA-744", videos: [{ name: "MIDA-744.mp4" }, { name: "MIDA-744U-C.mp4" }, { name: "MIDA-744-4K-AI去码.mp4" }] });
  assert.deepEqual(activeFlags(traits), ["quality4k", "subtitled", "uncensored", "uncensoredAi"]);
  assert.deepEqual(traits.editions.map(({ key }) => key), ["uncensoredAi", "subtitled", "quality4k"]);
});

check("metadata edition labels are evidence, not genre chips or visual verification", () => {
  const traits = deriveWorkTraits({ tags: ["眼鏡", "無碼", "無碼破解", "ai去碼", "中文字幕", "4k"] });
  assert.deepEqual(traits.tags, ["眼镜"]);
  assert.deepEqual(activeFlags(traits), ["quality4k", "subtitled", "uncensored", "uncensoredAi"]);
  for (const edition of traits.editions) {
    assert.ok(edition.evidence.length > 0);
    assert.ok(edition.evidence.every((text) => text.includes("资料标签") && text.includes("未核验本地画面")));
  }
});

check("evidence is deduplicated for duplicated metadata sources", () => {
  const traits = deriveWorkTraits({ tags: ["無碼", "无码"], infoSummary: { javdbTags: ["无码"] } }, { trait_tags: ["无码"] });
  assert.equal(traits.editions[0].evidence.length, 1);
});

for (const work of [{ code: "HEYZO-1234" }, { infoSummary: { code: "n1234" } }, { directoryName: "HEYZO-1234" }, { videos: [{ name: "n1234.mp4" }] }, { infoSummary: { maker: "1Pondo" } }, { videos: [{ name: "Caribbeancom-010123-001.mp4" }] }]) {
  check("reliable native release identifiers and suppliers", () => {
    const traits = deriveWorkTraits(work);
    assert.equal(traits.flags.uncensored, true);
    assert.equal(traits.flags.uncensoredAi, false);
    assert.ok(traits.editions[0].evidence.some((text) => text.includes("发行规则")));
  });
}

check("suppliers are restricted fields and require token boundaries", () => {
  assert.equal(deriveWorkTraits({ infoSummary: { maker: "fakeHEYZO", title: "Caribbeancom" } }).flags.uncensored, false);
  assert.equal(deriveWorkTraits({ infoSummary: { maker: "FC2" } }).flags.uncensored, false);
  assert.equal(deriveWorkTraits({}, { code: "010123-001" }).flags.uncensored, false);
  assert.equal(deriveWorkTraits({}, { maker: "Tokyo-Hot" }).flags.uncensored, true);
});

check("known filters use exact canonical labels and one URI decode", () => {
  const traits = deriveWorkTraits({ tags: ["眼鏡", "制服,眼镜", "100%自然", "tag:%E7%9C%BC"] });
  for (const tag of traits.tags) assert.equal(matchesWorkTraitFilter(traits, `tag:${encodeURIComponent(tag)}`), true);
  assert.equal(matchesWorkTraitFilter(traits, `tag:${encodeURIComponent("眼鏡")}`), true);
  assert.equal(matchesWorkTraitFilter(traits, `tag:${encodeURIComponent("制服")}`), false);
  assert.equal(matchesWorkTraitFilter(traits, "tag:%E7%"), false);
  assert.equal(matchesWorkTraitFilter(traits, "tag:"), false);
  assert.equal(matchesWorkTraitFilter(traits, "favorite"), null);
  assert.equal(matchesWorkTraitFilter(traits, "uncensoredUnknown"), null);
});

check("summary counts works distinctly, not copies or duplicated tags", () => {
  const one = { id: "one", tags: ["眼鏡", "眼镜", "OL"], videos: [{ name: "MIDA-744-U.mp4" }, { name: "MIDA-744U.mp4" }] };
  const two = { id: "two", tags: ["眼鏡", "无碼破解"], videos: [{ name: "ABF-158-AI去码-C.mp4" }] };
  const summary = summarizeWorkTraits([one, one, { ...one }, two]);
  assert.equal(summary.total, 2);
  assert.deepEqual(summary.tags.find((tag) => tag.name === "眼镜"), { name: "眼镜", count: 2 });
  assert.deepEqual(summary.tags.find((tag) => tag.name === "OL"), { name: "OL", count: 1 });
  assert.equal(summary.editions.find(({ key }) => key === "uncensored").count, 2);
  assert.equal(summary.editions.find(({ key }) => key === "uncensoredAi").count, 1);
  assert.equal(summary.editions.find(({ key }) => key === "subtitled").count, 1);
  assert.equal(summary.tags.some(({ name }) => name.includes("碼")), false);
});

check("summary supports injected traits and absent identifiers", () => {
  const one = {}, two = {};
  const summary = summarizeWorkTraits([one, one, two, null], () => ({ tags: ["眼鏡", "眼镜", "OL", "OL"], flags: { uncensoredAi: true }, editions: [] }));
  assert.equal(summary.total, 2);
  assert.deepEqual(Object.fromEntries(summary.tags.map(({ name, count }) => [name, count])), { OL: 2, "眼镜": 2 });
  assert.deepEqual(summary.editions.map(({ key, count }) => [key, count]), [["uncensoredAi", 2], ["uncensored", 2]]);
});

check("empty inputs are safe and do not invent a censored classification", () => {
  assert.deepEqual(deriveWorkTraits(null).tags, []);
  assert.deepEqual(deriveWorkTraits().editions, []);
  assert.deepEqual(activeFlags(deriveWorkTraits()), []);
  assert.equal(Object.hasOwn(deriveWorkTraits().flags, "censored"), false);
  assert.deepEqual(summarizeWorkTraits(), { tags: [], editions: [], total: 0 });
  assert.equal(matchesWorkTraitFilter(null, "quality4k"), false);
});

console.log(`work-traits: ok (${checks} behavior checks: labels, source noise, filenames, edition evidence, filters and distinct counts)`);
