import fs from "node:fs";
import vm from "node:vm";
import { webcrypto, randomUUID } from "node:crypto";
import { IDBFactory, IDBKeyRange, IDBDatabase, IDBObjectStore, IDBIndex, forceCloseDatabase } from "fake-indexeddb";

// Fast in-memory simulation, never Android/browser persistence evidence.
export const productionSource = fs.readFileSync(new URL("../../android-client/www/js/local-novels.js", import.meta.url), "utf8");
export const identitySource = fs.readFileSync(new URL("../../android-client/www/js/novel-chapter-identity.js", import.meta.url), "utf8");
export const frozenV2Source = fs.readFileSync(new URL("./android-local-novels-v2-before-chapter-identity.js", import.meta.url), "utf8");
export const plain = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
export const requestResult = request => new Promise((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
export function entry(revision = "original", id = "local-1") {
  return { id, book: { id, title: `${revision} title`, author: "合成作者", sourceType: "local-file", fileName: `${revision}.txt`, local: true,
    sourceKey: "PRIVATE_TEXT_FRAGMENT", metadata: { revision }, updatedAt: "2026-01-02T03:04:05.000Z",
    progress: { chapterIndex: 1, scrollRatio: 0.1, updatedAt: "2026-01-02T03:04:05.000Z" } },
    chapters: [1, 2, 3, 4].map(index => ({ id: `${id}-${index}`, bookId: id, index, title: `第${index}章`,
      content: `${revision} 正文 ${index}\n尾段`, metadata: { revision, index }, preamble: index === 1 })),
    createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-02T03:04:05.000Z", importFingerprint: `keep-${revision}`, futureField: { nested: [1, 2] }, bytes: 123 };
}
export function harness({ source = productionSource, persist = async () => false } = {}) {
  const name = `novel-v2-node-${randomUUID()}`, indexedDB = new IDBFactory(), connections = new Set(), restores = [], operations = [];
  const controls = { before: null, after: null, persistCalls: 0 };
  for (const prototype of [IDBObjectStore.prototype, IDBIndex.prototype]) {
    for (const method of ["get", "getAll", "getAllKeys", "openCursor", "openKeyCursor", "put", "delete", "clear"]) {
      const original = prototype[method]; if (typeof original !== "function") continue;
      prototype[method] = function (...args) {
        const store = this.transaction ? this : this.objectStore;
        if (store.transaction.db.name !== name) return original.apply(this, args);
        const call = { store: store.name, method, args, transaction: store.transaction };
        controls.before?.(call); const request = original.apply(this, args); operations.push(call);
        request.addEventListener("success", () => controls.after?.({ ...call, request })); return request;
      };
      restores.push(() => { prototype[method] = original; });
    }
  }
  const originalOpen = indexedDB.open.bind(indexedDB);
  indexedDB.open = (...args) => { const request = originalOpen(...args); request.addEventListener("success", () => connections.add(request.result)); return request; };
  const evaluate = (source) => {
  const exports = [...source.matchAll(/^export\s+(?:async\s+)?function\s+(\w+)/gm)].map(match => match[1]);
  const transformed = source.replace(/^import .*;\r?\n/gm, "").replace(/const LOCAL_NOVEL_DB_NAME = "[^"]+";/, `const LOCAL_NOVEL_DB_NAME = ${JSON.stringify(name)};`).replace(/^export /gm, "");
  return vm.runInNewContext(`${identitySource.replace(/^export /gm, "")}\n${transformed}\n({${exports.join(",")}})`, { Blob, Date, console, structuredClone, crypto: webcrypto, indexedDB, IDBKeyRange, setTimeout, clearTimeout, queueMicrotask,
    window: { indexedDB, setTimeout, clearTimeout }, navigator: { storage: { persist: () => { controls.persistCalls++; return persist(); } } } });
  };
  const api = evaluate(source);
  return { name, indexedDB, api, evaluate, operations, controls,
    async seed(rows = [entry()]) {
      const request = indexedDB.open(name, 1); request.onupgradeneeded = () => { const store = request.result.createObjectStore("books", { keyPath: "id" }); store.createIndex("updatedAt", "updatedAt"); store.createIndex("title", "book.title"); for (const row of rows) store.put(row); };
      const db = await requestResult(request); db.close(); operations.length = 0;
    },
    async seedV2(current = entry("v2-current"), legacy = entry()) {
      await this.seed([legacy]);
      const old = evaluate(frozenV2Source);
      await old.loadLocalNovelSummaries(); await old.saveLocalNovelEntry(current);
      for (const db of connections) db.close();
      operations.length = 0;
    },
    open(version) { return requestResult(indexedDB.open(name, version)); },
    async rows(storeName) { const db = await requestResult(indexedDB.open(name)); try { return plain(await requestResult(db.transaction(storeName).objectStore(storeName).getAll())); } finally { db.close(); } },
    forceClose() { for (const db of connections) forceCloseDatabase(db); },
    dispose() { for (const db of connections) { try { db.close(); } catch {} } for (const restore of restores.reverse()) restore(); }
  };
}
