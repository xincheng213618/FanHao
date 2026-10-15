const status = document.querySelector("#status"), list = document.querySelector("#cases"), reportNode = document.querySelector("#report");
const cases = [], databases = new Set(), connections = new Set();
let checks = 0, run;
const check = (condition, message) => { checks++; if (!condition) throw new Error(message); };
const requestResult = request => new Promise((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
const transactionDone = transaction => new Promise((resolve, reject) => { transaction.oncomplete = resolve; transaction.onabort = () => reject(transaction.error || new Error("aborted")); transaction.onerror = () => {}; });
const open = async name => { const db = await requestResult(indexedDB.open(name)); connections.add(db); return db; };
const input = (letters = ["A", "B", "C"]) => ({ book: { id: "local:synthetic-chapters", local: true, title: "Synthetic only", author: "Fixture" },
  chapters: letters.map((letter, offset) => ({ id: `legacy-${letter}`, bookId: "local:synthetic-chapters", index: offset + 1, title: letter, content: `Synthetic body ${letter}`, charCount: 20 })) });
async function context() {
  const id = crypto.randomUUID(), name = `fanhao-idb-chapter-fixture-${id}`;
  databases.add(name);
  const module = file => import(`/run/${run.runId}/${id}/${crypto.randomUUID()}/${file}`);
  return { name, current: () => module("storage.js"), legacy: () => module("legacy.js") };
}
async function writeRaw(name, store, action) {
  const db = await open(name), tx = db.transaction(store, "readwrite");
  const done = transactionDone(tx); action(tx.objectStore(store)); await done; db.close(); connections.delete(db);
}
async function readRaw(name, store, key) {
  const db = await open(name), tx = db.transaction(store, "readonly");
  const done = transactionDone(tx), result = await requestResult(tx.objectStore(store).get(key)); await done;
  db.close(); connections.delete(db); return result;
}
async function readAt(api, index, ratio = .63) {
  const data = await api.readLocalNovelChapter("local:synthetic-chapters", index);
  const saved = await api.saveLocalNovelProgress(data.book.id, { chapterId: data.chapter.id, chapterIndex: index,
    catalogRevision: data.book.catalogRevision, scrollRatio: ratio }, { expectedGeneration: data.generation });
  check(Boolean(saved), "Explicit anchored progress must save"); return data;
}
async function publish() {
  const report = { runId: run.runId, status: "running", checks, cases, scope: "Native browser IndexedDB; synthetic UUID databases only", ...run };
  reportNode.textContent = JSON.stringify(report, null, 2);
  await fetch("/report", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(report) });
}
async function test(name, fn) {
  const row = document.createElement("li"); row.textContent = `${name}：运行中`; list.append(row);
  try { await fn(); cases.push({ name, passed: true }); row.textContent = `PASS ${name}`; row.className = "pass"; }
  catch (error) { cases.push({ name, passed: false, error: String(error.stack || error) }); row.textContent = `FAIL ${name}：${error.message}`; row.className = "fail"; }
  await publish();
}
document.querySelector("#run").addEventListener("click", async event => {
  event.target.disabled = true; status.textContent = "正在运行真实 IndexedDB 场景";
  const originalOpen = IDBFactory.prototype.open;
  IDBFactory.prototype.open = function(name, ...args) {
    if (!databases.has(name)) throw new Error("Fixture attempted an unowned database");
    const request = originalOpen.call(this, name, ...args);
    request.addEventListener("success", () => connections.add(request.result)); return request;
  };
  const originalPersist = navigator.storage.persist.bind(navigator.storage);
  navigator.storage.persist = async () => false;
  try {
    run = await (await fetch("/start", { method: "POST" })).json();
    await test("v2升级保留当前正文和旧ID，旧进度待确认，旧副本仅供取回", async () => {
      const c = await context(), legacy = await c.legacy(), old = input();
      old.book.progress = { chapterIndex: 2, scrollRatio: .63, updatedAt: "2026-01-01T00:00:00.000Z" };
      await legacy.saveLocalNovelEntry(old);
      const backup = input(); backup.chapters[1].content = "OLD BACKUP, NOT CURRENT";
      await writeRaw(c.name, "books", store => store.put({ id: old.book.id, ...backup }));
      const api = await c.current(), current = await api.readLocalNovelEntry(old.book.id);
      check(current.chapters[1].content === old.chapters[1].content, "Migration replayed old backup");
      check(current.chapters[1].id === "legacy-B", "Migration unnecessarily changed old ID");
      check(!current.book.progress && current.book.progressRecovery?.reason === "legacy_unverified", "Old ordinal falsely treated as verified");
      check(current.book.progressRecovery.previous.scrollRatio === .63, "Old ratio lost");
      const recovered = await api.readLocalNovelRecoveryEntry(old.book.id, { expectedVersion: 3 });
      check(recovered.version === 3, "Recovery does not support v3");
      check(JSON.stringify(recovered).includes("OLD BACKUP, NOT CURRENT"), "Legacy body not available for explicit recovery");
      check(JSON.stringify(await readRaw(c.name, "books", old.book.id)) === JSON.stringify({ id: old.book.id, ...backup }), "Legacy snapshot modified");
    });
    await test("插章和调序保留章节ID及比例，旧会话写入被拒绝", async () => {
      const c = await context(), api = await c.current(); await api.saveLocalNovelEntry(input(), { expectedGeneration: null });
      const old = await readAt(api, 2), saved = await api.saveLocalNovelEntry(input(["X", "A", "B", "C"]), { expectedGeneration: old.generation });
      check(saved.book.progress.chapterId === old.chapter.id && saved.book.progress.chapterIndex === 3 && saved.book.progress.scrollRatio === .63, "Insertion lost/misplaced anchor");
      check(saved.book.catalogRevision !== old.book.catalogRevision, "Revision not advanced");
      const newer = await api.saveLocalNovelEntry(input(["C", "B", "X", "A"]), { expectedGeneration: saved.generation });
      check(newer.book.progress.chapterIndex === 2 && newer.book.progress.chapterId === old.chapter.id, "Reorder lost identity");
      check(await api.saveLocalNovelProgress(old.book.id, { chapterId: old.chapter.id, chapterIndex: 2, catalogRevision: old.book.catalogRevision, scrollRatio: .1 }, { expectedGeneration: old.generation }) === null, "Old session overwrote progress");
      check((await api.readLocalNovelSummary(old.book.id)).book.progress.scrollRatio === .63, "Rejected write changed ratio");
    });
    await test("改正文生成待复核候选，后续重导不能自动确认", async () => {
      const c = await context(), api = await c.current(); await api.saveLocalNovelEntry(input()); const old = await readAt(api, 2);
      const changed = input(); changed.chapters[1].content = "Different synthetic B body";
      const saved = await api.saveLocalNovelEntry(changed, { expectedGeneration: old.generation });
      check(!saved.book.progress && saved.book.progressRecovery.status === "needs_review", "Changed text inherited resolved ratio");
      check(saved.book.progressRecovery.candidate.chapterId !== old.chapter.id && saved.book.progressRecovery.candidate.scrollRatio === 0, "Candidate reused old identity/ratio");
      const again = await api.saveLocalNovelEntry(changed, { expectedGeneration: saved.generation });
      check(!again.book.progress && again.book.progressRecovery.status === "unresolved" && !again.book.progressRecovery.candidate, "Another import silently revived review");
      check(again.book.progressRecovery.previous.chapterId === old.chapter.id, "Original anchor lost");
      await readAt(api, 2, .1);
      check(!(await api.readLocalNovelSummary(old.book.id)).book.progressRecovery, "Explicit choice failed to clear recovery");
    });
    await test("重复正文和删章保留未决旧锚点", async () => {
      for (const duplicate of [true, false]) {
        const c = await context(), api = await c.current(); await api.saveLocalNovelEntry(input()); const old = await readAt(api, 2);
        const changed = input(duplicate ? ["A", "B", "B", "C"] : ["A", "C"]);
        const saved = await api.saveLocalNovelEntry(changed, { expectedGeneration: old.generation });
        check(!saved.book.progress && saved.book.progressRecovery.status === "unresolved", "Ambiguous/deleted chapter guessed");
        check(saved.book.progressRecovery.previous.chapterId === old.chapter.id && saved.book.progressRecovery.previous.scrollRatio === .63, "Unresolved anchor lost");
      }
    });
    await test("旧导入不能覆盖新代次，删除后不能被旧任务复活", async () => {
      const c = await context(), api = await c.current(), first = await api.saveLocalNovelEntry(input());
      const second = await api.saveLocalNovelEntry(input(["X", "A", "B"]), { expectedGeneration: first.generation });
      check(await api.saveLocalNovelEntry(input(), { expectedGeneration: first.generation }) === null, "Stale import overwrote replacement");
      await api.deleteLocalNovelEntry(first.book.id);
      check(await api.saveLocalNovelEntry(input(), { expectedGeneration: second.generation }) === null, "Deleted book revived");
      check(await api.readLocalNovelSummary(first.book.id) === null, "Deleted book is visible");
    });
    await test("损坏v2升级整体回滚，旧版本和原行保持", async () => {
      const c = await context(), legacy = await c.legacy(), entry = input(); await legacy.saveLocalNovelEntry(entry);
      const before = await readRaw(c.name, "bookMetadata", entry.book.id);
      await writeRaw(c.name, "chapterBodies", store => store.delete([entry.book.id, 2]));
      const api = await c.current(); let rejected = false; try { await api.readLocalNovelSummary(entry.book.id); } catch { rejected = true; }
      check(rejected, "Corrupt migration silently skipped body");
      const db = await open(c.name); check(db.version === 2, "Failed upgrade committed v3"); db.close(); connections.delete(db);
      check(JSON.stringify(await readRaw(c.name, "bookMetadata", entry.book.id)) === JSON.stringify(before), "Failed migration modified old metadata");
      check(await readRaw(c.name, "chapterBodies", [entry.book.id, 2]) === undefined, "Failed migration invented body");
    });
    await test("摘要及进度操作不访问正文，跨章ID写入被拒绝", async () => {
      const c = await context(), api = await c.current(); const saved = await api.saveLocalNovelEntry(input()); const chapter = await api.readLocalNovelChapter(saved.book.id, 2);
      const original = IDBDatabase.prototype.transaction;
      IDBDatabase.prototype.transaction = function(names, ...args) {
        const stores = typeof names === "string" ? [names] : Array.from(names);
        if (stores.includes("chapterBodies") || stores.includes("books") || stores.includes("bookExtras")) throw new Error("Summary/progress touched body or backup");
        return original.call(this, names, ...args);
      };
      try {
        check((await api.loadLocalNovelSummaries()).length === 1, "Summary unavailable without body");
        check(Boolean(await api.saveLocalNovelProgress(saved.book.id, { chapterId: chapter.chapter.id, chapterIndex: 2, catalogRevision: saved.book.catalogRevision, scrollRatio: .4 }, { expectedGeneration: saved.generation })), "Anchored progress requires body");
        check(await api.saveLocalNovelProgress(saved.book.id, { chapterId: chapter.chapter.id, chapterIndex: 1, catalogRevision: saved.book.catalogRevision, scrollRatio: .5 }, { expectedGeneration: saved.generation }) === null, "Wrong index accepted with different chapter ID");
      } finally { IDBDatabase.prototype.transaction = original; }
    });
  } catch (error) { cases.push({ name: "fixture infrastructure", passed: false, error: String(error.stack || error) }); }
  finally {
    for (const connection of connections) { try { connection.close(); } catch {} }
    IDBFactory.prototype.open = originalOpen; navigator.storage.persist = originalPersist;
    for (const name of databases) { try { await requestResult(indexedDB.deleteDatabase(name)); } catch (error) { cases.push({ name: "cleanup", passed: false, error: error.message }); } }
    const passed = cases.every(item => item.passed), final = { runId: run?.runId, status: passed ? "passed" : "failed", checks, cases, cleanedDatabases: databases.size, sourceHashes: run?.hashes };
    reportNode.textContent = JSON.stringify(final, null, 2); status.textContent = `${passed ? "通过" : "失败"}：${cases.length} 个场景，${checks} 条检查；已清理 ${databases.size} 个合成库`;
    await fetch("/report", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(final) });
  }
});
