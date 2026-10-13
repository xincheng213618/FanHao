import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { Worker } from "node:worker_threads";
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
  return { destroyed: false, writableEnded: false, status: null, headers: null, body: null,
    writeHead(status, headers = {}) { this.status = status; this.headers = headers; }, end(body) { this.body = body; this.writableEnded = true; } };
}
function imageService(store, options = {}) {
  return createMediaResponseService({ mediaBlobStore: store, getCoreDb: () => null,
    mimeTypes: {}, normalizeExt: () => ".jpg", notFound: (res) => { res.writeHead(404); res.end(); }, warn: () => {}, ...options });
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

async function avatarResponse(service, personId = 1, version = "avatar-v1") {
  const res = response();
  await service.serveActorAvatar(res, personId, { version });
  return { status: res.status, headers: res.headers, body: res.body == null ? null : Buffer.from(res.body) };
}

async function verifyAvatarCacheLifetime() {
  const legacy = imageService({ actorAvatarVersion: async () => ({
    status: "available", row: { image_blob: Buffer.from([1]), mime: "image/png" }, cacheToken: null
  }) });
  try {
    assert.equal((await avatarResponse(legacy)).status, 200, "unknown legacy-store metadata must remain ignored");
    assert.equal((await avatarResponse(legacy)).status, 200);
  } finally { await legacy.stop(); }
  const tokens = [];
  let held = null, rejectHeld = null, hold = false;
  const row = { image_blob: Buffer.from("cached avatar"), mime: "image/png" };
  const service = imageService({
    coreImage: async () => ({ image_blob: Buffer.from("eviction") }),
    cachedActorAvatarVersion: async (personId, version, token) => {
      tokens.push(token);
      if (hold) return new Promise((resolve, reject) => { held = resolve; rejectHeld = reject; });
      return { status: "available", row: token === "owner:1:1" ? null : row, cacheToken: "owner:1:1" };
    }
  }, { mediaBlobCacheMaxEntries: 1 });
  try {
    const first = await avatarResponse(service);
    hold = true;
    const pending = avatarResponse(service);
    await service.serveCoreImage(response(), 2);
    held({ status: "available", row: null, cacheToken: "owner:1:1" });
    assert.deepEqual(await pending, first, "capacity eviction must not discard a captured, freshly authorized avatar");
    hold = false;
    assert.deepEqual(await avatarResponse(service), first);
    assert.equal(tokens.at(-1), "owner:1:1", "the authorized capture must remain cacheable after capacity eviction");

    hold = true;
    const failed = avatarResponse(service);
    rejectHeld(new Error("fixture authority failed"));
    await assert.rejects(failed, /fixture authority failed/);
    hold = false;
    await avatarResponse(service);
    assert.equal(tokens.at(-1), "", "authority failure must evict the old bytes before retry");

    for (const restart of [false, true]) {
      hold = true;
      const res = response();
      const late = service.serveActorAvatar(res, 1, { version: "avatar-v1" });
      await service.stop();
      if (restart) await service.start();
      held({ status: "available", row: null, cacheToken: "owner:1:1" });
      await assert.rejects(late, { statusCode: 503 });
      assert.equal(res.status, null, "a late cached result must not publish bytes across stop/restart");
      if (!restart) await service.start();
      hold = false;
      await avatarResponse(service);
      assert.equal(tokens.at(-1), "", "restart must request fresh authority and bytes");
    }
  } finally { await service.stop(); }
}

class CountingWorker extends Worker {
  static replies = [];
  constructor(...args) {
    super(...args);
    const actions = new Map();
    this.postMessage = (message, transfers) => {
      actions.set(message.id, message.action);
      return super.postMessage(message, transfers);
    };
    this.on("message", (message) => {
      const row = message.value?.row || message.value;
      CountingWorker.replies.push({ action: actions.get(message.id), bytes: row?.image_blob?.byteLength || 0, status: message.value?.status });
      actions.delete(message.id);
    });
  }
}

async function verifyVersionedAvatarTransfers() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fanhao-avatar-authority-"));
  const identity = fs.statSync(root);
  const corePath = path.join(root, "core.sqlite"), imagePath = path.join(root, "images.sqlite");
  const db = new DatabaseSync(corePath);
  let snapshotDb, client;
  const services = [];
  try {
    attachCoreImageStore(db, { dbPath: imagePath });
    // Deliberately model an older read-compatible schema without immutable
    // stage triggers. Token invalidation must also cover such external writes.
    db.exec(`
      PRAGMA main.journal_mode = WAL;
      CREATE TABLE actor_profile_publications (person_id INTEGER, operation_id TEXT, intent_sha256 TEXT);
      CREATE TABLE actor_profile_image_revocations (person_id INTEGER, operation_id TEXT, intent_sha256 TEXT);
      CREATE TABLE cross_store_intents (op_id TEXT PRIMARY KEY, kind TEXT, aggregate_key TEXT, intent_sha256 TEXT);
      CREATE TABLE cross_store_operation_state (op_id TEXT PRIMARY KEY, status TEXT);
      CREATE TABLE cross_store_main_receipts (op_id TEXT PRIMARY KEY, step TEXT, intent_sha256 TEXT);
      CREATE TABLE fanhao_images.cross_store_receipts (op_id TEXT PRIMARY KEY, step TEXT, kind TEXT, aggregate_key TEXT, intent_sha256 TEXT);
      CREATE TABLE fanhao_images.actor_profile_image_staging (operation_id TEXT PRIMARY KEY, person_id INTEGER, intent_sha256 TEXT, image_blob BLOB, mime TEXT, source TEXT, updated_at TEXT);
      INSERT INTO cross_store_intents VALUES ('avatar-v1', 'actor_profile_upsert', 'person:1', 'sha');
      INSERT INTO cross_store_operation_state VALUES ('avatar-v1', 'completed');
      INSERT INTO cross_store_main_receipts VALUES ('avatar-v1', 'visibility_switch', 'sha');
      INSERT INTO fanhao_images.cross_store_receipts VALUES ('avatar-v1', 'image_stage', 'actor_profile_upsert', 'person:1', 'sha');
    `);
    let expectedBytes = Buffer.alloc(4 * 1024 * 1024, 73);
    db.prepare("INSERT INTO fanhao_images.actor_profile_image_staging VALUES ('avatar-v1', 1, 'sha', ?, 'image/png', 'actor_profiles', '2026-10-13')").run(expectedBytes);
    client = createMediaBlobWorkerClient({ dbPath: corePath, imageDbPath: imagePath, WorkerCtor: CountingWorker });
    const optimizedStore = process.argv.includes("--legacy-avatar-blobs") ? { actorAvatarVersion: client.actorAvatarVersion } : client;
    const optimized = imageService(optimizedStore);
    const legacy = imageService({ actorAvatarVersion: client.actorAvatarVersion });
    const inline = imageService(undefined, { getCoreDb: () => db });
    services.push(optimized, legacy, inline);
    const expected = {
      status: 200,
      headers: { "Content-Type": "image/png", "Content-Length": expectedBytes.length, "Cache-Control": "private, no-store", "Content-Disposition": "inline" },
      body: expectedBytes
    };
    CountingWorker.replies.length = 0;
    let optimizedCalls = 0, optimizedBytes = 0, legacyBytes = 0;
    for (let index = 0; index < 51; index += 1) {
      for (const service of services) {
        const before = CountingWorker.replies.length;
        assert.deepEqual(await avatarResponse(service), expected);
        const replies = CountingWorker.replies.slice(before);
        const bytes = replies.reduce((sum, entry) => sum + entry.bytes, 0);
        if (service === optimized) { optimizedCalls += replies.length; optimizedBytes += bytes; }
        if (service === legacy) legacyBytes += bytes;
      }
    }
    assert.equal(optimizedCalls, 51, "each hot request must still reach the durable authority");
    assert.equal(optimizedBytes, expectedBytes.length, "50 hot responses must read/transfer no additional BLOBs");
    assert.equal(legacyBytes, expectedBytes.length * 51, "the original full-read API remains unchanged");

    // An unrelated write on this same Worker connection does not change the
    // actor authority. data_version intentionally ignores its own commits.
    await client.upsertRemote({ url: "https://fixture.invalid/avatar-budget", buffer: Buffer.from([7]), updatedAt: "fixture" });
    assert.deepEqual(await avatarResponse(optimized), expected);
    assert.equal(CountingWorker.replies.at(-1).bytes, 0);

    const mutations = [
      ["cross_store_operation_state", "status", "pending", "completed"],
      ["cross_store_intents", "kind", "wrong_kind", "actor_profile_upsert"],
      ["cross_store_intents", "intent_sha256", "wrong_sha", "sha"],
      ["cross_store_main_receipts", "step", "wrong_step", "visibility_switch"],
      ["cross_store_main_receipts", "intent_sha256", "wrong_sha", "sha"],
      ["fanhao_images.cross_store_receipts", "step", "wrong_step", "image_stage"],
      ["fanhao_images.cross_store_receipts", "kind", "wrong_kind", "actor_profile_upsert"],
      ["fanhao_images.cross_store_receipts", "aggregate_key", "person:2", "person:1"],
      ["fanhao_images.cross_store_receipts", "intent_sha256", "wrong_sha", "sha"],
      ["fanhao_images.actor_profile_image_staging", "intent_sha256", "wrong_sha", "sha"],
      ["fanhao_images.actor_profile_image_staging", "person_id", 2, 1]
    ];
    for (const [table, column, invalid, valid] of mutations) {
      db.prepare(`UPDATE ${table} SET ${column} = ?`).run(invalid);
      for (const service of services) assert.deepEqual(await avatarResponse(service), { status: 404, headers: {}, body: null }, `${table}.${column} must fence cached bytes`);
      db.prepare(`UPDATE ${table} SET ${column} = ?`).run(valid);
      for (const service of services) assert.deepEqual(await avatarResponse(service), expected);
    }
    db.exec("DELETE FROM cross_store_main_receipts");
    for (const service of services) assert.equal((await avatarResponse(service)).status, 404);
    db.exec("INSERT INTO cross_store_main_receipts VALUES ('avatar-v1', 'visibility_switch', 'sha')");
    for (const service of services) await avatarResponse(service);
    db.exec("INSERT INTO actor_profile_image_revocations VALUES (1, 'avatar-v1', 'sha')");
    for (const service of services) assert.deepEqual(await avatarResponse(service), { status: 410, headers: { "Cache-Control": "private, no-store", "Content-Length": "0" }, body: null });
    db.exec("DELETE FROM actor_profile_image_revocations");
    for (const service of services) assert.deepEqual(await avatarResponse(service), expected);

    // Mutating an old schema's BLOB must invalidate the Worker token, even if
    // operation id, MIME, byte size and all receipts stay the same.
    expectedBytes = Buffer.alloc(expectedBytes.length, 81);
    db.prepare("UPDATE fanhao_images.actor_profile_image_staging SET image_blob = ?").run(expectedBytes);
    expected.body = expectedBytes;
    assert.deepEqual(await avatarResponse(optimized), expected);
    assert.equal(CountingWorker.replies.at(-1).bytes, expectedBytes.length);
    assert.deepEqual(await avatarResponse(optimized), expected);
    assert.equal(CountingWorker.replies.at(-1).bytes, 0);

    // SQLite's data_version pins a WAL read snapshot inside a SAVEPOINT.
    // A commit between the token read and authority JOIN must not mix epochs.
    snapshotDb = new DatabaseSync(corePath);
    attachCoreImageStore(snapshotDb, { dbPath: imagePath });
    snapshotDb.exec("SAVEPOINT avatar_snapshot_fixture");
    const mainVersion = snapshotDb.prepare("PRAGMA main.data_version").get().data_version;
    const imageVersion = snapshotDb.prepare("PRAGMA fanhao_images.data_version").get().data_version;
    db.exec("UPDATE cross_store_operation_state SET status = 'pending'; UPDATE fanhao_images.actor_profile_image_staging SET mime = 'image/webp'");
    assert.equal(snapshotDb.prepare("PRAGMA main.data_version").get().data_version, mainVersion);
    assert.equal(snapshotDb.prepare("PRAGMA fanhao_images.data_version").get().data_version, imageVersion);
    assert.equal(snapshotDb.prepare("SELECT status FROM cross_store_operation_state").get().status, "completed");
    assert.equal(snapshotDb.prepare("SELECT mime FROM fanhao_images.actor_profile_image_staging").get().mime, "image/png");
    snapshotDb.exec("RELEASE avatar_snapshot_fixture");
    assert.notEqual(snapshotDb.prepare("PRAGMA main.data_version").get().data_version, mainVersion);
    assert.notEqual(snapshotDb.prepare("PRAGMA fanhao_images.data_version").get().data_version, imageVersion);
    snapshotDb.close(); snapshotDb = null;
    db.exec("UPDATE cross_store_operation_state SET status = 'completed'; UPDATE fanhao_images.actor_profile_image_staging SET mime = 'image/png'");

    // The response cache survives a Worker-only restart, but its token cannot.
    await avatarResponse(optimized);
    await client.close();
    await assert.rejects(avatarResponse(optimized), { code: "MEDIA_BLOB_STOPPED" });
    await client.start();
    assert.deepEqual(await avatarResponse(optimized), expected);
    assert.equal(CountingWorker.replies.at(-1).bytes, expectedBytes.length);
    const beforeRestart = await client.cachedActorAvatarVersion(1, "avatar-v1");
    await client.close(); await client.start();
    const afterRestart = await client.cachedActorAvatarVersion(1, "avatar-v1", beforeRestart.cacheToken);
    assert.notEqual(afterRestart.cacheToken, beforeRestart.cacheToken);
    assert.deepEqual(Buffer.from(afterRestart.row.image_blob), expectedBytes);

    // SQL errors are surfaced without serving the hot row and leave no open
    // savepoint. Repairing the private schema permits the next cold read.
    await avatarResponse(optimized);
    db.exec("ALTER TABLE cross_store_main_receipts RENAME COLUMN step TO broken_step");
    await assert.rejects(avatarResponse(optimized), /step/);
    db.exec("ALTER TABLE cross_store_main_receipts RENAME COLUMN broken_step TO step");
    assert.deepEqual(await avatarResponse(optimized), expected);
    assert.equal(CountingWorker.replies.at(-1).bytes, expectedBytes.length);

    // Inline mode intentionally retains full reads: no token assumes that a
    // native connection or a switching facade remains the same authority.
    db.close();
    await assert.rejects(avatarResponse(inline));
    db.open(); attachCoreImageStore(db, { dbPath: imagePath });
    assert.deepEqual(await avatarResponse(inline), expected);
    for (const service of services) { await service.stop(); await service.start(); }
    for (const service of services) assert.deepEqual(await avatarResponse(service), expected);
    console.log(`avatar cache budget: cold ${expectedBytes.length} bytes, 50 hot requests 0 BLOB bytes; legacy hot ${50 * expectedBytes.length} bytes; full inline/Worker response and authority checks passed`);
  } finally {
    await Promise.all(services.map((service) => service.stop()));
    await client?.close();
    if (snapshotDb?.isOpen) snapshotDb.close();
    if (db.isOpen) db.close();
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
await verifyAvatarCacheLifetime();
await verifyVersionedAvatarTransfers();
console.log("media blob Worker verification passed: bounded port/payload, priority, immutable writes, real exit ownership, restart, cold single-flight, per-request revocation, actual SQLite transfers");
