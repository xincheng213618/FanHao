import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import * as model from "./fixtures/novel-model/identity-progress.mjs";
import { clampReadingProgress, chapterId, legacySourceHashes } from "./fixtures/novel-model/legacy-clamp.mjs";

// Pure synthetic candidate contract. No production DB, reader/API imports, or writes.
const storeSource = fs.readFileSync(new URL("../src/modules/novels/server/store.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");
const candidateSource = fs.readFileSync(new URL("./fixtures/novel-model/identity-progress.mjs", import.meta.url), "utf8");
// The frozen old implementation remains evidence; production now deliberately
// removed it. This candidate still has broader matching semantics than v5 and
// is not a claim that the candidate itself was shipped.
for (const fn of [clampReadingProgress, chapterId]) {
  const actual = fn.toString();
  assert.equal(crypto.createHash("sha256").update(actual).digest("hex"), legacySourceHashes[fn.name]);
  assert(!storeSource.includes(`function ${fn.name}(`), `production must not retain the retired ordinal-based ${fn.name}`);
}

const E = "edition-opaque-a";
const old = (chapterId, ordinal, title, content, upstream) => ({ id: chapterId, editionId: E, ordinal, title, content, ...(upstream ? { upstream } : {}) });
const incoming = (allocatedId, ordinal, title, content, upstream) => ({ allocatedId, editionId: E, ordinal, title, content, ...(upstream ? { upstream } : {}) });
const upstream = (chapterId, sourceBindingId = "binding-a", realm = "server-a") => ({ trusted: true, chapterId, sourceBindingId, realm });
const progress = (chapterId = "chapter-a", scrollRatio = 0.63, extra = {}) => ({ editionId: E, chapterId, ordinal: 1, scrollRatio, updatedAt: "2020-01-01T00:00:00.000Z", ...extra });
const allocation = (suffix) => ({ workId: `work-${suffix}`, editionId: `edition-${suffix}` });
const alias = (m, legacyId = "legacy-a", realm = "server-a", libraryId = "library-a") => m.qualifyLegacyAlias({ libraryId, realm, legacyId });
const reconcile = (m, oldChapters, incomingChapters, saved = progress()) => {
  const result = m.reconcileImportedChapters({ editionId: E, oldChapters, incomingChapters });
  return { ...result, mapped: m.remapImportedProgress({ editionId: E, oldChapters, ...result, progress: saved }) };
};
const freeze = (value) => {
  if (value && typeof value === "object") { Object.freeze(value); Object.values(value).forEach(freeze); }
  return value;
};
const cases = [];
const test = (name, run) => cases.push({ name, run });

test("legacy aliases are qualified by BOTH library and explicit realm", (m) => {
  assert.notEqual(alias(m).key, alias(m, "legacy-a", "server-b").key);
  assert.notEqual(alias(m).key, alias(m, "legacy-a", "server-a", "library-b").key);
  assert.equal(alias(m).key, alias(m).key);
});
test("structured aliases do not collide at separators or escaped characters", (m) => {
  const a = alias(m, "c", "b", "a|b");
  const b = alias(m, "b|c", "b", "a");
  const c = alias(m, 'c"]', "b\nx", "a");
  assert.equal(new Set([a.key, b.key, c.key]).size, 3);
  assert.deepEqual(JSON.parse(a.key), ["legacy-book", "a|b", "b", "c"]);
});
test("realm-less remote-cache stays unresolved despite a supplied activeUrl", (m) => {
  for (const realm of [undefined, null, "", "   "]) {
    const qualifiedAlias = m.qualifyLegacyAlias({ libraryId: "device-a", realm, legacyId: "remote_1", activeUrl: "https://current.invalid" });
    assert.deepEqual(qualifiedAlias, { status: "unresolved", reason: "missing_realm", key: null });
    assert.deepEqual(m.resolveImportIdentity({ qualifiedAlias, allocated: allocation("unused"), activeUrl: "https://current.invalid" }), { status: "unresolved", reason: "missing_realm" });
  }
});
test("known qualified alias reuses opaque work and edition identities", (m) => {
  const qualifiedAlias = alias(m);
  const found = m.resolveImportIdentity({ qualifiedAlias, aliases: [{ key: qualifiedAlias.key, ...allocation("known") }] });
  assert.equal(found.status, "reused");
  assert.equal(found.workId, "work-known");
  assert.equal(found.editionId, "edition-known");
});
test("same old book ID in another realm or library never aliases the original", (m) => {
  const known = { key: alias(m).key, ...allocation("known") };
  for (const qualifiedAlias of [alias(m, "legacy-a", "server-b"), alias(m, "legacy-a", "server-a", "library-b")]) {
    const found = m.resolveImportIdentity({ qualifiedAlias, aliases: [known], allocated: allocation("new") });
    assert.equal(found.status, "created");
    assert.equal(found.editionId, "edition-new");
  }
});
test("title, author, and source locator are not identity equality or ID generators", (m) => {
  const descriptor = { title: "同名小说", author: "同名作者", source: { uri: "content://synthetic/book" } };
  const a = m.resolveImportIdentity({ ...descriptor, allocated: allocation("a") });
  const b = m.resolveImportIdentity({ ...descriptor, allocated: allocation("b") });
  assert.notEqual(a.workId, b.workId);
  assert.notEqual(a.editionId, b.editionId);
  assert.equal(a.aliasKey, null);
  assert.equal("source" in a, false, "source binding is a separate caller-owned record");
});
test("an explicit work association can create another edition without title merging", (m) => {
  const result = m.resolveImportIdentity({ explicitWorkId: "work-established", allocated: allocation("second") });
  assert.equal(result.workId, "work-established");
  assert.equal(result.editionId, "edition-second");
  assert.equal(result.reason, "explicit_work_new_edition");
});
test("conflicting aliases and conflicting explicit associations remain unresolved", (m) => {
  const qualifiedAlias = alias(m);
  const first = { key: qualifiedAlias.key, ...allocation("first") };
  assert.equal(m.resolveImportIdentity({ qualifiedAlias, aliases: [first, { key: qualifiedAlias.key, ...allocation("other") }] }).reason, "alias_conflict");
  assert.equal(m.resolveImportIdentity({ qualifiedAlias, aliases: [first], explicitWorkId: "work-other" }).reason, "work_conflict");
  assert.equal(m.resolveImportIdentity({ qualifiedAlias, aliases: [first, { ...first }] }).status, "reused");
});
test("empty identity allocations and malformed aliases are rejected", (m) => {
  for (const value of ["", " ", undefined, 1]) {
    assert.throws(() => m.resolveImportIdentity({ allocated: { workId: value, editionId: "edition-valid" } }), TypeError);
    assert.throws(() => m.resolveImportIdentity({ allocated: { workId: "work-valid", editionId: value } }), TypeError);
  }
  assert.throws(() => m.qualifyLegacyAlias({ libraryId: "", realm: "server-a", legacyId: "old" }), TypeError);
  assert.throws(() => m.resolveImportIdentity({ qualifiedAlias: { status: "qualified", key: "library|realm|book" } }), SyntaxError);
  assert.throws(() => m.resolveImportIdentity({ qualifiedAlias: { status: "qualified" } }), TypeError);
});
test("opaque legacy IDs are not treated as chapter order or causal revisions", (m) => {
  const before = [old("old-book-00001", 1, "第一章", "原第一章正文")];
  const result = reconcile(m, before, [incoming("random-new-p", 1, "序言", "新序言"), incoming("random-new-c", 2, "第一章", "原第一章正文")], progress("old-book-00001"));
  assert.equal(result.chapters[1].id, "old-book-00001");
  assert.equal(result.mapped.progress.ordinal, 2);
  assert.equal(result.mapped.progress.scrollRatio, 0.63);
  assert.equal("updatedAt" in result.mapped.progress, false);
});

test("inserting a preamble maps the original chapter instead of clamping to new first", (m) => {
  const result = reconcile(m, [old("chapter-a", 1, "第一章", "A正文")], [incoming("new-preamble", 1, "序言", "序言正文"), incoming("new-a", 2, "第一章", "A正文")]);
  assert.equal(result.chapters[0].id, "new-preamble");
  assert.equal(result.chapters[1].id, "chapter-a");
  assert.deepEqual(result.mapped.progress, { editionId: E, chapterId: "chapter-a", ordinal: 2, scrollRatio: 0.63 });
  assert.equal(result.mapped.needsReview, false);
});
test("reordering updates only ordinal while preserving stable chapter identity", (m) => {
  const result = reconcile(m, [old("chapter-a", 1, "A", "正文A"), old("chapter-b", 2, "B", "正文B")], [incoming("new-b", 1, "B", "正文B"), incoming("new-a", 2, "A", "正文A")]);
  assert.deepEqual(result.chapters.map((c) => c.id), ["chapter-b", "chapter-a"]);
  assert.equal(result.mapped.progress.ordinal, 2);
  assert.equal(result.mapped.status, "mapped");
});
test("removing the progress chapter leaves unresolved old position, never next Nth", (m) => {
  const saved = progress();
  const result = reconcile(m, [old("chapter-a", 1, "A", "正文A"), old("chapter-b", 2, "B", "正文B")], [incoming("new-b", 1, "B", "正文B")], saved);
  assert.equal(result.mapped.status, "unresolved");
  assert.equal(result.mapped.progress, null);
  assert.deepEqual(result.mapped.previousProgress, saved);
  assert.equal(result.mapped.needsReview, true);
});
test("removing final chapter or all chapters never clamps to previous final", (m) => {
  const before = [old("chapter-a", 1, "A", "正文A"), old("chapter-b", 2, "B", "正文B")];
  for (const after of [[incoming("new-a", 1, "A", "正文A")], []]) {
    assert.equal(reconcile(m, before, after, progress("chapter-b", 0.8, { ordinal: 2 })).mapped.status, "unresolved");
  }
});
test("duplicate titles are disambiguated by unique exact full content", (m) => {
  const result = reconcile(m, [old("chapter-a", 1, "正文", "唯一A"), old("chapter-b", 2, "正文", "唯一B")], [incoming("new-b", 1, "正文", "唯一B"), incoming("new-a", 2, "正文", "唯一A")]);
  assert.equal(result.mapped.progress.ordinal, 2);
  assert.equal(result.mapped.progress.scrollRatio, 0.63);
});
test("repeated bodies with unique titles are disambiguated by unique title+body", (m) => {
  const result = reconcile(m, [old("chapter-a", 1, "A", "重复正文"), old("chapter-b", 2, "B", "重复正文")], [incoming("new-b", 1, "B", "重复正文"), incoming("new-a", 2, "A", "重复正文")]);
  assert.equal(result.mapped.progress.ordinal, 2);
  assert.equal(result.mapped.basis, "unique_title_content");
});
test("identical duplicate title/body chapters remain unresolved", (m) => {
  const result = reconcile(m, [old("chapter-a", 1, "重复", "重复正文"), old("chapter-b", 2, "重复", "重复正文")], [incoming("new-a", 1, "重复", "重复正文"), incoming("new-b", 2, "重复", "重复正文")]);
  assert.equal(result.matches.length, 0);
  assert.equal(result.mapped.status, "unresolved");
  assert.deepEqual(result.chapters.map((c) => c.id), ["new-a", "new-b"]);
});
test("many-to-one and one-to-many duplicate candidates are not guessed", (m) => {
  const a = old("chapter-a", 1, "重复", "同文");
  const b = old("chapter-b", 2, "重复", "同文");
  const x = incoming("new-x", 1, "重复", "同文");
  const y = incoming("new-y", 2, "重复", "同文");
  assert.equal(reconcile(m, [a, b], [x]).mapped.status, "unresolved");
  assert.equal(reconcile(m, [a], [x, y]).mapped.status, "unresolved");
});
test("removing a trusted match does not make globally repeated text falsely unique", (m) => {
  const result = reconcile(m, [old("chapter-a", 1, "重复", "同文", upstream("a")), old("chapter-b", 2, "重复", "同文")], [incoming("new-a", 1, "重复", "同文", upstream("a")), incoming("new-b", 2, "重复", "同文")], progress("chapter-b"));
  assert.equal(result.matches.length, 1);
  assert.equal(result.matches[0].basis, "trusted_upstream");
  assert.equal(result.mapped.status, "unresolved");
});
test("trusted scoped upstream ID has priority over text swapped between chapters", (m) => {
  const result = reconcile(m, [old("chapter-a", 1, "A", "正文A", upstream("a")), old("chapter-b", 2, "B", "正文B", upstream("b"))], [incoming("new-a", 1, "B", "正文B", upstream("a")), incoming("new-b", 2, "A", "正文A", upstream("b"))]);
  assert.equal(result.matches.find((link) => link.oldChapterId === "chapter-a").basis, "trusted_upstream");
  assert.equal(result.chapters[0].id, "chapter-a");
  assert.equal(result.mapped.status, "reset");
  assert.equal(result.mapped.progress.scrollRatio, 0);
  assert.equal(result.mapped.needsReview, true);
});
test("trusted unique IDs disambiguate repeated text and can retain unchanged ratio", (m) => {
  const result = reconcile(m, [old("chapter-a", 1, "重复", "同文", upstream("a")), old("chapter-b", 2, "重复", "同文", upstream("b"))], [incoming("new-b", 1, "重复", "同文", upstream("b")), incoming("new-a", 2, "重复", "同文", upstream("a"))]);
  assert.equal(result.mapped.basis, "trusted_upstream");
  assert.equal(result.mapped.progress.ordinal, 2);
  assert.equal(result.mapped.progress.scrollRatio, 0.63);
});
test("bare upstream ID cannot cross realm or source-binding boundaries", (m) => {
  for (const reference of [upstream("same", "binding-a", "server-b"), upstream("same", "binding-b", "server-a")]) {
    const result = reconcile(m, [old("chapter-a", 1, "旧章", "旧正文", upstream("same"))], [incoming("new-x", 1, "新章", "新正文", reference)]);
    assert.equal(result.matches.length, 0);
    assert.equal(result.mapped.status, "unresolved");
  }
});
test("upstream identity tuple cannot collide through component separators", (m) => {
  const result = reconcile(m, [old("chapter-a", 1, "A", "正文A", upstream("c", "b", "a|b"))], [incoming("new-x", 1, "X", "正文X", upstream("b|c", "b", "a"))]);
  assert.equal(result.mapped.status, "unresolved");
});
test("cross-binding unique text can map but must disclose text, not upstream, evidence", (m) => {
  const result = reconcile(m, [old("chapter-a", 1, "A", "同一正文", upstream("same"))], [incoming("new-a", 1, "A", "同一正文", upstream("same", "binding-b"))]);
  assert.equal(result.mapped.basis, "unique_title_content");
  assert.equal(result.mapped.status, "mapped");
});
test("untrusted upstream IDs and incomplete trusted references are not credentials", (m) => {
  const result = reconcile(m, [old("chapter-a", 1, "A", "正文A", { chapterId: "same" })], [incoming("new-x", 1, "X", "正文X", { chapterId: "same" })]);
  assert.equal(result.mapped.status, "unresolved");
  for (const reference of [{ trusted: true, chapterId: "same" }, { ...upstream("same"), realm: "" }, { ...upstream("same"), sourceBindingId: "" }]) {
    assert.throws(() => reconcile(m, [old("chapter-a", 1, "A", "正文A", reference)], []), TypeError);
  }
});
test("duplicate trusted upstream references are blocked, not downgraded to weaker evidence", (m) => {
  const result = reconcile(m, [old("chapter-a", 1, "A", "正文A", upstream("dup")), old("chapter-b", 2, "B", "正文B", upstream("dup"))], [incoming("new-a", 1, "A", "正文A", upstream("dup")), incoming("new-b", 2, "B", "正文B", upstream("dup"))]);
  assert.equal(result.matches.length, 0);
  assert.equal(result.unmatchedOld[0].reason, "ambiguous_upstream");
  assert.equal(result.mapped.status, "unresolved");
});
test("known different IDs in the same source binding contradict title/text equality", (m) => {
  const result = reconcile(m, [old("chapter-a", 1, "A", "相同正文", upstream("old"))], [incoming("new-a", 1, "A", "相同正文", upstream("other"))]);
  assert.equal(result.matches.length, 0);
  assert.equal(result.mapped.status, "unresolved");
});
test("unique title with changed body resets to chapter start and requires review", (m) => {
  const saved = progress();
  const result = reconcile(m, [old("chapter-a", 1, "第一章", "旧正文")], [incoming("new-a", 5, "第一章", "新增并修改的正文")], saved);
  assert.equal(result.mapped.status, "reset");
  assert.equal(result.mapped.basis, "unique_title");
  assert.equal(result.mapped.reason, "content_changed");
  assert.equal(result.mapped.needsReview, true);
  assert.equal(result.chapters[0].id, "new-a", "unique title is only a location hint, not stable chapter identity");
  assert.equal(result.matches[0].chapterIdentityPreserved, false);
  assert.equal(result.mapped.chapterIdentityPreserved, false);
  assert.deepEqual(result.mapped.progress, { editionId: E, chapterId: "new-a", ordinal: 5, scrollRatio: 0 });
  assert.deepEqual(result.mapped.previousProgress, saved);
});
test("unique unchanged body can survive a changed chapter title", (m) => {
  const result = reconcile(m, [old("chapter-a", 1, "旧标题", "完整相同正文")], [incoming("new-a", 3, "修正标题", "完整相同正文")]);
  assert.equal(result.mapped.basis, "unique_content");
  assert.equal(result.mapped.progress.ordinal, 3);
  assert.equal(result.mapped.progress.scrollRatio, 0.63);
});
test("title and content both changing without trusted reference remains unresolved", (m) => {
  const result = reconcile(m, [old("chapter-a", 1, "旧标题", "旧正文")], [incoming("new-a", 1, "新标题", "新正文")]);
  assert.equal(result.mapped.status, "unresolved");
});
test("empty chapter body is not evidence for retaining a scroll ratio", (m) => {
  const result = reconcile(m, [old("chapter-a", 1, "A", "")], [incoming("new-a", 1, "A", "")]);
  assert.equal(result.mapped.status, "reset");
  assert.equal(result.mapped.progress.scrollRatio, 0);
  assert.equal(result.mapped.needsReview, true);
});
test("body whitespace changes conservatively reset rather than reuse visual ratio", (m) => {
  const result = reconcile(m, [old("chapter-a", 1, "A", "第一段\n第二段")], [incoming("new-a", 1, "A", "第一段\n\n第二段")]);
  assert.equal(result.mapped.status, "reset");
});
test("full-body comparison does not confuse matching 512-char excerpts with equality", (m) => {
  const prefix = "合成前文".repeat(160);
  const suffix = "合成末文".repeat(160);
  const result = reconcile(m, [old("chapter-a", 1, "A", `${prefix}旧中段${suffix}`)], [incoming("new-a", 1, "A", `${prefix}新中段${suffix}`)]);
  assert.equal(result.mapped.status, "reset");
});
test("progress from a different edition is unresolved even when chapter IDs match", (m) => {
  const result = reconcile(m, [old("chapter-a", 1, "A", "正文")], [incoming("new-a", 1, "A", "正文")], progress("chapter-a", 0.63, { editionId: "edition-other" }));
  assert.equal(result.mapped.reason, "different_edition");
  assert.equal(result.mapped.progress, null);
});
test("old ordinal and updatedAt never locate an absent stable chapter identity", (m) => {
  const result = reconcile(m, [old("chapter-a", 1, "A", "正文")], [incoming("new-a", 1, "A", "正文")], progress("not-found", 0.63, { ordinal: 1, updatedAt: "2099-01-01" }));
  assert.equal(result.mapped.reason, "old_chapter_missing");
  assert.equal(result.mapped.progress, null);
});
test("malformed ratio is unresolved, not silently clamped into a valid progress", (m) => {
  for (const ratio of [NaN, Infinity, -0.1, 1.1, "0.5", null]) {
    const result = reconcile(m, [old("chapter-a", 1, "A", "正文")], [incoming("new-a", 1, "A", "正文")], progress("chapter-a", ratio));
    assert.equal(result.mapped.reason, "invalid_ratio");
  }
  for (const ratio of [0, 1]) {
    assert.equal(reconcile(m, [old("chapter-a", 1, "A", "正文")], [incoming("new-a", 1, "A", "正文")], progress("chapter-a", ratio)).mapped.progress.scrollRatio, ratio);
  }
});
test("missing progress does not invent a first-chapter reading record", (m) => {
  const result = reconcile(m, [old("chapter-a", 1, "A", "正文")], [incoming("new-a", 1, "A", "正文")], null);
  assert.equal(result.mapped.reason, "missing_progress");
  assert.equal(result.mapped.progress, null);
});
test("new chapters retain their independent allocation and have no ordinal-derived IDs", (m) => {
  const result = m.reconcileImportedChapters({ editionId: E, oldChapters: [], incomingChapters: [incoming("opaque-random-z", 10, "无标题章", "正文")] });
  assert.equal(result.chapters[0].id, "opaque-random-z");
  assert.equal(result.chapters[0].ordinal, 10);
  assert.equal(result.matches.length, 0);
});
test("duplicate, empty, or old-colliding allocated chapter IDs fail before matching", (m) => {
  const before = [old("chapter-a", 1, "A", "正文")];
  for (const after of [[incoming("", 1, "A", "正文")], [incoming("chapter-a", 1, "A", "正文")], [incoming("same", 1, "A", "正文"), incoming("same", 2, "B", "另一正文")]]) {
    assert.throws(() => m.reconcileImportedChapters({ editionId: E, oldChapters: before, incomingChapters: after }), TypeError);
  }
  assert.throws(() => m.reconcileImportedChapters({ editionId: E, oldChapters: [before[0], { ...before[0], ordinal: 2 }], incomingChapters: [] }), TypeError);
});
test("cross-edition chapters, repeated ordinals, and metadata-only rows are rejected", (m) => {
  for (const after of [[{ ...incoming("new-a", 1, "A", "正文"), editionId: "other" }], [incoming("new-a", 1, "A", "正文"), incoming("new-b", 1, "B", "正文B")], [{ ...incoming("new-a", 1, "A", "正文"), content: undefined }]]) {
    assert.throws(() => m.reconcileImportedChapters({ editionId: E, oldChapters: [], incomingChapters: after }), TypeError);
  }
  assert.throws(() => m.reconcileImportedChapters({ editionId: E, oldChapters: [{ ...old("a", 1, "A", "正文"), editionId: "other" }], incomingChapters: [] }), TypeError);
});
test("ambiguous progress link lists do not choose their first match", (m) => {
  const before = [old("chapter-a", 1, "A", "正文")];
  const result = m.reconcileImportedChapters({ editionId: E, oldChapters: before, incomingChapters: [incoming("new-a", 1, "A", "正文")] });
  assert.equal(m.remapImportedProgress({ editionId: E, oldChapters: before, ...result, matches: [...result.matches, ...result.matches], progress: progress() }).status, "unresolved");
});
test("candidate operations are deterministic and do not mutate input snapshots", (m) => {
  const input = freeze({ editionId: E, oldChapters: [old("chapter-a", 1, "A", "正文", upstream("a"))], incomingChapters: [incoming("new-a", 2, "A", "正文", upstream("a"))] });
  const before = JSON.stringify(input);
  const result = m.reconcileImportedChapters(input);
  assert.deepEqual(result, m.reconcileImportedChapters(input));
  const saved = freeze(progress());
  m.remapImportedProgress({ editionId: E, oldChapters: input.oldChapters, ...freeze(result), progress: saved });
  assert.equal(JSON.stringify(input), before);
});
test("synthetic reorder/insert/delete permutations preserve only proven chapter positions", (m) => {
  const before = Array.from({ length: 8 }, (_, n) => old(`opaque-${n}`, n + 1, `第${n}章`, `唯一合成全文${n}`));
  for (let removed = 0; removed < 8; removed += 1) {
    const remaining = before.filter((_, n) => n !== removed).reverse();
    const after = [incoming(`allocated-p-${removed}`, 1, "序言", "新序言"), ...remaining.map((chapter, n) => incoming(`allocated-${removed}-${n}`, n + 2, chapter.title, chapter.content))];
    const result = m.reconcileImportedChapters({ editionId: E, oldChapters: before, incomingChapters: after });
    for (const chapter of before) {
      const mapped = m.remapImportedProgress({ editionId: E, oldChapters: before, ...result, progress: progress(chapter.id, 0.37, { ordinal: chapter.ordinal }) });
      if (chapter.id === before[removed].id) assert.equal(mapped.status, "unresolved");
      else {
        assert.equal(mapped.status, "mapped");
        assert.equal(result.chapters.find((entry) => entry.ordinal === mapped.progress.ordinal).content, chapter.content);
        assert.equal(mapped.progress.scrollRatio, 0.37);
      }
    }
  }
});

function runCases(candidate) {
  for (const entry of cases) {
    try { entry.run(candidate); }
    catch (error) { error.message = `${entry.name}: ${error.message}`; throw error; }
  }
}
runCases(model);

// The historical function runs unchanged against a SQL-shaped in-memory boundary.
function runLegacy(initial, chapterCount) {
  let row = initial ? { ...initial } : null;
  const database = {
    prepare(sql) {
      const normalized = sql.trim().replace(/\s+/g, " ");
      if (normalized.startsWith("SELECT chapter_index")) return { get(bookId) { assert.equal(bookId, "legacy-book"); return row ? { ...row } : undefined; } };
      if (normalized.startsWith("DELETE FROM novel_reading_state")) return { run(bookId) { assert.equal(bookId, "legacy-book"); row = null; } };
      assert.ok(normalized.startsWith("UPDATE novel_reading_state"));
      return { run(idValue, index, ratio, updatedAt, bookId) { assert.equal(bookId, "legacy-book"); row = { chapter_id: idValue, chapter_index: index, scroll_ratio: ratio, updated_at: updatedAt }; } };
    },
  };
  clampReadingProgress(database, "legacy-book", chapterCount);
  return row;
}
const legacySaved = { chapter_id: chapterId("legacy-book", 1), chapter_index: 1, scroll_ratio: 0.63, updated_at: "2020-01-01T00:00:00.000Z" };
assert.deepEqual(runLegacy(legacySaved, 2), legacySaved, "historical unchanged-order positive control");
assert.equal(runLegacy(legacySaved, 0), null, "historical empty-catalog positive control");
const historicalCases = [
  ["preamble insertion wrongly retains ordinal 1", () => assert.equal(runLegacy(legacySaved, 2).chapter_index, 2)],
  ["chapter reorder wrongly retains ordinal 1", () => assert.equal(["原B", "原A"][runLegacy(legacySaved, 2).chapter_index - 1], "原A")],
  ["deletion wrongly resumes another chapter at the same ordinal", () => assert.equal(runLegacy(legacySaved, 1), null)],
  ["deleted last chapter wrongly clamps to previous final", () => assert.equal(runLegacy({ ...legacySaved, chapter_index: 2 }, 1), null)],
  ["changed text wrongly retains old scroll ratio", () => assert.equal(runLegacy(legacySaved, 1).scroll_ratio, 0)],
  ["ambiguous duplicate title/body wrongly returns a continuation", () => assert.equal(runLegacy(legacySaved, 2), null)],
];
for (const [name, check] of historicalCases) assert.throws(check, { name: "AssertionError" }, `historical negative control must fail: ${name}`);

// In-memory mutants show the new tests reject the specific unsafe shortcuts.
const mutants = [
  ["legacy realm guessed from active server", 'return { status: "unresolved", reason: "missing_realm", key: null };', 'return { status: "qualified", key: JSON.stringify(["legacy-book", libraryId, "current-active-server", legacyId]) };'],
  ["title treated as automatic work identity", 'workId: chosenWork || id(allocated?.workId, "allocated.workId"),', 'workId: "merged-same-title-work",'],
  ["upstream source realm ignored", 'return reference ? JSON.stringify(reference) : null;', 'return reference ? reference[2] : null;'],
  ["changed chapter body retains ratio", 'scrollRatio: contentUnchanged ? progress.scrollRatio : 0', 'scrollRatio: progress.scrollRatio'],
  ["old stable chapter ID replaced by ordinal", 'const chapterId = chapterIdentityPreserved ? old.id : incoming.allocatedId;', 'const chapterId = `chapter-${incoming.ordinal}`;'],
  ["unmatched progress clamped to new ordinal", 'if (links.length !== 1) return unresolved("no_unique_match");', 'if (links.length !== 1) return { status: "mapped", progress: { chapterId: chapters[0]?.id, ordinal: 1, scrollRatio: progress.scrollRatio } };'],
];
for (const [name, needle, replacement] of mutants) {
  assert.equal(candidateSource.split(needle).length, 2, `mutation anchor must occur exactly once: ${name}`);
  const mutatedSource = candidateSource.replace(needle, replacement);
  const mutated = await import(`data:text/javascript;base64,${Buffer.from(mutatedSource).toString("base64")}`);
  assert.throws(() => runCases(mutated), { name: "AssertionError" }, `candidate mutant must be rejected: ${name}`);
}

console.log(`PASS novel identity/progress candidate: ${cases.length} scenarios, 64 permutation progress checks; ${historicalCases.length} executable historical red controls + ${mutants.length} rejected in-memory mutants; frozen historical hashes matched and old functions absent from production.`);
console.log("SCOPE: synthetic pure functions only; no production code/API/storage wiring, real library reads, or migrations.");
