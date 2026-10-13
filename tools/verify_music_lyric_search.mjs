import assert from "node:assert/strict";
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { performance } from "node:perf_hooks";
import { createMusicStore } from "../src/modules/music/server/store.js";
import { listLyricMatches } from "../src/modules/music/server/lyrics-search.js";
import { writeScanRecords } from "../src/modules/music/server/scan.js";
import { MAX_INTRO_BYTES } from "../src/modules/music/server/constants.js";
import { routeMusicApi } from "../src/modules/music/server/routes.js";
import { createMusicSearchMatchContext, musicSearchValueMatch } from "../src/modules/music/server/search.js";

const legacyWideSuggestAlbums = process.argv.includes("--legacy-wide-suggest-albums");
assert(process.argv.slice(2).every(argument => ["--legacy-lyric-search", "--legacy-indexed-count", "--legacy-suggest-lookups", "--legacy-wide-suggest-albums", "--legacy-lyric-snippets", "--legacy-search-match-context", "--legacy-search-value-reuse"].includes(argument)), "known arguments");

// Actual store/schema/scan publication, private :memory: SQLite only. No worker,
// media, service, temporary file or application database participates.
const lyricPath = new URL("../src/modules/music/server/lyrics-search.js", import.meta.url);
const storePath = new URL("../src/modules/music/server/store.js", import.meta.url);
const lyricSource = fs.readFileSync(lyricPath, "utf8").replaceAll("\r\n", "\n");
const storeSource = fs.readFileSync(storePath, "utf8").replaceAll("\r\n", "\n");
const absoluteImports = (source, file) => source.replace(/from "(\.\/[^"]+)"/gu,
  (_, relative) => `from ${JSON.stringify(new URL(relative, file).href)}`);
const moduleUrl = source => `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;

const ORIGINAL_LYRIC_SNIPPETS = String.raw`function lyricMatch(row, query) {
  const lines = parseJsonArray(row.parsed_json)
    .map((line) => ({ timeMs: Math.max(0, Number(line?.timeMs || 0)), text: String(line?.text || "").trim() }))
    .filter((line) => line.text);
  const index = bestLyricLineIndex(lines, query);
  const selected = lines[index] || { timeMs: 0, text: fallbackLyricText(row.raw_text, query) };
  return {
    track: publicTrack(row),
    lineIndex: Math.max(0, index),
    timeMs: selected.timeMs,
    text: selected.text,
    before: previousLyricText(lines, index),
    after: nextLyricText(lines, index),
    highlights: matchedLyricTerms(selected.text, query)
  };
}

function bestLyricLineIndex(lines, query) {
  const normalizedQuery = normalizeComparable(query);
  const terms = lyricSearchTerms(query);
  let bestIndex = -1;
  let bestScore = 0;
  lines.forEach((line, index) => {
    const text = normalizeComparable(line.text);
    if (!text) return;
    let score = text.includes(normalizedQuery) ? 1000 + normalizedQuery.length : 0;
    const matched = terms.filter((term) => text.includes(term));
    score += matched.length * 120 + matched.reduce((sum, term) => sum + term.length, 0);
    if (score > bestScore) {
      bestScore = score;
      bestIndex = index;
    }
  });
  return bestIndex;
}

function previousLyricText(lines, index) {
  for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
    if (lines[cursor]?.text) return lines[cursor].text;
  }
  return "";
}

function nextLyricText(lines, index) {
  for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
    if (lines[cursor]?.text) return lines[cursor].text;
  }
  return "";
}

function fallbackLyricText(rawText, query) {
  const lines = String(rawText || "").split(/\r?\n/u).map((line) => line.replace(/^(?:\[[^\]]*\])+\s*/u, "").trim()).filter(Boolean);
  const normalizedQuery = normalizeComparable(query);
  return lines.find((line) => normalizeComparable(line).includes(normalizedQuery)) || lines[0] || "歌词命中";
}

function matchedLyricTerms(text, query) {
  const source = String(text || "");
  const normalizedSource = normalizeComparable(source);
  const phrases = [...new Set([normalizeComparable(query), ...lyricSearchTerms(query)].filter(Boolean))]
    .sort((left, right) => right.length - left.length);
  return phrases.filter((term) => normalizedSource.includes(term));
}

function lyricSearchTerms(value) {
  const normalized = normalizeComparable(value);
  const words = normalized.match(/[\p{L}\p{N}]+/gu) || [];
  return words.length > 1 ? [...new Set(words)] : normalized ? [normalized] : [];
}

function normalizeComparable(value) {
  return String(value || "").normalize("NFKC").replace(/\s+/gu, " ").trim().toLocaleLowerCase();
}
`;

function previousSnippetSource(source) {
  const start = source.indexOf("\nfunction lyricQueryContext(query) {");
  assert(start > 0, "locate the request-local context and complete snippet algorithm");
  const current = source.slice(start), previous = "\n" + ORIGINAL_LYRIC_SNIPPETS;
  const context = "  const context = lyricQueryContext(query);\n";
  const currentMap = "matches: rows.map((row) => lyricMatch(row, query, context))";
  const previousMap = "matches: rows.map((row) => lyricMatch(row, query))";
  assert.equal(source.split(context).length, 2); assert.equal(source.split(currentMap).length, 2);
  const restored = (source.slice(0, start) + previous).replace(context, "").replace(currentMap, previousMap);
  assert.equal(restored.replace(previous, current).replace(previousMap, currentMap)
    .replace("  return {\n    query,\n    matches:", context + "  return {\n    query,\n    matches:"), source,
  "the old snippet oracle restores exactly without changing SQL, paging or serializers");
  return restored;
}
const { listLyricMatches: previousSnippets } = await import(moduleUrl(absoluteImports(previousSnippetSource(lyricSource), lyricPath)));

function previousLyricsSource(source, { short = true, counts = true, indexedCount = false } = {}) {
  assert.ok(source.includes("CROSS JOIN music_tracks t") && source.includes("JOIN music_lyrics l ON l.track_id = t.id"));
  let previous = source;
  if (counts) {
    const start = previous.indexOf("  const total = Number(db.prepare(indexed");
    const end = previous.indexOf("  const select = `", start);
    assert.ok(start > 0 && end > start);
    previous = previous.slice(0, start) + String.raw`  const total = Number(db.prepare(indexed
    ? "SELECT COUNT(*) AS count FROM music_search WHERE music_search MATCH ?"
    : "SELECT COUNT(*) AS count FROM music_lyrics WHERE raw_text LIKE ? ESCAPE '\\'"
  ).get(searchArg)?.count || 0);
` + previous.slice(end);
  } else if (indexedCount) {
    const before = "? `SELECT COUNT(*) AS count FROM music_search\n       JOIN music_tracks t ON t.id = music_search.track_id\n       JOIN music_lyrics l ON l.track_id = t.id\n       WHERE t.status = 'ok' AND music_search MATCH ?`";
    assert.ok(previous.includes(before));
    previous = previous.replace(before, '? "SELECT COUNT(*) AS count FROM music_search WHERE music_search MATCH ?"');
  }
  if (short) {
    const start = previous.indexOf("function shortLyricRows(");
    const end = previous.indexOf("function emptyLyricSearch(", start);
    assert.ok(start > 0 && end > start);
    // The complete previous SQL/JS algorithm, including its original lack of
    // ORDER BY. This remains an independent oracle rather than a new join.
    const original = [
      "function shortLyricRows(db, searchArg, limit, offset) {",
      "  const lyrics = db.prepare(`",
      "    SELECT track_id, parsed_json, raw_text",
      "    FROM music_lyrics",
      "    WHERE raw_text LIKE ? ESCAPE '\\\\'",
      "    LIMIT ? OFFSET ?",
      "  `).all(searchArg, limit, offset);",
      "  const track = db.prepare(`",
      "    SELECT t.*, a.name AS artist_name, al.title AS album_name, al.cover_path,",
      "           s.favorite, s.rating, s.position_ms, s.duration_ms AS state_duration_ms,",
      "           s.play_count, s.last_played_at",
      "    FROM music_tracks t",
      "    LEFT JOIN music_artists a ON a.id = t.artist_id",
      "    LEFT JOIN music_albums al ON al.id = t.album_id",
      "    LEFT JOIN music_track_state s ON s.track_id = t.id",
      "    WHERE t.id = ? AND t.status = 'ok'",
      "  `);",
      "  return lyrics",
      "    .map((lyric) => {",
      "      const row = track.get(lyric.track_id);",
      "      return row ? { ...row, parsed_json: lyric.parsed_json, raw_text: lyric.raw_text } : null;",
      "    })",
      "    .filter(Boolean);",
      "}", ""
    ].join("\n");
    previous = previous.slice(0, start) + original + "\n" + previous.slice(end);
  }
  return previous;
}

const { listLyricMatches: previousLyrics } = await import(moduleUrl(absoluteImports(previousLyricsSource(lyricSource), lyricPath)));
let selectedLyrics = listLyricMatches;
if (process.argv.includes("--legacy-lyric-search")) selectedLyrics = previousLyrics;
if (process.argv.includes("--legacy-indexed-count")) {
  ({ listLyricMatches: selectedLyrics } = await import(moduleUrl(absoluteImports(previousLyricsSource(lyricSource,
    { short: false, counts: false, indexedCount: true }), lyricPath))));
}
let oldStoreSource = storeSource;
for (const [entity, serializer, lookup] of [["artist", "publicArtist", "artistLookup"], ["album", "publicAlbum", "albumLookup"]]) {
  const current = `[...new Set(tracks.map((track) => track.${entity}Id))].map((id) => ${lookup}.get(id)).filter(Boolean).map(${serializer})`;
  assert.ok(oldStoreSource.includes(current));
  oldStoreSource = oldStoreSource.replace(current, `tracks.map((track) => ${lookup}.get(track.${entity}Id)).filter(Boolean).map(${serializer})`);
}
const { createMusicStore: previousStore } = await import(moduleUrl(absoluteImports(oldStoreSource, storePath)));

const originalPrepare = DatabaseSync.prototype.prepare;
const connections = [], stores = [];
let work = null;
DatabaseSync.prototype.prepare = function (sql, ...args) {
  if (!connections.includes(this)) connections.push(this);
  const statement = originalPrepare.call(this, sql, ...args);
  const text = sql.replace(/\s+/gu, " ").trim();
  return new Proxy(statement, { get(target, name) {
    const value = Reflect.get(target, name, target);
    if (typeof value !== "function") return value;
    return (...input) => {
      if (work && ["get", "all"].includes(name)) {
        work[name] += 1;
        if (name === "get" && /^SELECT (?:\*|id,name,language,album_count,track_count,duration_ms,size_bytes) FROM music_artists WHERE id =/u.test(text)) work.artist += 1;
        if (name === "get" && /WHERE al.id = \?/u.test(text)) work.album += 1;
      }
      return value.apply(target, input);
    };
  } });
};
function openStore(factory = createMusicStore) {
  const store = factory({ dbPath: ":memory:", roots: [], scanWorker: {
    start() { assert.fail("no worker start"); }, scan() { assert.fail("no scan"); }, async stop() {}, diagnostics() { return {}; }
  } });
  stores.push(store);
  store.summary();
  return { store, db: connections.at(-1) };
}
function measured(run) {
  work = { get: 0, all: 0, artist: 0, album: 0 };
  try { const result = run(); return { result, counts: { ...work } }; } finally { work = null; }
}
const request = (q, limit = 7, offset = 0) => {
  const value = new URL("http://fixture/api/music/lyrics/search");
  for (const [key, text] of Object.entries({ q, limit, offset })) value.searchParams.set(key, text);
  return value;
};
function snapshot(count = 32, variant = 0) {
  const tracks = Array.from({ length: count }, (_, i) => ({
    id: `track-${i}`, artistId: `artist-${Math.floor(i / Math.max(1, count / 4))}`, albumId: `album-${Math.floor(i / Math.max(1, count / 4))}`,
    title: `测试歌曲 ${String(count - i).padStart(4, "0")}`, sortTitle: "", displayArtist: `测试歌手${Math.floor(i / Math.max(1, count / 4))}`,
    albumTitle: `测试专辑${Math.floor(i / Math.max(1, count / 4))}`, trackNo: i + 1, discNo: 1, genre: "测试", language: "华语",
    sourceRoot: "/synthetic", sourcePath: `/synthetic/${i}.mp3`, relativePath: `${i}.mp3`, fileName: `${i}.mp3`, ext: ".mp3",
    sizeBytes: i + 1, mtimeMs: 1, durationMs: 1000 + i, codec: "mp3", sampleRate: 44100, bitDepth: 16, channels: 2,
    lrcPath: "", hasLrc: 1, status: "ok", error: "", updatedAt: "2026-10-04"
  }));
  const artists = Array.from({ length: 4 }, (_, i) => ({ id: `artist-${i}`, name: `测试歌手${i}`, sortName: "", language: "华语",
    sourceRoot: "/synthetic", sourcePath: `/synthetic/artist${i}`, relativePath: `artist${i}`, albumCount: 1,
    trackCount: count / 4, durationMs: 1000, sizeBytes: 100, updatedAt: "2026-10-04" }));
  const albums = artists.map((artist, i) => ({ id: `album-${i}`, artistId: artist.id, title: `测试专辑${i}`, sortTitle: "", year: "2026",
    coverPath: variant % 2 ? `/synthetic/cover${i}.jpg` : "", introPath: "", introText: "", sourceRoot: "/synthetic",
    sourcePath: `/synthetic/album${i}`, relativePath: `album${i}`, trackCount: count / 4, durationMs: 1000, sizeBytes: 100, updatedAt: "cover-stamp" }));
  let lyrics = tracks.map((track, i) => ({ trackId: track.id, lrcPath: "", rawText: "[00:01]爱你在天空 Ａ % _ \\ é Love\n[00:02]空白后续",
    parsedJson: i % 5 === 0 ? "invalid" : JSON.stringify([{ timeMs: -10, text: " " }, { timeMs: 1000, text: "爱你在天空 Ａ % _ \\ é Love" },
      { timeMs: 2000, text: "空白后续" }]), updatedAt: "2026-10-04" }));
  if (variant === 1) lyrics.reverse();
  if (variant >= 2) lyrics = lyrics.map((_, i, source) => source[(i * 7) % source.length]);
  return { artists, albums, tracks: variant % 2 ? [...tracks].reverse() : tracks, lyrics };
}

try {
  let oracles = 0;
  let bounded;
  for (let variant = 0; variant < 5; variant++) {
    const { store, db } = openStore();
    const data = snapshot(32, variant);
    writeScanRecords(db, data, [], "2026-10-04");
    if (variant === 3) db.exec("CREATE INDEX fixture_lyrics_covering ON music_lyrics(raw_text, track_id, parsed_json)");
    if (variant === 4) db.exec("ANALYZE");
    db.prepare("INSERT INTO music_track_state(track_id,play_count,rating,favorite,position_ms,updated_at) VALUES(?,?,?,?,?,?)").run("track-5", 3, 4, 1, 300, "state");
    db.prepare("UPDATE music_tracks SET duration_ms=? WHERE id=?").run(0, "track-6");
    db.prepare("UPDATE music_tracks SET duration_ms=? WHERE id=?").run(1234, "track-7");
    const durationState = db.prepare("INSERT INTO music_track_state(track_id,duration_ms,updated_at) VALUES(?,?,?)");
    durationState.run("track-6", 3456, "state-duration");
    durationState.run("track-7", 9999, "state-duration");
    for (const q of ["爱", "爱你", "Ａ", "%", "_", "\\", "爱你在天空", "Love", "missing", ""]) {
      for (const limit of [1, 7, 100]) for (const offset of [0, 3, 20, 40]) {
        const url = request(q, limit, offset);
        const result = selectedLyrics === listLyricMatches ? store.searchLyrics(url) : selectedLyrics(db, url);
        assert.equal(JSON.stringify(result), JSON.stringify(previousLyrics(db, url)), `all-ok ${variant}/${q}/${limit}/${offset} preserves complete old response bytes and scan order`);
        oracles += 1;
      }
    }
    for (const q of ["爱你", "爱你在天空"]) {
      const url = request(q, 100);
      const result = selectedLyrics === listLyricMatches ? store.searchLyrics(url) : selectedLyrics(db, url);
      assert.equal(result.matches.find(match => match.track.id === "track-6").track.durationMs, 3456,
        "zero track duration falls back to the joined state duration");
      assert.equal(result.matches.find(match => match.track.id === "track-7").track.durationMs, 1234,
        "nonzero track duration takes precedence over the joined state duration");
      assert.equal(JSON.stringify(result), JSON.stringify(previousLyrics(db, url)));
    }
    bounded = measured(() => selectedLyrics(db, request("爱你", 100)));
  }
  console.log(`music-lyric-search: ${oracles} all-ok full response byte oracles; forward/reverse/shuffled inserts, covering index, ANALYZE, Unicode/escaped LIKE/FTS/timed fallback/state/EOF`);

  const { store, db } = openStore();
  const data = snapshot(1000);
  writeScanRecords(db, data, [], "2026-10-04");
  db.prepare("UPDATE music_tracks SET status='missing' WHERE CAST(substr(id,7) AS INTEGER)<100").run();
  const run = url => selectedLyrics === listLyricMatches ? store.searchLyrics(url) : selectedLyrics(db, url);
  const first = run(request("爱你", 100));
  assert.equal(first.total, 900, "short lyric count must include only active matching tracks before paging");
  assert.equal(first.matches.length, 100, "inactive leading lyrics must not consume the first page");
  assert.equal(first.hasMore, true);
  const all = [];
  let offset = 0;
  do {
    const page = measured(() => run(request("爱你", 100, offset)));
    assert.deepEqual(page.counts, { get: 1, all: 1, artist: 0, album: 0 }, "short lyric requests have two fixed SQL executions, independent of page size");
    assert.equal(page.result.offset, offset);
    all.push(...page.result.matches.map(match => match.track.id));
    offset += page.result.matches.length;
    if (!page.result.hasMore) break;
    assert.ok(page.result.matches.length > 0, "a load-more offset derived from displayed matches must always advance");
  } while (offset <= 1000);
  assert.deepEqual(all, data.lyrics.slice(100).map(lyric => lyric.trackId));
  assert.equal(new Set(all).size, 900);
  assert.deepEqual(run(request("爱你", 100, 900)).matches, []);
  assert.equal(run(request("爱你", 100, 900)).hasMore, false);
  assert.deepEqual(bounded.counts, { get: 1, all: 1, artist: 0, album: 0 }, "all-ok short pages also avoid N+1 queries");

  db.prepare("DELETE FROM music_lyrics WHERE track_id='track-999'").run();
  db.prepare("DELETE FROM music_tracks WHERE id='track-998'").run();
  db.prepare("INSERT INTO music_search(track_id,title,artist,album,lyrics) SELECT track_id,title,artist,album,lyrics FROM music_search WHERE track_id='track-997'").run();
  const indexed = measured(() => run(request("爱你在天空", 100)));
  assert.equal(indexed.result.total, 899, "FTS totals use the same active track/lyrics membership and retain existing duplicate-index multiplicity");
  assert.equal(indexed.result.matches.length, 100);
  assert.deepEqual(indexed.counts, { get: 1, all: 1, artist: 0, album: 0 });
  const indexedIds = [];
  for (let cursor = 0; cursor < 900; cursor += 100) {
    const page = run(request("爱你在天空", 100, cursor));
    indexedIds.push(...page.matches.map(match => match.track.id));
    assert.equal(page.hasMore, cursor + page.matches.length < 899);
  }
  assert.equal(indexedIds.length, 899);
  assert.equal(indexedIds.filter(id => id === "track-997").length, 2);
  assert.ok(!indexedIds.includes("track-999") && !indexedIds.includes("track-998"));
  db.prepare("UPDATE music_tracks SET status='error'").run();
  for (const q of ["爱你", "爱你在天空"]) {
    const empty = run(request(q, 100));
    assert.equal(empty.total, 0); assert.equal(empty.matches.length, 0); assert.equal(empty.hasMore, false);
  }
  db.prepare("UPDATE music_tracks SET status='ok',title='恢复的歌曲' WHERE id='track-997'").run();
  assert.equal(run(request("爱你", 100)).matches[0].track.title, "恢复的歌曲", "the next request reads current metadata/state without cache");
  console.log("music-lyric-search: active short paging repairs the 100-leading-missing/900-eligible case; stale/orphan/duplicate FTS, EOF, removed/restored membership and fixed 1 get+1 all passed");

  const current = openStore(process.argv.includes("--legacy-suggest-lookups") ? previousStore : createMusicStore);
  const previous = openStore(previousStore);
  const suggestionData = snapshot(1000);
  const sameEntityData = { ...suggestionData,
    artists: suggestionData.artists.map((artist, i) => ({ ...artist, trackCount: i === 0 ? 1000 : 0 })),
    albums: suggestionData.albums.map((album, i) => ({ ...album, trackCount: i === 0 ? 1000 : 0 })),
    tracks: suggestionData.tracks.map(track => ({ ...track, artistId: "artist-0", albumId: "album-0", displayArtist: "测试歌手0", albumTitle: "测试专辑0" })) };
  for (const fixture of [current, previous]) writeScanRecords(fixture.db, sameEntityData, [], "2026-10-04");
  const suggestion = measured(() => current.store.suggest("测试"));
  const oldSuggestion = measured(() => previous.store.suggest("测试"));
  assert.equal(JSON.stringify(suggestion.result), JSON.stringify(oldSuggestion.result));
  assert.equal(suggestion.counts.artist, 1, "8 same-artist tracks must perform only one request-local artist lookup");
  assert.equal(suggestion.counts.album, 1, "8 same-album tracks must perform only one request-local album lookup");
  assert.equal(oldSuggestion.counts.artist, 8); assert.equal(oldSuggestion.counts.album, 8);
  const interleaved = snapshot(8);
  const firstTrackOrder = ["B", "A", "B", "C", "D", "A", "E", "C"];
  const directOrder = ["E", "D", "C", "A", "B"];
  const interleavedData = { ...interleaved,
    artists: directOrder.map((label, i) => ({ ...interleaved.artists[0], id: `artist-${label}`,
      name: `探针曲歌手${label}`, trackCount: 10 - i })),
    albums: directOrder.map((label, i) => ({ ...interleaved.albums[0], id: `album-${label}`, artistId: `artist-${label}`,
      title: `探针曲专辑${label}`, trackCount: 10 - i })),
    tracks: interleaved.tracks.map((track, i) => ({ ...track, title: `探针曲 ${String(i).padStart(4, "0")}`,
      artistId: `artist-${firstTrackOrder[i]}`, albumId: `album-${firstTrackOrder[i]}`,
      displayArtist: `探针曲歌手${firstTrackOrder[i]}`, albumTitle: `探针曲专辑${firstTrackOrder[i]}` })) };
  for (const fixture of [current, previous]) {
    writeScanRecords(fixture.db, interleavedData, [], "2026-10-04");
    fixture.db.prepare("INSERT INTO music_track_state(track_id,play_count,updated_at) VALUES(?,?,?)").run("track-0", 15, "state");
    fixture.db.prepare("INSERT INTO music_track_state(track_id,play_count,updated_at) VALUES(?,?,?)").run("track-1", 7, "state");
  }
  for (const [table, column, prefix] of [["music_artists", "name", "artist"], ["music_albums", "title", "album"]]) {
    assert.deepEqual(current.db.prepare(`SELECT id FROM ${table} WHERE track_count>0 ORDER BY track_count DESC,${column} COLLATE NOCASE LIMIT 5`)
      .all().map(row => row.id), directOrder.map(label => `${prefix}-${label}`));
  }
  const interleavedSuggestion = measured(() => current.store.suggest("探针曲"));
  assert.deepEqual(interleavedSuggestion.result.tracks.map(track => track.artistId), firstTrackOrder.map(label => `artist-${label}`));
  assert.deepEqual(interleavedSuggestion.result.artists.map(artist => artist.id), ["B", "A", "C", "D", "E"].map(label => `artist-${label}`));
  assert.deepEqual(interleavedSuggestion.result.albums.map(album => album.id), ["B", "A", "C", "D", "E"].map(label => `album-${label}`));
  assert.equal(interleavedSuggestion.counts.artist, 5); assert.equal(interleavedSuggestion.counts.album, 5);
  assert.equal(JSON.stringify(interleavedSuggestion.result), JSON.stringify(previous.store.suggest("探针曲")),
    "interleaved top-eight entities preserve complete old response bytes despite a different direct entity ordering");
  for (const fixture of [current, previous]) writeScanRecords(fixture.db, suggestionData, [], "2026-10-04");
  let suggestionOracles = 2;
  for (const q of ["测试", "测试歌手", "测试专辑", "测试歌曲 0250", "ceshi", "csgs", "missing", "测试 歌曲", "测试歌手3", "___", ""]) {
    assert.equal(JSON.stringify(current.store.suggest(q)), JSON.stringify(previous.store.suggest(q))); suggestionOracles += 1;
  }
  for (const fixture of [current, previous]) {
    fixture.db.prepare("UPDATE music_artists SET name='更新歌手' WHERE id='artist-3'").run();
    fixture.db.prepare("UPDATE music_albums SET title='更新专辑' WHERE id='album-3'").run();
  }
  assert.equal(current.store.suggest("测试歌手3").artists[0].name, "更新歌手");
  assert.equal(JSON.stringify(current.store.suggest("测试歌手3")), JSON.stringify(previous.store.suggest("测试歌手3"))); suggestionOracles += 1;
  for (const fixture of [current, previous]) fixture.db.prepare("DELETE FROM music_artists WHERE id='artist-3'").run();
  assert.equal(JSON.stringify(current.store.suggest("测试歌手3")), JSON.stringify(previous.store.suggest("测试歌手3"))); suggestionOracles += 1;
  console.log(`music-suggest: ${suggestionOracles} old response byte oracles; 8+8 point reads ->1+1, first-track order/direct entity merge/missing relation/next-request updates preserved`);
  verifyLyricSnippetWork();
  await verifySuggestAlbumProjection();
  await verifySearchMatchContext();
  console.log("music-lyric-search: PASS");
} finally {
  work = null;
  try { await Promise.all(stores.map(store => store.stop())); }
  finally { DatabaseSync.prototype.prepare = originalPrepare; }
}

function verifyLyricSnippetWork() {
  const selected = process.argv.includes("--legacy-lyric-snippets") ? previousSnippets : null;
  let responseOracles = 0, errorOracles = 0;
  const sqlBudget = { get: 1, all: 1, artist: 0, album: 0 };
  function compare(owner, q, limit = 100, offset = 0) {
    const url = request(q, limit, offset);
    const current = measured(() => selected ? selected(owner.db, url) : owner.store.searchLyrics(url));
    const previous = measured(() => previousSnippets(owner.db, url));
    assert.deepEqual(current.result, previous.result, "complete timed lyric response retains the old selection/neighbor/highlight values");
    assert.equal(JSON.stringify(current.result), JSON.stringify(previous.result), "complete timed lyric response retains serialized field order and NaN/Infinity behavior");
    assert.deepEqual(current.counts, previous.counts);
    if (q) assert.deepEqual(current.counts, sqlBudget, "selection keeps one count and one page execution, with no per-track lookups");
    responseOracles++;
    return current.result;
  }
  function observeJS(run) {
    const original = { map: Array.prototype.map, filter: Array.prototype.filter, normalize: String.prototype.normalize, parse: JSON.parse };
    const counters = { maps: 0, mappedItems: 0, filters: 0, filteredItems: 0, normalizes: 0, parses: 0 };
    Array.prototype.map = function (...args) { counters.maps++; counters.mappedItems += this.length; return original.map.apply(this, args); };
    Array.prototype.filter = function (...args) { counters.filters++; counters.filteredItems += this.length; return original.filter.apply(this, args); };
    String.prototype.normalize = function (...args) { counters.normalizes++; return original.normalize.apply(this, args); };
    JSON.parse = function (...args) { counters.parses++; return original.parse.apply(this, args); };
    try { const result = measured(run); return { ...counters, sql: result.counts, response: result.result }; }
    finally { Array.prototype.map = original.map; Array.prototype.filter = original.filter; String.prototype.normalize = original.normalize; JSON.parse = original.parse; }
  }
  const rawText = "[00:01][00:02]love signal red blue 爱你 Ａ % _ \\ é\n[00:03]Another line";
  const diagnostics = [];
  for (const [limit, lineCount] of [[40, 200], [100, 500], [100, 2000]]) {
    const owner = openStore(), data = snapshot(100);
    const firstMatch = Math.floor(lineCount * 0.85), tieMatch = firstMatch + 5;
    const lines = Array.from({ length: lineCount }, (_, index) => ({ timeMs: index * 1000,
      text: index === firstMatch ? " Ｌｏｖｅ   signal 爱你 " : index === tieMatch ? "love signal 爱你" : `Synthetic line ${index}` }));
    data.lyrics = data.tracks.map(track => ({ trackId: track.id, lrcPath: "", rawText, parsedJson: JSON.stringify(lines), updatedAt: "same" }));
    writeScanRecords(owner.db, data, [], "same");
    const url = request("爱你", limit), currentRead = () => selected ? selected(owner.db, url) : owner.store.searchLyrics(url);
    const previousRead = () => previousSnippets(owner.db, url);
    const first = compare(owner, "爱你", limit);
    assert.equal(first.matches[0].lineIndex, firstMatch, "equal best scores retain the earlier filtered line");
    assert.equal(first.matches[0].before, `Synthetic line ${firstMatch - 1}`);
    assert.equal(first.matches[0].after, `Synthetic line ${firstMatch + 1}`);
    for (const q of ["爱", "love signal", "Ｌｏｖｅ", "red red blue", "%", "_", "\\", "é", "missing", ""]) {
      for (const offset of [0, 3, 100]) compare(owner, q, limit, offset);
    }
    const oldWork = observeJS(previousRead), newWork = observeJS(currentRead);
    assert.deepEqual(newWork.response, oldWork.response);
    assert.deepEqual(newWork.sql, sqlBudget); assert.deepEqual(oldWork.sql, sqlBudget);
    assert.equal(newWork.parses, limit); assert.equal(newWork.parses, oldWork.parses, "every row still parses its current JSON without a persistent cache");
    assert.equal(newWork.maps, 1, "negative control: selection must not map/copy every parsed lyric line");
    assert.equal(newWork.mappedItems, limit);
    assert(newWork.filters <= limit + 2, "negative control: scoring must not allocate a matched-term filter for every line");
    assert.equal(oldWork.mappedItems, limit * (lineCount + 1));
    assert(oldWork.filters >= limit * lineCount);
    // Timing runs after all JS-counter hooks have been restored, so the many
    // removed old callbacks do not include instrumentation overhead.
    for (let warm = 0; warm < 3; warm++) { previousRead(); currentRead(); }
    const previousTimes = [], currentTimes = [];
    const timed = (read, times) => { const began = performance.now(); read(); times.push(performance.now() - began); };
    for (let round = 0; round < 15; round++) {
      if (round % 2) { timed(currentRead, currentTimes); timed(previousRead, previousTimes); }
      else { timed(previousRead, previousTimes); timed(currentRead, currentTimes); }
    }
    const median = times => times.slice().sort((a, b) => a - b)[Math.floor(times.length / 2)];
    const { response: _oldResponse, ...before } = oldWork, { response: _newResponse, ...after } = newWork;
    diagnostics.push({ matches: limit, linesPerTrack: lineCount, timedRounds: 15,
      beforeMedianMs: +median(previousTimes).toFixed(3), afterMedianMs: +median(currentTimes).toFixed(3), before, after });
  }
  const owner = openStore(), data = snapshot(8);
  data.lyrics = data.tracks.map(track => ({ trackId: track.id, lrcPath: "", rawText, parsedJson: "[]", updatedAt: "same" }));
  writeScanRecords(owner.db, data, [], "same");
  const values = ["invalid", "null", "{}", "17", "[]",
    JSON.stringify([{ timeMs: -1, text: " " }, { timeMs: "bad", text: "爱你" }, { timeMs: 2, text: "before" },
      { timeMs: 4, text: "LOVE signal 爱你" }, { timeMs: 5, text: "after" }]),
    JSON.stringify([{ timeMs: 1, text: "red" }, { timeMs: 2, text: "blue" }, { timeMs: 3, text: "red blue" },
      { timeMs: 4, text: " " }, { timeMs: 5, text: "red blue" }, { timeMs: 6, text: "after" }]),
    JSON.stringify([{ timeMs: 3, text: "no matching" }, { timeMs: 7, text: "still no matching" }]),
    JSON.stringify([{ timeMs: {}, text: "爱你" }, { timeMs: 8, text: false }, { timeMs: 2, text: 17 },
      { timeMs: 10, text: ["爱你", "test"] }, { timeMs: -1, text: null }, "primitive", null]),
    '[{"timeMs":1e309,"text":"爱你"}]',
    JSON.stringify([{ timeMs: -9, text: "爱你" }, { timeMs: 5, text: "before" }, { timeMs: 7, text: "爱你" }]),
    JSON.stringify([{ timeMs: 9, text: "before" }, { timeMs: 10, text: " \r\n " }, { timeMs: 12, text: "é Ａ \\ % _" }])];
  for (const value of values) {
    owner.db.prepare("UPDATE music_lyrics SET parsed_json=?").run(value);
    for (const q of ["爱你", "love signal", "red blue", "red red blue", "Ａ", "é", "%", "_", "\\"]) compare(owner, q);
  }
  owner.db.prepare("UPDATE music_lyrics SET parsed_json=?").run(JSON.stringify([{ timeMs: 1, text: "no match" }]));
  const fallback = compare(owner, "爱你").matches[0];
  assert.equal(fallback.lineIndex, 0); assert.equal(fallback.before, ""); assert.equal(fallback.after, "no match");
  assert(fallback.text.startsWith("love signal"), "raw fallback removes repeated time tags but retains the original first matching text");
  for (const raw of ["[00:01]first\r\n[00:02]爱你", "[00:01]not matching", "", null]) {
    owner.db.prepare("UPDATE music_lyrics SET raw_text=?").run(raw);
    compare(owner, "love signal"); // The existing FTS row deliberately stays unchanged.
  }
  owner.db.prepare("UPDATE music_lyrics SET raw_text=?,parsed_json=?").run(rawText, JSON.stringify([{ timeMs: 321, text: "live 爱你" }]));
  assert.equal(compare(owner, "爱你").matches[0].timeMs, 321);
  owner.db.prepare("UPDATE music_tracks SET status='missing' WHERE id='track-0'").run(); compare(owner, "爱你");
  owner.db.prepare("UPDATE music_tracks SET status='ok',title='Live title',duration_ms=0 WHERE id='track-0'").run();
  owner.db.prepare("INSERT INTO music_track_state(track_id,position_ms,duration_ms,play_count,favorite,rating,updated_at) VALUES('track-0',123,999,3,1,4,'same')").run();
  const updated = compare(owner, "爱你").matches.find(match => match.track.id === "track-0");
  assert.equal(updated.track.title, "Live title"); assert.equal(updated.track.durationMs, 999);
  updated.text = "private response mutation"; assert.equal(compare(owner, "爱你").matches.find(match => match.track.id === "track-0").text, "live 爱你");
  owner.db.prepare("DELETE FROM music_lyrics WHERE track_id='track-0'").run(); compare(owner, "爱你");
  const errorShape = run => {
    try { run(); assert.fail("the previous invalid value must still throw"); }
    catch (error) { return { name: error.name, message: error.message, code: error.code }; }
  };
  for (const line of [{ timeMs: { toString: 1, valueOf: 2 }, text: "爱你" }, { timeMs: 1, text: { toString: 1, valueOf: 2 } }]) {
    owner.db.prepare("UPDATE music_lyrics SET parsed_json=?").run(JSON.stringify([line]));
    const currentError = errorShape(() => owner.store.searchLyrics(request("爱你")));
    assert.deepEqual(currentError, errorShape(() => previousSnippets(owner.db, request("爱你"))));
    assert.equal(currentError.name, "TypeError"); errorOracles++;
  }
  owner.db.close();
  assert.deepEqual(errorShape(() => listLyricMatches(owner.db, request("爱你"))), errorShape(() => previousSnippets(owner.db, request("爱你"))));
  errorOracles++;
  console.log(JSON.stringify({ check: "music-lyric-snippets", completeResponseOracles: responseOracles, identicalErrorOracles: errorOracles,
    SQLUnchanged: true, noPersistentCache: true, tiesAndFilteredNeighbors: true, malformedTimeTextAndRawFallback: true, liveUpdates: true, diagnostics }));
}

async function verifySuggestAlbumProjection() {
  // Whole previous request, including existing first-track Set deduplication.
  // This oracle is independent of the earlier repeated-lookup counterproof.
  const previousSuggest = [
    "  function suggest(queryOrUrl = \"\") {",
    "    const params = queryOrUrl?.searchParams;",
    "    const query = String(params ? params.get(\"q\") || params.get(\"search\") || \"\" : queryOrUrl || \"\").trim();",
    "    if (!query) return { query, tracks: [], artists: [], albums: [] };",
    "    const database = dbOrOpen();",
    "    const like = `%${escapeLike(query)}%`;",
    "    let searchKind = musicSearchIndexKind(query);",
    "    let searchTerm = query;",
    "    let tracks = suggestTracks(database, query, searchKind, searchTerm);",
    "    if (!tracks.length && searchKind !== \"phonetic\") {",
    "      searchKind = \"phonetic\";",
    "      tracks = suggestTracks(database, query, searchKind, query);",
    "    }",
    "    let correctedQuery = \"\";",
    "    if (!tracks.length) {",
    "      correctedQuery = findPhoneticCorrection(database, query);",
    "      if (correctedQuery) {",
    "        searchKind = \"phonetic\";",
    "        searchTerm = correctedQuery;",
    "        tracks = suggestTracks(database, query, searchKind, searchTerm);",
    "      }",
    "    }",
    "    const directArtists = database",
    "      .prepare(",
    "        `",
    "        SELECT *",
    "        FROM music_artists",
    "        WHERE track_count > 0 AND name LIKE ? ESCAPE '\\\\'",
    "        ORDER BY track_count DESC, name COLLATE NOCASE",
    "        LIMIT 5",
    "      `",
    "      )",
    "      .all(like)",
    "      .map(publicArtist);",
    "    const directAlbums = database",
    "      .prepare(",
    "        `",
    "        SELECT al.*, a.name AS artist_name",
    "        FROM music_albums al",
    "        LEFT JOIN music_artists a ON a.id = al.artist_id",
    "        WHERE al.track_count > 0 AND (",
    "          al.title LIKE ? ESCAPE '\\\\' OR",
    "          a.name LIKE ? ESCAPE '\\\\'",
    "        )",
    "        ORDER BY al.track_count DESC, al.title COLLATE NOCASE",
    "        LIMIT 5",
    "      `",
    "      )",
    "      .all(like, like)",
    "      .map(publicAlbum);",
    "    const artistLookup = database.prepare(\"SELECT * FROM music_artists WHERE id = ? AND track_count > 0\");",
    "    const albumLookup = database.prepare(`",
    "      SELECT al.*, a.name AS artist_name",
    "      FROM music_albums al",
    "      LEFT JOIN music_artists a ON a.id = al.artist_id",
    "      WHERE al.id = ? AND al.track_count > 0",
    "    `);",
    "    const artists = mergeSuggestionEntities(",
    "      [...new Set(tracks.map((track) => track.artistId))].map((id) => artistLookup.get(id)).filter(Boolean).map(publicArtist),",
    "      directArtists,",
    "      5",
    "    );",
    "    const albums = mergeSuggestionEntities(",
    "      [...new Set(tracks.map((track) => track.albumId))].map((id) => albumLookup.get(id)).filter(Boolean).map(publicAlbum),",
    "      directAlbums,",
    "      5",
    "    );",
    "    const matchQuery = correctedQuery || searchTerm || query;",
    "    return {",
    "      query,",
    "      tracks: tracks.map((track) => decorateTrackSearchMatch(track, matchQuery)),",
    "      artists: artists.map((artist) => decorateArtistSearchMatch(artist, matchQuery)),",
    "      albums: albums.map((album) => decorateAlbumSearchMatch(album, matchQuery)),",
    "      searchMode: searchKind,",
    "      correctedQuery",
    "    };",
    "  }",
    "",
    ""
  ].join("\n");
  // Keep the artist projection identical in this album-only control.
  const albumOnlyPreviousSuggest = previousSuggest
    .replace("const directArtists = database\n      .prepare(", "const directArtists = prepareArtistFacet(database,")
    .replace("SELECT *\n        FROM music_artists", "SELECT ${ARTIST_FACET_COLUMNS}\n        FROM music_artists")
    .replace('const artistLookup = database.prepare("SELECT * FROM music_artists WHERE id = ? AND track_count > 0");',
      'const artistLookup = prepareArtistFacet(database, `SELECT ${ARTIST_FACET_COLUMNS} FROM music_artists WHERE id = ? AND track_count > 0`);');
  const start = storeSource.indexOf("  function suggest("), end = storeSource.indexOf("  function suggestTracks(", start);
  const currentSuggest = storeSource.slice(start, end);
  const expected = albumOnlyPreviousSuggest
    .replace("const directAlbums = database\n      .prepare(", "const directAlbums = prepareAlbumFacet(database,")
    .replace("const albumLookup = database.prepare(" + String.fromCharCode(96), "const albumLookup = prepareAlbumFacet(database, " + String.fromCharCode(96))
    .replaceAll("SELECT al.*, a.name AS artist_name", "SELECT " + "$" + "{ALBUM_FACET_COLUMNS}, a.name AS artist_name");
  const projectionSuggest = currentSuggest
    .replace("    const matchContext = matchQuery && (tracks.length || artists.length || albums.length)\n      ? createMusicSearchMatchContext(matchQuery) : null;\n", "")
    .replaceAll(", matchQuery, matchContext)", ", matchQuery)");
  assert.equal(expected, projectionSuggest, "the album projection oracle retains the complete former request after removing only optional match context wiring");
  const previousSource = storeSource.replace(currentSuggest, albumOnlyPreviousSuggest);
  assert.equal(previousSource.replace(albumOnlyPreviousSuggest, currentSuggest), storeSource, "the whole old album request restores exactly without changing lookup deduplication or artist projection");
  const { createMusicStore: previousFactory } = await import(moduleUrl(absoluteImports(previousSource, storePath)));
  const selectedFactory = legacyWideSuggestAlbums ? previousFactory : createMusicStore;
  const prepare = DatabaseSync.prototype.prepare;
  const owned = [];
  let measurement = null, failure = null, beforeRead = null;
  let responseOracles = 0, errorOracles = 0, planOracles = 0;
  const distributions = [];
  let maximum;
  const columns = "al.id,al.artist_id,al.title,al.year,al.cover_path,al.track_count,al.duration_ms,al.size_bytes,al.updated_at";
  const albumQuery = sql => /a\.name AS artist_name\s+FROM music_albums al/u.test(sql);
  DatabaseSync.prototype.prepare = function (sql, ...args) {
    const database = this, kind = albumQuery(sql) ? /WHERE al\.id = \?/u.test(sql) ? "lookup" : "direct" : null;
    if (measurement?.db === database) measurement.prepares++;
    if (failure?.db === database && kind === failure.kind && failure.phase === "prepare") throw failure.error;
    const statement = prepare.call(database, sql, ...args);
    const observation = measurement?.db === database ? measurement : null;
    if (!observation && failure?.db !== database && beforeRead?.db !== database) return statement;
    return new Proxy(statement, { get(target, name) {
      const value = Reflect.get(target, name, target);
      if (typeof value !== "function") return value;
      if (name === "columns") return (...input) => { if (observation) observation.metadataReads++; return value.apply(target, input); };
      if (!["get", "all"].includes(name)) return value.bind(target);
      return (...input) => {
        if (observation) {
          observation.reads++;
          observation.queries.push({ sql, input });
        }
        if (failure?.db === database && kind === failure.kind && failure.phase === name) throw failure.error;
        const result = value.apply(target, input);
        if (kind && observation) {
          const rows = name === "all" ? result : result ? [result] : [];
          observation.rows += rows.length;
          for (const row of rows) for (const [field, item] of Object.entries(row)) {
            observation.fields++;
            if (field === "intro_text") observation.introBytes += typeof item === "string"
              ? Buffer.byteLength(item, "utf8") : ArrayBuffer.isView(item) ? item.byteLength : 0;
          }
        }
        if (beforeRead?.db === database && beforeRead.kind === kind && beforeRead.phase === name) {
          const callback = beforeRead.callback; beforeRead = null; callback();
        }
        return result;
      };
    } });
  };
  function open(factory) { const owner = openStore(factory); owned.push(owner); return owner; }
  function data(bytes) {
    const base = snapshot(8);
    return { ...base,
      artists: base.tracks.map((_, i) => ({ ...base.artists[0], id: "a" + i, name: "测试歌手" + i, trackCount: 1 })),
      albums: base.tracks.map((_, i) => ({ ...base.albums[0], id: "al" + i, artistId: "a" + i, title: "测试专辑" + i,
        introText: "x".repeat(bytes), introPath: "synthetic://intro", trackCount: 1 })),
      tracks: base.tracks.map((track, i) => ({ ...track, artistId: "a" + i, albumId: "al" + i,
        title: "测试歌曲" + i, displayArtist: "测试歌手" + i, albumTitle: "测试专辑" + i }))
    };
  }
  function seed(owner, records) {
    writeScanRecords(owner.db, records, [], "2026-10-04");
    owner.db.prepare("INSERT INTO music_track_state(track_id,favorite,rating,position_ms,play_count,updated_at) VALUES('track-0',0,1,100,0,'state')").run();
  }
  function read(owner, q) {
    measurement = { db: owner.db, prepares: 0, reads: 0, metadataReads: 0, rows: 0, fields: 0, introBytes: 0, queries: [] };
    try { return { response: owner.store.suggest(q), ...measurement }; }
    finally { measurement = null; }
  }
  function equal(after, before, label, { legacy = false } = {}) {
    assert.deepEqual(after.response, before.response, label);
    assert.equal(JSON.stringify(after.response), JSON.stringify(before.response), label + " JSON");
    assert.equal(after.reads, before.reads, "SQL execution count remains unchanged");
    assert.equal(after.prepares, before.prepares + (legacy && !legacyWideSuggestAlbums ? 2 : 0),
      "normal prepares are unchanged; missing optional columns only retry the two original wide prepares");
    for (let index = 0; index < after.queries.length; index++) {
      const current = after.queries[index], old = before.queries[index];
      assert.deepEqual(current.input, old.input, "complete original query binds");
      assert.equal(current.sql.replace(columns, "al.*"), old.sql, "JOIN/WHERE/ORDER/LIMIT and non-album queries are unchanged");
      assert.deepEqual(prepare.call(after.db, "EXPLAIN QUERY PLAN " + current.sql).all(...current.input).map(row => row.detail),
        prepare.call(before.db, "EXPLAIN QUERY PLAN " + old.sql).all(...old.input).map(row => row.detail));
      planOracles++;
    }
    responseOracles++;
  }
  function caught(run) {
    try { run(); } catch (error) { return error; }
    assert.fail("the original failure must still throw");
  }
  function shape(error) { return { name: error.name, message: error.message, code: error.code, errcode: error.errcode }; }
  async function route(owner, q = "测试") {
    const response = {}, log = console.error; console.error = () => {};
    try {
      assert(await routeMusicApi({ method: "GET" }, {}, new URL("http://fixture/api/music/suggest?q=" + encodeURIComponent(q)), {
        musicStore: owner.store, sendJson(_res, status, payload) { response.status = status; response.payload = payload; },
        notFound() { response.status = 404; }
      }));
      return response;
    } finally { console.error = log; }
  }
  try {
    for (const bytes of [0, 8192, MAX_INTRO_BYTES]) {
      const old = open(previousFactory), current = open(selectedFactory), records = data(bytes);
      seed(old, records); seed(current, records);
      const coldBefore = read(old, "测试"), coldAfter = read(current, "测试");
      equal(coldAfter, coldBefore, "first request with " + bytes + " byte intros");
      for (const q of ["测", "测试", "测试歌", "ceshi", "csgs", "测试专辑", "zzzzzz", "%_\\", "", new URL("http://fixture/api/music/suggest?q=测试")]) {
        equal(read(current, q), read(old, q), "query " + String(q));
      }
      const warmBefore = read(old, "测试"), warmAfter = read(current, "测试");
      equal(warmAfter, warmBefore, "repeated request");
      const result = { introBytesPerAlbum: bytes, rows: coldAfter.rows, prepares: coldAfter.prepares, reads: coldAfter.reads, metadataReads: coldAfter.metadataReads,
        formerFields: coldBefore.fields, fields: coldAfter.fields, formerColdBytes: coldBefore.introBytes,
        coldBytes: coldAfter.introBytes, formerWarmBytes: warmBefore.introBytes, warmBytes: warmAfter.introBytes };
      distributions.push(result);
      if (bytes === MAX_INTRO_BYTES) maximum = result;
      for (const sql of [
        "UPDATE music_tracks SET album_id='al0'",
        "UPDATE music_tracks SET album_id=''",
        "INSERT INTO music_albums(id,artist_id,title,source_root,source_path,relative_path,track_count,updated_at) VALUES('','a0','测试空专辑','synthetic','synthetic','synthetic',1,'v2')",
        "UPDATE music_albums SET cover_path=X'0102',year=NULL,duration_ms=NULL,size_bytes=NULL,updated_at='v2'",
        "UPDATE music_albums SET intro_text='new',intro_path='synthetic://next'",
        "UPDATE music_albums SET track_count=0 WHERE id=''",
        "UPDATE music_tracks SET album_id='al'||substr(id,7)",
        "UPDATE music_albums SET title='Tie',track_count=1",
        "UPDATE music_albums SET artist_id='missing' WHERE id='al2'",
        "UPDATE music_track_state SET favorite=NULL,rating='text',position_ms=0",
        "UPDATE music_tracks SET album_id='missing' WHERE id='track-0'"
      ]) {
        old.db.exec(sql); current.db.exec(sql);
        equal(read(current, "测试"), read(old, "测试"), "next-request metadata/duplicate/empty/orphan/raw-type change");
      }
      // The two autocommit query phases still see their own current rows.
      const interleaved = owner => {
        beforeRead = { db: owner.db, kind: "direct", phase: "all", callback() {
          owner.db.exec("UPDATE music_albums SET title='间隙后专辑',updated_at='v3'");
        } };
        const response = read(owner, "测试"); assert.equal(beforeRead, null); return response;
      };
      equal(interleaved(current), interleaved(old), "metadata changes between direct suggestions and point lookups");
      const routeAfter = await route(current), routeBefore = await route(old);
      assert.equal(routeAfter.status, 200); assert.deepEqual(routeAfter, routeBefore); responseOracles++;
      for (const [kind, phase] of [["direct", "prepare"], ["lookup", "prepare"], ["direct", "all"], ["lookup", "get"]]) {
        const held = Object.assign(new Error("held suggestion " + kind + "/" + phase), { code: "fixture" });
        for (const owner of [current, old]) {
          failure = { db: owner.db, kind, phase, error: held };
          assert.equal(caught(() => read(owner, "测试")), held, "prepare/all/get errors propagate the same Error object");
          errorOracles++;
        }
        failure = null;
      }
      const nativeUnsupported = caught(() => prepare.call(current.db, "SELECT al.not_a_dto_column FROM music_albums al"));
      for (const owner of [current, old]) {
        failure = { db: owner.db, kind: "direct", phase: "prepare", error: nativeUnsupported };
        assert.equal(caught(() => read(owner, "测试")), nativeUnsupported, "only the exact optional-column native error may retry");
        errorOracles++;
      }
      failure = null;
      for (const status of [503, 500]) {
        const held = Object.assign(new Error("private unavailable"), status === 503 ? { statusCode: 503, retryable: true, expose: true } : {});
        failure = { db: current.db, kind: "direct", phase: "all", error: held };
        const after = await route(current);
        failure = { db: old.db, kind: "direct", phase: "all", error: held };
        const before = await route(old);
        assert.equal(after.status, status); assert.deepEqual(after, before); errorOracles++;
        failure = null;
      }
    }
    for (const missing of [["year"], ["duration_ms"], ["size_bytes"], ["updated_at"],
      ["year", "duration_ms", "size_bytes", "updated_at"], ["cover_path"], ["track_count"], ["title"]]) {
      const old = open(previousFactory), current = open(selectedFactory);
      seed(old, data(8192)); seed(current, data(8192));
      for (const owner of [old, current]) for (const field of missing) {
        if (field === "track_count") owner.db.exec("DROP INDEX idx_music_albums_track_count");
        if (field === "title") owner.db.exec("DROP INDEX idx_music_albums_title; DROP INDEX idx_music_albums_track_count; DROP INDEX idx_music_albums_artist");
        owner.db.exec("ALTER TABLE music_albums DROP COLUMN " + field);
      }
      for (const q of ["测试", "测试专辑", "zzzzzz"]) {
        let before, error;
        try { before = read(old, q); } catch (caught) { error = caught; }
        if (error) {
          assert.deepEqual(shape(caught(() => read(current, q))), shape(error), "required original SELECT/WHERE/ORDER column errors stay native");
          errorOracles++;
        } else {
          const after = read(current, q);
          equal(after, before, "legacy optional columns " + missing.join(","), { legacy: true });
          assert.equal(after.introBytes, before.introBytes, "legacy fallback retains the complete original wide row");
        }
      }
    }
    console.log(JSON.stringify({ musicSuggestAlbumProjection: { responseOracles, errorOracles, planOracles,
      legacySchemas: 8, wholeOldRequestRestored: true, distributions } }));
    // Every response/plan/error/legacy/update oracle finishes before the old
    // whole-request negative reaches these actual materialization budgets.
    assert.equal(maximum.formerColdBytes, 13 * MAX_INTRO_BYTES, "the old request really reads thirteen maximum-sized intros");
    assert.equal(maximum.formerWarmBytes, 13 * MAX_INTRO_BYTES);
    assert.equal(maximum.coldBytes, 0, "suggest album intro payload budget: cold request must read zero intro bytes");
    assert.equal(maximum.warmBytes, 0, "suggest album intro payload budget: warm request must read zero intro bytes");
    assert.equal(maximum.metadataReads, 1, "one track-statement metadata inspection adds no executed row reads");
    assert.equal(maximum.prepares, 6); assert.equal(maximum.reads, 19);
  } finally {
    failure = null; beforeRead = null; measurement = null;
    DatabaseSync.prototype.prepare = prepare;
    await Promise.all(owned.map(owner => owner.store.stop()));
    assert(owned.every(owner => !owner.db.isOpen), "every private native owner closes even on the negative assertion");
  }
}

async function verifySearchMatchContext() {
  const searchPath = new URL("../src/modules/music/server/search.js", import.meta.url);
  const source = fs.readFileSync(searchPath, "utf8").replaceAll("\r\n", "\n");
  // This exact negative disables only this round's field-result reuse. The
  // query context, original phonetic cache, SQL and every other round remain.
  const cacheLine = "  const cache = context?.valueMatches;";
  const uncachedLine = "  const cache = null;";
  assert.equal(source.split(cacheLine).length, 2, "locate one request-local field-cache entry point");
  const uncachedSource = source.replace(cacheLine, uncachedLine);
  assert.equal(uncachedSource.replace(uncachedLine, cacheLine), source, "the new negative restores exact source bytes after one line");
  const sourceModule = text => moduleUrl(absoluteImports(text, searchPath)
    .replace('from "pinyin-pro"', `from ${JSON.stringify(import.meta.resolve("pinyin-pro"))}`));
  const uncachedModule = sourceModule(uncachedSource);
  const uncached = await import(uncachedModule);
  const uncachedStoreSource = absoluteImports(storeSource, storePath).replace(JSON.stringify(searchPath.href), JSON.stringify(uncachedModule));
  const { createMusicStore: uncachedFactory } = await import(moduleUrl(uncachedStoreSource));
  // Independent former two-argument helper, including its exact early-return
  // and conversion order. The rest of the phonetic/range algorithm is shared.
  const previousMatch = String.raw`export function musicSearchValueMatch(value, query) {
  const source = String(value || "");
  const needle = normalizeSearchText(query).toLocaleLowerCase();
  if (!source || !needle) return { score: 0, highlights: [] };
  const normalizedSource = normalizeSearchText(source).toLocaleLowerCase();
  const directRanges = directSearchRanges(source, needle);
  const sourcePhonetic = phoneticUnits(source);
  const queryPhonetic = phoneticUnits(needle);
  const phoneticRanges = [];
  const queryVariants = [...new Set([
    compactPhoneticText(needle),
    queryPhonetic.compact,
    queryPhonetic.initials
  ].filter((item) => item.length >= 2))];
  for (const variant of queryVariants) {
    collectMappedRanges(sourcePhonetic.compact, sourcePhonetic.compactMap, variant, phoneticRanges);
    collectMappedRanges(sourcePhonetic.initials, sourcePhonetic.initialMap, variant, phoneticRanges);
  }
  const ranges = mergeCharacterRanges([...directRanges, ...phoneticRanges]);
  let score = 0;
  if (normalizedSource === needle) score = 1000;
  else if (sourcePhonetic.compact === queryPhonetic.compact) score = 940;
  else if (sourcePhonetic.initials === queryPhonetic.compact || sourcePhonetic.initials === queryPhonetic.initials) score = 900;
  else if (normalizedSource.startsWith(needle)) score = 820;
  else if (sourcePhonetic.compact.startsWith(queryPhonetic.compact)) score = 780;
  else if (sourcePhonetic.initials.startsWith(queryPhonetic.compact)) score = 740;
  else if (directRanges.length) score = 680;
  else if (phoneticRanges.length) score = 620;
  return {
    score,
    highlights: ranges.map(([start, end]) => Array.from(source).slice(start, end).join("")).filter(Boolean)
  };
}`;
  const begin = source.indexOf("export function musicSearchValueMatch("), end = source.indexOf("\n\n\nexport function phoneticSearchFtsTerm(", begin);
  assert(begin > 0 && end > begin);
  const previousSearch = source.slice(0, begin) + previousMatch + source.slice(end);
  const oldSearchSource = previousSearch
    .replace("function directSearchRanges(source, query, contextTerms)", "function directSearchRanges(source, query)")
    .replace("const terms = contextTerms || [...new Set([query,", "const terms = [...new Set([query,");
  const searchModule = moduleUrl(absoluteImports(oldSearchSource, searchPath)
    .replace('from "pinyin-pro"', `from ${JSON.stringify(import.meta.resolve("pinyin-pro"))}`));
  const previous = await import(searchModule);
  assert.equal(musicSearchValueMatch.length, previous.musicSearchValueMatch.length, "the optional context retains the two-argument helper arity");
  let previousStoreSource = storeSource
    .replace("    const matchContext = matchQuery && (tracks.length || artists.length || albums.length)\n      ? createMusicSearchMatchContext(matchQuery) : null;", "    const matchContext = null;")
    .replaceAll("    const matchContext = matchQuery && rows.length ? createMusicSearchMatchContext(matchQuery) : null;", "    const matchContext = null;");
  assert.equal((previousStoreSource.match(/const matchContext = null;/gu) || []).length, 4, "restore former per-field query work at all four request boundaries");
  previousStoreSource = absoluteImports(previousStoreSource, storePath).replace(JSON.stringify(searchPath.href), JSON.stringify(searchModule));
  const { createMusicStore: previousFactory } = await import(moduleUrl(previousStoreSource));
  const legacyQueryContext = process.argv.includes("--legacy-search-match-context");
  const selectedFactory = legacyQueryContext ? previousFactory
    : process.argv.includes("--legacy-search-value-reuse") ? uncachedFactory : createMusicStore;
  let responseOracles = 0, helperOracles = 0, errorOracles = 0;
  const same = (actual, expected, label) => {
    assert.deepEqual(actual, expected, label);
    assert.equal(JSON.stringify(actual), JSON.stringify(expected), label + " serialized");
  };
  // Test-only exports inspect the existing private phonetic-unit cache using
  // the complete current and old sources, without exposing a production API.
  const phoneticExports = "\nexport { phoneticUnits, searchMatchPhoneticCache };\n";
  const phoneticCurrent = await import(sourceModule(source + phoneticExports));
  const phoneticPrevious = await import(sourceModule(oldSearchSource + phoneticExports));
  let phoneticCacheOracles = 0;
  for (let index = 0; index <= 4096; index++) {
    const value = `私有音色缓存${index}`;
    same(phoneticCurrent.phoneticUnits(value), phoneticPrevious.phoneticUnits(value), "existing phonetic units and range maps across the original cache capacity");
    phoneticCacheOracles++;
  }
  for (const probe of [phoneticCurrent, phoneticPrevious]) {
    assert.equal(probe.searchMatchPhoneticCache.size, 4096, "the original phonetic cache keeps its 4096-entry capacity");
    assert(!probe.searchMatchPhoneticCache.has("私有音色缓存0"));
    assert(probe.searchMatchPhoneticCache.has("私有音色缓存1"), "the original FIFO eviction removes only its oldest entry");
    const held = probe.searchMatchPhoneticCache.get("私有音色缓存4096");
    assert.equal(probe.phoneticUnits("私有音色缓存4096"), held, "existing phonetic cache hits retain the same private result object and maps");
    probe.phoneticUnits("私有音色缓存0");
    assert(!probe.searchMatchPhoneticCache.has("私有音色缓存1"), "hits do not turn the original phonetic FIFO cache into an LRU cache");
    assert.equal(probe.searchMatchPhoneticCache.size, 4096);
  }
  same(phoneticCurrent.phoneticUnits("私有音色缓存0"), phoneticPrevious.phoneticUnits("私有音色缓存0"), "an evicted phonetic entry recalculates the original value and range maps");
  phoneticCacheOracles++;
  const queries = ["", " ", "测", "测试", "测试歌", "ceshi", "csgs", "ＡＢＣ", "ABC", "é", "E\u0301", "İ", "ı", "中文😀",
    "😀测试😀", "𝄞", "🪐🪐", "aaaa aaaa", "阿 爱", "中文\n\t测试", "１２３", "%_\\", "a\u0000b", "\uD800", "𠀀测试", "ß", "e e", "a", "测试测试测试", "TEST", "测试歌手 测试歌曲"];
  const fields = ["", " ", "测试歌手", "测试歌曲", "测试专辑", "😀测试😀 测试", "ＡＢＣ ABC", "é E\u0301", "İ İstanbul", "𝄞 TEST", "𠀀测试", "\uD800测试",
    null, 0, false, NaN, Infinity, ["测试"], { toString() { return "测试"; } }];
  for (const query of queries) {
    const context = createMusicSearchMatchContext(query);
    for (const value of fields) {
      const expected = previous.musicSearchValueMatch(value, query);
      same(musicSearchValueMatch(value, query), expected, "original two-argument helper");
      same(musicSearchValueMatch(value, query, context), expected, "optional query context helper");
      const repeated = musicSearchValueMatch(value, query, context);
      same(repeated, expected, "repeated original field text retains complete old helper bytes");
      const next = musicSearchValueMatch(value, query, context);
      assert.notEqual(next.highlights, repeated.highlights, "repeated field callers retain independent mutable highlight arrays");
      repeated.highlights.push("private mutation"); repeated.score = -1;
      same(next, expected, "mutating an earlier result cannot change a later caller");
      same(musicSearchValueMatch(value, query, context), expected, "the internal cached snapshot remains private");
      helperOracles += 5;
    }
  }
  const errorShape = error => ({ name: error.name, message: error.message, code: error.code, errcode: error.errcode });
  const caught = run => { try { run(); } catch (error) { return error; } assert.fail("the old error still throws"); };
  for (const [value, query] of [[{ toString() { throw new Error("field conversion"); } }, "测试"],
    ["测试", { toString() { throw new Error("query conversion"); } }],
    [{ toString() { throw new Error("field before query"); } }, { toString() { throw new Error("query after field"); } }],
    ["", { toString() { throw new Error("query still converts for an empty field"); } }]]) {
    same(errorShape(caught(() => musicSearchValueMatch(value, query))), errorShape(caught(() => previous.musicSearchValueMatch(value, query))), "two-argument helper error and conversion order");
    errorOracles++;
  }
  const context = createMusicSearchMatchContext("测试");
  let sourceConversions = 0;
  const convertingField = { toString() { sourceConversions++; return "测试"; } };
  musicSearchValueMatch(convertingField, "测试", context); musicSearchValueMatch(convertingField, "测试", context);
  assert.equal(sourceConversions, 2, "every field keeps its original String conversion, including cache hits");
  const conversionError = new Error("cached field still converts");
  convertingField.toString = () => { throw conversionError; };
  assert.equal(caught(() => musicSearchValueMatch(convertingField, "测试", context)), conversionError, "cached field conversions propagate the original Error identity");
  errorOracles++;
  for (let index = 0; index < 300; index++) musicSearchValueMatch(`测试预算${index}`, "测试", context);
  assert.equal(context.valueMatches.size, 256, "request-local reuse stops retaining new values at 256 entries");
  const storedUnits = [...context.valueMatches].reduce((sum, [text, result]) => sum + text.length + result.highlights.reduce((units, highlight) => units + highlight.length, 0), 0);
  assert.equal(context.valueMatchUnits, storedUnits, "the text budget includes original cache keys and stored highlight strings");
  const textContext = createMusicSearchMatchContext("测试"), longPrefix = "测试" + "x".repeat(4096);
  for (let index = 0; index < 20; index++) {
    const value = longPrefix + index;
    same(musicSearchValueMatch(value, "测试", textContext), uncached.musicSearchValueMatch(value, "测试", uncached.createMusicSearchMatchContext("测试")), "text-budget bypass keeps the complete prior result");
  }
  assert(textContext.valueMatches.size < 20 && textContext.valueMatchUnits <= 64 * 1024, "request-local retained keys/highlights stay within 65536 UTF-16 units");
  const oversized = "测试" + "x".repeat(64 * 1024);
  same(musicSearchValueMatch(oversized, "测试", textContext), uncached.musicSearchValueMatch(oversized, "测试", uncached.createMusicSearchMatchContext("测试")), "oversized fields bypass memoization without truncating matching");
  assert(!textContext.valueMatches.has(oversized));
  assert.equal(createMusicSearchMatchContext("测试").valueMatches.size, 0, "a subsequent request starts with an empty field cache");
  const savedPrepare = DatabaseSync.prototype.prepare, savedNow = Date.now;
  const owned = [], diagnostics = [], reuseDiagnostics = [], queryBudgets = [], reuseBudgets = [];
  let measurement = null, failure = null, between = null;
  Date.now = () => 1_890_000_000_000;
  DatabaseSync.prototype.prepare = function (sql, ...args) {
    const database = this, text = sql.replace(/\s+/gu, " ").trim();
    if (measurement?.db === database) measurement.prepare++;
    if (failure?.db === database && failure.phase === "prepare") throw failure.error;
    const statement = savedPrepare.call(database, sql, ...args);
    return new Proxy(statement, { get(target, name) {
      const value = Reflect.get(target, name, target);
      if (typeof value !== "function") return value;
      return (...input) => {
        if (failure?.db === database && failure.phase === name) throw failure.error;
        if (measurement?.db === database && ["get", "all"].includes(name)) {
          measurement[name]++;
          measurement.queries.push({ sql: text, args: input });
        }
        const result = value.apply(target, input);
        if (between?.db === database && name === "all" && /LIMIT 8$/u.test(text)) {
          const callback = between.callback; between = null; callback();
        }
        return result;
      };
    } });
  };
  const open = (factory, data) => { const owner = openStore(factory); owned.push(owner); writeScanRecords(owner.db, data, [], "same"); return owner; };
  const url = (query, limit = 100, offset = 0, extra = {}) => {
    const result = new URL("http://fixture/api/music/tracks");
    for (const [key, value] of Object.entries({ q: query, limit, offset, ...extra })) result.searchParams.set(key, String(value));
    return result;
  };
  const read = (owner, method, query, limit = 100, offset = 0, extra = {}) => {
    measurement = { db: owner.db, prepare: 0, get: 0, all: 0, queries: [] };
    try {
      const payload = owner.store[method](method === "suggest" ? query : url(query, limit, offset, extra));
      const { db: _db, ...sql } = measurement;
      return { payload, sql };
    } finally { measurement = null; }
  };
  const compare = (current, old, method, query, limit = 100, offset = 0, extra = {}) => {
    const after = read(current, method, query, limit, offset, extra), before = read(old, method, query, limit, offset, extra);
    same(after.payload, before.payload, "whole " + method + " request " + String(query));
    same(after.sql, before.sql, "original SQL text, args, order and count");
    responseOracles++;
    return after.payload;
  };
  const observe = run => {
    const normalize = String.prototype.normalize;
    let normalizes = 0;
    String.prototype.normalize = function (...args) { normalizes++; return normalize.apply(this, args); };
    try { return { ...run(), normalizes }; }
    finally { String.prototype.normalize = normalize; }
  };
  const route = async (owner, method, query) => {
    const response = {}, log = console.error; console.error = () => {};
    const target = url(query); target.pathname = "/api/music/" + ({ listTracks: "tracks", listArtists: "artists", listAlbums: "albums", suggest: "suggest" }[method]);
    try {
      assert(await routeMusicApi({ method: "GET" }, {}, target, { musicStore: owner.store,
        sendJson(_res, status, payload) { response.status = status; response.payload = payload; }, notFound() { response.status = 404; } }));
      return response;
    } finally { console.error = log; }
  };
  try {
    const methods = ["suggest", "listTracks", "listArtists", "listAlbums"];
    for (const count of [40, 100, 1000]) {
      const data = snapshot(count), current = open(selectedFactory, data), old = open(previousFactory, data), fieldBaseline = open(uncachedFactory, data);
      for (const query of ["测", "测试", "测试歌", "ceshi", "csgs", "ceshigeshouu", "zzzzzz", "%_\\", "Ａ", "é", "𠀀测试", "😀测试", "", "测试 测试", "测试歌曲 0001", "测试专辑"]) {
        for (const method of methods) compare(current, old, method, query, count);
      }
      for (const method of methods) {
        for (const offset of [0, 3, count]) for (const sort of ["title", "name", "rating", "count", "played"]) {
          compare(current, old, method, "测试", 7, offset, { sort });
        }
      }
      for (const method of ["suggest", "listTracks"]) {
        const currentRead = () => read(current, method, "测试", count), previousRead = () => read(old, method, "测试", count);
        const fieldBaselineRead = () => read(fieldBaseline, method, "测试", count);
        // Warm both independent phonetic-unit caches before observing query
        // work. Native SQL and all other work remain in the measurements.
        for (let warm = 0; warm < 3; warm++) { currentRead(); previousRead(); fieldBaselineRead(); }
        const before = observe(previousRead), after = observe(currentRead), withoutValueReuse = observe(fieldBaselineRead);
        same(after.payload, before.payload, "counter request complete response"); same(after.sql, before.sql, "counter request SQL");
        same(after.payload, withoutValueReuse.payload, "this round preserves the complete query-context request");
        same(after.sql, withoutValueReuse.sql, "this round preserves original SQL text, args, order and executions");
        const fieldCount = method === "suggest" ? before.payload.tracks.length * 4 + before.payload.artists.length + before.payload.albums.length * 2 : before.payload.tracks.length * 4;
        queryBudgets.push({ saved: before.normalizes - (legacyQueryContext ? after : withoutValueReuse).normalizes, expected: 3 * (fieldCount - 1) });
        // Independent fixed fixture: titles/files are unique; four artist and
        // album texts repeat. Original FTS ordering includes all four artists
        // in its first 40 rows, before the entry budget can fill at 256 values.
        if (method === "listTracks" && count === 1000) assert.equal(new Set(before.payload.tracks.slice(0, 40).map(track => track.artistId)).size, 4,
          "original FTS ordering admits every repeated artist before the request cache entry limit");
        const expected = method === "suggest" ? 40 : ({ 40: 144, 100: 384, 1000: 1184 })[count];
        reuseBudgets.push({ saved: withoutValueReuse.normalizes - after.normalizes, expected });
        const beforeTimes = [], afterTimes = [];
        const currentTimed = () => current.store[method](method === "suggest" ? "测试" : url("测试", count));
        const previousTimed = () => old.store[method](method === "suggest" ? "测试" : url("测试", count));
        const baselineTimed = () => fieldBaseline.store[method](method === "suggest" ? "测试" : url("测试", count));
        const timed = (run, times) => { const started = performance.now(); run(); times.push(performance.now() - started); };
        for (let round = 0; round < 21; round++) {
          if (round % 2) { timed(baselineTimed, afterTimes); timed(previousTimed, beforeTimes); }
          else { timed(previousTimed, beforeTimes); timed(baselineTimed, afterTimes); }
        }
        const median = values => values.slice().sort((a, b) => a - b)[Math.floor(values.length / 2)];
        diagnostics.push({ catalogTracks: count, method, responseFields: fieldCount, beforeNormalizes: before.normalizes, afterNormalizes: withoutValueReuse.normalizes,
          prepare: after.sql.prepare, get: after.sql.get, all: after.sql.all, timedRounds: 21,
          beforeMedianMs: +median(beforeTimes).toFixed(3), afterMedianMs: +median(afterTimes).toFixed(3) });
        const baselineTimes = [], reusedTimes = [];
        for (let round = 0; round < 21; round++) {
          if (round % 2) { timed(currentTimed, reusedTimes); timed(baselineTimed, baselineTimes); }
          else { timed(baselineTimed, baselineTimes); timed(currentTimed, reusedTimes); }
        }
        reuseDiagnostics.push({ catalogTracks: count, method, responseFields: fieldCount,
          beforeNormalizes: withoutValueReuse.normalizes, afterNormalizes: after.normalizes, expectedSavedNormalizes: expected,
          prepare: after.sql.prepare, get: after.sql.get, all: after.sql.all, timedRounds: 21,
          beforeMedianMs: +median(baselineTimes).toFixed(3), afterMedianMs: +median(reusedTimes).toFixed(3) });
      }
      for (const sql of [
        "UPDATE music_tracks SET title='测试相同',display_artist='测试相同',album_title='测试相同',file_name='测试相同'",
        "UPDATE music_artists SET name='测试相同'; UPDATE music_albums SET title='测试相同'",
        "UPDATE music_tracks SET display_artist='',album_title='',file_name='' WHERE id='track-0'",
        "UPDATE music_tracks SET artist_id='missing',album_id='missing' WHERE id='track-0'",
        "UPDATE music_tracks SET status='missing' WHERE id='track-1'",
        "UPDATE music_tracks SET title='😀测试😀 ＡＢＣ é 𠀀测试' WHERE id='track-0'",
        "DELETE FROM music_artists WHERE id='artist-1'; DELETE FROM music_albums WHERE id='album-1'",
        "INSERT INTO music_track_state(track_id,favorite,rating,play_count,position_ms,updated_at) VALUES('track-0',1,5,7,123,'same')"
      ]) {
        current.db.exec(sql); old.db.exec(sql);
        for (const method of methods) compare(current, old, method, "测试", count);
      }
      // Preserve independent current-row phases, entity merge order and full
      // route bytes when a write occurs between the track and entity reads.
      const interleaved = [];
      for (const owner of [current, old]) {
        between = { db: owner.db, callback() { owner.db.exec("UPDATE music_artists SET name='测试间隙'; UPDATE music_albums SET title='测试间隙'"); } };
        interleaved.push(read(owner, "suggest", "测试"));
        assert.equal(between, null);
      }
      same(interleaved[0], interleaved[1], "complete suggestion response and SQL across an intervening metadata write"); responseOracles++;
      compare(current, old, "suggest", "测试", count);
      for (const method of methods) {
        same(await route(current, method, "测试"), await route(old, method, "测试"), "complete successful route response"); responseOracles++;
        const mutate = compare(current, old, method, "测试", count);
        const highlightArrays = [mutate.tracks, mutate.artists, mutate.albums].flatMap(items => items || [])
          .flatMap(item => Object.values(item.searchMatch?.highlights || {}));
        assert.equal(new Set(highlightArrays).size, highlightArrays.length, "all fields and entities in one response own distinct highlight arrays, including equal original texts");
        const item = mutate.tracks?.[0] || mutate.artists?.[0] || mutate.albums?.[0];
        if (item?.searchMatch) item.searchMatch.highlights.privateMutation = ["private"];
        compare(current, old, method, "测试", count);
        for (const phase of ["prepare", "get", "all"]) {
          const sentinel = Object.assign(new Error("private search match " + method + "/" + phase), { code: "FIXTURE_SEARCH_MATCH" });
          for (const owner of [current, old]) {
            failure = { db: owner.db, phase, error: sentinel };
            assert.equal(caught(() => read(owner, method, "测试", count)), sentinel, "ordinary SQL failures retain their exact Error object"); errorOracles++;
          }
          failure = null;
          compare(current, old, method, "测试", count);
        }
        for (const status of [500, 503]) {
          const sentinel = Object.assign(new Error("private unavailable"), status === 503 ? { statusCode: 503, retryable: true, expose: true } : {});
          failure = { db: current.db, phase: "prepare", error: sentinel }; const after = await route(current, method, "测试");
          failure = { db: old.db, phase: "prepare", error: sentinel }; const before = await route(old, method, "测试");
          assert.equal(after.status, status); same(after, before, "complete failed route response"); errorOracles++;
          failure = null;
        }
      }
      await current.store.stop(); await old.store.stop();
      same(errorShape(caught(() => current.db.prepare("SELECT 1"))), errorShape(caught(() => old.db.prepare("SELECT 1"))), "both private native connections close"); errorOracles++;
    }
    const emptyData = snapshot(0), currentEmpty = open(selectedFactory, emptyData), oldEmpty = open(previousFactory, emptyData);
    for (const method of methods) for (const query of ["", "测试", "ceshi", "😀", "%_"]) compare(currentEmpty, oldEmpty, method, query);
    const known = snapshot(8);
    for (const owner of [currentEmpty, oldEmpty]) writeScanRecords(owner.db, known, [], "same");
    for (const method of methods) compare(currentEmpty, oldEmpty, method, "测试", 8);
    console.log(JSON.stringify({ check: "music-search-match-context", completeResponseOracles: responseOracles, helperOracles, identicalErrorOracles: errorOracles,
      SQLUnchanged: true, requestOnlyContext: true, legacyTwoArgumentHelper: true, UnicodePhoneticEscapedTiesAndLiveUpdates: true, diagnostics }));
    console.log(JSON.stringify({ check: "music-search-value-reuse", completeResponseOracles: responseOracles, helperOracles, phoneticCacheOracles, identicalErrorOracles: errorOracles,
      exactOneLineNegative: true, originalPhoneticCachePreserved: true, requestOnlyCache: true, maxEntries: 256,
      maxKeyAndHighlightUTF16Units: 65536, freshMutableHighlightArrays: true, SQLUnchanged: true, diagnostics: reuseDiagnostics }));
    // Finish every response, SQL, update, route and error oracle before either
    // exact negative reaches its deterministic computation-work assertion.
    for (const budget of queryBudgets) assert.equal(budget.saved, budget.expected,
      "negative control: reuse query normalization and phonetic variants once per response instead of every field");
    for (const budget of reuseBudgets) assert.equal(budget.saved, budget.expected,
      "negative control: repeated original field text must reuse request-local match computation");
  } finally {
    failure = null; between = null; measurement = null; Date.now = savedNow;
    DatabaseSync.prototype.prepare = savedPrepare;
    await Promise.all(owned.map(owner => owner.store.stop()));
    assert(owned.every(owner => !owner.db.isOpen), "private native owners close after success or the negative assertion");
  }
}

