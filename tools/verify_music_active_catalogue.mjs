import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createMusicStore } from "../src/modules/music/server/store.js";
import { ensureSchema } from "../src/modules/music/server/schema.js";
import { writeScanRecords } from "../src/modules/music/server/scan.js";

// Actual scans of synthetic metadata preserve old listening/rating state.
// No worker, media, running service or user database participates.
const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fanhao-music-active-catalogue-"));
const dbPath = path.join(directory, "catalog.sqlite");
const database = new DatabaseSync(dbPath);
ensureSchema(database);
const store = createMusicStore({ dbPath, roots: [] });
const metrics = {};
let scenarios = 0;
try {
  publish(Array.from({ length: 100 }, (_, id) => id));
  for (let id = 0; id < 10; id++) store.saveProgress(`track-${id}`, { played: true, positionMs: 12000 });
  for (let id = 5; id < 15; id++) store.setRating(`track-${id}`, { rating: 4 });
  assertCounts({ unplayed: 90, unrated: 90 });
  scenarios++;

  // Five listened songs remain, while all ten rated songs leave the scan.
  publish([...Array.from({ length: 5 }, (_, id) => id), ...Array.from({ length: 10 }, (_, id) => id + 15)]);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM music_track_state").get().count, 15);
  assertCounts({ unplayed: 10, unrated: 15 });
  metrics.removedSongs = { activeTracks: 15, retainedHistoryRows: 15, unplayed: 10, unrated: 15 };
  scenarios++;

  // Original stable IDs restore their listening and rating rather than resetting.
  publish(Array.from({ length: 25 }, (_, id) => id));
  assertCounts({ unplayed: 15, unrated: 15 });
  assert.equal(store.trackDetail("track-5").track.playCount, 1);
  assert.equal(store.trackDetail("track-5").track.rating, 4);
  scenarios++;

  // A dated listening marker also excludes a song from the unplayed collection.
  database.prepare("UPDATE music_track_state SET play_count=0,last_played_at='2026-10-04' WHERE track_id='track-5'").run();
  database.prepare("UPDATE music_track_state SET rating=0 WHERE track_id='track-6'").run();
  store.invalidate();
  assertCounts({ unplayed: 15, unrated: 16 });
  scenarios++;

  // Missing rows and non-active statuses do not consume counts in the live catalogue.
  database.prepare("UPDATE music_tracks SET status='missing' WHERE id='track-5'").run();
  database.prepare("UPDATE music_artists SET track_count=track_count-1").run();
  database.prepare("UPDATE music_albums SET track_count=track_count-1").run();
  store.invalidate();
  assertCounts({ unplayed: 15, unrated: 16 });
  scenarios++;

  publish([]);
  assertCounts({ unplayed: 0, unrated: 0 });
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM music_track_state").get().count, 15);
  scenarios++;
  console.log(JSON.stringify({ ok: true, scenarios, ...metrics }, null, 2));
} finally {
  await store.stop();
  database.close();
  for (const suffix of ["", "-wal", "-shm"]) {
    const file = dbPath + suffix;
    if (fs.existsSync(file)) fs.unlinkSync(file);
  }
  fs.rmdirSync(directory);
}

function assertCounts(expected) {
  const badges = store.listSmartPlaylists().smartPlaylists;
  for (const [id, count] of Object.entries(expected)) {
    const badge = badges.find(item => item.id === id);
    const detail = store.smartPlaylistDetail(id, new URL("http://fixture?limit=1000"));
    const filtered = store.listTracks(new URL(`http://fixture?smart=${id}&limit=300`));
    assert.equal(detail.total, count, `${id}: actual detail establishes the active population`);
    assert.equal(badge.trackCount, count, `${id}: badge must exclude retained state for absent songs`);
    assert.equal(filtered.total, count, `${id}: filtered list and collection must agree`);
    assert.equal(detail.tracks.length, count);
  }
}

function publish(ids) {
  const updatedAt = "2026-10-04T00:00:00.000Z";
  const durationMs = 180000;
  const records = {
    artists: ids.length ? [{ id: "artist", name: "Synthetic", sortName: "Synthetic", language: "英文", sourceRoot: directory,
      sourcePath: directory, relativePath: "artist", albumCount: 1, trackCount: ids.length,
      durationMs: ids.length * durationMs, sizeBytes: ids.length, updatedAt }] : [],
    albums: ids.length ? [{ id: "album", artistId: "artist", title: "Album", sortTitle: "Album", year: "2026",
      coverPath: "", introPath: "", introText: "", sourceRoot: directory, sourcePath: directory, relativePath: "album",
      trackCount: ids.length, durationMs: ids.length * durationMs, sizeBytes: ids.length, updatedAt }] : [],
    tracks: ids.map(id => ({ id: `track-${id}`, artistId: "artist", albumId: "album", title: `Track ${id}`,
      sortTitle: `Track ${id}`, displayArtist: "Synthetic", albumTitle: "Album", trackNo: id + 1, discNo: 1,
      genre: "Pop", language: "英文", sourceRoot: directory, sourcePath: path.join(directory, `${id}.audio`),
      relativePath: `${id}.audio`, fileName: `${id}.audio`, ext: ".audio", sizeBytes: 1, mtimeMs: 1,
      durationMs, codec: "synthetic", sampleRate: 44100, bitDepth: 16, channels: 2, lrcPath: "", hasLrc: 0,
      status: "ok", error: "", updatedAt })), lyrics: []
  };
  writeScanRecords(database, records, [directory], updatedAt);
  store.invalidate();
}
