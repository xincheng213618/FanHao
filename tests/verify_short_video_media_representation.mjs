import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import { EventEmitter, once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import vm from "node:vm";
import { createFileServer } from "../src/platform/server/file-server.js";

// Execute the real runtime route/cache/queue/build/lifecycle functions and the
// real file server. Only catalog records, process execution and scheduling the
// shared encoding queue are controlled. All bytes live under one temp root;
// no service, downloader, real database, media library or FFmpeg is started.
const source = fs.readFileSync(new URL("../src/modules/short-videos/server/runtime.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");
function take(name) {
  const start = new RegExp(`^  (?:async )?function ${name}\\(`, "m").exec(source)?.index;
  assert(start != null, name);
  return source.slice(start, source.indexOf("\n  }", start) + 4);
}
const names = ["routeMedia", "beginSmoothPlaybackRequest", "beginStopSmoothPlaybackRequests", "sendSmoothPlaybackUnavailable",
  "sameSmoothPlaybackSource", "sendSmoothPlaybackSourceChanged",
  "isInitialVideoRange", "hasIfRange", "cachedStartupVideoFile", "startupVideoCacheDescriptor", "smoothVideoCacheDescriptor",
  "cachedSmoothVideoFile", "isSmoothVideoSourceCompatible", "safeStat", "hashText", "safeFilePart", "smoothVideoMetadataNeedsRendition",
  "tryQueueSmoothVideoCache", "queueSmoothVideoCache", "waitForSmoothVideoPlayback", "buildSmoothVideoCache", "executeSmoothVideoJob", "storedSmoothVideoProbe",
  "isCurrentSmoothVideoJob", "assertCurrentSmoothVideoJob", "assertSmoothVideoCatalog", "smoothVideoDiskIdentity", "validateSmoothVideoSource", "removeSmoothJobArtifact", "forgetSmoothVideoJobResolution",
  "stopSmoothVideoQueue", "stopDownloadManagerSync", "startDownloadManagerSync", "runtimeStartStillCurrent", "applyMobilePlaybackHints", "appendPlaybackQuery",
  "smoothVideoVersion", "smoothVideoCandidateVersion"];
const constants = Object.fromEntries(["SHORT_VIDEO_STREAM_CHUNK_BYTES", "SHORT_VIDEO_INITIAL_STREAM_CHUNK_BYTES", "SHORT_VIDEO_STARTUP_CACHE_BYTES",
  "SHORT_VIDEO_SMOOTH_FPS", "SHORT_VIDEO_SMOOTH_MAX_EDGE", "SHORT_VIDEO_SMOOTH_RENDITION_VERSION", "SHORT_VIDEO_SMOOTH_MIN_LONG_EDGE",
  "SHORT_VIDEO_SMOOTH_CACHE_DELAY_MS", "SHORT_VIDEO_SMOOTH_CURRENT_DELAY_MS", "SHORT_VIDEO_SMOOTH_ON_DEMAND_WAIT_MS", "SHORT_VIDEO_SMOOTH_ON_DEMAND_POLL_MS"]
  .map(name => [name, vm.runInNewContext(new RegExp(`^const ${name} = ([^;]+);`, "m").exec(source)[1])]));
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "fanhao-media-representation-"));
let sequence = 0;
const settle = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function fixture({ metadata = {}, timeout = 60, holdProcess = false, probe = null, filesystem = fs, cleanup = async () => {} } = {}) {
  const root = path.join(tempRoot, String(sequence++)); fs.mkdirSync(root);
  const original = Buffer.from("ORIGINAL-source-bytes"), preferred = Buffer.from("PREFERRED-h264-bytes"), legacy = Buffer.from("LEGACY-different-layout");
  const sourcePath = path.join(root, "original.mp4"); fs.writeFileSync(sourcePath, original);
  const initialVersion = String(Math.floor(fs.statSync(sourcePath).mtimeMs));
  const file = { id: "A", path: sourcePath, type: "video", ext: ".mp4", size: original.length, cacheVersion: initialVersion,
    actualCodec: "hevc", actualFrameRate: 30, actualWidth: 1080, actualHeight: 1920, ...metadata };
  const jobs = new Map(), requests = new Set(), timers = new Set(), children = new Map(), processCalls = [], queueSchedules = [], responses = [], executions = new Set(), outcomes = [], servedFiles = [];
  let closed = false, metadataWrites = 0;
  const fileServer = createFileServer({ mimeTypes: { ".mp4": "video/mp4" }, normalizeExt: value => value,
    notFound(res) { res.writeHead(404); res.end(); } });
  const processGate = deferred(), processStarted = deferred();
  const context = vm.createContext({
    ...constants, fs: filesystem, path, crypto, Date, AbortController, Promise, URLSearchParams, process: { pid: process.pid }, console: { log() {}, warn() {} },
    SHORT_VIDEO_SMOOTH_ON_DEMAND_WAIT_MS: timeout,
    // A four-byte prefix exercises the same virtual-entity behavior without
    // allocating a multi-megabyte source file for every race permutation.
    SHORT_VIDEO_STARTUP_CACHE_BYTES: 4,
    setTimeout(callback, delay) {
      const handle = setTimeout(() => { timers.delete(handle); callback(); }, delay); timers.add(handle); return handle;
    },
    clearTimeout(handle) { clearTimeout(handle); timers.delete(handle); }, clearImmediate,
    store: { videoFile: () => ({ ...file }), beginClose: async () => true, close: () => { closed = true; return true; },
      recoverDeleteJobs: async () => ({ pending: 0, active: 0 }), updateActualVideoPlaybackMetadata() { assert.equal(closed, false); metadataWrites++; return { changed: false }; } },
    sharedCache: { rootDir: root, touch() {}, scheduleCleanup() {} },
    smoothPlaybackRequests: requests, smoothPlaybackAccepting: true,
    smoothVideoJobs: jobs, smoothVideoQueue: [], smoothVideoActiveJobs: new Map(), smoothVideoChildren: children,
    smoothVideoExecutions: executions, smoothVideoJobGeneration: 0,
    videoCacheExecutions: new Set(), videoCacheAccepting: true,
    smoothVideoCandidateBacklog: [], smoothVideoCandidateIds: new Set(), smoothVideoResolvedVersions: new Map(), smoothVideoRenditionVersions: new Map(),
    smoothVideoCacheEntryNames: new Set(), smoothVideoPausedByUser: false, smoothVideoWarmupGeneration: 0,
    smoothVideoWarmupTimer: null, smoothVideoCandidateFillImmediate: null, smoothVideoCandidateRefill: null, smoothVideoTimer: null,
    smoothVideoCandidateScanOffset: 0, smoothVideoCandidateScanComplete: true,
    rememberSmoothVideoResolved() {}, sortAndScheduleSmoothVideoQueue: () => queueSchedules.push(jobs.size),
    tryQueueStartupVideoCache() {}, clearShortVideoListCache() {},
    createSmoothVideoInputAlias: async () => null, cleanupSmoothVideoInputAlias: cleanup,
    recordSmoothVideoJobResult(job, outcome) { outcomes.push(outcome); }, fillSmoothVideoCandidateQueue() {},
    probeSmoothVideo: probe || (async () => ({ codec: "hevc", frameRate: 30, width: 1080, height: 1920, bitRate: 1000000 })),
    async runMediaProcess(command, args) {
      processCalls.push({ command, args });
      processStarted.resolve();
      if (holdProcess) await processGate.promise;
      fs.writeFileSync(args.at(-1), preferred);
      return {};
    },
    ffmpegPath: "fixture-ffmpeg", hasNvenc: false, updateSmoothVideoProgress() {},
    mediaStreamService: { serveVideo: (...args) => { servedFiles.push(args[2]); return fileServer.serveRangedFile(...args); } },
    notFound(res) { res.writeHead(404); res.end(); },
    runtimeStarted: true, runtimeDesiredStarted: true, runtimeLifecycleGeneration: 0, runtimeStartPromise: null, runtimeStopPromise: null,
    runtimeTestHooks: {}, imageAccepting: true, beginStopImageRequests: async () => {}, stopVideoCacheQueue() {},
    downloadManagerSync: { start() {}, stop: async () => {} }, stopListServices: async () => {}, autoSmoothWarmup: false,
    catalogWorker: { reopen() {} }, smoothWarmupWorker: { reopen() {} }, watchWriter: { start: async () => {} }
  });
  vm.runInContext(`${names.map(take).join("\n")}\nglobalThis.api={${names.join(", ")}};`, context);
  const descriptor = context.api.smoothVideoCacheDescriptor("A", file), startup = context.api.startupVideoCacheDescriptor("A", file);
  fs.mkdirSync(descriptor.cacheDir, { recursive: true }); fs.mkdirSync(startup.cacheDir, { recursive: true });
  fs.writeFileSync(startup.cachePath, original.subarray(0, 4));
  const publish = (kind = "preferred") => fs.writeFileSync(kind === "legacy" ? descriptor.legacyCachePath : descriptor.cachePath, kind === "legacy" ? legacy : preferred);
  const request = ({ method = "GET", range = "bytes=0-3", query = "wait=0", sourceRoute = false, headers = {}, version = initialVersion } = {}) => {
    const req = Object.assign(new EventEmitter(), { method, headers: { ...(range ? { range } : {}), ...headers }, aborted: false });
    const chunks = [], res = new Writable({ write(chunk, _encoding, done) { chunks.push(Buffer.from(chunk)); done(); } });
    res.writeHead = (status, responseHeaders = {}) => { res.status = status; res.headers = responseHeaders; res.headersSent = true; return res; };
    res.body = () => Buffer.concat(chunks);
    const url = new URL(`http://fixture/media/${sourceRoute ? "short-video" : "short-video-smooth"}/A`);
    url.search = query;
    if (version !== null) url.searchParams.set("v", version);
    const task = context.api.routeMedia(req, res, url);
    const value = { req, res, task, abort() { req.aborted = true; req.emit("aborted"); } }; responses.push(value); return value;
  };
  const complete = async options => { const value = request(options); await value.task; return value.res; };
  return { context, api: context.api, file, root, descriptor, original, preferred, legacy, jobs, requests, timers, children, processCalls, queueSchedules, executions, outcomes, servedFiles,
    get closed() { return closed; }, get metadataWrites() { return metadataWrites; },
    publish, request, complete, processGate, processStarted,
    async close() {
      await context.api.beginStopSmoothPlaybackRequests();
      await Promise.all(responses.map(value => value.task));
      for (const handle of timers) clearTimeout(handle);
      await fileServer.stop();
    } };
}

try {
  {
    const f = fixture();
    try {
      const missingHead = await f.complete({ method: "HEAD", query: "wait=1" });
      assert.equal(missingHead.status, 503); assert.equal(missingHead.body().length, 0);
      assert.equal(f.jobs.size, 0, "HEAD reports missing without starting an encoder or a polling wait");
      assert.equal(f.timers.size, 0);
      const invalid = await f.complete({ query: "representation=source" });
      assert.equal(invalid.status, 400, "original bytes have their own endpoint, never a disguised preferred representation");
      assert.equal(f.jobs.size, 0);
      for (const query of ["wait=0", "wait=0&rendition=2k30-v2-range2", "wait=0&rendition=mobile-2560-h264-v3", "wait=0&rendition=mobile-2560-h264-v4-pinned", "wait=0&rendition=2k30-v3-pinned"]) {
        const res = await f.complete({ query });
        assert.equal(res.status, 503); assert.equal(res.body().length, 0);
        assert.equal(res.headers["Retry-After"], "1"); assert.equal(res.headers["Cache-Control"], "no-store");
        assert.equal(res.headers["Content-Range"], undefined, "an unready preferred URL never exposes original bytes or offsets");
      }
      assert.equal(f.jobs.size, 1, "parallel/repeated compatibility requests share one encoding job");
      assert.equal([...f.jobs.values()][0].forceCompatibility, true);
      const sourceValidator = (await f.complete({ method: "HEAD", sourceRoute: true })).headers.ETag;
      assert.equal((await f.complete({ headers: { "if-range": sourceValidator } })).status, 503, "an original-file validator cannot make an unready preferred URL serve original bytes");
      f.publish("legacy");
      assert.equal((await f.complete()).status, 503, "legacy bytes cannot silently stand in for a preferred URL");
      const legacy = await f.complete({ query: "representation=legacy" });
      assert.deepEqual(legacy.body(), f.legacy.subarray(0, 4));
      assert.equal(f.servedFiles.at(-1).entityMtimeResolutionMs, undefined, "legacy renditions keep physical timestamp precision");
      assert.equal(legacy.headers["X-FanHao-Playback-Rendition"], "smooth-4k30-legacy");
      f.publish();
      const nextLegacy = await f.complete({ range: "bytes=4-7", query: "representation=legacy" });
      assert.deepEqual(nextLegacy.body(), f.legacy.subarray(4, 8), "publishing preferred preserves the explicit legacy representation");
      const preferred = await f.complete();
      assert.deepEqual(preferred.body(), f.preferred.subarray(0, 4));
      assert.equal(f.servedFiles.at(-1).entityMtimeResolutionMs, undefined, "preferred renditions keep physical timestamp precision");
      assert.equal(preferred.headers["Content-Range"], `bytes 0-3/${f.preferred.length}`);
      assert.equal(preferred.headers["X-FanHao-Playback-Rendition"], "smooth-2k30");
      const head = await f.complete({ method: "HEAD" });
      assert.equal(head.status, 200); assert.equal(head.body().length, 0); assert.equal(head.headers["Content-Length"], f.preferred.length);
      assert.equal(head.headers.ETag, preferred.headers.ETag);
      const checked = await f.complete({ range: "bytes=4-7", headers: { "if-range": preferred.headers.ETag } });
      assert.equal(checked.status, 200, "a weak If-Range validator still follows the shared file server's full-entity policy");
      assert.deepEqual(checked.body(), f.preferred);
      fs.rmSync(f.descriptor.legacyCachePath);
      assert.equal((await f.complete({ query: "representation=legacy" })).status, 503, "a missing legacy URL does not upgrade to preferred bytes");
      const source = await f.complete({ sourceRoute: true });
      assert.equal(f.servedFiles.at(-1).entityMtimeResolutionMs, 1, "startup-prefix responses opt into source/catalog millisecond precision");
      assert.equal(source.headers["Content-Range"], `bytes 0-3/${f.original.length}`);
      assert.deepEqual(source.body(), f.original.subarray(0, 4));
      const rest = await f.complete({ sourceRoute: true, range: "bytes=4-7" });
      assert.equal(f.servedFiles.at(-1).entityMtimeResolutionMs, 1, "the whole source uses the same explicit millisecond precision");
      assert.equal(f.file.entityMtimeResolutionMs, undefined, "transport hints never mutate the catalog's source object");
      assert.deepEqual(Buffer.concat([source.body(), rest.body()]), f.original.subarray(0, 8), "startup and source ranges are the same original entity");
      const sourceHead = await f.complete({ sourceRoute: true, method: "HEAD" });
      assert.equal(sourceHead.headers["Content-Length"], f.original.length);
      const sourceChecked = await f.complete({ sourceRoute: true, headers: { "if-range": source.headers.ETag } });
      assert.deepEqual(sourceChecked.body(), f.original, "If-Range bypasses the physical startup prefix for a full source response");
    } finally { await f.close(); }
  }

  for (const range of [null, "bytes=0-3"]) {
    const f = fixture();
    try {
      const pending = f.request({ range, query: "wait=1" });
      await settle(); assert.equal(pending.res.headersSent, undefined); assert.equal(f.timers.size, 1);
      f.publish(); await pending.task;
      assert.equal(pending.res.headers["X-FanHao-Playback-Prepare"], "waited");
      assert.deepEqual(pending.res.body(), range ? f.preferred.subarray(0, 4) : f.preferred);
      assert.equal(f.requests.size, 0); assert.equal(f.timers.size, 0);
    } finally { await f.close(); }
  }
  {
    const f = fixture({ timeout: 15 });
    try {
      const res = await f.complete({ query: "wait=1" });
      assert.equal(res.status, 503); assert.equal(res.headers["X-FanHao-Playback-Prepare"], "wait-timeout");
      assert.equal(f.queueSchedules.length, 1, "timeout never schedules another copy of the shared job");
      for (const options of [{ method: "HEAD", query: "wait=1" }, { range: "bytes=4-7", query: "wait=1" }]) {
        const request = f.request(options); await settle();
        assert.equal(request.res.status, 503); assert.equal(f.timers.size, 0, "HEAD and noninitial reads never wait"); await request.task;
      }
      f.context.smoothVideoPausedByUser = true;
      // Use the actual scheduler for this boundary: forcing compatibility
      // still cannot launch a queue the user explicitly paused.
      vm.runInContext(`${take("sortAndScheduleSmoothVideoQueue")}\n${take("runSmoothVideoQueue")}\nglobalThis.runPausedQueue=runSmoothVideoQueue;`, f.context);
      const paused = await f.complete({ query: "wait=1" });
      assert.equal(paused.status, 503); assert.equal(paused.headers["X-FanHao-Playback-Prepare"], "paused");
      assert.equal(f.timers.size, 0); assert.equal(f.processCalls.length, 0, "a request cannot unpause the shared encoding queue");
      f.context.runPausedQueue(); assert.equal(f.processCalls.length, 0); assert.equal(f.jobs.size, 1);
    } finally { await f.close(); }
  }

  {
    const f = fixture();
    try {
      f.file.cacheVersion = String(Number(f.file.cacheVersion) + 1);
      const currentDescriptor = f.api.smoothVideoCacheDescriptor("A", f.file);
      fs.writeFileSync(currentDescriptor.cachePath, f.preferred);
      const stale = await f.complete();
      assert.equal(stale.status, 409); assert.equal(stale.headers["Cache-Control"], "no-store");
      assert.equal(f.jobs.size, 0, "a stale version never launches a replacement source's job");
      const alias = await f.complete({ version: null });
      assert.deepEqual(alias.body(), f.preferred.subarray(0, 4));
      assert.equal(alias.headers["Cache-Control"], "private, max-age=0, must-revalidate", "a versionless legacy alias is never immutable");
      assert.notEqual((await f.complete({ sourceRoute: true })).status, 409, "the original source route's stale-version contract is unchanged");
    } finally { await f.close(); }
  }
  for (const change of ["version", "removed"]) {
    const f = fixture();
    try {
      const pending = f.request({ query: "wait=1" }); await settle();
      assert.equal(f.jobs.size, 1);
      if (change === "version") f.file.cacheVersion = String(Number(f.file.cacheVersion) + 1);
      else f.context.store.videoFile = () => null;
      f.publish(); await pending.task;
      assert.equal(pending.res.status, change === "version" ? 409 : 404);
      assert.equal(pending.res.body().length, 0, "a changed catalog source cannot publish the old prepared bytes");
      assert.equal(f.jobs.size, 1); assert.equal(f.queueSchedules.length, 1, "completion never enqueues work for the replacement source");
    } finally { await f.close(); }
  }
  {
    const f = fixture();
    try {
      let reads = 0;
      f.context.store.videoFile = () => ({ ...f.file, cacheVersion: String(Number(f.file.cacheVersion) + (++reads === 1 ? 0 : 1)) });
      const res = await f.complete();
      assert.equal(res.status, 409); assert.equal(f.jobs.size, 0, "a source changed between route lookup and queue lookup is never enqueued");
    } finally { await f.close(); }
  }

  for (const invalidation of ["request", "response", "stop"]) {
    const f = fixture({ timeout: 2800 });
    try {
      const pending = f.request({ range: null, query: "wait=1" }); await settle();
      const sharedJob = [...f.jobs.values()][0], schedules = f.queueSchedules.length;
      assert.equal(f.timers.size, 1);
      const started = performance.now();
      if (invalidation === "request") pending.abort();
      if (invalidation === "response") pending.res.destroy();
      if (invalidation === "stop") await f.api.stopDownloadManagerSync();
      await pending.task;
      assert(performance.now() - started < 250, "disconnect/stop cancels the 2.8s preparation poll immediately");
      assert.equal(pending.res.headersSent, undefined); assert.equal(pending.res.body().length, 0);
      assert.equal(f.requests.size, 0); assert.equal(f.timers.size, 0);
      assert.equal(pending.req.listenerCount("aborted"), 0); assert.equal(pending.res.listenerCount("close"), 0);
      assert.equal(f.queueSchedules.length, schedules, "late completion cannot requeue work after cancellation");
      if (invalidation !== "stop") assert.equal([...f.jobs.values()][0], sharedJob, "one viewer leaving never cancels the shared transcode job");
      else {
        assert.equal(f.jobs.size, 0);
        const stopped = await f.complete(); assert.equal(stopped.status, 503);
        assert.equal(f.jobs.size, 0, "a stopped runtime cannot reopen its shared queue");
        assert.equal(await f.api.startDownloadManagerSync(), true);
        f.publish(); const restarted = await f.complete(); assert.deepEqual(restarted.body(), f.preferred.subarray(0, 4));
      }
    } finally { await f.close(); }
  }
  {
    const f = fixture({ timeout: 2800 });
    try {
      const old = f.request({ query: "wait=1" }), current = f.request({ query: "wait=1" }); await settle();
      assert.equal(f.jobs.size, 1); old.abort(); await old.task;
      assert.equal(current.res.destroyed, false);
      f.publish(); await current.task; assert.deepEqual(current.res.body(), f.preferred.subarray(0, 4));
      assert.equal(f.timers.size, 0);
    } finally { await f.close(); }
  }

  for (const marker of [false, true]) {
    const f = fixture();
    try {
      if (marker) fs.writeFileSync(f.descriptor.skipPath, "source-ok");
      assert.equal(f.api.queueSmoothVideoCache("A", { kind: "background" }).state, "source-ok", "low resolution still skips speculative background work");
      assert.equal(f.jobs.size, 0);
      assert.equal(f.api.queueSmoothVideoCache("A", { kind: "current" }).state, "queued");
      const job = [...f.jobs.values()][0]; job.progress = {};
      const result = await f.api.buildSmoothVideoCache(job);
      assert.equal(result.state, "completed", "an explicit 1080p HEVC compatibility request must materialize H.264 despite a skip marker");
      assert.equal(f.processCalls.length, 1); assert(f.processCalls[0].args.includes("libx264"));
      assert.deepEqual(fs.readFileSync(f.descriptor.cachePath), f.preferred);
      assert.equal(fs.existsSync(f.descriptor.skipPath), false);
    } finally { await f.close(); }
  }
  {
    const gate = deferred(), probing = deferred();
    const f = fixture({ metadata: { actualCodec: "", actualFrameRate: 0 }, probe: () => { probing.resolve(); return gate.promise; } });
    try {
      f.api.queueSmoothVideoCache("A", { kind: "background", delayMs: 8000 });
      const job = [...f.jobs.values()][0]; job.active = true; job.progress = {};
      const build = f.api.buildSmoothVideoCache(job); await probing.promise;
      assert.equal(f.api.queueSmoothVideoCache("A", { kind: "current" }).state, "transcoding");
      assert.equal(f.jobs.size, 1); assert.equal([...f.jobs.values()][0], job);
      assert.equal(job.forceCompatibility, true); assert.equal(job.kind, "current");
      gate.resolve({ codec: "hevc", frameRate: 30, width: 1080, height: 1920, bitRate: 1000000 });
      assert.equal((await build).state, "completed", "a current viewer upgrades an in-flight background probe instead of accepting source-ok");
      assert.equal(f.processCalls.length, 1);
    } finally { await f.close(); }
  }

  {
    const markerWrite = deferred(), publishedMarker = deferred();
    const filesystem = { ...fs, promises: { ...fs.promises,
      async writeFile(file, ...args) {
        await fs.promises.writeFile(file, ...args);
        if (String(file).endsWith(".source-ok")) { publishedMarker.resolve(); await markerWrite.promise; }
      }
    } };
    const f = fixture({ metadata: { actualCodec: "", actualFrameRate: 0 }, filesystem });
    try {
      f.api.queueSmoothVideoCache("A", { kind: "background" });
      const job = [...f.jobs.values()][0]; job.active = true; job.progress = {};
      const build = f.api.buildSmoothVideoCache(job); await publishedMarker.promise;
      f.api.queueSmoothVideoCache("A", { kind: "current" }); markerWrite.resolve();
      assert.equal((await build).state, "completed", "promotion during a skip-marker write still produces the preferred file");
      assert.equal(f.jobs.size, 1); assert.equal(f.processCalls.length, 1);
      assert.equal(fs.existsSync(f.descriptor.skipPath), false);
    } finally { await f.close(); }
  }

  {
    const f = fixture();
    try {
      f.publish("legacy"); f.api.queueSmoothVideoCache("A", { kind: "current" });
      const job = [...f.jobs.values()][0]; job.progress = {};
      await f.api.buildSmoothVideoCache(job);
      assert.deepEqual(fs.readFileSync(f.descriptor.legacyCachePath), f.legacy, "publishing a preferred file cannot evict bytes behind an explicit legacy URL");
    } finally { await f.close(); }
  }

  {
    const cleanupStarted = deferred(), cleanupGate = deferred(); let cleanups = 0;
    const f = fixture({ metadata: { actualCodec: "", actualFrameRate: 0 }, cleanup: async () => {
      if (++cleanups === 1) { cleanupStarted.resolve(); await cleanupGate.promise; }
    } });
    try {
      f.api.queueSmoothVideoCache("A", { kind: "background" });
      const job = [...f.jobs.values()][0]; job.active = true; job.progress = {};
      const execution = f.api.executeSmoothVideoJob(job); await cleanupStarted.promise;
      f.api.queueSmoothVideoCache("A", { kind: "current" }); cleanupGate.resolve(); await execution;
      assert.deepEqual(fs.readFileSync(f.descriptor.cachePath), f.preferred, "a promotion during post-skip alias cleanup cannot retire the only shared job without encoding");
      assert.equal(f.jobs.size, 0); assert.equal(f.processCalls.length, 1);
    } finally { await f.close(); }
  }

  for (const stage of ["probe", "encode"]) {
    const probeGate = deferred(), probeStarted = deferred();
    const f = fixture({ holdProcess: stage === "encode", metadata: stage === "probe" ? { actualCodec: "", actualFrameRate: 0 } : {},
      probe: () => { probeStarted.resolve(); return probeGate.promise; } });
    try {
      f.api.queueSmoothVideoCache("A", { kind: "current" });
      const job = [...f.jobs.values()][0]; job.active = true; job.progress = {};
      f.context.smoothVideoActiveJobs.set(job.key, job);
      const execution = f.api.executeSmoothVideoJob(job);
      await (stage === "probe" ? probeStarted.promise : f.processStarted.promise);
      assert.equal(f.executions.size, 1);
      let stopped = false;
      const stop = f.api.stopDownloadManagerSync().then(() => { stopped = true; });
      await settle();
      assert.equal(stopped, false, `${stage}: runtime stop retains the physical job promise`);
      assert.equal(f.closed, false, "store closure waits for all executing job continuations");
      const start = f.api.startDownloadManagerSync(); await settle();
      assert.equal(f.context.runtimeStarted, false, "a new start intent waits behind the old physical execution");
      if (stage === "probe") probeGate.resolve({ codec: "hevc", width: 1080, height: 1920, frameRate: 30 });
      else f.processGate.resolve();
      await Promise.all([execution, stop, start]);
      assert.equal(stopped, true); assert.equal(f.closed, true);
      assert.equal(f.metadataWrites, 0, "a late probe never writes metadata after its job was cancelled");
      assert.equal(fs.existsSync(f.descriptor.cachePath), false, "a late successful encode never publishes after stop");
      assert.equal(f.executions.size, 0); assert.equal(f.context.smoothVideoActiveJobs.size, 0);
      assert.equal(f.context.smoothVideoCandidateBacklog.length, 0, "an old completion cannot requeue work after runtime stop");
    } finally { await f.close(); }
  }

  for (const stage of ["stat", "rename", "skip-cleanup"]) {
    const gate = deferred(), reached = deferred(); let held = false, targetDescriptor;
    const filesystem = { ...fs, promises: { ...fs.promises,
      async stat(file, ...args) {
        const value = await fs.promises.stat(file, ...args);
        if (stage === "stat" && String(file).includes(".tmp-") && !held) { held = true; reached.resolve(); await gate.promise; }
        return value;
      },
      async rename(from, to) {
        await fs.promises.rename(from, to);
        if (stage === "rename" && !held) { held = true; reached.resolve(); await gate.promise; }
      },
      async rm(file, ...args) {
        await fs.promises.rm(file, ...args);
        if (stage === "skip-cleanup" && file === targetDescriptor?.skipPath && !held) { held = true; reached.resolve(); await gate.promise; }
      }
    } };
    const f = fixture({ filesystem }); targetDescriptor = f.descriptor;
    try {
      f.api.queueSmoothVideoCache("A", { kind: "current" });
      const job = [...f.jobs.values()][0]; job.active = true; job.progress = {};
      f.context.smoothVideoActiveJobs.set(job.key, job);
      const execution = f.api.executeSmoothVideoJob(job); await reached.promise;
      let stopped = false; const stop = f.api.stopDownloadManagerSync().then(() => { stopped = true; }); await settle();
      assert.equal(stopped, false); assert.equal(f.closed, false);
      gate.resolve(); await Promise.all([execution, stop]);
      assert.equal(fs.existsSync(f.descriptor.cachePath), false, `${stage}: pending native publication is rolled back before stop completes`);
      assert.equal(f.executions.size, 0); assert.equal(f.closed, true);
    } finally { await f.close(); }
  }

  {
    const f = fixture({ holdProcess: true });
    try {
      f.api.queueSmoothVideoCache("A", { kind: "current" });
      const old = [...f.jobs.values()][0]; old.active = true; old.progress = {};
      f.context.smoothVideoActiveJobs.set(old.key, old);
      const execution = f.api.executeSmoothVideoJob(old); await f.processStarted.promise;
      const drain = f.api.stopSmoothVideoQueue({ pause: false });
      f.api.queueSmoothVideoCache("A", { kind: "current" });
      const fresh = [...f.jobs.values()][0]; assert.notEqual(fresh, old);
      assert.equal(f.context.smoothVideoActiveJobs.get(old.key), old, "the old process owns its active slot until physical completion");
      f.processGate.resolve(); await Promise.all([execution, drain]);
      assert.equal(f.jobs.get(fresh.key), fresh, "a late old finally cannot delete the new generation's same-key job");
      assert.equal(f.context.smoothVideoActiveJobs.size, 0);
      assert.equal(fs.existsSync(f.descriptor.cachePath), false);
    } finally { await f.close(); }
  }

  {
    const f = fixture({ holdProcess: true });
    try {
      f.api.queueSmoothVideoCache("A", { kind: "current" });
      const old = [...f.jobs.values()][0]; old.active = true; old.progress = {};
      f.context.smoothVideoActiveJobs.set(old.key, old);
      const execution = f.api.executeSmoothVideoJob(old); await f.processStarted.promise;
      vm.runInContext(`${take("setSmoothVideoPausedByUser")}\nglobalThis.pauseEncoding=setSmoothVideoPausedByUser;`, f.context);
      f.context.pauseEncoding(true); f.processGate.resolve(); await execution;
      const next = [...f.jobs.values()][0];
      assert.notEqual(next, old); assert.equal(next.forceCompatibility, true, "a user pause retains the forced compatibility intent for resume");
      assert.equal(f.context.smoothVideoPausedByUser, true); assert.equal(f.closed, false, "a user pause is not a full runtime/store stop");
    } finally { await f.close(); }
  }

  {
    let child, releaseStdout, close;
    const run = vm.runInNewContext(`${take("runMediaProcess")}\nrunMediaProcess;`, {
      path, smoothVideoChildren: new Map(),
      spawn(command, args, options) {
        child = spawn(command, args, options);
        close = once(child, "close");
        const resume = child.stdout.resume.bind(child.stdout);
        child.stdout.resume = () => child.stdout;
        releaseStdout = () => { child.stdout.resume = resume; resume(); };
        return child;
      }
    });
    let settled = false;
    const running = run(process.execPath, ["-e", "process.stdout.write('early-and-late')"], { captureStdout: true }).then(value => { settled = true; return value; });
    try {
      await once(child, "exit"); await new Promise(resolve => setImmediate(resolve));
      assert.equal(child.stdout.destroyed, false, "the real child exited while its native stdout pipe is still held");
      assert.equal(settled, false, "exit alone cannot settle the media process promise");
    } finally { releaseStdout(); }
    const result = await running; await close;
    assert.equal(result.stdout, "early-and-late", "physical close includes data buffered after the exit notification");
  }
  {
    let physicallyClosed = false;
    const run = vm.runInNewContext(`${take("runMediaProcess")}\nrunMediaProcess;`, {
      path, smoothVideoChildren: new Map(),
      spawn(command, args, options) {
        const child = spawn(command, args, options);
        child.once("close", () => { physicallyClosed = true; });
        return child;
      }
    });
    await assert.rejects(run(path.join(tempRoot, "missing-transcoder.exe"), [], { captureStdout: true }), { code: "ENOENT" });
    assert.equal(physicallyClosed, true, "spawn failures also retain the process promise through physical close");
  }

  console.log("short-video-media-representation: passed actual pinned preferred/legacy/source ranges, HEAD/If-Range, pending 503, shared jobs, forced compatibility, request/stop cancellation and restart");
} finally {
  const resolved = path.resolve(tempRoot), parent = path.resolve(os.tmpdir());
  assert.equal(path.dirname(resolved), parent); assert(path.basename(resolved).startsWith("fanhao-media-representation-"));
  fs.rmSync(resolved, { recursive: true, force: true });
}
