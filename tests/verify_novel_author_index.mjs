import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { createNovelStore } from "../src/modules/novels/server/store.js";
import { createVerifiedTempDir } from "./verified-temp-cleanup.mjs";

assert(process.argv.slice(2).every(value => value === "--disable-author-index"), "known arguments");
const disabled = process.argv.includes("--disable-author-index");
const ownerUrl = new URL("../src/modules/novels/server/store.js", import.meta.url);
const frozen = execFileSync("git", ["show", "63c5fab243233e142cfd62c4eaf13812feb92405:src/modules/novels/server/store.js"],
  { cwd: fileURLToPath(new URL("../", import.meta.url)), encoding: "utf8" }).replace(/\r\n/g, "\n");
assert.equal(crypto.createHash("sha256").update(frozen).digest("hex"), "f9ffae913d0efc7aa245ed5b3d8108af9c043b542c77e30fe704f4af6219a6fa", "fixed complete historical store");
async function factory(source) {
  source = source.replace(/from "(\.\/[^"]+)"/gu, (_match, relative) => `from ${JSON.stringify(new URL(relative, ownerUrl).href)}`);
  return (await import("data:text/javascript;base64," + Buffer.from(source).toString("base64"))).createNovelStore;
}
// Only let the historical owner read an already migrated v6 database. Its
// queries, row mapping, errors, ordering and initialization body remain frozen.
assert.equal(frozen.split('=== 5) return;').length, 2);
assert.equal(frozen.split("version > 5").length, 2);
const beforeFactory = await factory(frozen.replace('=== 5) return;', '=== 6) return;').replace("version > 5", "version > 6"));
const currentSource = fs.readFileSync(ownerUrl, "utf8").replace(/\r\n/g, "\n");
const indexSlot = "database.exec(AUTHOR_INDEX_SQL)";
assert.equal(currentSource.split(indexSlot).length, 2, "one optional index installation");
const withoutIndexFactory = await factory(currentSource.replace(indexSlot, "void AUTHOR_INDEX_SQL"));
const testedFactory = disabled ? withoutIndexFactory : createNovelStore;
const temporary = createVerifiedTempDir("fanhao-novel-author-index-");
const nativePrepare = DatabaseSync.prototype.prepare;
const pairs = [];
let sequence = 0, active = null, fault = null, readerSetup = null, afterProof = null;
let responses = 0, errors = 0, policyChecks = 0;
const measurements = [];
const isPage = sql => /^\s*SELECT b\.\*,[\s\S]*LIMIT \? OFFSET \?/u.test(sql);
const isProof = sql => sql.includes("AS schema_name") && sql.includes("idx_novel_books_author_updated");
const isCount = sql => /^SELECT COUNT\(\*\) AS count FROM /u.test(sql);
DatabaseSync.prototype.prepare = function(sql, ...rest) {
  if (readerSetup && !pairs.some(pair => pair.writer === this)) { const setup = readerSetup; readerSetup = null; setup(this); }
  if (fault?.phase === "prepare" && fault.matches(sql)) { const error = fault.error; fault = null; throw error; }
  const originalSql = sql, database = this, page = isPage(sql), count = isCount(sql);
  if (active?.visits && (page || count)) {
    this.function("fixture_author_visit", value => { active[page ? "pageVisits" : "countVisits"]++; return value; });
    sql = sql.replace("b.status = 'ok'", "b.status = 'ok' AND fixture_author_visit(b.status) = 'ok'");
  }
  const statement = nativePrepare.call(this, sql, ...rest);
  return new Proxy(statement, { get(target, key) {
    const value = Reflect.get(target, key, target);
    if (typeof value !== "function") return value;
    return (...args) => {
      if (fault?.phase === key && fault.matches(originalSql)) { const error = fault.error; fault = null; throw error; }
      if (active && ["get", "all"].includes(key)) {
        active.reads++;
        if (isProof(originalSql)) active.probes++;
      }
      if (active && page && key === "all") {
        const plan = text => nativePrepare.call(database, "EXPLAIN QUERY PLAN " + text).all(...args).map(row => row.detail);
        active.plan = plan(originalSql); active.sql = originalSql;
        assert.deepEqual(plan(sql), active.plan, "visit callback preserves the unmodified native page plan");
      }
      if (active && ["get", "all"].includes(key)
        && (/COUNT\(DISTINCT TRIM\(author\)\)/u.test(originalSql) || /GROUP BY TRIM\(author\)/u.test(originalSql))) {
        (active.authorPlans ||= []).push(nativePrepare.call(database, "EXPLAIN QUERY PLAN " + originalSql).all(...args).map(row => row.detail));
      }
      const result = value.apply(target, args);
      if (isProof(originalSql) && key === "all" && afterProof) { const action = afterProof; afterProof = null; action(); }
      return result;
    };
  } });
};
const url = params => new URL("http://fixture.invalid/api/novels?" + new URLSearchParams(params));
function pair(label, ownerFactory = testedFactory) {
  const dbPath = path.join(temporary.tempDir, `${sequence++}-${label}.sqlite`);
  const current = ownerFactory({ dbPath }); current.summary();
  const result = { current, previous: beforeFactory({ dbPath }), dbPath, writer: new DatabaseSync(dbPath) };
  pairs.push(result); return result;
}
function book(database, id, index, extra = {}) {
  const row = { id, title: "Book " + String(index).padStart(6, "0"), author: "Writer", category: "分类" + index % 3,
    source_root: "synthetic", source_path: "synthetic://" + id, relative_path: id, file_name: id + ".txt",
    size_bytes: index + 10, mtime_ms: index, char_count: index + 100, chapter_count: index + 1,
    summary: "合成资料", tags_json: '["synthetic",2]', status: "ok", updated_at: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(), ...extra };
  const columns = Object.keys(row);
  database.prepare(`INSERT INTO novel_books(${columns.join(",")}) VALUES(${columns.map(() => "?").join(",")})`).run(...Object.values(row));
}
function seed(target, count = 32) {
  target.current.invalidate(); target.previous.invalidate(); target.writer.exec("BEGIN;DELETE FROM novel_reading_state;DELETE FROM novel_books");
  for (let index = 0; index < count; index++) book(target.writer, "b" + index, index, { author: index % 7 === 0 ? " Other " : index % 11 === 0 ? null : index % 13 === 0 ? "" : " Writer " });
  const state = target.writer.prepare("INSERT INTO novel_reading_state(book_id,chapter_index,scroll_ratio,updated_at) VALUES(?,1,.5,?)");
  for (let index = 0; index < Math.min(12, count); index++) state.run("b" + index, new Date(Date.UTC(2026, 1, 1, 0, 0, index)).toISOString());
  target.writer.exec("COMMIT");
}
function compare(target, params, label = "complete DTO", method = "listBooks") {
  const invoke = owner => method === "authorDetail" ? owner.authorDetail(params.author, url(params)) : owner[method](url(params));
  const old = invoke(target.previous), next = invoke(target.current);
  assert.deepEqual(next, old, label); assert.equal(JSON.stringify(next), JSON.stringify(old), label + " wire order"); responses++; return next;
}
function measure(owner, params, visits = false, method = "listBooks") {
  active = { reads: 0, probes: 0, visits, countVisits: 0, pageVisits: 0 };
  try { return { result: owner[method](url(params)), ...active }; } finally { active = null; }
}
function sameError(first, second, label) {
  const capture = callback => { try { callback(); } catch (error) { return { name: error.name, message: error.message, code: error.code }; } assert.fail(label + " must fail"); };
  assert.deepEqual(capture(second), capture(first), label); errors++;
}
function noQualifiedAuthor(target, label, params = { author: "Writer", sort: "updated", limit: "8" }) {
  compare(target, params, label);
  const measured = measure(target.current, params);
  assert(!measured.sql.includes("b.author COLLATE BINARY <> ''"), label + " original predicate");
  assert(!/b\.rowid (?:ASC|DESC)/u.test(measured.sql), label + " original order");
}
function rebuild(target, table, change) {
  target.current.invalidate(); target.previous.invalidate();
  const schema = target.writer.prepare("SELECT type,name,sql FROM sqlite_schema WHERE tbl_name=? AND sql IS NOT NULL").all(table);
  const declaration = schema.find(row => row.type === "table").sql;
  const columns = target.writer.prepare(`PRAGMA table_info(${table})`).all().map(row => row.name);
  target.writer.exec(`BEGIN;ALTER TABLE ${table} RENAME TO fixture_old;${change(declaration)};
    INSERT INTO ${table}(${columns.join(",")}) SELECT ${columns.join(",")} FROM fixture_old;DROP TABLE fixture_old;`);
  for (const row of schema.filter(row => row.type === "index")) target.writer.exec(row.sql);
  target.writer.exec("COMMIT");
}
function verifyResponses() {
  const target = pair("responses"); seed(target, 90);
  const planBaseline = pair("non-author-plans", withoutIndexFactory); seed(planBaseline, 90);
  for (const sort of ["updated", "title", "chapters", "size", "chars", "progress"]) {
    for (const reading of ["", "1"]) for (const filter of [{}, { category: "分类1", offset: "2" }, { q: "Book 0000", limit: "7" }]) {
      compare(target, { author: " Writer ", sort, reading, limit: "13", ...filter });
    }
    compare(target, { author: "Writer", sort, limit: "9" }, "actual author detail", "authorDetail");
  }
  for (const author of ["Absent", "", "Other", "\u0000", "Writer\u0000suffix"]) compare(target, { author, limit: "4" });
  for (const sort of ["updated", "title", "chapters", "size", "chars", "progress"]) for (const reading of ["", "1"]) {
    const params = { sort, reading, limit: "11" };
    compare(target, params, "non-author response");
    // Preserve the already shipped reading-page optimization in both plans;
    // the fixed historical owner remains the complete-response oracle above.
    const old = measure(planBaseline.current, params), next = measure(target.current, params);
    assert.equal(next.probes, 0, "non-author requests do not probe new capability");
    assert.deepEqual(next.plan, old.plan, "partial index is ineligible for non-author page plans");
  }
  for (const q of ["", "Write", "Other"]) {
    compare(target, { q }, "author aggregates retain their original SQL", "listAuthors");
    const old = measure(planBaseline.current, { q }, false, "listAuthors"), next = measure(target.current, { q }, false, "listAuthors");
    assert.equal(next.probes, 0);
    assert.deepEqual(next.authorPlans, old.authorPlans, "the partial index does not change author aggregate plans");
  }
  target.writer.exec("BEGIN;DELETE FROM novel_reading_state;DELETE FROM novel_books");
  const ids = ["z", "a", "m", "b"];
  ids.forEach((id, index) => book(target.writer, id, index, { title: "Same", author: "Writer", chapter_count: 8, size_bytes: 8, char_count: 8, updated_at: "tied" }));
  target.writer.exec("COMMIT");
  for (const sort of ["updated", "title", "chapters", "size", "chars", "progress"]) {
    const result = compare(target, { author: "Writer", sort, limit: "2", offset: "1" }, "standard producer rowid tie");
    assert.deepEqual(result.books.map(row => row.id), (sort === "updated" ? ids.toReversed() : ids).slice(1, 3)); policyChecks++;
  }
  // Dynamic stored types retain SQLite's comparison rules; rows remain wide.
  target.writer.prepare("UPDATE novel_books SET title=?,updated_at=? WHERE id='a'").run(Buffer.from([65, 0, 66]), Buffer.from([49, 0, 50]));
  for (const sort of ["updated", "title", "chapters"]) compare(target, { author: "Writer", sort, limit: "4" }, "native BLOB/NUL sort values");
}
function verifyLegacy() {
  for (const [label, mutate] of [
    ["unknown-index", target => target.writer.exec("CREATE INDEX fixture_extra ON novel_books(title COLLATE NOCASE)")],
    ["descending-old-index", target => target.writer.exec("DROP INDEX idx_novel_books_updated;CREATE INDEX idx_novel_books_updated ON novel_books(updated_at DESC)")],
    ["bad-own-index", target => target.writer.exec("DROP INDEX IF EXISTS idx_novel_books_author_updated;CREATE INDEX idx_novel_books_author_updated ON novel_books(author)")],
    ["rowid-shadow", target => target.writer.exec("ALTER TABLE novel_books ADD COLUMN rowid TEXT")],
    ["generated-shadow", target => target.writer.exec("ALTER TABLE novel_books ADD COLUMN _rowid_ INTEGER GENERATED ALWAYS AS (1) VIRTUAL")],
    ["without-rowid", target => rebuild(target, "novel_books", sql => sql + " WITHOUT ROWID")],
    ["collated-id", target => rebuild(target, "novel_books", sql => sql.replace("id TEXT PRIMARY KEY", "id TEXT COLLATE NOCASE PRIMARY KEY"))],
    ["state-table-key", target => rebuild(target, "novel_reading_state", sql => sql.replace("book_id TEXT PRIMARY KEY,", "book_id TEXT,").replace(/\)$/u, ", PRIMARY KEY(book_id))"))],
    ["nullable-title", target => { rebuild(target, "novel_books", sql => sql.replace("title TEXT NOT NULL", "title TEXT")); target.writer.exec("UPDATE novel_books SET title=NULL WHERE id='b1'"); }],
    ["main-view", target => target.writer.exec("ALTER TABLE novel_books RENAME TO fixture_books;CREATE VIEW novel_books AS SELECT * FROM fixture_books")],
    ["quoted-declaration", target => rebuild(target, "novel_books", sql => sql.replace("author TEXT", '"author" TEXT'))]
  ]) {
    const target = pair(label); seed(target, 20); mutate(target); noQualifiedAuthor(target, label);
  }
  const amplified = pair("legacy-join-affinity"); seed(amplified, 8);
  rebuild(amplified, "novel_reading_state", sql => sql.replace("book_id TEXT PRIMARY KEY,", "book_id TEXT COLLATE NOCASE,").replace(/\)$/u, ", PRIMARY KEY(book_id COLLATE BINARY))"));
  amplified.writer.exec("DELETE FROM novel_reading_state;DELETE FROM novel_books");
  book(amplified.writer, "a", 1); book(amplified.writer, "A", 2);
  amplified.writer.exec("INSERT INTO novel_reading_state(book_id,updated_at) VALUES('a','same'),('A','same')");
  const fanout = compare(amplified, { author: "Writer", limit: "8", sort: "title" }, "legacy left-side NOCASE join amplification");
  assert.equal(fanout.total, 2); assert.equal(fanout.books.length, 4);
  noQualifiedAuthor(amplified, "legacy join amplification must retain old SQL");
  for (const table of ["novel_books", "novel_reading_state"]) {
    const target = pair("temp-" + table); seed(target);
    const setup = database => database.exec(`CREATE TEMP VIEW ${table} AS SELECT * FROM main.${table}`);
    readerSetup = setup; const old = target.previous.listBooks(url({ author: "Writer", limit: "8" }));
    readerSetup = setup; const next = measure(target.current, { author: "Writer", limit: "8" });
    assert.deepEqual(next.result, old); assert(!next.sql.includes("b.author COLLATE BINARY <> ''")); responses++;
  }
}
function verifyErrorsAndWal() {
  const target = pair("errors"); seed(target);
  for (const phase of ["prepare", "all"]) {
    const expected = compare(target, { author: "Writer", limit: "8" });
    fault = { phase, matches: isProof, error: new Error("synthetic capability failure") };
    assert.deepEqual(target.current.listBooks(url({ author: "Writer", limit: "8" })), expected, "capability failure retains original successful SQL");
    assert.equal(fault, null); responses++;
  }
  for (const [phase, matches] of [["prepare", isPage], ["all", isPage], ["get", isCount]]) {
    const invoke = owner => { fault = { phase, matches, error: new Error("synthetic native failure") }; return owner.listBooks(url({ author: "Writer", limit: "8" })); };
    sameError(() => invoke(target.previous), () => invoke(target.current), "original SQL " + phase); assert.equal(fault, null);
  }
  target.writer.exec("DELETE FROM novel_reading_state");
  target.writer.prepare("UPDATE novel_books SET mtime_ms=? WHERE id='b1'").run(9223372036854775807n);
  sameError(() => target.previous.listBooks(url({ author: "Writer", sort: "title", limit: "1" })),
    () => target.current.listBooks(url({ author: "Writer", sort: "title", limit: "1" })), "selected unsafe INTEGER preserves native decode failure");
  compare(target, { author: "Writer", sort: "title", limit: "1", offset: "1" }, "unselected unsafe column remains undecoded");
  target.writer.prepare("UPDATE novel_books SET mtime_ms=1 WHERE id='b1'").run();
  const params = { author: "Writer", sort: "updated", limit: "8" };
  const old = target.previous.listBooks(url(params));
  afterProof = () => target.writer.exec("BEGIN;UPDATE novel_books SET title='External WAL value' WHERE id='b31';CREATE INDEX fixture_external ON novel_books(category);COMMIT");
  const during = target.current.listBooks(url(params)); assert.equal(afterProof, null);
  assert.deepEqual({ ...during, listRevision: null }, { ...old, listRevision: null }, "qualification and page share the old WAL snapshot");
  assert.notEqual(during.listRevision, old.listRevision, "after-commit storage mismatch produces an unstable revision"); responses++;
  noQualifiedAuthor(target, "external index is seen next request", params);
  assert(target.current.listBooks(url(params)).books.some(row => row.title === "External WAL value"));
  const missing = pair("native-missing-column"); seed(missing);
  missing.writer.exec("ALTER TABLE novel_books RENAME COLUMN status TO statusTEXT");
  sameError(() => missing.previous.listBooks(url(params)), () => missing.current.listBooks(url(params)), "legacy statusTEXT preserves missing status SQL error");
  const missingState = pair("native-missing-state"); seed(missingState);
  missingState.writer.exec("DROP TABLE novel_reading_state");
  sameError(() => missingState.previous.listBooks(url(params)), () => missingState.current.listBooks(url(params)), "missing state preserves native prepare error");
}
const normalized = value => JSON.parse(JSON.stringify(value, (key, entry) => key === "sourceRealm" ? "server:fixture" : key === "listRevision" ? "revision" : key === "dbPath" ? "fixture.sqlite" : entry));
const median = values => values.toSorted((a, b) => a - b)[Math.floor(values.length / 2)];
function verifyScale() {
  const indexed = pair("scale-indexed"), baseline = pair("scale-noindex", withoutIndexFactory);
  const insertTimes = [];
  for (const target of [baseline, indexed]) {
    const start = performance.now(); target.writer.exec("BEGIN");
    const statement = target.writer.prepare(`INSERT INTO novel_books(id,title,author,category,source_root,source_path,relative_path,file_name,
      size_bytes,char_count,chapter_count,status,updated_at) VALUES(?,?,?,'分类','synthetic',?,?,?,100,200,8,'ok',?)`);
    for (let index = 0; index < 100000; index++) {
      const id = "b" + index;
      statement.run(id, "Book " + String(index).padStart(6, "0"), index < 10 ? "Sparse" : index < 1010 ? "Common" : "Other",
        "synthetic://" + id, id, id + ".txt", new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString());
    }
    target.writer.exec("COMMIT"); insertTimes.push(performance.now() - start); target.current.summary();
  }
  for (const author of ["Sparse", "Common"]) for (const offset of ["0", "5"]) {
    const params = { author, limit: "40", offset, sort: "updated" };
    const old = measure(baseline.current, params, true), next = measure(indexed.current, params, true);
    assert.deepEqual(normalized(next.result), normalized(old.result), "same full response with only the optional index disabled"); responses++;
    const oldMs = [], newMs = [];
    for (let round = 0; round < 5; round++) {
      const run = (owner, times) => { const start = performance.now(); owner.listBooks(url(params)); times.push(performance.now() - start); };
      if (round % 2) { run(indexed.current, newMs); run(baseline.current, oldMs); } else { run(baseline.current, oldMs); run(indexed.current, newMs); }
    }
    measurements.push({ author, offset, before: { countVisits: old.countVisits, pageVisits: old.pageVisits, plan: old.plan },
      after: { countVisits: next.countVisits, pageVisits: next.pageVisits, plan: next.plan, probes: next.probes },
      diagnosticMs: { before: median(oldMs), after: median(newMs) }, oldMs, newMs });
  }
  const writes = [];
  for (const target of [baseline, indexed]) {
    const update = target.writer.prepare("UPDATE novel_books SET title=?,updated_at=? WHERE id=?");
    const upsert = target.writer.prepare(`INSERT INTO novel_books(id,title,author,category,source_root,source_path,relative_path,file_name,
      size_bytes,char_count,chapter_count,status,updated_at) VALUES(?,?,?,'分类','synthetic',?,?,?,100,200,8,'ok',?)
      ON CONFLICT(id) DO UPDATE SET title=excluded.title,author=excluded.author,updated_at=excluded.updated_at`);
    const remove = target.writer.prepare("DELETE FROM novel_books WHERE id=?");
    const phases = {};
    for (const kind of ["update", "upsert", "rescan"]) {
      const times = [];
      for (let round = 0; round < 5; round++) {
        const start = performance.now(); target.writer.exec("BEGIN");
        for (let index = 0; index < 2000; index++) {
          const id = "b" + index, title = kind + " " + round + "/" + index;
          if (kind === "update") update.run(title, "write-" + round, id);
          else {
            if (kind === "rescan") remove.run(id);
            upsert.run(id, title, index < 10 ? "Sparse" : index < 1010 ? "Common" : "Other", "synthetic://" + id, id, id + ".txt", "write-" + round);
          }
        }
        target.writer.exec("COMMIT"); times.push(performance.now() - start);
      }
      phases[kind] = median(times);
    }
    writes.push(phases);
  }
  const pageSize = baseline.writer.prepare("PRAGMA page_size").get().page_size;
  const beforePages = baseline.writer.prepare("PRAGMA page_count").get().page_count;
  const beforeFree = baseline.writer.prepare("PRAGMA freelist_count").get().freelist_count;
  const installation = /const AUTHOR_INDEX_SQL = `([\s\S]*?)`;/u.exec(currentSource)[1];
  const buildStart = performance.now(); baseline.writer.exec(installation); const buildMs = performance.now() - buildStart;
  const indexBytes = (baseline.writer.prepare("PRAGMA page_count").get().page_count - beforePages
    + beforeFree - baseline.writer.prepare("PRAGMA freelist_count").get().freelist_count) * pageSize;
  console.log(JSON.stringify({ insert100kMs: { baseline: insertTimes[0], indexed: insertTimes[1] }, write2000MedianMs: { baseline: writes[0], indexed: writes[1] }, indexBytes, buildMs, measurements }, null, 2));
  // Keep performance gates after the complete response/error/policy contracts.
  for (const result of measurements) {
    const count = result.author === "Sparse" ? 10 : 1000;
    assert.equal(result.after.probes, 1, "one live author capability query per request");
    assert.equal(result.after.countVisits, count, "author count visits only its indexed candidate range");
    assert(result.after.pageVisits <= 40 + Number(result.offset), "page visits only the requested author prefix");
    assert(result.after.plan.some(line => line.includes("SEARCH b USING INDEX idx_novel_books_author_updated")), "real page searches the expression index");
    assert(!result.after.plan.some(line => line.includes("TEMP B-TREE")), "updated author page needs no temporary sort");
  }
}
try {
  verifyResponses(); verifyLegacy(); verifyErrorsAndWal();
  console.log(`Novel author index contracts: ${responses} complete DTO/wire comparisons, ${policyChecks} explicit rowid-policy cases, ${errors} original errors PASS.`);
  verifyScale();
  console.log("Novel author index native candidate/ordering budgets PASS.");
} finally {
  DatabaseSync.prototype.prepare = nativePrepare;
  for (const target of pairs) { target.current.invalidate(); target.previous.invalidate(); target.writer.close(); }
  temporary.cleanup();
}
