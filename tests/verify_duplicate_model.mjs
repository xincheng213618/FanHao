import assert from "node:assert/strict";
import { buildDuplicateGroups } from "../src/modules/fanhao/server/duplicates/model.js";

let serial = 0, checks = 0;
const row = (name, extra = {}) => {
  const id = String(++serial);
  return { id, workId: `w${id}`, videoId: null, fileId: `v${id}`, path: `G:\\fixture-${id}\\${name}`, name, size: 100, modifiedAt: "2026-01-01T00:00:00Z", code: "", title: "Fixture", probe: null, ...extra };
};
const check = (name, fn) => { try { fn(); checks++; } catch (error) { error.message = `${name}: ${error.message}`; throw error; } };
const group = (left, right, expectedCode, expectedPart = "whole") => {
  const result = buildDuplicateGroups([row(left), row(right)]);
  assert.equal(result.groups.length, 1, `${left} / ${right}`);
  assert.equal(result.groups[0].code, expectedCode);
  assert.equal(result.groups[0].part, expectedPart);
  return result.groups[0];
};

check("empty and invalid inputs", () => {
  assert.deepEqual(buildDuplicateGroups(), { summary: { indexedFiles: 0, candidateGroups: 0, candidateFiles: 0, potentialExtraBytes: 0 }, groups: [] });
  assert.deepEqual(buildDuplicateGroups(null), buildDuplicateGroups([]));
  assert.deepEqual(buildDuplicateGroups([null, 1, {}, row("AB-123.mp4", { path: "" }), row("AB-123.mp4", { id: null })]), buildDuplicateGroups([]));
});
check("same release is a candidate, not proof of identical data", () => {
  const result = buildDuplicateGroups([row("ABC-123.mp4", { size: 100 }), row("ABC-123.mkv", { size: 100 })]);
  assert.deepEqual(result.summary, { indexedFiles: 2, candidateGroups: 1, candidateFiles: 2, potentialExtraBytes: 100 });
  const found = result.groups[0];
  assert.equal(found.totalBytes, 200); assert.equal(found.evidence, "same_code_part");
  assert.equal(found.partLabel, "未标分卷");
  assert(found.files.every(file => file.isLargest && !file.isLongest));
  assert(!Object.hasOwn(found, "identical"));
  assert(!found.files.some(file => Object.hasOwn(file, "contentHash")));
});
check("VR releases and copies are excluded before all summary counts", () => {
  for (const name of ["SIVR-123.mp4", "SSIS-VR-123.mp4", "DSVR-123.mp4", "3DSVR-123.mp4", "KMPVR-123.mp4", "VRKM-123.mp4", "ABC-123-VR.mp4"]) {
    assert.deepEqual(buildDuplicateGroups([row(name), row(name.replace(/\.mp4$/, ".mkv"))]), buildDuplicateGroups([]), name);
  }
  for (const extra of [{ path: "V:\\演员\\ABC-123.mp4" }, { path: "G:\\[VR]\\ABC-123.mp4" }, { path: "G:\\演员_VR\\ABC-123.mp4" }, { code: "SIVR-123" }, { title: "VR 测试作品" }, { tags: ["VR"] }, { isVr: true }]) {
    const result = buildDuplicateGroups([row("ABC-123.mp4", extra), row("ABC-123-copy.mp4"), row("ABC-123-other.mkv")]);
    assert.equal(result.summary.indexedFiles, 2); assert.equal(result.summary.candidateFiles, 2);
    assert.equal(result.summary.potentialExtraBytes, 100);
  }
  const ordinary = buildDuplicateGroups([row("ABC-123.mp4", { path: "G:\\Avril\\ABC-123.mp4" }), row("ABC-123.mkv", { path: "G:\\Avril\\ABC-123.mkv" })]);
  assert.equal(ordinary.groups.length, 1, "ordinary names containing vr must not be treated as VR");
});
check("single copies do not create groups", () => {
  const result = buildDuplicateGroups([row("ABC-123.mp4"), row("ABC-124.mp4")]);
  assert.equal(result.summary.indexedFiles, 2); assert.equal(result.groups.length, 0);
});
check("copy suffixes are not catalogue suffix letters", () => {
  const result = buildDuplicateGroups(["AB-123.mp4", "AB-123U.mp4", "AB-123UC.mkv", "AB-123C.mp4", "AB-123UN.mp4", "AB-123CH.mp4", "AB-123SUB.mp4"].map(name => row(name)));
  assert.equal(result.groups.length, 1); assert.equal(result.groups[0].files.length, 7);
  assert.equal(result.groups[0].code, "AB-123");
  assert(result.groups[0].files.find(file => file.name === "AB-123UC.mkv").editionLabels.some(label => label.startsWith("无码")));
  assert(!result.groups[0].files.find(file => file.name === "AB-123UC.mkv").editionLabels.some(label => label.startsWith("中字")));
  assert(result.groups[0].files.find(file => file.name === "AB-123C.mp4").editionLabels.some(label => label.startsWith("中字")));
});
check("glued and separated A/B remain separate conservative parts", () => {
  const found = buildDuplicateGroups(["AB-123A.mp4", "AB-123-A.mkv", "AB-123B.mp4", "AB-123-B.mkv", "AB-123-CD1.mp4", "AB-123-part1.mkv", "AB-123.mp4", "AB-123-FULL.mkv"].map(name => row(name)));
  assert.deepEqual(new Set(found.groups.map(item => item.part)), new Set(["A", "B", "1", "whole"]));
  assert(found.groups.every(item => item.files.length === 2));
});
check("explicit numeric parts normalize leading zeroes", () => {
  for (const name of ["ABC-123-CD1.mp4", "ABC-123-CD01.mp4", "ABC-123-part 01.mp4", "ABC-123-disc-1.mp4", "ABC-123-1.mp4", "ABC-123-01.mp4", "ABC-123-01U.mp4", "ABC-123.1.mp4"]) group(name, "ABC-123-PART1.mkv", "ABC-123", "1");
});
check("Chinese ordinal parts normalize to numeric parts", () => {
  for (const name of ["ABC-123-第一卷.mp4", "ABC-123 第1部.mp4", "ABC-123 一卷.mp4", "ABC-123-第01集.mp4"]) group(name, "ABC-123-CD1.mkv", "ABC-123", "1");
  group("ABC-123-第十二卷.mp4", "ABC-123-CD12.mkv", "ABC-123", "12");
  group("ABC-123-第两卷.mp4", "ABC-123-CD2.mkv", "ABC-123", "2");
});
check("upper and lower parts do not become full copies", () => {
  group("ABC-123-上卷.mp4", "ABC-123-(上).mkv", "ABC-123", "upper");
  group("ABC-123 下部.mp4", "ABC-123-下.mkv", "ABC-123", "lower");
  assert.equal(buildDuplicateGroups([row("ABC-123-上卷.mp4"), row("ABC-123-下卷.mp4"), row("ABC-123.mp4")]).groups.length, 0);
});
check("complete/unmarked files are isolated from each volume", () => {
  const result = buildDuplicateGroups([row("ABC-123.mp4"), row("ABC-123-CD1.mp4"), row("ABC-123-CD2.mp4")]);
  assert.equal(result.groups.length, 0); assert.equal(result.summary.potentialExtraBytes, 0);
});
check("conflicting volume markers are ineligible", () => {
  for (const name of ["ABC-123-CD1-CD2.mp4", "ABC-123-CD1-2.mp4", "ABC-123-part01_02.mp4", "ABC-123-第一卷-part2.mp4", "ABC-123A-CD1.mp4", "ABC-123-1-2.mp4", "ABC-123-CD0.mp4", "ABC-123-第一百卷.mp4"]) {
    assert.equal(buildDuplicateGroups([row(name), row(name)]).groups.length, 0, name);
  }
});
check("no release number is inferred from folders or titles", () => {
  const a = row("movie.mp4", { path: "G:/ABC-123/movie.mp4", title: "ABC-123" });
  const b = row("movie.mkv", { path: "H:/ABC-123/movie.mkv", title: "ABC-123" });
  assert.equal(buildDuplicateGroups([a, b]).groups.length, 0);
});
check("explicit metadata is a fallback for a generic filename", () => {
  const result = buildDuplicateGroups([row("movie.mp4", { code: "ABC-123" }), row("copy.mkv", { code: "ABC-123" })]);
  assert.equal(result.groups.length, 1); assert.equal(result.groups[0].code, "ABC-123");
  assert(result.groups[0].files.every(file => file.codeSource === "metadata"));
});
check("person/site plus year metadata is insufficient release identity", () => {
  for (const code of ["AZUL-2016", "LITTLE-2023", "LOVINGS-2023", "MARIE-2023", "SHARAPOVA-2020", "TEST-1900", "TEST-2099"]) {
    const names = ["Site.mp4", "[Site] 2023-03-31 Site Site - Title.mp4", "[Site] 2023-07-10 Site Site - Different Title.mp4",
      "Person Name - [Site.com] - [2023] - Different Title.mp4", "Person Name - [Site4K.com] - [2023] - Title - 2160p.mp4"];
    assert.equal(buildDuplicateGroups(names.map(name => row(name, { code }))).groups.length, 0, code);
  }
  const many = Array.from({ length: 406 }, (_, index) => row(`Person Name - [Site.com] - [2023] - Different Title ${index}.mp4`, { code: "AZUL-2016" }));
  assert.equal(buildDuplicateGroups(many).summary.indexedFiles, 406);
  assert.equal(buildDuplicateGroups(many).summary.candidateFiles, 0);
});
check("an explicit filename release number shaped like a year remains valid", () => {
  const found = group("TEST-2023.mp4", "TEST-2023-copy.mp4", "TEST-2023");
  assert(found.files.every(file => file.codeSource === "filename"));
  group("TEST-1900.mp4", "TEST-1900U.mkv", "TEST-1900");
  group("TEST-02023.mp4", "TEST-2023.mkv", "TEST-2023");
  group("TEST-2099.mp4", "TEST-2099-4K.mkv", "TEST-2099");
  assert.equal(buildDuplicateGroups([row("Name.2023.Different.Title.mp4"), row("Name.2023.Other.Title.mp4")]).groups.length, 0);
  assert.equal(buildDuplicateGroups([row("Name 2023 Different Title.mp4"), row("Name 2023 Other Title.mp4")]).groups.length, 0);
});
check("western calendar dates cannot be reduced to a bare year code", () => {
  for (const pair of [
    ["Site.2023.03.31.Title.mp4", "Site.2023.07.10.Title.mp4"],
    ["Site-2023-03-31-Title.mp4", "Site-2023-07-10-Title.mp4"],
    ["[Site] 2023-03-31 Site Site - Title.mp4", "[Site] 2023-03-31 Site Site - Other Title.mp4"]
  ]) assert.equal(buildDuplicateGroups(pair.map(name => row(name, { code: "AZUL-2016" }))).groups.length, 0);
  // A separate, explicit JAV number survives unrelated date decoration.
  const found = group("ABC-123-2023-03-31.mp4", "ABC-123-2023-07-10.mp4", "ABC-123");
  assert(found.files.every(file => file.codeSource === "filename"));
  assert.equal(buildDuplicateGroups([row("BRAZZERS.23.03.31.mp4"), row("BRAZZERS.23.07.10.mp4")]).groups.length, 0);
});
check("known special numbering does not become a person/year heuristic", () => {
  const result = buildDuplicateGroups([row("movie.mp4", { code: "HEYZO-2023" }), row("copy.mkv", { code: "HEYZO-2023" })]);
  assert.equal(result.groups[0].code, "HEYZO-2023");
  assert(result.groups[0].files.every(file => file.codeSource === "metadata"));
});
check("code provenance is per copy and cannot be supplied by a caller", () => {
  const result = buildDuplicateGroups([row("ABC-123.mp4", { codeSource: "metadata" }), row("copy.mkv", { code: "ABC-123", codeSource: "filename" })]);
  assert.equal(result.groups[0].files.find(file => file.name === "ABC-123.mp4").codeSource, "filename");
  assert.equal(result.groups[0].files.find(file => file.name === "copy.mkv").codeSource, "metadata");
});
check("metadata cannot settle generic bare part numbers", () => {
  for (const names of [["movie-1.mp4", "movie-2.mp4"], ["1.mp4", "2.mp4"], ["A.mp4", "B.mp4"]]) {
    assert.equal(buildDuplicateGroups(names.map(name => row(name, { code: "ABC-123" }))).groups.length, 0);
  }
});
check("clear filenames win over incorrect metadata", () => {
  const result = buildDuplicateGroups([row("ABC-123.mp4", { code: "OTHER-999" }), row("ABC-123.mkv", { code: "OTHER-998" })]);
  assert.equal(result.groups[0].code, "ABC-123");
  assert.equal(buildDuplicateGroups([row("ABC-123.mp4", { code: "SAME-001" }), row("ABC-124.mp4", { code: "SAME-001" })]).groups.length, 0);
});
check("multiple independent codes never fall back to metadata", () => {
  for (const name of ["ABC-123_ABC-124.mp4", "ABC-123 FC2-PPV-1234567.mp4", "XXX-AV-1234 AV-1234.mp4"]) {
    assert.equal(buildDuplicateGroups([row(name, { code: "ABC-123" }), row(name, { code: "ABC-123" })]).groups.length, 0, name);
  }
});
check("known overlapping aliases do not create multiple codes", () => {
  group("XXX-AV-1234.mp4", "XXX_AV_1234.mkv", "XXX-AV-1234");
  group("Tokyo-Hot-n1234.mp4", "N1234.mkv", "N-1234");
});
check("FC2 aliases and zero-padding preserve identity", () => {
  group("FC2-PPV-01234567.mp4", "fc2_1234567.mkv", "FC2-PPV-1234567");
  group("FC2-1234567U.mp4", "FC2-PPV-1234567UC.mkv", "FC2-PPV-1234567");
});
check("special release numbers are not split at their own numeric blocks", () => {
  group("HEYDOUGA-4017-001.mp4", "HEYDOUGA_4017_001.mkv", "HEYDOUGA-4017-1");
  group("010123-001.mp4", "010123_001.mkv", "010123-001");
  group("HEYZO-HD-0123.mp4", "HEYZO-123.mkv", "HEYZO-123");
  group("C0930-H1234.mp4", "C0930_H1234.mkv", "C0930-H1234");
  group("BRAZZERS.23.04.02.mp4", "BRAZZERS_23_04_02.mkv", "BRAZZERS.23.04.02");
});
check("bare part numbers work for alphanumeric release prefixes", () => {
  group("T28-123-01.mp4", "T28-123-CD1.mkv", "T28-123", "1");
  group("T38-001-02.mp4", "T38-001-PART2.mkv", "T38-001", "2");
  group("C0930-H1234-01.mp4", "C0930-H1234-CD1.mkv", "C0930-H1234", "1");
});
check("date-number releases with different explicit suppliers stay separate", () => {
  const result = buildDuplicateGroups(["1Pondo-010123-001.mp4", "Caribbeancom-010123-001.mp4", "010123-001.mp4"].map(name => row(name)));
  assert.equal(result.groups.length, 0);
  group("1Pondo-010123-001.mp4", "1Pondo-010123_001.mkv", "1PONDO-010123-001");
});
check("Windows logical paths are deduplicated before grouping", () => {
  const a = row("ABC-123.mp4", { id: "1", path: "G:\\Collection\\ABC-123.mp4", size: 200 });
  const same = row("ABC-123.mp4", { id: "2", path: "g:/collection/./ABC-123.mp4", size: 999 });
  assert.deepEqual(buildDuplicateGroups([a, same]).summary, { indexedFiles: 1, candidateGroups: 0, candidateFiles: 0, potentialExtraBytes: 0 });
  const b = row("ABC-123.mkv", { path: "H:/elsewhere/ABC-123.mkv", size: 100 });
  assert.deepEqual(buildDuplicateGroups([a, same, b]), buildDuplicateGroups([b, same, a]));
  assert.equal(buildDuplicateGroups([a, same, b]).groups[0].totalBytes, 300);
});
check("UNC path slash/case aliases are deduplicated", () => {
  const result = buildDuplicateGroups([row("ABC-123.mp4", { path: "\\\\Server\\Share\\ABC-123.mp4" }), row("ABC-123.mp4", { path: "//server/share/abc-123.mp4" })]);
  assert.equal(result.summary.indexedFiles, 1); assert.equal(result.groups.length, 0);
});
check("safe nonnegative sizes and overflow-safe sums", () => {
  const bad = [-1, 1.25, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1, "-3", "9.5", "NaN", null, true];
  const result = buildDuplicateGroups(bad.map(size => row("ABC-123.mp4", { size })));
  assert(result.groups[0].files.every(file => file.size === 0 && !file.isLargest));
  assert.equal(result.groups[0].potentialExtraBytes, 0);
  const huge = buildDuplicateGroups([row("ABC-123.mp4", { size: Number.MAX_SAFE_INTEGER }), row("ABC-123.mp4", { size: Number.MAX_SAFE_INTEGER }), row("ABC-123.mp4", { size: Number.MAX_SAFE_INTEGER })]);
  assert.equal(huge.groups[0].totalBytes, Number.MAX_SAFE_INTEGER); assert.equal(huge.summary.potentialExtraBytes, Number.MAX_SAFE_INTEGER);
  assert.equal(buildDuplicateGroups([row("ABC-123.mp4", { size: "123" }), row("ABC-123.mp4", { size: 1n })]).groups[0].totalBytes, 124);
});
check("largest and longest are independent cached facts", () => {
  const result = buildDuplicateGroups([row("ABC-123-4K.mp4", { size: 500, probe: { duration: 60, width: 1920, height: 1080, videoCodec: "h264" } }), row("ABC-123.mkv", { size: 300, probe: { duration: 120, width: 3840, height: 2160, videoCodec: "hevc" } })]);
  const [largest, longest] = result.groups[0].files;
  assert(largest.isLargest && !largest.isLongest); assert(!longest.isLargest && longest.isLongest);
  assert.equal(largest.duration, 60); assert.equal(longest.duration, 120);
  assert.equal(largest.resolutionLabel, "1920×1080（缓存探测）");
  assert.equal(longest.resolutionLabel, "3840×2160（缓存探测）");
  assert.equal(longest.probe.videoCodec, "hevc");
});
check("unprobed resolution labels explicitly identify filename evidence", () => {
  for (const [name, label] of [["ABC-123-4K.mp4", "文件名 4K"], ["ABC-123-2160p.mp4", "文件名 4K"], ["ABC-123-1080p.mp4", "文件名 1080P"], ["ABC-123.mp4", "未知"]]) {
    const found = group(name, name.replace(/\.mp4$/, ".mkv"), "ABC-123");
    assert(found.files.every(file => file.resolutionLabel === label && file.duration === null));
  }
  const found = buildDuplicateGroups([row("ABC-2160P.mp4", { code: "ABC-123" }), row("ABC-2160P.mkv", { code: "ABC-123" })]).groups[0];
  assert(found.files.every(file => file.resolutionLabel === "未知"));
});
check("invalid probe data cannot become known duration/resolution", () => {
  const result = buildDuplicateGroups([row("ABC-123.mp4", { probe: { duration: -1, width: -3840, height: 2160 } }), row("ABC-123.mp4", { probe: { duration: Infinity, width: 1920.5, height: 1080 } })]);
  assert(result.groups[0].files.every(file => file.duration === null && file.resolutionLabel === "未知" && !file.isLongest));
});
check("group ids are stable across order, paths, sizes, and extra copies", () => {
  const a = row("ABC-123.mp4"), b = row("ABC-123.mkv"), c = row("ABC-123-U.mp4", { size: 9999 });
  const expected = buildDuplicateGroups([a, b]).groups[0].id;
  assert.match(expected, /^[a-f0-9]{64}$/);
  assert.equal(buildDuplicateGroups([c, b, a]).groups[0].id, expected);
  assert.notEqual(group("ABC-123-CD1.mp4", "ABC-123-part1.mkv", "ABC-123", "1").id, expected);
});
check("groups sort by potential extra bytes, excluding the largest copy", () => {
  const result = buildDuplicateGroups([row("ABC-123.mp4", { size: 100 }), row("ABC-123.mp4", { size: 50 }), row("DEF-123.mp4", { size: 300 }), row("DEF-123.mp4", { size: 200 }), row("DEF-123.mp4", { size: 100 })]);
  assert.deepEqual(result.groups.map(g => [g.code, g.potentialExtraBytes, g.totalBytes]), [["DEF-123", 300, 600], ["ABC-123", 50, 150]]);
  assert.equal(result.summary.potentialExtraBytes, 350); assert.equal(result.summary.candidateFiles, 5);
});
check("input objects remain untouched and rows retain stable database ids", () => {
  const input = [row("ABC-123.mp4", { id: "9000000001" }), row("ABC-123.mkv", { id: "9000000002", videoId: "public-id", probe: { duration: 120, width: 1920, height: 1080 } })];
  const before = JSON.stringify(input);
  input.forEach(Object.freeze); Object.freeze(input);
  const result = buildDuplicateGroups(input);
  assert.equal(JSON.stringify(input), before);
  assert.deepEqual(new Set(result.groups[0].files.map(file => file.id)), new Set(["9000000001", "9000000002"]));
  assert.equal(result.groups[0].files.find(file => file.id === "9000000002").videoId, "public-id");
});

console.log(`duplicate-model: ${checks} checks passed (pure fixtures, no filesystem reads or deletion)`);
