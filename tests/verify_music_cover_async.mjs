import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { createMediaResponseService } from "../src/platform/server/media-response-service.js";
import { createMusicRuntime } from "../src/modules/music/server/runtime.js";
import { boundedInteger } from "../src/platform/server/local-image-read-queue.js";

const unhandled = [];
const onUnhandled = (error) => unhandled.push(error);
process.on("unhandledRejection", onUnhandled);
const cache = new Map();
const bytes = Buffer.from("controlled cover fixture");
const modifiedAt = "2026-10-04T00:00:00.000Z";
let readGate = null;
let activeReads = 0;
let peakReads = 0;
let reads = 0;
let writeFailure = false;
const db = {
  prepare(sql) {
    if (sql.includes("SELECT file_path, source_size")) return { get: (id) => cache.get(id) || null };
    if (sql.includes("SELECT *") || sql.includes("SELECT 1 AS ready")) return {
      get(id, filePath, size, mtime) {
        const row = cache.get(id);
        return row?.file_path === filePath && row.source_size === size && row.source_mtime === mtime ? row : null;
      }
    };
    return {
      run(id, filePath, relativePath, contentType, buffer, byteLength, sourceSize, sourceMtime) {
        if (writeFailure) throw new Error("controlled cache write failure");
        if (!sql.includes("image_blob = excluded.image_blob")) return;
        cache.set(id, { file_path: filePath, image_blob: buffer, content_type: contentType, byte_length: byteLength, source_size: sourceSize, source_mtime: sourceMtime });
      }
    };
  }
};
const service = createMediaResponseService({
  getCoreDb: () => db,
  mimeTypes: { ".jpg": "image/jpeg" },
  notFound: (res) => { res.writeHead(404); res.end(); },
  sendText: (res, status, text) => { res.writeHead(status); res.end(text); },
  safeStat: () => assert.fail("async covers must not use the synchronous disk read path"),
  localImageReadConcurrency: 4,
  localImageWaitMs: 1,
  statFile: async (filePath) => {
    if (filePath === "missing") throw Object.assign(new Error("controlled missing image"), { code: "ENOENT" });
    return { isFile: () => true, size: filePath === "empty" ? 0 : bytes.length, mtime: new Date(modifiedAt) };
  },
  readFile: async (filePath) => {
    reads += 1;
    activeReads += 1;
    peakReads = Math.max(peakReads, activeReads);
    try {
      if (readGate) await readGate.promise;
      if (filePath === "denied") throw Object.assign(new Error("controlled denied image"), { code: "EACCES" });
      return bytes;
    } finally {
      activeReads -= 1;
    }
  },
  warn: () => {}
});
const runtime = createMusicRuntime({
  dbPath: path.join(os.tmpdir(), `unused-fanhao-cover-fixture-${process.pid}.sqlite`),
  roots: [],
  mediaResponseService: service,
  sendJson: (res, status, value) => { res.writeHead(status); res.end(JSON.stringify(value)); }
});
runtime.store.coverFile = (id) => file(id);
runtime.store.coverFileAsync = async (id) => file(id);

try {
  readGate = deferred();
  const responses = Array.from({ length: 10 }, () => response());
  const duplicated = responses.map((res) => route(res, "same"));
  await immediate();
  assert.equal(reads, 1, "concurrent requests for one cold cover must coalesce the disk read");
  assert.ok(responses.every((res) => !res.writableEnded), "the event loop must run while the cold image read is pending");
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.ok(responses.every((res) => !res.headersSent), "the music consumer must not return prepared-image 503 after its wait budget");
  readGate.resolve();
  await Promise.all(duplicated);
  assert.ok(responses.every((res) => res.status === 200 && res.body.equals(bytes)));
  const warm = response();
  await route(warm, "same");
  assert.equal(reads, 1, "warm requests must still use the persistent local-image cache");

  readGate = deferred();
  const manyResponses = Array.from({ length: 12 }, () => response());
  const many = manyResponses.map((res, index) => route(res, `unique-${index}`));
  await immediate();
  assert.equal(activeReads, 4, "unique covers must use the existing bounded queue");
  readGate.resolve();
  await Promise.all(many);
  assert.equal(peakReads, 4);
  assert.ok(manyResponses.every((res) => res.status === 200));
  readGate = null;

  for (const [id, expected] of [["missing", 404], ["empty", 404], ["denied", 500]]) {
    const res = response();
    await route(res, id);
    assert.equal(res.status, expected, `${id} must preserve the image/error response contract`);
  }
  writeFailure = true;
  const fallback = response();
  await route(fallback, "uncached-fallback");
  assert.equal(fallback.status, 200, "a cache failure must still deliver the source image");
  assert.equal(fallback.headers["Cache-Control"], "public, max-age=3600");
  writeFailure = false;

  readGate = deferred();
  const disconnected = response();
  const disconnectedTask = route(disconnected, "disconnected");
  await immediate();
  disconnected.destroy();
  readGate.resolve();
  await disconnectedTask;
  assert.equal(disconnected.headersSent, false, "a disconnected response must not be written after reading finishes");

  readGate = deferred();
  const closing = response();
  closing.destroy = () => { closing.destroyed = true; }; // Native close can arrive later.
  const pending = route(closing, "closing");
  await immediate();
  let stopped = false;
  const stop = runtime.beginStop().then(() => { stopped = true; });
  await immediate();
  assert.equal(closing.destroyed, true, "shutdown must release pending HTTP cover responses");
  assert.equal(stopped, false, "shutdown must await dispatched cache writes before releasing store resources");
  const rejected = response();
  await route(rejected, "after-stop");
  assert.equal(rejected.status, 503, "new covers must not start during shutdown");
  readGate.resolve();
  await Promise.all([pending, stop]);
  assert.equal(cache.has("closing"), false, "stop revokes cache writes without waiting for an HTTP close event");
  await runtime.stop();
  await verifyPathIdentity();
  await verifyFinalAuthority();
  await verifyReaderLifecycle();
  await verifyMetadataCapacity();
  await verifyRealStoreAndCacheLocks();
  await immediate();
  assert.deepEqual(unhandled, []);
  console.log(`music-cover-async: ok (single-flight, queue concurrency=${peakReads}, final disk/db/row authority, bounded metadata, async warm stat, cache lock fallback/timeout restoration, disconnect, restart fences and shutdown)`);
} finally {
  readGate?.resolve();
  await runtime.stop();
  process.off("unhandledRejection", onUnhandled);
}

async function verifyPathIdentity() {
  // Exercise the production SQL against private in-memory SQLite, rather than
  // letting a fake cache hide a missing file_path predicate or error UPDATE.
  const database = new DatabaseSync(":memory:");
  database.exec(`
    ATTACH DATABASE ':memory:' AS fanhao_images;
    CREATE TABLE fanhao_images.local_image_cache (
      file_id TEXT PRIMARY KEY, file_path TEXT, relative_path TEXT,
      content_type TEXT, image_blob BLOB, byte_length INTEGER,
      source_size INTEGER, source_mtime TEXT, status TEXT, error TEXT,
      cached_at TEXT, updated_at TEXT
    );
  `);
  const gates = new Map();
  const failures = new Set();
  const pathBytes = new Map([["old.jpg", Buffer.from("OLD")], ["new.jpg", Buffer.from("NEW")]]);
  let sourceReads = 0;
  const images = createMediaResponseService({
    getCoreDb: () => database,
    mimeTypes: { ".jpg": "image/jpeg" },
    notFound: (res) => { res.writeHead(404); res.end(); },
    sendText: (res, status, text) => { res.writeHead(status); res.end(text); },
    statFile: async () => ({ isFile: () => true, size: 3, mtime: new Date(modifiedAt) }),
    readFile: async (filePath) => {
      sourceReads += 1;
      if (gates.has(filePath)) await gates.get(filePath).promise;
      if (failures.has(filePath)) throw Object.assign(new Error("controlled source failure"), { code: "EACCES" });
      return pathBytes.get(filePath);
    },
    warn: () => {}
  });
  const oldFile = (id) => ({ ...file(id), path: "old.jpg", size: 3 });
  const newFile = (id) => ({ ...file(id), path: "new.jpg", size: 3 });
  const cached = (id) => database.prepare("SELECT * FROM fanhao_images.local_image_cache WHERE file_id = ?").get(id);
  const seed = (source) => database.prepare(`
    INSERT INTO fanhao_images.local_image_cache
      (file_id, file_path, image_blob, byte_length, content_type, source_size, source_mtime, status)
    VALUES (?, ?, ?, 3, 'image/jpeg', 3, ?, 'ok')
  `).run(source.id, source.path, pathBytes.get(source.path), modifiedAt);
  try {
    seed(oldFile("persisted"));
    const changed = response();
    await images.serveImageAsync(changed, newFile("persisted"));
    assert.ok(changed.body.equals(Buffer.from("NEW")), "same ID/size/mtime with a new source path must not return the old persisted bytes");
    assert.equal(sourceReads, 1);
    assert.equal(cached("persisted").file_path, "new.jpg");

    seed(oldFile("prewarm"));
    assert.deepEqual(await images.prewarmLocalImages([newFile("prewarm")]), { requested: 1, cached: 0, warmed: 1, failed: 0 });
    assert.deepEqual(await images.prewarmLocalImages([newFile("prewarm")]), { requested: 1, cached: 1, warmed: 0, failed: 0 });
    assert.deepEqual(await images.prewarmLocalImages([oldFile("two-paths"), newFile("two-paths")]), { requested: 2, cached: 0, warmed: 2, failed: 0 }, "prewarm deduplication must include the path");

    for (const firstToFinish of ["old.jpg", "new.jpg"]) {
      const id = `inflight-${firstToFinish}`;
      gates.set("old.jpg", deferred());
      gates.set("new.jpg", deferred());
      const oldResponse = response();
      const newResponse = response();
      const before = sourceReads;
      const oldTask = images.serveImageAsync(oldResponse, oldFile(id));
      const newTask = images.serveImageAsync(newResponse, newFile(id));
      await immediate();
      assert.equal(sourceReads - before, 2, "two paths for one ID must have distinct in-flight reads");
      gates.get(firstToFinish).resolve();
      await (firstToFinish === "old.jpg" ? oldTask : newTask);
      gates.get(firstToFinish === "old.jpg" ? "new.jpg" : "old.jpg").resolve();
      await Promise.all([oldTask, newTask]);
      assert.ok(oldResponse.body.equals(Buffer.from("OLD")));
      assert.ok(newResponse.body.equals(Buffer.from("NEW")));
      assert.equal(cached(id).file_path, "new.jpg", "an older source completing last must not replace the newer source's durable row");
      assert.ok(Buffer.from(cached(id).image_blob).equals(Buffer.from("NEW")));
      gates.clear();
    }

    seed(newFile("warm-supersedes"));
    gates.set("old.jpg", deferred());
    const staleResponse = response();
    const staleTask = images.serveImageAsync(staleResponse, oldFile("warm-supersedes"));
    await immediate();
    await images.serveImageAsync(response(), newFile("warm-supersedes"));
    gates.get("old.jpg").resolve();
    await staleTask;
    assert.equal(cached("warm-supersedes").file_path, "new.jpg", "a newer cache hit must also supersede an older pending source");
    gates.clear();

    gates.set("old.jpg", deferred());
    failures.add("old.jpg");
    const failedOld = response();
    const failedTask = images.serveImageAsync(failedOld, oldFile("stale-error"));
    await immediate();
    await images.serveImageAsync(response(), newFile("stale-error"));
    gates.get("old.jpg").resolve();
    await failedTask;
    assert.equal(failedOld.status, 500);
    assert.equal(cached("stale-error").file_path, "new.jpg");
    assert.equal(cached("stale-error").status, "ok", "a stale source failure must not poison the newer successful cache row");
    gates.clear();
    failures.clear();

    seed(oldFile("changed-error"));
    failures.add("new.jpg");
    const failedNew = response();
    await images.serveImageAsync(failedNew, newFile("changed-error"));
    assert.equal(failedNew.status, 500);
    assert.equal(cached("changed-error").image_blob, null, "changing the cached path after an error must not relabel retained bytes from the old path");
    assert.equal(images.localImageCacheRow(newFile("changed-error")), null);
    failures.clear();
    const retried = response();
    await images.serveImageAsync(retried, newFile("changed-error"));
    assert.ok(retried.body.equals(Buffer.from("NEW")));
  } finally {
    for (const gate of gates.values()) gate.resolve();
    database.close();
  }
}

function imageDatabase(cachePath = ":memory:") {
  const database = new DatabaseSync(":memory:");
  database.prepare("ATTACH DATABASE ? AS fanhao_images").run(cachePath);
  database.exec(`CREATE TABLE fanhao_images.local_image_cache (
    file_id TEXT PRIMARY KEY, file_path TEXT, relative_path TEXT,
    content_type TEXT, image_blob BLOB, byte_length INTEGER,
    source_size INTEGER, source_mtime TEXT, status TEXT, error TEXT,
    cached_at TEXT, updated_at TEXT)`);
  return database;
}
function imageService(database, extra = {}) {
  return createMediaResponseService({
    getCoreDb: () => database,
    mimeTypes: { ".jpg": "image/jpeg" },
    notFound: res => { res.writeHead(404); res.end(); },
    sendText: (res, status, value) => { res.writeHead(status); res.end(value); },
    safeStat: () => assert.fail("async image serving must never use safeStat"),
    statFile: async () => diskStat(), readFile: async () => Buffer.from("OLD"), warn: () => {},
    ...extra
  });
}
function diskStat(extra = {}) {
  return { isFile: () => true, size: 3, mtime: new Date(modifiedAt), mtimeMs: Date.parse(modifiedAt), dev: 1, ino: 1, ...extra };
}
function cacheRecord(database, id) {
  return database.prepare("SELECT * FROM fanhao_images.local_image_cache WHERE file_id = ?").get(id);
}
function seedUnmatched(database, id) {
  database.prepare(`INSERT INTO fanhao_images.local_image_cache
    (file_id,file_path,source_size,source_mtime,status,byte_length,updated_at)
    VALUES (?, 'unmatched.jpg', 9, 'old-time', 'error', 1, 'before')`).run(id);
}

async function verifyFinalAuthority() {
  const cases = ["db", "source", "inode", "mtime", "file_path", "source_size", "source_mtime", "status", "byte_length", "updated_at"];
  for (const failRead of [false, true]) for (const change of cases) {
    const a = imageDatabase(), b = imageDatabase(), gate = deferred();
    let currentDb = a, sourceCurrent = true, physical = diskStat(), stats = 0;
    const source = { ...file(`${change}-${failRead}`), size: 3, isCurrentSource: () => sourceCurrent };
    seedUnmatched(a, source.id);
    const images = imageService(a, {
      getCoreDb: () => currentDb,
      statFile: async () => { if (++stats === 2) await gate.promise; return physical; },
      readFile: async () => { if (failRead) throw Object.assign(new Error("controlled read failure"), { code: "EACCES" }); return Buffer.from("OLD"); }
    });
    try {
      const res = response(), pending = images.serveImageAsync(res, source);
      await immediate();
      assert.equal(stats, 2, `${change}: mutation must occur during the final filesystem await`);
      if (change === "db") currentDb = b;
      else if (change === "source") sourceCurrent = false;
      else if (change === "inode") physical = diskStat({ ino: 2 });
      else if (change === "mtime") physical = diskStat({ mtimeMs: physical.mtimeMs + 0.25 });
      else a.prepare(`UPDATE fanhao_images.local_image_cache SET ${change} = ? WHERE file_id = ?`).run(["source_size", "byte_length"].includes(change) ? 17 : "changed", source.id);
      const before = cacheRecord(a, source.id);
      gate.resolve(); await pending;
      assert.equal(res.status, failRead ? 500 : 200);
      assert.deepEqual(cacheRecord(a, source.id), before, `${change}: late success/error must preserve changed cache authority`);
      assert.equal(cacheRecord(b, source.id), undefined, "old read must not write into the replacement database");
    } finally { gate.resolve(); await images.stop(); a.close(); b.close(); }
  }
}

async function verifyReaderLifecycle() {
  const database = imageDatabase();
  let gate = deferred(), starts = 0, readSignal;
  const images = imageService(database, {
    localImageReadConcurrency: 1, localImageReadCapacity: 2,
    readFile: async (_, { signal }) => { starts++; readSignal = signal; if (gate) await gate.promise; return Buffer.from("OLD"); }
  });
  try {
    const old = response(), next = response(), controller = new AbortController();
    const first = images.serveImageAsync(old, { ...file("retry"), size: 3 }, { signal: controller.signal });
    await immediate(); controller.abort();
    const fresh = images.serveImageAsync(next, { ...file("retry"), size: 3 });
    await immediate();
    assert.equal(starts, 1, "fresh same-key consumer waits for the cancelled physical read");
    assert.deepEqual(images.localImageReaderDiagnostics(), { accepting: true, active: 1, pending: 1, tasks: 2, owners: 1 });
    const full = response(); await images.serveImageAsync(full, { ...file("full"), size: 3 });
    assert.equal(full.status, 503, "cancelled physical I/O must still consume capacity");
    gate.resolve(); await Promise.all([first, fresh]); await immediate();
    assert.equal(next.status, 200, "new consumer must not inherit an old consumer's abort");
    assert.equal(old.headersSent, false); assert.equal(starts, 2);

    gate = deferred();
    const one = response(), two = response(), abortOne = new AbortController();
    const firstShared = images.serveImageAsync(one, { ...file("shared"), size: 3 }, { signal: abortOne.signal });
    const secondShared = images.serveImageAsync(two, { ...file("shared"), size: 3 });
    await immediate(); abortOne.abort();
    assert.equal(readSignal.aborted, false, "one disconnected consumer must not cancel a shared live consumer");
    gate.resolve(); await Promise.all([firstShared, secondShared]);
    assert.equal(one.headersSent, false); assert.equal(two.status, 200);

    gate = deferred();
    const activeRes = response(), queuedRes = response();
    const activeTask = images.serveImageAsync(activeRes, { ...file("active-stop"), size: 3 });
    const queuedTask = images.serveImageAsync(queuedRes, { ...file("queued-stop"), size: 3 });
    await immediate(); const startsBeforeStop = starts;
    let finished = false;
    const stopping = images.stop().then(() => { finished = true; });
    const staleStart = images.start().then(() => null, error => error);
    images.beginStop();
    await immediate();
    assert.equal(finished, false); assert.equal(images.localImageReaderDiagnostics().active, 1);
    assert.equal(queuedRes.status, 503); assert.equal(starts, startsBeforeStop);
    const warmStopped = response(); await images.serveImageAsync(warmStopped, { ...file("retry"), size: 3 });
    assert.equal(warmStopped.status, 503, "global stop must reject even persistent cache hits");
    gate.resolve(); await Promise.all([activeTask, queuedTask, stopping]);
    assert.equal((await staleStart).statusCode, 503, "later stop must fence an older pending start");
    await immediate();
    assert.deepEqual(images.localImageReaderDiagnostics(), { accepting: false, active: 0, pending: 0, tasks: 0, owners: 0 });
    assert.equal(cacheRecord(database, "active-stop"), undefined, "cancelled read must not write after stop");
    await images.start(); gate = null;
    const restarted = response(); await images.serveImageAsync(restarted, { ...file("fresh-start"), size: 3 });
    assert.equal(restarted.status, 200);
    for (const [value, expected] of [[Infinity, 4], [NaN, 4], [-1, 1], [999, 16]]) assert.equal(boundedInteger(value, 4, 1, 16), expected);
    assert.equal(boundedInteger(1, 128, 4, 512), 4);
    assert.equal(boundedInteger(Infinity, 128, 4, 512), 128);
  } finally { gate?.resolve(); await images.stop(); database.close(); }
}

async function verifyMetadataCapacity() {
  const requests = [], gates = [], tasks = [];
  let starts = 0, imageStarts = 0, storeStops = 0, startGate = null;
  const bounded = createMusicRuntime({
    dbPath: path.join(os.tmpdir(), `unused-fanhao-metadata-${process.pid}.sqlite`), roots: [],
    mediaResponseService: { serveImageAsync: async () => { imageStarts++; } },
    sendJson: (res, status, value) => { res.writeHead(status); res.end(JSON.stringify(value)); },
    notFound: res => { res.writeHead(404); res.end(); },
    coverRequestConcurrency: Infinity, coverRequestCapacity: Infinity
  });
  bounded.store.coverFileAsync = async id => { starts++; const gate = deferred(); gates.push(gate); await gate.promise; return file(id); };
  bounded.store.stop = async () => { storeStops++; };
  bounded.store.start = async () => { if (startGate) await startGate.promise; };
  const request = id => {
    const req = new EventEmitter(); req.method = "GET";
    const res = response(); requests.push({ req, res });
    const task = bounded.routeMedia(req, res, new URL(`http://fixture/media/music-cover/${id}`)); tasks.push(task); return res;
  };
  try {
    const malformedReq = new EventEmitter(); malformedReq.method = "GET";
    const malformedRes = response();
    await assert.rejects(bounded.routeMedia(malformedReq, malformedRes, new URL("http://fixture/media/music-cover/%zz")), URIError);
    assert.deepEqual(bounded.coverDiagnostics(), { accepting: true, active: 0, pending: 0, retained: 0 });
    assert.equal(malformedReq.listenerCount("aborted"), 0); assert.equal(malformedRes.listenerCount("close"), 0);
    for (let i = 0; i < 140; i++) request(`album-${i}`);
    await immediate();
    assert.equal(starts, 4, "metadata stat must share the four-operation admission limit");
    assert.deepEqual(bounded.coverDiagnostics(), { accepting: true, active: 4, pending: 124, retained: 128 });
    assert.equal(requests.filter(value => value.res.status === 503).length, 12);
    requests[4].res.destroy(); await immediate();
    assert.equal(bounded.coverDiagnostics().retained, 127, "queued disconnect must free capacity before its stat starts");
    request("replacement-slot"); await immediate();
    assert.equal(bounded.coverDiagnostics().retained, 128); assert.equal(starts, 4);
    requests[0].res.destroy(); await immediate();
    assert.equal(bounded.coverDiagnostics().active, 4, "disconnected metadata stat keeps its physical slot until settlement");
    let stopped = false;
    const stopping = bounded.beginStop().then(() => { stopped = true; });
    const oldStart = bounded.start().then(() => null, error => error);
    bounded.beginStop(); await immediate();
    assert.equal(stopped, false); assert.equal(storeStops, 0);
    assert.equal(request("stopped").status, 503); assert.equal(starts, 4);
    for (const gate of gates) gate.resolve();
    await Promise.all([...tasks, stopping]); await immediate();
    assert.equal((await oldStart).statusCode, 503);
    assert.equal(imageStarts, 0, "stop during metadata await must not start an image read/cache write");
    assert.deepEqual(bounded.coverDiagnostics(), { accepting: false, active: 0, pending: 0, retained: 0 });
    startGate = deferred();
    const pendingStart = bounded.start().then(() => null, error => error);
    await immediate(); const laterStop = bounded.beginStop(); startGate.resolve();
    assert.equal((await pendingStart).statusCode, 503, "store-start await must also respect a later stop");
    await laterStop; assert.equal(request("late-start").status, 503);
    startGate = null; await bounded.start();
    const fresh = request("fresh"); await immediate(); gates.at(-1).resolve(); await tasks.at(-1);
    assert.equal(fresh.status, undefined); assert.equal(imageStarts, 1, "explicit fresh start can accept metadata again");
  } finally { for (const gate of gates) gate.resolve(); startGate?.resolve(); await bounded.stop(); await Promise.allSettled(tasks); }
}

async function verifyRealStoreAndCacheLocks() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fanhao-music-cover-async-"));
  const musicPath = path.join(directory, "music.sqlite"), coverPath = path.join(directory, "cover.jpg");
  const otherPath = path.join(directory, "other.jpg"), cachePath = path.join(directory, "cache.sqlite");
  fs.writeFileSync(coverPath, "OLD"); fs.writeFileSync(otherPath, "NEW");
  const memory = imageDatabase();
  let statGate = null, metadataStats = 0, imageReads = 0;
  const images = imageService(memory, {
    statFile: value => fs.promises.stat(value),
    readFile: value => { imageReads++; return fs.promises.readFile(value); }
  });
  const real = createMusicRuntime({
    dbPath: musicPath, roots: [], mediaResponseService: images,
    scanWorkerOptions: { coverStatFile: async value => { metadataStats++; if (statGate) await statGate.promise; return fs.promises.stat(value); } },
    sendJson: (res, status, value) => { res.writeHead(status); res.end(JSON.stringify(value)); },
    notFound: res => { res.writeHead(404); res.end(); }
  });
  let musicDb, lockedCache, locker;
  const originalSyncStat = fs.statSync;
  try {
    await real.store.coverFileAsync("initialize-schema");
    musicDb = new DatabaseSync(musicPath);
    musicDb.prepare(`INSERT INTO music_albums
      (id,artist_id,title,cover_path,source_root,source_path,relative_path,updated_at)
      VALUES ('album','artist','fixture',?,?,?,?, 'initial')`).run(coverPath, directory, directory, "album");
    const coverRoute = res => real.routeMedia({ method: "GET" }, res, new URL("http://fixture/media/music-cover/album"));
    const cold = response(); await coverRoute(cold);
    assert.equal(cold.status, 200); assert.equal(imageReads, 1);
    fs.statSync = function (value, ...args) {
      assert.notEqual(path.resolve(String(value)), coverPath, "warm music route must use async source stat");
      return originalSyncStat.call(fs, value, ...args);
    };
    statGate = deferred();
    const warmResponses = Array.from({ length: 32 }, () => response());
    const beforeWarm = metadataStats;
    const warmTasks = warmResponses.map(coverRoute);
    await immediate();
    assert.equal(metadataStats - beforeWarm, 1, "same album metadata must coalesce while its async stat is pending");
    assert.ok(warmResponses.every(res => !res.headersSent));
    statGate.resolve(); statGate = null; await Promise.all(warmTasks);
    assert.ok(warmResponses.every(res => res.status === 200 && res.body.equals(Buffer.from("OLD"))));
    assert.equal(imageReads, 1, "warm route must preserve its persistent cache hit");
    fs.statSync = originalSyncStat;

    statGate = deferred();
    const changedTask = real.store.coverFileAsync("album"); await immediate();
    musicDb.prepare("UPDATE music_albums SET cover_path = ?, updated_at = 'changed' WHERE id = 'album'").run(otherPath);
    statGate.resolve(); statGate = null;
    assert.equal(await changedTask, null, "row/path replacement during metadata stat must discard old source");

    statGate = deferred();
    const oldDbTask = real.store.coverFileAsync("album"); await immediate();
    real.store.invalidate();
    const freshDbTask = real.store.coverFileAsync("album");
    statGate.resolve(); statGate = null;
    assert.equal(await oldDbTask, null, "a reopened music DB object must fence pending metadata");
    assert.ok(await freshDbTask);

    // Even equal size and timestamp cannot relabel a different disk object as
    // a warm hit; use controlled inode/mtime fractions without actual media.
    let identity = diskStat({ ino: 11 }), inodeReads = 0;
    const inodeRuntime = createMusicRuntime({
      dbPath: musicPath, roots: [], mediaResponseService: imageService(memory, {
        statFile: async () => identity,
        readFile: async () => { inodeReads++; return Buffer.from(inodeReads === 1 ? "ONE" : "TWO"); }
      }),
      scanWorkerOptions: { coverStatFile: async () => identity },
      sendJson: (res, status, value) => { res.writeHead(status); res.end(JSON.stringify(value)); },
      notFound: res => { res.writeHead(404); res.end(); }
    });
    try {
      const inodeRoute = res => inodeRuntime.routeMedia({ method: "GET" }, res, new URL("http://fixture/media/music-cover/album"));
      await inodeRoute(response()); identity = diskStat({ ino: 12 });
      const replaced = response(); await inodeRoute(replaced);
      assert.equal(replaced.body.toString(), "TWO"); assert.equal(inodeReads, 2);
      identity = diskStat({ ino: 12, mtimeMs: identity.mtimeMs + 0.25 });
      await inodeRoute(response()); assert.equal(inodeReads, 3, "sub-millisecond source mtime must change the warm key");
    } finally { await inodeRuntime.stop(); }

    lockedCache = imageDatabase(cachePath); locker = new DatabaseSync(cachePath);
    const nativePrepare = lockedCache.prepare.bind(lockedCache);
    let cacheGets = 0, cacheWrites = 0;
    lockedCache.prepare = sql => {
      const statement = nativePrepare(sql);
      if (!sql.includes("fanhao_images.local_image_cache")) return statement;
      return {
        get: (...args) => { assert.equal(nativePrepare("PRAGMA busy_timeout").get().timeout, 0); cacheGets++; return statement.get(...args); },
        run: (...args) => { assert.equal(nativePrepare("PRAGMA busy_timeout").get().timeout, 0); cacheWrites++; return statement.run(...args); }
      };
    };
    lockedCache.exec("PRAGMA busy_timeout = 5000");
    let readFailure = false;
    const locks = imageService(lockedCache, { readFile: async () => {
      if (readFailure) throw Object.assign(new Error("controlled denied image"), { code: "EACCES" });
      return Buffer.from("OLD");
    } });
    const timeout = () => nativePrepare("PRAGMA busy_timeout").get().timeout;
    try {
      const local = id => ({ ...file(id), size: 3 });
      await locks.serveImageAsync(response(), local("unlocked")); assert.equal(timeout(), 5000);
      assert.ok(locks.localImageCacheRow(local("unlocked"))); assert.equal(timeout(), 5000);
      assert.deepEqual(await locks.prewarmLocalImages([local("unlocked")]), { requested: 1, cached: 1, warmed: 0, failed: 0 });
      assert.equal(timeout(), 5000, "cache-ready SELECT must restore its original timeout too");
      readFailure = true; await locks.serveImageAsync(response(), local("unlocked-error")); assert.equal(timeout(), 5000);
      readFailure = false;
      locker.exec("BEGIN IMMEDIATE");
      const fallbackRes = response(); await locks.serveImageAsync(fallbackRes, local("locked-write"));
      assert.equal(fallbackRes.status, 200); assert.equal(timeout(), 5000);
      assert.equal(nativePrepare("SELECT * FROM fanhao_images.local_image_cache WHERE file_id = ?").get("locked-write"), undefined);
      readFailure = true;
      const errorRes = response(); await locks.serveImageAsync(errorRes, local("locked-error"));
      assert.equal(errorRes.status, 500); assert.equal(timeout(), 5000);
      locker.exec("ROLLBACK");
      locker.exec("BEGIN EXCLUSIVE"); readFailure = false;
      const getErrorRes = response(); await locks.serveImageAsync(getErrorRes, local("exclusive-get"));
      assert.equal(getErrorRes.status, 200, "locked cache SELECT must immediately fall back to source");
      assert.equal(timeout(), 5000); locker.exec("ROLLBACK");
      assert.ok(cacheGets > 0 && cacheWrites >= 4, "gate must cover get, success set, error set and locked failures");
    } finally { try { locker.exec("ROLLBACK"); } catch {} await locks.stop(); }
  } finally {
    fs.statSync = originalSyncStat; statGate?.resolve();
    await real.stop(); await images.stop(); musicDb?.close(); locker?.close(); lockedCache?.close(); memory.close();
    // A fixed flat fixture root: never recurse, inspect before removing files.
    const allowed = new Set(["music.sqlite", "music.sqlite-wal", "music.sqlite-shm", "cover.jpg", "other.jpg", "cache.sqlite", "cache.sqlite-wal", "cache.sqlite-shm", "music.sqlite-journal", "cache.sqlite-journal"]);
    for (const name of fs.readdirSync(directory)) { assert.ok(allowed.has(name), `unexpected fixture file ${name}`); assert.ok(fs.lstatSync(path.join(directory, name)).isFile()); fs.unlinkSync(path.join(directory, name)); }
    fs.rmdirSync(directory);
  }
}

function file(id) {
  return { id, path: id, relativePath: id, type: "image", ext: ".jpg", size: bytes.length, modifiedAt };
}
function route(res, id) {
  return runtime.routeMedia({ method: "GET" }, res, new URL(`http://fixture/media/music-cover/${id}`));
}
function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}
function immediate() {
  return new Promise((resolve) => setImmediate(resolve));
}
function response() {
  const res = new EventEmitter();
  Object.assign(res, { destroyed: false, writableEnded: false, headersSent: false });
  res.writeHead = (status, headers = {}) => {
    assert.equal(res.destroyed, false);
    res.status = status;
    res.headers = headers;
    res.headersSent = true;
  };
  res.end = (body = "") => {
    assert.equal(res.destroyed, false);
    res.body = Buffer.isBuffer(body) ? body : Buffer.from(body);
    res.writableEnded = true;
  };
  res.destroy = () => { res.destroyed = true; res.emit("close"); };
  return res;
}
