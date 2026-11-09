import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import fs from "node:fs";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Worker } from "node:worker_threads";
import { createDiskUsageRoutes } from "../src/modules/fanhao/server/disk-usage/routes.js";
import { createDiskUsageStore } from "../src/modules/fanhao/server/disk-usage/store.js";
import { createFileServer } from "../src/platform/server/file-server.js";
import { notFound, sendJson } from "../src/platform/server/responses.js";
import { createStaticFileServer } from "../src/platform/server/static-files.js";
import { createVideoProbeService } from "../src/platform/server/video-probe-service.js";

const fixture = createFixture();
let store;
try {
  const driveId = path.parse(fixture.root).root.slice(0, 1).toUpperCase();
  const outputPath = path.join(fixture.cacheDir, `${driveId.toLowerCase()}-fixture.sqlite`);
  const result = await scanFixture(fixture.root, outputPath, fixture.allowedLinkedRoots);
  assert.equal(result.files, 6);
  assert.equal(result.directories, 4);
  assert.equal(result.bytes, 460);

  const database = new DatabaseSync(outputPath, { readOnly: true });
  try {
    const rootRow = database.prepare("SELECT * FROM nodes WHERE path = ?").get(fixture.root);
    assert.equal(rootRow.size_bytes, 460);
    assert.equal(rootRow.file_count, 6);
    assert.equal(rootRow.directory_count, 4);
  } finally {
    database.close();
  }

  fs.writeFileSync(path.join(fixture.cacheDir, `${driveId.toLowerCase()}.json`), JSON.stringify({
    bytes: result.bytes,
    completedAt: result.completedAt,
    databaseFile: path.basename(outputPath),
    directories: result.directories,
    driveId,
    errors: result.errors,
    files: result.files,
    linkedRoots: fixture.allowedLinkedRoots,
    nodes: result.nodes,
    root: fixture.root,
    scanId: "fixture",
    schemaVersion: 1,
    skipped: result.skipped,
    startedAt: result.startedAt
  }), "utf8");

  const storeOptions = {
    cacheDir: fixture.cacheDir,
    excludedNames: ["$RECYCLE.BIN"],
    sources: [{ path: fixture.root, label: "测试资料" }, { path: fixture.allowedLinkedRoots[0], label: "链接资料" }]
  };
  store = createDiskUsageStore(storeOptions);
  store.start();
  const summary = store.summary();
  assert.equal(summary.cacheOnly, true);
  assert.equal(summary.drives.length, 1);
  assert.equal(summary.drives[0].cache.scanId, "fixture");
  assert.equal(summary.drives[0].cacheNeedsRefresh, false);
  assert.deepEqual(summary.drives[0].monitoredLinks, fixture.allowedLinkedRoots);
  assert.equal(summary.drives[0].task, null, "opening the store must not start a scan");

  const tree = store.tree(driveId, fixture.root, 100, 7);
  assert.equal(tree.node.size, 460);
  assert.deepEqual(tree.children.map((item) => item.name), ["Videos", "Linked", "Images", "readme.txt"]);
  assert.deepEqual(tree.children[0].treemapChildren.map((item) => item.name), ["large.mp4", "small.mp4", "Series"]);
  assert.deepEqual(tree.children[0].treemapChildren[2].treemapChildren.map((item) => item.name), ["episode.mp4"]);
  assert.deepEqual(tree.children[1].treemapChildren.map((item) => item.name), ["linked.mp4"]);
  const nested = store.tree(driveId, path.join(fixture.root, "Videos"), 100);
  assert.deepEqual(nested.children.map((item) => item.name), ["large.mp4", "small.mp4", "Series"]);
  const search = store.search(driveId, "large", 20);
  assert.equal(search.items.length, 1);
  assert.equal(search.items[0].size, 200);
  assert.throws(() => store.cachedNode(driveId, "Z:\\outside.txt"), /不在所选监控磁盘|未知的监控磁盘/);
  await verifyPlayInfo(store, driveId, fixture.root);
  await verifyDirectMedia(store, driveId, fixture.root);
  await store.stop();
  await verifyPointReader(storeOptions, driveId, outputPath);

  const staticServer = createStaticFileServer({
    publicDir: path.resolve("public"),
    mimeTypes: { ".html": "text/html" },
    normalizeExt: (value) => path.extname(value).toLowerCase(),
    notFound: () => {}
  });
  assert.equal(staticServer.publicFilePath("/disk-usage"), path.resolve("public/modules/fanhao/disk-usage/index.html"));
  console.log("disk-usage: ok");
} finally {
  try { await store?.stop(); }
  finally { fixture.cleanup(); }
}

async function verifyPlayInfo(store, driveId, root) {
  const videoPath = path.join(root, "Videos", "small.mp4");
  const videoExtensions = new Set([".mp4"]);
  let heldStat, syncStats = 0, probes = 0;
  const videoProbeService = createVideoProbeService({
    ffprobePath: "fixture-only", hasNvenc: false, directVideoExts: videoExtensions, probeWaitMs: 0,
    safeStat: () => assert.fail("playinfo probe must not use a synchronous source stat"),
    statFile(filePath) {
      assert.equal(filePath, videoPath);
      if (!heldStat) return fs.promises.stat(filePath);
      heldStat.started.resolve();
      return heldStat.result.promise;
    },
    execFileFn(_exe, args, _options, callback) {
      assert.equal(args.at(-1), videoPath);
      probes++;
      queueMicrotask(() => callback(null, '{"streams":[{"codec_type":"video","codec_name":"h264"}]}'));
    }
  });
  const routes = createDiskUsageRoutes({
    store, videoProbeService, videoExtensions, normalizeExt: path.extname,
    safeStat(filePath) { syncStats++; return fs.statSync(filePath); },
    sendJson(res, status, payload) { res.json = { status, payload }; }
  });
  function get(route = "playinfo", requestedPath = videoPath) {
    const req = Object.assign(new EventEmitter(), { method: "GET" });
    const res = new EventEmitter();
    const params = new URLSearchParams({ drive: driveId, path: requestedPath });
    const done = routes.routeApi(req, res, new URL(`http://fixture/api/disk-usage/${route}?${params}`)).then(handled => {
      assert.equal(handled, true);
      assert.equal(req.listenerCount("aborted"), 0);
      assert.equal(res.listenerCount("close"), 0);
      return res.json;
    });
    return { req, res, done };
  }
  const invalid = { status: 400, payload: { error: "该缓存项目不是可播放的视频" } };
  try {
    const mediaUrl = `/api/disk-usage/media?${new URLSearchParams({ drive: driveId, path: videoPath })}`;
    assert.deepEqual(await get().done, { status: 200, payload: {
      mode: "direct", label: "原生直连", streamUrl: mediaUrl, fallbackStreamUrl: `${mediaUrl}&mode=transcode&audio=aac`,
      duration: null, videoCodec: "h264", audioCodec: "", width: null, height: null, hasNvenc: false, probePending: false
    } });
    assert.deepEqual(await get("playinfo", path.join(root, "readme.txt")).done, invalid);
    assert.equal((await get("playinfo", path.join(root, "uncached.mp4")).done).status, 404);
    for (const event of ["aborted", "close"]) {
      heldStat = { started: Promise.withResolvers(), result: Promise.withResolvers() };
      const { req, res, done } = get();
      await heldStat.started.promise;
      (event === "aborted" ? req : res).emit(event);
      assert.equal(await done, undefined);
      heldStat.result.resolve(await fs.promises.stat(videoPath));
      heldStat = null;
    }
    fs.rmSync(videoPath);
    assert.deepEqual(await get().done, invalid, "a warmed probe cannot hide a removed source");
    fs.mkdirSync(videoPath);
    assert.deepEqual(await get().done, invalid, "an indexed video that became a directory cannot play");
    fs.rmdirSync(videoPath);
    fs.writeFileSync(videoPath, Buffer.alloc(125));
    assert.equal(syncStats, 0, "playinfo does not synchronously stat the source disk");
    assert.equal(probes, 1, "canceled, invalid and unindexed sources do not start probes");
    assert.equal((await get("item").done).payload.work.videoSize, 125, "item still uses live size rather than scan size");
    await videoProbeService.stop();
    assert.equal((await get().done).status, 503, "unavailable validation remains retryable");
  } finally {
    heldStat?.result.resolve(null);
    await videoProbeService.stop();
  }
}

async function verifyDirectMedia(store, driveId, root) {
  const videoPath = path.join(root, "Videos", "large.mp4");
  const bytes = Buffer.from("abcdefghij");
  fs.writeFileSync(videoPath, bytes);
  fs.utimesSync(videoPath, 1_700_000_000.123789, 1_700_000_000.123789);
  const { mtimeMs } = fs.statSync(videoPath);
  const etag = `W/"${bytes.length.toString(16)}-${Math.round(mtimeMs * 1000).toString(16)}"`;
  const lastModified = new Date(mtimeMs).toUTCString();
  const normalizeExt = name => path.extname(name).toLowerCase();
  const files = createFileServer({ defaultChunkBytes: 4, mimeTypes: { ".mp4": "video/mp4" }, normalizeExt, notFound });
  let syncStats = 0;
  const routes = createDiskUsageRoutes({
    store, normalizeExt, notFound, sendJson, serveRangedFile: files.serveRangedFile,
    safeStat(filePath) { syncStats++; return fs.statSync(filePath, { throwIfNoEntry: false }); }
  });
  let routeTask;
  const server = createServer((req, res) => {
    routeTask = routes.routeMedia(req, res, new URL(req.url, "http://fixture"));
    routeTask.catch(error => res.destroy(error));
  });
  try {
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const base = `http://127.0.0.1:${server.address().port}/api/disk-usage/media`;
    async function get(options, filePath = videoPath) {
      const response = await fetch(`${base}?${new URLSearchParams({ drive: driveId, path: filePath })}`, options);
      const body = Buffer.from(await response.arrayBuffer());
      assert.equal(await routeTask, true);
      return { response, body };
    }
    function assertMediaHeaders(response, length) {
      assert.equal(response.headers.get("content-length"), String(length));
      assert.equal(response.headers.get("content-type"), "video/mp4");
      assert.equal(response.headers.get("content-disposition"), "inline");
      assert.equal(response.headers.get("accept-ranges"), "bytes");
      assert.equal(response.headers.get("cache-control"), "private, no-store");
      assert.equal(response.headers.get("etag"), etag);
      assert.equal(response.headers.get("last-modified"), lastModified);
    }
    const full = await get();
    assert.equal(full.response.status, 200);
    assertMediaHeaders(full.response, bytes.length);
    assert.deepEqual(full.body, bytes);
    const range = await get({ headers: { range: "bytes=2-9" } });
    assert.equal(range.response.status, 206);
    assertMediaHeaders(range.response, 4);
    assert.equal(range.response.headers.get("content-range"), "bytes 2-5/10");
    assert.deepEqual(range.body, bytes.subarray(2, 6));
    const head = await get({ method: "HEAD", headers: { range: "bytes=2-9" } });
    assert.equal(head.response.status, 200);
    assertMediaHeaders(head.response, bytes.length);
    assert.equal(head.body.length, 0);
    const invalid = await get({ headers: { range: "bytes=99-" } });
    assert.equal(invalid.response.status, 416);
    assertMediaHeaders(invalid.response, 0);
    assert.equal(invalid.response.headers.get("content-range"), "bytes */10");
    const unchanged = await get({ headers: { "if-none-match": etag } });
    assert.equal(unchanged.response.status, 304);
    assert.equal(unchanged.response.headers.get("etag"), etag);
    assert.equal(unchanged.body.length, 0);
    const uncached = await get({}, path.join(root, "uncached.mp4"));
    assert.equal(uncached.response.status, 404);
    assert.deepEqual(JSON.parse(uncached.body), { error: "缓存中没有这个路径，请手动刷新磁盘缓存" });
    fs.rmSync(videoPath);
    const missing = await get();
    assert.equal(missing.response.status, 404);
    assert.deepEqual(JSON.parse(missing.body), { error: "Not found" });
    fs.mkdirSync(videoPath);
    const directory = await get();
    assert.equal(directory.response.status, 404);
    assert.deepEqual(JSON.parse(directory.body), { error: "Not found" });
    assert.equal(syncStats, 0, "direct media relies on the opened handle for source metadata");
  } finally {
    if (server.listening) await new Promise(resolve => server.close(resolve));
    await files.stop();
  }
}

async function verifyPointReader(options, driveId, outputPath) {
  const store = createDiskUsageStore(options);
  const manifestPath = path.join(options.cacheDir, `${driveId.toLowerCase()}.json`);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const large = path.join(manifest.root, "Videos", "large.mp4");
  const small = path.join(manifest.root, "Videos", "small.mp4");
  const generationPath = name => path.join(options.cacheDir, `${driveId.toLowerCase()}-${name}.sqlite`);
  const select = (databasePath, scanId) => fs.writeFileSync(manifestPath, JSON.stringify({
    ...manifest, databaseFile: path.basename(databasePath), scanId
  }));
  function changeSize(databasePath, size) {
    const writer = new DatabaseSync(databasePath);
    try { writer.prepare("UPDATE nodes SET size_bytes = ? WHERE path = ?").run(size, large); }
    finally { writer.close(); }
  }
  const prepare = DatabaseSync.prototype.prepare;
  const schedule = globalThis.setTimeout;
  const readers = [];
  const idleClosures = [];
  DatabaseSync.prototype.prepare = function(sql, ...args) {
    if (sql === "SELECT * FROM nodes WHERE path = ?") readers.push(this);
    return prepare.call(this, sql, ...args);
  };
  globalThis.setTimeout = function(callback, delay, ...args) {
    const timer = schedule(callback, delay, ...args);
    if (delay === 1500) idleClosures.push({ callback, timer });
    return timer;
  };
  const lookup = (filePath = large) => store.cachedNode(driveId, filePath);
  try {
    assert.equal(lookup().node.size, 200);
    assert.equal(lookup(small).node.size, 100);
    assert.throws(() => lookup(path.join(manifest.root, "uncached.mp4")), { statusCode: 404 });
    assert.equal(readers.length, 1, "warm paths and misses share one point statement");
    const originalReader = readers[0];
    assert.equal(originalReader.isOpen, true);
    assert.equal(idleClosures.length, 1, "warm reads refresh the existing idle timer");
    assert.equal(idleClosures[0].timer.hasRef(), false);

    changeSize(outputPath, 250);
    const changedTime = (fs.statSync(outputPath).mtimeMs + 1500) / 1000;
    fs.utimesSync(outputPath, changedTime, changedTime);
    assert.equal(lookup().node.size, 250, "external committed data remains visible");
    assert.equal(originalReader.isOpen, false, "a changed file identity retires its reader");
    const updatedReader = readers.at(-1);
    idleClosures[0].callback();
    assert.equal(updatedReader.isOpen, true, "a retired idle callback cannot close its successor");

    const nextPath = generationPath("fixture-next");
    fs.copyFileSync(outputPath, nextPath);
    changeSize(nextPath, 300);
    select(nextPath, "fixture-next");
    assert.equal(lookup().node.size, 300);
    assert.equal(updatedReader.isOpen, false, "manifest selection retires the previous file");
    const nextReader = readers.at(-1);
    select(outputPath, "fixture");
    assert.equal(lookup().node.size, 250, "returning to an earlier generation opens it again");
    assert.equal(nextReader.isOpen, false);
    const oldReader = readers.at(-1);
    select(nextPath, "fixture-next");
    store.start();
    assert.equal(oldReader.isOpen, false, "cleanup retires the old reader before removing its snapshot");
    assert.equal(fs.existsSync(outputPath), false);
    assert.equal(lookup().node.size, 300);
    const beforeCorruptManifest = readers.at(-1);
    fs.writeFileSync(manifestPath, "{");
    assert.throws(() => lookup(), { statusCode: 404 });
    assert.equal(beforeCorruptManifest.isOpen, false);
    select(nextPath, "fixture-next");
    assert.equal(lookup().node.size, 300, "the restored manifest can select its snapshot again");
    const selectedReader = readers.at(-1);

    select(generationPath("absent"), "absent");
    assert.throws(() => lookup(), { statusCode: 404, message: "该磁盘还没有缓存，请先手动刷新" });
    assert.equal(selectedReader.isOpen, false);
    const badPath = generationPath("invalid-schema");
    const bad = new DatabaseSync(badPath);
    try { bad.exec("CREATE TABLE unused (value)"); }
    finally { bad.close(); }
    select(badPath, "invalid-schema");
    assert.throws(() => lookup(), { statusCode: 500, message: `无法读取 ${driveId}: 的磁盘缓存` });
    assert.equal(readers.at(-1).isOpen, false, "failed statements retire their database");

    select(nextPath, "fixture-next");
    assert.equal(lookup().node.size, 300);
    const idleReader = readers.at(-1);
    idleClosures.at(-1).callback();
    assert.equal(idleReader.isOpen, false, "an idle reader releases the Windows file handle");
    assert.equal(lookup().node.size, 300, "the active snapshot can be read again after idle close");
    const activeReader = readers.at(-1);
    await store.stop();
    assert.equal(activeReader.isOpen, false);
    assert.throws(() => store.refresh(driveId), { statusCode: 503 });
    assert.equal(lookup().node.size, 300, "already-authorized reads remain available after stop");
    assert.equal(readers.at(-1).isOpen, false, "post-stop reads do not retain another handle");
  } finally {
    globalThis.setTimeout = schedule;
    DatabaseSync.prototype.prepare = prepare;
    await store.stop();
  }
}

function scanFixture(root, outputPath, allowedLinkedRoots = []) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("../src/modules/fanhao/server/disk-usage/scan-worker.js", import.meta.url), {
      workerData: { allowedLinkedRoots, excludedNames: ["$RECYCLE.BIN"], outputPath, root, scanId: "fixture" }
    });
    worker.on("message", (message) => {
      if (message.type === "complete") resolve(message.result);
      if (message.type === "failed") reject(new Error(message.error));
    });
    worker.once("error", reject);
    worker.once("exit", (code) => {
      if (code !== 0) reject(new Error(`scan worker exited ${code}`));
    });
  });
}

function createFixture() {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "fanhao-disk-usage-"));
  const root = path.join(baseDir, "library");
  const linkedTarget = path.join(baseDir, "linked-target");
  const linkedRoot = path.join(root, "Linked");
  const cacheDir = path.join(baseDir, "cache");
  fs.mkdirSync(path.join(root, "Videos"), { recursive: true });
  fs.mkdirSync(path.join(root, "Videos", "Series"), { recursive: true });
  fs.mkdirSync(path.join(root, "Images"), { recursive: true });
  fs.mkdirSync(linkedTarget, { recursive: true });
  fs.symlinkSync(linkedTarget, linkedRoot, "junction");
  fs.mkdirSync(cacheDir, { recursive: true });
  fs.writeFileSync(path.join(root, "Videos", "large.mp4"), Buffer.alloc(200));
  fs.writeFileSync(path.join(root, "Videos", "small.mp4"), Buffer.alloc(100));
  fs.writeFileSync(path.join(root, "Videos", "Series", "episode.mp4"), Buffer.alloc(40));
  fs.writeFileSync(path.join(root, "Images", "cover.jpg"), Buffer.alloc(50));
  fs.writeFileSync(path.join(root, "readme.txt"), Buffer.alloc(10));
  fs.writeFileSync(path.join(linkedTarget, "linked.mp4"), Buffer.alloc(60));
  const canonicalBase = fs.realpathSync.native(baseDir);
  return {
    baseDir,
    allowedLinkedRoots: [linkedRoot],
    cacheDir,
    root,
    cleanup() {
      const resolved = fs.realpathSync.native(baseDir);
      const tempRoot = fs.realpathSync.native(os.tmpdir());
      if (resolved !== canonicalBase || !resolved.startsWith(`${tempRoot}${path.sep}`) || !path.basename(resolved).startsWith("fanhao-disk-usage-")) {
        throw new Error("refusing to clean an unexpected disk-usage fixture path");
      }
      fs.rmSync(resolved, { recursive: true, force: false });
    }
  };
}
