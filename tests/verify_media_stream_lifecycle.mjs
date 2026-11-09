import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import { spawn } from "node:child_process";
import { EventEmitter, once } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { createFileServer } from "../src/platform/server/file-server.js";
import { createRequestHandler } from "../src/platform/server/http-app.js";
import { createMediaStreamService } from "../src/platform/server/media-stream-service.js";
import { createServerHost } from "../src/platform/server/server-host.js";
import { createDiskUsageRoutes } from "../src/modules/fanhao/server/disk-usage/routes.js";
import { createWorkDetailService } from "../src/modules/fanhao/server/works/work-detail-service.js";
import { routeWorksApi } from "../src/modules/fanhao/server/works/routes-api.js";
import { createGalleryMediaService } from "../src/modules/media/server/gallery-media-service.js";
import { createMediaRuntime } from "../src/modules/media/server/runtime.js";

// No media, FFmpeg, database, or application service is opened. Real children
// below are private Node processes; private HTTP servers bind loopback port 0.
const fixtures = [];
const actualChildren = new Set();
const servers = new Set();
let scenarios = 0;
const tick = () => new Promise((resolve) => setImmediate(resolve));
const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function until(predicate, message, timeout = 2000) {
  const end = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() > end) assert.fail(message);
    await delay(2);
  }
}

class CaptureResponse extends Writable {
  constructor({ slow = false } = {}) {
    super({ highWaterMark: slow ? 1 : 16384 });
    this.status = 0;
    this.headersSent = false;
    this.responseHeaders = {};
    this.chunks = [];
    this.callbacks = [];
    this.slow = slow;
    this.errors = [];
    this.on("error", (error) => this.errors.push(error));
  }
  setHeader(name, value) { this.responseHeaders[name] = value; }
  writeHead(status, headers = {}) { this.status = status; this.headersSent = true; Object.assign(this.responseHeaders, headers); }
  _write(chunk, _encoding, callback) {
    this.chunks.push(Buffer.from(chunk));
    if (this.slow) this.callbacks.push(callback); else callback();
  }
  release() { for (const callback of this.callbacks.splice(0)) callback(); }
  get body() { return Buffer.concat(this.chunks).toString(); }
}

function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new PassThrough({ highWaterMark: 16 });
  child.stderr = new PassThrough();
  child.exitCode = null;
  child.signalCode = null;
  child.killed = false;
  child.actualClosed = false;
  child.killCalls = [];
  child.kill = (signal) => { child.killCalls.push(signal); child.killed = true; return true; };
  return child;
}

async function closeFake(child, code = 0, signal = null) {
  if (child.actualClosed) return;
  child.stdout.end();
  child.stderr.end();
  await tick();
  child.actualClosed = true;
  child.exitCode = code;
  child.signalCode = signal;
  child.emit("close", code, signal);
  await tick();
}

function fixture(options = {}) {
  const { statFile = () => ({ isFile: () => true }), ...overrides } = options;
  const children = [], responses = [], requests = [], warnings = [], args = [];
  let statCalls = 0;
  const service = createMediaStreamService({
    ffmpegPath: "ffmpeg-fixture-never-executed", hasNvenc: true,
    statFile: (filePath) => { statCalls++; return statFile(filePath); },
    notFound: () => assert.fail("synthetic source exists"),
    sendJson(res, status, payload) { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(payload)); },
    serveRangedFile: () => {},
    warn: (_tag, message) => warnings.push(message),
    spawnProcess(command, commandArgs, config) {
      assert.equal(command, "ffmpeg-fixture-never-executed");
      assert.deepEqual(config, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
      args.push(commandArgs);
      const child = fakeChild(); children.push(child); return child;
    },
    startupTimeoutMs: 1000, childCloseTimeoutMs: 100, queueTimeoutMs: 1000,
    ...overrides
  });
  const context = { service, children, responses, requests, warnings, args, get statCalls() { return statCalls; }, async child(index = 0) {
    await until(() => children.length > index, `child ${index} starts after source stat`);
    return children[index];
  }, request({ method = "GET", query = "", slow = false, filePath = "synthetic-source.mp4", resolveMissingSource, req = new EventEmitter(), res = new CaptureResponse({ slow }) } = {}) {
    req.method = method; requests.push(req); responses.push(res);
    service.serveTranscodedVideo(req, res, { path: filePath }, new URL(`http://fixture/transcode${query}`), { resolveMissingSource });
    return { req, res };
  } };
  fixtures.push(context);
  return context;
}

async function scenario(name, run) { await run(); scenarios++; console.log(`media-stream: ${name}`); }

function privateChild(script) {
  const child = spawn(process.execPath, ["-e", script], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  actualChildren.add(child);
  child.actualClosed = false;
  child.closed = new Promise((resolve) => child.once("close", (code, signal) => { child.actualClosed = true; resolve({ code, signal }); }));
  return child;
}

async function listenPrivate(server) {
  servers.add(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return `http://127.0.0.1:${server.address().port}`;
}

async function closeServer(server) {
  if (server.listening) await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  servers.delete(server);
}

async function verifyInfoPreview() {
  const entries = new Map(), handles = [], library = { filesById: new Map() };
  const open = fs.promises.open;
  const closeResponse = (res, status) => { res.writeHead(status, { "Content-Length": 0 }); res.end(); };
  const notFound = res => closeResponse(res, 404);
  const sendJson = (res, status, body) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(body)); };
  const files = createFileServer({ mimeTypes: {}, normalizeExt: () => ".txt", notFound, stopTimeoutMs: 1000 });
  const mediaStreamService = createMediaStreamService({
    maxInfoBytes: 32,
    decodeInfoBuffer: buffer => buffer.toString("utf8"),
    isSubtitleLikeInfoText: text => text === "subtitle",
    parseInfoMetadata: (text, options) => ({ text, ...options }),
    sendJson, notFound, serveFilePreview: files.serveFilePreview
  });
  const workDetailService = createWorkDetailService({ library, mediaStreamService });
  function add(id, text, options = {}) {
    const file = { id, path: `synthetic-info:${id}`, name: `${id}.txt`, ext: ".txt", relativePath: `fixture/${id}.txt`, type: "info", size: text.length };
    const entry = { file, bytes: Buffer.from(text), ...options };
    library.filesById.set(id, file); entries.set(file.path, entry);
    return entry;
  }
  const delayedReads = [];
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  fs.promises.open = async (target, ...args) => {
    const entry = entries.get(target);
    if (!entry) return open(target, ...args);
    const record = { target, reads: 0, bytes: 0, closed: 0 };
    handles.push(record);
    return {
      async stat() { return { size: entry.statSize ?? entry.bytes.length, isFile: () => true }; },
      async read(buffer, offset, length, position) {
        record.reads++;
        entry.onRead?.();
        if (entry.held && record.reads === 1) { delayedReads.push(record); await gate; }
        const bytesRead = entry.bytes.copy(buffer, offset, position, position + Math.min(3, length));
        record.bytes += bytesRead;
        return { bytesRead };
      },
      async close() { record.closed++; }
    };
  };
  const server = http.createServer(createRequestHandler({
    attachAccessAnalytics() {}, attachAccessLogger() {}, requestCorsOrigin: () => "", requestAuthState: () => ({ allowed: true }),
    routeAuth: () => false, routeMedia: () => false, serveStatic: (_req, res) => notFound(res), sendJson,
    logError(_tag, error) { assert.equal(error.statusCode, 409); },
    async routeApi(req, res, url) {
      if (url.pathname === "/api/health") { sendJson(res, 200, { ok: true }); return true; }
      return routeWorksApi(req, res, url, { sendJson, notFound, workDetailService });
    }
  }));
  const controllers = [], pending = [];
  try {
    add("normal", "example text");
    add("caption", "subtitle");
    add("grown", "x".repeat(96), { statSize: 5 });
    add("short", "123", { statSize: 5 });
    add("oversized", "x".repeat(33));
    // Retarget the existing index key during the asynchronous read.
    add("remapped", "old", { onRead: () => {
      library.filesById.set("remapped", { type: "info", path: "synthetic-info:new-source" });
    } });
    add("held", "held payload", { held: true });
    const address = await listenPrivate(server);
    const request = (id, options) => fetch(`${address}/api/info/${id}`, options);
    const normal = await request("normal");
    assert.equal(normal.status, 200);
    assert.deepEqual(await normal.json(), { id: "normal", name: "normal.txt", ext: ".txt", size: 12, relativePath: "fixture/normal.txt", content: "example text",
      metadata: { text: "example text", title: "", fileName: "normal.txt", directoryName: "fixture" } });
    assert.equal((await (await request("caption")).json()).metadata, null);
    for (const id of ["grown", "short"]) assert.equal((await request(id)).status, 409);
    assert.equal(handles.find(handle => handle.target === "synthetic-info:grown").bytes, 6, "growth is detected without reading the unbounded tail");
    const oversized = await request("oversized");
    assert.equal(oversized.status, 413); assert.equal((await oversized.json()).size, 33);
    assert.equal(handles.find(handle => handle.target === "synthetic-info:oversized").reads, 0);
    assert.equal((await request("remapped")).status, 404);
    assert.equal((await request("missing")).status, 404);
    await until(() => files.diagnostics().active === 0, "finished previews release their descriptors");

    for (let index = 0; index < 8; index++) {
      const controller = new AbortController(); controllers.push(controller);
      pending.push(request("held", { signal: controller.signal }).then(response => response.status, error => error.name));
    }
    await until(() => delayedReads.length === 8, "the preview read slots are physically occupied");
    assert.deepEqual(await (await fetch(`${address}/api/health`)).json(), { ok: true });
    controllers[0].abort();
    assert.equal(await pending[0], "AbortError");
    const full = await request("held"); assert.equal(full.status, 503);
    assert.equal(full.headers.get("retry-after"), "1");
    assert.equal(delayedReads.length, 8, "disconnect cannot release an active file read slot");
    const stopping = files.stop();
    let stopped = false;
    stopping.then(() => { stopped = true; });
    await tick(); assert.equal(stopped, false);
    assert.equal(delayedReads.some(handle => handle.closed), false);
    release(); await stopping; await Promise.all(pending);
    assert(handles.every(handle => handle.closed === 1));
    assert.equal(files.diagnostics().active, 0);
  } finally {
    release(); controllers.forEach(controller => controller.abort());
    await Promise.all(pending); await files.stop().catch(() => {});
    fs.promises.open = open;
    server.closeAllConnections(); await closeServer(server);
  }
}

try {
  await scenario("info route uses a bounded asynchronous preview and retains physical read slots", verifyInfoPreview);
  await scenario("slow transcode metadata does not block health or HEAD, and stop waits for it", async () => {
    let release;
    const held = new Promise(resolve => { release = resolve; });
    const f = fixture({ concurrency: 1, capacity: 4, childCloseTimeoutMs: 500,
      statFile: filename => filename === "/slow" ? held : { isFile: () => true } });
    const server = http.createServer((req, res) => {
      const url = new URL(req.url, "http://fixture");
      if (url.pathname === "/health") { res.writeHead(200); res.end("ok"); return; }
      f.service.serveTranscodedVideo(req, res, { path: url.pathname }, url);
    });
    const address = await listenPrivate(server), controller = new AbortController();
    const first = fetch(`${address}/slow`, { signal: controller.signal }).then(response => response.status, error => error.name);
    let queued;
    try {
      await until(() => f.statCalls === 1, "first metadata read is pending");
      queued = fetch(`${address}/queued`);
      await until(() => f.service.diagnostics().queued === 1, "GET waits for the physical metadata slot");
      assert.equal(f.statCalls, 1);
      assert.equal(await (await fetch(`${address}/health`)).text(), "ok");
      const head = await fetch(`${address}/head`, { method: "HEAD" });
      assert.equal(head.status, 200); assert.equal(await head.text(), "");
      assert.equal(f.statCalls, 2); assert.equal(f.children.length, 0);

      controller.abort(); assert.equal(await first, "AbortError");
      const stopping = f.service.stop();
      let stopped = false; stopping.then(() => { stopped = true; });
      assert.equal((await queued).status, 503);
      assert.equal(stopped, false); assert.equal(f.service.diagnostics().active, 1);
      release({ isFile: () => true }); await stopping;
      assert.equal(f.children.length, 0, "late metadata never launches a retired child");
      assert.equal(f.service.diagnostics().jobs, 0);
      await f.service.start();
      assert.equal((await fetch(`${address}/head`, { method: "HEAD" })).status, 200);
    } finally {
      controller.abort(); release({ isFile: () => true });
      await f.service.stop().catch(() => {});
      await queued?.catch(() => {}); await first;
      server.closeAllConnections(); await closeServer(server);
    }
  });

  await scenario("queued requests check current file availability before spawning", async () => {
    let removed = false;
    const f = fixture({ concurrency: 1, capacity: 2,
      statFile: filename => filename === "second.mp4" && removed ? null : { isFile: () => true },
      notFound: res => { res.writeHead(404); res.end(); } });
    f.request(); const queued = f.request({ filePath: "second.mp4" }).res;
    const child = await f.child();
    assert.equal(f.statCalls, 1, "queued work has not checked an old path yet");
    removed = true;
    child.stdout.write("ok"); await closeFake(child);
    await until(() => queued.writableFinished, "vanished source finishes with a missing response");
    assert.equal(queued.status, 404); assert.equal(f.children.length, 1);
    assert.equal(f.service.diagnostics().jobs, 0);
  });

  await scenario("gallery and disk compatibility routes defer the source check to the queue", async () => {
    const checked = [];
    const f = fixture({ statFile: file => { checked.push(file); return { isFile: () => true }; } });
    const notFound = () => assert.fail("synthetic source is present");
    const safeStat = () => assert.fail("compatibility routes must not stat synchronously");
    const index = { mediaItems: [{ id: "fixture", sourceRoot: "fixture", relativePath: "gallery.mp4", size: 20 }] };
    const galleryMediaService = createGalleryMediaService({ getImageLibraryIndex: () => index,
      safeChildPath: (root, relative) => `${root}/${relative}`, safeStat, normalizeExt: () => ".mp4",
      directVideoExts: new Set([".mp4"]), notFound });
    const gallery = createMediaRuntime({ galleryMediaService, mediaStreamService: f.service, notFound });
    const disk = createDiskUsageRoutes({ store: { cachedNode: () => ({ node: { path: "fixture/disk.mp4" } }) },
      mediaStreamService: f.service, normalizeExt: () => ".mp4", videoExtensions: new Set([".mp4"]), safeStat, notFound });
    for (const [router, pathname] of [[gallery, "/media/gallery-video/fixture/transcode?mode=remux"], [disk, "/api/disk-usage/media?mode=transcode"]]) {
      const req = Object.assign(new EventEmitter(), { method: "GET" }), res = new CaptureResponse();
      assert.equal(await router.routeMedia(req, res, new URL(pathname, "http://fixture")), true);
      const child = await f.child(checked.length - 1);
      child.stdout.write("ok"); await closeFake(child);
      assert.equal(res.body, "ok");
    }
    assert.deepEqual(checked, ["fixture/gallery.mp4", "fixture/disk.mp4"]);
  });

  await scenario("cancelled relocation cannot launch a late child", async () => {
    let release, started;
    const held = new Promise(resolve => { release = resolve; });
    const f = fixture({ concurrency: 1, statFile: () => null });
    const { res } = f.request({ resolveMissingSource: (_file, signal) => { started = signal; return held; } });
    try {
      await until(() => started, "missing source entered relocation");
      res.destroy(); await until(() => started.aborted, "disconnect aborts further relocation work");
      assert.equal(f.service.diagnostics().active, 1, "the unresolved metadata operation still owns its slot");
    } finally { release({ path: "late-relocation.mp4" }); }
    await until(() => f.service.diagnostics().jobs === 0, "late relocation physically settles");
    assert.equal(f.children.length, 0);
  });

  await scenario("startup deadline retains the metadata slot until physical completion", async () => {
    let release;
    const held = new Promise(resolve => { release = resolve; });
    const f = fixture({ concurrency: 1, capacity: 2, startupTimeoutMs: 20, statFile: () => held });
    const res = f.request().res;
    try {
      await until(() => res.writableFinished, "held source metadata times out");
      assert.equal(res.status, 504);
      assert.equal(f.service.diagnostics().active, 1);
      assert.equal(f.children.length, 0);
      await assert.rejects(f.service.start(), { code: "TRANSCODE_CLOSE_UNCONFIRMED" });
    } finally { release({ isFile: () => true }); }
    await until(() => f.service.diagnostics().jobs === 0, "late physical stat settles without spawning");
    assert.equal(f.children.length, 0);
  });

  await scenario("finite admission, FIFO, actual-close ownership", async () => {
    const f = fixture({ concurrency: 2, capacity: 3 });
    const first = f.request(), second = f.request(), queued = f.request(), rejected = f.request();
    await f.child(1);
    assert.equal(f.service.diagnostics().queued, 1);
    await until(() => rejected.res.writableFinished, "full admission responds");
    assert.equal(rejected.res.status, 503);
    assert.match(rejected.res.body, /TRANSCODE_BUSY/);
    first.res.destroy(); await tick();
    assert.deepEqual(f.children[0].killCalls, ["SIGKILL"]);
    assert.equal(f.children.length, 2, "a kill request does not release the process slot");
    assert.equal(f.service.diagnostics().active, 2);
    await closeFake(f.children[0], null, "SIGKILL");
    await f.child(2);
    assert.equal(f.service.diagnostics().queued, 0);
    for (const child of f.children.slice(1)) { child.stdout.write("ftypmdat"); await closeFake(child); }
    await until(() => second.res.writableFinished && queued.res.writableFinished, "remaining accepted streams complete");
    assert.equal(f.service.diagnostics().jobs, 0);
  });

  await scenario("preclosed request and HEAD do not spawn", async () => {
    const f = fixture();
    const closed = new CaptureResponse(); closed.destroy(); await tick();
    f.request({ res: closed });
    const aborted = new EventEmitter(); aborted.aborted = true; f.request({ req: aborted });
    assert.equal(f.statCalls, 0);
    assert.equal(f.children.length, 0);
    const head = f.request({ method: "HEAD" });
    await until(() => head.res.writableFinished, "HEAD completes");
    assert.equal(head.res.status, 200);
    assert.equal(head.res.responseHeaders["Content-Type"], "video/mp4");
    assert.equal(head.res.body, "");
    assert.equal(f.children.length, 0);
  });

  await scenario("EOF does not finish until successful child close", async () => {
    const f = fixture(); const { res } = f.request(); const child = await f.child();
    assert.equal(res.headersSent, false);
    child.stdout.end("ftypmdat"); await tick();
    assert.equal(res.status, 200);
    assert.equal(res.writableEnded, false);
    assert.equal(f.service.diagnostics().active, 1);
    await closeFake(child);
    await until(() => res.writableFinished, "success closes response");
    assert.equal(res.body, "ftypmdat");
    assert.equal(res.errors.length, 0);
  });

  await scenario("successful close also waits for buffered EOF", async () => {
    const f = fixture(); const { res } = f.request({ slow: true }); const child = await f.child();
    child.stdout.write("first"); child.stdout.end("second"); await tick();
    child.actualClosed = true; child.exitCode = 0; child.emit("close", 0); await tick();
    assert.equal(res.writableEnded, false, "close alone must not truncate unread bytes");
    assert.equal(child.stdout.isPaused(), true);
    await until(() => { res.release(); return res.writableFinished; }, "buffered success flushes after drain");
    assert.equal(res.body, "firstsecond");
    assert.equal(f.service.diagnostics().jobs, 0);
  });

  await scenario("output failure destroys instead of clean 200 EOF", async () => {
    const f = fixture(); const { res } = f.request(); const child = await f.child();
    child.stdout.end("partial"); await tick();
    await closeFake(child, 17);
    assert.equal(res.status, 200);
    assert.equal(res.destroyed, true);
    assert.equal(res.writableFinished, false);
    assert.equal(res.errors.length, 1);
    assert.equal(f.service.diagnostics().jobs, 0);
  });

  await scenario("pre-output and synchronous spawn failures preserve 500", async () => {
    const f = fixture(); const { res } = f.request();
    (await f.child()).stderr.write("synthetic codec error");
    await closeFake(f.children[0], 1);
    await until(() => res.writableFinished, "failure responds");
    assert.equal(res.status, 500); assert.match(res.body, /视频转码失败/);
    const thrown = fixture({ spawnProcess: () => { throw new Error("synthetic spawn exception"); } });
    const response = thrown.request().res;
    await until(() => response.writableFinished, "spawn exception responds");
    assert.equal(response.status, 500);
    assert.equal(thrown.service.diagnostics().active, 0);
  });

  await scenario("pipe errors are handled and retain live ownership", async () => {
    for (const stream of ["stdout", "stderr"]) {
      const f = fixture({ concurrency: 1, capacity: 2 }); const { res } = f.request(); f.request();
      const child = await f.child();
      assert.doesNotThrow(() => child[stream].emit("error", new Error(`synthetic ${stream} error`)));
      await until(() => res.writableFinished, "pipe error responds");
      assert.equal(res.status, 500);
      assert.deepEqual(child.killCalls, ["SIGKILL"]);
      assert.equal(f.children.length, 1);
      assert.doesNotThrow(() => child[stream].emit("error", new Error("repeat while closing")));
      await closeFake(child, null, "SIGKILL");
      const next = await f.child(1);
      next.stdout.write("ok"); await closeFake(next);
    }
  });

  await scenario("request abort and response errors cancel child", async () => {
    const f = fixture(); const aborted = f.request();
    await f.child();
    aborted.req.aborted = true; aborted.req.emit("aborted"); await tick();
    assert.deepEqual(f.children[0].killCalls, ["SIGKILL"]);
    assert.equal(f.service.diagnostics().active, 1);
    await closeFake(f.children[0], null, "SIGKILL");
    const response = f.request().res; (await f.child(1)).stdout.write("partial"); await tick();
    response.emit("error", new Error("synthetic response error")); await tick();
    assert.deepEqual(f.children[1].killCalls, ["SIGKILL"]);
    await closeFake(f.children[1], null, "SIGKILL");
    assert.equal(f.service.diagnostics().jobs, 0);
  });

  await scenario("backpressure pauses and preserves all chunk bytes", async () => {
    const f = fixture(); const { res } = f.request({ slow: true }); const child = await f.child();
    const pieces = ["first", "second", "third", "fourth"];
    child.stdout.write(pieces[0]); await tick();
    for (const piece of pieces.slice(1)) child.stdout.write(piece);
    child.stdout.end(); await tick();
    assert.equal(child.stdout.isPaused(), true);
    assert.equal(res.chunks.length, 1);
    assert.equal(res.writableLength, pieces[0].length);
    await until(() => { res.release(); return child.stdout.readableEnded; }, "slow consumer drains stdout");
    assert.equal(res.writableEnded, false);
    await closeFake(child);
    await until(() => { res.release(); return res.writableFinished; }, "slow consumer flushes response");
    assert.equal(res.body, pieces.join(""));
  });

  await scenario("bounded queue wait and first-byte startup timeout", async () => {
    const f = fixture({ concurrency: 1, capacity: 2, queueTimeoutMs: 15 }); f.request(); const queued = f.request().res;
    await until(() => queued.writableFinished, "queue timeout responds");
    assert.equal(queued.status, 503); assert.equal(f.children.length, 1);
    await closeFake(f.children[0], 1);
    const startup = fixture({ startupTimeoutMs: 15 }); const response = startup.request().res;
    await until(() => response.writableFinished, "startup timeout responds");
    assert.equal(response.status, 504);
    assert.deepEqual(startup.children[0].killCalls, ["SIGKILL"]);
    assert.equal(startup.service.diagnostics().active, 1);
    await closeFake(startup.children[0], null, "SIGKILL");
  });

  await scenario("EOF with a still-live child is bounded and killed", async () => {
    const f = fixture({ childCloseTimeoutMs: 20 }); const { res } = f.request();
    (await f.child()).stdout.end("partial");
    await until(() => res.destroyed, "post-EOF close timeout destroys response");
    assert.deepEqual(f.children[0].killCalls, ["SIGKILL"]);
    assert.equal(f.service.diagnostics().active, 1);
    await closeFake(f.children[0], null, "SIGKILL");
  });

  await scenario("stop drains actual close and fences a newer stop intent", async () => {
    const f = fixture({ concurrency: 1, capacity: 2 }); f.request(); const queued = f.request().res;
    await f.child();
    const stopping = f.service.stop(); let stopped = false; stopping.then(() => { stopped = true; });
    const restarting = f.service.start(); const rejectedRestart = assert.rejects(restarting, { code: "TRANSCODE_STOPPED" });
    f.service.beginStop(); await tick();
    assert.equal(queued.status, 503);
    assert.equal(stopped, false);
    assert.equal(f.children.length, 1);
    await closeFake(f.children[0], null, "SIGKILL"); await stopping; await rejectedRestart;
    assert.equal(f.service.diagnostics().accepting, false);
    await f.service.start();
    const restarted = f.request().res; (await f.child(1)).stdout.write("ok"); await closeFake(f.children[1]);
    await until(() => restarted.writableFinished, "explicit later start resumes service");
  });

  await scenario("unconfirmed close fails closed, keeps owner, blocks queued spawn", async () => {
    const f = fixture({ concurrency: 1, capacity: 2, childCloseTimeoutMs: 20 }); const active = f.request(); const queued = f.request().res;
    await f.child();
    active.res.destroy(); await tick();
    await assert.rejects(f.service.start(), { code: "TRANSCODE_CLOSE_UNCONFIRMED" });
    await until(() => !f.service.diagnostics().accepting, "close timeout fails closed");
    await until(() => queued.writableFinished, "queued requests cancelled on unknown child");
    assert.equal(queued.status, 503);
    assert.equal(f.children.length, 1);
    assert.equal(f.service.diagnostics().unconfirmedClose, true);
    assert.equal(f.service.diagnostics().active, 1);
    await assert.rejects(f.service.stop(), { code: "TRANSCODE_CLOSE_UNCONFIRMED" });
    await assert.rejects(f.service.start(), { code: "TRANSCODE_CLOSE_UNCONFIRMED" });
    const rejected = f.request().res; await until(() => rejected.writableFinished, "new request rejected"); assert.equal(rejected.status, 503);
    await closeFake(f.children[0], null, "SIGKILL");
    await f.service.start(); assert.equal(f.service.diagnostics().active, 0);
  });

  await scenario("bounded stderr logging and unchanged codec/remux arguments", async () => {
    const f = fixture(); f.request({ query: "?mode=remux&audio=copy&t=12.8" });
    await f.child();
    const args = f.args[0]; assert.equal(args[args.indexOf("-ss") + 1], "12");
    assert.equal(args[args.indexOf("-c:v") + 1], "copy"); assert.equal(args[args.indexOf("-c:a") + 1], "copy");
    assert.equal(args.includes("-vf"), false);
    for (let index = 0; index < 10; index++) f.children[0].stderr.write("x".repeat(2000));
    assert.equal(f.warnings.join("").length, 8000);
    await closeFake(f.children[0], 1);
    f.request(); await f.child(1); const transcodeArgs = f.args[1];
    assert.equal(transcodeArgs[transcodeArgs.indexOf("-c:v") + 1], "h264_nvenc");
    assert.match(transcodeArgs[transcodeArgs.indexOf("-vf") + 1], /min\(iw,4096\).*min\(ih,4096\)/);
    f.children[1].stdout.write("ok"); await closeFake(f.children[1]);
    const invalid = fixture({ concurrency: Infinity, capacity: NaN });
    assert.equal(invalid.service.diagnostics().concurrency, 2); assert.equal(invalid.service.diagnostics().capacity, 16);
    const bounded = fixture({ concurrency: 100, capacity: 10000 });
    assert.equal(bounded.service.diagnostics().concurrency, 16); assert.equal(bounded.service.diagnostics().capacity, 512);
  });

  await scenario("private Node output failure aborts real HTTP body", async () => {
    const f = fixture({ spawnProcess: () => privateChild("process.stdout.write('partial mp4 bytes');setTimeout(()=>process.exit(17),80)") });
    const server = http.createServer((req, res) => f.service.serveTranscodedVideo(req, res, { path: "unused" }, new URL("http://fixture/transcode")));
    const address = await listenPrivate(server);
    const response = await fetch(address);
    assert.equal(response.status, 200);
    await assert.rejects(response.text(), /terminated|aborted|socket/i);
    const child = [...actualChildren].at(-1); assert.equal((await child.closed).code, 17);
    await until(() => f.service.diagnostics().jobs === 0, "failed private stream disposed");
    await closeServer(server);
  });

  await scenario("private Node success delivers exact HTTP bytes", async () => {
    const f = fixture({ spawnProcess: () => privateChild("process.stdout.write('ftypmdat');setTimeout(()=>process.exit(0),10)") });
    const server = http.createServer((req, res) => f.service.serveTranscodedVideo(req, res, { path: "unused" }, new URL("http://fixture/transcode")));
    const address = await listenPrivate(server); const response = await fetch(address, { headers: { Connection: "close" } });
    assert.equal(response.status, 200); assert.equal(await response.text(), "ftypmdat");
    const child = [...actualChildren].at(-1); assert.equal((await child.closed).code, 0);
    await until(() => f.service.diagnostics().jobs === 0, "successful private stream disposed"); await closeServer(server);
  });

  await scenario("private HTTP disconnect kills and observes actual Node close", async () => {
    const f = fixture({ spawnProcess: () => privateChild("process.stdout.write('ftyp');setInterval(()=>{},1000)") });
    const server = http.createServer((req, res) => f.service.serveTranscodedVideo(req, res, { path: "unused" }, new URL("http://fixture/transcode")));
    const address = await listenPrivate(server); const controller = new AbortController();
    try {
      const response = await fetch(address, { signal: controller.signal });
      assert.equal(response.status, 200);
      const body = response.text(); controller.abort(); await assert.rejects(body);
      const child = [...actualChildren].at(-1);
      await until(() => child.actualClosed, "disconnect waits for real Node close");
      await until(() => f.service.diagnostics().jobs === 0, "disconnected private stream disposed");
    } finally { controller.abort(); await f.service.stop(); await closeServer(server); }
  });

  await scenario("Host beginStop drains silent private child before successful exit", async () => {
    let child; let ready;
    const readiness = new Promise((resolve) => { ready = resolve; });
    const f = fixture({ spawnProcess: () => { child = privateChild("process.stderr.write('ready');setInterval(()=>{},1000)"); child.stderr.once("data", ready); return child; }, childCloseTimeoutMs: 500 });
    const exits = []; const processRef = new EventEmitter(); processRef.exit = (code) => exits.push(code);
    const host = createServerHost({ requestHandler: (req, res) => f.service.serveTranscodedVideo(req, res, { path: "unused" }, new URL("http://fixture/transcode")), host: "127.0.0.1", port: 0, getLibraryState: () => ({ availableRoots: [], missingRoots: [] }), beginStop: () => f.service.beginStop(), stop: () => f.service.stop(), processRef, logger: { log() {}, error() {} }, networkInterfaces: () => ({}), shutdownTimeoutMs: 1500 });
    servers.add(host.server); host.listen(); await once(host.server, "listening");
    const controller = new AbortController();
    const response = fetch(`http://127.0.0.1:${host.server.address().port}`, { signal: controller.signal, headers: { Connection: "close" } });
    try {
      await readiness; assert.equal(child.actualClosed, false);
      await host.shutdown("fixture");
      assert.equal(child.actualClosed, true, "successful Host exit requires actual child close");
      assert.deepEqual(exits, [0]);
      assert.equal((await response).status, 503);
      assert.equal(f.service.diagnostics().jobs, 0);
    } finally { controller.abort(); await response.catch(() => {}); await closeServer(host.server); }
  });

  console.log(`media-stream-lifecycle: ${scenarios} scenarios passed (controlled pipes, private Node children and loopback HTTP; no FFmpeg/media/services)`);
} finally {
  for (const f of fixtures) {
    for (const response of f.responses) { response.release(); if (!response.destroyed && !response.writableFinished) response.destroy(); }
    for (const child of f.children) { child.stdout.resume(); await closeFake(child, null, "SIGKILL"); }
    f.service.beginStop();
  }
  for (const child of actualChildren) {
    if (!child.actualClosed) child.kill("SIGKILL");
    await child.closed;
  }
  await tick();
  for (const f of fixtures) await f.service.stop().catch(() => {});
  for (const server of [...servers]) { server.closeAllConnections?.(); await closeServer(server); }
}
