import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createVideoProbeService } from "../src/platform/server/video-probe-service.js";
import { createVideoProbeCacheService } from "../src/platform/server/video-probe-cache-service.js";

// Synthetic source identities and controlled probe output only. The final HTTP
// check uses an actual Node child on a private port, without FFprobe or media.
const immediate = () => new Promise((resolve) => setImmediate(resolve));
const output = (duration = 1, codec = "h264") => JSON.stringify({
  format: { duration: String(duration) }, streams: [{ codec_type: "video", codec_name: codec }]
});
const file = (id = "video", version = 1) => ({ id, path: `fixture/${id}.mp4`, ext: ".mp4", size: version, modifiedAt: `version-${version}` });

function fixture(options = {}) {
  const calls = [], writes = [], disk = new Map();
  let stats = 0, syncProbes = 0;
  const stat = (source) => {
    stats++;
    const value = disk.get(source);
    if (!value) throw new Error("missing synthetic source");
    return { ...value };
  };
  const service = createVideoProbeService({
    directVideoExts: new Set([".mp4"]), ffprobePath: "fixture-ffprobe", hasNvenc: false,
    cacheLimit: options.cacheLimit ?? 3, safeStat: stat, statFile: async (source) => stat(source),
    execFileFn: (_exe, args, _opts, callback) => calls.push({ path: args.at(-1), callback }),
    spawnSyncFn: () => { syncProbes++; return { status: 0, stdout: output() }; },
    persistentCache: { get: () => ({ hit: false }), set: (source, signature, value) => writes.push({ source, signature, value }) },
    ...options
  });
  return { service, calls, writes, disk, stats: () => stats, syncProbes: () => syncProbes,
    source: (entry, identity = {}) => disk.set(entry.path, { size: entry.size ?? 1, mtimeMs: entry.size ?? 1, dev: 1, ino: 1, ...identity }) };
}

async function until(predicate, label) {
  for (let i = 0; i < 100 && !predicate(); i++) await new Promise((resolve) => setTimeout(resolve, 2));
  assert(predicate(), label);
}

async function complete(f, index, duration = 1, codec = "h264", error = null) {
  await until(() => f.calls.length > index, "cold probe must start");
  f.calls[index].callback(error, error ? "" : output(duration, codec));
}

async function verifySourceUpdates() {
  const f = fixture(), old = file(), fresh = file("video", 2);
  f.source(old);
  const first = f.service.probeCachedAsync(old);
  assert.equal(first, f.service.probeCachedAsync({ ...old }), "same source must share the pending stat and process");
  await complete(f, 0); assert.equal((await first).duration, 1);
  const statCount = f.stats();
  assert.equal((await f.service.probeCachedAsync(old)).duration, 1);
  assert.equal(f.stats(), statCount, "warm library identities must retain the zero-stat fast path");
  f.source(fresh);
  const updated = f.service.probeCachedAsync(fresh);
  await complete(f, 1, 2, "vp9");
  assert.equal((await updated).videoCodec, "vp9", "same ID and path with updated library metadata must re-probe");
  assert.equal(f.writes.at(-1).signature.cacheMtime, "library:version-2");
  assert.deepEqual(f.service.diagnostics(), { cached: 2, resolved: 2, owners: 0, inflight: 0 });

  for (const failedOld of [false, true]) {
    const race = fixture(); race.source(old);
    const pendingOld = race.service.probeCachedAsync(old);
    await until(() => race.calls.length === 1, "old probe must start");
    race.source(fresh);
    const pendingFresh = race.service.probeCachedAsync(fresh);
    await complete(race, 1, 2, "vp9"); assert.equal((await pendingFresh).duration, 2);
    await complete(race, 0, 1, "h264", failedOld ? new Error("old probe failed") : null);
    assert.equal(await pendingOld, null, "superseded success and error must both discard their result");
    assert.equal(race.writes.length, 1, "a late old probe must never replace the persistent row");
    assert.equal((await race.service.probeCachedAsync(fresh)).videoCodec, "vp9");
  }
}

async function verifyDiskIdentities() {
  const f = fixture(), entry = { id: "disk", path: "fixture/disk.mp4", ext: ".mp4" };
  f.source(entry);
  let task = f.service.probeCachedAsync(entry); await complete(f, 0); await task;
  task = f.service.probeCachedAsync(entry); assert.equal((await task).duration, 1);
  assert.equal(f.calls.length, 1, "unchanged stat identity may reuse its completed probe");
  f.source(entry, { size: 2, mtimeMs: 2 });
  task = f.service.probeCachedAsync(entry); await complete(f, 1, 2); assert.equal((await task).duration, 2);
  f.source(entry, { size: 2, mtimeMs: 2, ino: 3 });
  task = f.service.probeCachedAsync(entry); await complete(f, 2, 3); assert.equal((await task).duration, 3);
  assert.equal(f.calls.length, 3, "inode replacement must invalidate the in-memory disk key even at the same size and mtime");

  for (const replacement of ["mtime", "inode", "delete"]) {
    const changed = fixture(); changed.source(entry);
    const pending = changed.service.probeCachedAsync(entry);
    await until(() => changed.calls.length === 1, "probe must start before source replacement");
    if (replacement === "delete") changed.disk.delete(entry.path);
    else changed.source(entry, replacement === "mtime" ? { mtimeMs: 9 } : { ino: 9 });
    await complete(changed, 0);
    assert.equal(await pending, null, "a source replaced during probing must not commit its output");
    assert.equal(changed.writes.length, 0);
    assert.equal(changed.service.diagnostics().resolved, 0);
  }
}

async function verifyClearAndRetention() {
  const f = fixture(), entry = file(); f.source(entry);
  const before = f.service.probeCachedAsync(entry);
  await until(() => f.calls.length === 1, "first generation must start");
  f.service.clearCache();
  const after = f.service.probeCachedAsync(entry);
  await until(() => f.calls.length === 2, "clear must allow a fresh lookup");
  await complete(f, 0);
  assert.equal(await before, null);
  assert.equal(f.service.probeCachedAsync(entry), after, "an old completion must not remove the fresh single-flight entry");
  assert.equal(f.writes.length, 0);
  await complete(f, 1, 2); assert.equal((await after).duration, 2);
  assert.equal(f.writes.length, 1);

  let finishStat;
  const statPending = fixture({ statFile: () => new Promise((resolve) => { finishStat = resolve; }) });
  const lookup = statPending.service.probeCachedAsync(entry);
  statPending.service.clearCache(); finishStat({ size: 1, mtimeMs: 1 });
  assert.equal(await lookup, null);
  assert.equal(statPending.calls.length, 0, "clearing during a slow stat must prevent the old process from spawning");

  const concurrent = fixture({ cacheLimit: 1 });
  const a = file("a"), b = file("b"); concurrent.source(a); concurrent.source(b);
  const aTask = concurrent.service.probeCachedAsync(a), bTask = concurrent.service.probeCachedAsync(b);
  await complete(concurrent, 0, 1); await complete(concurrent, 1, 2);
  assert.equal((await aTask).duration, 1); assert.equal((await bTask).duration, 2);
  assert.deepEqual(concurrent.service.diagnostics(), { cached: 1, resolved: 1, owners: 0, inflight: 0 }, "cache eviction must never invalidate an unrelated active owner");

  const retained = fixture();
  for (let i = 0; i < 20; i++) {
    const source = file(`bounded-${i}`); retained.source(source);
    const pending = retained.service.probeCachedAsync(source); await complete(retained, i); await pending;
    assert(retained.service.diagnostics().cached <= 3);
    assert(retained.service.diagnostics().resolved <= 3);
    assert.equal(retained.service.diagnostics().owners, 0);
  }
  const persisted = fixture({ persistentCache: { get: () => ({ hit: true, value: { duration: 7 } }) } });
  for (let i = 0; i < 20; i++) assert.equal(persisted.service.probeCached(file(`persisted-${i}`)).duration, 7);
  assert.deepEqual(persisted.service.diagnostics(), { cached: 3, resolved: 3, owners: 0, inflight: 0 }, "synchronous persistent hits must share the same retention limits");
  const source = file("mutable"); retained.source(source);
  const pending = retained.service.probeCachedAsync(source);
  source.path = "fixture/reassigned.mp4";
  await complete(retained, 20); await pending;
  assert.equal(retained.writes.at(-1).source.path, "fixture/mutable.mp4", "pending requests must own a snapshot of their input");
}

function verifyPersistentDiskIdentity() {
  const db = new DatabaseSync(":memory:");
  const source = file(), disk = { size: 1, mtimeMs: 1, dev: 1, ino: 1 };
  try {
    const cache = createVideoProbeCacheService({ getDb: () => db });
    assert.equal(cache.set(source, disk, { duration: 5 }), true);
    assert.equal(cache.get(source, disk).value.duration, 5);
    assert.equal(cache.get(source, { ...disk, ino: 2 }).hit, false, "persistent disk cache must reject inode replacement at equal size and mtime");
    const reloaded = createVideoProbeCacheService({ getDb: () => db });
    assert.equal(reloaded.get(source, disk).value.duration, 5, "disk identity must survive memory-index reconstruction");
    assert.equal(reloaded.get(source, { ...disk, dev: 2 }).hit, false);
    db.prepare("UPDATE video_probe_cache SET source_mtime = ?").run("1");
    assert.equal(createVideoProbeCacheService({ getDb: () => db }).get(source, disk).hit, false, "legacy disk-only rows are regenerated without a schema migration");
    assert.equal(cache.set(source, { size: 1, cacheMtime: "library:version-1" }, { duration: 7 }), true);
    assert.equal(cache.get(source, { size: 1, cacheMtime: "library:version-1" }).value.duration, 7, "library warm-cache compatibility is preserved");
  } finally { db.close(); }
}

function verifyPersistentLockFallback() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fanhao-probe-cache-lock-"));
  const databasePath = path.join(directory, "cache.sqlite");
  const db = new DatabaseSync(databasePath), writer = new DatabaseSync(databasePath);
  let observedWait = null;
  const controlledDb = {
    exec: (sql) => db.exec(sql),
    prepare: (sql) => {
      const statement = db.prepare(sql);
      if (!sql.includes("INSERT INTO video_probe_cache")) return statement;
      return { run: (...args) => {
        observedWait = db.prepare("PRAGMA busy_timeout").get().timeout;
        return statement.run(...args);
      } };
    }
  };
  try {
    db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 150");
    const cache = createVideoProbeCacheService({ getDb: () => controlledDb, warn: () => {} });
    assert.equal(cache.start(), true);
    writer.exec("BEGIN IMMEDIATE");
    const started = performance.now();
    assert.equal(cache.set(file(), { size: 1, mtimeMs: 1 }, { duration: 42 }), false, "busy optional cache must fall back without waiting for a lock");
    const lockedWriteMs = performance.now() - started;
    assert.equal(observedWait, 0, "cache writes never borrow the main database's lock wait policy");
    assert.equal(db.prepare("PRAGMA busy_timeout").get().timeout, 150, "failure restores the original policy");
    assert.equal(cache.get(file(), { size: 1, mtimeMs: 1 }).hit, false, "failed writes cannot enter the memory snapshot");
    writer.exec("ROLLBACK");
    assert.equal(cache.set(file(), { size: 1, mtimeMs: 1 }, { duration: 42 }), true);
    assert.equal(db.prepare("PRAGMA busy_timeout").get().timeout, 150, "success also restores the original policy");
    assert.equal(cache.get(file(), { size: 1, mtimeMs: 1 }).value.duration, 42);
    db.exec("DROP TABLE video_probe_cache");
    writer.exec("BEGIN IMMEDIATE");
    const coldCache = createVideoProbeCacheService({ getDb: () => controlledDb, warn: () => {} });
    assert.equal(coldCache.start(), false, "optional cache schema initialization also falls back under a writer lock");
    assert.equal(db.prepare("PRAGMA busy_timeout").get().timeout, 150, "initialization failure restores the original policy");
    writer.exec("ROLLBACK");
    assert.equal(coldCache.start(), true, "failed initialization is retryable after lock release");
    assert.equal(db.prepare("PRAGMA busy_timeout").get().timeout, 150);
    console.log(JSON.stringify({ lockedWriteMs: Number(lockedWriteMs.toFixed(1)), fixture: "private SQLite writer lock, cache wait policy = 0" }));
  } finally {
    if (writer.isTransaction) writer.exec("ROLLBACK");
    writer.close(); db.close();
    for (const suffix of ["", "-wal", "-shm"]) fs.rmSync(`${databasePath}${suffix}`, { force: true });
    fs.rmdirSync(directory);
  }
}

async function verifyHttpResponsiveness() {
  const children = [];
  const service = createVideoProbeService({
    directVideoExts: new Set([".mp4"]), ffprobePath: "synthetic-probe", hasNvenc: false,
    safeStat: () => ({ size: 1, mtimeMs: 1 }), statFile: async () => ({ size: 1, mtimeMs: 1 }),
    execFileFn: (_exe, _args, options, callback) => {
      const child = execFile(process.execPath, ["-e", `setTimeout(() => process.stdout.write(${JSON.stringify(output(42))}), 350)`], options, callback);
      children.push(new Promise((resolve) => child.once("close", resolve)));
      return child;
    }
  });
  const server = http.createServer(async (req, res) => {
    const data = req.url === "/health" ? { ok: true } : await service.playInfoForFileAsync(file());
    res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify(data));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const started = performance.now();
    const play = fetch(`${base}/play`).then((r) => r.json());
    await until(() => children.length > 0, "HTTP playback must start the actual asynchronous child");
    const healthStarted = performance.now();
    assert.equal((await (await fetch(`${base}/health`)).json()).ok, true);
    const healthMs = performance.now() - healthStarted;
    const info = await play, playbackMs = performance.now() - started;
    assert.equal(info.probePending, true); assert.equal(info.mode, "direct");
    assert(healthMs < 250, `health response unexpectedly delayed: ${healthMs}`);
    assert(playbackMs < 300, `fallback unexpectedly waited for the 350ms probe: ${playbackMs}`);
    await Promise.all(children);
    assert.equal((await service.playInfoForFileAsync(file())).duration, 42);
    console.log(JSON.stringify({ playbackMs: Number(playbackMs.toFixed(1)), healthMs: Number(healthMs.toFixed(1)), fixture: "private HTTP and Node child" }));
  } finally {
    await Promise.all(children);
    await new Promise((resolve) => server.close(resolve));
  }
}

await verifySourceUpdates();
await verifyDiskIdentities();
await verifyClearAndRetention();
verifyPersistentDiskIdentity();
verifyPersistentLockFallback();
await verifyHttpResponsiveness();
console.log("Video probe source identity, generation isolation, bounded retention and asynchronous HTTP checks passed.");
