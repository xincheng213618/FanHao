import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { EventEmitter, getEventListeners, once } from "node:events";
import fs from "node:fs";
import http from "node:http";
import { Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { createFileServer as currentFactory } from "../src/platform/server/file-server.js";
import { createServerHost } from "../src/platform/server/server-host.js";

// Controlled descriptors and a private HTTP server only. The one real file
// read below is this verifier's source, never a user's media or database.
const sourcePath = fileURLToPath(import.meta.url);
const realOpen = fs.promises.open;
const realOpenSync = fs.openSync, realFstatSync = fs.fstatSync;
const realCreateReadStream = fs.createReadStream, realCloseSync = fs.closeSync;
const bytes = Buffer.from("synthetic file bytes");
const legacy = process.argv.includes("--legacy");
const withoutLifecycleHooks = process.argv.includes("--without-lifecycle-hooks");
let createFileServer = currentFactory;
if (legacy) {
  const source = execFileSync("git", ["show", "HEAD:src/platform/server/file-server.js"], { encoding: "utf8" });
  assert.ok(source.includes("fs.openSync(filePath") && source.includes("fs.fstatSync(fileDescriptor)"), "legacy control needs the actual preceding synchronous source");
  ({ createFileServer } = await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`));
}
const files = createFileServer({
  defaultChunkBytes: 4,
  mimeTypes: { ".txt": "text/plain" }, normalizeExt: () => ".txt",
  ...(legacy ? { safeStat: filePath => fs.statSync(filePath) } : {}),
  notFound(res) { res.writeHead(404); res.end(); }
});
let checks = 0;
const unhandled = [];
const onUnhandled = error => unhandled.push(error);
process.on("unhandledRejection", onUnhandled);
process.on("uncaughtException", onUnhandled);

try {
  for (const mode of ["range", "inline", "download"]) {
    await run(`${mode}: yielding open/stat and physical stream/handle lifetime`, async () => {
      const h = harness({ holdOpen: true, holdStat: true, holdStreamClose: true, holdClose: true });
      const req = request(), res = response(req);
      let settled = false;
      const returned = invoke(mode, req, res);
      const task = Promise.resolve(returned).finally(() => { settled = true; });
      try {
        await tick();
        assert.equal(res.status, undefined, "held asynchronous metadata must not publish headers");
        assert.equal(typeof returned?.then, "function", "serving must return a promise through descriptor closure");
        assert.equal(h.count.opens, 1, "serving must use asynchronous FileHandle opening");
        assert.equal(h.count.stats, 0);
        assert.equal(res.status, undefined, "held open must not publish headers");
        assert.equal(settled, false);
        h.open.resolve(); await tick();
        assert.equal(h.count.stats, 1);
        assert.equal(res.status, undefined);
        h.stat.resolve(); await tick();
        assert.equal(res.status, 200);
        assert.equal(res.writableFinished, true);
        assert.equal(settled, false, "response finish is not descriptor close");
        assert.equal(h.count.physicalCloses, 0);
        h.streamClose.resolve(); await tick();
        assert.equal(settled, false, "stream destruction must wait for its physical descriptor");
        h.close.resolve(); await task;
        assert.equal(h.count.physicalCloses, 1);
        assert.equal(h.handle.fd, -1);
        assert.deepEqual(res.body(), bytes);
        assertDetached(req, res);
      } finally { await h.release(task); }
    });
  }

  for (const mode of ["inline", "download", "range"]) {
    for (const stage of ["open", "stat", "body"]) {
      await run(`${mode}: ignored ${stage} cancellation retains owner and no late headers`, async () => {
        const h = harness({ holdOpen: stage === "open", holdStat: stage === "stat", holdBody: stage === "body", holdClose: true });
        const req = request(), res = response(req);
        let settled = false;
        const task = invoke(mode, req, res).finally(() => { settled = true; });
        try {
          await tick();
          req.aborted = true; req.emit("aborted"); await tick();
          assert.equal(res.destroyed, true, "disconnect must close a pre-header response immediately");
          assert.equal(settled, false, "an ignored open/stat/close still owns its task");
          h.open.resolve(); h.stat.resolve(); h.body.resolve(); await tick();
          if (stage !== "body") assert.equal(res.status, undefined, "cancelled metadata must not produce late headers");
          if (stage === "open") assert.equal(h.count.stats, 0, "late open must not start a new stat");
          if (stage === "body") assert.equal(res.body().length, 0, "cancelled bodies must not emit late bytes");
          assert.equal(settled, false);
          h.close.resolve(); await task;
          assert.equal(h.count.physicalCloses, 1);
          assertDetached(req, res);
        } finally { await h.release(task); }
      });
    }
  }

  await run("pre-aborted requests/signals and ended responses start no filesystem work", async () => {
    const h = harness();
    try {
      for (const kind of ["request", "signal", "response"]) {
        const req = request(), res = response(req), controller = new AbortController();
        if (kind === "request") req.aborted = true;
        if (kind === "signal") controller.abort();
        if (kind === "response") { res.end(); await tick(); }
        await invoke("inline", req, res, {}, { signal: controller.signal });
        assert.equal(res.status, undefined);
        assertDetached(req, res, controller.signal);
      }
      assert.equal(h.count.opens, 0);
    } finally { await h.release(); }
  });

  await run("inline and ranged signal cancellation closes response before ignored metadata settles", async () => {
    for (const mode of ["inline", "range"]) {
      const h = harness({ holdStat: true, holdClose: true });
      const req = request(), res = response(req), controller = new AbortController();
      let settled = false;
      const task = invoke(mode, req, res, {}, { signal: controller.signal }).finally(() => { settled = true; });
      try {
        await tick(); controller.abort(); await tick();
        assert.equal(res.destroyed, true);
        assert.equal(settled, false);
        h.stat.resolve(); await tick();
        assert.equal(res.status, undefined);
        assert.equal(settled, false);
        h.close.resolve(); await task;
        assertDetached(req, res, controller.signal);
      } finally { await h.release(task); }
    }
  });

  await run("source/DB guards before opening and after held open/stat/validation", async () => {
    for (const mode of ["inline", "range"]) {
      for (const stage of ["initial", "open", "stat", "validate"]) {
        const h = harness({ holdOpen: stage === "open", holdStat: stage === "stat" });
        const req = request(), res = response(req), validation = deferred();
        let current = stage !== "initial";
        const options = { isCurrent: () => current, validateFile: stage === "validate" ? () => validation.promise : undefined };
        const file = mode === "range" ? { isCurrentSource: options.isCurrent } : {};
        if (mode === "range") delete options.isCurrent;
        const task = invoke(mode, req, res, file, options);
        try {
          await tick(); current = false;
          h.open.resolve(); h.stat.resolve(); validation.resolve();
          await task;
          assert.equal(res.status, 404);
          assert.equal(h.count.readers, 0);
          if (stage === "initial") assert.equal(h.count.opens, 0);
          if (stage === "open") assert.equal(h.count.stats, 0);
          if (stage !== "initial") assert.equal(h.count.physicalCloses, 1);
          assertDetached(req, res);
        } finally { validation.resolve(); await h.release(task); }
      }
    }
  });

  await run("async path validation failures propagate before headers and close the same handle", async () => {
    for (const statusCode of [403, 409]) {
      const h = harness({ holdClose: true });
      const req = request(), res = response(req);
      const error = Object.assign(new Error("controlled archive validation"), { statusCode });
      const task = invoke("inline", req, res, {}, { validateFile: async stat => {
        assert.equal(stat.size, bytes.length); await tick(); throw error;
      } });
      const rejected = assert.rejects(task, error);
      try {
        await tick(); assert.equal(res.status, undefined);
        assert.equal(h.count.readers, 0);
        h.close.resolve(); await rejected;
        assert.equal(h.count.physicalCloses, 1);
        assertDetached(req, res);
      } finally { await h.release(task); }
    }
  });

  await run("missing/not-file/default I/O errors stay 404; opt-in genuine I/O errors propagate", async () => {
    for (const config of [
      { openError: "ENOENT" }, { openError: "EIO" }, { statError: "EACCES" }, { notFile: true }
    ]) {
      const h = harness(config), req = request(), res = response(req);
      try {
        assert.equal(await invoke("inline", req, res), false);
        assert.equal(res.status, 404);
        assert.equal(h.count.readers, 0);
        assert.equal(h.count.physicalCloses, config.openError ? 0 : 1);
        assertDetached(req, res);
      } finally { await h.release(); }
    }
    for (const config of [{ openError: "EIO" }, { statError: "EIO" }]) {
      const h = harness(config), req = request(), res = response(req);
      try {
        await assert.rejects(invoke("inline", req, res, {}, { throwFileErrors: true }), { code: "EIO" });
        assert.equal(res.status, undefined);
        assertDetached(req, res);
      } finally { await h.release(); }
    }
    for (const config of [{ openError: "ENOENT" }, { statError: "ENOTDIR" }, { notFile: true }]) {
      const h = harness(config), req = request(), res = response(req);
      try {
        assert.equal(await invoke("inline", req, res, {}, { throwFileErrors: true }), false);
        assert.equal(res.status, 404);
      } finally { await h.release(); }
    }
  });

  await run("HEAD, empty, 416 and startup-prefix 503 still await descriptor closure", async () => {
    for (const [mode, method, headers, file, size, expected] of [
      ["inline", "HEAD", {}, {}, bytes.length, 200],
      ["download", "HEAD", {}, {}, bytes.length, 200],
      ["range", "HEAD", { range: "bytes=2-4" }, {}, bytes.length, 200],
      ["inline", "GET", {}, {}, 0, 200],
      ["range", "GET", { range: "bytes=99-" }, {}, bytes.length, 416],
      ["range", "GET", {}, { totalSize: bytes.length + 100 }, bytes.length, 503],
      ["range", "GET", { range: "bytes=40-50" }, { totalSize: bytes.length + 100 }, bytes.length, 503]
    ]) {
      const h = harness({ size, holdClose: true });
      const req = request(method, headers), res = response(req);
      let settled = false;
      const task = invoke(mode, req, res, file).finally(() => { settled = true; });
      try {
        await tick(); assert.equal(res.status, expected);
        assert.equal(res.body().length, 0);
        assert.equal(h.count.readers, 0);
        assert.equal(settled, false);
        h.close.resolve(); await task;
        assert.equal(h.count.physicalCloses, 1);
        assertDetached(req, res);
      } finally { await h.release(task); }
    }
  });

  await run("descriptor closure alone cannot finish a response still draining its final bytes", async () => {
    const h = harness(), req = request(), finishGate = deferred(), res = response(req, { finishGate });
    let settled = false;
    const task = invoke("download", req, res).finally(() => { settled = true; });
    try {
      await tick();
      assert.equal(h.count.physicalCloses, 1);
      assert.equal(res.writableEnded, true);
      assert.equal(res.writableFinished, false);
      assert.equal(settled, false, "the serving lifetime also includes the destination's final drain");
      finishGate.resolve(); await task;
      assert.equal(res.writableFinished, true);
      assertDetached(req, res);
    } finally { finishGate.resolve(); await h.release(task); }
  });

  await run("stream setup/read/response failures destroy partial replies and release handles/listeners", async () => {
    for (const config of [{ setupError: true }, { readError: true }, { writeError: true }, { prematureClose: true }]) {
      for (const mode of ["inline", "download", "range"]) {
        const h = harness(config), req = request(), res = response(req, config);
        try {
          await invoke(mode, req, res);
          assert.equal(res.status, 200);
          assert.equal(res.destroyed, true);
          assert.equal(res.writableFinished, false, "a failed Content-Length body must not be completed");
          assert.equal(h.count.physicalCloses, 1);
          assertDetached(req, res);
        } finally { await h.release(); }
      }
    }
  });

  await run("close rejection and synchronous header exceptions always detach owner listeners", async () => {
    for (const config of [{ closeError: true, size: 0 }, { headerError: true }]) {
      const h = harness(config), req = request(), res = response(req, config), controller = new AbortController();
      try {
        await assert.rejects(invoke("inline", req, res, {}, { signal: controller.signal }), { code: config.closeError ? "EIO_CLOSE" : "HEADER_FAILURE" });
        assertDetached(req, res, controller.signal);
      } finally { await h.release(); }
    }
  });

  await run("headers and bytes use the opened entity; range limits, validators and protected diagnostics survive", async () => {
    const h = harness(), req = request("GET", { range: "bytes=3-", "if-range": '"entity-v1"' }), res = response(req);
    try {
      await invoke("range", req, res, {
        totalSize: 100, entityTag: '"entity-v1"', maxRangeBytes: 3,
        responseHeaders: { ETag: '"wrong"', "Content-Length": 999, "X-Source": "kept" }
      });
      assert.equal(res.status, 206);
      assert.equal(res.headers["Content-Range"], "bytes 3-5/100");
      assert.equal(res.headers["Content-Length"], 3);
      assert.equal(res.headers.ETag, '"entity-v1"');
      assert.equal(res.headers["X-Source"], "kept");
      assert.deepEqual(res.body(), bytes.subarray(3, 6));
      assert.deepEqual(h.streamOptions, { start: 3, end: 5, autoClose: true, emitClose: true });
    } finally { await h.release(); }
  });

  await run("real default Node FileHandle streams source and closes idempotently", async () => {
    fs.promises.open = realOpen;
    let actual;
    fs.promises.open = async (...args) => { actual = await realOpen(...args); return actual; };
    const req = request(), res = response(req);
    try {
      assert.equal(await files.serveInlineFile(res, sourcePath, "text/javascript"), true);
      assert.equal(actual.fd, -1);
      await actual.close();
      assert.deepEqual(res.body(), fs.readFileSync(sourcePath));
      assertDetached(req, res);
    } finally { fs.promises.open = realOpen; }
  });

  await run("private HTTP stays responsive during 18 held opens and drains socket before late FD", verifyHttp);
  await run("file lifecycle rejects new work, drains normal owners and can start again", async () => {
    const service = makeService(), h = harness();
    try {
      assert.equal(await service.start(), true);
      const initialReq = request();
      assert.equal(await invoke("inline", initialReq, response(initialReq), {}, {}, service), true);
      assert.equal(service.diagnostics().active, 0);
      service.beginStop();
      const req = request(), res = response(req), opens = h.count.opens;
      assert.equal(await invoke("inline", req, res, {}, {}, service), false);
      assert.equal(res.status, 503); assert.equal(res.body().length, 0);
      assert.equal(h.count.opens, opens);
      await service.stop(); await service.stop();
      assert.equal(service.diagnostics().accepting, false);
      assert.equal(await service.start(), true);
    } finally { await h.release(); await service.stop(); }
  });
  for (const stage of ["open", "stat", "body", "stream-close", "handle-close"]) {
    await run(`bounded stop retains ignored ${stage} until physical settlement`, async () => {
      const service = makeService({ stopTimeoutMs: 20 });
      const h = harness({ holdOpen: stage === "open", holdStat: stage === "stat", holdBody: stage === "body", holdStreamClose: stage === "stream-close" || stage === "body", holdClose: stage === "handle-close", earlyCloseSignal: stage === "handle-close" });
      const req = request(), res = response(req);
      const task = invoke("inline", req, res, {}, {}, service);
      try {
        await tick();
        assert.equal(service.diagnostics().active, 1);
        if (stage === "handle-close") {
          assert.equal(h.handle.fd, -1);
          assert.equal(h.count.physicalCloses, 0, "JS close notification must precede our held native close");
        }
        const stopping = service.stop();
        assert.equal(service.stop(), stopping, "repeated stop must share the same physical drain");
        const stopped = assert.rejects(stopping, { code: "FILE_SERVER_STOP_INCOMPLETE" });
        await tick();
        if (!res.writableFinished) assert.equal(res.destroyed, true);
        const blockedReq = request(), blockedRes = response(blockedReq);
        await invoke("range", blockedReq, blockedRes, {}, {}, service);
        assert.equal(blockedRes.status, 503); assert.equal(h.count.opens, 1);
        await stopped;
        assert.equal(service.diagnostics().active, 1);
        await assert.rejects(service.start(), { code: "FILE_SERVER_STOP_INCOMPLETE" });
        await h.release(task);
        assert.equal(service.diagnostics().active, 0);
        assert.equal(await service.start(), true);
        assertDetached(req, res);
      } finally { await h.release(task); await service.stop(); }
    });
  }
  await run("waiting start cannot reopen after a newer beginStop intent", async () => {
    const service = makeService(), h = harness({ holdOpen: true });
    const req = request(), res = response(req), task = invoke("download", req, res, {}, {}, service);
    try {
      await tick();
      const stopping = service.stop(), staleStart = service.start();
      service.beginStop();
      await h.release(task); await stopping;
      assert.equal(await staleStart, false);
      assert.equal(service.diagnostics().accepting, false);
      assert.equal(await service.start(), true);
    } finally { await h.release(task); await service.stop(); }
  });
  await run("early JS fd/close flags cannot release a rejected native descriptor close", async () => {
    const service = makeService({ stopTimeoutMs: 20 }), h = harness({ closeError: true, earlyCloseSignal: true, size: 0 });
    const req = request(), res = response(req);
    try {
      await assert.rejects(invoke("inline", req, res, {}, {}, service), { code: "EIO_CLOSE" });
      assert.equal(service.diagnostics().active, 1);
      assert.equal(service.diagnostics().closeFailed, 1);
      await assert.rejects(service.start(), { code: "FILE_SERVER_STOP_INCOMPLETE" }, "an explicit restart must reject an unknown close even before stopping");
      await assert.rejects(service.stop(), { code: "FILE_SERVER_STOP_INCOMPLETE" });
      await assert.rejects(service.start(), { code: "FILE_SERVER_STOP_INCOMPLETE" });
      h.proveClose();
      assert.equal(service.diagnostics().active, 1, "an event is not the native close promise's successful completion");
      await assert.rejects(service.start(), { code: "FILE_SERVER_STOP_INCOMPLETE" });
      assertDetached(req, res);
    } finally { await h.release(); await assert.rejects(service.stop(), { code: "FILE_SERVER_STOP_INCOMPLETE" }); }
  });
  await run("actual Node native close failure cannot be hidden by autoClose or a second JS close", verifyNativeCloseFailure);
  await run("actual server host refuses clean shutdown while a real FileHandle close is held", verifyHost);
  await tick();
  assert.deepEqual(unhandled, [], "read/response errors must remain local to the serving request");
  assert.ok(checks > 0);
  console.log(`file-server-async: PASS (${checks} controlled/real HTTP groups)`);
} finally {
  fs.promises.open = realOpen;
  fs.openSync = realOpenSync; fs.fstatSync = realFstatSync;
  fs.createReadStream = realCreateReadStream; fs.closeSync = realCloseSync;
  process.off("unhandledRejection", onUnhandled);
  process.off("uncaughtException", onUnhandled);
}

function deferred(resolved = false) {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  if (resolved) resolve();
  return { promise, resolve };
}
function tick() { return new Promise(resolve => setImmediate(resolve)); }
async function run(name, fn) {
  if (withoutLifecycleHooks && !name.startsWith("actual server host")) return;
  await fn(); checks += 1; console.log(`PASS ${name}`);
}
function makeService(options = {}) {
  return createFileServer({ mimeTypes: { ".txt": "text/plain" }, normalizeExt: () => ".txt",
    notFound(res) { res.writeHead(404); res.end(); }, ...options });
}
function request(method = "GET", headers = {}) {
  return Object.assign(new EventEmitter(), { method, headers, aborted: false });
}
function response(req, config = {}) {
  const chunks = [];
  const res = new Writable({
    write(chunk, _encoding, done) {
      if (config.writeError) done(Object.assign(new Error("response failure"), { code: "EIO" }));
      else { chunks.push(Buffer.from(chunk)); done(); }
    },
    final(done) { if (config.finishGate) config.finishGate.promise.then(() => done()); else done(); }
  });
  res.req = req;
  res.writeHead = (status, headers = {}) => {
    if (config.headerError) throw Object.assign(new Error("bad response headers"), { code: "HEADER_FAILURE" });
    res.status = status; res.headers = headers; res.headersSent = true; return res;
  };
  res.body = () => Buffer.concat(chunks);
  return res;
}
function invoke(mode, req, res, extra = {}, options = {}, service = files) {
  const file = { path: sourcePath, ext: ".txt", ...extra };
  if (mode === "inline") return service.serveInlineFile(res, file.path, "text/plain", options);
  if (mode === "download") return service.serveDownloadFile(req, res, file, "合成资料.txt");
  return service.serveRangedFile(req, res, file, options);
}
function assertDetached(req, res, signal) {
  assert.equal(req.listenerCount("aborted"), 0);
  assert.equal(res.listenerCount("close"), 0);
  if (signal) assert.equal(getEventListeners(signal, "abort").length, 0);
}
function harness(config = {}) {
  const h = {
    count: { opens: 0, stats: 0, readers: 0, closes: 0, physicalCloses: 0 },
    open: deferred(!config.holdOpen), stat: deferred(!config.holdStat), body: deferred(!config.holdBody),
    streamClose: deferred(!config.holdStreamClose), close: deferred(!config.holdClose)
  };
  let closeTask;
  h.proveClose = () => {
    if (h.count.physicalCloses) return;
    h.count.physicalCloses += 1; h.handle.fd = -1; h.handle.emit("close");
  };
  h.handle = Object.assign(new EventEmitter(), {
    fd: 42,
    async stat() {
      h.count.stats += 1; await h.stat.promise;
      if (config.statError) throw Object.assign(new Error("controlled stat"), { code: config.statError });
      return { size: config.size ?? bytes.length, mtimeMs: 123456, isFile: () => !config.notFile };
    },
    close() {
      h.count.closes += 1;
      if (!closeTask) closeTask = (async () => {
        if (config.earlyCloseSignal) { h.handle.fd = -1; h.handle.emit("close"); }
        await h.close.promise;
        if (config.closeError) throw Object.assign(new Error("controlled close failure"), { code: "EIO_CLOSE" });
        h.proveClose();
      })();
      return closeTask;
    },
    createReadStream(options) {
      h.count.readers += 1; h.streamOptions = options;
      if (config.setupError) throw new Error("controlled stream constructor");
      let sent = false;
      const stream = new Readable({
        read() {
          if (sent) return; sent = true;
          h.body.promise.then(() => {
            if (this.destroyed) return;
            if (config.readError) this.destroy(Object.assign(new Error("controlled read"), { code: "EIO" }));
            else if (config.prematureClose) this.destroy();
            else { this.push(bytes.subarray(options.start || 0, (options.end ?? (bytes.length - 1)) + 1)); this.push(null); }
          });
        },
        destroy(error, done) {
          h.streamClose.promise.then(() => h.handle.close()).then(() => done(error), done);
        }
      });
      h.stream = stream;
      return stream;
    }
  });
  fs.promises.open = async () => {
    h.count.opens += 1; await h.open.promise;
    if (config.openError) throw Object.assign(new Error("controlled open"), { code: config.openError });
    return h.handle;
  };
  if (legacy) {
    // Run the actual old synchronous implementation entirely on controlled
    // descriptors. Its response still publishes 200 before our open gate.
    fs.openSync = (filePath, ...args) => filePath === sourcePath ? (h.count.opens += 1, 42) : realOpenSync(filePath, ...args);
    fs.fstatSync = (fd, ...args) => fd === 42
      ? (h.count.stats += 1, { size: bytes.length, mtimeMs: 123456, isFile: () => true }) : realFstatSync(fd, ...args);
    fs.createReadStream = (filePath, options = {}) => filePath === sourcePath || options.fd === 42
      ? h.handle.createReadStream({ autoClose: true, emitClose: true, ...options }) : realCreateReadStream(filePath, options);
    fs.closeSync = (fd, ...args) => fd === 42 ? h.handle.close().catch(() => {}) : realCloseSync(fd, ...args);
  }
  h.release = async task => {
    for (const gate of [h.open, h.stat, h.body, h.streamClose, h.close]) gate.resolve();
    if (task) await Promise.resolve(task).catch(() => {});
    if (h.handle.fd !== -1 && h.count.opens && !config.openError && !config.closeError) await h.handle.close();
    if (config.closeError) h.proveClose();
    fs.promises.open = realOpen;
    fs.openSync = realOpenSync; fs.fstatSync = realFstatSync;
    fs.createReadStream = realCreateReadStream; fs.closeSync = realCloseSync;
  };
  return h;
}

async function verifyHttp() {
  const heldOpen = deferred(), heldClose = deferred(), controllers = new Set(), tasks = new Set();
  let opens = 0, stats = 0, closed = 0;
  fs.promises.open = async () => {
    opens += 1; await heldOpen.promise;
    return {
      async stat() { stats += 1; return { size: bytes.length, mtimeMs: 1, isFile: () => true }; },
      createReadStream() { return Readable.from([bytes]); },
      async close() { await heldClose.promise; closed += 1; }
    };
  };
  const server = http.createServer((req, res) => {
    if (req.url === "/health") { res.end("healthy"); return; }
    const controller = new AbortController(); controllers.add(controller);
    let task;
    task = files.serveInlineFile(res, sourcePath, "text/plain", { signal: controller.signal })
      .finally(() => { controllers.delete(controller); tasks.delete(task); });
    tasks.add(task);
    task.catch(error => { if (!res.destroyed && !res.writableEnded) res.destroy(error); });
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const base = `http://127.0.0.1:${server.address().port}`;
  const requests = [];
  try {
    for (let i = 0; i < 18; i += 1) {
      const request = http.get(base + "/held");
      request.on("error", () => {}); requests.push(request);
    }
    for (let i = 0; i < 100 && opens < 18; i += 1) await new Promise(resolve => setTimeout(resolve, 2));
    assert.equal(opens, 18);
    const started = performance.now();
    assert.equal(await (await fetch(base + "/health")).text(), "healthy");
    const healthMs = performance.now() - started;
    assert.equal(stats, 0); assert.equal(tasks.size, 18);
    for (const controller of controllers) controller.abort();
    const httpClosed = new Promise(resolve => server.close(resolve));
    await httpClosed;
    assert.equal(tasks.size, 18, "closing sockets does not complete ignored filesystem owners");
    heldOpen.resolve(); await tick();
    assert.equal(stats, 0); assert.equal(closed, 0);
    assert.equal(tasks.size, 18);
    heldClose.resolve(); await Promise.all(tasks);
    assert.equal(closed, 18);
    console.log(`diagnostic private HTTP: 18 pending opens, health ${healthMs.toFixed(2)}ms; server socket drain before physical FD drain`);
  } finally {
    heldOpen.resolve(); heldClose.resolve();
    for (const controller of controllers) controller.abort();
    for (const request of requests) request.destroy();
    server.closeAllConnections();
    if (server.listening) await new Promise(resolve => server.close(resolve));
    await Promise.allSettled(tasks);
    fs.promises.open = realOpen;
  }
}

async function verifyHost() {
  const closeGate = deferred(), enteredClose = deferred(), service = makeService({ stopTimeoutMs: 20 });
  let handle, stream, serving;
  fs.promises.open = async (...args) => {
    handle = await realOpen(...args);
    const createReadStream = handle.createReadStream.bind(handle);
    handle.createReadStream = options => {
      stream = createReadStream(options);
      const destroy = stream._destroy.bind(stream);
      stream._destroy = (error, done) => {
        enteredClose.resolve(); closeGate.promise.then(() => destroy(error, done));
      };
      return stream;
    };
    return handle;
  };
  const exits = [], loggedErrors = [], processRef = new EventEmitter();
  processRef.exit = code => exits.push(code);
  const host = createServerHost({
    requestHandler(req, res) {
      serving = service.serveInlineFile(res, sourcePath, "text/javascript");
      serving.catch(error => { if (!res.destroyed && !res.writableEnded) res.destroy(error); });
    }, port: 0, host: "127.0.0.1", networkInterfaces: () => ({}),
    getLibraryState: () => ({ availableRoots: [], missingRoots: [] }),
    logger: { log() {}, error(_context, error) { loggedErrors.push(error); } }, processRef,
    // The negative control retains the actual host and actual file server;
    // only the previously absent lifecycle composition hooks are omitted.
    beginStop: () => { if (!withoutLifecycleHooks) service.beginStop(); },
    stop: () => withoutLifecycleHooks ? undefined : service.stop(), shutdownTimeoutMs: 1000
  });
  try {
    const server = host.listen(); await once(server, "listening");
    const result = await fetch(`http://127.0.0.1:${server.address().port}/source`);
    assert.equal(result.status, 200);
    assert.deepEqual(Buffer.from(await result.arrayBuffer()), fs.readFileSync(sourcePath));
    await enteredClose.promise;
    assert.equal(stream.closed, false);
    assert.ok(handle.fd >= 0, "a completed HTTP body still has an actual open descriptor");
    assert.equal(service.diagnostics().active, 1);
    await host.shutdown("private-file-lifecycle-fixture");
    assert.deepEqual(exits, [1], "server host must not report clean exit while a real descriptor is still closing");
    assert.equal(loggedErrors.at(-1).code, "FILE_SERVER_STOP_INCOMPLETE");
    assert.equal(service.diagnostics().active, 1);
    assert.ok(handle.fd >= 0);
    closeGate.resolve(); await serving;
    assert.equal(handle.fd, -1);
    assert.equal(service.diagnostics().active, 0);
    assert.equal(await service.start(), true);
    await service.stop();
  } finally {
    closeGate.resolve();
    await serving?.catch(() => {});
    host.server.closeAllConnections();
    if (host.server.listening) await new Promise(resolve => host.server.close(resolve));
    if (handle?.fd !== -1) await handle?.close();
    fs.promises.open = realOpen;
    await service.stop();
  }
}

async function verifyNativeCloseFailure() {
  for (const method of ["HEAD", "GET"]) {
    const service = makeService({ stopTimeoutMs: 20 });
    let handle, nativeHandle, nativeClose, physicalFd;
    fs.promises.open = async (...args) => {
      handle = await realOpen(...args); physicalFd = handle.fd;
      const key = Object.getOwnPropertySymbols(handle).find(key => String(key) === "Symbol(kHandle)");
      assert.ok(key, "native-close proof needs this Node runtime's actual FileHandle");
      nativeHandle = handle[key]; nativeClose = nativeHandle.close.bind(nativeHandle);
      Object.defineProperty(nativeHandle, "close", { configurable: true,
        value: () => Promise.reject(Object.assign(new Error("controlled native close failure"), { code: "EIO_CLOSE" })) });
      return handle;
    };
    const req = request(method), res = response(req);
    try {
      await assert.rejects(service.serveInlineFile(res, sourcePath), { code: "EIO_CLOSE" });
      assert.equal(res.status, 200);
      assert.equal(handle.fd, -1, "actual Node sets its JS fd before native close completion");
      assert.equal(fs.fstatSync(physicalFd).isFile(), true, "the actual OS descriptor is still open despite the JS closed flag");
      assert.equal(service.diagnostics().active, 1);
      assert.equal(service.diagnostics().closeFailed, 1);
      await assert.rejects(service.start(), { code: "FILE_SERVER_STOP_INCOMPLETE" }, "explicit restart must reject the actual native failure before stop");
      await assert.rejects(handle.close(), { code: "EIO_CLOSE" }, "a later idempotent-looking JS close must retain the first native failure");
      await assert.rejects(service.stop(), { code: "FILE_SERVER_STOP_INCOMPLETE" });
      await assert.rejects(service.start(), { code: "FILE_SERVER_STOP_INCOMPLETE" });
      assertDetached(req, res);
    } finally {
      if (nativeHandle) delete nativeHandle.close;
      if (nativeClose) await nativeClose();
      if (physicalFd !== undefined) assert.throws(() => fs.fstatSync(physicalFd), { code: "EBADF" });
      fs.promises.open = realOpen;
    }
  }
}
