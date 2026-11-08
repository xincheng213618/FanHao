import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { DatabaseSync, StatementSync } from "node:sqlite";
import { performance } from "node:perf_hooks";
import { createMangaService } from "../src/modules/photos/server/manga-service.js";
import { createImageLibraryService } from "../src/modules/content-index/server/image-library-service.js";

const sourceUrl = new URL("../src/modules/photos/server/manga-service.js", import.meta.url);
const source = fs.readFileSync(sourceUrl, "utf8").replaceAll("\r\n", "\n");
const oldReader = fs.readFileSync(new URL("./fixtures/manga-comic-reader-before-cache.txt", import.meta.url), "utf8").replaceAll("\r\n", "\n");
assert.equal(createHash("sha256").update(oldReader).digest("hex"), "9048fedabc06e2c6049a1747fdb1cd654844e6478604eccd2b07b4b6231cc8ea");
// Restore the exact preceding three service kernels, retaining the previous
// round's file-input cache and every unrelated detail/identity/fallback path.
const factsCurrent = `  function idForDir(dirPath, dbComic = database.comic(databaseKey(dirPath))) {
    return stableMangaId(sourceUrlForCache(dirPath, dbComic), dirPath);
  }`;
const factsPrevious = `  function idForDir(dirPath) {
    const dbComic = database.comic(databaseKey(dirPath));
    return stableMangaId(sourceUrlForCache(dirPath, dbComic), dirPath);
  }`;
const summaryCurrent = `    const dbComic = database.comic(databaseKey(cacheDir));
    return summaryForComic(cacheDir, dbComic, manifestContext);`;
const summaryPrevious = `    const id = idForDir(cacheDir);
    const dbComic = database.comic(databaseKey(cacheDir));
    return summaryForComic(cacheDir, dbComic, manifestContext, id);`;
const coverCurrent = `    const dbCover = dbComic && !metadata.localCover && !metadata.coverUrl
      ? readFirstImage(databaseKey(cacheDir)) : null;`;
const coverPrevious = "    const dbCover = dbComic ? readFirstImage(databaseKey(cacheDir)) : null;";
function restore(text, changes) {
  for (const [current, previous] of changes) {
    assert.equal(text.split(current).length, 2, "a complete current kernel has one owner");
    const replaced = text.replace(current, previous);
    assert.equal(replaced.replace(previous, current), text, "only the named kernel changes in the oracle");
    text = replaced;
  }
  return text;
}
const repeatedFactsSource = restore(source, [[factsCurrent, factsPrevious], [summaryCurrent, summaryPrevious]]);
const eagerCoverSource = restore(source, [[coverCurrent, coverPrevious]]);
const previousSource = restore(repeatedFactsSource, [[coverCurrent, coverPrevious]]);
const pointCoversSource = restore(source, [[
  "const covers = database.summaryFirstImages(coversPending.map(({ key }) => key));",
  "const covers = null; // Use the same comic batch and read covers individually."
]]);
const readerUrl = "data:text/javascript;base64," + Buffer.from(oldReader).toString("base64");
async function factoryFrom(text, previousReader = false) {
  const resolved = text.replace(/from "(\.\.?\/[^"\n]+)"/gu, (_, relative) => "from " + JSON.stringify(
    previousReader && relative === "./manga-database.js" ? readerUrl : new URL(relative, sourceUrl).href));
  return (await import("data:text/javascript;base64," + Buffer.from(resolved).toString("base64"))).createMangaService;
}
const previousFactory = await factoryFrom(previousSource, true);
const pointCoversFactory = await factoryFrom(pointCoversSource);
const controls = {
  "--repeat-comic": await factoryFrom(repeatedFactsSource),
  "--eager-cover": await factoryFrom(eagerCoverSource),
  "--uncached-comic-statement": await factoryFrom(source, true)
};
assert(process.argv.slice(2).every(value => Object.hasOwn(controls, value)) && process.argv.length <= 3);
const testedFactory = controls[process.argv[2]] || createMangaService;

const root = fs.mkdtempSync(path.join(os.tmpdir(), "fanhao-manga-summary-reads-"));
const dbPath = path.join(root, "private.sqlite"), directories = [], handles = new Set();
const saved = { prepare: DatabaseSync.prototype.prepare, get: StatementSync.prototype.get,
  all: StatementSync.prototype.all, stat: fs.statSync };
const statements = new WeakMap();
let measuring = null, afterComic = null, afterBatch = null, fault = null, comparisons = 0, factsChecks = 0;
const reports = [];
DatabaseSync.prototype.prepare = function (sql, ...args) {
  handles.add(this);
  if (measuring && (/^SELECT\b/iu.test(sql.trim()) || sql.includes("__summary_ordinal") || sql.includes("__first_image_eligible"))) measuring.prepares++;
  const statement = saved.prepare.call(this, sql, ...args);
  statements.set(statement, { sql, db: this }); return statement;
};
for (const method of ["get", "all"]) StatementSync.prototype[method] = function (...args) {
  const { sql = "", db } = statements.get(this) || {};
  const kind = sql.includes("__summary_ordinal") ? "batch" : sql.includes("__first_image_eligible") ? "coverBatch"
    : sql.includes("FROM manga_comics WHERE cache_key") ? "comic"
    : sql.includes("FROM manga_images WHERE cache_key") ? "cover" : "other";
  if (measuring && (/^SELECT\b/iu.test(sql.trim()) || kind === "batch" || kind === "coverBatch")) {
    measuring.reads++; if (kind === "comic") measuring.comics++; if (kind === "cover") measuring.covers++;
    if (kind === "batch") measuring.batches++;
    if (kind === "coverBatch") measuring.coverBatches++;
  }
  if (fault?.kind === kind) { fault.calls++; if (fault.remaining-- > 0) throw new Error("controlled " + kind + " read failure"); }
  const result = saved[method].call(this, ...args);
  if (kind === "comic" && afterComic) { const action = afterComic; afterComic = null; action.run(result, db); }
  if (kind === "batch" && afterBatch) { const action = afterBatch; afterBatch = null; action(); }
  return result;
};
fs.statSync = function (file, ...args) {
  if (measuring && (file === root || typeof file === "string" && file.startsWith(root + path.sep))) measuring.stats++;
  return saved.stat.call(this, file, ...args);
};
let writer;
try {
  writer = new DatabaseSync(dbPath); handles.add(writer);
  const collector = fs.readFileSync(new URL("../tools/manga_collector.py", import.meta.url), "utf8");
  const schema = /    schema = """([\s\S]*?)    """/u.exec(collector)?.[1];
  assert(schema?.includes("CREATE TABLE IF NOT EXISTS manga_comics"));
  writer.exec("PRAGMA journal_mode=WAL"); writer.exec(schema);
  writer.exec("BEGIN");
  for (let index = 0; index < 1000; index++) addBook(index);
  writer.exec("COMMIT");

  // Independent controls remove exactly one mechanism. Timing is diagnostic;
  // fixed SQL/compile/stat access counts are the scale gates.
  for (const mode of ["metadata", "mixed", "first-image"]) {
    setCovers(mode);
    const current = listing(service(testedFactory)), previous = listing(service(previousFactory));
    page(current, 0); page(previous, 0); // Warm only these private owners.
    const expectedCovers = mode === "metadata" ? 0 : mode === "mixed" ? 500 : 1000;
    const before = [], after = [];
    for (const offset of [0, 48, 96]) {
      const old = sample(() => page(previous, offset)), optimized = sample(() => page(current, offset));
      assert.deepEqual(withoutRevision(optimized.value), withoutRevision(old.value), "complete preceding list DTO and ordering");
      comparisons++; before.push(old); after.push(optimized);
    }
    const median = values => values.map(value => value.ms).sort((a, b) => a - b)[Math.floor(values.length / 2)];
    reports.push({ mode, expectedCovers, previous: compact(before[0]), current: compact(after[0]),
      diagnosticMedianMs: { previous: +median(before).toFixed(2), current: +median(after).toFixed(2) } });
  }
  // Exercise contracts using the actual product even during negative controls;
  // those controls must fail the fixed work budgets after behavior is checked.
  const current = service(createMangaService), previous = service(previousFactory), directory = directories[0];
  verifyBatchedSummary(current, directory);
  verifyCoverSelection(current, previous, directory);
  verifyFreshFacts(current, previous, directory);
  verifyJsonFallback(current, previous, directory);
  verifyDuplicateKeys(current, previous, directory);
  console.log(JSON.stringify({ ok: true, comparisons, factsChecks, books: 1000, reports,
    scope: "actual manga/library factories and collector SQLite; file-input cache retained on both sides; no media or crawlers" }, null, 2));
  for (const report of reports) {
    assert.equal(report.previous.reads, 3001); assert.equal(report.previous.comics, 2000);
    assert.equal(report.previous.covers, 1000); assert.equal(report.previous.prepares, 2001); assert.equal(report.previous.stats, 5008);
    assert.equal(report.current.comics, 1000, "one comic fact per summary");
    assert.equal(report.current.covers, report.expectedCovers, "read firstImage only when the final metadata cover is empty");
    assert.equal(report.current.reads, 1001 + report.expectedCovers);
    assert.equal(report.current.prepares, 1, "only the unchanged per-page comics bulk statement is compiled on a warm page");
    assert.equal(report.current.stats, 3008 + report.expectedCovers, "each real reader still checks its source identity");
  }
} finally {
  measuring = null; afterComic = null; afterBatch = null; fault = null;
  DatabaseSync.prototype.prepare = saved.prepare; StatementSync.prototype.get = saved.get; StatementSync.prototype.all = saved.all; fs.statSync = saved.stat;
  for (const database of handles) try { database.close(); } catch {}
  assert.equal(path.dirname(fs.realpathSync(root)), fs.realpathSync(os.tmpdir()));
  for (const directory of directories) {
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(root));
    for (const name of ["catalog.json", "catalog.html", "manifest.json"]) fs.unlinkSync(path.join(directory, name));
    fs.rmdirSync(directory);
  }
  for (const suffix of ["", "-wal", "-shm"]) { const file = dbPath + suffix; if (fs.existsSync(file)) fs.unlinkSync(file); }
  fs.rmdirSync(root);
}

function addBook(index) {
  const directory = path.join(root, "smtt6_cache_" + String(index).padStart(5, "0"));
  fs.mkdirSync(directory); directories.push(directory);
  fs.writeFileSync(path.join(directory, "catalog.json"), JSON.stringify({ title: "Catalog " + index, author: "Catalog author", url: `https://synthetic.invalid/book/${index}` }));
  fs.writeFileSync(path.join(directory, "catalog.html"), '<div class="sp-book-tags"><a>韩漫</a></div>');
  fs.writeFileSync(path.join(directory, "manifest.json"), JSON.stringify({ chapters: [{ index: 1, status: "done", images: [{ index: 1, local_path: "synthetic.png", status: "downloaded" }] }] }));
  writer.prepare("INSERT INTO manga_comics(cache_key,dir_name,site,title,source_url,chapter_count,done_chapter_count,image_count,downloaded_count,author,updated_at) VALUES(?,?,'smtt6',?,?,1,1,1,1,'DB author','2026-01-01')")
    .run(directory, path.basename(directory), "DB " + index, `https://synthetic.invalid/book/${index}`);
  writer.prepare("INSERT INTO manga_chapters(cache_key,chapter_index,title) VALUES(?,1,'Synthetic chapter')").run(directory);
  writer.prepare("INSERT INTO manga_images(cache_key,chapter_index,image_index,local_path) VALUES(?,1,1,'synthetic.png')").run(directory);
}
function setCovers(mode) {
  writer.exec("BEGIN");
  const update = writer.prepare("UPDATE manga_comics SET cover_path=?,cover_url=? WHERE cache_key=?");
  for (const [index, directory] of directories.entries()) {
    const choice = mode === "metadata" ? index % 2 : mode === "mixed" ? index % 4 : 2;
    update.run(choice === 0 ? "missing-local-cover.png" : choice === 3 ? " " : "",
      choice === 1 ? "https://synthetic.invalid/cover" : choice === 3 ? " " : "", directory);
  }
  writer.exec("COMMIT");
}
function service(create) {
  return create({ root, databasePath: dbPath, mimeTypes: {}, normalizeExt: path.extname,
    safeStat(file) { try { return fs.statSync(file); } catch { return null; } }, spawnProcess() { assert.fail("no collector in fixture"); } });
}
function listing(mangaService, useBatch = false) {
  const index = { scannedAt: "fixture", photoSets: [], mediaItems: [] };
  return createImageLibraryService({ cachePreparedQueries: true, getImageLibraryIndex: () => index, getImageLibraryRevision: () => 1,
    maxItemLimit: 12000, clampInteger: (value, fallback, min, max) => value == null ? fallback : Math.max(min, Math.min(max, Number(value))),
    mangaService: useBatch ? mangaService : { ...mangaService, publicSummaries: undefined }, metadataService: { listRevision: () => 1 },
    photoSetService: {}, galleryMediaRootStatuses: () => [], photoSetRootStatuses: () => [], imageReaderCacheStatus: () => ({}) });
}
function page(owner, offset) { return owner.itemsPayload(new URL(`http://fixture/?mode=manga&limit=48&offset=${offset}`)); }
function withoutRevision({ listRevision: _opaque, ...value }) { return value; }
function compact({ value: _value, ms, ...work }) { return { ...work, ms: +ms.toFixed(2) }; }
function sample(read) {
  measuring = { reads: 0, prepares: 0, comics: 0, covers: 0, batches: 0, coverBatches: 0, stats: 0 }; const start = performance.now();
  try { return { value: read(), ms: performance.now() - start, ...measuring }; } finally { measuring = null; }
}
function compare(current, previous, directory) {
  const before = previous.publicSummary(directory), after = current.publicSummary(directory);
  assert.deepEqual(after, before); assert.equal(JSON.stringify(after), JSON.stringify(before)); comparisons++;
  return after;
}
function verifyBatchedSummary(current, directory) {
  for (const mode of ["metadata", "mixed", "first-image"]) {
    setCovers(mode);
    const before = listing(service(pointCoversFactory), true), after = listing(service(createMangaService), true);
    page(before, 0); page(after, 0);
    const baselines = [], optimized = [];
    for (const [round, offset] of [0, 48, 96, 144, 192, 240, 288].entries()) {
      const readBefore = () => sample(() => page(before, offset));
      const readAfter = () => sample(() => page(after, offset));
      const [old, next] = round % 2 ? [readAfter(), readBefore()].reverse() : [readBefore(), readAfter()];
      assert.equal(JSON.stringify(withoutRevision(next.value)), JSON.stringify(withoutRevision(old.value)));
      assert.equal(old.comics, 0); assert.equal(next.comics, 0);
      assert.equal(old.batches, 1); assert.equal(next.batches, 1);
      assert.equal(old.covers, mode === "metadata" ? 0 : mode === "mixed" ? 500 : 1000);
      assert.equal(next.covers, 0);
      assert.equal(next.coverBatches, mode === "metadata" ? 0 : 1);
      assert.equal(old.stats - next.stats, old.covers - next.coverBatches);
      comparisons++;
      baselines.push(old); optimized.push(next);
    }
    const median = rows => +rows.map(row => row.ms).sort((a, b) => a - b)[3].toFixed(2);
    console.log(JSON.stringify({ check: "manga-summary-cover-batch", mode, books: 1000,
      previous: compact(baselines[0]), current: compact(optimized[0]),
      medianMs: { previous: median(baselines), current: median(optimized) } }));
  }

  const findBook = comics => comics.find(comic => comic.dirName === path.basename(directory));
  const baseline = findBook(current.publicSummaries());
  afterBatch = () => writer.prepare("UPDATE manga_comics SET title='Batched WAL update' WHERE cache_key=?").run(directory);
  assert.deepEqual(findBook(current.publicSummaries()), baseline, "one SQL batch uses its original snapshot for every selected row");
  assert.equal(afterBatch, null);
  assert.equal(findBook(current.publicSummaries()).title, "Batched WAL update", "the next list observes the new commit");
  const expected = current.cacheDirs().map(current.publicSummary);
  fault = { kind: "batch", remaining: 1, calls: 0 };
  const fallback = sample(() => current.publicSummaries());
  fault = null;
  assert.equal(fallback.batches, 1); assert.equal(fallback.comics, 1000);
  assert.deepEqual(fallback.value, expected, "a failed batch retries the point reader without losing healthy comics");
  fault = { kind: "coverBatch", remaining: 1, calls: 0 };
  const coverFallback = sample(() => current.publicSummaries());
  fault = null;
  assert.equal(coverFallback.coverBatches, 1); assert.equal(coverFallback.covers, 1000);
  assert.deepEqual(coverFallback.value, expected, "a failed cover batch keeps every original point fallback");
  writer.prepare("UPDATE manga_images SET bytes=? WHERE cache_key=?").run(9007199254740993n, directory);
  try {
    const pointCovers = current.cacheDirs().map(current.publicSummary);
    const unsafe = sample(() => current.publicSummaries());
    assert.equal(unsafe.coverBatches, 1); assert.equal(unsafe.covers, 1000);
    assert.equal(findBook(unsafe.value).coverUrl, "", "an unsafe row still fails only its own cover");
    assert.deepEqual(unsafe.value, pointCovers, "a malformed first image cannot suppress other comic covers");
  } finally { writer.prepare("UPDATE manga_images SET bytes=0 WHERE cache_key=?").run(directory); }
  factsChecks += 5;
}
function verifyCoverSelection(current, previous, directory) {
  const update = writer.prepare("UPDATE manga_comics SET cover_path=?,cover_url=? WHERE cache_key=?");
  for (const [local, remote, needed] of [["missing.png", "", false], ["", "https://synthetic.invalid/cover", false], [" ", " ", true], ["", "", true]]) {
    update.run(local, remote, directory);
    const result = compare(current, previous, directory);
    fault = { kind: "cover", remaining: 1, calls: 0 };
    const failed = current.publicSummary(directory), calls = fault.calls; fault = null;
    if (needed) { assert.equal(calls, 1); assert.equal(failed.coverUrl, ""); }
    else { assert.equal(calls, 0, "metadata covers avoid even a failing unused image query"); assert.equal(failed.coverUrl, result.coverUrl); }
    compare(current, previous, directory);
  }
  writer.prepare("DELETE FROM manga_images WHERE cache_key=?").run(directory);
  assert.equal(compare(current, previous, directory).coverUrl, "");
  writer.prepare("INSERT INTO manga_images(cache_key,chapter_index,image_index,local_path) VALUES(?,1,7,'new-synthetic.png')").run(directory);
  assert(compare(current, previous, directory).coverUrl.endsWith("/1/7"), "null image results are not cached across external commits");
  const catalogFile = path.join(directory, "catalog.json"), catalog = fs.readFileSync(catalogFile, "utf8");
  fs.writeFileSync(catalogFile, JSON.stringify({ ...JSON.parse(catalog), cover_path: "catalog-local.png" }));
  assert.equal(sample(() => current.publicSummary(directory)).covers, 0, "a final catalog-file cover also avoids firstImage");
  compare(current, previous, directory); fs.writeFileSync(catalogFile, catalog);
  const htmlFile = path.join(directory, "catalog.html"), markup = fs.readFileSync(htmlFile, "utf8");
  fs.writeFileSync(htmlFile, markup + '<meta property="og:image" content="https://synthetic.invalid/html-cover">');
  assert.equal(sample(() => current.publicSummary(directory)).covers, 0, "a final HTML cover also avoids firstImage");
  compare(current, previous, directory); fs.writeFileSync(htmlFile, markup);
}
function verifyFreshFacts(current, previous, directory) {
  writer.prepare("UPDATE manga_comics SET cover_path='local.png',title='Old title',source_url='https://synthetic.invalid/old',author='Old author' WHERE cache_key=?").run(directory);
  const before = compare(current, previous, directory);
  afterComic = { run() { writer.prepare("UPDATE manga_comics SET title='New title',source_url='https://synthetic.invalid/new',author='New author' WHERE cache_key=?").run(directory); } };
  const coherent = current.publicSummary(directory); assert.equal(afterComic, null);
  assert.deepEqual(coherent, before, "ID and fields consume the very same row despite a WAL commit immediately after reading it"); factsChecks++;
  const next = current.publicSummary(directory);
  assert.notEqual(next.id, before.id); assert.equal(next.sourceUrl, "https://synthetic.invalid/new"); assert.equal(next.title, "New title"); assert.equal(next.author, "New author");
  compare(current, previous, directory);
  fault = { kind: "comic", remaining: 1, calls: 0 };
  const failed = sample(() => current.publicSummary(directory)); fault = null;
  assert.equal(failed.comics, 1, "one failed comic fact is not replaced by a second read within this summary");
  assert.equal(failed.value.title, "Catalog 0"); assert.equal(failed.value.author, "Catalog author"); factsChecks++;
  assert.equal(current.publicSummary(directory).title, "New title", "the next summary retries a failed comic read");
  const file = path.join(directory, "catalog.html");
  fs.writeFileSync(file, '<div class="sp-book-tags"><a>Updated file category</a></div>');
  assert.equal(compare(current, previous, directory).category, "Updated file category");
}
function verifyJsonFallback(current, previous, directory) {
  writer.prepare("DELETE FROM manga_comics WHERE cache_key=?").run(directory);
  const work = sample(() => current.publicSummary(directory));
  assert.equal(work.comics, 1, "a missing comic row is still a single fact, not a default-parameter reread");
  const result = compare(current, previous, directory); assert.equal(result.author, "Catalog author"); assert.equal(result.chapterCount, 1);
  assert.deepEqual(current.publicSummaries().find(comic => comic.dirName === result.dirName), result, "a missing batched row uses the current file fallback");
  const file = path.join(directory, "catalog.json");
  const catalog = JSON.parse(fs.readFileSync(file, "utf8")); catalog.author = "Updated JSON author";
  fs.writeFileSync(file, JSON.stringify(catalog)); assert.equal(compare(current, previous, directory).author, "Updated JSON author");
}
function verifyDuplicateKeys(current, previous, directory) {
  writer.exec("PRAGMA foreign_keys=OFF");
  const columns = writer.prepare("PRAGMA table_info(manga_comics)").all();
  writer.exec("ALTER TABLE manga_comics RENAME TO previous_comics;CREATE TABLE manga_comics("
    + columns.map(column => `"${column.name}" ${column.type}`).join(",") + ");INSERT INTO manga_comics SELECT * FROM previous_comics;DROP TABLE previous_comics");
  writer.prepare("INSERT INTO manga_comics(cache_key,dir_name,site,title,source_url) VALUES(?,?,'smtt6','First duplicate','https://synthetic.invalid/first')").run(directory, path.basename(directory));
  writer.prepare("INSERT INTO manga_comics(cache_key,dir_name,site,title,source_url) VALUES(?,?,'smtt6','Second duplicate','https://synthetic.invalid/second')").run(directory, path.basename(directory));
  assert.equal(compare(current, previous, directory).title, "First duplicate", "legacy nonunique cache keys retain native .get first-row behavior");
  const legacy = sample(() => current.publicSummaries());
  assert.equal(legacy.batches, 1); assert.equal(legacy.comics, 1000);
  assert.deepEqual(legacy.value, current.cacheDirs().map(current.publicSummary), "legacy duplicates bypass the batch");
}
