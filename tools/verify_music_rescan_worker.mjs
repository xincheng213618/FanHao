import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { spawn } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { Worker } from "node:worker_threads";
import { fileURLToPath } from "node:url";
import { createMusicRuntime } from "../src/modules/music/server/runtime.js";
import { musicPublicError } from "../src/modules/music/server/public-errors.js";
import { createMusicProgressWriter as createAndroidMusicProgressWriter } from "../android-client/www/modules/music/music-progress-writer.js";
import { createMusicProgressWriter as createWebMusicProgressWriter } from "../public/modules/music/music-progress-writer.js";
import { scanMusicRoots, scanSummary, writeScanRecords } from "../src/modules/music/server/scan.js";
import { createMusicScanWorkerClient } from "../src/modules/music/server/scan-worker-client.js";
import { ensureSchema } from "../src/modules/music/server/schema.js";
import { createMusicStore } from "../src/modules/music/server/store.js";

const failureWorkerUrl = new URL("./fixtures/music_scan_worker_failure.mjs", import.meta.url);
const databaseLockWorkerUrl = new URL("./fixtures/music_database_lock.mjs", import.meta.url);
const productionWorkerUrl = new URL("../src/modules/music/server/scan-worker.js", import.meta.url);
const shutdownFixtureUrl = new URL("./fixtures/server_host_shutdown_rescan.mjs", import.meta.url);
const owned = createOwnedFixtureDirectory();
let metrics = null;

try {
  const fixture = createMusicFixture(owned.fixtureDir);
  await verifyLegacyPersistenceEquivalence(fixture);
  await verifyAtomicFailures(fixture);
  await verifyCommittedCrashInvalidatesReaders(fixture);
  await verifyCheckpointDoesNotDelaySuccess(fixture);
  await verifyLockedSchemaStartup(fixture);
  await verifySingleFlightAndStop(fixture);
  await verifyAllMainThreadWritesFailFast(fixture);
  await verifyClientWriteRecovery("Web", createWebMusicProgressWriter);
  await verifyClientWriteRecovery("Android", createAndroidMusicProgressWriter);
  const responsiveness = await verifyHttpResponsivenessAndSnapshots(fixture);
  await verifyServerHostShutdown();
  const timing = await verifyWorkerTiming(fixture);
  metrics = { ...timing, ...responsiveness };
  verifySourceBoundary();
  console.log(JSON.stringify({ ok: true, ...metrics }, null, 2));
} finally {
  owned.cleanup();
}

async function verifyLegacyPersistenceEquivalence(fixture) {
  const directDbPath = path.join(fixture.baseDir, "direct.sqlite");
  const workerDbPath = path.join(fixture.baseDir, "worker.sqlite");
  const records = scanMusicRoots(fixture.roots, fixture.probeOptions);
  const retainedTrackId = records.tracks[0].id;
  seedOldSnapshot(directDbPath, retainedTrackId);
  seedOldSnapshot(workerDbPath, retainedTrackId);

  const directSummary = scanSummary(records, fixture.roots, false);
  const directDb = new DatabaseSync(directDbPath);
  try {
    writeScanRecords(directDb, records, fixture.roots, directSummary.scannedAt);
  } finally {
    directDb.close();
  }

  const store = createMusicStore({
    dbPath: workerDbPath,
    roots: fixture.roots,
    ...fixture.probeOptions
  });
  try {
    const workerSummary = await store.scan({ roots: fixture.roots });
    assert.deepEqual(normalizeSummary(workerSummary), normalizeSummary(directSummary), "worker success payload must match the legacy scan summary");
    assert.deepEqual(dumpCatalog(workerDbPath), dumpCatalog(directDbPath), "worker persistence must match the legacy transaction row-for-row");

    const workerDb = new DatabaseSync(workerDbPath, { readOnly: true });
    try {
      const managed = workerDb.prepare("SELECT title,display_artist,album_title,codec,duration_ms,has_lrc,lrc_path FROM music_tracks WHERE file_name = '04-managed.flac'").get();
      assert.deepEqual({ ...managed, lrc_path: path.basename(managed.lrc_path) }, {
        title: "Managed Title",
        display_artist: "Managed Artist",
        album_title: "Managed Album",
        codec: "FLAC",
        duration_ms: 245000,
        has_lrc: 1,
        lrc_path: "04-managed.lrc"
      }, "managed catalog metadata and lyric sidecars must survive the worker boundary");
      const timeoutTrack = workerDb.prepare("SELECT error,status FROM music_tracks WHERE file_name = '06-timeout.mp3'").get();
      assert.equal(timeoutTrack.status, "ok");
      assert.match(timeoutTrack.error, /timed out|ETIMEDOUT/i, "ffprobe timeout must publish a complete catalog with the legacy per-track error marker");
      const recovered = workerDb.prepare("SELECT title,display_artist FROM music_tracks WHERE file_name = '05 - 刘若英 - 后来.mp3'").get();
      const directRecovered = records.tracks.find((track) => track.fileName === "05 - 刘若英 - 后来.mp3");
      assert.deepEqual({ ...recovered }, { title: directRecovered.title, display_artist: directRecovered.displayArtist }, "filename identity recovery must match the legacy parser exactly");
      assert.equal(recovered.display_artist, "刘若英", "unknown-artist folder recovery must keep the parsed artist identity");
      const naturalOrder = workerDb.prepare("SELECT file_name FROM music_tracks WHERE source_path LIKE ? ORDER BY rowid").all(`%${path.sep}Album One${path.sep}%`).map((row) => row.file_name);
      assert.deepEqual(naturalOrder, ["01 - First.mp3", "02 - Second.mp3", "10 - Tenth.mp3"], "numeric filename ordering must remain stable across the worker boundary");
      const album = workerDb.prepare("SELECT cover_path,intro_path,intro_text FROM music_albums WHERE cover_path <> '' LIMIT 1").get();
      assert.ok(album, "album cover and introduction sidecars must be indexed");
      assert.equal(path.basename(album.cover_path), "cover.jpg");
      assert.equal(path.basename(album.intro_path), "Album One.txt");
      assert.equal(album.intro_text, "Fixture album introduction");
    } finally {
      workerDb.close();
    }

    const beforeDryRun = dumpCatalog(workerDbPath);
    const directDryRecords = scanMusicRoots(fixture.roots, { ...fixture.probeOptions, limit: 3 });
    const workerDrySummary = await store.scan({ roots: fixture.roots, limit: 3, dry_run: true });
    assert.deepEqual(
      normalizeSummary(workerDrySummary),
      normalizeSummary(scanSummary(directDryRecords, fixture.roots, true)),
      "limit and dryRun response semantics must match the legacy implementation"
    );
    assert.deepEqual(dumpCatalog(workerDbPath), beforeDryRun, "dryRun must not mutate any committed music data");

    const directLimitSummary = scanSummary(directDryRecords, fixture.roots, false);
    const directLimitDb = new DatabaseSync(directDbPath);
    try {
      writeScanRecords(directLimitDb, directDryRecords, fixture.roots, directLimitSummary.scannedAt);
    } finally {
      directLimitDb.close();
    }
    await store.scan({ root: fixture.roots[0], limit: 3 });
    assert.deepEqual(dumpCatalog(workerDbPath), dumpCatalog(directDbPath), "limited worker publication must preserve legacy row order and data");
  } finally {
    await store.stop();
  }
}

async function verifyAtomicFailures(fixture) {
  await verifyWorkerCrashKeepsOldSnapshot(fixture);
  await verifySqlFailureRollsBack(fixture);
  await verifyBusyFailureKeepsOldSnapshot(fixture);
}

async function verifyWorkerCrashKeepsOldSnapshot(fixture) {
  const dbPath = path.join(fixture.baseDir, "worker-crash.sqlite");
  seedOldSnapshot(dbPath, "future-track");
  const before = dumpCatalog(dbPath);
  const client = createMusicScanWorkerClient({
    dbPath,
    workerUrl: failureWorkerUrl,
    extraWorkerData: { mode: "crash", exitCode: 23 }
  });
  try {
    await assert.rejects(client.scan({ roots: fixture.roots }), (error) => error.code === "MUSIC_SCAN_WORKER_EXIT" && error.statusCode === 503);
    assert.deepEqual(dumpCatalog(dbPath), before, "a worker crash before commit must keep the old catalog intact");
  } finally {
    await client.stop();
  }
}

async function verifyCommittedCrashInvalidatesReaders(fixture) {
  const dbPath = path.join(fixture.baseDir, "committed-worker-crash.sqlite");
  seedOldSnapshot(dbPath, "old-track");
  const store = createMusicStore({
    dbPath,
    roots: fixture.roots,
    scanWorkerUrl: failureWorkerUrl,
    scanWorkerData: { mode: "commit-exit", exitCode: 27 }
  });
  let oldReader = null;
  try {
    await store.start();
    assert.equal(store.summary().totals.tracks, 1);
    assert.equal(store.facets().artists[0].name, "Old Artist", "fixture must warm the old facet cache before the uncertain result");
    oldReader = new DatabaseSync(dbPath, { readOnly: true });
    oldReader.exec("BEGIN");
    assert.equal(oldReader.prepare("SELECT title FROM music_tracks WHERE id = 'old-track'").get().title, "Old Track");
    await assert.rejects(
      store.scan({ roots: fixture.roots }),
      (error) => error.code === "MUSIC_SCAN_WORKER_EXIT" && error.statusCode === 503
    );
    assert.equal(store.trackDetail("old-track").track.title, "New Track", "a dispatched worker failure must reopen the main connection after a possible commit");
    assert.equal(store.facets().artists[0].name, "New Artist", "a dispatched worker failure must invalidate cached facets after a possible commit");
  } finally {
    try { oldReader?.exec("ROLLBACK"); } catch {}
    try { oldReader?.close(); } catch {}
    await store.stop();
  }
}

async function verifyCheckpointDoesNotDelaySuccess(fixture) {
  const dbPath = path.join(fixture.baseDir, "checkpoint-after-result.sqlite");
  seedOldSnapshot(dbPath, "future-track");
  const worker = new Worker(productionWorkerUrl, {
    workerData: {
      dbPath,
      ...fixture.probeOptions,
      checkpointDelayMs: 1200
    }
  });
  try {
    await waitForWorkerMessage(worker, (message) => message?.type === "ready");
    const requestId = 401;
    const result = waitForWorkerMessage(worker, (message) => message?.type === "result" && message.id === requestId);
    worker.postMessage({ type: "scan", id: requestId, request: { roots: fixture.slowRoots, limit: 1, dryRun: false } });
    const publishedAt = await waitForWorkerMessage(worker, (message) => message?.type === "phase" && message.id === requestId && message.phase === "publishing")
      .then(() => performance.now());
    const message = await result;
    const resultAfterPublishMs = performance.now() - publishedAt;
    assert.equal(message.ok, true);
    assert.ok(resultAfterPublishMs < 500, `success acknowledgement waited ${resultAfterPublishMs.toFixed(2)} ms for a best-effort checkpoint`);
  } finally {
    await worker.terminate();
  }
}

async function verifyLockedSchemaStartup(fixture) {
  const dbPath = path.join(fixture.baseDir, "locked-incomplete-schema.sqlite");
  seedIncompleteSchema(dbPath);
  const lockWorker = new Worker(databaseLockWorkerUrl, { workerData: { dbPath, holdMs: 1250 } });
  const released = waitForWorkerMessage(lockWorker, (message) => message?.type === "released");
  const store = createMusicStore({ dbPath, roots: fixture.roots });
  try {
    await waitForWorkerMessage(lockWorker, (message) => message?.type === "locked");
    const startedAt = performance.now();
    await store.start();
    const startupMs = performance.now() - startedAt;
    assert.ok(startupMs >= 1000 && startupMs < 5000, `schema initialization did not use its bounded startup wait (${startupMs.toFixed(2)} ms)`);
    await released;
    const database = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const tables = new Set(database.prepare("SELECT name FROM sqlite_master WHERE type IN ('table','view')").all().map((row) => row.name));
      for (const table of ["music_tracks", "music_track_state", "music_playlists", "music_search_phonetic"]) {
        assert.ok(tables.has(table), `locked incomplete-schema startup did not finish ${table}`);
      }
    } finally {
      database.close();
    }

    store.invalidate();
    const runtimeLock = new DatabaseSync(dbPath);
    runtimeLock.exec("BEGIN IMMEDIATE");
    try {
      const readStartedAt = performance.now();
      assert.equal(store.summary().totals.tracks, 0);
      assert.ok(performance.now() - readStartedAt < 75, "post-initialization connection reopen repeated the schema lock wait");
      const mutationStartedAt = performance.now();
      assert.throws(store.clearHistory, (error) => error.code === "MUSIC_WRITE_BUSY" && error.statusCode === 503);
      assert.ok(performance.now() - mutationStartedAt < 75, "main connection did not return to busy_timeout=0 after schema initialization");
    } finally {
      runtimeLock.exec("ROLLBACK");
      runtimeLock.close();
    }
  } finally {
    await lockWorker.terminate().catch(() => undefined);
    await store.stop();
  }

  const failureDbPath = path.join(fixture.baseDir, "locked-schema-timeout.sqlite");
  seedIncompleteSchema(failureDbPath);
  const failureLock = new Worker(databaseLockWorkerUrl, { workerData: { dbPath: failureDbPath, holdMs: 140 } });
  const failureReleased = waitForWorkerMessage(failureLock, (message) => message?.type === "released");
  const retryStore = createMusicStore({ dbPath: failureDbPath, roots: fixture.roots, schemaBusyTimeoutMs: 30 });
  try {
    await waitForWorkerMessage(failureLock, (message) => message?.type === "locked");
    await assert.rejects(retryStore.start(), (error) => {
      assert.equal(error.code, "MUSIC_SCHEMA_DATABASE_BUSY");
      assert.equal(error.statusCode, 503);
      assert.equal(error.retryable, true);
      assert.doesNotMatch(error.message, /sqlite|database is locked|[A-Z]:\\/i);
      assert.deepEqual(musicPublicError(error, "音乐数据库初始化失败"), {
        status: 503,
        payload: { error: error.message, code: "MUSIC_SCHEMA_DATABASE_BUSY", retryable: true },
        log: false
      });
      return true;
    });
    await failureReleased;
    await retryStore.start();
    assert.equal(retryStore.summary().totals.tracks, 0, "a bounded schema lock failure must leave initialization safely retryable");
  } finally {
    await failureLock.terminate().catch(() => undefined);
    await retryStore.stop();
  }
}

async function verifySqlFailureRollsBack(fixture) {
  const dbPath = path.join(fixture.baseDir, "sql-failure.sqlite");
  seedOldSnapshot(dbPath, "future-track");
  const database = new DatabaseSync(dbPath);
  database.exec(`
    UPDATE music_tracks SET genre = NULL;
    CREATE TRIGGER fail_music_publish
    BEFORE INSERT ON music_tracks
    BEGIN
      SELECT RAISE(ABORT, 'fixture publish failure');
    END;
  `);
  database.close();
  const before = dumpCatalog(dbPath);
  const store = createMusicStore({ dbPath, roots: fixture.roots, ...fixture.probeOptions });
  try {
    await assert.rejects(store.scan({ roots: fixture.roots }), (error) => error.code === "MUSIC_SCAN_DATABASE_UNAVAILABLE" && error.statusCode === 500);
    assert.deepEqual(dumpCatalog(dbPath), before, "an insert failure after catalog deletes must roll the whole publication back");
  } finally {
    await store.stop();
  }
}

async function verifyBusyFailureKeepsOldSnapshot(fixture) {
  const dbPath = path.join(fixture.baseDir, "busy.sqlite");
  seedOldSnapshot(dbPath, "future-track");
  const before = dumpCatalog(dbPath);
  const lock = new DatabaseSync(dbPath);
  lock.exec("BEGIN IMMEDIATE");
  const store = createMusicStore({
    dbPath,
    roots: fixture.roots,
    busyTimeoutMs: 50,
    ...fixture.probeOptions
  });
  try {
    await assert.rejects(store.scan({ roots: fixture.roots }), (error) => error.code === "MUSIC_SCAN_DATABASE_BUSY" && error.statusCode === 503);
    assert.deepEqual(dumpCatalogWithDatabase(lock), before, "SQLITE_BUSY must not replace any part of the committed catalog");
  } finally {
    lock.exec("ROLLBACK");
    lock.close();
    await store.stop();
  }
}

async function verifySingleFlightAndStop(fixture) {
  const missingRootStore = createMusicStore({ dbPath: path.join(fixture.baseDir, "missing-root.sqlite"), roots: [] });
  try {
    await assert.rejects(missingRootStore.scan({}), (error) => error.statusCode === 400 && error.message === "没有配置音乐目录");
    assert.equal(missingRootStore.scanDiagnostics().workerStarts, 0, "invalid scan input must fail before worker startup");
  } finally {
    await missingRootStore.stop();
  }

  const dbPath = path.join(fixture.baseDir, "single-flight.sqlite");
  seedOldSnapshot(dbPath, "future-track");
  const store = createMusicStore({ dbPath, roots: fixture.slowRoots, ...fixture.probeOptions });
  try {
    const first = store.scan({ roots: fixture.slowRoots, dryRun: true });
    const same = store.scan({ roots: fixture.slowRoots, dryRun: true });
    const conflict = assert.rejects(
      store.scan({ roots: fixture.slowRoots, dryRun: true, limit: 1 }),
      (error) => error.code === "MUSIC_SCAN_CONFLICT" && error.statusCode === 409
    );
    const [firstResult, sameResult] = await Promise.all([first, same]);
    await conflict;
    assert.deepEqual(firstResult, sameResult);
    const diagnostics = store.scanDiagnostics();
    assert.equal(diagnostics.scanDispatches, 1, "identical concurrent scans must share one worker dispatch");
    assert.equal(diagnostics.coalescedScans, 1);
    assert.equal(diagnostics.conflictingScans, 1);
  } finally {
    await store.stop();
  }

  const stopDbPath = path.join(fixture.baseDir, "stop.sqlite");
  seedOldSnapshot(stopDbPath, "future-track");
  const beforeStop = dumpCatalog(stopDbPath);
  const client = createMusicScanWorkerClient({
    dbPath: stopDbPath,
    workerUrl: failureWorkerUrl,
    extraWorkerData: { mode: "hang" }
  });
  const scanPromise = client.scan({ roots: fixture.roots });
  const stopped = assert.rejects(scanPromise, (error) => error.code === "MUSIC_SCAN_WORKER_STOPPED" && error.statusCode === 503);
  await waitFor(() => client.diagnostics().scanDispatches === 1);
  await client.stop();
  await stopped;
  assert.deepEqual(dumpCatalog(stopDbPath), beforeStop, "stopping an active worker must leave the old snapshot intact");
  await assert.rejects(client.scan({ roots: fixture.roots }), (error) => error.code === "MUSIC_SCAN_WORKER_STOPPED");
}

async function verifyAllMainThreadWritesFailFast(fixture) {
  const dbPath = path.join(fixture.baseDir, "all-writes-fail-fast.sqlite");
  seedOldSnapshot(dbPath, "old-track");
  const store = createMusicStore({ dbPath, roots: fixture.roots });
  store.summary();
  const lock = new DatabaseSync(dbPath);
  lock.exec("BEGIN IMMEDIATE");
  const before = dumpCatalogWithDatabase(lock);
  const oldPath = path.join(path.dirname(dbPath), "old.mp3");
  const mutations = [
    ["saveProgress", () => store.saveProgress("old-track", { positionMs: 50, played: true })],
    ["toggleFavorite", () => store.toggleFavorite("old-track", { favorite: false })],
    ["setRating", () => store.setRating("old-track", { rating: 1 })],
    ["clearHistory", () => store.clearHistory()],
    ["createPlaylist", () => store.createPlaylist({ name: "Busy fixture" })],
    ["updatePlaylist", () => store.updatePlaylist("playlist-1", { name: "Busy fixture" })],
    ["importM3uPlaylist", () => store.importM3uPlaylist({ name: "Busy import", content: `#EXTM3U\n${oldPath}` })],
    ["deletePlaylist", () => store.deletePlaylist("playlist-1")],
    ["addToPlaylist", () => store.addToPlaylist("playlist-1", "old-track")],
    ["removeFromPlaylist", () => store.removeFromPlaylist("playlist-1", "old-track")],
    ["reorderPlaylist", () => store.reorderPlaylist("playlist-1", { trackIds: ["old-track"] })]
  ];
  try {
    const startedAt = performance.now();
    for (const [name, mutate] of mutations) {
      const mutationStartedAt = performance.now();
      assert.throws(mutate, (error) => error.code === "MUSIC_WRITE_BUSY" && error.statusCode === 503 && error.retryable === true, `${name} must use the shared fail-fast write boundary`);
      assert.ok(performance.now() - mutationStartedAt < 75, `${name} waited on SQLite instead of failing fast`);
    }
    assert.ok(performance.now() - startedAt < 250, "the complete music mutation surface waited on SQLite locks");
    assert.deepEqual(dumpCatalogWithDatabase(lock), before, "no fail-fast mutation may partially change a table");
  } finally {
    lock.exec("ROLLBACK");
    lock.close();
    await store.stop();
  }
}

async function verifyClientWriteRecovery(clientName, createWriter) {
  const interleaved = createProgressWriterFixture(createWriter, ["busy", "busy", "busy", "success", "success"]);
  const record = { activeUrl: "http://fixture", trackId: "track-1", positionMs: 10, durationMs: 100 };
  interleaved.writer.reportPlayed({ ...record, reportKey: "busy", session: 1 });
  await runNextFixtureTimer(interleaved.timers, 0);
  interleaved.writer.save({ ...record, positionMs: 30 }, { delayMs: 800 });
  interleaved.writer.reportPlayed({ ...record, reportKey: "busy", session: 1 });
  await runNextFixtureTimer(interleaved.timers, 800);
  await runNextFixtureTimer(interleaved.timers, 1000);
  await runNextFixtureTimer(interleaved.timers, 1000);
  await runNextFixtureTimer(interleaved.timers, 0);
  assert.deepEqual(interleaved.sends.map(({ positionMs, played }) => ({ positionMs, played })), [
    { positionMs: 10, played: true },
    { positionMs: 30, played: false },
    { positionMs: 30, played: true },
    { positionMs: 30, played: false },
    { positionMs: 30, played: true }
  ], `${clientName} must serialize and merge interleaved played/progress busy retries`);
  assert.deepEqual(interleaved.persisted, { positionMs: 30, playCount: 1 });
  assert.deepEqual(interleaved.successfulPlayed, ["busy"]);
  assert.equal(interleaved.timers.size, 0);

  const unknown = createProgressWriterFixture(createWriter, ["unknown-committed"]);
  unknown.writer.reportPlayed({ ...record, reportKey: "unknown", session: 2 });
  await runNextFixtureTimer(unknown.timers, 0);
  unknown.writer.reportPlayed({ ...record, reportKey: "unknown", session: 2 });
  assert.equal(unknown.sends.length, 1, `${clientName} must not replay an unknown-result played write`);
  assert.deepEqual(unknown.persisted, { positionMs: 10, playCount: 1 });
  assert.deepEqual(unknown.successfulPlayed, []);
  assert.equal(unknown.timers.size, 0);

  const sessions = createProgressWriterFixture(createWriter, ["busy", "success", "success"]);
  sessions.writer.reportPlayed({ ...record, reportKey: "session-1", session: 1 });
  await runNextFixtureTimer(sessions.timers, 0);
  sessions.writer.reportPlayed({ ...record, positionMs: 30, reportKey: "session-2", session: 2 });
  await runNextFixtureTimer(sessions.timers, 0);
  await runNextFixtureTimer(sessions.timers, 0);
  assert.deepEqual(sessions.sends.map(({ reportKey, positionMs }) => ({ reportKey, positionMs })), [
    { reportKey: "session-1", positionMs: 10 },
    { reportKey: "session-1", positionMs: 30 },
    { reportKey: "session-2", positionMs: 30 }
  ], `${clientName} must preserve every same-track played token while merging the latest position`);
  assert.deepEqual(sessions.persisted, { positionMs: 30, playCount: 2 });
  assert.deepEqual(sessions.successfulPlayed, ["session-1", "session-2"]);
  assert.equal(sessions.timers.size, 0);
}

function createProgressWriterFixture(createWriter, outcomes) {
  let timerId = 0;
  const timers = new Map();
  const sends = [];
  const successfulPlayed = [];
  const persisted = { positionMs: 0, playCount: 0 };
  const writer = createWriter({
    setTimeoutFn(callback, delayMs) {
      const id = ++timerId;
      timers.set(id, { callback, delayMs });
      return id;
    },
    clearTimeoutFn(id) { timers.delete(id); },
    async send(record, played) {
      sends.push({ reportKey: record.reportKey || "", positionMs: record.positionMs, durationMs: record.durationMs, played });
      const outcome = outcomes.shift() || "success";
      if (outcome === "busy") {
        throw Object.assign(new Error("busy"), { status: 503, code: "MUSIC_WRITE_BUSY", retryable: true });
      }
      persisted.positionMs = record.positionMs;
      if (played) persisted.playCount += 1;
      if (outcome === "unknown-committed") throw new Error("response lost after commit");
    },
    onPlayed(record) { successfulPlayed.push(record.reportKey); }
  });
  return { writer, timers, sends, successfulPlayed, persisted };
}

async function runNextFixtureTimer(timers, expectedDelayMs) {
  const entry = timers.entries().next().value;
  assert.ok(entry, `expected a ${expectedDelayMs} ms fixture timer`);
  const [id, timer] = entry;
  timers.delete(id);
  assert.equal(timer.delayMs, expectedDelayMs);
  timer.callback();
  await delay(0);
}

async function verifyHttpResponsivenessAndSnapshots(fixture) {
  const dbPath = path.join(fixture.baseDir, "http.sqlite");
  const futureTrackId = scanMusicRoots(fixture.slowRoots, { ...fixture.probeOptions, limit: 1 }).tracks[0].id;
  seedOldSnapshot(dbPath, futureTrackId, futureTrackId, { withPlaylistItem: false });
  const runtime = createMusicRuntime({
    dbPath,
    ffprobePath: process.execPath,
    roots: fixture.slowRoots,
    scanWorkerOptions: {
      ...fixture.probeOptions,
      scanWorkerData: { publishDelayMs: 1200 }
    },
    mediaResponseService: { serveImage() {} },
    mediaStreamService: { serveVideo() {} },
    serveDownloadFile() {},
    notFound(res) { res.writeHead(404).end(); },
    readJsonBody,
    requireLocalAdmin() { return true; },
    sendJson
  });
  await runtime.start();
  const server = http.createServer(async (req, res) => {
    if (req.url === "/api/health") {
      sendJson(res, 200, { ok: true });
      return;
    }
    const handled = await runtime.routeApi(req, res, new URL(req.url, "http://127.0.0.1"));
    if (!handled) res.writeHead(404).end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const heartbeat = startHeartbeat(10);
  try {
    const initialSummary = await fetchJson(`${baseUrl}/api/music/summary`);
    assert.equal(initialSummary.totals.tracks, 1);
    const initialTrack = await fetchJson(`${baseUrl}/api/music/tracks/${encodeURIComponent(futureTrackId)}`);
    assert.equal(initialTrack.track.title, "Old Track");
    const beforeWrites = dumpMutableState(dbPath);
    const startedAt = performance.now();
    const rescan = fetch(`${baseUrl}/api/music/rescan`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ roots: fixture.slowRoots })
    });
    await waitFor(() => runtime.store.scanDiagnostics().activePhase === "publishing");

    const oldTrack = await fetchJson(`${baseUrl}/api/music/tracks/${encodeURIComponent(futureTrackId)}`);
    assert.equal(oldTrack.track.title, "Old Track", "readers must keep seeing the old committed snapshot during the worker write transaction");

    const heartbeatBeforeWrites = heartbeat.snapshot().ticks;
    const writesStartedAt = performance.now();
    const [progressBusy, favoriteBusy, playlistBusy, healthDuringWrites] = await Promise.all([
      fetchResponse(`${baseUrl}/api/music/tracks/${encodeURIComponent(futureTrackId)}/progress`, {
        method: "POST", body: { positionMs: 321, durationMs: 123456, played: true }
      }),
      fetchResponse(`${baseUrl}/api/music/tracks/${encodeURIComponent(futureTrackId)}/favorite`, {
        method: "POST", body: { favorite: false }
      }),
      fetchResponse(`${baseUrl}/api/music/playlists/playlist-1/tracks`, {
        method: "POST", body: { trackId: futureTrackId }
      }),
      fetchResponse(`${baseUrl}/api/health`)
    ]);
    const publishingWriteBatchMs = performance.now() - writesStartedAt;
    for (const response of [progressBusy, favoriteBusy, playlistBusy]) {
      assert.equal(response.status, 503);
      assert.deepEqual(response.body, {
        error: "音乐数据正在更新，请稍后重试",
        code: "MUSIC_WRITE_BUSY",
        retryable: true
      });
      assert.doesNotMatch(JSON.stringify(response.body), /sqlite|database is locked|\\|\/tmp\//i, "busy responses must not leak SQLite or filesystem details");
    }
    assert.equal(healthDuringWrites.status, 200);
    assert.equal(healthDuringWrites.body.ok, true);
    assert.ok(publishingWriteBatchMs < 250, `publishing writes blocked the event loop for ${publishingWriteBatchMs.toFixed(2)} ms`);
    await delay(40);
    assert.ok(heartbeat.snapshot().ticks > heartbeatBeforeWrites, "10 ms heartbeat must continue through publishing write conflicts");
    assert.deepEqual(dumpMutableState(dbPath), beforeWrites, "failed publishing writes must not partially change progress, favorite, or playlist rows");

    const healthLatencies = [];
    for (let index = 0; index < 6; index += 1) {
      const healthStartedAt = performance.now();
      const health = await fetchJson(`${baseUrl}/api/health`);
      healthLatencies.push(performance.now() - healthStartedAt);
      assert.equal(health.ok, true);
      await delay(15);
    }
    const response = await (await rescan).json();
    const snapshotScanMs = performance.now() - startedAt;
    assert.deepEqual(Object.keys(response).sort(), ["dryRun", "ok", "roots", "scannedAt", "totals"], "rescan success fields must remain compatible");
    assert.equal(response.ok, true);
    assert.equal(response.dryRun, false);
    assert.equal(response.totals.tracks, fixture.slowTrackCount);

    const newSummary = await fetchJson(`${baseUrl}/api/music/summary`);
    assert.equal(newSummary.totals.tracks, fixture.slowTrackCount, "the next read after commit must see the complete new snapshot");

    const progressRetry = await fetchResponse(`${baseUrl}/api/music/tracks/${encodeURIComponent(futureTrackId)}/progress`, {
      method: "POST", body: { positionMs: 321, durationMs: 123456, played: true }
    });
    const favoriteRetry = await fetchResponse(`${baseUrl}/api/music/tracks/${encodeURIComponent(futureTrackId)}/favorite`, {
      method: "POST", body: { favorite: false }
    });
    const playlistRetry = await fetchResponse(`${baseUrl}/api/music/playlists/playlist-1/tracks`, {
      method: "POST", body: { trackId: futureTrackId }
    });
    assert.deepEqual([progressRetry.status, favoriteRetry.status, playlistRetry.status], [200, 200, 200]);
    const afterRetries = dumpMutableState(dbPath);
    const trackState = afterRetries.music_track_state.find((row) => row.track_id === futureTrackId);
    assert.equal(trackState.play_count, 3, "the retried played mutation must increment play_count exactly once");
    assert.equal(trackState.favorite, 0, "the explicit favorite target must be applied exactly once");
    assert.deepEqual(
      afterRetries.music_playlist_items.filter((row) => row.playlist_id === "playlist-1" && row.track_id === futureTrackId).map((row) => row.track_id),
      [futureTrackId],
      "the retried playlist add must create exactly one item"
    );

    const heartbeatResult = heartbeat.stop();
    const maxHealthMs = Math.max(...healthLatencies);
    assert.ok(heartbeatResult.ticks >= 5, `expected heartbeat progress during rescan, got ${heartbeatResult.ticks}`);
    assert.ok(heartbeatResult.maxDelayMs < 200, `main event-loop heartbeat stalled for ${heartbeatResult.maxDelayMs.toFixed(2)} ms`);
    assert.ok(maxHealthMs < 250, `health response stalled for ${maxHealthMs.toFixed(2)} ms`);
    return {
      snapshotScanMs: Number(snapshotScanMs.toFixed(2)),
      heartbeatTicks: heartbeatResult.ticks,
      maxHeartbeatDelayMs: Number(heartbeatResult.maxDelayMs.toFixed(2)),
      maxHealthMs: Number(maxHealthMs.toFixed(2)),
      publishingWriteBatchMs: Number(publishingWriteBatchMs.toFixed(2))
    };
  } finally {
    heartbeat.stop();
    await new Promise((resolve) => server.close(resolve));
    await runtime.stop();
  }
}

async function verifyWorkerTiming(fixture) {
  const dbPath = path.join(fixture.baseDir, "timing.sqlite");
  seedOldSnapshot(dbPath, "future-track");
  const store = createMusicStore({ dbPath, roots: fixture.slowRoots, ...fixture.probeOptions });
  try {
    const coldStartedAt = performance.now();
    const cold = await store.scan({ roots: fixture.slowRoots });
    const coldScanMs = performance.now() - coldStartedAt;
    assert.equal(cold.totals.tracks, fixture.slowTrackCount);
    const prepared = store.scanDiagnostics();

    const warmStartedAt = performance.now();
    const warm = await store.scan({ roots: fixture.slowRoots });
    const warmScanMs = performance.now() - warmStartedAt;
    assert.equal(warm.totals.tracks, fixture.slowTrackCount);
    const diagnostics = store.scanDiagnostics();
    assert.equal(diagnostics.workerStarts, 1, "warm rescan must reuse the prepared worker");
    return {
      workerPrepareMs: Number(prepared.workerStartupMs.toFixed(2)),
      coldScanMs: Number(coldScanMs.toFixed(2)),
      warmScanMs: Number(warmScanMs.toFixed(2))
    };
  } finally {
    await store.stop();
  }
}

function createMusicFixture(baseDir) {
  const root = path.join(baseDir, "library");
  const slowRoot = path.join(baseDir, "slow-library");
  fs.mkdirSync(root, { recursive: true });
  fs.mkdirSync(slowRoot, { recursive: true });
  const albumDir = path.join(root, "Artist Alpha", "Album One");
  const singleDir = path.join(root, "未知歌手", "单曲");
  const managedDir = path.join(root, "Managed Folder", "Managed Album");
  fs.mkdirSync(albumDir, { recursive: true });
  fs.mkdirSync(singleDir, { recursive: true });
  fs.mkdirSync(managedDir, { recursive: true });

  writeMedia(path.join(albumDir, "10 - Tenth.mp3"), 10);
  writeMedia(path.join(albumDir, "02 - Second.mp3"), 20);
  writeMedia(path.join(albumDir, "01 - First.mp3"), 30);
  fs.writeFileSync(path.join(albumDir, "01 - First.lrc"), "[00:01.000]first lyric\n", "utf8");
  fs.writeFileSync(path.join(albumDir, "cover.jpg"), Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
  fs.writeFileSync(path.join(albumDir, "Album One.txt"), "Fixture album introduction", "utf8");
  writeMedia(path.join(singleDir, "05 - 刘若英 - 后来.mp3"), 40);
  writeMedia(path.join(singleDir, "06-timeout.mp3"), 50);
  const managedPath = path.join(managedDir, "04-managed.flac");
  const managedLyric = path.join(managedDir, "04-managed.lrc");
  writeMedia(managedPath, 60);
  fs.writeFileSync(managedLyric, "[00:02.000]managed lyric\n", "utf8");
  createManagedCatalog(root, managedPath, managedLyric);

  const slowTrackCount = 8;
  for (let index = 0; index < slowTrackCount; index += 1) {
    const dir = path.join(slowRoot, `Artist ${index + 1}`, "Slow Album");
    fs.mkdirSync(dir, { recursive: true });
    writeMedia(path.join(dir, `${String(index + 1).padStart(2, "0")}-slow.mp3`), index + 1);
  }

  const fakeProbePath = path.join(baseDir, "fake-ffprobe.mjs");
  fs.writeFileSync(fakeProbePath, `
const filePath = process.argv.at(-1) || "";
const fileName = filePath.replace(/\\\\/g, "/").split("/").at(-1) || "";
if (fileName.includes("timeout")) await new Promise((resolve) => setTimeout(resolve, 2500));
if (fileName.includes("slow")) await new Promise((resolve) => setTimeout(resolve, 55));
const stem = fileName.replace(/\\.[^.]+$/, "");
const recoverFromFileName = fileName.includes("刘若英");
process.stdout.write(JSON.stringify({
  format: {
    duration: "123.456",
    tags: {
      title: recoverFromFileName ? "" : "Probe " + stem,
      artist: recoverFromFileName ? "" : "Probe Artist",
      album: recoverFromFileName ? "" : "Probe Album",
      genre: "Pop", track: "7/12", disc: "1/1", date: "2024"
    }
  },
  streams: [{ codec_name: "mp3", sample_rate: "44100", channels: 2, bits_per_sample: 16 }]
}));
`, "utf8");

  return {
    baseDir,
    roots: [root],
    slowRoots: [slowRoot],
    slowTrackCount,
    probeOptions: {
      ffprobePath: process.execPath,
      ffprobeArgsPrefix: [fakeProbePath],
      ffprobeTimeoutMs: 1000
    }
  };
}

function createManagedCatalog(root, mediaPath, lyricPath) {
  const directory = path.join(root, "_目录");
  fs.mkdirSync(directory, { recursive: true });
  const catalog = new DatabaseSync(path.join(directory, "library.sqlite"));
  try {
    catalog.exec(`
      CREATE TABLE media (
        media_id TEXT PRIMARY KEY,
        media_type TEXT,
        target_relative_path TEXT,
        artist TEXT,
        title TEXT,
        album TEXT,
        album_artist TEXT,
        track_number INTEGER,
        disc_number INTEGER,
        duration_seconds REAL,
        codec TEXT
      );
      CREATE TABLE sidecars (
        sidecar_id INTEGER PRIMARY KEY,
        kind TEXT,
        action TEXT,
        media_id TEXT,
        target_relative_path TEXT,
        is_primary INTEGER
      );
    `);
    catalog.prepare("INSERT INTO media VALUES (?, 'audio', ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
      "managed-1",
      path.relative(root, mediaPath),
      "Managed Artist",
      "Managed Title",
      "Managed Album",
      "Managed Artist",
      4,
      1,
      245,
      "FLAC"
    );
    catalog.prepare("INSERT INTO sidecars VALUES (1, 'lyrics', 'move', ?, ?, 1)").run("managed-1", path.relative(root, lyricPath));
  } finally {
    catalog.close();
  }
}

function seedOldSnapshot(dbPath, retainedTrackId, catalogTrackId = "old-track", options = {}) {
  const now = "2026-08-12T00:00:00.000Z";
  const sourceRoot = path.dirname(dbPath);
  const oldPath = path.join(sourceRoot, "old.mp3");
  const records = {
    artists: [{
      id: "old-artist", name: "Old Artist", sortName: "Old Artist", language: "英文",
      sourceRoot, sourcePath: sourceRoot, relativePath: "", albumCount: 1,
      trackCount: 1, durationMs: 1000, sizeBytes: 1, updatedAt: now
    }],
    albums: [{
      id: "old-album", artistId: "old-artist", title: "Old Album", sortTitle: "Old Album", year: "2020",
      coverPath: "", introPath: "", introText: "", sourceRoot, sourcePath: sourceRoot,
      relativePath: "", trackCount: 1, durationMs: 1000, sizeBytes: 1, updatedAt: now
    }],
    tracks: [{
      id: catalogTrackId, artistId: "old-artist", albumId: "old-album", title: "Old Track", sortTitle: "Old Track",
      displayArtist: "Old Artist", albumTitle: "Old Album", trackNo: 1, discNo: 1, genre: "Pop", language: "英文",
      sourceRoot, sourcePath: oldPath, relativePath: "old.mp3", fileName: "old.mp3", ext: ".mp3", sizeBytes: 1,
      mtimeMs: 1, durationMs: 1000, codec: "MP3", sampleRate: 44100, bitDepth: 16, channels: 2,
      lrcPath: "", hasLrc: 0, status: "ok", error: "", updatedAt: now
    }],
    lyrics: []
  };
  const database = new DatabaseSync(dbPath);
  try {
    ensureSchema(database);
    writeScanRecords(database, records, [sourceRoot], now);
    database.prepare(`
      INSERT INTO music_track_state (track_id,favorite,rating,position_ms,duration_ms,play_count,last_played_at,updated_at)
      VALUES (?,1,5,10,100,2,?,?)
    `).run(retainedTrackId, now, now);
    database.prepare("INSERT INTO music_playlists (id,name,description,created_at,updated_at) VALUES ('playlist-1','Fixture','','2026','2026')").run();
    if (options.withPlaylistItem !== false) {
      database.prepare("INSERT INTO music_playlist_items (playlist_id,track_id,sort_order,added_at) VALUES ('playlist-1',?,1,'2026')").run(retainedTrackId);
    }
  } finally {
    database.close();
  }
}

function seedIncompleteSchema(dbPath) {
  const database = new DatabaseSync(dbPath);
  try {
    database.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE music_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
  } finally {
    database.close();
  }
}

function dumpMutableState(dbPath) {
  const database = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return Object.fromEntries(["music_track_state", "music_playlists", "music_playlist_items"].map((table) => [
      table,
      database.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()
    ]));
  } finally {
    database.close();
  }
}

function dumpCatalog(dbPath) {
  const database = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return dumpCatalogWithDatabase(database);
  } finally {
    database.close();
  }
}

function dumpCatalogWithDatabase(database) {
  const tables = [
    "music_artists", "music_albums", "music_tracks", "music_lyrics",
    "music_search", "music_search_short", "music_search_phonetic",
    "music_track_state", "music_playlists", "music_playlist_items", "music_meta"
  ];
  return Object.fromEntries(tables.map((table) => {
    const order = table === "music_meta" ? "key" : "rowid";
    const rows = database.prepare(`SELECT * FROM ${table} ORDER BY ${order}`).all().map((row) => normalizePersistedRow(table, row));
    return [table, rows];
  }));
}

function normalizePersistedRow(table, row) {
  const result = { ...row };
  if (Object.hasOwn(result, "updated_at")) result.updated_at = "<scan-time>";
  if (table === "music_meta" && result.key === "scanned_at") result.value = "<scan-time>";
  return result;
}

function normalizeSummary(summary) {
  return { ...summary, scannedAt: "<scan-time>" };
}

function verifySourceBoundary() {
  const storeSource = fs.readFileSync(new URL("../src/modules/music/server/store.js", import.meta.url), "utf8");
  const routesSource = fs.readFileSync(new URL("../src/modules/music/server/routes.js", import.meta.url), "utf8");
  const workerSource = fs.readFileSync(new URL("../src/modules/music/server/scan-worker.js", import.meta.url), "utf8");
  assert.doesNotMatch(storeSource, /scanMusicRoots|writeScanRecords|spawnSync/, "the HTTP-side store must only schedule scans and invalidate caches");
  assert.match(routesSource, /await musicStore\.scan/, "the existing endpoint must await asynchronous worker completion");
  assert.match(workerSource, /scanMusicRoots[\s\S]*writeScanRecords/, "the worker must own recursive scanning and atomic publication");
}

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
  res.end(body);
}

async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
}

async function fetchJson(url) {
  const response = await fetch(url);
  assert.equal(response.status, 200);
  return response.json();
}

async function fetchResponse(url, options = {}) {
  const init = { ...options };
  if (Object.hasOwn(init, "body") && init.body !== undefined) {
    init.headers = { "content-type": "application/json", ...(init.headers || {}) };
    init.body = JSON.stringify(init.body);
  }
  const response = await fetch(url, init);
  return { status: response.status, body: await response.json() };
}

function startHeartbeat(intervalMs) {
  let last = performance.now();
  let ticks = 0;
  let maxDelayMs = 0;
  let stopped = false;
  const timer = setInterval(() => {
    const now = performance.now();
    maxDelayMs = Math.max(maxDelayMs, now - last - intervalMs);
    last = now;
    ticks += 1;
  }, intervalMs);
  return {
    snapshot() {
      return { ticks, maxDelayMs };
    },
    stop() {
      if (!stopped) clearInterval(timer);
      stopped = true;
      return { ticks, maxDelayMs };
    }
  };
}

function waitForWorkerMessage(worker, predicate, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error("timed out waiting for worker message")), timeoutMs);
    const onMessage = (message) => {
      if (predicate(message)) finish(null, message);
    };
    const onError = (error) => finish(error);
    const onExit = (code) => finish(new Error(`worker exited before expected message (${code})`));
    function finish(error, value) {
      clearTimeout(timer);
      worker.off("message", onMessage);
      worker.off("error", onError);
      worker.off("exit", onExit);
      if (error) reject(error);
      else resolve(value);
    }
    worker.on("message", onMessage);
    worker.on("error", onError);
    worker.on("exit", onExit);
  });
}

async function verifyServerHostShutdown() {
  const result = await spawnNodeFixture(shutdownFixtureUrl, 5000);
  assert.equal(result.code, 0, `SIGTERM rescan fixture failed:\n${result.stderr || result.stdout}`);
  const markers = [
    "FIXTURE_RESCAN_ACTIVE",
    "FIXTURE_BEGIN_STOP",
    "FIXTURE_RESCAN_CANCELLED",
    "FIXTURE_STOP"
  ];
  let lastIndex = -1;
  for (const marker of markers) {
    const index = result.stdout.indexOf(marker);
    assert.ok(index > lastIndex, `missing or out-of-order shutdown marker ${marker}:\n${result.stdout}`);
    lastIndex = index;
  }
  assert.doesNotMatch(result.stdout, /FIXTURE_FORCE_EXIT/);
}

function spawnNodeFixture(fileUrl, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [fileURLToPath(fileUrl)], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`fixture timed out:\n${stdout}\n${stderr}`));
    }, timeoutMs);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr });
    });
  });
}

async function waitFor(predicate, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for fixture condition");
    await delay(5);
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function writeMedia(filePath, byte) {
  fs.writeFileSync(filePath, Buffer.alloc(128, byte));
}

function createOwnedFixtureDirectory() {
  const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "fanhao-music-rescan-worker-"));
  const tempRootPath = path.dirname(fixtureDir);
  const targetStat = fs.statSync(fixtureDir);
  const ownership = {
    tempRootPath,
    tempRoot: canonicalPath(tempRootPath),
    target: canonicalPath(fixtureDir),
    device: String(targetStat.dev),
    inode: String(targetStat.ino)
  };
  let cleaned = false;
  return {
    fixtureDir,
    cleanup() {
      if (cleaned) return;
      const tempRoot = canonicalPath(tempRootPath);
      const target = canonicalPath(fixtureDir);
      if (target === tempRoot) throw new Error("music rescan fixture cleanup refused its temp root");
      if (!path.basename(target).startsWith("fanhao-music-rescan-worker-")) throw new Error("music rescan fixture cleanup refused an unexpected target");
      if (!target.startsWith(`${tempRoot}${path.sep}`)) throw new Error("music rescan fixture cleanup refused a target outside temp");
      if (tempRoot !== ownership.tempRoot || target !== ownership.target) throw new Error("music rescan fixture cleanup refused a replaced path");
      const stat = fs.statSync(fixtureDir);
      if (String(stat.dev) !== ownership.device || String(stat.ino) !== ownership.inode) throw new Error("music rescan fixture cleanup refused a replacement target");
      fs.rmSync(fixtureDir, { recursive: true, force: false });
      cleaned = true;
    }
  };
}

function canonicalPath(value) {
  const resolved = path.normalize(fs.realpathSync.native(value)).replace(/[\\/]+$/u, "");
  return process.platform === "win32" ? resolved.toLocaleLowerCase("en-US") : resolved;
}
