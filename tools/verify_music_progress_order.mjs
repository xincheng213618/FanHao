import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { performance } from "node:perf_hooks";
import { createMusicStore } from "../src/modules/music/server/store.js";
import { routeMusicApi } from "../src/modules/music/server/routes.js";
import { ensureSchema } from "../src/modules/music/server/schema.js";

// Actual store, router and SQLite, using synthetic metadata only. No service,
// scan worker, media file, user database, browser profile or external request.
const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fanhao-music-progress-order-"));
const dbPath = path.join(directory, "catalog.sqlite");
const database = new DatabaseSync(dbPath);
ensureSchema(database);
const insertTrack = database.prepare(`INSERT INTO music_tracks
  (id,artist_id,album_id,title,source_root,source_path,relative_path,file_name,ext,duration_ms,status,updated_at)
  VALUES (?,'artist','album','Synthetic',?,?,?,?,?,180000,'ok','2026')`);
for (const id of ["ordered", "owner", "equal", "played", "legacy", "expiry", "capacity", "other", "claim", "reuse", "reserve-expiry", "provisional", "custom-reuse"]) {
  insertTrack.run(id, directory, path.join(directory, `${id}.audio`), `${id}.audio`, `${id}.audio`, ".audio");
}
const realNow = Date.now;
let clock = 1800000000000;
Date.now = () => clock;
const ttl = 24 * 60 * 60 * 1000;
let store = createMusicStore({ dbPath, roots: [] });
const stores = new Set([store]);
let serial = 0;
let scenarios = 0;
const metrics = {};
try {
  await verifyLegacyAndClock();
  await verifyValidation();
  await verifySequenceAndReopen();
  await verifyOwnerRetirement();
  await verifyPlayedIndependence();
  await verifyExpiryAndClockRollback();
  await verifyMissingTrackMarkers();
  await verifyCapacityAndPruning();
  await verifyWriteLock();
  await verifyFrozenClockReservations();
  await verifyReservedOwnerAgainstProvisional();
  await verifyLegacyLedgerMigration();
  await verifyActiveClaimReuse();
  await verifyExpiredClaimReplacement();
  console.log(JSON.stringify({ ok: true, scenarios, ...metrics }, null, 2));
} finally {
  Date.now = realNow;
  for (const instance of stores) await instance.stop();
  database.close();
  // Flat owned fixture directory; delete individual SQLite files only.
  for (const name of fs.readdirSync(directory)) fs.unlinkSync(path.join(directory, name));
  fs.rmdirSync(directory);
}

async function verifyLegacyAndClock() {
  store.toggleFavorite("legacy", { favorite: true });
  store.setRating("legacy", { rating: 4 });
  const first = await request("POST", "legacy/progress", { position_ms: 42000, duration_ms: 180000, played: true });
  assert.deepEqual(Object.keys(first.data).sort(), ["ok", "track"]);
  assert.equal(first.data.track.positionMs, 42000);
  assert.equal(first.data.track.favorite, true);
  assert.equal(first.data.track.rating, 4);
  const backward = store.saveProgress("legacy", { positionMs: 5000 });
  assert.equal(backward.positionMs, 5000);
  assert.equal(backward.playCount, 1);
  const beforeClock = database.prepare("SELECT value FROM music_meta WHERE key='progress_clock_ms'").get();
  const clockResponse = await request("GET", "legacy/progress-clock");
  assert.deepEqual(clockResponse, { status: 200, data: { trackId: "legacy", serverClockMs: clock } });
  assert.equal(store.trackDetail("legacy").serverClockMs, clock);
  assert.deepEqual(database.prepare("SELECT value FROM music_meta WHERE key='progress_clock_ms'").get(), beforeClock, "clock GET and track detail are read-only");
  assert.equal(database.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name='music_progress_sessions'").get().n, 0, "legacy writes do not create new ledgers");
  assert.equal((await request("GET", "missing/progress-clock")).status, 404);
  scenarios += 1;
}

async function verifyValidation() {
  const session = cursor();
  const invalid = [
    { progressSessionId: session.progressSessionId },
    { ...session, progressSessionId: "invalid" },
    { ...session, progressSessionStartedAt: "1800000000000" },
    { ...session, progressSessionStartedAt: -1 },
    { ...session, progressSequence: 0 },
    { ...session, progressSequence: Number.MAX_SAFE_INTEGER + 1 },
    { ...session, progressSessionStartedAt: clock + 1 },
    { played: true, playedReportId: uuid() },
    { played: true, playedReportId: "invalid", playedReportStartedAt: clock },
    { played: true, playedReportId: uuid(), playedReportStartedAt: 1.5 },
    { playedReportId: uuid(), playedReportStartedAt: clock },
    { played: true, playedReportId: uuid(), playedReportStartedAt: clock + 1 }
  ];
  const before = state("legacy");
  for (const body of invalid) {
    const response = await request("POST", "legacy/progress", { positionMs: 99999, ...body });
    assert.equal(response.status, 400);
    assert.deepEqual(state("legacy"), before);
  }
  assert.equal((await request("POST", "missing/progress", { ...cursor(), positionMs: 1 })).status, 404);
  scenarios += 1;
}

async function verifySequenceAndReopen() {
  const session = cursor();
  const first = store.saveProgressOutcome("ordered", { ...session, progressSequence: 2, positionMs: 90000 });
  assert.equal(first.progressApplied, true);
  const secondStore = createMusicStore({ dbPath, roots: [] });
  stores.add(secondStore);
  const stale = secondStore.saveProgressOutcome("ordered", { ...session, progressSequence: 1, positionMs: 10000 });
  assert.equal(stale.progressApplied, false);
  assert.equal(stale.track.positionMs, 90000);
  await store.stop();
  store = createMusicStore({ dbPath, roots: [] });
  stores.add(store);
  const replay = store.saveProgressOutcome("ordered", { ...session, progressSequence: 2, positionMs: 0 });
  assert.equal(replay.progressApplied, false);
  assert.equal(replay.track.positionMs, 90000);
  const seekBackward = store.saveProgressOutcome("ordered", { ...session, progressSequence: 3, positionMs: 5000 });
  assert.equal(seekBackward.progressApplied, true);
  assert.equal(seekBackward.track.positionMs, 5000, "a newer intent may seek backward");
  assert.throws(() => store.saveProgress("ordered", { ...session, progressSessionStartedAt: clock - 1, progressSequence: 4 }), error => error.statusCode === 409);
  metrics.sequence = { stalePositionMs: stale.track.positionMs, newBackwardSeekPositionMs: seekBackward.track.positionMs, durableAcrossConnections: true };
  scenarios += 1;
}

async function verifyOwnerRetirement() {
  const old = cursor(clock - 100);
  const fresh = cursor();
  store.saveProgress("owner", { ...old, positionMs: 10000 });
  store.saveProgress("owner", { ...fresh, positionMs: 90000 });
  const retired = store.saveProgressOutcome("owner", { ...old, progressSequence: 999, positionMs: 20000 });
  assert.equal(retired.progressApplied, false);
  assert.equal(retired.track.positionMs, 90000);
  const unseenOld = store.saveProgressOutcome("owner", { ...cursor(clock - 50), positionMs: 30000 });
  assert.equal(unseenOld.progressApplied, false);
  assert.equal(unseenOld.track.positionMs, 90000);
  const sameBornA = cursor(), sameBornB = cursor();
  store.saveProgress("equal", { ...sameBornA, positionMs: 10000 });
  store.saveProgress("equal", { ...sameBornB, positionMs: 90000 });
  const oldEqual = store.saveProgressOutcome("equal", { ...sameBornA, progressSequence: 999, positionMs: 20000 });
  assert.equal(oldEqual.progressApplied, false);
  assert.equal(oldEqual.track.positionMs, 90000);
  const currentEqual = store.saveProgressOutcome("equal", { ...sameBornB, progressSequence: 2, positionMs: 95000 });
  assert.equal(currentEqual.progressApplied, true);
  metrics.owner = { olderBornCannotReturn: true, retiredEqualBornCannotReturn: true };
  scenarios += 1;
}

async function verifyPlayedIndependence() {
  const session = cursor();
  const event = report();
  store.saveProgress("played", { ...session, progressSequence: 2, positionMs: 90000 });
  const packet = { ...session, progressSequence: 1, ...event, positionMs: 10000, played: true };
  const late = await request("POST", "played/progress", packet);
  assert.equal(late.data.progressApplied, false);
  assert.equal(late.data.playedApplied, true);
  assert.equal(late.data.track.positionMs, 90000);
  assert.equal(late.data.track.playCount, 1);
  // Lost first response / unload copy: reuse exactly the same identifiers.
  const duplicate = await request("POST", "played/progress", packet);
  assert.equal(duplicate.data.progressApplied, false);
  assert.equal(duplicate.data.playedApplied, false);
  assert.equal(duplicate.data.track.playCount, 1);
  const newer = store.saveProgressOutcome("played", { ...session, progressSequence: 3, ...event, positionMs: 5000, played: true });
  assert.equal(newer.progressApplied, true);
  assert.equal(newer.playedApplied, false);
  assert.equal(newer.track.playCount, 1);
  const another = store.saveProgressOutcome("played", { ...session, progressSequence: 2, ...report(), positionMs: 0, played: true });
  assert.equal(another.progressApplied, false);
  assert.equal(another.playedApplied, true);
  assert.equal(another.track.positionMs, 5000);
  assert.equal(another.track.playCount, 2);
  const before = state("played");
  assert.throws(() => store.saveProgress("other", { ...cursor(), ...event, positionMs: 100, played: true }), error => error.statusCode === 409);
  assert.deepEqual(state("played"), before);
  assert.throws(() => store.saveProgress("played", { ...session, progressSequence: 4, ...event, playedReportStartedAt: clock - 1, played: true }), error => error.statusCode === 409);
  assert.deepEqual(state("played"), before);
  // Idempotency survives reopening and a user's history-clear operation.
  await store.stop();
  store = createMusicStore({ dbPath, roots: [] });
  stores.add(store);
  store.clearHistory();
  const afterClear = store.saveProgressOutcome("played", packet);
  assert.equal(afterClear.playedApplied, false);
  assert.equal(afterClear.track.playCount, 0);
  metrics.played = { lateDistinctCountedWithoutPositionRollback: true, duplicateCountedOnce: true, historyClearRetainsReceipt: true };
  scenarios += 1;
}

async function verifyExpiryAndClockRollback() {
  clock += 10000;
  const expiredCursor = { ...cursor(clock - ttl), positionMs: 99999 };
  const expiredReport = { ...report(clock - ttl), played: true, positionMs: 99999 };
  const before = state("legacy");
  const sessionResponse = await request("POST", "legacy/progress", expiredCursor);
  assert.equal(sessionResponse.status, 409);
  assert.equal(sessionResponse.data.code, "MUSIC_PROGRESS_SESSION_EXPIRED");
  const reportResponse = await request("POST", "legacy/progress", expiredReport);
  assert.equal(reportResponse.status, 409);
  assert.equal(reportResponse.data.code, "MUSIC_PLAYED_REPORT_EXPIRED");
  assert.deepEqual(state("legacy"), before);
  const expiryClock = clock;
  assert.equal(Number(database.prepare("SELECT value FROM music_meta WHERE key='progress_clock_ms'").get().value), expiryClock, "an expired-only write commits its newer clock floor");
  clock -= 10000;
  await store.stop();
  store = createMusicStore({ dbPath, roots: [] });
  stores.add(store);
  assert.equal(store.progressClock("legacy").serverClockMs, expiryClock);
  assert.throws(() => store.saveProgress("legacy", expiredCursor), error => error.code === "MUSIC_PROGRESS_SESSION_EXPIRED");
  assert.throws(() => store.saveProgress("legacy", expiredReport), error => error.code === "MUSIC_PLAYED_REPORT_EXPIRED");
  assert.deepEqual(state("legacy"), before);
  clock = expiryClock;
  scenarios += 1;
}

async function verifyMissingTrackMarkers() {
  const session = cursor(), event = report();
  const packet = { ...session, ...event, positionMs: 42000, played: true };
  store.saveProgress("expiry", packet);
  database.prepare("UPDATE music_tracks SET status='missing' WHERE id='expiry'").run();
  store.saveProgress("other", { ...cursor(), positionMs: 1 });
  assert.equal((await request("POST", "expiry/progress", packet)).status, 404);
  database.prepare("UPDATE music_tracks SET status='ok' WHERE id='expiry'").run();
  const replay = store.saveProgressOutcome("expiry", packet);
  assert.equal(replay.progressApplied, false);
  assert.equal(replay.playedApplied, false);
  assert.equal(replay.track.playCount, 1);
  scenarios += 1;
}

async function verifyCapacityAndPruning() {
  resetLedgers();
  const insertSession = database.prepare("INSERT INTO music_progress_sessions(track_id,session_id,started_at,max_sequence,expires_at,retired) VALUES (?,?,?,1,?,0)");
  database.exec("BEGIN IMMEDIATE");
  for (let index = 0; index < 128; index += 1) insertSession.run("capacity", uuid(), clock, clock + ttl);
  database.exec("COMMIT");
  const before = state("capacity");
  const fullTrack = await request("POST", "capacity/progress", { ...cursor(), positionMs: 1234 });
  assertCapacity(fullTrack);
  const fullTrackFloor = store.progressClock("capacity").serverClockMs;
  assertCapacity(await request("POST", "capacity/progress-session", {}));
  assert.equal(store.progressClock("capacity").serverClockMs, fullTrackFloor, "failed reservation leaves the floor unchanged");
  assert.deepEqual(state("capacity"), before);
  resetLedgers();
  database.exec("BEGIN IMMEDIATE");
  for (let index = 0; index < 8192; index += 1) insertSession.run(`missing-${index}`, uuid(), clock, clock + ttl);
  database.exec("COMMIT");
  const global = await request("POST", "capacity/progress", { ...cursor(), positionMs: 1234 });
  assertCapacity(global);
  assertCapacity(await request("POST", "capacity/progress-session", {}));
  assert.equal(database.prepare("SELECT COUNT(*) AS n FROM music_progress_sessions").get().n, 8192, "valid markers are not evicted even when tracks are absent");
  resetLedgers();
  const insertReport = database.prepare("INSERT INTO music_played_receipts(report_id,track_id,started_at,expires_at) VALUES (?,?,?,?)");
  const known = report();
  database.exec("BEGIN IMMEDIATE");
  insertReport.run(known.playedReportId, "capacity", clock, clock + ttl);
  for (let index = 1; index < 8192; index += 1) insertReport.run(uuid(), `missing-${index}`, clock, clock + ttl);
  database.exec("COMMIT");
  const newCursor = cursor();
  const fullReports = await request("POST", "capacity/progress", { ...newCursor, ...report(), positionMs: 1234, played: true });
  assertCapacity(fullReports);
  assert.equal(database.prepare("SELECT COUNT(*) AS n FROM music_progress_sessions WHERE session_id=?").get(newCursor.progressSessionId).n, 0, "report capacity rolls back cursor admission too");
  assert.deepEqual(state("capacity"), before);
  const duplicate = store.saveProgressOutcome("capacity", { ...cursor(), ...known, positionMs: 1, played: true });
  assert.equal(duplicate.playedApplied, false, "known reports remain usable when capacity is full");
  const oldSession = cursor(clock - ttl), oldReport = report(clock - ttl);
  database.prepare("INSERT INTO music_progress_sessions(track_id,session_id,started_at,max_sequence,expires_at,retired) VALUES (?,?,?,1,?,0)").run("other", oldSession.progressSessionId, clock - ttl, clock);
  database.prepare("INSERT INTO music_progress_heads(track_id,session_id,started_at,expires_at) VALUES (?,?,?,?)").run("other", oldSession.progressSessionId, clock - ttl, clock);
  database.prepare("UPDATE music_played_receipts SET started_at=?,expires_at=?").run(clock - ttl, clock);
  database.prepare("UPDATE music_played_receipts SET report_id=? WHERE report_id=?").run(oldReport.playedReportId, known.playedReportId);
  const pruned = store.saveProgressOutcome("other", { ...cursor(), ...report(), played: true, positionMs: 55 });
  assert.equal(pruned.progressApplied, true);
  assert.equal(pruned.playedApplied, true);
  assert.equal(database.prepare("SELECT COUNT(*) AS n FROM music_played_receipts").get().n, 1);
  assert.equal(database.prepare("SELECT COUNT(*) AS n FROM music_progress_sessions WHERE session_id=?").get(oldSession.progressSessionId).n, 0);
  assert.throws(() => store.saveProgress("other", { ...oldReport, played: true }), error => error.code === "MUSIC_PLAYED_REPORT_EXPIRED");
  metrics.capacity = { globalSessionLimit: 8192, perTrackSessionLimit: 128, playedReceiptLimit: 8192, expiredOnlyPruning: true };
  scenarios += 1;
}

async function verifyWriteLock() {
  const before = state("other");
  const sessionCount = database.prepare("SELECT COUNT(*) AS n FROM music_progress_sessions").get().n;
  const floor = store.progressClock("other").serverClockMs;
  database.exec("BEGIN IMMEDIATE");
  const started = performance.now();
  const response = await request("POST", "other/progress", { ...cursor(), ...report(), positionMs: 99999, played: true });
  const claimResponse = await request("POST", "other/progress-session", {});
  const elapsedMs = performance.now() - started;
  database.exec("ROLLBACK");
  assert.equal(response.status, 503);
  assert.equal(response.data.code, "MUSIC_WRITE_BUSY");
  assert.equal(response.data.retryable, true);
  assert.equal(claimResponse.status, 503);
  assert.equal(claimResponse.data.code, "MUSIC_WRITE_BUSY");
  assert.ok(elapsedMs < 250, "initialized write lock must fail promptly");
  assert.deepEqual(state("other"), before);
  assert.equal(database.prepare("SELECT COUNT(*) AS n FROM music_progress_sessions").get().n, sessionCount);
  assert.equal(store.progressClock("other").serverClockMs, floor);
  metrics.lockedWriteMs = Number(elapsedMs.toFixed(3));
  scenarios += 1;
}

async function verifyFrozenClockReservations() {
  const first = await request("POST", "claim/progress-session", {});
  assert.equal(first.status, 200);
  assert.deepEqual(Object.keys(first.data).sort(), ["progressSessionId", "progressSessionStartedAt", "serverClockMs", "trackId"]);
  assert.equal(first.data.serverClockMs, first.data.progressSessionStartedAt);
  const secondStore = createMusicStore({ dbPath, roots: [] });
  stores.add(secondStore);
  const second = secondStore.claimProgressSession("claim");
  assert.notEqual(second.progressSessionId, first.data.progressSessionId);
  assert.ok(second.progressSessionStartedAt > first.data.progressSessionStartedAt, "frozen wall-clock claims still have a durable order");
  assert.equal(state("claim"), null, "reserving does not save position or count");
  assert.equal(database.prepare("SELECT * FROM music_progress_heads WHERE track_id='claim'").get(), undefined);
  const oldPacket = claimBody(first.data, 10000);
  store.saveProgress("claim", claimBody(second, 90000));
  const delayed = store.saveProgressOutcome("claim", oldPacket);
  assert.equal(delayed.progressApplied, false);
  assert.equal(delayed.track.positionMs, 90000, "a held older document's first packet cannot take the newer head");
  const beforeHead = database.prepare("SELECT * FROM music_progress_heads WHERE track_id='claim'").get();
  const beforeState = state("claim");
  const abandoned = store.claimProgressSession("claim");
  assert.deepEqual(database.prepare("SELECT * FROM music_progress_heads WHERE track_id='claim'").get(), beforeHead);
  assert.deepEqual(state("claim"), beforeState, "an unacknowledged reservation does not take ownership");
  const keepalive = store.saveProgressOutcome("claim", { ...claimBody(second, 95000), progressSequence: 2 });
  assert.equal(keepalive.progressApplied, true);
  assert.equal(keepalive.track.positionMs, 95000);
  store.saveProgress("claim", claimBody(abandoned, 5000));
  assert.equal(store.saveProgressOutcome("claim", { ...claimBody(second, 99000), progressSequence: 999 }).progressApplied, false);
  const previousClock = clock;
  clock -= 10000;
  await store.stop();
  store = createMusicStore({ dbPath, roots: [] });
  stores.add(store);
  const afterRestart = store.claimProgressSession("claim");
  assert.ok(afterRestart.progressSessionStartedAt > abandoned.progressSessionStartedAt, "reservation floor survives restart and wall-clock rollback");
  clock = previousClock;
  assert.equal((await request("POST", "claim/progress-session", { previousSessionId: "invalid" })).status, 400);
  assert.equal((await request("POST", "claim/progress-session", { progressSessionId: uuid() })).status, 400, "clients cannot choose a new owner ID");
  assert.equal((await request("POST", "missing/progress-session", {})).status, 404);
  metrics.claims = { frozenClockStrictOrder: true, heldOldDocumentPositionMs: delayed.track.positionMs, reservationDoesNotRetireActiveHead: true, durableAcrossRestart: true };
  scenarios += 1;
}

async function verifyActiveClaimReuse() {
  const owner = store.claimProgressSession("reuse");
  store.saveProgress("reuse", claimBody(owner, 42000));
  const before = database.prepare("SELECT COUNT(*) AS n FROM music_progress_sessions WHERE track_id='reuse'").get().n;
  for (let index = 0; index < 500; index += 1) {
    const reused = store.claimProgressSession("reuse", { previousSessionId: owner.progressSessionId });
    assert.equal(reused.progressSessionId, owner.progressSessionId);
    assert.equal(reused.progressSessionStartedAt, owner.progressSessionStartedAt);
  }
  assert.equal(database.prepare("SELECT COUNT(*) AS n FROM music_progress_sessions WHERE track_id='reuse'").get().n, before);
  const seq2 = store.saveProgressOutcome("reuse", { ...claimBody(owner, 43000), progressSequence: 2 });
  assert.equal(seq2.progressApplied, true);
  const incoming = store.claimProgressSession("reuse");
  store.saveProgress("reuse", claimBody(incoming, 50000));
  const retired = store.claimProgressSession("reuse", { previousSessionId: owner.progressSessionId });
  assert.notEqual(retired.progressSessionId, owner.progressSessionId);
  assert.ok(retired.progressSessionStartedAt > incoming.progressSessionStartedAt);
  assert.equal(store.saveProgressOutcome("reuse", { ...claimBody(incoming, 51000), progressSequence: 2 }).progressApplied, true, "claiming from a retired owner only reserves its replacement");
  metrics.activeClaimReuse = { pauseResumeClaims: 500, retainedSessionsBeforeNewOwner: before };
  scenarios += 1;
}

async function verifyReservedOwnerAgainstProvisional() {
  const owner = store.claimProgressSession("provisional");
  const sameBorn = store.trackDetail("provisional").serverClockMs;
  assert.equal(sameBorn, owner.progressSessionStartedAt);
  const held = { ...cursor(sameBorn), ...report(sameBorn), played: true, positionMs: 10000 };
  store.saveProgress("provisional", claimBody(owner, 90000));
  const delayed = store.saveProgressOutcome("provisional", held);
  assert.equal(delayed.progressApplied, false, "an unknown equal-born provisional cursor cannot replace a reserved owner");
  assert.equal(delayed.playedApplied, true, "its distinct played receipt remains independent of cursor ownership");
  assert.equal(delayed.track.positionMs, 90000);
  assert.equal(delayed.track.playCount, 1);
  assert.equal(store.saveProgressOutcome("provisional", { ...held, progressSequence: 999 }).progressApplied, false);
  await store.stop();
  store = createMusicStore({ dbPath, roots: [] });
  stores.add(store);
  assert.equal(store.saveProgressOutcome("provisional", { ...cursor(sameBorn), positionMs: 0 }).progressApplied, false, "reserved provenance survives reopening");
  const custom = cursor(store.progressClock("custom-reuse").serverClockMs);
  store.saveProgress("custom-reuse", { ...custom, positionMs: 42000 });
  const confirmed = store.claimProgressSession("custom-reuse", { previousSessionId: custom.progressSessionId });
  assert.equal(confirmed.progressSessionId, custom.progressSessionId);
  assert.equal(confirmed.progressSessionStartedAt, custom.progressSessionStartedAt);
  assert.equal(store.saveProgressOutcome("custom-reuse", { ...cursor(custom.progressSessionStartedAt), positionMs: 0 }).progressApplied, false, "claim reuse protects an existing custom owner without changing its ID or sequence");
  assert.equal(database.prepare("SELECT COUNT(*) AS n FROM music_progress_sessions WHERE track_id='custom-reuse'").get().n, 2);
  assert.equal(store.saveProgressOutcome("custom-reuse", { ...custom, progressSequence: 2, positionMs: 43000 }).progressApplied, true);
  metrics.provisional = { reservedPositionMs: delayed.track.positionMs, stalePlayedApplied: delayed.playedApplied, customClaimReuseProtected: true };
  scenarios += 1;
}

async function verifyLegacyLedgerMigration() {
  const migrationPath = path.join(directory, "legacy-ledger.sqlite");
  const migratedDatabase = new DatabaseSync(migrationPath);
  try {
    ensureSchema(migratedDatabase);
    migratedDatabase.prepare(`INSERT INTO music_tracks
      (id,artist_id,album_id,title,source_root,source_path,relative_path,file_name,ext,duration_ms,status,updated_at)
      VALUES ('migration','artist','album','Synthetic',?,?,?,?,?,180000,'ok','2026')`)
      .run(directory, path.join(directory, "migration.audio"), "migration.audio", "migration.audio", ".audio");
    migratedDatabase.exec(`CREATE TABLE music_progress_sessions (
      track_id TEXT NOT NULL, session_id TEXT NOT NULL, started_at INTEGER NOT NULL,
      max_sequence INTEGER NOT NULL, expires_at INTEGER NOT NULL, retired INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY(track_id,session_id));
      CREATE TABLE music_progress_heads (track_id TEXT PRIMARY KEY,session_id TEXT NOT NULL,started_at INTEGER NOT NULL,expires_at INTEGER NOT NULL);
      CREATE TABLE music_played_receipts (report_id TEXT PRIMARY KEY,track_id TEXT NOT NULL,started_at INTEGER NOT NULL,expires_at INTEGER NOT NULL);`);
    const owner = cursor(clock);
    const played = report(clock);
    migratedDatabase.prepare("INSERT INTO music_progress_sessions VALUES (?,?,?,?,?,0)").run("migration", owner.progressSessionId, clock, 7, clock + ttl);
    migratedDatabase.prepare("INSERT INTO music_progress_heads VALUES (?,?,?,?)").run("migration", owner.progressSessionId, clock, clock + ttl);
    migratedDatabase.prepare("INSERT INTO music_played_receipts VALUES (?,?,?,?)").run(played.playedReportId, "migration", clock, clock + ttl);
    migratedDatabase.prepare("INSERT INTO music_track_state(track_id,position_ms,updated_at) VALUES ('migration',42000,'2026')").run();
    const migratedStore = createMusicStore({ dbPath: migrationPath, roots: [] });
    stores.add(migratedStore);
    const claimed = migratedStore.claimProgressSession("migration", { previousSessionId: owner.progressSessionId });
    assert.equal(claimed.progressSessionId, owner.progressSessionId);
    const row = migratedDatabase.prepare("SELECT * FROM music_progress_sessions").get();
    assert.equal(row.reserved, 1);
    assert.equal(row.max_sequence, 7, "additive migration and reuse preserve the high-water mark");
    const replay = migratedStore.saveProgressOutcome("migration", { ...owner, ...played, played: true, progressSequence: 7, positionMs: 0 });
    assert.equal(replay.progressApplied, false);
    assert.equal(replay.playedApplied, false);
    assert.equal(replay.track.positionMs, 42000);
    assert.equal(migratedStore.saveProgressOutcome("migration", { ...cursor(clock), positionMs: 0 }).progressApplied, false);
    assert.equal(migratedStore.saveProgressOutcome("migration", { ...owner, progressSequence: 8, positionMs: 43000 }).progressApplied, true);
    metrics.legacyLedgerMigration = { highWaterPreserved: 7, receiptPreserved: true, reusedOwnerProtected: true };
    scenarios += 1;
  } finally { migratedDatabase.close(); }
}

async function verifyExpiredClaimReplacement() {
  const owner = store.claimProgressSession("reserve-expiry");
  store.saveProgress("reserve-expiry", claimBody(owner, 42000));
  clock = owner.progressSessionStartedAt + ttl;
  const replacement = store.claimProgressSession("reserve-expiry", { previousSessionId: owner.progressSessionId });
  assert.notEqual(replacement.progressSessionId, owner.progressSessionId);
  assert.ok(replacement.progressSessionStartedAt > owner.progressSessionStartedAt);
  assert.equal(state("reserve-expiry").position_ms, 42000);
  assert.throws(() => store.saveProgress("reserve-expiry", { ...claimBody(owner, 10000), progressSequence: 99 }), error => error.code === "MUSIC_PROGRESS_SESSION_EXPIRED");
  assert.equal(store.saveProgressOutcome("reserve-expiry", claimBody(replacement, 90000)).progressApplied, true);
  assert.equal(database.prepare("SELECT COUNT(*) AS n FROM music_progress_sessions WHERE track_id='reserve-expiry'").get().n, 1);
  scenarios += 1;
}

function claimBody(claim, positionMs) {
  return { progressSessionId: claim.progressSessionId, progressSessionStartedAt: claim.progressSessionStartedAt, progressSequence: 1, positionMs };
}

function uuid() {
  serial += 1;
  return `00000000-0000-4000-8000-${serial.toString(16).padStart(12, "0")}`;
}

function cursor(startedAt = clock) {
  return { progressSessionId: uuid(), progressSessionStartedAt: startedAt, progressSequence: 1 };
}

function report(startedAt = clock) {
  return { playedReportId: uuid(), playedReportStartedAt: startedAt };
}

function state(trackId) {
  return database.prepare("SELECT * FROM music_track_state WHERE track_id=?").get(trackId) || null;
}

function resetLedgers() {
  database.exec("DELETE FROM music_progress_heads; DELETE FROM music_progress_sessions; DELETE FROM music_played_receipts");
}

function assertCapacity(response) {
  assert.equal(response.status, 503);
  assert.equal(response.data.code, "MUSIC_PROGRESS_CAPACITY");
  assert.equal(response.data.retryable, true);
}

async function request(method, suffix, body) {
  let response;
  const handled = await routeMusicApi({ method, body }, {}, new URL(`http://fixture.invalid/api/music/tracks/${suffix}`), {
    musicStore: store,
    readJsonBody: async req => req.body,
    notFound() { response = { status: 404 }; },
    sendJson(_res, status, data) { response = { status, data }; },
    requireLocalAdmin() { return true; }
  });
  assert.equal(handled, true);
  return response;
}
