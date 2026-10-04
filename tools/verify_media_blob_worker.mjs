import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { DatabaseSync } from "node:sqlite";
import { createMediaBlobWorkerClient } from "../src/platform/server/media-blob-worker-client.js";
import { createMediaResponseService } from "../src/platform/server/media-response-service.js";
import { attachCoreImageStore } from "../src/platform/server/core-image-store.js";

const tick = () => new Promise((resolve) => setImmediate(resolve));
class HeldWorker extends EventEmitter {
  static all = [];
  constructor() { super(); this.sent = []; this.terminateCalls = 0; HeldWorker.all.push(this); }
  ref() {}
  unref() {}
  postMessage(message, transfers) { this.sent.push({ message, transfers }); }
  reply(value = null) { this.emit("message", { id: this.sent.at(-1).message.id, ok: true, value }); }
  terminate() { this.terminateCalls += 1; return Promise.resolve(0); }
  exit() { this.emit("exit", 0); }
}

async function verifyBoundedOwnership() {
  const client = createMediaBlobWorkerClient({ dbPath: "unused", WorkerCtor: HeldWorker, capacity: 4, closeTimeoutMs: 20 });
  const reads = Array.from({ length: 4 }, (_, id) => client.coreImage(id).catch((error) => error));
  const worker = HeldWorker.all.at(-1);
  assert.equal(worker.sent.length, 1, "SQLite Worker port must contain only the dispatched request");
  assert.equal(client.diagnostics().queued, 3);
  await assert.rejects(client.coreImage(5), { code: "MEDIA_BLOB_BUSY" });
  const stopped = client.close();
  await assert.rejects(stopped, { code: "MEDIA_BLOB_CLOSE_TIMEOUT" });
  assert.equal(client.diagnostics().workerOwned, true, "terminate resolution alone must retain ownership");
  await assert.rejects(client.coreImage(6), { code: "MEDIA_BLOB_STOPPED" });
  await assert.rejects(client.start(), { code: "MEDIA_BLOB_STOPPED" });
  assert.equal(worker.terminateCalls, 1);
  assert.equal((await Promise.all(reads)).every((error) => error.code === "MEDIA_BLOB_STOPPED"), true);
  worker.exit();
  await client.start();
  const next = client.coreImage(7);
  const replacement = HeldWorker.all.at(-1);
  worker.emit("message", { id: replacement.sent[0].message.id, ok: true, value: "stale" });
  replacement.reply("fresh");
  assert.equal(await next, "fresh", "an old Worker must not settle a replacement request");
  const close = client.close(); replacement.exit(); await close;
  assert.equal(client.diagnostics().payloadBytes, 0);
  await assert.rejects(client.coreImage(8), { code: "MEDIA_BLOB_STOPPED" });
}

async function verifyPriorityAndSnapshot() {
  const client = createMediaBlobWorkerClient({ dbPath: "unused", WorkerCtor: HeldWorker });
  const first = client.coreImage(1);
  const worker = HeldWorker.all.at(-1);
  const buffer = Buffer.from([1, 2, 3]);
  const record = { url: "https://fixture.invalid/a", buffer, updatedAt: "before" };
  const write = client.upsertRemote(record);
  const front = client.workCover(2);
  buffer.fill(9); record.url = "changed"; record.updatedAt = "after";
  worker.reply("first");
  assert.equal(worker.sent.at(-1).message.action, "workCover");
  worker.reply("front");
  const sent = worker.sent.at(-1);
  assert.equal(sent.message.action, "upsertRemote");
  assert.equal(sent.message.record.url, "https://fixture.invalid/a");
  assert.equal(sent.message.record.updatedAt, "before");
  assert.deepEqual([...sent.message.record.buffer], [1, 2, 3]);
  assert.deepEqual(sent.transfers, [sent.message.record.buffer.buffer]);
  worker.reply(true);
  await Promise.all([first, front, write]);
  const close = client.close(); worker.exit(); await close;
  const budget = createMediaBlobWorkerClient({ dbPath: "unused", WorkerCtor: HeldWorker, payloadMaxBytes: 200 });
  await assert.rejects(budget.upsertRemote({ url: "x", buffer: Buffer.alloc(201) }), { code: "MEDIA_BLOB_BUSY" });
  assert.equal(budget.diagnostics().workerOwned, false, "oversize admission must not create a Worker");
  await budget.close();
}

async function verifyFailureOwner() {
  const client = createMediaBlobWorkerClient({ dbPath: "unused", WorkerCtor: HeldWorker, requestTimeoutMs: 15, closeTimeoutMs: 20 });
  const read = client.coreImage(1);
  const worker = HeldWorker.all.at(-1);
  await assert.rejects(read, { code: "MEDIA_BLOB_TIMEOUT" });
  await assert.rejects(client.coreImage(2), { code: "MEDIA_BLOB_STOPPED" });
  assert.equal(client.diagnostics().workerOwned, true);
  worker.exit();
  const next = client.coreImage(3);
  const replacement = HeldWorker.all.at(-1);
  replacement.emit("error", new Error("fixture error"));
  await assert.rejects(next, /fixture error/);
  assert.equal(client.diagnostics().workerOwned, true);
  const close = client.close(); replacement.exit(); await close;
}

async function verifyStartIntentFence() {
  const client = createMediaBlobWorkerClient({ dbPath: "unused", WorkerCtor: HeldWorker });
  const read = client.coreImage(1).catch((error) => error);
  const worker = HeldWorker.all.at(-1);
  const closing = client.close();
  const restarting = client.start();
  client.beginStop();
  worker.exit();
  await closing;
  await assert.rejects(restarting, { code: "MEDIA_BLOB_STOPPED" });
  await read;
  assert.equal(client.diagnostics().accepting, false, "a newer stop intent must fence an awaiting start");
  await client.start(); await client.close();
}

function response() {
  return { destroyed: false, writableEnded: false, status: null, body: null,
    writeHead(status) { this.status = status; }, end(body) { this.body = body; this.writableEnded = true; } };
}
function imageService(store) {
  return createMediaResponseService({ mediaBlobStore: store, getCoreDb: () => null,
    mimeTypes: {}, normalizeExt: () => ".jpg", notFound: (res) => { res.writeHead(404); res.end(); }, warn: () => {} });
}
async function verifyColdSingleFlightAndAuthority() {
  let resolveRead, calls = 0, authorityCalls = 0, revoked = false;
  const service = imageService({
    coreImage: () => { calls += 1; return new Promise((resolve) => { resolveRead = resolve; }); },
    actorAvatarVersion: async () => { authorityCalls += 1; return revoked ? { status: "revoked" } : { status: "available", row: { image_blob: Buffer.from([2]), mime: "image/png" } }; }
  });
  const responses = Array.from({ length: 60 }, response);
  const reads = responses.map((res) => service.serveCoreImage(res, 1));
  await tick();
  assert.equal(calls, 1, "60 consumers of one cold image must share one Worker read");
  resolveRead({ image_blob: Buffer.alloc(1024, 7), mime: "image/png" });
  await Promise.all(reads);
  assert(responses.every((res) => res.status === 200 && res.body[0] === 7));
  await Promise.all(Array.from({ length: 20 }, () => service.serveActorAvatar(response(), 1, { version: "v1" })));
  assert.equal(authorityCalls, 20, "versioned avatar revocations must be queried for each request");
  revoked = true;
  const res = response(); await service.serveActorAvatar(res, 1, { version: "v1" });
  assert.equal(res.status, 410, "hot avatar bytes must not survive a durable revoke");
  await service.stop(); await service.start();
  const retry = service.serveCoreImage(response(), 1); await tick();
  assert.equal(calls, 2, "restart must clear old BLOB entries");
  resolveRead({ image_blob: Buffer.from([8]) }); await retry; await service.stop();

  let finishOld, lateCalls = 0;
  const lateService = imageService({ coreImage: () => new Promise((resolve) => { lateCalls += 1; finishOld = resolve; }) });
  const late = lateService.serveCoreImage(response(), 2); await tick();
  await lateService.stop(); await lateService.start();
  finishOld({ image_blob: Buffer.from([9]) }); await late;
  const fresh = lateService.serveCoreImage(response(), 2); await tick();
  assert.equal(lateCalls, 2, "a late result from an old generation must not refill a restarted hot cache");
  finishOld({ image_blob: Buffer.from([10]) }); await fresh; await lateService.stop();
}

async function verifyActualSqliteWorker() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fanhao-media-blob-"));
  const identity = fs.statSync(root);
  const corePath = path.join(root, "core.sqlite"), imagePath = path.join(root, "images.sqlite");
  let client;
  try {
    const db = new DatabaseSync(corePath);
    try {
      attachCoreImageStore(db, { dbPath: imagePath });
      db.prepare("INSERT INTO fanhao_images.images (id,owner_type,owner_id,kind,source_type,mime,image_blob) VALUES (1,'work',2,'cover','generated','image/png',?)").run(Buffer.from([3, 4, 5]));
    } finally { db.close(); }
    client = createMediaBlobWorkerClient({ dbPath: corePath, imageDbPath: imagePath });
    const row = await client.coreImage(1);
    assert(row.image_blob instanceof Uint8Array);
    assert.deepEqual([...row.image_blob], [3, 4, 5]);
    const cover = await client.workCover(2); assert.deepEqual([...cover.cover_blob], [3, 4, 5]);
    const bytes = Buffer.from([6, 7, 8]);
    await client.upsertRemote({ url: "https://fixture.invalid/a", buffer: bytes, updatedAt: "2026-10-04" });
    assert.deepEqual([...bytes], [6, 7, 8], "transferring a request must not detach the caller's bytes");
    assert.deepEqual([...(await client.remoteImage("https://fixture.invalid/a")).image_blob], [6, 7, 8]);
    assert.deepEqual(await client.cachedRemoteUrls(["https://fixture.invalid/a", "missing"]), ["https://fixture.invalid/a"]);
    await client.close(); assert.equal(client.diagnostics().workerOwned, false);
  } finally {
    await client?.close();
    // This fixture only owns flat SQLite files; cleanup is non-recursive.
    assert.equal(fs.realpathSync(root), path.resolve(root));
    assert.equal(fs.statSync(root).ino, identity.ino);
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      assert(entry.isFile() && /^(core|images)\.sqlite(?:-wal|-shm)?$/.test(entry.name));
      fs.unlinkSync(path.join(root, entry.name));
    }
    fs.rmdirSync(root);
  }
}

await verifyBoundedOwnership();
await verifyPriorityAndSnapshot();
await verifyFailureOwner();
await verifyStartIntentFence();
await verifyColdSingleFlightAndAuthority();
await verifyActualSqliteWorker();
console.log("media blob Worker verification passed: bounded port/payload, priority, immutable writes, real exit ownership, restart, cold single-flight, per-request revocation, actual SQLite transfers");
