import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { EventEmitter } from "node:events";
import { Readable, Writable } from "node:stream";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createFileServer } from "../src/platform/server/file-server.js";
import { createImageReaderCacheService } from "../src/platform/server/image-reader-cache-service.js";

// Actual product and module configuration branch, with controlled runtime/cache
// dependencies. No services, databases or media are opened. The one real handle
// below belongs to this verifier's source and is closed before the case returns.
const ownPath = fileURLToPath(import.meta.url);
const productPath = path.resolve("src/modules/short-videos/server/product.js");
const modulePath = path.resolve("src/modules/short-videos/module.js");
const productSource = fs.readFileSync(productPath, "utf8");
const moduleSource = fs.readFileSync(modulePath, "utf8");
const originalOpen = fs.promises.open;
const selected = process.argv.find(value => value.startsWith("--case="))?.slice(7) || "";
const withoutFileLifecycle = process.argv.includes("--without-file-lifecycle");
const withoutGenerationGuard = process.argv.includes("--without-generation-guard");
const unexpected = [];
const onUnexpected = error => unexpected.push(error);
process.on("unhandledRejection", onUnexpected);
let checks = 0, realm = 0;
const tick = () => new Promise(resolve => setImmediate(resolve));
function deferred(open = false) {
  let resolve;
  const promise = new Promise(yes => { resolve = yes; });
  if (open) resolve();
  return { promise, resolve };
}
async function until(condition, label) {
  const deadline = Date.now() + 2000;
  while (!condition() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 1));
  assert.ok(condition(), label);
}
const outcome = promise => Promise.resolve(promise).then(value => ({ value }), error => ({ error }));
function absoluteImports(source, from) {
  return source.replace(/from "(\.[^"]+)"/g, (_, value) => `from ${JSON.stringify(pathToFileURL(path.resolve(path.dirname(from), value)).href)}`);
}
async function fixture({ cache, realHandle = false, holdOpen = false, holdBody = false, holdClose = false, closeError = false, stopTimeoutMs = 40 } = {}) {
  const key = `__shortVideoProductLifecycle${++realm}`;
  const state = {
    runtimeStarts: 0, runtimeStops: 0, cacheStarts: 0, cacheStops: 0, cacheBegins: 0, timers: 0,
    fileStarts: 0, runtimeResult: true, runtimeStartGate: null, cacheStartGate: null, cacheStopGate: null,
    runtimeStartError: null, cacheStartError: null, runtimeStopError: null, cacheStopError: null,
    opens: 0, stats: 0, readers: 0, closes: 0, handles: [], tasks: [], dependencies: null
  };
  const gates = { open: deferred(!holdOpen), body: deferred(!holdBody), close: deferred(!holdClose) };
  const runtime = {
    async start() { state.runtimeStarts++; if (state.runtimeStartGate) await state.runtimeStartGate.promise; if (state.runtimeStartError) throw state.runtimeStartError; return state.runtimeResult; },
    async stop() { state.runtimeStops++; if (state.runtimeStopError) throw state.runtimeStopError; },
    routeMedia(req, res, url) {
      const file = { path: realHandle ? ownPath : "/controlled/synthetic.bin", ext: ".bin" };
      const task = url.pathname === "/download"
        ? state.dependencies.serveDownloadFile(req, res, file, "合成资料.bin")
        : state.dependencies.mediaStreamService.serveVideo(req, res, file);
      state.tasks.push(task);
      return task;
    }
  };
  const controlledCache = cache || {
    async start() { state.cacheStarts++; if (state.cacheStartGate) await state.cacheStartGate.promise; if (state.cacheStartError) throw state.cacheStartError; },
    beginStop() { state.cacheBegins++; },
    async stop() { state.cacheStops++; if (state.cacheStopGate) await state.cacheStopGate.promise; if (state.cacheStopError) throw state.cacheStopError; },
    startCleanupTimer() { state.timers++; }
  };
  const filesystem = { readFileSync() { throw new Error("Controlled settings have no file"); } };
  globalThis[key] = {
    filesystem,
    makeRuntime(dependencies) { state.dependencies = dependencies; return runtime; },
    makeCache() { return controlledCache; },
    makeFiles(options) {
      const files = createFileServer({ ...options, stopTimeoutMs });
      const start = files.start;
      files.start = (...args) => { state.fileStarts++; return start(...args); };
      if (withoutFileLifecycle) { files.beginStop = () => {}; files.stop = async () => {}; }
      return files;
    }
  };
  let source = productSource.replace('import fs from "node:fs";', `const fs = globalThis[${JSON.stringify(key)}].filesystem;`);
  for (const [name, field] of [["createShortVideosRuntime", "makeRuntime"], ["createImageReaderCacheService", "makeCache"], ["createFileServer", "makeFiles"]]) {
    const pattern = new RegExp(`import \\{ ${name} \\} from "[^"]+";`);
    assert.ok(pattern.test(source), `${name}: actual dependency must be present`);
    source = source.replace(pattern, `const ${name} = (...args) => globalThis[${JSON.stringify(key)}].${field}(...args);`);
  }
  if (withoutGenerationGuard) {
    source = source.replace(/if \(intent !== lifecycleGeneration\) throw stoppedError\(\);/g, "")
      .replace(/if \(intent !== lifecycleGeneration \|\| (filesStarted|runtimeStarted) === false\)/g, "if ($1 === false)");
  }
  const namespace = await import(`data:text/javascript;base64,${Buffer.from(absoluteImports(source, productPath)).toString("base64")}`);
  globalThis[key].productFactory = namespace.createShortVideoProduct;
  let entry = moduleSource.replace(/import \{ createShortVideoProduct \} from "\.\/server\/product\.js";/,
    `const createShortVideoProduct = (...args) => globalThis[${JSON.stringify(key)}].productFactory(...args);`);
  entry = entry.replace(/import \{ createShortVideosRuntime \} from "\.\/server\/runtime\.js";/,
    'const createShortVideosRuntime = () => { throw new Error("Config product branch required"); };');
  const { createModule } = await import(`data:text/javascript;base64,${Buffer.from(absoluteImports(entry, modulePath)).toString("base64")}`);
  const product = createModule({ moduleDeps: { shortVideos: { config: {
    SHORT_VIDEO_DB_PATH: "/controlled/unused.sqlite", APP_CONFIG_PATH: "/controlled/unused.json",
    SHORT_VIDEO_ROOTS: [], MIME_TYPES: { ".bin": "application/octet-stream", ".mjs": "text/javascript" }
  } } } });
  assert.ok(state.dependencies, "actual module config composition must construct product runtime");
  fs.promises.open = async (filePath, flags) => {
    assert.equal(filePath, realHandle ? ownPath : "/controlled/synthetic.bin");
    state.opens++;
    let handle;
    if (realHandle) {
      handle = await originalOpen(filePath, flags);
      const stat = handle.stat.bind(handle), close = handle.close.bind(handle);
      handle.stat = async () => { state.stats++; return stat(); };
      handle.close = async () => { state.closes++; await gates.close.promise; return close(); };
    } else {
      handle = new EventEmitter(); handle.fd = 1000 + state.opens;
      handle.stat = async () => { state.stats++; return { size: 5, mtimeMs: 1, isFile: () => true }; };
      let closing;
      handle.close = () => {
        state.closes++;
        if (!closing) closing = (async () => {
          await gates.close.promise;
          if (closeError) throw Object.assign(new Error("Controlled close failed"), { code: "EIO_CLOSE" });
          handle.fd = -1; handle.emit("close");
        })();
        return closing;
      };
      handle.physicalClose = () => { handle.fd = -1; handle.emit("close"); };
      handle.createReadStream = () => {
        state.readers++; let sent = false;
        return new Readable({
          read() { if (sent) return; sent = true; gates.body.promise.then(() => { if (!this.destroyed) { this.push(Buffer.from("IMAGE")); this.push(null); } }); },
          destroy(error, callback) { handle.close().then(() => callback(error), callback); }
        });
      };
    }
    state.handles.push(handle);
    await gates.open.promise;
    return handle;
  };
  function request(mode = "range", method = "GET") {
    const req = new EventEmitter(); req.method = method; req.headers = {}; req.aborted = false;
    const chunks = [];
    const res = new Writable({ write(chunk, encoding, done) { chunks.push(Buffer.from(chunk)); done(); } });
    res.req = req; res.headersSent = false;
    res.writeHead = (status, headers) => { res.statusCode = status; res.headers = headers; res.headersSent = true; };
    res.on("error", () => {});
    let done = false;
    const task = Promise.resolve(product.routeMedia(req, res, new URL(`http://127.0.0.1/${mode}`))).finally(() => { done = true; });
    task.catch(() => {});
    return { req, res, task, done: () => done, body: () => Buffer.concat(chunks).toString() };
  }
  return { product, state, gates, request,
    async close() {
      for (const gate of Object.values(gates)) gate.resolve();
      state.runtimeStartGate?.resolve();
      state.cacheStartGate?.resolve(); state.cacheStopGate?.resolve();
      state.runtimeStopError = null; state.cacheStopError = null;
      await Promise.allSettled(state.tasks);
      if (closeError) for (const handle of state.handles) handle.physicalClose?.();
      await outcome(product.stop());
      fs.promises.open = originalOpen;
      delete globalThis[key];
      for (const handle of state.handles) assert.equal(handle.fd, -1, "private descriptor must be physically closed");
    }
  };
}
async function run(name, verify) {
  if (selected && !name.includes(selected)) return;
  await verify(); checks++; console.log(`PASS ${name}`);
}
try {
  for (const mode of ["range", "download"]) await run(`${mode}-stop-shared-promise-and-physical-close`, async () => {
    const f = await fixture({ holdBody: true, holdClose: true });
    try {
      await f.product.start(); const r = f.request(mode);
      await until(() => f.state.readers === 1, "controlled stream begins");
      const stopping = f.product.beginStop(); assert.equal(f.product.stop(), stopping, "beginStop and stop must share full drain");
      let stopped = false; stopping.then(() => { stopped = true; });
      await tick();
      assert.equal(f.product.fileServerDiagnostics().accepting, false);
      assert.equal(f.product.fileServerDiagnostics().active, 1); assert.equal(r.res.destroyed, true);
      assert.equal(f.state.runtimeStops, 1); assert.equal(f.state.cacheStops, 1);
      assert.equal(stopped, false); assert.equal(r.done(), false);
      f.gates.close.resolve(); await stopping; await r.task;
      assert.equal(f.product.fileServerDiagnostics().active, 0); assert.equal(stopped, true);
      await f.product.start(); const fresh = f.request(mode, "HEAD"); await fresh.task;
      assert.equal(fresh.res.statusCode, 200); assert.equal(fresh.res.headers["Content-Length"], 5);
      if (mode === "download") assert.match(fresh.res.headers["Content-Disposition"], /^attachment;/);
    } finally { await f.close(); }
  });
  await run("inactive-file-requests-have-no-open", async () => {
    const f = await fixture();
    try {
      await f.product.start(); await f.product.stop();
      for (const mode of ["range", "download"]) { const r = f.request(mode); await r.task; assert.equal(r.res.statusCode, 503); }
      assert.equal(f.state.opens, 0); assert.equal(f.product.fileServerDiagnostics().active, 0);
    } finally { await f.close(); }
  });
  await run("ignored-open-stop-retains-late-descriptor", async () => {
    const f = await fixture({ holdOpen: true, holdClose: true });
    try {
      await f.product.start(); const r = f.request(); await until(() => f.state.opens === 1, "open captured");
      const stopping = f.product.beginStop(); let done = false; stopping.then(() => { done = true; });
      await tick(); assert.equal(r.res.destroyed, true); assert.equal(done, false); assert.equal(f.state.stats, 0);
      f.gates.open.resolve(); await until(() => f.state.closes > 0, "late handle close starts");
      assert.equal(f.state.stats, 0); assert.equal(f.state.readers, 0); assert.equal(f.product.fileServerDiagnostics().active, 1);
      f.gates.close.resolve(); await stopping; await r.task;
      assert.equal(f.product.fileServerDiagnostics().active, 0);
    } finally { await f.close(); }
  });
  await run("mixed-errors-wait-for-all-resources-and-recover", async () => {
    const f = await fixture({ holdClose: true });
    try {
      await f.product.start(); const r = f.request(); await until(() => f.state.closes > 0, "body finished but close held");
      f.state.runtimeStopError = Object.assign(new Error("runtime stop"), { code: "CONTROLLED_RUNTIME_STOP" });
      f.state.cacheStopError = Object.assign(new Error("cache stop"), { code: "CONTROLLED_CACHE_STOP" });
      f.state.cacheStopGate = deferred();
      const stopped = outcome(f.product.stop()); let done = false; stopped.then(() => { done = true; });
      await tick(); assert.equal(f.state.runtimeStops, 1); assert.equal(f.state.cacheStops, 1); assert.equal(done, false);
      f.gates.close.resolve(); await r.task;
      await tick(); assert.equal(done, false, "settled file and runtime errors cannot bypass deferred cache stop");
      f.state.cacheStopGate.resolve();
      const error = (await stopped).error; assert.ok(error instanceof AggregateError);
      assert.deepEqual(error.errors.map(value => value.code).sort(), ["CONTROLLED_CACHE_STOP", "CONTROLLED_RUNTIME_STOP"]);
      assert.equal(f.product.fileServerDiagnostics().active, 0);
      f.state.runtimeStopError = null; f.state.cacheStopError = null;
      await f.product.start(); assert.equal(f.state.runtimeStarts, 2); assert.equal(f.state.timers, 2);
    } finally { await f.close(); }
  });
  await run("failed-close-fences-restart-and-reports-all-errors", async () => {
    const f = await fixture({ closeError: true });
    try {
      await f.product.start(); const r = f.request(); assert.equal((await outcome(r.task)).error.code, "EIO_CLOSE");
      f.state.runtimeStopError = Object.assign(new Error("runtime stop"), { code: "CONTROLLED_RUNTIME_STOP" });
      f.state.cacheStopError = Object.assign(new Error("cache stop"), { code: "CONTROLLED_CACHE_STOP" });
      const error = (await outcome(f.product.stop())).error; assert.ok(error instanceof AggregateError);
      assert.deepEqual(error.errors.map(value => value.code).sort(), ["CONTROLLED_CACHE_STOP", "CONTROLLED_RUNTIME_STOP", "FILE_SERVER_STOP_INCOMPLETE"]);
      assert.equal(f.product.fileServerDiagnostics().active, 1); assert.equal(f.product.fileServerDiagnostics().closeFailed, 1);
      await assert.rejects(f.product.start(), value => value.code === "FILE_SERVER_STOP_INCOMPLETE");
      assert.equal(f.state.runtimeStarts, 1); assert.equal(f.state.timers, 1);
      f.state.handles[0].physicalClose(); f.state.runtimeStopError = null; f.state.cacheStopError = null;
      await assert.rejects(f.product.start(), value => value.code === "FILE_SERVER_STOP_INCOMPLETE");
      assert.equal(f.state.runtimeStarts, 1, "fd=-1/close event alone cannot confirm a rejected native close");
      assert.equal(f.product.fileServerDiagnostics().active, 1);
    } finally { await f.close(); }
  });
  await run("pending-start-before-new-stop-cannot-reopen-files", async () => {
    const f = await fixture({ holdBody: true, holdClose: true });
    try {
      await f.product.start(); const r = f.request(); await until(() => f.state.readers === 1, "active stream");
      const stop = f.product.stop(); const start = outcome(f.product.start()); f.product.beginStop();
      f.gates.close.resolve(); await stop; await r.task;
      assert.equal((await start).error?.code, "SHORT_VIDEO_PRODUCT_STOPPED");
      assert.equal(f.state.fileStarts, 1, "old start must check product generation before reopening file service");
      assert.equal(f.product.fileServerDiagnostics().accepting, false); assert.equal(f.state.timers, 1);
      await f.product.start(); assert.equal(f.state.timers, 2);
    } finally { await f.close(); }
  });
  await run("new-stop-during-runtime-start-does-not-start-cache", async () => {
    const f = await fixture();
    try {
      f.state.runtimeStartGate = deferred();
      const start = outcome(f.product.start()); await until(() => f.state.runtimeStarts === 1, "runtime start pending");
      await f.product.stop(); f.state.runtimeStartGate.resolve();
      assert.equal((await start).error?.code, "SHORT_VIDEO_PRODUCT_STOPPED");
      assert.equal(f.state.cacheStarts, 0); assert.equal(f.state.timers, 0); assert.equal(f.product.fileServerDiagnostics().accepting, false);
      f.state.runtimeStartGate = null; await f.product.start(); assert.equal(f.state.timers, 1);
    } finally { await f.close(); }
  });
  await run("runtime-start-false-does-not-start-cache-timer", async () => {
    const f = await fixture();
    try {
      f.state.runtimeResult = false;
      await assert.rejects(f.product.start(), error => error.code === "SHORT_VIDEO_PRODUCT_STOPPED");
      assert.equal(f.state.cacheStarts, 0); assert.equal(f.state.timers, 0);
      await f.product.stop(); f.state.runtimeResult = true; await f.product.start(); assert.equal(f.state.timers, 1);
    } finally { await f.close(); }
  });
  await run("partial-start-errors-get-a-fresh-physical-stop", async () => {
    for (const phase of ["runtime", "cache"]) {
      const f = await fixture({ holdClose: true });
      try {
        await f.product.start(); await f.product.stop();
        const gate = deferred(), failure = Object.assign(new Error(`controlled ${phase} startup`), { code: "CONTROLLED_START_FAILURE" });
        if (phase === "runtime") { f.state.runtimeStartGate = gate; f.state.runtimeStartError = failure; }
        else { f.state.cacheStartGate = gate; f.state.cacheStartError = failure; }
        const starting = outcome(f.product.start());
        await until(() => phase === "runtime" ? f.state.runtimeStarts === 2 : f.state.cacheStarts === 2, `${phase} partial startup`);
        const r = f.request("download", "HEAD");
        await until(() => f.state.closes > 0, "partial startup admitted descriptor awaiting close");
        gate.resolve(); assert.equal((await starting).error, failure);
        assert.equal(f.product.fileServerDiagnostics().accepting, false); assert.equal(f.state.timers, 1);
        const stopping = f.product.stop(); let done = false; stopping.then(() => { done = true; });
        await tick(); assert.equal(done, false, "old resolved stop cannot skip the new physical owner");
        assert.equal(f.state.runtimeStops, 2); assert.equal(f.state.cacheStops, 2);
        f.gates.close.resolve(); await r.task; await stopping;
        assert.equal(f.product.fileServerDiagnostics().active, 0);
      } finally { await f.close(); }
    }
  });
  await run("retired-cache-stop-error-recovers-after-physical-drain", async () => {
    const held = deferred(); let calls = 0;
    const cache = createImageReaderCacheService({ rootDir: "/controlled/cache", cleanupIntervalMs: 60000, getMaxBytes: () => 100, stopTimeoutMs: 20, warn() {},
      fsOps: { async lstat() { if (++calls === 1) await held.promise; return null; } } });
    const f = await fixture({ cache });
    try {
      await f.product.start(); await until(() => cache.diagnostics().scanning, "actual cache inventory held");
      await assert.rejects(f.product.stop(), error => error.code === "IMAGE_READER_CACHE_STOP_INCOMPLETE");
      await assert.rejects(f.product.start(), error => error.code === "IMAGE_READER_CACHE_STOP_INCOMPLETE");
      held.resolve(); await until(() => !cache.diagnostics().scanning, "actual cache owner retired");
      await f.product.start(); assert.equal(cache.diagnostics().accepting, true); assert.equal(cache.diagnostics().intervalActive, true);
    } finally { held.resolve(); await f.close(); }
  });
  await run("actual-node-filehandle-head-stop-waits-for-close", async () => {
    const f = await fixture({ realHandle: true, holdClose: true, stopTimeoutMs: 200 });
    try {
      await f.product.start(); const r = f.request("download", "HEAD");
      await until(() => r.res.writableFinished && f.state.closes > 0, "real head finished and descriptor close held");
      const handle = f.state.handles[0]; assert.ok(handle.fd >= 0); assert.equal(r.done(), false);
      const stopping = f.product.beginStop(); let done = false; stopping.then(() => { done = true; });
      await tick(); assert.equal(done, false); assert.equal(f.product.fileServerDiagnostics().active, 1);
      f.gates.close.resolve(); await r.task; await stopping;
      assert.equal(r.res.statusCode, 200); assert.equal(r.body(), ""); assert.equal(handle.fd, -1);
      assert.equal(f.product.fileServerDiagnostics().active, 0);
    } finally { await f.close(); }
  });
  assert.ok(checks > 0, "selected case must exist");
  assert.deepEqual(unexpected, [], "no unhandled asynchronous errors");
  console.log(`Short-video product lifecycle: ${checks} cases PASS`);
} finally {
  fs.promises.open = originalOpen;
  process.off("unhandledRejection", onUnexpected);
}
