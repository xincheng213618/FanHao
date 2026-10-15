import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { performance } from "node:perf_hooks";
import { catalogFilter } from "../src/modules/music/server/query.js";
import { trackOrderSql } from "../src/modules/music/server/helpers.js";
import { playedTrackPageIds } from "../src/modules/music/server/played-track-page.js";
import { ensureSchema } from "../src/modules/music/server/schema.js";
import { publicTrack } from "../src/modules/music/server/serializers.js";
import { createMusicStore } from "../src/modules/music/server/store.js";

const trackColumns = `t.*, a.name AS artist_name, al.title AS album_name, al.cover_path,
  s.favorite, s.rating, s.position_ms, s.duration_ms AS state_duration_ms, s.play_count, s.last_played_at`;
const joins = `LEFT JOIN music_artists a ON a.id = t.artist_id
  LEFT JOIN music_albums al ON al.id = t.album_id LEFT JOIN music_track_state s ON s.track_id = t.id`;
const realArgument = process.argv.indexOf("--real-db");
if (realArgument >= 0) {
  assert(process.argv[realArgument + 1], "--real-db requires a database path");
  const db = new DatabaseSync(path.resolve(process.argv[realArgument + 1]), { readOnly: true });
  try {
    db.exec("PRAGMA query_only = ON; PRAGMA busy_timeout = 250; BEGIN");
    const params = new URLSearchParams("sort=played&limit=80");
    const filter = catalogFilter(params);
    const baseline = timed(() => legacyRows(db, filter, 80, 0));
    const optimized = timed(() => optimizedRows(db, filter, 80, 0));
    assert.deepEqual(optimized.result, baseline.result, "real snapshot must retain row values and ordered IDs");
    console.log(JSON.stringify({ ok: true, mode: "real-read-only-snapshot", baselineMs: baseline.ms, optimizedMs: optimized.ms, rows: optimized.result.length }));
  } finally {
    db.close();
  }
} else {
  await verifyFixture();
}

async function verifyFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fanhao-music-played-"));
  const dbPath = path.join(root, "catalog.sqlite");
  const db = new DatabaseSync(dbPath);
  let store = null;
  try {
    ensureSchema(db);
    db.exec("BEGIN");
    const insert = db.prepare(`INSERT INTO music_tracks
      (id, artist_id, album_id, title, album_title, display_artist, disc_no, track_no, genre, language,
       source_root, source_path, relative_path, file_name, ext, status, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, 'fixture', ?, ?, ?, '.mp3', ?, '2026-10-11')`);
    const state = db.prepare(`INSERT INTO music_track_state
      (track_id, favorite, rating, last_played_at, updated_at) VALUES (?, ?, ?, ?, '2026-10-11')`);
    for (let index = 0; index < 30000; index += 1) {
      const id = `track-${String(index).padStart(5, "0")}`;
      insert.run(id, `artist-${index % 3}`, `album-${Math.floor(index / 100)}`, id,
        `Album ${String(Math.floor(index / 100)).padStart(3, "0")}`, `Artist ${index % 3}`,
        index % 100, index % 2 ? "rock" : "pop", index % 2 ? "英文" : "中文",
        `${id}.mp3`, `${id}.mp3`, `${id}.mp3`, index === 50 ? "missing" : "ok");
      if (index < 120) {
        const timestamp = index < 100 ? `2026-10-${String(index % 10 + 1).padStart(2, "0")}` : index < 110 ? "" : null;
        state.run(id, index % 2, index % 6, timestamp);
      }
    }
    state.run("orphan-state", 1, 5, "2099-01-01");
    db.exec("COMMIT");
    store = createMusicStore({ dbPath, roots: [] });
    const cases = [
      "limit=80", "limit=20&offset=80", "limit=80&offset=90", "limit=5&offset=100",
      "limit=80&offset=110", "limit=80&offset=29995", "limit=80&offset=40000",
      "limit=10&favorite=1", "limit=10&minRating=4", "limit=10&language=中文",
      "limit=10&artist=artist-1", "limit=10&album=album-0", "limit=10&genre=rock"
    ];
    for (const value of cases) {
      const params = new URLSearchParams(`sort=played&${value}`);
      const filter = catalogFilter(params);
      const limit = Number(params.get("limit"));
      const offset = Number(params.get("offset") || 0);
      const expected = legacyRows(db, filter, limit, offset);
      assert.deepEqual(optimizedRows(db, filter, limit, offset), expected, `SQL equivalence: ${value}`);
      const result = store.listTracks({ searchParams: params });
      assert.deepEqual(result.tracks, expected.map(publicTrack), `store fields and ordering: ${value}`);
      const total = Number(db.prepare(`SELECT COUNT(*) AS count FROM music_tracks t LEFT JOIN music_track_state s ON s.track_id = t.id WHERE ${filter.trackWhere}`).get(...filter.trackArgs).count);
      assert.equal(result.total, total, `total: ${value}`);
      assert.equal(result.hasMore, offset + expected.length < total, `pagination: ${value}`);
    }
    assert.equal(playedTrackPageIds(db, catalogFilter(new URLSearchParams("q=track")), 5, 0), null, "search retains its existing query path");
    assert.equal(playedTrackPageIds(db, catalogFilter(new URLSearchParams("smart=recent")), 5, 0), null, "smart playlists retain their existing order");
    const filter = catalogFilter(new URLSearchParams());
    const beforeWrite = legacyRows(db, filter, 80, 0).map(publicTrack);
    const originalPrepare = DatabaseSync.prototype.prepare;
    let concurrentWrite = false;
    try {
      DatabaseSync.prototype.prepare = function (sql) {
        const statement = originalPrepare.call(this, sql);
        if (this === db || !sql.includes("FROM music_track_state s INDEXED BY") || concurrentWrite) return statement;
        return { all: (...args) => {
          const rows = statement.all(...args);
          concurrentWrite = true;
          db.prepare("UPDATE music_track_state SET last_played_at = '2099-01-01' WHERE track_id = 'track-00000'").run();
          return rows;
        } };
      };
      const currentPage = store.listTracks({ searchParams: new URLSearchParams("sort=played&limit=80") });
      assert(concurrentWrite, "the concurrency fixture must publish between ID selection and hydration");
      assert.deepEqual(currentPage.tracks, beforeWrite, "concurrent progress writes must not split the page snapshot");
    } finally {
      DatabaseSync.prototype.prepare = originalPrepare;
    }
    const baseline = timed(() => legacyRows(db, filter, 80, 0));
    const optimized = timed(() => optimizedRows(db, filter, 80, 0));
    assert.deepEqual(optimized.result, baseline.result);
    const plan = [];
    playedTrackPageIds({ prepare(sql) { plan.push(...db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(80, 0).map((row) => row.detail)); return db.prepare(sql); } }, filter, 80, 0);
    assert(plan.some((detail) => detail.includes("idx_music_track_state_played")), "recent pages must start from the playback-time index");
    assert(plan.some((detail) => detail.includes("SEARCH t")), "recent pages must look up catalogue rows by ID");
    console.log(JSON.stringify({ ok: true, cases: cases.length, tracks: 30000, baselineMs: baseline.ms, optimizedMs: optimized.ms, plan }));
  } finally {
    await store?.stop();
    db.close();
    // Only remove these named fixture files. Refuse to recurse into anything
    // another process may have placed in the directory.
    assert.equal(path.dirname(fs.realpathSync(root)), fs.realpathSync(os.tmpdir()));
    for (const suffix of ["", "-wal", "-shm"]) {
      const file = `${dbPath}${suffix}`;
      if (fs.existsSync(file)) fs.unlinkSync(file);
    }
    fs.rmdirSync(root);
  }
}

function legacyRows(db, filter, limit, offset) {
  return db.prepare(`SELECT ${trackColumns} FROM music_tracks t ${joins}
    WHERE ${filter.trackWhere} ORDER BY ${trackOrderSql("played")} LIMIT ? OFFSET ?`)
    .all(...filter.trackArgs, limit, offset);
}

function optimizedRows(db, filter, limit, offset) {
  const ids = playedTrackPageIds(db, filter, limit, offset);
  if (!ids) return legacyRows(db, filter, limit, offset);
  const rows = db.prepare(`SELECT ${trackColumns} FROM music_tracks t ${joins}
    WHERE t.id IN (${ids.map(() => "?").join(", ")})`).all(...ids);
  const byId = new Map(rows.map((row) => [row.id, row]));
  return ids.map((id) => byId.get(id));
}

function timed(run) {
  const start = performance.now();
  const result = run();
  return { result, ms: Number((performance.now() - start).toFixed(2)) };
}
