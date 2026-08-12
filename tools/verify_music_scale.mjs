import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { createMusicStore } from "../src/modules/music/server/store.js";
import { ensureSchema } from "../src/modules/music/server/schema.js";
import { writeScanRecords } from "../src/modules/music/server/scan.js";
import {
  buildArtistLanguageConsensus,
  explicitMusicLanguageForArtist,
  musicLanguageForArtist
} from "../src/modules/music/server/language.js";
import {
  buildMusicIdentityKnowledge,
  resolveMusicTrackIdentity
} from "../src/modules/music/server/identity.js";
import { musicSearchValueMatch, phoneticSearchDocument, phoneticSearchFtsTerm } from "../src/modules/music/server/search.js";
import { createFileServer } from "../src/platform/server/file-server.js";
import { buildTrackVersionGroups, getTrackVersionInfo } from "../android-client/www/modules/music/track-versions.js";
import { selectTrackByVersionStrategy, shuffleTrackQueue } from "../android-client/www/modules/music/music-views.js";

globalThis.window = { location: { href: "http://localhost/", search: "", hash: "" } };
const { routeFromUrl, routeUrl } = await import("../public/js/router.js");

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
verifyMusicScaleFixtureCleanupSafety();
let fixture = null;
let store = null;

try {
  fixture = createMusicScaleFixture();
  store = createMusicStore({
    dbPath: fixture.dbPath,
    roots: [fixture.musicRoot]
  });
  const versionStrategyTracks = [
    { id: "original", title: "Belief", artist: "S.H.E", fileName: "Belief.mp3", sizeBytes: 8_000_000, bitDepth: 0, sampleRate: 44_100 },
    { id: "live", title: "Belief (Live)", artist: "S.H.E", fileName: "Belief (Live).flac", sizeBytes: 32_000_000, bitDepth: 24, sampleRate: 96_000 },
    { id: "remix", title: "Belief (Remix)", artist: "S.H.E", fileName: "Belief (Remix).flac", sizeBytes: 18_000_000, bitDepth: 16, sampleRate: 48_000 }
  ];
  assert.equal(selectTrackByVersionStrategy(versionStrategyTracks, "smart", versionStrategyTracks[2]).id, "remix");
  assert.equal(selectTrackByVersionStrategy(versionStrategyTracks, "original", versionStrategyTracks[2]).id, "original");
  assert.equal(selectTrackByVersionStrategy(versionStrategyTracks, "quality", versionStrategyTracks[0]).id, "live");
  assert.equal(selectTrackByVersionStrategy(versionStrategyTracks, "compact", versionStrategyTracks[1]).id, "original");
  const shuffledVersionTracks = shuffleTrackQueue(versionStrategyTracks, () => 0);
  assert.deepEqual(shuffledVersionTracks.map((track) => track.id), ["live", "remix", "original"]);
  assert.deepEqual(versionStrategyTracks.map((track) => track.id), ["original", "live", "remix"]);

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

  const versionGroups = buildTrackVersionGroups([
    { id: "belief-original", title: "Belief", artist: "S.H.E", album: "青春株式会社", durationMs: 271_040 },
    { id: "belief-live", title: "Belief(Live)", artist: "S.H.E", album: "_单曲", durationMs: 264_307 },
    { id: "belief-concert", title: "Belief（演唱会版）", artist: "S.H.E", album: "奇幻乐园演唱会", durationMs: 81_187 },
    { id: "belief-truth", title: "Belief(The Truth)", artist: "S.H.E", album: "_单曲", durationMs: 240_000 }
  ]);
  assert.equal(versionGroups.length, 2, "recognized version suffixes should group without absorbing unrelated bracketed titles");
  assert.deepEqual(versionGroups[0].tracks.map((track) => track.id), ["belief-original", "belief-live", "belief-concert"]);
  assert.equal(versionGroups[0].primary.id, "belief-original", "the original should lead a same-song version group");
  assert.equal(getTrackVersionInfo({ title: "Belief - Remix", artist: "S.H.E" }).label, "Remix");
  assert.equal(getTrackVersionInfo({ title: "Belief (Unplugged)", artist: "S.H.E" }).label, "不插电");
  assert.equal(getTrackVersionInfo({ title: "后来（现场版）", artist: "刘若英" }).baseTitle, "后来");
  assert.equal(buildTrackVersionGroups([
    { id: "unknown-a", title: "同名歌曲", artist: "未知歌手" },
    { id: "unknown-b", title: "同名歌曲", artist: "未知歌手" }
  ]).length, 2, "unknown artists should not be merged into a speculative version group");

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
  assert.equal(summary.totals?.tracks, fixture.trackCount, "music summary should count every fixture track");
  assert.equal(summary.totals?.artists, fixture.artistCount, "music summary should count every fixture artist");
  assert.equal(summary.totals?.albums, fixture.albumCount, "music summary should count every fixture album");
  assert.deepEqual(
    Object.fromEntries(summary.languages.map((item) => [item.name, item.trackCount])),
    fixture.languageTrackCounts,
    "music summary language counts should come only from the controlled fixture"
  );

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
  assert.match(phoneticSearchDocument("周杰伦"), /zhou jie lun/);
  assert.match(phoneticSearchDocument("周杰伦"), /zhoujielun/);
  assert.match(phoneticSearchDocument("周杰伦"), /zjl/);
  assert.match(phoneticSearchFtsTerm("zhou jie lun"), /zhou/);
  assert.deepEqual(musicSearchValueMatch("青花瓷", "qinghuaci").highlights, ["青花瓷"], "full pinyin should map back to visible Chinese title text");
  assert.deepEqual(musicSearchValueMatch("周杰伦", "zjl").highlights, ["周杰伦"], "initials should map back to visible Chinese artist text");
  store.listTracks(new URL("http://localhost/api/music/tracks?q=zhoujielun&limit=10"));
  const pinyinStartedAt = performance.now();
  const pinyinArtistSearch = store.listTracks(new URL("http://localhost/api/music/tracks?q=zhoujielun&limit=10"));
  const pinyinSearchMs = performance.now() - pinyinStartedAt;
  assert.equal(pinyinArtistSearch.searchMode, "phonetic");
  assert.ok(pinyinArtistSearch.tracks.slice(0, 5).some((track) => track.artist === "周杰伦"), "full pinyin should find the intended Chinese artist near the top");
  assert.ok(pinyinSearchMs < 300, `warm pinyin search should finish under 300 ms (actual ${pinyinSearchMs.toFixed(1)} ms)`);
  const initialArtistSearch = store.listTracks(new URL("http://localhost/api/music/tracks?q=zjl&limit=10"));
  assert.ok(initialArtistSearch.tracks.slice(0, 5).filter((track) => track.artist === "周杰伦").length >= 3, "artist initials should keep the intended popular artist near the top");
  const pinyinTitleSearch = store.listTracks(new URL("http://localhost/api/music/tracks?q=qinghuaci&limit=10"));
  assert.equal(pinyinTitleSearch.tracks[0]?.title, "青花瓷", "full title pinyin should rank the intended song first");
  assert.deepEqual(pinyinTitleSearch.tracks[0]?.searchMatch?.highlights?.title, ["青花瓷"], "track results should expose server-backed pinyin highlight terms");
  const homophoneTypoSearch = store.listTracks(new URL(`http://localhost/api/music/tracks?q=${encodeURIComponent("青花次")}&limit=10`));
  assert.equal(homophoneTypoSearch.tracks[0]?.title, "青花瓷", "a same-pinyin Chinese typo should recover the intended song");
  const pinyinTypoSearch = store.listTracks(new URL("http://localhost/api/music/tracks?q=zhoujieln&limit=10"));
  assert.equal(pinyinTypoSearch.correctedQuery, "zhoujielun", "a bounded Latin typo should expose its correction");
  assert.equal(pinyinTypoSearch.tracks[0]?.artist, "周杰伦");
  const multiTermTypoSearch = store.listTracks(new URL("http://localhost/api/music/tracks?q=tayor%20love%20story&limit=10"));
  assert.equal(multiTermTypoSearch.correctedQuery, "taylor love story");
  assert.ok(multiTermTypoSearch.tracks.some((track) => /Taylor/i.test(track.artist) && /Love Story/i.test(track.title)));
  const pinyinArtists = store.listArtists(new URL("http://localhost/api/music/artists?q=zjl&limit=5"));
  assert.equal(pinyinArtists.artists[0]?.name, "周杰伦", "artist browsing should understand initials as well as track search");
  const typoArtists = store.listArtists(new URL("http://localhost/api/music/artists?q=zhoujieln&limit=5"));
  assert.equal(typoArtists.artists[0]?.name, "周杰伦", "artist overview should follow the bounded pinyin correction used by track search");
  const pinyinAlbums = store.listAlbums(new URL("http://localhost/api/music/albums?q=qinghuaci&limit=5"));
  assert.ok(pinyinAlbums.albums.some((album) => album.title.includes("青花瓷")), "album browsing should understand full pinyin");

  store.searchLyrics(new URL(`http://localhost/api/music/lyrics/search?q=${encodeURIComponent("没有什么能够阻挡")}&limit=5`));
  const lyricSearchStartedAt = performance.now();
  const lyricSearch = store.searchLyrics(new URL(`http://localhost/api/music/lyrics/search?q=${encodeURIComponent("没有什么能够阻挡")}&limit=5`));
  const lyricSearchMs = performance.now() - lyricSearchStartedAt;
  assert.ok(lyricSearch.total > 0, "full-text lyric search should find matching songs");
  assert.equal(lyricSearch.matches[0]?.track?.title, "蓝莲花");
  assert.equal(lyricSearch.matches[0]?.text, "没有什么能够阻挡");
  assert.ok(Number(lyricSearch.matches[0]?.timeMs || 0) > 0, "lyric matches should expose their playback timestamp");
  assert.deepEqual(lyricSearch.matches[0]?.highlights, ["没有什么能够阻挡"]);
  assert.ok(lyricSearchMs < 150, `warm indexed lyric search should finish under 150 ms (actual ${lyricSearchMs.toFixed(1)} ms)`);
  store.listTracks(new URL(`http://localhost/api/music/tracks?q=${encodeURIComponent("没有什么能够阻挡")}&limit=20`));
  const lyricPhraseTrackStartedAt = performance.now();
  const lyricPhraseTracks = store.listTracks(new URL(`http://localhost/api/music/tracks?q=${encodeURIComponent("没有什么能够阻挡")}&limit=20`));
  const lyricPhraseTrackMs = performance.now() - lyricPhraseTrackStartedAt;
  assert.equal(lyricPhraseTracks.total, lyricSearch.total, "general search should count the same lyric phrase documents without a join scan");
  assert.ok(lyricPhraseTrackMs < 150, `warm general lyric phrase search should finish under 150 ms (actual ${lyricPhraseTrackMs.toFixed(1)} ms)`);
  const shortLyricStartedAt = performance.now();
  const shortLyricSearch = store.searchLyrics(new URL(`http://localhost/api/music/lyrics/search?q=${encodeURIComponent("爱你")}&limit=20`));
  const shortLyricMs = performance.now() - shortLyricStartedAt;
  assert.ok(shortLyricSearch.total > 0, "two-character lyric search should remain available");
  assert.ok(shortLyricSearch.matches.every((match) => String(match.text || "").includes("爱你")));
  assert.ok(shortLyricMs < 250, `bounded short lyric search should finish under 250 ms (actual ${shortLyricMs.toFixed(1)} ms)`);

  const favoriteFilter = store.listTracks(new URL("http://localhost/api/music/tracks?favorite=1&limit=300"));
  assert.ok(favoriteFilter.total > 0, "favorite quick filter should return the persisted favorites fixture");
  assert.ok(favoriteFilter.tracks.every((track) => track.favorite), "favorite quick filter must exclude non-favorites");
  const lyricsFilter = store.listTracks(new URL("http://localhost/api/music/tracks?lyrics=1&limit=300"));
  assert.ok(lyricsFilter.total > 0, "lyrics quick filter should return indexed lyric tracks");
  assert.ok(lyricsFilter.tracks.every((track) => track.hasLyrics), "lyrics quick filter must exclude tracks without lyrics");
  const ratingFilter = store.listTracks(new URL("http://localhost/api/music/tracks?minRating=4&limit=300"));
  assert.ok(ratingFilter.total > 0, "rating quick filter should return the persisted rated fixture");
  assert.ok(ratingFilter.tracks.every((track) => Number(track.rating || 0) >= 4), "rating quick filter must enforce its minimum rating");
  const losslessFilter = store.listTracks(new URL("http://localhost/api/music/tracks?quality=lossless&limit=300"));
  assert.ok(losslessFilter.total > 0, "lossless quick filter should return high-quality local tracks");
  assert.ok(losslessFilter.tracks.every((track) => {
    const codec = String(track.codec || "").toLowerCase();
    const fileName = String(track.fileName || "").toLowerCase();
    return ["flac", "wav", "alac"].includes(codec)
      || [".flac", ".wav", ".aiff", ".ape", ".dff", ".dsf"].some((ext) => fileName.endsWith(ext))
      || Number(track.bitDepth || 0) >= 24
      || Number(track.sampleRate || 0) >= 48000;
  }), "lossless quick filter must enforce the server quality predicate");

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
  const verificationDb = new DatabaseSync(fixture.dbPath, { readOnly: true });
  try {
    const indexedTracks = Number(verificationDb.prepare("SELECT COUNT(*) AS count FROM music_search_short").get()?.count || 0);
    assert.equal(indexedTracks, Number(summary.totals.tracks || 0), "the short search index should cover every active track");
    const phoneticIndexedTracks = Number(verificationDb.prepare("SELECT COUNT(*) AS count FROM music_search_phonetic").get()?.count || 0);
    assert.equal(phoneticIndexedTracks, Number(summary.totals.tracks || 0), "the phonetic search index should cover every active track");
    assert.equal(verificationDb.prepare("SELECT value FROM music_meta WHERE key = 'music_phonetic_index_version'").get()?.value, "1");
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
    "music-progress-writer.js",
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
  const androidApp = fs.readFileSync(path.join(root, "android-client", "www", "app.js"), "utf8");
  const androidMusicViewSource = fs.readFileSync(path.join(root, "android-client", "www", "modules", "music", "music-views.js"), "utf8");
  const androidMusicHomeViewSource = fs.readFileSync(path.join(root, "android-client", "www", "modules", "music", "music-home-view.js"), "utf8");
  const androidMusicPlaylistViewSource = fs.readFileSync(path.join(root, "android-client", "www", "modules", "music", "music-playlist-view.js"), "utf8");
  const androidMusicAutoCollectionViewSource = fs.readFileSync(path.join(root, "android-client", "www", "modules", "music", "music-auto-collection-view.js"), "utf8");
  const androidMusicHistoryActionsViewSource = fs.readFileSync(path.join(root, "android-client", "www", "modules", "music", "music-history-actions-view.js"), "utf8");
  const androidMusicListRequestSource = fs.readFileSync(path.join(root, "android-client", "www", "modules", "music", "music-list-request.js"), "utf8");
  const androidMusicLibraryViewSource = fs.readFileSync(path.join(root, "android-client", "www", "modules", "music", "music-library-view.js"), "utf8");
  const androidMusicLibrarySortSource = fs.readFileSync(path.join(root, "android-client", "www", "modules", "music", "music-library-sort.js"), "utf8");
  const androidMusicCollectionViewSource = fs.readFileSync(path.join(root, "android-client", "www", "modules", "music", "music-collection-view.js"), "utf8");
  const androidMusicSearchControllerSource = fs.readFileSync(path.join(root, "android-client", "www", "modules", "music", "music-search-controller.js"), "utf8");
  const androidMusicSheetsSource = fs.readFileSync(path.join(root, "android-client", "www", "modules", "music", "music-sheets.js"), "utf8");
  const androidMusicProgressWriterSource = fs.readFileSync(path.join(root, "android-client", "www", "modules", "music", "music-progress-writer.js"), "utf8");
  const androidMusicStateSource = fs.readFileSync(path.join(root, "android-client", "www", "modules", "music", "music-state.js"), "utf8");
  const androidClient = [androidMusicStateSource, androidMusicSearchControllerSource, androidMusicSheetsSource, androidMusicProgressWriterSource, androidMusicHomeViewSource, androidMusicPlaylistViewSource, androidMusicAutoCollectionViewSource, androidMusicHistoryActionsViewSource, androidMusicListRequestSource, androidMusicLibraryViewSource, androidMusicLibrarySortSource, androidMusicCollectionViewSource, androidMusicViewSource].join("\n");
  const androidMusicStyles = [
    fs.readFileSync(path.join(root, "android-client", "www", "modules", "music", "styles.css"), "utf8"),
    fs.readFileSync(path.join(root, "android-client", "www", "modules", "music", "home.css"), "utf8"),
    fs.readFileSync(path.join(root, "android-client", "www", "modules", "music", "playlist.css"), "utf8"),
    fs.readFileSync(path.join(root, "android-client", "www", "modules", "music", "auto-collection.css"), "utf8"),
    fs.readFileSync(path.join(root, "android-client", "www", "modules", "music", "library.css"), "utf8"),
    fs.readFileSync(path.join(root, "android-client", "www", "modules", "music", "collection.css"), "utf8")
  ].join("\n");
  const musicRuntime = fs.readFileSync(path.join(root, "src", "modules", "music", "server", "runtime.js"), "utf8");
  const musicServerFiles = fs.readdirSync(path.join(root, "src", "modules", "music", "server"))
    .filter((name) => name.endsWith(".js"))
    .sort();
  const musicStoreSource = musicServerFiles
    .map((name) => fs.readFileSync(path.join(root, "src", "modules", "music", "server", name), "utf8"))
    .join("\n");
  const webPageSource = musicClientSources["music-page.js"];
  const webActionsSource = musicClientSources["actions.js"];
  const webProgressWriterSource = musicClientSources["music-progress-writer.js"];
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
  assert.match(webActionsSource, /const progressWriter = createMusicProgressWriter\(\{[\s\S]*?api\.setProgress\(record\.trackId[\s\S]*?progressWriter\.reportPlayed\([\s\S]*?progressWriter\.save\(record/, "Web progress and played writes must use the shared per-track writer");
  assert.match(webProgressWriterSource, /playedQueue\.push\([\s\S]*?pendingProgressVersion[\s\S]*?function nextAction\([\s\S]*?isRetryableWriteBusy\(error\)/, "Web progress writer must serialize ordered played tokens with coalesced progress");
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
  assert.match(androidMusicViewSource, /from "\.\/music-state\.js\?v=/, "Android music must compose reusable state, formatting, and persistence helpers");
  assert.match(androidMusicViewSource, /createMusicSearchController/, "Android music must delegate search debounce, suggestions, and history coordination");
  assert.match(androidMusicViewSource, /createMusicHomeView/, "Android music must delegate its first-screen hierarchy to a focused home view");
  assert.match(androidMusicViewSource, /createMusicPlaylistView/, "Android music must delegate playlist detail hierarchy to a focused playlist view");
  assert.match(androidMusicViewSource, /createMusicAutoCollectionView/, "Android music must delegate recent-play and smart-playlist hierarchy to a focused auto-collection view");
  assert.match(androidMusicViewSource, /createMusicHistoryActionsView/, "Android music must delegate recent-play management to a focused action-sheet view");
  assert.match(androidMusicViewSource, /createMusicListRequestBuilder/, "Android music must delegate list request construction");
  assert.match(androidMusicViewSource, /createMusicLibraryView/, "Android music must delegate favorites and all-songs hierarchy to a focused library view");
  assert.match(androidMusicViewSource, /createMusicLibrarySort/, "Android music must delegate focused-library sorting to a dedicated controller");
  assert.match(androidMusicViewSource, /createMusicCollectionView/, "Android music must delegate artist and album hierarchy to a focused collection view");
  assert.ok(androidMusicViewSource.split(/\r?\n/).length <= 6000, "Android music view/controller must stay below 6000 lines");
  assert.ok(androidMusicHomeViewSource.split(/\r?\n/).length <= 430, "Android music home view must stay below 430 lines");
  assert.ok(androidMusicPlaylistViewSource.split(/\r?\n/).length <= 220, "Android music playlist view must stay below 220 lines");
  assert.ok(androidMusicAutoCollectionViewSource.split(/\r?\n/).length <= 220, "Android music auto-collection view must stay below 220 lines");
  assert.ok(androidMusicHistoryActionsViewSource.split(/\r?\n/).length <= 140, "Android music history actions view must stay below 140 lines");
  assert.ok(androidMusicListRequestSource.split(/\r?\n/).length <= 100, "Android music list-request builder must stay below 100 lines");
  assert.ok(androidMusicLibraryViewSource.split(/\r?\n/).length <= 180, "Android music focused-library view must stay below 180 lines");
  assert.ok(androidMusicCollectionViewSource.split(/\r?\n/).length <= 360, "Android music artist and album view must stay below 360 lines");
  assert.ok(androidMusicSearchControllerSource.split(/\r?\n/).length <= 400, "Android music search controller must stay below 400 lines");
  assert.ok(androidMusicStateSource.split(/\r?\n/).length <= 600, "Android music state helpers must stay below 600 lines");
  assert.match(androidClient, /music-mobile-load-more/);
  assert.match(androidMusicCollectionViewSource, /music-mobile-collection-artist-list/);
  assert.match(androidMusicCollectionViewSource, /music-mobile-collection-album-list/);
  assert.match(androidClient, /匹配度/);
  assert.match(androidClient, /collapseDuplicateTracks\(rawTracks\)/);
  assert.match(androidClient, /duplicateCount: group\.tracks\.length/);
  assert.match(androidClient, /rawLoaded: rawTracks\.length/);
  assert.match(androidClient, /const searchFocused = Boolean\(state\.searchOpen \|\| state\.query\)/);
  assert.match(androidMusicViewSource, /if \(searchFocused\) \{\s*shell\.append\(renderSearchSurface\(\), renderSearchContentRegion\(\)\);\s*\} else \{/, "Android music search should keep dedicated mounted search and content regions");
  assert.match(androidMusicHomeViewSource, /renderSearchLauncher[\s\S]*?renderQuickAccess[\s\S]*?renderRecentListening[\s\S]*?renderPlaylists[\s\S]*?renderSmartPlaylists/, "Android music home should expose search, quick access, recent listening, playlists, and mixes as distinct levels");
  assert.match(androidMusicHomeViewSource, /function isHomeView\(\)[\s\S]*?state\.dashboard[\s\S]*?label: "歌曲"[\s\S]*?dashboard: false/, "Android music quick access should leave the dashboard for the contextual song library");
  assert.match(androidApp, /const dashboard = !\["0", "false", "no"\][\s\S]*?\.\.\.\(!dashboard \? \{ dashboard: "0" \} : \{\}\)[\s\S]*?dashboard: query\.get\("dashboard"\)/, "Android navigation must preserve the music dashboard flag through sanitized and restored routes");
  assert.match(androidMusicViewSource, /if \(home\) \{[\s\S]*?renderQuickAccess\(\)[\s\S]*?renderSmartPlaylists\(\)[\s\S]*?\} else \{[\s\S]*?renderTabs\(\), renderControls\(\)[\s\S]*?renderTrackList\(\)/, "Android music should keep dashboard sections separate from the contextual track browser");
  assert.match(androidMusicViewSource, /const playlistDetail = isPlaylistDetailView\(\)[\s\S]*?else if \(playlistDetail\) \{[\s\S]*?renderPlaylistHero\(\), renderPlaylistListHeader\(\)[\s\S]*?renderPlaylistEmpty\(\)/, "Android playlist details should bypass global library tabs and compose their own focused hierarchy");
  assert.match(androidMusicViewSource, /const autoCollectionDetail = isAutoCollectionView\(\)[\s\S]*?else if \(autoCollectionDetail\) \{[\s\S]*?renderAutoCollectionHero\(\), renderAutoCollectionListHeader\(\)[\s\S]*?renderAutoCollectionEmpty\(\)/, "Android recent-play and smart-playlist details should bypass generic library tabs and facets");
  assert.match(androidMusicViewSource, /const focusedLibrary = focusedLibraryView\.isFocusedLibraryView\(\)[\s\S]*?else if \(focusedLibrary\) \{[\s\S]*?renderHeader\(openMusicSearch\), focusedLibraryView\.renderToolbar\(\)[\s\S]*?renderTrackList\(\)/, "Android favorites and all-songs pages should bypass the generic search, library hero, tabs, and duplicate list heading");
  assert.match(androidMusicViewSource, /const collectionBrowser = collectionView\.isCollectionBrowserView\(\)[\s\S]*?else if \(collectionBrowser\) \{[\s\S]*?renderBrowserHeader\(openMusicSearch\)[\s\S]*?renderBrowserToolbar\(\)[\s\S]*?renderBrowserContent\(\)/, "Android artist and album browsers should bypass the generic search launcher, library hero, and five-mode tab row");
  assert.match(androidMusicViewSource, /const detail = collectionView\.isCollectionDetailView\(\)[\s\S]*?if \(detail\) \{[\s\S]*?collectionView\.renderDetailHero\(\), collectionView\.renderDetailListHeader\(\), renderTrackList\(\)/, "Android artist and album details should compose one identity hero and one song-list header");
  assert.match(androidMusicViewSource, /function openMusicSearch\(\)[\s\S]*?state\.searchReturn = \{[\s\S]*?mode: state\.mode,[\s\S]*?language: state\.language/, "Android music search should remember the page and filters that opened it");
  assert.match(androidMusicSearchControllerSource, /const searchReturn = state\.searchReturn[\s\S]*?state\.searchReturn = null;[\s\S]*?\.\.\.searchReturn,[\s\S]*?query: ""/, "Android music search back should restore its originating artist, album, or library route");
  assert.match(androidMusicPlaylistViewSource, /music-mobile-playlist-topbar[\s\S]*?music-mobile-playlist-identity[\s\S]*?music-mobile-playlist-primary-actions[\s\S]*?随机播放[\s\S]*?播放全部/, "Android playlist details should expose back navigation, identity, and direct playback actions");
  assert.match(androidMusicPlaylistViewSource, /music-mobile-playlist-empty[\s\S]*?添加歌曲/, "Android playlist details should provide one dedicated path out of the empty state");
  assert.match(androidMusicPlaylistViewSource, /symbolButton\("arrow-back"[\s\S]*?top\.append\(back, spacer, management\)[\s\S]*?identity\.className = "music-mobile-playlist-identity is-compact"[\s\S]*?hero\.append\(top, identity\);\s*if \(tracks\.length\) hero\.append\(actions\);/, "Android playlist details should use real topbar icons, one compact text identity, and avoid empty disabled playback controls");
  assert.doesNotMatch(androidMusicPlaylistViewSource, /pageLabel\.textContent = "歌单"|identity\.append\(renderCover/, "Android playlist details should not repeat the entity type or let shared fallback artwork dominate the identity");
  assert.match(androidMusicPlaylistViewSource, /music-mobile-playlist-management[\s\S]*?编辑歌单[\s\S]*?删除歌单/, "Android playlist management should remain available without crowding the default hero");
  assert.match(androidMusicPlaylistViewSource, /function returnToMusicHome\(\)[\s\S]*?dashboard: true[\s\S]*?function browseLibrary\(\)[\s\S]*?dashboard: false/, "Android playlist back and add-song paths should route to the dashboard and contextual song browser respectively");
  assert.match(androidMusicAutoCollectionViewSource, /music-mobile-auto-identity[\s\S]*?随机播放[\s\S]*?播放全部[\s\S]*?music-mobile-playlist-list-head/, "Android auto collections should expose identity, direct playback, and one flat song-list header");
  assert.match(androidMusicAutoCollectionViewSource, /symbolButton\("arrow-back"[\s\S]*?identity\.append\(title, description, meta\)/, "Android auto collections should use one real back icon and one compact identity instead of stacked page-type and badge labels");
  assert.doesNotMatch(androidMusicAutoCollectionViewSource, /badge\.textContent|heading\.textContent = history \? "播放记录" : "自动歌单"/, "Android auto collections should not repeat their identity in the topbar and a category badge");
  assert.match(androidMusicAutoCollectionViewSource, /heading\.textContent = history \? "最近播放"[\s\S]*?music-mobile-history-play[\s\S]*?播放全部[\s\S]*?symbolButton\([\s\S]*?"shuffle"/, "Android recent play should use one compact title and one flat playback toolbar instead of a second hero identity");
  assert.match(androidMusicHistoryActionsViewSource, /function renderHistoryManagement\(\)[\s\S]*?function renderHistoryActionsSheet\(\)[\s\S]*?清空播放记录/, "Android recent play should keep clearing history in a dedicated bottom sheet instead of a floating page popover");
  assert.match(androidMusicAutoCollectionViewSource, /function returnToMusicHome\(\)[\s\S]*?dashboard: true[\s\S]*?function browseLibrary\(\)[\s\S]*?dashboard: false/, "Android auto-collection back and empty paths should route to the dashboard and contextual song browser respectively");
  assert.match(androidMusicLibraryViewSource, /我的收藏[\s\S]*?搜索我喜欢的歌曲[\s\S]*?播放全部[\s\S]*?renderMusicSort\(\)/, "Android favorites should expose one focused title, local search, direct playback, and sorting");
  assert.match(androidMusicLibraryViewSource, /music-mobile-playlist-topbar music-mobile-collection-topbar[\s\S]*?symbolButton\("arrow-back", returnToMusicHome/, "Android focused song libraries should use the same real back icon as playlist, collection, and search routes");
  assert.match(androidMusicLibraryViewSource, /function returnToMusicHome\(\)[\s\S]*?dashboard: true[\s\S]*?function browseAllSongs\(\)[\s\S]*?favorite: false/, "Android focused-library back and empty paths should return to the dashboard or all songs");
  assert.match(androidMusicViewSource, /const AUTO_COLLECTION_LIMIT = 300[\s\S]*?autoCollectionLimit: AUTO_COLLECTION_LIMIT/, "Android automatic collections should pass their larger first-page limit to the request builder");
  assert.match(androidMusicListRequestSource, /state\.mode === "history"[\s\S]*?autoCollectionLimit[\s\S]*?state\.smartId \? autoCollectionLimit : defaultLimit/, "Android automatic collections should load a useful first page instead of truncating short recent and smart lists at the generic limit");
  assert.match(androidMusicViewSource, /!\["library", "artists", "albums", "smart"\]\.includes\(state\.mode\)/, "Android large smart playlists should retain incremental loading");
  assert.match(androidMusicHomeViewSource, /music-mobile-home-tools[\s\S]*?music-mobile-home-search[\s\S]*?music-mobile-home-settings/, "Android music should keep search and settings in one compact top utility row");
  assert.match(androidMusicViewSource, /if \(!searchFocused\) shell\.append\(renderMiniPlayer\(\)\)[\s\S]*?classList\.toggle\("music-search-open", searchFocused\)/, "Android music search should remove persistent playback chrome while typing or reviewing results");
  assert.match(androidMusicViewSource, /music-mobile-track\$\{track\.coverUrl \? "" : " no-cover"\}/, "Android music rows should distinguish missing cover art so large fallback tiles do not dominate the list");
  assert.match(androidMusicStyles, /body\.music-mobile-view\s*\{[\s\S]*?--music-accent: #08b778;[\s\S]*?--music-accent-ink: #07140f;[\s\S]*?--music-accent-text: #087a54;[\s\S]*?--music-playing-accent: #08b778;[\s\S]*?--blue: var\(--mobile-accent\);/, "Android music should keep restrained brand green for playback and primary action while sharing the generic mobile accent contract");
  assert.doesNotMatch(androidMusicStyles, /body\.music-mobile-view\s*\{[^}]*--(?:bg|field|surface-soft|stat-surface|nav-surface|ink|muted|quiet|line):/, "Android music must inherit the shared mobile canvas and surface palette instead of applying a cold gray-white filter");
  assert.match(androidMusicStyles, /body\.music-mobile-view \.bottom-nav button\.active\s*\{[\s\S]*?background: transparent;[\s\S]*?color: var\(--ink\);/, "Android music navigation should use QQ Music's neutral selected state instead of a green tile");
  assert.match(androidMusicStyles, /\.music-mobile-quick-access\s*\{[\s\S]*?border-top: 1px solid var\(--line\)[\s\S]*?\.music-mobile-recent-card\s*\{[\s\S]*?calc\(\(100% - 20px\) \/ 3\)[\s\S]*?\.music-mobile-mini-player > \.music-mobile-cover\s*\{[\s\S]*?border: 2px solid color-mix\(in srgb, var\(--ink\) 12%, transparent\)[\s\S]*?\.music-mobile-mini-player\.is-playing > \.music-mobile-cover\s*\{[\s\S]*?border-color: var\(--music-playing-accent\)/, "Android music home should retain flat shortcuts, a three-cover recent rail, and reserve the restrained green mini-player ring for active playback");
  assert.match(androidMusicStyles, /body\.music-mobile-view \.music-mobile-library-head\.is-home \.music-mobile-play-all\s*\{[\s\S]*?background: var\(--music-accent\);[\s\S]*?color: var\(--music-accent-ink\);/, "Android music home should retain one restrained green continue action while keeping secondary controls neutral");
  assert.match(androidMusicStyles, /\.music-mobile-playlist-hero\s*\{[\s\S]*?margin: 0 -12px;[\s\S]*?background: var\(--surface-soft\)[\s\S]*?\.music-mobile-playlist-list-head\s*\{[\s\S]*?border-bottom: 1px solid var\(--line\)[\s\S]*?\.music-mobile-playlist-empty\s*\{/, "Android playlist details should use a page-level hero, flat list divider, and dedicated empty state");
  assert.match(androidMusicStyles, /\.music-mobile-playlist-primary-actions \.primary\s*\{[\s\S]*?background: var\(--surface-raised\);[\s\S]*?color: var\(--ink\);/, "Android playlist playback actions should follow QQ Music's neutral action treatment instead of using a fluorescent green fill");
  assert.match(androidMusicStyles, /\.music-mobile-auto-hero\s*\{[\s\S]*?background: var\(--surface-soft\)[\s\S]*?\.music-mobile-auto-identity strong\s*\{[\s\S]*?font-size: clamp\(24px, 7vw, 30px\)/, "Android automatic collections should use a focused flat hero instead of the generic search, tabs, and filters stack");
  assert.match(androidMusicStyles, /\.music-mobile-auto-hero \.music-mobile-playlist-back[\s\S]*?min-width: 44px;[\s\S]*?min-height: 44px;/, "Android automatic collections should retain practical tap targets after compacting the hero");
  assert.match(androidMusicStyles, /\.music-mobile-focused-library-head\s*\{[\s\S]*?background: var\(--surface-soft\)[\s\S]*?\.music-mobile-focused-library-search\s*\{[\s\S]*?min-height: 44px;[\s\S]*?\.music-mobile-focused-library-toolbar\s*\{/, "Android favorites and all-songs pages should follow the reference's compact topbar, search, and playback-toolbar sequence");
  assert.match(androidMusicStyles, /\.music-mobile-focused-library-play\s*\{[\s\S]*?background: transparent;[\s\S]*?color: var\(--ink\);[\s\S]*?\.music-mobile-focused-library-play-icon\s*\{[\s\S]*?background: var\(--music-accent\);[\s\S]*?color: var\(--music-accent-ink\);/, "Android focused library playback should match the reference's compact accent icon and neutral label instead of a large fluorescent green pill");
  assert.match(androidMusicStyles, /\.music-mobile-focused-library-locate\s*\{[\s\S]*?color: var\(--muted\);[\s\S]*?\.music-mobile-focused-library-head ~ \.music-mobile-list \.music-mobile-icon-button\.track-label\s*\{[\s\S]*?color: var\(--muted\);/, "Android focused library secondary controls should remain neutral so green is reserved for playback and active state");
  assert.match(androidMusicViewSource, /DEFAULT_COVER_URL = "\.\/assets\/music\/default-cover-v1\.jpg\?v=20260730-music-palette-ui-42"/, "Android music should use the lightly colored bundled fallback artwork instead of repeating a gray-white placeholder");
  const defaultCoverPath = path.join(root, "android-client", "www", "assets", "music", "default-cover-v1.jpg");
  assert(fs.existsSync(defaultCoverPath), "Android colored fallback artwork must be bundled");
  assert(fs.statSync(defaultCoverPath).size < 500_000, "Android fallback artwork should stay compact enough for the bundled client");
  assert.doesNotMatch(androidMusicViewSource, /cover\.textContent = initials/, "Android music covers must not fall back to fake initial artwork");
  assert.match(androidMusicCollectionViewSource, /function sortedArtists\(items\)[\s\S]*?isUnknownArtist/, "Android artist browsing should keep unidentified entries last");
  assert.match(androidMusicCollectionViewSource, /const artwork = albumDetail && \(album\?\.coverUrl \|\| firstTrack\?\.coverUrl\)[\s\S]*?: null;[\s\S]*?identity\.className = `music-mobile-collection-identity \$\{artwork \? "has-art" : "no-art"\}`/, "Android collection details should only present real album artwork and keep artist identities honest when portraits are unavailable");
  assert.match(androidMusicCollectionViewSource, /music-mobile-collection-detail[\s\S]*?music-mobile-collection-actions[\s\S]*?播放全部[\s\S]*?随机播放/, "Android artist and album routes should use a dedicated collection hero with direct playback actions");
  assert.match(androidMusicCollectionViewSource, /hero\.append\(renderTopbar\("", returnToCollectionBrowser\)\)[\s\S]*?kicker\.textContent = "本地音乐"[\s\S]*?playbackButton\("播放全部", "play"[\s\S]*?playbackButton\("随机播放", "shuffle"/, "Android collection details should avoid repeating the entity type and use the shared real icon family for compact playback actions");
  assert.match(androidMusicStyles, /\.music-mobile-collection-detail\.no-art\s*\{[\s\S]*?gap: 9px;[\s\S]*?\.music-mobile-collection-identity\.no-art\s*\{[\s\S]*?min-height: 64px;[\s\S]*?\.music-mobile-collection-identity strong\s*\{[\s\S]*?-webkit-line-clamp: 2;[\s\S]*?\.music-mobile-collection-detail\.no-art \.music-mobile-collection-identity strong\s*\{[\s\S]*?font-size: clamp\(21px, 6\.4vw, 26px\);/, "Android text-led artist and album fallbacks should keep long identities compact instead of consuming most of the first viewport");
  assert.match(androidMusicHomeViewSource, /state\.mode === "artists"[\s\S]*?"全部歌手"[\s\S]*?state\.mode === "albums"[\s\S]*?"全部专辑"[\s\S]*?state\.artistId \|\| state\.albumId[\s\S]*?"歌曲"/, "Android music headings should describe the visible list instead of repeating the page title");
  assert.match(androidMusicViewSource, /function renderFullTrackInfo\(track\)[\s\S]*?music-mobile-full-track-info[\s\S]*?function renderFullQuickActions\(track\)/, "Android full player should place song identity and secondary actions below the artwork");
  assert.match(androidMusicViewSource, /player\.className = `music-mobile-mini-player\$\{state\.current && !audio\?\.paused \? " is-playing" : ""\}`[\s\S]*?classList\.toggle\("is-playing", playing\)/, "Android mini-player should expose the playback state so the accent ring disappears while paused");
  assert.doesNotMatch(androidMusicViewSource, /music-mobile-full-title/, "Android full player must not repeat song identity in both the top bar and content stage");
  assert.match(androidMusicViewSource, /symbolButton\("chevron-down"[\s\S]*?symbolButton\("more"[\s\S]*?symbolButton\("previous"[\s\S]*?symbolButton\(track && !audio\?\.paused \? "pause" : "play"[\s\S]*?symbolButton\("next"[\s\S]*?symbolButton\("queue"/, "Android full player should use one coherent real icon family for navigation and transport");
  assert.match(androidMusicViewSource, /fullActionButton\(track\?\.favorite \? "favorite-fill" : "favorite"[\s\S]*?fullActionButton\("playlist-add"[\s\S]*?fullActionButton\("download"[\s\S]*?fullActionButton\("timer"/, "Android full player should keep four familiar icon actions instead of a noisy row of five text controls");
  assert.match(androidMusicViewSource, /symbolButton\(track\.favorite \? "favorite-fill" : "favorite"[\s\S]*?symbolButton\("more"[\s\S]*?track-label track-more/, "Android track rows should use the shared heart and more assets instead of text action pills");
  assert.match(androidMusicViewSource, /controls\.append\(repeat, prev, play, next, queue\)/, "Android full player should keep a compact five-control transport row");
  assert.match(androidMusicViewSource, /panel === "lyrics" && !hasLyrics\(\)[\s\S]*?function normalizeFullPanel\(panel, track\)[\s\S]*?value === "lyrics" && !hasLyrics\(\) \? "cover" : value/, "Android full player must not open an empty lyric canvas when the current track has no lyrics");
  assert.match(androidMusicViewSource, /function renderPlaybackSettingsSheet\(track\) \{[\s\S]*?document\.createElement\("section"\)[\s\S]*?aria-label", "播放设置"[\s\S]*?music-mobile-playback-shuffle[\s\S]*?renderPlaybackSpeedControl\(track\)[\s\S]*?renderVolumeControl\(track\)/, "Android full player should move shuffle, rating, speed, and volume into a focused playback settings sheet");
  assert.match(androidMusicViewSource, /if \(state\.queueManageOpen\)[\s\S]*?queueActionButton\("arrow-upward"[\s\S]*?queueActionButton\("arrow-downward"[\s\S]*?queueActionButton\("close"[\s\S]*?music-mobile-queue-handle/, "Android queue should keep real-icon reorder controls available without exposing three management buttons in the default scan state");
  assert.match(androidMusicStyles, /\.music-mobile-full-controls \.music-mobile-icon-button\.primary[\s\S]*?background: color-mix\([\s\S]*?color: var\(--ink\)/, "Android full player transport should stay neutral instead of using a fluorescent green fill");
  assert.match(androidMusicStyles, /\.music-mobile-full-quick-actions button\.active[\s\S]*?background: transparent;[\s\S]*?color: var\(--music-accent-text\)/, "Android full player should reserve green for active secondary actions");
  assert.match(androidMusicViewSource, /symbol = document\.createElement\("img"\)[\s\S]*?symbol\.src = `\.\/assets\/icons\/music-\$\{name\}\.svg\?v=20260730-music-palette-ui-42`/, "Android music controls should render bundled icon-library assets instead of text glyphs or CSS drawings");
  assert.match(androidMusicStyles, /\.music-mobile-full-quick-actions button\.active\s*\{[\s\S]*?background: var\(--field\);[\s\S]*?\.music-mobile-full-controls \.music-mobile-icon-button\.active\s*\{[\s\S]*?background: var\(--field\);[\s\S]*?filter: none;/, "Android paused playback modes and secondary active controls should use neutral graphite selection instead of forced green icon filters");
  assert.match(androidMusicStyles, /\.music-mobile-full-quick-actions button\.favorite\.active\s*\{[\s\S]*?color: #ff4f67;/, "Android favorite state should use the familiar heart color instead of adding another green status");
  assert.match(androidMusicStyles, /\.music-mobile-track-action-choice\.active\s*\{[\s\S]*?background: transparent;[\s\S]*?color: #d72f49;/, "Android track actions should keep the favorite state in the same red family as the full player without adding another colored card");
  assert.match(androidMusicStyles, /\.music-mobile-progress\.full input\s*\{[\s\S]*?accent-color: var\(--ink\);/, "Android full-player progress should remain neutral against the artwork-tinted backdrop");
  assert.match(androidMusicStyles, /body\.music-mobile-view \.music-mobile-sheet-backdrop\s*\{[\s\S]*?position: absolute;[\s\S]*?body\.music-mobile-view \.music-mobile-queue-sheet\s*\{[\s\S]*?position: absolute;/, "Android full-player sheets must overlay the player without becoming grid rows that compress the cover and title");
  for (const icon of ["arrow-back", "arrow-upward", "arrow-downward", "chevron-down", "close", "drag-handle", "more", "favorite", "favorite-fill", "playlist-add", "add-to-queue", "download", "timer", "repeat", "repeat-one", "previous", "next", "queue", "play", "play-circle", "pause", "shuffle", "filter-list", "sort", "my-location", "check", "delete", "person", "album"]) {
    assert(fs.existsSync(path.join(root, "android-client", "www", "assets", "icons", `music-${icon}.svg`)), `Android music icon asset must be bundled: ${icon}`);
  }
  assert.match(androidMusicViewSource, /function scheduleActiveQueueScroll\(\)[\s\S]*?closest\("\.music-mobile-queue-list"\)[\s\S]*?list\.scrollTo\(\{ top: target, behavior: "auto" \}\)/, "Android queue reveal must scroll inside the queue sheet instead of moving the fullscreen player under the system bar");
  assert.match(androidMusicStyles, /\.music-mobile-collection-browser-head\s*\{[\s\S]*?background: var\(--surface-soft\)[\s\S]*?\.music-mobile-collection-search\s*\{[\s\S]*?min-height: 44px;[\s\S]*?\.music-mobile-collection-browser-toolbar\s*\{/, "Android artist and album browsers should follow the compact topbar, search, mode switch, and filter sequence");
  assert.match(androidMusicStyles, /\.music-mobile-collection-artist-row,[\s\S]*?\.music-mobile-collection-album-row\s*\{[\s\S]*?border-bottom: 1px solid var\(--line\)[\s\S]*?background: transparent;/, "Android artist and album browsers should use flat rows rather than rounded utility cards");
  assert.match(androidMusicStyles, /\.music-mobile-collection-actions button\s*\{[\s\S]*?background: var\(--surface-raised\);[\s\S]*?color: var\(--ink\);/, "Android artist and album playback actions should remain neutral instead of using a fluorescent green fill");
  assert.match(androidMusicStyles, /\.music-mobile-collection-list-head ~ \.music-mobile-list \.music-mobile-icon-button\.track-label\s*\{[\s\S]*?background: transparent;[\s\S]*?color: var\(--muted\);/, "Android collection row actions should remain neutral so green stays reserved for playback and active state");
  assert.match(androidMusicStyles, /\.music-mobile-track\.active\s*\{[\s\S]*?box-shadow: none;[\s\S]*?\.music-mobile-track\.playing\s*\{[\s\S]*?box-shadow: inset 3px 0 0 var\(--music-playing-accent\);/, "Android track rows should show the restrained green edge only while playback is actually active");
  assert.match(androidMusicStyles, /\.music-mobile-mini-player \.music-mobile-mini-text strong\s*\{[\s\S]*?display: block;[\s\S]*?font-size: 13px;/, "Android mini-player titles must establish a block formatting boundary so long names ellipsize before the playback controls");
  assert.match(androidMusicStyles, /\.music-mobile-shell\s*\{[\s\S]*?overflow-anchor: none;/, "Android music route changes should not let browser scroll anchoring crop the new page header");
  assert.match(androidApp, /renderCurrentView\(\{[\s\S]*?restoreScrollY: navigation\.restoreScrollY \?\? 0[\s\S]*?\}\);/, "Android same-module route changes should reapply their scroll target after asynchronous rendering settles");
  assert.match(androidMusicLibraryViewSource, /symbolButton\([\s\S]*?"filter-list"[\s\S]*?aria-controls", "music-library-filter-overlay"[\s\S]*?music-mobile-focused-library-action-badge/, "Android all-songs should expose one real icon filter trigger with compact active-state feedback");
  assert.match(androidMusicViewSource, /function renderFacetFilters\(\)[\s\S]*?music-library-filter-overlay[\s\S]*?role", "dialog"[\s\S]*?筛选歌曲[\s\S]*?music-mobile-library-filter-content[\s\S]*?aria-pressed/, "Android music facets should open as a dedicated, accessible filter page instead of an inline horizontal rail");
  assert.match(androidMusicViewSource, /function renderFacetRow\(label, items, activeId, onSelect\)[\s\S]*?const selected = Boolean\(activeId\) && item\.id === activeId[\s\S]*?aria-pressed/, "Android filter defaults should stay neutral and reserve the accent fill for a real active constraint");
  assert.match(androidMusicLibrarySortSource, /symbolButton\([\s\S]*?"sort"[\s\S]*?function renderLibrarySortSheet\(\)[\s\S]*?role", "dialog"[\s\S]*?排序方式[\s\S]*?music-mobile-library-sort-choice[\s\S]*?setMusicSymbol\(stateLabel, "check"\)/, "Android all-songs sorting should use a real icon trigger and a focused checked bottom sheet instead of a native full-screen select dialog");
  assert.match(androidMusicStyles, /\.music-mobile-library-sort-sheet\s*\{[\s\S]*?top: auto;[\s\S]*?bottom: 0;[\s\S]*?max-height: min\(66vh, 560px\);[\s\S]*?transform: translateX\(50%\);/, "Android sorting should stay anchored to the bottom on narrow phones despite the general full-page settings-sheet media rule");
  assert.match(androidMusicViewSource, /function facetAlbumTitle\(album\)[\s\S]*?\^_\?单曲\$[\s\S]*?function prioritizedFacetItems/, "Android album facets should normalize generic single-track albums before disambiguating them by artist");
  assert.match(androidMusicStyles, /\.music-mobile-library-filter-content \.music-mobile-facet-scroll\s*\{[\s\S]*?grid-template-columns: repeat\(3, minmax\(0, 1fr\)\);[\s\S]*?overflow: visible;[\s\S]*?data-facet="专辑"[\s\S]*?repeat\(2, minmax\(0, 1fr\)\)/, "Android filter choices should use readable wrapped grids without horizontally clipped controls");
  assert.match(androidClient, /if \(!moduleActive \|\| !els\.viewContent\) return;/, "inactive music requests must not repaint another module");
  assert.match(androidClient, /enterkeyhint/);
  assert.match(androidClient, /hasOwnProperty\.call\(patch, "language"\)/);
  assert.match(androidClient, /function updateListParams\(patch = \{\}, options = \{\}\) \{[\s\S]*?const searchFocus = captureMusicSearchFocus\(\);\s*if \(searchFocus\) pendingSearchFocus = searchFocus;/, "Android music navigation should capture search focus before the host clears the module DOM");
  assert.match(androidClient, /function renderShell\(\)[\s\S]*?restoreMusicSearchFocus\(searchFocus\)/, "Android music refreshes should restore search focus and selection");
  assert.match(androidClient, /function updateStaticPlaybackControls\(playing\)[\s\S]*?music-mobile-playing-bars/, "Android music playback events should reconcile the header and active track row without a full rerender");
  assert.match(androidClient, /function updateMountedMiniPlayerTrack\(\)[\s\S]*?player\.dataset\.trackKey[\s\S]*?replaceWith\(renderCover[\s\S]*?title\.textContent[\s\S]*?meta\.textContent/, "Android music playback transitions should reconcile mini-player metadata without replacing its mounted node");
  assert.match(androidClient, /function updatePlaybackUi\(\)[\s\S]*?updateMountedMiniPlayerTrack\(\)/, "Android music playback events should keep mounted mini-player metadata current");
  assert.match(androidClient, /function renderSearchSurface\(\)[\s\S]*?function renderSearchDiscovery\(\)/, "Android music search should have a dedicated result and discovery surface");
  assert.match(androidClient, /\{ scope: "all", label: "综合" \}[\s\S]*?\{ scope: "songs", label: "歌曲" \}[\s\S]*?\{ scope: "lyrics", label: "歌词" \}[\s\S]*?function renderSearchOverview\(\)/, "Android music search should expose unified, song, and lyric result scopes");
  assert.match(androidClient, /Promise\.allSettled\(\[[\s\S]*?\/api\/music\/artists[\s\S]*?\/api\/music\/albums/, "Android unified search should fetch filtered artist and album matches together");
  assert.match(androidClient, /function renderSearchOverview\(\)[\s\S]*?bestSearchMatch\(data\)[\s\S]*?renderBestSearchMatch\(best\)[\s\S]*?music-mobile-search-album-rail/, "Android unified search should select the strongest typed entity before related results");
  assert.match(androidClient, /function renderBestSearchMatch\(best\)[\s\S]*?searchVersionGroupForTrack\(item\)[\s\S]*?选择版本[\s\S]*?renderSearchVersionRail\(versionGroup\)/, "Android best matches should expose same-song versions without leaving the unified result page");
  assert.match(androidClient, /function renderSearchVersionChoice\(track, group, options = \{\}\)[\s\S]*?getTrackVersionInfo\(track\)[\s\S]*?playSearchTrackVersion\(track, group\.tracks\)/, "Android version choices should label and play the selected concrete track");
  assert.match(androidClient, /function renderSearchSongResults\(options = \{\}\)[\s\S]*?currentSearchVersionGroups\(tracks\)[\s\S]*?versionGroups: visibleGroups/, "Android song search should group recognized versions before rendering bounded previews");
  assert.match(androidClient, /function renderSearchTrackVersionGroup\(group, index\)[\s\S]*?searchExpandedVersionGroups[\s\S]*?renderSearchVersionChoice\(track, group\)/, "Android song results should expand a version group into directly playable choices");
  assert.match(androidClient, /function toggleSearchTrackVersionGroup\(key\)[\s\S]*?searchExpandedVersionGroups\.delete[\s\S]*?searchExpandedVersionGroups\.add[\s\S]*?refreshMountedSearchUi\(\)/, "Android version expansion should preserve the mounted search and player surfaces");
  assert.match(androidClient, /MUSIC_REMEMBER_VERSION_KEY = "fanhao\.android\.music\.rememberVersionChoices"[\s\S]*?MUSIC_VERSION_PREFERENCES_KEY = "fanhao\.android\.music\.versionPreferences"[\s\S]*?MUSIC_VERSION_STRATEGY_KEY = "fanhao\.android\.music\.versionStrategy"[\s\S]*?rememberVersionChoices: readRememberVersionChoicesPreference\(\)[\s\S]*?versionStrategy: readVersionStrategyPreference\(\)/, "Android music should persist per-song version memory and the global version strategy independently from the playback queue");
  assert.match(androidClient, /function preferredTrackForVersionGroup\(group, fallback = null\)[\s\S]*?rememberedTrackForVersionGroup\(group\)[\s\S]*?selectTrackByVersionStrategy\(tracks, state\.versionStrategy, defaultTrack\)/, "Android search should let a remembered concrete version override the global strategy and safe fallback");
  assert.match(androidClient, /function rememberedTrackForVersionGroup\(group\)[\s\S]*?state\.rememberVersionChoices[\s\S]*?versionPreferenceKey\(group\.key\)[\s\S]*?tracks\.find/, "Android search should resolve remembered versions only when version memory is enabled");
  assert.match(androidClient, /function playSearchTrackVersion\(track, tracks\)[\s\S]*?rememberTrackVersionChoice\(track, versions\)[\s\S]*?preferredSearchQueue\(state\.data\?\.tracks, track\)[\s\S]*?state\.queue = searchQueue/, "Choosing a search version should remember it and retain the complete deduplicated search queue");
  assert.match(androidClient, /function renderSettingsSheet\(\)[\s\S]*?默认播放版本策略[\s\S]*?VERSION_STRATEGY_OPTIONS[\s\S]*?记住版本选择[\s\S]*?版本偏好[\s\S]*?renderSettingsDisclosureGroup\([\s\S]*?"search"[\s\S]*?"搜索与版本"[\s\S]*?clearActiveVersionPreferences/, "Android music settings should manage the global strategy and remembered search versions without leaving the player");
  assert.match(androidClient, /function readRememberVersionChoicesPreference\(\)[\s\S]*?value === null \? true[\s\S]*?function readVersionStrategyPreference\(\)[\s\S]*?MUSIC_VERSION_STRATEGY_KEY[\s\S]*?function pruneVersionPreferences\(value\)[\s\S]*?VERSION_PREFERENCE_LIMIT/, "Version preferences should use safe local defaults and cap remembered per-song storage");
  assert.match(androidClient, /VERSION_STRATEGY_OPTIONS = \[[\s\S]*?智能选择[\s\S]*?原版优先[\s\S]*?无损优先[\s\S]*?小文件优先[\s\S]*?function setVersionStrategy\(value\)[\s\S]*?writeVersionStrategyPreference/, "Android music settings should expose and persist four understandable default-version strategies");
  assert.match(androidClient, /function selectTrackByVersionStrategy\(tracks = \[\], strategy = "smart", fallback = null\)[\s\S]*?kind === "original"[\s\S]*?bestAudioQualityTrack[\s\S]*?sizeBytes[\s\S]*?function audioQualityRank\(track = \{\}\)[\s\S]*?lossless[\s\S]*?bitDepth[\s\S]*?sampleRate/, "Global version selection should implement smart, original, lossless-quality, and compact-file policies from real track metadata");
  assert.match(androidClient, /已合并 \$\{track\.duplicateCount\} 个相同文件[\s\S]*?\$\{formatNumber\(track\.duplicateCount\)\} 个来源/, "Android search should distinguish identical file sources from semantic song versions");
  assert.match(androidMusicStyles, /\.music-mobile-search-best-stack[\s\S]*?\.music-mobile-search-version-rail[\s\S]*?\.music-mobile-search-version-choice\.preferred[\s\S]*?\.music-mobile-search-version-choice-label i[\s\S]*?\.music-mobile-search-track-version-group/, "Android music should style preferred versions and expandable result groups as one visual system");
  assert.match(androidMusicStyles, /\.music-mobile-settings-action[\s\S]*?\.music-mobile-settings-action:disabled/, "Android music settings should expose a bounded clear-version action state");
  assert.match(androidClient, /function renderSearchContent\(\)[\s\S]*?renderLyricSearchResults\(\{ preview: true, collapsible: false \}\)[\s\S]*?renderSearchSongResults\(\{ preview: true, collapsible: false \}\)/, "Android unified search should keep lyrics and songs as compact previews without redundant collapse controls");
  assert.match(androidClient, /function renderSearchPlaybackAction\(\)[\s\S]*?播放本次搜索[\s\S]*?同名版本不重复入队[\s\S]*?随机播放[\s\S]*?shuffleSearchResults[\s\S]*?play\.addEventListener\("click", playSearchResults\)/, "Android search should expose deduplicated sequential and random playback before the long result groups");
  assert.match(androidClient, /function renderSearchResultGroup\(key, titleText, metaText, content, options = \{\}\)[\s\S]*?aria-expanded[\s\S]*?toggleSearchResultGroup\(groupKey\)/, "Android unified search groups should expose accessible expand and collapse controls");
  assert.match(androidClient, /function toggleSearchResultGroup\(key\)[\s\S]*?searchCollapsedGroups\.delete[\s\S]*?searchCollapsedGroups\.add[\s\S]*?refreshMountedSearchUi\(\)/, "Android search should retain group-collapse state while refreshing its mounted result surface");
  assert.match(androidClient, /function refreshMountedSearchResults\(query\)[\s\S]*?normalizeSearchComparison\(state\.query\)[\s\S]*?state\.searchCollapsedGroups = new Set\(\)/, "A new query should reset result groups to a discoverable expanded state");
  assert.match(androidClient, /function renderTrackList\(options = \{\}\)[\s\S]*?Array\.isArray\(options\.tracks\)[\s\S]*?showLoadMore = options\.showLoadMore !== false/, "Android unified search should be able to render bounded song previews without losing the full songs tab");
  assert.match(androidMusicStyles, /\.music-mobile-search-playback-action[\s\S]*?\.music-mobile-search-playback-actions[\s\S]*?button\.secondary[\s\S]*?\.music-mobile-search-result-group-actions[\s\S]*?\.music-mobile-search-result-group\.is-collapsed/, "Android search styling should distinguish sequential, random, and collapsed result actions");
  assert.match(androidClient, /function searchEntityScore\(type, item\)[\s\S]*?scores\.title[\s\S]*?scores\.artist[\s\S]*?scores\.album/, "Android best-match intent should compare title, artist, and album evidence");
  assert.match(androidClient, /function renderSearchScopes\(\)[\s\S]*?scope: "playlists", label: "歌单"/, "Android unified search should expose a dedicated playlist scope");
  assert.match(androidClient, /function searchPlaylistMatches\(query = state\.query\)[\s\S]*?state\.playlists[\s\S]*?state\.smartPlaylists[\s\S]*?description\.includes\(needle\)/, "Android playlist search should rank both user and smart playlists by name and description");
  assert.match(androidClient, /function renderPlaylistSearchResults\(options = \{\}\)[\s\S]*?renderPlaylistSearchCard[\s\S]*?switchSearchScope\("playlists"\)/, "Android playlist matches should render in unified previews and a full dedicated scope");
  assert.match(androidClient, /function openPlaylistSearchMatch\(match\)[\s\S]*?mode: match\.kind === "smart" \? "smart" : "playlist"[\s\S]*?resetSearch: true/, "Android playlist search results should open the matching smart or user playlist directly");
  assert.match(androidClient, /function loadLyricSearchResults\(renderGuard = null, options = \{\}\)[\s\S]*?\/api\/music\/lyrics\/search[\s\S]*?function renderLyricSearchResults\(options = \{\}\)/, "Android music search should load and render timed lyric matches");
  assert.match(androidClient, /const lyricOnlySearch = unifiedSearch && state\.searchScope === "lyrics"[\s\S]*?await loadLyricSearchResults\(renderGuard, \{ limit: 40 \}\)/, "Restored lyric routes should not wait on an irrelevant general track search");
  assert.match(androidClient, /function renderLyricSearchMatch\(match\)[\s\S]*?music-mobile-lyric-search-context[\s\S]*?formatClock\(match\.timeMs\)/, "Android lyric results should show surrounding context and the matched timestamp");
  assert.match(androidClient, /function openLyricSearchMatch\(match\)[\s\S]*?seekMs:[\s\S]*?openLyrics: true/, "Android lyric matches should open playback at the matched line");
  assert.match(androidClient, /function appendSearchHighlightedText\(target, value, item, field\)[\s\S]*?searchMatch\?\.highlights/, "Android search should render server-backed pinyin highlight terms");
  assert.match(androidClient, /function searchSortHint\(\)[\s\S]*?完整匹配优先[\s\S]*?播放次数/, "Android search should explain why relevance-ranked results appear first");
  assert.match(androidClient, /function trackSearchMatchLabel\(track, query\)[\s\S]*?歌名[\s\S]*?歌手[\s\S]*?专辑[\s\S]*?综合匹配/, "Android search rows should explain which metadata field matched the query");
  assert.match(androidClient, /function renderTrackRow\(track, index, options = \{\}\)[\s\S]*?music-mobile-track-title-line[\s\S]*?music-mobile-track-match[\s\S]*?text\.append\(titleLine, meta\)/, "Android search rows should mount their match explanation beside the visible title");
  assert.match(androidClient, /function playSearchResults\(\)[\s\S]*?preferredSearchQueue\(tracks\)[\s\S]*?state\.queue = queue[\s\S]*?openTrack\(queue\[0\]\.id/, "Android search should support playing the strategy-resolved result queue in one tap");
  assert.match(androidClient, /function shuffleSearchResults\(\)[\s\S]*?shuffleTrackQueue\(preferredSearchQueue\(tracks\)\)[\s\S]*?state\.queue = queue[\s\S]*?openTrack\(queue\[0\]\.id/, "Android search should support one-tap random playback without mutating the source result order");
  assert.match(androidClient, /track\.artist \|\| "未知歌手", highlight: true[\s\S]*?track\.album \|\| "未知专辑", highlight: true/, "Android music search should highlight matching artist and album metadata as well as titles");
  assert.match(androidClient, /SEARCH_DEBOUNCE_MS = 280[\s\S]*?scheduleLiveSearch\(search\.value\)/, "Android music search should update after a bounded typing debounce");
  assert.match(androidClient, /window\.setTimeout\(\(\) => commitMusicSearch\(query\), SEARCH_DEBOUNCE_MS\)[\s\S]*?if \(!options\.preserveSuggestions\)[\s\S]*?searchSuggestionController\?\.abort\(\);[\s\S]*?state\.searchSuggestions = \[\];[\s\S]*?state\.searchSuggestionLoading = false;/, "Android live search should retire the type-ahead overlay once the mounted result page takes over");
  assert.match(androidClient, /MUSIC_SEARCH_HISTORY_KEY[\s\S]*?rememberSearchQuery\(query\)/, "Android music search should persist explicit queries as recent searches");
  assert.match(androidClient, /search\.addEventListener\("search", \(\) => \{[\s\S]*?state\.searchSuggestions = \[\];[\s\S]*?state\.searchSuggestionIndex = -1;[\s\S]*?state\.searchSuggestionLoading = false;[\s\S]*?commitMusicSearch\(search\.value, \{ remember: true \}\)/, "Android IME search actions should clear type-ahead state and save the explicit query to recent history");
  assert.match(androidClient, /const back = symbolButton\("arrow-back", closeSearch[\s\S]*?search\.type = "search"[\s\S]*?bar\.append\(back, search\)/, "Android mounted search should use the shared back icon and the native clear affordance instead of competing text actions");
  assert.match(androidClient, /card\.className = `music-mobile-search-best-match type-\$\{best\.type\}\$\{best\.type === "artist" \? " no-art" : ""\}`[\s\S]*?if \(best\.type === "playlist"\)[\s\S]*?\} else if \(best\.type !== "artist"\) \{[\s\S]*?card\.append\(renderCover\(item, "tiny"\)\)/, "Android best-match artists should use an honest compact no-art layout without fallback artwork or fabricated initial avatars");
  assert.match(androidClient, /search\.addEventListener\("pointerdown", \(event\) => \{[\s\S]*?event\.clientX < bounds\.right - 56[\s\S]*?search\.value = "";[\s\S]*?scheduleLiveSearch\(""\)/, "Android search trailing clear affordance should remain functional in WebView instead of only rendering a native-looking mark");
  assert.match(androidClient, /region\.append\(renderSearchScopes\(\)\);[\s\S]*?if \(state\.searchScope !== "all"\) \{[\s\S]*?region\.append\(resultsHead\)/, "Android unified search should surface the best match immediately instead of placing management controls ahead of content");
  assert.match(androidClient, /function closeSearch\(\)[\s\S]*?state\.searchSuggestions = \[\];[\s\S]*?state\.searchSuggestionQuery = "";[\s\S]*?state\.searchOpen = false/, "Closing and reopening search should not leak stale type-ahead suggestions into discovery");
  assert.match(androidApp, /function replaceViewParams\(view, params = \{\}, navigation = \{\}\)[\s\S]*?currentViewParams = sanitizeViewParams[\s\S]*?replaceCurrentHistory\(\)/, "Android modules should be able to synchronize route params without rerendering the host view");
  assert.match(androidApp, /const rawSearchScope = String\(params\.searchScope \|\| params\.scope[\s\S]*?query && searchScope !== "all" \? \{ searchScope \}/, "Android music routes should retain the selected search result scope");
  assert.match(androidApp, /\["songs", "lyrics", "playlists", "all"\]\.includes\(rawSearchScope\)/, "Android host routing should preserve the playlist-only search scope");
  assert.match(androidApp, /showView,\s*replaceViewParams,\s*goBack/, "Android module navigation host should expose mounted-route synchronization");
  assert.match(androidClient, /function commitMusicSearch\(value, options = \{\}\)[\s\S]*?refreshMountedSearchResults\(query\)/, "Android live search should use the mounted result refresh path");
  assert.match(androidClient, /function refreshMountedSearchUi\(\)[\s\S]*?summary\.replaceChildren[\s\S]*?content\.replaceChildren[\s\S]*?updatePlaybackUi\(\)/, "Android live search should replace only summary and result regions while retaining the input and mini player");
  assert.match(androidClient, /function refreshMountedSearchResults\(query\)[\s\S]*?replaceViewParams\?\.\("music", musicRouteParams\(\)[\s\S]*?applyLoadedMusicData\(data\)/, "Android mounted search should synchronize the route and apply fresh data without host navigation");
  assert.match(androidClient, /SEARCH_SUGGESTION_DEBOUNCE_MS = 90[\s\S]*?function loadSearchSuggestions\(query\)[\s\S]*?\/api\/music\/suggest\?\$\{params\}[\s\S]*?buildSearchSuggestions\(query, data\)/, "Android search should use the dedicated ranked suggestion endpoint instead of three parallel list requests");
  assert.match(androidClient, /function renderSearchSuggestionsRegion\(\)[\s\S]*?role", "listbox"[\s\S]*?music-mobile-search-suggestion-group-head[\s\S]*?renderSearchSuggestion\(entry\.item, entry\.index\)/, "Android type-ahead should render ranked suggestions in labeled groups");
  assert.match(androidClient, /function handleSearchSuggestionKeydown\(event, input\)[\s\S]*?ArrowDown[\s\S]*?ArrowUp[\s\S]*?Escape[\s\S]*?activateSearchSuggestion\(selected\)/, "Android search suggestions should support keyboard selection and dismissal without replacing the mounted search input");
  assert.match(androidClient, /function buildSearchSuggestions\(query, data\)[\s\S]*?猜你想搜[\s\S]*?最近搜索[\s\S]*?buildArtistSuggestionGroup[\s\S]*?buildTrackSuggestionGroup[\s\S]*?buildAlbumSuggestionGroup/, "Android type-ahead should combine typo recovery, history, songs, artists, and albums");
  assert.match(androidClient, /function buildPlaylistSuggestionGroup\(query, seenValues\)[\s\S]*?groupLabel: "歌单"[\s\S]*?智能歌单/, "Android type-ahead should include real local playlist suggestions");
  assert.match(androidClient, /function buildTrackSuggestionGroup\(query, tracks, seenValues\)[\s\S]*?buildTrackVersionGroups\(tracks\)[\s\S]*?个版本/, "Android song suggestions should collapse same-song versions before taking limited suggestion slots");
  assert.match(androidClient, /searchRecovery: emptySearchRecovery\(\)[\s\S]*?function loadSearchRecovery\(query, signal = null\)[\s\S]*?\/api\/music\/suggest\?\$\{params\}[\s\S]*?correctedTarget/, "Android search should load unfiltered recovery candidates only for empty result states");
  assert.match(androidClient, /function shouldRenderSearchRecovery\(\)[\s\S]*?hasActiveSearchFilters\(\)[\s\S]*?searchOverview\.artists[\s\S]*?lyricSearch\.matches/, "Android no-result diagnosis should distinguish filtered songs from empty unified or lyric scopes");
  assert.match(androidClient, /function renderSearchRecovery\(\)[\s\S]*?当前筛选把结果挡住了[\s\S]*?清除筛选[\s\S]*?查看综合[\s\S]*?renderSearchRecoverySuggestions/, "Android no-result recovery should expose direct filter, scope, correction, and related-result actions");
  assert.match(androidClient, /function renderSearchRecoverySuggestions\(recovery\)[\s\S]*?\["歌曲", recovery\.tracks\][\s\S]*?\["歌手", recovery\.artists\][\s\S]*?\["专辑", recovery\.albums\]/, "Android recovery suggestions should remain grounded in real local song, artist, and album results");
  assert.match(androidClient, /function searchRecoverySuggestionCount\(recovery\)[\s\S]*?normalizeSearchComparison\(item\.value\)[\s\S]*?seen\.size/, "Android recovery copy should count the same deduplicated candidates that are visible in the suggestion rail");
  assert.match(androidClient, /function switchSearchScope\(scope\)[\s\S]*?nextScope === "lyrics"[\s\S]*?loadLyricSearchResults[\s\S]*?loadSearchRecovery\(state\.query\)/, "Android lyrics-scope transitions should backfill related recovery suggestions when lyric matches are empty");
  assert.match(androidClient, /function renderSearchHistoryChips\(items = \[\]\)[\s\S]*?music-mobile-search-history-remove[\s\S]*?removeSearchHistoryQuery\(text\)/, "Android recent searches should support removing one query without clearing the list");
  assert.match(androidClient, /function renderSearchDiscovery\(\)[\s\S]*?renderSearchShortcutBlock\(\)[\s\S]*?renderSearchHotBlock\(hotItems\)[\s\S]*?renderSearchRecentBlock\(recent\)/, "Android empty search should be a useful discovery surface instead of a sparse chip list");
  assert.match(androidClient, /function renderSearchShortcutBlock\(\)[\s\S]*?搜歌曲[\s\S]*?搜歌词[\s\S]*?搜歌手[\s\S]*?搜专辑[\s\S]*?最近播放[\s\S]*?我喜欢/, "Android search discovery should expose the main search scopes and listening collections in one tap");
  assert.match(androidClient, /function renderSearchHotBlock\(items\)[\s\S]*?track\.playCount[\s\S]*?commitMusicSearch\(track\.title, \{ remember: true \}\)/, "Android local hot search should be grounded in play counts and open a real query");
  assert.match(androidClient, /function commitMusicSearch\(value, options = \{\}\)[\s\S]*?if \(options\.remember\)[\s\S]*?input\.value = query/, "Explicit discovery and history searches should synchronize the retained visible input");
  assert.match(androidClient, /function renderSearchRecentBlock\(tracks\)[\s\S]*?playSearchDiscoveryTrack\(track, tracks\)[\s\S]*?function playSearchDiscoveryTrack[\s\S]*?state\.queue =/, "Android search discovery should let recent tracks resume directly with a coherent queue");
  assert.match(androidClient, /function focusSearchDiscoveryScope\(scope\)[\s\S]*?searchScopePlaceholder\(nextScope\)[\s\S]*?input\.focus\(\)/, "Android discovery scope shortcuts should focus the retained search input with contextual prompts");
  assert.match(androidClient, /if \(!\["artists", "albums"\]\.includes\(state\.mode\) && !state\.query\) state\.queue = visibleTracks/, "Typing a search should not replace the active playback queue");
  assert.match(androidClient, /function activateSearchResultQueue\(trackId\)[\s\S]*?state\.queue = preferredSearchQueue\(tracks\)[\s\S]*?function preferredSearchQueue\(tracks = state\.data\?\.tracks, selectedTrack = null\)[\s\S]*?currentSearchVersionGroups\(tracks\)[\s\S]*?selectedTrack\?\.id[\s\S]*?preferredTrackForVersionGroup/, "Choosing a search result should promote one globally resolved version per result group while preserving an explicitly selected version");
  assert.match(androidClient, /function renderTrackActionsSheet\(\)[\s\S]*?立即播放[\s\S]*?下一首播放[\s\S]*?加入队列[\s\S]*?收藏歌曲[\s\S]*?查看歌手[\s\S]*?查看专辑/, "Android track actions should expose the main post-search listening actions in a touch-friendly sheet");
  assert.match(androidClient, /function renderSearchQuickFilters\(\)[\s\S]*?已收藏[\s\S]*?有歌词[\s\S]*?4 分以上[\s\S]*?无损/, "Android search should expose real quick filters for local music metadata");
  assert.match(androidClient, /function searchSortHint\(\)[\s\S]*?correctedQuery[\s\S]*?已自动纠正[\s\S]*?searchMode === "phonetic"[\s\S]*?已识别拼音或首字母/, "Android search should explain typo recovery and phonetic matching in plain language");
  assert.match(androidClient, /function trackSearchMatchLabel\(track, query\)[\s\S]*?容错匹配[\s\S]*?拼音匹配/, "Android search rows should distinguish fuzzy and phonetic recall from generic matching");
  assert.match(androidClient, /function musicListQuery\(\)[\s\S]*?searchFavorite[\s\S]*?params\.set\("lyrics", "1"\)[\s\S]*?params\.set\("minRating"[\s\S]*?params\.set\("quality"/, "Android search quick filters should reach the music API query");
  assert.match(androidClient, /function renderPlaylistActionsSheet\(\)[\s\S]*?新建歌单[\s\S]*?addTrackToPlaylist\(playlist\.id, track\?\.id\)/, "Android search results should be addable directly to any playlist");
  assert.match(androidClient, /function renderSettingsSheet\(\)[\s\S]*?无缝播放[\s\S]*?歌曲交叉淡化[\s\S]*?播放 \/ 暂停淡化/, "Android music should expose distinct gapless, track-crossfade, and play-pause fade settings");
  assert.match(androidClient, /function renderSettingsTransitionPresets\(\)[\s\S]*?标准[\s\S]*?无缝[\s\S]*?柔和[\s\S]*?aria-pressed[\s\S]*?setPlaybackTransitionMode/, "Android music settings should expose plain-language one-tap transition modes");
  assert.match(androidClient, /function setPlaybackTransitionMode\(mode\)[\s\S]*?writeGaplessPreference[\s\S]*?writeCrossfadeSecondsPreference[\s\S]*?clearGaplessPreload[\s\S]*?scheduleGaplessPreload/, "Android transition presets should persist mutually exclusive playback strategies and reconcile preloading immediately");
  assert.match(androidClient, /function renderSettingsDisclosureGroup\(id, label, summaryText, body\)[\s\S]*?aria-expanded[\s\S]*?state\.settingsSection[\s\S]*?function settingsTransitionSummary\(\)[\s\S]*?柔和[\s\S]*?无缝播放/, "Android music settings should expose compact progressive-disclosure groups with plain-language summaries");
  assert.match(androidClient, /speed\.addEventListener\("change"[\s\S]*?updateSettingsDisclosureValue\("playback"[\s\S]*?function updateSettingsDisclosureValue\(id, value\)[\s\S]*?music-mobile-settings-disclosure-value/, "Android music settings should keep compact group summaries synchronized while controls change");
  assert.match(androidClient, /const resumeQueue = document\.createElement\("button"\)[\s\S]*?writeResumeQueuePreference[\s\S]*?rememberPlaybackQueue[\s\S]*?settingsRow\("恢复播放现场"/, "Android music settings should expose configurable queue restoration");
  assert.match(androidClient, /SLEEP_AFTER_CURRENT = -1[\s\S]*?SLEEP_TIMER_OPTIONS = \[SLEEP_AFTER_CURRENT[\s\S]*?function renderSettingsSheet\(\)[\s\S]*?settingsRow\([\s\S]*?"睡眠定时"[\s\S]*?按时间暂停[\s\S]*?播完当前歌曲/, "Android music settings should expose timed and end-of-current-track sleep modes");
  assert.match(androidClient, /function renderSleepTimerSheet\(\)[\s\S]*?minutes === SLEEP_AFTER_CURRENT[\s\S]*?需要先播放一首歌[\s\S]*?当前歌曲结束后暂停[\s\S]*?不再自动播放下一首/, "The sleep timer sheet should explain and safely disable end-of-track sleep when no song is active");
  assert.match(androidClient, /function renderTrackActionsSheet\(\)[\s\S]*?\{ primary: true, icon: "play-circle" \}[\s\S]*?function trackActionChoice[\s\S]*?options\.primary \? " primary"[\s\S]*?symbolButton\(options\.icon/, "Android track actions should distinguish four high-frequency real-icon choices from flat secondary rows");
  assert.match(androidClient, /target\.addEventListener\("ended"[\s\S]*?sleepAfterCurrentTimerActive\(\)[\s\S]*?expireSleepTimer\(\)[\s\S]*?state\.repeat === "one"[\s\S]*?tryPromoteGaplessPreload/, "End-of-track sleep should stop before repeat, gapless promotion, or automatic next-track playback");
  assert.match(androidClient, /function restorePlaybackQueue\(renderGuard = null\)[\s\S]*?readPlaybackQueuePreference\(\)[\s\S]*?state\.queue = queue[\s\S]*?openTrack\(trackId, \{ autoplay: false, renderGuard \}\)/, "Android music should restore the saved queue and selected track without autoplay");
  assert.match(androidClient, /function restorePlaybackQueue\(renderGuard = null\) \{\s*if \(!state\.resumeQueue \|\| state\.current \|\| state\.loading\) return false;/, "Android queue restoration should work from any restored music browse or search route");
  assert.match(androidClient, /function rememberPlaybackQueue\(\)[\s\S]*?writePlaybackQueuePreference\(\{[\s\S]*?currentTrackId:[\s\S]*?queue:/, "Android music should persist the current track and a bounded playback queue");
  assert.match(androidMusicViewSource, /const progressWriter = createMusicProgressWriter\(\{[\s\S]*?encodeURIComponent\(record\.trackId\)[\s\S]*?progressWriter\.save\(record, \{ delayMs: 800 \}\)/, "Android playback progress must call its shared per-track writer");
  assert.match(androidMusicProgressWriterSource, /playedQueue\.push\([\s\S]*?pendingProgressVersion[\s\S]*?function nextAction\([\s\S]*?isRetryableWriteBusy\(error\)/, "Android progress writer must serialize ordered played tokens with coalesced progress");
  assert.equal(androidMusicProgressWriterSource, webProgressWriterSource, "Web and Android progress ordering/retry semantics must remain identical");
  assert.match(androidClient, /function renderSettingsVolumeControl\(\)[\s\S]*?type = "range"[\s\S]*?setVolume/, "Android music settings should provide a persistent in-app volume control");
  assert.match(androidClient, /shuffle\.addEventListener\("click"[\s\S]*?writeShufflePreference[\s\S]*?scheduleGaplessPreload[\s\S]*?playbackBody\.append\(settingsRow\("随机播放"/, "Android music settings should expose shuffle and reconcile gapless preloading");
  assert.match(androidClient, /function fadeAudioVolume\(target, toVolume, durationMs\)[\s\S]*?requestAnimationFrame\(step\)/, "Android music fade should ramp volume instead of delaying playback with a timer");
  assert.match(androidClient, /function setCrossfadeSeconds\(value\)[\s\S]*?writeCrossfadeSecondsPreference[\s\S]*?state\.gapless = false[\s\S]*?scheduleGaplessPreload/, "Android crossfade should persist its duration and disable the conflicting gapless strategy");
  assert.match(androidClient, /function setGaplessPlayback\(enabled\)[\s\S]*?state\.crossfadeSeconds = 0[\s\S]*?writeCrossfadeSecondsPreference\(0\)/, "Android gapless mode should disable the conflicting track crossfade strategy");
  assert.match(androidClient, /function transitionPreloadEnabled\(\)[\s\S]*?state\.gapless \|\| state\.crossfadeSeconds > 0[\s\S]*?!state\.shuffle/, "Android transition preloading should serve gapless and crossfade modes while remaining bounded under shuffle");
  assert.match(androidClient, /function transitionPreloadEnabled\(\)[\s\S]*?!sleepAfterCurrentTimerActive\(\)[\s\S]*?function setSleepTimer\(minutes\)[\s\S]*?normalized === SLEEP_AFTER_CURRENT[\s\S]*?clearGaplessPreload\(\)[\s\S]*?cancelCrossfade\(\)/, "End-of-track sleep should disable preloaded gapless and crossfade handoffs before the current song finishes");
  assert.match(androidClient, /function expireSleepTimer\(\)[\s\S]*?afterCurrent = sleepAfterCurrentTimerActive\(\)[\s\S]*?state\.sleepMinutes = 0[\s\S]*?pauseAudio\(\)[\s\S]*?当前歌曲已播完/, "Sleep timer expiry should clear one-shot state and pause with a distinct end-of-track status");
  assert.match(androidClient, /function scheduleGaplessPreload\(\)[\s\S]*?gaplessPreloadAudio\.preload = "auto"/, "Android transition modes should preload the next queue item");
  assert.match(androidClient, /const audioEventTargets = new WeakSet\(\)[\s\S]*?function installAudioEvents\(target\)/, "Android music should bind playback events to every promotable audio element");
  assert.match(androidClient, /function tryPromoteGaplessPreload\(options = \{\}\)[\s\S]*?audio = incoming[\s\S]*?Promise\.resolve\(incoming\.play\(\)\)[\s\S]*?retireAudioElement\(outgoing\)/, "Android gapless mode should promote the ready preload instead of reopening its stream");
  assert.match(androidClient, /function crossfadeAudioPair\(outgoing, incoming, durationMs\)[\s\S]*?outgoing\.volume = fromOutgoing \* \(1 - progress\)[\s\S]*?incoming\.volume = toIncoming \* progress/, "Android track crossfade should overlap two real audio elements with opposing volume ramps");
  assert.match(androidClient, /function hydratePromotedTrack\(trackId\)[\s\S]*?fetchJson[\s\S]*?state\.current = data\.track \|\| state\.current/, "Android gapless promotion should hydrate metadata without replacing the promoted player");
  assert.match(androidMusicStyles, /\.music-mobile-search-surface\s*\{[\s\S]*?\.music-mobile-search-scopes/, "Android music search should use a dedicated mobile layout");
  assert.match(androidMusicStyles, /\.music-mobile-search-overview\s*,[\s\S]*?\.music-mobile-search-best-match[\s\S]*?\.music-mobile-search-artist-rail[\s\S]*?\.music-mobile-search-album-rail/, "Android unified search overview should have dedicated responsive styling for typed best matches");
  assert.match(androidMusicStyles, /\.music-mobile-lyric-search-results[\s\S]*?\.music-mobile-lyric-search-card[\s\S]*?\.music-mobile-lyric-search-context/, "Android lyric search should use compact context cards instead of generic song rows");
  assert.match(androidMusicStyles, /\.music-mobile-search-sort-hint[\s\S]*?\.music-mobile-track-match/, "Android search ranking explanations should have compact dedicated styling");
  assert.match(androidMusicStyles, /\.music-mobile-search-quick-filters[\s\S]*?\.music-mobile-search-quick-filters button\.active/, "Android search quick filters should use a compact horizontally scrollable mobile layout");
  assert.match(androidMusicStyles, /\.music-mobile-playlist-actions-sheet[\s\S]*?\.music-mobile-playlist-action-choice\.create/, "Android playlist selection should use a dedicated touch-friendly sheet");
  assert.match(androidMusicStyles, /\.music-mobile-track-actions-sheet[\s\S]*?\.music-mobile-track-actions-grid[\s\S]*?\.music-mobile-track-action-choice/, "Android track actions should render as a structured mobile bottom sheet");
  assert.match(androidMusicStyles, /\.music-mobile-sleep-list[\s\S]*?grid-template-columns: repeat\(2,[\s\S]*?\.music-mobile-sleep-choice\.active[\s\S]*?background: var\(--ink\)/, "Android sleep choices should use a compact two-column sheet with a neutral active state");
  assert.match(androidMusicStyles, /\.music-mobile-playlist-action-choice\.create\s*\{[\s\S]*?background: var\(--field\)[\s\S]*?color: var\(--ink\)/, "Creating a playlist should remain a neutral list action instead of a persistent green card");
  assert.match(androidMusicStyles, /\.music-mobile-track-actions-grid[\s\S]*?repeat\(4,[\s\S]*?\.music-mobile-track-action-choice\.primary[\s\S]*?background: var\(--field\)[\s\S]*?\.music-mobile-track-action-choice\.active[\s\S]*?#d72f49/, "Track actions should use four compact neutral icon tiles and reserve red for favorites");
  assert.match(androidMusicSheetsSource, /icon: "play-circle"[\s\S]*?icon: "next"[\s\S]*?icon: "add-to-queue"[\s\S]*?icon: "playlist-add"[\s\S]*?icon: "person"[\s\S]*?icon: "album"/, "Track action sheets should use bundled icon-library assets for primary and contextual actions");
  assert.match(androidMusicViewSource, /music-mobile-queue-toolbar[\s\S]*?symbolButton\("playlist-add"[\s\S]*?symbolButton\(state\.queueManageOpen \? "check" : "drag-handle"[\s\S]*?music-drag-handle\.svg/, "The playback queue should use a compact icon toolbar and real drag-handle assets");
  assert.match(androidMusicStyles, /body\.music-mobile-view \.music-mobile-track-actions-sheet,[\s\S]*?body\.music-mobile-view \.music-mobile-playlist-actions-sheet[\s\S]*?border-radius: 24px 24px 0 0/, "Track and playlist actions should override fullscreen settings with compact mobile bottom sheets");
  assert.match(androidMusicStyles, /\.music-mobile-settings-volume[\s\S]*?accent-color: var\(--music-accent\)/, "Android music volume settings should reserve the music accent for the interactive range control");
  assert.match(androidMusicStyles, /\.music-mobile-search-suggestions\s*\{[\s\S]*?focus-within[\s\S]*?\.music-mobile-search-suggestion-group[\s\S]*?\.music-mobile-search-suggestion\.active/, "Android grouped type-ahead results should render as a focused, keyboard-selectable overlay");
  assert.match(androidMusicStyles, /\.music-mobile-search-scopes\s*\{[\s\S]*?repeat\(6[\s\S]*?\.music-mobile-search-playlist-list[\s\S]*?\.music-mobile-search-playlist-card/, "Android playlist search should fit six result scopes and use touch-friendly playlist cards");
  assert.match(androidMusicStyles, /\.music-mobile-search-recovery\s*\{[\s\S]*?\.music-mobile-search-recovery-actions[\s\S]*?\.music-mobile-search-recovery-suggestions/, "Android empty search recovery should render as a touch-friendly diagnostic card and suggestion rail");
  assert.match(androidMusicStyles, /\.music-mobile-search-history-chips\s*\{[\s\S]*?\.music-mobile-search-history-remove/, "Android recent-search removal should use compact dedicated styling");
  assert.match(androidMusicStyles, /\.music-mobile-search-shortcuts[\s\S]*?grid-template-columns: repeat\(2[\s\S]*?\.music-mobile-search-hot-list[\s\S]*?\.music-mobile-search-recent-rail/, "Android search discovery should use compact shortcut, ranked, and horizontally scrollable recent layouts");
  assert.match(androidMusicStyles, /\.music-mobile-settings-list[\s\S]*?\.music-mobile-settings-group-trigger[\s\S]*?grid-template-columns: minmax\(0, 1fr\) 20px[\s\S]*?\.music-mobile-settings-disclosure-value[\s\S]*?\.music-mobile-settings-chevron/, "Android music settings should group disclosure rows into one compact native-style list with real chevrons");
  assert.match(androidMusicStyles, /\.music-mobile-settings-transition-presets[\s\S]*?repeat\(3[\s\S]*?button\.active[\s\S]*?var\(--music-accent/, "Android transition presets should render as a compact three-mode selector with accent limited to the active choice");
  assert.match(androidMusicStyles, /@media \(max-width: 600px\)[\s\S]*?\.music-mobile-settings-sheet\s*\{[\s\S]*?top: 0;[\s\S]*?max-height: none;[\s\S]*?grid-auto-rows: max-content/, "Android music settings should become a dedicated, fully scrollable full-screen surface on phones");
  assert.match(musicRuntime, /MUSIC_STREAM_CHUNK_BYTES = 2 \* 1024 \* 1024/);
  assert.match(musicRuntime, /maxRangeBytes: MUSIC_STREAM_CHUNK_BYTES/, "music streaming should cap open-ended byte ranges");
  assert.match(musicStoreSource, /music_search_short_vocab USING fts5vocab/, "short search totals should come from the FTS vocabulary instead of rescanning tracks");
  assert.match(musicStoreSource, /music_search_phonetic USING fts5[\s\S]*?music_search_phonetic_vocab USING fts5vocab/, "music search should keep a persistent phonetic FTS index and vocabulary");
  assert.match(musicStoreSource, /findPhoneticCorrection[\s\S]*?maxDistance = query\.length >= 8 \? 2 : 1/, "music typo correction should remain bounded instead of broadening into an unranked scan");
  assert.match(musicStoreSource, /export function listLyricMatches[\s\S]*?lyrics: \$\{ftsTerm\(query\)\}[\s\S]*?bestLyricLineIndex/, "lyric search should reuse the persistent music FTS index and map results to timed lines");
  assert.match(musicStoreSource, /musicIndexedSearchDocumentCount[\s\S]*?SELECT COUNT\(\*\) AS count FROM \$\{table\} WHERE \$\{table\} MATCH/, "unfiltered indexed search totals should count FTS documents without scanning a track join");
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
  store?.invalidate();
  fixture?.cleanup();
}

function createMusicScaleFixture(options = {}) {
  const ownedDirectory = createOwnedMusicFixtureDirectory(options);
  const fixtureDir = ownedDirectory.fixtureDir;
  const musicRoot = path.join(fixtureDir, "library");
  const dbPath = path.join(fixtureDir, "music.sqlite");
  const scannedAt = "2026-08-11T00:00:00.000Z";
  let completed = false;
  try {
    fs.mkdirSync(musicRoot, { recursive: true });

    const records = { artists: [], albums: [], tracks: [], lyrics: [] };
    const artists = new Map();
    const albums = new Map();
    const states = [];
    const rangePath = path.join(musicRoot, "fixture-range.flac");
    fs.writeFileSync(rangePath, Buffer.alloc(2 * 1024 * 1024 + 1, 7));
    if (options.failAt === "after-range-file") throw new Error("music scale fixture failure injection");

    function addTrack({ artist, title, album, language, genre = "流行", ext = ".mp3", codec = "mp3", sizeBytes = 640_000, durationMs = 210_000, bitDepth = 16, sampleRate = 44_100, hasLyrics = false, sourcePath = "" }) {
    let artistRecord = artists.get(artist);
    if (!artistRecord) {
      artistRecord = { id: `artist-${artists.size + 1}`, name: artist, language, tracks: [] };
      artists.set(artist, artistRecord);
    }
    const albumKey = `${artistRecord.id}\u0000${album}`;
    let albumRecord = albums.get(albumKey);
    if (!albumRecord) {
      albumRecord = { id: `album-${albums.size + 1}`, artist: artistRecord, title: album, tracks: [] };
      albums.set(albumKey, albumRecord);
    }
    const trackNumber = records.tracks.length + 1;
    const fileName = `${trackNumber}${ext}`;
    const track = {
      id: `track-${trackNumber}`,
      artistId: artistRecord.id,
      albumId: albumRecord.id,
      title,
      sortTitle: title,
      displayArtist: artist,
      albumTitle: album,
      trackNo: albumRecord.tracks.length + 1,
      discNo: 1,
      genre,
      language,
      sourceRoot: musicRoot,
      sourcePath: sourcePath || path.join(musicRoot, "virtual", fileName),
      relativePath: fileName,
      fileName,
      ext,
      sizeBytes,
      mtimeMs: 1_755_000_000_000,
      durationMs,
      codec,
      sampleRate,
      bitDepth,
      channels: 2,
      lrcPath: hasLyrics ? path.join(musicRoot, `${trackNumber}.lrc`) : "",
      hasLrc: hasLyrics ? 1 : 0,
      status: "ok",
      error: "",
      updatedAt: scannedAt
    };
    records.tracks.push(track);
    artistRecord.tracks.push(track);
    albumRecord.tracks.push(track);
    return track;
  }

    const rangeTrack = addTrack({
    artist: "Fixture Range",
    title: "Fixture Range Track",
    album: "00 Fixture Range",
    language: "英文",
    ext: ".flac",
    codec: "flac",
    sizeBytes: fs.statSync(rangePath).size,
    bitDepth: 24,
    sampleRate: 96_000,
    sourcePath: rangePath
  });
    const blueLotus = addTrack({ artist: "许巍", title: "蓝莲花", album: "中文精选", language: "中文", hasLyrics: true });
  addTrack({ artist: "周杰伦", title: "青花瓷", album: "青花瓷", language: "中文" });
  addTrack({ artist: "周杰伦", title: "周杰伦 Fixture One", album: "青花瓷", language: "中文" });
  addTrack({ artist: "周杰伦", title: "周杰伦 Fixture Two", album: "青花瓷", language: "中文" });
  addTrack({ artist: "王菲", title: "红豆", album: "中文精选", language: "中文" });
  addTrack({ artist: "刘若英", title: "后来", album: "中文精选", language: "中文" });
  addTrack({ artist: "林俊杰", title: "江南", album: "中文精选", language: "中文" });
  addTrack({ artist: "Hillsong Young & Free", title: "Wake (Live)", album: "Live", language: "英文" });
  addTrack({ artist: "Taylor Swift", title: "Love Story", album: "Fearless", language: "英文" });
  addTrack({ artist: "坂本龍一", title: "Merry Christmas Mr. Lawrence", album: "Japanese Classics", language: "日文" });
  for (const artist of ["BLACKPINK", "BIGBANG", "IU", "EXO"]) addTrack({ artist, title: `${artist} Fixture Song`, album: "Korean Hits", language: "韩文" });
  for (let index = 0; index < 300; index += 1) addTrack({ artist: "S.H.E", title: `SHE Fixture ${index + 1}`, album: "SHE Collection", language: "中文" });
  for (let index = 0; index < 90; index += 1) addTrack({ artist: `中文歌手${index + 1}`, title: `中文歌曲${index + 1}`, album: `中文专辑${index + 1}`, language: "中文" });
  for (let index = 0; index < 10_010; index += 1) addTrack({ artist: "Scale Artist", title: `a scale fixture ${index + 1}`, album: "Scale Data", language: "英文" });

  records.lyrics.push({
    trackId: blueLotus.id,
    lrcPath: blueLotus.lrcPath,
    rawText: "[00:01.000]没有什么能够阻挡\n[00:02.000]我对爱的向往\n[00:03.000]爱你",
    parsedJson: JSON.stringify([
      { timeMs: 1000, text: "没有什么能够阻挡" },
      { timeMs: 2000, text: "我对爱的向往" },
      { timeMs: 3000, text: "爱你" }
    ]),
    updatedAt: scannedAt
  });
  states.push({ trackId: blueLotus.id, favorite: 1, rating: 5, playCount: 3 });
  states.push({ trackId: rangeTrack.id, favorite: 0, rating: 4, playCount: 1 });

  for (const artist of artists.values()) {
    const artistAlbums = [...albums.values()].filter((album) => album.artist === artist);
    artist.tracks.forEach((track) => { track.artistId = artist.id; });
    records.artists.push({
      id: artist.id,
      name: artist.name,
      sortName: artist.name,
      language: artist.language,
      sourceRoot: musicRoot,
      sourcePath: path.join(musicRoot, artist.id),
      relativePath: artist.id,
      albumCount: artistAlbums.length,
      trackCount: artist.tracks.length,
      durationMs: artist.tracks.reduce((total, track) => total + track.durationMs, 0),
      sizeBytes: artist.tracks.reduce((total, track) => total + track.sizeBytes, 0),
      updatedAt: scannedAt
    });
  }
  for (const album of albums.values()) {
    records.albums.push({
      id: album.id,
      artistId: album.artist.id,
      title: album.title,
      sortTitle: album.title,
      year: "2026",
      coverPath: "",
      introPath: "",
      introText: "",
      sourceRoot: musicRoot,
      sourcePath: path.join(musicRoot, album.id),
      relativePath: album.id,
      trackCount: album.tracks.length,
      durationMs: album.tracks.reduce((total, track) => total + track.durationMs, 0),
      sizeBytes: album.tracks.reduce((total, track) => total + track.sizeBytes, 0),
      updatedAt: scannedAt
    });
  }

  const database = new DatabaseSync(dbPath);
  try {
    ensureSchema(database);
    writeScanRecords(database, records, [musicRoot], scannedAt);
    const insertState = database.prepare(`
      INSERT INTO music_track_state (track_id, favorite, rating, position_ms, duration_ms, play_count, last_played_at, updated_at)
      VALUES (?, ?, ?, 0, 0, ?, ?, ?)
    `);
    for (const state of states) insertState.run(state.trackId, state.favorite, state.rating, state.playCount, scannedAt, scannedAt);
  } finally {
    database.close();
  }

    const languageTrackCounts = Object.fromEntries(
    [...new Set(records.tracks.map((track) => track.language))]
      .sort()
      .map((language) => [language, records.tracks.filter((track) => track.language === language).length])
  );
    completed = true;
    return {
    dbPath,
    musicRoot,
    trackCount: records.tracks.length,
    artistCount: records.artists.length,
    albumCount: records.albums.length,
    languageTrackCounts,
      cleanup: ownedDirectory.cleanup
    };
  } finally {
    if (!completed) ownedDirectory.cleanup();
  }
}

function createOwnedMusicFixtureDirectory(options = {}) {
  const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "fanhao-music-scale-"));
  let ownership = null;
  let handedOff = false;
  try {
    ownership = captureMusicFixtureOwnership(fixtureDir);
    options.onFixtureDirectory?.(fixtureDir);
    handedOff = true;
    return createMusicFixtureOwner(fixtureDir, ownership);
  } finally {
    if (!handedOff && ownership) cleanupMusicFixtureDirectory(fixtureDir, ownership);
  }
}

function createMusicFixtureOwner(fixtureDir, ownership = captureMusicFixtureOwnership(fixtureDir)) {
  let cleaned = false;
  return {
    fixtureDir,
    cleanup() {
      if (cleaned) return;
      cleanupMusicFixtureDirectory(fixtureDir, ownership);
      cleaned = true;
    }
  };
}

function captureMusicFixtureOwnership(fixtureDir) {
  const tempRootPath = path.dirname(fixtureDir);
  const targetStat = fs.statSync(fixtureDir);
  return {
    fixtureDir,
    tempRootPath,
    tempRoot: canonicalMusicFixturePath(tempRootPath),
    target: canonicalMusicFixturePath(fixtureDir),
    device: String(targetStat.dev),
    inode: String(targetStat.ino)
  };
}

function cleanupMusicFixtureDirectory(fixtureDir, ownership) {
  const tempRoot = canonicalMusicFixturePath(ownership.tempRootPath);
  const target = canonicalMusicFixturePath(fixtureDir);
  const separator = path.sep;
  if (target === tempRoot) throw new Error("music scale fixture cleanup refused to remove its temp root");
  if (!path.basename(target).startsWith("fanhao-music-scale-")) throw new Error("music scale fixture cleanup refused an unexpected target name");
  if (!target.startsWith(`${tempRoot}${separator}`)) throw new Error("music scale fixture cleanup refused a target outside its temp root");
  if (tempRoot !== ownership.tempRoot || target !== ownership.target) throw new Error("music scale fixture cleanup refused a replaced path");
  const targetStat = fs.statSync(fixtureDir);
  if (String(targetStat.dev) !== ownership.device || String(targetStat.ino) !== ownership.inode) {
    throw new Error("music scale fixture cleanup refused a replacement target");
  }
  fs.rmSync(fixtureDir, { recursive: true, force: false });
}

function canonicalMusicFixturePath(value) {
  const resolved = path.normalize(fs.realpathSync.native(value)).replace(/[\\/]+$/u, "");
  return process.platform === "win32" ? resolved.toLocaleLowerCase("en-US") : resolved;
}

function verifyMusicScaleFixtureCleanupSafety() {
  const normal = createOwnedMusicFixtureDirectory();
  normal.cleanup();
  assert.equal(fs.existsSync(normal.fixtureDir), false, "a normally owned music fixture must be removed");

  let failedFixtureDir = "";
  assert.throws(
    () => createMusicScaleFixture({
      failAt: "after-range-file",
      onFixtureDirectory: (fixtureDir) => { failedFixtureDir = fixtureDir; }
    }),
    /music scale fixture failure injection/
  );
  assert.ok(failedFixtureDir, "the failure injection must create a fixture directory first");
  assert.equal(fs.existsSync(failedFixtureDir), false, "a mid-creation failure must clean its owned fixture");

  const replaced = createOwnedMusicFixtureDirectory();
  const movedPath = `${replaced.fixtureDir}-moved`;
  try {
    fs.renameSync(replaced.fixtureDir, movedPath);
    fs.mkdirSync(replaced.fixtureDir);
    const replacementSentinel = path.join(replaced.fixtureDir, "replacement-sentinel.txt");
    fs.writeFileSync(replacementSentinel, "must survive refused cleanup");
    assert.throws(() => replaced.cleanup(), /music scale fixture cleanup refused/);
    assert.equal(fs.existsSync(replacementSentinel), true, "a replacement directory must not be removed");
  } finally {
    cleanupExistingMusicFixtureDirectory(replaced.fixtureDir);
    cleanupExistingMusicFixtureDirectory(movedPath);
  }

  const linked = createOwnedMusicFixtureDirectory();
  const linkedMovedPath = `${linked.fixtureDir}-moved`;
  const outside = createOwnedMusicFixtureDirectory();
  try {
    const outsideSentinel = path.join(outside.fixtureDir, "outside-sentinel.txt");
    fs.writeFileSync(outsideSentinel, "must survive replaced-link cleanup");
    fs.renameSync(linked.fixtureDir, linkedMovedPath);
    fs.symlinkSync(outside.fixtureDir, linked.fixtureDir, process.platform === "win32" ? "junction" : "dir");
    assert.throws(() => linked.cleanup(), /music scale fixture cleanup refused/);
    assert.equal(fs.existsSync(outsideSentinel), true, "a replaced link must not reach outside its original fixture");
  } finally {
    const linkStat = fs.lstatSync(linked.fixtureDir, { throwIfNoEntry: false });
    if (linkStat?.isSymbolicLink()) fs.unlinkSync(linked.fixtureDir);
    cleanupExistingMusicFixtureDirectory(linked.fixtureDir);
    cleanupExistingMusicFixtureDirectory(linkedMovedPath);
    outside.cleanup();
  }
}

function cleanupExistingMusicFixtureDirectory(fixtureDir) {
  if (!fs.statSync(fixtureDir, { throwIfNoEntry: false })) return;
  createMusicFixtureOwner(fixtureDir).cleanup();
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
