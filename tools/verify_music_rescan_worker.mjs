import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { DatabaseSync } from "node:sqlite";
import { createMusicRuntime } from "../src/modules/music/server/runtime.js";
import { scanMusicRoots, scanSummary, writeScanRecords } from "../src/modules/music/server/scan.js";
import { createMusicScanWorkerClient } from "../src/modules/music/server/scan-worker-client.js";
import { ensureSchema } from "../src/modules/music/server/schema.js";
import { createMusicStore } from "../src/modules/music/server/store.js";

const failureWorkerUrl = new URL("./fixtures/music_scan_worker_failure.mjs", import.meta.url);
const owned = createOwnedFixtureDirectory();
let metrics = null;

try {
  const fixture = createMusicFixture(owned.fixtureDir);
  await verifyLegacyPersistenceEquivalence(fixture);
  await verifyAtomicFailures(fixture);
  await verifySingleFlightAndStop(fixture);
  const responsiveness = await verifyHttpResponsivenessAndSnapshots(fixture);
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

async function verifyHttpResponsivenessAndSnapshots(fixture) {
  const dbPath = path.join(fixture.baseDir, "http.sqlite");
  seedOldSnapshot(dbPath, "future-track");
  const runtime = createMusicRuntime({
    dbPath,
    ffprobePath: process.execPath,
    roots: fixture.slowRoots,
    scanWorkerOptions: {
      ...fixture.probeOptions,
      scanWorkerData: { publishDelayMs: 200 }
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
    const startedAt = performance.now();
    const rescan = fetch(`${baseUrl}/api/music/rescan`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ roots: fixture.slowRoots })
    });
    await waitFor(() => runtime.store.scanDiagnostics().activePhase === "publishing");

    const oldSummary = await fetchJson(`${baseUrl}/api/music/summary`);
    assert.equal(oldSummary.totals.tracks, 1, "readers must keep seeing the old committed snapshot during the worker write transaction");

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

    const heartbeatResult = heartbeat.stop();
    const maxHealthMs = Math.max(...healthLatencies);
    assert.ok(heartbeatResult.ticks >= 5, `expected heartbeat progress during rescan, got ${heartbeatResult.ticks}`);
    assert.ok(heartbeatResult.maxDelayMs < 200, `main event-loop heartbeat stalled for ${heartbeatResult.maxDelayMs.toFixed(2)} ms`);
    assert.ok(maxHealthMs < 250, `health response stalled for ${maxHealthMs.toFixed(2)} ms`);
    return {
      snapshotScanMs: Number(snapshotScanMs.toFixed(2)),
      heartbeatTicks: heartbeatResult.ticks,
      maxHeartbeatDelayMs: Number(heartbeatResult.maxDelayMs.toFixed(2)),
      maxHealthMs: Number(maxHealthMs.toFixed(2))
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
if (fileName.includes("timeout")) await new Promise((resolve) => setTimeout(resolve, 500));
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
      ffprobeTimeoutMs: 120
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

function seedOldSnapshot(dbPath, retainedTrackId) {
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
      id: "old-track", artistId: "old-artist", albumId: "old-album", title: "Old Track", sortTitle: "Old Track",
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
    database.prepare("INSERT INTO music_playlist_items (playlist_id,track_id,sort_order,added_at) VALUES ('playlist-1',?,1,'2026')").run(retainedTrackId);
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
    stop() {
      if (!stopped) clearInterval(timer);
      stopped = true;
      return { ticks, maxDelayMs };
    }
  };
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
