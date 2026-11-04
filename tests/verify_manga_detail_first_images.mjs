import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { DatabaseSync, StatementSync } from "node:sqlite";
import { createMangaDatabaseReader } from "../src/modules/photos/server/manga-database.js";
import { createMangaService } from "../src/modules/photos/server/manga-service.js";

// Complete immutable owners supply the output oracle. Work budgets separately
// disable only this round's bulk call, retaining the preceding file/SQL caches.
const commit = "63c5fab243233e142cfd62c4eaf13812feb92405";
const owners = {
  "manga-database.js": "9048fedabc06e2c6049a1747fdb1cd654844e6478604eccd2b07b4b6231cc8ea",
  "manga-service.js": "65e5381e9df135c560058e770fc9435c2918fc6c888fc4b3aa0bae4d703df4d4"
};
const sourceUrl = new URL("../src/modules/photos/server/manga-service.js", import.meta.url);
const currentSource = fs.readFileSync(sourceUrl, "utf8").replaceAll("\r\n", "\n");
const dataUrl = text => "data:text/javascript;base64," + Buffer.from(text).toString("base64");
const frozen = {};
for (const [name, hash] of Object.entries(owners)) {
  frozen[name] = execFileSync("git", ["show", `${commit}:src/modules/photos/server/${name}`], { encoding: "utf8", cwd: new URL("..", import.meta.url) }).replaceAll("\r\n", "\n");
  assert.equal(createHash("sha256").update(frozen[name]).digest("hex"), hash);
}
async function serviceFactory(source, readerUrl = new URL("./manga-database.js", sourceUrl).href) {
  return (await import(dataUrl(source.replace(/from "(\.\.?\/[^"\n]+)"/gu, (_, relative) => "from " + JSON.stringify(
    relative === "./manga-database.js" ? readerUrl : new URL(relative, sourceUrl).href))))).createMangaService;
}
const oldReaderFactory = (await import(dataUrl(frozen["manga-database.js"]))).createMangaDatabaseReader;
const oldFactory = await serviceFactory(frozen["manga-service.js"], dataUrl(frozen["manga-database.js"]));
const bulkCall = "      const covers = database.detailFirstImages(databaseKey(cacheDir), chapters.map(chapter => chapter.index));";
assert.equal(currentSource.split(bulkCall).length, 2);
const disabledSource = currentSource.replace(bulkCall, "      const covers = null;");
assert.equal(disabledSource.replace("      const covers = null;", bulkCall), currentSource);
const disabledFactory = await serviceFactory(disabledSource);
assert(process.argv.slice(2).every(value => value === "--legacy-detail-first-images"));
const testedFactory = process.argv.includes("--legacy-detail-first-images") ? disabledFactory : createMangaService;
const collector = fs.readFileSync(new URL("../tools/manga_collector.py", import.meta.url), "utf8").replaceAll("\r\n", "\n");
const schema = /    schema = """([\s\S]*?)    """/u.exec(collector)?.[1];
assert(schema?.includes("CREATE TABLE IF NOT EXISTS manga_images"));

const root = fs.mkdtempSync(path.join(os.tmpdir(), "fanhao-manga-detail-first-"));
const files = new Set(), directories = new Set([root]), handles = new Set(), statements = new WeakMap();
const native = { prepare: DatabaseSync.prototype.prepare, get: StatementSync.prototype.get, all: StatementSync.prototype.all, stat: fs.statSync };
let measuring = null, opening = null, fault = null, afterRead = null, comparisons = 0;
let latestBulk = null;
const kindOf = sql => sql.includes("__detail_eligible") ? "bulk"
  : sql.includes("FROM manga_images WHERE cache_key") && sql.includes("chapter_index = ?") && sql.includes("LIMIT 1") ? "point"
  : sql.includes("FROM manga_chapters WHERE cache_key") ? "chapters" : "other";
DatabaseSync.prototype.prepare = function (sql, ...args) {
  handles.add(this);
  if (opening && sql.includes("FROM sqlite_master")) opening.db = this;
  const kind = kindOf(sql);
  if (measuring && /^(?:SELECT|WITH)\b/iu.test(sql.trim())) measuring.prepares++;
  if (fault?.phase === "prepare" && fault.kind === kind) { fault.reached++; throw fault.error; }
  const statement = native.prepare.call(this, sql, ...args);
  statements.set(statement, { sql, kind, db: this }); return statement;
};
for (const method of ["get", "all"]) StatementSync.prototype[method] = function (...args) {
  const owner = statements.get(this) || { sql: "", kind: "other" };
  const counted = measuring && /^(?:SELECT|WITH)\b/iu.test(owner.sql.trim());
  if (counted) { measuring.reads++; measuring[owner.kind]++; }
  if (fault?.phase === method && fault.kind === owner.kind) { fault.reached++; throw fault.error; }
  const result = native[method].call(this, ...args);
  if (owner.kind === "bulk") latestBulk = { sql: owner.sql, args, db: owner.db };
  if (counted) {
    const rows = method === "all" ? result : result ? [result] : [];
    measuring.rows += rows.length;
  }
  if (afterRead?.kind === owner.kind) { const action = afterRead; afterRead = null; action.run(owner, result); }
  return result;
};
fs.statSync = function (file, ...args) {
  if (measuring && typeof file === "string" && file.startsWith(root + path.sep)) measuring.stats++;
  return native.stat.call(this, file, ...args);
};
const observed = { prepare: DatabaseSync.prototype.prepare, get: StatementSync.prototype.get, all: StatementSync.prototype.all, stat: fs.statSync };
function uninstrumented(run) {
  DatabaseSync.prototype.prepare = native.prepare; StatementSync.prototype.get = native.get; StatementSync.prototype.all = native.all; fs.statSync = native.stat;
  try { return run(); }
  finally { DatabaseSync.prototype.prepare = observed.prepare; StatementSync.prototype.get = observed.get; StatementSync.prototype.all = observed.all; fs.statSync = observed.stat; }
}
function mkdir(directory) { fs.mkdirSync(directory); directories.add(directory); return directory; }
function write(file, value) { fs.writeFileSync(file, value); files.add(file); }
function fixture(name, transform = text => text, { wal = false } = {}) {
  const directory = mkdir(path.join(root, name)), file = path.join(directory, "private.sqlite"); files.add(file);
  const db = new DatabaseSync(file); handles.add(db);
  if (wal) db.exec("PRAGMA journal_mode=WAL");
  db.exec(transform(schema));
  const cacheDir = mkdir(path.join(directory, "smtt6_cache_fixture"));
  write(path.join(cacheDir, "catalog.json"), JSON.stringify({ title: "Catalog", url: "https://fixture.invalid/manga" }));
  write(path.join(cacheDir, "catalog.html"), '<div class="sp-book-tags"><a>剧情</a></div>');
  write(path.join(cacheDir, "manifest.json"), JSON.stringify({ chapters: [{ index: 9, title: "Manifest chapter", images: [] }] }));
  db.prepare("INSERT INTO manga_comics(cache_key,dir_name,site,title,source_url,author,cover_url,created_at) VALUES(?,?,'smtt6','Synthetic manga','https://fixture.invalid/manga','Synthetic author','https://fixture.invalid/cover','2026-01-01')")
    .run(cacheDir, path.basename(cacheDir));
  return { directory, file, db, cacheDir };
}
function addChapter(f, index, images = 3) {
  f.db.prepare("INSERT INTO manga_chapters(cache_key,chapter_index,title,slug,image_count,downloaded_count,status) VALUES(?,?,?, ?,?,?,'done')")
    .run(f.cacheDir, index, `Chapter ${index}`, `chapter-${index}`, images, images);
  const insert = f.db.prepare("INSERT INTO manga_images(cache_key,chapter_index,image_index,local_path,bytes,status) VALUES(?,?,?,?,24,'downloaded')");
  for (let image = 1; image <= images; image++) insert.run(f.cacheDir, index, image, image === 1 ? "" : `private-${index}-${image}.png`);
}
function service(f, create = createMangaService) {
  return { api: create({ root: f.directory, databasePath: f.file, mimeTypes: {}, normalizeExt: path.extname,
    safeStat(file) { try { return fs.statSync(file); } catch { return null; } }, spawnProcess() { assert.fail("no collector or real media"); } }), db: null };
}
function detail(owner, f) { opening = owner; try { return owner.api.publicDetail(f.cacheDir); } finally { opening = null; } }
function equal(actual, expected, label) {
  assert.deepEqual(actual, expected, label); assert.equal(JSON.stringify(actual), JSON.stringify(expected), label + " wire/field order"); comparisons++;
}
function compare(f, label = "complete frozen detail") {
  const actual = service(f), previous = service(f, oldFactory);
  equal(detail(actual, f), detail(previous, f), label); return { actual, previous };
}
function reader(f, create = createMangaDatabaseReader) {
  const owner = { reader: create({ dbPath: f.file }), db: null }; opening = owner;
  try { assert(owner.reader.status().available); } finally { opening = null; }
  assert(owner.db); return owner;
}
function sample(run) {
  measuring = { prepares: 0, reads: 0, bulk: 0, point: 0, chapters: 0, other: 0, rows: 0, stats: 0 };
  try { const value = run(); return { value, counts: { ...measuring } }; } finally { measuring = null; }
}

let scale;
try {
  verifyHealthyAndInputs();
  verifyNativeFailuresAndFallback();
  verifyLegacySchemas();
  verifyTempShadowAndTransactions();
  verifyPublicationAndIdentity();
  scale = verifyScale();
  console.log(JSON.stringify({ ok: true, comparisons, scale,
    scope: "complete frozen owners; actual native SQLite/collector schema; synthetic metadata only; timings exclude instrumentation" }, null, 2));
  assert.equal(scale.current.point, 0, "healthy detail avoids per-chapter firstImage reads");
  assert.equal(scale.current.reads, 4);
  assert.equal(scale.current.prepares, 2);
  assert.equal(scale.current.stats, 6);
  assert.equal(scale.current.rows, scale.previous.rows, "batching preserves returned chapter/first-image row count");
  assert.equal(scale.current.bulk, 1, "one native bulk read for the complete directory");
} finally {
  measuring = opening = fault = afterRead = null;
  DatabaseSync.prototype.prepare = native.prepare; StatementSync.prototype.get = native.get; StatementSync.prototype.all = native.all; fs.statSync = native.stat;
  for (const db of handles) try { db.close(); } catch {}
  assert.equal(path.dirname(fs.realpathSync(root)), fs.realpathSync(os.tmpdir()));
  for (const file of files) {
    assert(path.resolve(file).startsWith(path.resolve(root) + path.sep));
    for (const suffix of ["", "-wal", "-shm", "-journal"]) if (fs.existsSync(file + suffix)) fs.unlinkSync(file + suffix);
  }
  for (const directory of [...directories].sort((a, b) => b.length - a.length)) fs.rmdirSync(directory);
}

function verifyHealthyAndInputs() {
  const f = fixture("healthy");
  f.db.exec("BEGIN"); for (const index of [-1, 0, 1.5, 2, 7]) addChapter(f, index); f.db.exec("COMMIT");
  compare(f);
  const current = reader(f), previous = reader(f, oldReaderFactory);
  const source = fs.readFileSync(new URL("../src/modules/photos/server/manga-database.js", import.meta.url), "utf8");
  const expectedDdl = /const MANGA_IMAGES_TABLE_SQL = `([\s\S]*?)`;/u.exec(source)?.[1].replaceAll("\r\n", "\n");
  assert.equal(f.db.prepare("SELECT sql FROM sqlite_schema WHERE name='manga_images'").get().sql.replaceAll("\r\n", "\n"), expectedDdl, "actual producer DDL enters the fast path");
  for (const indexes of [[2, -1, 0, 1.5, 7, 99, 2], [0], [99]]) {
    const rows = current.reader.detailFirstImages(f.cacheDir, indexes);
    assert(Array.isArray(rows)); equal(rows, indexes.map(index => previous.reader.firstImage(f.cacheDir, index)), "aligned complete native rows, including duplicates and missing covers");
    assert(rows.every(row => !row || Object.keys(row).every(key => !key.startsWith("__detail_"))));
  }
  for (const indexes of [[], Array(10001).fill(2), [NaN], [Infinity], ["2"], [null]]) assert.equal(current.reader.detailFirstImages(f.cacheDir, indexes), null);
  assert.equal(current.reader.detailFirstImages({ toString() { assert.fail("unsupported keys must not be coerced"); } }, [2]), null);
  const empty = fixture("empty"); compare(empty, "zero DB chapters keep the manifest fallback");
  for (const [index, value] of [[-1, null], [0, " "], [1.5, 0], [2, new Uint8Array()], [7, "with\0nul"]]) {
    f.db.prepare("UPDATE manga_images SET local_path=? WHERE cache_key=? AND chapter_index=? AND image_index=2").run(value, f.cacheDir, index);
  }
  compare(f, "original SQL local-path truth semantics");
  f.db.exec("UPDATE manga_images SET rowid=9223372036854775807 WHERE chapter_index=7 AND image_index=2");
  compare(f, "unsafe physical rowid stays inside SQLite rather than crossing the native bridge");

  const typed = fixture("typed-chapters", sql => sql.replace("CREATE TABLE IF NOT EXISTS manga_chapters (\n        cache_key TEXT NOT NULL,\n        chapter_index INTEGER NOT NULL", "CREATE TABLE IF NOT EXISTS manga_chapters (\n        cache_key TEXT NOT NULL,\n        chapter_index TEXT NOT NULL"));
  typed.db.exec("PRAGMA foreign_keys=OFF");
  addChapter(typed, "01"); addChapter(typed, "2.0"); addChapter(typed, new Uint8Array([51]));
  typed.db.prepare("INSERT INTO manga_images(cache_key,chapter_index,image_index,local_path) VALUES(?,51,8,'numeric-request.png')").run(typed.cacheDir);
  const typedOwner = compare(typed, "detail requests the converted Number chapter indexes, not their raw storage values").actual;
  assert.equal(sample(() => detail(typedOwner, typed)).counts.bulk, 1, "only the images table needs canonical eligibility");
  assert(latestBulk.args.slice(2).every(index => typeof index === "number"));
  addChapter(typed, "not-a-number");
  compare(typed, "non-finite converted chapter index retains per-chapter fallback");
  assert.equal(sample(() => detail(typedOwner, typed)).counts.bulk, 0);
}

function verifyNativeFailuresAndFallback() {
  const f = fixture("native-failures"); for (let index = 1; index <= 3; index++) addChapter(f, index);
  for (const phase of ["prepare", "all"]) {
    const owner = service(f), expected = detail(service(f, oldFactory), f);
    fault = { kind: "bulk", phase, error: new Error(`controlled bulk ${phase}`), reached: 0 };
    try { equal(detail(owner, f), expected, `bulk ${phase} failure retries the old per-chapter boundary`); assert.equal(fault.reached, 1); }
    finally { fault = null; }
    assert.equal(sample(() => detail(owner, f)).counts.bulk, 1, "batch failure is not negatively cached");
  }
  f.db.exec("UPDATE manga_images SET bytes=9223372036854775807 WHERE chapter_index=2 AND image_index=2");
  const failed = compare(f, "one unsafe selected row keeps the other chapters' covers");
  const dto = detail(failed.actual, f);
  assert(dto.chapters[0].coverUrl); assert.equal(dto.chapters[1].coverUrl, ""); assert(dto.chapters[2].coverUrl);
  assert.equal(sample(() => detail(failed.actual, f)).counts.point, 3, "native bulk decode failure falls back per chapter");
  f.db.exec("UPDATE manga_images SET bytes=24 WHERE chapter_index=2 AND image_index=2");
  f.db.exec("UPDATE manga_images SET bytes=9223372036854775807 WHERE chapter_index=2 AND image_index=3");
  compare(f, "an unselected bad image is never decoded");
  assert.equal(sample(() => detail(failed.actual, f)).counts.bulk, 1);
  assert.equal(sample(() => detail(failed.actual, f)).counts.point, 0);
}

function verifyLegacySchemas() {
  for (const [name, transform] of [
    ["extra-column", sql => sql.replace("error TEXT,\n        PRIMARY KEY (cache_key, chapter_index, image_index)", "error TEXT,\n        extra INTEGER,\n        PRIMARY KEY (cache_key, chapter_index, image_index)")],
    ["missing-column", sql => sql.replace("        downloaded_url TEXT,\n", "")],
    ["nocase", sql => sql.replace("CREATE TABLE IF NOT EXISTS manga_images (\n        cache_key TEXT NOT NULL", "CREATE TABLE IF NOT EXISTS manga_images (\n        cache_key TEXT COLLATE NOCASE NOT NULL")],
    ["nocase-binary-pk", sql => sql.replace("CREATE TABLE IF NOT EXISTS manga_images (\n        cache_key TEXT NOT NULL", "CREATE TABLE IF NOT EXISTS manga_images (\n        cache_key TEXT COLLATE NOCASE NOT NULL")
      .replace("PRIMARY KEY (cache_key, chapter_index, image_index)", "PRIMARY KEY (cache_key COLLATE BINARY, chapter_index, image_index)")],
    ["nonunique", sql => sql.replace("        PRIMARY KEY (cache_key, chapter_index, image_index),\n", "")]
  ]) {
    const f = fixture(name, transform); addChapter(f, 1); addChapter(f, 2);
    if (name === "nonunique") f.db.prepare("INSERT INTO manga_images(cache_key,chapter_index,image_index,local_path) VALUES(?,1,2,'duplicate.png')").run(f.cacheDir);
    if (name === "nocase-binary-pk") {
      f.db.exec("PRAGMA foreign_keys=OFF");
      f.db.prepare("INSERT INTO manga_images(cache_key,chapter_index,image_index,local_path) VALUES(?,1,1,'other-case.png')").run(f.cacheDir.toUpperCase());
    }
    const owner = compare(f, name).actual;
    assert.equal(sample(() => detail(owner, f)).counts.point, 2, name + " retains the original schema semantics");
    const current = reader(f), previous = reader(f, oldReaderFactory);
    assert.equal(current.reader.detailFirstImages(f.cacheDir, [1, 2]), null);
    equal(current.reader.firstImage(f.cacheDir, 1), previous.reader.firstImage(f.cacheDir, 1), name + " retains complete native point row and ties");
    if (name === "extra-column") {
      f.db.exec("UPDATE manga_images SET extra=9223372036854775807 WHERE chapter_index=2 AND image_index=2");
      const bad = compare(f, "unused unknown INTEGER still participates in native decoding");
      const dto = detail(bad.actual, f); assert(dto.chapters[0].coverUrl); assert.equal(dto.chapters[1].coverUrl, "");
    }
  }
  const generated = fixture("generated-rowid"); addChapter(generated, 1); addChapter(generated, 2);
  generated.db.exec("ALTER TABLE manga_images ADD COLUMN rowid INTEGER GENERATED ALWAYS AS (1) VIRTUAL");
  const owner = compare(generated, "generated rowid shadow cannot be used as a physical address").actual;
  assert.equal(sample(() => detail(owner, generated)).counts.point, 2);
  const extraAlias = fixture("reserved-alias"); addChapter(extraAlias, 1);
  extraAlias.db.exec("ALTER TABLE manga_images ADD COLUMN __detail_eligible INTEGER DEFAULT 1");
  compare(extraAlias, "unknown columns cannot overwrite the internal policy proof");
}

function verifyTempShadowAndTransactions() {
  const f = fixture("temp-shadow", text => text, { wal: true }); addChapter(f, 1); addChapter(f, 2);
  const pair = compare(f);
  for (const owner of Object.values(pair)) owner.db.exec("CREATE TEMP VIEW MANGA_IMAGES AS SELECT * FROM main.manga_images WHERE image_index=3");
  equal(detail(pair.actual, f), detail(pair.previous, f), "uppercase TEMP view keeps the old unqualified lookup");
  assert(detail(pair.actual, f).chapters[0].coverUrl.endsWith("/1/3"));
  assert.equal(sample(() => detail(pair.actual, f)).counts.point, 2);
  for (const owner of Object.values(pair)) owner.db.exec("DROP VIEW temp.MANGA_IMAGES; CREATE TEMP TABLE MANGA_IMAGES AS SELECT * FROM main.manga_images WHERE 0");
  equal(detail(pair.actual, f), detail(pair.previous, f), "TEMP table also disables the main-table proof");
  for (const owner of Object.values(pair)) owner.db.exec("DROP TABLE temp.MANGA_IMAGES");
  equal(detail(pair.actual, f), detail(pair.previous, f), "removing TEMP shadow re-enables the healthy schema");
  assert.equal(sample(() => detail(pair.actual, f)).counts.point, 0);

  const r = reader(f), writer = new DatabaseSync(f.file); handles.add(writer);
  r.db.exec("BEGIN");
  const first = r.reader.detailFirstImages(f.cacheDir, [1, 2]); assert(first); assert(r.db.isTransaction);
  writer.exec("UPDATE manga_images SET image_index=6 WHERE chapter_index=1 AND image_index=2");
  equal(r.reader.detailFirstImages(f.cacheDir, [1, 2]), first, "caller transaction retains its existing SQLite snapshot");
  assert(r.db.isTransaction, "helper never commits or rolls back its caller");
  r.db.exec("ROLLBACK");
  assert.equal(r.reader.detailFirstImages(f.cacheDir, [1])[0].image_index, 3, "subsequent lookup sees the new first image after rollback");
}

function verifyPublicationAndIdentity() {
  const f = fixture("wal-publication", text => text, { wal: true }); addChapter(f, 1); addChapter(f, 2);
  const pair = compare(f), writer = new DatabaseSync(f.file); handles.add(writer);
  writer.exec("UPDATE manga_images SET image_index=5 WHERE chapter_index=1 AND image_index=2");
  equal(detail(pair.actual, f), detail(pair.previous, f), "external WAL publication remains visible between requests");
  afterRead = { kind: "chapters", run() { writer.exec("UPDATE manga_images SET image_index=2 WHERE chapter_index=1 AND image_index=3"); } };
  const justBefore = detail(pair.actual, f); assert.equal(afterRead, null);
  equal(justBefore, detail(pair.previous, f), "commit before the batch is included in its single statement snapshot");
  const expectedBefore = detail(pair.previous, f);
  let published = false;
  afterRead = { kind: "bulk", run() { writer.exec("UPDATE manga_images SET image_index=6 WHERE chapter_index=2 AND image_index=2"); published = true; } };
  const before = detail(pair.actual, f); assert(published);
  equal(before, expectedBefore, "publication after the batch changes no already materialized fields");
  const after = detail(pair.actual, f);
  assert.notEqual(after.chapters[1].coverUrl, before.chapters[1].coverUrl);
  equal(after, detail(pair.previous, f), "following request observes the committed data");

  const replaced = fixture("file-replacement"); addChapter(replaced, 1);
  const replacement = path.join(replaced.directory, "replacement.sqlite"), oldFile = path.join(replaced.directory, "original.sqlite");
  files.add(replacement); files.add(oldFile);
  replaced.db.exec("VACUUM INTO '" + replacement.replaceAll("'", "''") + "'");
  const newDb = new DatabaseSync(replacement); handles.add(newDb);
  newDb.exec("UPDATE manga_images SET image_index=7 WHERE image_index=2"); newDb.close(); replaced.db.close();
  const fixedTime = new Date("2025-01-01T00:00:00.000Z");
  fs.utimesSync(replaced.file, fixedTime, fixedTime); fs.utimesSync(replacement, fixedTime, fixedTime);
  const owners = compare(replaced), oldStat = fs.statSync(replaced.file, { bigint: true }), newStat = fs.statSync(replacement, { bigint: true });
  assert.equal(oldStat.size, newStat.size); assert.equal(oldStat.mtimeNs, newStat.mtimeNs); assert.notEqual(oldStat.ino, newStat.ino);
  // Close the exposed fixture handles before renaming on Windows. The owners
  // retain their connection state and must recognize the replacement identity.
  for (const owner of Object.values(owners)) owner.db.close();
  fs.renameSync(replaced.file, oldFile); fs.renameSync(replacement, replaced.file);
  const swapped = detail(owners.actual, replaced);
  equal(swapped, detail(owners.previous, replaced), "same-size/same-mtime replacement reopens both actual owners");
  assert(swapped.chapters[0].coverUrl.endsWith("/1/3"));
  const absent = path.join(replaced.directory, "temporarily-missing.sqlite"); files.add(absent);
  for (const owner of Object.values(owners)) owner.db.close();
  fs.renameSync(replaced.file, absent);
  equal(detail(owners.actual, replaced), detail(owners.previous, replaced), "missing database keeps the manifest fallback");
  fs.renameSync(absent, replaced.file);
  equal(detail(owners.actual, replaced), detail(owners.previous, replaced), "restoring the file retries instead of caching a missing source");
}

function verifyScale() {
  const f = fixture("scale"); f.db.exec("BEGIN");
  for (let index = 1; index <= 1000; index++) addChapter(f, index, 20);
  f.db.exec("COMMIT");
  const current = service(f, testedFactory), previous = service(f, disabledFactory);
  detail(current, f); detail(previous, f);
  const old = sample(() => detail(previous, f)), next = sample(() => detail(current, f));
  equal(next.value, old.value, "current-only disabled mechanism complete response");
  equal(next.value, detail(service(f, oldFactory), f), "1000 chapters match the complete frozen owners");
  assert.equal(old.counts.point, 1000); assert.equal(old.counts.reads, 1003); assert.equal(old.counts.stats, 1005);
  assert.equal(old.counts.rows, 2002);
  if (latestBulk) {
    const plan = f.db.prepare("EXPLAIN QUERY PLAN " + latestBulk.sql).all(...latestBulk.args).map(row => row.detail);
    assert(plan.some(value => /SEARCH picked USING INDEX .*cache_key=\? AND chapter_index=\?/u.test(value)), "native first-image lookup uses the chapter PK prefix");
    assert(!plan.some(value => /SCAN picked\b/u.test(value)), "do not replace point reads with a full images scan");
  }
  const times = { previous: [], current: [] };
  uninstrumented(() => {
    for (let round = 0; round < 5; round++) {
      const values = {};
      for (const [key, owner] of round % 2 ? [["current", current], ["previous", previous]] : [["previous", previous], ["current", current]]) {
        const began = performance.now(); values[key] = detail(owner, f); times[key].push(performance.now() - began);
      }
      equal(values.current, values.previous, "interleaved complete native directory response");
    }
  });
  const median = values => values.toSorted((a, b) => a - b)[2];
  return { chapters: 1000, storedImages: 20000, previous: old.counts, current: next.counts,
    nativeDiagnosticMedianMs: { previous: median(times.previous), current: median(times.current) } };
}
