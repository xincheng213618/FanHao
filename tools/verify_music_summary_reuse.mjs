import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createMusicStore } from "../src/modules/music/server/store.js";
import { MUSIC_FACET_CACHE } from "../src/modules/music/server/constants.js";
import { ensureSchema } from "../src/modules/music/server/schema.js";
import { writeScanRecords } from "../src/modules/music/server/scan.js";

// Actual store, scan publisher and SQLite; synthetic metadata only. No worker,
// service, media file, browser profile, user database or external request.
const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fanhao-music-summary-reuse-"));
const dbPath = path.join(directory, "catalog.sqlite");
const database = new DatabaseSync(dbPath);
ensureSchema(database);
const records = syntheticCatalog();
writeScanRecords(database, records, [directory], "2026-01-01");
const realNow = Date.now;
let clock = realNow();
Date.now = () => clock;
const store = createMusicStore({ dbPath, roots: [] });
const originalPrepare = DatabaseSync.prototype.prepare;
let measuring = false;
let executions = 0;
let connection = null;
let serial = 0;
let scenarios = 0;
const metrics = {};
DatabaseSync.prototype.prepare = function (sql, ...args) {
  const statement = originalPrepare.call(this, sql, ...args);
  if (!measuring) return statement;
  connection = this;
  return new Proxy(statement, {
    get(target, key) {
      const value = Reflect.get(target, key, target);
      if (typeof value !== "function") return value;
      if (key !== "get" && key !== "all") return value.bind(target);
      return (...parameters) => {
        executions += 1;
        return value.apply(target, parameters);
      };
    }
  });
};

try {
  store.saveProgress("track-0", { position_ms: 42000, played: true });
  const cold = readSummary();
  assert.ok(cold.sql > 0, "the counter observes actual SQLite executions on a cold read");
  const facets = store.facets();
  const facetCache = MUSIC_FACET_CACHE.get(connection);
  assertCacheHit(cold.value);
  verifyClaimsAndNoopWrites();
  await verifyNoopTimestampAndOrdering();
  verifyChangedState();
  verifyFailedTransactions();
  verifyExpiryFloor();
  verifyTimeToLive();
  verifyScanInvalidation();
  assert.notStrictEqual(MUSIC_FACET_CACHE.get(connection), facetCache, "publication opens a new cache owner");
  assert.ok(facets.artists.length > 0);
  console.log(JSON.stringify({ ok: true, scenarios, ...metrics }, null, 2));
} finally {
  DatabaseSync.prototype.prepare = originalPrepare;
  Date.now = realNow;
  await store.stop();
  database.close();
  // Flat owned directory: delete individual SQLite files only.
  for (const name of fs.readdirSync(directory)) fs.unlinkSync(path.join(directory, name));
  fs.rmdirSync(directory);
}

function verifyClaimsAndNoopWrites() {
  const beforeClaim = store.summary();
  const owner = store.claimProgressSession("track-0");
  assertCacheHit(beforeClaim);
  const body = { ...cursor(owner, 2), positionMs: 90000, played: true, playedReportId: uuid(), playedReportStartedAt: owner.serverClockMs };
  store.saveProgressOutcome("track-0", body);
  const baseline = readSummary().value;
  const json = JSON.stringify(baseline);
  const beforeFacets = store.facets();
  const cache = MUSIC_FACET_CACHE.get(connection);
  for (let index = 0; index < 500; index += 1) {
    clock += 1;
    const reused = store.claimProgressSession("track-0", { previousSessionId: owner.progressSessionId });
    assert.equal(reused.progressSessionId, owner.progressSessionId);
    assertCacheHit(baseline);
    const duplicate = store.saveProgressOutcome("track-0", body);
    assert.equal(duplicate.progressApplied, false);
    assert.equal(duplicate.playedApplied, false);
    assertCacheHit(baseline);
    const stale = store.saveProgressOutcome("track-0", { ...cursor(owner, 1), positionMs: 10000 });
    assert.equal(stale.progressApplied, false);
    assertCacheHit(baseline);
  }
  for (let index = 0; index < 20; index += 1) {
    store.claimProgressSession("track-0");
    assertCacheHit(baseline);
  }
  assert.equal(store.claimProgressSession("missing"), null);
  assertCacheHit(baseline);
  assert.equal(store.saveProgressOutcome("missing", { positionMs: 0 }), null);
  assertCacheHit(baseline);
  assert.throws(() => store.claimProgressSession("track-0", { previousSessionId: "invalid" }), error => error.statusCode === 400);
  assertCacheHit(baseline);
  const afterFacets = store.facets();
  assert.strictEqual(afterFacets.artists, beforeFacets.artists);
  assert.strictEqual(afterFacets.albums, beforeFacets.albums);
  assert.strictEqual(afterFacets.genres, beforeFacets.genres);
  assert.strictEqual(MUSIC_FACET_CACHE.get(connection), cache);
  assert.equal(JSON.stringify(store.summary()), json, "receipts and clock floors do not change the public summary");
  metrics.noop = { claimReuse: 500, duplicatePlayedAndCursor: 500, staleCursor: 500, reservations: 20, summarySql: 0, facetCacheRetained: true };
  scenarios += 1;
}

function verifyChangedState() {
  let before = store.summary();
  store.saveProgress("track-0", { position_ms: 5000 });
  let fresh = assertFreshSummary(before);
  assert.equal(fresh.recent[0].positionMs, 5000, "legacy backward seek remains immediately visible");
  const owner = store.claimProgressSession("track-0");
  before = fresh;
  store.saveProgressOutcome("track-0", { ...cursor(owner, 1), positionMs: 7000 });
  fresh = assertFreshSummary(before);
  assert.equal(fresh.topPlayed[0].positionMs, 7000);
  before = fresh;
  store.toggleFavorite("track-0", { favorite: true });
  fresh = assertFreshSummary(before);
  assert.equal(fresh.recent[0].favorite, true);
  before = fresh;
  store.setRating("track-0", { rating: 4 });
  fresh = assertFreshSummary(before);
  assert.equal(fresh.topPlayed[0].rating, 4);
  before = fresh;
  const staleWithNewPlay = store.saveProgressOutcome("track-0", {
    ...cursor(owner, 1), positionMs: 0, played: true, playedReportId: uuid(), playedReportStartedAt: owner.serverClockMs
  });
  assert.equal(staleWithNewPlay.progressApplied, false);
  assert.equal(staleWithNewPlay.playedApplied, true);
  fresh = assertFreshSummary(before);
  assert.equal(fresh.topPlayed[0].positionMs, 7000);
  assert.equal(fresh.totals.plays, before.totals.plays + 1);
  before = fresh;
  store.clearHistory();
  fresh = assertFreshSummary(before);
  assert.equal(fresh.totals.plays, 0);
  assert.equal(fresh.totals.listenedTracks, 0);
  assert.deepEqual(fresh.recent, []);
  assert.deepEqual(fresh.topPlayed, []);
  metrics.changedState = { legacySeek: true, fencedSeek: true, favorite: true, rating: true, independentPlayed: true, clearHistory: true };
  scenarios += 1;
}

async function verifyNoopTimestampAndOrdering() {
  store.toggleFavorite("track-0", { favorite: true });
  store.setRating("track-0", { rating: 4 });
  const owner = store.claimProgressSession("track-0");
  const body = { ...cursor(owner, 2), positionMs: 90000, played: true, playedReportId: uuid(), playedReportStartedAt: owner.serverClockMs };
  store.saveProgressOutcome("track-0", body);
  await new Promise(resolve => setTimeout(resolve, 8));
  store.toggleFavorite("track-1", { favorite: true });
  store.setRating("track-1", { rating: 4 });
  const row = () => database.prepare("SELECT updated_at,last_played_at,play_count,position_ms FROM music_track_state WHERE track_id='track-0'").get();
  const order = id => store.smartPlaylistDetail(id).tracks.map(track => track.id);
  const before = row();
  const laterTimestamp = database.prepare("SELECT updated_at FROM music_track_state WHERE track_id='track-1'").get().updated_at;
  assert.ok(laterTimestamp > before.updated_at, "the second favorite has a genuinely later wall-clock timestamp");
  const favorites = order("favorites"), topRated = order("toprated");
  assert.deepEqual(favorites, ["track-1", "track-0"]);
  assert.deepEqual(topRated, favorites);
  const baseline = store.summary();
  await new Promise(resolve => setTimeout(resolve, 8));
  assert.ok(new Date().toISOString() > laterTimestamp);
  const duplicate = store.saveProgressOutcome("track-0", body);
  assert.equal(duplicate.progressApplied, false);
  assert.equal(duplicate.playedApplied, false);
  const stale = store.saveProgressOutcome("track-0", { ...cursor(owner, 1), positionMs: 0 });
  assert.equal(stale.progressApplied, false);
  assert.deepEqual(row(), before, "a late duplicate or stale cursor does not touch state.updated_at");
  assert.deepEqual(order("favorites"), favorites);
  assert.deepEqual(order("toprated"), topRated);
  assertCacheHit(baseline);
  const distinctPlayed = store.saveProgressOutcome("track-0", {
    ...cursor(owner, 1), positionMs: 0, played: true, playedReportId: uuid(), playedReportStartedAt: owner.serverClockMs
  });
  assert.equal(distinctPlayed.progressApplied, false);
  assert.equal(distinctPlayed.playedApplied, true);
  const updated = row();
  assert.ok(updated.updated_at > laterTimestamp, "an accepted independent played event legitimately updates state time");
  assert.equal(updated.last_played_at, updated.updated_at);
  assert.equal(updated.play_count, before.play_count + 1);
  assert.equal(updated.position_ms, before.position_ms);
  assert.deepEqual(order("favorites"), ["track-0", "track-1"]);
  assert.deepEqual(order("toprated"), ["track-0", "track-1"]);
  const fresh = store.summary();
  assert.notStrictEqual(fresh, baseline);
  assert.equal(fresh.totals.plays, baseline.totals.plays + 1);
  // Leave the following state-change checks with values they can really change.
  store.toggleFavorite("track-0", { favorite: false });
  store.setRating("track-0", { rating: 0 });
  metrics.stateOrdering = { realWallClockAdvanced: true, noopPreservesUpdatedAt: true, favoritesAndRatingsOrderRetained: true, independentPlayedUpdatesTimeAndOrder: true };
  scenarios += 1;
}

function verifyFailedTransactions() {
  const baseline = store.summary();
  database.exec("BEGIN IMMEDIATE");
  try {
    assert.throws(() => store.toggleFavorite("track-0"), error => error.statusCode === 503 && error.code === "MUSIC_WRITE_BUSY");
    assertCacheHit(baseline);
    assert.throws(() => store.claimProgressSession("track-0"), error => error.statusCode === 503 && error.code === "MUSIC_WRITE_BUSY");
    assertCacheHit(baseline);
  } finally { database.exec("ROLLBACK"); }
  database.exec("CREATE TRIGGER reject_summary_fixture BEFORE INSERT ON music_track_state BEGIN SELECT RAISE(ABORT,'synthetic rollback'); END");
  try {
    assert.throws(() => store.saveProgress("track-0", { positionMs: 99999, played: true }), /synthetic rollback/);
    assertCacheHit(baseline);
    assert.throws(() => store.setRating("track-0", { rating: 1 }), /synthetic rollback/);
    assertCacheHit(baseline);
  } finally { database.exec("DROP TRIGGER reject_summary_fixture"); }
  assert.equal(database.prepare("SELECT position_ms FROM music_track_state WHERE track_id='track-0'").get().position_ms, 7000);
  metrics.failedTransactions = { busyPreservesCache: true, rollbackPreservesCache: true };
  scenarios += 1;
}

function verifyExpiryFloor() {
  clock += 24 * 60 * 60 * 1000 + 10000;
  const baseline = readSummary().value;
  const expiredBorn = clock - 24 * 60 * 60 * 1000;
  const beforeFloor = store.progressClock("track-0").serverClockMs;
  clock += 1;
  assert.throws(() => store.saveProgressOutcome("track-0", {
    progressSessionId: uuid(), progressSessionStartedAt: expiredBorn, progressSequence: 1, positionMs: 0
  }), error => error.code === "MUSIC_PROGRESS_SESSION_EXPIRED");
  assertCacheHit(baseline);
  const afterFloor = store.progressClock("track-0").serverClockMs;
  assert.ok(afterFloor > beforeFloor);
  clock -= 1000;
  assert.equal(store.progressClock("track-0").serverClockMs, afterFloor, "expired floor is durable even though summary cache is retained");
  assertCacheHit(baseline);
  assert.throws(() => store.saveProgressOutcome("track-0", {
    played: true, playedReportId: uuid(), playedReportStartedAt: expiredBorn, positionMs: 0
  }), error => error.code === "MUSIC_PLAYED_REPORT_EXPIRED");
  assertCacheHit(baseline);
  metrics.expiry = { floorCommitted: true, summarySql: 0, rollbackCannotReviveToken: true };
  scenarios += 1;
}

function verifyTimeToLive() {
  clock += 20000;
  const first = readSummary().value;
  clock += 4999;
  store.claimProgressSession("track-1");
  assertCacheHit(first);
  clock += 1;
  const second = assertFreshSummary(first);
  assert.deepEqual(second, first);
  clock -= 2000;
  assertCacheHit(second, "the existing five-second cache contract tolerates a backward wall clock");
  clock += 6999;
  assertCacheHit(second);
  clock += 1;
  assertFreshSummary(second);
  metrics.ttl = { before5000MsReused: true, at5000MsRefreshed: true, originalRollbackBehaviorPreserved: true };
  scenarios += 1;
}

function verifyScanInvalidation() {
  const before = store.summary();
  const beforeArtists = store.facets().artists;
  const replacement = structuredClone(records);
  replacement.artists[0].name = "Published replacement";
  replacement.tracks[0].displayArtist = "Published replacement";
  replacement.tracks[0].title = "Published track";
  writeScanRecords(database, replacement, [directory], "2026-02-02");
  // The actual scan service's onPublished callback calls this public method.
  store.invalidate();
  const fresh = assertFreshSummary(before);
  assert.equal(fresh.scannedAt, "2026-02-02");
  const published = store.facets().artists;
  assert.notStrictEqual(published, beforeArtists);
  assert.ok(published.some(artist => artist.name === "Published replacement"));
  store.saveProgress("track-0", { positionMs: 3000, played: true });
  const played = assertFreshSummary(fresh);
  assert.equal(played.recent[0].title, "Published track");
  metrics.publication = { actualPublisher: true, newConnectionRebuildsSummaryAndFacets: true };
  scenarios += 1;
}

function readSummary() {
  executions = 0;
  measuring = true;
  try { return { value: store.summary(), sql: executions }; }
  finally { measuring = false; }
}

function assertCacheHit(previous, message = "a write with no public track effect must preserve the warm cache") {
  const result = readSummary();
  assert.equal(result.sql, 0, message);
  assert.strictEqual(result.value, previous, message);
}

function assertFreshSummary(previous) {
  const result = readSummary();
  assert.ok(result.sql > 0, "a changed state or expired cache must read SQLite");
  assert.notStrictEqual(result.value, previous);
  return result.value;
}

function cursor(owner, sequence) {
  return { progressSessionId: owner.progressSessionId, progressSessionStartedAt: owner.progressSessionStartedAt, progressSequence: sequence };
}

function uuid() {
  serial += 1;
  return `00000000-0000-4000-8000-${serial.toString(16).padStart(12, "0")}`;
}

function syntheticCatalog() {
  const result = { artists: [], albums: [], tracks: [], lyrics: [] };
  for (let index = 0; index < 4; index += 1) {
    const artistId = `artist-${index}`, albumId = `album-${index}`, name = `Artist ${index}`;
    const updatedAt = "2026-01-01";
    result.artists.push({ id: artistId, name, sortName: name, language: "英文", sourceRoot: directory, sourcePath: path.join(directory, artistId), relativePath: artistId, albumCount: 1, trackCount: 1, durationMs: 180000, sizeBytes: 1, updatedAt });
    result.albums.push({ id: albumId, artistId, title: `Album ${index}`, sortTitle: `Album ${index}`, year: "2026", coverPath: "", introPath: "", introText: "", sourceRoot: directory, sourcePath: path.join(directory, albumId), relativePath: albumId, trackCount: 1, durationMs: 180000, sizeBytes: 1, updatedAt });
    result.tracks.push({ id: `track-${index}`, artistId, albumId, title: `Track ${index}`, sortTitle: `Track ${index}`, displayArtist: name, albumTitle: `Album ${index}`, trackNo: 1, discNo: 1, genre: "Synthetic", language: "英文", sourceRoot: directory, sourcePath: path.join(directory, `track-${index}.audio`), relativePath: `track-${index}.audio`, fileName: `track-${index}.audio`, ext: ".audio", sizeBytes: 1, mtimeMs: 1, durationMs: 180000, codec: "synthetic", sampleRate: 44100, bitDepth: 16, channels: 2, lrcPath: "", hasLrc: 0, status: "ok", error: "", updatedAt });
  }
  return result;
}
