import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { Readable, Writable } from "node:stream";
import { createFileServer } from "../src/platform/server/file-server.js";
import { createRequestHandler } from "../src/platform/server/http-app.js";
import { readJsonFile } from "../src/platform/server/request-io.js";
import { sendHtml, sendJson, sendText } from "../src/platform/server/responses.js";
import { createAndroidUpdateRuntime } from "../src/modules/system/server/android-update/runtime.js";

// Private APK bytes and loopback server only; never reads a published update.
const root = fs.mkdtempSync(path.join(os.tmpdir(), "fanhao-apk-streams-"));
const channel = path.join(root, "debug");
const apk = path.join(channel, "测试 更新.apk");
const manifest = path.join(channel, "latest.json");
const replacement = path.join(channel, "old.apk");
const bytes = Buffer.alloc(128 * 1024, 0x61);
const original = { open: fs.promises.open, exists: fs.existsSync, stat: fs.statSync, statAsync: fs.promises.stat, readSync: fs.readFileSync };
const readers = new Set();
const unhandled = [];
const onUnhandled = error => unhandled.push(error);
process.on("uncaughtException", onUnhandled);
process.on("unhandledRejection", onUnhandled);
let opened = 0, closed = 0, mode = "normal", closeGate = null, lastReader, metadataGate;
let files, server;
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};

try {
  fs.mkdirSync(channel);
  fs.writeFileSync(apk, bytes);
  fs.writeFileSync(manifest, JSON.stringify({ apkFile: path.basename(apk), versionCode: 1 }));
  const notFound = res => { res.writeHead(404); res.end(); };
  files = createFileServer({ mimeTypes: {}, normalizeExt: file => path.extname(file), notFound });
  const runtime = createAndroidUpdateRuntime({
    clampInteger: value => Number(value || 0), normalizeExt: file => path.extname(file),
    notFound, port: 0, updateDir: root, readJsonFile, serveWholeFile: files.serveWholeFile,
    safeChildPath(parent, name) {
      const target = path.resolve(parent, name);
      return path.dirname(target) === path.resolve(parent) ? target : null;
    },
    sendJson
  });
  fs.readFileSync = (...args) => {
    assert.notEqual(args[0], manifest, "update requests must read the manifest asynchronously");
    return original.readSync(...args);
  };
  fs.existsSync = file => {
    assert.notEqual(file, apk, "APK requests must not block on synchronous file metadata");
    return original.exists(file);
  };
  fs.statSync = (...args) => {
    assert.notEqual(args[0], apk, "APK requests must not block on synchronous file metadata");
    return original.stat(...args);
  };
  fs.promises.stat = async (...args) => {
    if (args[0] === apk && metadataGate) {
      const gate = metadataGate;
      gate.entered.resolve();
      await gate.release.promise;
    }
    return original.statAsync(...args);
  };
  fs.promises.open = async (...args) => {
    const handle = await original.open(...args);
    if (args[0] !== apk) return handle;
    opened++;
    const close = handle.close.bind(handle);
    const createReadStream = handle.createReadStream.bind(handle);
    const gate = closeGate;
    handle.close = async () => { if (gate) await gate.promise; await close(); closed++; };
    handle.createReadStream = options => {
      let reader;
      if (mode === "normal") reader = createReadStream(options);
      else if (mode === "error") reader = new Readable({
        read() { this.destroy(Object.assign(new Error("controlled APK read failure"), { code: "EIO" })); },
        destroy(error, done) { handle.close().then(() => done(error), done); }
      });
      else reader = new Readable({
        read() { if (!this.sent) { this.sent = true; this.push(Buffer.from("a")); } },
        destroy(error, done) { handle.close().then(() => done(error), done); }
      });
      readers.add(reader);
      reader.once("close", () => readers.delete(reader));
      lastReader = reader;
      return reader;
    };
    return handle;
  };
  const route = `/api/android/update/apk/debug/${encodeURIComponent(path.basename(apk))}`;
  const handler = createRequestHandler({
    attachAccessAnalytics() {}, attachAccessLogger() {}, requestCorsOrigin: () => "",
    requestAuthState: () => ({ allowed: false }), routeAuth: async () => false,
    routeApi: runtime.routeApi, renderAndroidUpdatePage: runtime.renderPage,
    sendLoginRequired: (_req, res) => sendText(res, 401, "Login required"),
    sendHtml, sendJson, sendText, logError() {}
  });
  server = http.createServer((req, res) => {
    if (req.url === "/health") { res.end("healthy"); return; }
    return handler(req, res);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = `http://127.0.0.1:${server.address().port}`;
  const updateUrl = base + "/api/android/update?channel=debug";
  const directoryApk = path.join(channel, "directory.apk");
  fs.mkdirSync(directoryApk);
  try {
    fs.writeFileSync(manifest, JSON.stringify({ apkFile: path.basename(directoryApk), versionCode: 1 }));
    const metadata = await fetch(updateUrl);
    assert.equal(metadata.status, 200);
    const update = await metadata.json();
    assert.equal(update.available, false, "a directory must not be advertised as a downloadable update");
    assert.equal(update.downloadUrl, "");
    assert.match(await (await fetch(base + "/android-update")).text(), /暂无可下载版本/);
    assert.equal((await fetch(base + "/api/android/update/apk/debug/directory.apk")).status, 404);
    fs.writeFileSync(manifest, JSON.stringify({ apkFile: `../${path.basename(apk)}`, versionCode: 1 }));
    assert.equal((await (await fetch(updateUrl)).json()).available, false, "a malformed manifest name must match download authorization");
    assert.equal((await fetch(base + route)).status, 404);
  } finally {
    fs.rmdirSync(directoryApk);
    fs.writeFileSync(manifest, JSON.stringify({ apkFile: path.basename(apk), versionCode: 1 }));
  }
  assert.equal((await fetch(base + "/api/android/update/apk/debug/%ZZ")).status, 404);
  const latest = await (await fetch(updateUrl)).json();
  assert.equal(latest.available, true);
  assert.equal(latest.downloadUrl, base + route);
  assert.equal(latest.size, bytes.length);
  assert.match(await (await fetch(base + "/android-update")).text(), /下载最新版 APK/);
  assert.equal((await (await fetch(updateUrl + "&currentVersionCode=1")).json()).available, false);

  metadataGate = { entered: deferred(), release: deferred() };
  const withdrawing = fetch(updateUrl);
  await Promise.race([
    metadataGate.entered.promise,
    withdrawing.then(() => { throw new Error("update response completed before checking the APK"); })
  ]);
  assert.equal(await (await fetch(base + "/health")).text(), "healthy");
  assert.equal(path.dirname(replacement), channel);
  fs.renameSync(apk, replacement);
  metadataGate.release.resolve();
  const withdrawn = await withdrawing;
  assert.equal(withdrawn.status, 200);
  assert.equal((await withdrawn.json()).downloadUrl, "", "a package withdrawn during metadata I/O becomes unavailable");
  fs.renameSync(replacement, apk);
  metadataGate = null;

  const get = await fetch(base + route);
  assert.equal(get.status, 200);
  assert.deepEqual(Buffer.from(await get.arrayBuffer()), bytes);
  assert.equal(get.headers.get("content-type"), "application/vnd.android.package-archive");
  assert.equal(get.headers.get("cache-control"), "no-store");
  assert.match(get.headers.get("content-disposition"), /filename\*=UTF-8''%E6%B5%8B/);
  const head = await fetch(base + route, { method: "HEAD" });
  assert.equal(head.status, 200);
  assert.equal(head.headers.get("content-length"), String(bytes.length));
  assert.equal(await head.text(), "");
  assert.equal((await fetch(base + "/api/android/update/apk/debug/unpublished.apk")).status, 404);

  // Headers and content retain the same open descriptor across replacement.
  const response = capture(() => {
    assert.equal(path.dirname(replacement), channel);
    fs.renameSync(apk, replacement);
    fs.writeFileSync(apk, "replacement bytes");
  });
  await runtime.routeApi(request("GET"), response, new URL(route, base));
  assert.equal(response.headers["Content-Length"], bytes.length);
  assert.deepEqual(response.body(), bytes);
  fs.unlinkSync(replacement);
  fs.writeFileSync(apk, bytes);

  // The route must await physical closure, not just response finish.
  closeGate = deferred();
  const held = capture();
  let settled = false;
  const pending = runtime.routeApi(request("HEAD"), held, new URL(route, base)).finally(() => { settled = true; });
  await once(held, "finish");
  await tick();
  assert.equal(settled, false, "APK routes must retain their asynchronous stream owner");
  assert.ok(files.diagnostics().active > 0);
  closeGate.resolve();
  await pending;
  closeGate = null;

  mode = "error";
  await assert.rejects(async () => { const result = await fetch(base + route); await result.arrayBuffer(); },
    "a disk failure must abort the truncated response");
  if (!lastReader.closed) await once(lastReader, "close");
  assert.equal(await (await fetch(base + "/health")).text(), "healthy");

  mode = "slow";
  await new Promise((resolve, reject) => {
    const req = http.get(base + route, res => {
      res.once("data", () => { res.destroy(); resolve(); });
      res.on("error", () => {});
    });
    req.on("error", reject);
  });
  if (!lastReader.closed) await once(lastReader, "close");
  assert.equal(lastReader.destroyed, true, "cancelled downloads must retire the APK reader");

  const before = opened;
  const aborted = request("GET"); aborted.aborted = true;
  await runtime.routeApi(aborted, capture(), new URL(route, base));
  assert.equal(opened, before, "already cancelled requests must not open the APK");

  // Shared file-server shutdown must include APK downloads.
  const stoppedResponse = capture();
  const started = new Promise(resolve => stoppedResponse.once("first-byte", resolve));
  const stopDownload = runtime.routeApi(request("GET"), stoppedResponse, new URL(route, base));
  await started;
  files.beginStop();
  await Promise.all([files.stop(), stopDownload]);
  assert.equal(stoppedResponse.destroyed, true);
  assert.equal(files.diagnostics().active, 0);
  assert.equal(opened, closed, "every opened APK descriptor must be physically closed");
  await tick();
  assert.deepEqual(unhandled, []);
  console.log("android-update-streams: ok (GET/HEAD, published-name guard, async metadata, file identity, awaited close, read error, cancellation, shutdown)");
} finally {
  metadataGate?.release.resolve();
  closeGate?.resolve();
  for (const reader of readers) reader.destroy();
  await files?.stop();
  if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  fs.promises.open = original.open;
  fs.existsSync = original.exists;
  fs.statSync = original.stat;
  fs.promises.stat = original.statAsync;
  fs.readFileSync = original.readSync;
  process.off("uncaughtException", onUnhandled);
  process.off("unhandledRejection", onUnhandled);
  for (const file of [apk, manifest, replacement]) {
    assert.equal(path.dirname(file), channel);
    if (fs.existsSync(file)) fs.unlinkSync(file);
  }
  fs.rmdirSync(channel);
  assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
  fs.rmdirSync(root);
}

function request(method) { return Object.assign(new EventEmitter(), { method, headers: {}, aborted: false }); }
function capture(beforeHeaders = () => {}) {
  const chunks = [];
  const res = new Writable({ write(chunk, _encoding, done) { chunks.push(Buffer.from(chunk)); this.emit("first-byte"); done(); } });
  res.writeHead = (status, headers) => { res.status = status; res.headers = headers; res.headersSent = true; beforeHeaders(); };
  res.body = () => Buffer.concat(chunks);
  return res;
}
