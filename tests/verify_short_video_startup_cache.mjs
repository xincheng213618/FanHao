import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import vm from "node:vm";

// Actual startup queue/copy/runtime lifecycle over real temporary files,
// FileHandles and pipeline streams. Metadata, native open/close and rename can
// settle independently; unrelated DB/workers/processes are boundary doubles.
const source = fs.readFileSync(new URL("../src/modules/short-videos/server/runtime.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");
function take(name) {
  const start = new RegExp(`^  (?:async )?function ${name}\\(`, "m").exec(source)?.index;
  assert(start != null, name); return source.slice(start, source.indexOf("\n  }", start) + 4);
}
const globals = source.slice(source.indexOf("  const videoCacheQueue ="), source.indexOf("  const smoothVideoQueue ="));
const implementation = source.slice(source.indexOf("  function tryQueueStartupVideoCache("), source.indexOf("  function sortAndScheduleSmoothVideoQueue("));
assert(globals && implementation);
const names = ["startupVideoCacheDescriptor", "safeStat", "hashText", "safeFilePart", "stopVideoCacheQueue",
  "stopDownloadManagerSync", "startDownloadManagerSync", "runtimeStartStillCurrent"];
const pendingLimit = vm.runInNewContext(/^const SHORT_VIDEO_STARTUP_CACHE_PENDING_LIMIT = ([^;]+);/m.exec(source)[1]);
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "fanhao-startup-cache-"));
let sequence = 0, checks = 0, nativeOpens = 0, nativeReaders = 0, nativeWriters = 0;
const tick = () => new Promise(resolve => setImmediate(resolve));
function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
async function bounded(promise, label) {
  let timeout;
  try { return await Promise.race([promise, new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error(`timed out: ${label}`)), 1500); })]); }
  finally { clearTimeout(timeout); }
}

function fixture({ stage = "", closeFailure = false, rollbackFailure = false } = {}) {
  const root = path.join(tempRoot, String(sequence++)); fs.mkdirSync(root);
  const catalog = new Map(), handles = [], readers = [], writers = [], retired = [], timers = new Map(), calls = [];
  const reached = deferred(), mainGate = deferred(), readerCloseGate = deferred(), closeReached = deferred(), otherStop = deferred();
  let timerId = 0, held = false, sourceReaderHeld = false, closed = false, stopRequested = false, holdOtherStop = false;
  const original = Buffer.from("ORIGINAL-startup-bytes"), createdDescriptors = [];
  function add(id) {
    const filePath = path.join(root, `${id}.mp4`); fs.writeFileSync(filePath, original);
    const stat = fs.statSync(filePath), file = { id, path: filePath, type: "video", ext: ".mp4", size: stat.size, cacheVersion: Math.floor(stat.mtimeMs) };
    catalog.set(id, file); return file;
  }
  const file = add("A");
  const hit = async point => {
    if (stage !== point || held) return;
    held = true; reached.resolve(); await mainGate.promise;
  };
  function wrapReader(reader, options) {
    nativeReaders++;
    readers.push({ stream: reader, options });
    if (stage === "copy" && !sourceReaderHeld) {
      sourceReaderHeld = true;
      const read = reader._read.bind(reader), destroy = reader._destroy.bind(reader);
      reader._read = size => {
        reached.resolve();
        mainGate.promise.then(() => { if (!reader.destroyed) read(size); });
      };
      reader._destroy = (error, done) => { closeReached.resolve(); readerCloseGate.promise.then(() => destroy(error, done)); };
    }
    return reader;
  }
  const filesystem = { ...fs, promises: { ...fs.promises,
    async open(filePath, ...args) {
      const handle = await fs.promises.open(filePath, ...args), nativeClose = handle.close.bind(handle), stat = handle.stat.bind(handle);
      nativeOpens++;
      const record = { handle, nativeClose, closes: 0, stats: 0 }; handles.push(record); calls.push(["open", filePath]);
      const create = handle.createReadStream.bind(handle);
      handle.createReadStream = options => wrapReader(create(options), options);
      handle.stat = async (...statArgs) => { record.stats++; const value = await stat(...statArgs); await hit("stat"); return value; };
      let closing;
      handle.close = () => closing ||= (async () => {
        closeReached.resolve(); await hit("close");
        if (closeFailure) throw Object.assign(new Error("controlled native close failure"), { code: "STARTUP_CLOSE_FAILED" });
        await nativeClose(); record.closes++; calls.push(["fd-closed", filePath]);
      })();
      await hit("open"); return handle;
    },
    async rename(from, to) { await fs.promises.rename(from, to); await hit("rename"); },
    async rm(target, ...args) {
      if (rollbackFailure && stopRequested && createdDescriptors.some(descriptor => descriptor.cachePath === target)) {
        throw Object.assign(new Error("controlled rollback failure"), { code: "STARTUP_ROLLBACK_FAILED" });
      }
      return fs.promises.rm(target, ...args);
    }
  },
    createReadStream: (...args) => wrapReader(fs.createReadStream(...args), args[1]),
    createWriteStream(...args) { const stream = fs.createWriteStream(...args); nativeWriters++; writers.push(stream); return stream; }
  };
  const context = vm.createContext({
    fs: filesystem, path, crypto, pipeline, process: { pid: process.pid }, AbortController,
    Date: { now: () => 1000 }, SHORT_VIDEO_STARTUP_CACHE_BYTES: 4, SHORT_VIDEO_STARTUP_CACHE_PENDING_LIMIT: pendingLimit,
    console: { warn() {}, log() {} },
    setTimeout(callback, delay) { const id = ++timerId; timers.set(id, { callback, delay }); return id; }, clearTimeout: id => timers.delete(id),
    store: { videoFile: id => catalog.has(id) ? { ...catalog.get(id) } : null,
      beginClose: async () => true, close() { closed = true; calls.push(["store-close"]); return true; },
      recoverDeleteJobs: async () => { closed = false; calls.push(["store-open"]); return { pending: 0, active: 0 }; } },
    sharedCache: { rootDir: path.join(root, "cache"), touch: target => calls.push(["touch", target, stopRequested]), scheduleCleanup: () => calls.push(["cleanup", stopRequested]) },
    runtimeStarted: true, runtimeDesiredStarted: true, runtimeLifecycleGeneration: 0, runtimeStartPromise: null, runtimeStopPromise: null,
    runtimeTestHooks: {}, imageAccepting: true, smoothPlaybackAccepting: true, smoothVideoExecutions: new Set(),
    beginStopImageRequests: async () => {}, beginStopSmoothPlaybackRequests: async () => {}, stopSmoothVideoQueue: async () => {},
    downloadManagerSync: { start() {}, stop: () => holdOtherStop ? otherStop.promise : Promise.resolve() }, stopListServices: async () => {},
    catalogWorker: { reopen() {} }, smoothWarmupWorker: { reopen() {} }, watchWriter: { start: async () => {} }, autoSmoothWarmup: false
  });
  vm.runInContext(`${globals}\n${implementation}\n${names.map(take).join("\n")}\nglobalThis.api = { queueStartupVideoCache, runVideoCacheQueue, stopVideoCacheQueue, stopDownloadManagerSync, startDownloadManagerSync,
    descriptor: startupVideoCacheDescriptor, state: () => ({ active: videoCacheActive, activeJob: videoCacheActiveJob, accepting: videoCacheAccepting, jobs: [...videoCacheJobs.values()], queued: [...videoCacheQueue], executions: videoCacheExecutions.size }),
    replaceOwner(job) { videoCacheJobs.set(job.key, job); } };`, context);
  function descriptor(id = "A") {
    const value = context.api.descriptor(id, catalog.get(id));
    if (!createdDescriptors.some(item => item.cachePath === value.cachePath)) createdDescriptors.push(value);
    return value;
  }
  const queue = (id = "A", options = {}) => { descriptor(id); return context.api.queueStartupVideoCache(id, options); };
  const run = () => {
    if (timers.size) {
      const [id, timer] = [...timers.entries()][0]; timers.delete(id); return timer.callback();
    }
    return context.api.runVideoCacheQueue();
  };
  return { root, file, original, catalog, handles, readers, writers, calls, timers, reached, closeReached, context,
    api: context.api, add, queue, run, descriptor, state: context.api.state,
    get closed() { return closed; },
    release() { mainGate.resolve(); readerCloseGate.resolve(); }, releaseMain: mainGate.resolve, releaseReaderClose: readerCloseGate.resolve,
    stop() { stopRequested = true; return context.api.stopDownloadManagerSync(); },
    holdOtherStop() { holdOtherStop = true; }, releaseOtherStop: otherStop.resolve,
    replaceSource() {
      const target = `${file.path}.retired`; fs.renameSync(file.path, target); retired.push(target);
      fs.writeFileSync(file.path, Buffer.alloc(file.size, 0x78));
      const previous = fs.statSync(target); fs.utimesSync(file.path, previous.atimeMs / 1000, previous.mtimeMs / 1000);
    },
    async dispose() {
      mainGate.resolve(); readerCloseGate.resolve(); otherStop.resolve();
      await context.api.stopDownloadManagerSync().catch(() => {});
      for (const record of handles) if (record.handle.fd >= 0) await record.nativeClose();
      for (const descriptor of createdDescriptors) {
        if (!fs.existsSync(descriptor.cacheDir)) continue;
        assert.equal(path.dirname(descriptor.cacheDir), path.join(root, "cache", "short-videos"));
        for (const name of fs.readdirSync(descriptor.cacheDir)) {
          const target = path.join(descriptor.cacheDir, name); assert.equal(path.dirname(path.resolve(target)), descriptor.cacheDir);
          if (fs.existsSync(target)) fs.unlinkSync(target);
        }
      }
      for (const target of [...catalog.values()].map(item => item.path).concat(retired)) { assert.equal(path.dirname(path.resolve(target)), root); if (fs.existsSync(target)) fs.unlinkSync(target); }
      for (const directory of [path.join(root, "cache", "short-videos", "startup"), path.join(root, "cache", "short-videos"), path.join(root, "cache"), root]) {
        const relative = path.relative(tempRoot, directory); assert(!relative.startsWith("..") && !path.isAbsolute(relative));
        if (fs.existsSync(directory)) fs.rmdirSync(directory);
      }
    }
  };
}
async function scenario(name, run) {
  await run(); checks++; console.log(`PASS ${name}`);
}
function assertNoDescriptors(f) {
  for (const record of f.handles) { assert.equal(record.handle.fd, -1); assert.equal(record.closes, 1); }
  f.readers.forEach(({ stream }) => assert.equal(stream.closed, true));
  f.writers.forEach(stream => assert.equal(stream.closed, true));
}

try {
  await scenario("successful copy uses a real shared FileHandle and exact prefix", async () => {
    const f = fixture();
    try {
      f.queue(); await bounded(f.run(), "successful copy");
      assert.deepEqual(fs.readFileSync(f.descriptor().cachePath), f.original.subarray(0, 4));
      assert.equal(f.handles.length, 1); assert.equal(f.readers.length, 1); assert.equal(f.writers.length, 1);
      assert.deepEqual({ ...f.readers[0].options }, { start: 0, end: 3, autoClose: false, emitClose: true });
      assertNoDescriptors(f); assert.equal(f.state().executions, 0); assert.equal(f.state().active, false);
      const opened = f.handles.length; assert.equal(f.queue().state, "cached"); assert.equal(f.handles.length, opened);
    } finally { await f.dispose(); }
  });

  for (const stage of ["open", "stat", "copy", "rename", "close"]) {
    await scenario(`stop drains held ${stage} and forbids stale publication`, async () => {
      const f = fixture({ stage });
      let execution;
      try {
        f.queue(); execution = f.run(); await bounded(f.reached.promise, `${stage} reached`);
        const touches = f.calls.filter(call => call[0] === "touch").length;
        let stopped = false; const stopping = f.stop().then(() => { stopped = true; }); await tick();
        assert.equal(stopped, false, `${stage}: stop cannot finish while actual filesystem work remains pending`);
        assert.equal(f.closed, false); assert.equal(f.state().executions, 1);
        const fd = f.handles[0].handle.fd; assert.ok(fd >= 0); assert.equal(fs.fstatSync(fd).isFile(), true);
        if (stage === "copy") { await bounded(f.closeReached.promise, "source destroy started"); assert.equal(f.readers[0].stream.closed, false); }
        assert.equal(f.queue().state, "stopped", "a stopped queue rejects new background work");
        f.release(); await bounded(Promise.all([execution, stopping]), `${stage} drain`);
        assert.equal(f.closed, true); assert.equal(f.state().executions, 0); assert.equal(f.state().active, false);
        assert.equal(f.calls.filter(call => call[0] === "touch").length, touches, "a cancelled continuation cannot touch/publish after stop");
        if (stage !== "close") assert.equal(fs.existsSync(f.descriptor().cachePath), false);
        assertNoDescriptors(f);
        if (stage === "open" || stage === "stat") assert.equal(f.readers.length, 0, "late metadata cannot start new source reads");
      } finally { f.release(); await execution?.catch(() => {}); await f.dispose(); }
    });
  }

  await scenario("stop/start waits for physical copy before reusing the same key", async () => {
    const f = fixture({ stage: "copy" }); let old;
    try {
      f.queue(); old = f.run(); await bounded(f.reached.promise, "copy reached");
      const stopping = f.stop(), starting = f.api.startDownloadManagerSync(); await tick();
      assert.equal(f.context.runtimeStarted, false); assert.equal(f.closed, false); assert.equal(f.state().accepting, false);
      f.release(); await bounded(Promise.all([old, stopping, starting]), "copy restart");
      assert.equal(f.state().accepting, true); assert.equal(f.context.runtimeStarted, true);
      assert.equal(f.queue().state, "queued"); await bounded(f.run(), "new same-key copy");
      assert.deepEqual(fs.readFileSync(f.descriptor().cachePath), f.original.subarray(0, 4)); assertNoDescriptors(f);
      assert.equal(f.state().jobs.length, 0); assert.equal(f.state().executions, 0);
    } finally { f.release(); await old?.catch(() => {}); await f.dispose(); }
  });

  await scenario("an obsolete finally cannot delete a replacement same-key owner", async () => {
    const f = fixture({ stage: "copy" }); let execution;
    try {
      f.queue(); execution = f.run(); await bounded(f.reached.promise, "copy reached");
      const old = f.state().activeJob, replacement = { ...old, active: false, controller: new AbortController() };
      f.api.replaceOwner(replacement); f.release(); await bounded(execution, "obsolete owner drain");
      assert.equal(f.state().jobs[0], replacement); assert.equal(fs.existsSync(f.descriptor().cachePath), false); assertNoDescriptors(f);
    } finally { f.release(); await execution?.catch(() => {}); await f.dispose(); }
  });

  for (const change of ["mtime", "same-size-replacement", "after-rename"]) {
    await scenario(`rejects stale source ${change}`, async () => {
      const f = fixture({ stage: change === "after-rename" ? "rename" : "copy" }); let execution;
      try {
        f.queue(); execution = f.run(); await bounded(f.reached.promise, "source mutation reached");
        if (change === "mtime") { const value = fs.statSync(f.file.path).mtimeMs + 10; fs.utimesSync(f.file.path, value / 1000, value / 1000); }
        else f.replaceSource();
        f.release(); await bounded(execution, "source mutation rejected");
        assert.equal(fs.existsSync(f.descriptor().cachePath), false); assert.equal(f.calls.filter(call => call[0] === "touch").length, 0);
        assertNoDescriptors(f);
      } finally { f.release(); await execution?.catch(() => {}); await f.dispose(); }
    });
  }

  for (const failure of ["close", "rollback"]) {
    await scenario(`${failure} failure cannot claim clean stop or restart`, async () => {
      const f = fixture({ stage: failure === "rollback" ? "rename" : "", closeFailure: failure === "close", rollbackFailure: failure === "rollback" });
      const unhandled = [], onUnhandled = error => unhandled.push(error); process.on("unhandledRejection", onUnhandled);
      let execution;
      try {
        f.holdOtherStop(); f.queue(); execution = f.run();
        if (failure === "rollback") await bounded(f.reached.promise, "rollback reached"); else await bounded(execution, "failed close");
        const errorCode = failure === "close" ? "STARTUP_CLOSE_FAILED" : "STARTUP_ROLLBACK_FAILED";
        const stopping = assert.rejects(f.stop(), { code: errorCode });
        f.release(); await bounded(execution, "failure settled"); await tick(); await tick();
        assert.equal(unhandled.length, 0, "an early drain rejection must be handled while another stop service still waits");
        assert.equal(f.closed, false); assert.equal(f.state().executions, 1);
        if (failure === "close") assert.equal(fs.fstatSync(f.handles[0].handle.fd).isFile(), true, "the simulated native failure keeps the actual OS descriptor open");
        f.releaseOtherStop(); await bounded(stopping, "failed stop propagated");
        await assert.rejects(f.api.startDownloadManagerSync(), { code: errorCode }); assert.equal(f.closed, false);
      } finally { f.release(); f.releaseOtherStop(); await execution?.catch(() => {}); await f.dispose(); process.off("unhandledRejection", onUnhandled); }
    });
  }

  await scenario("pending budget, priority and same-key promotion remain bounded", async () => {
    const f = fixture();
    try {
      for (let i = 0; i < 8; i++) { const id = `background-${i}`; f.add(id); f.queue(id, { kind: "background" }); }
      assert.equal(f.state().queued.length, pendingLimit); assert.equal(f.state().jobs.length, pendingLimit);
      assert.deepEqual(Array.from(f.state().queued, job => job.id), Array.from({ length: 6 }, (_, i) => `background-${i + 2}`));
      f.queue("A", { kind: "current" }); assert.equal(f.state().queued.length, pendingLimit);
      await bounded(f.run(), "priority copy"); assert.equal(f.calls.find(call => call[0] === "open")[1], f.file.path);
      const promoted = f.state().jobs.find(job => job.id === "background-7"); f.queue("background-7", { kind: "current" });
      assert.equal(f.state().jobs.find(job => job.id === "background-7"), promoted);
      await bounded(f.run(), "promoted copy"); assert.equal(f.calls.filter(call => call[0] === "open")[1][1], f.catalog.get("background-7").path);
      assertNoDescriptors(f);
    } finally { await f.dispose(); }
  });

  await scenario("new current work does not abort the active speculative copy", async () => {
    const f = fixture({ stage: "copy" }); let execution;
    try {
      f.queue("A", { kind: "background" }); execution = f.run(); await bounded(f.reached.promise, "active speculative copy");
      const old = f.state().activeJob;
      for (let i = 0; i < 7; i++) { const id = `queued-${i}`; f.add(id); f.queue(id, { kind: "background" }); }
      const current = f.add("current"); f.queue(current.id, { kind: "current" });
      assert.equal(old.controller.signal.aborted, false); assert.equal(f.state().activeJob, old); assert.equal(f.state().queued.length, pendingLimit);
      f.release(); await bounded(execution, "active speculative completes"); await bounded(f.run(), "latest current follows");
      assert.equal(f.calls.filter(call => call[0] === "open")[1][1], current.path); assertNoDescriptors(f);
    } finally { f.release(); await execution?.catch(() => {}); await f.dispose(); }
  });

  await scenario("current storms stay bounded and future current work does not block ready background", async () => {
    const storm = fixture();
    try {
      for (let i = 0; i < 8; i++) { const id = `current-${i}`; storm.add(id); storm.queue(id, { kind: "current" }); }
      assert.equal(storm.state().queued.length, pendingLimit); assert.equal(storm.state().jobs.length, pendingLimit);
      assert.deepEqual(Array.from(storm.state().queued, job => job.id), Array.from({ length: 6 }, (_, i) => `current-${i + 2}`));
      storm.queue("A", { kind: "background" });
      assert.equal(storm.state().queued.length, pendingLimit); assert.equal(storm.state().jobs.some(job => job.id === "A"), false);
      await bounded(storm.run(), "oldest retained current");
      assert.equal(storm.calls.find(call => call[0] === "open")[1], storm.catalog.get("current-2").path); assertNoDescriptors(storm);
    } finally { await storm.dispose(); }
    const ready = fixture();
    try {
      ready.add("future"); ready.queue("future", { kind: "current", delayMs: 3000 }); ready.queue("A", { kind: "background" });
      await bounded(ready.run(), "eligible background before delayed current");
      assert.equal(ready.calls.find(call => call[0] === "open")[1], ready.file.path);
      assert.deepEqual(Array.from(ready.state().queued, job => job.id), ["future"]); assertNoDescriptors(ready);
    } finally { await ready.dispose(); }
  });

  await scenario("stop between final validation and its caller cannot accept published bytes", async () => {
    const f = fixture(); let stopping, injected = false;
    try {
      f.context.afterFinalValidation = () => { injected = true; stopping = f.stop(); };
      vm.runInContext(`const validateBeforeStop = validateStartupVideoSource;
        validateStartupVideoSource = async (job, handle) => {
          await validateBeforeStop(job, handle);
          if (fs.existsSync(job.descriptor.cachePath)) afterFinalValidation();
        };`, f.context);
      f.queue(); await bounded(f.run(), "post-validation cancellation");
      assert.equal(injected, true, "the actual final validation finished before the runtime stop was inserted");
      await bounded(stopping, "post-validation stop drain");
      assert.equal(f.calls.filter(call => call[0] === "touch").length, 0, "an invalidated helper result cannot lead to a late cache touch");
      assert.equal(fs.existsSync(f.descriptor().cachePath), false, "a publication interrupted before caller acceptance must be rolled back");
      assert.equal(f.closed, true); assert.equal(f.state().executions, 0); assertNoDescriptors(f);
    } finally { f.release(); await stopping?.catch(() => {}); await f.dispose(); }
  });

  console.log(`short-video-startup-cache: PASS (${checks} real-file lifecycle/queue groups; ${nativeOpens} FileHandles, ${nativeReaders} read streams, ${nativeWriters} write streams; physical close and failure gates)`);
} finally {
  assert.equal(path.dirname(path.resolve(tempRoot)), path.resolve(os.tmpdir())); assert(path.basename(tempRoot).startsWith("fanhao-startup-cache-"));
  fs.rmdirSync(tempRoot);
}
