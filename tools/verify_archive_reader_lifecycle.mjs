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
    pythonPath: process.execPath, helperPath: path.join(projectRoot, "tools/fixtures/archive_image_helper_fixture.mjs"), ffmpegPath: process.execPath,
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
    await verifyBoundedPool();await verifyChildCloseOwnership();await verifyIndexAuthority();await verifyOldSchemaAndZipIdentity();await verifyPhotoAuthority();await verifyAsyncInventory();await verifyCacheInterleavingAndLinks();await verifyWarmCoverIdentity();await verifyLateTargetJunction();await verifyHostDrain();
  }
  await verifyAsyncInlineOwnership();
  assert(scenarios > 0, `No async inline scenario matched ${inlineCase}`);
  console.log(`archive-reader-lifecycle: ok (${scenarios} scenarios; controlled children/stat, synthetic ZIP, private SQLite)`);
} finally {
  const stopped=await Promise.allSettled(services.map(service=>service.stop()));for(const result of stopped)if(result.status==="rejected")console.error(result.reason.message);
  for(const service of databases)service.close();cleanupOwnedRoot();
}
