import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createNovelStore } from "../src/modules/novels/server/store.js";
import { createNovelWriteWorkerClient } from "../src/modules/novels/server/write-worker-client.js";

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "fanhao-novel-summary-"));
const dbPath = path.join(temporary, "novels.sqlite");
const replacementPath = path.join(temporary, "replacement.sqlite");
const store = createNovelStore({ dbPath });
const replacement = createNovelStore({ dbPath: replacementPath });
const originalPrepare = DatabaseSync.prototype.prepare;
let aggregates = 0;
let beforeQuery = null;
let external = null;
DatabaseSync.prototype.prepare = function (sql) {
  if (/COUNT\(DISTINCT NULLIF|GROUP BY COALESCE\(category|GROUP BY source_root/.test(sql)) aggregates += 1;
  if (beforeQuery && /SELECT COUNT\(\*\) AS count FROM novel_books b/.test(sql)) {
    const callback = beforeQuery;
    beforeQuery = null;
    callback();
  }
  return originalPrepare.call(this, sql);
};

try {
  const first = store.uploadBook({ fileName: "first.txt", category: "分类一", text: "第一章 测试\n第一本书的测试正文。" });
  const second = store.uploadBook({ fileName: "second.txt", category: "分类二", text: "第一章 测试\n第二本书的测试正文。" });
  const url = new URL("http://fixture/api/novels?limit=1");
  aggregates = 0;
  const initial = store.listBooks(url);
  assert.equal(aggregates, 3, "one page should build totals/categories/roots only once");
  assert.deepEqual(initial.facets, initial.summary.categories);
  assert.match(initial.listRevision, /^[0-9a-f]{64}$/);
  assert.equal(initial.nextOffset, 1);
  const next = store.listBooks(new URL("http://fixture/api/novels?limit=1&offset=1"));
  assert.equal(aggregates, 3, "unchanged pages must reuse the static summary");
  assert.equal(next.summary.totals.books, 2);
  assert.equal(next.listRevision, initial.listRevision, "unchanged pages must share a list revision across reopened connections");
  assert.equal(next.nextOffset, 2);

  store.saveProgress(first.book.id, { chapterIndex: 1, scrollRatio: 0.4 });
  const reading = store.summary();
  assert.equal(aggregates, 6, "a changed storage stamp must conservatively rebuild static aggregates");
  assert.equal(reading.recent[0].id, first.book.id);
  assert.equal(reading.recent[0].progress.scrollRatio, 0.4);
  store.summary();
  assert.equal(aggregates, 6, "the unchanged catalog should be reusable after the progress refresh");
  store.updateBookMetadata(second.book.id, { title: "更新后的书名", category: "新的分类" });
  assert.ok(store.summary().categories.some((item) => item.name === "新的分类"));
  assert.equal(aggregates, 9, "a local catalog edit must invalidate static aggregates");

  external = new DatabaseSync(dbPath);
  external.exec(`UPDATE novel_books SET category = '外部分类', chapter_count = 7 WHERE id = '${first.book.id}';`);
  const externallyUpdated = store.summary();
  assert.ok(externallyUpdated.categories.some((item) => item.name === "外部分类"));
  assert.equal(externallyUpdated.totals.chapters, 8);
  assert.equal(aggregates, 12, "external storage edits must be noticed even without a scanned_at change");
  beforeQuery = () => external.exec(`UPDATE novel_books SET category = '快照后分类' WHERE id = '${first.book.id}'; INSERT OR REPLACE INTO novel_meta (key,value) VALUES ('scanned_at','new-scan');`);
  const snapshot = store.listBooks(url);
  assert.ok(snapshot.summary.categories.some((item) => item.name === "外部分类"), "the response must keep the snapshot pinned before an external commit");
  assert.notEqual(snapshot.summary.scannedAt, "new-scan");
  const afterSnapshot = store.listBooks(url);
  assert.equal(afterSnapshot.summary.scannedAt, "new-scan");
  assert.ok(afterSnapshot.summary.categories.some((item) => item.name === "快照后分类"), "the next snapshot must see the external commit");
  assert.notEqual(snapshot.listRevision, afterSnapshot.listRevision, "a writer committing within the pinned read must invalidate the next append");
  assert.equal(store.listBooks(url).listRevision, afterSnapshot.listRevision, "a later stable snapshot can reuse its revision");

  store.invalidate();
  assert.equal(store.summary().totals.books, 2, "invalidated connections must reopen normally");
  external.close();
  external = null;
  replacement.uploadBook({ fileName: "replacement.txt", text: "第一章 替换\n替换后的独立书库。" });
  const replacementRealm = replacement.summary().sourceRealm;
  replacement.invalidate();
  fs.renameSync(dbPath, path.join(temporary, "retired.sqlite"));
  fs.renameSync(replacementPath, dbPath);
  const replaced = store.summary();
  assert.equal(replaced.sourceRealm, replacementRealm, "a replaced database file must not reuse the old source identity/cache");
  assert.equal(replaced.totals.books, 1);
  store.invalidate();
  assert.equal(store.summary().totals.books, 1);
  assert.notEqual(store.listBooks(url).listRevision, afterSnapshot.listRevision, "database replacement cannot reuse the retired list revision");
  await verifyPaginationRevision();
  console.log("novel-summary-cache: ok (deduplicated aggregates, progress, local/external writes, snapshots, reopen, database replacement, pagination revisions and actual write Worker)");
} finally {
  DatabaseSync.prototype.prepare = originalPrepare;
  store.invalidate();
  replacement.invalidate();
  external?.close();
  const resolved = fs.realpathSync(temporary);
  assert.equal(path.dirname(resolved), fs.realpathSync(os.tmpdir()));
  assert.ok(path.basename(resolved).startsWith("fanhao-novel-summary-"));
  for (const entry of fs.readdirSync(resolved, { withFileTypes: true })) {
    assert.ok(entry.isFile(), "the owned fixture should only contain SQLite files");
    fs.unlinkSync(path.join(resolved, entry.name));
  }
  fs.rmdirSync(resolved);
}

async function verifyPaginationRevision() {
  const paginationPath = path.join(temporary, "pagination.sqlite");
  const paginationStore = createNovelStore({ dbPath: paginationPath });
  const worker = createNovelWriteWorkerClient({ dbPath: paginationPath });
  let writer;
  try {
    const templateBook = paginationStore.uploadBook({ fileName: "synthetic.txt", text: "第一章 合成\n合成正文。" });
    writer = new DatabaseSync(paginationPath);
    const columns = writer.prepare("PRAGMA table_info(novel_books)").all().map(row => row.name);
    const template = writer.prepare("SELECT * FROM novel_books WHERE id=?").get(templateBook.book.id);
    const insertBook = writer.prepare(`INSERT INTO novel_books (${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")})`);
    const insertChapter = writer.prepare("INSERT INTO novel_chapters(id,book_id,chapter_index,title,content,char_count,updated_at) VALUES(?,?,?,?,?,?,?)");
    const insertProgress = writer.prepare("INSERT INTO novel_reading_state(book_id,chapter_id,chapter_index,scroll_ratio,updated_at,catalog_revision,status) VALUES(?,?,?,?,?,?,?)");
    const ids = Array.from({ length: 50 }, (_, index) => `synthetic-${String(index).padStart(2, "0")}`);
    writer.exec("BEGIN IMMEDIATE");
    for (const [index, id] of ids.entries()) {
      const chapterId = `chapter-${id}`;
      const row = { ...template, id, title: `合成${index}`, author: "合成作者", category: index % 2 ? "分类一" : "分类二",
        source_path: `upload://${id}`, updated_at: "2000-01-01T00:00:00.000Z", first_chapter_id: chapterId, latest_chapter_id: chapterId };
      insertBook.run(...columns.map(key => row[key]));
      insertChapter.run(chapterId, id, 1, "合成", "合成", 2, row.updated_at);
      insertProgress.run(id, chapterId, 1, 0, new Date(Date.UTC(2000, 0, 1, 0, 0, index)).toISOString(), row.catalog_revision, "resolved");
    }
    writer.prepare("DELETE FROM novel_chapters WHERE book_id=?").run(templateBook.book.id);
    writer.prepare("DELETE FROM novel_books WHERE id=?").run(templateBook.book.id);
    writer.exec("COMMIT");
    const pageUrl = new URL("http://fixture/api/novels?sort=progress&reading=1&limit=48");
    const page = (offset = 0, limit = 48) => {
      const url = new URL(pageUrl);
      url.searchParams.set("offset", String(offset));
      url.searchParams.set("limit", String(limit));
      return paginationStore.listBooks(url);
    };
    const first = page();
    assert.deepEqual(first.books.map(book => book.id), ids.slice(2).reverse());
    assert.equal(first.nextOffset, 48);
    assert.equal(page().listRevision, first.listRevision);
    writer.exec("BEGIN IMMEDIATE");
    try {
      const locked = page(48);
      assert.equal(locked.listRevision, first.listRevision, "an external writer lock must not force writes or prevent list reads");
      assert.equal(locked.nextOffset, 50);
    } finally { writer.exec("ROLLBACK"); }

    paginationStore.saveProgress(ids[1], { chapterIndex: 1, scrollRatio: 0.5 });
    const shifted = page(first.nextOffset);
    const oldAppend = [...first.books, ...shifted.books];
    assert.equal(oldAppend.length, 50);
    assert.equal(new Set(oldAppend.map(book => book.id)).size, 49, "the original offset append actually duplicates a book after progress reorders the list");
    assert.ok(!oldAppend.some(book => book.id === ids[1]));
    assert.notEqual(shifted.listRevision, first.listRevision, "the client must replace the prefix instead of deduplicating and silently missing the shifted book");
    const rebase = page(0, first.nextOffset + 48);
    assert.equal(rebase.nextOffset, 50);
    assert.equal(rebase.books.length, 50);
    assert.equal(new Set(rebase.books.map(book => book.id)).size, 50);
    assert.equal(rebase.books[0].id, ids[1]);
    assert.equal(rebase.listRevision, shifted.listRevision);
    assert.equal(page(100).nextOffset, 100, "an empty page reports its raw requested offset");

    const authorUrl = new URL("http://fixture/api/novels/authors/name?sort=progress&reading=1&limit=48");
    const authorPage = paginationStore.authorDetail("合成作者", authorUrl);
    assert.equal(authorPage.listRevision, rebase.listRevision);
    assert.equal(authorPage.nextOffset, 48);
    assert.deepEqual(authorPage.books.map(book => book.id), rebase.books.slice(0, 48).map(book => book.id));
    paginationStore.updateBookMetadata(ids[0], { title: "本地校正标题" });
    const localEdit = page();
    assert.notEqual(localEdit.listRevision, rebase.listRevision);
    assert.equal(paginationStore.authorDetail("合成作者", authorUrl).listRevision, localEdit.listRevision);

    // Use the real write Worker without an onCommitted invalidation callback:
    // the read store must detect independently committed progress itself.
    await worker.start();
    await worker.saveProgress(ids[0], { chapterIndex: 1, scrollRatio: 0.7 });
    await worker.stop();
    const workerEdit = page();
    assert.notEqual(workerEdit.listRevision, localEdit.listRevision);
    assert.equal(workerEdit.books[0].id, ids[0]);
    assert.equal(workerEdit.books[0].progress.scrollRatio, 0.7);
    assert.equal(page().listRevision, workerEdit.listRevision);

    writer.prepare("UPDATE novel_reading_state SET updated_at=? WHERE book_id=?").run("2999-01-01T00:00:00.000Z", ids[2]);
    const externalProgress = page();
    assert.notEqual(externalProgress.listRevision, workerEdit.listRevision);
    assert.equal(externalProgress.books[0].id, ids[2]);
    writer.prepare("UPDATE novel_books SET category=? WHERE id=?").run("外部分组", ids[2]);
    const externalEdit = page();
    assert.notEqual(externalEdit.listRevision, externalProgress.listRevision);
    assert.equal(externalEdit.books[0].category, "外部分组");
    writer.prepare("DELETE FROM novel_books WHERE id=?").run(ids[3]);
    const externalDelete = page();
    assert.notEqual(externalDelete.listRevision, externalEdit.listRevision);
    assert.equal(externalDelete.total, 49);
    const additionalId = "synthetic-added";
    const additional = { ...template, id: additionalId, source_path: `upload://${additionalId}`, title: "外部新增", author: "合成作者" };
    insertBook.run(...columns.map(key => additional[key]));
    const externalInsert = paginationStore.listBooks(new URL("http://fixture/api/novels?limit=48"));
    assert.notEqual(externalInsert.listRevision, externalDelete.listRevision);
    assert.equal(externalInsert.total, 50);

    beforeQuery = () => writer.prepare("UPDATE novel_books SET title=? WHERE id=?").run("快照提交后标题", ids[2]);
    const race = page();
    assert.notEqual(race.books[0].title, "快照提交后标题", "list rows keep their pinned snapshot while another connection commits");
    const afterRace = page();
    assert.notEqual(race.listRevision, afterRace.listRevision, "the race token cannot describe the newer file stamp");
    assert.equal(afterRace.books[0].title, "快照提交后标题");
    assert.equal(page().listRevision, afterRace.listRevision);
  } finally {
    beforeQuery = null;
    await worker.stop();
    paginationStore.invalidate();
    if (writer?.isTransaction) writer.exec("ROLLBACK");
    writer?.close();
  }
}
