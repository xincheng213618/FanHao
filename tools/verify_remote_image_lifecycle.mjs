import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { createMediaResponseService, MAX_REMOTE_IMAGE_URL_LENGTH } from "../src/platform/server/media-response-service.js";
import { createRemoteImageWarmQueue, readRemoteImageBody } from "../src/platform/server/remote-image-warm-queue.js";

const tick = () => new Promise((resolve) => setImmediate(resolve));
async function until(predicate) {
  for (let count = 0; count < 1000; count += 1) { if (predicate()) return; await new Promise((resolve) => setTimeout(resolve, 2)); }
  throw new Error("fixture condition did not settle");
}
function response() { return { destroyed: false, writableEnded: false, writeHead(status, headers) { this.status = status; this.headers = headers; }, end(body) { this.body = body; this.writableEnded = true; } }; }
function service(options = {}) {
  return createMediaResponseService({ getCoreDb: () => null,
    mediaBlobStore: { remoteImage: async () => null, cachedRemoteUrls: async () => [], upsertRemote: async () => true },
    mimeTypes: { ".jpg": "image/jpeg" }, normalizeExt: () => ".jpg", publicRemoteUrl: (value) => value || "",
    isAllowedRemoteImageUrl: () => true, notFound: () => {}, sendText: (res,status,body) => { res.writeHead(status); res.end(body); }, proxiedRemoteImageUrl: (url) => url,
    warn: () => {}, ...options });
}
async function miss(instance, target) {
  const res = response();
  await instance.serveCachedRemoteImage({}, res, new URL("http://fixture/media/remote-image?url=" + encodeURIComponent(target)));
  return res;
}

async function verifyBodyLimits() {
  let pulls = 0, cancelled = 0;
  const body = new ReadableStream({ pull(controller) { pulls += 1; controller.enqueue(new Uint8Array(1024)); }, cancel() { cancelled += 1; } }, { highWaterMark: 0 });
  const unknownLength = new Response(body, { headers: { "content-type": "image/jpeg" } });
  unknownLength.arrayBuffer = () => { throw new Error("must stream rather than buffer the full body"); };
  await assert.rejects(readRemoteImageBody(unknownLength, 2048, new AbortController().signal), { statusCode: 413 });
  assert.equal(pulls, 3); assert.equal(cancelled, 1);
  let declaredPulled = 0, declaredCancelled = 0;
  const declared = new Response(new ReadableStream({ pull() { declaredPulled += 1; }, cancel() { declaredCancelled += 1; } }, { highWaterMark: 0 }), { headers: { "content-length": "4096" } });
  await assert.rejects(readRemoteImageBody(declared, 1024, new AbortController().signal), { statusCode: 413 });
  assert.equal(declaredPulled, 0); assert.equal(declaredCancelled, 1);
  const valid = await readRemoteImageBody(new Response(Uint8Array.from([1, 2, 3])), 3, new AbortController().signal);
  assert.deepEqual([...valid], [1, 2, 3]);
  const reusedSlab = new Uint8Array(64 * 1024);
  let tinyIndex = 0;
  const tinyBody = new ReadableStream({ pull(controller) {
    if (tinyIndex === 128) { controller.close(); return; }
    reusedSlab[0] = tinyIndex++;
    controller.enqueue(reusedSlab.subarray(0, 1));
  } }, { highWaterMark: 0 });
  const copied = await readRemoteImageBody(new Response(tinyBody), 128, new AbortController().signal);
  assert.deepEqual([...copied], Array.from({ length: 128 }, (_, index) => index), "tiny views must copy their valid bytes rather than retaining/reusing an entire backing slab");
  const controller = new AbortController();
  const interrupted = readRemoteImageBody(new Response(new ReadableStream({ pull() {} }, { highWaterMark: 0 })), 1024, controller.signal);
  controller.abort(new Error("fixture abort"));
  await assert.rejects(interrupted, /fixture abort/);
}

async function verifyDirectAdmissionAndStop() {
  let fetched = 0, cancelled = 0;
  const instance = service({ remoteImageWarmConcurrency: 2, remoteImageWarmCapacity: 12,
    fetchRemoteImage: (_url, { signal }) => new Promise((_resolve, reject) => {
      fetched += 1;
      const abort = () => { cancelled += 1; reject(signal.reason); };
      if (signal.aborted) abort(); else signal.addEventListener("abort", abort, { once: true });
    }) });
  const redirects = await Promise.all(Array.from({ length: 200 }, (_, index) => miss(instance, "https://fixture.invalid/" + index)));
  assert(redirects.every((res) => res.status === 302), "a full warm queue must retain redirect fallback");
  assert.equal(fetched, 2);
  assert.deepEqual(instance.remoteImageWarmDiagnostics(), { active: 2, queued: 10, capacity: 12, concurrency: 2, accepting: true });
  await instance.stop();
  assert.equal(cancelled, 2); assert.equal(instance.remoteImageWarmDiagnostics().active, 0);
  await assert.rejects(miss(instance, "https://fixture.invalid/late"), { statusCode: 503 });
  await instance.start();
  await miss(instance, "https://fixture.invalid/new");
  await until(() => fetched === 3); await instance.stop();
}

async function verifyRetainedOwnership() {
  let release, writes = 0;
  const instance = service({ remoteImageWarmConcurrency: 1, remoteImageWarmCapacity: 2, remoteImageStopWaitMs: 20,
    fetchRemoteImage: () => new Promise((resolve) => { release = resolve; }),
    mediaBlobStore: { remoteImage: async () => null, cachedRemoteUrls: async () => [], upsertRemote: async () => { writes += 1; } } });
  await miss(instance, "https://fixture.invalid/held"); await tick();
  await assert.rejects(instance.stop(), { code: "REMOTE_IMAGE_STOP_TIMEOUT" });
  await assert.rejects(instance.start(), { code: "REMOTE_IMAGE_STOPPED" });
  assert.equal(instance.remoteImageWarmDiagnostics().active, 1, "logical cancellation must retain an unsettled fetch owner");
  release(new Response(Uint8Array.from([7])));
  await until(() => instance.remoteImageWarmDiagnostics().active === 0);
  assert.equal(writes, 0, "late fetch must not publish cache bytes or write SQLite after stop");
  await instance.start(); await instance.stop();

  let finishWrite;
  const pendingWrite = service({ remoteImageStopWaitMs: 20,
    fetchRemoteImage: async () => new Response(Uint8Array.from([8])),
    mediaBlobStore: { remoteImage: async () => null, cachedRemoteUrls: async () => [], upsertRemote: () => new Promise((resolve) => { finishWrite = resolve; }) } });
  await miss(pendingWrite, "https://fixture.invalid/write"); await until(() => Boolean(finishWrite));
  await assert.rejects(pendingWrite.stop(), { code: "REMOTE_IMAGE_STOP_TIMEOUT" });
  assert.equal(pendingWrite.remoteImageWarmDiagnostics().active, 1, "a dispatched write is owned until its result settles");
  finishWrite(true); await until(() => pendingWrite.remoteImageWarmDiagnostics().active === 0);
  await pendingWrite.start(); await pendingWrite.stop();
}

async function verifyQueuedReplacement() {
  const releases = [], started = [];
  const pool = createRemoteImageWarmQueue({ concurrency: 1, capacity: 3,
    run: (key) => new Promise((resolve) => { started.push(key); releases.push(resolve); }) });
  assert(pool.enqueue("active")); assert(pool.enqueue("old1")); assert(pool.enqueue("old2"));
  assert.equal(pool.enqueue("overflow"), false); assert.equal(pool.enqueue("active"), false);
  await tick(); pool.replaceQueued(); assert(pool.enqueue("new"));
  releases.shift()(); await until(() => started.length === 2);
  assert.deepEqual(started, ["active", "new"]);
  releases.shift()(); await until(() => pool.diagnostics().active === 0); await pool.stop();
}

async function verifyBodyCleanupOwnership() {
  let release, readStarted = false, cancelStarted = false, cancelFinished = false;
  const body = new ReadableStream({
    pull() { readStarted = true; },
    cancel() {
      cancelStarted = true;
      return new Promise((resolve) => { release = () => { cancelFinished = true; resolve(); }; });
    }
  }, { highWaterMark: 0 });
  const instance = service({ remoteImageStopWaitMs: 20, fetchRemoteImage: async () => new Response(body) });
  await miss(instance, "https://fixture.invalid/held-body");
  await until(() => readStarted);
  await assert.rejects(instance.stop(), { code: "REMOTE_IMAGE_STOP_TIMEOUT" });
  assert.equal(cancelStarted, true); assert.equal(cancelFinished, false);
  assert.equal(instance.remoteImageWarmDiagnostics().active, 1, "body cancellation cleanup must retain its physical owner");
  await assert.rejects(instance.start(), { code: "REMOTE_IMAGE_STOPPED" });
  release();
  await until(() => instance.remoteImageWarmDiagnostics().active === 0);
  assert.equal(cancelFinished, true);
  await instance.start(); await instance.stop();
}

async function verifyStartIntentFence() {
  let release;
  const pool = createRemoteImageWarmQueue({ run: () => new Promise((resolve) => { release = resolve; }) });
  pool.enqueue("held"); await tick();
  const stopping = pool.stop();
  const restarting = pool.start();
  pool.beginStop(); release();
  await stopping;
  await assert.rejects(restarting, { code: "REMOTE_IMAGE_STOPPED" });
  assert.equal(pool.diagnostics().accepting, false, "a newer stop intent must fence an awaiting start");
  await pool.start(); await pool.stop();
}

async function verifyActualChunkedBody() {
  let bytesSent = 0, originClosed = false, writes = 0;
  const origin = http.createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "image/jpeg" });
    const timer = setInterval(() => { bytesSent += 1024; res.write(Buffer.alloc(1024, 3)); }, 2);
    req.on("close", () => { clearInterval(timer); originClosed = true; });
  });
  origin.listen(0, "127.0.0.1"); await once(origin, "listening");
  const warnings = [];
  const instance = service({ maxRemoteImageBytes: 4096, warn: (...values) => warnings.push(values),
    mediaBlobStore: { remoteImage: async () => null, cachedRemoteUrls: async () => [], upsertRemote: async () => { writes += 1; } } });
  try {
    await miss(instance, "http://127.0.0.1:" + origin.address().port + "/image.jpg");
    await until(() => originClosed && instance.remoteImageWarmDiagnostics().active === 0);
    assert.equal(writes, 0);
    assert(warnings.some((values) => values.join(" ").includes("远程图片过大")));
    assert(bytesSent >= 5120 && bytesSent < 1024 * 1024, "a missing Content-Length must cancel the origin before buffering its full stream");
  } finally { await instance.stop(); await new Promise((resolve) => origin.close(resolve)); origin.closeAllConnections(); }
}

const tinyGif = Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7","base64");
function tinyGifRow(metadata = {}) {
  const image = Buffer.allocUnsafeSlow(tinyGif.length); tinyGif.copy(image);
  return { content_type:"image/gif",image_blob:image,byte_length:image.length,updated_at:"2026-10-04T00:00:00Z",...metadata };
}

async function verifyCompletedCacheBudget() {
  const reads = new Map(), urlFor = id => `https://javdb.com/image.gif?id=${id}&signature=${"s".repeat(32 * 1024)}`;
  const cache = service({mediaBlobCacheMaxBytes:256 * 1024,mediaBlobStore:{remoteImage:async url=>{
    const id = new URL(url).searchParams.get("id"); reads.set(id,(reads.get(id)||0)+1); return tinyGifRow();
  },cachedRemoteUrls:async()=>[],upsertRemote:async()=>true}});
  try {
    for(let id=0;id<90;id++){const res=await miss(cache,urlFor(id));assert.equal(res.status,200);assert.equal(res.headers["Content-Type"],"image/gif");assert.deepEqual(res.body,tinyGif);}
    assert.equal(cache.remoteImageWarmDiagnostics().active,0);assert.equal(cache.remoteImageWarmDiagnostics().queued,0);
    await miss(cache,urlFor(89));assert.equal(reads.get("89"),1,"a recent completed row must remain hot");
    await miss(cache,urlFor(0));assert.equal(reads.get("0"),2,"90 completed tiny images with long keys must evict old rows even when BLOB bytes fit the budget");
  } finally { await cache.stop(); }

  let metadataReads=0;
  const metadata = service({mediaBlobCacheMaxBytes:4096,mediaBlobStore:{remoteImage:async()=>{metadataReads++;return tinyGifRow({source_label:"m".repeat(8192)});},cachedRemoteUrls:async()=>[],upsertRemote:async()=>true}});
  try { await miss(metadata,"https://javdb.com/metadata.gif");await miss(metadata,"https://javdb.com/metadata.gif");assert.equal(metadataReads,2,"row metadata strings must count toward completed cache weight"); }
  finally { await metadata.stop(); }

  const counts = new Map();
  const entries = service({mediaBlobCacheMaxBytes:1024 * 1024,mediaBlobCacheMaxEntries:2,mediaBlobStore:{remoteImage:async url=>{counts.set(url,(counts.get(url)||0)+1);return tinyGifRow();},cachedRemoteUrls:async()=>[],upsertRemote:async()=>true}});
  const targets=["https://javdb.com/0.gif","https://javdb.com/1.gif","https://javdb.com/2.gif"];
  try {
    for(const index of [0,1,0,2,0])await miss(entries,targets[index]);assert.equal(counts.get(targets[0]),1,"completed cache must retain the most recently accessed row");
    await miss(entries,targets[1]);assert.equal(counts.get(targets[1]),2,"entry count must cap completed bookkeeping independently of BLOB budget");
  } finally { await entries.stop(); }
}

async function verifyRemoteUrlAdmission() {
  assert.equal(MAX_REMOTE_IMAGE_URL_LENGTH,64 * 1024);
  const prefix="https://javdb.com/image.gif?signature=", sized=(length,char="a")=>prefix+char.repeat(length-prefix.length);
  const below=sized(MAX_REMOTE_IMAGE_URL_LENGTH-1),at=sized(MAX_REMOTE_IMAGE_URL_LENGTH),above=sized(MAX_REMOTE_IMAGE_URL_LENGTH+1);
  let reads=0;
  const allowed = parsed => parsed.protocol === "https:" && parsed.hostname === "javdb.com";
  const direct=service({isAllowedRemoteImageUrl:allowed,mediaBlobStore:{remoteImage:async()=>{reads++;return tinyGifRow();},cachedRemoteUrls:async()=>[],upsertRemote:async()=>true},fetchRemoteImage:()=>assert.fail("cached direct requests must not fetch")});
  try {
    assert.equal((await miss(direct,below)).status,200);assert.equal((await miss(direct,at)).status,200);assert.equal(reads,2);
    const rejected=await miss(direct,above);assert.equal(rejected.status,414);assert.equal(reads,2,"oversize direct URL must be rejected before cache lookup");
    const expanded=prefix+"中".repeat(8192);assert(expanded.length<MAX_REMOTE_IMAGE_URL_LENGTH);assert(new URL(expanded).href.length>MAX_REMOTE_IMAGE_URL_LENGTH);
    assert.equal((await miss(direct,expanded)).status,414);assert.equal(reads,2,"canonical wire URL length must also be bounded");
    assert.equal((await miss(direct,"https://outside.invalid/image.gif")).status,403);assert.equal(reads,2,"host admission must remain intact");
  } finally { await direct.stop(); }

  let fetched=0,writes=0,lookups=0;const lookupLengths=[];
  const prewarm=service({isAllowedRemoteImageUrl:allowed,fetchRemoteImage:async()=>{fetched++;return new Response(tinyGif,{headers:{"content-type":"image/gif"}});},
    mediaBlobStore:{remoteImage:async()=>null,cachedRemoteUrls:async urls=>{lookups++;lookupLengths.push(...urls.map(url=>url.length));return [];},upsertRemote:async()=>{writes++;return true;}}});
  try {
    const wrappedTarget=sized(MAX_REMOTE_IMAGE_URL_LENGTH,":"),wrapped="/media/remote-image?url="+encodeURIComponent(wrappedTarget);
    assert(wrapped.length>MAX_REMOTE_IMAGE_URL_LENGTH,"encoded signature wrapper must remain compatible beyond raw target limit");
    assert.equal(prewarm.remoteImageTargetUrl(wrapped),wrappedTarget);
    assert.equal(prewarm.remoteImageTargetUrl(above),"");assert.equal(prewarm.remoteImageTargetUrl("/media/remote-image?url="+encodeURIComponent(above)),"");
    assert.equal(prewarm.remoteImageTargetUrl("/media/remote-image?url="+encodeURIComponent(at)+"&unused="+"x".repeat(MAX_REMOTE_IMAGE_URL_LENGTH*3)),"");
    const accepted=prewarm.prewarmRemoteImagesForWorks([below,at,above,wrapped,"https://outside.invalid/image.gif","not-a-url"].map(remoteCoverUrl=>({remoteCoverUrl})),100);
    assert.equal(accepted,3,"prewarm must admit long valid signatures and filter malformed, disallowed and oversized URLs");
    await until(()=>writes===3&&prewarm.remoteImageWarmDiagnostics().active===0);assert.equal(fetched,3);assert.equal(lookups,1);assert(lookupLengths.every(length=>length<=MAX_REMOTE_IMAGE_URL_LENGTH));
    prewarm.beginStop();assert.equal(prewarm.prewarmRemoteImagesForWorks([{remoteCoverUrl:below}],1),0,"stop admission must remain intact");
  } finally { await prewarm.stop(); }
}

await verifyBodyLimits();
await verifyDirectAdmissionAndStop();
await verifyRetainedOwnership();
await verifyQueuedReplacement();
await verifyBodyCleanupOwnership();
await verifyStartIntentFence();
await verifyActualChunkedBody();
await verifyCompletedCacheBudget();
await verifyRemoteUrlAdmission();
console.log("remote image lifecycle verification passed: streaming limits, direct-request admission, redirect fallback, abort/drain ownership, source epoch, queued replacement, actual loopback chunked cancellation, completed cache key/metadata weight and entry cap, direct/prewarm URL boundaries");
