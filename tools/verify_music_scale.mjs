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
  const appClient = fs.readFileSync(path.join(root, "public", "app.js"), "utf8");
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

  // Keep the old monolith assertions available for older checkouts. The modular
  // checkout above is verified through its actual file boundaries instead.
  if (!musicClientSources["actions.js"]) {
  const openingStateStart = webClient.indexOf("  function setTrackOpeningState(");
  const openingStateEnd = webClient.indexOf("\n  function ", openingStateStart + 10);
  const openingStateSource = webClient.slice(openingStateStart, openingStateEnd);
  const openTrackStart = webClient.indexOf("  async function openTrack(");
  const openTrackEnd = webClient.indexOf("\n  function openTrackFromList", openTrackStart + 10);
  const openTrackSource = webClient.slice(openTrackStart, openTrackEnd);
  const contentRefreshStart = webClient.indexOf("  function refreshMusicLibraryContent(");
  const contentRefreshEnd = webClient.indexOf("\n  function ", contentRefreshStart + 10);
  const contentRefreshSource = webClient.slice(contentRefreshStart, contentRefreshEnd);
  const sidebarKeyStart = webClient.indexOf("  function musicSidebarRenderKey(");
  const sidebarKeyEnd = webClient.indexOf("\n  function ", sidebarKeyStart + 10);
  const sidebarKeySource = webClient.slice(sidebarKeyStart, sidebarKeyEnd);
  const renderStatsStart = webClient.indexOf("  function renderStats(");
  const renderStatsEnd = webClient.indexOf("\n  function ", renderStatsStart + 10);
  const renderStatsSource = webClient.slice(renderStatsStart, renderStatsEnd);
  assert.match(webClient, /MUSIC_PAGE_LIMIT = 120/);
  assert.match(webClient, /music-load-more/);
  assert.match(webClient, /music-artist-browser/);
  assert.match(webClient, /MUSIC_ARTIST_PAGE_LIMIT = 80/);
  assert.match(webClient, /MUSIC_ALBUM_PAGE_LIMIT = 80/);
  assert.match(webClient, /music-album-browser/);
  assert.doesNotMatch(webClient, /function renderSearchPage\(/, "the removed standalone search page must not bring back a second music brand and visual system");
  assert.doesNotMatch(webClient, /textContent = "FanHao"/, "the music UI must not render a redundant FanHao brand label");
  assert.doesNotMatch(musicFoundation, /music-search-page|music-search-layer/, "the unified music shell should not retain the old standalone light search theme");
  assert.match(webClient, /sidebarSection\("语种", languageList, \{\s*open: state\.music\.language !== "all"/, "the active language filter should expand automatically without lengthening the default sidebar");
  assert.match(webClient, /\(state\.music\.artists \|\| \[\]\)\.slice\(0, 8\)/, "the sidebar should keep only a compact artist preview");
  assert.match(webClient, /\(state\.music\.albums \|\| \[\]\)\.slice\(0, 6\)/, "the sidebar should keep only a compact album preview");
  assert.match(webClient, /sidebarBrowseButton\("查看全部歌手"/, "the compact artist preview should link to the paginated browser");
  assert.match(webClient, /sidebarBrowseButton\("查看全部专辑"/, "the compact album preview should link to the paginated browser");
  assert.match(musicFoundation, /--music-panel:\s*rgba\(255, 255, 255, \.055\)/, "music browser cards should use the module's dark panel surface");
  assert.match(musicFoundation, /--accent:\s*#3eda93/, "music browser controls should use a readable accent on dark surfaces");
  assert.match(webClient, /按匹配度/);
  assert.match(webClient, /dataset\.musicControlIcon === normalizedIcon/, "desktop player should not recreate the SVG icon on every progress update");
  assert.match(webClient, /MUSIC_VISUALIZER_FRAME_MS = 50/, "the visualizer should cap expensive canvas drawing at 20 fps");
  assert.match(webClient, /audio\.addEventListener\("pause", \(\) => \{[\s\S]*?stopMusicVisualizer\(\{ draw: true \}\)/, "pausing playback should stop the visualizer loop");
  assert.match(webClient, /!audio \|\| audio\.paused \|\| document\.hidden/, "the visualizer should not run while paused or hidden");
  assert.match(webClient, /visualizerBins = new Uint8Array\(audioAnalyser\.frequencyBinCount\)/, "the visualizer should reuse its frequency buffer");
  assert.match(webClient, /visualizerCanvas\.dataset\.visualizerRunning = "false"/, "the visualizer should expose a stopped state for runtime verification");
  assert.match(webClient, /state\.activeView !== "music" \|\| !visualizerCanvas\?\.isConnected/, "the visualizer loop should stop outside the music view or after its canvas detaches");
  assert.match(webClient, /function drawMusicVisualizer\([\s\S]*?state\.activeView !== "music" \|\| !canvas\?\.isConnected/, "detached visualizer canvases should never be drawn");
  assert.match(webClient, /mediaSessionPositionSecond !== positionSecond/, "Media Session position updates should be limited to once per second");
  assert.match(webClient, /MUSIC_PROGRESS_SAVE_INTERVAL_MS = 10000/, "continuous playback progress should be saved at a low fixed frequency");
  assert.match(webClient, /pendingProgressRecord = record;[\s\S]*?if \(progressTimer\) return;/, "time updates should refresh one pending snapshot instead of resetting the timer");
  assert.match(webClient, /encodeURIComponent\(record\.trackId\)/, "progress writes must use the captured track id rather than whichever track is current later");
  assert.match(webClient, /audio\.addEventListener\("pause", \(\) => \{[\s\S]*?saveProgressSoon\(null, \{ immediate: true \}\)/, "pausing should immediately flush the current position");
  assert.match(webClient, /audio\.addEventListener\("ended", \(\) => \{[\s\S]*?saveProgressSoon\(0, \{ immediate: true \}\)/, "finishing should immediately persist the reset position");
  assert.match(webClient, /state\.music\.current\.id !== trackId\) \{\s*saveProgressSoon\(null, \{ immediate: true \}\)/, "switching tracks should flush the old track before replacing it");
  assert.match(webClient, /if \(document\.hidden\) \{\s*saveProgressSoon\(null, \{ immediate: true \}\)/, "backgrounding the page should immediately persist playback progress");
  assert.match(webClient, /const generation = \+\+trackOpenGeneration;\s*trackOpenController\?\.abort\(\);/, "a newer track request should cancel the previous request");
  assert.match(webClient, /api\(`\/api\/music\/tracks\/\$\{encodeURIComponent\(trackId\)\}[\s\S]*?\{ signal: controller\.signal \}\)/, "track detail requests should be abortable");
  assert.match(webClient, /controller\.signal\.aborted \|\| generation !== trackOpenGeneration/, "stale track responses must not replace the latest selection");
  assert.match(webClient, /state\.music\.current\?\.id === trackId && audio\?\.src[\s\S]*?return state\.music\.current;/, "selecting the current track should resume it without refetching and rebuilding the library");
  assert.match(webClient, /state\.music\.status = "正在打开歌曲";\s*setTrackOpeningState\(trackId\);\s*let data;/, "opening a track should use a lightweight in-place loading state instead of a full pre-request render");
  assert.match(webClient, /let musicTrackElementMap = new Map\(\);\s*let openingTrackElementId = "";/, "music rows should keep a bounded id-to-element index for hot-path updates");
  assert.match(openingStateSource, /affectedTrackIds = new Set\([\s\S]*?musicTrackElementMap\.get\(affectedTrackId\)/, "opening state should touch only the previous and requested track ids");
  assert.doesNotMatch(openingStateSource, /querySelectorAll/, "opening a track must not scan every mounted music row");
  assert.match(webClient, /function trackRow\([\s\S]*?registerMusicTrackElement\(row, track\.id\)/, "library rows should register in the track element index");
  assert.match(webClient, /function queueRow\([\s\S]*?registerMusicTrackElement\(row, track\.id\)/, "queue rows should register in the track element index");
  assert.match(webClient, /unregisterMusicTrackElements\(queuePanel\);\s*queuePanel\.replaceWith\(renderQueuePanel\(\)\)/, "queue replacement should unregister detached track elements");
  assert.match(webClient, /element\.dataset\.musicTrackId = trackId/, "registered track and queue rows should expose the in-place loading target");
  assert.match(webClient, /playbackButtonEls = \[\];[\s\S]*?currentTrackIndicatorMap = new Map\(\);[\s\S]*?playbackSurfaceEls = \[\];/, "each render should rebuild bounded playback references and a fresh track indicator index");
  assert.match(webClient, /play\.textContent = state\.music\.playing \? "暂停" : "播放";[\s\S]*?registerPlaybackButton\(play, "text"\)/, "the right-side play button should join the shared playback state channel");
  assert.match(webClient, /registerPlaybackButton\(playButton, "icon"\)/, "icon play controls should join the shared playback state channel");
  assert.match(webClient, /registerCurrentTrackIndicator\(number, track\.id, numberLabel, "Ⅱ"\)/, "the active library row should reflect play and pause without rebuilding the table");
  assert.match(webClient, /currentTrackIndicatorMap\.get\(trackId\) \|\| \[\][\s\S]*?currentTrackIndicatorMap\.set\(trackId, indicators\)/, "track indicators should be indexed by track id");
  assert.match(webClient, /for \(const indicator of currentTrackIndicatorMap\.get\(currentTrackId\) \|\| \[\]\)/, "playback updates should visit only the current track indicators regardless of list length");
  assert.doesNotMatch(webClient, /for \(const indicator of currentTrackIndicatorEls\)/, "playback must not scan every loaded track row");
  assert.match(webClient, /DESKTOP_QUEUE_PAGE_SIZE = 120/, "expanded desktop queues should render in bounded pages");
  assert.match(webClient, /function appendExpandedQueueRows\([\s\S]*?queue\.slice\(0, limit\)\.forEach/, "expanding a queue should render only the first queue page");
  assert.match(webClient, /function appendNextQueuePage\([\s\S]*?document\.createDocumentFragment\(\)[\s\S]*?index = oldLimit; index < nextLimit[\s\S]*?list\.append\(fragment\)/, "queue pagination should append only the next page in one fragment");
  assert.match(webClient, /currentIndex >= limit[\s\S]*?queueContextCurrent/, "the current song should remain reachable when it falls outside the rendered queue page");
  assert.match(webClient, /function queueCountText\([\s\S]*?已显示/, "expanded queues should report how many rows are currently displayed");
  assert.match(musicPlayerStyles, /\.music-queue-load-more/, "expanded queues should expose a styled incremental load control");
  assert.match(musicPlayerStyles, /\.music-track-row:not\(\.head\)\s*\{\s*content-visibility: auto;\s*contain-intrinsic-size: auto 52px;/, "offscreen track rows should skip layout and painting while retaining stable scroll height");
  assert.match(musicPlayerStyles, /\.music-queue-row\s*\{[\s\S]*?content-visibility: auto;\s*contain-intrinsic-size: auto 34px;/, "expanded queues should skip rendering offscreen rows");
  assert.match(musicLibraryStyles, /\.music-artist-browser-card\s*\{[\s\S]*?content-visibility: auto;\s*contain-intrinsic-size: auto 66px;/, "offscreen artist cards should use intrinsic layout containment");
  assert.match(musicLibraryStyles, /\.music-album-browser-card\s*\{[\s\S]*?content-visibility: auto;\s*contain-intrinsic-size: auto 76px;/, "offscreen album cards should use intrinsic layout containment");
  assert.match(webClient, /panel\.dataset\.musicTrackId = track\?\.id \|\| ""/, "the right player panel should expose which summary can be retained during queue-only updates");
  assert.match(webClient, /function refreshQueueSurface\([\s\S]*?queuePanel\.replaceWith\(renderQueuePanel\(\)\)/, "queue changes should replace only the queue panel while its current-track summary remains valid");
  assert.match(webClient, /function appendTrackToQueue\([\s\S]*?refreshQueueSurface\(\);\s*}/, "adding a track should not rebuild the full music view");
  assert.match(webClient, /function moveQueueTrack\([\s\S]*?refreshQueueSurface\(\);[\s\S]*?persistPlaylistQueueOrder/, "queue reordering should update the queue surface before persisting playlist order");
  assert.match(webClient, /function removeTrackFromQueue\([\s\S]*?refreshQueueSurface\(\);\s*}/, "removing a track should not rebuild the full music view");
  assert.match(webClient, /function clearQueueAfterCurrent\([\s\S]*?refreshQueueSurface\(\);\s*}/, "clearing the queue should use the bounded queue refresh path");
  assert.match(webClient, /function refreshPlaylistDialog\([\s\S]*?music-playlist-dialog-backdrop[\s\S]*?shell\.append\(renderPlaylistDialog\(\)\)/, "playlist dialogs should be overlaid without rebuilding the music shell");
  assert.match(webClient, /async function openPlaylistDialog\([\s\S]*?refreshPlaylistDialog\(\)[\s\S]*?await loadPlaylists\(\)[\s\S]*?refreshPlaylistDialog\(\)/, "the playlist dialog should open immediately and refresh only itself after playlist data arrives");
  assert.match(webClient, /function closePlaylistDialog\([\s\S]*?refreshPlaylistDialog\(\{ focus: false }\)[\s\S]*?returnFocus\.focus/, "closing the playlist dialog should remove only the overlay and restore focus");
  assert.match(webClient, /async function persistPlaylistQueueOrder\([\s\S]*?state\.music\.status = "歌单顺序已保存";\s*return data;/, "playlist order persistence should not trigger a second full render");
  assert.match(webClient, /function refreshLibrarySidebars\([\s\S]*?embedded\.replaceWith\(next\)[\s\S]*?drawer\.replaceWith\(next\)/, "playlist count changes should refresh only mounted sidebars");
  assert.match(webClient, /side\.dataset\.musicSidebarKey = musicSidebarRenderKey\(\)/, "rendered sidebars should expose their stable content signature");
  assert.match(webClient, /embedded\.dataset\.musicSidebarKey !== renderKey[\s\S]*?drawer\.dataset\.musicSidebarKey !== renderKey/, "sidebars should be retained while their visible content signature is unchanged");
  assert.match(sidebarKeySource, /state\.music\.language[\s\S]*?state\.music\.artistId[\s\S]*?itemKey\(state\.music\.playlists\)[\s\S]*?itemKey\(state\.music\.albums, 6\)/, "sidebar signatures should cover filters, counts, playlists, artists, and albums");
  assert.doesNotMatch(sidebarKeySource, /state\.music\.query|state\.music\.sort/, "typing and track sorting should not invalidate unchanged sidebar DOM");
  assert.match(renderStatsSource, /const renderKey = JSON\.stringify\(items\)[\s\S]*?dataset\.musicStatsKey === renderKey/, "music statistics should reuse mounted cards while their displayed values are unchanged");
  assert.match(renderStatsSource, /mountedStats\.length === items\.length[\s\S]*?every\(\(item\) => item\.classList\.contains\("music-stat"\)\)/, "statistics reuse should reject cards left by another module");
  assert.match(renderStatsSource, /dataset\.musicStatsKey = renderKey;\s*els\.statsRow\.innerHTML = "";/, "changed statistics should update their signature before rebuilding cards");
  assert.match(webClient, /function refreshLibraryDrawer\([\s\S]*?music-library-layer[\s\S]*?aria-expanded[\s\S]*?layout\.append\(renderLibraryDrawer\(\)\)/, "the responsive library drawer should toggle only its overlay and launcher state");
  assert.match(webClient, /function openLibraryDrawer\(\)[\s\S]*?refreshLibraryDrawer\(\{ focus: true }\)/, "opening the library drawer should preserve the mounted list");
  assert.match(webClient, /function closeLibraryDrawer\(\)[\s\S]*?refreshLibraryDrawer\(\{ focus: true }\)/, "closing the library drawer should preserve the mounted list");
  assert.match(webClient, /sleepTimerControlEls = \[\];[\s\S]*?lyricLineEls = \[\];/, "each render should keep only the mounted sleep timer controls");
  assert.match(webClient, /sleepTimerControlEls\.push\(\{ select, status \}\)/, "sleep timer controls should register for local countdown updates");
  assert.match(webClient, /sleepTimerInterval = window\.setInterval\([\s\S]*?updateSleepTimerUi\(\);[\s\S]*?\}, 30000\)/, "sleep countdown ticks should update only their controls");
  assert.match(webClient, /function expireSleepTimer\([\s\S]*?state\.music\.status = "睡眠定时已暂停播放";\s*updateSleepTimerUi\(\);/, "sleep timer expiry should not rebuild the music page");
  assert.match(webClient, /function updateSleepTimerUi\([\s\S]*?for \(const \{ select, status \} of sleepTimerControlEls\)/, "sleep timer UI updates should stay bounded to mounted controls");
  assert.match(webClient, /playbackSurfaceEls = \[\];[\s\S]*?playbackErrorEls = \[\];[\s\S]*?sleepTimerControlEls = \[\];/, "each render should keep only mounted playback error nodes");
  assert.match(webClient, /audio\.addEventListener\("error", \(\) => \{\s*setPlaybackError\([\s\S]*?updatePlaybackUi\(\);\s*\}\);/, "audio element errors should update the player locally");
  assert.match(webClient, /audio\.play\(\)\.catch\(\(error\) => \{\s*setPlaybackError\([\s\S]*?updatePlaybackUi\(\);\s*\}\);/, "rejected playback should not rebuild the music page");
  assert.match(webClient, /function createPlaybackErrorElement\([\s\S]*?playbackErrorEls\.push\(error\)/, "player surfaces should register inline error status elements");
  assert.match(webClient, /function setPlaybackError\([\s\S]*?for \(const error of playbackErrorEls\)/, "playback errors should update only mounted player status elements");
  assert.match(musicPlayerStyles, /\.music-player-error\[hidden\]/, "inline playback errors should remain hidden when playback is healthy");
  assert.match(webClient, /playbackErrorEls = \[\];[\s\S]*?shuffleControlEls = \[\];[\s\S]*?repeatControlEls = \[\];[\s\S]*?sleepTimerControlEls = \[\];/, "each render should keep only mounted playback mode controls");
  assert.match(webClient, /registerShuffleControl\(controlButton\("随机", toggleShuffleMode/, "shuffle buttons should use the local playback-mode updater");
  assert.match(webClient, /registerRepeatControl\(controlButton\(repeatLabel\(state\.music\.repeat\), cycleRepeatMode/, "repeat buttons should use the local playback-mode updater");
  assert.match(webClient, /function toggleShuffleMode\(\) \{\s*state\.music\.shuffle = !state\.music\.shuffle;\s*writeShufflePreference\([\s\S]*?updatePlaybackModeControls\(\);\s*\}/, "shuffle changes should not rebuild the page");
  assert.match(webClient, /function cycleRepeatMode\(\) \{\s*state\.music\.repeat = nextRepeat[\s\S]*?updatePlaybackModeControls\(\);\s*\}/, "repeat changes should not rebuild the page");
  assert.match(webClient, /function updatePlaybackModeControls\([\s\S]*?aria-pressed[\s\S]*?dataset\.repeatMode/, "playback mode controls should update visible and accessible state together");
  assert.match(webClient, /let suggestController = null;\s*let suggestionCache = new Map\(\);/, "music suggestions should keep one active request and a session cache");
  assert.match(webClient, /function queueMusicSuggest\([\s\S]*?suggestController\?\.abort\(\);[\s\S]*?suggestionCache\.get\([\s\S]*?return;/, "typing should cancel stale suggestions and reuse cached queries before scheduling work");
  assert.match(webClient, /const MUSIC_LIBRARY_SEARCH_DEBOUNCE_MS = 220;/, "library search should react well before the previous half-second delay");
  assert.match(webClient, /const MUSIC_CATALOG_SEARCH_DEBOUNCE_MS = 180;/, "artist and album filters should use the faster catalog delay");
  assert.match(webClient, /Array\.from\(normalized\)\.length < MUSIC_SUGGEST_MIN_CHARACTERS/, "short searches should update the main list without starting a second expensive suggestion scan");
  assert.match(webClient, /state\.music\.query \? MUSIC_LIBRARY_SEARCH_DEBOUNCE_MS : MUSIC_LIBRARY_CLEAR_DEBOUNCE_MS/, "library search should use a short adaptive debounce and clear stale results quickly");
  assert.ok((webClient.match(/MUSIC_CATALOG_SEARCH_DEBOUNCE_MS/g) || []).length >= 3, "artist and album search should share the faster catalog debounce");
  assert.match(webClient, /api\(`\/api\/music\/suggest\?q=[\s\S]*?\{ signal: controller\.signal \}\)/, "suggestion requests should be abortable");
  assert.match(webClient, /if \(controller\.signal\.aborted\) return;[\s\S]*?rememberSuggestionCache\(key, suggestions\)/, "aborted suggestion responses must not enter the cache");
  assert.match(webClient, /while \(suggestionCache\.size > 24\)/, "the suggestion cache should remain bounded");
  assert.match(webClient, /search\.dataset\.musicSearch = "artists"/, "artist search should expose a stable focus key");
  assert.match(webClient, /search\.dataset\.musicSearch = "albums"/, "album search should expose a stable focus key");
  assert.match(webClient, /input\.dataset\.musicSearch = "library"/, "track search should expose a stable focus key");
  assert.match(webClient, /const inputFocus = captureMusicInputFocus\(\);[\s\S]*?restoreMusicInputFocus\(shell, inputFocus\);/, "music renders should restore the focused search after replacing the view");
  assert.match(webClient, /function captureMusicInputFocus\([\s\S]*?selectionStart[\s\S]*?selectionEnd/, "search focus capture should preserve the caret selection");
  assert.match(webClient, /function restoreMusicInputFocus\([\s\S]*?focus\(\{ preventScroll: true \}\)[\s\S]*?setSelectionRange/, "search focus restoration should avoid scroll jumps and restore the caret");
  assert.match(webClient, /updateMediaSession\(duration, current\);\s*updatePlaybackControls\(playing\);\s*if \(state\.activeView !== "music" \|\| !currentProgressEls\?\.current\?\.isConnected\) return;/, "detached progress controls should not receive playback-time DOM writes");
  assert.match(webClient, /surface\.classList\.toggle\("playing", playing\)/, "the single-track surface should follow the real audio state");
  assert.match(webClient, /function renderPlayerBar\(\) \{\s*const track = state\.music\.current \|\| state\.music\.queue\[0\] \|\| null;/, "the bottom player and right panel should expose the same ready-to-play track before playback starts");
  assert.match(webClient, /lyricLineEls = \[\];[\s\S]*?lyricFollowButtonEls = \[\];[\s\S]*?activeLyricElement = null;/, "lyric rendering should keep bounded references for the current page only");
  assert.match(webClient, /if \(state\.activeView !== "music" \|\| lyricRaf \|\| !lyricLineEls\[0\]\?\.isConnected\) return;/, "library and background playback should do no lyric scanning without a mounted lyric view");
  assert.match(webClient, /function findLyricIndex\([\s\S]*?while \(low <= high\)/, "lyric lookup should use binary search instead of scanning from the first line on every update");
  assert.match(webClient, /activeLyricElement\?\.classList\.remove\("active"\);[\s\S]*?nextActive\?\.classList\.add\("active"\)/, "lyric changes should touch only the previous and next active lines");
  assert.doesNotMatch(webClient, /document\.querySelectorAll\("\.music-lyric/, "lyric updates should not query the full document during playback");
  assert.match(webClient, /musicLoadController\?\.abort\(\);\s*const controller = new AbortController\(\);/, "a newer music list query should cancel the previous request");
  assert.match(webClient, /const request = \(path\) => api\(path, \{ signal: controller\.signal \}\)/, "music list requests should be abortable");
  assert.match(webClient, /if \(!els\.workGrid\?\.querySelector\?\.\("\.music-shell"\)\) renderView\(\);\s*setMusicListLoadingState\(true, \{ append \}\);/, "mounted music views should keep their current DOM while a new list loads");
  assert.doesNotMatch(webClient, /if \(!append\) renderView\(\)/, "search and filter requests must not rebuild the full page before fetching");
  assert.match(webClient, /controller\.signal\.aborted \|\| generation !== musicLoadGeneration/, "stale list results must not overwrite the newest search");
  assert.match(webClient, /function setMusicListLoadingState\([\s\S]*?music-list-loading-badge/, "list loading should use an in-place status indicator");
  assert.match(webClient, /renderStats\(\);\s*if \(!refreshMusicLibraryContent\(\)\) renderView\(\);/, "completed searches should refresh only the mounted library content when possible");
  assert.match(contentRefreshSource, /currentPanel\.replaceWith\(nextPanel\);\s*refreshLibrarySidebars\(\)/, "search results should replace only the central panel and sidebar facets");
  assert.match(contentRefreshSource, /captureMusicInputFocus\(\)[\s\S]*?restoreMusicInputFocus\(nextPanel, inputFocus\)/, "local result refresh should preserve search focus and selection");
  assert.match(contentRefreshSource, /mountedTrackId[\s\S]*?surfacedTrackId = state\.music\.current\?\.id \|\| state\.music\.queue\[0\]\?\.id[\s\S]*?refreshCurrentTrackSurfaces\(mountedTrackId\)/, "initial results and no-current searches should synchronize ready-to-play player surfaces");
  assert.doesNotMatch(contentRefreshSource, /renderNowPanel|renderPlayerBar/, "search result refresh must retain the right and bottom player surfaces");
  assert.match(musicPlayerStyles, /\.music-list-loading-badge/, "the lightweight list loading state should remain visible in the unified shell");
  assert.match(webClient, /if \(event\.key === "Enter" && state\.music\.mode === "library"\) \{\s*event\.preventDefault\(\);\s*window\.clearTimeout\(searchTimer\);/, "submitting search with Enter should cancel the pending debounced duplicate request");
  assert.match(webClient, /if \(!artistMode && !albumMode && !state\.music\.current\) state\.music\.queue = mergedTracks;/, "browsing should only refresh the ready-to-play queue before a track has been selected");
  assert.match(webClient, /function openTrackFromList\([\s\S]*?state\.music\.queue = source\.some\([\s\S]*?return openTrack\(item\.id, options\);/, "choosing a browse result should explicitly seed the queue from that list");
  assert.match(openTrackSource, /if \(state\.activeView === "music"\) \{\s*if \(shouldOpenPage \|\| !refreshCurrentTrackSurfaces\(previousTrackId\)\) renderView\(\);\s*}/, "ordinary playback should avoid a full render and background track changes should not touch another module");
  assert.doesNotMatch(openTrackSource, /renderStats\(\)/, "switching tracks should not rebuild unchanged library statistics");
  assert.match(webClient, /function refreshCurrentTrackSurfaces\([\s\S]*?nowPanel\.replaceWith\(nextNowPanel\);\s*playerBar\.replaceWith\(nextPlayerBar\);[\s\S]*?return true;/, "track changes should retain the library list while replacing only the right and bottom player surfaces");
  assert.match(webClient, /function updateBrowseTrackSelection\([\s\S]*?currentTrackIndicatorMap\.get\(previousTrackId\)[\s\S]*?currentTrackIndicatorMap\.get\(currentTrackId\)/, "track changes should update only the previous and current list indicators");
  assert.match(webClient, /function pruneDetachedPlaybackControls\([\s\S]*?playbackButtonEls = playbackButtonEls\.filter[\s\S]*?sleepTimerControlEls = sleepTimerControlEls\.filter/, "replacing player surfaces should discard detached control references");
  assert.match(webClient, /function toggleFavorite\([\s\S]*?trackMetadataRequiresReload\("favorite"\)[\s\S]*?else refreshTrackMetadata\(updated\)/, "ordinary favorite toggles should update metadata surfaces without rebuilding the list");
  assert.match(webClient, /function setTrackRating\([\s\S]*?trackMetadataRequiresReload\("rating"\)[\s\S]*?else refreshTrackMetadata\(updated\)/, "ordinary rating changes should update metadata surfaces without rebuilding the list");
  assert.match(webClient, /function trackMetadataRequiresReload\([\s\S]*?state\.music\.mode === "smart"[\s\S]*?state\.music\.favorite \|\| state\.music\.sort === "favorite"[\s\S]*?state\.music\.sort === "rating"/, "metadata changes should reload only when they can change list membership or ordering");
  assert.match(webClient, /function refreshTrackMetadata\([\s\S]*?currentTrackIndicatorMap\.get\(updated\.id\)[\s\S]*?secondary\.textContent = trackSecondaryText\(visibleTrack\)[\s\S]*?refreshCurrentTrackSurfaces\(updated\.id\)/, "metadata refresh should touch only matching rows and the current player surfaces");
  assert.match(webClient, /const surfacedTrackId = state\.music\.current\?\.id \|\| state\.music\.queue\[0\]\?\.id \|\| ""/, "metadata refresh should also update the ready-to-play first track before playback starts");
  assert.match(webClient, /function uniqueQueueTracks\([\s\S]*?seen\.has\(item\.id\)/, "queue seeding should remove duplicate track ids");
  assert.match(webClient, /row\.addEventListener\("click", \(\) => openTrackFromList\(track, state\.music\.data\?\.tracks \|\| \[\]/, "library rows should establish their visible list as the playback queue");
  assert.match(webClient, /function queueRow\([\s\S]*?openTrack\(track\.id, \{ autoplay: true \}\)/, "queue navigation must not rebuild the queue from browse results");
  assert.match(webClient, /Boolean\(state\.music\.current\)[\s\S]*?appendLibraryTrackPage\(incomingTracks, previousRawTracks\.length\)\);\s*if \(appendedInPlace\) return;/, "plain library pagination should append only the new page when playback is already established");
  assert.match(webClient, /function appendLibraryTrackPage\([\s\S]*?document\.createDocumentFragment\(\)[\s\S]*?tracks\.forEach\([\s\S]*?table\.append\(fragment\)/, "incremental pagination should build and append one fragment instead of rebuilding prior rows");
  assert.match(webClient, /const appendScrollTop = append[\s\S]*?if \(append\) restoreMusicPanelScroll\(appendScrollTop\);/, "pagination fallbacks should preserve the track panel scroll position");
  assert.match(webClient, /function renderTrackLoadMore\(trackCount\)/, "initial and incremental track pages should share one load-more control builder");
  assert.match(webClient, /const appendedInPlace = append && \(artistMode\s*\? appendArtistPage\(data\.artists \|\| \[\], previousArtists\.length\)\s*:\s*albumMode\s*\? appendAlbumPage\(data\.albums \|\| \[\], previousAlbums\.length\)/, "artist and album pagination should append in place");
  assert.match(webClient, /function renderArtistCard\(artist\)/, "initial and appended artist pages should share one card builder");
  assert.match(webClient, /function renderAlbumCard\(album\)/, "initial and appended album pages should share one card builder");
  assert.match(webClient, /function appendArtistPage\([\s\S]*?document\.createDocumentFragment\(\)[\s\S]*?grid\.append\(fragment\)/, "artist pagination should append one fragment without rebuilding earlier cards");
  assert.match(webClient, /function appendAlbumPage\([\s\S]*?document\.createDocumentFragment\(\)[\s\S]*?grid\.append\(fragment\)/, "album pagination should append one fragment without rebuilding earlier cards");
  assert.match(webClient, /MUSIC_SIDE_LIST_CACHE_MS = 60000/, "playlist side data should use a short refresh window");
  assert.match(webClient, /sideListCacheFresh\(state\.music\.playlistsLoadedAt\) \? Promise\.resolve\(\) : loadPlaylists/, "track queries should reuse fresh user playlists");
  assert.match(webClient, /sideListCacheFresh\(state\.music\.smartPlaylistsLoadedAt\) \? Promise\.resolve\(\) : loadSmartPlaylists/, "track queries should reuse fresh smart playlists");
  assert.match(webClient, /state\.music\.playlistsLoadedAt = Date\.now\(\)/, "successful playlist refreshes should update their cache timestamp");
  assert.match(webClient, /state\.music\.smartPlaylistsLoadedAt = Date\.now\(\)/, "successful smart playlist refreshes should update their cache timestamp");
  assert.match(webClient, /function sideListCacheFresh\([\s\S]*?MUSIC_SIDE_LIST_CACHE_MS/, "side list freshness should remain time bounded");
  assert.match(webClient, /collapseDuplicateTracks\(mergedRawTracks\)/);
  assert.match(webClient, /duplicateCount: group\.tracks\.length/);
  assert.match(webClient, /rawLoaded: mergedRawTracks\.length/);
  assert.match(webClient, /trackReturnContext = \{\s*route: musicRouteOverrides\(\),\s*scroll: captureLibraryScroll\(\)/, "opening the track page should remember its source route and scroll positions");
  assert.match(webClient, /returnContext\?\.route \|\| musicRouteOverrides\(\)/, "closing the track page should restore its source route");
  assert.match(webClient, /restoreLibraryScroll\(returnContext\?\.scroll\)/, "closing the track page should restore the library scroll positions");
  }
  assert.match(appClient, /musicTrackId:\s*state\.activeView === "music" && state\.music\.trackPageOpen/, "the current song must not turn a library route into a track-page route");
  assert.match(appClient, /setActiveView\("music", \{ skipRoute: true, deferInitialLoad: true \}\);\s*await musicPage\.openRouteTarget\(next\);/, "music route restoration should let openRouteTarget own the single initial data load");
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
  const files = fs.readdirSync(directory)
    .filter((name) => name.endsWith(".js"))
    .map((name) => path.join(directory, name));
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
      assert.fail(`music server imports must stay acyclic: ${cycle}`);
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
