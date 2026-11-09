import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { EventEmitter, once } from "node:events";
import fs from "node:fs";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { DatabaseSync, StatementSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { createMangaService as currentFactory } from "../src/modules/photos/server/manga-service.js";
import { createMangaDatabaseReader as currentReaderFactory } from "../src/modules/photos/server/manga-database.js";
import { routePhotosApi } from "../src/modules/photos/server/routes.js";
import { createPhotosRuntime } from "../src/modules/photos/server/runtime.js";

// The legacy revision was checked against both clean manga source files before
// this optimization. It executes their actual code, not a rewritten baseline.
// --legacy must fail the warm lookup gate; --legacy --diagnose prints all scales.
const ORIGINAL_FIRST_IMAGE = String.raw`  function firstImage(cacheKey, chapterIndex = null) {
    const database = open();
    if (!database) return null;
    try {
      if (chapterIndex == null) {
        return database.prepare(
          "SELECT * FROM manga_images WHERE cache_key = ? AND local_path IS NOT NULL AND local_path <> '' ORDER BY chapter_index, image_index LIMIT 1"
        ).get(String(cacheKey || "")) || null;
      }
      return database.prepare(
        "SELECT * FROM manga_images WHERE cache_key = ? AND chapter_index = ? AND local_path IS NOT NULL AND local_path <> '' ORDER BY image_index LIMIT 1"
      ).get(String(cacheKey || ""), Number(chapterIndex)) || null;
    } catch {
      return null;
    }
  }`;
const forceUncachedFirstImages = process.argv.includes("--legacy-first-image-statements");
const forceRepeatedChapterSummaries = process.argv.includes("--legacy-chapter-summaries");
const legacy = process.argv.includes("--legacy");
const diagnose = process.argv.includes("--diagnose");
const legacyRef = "1f6ddf213f0fbab4d417fdf61636b957d1909338";
const factory = legacy ? await legacyFactory() : forceUncachedFirstImages ? (await uncachedFirstImageModules()).factory : currentFactory;
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "fanhao-manga-lookups-"));
const collector = fs.readFileSync(path.resolve(import.meta.dirname, "../tools/manga_collector.py"), "utf8");
const schema = /    schema = """([\s\S]*?)    """/.exec(collector)?.[1];
assert.ok(schema?.includes("CREATE TABLE IF NOT EXISTS manga_comics"), "use the actual collector schema");
const ownedDirectories = [];
const handles = new Set();
const originalPrepare = DatabaseSync.prototype.prepare;
const originalExecutions = Object.fromEntries(["get", "all", "iterate"].map(method => [method, StatementSync.prototype[method]]));
const statementSql = new WeakMap();
const originalRead = fs.readFileSync;
const originalStat = fs.statSync;
const originalExists = fs.existsSync;
const originalReaddir = fs.readdirSync;
let measured = false;
let counts;
let checks = 0;
let served = 0;
let afterChapterRowsRead;
let manifestReadProbe;
DatabaseSync.prototype.prepare = function (statement, ...args) {
  handles.add(this);
  if (measured && /\bSELECT\b/i.test(statement)) counts.prepares += 1;
  const prepared = originalPrepare.call(this, statement, ...args);
  statementSql.set(prepared, statement);
  return prepared;
};
for (const method of Object.keys(originalExecutions)) StatementSync.prototype[method] = function (...args) {
  const statement = statementSql.get(this) || "";
  if (measured && /\bSELECT\b/i.test(statement)) {
    counts.sqlReads += 1;
    if (/\bFROM\s+manga_comics\b/i.test(statement) && !/\bWHERE\b/i.test(statement)) counts.librarySqlReads += 1;
  }
  const result = originalExecutions[method].call(this, ...args);
  if (method === "all" && statement === "SELECT * FROM manga_chapters WHERE cache_key = ? ORDER BY chapter_index") {
    if (measured) counts.chapterRows += result.length;
    const afterRead = afterChapterRowsRead;
    afterChapterRowsRead = null;
    afterRead?.();
  }
  return result;
};
fs.readFileSync = function (file, ...args) {
  const json = measured && isOwned(file) && /^(catalog|manifest)\.json$/.test(path.basename(file));
  const html = measured && isOwned(file) && path.basename(file) === "catalog.html";
  if (json) counts.jsonReads += 1;
  if (html) counts.htmlReads += 1;
  const value = originalRead.call(this, file, ...args);
  if (file === manifestReadProbe?.file) {
    manifestReadProbe.reads++;
    manifestReadProbe.bytes += Buffer.byteLength(value);
    const afterRead = manifestReadProbe.afterRead;
    manifestReadProbe.afterRead = null;
    afterRead?.();
  }
  if (json || html) counts.metadataBytes += Buffer.byteLength(value);
  return value;
};
fs.statSync = function (file, ...args) { if (measured && isOwned(file)) counts.statCalls += 1; return originalStat.call(this, file, ...args); };
fs.existsSync = function (file, ...args) { if (measured && isOwned(file)) counts.existsCalls += 1; return originalExists.call(this, file, ...args); };
fs.readdirSync = function (file, ...args) { if (measured && isOwned(file)) counts.directoryScans += 1; return originalReaddir.call(this, file, ...args); };

try {
  const fixture = fresh("large", { wal: true });
  const bookDirs = [];
  let previous = 0;
  for (const total of [100, 500, 1000]) {
    fixture.db.exec("BEGIN IMMEDIATE");
    try {
      for (let index = previous; index < total; index++) bookDirs.push(addBook(fixture, index));
      fixture.db.exec("COMMIT");
    } catch (error) { fixture.db.exec("ROLLBACK"); throw error; }
    previous = total;
    const target = bookDirs.at(-1);
    const id = expectedId(`https://synthetic.invalid/book/${total - 1}`, target);
    assert.equal(fixture.service.publicSummary(target).id, id);
    const cold = await measure(`cold-index-${total}-books`, () => assert.equal(fixture.service.cacheById(id), target, "build the initial index before measuring warm lookup"));
    if (!diagnose) assert.ok(cold.librarySqlReads <= 1, "a cold index should materialize the SQL comic catalog only once");
    for (let sample = 1; sample <= 3; sample++) {
      const result = await measure(`warm-image-${total}-books-${sample}`, () => fixture.service.serveImage({}, id, "1", "1"));
      warmGate(result, 1);
    }
    const result = await measure(`warm-chapter-route-${total}-books`, async () => {
      const response = {};
      await routePhotosApi({ method: "GET" }, response, new URL(`http://fixture/api/manga/${id}/chapters/1`), {
        mangaService: fixture.service, imageReaderCacheStatus: async () => ({ synthetic: true }),
        notFound: () => assert.fail("known synthetic chapter must exist"),
        sendJson: (res, status, data) => Object.assign(res, { status, data })
      });
      assert.equal(response.status, 200); assert.equal(response.data.comic.id, id); assert.equal(response.data.chapter.images.length, 1);
    });
    // Chapter presentation legitimately performs a few target queries in addition
    // to lookup; still forbid a library-wide scan on this known route.
    warmGate(result, 3);
    checks += 1;
  }
  const target = bookDirs.at(-1);
  const id = expectedId("https://synthetic.invalid/book/999", target);
  const began = performance.now();
  let timerLag;
  const timer = new Promise(resolve => setTimeout(() => { timerLag = performance.now() - began; resolve(); }, 0));
  const burst = await measure("warm-1000-books-16-images", () => Promise.all(Array.from({ length: 16 }, () => fixture.service.serveImage({}, id, "1", "1"))));
  await timer;
  console.log(JSON.stringify({ name: "main-loop-zero-delay-timer", elapsedMs: +timerLag.toFixed(2) }));
  warmGate(burst, 16);
  if (!diagnose) assert.ok(timerLag < 500, `indexed resolution burst delayed the main loop ${timerLag.toFixed(1)} ms`);
  assert.equal(served, 16 + 3 * 3, "all images reach the controlled archive/image continuation");

  // The actual collector uses WAL. A normal write lock is a control, not a
  // fabricated rollback-journal lock scenario attributed to production.
  fixture.db.exec("BEGIN IMMEDIATE");
  try { assert.equal(fixture.service.publicSummary(target).id, id); } finally { fixture.db.exec("ROLLBACK"); }
  checks += 1;
  if (!diagnose) {
    verifyInvalidation(fixture, target, id);
    verifyCrossRootIdentity();
    verifyDuplicateLegacySqlKey();
    verifyDatabaseReplacement();
    if (!legacy) await verifyFirstImageStatements();
    if (!legacy) await verifyChapterSummaryReuse();
    if (!legacy) await verifyChapterNavigationCache();
    if (!legacy) await verifyManifestImageChapterCache();
    if (!legacy) await verifyChapterHttpLifecycle();
  }
  console.log(`PASS manga lookup performance: ${checks} groups; actual service/collector SQLite, synthetic catalog and controlled image continuation${diagnose ? " (diagnostic mode: performance gates omitted)" : ""}`);
} finally {
  DatabaseSync.prototype.prepare = originalPrepare;
  for (const method of Object.keys(originalExecutions)) StatementSync.prototype[method] = originalExecutions[method];
  fs.readFileSync = originalRead; fs.statSync = originalStat; fs.existsSync = originalExists; fs.readdirSync = originalReaddir;
  for (const database of handles) { try { database.close(); } catch {} }
  const resolved = fs.realpathSync(temporary);
  assert.equal(path.dirname(resolved).toLowerCase(), fs.realpathSync(os.tmpdir()).toLowerCase());
  assert.ok(path.basename(resolved).startsWith("fanhao-manga-lookups-"));
  // Delete only explicit files, then validated empty leaf directories. No
  // recursive operation, collector process, production server or real media is used.
  for (const directory of [...ownedDirectories].reverse().concat(resolved)) {
    assert.ok(directory === resolved || directory.startsWith(resolved + path.sep));
    for (const name of fs.readdirSync(directory)) {
      const file = path.resolve(directory, name); assert.equal(path.dirname(file), directory);
      assert.ok(fs.lstatSync(file).isFile(), "all owned child directories must already be empty and removed"); fs.unlinkSync(file);
    }
    fs.rmdirSync(directory);
  }
  assert.equal(fs.existsSync(resolved), false);
}

async function uncachedFirstImageModules() {
  const readerPath = path.resolve(import.meta.dirname, "../src/modules/photos/server/manga-database.js");
  const sourcePath = path.resolve(import.meta.dirname, "../src/modules/photos/server/manga-service.js");
  const reader = fs.readFileSync(readerPath, "utf8").replaceAll("\r\n", "\n");
  const start = reader.indexOf("  function firstImage(");
  const nextMethod = reader.indexOf("\n  function ", start + 1);
  const end = nextMethod >= 0 ? nextMethod : reader.indexOf("\n  return { chapter", start);
  assert(start >= 0 && end > start, "locate the complete current firstImage method");
  const actual = reader.slice(start, end).trimEnd();
  const restored = reader.replace(actual, ORIGINAL_FIRST_IMAGE);
  assert.equal(restored.replace(ORIGINAL_FIRST_IMAGE, actual), reader, "the old oracle changes only firstImage");
  const readerUrl = "data:text/javascript;base64," + Buffer.from(restored).toString("base64");
  const readerModule = await import(readerUrl);
  const service = fs.readFileSync(sourcePath, "utf8").replace(/from "(\.\.?\/[^"\n]+)"/g, (_match, relative) =>
    "from " + JSON.stringify(relative === "./manga-database.js" ? readerUrl : pathToFileURL(path.resolve(path.dirname(sourcePath), relative)).href));
  const serviceModule = await import("data:text/javascript;base64," + Buffer.from(service).toString("base64"));
  return { factory: serviceModule.createMangaService, readerFactory: readerModule.createMangaDatabaseReader };
}

async function verifyFirstImageStatements() {
  const fixture = fresh("chapter-statements", { wal: true });
  const dir = addBook(fixture, 1);
  // Exercise the per-chapter compatibility lane. Canonical collector tables
  // use the independent detail batch gate; extra columns keep firstImage()
  // responsible for this complete response and its existing compile budget.
  fixture.db.exec("ALTER TABLE manga_images ADD COLUMN fixture_statement_lane TEXT");
  fixture.db.exec("BEGIN IMMEDIATE");
  try {
    const chapter = fixture.db.prepare("INSERT INTO manga_chapters(cache_key,chapter_index,title,image_count,downloaded_count) VALUES (?,?,?,30,1)");
    const image = fixture.db.prepare("INSERT INTO manga_images(cache_key,chapter_index,image_index,local_path) VALUES (?,?,?,?)");
    for (let chapterIndex = 2; chapterIndex <= 1000; chapterIndex++) {
      chapter.run(dir, chapterIndex, "Synthetic chapter " + chapterIndex);
      for (let imageIndex = 1; imageIndex <= 30; imageIndex++) image.run(dir, chapterIndex, imageIndex, imageIndex === 29 ? "synthetic.png" : null);
    }
    fixture.db.exec("COMMIT");
  } catch (error) { fixture.db.exec("ROLLBACK"); throw error; }
  const old = await uncachedFirstImageModules();
  const previousService = old.factory({ root: fixture.root, databasePath: fixture.dbPath, mimeTypes: {}, normalizeExt: path.extname, safeStat: () => null });
  let oracles = 0;
  const compare = () => {
    const previous = previousService.publicDetail(dir), current = fixture.service.publicDetail(dir);
    assert.deepEqual(current, previous, "the complete chapter-directory response retains the former values");
    assert.equal(JSON.stringify(current), JSON.stringify(previous), "the complete chapter-directory JSON retains field order");
    oracles++;
    return current;
  };
  const initial = compare();
  assert.equal(initial.chapters.length, 1000);
  assert(initial.chapters[28].coverUrl.endsWith("/29/29"));
  const before = await measure("uncached-1000-chapter-detail", () => previousService.publicDetail(dir));
  const after = await measure("reused-1000-chapter-detail", () => fixture.service.publicDetail(dir));
  assert.equal(before.prepares - after.prepares, 1001, "the old firstImage mechanism compiles the comic cover and all 1000 chapter covers");
  assert(after.prepares <= 3, "firstImage reuse leaves at most three unrelated point/directory SELECT compilations");
  assert.equal(after.sqlReads, before.sqlReads, "prepared statements must not cache row results");
  assert.equal(after.statCalls, before.statCalls, "prepared statements must retain every source-file check");

  const previousReader = old.readerFactory({ dbPath: fixture.dbPath });
  const reader = (forceUncachedFirstImages ? old.readerFactory : currentReaderFactory)({ dbPath: fixture.dbPath });
  const compareImage = (key = dir, chapterIndex = null) => {
    const expected = previousReader.firstImage(key, chapterIndex), result = reader.firstImage(key, chapterIndex);
    assert.deepEqual(result, expected);
    assert.equal(JSON.stringify(result), JSON.stringify(expected));
    oracles++;
    return result;
  };
  compareImage();
  for (const chapterIndex of [1, "1", 29, 0, -1, 1001, NaN, Infinity]) compareImage(dir, chapterIndex);
  const otherDir = addBook(fixture, 2);
  compareImage(otherDir); compareImage(otherDir, 1); compareImage(dir, 29);
  const first = compareImage(dir, 29), second = compareImage(dir, 29);
  assert.notStrictEqual(first, second, "each execution returns an independent row object");
  first.local_path = "private response mutation";
  assert.equal(compareImage(dir, 29).local_path, "synthetic.png");
  fixture.db.prepare("UPDATE manga_images SET local_path='changed.png' WHERE cache_key=? AND chapter_index=29 AND image_index=29").run(dir);
  assert.equal(compareImage(dir, 29).local_path, "changed.png", "a WAL update remains visible through the prepared statement");
  compare();
  fixture.db.exec("ALTER TABLE manga_images ADD COLUMN fixture_added_column TEXT DEFAULT 'added'");
  assert.equal(compareImage(dir, 29).fixture_added_column, "added", "external schema changes recompile SELECT * and expose new columns");
  fixture.db.prepare("UPDATE manga_images SET local_path='' WHERE cache_key=? AND chapter_index=29").run(dir);
  assert.equal(compareImage(dir, 29), null);
  compare();
  fixture.db.prepare("INSERT INTO manga_images(cache_key,chapter_index,image_index,local_path) VALUES (?,29,0,'zero.png')").run(dir);
  assert.equal(compareImage(dir, 29).image_index, 0);
  compare();
  fixture.db.exec("DROP TABLE manga_images");
  assert.equal(compareImage(dir, 29), null, "read errors retain the null fallback");
  const imagesTable = /CREATE TABLE IF NOT EXISTS manga_images \([\s\S]+?\n    \);/.exec(schema)?.[0];
  assert(imagesTable);
  fixture.db.exec(imagesTable);
  fixture.db.prepare("INSERT INTO manga_images(cache_key,chapter_index,image_index,local_path) VALUES (?,29,2,'restored.png')").run(dir);
  assert.equal(compareImage(dir, 29).local_path, "restored.png", "a failed query is retried against the restored table");
  compare();
  console.log(JSON.stringify({ check: "manga-first-image-statements", chapters: 1000, completeResponseOracles: oracles, prepared: { previous: before.prepares, current: after.prepares }, uncachedReads: after.sqlReads, sourceChecksRetained: true, externalSchemaAndRows: true, failureRetry: true }));
  checks++;
}

async function repeatedChapterSummaryModules() {
  const servicePath = path.resolve(import.meta.dirname, "../src/modules/photos/server/manga-service.js");
  const routesPath = path.resolve(import.meta.dirname, "../src/modules/photos/server/routes.js");
  const service = fs.readFileSync(servicePath, "utf8").replaceAll("\r\n", "\n");
  // Keep this older gate sensitive to duplicate summaries. Disable newer
  // file-input and list-summary reuse on both sides of this older oracle.
  const cacheBinding = "const metadataInputs = createMangaMetadataInputCache();";
  assert.equal(service.split(cacheBinding).length, 2);
  const summaryStart = service.indexOf("  function readManifestSummary(");
  const summaryEnd = service.indexOf("\n  function publicSummary(", summaryStart);
  assert(summaryStart >= 0 && summaryEnd > summaryStart);
  const uncachedService = service.replace(cacheBinding, "const metadataInputs = readMangaMetadataInputs;")
    .replace(service.slice(summaryStart, summaryEnd), "  function readManifestSummary(cacheDir, context) {\n    return summarizeManifest(readMangaManifest(cacheDir, context));\n  }\n");
  const currentSummary = "    if (manga === undefined) manga = publicSummary(cacheDir, manifestContext);";
  const oldSummary = "    manifestContext = {};\n    manga = publicSummary(cacheDir, manifestContext);";
  assert.equal(service.split(currentSummary).length, 2);
  const previousService = uncachedService.replace(currentSummary, oldSummary);
  assert.equal(previousService.replace(oldSummary, currentSummary), uncachedService, "the oracle restores only the former chapter summary call");
  const moduleSource = previousService.replace(/from "(\.\.?\/[^"\n]+)"/g, (_match, relative) =>
    "from " + JSON.stringify(pathToFileURL(path.resolve(path.dirname(servicePath), relative)).href));
  const previousFactory = (await import("data:text/javascript;base64," + Buffer.from(moduleSource).toString("base64"))).createMangaService;
  const uncachedModule = uncachedService.replace(/from "(\.\.?\/[^"\n]+)"/g, (_match, relative) =>
    "from " + JSON.stringify(pathToFileURL(path.resolve(path.dirname(servicePath), relative)).href));
  const uncachedFactory = (await import("data:text/javascript;base64," + Buffer.from(uncachedModule).toString("base64"))).createMangaService;
  const route = fs.readFileSync(routesPath, "utf8").replaceAll("\r\n", "\n");
  const currentCall = "      const manifestContext = {};\n      const comic = cacheDir ? mangaService.publicSummary(cacheDir, manifestContext) : null;\n      const chapter = cacheDir ? await mangaService.publicChapter(cacheDir, decodeURIComponent(mangaChapterMatch[2]), comic, manifestContext, { signal: controller.signal }) : null;";
  const oldCall = "      const chapter = cacheDir ? await mangaService.publicChapter(cacheDir, decodeURIComponent(mangaChapterMatch[2]), undefined, undefined, { signal: controller.signal }) : null;";
  const currentCache = "      const cache = await imageReaderCacheStatus();\n      if (!unavailable()) sendJson(res, 200, { comic, chapter, cache });";
  const oldCache = "      const comic = mangaService.publicSummary(cacheDir);\n" + currentCache;
  assert.equal(route.split(currentCall).length, 2); assert.equal(route.split(currentCache).length, 2);
  const previousRoute = route.replace(currentCall, oldCall).replace(currentCache, oldCache);
  assert.equal(previousRoute.replace(oldCall, currentCall).replace(oldCache, currentCache), route, "the route oracle restores only repeated summary work");
  const routeModule = previousRoute.replace(/from "(\.\.?\/[^"\n]+)"/g, (_match, relative) =>
    "from " + JSON.stringify(pathToFileURL(path.resolve(path.dirname(routesPath), relative)).href));
  return { factory: previousFactory, uncachedFactory, route: (await import("data:text/javascript;base64," + Buffer.from(routeModule).toString("base64"))).routePhotosApi };
}

async function verifyChapterSummaryReuse() {
  const previous = await repeatedChapterSummaryModules();
  const selectedRoute = forceRepeatedChapterSummaries ? previous.route : routePhotosApi;
  let oracles = 0;
  async function call(route, service, id, index) {
    const response = {};
    await route({ method: "GET" }, response, new URL(`http://fixture/api/manga/${encodeURIComponent(id)}/chapters/${encodeURIComponent(index)}`), {
      mangaService: service, imageReaderCacheStatus: async () => ({ synthetic: true }),
      notFound: res => Object.assign(res, { status: 404 }),
      sendJson: (res, status, data) => Object.assign(res, { status, data })
    });
    return response;
  }
  async function outcome(run) {
    try { return { result: await run() }; }
    catch (error) { return { error: { name: error.name, message: error.message } }; }
  }
  async function compare(fixture, index, id = alias(fixture.dir)) {
    const expected = await outcome(() => call(previous.route, fixture.previous, id, index));
    const actual = await outcome(() => call(selectedRoute, fixture.service, id, index));
    assert.deepEqual(actual, expected, "the complete chapter route retains status, response and error behavior");
    assert.equal(JSON.stringify(actual), JSON.stringify(expected), "complete serialized chapter-route response retains field order");
    const directBefore = await outcome(() => fixture.previous.publicChapter(fixture.dir, index));
    const directAfter = await outcome(() => fixture.service.publicChapter(fixture.dir, index));
    assert.deepEqual(directAfter, directBefore, "standalone publicChapter keeps its former default summary path");
    assert.equal(JSON.stringify(directAfter), JSON.stringify(directBefore));
    oracles++;
    return actual;
  }
  async function sample(route, service, fixture) {
    counts = freshCounts(); measured = true; const began = performance.now();
    try {
      const result = await call(route, service, fixture.id, fixture.chapters[Math.floor(fixture.total / 2)].index);
      assert.equal(result.status, 200);
      return { elapsedMs: performance.now() - began, ...counts };
    } finally { measured = false; }
  }
  const median = samples => samples.map(item => item.elapsedMs).sort((a, b) => a - b)[Math.floor(samples.length / 2)];
  for (const source of ["sqlite", "json"]) for (const total of [100, 1000]) {
    const fixture = fresh(`summary-${source}-${total}`, { wal: true });
    fixture.total = total;
    fixture.dir = addBook(fixture, 1, { jsonOnly: source === "json" });
    fixture.chapters = Array.from({ length: total }, (_, offset) => {
      const index = offset * 2 + 1;
      return { index, title: `合成章节 ${index}`, slug: `chapter-${index}`, url: `https://synthetic.invalid/book/${index}.html`, status: "done",
        images: Array.from({ length: 30 }, (_, image) => ({ index: image + 1, source_url: `https://synthetic.invalid/image/${index}/${image}`,
          local_path: `missing-${index}-${image}.png`, bytes: 12345, status: "downloaded" })) };
    });
    const manifestPath = path.join(fixture.dir, "manifest.json"), catalogPath = path.join(fixture.dir, "catalog.json");
    const manifest = JSON.stringify({ created_at: "2026-01-01", chapters: fixture.chapters });
    const catalog = JSON.stringify({ title: "合成漫画", author: "合成作者", url: "https://synthetic.invalid/book/1",
      chapters: fixture.chapters.map(chapter => ({ index: chapter.index, title: chapter.title, url: chapter.url })) });
    write(manifestPath, manifest); write(catalogPath, catalog);
    write(path.join(fixture.dir, "catalog.html"), '<div class="sp-book-tags"><a>韩漫</a><a>合成标签</a></div>' + "<!-- synthetic -->".repeat(4000));
    if (source === "sqlite") {
      fixture.db.exec("BEGIN");
      try {
        fixture.db.prepare("DELETE FROM manga_chapters WHERE cache_key=?").run(fixture.dir);
        const chapterStatement = fixture.db.prepare("INSERT INTO manga_chapters(cache_key,chapter_index,title,slug,url,image_count,downloaded_count,status) VALUES (?,?,?,?,?,30,30,'done')");
        const imageStatement = fixture.db.prepare("INSERT INTO manga_images(cache_key,chapter_index,image_index,local_path,bytes,status) VALUES (?,?,?,?,12345,'downloaded')");
        for (const chapter of fixture.chapters) {
          chapterStatement.run(fixture.dir, chapter.index, chapter.title, chapter.slug, chapter.url);
          for (const image of chapter.images) imageStatement.run(fixture.dir, chapter.index, image.index, image.local_path);
        }
        fixture.db.prepare("UPDATE manga_comics SET chapter_count=?,done_chapter_count=?,image_count=?,downloaded_count=? WHERE cache_key=?").run(total, total, total * 30, total * 30, fixture.dir);
        fixture.db.exec("COMMIT");
      } catch (error) { fixture.db.exec("ROLLBACK"); throw error; }
    }
    const options = { root: fixture.root, databasePath: source === "sqlite" ? fixture.dbPath : "", mimeTypes: {}, normalizeExt: path.extname,
      safeStat(file) { try { return fs.statSync(file); } catch { return null; } } };
    fixture.service = previous.uncachedFactory(options); fixture.previous = previous.factory(options);
    fixture.id = fixture.previous.publicSummary(fixture.dir).id;
    assert.equal(fixture.service.publicSummary(fixture.dir).id, fixture.id);
    for (const index of [1, fixture.chapters[Math.floor(total / 2)].index, fixture.chapters.at(-1).index, 2, "invalid"]) await compare(fixture, index);
    assert.equal((await compare(fixture, 1, "missing-directory-id")).result.status, 404);
    fixture.previous.cacheById(fixture.id); fixture.service.cacheById(fixture.id);
    for (let warm = 0; warm < 3; warm++) { await sample(previous.route, fixture.previous, fixture); await sample(selectedRoute, fixture.service, fixture); }
    const beforeSamples = [], afterSamples = [];
    for (let round = 0; round < 15; round++) {
      if (round % 2) { afterSamples.push(await sample(selectedRoute, fixture.service, fixture)); beforeSamples.push(await sample(previous.route, fixture.previous, fixture)); }
      else { beforeSamples.push(await sample(previous.route, fixture.previous, fixture)); afterSamples.push(await sample(selectedRoute, fixture.service, fixture)); }
    }
    const before = beforeSamples[0], after = afterSamples[0];
    assert.equal(after.htmlReads, 1, "negative control: a chapter route must read catalog HTML only once");
    assert.equal(before.htmlReads, 2, "the old oracle demonstrates the repeated summary");
    assert.equal(after.jsonReads, before.jsonReads - (source === "sqlite" ? 1 : 4));
    assert.equal(after.sqlReads, before.sqlReads - (source === "sqlite" ? 2 : 0), "a reused summary saves its single comic row and fallback cover read");
    assert(after.metadataBytes < before.metadataBytes);
    console.log(JSON.stringify({ check: "manga-chapter-summary-reuse", source, chapters: total,
      beforeMedianMs: +median(beforeSamples).toFixed(3), afterMedianMs: +median(afterSamples).toFixed(3),
      before: { ...before, elapsedMs: +before.elapsedMs.toFixed(3) }, after: { ...after, elapsedMs: +after.elapsedMs.toFixed(3) } }));
    if (source === "json" && total === 1000) await verifyManifestRequestReuse(options, fixture.dir, manifestPath, manifest, fixture.chapters[500].index);
    const response = (await compare(fixture, 1)).result;
    response.data.comic.title = "private response mutation";
    await compare(fixture, 1);
    write(catalogPath, JSON.stringify({ title: "当前文件修改", author: "修改作者", url: "https://synthetic.invalid/book/1" }));
    if (source === "sqlite") fixture.db.prepare("UPDATE manga_chapters SET title='外部 WAL 修改' WHERE cache_key=? AND chapter_index=1").run(fixture.dir);
    else { fixture.chapters[0].title = "当前 JSON 修改"; write(manifestPath, JSON.stringify({ chapters: fixture.chapters })); }
    await compare(fixture, 1);
    for (const value of ["null", "{", "[]", "17"]) { write(catalogPath, value); await compare(fixture, 1); }
    fs.unlinkSync(catalogPath); await compare(fixture, 1); write(catalogPath, catalog);
    for (const value of ["null", "{"]) { write(manifestPath, value); await compare(fixture, 1); }
    fs.unlinkSync(manifestPath);
    assert.equal((await compare(fixture, 1)).result.status, 404, "a missing manifest must keep the directory unavailable");
    write(manifestPath, manifest); await compare(fixture, 1);
  }
  const events = [], summary = { id: "canonical-id" };
  let manifestContext;
  await routePhotosApi({ method: "GET" }, {}, new URL("http://fixture/api/manga/legacy-alias/chapters/7"), {
    mangaService: {
      cacheById(id) { assert.equal(id, "legacy-alias"); events.push("lookup"); return "private-directory"; },
      publicSummary(directory, context) { assert.equal(directory, "private-directory"); manifestContext = context; events.push("summary"); return summary; },
      async publicChapter(directory, index, comic, context, { signal }) {
        assert.equal(directory, "private-directory"); assert.equal(index, "7"); assert.strictEqual(comic, summary); assert.strictEqual(context, manifestContext);
        assert(signal instanceof AbortSignal && !signal.aborted);
        events.push("chapter");
        return { id: comic.id };
      }
    },
    imageReaderCacheStatus: async () => { events.push("cache"); return {}; },
    sendJson(_res, status, data) { assert.equal(status, 200); assert.strictEqual(data.comic, summary); assert.equal(data.chapter.id, summary.id); events.push("send"); }
  });
  assert.deepEqual(events, ["lookup", "summary", "chapter", "cache", "send"], "summary remains before chapter reads, using the same canonical identity within one request");
  console.log(JSON.stringify({ check: "manga-chapter-summary-contract", completeResponseOracles: oracles, standaloneDefaults: true,
    sparseAndMissingChapters: true, missingDirectoryAndManifest: true, malformedJson: true, externalWrites: true, responseIsolation: true, identityAndOrder: true, chapterSummaryReuseIsRequestLocal: true, fileInputCacheBypassedForThisGate: true }));
  checks++;
}

async function verifyChapterHttpLifecycle() {
  const fixture = fresh("chapter-http");
  const directory = addBook(fixture, 1);
  const chapters = path.join(directory, "chapters");
  const chapterDirectory = path.join(chapters, "001");
  const imageDirectory = path.join(chapterDirectory, "images");
  for (const owned of [chapters, chapterDirectory, imageDirectory]) mkdir(owned);
  const imagePath = path.join(imageDirectory, "001.png");
  const png = Buffer.alloc(24);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(png);
  png.writeUInt32BE(720, 16);
  png.writeUInt32BE(1080, 20);
  write(imagePath, png);

  const events = new EventEmitter();
  const event = name => once(events, name, { signal: AbortSignal.timeout(5000) });
  const releaseStat = Promise.withResolvers();
  const { stat, open } = fs.promises;
  let heldStat;
  let imageOpens = 0;
  let cacheReads = 0;
  const writes = [];
  const routeErrors = [];
  fs.promises.stat = function (file, ...args) {
    if (file === imagePath && !heldStat) {
      heldStat = releaseStat.promise.then(() => stat.call(this, file, ...args));
      events.emit("image-stat");
      return heldStat;
    }
    return stat.call(this, file, ...args);
  };
  fs.promises.open = function (file, ...args) {
    if (file === imagePath) imageOpens++;
    return open.call(this, file, ...args);
  };
  const client = new AbortController();
  const server = createServer((req, res) => {
    const url = new URL(req.url, "http://fixture");
    if (url.pathname === "/health") {
      res.end("ok");
      return;
    }
    const send = (status, data) => {
      writes.push(status);
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(data));
    };
    void routePhotosApi(req, res, url, {
      mangaService: fixture.service,
      imageReaderCacheStatus: async () => { cacheReads++; return { synthetic: true }; },
      notFound: () => send(404, { error: "missing" }),
      sendJson: (_res, status, data) => send(status, data)
    }).catch(error => {
      routeErrors.push(error);
      res.destroy(error);
    }).finally(() => {
      if (url.searchParams.has("held")) events.emit("held-settled");
    });
  });
  try {
    server.listen(0, "127.0.0.1");
    await once(server, "listening", { signal: AbortSignal.timeout(5000) });
    const base = `http://127.0.0.1:${server.address().port}`;
    const chapter = `${base}/api/manga/${fixture.service.publicSummary(directory).id}/chapters/`;
    const entered = event("image-stat");
    const pending = fetch(chapter + "1?held", { signal: AbortSignal.any([client.signal, AbortSignal.timeout(5000)]) })
      .then(response => ({ response }), error => ({ error }));
    await entered;
    const health = await fetch(base + "/health", { signal: AbortSignal.timeout(2000) });
    assert.equal(await health.text(), "ok", "a held page stat must leave the event loop responsive");
    assert.deepEqual(writes, []);
    const settled = event("held-settled");
    client.abort();
    await settled;
    assert.equal((await pending).error?.name, "AbortError");
    assert.deepEqual(writes, [], "an aborted chapter must not send a late response");
    assert.equal(cacheReads, 0, "an aborted chapter skips reader cache status");

    releaseStat.resolve();
    await heldStat;
    const found = await fetch(chapter + "1", { signal: AbortSignal.timeout(5000) });
    assert.equal(found.status, 200);
    const payload = await found.json();
    assert.equal(payload.chapter.images[0].width, 720);
    assert.equal(payload.chapter.images[0].height, 1080);
    assert.deepEqual(payload.cache, { synthetic: true });
    assert.equal(imageOpens, 1, "only the live retry opens the image after the held stat resolves");
    const missing = await fetch(chapter + "777", { signal: AbortSignal.timeout(5000) });
    assert.equal(missing.status, 404);
    await missing.json();
    assert.deepEqual(writes, [200, 404]);
    assert.deepEqual(routeErrors, []);
  } finally {
    client.abort();
    releaseStat.resolve();
    await heldStat?.catch(() => {});
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    fs.promises.stat = stat;
    fs.promises.open = open;
  }

  for (const code of ["MANGA_DIMENSIONS_BUSY", "MANGA_DIMENSIONS_STOPPED"]) {
    const req = Object.assign(new EventEmitter(), { method: "GET" });
    const headers = {};
    const res = Object.assign(new EventEmitter(), { setHeader: (name, value) => { headers[name] = value; } });
    let response;
    const route = await routePhotosApi(req, res, new URL("http://fixture/api/manga/test/chapters/1"), {
      mangaService: {
        cacheById: () => directory,
        publicSummary: () => ({ id: "test" }),
        async publicChapter() { throw Object.assign(new Error("private disk path"), { statusCode: 503, code }); }
      },
      imageReaderCacheStatus: () => assert.fail("no cache lookup on retryable admission failure"),
      notFound: () => assert.fail("admission failures must not look like missing chapters"),
      sendJson: (_res, status, payload) => { response = { status, payload }; }
    });
    assert.equal(route, true);
    assert.deepEqual(headers, { "Retry-After": "1" });
    assert.deepEqual(response, { status: 503, payload: { error: "暂时无法读取漫画章节，请稍后重试", code, retryable: true } });
    assert.equal(req.listenerCount("aborted"), 0);
    assert.equal(res.listenerCount("close"), 0);
  }
  console.log(JSON.stringify({ check: "manga-chapter-http-lifecycle", asyncPageStat: true, unrelatedHealth: true,
    disconnectCancelsRead: true, retryWithDimensions: true, missingIs404: true, admissionFailuresAre503: true }));
  checks++;
}

async function beforeReaderCacheFactory() {
  const sourceUrl = new URL("../src/modules/photos/server/manga-service.js", import.meta.url);
  const beforeSource = execFileSync("git", ["show", "f110040d02b1eb579461248da9960e97370fa4d2:src/modules/photos/server/manga-service.js"],
    { cwd: new URL("..", import.meta.url), encoding: "utf8", windowsHide: true });
  const moduleSource = beforeSource.replace(/from "(\.\.?\/[^"\n]+)"/g, (_match, relative) =>
    "from " + JSON.stringify(new URL(relative, sourceUrl).href));
  return (await import("data:text/javascript;base64," + Buffer.from(moduleSource).toString("base64"))).createMangaService;
}

async function observeManifest(file, run, afterRead = null) {
  const probe = { file, reads: 0, bytes: 0, afterRead };
  manifestReadProbe = probe;
  try { return { value: await run(), reads: probe.reads, bytes: probe.bytes }; }
  finally { manifestReadProbe = null; }
}

async function verifyManifestRequestReuse(options, directory, file, manifest, index) {
  const beforeFactory = await beforeReaderCacheFactory();
  const source = execFileSync("git", ["show", "f110040d02b1eb579461248da9960e97370fa4d2:src/modules/photos/server/routes.js"],
    { cwd: new URL("..", import.meta.url), encoding: "utf8", windowsHide: true });
  const { routePhotosApi: beforeRoute } = await import("data:text/javascript;base64," + Buffer.from(source).toString("base64"));
  const previous = beforeFactory(options), current = currentFactory(options);
  async function request(route, service, chapter = true) {
    const response = {};
    const url = new URL(`http://fixture/api/manga/${alias(directory)}${chapter ? `/chapters/${index}` : ""}`);
    assert(await route({ method: "GET" }, response, url, {
      mangaService: service, imageReaderCacheStatus: async () => ({}),
      notFound: res => Object.assign(res, { status: 404 }),
      sendJson: (res, status, data) => Object.assign(res, { status, data })
    }));
    return response;
  }
  const expectedChapter = await request(beforeRoute, previous);
  const summary = current.publicSummary(directory);
  assert.deepEqual([directory, directory].map(current.publicSummary), [summary, summary], "publicSummary remains usable as an Array.map callback");
  for (const chapter of [true, false]) {
    const expected = await request(beforeRoute, previous, chapter);
    assert.equal(JSON.stringify(await request(routePhotosApi, current, chapter)), JSON.stringify(expected), "complete route response retains fields and order");
    const beforeTimes = [], afterTimes = [];
    async function sample(route, service, expectedReads, times) {
      const start = performance.now();
      const result = await observeManifest(file, () => request(route, service, chapter));
      times.push(performance.now() - start);
      assert.equal(result.value.status, 200);
      assert.equal(result.reads, expectedReads);
      assert.equal(result.bytes, expectedReads * Buffer.byteLength(manifest));
    }
    const beforeReads = chapter ? 3 : 2;
    for (let round = 0; round < 7; round++) {
      if (round % 2) await sample(routePhotosApi, current, 1, afterTimes);
      await sample(beforeRoute, previous, beforeReads, beforeTimes);
      if (!(round % 2)) await sample(routePhotosApi, current, 1, afterTimes);
    }
    const median = values => +values.sort((a, b) => a - b)[3].toFixed(2);
    console.log(JSON.stringify({ check: "manga-request-manifest-reuse", route: chapter ? "chapter" : "detail", chapters: 1000,
      beforeReads, afterReads: 1, manifestBytes: Buffer.byteLength(manifest),
      beforeMedianMs: median(beforeTimes), afterMedianMs: median(afterTimes), completeResponseOracle: true }));
  }

  const changed = JSON.parse(manifest);
  changed.chapters.find(chapter => chapter.index === index).title = "新的章节标题";
  changed.chapters.shift();
  const inFlight = await observeManifest(file, () => request(routePhotosApi, current), () => write(file, JSON.stringify(changed)));
  assert.equal(inFlight.reads, 1);
  assert.deepEqual(inFlight.value, expectedChapter, "a rewrite after the first read cannot mix manifest versions in one chapter response");
  const next = await request(routePhotosApi, current);
  assert.deepEqual(next, await request(beforeRoute, previous));
  assert.equal(next.data.chapter.title, "新的章节标题");
  assert.equal(next.data.chapter.navigation.total, changed.chapters.length);
  write(file, manifest);
  await verifyManifestListSummary(options, file, manifest, previous);
}

async function verifyManifestListSummary(options, file, manifest, previous) {
  const current = currentFactory(options);
  const edited = manifest.replace('"status":"done"', '"status":"wait"');
  assert.notEqual(edited, manifest);
  assert.equal(Buffer.byteLength(edited), Buffer.byteLength(manifest));
  const fixedTime = new Date("2026-01-01T00:00:00Z");
  fs.utimesSync(file, fixedTime, fixedTime);
  const rewrite = (contents) => { write(file, contents); fs.utimesSync(file, fixedTime, fixedTime); };
  async function list(mangaService) {
    const response = {};
    assert(await routePhotosApi({ method: "GET" }, response, new URL("http://fixture/api/manga"), {
      mangaService, imageReaderCacheStatus: async () => ({}),
      sendJson: (res, status, data) => Object.assign(res, { status, data })
    }));
    return response;
  }
  const expected = await list(previous);
  const cold = await observeManifest(file, () => list(current));
  const warm = await observeManifest(file, () => list(current));
  assert.equal(cold.reads, 1);
  assert.equal(warm.reads, 0, "warm manga lists reuse only the file summary");
  assert.equal(JSON.stringify(cold.value), JSON.stringify(expected));
  assert.equal(JSON.stringify(warm.value), JSON.stringify(expected));

  rewrite(edited);
  const editedPage = await observeManifest(file, () => list(current));
  assert.equal(editedPage.reads, 1, "same-length, same-mtime edits must invalidate the summary");
  assert.equal(editedPage.value.data.comics[0].doneChapterCount, expected.data.comics[0].doneChapterCount - 1);
  assert.deepEqual(editedPage.value, await list(previous));

  rewrite(manifest);
  const racing = await observeManifest(file, () => list(current), () => rewrite(edited));
  assert.deepEqual(racing.value, expected, "an in-flight rewrite does not change the parsed result");
  const afterRace = await observeManifest(file, () => list(current));
  assert.equal(afterRace.reads, 1, "a changed manifest is not retained under a stale stamp");
  assert.deepEqual(afterRace.value, editedPage.value);

  rewrite(manifest);
  const failed = await observeManifest(file, () => list(current), () => { throw new Error("synthetic transient read failure"); });
  assert.equal(failed.value.data.comics[0].chapterCount, 0);
  const recovered = await observeManifest(file, () => list(current));
  assert.equal(recovered.reads, 1, "a failed read does not poison later summaries of the same file");
  assert.deepEqual(recovered.value, expected);
  console.log(JSON.stringify({ check: "manga-manifest-list-summary", warmReads: warm.reads, chapters: expected.data.comics[0].chapterCount,
    sameSizeMtimeRewrite: true, inFlightRewrite: true, transientReadRecovery: true, completeResponseOracle: true }));
  checks++;
}

async function verifyChapterNavigationCache() {
  const beforeFactory = await beforeReaderCacheFactory();
  for (const total of [1000, 10000]) {
    const fixture = fresh(`chapter-navigation-${total}`, { wal: true });
    const dir = addBook(fixture, 1);
    const { db, service } = fixture;
    const previous = beforeFactory({ root: fixture.root, databasePath: fixture.dbPath, mimeTypes: {}, normalizeExt: path.extname,
      safeStat(file) { try { return fs.statSync(file); } catch { return null; } } });
    const insert = db.prepare("INSERT INTO manga_chapters(cache_key,chapter_index,title,image_count,downloaded_count,status) VALUES (?,?,?,1,1,'done')");
    db.exec("BEGIN IMMEDIATE");
    // A zero index precedes chapter 1 and maps to the same public ordinal.
    // Subsequent indexes are sparse, so the positions cannot be inferred from IDs.
    insert.run(dir, 0, "Legacy ordinal");
    for (let i = 2; i < total; i++) insert.run(dir, i * 2, `合成章节 ${i}`);
    db.prepare("UPDATE manga_comics SET chapter_count=? WHERE cache_key=?").run(total, dir);
    db.exec("COMMIT");

    const id = service.publicSummary(dir).id;
    async function request(owner, index) {
      const response = {};
      await routePhotosApi({ method: "GET" }, response, new URL(`http://fixture/api/manga/${id}/chapters/${index}`), {
        mangaService: owner, imageReaderCacheStatus: async () => ({}),
        notFound: res => Object.assign(res, { status: 404 }),
        sendJson: (res, status, data) => Object.assign(res, { status, data })
      });
      return response;
    }
    async function compare(index) {
      const actual = await request(service, index);
      const expected = await request(previous, index);
      assert.deepEqual(actual, expected);
      assert.equal(JSON.stringify(actual), JSON.stringify(expected), "retain complete chapter route field order and values");
      return actual;
    }
    const first = await compare(1);
    assert.equal(first.data.chapter.navigation.position, 1);
    assert.equal(first.data.chapter.navigation.next.index, 1);
    first.data.chapter.navigation.next.title = "must not leak back into the cache";
    for (const index of [0, 1, total, (total - 1) * 2, total + 1, "missing"]) await compare(index);

    function median(samples) { return +samples.sort((a, b) => a - b)[Math.floor(samples.length / 2)].toFixed(3); }
    const before = [], after = [];
    async function sample(owner, index, expectedRows, samples) {
      counts = freshCounts(); measured = true;
      const began = performance.now();
      let response;
      try { response = await request(owner, index); }
      finally { measured = false; }
      samples.push(performance.now() - began);
      assert.equal(response.status, 200);
      assert.equal(counts.chapterRows, expectedRows, "warm navigation must not materialize the chapter directory");
      assert.equal(counts.librarySqlReads, 0, "warm lookup must not read the comic catalog");
    }
    for (let round = 0; round < 11; round++) {
      const index = total + round * 2;
      if (round % 2) await sample(service, index, 0, after);
      await sample(previous, index, total, before);
      if (!(round % 2)) await sample(service, index, 0, after);
    }

    db.prepare("UPDATE manga_chapters SET title='外部提交' WHERE cache_key=? AND chapter_index=?").run(dir, total + 2);
    const refreshed = await compare(total);
    assert.equal(refreshed.data.chapter.navigation.next.title, "外部提交");
    db.prepare("DELETE FROM manga_chapters WHERE cache_key=? AND chapter_index=?").run(dir, total + 2);
    afterChapterRowsRead = () => insert.run(dir, total + 1, "构建期间提交");
    const inFlight = await request(service, total);
    assert.equal(inFlight.data.chapter.navigation.next.index, total + 4, "the in-flight read uses the chapter list it actually read");
    assert.equal(afterChapterRowsRead, null);
    const afterWrite = await compare(total);
    assert.equal(afterWrite.data.chapter.navigation.next.index, total + 1, "the invalidated build cannot publish stale rows under a new WAL version");

    db.prepare("UPDATE manga_chapters SET failed_count=9223372036854775807 WHERE cache_key=? AND chapter_index=0").run(dir);
    assert.equal((await compare(total)).data.chapter.navigation.total, 1, "unsafe native full-row read still uses the target-only fallback");
    db.prepare("UPDATE manga_chapters SET failed_count=0 WHERE cache_key=? AND chapter_index=0").run(dir);
    await compare(total);
    await sample(service, total, 0, []);

    db.prepare("UPDATE manga_chapters SET title=? WHERE cache_key=? AND chapter_index=0").run("x".repeat(256 * 1024), dir);
    await compare(total);
    await sample(service, total, total, []);
    db.prepare("UPDATE manga_chapters SET title='Legacy ordinal' WHERE cache_key=? AND chapter_index=0").run(dir);
    await compare(total);
    const runtime = createPhotosRuntime({ mangaService: service, photoSetService: {} });
    await runtime.stop();
    const stopped = await request(service, total);
    assert.equal(stopped.status, 503);
    assert.equal(stopped.data.code, "MANGA_DIMENSIONS_STOPPED");
    await runtime.start();
    await sample(service, total, total, []);
    console.log(JSON.stringify({ check: "manga-chapter-navigation-cache", chapters: total, beforeRows: total, afterRows: 0,
      beforeMedianMs: median(before), afterMedianMs: median(after), completeResponseOracle: true,
      sparseAndLegacyOrdinals: true, externalWalWriteAndRace: true, readFailureAndRetry: true, retentionLimitAndStop: true }));
    checks++;
  }
}

async function verifyManifestImageChapterCache() {
  const fixture = fresh("manifest-image-cache", { wal: true });
  const directory = addBook(fixture, 1, { jsonOnly: true });
  const file = path.join(directory, "manifest.json");
  const image = (chapter, index) => ({ index, source_url: `https://fixture.invalid/chapter/${chapter}/image/${index}`,
    local_path: `chapters/${chapter}/images/${index}.png`, content_type: "image/png", bytes: 24, status: "downloaded" });
  const chapters = Array.from({ length: 1000 }, (_, index) => ({ index: index + 1, title: `Synthetic chapter ${index + 1}`,
    html_path: `chapters/${index + 1}/chapter.html`, images: Array.from({ length: 30 }, (_, item) => image(index + 1, item + 1)) }));
  const manifest = JSON.stringify({ chapters });
  write(file, manifest);
  const exactTime = new Date("2026-01-01T00:00:00Z");
  fs.utimesSync(file, exactTime, exactTime);
  const beforeFactory = await beforeReaderCacheFactory();
  function runtime(owner) {
    const mangaService = owner({ root: fixture.root, databasePath: fixture.dbPath, mimeTypes: {}, normalizeExt: path.extname,
      safeStat: file => fs.statSync(file, { throwIfNoEntry: false }),
      notFound: res => Object.assign(res, { status: 404 }),
      serveArchiveMemberImage: async (res, record) => Object.assign(res, { status: 200, record }) });
    return createPhotosRuntime({ mangaService, photoSetService: {} });
  }
  const previous = runtime(beforeFactory), current = runtime(currentFactory);
  async function request(owner, index = 1, chapter = 500) {
    const response = {};
    assert(await owner.routeMedia({ method: "GET" }, response, new URL(`http://fixture/media/manga/${alias(directory)}/${chapter}/${index}`)));
    return response;
  }
  async function compare(index = 1, chapter = 500) {
    const next = await request(current, index, chapter);
    assert.deepEqual(next, await request(previous, index, chapter), "same complete archive handoff or not-found response");
    return next;
  }
  const observe = (run, afterRead = null) => observeManifest(file, run, afterRead);
  assert.equal((await compare()).record.memberPath, "images/1.png");
  assert.deepEqual(await compare(31), { status: 404 });
  await compare(1, 501);
  assert.equal((await observe(() => request(current))).reads, 1, "retain only the most recent manifest chapter");
  const samples = [[], []];
  async function sample(owner, expectedReads, times) {
    const start = performance.now();
    const result = await observe(async () => {
      for (let index = 1; index <= 30; index++) assert.equal((await request(owner, index)).record.memberPath, `images/${index}.png`);
    });
    times.push(performance.now() - start);
    assert.equal(result.reads, expectedReads);
    assert.equal(result.bytes, expectedReads * Buffer.byteLength(manifest));
  }
  for (let round = 0; round < 5; round++) {
    if (round % 2) await sample(current, 0, samples[1]);
    await sample(previous, 30, samples[0]);
    if (!(round % 2)) await sample(current, 0, samples[1]);
  }
  await current.stop();
  assert.equal((await observe(() => request(current))).reads, 1, "photos stop releases the retained manifest chapter");

  const changed = manifest.replace("chapters/500/images/1.png", "chapters/500/images/a.png");
  const sameStamp = fs.statSync(file).mtimeMs;
  const backup = path.join(directory, "previous-manifest.json");
  fs.renameSync(file, backup);
  write(file, changed);
  fs.utimesSync(file, exactTime, exactTime);
  assert.equal(fs.statSync(file).mtimeMs, sameStamp);
  assert.equal(Buffer.byteLength(changed), Buffer.byteLength(manifest));
  assert.equal((await compare()).record.memberPath, "images/a.png", "same-mtime, same-size replacement changes the image source");

  write(file, manifest);
  const inFlight = await observe(() => request(current), () => write(file, changed));
  assert.equal(inFlight.value.record.memberPath, "images/1.png");
  assert.equal((await compare()).record.memberPath, "images/a.png", "a changed source during the read is not cached as the replacement");
  write(file, "null");
  await assert.rejects(() => request(current), { name: "TypeError" });
  await assert.rejects(() => request(previous), { name: "TypeError" });
  write(file, JSON.stringify({ chapters: [{ ...chapters[499], images: [{ ...image(500, 1), local_path: "../outside.png" }] }] }));
  assert.deepEqual(await compare(), { status: 404 }, "cached metadata still passes the same path validation");
  assert.deepEqual(await compare(), { status: 404 });
  write(file, JSON.stringify({ chapters: [{ ...chapters[499], images: Array.from({ length: 513 }, (_, i) => image(500, i + 1)) }] }));
  await compare();
  assert.equal((await observe(() => request(current))).reads, 1, "oversized chapters use uncached reads");
  write(file, manifest);
  await compare();
  fixture.db.prepare("INSERT INTO manga_comics(cache_key,dir_name,site,title,source_url) VALUES (?,?,'smtt6','SQLite book',?)")
    .run(directory, path.basename(directory), "https://synthetic.invalid/book/1");
  fixture.db.prepare("INSERT INTO manga_chapters(cache_key,chapter_index,title,html_path) VALUES (?,500,'SQLite chapter','chapters/500/chapter.html')").run(directory);
  fixture.db.prepare("INSERT INTO manga_images(cache_key,chapter_index,image_index,local_path,content_type) VALUES (?,500,1,'chapters/500/images/sqlite.png','image/png')").run(directory);
  assert.equal((await compare()).record.memberPath, "images/sqlite.png", "new database rows take precedence over a warm manifest entry");
  const median = values => +values.sort((a, b) => a - b)[2].toFixed(2);
  console.log(JSON.stringify({ check: "manga-manifest-image-chapter-cache", chapters: 1000, requests: 30,
    beforeReads: 30, afterReads: 0, beforeBytes: 30 * Buffer.byteLength(manifest), afterBytes: 0,
    beforeMedianMs: median(samples[0]), afterMedianMs: median(samples[1]), fullMediaRouteOracle: true,
    sourceReplacementRace: true, pathValidationAndSqlitePriority: true, capacityAndStop: true }));
  checks++;
}

function isOwned(file) { return typeof file === "string" && file.startsWith(temporary + path.sep); }
function mkdir(directory) { assert.ok(isOwned(directory)); fs.mkdirSync(directory); ownedDirectories.push(directory); }
function write(file, value) { assert.ok(isOwned(file)); fs.writeFileSync(file, value); }
function expectedId(url, dir) { return `manga_${createHash("sha256").update(String(url || path.resolve(dir)).trim()).digest("base64url").slice(0, 18)}`; }
function alias(dir) { return `mg_${Buffer.from(path.resolve(dir)).toString("base64url")}`; }
function fresh(name, { wal = false, duplicateKeys = false } = {}) {
  const root = path.join(temporary, name); mkdir(root);
  const dbPath = path.join(root, "manga.sqlite"); const db = new DatabaseSync(dbPath); handles.add(db);
  if (wal) db.exec("PRAGMA journal_mode=WAL");
  db.exec(duplicateKeys ? schema.replace("cache_key TEXT PRIMARY KEY", "cache_key TEXT") : schema);
  const service = factory({ root, databasePath: dbPath, projectRoot: path.resolve(import.meta.dirname, ".."), mimeTypes: {},
    normalizeExt: value => path.extname(String(value)).toLowerCase(),
    notFound() { assert.fail("known synthetic image must exist"); },
    safeStat(file) { try { return fs.statSync(file); } catch { return null; } },
    async serveArchiveMemberImage(_response, record) {
      assert.ok(record.fallbackPath.startsWith(root + path.sep)); assert.equal(record.sourceType, "manga");
      assert.equal(record.contentType, "image/png"); served += 1;
    }
  });
  return { root, dbPath, db, service };
}
function addBook(fixture, index, { sourceUrl = `https://synthetic.invalid/book/${index}`, jsonOnly = false, emptyManifest = false, name = `smtt6_cache_${String(index).padStart(5, "0")}`, downloaded = 1 } = {}) {
  const dir = path.join(fixture.root, name); mkdir(dir);
  write(path.join(dir, "catalog.json"), JSON.stringify({ title: `合成${index}`, author: "合成作者", url: sourceUrl }));
  if (!emptyManifest) write(path.join(dir, "manifest.json"), JSON.stringify({ chapters: [] }));
  if (!jsonOnly) {
    fixture.db.prepare("INSERT INTO manga_comics(cache_key,dir_name,site,title,source_url,chapter_count,done_chapter_count,image_count,downloaded_count) VALUES (?,?,?,?,?,1,1,1,?)")
      .run(dir, name, "smtt6", `合成${index}`, sourceUrl, downloaded);
    if (!emptyManifest) {
      fixture.db.prepare("INSERT INTO manga_chapters(cache_key,chapter_index,title,image_count,downloaded_count,status) VALUES (?,1,'合成章节',1,1,'done')").run(dir);
      fixture.db.prepare("INSERT INTO manga_images(cache_key,chapter_index,image_index,local_path,content_type,bytes,status) VALUES (?,1,1,'chapters/001/images/001.png','image/png',24,'downloaded')").run(dir);
    }
  }
  return dir;
}
async function measure(name, run) {
  counts = freshCounts();
  measured = true; const began = performance.now();
  try { await run(); const result = { name, elapsedMs: +(performance.now() - began).toFixed(2), ...counts }; console.log(JSON.stringify(result)); return result; }
  finally { measured = false; }
}
function freshCounts() {
  return { prepares: 0, sqlReads: 0, librarySqlReads: 0, chapterRows: 0, jsonReads: 0, htmlReads: 0, metadataBytes: 0, statCalls: 0, existsCalls: 0, directoryScans: 0 };
}
function warmGate(result, requests) {
  if (diagnose) return;
  assert.ok(result.sqlReads <= 8 * requests, `${result.name} repeats library-wide SQL: ${result.sqlReads}`);
  assert.equal(result.librarySqlReads, 0, `${result.name} rereads a whole-library SQL catalog`);
  assert.ok(result.jsonReads <= 8 * requests, `${result.name} rereads unrelated catalogs: ${result.jsonReads}`);
  assert.ok(result.statCalls + result.existsCalls <= 64 * requests, `${result.name} stats unrelated library entries`);
  assert.equal(result.directoryScans, 0, `${result.name} scans a known library again`);
}
function verifyInvalidation(fixture, target, initialId) {
  const { service, db } = fixture;
  const originalManifest = fs.readFileSync(path.join(target, "manifest.json"));
  fs.unlinkSync(path.join(target, "manifest.json"));
  assert.equal(service.cacheById(initialId), null, "removing a known manifest invalidates a positive lookup");
  write(path.join(target, "manifest.json"), originalManifest);
  assert.equal(service.cacheById(initialId), target, "restoring a known manifest does not leave an immortal negative lookup");
  checks += 1;
  const empty = addBook(fixture, 2000, { jsonOnly: true, emptyManifest: true });
  const emptyId = expectedId("https://synthetic.invalid/book/2000", empty);
  assert.equal(service.cacheById(emptyId), null);
  write(path.join(empty, "manifest.json"), JSON.stringify({ chapters: [] }));
  assert.equal(service.cacheById(emptyId), empty, "an existing empty cache directory becoming ready must be discovered");
  checks += 1;
  const fallback = addBook(fixture, 2001, { jsonOnly: true });
  const first = expectedId("https://synthetic.invalid/book/2001", fallback);
  assert.equal(service.cacheById(first), fallback);
  write(path.join(fallback, "catalog.json"), JSON.stringify({ title: "改名", author: "新作者", url: "https://synthetic.invalid/edited" }));
  assert.equal(service.cacheById(first), null, "editing an existing catalog URL invalidates its old opaque ID");
  const second = expectedId("https://synthetic.invalid/edited", fallback);
  assert.equal(service.cacheById(second), fallback); assert.equal(service.publicSummary(fallback).author, "新作者");
  write(path.join(fallback, "catalog.json"), JSON.stringify({ title: "manifest fallback", url: "" }));
  write(path.join(fallback, "manifest.json"), JSON.stringify({ chapters: [{ url: "https://smtt6.com/man-hua-yue-du/fallback/001.html" }] }));
  const third = expectedId("https://smtt6.com/man-hua-yue-du/fallback.html", fallback);
  assert.equal(service.cacheById(second), null); assert.equal(service.cacheById(third), fallback);
  assert.equal(service.publicSummary(fallback).sourceUrl, "", "manifest source inference changes identity without inventing a catalog URL in the legacy DTO");
  write(path.join(fallback, "manifest.json"), JSON.stringify({ chapters: [{ url: "https://smtt6.com/man-hua-yue-du/revised/001.html" }] }));
  const fourth = expectedId("https://smtt6.com/man-hua-yue-du/revised.html", fallback);
  assert.equal(service.cacheById(third), null); assert.equal(service.cacheById(fourth), fallback, "manifest-only source edits are visible without root-directory edits");
  checks += 1;
  db.prepare("UPDATE manga_comics SET source_url=? WHERE cache_key=?").run("https://synthetic.invalid/sql-edited", target);
  const changed = expectedId("https://synthetic.invalid/sql-edited", target);
  assert.equal(service.cacheById(initialId), null); assert.equal(service.cacheById(changed), target);
  db.prepare("DELETE FROM manga_comics WHERE cache_key=?").run(target);
  assert.equal(service.cacheById(changed), null); assert.equal(service.cacheById(initialId), target, "deleted SQL metadata falls back to the current JSON source");
  checks += 1;
  const duplicate = addBook(fixture, 2002, { sourceUrl: "https://synthetic.invalid/book/0", name: "smtt6_cache_00000_full", downloaded: 2 });
  const duplicateId = expectedId("https://synthetic.invalid/book/0", duplicate);
  assert.equal(service.cacheById(duplicateId), duplicate, "more downloaded duplicate wins");
  assert.equal(service.cacheById(alias(path.join(fixture.root, "smtt6_cache_00000"))), null, "legacy aliases must not bypass winner selection");
  assert.equal(service.cacheById(alias(duplicate)), duplicate);
  db.prepare("UPDATE manga_comics SET downloaded_count=1 WHERE cache_key=?").run(duplicate);
  assert.equal(service.cacheById(duplicateId), path.join(fixture.root, "smtt6_cache_00000"), "a tie preserves original numeric directory order");
  checks += 1;
  const upper = addBook(fixture, 2003, { sourceUrl: "https://Synthetic.invalid/Book/ONE/" });
  const lower = addBook(fixture, 2004, { sourceUrl: "https://synthetic.invalid/book/one" });
  const upperId = expectedId("https://Synthetic.invalid/Book/ONE/", upper);
  const lowerId = expectedId("https://synthetic.invalid/book/one", lower);
  assert.notEqual(upperId, lowerId); assert.equal(service.cacheById(upperId), upper); assert.equal(service.cacheById(lowerId), lower);
  const whitespace = addBook(fixture, 2005, { sourceUrl: "https://synthetic.invalid/catalog-precedence" });
  db.prepare("UPDATE manga_comics SET source_url='   ' WHERE cache_key=?").run(whitespace);
  write(path.join(whitespace, "manifest.json"), JSON.stringify({ chapters: [{ url: "https://smtt6.com/man-hua-yue-du/space/001.html" }] }));
  assert.equal(service.cacheById(expectedId("https://synthetic.invalid/catalog-precedence", whitespace)), null, "a truthy whitespace SQL URL preserves the original trim-then-manifest fallback");
  assert.equal(service.cacheById(expectedId("https://smtt6.com/man-hua-yue-du/space.html", whitespace)), whitespace);
  checks += 1;
}
function verifyCrossRootIdentity() {
  const a = fresh("root-a"); const b = fresh("root-b");
  const aDir = addBook(a, 1, { jsonOnly: true, sourceUrl: "" }); const bDir = addBook(b, 1, { jsonOnly: true, sourceUrl: "" });
  const aId = expectedId("", aDir); const bId = expectedId("", bDir);
  assert.notEqual(aId, bId); assert.equal(a.service.cacheById(aId), aDir); assert.equal(b.service.cacheById(bId), bDir);
  assert.equal(a.service.cacheById(bId), null); assert.equal(b.service.cacheById(aId), null);
  checks += 1;
}
function verifyDuplicateLegacySqlKey() {
  const fixture = fresh("duplicate-key", { duplicateKeys: true });
  const dir = addBook(fixture, 1, { jsonOnly: true });
  const insert = fixture.db.prepare("INSERT INTO manga_comics(cache_key,dir_name,site,title,source_url) VALUES (?,?,'smtt6',?,?)");
  insert.run(dir, path.basename(dir), "first", "https://synthetic.invalid/first");
  insert.run(dir, path.basename(dir), "second", "https://synthetic.invalid/second");
  const first = expectedId("https://synthetic.invalid/first", dir);
  assert.equal(fixture.service.publicSummary(dir).title, "first");
  assert.equal(fixture.service.cacheById(first), dir);
  assert.equal(fixture.service.cacheById(expectedId("https://synthetic.invalid/second", dir)), null, "a bulk Map must preserve SELECT.get first-row semantics in a legacy schema");
  checks += 1;
}
function verifyDatabaseReplacement() {
  const fixture = fresh("replacement");
  const dir = addBook(fixture, 1); const oldId = expectedId("https://synthetic.invalid/book/1", dir);
  fixture.db.close();
  const exactTime = new Date(Math.floor(Date.now() / 1000) * 1000);
  fs.utimesSync(fixture.dbPath, exactTime, exactTime);
  const beforeReaders = new Set(handles);
  assert.equal(fixture.service.cacheById(oldId), dir);
  const retainedReaders = [...handles].filter(database => !beforeReaders.has(database));
  assert.equal(retainedReaders.length, 1, "capture only this private service's actual read connection");
  assert.ok(fixture.service.publicDetail(dir).coverUrl.endsWith("/1/1"), "prime both firstImage statements before replacing their connection");
  const before = fs.statSync(fixture.dbPath);
  const replacement = path.join(fixture.root, "replacement.sqlite");
  const next = new DatabaseSync(replacement); handles.add(next);
  next.exec(schema);
  next.prepare("INSERT INTO manga_comics(cache_key,dir_name,site,title,source_url) VALUES (?,?,'smtt6','replacement',?)")
    .run(dir, path.basename(dir), "https://synthetic.invalid/replacement");
  next.prepare("INSERT INTO manga_chapters(cache_key,chapter_index,title) VALUES (?,77,'replacement chapter')").run(dir);
  next.prepare("INSERT INTO manga_images(cache_key,chapter_index,image_index,local_path) VALUES (?,77,9,'replacement.jpg')").run(dir);
  next.close();
  fs.utimesSync(replacement, before.atime, before.mtime);
  assert.equal(fs.statSync(replacement).mtimeMs, before.mtimeMs, "the replacement keeps exactly the old mtime, rather than a rounded approximation");
  const backup = path.join(fixture.root, "previous.sqlite");
  for (const file of [fixture.dbPath, replacement, backup]) assert.equal(path.dirname(path.resolve(file)), fixture.root);
  // Windows forbids renaming a file with a live SQLite read handle. Close the
  // captured fixture connection while deliberately retaining the service's
  // internal state and index: only its file-identity gate can reopen correctly.
  for (const database of retainedReaders) database.close();
  fs.renameSync(fixture.dbPath, backup); fs.renameSync(replacement, fixture.dbPath);
  const newId = expectedId("https://synthetic.invalid/replacement", dir);
  assert.equal(fixture.service.cacheById(oldId), null, "same-mtime file replacement must not retain an old SQLite reader or index");
  assert.equal(fixture.service.cacheById(newId), dir);
  const replacedSummary = fixture.service.publicSummary(dir);
  assert.equal(replacedSummary.title, "replacement");
  assert.ok(replacedSummary.coverUrl.endsWith("/77/9"), "the first response after replacement must read the new cover through new statements");
  checks += 1;
}
async function legacyFactory() {
  const sourcePath = "src/modules/photos/server/manga-service.js";
  const readerPath = "src/modules/photos/server/manga-database.js";
  const read = relative => execFileSync("git", ["show", `${legacyRef}:${relative}`], { cwd: path.resolve(import.meta.dirname, ".."), encoding: "utf8", windowsHide: true });
  const readerUrl = `data:text/javascript;base64,${Buffer.from(read(readerPath)).toString("base64")}`;
  let source = read(sourcePath);
  assert.match(source, /for \(const dirPath of cacheDirs\(\)\)/, "negative source must contain the actual repeated lookup");
  source = source.replace(/(from\s+["'])(\.{1,2}\/[^"']+)(["'])/g, (_match, prefix, specifier, quote) => `${prefix}${specifier === "./manga-database.js" ? readerUrl : pathToFileURL(path.resolve(import.meta.dirname, "..", path.dirname(sourcePath), specifier)).href}${quote}`);
  return (await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`)).createMangaService;
}
