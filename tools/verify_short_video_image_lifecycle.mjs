import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { EventEmitter, getEventListeners } from "node:events";
import { Readable, PassThrough } from "node:stream";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";
import { createMediaResponseService } from "../src/platform/server/media-response-service.js";
import { localImageDiskIdentity } from "../src/platform/server/local-image-read-queue.js";
import { createFileServer } from "../src/platform/server/file-server.js";

// Actual runtime source, with only its persistent store/background services
// replaced. Image serving and the admission/cancellation code remain intact.
// No directory, database, credential, image file or background process is used.
const legacy = process.argv.includes("--legacy");
const withoutResponseSourceGuard = process.argv.includes("--without-response-source-guard");
const legacyProductInline = process.argv.includes("--legacy-product-inline");
const withoutGalleryVideoSignal = process.argv.includes("--without-gallery-video-signal");
const runtimePath = path.resolve("src/modules/short-videos/server/runtime.js");
let runtimeSource = legacy
  ? execFileSync("git", ["show", "HEAD:src/modules/short-videos/server/runtime.js"], { encoding: "utf8" })
  : fs.readFileSync(runtimePath, "utf8");
if (withoutGalleryVideoSignal) {
  const forwarding = "await mediaStreamService.serveVideo(req, res, file, { signal });";
  assert.ok(runtimeSource.includes(forwarding));
  runtimeSource = runtimeSource.replace(forwarding, "await mediaStreamService.serveVideo(req, res, file);");
}
const owner = `shortVideoImageFixture${process.pid}`;
globalThis[owner] = {};
for (const [importName, field] of [["createShortVideoStore", "store"], ["createShortVideoWatchWriteService", "writer"], ["createDownloadManagerSyncService", "sync"]]) {
  const pattern = new RegExp(`import \\{ ${importName} \\} from \\"[^\\"]+\\";`);
  assert.ok(pattern.test(runtimeSource), `${importName}: actual runtime dependency must be found`);
  runtimeSource = runtimeSource.replace(pattern, `const ${importName} = () => globalThis[${JSON.stringify(owner)}].${field};`);
}
runtimeSource = absoluteImports(runtimeSource, runtimePath);
const { createShortVideosRuntime } = await import(`data:text/javascript;base64,${Buffer.from(runtimeSource).toString("base64")}`);
let legacyMediaFactory;
if (legacy) {
  const source = execFileSync("git", ["show", "HEAD:src/platform/server/media-response-service.js"], { encoding: "utf8" });
  const module = await import(`data:text/javascript;base64,${Buffer.from(absoluteImports(source, path.resolve("src/platform/server/media-response-service.js"))).toString("base64")}`);
  legacyMediaFactory = module.createMediaResponseService;
} else if (withoutResponseSourceGuard) {
  const file = path.resolve("src/platform/server/media-response-service.js");
  let source = fs.readFileSync(file, "utf8");
  const guard = "if (!options.requireCurrentSource) return true;";
  assert.ok(source.includes(guard));
  source = source.replace(guard, "return true; // Controlled missing final response-source guard.");
  ({ createMediaResponseService: legacyMediaFactory } = await import(`data:text/javascript;base64,${Buffer.from(absoluteImports(source, file)).toString("base64")}`));
}
const originalReadSync = fs.readFileSync;
const unhandled = [], onUnhandled = error => unhandled.push(error);
process.on("unhandledRejection", onUnhandled);
let checks = 0;
try {
  await run("local cover and gallery warm requests reuse one identity-matched cache write", async () => {
    const f = fixture();
    try {
      for (const kind of ["cover", "gallery"]) {
        const first = response(); await f.route(first, kind, "warm");
        assert.equal(first.status, 200); assert.equal(first.headers["Content-Type"], "image/jpeg");
        const before = f.state.reads;
        for (let i = 0; i < 4; i++) await f.route(response(), kind, "warm");
        assert.equal(f.state.reads, before, `${kind}: warm requests must not read the source again`);
      }
      assert.equal(f.state.reads, 2); assert.equal(f.state.writes, 2);
      assert.equal(f.state.syncReads, 0, "actual short-video routes must not call readFileSync");
    } finally { await f.close(); }
  });
  await run("cold same-source requests coalesce; disconnecting one preserves the live consumer", async () => {
    const gate = deferred(), f = fixture({ read: async () => { await gate.promise; return Buffer.from("IMAGE"); } });
    try {
      const a = response(), b = response(), req = request();
      const one = f.route(a, "cover", "shared", req), two = f.route(b, "cover", "shared");
      await until(() => f.state.reads === 1);
      req.aborted = true; req.emit("aborted");
      assert.equal(f.state.readSignals[0].aborted, false, "a shared live response owns the read");
      gate.resolve(); await Promise.all([one, two]);
      assert.equal(a.status, undefined); assert.equal(b.status, 200); assert.equal(f.state.reads, 1);
      assert.equal(req.listenerCount("aborted"), 0); assert.equal(a.listenerCount("close"), 0);
    } finally { gate.resolve(); await f.close(); }
  });
  await run("gallery HEAD has current length and no image body/read; video and SQLite covers retain their contracts", async () => {
    const f = fixture();
    try {
      const head = response(); await f.route(head, "gallery", "head", request("HEAD"));
      assert.equal(head.status, 200); assert.equal(head.headers["Content-Length"], 5); assert.equal(head.body, undefined); assert.equal(f.state.reads, 0);
      f.source("gallery", "video").type = "video";
      const video = response(); await f.route(video, "gallery", "video");
      assert.equal(video.status, 206); assert.equal(f.state.streams, 1); assert.equal(f.state.reads, 0);
      const blob = f.source("cover", "blob"); blob.buffer = Buffer.from("BLOB"); blob.cacheVersion = "receipt-version";
      const res = response(); await f.route(res, "cover", "blob");
      assert.equal(res.status, 200); assert.strictEqual(res.body, blob.buffer, "owned Buffer need not be copied");
      assert.equal(res.headers["Cache-Control"], "private, max-age=31536000, immutable"); assert.equal(res.headers.ETag, '"receipt-version"');
      assert.equal(f.state.reads, 0);
    } finally { await f.close(); }
  });
  await run("current missing/empty/stat/read errors complete; read failure can retry", async () => {
    let fail = true;
    const f = fixture({ read: async () => { if (fail) throw Object.assign(new Error("denied"), { code: "EACCES" }); return Buffer.from("IMAGE"); } });
    try {
      f.source("cover", "missing").missing = true;
      const missing = response(); await f.route(missing, "cover", "missing"); assert.equal(missing.status, 404);
      f.source("cover", "stat-error").statError = true;
      const statError = response(); await f.route(statError, "cover", "stat-error"); assert.equal(statError.status, 500);
      const bad = response(); await f.route(bad, "cover", "retry"); assert.equal(bad.status, 500);
      fail = false;
      const next = response(); await f.route(next, "cover", "retry"); assert.equal(next.status, 200);
      f.source("cover", "empty").size = 0;
      const empty = response(); await f.route(empty, "cover", "empty"); assert.equal(empty.status, 404);
      assert.equal(f.state.reads, 2, "empty/missing metadata must not read bytes");
    } finally { await f.close(); }
  });
  await run("128 total / four active bound includes metadata, queued cancellation and overflow", async () => {
    const gate = deferred(), f = fixture({ metadata: async () => gate.promise });
    try {
      const responses = Array.from({ length: 129 }, () => response());
      const pending = responses.map((res, i) => f.route(res, "cover", `capacity-${i}`));
      await immediate();
      assert.equal(f.state.producers, 4); assert.deepEqual(f.runtime.imageReaderDiagnostics(), { accepting: true, active: 4, pending: 124, tasks: 128 });
      assert.equal(responses[128].status, 503);
      responses[50].destroyed = true; responses[50].emit("close"); await pending[50];
      assert.deepEqual(f.runtime.imageReaderDiagnostics(), { accepting: true, active: 4, pending: 123, tasks: 127 });
      assert.equal(f.state.producers, 4, "cancelled queued metadata must never start");
      gate.resolve(); await Promise.all(pending);
      assert.equal(f.state.peakProducers, 4); assert.ok(f.state.peakReads <= 4); assert.equal(f.state.producers, 127);
      assert.deepEqual(f.runtime.imageReaderDiagnostics(), { accepting: true, active: 0, pending: 0, tasks: 0 });
    } finally { gate.resolve(); await f.close(); }
  });
  await run("cancelled active metadata retains its slot; a late error neither responds nor writes", async () => {
    const gate = deferred(), f = fixture({ metadata: async () => { await gate.promise; throw new Error("late metadata error"); } });
    try {
      const responses = Array.from({ length: 5 }, () => response()), pending = responses.map((res, i) => f.route(res, "cover", `meta-${i}`));
      await immediate(); responses[0].destroyed = true; responses[0].emit("close");
      await immediate(); assert.equal(f.state.producers, 4); assert.equal(f.runtime.imageReaderDiagnostics().active, 4);
      gate.resolve(); await Promise.all(pending);
      assert.equal(responses[0].status, undefined); assert.equal(responses[1].status, 500); assert.equal(f.state.writes, 0);
      for (const res of responses) assert.equal(res.listenerCount("close"), 0);
    } finally { gate.resolve(); await f.close(); }
  });
  await run("cancelled physical read retains capacity until settle; fresh same-key retry does not inherit abort", async () => {
    const gate = deferred(), f = fixture({ read: async () => { await gate.promise; return Buffer.from("IMAGE"); } });
    try {
      const old = response(), next = response(), first = f.route(old, "cover", "cancel-retry");
      await until(() => f.state.reads === 1); old.destroyed = true; old.emit("close");
      const fresh = f.route(next, "cover", "cancel-retry"); await immediate();
      assert.equal(f.state.reads, 1); assert.equal(f.images.localImageReaderDiagnostics().tasks, 2);
      gate.resolve(); await Promise.all([first, fresh]);
      assert.equal(old.status, undefined); assert.equal(next.status, 200); assert.equal(f.state.reads, 2); assert.equal(f.state.writes, 1);
    } finally { gate.resolve(); await f.close(); }
  });
  await run("stale producer result cannot serve an old warm cache entry", async () => {
    const f = fixture();
    try {
      await f.route(response(), "cover", "old-warm");
      const source = f.source("cover", "old-warm"), old = f.file(source);
      f.state.metadataResult = old; source.current = false;
      const res = response(); await f.route(res, "cover", "old-warm");
      assert.equal(res.status, 404); assert.equal(f.state.reads, 1); assert.equal(f.state.writes, 1);
    } finally { await f.close(); }
  });
  await run("same path/size/date with a new inode or sub-millisecond stamp misses the warm cache", async () => {
    const f = fixture();
    try {
      await f.route(response(), "cover", "physical");
      const value = f.source("cover", "physical"); value.ino = 2;
      await f.route(response(), "cover", "physical"); assert.equal(f.state.reads, 2);
      const oldDate = new Date(value.mtimeMs).toISOString(); value.mtimeMs += 0.25;
      assert.equal(new Date(value.mtimeMs).toISOString(), oldDate);
      await f.route(response(), "cover", "physical"); assert.equal(f.state.reads, 3);
      await f.route(response(), "cover", "physical"); assert.equal(f.state.reads, 3);
    } finally { await f.close(); }
  });
  for (const failing of [false, true]) await run(`late ${failing ? "error" : "success"} cannot overwrite a changed source/cache`, async () => {
    const gate = deferred(); let slow = true;
    const f = fixture({ read: async () => { if (slow) { await gate.promise; if (failing) throw new Error("old failure"); return Buffer.from("OLD!!"); } return Buffer.from("NEW!!"); } });
    try {
      const old = response(), pending = f.route(old, "cover", "changed"); await until(() => f.state.reads === 1);
      const prior = f.source("cover", "changed"); prior.current = false;
      const changed = { ...prior, current: true, mtimeMs: prior.mtimeMs + 1, path: "/controlled/changed-new.jpg" }; f.state.sources.set("cover:changed:0", changed); slow = false;
      const fresh = response(); await f.route(fresh, "cover", "changed"); assert.equal(fresh.status, 200);
      const before = { ...f.state.cache.get(changed.id) };
      gate.resolve(); await pending;
      assert.deepEqual(f.state.cache.get(changed.id), before, "old success/error must preserve new source BLOB and stamp");
      assert.equal(old.status, 404, "old success/error must not publish after the request's source has changed");
      assert.equal(old.body, undefined, "stale 404 must contain neither old image bytes nor the old read error");
      assert.equal(f.state.writes, 1);
    } finally { gate.resolve(); await f.close(); }
  });
  for (const change of ["logical-delete", "database-owner"]) await run(`${change} during read prevents a stale HTTP image`, async () => {
    const gate = deferred(), f = fixture({ read: async () => { await gate.promise; return Buffer.from("OLD!!"); } });
    try {
      const res = response(), pending = f.route(res, "gallery", "retired");
      await until(() => f.state.reads === 1);
      if (change === "logical-delete") f.source("gallery", "retired").current = false;
      else f.state.ownerEpoch++;
      gate.resolve(); await pending;
      assert.equal(res.status, 404); assert.equal(res.body, undefined); assert.equal(f.state.writes, 0);
    } finally { gate.resolve(); await f.close(); }
  });
  await run("runtime stop drains ignored abort, rejects queued/new requests and fences an older waiting start", async () => {
    const gate = deferred(), f = fixture({ metadata: async () => gate.promise });
    try {
      const responses = Array.from({ length: 5 }, () => response()), pending = responses.map((res, i) => f.route(res, "cover", `stop-${i}`));
      await immediate(); let stopped = false;
      const stop = f.runtime.stop().then(() => { stopped = true; });
      const staleStart = f.runtime.start(); f.runtime.stop(); await immediate();
      assert.equal(stopped, false); assert.equal(responses[4].status, 503); assert.equal(f.runtime.imageReaderDiagnostics().active, 4);
      const later = response(); await f.route(later, "cover", "stopped"); assert.equal(later.status, 503);
      gate.resolve(); await Promise.all([...pending, stop]); assert.equal(await staleStart, false);
      assert.equal(f.state.reads, 0); assert.equal(f.state.writes, 0); assert.equal(f.runtime.imageReaderDiagnostics().accepting, false);
      assert.ok(responses.slice(0, 4).every(res => res.status === undefined));
      assert.equal(await f.runtime.start(), true);
      const fresh = response(); await f.route(fresh, "cover", "reopened"); assert.equal(fresh.status, 200);
    } finally { gate.resolve(); await f.close(); }
  });
  await run("beginStop during physical read waits for settle even when a background stop rejects", async () => {
    const gate = deferred(), f = fixture({ read: async () => { await gate.promise; return Buffer.from("IMAGE"); } });
    try {
      const res = response(), pending = f.route(res, "cover", "read-stop");
      await until(() => f.state.reads === 1);
      f.state.writerStopError = true;
      const firstStop = f.runtime.beginStop();
      assert.strictEqual(f.runtime.stop(), firstStop, "product beginStop then stop must share the same drain/epoch");
      let settled = false; const stopping = firstStop.then(() => null, error => error).finally(() => { settled = true; });
      await immediate(); assert.equal(settled, false); assert.equal(f.runtime.imageReaderDiagnostics().active, 1);
      assert.equal(f.state.readSignals[0].aborted, true); assert.equal(f.images.localImageReaderDiagnostics().active, 1);
      gate.resolve(); await pending; assert.equal((await stopping).message, "controlled background stop failure");
      assert.equal(res.status, undefined); assert.equal(f.state.writes, 0); assert.equal(res.listenerCount("close"), 0);
      assert.deepEqual(f.runtime.imageReaderDiagnostics(), { accepting: false, active: 0, pending: 0, tasks: 0 });
      f.state.writerStopError = false; await f.runtime.start();
      const fresh = response(); await f.route(fresh, "cover", "read-restarted"); assert.equal(fresh.status, 200);
    } finally { f.state.writerStopError = false; gate.resolve(); await f.close(); }
  });
  await run("actual configured product retains four of 128 slots through stream and physical handle close", async () => {
    const body = deferred(), close = deferred(), f = await productFixture({ bodyGate: body, closeGate: close });
    try {
      const head = streamResponse(); await f.route(head, "gallery", "head", request("HEAD"));
      assert.equal(head.status, 200); assert.equal(head.headers["Content-Length"], 5); assert.equal(f.io.opens, 0);
      const responses = Array.from({ length: 129 }, () => streamResponse());
      const pending = responses.map((res, i) => f.route(res, "cover", `fd-${i}`));
      await until(() => f.io.streams >= 4); await immediate(); await immediate();
      assert.equal(f.io.opens, 4, "actual main product must not launch all inline streams after awaiting a boolean");
      assert.deepEqual(f.product.imageReaderDiagnostics(), { accepting: true, active: 4, pending: 124, tasks: 128 });
      assert.equal(responses[128].status, 503);
      body.resolve(); await until(() => f.io.closeStarts === 4);
      assert.ok(responses.slice(0, 4).every(res => res.writableFinished));
      assert.equal(f.io.closed, 0); assert.equal(f.io.opens, 4, "response finish must not release an unclosed file handle");
      assert.equal(f.product.imageReaderDiagnostics().active, 4);
      close.resolve(); await Promise.all(pending);
      assert.equal(f.io.peak, 4); assert.equal(f.io.closed, 128); assert.equal(f.io.streams, 128); assert.equal(f.state.writes, 0, "independent product must not adopt a FanHao BLOB cache");
      assert.ok(responses.slice(0, 128).every(res => res.status === 200 && Buffer.concat(res.chunks).toString() === "IMAGE"));
      assert.deepEqual(responses[0].headers, { "Content-Type": "image/jpeg", "Content-Length": 5, "Cache-Control": "public, max-age=3600", "Content-Disposition": "inline" });
    } finally { body.resolve(); close.resolve(); await f.close(); }
  });
  for (const stage of ["open", "stat"]) await run(`configured product disconnect during ignored ${stage} waits for actual close and stop`, async () => {
    const open = deferred(), stat = deferred(), close = deferred();
    const f = await productFixture({ ...(stage === "open" ? { openGate: open } : { statGate: stat }), closeGate: close });
    try {
      const res = streamResponse(), pending = f.route(res, "cover", `cancel-${stage}`);
      await until(() => stage === "open" ? f.io.opens === 1 : f.io.stats === 1); res.destroy(); await immediate();
      open.resolve(); stat.resolve(); await until(() => f.io.closeStarts === 1);
      assert.equal(f.io.streams, 0); if (stage === "open") assert.equal(f.io.stats, 0, "late cancelled open must not dispatch another stat");
      let stopped = false; const stopping = f.product.beginStop().then(() => { stopped = true; });
      await immediate(); assert.equal(stopped, false); assert.equal(f.product.imageReaderDiagnostics().active, 1); assert.equal(f.io.closed, 0);
      close.resolve(); await Promise.all([pending, stopping]); assert.equal(f.io.closed, 1); assert.equal(res.status, undefined);
      assert.equal(res.listeners("close").filter(value => value.name === "responseClosed").length, 0);
    } finally { open.resolve(); stat.resolve(); close.resolve(); await f.close(); }
  });
  await run("configured product disconnect during body read retains its slot until stream/handle close", async () => {
    const body = deferred(), close = deferred(), f = await productFixture({ bodyGate: body, closeGate: close });
    try {
      const res = streamResponse(), pending = f.route(res, "cover", "body-disconnect");
      await until(() => f.io.streams === 1); res.destroy(); await until(() => f.io.closeStarts === 1);
      let stopped = false; const stopping = f.product.beginStop().then(() => { stopped = true; });
      await immediate(); assert.equal(stopped, false); assert.equal(f.product.imageReaderDiagnostics().active, 1);
      assert.equal(f.io.active, 1); assert.equal(f.io.closed, 0);
      body.resolve(); await immediate(); assert.equal(Buffer.concat(res.chunks).length, 0);
      close.resolve(); await Promise.all([pending, stopping]);
      assert.equal(f.io.closed, 1); assert.equal(f.product.imageReaderDiagnostics().active, 0);
      assert.equal(res.listeners("close").filter(value => value.name === "responseClosed").length, 0);
      assert.equal(f.io.signals.flatMap(signal => getEventListeners(signal, "abort")).length, 0);
    } finally { body.resolve(); close.resolve(); await f.close(); }
  });
  for (const change of ["source", "disk"]) await run(`configured product checks ${change} after same-handle stat before headers`, async () => {
    const gate = deferred(), f = await productFixture({ statGate: gate, statChanged: change === "disk" });
    try {
      const res = streamResponse(), pending = f.route(res, "gallery", `replace-${change}`);
      await until(() => f.io.stats === 1);
      if (change === "source") f.source("gallery", `replace-${change}`).current = false;
      gate.resolve(); await pending;
      assert.equal(res.status, 404); assert.equal(f.io.streams, 0); assert.equal(f.io.closed, 1);
      assert.deepEqual(JSON.parse(Buffer.concat(res.chunks).toString()), { error: "Not found" });
    } finally { gate.resolve(); await f.close(); }
  });
  await run("configured product current open/stat errors, stream failure and close rejection detach owners", async () => {
    for (const variant of ["missing", "open-error", "stat-error", "stream-throw", "read-error", "close-reject"]) {
      const f = await productFixture({ error: variant });
      try {
        const res = streamResponse(); await f.route(res, "cover", variant); await immediate();
        if (variant === "missing") assert.equal(res.status, 404);
        else if (["open-error", "stat-error"].includes(variant)) assert.equal(res.status, 500);
        else { assert.equal(res.status, 200); assert.equal(res.destroyed, true, "partial/failed streamed response must be destroyed rather than append JSON"); }
        assert.equal(f.io.active, 0); assert.equal(f.product.imageReaderDiagnostics().active, 0);
        assert.equal(res.listeners("close").filter(value => value.name === "responseClosed").length, 0);
        assert.equal(f.io.signals.flatMap(signal => getEventListeners(signal, "abort")).length, 0);
        if (variant === "close-reject") {
          assert.equal(f.product.fileServerDiagnostics().active, 1, "failed close must remain owned even when its JS descriptor is already -1");
          await assert.rejects(f.product.stop(), error => error.code === "FILE_SERVER_STOP_INCOMPLETE");
          await assert.rejects(f.product.start(), error => error.code === "FILE_SERVER_STOP_INCOMPLETE");
        }
      } finally { await f.close(); }
    }
  });
  for (const change of ["logical-delete", "database-owner", "disconnect", "runtime-stop"]) {
    await run(`actual gallery-video file open retains ownership across ${change}`, async () => {
      const savedOpen = fs.promises.open, opened = deferred(), closed = deferred();
      let opens = 0, stats = 0, closes = 0, streams = 0, closeStarted = false, signal, settled = false;
      fs.promises.open = async filePath => {
        assert.ok(String(filePath).startsWith("/controlled/")); opens++;
        await opened.promise;
        return {
          stat: async () => { stats++; return { size: 5, mtimeMs: 0, isFile: () => true }; },
          createReadStream() { streams++; assert.fail("cancelled or changed gallery video must not start a stream"); },
          close: async () => { closeStarted = true; await closed.promise; closes++; }
        };
      };
      const files = createFileServer({ mimeTypes: { ".jpg": "image/jpeg" }, normalizeExt: () => ".jpg", notFound: res => { res.writeHead(404); res.end(); } });
      const f = fixture({ videoTransport(req, res, file, options) { signal = options?.signal; return files.serveRangedFile(req, res, file, options); } });
      let stop;
      try {
        const item = f.source("gallery", "held-video"); item.type = "video";
        const res = streamResponse(), req = request();
        const job = f.route(res, "gallery", "held-video", req).finally(() => { settled = true; });
        await until(() => opens === 1);
        if (change === "logical-delete") item.current = false;
        else if (change === "database-owner") f.state.ownerEpoch++;
        else if (change === "disconnect") { req.aborted = true; req.emit("aborted"); }
        else stop = f.runtime.stop();
        await immediate();
        assert.equal(settled, false); assert.equal(f.runtime.imageReaderDiagnostics().tasks, 1);
        if (change === "runtime-stop") { assert.equal(res.destroyed, true, "runtime cancellation must reach the pending file opener"); assert.equal(signal?.aborted, true); }
        opened.resolve(); await until(() => closeStarted);
        assert.equal(settled, false, "the serving slot belongs to the physically closing handle");
        closed.resolve(); await job; await stop;
        assert.equal(closes, 1); assert.equal(stats, 0); assert.equal(streams, 0);
        if (["logical-delete", "database-owner"].includes(change)) assert.equal(res.status, 404);
        else assert.equal(res.status, undefined);
        assert.equal(f.runtime.imageReaderDiagnostics().tasks, 0);
        assert.equal(req.listenerCount("aborted"), 0); assert.equal(res.listenerCount("close"), 0);
      } finally { opened.resolve(); closed.resolve(); await stop; await f.close(); fs.promises.open = savedOpen; }
    });
  }
  await run("default Node FileHandle stream and idempotent close read only this verifier's source", async () => {
    const filePath = path.resolve(import.meta.filename), bytes = originalReadSync(filePath), stat = fs.statSync(filePath), open = fs.promises.open;
    const f = await productFixture(); let handle;
    try {
      fs.promises.open = async (...args) => { handle = await open(...args); return handle; };
      const res = streamResponse();
      await f.io.adapter(res, { path: filePath, diskIdentity: localImageDiskIdentity(filePath, stat), isCurrentSource: () => true });
      assert.equal(res.status, 200); assert.deepEqual(Buffer.concat(res.chunks), bytes); assert.equal(res.headers["Content-Length"], bytes.length);
      assert.equal(handle.fd, -1, "actual OS descriptor must be closed after its stream and idempotent finally close");
      assert.equal(res.listeners("close").filter(value => value.name === "responseClosed").length, 0);
    } finally { await f.close(); }
  });
  await run("private HTTP health completes while 18 cold images are held; normal images await full bytes", async () => {
    const gate = deferred(), f = fixture({ read: async () => { await gate.promise; return Buffer.from("IMAGE"); } });
    const server = http.createServer((req, res) => {
      const url = new URL(req.url, "http://127.0.0.1");
      if (url.pathname === "/health") { res.end("ok"); return; }
      f.runtime.routeMedia(req, res, url).catch(error => { res.writeHead(500); res.end(error.message); });
    });
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    try {
      const pending = Array.from({ length: 18 }, (_, i) => get(`${base}/media/short-video-cover/http-${i}`));
      await until(() => f.state.reads === 4); const start = performance.now();
      let timer;
      const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("health blocked on held image I/O")), 2000); });
      let health;
      try { health = await Promise.race([get(`${base}/health`), timeout]); } finally { clearTimeout(timer); }
      assert.equal(health.status, 200); assert.equal(health.body.toString(), "ok"); assert.equal(f.state.reads, 4);
      assert.equal(f.state.writes, 0); assert.equal(f.runtime.imageReaderDiagnostics().tasks, 18);
      console.log(`[diagnostic] held-image HTTP health ${(performance.now() - start).toFixed(2)}ms; 4 active / 14 queued`);
      gate.resolve(); const results = await Promise.all(pending);
      assert.ok(results.every(result => result.status === 200 && result.body.toString() === "IMAGE"));
      assert.ok(results.every(result => !result.headers["x-fanhao-image-prepare"]), "direct image route must not opt into prepared-image 503 retry");
    } finally { gate.resolve(); await f.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  });
  await immediate(); assert.deepEqual(unhandled, []); console.log(`PASS short-video image lifecycle: ${checks} scenarios`);
} catch (error) {
  console.error(String(error.stack || error).replace(/data:text\/javascript;base64,[A-Za-z0-9+/=]+/g, "actual-runtime-source"));
  process.exitCode = 1;
} finally { fs.readFileSync = originalReadSync; process.off("unhandledRejection", onUnhandled); delete globalThis[owner]; }

function absoluteImports(source, file) {
  return source.replace(/from (["'])(\.[^"']+)\1/g, (_, quote, specifier) => `from ${quote}${new URL(specifier, pathToFileURL(file)).href}${quote}`);
}
function deferred() { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; }
function immediate() { return new Promise(resolve => setImmediate(resolve)); }
function delay(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
async function until(predicate) { for (let i = 0; i < 100; i++) { if (predicate()) return; await delay(5); } assert.fail("controlled stage did not start"); }
async function run(name, callback) { await callback(); checks++; console.log(`PASS ${name}`); }
function request(method = "GET") { return Object.assign(new EventEmitter(), { method, headers: {} }); }
function response() {
  return Object.assign(new EventEmitter(), {
    headers: {}, destroyed: false, writableEnded: false,
    writeHead(status, headers = {}) { assert.equal(this.destroyed, false); this.status = status; this.headers = headers; this.headersSent = true; },
    end(body) { this.body = body; this.writableEnded = true; }
  });
}
function get(url) {
  return new Promise((resolve, reject) => http.get(url, { agent: false }, res => {
    const chunks = []; res.on("data", chunk => chunks.push(chunk)); res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(chunks), headers: res.headers }));
  }).on("error", reject));
}
function streamResponse() {
  const res = new PassThrough(); res.chunks = [];
  res.on("data", chunk => res.chunks.push(chunk));
  res.writeHead = (status, headers = {}) => { res.status = status; res.headers = headers; res.headersSent = true; };
  return res;
}
async function productFixture({ bodyGate, closeGate, openGate, statGate, statChanged = false, error = "" } = {}) {
  const f = fixture(), saved = { open: fs.promises.open, openSync: fs.openSync, fstatSync: fs.fstatSync, closeSync: fs.closeSync, createReadStream: fs.createReadStream };
  const io = { opens: 0, stats: 0, streams: 0, active: 0, peak: 0, closed: 0, closeStarts: 0, signals: [] }, descriptors = new Map();
  function handle(filePath) {
    assert.ok(String(filePath).startsWith("/controlled/"));
    const value = [...f.state.sources.values()].find(value => value.path === filePath);
    const snapshot = { size: value.size, mtime: new Date(value.mtimeMs), mtimeMs: value.mtimeMs, dev: 1, ino: statChanged ? 2 : value.ino || 1, isFile: () => true };
    io.opens++; io.active++; io.peak = Math.max(io.peak, io.active);
    let closing;
    const result = {
      fd: 900000 + io.opens,
      snapshot,
      async stat() { io.stats++; if (statGate) await statGate.promise; if (error === "stat-error") throw new Error("controlled stat error"); return snapshot; },
      close() {
        if (!closing) { io.closeStarts++; closing = (async () => { if (closeGate) await closeGate.promise; io.active--; io.closed++; result.fd = -1; if (error === "close-reject") throw new Error("controlled close rejection after physical release"); })(); }
        return closing;
      },
      createReadStream() {
        if (["stream-throw", "close-reject"].includes(error)) throw new Error("controlled synchronous stream setup error");
        io.streams++; let started = false;
        return new Readable({
          read() { if (started) return; started = true; (async () => {
            if (bodyGate) await bodyGate.promise;
            if (this.destroyed) return;
            if (error === "read-error") { this.push(Buffer.from("IM")); this.destroy(new Error("controlled partial read error")); }
            else { this.push(Buffer.from("IMAGE")); this.push(null); }
          })().catch(error => this.destroy(error)); },
          destroy(streamError, callback) { result.close().then(() => callback(streamError), callback); }
        });
      }
    };
    return result;
  }
  fs.promises.open = async filePath => {
    if (error === "missing") throw Object.assign(new Error("controlled missing file"), { code: "ENOENT" });
    if (error === "open-error") throw new Error("controlled open error");
    const opened = handle(filePath); if (openGate) await openGate.promise; return opened;
  };
  // The legacy control pins the former synchronous descriptor transport.
  // Updating the shared file server must not turn that regression into a pass.
  fs.openSync = (filePath, ...args) => {
    if (!String(filePath).startsWith("/controlled/")) return saved.openSync(filePath, ...args);
    const fd = descriptors.size + 900000; descriptors.set(fd, handle(filePath)); return fd;
  };
  fs.fstatSync = (fd, ...args) => descriptors.has(fd) ? descriptors.get(fd).snapshot : saved.fstatSync(fd, ...args);
  fs.closeSync = fd => { if (descriptors.has(fd)) descriptors.get(fd).close(); else saved.closeSync(fd); };
  fs.createReadStream = (filePath, options) => descriptors.has(options?.fd) ? descriptors.get(options.fd).createReadStream() : saved.createReadStream(filePath, options);
  const productPath = path.resolve("src/modules/short-videos/server/product.js");
  let source = originalReadSync(productPath, "utf8");
  if (legacyProductInline) {
    const start = source.indexOf("  const images = {"), end = source.indexOf("  const cache =", start);
    assert.ok(start >= 0 && end > start);
    source = source.slice(0, start) + `  const images = {
      async serveImageAsync(res, file) {
        const fd = fs.openSync(file.path, "r"), stat = fs.fstatSync(fd);
        res.writeHead(200, {
          "Content-Type": config.MIME_TYPES[normalizeExt(file.path)],
          "Content-Length": stat.size,
          "Cache-Control": "public, max-age=3600",
          "Content-Disposition": "inline"
        });
        fs.createReadStream(null, { fd, autoClose: true }).pipe(res);
        await true;
      }
    };\n` + source.slice(end);
  }
  globalThis[owner].productRuntime = dependencies => {
    const original = dependencies.mediaResponseService.serveImageAsync;
    io.adapter = original;
    dependencies.mediaResponseService.serveImageAsync = (res, file, options) => { io.signals.push(options.signal); return original(res, file, options); };
    return createShortVideosRuntime(dependencies);
  };
  for (const [name, body] of [["createShortVideosRuntime", `(...args) => globalThis[${JSON.stringify(owner)}].productRuntime(...args)`], ["createImageReaderCacheService", "() => ({ stop() {}, startCleanupTimer() {} })"]]) {
    const pattern = new RegExp(`import \\{ ${name} \\} from \\"[^\\"]+\\";`);
    assert.ok(pattern.test(source)); source = source.replace(pattern, `const ${name} = ${body};`);
  }
  const { createShortVideoProduct } = await import(`data:text/javascript;base64,${Buffer.from(absoluteImports(source, productPath)).toString("base64")}`);
  globalThis[owner].productFactory = createShortVideoProduct;
  const modulePath = path.resolve("src/modules/short-videos/module.js");
  let moduleSource = originalReadSync(modulePath, "utf8");
  const productImport = /import \{ createShortVideoProduct \} from "\.\/server\/product\.js";/;
  assert.ok(productImport.test(moduleSource));
  moduleSource = moduleSource.replace(productImport, `const createShortVideoProduct = (...args) => globalThis[${JSON.stringify(owner)}].productFactory(...args);`);
  const { createModule } = await import(`data:text/javascript;base64,${Buffer.from(absoluteImports(moduleSource, modulePath)).toString("base64")}`);
  const product = createModule({ moduleDeps: { shortVideos: { config: { SHORT_VIDEO_DB_PATH: "/controlled/unused.sqlite", SHORT_VIDEO_ROOTS: [], MIME_TYPES: { ".jpg": "image/jpeg" }, APP_CONFIG_PATH: "/controlled/unused.json" } } } });
  f.state.open = true;
  return { ...f, product, io,
    route: (res, kind, id, req = request()) => product.routeMedia(req, res, new URL(`http://127.0.0.1/media/short-video-${kind}/${encodeURIComponent(id)}${kind === "gallery" ? "/0" : ""}`)),
    close: async () => {
      try {
        if (error === "close-reject") await assert.rejects(product.beginStop(), failure => failure.code === "FILE_SERVER_STOP_INCOMPLETE");
        else { await product.beginStop(); await product.stop(); }
        await f.close();
      } finally { fs.promises.open = saved.open; fs.openSync = saved.openSync; fs.fstatSync = saved.fstatSync; fs.closeSync = saved.closeSync; fs.createReadStream = saved.createReadStream; }
    }
  };
}
function fixture({ metadata = async () => {}, read = async () => Buffer.from("IMAGE"), videoTransport } = {}) {
  const state = { sources: new Map(), cache: new Map(), reads: 0, syncReads: 0, writes: 0, producers: 0, producerActive: 0, peakProducers: 0, activeReads: 0, peakReads: 0, streams: 0, readSignals: [], open: true, ownerEpoch: 0 };
  const source = (kind, id, index = 0) => {
    const key = `${kind}:${id}:${index}`;
    if (!state.sources.has(key)) state.sources.set(key, { key, id: `${id}:${kind}:${index}`, path: `/controlled/${kind}-${id}-${index}.jpg`, type: "image", size: 5, mtimeMs: Date.parse("2026-10-04T00:00:00.000Z"), current: true });
    return state.sources.get(key);
  };
  const stat = value => ({ isFile: () => true, size: value.size, mtime: new Date(value.mtimeMs), mtimeMs: value.mtimeMs, dev: 1, ino: value.ino || 1 });
  const file = value => {
    const epoch = state.ownerEpoch;
    return { ...value, ext: ".jpg", modifiedAt: new Date(value.mtimeMs).toISOString(), cacheMtime: JSON.stringify([new Date(value.mtimeMs).toISOString(), Number(value.mtimeMs), "1", String(value.ino || 1)]), cacheVersion: value.cacheVersion || String(value.mtimeMs), diskIdentity: localImageDiskIdentity(value.path, stat(value)), isCurrentSource: () => state.open && epoch === state.ownerEpoch && value.current && state.sources.get(value.key) === value };
  };
  const produce = async (kind, id, index, { signal } = {}) => {
    state.producers++; state.producerActive++; state.peakProducers = Math.max(state.peakProducers, state.producerActive);
    const value = source(kind, id, index), captured = file(value);
    try { await metadata(value, signal); if (value.statError) throw new Error("controlled stat error"); return value.missing ? null : state.metadataResult || captured; }
    finally { state.producerActive--; }
  };
  const store = {
    listVideos() { assert.fail("image fixture must not query a catalog"); }, catalogStamp: () => "controlled",
    prepareSchema() {}, close() { state.open = false; return true; }, beginClose() { state.open = false; return Promise.resolve(); }, recoverDeleteJobs() { state.open = true; return Promise.resolve({ pending: 0, active: 0 }); },
    coverFileAsync: (id, options) => produce("cover", id, 0, options), galleryFileAsync: (id, index, options) => produce("gallery", id, index, options),
    coverFile: id => ({ id: source("cover", id).id, path: source("cover", id).path, ext: ".jpg", type: "image" }), galleryFile: (id, index) => ({ id: source("gallery", id, index).id, path: source("gallery", id, index).path, ext: ".jpg", type: "image" })
  };
  globalThis[owner] = { store, writer: { start: async () => true, stop: async () => { if (state.writerStopError) throw new Error("controlled background stop failure"); } }, sync: { start() {}, stop: async () => {} } };
  const database = { prepare(sql) {
    if (sql.includes("SELECT file_path, source_size")) return { get: id => state.cache.get(id) || null };
    if (sql.includes("SELECT *") || sql.includes("SELECT 1 AS ready")) return { get(id, filePath, size, mtime) { const row = state.cache.get(id); return row?.file_path === filePath && row.source_size === size && row.source_mtime === mtime && row.image_blob?.length ? row : null; } };
    return { run(id, filePath, relativePath, mime, buffer, length, size, mtime) {
      if (Buffer.isBuffer(buffer)) { state.writes++; state.cache.set(id, { file_path: filePath, relative_path: relativePath, content_type: mime, image_blob: buffer, byte_length: length, source_size: size, source_mtime: mtime, status: "ok", updated_at: String(state.writes) }); }
    } };
  } };
  const opts = {
    getCoreDb: () => database, mimeTypes: { ".jpg": "image/jpeg" }, notFound: res => { res.writeHead(404); res.end(); }, sendText: (res, status, text) => { res.writeHead(status); res.end(text); }, warn() {},
    resolveCurrentLocalImageSource: () => undefined,
    safeStat: () => ({ size: 5, mtime: new Date("2026-10-04T00:00:00.000Z") }),
    statFile: async filePath => { const value = [...state.sources.values()].find(value => value.path === filePath); return stat(value || { size: 5, mtimeMs: Date.parse("2026-10-04T00:00:00.000Z") }); },
    readFile: async (filePath, { signal }) => { state.reads++; state.activeReads++; state.peakReads = Math.max(state.peakReads, state.activeReads); state.readSignals.push(signal); try { return await read(filePath, signal); } finally { state.activeReads--; } }
  };
  const images = (legacyMediaFactory || createMediaResponseService)(opts);
  fs.readFileSync = filePath => { assert.ok(String(filePath).startsWith("/controlled/"), "fixture must never read actual media"); state.reads++; state.syncReads++; return Buffer.from("IMAGE"); };
  const runtime = createShortVideosRuntime({ dbPath: ":memory:", roots: [], mediaResponseService: images, mediaStreamService: { serveVideo: videoTransport || function(req, res) { state.streams++; res.writeHead(206); res.end(); } }, notFound: opts.notFound, sendJson: (res, status, value) => { res.writeHead(status); res.end(JSON.stringify(value)); } });
  state.open = true;
  return {
    state, images, runtime, source, file,
    route: (res, kind, id, req = request()) => runtime.routeMedia(req, res, new URL(`http://127.0.0.1/media/short-video-${kind}/${encodeURIComponent(id)}${kind === "gallery" ? "/0" : ""}`)),
    close: async () => { await runtime.stop(); await images.stop?.(); fs.readFileSync = originalReadSync; }
  };
}
