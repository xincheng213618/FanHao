import assert from "node:assert/strict";
import path from "node:path";
import http from "node:http";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { DatabaseSync } from "node:sqlite";
import { createGalleryMediaService } from "../src/modules/media/server/gallery-media-service.js";
import { createMediaRuntime } from "../src/modules/media/server/runtime.js";

// Synthetic stats, in-memory SQLite, owned Node children and random-loopback
// HTTP only. Never opens actual media, FFmpeg, credentials or an app service.
const jpeg = Buffer.from([255, 216, 255, 217]);
const unhandled = [];
const onUnhandled = (error) => unhandled.push(error);
process.on("unhandledRejection", onUnhandled);
try {
  await realRoutes(); await queueLifecycle(); await identities(); await failures();
  await immediate(); assert.deepEqual(unhandled, []);
  console.log("gallery-cover-async: ok (route/health, async probe/frame, seek/scale/q, coalescing, bounds, warm/error cache, source/cache/DB identity, disconnect, timeout/overflow/JPEG, held-close stop and stale start)");
} finally { process.off("unhandledRejection", onUnhandled); }

function database() {
  const native = new DatabaseSync(":memory:");
  native.exec(`CREATE TABLE gallery_media_covers (media_id TEXT PRIMARY KEY, source_path TEXT, source_size INTEGER, source_mtime_ms INTEGER, cover_mime TEXT, cover_blob BLOB, cover_bytes INTEGER, generator_version INTEGER, status TEXT, error TEXT, generated_at TEXT, updated_at TEXT)`);
  const result = { native, writes: 0, prepare(sql) {
    const statement = native.prepare(sql);
    return { get: (...args) => statement.get(...args), run: (...args) => {
      const value = statement.run(...args); if (sql.includes("INSERT INTO gallery_media_covers")) result.writes += 1; return value;
    } };
  } };
  return result;
}
function environment(extra = {}) {
  const env = { database: database(), databases: [], statGate: null,
    items: Array.from({ length: 6 }, (_, i) => ({ id: String(i + 1), sourceRoot: path.resolve("controlled-gallery"), relativePath: `video-${i + 1}.mp4`, type: "video", size: 4, updatedAt: "fixture" })) };
  env.databases.push(env.database);
  env.disk = new Map(env.items.map((item) => [path.join(item.sourceRoot, item.relativePath), { size: 4, mtimeMs: 1234.5, dev: 1, ino: Number(item.id) }]));
  env.service = createGalleryMediaService({ coverBoxSize: 320, coverGeneratorVersion: 2, coverMaxBytes: 4096,
    directVideoExts: new Set([".mp4"]), ffmpegPath: "controlled-ffmpeg", ffprobePath: "controlled-ffprobe",
    getImageGalleryDb: () => env.database, getImageLibraryIndex: () => ({ mediaItems: env.items }),
    normalizeExt: () => ".mp4", notFound: (res) => { res.writeHead(404); res.end(); },
    playbackProgressService: { getVideoProgress: () => null }, publicGalleryMediaItem: (item) => item,
    safeChildPath: (root, relative) => path.join(root, relative), safeStat: () => assert.fail("cover uses async stat"),
    statFile: async (filePath) => { if (env.statGate) await env.statGate.promise; const value = env.disk.get(filePath);
      if (!value) throw Object.assign(new Error("missing"), { code: "ENOENT" }); return { ...value, isFile: () => true }; }, ...extra });
  env.runtime = createMediaRuntime({ galleryMediaService: env.service });
  env.close = async () => { await env.runtime.stop(); for (const db of env.databases) db.native.close(); };
  return env;
}
function response() {
  return Object.assign(new EventEmitter(), { headersSent: false, destroyed: false, writableEnded: false,
    writeHead(status, headers = {}) { assert.equal(this.destroyed, false); this.status = status; this.headers = headers; this.headersSent = true; },
    end(body) { assert.equal(this.destroyed, false); this.body = body; this.writableEnded = true; },
    destroy() { this.destroyed = true; this.emit("close"); } });
}
function request() { return Object.assign(new EventEmitter(), { method: "GET" }); }
async function route(env, id, res = response(), req = request()) {
  assert.equal(await env.runtime.routeMedia(req, res, new URL(`http://fixture/media/gallery-media-cover/${id}`)), true); return res;
}
function children({ held = false, frameDelay = 120, mode = "ok", probeMode = "ok" } = {}) {
  const records = [];
  const spawnFn = (command, args, options) => {
    const probe = command === "controlled-ffprobe";
    let child;
    if (held) { child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); }
    else {
      const selected = probe ? probeMode : mode;
      const delay = probe ? 20 : frameDelay;
      const payload = probe ? Buffer.from(JSON.stringify({ format: { duration: 100 } })) : selected === "invalid" ? Buffer.from([1, 2, 3]) : selected === "overflow" ? Buffer.alloc(4097) : jpeg;
      const script = selected === "hang" ? "setInterval(()=>{},1000)" : selected === "failure" ? `setTimeout(()=>{process.stderr.write('controlled failure');process.exit(1)},${delay})` : `setTimeout(()=>process.stdout.write(Buffer.from('${payload.toString("base64")}','base64')),${delay})`;
      child = spawn(process.execPath, ["-e", script], options);
    }
    const record = { child, probe, args, command, closed: false, killed: false }; records.push(record);
    const kill = held ? () => true : child.kill.bind(child);
    child.kill = (signal) => { record.killed = true; return kill(signal); };
    child.once("close", () => { record.closed = true; });
    record.close = (bytes = jpeg, code = 0) => { if (record.closed) return; child.stdout.end(bytes); child.stderr.end(); child.emit("close", code); };
    return child;
  };
  return { records, spawnFn, closeAll() { for (const item of records) item.close(); }, assertClosed() { assert.ok(records.every((item) => item.closed)); } };
}
async function realRoutes() {
  const owned = children({ frameDelay: 300 }); const env = environment({ spawnFn: owned.spawnFn });
  const server = http.createServer(async (req, res) => {
    if (req.url === "/health") { res.end("healthy"); return; }
    try { if (!await env.runtime.routeMedia(req, res, new URL(req.url, "http://fixture"))) { res.writeHead(404); res.end(); } }
    catch (error) { if (!res.destroyed && !res.writableEnded) { res.writeHead(500); res.end(error.message); } }
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await env.runtime.start();
    const duplicates = [fetch(`${base}/media/gallery-media-cover/1`), fetch(`${base}/media/gallery-media-cover/1`)];
    await waitFor(() => owned.records.some((item) => !item.probe));
    const started = performance.now(); assert.equal(await (await fetch(`${base}/health`)).text(), "healthy");
    assert.equal(owned.records.find((item) => !item.probe).closed, false);
    console.log(`gallery-cover async: health=${Math.round(performance.now() - started)}ms during pending frame`);
    for (const pending of duplicates) { const res = await pending; assert.equal(res.status, 200); assert.ok(Buffer.from(await res.arrayBuffer()).equals(jpeg));
      assert.equal(res.headers.get("content-type"), "image/jpeg"); assert.equal(res.headers.get("cache-control"), "public, max-age=86400"); assert.equal(res.headers.get("content-disposition"), "inline"); }
    assert.equal(owned.records.length, 2); assert.equal(env.database.writes, 1);
    const frame = owned.records.find((item) => !item.probe);
    for (const [flag, value] of [["-ss", "8"], ["-vf", "scale=320:-2"], ["-q:v", "5"]]) assert.equal(frame.args[frame.args.indexOf(flag) + 1], value);
    assert.equal((await fetch(`${base}/media/gallery-media-cover/1`)).status, 200); assert.equal(owned.records.length, 2);
    assert.equal((await fetch(`${base}/media/gallery-media-cover/missing`)).status, 404);
    const disconnected = http.get(`${base}/media/gallery-media-cover/2`); disconnected.on("error", () => {});
    const survivor = fetch(`${base}/media/gallery-media-cover/2`);
    await waitFor(() => owned.records.filter((item) => !item.probe).length === 2); disconnected.destroy();
    assert.equal((await survivor).status, 200); assert.equal(owned.records.findLast((item) => !item.probe).killed, false);
    const alone = http.get(`${base}/media/gallery-media-cover/3`); alone.on("error", () => {});
    await waitFor(() => owned.records.filter((item) => !item.probe).length === 3); alone.destroy();
    await waitFor(() => owned.records.findLast((item) => !item.probe).closed);
    assert.equal(owned.records.findLast((item) => !item.probe).killed, true);
    assert.equal(env.database.native.prepare("SELECT * FROM gallery_media_covers WHERE media_id='3'").get(), undefined);
  } finally { await env.close(); owned.assertClosed(); server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
}
async function queueLifecycle() {
  const owned = children({ held: true }); const env = environment({ spawnFn: owned.spawnFn, probeDuration: async () => 100, generationConcurrency: 2, generationCapacity: 4 });
  const responses = Array.from({ length: 5 }, response); const pending = responses.map((res, i) => route(env, String(i + 1), res));
  try {
    await waitFor(() => owned.records.length === 2 && responses[4].writableEnded);
    assert.equal(env.service.diagnostics().tasks, 4); assert.equal(responses[4].status, 404); assert.equal(env.database.writes, 0);
    owned.records[0].child.emit("error", new Error("controlled stream failure")); await immediate();
    assert.equal(owned.records[0].killed, true); assert.equal(owned.records.length, 2, "error without close retains slot");
    let stopped = false; const stop = env.runtime.stop().then(() => { stopped = true; });
    const stale = assert.rejects(env.runtime.start(), { statusCode: 503 }); env.runtime.beginStop();
    await immediate(); assert.equal(stopped, false); assert.equal((await route(env, "1")).status, 503);
    owned.closeAll(); await stop; await stale; await Promise.all(pending);
    assert.equal(owned.records.length, 2); assert.equal(env.database.writes, 0);
    await env.runtime.start(); const restarted = route(env, "1"); await waitFor(() => owned.records.length === 3);
    owned.records[2].close(); assert.equal((await restarted).status, 200);
  } finally { owned.closeAll(); await Promise.allSettled(pending); await env.close(); }
}
async function identities() {
  for (const kind of ["disk", "disk-error", "path", "index", "cache", "cache-blob", "database", "last-stat-index"]) {
    const owned = children({ held: true }); const env = environment({ spawnFn: owned.spawnFn, probeDuration: async () => 100 });
    if (kind === "cache-blob") env.database.native.prepare("INSERT INTO gallery_media_covers (media_id,source_path,source_size,source_mtime_ms,generator_version,status,cover_blob,cover_bytes,updated_at) VALUES ('1',?,4,1234,1,'ok',?,4,'unchanged')").run(path.join(env.items[0].sourceRoot, env.items[0].relativePath), jpeg);
    const res = response(); const pending = route(env, "1", res);
    try {
      await waitFor(() => owned.records.length === 1); const old = env.database;
      if (kind === "disk" || kind === "disk-error") env.disk.get(path.join(env.items[0].sourceRoot, env.items[0].relativePath)).ino += 100;
      if (kind === "path") env.items[0].relativePath = "replacement.mp4";
      if (kind === "index") env.items = env.items.filter((item) => item.id !== "1");
      if (kind === "cache") old.native.prepare("INSERT INTO gallery_media_covers (media_id,source_path,source_size,source_mtime_ms,generator_version,status,cover_blob,cover_bytes,updated_at) VALUES ('1',?,4,1234,3,'ok',?,4,'manual')").run(path.join(env.items[0].sourceRoot, env.items[0].relativePath), jpeg);
      if (kind === "cache-blob") old.native.prepare("UPDATE gallery_media_covers SET cover_blob=? WHERE media_id='1'").run(Buffer.from([255,216,0,1]));
      if (kind === "database") { env.database = database(); env.databases.push(env.database); }
      if (kind === "last-stat-index") env.statGate = deferred();
      owned.records[0].close(jpeg, kind === "disk-error" ? 1 : 0);
      if (kind === "last-stat-index") { await immediate(); env.items = env.items.filter((item) => item.id !== "1"); env.statGate.resolve(); }
      await pending; assert.equal(res.status, 404, kind); assert.equal(old.writes, 0); assert.equal(env.database.writes, 0);
      if (kind === "cache") assert.equal(old.native.prepare("SELECT updated_at FROM gallery_media_covers WHERE media_id='1'").get().updated_at, "manual");
      if (kind === "cache-blob") assert.ok(Buffer.from(old.native.prepare("SELECT cover_blob FROM gallery_media_covers WHERE media_id='1'").get().cover_blob).equals(Buffer.from([255,216,0,1])));
    } finally { env.statGate?.resolve(); owned.closeAll(); await pending; await env.close(); }
  }
}
async function failures() {
  for (const mode of ["failure", "invalid", "overflow", "hang"]) {
    const owned = children({ mode, frameDelay: 5 }); const env = environment({ spawnFn: owned.spawnFn, timeoutMs: mode === "hang" ? 25 : 1000 });
    try {
      assert.equal((await route(env, "1")).status, 404, mode);
      assert.equal(env.database.native.prepare("SELECT status FROM gallery_media_covers WHERE media_id='1'").get().status, "error");
      const count = owned.records.length; assert.equal((await route(env, "1")).status, 404); assert.equal(owned.records.length, count);
      if (mode === "overflow" || mode === "hang") assert.equal(owned.records.find((item) => !item.probe).killed, true);
    } finally { await env.close(); owned.assertClosed(); }
  }
  const owned = children({ probeMode: "hang", frameDelay: 5 }); const fallback = environment({ spawnFn: owned.spawnFn, probeTimeoutMs: 25 });
  try { assert.equal((await route(fallback, "1")).status, 200); assert.equal(owned.records[0].killed, true); assert.equal(owned.records[0].closed, true);
    assert.equal(owned.records[1].args[owned.records[1].args.indexOf("-ss") + 1], "8"); }
  finally { await fallback.close(); owned.assertClosed(); }
  const held = children({ held: true }); const aborted = environment({ spawnFn: held.spawnFn });
  const res = response(), req = request(), pending = route(aborted, "1", res, req);
  try {
    await waitFor(() => held.records.length === 1); assert.equal(held.records[0].command, "controlled-ffprobe");
    req.emit("aborted"); res.destroy(); await immediate(); assert.equal(held.records[0].killed, true);
    let done = false; const stopping = aborted.runtime.stop().then(() => { done = true; }); await immediate(); assert.equal(done, false);
    held.closeAll(); await stopping; await pending; assert.equal(held.records.length, 1); assert.equal(aborted.database.writes, 0);
  } finally { held.closeAll(); await pending; await aborted.close(); }
}
function deferred() { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; }
function immediate() { return new Promise((resolve) => setImmediate(resolve)); }
async function waitFor(test) { for (let i = 0; !test(); i += 1) { assert.ok(i < 300, "fixture phase timed out"); await new Promise((resolve) => setTimeout(resolve, 5)); } }
