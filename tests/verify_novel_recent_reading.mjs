import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { performance } from "node:perf_hooks";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

import { createNovelStore } from "../src/modules/novels/server/store.js";
import { createVerifiedTempDir } from "./verified-temp-cleanup.mjs";

const args = process.argv.slice(2);
assert(args.every(value => value === "--legacy-recent"), "known arguments");
const ownerUrl = new URL("../src/modules/novels/server/store.js", import.meta.url);
const baselineCommit = "63c5fab243233e142cfd62c4eaf13812feb92405";
const baselineSource = execFileSync("git", ["show", `${baselineCommit}:src/modules/novels/server/store.js`], {
  cwd: fileURLToPath(new URL("../", import.meta.url)), encoding: "utf8"
}).replace(/\r\n/g, "\n");
assert.equal(crypto.createHash("sha256").update(baselineSource).digest("hex"),
  "f9ffae913d0efc7aa245ed5b3d8108af9c043b542c77e30fe704f4af6219a6fa", "complete fixed factory oracle");
// v6 adds only an optional index. Let the frozen query owner read that schema
// without changing its SQL, ordering, cache or error handling.
let readableBaseline = baselineSource;
for (const [before, after] of [['=== 5) return;', '=== 6) return;'], ['if (version > 5) throw', 'if (version > 6) throw']]) {
  assert.equal(readableBaseline.split(before).length, 2, "one read-version adapter slot");
  readableBaseline = readableBaseline.replace(before, after);
}
const previousFactory = await factoryFromSource(readableBaseline);
const currentSource = fs.readFileSync(ownerUrl, "utf8").replace(/\r\n/g, "\n");
const joinChoice = 'const recentJoin = canDriveRecentReadingFromState(database) ? "CROSS JOIN" : "JOIN";';
assert.equal(currentSource.split(joinChoice).length, 2, "one narrow recent join control");
const testedFactory = args.includes("--legacy-recent")
  ? await factoryFromSource(currentSource.replace(joinChoice, 'const recentJoin = "JOIN";'))
  : createNovelStore;
const directory = createVerifiedTempDir("fanhao-novel-recent-reading-");
const dbPath = path.join(directory.tempDir, "fixture.sqlite");
const current = testedFactory({ dbPath }), previous = previousFactory({ dbPath });
const originalPrepare = DatabaseSync.prototype.prepare, originalExec = DatabaseSync.prototype.exec;
const originalUuid = crypto.randomUUID;
let writer, work = null, fault = null, probeResult = null, beforeRecent = null, readAudit = null, readerSetup = null;
let responseOracles = 0, errorOracles = 0;
let definitions;
const metrics = [];

const isRecent = sql => /FROM novel_reading_state s\s+(?:CROSS )?JOIN novel_books b ON b\.id = s\.book_id/u.test(sql)
  && /ORDER BY s\.updated_at DESC\s+LIMIT 6/u.test(sql);
const isProbe = sql => /^PRAGMA table_info\(novel_(?:books|reading_state)\)$/u.test(sql)
  || /COUNT\(DISTINCT updated_at\) AS timestamps|AS books_sql/u.test(sql);
const isWrite = sql => /^(?:\s*)(?:CREATE|ALTER|DROP|INSERT|UPDATE|DELETE|REPLACE|BEGIN IMMEDIATE|PRAGMA journal_mode)/iu.test(sql);
DatabaseSync.prototype.exec = function(sql, ...rest) {
  if (readAudit && this !== writer && isWrite(sql)) readAudit.push(sql);
  return originalExec.call(this, sql, ...rest);
};
DatabaseSync.prototype.prepare = function(sql, ...rest) {
  if (readerSetup && this !== writer) { const setup = readerSetup; readerSetup = null; setup(this); }
  const recent = isRecent(sql), probe = isProbe(sql);
  const authorProbe = sql.includes("name = 'idx_novel_books_author_updated' COLLATE NOCASE");
  if (recent && beforeRecent) { const action = beforeRecent; beforeRecent = null; action(); }
  if (fault?.phase === "prepare" && fault.matches(sql)) { const error = fault.error; fault = null; throw error; }
  if (recent && work) {
    work.prepared++;
    const nativePlan = originalPrepare.call(this, `EXPLAIN QUERY PLAN ${sql}`).all().map(row => row.detail);
    this.function("fixture_recent_book_visit", value => { if (work) work.visits++; return value; });
    sql = sql.replace("b.status = 'ok'", "b.status = 'ok' AND fixture_recent_book_visit(b.status) = 'ok'");
    work.sql = sql;
    work.plan = originalPrepare.call(this, `EXPLAIN QUERY PLAN ${sql}`).all().map(row => row.detail);
    assert.deepEqual(work.plan, nativePlan, "the visit callback must preserve the unmodified native join plan");
  }
  const statement = originalPrepare.call(this, sql, ...rest);
  return new Proxy(statement, { get(target, key) {
    const value = Reflect.get(target, key, target);
    if (typeof value !== "function") return value;
    return (...parameters) => {
      if (readAudit && this !== writer && key === "run" && isWrite(sql)) readAudit.push(sql);
      if (fault?.phase === key && fault.matches(sql)) { const error = fault.error; fault = null; throw error; }
      if (probeResult?.phase === key && probeResult.matches(sql)) { const result = probeResult.value; probeResult = null; return result; }
      if (work && ["get", "all"].includes(key)) {
        work.reads++;
        if (probe) work.probes++;
        if (authorProbe) work.authorProbes++;
        if (recent) work.executed++;
      }
      return value.apply(target, parameters);
    };
  } });
};

try {
  current.bookMeta("missing"); // Only this named temporary library is initialized.
  writer = new DatabaseSync(dbPath);
  definitions = writer.prepare("SELECT type, name, tbl_name, sql FROM sqlite_schema WHERE sql IS NOT NULL AND type IN ('table','index')").all();
  seed(240, 10);
  for (const method of ["summary", "listBooks", "listAuthors", "authorDetail"]) {
    for (const params of [{}, { sort: "title", limit: "7", offset: "2" }, { q: "Book 000", category: "分类1", reading: "1" },
      { q: "NoSuchBook", offset: "999999" }, { author: "Author 1", sort: "progress", limit: "1" }]) {
      compare(method, params);
    }
  }
  assert.equal(compare("summary").recent.length, 6, "control has enough joined reading rows for the old limit");
  assert(compare("summary").recent.some(book => book.progressRecovery), "recovery DTOs participate in recent reading");
  verifyFallbacks();
  verifyCollationAndViews();
  verifyErrors();
  verifyProbeFailures();
  verifyExternalWrites();
  verifyMetadataBoundaries();
  verifyReplacement();
  verifyScale();
  console.log(JSON.stringify({ ok: true, fixture: "novel-recent-reading", responseOracles, errorOracles, metrics }, null, 2));
} finally {
  work = null; fault = null; probeResult = null; beforeRecent = null; readAudit = null; readerSetup = null;
  DatabaseSync.prototype.prepare = originalPrepare; DatabaseSync.prototype.exec = originalExec;
  crypto.randomUUID = originalUuid;
  current.invalidate(); previous.invalidate();
  if (writer?.isTransaction) writer.exec("ROLLBACK");
  if (writer?.isOpen) writer.close();
  directory.cleanup();
}

async function factoryFromSource(source) {
  source = source.replace(/from "(\.\/[^"]+)"/gu,
    (_match, relative) => `from ${JSON.stringify(new URL(relative, ownerUrl).href)}`);
  return (await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`)).createNovelStore;
}

function call(owner, method, params = {}) {
  const url = new URL(`http://fixture.invalid/novels?${new URLSearchParams(params)}`);
  return method === "summary" ? owner.summary()
    : method === "authorDetail" ? owner.authorDetail("Author 1", url) : owner[method](url);
}
function compare(method, params = {}, label = method) {
  const next = call(current, method, params), old = call(previous, method, params);
  assert.deepEqual(next, old, label); responseOracles++;
  return next;
}
function errorFrom(run) {
  try { run(); } catch (error) { return { name: error.name, message: error.message, code: error.code, errcode: error.errcode }; }
  assert.fail("the original recent/query error must remain visible");
}
function compareError(method, params = {}, label = method) {
  assert.deepEqual(errorFrom(() => call(current, method, params)), errorFrom(() => call(previous, method, params)), label);
  errorOracles++;
}
function measure(owner, method = "summary", params = {}) {
  work = { visits: 0, reads: 0, probes: 0, authorProbes: 0, prepared: 0, executed: 0 };
  const started = performance.now();
  try { return { result: call(owner, method, params), milliseconds: +(performance.now() - started).toFixed(2), ...work }; }
  finally { work = null; }
}
function insertBook(id, index, extra = {}) {
  const value = { id, title: `Book ${String(index).padStart(6, "0")}`, author: `Author ${index % 4}`, category: `分类${index % 3}`,
    source_root: "synthetic", source_path: `synthetic://${id}`, relative_path: id, file_name: `${id}.txt`, size_bytes: index % 31,
    char_count: index % 23, chapter_count: 3, summary: "synthetic", tags_json: '["合成",2,false]', status: "ok",
    updated_at: "2026-01-01", catalog_revision: "revision", ...extra };
  const keys = Object.keys(value);
  writer.prepare(`INSERT INTO novel_books (${keys.join(",")}) VALUES (${keys.map(() => "?").join(",")})`).run(...Object.values(value));
}
function setState(count, { tied = false, orphan = false } = {}) {
  writer.exec("DELETE FROM novel_reading_state");
  const insert = writer.prepare(`INSERT INTO novel_reading_state(book_id,chapter_id,chapter_index,scroll_ratio,updated_at,
    catalog_revision,status,reason,anchor_json,candidate_json) VALUES(?,?,1,.5,?,?,?,?,?,?)`);
  for (let index = 0; index < count; index++) {
    const id = orphan && index === count - 1 ? "orphan" : `b${index}`;
    insert.run(id, `chapter-${id}`, tied ? "2026" : new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
      index % 7 === 0 ? "stale" : "revision", ["resolved", "needs_review", "unresolved"][index % 3], "fixture",
      index % 3 ? '{"chapterIndex":1,"scrollRatio":0.2}' : null, index % 3 === 1 ? '{"chapterIndex":2}' : null);
  }
}
function seed(books, states) {
  current.invalidate(); previous.invalidate();
  writer.exec("BEGIN; DELETE FROM novel_reading_state; DELETE FROM novel_books");
  for (let index = 0; index < books; index++) insertBook(`b${index}`, index);
  setState(states);
  writer.exec("COMMIT");
}
function rebuild(name, change = sql => sql) {
  current.invalidate(); previous.invalidate();
  const definition = definitions.find(row => row.type === "table" && row.name === name);
  writer.exec(`BEGIN; ALTER TABLE ${name} RENAME TO ${name}_fixture_old; ${change(definition.sql)};
    INSERT INTO ${name} SELECT * FROM ${name}_fixture_old; DROP TABLE ${name}_fixture_old;`);
  for (const row of definitions.filter(row => row.type === "index" && row.tbl_name === name)) writer.exec(row.sql);
  writer.exec("COMMIT");
}
function verifyFallbacks() {
  for (const [label, count, options] of [["tied timestamps", 10, { tied: true }], ["dense state", 1025, {}],
    ["orphan and missing books", 10, { orphan: true }]]) {
    writer.exec("BEGIN"); setState(count, options); writer.exec("COMMIT");
    if (label.includes("missing")) writer.prepare("UPDATE novel_books SET status='missing' WHERE id='b8'").run();
    for (const method of ["summary", "listBooks", "listAuthors", "authorDetail"]) compare(method, { limit: "3", sort: "progress" }, label);
    if (label !== "orphan and missing books") {
      const next = measure(current), old = measure(previous);
      assert.deepEqual(next.result, old.result); responseOracles++;
      assert.equal(next.visits, old.visits, `${label}: keep the old candidate traversal`);
    }
  }
  writer.prepare("UPDATE novel_books SET status='ok' WHERE id='b8'").run();
  setState(10);
  rebuild("novel_reading_state", sql => sql.replace("updated_at TEXT NOT NULL", "updated_at TEXT"));
  writer.prepare("UPDATE novel_reading_state SET updated_at=NULL WHERE book_id='b0'").run();
  compare("summary", {}, "NULL progress timestamp keeps legacy ordering");
  const nullable = measure(current), oldNullable = measure(previous);
  assert.equal(nullable.visits, oldNullable.visits, "NULL timestamp falls back");
  writer.prepare("UPDATE novel_reading_state SET updated_at='2025' WHERE book_id='b0'").run();
  rebuild("novel_reading_state");
  for (const table of ["novel_books", "novel_reading_state"]) {
    rebuild(table, sql => sql.replace(/(id|book_id) TEXT PRIMARY KEY/u, "$1 TEXT"));
    if (table === "novel_books") writer.exec("INSERT INTO novel_books SELECT 'b0',title,author,category,source_root,'duplicate://b0',relative_path,file_name,size_bytes,mtime_ms,encoding,char_count,chapter_count,first_chapter_id,latest_chapter_id,latest_chapter_title,summary,tags_json,status,error,updated_at,catalog_revision,legacy_write_allowed FROM novel_books WHERE id='b0'");
    else writer.exec("INSERT INTO novel_reading_state SELECT * FROM novel_reading_state WHERE book_id='b0'");
    compare("summary", {}, `${table}: duplicate legacy keys retain JOIN multiplicity/order`);
    const next = measure(current), old = measure(previous);
    assert.deepEqual(next.result, old.result); responseOracles++;
    assert.equal(next.visits, old.visits, `${table}: unqualified key does not switch driver`);
    if (table === "novel_books") writer.prepare("DELETE FROM novel_books WHERE source_path='duplicate://b0'").run();
    else writer.exec("DELETE FROM novel_reading_state WHERE rowid NOT IN (SELECT MIN(rowid) FROM novel_reading_state GROUP BY book_id)");
    rebuild(table);
  }
  for (const table of ["novel_books", "novel_reading_state"]) {
    rebuild(table, sql => sql.replace(/(id|book_id) TEXT PRIMARY KEY/u, "$1 VARCHAR PRIMARY KEY"));
    compare("summary", {}, `${table}: legacy non-TEXT key declaration`);
    const next = measure(current), old = measure(previous);
    assert.equal(next.visits, old.visits, "legacy type falls back to original join");
    rebuild(table);
  }
}
function verifyCollationAndViews() {
  rebuild("novel_reading_state", sql => sql.replace("updated_at TEXT NOT NULL", "updated_at TEXT COLLATE NOCASE NOT NULL"));
  writer.prepare("UPDATE novel_reading_state SET updated_at='stamp' WHERE book_id='b0'").run();
  writer.prepare("UPDATE novel_reading_state SET updated_at='STAMP' WHERE book_id='b1'").run();
  compare("summary", {}, "timestamp DISTINCT respects the ORDER BY column's NOCASE ties");
  const tied = measure(current), oldTied = measure(previous);
  assert.equal(tied.visits, oldTied.visits);
  setState(10); rebuild("novel_reading_state");

  // A TEXT single-column primary key alone does not prove that JOIN's
  // comparison is unique. Here the column and PK index use different collations.
  setState(0);
  insertBook("a", 300, { title: "z" }); insertBook("A", 301, { title: "a" });
  rebuild("novel_books", sql => sql.replace("id TEXT PRIMARY KEY", "id TEXT COLLATE NOCASE")
    .replace(/\)\s*$/u, ", PRIMARY KEY(id COLLATE BINARY))"));
  writer.exec("CREATE INDEX fixture_books_status_title ON novel_books(status,title); CREATE INDEX fixture_books_nocase ON novel_books(id COLLATE NOCASE)");
  writer.prepare("INSERT INTO novel_reading_state(book_id,chapter_index,updated_at,catalog_revision,status) VALUES('a',1,'unique','revision','resolved')").run();
  assert.deepEqual(previous.summary().recent.map(book => book.id), ["A", "a"], "actual legacy JOIN exposes its two tied matches in book-index order");
  for (const method of ["summary", "listBooks", "listAuthors", "authorDetail"]) compare(method, {}, "collation mismatch cannot reorder JOIN-amplified timestamp ties");
  writer.exec("DELETE FROM novel_reading_state; DELETE FROM novel_books WHERE source_path IN ('synthetic://a','synthetic://A')");
  rebuild("novel_books"); setState(10);

  for (const table of ["novel_books", "novel_reading_state"]) {
    const values = [];
    for (const owner of [current, previous]) {
      readerSetup = db => originalExec.call(db, `CREATE TEMP VIEW ${table} AS SELECT * FROM main.${table}`);
      values.push(call(owner, "summary"));
      assert.equal(readerSetup, null, "temporary shadow belongs to the actual reader connection");
    }
    assert.deepEqual(values[0], values[1], "TEMP legacy views cannot inherit a main table's PK qualification"); responseOracles++;
  }
}
function verifyErrors() {
  for (const phase of ["prepare", "all"]) for (const method of ["summary", "listBooks", "listAuthors", "authorDetail"]) {
    const failures = [];
    for (const owner of [current, previous]) {
      fault = { phase, matches: isRecent, error: Object.assign(new Error(`controlled recent ${phase}`), { code: "SQLITE_BUSY" }) };
      failures.push(errorFrom(() => call(owner, method)));
      assert.equal(fault, null, "fault reaches actual recent statement");
    }
    assert.deepEqual(failures[0], failures[1]); errorOracles++;
    compare(method, {}, `${phase}: next read recovers`);
  }
  writer.prepare("UPDATE novel_reading_state SET anchor_json='{bad' WHERE book_id='b8'").run();
  compareError("summary", {}, "malformed recovery JSON keeps mapper error");
  writer.prepare("UPDATE novel_reading_state SET anchor_json=NULL WHERE book_id='b8'").run();
  writer.exec("ALTER TABLE novel_books ADD COLUMN fixture_unsafe INTEGER DEFAULT 9223372036854775807");
  compareError("summary", {}, "unused selected field still throws native unsafe-integer error");
  writer.exec("ALTER TABLE novel_books DROP COLUMN fixture_unsafe");
  writer.exec("ALTER TABLE novel_reading_state RENAME COLUMN chapter_id TO hidden_chapter_id");
  compareError("summary", {}, "original query preparation error survives a successful/failed probe");
  writer.exec("ALTER TABLE novel_reading_state RENAME COLUMN hidden_chapter_id TO chapter_id");
  compare("summary", {}, "DDL restoration is visible to the next opened reader");
}
function verifyProbeFailures() {
  const production = args.includes("--legacy-recent") ? createNovelStore({ dbPath }) : current;
  try {
    for (const [phase, matches] of [["prepare", sql => /^PRAGMA table_info/u.test(sql)], ["all", sql => /^PRAGMA table_info/u.test(sql)],
      ["prepare", sql => /COUNT\(DISTINCT updated_at\)/u.test(sql)], ["get", sql => /COUNT\(DISTINCT updated_at\)/u.test(sql)],
      ["prepare", sql => /AS books_sql/u.test(sql)], ["get", sql => /AS books_sql/u.test(sql)]]) {
      fault = { phase, matches, error: new Error(`controlled eligibility ${phase}`) };
      const next = measure(production), old = measure(previous);
      assert.equal(fault, null, "real eligibility probe was reached");
      assert.deepEqual(next.result, old.result); responseOracles++;
      assert.equal(next.visits, old.visits, "probe failure conservatively keeps old JOIN");
      assert.deepEqual(production.summary(), previous.summary(), "later qualification retries without cached failed eligibility"); responseOracles++;
    }
    for (const [phase, matches, value] of [
      ["all", sql => /^PRAGMA table_info/u.test(sql), []],
      ["get", sql => /AS books_sql/u.test(sql), undefined],
      ["get", sql => /COUNT\(DISTINCT updated_at\)/u.test(sql), { count: 10, timestamps: 9 }]
    ]) {
      probeResult = { phase, matches, value };
      const next = measure(production), old = measure(previous);
      assert.equal(probeResult, null, "false/missing eligibility proof reached the native-result boundary");
      assert.deepEqual(next.result, old.result); responseOracles++;
      assert.equal(next.visits, old.visits, "false/missing proof keeps the exact legacy driver");
      assert.deepEqual(production.summary(), previous.summary(), "next request obtains a new proof"); responseOracles++;
    }
  } finally { if (production !== current) production.invalidate(); }
}
function verifyExternalWrites() {
  const first = compare("listBooks", { limit: "3" });
  writer.prepare("UPDATE novel_reading_state SET updated_at='2999',scroll_ratio=.75 WHERE book_id='b0'").run();
  const changed = compare("listBooks", { limit: "3" });
  assert.notEqual(changed.listRevision, first.listRevision);
  assert.equal(changed.summary.recent[0].id, "b0", "fresh external reading state replaces the recent prefix");
  writer.exec("BEGIN IMMEDIATE");
  try {
    readAudit = [];
    compare("summary", {}, "current schema reads coexist with an external writer lock");
    assert.deepEqual(readAudit, [], "opening a current v5 library and probing recent never writes");
  } finally { readAudit = null; writer.exec("ROLLBACK"); }
  crypto.randomUUID = () => "11111111-1111-4111-8111-111111111111";
  for (const method of ["summary", "listBooks", "listAuthors"]) {
    const values = [];
    for (const owner of [current, previous]) {
      writer.prepare("UPDATE novel_books SET title='Old title',chapter_count=3 WHERE id='b0'").run();
      beforeRecent = () => writer.prepare("UPDATE novel_books SET title='New title',chapter_count=9 WHERE id='b0'").run();
      values.push(call(owner, method, { limit: "3" }));
      assert.equal(beforeRecent, null);
      const recent = method === "summary" ? values.at(-1).recent : values.at(-1).summary.recent;
      assert.equal(recent[0].title, "Old title", "recent uses the already-pinned snapshot");
    }
    assert.deepEqual(values[0], values[1]); responseOracles++;
    const after = compare(method, { limit: "3" });
    assert.equal((method === "summary" ? after : after.summary).recent[0].title, "New title");
  }
  crypto.randomUUID = originalUuid;
}
function verifyMetadataBoundaries() {
  const saved = writer.prepare("SELECT * FROM novel_meta ORDER BY key").all();
  for (const [key, value] of [["schema_version", "7"], ["schema_version", "NaN"], ["schema_version", "-1"], ["library_id", "invalid"]]) {
    writer.prepare("UPDATE novel_meta SET value=? WHERE key=?").run(value, key);
    const before = writer.prepare("SELECT * FROM novel_meta ORDER BY key").all();
    readAudit = [];
    for (const method of ["summary", "listBooks", "listAuthors", "authorDetail"]) compareError(method, {}, `${key}=${value}`);
    assert.deepEqual(readAudit, [], "invalid/future metadata is rejected before DDL or assignments"); readAudit = null;
    assert.deepEqual(writer.prepare("SELECT * FROM novel_meta ORDER BY key").all(), before);
    writer.prepare("UPDATE novel_meta SET value=? WHERE key=?").run(saved.find(row => row.key === key).value, key);
  }
  writer.prepare("UPDATE novel_books SET title='Fresh metadata',tags_json='[\"new\"]',summary='Current summary' WHERE id='b0'").run();
  const fresh = compare("summary");
  assert.equal(fresh.recent[0].title, "Fresh metadata");
  assert.deepEqual(fresh.recent[0].tags, ["new"]);
}
function verifyReplacement() {
  const oldRealm = compare("summary").sourceRealm;
  const replacementPath = path.join(directory.tempDir, "replacement.sqlite");
  const replacement = createNovelStore({ dbPath: replacementPath });
  replacement.bookMeta("missing"); replacement.invalidate();
  current.invalidate(); previous.invalidate(); writer.close();
  for (const suffix of ["-wal", "-shm"]) assert(!fs.existsSync(dbPath + suffix), "closed private readers/writer checkpoint before replacing database");
  fs.renameSync(dbPath, path.join(directory.tempDir, "retired.sqlite"));
  fs.renameSync(replacementPath, dbPath);
  writer = new DatabaseSync(dbPath);
  seed(30, 10);
  const next = compare("summary", {}, "same owner observes a replaced database's new schema and source identity");
  assert.notEqual(next.sourceRealm, oldRealm);
  assert.equal(next.totals.books, 30);
}
function verifyScale() {
  seed(100000, 0);
  for (const stateRows of [0, 10]) {
    setState(stateRows);
    current.summary(); previous.summary(); // Static aggregates are not this budget's target.
    for (const method of ["summary", "listBooks", "listAuthors", "authorDetail"]) {
      const params = { limit: "1", q: "NoSuchBook", offset: "100000" };
      const old = measure(previous, method, params), next = measure(current, method, params);
      assert.deepEqual(next.result, old.result); responseOracles++;
      assert.equal(old.visits, 100000, "negative/oracle really traverses every active book");
      assert.equal(old.prepared, 1); assert.equal(old.executed, 1);
      assert.equal(next.prepared, 1); assert.equal(next.executed, 1);
      assert(old.plan.some(detail => /SCAN b/u.test(detail)), "instrumentation retains the original native book driver");
      assert(next.visits <= stateRows, `${method}/${stateRows}: recent book candidate budget is bounded by sparse reading state`);
      assert(next.plan.some(detail => /SCAN s/u.test(detail)), "native plan drives the bounded state rather than books");
      assert.equal(next.probes, 4, "qualification uses two PK probes, one catalog/shadow proof and one bounded aggregate");
      assert.equal(old.authorProbes, 0, "the frozen owner has no author-index qualification");
      assert.equal(next.authorProbes, method === "authorDetail" ? 1 : 0, "only the author request adds one metadata qualification");
      assert.equal(next.reads, old.reads + 4 + next.authorProbes, "recent qualifications and the optional author proof are counted separately");
      let nativeDiagnosticMs;
      if (method === "summary") {
        const beforeTimes = [], afterTimes = [];
        for (let round = 0; round < 3; round++) {
          for (const [owner, times] of round % 2 ? [[current, afterTimes], [previous, beforeTimes]] : [[previous, beforeTimes], [current, afterTimes]]) {
            const start = performance.now();
            assert.deepEqual(call(owner, method, params), next.result);
            times.push(performance.now() - start);
          }
        }
        const median = values => +values.sort((a, b) => a - b)[1].toFixed(2);
        nativeDiagnosticMs = { previousMedian: median(beforeTimes), currentMedian: median(afterTimes) };
      }
      metrics.push({ method, books: 100000, stateRows, previousVisits: old.visits, currentVisits: next.visits,
        instrumentedPreviousMs: old.milliseconds, instrumentedCurrentMs: next.milliseconds,
        nativeDiagnosticMs, sqlReads: next.reads, probes: next.probes });
    }
  }
}
