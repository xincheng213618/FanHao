// This page executes the complete production module against browser-native IDB.
// It never imports a DB emulator, connects to an app origin, or opens a fixed DB.
const PREFIX = "fanhao-idb-v2-fixture-";
const generated = new Set();
const connections = new Set();
const opened = [];
const cases = [];
const status = document.querySelector("#status");
const counts = document.querySelector("#counts");
const list = document.querySelector("#cases");
const reportNode = document.querySelector("#report");
const runButton = document.querySelector("#run");
const rawOpen = IDBFactory.prototype.open;
const rawDelete = IDBFactory.prototype.deleteDatabase;
const FORBIDDEN = new Set(["books", "chapterBodies", "bookExtras"]);
let currentChecks = 0;
let totalChecks = 0;
let persistenceCalls = 0;
let running = false;
let activeRunId = "";

function check(condition, message) {
  currentChecks++; totalChecks++;
  if (!condition) throw new Error(message);
}
function equal(actual, expected, message) { check(JSON.stringify(actual) === JSON.stringify(expected), `${message}: ${JSON.stringify(actual)} != ${JSON.stringify(expected)}`); }
async function rejects(action, message) {
  let error;
  try { await action(); } catch (caught) { error = caught; }
  check(Boolean(error), message);
  return error;
}
function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
async function bounded(promise, message, ms = 10000) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); })]); }
  finally { clearTimeout(timer); }
}
function requestValue(request) { return new Promise((resolve, reject) => { request.addEventListener("success", () => resolve(request.result), { once: true }); request.addEventListener("error", () => reject(request.error), { once: true }); }); }
function transactionDone(transaction) { return new Promise((resolve, reject) => { transaction.addEventListener("complete", resolve, { once: true }); transaction.addEventListener("abort", () => reject(transaction.error || new Error("transaction aborted")), { once: true }); }); }
function patch(object, key, replacement) {
  const own = Object.getOwnPropertyDescriptor(object, key);
  Object.defineProperty(object, key, { configurable: true, writable: true, value: replacement });
  return () => own ? Object.defineProperty(object, key, own) : delete object[key];
}
async function patches(restorers, action) { try { return await action(); } finally { for (const restore of restorers.reverse()) restore(); } }
function requireGenerated(name) { if (!generated.has(name)) throw new Error(`Safety fence refused database: ${String(name)}`); }
IDBFactory.prototype.open = function(name, ...rest) {
  requireGenerated(name);
  const request = Reflect.apply(rawOpen, this, [name, ...rest]);
  opened.push({ name, version: rest[0], request });
  const retain = () => connections.add(request.result);
  request.addEventListener("upgradeneeded", retain);
  request.addEventListener("success", retain);
  return request;
};
IDBFactory.prototype.deleteDatabase = function(name) { requireGenerated(name); return Reflect.apply(rawDelete, this, [name]); };
// Do not modify persistence permission/state just to verify DB transactions.
if (navigator.storage?.persist) patch(navigator.storage, "persist", () => { persistenceCalls++; return Promise.resolve(false); });

function fixtureEntry(id = "local:fixture:a", extra = {}) {
  const stamp = "2024-01-02T03:04:05.000Z";
  return {
    id, book: { id, title: "合成测试书", author: "隔离样本", category: "本地", sourceType: "local-file", fileName: "synthetic.txt", updatedAt: stamp },
    chapters: [
      { id: `${id}-00001`, bookId: id, index: 1, title: "第一章", content: "  合成正文 A\n\n中文与🙂\r\n结尾  ", updatedAt: stamp },
      { id: `${id}-00002`, bookId: id, index: 2, title: "第二章", content: "合成正文 B，禁止跨章读取。", updatedAt: stamp }
    ], createdAt: stamp, updatedAt: stamp, ...extra
  };
}
async function fresh() {
  const caseId = crypto.randomUUID();
  const name = `${PREFIX}${caseId}`;
  generated.add(name);
  const api = await import(`/storage.js?run=${activeRunId}&case=${caseId}`);
  return { caseId, name, api };
}
async function seedV1(name, rows) {
  const request = indexedDB.open(name, 1);
  request.onupgradeneeded = () => {
    const store = request.result.createObjectStore("books", { keyPath: "id" });
    store.createIndex("updatedAt", "updatedAt"); store.createIndex("title", "book.title");
  };
  const db = await requestValue(request);
  const tx = db.transaction("books", "readwrite");
  const done = transactionDone(tx);
  for (const row of rows) tx.objectStore("books").put(row);
  await done;
  db.close();
}
async function inspect(name, version, action) {
  const db = await bounded(requestValue(indexedDB.open(name, version)), "isolated database open timed out");
  try { return await action(db); } finally { db.close(); }
}
function countOpens(name) { return opened.filter((record) => record.name === name).length; }
function test(name, run) { cases.push({ name, run }); }
function summaryShape(value, message) {
  check(value && value.book && typeof value.id === "string", `${message}: summary shape`);
  check(!Object.hasOwn(value, "chapters"), `${message}: no aggregate chapters`);
  check(typeof value.generation === "string" && value.generation.length > 0, `${message}: generation present`);
  equal(value.book.localGeneration, value.generation, `${message}: book generation agrees`);
  check(!Object.hasOwn(value.book, "content") && !Object.hasOwn(value.book, "chapters"), `${message}: no body in summary`);
}
function metadataOnly(chapters, message) { check(Array.isArray(chapters), `${message}: chapters array`); for (const chapter of chapters) check(!Object.hasOwn(chapter, "content"), `${message}: chapter has no content`); }
function storeFence() {
  const restorers = [];
  const accesses = [];
  for (const [prototype, methods] of [
    [IDBObjectStore.prototype, ["get", "getAll", "getKey", "getAllKeys", "openCursor", "openKeyCursor", "count", "put", "add", "delete", "clear", "index"]],
    [IDBIndex.prototype, ["get", "getAll", "getKey", "getAllKeys", "openCursor", "openKeyCursor", "count"]]
  ]) for (const method of methods) {
    const original = prototype[method];
    if (!original) continue;
    restorers.push(patch(prototype, method, function(...args) {
      const store = this instanceof IDBIndex ? this.objectStore : this;
      accesses.push({ store: store.name, method });
      if (FORBIDDEN.has(store.name)) throw new Error(`Forbidden body/legacy/extras access: ${store.name}.${method}`);
      return Reflect.apply(original, this, args);
    }));
  }
  return { restorers, accesses };
}

test("v2 fresh schema and explicit summary/catalog/chapter APIs", async () => {
  const { name, api } = await fresh();
  for (const key of ["loadLocalNovelSummaries", "readLocalNovelSummary", "readLocalNovelCatalog", "readLocalNovelChapter", "saveLocalNovelEntry", "saveLocalNovelProgress", "deleteLocalNovelEntry", "readLocalNovelEntry"]) check(typeof api[key] === "function", `${key} exported`);
  const entry = fixtureEntry();
  const saved = await api.saveLocalNovelEntry(entry);
  summaryShape(saved, "save result");
  const summary = await api.readLocalNovelSummary(entry.id); summaryShape(summary, "read summary");
  const catalog = await api.readLocalNovelCatalog(entry.id); metadataOnly(catalog.chapters, "catalog"); equal(catalog.chapters.length, 2, "catalog count");
  const reader = await api.readLocalNovelChapter(entry.id, 2);
  equal(reader.chapter.content, entry.chapters[1].content, "requested body preserved");
  equal(reader.prev.index, 1, "previous meta"); equal(reader.next, null, "no next chapter"); metadataOnly(reader.chapters, "reader directory");
  equal(reader.generation, saved.generation, "reader generation");
  await inspect(name, 2, (db) => { equal(db.version, 2, "actual native DB version"); for (const store of ["books", "bookMetadata", "chapterMetadata", "chapterBodies", "readingProgress", "bookExtras"]) check(db.objectStoreNames.contains(store), `store ${store}`); });
});

test("v1 upgrade retains raw rows, structured-clone extras and exact bodies", async () => {
  const { name, api } = await fresh();
  const entry = fixtureEntry();
  entry.unknownEntry = { flag: true, date: new Date("2020-06-07T00:00:00.000Z") };
  entry.book.privateUnknown = { text: "合成私有字段，不可出现在目录" };
  entry.chapters[0].unknownChapter = ["synthetic", 7];
  entry.blobExtra = new Blob(["synthetic opaque blob"], { type: "text/plain" });
  entry.book.progress = { chapterIndex: 2, scrollRatio: 0.44, updatedAt: entry.updatedAt, unknownProgress: "retained" };
  await seedV1(name, [entry]);
  const summaries = await api.loadLocalNovelSummaries(); equal(summaries.length, 1, "one migrated book"); summaryShape(summaries[0], "migrated summary");
  check(!Object.hasOwn(summaries[0].book, "privateUnknown"), "summary does not leak arbitrary book extras");
  const full = await api.readLocalNovelEntry(entry.id);
  equal(full.chapters.map((c) => c.content), entry.chapters.map((c) => c.content), "all exact migrated bodies");
  equal(full.book.privateUnknown, entry.book.privateUnknown, "book extras restored only by full API");
  equal(full.unknownEntry.date.toISOString(), entry.unknownEntry.date.toISOString(), "Date retained");
  equal(await full.blobExtra.text(), await entry.blobExtra.text(), "Blob retained");
  equal(full.chapters[0].unknownChapter, entry.chapters[0].unknownChapter, "chapter extras retained");
  await inspect(name, 2, async (db) => {
    const old = await requestValue(db.transaction("books").objectStore("books").get(entry.id));
    equal(old.book, entry.book, "legacy book untouched"); equal(old.chapters, entry.chapters, "legacy chapters untouched");
    equal(old.unknownEntry.date.toISOString(), entry.unknownEntry.date.toISOString(), "legacy Date untouched"); equal(await old.blobExtra.text(), await entry.blobExtra.text(), "legacy Blob untouched");
  });
});

test("summary/catalog/progress execute with real body/legacy/extras access denied", async () => {
  const { api } = await fresh(); const entry = fixtureEntry(); const saved = await api.saveLocalNovelEntry(entry);
  const fence = storeFence(); const beforePersist = persistenceCalls;
  await patches(fence.restorers, async () => {
    summaryShape((await api.loadLocalNovelSummaries())[0], "fenced list");
    summaryShape(await api.readLocalNovelSummary(entry.id), "fenced summary");
    metadataOnly((await api.readLocalNovelCatalog(entry.id)).chapters, "fenced catalog");
    const result = await api.saveLocalNovelProgress(entry.id, { chapterIndex: 2, scrollRatio: 0.71 }, { expectedGeneration: saved.generation });
    summaryShape(result, "fenced progress result"); equal(result.book.progress.chapterIndex, 2, "fenced progress index"); equal(result.book.progress.scrollRatio, 0.71, "fenced progress ratio");
  });
  check(fence.accesses.length > 0, "fence observed real IDB operations");
  check(fence.accesses.every((entry) => !FORBIDDEN.has(entry.store)), "production did not attempt even a swallowed forbidden access");
  equal(persistenceCalls, beforePersist, "progress does not request persistence again");
});

test("single-chapter reader reads exactly one target body, never aggregate bodies", async () => {
  const { api } = await fresh(); const entry = fixtureEntry(); await api.saveLocalNovelEntry(entry);
  const bodyReads = []; const restorers = [];
  for (const method of ["get", "getAll", "openCursor", "openKeyCursor", "getAllKeys"]) {
    const original = IDBObjectStore.prototype[method];
    restorers.push(patch(IDBObjectStore.prototype, method, function(...args) {
      if (this.name === "books") throw new Error("reader must not fall back to legacy aggregate");
      if (this.name === "chapterBodies") { if (method !== "get") throw new Error(`aggregate body operation ${method}`); bodyReads.push(args[0]); }
      return Reflect.apply(original, this, args);
    }));
  }
  for (const method of ["get", "getAll", "openCursor", "openKeyCursor"]) {
    const original = IDBIndex.prototype[method];
    restorers.push(patch(IDBIndex.prototype, method, function(...args) {
      if (["books", "chapterBodies"].includes(this.objectStore.name)) throw new Error(`reader aggregate index operation ${this.objectStore.name}.${method}`);
      return Reflect.apply(original, this, args);
    }));
  }
  await patches(restorers, async () => { const reader = await api.readLocalNovelChapter(entry.id, 1); equal(reader.chapter.content, entry.chapters[0].content, "single body"); metadataOnly(reader.chapters, "reader metas"); });
  equal(bodyReads, [[entry.id, 1]], "exact composite target body key only");
});

function abortAfterSuccess(storeName, method = "put") {
  const original = IDBObjectStore.prototype[method]; let aborted = false; let successSeen = false;
  const restore = patch(IDBObjectStore.prototype, method, function(...args) {
    const request = Reflect.apply(original, this, args);
    if (this.name === storeName && !aborted) {
      const tx = this.transaction;
      request.addEventListener("success", () => { if (!aborted) { successSeen = true; aborted = true; tx.abort(); } }, { once: true });
    }
    return request;
  });
  return { restore, get aborted() { return aborted; }, get successSeen() { return successSeen; } };
}
test("save promise only succeeds after transaction complete; abort after request success rolls back", async () => {
  const { api } = await fresh(); const entry = fixtureEntry(); await api.saveLocalNovelEntry(entry);
  let completed = false; const original = IDBDatabase.prototype.transaction;
  await patches([patch(IDBDatabase.prototype, "transaction", function(...args) { const tx = Reflect.apply(original, this, args); if (args[1] === "readwrite") tx.addEventListener("complete", () => { completed = true; }); return tx; })], async () => { await api.saveLocalNovelEntry(entry); check(completed, "save resolves after real complete event"); });
  const before = await api.readLocalNovelEntry(entry.id);
  const injected = abortAfterSuccess("bookMetadata");
  await patches([injected.restore], async () => { const replacement = fixtureEntry(); replacement.chapters[0].content = "must roll back"; await rejects(() => api.saveLocalNovelEntry(replacement), "save must reject transaction abort"); });
  check(injected.successSeen && injected.aborted, "real put success preceded abort");
  const after = await api.readLocalNovelEntry(entry.id); equal(after.chapters, before.chapters, "aborted replacement preserves bodies"); equal(after.generation, before.generation, "aborted replacement preserves generation");
});
test("progress abort is not reported as success and retains prior state", async () => {
  const { api } = await fresh(); const entry = fixtureEntry(); const saved = await api.saveLocalNovelEntry(entry);
  await api.saveLocalNovelProgress(entry.id, { chapterIndex: 1, scrollRatio: 0.2 }, { expectedGeneration: saved.generation });
  const injected = abortAfterSuccess("readingProgress");
  await patches([injected.restore], async () => { await rejects(() => api.saveLocalNovelProgress(entry.id, { chapterIndex: 2, scrollRatio: 0.9 }, { expectedGeneration: saved.generation }), "progress abort must reject"); });
  check(injected.aborted, "progress request really aborted"); equal((await api.readLocalNovelSummary(entry.id)).book.progress.scrollRatio, 0.2, "prior progress retained");
});
test("delete abort preserves book; committed delete plus late progress cannot revive it", async () => {
  const { api } = await fresh(); const entry = fixtureEntry(); const saved = await api.saveLocalNovelEntry(entry);
  const before = await api.readLocalNovelEntry(entry.id);
  const injected = abortAfterSuccess("bookMetadata", "delete");
  await patches([injected.restore], async () => { await rejects(() => api.deleteLocalNovelEntry(entry.id), "delete abort must reject"); });
  check(injected.aborted, "delete request really aborted"); check(Boolean(await api.readLocalNovelSummary(entry.id)), "aborted delete kept book");
  equal(await api.readLocalNovelEntry(entry.id), before, "aborted delete retained complete content, extras and metadata");
  await api.deleteLocalNovelEntry(entry.id);
  equal(await api.saveLocalNovelProgress(entry.id, { chapterIndex: 1, scrollRatio: 0.5 }, { expectedGeneration: saved.generation }), null, "late progress returns missing, not recreated");
  equal(await api.readLocalNovelSummary(entry.id), null, "deleted book remains absent");
});
test("reimport and delete/reimport reject stale generations while preserving new content", async () => {
  const { api } = await fresh(); const entry = fixtureEntry(); const first = await api.saveLocalNovelEntry(entry);
  const replacement = fixtureEntry(); replacement.book.title = "新导入"; replacement.chapters[0].content = "全新合成正文";
  const second = await api.saveLocalNovelEntry(replacement); check(first.generation !== second.generation, "reimport has new generation");
  equal(await api.saveLocalNovelProgress(entry.id, { chapterIndex: 2, scrollRatio: 0.9 }, { expectedGeneration: first.generation }), null, "old generation rejected");
  equal((await api.readLocalNovelChapter(entry.id, 1)).chapter.content, replacement.chapters[0].content, "new body untouched");
  await api.deleteLocalNovelEntry(entry.id); const third = await api.saveLocalNovelEntry(replacement); check(third.generation !== second.generation, "recreated ID has distinct generation");
  equal(await api.saveLocalNovelProgress(entry.id, { chapterIndex: 1, scrollRatio: 0.4 }, { expectedGeneration: second.generation }), null, "deleted generation rejected after recreation");
  check(Boolean(await api.saveLocalNovelProgress(entry.id, { chapterIndex: 2, scrollRatio: 0.3 }, { expectedGeneration: third.generation })), "current generation updates normally");
});
test("two concurrent progress calls preserve invocation order and missing chapter is rejected", async () => {
  const { api } = await fresh(); const entry = fixtureEntry(); const saved = await api.saveLocalNovelEntry(entry);
  const a = api.saveLocalNovelProgress(entry.id, { chapterIndex: 1, scrollRatio: 0.12 }, { expectedGeneration: saved.generation });
  const b = api.saveLocalNovelProgress(entry.id, { chapterIndex: 2, scrollRatio: 0.76 }, { expectedGeneration: saved.generation });
  await Promise.all([a, b]); equal((await api.readLocalNovelSummary(entry.id)).book.progress.scrollRatio, 0.76, "newest invocation wins");
  equal(await api.saveLocalNovelProgress(entry.id, { chapterIndex: 999, scrollRatio: 0.8 }, { expectedGeneration: saved.generation }), null, "missing chapter does not create invalid progress");
});
test("synchronous indexedDB.open exception is retryable on the same module", async () => {
  const { name, api } = await fresh(); const original = IDBFactory.prototype.open; let thrown = false;
  await patches([patch(IDBFactory.prototype, "open", function(dbName, ...args) { if (dbName === name && !thrown) { thrown = true; throw new DOMException("synthetic open failure", "UnknownError"); } return Reflect.apply(original, this, [dbName, ...args]); })], async () => {
    await rejects(() => api.loadLocalNovelSummaries(), "first synchronous failure rejects"); equal(await api.loadLocalNovelSummaries(), [], "second call actually retries");
  }); check(thrown, "synchronous failure injected");
});
test("versionchange closes cached connection and an aborted upgrade permits reopen", async () => {
  const { name, api } = await fresh(); const entry = fixtureEntry(); await api.saveLocalNovelEntry(entry);
  const external = indexedDB.open(name, 3); let upgrade = false;
  external.onupgradeneeded = () => { upgrade = true; external.transaction.abort(); };
  await rejects(() => bounded(requestValue(external), "production did not release connection for versionchange"), "external synthetic version upgrade aborts"); check(upgrade, "native versionchange unblocked upgrade");
  const before = countOpens(name); check(Boolean(await api.readLocalNovelSummary(entry.id)), "same module reopens after versionchange"); equal(countOpens(name), before + 1, "cache was invalidated, real new open occurred");
});
test("damaged legacy row rolls back upgrade and remains readable as v1", async () => {
  const { name, api } = await fresh(); const valid = fixtureEntry("local:fixture:a-valid"); const bad = fixtureEntry("local:fixture:z-bad"); bad.chapters[1].index = 1;
  await seedV1(name, [valid, bad]); await rejects(() => api.loadLocalNovelSummaries(), "duplicate legacy chapter index rejects migration after a valid book");
  await inspect(name, 1, async (db) => { equal(db.version, 1, "failed upgrade leaves v1"); equal([...db.objectStoreNames], ["books"], "new stores and previously migrated valid book rolled back"); equal(await requestValue(db.transaction("books").objectStore("books").get(bad.id)), bad, "damaged original preserved verbatim as structured clone"); equal(await requestValue(db.transaction("books").objectStore("books").get(valid.id)), valid, "earlier valid original also untouched"); });
});

test("native forbidden-store access controls prove fences reject actual IDB calls", async () => {
  const { name, api } = await fresh(); await api.saveLocalNovelEntry(fixtureEntry());
  await inspect(name, 2, async (db) => {
    const fence = storeFence();
    await patches(fence.restorers, async () => {
      for (const store of FORBIDDEN) {
        const tx = db.transaction(store, "readonly");
        const error = await rejects(async () => tx.objectStore(store).get("synthetic-control"), `${store} fence must reject a native operation`);
        check(error.message.includes(`Forbidden body/legacy/extras access: ${store}.get`), "access fence—not a missing store or native invalid key—caused rejection");
      }
    });
    equal(fence.accesses.filter((entry) => FORBIDDEN.has(entry.store)).length, 3, "all three real store boundaries observed");
  });
});

test("migration request success followed by abort rolls back all v2 stores, then retries", async () => {
  const { name, api } = await fresh(); const original = fixtureEntry(); await seedV1(name, [original]);
  const injected = abortAfterSuccess("bookMetadata");
  await patches([injected.restore], async () => { await rejects(() => api.loadLocalNovelSummaries(), "abort after first migrated write must reject open"); });
  check(injected.successSeen && injected.aborted, "native migration put had succeeded before abort");
  await inspect(name, 1, async (db) => { equal([...db.objectStoreNames], ["books"], "all DDL rolled back"); equal(await requestValue(db.transaction("books").objectStore("books").get(original.id)), original, "original remains unchanged after abort"); });
  const summaries = await api.loadLocalNovelSummaries(); equal(summaries.length, 1, "same module can retry migration"); equal((await api.readLocalNovelChapter(original.id, 1)).chapter.content, original.chapters[0].content, "retry exact body");
});

async function heldV1(context) {
  const entry = fixtureEntry(); await seedV1(context.name, [entry]);
  const blocker = await requestValue(indexedDB.open(context.name, 1));
  return { blocker, entry };
}
async function assertStillV1(name, entry) {
  await inspect(name, 1, async (db) => { equal(db.version, 1, "retired open did not upgrade DB"); equal([...db.objectStoreNames], ["books"], "retired open did not create stores"); equal(await requestValue(db.transaction("books").objectStore("books").get(entry.id)), entry, "retired open did not change original row"); });
}
test("blocked open rejects; its delayed native upgrade aborts instead of migrating", async () => {
  const context = await fresh(); const { blocker, entry } = await heldV1(context);
  const original = IDBFactory.prototype.open; let retired; let lateUpgrade = false;
  try {
    await patches([patch(IDBFactory.prototype, "open", function(name, ...args) {
      const request = Reflect.apply(original, this, [name, ...args]);
      if (name === context.name && args[0] === 2) { retired = request; request.addEventListener("upgradeneeded", () => { lateUpgrade = true; }); }
      return request;
    })], async () => {
      const error = await rejects(() => context.api.loadLocalNovelSummaries(), "held native connection must reject blocked upgrade");
      check(String(error.message).includes("占用"), "failure is the production blocked error"); check(Boolean(retired), "real v2 open captured");
      const terminal = requestValue(retired).then(() => "success", () => "error");
      blocker.close(); equal(await bounded(terminal, "retired blocked request did not reach terminal event"), "error", "retired native request aborts");
      check(lateUpgrade, "real delayed upgradeneeded occurred after rejection");
    });
  } finally { blocker.close(); }
  await assertStillV1(context.name, entry);
});

test("open timeout with blocked notification suppressed still aborts late native upgrade", async () => {
  const context = await fresh(); const { blocker, entry } = await heldV1(context);
  const original = IDBFactory.prototype.open; let retired; let blockedSuppressed = false; let lateUpgrade = false;
  try {
    await patches([patch(IDBFactory.prototype, "open", function(name, ...args) {
      const request = Reflect.apply(original, this, [name, ...args]);
      if (name === context.name && args[0] === 2) {
        retired = request;
        // Real request/event, but hold back this notification so the real 2s timer fires.
        request.addEventListener("blocked", (event) => { blockedSuppressed = true; event.stopImmediatePropagation(); });
        request.addEventListener("upgradeneeded", () => { lateUpgrade = true; });
      }
      return request;
    })], async () => {
      const started = performance.now();
      const error = await rejects(() => context.api.loadLocalNovelSummaries(), "pending native open must time out");
      check(blockedSuppressed, "blocked notification suppression actually ran");
      check(performance.now() - started >= 1500, "real open timer elapsed, not immediate blocked rejection");
      check(String(error.message).includes("暂时不可用"), "production timeout error observed");
      const terminal = requestValue(retired).then(() => "success", () => "error");
      blocker.close(); equal(await bounded(terminal, "timed-out open did not finish"), "error", "late timed-out upgrade rejected"); check(lateUpgrade, "native delayed upgrade occurred");
    });
  } finally { blocker.close(); }
  await assertStillV1(context.name, entry);
});

test("a retired open error cannot clear the replacement module connection promise", async () => {
  const context = await fresh(); const { blocker, entry } = await heldV1(context);
  try {
    await rejects(() => context.api.loadLocalNovelSummaries(), "first queued open is blocked");
    // Native IDB open requests queue: A's delayed upgrade aborts, then B may upgrade.
    const replacement = context.api.loadLocalNovelSummaries(); blocker.close();
    const summaries = await bounded(replacement, "replacement open did not complete"); equal(summaries.length, 1, "replacement open succeeds");
    const before = countOpens(context.name);
    equal((await context.api.readLocalNovelSummary(entry.id)).id, entry.id, "replacement connection remains usable");
    equal(countOpens(context.name), before, "old request callback did not invalidate current cache");
  } finally { blocker.close(); }
});

// Recovery cases below add coverage; all 17 preceding storage cases are retained.
async function recoveryRejects(action, code, message) {
  const error = await rejects(action, message);
  equal(error.code, `RECOVERY_${code}`, `${message}: stable recovery error code`);
  return error;
}
async function assertDatabaseAbsent(name) {
  let wasAbsent = false;
  const request = indexedDB.open(name);
  request.onupgradeneeded = (event) => {
    wasAbsent = event.oldVersion === 0;
    request.transaction.abort(); // Native absence probe must not persist a DB either.
  };
  const db = await requestValue(request).catch(() => null);
  db?.close();
  check(wasAbsent && db === null, "native oldVersion=0 + aborted probe proves database remains absent");
}
function recoveryReadFence(name, { noTransactions = false } = {}) {
  const restorers = [];
  const transactions = [];
  const operations = [];
  let valuesRead = 0;
  const transaction = IDBDatabase.prototype.transaction;
  restorers.push(patch(IDBDatabase.prototype, "transaction", function(...args) {
    const [stores, mode] = args;
    if (this.name === name) {
      const scope = typeof stores === "string" ? [stores] : Array.from(stores);
      transactions.push({ stores: scope, mode: mode || "readonly" });
      if (noTransactions || mode && mode !== "readonly" || scope.some((store) => store !== "books")) throw new Error("Recovery fence refused non-readonly/foreign-store transaction");
    }
    return Reflect.apply(transaction, this, args);
  }));
  for (const method of ["get", "getAll", "getAllKeys", "openCursor", "openKeyCursor", "put", "add", "delete", "clear", "index"]) {
    const original = IDBObjectStore.prototype[method];
    restorers.push(patch(IDBObjectStore.prototype, method, function(...args) {
      if (this.transaction.db.name === name) {
        operations.push({ store: this.name, method });
        if (this.name !== "books" || !["get", "openCursor", "openKeyCursor"].includes(method)) throw new Error(`Recovery fence refused ${this.name}.${method}`);
      }
      return Reflect.apply(original, this, args);
    }));
  }
  const descriptor = Object.getOwnPropertyDescriptor(IDBCursorWithValue.prototype, "value");
  if (!descriptor?.get) throw new Error("Native cursor value descriptor unavailable");
  Object.defineProperty(IDBCursorWithValue.prototype, "value", { ...descriptor, get() {
    const store = this.source instanceof IDBIndex ? this.source.objectStore : this.source;
    if (store.transaction.db.name === name) valuesRead++;
    return Reflect.apply(descriptor.get, this, []);
  } });
  restorers.push(() => Object.defineProperty(IDBCursorWithValue.prototype, "value", descriptor));
  return { restorers, transactions, operations, get valuesRead() { return valuesRead; } };
}
function safeRecoveryItem(item) {
  equal(Object.keys(item).sort(), ["key", "title", "fileName", "totalChapters", "readableChapters", "omittedChapters", "exportable"].sort(), "recovery list exact safe field allowlist");
  check(typeof item.title === "string" && typeof item.fileName === "string", "recovery display metadata stays string-valued");
  equal(item.totalChapters, item.readableChapters + item.omittedChapters, "recovery counts reconcile");
  equal(item.exportable, item.readableChapters > 0, "exportability reflects readable chapters");
}
function damagedRecoveryEntry(id = "local:recovery:damaged") {
  return {
    id,
    book: { id: "contradictory-old-id", title: "合成可取回旧书", fileName: "recover-synthetic.txt", sourceUri: "PRIVATE_SOURCE_URI", sourceKey: "PRIVATE_SOURCE_TEXT", privateExtra: { token: "PRIVATE_CREDENTIAL" } },
    chapters: [
      { id: "duplicate", bookId: "wrong-parent", index: 9, title: "第一段", content: "  可取回 A\r\n\n保持原始空白  ", privateExtra: "PRIVATE_CHAPTER_EXTRA" },
      { title: "空白", content: " \r\n\t" },
      null,
      { id: "duplicate", index: 9, title: "第二段", content: "可取回 B🙂", preamble: true },
      { title: "非字符串", content: { private: "PRIVATE_INVALID_BODY" } }
    ],
    privateEntry: "PRIVATE_ENTRY_EXTRA"
  };
}

test("recovery of an absent database rejects without creating it or poisoning normal open", async () => {
  const { name, api } = await fresh();
  for (const method of ["listLocalNovelRecoveryBooks", "readLocalNovelRecoveryEntry"]) check(typeof api[method] === "function", `${method} exported`);
  const fence = recoveryReadFence(name, { noTransactions: true });
  await patches(fence.restorers, async () => {
    await recoveryRejects(() => api.listLocalNovelRecoveryBooks(), "NOT_FOUND", "missing list reports not found");
    await recoveryRejects(() => api.readLocalNovelRecoveryEntry("synthetic", { expectedVersion: 1 }), "NOT_FOUND", "missing single-book read reports not found");
  });
  equal(fence.transactions.length, 0, "missing recovery opens never start store transactions");
  await assertDatabaseAbsent(name);
  equal(await api.loadLocalNovelSummaries(), [], "normal open can independently create a fresh v2 after recovery failure");
  await inspect(name, 2, (db) => equal(db.version, 2, "normal schema creation remains functional"));
});

test("failed v1 upgrade remains recoverable with readonly partial-book extraction and unchanged originals", async () => {
  const { name, api } = await fresh(); const damaged = damagedRecoveryEntry();
  await seedV1(name, [damaged]);
  await rejects(() => api.loadLocalNovelSummaries(), "damaged identity prevents normal migration");
  const fence = recoveryReadFence(name);
  await patches(fence.restorers, async () => {
    const page = await api.listLocalNovelRecoveryBooks({ limit: 1 });
    equal(page.version, 1, "recovery reports actual v1"); equal(page.source, "legacy-books", "recovery explicitly labels legacy source");
    equal(page.items.length, 1, "damaged book remains visible"); safeRecoveryItem(page.items[0]);
    equal([page.items[0].totalChapters, page.items[0].readableChapters, page.items[0].omittedChapters], [5, 2, 3], "damaged chapter counts are explicit");
    check(!JSON.stringify(page).includes("PRIVATE_"), "listing cannot expose URI, credentials, unknown fields or body markers");
    const rescued = await api.readLocalNovelRecoveryEntry(page.items[0].key, { expectedVersion: page.version });
    equal(rescued.version, 1, "single-book result reports current observed version"); equal(rescued.source, "legacy-books", "single-book source stays explicit");
    equal(Object.keys(rescued.entry.book).sort(), ["fileName", "title"], "recovered book DTO excludes private source data");
    equal(rescued.entry.chapters.map((chapter) => chapter.content), [damaged.chapters[0].content, damaged.chapters[3].content], "original readable text and old array order survive invalid IDs/duplicate indexes");
    equal([rescued.totalChapters, rescued.readableChapters, rescued.omittedChapters], [5, 2, 3], "single-read counts recomputed from this row");
    check(rescued.entry.chapters.every((chapter) => Object.keys(chapter).every((key) => ["title", "content", "index", "preamble"].includes(key))), "chapter rescue allowlist excludes unknown fields and IDs");
    check(!JSON.stringify(rescued).includes("PRIVATE_"), "returned rescue DTO does not leak private extras");
  });
  check(fence.transactions.length >= 2 && fence.transactions.every((tx) => tx.mode === "readonly" && JSON.stringify(tx.stores) === '["books"]'), "both actual recovery transactions use books-only readonly mode");
  await assertStillV1(name, damaged);
  await rejects(() => api.loadLocalNovelSummaries(), "recovery has not silently repaired or bypassed the damaged normal upgrade");
});

test("recovery pagination preserves native key types, bounded reads, and unexportable rows", async () => {
  const { name, api } = await fresh();
  const keys = [0, 2, new Date("2020-01-02T00:00:00.000Z"), "", "z-last-string", ["array-key", 1]];
  const rows = keys.map((key, index) => ({ ...damagedRecoveryEntry(key), book: { title: `分页合成${index}`, fileName: `page-${index}.txt`, secret: "PRIVATE_PAGINATION_EXTRA" }, ...(index === 4 ? { chapters: [null, { content: "  " }] } : {}) }));
  await seedV1(name, rows);
  const expected = [...keys].sort((a, b) => indexedDB.cmp(a, b));
  const fence = recoveryReadFence(name); const actual = []; let pageCount = 0;
  await patches(fence.restorers, async () => {
    let afterKey;
    do {
      const beforeValues = fence.valuesRead;
      const page = await api.listLocalNovelRecoveryBooks({ limit: 2, ...(afterKey === undefined ? {} : { afterKey, expectedVersion: 1 }) });
      pageCount++; check(page.items.length <= 2, "page contains at most the requested number of rows");
      check(fence.valuesRead - beforeValues <= 2, "native cursor cloned-value access is bounded by page size, not whole library");
      for (const item of page.items) { safeRecoveryItem(item); actual.push(item.key); }
      check(!JSON.stringify(page).includes("PRIVATE_"), "paginated summaries stay on the safe allowlist");
      if (!page.hasMore) { equal(page.nextKey, null, "terminal page has no continuation key"); break; }
      check(indexedDB.cmp(page.nextKey, page.items[page.items.length - 1].key) === 0, "continuation is the exact last returned native key");
      afterKey = page.nextKey; check(pageCount <= keys.length, "pagination makes forward progress");
    } while (true);
    equal(actual.length, expected.length, "every old row, including unexportable rows, is listed once");
    actual.forEach((key, index) => check(indexedDB.cmp(key, expected[index]) === 0, `native key order ${index}`));
    check(typeof actual[0] === "number" && actual[0] === 0, "numeric zero key remains numeric");
    check(actual[2] instanceof Date, "Date key remains Date, not a serialized string");
    check(typeof actual[3] === "string" && actual[3] === "", "empty string key remains a valid key");
    check(Array.isArray(actual[5]), "compound array key remains an array");
    for (const key of [0, "", keys[2], keys[5]]) check(Boolean(await api.readLocalNovelRecoveryEntry(key, { expectedVersion: 1 })), "typed key can retrieve its exact old row");
    const unreadable = await api.readLocalNovelRecoveryEntry("z-last-string", { expectedVersion: 1 });
    equal(unreadable.entry.chapters, [], "unreadable old row does not invent replacement text"); equal(unreadable.omittedChapters, 2, "omissions are explicit");
    equal(await api.readLocalNovelRecoveryEntry("absent-row", { expectedVersion: 1 }), null, "missing row in an existing database returns null");
  });
  equal(pageCount, 3, "six rows at two per page use three pages");
  check(fence.operations.every((operation) => ["get", "openCursor", "openKeyCursor"].includes(operation.method)), "no getAll, write, or hidden metadata store access");
  await inspect(name, 1, async (db) => { const original = await requestValue(db.transaction("books").objectStore("books").getAll()); equal(original.length, rows.length, "pagination does not delete old rows"); for (let i = 0; i < original.length; i++) check(indexedDB.cmp(original[i].id, expected[i]) === 0, "raw old keys remain unchanged"); });
});

test("recovery shows v2 pre-upgrade copy, rejects stale v1 pages, and leaves normal connection usable", async () => {
  const { name, api } = await fresh(); const legacy = fixtureEntry("local:recovery:versioned"); await seedV1(name, [legacy]);
  const v1Page = await api.listLocalNovelRecoveryBooks({ limit: 1 }); equal(v1Page.version, 1, "first page really came from v1");
  await api.loadLocalNovelSummaries();
  const replacement = fixtureEntry(legacy.id); replacement.book.title = "已更新的当前正文"; replacement.chapters[0].content = "Current v2 content, not the rescue snapshot";
  const saved = await api.saveLocalNovelEntry(replacement);
  const fence = recoveryReadFence(name);
  await patches(fence.restorers, async () => {
    await recoveryRejects(() => api.listLocalNovelRecoveryBooks({ afterKey: v1Page.items[0].key, expectedVersion: 1 }), "STALE_VERSION", "old paginated view rejects schema change");
    await recoveryRejects(() => api.readLocalNovelRecoveryEntry(legacy.id, { expectedVersion: 1 }), "STALE_VERSION", "old single-book selection rejects schema change");
    equal(fence.transactions.length, 0, "stale requests reject before any old-row transaction");
    const page = await api.listLocalNovelRecoveryBooks(); equal(page.version, 2, "fresh recovery view labels v2"); equal(page.items[0].title, legacy.book.title, "v2 rescue listing is the pre-upgrade copy, not current metadata");
    const rescued = await api.readLocalNovelRecoveryEntry(legacy.id, { expectedVersion: 2 }); equal(rescued.entry.chapters[0].content, legacy.chapters[0].content, "v2 recovery deliberately retrieves old copy"); equal(rescued.version, 2, "old-copy result carries schema version 2");
  });
  const recoveryConnection = opened[opened.length - 1].request.result;
  const closedError = await rejects(async () => recoveryConnection.transaction("books"), "recovery owns and closes its connection after completion"); equal(closedError.name, "InvalidStateError", "native closed-connection error");
  const before = countOpens(name); equal((await api.readLocalNovelChapter(legacy.id, 1)).chapter.content, replacement.chapters[0].content, "normal reader still sees current v2 body"); equal(countOpens(name), before, "recovery did not invalidate normal module cached connection"); equal((await api.readLocalNovelSummary(legacy.id)).generation, saved.generation, "recovery did not replace active generation");
  await inspect(name, 2, async (db) => equal(await requestValue(db.transaction("books").objectStore("books").get(legacy.id)), legacy, "old snapshot remains unchanged"));
});

test("future schema is fully refused before store access and cannot be downgraded", async () => {
  const { name, api } = await fresh(); const legacy = fixtureEntry(); await seedV1(name, [legacy]);
  const request = indexedDB.open(name, 3); request.onupgradeneeded = () => request.result.createObjectStore("future-schema-sentinel"); const future = await requestValue(request); future.close();
  const fence = recoveryReadFence(name, { noTransactions: true });
  await patches(fence.restorers, async () => {
    await recoveryRejects(() => api.listLocalNovelRecoveryBooks(), "UNSUPPORTED_VERSION", "future schema list is not guessed");
    await recoveryRejects(() => api.readLocalNovelRecoveryEntry(legacy.id, { expectedVersion: 2 }), "UNSUPPORTED_VERSION", "future schema single read is not guessed");
  });
  equal(fence.transactions.length, 0, "future version inspection never touches a store");
  await rejects(() => api.loadLocalNovelSummaries(), "normal v2 open also refuses existing v3");
  await inspect(name, 3, async (db) => { check(db.objectStoreNames.contains("future-schema-sentinel"), "future schema sentinel preserved"); equal(await requestValue(db.transaction("books").objectStore("books").get(legacy.id)), legacy, "future DB old row unchanged"); });
});

test("recovery requires version-bound valid arguments without opening the database", async () => {
  const { name, api } = await fresh(); const before = countOpens(name);
  for (const limit of [0, 51, 1.5]) await recoveryRejects(() => api.listLocalNovelRecoveryBooks({ limit }), "INVALID_ARGUMENT", `invalid limit ${limit}`);
  await recoveryRejects(() => api.listLocalNovelRecoveryBooks({ afterKey: 0 }), "INVALID_ARGUMENT", "zero continuation key also requires expected version");
  await recoveryRejects(() => api.listLocalNovelRecoveryBooks({ afterKey: null, expectedVersion: 1 }), "INVALID_ARGUMENT", "invalid native continuation key");
  await recoveryRejects(() => api.readLocalNovelRecoveryEntry("valid-key"), "INVALID_ARGUMENT", "single-book selection must supply observed version");
  await recoveryRejects(() => api.readLocalNovelRecoveryEntry("valid-key", { expectedVersion: 3 }), "INVALID_ARGUMENT", "unsupported expected version");
  await recoveryRejects(() => api.readLocalNovelRecoveryEntry(undefined, { expectedVersion: 1 }), "INVALID_ARGUMENT", "invalid native single-book key");
  equal(countOpens(name), before, "argument errors cannot create/open a database"); await assertDatabaseAbsent(name);
});

test("recovery read success followed by transaction abort does not report recovered text", async () => {
  const { name, api } = await fresh(); const entry = fixtureEntry(); await seedV1(name, [entry]);
  const injected = abortAfterSuccess("books", "get");
  await patches([injected.restore], async () => { await recoveryRejects(() => api.readLocalNovelRecoveryEntry(entry.id, { expectedVersion: 1 }), "READ_FAILED", "recovery abort must reject despite request success"); });
  check(injected.successSeen && injected.aborted, "native readonly get success occurred before abort");
  equal((await api.readLocalNovelRecoveryEntry(entry.id, { expectedVersion: 1 })).entry.chapters[0].content, entry.chapters[0].content, "independent retry reads original text");
  await assertStillV1(name, entry);
  equal((await api.loadLocalNovelSummaries()).length, 1, "failed recovery did not poison subsequent normal upgrade");
});

test("missing legacy store is reported without repairing v2", async () => {
  const { name, api } = await fresh();
  const request = indexedDB.open(name, 2); request.onupgradeneeded = () => request.result.createObjectStore("unrelated-preserved-store"); const original = await requestValue(request); original.close();
  const fence = recoveryReadFence(name, { noTransactions: true });
  await patches(fence.restorers, async () => {
    await recoveryRejects(() => api.listLocalNovelRecoveryBooks(), "SCHEMA_UNAVAILABLE", "no books store means no recoverable schema");
    await recoveryRejects(() => api.readLocalNovelRecoveryEntry("synthetic", { expectedVersion: 2 }), "SCHEMA_UNAVAILABLE", "single read does not recreate old store");
  });
  equal(fence.transactions.length, 0, "unavailable schema rejected before any data transaction");
  await inspect(name, 2, (db) => equal([...db.objectStoreNames], ["unrelated-preserved-store"], "no repair DDL was performed"));
});
test("recovery readonly transaction fence has a live native negative control", async () => {
  const live = await fresh(); await seedV1(live.name, [fixtureEntry()]);
  await inspect(live.name, 1, async (db) => {
    const readonly = recoveryReadFence(live.name);
    await patches(readonly.restorers, async () => {
      const error = await rejects(async () => db.transaction("books", "readwrite"), "negative control must reject real non-readonly transaction");
      equal(error.message, "Recovery fence refused non-readonly/foreign-store transaction", "failure is our readonly access gate");
    });
    equal(readonly.transactions.length, 1, "negative control reached actual IDB database boundary");
  });
});

async function cleanup() {
  for (const db of connections) { try { db.close(); } catch {} }
  const failures = [];
  for (const name of generated) {
    try { await bounded(requestValue(indexedDB.deleteDatabase(name)), `cleanup blocked: ${name}`, 5000); }
    catch (error) { failures.push(String(error.message || error)); }
  }
  return failures;
}
async function publish(report) {
  reportNode.textContent = JSON.stringify(report, null, 2);
  counts.textContent = `${report.cases.length}/${cases.length} 场景 · ${totalChecks} 检查 · ${report.cases.filter((item) => item.status === "failed").length} 失败`;
  try { await fetch("/report", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(report) }); } catch {}
}
runButton.addEventListener("click", async () => {
  if (running) return; running = true; runButton.disabled = true; list.replaceChildren(); totalChecks = 0;
  let source;
  try {
    const response = await fetch("/start", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    if (!response.ok) throw new Error(await response.text());
    source = await response.json(); activeRunId = source.runId;
  } catch (error) { status.textContent = `无法冻结源码：${error.message || error}`; running = false; runButton.disabled = false; return; }
  const runNames = new Set(generated);
  const report = { status: "running", runId: activeRunId, startedAt: new Date().toISOString(), cases: [], nativeIndexedDB: true, source, boundaries: ["Only DB_NAME substituted in one frozen production source snapshot per run", "Native IDB with transparent prototype access fences and explicit fault injection", "Persistence permission request is a counted no-op", "Synthetic random UUID DB names only; no real library", "Not Android WebView, real disk quota, process kill, or power-loss testing"] };
  await publish(report);
  for (const entry of cases) {
    currentChecks = 0; status.textContent = `正在运行：${entry.name}`; const item = document.createElement("li"); item.textContent = entry.name; list.append(item); const started = performance.now();
    try { await bounded(entry.run(), `case timeout: ${entry.name}`, 20000); item.className = "pass"; item.textContent = `通过 · ${entry.name}`; report.cases.push({ name: entry.name, status: "passed", checks: currentChecks, ms: Math.round(performance.now() - started) }); }
    catch (error) { item.className = "fail"; item.textContent = `失败 · ${entry.name}：${error.message || error}`; report.cases.push({ name: entry.name, status: "failed", checks: currentChecks, error: String(error.stack || error), ms: Math.round(performance.now() - started) }); }
    await publish(report);
  }
  report.cleanupFailures = await cleanup(); report.databaseCount = [...generated].filter((name) => !runNames.has(name)).length; report.checks = totalChecks; report.finishedAt = new Date().toISOString(); report.status = report.cases.some((entry) => entry.status === "failed") || report.cleanupFailures.length ? "failed" : "passed";
  status.textContent = report.status === "passed" ? "全部通过；所有本页生成的隔离数据库已清理。" : "存在失败，请查看场景和 JSON 报告。";
  await publish(report); running = false; runButton.disabled = false;
});
