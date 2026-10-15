import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { createM3uTrackMatcher, decodeM3uPath, parseM3u } from "../src/modules/music/server/m3u.js";

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
  console.log("music-m3u: network/local file URL identity, ambiguous names, encoded paths and playlist order passed (memory SQLite only)");
} finally {
  database.close();
}
