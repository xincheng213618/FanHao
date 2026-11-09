import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { EventEmitter } from "node:events";
import { createVideoProbeService } from "../src/platform/server/video-probe-service.js";
import { createServerHost } from "../src/platform/server/server-host.js";

// Controlled processes and filesystem waits, plus one real disposable Node
// child. No media, FFprobe, production database or existing service is used.
const tick = () => new Promise((resolve) => setImmediate(resolve));
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const source = (id) => ({ id, path: `fixture/${id}.mp4`, ext: ".mp4", size: 1, modifiedAt: "fixture-v1" });
const stat = { size: 1, mtimeMs: 1, dev: 1, ino: 1 };
const output = JSON.stringify({ streams: [{ codec_type: "video", codec_name: "h264" }], format: { duration: "42" } });
async function until(predicate, label) {
  for (let i = 0; i < 300 && !predicate(); i++) await delay(2);
  assert(predicate(), label);
}

function fixture(options = {}) {
  const calls = [], writes = [];
  let live = 0, peak = 0;
  const service = createVideoProbeService({
    ffprobePath: "fixture-probe", hasNvenc: false, directVideoExts: new Set([".mp4"]),
    safeStat: () => ({ ...stat }), statFile: async () => ({ ...stat }),
    persistentCache: { get: () => ({ hit: false }), set: (...args) => writes.push(args) },
    execFileFn: (_exe, args, opts, callback) => {
      const child = new EventEmitter();
      child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
      child.killCalls = [];
      child.kill = (signal) => { child.killCalls.push(signal); return true; };
      child.finish = (error = null) => callback(error, error ? "" : output);
      child.close = () => { if (!child.closed) { child.closed = true; live--; child.emit("close", 0); } };
      child.path = args.at(-1); child.options = opts;
      calls.push(child); live++; peak = Math.max(peak, live);
      return child;
    }, ...options
  });
  return { service, calls, writes, peak: () => peak, live: () => live };
}

async function closeAll(f) {
  f.service.beginStop();
  for (const child of f.calls) child.close();
  await f.service.stop();
}

async function verifySharedCapacity() {
  const f = fixture({ asyncCapacity: 8, probeWaitMs: 2 });
  const tasks = [];
  try {
    f.service.prewarm([source("bg-a"), source("bg-b"), source("bg-c")]);
    await until(() => f.calls.length === 2, "prewarm starts only two children");
    for (let i = 0; i < 20; i++) tasks.push(f.service.playInfoForFileAsync(source(`front-${i}`)));
    for (let i = 0; i < 2; i++) tasks.push(f.service.probeAsync(source(`raw-${i}`)).catch((error) => error.code));
    const results = await Promise.all(tasks);
    assert.equal(f.calls.length, 2, "foreground and raw probes must share prewarm capacity");
    assert.equal(f.peak(), 2);
    assert(f.service.diagnostics().inflight <= 8);
    assert.equal(f.service.asyncDiagnostics().active + f.service.asyncDiagnostics().queued, 8);
    assert.equal(results.at(-1), "PROBE_BUSY");
    assert(results.some((value) => value?.probePending === false), "overload responds without pretending rejected work is pending");
    f.calls[0].finish();
    await tick();
    assert.equal(f.calls.length, 2, "callback alone must retain the child slot");
    f.calls[0].close();
    await until(() => f.calls.length === 3, "confirmed close permits next child");
    assert.equal(f.calls[2].path, source("front-0").path, "foreground runs ahead of queued prewarm");
    assert.equal(f.writes.length, 1);
    assert.equal(f.peak(), 2);
  } finally { await closeAll(f); }
}

async function verifyDefaultBurst() {
  const f = fixture({ probeWaitMs: 2 });
  f.service.prewarm(Array.from({ length: 6 }, (_, i) => source(`burst-bg-${i}`)));
  await until(() => f.calls.length === 2, "default prewarm begins two children");
  const raw = [f.service.probeAsync(source("burst-raw-a")), f.service.probeAsync(source("burst-raw-b"))];
  const foreground = Array.from({ length: 20 }, (_, i) => f.service.playInfoForFileAsync(source(`burst-front-${i}`)));
  try {
    const results = await Promise.all(foreground);
    assert(results.every((value) => value.probePending), "the accepted cold burst retains the quick fallback contract");
    assert.equal(f.service.asyncDiagnostics().capacity, 48);
    assert.equal(f.service.asyncDiagnostics().queued, 22);
    assert.equal(f.calls.length, 2, "twenty foreground and two raw probes cannot bypass the default two-child limit");
    assert.equal(f.peak(), 2);
  } finally {
    await closeAll(f);
    assert.deepEqual(await Promise.all(raw), [null, null]);
  }
}

async function verifyPromotionAndSnapshot() {
  const f = fixture({ asyncConcurrency: 1 });
  const first = f.service.probeAsync(source("raw-first"));
  const mutable = source("raw-snapshot");
  const second = f.service.probeAsync(mutable); mutable.path = "reassigned";
  const backgroundA = f.service.probeCachedAsync(source("background-a"), { background: true });
  const backgroundB = f.service.probeCachedAsync(source("background-b"), { background: true });
  assert.equal(f.service.probeCachedAsync(source("background-b")), backgroundB);
  try {
    f.calls[0].finish(); f.calls[0].close(); await first;
    await until(() => f.calls.length === 2, "raw queued source starts");
    assert.equal(f.calls[1].path, source("raw-snapshot").path);
    f.calls[1].finish(); f.calls[1].close(); await second;
    await until(() => f.calls.length === 3, "promoted source starts");
    assert.equal(f.calls[2].path, source("background-b").path);
    f.calls[2].finish(); f.calls[2].close(); await backgroundB;
    await until(() => f.calls.length === 4, "remaining background starts");
    f.calls[3].finish(); f.calls[3].close(); await backgroundA;
  } finally { await closeAll(f); }
}

async function verifyStatBoundaries() {
  const physical = [];
  let blocked = true;
  const f = fixture({ statCapacity: 3, statTimeoutMs: 20,
    statFile: () => blocked ? new Promise((resolve) => physical.push(resolve)) : Promise.resolve({ ...stat }) });
  for (let i = 0; i < 3; i++) {
    const task = f.service.probeCachedAsync(source(`stat-${i}`));
    await assert.rejects(task, { code: "PROBE_STAT_TIMEOUT" });
    assert.equal(f.writes.length, 0, "stat timeouts must not create negative persistent rows");
    assert.equal(f.service.diagnostics().resolved, 0);
    f.service.clearCache();
  }
  await assert.rejects(f.service.probeCachedAsync(source("stat-overflow")), { code: "PROBE_BUSY" });
  assert.equal(physical.length, 3, "clears cannot discard outstanding OS stat ownership");
  assert.equal(f.service.asyncDiagnostics().physicalStats, 3);
  blocked = false;
  for (const finish of physical) finish({ ...stat });
  await tick();
  assert.equal(f.calls.length, 0, "late filesystem results cannot spawn children");
  assert.equal(f.service.asyncDiagnostics().physicalStats, 0);
  const retry = f.service.probeCachedAsync(source("stat-0"));
  await until(() => f.calls.length === 1, "timed-out source remains retryable");
  f.calls[0].finish(); f.calls[0].close(); assert.equal((await retry).duration, 42);
  await closeAll(f);

  let finishOld;
  const g = fixture({ statFile: () => new Promise((resolve) => { finishOld = resolve; }) });
  const old = g.service.probeCachedAsync(source("clear-stat"));
  g.service.clearCache();
  assert.equal(await old, null, "clear cancels logical filesystem waiting immediately");
  assert.equal(g.service.asyncDiagnostics().active, 0);
  assert.equal(g.service.asyncDiagnostics().physicalStats, 1);
  finishOld({ ...stat }); await tick(); assert.equal(g.calls.length, 0);
  await g.service.stop();

  const blockedStats = [];
  let slow = true;
  const h = fixture({ statFile: () => slow ? new Promise((resolve) => blockedStats.push(resolve)) : Promise.resolve({ ...stat }) });
  h.service.prewarm([source("prewarm-old-a"), source("prewarm-old-b")]);
  assert.equal(blockedStats.length, 2);
  h.service.clearCache();
  slow = false;
  h.service.prewarm([source("prewarm-new")]);
  await until(() => h.calls.length === 1, "clearing hung stats must release logical prewarm slots");
  assert.equal(h.calls[0].path, source("prewarm-new").path);
  for (const finish of blockedStats) finish({ ...stat });
  h.calls[0].finish(); h.calls[0].close(); await tick();
  assert.equal(h.calls.length, 1, "old prewarm stat completion cannot spawn a child");
  await closeAll(h);
}

async function verifyRequiredPlaybackSource() {
  const file = { ...source("verified"), modifiedAt: new Date(stat.mtimeMs).toISOString() };
  const { path } = file;
  const live = { ...stat, isFile: () => true };
  let checked = [], actual = live;
  const saved = { duration: 71, videoCodec: "h264", audioCodec: "aac" };
  const f = fixture({ asyncConcurrency: 1, probeWaitMs: 0,
    statFile: async (filePath) => { checked.push(filePath); return actual; },
    persistentCache: { get: (_file, identity) => identity.cacheMtime
      ? { hit: true, value: saved } : { hit: false } }
  });
  const background = f.service.probeAsync(source("occupied-probe"));
  try {
    assert.equal((await f.service.playInfoForFileAsync(file, file.id, { requireSource: true })).duration, 71);
    assert.deepEqual(checked, [path], "a matching validated source reuses warm metadata even while FFprobe is occupied");
    assert.equal(f.calls.length, 1);

    actual = null;
    assert.equal(await f.service.playInfoForFileAsync(file, file.id, { requireSource: true }), null,
      "a warm row cannot validate a missing file");
    actual = { ...live, isFile: () => false };
    assert.equal(await f.service.playInfoForFileAsync(file, file.id, { requireSource: true }), null,
      "a directory at the old path is not a valid media source");

    actual = { ...live, size: 2, mtimeMs: 2, ino: 2 };
    checked = [];
    const changed = f.service.playInfoForFileAsync(file, file.id, { requireSource: true });
    await until(() => f.service.asyncDiagnostics().queued === 1, "a changed disk source cannot use the stale index row");
    assert.deepEqual(checked, [path]);
    f.calls[0].finish(); f.calls[0].close(); await background;
    await until(() => f.calls.length === 2, "verified source runs FFprobe after child slot opens");
    assert.deepEqual(checked, [path], "cold playback reuses its checked stat before FFprobe");
    f.calls[1].finish(); f.calls[1].close();
    assert.equal((await changed).duration, 42);
    assert.deepEqual(checked, [path, path], "a cold result is checked again before publication");
    assert.equal((await f.service.playInfoForFileAsync(file, file.id, { requireSource: true })).duration, 42);
    assert.equal(f.calls.length, 2, "the verified disk signature keeps the new result warm");
  } finally { await closeAll(f); }

  const restored = { ...file, id: "restored", path: "fixture/restored.mp4" };
  let available = false;
  const g = fixture({ probeWaitMs: 0, safeStat: () => null, statFile: async () => available ? live : null });
  try {
    assert.equal(g.service.probeCached(restored), null);
    assert.equal(await g.service.probeCachedAsync(restored), null);
    assert.equal(g.service.diagnostics().resolved, 0, "absence must not occupy the warm probe cache");
    available = true;
    const requested = g.service.playInfoForFileAsync(restored, restored.id, { requireSource: true });
    await until(() => g.calls.length === 1, "reconnected source with unchanged index identity is probed again");
    g.calls[0].finish(); g.calls[0].close();
    assert.equal((await requested).duration, 42);
  } finally { await closeAll(g); }
}

async function verifyPlaybackSourceCancellation() {
  const live = { ...stat, isFile: () => true };
  let releaseLookup, lookupCalls = 0;
  const f = fixture({ asyncConcurrency: 1, asyncCapacity: 2, statTimeoutMs: 35, stopTimeoutMs: 30,
    statFile: () => { lookupCalls++; return new Promise(resolve => { releaseLookup = resolve; }); }
  });
  const required = (id, options) => f.service.playInfoForFileAsync(source(id), id, { requireSource: true, ...options });
  try {
    const held = required("held");
    const aborted = new AbortController();
    const queued = required("queued", { signal: aborted.signal });
    await assert.rejects(required("overflow"), { code: "PROBE_BUSY", statusCode: 503 });
    aborted.abort();
    assert.equal(await queued, null);
    await assert.rejects(held, { code: "PROBE_STAT_TIMEOUT", statusCode: 503 });
    assert.equal(lookupCalls, 1, "disconnecting a queued lookup never stats its path");
    assert.equal(f.service.asyncDiagnostics().sourceLookup.active, 1);
    await assert.rejects(f.service.stop(), { code: "PROBE_CLOSE_TIMEOUT" });
    await assert.rejects(f.service.start(), { code: "PROBE_CLOSE_TIMEOUT" });
    releaseLookup(live);
    await tick();
    assert.equal(f.calls.length, 0, "a late result cannot start FFprobe after timeout or stop");
    assert.equal(f.service.asyncDiagnostics().sourceLookup.active, 0);
    await f.service.start();
  } finally {
    releaseLookup?.(live);
    await closeAll(f);
  }

  const moved = { ...source("relocation"), path: "fixture/moved.mp4" };
  const checked = [];
  let releaseRelocation, relocationSignal;
  const g = fixture({ probeWaitMs: 0, statFile: async (filePath) => {
    checked.push(filePath);
    return filePath === moved.path ? live : null;
  } });
  try {
    const controller = new AbortController();
    const options = { requireSource: true, signal: controller.signal, resolveMissingSource: (_file, signal) => {
      relocationSignal = signal;
      return new Promise(resolve => { releaseRelocation = resolve; });
    } };
    const cancelled = g.service.playInfoForFileAsync(source("relocation"), moved.id, options);
    await until(() => Boolean(releaseRelocation), "the missing source reaches async relocation");
    controller.abort();
    assert.equal(await cancelled, null);
    assert.equal(relocationSignal.aborted, true);
    assert.equal(g.service.asyncDiagnostics().sourceLookup.active, 1);
    releaseRelocation(moved);
    await tick();
    assert.deepEqual(checked, [source("relocation").path]);
    const recovered = g.service.playInfoForFileAsync(source("relocation"), moved.id, {
      requireSource: true, resolveMissingSource: async () => moved
    });
    await until(() => g.calls.length === 1, "relocated source is checked and probed");
    assert.equal(g.calls[0].path, moved.path);
    g.calls[0].finish(); g.calls[0].close();
    assert.equal((await recovered).duration, 42);
    assert.deepEqual(checked.slice(1), [source("relocation").path, moved.path, moved.path]);
  } finally {
    releaseRelocation?.(moved);
    await closeAll(g);
  }
}

async function verifyProcessClosure() {
  for (const failure of ["callback", "stdout", "stderr", "process", "timeout"]) {
    const f = fixture({ asyncConcurrency: 1, processTimeoutMs: failure === "timeout" ? 20 : 1000 });
    const first = f.service.probeAsync(source(`error-${failure}`));
    const second = f.service.probeAsync(source("next"));
    if (failure === "callback") f.calls[0].finish(new Error("synthetic callback failure"));
    if (failure === "stdout" || failure === "stderr") f.calls[0][failure].emit("error", new Error("synthetic pipe failure"));
    if (failure === "process") f.calls[0].emit("error", new Error("synthetic process failure"));
    await until(() => f.calls[0].killCalls.length > 0, "failure requests process termination");
    assert.equal(f.calls[0].killCalls[0], "SIGKILL");
    assert.equal(f.calls.length, 1, "failure does not release a live child's slot");
    assert.equal(f.service.asyncDiagnostics().children, 1);
    f.calls[0].close(); assert.equal(await first, null);
    await until(() => f.calls.length === 2, "next source starts after close");
    f.calls[1].finish(); f.calls[1].close(); assert.equal((await second).duration, 42);
    assert.equal(f.peak(), 1);
    await closeAll(f);
  }
}

async function verifyLifecycle() {
  const f = fixture({ stopTimeoutMs: 20 });
  const old = f.service.probeCachedAsync(source("stop"));
  await until(() => f.calls.length === 1, "stop fixture starts");
  const stopping = f.service.stop();
  const startedEarly = f.service.start();
  await assert.rejects(f.service.probeCachedAsync(source("rejected")), { code: "PROBE_STOPPED" });
  await assert.rejects(stopping, { code: "PROBE_CLOSE_TIMEOUT" });
  await assert.rejects(startedEarly, { code: "PROBE_CLOSE_TIMEOUT" });
  assert.equal(f.service.asyncDiagnostics().children, 1, "unconfirmed child ownership survives timeout");
  f.calls[0].finish(); f.calls[0].close(); assert.equal(await old, null);
  assert.equal(f.writes.length, 0);
  await f.service.start();
  const fresh = f.service.probeCachedAsync(source("after-stop"));
  await until(() => f.calls.length === 2, "confirmed closure allows a later start");
  const nextStop = f.service.stop();
  const staleStart = f.service.start();
  f.service.beginStop();
  f.calls[1].close(); await fresh; await nextStop;
  await assert.rejects(staleStart, { code: "PROBE_STOPPED" });
  assert.equal(f.service.asyncDiagnostics().stopping, true);
  await f.service.start();
  await f.service.stop();
}

async function verifyActualShutdown() {
  let child, closed = false, ready = false;
  const exits = [];
  const f = fixture({ execFileFn: (_exe, _args, options, callback) => {
    child = execFile(process.execPath, ["-e", "process.stdout.write('ready');setInterval(()=>{},1000)"], options, callback);
    child.stdout.on("data", () => { ready = true; });
    child.once("close", () => { closed = true; });
    return child;
  } });
  const host = createServerHost({ requestHandler: () => {}, port: 0, host: "127.0.0.1",
    getLibraryState: () => ({ availableRoots: [], missingRoots: [] }),
    createServer: () => ({ close: (callback) => callback() }),
    processRef: { exit: (code) => { assert.equal(closed, true, "host exit requires actual child close"); exits.push(code); } },
    logger: { log() {}, error() {} }, beginStop: f.service.beginStop, stop: f.service.stop });
  const task = f.service.probeCachedAsync(source("actual-node"));
  try {
    await until(() => ready, "actual disposable child is running");
    await host.shutdown("fixture");
    assert.deepEqual(exits, [0]); assert.equal(await task, null);
    assert.equal(f.service.asyncDiagnostics().children, 0);
  } finally {
    if (child && !closed) { child.kill("SIGKILL"); await new Promise((resolve) => child.once("close", resolve)); }
    await f.service.stop();
  }
}

await verifySharedCapacity();
await verifyDefaultBurst();
await verifyPromotionAndSnapshot();
await verifyStatBoundaries();
await verifyRequiredPlaybackSource();
await verifyPlaybackSourceCancellation();
await verifyProcessClosure();
await verifyLifecycle();
await verifyActualShutdown();
console.log("Video probe shared capacity, foreground priority, verified playback sources, filesystem bounds, actual process closure and shutdown checks passed.");
