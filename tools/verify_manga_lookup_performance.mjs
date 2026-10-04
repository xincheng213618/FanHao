import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { DatabaseSync, StatementSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { createMangaService as currentFactory } from "../src/modules/photos/server/manga-service.js";
import { routePhotosApi } from "../src/modules/photos/server/routes.js";

// The legacy revision was checked against both clean manga source files before
// this optimization. It executes their actual code, not a rewritten baseline.
// --legacy must fail the warm lookup gate; --legacy --diagnose prints all scales.
const legacy = process.argv.includes("--legacy");
const diagnose = process.argv.includes("--diagnose");
const legacyRef = "1f6ddf213f0fbab4d417fdf61636b957d1909338";
const factory = legacy ? await legacyFactory() : currentFactory;
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "fanhao-manga-lookups-"));
const collector = fs.readFileSync(path.resolve(import.meta.dirname, "manga_collector.py"), "utf8");
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
DatabaseSync.prototype.prepare = function (statement, ...args) {
  handles.add(this);
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
  return originalExecutions[method].call(this, ...args);
};
fs.readFileSync = function (file, ...args) {
  if (measured && isOwned(file) && /^(catalog|manifest)\.json$/.test(path.basename(file))) counts.jsonReads += 1;
  return originalRead.call(this, file, ...args);
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
  // recursive operation, collector process, real server or real media is used.
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
  counts = { sqlReads: 0, librarySqlReads: 0, jsonReads: 0, statCalls: 0, existsCalls: 0, directoryScans: 0 };
  measured = true; const began = performance.now();
  try { await run(); const result = { name, elapsedMs: +(performance.now() - began).toFixed(2), ...counts }; console.log(JSON.stringify(result)); return result; }
  finally { measured = false; }
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
  const before = fs.statSync(fixture.dbPath);
  const replacement = path.join(fixture.root, "replacement.sqlite");
  const next = new DatabaseSync(replacement); handles.add(next);
  next.exec(schema);
  next.prepare("INSERT INTO manga_comics(cache_key,dir_name,site,title,source_url) VALUES (?,?,'smtt6','replacement',?)")
    .run(dir, path.basename(dir), "https://synthetic.invalid/replacement");
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
  assert.equal(fixture.service.cacheById(newId), dir); assert.equal(fixture.service.publicSummary(dir).title, "replacement");
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
