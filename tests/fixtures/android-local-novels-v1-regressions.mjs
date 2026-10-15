import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import vm from "node:vm";

// Historical v1 commit/abort regressions; not evidence for the current v2 module.
const sourcePath = new URL("./android-local-novels-v1.js", import.meta.url);
const source = fs.readFileSync(sourcePath, "utf8");
const apiNames = [
  "loadLocalNovelEntries", "readLocalNovelEntry", "saveLocalNovelEntry",
  "saveLocalNovelProgress", "deleteLocalNovelEntry"
];
const plain = (value) => JSON.parse(JSON.stringify(value));
const clone = (value) => structuredClone(value);

function book(revision = "original") {
  return {
    id: "local-1",
    book: {
      id: "local-1", title: `${revision} title`, author: `${revision} author`,
      category: "本机", sourceFile: `${revision}.txt`, updatedAt: "2026-01-02T03:04:05.000Z",
      metadata: { revision, encoding: "UTF-8" },
      progress: { chapterIndex: 1, scrollRatio: 0.1, updatedAt: "2026-01-02T03:04:05.000Z" }
    },
    chapters: [{ index: 1, title: `${revision} chapter`, content: `${revision} 正文`, metadata: { revision } }],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-02T03:04:05.000Z",
    importFingerprint: `keep-${revision}`,
    bytes: 123
  };
}

function observe(promise) {
  const result = { state: "pending" };
  promise.then(
    (value) => Object.assign(result, { state: "resolved", value }),
    (error) => Object.assign(result, { state: "rejected", error })
  );
  return result;
}

async function flushMicrotasks() {
  for (let index = 0; index < 12; index += 1) await Promise.resolve();
}

// A deliberately small, in-memory IDB fixture, not a browser or production DB.
// Model the platform rules needed here: same-store transactions are serialized,
// requests operate on staged copies, success callbacks can queue more requests,
// and only transaction completion commits; abort rolls the staged copy back.
// https://developer.mozilla.org/en-US/docs/Web/API/IDBTransaction
// https://developer.mozilla.org/en-US/docs/Web/API/IDBTransaction/complete_event
function createHarness({ rows = [book()], persist = () => Promise.resolve(true) } = {}) {
  const events = [];
  const operations = [];
  const transactions = [];
  const waiting = [];
  const db = {
    rows: new Map(rows.map((row) => [row.id, clone(row)])),
    requestError: null,
    objectStoreNames: { contains: () => true },
    close() {},
    transaction(storeName, mode) {
      assert.equal(storeName, "books");
      assert.ok(mode === "readonly" || mode === "readwrite");
      const transaction = new MemoryTransaction(mode);
      transactions.push(transaction);
      waiting.push(transaction);
      if (waiting.length === 1) events.push(() => transaction.start());
      return transaction;
    }
  };

  class MemoryTransaction {
    constructor(mode) {
      this.id = transactions.length + 1;
      this.mode = mode;
      this.state = "queued";
      this.active = true;
      this.error = null;
      this.requests = [];
      this.abortAtCommit = false;
      this.abortError = null;
      this.store = {
        get: (key) => this.enqueue("get", key),
        getAll: () => this.enqueue("getAll"),
        put: (row) => this.enqueue("put", row.id, clone(row)),
        delete: (key) => this.enqueue("delete", key)
      };
    }

    objectStore(name) {
      assert.equal(name, "books");
      return this.store;
    }

    enqueue(operation, key, row) {
      if (this.state !== "queued" && !this.active) throw new Error("TransactionInactiveError");
      if (operation === "put" || operation === "delete") assert.equal(this.mode, "readwrite");
      const request = { transaction: this, result: undefined, error: null };
      this.requests.push({ operation, key, row, request });
      return request;
    }

    start() {
      this.state = "running";
      this.active = false;
      this.staged = new Map([...db.rows].map(([key, row]) => [key, clone(row)]));
      this.next();
    }

    next() {
      if (this.state !== "running") return;
      if (this.requests.length) events.push(() => this.runRequest(this.requests.shift()));
      else events.push(() => this.complete());
    }

    runRequest({ operation, key, row, request }) {
      if (this.state !== "running") return;
      this.active = true;
      const injected = db.requestError;
      if (injected?.operation === operation) {
        db.requestError = null;
        request.error = injected.error;
        const event = { target: request };
        request.onerror?.(event);
        this.onerror?.(event);
        this.abort(injected.error);
        this.active = false;
        return;
      }
      if (operation === "get") request.result = clone(this.staged.get(key));
      if (operation === "getAll") request.result = clone([...this.staged.values()]);
      if (operation === "put") {
        this.staged.set(key, clone(row));
        request.result = key;
      }
      if (operation === "delete") this.staged.delete(key);
      operations.push({ transaction: this, operation, key });
      try {
        request.onsuccess?.({ target: request });
        db.afterRequestSuccess?.({ transaction: this, operation, key });
      } catch (error) {
        this.abort(error);
      }
      this.active = false;
      this.next();
    }

    abort(error = null) {
      if (this.state === "aborted" || this.state === "complete" || this.state === "aborting") return;
      this.state = "aborting";
      this.error = error;
      events.push(() => {
        this.state = "aborted";
        this.onabort?.({ target: this });
        this.release();
      });
    }

    complete() {
      if (this.state !== "running") return;
      if (this.abortAtCommit) {
        this.abort(this.abortError);
        return;
      }
      if (this.mode === "readwrite") db.rows = this.staged;
      this.state = "complete";
      this.oncomplete?.({ target: this });
      this.release();
    }

    release() {
      assert.equal(waiting.shift(), this);
      if (waiting.length) events.push(() => waiting[0].start());
    }
  }

  const indexedDB = {
    open() {
      const request = { result: db, error: null };
      events.push(() => request.onsuccess?.({ target: request }));
      return request;
    }
  };
  let persistCalls = 0;
  const sandbox = {
    Blob, Date, console,
    indexedDB,
    window: { indexedDB, setTimeout: () => 1, clearTimeout() {} },
    navigator: { storage: { persist: () => persist(++persistCalls) } }
  };
  // Execute the production module unchanged except for its ESM export keywords.
  const api = vm.runInNewContext(
    `${source.replace(/^export /gm, "")}\n({ ${apiNames.join(", ")} });`,
    sandbox,
    { filename: sourcePath.pathname }
  );
  return {
    api, db, operations, transactions,
    get persistCalls() { return persistCalls; },
    async until(predicate, message = "operation did not reach the expected state") {
      for (let count = 0; count < 200; count += 1) {
        await flushMicrotasks();
        if (predicate()) return;
        assert.ok(events.length, message);
        events.shift()();
      }
      assert.fail(message);
    },
    async settle(promise) {
      const observed = observe(promise);
      await this.until(() => observed.state !== "pending");
      if (observed.state === "rejected") throw observed.error;
      return observed.value;
    },
    async drain() {
      for (let count = 0; count < 200; count += 1) {
        await flushMicrotasks();
        if (!events.length) return;
        events.shift()();
      }
      assert.fail("fixture event queue did not drain");
    }
  };
}

const writers = [
  { name: "save entry", operation: "put", run: (api) => api.saveLocalNovelEntry(book("replacement")) },
  { name: "save progress", operation: "put", run: (api) => api.saveLocalNovelProgress("local-1", { chapterIndex: 3, scrollRatio: 0.6 }) },
  { name: "delete entry", operation: "delete", run: (api) => api.deleteLocalNovelEntry("local-1") }
];

for (const writer of writers) {
  await test(`${writer.name}: request success does not settle before commit`, async () => {
    const harness = createHarness();
    const observed = observe(writer.run(harness.api));
    await harness.until(() => harness.operations.some((item) => item.operation === writer.operation));
    assert.equal(observed.state, "pending", "request success must not be reported as transaction success");
    assert.deepEqual(harness.db.rows.get("local-1"), book(), "uncommitted data must stay isolated");
    await harness.until(() => observed.state !== "pending");
    assert.equal(observed.state, "resolved");
    const transaction = harness.operations.find((item) => item.operation === writer.operation).transaction;
    assert.equal(transaction.state, "complete");
    if (writer.operation === "delete") {
      assert.equal(observed.value, undefined);
      assert.equal(harness.db.rows.has("local-1"), false);
    } else {
      assert.equal(observed.value.book.id, "local-1");
      assert.ok(harness.db.rows.get("local-1").bytes > 0);
    }
  });

  await test(`${writer.name}: abort after request success rejects and rolls back`, async () => {
    const harness = createHarness();
    const observed = observe(writer.run(harness.api));
    await harness.until(() => harness.operations.some((item) => item.operation === writer.operation));
    const transaction = harness.operations.find((item) => item.operation === writer.operation).transaction;
    const failure = new Error("injected commit I/O failure");
    transaction.abortAtCommit = true;
    transaction.abortError = failure;
    await harness.until(() => observed.state !== "pending");
    assert.equal(observed.state, "rejected");
    assert.equal(observed.error, failure);
    await harness.drain();
    assert.deepEqual(harness.db.rows.get("local-1"), book());
  });
}

await test("progress queued after deletion cannot resurrect the book", async () => {
  const harness = createHarness();
  const deletion = observe(harness.api.deleteLocalNovelEntry("local-1"));
  const progress = observe(harness.api.saveLocalNovelProgress("local-1", { chapterIndex: 5, scrollRatio: 0.7 }));
  await harness.until(() => progress.state !== "pending" && deletion.state !== "pending");
  await harness.drain();
  assert.equal(deletion.state, "resolved");
  assert.equal(progress.state, "resolved");
  assert.equal(progress.value, null);
  assert.equal(harness.db.rows.has("local-1"), false);
  assert.equal(harness.operations.some((item) => item.operation === "put"), false);
});

await test("progress queued after reimport reads the replacement body and metadata", async () => {
  const harness = createHarness();
  const replacement = observe(harness.api.saveLocalNovelEntry(book("replacement")));
  await harness.until(() => harness.transactions.length === 1);
  assert.equal(harness.transactions[0].state, "queued");
  const progress = observe(harness.api.saveLocalNovelProgress("local-1", { chapterIndex: 4, scrollRatio: 0.75 }));
  await harness.until(() => progress.state !== "pending" && replacement.state !== "pending");
  await harness.drain();
  assert.equal(replacement.state, "resolved");
  assert.equal(progress.state, "resolved");
  const stored = harness.db.rows.get("local-1");
  assert.deepEqual(stored.chapters, plain(replacement.value.chapters));
  assert.deepEqual(stored.book.metadata, { revision: "replacement", encoding: "UTF-8" });
  assert.equal(stored.book.title, replacement.value.book.title);
  assert.equal(stored.book.author, replacement.value.book.author);
  assert.equal(stored.book.sourceFile, replacement.value.book.sourceFile);
  assert.equal(stored.book.progress.chapterIndex, 4);
  assert.equal(stored.book.progress.scrollRatio, 0.75);
  assert.equal(progress.value.chapters[0].content, "replacement 正文");
});

await test("consecutive progress calls commit in call order and retain the newest value", async () => {
  const harness = createHarness();
  const older = observe(harness.api.saveLocalNovelProgress("local-1", { chapterIndex: 2, scrollRatio: 0.2 }));
  const newer = observe(harness.api.saveLocalNovelProgress("local-1", { chapterIndex: 7, scrollRatio: 0.8 }));
  await harness.until(() => older.state !== "pending" && newer.state !== "pending");
  await harness.drain();
  assert.equal(older.state, "resolved");
  assert.equal(newer.state, "resolved");
  assert.equal(older.value.book.progress.chapterIndex, 2);
  assert.equal(newer.value.book.progress.chapterIndex, 7);
  assert.equal(harness.db.rows.get("local-1").book.progress.chapterIndex, 7);
  assert.equal(harness.db.rows.get("local-1").book.progress.scrollRatio, 0.8);
  assert.deepEqual(harness.operations.map(({ operation, transaction }) => [operation, transaction.id]), [
    ["get", 1], ["put", 1], ["get", 2], ["put", 2]
  ]);
});

await test("progress never requests or waits for storage persistence", async () => {
  const harness = createHarness({ persist: () => new Promise(() => {}) });
  const saved = await harness.settle(harness.api.saveLocalNovelProgress("local-1", { chapterIndex: 3 }));
  assert.equal(saved.book.progress.chapterIndex, 3);
  assert.equal(await harness.settle(harness.api.saveLocalNovelProgress("missing")), null);
  assert.equal(harness.persistCalls, 0);
});

await test("progress read and write share one transaction, so a queued deletion wins", async () => {
  const harness = createHarness();
  let deletion;
  harness.db.afterRequestSuccess = ({ operation }) => {
    if (operation === "get" && !deletion) deletion = observe(harness.api.deleteLocalNovelEntry("local-1"));
  };
  const progress = observe(harness.api.saveLocalNovelProgress("local-1", { chapterIndex: 2 }));
  await harness.until(() => progress.state !== "pending" && deletion && deletion.state !== "pending");
  await harness.drain();
  assert.equal(harness.db.rows.has("local-1"), false, "late progress must not resurrect a deleted book");
  const get = harness.operations.find((item) => item.operation === "get");
  const put = harness.operations.find((item) => item.operation === "put");
  assert.equal(get.transaction.mode, "readwrite");
  assert.equal(get.transaction, put.transaction);
  assert.equal(progress.state, "resolved");
  assert.equal(deletion.state, "resolved");
});

await test("normal progress preserves current metadata and aliases while updating its byte estimate", async () => {
  const harness = createHarness();
  const result = await harness.settle(harness.api.saveLocalNovelProgress("local-1", { chapter_index: 9, scroll_ratio: 0.4 }));
  const stored = harness.db.rows.get("local-1");
  assert.equal(result.book.progress.chapterIndex, 9);
  assert.equal(result.book.progress.scrollRatio, 0.4);
  assert.equal(stored.book.progress.updatedAt, stored.updatedAt);
  assert.equal(stored.book.updatedAt, book().book.updatedAt);
  assert.equal(stored.createdAt, book().createdAt);
  assert.equal(stored.importFingerprint, book().importFingerprint);
  assert.equal(stored.chapters[0].content, book().chapters[0].content);
  assert.deepEqual(stored.chapters[0].metadata, book().chapters[0].metadata);
  assert.deepEqual(stored.book.metadata, book().book.metadata);
  assert.ok(stored.bytes > 123);
  assert.equal(result.bytes, stored.bytes);
  const clamped = await harness.settle(harness.api.saveLocalNovelProgress("local-1", { chapterIndex: -3, scrollRatio: 7 }));
  assert.equal(clamped.book.progress.chapterIndex, 1);
  assert.equal(clamped.book.progress.scrollRatio, 1);
  const entries = await harness.settle(harness.api.loadLocalNovelEntries());
  assert.equal(entries.length, 1);
  assert.equal(entries[0].book.progress.chapterIndex, 1);
});

await test("missing or invalid books are not created by progress", async () => {
  const harness = createHarness({ rows: [] });
  assert.equal(await harness.settle(harness.api.saveLocalNovelProgress("missing", { chapterIndex: 2 })), null);
  assert.equal(await harness.settle(harness.api.saveLocalNovelProgress("")), null);
  assert.equal(await harness.settle(harness.api.readLocalNovelEntry("")), null);
  assert.equal(await harness.settle(harness.api.deleteLocalNovelEntry("")), undefined);
  assert.equal(harness.operations.some((item) => item.operation === "put"), false);
  assert.equal(harness.db.rows.size, 0);
  await assert.rejects(harness.api.saveLocalNovelEntry({}), /本地小说缺少 ID/);
});

await test("request failures preserve the original error and cannot report successful progress", async () => {
  for (const operation of ["get", "put"]) {
    const harness = createHarness();
    const error = new Error(`injected ${operation} failure`);
    harness.db.requestError = { operation, error };
    const observed = observe(harness.api.saveLocalNovelProgress("local-1", { chapterIndex: 7 }));
    await harness.until(() => observed.state !== "pending");
    assert.equal(observed.state, "rejected");
    assert.equal(observed.error, error);
    await harness.drain();
    assert.deepEqual(harness.db.rows.get("local-1"), book());
  }
});

await test("an explicit abort without an IDB error still rejects with the existing fallback", async () => {
  const harness = createHarness();
  const observed = observe(harness.api.saveLocalNovelProgress("local-1", { chapterIndex: 8 }));
  await harness.until(() => harness.operations.some((item) => item.operation === "put"));
  harness.operations.find((item) => item.operation === "put").transaction.abort();
  await harness.until(() => observed.state !== "pending");
  assert.equal(observed.state, "rejected");
  assert.match(observed.error.message, /本地小说库读写失败/);
  assert.deepEqual(harness.db.rows.get("local-1"), book());
});

await test("a failed persistence request remains non-fatal", async () => {
  const harness = createHarness({ persist: () => Promise.reject(new Error("persist denied")) });
  const saved = await harness.settle(harness.api.saveLocalNovelEntry(book("replacement")));
  assert.equal(saved.book.title, "replacement title");
  const progress = await harness.settle(harness.api.saveLocalNovelProgress("local-1", { chapterIndex: 2 }));
  assert.equal(progress.book.progress.chapterIndex, 2);
});
