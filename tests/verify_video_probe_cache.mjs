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

async function verifyPersistentPointReads() {
  const source = fs.readFileSync(new URL("../src/platform/server/video-probe-cache-service.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");
  const readBlock = source.match(/    readStatement = db\.prepare\(`[\s\S]*?    `\);/)?.[0];
  assert(readBlock?.includes("WHERE file_id = ? AND file_path = ?"), "oracle must restore the old full-table snapshot");
  let legacySource = source.replace("  let readStatement = null;", "  const rowsByFile = new Map();")
    .replace("    readStatement = null;", "    rowsByFile.clear();")
    .replace(readBlock, readBlock.replace("readStatement =", "const rows =").replace("        WHERE file_id = ? AND file_path = ?\n", "").replace("    `);", "    `).all();\n    rowsByFile.clear();\n    for (const row of rows) rowsByFile.set(cacheKey(row.file_id, row.file_path), row);"))
    .replace("const row = withoutLockWait(cacheDatabase, () => readStatement.get(String(file.id), String(file.path)));", "const row = rowsByFile.get(cacheKey(file.id, file.path));")
    .replace('      return true;\n    } catch (error) {\n      warn("[video-probe-cache-write]"', `      rowsByFile.set(cacheKey(file.id, file.path), {
        source_size: Number(stat.size) || 0, source_mtime: sourceMtime(stat),
        schema_version: VIDEO_PROBE_CACHE_SCHEMA_VERSION, status: value ? "ok" : "unavailable",
        probe_json: value ? JSON.stringify(value) : null
      });
      return true;
    } catch (error) {
      warn("[video-probe-cache-write]"`)
    .replace("  return { get, set, start: initialize };", '  function cacheKey(id, path) { return String(id || "") + "\\0" + String(path || ""); }\n  return { get, set, start: initialize };');
  const legacyFactory = (await import("data:text/javascript;base64," + Buffer.from(legacySource).toString("base64"))).createVideoProbeCacheService;
  const measuredFactory = process.argv.includes("--legacy-persistent-snapshot") ? legacyFactory : createVideoProbeCacheService;
  const db = new DatabaseSync(":memory:"), owners = [];
  const signature = { size: 1, cacheMtime: "library:version-1" };
  try {
    createVideoProbeCacheService({ getDb: () => db }).start();
    const insert = db.prepare("INSERT INTO video_probe_cache VALUES(?,?,1,'library:version-1',1,?,?,'private')");
    db.exec("BEGIN");
    for (let index = 0; index < 10000; index++) {
      const entry = file(`persisted-${index}`), value = { duration: index + 1, videoCodec: index % 3 ? "h264" : "vp9", audioCodec: "aac", width: 1920, height: 1080 };
      insert.run(entry.id, entry.path, index % 5 ? "ok" : "unavailable", index % 5 ? JSON.stringify(value) : null);
    }
    db.exec("COMMIT");
    function owner(factory) {
      const counts = { fullRows: 0, reads: 0, prepares: 0 };
      const controlledDb = { exec: sql => db.exec(sql), prepare: sql => {
        const statement = db.prepare(sql);
        if (!/SELECT[\s\S]*FROM video_probe_cache/.test(sql)) return statement;
        counts.prepares++;
        return { all: (...args) => { const rows = statement.all(...args); counts.fullRows += rows.length; return rows; },
          get: (...args) => { counts.reads++; assert.equal(db.prepare("PRAGMA busy_timeout").get().timeout, 0); return statement.get(...args); } };
      } };
      const persistentCache = factory({ getDb: () => controlledDb, warn: () => {} });
      assert.equal(persistentCache.start(), true);
      const service = fixture({ cacheLimit: 512, persistentCache,
        safeStat: () => assert.fail("persisted identities need no stat"), statFile: async () => assert.fail("persisted identities need no stat"),
        spawnSyncFn: () => assert.fail("persisted identities need no FFprobe"), execFileFn: () => assert.fail("persisted identities need no FFprobe") }).service;
      const result = { persistentCache, service, counts }; owners.push(result); return result;
    }
    const previous = owner(legacyFactory), current = owner(measuredFactory);
    assert.equal(previous.counts.fullRows, 10000);
    assert.equal(current.counts.fullRows, 0, "startup must not materialize the persistent probe table");
    for (let index = 0; index < 1000; index++) {
      const entry = file(`persisted-${index}`), before = await previous.service.playInfoForFileAsync(entry), after = await current.service.playInfoForFileAsync(entry);
      assert.deepEqual(after, before); assert.equal(JSON.stringify(after), JSON.stringify(before));
    }
    assert.equal(current.counts.reads, 1000, "each cold identity fetches one primary-key row");
    assert.equal(current.counts.prepares, 1, "the initialized point statement is reused");
    assert.equal(current.counts.fullRows, 0);
    assert.deepEqual(current.service.diagnostics(), { cached: 512, resolved: 512, owners: 0, inflight: 0 });
    for (let index = 900; index < 1000; index++) {
      const entry = file(`persisted-${index}`);
      assert.deepEqual(await current.service.playInfoForFileAsync(entry), await previous.service.playInfoForFileAsync(entry));
      assert.deepEqual(current.service.playInfoForFile(entry), previous.service.playInfoForFile(entry));
    }
    assert.equal(current.counts.reads, 1000, "both async and sync hot playback add zero persistent reads");

    const entry = file("persisted-2001"), changed = { duration: 987, videoCodec: "hevc", audioCodec: "aac" };
    db.prepare("UPDATE video_probe_cache SET probe_json=? WHERE file_id=?").run(JSON.stringify(changed), entry.id);
    assert.equal((await current.service.playInfoForFileAsync(entry)).duration, 987, "a cold item reads current durable authority");
    assert.notEqual((await previous.service.playInfoForFileAsync(entry)).duration, 987, "the old process snapshot ignored this update");
    db.prepare("UPDATE video_probe_cache SET probe_json=? WHERE file_id=?").run(JSON.stringify({ ...changed, duration: 988 }), entry.id);
    const reads = current.counts.reads;
    assert.equal((await current.service.playInfoForFileAsync(entry)).duration, 987, "the existing bounded hot-cache policy is unchanged");
    assert.equal(current.counts.reads, reads);
    current.service.clearCache();
    assert.equal((await current.service.playInfoForFileAsync(entry)).duration, 988);
    for (const [field, value, expected] of [["schema_version", 9, false], ["source_size", 2, false], ["source_mtime", "old", false],
      ["status", "unavailable", true], ["probe_json", "invalid", false], ["probe_json", "null", false], ["probe_json", "42", false]]) {
      db.prepare("UPDATE video_probe_cache SET schema_version=1,source_size=1,source_mtime='library:version-1',status='ok',probe_json=? WHERE file_id=?").run(JSON.stringify(changed), entry.id);
      db.prepare(`UPDATE video_probe_cache SET ${field}=? WHERE file_id=?`).run(value, entry.id);
      assert.deepEqual(current.persistentCache.get(entry, signature), { hit: expected, value: null }, `${field} validation`);
    }
    db.prepare("DELETE FROM video_probe_cache WHERE file_id=?").run(entry.id);
    assert.deepEqual(current.persistentCache.get(entry, signature), { hit: false, value: null });
    console.log(JSON.stringify({ persistentPointReads: 1000, playbackDtoOracles: 1200, startupRowsBefore: previous.counts.fullRows, startupRowsAfter: current.counts.fullRows }));
  } finally { for (const owner of owners) await owner.service.stop(); db.close(); }
}

async function verifyPersistentFailures() {
  const db = new DatabaseSync(":memory:"), signature = { size: 1, cacheMtime: "library:version-1" }, entry = file();
  let failPrepare = true, failWritePrepare = false, failRead = false, failWrite = false, reads = 0;
  const warnings = [];
  const controlledDb = { exec: sql => db.exec(sql), prepare: sql => {
    if (/SELECT[\s\S]*FROM video_probe_cache/.test(sql)) {
      if (failPrepare) { failPrepare = false; throw new Error("controlled prepare failure"); }
      const statement = db.prepare(sql);
      return { get: (...args) => { reads++; if (failRead) { failRead = false; throw new Error("controlled read failure"); } return statement.get(...args); } };
    }
    if (sql.includes("INSERT INTO video_probe_cache") && failWritePrepare) { failWritePrepare = false; throw new Error("controlled second prepare failure"); }
    const statement = db.prepare(sql);
    if (!sql.includes("INSERT INTO video_probe_cache")) return statement;
    return { run: (...args) => { if (failWrite) { failWrite = false; throw new Error("controlled write failure"); } return statement.run(...args); } };
  } };
  const cache = createVideoProbeCacheService({ getDb: () => controlledDb, warn: (...args) => warnings.push(args) });
  let playback;
  try {
    db.exec("PRAGMA busy_timeout = 150");
    assert.deepEqual(cache.get(entry, signature), { hit: false, value: null });
    assert.equal(db.prepare("PRAGMA busy_timeout").get().timeout, 150);
    assert.equal(cache.start(), true, "partial prepare failure must permit complete reinitialization");
    failWritePrepare = true;
    const partial = createVideoProbeCacheService({ getDb: () => controlledDb, warn: () => {} });
    assert.equal(partial.start(), false, "a read statement alone is not a completed initialization");
    assert.equal(db.prepare("PRAGMA busy_timeout").get().timeout, 150);
    assert.equal(partial.start(), true, "failure of the second prepare also retries initialization");
    assert.equal(cache.set(entry, signature, { duration: 5 }), true);
    failRead = true;
    assert.deepEqual(cache.get(entry, signature), { hit: false, value: null });
    assert.equal(db.prepare("PRAGMA busy_timeout").get().timeout, 150);
    assert.equal(cache.get(entry, signature).value.duration, 5, "a transient read failure must not become a cached miss");
    failWrite = true;
    assert.equal(cache.set(entry, signature, { duration: 8 }), false);
    assert.equal(cache.get(entry, signature).value.duration, 5);
    assert.equal(cache.set(entry, signature, { duration: 8 }), true);
    assert.equal(cache.get(entry, signature).value.duration, 8);
    assert.equal(cache.set(entry, signature, null), true);
    assert.deepEqual(cache.get(entry, signature), { hit: true, value: null }, "negative probe entries remain durable hits");
    const beforeInvalid = reads;
    for (const invalid of [null, {}, { id: entry.id }, { path: entry.path }]) assert.equal(cache.get(invalid, signature).hit, false);
    assert.equal(cache.get(entry, null).hit, false); assert.equal(reads, beforeInvalid);
    db.close();
    assert.deepEqual(cache.get(entry, signature), { hit: false, value: null });
    assert.equal(cache.set(entry, signature, { duration: 9 }), false);
    playback = fixture({ persistentCache: cache, safeStat: () => null, statFile: async () => null,
      execFileFn: () => assert.fail("closed-cache fallback must not launch a real probe") }).service;
    const response = await playback.playInfoForFileAsync(entry);
    assert.equal(response.mode, "direct"); assert.equal(response.duration, null);
    assert(warnings.some(([label]) => label === "[video-probe-cache]") && warnings.some(([label]) => label === "[video-probe-cache-read]") && warnings.some(([label]) => label === "[video-probe-cache-write]"));
  } finally { await playback?.stop(); if (db.isOpen) db.close(); }
}

function verifyPersistentLockFallback() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fanhao-probe-cache-lock-"));
  const databasePath = path.join(directory, "cache.sqlite");
  const db = new DatabaseSync(databasePath);
  let writer = new DatabaseSync(databasePath), observedWait = null, observedReadWait = null;
  const controlledDb = {
    exec: (sql) => db.exec(sql),
    prepare: (sql) => {
      const statement = db.prepare(sql);
      if (/SELECT[\s\S]*FROM video_probe_cache/.test(sql)) return { get: (...args) => {
        observedReadWait = db.prepare("PRAGMA busy_timeout").get().timeout;
        return statement.get(...args);
      } };
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
    assert.equal(coldCache.set(file(), { size: 1, mtimeMs: 1 }, { duration: 42 }), true);
    writer.close();
    db.exec("PRAGMA journal_mode = DELETE");
    writer = new DatabaseSync(databasePath);
    writer.exec("BEGIN EXCLUSIVE");
    const readStarted = performance.now();
    assert.deepEqual(coldCache.get(file(), { size: 1, mtimeMs: 1 }), { hit: false, value: null }, "locked cold reads remain optional cache misses");
    const lockedReadMs = performance.now() - readStarted;
    assert.equal(observedReadWait, 0, "cold point reads never borrow the main database's lock wait policy");
    assert.equal(db.prepare("PRAGMA busy_timeout").get().timeout, 150, "read failure restores the original policy");
    writer.exec("ROLLBACK");
    assert.equal(coldCache.get(file(), { size: 1, mtimeMs: 1 }).value.duration, 42, "the next read retries after an exclusive lock is released");
    assert.equal(db.prepare("PRAGMA busy_timeout").get().timeout, 150);
    console.log(JSON.stringify({ lockedWriteMs: Number(lockedWriteMs.toFixed(1)), lockedReadMs: Number(lockedReadMs.toFixed(1)), fixture: "private SQLite writer/read locks, cache wait policy = 0" }));
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
await verifyPersistentPointReads();
await verifyPersistentFailures();
verifyPersistentLockFallback();
await verifyHttpResponsiveness();
console.log("Video probe source identity, generation isolation, bounded retention and asynchronous HTTP checks passed.");
