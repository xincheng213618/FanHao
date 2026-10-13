import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createMusicStore } from "../src/modules/music/server/store.js";
import { MUSIC_FACET_CACHE } from "../src/modules/music/server/constants.js";
import { ensureSchema } from "../src/modules/music/server/schema.js";
import { writeScanRecords } from "../src/modules/music/server/scan.js";

const legacyTopPlayedJoins = process.argv.includes("--legacy-top-played-joins");
assert(process.argv.slice(2).every(argument => argument === "--legacy-top-played-joins"), "known arguments");

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
  await verifyTopPlayedJoinWork();
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

async function verifyTopPlayedJoinWork() {
  const sourceUrl = new URL("../src/modules/music/server/store.js", import.meta.url);
  const source = fs.readFileSync(sourceUrl, "utf8");
  const blockStart = source.indexOf("    const topPlayed = prepareTrackList(database,");
  const blockEnd = source.indexOf("    summaryCache = {", blockStart);
  assert.ok(blockStart >= 0 && blockEnd > blockStart, "locate only the topPlayed query");
  const block = source.slice(blockStart, blockEnd);
  const quote = String.fromCharCode(96);
  const queryStart = block.indexOf(quote), queryEnd = block.lastIndexOf(quote);
  assert.ok(queryStart >= 0 && queryEnd > queryStart, "topPlayed has one SQL template");
  const previousSql = [
    "SELECT ${TRACK_LIST_COLUMNS}, a.name AS artist_name, al.title AS album_name, al.cover_path,",
    "       s.favorite, s.rating, s.position_ms, s.duration_ms AS state_duration_ms,",
    "       s.play_count, s.last_played_at",
    "FROM music_track_state s",
    "CROSS JOIN music_tracks t ON t.id = s.track_id",
    "LEFT JOIN music_artists a ON a.id = t.artist_id",
    "LEFT JOIN music_albums al ON al.id = t.album_id",
    "WHERE COALESCE(s.play_count, 0) > 0",
    "ORDER BY COALESCE(s.play_count, 0) DESC, COALESCE(s.last_played_at, '') DESC, t.title COLLATE NOCASE ASC",
    "LIMIT 8"
  ].join("\n");
  const previousBlock = block.slice(0, queryStart + 1) + previousSql + block.slice(queryEnd);
  const previousSource = (source.slice(0, blockStart) + previousBlock + source.slice(blockEnd))
    .replace(/from "(\.\/[^"]+)"/gu, (_, relative) => "from " + JSON.stringify(new URL(relative, sourceUrl).href));
  const previousFactory = (await import("data:text/javascript;base64," + Buffer.from(previousSource).toString("base64"))).createMusicStore;
  const testedFactory = legacyTopPlayedJoins ? previousFactory : createMusicStore;
  const schema = fs.readFileSync(new URL("../src/modules/music/server/schema.js", import.meta.url), "utf8");
  const oldTables = ["music_artists", "music_tracks", "music_track_state"].map(name => {
    const table = schema.match(new RegExp("CREATE TABLE IF NOT EXISTS " + name + " \\([\\s\\S]+?\\n    \\);"))?.[0];
    assert.ok(table, "legacy fixture uses the actual table declaration: " + name);
    return table.replace(/^\s+(?:genre TEXT,|language TEXT NOT NULL DEFAULT '其他',|rating INTEGER DEFAULT 0,)\r?\n/gmu, "");
  }).join("\n");
  const savedPrepare = DatabaseSync.prototype.prepare;
  const savedExec = DatabaseSync.prototype.exec;
  const savedNow = Date.now;
  const privateStores = [];
  const privateDatabases = new Set();
  let opening = null;
  let measure = null;
  let topReadError = null;
  let privateClock = 1800000000000;
  let oracleCount = 0;
  Date.now = () => privateClock;
  DatabaseSync.prototype.exec = function (sql, ...args) {
    if (opening && !opening.database) {
      opening.database = this;
      privateDatabases.add(this);
      if (opening.legacy) {
        savedExec.call(this, oldTables);
        // A pre-existing track table may have additional columns with names
        // also projected from state. The original SELECT's last column wins.
        for (const [name, definition] of [
          ["favorite", "INTEGER DEFAULT 1"], ["rating", "INTEGER DEFAULT 99"],
          ["position_ms", "INTEGER DEFAULT 987654321"], ["play_count", "INTEGER DEFAULT 99999999"],
          ["last_played_at", "TEXT DEFAULT '2099'"], ["state_duration_ms", "INTEGER DEFAULT 99999"],
          ["cover_updated_at", "TEXT DEFAULT 'legacy-stamp'"]
        ]) savedExec.call(this, "ALTER TABLE music_tracks ADD COLUMN " + name + " " + definition);
      }
    }
    return savedExec.call(this, sql, ...args);
  };
  DatabaseSync.prototype.prepare = function (sql, ...args) {
    const isTop = privateDatabases.has(this) && sql.includes("ORDER BY COALESCE(s.play_count, 0) DESC");
    if (isTop && topReadError) throw topReadError;
    if (isTop && measure?.database === this) {
      // Probe the actual lookup keys, retaining the original PK tables and
      // join plan. SELECT name probes would only count the eight output rows.
      const probed = sql
        .replace("a.id = t.artist_id", "a.id = fixture_top_artist_key(t.artist_id)")
        .replace("al.id = t.album_id", "al.id = fixture_top_album_key(t.album_id)");
      assert.notEqual(probed, sql, "instrument the actual topPlayed joins");
      const plan = query => savedPrepare.call(this, "EXPLAIN QUERY PLAN " + query).all().map(row => row.detail);
      const rawPlan = plan(sql), probePlan = plan(probed);
      assert.deepEqual(probePlan, rawPlan, "lookup probes preserve the actual SQLite plan");
      assert.ok(rawPlan.some(detail => /SCAN s\b/u.test(detail)), "the original state driver remains");
      assert.ok(rawPlan.some(detail => /SEARCH t USING INDEX sqlite_autoindex_music_tracks_1/u.test(detail)), "tracks retain PK lookups");
      assert.ok(rawPlan.some(detail => /SEARCH a USING INDEX sqlite_autoindex_music_artists_1/u.test(detail)), "artists retain PK lookups");
      assert.ok(rawPlan.some(detail => /SEARCH al USING INDEX sqlite_autoindex_music_albums_1/u.test(detail)), "albums retain PK lookups");
      measure.plan = rawPlan;
      const statement = savedPrepare.call(this, probed, ...args), owner = this;
      return new Proxy(statement, { get(target, key) {
        const value = Reflect.get(target, key, target);
        if (typeof value !== "function") return value;
        return (...parameters) => {
          if (key === "all" && measure?.database === owner) measure.topReads++;
          return value.apply(target, parameters);
        };
      } });
    }
    return savedPrepare.call(this, sql, ...args);
  };
  try {
    const modern = [open(previousFactory), open(testedFactory)];
    const initial = compare(modern, "dense modern catalogue");
    assert.deepEqual(initial.topPlayed.map(track => track.id), Array.from({ length: 8 }, (_, index) => "t" + index), "complete ties retain the original first eight state rows");
    assert.equal(initial.topPlayed[0].artist, "", "missing artist keeps the empty fallback");
    assert.equal(initial.topPlayed[0].album, "", "missing album keeps the empty fallback");
    assert.equal(initial.topPlayed[0].durationMs, 3456, "zero track duration falls back to state");
    assert.equal(initial.topPlayed[1].artist, "Artist 1");
    assert.equal(initial.topPlayed[1].album, "Album 1");
    assert.equal(initial.topPlayed[1].durationMs, 1234, "nonzero track duration wins over state");
    assert.equal(initial.topPlayed[2].artist, "Track artist 2");
    assert.equal(initial.topPlayed[2].album, "Track album 2");
    assert.equal(initial.topPlayed[0].id, "t0", "the existing topPlayed includes an inactive track");
    const previousWork = measured(modern[0]), currentWork = measured(modern[1]);
    assert.ok(previousWork.artistLookups >= 9000 && previousWork.albumLookups >= 9000, "the old query visits dense catalogue associations");
    assert.equal(previousWork.topReads, 1);
    assert.equal(currentWork.topReads, 1);
    if (!legacyTopPlayedJoins) assert.ok(currentWork.plan.includes("CO-ROUTINE ranked"), "the limited inner selection is materialized before association lookups");
    change(modern, "DELETE FROM music_track_state WHERE track_id IN (" + Array.from({ length: 30 }, (_, index) => "'t" + index + "'").join(",") + ")");
    for (const item of modern) {
      const insert = item.database.prepare("INSERT INTO music_track_state (track_id, favorite, rating, position_ms, duration_ms, play_count, last_played_at, updated_at) VALUES (?,0,0,0,3456,100000,'2026-01-01','2026-01-01')");
      for (let index = 29; index >= 0; index -= 1) insert.run("t" + index);
    }
    const reverse = compare(modern, "reverse insertion with complete ties");
    assert.deepEqual(reverse.topPlayed.map(track => track.id), Array.from({ length: 8 }, (_, index) => "t" + (29 - index)), "fully tied first eight keep state scan order");
    for (const sql of [
      "UPDATE music_track_state SET play_count=5,last_played_at='2026-02-02'",
      "UPDATE music_tracks SET title=CASE CAST(substr(id,2) AS INTEGER)%2 WHEN 0 THEN 'é' ELSE 'E' END",
      "UPDATE music_track_state SET play_count=NULL",
      "UPDATE music_track_state SET play_count=-1",
      "UPDATE music_track_state SET play_count=3,last_played_at=NULL",
      "UPDATE music_tracks SET duration_ms=0,display_artist='',album_title='' WHERE id='t0'; UPDATE music_track_state SET duration_ms=9876 WHERE track_id='t0'",
      "DELETE FROM music_albums WHERE id='al0'; DELETE FROM music_artists WHERE id='a0'",
      "UPDATE music_tracks SET status='missing' WHERE id IN ('t0','t1','t2')",
      "DELETE FROM music_tracks WHERE id='t0'",
      "DELETE FROM music_track_state WHERE track_id LIKE 't%'"
    ]) { change(modern, sql); compare(modern, sql); }
    const sentinel = Object.assign(new Error("private topPlayed read failure"), { code: "FIXTURE_TOP_READ" });
    topReadError = sentinel;
    for (const item of modern) {
      privateClock += 6000;
      assert.throws(() => item.store.summary(), error => error === sentinel, "the exact original SQLite read error propagates");
    }
    topReadError = null;
    compare(modern, "retry after topPlayed error");

    const legacy = [open(previousFactory, true), open(testedFactory, true)];
    const migrated = compare(legacy, "additive legacy migration and duplicate column names");
    assert.equal(migrated.topPlayed[0].favorite, false, "state overrides the extra legacy track favorite");
    assert.equal(migrated.topPlayed[0].rating, 0);
    assert.equal(migrated.topPlayed[0].positionMs, 0);
    assert.equal(migrated.topPlayed[0].playCount, 100000);
    assert.equal(migrated.topPlayed[0].lastPlayedAt, "2026-01-01");
    assert.equal(migrated.topPlayed[0].durationMs, 3456);
    assert.equal(migrated.topPlayed[1].coverUrl, "/media/music-cover/al1?v=legacy-stamp", "additional nonconflicting track fields still reach publicTrack");
    for (const sql of [
      "UPDATE music_track_state SET play_count=9",
      "UPDATE music_track_state SET play_count=NULL",
      "UPDATE music_track_state SET play_count=100",
      "UPDATE music_track_state SET play_count=3,last_played_at=NULL",
      "ANALYZE; PRAGMA reverse_unordered_selects=ON; UPDATE music_track_state SET play_count=100",
      "UPDATE music_track_state SET favorite=NULL,rating=NULL,position_ms=NULL,duration_ms=NULL,last_played_at=NULL,play_count=3"
    ]) { change(legacy, sql); compare(legacy, sql); }
    // Keep the full response and compatibility oracles ahead of the negative
    // control's budget failure; restoring old SQL must fail for excess work.
    assert.ok(currentWork.artistLookups <= 8, "topPlayed artist lookup budget: at most eight; observed " + currentWork.artistLookups);
    assert.ok(currentWork.albumLookups <= 8, "topPlayed album lookup budget: at most eight; observed " + currentWork.albumLookups);
    assert.equal(currentWork.artistLookups, initial.topPlayed.length);
    assert.equal(currentWork.albumLookups, initial.topPlayed.length);
    metrics.topPlayedJoins = {
      tracks: 10000, fullSummaryOracles: oracleCount,
      previousArtistLookups: previousWork.artistLookups, previousAlbumLookups: previousWork.albumLookups,
      artistLookups: currentWork.artistLookups, albumLookups: currentWork.albumLookups,
      rawAndProbedPlansEqual: true, originalReadErrorPreserved: true, additiveLegacyColumns: true
    };
    scenarios += 1;
  } finally {
    DatabaseSync.prototype.prepare = savedPrepare;
    DatabaseSync.prototype.exec = savedExec;
    Date.now = savedNow;
    for (const item of privateStores) await item.stop();
  }

  function open(factory, legacy = false) {
    const item = { legacy, database: null, store: factory({
      dbPath: ":memory:", roots: [],
      scanWorker: { start() { assert.fail("no private scan worker"); }, scan() { assert.fail("no private scan"); }, async stop() {} }
    }) };
    privateStores.push(item.store);
    opening = item;
    try { item.store.summary(); } finally { opening = null; }
    assert.ok(item.database, "actual store owns a private in-memory SQLite connection");
    item.database.function("fixture_top_artist_key", key => {
      if (measure?.database === item.database) measure.artistLookups += 1;
      return key;
    });
    item.database.function("fixture_top_album_key", key => {
      if (measure?.database === item.database) measure.albumLookups += 1;
      return key;
    });
    seed(item.database);
    return item;
  }

  function seed(db) {
    db.exec("BEGIN");
    try {
      const artist = db.prepare("INSERT INTO music_artists (id,name,language,source_root,source_path,relative_path,album_count,track_count,duration_ms,size_bytes,status,updated_at) VALUES (?,?,?,?,?,?,1,100,100000,100,?,'2026-01-01')");
      const album = db.prepare("INSERT INTO music_albums (id,artist_id,title,cover_path,source_root,source_path,relative_path,track_count,duration_ms,size_bytes,updated_at) VALUES (?,?,?,?,?,?,?,100,100000,100,'2026-01-01')");
      for (let index = 0; index < 100; index += 1) {
        const id = "a" + index, albumId = "al" + index;
        artist.run(id, "Artist " + index, ["中文", "英文", "日文", "其他"][index % 4], "synthetic", "artist/" + id, id, index % 17 ? "ok" : "missing");
        album.run(albumId, id, "Album " + index, "synthetic-cover", "synthetic", "album/" + albumId, albumId);
      }
      const track = db.prepare("INSERT INTO music_tracks (id,artist_id,album_id,title,display_artist,album_title,track_no,disc_no,genre,language,source_root,source_path,relative_path,file_name,ext,size_bytes,mtime_ms,duration_ms,codec,sample_rate,bit_depth,channels,has_lrc,status,updated_at) VALUES (?,?,?,?,?,?,?,1,?,?,?,?,?,?,'.audio',1,1,?,'synthetic',44100,16,2,?,?,'2026-01-01')");
      const state = db.prepare("INSERT INTO music_track_state (track_id,favorite,rating,position_ms,duration_ms,play_count,last_played_at,updated_at) VALUES (?,?,?,?,3456,?,?,'2026-01-01')");
      for (let index = 0; index < 10000; index += 1) {
        const id = "t" + index;
        track.run(id, index % 97 ? "a" + index % 100 : "absent-artist", index % 83 ? "al" + index % 100 : "absent-album",
          index < 30 ? "Tied title" : "Title " + String(index).padStart(5, "0"),
          index < 2 ? "" : "Track artist " + index, index < 2 ? "" : "Track album " + index, index % 12 + 1,
          index % 2 ? "Synthetic" : "", ["中文", "英文", "日文", "其他"][index % 4],
          "synthetic", "track/" + id, id + ".audio", id + ".audio", index === 0 ? 0 : 1234, index % 2, index % 43 ? "ok" : "missing");
        state.run(id, index % 2, index % 6, index * 10, index < 30 ? 100000 : index % 53 === 0 ? 0 : index % 47 === 0 ? null : 1 + index % 100, index < 30 ? "2026-01-01" : index % 41 ? "2025-01-01" : null);
      }
      state.run("orphan-state", 1, 5, 0, 999999, "2099-01-01");
      state.run(null, 1, 5, 0, 999999, "2099-01-01");
      db.exec("COMMIT");
    } catch (error) { db.exec("ROLLBACK"); throw error; }
    MUSIC_FACET_CACHE.delete(db);
  }

  function read(item) {
    privateClock += 6000;
    return item.store.summary();
  }

  function compare(items, label) {
    const previous = read(items[0]), current = read(items[1]);
    assert.equal(JSON.stringify(current), JSON.stringify(previous), "complete summary JSON: " + label);
    oracleCount += 1;
    return current;
  }

  function change(items, sql) {
    for (const item of items) {
      item.database.exec(sql);
      MUSIC_FACET_CACHE.delete(item.database);
    }
  }

  function measured(item) {
    const raw = read(item);
    measure = { database: item.database, artistLookups: 0, albumLookups: 0, topReads: 0, plan: [] };
    try {
      const probed = read(item);
      assert.equal(JSON.stringify(probed), JSON.stringify(raw), "the lookup probes retain the entire actual summary response");
      return { ...measure, database: undefined };
    } finally { measure = null; }
  }
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
