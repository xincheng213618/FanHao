import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { reconcileLocalNovelEntry } from "../android-client/www/js/novel-chapter-identity.js";
import { harness, entry, plain, requestResult, productionSource, identitySource, frozenV2Source } from "./fixtures/android-local-novel-v2-harness.mjs";

// Current production coordinator and complete storage module on synthetic
// fake-indexeddb. Native IndexedDB evidence is deliberately a separate suite.
const vectors = JSON.parse(fs.readFileSync(new URL("./fixtures/novel-model/chapter-identity-vectors.json", import.meta.url), "utf8")).cases;
const tests = [], pureTests = [];
const test = (name, run) => tests.push({ name, run });
const pureTest = (name, run) => pureTests.push({ name, run });
const clone = structuredClone;
const stores = ["books", "bookMetadata", "chapterMetadata", "chapterBodies", "readingProgress", "bookExtras"];
const snapshot = async h => Object.fromEntries(await Promise.all(stores.map(async store => [store, await h.rows(store)])));
const selected = async (h, full, index = 2, ratio = 0.6) => {
  const chapter = full.chapters.find(item => item.index === index);
  return h.api.saveLocalNovelProgress(full.book.id, { chapterId: chapter.id, chapterIndex: index, scrollRatio: ratio, catalogRevision: full.book.catalogRevision }, { expectedGeneration: full.generation });
};
const fresh = async h => { await h.api.saveLocalNovelEntry(entry(), { expectedGeneration: null }); return h.api.readLocalNovelEntry("local-1"); };
const replace = (before, chapters) => ({ ...clone(before), chapters: chapters.map((chapter, ordinal) => ({ ...chapter, index: ordinal + 1 })) });

function vectorRun(reconcile, vector) {
  const book = { id: "local-synthetic", catalogRevision: "r1", progress: null, progressRecovery: null };
  if (vector.progress?.status === "resolved") book.progress = vector.progress;
  else if (vector.progress) book.progressRecovery = vector.progress;
  const existing = vector.oldChapters.length ? { book, chapters: vector.oldChapters } : null;
  let next = 0;
  const result = reconcile(existing, { book: { id: book.id }, chapters: vector.incomingChapters }, { allocateId: () => `new-${++next}`, allocateRevision: () => "r2" });
  assert.deepEqual(plain(result.chapters.map(chapter => chapter.id)), vector.ids);
  const progress = result.book.progress ? { status: "resolved", ...result.book.progress } : result.book.progressRecovery;
  assert.equal(progress?.status ?? null, vector.status);
  for (const field of ["reason", "chapterId", "chapterIndex", "scrollRatio", "candidate"]) if (Object.hasOwn(vector, field)) assert.deepEqual(plain(progress[field]), vector[field]);
  return result;
}
for (const vector of vectors) pureTest(`shared Node/Python/Android vector: ${vector.name}`, reconcile => vectorRun(reconcile, vector));
pureTest("fresh ID allocator cannot collide with old IDs, duplicate new IDs or blank IDs", reconcile => {
  const existing = { book: { id: "x", catalogRevision: "r1" }, chapters: [{ id: "old", index: 1, title: "A", content: "old" }] };
  const incoming = { book: { id: "x" }, chapters: [{ index: 1, title: "A", content: "new" }, { index: 2, title: "B", content: "other" }] };
  for (const id of ["old", "", "same-new"]) assert.throws(() => reconcile(existing, incoming, { allocateId: () => id, allocateRevision: () => "r2" }), /身份/);
});
pureTest("a title hint cannot steal another exact-matched identity or duplicate body", reconcile => {
  const before = { book: { id: "x", catalogRevision: "r1", progress: { chapterId: "a", chapterIndex: 1, scrollRatio: 0.6, catalogRevision: "r1" } },
    chapters: [{ id: "a", index: 1, title: "A", content: "old A" }, { id: "b", index: 2, title: "B", content: "body B" }] };
  for (const chapters of [[{ index: 1, title: "A", content: "body B" }], [{ index: 1, title: "A", content: "changed" }, { index: 2, title: "C", content: "changed" }]]) {
    let n = 0; const result = reconcile(before, { book: { id: "x" }, chapters }, { allocateId: () => `new-${++n}`, allocateRevision: () => "r2" });
    assert.equal(result.book.progress, null); assert.equal(result.book.progressRecovery.status, "unresolved"); assert.equal(result.book.progressRecovery.candidate, undefined);
  }
});
pureTest("another reimport retires a previous review candidate without reviving progress", reconcile => {
  const existing = { book: { id: "x", catalogRevision: "r1", progressRecovery: { status: "needs_review", reason: "content_changed", previous: { chapterId: "old", chapterIndex: 1, scrollRatio: 0.8, catalogRevision: "r0" }, candidate: { chapterId: "now", chapterIndex: 1, scrollRatio: 0, catalogRevision: "r1" } } }, chapters: [{ id: "now", index: 1, title: "A", content: "body" }] };
  const result = reconcile(existing, { book: { id: "x" }, chapters: existing.chapters }, { allocateRevision: () => "r2" });
  assert.equal(result.book.progress, null); assert.equal(result.book.progressRecovery.status, "unresolved"); assert.equal(result.book.progressRecovery.candidate, undefined); assert.equal(result.book.progressRecovery.previous.scrollRatio, 0.8);
});
pureTest("invalid previous ratios are explicit unresolved anchors, never silently zero", reconcile => {
  for (const ratio of [-0.2, 2, NaN, Infinity]) {
    const existing = { book: { id: "x", catalogRevision: "r1", progress: { chapterId: "a", chapterIndex: 1, scrollRatio: ratio, catalogRevision: "r1" } }, chapters: [{ id: "a", index: 1, title: "A", content: "body" }] };
    const result = reconcile(existing, { book: { id: "x" }, chapters: existing.chapters }, { allocateRevision: () => "r2" });
    assert.equal(result.book.progress, null); assert.equal(result.book.progressRecovery.reason, "invalid_ratio"); assert.equal(result.book.progressRecovery.previous.invalidScrollRatio, true);
    assert.equal(result.book.progressRecovery.previous.scrollRatio, Number.isFinite(ratio) ? ratio : null);
  }
});

test("v2 upgrade keeps CURRENT layered text and unique IDs, not legacy books content", async h => {
  await h.seedV2(); const before = await snapshot(h), oldIds = before.chapterMetadata.map(chapter => chapter.id);
  const summary = (await h.api.loadLocalNovelSummaries())[0], full = await h.api.readLocalNovelEntry("local-1");
  assert.equal(full.book.title, "v2-current title"); assert.deepEqual(plain(full.chapters.map(chapter => chapter.content)), entry("v2-current").chapters.map(chapter => chapter.content));
  assert.deepEqual(plain(full.chapters.map(chapter => chapter.id)), oldIds); assert.deepEqual(await h.rows("books"), before.books);
  assert.equal(summary.book.progress, null); assert.equal(summary.book.progressRecovery.reason, "legacy_unverified"); assert.equal(summary.book.progressRecovery.previous.scrollRatio, 0.1);
  assert.equal(summary.book.progressRecovery.previous.chapterId, null); assert.ok(summary.book.catalogRevision);
  const db = await h.open(3); assert.equal(db.version, 3); assert.ok(db.transaction("chapterMetadata").objectStore("chapterMetadata").indexNames.contains("chapterId")); db.close();
  h.forceClose(); await new Promise(resolve => setTimeout(resolve, 0)); const reopened = await h.api.readLocalNovelEntry("local-1"); assert.deepEqual(plain(reopened), plain(full));
});
test("malformed v2 body aborts upgrade and preserves every original store", async h => {
  await h.seedV2(); const db = await h.open(2), tx = db.transaction("chapterBodies", "readwrite");
  const row = await requestResult(tx.objectStore("chapterBodies").get(["local-1", 2])); row.generation = "wrong-generation"; await requestResult(tx.objectStore("chapterBodies").put(row));
  await new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onabort = reject; }); db.close();
  const before = await snapshot(h); await assert.rejects(h.api.loadLocalNovelSummaries(), /不完整/);
  assert.deepEqual(await snapshot(h), before); const preserved = await h.open(2); assert.equal(preserved.version, 2); preserved.close();
});
test("abort after migration put success rolls back schema and all data", async h => {
  await h.seedV2(); const before = await snapshot(h); let aborted = false;
  h.controls.after = call => { if (!aborted && call.method === "put" && call.store === "bookMetadata") { aborted = true; call.transaction.abort(); } };
  await assert.rejects(h.api.loadLocalNovelSummaries()); h.controls.after = null;
  assert.equal(aborted, true); assert.deepEqual(await snapshot(h), before); const db = await h.open(2); assert.equal(db.version, 2); db.close();
});
test("insert-only CAS prevents a concurrent same-book import from replacing the winner", async h => {
  const results = await Promise.all(["first", "second"].map(label => h.api.saveLocalNovelEntry(entry(label), { expectedGeneration: null })));
  assert.equal(results.filter(Boolean).length, 1); const full = await h.api.readLocalNovelEntry("local-1"); assert.equal(full.book.title, results.find(Boolean).book.title);
});
test("two imports from one generation permit exactly one complete replacement", async h => {
  const before = await fresh(h); const results = await Promise.all(["first", "second"].map(label => h.api.saveLocalNovelEntry(entry(label), { expectedGeneration: before.generation })));
  assert.equal(results.filter(Boolean).length, 1); const after = await h.api.readLocalNovelEntry("local-1"); assert.equal(after.book.title, results.find(Boolean).book.title);
  assert.ok(after.chapters.every(chapter => chapter.content.startsWith(after.book.title.split(" ")[0])));
});
test("reimport reads latest progress inside its transaction, not caller's stale full entry", async h => {
  const before = await fresh(h); await selected(h, before, 2, 0.85);
  const reordered = replace(before, [before.chapters[2], before.chapters[0], before.chapters[1], before.chapters[3]]);
  const result = await h.api.saveLocalNovelEntry(reordered, { expectedGeneration: before.generation });
  assert.equal(result.book.progress.chapterId, before.chapters[1].id); assert.equal(result.book.progress.chapterIndex, 3); assert.equal(result.book.progress.scrollRatio, 0.85);
});
test("new imports ignore ordinal IDs; insert and reorder preserve only exact unique IDs", async h => {
  const before = await fresh(h); assert.ok(before.chapters.every((chapter, i) => chapter.id !== entry().chapters[i].id));
  await selected(h, before, 2, 0.7); const prelude = { title: "序言", content: "NEW unique prelude", preamble: true };
  const result = await h.api.saveLocalNovelEntry(replace(before, [prelude, before.chapters[1], before.chapters[0], ...before.chapters.slice(2)]), { expectedGeneration: before.generation });
  const full = await h.api.readLocalNovelEntry("local-1"); assert.notEqual(full.book.catalogRevision, before.book.catalogRevision);
  assert.equal(full.chapters[1].id, before.chapters[1].id); assert.equal(result.book.progress.chapterId, before.chapters[1].id); assert.equal(result.book.progress.scrollRatio, 0.7);
});
test("changed chapter gets new ID and review candidate; repeated import cannot resurrect old ratio", async h => {
  const before = await fresh(h); await selected(h, before, 2, 0.7);
  const changed = clone(before); changed.chapters[1].content = "entirely changed second chapter";
  const result = await h.api.saveLocalNovelEntry(changed, { expectedGeneration: before.generation });
  assert.equal(result.book.progress, null); assert.equal(result.book.progressRecovery.status, "needs_review"); assert.notEqual(result.book.progressRecovery.candidate.chapterId, before.chapters[1].id);
  assert.equal(result.book.progressRecovery.candidate.scrollRatio, 0); assert.equal(result.book.progressRecovery.previous.scrollRatio, 0.7);
  const again = await h.api.saveLocalNovelEntry(changed, { expectedGeneration: result.generation });
  assert.equal(again.book.progress, null); assert.equal(again.book.progressRecovery.status, "unresolved"); assert.equal(again.book.progressRecovery.candidate, undefined);
});
test("deleted chapter and duplicate bodies never clamp or map by ordinal or title", async h => {
  const before = await fresh(h); await selected(h, before, 2, 0.7);
  const removed = await h.api.saveLocalNovelEntry(replace(before, before.chapters.filter(chapter => chapter.index !== 2)), { expectedGeneration: before.generation });
  assert.equal(removed.book.progress, null); assert.equal(removed.book.progressRecovery.reason, "no_unique_match"); assert.equal(removed.book.progressRecovery.previous.chapterId, before.chapters[1].id);
  const full = await h.api.readLocalNovelEntry("local-1"); await selected(h, full, 1, 0.4);
  const duplicate = await h.api.saveLocalNovelEntry(replace(full, [full.chapters[0], { ...full.chapters[0], title: "another title" }]), { expectedGeneration: full.generation });
  assert.equal(duplicate.book.progress, null); assert.equal(duplicate.book.progressRecovery.reason, "ambiguous_content");
});
test("ID, revision and generation each fence progress; a valid explicit selection clears recovery", async h => {
  const before = await fresh(h); const first = before.chapters[0];
  for (const progress of [
    { chapterId: first.id, chapterIndex: 1, scrollRatio: 0.4, catalogRevision: "stale" },
    { chapterId: "wrong", chapterIndex: 1, scrollRatio: 0.4, catalogRevision: before.book.catalogRevision },
    { chapterId: first.id, chapterIndex: 2, scrollRatio: 0.4, catalogRevision: before.book.catalogRevision }
  ]) assert.equal(await h.api.saveLocalNovelProgress("local-1", progress, { expectedGeneration: before.generation }), null);
  assert.equal(await h.api.saveLocalNovelProgress("local-1", { chapterIndex: 1, scrollRatio: 0.4 }), null);
  await selected(h, before, 1, 0.3); const changed = clone(before); changed.chapters[0].content = "changed body";
  const next = await h.api.saveLocalNovelEntry(changed, { expectedGeneration: before.generation });
  assert.equal(await h.api.saveLocalNovelProgress("local-1", { chapterIndex: 1, scrollRatio: 0.9 }, { expectedGeneration: next.generation }), null);
  assert.equal(await selected(h, before, 1, 0.9), null);
  const full = await h.api.readLocalNovelEntry("local-1"), saved = await selected(h, full, 1, 0);
  assert.equal(saved.book.progressRecovery, null); assert.equal(saved.book.progress.chapterId, full.chapters[0].id); assert.equal(saved.book.progress.scrollRatio, 0);
});
test("chapter reads use one body and can reject an old ID or revision at unchanged ordinal", async h => {
  const before = await fresh(h), chapter = before.chapters[1]; h.operations.length = 0;
  assert.equal((await h.api.readLocalNovelChapter("local-1", 2, { chapterId: chapter.id, catalogRevision: before.book.catalogRevision })).chapter.id, chapter.id);
  assert.equal(h.operations.filter(call => call.store === "chapterBodies").length, 1);
  assert.equal(await h.api.readLocalNovelChapter("local-1", 2, { chapterId: "wrong" }), null);
  assert.equal(await h.api.readLocalNovelChapter("local-1", 2, { catalogRevision: "wrong" }), null);
});
test("first remote cache maps source identity only with exact source revision proof", async h => {
  const remote = entry(); remote.book.sourceCatalogRevision = "source-r1"; remote.book.sourceProgress = { chapterId: "source-2", chapterIndex: 2, scrollRatio: 0.8, catalogRevision: "source-r1" };
  remote.chapters.forEach(chapter => { chapter.sourceChapterId = `source-${chapter.index}`; chapter.sourceCatalogRevision = "source-r1"; });
  const saved = await h.api.saveLocalNovelEntry(remote, { expectedGeneration: null }), full = await h.api.readLocalNovelEntry("local-1");
  assert.equal(saved.book.progress.chapterId, full.chapters[1].id); assert.notEqual(saved.book.progress.chapterId, "source-2"); assert.equal(saved.book.progress.scrollRatio, 0.8);
  assert.equal(full.chapters[1].sourceChapterId, "source-2"); assert.equal(full.book.sourceProgress, undefined);
  await selected(h, full, 3, 0.25); remote.book.sourceProgress.scrollRatio = 0.99;
  const refreshed = await h.api.saveLocalNovelEntry(remote, { expectedGeneration: saved.generation }); assert.equal(refreshed.book.progress.chapterId, full.chapters[2].id); assert.equal(refreshed.book.progress.scrollRatio, 0.25);
});
test("remote mismatched revision and duplicate source ID stay unresolved with source anchor", async h => {
  for (const damage of ["wrong-revision", "duplicate-source-id"]) {
    const remote = entry(damage, damage); remote.book.sourceCatalogRevision = "source-r1";
    remote.book.sourceProgress = { chapterId: "source-2", chapterIndex: 2, scrollRatio: 0.8, catalogRevision: damage === "wrong-revision" ? "old-r0" : "source-r1" };
    remote.chapters.forEach(chapter => { chapter.sourceChapterId = damage === "duplicate-source-id" ? "source-2" : `source-${chapter.index}`; chapter.sourceCatalogRevision = "source-r1"; });
    const saved = await h.api.saveLocalNovelEntry(remote, { expectedGeneration: null }); assert.equal(saved.book.progress, null); assert.equal(saved.book.progressRecovery.reason, "source_anchor_mismatch");
    assert.equal(saved.book.progressRecovery.previous.chapterId, null); assert.equal(saved.book.progressRecovery.previous.sourceChapterId, "source-2");
  }
});

let passed = 0, negatives = 0;
for (const item of pureTests) { item.run(reconcileLocalNovelEntry); passed++; console.log(`PASS ${item.name}`); }
for (const item of tests) { const h = harness(); try { await item.run(h); passed++; console.log(`PASS ${item.name}`); } finally { h.dispose(); } }
const mutations = [
  { name: "CAS removed", anchor: "if (expectedGeneration !== undefined && (rows.book?.generation ?? null) !== expectedGeneration)", replacement: "if (false)", test: "insert-only CAS" },
  { name: "v2 upgrade replays old backup", anchor: "const legacyWholeBook = event.oldVersion < 2;", replacement: "const legacyWholeBook = event.oldVersion < 3;", test: "v2 upgrade keeps" },
  { name: "ordinal write without generation allowed", anchor: 'if (!anchored && (typeof expectedGeneration !== "string" || !expectedGeneration)) return null;', replacement: "/* unsafe ordinal write */", test: "ID, revision and generation" },
  { name: "progress revision gate removed", anchor: 'if (anchored && (typeof progress.chapterId !== "string" || !progress.chapterId || progress.catalogRevision !== metadata.book.catalogRevision))', replacement: 'if (anchored && (typeof progress.chapterId !== "string" || !progress.chapterId))', test: "ID, revision and generation" }
];
for (const mutation of mutations) {
  assert.equal(productionSource.split(mutation.anchor).length, 2, `mutation anchor: ${mutation.name}`);
  const h = harness({ source: productionSource.replace(mutation.anchor, mutation.replacement) }); let failure;
  try { await tests.find(item => item.name.startsWith(mutation.test)).run(h); } catch (error) { failure = error; } finally { h.dispose(); }
  assert.equal(failure?.code, "ERR_ASSERTION", `mutation must fail at a behavioral assertion: ${mutation.name}: ${failure?.stack}`); negatives++; console.log(`CONTROL rejected ${mutation.name}`);
}
const pureMutation = identitySource.replace('exact?.length === 1 && newBodies.get(chapter.content)?.length === 1', 'exact?.length === 1');
assert.notEqual(pureMutation, identitySource);
const unsafe = vm.runInNewContext(`${pureMutation.replace(/^export /gm, "")}\nreconcileLocalNovelEntry`);
assert.throws(() => vectorRun(unsafe, vectors.find(item => item.name.startsWith("duplicate incoming"))), { code: "ERR_ASSERTION" }); negatives++;
const old = harness({ source: frozenV2Source });
try {
  await old.seed(); await old.api.loadLocalNovelSummaries(); const replaced = await old.api.saveLocalNovelEntry(entry("changed"));
  assert.throws(() => assert.equal(replaced.book.progress, null), { code: "ERR_ASSERTION" }); negatives++;
  console.log("CONTROL frozen v2 reproduces ordinal progress carry-over after rewritten text");
} finally { old.dispose(); }
console.log(`Local chapter identity: ${passed} production pure/storage scenarios, ${negatives} executable historical/mutation controls. Synthetic data only; no native-browser or device claim.`);
