import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { harness, entry, plain, requestResult, productionSource } from "./fixtures/android-local-novel-v2-harness.mjs";

// Current production source on fake-indexeddb. Real-browser verification is separate.
const protectedStores = new Set(["books", "chapterBodies", "bookExtras"]);
const check = async (name, action, options) => test(name, async () => { const h = harness(options); try { await action(h); } finally { h.dispose(); } });
const migrate = async h => {
  await h.seed(); const catalog = await h.api.readLocalNovelCatalog("local-1"), chapter = catalog.chapters[0];
  h.baselineGeneration = catalog.generation;
  assert.equal(catalog.book.progress, null); assert.equal(catalog.book.progressRecovery.reason, "legacy_unverified");
  // Explicit user chapter selection establishes the baseline for the old writer
  // lifecycle tests; migration itself must never declare old ordinal progress safe.
  return h.api.saveLocalNovelProgress("local-1", { chapterId: chapter.id, chapterIndex: chapter.index, scrollRatio: 0.1, catalogRevision: catalog.book.catalogRevision }, { expectedGeneration: catalog.generation });
};

await check("v1 upgrade preserves original rows, identities, text and unknown fields", async h => {
  await h.seed(); const before = await h.rows("books"), summaries = await h.api.loadLocalNovelSummaries();
  assert.equal(summaries.length, 1); assert.equal(summaries[0].book.id, "local-1"); assert.equal("chapters" in summaries[0], false);
  assert.ok(summaries[0].generation); assert.equal(summaries[0].book.localGeneration, summaries[0].generation);
  assert.equal(JSON.stringify(summaries).includes("PRIVATE_TEXT_FRAGMENT"), false); assert.deepEqual(await h.rows("books"), before);
  const full = await h.api.readLocalNovelEntry("local-1");
  for (const field of ["importFingerprint", "futureField"]) assert.deepEqual(plain(full[field]), entry()[field]);
  assert.deepEqual(plain(full.book.metadata), entry().book.metadata); assert.equal(full.book.sourceKey, entry().book.sourceKey);
  assert.deepEqual(plain(full.chapters.map(ch => ch.content)), entry().chapters.map(ch => ch.content));
  assert.deepEqual(plain(full.chapters[0].metadata), entry().chapters[0].metadata);
  assert.equal(full.book.progress, null); assert.equal(full.book.progressRecovery.reason, "legacy_unverified");
  const db = await h.open(3); assert.equal(db.version, 3); db.close();
});
await check("summary, catalog and progress never touch legacy/body/extras stores", async h => {
  const summary = await migrate(h); h.operations.length = 0;
  h.controls.before = call => { if (protectedStores.has(call.store)) throw new Error(`forbidden ${call.store}`); };
  assert.equal((await h.api.loadLocalNovelSummaries()).length, 1);
  assert.equal((await h.api.readLocalNovelSummary("local-1")).book.title, entry().book.title);
  const catalog = await h.api.readLocalNovelCatalog("local-1"); assert.equal(catalog.chapters.length, 4); assert.ok(catalog.chapters.every(ch => !("content" in ch)));
  const saved = await h.api.saveLocalNovelProgress("local-1", { chapterIndex: 2, scrollRatio: 0.65 }, { expectedGeneration: summary.generation });
  assert.equal(saved.book.progress.scrollRatio, 0.65); assert.equal("chapters" in saved, false);
  assert.ok(h.operations.every(call => !protectedStores.has(call.store))); await assert.rejects(h.api.readLocalNovelEntry("local-1"), /forbidden/);
  h.controls.before = null;
});
await check("reader fetches one body; neighboring chapters and TOC remain metadata only", async h => {
  await migrate(h); h.operations.length = 0; const data = await h.api.readLocalNovelChapter("local-1", 2);
  assert.equal(data.chapter.content, entry().chapters[1].content); assert.equal(data.prev.index, 1); assert.equal(data.next.index, 3);
  assert.equal("content" in data.prev, false); assert.equal("content" in data.next, false); assert.ok(data.chapters.every(ch => !("content" in ch)));
  const bodies = h.operations.filter(call => call.store === "chapterBodies"); assert.equal(bodies.length, 1); assert.equal(bodies[0].method, "get");
  assert.deepEqual(plain(bodies[0].args[0]), ["local-1", 2]); assert.equal(await h.api.readLocalNovelChapter("wrong-book", 2), null);
});
const writers = [
  { name: "save entry", method: "put", store: "bookMetadata", run: h => h.api.saveLocalNovelEntry(entry("replacement")) },
  { name: "save progress", method: "put", store: "readingProgress", run: h => h.api.saveLocalNovelProgress("local-1", { chapterIndex: 3, scrollRatio: 0.6 }, { expectedGeneration: h.baselineGeneration }) },
  { name: "delete entry", method: "delete", store: "bookMetadata", run: h => h.api.deleteLocalNovelEntry("local-1") }
];
for (const writer of writers) {
  await check(`${writer.name}: request success does not settle before transaction commit`, async h => {
    await migrate(h); let settled = false, completed = false, boundary;
    h.controls.after = call => { if (!boundary && call.method === writer.method && call.store === writer.store) {
      call.transaction.addEventListener("complete", () => { completed = true; });
      boundary = (async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); assert.equal(completed, false); assert.equal(settled, false); })();
    } };
    const value = await writer.run(h).then(result => { settled = true; return result; }); await boundary;
    assert.ok(boundary); assert.equal(completed, true); if (writer.name !== "delete entry") assert.equal("chapters" in value, false);
  });
  await check(`${writer.name}: abort after request success rolls back all stores`, async h => {
    await migrate(h); const before = plain(await h.api.readLocalNovelEntry("local-1")); let aborted = false;
    h.controls.after = call => { if (!aborted && call.method === writer.method && call.store === writer.store) { aborted = true; call.transaction.abort(); } };
    await assert.rejects(writer.run(h)); h.controls.after = null; assert.ok(aborted);
    assert.deepEqual(plain(await h.api.readLocalNovelEntry("local-1")), before); assert.deepEqual(await h.rows("books"), [entry()]);
  });
}
await check("deletion followed by late progress cannot recreate any old or new record", async h => {
  const summary = await migrate(h), deletion = h.api.deleteLocalNovelEntry("local-1");
  const progress = h.api.saveLocalNovelProgress("local-1", { chapterIndex: 2 }, { expectedGeneration: summary.generation });
  await deletion; assert.equal(await progress, null);
  for (const store of ["books", "bookMetadata", "chapterMetadata", "chapterBodies", "readingProgress", "bookExtras"]) assert.equal((await h.rows(store)).length, 0);
});
await check("same-ID reimport replaces text atomically and rejects old-generation progress", async h => {
  const before = await migrate(h), replacement = entry("replacement"); replacement.chapters.pop(); const saved = await h.api.saveLocalNovelEntry(replacement);
  assert.notEqual(saved.generation, before.generation);
  assert.equal(await h.api.saveLocalNovelProgress("local-1", { chapterIndex: 3, scrollRatio: 0.9 }, { expectedGeneration: before.generation }), null);
  const full = await h.api.readLocalNovelEntry("local-1"); assert.equal(full.chapters.length, 3); assert.equal(full.chapters[0].content, replacement.chapters[0].content);
  assert.equal(full.book.progress, null); assert.equal(full.book.progressRecovery.reason, "content_changed"); assert.equal(full.book.progressRecovery.previous.scrollRatio, 0.1);
  const selected = full.chapters[2];
  assert.equal((await h.api.saveLocalNovelProgress("local-1", { chapterId: selected.id, catalogRevision: full.book.catalogRevision, chapterIndex: 3, scrollRatio: 0.7 }, { expectedGeneration: saved.generation })).book.progress.scrollRatio, 0.7);
});
await check("consecutive progress writes retain order without rewriting bodies", async h => {
  const summary = await migrate(h), before = await h.rows("chapterBodies");
  const results = await Promise.all([0.2, 0.8].map(scrollRatio => h.api.saveLocalNovelProgress("local-1", { chapterIndex: 2, scrollRatio }, { expectedGeneration: summary.generation })));
  assert.deepEqual(results.map(result => result.book.progress.scrollRatio), [0.2, 0.8]); assert.equal((await h.api.readLocalNovelSummary("local-1")).book.progress.scrollRatio, 0.8); assert.deepEqual(await h.rows("chapterBodies"), before);
});
await check("progress does not request persistence or recalculate whole-book bytes", async h => {
  const summary = await migrate(h), saved = await h.api.saveLocalNovelProgress("local-1", { chapterIndex: 3, scrollRatio: 0.5 }, { expectedGeneration: h.baselineGeneration }); assert.equal(h.controls.persistCalls, 0); assert.equal(saved.bytes, summary.bytes);
}, { persist: () => new Promise(() => {}) });
await check("deletion queued during progress reads wins over the later progress put", async h => {
  await migrate(h); let deletion;
  h.controls.after = call => { if (!deletion && call.store === "bookMetadata" && call.method === "get") deletion = h.api.deleteLocalNovelEntry("local-1"); };
  await h.api.saveLocalNovelProgress("local-1", { chapterIndex: 2 }, { expectedGeneration: h.baselineGeneration }); await deletion; h.controls.after = null; assert.equal(await h.api.readLocalNovelSummary("local-1"), null);
});
await check("missing entries stay missing and invalid writes have no side effects", async h => {
  await h.seed([]); await h.api.loadLocalNovelSummaries(); assert.equal(await h.api.saveLocalNovelProgress("missing", { chapterIndex: 2 }), null); assert.equal(await h.api.saveLocalNovelProgress(""), null);
  assert.equal(await h.api.readLocalNovelEntry(""), null); assert.equal(await h.api.deleteLocalNovelEntry(""), undefined); await assert.rejects(h.api.saveLocalNovelEntry({})); assert.equal((await h.rows("bookMetadata")).length, 0);
});
for (const method of ["get", "put"]) await check(`synchronous ${method} failure propagates and rolls back progress`, async h => {
  await migrate(h); const before = plain(await h.api.readLocalNovelSummary("local-1")), sentinel = new Error(`injected ${method}`);
  h.controls.before = call => { if (call.method === method && ["bookMetadata", "readingProgress"].includes(call.store)) throw sentinel; };
  await assert.rejects(h.api.saveLocalNovelProgress("local-1", { chapterIndex: 2 }, { expectedGeneration: h.baselineGeneration }), error => error === sentinel); h.controls.before = null; assert.deepEqual(plain(await h.api.readLocalNovelSummary("local-1")), before);
});
await check("denied persistence remains nonfatal when importing", async h => {
  await migrate(h); assert.equal((await h.api.saveLocalNovelEntry(entry("replacement"))).book.title, "replacement title"); assert.equal(h.controls.persistCalls, 1);
}, { persist: () => Promise.reject(new Error("denied")) });
for (const [name, damage] of [
  ["missing body", row => { row.chapters[0].content = null; }], ["duplicate ordinal", row => { row.chapters[1].index = 1; }],
  ["contradictory parent", row => { row.chapters[0].bookId = "another-book"; }], ["no chapters", row => { row.chapters = []; }]
]) await check(`migration with ${name} leaves the entire v1 database intact`, async h => {
  const damaged = entry("damaged", "local-2"); damage(damaged); await h.seed([entry(), damaged]); await assert.rejects(h.api.loadLocalNovelSummaries());
  const db = await h.open(1); assert.equal(db.version, 1); assert.deepEqual(Array.from(db.objectStoreNames), ["books"]); db.close(); assert.deepEqual(await h.rows("books"), [entry(), damaged]);
});
await check("synchronous open failure can be retried", async h => {
  await h.seed(); const original = h.indexedDB.open; let calls = 0; h.indexedDB.open = (...args) => { if (++calls === 1) throw new Error("transient open"); return original(...args); };
  await assert.rejects(h.api.loadLocalNovelSummaries(), /transient open/); assert.equal((await h.api.loadLocalNovelSummaries()).length, 1); assert.equal(calls, 2);
});
await check("blocked open fails, its late upgrade aborts, explicit retry succeeds", async h => {
  await h.seed(); const blocker = await h.open(1); await assert.rejects(h.api.loadLocalNovelSummaries(), /升级|占用|blocked/);
  blocker.close(); const v1 = await h.open(1); assert.equal(v1.version, 1); v1.close(); assert.equal((await h.api.loadLocalNovelSummaries()).length, 1);
});
await check("abnormal connection close permits reopening", async h => {
  await migrate(h); h.forceClose(); await new Promise(resolve => setTimeout(resolve, 0)); assert.equal((await h.api.loadLocalNovelSummaries()).length, 1);
});
await check("versionchange closes our connection and a future schema is never erased", async h => {
  await migrate(h); const upgrade = h.indexedDB.open(h.name, 4); upgrade.onupgradeneeded = () => upgrade.result.createObjectStore("futureVersion");
  const db = await requestResult(upgrade); assert.equal(db.version, 4); db.close(); await assert.rejects(h.api.loadLocalNovelSummaries());
  const preserved = await h.open(4); assert.ok(preserved.objectStoreNames.contains("futureVersion")); preserved.close();
});
await check("frozen v1 implementation fails the metadata-only access boundary", async h => {
  await h.seed(); h.controls.before = call => { if (call.store === "books") throw new Error("legacy full-book access"); }; await assert.rejects(h.api.loadLocalNovelEntries(), /legacy full-book access/);
}, { source: fs.readFileSync(new URL("./fixtures/android-local-novels-v1.js", import.meta.url), "utf8") });
assert.match(productionSource, /const LOCAL_NOVEL_DB_VERSION = 3;/);
console.log("Boundary: current-source simulated IndexedDB tests; native-browser evidence is separate. Historical v1 regressions remain in fixtures/android-local-novels-v1-regressions.mjs.");
