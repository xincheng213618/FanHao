import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { createMusicStore } from "../src/modules/music/server/store.js";
import {
  buildArtistLanguageConsensus,
  explicitMusicLanguageForArtist,
  musicLanguageForArtist
} from "../src/modules/music/server/language.js";
import {
  buildMusicIdentityKnowledge,
  resolveMusicTrackIdentity
} from "../src/modules/music/server/identity.js";
import { createFileServer } from "../src/platform/server/file-server.js";

globalThis.window = { location: { href: "http://localhost/", search: "", hash: "" } };
const { routeFromUrl, routeUrl } = await import("../public/js/router.js");

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const store = createMusicStore({
  dbPath: path.join(root, "data", "music.sqlite"),
  roots: ["D:\\Music"]
});

try {
  const identityKnowledge = buildMusicIdentityKnowledge([
    { artist: "刘若英", title: "后来" },
    { artist: "刘若英", title: "后来" },
    { artist: "林俊杰", title: "江南" },
    { artist: "林俊杰", title: "江南" },
    { artist: "Hillsong Young & Free", title: "Wake (Live)" },
    { artist: "王菲", title: "容易受伤的女人" },
    { artist: "高胜美", title: "容易受伤的女人" }
  ]);
  assert.deepEqual(
    resolveMusicTrackIdentity({ fileStem: "后来(刘若英)", title: "后来(刘若英)" }, identityKnowledge),
    { artist: "刘若英", title: "后来", recovered: true, source: "filename-suffix" }
  );
  assert.equal(resolveMusicTrackIdentity({ fileStem: "江南", title: "江南" }, identityKnowledge).artist, "林俊杰");
  assert.equal(resolveMusicTrackIdentity({ fileStem: "Wake (Live) - Hillsong Young & Free", parsedArtist: "Wake (Live)", parsedTitle: "Hillsong Young & Free" }, identityKnowledge).artist, "Hillsong Young & Free");
  assert.equal(resolveMusicTrackIdentity({ fileStem: "Wake (Live) - Hillsong Young & Free", parsedArtist: "Wake (Live)", parsedTitle: "Hillsong Young & Free" }).artist, "Hillsong Young & Free", "a version marker on the left should identify title - artist order without library knowledge");
  const ambiguousHyphen = resolveMusicTrackIdentity({ fileStem: "九黎如嫣 - 少年", title: "九黎如嫣 - 少年", parsedArtist: "九黎如嫣", parsedTitle: "少年" }, identityKnowledge);
  assert.equal(ambiguousHyphen.source, "filename", "unknown A - B pairs should not be promoted as high-confidence identities");
  assert.equal(ambiguousHyphen.title, "九黎如嫣 - 少年", "ambiguous A - B pairs should preserve the original title");
  assert.equal(resolveMusicTrackIdentity({ fileStem: "Everything I Do (I Do it for You)", title: "Everything I Do (I Do it for You)" }, identityKnowledge).artist, "待识别");
  assert.equal(resolveMusicTrackIdentity({ fileStem: "容易受伤的女人", title: "容易受伤的女人" }, identityKnowledge).artist, "待识别", "ambiguous cover titles must remain unresolved");

  assert.equal(explicitMusicLanguageForArtist("S.H.E"), "中文");
  assert.equal(explicitMusicLanguageForArtist("坂本龍一"), "日文");
  assert.equal(explicitMusicLanguageForArtist("BLACKPINK"), "韩文");
  assert.equal(explicitMusicLanguageForArtist("Selena Gomez&BLACKPINK"), "", "a featured Korean artist must not reclassify the primary artist");
  const languageConsensus = buildArtistLanguageConsensus([
    { artist: "陈奕迅", language: "中文" },
    { artist: "陈奕迅", language: "中文" },
    { artist: "陈奕迅", language: "其他" },
    { artist: "Various Artists", language: "英文" },
    { artist: "Various Artists", language: "韩文" }
  ]);
  assert.equal(musicLanguageForArtist("陈奕迅", "其他", languageConsensus), "中文");
  assert.equal(musicLanguageForArtist("Various Artists", "韩文", languageConsensus), "韩文", "mixed compilations should keep their path language");

  const summary = store.summary();
  assert.ok(Number(summary.totals?.tracks || 0) > 0, "music summary should include tracks");
  assert.ok((summary.languages || []).some((item) => item.name === "中文"), "language facets should include Chinese");

  store.facets();
  const startedAt = performance.now();
  const page = store.listTracks(new URL("http://localhost/api/music/tracks?limit=1000"));
  const pageMs = performance.now() - startedAt;
  assert.equal(page.tracks.length, 300, "track page must clamp oversized requests");
  assert.equal(page.limit, 300);
  assert.ok(page.hasMore, "large libraries should expose incremental loading");
  assert.ok(page.artists.length <= 48, "track responses must keep artist facets compact");
  assert.ok(page.albums.length <= 60, "track responses must keep album facets compact");
  assert.ok(Buffer.byteLength(JSON.stringify(page)) < 350_000, "track response should stay below 350 KB");
  assert.ok(pageMs < 500, `warm track page should finish under 500 ms (actual ${pageMs.toFixed(1)} ms)`);

  const rangedTrack = page.tracks.find((track) => Number(track.sizeBytes || 0) > 2 * 1024 * 1024);
  assert.ok(rangedTrack, "scale fixture should include an audio file larger than the stream chunk");
  const rangedFile = store.trackFile(rangedTrack.id);
  assert.ok(rangedFile?.path);
  let rangeStatus = 0;
  let rangeHeaders = {};
  let rangeEnded = false;
  const fileServer = createFileServer({
    defaultChunkBytes: 2 * 1024 * 1024,
    mimeTypes: { [rangedFile.ext]: "audio/test" },
    normalizeExt: (filePath) => path.extname(filePath).toLowerCase(),
    notFound: () => assert.fail("ranged music fixture should exist"),
    safeStat: (filePath) => fs.statSync(filePath, { throwIfNoEntry: false })
  });
  fileServer.serveRangedFile(
    { method: "HEAD", headers: { range: "bytes=0-" } },
    {
      writeHead(status, headers) {
        rangeStatus = status;
        rangeHeaders = headers;
      },
      end() {
        rangeEnded = true;
      }
    },
    { ...rangedFile, maxRangeBytes: 2 * 1024 * 1024 }
  );
  assert.equal(rangeStatus, 206);
  assert.equal(Number(rangeHeaders["Content-Length"]), 2 * 1024 * 1024);
  assert.match(String(rangeHeaders["Content-Range"] || ""), /^bytes 0-2097151\//);
  assert.equal(rangeEnded, true);

  const searchStartedAt = performance.now();
  const search = store.listTracks(new URL("http://localhost/api/music/tracks?q=周杰伦&limit=120"));
  const searchMs = performance.now() - searchStartedAt;
  assert.ok(search.total > 0, "trigram search should find Chinese artists");
  assert.ok(search.tracks.length <= 120);
  assert.ok(searchMs < 800, `indexed search should finish under 800 ms (actual ${searchMs.toFixed(1)} ms)`);
  assert.equal(search.relevance, true, "unsorted searches should use relevance ranking");

  const combinedStartedAt = performance.now();
  const combinedSearch = store.listTracks(new URL("http://localhost/api/music/tracks?q=周杰伦%20青花瓷&limit=20"));
  const combinedSearchMs = performance.now() - combinedStartedAt;
  assert.ok(combinedSearch.total > 0, "artist and title terms should match across FTS fields");
  assert.equal(combinedSearch.relevance, true);
  assert.ok(combinedSearchMs < 250, `combined FTS search should finish under 250 ms (actual ${combinedSearchMs.toFixed(1)} ms)`);
  assert.ok(combinedSearch.tracks.slice(0, 5).some((track) => track.title.includes("青花瓷") && `${track.title} ${track.artist}`.includes("周杰伦")), "combined search should rank the intended track near the top");
  const compactSearch = store.listTracks(new URL("http://localhost/api/music/tracks?q=周杰伦青花瓷&limit=20"));
  assert.ok(compactSearch.total > 0, "concatenated Chinese artist and title should be segmented");
  assert.ok(compactSearch.tracks.slice(0, 5).some((track) => track.title.includes("青花瓷")));
  const englishCombinedSearch = store.listTracks(new URL("http://localhost/api/music/tracks?q=Taylor%20Love%20Story&limit=20"));
  assert.ok(englishCombinedSearch.total > 0, "multi-word English artist and title search should match");
  assert.ok(englishCombinedSearch.tracks.slice(0, 5).some((track) => /Love Story/i.test(track.title) && /Taylor/i.test(track.artist)));
  const combinedSuggest = store.suggest("Taylor Love Story");
  assert.ok(combinedSuggest.tracks.slice(0, 5).some((track) => /Love Story/i.test(track.title) && /Taylor/i.test(track.artist)), "suggestions should use the same multi-term relevance logic");
  const exactTitleSearch = store.listTracks(new URL("http://localhost/api/music/tracks?q=青花瓷&limit=10"));
  assert.equal(exactTitleSearch.tracks[0]?.title, "青花瓷", "exact song titles should outrank partial title matches");

  const shortSearchStartedAt = performance.now();
  const shortSearch = store.listTracks(new URL(`http://localhost/api/music/tracks?q=${encodeURIComponent("许巍")}&limit=120`));
  const shortSearchMs = performance.now() - shortSearchStartedAt;
  assert.ok(shortSearch.tracks.some((track) => track.artist === "许巍"), "two-character artist searches should keep complete results");
  assert.ok(shortSearchMs < 150, `short indexed search should finish under 150 ms (actual ${shortSearchMs.toFixed(1)} ms)`);
  const broadSingleStartedAt = performance.now();
  const broadSingleSearch = store.listTracks(new URL("http://localhost/api/music/tracks?q=a&limit=120"));
  const broadSingleSearchMs = performance.now() - broadSingleStartedAt;
  assert.ok(broadSingleSearch.total > 10000, "the high-cardinality one-character fixture should exercise the broad search path");
  assert.ok(broadSingleSearchMs < 100, `broad one-character search should finish under 100 ms (actual ${broadSingleSearchMs.toFixed(1)} ms)`);
  const verificationDb = new DatabaseSync(path.join(root, "data", "music.sqlite"), { readOnly: true });
  try {
    const indexedTracks = Number(verificationDb.prepare("SELECT COUNT(*) AS count FROM music_search_short").get()?.count || 0);
    assert.equal(indexedTracks, Number(summary.totals.tracks || 0), "the short search index should cover every active track");
    const legacyShortCount = verificationDb.prepare(`
      SELECT COUNT(*) AS count
      FROM music_tracks
      WHERE status = 'ok' AND (
        title LIKE ? OR display_artist LIKE ? OR album_title LIKE ? OR genre LIKE ? OR file_name LIKE ?
      )
    `);
    for (const query of ["许巍", "王菲", "a", "的", "ab"]) {
      const like = `%${query}%`;
      const expected = Number(legacyShortCount.get(like, like, like, like, like)?.count || 0);
      const indexed = store.listTracks(new URL(`http://localhost/api/music/tracks?q=${encodeURIComponent(query)}&limit=20`));
      assert.equal(indexed.total, expected, `short index should preserve all matches for ${query}`);
    }
    const filteredLike = "%王%";
    const expectedFiltered = Number(verificationDb.prepare(`
      SELECT COUNT(*) AS count
      FROM music_tracks
      WHERE status = 'ok' AND language = '中文' AND (
        title LIKE ? OR display_artist LIKE ? OR album_title LIKE ? OR genre LIKE ? OR file_name LIKE ?
      )
    `).get(filteredLike, filteredLike, filteredLike, filteredLike, filteredLike)?.count || 0);
    const filteredShort = store.listTracks(new URL(`http://localhost/api/music/tracks?language=${encodeURIComponent("中文")}&q=${encodeURIComponent("王")}&limit=20`));
    assert.equal(filteredShort.total, expectedFiltered, "short search should preserve language-filtered totals when vocabulary counts cannot be used");
  } finally {
    verificationDb.close();
  }

  const korean = store.listTracks(new URL("http://localhost/api/music/tracks?language=韩文&limit=80"));
  assert.ok(korean.total > 0, "Korean partition should contain tracks");
  assert.ok(korean.tracks.every((track) => track.language === "韩文"));
  const waitingLanguage = summary.languages.find((item) => item.name === "待识别");
  assert.ok(Number(waitingLanguage?.trackCount || 0) <= 3500, "high-confidence identity recovery should keep the unresolved partition at or below 3,500 tracks");
  const recoveredLiu = store.listTracks(new URL(`http://localhost/api/music/tracks?language=${encodeURIComponent("中文")}&q=${encodeURIComponent("刘若英 后来")}&limit=20`));
  assert.ok(recoveredLiu.tracks.some((track) => track.artist === "刘若英" && track.title === "后来"), "title(artist) filenames should recover both fields");
  const recoveredJiangnan = store.listTracks(new URL(`http://localhost/api/music/tracks?language=${encodeURIComponent("中文")}&q=${encodeURIComponent("林俊杰 江南")}&limit=20`));
  assert.ok(recoveredJiangnan.tracks.some((track) => track.artist === "林俊杰" && track.title === "江南"), "unique local title consensus should recover known artists");
  const reversedIdentity = store.listTracks(new URL(`http://localhost/api/music/tracks?q=${encodeURIComponent("Hillsong Wake")}&limit=20`));
  assert.ok(reversedIdentity.tracks.some((track) => track.artist === "Hillsong Young & Free" && track.title === "Wake (Live)"), "title - artist filenames should recognize a versioned title on the left");
  const sheTracks = store.listTracks(new URL("http://localhost/api/music/tracks?language=中文&q=S.H.E&limit=300"));
  assert.ok(sheTracks.total >= 300, "S.H.E should be grouped with Chinese artists");
  assert.ok(sheTracks.tracks.every((track) => track.language === "中文"));
  const sakamotoTracks = store.listTracks(new URL(`http://localhost/api/music/tracks?language=${encodeURIComponent("日文")}&q=${encodeURIComponent("坂本龍一")}&limit=20`));
  assert.equal(sakamotoTracks.total, 1, "Ryuichi Sakamoto should be grouped with Japanese artists");
  assert.equal(sakamotoTracks.tracks[0]?.language, "日文");
  for (const koreanArtist of ["BLACKPINK", "BIGBANG", "IU", "EXO"]) {
    const result = store.listTracks(new URL(`http://localhost/api/music/tracks?language=${encodeURIComponent("韩文")}&q=${encodeURIComponent(koreanArtist)}&limit=80`));
    assert.ok(result.total > 0, `${koreanArtist} should be grouped with Korean artists`);
    assert.ok(result.tracks.every((track) => track.language === "韩文"));
  }

  const artists = store.listArtists(new URL("http://localhost/api/music/artists?language=中文&sort=name&limit=40"));
  assert.ok(artists.total > artists.artists.length, "artist endpoint should be paginated");
  assert.ok(artists.artists.every((artist) => artist.language === "中文"));
  assert.equal(artists.limit, 40);
  assert.ok(artists.hasMore);
  const nextArtists = store.listArtists(new URL("http://localhost/api/music/artists?language=中文&sort=name&limit=40&offset=40"));
  assert.equal(nextArtists.artists.length, 40);
  assert.notEqual(nextArtists.artists[0]?.id, artists.artists[0]?.id, "artist pages should advance by offset");
  const artistSearch = store.listArtists(new URL("http://localhost/api/music/artists?language=中文&q=周&sort=name&limit=40"));
  assert.ok(artistSearch.total > 0);
  assert.ok(artistSearch.artists.every((artist) => artist.name.includes("周")));
  const selectedArtist = artists.artists[0];
  const selectedArtistTracks = store.listTracks(new URL(`http://localhost/api/music/tracks?artist=${encodeURIComponent(selectedArtist.id)}&language=中文&limit=20`));
  assert.ok(selectedArtistTracks.artists.some((artist) => artist.id === selectedArtist.id), "selected artist must remain available outside the popular facet");
  assert.ok(selectedArtistTracks.tracks.every((track) => track.artistId === selectedArtist.id));

  const albumStartedAt = performance.now();
  const albums = store.listAlbums(new URL("http://localhost/api/music/albums?language=中文&sort=title&limit=40"));
  const albumMs = performance.now() - albumStartedAt;
  assert.ok(albums.total > albums.albums.length, "album endpoint should be paginated");
  assert.equal(albums.albums.length, 40);
  assert.equal(albums.limit, 40);
  assert.equal(albums.offset, 0);
  assert.ok(albums.hasMore);
  assert.equal(albums.languages.find((item) => item.name === "中文")?.albumCount, albums.total, "album language counts should match the browser total");
  assert.ok(albumMs < 500, `album page should finish under 500 ms (actual ${albumMs.toFixed(1)} ms)`);
  const nextAlbums = store.listAlbums(new URL("http://localhost/api/music/albums?language=中文&sort=title&limit=40&offset=40"));
  assert.equal(nextAlbums.albums.length, 40);
  assert.notEqual(nextAlbums.albums[0]?.id, albums.albums[0]?.id, "album pages should advance by offset");
  const albumSearch = store.listAlbums(new URL("http://localhost/api/music/albums?language=中文&q=周杰伦&sort=tracks&limit=40"));
  assert.ok(albumSearch.total > 0, "album search should match album artists");
  const selectedAlbum = albums.albums[0];
  const selectedAlbumTracks = store.listTracks(new URL(`http://localhost/api/music/tracks?album=${encodeURIComponent(selectedAlbum.id)}&language=中文&limit=20`));
  assert.ok(selectedAlbumTracks.albums.some((album) => album.id === selectedAlbum.id), "selected album must remain available outside the popular facet");
  assert.ok(selectedAlbumTracks.tracks.every((track) => track.albumId === selectedAlbum.id));

  const musicClientFiles = [
    "music-page.js",
    "actions.js",
    "api.js",
    "constants.js",
    "format.js",
    "player/engine.js",
    "prefs.js",
    "state.js",
    "views/components.js",
    "views/home.js"
  ];
  const musicClientSources = Object.fromEntries(musicClientFiles.map((relativePath) => [
    relativePath,
    fs.readFileSync(path.join(root, "public", "modules", "music", ...relativePath.split("/")), "utf8")
  ]));
  const webClient = musicClientFiles.map((relativePath) => musicClientSources[relativePath]).join("\n");
  const musicFoundation = fs.readFileSync(path.join(root, "public", "modules", "music", "styles", "foundation.css"), "utf8");
  const musicLibraryStyles = fs.readFileSync(path.join(root, "public", "modules", "music", "styles", "library.css"), "utf8");
  const musicPlayerStyles = fs.readFileSync(path.join(root, "public", "modules", "music", "styles", "player.css"), "utf8");
  const standaloneHost = fs.readFileSync(path.join(root, "public", "js", "standalone-host.js"), "utf8");
  const androidClient = fs.readFileSync(path.join(root, "android-client", "www", "modules", "music", "music-views.js"), "utf8");
  const musicRuntime = fs.readFileSync(path.join(root, "src", "modules", "music", "server", "runtime.js"), "utf8");
  const musicServerFiles = fs.readdirSync(path.join(root, "src", "modules", "music", "server"))
    .filter((name) => name.endsWith(".js"))
    .sort();
  const musicStoreSource = musicServerFiles
    .map((name) => fs.readFileSync(path.join(root, "src", "modules", "music", "server", name), "utf8"))
    .join("\n");
  const webPageSource = musicClientSources["music-page.js"];
  const webActionsSource = musicClientSources["actions.js"];
  const webPlayerSource = musicClientSources["player/engine.js"];
  const webConstantsSource = musicClientSources["constants.js"];
  const webFormatSource = musicClientSources["format.js"];

  assert.match(webPageSource, /createMusicActions\(\{ state, api: musicApi, player, view, router, showError \}\)/, "the Web page must stay a composition root");
  assert.doesNotMatch(webPageSource, /new Audio\(/, "the Web composition root must not own the audio element");
  assert.match(webPlayerSource, /new Audio\(\)/, "the player engine must own the audio element");
  assert.match(webConstantsSource, /MUSIC_PAGE_LIMIT = 120/);
  assert.match(webConstantsSource, /MUSIC_ARTIST_PAGE_LIMIT = 80/);
  assert.match(webConstantsSource, /MUSIC_ALBUM_PAGE_LIMIT = 80/);
  assert.match(webConstantsSource, /MUSIC_VISUALIZER_FRAME_MS = 50/);
  assert.match(webFormatSource, /duplicateCount: group\.tracks\.length/);
  assert.match(webActionsSource, /collapseDuplicateTracks\(mergedRawTracks\)/);
  assert.match(webActionsSource, /rawLoaded: mergedRawTracks\.length/);
  assert.match(webActionsSource, /const generation = \+\+trackOpenGeneration;\s*trackOpenController\?\.abort\(\);/, "a newer track request should cancel the previous request");
  assert.match(webActionsSource, /api\.getTrack\(trackId, musicListParams\(\), controller\.signal\)/, "track detail requests should be abortable");
  assert.match(webActionsSource, /controller\.signal\.aborted \|\| generation !== trackOpenGeneration/, "stale track responses must not replace the latest selection");
  assert.match(webActionsSource, /pendingProgressRecord = record;[\s\S]*?if \(progressTimer\) return;/, "time updates should reuse one pending progress snapshot");
  assert.match(webActionsSource, /api\.setProgress\(record\.trackId/, "progress writes must use the captured track id");
  assert.match(webActionsSource, /view\.appendArtistPage\([\s\S]*?view\.appendAlbumPage\([\s\S]*?view\.appendLibraryTrackPage\(/, "pagination must delegate bounded DOM appends to the view");
  assert.match(webActionsSource, /!appendedInPlace && !view\.refreshMusicLibraryContent\(\)/, "completed searches must prefer a local library refresh");
  assert.match(webPageSource, /function refreshMusicLibraryContent\([\s\S]*?currentPanel\.replaceWith\(nextPanel\);\s*refreshLibrarySidebars\(\)/, "search results should replace only the central panel and sidebar facets");
  assert.match(webPageSource, /captureMusicInputFocus\(\)[\s\S]*?restoreMusicInputFocus\(nextPanel, inputFocus\)/, "local refresh must preserve search focus and selection");
  assert.match(webPageSource, /function appendLibraryTrackPage\([\s\S]*?document\.createDocumentFragment\(\)[\s\S]*?table\.append\(fragment\)/, "track pagination must append one fragment");
  assert.match(webPageSource, /function appendArtistPage\([\s\S]*?document\.createDocumentFragment\(\)[\s\S]*?grid\.append\(fragment\)/, "artist pagination must append one fragment");
  assert.match(webPageSource, /function appendAlbumPage\([\s\S]*?document\.createDocumentFragment\(\)[\s\S]*?grid\.append\(fragment\)/, "album pagination must append one fragment");
  assert.match(webPlayerSource, /audio\.addEventListener\("pause", \(\) => \{[\s\S]*?stopVisualizer\(\{ draw: true \}\)/, "pausing playback should stop the visualizer loop");
  assert.match(webPlayerSource, /!audio \|\| audio\.paused \|\| document\.hidden/, "the visualizer must stop while paused or hidden");
  assert.match(webPlayerSource, /visualizerBins = new Uint8Array\(audioAnalyser\.frequencyBinCount\)/, "the visualizer should reuse its frequency buffer");
  assert.match(webPlayerSource, /mediaSessionPositionSecond !== positionSecond/, "Media Session position updates should be limited to once per second");
  assert.match(webPlayerSource, /function installVisibilityHandler\([\s\S]*?callbacks\.onSaveProgress/, "backgrounding the page must flush progress");
  assert.match(webPageSource, /let musicTrackElementMap = new Map\(\);\s*let openingTrackElementId = "";/, "music rows should keep a bounded id-to-element index");
  assert.match(webPageSource, /let activeLyricElement = null;\s*let lyricRaf = 0;/, "the music view must own its lyric animation frame state");
  assert.match(musicPlayerStyles, /\.music-track-row:not\(\.head\)\s*\{\s*content-visibility:/, "long music rows should skip offscreen rendering");
  assert.match(musicPlayerStyles, /\.music-queue-row\s*\{[\s\S]*?content-visibility:/, "large queue rows should skip offscreen rendering");
  assert.match(musicLibraryStyles, /\.music-artist-browser-card\s*\{[\s\S]*?content-visibility:/, "large artist grids should isolate offscreen cards");
  assert.match(musicLibraryStyles, /\.music-album-browser-card\s*\{[\s\S]*?content-visibility:/, "large album grids should isolate offscreen cards");
  assert.ok(webPageSource.split(/\r?\n/).length <= 2600, "the Web music composition root must stay below 2600 lines");
  assert.ok(webActionsSource.split(/\r?\n/).length <= 1200, "music actions must stay below 1200 lines");
  assert.ok(webPlayerSource.split(/\r?\n/).length <= 600, "music player engine must stay below 600 lines");
  for (const serverFile of musicServerFiles) {
    const source = fs.readFileSync(path.join(root, "src", "modules", "music", "server", serverFile), "utf8");
    assert.ok(source.split(/\r?\n/).length <= 1200, `music server part must stay below 1200 lines: ${serverFile}`);
  }
  assertNoRelativeImportCycles(path.join(root, "src", "modules", "music", "server"));
  assertNoRelativeImportCycles(path.join(root, "public", "modules", "music"));

  assert.match(standaloneHost, /musicTrackId:\s*state\.music\.trackPageOpen \? state\.music\.current\?\.id \|\| "" : ""/, "the current song must not turn a library route into a track-page route");
  assert.match(standaloneHost, /page\.enter\(\{ skipRoute: true, deferInitialLoad: true \}\);\s*await page\.openRouteTarget\(next\);/, "music route restoration should let openRouteTarget own the single initial data load");
  assert.match(androidClient, /DEFAULT_LIMIT = 80/);
  assert.match(androidClient, /music-mobile-load-more/);
  assert.match(androidClient, /music-mobile-artist-browser/);
  assert.match(androidClient, /music-mobile-album-browser/);
  assert.match(androidClient, /匹配度/);
  assert.match(androidClient, /collapseDuplicateTracks\(rawTracks\)/);
  assert.match(androidClient, /duplicateCount: group\.tracks\.length/);
  assert.match(androidClient, /rawLoaded: rawTracks\.length/);
  assert.match(androidClient, /const searchFocused = Boolean\(state\.searchOpen \|\| state\.query\)/);
  assert.match(androidClient, /if \(!searchFocused\) shell\.append\(renderFacetFilters\(\)\)/);
  assert.match(androidClient, /enterkeyhint/);
  assert.match(androidClient, /hasOwnProperty\.call\(patch, "language"\)/);
  assert.match(musicRuntime, /MUSIC_STREAM_CHUNK_BYTES = 2 \* 1024 \* 1024/);
  assert.match(musicRuntime, /maxRangeBytes: MUSIC_STREAM_CHUNK_BYTES/, "music streaming should cap open-ended byte ranges");
  assert.match(musicStoreSource, /music_search_short_vocab USING fts5vocab/, "short search totals should come from the FTS vocabulary instead of rescanning tracks");
  assert.match(musicStoreSource, /rank MATCH 'bm25\(0,10,6,3,1,0\.5\)'/, "short search should let FTS stream results in weighted relevance order");

  const albumRoute = routeFromUrl("http://localhost/music/albums?language=中文&q=现场&sort=tracks");
  assert.equal(albumRoute.musicMode, "albums");
  assert.equal(albumRoute.musicLanguage, "中文");
  assert.equal(albumRoute.musicQuery, "现场");
  assert.equal(albumRoute.musicSort, "album");
  assert.equal(albumRoute.musicAlbumSort, "tracks");
  assert.equal(routeUrl(albumRoute, { initialParams: new URLSearchParams(), hash: "" }), "/music/albums?q=%E7%8E%B0%E5%9C%BA&language=%E4%B8%AD%E6%96%87&sort=tracks");
  const androidAlbumUrl = routeUrl(albumRoute, {
    initialParams: new URLSearchParams("client=android&returnTo=capacitor%3A%2F%2Flocalhost%2F"),
    hash: ""
  });
  assert.equal((androidAlbumUrl.match(/\?/g) || []).length, 1, "music catalog routes must compose one query string");
  const androidAlbumParams = new URL(androidAlbumUrl, "http://localhost").searchParams;
  assert.equal(androidAlbumParams.get("client"), "android");
  assert.equal(androidAlbumParams.get("returnTo"), "capacitor://localhost/");
  assert.equal(androidAlbumParams.get("q"), "现场");
  assert.equal(androidAlbumParams.get("language"), "中文");
  assert.equal(androidAlbumParams.get("sort"), "tracks");

  console.log(JSON.stringify({
    ok: true,
    tracks: summary.totals.tracks,
    artists: summary.totals.artists,
    pageMs: Number(pageMs.toFixed(2)),
    searchMs: Number(searchMs.toFixed(2)),
    shortSearchMs: Number(shortSearchMs.toFixed(2)),
    broadSingleSearchMs: Number(broadSingleSearchMs.toFixed(2)),
    combinedSearchMs: Number(combinedSearchMs.toFixed(2)),
    albumMs: Number(albumMs.toFixed(2)),
    pageBytes: Buffer.byteLength(JSON.stringify(page)),
    chineseArtists: artists.total,
    chineseAlbums: albums.total,
    languages: summary.languages.map((item) => ({ name: item.name, tracks: item.trackCount }))
  }, null, 2));
} finally {
  store.invalidate();
}

function assertNoRelativeImportCycles(directory) {
  const files = fs.readdirSync(directory, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".js"))
    .map((entry) => path.join(entry.parentPath, entry.name));
  const fileSet = new Set(files.map((filePath) => path.resolve(filePath)));
  const graph = new Map(files.map((filePath) => {
    const source = fs.readFileSync(filePath, "utf8");
    const dependencies = [...source.matchAll(/(?:from\s*|import\s*\()(["'])(\.\.?\/[^"']+)\1/g)]
      .map((match) => {
        let target = path.resolve(path.dirname(filePath), match[2].split("?")[0]);
        if (!path.extname(target)) target += ".js";
        return target;
      })
      .filter((target) => fileSet.has(target));
    return [path.resolve(filePath), dependencies];
  }));
  const visited = new Set();
  const active = new Set();
  const stack = [];

  function visit(filePath) {
    if (active.has(filePath)) {
      const cycle = [...stack.slice(stack.indexOf(filePath)), filePath]
        .map((item) => path.basename(item))
        .join(" -> ");
      assert.fail(`music module imports must stay acyclic: ${cycle}`);
    }
    if (visited.has(filePath)) return;
    visited.add(filePath);
    active.add(filePath);
    stack.push(filePath);
    for (const dependency of graph.get(filePath) || []) visit(dependency);
    stack.pop();
    active.delete(filePath);
  }

  for (const filePath of graph.keys()) visit(filePath);
}
