import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createServer, request as httpRequest } from "node:http";
import { createHash, randomUUID } from "node:crypto";

// Synthetic-only localhost fixture. No proxy/fetch to a backend, database reads,
// production writes, or arbitrary filesystem HTTP routes exist here.
// Only a known manga-recovery run can receive its exact, bounded synthetic POST
// as an in-memory failure/completion receipt; every previous scene stays GET-only.
const webRoot = fs.realpathSync(path.resolve(import.meta.dirname, "../android-client/www"));
const fixtureRoot = path.join(import.meta.dirname, "fixtures");
const fixtureHtml = fs.readFileSync(path.join(fixtureRoot, "android-gallery-navigation-browser.html"));
const fixtureBootstrap = fs.readFileSync(path.join(fixtureRoot, "android-gallery-navigation-browser.mjs"));
const moduleIds = ["fanhao", "photos", "media", "novels", "short-videos", "music", "tools"];
const mime = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".ico": "image/x-icon", ".woff": "font/woff", ".woff2": "font/woff2" };
const runs = new Map();
const requests = [];
const timestamp = "2026-08-31T00:00:00.000Z";
const fixtureScenarios = new Set(["default", "photo-categories", "novel-detail-layout", "novel-categories", "music-search", "music-details", "music-playlists", "music-bottom-layout", "fanhao-search", "media-layout", "manga-layout", "manga-panels", "manga-recovery"]);
const mangaRecoveryProfiles = new Set(["immediate-failure", "delayed-failure", "retry-complete"]);
const mangaRecoveryUrl = "https://manga-recovery.invalid/comic/synthetic-recovery";
const mangaRecoveryStates = new Map();
const stressPhotoCategories = [
  "我喜欢的", "all", "[XIUREN] 秀人网", "[COS]", "内购私拍", "日本写真集", "韩国写真集", "国模",
  ...Array.from({ length: 19 }, (_, index) => `合成分类${String(index + 9).padStart(2, "0")}`),
  "合成分类28：用于核对中文长名称是否能够完整换行显示的测试分类",
  "合成分类29：用于核对横屏与窄屏下分类菜单是否保持可读和可点击的长名称",
  "合成分类30：这是用于核对分类菜单能够滚动到末尾并完整选择的最后一项超长中文名称"
].map(value => Object.freeze({ value, count: value === "all" ? 30 : 1 }));
const novelSourceRealm = "server:88888888-8888-4888-8888-888888888888";
const novelCategoryNames = [
  "武侠仙侠", "都市生活", "历史军事", "科幻未来", "悬疑推理", "奇幻冒险", "旅行随笔",
  "长分类：用于检查三百二十像素手机顶栏中小说分类名称是否能够完整显示的末项"
];
const novelTitles = ["山海之间", "春日来信", "旧城漫步", "群星入海", "雾中回声", "晴空日记", "远山行记", "在很长的旅途中寻找一座从未见过的小城"];
// The real Android module creates title-based CSS covers from these publicBook
// fields. Every path/name below is synthetic metadata, never opened or scanned.
const novelBooks = novelCategoryNames.map((category, index) => {
  const chapterCount = index + 2, charCount = chapterCount * 1800;
  return {
    id: `fixture-novel-${index + 1}`, sourceRealm: novelSourceRealm,
    catalogRevision: "77777777-7777-4777-8777-777777777777", title: novelTitles[index], author: `合成作者${index + 1}`, category,
    sourceRoot: "synthetic-novel-library", sourcePath: `synthetic-novel-${index + 1}.txt`,
    relativePath: `synthetic-novel-${index + 1}.txt`, fileName: `synthetic-novel-${index + 1}.txt`,
    sizeBytes: charCount * 3, mtimeMs: Date.parse(timestamp), encoding: "utf-8", charCount, chapterCount,
    firstChapterId: `fixture-novel-${index + 1}-chapter-1`, latestChapterId: `fixture-novel-${index + 1}-chapter-${chapterCount}`,
    latestChapterTitle: `第 ${chapterCount} 章 合成结尾`, summary: "仅用于观察手机书库的分类、标题、占位封面与排版。", tags: [], updatedAt: timestamp,
    progressRecovery: null, progress: null
  };
});
const novelSummary = {
  sourceRealm: novelSourceRealm, dbPath: "synthetic-novel-categories.sqlite", scannedAt: timestamp,
  roots: [{ path: "synthetic-novel-library", count: novelBooks.length }], recent: [],
  totals: { books: novelBooks.length, authors: novelBooks.length,
    chapters: novelBooks.reduce((sum, book) => sum + book.chapterCount, 0),
    chars: novelBooks.reduce((sum, book) => sum + book.charCount, 0),
    bytes: novelBooks.reduce((sum, book) => sum + book.sizeBytes, 0), updatedAt: timestamp },
  categories: novelCategoryNames.map(name => ({ name, count: 1 }))
};

function novelListData(url) {
  const query = String(url.searchParams.get("q") || url.searchParams.get("search") || "").trim();
  const category = String(url.searchParams.get("category") || "all"), author = String(url.searchParams.get("author") || "");
  const readingOnly = ["1", "true", "yes"].includes(String(url.searchParams.get("reading") || "").toLowerCase());
  const requestedSort = url.searchParams.get("sort") || "updated";
  const sort = ["updated", "title", "size", "chars", "chapters", "progress"].includes(requestedSort) ? requestedSort : "updated";
  const limit = Math.min(100, Math.max(1, Math.trunc(Number(url.searchParams.get("limit")) || 80)));
  const offset = Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, Math.trunc(Number(url.searchParams.get("offset")) || 0)));
  const matching = novelBooks.filter(book => !readingOnly && (category === "all" || book.category === category)
    && (!author || book.author === author) && (!query || [book.title, book.author, book.category, book.summary].some(value => value.includes(query))));
  matching.sort((left, right) => {
    const field = { size: "sizeBytes", chars: "charCount", chapters: "chapterCount" }[sort];
    const difference = field ? right[field] - left[field] : 0;
    return difference || (left.title < right.title ? -1 : left.title > right.title ? 1 : 0);
  });
  const books = matching.slice(offset, offset + limit);
  return { sourceRealm: novelSourceRealm, listRevision: "synthetic-novel-categories-v1", books,
    total: matching.length, limit, offset, nextOffset: offset + books.length,
    query, category, author, readingOnly, sort, facets: novelSummary.categories, summary: novelSummary };
}

// Separate read-only novel metadata fixture. These publicBook/publicChapter(false)
// shapes never load TXT, construct a store/database, or offer reader content.
const novelDetailRealm = "server:99999999-9999-4999-8999-999999999999";
const novelDetailSummaryText = "这是一段只用于核对手机小说详情布局的合成长简介，不对应真实小说或作者。旅途从一座几何小城开始，圆形与方形沿着彩色道路前往远方，章节目录只提供名称和字数元信息。\n\nSyntheticNovelDetailDescriptionWithoutAnyWordBreaksForCheckingNarrowPortraitAndShortLandscapeExpandedSummaryReadability\n\n在狭窄竖屏与较矮横屏中，可以展开简介核对整段文字是否完整可读，切换目录分段或搜索章节名称。所有内容都是安全合成资料，没有任何章节正文、下载文件、采集链接或数据库操作。简介尾部：合成远行在此结束。";
const novelDetailDefinitions = [
  { suffix: "cn", title: "合成小说详情这是超过四十个中文字符用于核对手机窄屏长书名完整阅读以及简介展开和章节目录布局的测试标题",
    author: "合成详情作者", category: "合成详情", summary: novelDetailSummaryText, chapterCount: 161,
    revision: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" },
  { suffix: "latin", title: "SyntheticNovelDetailContinuousLatinTitleWithoutWordBreaksForNarrowPortraitAndLandscapeReadability",
    author: "SyntheticNovelDetailAuthorWithoutWordBreaksForNarrowScreenMetadata",
    category: "SyntheticNovelDetailCategoryWithoutWordBreaksForNarrowScreenMetadata",
    summary: "这是一段无需展开的合成短简介，用来检查长英文书名、作者和分类是否能够在手机详情中完整显示。", chapterCount: 3,
    revision: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" },
  { suffix: "empty", title: "合成小说：空目录与无简介", author: "合成空目录作者", category: "合成空目录", summary: "", chapterCount: 0,
    revision: "cccccccc-cccc-4ccc-8ccc-cccccccccccc" },
  { suffix: "error", title: "合成目录错误示例", author: "合成目录测试作者", category: "合成详情",
    summary: "此书仅展示安全合成的长目录错误，不提供章节正文或任何写入。", chapterCount: 2,
    revision: "dddddddd-dddd-4ddd-8ddd-dddddddddddd" }
];
function novelDetailChapter(id, index) {
  const special = {
    1: `第1章 合成开篇这是超过四十个中文字符用于检查章节目录中长名称完整换行以及相邻章节按钮边界的测试标题`,
    80: "第80章 SyntheticCatalogChapterEightyWithoutWordBreaksForNarrowPortraitAndShortLandscapeMetadataReadability",
    81: "第81章 第二分段这是用于核对分页之后章节名称仍然完整可读并且不会挤压相邻目录控件的合成长标题",
    161: "第161章 合成目录最后一章这是用于核对末分段长章节名称可以完整阅读并且能够正确返回上一段的安全测试尾章"
  };
  return { id: `${id}-chapter-${String(index).padStart(3, "0")}`, bookId: id, index,
    title: special[index] || `第${index}章 合成目录 ${String(index).padStart(3, "0")}`,
    content: "", charCount: 1200, updatedAt: timestamp };
}
const novelDetailBooks = novelDetailDefinitions.map(({ suffix, revision, ...definition }) => {
  const id = `fixture-novel-detail-${suffix}`, count = definition.chapterCount;
  return { id, sourceRealm: novelDetailRealm, catalogRevision: revision, ...definition,
    sourceRoot: "synthetic-novel-detail-library", sourcePath: `synthetic-novel-detail-${suffix}.txt`,
    relativePath: `synthetic-novel-detail-${suffix}.txt`, fileName: `synthetic-novel-detail-${suffix}.txt`,
    sizeBytes: count * 3600, mtimeMs: Date.parse(timestamp), encoding: "utf-8", charCount: count * 1200,
    firstChapterId: count ? novelDetailChapter(id, 1).id : "", latestChapterId: count ? novelDetailChapter(id, count).id : "",
    latestChapterTitle: count ? novelDetailChapter(id, count).title : "", tags: [], updatedAt: timestamp,
    progress: null, progressRecovery: null };
});
const novelDetailChapters = new Map(novelDetailBooks.map(book => [book.id, Array.from({ length: book.chapterCount }, (_, index) => novelDetailChapter(book.id, index + 1))]));
const novelDetailSummary = {
  sourceRealm: novelDetailRealm, dbPath: "synthetic-novel-detail.sqlite", scannedAt: timestamp,
  roots: [{ path: "synthetic-novel-detail-library", count: novelDetailBooks.length }], recent: [],
  totals: { books: novelDetailBooks.length, authors: novelDetailBooks.length,
    chapters: novelDetailBooks.reduce((sum, book) => sum + book.chapterCount, 0), chars: novelDetailBooks.reduce((sum, book) => sum + book.charCount, 0),
    bytes: novelDetailBooks.reduce((sum, book) => sum + book.sizeBytes, 0), updatedAt: timestamp },
  categories: [...new Set(novelDetailBooks.map(book => book.category))].map(name => ({ name, count: novelDetailBooks.filter(book => book.category === name).length }))
};
const novelDetailCatalogError = "合成目录读取失败：此固定错误仅用于核对手机详情页中的章节目录错误排版，没有请求任何小说来源，也没有读取正文、下载文件或写入数据库。请检查较窄屏幕下的长错误能否完整换行，以及目录搜索和排序操作是否仍然可见。SyntheticCatalogFailureWithoutWordBreaksForCheckingNarrowScreenErrorReadability。合成错误末尾仍应完整显示。";
const novelDetailInteger = (value, fallback, min, max) => value === null || value === undefined || String(value).trim() === "" || !Number.isFinite(Number(value))
  ? fallback : Math.max(min, Math.min(max, Math.floor(Number(value))));
const novelDetailFold = value => String(value).replace(/[A-Z]/g, char => char.toLowerCase());
function novelDetailData(url) {
  const ok = payload => ({ status: 200, payload }), fail = (status, error) => ({ status, payload: { error } });
  if (url.pathname === "/api/novels/summary") return ok(novelDetailSummary);
  if (url.pathname === "/api/novels") {
    const query = String(url.searchParams.get("q") || url.searchParams.get("search") || "").trim();
    const category = String(url.searchParams.get("category") || "all").trim() || "all", author = String(url.searchParams.get("author") || "").trim();
    const readingOnly = ["1", "true", "yes"].includes(String(url.searchParams.get("reading") || "").toLowerCase());
    const requestedSort = url.searchParams.get("sort") || "updated", sort = ["updated", "title", "size", "chars", "chapters", "progress"].includes(requestedSort) ? requestedSort : "updated";
    const limit = novelDetailInteger(url.searchParams.get("limit"), 5000, 1, 5000), offset = novelDetailInteger(url.searchParams.get("offset"), 0, 0, Number.MAX_SAFE_INTEGER);
    const matching = novelDetailBooks.filter(book => !readingOnly && (category === "all" || category === book.category) && (!author || book.author === author)
      && (!query || [book.title, book.author, book.category, book.latestChapterTitle, book.summary].some(value => novelDetailFold(value).includes(novelDetailFold(query)))));
    matching.sort((left, right) => {
      const field = { size: "sizeBytes", chars: "charCount", chapters: "chapterCount" }[sort];
      return (field ? right[field] - left[field] : sort === "updated" || sort === "progress" ? right.updatedAt.localeCompare(left.updatedAt) : 0)
        || (novelDetailFold(left.title) < novelDetailFold(right.title) ? -1 : novelDetailFold(left.title) > novelDetailFold(right.title) ? 1 : 0);
    });
    const books = matching.slice(offset, offset + limit);
    return ok({ sourceRealm: novelDetailRealm, listRevision: "synthetic-novel-detail-v1", books, total: matching.length, limit, offset, nextOffset: offset + books.length,
      query, category, author, readingOnly, sort, facets: novelDetailSummary.categories, summary: novelDetailSummary });
  }
  const match = /^\/api\/novels\/(fixture-novel-detail-(?:cn|latin|empty|error))(\/catalog)?$/.exec(url.pathname);
  if (!match) return fail(404, "Unknown synthetic novel metadata endpoint");
  const book = novelDetailBooks.find(item => item.id === match[1]);
  if (!match[2]) return url.searchParams.get("catalog") === "0"
    ? ok({ serverClockMs: Date.parse(timestamp), sourceRealm: book.sourceRealm, catalogRevision: book.catalogRevision, book, chapters: [], chapterTotal: book.chapterCount, catalogLoaded: false })
    : fail(404, "Only explicit catalog=0 metadata is available");
  if (url.searchParams.has("sourceRealm") && url.searchParams.get("sourceRealm") !== book.sourceRealm) return fail(409, "小说库来源已变化，请重新打开");
  if (url.searchParams.has("catalogRevision") && url.searchParams.get("catalogRevision") !== book.catalogRevision) return fail(409, "目录版本已变化，请刷新目录");
  if (book.id === "fixture-novel-detail-error") return fail(503, novelDetailCatalogError);
  const query = String(url.searchParams.get("q") || "").replace(/\s+/g, " ").trim().slice(0, 80);
  const order = String(url.searchParams.get("order") || "asc").toLowerCase() === "desc" ? "desc" : "asc";
  const all = ["1", "true", "yes"].includes(String(url.searchParams.get("all") || "").toLowerCase());
  const requestedLimit = novelDetailInteger(url.searchParams.get("limit"), 120, 20, 200), requestedOffset = novelDetailInteger(url.searchParams.get("offset"), 0, 0, Number.MAX_SAFE_INTEGER);
  const anchor = novelDetailInteger(url.searchParams.get("anchor"), 0, 0, Number.MAX_SAFE_INTEGER);
  const matching = novelDetailChapters.get(book.id).filter(chapter => !query || novelDetailFold(chapter.title).includes(novelDetailFold(query)) || String(chapter.index).includes(query));
  if (order === "desc") matching.reverse();
  const filteredTotal = matching.length, limit = all ? Math.max(1, filteredTotal) : requestedLimit;
  let offset = all ? 0 : requestedOffset;
  if (!all && !query && anchor > 0 && filteredTotal > 0) {
    const clampedAnchor = Math.max(1, Math.min(filteredTotal, anchor)), position = order === "desc" ? filteredTotal - clampedAnchor : clampedAnchor - 1;
    offset = Math.floor(position / limit) * limit;
  }
  offset = Math.max(0, Math.min(filteredTotal > 0 ? Math.floor((filteredTotal - 1) / limit) * limit : 0, offset));
  const chapters = matching.slice(offset, offset + limit);
  return ok({ sourceRealm: book.sourceRealm, catalogRevision: book.catalogRevision, bookId: book.id, chapters, total: book.chapterCount,
    filteredTotal, limit, offset, query, order, all, firstIndex: chapters[0]?.index || 0, lastIndex: chapters.at(-1)?.index || 0 });
}
// Public catalogue DTOs only: no track detail, stream, download, progress or
// favorite endpoint is supplied. Existing write/media rejection stays intact.
const musicTracks = ["合成晨光", "合成远航", "合成回声（已收藏）"].map((title, index) => ({
  id: `fixture-music-track-${index + 1}`, artistId: "fixture-music-artist", albumId: "fixture-music-album",
  title, artist: "合成歌手", album: "合成晴空专辑", trackNo: index + 1, discNo: 1,
  genre: "流行", language: "国语", durationMs: 180000, codec: index ? "flac" : "mp3",
  sampleRate: 44100, bitDepth: index ? 16 : 0, channels: 2, hasLyrics: index === 2,
  streamUrl: "", downloadUrl: "", coverUrl: "/fixture/poster/music-one.svg",
  favorite: index === 2, rating: [2, 4, 5][index], positionMs: 0, playCount: 0, lastPlayedAt: "",
  fileName: `synthetic-music-${index + 1}.${index ? "flac" : "mp3"}`, sizeBytes: 1024 * 1024 * (index + 1)
}));
const musicArtists = [{ id: "fixture-music-artist", name: "合成歌手", language: "国语", albumCount: 1,
  trackCount: 3, durationMs: 540000, sizeBytes: 6 * 1024 ** 2 }];
const musicAlbums = [{ id: "fixture-music-album", artistId: "fixture-music-artist", artistName: "合成歌手",
  title: "合成晴空专辑", year: "2026", coverUrl: "/fixture/poster/music-one.svg",
  trackCount: 3, durationMs: 540000, sizeBytes: 6 * 1024 ** 2, updatedAt: timestamp }];
const musicLanguages = [{ name: "国语", trackCount: 3, artistCount: 1, albumCount: 1, durationMs: 540000, sizeBytes: 6 * 1024 ** 2 }];
const musicSummary = { dbPath: "synthetic-music-search.sqlite", roots: [], scannedAt: timestamp,
  totals: { tracks: 3, artists: 1, albums: 1, bytes: 6 * 1024 ** 2, durationMs: 540000, listenedTracks: 0, plays: 0 },
  languages: musicLanguages, recent: [], topPlayed: [] };
const musicSceneAssets = [
  ...["arrow-back", "favorite", "favorite-fill", "more", "filter-list", "sort", "check", "play", "next", "queue", "shuffle", "person", "album", "play-circle",
    "chevron-down", "previous", "pause", "repeat", "repeat-one", "download", "timer", "close",
    "drag-handle", "my-location", "arrow-upward", "arrow-downward"]
    .map(name => `assets/icons/music-${name}.svg`),
  "assets/music/default-cover-v1.jpg", "assets/icons/play.svg"
];

function musicData(url) {
  const query = String(url.searchParams.get("q") || url.searchParams.get("search") || "").trim();
  const contains = (...values) => !query || values.some(value => String(value).includes(query));
  const flag = name => ["1", "true", "yes"].includes(String(url.searchParams.get(name) || "").trim().toLowerCase());
  const limit = Math.min(100, Math.max(1, Math.trunc(Number(url.searchParams.get("limit")) || 80)));
  const offset = Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, Math.trunc(Number(url.searchParams.get("offset")) || 0)));
  const paged = (field, values, extra = {}) => ({ [field]: values.slice(offset, offset + limit), total: values.length,
    limit, offset, hasMore: offset + limit < values.length, query, summary: musicSummary, languages: musicLanguages, ...extra });
  if (url.pathname === "/api/music/summary") return musicSummary;
  if (url.pathname === "/api/music/tracks") {
    const favorite = flag("favorite"), lyrics = flag("lyrics") || flag("hasLyrics");
    const minRating = Math.max(0, Math.min(5, Number(url.searchParams.get("minRating")) || 0));
    const quality = url.searchParams.get("quality") === "lossless" ? "lossless" : "";
    const artistId = url.searchParams.get("artist") || url.searchParams.get("artistId") || "";
    const albumId = url.searchParams.get("album") || url.searchParams.get("albumId") || "";
    const tracks = musicTracks.filter(track => contains(track.title, track.artist, track.album, track.fileName)
      && (!favorite || track.favorite) && (!lyrics || track.hasLyrics) && track.rating >= minRating
      && (!quality || track.codec === "flac") && (!artistId || artistId === "all" || track.artistId === artistId)
      && (!albumId || albumId === "all" || track.albumId === albumId));
    return paged("tracks", tracks, { favorite, lyrics, minRating, quality, artistId, albumId,
      genre: "", language: "", searchMode: "", correctedQuery: "", smartId: "", smartPlaylist: null,
      sort: url.searchParams.get("sort") || "album", relevance: Boolean(query),
      artists: musicArtists, albums: musicAlbums, genres: [{ id: "流行", name: "流行", trackCount: 3, artistCount: 1, albumCount: 1, durationMs: 540000, sizeBytes: 6 * 1024 ** 2 }] });
  }
  if (url.pathname === "/api/music/artists") return paged("artists", musicArtists.filter(artist => contains(artist.name)), { sort: url.searchParams.get("sort") || "count", language: "", letter: "", searchMode: "", correctedQuery: "" });
  if (url.pathname === "/api/music/albums") return paged("albums", musicAlbums.filter(album => contains(album.title, album.artistName)), { sort: url.searchParams.get("sort") || "updated", artistId: "", genre: "", language: "", letter: "", searchMode: "" });
  if (url.pathname === "/api/music/playlists") return { playlists: [] };
  if (url.pathname === "/api/music/smart-playlists") return { smartPlaylists: [] };
  if (url.pathname === "/api/music/lyrics/search") return { query, matches: [], total: 0, limit, offset, hasMore: false, indexed: false };
  if (url.pathname === "/api/music/suggest") return { query,
    tracks: query ? musicTracks.filter(track => contains(track.title, track.artist, track.album)) : [],
    artists: query ? musicArtists.filter(artist => contains(artist.name)) : [],
    albums: query ? musicAlbums.filter(album => contains(album.title, album.artistName)) : [], searchMode: "", correctedQuery: "" };
  return null;
}

const musicDetailArtist = {
  id: "fixture-music-details-artist", name: "合成歌手：用于检查手机窄屏详情中超长姓名能否完整阅读与换行的测试演唱者 Aurora Ensemble",
  language: "国语", albumCount: 2, trackCount: 4, durationMs: 720000, sizeBytes: 4 * 1024 ** 2
};
const musicDetailAlbums = [
  { id: "fixture-music-details-covered", title: "有封面合成专辑：跨越四季与漫长旅程的现场录音纪念特别收藏版本以及从未忘记的旋律", coverUrl: "/fixture/poster/music-one.svg", year: "2026" },
  { id: "fixture-music-details-uncovered", title: "无封面合成专辑：来自远方的晚风与星光以及那些值得慢慢听完的音乐故事", coverUrl: "", year: "2025" }
].map(album => ({ ...album, artistId: musicDetailArtist.id, artistName: musicDetailArtist.name,
  trackCount: 2, durationMs: 360000, sizeBytes: 2 * 1024 ** 2, updatedAt: timestamp }));
const musicDetailTracks = musicDetailAlbums.flatMap((album, albumIndex) => [1, 2].map(trackNo => ({
  id: `fixture-music-details-track-${albumIndex * 2 + trackNo}`, artistId: musicDetailArtist.id, albumId: album.id,
  title: `合成乐章${albumIndex * 2 + trackNo}：用于核对长歌手名与长专辑名的歌曲行`, artist: musicDetailArtist.name, album: album.title,
  trackNo, discNo: 1, genre: "流行", language: "国语", durationMs: 180000,
  codec: "flac", sampleRate: 44100, bitDepth: 16, channels: 2, hasLyrics: false,
  streamUrl: "", downloadUrl: "", coverUrl: album.coverUrl, favorite: false, rating: 0,
  positionMs: 0, playCount: 0, lastPlayedAt: "", fileName: `synthetic-music-details-${albumIndex * 2 + trackNo}.flac`, sizeBytes: 1024 ** 2
})));
const musicDetailLanguages = [{ name: "国语", trackCount: 4, artistCount: 1, albumCount: 2, durationMs: 720000, sizeBytes: 4 * 1024 ** 2 }];
const musicDetailSummary = { dbPath: "synthetic-music-details.sqlite", roots: [], scannedAt: timestamp,
  totals: { tracks: 4, artists: 1, albums: 2, bytes: 4 * 1024 ** 2, durationMs: 720000, listenedTracks: 0, plays: 0 },
  languages: musicDetailLanguages, recent: [], topPlayed: [] };

function musicDetailsData(url) {
  const params = url.searchParams;
  const query = String(params.get("q") || params.get("search") || "").trim();
  const artistId = params.get("artist") || params.get("artistId") || "";
  const albumId = params.get("album") || params.get("albumId") || "";
  const language = params.get("language") || params.get("lang") || "", genre = params.get("genre") || params.get("musicGenre") || "";
  const contains = (...values) => !query || values.some(value => String(value || "").includes(query));
  const selected = (requested, value) => !requested || requested === "all" || requested === value;
  const flag = name => ["1", "true", "yes"].includes(String(params.get(name) || "").trim().toLowerCase());
  const limit = Math.min(100, Math.max(1, Math.trunc(Number(params.get("limit")) || 80)));
  const offset = Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, Math.trunc(Number(params.get("offset")) || 0)));
  const paged = (field, values, extra = {}) => ({ [field]: values.slice(offset, offset + limit), total: values.length,
    limit, offset, hasMore: offset + limit < values.length, query, summary: musicDetailSummary, languages: musicDetailLanguages, ...extra });
  const artists = selected(language, musicDetailArtist.language) ? [musicDetailArtist] : [];
  const albums = musicDetailAlbums.filter(album => selected(artistId, album.artistId)
    && selected(language, musicDetailArtist.language) && selected(genre, "流行"));
  if (url.pathname === "/api/music/summary") return musicDetailSummary;
  if (url.pathname === "/api/music/artists") return paged("artists", artists.filter(artist => contains(artist.name)), {
    sort: params.get("sort") || "count", language, letter: "", searchMode: "", correctedQuery: "" });
  if (url.pathname === "/api/music/albums") {
    const matches = albums.filter(album => contains(album.title, album.artistName));
    const sort = params.get("sort") || "updated";
    if (sort === "title") matches.sort((left, right) => left.title.localeCompare(right.title));
    if (sort === "year") matches.sort((left, right) => right.year.localeCompare(left.year));
    return paged("albums", matches, { sort, artistId, genre, language, letter: "", searchMode: "" });
  }
  if (url.pathname === "/api/music/tracks") {
    const favorite = flag("favorite"), lyrics = flag("lyrics") || flag("hasLyrics");
    const minRating = Math.max(0, Math.min(5, Number(params.get("minRating")) || 0));
    const quality = params.get("quality") === "lossless" ? "lossless" : "";
    const tracks = musicDetailTracks.filter(track => selected(artistId, track.artistId) && selected(albumId, track.albumId)
      && selected(language, track.language) && selected(genre, track.genre) && contains(track.title, track.artist, track.album, track.fileName)
      && (!favorite || track.favorite) && (!lyrics || track.hasLyrics) && track.rating >= minRating && (!quality || track.codec === "flac"));
    return paged("tracks", tracks, { artistId, albumId, genre, language, favorite, lyrics, minRating, quality,
      searchMode: "", correctedQuery: "", smartId: "", smartPlaylist: null, sort: params.get("sort") || "album", relevance: false,
      artists, albums, genres: [{ id: "流行", name: "流行", trackCount: 4, artistCount: 1, albumCount: 2, durationMs: 720000, sizeBytes: 4 * 1024 ** 2 }] });
  }
  if (url.pathname === "/api/music/playlists") return { playlists: [] };
  if (url.pathname === "/api/music/smart-playlists") return { smartPlaylists: [] };
  return null;
}

const musicPlaylistAssets = ["add-to-queue", "playlist-add", "delete"].map(name => `assets/icons/music-${name}.svg`);
const musicPlaylistTracks = musicDetailTracks.map((track, index) => ({ ...track,
  playCount: index < 2 ? 2 - index : 0,
  lastPlayedAt: index === 0 ? timestamp : index === 1 ? "2026-08-30T00:00:00.000Z" : ""
}));
const musicPlaylistHistory = musicPlaylistTracks.filter(track => track.lastPlayedAt);
const musicPlaylistSummary = { ...musicDetailSummary, dbPath: "synthetic-music-playlists.sqlite",
  totals: { ...musicDetailSummary.totals, listenedTracks: 2, plays: 3 }, recent: musicPlaylistHistory, topPlayed: musicPlaylistHistory };
const musicPlaylists = [
  { id: "fixture-music-playlist-long", name: "合成自建歌单：把晴天雨天和每一次漫长旅途都收进同一个缓缓展开的音乐故事",
    description: "这是一个只用于页面布局检查的合成歌单。把清晨的第一缕阳光、午后的安静片刻和夜晚归途中的星光放在一起，检查手机窄屏能否清楚展示长名称、完整说明、管理入口和歌曲列表。所有内容均为固定合成资料，不包含实际音频或个人播放记录。", trackCount: 4 },
  { id: "fixture-music-playlist-empty", name: "合成空歌单：留给下一段旅程的音乐收藏", description: "这里还没有歌曲，可查看空歌单的添加入口。", trackCount: 0 }
].map(playlist => ({ ...playlist, exportUrl: `/api/music/playlists/${playlist.id}/export.m3u8`, createdAt: timestamp, updatedAt: timestamp }));
// This is the real built-in ID and fixed public metadata, not a custom smart mix.
const musicPlaylistSmart = { id: "hires", name: "无损与高解析", description: "FLAC、WAV、ALAC 或 24bit/48kHz 以上音频。",
  badge: "Hi-Res", trackCount: 4, limit: 240 };

function musicPlaylistsData(url) {
  const params = url.searchParams, pathname = url.pathname;
  const facets = { artists: [musicDetailArtist], albums: musicDetailAlbums,
    genres: [{ id: "流行", name: "流行", trackCount: 4, artistCount: 1, albumCount: 2, durationMs: 720000, sizeBytes: 4 * 1024 ** 2 }] };
  if (pathname === "/api/music/summary") return musicPlaylistSummary;
  if (pathname === "/api/music/playlists") return { playlists: musicPlaylists, total: musicPlaylists.length };
  if (pathname === "/api/music/smart-playlists") return { smartPlaylists: [musicPlaylistSmart], total: 1, summary: musicPlaylistSummary };
  const playlistId = /^\/api\/music\/playlists\/(fixture-music-playlist-(?:long|empty))$/.exec(pathname)?.[1];
  if (playlistId) {
    const playlist = musicPlaylists.find(item => item.id === playlistId), tracks = playlist.trackCount ? musicPlaylistTracks : [];
    return { playlist, tracks, total: tracks.length, summary: musicPlaylistSummary, ...facets };
  }
  if (pathname === "/api/music/history") {
    const limit = Math.min(2000, Math.max(1, Math.trunc(Number(params.get("limit")) || 100)));
    const tracks = musicPlaylistHistory.slice(0, limit);
    return { tracks, total: tracks.length, limit, summary: musicPlaylistSummary, ...facets };
  }
  const catalogue = musicDetailsData(url);
  if (!catalogue) return null;
  const result = { ...catalogue, summary: musicPlaylistSummary };
  if (Array.isArray(catalogue.tracks)) {
    result.tracks = catalogue.tracks.map(track => musicPlaylistTracks.find(item => item.id === track.id) || track);
    const smartId = params.get("smart") || params.get("smartId") || "";
    if (smartId) {
      if (smartId !== musicPlaylistSmart.id) return null;
      result.smartId = smartId;
      result.smartPlaylist = { ...musicPlaylistSmart, trackCount: result.total };
    }
  }
  return result;
}
const musicBottomTracks = Array.from({ length: 200 }, (_, index) => ({ ...musicPlaylistTracks[index % musicPlaylistTracks.length],
  id: `fixture-bottom-track-${String(index + 1).padStart(3, "0")}`, title: `合成底栏布局歌曲 ${String(index + 1).padStart(3, "0")}` }));
function musicBottomLayoutData(url) {
  const base = musicPlaylistsData(url);
  if (url.pathname !== "/api/music/tracks") return base;
  const query = String(url.searchParams.get("q") || "").trim().toLowerCase();
  const tracks = musicBottomTracks.filter(track => !query || `${track.title} ${track.artist} ${track.album}`.toLowerCase().includes(query));
  const offset = Math.max(0, Math.trunc(Number(url.searchParams.get("offset")) || 0));
  const limit = Math.min(200, Math.max(1, Math.trunc(Number(url.searchParams.get("limit")) || 80)));
  return { ...base, tracks: tracks.slice(offset, offset + limit), total: tracks.length, offset, limit, hasMore: offset + limit < tracks.length,
    summary: { ...musicPlaylistSummary, totals: { ...musicPlaylistSummary.totals, tracks: musicBottomTracks.length } } };
}
const fanhaoPerson = { id: "fixture-fanhao-person-1", name: "合成人物甲", workCount: 2, sourceCount: 1, isWestern: false,
  avatarUrl: "/fixture/poster/person-one.svg", actorProfile: { displayName: "合成人物甲", gender: "female", avatarUrl: "/fixture/poster/person-one.svg" } };
const fanhaoWorks = ["合成晨光：用于检查主库搜索的收藏作品", "合成远航：用于检查主库搜索的在看作品", "合成回声：用于检查主库搜索的未下载作品"].map((title, index) => ({
  id: `fixture-fanhao-work-${index + 1}`, title: `SYN-00${index + 1} ${title}`, code: `SYN-00${index + 1}`,
  directoryName: title, category: "censored", personId: fanhaoPerson.id, personName: fanhaoPerson.name, personDisplayName: fanhaoPerson.name,
  relativePath: `synthetic-library/work-${index + 1}`, modifiedAt: ["2026-08-20T00:00:00.000Z", "2026-08-30T00:00:00.000Z", "2026-08-10T00:00:00.000Z"][index],
  favorite: index === 0, missingLocal: index === 2,
  progress: index === 1 ? { percent: 35, positionMs: 210000, durationMs: 600000, updatedAt: timestamp } : null,
  playableCount: 0, videoCount: 0, videoSize: 0, infoCount: 1, imageCount: 0,
  coverId: null, cachedCover: { coverUrl: `/fixture/poster/work-${["one", "two", "three"][index]}.svg` },
  javdbUrl: "", localMarkers: [],
  infoSummary: { code: `SYN-00${index + 1}`, title, actors: [fanhaoPerson.name], studio: "合成片商",
    releaseDate: ["2026-08-01", "2026-05-01", "2026-07-01"][index], rating: [4.8, 3.7, 4.2][index], ratingCount: [100, 50, 80][index], durationMinutes: [90, 120, 100][index] }
}));
const fanhaoPredicates = {
  all: () => true, playable: work => work.playableCount > 0, favorite: work => work.favorite,
  progress: work => Boolean(work.progress), info: work => work.infoCount > 0,
  localOnly: work => !work.missingLocal, missingLocal: work => work.missingLocal,
  rated: work => Number.isFinite(Number(work.infoSummary?.rating)), highRating: work => Number(work.infoSummary?.rating) >= 4,
  vr: () => false, missingCover: work => !work.missingLocal && !work.cachedCover?.coverUrl
};

function fanhaoSearchData(url, baseWorks = fanhaoWorks) {
  const q = String(url.searchParams.get("q") || "").trim(), category = url.searchParams.get("category") || "censored";
  const contains = (...values) => !q || values.some(value => String(value || "").includes(q));
  const source = baseWorks.filter(work => ["all", "censored"].includes(category) && contains(work.title, work.code, work.personName));
  const filter = url.searchParams.get("filter") || "all", sort = url.searchParams.get("sort") || "updated";
  const filters = filter.split(",").filter(Boolean);
  const facets = Object.fromEntries(Object.entries(fanhaoPredicates).map(([key, predicate]) => [key, source.filter(predicate).length]));
  const filtered = source.filter(work => filters.every(key => !fanhaoPredicates[key] || fanhaoPredicates[key](work)));
  const text = (left, right) => String(left || "").localeCompare(String(right || ""));
  filtered.sort((left, right) => {
    let difference = 0;
    if (sort === "updated") difference = text(right.modifiedAt, left.modifiedAt);
    if (sort === "releaseDesc") difference = text(right.infoSummary.releaseDate, left.infoSummary.releaseDate);
    if (sort === "releaseAsc") difference = text(left.infoSummary.releaseDate, right.infoSummary.releaseDate);
    if (sort === "ratingDesc") difference = right.infoSummary.rating - left.infoSummary.rating;
    if (["ratingCountDesc", "popularityDesc"].includes(sort)) difference = right.infoSummary.ratingCount - left.infoSummary.ratingCount;
    if (sort === "progress") difference = text(right.progress?.updatedAt, left.progress?.updatedAt);
    if (sort === "durationDesc") difference = right.infoSummary.durationMinutes - left.infoSummary.durationMinutes;
    return difference || text(left.title, right.title);
  });
  const limit = Math.min(100, Math.max(1, Math.trunc(Number(url.searchParams.get("limit")) || 48)));
  const offset = Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, Math.trunc(Number(url.searchParams.get("offset")) || 0)));
  const works = filtered.slice(offset, offset + limit);
  return { q, category, filter, sort, count: works.length, total: filtered.length, limit, offset, works, facets, traitFacets: {},
    categories: [{ value: "censored", label: "番号", count: source.length }],
    people: contains(fanhaoPerson.name) && ["all", "censored"].includes(category) ? [fanhaoPerson] : [] };
}

function fanhaoData(url) {
  if (url.pathname === "/api/library") return { access: { mode: "loopback" }, availableRoots: [], people: [fanhaoPerson], works: [],
    totals: { people: 1, works: 2, videos: 0, infoFiles: 2 }, user: { favoriteCount: 1, historyCount: 1, favorites: [] } };
  if (["/api/fanhao/search", "/api/search"].includes(url.pathname)) return fanhaoSearchData(url);
  if (/^\/api\/works\/fixture-fanhao-work-[123]\/move-job$/.test(url.pathname)) return { ok: true, job: null };
  const workId = /^\/api\/works\/(fixture-fanhao-work-[123])$/.exec(url.pathname)?.[1];
  if (workId) {
    const work = fanhaoWorks.find(item => item.id === workId);
    return { work: { ...work, videos: [], images: [], infos: [], infoMetadata: { fields: [{ label: "来源", value: "隔离合成目录，无实际文件" }] } } };
  }
  if (url.pathname === `/api/people/${fanhaoPerson.id}`) return { ...fanhaoSearchData(url), person: fanhaoPerson,
    filmographyCount: 3, year: "all", years: [{ value: "all", label: "全部年份", count: 3 }] };
  return null;
}
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const csp = "default-src 'self'; script-src 'self'; connect-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; style-src 'self' 'unsafe-inline'; font-src 'self' data:; object-src 'none'; worker-src 'none'; frame-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'";

function freezeSources(scenario = "default", profile = "") {
  assert(fixtureScenarios.has(scenario), "Unknown fixture scenario");
  const files = new Map();
  const pending = ["index.html", "app.js", "styles.css", ...moduleIds.map((id) => `modules/${id}/android-module.js`)];
  // These existing UI assets use runtime-composed URLs and are not discovered
  // by static import parsing. Keep an explicit per-scene allowlist, not a folder.
  if (["music-search", "music-details", "music-playlists", "music-bottom-layout"].includes(scenario)) pending.push(...musicSceneAssets);
  if (["music-playlists", "music-bottom-layout"].includes(scenario)) pending.push(...musicPlaylistAssets);
  let totalBytes = 0;
  while (pending.length) {
    const relative = pending.pop();
    if (files.has(relative)) continue;
    assert.ok(relative && !relative.startsWith("../") && !path.posix.isAbsolute(relative), `Unsafe asset: ${relative}`);
    const extension = path.extname(relative).toLowerCase();
    assert.ok(mime[extension], `Asset type is not allowed: ${relative}`);
    const absolute = fs.realpathSync(path.resolve(webRoot, relative));
    const within = path.relative(webRoot, absolute);
    assert.ok(within && !within.startsWith("..") && !path.isAbsolute(within), `Asset escapes www: ${relative}`);
    assert.ok(fs.statSync(absolute).isFile(), `Asset is not a file: ${relative}`);
    const data = fs.readFileSync(absolute);
    totalBytes += data.byteLength;
    assert.ok(files.size < 300 && totalBytes < 24 * 1024 * 1024, "Static dependency closure is unexpectedly large");
    files.set(relative, { data, sha256: sha256(data), type: mime[extension] });
    const text = data.toString("utf8");
    const references = extension === ".js"
      ? [...text.matchAll(/(?:\bfrom\s*|\bimport\s*(?:\(\s*)?)["']([^"']+)["']/g)].map((match) => match[1])
      : extension === ".css"
        ? [...text.matchAll(/@import\s+["']([^"']+)["']|url\(\s*["']?([^\s"')]+)["']?\s*\)/g)].map((match) => match[1] || match[2])
        : extension === ".html"
          ? [...text.matchAll(/(?:src|href)=["']([^"']+)["']/g)].map((match) => match[1]) : [];
    for (const reference of references) {
      if (!reference.startsWith(".")) continue;
      const target = path.posix.normalize(path.posix.join(path.posix.dirname(relative), reference.split(/[?#]/)[0]));
      if (!files.has(target)) pending.push(target);
    }
  }
  // App/module/navigation source is byte-for-byte frozen. Configuration points
  // only at this fixture; the bottom-layout scene explicitly wraps CSS env()
  // for its labelled pressure override. The index gains the isolation bootstrap.
  const config = files.get("js/config.js");
  const source = config.data.toString("utf8");
  const urlPattern = /export const DEFAULT_URL = [^;]+;/g;
  const updatePattern = /export const DEFAULT_UPDATE_URLS = Object\.freeze\(\[[\s\S]*?\]\);/g;
  assert.equal([...source.matchAll(urlPattern)].length, 1, "DEFAULT_URL replacement must be exact");
  assert.equal([...source.matchAll(updatePattern)].length, 1, "Update URL replacement must be exact");
  config.served = Buffer.from(source.replace(urlPattern, "export const DEFAULT_URL = location.origin;")
    .replace(updatePattern, "export const DEFAULT_UPDATE_URLS = Object.freeze([location.origin]);"));
  if (scenario === "music-bottom-layout") for (const [name, item] of files) {
    if (!name.endsWith(".css")) continue;
    const css = item.data.toString("utf8");
    if (css.includes("env(safe-area-inset-bottom)")) item.served = Buffer.from(css.replaceAll("env(safe-area-inset-bottom)", "var(--fixture-safe-area-bottom, env(safe-area-inset-bottom))"));
  }
  assert.equal([...files.get("index.html").data.toString("utf8").matchAll(/<head>/g)].length, 1);
  const runId = randomUUID();
  files.get("index.html").served = Buffer.from(files.get("index.html").data.toString("utf8").replace("<head>",
    `<head>\n    <script src="/fixture/browser.mjs?run=${runId}${scenario === "music-bottom-layout" ? "&scenario=music-bottom-layout" : ""}"></script>`));
  return { runId, scenario, ...(profile ? { profile } : {}), files, totalBytes, createdAt: new Date().toISOString() };
}

const movieItems = [
  { id: "fixture-movie-one", title: "合成电影：远航计划", year: 2026, category: "科幻", coverUrl: "/fixture/poster/movie-one.svg" },
  { id: "fixture-movie-two", title: "合成电影：暮色列车", year: 2025, category: "剧情", coverUrl: "/fixture/poster/movie-two.svg" }
].map((item) => ({ ...item, type: "movie", mediaKind: "movie", ext: "mp4", size: 1024 * 1024, updatedAt: timestamp, exists: false, streamUrl: "" }));
const tvSeries = { id: "fixture-series-one", seriesKey: "fixture-series-one", type: "tvSeries", title: "合成剧集：春日车站", category: "剧情", year: 2026, chapterCount: 2, episodeCount: 2, coverUrl: "/fixture/poster/tv-one.svg", updatedAt: timestamp };
const episodes = ["第01集 出发", "第02集 归来"].map((title, index) => ({
  id: `fixture-episode-${index + 1}`, title, type: "tv", mediaKind: "tv", seriesKey: tvSeries.seriesKey,
  seriesName: tvSeries.title, tvSeries: { title: tvSeries.title }, episodeNumber: index + 1,
  category: "剧情", ext: "mp4", coverUrl: tvSeries.coverUrl, size: 1024, updatedAt: timestamp, exists: false, streamUrl: ""
}));

// Public manga-service summary/detail/chapter fields only. Image bytes below
// are generated geometry, and their URLs explicitly name the isolated run:
// actual reader images use no-referrer, so Referer cannot identify their scene.
const mangaLayoutCategory = "合成漫画布局";
const mangaLayoutTitles = [
  "合成漫画布局这是超过四十个中文字符用于核对窄屏详情长题名完整阅读以及章节目录与操作按钮布局的测试书名",
  "SyntheticMangaLayoutContinuousLatinTitleWithoutWordBreaksForPortraitAndLandscapeDetailReadability",
  "合成漫画：几何小城"
];
const mangaLayoutDescription = [
  "这是一段只用于检查手机漫画详情布局的合成长简介，不对应任何真实漫画、作者或图片。故事从一座几何形状构成的城市开始，圆形、方形与三角形沿着不同颜色的道路旅行，每一章都用安全的纯色图案展示阅读页面。",
  "在狭窄竖屏和较矮横屏中，可以核对简介文字是否完整换行、章节名称是否可读、各个操作入口是否仍然容易触达。这里没有真实媒体路径、采集地址、数据库或下载内容。",
  "SyntheticDescriptionContinuousLatinWordsForCheckingUnbrokenTextWrappingWithoutAnyExternalSourceOrRealComicContent",
  "简介末尾：合成旅程在第三章结束，阅读与返回均应沿真实页面导航。"
].join("\n\n");
const mangaLayoutChapterTitles = [
  "第01话这是用于核对章节目录与阅读标题在三百二十像素小屏幕中能否完整显示的合成长中文章节名称",
  "第02话 沿着彩色道路旅行",
  "第03话 合成几何旅程的终章"
];
const mangaLayoutComics = mangaLayoutTitles.map((title, index) => ({
  id: `fixture-manga-layout-${index + 1}`, title, dirName: `synthetic-manga-layout-${index + 1}`,
  site: "合成只读资料", sourceUrl: "", author: "合成作者", description: index === 0 ? mangaLayoutDescription
    : index === 1 ? "这是用于核对短简介在窄屏封面旁也能完整阅读的合成文字圆形方形和三角形一起沿着彩色道路旅行最后平安回到几何小城并结束这次旅程" : "",
  status: "完结", region: "合成地区", category: mangaLayoutCategory, tags: ["合成", "几何布局"],
  updatedAt: timestamp, chapterCount: 3, doneChapterCount: 3, imageCount: 9, downloadedCount: 9,
  failedCount: 0, coverUrl: "/fixture/poster/manga-one.svg"
}));
function mangaLayoutImage(runId, id, chapterIndex, imageIndex) {
  return `/fixture/manga-page/${runId}/${id}/${chapterIndex}/${imageIndex}.svg`;
}
function mangaLayoutSvg(chapterIndex, imageIndex) {
  const color = ["#346c88", "#77624d", "#526e58"][chapterIndex - 1];
  return `<svg xmlns="http://www.w3.org/2000/svg" width="720" height="1080" viewBox="0 0 720 1080"><rect width="720" height="1080" fill="${color}"/><circle cx="${120 + imageIndex * 100}" cy="260" r="120" fill="#fff" opacity=".18"/><path d="M0 900 240 500 720 900v180H0" fill="#fff" opacity=".14"/><rect x="60" y="60" width="600" height="960" rx="24" fill="none" stroke="#fff" stroke-opacity=".3" stroke-width="8"/><text x="90" y="940" fill="#fff" font-family="sans-serif" font-size="42">SYNTHETIC ${chapterIndex} / ${imageIndex}</text><text x="90" y="995" fill="#fff" font-family="sans-serif" font-size="25">SAFE GEOMETRY ONLY</text></svg>`;
}
function mangaLayoutChapterSummary(runId, id, index) {
  return { index, title: mangaLayoutChapterTitles[index - 1], slug: `synthetic-chapter-${index}`, status: "done",
    imageCount: 3, downloadedCount: 3, failedCount: 0, coverUrl: mangaLayoutImage(runId, id, index, 1) };
}
function mangaLayoutData(url, runId) {
  if (url.pathname === "/api/image-library/items") {
    const query = String(url.searchParams.get("query") || url.searchParams.get("q") || "").trim();
    const category = url.searchParams.get("category") || "", sort = url.searchParams.get("sort") || "updated";
    const offset = Math.max(0, Number(url.searchParams.get("offset")) || 0), limit = Math.min(100, Math.max(1, Number(url.searchParams.get("limit")) || 40));
    const items = mangaLayoutComics.filter(comic => (!query || comic.title.includes(query)) && (!category || category === "all" || category === comic.category))
      .map(comic => ({ ...comic, type: "manga" }));
    if (sort === "title") items.sort((left, right) => left.title.localeCompare(right.title, "zh-CN"));
    return { mode: "manga", query, category, sort, items: items.slice(offset, offset + limit), total: items.length, offset, limit,
      facets: { categories: [{ value: mangaLayoutCategory, count: mangaLayoutComics.length }], people: [] } };
  }
  const match = /^\/api\/manga\/(fixture-manga-layout-[1-3])(?:\/chapters\/([1-3]))?$/.exec(url.pathname);
  if (!match) return null;
  const comic = mangaLayoutComics.find(item => item.id === match[1]);
  const chapters = [1, 2, 3].map(index => mangaLayoutChapterSummary(runId, comic.id, index));
  const cache = { root: "synthetic-manga-layout-cache", exists: true, maxBytes: 1024 ** 3, currentBytes: 0, overBytes: 0, fileCount: 0, cleanupIntervalMs: 300000, entries: [] };
  if (!match[2]) return { comic: { ...comic, createdAt: timestamp, chapters }, update: { status: "idle" }, cache };
  const index = Number(match[2]), navigationItem = item => item ? { index: item.index, title: item.title, status: item.status, imageCount: item.imageCount, downloadedCount: item.downloadedCount } : null;
  return { comic, cache, chapter: { ...chapters[index - 1], images: [1, 2, 3].map(imageIndex => ({
    index: imageIndex, name: `synthetic-${index}-${imageIndex}.svg`, localPath: `chapter-${index}/synthetic-${imageIndex}.svg`,
    contentType: "image/svg+xml", bytes: Buffer.byteLength(mangaLayoutSvg(index, imageIndex)), status: "downloaded",
    width: 720, height: 1080, url: mangaLayoutImage(runId, comic.id, index, imageIndex)
  })), navigation: { position: index, total: 3, previous: navigationItem(chapters[index - 2]), next: navigationItem(chapters[index]) } } };
}

// publicUpdateJob has message/currentChapterTitle, not separate error/stage
// fields. These records never advance or invoke a collector; normal polling
// receives the same immutable synthetic presentation on every GET.
const mangaPanelJobs = [
  { id: "fixture-manga-panels-running", kind: "update", comic: mangaLayoutComics[1], status: "running",
    startedAt: "2026-08-31T00:03:00.000Z", finishedAt: "", cachedChapters: 1, pendingChapters: 2,
    processedChapters: 1, completedChapters: 0, failedChapters: 0, currentChapterIndex: 2,
    currentChapterTitle: "SyntheticRunningChapterTitleWithoutWordBreaksForNarrowScreenDownloadProgressAndTaskInformationReadability",
    completedImages: 1, downloadedImages: 1, failedImages: 0, progressPercent: 16, exitCode: null,
    message: "正在更新第 1/2 章 · 图片 1/3" },
  { id: "fixture-manga-panels-failed", kind: "add", comic: mangaLayoutComics[0], status: "failed",
    startedAt: "2026-08-31T00:02:00.000Z", finishedAt: "2026-08-31T00:02:30.000Z", cachedChapters: 0, pendingChapters: 3,
    processedChapters: 2, completedChapters: 1, failedChapters: 1, currentChapterIndex: 2,
    currentChapterTitle: "第02话这是用于核对下载记录中当前章节长名称是否完整换行以及相邻重试按钮可达性的安全合成章节标题",
    completedImages: 1, downloadedImages: 4, failedImages: 1, progressPercent: 44, exitCode: 1,
    message: "合成任务读取失败：这一段长错误仅用于检查手机端下载记录的排版，不对应真实请求、文件或媒体。需要确认窄屏下错误能够换行，并且不会挤压书页与重试操作。SyntheticCollectorFailureWithoutWordBreaksForCheckingNarrowScreenErrorMessageWrapping。合成来源 https://manga-fixture.invalid/comic/synthetic-layout-only 不会被访问；所有更新、重试、清理和下载内容继续拒绝。错误信息末尾仍应完整可读。" },
  { id: "fixture-manga-panels-complete", kind: "update", comic: mangaLayoutComics[2], status: "complete",
    startedAt: "2026-08-31T00:01:00.000Z", finishedAt: "2026-08-31T00:01:30.000Z", cachedChapters: 1, pendingChapters: 2,
    processedChapters: 2, completedChapters: 2, failedChapters: 0, currentChapterIndex: 3,
    currentChapterTitle: "第03话 合成几何旅程的终章", completedImages: 3, downloadedImages: 6, failedImages: 0,
    progressPercent: 100, exitCode: 0, message: "更新完成，共处理 2 个章节" }
].map(({ comic, ...job }) => Object.freeze({ ...job, comicId: comic.id, comicAvailable: true, title: comic.title,
  site: comic.site, sourceUrl: `https://manga-fixture.invalid/comic/${comic.id}.html`, coverUrl: comic.coverUrl,
  totalChapters: 3, totalImages: 3, downloadedBytes: job.downloadedImages * 1024 }));
function mangaPanelsJobsData(url) {
  if (url.pathname === "/api/manga/jobs") {
    const limit = Math.max(1, Math.min(50, Number(url.searchParams.get("limit")) || 12));
    return { jobs: mangaPanelJobs.slice(0, limit) };
  }
  const match = /^\/api\/manga\/jobs\/([^/]+)$/.exec(url.pathname);
  const job = match ? mangaPanelJobs.find(item => item.id === match[1]) : null;
  return job ? { job } : null;
}

const mangaRecoveryError = "合成采集启动失败：此回执仅用于核对手机端失败提示和重试入口，没有访问任何漫画网站，也没有启动采集器、下载文件或写入数据库。请保留当前作品链接，确认错误信息可以完整阅读，再使用同一地址重试。SyntheticRecoveryFailureWithoutWordBreaksForCheckingNarrowScreenErrorMessageWrapping。合成错误信息末尾仍应完整可读。";
function mangaRecoveryJob(runId) {
  const comic = mangaLayoutComics[2];
  return { id: `fixture-manga-recovery-complete-${runId}`, kind: "add", comicId: comic.id, comicAvailable: true,
    title: comic.title, site: comic.site, sourceUrl: mangaRecoveryUrl, coverUrl: comic.coverUrl,
    status: "complete", startedAt: timestamp, finishedAt: "2026-08-31T00:00:01.000Z", totalChapters: 3,
    cachedChapters: 0, pendingChapters: 3, processedChapters: 3, completedChapters: 3, failedChapters: 0,
    currentChapterIndex: 3, currentChapterTitle: mangaLayoutChapterTitles[2], completedImages: 3, totalImages: 3,
    downloadedImages: 9, failedImages: 0, downloadedBytes: 9216, progressPercent: 100, exitCode: 0,
    message: "合成重试回执已完成，未执行网络采集" };
}
function mangaRecoveryJobsData(url, runId) {
  const job = mangaRecoveryStates.get(runId)?.job;
  if (url.pathname === "/api/manga/jobs") return { jobs: job ? [job] : [] };
  return job && url.pathname === `/api/manga/jobs/${job.id}` ? { job } : null;
}
function readSyntheticRecoveryBody(request) {
  return new Promise((resolve, reject) => {
    let bytes = 0, chunks = [], settled = false;
    const finish = (status, value) => {
      if (settled) return; settled = true; clearTimeout(timer);
      request.removeListener("data", onData); request.removeListener("end", onEnd); request.removeListener("aborted", onAborted); request.removeListener("error", onAborted);
      if (status) { chunks = []; request.resume(); reject(Object.assign(new Error("Synthetic request body rejected"), { status })); }
      else resolve(value);
    };
    const onData = chunk => { bytes += chunk.length; if (bytes > 1024) finish(413); else chunks.push(chunk); };
    const onEnd = () => finish(0, Buffer.concat(chunks).toString("utf8"));
    const onAborted = () => finish(400);
    const timer = setTimeout(() => finish(408), 2000);
    request.on("data", onData); request.on("end", onEnd); request.on("aborted", onAborted); request.on("error", onAborted);
  });
}
async function serveMangaRecovery(request, response, run, url, json, record) {
  const reply = (status, payload) => { record(status, { omitQuery: true }); if (!response.destroyed) json(status, payload); };
  if (request.headers.origin !== origin) { request.resume(); return reply(403, { error: "This synthetic POST requires the same fixture Origin" }); }
  if (url.search || !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers["content-type"] || "")
    || (request.headers["content-encoding"] && request.headers["content-encoding"] !== "identity")) {
    request.resume(); return reply(400, { error: "Only the exact synthetic JSON request is allowed" });
  }
  if (Number(request.headers["content-length"] || 0) > 1024) { request.resume(); return reply(413, { error: "Synthetic body limit exceeded" }); }
  let body;
  try { body = await readSyntheticRecoveryBody(request); }
  catch (error) { return reply(error.status || 400, { error: "Synthetic request body rejected" }); }
  // Canonical JSON is what the real fetchJson serializes. Exact comparison also
  // rejects duplicate keys, arrays, extra properties, escaped aliases and URLs.
  if (body !== JSON.stringify({ url: mangaRecoveryUrl })) return reply(400, { error: "Only the displayed synthetic URL and exact JSON shape are allowed" });
  body = null; // Never retain submitted text in run state or diagnostic records.
  const state = mangaRecoveryStates.get(run.runId);
  if (state.pending) return reply(409, { error: "Synthetic response is already pending" });
  state.attempts = Math.min(2, state.attempts + 1);
  if (run.profile === "delayed-failure") {
    state.pending = true;
    const connected = await new Promise(resolve => {
      const finish = value => { clearTimeout(timer); response.removeListener("close", closed); resolve(value); };
      const closed = () => finish(false), timer = setTimeout(() => finish(true), 3000);
      response.once("close", closed);
    });
    state.pending = false; if (!connected) return;
  }
  if (run.profile !== "retry-complete" || state.attempts === 1) return reply(503, { error: mangaRecoveryError });
  const existing = Boolean(state.job); state.job ||= mangaRecoveryJob(run.runId);
  return reply(existing ? 200 : 202, { started: !existing, existing, job: state.job });
}

// This scene changes DTO text only. The shapes follow publicMovie/publicTvSeries
// and gallery-media publicDetail; every media action remains unavailable.
const mediaLayoutChineseTitle = "合成电影布局压力这是超过四十个中文字符用于核对窄屏和横屏详情标题完整显示以及按钮布局的长片名";
const mediaLayoutLatinTitle = "SyntheticMovieLayoutContinuousLatinTitleWithoutSpacesForNarrowPortraitAndShortLandscapeReadability";
const mediaLayoutRoot = "合成资料根目录这是超过四十个中文字符用于核对文件事实字段在窄屏详情内能否正常换行并完整显示的名称";
const mediaLayoutLatinRoot = "SyntheticMediaLibraryRootWithoutAnyWordBreaksForNarrowPortraitAndShortLandscapeFileFactsReadability";
const mediaLayoutCategory = "合成影视布局";
const mediaLayoutSeriesTitle = "合成电视剧布局压力这是超过四十个中文字符用于核对剧名与分集标题在小屏幕内完整阅读和返回的系列名称";
const mediaLayoutMetadata = (title, coverUrl) => ({
  category: mediaLayoutCategory, doubanId: "", doubanUrl: "", title, originalTitle: mediaLayoutLatinTitle,
  aliases: ["只读合成资料"], officialSite: "", year: "2026", rating: 8.6, ratingCount: 128,
  ratingStars: {}, ratingBetterThan: [], directors: ["合成导演"], writers: ["合成编剧"],
  genres: ["剧情", "合成布局类型名称用于验证多行事实字段能否完整换行而不挤压相邻操作"], actors: ["合成演员"],
  countries: ["合成地区"], languages: ["中文"], pubdate: "2026-01-01", releaseDates: ["2026-01-01"],
  seasonCount: null, episodeCount: null, episodeDuration: "", durations: ["120分钟"], imdbId: "", info: {},
  detailSource: "synthetic-fixture", summary: "这些文字仅用于布局检查，不对应任何真实电影、人物或媒体文件。",
  coverUrl, fetchedAt: timestamp, updatedAt: timestamp
});
const mediaLayoutMovies = [mediaLayoutChineseTitle, mediaLayoutLatinTitle].map((title, index) => {
  const id = `fixture-media-layout-movie-${index + 1}`, coverUrl = `/fixture/poster/movie-${index ? "two" : "one"}.svg`;
  const rootLabel = index ? mediaLayoutLatinRoot : mediaLayoutRoot;
  return { id, type: "movie", mediaKind: "movie", title, category: mediaLayoutCategory, rootLabel,
    relativePath: `合成目录/${rootLabel}/${title}.mkv`, ext: "mkv", size: 2 * 1024 ** 3, updatedAt: timestamp,
    year: "2026", rating: 8.6, coverUrl, movieMetadata: { ...mediaLayoutMetadata(title, coverUrl), mediaId: id, movieTitle: title },
    tvSeries: null, exists: false, playable: false, streamUrl: "" };
});
const mediaLayoutSeries = {
  id: "fixture-media-layout-series", seriesKey: "fixture-media-layout-series", type: "tvSeriesWork", title: mediaLayoutSeriesTitle,
  category: mediaLayoutCategory, rootLabel: mediaLayoutRoot, year: "2026", rating: 8.6, episodeCount: 2, chapterCount: 2,
  coverUrl: "/fixture/poster/tv-one.svg", updatedAt: timestamp
};
const mediaLayoutTvMetadata = { ...mediaLayoutMetadata(mediaLayoutSeriesTitle, mediaLayoutSeries.coverUrl),
  seriesKey: mediaLayoutSeries.seriesKey, seriesName: mediaLayoutSeriesTitle, seasonCount: 1, episodeCount: 2, episodeDuration: "45分钟" };
const mediaLayoutEpisodes = [
  "第01集这是超过四十个中文字符用于核对电视剧分集名称完整显示以及相邻集数按钮可达性的合成长标题",
  "SyntheticEpisodeTwoContinuousLatinFilenameForPortraitAndLandscapeNavigationWithoutAnyRealVideo"
].map((title, index) => ({
  id: `fixture-media-layout-episode-${index + 1}`, type: "tv", mediaKind: "tv", title, seriesKey: mediaLayoutSeries.seriesKey,
  seriesName: mediaLayoutSeriesTitle, episodeNumber: index + 1, category: mediaLayoutCategory, rootLabel: index ? mediaLayoutLatinRoot : mediaLayoutRoot,
  relativePath: `合成目录/${index ? mediaLayoutLatinRoot : mediaLayoutRoot}/${mediaLayoutSeriesTitle}/${title}.mkv`, ext: "mkv", size: 1024 ** 3,
  updatedAt: timestamp, year: "2026", rating: 8.6, coverUrl: mediaLayoutSeries.coverUrl, tvSeries: mediaLayoutTvMetadata,
  movieMetadata: null, exists: false, playable: false, streamUrl: ""
}));
function mediaLayoutData(url) {
  if (url.pathname.startsWith("/api/gallery-media/")) {
    const id = decodeURIComponent(url.pathname.slice("/api/gallery-media/".length));
    const item = [...mediaLayoutMovies, ...mediaLayoutEpisodes].find(candidate => candidate.id === id);
    return item ? { item: { ...item, type: "media", progress: null, videos: [{ id: item.id, name: `${item.title}.mkv`,
      title: item.title, relativePath: item.relativePath, ext: item.ext, size: item.size, playable: false, progress: null }] } } : null;
  }
  if (url.pathname !== "/api/image-library/items") return null;
  const mode = url.searchParams.get("mode") || "movie", tvView = url.searchParams.get("tvView") === "episodes" ? "episodes" : "series";
  const seriesKey = url.searchParams.get("seriesKey") || "", category = url.searchParams.get("category") || "";
  const query = url.searchParams.get("q") || url.searchParams.get("query") || "", sort = url.searchParams.get("sort") || "updated";
  let items = mode === "movie" ? [...mediaLayoutMovies]
    : tvView === "episodes" ? seriesKey === mediaLayoutSeries.seriesKey ? [...mediaLayoutEpisodes] : [] : [mediaLayoutSeries];
  if (category) items = items.filter(item => item.category === category);
  if (query) items = items.filter(item => item.title.includes(query));
  if (sort === "title") items.sort((a, b) => a.title.localeCompare(b.title, "zh-CN"));
  const offset = Math.max(0, Number(url.searchParams.get("offset")) || 0), limit = Math.min(240, Math.max(1, Number(url.searchParams.get("limit")) || 40));
  return { mode, query, category, tvView, seriesKey, sort, items: items.slice(offset, offset + limit), total: items.length, offset, limit,
    facets: { categories: [{ value: mediaLayoutCategory, count: mode === "movie" || tvView === "episodes" ? 2 : 1 }], people: [] },
    seriesSummary: seriesKey === mediaLayoutSeries.seriesKey ? { ...mediaLayoutSeries, count: 2 } : null };
}

function apiData(url, scenario = "default", runId = "") {
  const pathname = url.pathname;
  if (scenario === "manga-recovery" && (pathname === "/api/manga/jobs" || pathname.startsWith("/api/manga/jobs/"))) return mangaRecoveryJobsData(url, runId);
  if (scenario === "manga-panels" && (pathname === "/api/manga/jobs" || pathname.startsWith("/api/manga/jobs/"))) return mangaPanelsJobsData(url);
  if (["manga-layout", "manga-panels", "manga-recovery"].includes(scenario) && ((pathname === "/api/image-library/items" && url.searchParams.get("mode") === "manga")
    || /^\/api\/manga\/(?!storage(?:$|\/)|jobs(?:$|\/))/.test(pathname))) return mangaLayoutData(url, runId);
  if (scenario === "media-layout" && (pathname.startsWith("/api/gallery-media/")
    || (pathname === "/api/image-library/items" && ["movie", "tv", "media"].includes(url.searchParams.get("mode"))))) return mediaLayoutData(url);
  if (scenario === "fanhao-search") {
    const data = fanhaoData(url);
    if (data) return data;
  }
  if (scenario === "novel-categories") {
    if (pathname === "/api/novels") return novelListData(url);
    if (pathname === "/api/novels/summary") return novelSummary;
  }
  if (scenario === "music-search" && pathname.startsWith("/api/music/")) return musicData(url);
  if (scenario === "music-details" && pathname.startsWith("/api/music/")) return musicDetailsData(url);
  if (scenario === "music-playlists" && pathname.startsWith("/api/music/")) return musicPlaylistsData(url);
  if (scenario === "music-bottom-layout" && pathname.startsWith("/api/music/")) return musicBottomLayoutData(url);
  if (pathname === "/api/modules") return { modules: [] };
  // Match the read DTOs owned by accounts/service, computer-control/service,
  // image-reader-cache-service and manga-service. These fixed values never
  // instantiate those services, inspect host paths or enable an operation.
  if (pathname === "/api/accounts/status") return {
    user: null, registrationEnabled: true, invitationRequired: true,
    accountLoginRequired: false, setupAvailable: false
  };
  if (pathname === "/api/system/control") return {
    ok: true, platform: "unsupported", platformLabel: "隔离夹具（不支持电脑控制）",
    actions: [], lastDispatch: null
  };
  if (pathname === "/api/image-reader/cache") return {
    cache: {
      root: "synthetic-image-reader-cache", exists: true, maxBytes: 2 * 1024 ** 3,
      currentBytes: 0, overBytes: 0, fileCount: 0, cleanupIntervalMs: 5 * 60 * 1000, entries: []
    },
    config: { imageReaderCacheMaxBytes: 2 * 1024 ** 3 }
  };
  if (pathname === "/api/manga/storage") return { storage: {
    root: "synthetic-manga-library", exists: true, scannedAt: timestamp,
    comicCount: 0, chapterCount: 0, imageCount: 0, downloadedCount: 0, failedCount: 0,
    bytes: 0, fileCount: 0, totalBytes: 0, diskFreeBytes: 0,
    trash: { itemCount: 0, bytes: 0, fileCount: 0, items: [] }
  } };
  if (pathname === "/api/library") return { people: [], totals: { people: 0, videos: 0, works: 0, infoFiles: 0 }, user: { historyCount: 0, favorites: [] }, availableRoots: [], access: {} };
  if (pathname === "/api/history") return { works: [], total: 0 };
  if (pathname === "/api/image-library/summary") return { totals: { photoAlbums: 1, mangaComics: 1, movieVideos: 2, tvVideos: 2 }, channels: [], photoRoots: [], mediaRoots: [], scannedAt: timestamp };
  if (["/api/novels/summary", "/api/music/summary", "/api/short-videos/summary"].includes(pathname)) return { totals: {}, items: [] };
  if (pathname === "/api/manga/jobs") return { jobs: [] };
  if (pathname === "/api/android/update") return { available: false, message: "隔离夹具不提供 APK", versionCode: 0 };
  if (pathname.startsWith("/api/gallery-media/")) {
    const id = decodeURIComponent(pathname.slice("/api/gallery-media/".length));
    const item = [...movieItems, ...episodes].find((candidate) => candidate.id === id);
    return item ? { item } : null;
  }
  if (pathname !== "/api/image-library/items") return null;
  const mode = url.searchParams.get("mode") || "photo";
  if (!["photo", "manga", "movie", "tv", "media"].includes(mode)) return null;
  const query = url.searchParams.get("query") || "";
  const collection = url.searchParams.get("collection") || "";
  const seriesKey = url.searchParams.get("seriesKey") || "";
  const tvView = url.searchParams.get("tvView") === "episodes" ? "episodes" : "series";
  const category = url.searchParams.get("category") || (mode === "photo" ? "我喜欢的" : "");
  const photoView = collection ? "albums" : "collections";
  let items;
  if (mode === "movie") items = movieItems;
  else if (mode === "tv" || mode === "media") items = tvView === "episodes" ? (seriesKey === tvSeries.seriesKey ? episodes : []) : [tvSeries];
  else if (mode === "manga") items = [{ id: "fixture-manga", type: "manga", title: "合成韩漫：晴空日记", chapterCount: 0, imageCount: 0, coverUrl: "/fixture/poster/manga-one.svg" }];
  else items = collection
    ? [{ id: "fixture-photo-album", type: "photo", title: "合成套图：湖畔晨光", category, imageCount: 0, coverUrl: "/fixture/poster/photo-one.svg" }]
    : [{ type: "photoCollectionCategory", category, collections: [{ id: "fixture-photo", collectionId: "fixture-photo", type: "photoCollection", title: "合成套图合集", category, albumCount: 1, coverUrl: "/fixture/poster/photo-one.svg" }] }];
  if (query) items = items.filter((item) => String(item.title || "").includes(query));
  const offset = Math.max(0, Number(url.searchParams.get("offset")) || 0);
  const limit = Math.min(100, Math.max(1, Number(url.searchParams.get("limit")) || 40));
  return { mode, query, category, collection, photoView, tvView, seriesKey, sort: url.searchParams.get("sort") || "updated",
    items: items.slice(offset, offset + limit), total: items.length, offset, limit,
    facets: { categories: mode === "photo" && scenario === "photo-categories" ? stressPhotoCategories : [], people: [] },
    collectionSummary: collection ? { title: "合成套图合集", category, count: 1 } : null,
    seriesSummary: seriesKey ? { ...tvSeries, count: 2 } : null };
}

function describeRun(run) {
  // Use the actual shell's existing hash route; the isolation bootstrap does
  // not need to overwrite last-view or module state for this scene.
  const initialHash = ["novel-categories", "novel-detail-layout"].includes(run.scenario) ? "#novels"
    : run.scenario === "music-search" ? `#music?mode=library&dashboard=0&query=${encodeURIComponent("合成")}`
    : run.scenario === "music-details" ? "#music?mode=albums&dashboard=0"
    : run.scenario === "music-playlists" ? "#music?mode=library"
    : run.scenario === "music-bottom-layout" ? "#music?mode=library&dashboard=0"
    : run.scenario === "media-layout" ? "#channel?mode=movie"
    : ["manga-layout", "manga-panels", "manga-recovery"].includes(run.scenario) ? "#channel?mode=manga"
    : run.scenario === "fanhao-search" ? `#search?query=${encodeURIComponent("合成")}&category=censored` : "";
  return { runId: run.runId, scenario: run.scenario, ...(run.profile ? { profile: run.profile } : {}), url: `/run/${run.runId}/www/index.html${initialHash}`, createdAt: run.createdAt, totalBytes: run.totalBytes,
    files: [...run.files].map(([name, item]) => ({ name, sha256: item.sha256, servedSha256: sha256(item.served || item.data), transformed: Boolean(item.served) })) };
}

let origin;
const server = createServer((request, response) => {
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("Content-Security-Policy", csp);
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("Referrer-Policy", "same-origin");
  let url;
  try { url = new URL(request.url, origin); } catch { response.writeHead(400).end(); return; }
  const send = (status, type, body) => { response.writeHead(status, { "Content-Type": `${type}; charset=utf-8` }); response.end(body); };
  const json = (status, body) => send(status, "application/json", JSON.stringify(body, null, 2));
  let referencedRun = "";
  try {
    const referrer = new URL(request.headers.referer || origin, origin);
    if (referrer.origin === origin) referencedRun = /^\/run\/([a-f0-9-]{36})\//.exec(referrer.pathname)?.[1] || "";
  }
  catch { /* An invalid diagnostic Referer must never crash the fixture. */ }
  const record = (status, { omitQuery = false } = {}) => {
    requests.push({ sequence: requests.length ? requests.at(-1).sequence + 1 : 1, runId: referencedRun, method: request.method, path: url.pathname, query: omitQuery ? {} : Object.fromEntries(url.searchParams), status });
    if (requests.length > 4000) requests.shift();
  };
  if (request.headers.host !== new URL(origin).host || (request.headers.origin && request.headers.origin !== origin) || request.headers["sec-fetch-site"] === "cross-site") {
    record(403); return json(403, { error: "Only this loopback fixture origin is allowed" });
  }
  if (request.method === "POST" && url.pathname === "/fixture/new-run") {
    const scenario = url.searchParams.get("scenario") ?? "default", profile = url.searchParams.get("profile") || "";
    if ([...url.searchParams.keys()].some(key => !["scenario", "profile"].includes(key)) || url.searchParams.getAll("scenario").length > 1 || url.searchParams.getAll("profile").length > 1 || !fixtureScenarios.has(scenario)
      || (scenario === "manga-recovery" ? !mangaRecoveryProfiles.has(profile) : url.searchParams.has("profile"))) {
      return json(400, { error: "Unknown or ambiguous fixture scenario" });
    }
    if (runs.size >= 12) return json(429, { error: "运行数量已达 12，请重启夹具（不删除浏览器数据）" });
    try { const run = freezeSources(scenario, profile); runs.set(run.runId, run); if (scenario === "manga-recovery") mangaRecoveryStates.set(run.runId, { attempts: 0, job: null, pending: false }); return json(200, describeRun(run)); }
    catch (error) { return json(500, { error: error.message }); }
  }
  if (request.method === "POST" && url.pathname === "/api/manga/add" && runs.get(referencedRun)?.scenario === "manga-recovery") {
    void serveMangaRecovery(request, response, runs.get(referencedRun), url, json, record).catch(() => { record(500, { omitQuery: true }); if (!response.destroyed) json(500, { error: "Synthetic recovery response failed" }); });
    return;
  }
  if (request.method !== "GET") { record(405); return json(405, { error: "Synthetic fixture is read-only" }); }
  if (url.pathname === "/") return send(200, "text/html", fixtureHtml);
  if (url.pathname === "/fixture/browser.mjs") return send(200, "text/javascript", fixtureBootstrap);
  if (url.pathname === "/fixture/requests") {
    const runId = url.searchParams.get("run");
    return json(200, { scope: "Synthetic API only; no production proxy", runs: [...runs.values()].filter((run) => !runId || run.runId === runId).map(describeRun), requests: requests.filter((entry) => !runId || entry.runId === runId) });
  }
  const poster = /^\/fixture\/poster\/(movie-one|movie-two|tv-one|photo-one|manga-one|music-one|work-one|work-two|work-three|person-one)\.svg$/.exec(url.pathname);
  if (poster) {
    const color = { "movie-one": "#1d5774", "movie-two": "#704239", "tv-one": "#346652", "photo-one": "#417b7c", "manga-one": "#665189", "music-one": "#5b668c",
      "work-one": "#416c88", "work-two": "#65734d", "work-three": "#8b635b", "person-one": "#5c6985" }[poster[1]];
    return send(200, "image/svg+xml", `<svg xmlns="http://www.w3.org/2000/svg" width="360" height="480" viewBox="0 0 360 480"><rect width="360" height="480" fill="${color}"/><circle cx="240" cy="140" r="94" fill="#fff" opacity=".12"/><path d="M0 420 150 240 360 420v60H0" fill="#fff" opacity=".16"/><text x="24" y="400" fill="#fff" font-family="sans-serif" font-size="28">SYNTHETIC</text><text x="24" y="440" fill="#fff" font-family="sans-serif" font-size="22">${poster[1]}</text></svg>`);
  }
  const mangaPage = /^\/fixture\/manga-page\/([a-f0-9-]{36})\/(fixture-manga-layout-[1-3])\/([1-3])\/([1-3])\.svg$/.exec(url.pathname);
  if (mangaPage && ["manga-layout", "manga-panels", "manga-recovery"].includes(runs.get(mangaPage[1])?.scenario) && (!referencedRun || referencedRun === mangaPage[1]) && !url.search) {
    record(200); return send(200, "image/svg+xml", mangaLayoutSvg(Number(mangaPage[3]), Number(mangaPage[4])));
  }
  if (url.pathname.startsWith("/api/")) {
    if (url.searchParams.has("scenario")) { record(400); return json(400, { error: "Choose the fixture scenario from the launcher, not API query parameters" }); }
    if (runs.get(referencedRun)?.scenario === "novel-detail-layout" && (url.pathname === "/api/novels" || url.pathname.startsWith("/api/novels/"))) {
      const result = novelDetailData(url); record(result.status); return json(result.status, result.payload);
    }
    const result = apiData(url, runs.get(referencedRun)?.scenario || "default", referencedRun);
    record(result ? 200 : 404);
    return json(result ? 200 : 404, result || { error: "Unknown synthetic API; no proxy fallback" });
  }
  const asset = /^\/run\/([a-f0-9-]{36})\/www\/(.+)$/.exec(url.pathname);
  if (asset) {
    let relative;
    try { relative = decodeURIComponent(asset[2]); } catch { return json(400, { error: "Invalid asset path" }); }
    const item = runs.get(asset[1])?.files.get(relative);
    if (item) return send(200, item.type, item.served || item.data);
  }
  record(404);
  return json(404, { error: "Not in the frozen static allowlist" });
});

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
origin = `http://127.0.0.1:${server.address().port}`;
if (process.argv.includes("--smoke-novel-detail")) {
  let checks = 0;
  const check = (condition, message) => { assert.ok(condition, message); checks++; };
  try {
    const launcher = await (await fetch(origin)).text();
    check(launcher.includes('data-fixture-scenario="novel-detail-layout"') && launcher.includes("小说详情与章节目录（长书名、简介与分页）"), "visible independent novel detail launcher");
    const runResponse = await fetch(`${origin}/fixture/new-run?scenario=novel-detail-layout`, { method: "POST" });
    check(runResponse.status === 200, "novel detail creates a fresh frozen run");
    const run = await runResponse.json(), headers = { Referer: new URL(run.url, origin).href };
    check(new URL(run.url, origin).hash === "#novels", "novel detail scene uses the real book-list route");
    const defaultRun = await (await fetch(`${origin}/fixture/new-run`, { method: "POST" })).json();
    const oldRun = await (await fetch(`${origin}/fixture/new-run?scenario=novel-categories`, { method: "POST" })).json();
    const defaultHeaders = { Referer: new URL(defaultRun.url, origin).href }, oldHeaders = { Referer: new URL(oldRun.url, origin).href };
    const response = await fetch(`${origin}/api/novels?limit=80`, { headers }), list = await response.json();
    check(response.status === 200 && list.books.length === 4 && list.total === 4 && list.sourceRealm === novelDetailRealm, "four known publicBook summaries share their scene owner");
    const byId = new Map(list.books.map(book => [book.id, book]));
    const cn = byId.get("fixture-novel-detail-cn"), latin = byId.get("fixture-novel-detail-latin"), empty = byId.get("fixture-novel-detail-empty"), errorBook = byId.get("fixture-novel-detail-error");
    check(cn.title.length > 40 && cn.summary.length > 150 && /[A-Za-z]{100,}/.test(cn.summary) && cn.chapterCount === 161, "long Chinese title and expanded-summary token cover a three-page catalogue");
    check(/^[A-Za-z]{64,}$/.test(latin.title) && /^[A-Za-z]{60,}$/.test(latin.author) && /^[A-Za-z]{60,}$/.test(latin.category)
      && latin.summary.length < 150 && latin.chapterCount === 3, "Latin title, author and category stress actual metadata spans");
    check(empty.summary === "" && empty.chapterCount === 0 && empty.firstChapterId === "" && empty.latestChapterId === "", "empty book has no invented summary or chapter identity");
    const summary = await (await fetch(`${origin}/api/novels/summary`, { headers })).json();
    check(summary.sourceRealm === list.sourceRealm && summary.totals.books === 4 && summary.totals.chapters === 166, "detail list/summary ownership and counts agree");
    const catalogue = async (book, query) => {
      const params = new URLSearchParams(query);
      if (!params.has("sourceRealm")) params.set("sourceRealm", book.sourceRealm);
      if (!params.has("catalogRevision")) params.set("catalogRevision", book.catalogRevision);
      return fetch(`${origin}/api/novels/${book.id}/catalog?${params}`, { headers });
    };
    for (const book of list.books) {
      const path = `/api/novels/${book.id}`;
      const metaResponse = await fetch(`${origin}${path}?catalog=0`, { headers }), meta = await metaResponse.json();
      check(metaResponse.status === 200 && JSON.stringify(meta.book) === JSON.stringify(book) && meta.sourceRealm === book.sourceRealm
        && meta.catalogRevision === book.catalogRevision && meta.catalogLoaded === false && meta.chapterTotal === book.chapterCount
        && meta.chapters.length === 0 && meta.serverClockMs > 0 && book.progress === null && book.progressRecovery === null, "bookMeta matches the owning partial-detail DTO");
      check((await fetch(`${origin}${path}`, { headers })).status === 404, "full-detail compatibility is not implicitly exposed");
      for (const otherHeaders of [defaultHeaders, oldHeaders]) check((await fetch(`${origin}${path}?catalog=0`, { headers: otherHeaders })).status === 404, "known detail IDs remain unavailable in previous scenes");
      check((await catalogue(book, { sourceRealm: "server:00000000-0000-4000-8000-000000000000" })).status === 409, "wrong catalogue source is rejected before content or error presentation");
      check((await catalogue(book, { catalogRevision: "00000000-0000-4000-8000-000000000000" })).status === 409, "wrong catalogue revision is rejected before content or error presentation");
      for (const target of [path, `${path}/catalog`, `${path}/progress`, "/api/novels/upload", "/api/novels/import"]) {
        for (const method of ["POST", "PATCH", "DELETE"]) check((await fetch(`${origin}${target}`, { method, headers })).status === 405, "novel detail scene offers no mutation endpoint");
      }
      for (const target of [`${path}/chapters/1`, `${path}/download`, `/media/novels/${book.id}`]) check((await fetch(`${origin}${target}`, { headers })).status === 404, "reader text and download/media bytes remain unavailable");
    }
    const first = await (await catalogue(cn, { limit: "80", order: "asc", anchor: "1" })).json();
    check(first.bookId === cn.id && first.sourceRealm === cn.sourceRealm && first.catalogRevision === cn.catalogRevision && first.chapters.length === 80
      && first.total === 161 && first.filteredTotal === 161 && first.limit === 80 && first.offset === 0 && first.firstIndex === 1 && first.lastIndex === 80, "initial catalogue page uses exact top-level identity and 80-entry boundaries");
    check(first.chapters.every((chapter, index) => chapter.bookId === cn.id && chapter.index === index + 1 && chapter.id === novelDetailChapter(cn.id, index + 1).id
      && chapter.content === "" && chapter.charCount === 1200 && chapter.updatedAt === timestamp) && first.chapters[0].id === cn.firstChapterId, "chapters are stable publicChapter(false) metadata only");
    const middle = await (await catalogue(cn, { limit: "80", offset: "80" })).json(), tail = await (await catalogue(cn, { limit: "80", offset: "160" })).json();
    check(middle.chapters.length === 80 && middle.firstIndex === 81 && middle.lastIndex === 160 && middle.offset === 80, "second catalogue page is 81 through 160");
    check(tail.chapters.length === 1 && tail.firstIndex === 161 && tail.lastIndex === 161 && tail.chapters[0].id === cn.latestChapterId, "last catalogue page preserves the final chapter identity");
    const clamped = await (await catalogue(cn, { limit: "80", offset: "999999" })).json();
    check(clamped.offset === 160 && clamped.chapters[0].index === 161, "oversized offsets clamp to the real last page");
    const descending = await (await catalogue(cn, { limit: "80", order: "desc", offset: "0" })).json();
    check(descending.firstIndex === 161 && descending.lastIndex === 82 && descending.chapters.every((chapter, index) => chapter.index === 161 - index), "descending order sorts by numeric chapter index");
    const anchoredDesc = await (await catalogue(cn, { limit: "80", order: "desc", anchor: "1" })).json();
    check(anchoredDesc.offset === 160 && anchoredDesc.chapters.length === 1 && anchoredDesc.chapters[0].index === 1, "descending anchor 1 selects its owning last segment");
    const searched = await (await catalogue(cn, { limit: "80", q: "  161  ", anchor: "1" })).json();
    check(searched.query === "161" && searched.filteredTotal === 1 && searched.total === 161 && searched.offset === 0 && searched.chapters[0].index === 161, "query normalization/filtering ignores an anchor and retains total book count");
    const latinSearch = await (await catalogue(cn, { q: "syntheticcatalogchapter" })).json();
    check(latinSearch.filteredTotal === 1 && latinSearch.chapters[0].index === 80, "catalogue ASCII search matches title case-insensitively");
    const noMatches = await (await catalogue(cn, { q: "不存在的合成章节" })).json();
    check(noMatches.filteredTotal === 0 && noMatches.chapters.length === 0 && noMatches.offset === 0 && noMatches.firstIndex === 0 && noMatches.lastIndex === 0, "no matches retain an empty metadata page");
    const truncated = await (await catalogue(cn, { q: "x".repeat(100) })).json(); check(truncated.query.length === 80, "catalogue queries use the owning 80-character bound");
    check((await (await catalogue(cn, { limit: "2" })).json()).limit === 20 && (await (await catalogue(cn, { limit: "9999" })).json()).limit === 200
      && (await (await catalogue(cn, {})).json()).limit === 120, "catalogue limit normalization matches the store contract");
    const all = await (await catalogue(cn, { all: "1", limit: "20", offset: "99999" })).json();
    check(all.all === true && all.limit === 161 && all.offset === 0 && all.chapters.length === 161 && all.chapters.every(chapter => chapter.content === ""), "all-mode is metadata-only with no reader text");
    const emptyCatalog = await (await catalogue(empty, { limit: "80", anchor: "1" })).json();
    check(emptyCatalog.total === 0 && emptyCatalog.filteredTotal === 0 && emptyCatalog.chapters.length === 0 && emptyCatalog.firstIndex === 0 && emptyCatalog.lastIndex === 0, "empty-book catalogue does not manufacture a first chapter");
    const latinCatalog = await (await catalogue(latin, { limit: "80", anchor: "1" })).json(); check(latinCatalog.chapters.length === 3, "short-book catalogue is a single complete metadata page");
    const failed = await catalogue(errorBook, { limit: "80" }), failedPayload = await failed.json();
    check(failed.status === 503 && failedPayload.error === novelDetailCatalogError && failedPayload.error.length > 150 && !Object.hasOwn(failedPayload, "chapters"), "fourth book has only its fixed long synthetic catalogue error");
    check((await fetch(`${origin}/api/novels/unknown-detail-id/catalog?sourceRealm=wrong`, { headers })).status === 404, "unknown IDs are 404 before any owner checks");
    check((await fetch(`${origin}/api/novels/authors`, { headers })).status === 404 && (await fetch(`${origin}/api/manga/add`, { method: "POST", headers })).status === 405, "this scene gains neither author APIs nor the manga POST exception");
    const oldNovels = await (await fetch(`${origin}/api/novels?limit=80`, { headers: oldHeaders })).json();
    check(oldNovels.books.length === 8 && oldNovels.sourceRealm === novelSourceRealm && oldNovels.books.every(book => JSON.stringify(book) === JSON.stringify(novelBooks.find(item => item.id === book.id))), "previous novel DTOs remain unchanged");
    check((await fetch(`${origin}/api/novels`, { headers: defaultHeaders })).status === 404, "default scene does not gain novel list APIs");
    const recoveryRun = await (await fetch(`${origin}/fixture/new-run?scenario=manga-recovery&profile=immediate-failure`, { method: "POST" })).json();
    check((await fetch(`${origin}/api/manga/add`, { method: "POST", headers: { Origin: origin, Referer: new URL(recoveryRun.url, origin).href, "Content-Type": "application/json" }, body: JSON.stringify({ url: mangaRecoveryUrl }) })).status === 503, "the existing exact in-memory manga recovery exception remains scoped and unchanged");
    for (const name of ["modules/novels/styles.css", "modules/novels/mobile-refinements.css", "modules/novels/novel-views.js"]) {
      const frozen = run.files.find(file => file.name === name);
      check(frozen && sha256(Buffer.from(await (await fetch(`${origin}/run/${run.runId}/www/${name}`)).arrayBuffer())) === frozen.servedSha256, "detail uses the frozen real novel cascade and views source");
    }
    console.log(JSON.stringify({ result: "PASS", checks, books: 4, boundary: "Synthetic publicBook/bookMeta/catalogue metadata GETs only; no reader text, progress, downloads, import, collectors, real files or database" }, null, 2));
  } finally { await new Promise(resolve => server.close(resolve)); }
} else if (process.argv.includes("--smoke-recovery")) {
  let checks = 0;
  const check = (condition, message) => { assert.ok(condition, message); checks++; };
  try {
    const launcher = await fetch(origin), html = await launcher.text();
    check(launcher.status === 200 && html.includes(mangaRecoveryUrl), "launcher displays the sole inert recovery URL");
    for (const profile of mangaRecoveryProfiles) check(html.includes(`data-fixture-profile="${profile}"`), "visible recovery profile button");
    for (const query of ["scenario=manga-recovery", "scenario=manga-recovery&profile=unknown", "scenario=manga-recovery&profile=immediate-failure&profile=delayed-failure", "scenario=default&profile=immediate-failure", "scenario=manga-recovery&profile=immediate-failure&url=unknown"]) {
      check((await fetch(`${origin}/fixture/new-run?${query}`, { method: "POST" })).status === 400, "unknown or ambiguous recovery profiles are rejected");
    }
    const byProfile = new Map();
    for (const profile of mangaRecoveryProfiles) {
      const response = await fetch(`${origin}/fixture/new-run?scenario=manga-recovery&profile=${profile}`, { method: "POST" });
      check(response.status === 200, "recovery profile creates a fresh isolated run");
      const run = await response.json(); byProfile.set(profile, run);
      check(run.profile === profile && new URL(run.url, origin).hash === "#channel?mode=manga", "profile uses the unchanged real manga route");
    }
    const defaultRun = await (await fetch(`${origin}/fixture/new-run`, { method: "POST" })).json();
    const headersFor = run => ({ Origin: origin, Referer: new URL(run.url, origin).href, "Content-Type": "application/json" });
    const exactBody = JSON.stringify({ url: mangaRecoveryUrl });
    const post = (run, body = exactBody, headers = headersFor(run), query = "") => fetch(`${origin}/api/manga/add${query}`, { method: "POST", headers, body });
    const jobs = async run => (await (await fetch(`${origin}/api/manga/jobs`, { headers: headersFor(run) })).json()).jobs;
    const retryRun = byProfile.get("retry-complete");
    for (const body of ["{}", "null", "[]", "not-json", JSON.stringify({ url: "https://other-recovery.invalid/comic" }), JSON.stringify({ url: mangaRecoveryUrl, extra: true }), `{"url":"${mangaRecoveryUrl}","url":"${mangaRecoveryUrl}"}`, `{ "url": "${mangaRecoveryUrl}" }`]) {
      check((await post(retryRun, body)).status === 400, "only the exact canonical JSON and synthetic URL are accepted");
    }
    check((await post(retryRun, "x".repeat(2048))).status === 413, "oversized bodies are bounded");
    check((await post(retryRun, exactBody, { ...headersFor(retryRun), "Content-Type": "text/plain" })).status === 400, "other content types are rejected");
    check((await post(retryRun, exactBody, { ...headersFor(retryRun), "Content-Encoding": "gzip" })).status === 400, "encoded bodies are never decompressed");
    check((await post(retryRun, exactBody, { ...headersFor(retryRun), Origin: "http://cross-origin.invalid" })).status === 403, "cross-origin recovery POST is rejected");
    const noOrigin = headersFor(retryRun); delete noOrigin.Origin;
    check((await post(retryRun, exactBody, noOrigin)).status === 403, "missing Origin cannot use the POST exception");
    check((await post(retryRun, exactBody, headersFor(retryRun), "?profile=retry-complete")).status === 400, "API query parameters cannot choose recovery behavior");
    check((await post(defaultRun)).status === 405, "ordinary runs never receive the synthetic POST exception");
    check((await post(retryRun, exactBody, { Origin: origin, "Content-Type": "application/json" })).status === 405, "missing run attribution keeps POST rejected");
    check((await post(retryRun, exactBody, { ...headersFor(retryRun), Referer: `${origin}/run/00000000-0000-4000-8000-000000000000/www/index.html` })).status === 405, "unknown runs keep POST rejected");
    for (const run of byProfile.values()) check((await jobs(run)).length === 0, "rejected requests never create or accept a job");
    const immediate = byProfile.get("immediate-failure");
    for (let index = 0; index < 2; index++) {
      const response = await post(immediate), payload = await response.json();
      check(response.status === 503 && payload.error === mangaRecoveryError && !Object.hasOwn(payload, "job"), "immediate failures return no accepted task");
    }
    check((await jobs(immediate)).length === 0, "repeated immediate failures never appear in job history");
    const delayed = byProfile.get("delayed-failure"), started = Date.now(), pending = post(delayed);
    await new Promise(resolve => setTimeout(resolve, 50));
    check((await jobs(delayed)).length === 0, "delayed failure has no task while its response is pending");
    check((await post(delayed)).status === 409, "one delayed response per run is allowed at a time");
    const delayedResponse = await pending;
    check(delayedResponse.status === 503 && Date.now() - started >= 2700 && (await delayedResponse.json()).error === mangaRecoveryError, "delayed profile waits before returning only a synthetic error");
    check((await jobs(delayed)).length === 0, "delayed failures do not create a job");
    const first = await post(retryRun);
    check(first.status === 503 && !Object.hasOwn(await first.json(), "job") && (await jobs(retryRun)).length === 0, "invalid requests did not advance the first failure attempt");
    const second = await post(retryRun), completed = await second.json();
    check(second.status === 202 && completed.started === true && completed.existing === false && completed.job.status === "complete"
      && completed.job.progressPercent === 100 && completed.job.kind === "add" && completed.job.comicAvailable === true, "second exact request returns only the in-memory completion DTO");
    check(JSON.stringify(await jobs(retryRun)) === JSON.stringify([completed.job]), "only the completed synthetic job enters history");
    const jobPath = `/api/manga/jobs/${completed.job.id}`;
    check(JSON.stringify((await (await fetch(`${origin}${jobPath}`, { headers: headersFor(retryRun) })).json()).job) === JSON.stringify(completed.job), "known completion job is available by GET");
    check((await fetch(`${origin}${jobPath}`, { headers: headersFor(immediate) })).status === 404, "a recovery job cannot cross run/profile ownership");
    const repeated = await post(retryRun), repeatedPayload = await repeated.json();
    check(repeated.status === 200 && repeatedPayload.existing === true && repeatedPayload.started === false && repeatedPayload.job.id === completed.job.id, "later identical requests return the same bounded in-memory receipt");
    const safeComic = await (await fetch(`${origin}/api/manga/${completed.job.comicId}`, { headers: headersFor(retryRun) })).json();
    check(safeComic.comic.chapters.length === 3 && safeComic.update.status === "idle", "completion only links an already synthetic comic");
    const chapter = await (await fetch(`${origin}/api/manga/${completed.job.comicId}/chapters/1`, { headers: headersFor(retryRun) })).json();
    check((await fetch(`${origin}${chapter.chapter.images[0].url}`)).status === 200, "known recovery pages use only generated geometry SVGs");
    for (const method of ["PATCH", "PUT", "DELETE"]) check((await fetch(`${origin}/api/manga/add`, { method, headers: headersFor(retryRun), body: exactBody })).status === 405, "other methods keep the universal write rejection");
    for (const target of ["/api/manga/jobs/unknown", `/api/manga/${completed.job.comicId}/download`, `/api/manga/${completed.job.comicId}/chapters/1/download`, `/media/manga/${completed.job.comicId}/1/1`]) {
      check((await fetch(`${origin}${target}`, { headers: headersFor(retryRun) })).status === 404, "unknown jobs, downloads and actual bytes remain unavailable");
    }
    for (const target of ["/api/manga/jobs/history", `${jobPath}/retry`, `/api/manga/${completed.job.comicId}/update`]) {
      for (const method of ["POST", "DELETE"]) check((await fetch(`${origin}${target}`, { method, headers: headersFor(retryRun) })).status === 405, "recovery permits no other mutation endpoints");
    }
    const diagnostics = await (await fetch(`${origin}/fixture/requests`)).json();
    check(!JSON.stringify(diagnostics.requests).includes(mangaRecoveryUrl)
      && diagnostics.requests.every(record => Object.keys(record).every(key => ["sequence", "runId", "method", "path", "query", "status"].includes(key))), "submitted bodies and URLs are absent from diagnostic records");
    check((await jobs(immediate)).length === 0 && (await jobs(delayed)).length === 0, "completion never mutates another profile's state");
    console.log(JSON.stringify({ result: "PASS", checks, profiles: [...mangaRecoveryProfiles], boundary: "Bounded synthetic HTTP receipts only; no collector, outgoing fetch, subprocess, database or archive/media writes" }, null, 2));
  } finally { await new Promise(resolve => server.close(resolve)); }
} else if (process.argv.includes("--smoke")) {
  let checks = 0;
  const check = (condition, message) => { assert.ok(condition, message); checks += 1; };
  try {
    const launcher = await fetch(origin);
    check(launcher.status === 200, "launcher");
    const launcherText = await launcher.text();
    check(launcherText.includes('data-fixture-scenario="photo-categories"'), "visible category stress launcher without state injection");
    check(launcherText.includes('data-fixture-scenario="novel-categories"'), "visible novel categories launcher without state injection");
    check(launcherText.includes('data-fixture-scenario="music-search"'), "visible music search launcher without state injection");
    check(launcherText.includes('data-fixture-scenario="music-details"'), "visible music details launcher without state injection");
    check(launcherText.includes('data-fixture-scenario="music-playlists"'), "visible music playlists launcher without state injection");
    check(launcherText.includes('data-fixture-scenario="fanhao-search"'), "visible FanHao search launcher without state injection");
    const response = await fetch(`${origin}/fixture/new-run`, { method: "POST" });
    check(response.status === 200, "new run");
    const run = await response.json();
    check(run.scenario === "default", "the existing launcher run remains the default scenario");
    check(run.files.length > 30, "real dependency closure, not a replacement navigation mock");
    const headers = { Referer: `${origin}${run.url}` };
    for (const asset of run.files) {
      const served = await fetch(`${origin}/run/${run.runId}/www/${asset.name}`, { headers });
      check(served.status === 200, `frozen ${asset.name}`);
      check(sha256(Buffer.from(await served.arrayBuffer())) === asset.servedSha256, `frozen hash ${asset.name}`);
      if (!asset.transformed) check(asset.sha256 === asset.servedSha256, `real unchanged asset ${asset.name}`);
    }
    const index = await (await fetch(`${origin}${run.url}`)).text();
    check(index.indexOf("/fixture/browser.mjs") < index.indexOf('src="./app.js'), "bootstrap before actual app");
    const config = await (await fetch(`${origin}/run/${run.runId}/www/js/config.js`)).text();
    check(config.includes("DEFAULT_URL = location.origin") && !/https?:/.test(config), "only fixture backend defaults");
    const settingsPaths = ["/api/accounts/status", "/api/system/control", "/api/image-reader/cache", "/api/manga/storage"];
    const settings = new Map();
    for (const pathname of settingsPaths) {
      const result = await fetch(`${origin}${pathname}`, { headers });
      check(result.status === 200, `read-only synthetic settings ${pathname}`);
      settings.set(pathname, await result.json());
      for (const method of ["POST", "PATCH", "DELETE"]) {
        check((await fetch(`${origin}${pathname}`, { method })).status === 405, `settings rejects ${method} ${pathname}`);
      }
    }
    const account = settings.get("/api/accounts/status"), control = settings.get("/api/system/control");
    check(account.user === null && account.setupAvailable === false && account.accountLoginRequired === false
      && typeof account.registrationEnabled === "boolean" && typeof account.invitationRequired === "boolean", "guest account DTO without administrator setup or credentials");
    check(control.ok === true && control.platform === "unsupported" && control.actions.length === 0 && control.lastDispatch === null, "system status exposes no host action or dispatch");
    const cacheStatus = settings.get("/api/image-reader/cache");
    check(cacheStatus.cache.exists === true && cacheStatus.cache.currentBytes === 0 && cacheStatus.cache.overBytes === 0
      && cacheStatus.cache.fileCount === 0 && cacheStatus.cache.entries.length === 0 && cacheStatus.cache.cleanupIntervalMs > 0
      && cacheStatus.cache.maxBytes > 0 && cacheStatus.config.imageReaderCacheMaxBytes === cacheStatus.cache.maxBytes, "empty synthetic image-reader cache DTO");
    const storage = settings.get("/api/manga/storage").storage;
    check(storage.exists === true && ["comicCount", "chapterCount", "imageCount", "downloadedCount", "failedCount", "bytes", "fileCount", "totalBytes", "diskFreeBytes"].every(key => storage[key] === 0)
      && storage.trash.itemCount === 0 && storage.trash.bytes === 0 && storage.trash.fileCount === 0 && storage.trash.items.length === 0, "empty synthetic manga storage and trash DTO");
    check(JSON.stringify(await (await fetch(`${origin}/api/manga/storage?refresh=1`, { headers })).json())
      === JSON.stringify({ storage }), "storage refresh remains a fixed read without a filesystem scan");
    for (const pathname of ["/api/accounts/login", "/api/accounts/register", "/api/image-reader/cache/cleanup"]) {
      check((await fetch(`${origin}${pathname}`, { method: "POST" })).status === 405, `no settings mutation ${pathname}`);
    }
    check((await fetch(`${origin}/api/manga/trash`, { method: "DELETE" })).status === 405, "no synthetic trash purge action");
    for (const mode of ["photo", "manga", "movie", "tv"]) {
      const result = await (await fetch(`${origin}/api/image-library/items?mode=${mode}`, { headers })).json();
      check(result.mode === mode && result.items.length > 0, `synthetic ${mode} list`);
    }
    const photoPath = "/api/image-library/items?mode=photo";
    const defaultPhoto = await (await fetch(`${origin}${photoPath}`, { headers })).json();
    check(defaultPhoto.facets.categories.length === 0, "default photo facets remain unchanged");
    const stressResponse = await fetch(`${origin}/fixture/new-run?scenario=photo-categories`, { method: "POST" });
    check(stressResponse.status === 200, "explicit category stress run");
    const stressRun = await stressResponse.json(), stressHeaders = { Referer: `${origin}${stressRun.url}` };
    check(stressRun.scenario === "photo-categories" && stressRun.runId !== run.runId, "stress scenario has its own visible run metadata and storage namespace");
    const stressPhoto = await (await fetch(`${origin}${photoPath}`, { headers: stressHeaders })).json();
    check(stressPhoto.facets.categories.length === 30 && new Set(stressPhoto.facets.categories.map(item => item.value)).size === 30, "stress photo DTO contains 30 distinct fixed categories");
    check(stressPhoto.facets.categories.filter(item => item.value.length > 25).length === 3
      && stressPhoto.facets.categories.every(item => Number.isInteger(item.count) && item.count > 0), "three long Chinese category labels retain valid facet counts");
    const lastCategory = stressPhoto.facets.categories.at(-1).value;
    const lastPhoto = await (await fetch(`${origin}${photoPath}&category=${encodeURIComponent(lastCategory)}`, { headers: stressHeaders })).json();
    check(lastPhoto.category === lastCategory && lastPhoto.items[0].collections[0].category === lastCategory
      && lastPhoto.facets.categories.length === 30, "the last long category can be selected through the real photo query contract");
    check(JSON.stringify(await (await fetch(`${origin}${photoPath}`, { headers })).json()) === JSON.stringify(defaultPhoto), "a stress run cannot change another run's photo fixtures");
    check(JSON.stringify(await (await fetch(`${origin}${photoPath}`)).json()) === JSON.stringify(defaultPhoto), "unscoped requests keep the default fixture");
    check(JSON.stringify(await (await fetch(`${origin}${photoPath}`, { headers: { Referer: `https://example.invalid${stressRun.url}` } })).json())
      === JSON.stringify(defaultPhoto), "a cross-origin Referer cannot select a stress run");
    const moviePath = "/api/image-library/items?mode=movie";
    check(JSON.stringify(await (await fetch(`${origin}${moviePath}`, { headers: stressHeaders })).json())
      === JSON.stringify(await (await fetch(`${origin}${moviePath}`, { headers })).json()), "category stress only changes photo facets");
    for (const query of ["scenario=unknown", "scenario=", "scenario=photo-categories&scenario=default", "stress=1"]) {
      check((await fetch(`${origin}/fixture/new-run?${query}`, { method: "POST" })).status === 400, `reject unknown or ambiguous scenario ${query}`);
    }
    check((await fetch(`${origin}${photoPath}&scenario=photo-categories`, { headers })).status === 400, "API requests cannot override the launcher's scenario");
    for (const method of ["POST", "PATCH", "DELETE"]) {
      check((await fetch(`${origin}${photoPath}`, { method, headers: stressHeaders })).status === 405, `stress fixture rejects ${method} photo writes`);
    }
    const novelRunResponse = await fetch(`${origin}/fixture/new-run?scenario=novel-categories`, { method: "POST" });
    check(novelRunResponse.status === 200, "explicit novel categories run");
    const novelRun = await novelRunResponse.json(), novelHeaders = { Referer: `${origin}${novelRun.url}` };
    check(novelRun.scenario === "novel-categories" && new URL(novelRun.url, origin).hash === "#novels", "novel launcher uses the real Android root hash route");
    check(new Set([run.runId, stressRun.runId, novelRun.runId]).size === 3, "each scene retains independent run and persistence ownership");
    const novelsResponse = await fetch(`${origin}/api/novels?limit=80`, { headers: novelHeaders });
    check(novelsResponse.status === 200, "synthetic novel list is available in its own scene");
    const novels = await novelsResponse.json();
    check(novels.books.length === 8 && novels.total === 8 && novels.nextOffset === 8 && novels.offset === 0
      && novels.sourceRealm === novelSourceRealm && novels.listRevision.length > 0, "novel list uses the current public DTO and source identity");
    check(novels.facets.length === 8 && novels.facets.every(item => item.name && item.count === 1)
      && novels.facets.at(-1).name.length > 30 && novels.summary.categories.length === 8, "eight dynamic novel category facets include the long final label");
    check(novels.books.every(book => book.id && book.title && book.author && book.category && book.chapterCount > 0
      && book.sourceRealm === novels.sourceRealm && book.progress === null), "synthetic books supply the real title-cover and unread-row fields");
    const lastNovelCategory = novels.facets.at(-1).name;
    const filteredNovels = await (await fetch(`${origin}/api/novels?category=${encodeURIComponent(lastNovelCategory)}`, { headers: novelHeaders })).json();
    check(filteredNovels.total === 1 && filteredNovels.books[0].category === lastNovelCategory && filteredNovels.facets.length === 8, "last novel category filters the list without losing global category facets");
    const pagedNovels = await (await fetch(`${origin}/api/novels?limit=2&offset=2`, { headers: novelHeaders })).json();
    check(pagedNovels.total === 8 && pagedNovels.books.length === 2 && pagedNovels.offset === 2 && pagedNovels.nextOffset === 4, "novel fixture preserves bounded paging");
    const novelTotals = await (await fetch(`${origin}/api/novels/summary`, { headers: novelHeaders })).json();
    check(novelTotals.totals.books === 8 && novelTotals.categories.length === 8 && novelTotals.sourceRealm === novels.sourceRealm, "novel summary agrees with list facets and source");
    for (const sceneHeaders of [headers, stressHeaders]) {
      check((await fetch(`${origin}/api/novels`, { headers: sceneHeaders })).status === 404, "existing scenes do not gain novel APIs");
      check((await (await fetch(`${origin}/api/novels/summary`, { headers: sceneHeaders })).json()).categories === undefined, "existing scenes keep their original empty novel summary");
    }
    check(JSON.stringify(await (await fetch(`${origin}${photoPath}`, { headers: novelHeaders })).json()) === JSON.stringify(defaultPhoto), "novel scene leaves default photo data unchanged");
    for (const method of ["POST", "PATCH", "DELETE"]) {
      check((await fetch(`${origin}/api/novels`, { method, headers: novelHeaders })).status === 405, `novel fixture rejects ${method} writes`);
    }
    const musicRunResponse = await fetch(`${origin}/fixture/new-run?scenario=music-search`, { method: "POST" });
    check(musicRunResponse.status === 200, "explicit music search run");
    const musicRun = await musicRunResponse.json(), musicHeaders = { Referer: `${origin}${musicRun.url}` };
    const musicHash = new URL(musicRun.url, origin).hash;
    const musicRoute = new URLSearchParams(musicHash.split("?")[1]);
    check(musicRun.scenario === "music-search" && musicHash.startsWith("#music?")
      && musicRoute.get("mode") === "library" && musicRoute.get("dashboard") === "0" && musicRoute.get("query") === "合成", "music scene opens the real comprehensive search route");
    const musicPath = `/api/music/tracks?q=${encodeURIComponent("合成")}`;
    const songs = await (await fetch(`${origin}${musicPath}`, { headers: musicHeaders })).json();
    check(songs.total === 3 && songs.tracks.filter(track => track.favorite).length === 1
      && songs.tracks.filter(track => !track.favorite).length === 2, "music scene exposes two ordinary tracks and one fixed favorite");
    check(songs.tracks.every(track => track.id && track.artistId && track.albumId && track.title && track.durationMs > 0
      && track.streamUrl === "" && track.downloadUrl === ""), "music public track metadata has no enabled stream or download");
    const favorites = await (await fetch(`${origin}${musicPath}&favorite=1`, { headers: musicHeaders })).json();
    check(favorites.favorite === true && favorites.total === 1 && favorites.tracks.length === 1
      && favorites.tracks[0].id === "fixture-music-track-3", "favorite filtering uses the real track-list query contract");
    const multiFilter = await (await fetch(`${origin}${musicPath}&favorite=1&lyrics=1&minRating=4&quality=lossless`, { headers: musicHeaders })).json();
    check(multiFilter.total === 1 && multiFilter.favorite && multiFilter.lyrics && multiFilter.minRating === 4 && multiFilter.quality === "lossless"
      && multiFilter.tracks[0].rating === 5 && multiFilter.tracks[0].hasLyrics && multiFilter.tracks[0].codec === "flac", "combined music filters remain represented in the read DTO");
    check((await (await fetch(`${origin}${musicPath}`, { headers: musicHeaders })).json()).total === 3, "clearing all filters restores three fixed songs without a write");
    const emptyMusic = await (await fetch(`${origin}/api/music/tracks?q=not-a-synthetic-match`, { headers: musicHeaders })).json();
    check(emptyMusic.total === 0 && emptyMusic.tracks.length === 0, "unmatched music queries return an empty read result");
    const musicPage = await (await fetch(`${origin}${musicPath}&limit=1&offset=1`, { headers: musicHeaders })).json();
    check(musicPage.total === 3 && musicPage.tracks.length === 1 && musicPage.offset === 1 && musicPage.hasMore, "music list paging stays bounded");
    for (const field of ["artists", "albums"]) {
      const catalogue = await (await fetch(`${origin}/api/music/${field}?q=${encodeURIComponent("合成")}`, { headers: musicHeaders })).json();
      check(catalogue.total === 1 && catalogue[field].length === 1 && catalogue[field][0].trackCount === 3, `synthetic ${field} support the comprehensive search overview`);
    }
    for (const pathname of ["/api/music/summary", "/api/music/playlists", "/api/music/smart-playlists", "/api/music/suggest?q=合成", "/api/music/lyrics/search?q=合成"]) {
      check((await fetch(`${origin}${pathname}`, { headers: musicHeaders })).status === 200, `read-only music search dependency ${pathname}`);
    }
    const musicCover = await fetch(`${origin}${songs.tracks[0].coverUrl}`, { headers: musicHeaders });
    check(musicCover.status === 200 && musicCover.headers.get("content-type").startsWith("image/svg+xml"), "music cover is generated SVG only");
    for (const name of musicSceneAssets) {
      const asset = musicRun.files.find(item => item.name === name);
      check(asset && !asset.transformed, `music runtime UI asset is explicitly frozen ${name}`);
      const resource = await fetch(`${origin}/run/${musicRun.runId}/www/${name}`, { headers: musicHeaders });
      check(resource.status === 200 && sha256(Buffer.from(await resource.arrayBuffer())) === asset.servedSha256, `music runtime UI asset preserves source bytes ${name}`);
    }
    for (const sceneHeaders of [headers, stressHeaders, novelHeaders]) {
      check((await fetch(`${origin}${musicPath}`, { headers: sceneHeaders })).status === 404, "existing scenes do not gain music list APIs");
      check((await (await fetch(`${origin}/api/music/summary`, { headers: sceneHeaders })).json()).totals.tracks === undefined, "existing scenes keep the original empty music summary");
    }
    check(JSON.stringify(await (await fetch(`${origin}${photoPath}`, { headers: musicHeaders })).json()) === JSON.stringify(defaultPhoto), "music search scene leaves photo fixtures unchanged");
    check((await fetch(`${origin}/api/novels`, { headers: musicHeaders })).status === 404, "music search scene does not expose the novel fixture");
    for (const pathname of ["/media/music/fixture-music-track-3", "/media/music-download/fixture-music-track-3", "/api/music/tracks/fixture-music-track-3"]) {
      check((await fetch(`${origin}${pathname}`, { headers: musicHeaders })).status === 404, `music scene does not serve playback/detail bytes ${pathname}`);
    }
    for (const method of ["POST", "PATCH", "DELETE"]) {
      check((await fetch(`${origin}/api/music/tracks/fixture-music-track-3/favorite`, { method, headers: musicHeaders })).status === 405, `music scene rejects ${method} favorite writes`);
    }
    const fanhaoRunResponse = await fetch(`${origin}/fixture/new-run?scenario=fanhao-search`, { method: "POST" });
    check(fanhaoRunResponse.status === 200, "explicit FanHao search run");
    const fanhaoRun = await fanhaoRunResponse.json(), fanhaoHeaders = { Referer: `${origin}${fanhaoRun.url}` };
    const fanhaoHash = new URL(fanhaoRun.url, origin).hash, fanhaoRoute = new URLSearchParams(fanhaoHash.split("?")[1]);
    check(fanhaoHash.startsWith("#search?") && fanhaoRoute.get("query") === "合成" && fanhaoRoute.get("category") === "censored", "FanHao launcher uses the existing scoped search route");
    const fanhaoPath = `/api/fanhao/search?q=${encodeURIComponent("合成")}&category=censored`;
    const searchResult = await (await fetch(`${origin}${fanhaoPath}`, { headers: fanhaoHeaders })).json();
    check(searchResult.total === 3 && searchResult.count === 3 && searchResult.works.length === 3
      && searchResult.people.length === 1 && searchResult.people[0].actorProfile.displayName === "合成人物甲", "FanHao search returns actual works and matched-person DTOs");
    check(searchResult.facets.all === 3 && searchResult.facets.favorite === 1 && searchResult.facets.progress === 1
      && searchResult.facets.missingLocal === 1 && searchResult.facets.localOnly === 2, "FanHao status facets are distinct and consistent with source works");
    for (const filter of ["favorite", "progress", "missingLocal"]) {
      const filtered = await (await fetch(`${origin}${fanhaoPath}&filter=${filter}`, { headers: fanhaoHeaders })).json();
      check(filtered.total === 1 && filtered.works.length === 1 && fanhaoPredicates[filter](filtered.works[0])
        && filtered.facets.all === 3, `real ${filter} filter preserves complete source facets`);
    }
    const noIntersection = await (await fetch(`${origin}${fanhaoPath}&filter=favorite,progress`, { headers: fanhaoHeaders })).json();
    check(noIntersection.total === 0 && noIntersection.works.length === 0, "multiple FanHao status filters use intersection semantics");
    const titleSorted = await (await fetch(`${origin}${fanhaoPath}&sort=title`, { headers: fanhaoHeaders })).json();
    const ratingSorted = await (await fetch(`${origin}${fanhaoPath}&sort=ratingDesc`, { headers: fanhaoHeaders })).json();
    check(titleSorted.works.map(work => work.id).join(",") === "fixture-fanhao-work-1,fixture-fanhao-work-2,fixture-fanhao-work-3", "FanHao title sort has a visible deterministic order");
    check(ratingSorted.works.map(work => work.id).join(",") === "fixture-fanhao-work-1,fixture-fanhao-work-3,fixture-fanhao-work-2", "FanHao rating sort changes the visible order");
    const fanhaoPage = await (await fetch(`${origin}${fanhaoPath}&limit=1&offset=1`, { headers: fanhaoHeaders })).json();
    check(fanhaoPage.total === 3 && fanhaoPage.count === 1 && fanhaoPage.offset === 1, "FanHao search paging uses the real count/total boundary");
    const emptyFanhao = await (await fetch(`${origin}/api/fanhao/search?q=not-a-synthetic-match`, { headers: fanhaoHeaders })).json();
    check(emptyFanhao.total === 0 && emptyFanhao.people.length === 0 && emptyFanhao.works.length === 0, "unmatched FanHao search stays empty");
    const scopedFanhao = await (await fetch(`${origin}${fanhaoPath.replace("censored", "western")}`, { headers: fanhaoHeaders })).json();
    check(scopedFanhao.total === 0 && scopedFanhao.people.length === 0, "synthetic main-library works do not leak into the western scope");
    const fanhaoLibrary = await (await fetch(`${origin}/api/library`, { headers: fanhaoHeaders })).json();
    check(fanhaoLibrary.people.length === 1 && fanhaoLibrary.totals.works === 2 && fanhaoLibrary.user.favoriteCount === 1, "the shell library snapshot supplies synthetic local-person context");
    const detail = await (await fetch(`${origin}/api/works/fixture-fanhao-work-1`, { headers: fanhaoHeaders })).json();
    check(detail.work.videos.length === 0 && detail.work.images.length === 0 && detail.work.javdbUrl === "", "work prefetch/detail has no media or external source");
    for (const work of searchResult.works) {
      const response = await fetch(`${origin}/api/works/${work.id}/move-job`, { headers: fanhaoHeaders });
      const payload = await response.json();
      check(response.status === 200 && payload.ok === true && payload.job === null && Object.keys(payload).length === 2,
        `known synthetic work ${work.id} has no migration job`);
    }
    check((await fetch(`${origin}/api/works/fixture-fanhao-work-4/move-job`, { headers: fanhaoHeaders })).status === 404,
      "unknown synthetic work cannot read a migration status");
    const personDetail = await (await fetch(`${origin}/api/people/${fanhaoPerson.id}`, { headers: fanhaoHeaders })).json();
    check(personDetail.person.id === fanhaoPerson.id && personDetail.total === 3, "matched person opens a synthetic read-only detail");
    for (const source of [...searchResult.works.map(work => work.cachedCover.coverUrl), searchResult.people[0].actorProfile.avatarUrl]) {
      const image = await fetch(`${origin}${source}`, { headers: fanhaoHeaders });
      check(image.status === 200 && image.headers.get("content-type").startsWith("image/svg+xml"), "FanHao covers and portrait are synthetic SVG only");
    }
    for (const sceneHeaders of [headers, stressHeaders, novelHeaders, musicHeaders]) {
      check((await fetch(`${origin}${fanhaoPath}`, { headers: sceneHeaders })).status === 404, "existing scenarios do not gain FanHao search data");
      check((await fetch(`${origin}/api/works/fixture-fanhao-work-1/move-job`, { headers: sceneHeaders })).status === 404,
        "existing scenarios do not gain FanHao migration status data");
      check((await (await fetch(`${origin}/api/library`, { headers: sceneHeaders })).json()).people.length === 0, "existing shell library snapshots remain unchanged");
    }
    for (const method of ["POST", "PATCH", "DELETE"]) {
      for (const pathname of ["/api/works/fixture-fanhao-work-1/favorite", "/api/works/fixture-fanhao-work-1/move", "/api/works/fixture-fanhao-work-1/move-job", "/api/works/fixture-fanhao-work-1"]) {
        check((await fetch(`${origin}${pathname}`, { method, headers: fanhaoHeaders })).status === 405, `FanHao scene rejects ${method} business mutation ${pathname}`);
      }
    }
    check((await (await fetch(`${origin}${fanhaoPath}`, { headers: fanhaoHeaders })).json()).total === 3, "clearing a FanHao filter restores the fixed three results without a write");
    const musicDetailsResponse = await fetch(`${origin}/fixture/new-run?scenario=music-details`, { method: "POST" });
    check(musicDetailsResponse.status === 200, "explicit independent music details run");
    const musicDetailsRun = await musicDetailsResponse.json(), musicDetailsHeaders = { Referer: `${origin}${musicDetailsRun.url}` };
    const musicDetailsHash = new URL(musicDetailsRun.url, origin).hash, musicDetailsRoute = new URLSearchParams(musicDetailsHash.split("?")[1]);
    check(musicDetailsRun.scenario === "music-details" && musicDetailsHash.startsWith("#music?")
      && musicDetailsRoute.get("mode") === "albums" && musicDetailsRoute.get("dashboard") === "0" && !musicDetailsRoute.has("query"),
      "music details launcher uses the real album browser without injecting detail state");
    const detailAlbums = await (await fetch(`${origin}/api/music/albums`, { headers: musicDetailsHeaders })).json();
    const detailArtists = await (await fetch(`${origin}/api/music/artists`, { headers: musicDetailsHeaders })).json();
    const detailTracks = await (await fetch(`${origin}/api/music/tracks`, { headers: musicDetailsHeaders })).json();
    check(detailAlbums.total === 2 && detailAlbums.albums.length === 2 && detailAlbums.albums.every(album => album.title.length > 30
      && album.artistId === musicDetailArtist.id && album.artistName === musicDetailArtist.name && album.trackCount === 2),
      "two long-name album DTOs retain their common synthetic artist and track counts");
    check(detailArtists.total === 1 && detailArtists.artists.length === 1 && detailArtists.artists[0].name.length > 40
      && detailArtists.artists[0].albumCount === 2 && detailArtists.artists[0].trackCount === 4,
      "long-name artist DTO exposes two albums and four tracks");
    check(detailTracks.total === 4 && detailTracks.tracks.length === 4 && detailTracks.tracks.every(track => track.streamUrl === ""
      && track.downloadUrl === "" && track.artistId === musicDetailArtist.id && track.durationMs === 180000),
      "music detail tracks contain catalogue metadata without stream or download URLs");
    const artistTracks = await (await fetch(`${origin}/api/music/tracks?artist=${musicDetailArtist.id}&language=${encodeURIComponent("国语")}`, { headers: musicDetailsHeaders })).json();
    check(artistTracks.total === 4 && artistTracks.artistId === musicDetailArtist.id && artistTracks.language === "国语"
      && artistTracks.artists.some(artist => artist.id === musicDetailArtist.id), "artist detail uses the actual filtered-track and selected-facet DTO");
    for (const album of detailAlbums.albums) {
      const scoped = await (await fetch(`${origin}/api/music/tracks?artistId=${musicDetailArtist.id}&albumId=${album.id}`, { headers: musicDetailsHeaders })).json();
      check(scoped.total === 2 && scoped.tracks.length === 2 && scoped.artistId === musicDetailArtist.id && scoped.albumId === album.id
        && scoped.tracks.every(track => track.albumId === album.id && track.coverUrl === album.coverUrl)
        && scoped.albums.some(item => item.id === album.id && item.title === album.title), `album detail ${album.id} keeps its two tracks and selected facet`);
    }
    const coveredAlbum = detailAlbums.albums.find(album => album.coverUrl), uncoveredAlbum = detailAlbums.albums.find(album => !album.coverUrl);
    check(coveredAlbum && uncoveredAlbum && detailTracks.tracks.filter(track => track.albumId === uncoveredAlbum.id).every(track => track.coverUrl === ""),
      "the no-art album and all its tracks cannot accidentally enable the first-track artwork fallback");
    const detailCover = await fetch(`${origin}${coveredAlbum.coverUrl}`, { headers: musicDetailsHeaders });
    check(detailCover.status === 200 && detailCover.headers.get("content-type").startsWith("image/svg+xml"), "music detail artwork is synthetic SVG only");
    const detailPage = await (await fetch(`${origin}/api/music/tracks?limit=1&offset=1`, { headers: musicDetailsHeaders })).json();
    check(detailPage.total === 4 && detailPage.tracks.length === 1 && detailPage.offset === 1 && detailPage.hasMore
      && detailPage.tracks[0].id === detailTracks.tracks[1].id, "music detail paging preserves the stable full catalogue boundary");
    for (const query of ["artistId=unknown", "albumId=unknown", "q=not-a-synthetic-match", `language=${encodeURIComponent("未知语种")}`]) {
      const empty = await (await fetch(`${origin}/api/music/tracks?${query}`, { headers: musicDetailsHeaders })).json();
      check(empty.total === 0 && empty.tracks.length === 0, `unknown music detail selection stays empty: ${query}`);
    }
    for (const pathname of ["/api/music/summary", "/api/music/playlists", "/api/music/smart-playlists"]) {
      check((await fetch(`${origin}${pathname}`, { headers: musicDetailsHeaders })).status === 200, `read-only music detail startup dependency ${pathname}`);
    }
    for (const name of musicSceneAssets) {
      const asset = musicDetailsRun.files.find(item => item.name === name);
      check(asset && !asset.transformed, `music details freezes its runtime UI asset ${name}`);
      const resource = await fetch(`${origin}/run/${musicDetailsRun.runId}/www/${name}`, { headers: musicDetailsHeaders });
      check(resource.status === 200 && sha256(Buffer.from(await resource.arrayBuffer())) === asset.servedSha256, `music details preserves runtime asset bytes ${name}`);
    }
    for (const sceneHeaders of [headers, stressHeaders, novelHeaders, fanhaoHeaders]) {
      check((await fetch(`${origin}/api/music/tracks`, { headers: sceneHeaders })).status === 404, "other scenarios do not gain music detail tracks");
    }
    const unchangedMusic = await (await fetch(`${origin}${musicPath}`, { headers: musicHeaders })).json();
    check(JSON.stringify(unchangedMusic) === JSON.stringify(songs), "music details leaves the original three-track search DTO unchanged");
    const isolatedTracks = await (await fetch(`${origin}/api/music/tracks?artistId=${musicDetailArtist.id}`, { headers: musicHeaders })).json();
    check(isolatedTracks.total === 0 && isolatedTracks.tracks.length === 0, "music search cannot select the independent details artist");
    check(JSON.stringify(await (await fetch(`${origin}${photoPath}`, { headers: musicDetailsHeaders })).json()) === JSON.stringify(defaultPhoto),
      "music details leaves existing photo data unchanged");
    for (const pathname of ["/api/music/tracks/fixture-music-details-track-1", "/api/music/albums/fixture-music-details-covered",
      "/api/music/artists/fixture-music-details-artist", "/media/music/fixture-music-details-track-1", "/media/music-download/fixture-music-details-track-1",
      "/api/music/not-implemented", "/api/novels"]) {
      check((await fetch(`${origin}${pathname}`, { headers: musicDetailsHeaders })).status === 404, `music details does not serve extra APIs or audio ${pathname}`);
    }
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      for (const pathname of ["/api/music/tracks/fixture-music-details-track-1/favorite", "/api/music/tracks/fixture-music-details-track-1/progress", "/api/music/playlists"]) {
        check((await fetch(`${origin}${pathname}`, { method, headers: musicDetailsHeaders })).status === 405, `music details rejects ${method} business write ${pathname}`);
      }
    }
    const musicPlaylistsResponse = await fetch(`${origin}/fixture/new-run?scenario=music-playlists`, { method: "POST" });
    check(musicPlaylistsResponse.status === 200, "explicit independent music playlists run");
    const musicPlaylistsRun = await musicPlaylistsResponse.json(), musicPlaylistsHeaders = { Referer: `${origin}${musicPlaylistsRun.url}` };
    const musicPlaylistsHash = new URL(musicPlaylistsRun.url, origin).hash, musicPlaylistsRoute = new URLSearchParams(musicPlaylistsHash.split("?")[1]);
    check(musicPlaylistsRun.scenario === "music-playlists" && musicPlaylistsHash === "#music?mode=library"
      && !musicPlaylistsRoute.has("playlistId") && !musicPlaylistsRoute.has("smartId"), "music playlists launches the real music home without injected selection");
    const playlistList = await (await fetch(`${origin}/api/music/playlists`, { headers: musicPlaylistsHeaders })).json();
    check(playlistList.total === 2 && playlistList.playlists.length === 2 && playlistList.playlists.every(playlist => playlist.id
      && playlist.name.length <= 80 && playlist.description.length <= 300 && playlist.exportUrl.startsWith("/api/music/playlists/")
      && playlist.createdAt === timestamp && playlist.updatedAt === timestamp && !Object.hasOwn(playlist, "readOnly")),
      "playlist DTOs keep real bounded metadata without invented permission fields");
    const longPlaylist = playlistList.playlists.find(playlist => playlist.trackCount === 4), emptyPlaylist = playlistList.playlists.find(playlist => playlist.trackCount === 0);
    check(longPlaylist?.name.length > 30 && longPlaylist.description.length > 80 && emptyPlaylist, "one long-name described playlist and one empty playlist are available");
    for (const playlist of playlistList.playlists) {
      const response = await fetch(`${origin}/api/music/playlists/${playlist.id}`, { headers: musicPlaylistsHeaders });
      const payload = await response.json();
      check(response.status === 200 && payload.playlist.id === playlist.id && payload.playlist.name === playlist.name
        && payload.total === playlist.trackCount && payload.tracks.length === playlist.trackCount && payload.artists.length === 1
        && payload.albums.length === 2 && payload.summary.totals.tracks === 4 && !Object.hasOwn(payload, "hasMore"),
        `known playlist ${playlist.id} returns the actual non-paged detail DTO`);
      check(payload.tracks.every(track => track.streamUrl === "" && track.downloadUrl === ""), `playlist ${playlist.id} never enables audio or downloads`);
      check((await fetch(`${origin}${playlist.exportUrl}`, { headers: musicPlaylistsHeaders })).status === 404, `playlist ${playlist.id} export bytes stay unavailable`);
    }
    const smartList = await (await fetch(`${origin}/api/music/smart-playlists`, { headers: musicPlaylistsHeaders })).json();
    check(smartList.total === 1 && smartList.smartPlaylists.length === 1 && smartList.smartPlaylists[0].id === "hires"
      && smartList.smartPlaylists[0].name === "无损与高解析" && smartList.smartPlaylists[0].description === "FLAC、WAV、ALAC 或 24bit/48kHz 以上音频。"
      && smartList.smartPlaylists[0].badge === "Hi-Res" && smartList.smartPlaylists[0].limit === 240,
      "smart playlist keeps the real built-in ID, short name and fixed description");
    const smartTracks = await (await fetch(`${origin}/api/music/tracks?smart=hires&limit=4`, { headers: musicPlaylistsHeaders })).json();
    check(smartTracks.total === 4 && smartTracks.tracks.length === 4 && smartTracks.smartId === "hires" && smartTracks.smartPlaylist.id === "hires"
      && smartTracks.smartPlaylist.trackCount === 4 && smartTracks.tracks.every(track => track.codec === "flac" && track.streamUrl === "" && track.downloadUrl === ""),
      "real smart=hires track route supplies the matching selected-smart DTO without audio");
    const smartPage = await (await fetch(`${origin}/api/music/tracks?smart=hires&limit=1&offset=1`, { headers: musicPlaylistsHeaders })).json();
    check(smartPage.total === 4 && smartPage.tracks.length === 1 && smartPage.offset === 1 && smartPage.hasMore, "smart track paging keeps its full match total");
    const playlistHistory = await (await fetch(`${origin}/api/music/history?limit=100`, { headers: musicPlaylistsHeaders })).json();
    check(playlistHistory.total === 2 && playlistHistory.tracks.length === 2 && playlistHistory.limit === 100
      && playlistHistory.tracks.every(track => track.lastPlayedAt && track.playCount > 0 && track.streamUrl === "" && track.downloadUrl === "")
      && playlistHistory.tracks[0].lastPlayedAt > playlistHistory.tracks[1].lastPlayedAt
      && !Object.hasOwn(playlistHistory, "offset") && !Object.hasOwn(playlistHistory, "hasMore"), "history has two ordered synthetic plays and the real non-paged DTO");
    const limitedHistory = await (await fetch(`${origin}/api/music/history?limit=1`, { headers: musicPlaylistsHeaders })).json();
    check(limitedHistory.total === 1 && limitedHistory.tracks.length === 1 && limitedHistory.limit === 1
      && limitedHistory.tracks[0].id === playlistHistory.tracks[0].id, "history total reflects the limited returned rows as the owning service does");
    const playlistSummary = await (await fetch(`${origin}/api/music/summary`, { headers: musicPlaylistsHeaders })).json();
    check(playlistSummary.totals.tracks === 4 && playlistSummary.totals.listenedTracks === 2 && playlistSummary.totals.plays === 3
      && JSON.stringify(playlistSummary.recent) === JSON.stringify(playlistHistory.tracks), "music home summary agrees with fixed synthetic history");
    for (const name of [...musicSceneAssets, ...musicPlaylistAssets]) {
      const asset = musicPlaylistsRun.files.find(item => item.name === name);
      check(asset && !asset.transformed, `music playlists freezes its runtime UI asset ${name}`);
      const resource = await fetch(`${origin}/run/${musicPlaylistsRun.runId}/www/${name}`, { headers: musicPlaylistsHeaders });
      check(resource.status === 200 && sha256(Buffer.from(await resource.arrayBuffer())) === asset.servedSha256, `music playlists preserves runtime asset bytes ${name}`);
    }
    for (const sceneHeaders of [headers, stressHeaders, novelHeaders, fanhaoHeaders, musicHeaders, musicDetailsHeaders]) {
      check((await fetch(`${origin}/api/music/playlists/${longPlaylist.id}`, { headers: sceneHeaders })).status === 404, "other scenarios do not gain synthetic custom playlist details");
      check((await fetch(`${origin}/api/music/history`, { headers: sceneHeaders })).status === 404, "other scenarios do not gain synthetic listening history");
    }
    check(JSON.stringify(await (await fetch(`${origin}${musicPath}`, { headers: musicHeaders })).json()) === JSON.stringify(songs), "music playlists leaves the original search DTO unchanged");
    check(JSON.stringify(await (await fetch(`${origin}/api/music/tracks`, { headers: musicDetailsHeaders })).json()) === JSON.stringify(detailTracks), "playlist history does not mutate the original detail-track state");
    for (const sceneHeaders of [musicHeaders, musicDetailsHeaders]) {
      check((await (await fetch(`${origin}/api/music/playlists`, { headers: sceneHeaders })).json()).playlists.length === 0
        && (await (await fetch(`${origin}/api/music/smart-playlists`, { headers: sceneHeaders })).json()).smartPlaylists.length === 0,
        "original music scenes retain their empty playlist catalogues");
    }
    check(JSON.stringify(await (await fetch(`${origin}${photoPath}`, { headers: musicPlaylistsHeaders })).json()) === JSON.stringify(defaultPhoto), "music playlists leaves existing photo data unchanged");
    for (const pathname of ["/api/music/playlists/unknown", "/api/music/smart-playlists/hires", "/api/music/tracks?smart=unknown", "/api/music/not-implemented", "/api/novels"]) {
      check((await fetch(`${origin}${pathname}`, { headers: musicPlaylistsHeaders })).status === 404, `music playlists does not add an unused API ${pathname}`);
    }
    for (const track of smartTracks.tracks) {
      for (const pathname of [`/api/music/tracks/${track.id}`, `/media/music/${track.id}`, `/media/music-download/${track.id}`]) {
        check((await fetch(`${origin}${pathname}`, { headers: musicPlaylistsHeaders })).status === 404, `playlist track detail and audio stay unavailable ${pathname}`);
      }
    }
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      for (const pathname of ["/api/music/playlists", `/api/music/playlists/${longPlaylist.id}`, `/api/music/playlists/${longPlaylist.id}/tracks`,
        "/api/music/tracks/fixture-music-details-track-1/progress", "/api/music/tracks/fixture-music-details-track-1/favorite", "/api/music/history"]) {
        check((await fetch(`${origin}${pathname}`, { method, headers: musicPlaylistsHeaders })).status === 405, `music playlists rejects ${method} business write ${pathname}`);
      }
    }
    for (const [sceneHeaders, pathname] of [[musicHeaders, "/api/music/tracks"], [musicDetailsHeaders, "/api/music/tracks"],
      [musicPlaylistsHeaders, "/api/music/tracks"], [musicPlaylistsHeaders, `/api/music/playlists/${longPlaylist.id}`], [musicPlaylistsHeaders, "/api/music/history"]]) {
      const payload = await (await fetch(`${origin}${pathname}`, { headers: sceneHeaders })).json();
      check(payload.genres.length === 1 && payload.genres[0].id === "流行" && payload.genres[0].id === payload.genres[0].name,
        `music genre facets retain the publicGenre id/name contract for ${pathname}`);
    }
    const episodesResponse = await (await fetch(`${origin}/api/image-library/items?mode=tv&tvView=episodes&seriesKey=fixture-series-one`, { headers })).json();
    check(episodesResponse.items.length === 2 && episodesResponse.items.every((item) => item.type === "tv"), "actual tv drilldown API shape");
    check((await fetch(`${origin}/api/gallery-media/fixture-movie-one`, { headers })).status === 200, "synthetic detail");
    check((await fetch(`${origin}/api/library`, { method: "DELETE" })).status === 405, "no API writes");
    check((await fetch(`${origin}/api/not-implemented`)).status === 404, "no proxy fallback");
    check((await fetch(`${origin}/run/${run.runId}/www/%2e%2e%2f%2e%2e%2fAGENTS.md`)).status === 404, "no traversal");
    check((await fetch(`${origin}/run/${run.runId}/www/package.json`)).status === 404, "no arbitrary workspace files");
    check((await fetch(origin, { headers: { Origin: "http://example.invalid" } })).status === 403, "cross-origin rejected");
    const hostileHostStatus = await new Promise((resolve, reject) => {
      const probe = httpRequest(origin, { headers: { Host: "example.invalid" } }, (result) => { result.resume(); resolve(result.statusCode); });
      probe.on("error", reject);
      probe.end();
    });
    check(hostileHostStatus === 403, "DNS rebinding rejected");
    const second = await (await fetch(`${origin}/fixture/new-run`, { method: "POST" })).json();
    check(second.runId !== run.runId, "fresh storage namespace per run");
    const log = await (await fetch(`${origin}/fixture/requests?run=${run.runId}`)).json();
    check(log.requests.some((entry) => entry.query.mode === "movie") && log.requests.some((entry) => entry.query.mode === "tv"), "real HTTP request log");
    check((await fetch(`${origin}${run.url}`)).headers.get("content-security-policy").includes("connect-src 'self'"), "browser network fence supplied");
    check(launcherText.includes('data-fixture-scenario="music-bottom-layout"'), "visible bottom layout pressure scene");
    const bottomRunResponse = await fetch(`${origin}/fixture/new-run?scenario=music-bottom-layout`, { method: "POST" });
    check(bottomRunResponse.status === 200, "bottom layout creates an isolated run");
    const bottomRun = await bottomRunResponse.json(), bottomHeaders = { Referer: new URL(bottomRun.url, origin).href };
    check(new URL(bottomRun.url, origin).hash === "#music?mode=library&dashboard=0", "bottom scene uses the actual flat music route");
    check((await (await fetch(`${origin}${bottomRun.url}`)).text()).includes("&scenario=music-bottom-layout"), "pressure profile is explicit in the pre-app bootstrap");
    const bottomFirst = await (await fetch(`${origin}/api/music/tracks`, { headers: bottomHeaders })).json();
    const bottomLast = await (await fetch(`${origin}/api/music/tracks?offset=160&limit=80`, { headers: bottomHeaders })).json();
    check(bottomFirst.tracks.length === 80 && bottomFirst.total === 200 && bottomFirst.hasMore, "bottom scene has a real paged deep synthetic list");
    check(bottomLast.tracks.length === 40 && !bottomLast.hasMore && bottomLast.tracks.at(-1).id === "fixture-bottom-track-200", "bottom scene final page is complete");
    check((await (await fetch(`${origin}/run/${bottomRun.runId}/www/css/settings-nav.css`)).text()).includes("var(--fixture-safe-area-bottom, env(safe-area-inset-bottom))"), "safe-area pressure is an explicit fixture-only CSS override");
    check(!(await (await fetch(`${origin}/run/${run.runId}/www/css/settings-nav.css`)).text()).includes("--fixture-safe-area-bottom"), "ordinary scenes retain unchanged safe-area CSS");
    check((await fetch(`${origin}/api/music/tracks/fixture-bottom-track-001`, { headers: bottomHeaders })).status === 404, "bottom scene does not expose playback details");
    check((await fetch(`${origin}/api/music/tracks/fixture-bottom-track-001/favorite`, { method: "POST", headers: bottomHeaders })).status === 405, "bottom scene remains read-only");
    check(launcherText.includes('data-fixture-scenario="media-layout"') && launcherText.includes("影视布局压力（长片名、剧名与文件信息）"), "visible media layout launcher");
    const mediaResponse = await fetch(`${origin}/fixture/new-run?scenario=media-layout`, { method: "POST" });
    check(mediaResponse.status === 200, "media layout creates an isolated run");
    const mediaRun = await mediaResponse.json(), mediaHeaders = { Referer: new URL(mediaRun.url, origin).href };
    check(new URL(mediaRun.url, origin).hash === "#channel?mode=movie", "media layout opens the actual movie shell route");
    const mediaMovies = await (await fetch(`${origin}/api/image-library/items?mode=movie`, { headers: mediaHeaders })).json();
    check(mediaMovies.items.length === 2 && mediaMovies.items.every(item => item.title.length >= 40 && item.movieMetadata.title.length >= 40), "two long movies retain complete movie metadata");
    const mediaSeries = await (await fetch(`${origin}/api/image-library/items?mode=tv`, { headers: mediaHeaders })).json();
    check(mediaSeries.items.length === 1 && mediaSeries.items[0].title.length >= 40, "one long synthetic series");
    const mediaEpisodes = await (await fetch(`${origin}/api/image-library/items?mode=tv&tvView=episodes&seriesKey=${mediaLayoutSeries.seriesKey}`, { headers: mediaHeaders })).json();
    check(mediaEpisodes.items.length === 2 && mediaEpisodes.items.every(item => item.title.length >= 40), "two long synthetic episodes");
    check([mediaMovies.items[1], mediaEpisodes.items[1]].every(item => /^[A-Za-z]{64,}$/.test(item.rootLabel)
      && item.relativePath.includes(`/${item.rootLabel}/`)), "second movie and episode retain unbroken Latin root/path pressure");
    for (const item of [...mediaMovies.items, ...mediaEpisodes.items]) {
      const detailPath = `/api/gallery-media/${encodeURIComponent(item.id)}`;
      const detailResponse = await fetch(`${origin}${detailPath}`, { headers: mediaHeaders });
      const detail = (await detailResponse.json()).item;
      check(detailResponse.status === 200 && detail.id === item.id && detail.rootLabel.length >= 40 && detail.relativePath.length >= 100
        && detail.videos[0].name.length >= 40 && detail.videos[0].relativePath === detail.relativePath, "detail uses long root/path/public video filename DTOs");
      check(detail.exists === false && detail.playable === false && detail.streamUrl === "" && detail.videos[0].playable === false, "media layout never enables playback");
      check((await fetch(`${origin}${detailPath}`, { headers })).status === 404, "media layout IDs remain unavailable to the default scene");
      for (const method of ["POST", "PATCH", "DELETE"]) check((await fetch(`${origin}${detailPath}`, { method, headers: mediaHeaders })).status === 405, "media layout business writes stay rejected");
      check((await fetch(`${origin}/media/gallery-video/${encodeURIComponent(item.id)}`, { headers: mediaHeaders })).status === 404, "synthetic media bytes remain unavailable");
    }
    check((await fetch(`${origin}/api/gallery-media/unknown-media-layout-id`, { headers: mediaHeaders })).status === 404, "unknown media layout details do not proxy");
    const ordinaryMovies = await (await fetch(`${origin}/api/image-library/items?mode=movie`, { headers })).json();
    check(JSON.stringify(ordinaryMovies.items.map(item => item.title)) === JSON.stringify(movieItems.map(item => item.title)), "ordinary movie data stays unchanged");
    const mediaCss = mediaRun.files.find(item => item.name === "modules/media/styles.css");
    check(mediaCss && sha256(Buffer.from(await (await fetch(`${origin}/run/${mediaRun.runId}/www/${mediaCss.name}`, { headers: mediaHeaders })).arrayBuffer())) === mediaCss.servedSha256, "media layout uses the frozen real media stylesheet");
    check(launcherText.includes('data-fixture-scenario="manga-layout"') && launcherText.includes("漫画详情与阅读布局（长简介与章节）"), "visible manga layout launcher");
    const mangaResponse = await fetch(`${origin}/fixture/new-run?scenario=manga-layout`, { method: "POST" });
    check(mangaResponse.status === 200, "manga layout creates an isolated run");
    const mangaRun = await mangaResponse.json(), mangaHeaders = { Referer: new URL(mangaRun.url, origin).href };
    check(new URL(mangaRun.url, origin).hash === "#channel?mode=manga", "manga layout opens the actual manga list shell route");
    const mangaItems = await (await fetch(`${origin}/api/image-library/items?mode=manga`, { headers: mangaHeaders })).json();
    check(mangaItems.items.length === 3 && mangaItems.items[0].title.length >= 40 && /^[A-Za-z]{64,}$/.test(mangaItems.items[1].title)
      && mangaItems.items.every(item => item.type === "manga" && item.chapterCount === 3 && item.imageCount === 9), "three manga summaries cover Chinese, unbroken Latin and fallback cases");
    check(mangaItems.items[0].description.length > 300 && mangaItems.items[1].description.length >= 60 && mangaItems.items[1].description.length <= 80
      && !mangaItems.items[1].description.includes("\n") && mangaItems.items[2].description === "", "long, short and empty description DTOs retain distinct semantics");
    for (const item of mangaItems.items) {
      const detailPath = `/api/manga/${item.id}`;
      const detail = await (await fetch(`${origin}${detailPath}`, { headers: mangaHeaders })).json();
      check(detail.comic.id === item.id && detail.comic.chapters.length === 3 && detail.update.status === "idle"
        && detail.comic.sourceUrl === "" && detail.cache.exists, "manga public detail has three readable chapters and no update source");
      check((await fetch(`${origin}${detailPath}`, { headers })).status === 404 && (await fetch(`${origin}${detailPath}`, { headers: mediaHeaders })).status === 404, "manga details stay out of default and media scenes");
      for (const index of [1, 2, 3]) {
        const chapterPath = `${detailPath}/chapters/${index}`;
        const payload = await (await fetch(`${origin}${chapterPath}`, { headers: mangaHeaders })).json();
        const chapter = payload.chapter;
        check(payload.comic.id === item.id && chapter.index === index && chapter.images.length === 3
          && chapter.imageCount === 3 && chapter.downloadedCount === 3 && chapter.status === "done", "manga chapter manifest uses the owning public DTO");
        check(chapter.navigation.position === index && chapter.navigation.total === 3
          && (chapter.navigation.previous?.index ?? null) === (index > 1 ? index - 1 : null)
          && (chapter.navigation.next?.index ?? null) === (index < 3 ? index + 1 : null), "manga chapter previous/next navigation is exact");
        for (const image of chapter.images) {
          const imageResponse = await fetch(`${origin}${image.url}`), svg = await imageResponse.text();
          check(imageResponse.status === 200 && imageResponse.headers.get("content-type").startsWith("image/svg+xml")
            && image.width === 720 && image.height === 1080 && image.bytes === Buffer.byteLength(svg)
            && image.contentType === "image/svg+xml" && image.status === "downloaded"
            && svg.includes("SAFE GEOMETRY ONLY") && !/<script|href=|foreignObject/i.test(svg), "no-referrer reader loads only safe generated SVG geometry");
          check((await fetch(`${origin}${image.url}`, { headers })).status === 404, "a different run cannot address manga page images");
        }
        check((await fetch(`${origin}${chapterPath}/download`, { headers: mangaHeaders })).status === 404, "chapter downloads never expose bytes");
        check((await fetch(`${origin}${chapterPath}`, { headers })).status === 404, "chapter manifests stay out of the default scene");
      }
      for (const method of ["POST", "PATCH", "DELETE"]) for (const target of [detailPath, `${detailPath}/update`, `${detailPath}/favorite`, `${detailPath}/chapters/1`]) {
        check((await fetch(`${origin}${target}`, { method, headers: mangaHeaders })).status === 405, "manga business writes stay rejected");
      }
      for (const target of [`${detailPath}/download`, `${detailPath}/update`, `/media/manga/${item.id}/1/1`, `/media/manga-cover/${item.id}`]) {
        check((await fetch(`${origin}${target}`, { headers: mangaHeaders })).status === 404, "no update reads, archive or actual manga media fallback");
      }
    }
    for (const target of ["/api/manga/unknown-manga-layout-id", `/api/manga/${mangaLayoutComics[0].id}/chapters/4`,
      mangaLayoutImage(run.runId, mangaLayoutComics[0].id, 1, 1), mangaLayoutImage(mangaRun.runId, "unknown-manga", 1, 1),
      mangaLayoutImage(mangaRun.runId, mangaLayoutComics[0].id, 4, 1), `${mangaLayoutImage(mangaRun.runId, mangaLayoutComics[0].id, 1, 1)}?path=../real`]) {
      check((await fetch(`${origin}${target}`, { headers: mangaHeaders })).status === 404, "unknown manga IDs, image indices, runs and query paths stay rejected");
    }
    const ordinaryManga = await (await fetch(`${origin}/api/image-library/items?mode=manga`, { headers })).json();
    check(ordinaryManga.items.length === 1 && ordinaryManga.items[0].id === "fixture-manga" && ordinaryManga.items[0].chapterCount === 0, "default manga data remains unchanged");
    const mangaCss = mangaRun.files.find(item => item.name === "modules/photos/styles.css");
    check(mangaCss && sha256(Buffer.from(await (await fetch(`${origin}/run/${mangaRun.runId}/www/${mangaCss.name}`, { headers: mangaHeaders })).arrayBuffer())) === mangaCss.servedSha256, "manga layout retains the frozen real photos stylesheet");
    check(launcherText.includes('data-fixture-scenario="manga-panels"') && launcherText.includes("漫画添加与下载记录面板（长任务信息）"), "visible manga panels launcher");
    const panelsResponse = await fetch(`${origin}/fixture/new-run?scenario=manga-panels`, { method: "POST" });
    check(panelsResponse.status === 200, "manga panels creates an isolated run");
    const panelsRun = await panelsResponse.json(), panelsHeaders = { Referer: new URL(panelsRun.url, origin).href };
    check(new URL(panelsRun.url, origin).hash === "#channel?mode=manga", "manga panels opens the real library route");
    const panelJobs = (await (await fetch(`${origin}/api/manga/jobs?limit=12`, { headers: panelsHeaders })).json()).jobs;
    check(panelJobs.length === 3 && panelJobs.map(job => job.status).join(",") === "running,failed,complete", "fixed running, failed and complete public jobs");
    check(new Set(panelJobs.map(job => job.comicId)).size === 3, "all three history records have distinct logical comic owners");
    check(/^[A-Za-z]{64,}$/.test(panelJobs[0].title) && /^[A-Za-z]{64,}$/.test(panelJobs[0].currentChapterTitle)
      && panelJobs[1].message.length > 180 && panelJobs[1].message.includes("错误信息末尾仍应完整可读"), "long title, current chapter and error use actual public job fields");
    check(JSON.stringify((await (await fetch(`${origin}/api/manga/jobs?limit=1`, { headers: panelsHeaders })).json()).jobs) === JSON.stringify(panelJobs.slice(0, 1)), "job limit matches the owning list contract");
    check(JSON.stringify((await (await fetch(`${origin}/api/manga/jobs?limit=12`, { headers: panelsHeaders })).json()).jobs) === JSON.stringify(panelJobs), "polling does not simulate task progress or cause writes");
    for (const job of panelJobs) {
      check(job.comicAvailable === true && mangaLayoutComics.some(comic => comic.id === job.comicId && comic.title === job.title)
        && new URL(job.sourceUrl).hostname.endsWith(".invalid") && !Object.hasOwn(job, "error") && !Object.hasOwn(job, "stage"), "public job presentation has a safe known comic and inert synthetic source");
      const requiredCounts = ["totalChapters", "cachedChapters", "pendingChapters", "processedChapters", "completedChapters", "failedChapters", "currentChapterIndex", "completedImages", "totalImages", "downloadedImages", "failedImages", "downloadedBytes", "progressPercent"];
      check(requiredCounts.every(key => Number.isFinite(job[key]) && job[key] >= 0) && job.totalChapters === 3
        && job.cachedChapters + job.completedChapters <= job.totalChapters && job.progressPercent <= 100, "job counters stay internally consistent");
      const jobPath = `/api/manga/jobs/${job.id}`;
      check(JSON.stringify((await (await fetch(`${origin}${jobPath}`, { headers: panelsHeaders })).json()).job) === JSON.stringify(job), "known individual job GET matches its list DTO");
      for (const scopedHeaders of [headers, mangaHeaders, mediaHeaders]) check((await fetch(`${origin}${jobPath}`, { headers: scopedHeaders })).status === 404, "job IDs remain isolated from previous scenes");
      for (const method of ["POST", "PATCH", "DELETE"]) for (const target of [jobPath, `${jobPath}/retry`]) check((await fetch(`${origin}${target}`, { method, headers: panelsHeaders })).status === 405, "job retry and mutation paths remain rejected");
    }
    check((await fetch(`${origin}/api/manga/jobs/unknown-synthetic-job`, { headers: panelsHeaders })).status === 404, "unknown jobs never proxy to a service");
    for (const scopedHeaders of [headers, mangaHeaders, mediaHeaders]) check((await (await fetch(`${origin}/api/manga/jobs`, { headers: scopedHeaders })).json()).jobs.length === 0, "previous scenes retain empty job lists");
    const panelComics = await (await fetch(`${origin}/api/image-library/items?mode=manga`, { headers: panelsHeaders })).json();
    check(JSON.stringify(panelComics.items) === JSON.stringify(mangaItems.items), "manga panels reuses the existing safe comic list without changing it");
    const panelDetail = await (await fetch(`${origin}/api/manga/${mangaLayoutComics[0].id}`, { headers: panelsHeaders })).json();
    check(panelDetail.comic.chapters.length === 3 && panelDetail.update.status === "idle", "known book-page actions retain the safe detail DTO");
    const panelChapter = await (await fetch(`${origin}/api/manga/${mangaLayoutComics[0].id}/chapters/1`, { headers: panelsHeaders })).json();
    check(panelChapter.chapter.images.length === 3 && (await fetch(`${origin}${panelChapter.chapter.images[0].url}`)).status === 200, "manga panel book pages retain run-scoped generated image access");
    check((await fetch(`${origin}${panelChapter.chapter.images[0].url}`, { headers: mangaHeaders })).status === 404, "old manga runs cannot address a panel run's images");
    for (const target of ["/api/manga/add", "/api/manga/jobs/history", `/api/manga/${mangaLayoutComics[0].id}/update`]) {
      for (const method of ["POST", "PATCH", "DELETE"]) check((await fetch(`${origin}${target}`, { method, headers: panelsHeaders })).status === 405, "panel add/update/history mutations remain rejected");
    }
    for (const target of [`/api/manga/${mangaLayoutComics[0].id}/download`, `/api/manga/${mangaLayoutComics[0].id}/chapters/1/download`, `/media/manga/${mangaLayoutComics[0].id}/1/1`]) {
      check((await fetch(`${origin}${target}`, { headers: panelsHeaders })).status === 404, "panel archives and actual media bytes remain unavailable");
    }
    for (const previousRun of runs.values()) check((await fetch(`${origin}/api/manga/add`, { method: "POST", headers: { Referer: new URL(previousRun.url || describeRun(previousRun).url, origin).href, Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify({ url: mangaRecoveryUrl }) })).status === 405, "every previous scene still rejects manga-add POST");
    console.log(JSON.stringify({ result: "PASS", checks, frozenFiles: run.files.length, bytes: run.totalBytes, boundary: "HTTP/source isolation only; browser layout, CSP enforcement, routing, and native behavior not asserted" }, null, 2));
  } finally { await new Promise((resolve) => server.close(resolve)); }
} else {
  console.log(`Android gallery navigation fixture: ${origin}/`);
  console.log("Create a fresh run from the launcher after production changes; same-run reload preserves navigation.");
  for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => server.close(() => process.exit(0)));
}
