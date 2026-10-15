import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { createMusicStore } from "../src/modules/music/server/store.js";

assert(process.argv.slice(2).every(value => value === "--legacy-playlist-order"));
const negative = process.argv.includes("--legacy-playlist-order");
const storeUrl = new URL("../src/modules/music/server/store.js", import.meta.url);
const source = readFileSync(storeUrl, "utf8").replaceAll("\r\n", "\n");
const start = source.indexOf("  function reorderPlaylist("), end = source.indexOf("\n  function trackFile(", start);
assert(start > 0 && end > start);
const current = source.slice(start, end).trimEnd();
// Restore the complete former operation, including its transaction, timestamp,
// input normalization and response. Only this function differs in the oracle.
const previous = `  function reorderPlaylist(playlistId, input = {}) {
    const reordered = mutate((database) => {
      const playlist = database.prepare("SELECT id FROM music_playlists WHERE id = ?").get(playlistId);
      if (!playlist) return false;
      const requested = playlistTrackIdsFromInput(input);
      if (!requested.length) throw httpError(400, "缺少歌曲排序");
      const existing = database
        .prepare(
          \`
          SELECT track_id
          FROM music_playlist_items
          WHERE playlist_id = ?
          ORDER BY sort_order ASC, added_at ASC
        \`
        )
        .all(playlistId)
        .map((row) => row.track_id);
      const existingSet = new Set(existing);
      const ordered = requested.filter((trackId) => existingSet.has(trackId));
      if (!ordered.length) throw httpError(400, "没有可排序的歌曲");
      const orderedSet = new Set(ordered);
      const nextOrder = [...ordered, ...existing.filter((trackId) => !orderedSet.has(trackId))];
      const now = new Date().toISOString();
      const updateItem = database.prepare("UPDATE music_playlist_items SET sort_order = ? WHERE playlist_id = ? AND track_id = ?");
      nextOrder.forEach((trackId, index) => updateItem.run(index + 1, playlistId, trackId));
      database.prepare("UPDATE music_playlists SET updated_at = ? WHERE id = ?").run(now, playlistId);
      return playlistDetail(playlistId);
    });
    return reordered || null;
  }`;
assert.notEqual(current, previous);
const restored = source.replace(current, previous);
assert.equal(restored.replace(previous, current), source);
const absolute = restored.replace(/from "(\.\/[^"]+)"/gu, (_, relative) => `from ${JSON.stringify(new URL(relative, storeUrl).href)}`);
const { createMusicStore: previousFactory } = await import(`data:text/javascript;base64,${Buffer.from(absolute).toString("base64")}`);

// Private in-memory stores only: no workers, services, media or filesystem DB.
const nativePrepare = DatabaseSync.prototype.prepare, NativeDate = Date;
const owners = [], connections = [];
let clock = NativeDate.parse("2026-10-15T00:00:00Z"), measuring = null, fault = null;
let comparisons = 0;
globalThis.Date = class extends NativeDate {
  constructor(...args) { super(...(args.length ? args : [clock])); }
  static now() { return clock; }
};
DatabaseSync.prototype.prepare = function (sql, ...args) {
  const db = this;
  if (!connections.includes(db)) connections.push(db);
  const statement = nativePrepare.call(db, sql, ...args);
  const kind = sql.startsWith("UPDATE music_playlist_items SET sort_order") ? "item"
    : sql.startsWith("UPDATE music_playlists SET updated_at") ? "metadata" : "";
  return new Proxy(statement, { get(target, name) {
    const value = Reflect.get(target, name, target);
    if (typeof value !== "function") return value;
    return (...input) => {
      if (measuring?.db === db) {
        if (name === "get" || name === "all") measuring.reads++;
        if (name === "run" && kind) measuring[kind]++;
      }
      if (fault?.db === db && name === "run" && kind === fault.kind && --fault.remaining === 0) throw fault.error;
      return value.apply(target, input);
    };
  } });
};
function open(factory, count) {
  const store = factory({ dbPath: ":memory:", roots: [], scanWorker: {
    start() { assert.fail("no worker start"); }, scan() { assert.fail("no media scan"); }, async stop() {}
  } });
  store.summary();
  const db = connections.at(-1), owner = { store, db }; owners.push(owner);
  db.exec("BEGIN; INSERT INTO music_playlists VALUES('p','Fixture','Synthetic','initial','initial');"
    + "INSERT INTO music_playlists VALUES('other','Other playlist','','initial','initial')");
  db.prepare("INSERT INTO music_artists(id,name,source_root,source_path,relative_path,track_count,status,updated_at) VALUES('a','Artist','','a','a',?,'ok','fixture')").run(count);
  db.prepare("INSERT INTO music_albums(id,artist_id,title,source_root,source_path,relative_path,track_count,updated_at) VALUES('al','a','Album','','al','al',?,'fixture')").run(count);
  const track = db.prepare("INSERT INTO music_tracks(id,artist_id,album_id,title,source_root,source_path,relative_path,file_name,ext,status,updated_at) VALUES(?,'a','al',?,'synthetic',?,?,?,'.mp3','ok','fixture')");
  const item = db.prepare("INSERT INTO music_playlist_items VALUES('p',?,?,'added')");
  for (let i = 0; i < count; i++) {
    track.run(`t${i}`, `Track ${i}`, `synthetic/${i}`, `${i}`, `${i}.mp3`);
    item.run(`t${i}`, i + 1);
  }
  db.exec("INSERT INTO music_playlist_items VALUES('other','t0',73,'other-added'); COMMIT");
  return owner;
}
const pair = count => ({ old: open(previousFactory, count), current: open(negative ? previousFactory : createMusicStore, count) });
const each = (value, action) => { action(value.old); action(value.current); };
function snapshot(owner) {
  return {
    playlists: owner.db.prepare("SELECT * FROM music_playlists ORDER BY id").all(),
    items: owner.db.prepare("SELECT playlist_id,track_id,quote(sort_order) AS stored_order,typeof(sort_order) AS type,added_at FROM music_playlist_items ORDER BY playlist_id,track_id").all()
  };
}
function read(owner, input, id = "p") {
  measuring = { db: owner.db, item: 0, metadata: 0, reads: 0 };
  try { return { response: owner.store.reorderPlaylist(id, input), ...measuring }; }
  finally { measuring = null; }
}
function compare(value, input, id = "p") {
  clock += 1000;
  const beforeOther = snapshot(value.current).items.filter(row => row.playlist_id === "other");
  const old = read(value.old, input, id), current = read(value.current, input, id);
  assert.deepEqual(current.response, old.response, "complete response and track order");
  assert.equal(JSON.stringify(current.response), JSON.stringify(old.response));
  assert.deepEqual(snapshot(value.current), snapshot(value.old), "complete persisted order and timestamps");
  assert.deepEqual(snapshot(value.current).items.filter(row => row.playlist_id === "other"), beforeOther, "other playlists stay unchanged");
  assert.equal(current.reads, old.reads, "reuse the original read rather than add another query");
  assert.equal(current.metadata, old.metadata, "playlist updated_at must still be written on no-op order requests");
  comparisons++;
  return { old, current };
}
function caught(action) { try { action(); } catch (error) { return error; } assert.fail("expected failure"); }
const metrics = [];
try {
  const large = pair(1000);
  for (const [name, expected] of [["swap-two", 2], ["repeat-same-order", 0]]) {
    const result = compare(large, { trackIds: ["t1", "t0"] });
    assert.equal(result.current.response.tracks.length, 1000);
    assert.deepEqual(result.current.response.tracks.slice(0, 3).map(row => row.id), ["t1", "t0", "t2"]);
    assert.equal(result.current.response.playlist.updatedAt, new Date(clock).toISOString());
    assert.equal(result.old.item, 1000);
    metrics.push({ name, previousItemUpdates: result.old.item, itemUpdates: result.current.item });
    assert.equal(result.current.item, expected, `${name}: unchanged playlist positions must not issue UPDATE`);
  }
  compare(large, { trackIds: ["t999", "unknown", "t999", { track_id: " t0 " }] });
  compare(large, { tracks: Array.from({ length: 1000 }, (_, i) => ({ id: `t${999 - i}` })) });

  const legacy = pair(10);
  each(legacy, owner => {
    const values = [null, -2, 0, 4, 4, 2.5, "legacy", 9007199254740993n, new Uint8Array([49]), "3"];
    values.forEach((value, i) => owner.db.prepare("UPDATE music_playlist_items SET sort_order=? WHERE playlist_id='p' AND track_id=?").run(value, `t${i}`));
    owner.db.exec("UPDATE music_tracks SET status='missing' WHERE id='t3'; DELETE FROM music_tracks WHERE id='t7'");
  });
  const existing = legacy.current.db.prepare("SELECT track_id FROM music_playlist_items WHERE playlist_id='p' ORDER BY sort_order,added_at").all().map(row => row.track_id);
  const expectedOrder = ["t4", "t1", ...existing.filter(id => !["t4", "t1"].includes(id))];
  const normalized = compare(legacy, { trackIds: [{ id: " t4 " }, "absent", { track_id: "t1" }, "t4"] });
  const persisted = legacy.current.db.prepare("SELECT track_id,sort_order,typeof(sort_order) AS type FROM music_playlist_items WHERE playlist_id='p' ORDER BY sort_order").all();
  assert.deepEqual(persisted.map(row => row.track_id), expectedOrder);
  assert.deepEqual(persisted.map(row => row.sort_order), Array.from({ length: 10 }, (_, i) => i + 1));
  assert(persisted.every(row => row.type === "integer"));
  assert.deepEqual(normalized.current.response.tracks.map(row => row.id), expectedOrder.filter(id => !["t3", "t7"].includes(id)));
  assert.equal(compare(legacy, { trackIds: expectedOrder }).current.item, negative ? 10 : 0);

  for (const input of [{}, { trackIds: [] }, { trackIds: ["unknown"] }]) each(legacy, owner => {
    const before = snapshot(owner), error = caught(() => owner.store.reorderPlaylist("p", input));
    assert.equal(error.statusCode, 400);
    assert.deepEqual(snapshot(owner), before, "invalid input must roll back");
  });
  assert.equal(compare(legacy, { trackIds: ["t0"] }, "absent").current.response, null);
  for (const kind of ["item", "metadata"]) {
    const value = pair(6), error = new Error(`controlled ${kind} write failure`);
    each(value, owner => {
      const before = snapshot(owner);
      fault = { db: owner.db, kind, remaining: kind === "item" ? 2 : 1, error };
      try { assert.equal(caught(() => owner.store.reorderPlaylist("p", { trackIds: ["t5", "t4"] })), error); }
      finally { fault = null; }
      assert.deepEqual(snapshot(owner), before, "a partial reorder or timestamp failure must roll back every write");
    });
    compare(value, { trackIds: ["t5", "t4"] });
  }
  console.log(JSON.stringify({ musicPlaylistOrder: "ok", comparisons, privateDatabases: owners.length, metrics }));
} finally {
  fault = null; measuring = null;
  try { for (const owner of owners) await owner.store.stop(); }
  finally { DatabaseSync.prototype.prepare = nativePrepare; globalThis.Date = NativeDate; }
}
