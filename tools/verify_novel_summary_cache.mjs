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
let readingWork = null;
let authorWork = null;
DatabaseSync.prototype.prepare = function (sql) {
  const aggregate = /COUNT\(DISTINCT NULLIF|GROUP BY COALESCE\(category|GROUP BY source_root/.test(sql);
  if (aggregate) aggregates += 1;
  const count = /SELECT COUNT\(\*\) AS count FROM (?:novel_books b|novel_reading_state rs CROSS JOIN novel_books b)/u.test(sql);
  const authorCount = /SELECT COUNT\(DISTINCT TRIM\(author\)\) AS count FROM novel_books /u.test(sql);
  if (beforeQuery && (count || authorCount)) {
    const callback = beforeQuery;
    beforeQuery = null;
    callback();
  }
  const page = /FROM novel_books b\s+LEFT JOIN novel_reading_state s/u.test(sql);
  if (readingWork && count) {
    this.function("fixture_reading_book_visit", value => { if (readingWork) readingWork.visits++; return value; });
    // Keep the indexed/original status predicate and observe actual SQLite
    // candidate visits with an additional identity callback.
    sql = sql.replace("b.status = 'ok'", "b.status = 'ok' AND fixture_reading_book_visit(b.status) = 'ok'");
  }
  const statement = originalPrepare.call(this, sql);
  if (!readingWork && !authorWork) return statement;
  return new Proxy(statement, { get(target, key) {
    const value = Reflect.get(target, key, target);
    if (typeof value !== "function") return value;
    return (...parameters) => {
      if (readingWork && ["get", "all"].includes(key)) {
        readingWork[key]++;
        if (count) readingWork.countQueries++;
        if (page) readingWork.pageQueries++;
      }
      if (authorWork && ["get", "all"].includes(key)) {
        authorWork[key]++;
        if (aggregate) authorWork.aggregates++;
      }
      return value.apply(target, parameters);
    };
  } });
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
  await verifyReadingCount();
  await verifyAuthorSummaryCache();
  await verifyCatalogEmptySearch();
  console.log("novel-summary-cache: ok (deduplicated aggregates, author pages/optional probes, empty catalog search, progress, local/external writes, snapshots, reopen, database replacement, pagination revisions and actual write Worker)");
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

    // The reading driver must retain the same snapshot when a new state row
    // commits after source identity has pinned this request's read transaction.
    const addedChapterId = "chapter-synthetic-added";
    insertChapter.run(addedChapterId, additionalId, 1, "外部新增", "合成", 2, "2000-01-01");
    writer.prepare("UPDATE novel_books SET first_chapter_id=?,latest_chapter_id=? WHERE id=?").run(addedChapterId, addedChapterId, additionalId);
    beforeQuery = () => insertProgress.run(additionalId, addedChapterId, 1, 0, "1999-01-01", additional.catalog_revision, "resolved");
    const readingSnapshot = page(0, 96);
    assert.equal(beforeQuery, null, "the concurrent count hook executes for the reading-state driver too");
    assert.equal(readingSnapshot.total, 49);
    assert.ok(!readingSnapshot.books.some(book => book.id === additionalId));
    const readingAfterCommit = page(0, 96);
    assert.equal(readingAfterCommit.total, 50);
    assert.ok(readingAfterCommit.books.some(book => book.id === additionalId));
    assert.notEqual(readingSnapshot.listRevision, readingAfterCommit.listRevision);

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

async function verifyCatalogEmptySearch({ memory = false } = {}) {
  const sourceUrl = new URL("../src/modules/novels/server/store.js", import.meta.url);
  const source = fs.readFileSync(sourceUrl, "utf8").replaceAll("\r\n", "\n");
  // Preserve the whole immediately preceding method rather than a second
  // hand-written query/serializer oracle. Every other store path stays current.
  const previousCatalog = [
    "  function catalog(bookId, url) {",
    "    return withReadDb((database) => {",
    "      const book = bookRecordFromDb(database, bookId);",
    "      if (book) checkBookPreconditions(book, {",
    "        sourceRealm: url.searchParams.has(\"sourceRealm\") ? url.searchParams.get(\"sourceRealm\") : undefined,",
    "        catalogRevision: url.searchParams.has(\"catalogRevision\") ? url.searchParams.get(\"catalogRevision\") : undefined",
    "      });",
    "      if (!book) return null;",
    "      const query = String(url?.searchParams?.get(\"q\") || \"\").replace(/\\s+/g, \" \").trim().slice(0, 80);",
    "      const order = String(url?.searchParams?.get(\"order\") || \"asc\").toLowerCase() === \"desc\" ? \"desc\" : \"asc\";",
    "      const all = [\"1\", \"true\", \"yes\"].includes(String(url?.searchParams?.get(\"all\") || \"\").toLowerCase());",
    "      const requestedLimit = clampInteger(url?.searchParams?.get(\"limit\"), 120, 20, 200);",
    "      const requestedOffset = clampInteger(url?.searchParams?.get(\"offset\"), 0, 0, Number.MAX_SAFE_INTEGER);",
    "      const anchor = clampInteger(url?.searchParams?.get(\"anchor\"), 0, 0, Number.MAX_SAFE_INTEGER);",
    "      const where = [\"book_id = ?\"];",
    "      const params = [bookId];",
    "      if (query) {",
    "        const pattern = `%${escapeLike(query)}%`;",
    "        where.push(\"(title LIKE ? ESCAPE '\\\\' COLLATE NOCASE OR CAST(chapter_index AS TEXT) LIKE ? ESCAPE '\\\\')\");",
    "        params.push(pattern, pattern);",
    "      }",
    "      const filteredTotal = Number(",
    "        database.prepare(`SELECT COUNT(*) AS count FROM novel_chapters WHERE ${where.join(\" AND \")}`).get(...params)?.count || 0",
    "      );",
    "      const limit = all ? Math.max(1, filteredTotal) : requestedLimit;",
    "      let offset = all ? 0 : requestedOffset;",
    "      if (!all && !query && anchor > 0 && filteredTotal > 0) {",
    "        const clampedAnchor = Math.max(1, Math.min(filteredTotal, anchor));",
    "        const position = order === \"desc\" ? filteredTotal - clampedAnchor : clampedAnchor - 1;",
    "        offset = Math.floor(position / limit) * limit;",
    "      }",
    "      const lastPageOffset = filteredTotal > 0 ? Math.floor((filteredTotal - 1) / limit) * limit : 0;",
    "      offset = Math.max(0, Math.min(lastPageOffset, offset));",
    "      const rows = database",
    "        .prepare(",
    "          `",
    "          SELECT id, book_id, chapter_index, title, '' AS content, char_count, updated_at",
    "          FROM novel_chapters",
    "          WHERE ${where.join(\" AND \")}",
    "          ORDER BY chapter_index ${order === \"desc\" ? \"DESC\" : \"ASC\"}",
    "          LIMIT ? OFFSET ?",
    "        `",
    "        )",
    "        .all(...params, limit, offset);",
    "      const chapters = rows.map((row) => publicChapter(row, false));",
    "      return {",
    "        sourceRealm: book.sourceRealm,",
    "        catalogRevision: book.catalogRevision,",
    "        bookId,",
    "        chapters,",
    "        total: Number(book.chapterCount || 0),",
    "        filteredTotal,",
    "        limit,",
    "        offset,",
    "        query,",
    "        order,",
    "        all,",
    "        firstIndex: chapters[0]?.index || 0,",
    "        lastIndex: chapters[chapters.length - 1]?.index || 0",
    "      };",
    "    });",
    "  }",
    "",
    ""
  ].join("\n");
  const start = source.indexOf("  function catalog(");
  const end = source.indexOf("  function saveProgress(", start);
  const currentCatalog = source.slice(start, end);
  const addition = '      if (filteredTotal === 0) where.push("0");\n';
  const limitLine = "      const limit = all ? Math.max(1, filteredTotal) : requestedLimit;";
  assert.equal(previousCatalog.replace(limitLine, addition + limitLine), currentCatalog,
    "the complete previous catalog method differs only by the zero-count predicate");
  const previousSource = source.replace(currentCatalog, previousCatalog);
  assert.equal(previousSource.replace(previousCatalog, currentCatalog), source);
  const factory = async text => {
    if (memory) text = text.replace("const candidate = new DatabaseSync(dbPath);", "const candidate = globalThis.__novelCatalogFixtureDb;");
    text = text.replace(/from "(\.\/[^"]+)"/gu, (_, relative) => "from " + JSON.stringify(new URL(relative, sourceUrl).href));
    return (await import("data:text/javascript;base64," + Buffer.from(text).toString("base64"))).createNovelStore;
  };
  const previousFactory = await factory(previousSource);
  const underTestFactory = process.argv.includes("--legacy-catalog-zero")
    ? previousFactory : memory ? await factory(source) : createNovelStore;
  const catalogPath = memory ? ":memory:" : path.join(temporary, "catalog.sqlite");
  const priorMemoryOwner = globalThis.__novelCatalogFixtureDb;
  const memoryDb = memory ? new DatabaseSync(":memory:") : null;
  if (memoryDb) globalThis.__novelCatalogFixtureDb = new Proxy(memoryDb, { get(target, key) {
    if (key === "close") return () => {};
    const value = Reflect.get(target, key, target);
    return typeof value === "function" ? value.bind(target) : value;
  } });
  const current = underTestFactory({ dbPath: catalogPath });
  const previous = previousFactory({ dbPath: catalogPath });
  const inheritedPrepare = DatabaseSync.prototype.prepare;
  let writer = null;
  let work = null;
  let heldFailure = null;
  let afterCount = null;
  let responseOracles = 0;
  let errorOracles = 0;
  let walCases = 0;
  const visitComparisons = [];
  DatabaseSync.prototype.prepare = function (sql, ...args) {
    const count = /SELECT COUNT\(\*\) AS count FROM novel_chapters/u.test(sql);
    const page = /SELECT id, book_id, chapter_index, title, '' AS content, char_count, updated_at\s+FROM novel_chapters/u.test(sql);
    if (work) {
      work.prepares++;
      if (page) work.pageSql = sql;
      if (count) work.countSql = sql;
    }
    if (page && heldFailure?.stage === "prepare") throw heldFailure.error;
    if (work?.instrument && (count || page)) {
      // Observe the actual native predicate while retaining its indexed book
      // filter. Apply this only to ordinary TEXT rows in the final visit proof.
      this.function("fixture_catalog_title_visit", (value, kind) => {
        if (work) work[kind + "Visits"]++;
        return value;
      });
      sql = sql.replace("title LIKE", "fixture_catalog_title_visit(title, '" + (count ? "count" : "page") + "') LIKE");
    }
    if (work && page) work.executedPageSql = sql;
    if (work && count) work.executedCountSql = sql;
    const statement = inheritedPrepare.call(this, sql, ...args);
    return new Proxy(statement, { get(target, key) {
      const value = Reflect.get(target, key, target);
      if (typeof value !== "function") return value;
      return (...parameters) => {
        if (work && ["get", "all"].includes(key)) {
          work.reads++;
          if (page) work.pageArgs = parameters;
          if (count) work.countArgs = parameters;
        }
        if (page && heldFailure?.stage === key) throw heldFailure.error;
        const result = value.apply(target, parameters);
        if (count && key === "get" && afterCount) {
          const callback = afterCount;
          afterCount = null;
          callback(result);
        }
        return result;
      };
    } });
  };
  const urlFor = (params = {}) => new URL("http://fixture/api/novels/catalog?" + new URLSearchParams(params));
  const read = (target, bookId, params = {}, instrument = false) => {
    work = { prepares: 0, reads: 0, countVisits: 0, pageVisits: 0, instrument, pageSql: null, pageArgs: null };
    try {
      const response = target.catalog(bookId, urlFor(params));
      return { response, json: JSON.stringify(response), work: { ...work } };
    } finally { work = null; }
  };
  const equivalent = (bookId, params = {}) => {
    const before = read(previous, bookId, params);
    const actual = read(current, bookId, params);
    assert.equal(actual.json, before.json, "complete catalog response " + String(bookId) + " " + urlFor(params).search);
    if (actual.response?.filteredTotal > 0) {
      assert.equal(actual.work.pageSql, before.work.pageSql, "a nonempty catalog keeps the preceding page SQL verbatim");
      assert.deepEqual(actual.work.pageArgs, before.work.pageArgs);
    }
    responseOracles++;
    return { before, actual };
  };
  const sameError = (bookId, params = {}) => {
    const errorShape = target => {
      try { read(target, bookId, params); }
      catch (error) { return { name: error.name, message: error.message, code: error.code, errcode: error.errcode, statusCode: error.statusCode }; }
      assert.fail("catalog must preserve the preceding error");
    };
    assert.deepEqual(errorShape(current), errorShape(previous));
    errorOracles++;
  };
  const sameNativeParameter = bookId => {
    const outcome = target => {
      try { return { json: read(target, bookId, { q: "notfound" }).json }; }
      catch (error) { return { error: { name: error.name, message: error.message, code: error.code, errcode: error.errcode } }; }
    };
    const actual = outcome(current);
    assert.deepEqual(actual, outcome(previous), "native parameter handling remains unchanged");
    if (actual.error) errorOracles++;
    else responseOracles++;
  };
  try {
    current.bookMeta("__fixture_init");
    writer = memoryDb || new DatabaseSync(catalogPath);
    writer.exec("PRAGMA temp_store=MEMORY");
    const insertBook = writer.prepare("INSERT INTO novel_books(id,title,author,category,source_root,source_path,relative_path,file_name,size_bytes,char_count,chapter_count,summary,tags_json,status,updated_at,catalog_revision)VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)");
    const addBook = (id, total, status = "ok") => insertBook.run(id, id || "empty identifier", "合成作者", "分类",
      "synthetic", "synthetic://" + id, "x", "x.txt", 40000, 40000, total, "合成简介", '["synthetic"]', status, "2026", "private-revision");
    addBook("private", 0);
    for (const [id, total, status] of [["empty", 0, "ok"], ["stale", 99, "ok"], ["inactive", 99, "error"], ["", 0, "ok"], ["0", 0, "ok"]]) addBook(id, total, status);
    const insertChapter = writer.prepare("INSERT INTO novel_chapters(id,book_id,chapter_index,title,content,char_count,updated_at)VALUES(?,?,?,?,?,?,?)");
    const paramsCases = [
      {}, { q: "notfound" }, { q: "章" }, { q: "%_\\" }, { q: "  no    result " }, { q: "9" },
      { q: "notfound", all: 1 }, { q: "notfound", all: "yes", order: "desc" },
      { q: "notfound", limit: "NaN", offset: "NaN" }, { q: "notfound", limit: "Infinity", offset: "Infinity" },
      { q: "notfound", limit: "1e309", offset: "1e309" },
      { q: "notfound", limit: "9223372036854775808", offset: "9223372036854775808" },
      { q: "notfound", limit: "-1", offset: "-1" }, { order: "desc", offset: "999999" }, { all: 1 }, { q: "notfound", anchor: "1" }
    ];
    for (const chapterCount of [20, 2000, 20000]) {
      writer.exec("BEGIN IMMEDIATE");
      writer.exec("DELETE FROM novel_chapters");
      writer.prepare("UPDATE novel_books SET chapter_count=? WHERE id='private'").run(chapterCount);
      for (let i = 1; i <= chapterCount; i++) insertChapter.run("c" + i, "private", i, i % 7 ? "章" + i : "%_\\", "文".repeat(200), 200, "2026");
      writer.exec("COMMIT");
      for (const id of ["private", "empty", "stale", "inactive", "missing", "", "0"]) {
        for (const params of paramsCases) equivalent(id, params);
        equivalent(id, { anchor: chapterCount - 1 });
      }
      for (const invalid of [undefined, null, {}, [], true, NaN, Infinity, 1n << 100n]) sameNativeParameter(invalid);
      for (const wrong of [{ sourceRealm: "wrong" }, { catalogRevision: "wrong" }]) sameError("empty", wrong);
      for (const reverse of [0, 1]) {
        writer.exec("PRAGMA reverse_unordered_selects=" + reverse + ";ANALYZE");
        equivalent("private", { q: "notfound" });
        equivalent("private", { q: "章", order: "desc", offset: 8 });
      }
      const raw = equivalent("private", { q: "notfound" });
      const before = read(previous, "private", { q: "notfound" }, true);
      const actual = read(current, "private", { q: "notfound" }, true);
      assert.equal(before.json, raw.before.json, "instrumentation must retain the preceding complete response");
      assert.equal(actual.json, raw.actual.json, "instrumentation must retain the current complete response");
      responseOracles += 2;
      writer.function("fixture_catalog_title_visit", (value, _kind) => value);
      const explain = (sql, args = actual.work.pageArgs) => writer.prepare("EXPLAIN QUERY PLAN " + sql).all(...args).map(row => row.detail);
      assert.deepEqual(explain(actual.work.pageSql), explain(before.work.pageSql), "the zero predicate retains the indexed chapter query plan");
      assert.ok(explain(actual.work.pageSql).some(detail => /SEARCH novel_chapters USING INDEX idx_novel_chapters_book/u.test(detail)));
      for (const measured of [before.work, actual.work]) {
        assert.deepEqual(explain(measured.executedPageSql, measured.pageArgs), explain(measured.pageSql, measured.pageArgs), "the native page probe retains its original indexed plan");
        assert.deepEqual(explain(measured.executedCountSql, measured.countArgs), explain(measured.countSql, measured.countArgs), "the native COUNT probe retains its original indexed plan");
      }
      visitComparisons.push({ chapterCount, before: before.work, actual: actual.work });
    }
    for (const stage of ["prepare", "all"]) {
      const error = Object.assign(new Error("fixture held catalog page " + stage), { code: "ERR_SQLITE_ERROR", errcode: 5 });
      heldFailure = { stage, error };
      for (const target of [current, previous]) {
        let thrown;
        try { read(target, "private", { q: "notfound" }); } catch (caught) { thrown = caught; }
        assert.equal(thrown, error, "zero count must still execute the original page prepare/all");
        errorOracles++;
      }
      heldFailure = null;
      equivalent("private", { q: "notfound" });
    }
    writer.exec("ALTER TABLE novel_chapters RENAME COLUMN updated_at TO fixture_renamed");
    sameError("private", { q: "notfound" });
    sameError("empty");
    writer.exec("ALTER TABLE novel_chapters RENAME COLUMN fixture_renamed TO updated_at");
    equivalent("private", { q: "notfound" });
    writer.prepare("INSERT INTO novel_reading_state(book_id,chapter_id,chapter_index,updated_at,catalog_revision,status,anchor_json)VALUES(?,?,?,?,?,?,?)")
      .run("private", "c2", 2, "2026", "private-revision", "needs_review", "{invalid");
    sameError("private", { q: "notfound" });
    writer.exec("DELETE FROM novel_reading_state");
    writer.exec("UPDATE novel_books SET tags_json='{invalid',chapter_count=NULL WHERE id='private'");
    equivalent("private", { q: "notfound" });
    equivalent("private", { q: "章" });
    writer.exec("UPDATE novel_books SET tags_json='[]',chapter_count=20000 WHERE id='private'");
    writer.prepare("UPDATE novel_chapters SET char_count=? WHERE chapter_index=2").run(9223372036854775807n);
    sameError("private", { q: "2" });
    equivalent("private", { q: "notfound" });
    writer.exec("UPDATE novel_chapters SET char_count=200 WHERE chapter_index=2");
    for (const value of [new Uint8Array([65, 66]), "invalid"]) {
      writer.prepare("UPDATE novel_chapters SET title=?,char_count=? WHERE chapter_index IN(1,2,3)").run(new Uint8Array([65, 66]), value);
      equivalent("private", { q: "notfound" });
    }
    writer.exec("UPDATE novel_chapters SET title='恢复标题',char_count=200 WHERE chapter_index IN(1,2,3)");
    const mutable = equivalent("private", { q: "恢复标题" }).actual.response;
    mutable.chapters[0].title = "caller mutation";
    equivalent("private", { q: "恢复标题" });

    if (!memory) {
      assert.equal(writer.prepare("PRAGMA journal_mode").get().journal_mode, "wal", "this branch must use an actual private file/WAL writer");
      writer.exec("BEGIN IMMEDIATE");
      insertChapter.run("held", "private", 20001, "held-writer-token", "合成", 2, "2026");
      const held = equivalent("private", { q: "held-writer-token" });
      assert.equal(held.actual.response.filteredTotal, 0, "a reader cannot see the independent writer's uncommitted chapter");
      writer.exec("ROLLBACK");
      assert.equal(equivalent("private", { q: "held-writer-token" }).actual.response.filteredTotal, 0);
      walCases += 2;
      const baseline = read(previous, "private", { q: "postcount-token" });
      afterCount = count => {
        assert.equal(count.count, 0);
        // This is a second native file connection committing after the reader's
        // COUNT step, while its already-pinned read transaction remains open.
        writer.exec("BEGIN IMMEDIATE");
        insertChapter.run("committed", "private", 20001, "postcount-token", "合成", 2, "2026");
        writer.exec("UPDATE novel_books SET chapter_count=20001 WHERE id='private'");
        writer.exec("COMMIT");
      };
      const pinned = read(current, "private", { q: "postcount-token" });
      assert.equal(afterCount, null, "the external commit hook must run after the actual COUNT step");
      assert.equal(pinned.json, baseline.json, "the complete response retains its pre-commit empty snapshot");
      responseOracles++;
      const refreshed = equivalent("private", { q: "postcount-token" });
      assert.equal(refreshed.actual.response.filteredTotal, 1);
      assert.equal(refreshed.actual.response.chapters[0].title, "postcount-token");
      assert.equal(refreshed.actual.response.total, 20001);
      walCases++;
    }
    console.log("novel-catalog-empty: " + responseOracles + " complete response oracles / " + errorOracles + " error oracles / " +
      walCases + " actual file/WAL cases; visits " + JSON.stringify(visitComparisons.map(({ chapterCount, before, actual }) => ({
        chapterCount, count: [before.countVisits, actual.countVisits], page: [before.pageVisits, actual.pageVisits],
        prepares: [before.prepares, actual.prepares], reads: [before.reads, actual.reads]
      }))));
    // Every response/error/snapshot assertion precedes these work budgets. The
    // whole-old-method control therefore goes RED for the intended scan only.
    for (const { chapterCount, before, actual } of visitComparisons) {
      assert.equal(before.countVisits, chapterCount, "the preceding native COUNT must examine all candidate titles");
      assert.equal(actual.countVisits, before.countVisits, "COUNT retains its original native work");
      assert.equal(before.pageVisits, chapterCount, "the preceding native page must exhibit the duplicate title scan");
      assert.equal(actual.prepares, before.prepares, "zero count must retain every native prepare");
      assert.equal(actual.reads, before.reads, "zero count must retain every native get/all call");
      assert.equal(actual.pageVisits, 0, "empty catalog page title visits budget");
    }
  } finally {
    work = null;
    heldFailure = null;
    afterCount = null;
    DatabaseSync.prototype.prepare = inheritedPrepare;
    current.invalidate();
    previous.invalidate();
    if (writer && writer !== memoryDb) { try { writer.exec("ROLLBACK"); } catch {} writer.close(); }
    memoryDb?.close();
    if (memoryDb) assert.equal(memoryDb.isOpen, false);
    if (priorMemoryOwner === undefined) delete globalThis.__novelCatalogFixtureDb;
    else globalThis.__novelCatalogFixtureDb = priorMemoryOwner;
  }
}

async function verifyAuthorSummaryCache({ memory = false } = {}) {
  const sourceUrl = new URL("../src/modules/novels/server/store.js", import.meta.url);
  const source = fs.readFileSync(sourceUrl, "utf8").replaceAll("\r\n", "\n");
  // Restore the complete preceding authors method. Other cache users, SQL,
  // initialization and serializers remain the actual current store.
  const previousAuthors = [
    "  function listAuthors(url) {",
    "    return withReadDb((database) => {",
    "      const sourceRealm = sourceRealmFromDb(database);",
    "      const query = String(url.searchParams.get(\"q\") || url.searchParams.get(\"search\") || \"\").trim();",
    "      const sort = normalizeAuthorSort(url.searchParams.get(\"sort\"));",
    "      const limit = clampInteger(url.searchParams.get(\"limit\"), 5000, 1, 5000);",
    "      const offset = clampInteger(url.searchParams.get(\"offset\"), 0, 0, Number.MAX_SAFE_INTEGER);",
    "      const conditions = [\"status = 'ok'\", \"TRIM(COALESCE(author, '')) <> ''\"];",
    "      const params = [];",
    "      if (query) {",
    "        conditions.push(\"author LIKE ? ESCAPE '\\\\'\");",
    "        params.push(`%${escapeLike(query)}%`);",
    "      }",
    "      const where = `WHERE ${conditions.join(\" AND \")}`;",
    "      const order = authorOrderSql(sort);",
    "      const total = database.prepare(`SELECT COUNT(DISTINCT TRIM(author)) AS count FROM novel_books ${where}`).get(...params);",
    "      const authors = database",
    "        .prepare(",
    "          `",
    "          SELECT",
    "            TRIM(author) AS name,",
    "            COUNT(*) AS book_count,",
    "            COALESCE(SUM(chapter_count), 0) AS chapter_count,",
    "            COALESCE(SUM(char_count), 0) AS char_count,",
    "            COALESCE(SUM(size_bytes), 0) AS size_bytes,",
    "            COALESCE(MAX(updated_at), '') AS updated_at",
    "          FROM novel_books",
    "          ${where}",
    "          GROUP BY TRIM(author)",
    "          ${order}",
    "          LIMIT ? OFFSET ?",
    "        `",
    "        )",
    "        .all(...params, limit, offset)",
    "        .map((row) => ({",
    "          name: row.name || \"\",",
    "          bookCount: Number(row.book_count || 0),",
    "          chapterCount: Number(row.chapter_count || 0),",
    "          charCount: Number(row.char_count || 0),",
    "          sizeBytes: Number(row.size_bytes || 0),",
    "          updatedAt: row.updated_at || \"\"",
    "        }));",
    "      return {",
    "        sourceRealm,",
    "        authors,",
    "        total: Number(total?.count || 0),",
    "        query,",
    "        sort,",
    "        limit,",
    "        offset,",
    "        summary: summaryFromDb(database)",
    "      };",
    "    });",
    "  }",
    "",
    ""
  ].join("\n");
  const start = source.indexOf("  function listAuthors(");
  const end = source.indexOf("  function authorDetail(", start);
  const currentAuthors = source.slice(start, end);
  assert.equal(previousAuthors.replace("    });\n  }\n", '    }, { cacheSummary: "optional" });\n  }\n'), currentAuthors.replace('${where}${Number(total?.count || 0) === 0 ? " AND 0" : ""}', '${where}'),
    "the whole previous method differs only by its optional cache opt-in");
  const previousSource = source.replace(currentAuthors, previousAuthors);
  assert.equal(previousSource.replace(previousAuthors, currentAuthors), source);
  const factory = async text => {
    if (memory) text = text.replace("const candidate = new DatabaseSync(dbPath);", "const candidate = globalThis.__novelAuthorFixtureDb;");
    text = text.replace(/from "(\.\/[^"]+)"/gu, (_, relative) => `from ${JSON.stringify(new URL(relative, sourceUrl).href)}`);
    return (await import(`data:text/javascript;base64,${Buffer.from(text).toString("base64")}`)).createNovelStore;
  };
  const previousFactory = await factory(previousSource);
  const underTestFactory = process.argv.includes("--legacy-author-summary")
    ? previousFactory : memory ? await factory(source) : createNovelStore;
  const authorPath = memory ? ":memory:" : path.join(temporary, "authors.sqlite");
  const replacementAuthorPath = path.join(temporary, "authors-replacement.sqlite");
  const originalStat = fs.statSync;
  const originalMemoryOwner = globalThis.__novelAuthorFixtureDb;
  const memoryDb = memory ? new DatabaseSync(":memory:") : null;
  if (memoryDb) globalThis.__novelAuthorFixtureDb = new Proxy(memoryDb, { get(target, key) {
    if (key === "close") return () => {};
    const value = Reflect.get(target, key, target);
    return typeof value === "function" ? value.bind(target) : value;
  } });
  const current = underTestFactory({ dbPath: authorPath });
  const previous = previousFactory({ dbPath: authorPath });
  let writer = null;
  let replacementStore = null;
  let replacementWriter = null;
  let storageEpoch = 1n;
  let probeCalls = 0;
  let probeErrorAt = 0;
  let noProof = false;
  let zeroWal = false;
  const heldStatError = Object.assign(new Error("fixture storage probe denied"), { code: "EACCES" });
  fs.statSync = function (file, ...args) {
    const selected = String(file) === authorPath || String(file) === `${authorPath}-wal`;
    if (!selected) return originalStat.call(this, file, ...args);
    const wal = String(file).endsWith("-wal");
    if (!wal && ++probeCalls === probeErrorAt) throw heldStatError;
    if (noProof) throw Object.assign(new Error("fixture storage proof unavailable"), { code: "ENOENT" });
    if (memory) return { dev: 1n, ino: wal ? 2n : 1n, birthtimeNs: 1n, mtimeNs: storageEpoch,
      ctimeNs: storageEpoch, size: wal ? zeroWal ? 0n : 64n : 4096n };
    const stat = originalStat.call(this, file, ...args);
    return wal && zeroWal ? { ...stat, size: 0n } : stat;
  };
  const observed = (target, method, ...args) => {
    authorWork = { get: 0, all: 0, aggregates: 0 };
    try { return { response: target[method](...args), work: { ...authorWork } }; }
    finally { authorWork = null; }
  };
  const urlFor = (params = {}) => new URL(`http://fixture/api/novels/authors?${new URLSearchParams(params)}`);
  let responseOracles = 0;
  let errorOracles = 0;
  const equivalent = (params = {}) => {
    const actual = observed(current, "listAuthors", urlFor(params));
    assert.equal(JSON.stringify(actual.response), JSON.stringify(previous.listAuthors(urlFor(params))), `complete authors response ${urlFor(params).search}`);
    responseOracles++;
    return actual;
  };
  const sameError = (method, ...args) => {
    const errorShape = target => {
      try { target[method](...args); }
      catch (error) { return { name: error.name, message: error.message, code: error.code, errcode: error.errcode }; }
      assert.fail(`${method} must preserve the preceding error`);
    };
    assert.deepEqual(errorShape(current), errorShape(previous));
    errorOracles++;
  };
  const mutate = (sql, ...args) => {
    writer.prepare(sql).run(...args);
    storageEpoch++;
  };
  const warmWork = [];
  const failedProbeWork = [];
  const proofWork = [];
  let coldWork;
  let mixedWork;
  try {
    current.bookMeta("__fixture_init");
    writer = memoryDb || new DatabaseSync(authorPath);
    writer.exec("PRAGMA temp_store=MEMORY");
    const insert = writer.prepare(`INSERT INTO novel_books
      (id,title,author,category,source_root,source_path,relative_path,file_name,size_bytes,char_count,chapter_count,tags_json,status,updated_at,catalog_revision)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    const aliases = ["Alice", "alice", " ALICE ", "中文作者", "中 2", "Émile", "emile", "É 2", "12", "１２", "%_\\", "", null, new Uint8Array([65, 66])];
    writer.exec("BEGIN IMMEDIATE");
    for (let index = 0; index < 20000; index++) insert.run(`author-book-${index}`, `Book ${index}`,
      index < aliases.length ? aliases[index] : index % 17 ? `Author ${index % 200}` : null,
      index % 7 ? `cat${index % 4}` : null, `synthetic${index % 3}`, `synthetic://${index}`, "x", "x.txt",
      index, index * 2, index % 10, '["tag"]', index % 29 ? "ok" : "inactive", "2026", "catalog-v1");
    writer.exec("COMMIT");
    coldWork = equivalent({ limit: 24 }).work;
    for (let page = 0; page < 12; page++) warmWork.push(equivalent({ limit: 24, offset: page * 24 }).work);
    for (const sort of ["name", "books", "chapters", "size", "updated", "unknown", ""]) {
      for (const q of ["", "ALICE", "中", "É", "12", "%_\\", "notfound"]) {
        for (const offset of [0, 2, 250]) equivalent({ limit: 2, offset, sort, q });
      }
    }
    for (const reverse of [0, 1]) {
      writer.exec(`PRAGMA reverse_unordered_selects=${reverse}; ANALYZE`);
      storageEpoch++;
      for (const sort of ["name", "books", "chapters", "size", "updated"]) equivalent({ limit: 8, sort });
    }
    writer.exec("PRAGMA reverse_unordered_selects=0");
    current.summary();
    equivalent();
    const mixed = observed(current, "summary");
    assert.equal(JSON.stringify(mixed.response), JSON.stringify(previous.summary()));
    responseOracles++;
    mixedWork = mixed.work;
    mutate("INSERT INTO novel_chapters(id,book_id,chapter_index,title,content,char_count,updated_at) VALUES(?,?,?,?,?,?,?)",
      "author-chapter", "author-book-1", 1, "合成", "合成", 2, "2026");
    mutate(`INSERT INTO novel_reading_state(book_id,chapter_id,chapter_index,scroll_ratio,updated_at,catalog_revision,status)
      VALUES(?,?,?,?,?,?,?)`, "author-book-1", "author-chapter", 1, 0.2, "2026-01-01", "catalog-v1", "resolved");
    assert.equal(equivalent().response.summary.recent[0].progress.scrollRatio, 0.2);
    mutate("UPDATE novel_reading_state SET scroll_ratio=?,updated_at=? WHERE book_id=?", 0.7, "2026-02-01", "author-book-1");
    assert.equal(equivalent().response.summary.recent[0].progress.scrollRatio, 0.7);
    current.saveProgress("author-book-1", { chapterIndex: 1, scrollRatio: 0.8 });
    storageEpoch++;
    assert.equal(equivalent().response.summary.recent[0].progress.scrollRatio, 0.8);
    const changed = equivalent().response;
    changed.summary.totals.books = -1;
    changed.summary.categories[0].name = "caller mutation";
    changed.summary.roots[0].path = "caller mutation";
    changed.summary.recent[0].title = "caller mutation";
    equivalent();
    current.updateBookMetadata("author-book-2", { author: "Alice", category: "本地修改" });
    storageEpoch++;
    equivalent();
    mutate("UPDATE novel_books SET author=?,category=?,chapter_count=? WHERE id=?", "外部作者", "外部修改", 44, "author-book-3");
    equivalent();
    mutate("INSERT OR REPLACE INTO novel_meta(key,value)VALUES('scanned_at','authors-next-scan')");
    assert.equal(equivalent().response.summary.scannedAt, "authors-next-scan");
    mutate("UPDATE novel_meta SET value=? WHERE key='library_id'", "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
    assert.equal(equivalent().response.sourceRealm, "server:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
    writer.exec("ALTER TABLE novel_books ADD COLUMN fixture_legacy_value BLOB");
    storageEpoch++;
    equivalent();
    current.invalidate(); previous.invalidate();
    equivalent(); equivalent();
    if (!memory) {
      writer.exec("BEGIN IMMEDIATE");
      try {
        writer.prepare("UPDATE novel_books SET author=? WHERE id=?").run("未提交作者", "author-book-4");
        equivalent();
      } finally { writer.exec("ROLLBACK"); }
      // Both author rows and summary retain their first source read while a
      // real external WAL writer commits inside the author-count prepare hook.
      const pinned = previous.listAuthors(urlFor({ limit: 5000 }));
      beforeQuery = () => writer.prepare("UPDATE novel_books SET author=?,category=? WHERE id=?")
        .run("快照后作者", "快照后分类", "author-book-5");
      const snapshot = current.listAuthors(urlFor({ limit: 5000 }));
      assert.equal(beforeQuery, null, "the authors count participates in the concurrent hook");
      assert.equal(JSON.stringify(snapshot), JSON.stringify(pinned));
      responseOracles++;
      const committed = equivalent({ limit: 5000 });
      assert.ok(committed.response.authors.some(row => row.name === "快照后作者"));
      assert.ok(committed.response.summary.categories.some(row => row.name === "快照后分类"));
      equivalent();
    }
    for (const stage of [1, 2, 3]) {
      current.invalidate();
      probeCalls = 0; probeErrorAt = stage;
      const failed = equivalent({ limit: 48 });
      failedProbeWork.push({ stage, probes: probeCalls, work: failed.work });
      probeErrorAt = 0;
      proofWork.push(equivalent().work, equivalent().work);
    }
    noProof = true;
    proofWork.push(equivalent().work, equivalent().work);
    noProof = false;
    proofWork.push(equivalent().work, equivalent().work);
    zeroWal = true;
    equivalent(); equivalent();
    zeroWal = false;
    equivalent(); equivalent();
    // Optional probe failure must not persist into the strict readers.
    current.invalidate();
    probeCalls = 0; probeErrorAt = 1;
    equivalent();
    probeErrorAt = 0;
    for (const target of [current, previous]) for (const [method, args] of [
      ["summary", []], ["listBooks", [new URL("http://fixture/api/novels?limit=1")]],
      ["authorDetail", ["Alice", new URL("http://fixture/api/novels?limit=1")]]
    ]) {
      probeCalls = 0; probeErrorAt = 1;
      assert.throws(() => target[method](...args), error => error === heldStatError);
      errorOracles++;
    }
    probeErrorAt = 0;
    equivalent(); equivalent();
    mutate("UPDATE novel_reading_state SET status=?,reason=?,anchor_json=?,candidate_json=? WHERE book_id=?",
      "needs_review", "changed", '{"chapterIndex":9}', '{"chapterIndex":2}', "author-book-1");
    const recovery = equivalent().response.summary.recent[0].progressRecovery;
    assert.equal(recovery.previous.chapterIndex, 9);
    assert.equal(recovery.candidate.chapterIndex, 2);
    mutate("UPDATE novel_reading_state SET anchor_json=? WHERE book_id=?", "{invalid", "author-book-1");
    sameError("listAuthors", urlFor());
    mutate("UPDATE novel_reading_state SET anchor_json=? WHERE book_id=?", '{"chapterIndex":4}', "author-book-1");
    equivalent();
    const stateSchema = writer.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='novel_reading_state'").get().sql;
    writer.exec("DROP TABLE novel_reading_state");
    storageEpoch++;
    sameError("listAuthors", urlFor());
    writer.exec(stateSchema);
    storageEpoch++;
    equivalent();
    mutate("UPDATE novel_meta SET value='6' WHERE key='schema_version'");
    sameError("listAuthors", urlFor());
    mutate("UPDATE novel_meta SET value='5' WHERE key='schema_version'");
    equivalent();
    mutate("UPDATE novel_meta SET value='invalid' WHERE key='library_id'");
    sameError("listAuthors", urlFor());
    mutate("UPDATE novel_meta SET value=? WHERE key='library_id'", "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
    equivalent();
    if (!memory) {
      current.invalidate(); previous.invalidate();
      writer.close(); writer = null;
      replacementStore = createNovelStore({ dbPath: replacementAuthorPath });
      replacementStore.bookMeta("__fixture_init");
      replacementWriter = new DatabaseSync(replacementAuthorPath);
      replacementWriter.prepare(`INSERT INTO novel_books(id,title,author,source_root,source_path,relative_path,file_name,status,updated_at)
        VALUES('replacement','替换','替换作者','synthetic','synthetic://replacement','x','x.txt','ok','2026')`).run();
      const replacementRealm = replacementStore.summary().sourceRealm;
      replacementStore.invalidate();
      replacementWriter.close(); replacementWriter = null;
      fs.renameSync(authorPath, path.join(temporary, "authors-retired.sqlite"));
      fs.renameSync(replacementAuthorPath, authorPath);
      const replaced = equivalent();
      assert.equal(replaced.response.sourceRealm, replacementRealm);
      assert.equal(replaced.response.summary.totals.books, 1);
      assert.equal(replaced.response.authors[0].name, "替换作者");
      equivalent();
    }
    // The whole-method negative passes every response/error/snapshot oracle
    // before the actual-query budget below detects the lost summary reuse.
    console.log(JSON.stringify({ novelAuthorSummary: { books: 20000, memory, responseOracles, errorOracles,
      coldWork, warmWork, mixedWork, failedProbeWork, proofWork } }));
    assert.equal(coldWork.aggregates, 3, "a cold authors page still reads all three static aggregates");
    for (const work of warmWork) {
      assert.equal(work.aggregates, 0, "unchanged authors pages must reuse the existing static summary");
      assert.ok(work.get + work.all <= 15, "warm author-page SQLite reads remain fixed");
    }
    assert.equal(mixedWork.aggregates, 0, "authors pages preserve a shared warmed summary for other readers");
    for (const failed of failedProbeWork) {
      assert.ok(failed.probes >= failed.stage, "the requested optional filesystem probe actually failed");
      assert.equal(failed.work.aggregates, 3, "failed proof declines reuse and admission");
    }
    assert.deepEqual(proofWork.map(work => work.aggregates), [3, 0, 3, 0, 3, 0, 3, 3, 3, 0],
      "failure and missing proof rebuild; only a later complete stable proof may be admitted");
  } finally {
    beforeQuery = null;
    authorWork = null;
    probeErrorAt = 0;
    noProof = false;
    fs.statSync = originalStat;
    current.invalidate(); previous.invalidate(); replacementStore?.invalidate();
    if (writer?.isTransaction) writer.exec("ROLLBACK");
    if (writer?.isOpen) writer.close();
    if (replacementWriter?.isOpen) replacementWriter.close();
    if (memoryDb?.isOpen) memoryDb.close();
    if (originalMemoryOwner === undefined) delete globalThis.__novelAuthorFixtureDb;
    else globalThis.__novelAuthorFixtureDb = originalMemoryOwner;
  }
}

async function verifyReadingCount() {
  const sourceUrl = new URL("../src/modules/novels/server/store.js", import.meta.url);
  const source = fs.readFileSync(sourceUrl, "utf8").replaceAll("\r\n", "\n");
  const countBlock = `      const countFrom = readingOnly
        ? "novel_reading_state rs CROSS JOIN novel_books b ON b.id = rs.book_id"
        : "novel_books b";
      const countRow = database.prepare(\`SELECT COUNT(*) AS count FROM \${countFrom} \${where}\`).get(...params);`;
  assert.equal(source.split(countBlock).length, 2);
  // The former count driver is the only restored code. The actual factory,
  // schema, predicates, rows/order, transaction and revision remain real.
  const previousSource = source.replace(countBlock,
    "      const countRow = database.prepare(`SELECT COUNT(*) AS count FROM novel_books b ${where}`).get(...params);")
    .replace(/from "(\.\/[^"]+)"/gu, (_, relative) => `from ${JSON.stringify(new URL(relative, sourceUrl).href)}`);
  const { createNovelStore: previousFactory } = await import(`data:text/javascript;base64,${Buffer.from(previousSource).toString("base64")}`);
  const factory = process.argv.includes("--legacy-reading-count") ? previousFactory : createNovelStore;
  const readingPath = path.join(temporary, "reading.sqlite");
  const current = factory({ dbPath: readingPath }), previous = previousFactory({ dbPath: readingPath });
  let writer;
  function measure(target, url) {
    readingWork = { visits: 0, get: 0, all: 0, countQueries: 0, pageQueries: 0 };
    try { const result = target.listBooks(url); return { result, ...readingWork }; }
    finally { readingWork = null; }
  }
  try {
    const uploaded = current.uploadBook({ fileName: "synthetic.txt", title: "合成书", text: "第一章 合成\n合成正文。" });
    writer = new DatabaseSync(readingPath);
    const columns = writer.prepare("PRAGMA table_info(novel_books)").all().map(row => row.name);
    const template = writer.prepare("SELECT * FROM novel_books WHERE id=?").get(uploaded.book.id);
    const insertBook = writer.prepare(`INSERT INTO novel_books (${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")})`);
    const insertChapter = writer.prepare("INSERT INTO novel_chapters(id,book_id,chapter_index,title,content,char_count,updated_at) VALUES(?,?,1,'合成','合成',2,'2026')");
    const insertProgress = writer.prepare("INSERT INTO novel_reading_state(book_id,chapter_id,chapter_index,scroll_ratio,updated_at,catalog_revision,status,reason) VALUES(?,?,1,0.5,?,?,?,?)");
    writer.exec("BEGIN IMMEDIATE");
    for (let i = 0; i < 18000; i++) {
      const row = { ...template, id: `reading-${i}`, title: i < 10 ? "并列书名" : `书${String(i).padStart(5, "0")}`,
        author: `作者${i % 4}`, category: `分类${i % 3}`, source_path: `synthetic://${i}`,
        first_chapter_id: `reading-chapter-${i}`, latest_chapter_id: `reading-chapter-${i}`,
        status: i % 37 === 0 ? "missing" : "ok", updated_at: `2026-${String(i % 12 + 1).padStart(2, "0")}-01` };
      insertBook.run(...columns.map(key => row[key]));
      insertChapter.run(row.first_chapter_id, row.id);
    }
    for (let i = 0; i < 120; i++) insertProgress.run(`reading-${i * 131}`, `reading-chapter-${i * 131}`,
      `2026-${String(i % 12 + 1).padStart(2, "0")}-02`, i % 7 === 0 ? "stale-revision" : template.catalog_revision,
      ["needs_review", "unresolved", "resolved"][i % 3], "test");
    insertProgress.run("reading-orphan", "reading-orphan-chapter", "2026", template.catalog_revision, "resolved", "");
    writer.prepare("DELETE FROM novel_chapters WHERE book_id=?").run(uploaded.book.id);
    writer.prepare("DELETE FROM novel_books WHERE id=?").run(uploaded.book.id);
    writer.exec("COMMIT");

    let responseOracles = 0;
    for (const reading of ["1", "0"]) for (const sort of ["title", "updated", "chars", "progress"])
      for (const limit of [1, 48, 200]) for (const offset of [0, 30, 130, 19000])
        for (const filter of ["", "&category=分类1&author=作者1", "&q=书001"]) {
          const url = new URL(`http://fixture/api/novels?reading=${reading}&sort=${sort}&limit=${limit}&offset=${offset}${filter}`);
          assert.equal(JSON.stringify(current.listBooks(url)), JSON.stringify(previous.listBooks(url)), `complete old response ${url.search}`);
          responseOracles++;
        }
    const visits = [];
    for (const limit of [1, 48, 5000]) {
      const url = new URL(`http://fixture/api/novels?reading=1&sort=progress&limit=${limit}&offset=30`);
      const actual = measure(current, url), old = measure(previous, url);
      assert.equal(JSON.stringify(actual.result), JSON.stringify(old.result));
      assert.equal(old.visits, 17513, "the restored driver really visits the full active book population");
      assert.ok(actual.visits <= 121, "reading count visits at most the 121 state candidates instead of 18,000 books");
      assert.equal(actual.countQueries, 1); assert.equal(actual.pageQueries, 1);
      assert.ok(actual.get + actual.all <= 16, "metadata/revision/summary reads stay fixed rather than adding a query per returned book");
      assert.equal(actual.result.total, 116, "all retained state statuses count, excluding missing books and an orphan");
      visits.push({ limit, previous: old.visits, current: actual.visits, sqlReads: actual.get + actual.all });
    }
    const completeUrl = new URL("http://fixture/api/novels?reading=1&sort=progress&limit=5000");
    for (const sql of [
      "UPDATE novel_reading_state SET scroll_ratio=0.75,updated_at='2999-01-01' WHERE book_id='reading-131'",
      "UPDATE novel_books SET status='error' WHERE id='reading-131'",
      "UPDATE novel_books SET status='ok' WHERE id='reading-131'",
      "DELETE FROM novel_reading_state WHERE book_id='reading-131'"
    ]) {
      writer.exec(sql);
      const page = current.listBooks(completeUrl);
      assert.equal(JSON.stringify(page), JSON.stringify(previous.listBooks(completeUrl)), "fresh progress/catalog/removal keeps the complete old response");
      assert.equal(page.total, page.books.length);
      assert.equal(page.nextOffset, page.books.length);
      responseOracles++;
    }
    insertProgress.run("reading-131", "reading-chapter-131", "3000-01-01", template.catalog_revision, "resolved", "");
    const restored = current.listBooks(completeUrl);
    assert.equal(JSON.stringify(restored), JSON.stringify(previous.listBooks(completeUrl)));
    assert.equal(restored.books[0].id, "reading-131");
    assert.equal(restored.total, 116);
    responseOracles++;
    console.log(JSON.stringify({ novelReadingCount: { books: 18000, stateRows: 121, responseOracles, visits } }));
  } finally {
    readingWork = null;
    current.invalidate(); previous.invalidate();
    if (writer?.isTransaction) writer.exec("ROLLBACK");
    writer?.close();
  }
}
