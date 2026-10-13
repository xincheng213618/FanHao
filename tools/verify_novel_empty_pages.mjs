import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { createNovelStore } from "../src/modules/novels/server/store.js";

// Two store implementations read the same private SQLite file. Restore only
// the empty-page guards; all pre-existing cache/count/snapshot behavior stays.
const sourceUrl = new URL("../src/modules/novels/server/store.js", import.meta.url);
let source = fs.readFileSync(sourceUrl, "utf8");
for (const variable of ["countRow", "total"]) {
  const guard = '${where}${Number(' + variable + '?.count || 0) === 0 ? " AND 0" : ""}';
  assert.equal(source.split(guard).length, 2);
  source = source.replace(guard, "${where}");
}
source = source.replace(/from "(\.\/[^"]+)"/gu, (_, relative) => `from ${JSON.stringify(new URL(relative, sourceUrl).href)}`);
const { createNovelStore: previousFactory } = await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
assert.ok(process.argv.slice(2).every(value => value === "--legacy"));
const factory = process.argv.includes("--legacy") ? previousFactory : createNovelStore;
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "fanhao-novel-empty-pages-"));
const dbPath = path.join(temporary, "private.sqlite");
const current = factory({ dbPath }), previous = previousFactory({ dbPath });
const originalPrepare = DatabaseSync.prototype.prepare;
const originalUuid = crypto.randomUUID;
let writer = null, work = null, beforePage = null, fault = null;
let responseOracles = 0, errorOracles = 0;
const metrics = [];
DatabaseSync.prototype.prepare = function (sql, ...args) {
  const page = /SELECT b\.\*,[\s\S]*LIMIT \? OFFSET \?/u.test(sql)
    || /TRIM\(author\) AS name,[\s\S]*LIMIT \? OFFSET \?/u.test(sql);
  const count = /SELECT COUNT\(\*\) AS count FROM (?:novel_books b|novel_reading_state rs CROSS JOIN novel_books b)/u.test(sql)
    || /SELECT COUNT\(DISTINCT TRIM\(author\)\) AS count FROM novel_books /u.test(sql);
  if (page && beforePage) { const run = beforePage; beforePage = null; run(); }
  if (page && fault === "compile") sql = sql.replace("SELECT", "SELECT fixture_missing_column,");
  if (page && work) {
    work.prepared++;
    work.pageSql = sql;
    this.function("fixture_empty_page_visit", value => { if (work) work.visits++; return value; });
    sql = sql.replace(/((?:b\.)?status) = 'ok'/u, "$1 = 'ok' AND fixture_empty_page_visit($1) = 'ok'");
  }
  const statement = originalPrepare.call(this, sql, ...args);
  if (!page && !count) return statement;
  return new Proxy(statement, { get(target, key) {
    const value = Reflect.get(target, key, target);
    if (typeof value !== "function") return value;
    return (...parameters) => {
      if (count && key === "get" && work) work.counts++;
      if (page && key === "all") {
        if (work) { work.executed++; work.pageArgs = parameters; }
        if (fault === "execute") throw Object.assign(new Error("controlled page execution failure"), { code: "SQLITE_BUSY" });
      }
      return value.apply(target, parameters);
    };
  } });
};

try {
  current.bookMeta("missing"); // Initialize only this fixture's database.
  writer = new DatabaseSync(dbPath);
  seed(512);
  for (const method of ["listBooks", "listAuthors"]) {
    const sorts = method === "listBooks" ? ["updated", "title", "size", "chars", "chapters", "progress", "unknown"] : ["books", "name", "chapters", "size", "updated", "unknown"];
    for (const sort of sorts) for (const q of ["NoSuchNovel", "Literal", "%", "_", "\\", "'", "中文", ""]) {
      compare(method, { q, sort, limit: "7", offset: "2" });
    }
    for (const offset of ["0", "1000", "-1", "bad", String(Number.MAX_SAFE_INTEGER)]) {
      for (const q of ["NoSuchNovel", ""]) compare(method, { q, offset, limit: "1" });
    }
    for (const limit of ["0", "-1", "bad", "99999"]) compare(method, { q: "NoSuchNovel", limit });
    for (const search of ["Literal", "NoSuchNovel", "%"]) compare(method, { search });
  }
  for (const reading of ["1", "true", "yes", "0"]) for (const filter of [
    { q: "NoSuchNovel" }, { q: "Literal" }, { author: "NoSuchAuthor" },
    { category: "NoSuchCategory" }, { category: "分类1", author: "Author 1" }, {}
  ]) compare("listBooks", { ...filter, reading, sort: "progress", limit: "7", offset: "1" });
  const readingPage = compare("listBooks", { reading: "1", sort: "progress", limit: "7" });
  assert.ok(readingPage.total > 0 && readingPage.books.some(book => book.progress), "sparse reading controls include resolved progress");
  assert.ok(readingPage.books.some(book => book.progressRecovery), "sparse reading controls also retain recovery state");
  for (const q of ["NoSuchNovel", "Literal", ""]) compare("authorDetail", { q, limit: "2" });
  for (const method of ["listBooks", "listAuthors"]) {
    const match = compare(method, { q: "Literal", limit: "30" });
    assert.ok(match.total > 0 && (match.books || match.authors).length > 0, "nonempty controls really return rows");
    for (const kind of ["compile", "execute"]) {
      fault = kind;
      assert.deepEqual(errorFrom(() => call(current, method, { q: "NoSuchNovel" })), errorFrom(() => call(previous, method, { q: "NoSuchNovel" })));
      errorOracles++;
      fault = null; compare(method, { q: "NoSuchNovel" });
    }
  }
  writer.exec("ALTER TABLE novel_reading_state RENAME COLUMN chapter_id TO fixture_hidden_chapter_id");
  assert.deepEqual(errorFrom(() => call(current, "listBooks", { q: "NoSuchNovel" })), errorFrom(() => call(previous, "listBooks", { q: "NoSuchNovel" })));
  errorOracles++;
  writer.exec("ALTER TABLE novel_reading_state RENAME COLUMN fixture_hidden_chapter_id TO chapter_id");
  compare("listBooks", { q: "NoSuchNovel" });

  // A real WAL writer commits after COUNT but before the page SELECT. Both
  // responses must keep the already-established snapshot, then see the write
  // on the next request. Fix only the one-use revision nonce for the oracle.
  for (const method of ["listBooks", "listAuthors"]) {
    crypto.randomUUID = () => "11111111-1111-4111-8111-111111111111";
    const responses = [];
    for (const target of [current, previous]) {
      writer.prepare("DELETE FROM novel_books WHERE id='interleaved'").run();
      beforePage = () => insertBook("interleaved", "Interleaved Match", "Interleaved Match", 1);
      responses.push(call(target, method, { q: "Interleaved Match" }));
      assert.equal(beforePage, null, "the page is still compiled after its zero count");
      assert.equal(responses.at(-1).total, 0);
    }
    assert.deepEqual(responses[0], responses[1]); responseOracles++;
    crypto.randomUUID = originalUuid;
    const visible = compare(method, { q: "Interleaved Match" });
    assert.equal(visible.total, 1);
    writer.prepare("DELETE FROM novel_books WHERE id='interleaved'").run();
    assert.equal(compare(method, { q: "Interleaved Match" }).total, 0);
  }

  seed(50000);
  for (const [method, params] of [
    ["listBooks", { q: "NoSuchNovel", limit: "30" }],
    ["listBooks", { q: "NoSuchNovel", reading: "1", limit: "30" }],
    ["listAuthors", { q: "NoSuchNovel", limit: "30" }]
  ]) {
    const next = measure(current, method, params), old = measure(previous, method, params);
    assert.deepEqual(next.result, old.result); responseOracles++;
    assert.equal(next.result.total, 0);
    assert.equal(next.counts, 1); assert.equal(old.counts, 1);
    assert.equal(next.prepared, 1); assert.equal(next.executed, 1, "retain page SQL compilation/execution and their errors");
    assert.deepEqual(next.pageArgs, old.pageArgs);
    assert.equal(next.pageSql.replace(" AND 0", ""), old.pageSql, "only the impossible predicate may change");
    assert.ok(old.visits > 10000, "the former empty page must exercise catalogue-sized work");
    assert.equal(next.visits, 0, `${method}/${params.reading || "all"}: no repeated empty-page scan`);
    metrics.push({ method, reading: params.reading || "0", previousVisits: old.visits, currentVisits: next.visits });
  }
  console.log(JSON.stringify({ ok: true, responseOracles, errorOracles, books: 50000, metrics }, null, 2));
} finally {
  work = null; beforePage = null; fault = null;
  DatabaseSync.prototype.prepare = originalPrepare; crypto.randomUUID = originalUuid;
  current.invalidate(); previous.invalidate(); writer?.close();
  // Delete only known fixture-owned files, then the empty directory; never
  // recursively remove an inferred path or touch an application database.
  for (const suffix of ["", "-wal", "-shm"]) {
    const file = path.resolve(dbPath + suffix);
    assert.equal(path.dirname(file), path.resolve(temporary));
    try { fs.unlinkSync(file); } catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  fs.rmdirSync(temporary);
}

function insertBook(id, title, author, index) {
  writer.prepare("INSERT INTO novel_books(id,title,author,category,source_root,source_path,relative_path,file_name,size_bytes,char_count,chapter_count,summary,tags_json,status,updated_at,catalog_revision) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
    .run(id, title, author, `分类${index % 3}`, "synthetic", `synthetic/${id}`, id, `${id}.txt`, index % 31, index % 23, index % 13, "", "[]", index % 37 === 0 ? "missing" : "ok", `2026-${String(index % 12 + 1).padStart(2, "0")}-01`, "revision");
}
function seed(count) {
  writer.exec("BEGIN;DELETE FROM novel_reading_state;DELETE FROM novel_books");
  const progress = writer.prepare("INSERT INTO novel_reading_state(book_id,chapter_id,chapter_index,scroll_ratio,updated_at,catalog_revision,status,reason,anchor_json,candidate_json) VALUES(?,?,1,.5,'2026','revision',?,'fixture',?,?)");
  for (let index = 0; index < count; index++) {
    const title = index % 17 ? `Book ${String(index).padStart(6, "0")}` : "Literal % _ \\ ' 中文";
    const author = index % 17 ? (index % 29 ? `Author ${index % 9}` : "  ") : "Literal % _ \\ ' 中文";
    insertBook(`b${index}`, title, author, index);
    if (index % 97 === 0) progress.run(`b${index}`, `c${index}`, index % 2 ? "resolved" : "needs_review", '{"chapterIndex":1}', '{"chapterIndex":2}');
  }
  progress.run("orphan", "missing", "unresolved", null, null);
  writer.exec("COMMIT");
  current.summary(); previous.summary();
}
function call(target, method, params) {
  const url = new URL(`http://fixture.invalid/?${new URLSearchParams(params)}`);
  return method === "authorDetail" ? target.authorDetail("Author 1", url) : target[method](url);
}
function compare(method, params) {
  const next = call(current, method, params), old = call(previous, method, params);
  assert.deepEqual(next, old, `${method}/${JSON.stringify(params)}`); responseOracles++;
  return next;
}
function errorFrom(run) {
  try { run(); } catch (error) { return { name: error.name, message: error.message, code: error.code, errcode: error.errcode }; }
  assert.fail("the original page error must remain visible");
}
function measure(target, method, params) {
  work = { visits: 0, counts: 0, prepared: 0, executed: 0 };
  try { return { result: call(target, method, params), ...work }; }
  finally { work = null; }
}
