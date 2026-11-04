import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { DatabaseSync, StatementSync } from "node:sqlite";
import { createMangaDatabaseReader } from "../src/modules/photos/server/manga-database.js";

// The complete preceding reader is immutable. The comparison never restores
// old row values or rewrites the SQL; only statement compilation is optimized.
const baseline = fs.readFileSync(new URL("./fixtures/manga-comic-reader-before-cache.txt", import.meta.url), "utf8").replaceAll("\r\n", "\n");
assert.equal(createHash("sha256").update(baseline).digest("hex"), "9048fedabc06e2c6049a1747fdb1cd654844e6478604eccd2b07b4b6231cc8ea");
const previousFactory = (await import("data:text/javascript;base64," + Buffer.from(baseline).toString("base64"))).createMangaDatabaseReader;
assert(process.argv.slice(2).every(value => value === "--legacy-comic-statements"));
const factory = process.argv.includes("--legacy-comic-statements") ? previousFactory : createMangaDatabaseReader;
const collector = fs.readFileSync(new URL("../tools/manga_collector.py", import.meta.url), "utf8");
const schema = /    schema = """([\s\S]*?)    """/u.exec(collector)?.[1];
assert(schema?.includes("CREATE TABLE IF NOT EXISTS manga_comics"), "use the actual collector schema");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "fanhao-manga-comic-statements-"));
const files = new Set(), handles = new Set(), statementSql = new WeakMap(), stats = new Map();
const originals = { prepare: DatabaseSync.prototype.prepare, get: StatementSync.prototype.get, stat: fs.statSync };
const comicSql = "SELECT * FROM manga_comics WHERE cache_key = ?";
let opening = null, fault = null, measured = null, comparisons = 0;
function counters(db) {
  if (!stats.has(db)) stats.set(db, { comicPrepares: 0, comicReads: 0, imagePrepares: 0 });
  return stats.get(db);
}
DatabaseSync.prototype.prepare = function (sql, ...args) {
  handles.add(this); if (opening) opening.db = this;
  const count = counters(this);
  if (sql === comicSql) {
    count.comicPrepares++;
    if (measured?.db === this) measured.prepares++;
    if (fault?.db === this && fault.phase === "prepare") { fault.reached = true; throw fault.error; }
  }
  if (sql.includes("FROM manga_images") && sql.includes("LIMIT 1")) count.imagePrepares++;
  const statement = originals.prepare.call(this, sql, ...args); statementSql.set(statement, { db: this, sql }); return statement;
};
StatementSync.prototype.get = function (...args) {
  const owner = statementSql.get(this);
  if (owner?.sql === comicSql) {
    counters(owner.db).comicReads++;
    if (measured?.db === owner.db) measured.reads++;
    if (fault?.db === owner.db && fault.phase === "get") { fault.reached = true; throw fault.error; }
  }
  return originals.get.apply(this, args);
};
fs.statSync = function (file, ...args) {
  if (measured && file === measured.file) measured.sourceChecks++;
  return originals.stat.call(this, file, ...args);
};
function database(name, legacy = false) {
  const file = path.join(root, name + ".sqlite"); files.add(file);
  const writer = new DatabaseSync(file); handles.add(writer);
  writer.exec("PRAGMA journal_mode=WAL");
  writer.exec(legacy ? schema.replace("cache_key TEXT PRIMARY KEY", "cache_key TEXT COLLATE NOCASE") : schema);
  // Older databases may lack the parent's unique constraint. Keep their rows
  // readable without requiring the current collector's child FK to be valid.
  if (legacy) writer.exec("PRAGMA foreign_keys=OFF");
  return { file, writer };
}
function add(db, key, title) {
  db.prepare("INSERT INTO manga_comics(cache_key,dir_name,site,title,source_url) VALUES(?,?,'synthetic',?,?)")
    .run(key, "synthetic", title, "https://synthetic.invalid/" + title);
}
function owner(create, file) {
  const result = { reader: create({ dbPath: file }), db: null, file };
  opening = result;
  try { assert(result.reader.lookupStamp()); } finally { opening = null; }
  assert(result.db); return result;
}
function pair(file) { return { previous: owner(previousFactory, file), current: owner(factory, file) }; }
function compare(pair, key) {
  const expected = pair.previous.reader.comic(key), actual = pair.current.reader.comic(key);
  assert.deepEqual(actual, expected, "complete preceding native comic row or null fallback");
  assert.equal(JSON.stringify(actual), JSON.stringify(expected)); comparisons++; return actual;
}
function measure(owner, keys) {
  measured = { db: owner.db, file: owner.file, prepares: 0, reads: 0, sourceChecks: 0 };
  try { for (const key of keys) assert(owner.reader.comic(key)); return { ...measured, db: undefined, file: undefined }; }
  finally { measured = null; }
}
let metrics;
try {
  const large = database("scale");
  for (let index = 0; index < 200; index++) add(large.writer, "key-" + index, "title-" + index);
  const scale = pair(large.file), keys = Array.from({ length: 600 }, (_, index) => "key-" + index % 200);
  metrics = { previous: measure(scale.previous, keys), current: measure(scale.current, keys) };
  for (const key of ["key-0", "key-199", "missing", "", null, 0, NaN, [], Symbol("synthetic")]) compare(scale, key);
  const first = compare(scale, "key-0"), second = compare(scale, "key-0");
  assert.notStrictEqual(first, second, "reuse the statement, never its returned row object");
  first.title = "caller mutation"; assert.equal(compare(scale, "key-0").title, "title-0");
  large.writer.prepare("UPDATE manga_comics SET title='WAL published' WHERE cache_key='key-0'").run();
  assert.equal(compare(scale, "key-0").title, "WAL published", "each execution sees external WAL commits");
  large.writer.exec("ALTER TABLE manga_comics ADD COLUMN fixture_extra TEXT DEFAULT 'new column'");
  assert.equal(compare(scale, "key-0").fixture_extra, "new column", "SELECT * recompiles after external schema publication");
  large.writer.exec("ALTER TABLE manga_comics RENAME COLUMN title TO original_title");
  assert.equal(compare(scale, "key-0").original_title, "WAL published");
  large.writer.exec("ALTER TABLE manga_comics RENAME COLUMN original_title TO title");
  compare(scale, "key-0");
  large.writer.exec("UPDATE manga_comics SET image_count=9223372036854775807 WHERE cache_key='key-0'");
  assert.equal(compare(scale, "key-0"), null, "native unsafe integer decoding keeps the established fallback");
  const failedPrepares = counters(scale.current.db).comicPrepares;
  large.writer.exec("UPDATE manga_comics SET image_count=1 WHERE cache_key='key-0'");
  assert(compare(scale, "key-0"));
  assert.equal(counters(scale.current.db).comicPrepares, failedPrepares + 1, "a native execution failure discards only this cached statement");

  for (const phase of ["prepare", "get"]) {
    const native = database("failure-" + phase); add(native.writer, "key", "recoverable");
    native.writer.prepare("INSERT INTO manga_chapters(cache_key,chapter_index,title) VALUES('key',1,'chapter')").run();
    native.writer.prepare("INSERT INTO manga_images(cache_key,chapter_index,image_index,local_path) VALUES('key',1,1,'synthetic.png')").run();
    const readers = pair(native.file);
    for (const reader of Object.values(readers)) {
      assert(reader.reader.firstImage("key"));
      if (phase === "get") assert(reader.reader.comic("key"));
      const imagePrepares = counters(reader.db).imagePrepares;
      const error = Object.assign(new Error("controlled comic " + phase), { code: "SQLITE_BUSY" });
      fault = { db: reader.db, phase, error, reached: false };
      assert.equal(reader.reader.comic("key"), null); assert(fault.reached); fault = null;
      const prepares = counters(reader.db).comicPrepares;
      assert.equal(reader.reader.comic("key").title, "recoverable");
      assert.equal(counters(reader.db).comicPrepares, prepares + 1, "same-owner retry compiles a fresh comic statement");
      assert(reader.reader.firstImage("key"));
      assert.equal(counters(reader.db).imagePrepares, imagePrepares, "comic errors leave the independent firstImage statement intact");
    }
    compare(readers, "key");
  }
  large.writer.exec("DROP TABLE manga_comics");
  assert.equal(compare(scale, "key-0"), null, "a cached statement cannot return rows from a dropped table");
  large.writer.exec(schema); add(large.writer, "key-0", "restored table");
  assert.equal(compare(scale, "key-0").title, "restored table");

  const duplicate = database("legacy-duplicates", true); add(duplicate.writer, "Key", "first"); add(duplicate.writer, "key", "second");
  const legacy = pair(duplicate.file);
  assert.equal(compare(legacy, "KEY").title, "first", "preserve the original SQL comparison and legacy first-row behavior");
  duplicate.writer.prepare("DELETE FROM manga_comics WHERE title='first'").run();
  assert.equal(compare(legacy, "KEY").title, "second");

  const original = database("replacement"); add(original.writer, "key", "before replacement");
  original.writer.close();
  const fixed = new Date("2026-01-01T00:00:00.000Z"); fs.utimesSync(original.file, fixed, fixed);
  const replacement = database("next-file"); add(replacement.writer, "key", "after replacement"); replacement.writer.close();
  fs.utimesSync(replacement.file, fixed, fixed);
  const replacing = pair(original.file); compare(replacing, "key");
  const oldIdentity = fs.statSync(original.file, { bigint: true });
  // Windows cannot rename SQLite's live handles. Close only captured fixture
  // connections; keep the owners and their prepared statement fields intact.
  for (const reader of Object.values(replacing)) reader.db.close();
  const retired = path.join(root, "retired.sqlite"); files.add(retired);
  for (const file of [retired, original.file, replacement.file]) assert.equal(path.dirname(path.resolve(file)), path.resolve(root));
  fs.renameSync(original.file, retired); fs.renameSync(replacement.file, original.file);
  const newIdentity = fs.statSync(original.file, { bigint: true });
  assert.equal(newIdentity.mtimeNs, oldIdentity.mtimeNs); assert.notEqual(newIdentity.ino, oldIdentity.ino);
  assert.equal(compare(replacing, "key").title, "after replacement", "a new file uses a new connection and statement");
  const missing = database("disappearing"); add(missing.writer, "key", "returns later"); missing.writer.close();
  const missingReaders = pair(missing.file); compare(missingReaders, "key");
  for (const reader of Object.values(missingReaders)) reader.db.close();
  const away = path.join(root, "away.sqlite"); files.add(away);
  for (const file of [missing.file, away]) assert.equal(path.dirname(path.resolve(file)), path.resolve(root));
  fs.renameSync(missing.file, away); assert.equal(compare(missingReaders, "key"), null);
  fs.renameSync(away, missing.file); assert.equal(compare(missingReaders, "key").title, "returns later");
  console.log(JSON.stringify({ ok: true, comparisons, nativeWal: true, externalSchema: true, failureRetry: true,
    sameMtimeReplacement: true, legacyDuplicateKeys: true, statementOnly: true, metrics }));
  assert.equal(metrics.previous.prepares, 600);
  assert.equal(metrics.current.reads, metrics.previous.reads, "every requested row still executes native SQL");
  assert.equal(metrics.current.sourceChecks, metrics.previous.sourceChecks, "every reader call retains its file-identity probe");
  assert.equal(metrics.current.sourceChecks, 600);
  assert.equal(metrics.current.prepares, 1, "comic compilation is reused within its owning native connection");
} finally {
  fault = null; measured = null; opening = null;
  DatabaseSync.prototype.prepare = originals.prepare; StatementSync.prototype.get = originals.get; fs.statSync = originals.stat;
  for (const db of handles) try { db.close(); } catch {}
  assert.equal(path.dirname(fs.realpathSync(root)), fs.realpathSync(os.tmpdir()));
  for (const file of files) for (const suffix of ["", "-wal", "-shm"]) {
    const owned = path.resolve(file + suffix); assert.equal(path.dirname(owned), path.resolve(root));
    if (fs.existsSync(owned)) fs.unlinkSync(owned);
  }
  fs.rmdirSync(root);
}
