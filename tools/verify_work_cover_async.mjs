import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import http from "node:http";
import { DatabaseSync } from "node:sqlite";
import { extractCoverFrameAsync, probeVideoDurationAsync } from "../lib/cover-frame.js";
import { createWorkCoverMutationService } from "../src/modules/fanhao/server/works/work-cover-mutation-service.js";
import { createWorkMutationService } from "../src/modules/fanhao/server/works/work-mutation-service.js";
import { routeWorksApi } from "../src/modules/fanhao/server/works/routes-api.js";

// Production process/service/HTTP code with controlled children and private
// in-memory SQLite. No executable, real media, service or application DB is used.
const jpeg = Buffer.from([0xff, 0xd8, 1, 2, 0xff, 0xd9]);
const immediate = () => new Promise((resolve) => setImmediate(resolve));
const capture = (promise) => promise.then((value) => ({ value }), (error) => ({ error }));
const unhandled = [];
const onUnhandled = (error) => unhandled.push(error);
process.on("unhandledRejection", onUnhandled);

function children() {
  const calls = [];
  let active = 0, peak = 0;
  const spawnFn = (executable, args, options) => {
    const child = new EventEmitter();
    Object.assign(child, { executable, args, options, stdout: new EventEmitter(), stderr: new EventEmitter(), killed: false, closed: false });
    child.kill = (signal) => { child.killed = true; child.killSignal = signal; return true; };
    child.finish = (output = jpeg, status = 0) => {
      assert.equal(child.closed, false);
      if (output?.length) child.stdout.emit("data", output);
      child.closed = true; active--; child.emit("close", status);
    };
    calls.push(child); peak = Math.max(peak, ++active);
    return child;
  };
  return { calls, spawnFn, active: () => active, peak: () => peak };
}

async function until(predicate, label) {
  for (let index = 0; index < 100 && !predicate(); index++) await new Promise((resolve) => setTimeout(resolve, 2));
  assert(predicate(), label);
}

async function verifyChildBoundaries() {
  const cold = children();
  const task = capture(extractCoverFrameAsync("fixture-video", { spawnFn: cold.spawnFn, ffprobePath: "fixture-probe", ffmpegPath: "fixture-frame" }));
  assert.equal(cold.calls[0].executable, "fixture-probe", "unknown duration must spawn an asynchronous probe, never the synchronous fallback");
  let settled = false; task.then(() => { settled = true; });
  await immediate(); assert.equal(settled, false, "the event loop must be available during the cold probe");
  cold.calls[0].finish(Buffer.from('{"format":{"duration":"100"}}'));
  await until(() => cold.calls.length === 2, "probe close must start extraction");
  assert.equal(cold.calls[1].args[cold.calls[1].args.indexOf("-ss") + 1], "8");
  cold.calls[1].finish(); assert.deepEqual((await task).value, jpeg); assert.equal(cold.peak(), 1);

  for (const reason of ["abort", "timeout", "size", "error", "pipe-error"]) {
    const f = children(), controller = new AbortController();
    const result = capture(extractCoverFrameAsync("fixture-video", { duration: 0, spawnFn: f.spawnFn, signal: controller.signal, maxBytes: 8, timeoutMs: reason === "timeout" ? 5 : 1000 }));
    let done = false; result.then(() => { done = true; });
    const child = f.calls[0];
    if (reason === "abort") controller.abort();
    if (reason === "size") child.stdout.emit("data", Buffer.alloc(9));
    if (reason === "error") child.emit("error", new Error("controlled spawn error"));
    if (reason === "pipe-error") child.stdout.emit("error", new Error("controlled pipe error"));
    if (reason === "timeout") await new Promise((resolve) => setTimeout(resolve, 12));
    await immediate(); assert.equal(child.killed, true, `${reason} must kill the child`); assert.equal(child.killSignal, "SIGKILL");
    assert.equal(done, false, `${reason} must wait for close before releasing the process slot`);
    child.finish(null, null);
    const { error } = await result; assert(error);
    if (reason === "abort") assert.equal(error.name, "AbortError");
    if (reason === "timeout") assert.equal(error.code, "COVER_TIMEOUT");
  }
  for (const [output, status, message] of [[Buffer.from("invalid"), 0, /JPEG/], [null, 1, /抽帧失败/]]) {
    const f = children(); const task = capture(extractCoverFrameAsync("fixture-video", { duration: 1, spawnFn: f.spawnFn }));
    f.calls[0].stderr.emit("data", Buffer.alloc(100_000, 120)); f.calls[0].finish(output, status);
    assert.match((await task).error.message, message);
    assert((await task).error.message.length < 66_000, "stderr diagnostics must remain bounded");
  }
  const unavailable = children(); const probe = probeVideoDurationAsync("fixture", { spawnFn: unavailable.spawnFn });
  unavailable.calls[0].finish(null, 1); assert.equal(await probe, null, "unavailable probe must retain duration fallback compatibility");
  const beforeAbort = children(), controller = new AbortController(); controller.abort();
  assert.equal((await capture(extractCoverFrameAsync("fixture", { spawnFn: beforeAbort.spawnFn, signal: controller.signal }))).error.name, "AbortError");
  assert.equal(beforeAbort.calls.length, 0, "an already-cancelled request must not spawn");
}

function fixture(options = {}) {
  const db = new DatabaseSync(":memory:");
  db.exec(`ATTACH DATABASE ':memory:' AS fanhao_images;
    CREATE TABLE fanhao_images.images (
      id INTEGER PRIMARY KEY, owner_type TEXT, owner_id INTEGER, kind TEXT, source_type TEXT,
      local_path TEXT, remote_url TEXT, mime TEXT, image_blob BLOB, byte_size INTEGER, sort_order INTEGER,
      status TEXT, source TEXT, legacy_table TEXT, legacy_key TEXT, created_at TEXT, updated_at TEXT
    );
    CREATE UNIQUE INDEX fanhao_images.unique_asset ON images(owner_type, owner_id, kind, source_type, COALESCE(remote_url, ''), COALESCE(local_path, ''), sort_order);`);
  const f = children(), manual = new Map(), disk = new Map();
  const works = new Map(Array.from({ length: 8 }, (_, index) => {
    const id = String(index + 1), video = { id: `video-${id}`, path: `fixture-${id}.mp4`, relativePath: `${id}.mp4`, size: 10, modifiedAt: "2026-10-04" };
    disk.set(video.path, { size: 10, mtimeMs: 1, isFile: () => true });
    return [id, { id, title: `Work ${id}`, videos: [video] }];
  }));
  let invalidations = 0;
  const coverRow = (id) => db.prepare("SELECT id, image_blob, source_type, source FROM fanhao_images.images WHERE owner_id = ? AND kind = 'cover' ORDER BY id DESC LIMIT 1").get(Number(id));
  const service = createWorkCoverMutationService({
    ffprobePath: "fixture-probe", ffmpegPath: "fixture-frame", getCoreDb: () => db, getWorks: () => [...works.values()], resolveWork: (id) => works.get(String(id)),
    manualCoverStamp: (work) => JSON.stringify(manual.get(work.id)), spawnFn: f.spawnFn,
    stat: async (filePath) => { const value = disk.get(filePath); if (!value) throw Object.assign(new Error("missing fixture"), { code: "ENOENT" }); return value; },
    safeStat: () => assert.fail("generation must not stat synchronously"),
    videoProbeService: { probeCached: () => assert.fail("generation must not cold-probe synchronously") },
    publicCoreWorkCover: (id) => coverRow(id) ? { id: String(coverRow(id).id), generated: true } : null,
    publicWorkCover: (row) => row, workCoverRow: coverRow,
    invalidateWorkImageCache() { invalidations++; }, workInfoService: { invalidate() {} }, resetWorkSearch() {}, ...options
  });
  const mutation = createWorkMutationService({
    generateWorkCover: service.generateWorkCover, cancelCoverGeneration: service.cancelWork,
    resolveLibraryWorkByPublicId: (id) => works.get(String(id)), publicWork: (work) => ({ id: work.id, title: work.title }),
    manualCoverStateService: { setWorkManualCover(id, imageId) { manual.set(String(id), { imageId, updatedAt: Date.now() }); return { manualCoverId: imageId }; } }
  });
  async function finishJob(id) {
    const source = works.get(String(id)).videos[0].path;
    const probe = f.calls.find((child) => !child.closed && child.executable === "fixture-probe" && child.args.at(-1) === source);
    assert(probe, `missing probe for ${id}`); probe.finish(Buffer.from('{"format":{"duration":20}}'));
    await until(() => f.calls.some((child) => !child.closed && child.executable === "fixture-frame" && child.args.includes(source)), "frame must start after probe close");
    f.calls.find((child) => !child.closed && child.executable === "fixture-frame" && child.args.includes(source)).finish();
  }
  async function close() { service.beginStop(); for (const child of f.calls) if (!child.closed) child.finish(null, null); await service.stop(); db.close(); }
  return { ...f, db, works, disk, manual, service, mutation, coverRow, invalidations: () => invalidations, finishJob, close };
}

async function verifyMutationQueue() {
  const f = fixture({ generationConcurrency: 2, generationCapacity: 4 });
  try {
    const first = capture(f.mutation.generateCover("1")), same = capture(f.mutation.generateCover("1"));
    await until(() => f.calls.length === 1, "single-flight must dispatch one cold probe");
    assert.equal(f.calls.length, 1);
    const more = [2, 3, 4].map((id) => capture(f.mutation.generateCover(String(id))));
    const full = await capture(f.mutation.generateCover("5")); assert.equal(full.error.statusCode, 503);
    await immediate(); assert.equal(f.active(), 2, "probe/frame concurrency must be bounded together");
    await f.finishJob("1");
    const [a, b] = await Promise.all([first, same]);
    assert.deepEqual(a.value, b.value); assert.equal(a.value.ok, true); assert.equal(a.value.work.id, "1");
    assert.equal(f.invalidations(), 1, "merged consumers must commit and invalidate only once");
    assert.equal(f.db.prepare("SELECT count(*) AS count FROM fanhao_images.images WHERE owner_id=1").get().count, 1);
    await f.finishJob("2"); await until(() => f.calls.some((child) => child.args.at(-1) === "fixture-3.mp4"), "queue must drain after a child closes");
    await f.finishJob("3"); await f.finishJob("4"); await Promise.all(more); assert(f.peak() <= 2);
  } finally { await f.close(); }

  for (const ambiguous of [false, true]) {
    let f, commitAttempts = 0;
    const database = {
      prepare: (...args) => f.db.prepare(...args),
      exec(sql) {
        if (sql === "COMMIT") {
          commitAttempts++;
          if (ambiguous) f.db.exec(sql);
          throw new Error("controlled commit failure");
        }
        return f.db.exec(sql);
      }
    };
    f = fixture({ getCoreDb: () => database });
    try {
      const pending = capture(f.mutation.generateCover("1")); await until(() => f.calls.length === 1, "commit failure must start probe");
      await f.finishJob("1"); const result = await pending; assert(result.error);
      assert.equal(commitAttempts, 1, "a failed or unknown commit must never be retried automatically");
      assert.equal(f.calls.length, 2, "an unknown write outcome must not restart probe/extraction");
      assert.equal(f.db.prepare("SELECT count(*) AS count FROM fanhao_images.images").get().count, ambiguous ? 1 : 0);
      if (ambiguous) assert(result.error instanceof AggregateError, "failed rollback must report that the commit outcome could not be confirmed");
      assert.equal(f.invalidations(), 0);
    } finally { await f.close(); }
  }

  let releaseStat, lastStatArrived, statCount = 0;
  const lastStat = new Promise((resolve) => { lastStatArrived = resolve; });
  const replaceWhileChecking = fixture({ stat: async () => {
    if (++statCount === 3) { lastStatArrived(); return new Promise((resolve) => { releaseStat = resolve; }); }
    return { size: 10, mtimeMs: 1 };
  } });
  try {
    const pending = capture(replaceWhileChecking.mutation.generateCover("1"));
    await until(() => replaceWhileChecking.calls.length === 1, "last-stat fixture must start probe");
    await replaceWhileChecking.finishJob("1"); await lastStat;
    replaceWhileChecking.works.set("1", { id: "1", videos: [{ id: "new-video", path: "new-source.mp4" }] });
    releaseStat({ size: 10, mtimeMs: 1 });
    assert.equal((await pending).error.statusCode, 409, "library replacement during the final async stat must be checked after awaiting it");
    assert.equal(replaceWhileChecking.coverRow("1"), undefined);
  } finally { releaseStat?.({ size: 10, mtimeMs: 1 }); await replaceWhileChecking.close(); }

  for (const conflict of ["manual", "source", "disk", "image"]) {
    const f = fixture();
    try {
      const task = capture(f.mutation.generateCover("1")); await until(() => f.calls.length === 1, "conflict fixture must start probe");
      if (conflict === "manual") f.manual.set("1", { imageId: "manual-new" });
      if (conflict === "source") f.works.get("1").videos[0].relativePath = "changed.mp4";
      if (conflict === "disk") f.disk.set("fixture-1.mp4", { size: 11, mtimeMs: 2 });
      if (conflict === "image") f.db.prepare("INSERT INTO fanhao_images.images (owner_type,owner_id,kind,source_type,source,updated_at) VALUES ('work',1,'cover','local','manual','new')").run();
      await f.finishJob("1"); const result = await task;
      assert.equal(result.error.statusCode, 409, `${conflict} changed during generation must reject stale commit`);
      assert.equal(f.db.prepare("SELECT count(*) AS count FROM fanhao_images.images WHERE source_type='generated'").get().count, 0);
      assert.equal(f.invalidations(), 0);
    } finally { await f.close(); }
  }

  const manual = fixture();
  try {
    const task = capture(manual.mutation.generateCover("1")); await until(() => manual.calls.length === 1, "manual cancellation must start probe");
    manual.mutation.setManualCover("1", { imageId: "manual" }); assert(manual.calls[0].killed);
    manual.calls[0].finish(null, null); assert.equal((await task).error.name, "AbortError"); assert.equal(manual.coverRow("1"), undefined);
  } finally { await manual.close(); }

  const cancelled = fixture();
  try {
    const controller = new AbortController();
    const cancelledConsumer = capture(cancelled.mutation.generateCover("1", { signal: controller.signal }));
    const liveConsumer = capture(cancelled.mutation.generateCover("1")); await until(() => cancelled.calls.length === 1, "duplicate cancellation must start probe");
    controller.abort(); assert.equal(cancelled.calls[0].killed, false, "one disconnected duplicate must not cancel another consumer");
    await cancelled.finishJob("1"); assert.equal((await cancelledConsumer).error.name, "AbortError"); assert.equal((await liveConsumer).value.ok, true);
    const active = capture(cancelled.mutation.generateCover("2")); await until(() => cancelled.calls.some((child) => !child.closed), "stop must have an active child");
    const queued = [3, 4, 5].map((id) => capture(cancelled.mutation.generateCover(String(id))));
    await immediate(); let stopped = false;
    const stopping = cancelled.service.stop().then(() => { stopped = true; }); await immediate();
    assert.equal(stopped, false, "stop must retain live child ownership until close");
    const dispatched = cancelled.calls.length;
    assert.equal((await capture(cancelled.mutation.generateCover("6"))).error.statusCode, 503);
    for (const child of cancelled.calls) if (!child.closed) { assert(child.killed); child.finish(null, null); }
    await Promise.all([active, ...queued, stopping]); assert.equal(cancelled.calls.length, dispatched, "stop must not dispatch queued jobs");
    assert.equal(cancelled.active(), 0);
  } finally { await cancelled.close(); }
}

async function verifyHttpHealthAndDisconnect() {
  const f = fixture(); let routeWrites = 0;
  const deps = { workMutationService: f.mutation, requireLocalAdmin: () => true,
    notFound(res) { res.writeHead(404); res.end(); },
    sendJson(res, status, payload) { assert.equal(res.destroyed, false); routeWrites++; res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(payload)); } };
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://fixture");
    if (url.pathname === "/health") { res.end("ready"); return; }
    try { if (!await routeWorksApi(req, res, url, deps)) deps.notFound(res); }
    catch (error) { res.destroy(error); }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const pending = fetch(`${base}/api/works/1/cover/generate`, { method: "POST" });
    await until(() => f.calls.length === 1, "HTTP generate must await cold probe");
    const health = await fetch(`${base}/health`); assert.equal(await health.text(), "ready"); assert.equal(routeWrites, 0, "route must await generation before returning its payload");
    await f.finishJob("1"); const response = await pending;
    assert.equal(response.status, 200); assert.deepEqual(await response.json(), { ok: true, cover: { id: "1", generated: true }, work: { id: "1", title: "Work 1" } });
    const missing = await fetch(`${base}/api/works/999/cover/generate`, { method: "POST" }); assert.equal(missing.status, 404);
    const controller = new AbortController(); const disconnect = capture(fetch(`${base}/api/works/2/cover/generate`, { method: "POST", signal: controller.signal }));
    await until(() => f.calls.length === 3, "disconnect fixture must start a cold probe"); controller.abort(); await disconnect;
    await until(() => f.calls[2].killed, "HTTP disconnect must abort the unshared child");
    f.calls[2].finish(null, null); await immediate(); assert.equal(routeWrites, 1, "disconnected generation must never write a late response"); assert.equal(f.coverRow("2"), undefined);
    const failed = fetch(`${base}/api/works/3/cover/generate`, { method: "POST" });
    await until(() => f.calls.length === 4, "HTTP error fixture must start probe");
    f.calls[3].finish(Buffer.from('{"format":{"duration":20}}'));
    await until(() => f.calls.length === 5, "HTTP error fixture must start frame");
    f.calls[4].stderr.emit("data", Buffer.from("controlled decoder failure")); f.calls[4].finish(null, 1);
    const failedResponse = await failed; assert.equal(failedResponse.status, 500);
    const failedPayload = await failedResponse.json(); assert.match(failedPayload.error, /controlled decoder failure/); assert.equal(failedPayload.work.id, "3");
    assert.equal(f.coverRow("3"), undefined);
  } finally { await f.close(); await new Promise((resolve) => server.close(resolve)); }
}

try {
  await verifyChildBoundaries(); await verifyMutationQueue(); await verifyHttpHealthAndDisconnect(); await immediate();
  assert.deepEqual(unhandled, []);
  console.log("work-cover-async: ok (cold probe/HTTP health, bounded queue, duplicate consumers, kill-and-close, timeout/size/errors, source/manual/image conflicts, disconnect, shutdown, SQLite commit/rollback/unknown outcome)");
} finally { process.off("unhandledRejection", onUnhandled); }
