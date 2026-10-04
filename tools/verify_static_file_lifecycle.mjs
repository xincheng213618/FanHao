import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { spawnSync } from "node:child_process";
import { EventEmitter, once } from "node:events";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { brotliDecompressSync, gunzipSync } from "node:zlib";
import * as currentStatic from "../src/platform/server/static-files.js";
import * as currentHttp from "../src/platform/server/http-app.js";
import { createServerHost } from "../src/platform/server/server-host.js";

// Controlled file handles and streams exercise the actual server. The one real
// FileHandle/HTTP case reads this fixture's source only. No files or directories
// are created/deleted; no media, database or production service is used.
const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const staticPath = path.join(repository, "src/platform/server/static-files.js");
const httpPath = path.join(repository, "src/platform/server/http-app.js");
const virtualRoot = path.join(os.tmpdir(), "fanhao-virtual-static-fixture");
const realStaticSource = fs.readFileSync(staticPath, "utf8");
const realHttpSource = fs.readFileSync(httpPath, "utf8");
const legacyStatic = process.argv.includes("--legacy-static");
const legacyHttp = process.argv.includes("--legacy-http");
const withoutStaticLifecycle = process.argv.includes("--without-lifecycle-hooks");
const withoutNativeCloseProof = process.argv.includes("--without-native-close-proof");
let staticModule = currentStatic, httpModule = currentHttp;
if (legacyStatic) {
  const old = spawnSync("git", ["show", "HEAD:src/platform/server/static-files.js"], { cwd: repository, encoding: "utf8" });
  assert.equal(old.status, 0, old.stderr);
  assert.match(old.stdout, /fs\.existsSync\(target\).*fs\.statSync\(target\)/);
  staticModule = await import(`data:text/javascript;base64,${Buffer.from(old.stdout).toString("base64")}`);
}
if (legacyHttp) {
  const statement = "await serveStatic(req, res, url.pathname);";
  assert.equal(realHttpSource.split(statement).length, 2, "negative must remove the actual static await");
  httpModule = await import(`data:text/javascript;base64,${Buffer.from(realHttpSource.replace(statement, "serveStatic(req, res, url.pathname);")).toString("base64")}`);
}
if (withoutNativeCloseProof) {
  const statement = "handle.close = () => owner.closePromise ||= Promise.resolve().then(closeHandle);";
  assert.equal(realStaticSource.split(statement).length, 2, "negative must remove the actual first native close capture");
  staticModule = await import(`data:text/javascript;base64,${Buffer.from(realStaticSource.replace(statement, "// Native close capture omitted in the behavioral negative.")).toString("base64")}`);
}

const codeError = (code, message = code) => Object.assign(new Error(message), { code });
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function ticks() { for (let index = 0; index < 12; index += 1) await Promise.resolve(); }

class ResponseSink extends Writable {
  constructor(onHeaders = null) {
    super(); this.chunks = []; this.headers = {}; this.statusCode = 0; this.headersSent = false; this.onHeaders = onHeaders;
    this.failures = []; this.on("error", error => this.failures.push(error));
  }
  _write(chunk, _encoding, done) { this.chunks.push(Buffer.from(chunk)); done(); }
  writeHead(status, headers = {}) {
    this.onHeaders?.(status, headers);
    this.statusCode = status; this.headers = { ...this.headers, ...headers }; this.headersSent = true;
  }
  setHeader(name, value) { this.headers[name] = value; }
  getHeader(name) { return this.headers[name]; }
  get body() { return Buffer.concat(this.chunks); }
}

function request(url = "/asset.bin", options = {}) {
  return Object.assign(new EventEmitter(), { method: "GET", url, headers: { host: "fixture" }, aborted: false }, options);
}

function virtualFs() {
  const files = new Map(), handles = [], events = [], realm = new AsyncLocalStorage();
  let nextFd = 10, syncCalls = 0;
  const target = route => path.join(virtualRoot, route);
  function add(route, bytes = "synthetic bytes", options = {}) {
    const entry = { bytes: Buffer.from(bytes), isFile: true, ...options };
    files.set(target(route), entry); return entry;
  }
  function stat(entry) {
    if (entry.statError) throw entry.statError;
    return { size: entry.bytes.length, isFile: () => entry.isFile };
  }
  function handle(filePath, entry) {
    const record = { path: filePath, entry, fd: nextFd++, physicallyClosed: false, closeCount: 0, statCalls: 0, streamCalls: 0, stream: null };
    let closing;
    const close = () => { if (!record.physicallyClosed) { record.physicallyClosed = true; record.fd = -1; record.closeCount += 1; } };
    record.stat = async () => {
      record.statCalls += 1; events.push({ type: "stat", realm: realm.getStore()?.id });
      if (entry.statGate) await entry.statGate.promise;
      return stat(entry);
    };
    record.close = () => closing ||= (async () => {
      if (entry.earlyCloseSignal) record.fd = -1;
      if (entry.closeGate) await entry.closeGate.promise;
      if (entry.closeError) throw entry.closeError;
      close();
    })();
    record.createReadStream = options => {
      record.streamCalls += 1; assert.equal(options.autoClose, true);
      events.push({ type: "stream", realm: realm.getStore()?.id });
      if (entry.createError) throw entry.createError;
      let started = false;
      const stream = new Readable({
        read() {
          if (started) return;
          started = true;
          if (entry.holdStream) return;
          if (entry.readError) { this.destroy(entry.readError); return; }
          this.push(entry.bytes); this.push(null);
        },
        destroy(error, done) {
          Promise.resolve(entry.streamCloseGate?.promise).then(() => record.close()).then(() => done(error), done);
        }
      });
      record.stream = stream; return stream;
    };
    handles.push(record); return record;
  }
  async function openFile(filePath, flags) {
    assert.equal(flags, "r"); events.push({ type: "open", realm: realm.getStore()?.id });
    const entry = files.get(filePath);
    if (!entry) throw codeError("ENOENT");
    if (entry.openGate) await entry.openGate.promise;
    if (entry.openError) throw entry.openError;
    return handle(filePath, entry);
  }
  // The old implementation's real fs calls receive the same controlled path
  // catalogue in its behavioral negative. Production uses its injected opener.
  function installLegacyFs() {
    const originals = { existsSync: fs.existsSync, statSync: fs.statSync, createReadStream: fs.createReadStream };
    const controlled = value => typeof value === "string" && value.startsWith(virtualRoot + path.sep);
    fs.existsSync = (value, ...args) => { if (!controlled(value)) return originals.existsSync(value, ...args); syncCalls += 1; return files.has(value); };
    fs.statSync = (value, ...args) => { if (!controlled(value)) return originals.statSync(value, ...args); syncCalls += 1; const entry = files.get(value); if (!entry) throw codeError("ENOENT"); return stat(entry); };
    fs.createReadStream = (value, ...args) => {
      if (!controlled(value)) return originals.createReadStream(value, ...args);
      const entry = files.get(value); if (!entry) throw codeError("ENOENT");
      return handle(value, entry).createReadStream({ autoClose: true });
    };
    return () => Object.assign(fs, originals);
  }
  const fileserver = staticModule.createStaticFileServer({
    publicDir: virtualRoot, mimeTypes: { ".bin": "application/octet-stream", ".txt": "text/plain", ".js": "text/javascript", ".html": "text/html" },
    normalizeExt: filename => path.extname(filename),
    notFound(res) { res.writeHead(404); res.end(); }, openFile, stopTimeoutMs: 20
  });
  return { add, target, files, handles, events, realm, fileserver, installLegacyFs,
    active: () => handles.filter(value => !value.physicallyClosed).length,
    syncCalls: () => syncCalls,
    dispose() { for (const entry of handles) entry.stream?.destroy(); } };
}

function handler(fileserver, { realm = new AsyncLocalStorage(), errors = [], auth = () => ({ allowed: true, user: { id: "alice" } }) } = {}) {
  return httpModule.createRequestHandler({
    attachAccessAnalytics() {}, attachAccessLogger() {}, requestCorsOrigin: () => "", requestAuthState: auth,
    runForUser: (user, action) => realm.run(user, action), routeAuth: async () => false,
    sendLoginRequired(_req, res) { res.writeHead(401); res.end(); },
    async routeApi(_req, res, url) { if (url.pathname === "/health") { res.writeHead(200); res.end("healthy"); return true; } return false; },
    routeMedia: async () => false, renderAndroidUpdatePage: () => "",
    serveStatic: fileserver.serveStatic,
    sendHtml(res, status, html) { res.writeHead(status); res.end(html); },
    sendText(res, status, text) { res.writeHead(status); res.end(text); },
    sendJson(res, status, value) { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(value)); },
    logError(...args) { errors.push(args); }
  });
}

async function direct(f, req = request(), res = new ResponseSink()) {
  const completed = res.writableFinished ? Promise.resolve() : once(res, "finish");
  await f.fileserver.serveStatic(req, res, new URL(req.url, "http://fixture").pathname);
  await completed; return res;
}

async function rawHttp(port, route, options = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path: route, ...options }, res => {
      const chunks = []; res.on("data", chunk => chunks.push(chunk)); res.once("error", reject);
      res.once("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.once("error", reject); req.end();
  });
}

const cases = [];
const add = (name, run) => cases.push({ name, run });

add("default-opener:actual-readonly-file-and-head-use-no-sync-metadata", async () => {
  const filename = fileURLToPath(import.meta.url), expected = fs.readFileSync(filename), handles = [];
  const originalOpen = fs.promises.open, originalExists = fs.existsSync, originalStat = fs.statSync;
  let syncCalls = 0;
  fs.promises.open = async (...args) => { const opened = await originalOpen(...args); handles.push(opened); return opened; };
  fs.existsSync = (value, ...args) => { if (value === filename) { syncCalls += 1; throw codeError("SYNC_STATIC_METADATA"); } return originalExists(value, ...args); };
  fs.statSync = (value, ...args) => { if (value === filename) { syncCalls += 1; throw codeError("SYNC_STATIC_METADATA"); } return originalStat(value, ...args); };
  const fileserver = staticModule.createStaticFileServer({ publicDir: path.dirname(filename), mimeTypes: { ".mjs": "text/javascript" }, normalizeExt: value => path.extname(value), notFound(res) { res.writeHead(404); res.end(); } });
  const server = http.createServer(handler(fileserver));
  try {
    server.listen(0, "127.0.0.1"); await once(server, "listening");
    const route = `/${path.basename(filename)}`, port = server.address().port;
    const get = await rawHttp(port, route); assert.equal(get.status, 200); assert.deepEqual(get.body, expected);
    const head = await rawHttp(port, route, { method: "HEAD" }); assert.equal(head.status, 200); assert.equal(head.body.length, 0);
    assert.equal(Number(head.headers["content-length"]), expected.length); assert.equal(syncCalls, 0);
    assert.equal(handles.length, 2); assert(handles.every(value => value.fd === -1), "actual FileHandles close after GET and HEAD");
  } finally {
    fs.promises.open = originalOpen; fs.existsSync = originalExists; fs.statSync = originalStat;
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    for (const value of handles) if (value.fd !== -1) await value.close();
  }
});

add("identity:replacement-after-headers-cannot-mix-size-and-new-bytes", async f => {
  const original = f.add("asset.bin", "OLD");
  const res = new ResponseSink(() => f.add("asset.bin", "NEW-SOURCE-BYTES"));
  await direct(f, request(), res);
  assert.equal(res.headers["Content-Length"], original.bytes.length); assert.deepEqual(res.body, original.bytes);
  assert.equal(f.active(), 0); assert.equal(f.handles.length, 1); assert.equal(f.handles[0].closeCount, 1);
});

add("headers:head-and-empty-file-close-without-creating-a-reader", async f => {
  f.add("asset.bin", "nonempty"); const head = await direct(f, request("/asset.bin", { method: "HEAD" }));
  assert.equal(head.body.length, 0); assert.equal(head.headers["Content-Length"], 8);
  f.add("empty.bin", ""); const empty = await direct(f, request("/empty.bin"));
  assert.equal(empty.headers["Content-Length"], 0); assert.equal(empty.body.length, 0);
  f.add("large.js", "synthetic source\n".repeat(200));
  const compressedHead = await direct(f, request("/large.js", { method: "HEAD", headers: { "accept-encoding": "br" } }));
  assert.equal(compressedHead.headers["Content-Encoding"], "br"); assert.equal(compressedHead.headers["Content-Length"], undefined);
  assert.equal(compressedHead.body.length, 0);
  assert.equal(f.handles.length, 3); assert(f.handles.every(value => value.closeCount === 1 && value.streamCalls === 0));
});

add("compression:gzip-and-brotli-preserve-payload-and-close-handles", async f => {
  const entry = f.add("asset.js", "const synthetic = 1;\n".repeat(200));
  for (const [encoding, decode] of [["gzip", gunzipSync], ["br", brotliDecompressSync]]) {
    const res = await direct(f, request("/asset.js?v=bundle-abcdef123456", { headers: { "accept-encoding": encoding } }));
    assert.equal(res.headers["Content-Encoding"], encoding); assert.equal(res.headers.Vary, "Accept-Encoding");
    assert.equal(res.headers["Cache-Control"], "public, max-age=31536000, immutable");
    assert.equal(res.headers["Content-Length"], undefined); assert.deepEqual(decode(res.body), entry.bytes);
    assert.equal(f.active(), 0);
  }
  assert(f.handles.every(value => value.closeCount === 1));
});

add("mapping:app-standalone-cache-and-outside-root-contracts-remain", async f => {
  f.add("index.html", "app"); f.add("admin.html", "admin");
  f.add("modules/fanhao/disk-usage/index.html", "disk"); f.add("modules/system/computer-control/index.html", "control");
  f.add("modules/fanhao/file-workflows/index.html", "workflow");
  for (const [route, content] of [["/music/album", "app"], ["/", "app"], ["/admin", "admin"], ["/disk-usage", "disk"], ["/system-control", "control"], ["/fanhao/file-workflows", "workflow"]]) {
    const res = await direct(f, request(route)); assert.equal(res.statusCode, 200); assert.equal(res.body.toString(), content);
    assert.equal(res.headers["Cache-Control"], "no-store");
  }
  const encodedTraversal = "/%2e%2e%2f%2e%2e%2foutside.bin";
  assert.equal(f.fileserver.publicFilePath(encodedTraversal), f.target("outside.bin"), "existing normalization maps root traversal inside the public directory");
  const outside = await direct(f, request(encodedTraversal)); assert.equal(outside.statusCode, 404);
  assert.equal(staticModule.staticCacheControl("/asset.js?v=ordinary", ".js"), "no-store");
  assert.equal(staticModule.staticCacheControl("/index.html?v=bundle-abcdef123456", ".html"), "no-store");
});

add("not-found:missing-directory-and-permission-do-not-leak-handles", async f => {
  f.add("folder", "", { isFile: false }); f.add("denied.bin", "", { openError: codeError("EACCES") });
  for (const route of ["/missing.bin", "/folder", "/denied.bin"]) {
    const res = await direct(f, request(route)); assert.equal(res.statusCode, 404);
  }
  assert.equal(f.active(), 0); assert.equal(f.handles.length, 1); assert.equal(f.handles[0].closeCount, 1);
});

add("preheader:open-stat-and-reader-errors-reach-awaited-public-boundary", async f => {
  f.add("open.bin", "bytes", { openError: codeError("EIO") });
  f.add("stat.bin", "bytes", { statError: codeError("EIO") });
  f.add("reader.bin", "bytes", { createError: codeError("EIO") });
  const errors = [], handle = handler(f.fileserver, { realm: f.realm, errors });
  for (const route of ["/open.bin", "/stat.bin", "/reader.bin"]) {
    const res = new ResponseSink(); await handle(request(route), res);
    assert.equal(res.statusCode, 500); assert.deepEqual(JSON.parse(res.body), { error: "Internal server error" });
    assert.equal(f.active(), 0);
  }
  assert.equal(errors.length, 3); assert(f.handles.every(value => value.closeCount === 1));
});

add("open:pending-filesystem-does-not-block-health-and-abort-closes-late-handle", async f => {
  const gate = deferred(); f.add("asset.bin", "bytes", { openGate: gate });
  const req = request(), res = new ResponseSink(), operation = f.fileserver.serveStatic(req, res, "/asset.bin");
  await ticks(); assert.equal(f.handles.length, 0); assert.equal(res.headersSent, false);
  const health = new ResponseSink(); await handler(f.fileserver)(request("/health"), health);
  assert.equal(health.body.toString(), "healthy"); assert.equal(f.syncCalls(), 0);
  req.aborted = true; req.emit("aborted"); gate.resolve(); await operation;
  assert.equal(res.headersSent, false); assert.equal(f.handles.length, 1); assert.equal(f.active(), 0);
  assert.equal(f.handles[0].statCalls, 0); assert.equal(f.handles[0].closeCount, 1);
});

add("stat:disconnect-before-metadata-completes-closes-without-response", async f => {
  const gate = deferred(); f.add("asset.bin", "bytes", { statGate: gate });
  const req = request(), res = new ResponseSink(), operation = f.fileserver.serveStatic(req, res, "/asset.bin");
  await ticks(); assert.equal(f.handles[0].statCalls, 1); assert.equal(f.active(), 1);
  res.destroy(); gate.resolve(); await operation;
  assert.equal(res.headersSent, false); assert.equal(f.active(), 0); assert.equal(f.handles[0].streamCalls, 0);
});

add("abort:already-aborted-request-never-opens-a-file", async f => {
  f.add("asset.bin", "bytes"); const req = request("/asset.bin", { aborted: true }), res = new ResponseSink();
  await f.fileserver.serveStatic(req, res, "/asset.bin"); assert.equal(f.events.length, 0); assert.equal(res.headersSent, false);
});

add("abort:midstream-request-abort-closes-reader-and-detaches-listener", async f => {
  f.add("asset.bin", "bytes", { holdStream: true });
  const req = request(), res = new ResponseSink(), operation = f.fileserver.serveStatic(req, res, "/asset.bin");
  await ticks(); assert.equal(res.headersSent, true); assert.equal(f.active(), 1);
  assert.equal(req.listenerCount("aborted"), 1); req.aborted = true; req.emit("aborted"); await operation;
  assert.equal(f.active(), 0); assert.equal(f.handles[0].closeCount, 1); assert.equal(req.listenerCount("aborted"), 0);
  assert.equal(f.handles[0].stream.destroyed, true); assert.equal(res.destroyed, true);
});

add("disconnect:compressed-response-close-retires-source-handle", async f => {
  f.add("asset.js", "large source\n".repeat(500), { holdStream: true });
  const req = request("/asset.js", { headers: { "accept-encoding": "gzip" } }), res = new ResponseSink();
  const operation = f.fileserver.serveStatic(req, res, "/asset.js"); await ticks();
  assert.equal(res.headers["Content-Encoding"], "gzip"); assert.equal(f.active(), 1);
  res.destroy(); await operation;
  assert.equal(f.active(), 0); assert.equal(f.handles[0].stream.destroyed, true); assert.equal(req.listenerCount("aborted"), 0);
});

add("disconnect:response-closed-at-header-commit-retires-the-unread-source", async f => {
  f.add("asset.bin", "bytes", { holdStream: true });
  const req = request(), res = new ResponseSink(() => res.destroy());
  await f.fileserver.serveStatic(req, res, "/asset.bin");
  assert.equal(res.destroyed, true); assert.equal(res.body.length, 0);
  assert.equal(f.active(), 0); assert.equal(f.handles[0].closeCount, 1); assert.equal(req.listenerCount("aborted"), 0);
});

add("postheader:plain-and-compressed-read-errors-destroy-incomplete-body", async f => {
  for (const encoding of ["", "gzip"]) {
    f.add("asset.js", "large source\n".repeat(500), { readError: codeError("EIO") });
    const req = request("/asset.js", { headers: { "accept-encoding": encoding } }), res = new ResponseSink();
    await f.fileserver.serveStatic(req, res, "/asset.js");
    assert.equal(res.statusCode, 200); assert.equal(res.destroyed, true); assert.equal(res.body.length, 0);
    assert.equal(f.active(), 0); assert.equal(req.listenerCount("aborted"), 0);
  }
  assert(f.handles.every(value => value.closeCount === 1));
});

add("headers:throwing-before-header-commit-still-closes-created-reader", async f => {
  f.add("asset.bin", "bytes"); const res = new ResponseSink(() => { throw codeError("HEADER_FAILURE"); });
  await assert.rejects(f.fileserver.serveStatic(request(), res, "/asset.bin"), { code: "HEADER_FAILURE" });
  assert.equal(res.headersSent, false); assert.equal(f.active(), 0); assert.equal(f.handles[0].closeCount, 1);
});

add("auth-and-als:denial-never-opens-and-awaited-metadata-keeps-request-owner", async f => {
  const gate = deferred(); f.add("alice.bin", "alice bytes", { statGate: gate }); f.add("bob.bin", "bob bytes");
  const secured = handler(f.fileserver, { realm: f.realm, auth: req => ({ allowed: req.headers.owner !== "denied", user: { id: req.headers.owner } }) });
  const denied = new ResponseSink(); await secured(request("/alice.bin", { headers: { owner: "denied" } }), denied);
  assert.equal(denied.statusCode, 401); assert.equal(f.events.length, 0);
  const alice = new ResponseSink(); let aliceSettled = false;
  const pending = secured(request("/alice.bin", { headers: { owner: "alice" } }), alice).then(() => { aliceSettled = true; });
  await ticks(); assert.equal(aliceSettled, false, "request handler must await the pending static response");
  const bob = new ResponseSink(); await secured(request("/bob.bin", { headers: { owner: "bob" } }), bob);
  assert.equal(bob.body.toString(), "bob bytes"); gate.resolve(); await pending;
  assert.equal(alice.body.toString(), "alice bytes");
  assert.deepEqual(f.events.map(event => [event.type, event.realm]), [["open", "alice"], ["stat", "alice"], ["open", "bob"], ["stat", "bob"], ["stream", "bob"], ["stream", "alice"]]);
  assert.equal(f.active(), 0);
});

add("lifecycle:normal-drain-refuses-new-files-and-fresh-start-reopens", async f => {
  f.add("asset.bin", "bytes"); await direct(f);
  assert.deepEqual(f.fileserver.diagnostics(), { accepting: true, active: 0, closeFailed: 0 });
  f.fileserver.beginStop();
  const eventCount = f.events.length, stopped = new ResponseSink();
  await f.fileserver.serveStatic(request(), stopped, "/asset.bin");
  assert.equal(stopped.statusCode, 503); assert.equal(stopped.body.length, 0);
  assert.equal(stopped.headers["Cache-Control"], "no-store"); assert.equal(f.events.length, eventCount);
  await f.fileserver.stop(); assert.equal(await f.fileserver.start(), true);
  const restarted = await direct(f); assert.equal(restarted.statusCode, 200);
  assert.equal(f.active(), 0); assert.equal(f.fileserver.diagnostics().active, 0);
});

add("lifecycle:ignored-open-stat-and-head-close-retain-physical-owners", async f => {
  for (const stage of ["open", "stat", "close"]) {
    const gate = deferred(), route = `/${stage}.bin`;
    f.add(`${stage}.bin`, "bytes", { [`${stage}Gate`]: gate, earlyCloseSignal: stage === "close" });
    const req = request(route, { method: "HEAD" }), res = new ResponseSink();
    const operation = f.fileserver.serveStatic(req, res, route);
    const done = operation.then(() => true, error => error);
    try {
      await ticks();
      assert.equal(f.fileserver.diagnostics().active, 1);
      if (stage === "open") assert.equal(f.handles.length, 0);
      else if (stage === "stat") assert.equal(f.handles.at(-1).statCalls, 1);
      else {
        assert.equal(res.statusCode, 200); assert.equal(res.writableEnded, true);
        assert.equal(f.handles.at(-1).fd, -1, "the JS close signal precedes physical completion");
        assert.equal(f.handles.at(-1).physicallyClosed, false);
      }
      const stopping = f.fileserver.stop(); assert.equal(f.fileserver.stop(), stopping);
      if (stage !== "close") assert.equal(res.destroyed, true, "pre-header stop disconnects the HTTP response immediately");
      await assert.rejects(stopping, { code: "STATIC_FILE_STOP_INCOMPLETE" });
      assert.equal(f.fileserver.diagnostics().active, 1);
      await assert.rejects(f.fileserver.start(), { code: "STATIC_FILE_STOP_INCOMPLETE" });
      const eventCount = f.events.length, blocked = new ResponseSink();
      await f.fileserver.serveStatic(request(route), blocked, route);
      assert.equal(blocked.statusCode, 503); assert.equal(f.events.length, eventCount);
    } finally { gate.resolve(); assert.equal(await done, true); }
    assert.equal(f.active(), 0); assert.equal(f.fileserver.diagnostics().active, 0);
    assert.equal(req.listenerCount("aborted"), 0); assert.equal(await f.fileserver.start(), true);
  }
});

add("lifecycle:plain-gzip-brotli-stream-close-blocks-stop-until-physical-settle", async f => {
  for (const encoding of ["", "gzip", "br"]) {
    const gate = deferred(); f.add("asset.js", "synthetic source\n".repeat(300), { holdStream: true, streamCloseGate: gate });
    const req = request("/asset.js", { headers: { "accept-encoding": encoding } }), res = new ResponseSink();
    const operation = f.fileserver.serveStatic(req, res, "/asset.js");
    const done = operation.then(() => true, error => error);
    try {
      await ticks(); assert.equal(res.statusCode, 200);
      const source = f.handles.at(-1).stream; assert.equal(source.closed, false);
      await assert.rejects(f.fileserver.stop(), { code: "STATIC_FILE_STOP_INCOMPLETE" });
      assert.equal(res.destroyed, true); assert.equal(source.destroyed, true); assert.equal(source.closed, false);
      assert.equal(f.fileserver.diagnostics().active, 1); assert.equal(f.active(), 1);
    } finally { gate.resolve(); assert.equal(await done, true); }
    assert.equal(f.active(), 0); assert.equal(f.fileserver.diagnostics().active, 0);
    assert.equal(req.listenerCount("aborted"), 0); assert.equal(await f.fileserver.start(), true);
  }
});

add("lifecycle:waiting-start-cannot-override-a-newer-stop-intent", async f => {
  const gate = deferred(); f.add("asset.bin", "bytes", { openGate: gate });
  const operation = f.fileserver.serveStatic(request(), new ResponseSink(), "/asset.bin");
  const stopping = f.fileserver.stop(), starting = f.fileserver.start();
  f.fileserver.beginStop(); gate.resolve(); await operation; await stopping;
  assert.equal(await starting, false); assert.equal(f.fileserver.diagnostics().accepting, false);
  assert.equal(await f.fileserver.start(), true); await direct(f);
});

add("lifecycle:failed-close-is-not-released-by-fd-minus-one-or-late-events", async f => {
  f.add("asset.bin", "bytes", { earlyCloseSignal: true, closeError: codeError("EIO_CLOSE") });
  const req = request("/asset.bin", { method: "HEAD" }), res = new ResponseSink();
  await assert.rejects(f.fileserver.serveStatic(req, res, "/asset.bin"), { code: "EIO_CLOSE" });
  assert.equal(res.statusCode, 200); assert.equal(f.handles[0].fd, -1); assert.equal(f.active(), 1);
  assert.deepEqual(f.fileserver.diagnostics(), { accepting: true, active: 1, closeFailed: 1 });
  await assert.rejects(f.fileserver.start(), { code: "STATIC_FILE_STOP_INCOMPLETE" });
  await assert.rejects(f.fileserver.stop(), { code: "STATIC_FILE_STOP_INCOMPLETE" });
  f.handles[0].physicallyClosed = true;
  assert.equal(f.fileserver.diagnostics().active, 1, "an unverifiable later event must not silently repair a failed native close");
  await assert.rejects(f.fileserver.start(), { code: "STATIC_FILE_STOP_INCOMPLETE" });
  assert.equal(req.listenerCount("aborted"), 0);
});

add("native-close:actual-node-head-and-autoclose-failure-retain-unknown-owner", async () => {
  const filename = fileURLToPath(import.meta.url);
  for (const method of ["HEAD", "GET"]) {
    let opened, nativeHandle, nativeClose, physicalFd;
    const fileserver = staticModule.createStaticFileServer({
      publicDir: path.dirname(filename), mimeTypes: { ".mjs": "text/javascript" }, normalizeExt: value => path.extname(value),
      notFound(res) { res.writeHead(404); res.end(); }, stopTimeoutMs: 20,
      async openFile(target, flags) {
        assert.equal(target, filename); opened = await fs.promises.open(target, flags); physicalFd = opened.fd;
        const key = Object.getOwnPropertySymbols(opened).find(value => String(value) === "Symbol(kHandle)");
        assert(key, "native-close proof requires this Node runtime's actual FileHandle");
        nativeHandle = opened[key]; nativeClose = nativeHandle.close.bind(nativeHandle);
        Object.defineProperty(nativeHandle, "close", { configurable: true, value: () => Promise.reject(codeError("EIO_CLOSE")) });
        return opened;
      }
    });
    const req = request(`/${path.basename(filename)}`, { method }), res = new ResponseSink();
    try {
      await assert.rejects(fileserver.serveStatic(req, res, `/${path.basename(filename)}`), { code: "EIO_CLOSE" });
      assert.equal(res.statusCode, 200); assert.equal(opened.fd, -1);
      assert.equal(fs.fstatSync(physicalFd).isFile(), true, "JS close notification has not closed the actual descriptor");
      if (method === "GET") assert.deepEqual(res.body, fs.readFileSync(filename));
      assert.deepEqual(fileserver.diagnostics(), { accepting: true, active: 1, closeFailed: 1 });
      await assert.rejects(opened.close(), { code: "EIO_CLOSE" }, "a second JS close cannot hide the first failure");
      await assert.rejects(fileserver.start(), { code: "STATIC_FILE_STOP_INCOMPLETE" });
      await assert.rejects(fileserver.stop(), { code: "STATIC_FILE_STOP_INCOMPLETE" });
      await assert.rejects(fileserver.start(), { code: "STATIC_FILE_STOP_INCOMPLETE" });
      assert.equal(req.listenerCount("aborted"), 0);
    } finally {
      if (nativeHandle) { delete nativeHandle.close; await nativeClose(); }
      if (physicalFd !== undefined) assert.throws(() => fs.fstatSync(physicalFd), { code: "EBADF" });
    }
  }
});

add("actual-host:finished-plain-gzip-brotli-body-cannot-hide-held-file-close", async () => {
  const filename = fileURLToPath(import.meta.url), expected = fs.readFileSync(filename);
  for (const encoding of ["", "gzip", "br"]) {
    const closeGate = deferred(), destroying = deferred(); let opened, physicalFd, serving, servingSettled = false;
    const fileserver = staticModule.createStaticFileServer({
      publicDir: path.dirname(filename), mimeTypes: { ".js": "text/javascript" }, normalizeExt: () => ".js", stopTimeoutMs: 20,
      notFound(res) { res.writeHead(404); res.end(); },
      async openFile(target, flags) {
        assert.equal(target, filename); opened = await fs.promises.open(target, flags); physicalFd = opened.fd;
        const create = opened.createReadStream.bind(opened);
        opened.createReadStream = options => {
          const source = create(options), destroy = source._destroy.bind(source);
          source._destroy = (error, done) => { destroying.resolve(); closeGate.promise.then(() => destroy(error, done), done); };
          return source;
        };
        return opened;
      }
    });
    const exits = [], errors = [], processRef = Object.assign(new EventEmitter(), { exit: code => exits.push(code) });
    const host = createServerHost({
      host: "127.0.0.1", port: 0, processRef, networkInterfaces: () => ({}),
      getLibraryState: () => ({ availableRoots: [], missingRoots: [] }), logger: { log() {}, error(...args) { errors.push(args); } },
      requestHandler(req, res) {
        serving = fileserver.serveStatic(req, res, `/${path.basename(filename)}`);
        serving.then(() => { servingSettled = true; }, error => { servingSettled = true; errors.push(error); });
      },
      beginStop: withoutStaticLifecycle ? () => {} : fileserver.beginStop,
      stop: withoutStaticLifecycle ? () => {} : fileserver.stop
    });
    try {
      host.listen(); await once(host.server, "listening");
      const response = await rawHttp(host.server.address().port, `/${path.basename(filename)}`, { headers: { "accept-encoding": encoding } });
      await destroying.promise;
      assert.equal(response.status, 200);
      const body = encoding === "gzip" ? gunzipSync(response.body) : encoding === "br" ? brotliDecompressSync(response.body) : response.body;
      assert.deepEqual(body, expected); assert.equal(servingSettled, false);
      assert.equal(fs.fstatSync(physicalFd).isFile(), true); assert.equal(fileserver.diagnostics().active, 1);
      await host.shutdown("controlled-fixture");
      assert.deepEqual(exits, [1], "HTTP completion must not let the host report clean shutdown before physical file close");
      assert(errors.some(args => Array.isArray(args) && args.some(error => error?.code === "STATIC_FILE_STOP_INCOMPLETE")));
      assert.equal(fileserver.diagnostics().active, 1); assert.equal(fs.fstatSync(physicalFd).isFile(), true);
      closeGate.resolve(); await serving;
      assert.throws(() => fs.fstatSync(physicalFd), { code: "EBADF" }); assert.equal(fileserver.diagnostics().active, 0);
      assert.equal(await fileserver.start(), true); await fileserver.stop();
    } finally {
      closeGate.resolve(); if (serving) await serving.catch(() => {});
      host.server.closeAllConnections(); if (host.server.listening) await new Promise(resolve => host.server.close(resolve));
      if (opened && opened.fd !== -1) await opened.close();
    }
  }
});

export async function runStaticFileLifecycleFixture({ caseName = "" } = {}) {
  const selected = cases.filter(test => !caseName || test.name === caseName); assert(selected.length, `unknown case: ${caseName}`);
  for (const test of selected) {
    const f = virtualFs(), restore = f.installLegacyFs();
    try { await test.run(f); console.log(`static-file-lifecycle: PASS ${test.name}`); }
    finally { restore(); f.dispose(); }
  }
  assert.doesNotMatch(realStaticSource, /(?:existsSync|statSync|openSync)\(/, "production static opener must not perform synchronous metadata I/O");
  console.log(`static-file-lifecycle: ${selected.length} cases PASS`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const caseName = process.argv.find(arg => arg.startsWith("--case="))?.slice(7) || "";
  await runStaticFileLifecycleFixture({ caseName });
}
