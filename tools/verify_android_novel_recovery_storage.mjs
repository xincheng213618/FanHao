import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { randomUUID, webcrypto } from "node:crypto";
import { IDBFactory, IDBKeyRange, IDBObjectStore, IDBIndex, forceCloseDatabase } from "fake-indexeddb";
import { entry, identitySource } from "./fixtures/android-local-novel-v2-harness.mjs";

// Full current production module on fake-indexeddb, never a user's database.
// Request/timer doubles below are explicitly limited to rare lifecycle events.
const source = fs.readFileSync(new URL("../android-client/www/js/local-novels.js", import.meta.url), "utf8");
const clone = structuredClone;
const requestResult = request => new Promise((resolve, reject) => {
  request.addEventListener("success", () => resolve(request.result));
  request.addEventListener("error", () => reject(request.error));
});
const done = transaction => new Promise((resolve, reject) => {
  transaction.addEventListener("complete", resolve);
  transaction.addEventListener("abort", () => reject(transaction.error || new Error("transaction aborted")));
});
const turn = () => new Promise(resolve => setImmediate(resolve));
const code = suffix => error => error?.code === `RECOVERY_${suffix}`;
const tests = [];
const test = (name, run) => tests.push({ name, run });

function manualClock() {
  let next = 0;
  const pending = new Map();
  return {
    setTimeout(fn, delay) { const id = ++next; pending.set(id, { fn, delay }); return id; },
    clearTimeout(id) { pending.delete(id); },
    fire(delay) { const item = [...pending].find(([, task]) => task.delay === delay); assert(item, `missing ${delay}ms timer`); pending.delete(item[0]); item[1].fn(); },
    get size() { return pending.size; }
  };
}

function harness(production = source, clock = { setTimeout, clearTimeout }) {
  const name = `novel-recovery-test-${randomUUID()}`, factory = new IDBFactory();
  const opens = [], connections = [], operations = [], transactions = [], restores = [];
  const controls = { before: null, after: null, beforeTransaction: null, opened: null };
  for (const prototype of [IDBObjectStore.prototype, IDBIndex.prototype]) {
    for (const method of ["get", "getAll", "getAllKeys", "openCursor", "openKeyCursor", "put", "add", "delete", "clear"]) {
      const original = prototype[method];
      if (!original) continue;
      prototype[method] = function (...args) {
        const store = this.transaction ? this : this.objectStore;
        if (store.transaction.db.name !== name) return original.apply(this, args);
        const call = { store: store.name, method, args, transaction: store.transaction };
        operations.push(call); controls.before?.(call);
        const request = original.apply(this, args);
        request.addEventListener("success", () => controls.after?.({ ...call, request }));
        return request;
      };
      restores.push(() => { prototype[method] = original; });
    }
  }
  const nativeOpen = factory.open.bind(factory);
  factory.open = (...args) => {
    opens.push(args);
    const request = nativeOpen(...args);
    request.addEventListener("success", () => {
      const db = request.result, record = { db, closed: false, closeCount: 0 };
      connections.push(record);
      const close = db.close.bind(db), transaction = db.transaction.bind(db);
      db.close = () => { record.closed = true; record.closeCount++; close(); };
      db.transaction = (stores, mode, ...rest) => {
        const call = { stores: typeof stores === "string" ? [stores] : [...stores], mode: mode || "readonly", db };
        transactions.push(call); controls.beforeTransaction?.(call);
        return transaction(stores, mode, ...rest);
      };
      controls.opened?.(record);
    });
    return request;
  };
  const window = { indexedDB: factory, IDBKeyRange, setTimeout: clock.setTimeout.bind(clock), clearTimeout: clock.clearTimeout.bind(clock) };
  const exports = [...production.matchAll(/^export\s+(?:async\s+)?function\s+(\w+)/gm)].map(match => match[1]);
  const transformed = production.replace(/^import .*;\r?\n/gm, "").replace(/const LOCAL_NOVEL_DB_NAME = "[^"]+";/, `const LOCAL_NOVEL_DB_NAME = ${JSON.stringify(name)};`).replace(/^export /gm, "");
  const api = vm.runInNewContext(`${identitySource.replace(/^export /gm, "")}\n${transformed}\n({${exports.join(",")}})`, {
    window, indexedDB: factory, IDBKeyRange, Blob, Date, structuredClone, crypto: webcrypto,
    navigator: { storage: { persist: async () => false } }
  });
  return {
    name, factory, window, api, opens, connections, operations, transactions, controls,
    open: version => requestResult(version === undefined ? factory.open(name) : factory.open(name, version)),
    async seed(rows = [entry()], { version = 1, keyed = false, omitBooks = false } = {}) {
      const request = factory.open(name, version);
      request.onupgradeneeded = () => {
        if (omitBooks) { request.result.createObjectStore("other"); return; }
        const store = request.result.createObjectStore("books", keyed ? undefined : { keyPath: "id" });
        for (const row of rows) keyed ? store.put(row.value, row.key) : store.put(row);
      };
      (await requestResult(request)).close();
      this.reset();
    },
    async snapshot() {
      const db = await this.open();
      try {
        const names = [...db.objectStoreNames], transaction = db.transaction(names, "readonly"), completed = done(transaction);
        const stores = await Promise.all(names.map(name => new Promise((resolve, reject) => {
          const rows = [], request = transaction.objectStore(name).openCursor();
          request.onerror = () => reject(request.error);
          request.onsuccess = () => { const cursor = request.result; if (!cursor) { resolve([name, rows]); return; } rows.push({ key: clone(cursor.primaryKey), value: clone(cursor.value) }); cursor.continue(); };
        })));
        await completed;
        return { version: db.version, stores };
      } finally { db.close(); }
    },
    reset() { opens.length = 0; operations.length = 0; transactions.length = 0; },
    fence() {
      controls.beforeTransaction = call => { assert.deepEqual(call.stores, ["books"], "recovery touched non-legacy store"); assert.equal(call.mode, "readonly", "recovery used a writable transaction"); };
      controls.before = call => { assert.equal(call.store, "books"); assert(["openCursor", "get"].includes(call.method), `forbidden recovery operation ${call.method}`); };
    },
    unfence() { controls.beforeTransaction = controls.before = controls.after = controls.opened = null; },
    dispose() { this.unfence(); for (const record of connections) record.db.close(); for (const restore of restores.reverse()) restore(); }
  };
}

function assertClosed(h, from) { assert(h.connections.slice(from).length > 0); assert(h.connections.slice(from).every(record => record.closed), "recovery retained an open connection"); }
function assertSafeMetadata(item) {
  assert.deepEqual(Object.keys(item).sort(), ["key", "title", "fileName", "totalChapters", "readableChapters", "omittedChapters", "exportable"].sort());
  assert(!JSON.stringify(item).includes("PRIVATE_TEXT_FRAGMENT"));
}

test("missing database stays absent after list/read and can still be normally created later", async h => {
  assert.deepEqual(await h.factory.databases(), []);
  await assert.rejects(h.api.listLocalNovelRecoveryBooks(), code("NOT_FOUND"));
  await assert.rejects(h.api.readLocalNovelRecoveryEntry("missing", { expectedVersion: 1 }), code("NOT_FOUND"));
  await turn();
  assert.deepEqual(await h.factory.databases(), [], "recovery implicitly created a database");
  assert(h.opens.every(args => args.length === 1), "recovery requested a schema version");
  assert.equal(h.transactions.length, 0);
  await h.seed();
  assert.equal((await h.api.loadLocalNovelSummaries()).length, 1);
});

test("failed strict migration retains v1 and readable portions remain recoverable without repair", async h => {
  const damaged = entry("damaged", "broken");
  damaged.chapters = [
    { index: 2, bookId: "wrong", title: "Second first", content: " keep original whitespace \n", unknown: "PRIVATE_TEXT_FRAGMENT" },
    { index: 2, title: "Duplicate index", content: "duplicate-index body", preamble: true },
    { index: -1, title: "Bad ordinal", content: "bad-index body" },
    null, { content: { unsafe: true } }, { content: "   \n" }, { content: "" }, 7
  ];
  damaged.book.sourceKey = "PRIVATE_TEXT_FRAGMENT";
  damaged.book.future = new Date("2020-01-02T00:00:00Z");
  damaged.futureField = { bytes: new Uint8Array([1, 2, 3]), blob: new Blob(["keep blob"]), nested: [null, false] };
  await h.seed([entry(), damaged]);
  const before = await h.snapshot();
  await assert.rejects(h.api.loadLocalNovelSummaries());
  assert.deepEqual(await h.snapshot(), before);
  h.reset(); h.fence();
  const from = h.connections.length;
  let list;
  await assert.doesNotReject(async () => { list = await h.api.listLocalNovelRecoveryBooks(); }, "existing damaged v1 must remain listable without requesting migration");
  assert.equal(list.version, 1); assert.equal(list.source, "legacy-books"); assert.equal(list.items.length, 2);
  list.items.forEach(assertSafeMetadata);
  const item = list.items.find(item => item.key === "broken");
  assert.equal(item.totalChapters, 8); assert.equal(item.readableChapters, 3); assert.equal(item.omittedChapters, 5); assert.equal(item.exportable, true);
  const read = await h.api.readLocalNovelRecoveryEntry(item.key, { expectedVersion: list.version });
  assert.equal(read.source, "legacy-books"); assert.equal(read.version, 1);
  assert.equal(read.totalChapters, 8); assert.equal(read.readableChapters, 3); assert.equal(read.omittedChapters, 5);
  assert.deepEqual(clone(read.entry.book), { title: "damaged title", fileName: "damaged.txt" });
  assert.deepEqual(clone(read.entry.chapters.map(chapter => chapter.content)), damaged.chapters.slice(0, 3).map(chapter => chapter.content));
  assert.equal(read.entry.chapters[0].index, 2); assert.equal(read.entry.chapters[1].index, 2);
  assert.equal("index" in read.entry.chapters[2], false);
  assert.equal(read.entry.chapters[1].preamble, true);
  assert(!JSON.stringify(read).includes("PRIVATE_TEXT_FRAGMENT")); assert(!JSON.stringify(read).includes("wrong"));
  assert(h.opens.every(args => args.length === 1)); assertClosed(h, from);
  h.unfence(); assert.deepEqual(await h.snapshot(), before);
  await assert.rejects(h.api.loadLocalNovelSummaries(), "recovery must not silently repair the corrupt record");
});

test("cursor pagination keeps mixed valid IDB keys and visits each row once", async h => {
  const keys = [-5, 0, new Date("2024-01-01Z"), "", "alpha", new Uint8Array([4, 7]).buffer, [], ["nested", [3, "x"]]];
  const sorted = [...keys].sort((a, b) => h.factory.cmp(a, b));
  await h.seed(keys.map((key, index) => ({ key, value: entry(`row-${index}`) })), { keyed: true });
  h.fence(); const from = h.connections.length, visited = []; let afterKey, expectedVersion;
  for (let pageNumber = 0; pageNumber < 10; pageNumber++) {
    const page = await h.api.listLocalNovelRecoveryBooks({ afterKey, expectedVersion, limit: 3 });
    assert.equal(page.version, 1); assert(page.items.length <= 3); page.items.forEach(assertSafeMetadata);
    visited.push(...page.items.map(item => item.key));
    for (const item of page.items) assert((await h.api.readLocalNovelRecoveryEntry(item.key, { expectedVersion: page.version })).entry.chapters.length === 4);
    if (!page.hasMore) { assert.equal(page.nextKey, null); break; }
    assert.equal(h.factory.cmp(page.nextKey, page.items.at(-1).key), 0);
    afterKey = page.nextKey; expectedVersion = page.version;
  }
  assert.equal(visited.length, keys.length);
  visited.forEach((key, index) => assert.equal(h.factory.cmp(key, sorted[index]), 0, `key ${index} was skipped, duplicated or stringified`));
  assert.equal(h.operations.filter(call => call.method === "openCursor").length, 3);
  assert(h.opens.every(args => args.length === 1)); assertClosed(h, from);
});

test("default limit and exact page boundary do not report a spurious next page", async h => {
  await h.seed(Array.from({ length: 20 }, (_, index) => entry(`row-${index}`, `key-${String(index).padStart(2, "0")}`)));
  h.fence(); const first = await h.api.listLocalNovelRecoveryBooks();
  assert.equal(first.items.length, 10); assert.equal(first.hasMore, true);
  const second = await h.api.listLocalNovelRecoveryBooks({ afterKey: first.nextKey, expectedVersion: first.version });
  assert.equal(second.items.length, 10); assert.equal(second.hasMore, false); assert.equal(second.nextKey, null);
  const empty = await h.api.listLocalNovelRecoveryBooks({ afterKey: second.items.at(-1).key, expectedVersion: 1 });
  assert.equal(empty.items.length, 0); assert.equal(empty.hasMore, false); assert.equal(empty.nextKey, null);
});

test("malformed row metadata is safe and non-readable records stay visible but not exportable", async h => {
  const rows = [null, 12, {}, { book: { title: { bad: 1 }, fileName: ["bad"] }, chapters: [null, { content: 4 }, { content: " \n" }] }, { book: { title: "empty" }, chapters: [] }];
  await h.seed(rows.map((value, key) => ({ key, value })), { keyed: true });
  h.fence(); const list = await h.api.listLocalNovelRecoveryBooks();
  assert.equal(list.items.length, rows.length);
  for (const item of list.items) {
    assertSafeMetadata(item); assert.equal(item.readableChapters, 0); assert.equal(item.exportable, false);
    const read = await h.api.readLocalNovelRecoveryEntry(item.key, { expectedVersion: 1 });
    assert.equal(read.entry.chapters.length, 0); assert.equal(read.omittedChapters, read.totalChapters);
    assert.equal(typeof read.entry.book.title, "string"); assert.equal(typeof read.entry.book.fileName, "string");
  }
});

test("read returns counts from its current row, not a stale list snapshot", async h => {
  await h.seed(); const list = await h.api.listLocalNovelRecoveryBooks(); assert.equal(list.items[0].readableChapters, 4);
  const db = await h.open(), transaction = db.transaction("books", "readwrite"), completed = done(transaction);
  const changed = entry(); changed.chapters[0].content = null;
  transaction.objectStore("books").put(changed); await completed; db.close();
  const before = await h.snapshot(); h.fence();
  const read = await h.api.readLocalNovelRecoveryEntry(list.items[0].key, { expectedVersion: 1 });
  assert.equal(read.totalChapters, 4); assert.equal(read.readableChapters, 3); assert.equal(read.omittedChapters, 1); assert.equal(read.entry.chapters.length, 3);
  h.unfence(); assert.deepEqual(await h.snapshot(), before);
});

test("v3 exposes only the old snapshot and never changes current data or the normal connection cache", async h => {
  await h.seed(); await h.api.loadLocalNovelSummaries();
  const replacement = entry("current-v2"); await h.api.saveLocalNovelEntry(replacement);
  const before = await h.snapshot(); h.reset(); h.fence(); const from = h.connections.length;
  const list = await h.api.listLocalNovelRecoveryBooks(); assert.equal(list.version, 3); assert.equal(list.items[0].title, "original title");
  const read = await h.api.readLocalNovelRecoveryEntry("local-1", { expectedVersion: 3 });
  assert.equal(read.version, 3); assert.equal(read.source, "legacy-books"); assert.equal(read.entry.chapters[0].content, entry().chapters[0].content);
  assertClosed(h, from); assert.equal(h.opens.length, 2);
  await assert.rejects(h.api.readLocalNovelRecoveryEntry("local-1", { expectedVersion: 1 }), code("STALE_VERSION"));
  await assert.rejects(h.api.listLocalNovelRecoveryBooks({ afterKey: "local-1", expectedVersion: 1 }), code("STALE_VERSION"));
  assert.equal(h.transactions.length, 2, "stale page accessed a store before version rejection");
  h.unfence(); const openCount = h.opens.length;
  assert.equal((await h.api.readLocalNovelSummary("local-1")).book.title, "current-v2 title");
  assert.equal(h.opens.length, openCount, "recovery invalidated the normal cached connection");
  assert.deepEqual(await h.snapshot(), before);
});

for (const version of [2, 3]) test(`existing v${version} legacy copy is readable without any schema change`, async h => {
  await h.seed([entry()], { version }); const before = await h.snapshot(); h.reset(); h.fence();
  const page = await h.api.listLocalNovelRecoveryBooks(); assert.equal(page.version, version);
  const read = await h.api.readLocalNovelRecoveryEntry(page.items[0].key, { expectedVersion: version });
  assert.equal(read.entry.chapters[0].content, entry().chapters[0].content);
  assert.equal(h.opens.length, 2); assert(h.opens.every(args => args.length === 1));
  h.unfence(); assert.deepEqual(await h.snapshot(), before);
});

test("a page from v1 is rejected after normal migration without rerunning migration", async h => {
  await h.seed(); const page = await h.api.listLocalNovelRecoveryBooks(); await h.api.loadLocalNovelSummaries();
  const before = await h.snapshot(); h.reset(); h.fence();
  await assert.rejects(h.api.readLocalNovelRecoveryEntry(page.items[0].key, { expectedVersion: page.version }), code("STALE_VERSION"));
  assert.equal(h.transactions.length, 0); assert.equal(h.operations.length, 0); assert.equal(h.opens[0].length, 1);
  h.unfence(); assert.deepEqual(await h.snapshot(), before);
});

for (const version of [4, 99]) test(`future schema v${version} is rejected before any transaction or legacy read`, async h => {
  await h.seed([entry()], { version }); const before = await h.snapshot(); h.reset(); h.fence(); const from = h.connections.length;
  await assert.rejects(h.api.listLocalNovelRecoveryBooks(), code("UNSUPPORTED_VERSION"));
  await assert.rejects(h.api.readLocalNovelRecoveryEntry("local-1", { expectedVersion: 2 }), code("UNSUPPORTED_VERSION"));
  assert.equal(h.transactions.length, 0); assert.equal(h.operations.length, 0); assertClosed(h, from);
  h.unfence(); assert.deepEqual(await h.snapshot(), before);
});

for (const version of [1, 2, 3]) test(`known schema v${version} without books is refused without creating the store`, async h => {
  await h.seed([], { version, omitBooks: true }); const before = await h.snapshot(); h.reset(); h.fence();
  await assert.rejects(h.api.listLocalNovelRecoveryBooks(), code("SCHEMA_UNAVAILABLE"));
  assert.equal(h.transactions.length, 0); assert.equal(h.operations.length, 0);
  h.unfence(); assert.deepEqual(await h.snapshot(), before);
});

test("bad keys, limits, or missing page versions fail before opening a database", async h => {
  for (const limit of [0, -1, 1.5, 51, NaN, "10", null]) await assert.rejects(h.api.listLocalNovelRecoveryBooks({ limit }), code("INVALID_ARGUMENT"));
  for (const expectedVersion of [0, 4, "1", null, NaN]) await assert.rejects(h.api.listLocalNovelRecoveryBooks({ expectedVersion }), code("INVALID_ARGUMENT"));
  await assert.rejects(h.api.listLocalNovelRecoveryBooks({ afterKey: "a" }), code("INVALID_ARGUMENT"));
  await assert.rejects(h.api.readLocalNovelRecoveryEntry("a"), code("INVALID_ARGUMENT"));
  for (const key of [undefined, null, NaN, {}, new Date(NaN), [undefined]]) {
    await assert.rejects(h.api.readLocalNovelRecoveryEntry(key, { expectedVersion: 1 }), code("INVALID_ARGUMENT"));
    if (key !== undefined) await assert.rejects(h.api.listLocalNovelRecoveryBooks({ afterKey: key, expectedVersion: 1 }), code("INVALID_ARGUMENT"));
  }
  assert.equal(h.opens.length, 0); assert.deepEqual(await h.factory.databases(), []);
});

test("missing selected key returns null after committing the readonly transaction and closing", async h => {
  await h.seed(); h.fence(); const from = h.connections.length;
  assert.equal(await h.api.readLocalNovelRecoveryEntry("missing", { expectedVersion: 1 }), null); assertClosed(h, from);
});

for (const operation of ["list", "read"]) {
  const run = h => operation === "list" ? h.api.listLocalNovelRecoveryBooks() : h.api.readLocalNovelRecoveryEntry("local-1", { expectedVersion: 1 });
  test(`${operation} success settles after transaction completion, never at request success`, async h => {
    await h.seed(); h.fence(); let settled = false, completed = false, boundary;
    h.controls.after = call => {
      if (boundary || !["get", "openCursor"].includes(call.method)) return;
      call.transaction.addEventListener("complete", () => { completed = true; });
      boundary = (async () => { await Promise.resolve(); await Promise.resolve(); assert.equal(completed, false); assert.equal(settled, false); })();
    };
    const result = await run(h).then(value => { settled = true; return value; }); await boundary;
    assert(boundary); assert.equal(completed, true); assert(result); assertClosed(h, 1);
  });
  test(`${operation} abort after request success rejects and leaves the entire database unchanged`, async h => {
    await h.seed(); const before = await h.snapshot(); h.fence(); const from = h.connections.length; let aborted = false;
    h.controls.after = call => { if (!aborted && ["get", "openCursor"].includes(call.method)) { aborted = true; call.transaction.abort(); } };
    await assert.rejects(run(h), code("READ_FAILED")); assert.equal(aborted, true); assertClosed(h, from);
    h.unfence(); assert.deepEqual(await h.snapshot(), before);
  });
  test(`${operation} synchronous store failure rejects with a stable code and releases its connection`, async h => {
    await h.seed(); const before = await h.snapshot(); h.fence(); const from = h.connections.length;
    h.controls.before = () => { throw new Error("synthetic store exception"); };
    await assert.rejects(run(h), error => code("READ_FAILED")(error) && error.cause?.message === "synthetic store exception"); assertClosed(h, from);
    h.unfence(); assert.deepEqual(await h.snapshot(), before);
  });
}

test("synchronous open and transaction creation failures remain retryable", async h => {
  await h.seed(); const original = h.factory.open; let once = true;
  h.factory.open = (...args) => { if (once) { once = false; throw new Error("synthetic open exception"); } return original(...args); };
  await assert.rejects(h.api.listLocalNovelRecoveryBooks(), code("OPEN_FAILED"));
  assert.equal((await h.api.listLocalNovelRecoveryBooks()).items.length, 1);
  h.controls.beforeTransaction = () => { throw new Error("synthetic transaction exception"); };
  const from = h.connections.length;
  await assert.rejects(h.api.listLocalNovelRecoveryBooks(), code("READ_FAILED")); assertClosed(h, from);
  h.unfence(); assert.equal((await h.api.listLocalNovelRecoveryBooks()).items.length, 1);
});

test("cursor continuation failure cannot publish a partial page", async h => {
  await h.seed([entry(), entry("next", "next")]); h.fence(); let injected = false;
  h.controls.after = call => { if (!injected && call.method === "openCursor" && call.request.result) { injected = true; call.request.result.continue = () => { throw new Error("cursor fail"); }; } };
  await assert.rejects(h.api.listLocalNovelRecoveryBooks(), code("READ_FAILED")); assert.equal(injected, true); assertClosed(h, 1);
});

test("fake-indexeddb forced close waits for the read transaction and leaves no live connection", async h => {
  await h.seed(); h.fence(); let closed = false;
  h.controls.after = call => { if (!closed && call.method === "get") { closed = true; forceCloseDatabase(call.transaction.db); } };
  // fake-indexeddb's closeConnection waits for transactions before firing close;
  // this is a completed read, not an abnormal-close-before-commit simulation.
  assert.equal((await h.api.readLocalNovelRecoveryEntry("local-1", { expectedVersion: 1 })).readableChapters, 4);
  assert.equal(closed, true); await turn(); assertClosed(h, 1);
});

test("an actual competing schema upgrade cancels an active recovery page and is not blocked", async h => {
  await h.seed(Array.from({ length: 20 }, (_, index) => entry(`row-${index}`, `key-${index}`)));
  let upgrade, completion;
  h.controls.after = call => {
    if (upgrade || call.method !== "openCursor" || !call.request.result) return;
    upgrade = h.factory.open(h.name, 2);
    upgrade.onupgradeneeded = () => upgrade.result.createObjectStore("externalUpgradeMarker");
    completion = requestResult(upgrade);
  };
  await assert.rejects(h.api.listLocalNovelRecoveryBooks({ limit: 20 }), code("VERSION_CHANGED"));
  assert(upgrade); const db = await completion; assert.equal(db.version, 2); db.close();
  h.unfence(); assert.equal((await h.api.listLocalNovelRecoveryBooks()).version, 2);
});

const edgeTests = [];
const edge = (name, run) => edgeTests.push({ name, run });
edge("open timeout rejects once and closes a later real fake-indexeddb connection", async production => {
  const clock = manualClock(), h = harness(production, clock);
  try {
    await h.seed(); const blocker = await h.open(1), upgrade = h.factory.open(h.name, 2);
    upgrade.onupgradeneeded = () => upgrade.result.createObjectStore("upgradedElsewhere");
    const upgradeDone = requestResult(upgrade); await turn();
    const from = h.connections.length, pending = h.api.listLocalNovelRecoveryBooks();
    const rejected = assert.rejects(pending, code("TIMEOUT")); clock.fire(2000); await rejected;
    blocker.close(); (await upgradeDone).close(); await turn(); await turn(); await turn();
    assertClosed(h, from); assert.equal(clock.size, 0);
    assert.equal((await h.api.listLocalNovelRecoveryBooks()).version, 2); assert.equal(clock.size, 0);
  } finally { h.dispose(); }
});

edge("blocked request failure still aborts a late missing-database upgrade and closes a late success", async production => {
  const clock = manualClock(), h = harness(production, clock);
  try {
    const request = {}, calls = []; let aborted = 0, closed = 0;
    h.window.indexedDB = { open(...args) { calls.push(args); return request; } };
    const pending = h.api.listLocalNovelRecoveryBooks(); const rejected = assert.rejects(pending, code("OPEN_BLOCKED"));
    request.onblocked(); await rejected; assert.equal(clock.size, 0);
    request.transaction = { abort() { aborted++; } };
    request.result = { close() { closed++; } };
    request.onupgradeneeded(); assert.equal(aborted, 1); assert.equal(closed, 1);
    request.onsuccess(); assert.equal(closed, 2); assert.equal(calls[0].length, 1); assert.equal(clock.size, 0);
  } finally { h.dispose(); }
});

edge("transaction timeout aborts and closes without returning a partial result", async production => {
  const clock = manualClock(), h = harness(production, clock);
  try {
    const request = {}, read = {}; let aborted = 0, closed = 0;
    const transaction = { abort() { aborted++; }, objectStore() { return { openCursor() { return read; } }; } };
    h.window.indexedDB = { open() { return request; } };
    const pending = h.api.listLocalNovelRecoveryBooks(); const rejected = assert.rejects(pending, code("TIMEOUT"));
    request.result = { version: 1, objectStoreNames: { contains: name => name === "books" }, close() { closed++; }, transaction() { return transaction; } };
    request.onsuccess(); clock.fire(30000); await rejected;
    assert.equal(aborted, 1); assert.equal(closed, 1); assert.equal(clock.size, 0);
    transaction.oncomplete(); assert.equal(closed, 1);
  } finally { h.dispose(); }
});

edge("abnormal close event before transaction completion rejects and releases the pending read", async production => {
  const clock = manualClock(), h = harness(production, clock);
  try {
    const request = {}, read = {}; let aborted = 0, closed = 0;
    const transaction = { abort() { aborted++; }, objectStore() { return { get() { return read; } }; } };
    h.window.indexedDB = { open() { return request; } };
    const pending = h.api.readLocalNovelRecoveryEntry("local-1", { expectedVersion: 1 });
    const rejected = assert.rejects(pending, code("CONNECTION_CLOSED"));
    const db = { version: 1, objectStoreNames: { contains: name => name === "books" }, close() { closed++; }, transaction() { return transaction; } };
    request.result = db; request.onsuccess(); db.onclose(); await rejected;
    assert.equal(aborted, 1); assert.equal(closed, 1); assert.equal(clock.size, 0);
    transaction.oncomplete(); assert.equal(closed, 1);
  } finally { h.dispose(); }
});

const mutants = [
  { name: "explicit v2 open", anchor: "request = window.indexedDB.open(LOCAL_NOVEL_DB_NAME);", replacement: "request = window.indexedDB.open(LOCAL_NOVEL_DB_NAME, 2);", test: "failed strict migration" },
  { name: "readwrite recovery", anchor: 'transaction = db.transaction([LEGACY_BOOK_STORE], "readonly");', replacement: 'transaction = db.transaction([LEGACY_BOOK_STORE], "readwrite");', test: "cursor pagination" },
  { name: "future-version gate removed", anchor: "if (![1, 2, 3].includes(db.version)) {", replacement: "if (false) {", test: "future schema v4" },
  { name: "stale-page gate removed", anchor: "if (expectedVersion !== undefined && expectedVersion !== db.version) {", replacement: "if (false) {", test: "a page from v1" },
  { name: "inclusive pagination repeats boundary", anchor: "IDBKeyRange.lowerBound(afterKey, true)", replacement: "IDBKeyRange.lowerBound(afterKey, false)", test: "cursor pagination" },
  { name: "whole-row metadata leak", anchor: "items.push({ key: cursor.primaryKey, ...metadata, exportable:", replacement: "items.push({ ...cursor.value, key: cursor.primaryKey, ...metadata, exportable:", test: "failed strict migration" },
  { name: "safe export replaced by raw entry", anchor: 'entry: { book: { title, fileName }, chapters },', replacement: "entry: row,", test: "failed strict migration" },
  { name: "request-success early settlement", anchor: "queue(transaction.objectStore(LEGACY_BOOK_STORE), watch, (value) => { result = value; }, db.version);", replacement: "queue(transaction.objectStore(LEGACY_BOOK_STORE), watch, (value) => { result = value; resolve(result); }, db.version);", test: "read success settles" },
  { name: "late-success connection not closed", anchor: "if (settled) { close(); return; }\n      if (![1, 2, 3].includes(db.version))", replacement: "if (settled) { return; }\n      if (![1, 2, 3].includes(db.version))", edge: "open timeout" },
  { name: "late-missing upgrade not aborted", anchor: "try { request.transaction.abort(); } catch {}", replacement: "/* mutation: no abort */", edge: "blocked request" }
];

let passed = 0, edgePassed = 0, controls = 0;
for (const item of tests) {
  const h = harness();
  try { await item.run(h); passed++; console.log(`PASS ${item.name}`); }
  finally { h.dispose(); }
}
for (const item of edgeTests) { await item.run(source); edgePassed++; console.log(`PASS boundary ${item.name}`); }
for (const mutant of mutants) {
  assert.equal(source.split(mutant.anchor).length, 2, `ambiguous mutant anchor: ${mutant.name}`);
  const changed = source.replace(mutant.anchor, mutant.replacement);
  let failure;
  if (mutant.edge) {
    try { await edgeTests.find(item => item.name.startsWith(mutant.edge)).run(changed); }
    catch (error) { failure = error; }
  } else {
    const h = harness(changed);
    try { await tests.find(item => item.name.startsWith(mutant.test)).run(h); }
    catch (error) { failure = error; }
    finally { h.dispose(); }
  }
  assert(failure, `mutant survived: ${mutant.name}`);
  // An assertion or an assertion embedded by the operation fence is evidence;
  // syntax/compilation errors and arbitrary fixture crashes are never accepted.
  assert(failure.code === "ERR_ASSERTION" || failure.cause?.code === "ERR_ASSERTION", `mutant failed outside a tested assertion: ${mutant.name}: ${failure.stack}`);
  controls++; console.log(`CONTROL rejected ${mutant.name}`);
}
console.log(`Novel recovery storage: ${passed} full-source fake-indexeddb scenarios + ${edgePassed} lifecycle-boundary scenarios passed; ${controls} behavioral mutants rejected.`);
console.log("Boundary: synthetic fake-indexeddb data; lifecycle-only timer/request doubles are named above. No browser/native persistence, real library, migration repair, or data deletion was exercised.");
