import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { PassThrough, Readable } from "node:stream";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createArchiveTaskPool, runArchiveChild } from "../src/platform/server/archive-task-pool.js";
import { createArchiveImageService, archiveDiskSignature } from "../src/platform/server/archive-image-service.js";
import { createImageReaderCacheService } from "../src/platform/server/image-reader-cache-service.js";
import { createImageGalleryDbService } from "../src/modules/content-index/server/image-gallery-db-service.js";
import { createPhotoSetService } from "../src/modules/photos/server/photo-set-service.js";
import { createImageLibraryIndexService } from "../src/modules/content-index/server/image-library-index-service.js";
import { CURRENT_INDEX_SCHEMA, PARSER_VERSION, imageLibraryCacheIdentity } from "../src/modules/content-index/server/image-library-index-contract.js";
import { createServerHost } from "../src/platform/server/server-host.js";
import { createFileServer } from "../src/platform/server/file-server.js";
import http from "node:http";
import crypto from "node:crypto";
import { types } from "node:util";
import { routePhotosApi } from "../src/modules/photos/server/routes.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "fanhao-archive-lifecycle-"));
const databases = [], services = [];
const inlineCase = process.argv.find(value => value.startsWith("--case="))?.slice(7) || "";
let archiveFactory = createArchiveImageService;
if (process.argv.includes("--without-inline-stream-owner") || process.argv.includes("--without-inline-validation")) {
  const file = path.join(projectRoot, "src/platform/server/archive-image-service.js");
  let source = fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n");
  if (process.argv.includes("--without-inline-stream-owner")) {
    source = source.replace('await pool.run(`stream:${crypto.randomUUID()}`, async context => {', 'await (async context => {')
      .replace('}, { signal: controller.signal, waitForCloseOnAbort: true });', '})({ signal: controller.signal, isCurrent: () => true });');
  }
  if (process.argv.includes("--without-inline-validation")) source = source.replace('await prepared.validate?.({ isCurrent });', '/* Controlled missing final cache/source validation. */');
  source = source.replace(/from\s+(["'])(\.[^"']+)\1/g, (_match, _quote, relative) =>
    `from ${JSON.stringify(pathToFileURL(path.resolve(path.dirname(file), relative)).href)}`);
  archiveFactory = (await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`)).createArchiveImageService;
}
let scenarios = 0;
function gate() { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; }
const tick = () => new Promise(resolve => setImmediate(resolve));
async function until(check, label) { const deadline=Date.now()+5000; while(Date.now()<deadline){if(check())return;await new Promise(resolve=>setTimeout(resolve,1));}assert.fail(`Did not reach ${label}`); }
const outcome = promise => promise.then(value => ({ value }), error => ({ error }));
function stat(overrides = {}) { return { size: 7, mtimeMs: 123.125, dev: 1, ino: 10, isFile: () => true, ...overrides }; }
function fakeChild() { const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kills = 0; child.kill = () => { child.kills++; return true; }; return child; }
function response() { const res = new EventEmitter(); res.destroyed = false; res.writableEnded = false; res.writeHead = code => { res.statusCode = code; }; res.end = value => { res.body = value; res.writableEnded = true; }; return res; }
function galleryDb(dbPath = ":memory:") { const service = createImageGalleryDbService({ dbPath, ensureDataDir() {} }); databases.push(service); return service.getDb(); }
function archiveService(options = {}) {
  const service = archiveFactory({ archiveImageExts: new Set([".jpg"]), coverBoxSize: 480, coverMaxBytes: 1024,
    pythonPath: process.execPath, helperPath: path.join(projectRoot, "tests/fixtures/archive_image_helper_fixture.mjs"), ffmpegPath: process.execPath,
    projectRoot, imageReaderCacheService: { rootDir: path.join(temporary, "reader"), touch: async () => {}, scheduleCleanup() {} },
    normalizeExt: value => path.extname(value).toLowerCase(), mimeTypes: { ".jpg": "image/jpeg" }, getImageGalleryDb: () => galleryDb(),
    notFound: res => res.end("missing"), sendText: (res,code,message) => { res.writeHead(code); res.end(message); }, serveInlineFile: () => true,
    warn() {}, ...options }); services.push(service); return service;
}

async function verifyBoundedPool() {
  const pool = createArchiveTaskPool({ concurrency: 2, capacity: 4, stopTimeoutMs: 20 });
  const held = gate(); let starts = 0;
  const controllers = Array.from({ length: 4 }, () => new AbortController());
  const jobs = controllers.map((controller,index) => outcome(pool.run(String(index), async () => { starts++; await held.promise; return index; }, { signal: controller.signal })));
  await until(() => starts === 2, "two metadata owners");
  await assert.rejects(pool.run("overflow", () => 0), error => error.code === "ARCHIVE_READER_BUSY");
  controllers[3].abort(); await jobs[3]; await tick(); assert.equal(pool.diagnostics().tasks, 3);
  controllers[0].abort(); assert.equal((await jobs[0]).error.code, "ARCHIVE_READER_STOPPED");
  assert.equal(pool.diagnostics().active, 2, "logical cancellation must retain physical metadata owner");
  const stopped = outcome(pool.stop()); assert.equal((await jobs[1]).error.statusCode, 503);
  assert.equal((await stopped).error.code, "ARCHIVE_READER_STOP_INCOMPLETE");
  assert.equal(pool.diagnostics().active, 2); assert.equal(starts, 2);
  await assert.rejects(pool.start(), error => error.code === "ARCHIVE_READER_STOP_INCOMPLETE");
  held.resolve(); await Promise.all(jobs); await until(() => pool.diagnostics().tasks === 0 && pool.diagnostics().active === 0, "physical drain");
  await pool.start(); assert.equal(await pool.run("fresh", () => 42), 42); await pool.stop();

  const shared = createArchiveTaskPool({ concurrency: 1, capacity: 3 }); const sharedGate = gate(); let reads = 0;
  const controller = new AbortController();
  const first = outcome(shared.run("same", async () => { reads++; await sharedGate.promise; return "shared"; }, { signal: controller.signal }));
  const second = shared.run("same", () => assert.fail("duplicate dispatched"));
  await until(() => reads === 1, "shared owner"); controller.abort(); assert.equal((await first).error.statusCode, 503);
  sharedGate.resolve(); assert.equal(await second, "shared"); await shared.stop();

  const retry = createArchiveTaskPool({ concurrency: 1, capacity: 2 }); const oldGate = gate(); const oldController = new AbortController(); let retryReads = 0;
  const old = outcome(retry.run("same", async () => { retryReads++; await oldGate.promise; }, { signal: oldController.signal }));
  await until(() => retryReads === 1, "old owner"); oldController.abort(); await old;
  const fresh = retry.run("same", () => { retryReads++; return "fresh"; });
  assert.equal(retry.diagnostics().tasks, 2); await tick(); assert.equal(retryReads, 1);
  await assert.rejects(retry.run("third", () => 0), error => error.statusCode === 503);
  oldGate.resolve(); assert.equal(await fresh, "fresh"); assert.equal(retryReads, 2); await retry.stop();
  scenarios += 3;
}

async function verifyChildCloseOwnership() {
  for (const mode of ["stdout-error", "stderr-error", "child-error", "overflow", "abort", "timeout"]) {
    const pool = createArchiveTaskPool({ concurrency: 1, capacity: 3, stopTimeoutMs: 20 });
    const children = []; const spawnProcess = () => { const child = fakeChild(); children.push(child); return child; };
    const controller = new AbortController();
    const job = outcome(pool.run("first", context => runArchiveChild("controlled", [], { spawnProcess, signal: context.signal, maxBytes: 4, timeoutMs: mode === "timeout" ? 1 : 1000 }), { signal: controller.signal }));
    const queued = outcome(pool.run("second", context => runArchiveChild("controlled", [], { spawnProcess, signal: context.signal })));
    await until(() => children.length === 1, `${mode} owner`); const child = children[0];
    if (mode.endsWith("error")) (mode === "child-error" ? child : mode === "stdout-error" ? child.stdout : child.stderr).emit("error", new Error(mode));
    else if (mode === "overflow") child.stdout.write(Buffer.alloc(5));
    else if (mode === "abort") controller.abort();
    else await new Promise(resolve => setTimeout(resolve, 5));
    assert(child.kills >= 1); await tick(); assert.equal(children.length, 1, `${mode} must retain slot until close`);
    assert.equal(pool.diagnostics().active, 1);
    const stopping = outcome(pool.stop()); assert.equal((await queued).error.statusCode, 503);
    assert.equal((await stopping).error.code, "ARCHIVE_READER_STOP_INCOMPLETE"); assert.equal(pool.diagnostics().tasks, 1);
    child.emit("close", 1, "SIGKILL"); assert((await job).error); await until(() => pool.diagnostics().active === 0, "child closed");
    await pool.start(); await pool.stop(); scenarios++;
  }
  const pool = createArchiveTaskPool({ stopTimeoutMs: 1000 }); const child = fakeChild(); const controller = new AbortController(); let finished = false;
  const nested = outcome(pool.run("nested", context => runArchiveChild("controlled", [], { spawnProcess: () => child, signal: context.signal }), { signal: controller.signal, waitForCloseOnAbort: true })).then(value => { finished = true; return value; });
  await tick(); controller.abort(); await tick(); assert.equal(finished,false, "nested temporary output user must await actual child close");
  const stop = pool.stop(); child.emit("close", 1); await nested; await stop; scenarios++;

  const lifecycle = createArchiveTaskPool({ stopTimeoutMs: 1000 }); const hold = gate();
  const active = outcome(lifecycle.run("held", () => hold.promise)); await tick(); const stopTask = lifecycle.stop();
  const staleStart = outcome(lifecycle.start()); lifecycle.beginStop(); hold.resolve(); await stopTask; await active;
  assert.equal((await staleStart).error.code, "ARCHIVE_READER_STOPPED"); assert.equal(lifecycle.diagnostics().accepting,false); await lifecycle.start(); await lifecycle.stop(); scenarios++;
}

async function verifyIndexAuthority() {
  const archivePath = path.join(temporary,"controlled.zip");
  for (const mode of ["inode", "precise-mtime", "database", "row", "clear", "stop"]) {
    const dbA = galleryDb(), dbB = galleryDb(); let currentDb = dbA, source = stat(), stats = 0; const final = gate(); let finalStarted = false;
    const service = archiveService({ getImageGalleryDb: () => currentDb,
      statFile: async () => { stats++; if (stats === 2) { finalStarted = true; await final.promise; } return source; },
      spawnProcess: () => { const child = fakeChild(); queueMicrotask(() => { child.stdout.write(JSON.stringify({ ok:true, imageCount:1, images:[{ path:"cover.jpg", bytes:3 }] })); child.emit("close",0); }); return child; } });
    const job = outcome(service.archiveImagesPayload(archivePath)); await until(() => finalStarted, `${mode} final stat`);
    if (mode === "inode") source = stat({ ino: 11 });
    if (mode === "precise-mtime") source = stat({ mtimeMs: 123.126 });
    if (mode === "database") currentDb = dbB;
    if (mode === "row") dbA.prepare("INSERT INTO photo_set_image_indexes(archive_path,images_json,updated_at) VALUES(?,?,?)").run(archivePath,'[{"path":"manual.jpg"}]',"manual");
    if (mode === "clear") service.clearListCache();
    if (mode === "stop") service.beginStop();
    final.resolve(); const result = await job;
    if (["inode","precise-mtime"].includes(mode)) assert.equal(result.error.code,"ARCHIVE_READER_SOURCE_CHANGED");
    if (["clear","stop"].includes(mode)) assert.equal(result.error.code,"ARCHIVE_READER_STOPPED");
    if (["database","row"].includes(mode)) assert.equal(result.value.images[0].path,"cover.jpg");
    const rowA = dbA.prepare("SELECT * FROM photo_set_image_indexes").all(), rowB = dbB.prepare("SELECT * FROM photo_set_image_indexes").all();
    assert.equal(rowB.length,0); assert.equal(rowA.length,mode === "row" ? 1 : 0); if (mode === "row") assert.equal(rowA[0].updated_at,"manual");
    await service.stop(); scenarios++;
  }
}

async function verifyOldSchemaAndZipIdentity() {
  const dbPath = path.join(temporary,"legacy.sqlite"); const oldService = createImageGalleryDbService({dbPath,ensureDataDir(){}});const legacy=oldService.getDb();
  legacy.exec("ALTER TABLE photo_set_covers DROP COLUMN archive_identity; ALTER TABLE photo_set_image_indexes DROP COLUMN archive_identity;");
  legacy.prepare("INSERT INTO photo_set_covers(album_id,archive_path,updated_at) VALUES(?,?,?)").run("legacy","old.zip","preserved"); oldService.close();
  const service = createImageGalleryDbService({ dbPath, ensureDataDir() {} }); databases.push(service); const db = service.getDb();
  for (const table of ["photo_set_covers","photo_set_image_indexes"]) assert(db.prepare(`PRAGMA table_info(${table})`).all().some(row => row.name === "archive_identity"));
  assert.equal(db.prepare("SELECT updated_at FROM photo_set_covers WHERE album_id='legacy'").get().updated_at,"preserved");
  const version = db.prepare("PRAGMA schema_version").get().schema_version; service.close(); assert.equal(service.getDb().prepare("PRAGMA schema_version").get().schema_version,version,"reopening unchanged schema must not repeat migration");
  const legacyPath=path.join(temporary,"empty-identity.zip"),legacyDb=service.getDb();let relists=0;
  legacyDb.prepare("INSERT INTO photo_set_image_indexes(archive_path,indexer_version,images_json,image_count,updated_at) VALUES(?,?,?,?,?)").run(legacyPath,3,'[{"path":"old.jpg"}]',1,"legacy");
  const legacyReader=archiveService({getImageGalleryDb:()=>legacyDb,statFile:async()=>stat(),spawnProcess:()=>{relists++;const child=fakeChild();queueMicrotask(()=>{child.stdout.write(JSON.stringify({ok:true,images:[{path:"fresh.jpg"}],imageCount:1}));child.emit("close",0);});return child;}});
  assert.equal((await legacyReader.archiveImagesPayload(legacyPath)).images[0].path,"fresh.jpg");assert.equal(relists,1,"current-version legacy row with empty physical identity must be a safe miss");await legacyReader.stop();scenarios++;

  const source = path.join(temporary,"identity.zip"); const replacement = path.join(temporary,"replacement.zip");
  fs.writeFileSync(source, storedZip("cover.jpg","AAA")); const original = fs.statSync(source); const served = [];
  const readerCache = createImageReaderCacheService({ rootDir:path.join(temporary,"zip-cache"),getMaxBytes:()=>1e6,cleanupTargetRatio:.8,cleanupIntervalMs:60000,warn() {} }); services.push(readerCache);
  const database = galleryDb(); const make = () => archiveService({ pythonPath:process.env.PYTHON || "python", helperPath:path.join(projectRoot,"tools/archive_image_reader.py"),getImageGalleryDb:()=>database,
    imageReaderCacheService:readerCache,serveInlineFile: (_res,file) => { served.push(fs.readFileSync(file,"utf8")); return true; } });
  const first = make(); await first.serveArchiveMemberImage(response(),{archivePath:source,memberPath:"cover.jpg",sourceType:"synthetic"}); await first.stop();
  fs.writeFileSync(replacement,storedZip("cover.jpg","BBB")); fs.utimesSync(replacement,original.atime,original.mtime); fs.renameSync(replacement,source);
  const changed = fs.statSync(source); assert.equal(changed.size,original.size); assert(Math.abs(changed.mtimeMs-original.mtimeMs)<1,"fixture preserves milliseconds"); assert.notEqual(String(changed.ino),String(original.ino));
  const second = make(); await second.serveArchiveMemberImage(response(),{archivePath:source,memberPath:"cover.jpg",sourceType:"synthetic"}); assert.deepEqual(served,["AAA","BBB"]);
  await second.stop(); scenarios += 2;
}


async function verifyPhotoDetailPaging() {
  const file = path.join(projectRoot, "src/modules/photos/server/photo-set-service.js");
  const source = fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n");
  const currentRequest = "      // The archive cache already owns the full list; copy only the visible page.\n      limit: 0,";
  const currentCount = "    const fallbackCount = imageLimit > 0 ? Math.min(images.length, imageOffset + imageLimit) : images.length;\n    const imageCount = Number(payload.imageCount || fallbackCount || 0);";
  assert(source.includes(currentRequest) && source.includes(currentCount), "paging oracle restores both changed expressions");
  const legacySource = source.replace(currentRequest, "      limit: imageLimit > 0 ? imageOffset + imageLimit : 0,")
    .replace(currentCount, "    const imageCount = Number(payload.imageCount || images.length || 0);")
    .replace(/from\s+(["'])(\.[^"']+)\1/g, (_match, _quote, relative) =>
      "from " + JSON.stringify(pathToFileURL(path.resolve(path.dirname(file), relative)).href));
  const legacyFactory = (await import("data:text/javascript;base64," + Buffer.from(legacySource).toString("base64"))).createPhotoSetService;
  const measuredFactory = process.argv.includes("--legacy-photo-detail-paging") ? legacyFactory : createPhotoSetService;
  const album = { id: "synthetic-paging", sourceRoot: path.resolve("synthetic"), relativePath: "paging.zip", extra: "retained" };
  const controller = new AbortController();
  const options = { safeChildPath: (root, relative) => path.resolve(root, relative), getImageLibraryIndex: () => ({ photoSets: [album] }), photoSetById: () => album };
  const smallImages = Array.from({ length: 7 }, (_, index) => ({ path: `folder/image-${index}.jpg`, name: index % 2 ? "" : `Image ${index}`, bytes: index % 2 ? String(index) : index }));
  const pages = [{}, { imageLimit: 2 }, { imageOffset: 3, imageLimit: 2 }, { imageOffset: 99, imageLimit: 2 },
    { imageOffset: 3, imageLimit: 0 }, { imageOffset: 3, imageLimit: -1 }, { imageOffset: -1, imageLimit: 3 },
    { imageOffset: 2.9, imageLimit: 1.9 }, { imageOffset: 3, imageLimit: 0.5 },
    { imageOffset: "bad", imageLimit: "bad" }, { imageOffset: Infinity, imageLimit: 2 }, { imageOffset: 2, imageLimit: Infinity }];
  let oracles = 0;
  for (const images of [smallImages, [], undefined, "invalid"]) for (const imageCount of [undefined, null, 0, NaN, false, "", "0", "bad", -1, 20, Infinity]) {
    const provider = async (_archivePath, request) => {
      assert.equal(request.signal, controller.signal, "detail forwards the caller's signal unchanged");
      const limit = Math.max(0, Math.floor(Number(request.limit) || 0));
      return { images: Array.isArray(images) && limit > 0 ? images.slice(0, limit) : images, imageCount };
    };
    const previous = legacyFactory({ ...options, archiveImagesPayload: provider }), current = measuredFactory({ ...options, archiveImagesPayload: provider });
    for (const page of pages) {
      const before = await previous.publicDetail(album, { ...page, signal: controller.signal });
      const after = await current.publicDetail(album, { ...page, signal: controller.signal });
      assert.deepEqual(after, before); assert.equal(JSON.stringify(after), JSON.stringify(before)); oracles++;
    }
  }
  const failure = new Error("controlled archive failure");
  for (const factory of [legacyFactory, measuredFactory]) {
    const service = factory({ ...options, archiveImagesPayload: async (_archivePath, request) => { assert.equal(request.signal, controller.signal); throw failure; } });
    await assert.rejects(service.publicDetail(album, { imageOffset: 3, imageLimit: 2, signal: controller.signal }), error => error === failure);
  }

  const images = Array.from({ length: 20000 }, (_, index) => ({ path: `_fixture_detail_/${index}.jpg`, name: `Image ${index}`, bytes: index }));
  const db = galleryDb(), archivePath = path.resolve(album.sourceRoot, album.relativePath), disk = stat();
  const signature = archiveDiskSignature(archivePath, disk);
  db.prepare("INSERT INTO photo_set_image_indexes(archive_path,archive_size,archive_mtime_ms,archive_identity,image_count,images_json,indexer_version,indexed_at,updated_at) VALUES(?,?,?,?,?,?,3,'private','private')")
    .run(archivePath, disk.size, disk.mtimeMs, signature.archiveIdentity, images.length, JSON.stringify(images));
  let reads = 0, stats = 0;
  const prepare = db.prepare.bind(db);
  db.prepare = sql => {
    const statement = prepare(sql);
    if (!sql.startsWith("SELECT * FROM photo_set_image_indexes")) return statement;
    return new Proxy(statement, { get(target, key) {
      if (key === "get") return (...args) => { reads++; return target.get(...args); };
      const value = Reflect.get(target, key, target); return typeof value === "function" ? value.bind(target) : value;
    } });
  };
  const archive = archiveService({ getImageGalleryDb: () => db, statFile: async () => { stats++; return disk; }, spawnProcess: () => assert.fail("persisted paging must not spawn a helper") });
  const previous = legacyFactory({ ...options, archiveImagesPayload: archive.archiveImagesPayload });
  const current = measuredFactory({ ...options, archiveImagesPayload: archive.archiveImagesPayload });
  await current.publicDetail(album, { imageLimit: 48 });
  const slice = Array.prototype.slice, stringify = JSON.stringify, parse = JSON.parse;
  async function measure(service) {
    const metric = { copied: 0, copies: 0, serializations: 0, parses: 0 };
    reads = 0; stats = 0;
    Array.prototype.slice = function (...args) {
      const result = slice.apply(this, args);
      if (this[0]?.path?.startsWith("_fixture_detail_/")) { metric.copies++; metric.copied += result.length; }
      return result;
    };
    JSON.stringify = (value, ...args) => { if (Array.isArray(value?.images)) metric.serializations++; return stringify(value, ...args); };
    JSON.parse = (...args) => { metric.parses++; return parse(...args); };
    try {
      const response = await service.publicDetail(album, { imageOffset: 19952, imageLimit: 48, signal: controller.signal });
      return { response, ...metric, reads, stats, cacheBytes: archive.diagnostics().listCacheBytes };
    } finally { Array.prototype.slice = slice; JSON.stringify = stringify; JSON.parse = parse; }
  }
  const before = await measure(previous), after = await measure(current);
  assert.deepEqual(after.response, before.response); assert.equal(stringify(after.response), stringify(before.response));
  assert.equal(before.copied, 20048, "old deep page copies the full prefix and then the page");
  assert.equal(after.copied, 48, "deep page only copies its 48 visible image references");
  assert.equal(after.copies, 1);
  for (const result of [before, after]) {
    assert.equal(result.reads, 3, "all database authority fences remain");
    assert.equal(result.stats, 2, "both source identity fences remain");
    assert.equal(result.parses, 0, "warm paging retains parsed metadata");
    assert.equal(result.serializations, 1, "mutable archive cache still refreshes its complete byte weight");
  }
  assert.equal(after.cacheBytes, before.cacheBytes);
  after.response.images[0].name = "public DTO mutation";
  assert.notEqual((await current.publicDetail(album, { imageOffset: 19952, imageLimit: 1 })).images[0].name, "public DTO mutation");
  const exposed = await archive.listArchiveImages(archivePath);
  exposed[19952].name = "shared archive mutation retained";
  assert.equal((await current.publicDetail(album, { imageOffset: 19952, imageLimit: 1 })).images[0].name, "shared archive mutation retained");
  console.log("archive-photo-detail-paging:", JSON.stringify({ oracles: oracles + 1, copiedBefore: before.copied, copiedAfter: after.copied, cacheBytes: after.cacheBytes }));
  scenarios++;
}

async function verifyIndexStampWork() {
  const file = path.join(projectRoot, "src/platform/server/archive-image-service.js");
  const source = fs.readFileSync(file, "utf8").replaceAll("\r\n", "\n");
  const currentBlock = source.match(/  function rowStamp\([\s\S]*?(?=  function remember\()/)?.[0];
  assert(currentBlock?.includes("function rowStampsMatch("), "whole index authority source hook must exist");
  // Restore the whole previous stamp and authority comparison, preserving
  // actual SQL, rows, owner checks, task pool, TTL and payload budget.
  const previousBlock = [
    "  function rowStamp(row) { return row ? JSON.stringify(row) : \"missing\"; }",
    "  function indexAuthority(source) {",
    "    let db;",
    "    try { db = options.getImageGalleryDb(); return { db, stamp: rowStamp(indexRow(db, source)), valid: true }; }",
    "    catch { return { db, valid: false }; }",
    "  }",
    "  function authorityCurrent(source, authority, context) {",
    "    if (!context.isCurrent() || !authority.valid) return false;",
    "    try { return options.getImageGalleryDb() === authority.db && rowStamp(indexRow(authority.db, source)) === authority.stamp; }",
    "    catch { return false; }",
    "  }",
    ""
  ].join("\n");
  const previousSource = source.replace(currentBlock, previousBlock);
  assert.notEqual(previousSource, source, "the negative restores the whole preceding index authority");
  assert.equal(previousSource.replace(previousBlock, currentBlock), source, "only the authority source block changes");
  const resolvedSource = previousSource.replace(/from\s+(["'])(\.[^"']+)\1/g, (_match, _quote, relative) =>
    "from " + JSON.stringify(pathToFileURL(path.resolve(path.dirname(file), relative)).href));
  const legacyFactory = (await import("data:text/javascript;base64," + Buffer.from(resolvedSource).toString("base64"))).createArchiveImageService;
  const measuredFactory = process.argv.includes("--legacy-index-json-stamp") ? legacyFactory : createArchiveImageService;
  const stringify=JSON.stringify, parse=JSON.parse;
  let metric = null;
  const owners=[];
  function owner(factory, images) {
    const dbService=createImageGalleryDbService({dbPath:":memory:",ensureDataDir(){}}), db=dbService.getDb();
    const state={db, statError:null,beforeStat:null,beforeRead:null,readError:null,rowTransform:null,stats:0,helpers:0,warnings:[]};
    const originalPrepare=db.prepare.bind(db);
    db.prepare=sql => {
      const statement=originalPrepare(sql);
      if (!sql.startsWith("SELECT * FROM photo_set_image_indexes")) return statement;
      return new Proxy(statement,{get(target,property) {
        if(property==="get") return (...args) => {
          if (metric) metric.reads++;
          state.beforeRead?.(state);
          if(state.readError)throw state.readError;
          const row=target.get(...args);
          if(metric && typeof row?.images_json==="string") metric.readBytes+=Buffer.byteLength(row.images_json);
          return state.rowTransform?.(row) ?? row;
        };
        const value=Reflect.get(target,property,target);return typeof value==="function"?value.bind(target):value;
      }});
    };
    const archivePath=path.resolve("synthetic/archive.zip"),stat={size:7,mtimeMs:123.125,dev:1,ino:10,isFile:()=>true};
    const signature=archiveDiskSignature(archivePath,stat);
    db.prepare("INSERT INTO photo_set_image_indexes(archive_path,archive_size,archive_mtime_ms,archive_identity,image_count,images_json,indexer_version,indexed_at,updated_at) VALUES(?,?,?,?,?,?,3,'private','private')")
    .run(archivePath,7,123.125,signature.archiveIdentity,images.length,stringify(images));
    const archive=factory({
      getImageGalleryDb:()=>state.db,
      statFile:async()=>{state.stats++;if(metric)metric.stats++;if(state.statError)throw state.statError;state.beforeStat?.(state);return stat;},
      pythonPath:"unused",helperPath:"unused",projectRoot:process.cwd(),
      spawnProcess:()=>{state.helpers++;if(metric)metric.helpers++;const child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();child.kill=()=>true;
        queueMicrotask(()=>{child.stdout.write(stringify({ok:true,images:[{path:"controlled-helper.jpg",bytes:9}],imageCount:1}));child.emit("close",0);});return child;},
      warn:(...args)=>state.warnings.push(args),archiveImageExts:new Set([".jpg"]),normalizeExt:value=>path.extname(String(value||"")).toLowerCase(),
      mimeTypes:{".jpg":"image/jpeg"},imageReaderCacheService:{rootDir:"unused"},listCacheTtlMs:60000
    });
    const album={id:"album",sourceRoot:path.dirname(archivePath),relativePath:path.basename(archivePath),updatedAt:"private",extra:"retained"};
    const photo=createPhotoSetService({archiveImagesPayload:archive.archiveImagesPayload,safeChildPath:(root,relative)=>path.resolve(root,relative),
      getImageLibraryIndex:()=>({photoSets:[album]}),photoSetById:()=>album});
    const item={db,dbService,state,archive,photo,album,archivePath,signature};owners.push(item);return item;
  }
  async function read(owner,options={}) {
    metric={reads:0,readBytes:0,stats:0,helpers:0,stringifyCalls:0,stringifyOutputBytes:0,rowStringifyCalls:0,rowStringifyInputBytes:0,rowStringifyOutputBytes:0,parses:0};
    JSON.stringify=(value,...args)=>{
      const result=stringify(value,...args);metric.stringifyCalls++;metric.stringifyOutputBytes+=typeof result==="string"?Buffer.byteLength(result):0;
      if(value && Object.hasOwn(value,"images_json")) {
        metric.rowStringifyCalls++;metric.rowStringifyInputBytes+=typeof Object.getOwnPropertyDescriptor(value,"images_json")?.value==="string"?Buffer.byteLength(Object.getOwnPropertyDescriptor(value,"images_json").value):0;
        metric.rowStringifyOutputBytes+=typeof result==="string"?Buffer.byteLength(result):0;
      } return result;
    };
    JSON.parse=(...args)=>{metric.parses++;return parse(...args);};
    const start=performance.now();
    try{
      const response=await owner.photo.publicDetail(owner.album,options);
      return {response,ms:performance.now()-start,...metric,cache:owner.archive.diagnostics()};
    }finally{JSON.stringify=stringify;JSON.parse=parse;metric=null;}
  }
  let oracles=0,errorOracles=0;
  async function equal(left,right,options,label) {
    const before=await read(left,options),after=await read(right,options);
    assert.deepEqual(after.response,before.response,label);assert.equal(stringify(after.response),stringify(before.response),label+" JSON");
    for(const name of ["reads","readBytes","stats","helpers","parses"])assert.equal(after[name],before[name],label+"/"+name);
    assert.equal(after.cache.listEntries,before.cache.listEntries,label+"/entries");assert.equal(after.cache.listCacheBytes,before.cache.listCacheBytes,label+"/bytes");oracles++;
    return {before,after};
  }
  const distributions=[];
  let payloadBudget;
  try{
    for(const count of [0,1,48,1000,20000]){
      const images=Array.from({length:count},(_,i)=>({path:"folder/相册_"+String(i).padStart(5,"0")+"_\n\"quoted\".jpg",name:"合成 "+i,bytes:i,extra:"extra"}));
      const previous=owner(legacyFactory,images),current=owner(measuredFactory,images);
      const cold=await equal(previous,current,{imageLimit:48},"cold "+count);
      const warm=await equal(previous,current,{imageLimit:48,imageOffset:48},"warm "+count);
      if(count===20000)payloadBudget=warm;
      for(const opts of [{},{imageLimit:1},{imageLimit:0,imageOffset:3},{imageLimit:12.75,imageOffset:8.3},{imageLimit:-1,imageOffset:-1},{imageLimit:"bad",imageOffset:"bad"},{imageLimit:48,imageOffset:999999}])
        await equal(previous,current,opts,"options "+count+"/"+stringify(opts));
      for(let i=0;i<3;i++)await equal(previous,current,{imageLimit:48,imageOffset:i*48},"warmup "+count);
      const oldTimes=[],newTimes=[];
      for(let i=0;i<8;i++){
        const pair=i%2?[current,previous]:[previous,current],results=[];
        for(const target of pair)results.push([target,await read(target,{imageLimit:48,imageOffset:(i+2)*48})]);
        const before=results.find(([target])=>target===previous)[1],after=results.find(([target])=>target===current)[1];
        assert.deepEqual(after.response,before.response);assert.equal(stringify(after.response),stringify(before.response));oldTimes.push(before.ms);newTimes.push(after.ms);oracles++;
      }
      const median=values=>[...values].sort((a,b)=>a-b)[Math.floor(values.length/2)];
      distributions.push({count,jsonBytes:Buffer.byteLength(stringify(images)),coldBefore:cold.before.ms,coldAfter:cold.after.ms,
        warmBefore:warm.before.ms,warmAfter:warm.after.ms,oldMedian:median(oldTimes),median:median(newTimes),
        reads:warm.after.reads,stats:warm.after.stats,parse:warm.after.parses,readBytes:warm.after.readBytes,
        oldRowStringifyInputBytes:warm.before.rowStringifyInputBytes,rowStringifyInputBytes:warm.after.rowStringifyInputBytes,
        oldRowStringifyOutputBytes:warm.before.rowStringifyOutputBytes,rowStringifyOutputBytes:warm.after.rowStringifyOutputBytes,
        stringifyCalls:warm.after.stringifyCalls,oldAllStringifyOutputBytes:warm.before.stringifyOutputBytes,allStringifyOutputBytes:warm.after.stringifyOutputBytes,
        cacheBytes:warm.after.cache.listCacheBytes});
    }

    const baseline=[{path:"first.jpg",name:"one",bytes:1},{path:"second.jpg",name:"two",bytes:2}];
    const previous=owner(legacyFactory,baseline),current=owner(measuredFactory,baseline);
    await equal(previous,current,{imageLimit:1},"boundary prewarm");
    const mutate=(sql,...values)=>{for(const target of [previous,current])target.db.prepare(sql).run(...values);};
    const metadataCases=[];
    for(const [sql,values,label] of [
      ["UPDATE photo_set_image_indexes SET updated_at=?",["fresh"],"timestamp"],
      ["UPDATE photo_set_image_indexes SET image_count=?",[300],"count"],
      ["UPDATE photo_set_image_indexes SET images_json=?",[stringify([{path:"changed.jpg",bytes:9}])],"images content"],
      ["UPDATE photo_set_image_indexes SET images_json=?",[' [ { "path":"changed.jpg", "bytes":9 } ] '],"same parsed content/raw whitespace"],
      ["UPDATE photo_set_image_indexes SET images_json=?",[stringify(baseline)],"restore images"]
    ]){
      mutate(sql,...values);const pair=await equal(previous,current,{imageLimit:1},label);
      assert.equal(pair.after.parses,1,label+" invalidates memory");metadataCases.push(label);
    }
    for(const target of [previous,current])target.db.exec('ALTER TABLE photo_set_image_indexes ADD COLUMN extra_metadata;ALTER TABLE photo_set_image_indexes ADD COLUMN "0";');
    for(const value of [null,"",0,2,2.5," x\0😀 ",new Uint8Array([]),new Uint8Array([1,2,255])]){
      mutate("UPDATE photo_set_image_indexes SET extra_metadata=?,\"0\"=?",value,"ordered");
      const pair=await equal(previous,current,{imageLimit:1},"native extra column "+String(value));assert.equal(pair.after.parses,1);metadataCases.push("extra");
      if(value instanceof Uint8Array)assert.equal(pair.after.rowStringifyInputBytes,pair.before.rowStringifyInputBytes,"extra native BLOB retains whole legacy serialization");
    }
    // The entire original key order remains a fence, even when a reordered
    // table has identical values and public image data.
    for(const target of [previous,current]){
      target.archive.clearListCache();
      target.state.beforeStat=state=>{if(metric.stats!==2)return;state.beforeStat=null;
        target.db.exec('ALTER TABLE photo_set_image_indexes RENAME TO old_private_index;CREATE TABLE photo_set_image_indexes AS SELECT images_json,"0",extra_metadata,archive_path,archive_identity,archive_size,archive_mtime_ms,image_count,indexer_version,indexed_at,updated_at FROM old_private_index;DROP TABLE old_private_index;');};
    }
    const reordered=await equal(previous,current,{imageLimit:1},"DDL/reordered fields during final source check");
    assert.equal(reordered.after.cache.listEntries,0,"key-order change declines admission");
    await equal(previous,current,{imageLimit:1},"after reordered fields");
    for(const target of [previous,current])target.db.exec('ALTER TABLE photo_set_image_indexes ADD COLUMN another_metadata;');
    const afterDdl=await equal(previous,current,{imageLimit:1},"extra column DDL on same owner");assert.equal(afterDdl.after.parses,1);
    const held=new Error("held stat");held.code="PRIVATE_STAT_ERROR";
    const transitionImages=[{path:"first $& $$ $' $` $1.jpg",name:"same",bytes:1}];
    const transitionPrevious=owner(legacyFactory,transitionImages),transitionCurrent=owner(measuredFactory,transitionImages);
    for(const direction of ["native-to-legacy","legacy-to-native"]){
      for(const target of [transitionPrevious,transitionCurrent]){
        target.archive.clearListCache();target.state.imageGets=0;target.state.throwImage=false;
        target.state.legacyRow=row=>{const result={};Object.defineProperty(result,"images_json",{enumerable:true,get(){target.state.imageGets++;if(target.state.throwImage)throw held;return row.images_json;}});
          result.toJSON=()=>row;return result;};
        target.state.rowTransform=direction==="native-to-legacy"?null:target.state.legacyRow;
      }
      await equal(transitionPrevious,transitionCurrent,{imageLimit:1},direction+" first");
      for(const target of [transitionPrevious,transitionCurrent]){target.state.imageGets=0;target.state.throwImage=true;
        target.state.rowTransform=direction==="native-to-legacy"?target.state.legacyRow:null;}
      const mixed=await equal(transitionPrevious,transitionCurrent,{imageLimit:1},direction+" warm");
      assert.equal(mixed.after.parses,0);assert.equal(mixed.after.helpers,0);
      assert.equal(transitionCurrent.state.imageGets,0,"an equivalent legacy toJSON must retain the warm hit without reading images_json");
      assert.equal(transitionPrevious.state.imageGets,0);
    }
    const transformations=[
      ["ordinary object",row=>({...row})],
      ["images accessor",row=>{const result=Object.assign(Object.create(null),row),value=result.images_json;Object.defineProperty(result,"images_json",{enumerable:true,configurable:true,get:()=>value});return result;}],
      ["extra accessor",row=>{const result=Object.assign(Object.create(null),row);Object.defineProperty(result,"extra_metadata",{enumerable:true,configurable:true,get:()=>42});return result;}],
      ["nonenumerable image",row=>{const result=Object.assign(Object.create(null),row);Object.defineProperty(result,"images_json",{enumerable:false});return result;}],
      ["own toJSON",row=>{const result=Object.assign(Object.create(null),row);result.toJSON=()=>({...row});return result;}],
      ["proxy row",row=>new Proxy(row,{})],
      ["symbol accessor",row=>{const result=Object.assign(Object.create(null),row);Object.defineProperty(result,Symbol("ignored"),{enumerable:true,get(){assert.fail("JSON must not read Symbol accessors");}});return result;}],
      ["own toJSON undefined",row=>Object.assign(Object.create(null),row,{toJSON:()=>undefined})],
      ["own toJSON null",row=>Object.assign(Object.create(null),row,{toJSON:()=>null})],
      ["nonstring image NULL",row=>Object.assign(Object.create(null),row,{images_json:null})],
      ["nonstring image empty BLOB",row=>Object.assign(Object.create(null),row,{images_json:new Uint8Array([])})],
      ["nonstring image invalid number",row=>Object.assign(Object.create(null),row,{images_json:7})]
    ];
    for(const [label,transform]of transformations){
      for(const target of [previous,current]){target.archive.clearListCache();target.state.rowTransform=transform;}
      const pair=await equal(previous,current,{imageLimit:1},label);
      assert.equal(pair.after.rowStringifyInputBytes,pair.before.rowStringifyInputBytes,label+" keeps whole legacy serialization");
      assert.equal(pair.after.rowStringifyOutputBytes,pair.before.rowStringifyOutputBytes,label+" legacy bytes");
      await equal(previous,current,{imageLimit:1},label+" next");
    }
    for(const target of [previous,current]){target.state.rowTransform=null;target.archive.clearListCache();}
    for(const target of [previous,current]){target.state.statError=held;await assert.rejects(read(target,{imageLimit:1}),error=>error===held);target.state.statError=null;oracles++;errorOracles++;}
    for(const stage of ["authority","cached"]){
      await equal(previous,current,{imageLimit:1},"error warm");
      for(const target of [previous,current]){
        target.state.beforeRead=state=>{
          if((stage==="authority"&&metric.reads===1)||(stage==="cached"&&metric.reads===2)){
            state.beforeRead=null;throw held;
          }
        };
      }
      await equal(previous,current,{imageLimit:1},"swallowed native SELECT error "+stage);
      assert.deepEqual(current.state.warnings,previous.state.warnings);
    }

    for(const target of [previous,current]){
      target.archive.clearListCache();
      target.db.exec('ALTER TABLE photo_set_image_indexes RENAME TO old_typed_index;CREATE TABLE photo_set_image_indexes(archive_path TEXT PRIMARY KEY,archive_size INTEGER,archive_mtime_ms REAL,archive_identity TEXT,image_count INTEGER,images_json,indexer_version INTEGER,indexed_at TEXT,updated_at TEXT);INSERT INTO photo_set_image_indexes SELECT archive_path,archive_size,archive_mtime_ms,archive_identity,image_count,images_json,indexer_version,indexed_at,updated_at FROM old_typed_index;DROP TABLE old_typed_index;');
    }
    let nativeImageTypes=0;
    for(const value of [null,0,1,1.5,"","[]",stringify(baseline),new Uint8Array([]),new Uint8Array([91,93]),new Uint8Array([255])]){
      for(const target of [previous,current]){
        target.archive.clearListCache();
        target.db.prepare("UPDATE photo_set_image_indexes SET images_json=?,image_count=2,indexer_version=3,archive_identity=?").run(value,target.signature.archiveIdentity);
      }
      const actualType=previous.db.prepare("SELECT typeof(images_json) AS storage FROM photo_set_image_indexes").get().storage;
      await equal(previous,current,{imageLimit:1},"native images_json "+actualType+"/"+String(value));
      await equal(previous,current,{imageLimit:1},"native images_json warm "+actualType+"/"+String(value));nativeImageTypes++;
    }
    async function route(target) {
      const response=new EventEmitter();response.destroyed=false;response.writableEnded=false;const result={};
      assert.equal(await routePhotosApi({method:"GET"},response,new URL("http://private.invalid/api/photo-sets/album?imageLimit=1"),{
        photoSetService:target.photo,imageReaderCacheStatus:async()=>({synthetic:true}),
        sendJson(_res,status,payload){result.status=status;result.payload=payload;response.writableEnded=true;},
        notFound(){result.status=404;response.writableEnded=true;}
      }),true);return result;
    }
    assert.equal(stringify(await route(current)),stringify(await route(previous)));oracles++;

    const alternatePrevious=owner(legacyFactory,baseline),alternateCurrent=owner(measuredFactory,baseline);
    previous.state.db=alternatePrevious.db;current.state.db=alternateCurrent.db;
    const replaced=await equal(previous,current,{imageLimit:1},"native owner replacement");
    assert.equal(replaced.after.parses,1);
    previous.state.db=previous.db;current.state.db=current.db;
    await equal(previous,current,{imageLimit:1},"native owner return");
    // Pure rowStamp equivalence additionally covers string escaping, native
    // scalar canonicalization, unusual providers, getters and key order.
    const oldStampFunction=new Function(previousBlock+"\nreturn rowStamp;")();
    const stampFunctions=new Function("types",currentBlock+"\nreturn {rowStamp,rowStampsMatch};")(types);
    const row=(value,extra=1)=>Object.assign(Object.create(null),{archive_path:"private",images_json:value,extra});
    const values=[null,undefined,0,1,NaN,Infinity,"","[]"," \0\n\"\\","😀","\ud800",new Uint8Array([]),new Uint8Array([1,2])];
    let pureOracles=0;
    for(const a of values)for(const b of values){
      assert.equal(stampFunctions.rowStampsMatch(stampFunctions.rowStamp(row(a)),stampFunctions.rowStamp(row(b))),oldStampFunction(row(a))===oldStampFunction(row(b)));
      pureOracles++;
    }
    const a=Object.assign(Object.create(null),{first:1,images_json:"[]",last:2}),b=Object.assign(Object.create(null),{last:2,images_json:"[]",first:1});
    assert.equal(stampFunctions.rowStampsMatch(stampFunctions.rowStamp(a),stampFunctions.rowStamp(b)),false);pureOracles++;
    const originalToJson=Object.getOwnPropertyDescriptor(Object.prototype,"toJSON");
    try{
      Object.defineProperty(Object.prototype,"toJSON",{configurable:true,value(){return "prototype pollution";}});
      assert.equal(stampFunctions.rowStampsMatch(stampFunctions.rowStamp(row("[]")),stampFunctions.rowStamp(row(" [ ] "))),false);
      assert.equal(stampFunctions.rowStamp(row("[]")).metadata,stringify(Object.assign(Object.create(null),row("[]"),{images_json:null})));pureOracles++;
    }finally{if(originalToJson)Object.defineProperty(Object.prototype,"toJSON",originalToJson);else delete Object.prototype.toJSON;}

    for(const label of ["images getter","extra getter","own toJSON"]){
      const make=()=>{
        const item=row("[]"),log=[];
        if(label==="own toJSON") item.toJSON=()=>{log.push("toJSON");throw held;};
        else Object.defineProperty(item,label==="images getter"?"images_json":"extra",{enumerable:true,configurable:true,get(){log.push(label);throw held;}});
        return {item,log};
      };
      const before=make(),after=make();
      assert.throws(()=>oldStampFunction(before.item),error=>error===held);
      assert.throws(()=>stampFunctions.rowStamp(after.item),error=>error===held);
      assert.deepEqual(after.log,before.log);pureOracles++;
    }
    for(const item of [Object(1),Object(true),Object(1n),Object(Symbol("private")),()=>{}]){
      Object.setPrototypeOf(item,null);delete item.name;delete item.length;item.images_json="[]";
      let before,after,oldError,nextError;
      try{before=oldStampFunction(item);}catch(error){oldError=error;}
      try{after=stampFunctions.rowStamp(item);}catch(error){nextError=error;}
      if(oldError){assert(nextError);assert.equal(nextError.constructor,oldError.constructor);assert.equal(nextError.message,oldError.message);}
      else{assert.equal(after,before,"non-native boxed or function rows retain original JSON semantics");}
      pureOracles++;
    }
    for(const metadata of ['literal "images_json":null', 'escaped \\"images_json\\":null', "\n\0😀\ud800"]){
      const native=row("[]",metadata),split=stampFunctions.rowStamp(native),whole=oldStampFunction(native);
      assert.equal(stampFunctions.rowStampsMatch(split,whole),true);assert.equal(stampFunctions.rowStampsMatch(whole,split),true);pureOracles++;
    }
    for(const images of ["$&","$$","$'","$`","$1","normal"]){
      const native=row(images),split=stampFunctions.rowStamp(native),whole=oldStampFunction(native);
      assert.equal(stampFunctions.rowStampsMatch(split,whole),true);assert.equal(stampFunctions.rowStampsMatch(whole,split),true);pureOracles++;
    }
    const proxyLogs=[];
    for(const fn of [oldStampFunction,stampFunctions.rowStamp]){
      const log=[];const item=new Proxy(row("[]"),{get(target,key,receiver){log.push("get:"+String(key));return Reflect.get(target,key,receiver);},
        ownKeys(target){log.push("ownKeys");return Reflect.ownKeys(target);},
        getOwnPropertyDescriptor(target,key){log.push("descriptor:"+String(key));return Reflect.getOwnPropertyDescriptor(target,key);},
        getPrototypeOf(target){log.push("prototype");return Reflect.getPrototypeOf(target);}});
      fn(item);proxyLogs.push(log);
    }
    assert.deepEqual(proxyLogs[1],proxyLogs[0]);pureOracles++;

    console.log(stringify({indexStampWork:{responseOracles:oracles-errorOracles,errorOracles,pureOracles,nativeImageTypes,metadataCases:metadataCases.length,
      legacyProviderCases:transformations.length,owners:owners.length,distributions}}));
    // Every complete response, legacy/native type, mutation, error and owner
    // comparison precedes the whole former source's real serialization budget.
    assert.equal(payloadBudget.before.rowStringifyInputBytes,3*distributions.find(item=>item.count===20000).jsonBytes);
    assert.equal(payloadBudget.after.reads,3,"index authority retains every row read");
    assert.equal(payloadBudget.after.stats,2,"index authority retains both physical source fences");
    assert.equal(payloadBudget.after.parses,0,"a warm list still reuses parsed images");
    assert.equal(payloadBudget.after.stringifyCalls,payloadBudget.before.stringifyCalls,"payload cache weight serialization remains");
    assert.equal(payloadBudget.after.cache.listCacheBytes,payloadBudget.before.cache.listCacheBytes,"the existing 16 MiB cache budget is unchanged");
    assert.equal(payloadBudget.after.rowStringifyInputBytes,0,"archive index authority images JSON serialization budget");
    scenarios++;

  }finally{JSON.stringify=stringify;JSON.parse=parse;for(const item of owners){await item.archive.stop();await item.photo.stop();item.dbService.close();}}

}

async function verifyPhotoAuthority() {
  for (const indexed of [false, true]) for (const mode of ["source", "database", "album", "album-in-place", "row", "stop", "success"]) {
    const dbA = galleryDb(), dbB = galleryDb(); let currentDb = dbA;
    let album = { id:"album",sourceRoot:temporary,relativePath:"photo.zip",updatedAt:"before" };
    const configuration = { archiveExts:new Set([".zip"]),directVideoExts:new Set(),galleryMediaSources:[],photoSetRoots:[],videoExts:[] };
    let imageIndex = { schemaVersion:CURRENT_INDEX_SCHEMA,parserVersion:PARSER_VERSION,cacheIdentity:imageLibraryCacheIdentity(configuration),photoSets:[album],mediaItems:[] };
    const owner = createImageLibraryIndexService({ ...configuration,readJsonFile:()=>imageIndex,imageLibraryIndexPath:path.join(temporary,"authority-index.json") });
    let lookupCalls = 0;
    let identity = "original", calls = 0; const final = gate(); let finalStarted = false;
    const service = createPhotoSetService({ archiveImageExts:new Set([".jpg"]),coverGeneratorVersion:2,coverHints:new Set(["cover"]),coverMaxBytes:1024,
      archiveImageSignature:async archivePath => { calls++; if (calls === 2) { finalStarted=true; await final.promise; } return {archivePath,archiveSize:7,archiveMtimeMs:123.125,archiveIdentity:identity}; },
      getImageGalleryDb:()=>currentDb,getImageLibraryIndex:()=>imageIndex,
      photoSetById:indexed?id=>{lookupCalls++;return owner.photoSetById(id);}:undefined,
      safeChildPath:(root,relative)=>path.join(root,relative),normalizeExt:value=>path.extname(value).toLowerCase(),fileBase:value=>path.parse(value).name,
      safeStat:()=>assert.fail("cover pipeline must not stat synchronously"),mimeTypes:{".jpg":"image/jpeg"},listArchiveImages:async()=>[{path:"cover.jpg",bytes:3}],
      extractArchiveMemberToCache:async (_source,_member,target)=>fs.promises.writeFile(target,"AAA"),compressImageFileToJpeg:()=>assert.fail("explicit small cover should retain bytes"),
      notFound:res=>{res.writeHead(404);res.end("missing");} }); services.push(service);
    const res=response(); const job=service.serveCover(res,"album"); await until(()=>finalStarted,`photo ${mode} final signature`);
    if(mode==="source")identity="replacement";
    if(mode==="database")currentDb=dbB;
    if(mode==="album"){album={...album,updatedAt:"after"};imageIndex={...imageIndex,photoSets:[album]};owner.invalidate();}
    if(mode==="album-in-place"){album.relativePath="changed.zip";album.updatedAt="after";}
    if(mode==="row")dbA.prepare("INSERT INTO photo_set_covers(album_id,archive_path,updated_at) VALUES(?,?,?)").run("album",path.join(temporary,"photo.zip"),"manual");
    if(mode==="stop")service.beginStop();
    final.resolve(); await job; await service.stop();
    const rows=dbA.prepare("SELECT * FROM photo_set_covers").all(); assert.equal(dbB.prepare("SELECT count(*) AS n FROM photo_set_covers").get().n,0);
    assert.equal(rows.length,mode==="success"||mode==="row"?1:0);
    if(mode==="success"){assert.equal(res.statusCode,200);assert.equal(Buffer.from(rows[0].cover_blob).toString(),"AAA");assert.equal(rows[0].archive_identity,"original");}
    if(mode==="row")assert.equal(rows[0].updated_at,"manual"); scenarios++;
    assert.equal(lookupCalls>0,indexed,"cover authority must use the optional owner capability when provided");
    owner.invalidate();
  }
}

async function verifyPhotoAuthorityBytes() {
  const file = path.join(projectRoot, "src/modules/photos/server/photo-set-service.js");
  const source = fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n");
  const block = source.match(/  const rowStamp =[\s\S]*?(?=  function imageUrl\()/)?.[0];
  assert(block?.includes("function authority("), "whole photo authority negative-control hook must exist");
  const legacyBlock = [
    '  const rowStamp = value => JSON.stringify(value && { ...value, cover_blob: value.cover_blob ? Buffer.from(value.cover_blob).toString("base64") : null });',
    '  function authority(album, context) {',
    '    const db = getImageGalleryDb(), stamp = rowStamp(coverRow(album, db));',
    '    return { db, stamp, album: albumStamp(album), current: () => context.isCurrent() && getImageGalleryDb() === db && albumStamp(byId(album.id)) === albumStamp(album) && rowStamp(coverRow(album, db)) === stamp };',
    '  }', ''
  ].join("\n");
  assert.notEqual(block, legacyBlock, "negative control must restore the previous authority");
  const legacySource = source.replace(block, legacyBlock).replace(/from\s+(["'])(\.[^"']+)\1/g, (_match, _quote, relative) =>
    "from " + JSON.stringify(pathToFileURL(path.resolve(path.dirname(file), relative)).href));
  const legacyFactory = (await import("data:text/javascript;base64," + Buffer.from(legacySource).toString("base64"))).createPhotoSetService;
  const measuredFactory = process.argv.includes("--legacy-photo-authority") ? legacyFactory : createPhotoSetService;
  const from = Buffer.from, toString = Buffer.prototype.toString, warn = console.warn, RealDate = Date;
  let active = null, warnings = null;
  Buffer.from = function(value, ...args) {
    if (active && value instanceof Uint8Array && !args.length) active.copyBytes += value.byteLength;
    return from.call(this, value, ...args);
  };
  Buffer.prototype.toString = function(encoding, ...args) {
    const result = toString.call(this, encoding, ...args);
    if (active && encoding === "base64") { active.base64Calls++; active.base64Bytes += this.length; active.base64Chars += result.length; }
    return result;
  };
  console.warn = (...args) => { if (warnings) warnings.push(args.map(String)); else warn(...args); };

  async function run(factory, options = {}) {
    const { bytes = 64 * 1024, requests = 1, status = "ok", mode = "", indexed = true, generation = false, absent = false, alias = "", mutation } = options;
    const owner = createImageGalleryDbService({ dbPath: ":memory:", ensureDataDir() {} }), database = owner.getDb();
    const otherOwner = mode === "database" ? createImageGalleryDbService({ dbPath: ":memory:", ensureDataDir() {} }) : null;
    database.exec("ALTER TABLE photo_set_covers ADD COLUMN extra_metadata TEXT");
    const album = { id: "authority-bytes", sourceRoot: temporary, relativePath: "authority-bytes.zip", updatedAt: "before" };
    const archivePath = path.join(album.sourceRoot, album.relativePath);
    const data = Object.hasOwn(options, "blob") ? options.blob : from(bytes === 0 ? [] : new Uint8Array(bytes).fill(87));
    if (!absent) database.prepare("INSERT INTO photo_set_covers(album_id,archive_path,archive_size,archive_mtime_ms,archive_identity,member_path,cover_mime,cover_blob,cover_bytes,source_bytes,generator_version,status,error,generated_at,updated_at,extra_metadata) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
      .run(album.id, archivePath, 7, 123.125, "identity", "cover.jpg", "image/jpeg", data, bytes, bytes, generation ? 1 : 2, status, status === "error" ? "cached error" : null, "before", "before", "original");
    let shared = data;
    if (alias === "buffer") shared = from(data);
    if (alias === "offset-view") { const storage = new Uint8Array(data.length + 10); storage.set(data, 5); shared = storage.subarray(5, 5 + data.length); }
    if (alias === "array-buffer") shared = Uint8Array.from(data).buffer;
    const counters = { reads: 0, readBytes: 0, base64Calls: 0, base64Bytes: 0, base64Chars: 0, copyBytes: 0, signatures: 0, lookups: 0 };
    const wrapped = {
      exec: sql => database.exec(sql),
      prepare(sql) {
        const statement = database.prepare(sql);
        if (sql !== "SELECT * FROM photo_set_covers WHERE album_id = ?") return statement;
        return { get(...args) {
          const row = statement.get(...args);
          if (active) { counters.reads++; if (row?.cover_blob instanceof Uint8Array) counters.readBytes += row.cover_blob.byteLength; }
          if (alias && row) row.cover_blob = shared;
          return row;
        } };
      }
    };
    let currentDb = wrapped, calls = 0, service;
    service = factory({
      archiveImageExts: new Set([".jpg"]), coverGeneratorVersion: 2, coverHints: new Set(["cover"]), coverMaxBytes: 1024 * 1024,
      mimeTypes: { ".jpg": "image/jpeg" }, getImageGalleryDb: () => currentDb, getImageLibraryIndex: () => ({ photoSets: [album] }),
      photoSetById: indexed ? id => { counters.lookups++; return id === album.id ? album : null; } : undefined,
      safeChildPath: (root, relative) => path.join(root, relative), normalizeExt: value => path.extname(value).toLowerCase(), fileBase: value => path.parse(value).name,
      archiveImageSignature: async target => {
        counters.signatures++;
        if (++calls === 2) {
          mutation?.(database, shared);
          if (mode === "database") currentDb = otherOwner.getDb();
          if (mode === "album") album.updatedAt = "after";
          if (mode === "stop") service.beginStop();
        }
        return { archivePath: target, archiveSize: 7, archiveMtimeMs: 123.125, archiveIdentity: mode === "source" && calls === 2 ? "changed" : "identity" };
      },
      listArchiveImages: () => generation ? [{ path: "cover.jpg", bytes: 3 }] : absent ? [] : assert.fail("matching cached cover must not relist"),
      extractArchiveMemberToCache: async (_archive, _member, target) => { fs.writeFileSync(target, "AAA"); },
      compressImageFileToJpeg: () => assert.fail("small explicit synthetic cover must not compress"),
      notFound: res => { res.writeHead(404); res.end("missing"); }
    });
    const results = [], logs = []; let row;
    // Only publication timestamps are fixed; deadlines still use the real Date.now().
    globalThis.Date = class extends RealDate { constructor(...args) { super(...(args.length ? args : ["2026-10-04T00:00:00.000Z"])); } };
    active = counters; warnings = logs;
    try {
      for (let index = 0; index < requests; index++) {
        const res = response();
        res.writeHead = (code, headers = {}) => { res.statusCode = code; res.headers = headers; };
        await service.serveCover(res, album.id);
        results.push({ status: res.statusCode, headers: res.headers, body: res.body });
      }
    } finally {
      active = null; warnings = null; globalThis.Date = RealDate;
      try { row = database.prepare("SELECT * FROM photo_set_covers").get(); await service.stop(); }
      finally { owner.close(); otherOwner?.close(); }
    }
    return { results, row, logs, counters };
  }

  try {
    const budgets = [];
    let oracles = 0;
    async function compare(name, options) {
      const old = await run(legacyFactory, options), current = await run(measuredFactory, options);
      assert.deepEqual(current.results, old.results, name + " complete headers/status/body");
      assert.deepEqual(current.row, old.row, name + " complete cover row");
      assert.deepEqual(current.logs, old.logs, name + " error behavior");
      assert.equal(current.counters.reads, old.counters.reads, name + " authority read fences");
      assert.equal(current.counters.signatures, old.counters.signatures, name + " source fences");
      assert.equal(current.counters.lookups, old.counters.lookups, name + " album fences");
      if (options.expected !== undefined) assert.equal(current.results[0].status, options.expected, name);
      oracles++;
      return { old, current };
    }
    // Synthetic 64 KiB and configured 1 MiB maximum: the budget measures work, not timing.
    for (const bytes of [64 * 1024, 1024 * 1024]) budgets.push({ bytes, ...(await compare("warm-" + bytes, { bytes, requests: 64, expected: 200 })) });
    const cases = [
      ["stable", { expected: 200 }],
      ["same-length-content", { mutation: db => db.prepare("UPDATE photo_set_covers SET cover_blob=?").run(from(new Uint8Array(64 * 1024).fill(88))), expected: 503 }],
      ["different-length", { mutation: db => db.prepare("UPDATE photo_set_covers SET cover_blob=?").run(from("changed")), expected: 503 }],
      ["delete-row", { mutation: db => db.exec("DELETE FROM photo_set_covers"), expected: 503 }],
      ["empty-blob", { blob: from([]), expected: 200 }], ["null-blob", { blob: null, expected: 404 }],
      ["text-blob", { blob: "unicode中文", expected: 200 }], ["empty-text", { blob: "", expected: 404 }],
      ["zero", { blob: 0, expected: 404 }], ["invalid-integer", { blob: 1, expected: 404 }],
      ["empty-to-null", { blob: from([]), mutation: db => db.exec("UPDATE photo_set_covers SET cover_blob=NULL"), expected: 503 }],
      ["null-to-zero", { blob: null, mutation: db => db.exec("UPDATE photo_set_covers SET cover_blob=0"), expected: 404 }],
      ["null-to-empty-text", { blob: null, mutation: db => db.exec("UPDATE photo_set_covers SET cover_blob=''"), expected: 404 }],
      ["text-to-bytes", { blob: "AAA", mutation: db => db.prepare("UPDATE photo_set_covers SET cover_blob=?").run(from("AAA")), expected: 200 }],
      ["error-row", { status: "error", expected: 404 }], ["absent-row", { absent: true, expected: 404 }]
    ];
    for (const mode of ["source", "database", "album", "stop"]) cases.push([mode, { mode, expected: 503 }]);
    for (const alias of ["buffer", "offset-view", "array-buffer"]) cases.push([alias, { alias, mutation: (_db, shared) => { new Uint8Array(shared instanceof ArrayBuffer ? shared : shared.buffer, shared.byteOffset || 0, shared.byteLength)[0] = 88; }, expected: 503 }]);
    for (const column of ["archive_path", "archive_size", "archive_mtime_ms", "archive_identity", "member_path", "cover_mime", "cover_bytes", "source_bytes", "generator_version", "status", "error", "generated_at", "updated_at", "extra_metadata"]) {
      cases.push([column, { mutation: db => db.prepare("UPDATE photo_set_covers SET " + column + "=?").run(["archive_size", "archive_mtime_ms", "cover_bytes", "source_bytes", "generator_version"].includes(column) ? 999 : "changed"), expected: 503 }]);
    }
    cases.push(["generation", { generation: true, expected: 200 }],
      ["generation-content", { generation: true, mutation: db => db.prepare("UPDATE photo_set_covers SET cover_blob=?").run(from(new Uint8Array(64 * 1024).fill(88))), expected: 503 }],
      ["generation-extra-field", { generation: true, mutation: db => db.exec("UPDATE photo_set_covers SET extra_metadata='changed'"), expected: 503 }]);
    for (const mode of ["source", "database", "album", "stop"]) cases.push(["generation-" + mode, { generation: true, mode, expected: 503 }]);
    for (const indexed of [false, true]) for (const [name, options] of cases) await compare(name + "-" + indexed, { ...options, indexed });
    console.log("photo-authority-bytes: " + oracles + " complete response/row/error oracles passed");
    for (const { bytes, old, current } of budgets) {
      assert.equal(old.counters.reads, 256); assert.equal(old.counters.readBytes, 256 * bytes);
      assert.equal(old.counters.base64Calls, 192); assert.equal(old.counters.base64Bytes, 192 * bytes);
      assert.equal(old.counters.copyBytes, 256 * bytes, "old source must exercise the previous byte-copy work");
      assert.equal(current.counters.reads, 256); assert.equal(current.counters.readBytes, 256 * bytes);
      assert.equal(current.counters.base64Calls, 0, "photo authority must not encode BLOBs as Base64");
      assert.equal(current.counters.copyBytes, 128 * bytes, "only the independent baseline and response copies remain");
    }
    scenarios += oracles;
  } finally { active = null; warnings = null; Buffer.from = from; Buffer.prototype.toString = toString; console.warn = warn; globalThis.Date = RealDate; }
}

async function verifyPhotoCoverSelection() {
  const file = path.join(projectRoot, "src/modules/photos/server/photo-set-service.js");
  const source = fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n");
  const start = source.indexOf("  function selectCoverImage("), end = source.indexOf("  async function coverBlobFromFile(", start);
  assert(start >= 0 && end > start, "whole cover selector control hook must exist");
  const currentSelector = source.slice(start, end).trimEnd();
  const oldSelector = `  function selectCoverImage(images = []) {
    const candidates = images.filter((image) => image?.path);
    if (!candidates.length) return null;

    const explicit = candidates
      .map((image, index) => {
        const hintScore = coverHintScore(image);
        const depth = archiveMemberDepth(image.path);
        const ext = normalizeExt(image.path);
        const tieScore = (depth <= 1 ? 40 : Math.max(0, 30 - depth * 5)) + ([".jpg", ".jpeg", ".webp", ".png"].includes(ext) ? 10 : 0);
        return { image, index, score: hintScore + tieScore, hintScore };
      })
      .filter((item) => item.hintScore > 0)
      .sort((a, b) => b.score - a.score || a.index - b.index)[0];

    if (explicit) return { image: explicit.image, isExplicitCover: true };
    return { image: candidates[0], isExplicitCover: false };
  }`;
  assert.notEqual(currentSelector, oldSelector, "negative control must restore the prior selector");
  async function factory(text, expose = false) {
    if (expose) {
      text = text.replace("    archivePath,\n    byId,", "    selectCoverImage,\n    archivePath,\n    byId,");
      assert(text.includes("    selectCoverImage,\n    archivePath,"), "direct selector observation hook must exist");
    }
    text = text.replace(/from\s+(["'])(\.[^"']+)\1/g, (_match, _quote, relative) =>
      "from " + JSON.stringify(pathToFileURL(path.resolve(path.dirname(file), relative)).href));
    return (await import("data:text/javascript;base64," + Buffer.from(text).toString("base64"))).createPhotoSetService;
  }
  const legacySource = source.replace(currentSelector, oldSelector);
  const legacyFactory = await factory(legacySource);
  const activeFactory = process.argv.includes("--legacy-photo-selection") ? legacyFactory : createPhotoSetService;
  const directFactories = [await factory(legacySource, true), await factory(process.argv.includes("--legacy-photo-selection") ? legacySource : source, true)];
  const hints = ["cover", "poster", "folder", "front", "fanart", "thumb", "thumbnail", "封面"];
  const methods = { fileBase: value => path.basename(value, path.extname(value)), normalizeExt: value => path.extname(value).toLowerCase() };
  const realMap = Array.prototype.map, realReduce = Array.prototype.reduce, realSort = Array.prototype.sort, RealDate = Date, warn = console.warn;
  let measured = null;
  Array.prototype.map = function(callback, thisArg) {
    return realMap.call(this, function(value, index, array) {
      const result = callback.call(this, value, index, array);
      if (measured && result && Object.hasOwn(result, "score") && Object.hasOwn(result, "image")) measured.records++;
      return result;
    }, thisArg);
  };
  Array.prototype.reduce = function(callback, ...rest) {
    return realReduce.call(this, (best, value, index, array) => {
      const result = callback(best, value, index, array);
      if (measured && result !== best && result && Object.hasOwn(result, "score") && Object.hasOwn(result, "image")) measured.records++;
      return result;
    }, ...rest);
  };
  Array.prototype.sort = function(callback) {
    if (measured && this.length && Object.hasOwn(this[0], "score") && Object.hasOwn(this[0], "image")) {
      const counters = measured; counters.sorts++;
      return realSort.call(this, (a, b) => { counters.comparisons++; return callback(a, b); });
    }
    return realSort.call(this, callback);
  };
  globalThis.Date = class extends RealDate { constructor(...args) { super(...(args.length ? args : ["2026-10-04T00:00:00.000Z"])); } };
  const sparse = []; sparse.length = 8; sparse[2] = { path: "first.jpg" }; sparse[6] = { path: "cover.jpg" };
  const shapes = [[], [null, undefined, {}, { path: "" }], [{ path: "first.jpg" }, { path: "later.png" }],
    [{ path: "cover.jpg" }, { path: "cover.png" }], [{ path: "x/cover.jpg" }, { path: "cover.jpg" }],
    [{ path: "part_cover.jpg" }, { path: "folder.jpg" }, { path: "x/cover.bmp" }],
    [{ path: "封面.jpg" }, { path: "cover.jpg" }], [{ path: "p\\cover.PNG" }, { path: "cover.webp" }],
    [{ path: "cover.bmp" }, { path: "cover.jpeg" }], [{ path: "a/b/c/d/e/f/cover.gif" }, { path: "poster.jpg" }], sparse];
  let directOracles = 0, ownerOracles = 0;
  async function owner(make, images, options = {}) {
    const storage = createImageGalleryDbService({ dbPath: ":memory:", ensureDataDir() {} }), database = storage.getDb();
    const album = { id: "selection", sourceRoot: temporary, relativePath: "selection.zip", updatedAt: "fixed" };
    const log = [], counters = { records: 0, sorts: 0, comparisons: 0 };
    const calls = { fileBase: 0, normalizeExt: 0, signature: 0, extract: 0, compress: 0 };
    let selected = null; const errors = [], error = new Error("controlled selector dependency failure");
    const wrapper = (name, operation) => value => {
      calls[name]++; log.push([name, value]);
      if (options.fail === name && calls[name] === 3) throw error;
      return operation(value);
    };
    const service = make({ archiveImageExts: new Set([".jpg", ".png", ".webp", ".bmp"]), coverGeneratorVersion: 2,
      coverHints: new Set(hints), coverMaxBytes: 1024 * 1024, mimeTypes: { ".jpg": "image/jpeg", ".png": "image/png", ".webp": "image/webp", ".bmp": "image/bmp" },
      getImageGalleryDb: () => database, getImageLibraryIndex: () => ({ photoSets: [album] }), safeChildPath: (root, relative) => path.join(root, relative),
      fileBase: wrapper("fileBase", methods.fileBase), normalizeExt: wrapper("normalizeExt", methods.normalizeExt),
      archiveImageSignature: async target => { calls.signature++; return { archivePath: target, archiveSize: 7, archiveMtimeMs: 123.125, archiveIdentity: "fixed" }; },
      listArchiveImages: async () => images,
      extractArchiveMemberToCache: async (_archive, member, target) => { calls.extract++; selected = member; fs.writeFileSync(target, "RAW:" + member); },
      compressImageFileToJpeg: async () => { calls.compress++; return Buffer.from("JPEG:" + selected); },
      notFound: res => { res.writeHead(404); res.end("missing"); } });
    const res = response(); res.writeHead = (status, headers = {}) => { res.statusCode = status; res.headers = headers; };
    console.warn = (...args) => errors.push(args.map(String)); measured = options.measure ? counters : null;
    let row;
    try { await service.serveCover(res, album.id); }
    finally {
      measured = null; console.warn = warn;
      try { row = database.prepare("SELECT * FROM photo_set_covers").get(); await service.stop(); }
      finally { storage.close(); }
    }
    return { payload: { status: res.statusCode, headers: res.headers, body: res.body }, row, selected, errors, log, calls, counters };
  }
  try {
    const direct = directFactories.map(make => make({ coverHints: new Set(hints), ...methods }));
    try {
      for (const images of shapes) {
        const old = direct[0].selectCoverImage(images), current = direct[1].selectCoverImage(images);
        assert.deepEqual(current, old); if (old) assert.strictEqual(current.image, old.image, "retain the selected input object");
        directOracles++;
      }
    } finally { await Promise.all(direct.map(service => service.stop())); }
    const heldError = new Error("held selector error");
    for (const mode of ["getter", "changing-path", "has-error", "empty-stem", "invalid-path", "bad-stem"]) {
      const values = [];
      for (const make of directFactories) {
        const log = [], images = ["cover.jpg", "later.jpg", "folder.png"].map((member, index) => { let reads = 0; return {
          get path() { log.push(["path", index, ++reads]); return mode === "changing-path" && index === 0 && reads > 1 ? "" : mode === "invalid-path" && index === 1 ? 123 : member; },
          get name() { log.push(["name", index]); return "poster.jpg"; }
        }; });
        const service = make({ coverHints: { has(value) { log.push(["has", value]); if (mode === "has-error") throw heldError; return hints.includes(value); } },
          fileBase(value) { log.push(["fileBase", value]); return mode === "bad-stem" ? null : mode === "empty-stem" ? "" : methods.fileBase(value); },
          normalizeExt(value) { log.push(["normalizeExt", value]); return methods.normalizeExt(value); } });
        let result, error;
        try { const value = service.selectCoverImage(images); result = value ? { index: images.indexOf(value.image), explicit: value.isExplicitCover } : null; }
        catch (caught) { error = caught; }
        if (mode === "has-error") assert.strictEqual(error, heldError);
        values.push({ log, result, error: error ? { name: error.name, message: error.message } : null }); await service.stop();
      }
      assert.deepEqual(values[1], values[0], mode);
      if (mode === "getter") assert.deepEqual(values[0].log.slice(0, 3), [["path", 0, 1], ["path", 1, 1], ["path", 2, 1]], "complete filtering precedes any scoring");
      directOracles++;
    }
    async function compare(images, options = {}) {
      const old = await owner(legacyFactory, images, options), current = await owner(activeFactory, images, options);
      for (const key of ["payload", "row", "selected", "errors", "log", "calls"]) assert.deepEqual(current[key], old[key], "complete owner " + key);
      if (options.fail) assert.equal(current.calls.extract, 0, "a later scoring error must still prevent extraction");
      ownerOracles++; return { old, current };
    }
    for (const images of shapes) await compare(images);
    for (const fail of ["fileBase", "normalizeExt"]) await compare([{ path: "cover.jpg" }, { path: "later.jpg" }, { path: "later2.png" }], { fail });
    const budgets = [];
    for (const kind of ["none", "one", "many"]) {
      const images = Array.from({ length: 50_000 }, (_, index) => {
        const stem = kind === "none" ? "image-" + index : kind === "one" ? (index === 49_999 ? "cover" : "image-" + index)
          : ["cover", "part_cover_2", "bookcover2", "poster", "part_poster_2"][(index * 17) % 5];
        const depth = (index * 29) % 8, ext = [".jpg", ".PNG", ".webp", ".bmp"][(index * 13) % 4];
        return { path: Array.from({ length: depth }, (_, part) => "d" + part).join("/") + (depth ? "/" : "") + stem + "-" + (kind === "many" ? index : "") + ext };
      });
      budgets.push({ kind, ...(await compare(images, { measure: true })) });
    }
    console.log("photo-cover-selection: " + directOracles + " selector and " + ownerOracles + " complete owner oracles passed");
    for (const { kind, old, current } of budgets) {
      assert.equal(old.counters.records, 50_000, "old selector must create every score record");
      assert.equal(current.calls.fileBase, 50_000); assert.equal(current.calls.normalizeExt, 50_003);
      if (kind === "many") assert(old.counters.comparisons >= 49_999, "old mixed-hint source must perform real sorting");
      assert(current.counters.records <= 64, "cover selector score-record allocation budget: observed " + current.counters.records);
      assert.equal(current.counters.sorts, 0, "cover selector must not sort score records");
      assert.equal(current.counters.comparisons, 0);
    }
    scenarios += directOracles + ownerOracles;
  } finally { measured = null; Array.prototype.map = realMap; Array.prototype.reduce = realReduce; Array.prototype.sort = realSort; globalThis.Date = RealDate; console.warn = warn; }
}

async function verifyAsyncInventory() {
  const cacheRoot=path.join(temporary,"inventory");fs.mkdirSync(cacheRoot); const a=path.join(cacheRoot,"a.jpg"),b=path.join(cacheRoot,"b.jpg");fs.writeFileSync(a,"AAA");fs.writeFileSync(b,"BB");
  fs.utimesSync(a,new Date(1000),new Date(1000));fs.utimesSync(b,new Date(2000),new Date(2000));
  let reads=0,holdStat=false,held=false;const scanningGate=gate();
  const ops={...fs.promises,readdir:async(...args)=>{reads++;return fs.promises.readdir(...args);},lstat:async target=>{const value=await fs.promises.lstat(target);if(holdStat&&target===b&&!held){held=true;await scanningGate.promise;}return value;}};
  const cache=createImageReaderCacheService({rootDir:cacheRoot,getMaxBytes:()=>1000,cleanupTargetRatio:.8,cleanupIntervalMs:Infinity,touchThrottleMs:0,fsOps:ops,warn(){}});services.push(cache);
  const snapshots=await Promise.all(Array.from({length:16},()=>cache.statusAsync()));assert.equal(reads,1);assert(snapshots.every(value=>value.currentBytes===5&&value.fileCount===2));
  holdStat=true;const scan=cache.cleanup({refresh:true});await until(()=>held,"inventory old snapshot");await cache.touch(a);const touched=cache.status().entries.find(entry=>entry.relativePath==="a.jpg").touchedAt;
  scanningGate.resolve();await scan;assert.equal(cache.status().entries.find(entry=>entry.relativePath==="a.jpg").touchedAt,touched,"scan must merge concurrent touch rather than replace it with old mtime");
  fs.unlinkSync(b);fs.writeFileSync(path.join(cacheRoot,"external.jpg"),"NEW");const forced=await cache.cleanup({force:true});assert.equal(forced.removedCount,2);assert.equal(cache.status().fileCount,0,"forced cleanup must inspect external additions and removals");
  await cache.stop();assert.equal(await cache.touch(a),false);cache.scheduleCleanup();assert.equal(cache.diagnostics().timerPending,false);scenarios += 3;

  const heldRoot=path.join(temporary,"held-cache");fs.mkdirSync(heldRoot);let statHeld=false;const hold=gate();
  const stoppedCache=createImageReaderCacheService({rootDir:heldRoot,getMaxBytes:()=>100,cleanupTargetRatio:.8,cleanupIntervalMs:60000,stopTimeoutMs:20,
    fsOps:{...fs.promises,lstat:async value=>{statHeld=true;await hold.promise;return fs.promises.lstat(value);}},warn(){}});services.push(stoppedCache);
  const status=outcome(stoppedCache.statusAsync());await until(()=>statHeld,"cache stat owner");const stopping=outcome(stoppedCache.stop());assert.equal((await status).error.code,"IMAGE_READER_CACHE_STOPPED");assert.equal((await stopping).error.code,"IMAGE_READER_CACHE_STOP_INCOMPLETE");assert.equal(stoppedCache.diagnostics().scanning,true);
  await assert.rejects(stoppedCache.start(),error=>error.code==="IMAGE_READER_CACHE_STOP_INCOMPLETE");hold.resolve();await until(()=>!stoppedCache.diagnostics().scanning,"cache real drain");await stoppedCache.start();await stoppedCache.stop();scenarios++;
}

async function verifyCacheInterleavingAndLinks() {
  const cacheRoot=path.join(temporary,"race-cache");fs.mkdirSync(cacheRoot);const file=path.join(cacheRoot,"a.jpg");fs.writeFileSync(file,"AAA");
  let maxBytes=100,holdCleanup=false,held=false;const gateCleanup=gate();
  const cache=createImageReaderCacheService({rootDir:cacheRoot,getMaxBytes:()=>maxBytes,cleanupTargetRatio:0,cleanupIntervalMs:60000,touchThrottleMs:0,warn(){},
    fsOps:{...fs.promises,realpath:async target=>{const value=await fs.promises.realpath(target);if(holdCleanup&&target===file&&!held){held=true;await gateCleanup.promise;}return value;}}});services.push(cache);
  await cache.statusAsync();maxBytes=0;holdCleanup=true;const cleaning=cache.cleanup();await until(()=>held,"cleanup old identity");await cache.touch(file);gateCleanup.resolve();
  assert.equal((await cleaning).removedCount,0,"cleanup must not delete an internally touched entry after an async path check");assert.equal(fs.existsSync(file),true);await cache.stop();scenarios++;

  const linkedRoot=path.join(temporary,"link-cache"),outside=path.join(temporary,"owned-outside");fs.mkdirSync(linkedRoot);fs.mkdirSync(outside);const outsideFile=path.join(outside,"cover.jpg");fs.writeFileSync(outsideFile,"AAA");fs.utimesSync(outsideFile,new Date(1000),new Date(1000));
  fs.symlinkSync(outside,path.join(linkedRoot,"branch"),process.platform==="win32"?"junction":"dir");const before=fs.statSync(outsideFile).mtimeMs;
  const linkedCache=createImageReaderCacheService({rootDir:linkedRoot,getMaxBytes:()=>100,cleanupTargetRatio:.8,cleanupIntervalMs:60000,warn(){}});services.push(linkedCache);
  assert.equal(await linkedCache.touch(path.join(linkedRoot,"branch","cover.jpg")),false);assert.equal(fs.statSync(outsideFile).mtimeMs,before);
  let children=0;const reader=archiveService({getImageGalleryDb:()=>galleryDb(),statFile:async()=>stat(),imageReaderCacheService:linkedCache,spawnProcess:()=>{children++;assert.fail("unsafe target must not spawn");}});
  await assert.rejects(reader.extractArchiveMemberToCache(path.join(temporary,"source.zip"),"cover.jpg",path.join(linkedRoot,"branch","cover.jpg")),error=>error.code==="ARCHIVE_READER_UNSAFE_TARGET");
  const res=response();await reader.serveArchiveMemberImage(res,{archivePath:path.join(temporary,"source.zip"),memberPath:"cover.jpg",sourceType:"branch"});assert.equal(res.statusCode,403);assert.equal(children,0);assert.equal(fs.statSync(outsideFile).mtimeMs,before);await reader.stop();scenarios++;

  const backgroundRoot=path.join(temporary,"background");fs.mkdirSync(backgroundRoot);const hold=gate();let waiting=false;
  const background=createImageReaderCacheService({rootDir:backgroundRoot,getMaxBytes:()=>100,cleanupTargetRatio:.8,cleanupIntervalMs:60000,stopTimeoutMs:20,warn(){},fsOps:{...fs.promises,lstat:async value=>{waiting=true;await hold.promise;return fs.promises.lstat(value);}}});services.push(background);
  await background.start({backgroundInventory:true});assert.equal(waiting,true);assert.equal(background.diagnostics().scanning,true,"background startup must retain inventory owner without awaiting tree");
  const status=outcome(background.statusAsync()),cleanup=outcome(background.cleanup({force:true}));background.beginStop();assert.equal((await status).error.statusCode,503);assert.equal((await cleanup).error.statusCode,503);
  assert.equal(background.diagnostics().scanning,true);const stopping=outcome(background.stop());hold.resolve();assert.equal((await stopping).error,undefined);await background.start();await background.stop();scenarios++;
}

async function verifyWarmCoverIdentity() {
  for(const status of ["ok","error"]){const database=galleryDb();let calls=0;
    const album={id:"cached",sourceRoot:temporary,relativePath:"cached.zip",updatedAt:"old"},sourcePath=path.join(temporary,"cached.zip");
    database.prepare("INSERT INTO photo_set_covers(album_id,archive_path,archive_size,archive_mtime_ms,archive_identity,cover_blob,generator_version,status,updated_at) VALUES(?,?,?,?,?,?,?,?,?)").run("cached",sourcePath,7,123.125,"old",Buffer.from("OLD"),2,status,"old");
    const service=createPhotoSetService({archiveImageExts:new Set([".jpg"]),coverGeneratorVersion:2,coverHints:new Set(),coverMaxBytes:1024,getImageGalleryDb:()=>database,getImageLibraryIndex:()=>({photoSets:[album]}),safeChildPath:(root,relative)=>path.join(root,relative),
      archiveImageSignature:async archivePath=>({archivePath,archiveSize:7,archiveMtimeMs:123.125,archiveIdentity:++calls===1?"old":"new"}),notFound:res=>res.end("missing"),listArchiveImages:()=>assert.fail("matching cached row must not relist")});services.push(service);
    const res=response();await service.serveCover(res,"cached");assert.equal(calls,2);assert.equal(res.statusCode,503);assert.notEqual(res.body?.toString(),"OLD");assert.equal(database.prepare("SELECT archive_identity FROM photo_set_covers").get().archive_identity,"old");await service.stop();scenarios++;
  }
}

async function verifyLateTargetJunction() {
  for(const mode of ["cached-stat","final-source"]){
    const cacheRoot=path.join(temporary,`late-target-${mode}`),sourcePath=path.join(temporary,`late-${mode}.zip`),sourceStat=stat();
    const source=archiveDiskSignature(sourcePath,sourceStat),archiveHash=crypto.createHash("sha1").update(source.archiveIdentity).digest("hex").slice(0,24),memberHash=crypto.createHash("sha1").update("cover.jpg").digest("hex").slice(0,24);
    const parent=path.join(cacheRoot,"photo",archiveHash),target=path.join(parent,`${memberHash}.jpg`),outside=path.join(temporary,`late-outside-${mode}`);
    fs.mkdirSync(parent,{recursive:true});fs.mkdirSync(outside);fs.writeFileSync(target,"INSIDE_OWNED");fs.writeFileSync(path.join(outside,path.basename(target)),"OUTSIDE_OWNED");
    const hold=gate();let waiting=false,sourceCalls=0,serves=0,touches=0;
    const cache=createImageReaderCacheService({rootDir:cacheRoot,getMaxBytes:()=>1000,cleanupTargetRatio:.8,cleanupIntervalMs:60000,warn(){}});services.push(cache);
    const service=archiveService({getImageGalleryDb:()=>galleryDb(),imageReaderCacheService:{rootDir:cacheRoot,scheduleCleanup(){},touch:async file=>{touches++;return cache.touch(file);}},
      statFile:async file=>{if(file===sourcePath){sourceCalls++;if(mode==="final-source"&&sourceCalls===2){waiting=true;await hold.promise;}return sourceStat;}const snapshot=await fs.promises.stat(file);if(mode==="cached-stat"&&file===target){waiting=true;await hold.promise;}return snapshot;},
      spawnProcess:()=>assert.fail("warm file should not start helper"),serveInlineFile:(res,file)=>{serves++;res.writeHead(200);res.end(fs.readFileSync(file));return true;}});
    const res=response(),job=service.serveArchiveMemberImage(res,{archivePath:sourcePath,memberPath:"cover.jpg",sourceType:"photo"});await until(()=>waiting,`${mode} path replacement window`);
    fs.unlinkSync(target);fs.rmdirSync(parent);fs.symlinkSync(outside,parent,process.platform==="win32"?"junction":"dir");hold.resolve();await job;
    assert.equal(res.statusCode,403);assert.equal(serves,0,"final canonical guard must reject target parent swapped during an async wait");assert.equal(touches,1);
    assert.equal(fs.readFileSync(path.join(outside,path.basename(target)),"utf8"),"OUTSIDE_OWNED");await service.stop();scenarios++;
  }

  const cacheRoot=path.join(temporary,"late-extract"),parent=path.join(cacheRoot,"photo"),target=path.join(parent,"result.jpg"),outside=path.join(temporary,"extract-outside"),sourcePath=path.join(temporary,"extract-source.zip");
  fs.mkdirSync(parent,{recursive:true});fs.mkdirSync(outside);fs.writeFileSync(path.join(outside,"result.jpg"),"OUTSIDE_OWNED");
  const hold=gate();let waiting=false,calls=0,staging;
  const service=archiveService({imageReaderCacheService:{rootDir:cacheRoot,touch:async()=>{},scheduleCleanup(){}},statFile:async()=>{if(++calls===2){waiting=true;await hold.promise;}return stat();},
    spawnProcess:(_file,args)=>{const child=fakeChild();staging=args.at(-1);fs.writeFileSync(staging,"SAFE_INSIDE");queueMicrotask(()=>{child.stdout.write('{"ok":true}');child.emit("close",0);});return child;}});
  const job=outcome(service.extractArchiveMemberToCache(sourcePath,"cover.jpg",target));await until(()=>waiting,"extract final source wait");
  fs.unlinkSync(staging);fs.rmdirSync(parent);fs.writeFileSync(path.join(outside,path.basename(staging)),"OUTSIDE_STAGING");fs.symlinkSync(outside,parent,process.platform==="win32"?"junction":"dir");hold.resolve();
  assert.equal((await job).error.code,"ARCHIVE_READER_UNSAFE_TARGET");assert.equal(fs.readFileSync(path.join(outside,"result.jpg"),"utf8"),"OUTSIDE_OWNED","late junction must not redirect publication");
  assert.equal(fs.readFileSync(path.join(outside,path.basename(staging)),"utf8"),"OUTSIDE_STAGING","failure cleanup must not unlink through a replaced parent");await service.stop();scenarios++;
}

async function verifyHostDrain() {
  for(const mode of ["archive","inventory"]){const held=gate();let started=false,stopCalled=false;const exits=[];const processRef=new EventEmitter();processRef.exit=code=>exits.push(code);
    const pool=createArchiveTaskPool({stopTimeoutMs:20});
    const cache=createImageReaderCacheService({rootDir:path.join(temporary,"host-cache"),getMaxBytes:()=>100,cleanupTargetRatio:.8,cleanupIntervalMs:60000,stopTimeoutMs:20,warn(){},fsOps:{...fs.promises,lstat:async()=>{started=true;await held.promise;return null;}}});
    const host=createServerHost({host:"127.0.0.1",port:0,getLibraryState:()=>({availableRoots:[],missingRoots:[]}),logger:{log(){},error(){}},processRef,networkInterfaces:()=>({}),shutdownTimeoutMs:1000,
      requestHandler:async(_req,res)=>{try{if(mode==="archive")await pool.run("http",()=>{started=true;return held.promise;});else await cache.statusAsync();res.end("ready");}catch(error){res.writeHead(error.statusCode||500);res.end(error.code);}},
      beginStop:()=>{pool.beginStop();cache.beginStop();},stop:async()=>{stopCalled=true;await (mode==="archive"?pool.stop():cache.stop());}});
    const server=host.listen();await new Promise(resolve=>server.once("listening",resolve));
    const result=new Promise((resolve,reject)=>{const req=http.get({hostname:"127.0.0.1",port:server.address().port,path:"/",agent:false},res=>{res.resume();res.once("end",()=>resolve(res.statusCode));});req.once("error",reject);});
    await until(()=>started,`${mode} HTTP owner`);await host.shutdown("fixture");assert.equal(await result,503);assert.equal(stopCalled,true,"server.close must drain logical HTTP before bounded stop");assert.deepEqual(exits,[1],"unclosed physical owner must fail closed, not report graceful success");
    assert.equal(mode==="archive"?pool.diagnostics().active:cache.diagnostics().scanning,mode==="archive"?1:true);held.resolve();await until(()=>mode==="archive"?pool.diagnostics().active===0:!cache.diagnostics().scanning,`${mode} physical settlement`);await pool.start();await pool.stop();await cache.start({backgroundInventory:true});await cache.stop();scenarios++;
  }
}

function inlineResponse() {
  const res = new PassThrough();
  res.chunks = []; res.on("data", chunk => res.chunks.push(Buffer.from(chunk)));
  res.req = Object.assign(new EventEmitter(), { method: "GET", headers: {}, aborted: false });
  res.writeHead = (status, headers = {}) => { res.statusCode = status; res.headers = headers; res.headersSent = true; };
  return res;
}

function inlineFixture(label, options = {}) {
  const cacheRoot = path.join(temporary, `inline-${label}`), sourcePath = path.join(temporary, `inline-${label}.zip`);
  fs.writeFileSync(sourcePath, "SYNTHETIC_ARCHIVE");
  const source = archiveDiskSignature(sourcePath, fs.statSync(sourcePath));
  const archiveHash = crypto.createHash("sha1").update(source.archiveIdentity).digest("hex").slice(0, 24);
  const memberHash = crypto.createHash("sha1").update("cover.jpg").digest("hex").slice(0, 24);
  const parent = path.join(cacheRoot, "photo", archiveHash), target = path.join(parent, `${memberHash}.jpg`);
  fs.mkdirSync(parent, { recursive: true }); fs.writeFileSync(target, "INSIDE_OWNED");
  const savedOpen = fs.promises.open, requests = [], responses = [];
  const io = { opens: 0, stats: 0, streams: 0, closeStarts: 0, closed: 0, handles: [], notFound: 0 };
  fs.promises.open = async (file, ...args) => {
    if (path.resolve(file) !== target) return savedOpen(file, ...args);
    io.opens++;
    if (options.beforeOpenGate) await options.beforeOpenGate.promise;
    const actual = await savedOpen(file, ...args); io.handles.push(actual);
    let closing;
    const owner = {
      async stat() {
        io.stats++; const snapshot = await actual.stat();
        if (options.statGate) await options.statGate.promise;
        return snapshot;
      },
      close() {
        if (!closing) {
          io.closeStarts++;
          closing = (async () => {
            if (options.closeGate) await options.closeGate.promise;
            await actual.close(); io.closed++;
          })();
        }
        return closing;
      },
      createReadStream() {
        io.streams++; let started = false;
        return new Readable({
          read() {
            if (started) return; started = true;
            (async () => {
              if (options.bodyGate) await options.bodyGate.promise;
              if (this.destroyed) return;
              const buffer = await actual.readFile();
              if (!this.destroyed) { this.push(buffer); this.push(null); }
            })().catch(error => this.destroy(error));
          },
          destroy(error, done) { owner.close().then(() => done(error), done); }
        });
      }
    };
    if (options.openGate) await options.openGate.promise;
    return owner;
  };
  const notFound = res => { io.notFound++; res.writeHead(404); res.end("missing"); };
  const files = createFileServer({ mimeTypes: { ".jpg": "image/jpeg" }, normalizeExt: value => path.extname(value).toLowerCase(), notFound, stopTimeoutMs: options.stopTimeoutMs || 1000 });
  const service = archiveService({ stopTimeoutMs: options.stopTimeoutMs || 1000,
    imageReaderCacheService: { rootDir: cacheRoot, touch: async () => {}, scheduleCleanup() {} },
    statFile: file => fs.promises.stat(file), spawnProcess: () => assert.fail("warm synthetic target must not extract"),
    serveInlineFile: files.serveInlineFile, notFound });
  return { io, service, files, sourcePath, parent, target, cacheRoot,
    request() {
      const res = inlineResponse(); responses.push(res);
      const task = service.serveArchiveMemberImage(res, { archivePath: sourcePath, memberPath: "cover.jpg", sourceType: "photo" });
      requests.push(task); return { res, task };
    },
    async close() {
      for (const res of responses) if (!res.destroyed && !res.writableEnded) res.destroy();
      for (const value of Object.values(options)) value?.resolve?.();
      try { await Promise.allSettled(requests); await Promise.allSettled([service.stop(), files.stop()]); }
      finally { fs.promises.open = savedOpen; }
      assert(io.handles.every(handle => handle.fd === -1), "every actual private file descriptor must close");
      assert.equal(files.diagnostics().active, 0, "file resource ownership must retire with the archive's physical stream");
    }
  };
}

async function inlineScenario(name, run) {
  if (inlineCase && !name.includes(inlineCase)) return;
  await run(); scenarios++; console.log(`PASS ${name}`);
}

async function verifyAsyncInlineOwnership() {
  await inlineScenario("async-inline-full-response-and-descriptor-close", async () => {
    const bodyGate = gate(), closeGate = gate(), f = inlineFixture("normal", { bodyGate, closeGate });
    try {
      let done = false; const { res, task } = f.request(); task.then(() => { done = true; });
      await until(() => f.io.streams === 1, "owned inline stream"); await tick();
      assert.equal(done, false); assert.equal(f.service.diagnostics().active, 1);
      bodyGate.resolve(); await until(() => f.io.closeStarts === 1 && res.writableFinished, "response finish before physical close");
      assert.equal(done, false); assert.equal(f.io.closed, 0); assert(f.io.handles[0].fd >= 0);
      assert.equal(f.service.diagnostics().active, 1, "finished HTTP body must retain its stream owner until the descriptor closes");
      assert.equal(f.files.diagnostics().active, 1, "global file ownership observes the same retained physical stream");
      closeGate.resolve(); await task;
      assert.equal(res.statusCode, 200); assert.equal(Buffer.concat(res.chunks).toString(), "INSIDE_OWNED");
      assert.equal(res.headers["Content-Length"], 12); assert.equal(f.io.closed, 1); assert.equal(done, true);
      assert.equal(f.files.diagnostics().active, 0);
      assert.equal(res.listeners("close").filter(value => value.name === "disconnect").length, 0);
    } finally { await f.close(); }
  });
  await inlineScenario("async-inline-clear-during-ignored-open", async () => {
    const openGate = gate(), closeGate = gate(), f = inlineFixture("clear-open", { openGate, closeGate });
    try {
      let done = false; const { res, task } = f.request(); task.then(() => { done = true; });
      await until(() => f.io.handles.length === 1, "held actual open"); f.service.clearListCache();
      openGate.resolve(); await until(() => f.io.closeStarts === 1, "cancelled open closes its handle");
      assert.equal(done, false); assert.equal(f.service.diagnostics().active, 1); assert.equal(f.io.stats, 0);
      closeGate.resolve(); await task; assert.equal(res.statusCode, undefined); assert.equal(Buffer.concat(res.chunks).length, 0);
      assert.equal(f.io.closed, 1);
    } finally { await f.close(); }
  });
  await inlineScenario("async-inline-stop-held-stat-fences-restart-until-close", async () => {
    const statGate = gate(), closeGate = gate(), f = inlineFixture("stop-stat", { statGate, closeGate, stopTimeoutMs: 20 });
    try {
      const { res, task } = f.request(); await until(() => f.io.stats === 1, "held same-handle stat");
      f.files.beginStop();
      const stopping = outcome(f.service.stop()), fileStopping = outcome(f.files.stop());
      assert.equal((await stopping).error.code, "ARCHIVE_READER_STOP_INCOMPLETE");
      assert.equal((await fileStopping).error.code, "FILE_SERVER_STOP_INCOMPLETE");
      assert.equal(f.files.diagnostics().active, 1);
      await assert.rejects(f.files.start(), error => error.code === "FILE_SERVER_STOP_INCOMPLETE");
      assert.equal(f.service.diagnostics().active, 1); await assert.rejects(f.service.start(), error => error.code === "ARCHIVE_READER_STOP_INCOMPLETE");
      statGate.resolve(); await until(() => f.io.closeStarts === 1, "stopped stat physical close");
      assert.equal(f.io.closed, 0); assert.equal(f.service.diagnostics().active, 1);
      closeGate.resolve(); await task; await until(() => f.service.diagnostics().tasks === 0, "closed inline owner");
      assert.equal(f.files.diagnostics().active, 0);
      assert.equal(res.statusCode, undefined); assert.equal(Buffer.concat(res.chunks).length, 0);
      await f.files.start(); await f.service.start(); const fresh = f.request(); await fresh.task;
      assert.equal(fresh.res.statusCode, 200); assert.equal(Buffer.concat(fresh.res.chunks).toString(), "INSIDE_OWNED");
    } finally { await f.close(); }
  });
  await inlineScenario("async-inline-body-disconnect-waits-for-physical-close", async () => {
    const bodyGate = gate(), closeGate = gate(), f = inlineFixture("body-cancel", { bodyGate, closeGate });
    try {
      let done = false; const { res, task } = f.request(); task.then(() => { done = true; });
      await until(() => f.io.streams === 1, "body stream"); res.destroy();
      await until(() => f.io.closeStarts === 1, "disconnected stream close"); await tick();
      assert.equal(done, false); assert.equal(f.service.diagnostics().active, 1); assert.equal(f.io.closed, 0);
      bodyGate.resolve(); closeGate.resolve(); await task; assert.equal(Buffer.concat(res.chunks).length, 0); assert.equal(f.io.closed, 1);
      assert.equal(res.listeners("close").filter(value => value.name === "disconnect").length, 0);
    } finally { await f.close(); }
  });
  await inlineScenario("async-inline-unique-response-owners-bound-four-of-128", async () => {
    const bodyGate = gate(), closeGate = gate(), f = inlineFixture("capacity", { bodyGate, closeGate });
    try {
      const requests = Array.from({ length: 129 }, () => f.request());
      await until(() => f.io.streams >= 4, "four inline stream owners"); await tick();
      assert.equal(f.io.opens, 4, "responses cannot reuse a prepared path as an unbounded stream launch");
      assert.equal(f.service.diagnostics().active, 4); assert.equal(f.service.diagnostics().tasks, 128);
      assert.equal(f.files.diagnostics().active, 4, "file owner registry must not bypass or duplicate archive admission");
      assert.equal(requests[128].res.statusCode, 503);
      bodyGate.resolve(); await until(() => f.io.closeStarts === 4, "four finished response handles");
      assert.equal(f.io.opens, 4); assert.equal(f.io.closed, 0);
      closeGate.resolve(); await Promise.all(requests.map(value => value.task));
      assert.equal(f.io.closed, 128); assert.equal(f.io.streams, 128);
      assert(requests.slice(0, 128).every(({ res }) => res.statusCode === 200 && Buffer.concat(res.chunks).toString() === "INSIDE_OWNED"));
    } finally { await f.close(); }
  });
  await inlineScenario("async-inline-source-replacement-after-open-rejects-before-headers", async () => {
    const openGate = gate(), f = inlineFixture("source-after-open", { openGate });
    try {
      const { res, task } = f.request(); await until(() => f.io.handles.length === 1, "source-change open");
      fs.writeFileSync(f.sourcePath, "REPLACED_ARCHIVE_SOURCE"); openGate.resolve(); await task;
      assert.equal(res.statusCode, 409); assert.equal(f.io.streams, 0); assert.equal(f.io.closed, 1);
      assert.notEqual(Buffer.concat(res.chunks).toString(), "INSIDE_OWNED");
    } finally { await f.close(); }
  });
  await inlineScenario("async-inline-cache-junction-after-opened-same-fd-is-rejected", async () => {
    const statGate = gate(), f = inlineFixture("junction-after-open", { statGate });
    const outside = path.join(temporary, "inline-outside-owned"), retired = path.join(f.cacheRoot, "retired-owned");
    fs.mkdirSync(outside); fs.writeFileSync(path.join(outside, path.basename(f.target)), "OUTSIDE_OWNED");
    try {
      const { res, task } = f.request(); await until(() => f.io.stats === 1, "opened same-FD stat");
      // Windows cannot rename the containing directory while its file is open.
      // Retire only that synthetic file, then replace its now-empty parent.
      fs.mkdirSync(retired); fs.renameSync(f.target, path.join(retired, path.basename(f.target)));
      fs.rmdirSync(f.parent); fs.symlinkSync(outside, f.parent, process.platform === "win32" ? "junction" : "dir");
      statGate.resolve(); await task;
      assert.equal(res.statusCode, 403, "the final cache-path guard must run after the actual file handle's metadata await");
      assert.equal(f.io.streams, 0); assert.equal(f.io.closed, 1);
      assert.equal(fs.readFileSync(path.join(outside, path.basename(f.target)), "utf8"), "OUTSIDE_OWNED");
      assert.equal(fs.readFileSync(path.join(retired, path.basename(f.target)), "utf8"), "INSIDE_OWNED");
    } finally { await f.close(); }
  });
  await inlineScenario("async-inline-cache-eviction-before-open-is-one-404", async () => {
    const beforeOpenGate = gate(), f = inlineFixture("evicted-before-open", { beforeOpenGate });
    try {
      const { res, task } = f.request(); await until(() => f.io.opens === 1, "cache eviction window");
      fs.unlinkSync(f.target); beforeOpenGate.resolve(); await task;
      assert.equal(res.statusCode, 404); assert.equal(f.io.notFound, 1, "the archive wrapper must not send a second missing-file response");
      assert.equal(f.io.streams, 0); assert.equal(f.io.handles.length, 0);
    } finally { await f.close(); }
  });
}

function storedZip(name,text) {
  const data=Buffer.from(text),file=Buffer.from(name);let crc=0xffffffff;for(const value of data){crc^=value;for(let bit=0;bit<8;bit++)crc=(crc>>>1)^((crc&1)?0xedb88320:0);}crc=(crc^0xffffffff)>>>0;
  const local=Buffer.alloc(30);local.writeUInt32LE(0x04034b50);local.writeUInt16LE(20,4);local.writeUInt32LE(crc,14);local.writeUInt32LE(data.length,18);local.writeUInt32LE(data.length,22);local.writeUInt16LE(file.length,26);
  const central=Buffer.alloc(46);central.writeUInt32LE(0x02014b50);central.writeUInt16LE(20,4);central.writeUInt16LE(20,6);central.writeUInt32LE(crc,16);central.writeUInt32LE(data.length,20);central.writeUInt32LE(data.length,24);central.writeUInt16LE(file.length,28);
  const end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50);end.writeUInt16LE(1,8);end.writeUInt16LE(1,10);end.writeUInt32LE(central.length+file.length,12);end.writeUInt32LE(local.length+file.length+data.length,16);
  return Buffer.concat([local,file,data,central,file,end]);
}

function cleanupOwnedRoot() {
  const resolved=fs.realpathSync(temporary),tempRoot=fs.realpathSync(os.tmpdir());
  assert.equal(path.dirname(resolved).toLowerCase(),tempRoot.toLowerCase());assert(path.basename(resolved).startsWith("fanhao-archive-lifecycle-"));assert(!fs.lstatSync(resolved).isSymbolicLink());
  if(process.platform!=="win32"){fs.rmSync(resolved,{recursive:true});return;}
  const result=spawnSync("powershell.exe",["-NoProfile","-NonInteractive","-Command","$ErrorActionPreference='Stop'; $target=(Resolve-Path -LiteralPath $env:FANHAO_ARCHIVE_LIFECYCLE_CLEANUP).ProviderPath; $temporary=(Resolve-Path -LiteralPath ([IO.Path]::GetTempPath())).ProviderPath.TrimEnd('\\'); if (-not [string]::Equals([IO.Path]::GetDirectoryName($target),$temporary,[StringComparison]::OrdinalIgnoreCase)) { throw 'Invalid fixture parent' }; if (-not [IO.Path]::GetFileName($target).StartsWith('fanhao-archive-lifecycle-')) { throw 'Invalid fixture name' }; if ((Get-Item -LiteralPath $target).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Invalid fixture link' }; Remove-Item -LiteralPath $target -Recurse -Force"],{env:{...process.env,FANHAO_ARCHIVE_LIFECYCLE_CLEANUP:resolved},windowsHide:true,encoding:"utf8"});
  assert.equal(result.status,0,result.stderr||"Native owned fixture cleanup failed");
}

try {
  if (!inlineCase) {
    await verifyBoundedPool();await verifyChildCloseOwnership();await verifyIndexAuthority();await verifyOldSchemaAndZipIdentity();await verifyPhotoAuthority();await verifyPhotoAuthorityBytes();await verifyPhotoCoverSelection();await verifyAsyncInventory();await verifyCacheInterleavingAndLinks();await verifyWarmCoverIdentity();await verifyLateTargetJunction();await verifyHostDrain();
  }
  if (!inlineCase) await verifyIndexStampWork();
  if (!inlineCase || inlineCase === "photo-detail-paging") await verifyPhotoDetailPaging();
  await verifyAsyncInlineOwnership();
  assert(scenarios > 0, `No async inline scenario matched ${inlineCase}`);
  console.log(`archive-reader-lifecycle: ok (${scenarios} scenarios; controlled children/stat, synthetic ZIP, private SQLite)`);
} finally {
  const stopped=await Promise.allSettled(services.map(service=>service.stop()));for(const result of stopped)if(result.status==="rejected")console.error(result.reason.message);
  for(const service of databases)service.close();cleanupOwnedRoot();
}
