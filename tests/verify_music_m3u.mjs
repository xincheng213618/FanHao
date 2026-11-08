import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { MAX_LIMIT } from "../src/modules/music/server/constants.js";
import { createM3uTrackMatcher, decodeM3uPath, parseM3u } from "../src/modules/music/server/m3u.js";
import { routeMusicApi } from "../src/modules/music/server/routes.js";
import { createMusicStore } from "../src/modules/music/server/store.js";

// Matching uses real SQLite rows but never opens the synthetic media paths.
const database = new DatabaseSync(":memory:");
try {
  database.exec("CREATE TABLE music_tracks (id TEXT, source_path TEXT, relative_path TEXT, file_name TEXT, status TEXT)");
  const insert = database.prepare("INSERT INTO music_tracks VALUES (?, ?, ?, ?, ?)");
  const local = path.resolve(path.parse(process.cwd()).root, "music", "song.mp3");
  insert.run("network", String.raw`\\media-host\music\song.mp3`, "song.mp3", "song.mp3", "ok");
  insert.run("other-network", String.raw`\\other-host\music\song.mp3`, "song.mp3", "song.mp3", "ok");
  insert.run("local", local, "song.mp3", "song.mp3", "ok");
  insert.run("unicode", String.raw`\\media-host\music\中文 #1.mp3`, "中文 #1.mp3", "中文 #1.mp3", "ok");
  insert.run("unique", String.raw`C:\albums\unique.flac`, "albums/unique.flac", "unique.flac", "ok");
  insert.run("missing", String.raw`\\media-host\music\missing.mp3`, "missing.mp3", "missing.mp3", "missing");
  const matcher = createM3uTrackMatcher(database);
  const networkUrl = "file://media-host/music/song.mp3";

  assert.equal(matcher.match(networkUrl)?.id, "network", "a file URL must not lose its network host and select a same-named local track");
  assert.equal(matcher.match("file://other-host/music/song.mp3")?.id, "other-network");
  assert.equal(matcher.match(String.raw`\\media-host\music\song.mp3`)?.id, "network", "raw UNC paths retain the same identity");
  assert.equal(matcher.match("FILE://MEDIA-HOST/music/song.mp3")?.id, "network");
  assert.equal(matcher.match("file://media-host/music/%E4%B8%AD%E6%96%87%20%231.mp3")?.id, "unicode");
  assert.equal(matcher.match(pathToFileURL(local).href)?.id, "local", "local file URLs keep their local path identity");
  assert.equal(matcher.match(pathToFileURL(local).href.replace("file:///", "file://localhost/"))?.id, "local");
  assert.equal(matcher.match("song.mp3"), null, "ambiguous relative names must not pick an arbitrary host");
  assert.equal(matcher.match("file://unknown-host/music/song.mp3"), null, "an absent host must not become a local absolute match");
  assert.equal(matcher.match("unique.flac")?.id, "unique", "unique filename fallback remains available");
  assert.equal(matcher.match("albums/unique.flac")?.id, "unique");
  assert.equal(matcher.match("file://media-host/music/missing.mp3"), null, "unavailable tracks stay excluded");

  assert.equal(decodeM3uPath(networkUrl), "//media-host/music/song.mp3");
  assert.equal(decodeM3uPath("file:///C:/Music/A%20B.mp3"), "C:/Music/A B.mp3");
  assert.equal(decodeM3uPath("file://localhost/C:/Music/A%20B.mp3"), "C:/Music/A B.mp3");
  assert.equal(decodeM3uPath("file:///var/music/A%20B.mp3"), "/var/music/A B.mp3");
  assert.equal(decodeM3uPath("album/A%20B.mp3"), "album/A B.mp3");
  const parsed = parseM3u(`\uFEFF#EXTM3U\r\n#PLAYLIST:Network mix\r\n#EXTINF:180,Network song\r\n${networkUrl}\r\n${pathToFileURL(local).href}\r\n`);
  assert.equal(parsed.name, "Network mix");
  assert.deepEqual(parsed.entries.map(entry => matcher.match(entry)?.id), ["network", "local"], "playlist order and cross-host identities must survive parsing");
  insert.run("legacy-blob", new Uint8Array([1, 2, 3]), null, new Uint8Array([1, 2, 3]), "ok");
  const old = createM3uTrackMatcher(database);
  const entries = [...parsed.entries, "song.mp3", "unique.flac", "1,2,3", "FILE://MEDIA-HOST/music/song.mp3"];
  const scoped = createM3uTrackMatcher(database, entries);
  for (const entry of entries) assert.deepEqual(scoped.match(entry), old.match(entry), "old nullable/BLOB path columns match identically");
  database.exec("CREATE TEMP TABLE music_tracks(id, source_path, relative_path, file_name, status)");
  database.prepare("INSERT INTO temp.music_tracks VALUES (?, ?, ?, ?, ?)")
    .run(9007199254740993n, "unreferenced", "unreferenced", "unreferenced", "ok");
  assert.throws(() => createM3uTrackMatcher(database), { code: "ERR_OUT_OF_RANGE" });
  assert.throws(() => createM3uTrackMatcher(database, entries), { code: "ERR_OUT_OF_RANGE" }, "an unreferenced row still preserves the native read error");
  console.log("music-m3u: network/local file URL identity, ambiguous names, encoded paths and playlist order passed (memory SQLite only)");
} finally {
  database.close();
}

await verifyScopedImport();

async function verifyScopedImport() {
  const storeUrl = new URL("../src/modules/music/server/store.js", import.meta.url);
  const source = fs.readFileSync(storeUrl, "utf8");
  const choice = "createM3uTrackMatcher(database, parsed.entries, source.baseDir)";
  assert.equal(source.split(choice).length, 2);
  const oldSource = source.replace(choice, "createM3uTrackMatcher(database)")
    .replace(/from "(\.\/[^"\n]+)"/gu, (_match, relative) => `from ${JSON.stringify(new URL(relative, storeUrl).href)}`);
  const { createMusicStore: previous } = await import(`data:text/javascript;base64,${Buffer.from(oldSource).toString("base64")}`);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fanhao-m3u-scoped-fixture-"));
  const dbPath = path.join(directory, "catalog.sqlite"), owners = [];
  const prepare = DatabaseSync.prototype.prepare;
  let captured, scan = null, failItem = false;
  DatabaseSync.prototype.prepare = function(sql, ...args) {
    captured = this;
    const statement = prepare.call(this, sql, ...args);
    if (scan && sql.startsWith("SELECT id, source_path, relative_path, file_name FROM music_tracks")) {
      return {
        all() { scan.method = "all"; const rows = statement.all(); scan.rows = rows.length; return rows; },
        *iterate() { scan.method = "iterate"; for (const row of statement.iterate()) { scan.rows++; yield row; } }
      };
    }
    if (failItem && sql.startsWith("INSERT OR IGNORE INTO music_playlist_items")) {
      let inserts = 0;
      return { run(...values) {
        if (++inserts === 2) throw new Error("private synthetic item write error");
        return statement.run(...values);
      } };
    }
    return statement;
  };
  function open(factory = createMusicStore) {
    const store = factory({ dbPath, roots: [], scanWorker: { start() { assert.fail("no scan"); }, async stop() {} } });
    owners.push(store);
    return store;
  }
  async function route(store, body, expected = 200) {
    const res = {};
    assert(await routeMusicApi({ method: "POST" }, res, new URL("http://fixture/api/music/playlists/import-m3u"), {
      musicStore: store, requireLocalAdmin: () => true, readJsonBody: () => body,
      sendJson: (target, status, data) => Object.assign(target, { status, data })
    }));
    assert.equal(res.status, expected);
    if (expected !== 200) return res;
    const { playlist } = res.data;
    assert.match(playlist.id, /^[0-9a-f]{20}$/u);
    assert.equal(playlist.exportUrl, `/api/music/playlists/${playlist.id}/export.m3u8`);
    assert.equal(playlist.updatedAt, playlist.createdAt);
    return { ...res, data: { ...res.data, playlist: { ...playlist, id: "fixture-id", exportUrl: "fixture-export", createdAt: "fixture-time", updatedAt: "fixture-time" } } };
  }
  const input = entries => ({ content: `#EXTM3U\n#PLAYLIST:Fixture\n${entries.join("\n")}` });
  const relative = Array.from({ length: 24 }, (_, i) => `Music Library/Author/Collection/Album/Track ${i * 263 + 1}.mp3`);
  const absolute = relative.map(entry => `X:/fixture/${entry}`);
  const median = samples => +samples.sort((a, b) => a - b)[Math.floor(samples.length / 2)].toFixed(3);
  try {
    const writer = open(); writer.summary();
    captured.exec(`INSERT INTO music_artists(id,name,source_root,source_path,relative_path,updated_at) VALUES('a','Author','fixture','fixture','fixture','2026');
      INSERT INTO music_albums(id,artist_id,title,source_root,source_path,relative_path,updated_at) VALUES('al','a','Album','fixture','fixture','fixture','2026');
      WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<100000)
      INSERT INTO music_tracks(id,artist_id,album_id,title,source_root,source_path,relative_path,file_name,ext,status,updated_at)
      SELECT 'v'||i,'a','al','Track '||i,'fixture','X:/fixture/Music Library/Author/Collection/Album/Track '||i||'.mp3',
        'Music Library/Author/Collection/Album/Track '||i||'.mp3','Track '||i||'.mp3','.mp3',CASE WHEN i%43=0 THEN 'missing' ELSE 'ok' END,'2026' FROM n;
      INSERT INTO music_tracks(id,artist_id,album_id,title,source_root,source_path,relative_path,file_name,ext,updated_at)
      VALUES ('unc','a','al','Network','fixture','//host/music/中文 #1.mp3','中文 #1.mp3','中文 #1.mp3','.mp3','2026'),
        ('duplicate','a','al','Duplicate','fixture','X:/other/Track 1.mp3','other/Track 1.mp3','Track 1.mp3','.mp3','2026');`);
    const m3uPath = path.join(directory, "fixture.m3u");
    fs.writeFileSync(m3uPath, "#EXTM3U\nfile://host/music/%E4%B8%AD%E6%96%87%20%231.mp3\nTrack 1.mp3\n");
    await writer.stop();
    const factories = [previous, createMusicStore], cold = [[], []];
    for (let round = 0; round < 3; round++) {
      const replies = [];
      for (const i of (round % 2 ? [1, 0] : [0, 1])) {
        const store = open(factories[i]), started = performance.now();
        replies[i] = await route(store, input(relative)); cold[i].push(performance.now() - started); await store.stop();
      }
      assert.deepEqual(replies[1], replies[0]);
    }
    const before = open(previous), after = open();
    scan = { rows: 0 }; const previousResult = await route(before, input(relative)); const oldScan = scan;
    scan = { rows: 0 }; assert.deepEqual(await route(after, input(relative)), previousResult); const nextScan = scan;
    scan = null;
    assert.equal(oldScan.method, "all"); assert.equal(nextScan.method, "iterate"); assert.equal(nextScan.rows, oldScan.rows);
    for (const body of [input(absolute), input(["Track 1.mp3", absolute[0], absolute[0], relative[1]]), { path: m3uPath }]) {
      assert.deepEqual(await route(after, body), await route(before, body));
    }
    const large = input(Array(MAX_LIMIT + 1).fill(relative[0]));
    const largeBefore = await route(before, large);
    scan = { rows: 0 }; assert.deepEqual(await route(after, large), largeBefore);
    assert.equal(scan.method, "all", "larger imports keep their original matcher"); scan = null;
    const rows = () => captured.prepare("SELECT (SELECT COUNT(*) FROM music_playlists) AS playlists, (SELECT COUNT(*) FROM music_playlist_items) AS items").get();
    const unchanged = rows();
    assert.deepEqual(await route(after, input(["not present"]), 400), await route(before, input(["not present"]), 400));
    const log = console.error;
    try {
      console.error = () => {}; failItem = true;
      assert.deepEqual(await route(after, input(relative), 500), await route(before, input(relative), 500));
    } finally { failItem = false; console.error = log; }
    assert.deepEqual(rows(), unchanged, "missing paths and failed writes leave no partial playlists or items");
    const warm = {};
    for (const [name, entries] of [["relative", relative], ["absolute", absolute]]) {
      const samples = [[], []];
      for (let round = 0; round < 7; round++) for (const i of (round % 2 ? [1, 0] : [0, 1])) {
        const started = performance.now(); await route([before, after][i], input(entries)); samples[i].push(performance.now() - started);
      }
      warm[name] = samples.map(median);
    }
    console.log(JSON.stringify({ check: "music-m3u-scoped-import", catalogue: 100002, active: nextScan.rows,
      coldRelativeMedianMs: cold.map(median), warmMedianMs: warm, completeRouteOracles: 8, errorOracles: 2 }));
  } finally {
    DatabaseSync.prototype.prepare = prepare;
    for (const store of owners) await store.stop();
    for (const name of fs.readdirSync(directory)) fs.unlinkSync(path.join(directory, name));
    fs.rmdirSync(directory);
  }
}
