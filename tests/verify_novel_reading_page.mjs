import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { createNovelStore } from "../src/modules/novels/server/store.js";
import { createVerifiedTempDir } from "./verified-temp-cleanup.mjs";

assert(process.argv.slice(2).every(value => value === "--legacy-reading-page"), "known arguments");
const ownerUrl = new URL("../src/modules/novels/server/store.js", import.meta.url);
const oldSource = execFileSync("git", ["show", "63c5fab243233e142cfd62c4eaf13812feb92405:src/modules/novels/server/store.js"],
  { cwd: fileURLToPath(new URL("../", import.meta.url)), encoding: "utf8" }).replace(/\r\n/g, "\n");
assert.equal(crypto.createHash("sha256").update(oldSource).digest("hex"), "f9ffae913d0efc7aa245ed5b3d8108af9c043b542c77e30fe704f4af6219a6fa", "fixed complete store oracle");
async function factory(source) {
  source = source.replace(/from "(\.\/[^"]+)"/gu, (_match, relative) => `from ${JSON.stringify(new URL(relative, ownerUrl).href)}`);
  return (await import("data:text/javascript;base64," + Buffer.from(source).toString("base64"))).createNovelStore;
}
// Keep the complete frozen query owner; only accept the index-only v6 schema.
let readableBaseline = oldSource;
for (const [before, after] of [['=== 5) return;', '=== 6) return;'], ['if (version > 5) throw', 'if (version > 6) throw']]) {
  assert.equal(readableBaseline.split(before).length, 2, "one read-version adapter slot");
  readableBaseline = readableBaseline.replace(before, after);
}
const beforeFactory = await factory(readableBaseline);
const source = fs.readFileSync(ownerUrl, "utf8").replace(/\r\n/g, "\n");
const joinSlot = 'const pageFrom = stateDrivenPage\n        ? "novel_reading_state s CROSS JOIN novel_books b ON s.book_id = b.id"\n        : "novel_books b LEFT JOIN novel_reading_state s ON s.book_id = b.id";';
assert.equal(source.split(joinSlot).length, 2, "one page-only FROM choice");
const fallbackFactory = await factory(source.replace(joinSlot, 'const pageFrom = "novel_books b LEFT JOIN novel_reading_state s ON s.book_id = b.id";'));
const testedFactory = process.argv.includes("--legacy-reading-page") ? fallbackFactory : createNovelStore;
const directory = createVerifiedTempDir("fanhao-novel-reading-page-");
const dbPath = path.join(directory.tempDir, "private.sqlite");
const current = testedFactory({ dbPath }), previous = beforeFactory({ dbPath });
const fallback = fallbackFactory({ dbPath });
const prepare = DatabaseSync.prototype.prepare, randomUuid = crypto.randomUUID;
let writer, definitions, work = null, fault = null, beforePage = null, readerSetup = null;
let responseOracles = 0, errorOracles = 0;
const measurements = [];
const isPage = sql => /SELECT b\.\*,[\s\S]*LIMIT \? OFFSET \?/u.test(sql);
const probeName = sql => /^PRAGMA table_info\(novel_books\)$/u.test(sql) ? "books columns"
  : /^PRAGMA table_info\(novel_reading_state\)$/u.test(sql) ? "state columns"
    : /AS books_sql/u.test(sql) ? "books declaration and TEMP"
      : /COUNT\(DISTINCT updated_at\) AS timestamps/u.test(sql) ? "bounded timestamps"
        : /SELECT sql FROM main\.sqlite_schema.*name = 'novel_reading_state'/u.test(sql) ? "state declaration" : "";
DatabaseSync.prototype.prepare = function(sql, ...rest) {
  if (readerSetup && this !== writer) { const setup = readerSetup; readerSetup = null; setup(this); }
  const page = isPage(sql), probe = !work?.pageSeen && probeName(sql);
  if (page && beforePage) { const action = beforePage; beforePage = null; action(); }
  if (fault?.phase === "prepare" && fault.matches(sql, probe)) { const error = fault.error; fault = null; throw error; }
  const nativeSql = sql, connection = this;
  if (page && work) {
    work.pageSeen = true;
    if (work.countVisits) {
      this.function("fixture_reading_page_visit", value => { if (work) work.visits++; return value; });
      sql = sql.replace("b.status = 'ok'", "b.status = 'ok' AND fixture_reading_page_visit(b.status) = 'ok'");
    }
  }
  const statement = prepare.call(this, sql, ...rest);
  return new Proxy(statement, { get(target, key) {
    const value = Reflect.get(target, key, target);
    if (typeof value !== "function") return value;
    return (...args) => {
      if (fault?.phase === key && fault.matches(nativeSql, probe)) { const error = fault.error; fault = null; throw error; }
      if (work && ["get", "all"].includes(key)) {
        work.reads++;
        if (probe) { work.probes++; work.probeNames.push(probe); }
      }
      if (page && key === "all" && work) {
        const plan = text => prepare.call(connection, "EXPLAIN QUERY PLAN " + text).all(...args).map(row => row.detail);
        work.plan = plan(nativeSql); work.sql = nativeSql;
        assert.deepEqual(plan(sql), work.plan, "visit instrumentation preserves the unmodified native query plan");
        const start = performance.now(), result = value.apply(target, args);
        work.pageMs += performance.now() - start; work.pageRows += result.length; return result;
      }
      return value.apply(target, args);
    };
  } });
};
const url = params => new URL("http://fixture.invalid/api/novels?" + new URLSearchParams(params));
function compare(params = {}, label = "full response") {
  const old = previous.listBooks(url(params)), next = current.listBooks(url(params));
  assert.deepEqual(next, old, label); assert.equal(JSON.stringify(next), JSON.stringify(old), label + " wire order"); responseOracles++; return next;
}
function book(id, index, extra = {}) {
  const row = { id, title: "Book " + String(index).padStart(6, "0"), author: "Author " + index % 7, category: "分类" + index % 3,
    source_root: "synthetic", source_path: "synthetic://" + id, relative_path: id, file_name: id + ".txt", size_bytes: index,
    char_count: index + 1, chapter_count: 10, summary: "synthetic", tags_json: '["合成",2,false]', status: "ok", updated_at: "2026-01-01", ...extra };
  const keys = Object.keys(row);
  writer.prepare(`INSERT INTO novel_books(${keys.join(",")}) VALUES(${keys.map(() => "?").join(",")})`).run(...Object.values(row));
}
function states(count, { tied = false, orphan = false } = {}) {
  writer.exec("DELETE FROM novel_reading_state");
  const insert = writer.prepare("INSERT INTO novel_reading_state(book_id,chapter_index,scroll_ratio,updated_at) VALUES(?,1,.5,?)");
  for (let index = 0; index < count; index++) insert.run(orphan && index === count - 1 ? "orphan" : "b" + index,
    tied ? "same timestamp" : new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString());
}
function seed(count, stateCount = 10, options = {}) {
  current.invalidate(); previous.invalidate(); writer.exec("BEGIN;DELETE FROM novel_reading_state;DELETE FROM novel_books");
  for (let index = 0; index < count; index++) book("b" + index, index);
  states(stateCount, options); writer.exec("COMMIT");
}
function rebuild(table, change = sql => sql) {
  current.invalidate(); previous.invalidate();
  const ddl = definitions.find(row => row.type === "table" && row.name === table).sql;
  writer.exec(`BEGIN;ALTER TABLE ${table} RENAME TO private_old;${change(ddl)};INSERT INTO ${table} SELECT * FROM private_old;DROP TABLE private_old;`);
  for (const row of definitions.filter(row => row.type === "index" && row.tbl_name === table)) writer.exec(row.sql);
  writer.exec("COMMIT");
}
function measure(owner, params, countVisits = false) {
  work = { reads: 0, probes: 0, probeNames: [], pageSeen: false, visits: 0, pageMs: 0, pageRows: 0, countVisits };
  const start = performance.now();
  try { const result = owner.listBooks(url(params)); return { result, ms: performance.now() - start, ...work }; }
  finally { work = null; }
}
const normal = { reading: "1", sort: "progress", limit: "30" };
function assertOriginalPage(params = normal) {
  const result = measure(current, params);
  assert(result.sql.includes("FROM novel_books b LEFT JOIN novel_reading_state s ON s.book_id = b.id"), "ineligible pages retain the exact original joins");
  return result;
}
function verifyResponses() {
  seed(240, 10);
  for (const reading of ["1", "0", "yes"]) for (const sort of ["progress", "title", "updated", "chars", "size", "chapters"]) {
    for (const filter of [{}, { category: "分类1", offset: "1" }, { author: "Author 1" }, { q: "Book 000", offset: "3" }]) compare({ ...filter, reading, sort, limit: "7" });
  }
  for (const params of [{ ...normal, offset: "999999" }, { ...normal, q: "NoSuchBook" }, { sort: "progress" }, { reading: "1", sort: "title" }]) {
    compare(params); const measured = assertOriginalPage(params); assert.equal(measured.probes, 0, "empty/non-progress/non-reading pages do no new qualification");
  }
  for (const [count, options] of [[0, {}], [10, { tied: true }], [1025, {}], [10, { orphan: true }]]) {
    seed(1200, count, options); compare(normal);
    if (options.orphan) continue;
    assertOriginalPage();
  }
  seed(240, 10);
  const expected = measure(current, normal); assert.equal(expected.probes, 5); assert.equal(new Set(expected.probeNames).size, 5);
}
function verifyLegacy() {
  for (const [table, change] of [
    ["novel_books", sql => sql.replace("id TEXT PRIMARY KEY", "id VARCHAR PRIMARY KEY")],
    ["novel_books", sql => sql.replace("id TEXT PRIMARY KEY", "id TEXT COLLATE NOCASE PRIMARY KEY")],
    ["novel_reading_state", sql => sql.replace("book_id TEXT PRIMARY KEY", "book_id VARCHAR PRIMARY KEY")],
    ["novel_reading_state", sql => sql.replace("book_id TEXT PRIMARY KEY", "book_id TEXT COLLATE NOCASE PRIMARY KEY")],
    ["novel_reading_state", sql => sql.replace("book_id TEXT PRIMARY KEY,", "book_id TEXT,").replace(/\)\s*$/u, ", PRIMARY KEY(book_id))")]
  ]) {
    rebuild(table, change); compare(normal, "legacy declaration"); assertOriginalPage(); rebuild(table);
  }
  // The state column is on the left of the original ON. NOCASE can match two
  // distinct BINARY book IDs and introduce tied progress rows from one state.
  rebuild("novel_reading_state", sql => sql.replace("book_id TEXT PRIMARY KEY", "book_id TEXT COLLATE NOCASE PRIMARY KEY"));
  writer.exec("DELETE FROM novel_reading_state;DELETE FROM novel_books"); book("a", 1); book("A", 2);
  writer.prepare("INSERT INTO novel_reading_state(book_id,chapter_index,updated_at) VALUES('a',1,'unique')").run();
  assert.equal(compare(normal, "state left collation fanout").books.length, 2); assertOriginalPage();
  rebuild("novel_reading_state"); seed(240, 10);
  rebuild("novel_reading_state", sql => sql.replace("updated_at TEXT NOT NULL", "updated_at TEXT COLLATE NOCASE NOT NULL"));
  writer.exec("UPDATE novel_reading_state SET updated_at=CASE book_id WHEN 'b0' THEN 'A' WHEN 'b1' THEN 'a' ELSE book_id END");
  compare(normal, "SQL timestamp collation ties"); assertOriginalPage(); rebuild("novel_reading_state"); seed(240, 10);
  rebuild("novel_reading_state", sql => sql.replace("updated_at TEXT NOT NULL", "updated_at TEXT"));
  writer.exec("UPDATE novel_reading_state SET updated_at=NULL WHERE book_id='b0'");
  compare(normal, "legacy NULL timestamp"); assertOriginalPage();
  writer.exec("UPDATE novel_reading_state SET updated_at=book_id WHERE updated_at IS NULL");
  rebuild("novel_reading_state"); seed(240, 10);
  for (const table of ["novel_books", "novel_reading_state"]) {
    const install = db => db.exec(`CREATE TEMP VIEW ${table} AS SELECT * FROM main.${table}`);
    readerSetup = install; const old = previous.listBooks(url(normal));
    readerSetup = install; const next = measure(current, normal);
    assert.deepEqual(next.result, old); assert(next.sql.includes("FROM novel_books b LEFT JOIN")); responseOracles++;
  }
}
function verifyErrors() {
  seed(240, 10);
  for (const name of ["books columns", "state columns", "books declaration and TEMP", "bounded timestamps", "state declaration"]) {
    for (const phase of ["prepare", name.endsWith("columns") ? "all" : "get"]) {
      const expected = previous.listBooks(url(normal));
      fault = { phase, matches: (_sql, probe) => probe === name, error: new Error("controlled qualification failure") };
      const actual = assertOriginalPage(); assert.equal(fault, null, "fault hit the exact page qualification");
      assert.deepEqual(actual.result, expected); responseOracles++;
    }
  }
  for (const phase of ["prepare", "all"]) {
    const held = Object.assign(new Error("controlled page error"), { code: "SQLITE_BUSY" });
    for (const owner of [previous, current]) {
      fault = { phase, matches: sql => isPage(sql), error: held };
      assert.throws(() => owner.listBooks(url(normal)), error => error === held); errorOracles++;
    }
  }
  writer.exec("ALTER TABLE novel_books ADD COLUMN unsafe_integer INTEGER; UPDATE novel_books SET unsafe_integer=9007199254740992");
  const errors = [];
  for (const owner of [previous, current]) { try { owner.listBooks(url(normal)); assert.fail("native integer decode must fail"); } catch (error) { errors.push([error.name, error.code, error.message]); errorOracles++; } }
  assert.deepEqual(errors[1], errors[0]); assert.equal(errors[0][0], "RangeError");
  writer.exec("UPDATE novel_books SET unsafe_integer=NULL"); compare(normal, "native decode recovery");
  writer.exec("ALTER TABLE novel_books DROP COLUMN unsafe_integer");
}
function verifyWal() {
  seed(240, 10); const expected = previous.listBooks(url(normal));
  beforePage = () => writer.exec("UPDATE novel_reading_state SET updated_at='2099-01-01' WHERE book_id='b0'");
  const snapshot = current.listBooks(url(normal));
  assert.deepEqual(snapshot.books, expected.books, "qualification and page retain the read snapshot across a real WAL writer"); responseOracles++;
  assert.equal(current.listBooks(url(normal)).books[0].id, "b0", "the next connection sees the committed WAL change"); responseOracles++;
  current.invalidate(); previous.invalidate(); compare(normal, "explicit owner reopen");
}
function verifyScale() {
  seed(100000, 10);
  for (const stateCount of [10, 1000]) {
    states(stateCount); current.invalidate(); previous.invalidate();
    for (const filter of [{}, { category: "分类1" }]) {
      const params = { ...normal, ...filter }, old = measure(fallback, params, true), next = measure(current, params, true);
      assert.deepEqual(next.result, previous.listBooks(url(params)), "the fixed complete owner still supplies the response oracle");
      assert.deepEqual(next.result, old.result); responseOracles++;
      assert.equal(old.visits, 100000); assert.equal(next.visits, stateCount, "reading page visits are bounded by actual reading-state rows");
      assert.equal(next.probes, 5, "page qualifications are counted separately from the existing summary probes");
      const oldTimes = [], times = [];
      for (let round = 0; round < 3; round++) for (const owner of round % 2 ? [current, fallback] : [fallback, current]) {
        const result = measure(owner, params, false); (owner === current ? times : oldTimes).push(result.ms);
      }
      measurements.push({ stateCount, filter, oldVisits: old.visits, visits: next.visits, probes: next.probes,
        oldPlan: old.plan, plan: next.plan, diagnosticMs: { old: oldTimes, current: times } });
    }
  }
}
try {
  current.bookMeta("missing"); writer = new DatabaseSync(dbPath);
  definitions = writer.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE sql IS NOT NULL AND type IN ('table','index')").all();
  verifyResponses(); verifyLegacy(); verifyErrors(); verifyWal(); verifyScale();
  console.log(JSON.stringify({ fixture: "novel-reading-page", responseOracles, errorOracles, measurements }, null, 2));
} finally {
  DatabaseSync.prototype.prepare = prepare; crypto.randomUUID = randomUuid;
  current.invalidate(); previous.invalidate(); fallback.invalidate(); if (writer?.isOpen) writer.close(); directory.cleanup();
}
