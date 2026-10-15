import path from "node:path";
import { createImageLibraryService } from "../../src/modules/content-index/server/image-library-service.js";
import { createGalleryMediaService } from "../../src/modules/media/server/gallery-media-service.js";
import { createPlaybackProgressService } from "../../src/modules/fanhao/server/playback/playback-progress-service.js";
import { createWorkDetailService } from "../../src/modules/fanhao/server/works/work-detail-service.js";

// Shared synthetic-only backend for VM and isolated browser tests. The actual
// list/detail/progress/play-info selectors run; paths/stat/probe/persistence are
// explicit in-memory boundaries. No service is started and no media/DB is read.
export const ANIME_FIXTURE = Object.freeze({
  categories: ["合成日本", "合成中国"],
  titles: { alpha: "Alpha 合成动漫", beta: "Beta 合成动漫", feature: "Gamma 合成剧场版" }
});
export function createSyntheticAnimeLibrary({ count = 300, betaCount = 3, metadataCount = 9999 } = {}) {
  if (!Number.isInteger(count) || count < 1 || count > 2000) throw new Error("Synthetic count must be 1..2000");
  const id = (series, number = 1) => `${series}-${String(number).padStart(4, "0")}`;
  const metadata = new Map(), movies = new Map(), progressState = { progress: {}, favorites: {}, favoriteFolders: {} };
  const core = { worksById: new Map(), filesById: new Map(), peopleById: new Map() };
  let saves = 0;
  const progressService = createPlaybackProgressService({ getLibrary: () => core, publicFavoriteFolders: () => [], recentWatchedDays: 30,
    userState: progressState, userStateService: { save() { saves++; } } });
  const rows = [];
  const append = (series, title, category, length, mediaKind, rating, day) => {
    const key = `${mediaKind === "anime" ? "动漫:" : ""}${category}|${title}`;
    if (mediaKind !== "movie") metadata.set(key, { title, category, rating, ratingCount: 123, year: "2025",
      episodeCount: metadataCount, genres: [mediaKind === "anime" ? "动画" : "剧情"],
      coverUrl: `/synthetic-cover/${series}.svg` });
    for (let number = 1; number <= length; number++) rows.push({ id: id(series, number), title: `${title} Episode ${number}`,
      mediaKind, type: mediaKind, category, seriesName: title, sourceRoot: "synthetic-media-root",
      relativePath: `${series}/episode-${number}.mkv`, ext: "mkv", playable: true, size: 1000 + number,
      updatedAt: `2026-08-${day}T00:00:00Z` });
    return key;
  };
  const keys = {
    alpha: append("anime-alpha", ANIME_FIXTURE.titles.alpha, ANIME_FIXTURE.categories[0], count, "anime", 7.1, "01"),
    beta: append("anime-beta", ANIME_FIXTURE.titles.beta, ANIME_FIXTURE.categories[1], betaCount, "anime", 8.8, "03"),
    feature: append("anime-feature", ANIME_FIXTURE.titles.feature, ANIME_FIXTURE.categories[0], 1, "anime", 9.0, "02"),
    tv: append("tv-alpha", ANIME_FIXTURE.titles.alpha, ANIME_FIXTURE.categories[0], 2, "tv", 9.5, "04"),
    movie: append("movie-alpha", "Synthetic unrelated movie", "仅电影分类", 1, "movie", 6.0, "05")
  };
  movies.set(id("movie-alpha"), { title: "Synthetic unrelated movie", year: "2025", rating: 6.0 });
  const index = { scannedAt: "2026-08-31T00:00:00Z", photoSets: [], mediaItems: rows };
  const listService = createImageLibraryService({
    clampInteger(value, fallback, min, max) { const n = Number.parseInt(String(value ?? ""), 10); return Math.min(max, Math.max(min, Number.isFinite(n) ? n : fallback)); },
    getImageLibraryIndex: () => index, maxItemLimit: 12000, galleryMediaRootStatuses: () => [], imageReaderCacheStatus: () => ({}),
    photoSetRootStatuses: () => [], mangaService: { cacheDirs: () => [], publicSummary: value => value, rootStatus: () => ({}) },
    metadataService: { movieRowsMap: () => movies, movieRow: key => movies.get(key), publicMovie: value => value,
      tvSeriesRowsMap: () => metadata, tvSeriesRow: key => metadata.get(key), publicTvSeries: value => value,
      tvSeriesKey: (category, title) => `${category}|${title}` },
    photoCollectionRootValue: "synthetic", photoSetService: { coverUrl: () => "" }
  });
  const fail = () => { throw new Error("Synthetic anime fixture forbids external IO"); };
  const mediaService = createGalleryMediaService({ publicGalleryMediaItem: listService.publicGalleryMediaItem,
    getImageLibraryIndex: () => index, playbackProgressService: progressService,
    safeChildPath: (root, relative) => root === "synthetic-media-root" && rows.some(row => row.relativePath === relative) ? `synthetic/${relative}` : "",
    safeStat: file => file.startsWith("synthetic/") ? { size: 4096, mtimeMs: Date.parse("2026-08-01T00:00:00Z"), isFile: () => true } : null,
    normalizeExt: file => path.extname(file).toLowerCase(), directVideoExts: new Set([".mkv", ".mp4"]),
    getImageGalleryDb: fail, videoProbeCached: fail, notFound: fail, mediaStreamService: { serveVideo: fail },
    ffmpegPath: "FORBIDDEN_SYNTHETIC", coverBoxSize: 320, coverMaxBytes: 1024, coverGeneratorVersion: 1 });
  const workDetailService = createWorkDetailService({ galleryMediaService: mediaService, library: core,
    playbackProgressService: progressService, resolveVideoFileByPublicId: () => null,
    videoProbeService: { async playInfoForFileAsync(file, videoId, options) {
      return { mode: "direct", videoId, duration: 600, streamUrl: `${options.streamBase}/${encodeURIComponent(videoId)}`,
        fallbackStreamUrl: `${options.streamBase}/${encodeURIComponent(videoId)}/transcode` };
    } } });
  return {
    id, keys, rows, index, listService, mediaService, progressService, progressState,
    get saveCount() { return saves; },
    list(url) { return listService.itemsPayload(url instanceof URL ? url : new URL(url, "https://synthetic.invalid")); },
    detail(mediaId) { const row = mediaService.byId(mediaId); return row ? { item: mediaService.publicDetail(row) } : null; },
    playInfo(mediaId, options = { source: "gallery" }) { return workDetailService.playInfoPayload(mediaId, options); },
    saveProgress(mediaId, body) { if (!mediaService.byId(mediaId)) throw new Error("Unknown synthetic media ID"); return progressService.saveVideoProgress(mediaId, body); }
  };
}
