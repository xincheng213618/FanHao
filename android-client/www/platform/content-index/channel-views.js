import { fetchJson } from "../../js/api.js?v=assets-07b744082137";
import { enhanceAutoLoadMore } from "../../js/auto-load.js?v=assets-07b744082137";
import { cacheAgeText, readCachedJson, writeCachedJson } from "../../js/cache.js?v=assets-07b744082137";
import { isChannelFavorite, toggleChannelFavorite } from "../../js/channel-favorites.js";
import { formatBytes, formatDate, formatNumber, formatTime } from "../../js/format.js";
import { absoluteUrl, loadPreviewImage } from "../../js/image.js";
import { photoCatalogCollections } from "./photo-catalog.js";

const CHANNELS = {
  photo: { label: "套图", path: "/photo", empty: "还没有索引到套图。", unit: "套" },
  manga: { label: "韩漫", path: "/photo/manga", empty: "还没有缓存漫画。", unit: "部" },
  western: { label: "欧美", path: "/western", empty: "还没有索引到欧美视频。", unit: "视频" },
  media: { label: "影视作品", path: "/media", empty: "还没有索引到影视作品。", unit: "部" },
  movie: { label: "电影", path: "/movies", empty: "还没有索引到电影。", unit: "影片" },
  tv: { label: "电视剧", path: "/tv", empty: "还没有索引到电视剧。", unit: "剧" },
  anime: { label: "动漫", path: "/media?kind=anime", empty: "还没有索引到动漫。", unit: "部" }
};
const EAGER_PHOTO_COVER_COUNT = 4;
const EAGER_PHOTO_DETAIL_IMAGE_COUNT = 4;
const PHOTO_DETAIL_IMAGE_CONCURRENCY = 4;
const EAGER_CHANNEL_COVER_COUNT = 14;
const LAZY_PHOTO_PREVIEW_ROOT_MARGIN = "180px 0px 420px 0px";
const LAZY_PHOTO_DETAIL_ROOT_MARGIN = "240px 0px 560px 0px";
const LAZY_CHANNEL_PREVIEW_ROOT_MARGIN = "900px 0px 1200px 0px";
const PLAY_OPEN_COOLDOWN_MS = 1400;
let mediaPlaybackSessionSequence = 0;
const MANGA_READING_PROGRESS_STORAGE_KEY = "fanhao.android.mangaReadingProgress.v1";
const MANGA_RESUME_REQUEST_STORAGE_KEY = "fanhao.android.mangaResumeRequest.v1";
const MAX_MANGA_READING_PROGRESS = 60;

export function mediaResumePosition(progress = {}) {
  const position = Number(progress?.position);
  const duration = Number(progress?.duration);
  return Number.isFinite(position) && Number.isFinite(duration)
    && position > 5 && duration > 0 && position < duration - 8 ? position : 0;
}

export function mediaPlaybackLabel(item = {}) {
  const position = mediaResumePosition(item.progress);
  return position > 0 ? `继续播放 · ${formatTime(position)}` : "点击播放";
}

export function mediaPlaybackUrl(sourceUrl, value) {
  if (!value) return "";
  try {
    const source = new URL(sourceUrl);
    const url = new URL(absoluteUrl(sourceUrl, value));
    return ["http:", "https:"].includes(url.protocol) && url.origin === source.origin
      && !url.username && !url.password ? url.toString() : "";
  } catch {
    return "";
  }
}

function readMangaReadingProgress(mangaId) {
  const id = String(mangaId || "").trim();
  if (!id) return null;
  try {
    const records = JSON.parse(localStorage.getItem(MANGA_READING_PROGRESS_STORAGE_KEY) || "{}");
    const progress = records && typeof records === "object" ? records[id] : null;
    if (!progress || Number(progress.chapterIndex || 0) <= 0) return null;
    return progress;
  } catch {
    return null;
  }
}

function writeMangaReadingProgress(mangaId, progress = {}) {
  const id = String(mangaId || "").trim();
  if (!id || Number(progress.chapterIndex || 0) <= 0) return;
  try {
    const parsed = JSON.parse(localStorage.getItem(MANGA_READING_PROGRESS_STORAGE_KEY) || "{}");
    const records = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    records[id] = {
      chapterIndex: Number(progress.chapterIndex),
      chapterTitle: String(progress.chapterTitle || ""),
      chapterPosition: Math.max(1, Number(progress.chapterPosition || 1)),
      chapterTotal: Math.max(1, Number(progress.chapterTotal || 1)),
      pageIndex: Math.max(1, Number(progress.pageIndex || 1)),
      pageTotal: Math.max(1, Number(progress.pageTotal || 1)),
      updatedAt: new Date().toISOString()
    };
    const entries = Object.entries(records)
      .sort((a, b) => String(b[1]?.updatedAt || "").localeCompare(String(a[1]?.updatedAt || "")))
      .slice(0, MAX_MANGA_READING_PROGRESS);
    localStorage.setItem(MANGA_READING_PROGRESS_STORAGE_KEY, JSON.stringify(Object.fromEntries(entries)));
  } catch {}
}

function requestMangaResume(mangaId, chapterIndex, pageIndex) {
  try {
    sessionStorage.setItem(MANGA_RESUME_REQUEST_STORAGE_KEY, JSON.stringify({
      mangaId: String(mangaId || ""),
      chapterIndex: Number(chapterIndex || 0),
      pageIndex: Math.max(1, Number(pageIndex || 1))
    }));
  } catch {}
}

function consumeMangaResume(mangaId, chapterIndex) {
  try {
    const request = JSON.parse(sessionStorage.getItem(MANGA_RESUME_REQUEST_STORAGE_KEY) || "null");
    if (request?.mangaId !== String(mangaId || "") || Number(request?.chapterIndex || 0) !== Number(chapterIndex || 0)) return null;
    sessionStorage.removeItem(MANGA_RESUME_REQUEST_STORAGE_KEY);
    return request;
  } catch {
    return null;
  }
}

function channelDataSignature(data = {}) {
  const items = Array.isArray(data.items) ? data.items : [];
  return JSON.stringify({
    total: Number(data.total || items.length),
    mode: data.mode || "",
    query: data.query || "",
    photoView: data.photoView || "",
    category: data.category || "",
    person: data.person || "",
    collection: data.collection || "",
    tvView: data.tvView || "",
    seriesKey: data.seriesKey || "",
    sort: data.sort || "",
    rawLoaded: data.rawLoaded,
    hasMore: data.hasMore,
    searchTerms: data.searchTerms || [],
    facets: data.facets || null,
    items: items.map((item) => [
      item.id || "",
      item.type || "",
      item.title || "",
      item.coverUrl || "",
      item.routePath || "",
      item.updatedAt || "",
      item.size || 0,
      item.collectionId || "",
      item.matchFields || [],
      item.seriesKey || "",
      item.chapterCount ?? "",
      item.imageCount ?? "",
      item.doneChapterCount ?? "",
      item.year ?? "",
      item.rating ?? "",
      item.genres ?? [],
      item.movieMetadata ?? null,
      item.tvSeries ?? null,
      item.episodeCount ?? "",
      item.mediaKind || "",
      item.category || "",
      item.ext || "",
      item.collections?.map((collection) => [collection.id, collection.title, collection.albumCount, collection.size, collection.updatedAt, collection.coverUrl])
    ])
  });
}

function photoAlbumDataSignature(album = {}) {
  const images = Array.isArray(album.images) ? album.images : [];
  return JSON.stringify({
    id: album.id || "",
    updatedAt: album.updatedAt || "",
    imageCount: Number(album.imageCount || images.length || 0),
    imageOffset: Number(album.imageOffset || 0),
    imageLimit: Number(album.imageLimit || images.length || 0),
    coverUrl: album.coverUrl || "",
    images: images.map((image) => [image.index || 0, image.url || "", image.name || "", Number(image.bytes || 0)])
  });
}

export function normalizeChannelMode(value) {
  const mode = String(value || "").trim();
  if (mode === "movies") return "movie";
  if (["video", "videos", "screen", "film", "films"].includes(mode)) return "media";
  return CHANNELS[mode] ? mode : "photo";
}

export function channelConfig(mode) {
  return CHANNELS[normalizeChannelMode(mode)] || CHANNELS.photo;
}

export function mangaWholeDownloadReady(comic = {}) {
  const chapterCount = Math.max(0, Number(comic.chapterCount || 0));
  const doneChapterCount = Math.max(0, Number(comic.doneChapterCount || 0));
  const imageCount = Math.max(0, Number(comic.imageCount || 0));
  const downloadedCount = Math.max(0, Number(comic.downloadedCount || 0));
  const failedCount = Math.max(0, Number(comic.failedCount || 0));
  return chapterCount > 0
    && doneChapterCount >= chapterCount
    && imageCount > 0
    && downloadedCount >= imageCount
    && failedCount === 0;
}

export function mangaJobChapterStats(job = {}) {
  const total = Math.max(0, Number(job.totalChapters || 0));
  const cached = Math.max(0, Number(job.cachedChapters || 0));
  const completedThisRun = Math.max(0, Number(job.completedChapters || 0));
  const completed = total > 0 ? Math.min(total, cached + completedThisRun) : cached + completedThisRun;
  return {
    total,
    completed,
    remaining: Math.max(0, total - completed)
  };
}

export function tvSeriesCardNavigation(mode, item = {}) {
  const normalizedMode = normalizeChannelMode(mode);
  if (!["tv", "anime", "media"].includes(normalizedMode)) return null;
  if (!["tvSeries", "tvSeriesWork"].includes(String(item?.type || ""))) return null;
  const params = {
    tvView: "episodes",
    seriesKey: item.seriesKey || item.id,
    category: item.category || "",
    query: "",
    sort: "title"
  };
  if (normalizedMode === "media" || normalizedMode === "anime") params.mode = normalizedMode;
  return params;
}

// Catalog posters and episode rows have different jobs. Keep technical filenames
// in the detail disclosure, and never invent ratings, seasons or watched state.
export function movieMetadataHasSeriesConflict(metadata = {}) {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return false;
  const info = metadata.info && typeof metadata.info === "object" && !Array.isArray(metadata.info) ? metadata.info : {};
  const positiveCount = (value) => {
    if (typeof value === "number") return Number.isSafeInteger(value) && value > 0;
    if (typeof value !== "string") return false;
    const match = value.trim().match(/^(?:共\s*)?(\d+)(?:\.0+)?\s*(?:集|季|episodes?|seasons?)?$/i);
    return Boolean(match && Number.isSafeInteger(Number(match[1])) && Number(match[1]) > 0);
  };
  const positiveDuration = (value) => {
    if (typeof value === "number") return Number.isFinite(value) && value > 0;
    if (typeof value !== "string") return false;
    const text = value.trim();
    const simple = text.match(/^(?:约\s*)?(\d+(?:\.\d+)?)\s*(?:分钟|分|秒钟|秒|小时|minutes?|mins?|seconds?|secs?|hours?|hrs?)?$/i);
    if (simple) return Number.isFinite(Number(simple[1])) && Number(simple[1]) > 0;
    const iso = text.match(/^PT(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?$/i);
    if (iso) return iso.slice(1).every((part) => part === undefined || Number.isFinite(Number(part)))
      && iso.slice(1).some((part) => Number(part) > 0);
    if (!/^\d{1,3}:\d{2}(?::\d{2})?$/.test(text)) return false;
    const clock = text.split(":").map(Number);
    return clock.slice(1).every((part) => part < 60) && clock.some((part) => part > 0);
  };
  const subjectTypes = [metadata.subjectType, metadata["@type"]].flat().filter((value) => typeof value === "string");
  return subjectTypes.some((value) => /^(?:https?:\/\/schema\.org\/)?TV(?:Series|Season|Episode)$/i.test(value.trim()))
    || [metadata.seasonCount, metadata.episodeCount, info["季数"], info["集数"]].some(positiveCount)
    || [metadata.episodeDuration, info["单集片长"]].some(positiveDuration);
}

export function normalizeMediaMetadataItem(item = {}, mode = "") {
  if (!item || typeof item !== "object" || Array.isArray(item)) return item;
  if (String(item.mediaKind || item.type || mode) !== "movie" || !movieMetadataHasSeriesConflict(item.movieMetadata)) return item;
  // Legacy servers already promote matched titles/ratings into the list fields.
  // movieTitle is the stored local title, not the remote subject title. Never
  // reclassify a file, rewrite its identity or infer a replacement remote match.
  const title = String(item.movieMetadata.movieTitle || item.title || "影片").trim() || "影片";
  const suffix = item.updatedAt ? `?v=${encodeURIComponent(item.updatedAt)}` : "";
  return {
    ...item,
    title,
    movieMetadata: null,
    year: "",
    rating: null,
    ratingCount: null,
    genres: [],
    coverUrl: item.id ? `/media/gallery-media-cover/${encodeURIComponent(item.id)}${suffix}` : "",
    metadataWarning: "电影资料与剧集信息不符，已显示本地信息。"
  };
}

export function normalizeMediaMetadataPayload(data = {}, mode = data.mode) {
  if (!["movie", "media"].includes(mode) || !Array.isArray(data.items)) return data;
  return { ...data, items: data.items.map((item) => normalizeMediaMetadataItem(item, mode)) };
}

export function mediaCardPresentation(mode, item = {}) {
  if (!["movie", "tv", "anime", "media"].includes(mode)) return null;
  item = normalizeMediaMetadataItem(item, mode);
  const series = ["tvSeries", "tvSeriesWork"].includes(String(item.type || ""));
  const episode = !series && (["tv", "anime"].includes(mode) || ["tv", "anime"].includes(item.type) || ["tv", "anime"].includes(item.mediaKind));
  const metadata = episode || series ? item.tvSeries || {} : item.movieMetadata || {};
  const year = String(item.year || metadata.year || "").trim();
  const rating = Number(item.rating ?? metadata.rating);
  const rawTitle = String(item.title || (series ? metadata.title : "") || (episode ? "剧集" : "影片")).trim();
  let title = !episode && !series ? String(metadata.title || rawTitle).trim() : rawTitle;
  if (!episode && !series && /[\u3400-\u9fff]/u.test(title)) {
    // Match the server's moviePrimaryDisplayTitle: retain the localized title,
    // not the trailing translated title that crowds a narrow poster caption.
    const parts = title.split(/\s+/u);
    const lastCjk = parts.reduce((last, part, index) => /[\u3400-\u9fff]/u.test(part) ? index : last, -1);
    if (/[a-z]/iu.test(parts.slice(lastCjk + 1).join(" "))) title = parts.slice(0, lastCjk + 1).join(" ");
  }
  if (!episode && /^\d{4}$/.test(year)) title = title.replace(new RegExp(`\\s*[（(]${year}[）)]$`), "").trim() || rawTitle;
  if (episode) {
    const match = rawTitle.match(/S(\d{1,2})E(\d{1,3})/i);
    if (match) title = `${Number(match[1]) > 1 ? `第 ${Number(match[1])} 季 · ` : ""}第 ${Number(match[2])} 集`;
  }
  const count = Number(item.episodeCount ?? item.chapterCount);
  const genre = (Array.isArray(item.genres) ? item.genres : Array.isArray(metadata.genres) ? metadata.genres : []).find((value) => typeof value === "string" && value.trim());
  const secondary = String(genre || item.category || "").trim();
  const meta = item.metadataWarning ? ["资料待核对"] : episode
    ? [item.ext ? String(item.ext).toUpperCase() : "", Number(item.size) > 0 ? formatBytes(item.size) : ""].filter(Boolean)
    : [year, series && Number.isFinite(count) && count > 0 ? `${formatNumber(count)} 集在库` : secondary !== title ? secondary : ""].filter(Boolean);
  return { episode, series, title, meta: [...new Set(meta)].join(" · "), rating: !episode && Number.isFinite(rating) && rating > 0 && rating <= 10 ? rating.toFixed(1) : "" };
}

export function selectMangaTaskDisplayJobs(jobs = [], activeJob = null, limit = 6) {
  const byId = new Map();
  for (const job of [activeJob, ...(Array.isArray(jobs) ? jobs : [])]) {
    const id = String(job?.id || "").trim();
    if (!id) continue;
    if (!byId.has(id)) byId.set(id, job);
  }
  const newestByComic = new Map();
  for (const job of [...byId.values()].sort((a, b) => mangaTaskStartedAt(b) - mangaTaskStartedAt(a))) {
    const key = mangaTaskLogicalKey(job);
    if (!newestByComic.has(key)) newestByComic.set(key, job);
  }
  return [...newestByComic.values()]
    .sort((a, b) => {
      const runningDelta = Number(mangaTaskIsRunning(b)) - Number(mangaTaskIsRunning(a));
      const failureDelta = Number(b.status === "failed") - Number(a.status === "failed");
      return runningDelta || failureDelta || mangaTaskStartedAt(b) - mangaTaskStartedAt(a);
    })
    .slice(0, Math.max(0, Number(limit || 0)));
}

export function mangaTaskMonitorDelayMs(jobs = [], options = {}) {
  if (options.hidden === true) return 60_000;
  if ((Array.isArray(jobs) ? jobs : []).some(mangaTaskIsRunning)) return 1_400;
  if (options.connectionError === true) return 10_000;
  return 30_000;
}

export function mergeMangaTaskState(previous, incoming = {}) {
  if (!previous) return incoming;
  const sameJob = previous.id && String(previous.id) === String(incoming.id || "");
  if (!sameJob) {
    if (previous.status === "starting" && !previous.id) return mangaTaskIsRunning(incoming) ? incoming : previous;
    return mangaTaskStartedAt(previous) > mangaTaskStartedAt(incoming) ? previous : incoming;
  }
  // A late list response must not resurrect a task already settled by its detail poll.
  const settled = previous.status === "complete" || (previous.status === "failed" && previous.finishedAt);
  if (settled && mangaTaskIsRunning(incoming)) return previous;
  return { ...previous, ...incoming };
}

export function photoIndexTaskProgress(task = {}) {
  const logs = Array.isArray(task.logs) ? task.logs : [];
  let reported = null;
  for (let index = logs.length - 1; index >= 0; index -= 1) {
    const line = String(logs[index] || "");
    const marker = "IMAGE_LIBRARY_PROGRESS ";
    const position = line.indexOf(marker);
    if (position < 0) continue;
    try {
      reported = JSON.parse(line.slice(position + marker.length));
      break;
    } catch {}
  }
  const status = String(task.status || "idle");
  const fallbackPercent = status === "done" ? 100 : status === "running" || status === "starting" ? 2 : 0;
  const percent = Math.max(0, Math.min(100, Number(reported?.percent ?? fallbackPercent)));
  const fallbackMessage = status === "done"
    ? "索引刷新完成"
    : status === "error" ? "索引刷新失败"
      : status === "stopped" ? "索引刷新已停止"
        : status === "stopping" ? "正在停止扫描"
          : status === "running" || status === "starting" ? "正在准备扫描"
            : "等待刷新";
  return {
    percent,
    message: String(reported?.message || fallbackMessage),
    phase: String(reported?.phase || ""),
    root: String(reported?.root || ""),
    rootIndex: Math.max(0, Number(reported?.rootIndex || 0)),
    rootTotal: Math.max(0, Number(reported?.rootTotal || 0)),
    itemCount: Math.max(0, Number(reported?.itemCount || reported?.photoSets || 0))
  };
}

function mangaTaskLogicalKey(job = {}) {
  const comicId = String(job.comicId || "").trim();
  if (comicId) return `comic:${comicId}`;
  const source = canonicalMangaTaskSource(job.sourceUrl);
  if (source) return `source:${source}`;
  return `task:${String(job.site || "").trim().toLowerCase()}:${String(job.title || job.id || "").trim().toLowerCase()}`;
}

function canonicalMangaTaskSource(value) {
  try {
    const url = new URL(String(value || "").trim());
    const host = url.hostname.toLowerCase().replace(/^www\./, "");
    url.hostname = ["jmd9.com", "91jmd.com"].includes(host) ? "jmd9.com" : host;
    url.hash = "";
    url.search = "";
    return `${url.hostname}${url.pathname.replace(/\/+$/, "")}`.toLowerCase();
  } catch {
    return "";
  }
}

function mangaTaskStartedAt(job = {}) {
  const parsed = Date.parse(String(job.startedAt || ""));
  if (Number.isFinite(parsed)) return parsed;
  const idTimestamp = Number(String(job.id || "").match(/(\d{10,})/u)?.[1] || 0);
  return Number.isFinite(idTimestamp) ? idTimestamp : 0;
}

function mangaTaskIsRunning(job = {}) {
  return ["starting", "running"].includes(String(job.status || ""));
}

export function createChannelViews(context) {
  const {
    els,
    getActiveUrl,
    getChannelLimit,
    increaseChannelLimit,
    getPhotoImageLimit = () => 24,
    increasePhotoImageLimit = () => {},
    getMangaImageLimit = () => 12,
    increaseMangaImageLimit = () => {},
    openInLibrary,
    showPhotoDetail = null,
    showPhotoCatalog = null,
    showMangaDetail = null,
    showMangaCatalog = showMangaDetail,
    showMangaLibrary = null,
    showMangaChapter = null,
    showMediaDetail = null,
    setActiveBottom,
    renderCurrentView,
    renderCurrentViewPreservingScroll = renderCurrentView,
    requestConfirmation = async (options = {}) => window.confirm(options.message || "确认继续吗？"),
    goBack = () => window.history.back(),
    getMediaViewer = () => null,
    recordRecentContent = () => {},
    onChannelFavoriteChange = () => {},
    openMediaSearch = null,
    updateModuleChrome = () => {},
    updateChannelQuery = () => {},
    updateChannelParams = () => {}
  } = context;
  let previewImageObservers = new Map();
  let photoDetailImageObserver = null;
  let photoDetailImageQueue = [];
  let activePhotoDetailImageLoads = 0;
  let photoDetailImageGeneration = 0;
  let photoDetailStartupImage = null;
  let channelPageState = null;
  let channelRequestGeneration = 0;
  let channelRequestController = null;
  let channelRenderingKey = "";
  let mountedChannelList = null;
  let channelMetaHeader = null;
  let mangaAddOpen = false;
  let mangaAddUrl = "";
  let mangaAddJob = null;
  let mangaAddError = "";
  let mangaAddPoll = null;
  let mangaAddGeneration = 0;
  let mangaTaskJobs = [];
  let mangaTaskLoaded = false;
  let mangaTaskError = "";
  let mangaTaskHistoryOpen = false;
  let mangaTaskClearing = false;
  let mangaTaskActionError = "";
  let mangaTaskMonitor = null;
  let mangaTaskListGeneration = 0;
  let mangaTaskNotice = null;
  let mangaTaskNoticeTimer = 0;
  const mangaTaskRetrying = new Set();
  const mangaTaskActionErrors = new Map();
  const mangaUpdateJobs = new Map();
  const mangaUpdatePolls = new Map();
  let mangaReaderProgressTracker = null;

  async function renderChannel(params = {}, isActive = () => true) {
    const generation = ++channelRequestGeneration;
    channelRequestController?.abort();
    const controller = new AbortController();
    channelRequestController = controller;
    const cancel = () => controller.abort();
    if (isActive.signal?.aborted) cancel();
    else isActive.signal?.addEventListener("abort", cancel, { once: true });
    resetMangaReaderProgressTracker();
    const normalizedMode = normalizeChannelMode(typeof params === "string" ? params : params.mode);
    const query = String(typeof params === "object" ? params.query || "" : "").trim();
    const rawPhotoView = String(typeof params === "object" ? params.photoView || "" : "").trim();
    const photoView = normalizedMode === "photo" && rawPhotoView !== "albums" ? "collections" : "albums";
    const category = String(typeof params === "object" ? params.category || "" : "").trim();
    const person = String(typeof params === "object" ? params.person || "" : "").trim();
    const collection = String(typeof params === "object" ? params.collection || "" : "").trim();
    const tvView = String(typeof params === "object" ? params.tvView || "" : "").trim() === "episodes" ? "episodes" : "series";
    const seriesKey = String(typeof params === "object" ? params.seriesKey || "" : "").trim();
    const mediaMode = ["movie", "tv", "anime", "media"].includes(normalizedMode);
    const defaultSort = normalizedMode === "photo" && photoView === "collections" && !collection && !query ? "count" : mediaMode && query ? "relevance" : "updated";
    const requestedSort = normalizeChannelSort(typeof params === "object" ? params.sort || defaultSort : defaultSort);
    const sort = mediaMode && !query && requestedSort === "relevance" ? "updated" : requestedSort;
    const channel = channelConfig(normalizedMode);
    const limit = getChannelLimit();
    const filters = { query, photoView, category, person, collection, tvView, seriesKey, sort };
    const activeUrl = getActiveUrl();
    const isCurrent = () => generation === channelRequestGeneration && !controller.signal.aborted && isActive() && getActiveUrl() === activeUrl;
    if (!isCurrent()) {
      isActive.signal?.removeEventListener("abort", cancel);
      if (channelRequestController === controller) channelRequestController = null;
      return;
    }
    const pageKey = channelPageKey(normalizedMode, filters, activeUrl);
    channelRenderingKey = pageKey;
    const currentPage = channelPageState?.key === pageKey ? channelPageState.data : null;
    const retryPage = currentPage && channelPageState.retry?.targetLimit === limit ? channelPageState.retry : null;
    const basePage = retryPage ? retryPage.base : currentPage;
    const loadedCount = Array.isArray(currentPage?.items) ? currentPage.items.length : 0;
    const rawLoaded = Math.max(loadedCount, Number(currentPage?.rawLoaded || 0));
    const rangeReduced = currentPage && loadedCount > limit;
    const knownTotal = Number(currentPage?.total || 0);
    const hasKnownTotal = currentPage && Number.isFinite(Number(currentPage.total));
    const pageComplete = currentPage && (loadedCount >= limit || currentPage.hasMore === false || (hasKnownTotal && rawLoaded >= knownTotal));
    const offset = retryPage ? retryPage.offset : pageComplete ? 0 : rawLoaded;
    const requestLimit = retryPage ? retryPage.limit : Math.max(1, limit - (pageComplete ? 0 : loadedCount));
    const path = channelItemsPath(normalizedMode, requestLimit, filters, offset);
    const loadingMore = Boolean(currentPage && offset > 0);
    const pendingPaging = loadingMore ? { status: "loading" } : {};
    let displayedData = currentPage;
    let displayedCache = null;
    let renderedCache = false;
    let renderedCacheSignature = "";

    setActiveBottom(normalizedMode);
    if (normalizedMode === "photo") updateModuleChrome("photo", { category });
    else if (["media", "movie", "tv", "anime"].includes(normalizedMode)) updateModuleChrome("media", { mode: normalizedMode });
    else updateModuleChrome("none");
    if (pageComplete || loadingMore) {
      renderChannelData(normalizedMode, currentPage, null, pendingPaging);
      renderedCache = true;
      renderedCacheSignature = channelDataSignature(currentPage);
    } else {
      resetPreviewImageObserver();
      els.viewKicker.textContent = query ? "频道搜索" : "内容频道";
      els.viewTitle.textContent = query ? `${channel.label}：${query}` : channel.label;
      setChannelMeta(normalizedMode, query ? "正在筛选" : "正在读取");
      if (normalizedMode === "manga") {
        els.viewContent.replaceChildren(createMangaLoading(query ? "正在筛选韩漫书库" : "正在读取韩漫书库"));
      } else {
        els.viewContent.innerHTML = `<div class="loading-row">正在加载${channel.label}</div>`;
      }
    }

    const slowTimer = normalizedMode === "manga" && !renderedCache ? window.setTimeout(() => {
      if (renderedCache || !isCurrent()) return;
      const detail = els.viewContent.querySelector("[data-manga-loading-detail]");
      if (detail) detail.textContent = "电脑端响应较慢，最多再等待 10 秒";
    }, 2200) : 0;

    try {
      let cached = pageComplete && !loadingMore ? null : await readCachedJson(activeUrl, path).catch(() => null);
      if (!cached && offset === 0 && requestLimit > 5000 && !pageComplete && isCurrent()) {
        cached = await readCachedJson(activeUrl, channelItemsPath(normalizedMode, 5000, filters, 0)).catch(() => null);
      }
      if (!isCurrent()) return;
      if (cached?.payload && !(offset > 0 && channelRevisionChanged(basePage, cached.payload))) {
        renderedCache = true;
        const mergedCache = mergeChannelPageData(basePage, cached.payload, offset);
        channelPageState = { key: pageKey, data: mergedCache, ...(retryPage ? { retry: retryPage } : {}) };
        displayedData = mergedCache;
        displayedCache = cached;
        renderedCacheSignature = channelDataSignature(mergedCache);
        renderChannelData(normalizedMode, mergedCache, cached, pendingPaging);
      }

      const mergedData = await loadConsistentChannelPage(normalizedMode, filters, {
        activeUrl, basePage, offset, requestLimit,
        targetRaw: offset > 0 ? offset + requestLimit : rangeReduced ? requestLimit : Math.max(rawLoaded, requestLimit),
        signal: controller.signal, isCurrent
      });
      if (!isCurrent()) return;
      if (offset === 0) writeCachedJson(activeUrl, path, mergedData).catch(() => {});
      channelPageState = { key: pageKey, data: mergedData };
      if (!loadingMore && renderedCache && channelDataSignature(mergedData) === renderedCacheSignature) {
        applyChannelHeader(normalizedMode, mergedData);
        return;
      }
      renderChannelData(normalizedMode, mergedData);
    } catch (error) {
      if (!isCurrent()) return;
      if (loadingMore) {
        // Keep the readable page and retry the outstanding range. Advancing
        // the limit again or auto-retrying here causes runaway offline loads.
        // Cached tail rows do not confirm that range: retry from its original
        // base even when the cached merge already satisfies the target limit.
        channelPageState = { key: pageKey, data: displayedData,
          retry: { offset, limit: requestLimit, targetLimit: limit, base: basePage } };
        renderChannelData(normalizedMode, displayedData, displayedCache, {
          status: "error",
          retry: () => isCurrent() ? renderCurrentViewPreservingScroll() : undefined
        });
        return;
      }
      if (renderedCache) {
        setChannelMeta(normalizedMode, "离线缓存");
        if (normalizedMode === "manga") {
          prependMangaCacheNotice("电脑端暂时未连接，当前书库来自手机缓存。");
        } else {
          const notice = renderMessage("电脑端暂时连不上，当前显示的是本地缓存。", "quiet", false);
          notice.dataset.channelCacheNotice = "";
        }
      } else {
        if (normalizedMode === "manga") {
          renderMangaLibraryFailure(error);
        } else {
          setChannelMeta(normalizedMode, "读取失败");
          renderMessage(error.message || `${channel.label}读取失败`, "error");
        }
      }
    } finally {
      if (slowTimer) window.clearTimeout(slowTimer);
      isActive.signal?.removeEventListener("abort", cancel);
      if (channelRequestController === controller) channelRequestController = null;
    }
  }

  function channelRevisionChanged(existing, incoming) {
    if (!existing || !incoming) return false;
    if (existing.listRevision || incoming.listRevision) return existing.listRevision !== incoming.listRevision;
    const previous = existing.scannedAt || "";
    const next = incoming.scannedAt || "";
    return String(previous) !== String(next);
  }

  async function loadConsistentChannelPage(mode, filters, request) {
    let offset = request.offset;
    let base = offset > 0 ? request.basePage : null;
    let limit = Math.min(5000, request.requestLimit);
    let prefixAttempts = offset === 0 ? 1 : 0;
    let rebuilding = offset === 0;
    while (request.isCurrent()) {
      const path = channelItemsPath(mode, limit, filters, offset);
      const data = await fetchJson(request.activeUrl, path, {
        timeoutMs: mode === "manga" ? 10000 : 12000, signal: request.signal
      });
      if (!request.isCurrent()) return null;
      writeCachedJson(request.activeUrl, path, data).catch(() => {});
      if (offset > 0 && channelRevisionChanged(base, data)) {
        if (++prefixAttempts > 3) throw new Error("目录正在更新，请重新加载");
        // Offset pages from different snapshots cannot reconstruct a prefix.
        // Keep the displayed page until a complete replacement is ready.
        base = null;
        rebuilding = true;
        offset = 0;
        limit = Math.min(5000, request.targetRaw);
        continue;
      }
      base = mergeChannelPageData(offset > 0 ? base : null, data, offset);
      if (!rebuilding || base.hasMore === false || base.rawLoaded >= request.targetRaw) return base;
      offset = base.rawLoaded;
      limit = Math.min(5000, Math.max(1, request.targetRaw - base.rawLoaded));
    }
    return null;
  }

  function renderMangaLibraryFailure(error) {
    els.viewMeta.textContent = "读取失败";
    els.viewContent.innerHTML = "";
    els.viewContent.append(createMangaFailurePanel({
      title: "韩漫书库暂时打不开",
      message: mangaConnectionFailureMessage(error, "电脑端没有返回韩漫书库，请稍后重新读取。"),
      primaryLabel: "重新读取",
      primaryAction: () => renderCurrentView()
    }));
  }

  function channelPageKey(mode, filters = {}, sourceUrl = getActiveUrl()) {
    return JSON.stringify({
      sourceUrl,
      mode,
      query: String(filters.query || "").trim(),
      photoView: filters.photoView || "",
      category: filters.category || "",
      person: filters.person || "",
      collection: filters.collection || "",
      tvView: filters.tvView || "",
      seriesKey: filters.seriesKey || "",
      sort: normalizeChannelSort(filters.sort)
    });
  }

  function mergeChannelPageData(existing = null, incoming = {}, offset = 0) {
    const rawItems = Array.isArray(incoming.items) ? incoming.items : [];
    const suppliedOffset = Number(incoming.nextOffset);
    const rawLoaded = Number.isSafeInteger(suppliedOffset) && suppliedOffset >= offset + rawItems.length
      ? suppliedOffset : offset + rawItems.length;
    const total = Number(incoming.total ?? existing?.total ?? rawLoaded);
    const merged = new Map();
    for (const item of [...(offset > 0 ? existing?.items || [] : []), ...rawItems]) {
      const key = channelItemKey(item) || Symbol("unidentified");
      merged.set(key, item);
    }
    const items = [...merged.values()];
    return {
      ...existing,
      ...incoming,
      items,
      count: items.length,
      limit: items.length,
      offset: 0,
      total,
      rawLoaded,
      hasMore: rawItems.length > 0 && rawLoaded > offset && rawLoaded < total
    };
  }

  function channelItemKey(item) {
    const id = item?.id || item?.collectionId || item?.routePath;
    return id ? `${String(item?.type || "")}:${String(id)}` : "";
  }

  function applyChannelHeader(mode, data = {}, cacheEntry = null) {
    data = photoCatalogDisplayData(mode, data);
    const channel = channelConfig(mode);
    const items = data.items || [];
    const total = Number(data.total || items.length);
    const query = String(data.query || "").trim();
    const photoView = String(data.photoView || "") === "collections" ? "collections" : "albums";
    const category = String(data.category || "").trim();
    const person = String(data.person || "").trim();
    const collection = String(data.collection || "").trim();
    const tvView = String(data.tvView || "") === "episodes" ? "episodes" : "series";
    const seriesKey = String(data.seriesKey || "").trim();
    const seriesSummary = data.seriesSummary || null;
    const sort = normalizeChannelSort(data.sort);
    const collectionTitle = data.collectionSummary?.title || "";
    const suffix = mode === "photo" ? "" : cacheEntry ? ` · 缓存 ${cacheAgeText(cacheEntry.updatedAt)}` : data.scannedAt ? ` · 更新 ${cacheAgeText(data.scannedAt)}` : "";
    const unit = mode === "tv" || mode === "anime" || mode === "media" ? (seriesKey ? "集" : "部") : photoView === "collections" && mode === "photo" ? "合集" : channel.unit;
    if (mode === "photo") updateModuleChrome("photo", { category, facets: data.facets || {} });
    else if (["media", "movie", "tv", "anime"].includes(mode)) updateModuleChrome("media", { mode });
    else updateModuleChrome("none");
    els.viewTitle.textContent = channelTitle(channel, { query, mode, photoView, collectionTitle, category, seriesSummary });
    setChannelMeta(mode, ["movie", "tv", "anime", "media"].includes(mode)
      ? `${query ? `找到 ${formatNumber(total)} ${unit}` : `共 ${formatNumber(total)} ${unit}`}${items.length < total ? ` · 已显示 ${formatNumber(items.length)}` : ""}${cacheEntry ? suffix : ""}`
      : query
      ? `${formatNumber(total)} 个匹配 · 已显示 ${formatNumber(items.length)}${sort === "relevance" ? " · 相关性排序" : ""}${suffix}`
      : `${formatNumber(items.length)} / ${formatNumber(total)} ${unit}${suffix}`);
  }

  function setChannelMeta(mode, text) {
    const mediaMode = ["movie", "tv", "anime", "media"].includes(mode);
    const header = channelMetaHeader;
    if (mediaMode && openMediaSearch && header?.mode === mode && header.handler === openMediaSearch
      && els.viewMeta.children.length === 2 && els.viewMeta.children[0] === header.count && els.viewMeta.children[1] === header.search) {
      if (header.count.textContent !== text) header.count.textContent = text;
      return;
    }
    channelMetaHeader = null;
    els.viewMeta.textContent = text;
    if (mediaMode && openMediaSearch) {
      const count = document.createElement("span");
      count.className = "media-list-count";
      count.textContent = els.viewMeta.textContent;
      const search = document.createElement("button");
      search.type = "button";
      search.className = "module-chrome-search media-list-search icon-only";
      search.setAttribute("aria-label", mode === "tv" ? "搜索电视剧" : mode === "anime" ? "搜索动漫" : mode === "movie" ? "搜索电影" : "搜索影视");
      search.innerHTML = '<span aria-hidden="true">⌕</span>';
      search.addEventListener("click", openMediaSearch);
      els.viewMeta.replaceChildren(count, search);
      channelMetaHeader = { mode, handler: openMediaSearch, count, search };
    }
  }

  function renderChannelData(mode, data = {}, cacheEntry = null, paging = {}) {
    data = normalizeMediaMetadataPayload(data, mode);
    els.viewContent.querySelectorAll(":scope > [data-channel-cache-notice]").forEach(node => node.remove());
    applyChannelHeader(mode, data, cacheEntry);
    if (refreshChannelList(mode, data, paging)) return;
    const pendingCategoryGroups = mode === "photo" && data.photoView === "collections" && (data.items || []).length < Number(data.total || 0);
    data = photoCatalogDisplayData(mode, data);
    const channel = channelConfig(mode);
    const items = data.items || [];
    const query = String(data.query || "").trim();
    const photoView = String(data.photoView || "") === "collections" ? "collections" : "albums";
    const seriesKey = String(data.seriesKey || "").trim();
    resetPreviewImageObserver();
    els.viewContent.innerHTML = "";

    if (mode === "manga") {
      els.viewContent.append(createMangaLibraryActions());
      els.viewContent.append(createMangaTaskManager());
      void ensureMangaTaskMonitor();
    }

    const controls = createChannelListControls(mode, data);
    els.viewContent.append(...controls);

    if (!items.length) {
      renderMessage(query ? `没有搜到「${query}」。` : channel.empty, "quiet", false);
      return;
    }

    let list;
    if (mode === "photo" && photoView !== "collections") {
      list = createPhotoMasonryList(items);
    } else {
      const grid = document.createElement("div");
      const mediaLayout = ["movie", "tv", "anime", "media"].includes(mode) ? (seriesKey || data.tvView === "episodes" ? " media-episode-list" : " media-poster-grid") : "";
      grid.className = `channel-list ${mode}-list${mode === "photo" ? " photo-catalog-grid" : ""}${mediaLayout}`;
      items.forEach((item, index) => grid.append(createChannelCard(mode, item, { index })));
      list = grid;
    }
    els.viewContent.append(list);
    const keys = items.map(channelItemKey);
    if (mode !== "manga" && photoView !== "collections" && keys.every(Boolean) && new Set(keys).size === keys.length) {
      const nodes = mode === "photo"
        ? items.map((_item, index) => list.children[index % list.children.length].children[Math.floor(index / list.children.length)])
        : [...list.children];
      mountedChannelList = { key: channelRenderingKey, mode, list, controls,
        layout: channelListLayout(mode, data), controlsSignature: channelControlsSignature(data),
        rows: items.map((item, index) => ({ key: keys[index], signature: JSON.stringify(item), node: nodes[index] })) };
    }
    renderChannelPaging(mode, data, paging, pendingCategoryGroups);
  }

  function createChannelListControls(mode, data) {
    const { category = "", person = "", collection = "", seriesKey = "", seriesSummary = null, query = "", photoView = "albums", sort = "updated" } = data;
    const controls = [];
    if (mode === "photo") {
      if (collection) controls.push(createCollectionContextRow(data.collectionSummary, { category }));
      const filters = createPhotoFilterStrip(data.facets || {}, { category, person, collection, photoView });
      if (filters.childElementCount) controls.push(filters);
    } else if (["tv", "anime", "media"].includes(mode)) {
      if (seriesKey) controls.push(createTvSeriesContextRow(seriesSummary, { total: Number(data.total || data.items?.length || 0), mode }));
      else controls.push(mode === "media"
        ? createMediaFilterStrip(data.facets || {}, { category, sort, query }, [
          { value: "updated", label: "最近" }, { value: "rating", label: "评分" }, { value: "title", label: "标题" }, { value: "size", label: "大小" }
        ]) : createTvFilterStrip(data.facets || {}, { category, sort, seriesKey, query }));
    } else if (["western", "movie"].includes(mode)) controls.push(createMediaFilterStrip(data.facets || {}, { category, sort, query: mode === "movie" ? query : "" }));
    if (query) controls.push(createChannelQueryRow(channelConfig(mode), query, data.searchTerms || [], sort));
    return controls;
  }

  function channelListLayout(mode, data) {
    return JSON.stringify([mode, data.photoView || "albums", Boolean(data.seriesKey || data.tvView === "episodes")]);
  }

  function channelControlsSignature(data) {
    return JSON.stringify([data.facets, data.category, data.person, data.collection, data.photoView,
      data.sort, data.query, data.searchTerms, data.seriesKey, data.seriesSummary, data.collectionSummary,
      data.seriesKey ? data.total : null]);
  }

  function refreshChannelList(mode, data, paging = {}) {
    const mounted = mountedChannelList;
    const items = data.items || [];
    if (!mounted || mounted.key !== channelRenderingKey || mounted.mode !== mode || !mounted.list.isConnected
      || mounted.layout !== channelListLayout(mode, data) || items.length < mounted.rows.length) return false;
    if (mode === "photo" && mounted.list.children.length !== 2) return false;
    const keys = items.map(channelItemKey);
    if (!keys.every(Boolean) || new Set(keys).size !== keys.length || mounted.rows.some((row, index) => row.key !== keys[index])) return false;
    for (let index = 0; index < items.length; index += 1) {
      const signature = JSON.stringify(items[index]);
      const previous = mounted.rows[index];
      if (previous?.signature === signature) continue;
      const node = createChannelCard(mode, items[index], { index });
      if (previous) {
        const focused = previous.node === document.activeElement || previous.node.contains(document.activeElement);
        for (const target of previous.node.querySelectorAll("[data-preview-url]")) {
          for (const observer of previewImageObservers.values()) observer.unobserve(target);
        }
        previous.node.replaceWith(node);
        if (focused) node.focus({ preventScroll: true });
      } else if (mode === "photo") mounted.list.children[index % mounted.list.children.length].append(node);
      else mounted.list.append(node);
      mounted.rows[index] = { key: keys[index], signature, node };
    }
    const controlsSignature = channelControlsSignature(data);
    if (controlsSignature !== mounted.controlsSignature) {
      const focused = document.activeElement;
      const restoreFocus = mounted.controls.some(node => node === focused || node.contains(focused));
      const controls = createChannelListControls(mode, data);
      mounted.controls.forEach(node => node.remove());
      mounted.list.before(...controls);
      if (restoreFocus) {
        const candidates = controls.flatMap(node => [node, ...node.querySelectorAll("button,input,select,a")]);
        const replacement = candidates.find(node => node.tagName === focused.tagName && node.className === focused.className
          && node.getAttribute("aria-label") === focused.getAttribute("aria-label") && node.textContent === focused.textContent);
        replacement?.focus({ preventScroll: true });
      }
      mounted.controls = controls;
      mounted.controlsSignature = controlsSignature;
    }
    renderChannelPaging(mode, data, paging);
    return true;
  }

  function renderChannelPaging(mode, data, paging = {}, pendingCategoryGroups = false) {
    els.viewContent.querySelectorAll(":scope > .channel-more").forEach(node => node.remove());
    const items = data.items || [];
    const total = Number(data.total ?? items.length);
    if (paging.status === "loading") {
      const pending = document.createElement("button");
      pending.type = "button";
      pending.className = "text-button channel-more";
      pending.disabled = true;
      pending.setAttribute("aria-live", "polite");
      pending.textContent = "正在接着加载";
      els.viewContent.append(pending);
    } else if (paging.status === "error") {
      els.viewContent.append(createLoadMoreButton("加载失败，点击重试", paging.retry, { auto: false }));
    } else if ((data.hasMore !== false && Number(data.rawLoaded ?? items.length) < total) || pendingCategoryGroups || (mode === "photo" && data.photoView === "collections" && items.length < total)) {
      els.viewContent.append(createLoadMoreButton(`向下滑动继续加载 ${formatNumber(items.length)} / ${formatNumber(total)}`, () => {
        increaseChannelLimit(48);
        return renderCurrentViewPreservingScroll();
      }, { requireScrollIntent: mode === "photo" }));
    }
  }

  function photoCatalogDisplayData(mode, data) {
    if (mode !== "photo" || data.photoView !== "collections" || data.collection) return data;
    const collections = photoCatalogCollections(data.items, data.sort || "count");
    return { ...data, items: collections.slice(0, getChannelLimit()), total: collections.length };
  }

  function createChannelCard(mode, item, options = {}) {
    if (["movie", "media"].includes(mode)) item = normalizeMediaMetadataItem(item, mode);
    const channel = channelConfig(mode);
    const itemType = String(item?.type || "");
    const photoCollection = mode === "photo" && itemType.startsWith("photoCollection");
    const card = document.createElement("button");
    card.type = "button";
    card.className = `channel-card ${mode}`;
    if (mode === "photo") card.classList.add(photoCollection ? "photo-collection-card" : "photo-album-card");
    card.addEventListener("click", () => {
      if (photoCollection) {
        updateChannelParams({ photoView: "albums", collection: item.collectionId || item.id, person: "", query: "", sort: "updated" }, { push: true, skipHistory: false, replaceHistory: false });
        return;
      }
      const tvSeriesNavigation = tvSeriesCardNavigation(mode, item);
      if (tvSeriesNavigation) {
        updateChannelParams(
          tvSeriesNavigation,
          { skipHistory: false, replaceHistory: false, push: true }
        );
        return;
      }
      if (mode === "photo" && item.id && showPhotoDetail) {
        showPhotoDetail(item.id);
        return;
      }
      if (mode === "manga" && item.id && showMangaDetail) {
        showMangaDetail(item.id);
        return;
      }
      if ((["western", "movie", "tv", "anime", "media"].includes(mode)) && item.id && showMediaDetail) {
        showMediaDetail(item.id, mediaDetailModeForItem(mode, item));
        return;
      }
      openInLibrary(item.routePath || channel.path);
    });

    const presentation = mediaCardPresentation(mode, item);
    if (presentation) {
      card.classList.add(presentation.episode ? "media-episode-card" : "media-poster-card");
      const frame = document.createElement("div");
      frame.className = "media-card-cover";
      frame.setAttribute("aria-hidden", "true");
      const thumb = document.createElement("div");
      thumb.className = "channel-thumb";
      thumb.textContent = item.coverUrl ? "封面加载中" : "暂无封面";
      if (item.coverUrl) thumb.dataset.imageErrorText = "封面加载失败";
      frame.append(thumb);
      if (item.coverUrl) loadChannelPreviewImage(thumb, absoluteUrl(getActiveUrl(), item.coverUrl), mode, options.index);
      if (presentation.rating) {
        const rating = document.createElement("span");
        rating.className = "media-poster-rating";
        rating.textContent = presentation.rating;
        frame.append(rating);
      }
      const body = document.createElement("div");
      body.className = "channel-summary";
      const title = document.createElement("strong");
      title.textContent = presentation.title;
      const meta = document.createElement("span");
      meta.className = "media-card-meta";
      meta.textContent = presentation.meta;
      body.append(title, meta);
      card.setAttribute("aria-label", [presentation.title, presentation.meta, presentation.rating ? `评分 ${presentation.rating}` : ""].filter(Boolean).join("，"));
      card.append(frame, body);
      return card;
    }

    const thumb = document.createElement("div");
    thumb.className = "channel-thumb";
    thumb.textContent = thumbFallbackText(item.title || channel.label);
    // The image loader replaces the placeholder and applies the source aspect ratio.
    // Keep a stable frame around collection covers; album masonry stays intrinsic.
    const coverFrame = photoCollection ? document.createElement("div") : null;
    if (coverFrame) {
      coverFrame.className = "photo-collection-cover";
      coverFrame.append(thumb);
    }
    const cover = item.coverUrl ? absoluteUrl(getActiveUrl(), item.coverUrl) : "";
    if (cover) loadChannelPreviewImage(thumb, cover, mode, options.index);

    const body = document.createElement("div");
    body.className = "channel-summary";

    const label = document.createElement("span");
    label.className = "channel-label";
    label.textContent = channelCardLabel(mode, item);

    const title = document.createElement("strong");
    title.textContent = channelCardTitle(mode, item, channel);
    const subtitle = channelCardSubtitle(mode, item);
    const subtitleNode = subtitle ? document.createElement("span") : null;
    if (subtitle) {
      subtitleNode.className = "channel-subtitle";
      subtitleNode.textContent = subtitle;
    }

    const facts = document.createElement("div");
    facts.className = "channel-facts";
    for (const fact of channelFacts(mode, item).filter(Boolean).slice(0, 3)) {
      const node = document.createElement("span");
      node.textContent = fact;
      facts.append(node);
    }

    if (!photoCollection) body.append(label);
    body.append(title);
    if (subtitleNode) body.append(subtitleNode);
    body.append(facts);
    card.append(coverFrame || thumb, body);
    return card;
  }

  function createPhotoMasonryList(items = []) {
    const wrap = document.createElement("div");
    wrap.className = "photo-masonry-list";

    const columns = [document.createElement("div"), document.createElement("div")];
    for (const column of columns) {
      column.className = "photo-masonry-column";
      wrap.append(column);
    }

    items.forEach((item, index) => {
      columns[index % columns.length].append(createChannelCard("photo", item, { index }));
    });
    return wrap;
  }

  function loadChannelPreviewImage(thumb, cover, mode, index = 0) {
    const activeUrl = getActiveUrl();
    if (shouldEagerLoadCover(mode, index) || !("IntersectionObserver" in window)) {
      loadPreviewImage(thumb, cover, { cacheBaseUrl: activeUrl });
      return;
    }

    thumb.dataset.previewUrl = cover;
    thumb.dataset.previewCacheBaseUrl = activeUrl;
    getPreviewImageObserver(mode).observe(thumb);
  }

  function shouldEagerLoadCover(mode, index = 0) {
    const safeIndex = Math.max(0, Number(index) || 0);
    if (mode === "photo") return safeIndex < EAGER_PHOTO_COVER_COUNT;
    return safeIndex < EAGER_CHANNEL_COVER_COUNT;
  }

  function getPreviewImageObserver(mode = "") {
    const key = mode === "photo" ? "photo" : "default";
    const existing = previewImageObservers.get(key);
    if (existing) return existing;
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const target = entry.target;
        observer.unobserve(target);
        loadPendingPreviewImage(target);
      }
    }, {
      root: null,
      rootMargin: key === "photo" ? LAZY_PHOTO_PREVIEW_ROOT_MARGIN : LAZY_CHANNEL_PREVIEW_ROOT_MARGIN,
      threshold: 0
    });
    previewImageObservers.set(key, observer);
    return observer;
  }

  function loadPendingPreviewImage(target) {
    const cover = target.dataset.previewUrl || "";
    const cacheBaseUrl = target.dataset.previewCacheBaseUrl || getActiveUrl();
    delete target.dataset.previewUrl;
    delete target.dataset.previewCacheBaseUrl;
    if (!cover || !target.isConnected) return;
    loadPreviewImage(target, cover, { cacheBaseUrl });
  }

  function resetPreviewImageObserver() {
    mountedChannelList = null;
    for (const observer of previewImageObservers.values()) observer.disconnect();
    previewImageObservers = new Map();
    if (photoDetailImageObserver) {
      photoDetailImageObserver.disconnect();
      photoDetailImageObserver = null;
    }
    photoDetailImageQueue = [];
    activePhotoDetailImageLoads = 0;
    photoDetailStartupImage = null;
    photoDetailImageGeneration += 1;
  }

  function cancelChannelRequest() {
    channelRequestGeneration += 1;
    channelRequestController?.abort();
    channelRequestController = null;
    if (mountedChannelList) {
      for (const observer of previewImageObservers.values()) observer.disconnect();
      previewImageObservers = new Map();
      mountedChannelList = null;
    }
  }

  function createChannelQueryRow(channel, query, terms = [], sort = "") {
    const row = document.createElement("div");
    row.className = "channel-query-row";

    const text = document.createElement("span");
    text.textContent = [
      `${channel.label}内搜索：${query}`,
      terms.length > 1 ? `同时包含 ${terms.join(" + ")}` : "",
      sort === "relevance" ? "按相关性排序" : ""
    ].filter(Boolean).join(" · ");

    const button = document.createElement("button");
    button.type = "button";
    button.textContent = "清除";
    button.addEventListener("click", () => updateChannelQuery(""));

    row.append(text, button);
    return row;
  }

  function createMangaLibraryActions() {
    const panel = document.createElement("section");
    panel.className = "manga-library-actions";

    const head = document.createElement("div");
    head.className = "manga-library-actions-head";
    const copy = document.createElement("div");
    const title = document.createElement("strong");
    title.textContent = "漫画书库";
    const hint = document.createElement("span");
    hint.textContent = "支持 smtt6、55comic、jmd9 / 91jmd";
    copy.append(title, hint);

    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.textContent = mangaAddOpen ? "收起" : mangaJobRunning(mangaAddJob) ? "采集中" : "添加漫画";
    toggle.setAttribute("aria-expanded", String(mangaAddOpen));
    toggle.addEventListener("click", () => {
      mangaAddOpen = !mangaAddOpen;
      syncMangaLibraryActions();
    });
    const actions = document.createElement("div");
    actions.className = "manga-library-head-actions";
    const history = document.createElement("button");
    history.type = "button";
    history.className = "manga-task-history-toggle";
    history.innerHTML = '<svg aria-hidden="true" viewBox="0 0 24 24"><path d="M3 11a9 9 0 1 1 2.7 7M3 5v6h6m3-4v5l3 2" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    updateMangaTaskHistoryControl(history);
    history.addEventListener("click", toggleMangaTaskHistory);
    actions.append(history, toggle);
    head.append(copy, actions);
    panel.append(head);

    if (!mangaAddOpen) return panel;

    const form = document.createElement("form");
    form.className = "manga-add-form";
    const input = document.createElement("input");
    input.type = "url";
    input.required = true;
    input.placeholder = "粘贴漫画作品链接";
    input.value = mangaAddUrl;
    input.disabled = mangaJobRunning(mangaAddJob);
    input.addEventListener("input", () => {
      mangaAddUrl = input.value;
      if (!mangaAddError) return;
      mangaAddError = "";
      panel.querySelector(".manga-operation-error")?.remove();
    });
    const submit = document.createElement("button");
    submit.type = "submit";
    submit.disabled = mangaJobRunning(mangaAddJob);
    submit.textContent = mangaJobRunning(mangaAddJob) ? "采集中" : mangaAddJob?.status === "failed" ? "重新采集" : "开始采集";
    form.append(input, submit);
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      void startMangaAdd(input.value);
    });
    panel.append(form);

    if (mangaAddError) {
      const error = document.createElement("p");
      error.className = "manga-operation-error";
      error.textContent = mangaAddError;
      panel.append(error);
    }
    return panel;
  }

  async function startMangaAdd(url) {
    const value = String(url || "").trim();
    if (!value || mangaJobRunning(mangaAddJob)) return;
    const generation = ++mangaAddGeneration;
    mangaAddOpen = true;
    mangaAddUrl = value;
    mangaAddError = "";
    mangaAddJob = { status: "starting", message: "正在启动采集", progressPercent: 1 };
    syncMangaLibraryActions();
    try {
      const result = await fetchJson(getActiveUrl(), "/api/manga/add", {
        method: "POST",
        body: { url: value },
        timeoutMs: 22000
      });
      if (generation !== mangaAddGeneration) return;
      const changed = updateMangaAddState(mergeMangaTaskJob(result.job || { status: "running", message: "正在读取远程目录" }));
      if (mangaJobRunning(mangaAddJob) && mangaAddJob.id) void watchMangaAdd(mangaAddJob.id, generation);
      if (changed) await refreshMangaLibrary();
    } catch (error) {
      if (generation !== mangaAddGeneration) return;
      updateMangaAddState({ status: "failed", message: error.message || "漫画采集启动失败" });
    }
  }

  function syncMangaLibraryActions() {
    const current = els.viewContent.querySelector(".manga-library-actions");
    if (!current) return false;
    current.replaceWith(createMangaLibraryActions());
    return true;
  }

  function updateMangaAddState(job) {
    const previous = mangaAddJob;
    const controlsChanged = previous?.status !== job.status || previous?.id !== job.id;
    const libraryChanged = Boolean(job.comicAvailable && !previous?.comicAvailable)
      || (mangaJobRunning(previous) && !mangaJobRunning(job));
    mangaAddJob = job;
    if (job.status === "complete" && controlsChanged) {
      mangaAddOpen = false;
      mangaAddUrl = "";
      mangaAddError = "";
      if (mangaJobRunning(previous) && mangaTaskNotice?.jobId !== job.id) showMangaTaskNotice(job);
    } else if (job.status === "failed" && controlsChanged) {
      mangaAddError = job.message || "漫画采集失败";
    }
    if (controlsChanged) syncMangaLibraryActions();
    syncMangaTaskManager();
    return libraryChanged;
  }

  function watchMangaAdd(jobId, generation = mangaAddGeneration) {
    if (mangaAddPoll?.jobId === jobId && mangaAddPoll.generation === generation) return mangaAddPoll.promise;
    const poll = { jobId, generation, promise: null };
    const isCurrent = () => generation === mangaAddGeneration && mangaAddJob?.id === jobId;
    mangaAddPoll = poll;
    poll.promise = (async () => {
      while (isCurrent() && mangaJobRunning(mangaAddJob)) {
        await mangaPollDelay();
        if (!isCurrent() || !mangaJobRunning(mangaAddJob)) break;
        const data = await fetchJson(getActiveUrl(), `/api/manga/jobs/${encodeURIComponent(jobId)}`, {
          timeoutMs: 12000
        });
        if (!isCurrent()) break;
        const changed = updateMangaAddState(mergeMangaTaskJob(data.job || mangaAddJob));
        if (changed) await refreshMangaLibrary();
      }
      return mangaAddJob;
    })().catch((error) => {
      if (!isCurrent() || !mangaJobRunning(mangaAddJob)) return mangaAddJob;
      updateMangaAddState(mergeMangaTaskJob({ ...mangaAddJob, status: "failed", message: error.message || "漫画采集状态读取失败" }));
      return mangaAddJob;
    }).finally(() => { if (mangaAddPoll === poll) mangaAddPoll = null; });
    return poll.promise;
  }

  async function refreshMangaLibrary() {
    channelPageState = null;
    if (els.viewContent.querySelector("[data-manga-task-manager]")) await renderCurrentViewPreservingScroll();
  }

  function mergeMangaTaskJob(job = {}) {
    const jobId = String(job.id || "").trim();
    if (!jobId) return job;
    const index = mangaTaskJobs.findIndex((item) => String(item.id || "") === jobId);
    const previous = index >= 0 ? mangaTaskJobs[index] : null;
    const merged = mergeMangaTaskState(previous, job);
    if (index >= 0) mangaTaskJobs.splice(index, 1, merged);
    else mangaTaskJobs.unshift(merged);
    mangaTaskJobs.sort((a, b) => Number(mangaJobRunning(b)) - Number(mangaJobRunning(a)) || mangaTaskStartedAt(b) - mangaTaskStartedAt(a));
    mangaTaskJobs = mangaTaskJobs.slice(0, 12);
    rememberMangaUpdateJob(merged);
    if (mangaJobRunning(previous) && merged.status === "complete") showMangaTaskNotice(merged);
    return merged;
  }

  function rememberMangaUpdateJob(job = {}) {
    const mangaId = String(job.comicId || "");
    if (!mangaId) return job;
    const current = mergeMangaTaskState(mangaUpdateJobs.get(mangaId), job);
    mangaUpdateJobs.set(mangaId, current);
    return current;
  }

  function showMangaTaskNotice(job = {}) {
    const chapterStats = mangaJobChapterStats(job);
    mangaTaskNotice = {
      jobId: String(job.id || ""),
      comicId: String(job.comicId || ""),
      kind: String(job.kind || ""),
      title: String(job.title || "漫画").trim() || "漫画",
      message: job.kind === "update" && job.pendingChapters === 0
        ? `已是最新 · 已缓存 ${formatNumber(chapterStats.completed)} 章`
        : chapterStats.total > 0 ? `已完成 ${formatNumber(chapterStats.completed)} 章` : mangaJobMessage(job)
    };
    window.clearTimeout(mangaTaskNoticeTimer);
    mangaTaskNoticeTimer = window.setTimeout(() => {
      mangaTaskNotice = null;
      mangaTaskNoticeTimer = 0;
      els.viewContent.querySelectorAll("[data-manga-completion-notice]").forEach((node) => node.remove());
      syncMangaTaskManager();
    }, 5200);
    syncMangaTaskManager();
    syncMangaDetailCompletionNotice();
  }

  function createMangaCompletionNotice() {
    const notice = document.createElement("aside");
    notice.className = "manga-task-notice";
    notice.dataset.mangaCompletionNotice = "";
    notice.setAttribute("role", "status");
    notice.setAttribute("aria-atomic", "true");
    const mark = document.createElement("i");
    mark.textContent = "✓";
    mark.setAttribute("aria-hidden", "true");
    const noticeCopy = document.createElement("span");
    const noticeTitle = document.createElement("strong");
    const action = mangaTaskNotice?.kind === "update" ? "更新完成" : "下载完成";
    noticeTitle.textContent = `《${mangaTaskNotice?.title || "漫画"}》${action}`;
    const noticeMeta = document.createElement("small");
    noticeMeta.textContent = mangaTaskNotice?.message || "任务已完成";
    noticeCopy.append(noticeTitle, noticeMeta);
    notice.append(mark, noticeCopy);
    return notice;
  }

  function mangaTaskNoticeMatchesComic(comic = {}) {
    if (!mangaTaskNotice) return false;
    const comicId = String(comic.id || "");
    const currentJob = mangaUpdateJobs.get(comicId);
    if (mangaJobRunning(currentJob) || (currentJob?.id && currentJob.id !== mangaTaskNotice.jobId)) return false;
    if (mangaTaskNotice.comicId) return mangaTaskNotice.comicId === comicId;
    return String(comic.title || "").trim() === mangaTaskNotice.title;
  }

  function syncMangaDetailCompletionNotice() {
    const panel = els.viewContent.querySelector(".manga-detail-summary");
    const slot = panel?.querySelector(".manga-job-slot");
    if (!panel || !slot || !mangaTaskNoticeMatchesComic({ id: panel.dataset.mangaId })) return;
    slot.querySelector("[data-manga-completion-notice]")?.remove();
    slot.append(createMangaCompletionNotice());
  }

  function mangaTaskDisplayJobs() {
    return selectMangaTaskDisplayJobs(mangaTaskJobs, mangaAddJob, 6);
  }

  function updateMangaTaskHistoryControl(button) {
    button.setAttribute("aria-label", mangaTaskHistoryOpen ? "收起下载记录" : "下载记录");
    button.setAttribute("aria-expanded", String(mangaTaskHistoryOpen));
    button.title = mangaTaskHistoryOpen ? "收起下载记录" : "下载与更新记录";
  }

  function toggleMangaTaskHistory() {
    mangaTaskHistoryOpen = !mangaTaskHistoryOpen;
    syncMangaTaskManager();
    if (!mangaTaskHistoryOpen) {
      els.viewContent.querySelector(".manga-task-history-toggle")?.focus({ preventScroll: true });
      return;
    }
    void refreshMangaTaskJobs().then(refreshMangaLibraryAfterTaskChange).catch((error) => {
      mangaTaskError = error.message || "漫画任务读取失败";
      syncMangaTaskManager();
    });
  }

  function createMangaTaskManager() {
    const panel = document.createElement("section");
    panel.className = "manga-task-manager";
    panel.dataset.mangaTaskManager = "";
    const jobs = mangaTaskDisplayJobs();
    const running = jobs.filter(mangaJobRunning).length;
    const failed = jobs.filter((job) => job.status === "failed").length;
    const finished = jobs.filter((job) => !mangaJobRunning(job)).length;
    const connectionError = Boolean(mangaTaskError);
    const hasAttention = running > 0 || failed > 0;
    panel.hidden = !mangaTaskHistoryOpen && !hasAttention && !mangaTaskNotice && !connectionError && !mangaTaskActionError;
    panel.classList.toggle("is-idle", !hasAttention && !mangaTaskHistoryOpen);
    panel.classList.toggle("has-notice", Boolean(mangaTaskNotice));

    // Completion is a temporary acknowledgement, not a permanent empty panel.
    if (!mangaTaskHistoryOpen && !hasAttention && !connectionError && !mangaTaskActionError && mangaTaskNotice) {
      panel.append(createMangaCompletionNotice());
      return panel;
    }

    const head = document.createElement("div");
    head.className = "manga-task-manager-head";
    const copy = document.createElement("div");
    const title = document.createElement("strong");
    title.textContent = "下载与更新";
    const meta = document.createElement("span");
    meta.textContent = connectionError
      ? "显示上次任务状态"
      : running ? `${formatNumber(running)} 个任务进行中` : failed ? `${formatNumber(failed)} 个任务需要处理` : "暂无进行中任务";
    copy.append(title, meta);
    const indicator = document.createElement("button");
    indicator.type = "button";
    indicator.className = `manga-task-manager-indicator${running && !connectionError ? " is-running" : ""}`;
    indicator.textContent = connectionError ? "连接中断" : mangaTaskHistoryOpen ? "收起记录" : running ? "查看全部" : "任务记录";
    indicator.disabled = connectionError;
    indicator.setAttribute("aria-expanded", mangaTaskHistoryOpen ? "true" : "false");
    indicator.addEventListener("click", toggleMangaTaskHistory);
    if (connectionError || (failed && !running)) indicator.classList.add("has-failure");
    const headActions = document.createElement("div");
    headActions.className = "manga-task-manager-actions";
    headActions.append(indicator);
    if (mangaTaskHistoryOpen && finished > 0) {
      const clear = document.createElement("button");
      clear.type = "button";
      clear.className = "manga-task-clear";
      clear.textContent = mangaTaskClearing ? "清理中" : "清理记录";
      clear.disabled = mangaTaskClearing || connectionError;
      clear.addEventListener("click", () => void clearFinishedMangaTaskHistory());
      headActions.append(clear);
    }
    head.append(copy, headActions);
    panel.append(head);

    if (mangaTaskActionError) {
      const error = document.createElement("p");
      error.className = "manga-operation-error";
      error.textContent = mangaTaskActionError;
      panel.append(error);
    }

    if (!mangaTaskLoaded && !jobs.length) {
      const loading = document.createElement("div");
      loading.className = "manga-task-manager-empty";
      loading.textContent = "正在读取下载任务";
      panel.append(loading);
      return panel;
    }

    if (mangaTaskError && !jobs.length) {
      panel.append(createMangaTaskConnectionNotice());
      return panel;
    }

    if (!jobs.length) {
      if (mangaTaskHistoryOpen) {
        const empty = document.createElement("div");
        empty.className = "manga-task-manager-empty";
        empty.textContent = "暂无下载与更新记录";
        panel.append(empty);
      }
      return panel;
    }

    if (mangaTaskNotice) {
      panel.append(createMangaCompletionNotice());
    }

    const list = document.createElement("div");
    list.className = "manga-task-list";
    const attentionJobs = jobs.filter((job) => mangaJobRunning(job) || job.status === "failed");
    const visibleJobs = mangaTaskHistoryOpen
      ? jobs
      : attentionJobs;
    visibleJobs.forEach((job) => list.append(createMangaTaskCard(job, {
      compact: !mangaTaskHistoryOpen && !mangaJobRunning(job) && job.status !== "failed"
    })));
    if (mangaTaskError) panel.append(createMangaTaskConnectionNotice());
    if (visibleJobs.length) panel.append(list);
    return panel;
  }

  function createMangaTaskConnectionNotice() {
    const notice = document.createElement("aside");
    notice.className = "manga-task-connection";
    const copy = document.createElement("div");
    const title = document.createElement("strong");
    title.textContent = "电脑端暂时未连接";
    const detail = document.createElement("span");
    detail.textContent = "当前显示上次任务状态";
    copy.append(title, detail);
    const retry = document.createElement("button");
    retry.type = "button";
    retry.textContent = "重试";
    retry.addEventListener("click", async () => {
      retry.disabled = true;
      retry.textContent = "连接中";
      try {
        await refreshMangaLibraryAfterTaskChange(await refreshMangaTaskJobs());
      } catch (error) {
        mangaTaskError = error.message || "漫画任务读取失败";
        syncMangaTaskManager();
      }
    });
    notice.append(copy, retry);
    return notice;
  }

  function createMangaTaskCard(job = {}, options = {}) {
    const card = document.createElement("article");
    card.className = `manga-task-card is-${String(job.status || "idle")}${options.compact ? " is-compact" : ""}`;
    card.dataset.mangaTaskId = String(job.id || "");

    const head = document.createElement("div");
    head.className = "manga-task-card-head";
    const copy = document.createElement("div");
    const title = document.createElement("strong");
    title.textContent = job.title || job.currentChapterTitle || "漫画任务";
    const meta = document.createElement("span");
    meta.textContent = options.compact
      ? [mangaJobMessage(job), Number(job.totalChapters || 0) > 0 ? `${formatNumber(job.totalChapters)} 章` : ""].filter(Boolean).join(" · ")
      : [job.kind === "add" ? "新增采集" : "增量更新", job.site].filter(Boolean).join(" · ");
    copy.append(title, meta);
    head.append(copy);

    const actions = document.createElement("div");
    actions.className = "manga-task-card-actions";
    if (job.comicAvailable && job.comicId) {
      const open = document.createElement("button");
      open.type = "button";
      open.textContent = "书页";
      open.addEventListener("click", () => showMangaDetail?.(job.comicId));
      actions.append(open);
    }
    if (job.status === "failed" && job.id) {
      const retrying = mangaTaskRetrying.has(String(job.id));
      const retry = document.createElement("button");
      retry.type = "button";
      retry.className = "primary";
      retry.textContent = retrying ? "重试中" : "重试";
      retry.disabled = retrying || mangaTaskClearing;
      retry.addEventListener("click", () => void retryMangaTask(job));
      actions.append(retry);
    }
    if (actions.childElementCount) head.append(actions);

    card.append(head);
    if (!options.compact) card.append(createMangaJobProgress(job));
    const actionError = mangaTaskActionErrors.get(String(job.id || ""));
    if (actionError) {
      const error = document.createElement("p");
      error.className = "manga-operation-error";
      error.textContent = actionError;
      card.append(error);
    }
    return card;
  }

  async function retryMangaTask(job = {}) {
    const jobId = String(job.id || "").trim();
    if (!jobId || job.status !== "failed" || mangaTaskRetrying.has(jobId)) return;
    mangaTaskRetrying.add(jobId);
    mangaTaskActionErrors.delete(jobId);
    mangaTaskActionError = "";
    syncMangaTaskManager();
    try {
      const result = await fetchJson(getActiveUrl(), `/api/manga/jobs/${encodeURIComponent(jobId)}/retry`, {
        method: "POST",
        timeoutMs: 22000
      });
      const next = result.job || { status: "running", message: "正在重新连接采集器" };
      mergeMangaTaskJob(next);
      if (mangaAddJob?.id === jobId) {
        const generation = ++mangaAddGeneration;
        updateMangaAddState(next);
        if (mangaJobRunning(next) && next.id) void watchMangaAdd(next.id, generation);
      }
      syncMangaTaskManager();
      ensureMangaTaskMonitor();
    } catch (error) {
      mangaTaskActionErrors.set(jobId, error.message || "漫画任务重试失败");
    } finally {
      mangaTaskRetrying.delete(jobId);
      syncMangaTaskManager();
    }
  }

  async function clearFinishedMangaTaskHistory() {
    if (mangaTaskClearing) return;
    const finishedCount = mangaTaskJobs.filter((job) => !mangaJobRunning(job)).length;
    if (!finishedCount) return;
    const runningCount = mangaTaskJobs.filter(mangaJobRunning).length;
    const confirmed = await requestConfirmation({
      title: "清理漫画任务记录",
      message: runningCount
        ? `将清理 ${formatNumber(finishedCount)} 条已结束记录，${formatNumber(runningCount)} 个进行中任务会继续保留。漫画文件不会被删除。`
        : `将清理 ${formatNumber(finishedCount)} 条已结束记录，漫画文件不会被删除。`,
      confirmLabel: "清理记录",
      danger: false
    });
    if (!confirmed) return;
    mangaTaskListGeneration += 1;
    mangaTaskClearing = true;
    mangaTaskActionError = "";
    syncMangaTaskManager();
    try {
      await fetchJson(getActiveUrl(), "/api/manga/jobs/history", {
        method: "DELETE",
        timeoutMs: 12000
      });
      mangaTaskJobs = mangaTaskJobs.filter(mangaJobRunning);
      if (mangaAddJob && !mangaJobRunning(mangaAddJob)) mangaAddJob = null;
      for (const [mangaId, update] of mangaUpdateJobs) {
        if (!mangaJobRunning(update)) mangaUpdateJobs.delete(mangaId);
      }
      mangaTaskActionErrors.clear();
      if (!mangaTaskJobs.length) mangaTaskHistoryOpen = false;
      await refreshMangaTaskJobs();
    } catch (error) {
      mangaTaskActionError = error.message || "漫画任务记录清理失败";
    } finally {
      mangaTaskClearing = false;
      syncMangaTaskManager();
    }
  }

  function syncMangaTaskManager() {
    els.viewContent.querySelectorAll(".manga-task-history-toggle").forEach(updateMangaTaskHistoryControl);
    const current = els.viewContent.querySelector("[data-manga-task-manager]");
    if (!current) return false;
    current.replaceWith(createMangaTaskManager());
    return true;
  }

  async function refreshMangaTaskJobs() {
    const generation = ++mangaTaskListGeneration;
    const requestedIds = new Set(mangaTaskJobs.map((job) => String(job.id || "")));
    const data = await fetchJson(getActiveUrl(), "/api/manga/jobs?limit=12", { timeoutMs: 12000 });
    if (generation !== mangaTaskListGeneration || mangaTaskClearing) return false;
    const incoming = Array.isArray(data.jobs) ? data.jobs : [];
    const incomingIds = new Set(incoming.map((job) => String(job.id || "")));
    let settled = false;
    mangaTaskLoaded = true;
    mangaTaskError = "";
    for (const job of incoming) {
      const previous = mangaTaskJobs.find((item) => String(item.id || "") === String(job.id || ""));
      const merged = mergeMangaTaskJob(job);
      if ((mangaJobRunning(previous) && !mangaJobRunning(merged)) || (merged.comicAvailable && !previous?.comicAvailable)) settled = true;
      if (merged.id && merged.id === mangaAddJob?.id) updateMangaAddState(merged);
    }
    // Keep tasks created while this request was in flight, but honor removed history.
    mangaTaskJobs = mangaTaskJobs.filter((job) => incomingIds.has(String(job.id || "")) || !requestedIds.has(String(job.id || "")));
    syncMangaTaskManager();
    return settled;
  }

  async function refreshMangaLibraryAfterTaskChange(changed) {
    if (changed && els.viewContent.querySelector("[data-manga-task-manager]")) await refreshMangaLibrary();
  }

  function ensureMangaTaskMonitor() {
    if (mangaTaskMonitor) return mangaTaskMonitor;
    mangaTaskMonitor = (async () => {
      while (els.viewContent.querySelector("[data-manga-task-manager]")) {
        let shouldRefreshLibrary = false;
        try {
          shouldRefreshLibrary = await refreshMangaTaskJobs();
        } catch (error) {
          mangaTaskLoaded = true;
          mangaTaskError = error.message || "漫画任务读取失败";
          syncMangaTaskManager();
        }
        await refreshMangaLibraryAfterTaskChange(shouldRefreshLibrary);
        const delay = mangaTaskMonitorDelayMs(mangaTaskJobs, {
          connectionError: Boolean(mangaTaskError),
          hidden: document.visibilityState === "hidden"
        });
        await new Promise((resolve) => window.setTimeout(resolve, delay));
      }
    })().finally(() => { mangaTaskMonitor = null; });
    return mangaTaskMonitor;
  }

  function mangaPollDelay() {
    return new Promise((resolve) => window.setTimeout(resolve, 1200));
  }

  function mangaJobRunning(job) {
    return ["starting", "running"].includes(String(job?.status || ""));
  }

  function mangaJobMessage(job = {}) {
    if (job.message) return String(job.message);
    if (job.status === "starting") return "正在启动";
    if (job.status === "running") return "正在处理章节";
    if (job.status === "complete") return "处理完成";
    if (job.status === "failed") return "处理失败";
    return "等待开始";
  }

  function createMangaJobProgress(job = {}) {
    const wrap = document.createElement("div");
    wrap.className = `manga-job-progress is-${String(job.status || "idle")}`;
    wrap.setAttribute("role", "status");
    const percent = Math.max(0, Math.min(100, Number(job.progressPercent || (job.status === "complete" ? 100 : 0))));
    const chapterStats = mangaJobChapterStats(job);
    const hasChapterTotal = job.totalChapters !== null && job.totalChapters !== undefined;

    const head = document.createElement("div");
    head.className = "manga-job-progress-head";
    const label = document.createElement("strong");
    label.textContent = mangaJobMessage(job);
    const value = document.createElement("span");
    value.textContent = `${Math.round(percent)}%`;
    head.append(label, value);

    const track = document.createElement("div");
    track.className = "manga-job-progress-track";
    track.setAttribute("role", "progressbar");
    track.setAttribute("aria-valuemin", "0");
    track.setAttribute("aria-valuemax", "100");
    track.setAttribute("aria-valuenow", String(Math.round(percent)));
    const fill = document.createElement("i");
    fill.style.width = `${percent}%`;
    track.append(fill);

    const meta = document.createElement("div");
    meta.className = "manga-job-progress-meta";
    for (const text of [
      hasChapterTotal ? `目录 ${formatNumber(job.totalChapters)} 章` : "",
      hasChapterTotal ? `已完成 ${formatNumber(chapterStats.completed)} 章` : "",
      hasChapterTotal ? `剩余 ${formatNumber(chapterStats.remaining)} 章` : "",
      Number(job.totalImages || 0) > 0 ? `本章 ${formatNumber(job.completedImages || 0)}/${formatNumber(job.totalImages)} 张` : "",
      Number(job.downloadedBytes || 0) > 0 ? formatBytes(job.downloadedBytes) : ""
    ].filter(Boolean)) {
      const item = document.createElement("span");
      item.textContent = text;
      meta.append(item);
    }

    wrap.append(head, track);
    if (job.currentChapterTitle) {
      const current = document.createElement("span");
      current.className = "manga-job-current";
      current.textContent = job.currentChapterTitle;
      wrap.append(current);
    }
    if (meta.childElementCount) wrap.append(meta);
    return wrap;
  }

  function channelCardLabel(mode, item) {
    if (mode === "photo" && item.type === "photoCollection") return [item.category, item.rootLabel].filter(Boolean).join(" · ") || "合集";
    if (mode === "manga") return [item.category, chapterProgressText(item)].filter(Boolean).join(" · ") || "漫画";
    if (mode === "photo") return [item.category, item.personName].filter(Boolean).join(" · ") || "套图";
    if (mode === "media" && item.type === "tvSeries") return ["电视剧", item.category, item.year].filter(Boolean).join(" · ");
    if (mode === "media" && item.type === "movie") return ["电影", item.category, item.year].filter(Boolean).join(" · ");
    if (mode === "media" && item.type === "tv") return [item.tvSeries?.title || item.seriesName, item.category].filter(Boolean).slice(0, 2).join(" · ") || "电视剧";
    if (mode === "tv" && item.type === "tvSeries") return [item.category, item.year].filter(Boolean).join(" · ") || "电视剧";
    if (mode === "tv") return [item.tvSeries?.title, item.seriesName].filter(Boolean).slice(0, 1).join(" · ") || "电视剧";
    return [item.category, item.seriesName || item.personName].filter(Boolean).join(" · ") || channelConfig(mode).label;
  }

  function channelCardTitle(mode, item, channel) {
    if (mode === "photo" && item.type !== "photoCollection") return photoAlbumCardTitle(item);
    if (mode === "media" && item.type === "tv") return tvEpisodeTitle(item);
    if (mode === "tv" && item.type !== "tvSeries") return tvEpisodeTitle(item);
    return item.title || channel.label;
  }

  function channelCardSubtitle(mode, item) {
    if (mode === "media" && item.type === "tv") return tvEpisodeFileLabel(item);
    if (mode === "tv" && item.type !== "tvSeries") return tvEpisodeFileLabel(item);
    return "";
  }

  function tvEpisodeTitle(item = {}) {
    const match = String(item.title || "").match(/S(\d{1,2})E(\d{1,3})/i);
    if (!match) return item.title || "播放";
    const season = Number(match[1] || 0);
    const episode = Number(match[2] || 0);
    if (season > 1) return `第 ${season} 季 第 ${episode} 集`;
    return `第 ${episode} 集`;
  }

  function tvEpisodeFileLabel(item = {}) {
    return String(item.title || "").replace(/\s+/g, " ").trim();
  }

  function photoAlbumCardTitle(item = {}) {
    const raw = String(item.title || "").replace(/\s+/g, " ").trim();
    const person = String(item.personName || "").replace(/[[\]]/g, "").trim();
    if (!raw || !person) return raw || "套图";
    return raw
      .replace(new RegExp(`^${escapeRegExp(person)}\\s*[–—-]\\s*`, "i"), "")
      .replace(new RegExp(`^${escapeRegExp(person)}\\s+`, "i"), "")
      .trim() || raw;
  }

  function escapeRegExp(value) {
    return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  function channelFacts(mode, item) {
    if (mode === "manga") {
      return [
        item.chapterCount !== null ? `${formatNumber(item.chapterCount)} 话` : "",
        item.imageCount !== null ? `${formatNumber(item.imageCount)} 张` : "",
        formatDate(item.updatedAt)
      ];
    }
    if (mode === "photo") {
      const match = channelSearchMatchText(item);
      if (item.type === "photoCollection") {
        return [
          match,
          item.albumCount !== null ? `${formatNumber(item.albumCount)} 期` : "",
          Number(item.imageCount || 0) > 0 ? `${formatNumber(item.imageCount)} 张` : "",
          formatBytes(item.size)
        ];
      }
      return [
        match,
        item.ext ? item.ext.toUpperCase() : "",
        formatBytes(item.size),
        formatDate(item.updatedAt)
      ];
    }
    if (mode === "tv" && item.type === "tvSeries") {
      return [
        item.chapterCount !== null ? `${formatNumber(item.chapterCount)} 集` : "",
        item.rating ? `豆瓣 ${Number(item.rating).toFixed(1)}` : "",
        formatBytes(item.size)
      ];
    }
    if (mode === "media" && item.type === "tvSeries") {
      return [
        item.chapterCount !== null ? `${formatNumber(item.chapterCount)} 集` : "",
        item.rating ? `豆瓣 ${Number(item.rating).toFixed(1)}` : "",
        formatBytes(item.size)
      ];
    }
    if (mode === "media" && item.type === "movie") {
      return [
        item.rating ? `豆瓣 ${Number(item.rating).toFixed(1)}` : "",
        item.year || "",
        formatBytes(item.size)
      ];
    }
    return [
      item.ext ? item.ext.toUpperCase() : "",
      formatBytes(item.size),
      formatDate(item.updatedAt)
    ];
  }

  function channelSearchMatchText(item = {}) {
    const labels = {
      title: "标题",
      person: "人物",
      collection: "合集",
      category: "分类",
      folder: "文件夹",
      metadata: "资料"
    };
    const fields = (Array.isArray(item.matchFields) ? item.matchFields : []).map((field) => labels[field]).filter(Boolean);
    return fields.length ? `匹配 ${fields.slice(0, 2).join("/")}` : "";
  }

  function chapterProgressText(item) {
    if (item.doneChapterCount === null || item.chapterCount === null) return "";
    return `${formatNumber(item.doneChapterCount)}/${formatNumber(item.chapterCount)} 话`;
  }

  function thumbFallbackText(value) {
    return String(value || "?").trim().slice(0, 2) || "?";
  }

  function channelItemsPath(mode, limit, filters = {}, offset = 0) {
    const text = String(filters.query || "").trim();
    const mediaMode = ["movie", "tv", "anime", "media"].includes(mode);
    const mediaSort = normalizeChannelSort(filters.sort || (text ? "relevance" : "updated"));
    const params = new URLSearchParams({
      mode: mode === "anime" ? "media" : mode,
      limit: String(limit),
      offset: String(Math.max(0, Number(offset || 0))),
      sort: mediaMode ? (!text && mediaSort === "relevance" ? "updated" : mediaSort)
        : text ? "relevance" : normalizeChannelSort(filters.sort)
    });
    if (mode === "anime") params.set("kind", "anime");
    if (text) params.set("q", text);
    if (mode === "photo") {
      if (filters.photoView === "collections" && !filters.collection) params.set("photoView", "collections");
      if (filters.category && filters.category !== "all") params.set("category", filters.category);
      if (filters.person && filters.person !== "all") params.set("person", filters.person);
      if (filters.collection) params.set("collection", filters.collection);
    } else if (["western", "media", "movie", "tv", "anime"].includes(mode)) {
      if (filters.category && filters.category !== "all") params.set("category", filters.category);
      if (mode === "tv" || mode === "anime" || mode === "media") {
        if (filters.seriesKey) {
          params.set("tvView", "episodes");
          params.set("seriesKey", filters.seriesKey);
        } else if (mode === "tv" && filters.tvView === "episodes") {
          params.set("tvView", "episodes");
        }
      }
    }
    return `/api/image-library/items?${params}`;
  }

  function channelTitle(channel, filters = {}) {
    if (filters.mode === "photo" && filters.collectionTitle) {
      return filters.query ? `${filters.collectionTitle}：${filters.query}` : filters.collectionTitle;
    }
    if (filters.mode === "photo" && filters.photoView === "collections") {
      return filters.query ? `按合集浏览：${filters.query}` : "按合集浏览";
    }
    if (filters.mode === "photo") {
      return filters.query ? `全部套图：${filters.query}` : "全部套图";
    }
    if ((filters.mode === "tv" || filters.mode === "anime" || filters.mode === "media") && filters.seriesSummary?.title) {
      return filters.query ? `${filters.seriesSummary.title}：${filters.query}` : filters.seriesSummary.title;
    }
    if (filters.mode !== "photo" && filters.category && filters.category !== "all") {
      return filters.query ? `${channel.label}：${filters.category}：${filters.query}` : `${channel.label}：${filters.category}`;
    }
    return filters.query ? `${channel.label}：${filters.query}` : channel.label;
  }

  function normalizeChannelSort(value) {
    const sort = String(value || "").trim();
    return ["updated", "count", "title", "size", "rating", "relevance"].includes(sort) ? sort : "updated";
  }

  function createCollectionContextRow(summary = null, state = {}) {
    const row = document.createElement("div");
    row.className = "channel-context-row";
    const copy = document.createElement("div");
    copy.className = "photo-collection-context-copy";
    const title = document.createElement("strong");
    title.textContent = summary?.title || "当前合集";
    const text = document.createElement("span");
    const parts = [
      summary?.count ? `${formatNumber(summary.count)} 期` : "",
      summary?.imageCount ? `${formatNumber(summary.imageCount)} 张` : "",
      formatBytes(summary?.size)
    ].filter(Boolean);
    text.textContent = parts.length ? parts.join(" · ") : "合集内容";
    copy.append(title, text);
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = "返回分类";
    button.addEventListener("click", () => {
      const category = state.category || summary?.category || "";
      if (showPhotoCatalog) showPhotoCatalog(category);
      else updateChannelParams({ photoView: "collections", collection: "", category, person: "", query: "", sort: "count" });
    });
    row.append(copy, button);
    return row;
  }

  function createPhotoFilterStrip(facets = {}, state = {}) {
    const wrap = document.createElement("div");
    wrap.className = "channel-filter-wrap photo-filter-wrap";

    const row = document.createElement("div");
    row.className = "channel-filter-select-row";
    if (!state.collection && state.photoView !== "collections" && (facets.people || []).length) {
      row.append(createFacetSelect("人物", facets.people || [], state.person || "all", (value) => updateChannelParams({ person: value === "all" ? "" : value, collection: "" })));
    }
    if (row.children.length) wrap.append(row);
    return wrap;
  }

  function createMediaFilterStrip(facets = {}, state = {}, sortOptions = null) {
    const wrap = document.createElement("div");
    wrap.className = "channel-filter-wrap";
    const categories = facets.categories || [];
    if (categories.length) {
      wrap.append(createFacetRow("分类", categories, state.category || "all", (value) => updateChannelParams({ category: value === "all" ? "" : value })));
    }
    wrap.append(createSortRow(state.sort || "updated", sortOptions || [
      { value: "updated", label: "最近" },
      { value: "title", label: "标题" },
      { value: "size", label: "大小" }
    ], Boolean(state.query)));
    return wrap;
  }

  function createTvFilterStrip(facets = {}, state = {}) {
    const wrap = document.createElement("div");
    wrap.className = "channel-filter-wrap channel-tv-filter-wrap";
    wrap.append(createSortRow(state.sort || "updated", [
      { value: "updated", label: "最近" },
      { value: "rating", label: "评分" },
      { value: "title", label: "标题" }
    ], Boolean(state.query)));
    return wrap;
  }

  function createTvSeriesContextRow(summary = null, state = {}) {
    const row = document.createElement("div");
    row.className = "channel-context-row channel-tv-series-row media-series-context";
    const text = document.createElement("div");
    text.className = "media-series-copy";
    const parts = [
      summary?.category || "",
      summary?.year || "",
      summary?.rating ? `豆瓣 ${Number(summary.rating).toFixed(1)}` : "",
      `${formatNumber(state.total || summary?.chapterCount || 0)} 集在库`
    ].filter(Boolean);
    const title = document.createElement("strong");
    title.textContent = summary?.title || "当前剧集";
    const metadata = document.createElement("span");
    metadata.textContent = parts.join(" · ");
    text.append(title, metadata);
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = state.mode === "media" ? "返回影视" : state.mode === "anime" ? "返回动漫" : "返回剧集";
    button.addEventListener("click", () => {
      if (context.returnToMediaCatalog?.()) return;
      updateChannelParams({ mode: state.mode || "tv", tvView: "series", seriesKey: "", query: "" });
    });
    row.append(text, button);
    return row;
  }

  function createSortRow(activeSort, options = [
    { value: "updated", label: "最近" },
    { value: "title", label: "标题" },
    { value: "size", label: "大小" }
  ], searching = false) {
    const row = document.createElement("div");
    row.className = "channel-filter-row channel-sort-row";
    const title = document.createElement("span");
    title.textContent = "排序";
    row.append(title);
    const choices = searching ? [{ value: "relevance", label: "相关" }, ...options] : options;
    for (const option of choices) {
      const chip = createFacetChip(option.label, option.value, option.value === activeSort,
        (value) => updateChannelParams({ sort: value === "updated" && !searching ? "" : value }));
      chip.setAttribute("aria-pressed", String(option.value === activeSort));
      row.append(chip);
    }
    return row;
  }

  function createFacetRow(label, items, activeValue, onSelect, allLabel = "全部") {
    const row = document.createElement("div");
    row.className = "channel-filter-row";
    const title = document.createElement("span");
    title.textContent = label;
    row.append(title, createFacetChip(allLabel, "all", activeValue === "all" || !activeValue, onSelect));
    for (const item of items.slice(0, 10)) {
      row.append(createFacetChip(item.value, item.value, item.value === activeValue, onSelect, item.count));
    }
    return row;
  }

  function createFacetSelect(label, items, activeValue, onSelect, allLabel = "全部") {
    const field = document.createElement("label");
    field.className = "channel-filter-select";

    const title = document.createElement("span");
    title.textContent = label;

    const select = document.createElement("select");
    select.setAttribute("aria-label", label);
    appendSelectOption(select, allLabel, "all");

    const values = new Set(["all"]);
    for (const item of items.slice(0, 80)) {
      const value = String(item.value || "").trim();
      if (!value || values.has(value)) continue;
      values.add(value);
      appendSelectOption(select, value, value, item.count);
    }

    if (activeValue && !values.has(activeValue)) appendSelectOption(select, activeValue, activeValue);
    select.value = activeValue || "all";
    select.addEventListener("change", () => onSelect(select.value));

    field.append(title, select);
    return field;
  }

  function appendSelectOption(select, label, value, count = undefined) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = label;
    if (count !== undefined) option.title = `${label} · ${formatNumber(count || 0)}`;
    select.append(option);
  }

  function createFacetChip(label, value, active, onSelect, count = undefined) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = active ? "active" : "";
    button.textContent = label;
    if (count !== undefined) {
      button.title = `${label} · ${formatNumber(count || 0)}`;
      button.setAttribute("aria-label", `${label}，${formatNumber(count || 0)} 项`);
    }
    button.addEventListener("click", () => onSelect(value));
    return button;
  }

  function createLoadMoreButton(text, handler, options = {}) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "text-button channel-more";
    button.textContent = text;
    return enhanceAutoLoadMore(button, handler, {
      idleText: text,
      loadingText: "正在接着加载",
      retryText: "加载停住了，点一下重试",
      auto: options.auto,
      requireScrollIntent: options.requireScrollIntent === true
    });
  }

  function renderMessage(message, tone = "quiet", replace = true) {
    const node = document.createElement("div");
    node.className = `loading-row ${tone}`;
    node.textContent = message;
    if (replace) els.viewContent.innerHTML = "";
    els.viewContent.append(node);
    return node;
  }

  async function renderPhotoDetail(id, isActive = () => true) {
    cancelChannelRequest();
    resetMangaReaderProgressTracker();
    const albumId = String(id || "").trim();
    const path = photoDetailPath(albumId, { imageLimit: getPhotoImageLimit() });
    const activeUrl = getActiveUrl();
    let renderedCache = false;
    let renderedCacheSignature = "";

    setActiveBottom("photo");
    els.viewKicker.textContent = "套图";
    els.viewTitle.textContent = "套图详情";
    els.viewMeta.textContent = "正在读取";
    els.viewContent.innerHTML = `<div class="loading-row">正在读取套图</div>`;

    if (!albumId) {
      renderMessage("套图 ID 无效。", "error");
      return;
    }

    const cached = await readCachedJson(activeUrl, path).catch(() => null);
    if (!isActive()) return;
    if (cached?.payload?.album) {
      renderedCache = true;
      renderedCacheSignature = photoAlbumDataSignature(cached.payload.album);
      renderPhotoAlbum(cached.payload.album, cached);
    }

    try {
      const data = await fetchJson(activeUrl, path, { timeoutMs: 20000, signal: isActive.signal });
      writeCachedJson(activeUrl, path, data).catch(() => {});
      if (!isActive()) return;
      if (renderedCache && photoAlbumDataSignature(data.album) === renderedCacheSignature) {
        applyPhotoAlbumHeader(data.album);
        return;
      }
      renderPhotoAlbum(data.album);
    } catch (error) {
      if (!isActive()) return;
      if (renderedCache) {
        renderMessage("电脑端暂时连不上，当前显示的是本地缓存套图。", "quiet", false);
      } else {
        renderMessage(error.message || "套图读取失败", "error");
      }
    }
  }

  function renderPhotoAlbum(album = {}, cacheEntry = null) {
    const loadedImages = Array.isArray(album.images) ? album.images.slice() : [];
    let totalImages = Number(album.imageCount || loadedImages.length || 0);
    applyPhotoAlbumHeader(album, cacheEntry);
    resetPreviewImageObserver();
    els.viewContent.innerHTML = "";
    recordPhotoRecent(album);
    els.viewContent.append(createPhotoSummary(album, photoContentItem(album)));

    if (!loadedImages.length) {
      renderMessage("这套图暂时没有可预览图片。", "quiet", false);
      return;
    }

    const grid = document.createElement("div");
    grid.className = "photo-preview-grid";
    loadedImages.forEach((image, index) => grid.append(createPhotoTile(album, image, loadedImages, { index })));
    els.viewContent.append(grid);

    appendPhotoDetailLoadMore(album, loadedImages, grid, totalImages, (nextTotal) => {
      totalImages = nextTotal;
    });
  }

  function applyPhotoAlbumHeader(album = {}, cacheEntry = null) {
    const images = Array.isArray(album.images) ? album.images : [];
    const totalImages = Number(album.imageCount || images.length || 0);
    const suffix = cacheEntry ? ` · 缓存 ${cacheAgeText(cacheEntry.updatedAt)}` : "";
    els.viewKicker.textContent = [album.category, album.personName].filter(Boolean).join(" · ") || "套图";
    els.viewTitle.textContent = "套图详情";
    els.viewMeta.textContent = `${formatNumber(totalImages)} 张 · ${formatBytes(album.size)}${suffix}`;
  }

  function appendPhotoDetailLoadMore(album, loadedImages, grid, totalImages, updateTotalImages) {
    if (!grid?.isConnected || loadedImages.length >= totalImages || !album?.id) return;
    const text = `向下滑动继续显示 ${formatNumber(loadedImages.length)} / ${formatNumber(totalImages)}`;
    const more = createLoadMoreButton(text, async () => {
      const imageOffset = loadedImages.length;
      increasePhotoImageLimit(24);
      const imageLimit = Math.max(1, getPhotoImageLimit() - imageOffset);
      const path = photoDetailPath(album.id, { imageLimit, imageOffset });
      const data = await fetchJson(getActiveUrl(), path, { timeoutMs: 26000 });
      if (!grid.isConnected) return;

      const nextAlbum = data.album || {};
      const mergedImages = mergePhotoDetailImages(loadedImages, nextAlbum.images || []);
      const appendedImages = mergedImages.slice(loadedImages.length);
      loadedImages.splice(0, loadedImages.length, ...mergedImages);
      Object.assign(album, nextAlbum, { images: loadedImages, imageOffset: 0, imageLimit: loadedImages.length });
      const nextTotal = Math.max(Number(nextAlbum.imageCount || 0), totalImages, loadedImages.length);
      updateTotalImages(nextTotal);
      appendedImages.forEach((image, offset) => {
        grid.append(createPhotoTile(album, image, loadedImages, { index: imageOffset + offset }));
      });
      more.remove();
      appendPhotoDetailLoadMore(album, loadedImages, grid, nextTotal, updateTotalImages);
    }, { requireScrollIntent: true });
    els.viewContent.append(more);
  }

  function mergePhotoDetailImages(existing, incoming) {
    const merged = new Map();
    for (const image of [...(existing || []), ...(incoming || [])]) {
      const key = Number(image?.index || 0) > 0 ? `index:${Number(image.index)}` : `url:${String(image?.url || image?.name || "")}`;
      if (key !== "url:") merged.set(key, image);
    }
    return [...merged.values()].sort((a, b) => Number(a.index || 0) - Number(b.index || 0));
  }

  function createPhotoSummary(album = {}, favoriteItem = null) {
    const panel = document.createElement("div");
    panel.className = "photo-detail-summary";

    const main = document.createElement("div");
    main.className = "photo-detail-main";

    const title = document.createElement("strong");
    title.textContent = album.title || album.personName || album.subCategory || album.category || "套图";

    const subtitle = document.createElement("small");
    subtitle.textContent = [album.personName, album.category].filter(Boolean).join(" · ");
    main.append(title);
    if (subtitle.textContent) main.append(subtitle);

    const facts = document.createElement("div");
    facts.className = "photo-detail-facts";
    for (const fact of [
      album.archiveExt ? album.archiveExt.toUpperCase() : "",
      formatBytes(album.size),
      album.imageCount !== null && album.imageCount !== undefined ? `${formatNumber(album.imageCount)} 张` : "",
      formatDate(album.updatedAt)
    ].filter(Boolean)) {
      const node = document.createElement("span");
      node.textContent = fact;
      facts.append(node);
    }

    const side = document.createElement("div");
    side.className = "photo-detail-side";
    side.append(facts);
    const actions = document.createElement("div");
    actions.className = "photo-detail-actions";
    if (favoriteItem) actions.append(createChannelFavoriteButton(favoriteItem));
    if (actions.childElementCount) side.append(actions);

    panel.append(main, side);
    return panel;
  }

  function createPhotoTile(album, image = {}, sourceImages = [], options = {}) {
    const imageUrl = absoluteUrl(getActiveUrl(), image.url);
    const tile = document.createElement("button");
    tile.type = "button";
    tile.className = "photo-preview-tile";
    const previewUrl = Number(options.index || 0) === 0 ? absoluteUrl(getActiveUrl(), album.coverUrl) : "";
    if (previewUrl) {
      tile.dataset.photoPreview = "1";
      tile.style.backgroundImage = `url(${JSON.stringify(previewUrl)})`;
      tile.style.backgroundPosition = "center";
      tile.style.backgroundRepeat = "no-repeat";
      tile.style.backgroundSize = "cover";
    }

    const fallback = document.createElement("span");
    fallback.textContent = formatNumber(image.index || 0);
    tile.append(fallback);

    if (imageUrl) {
      const img = document.createElement("img");
      img.alt = image.name || `${album.title || "套图"} ${image.index || ""}`.trim();
      img.loading = "lazy";
      img.decoding = "async";
      img.referrerPolicy = "no-referrer";
      if ("fetchPriority" in img) img.fetchPriority = Number(options.index || 0) < EAGER_PHOTO_DETAIL_IMAGE_COUNT ? "high" : "low";
      img.addEventListener("load", () => {
        if (tile.dataset.photoPreview === "1") {
          delete tile.dataset.photoPreview;
          tile.style.removeProperty("background-image");
          tile.style.removeProperty("background-position");
          tile.style.removeProperty("background-repeat");
          tile.style.removeProperty("background-size");
        }
        delete img.dataset.photoReleased;
        delete img.dataset.photoFailed;
        tile.classList.remove("load-failed");
        fallback.textContent = formatNumber(image.index || 0);
        tile.setAttribute("aria-label", `打开第 ${formatNumber(image.index || options.index + 1)} 张`);
      });
      img.addEventListener("error", () => {
        if (img.dataset.photoReleased === "1") return;
        img.dataset.photoFailed = "1";
        tile.classList.add("load-failed");
        fallback.textContent = "加载失败 · 点按重试";
        tile.setAttribute("aria-label", `第 ${formatNumber(image.index || options.index + 1)} 张加载失败，点按重试`);
      });
      loadPhotoDetailImage(img, imageUrl, options.index);
      tile.append(img);
      tile.addEventListener("click", () => {
        if (img.dataset.photoFailed === "1") {
          retryPhotoDetailImage(img, imageUrl, image.index || options.index + 1, fallback);
          return;
        }
        const viewer = getMediaViewer();
        if (!viewer) return;
        const fallbackItems = photoViewerItemsFromImages(album, sourceImages);
        const fallbackIndex = fallbackItems.findIndex((item) => item.url === imageUrl);
        const sourceKey = photoViewerSourceKey(album);
        viewer.openImage(imageUrl, img.alt, {
          items: fallbackItems,
          index: fallbackIndex >= 0 ? fallbackIndex : Math.max(0, Number(image.index || options.index + 1 || 1) - 1),
          sourceKey
        });
        hydratePhotoViewerItems(viewer, album, sourceImages, sourceKey);
      });
    }

    return tile;
  }

  async function photoViewerItems(album = {}, sourceImages = []) {
    const currentImages = Array.isArray(sourceImages) ? sourceImages : [];
    const totalImages = Number(album.imageCount || currentImages.length || 0);
    if (!album.id || currentImages.length >= totalImages) return photoViewerItemsFromImages(album, currentImages);

    const activeUrl = getActiveUrl();
    const path = photoDetailPath(album.id, { imageLimit: "all" });
    const cached = await readCachedJson(activeUrl, path).catch(() => null);
    if (cached?.payload?.album?.images?.length >= totalImages) {
      return photoViewerItemsFromImages(cached.payload.album, cached.payload.album.images);
    }

    const data = await fetchJson(activeUrl, path, { timeoutMs: 26000 });
    writeCachedJson(activeUrl, path, data).catch(() => {});
    return photoViewerItemsFromImages(data.album || album, data.album?.images || currentImages);
  }

  function hydratePhotoViewerItems(viewer, album = {}, sourceImages = [], sourceKey = "") {
    const currentImages = Array.isArray(sourceImages) ? sourceImages : [];
    const totalImages = Number(album.imageCount || currentImages.length || 0);
    if (!viewer?.updateItems || !album.id || currentImages.length >= totalImages) return;

    photoViewerItems(album, sourceImages)
      .then((items) => {
        if (items.length > currentImages.length) viewer.updateItems(items, { sourceKey });
      })
      .catch(() => {});
  }

  function photoViewerSourceKey(album = {}) {
    return album.id ? `photo:${album.id}` : "";
  }

  function photoViewerItemsFromImages(album = {}, images = []) {
    const title = album.title || album.personName || album.subCategory || album.category || "套图";
    return (Array.isArray(images) ? images : [])
      .map((item) => ({
        url: absoluteUrl(getActiveUrl(), item.url),
        title
      }))
      .filter((item) => item.url);
  }

  function loadPhotoDetailImage(img, imageUrl, index = 0) {
    if (!img || !imageUrl) return;
    img.dataset.photoRetrySrc = imageUrl;
    img.dataset.photoSrc = imageUrl;
    const safeIndex = Math.max(0, Number(index) || 0);
    if (safeIndex === 0 && !photoDetailStartupImage) photoDetailStartupImage = img;
    const hasObserver = "IntersectionObserver" in window;
    if (hasObserver) getPhotoDetailImageObserver().observe(img);
    if (safeIndex < EAGER_PHOTO_DETAIL_IMAGE_COUNT || !hasObserver) {
      window.requestAnimationFrame(() => loadPendingPhotoDetailImage(img));
    }
  }

  function getPhotoDetailImageObserver() {
    if (photoDetailImageObserver) return photoDetailImageObserver;
    photoDetailImageObserver = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        const image = entry.target;
        if (entry.isIntersecting) loadPendingPhotoDetailImage(image);
        else releasePhotoDetailImage(image);
      }
    }, {
      root: null,
      rootMargin: LAZY_PHOTO_DETAIL_ROOT_MARGIN,
      threshold: 0
    });
    return photoDetailImageObserver;
  }

  function loadPendingPhotoDetailImage(image) {
    const imageUrl = image?.dataset?.photoSrc || image?.dataset?.photoRetrySrc || "";
    if (!imageUrl || !image?.isConnected) return;
    delete image.dataset.photoSrc;
    enqueuePhotoDetailImage(image, imageUrl);
  }

  function enqueuePhotoDetailImage(image, imageUrl) {
    if (!image || !imageUrl || image.getAttribute("src") || image.dataset.photoQueued === "1") return;
    image.dataset.photoQueued = "1";
    photoDetailImageQueue.push({
      image,
      imageUrl,
      generation: photoDetailImageGeneration
    });
    drainPhotoDetailImageQueue();
  }

  function retryPhotoDetailImage(image, imageUrl = image?.dataset?.photoRetrySrc || "", index = 0, fallback = null) {
    if (!image || !imageUrl || image.dataset.photoQueued === "1") return;
    image.removeAttribute("src");
    delete image.dataset.photoFailed;
    image.closest(".photo-preview-tile")?.classList.remove("load-failed");
    if (fallback) fallback.textContent = formatNumber(index || 0);
    enqueuePhotoDetailImage(image, imageUrl);
  }

  function drainPhotoDetailImageQueue() {
    const concurrency = photoDetailStartupImage ? 1 : PHOTO_DETAIL_IMAGE_CONCURRENCY;
    while (activePhotoDetailImageLoads < concurrency && photoDetailImageQueue.length) {
      const item = photoDetailImageQueue.shift();
      const { image, imageUrl, generation } = item;
      if (generation !== photoDetailImageGeneration || !image?.isConnected || image.getAttribute("src")) {
        if (image?.dataset) delete image.dataset.photoQueued;
        continue;
      }

      activePhotoDetailImageLoads += 1;
      delete image.dataset.photoQueued;
      delete image.dataset.photoFailed;
      delete image.dataset.photoReleased;
      image.closest(".photo-preview-tile")?.classList.remove("load-failed");
      const settle = (loaded) => {
        image.removeEventListener("load", onLoad);
        image.removeEventListener("error", onError);
        if (generation !== photoDetailImageGeneration) return;
        activePhotoDetailImageLoads = Math.max(0, activePhotoDetailImageLoads - 1);
        if (photoDetailStartupImage === image) photoDetailStartupImage = null;
        if (loaded && !photoDetailImageNearViewport(image)) releasePhotoDetailImage(image);
        drainPhotoDetailImageQueue();
      };
      const onLoad = () => settle(true);
      const onError = () => settle(false);
      image.addEventListener("load", onLoad);
      image.addEventListener("error", onError);
      image.src = imageUrl;
    }
  }

  function photoDetailImageNearViewport(image) {
    const rect = image?.getBoundingClientRect?.();
    if (!rect) return false;
    return rect.bottom >= -240 && rect.top <= window.innerHeight + 560;
  }

  function releasePhotoDetailImage(image) {
    if (!image?.hasAttribute?.("src") || !image.complete || image.naturalWidth <= 0 || image.dataset.photoQueued === "1") return;
    image.dataset.photoReleased = "1";
    image.dataset.photoSrc = image.dataset.photoRetrySrc || image.getAttribute("src") || "";
    image.removeAttribute("src");
    window.requestAnimationFrame(() => {
      if (!image.hasAttribute("src")) delete image.dataset.photoReleased;
    });
  }

  function photoDetailPath(id, options = {}) {
    const params = new URLSearchParams();
    if (options.imageLimit === "all") {
      params.set("imageLimit", "all");
    } else if (Number.isFinite(Number(options.imageLimit)) && Number(options.imageLimit) > 0) {
      params.set("imageLimit", String(Math.floor(Number(options.imageLimit))));
    }
    if (Number.isFinite(Number(options.imageOffset)) && Number(options.imageOffset) > 0) {
      params.set("imageOffset", String(Math.floor(Number(options.imageOffset))));
    }
    const query = params.toString();
    return `/api/photo-sets/${encodeURIComponent(String(id || ""))}${query ? `?${query}` : ""}`;
  }

  async function renderMediaDetail(id, initialMode = "", isActive = () => true) {
    cancelChannelRequest();
    resetMangaReaderProgressTracker();
    const mediaId = String(id || "").trim();
    const path = mediaDetailPath(mediaId);
    const activeUrl = getActiveUrl();
    const isCurrent = () => isActive() && !isActive.signal?.aborted && getActiveUrl() === activeUrl;
    let playbackRequested = false;
    let progressHandler = null;
    // Cache and network renders share one view subscription. Replacing the
    // surface replaces only its handler, not another native listener.
    const progressListenerReady = listenForNativeProgress(isActive.signal, event => {
      if (isCurrent()) progressHandler?.(event);
    });
    const playbackContext = {
      sourceUrl: activeUrl, isActive: isCurrent, signal: isActive.signal,
      onPlayRequested: () => { playbackRequested = true; },
      setProgressHandler: handler => { progressHandler = handler; return progressListenerReady; }
    };
    const loadingMode = ["western", "media", "movie", "tv", "anime"].includes(normalizeChannelMode(initialMode))
      ? normalizeChannelMode(initialMode)
      : "movie";
    const loadingChannel = channelConfig(loadingMode);
    let renderedCache = false;

    setActiveBottom(loadingMode);
    if (els.contentPanel) els.contentPanel.dataset.channelMode = loadingMode;
    els.viewKicker.textContent = loadingChannel.label;
    els.viewTitle.textContent = `${loadingChannel.label}详情`;
    els.viewMeta.textContent = "正在读取";
    els.viewContent.innerHTML = `<div class="loading-row">正在读取${loadingChannel.label}</div>`;

    if (!mediaId) {
      renderMessage("媒体 ID 无效。", "error");
      return;
    }

    const cached = await readCachedJson(activeUrl, path).catch(() => null);
    if (!isCurrent()) return;
    if (String(cached?.payload?.item?.id || "") === mediaId) {
      renderedCache = true;
      renderGalleryMedia(cached.payload.item, cached, playbackContext);
    }

    try {
      const data = await fetchJson(activeUrl, path, { timeoutMs: 16000, signal: isActive.signal });
      if (String(data?.item?.id || "") !== mediaId) throw new Error("媒体信息已变化，请返回列表刷新后重试。");
      writeCachedJson(activeUrl, path, data).catch(() => {});
      // Once a click owns this detail, even a response arriving after playback
      // settles must not replace its button, error or freshly prepared progress.
      if (!isCurrent() || playbackRequested) return;
      renderGalleryMedia(data.item, null, playbackContext);
    } catch (error) {
      if (!isCurrent() || playbackRequested) return;
      if (renderedCache) {
        renderMessage("电脑端暂时连不上，当前显示的是本地缓存媒体信息。", "quiet", false);
      } else {
        renderMessage(error.message || "媒体读取失败", "error");
      }
    }
  }

  function renderGalleryMedia(item = {}, cacheEntry = null, playbackContext = {}) {
    item = normalizeMediaMetadataItem(item);
    const mode = normalizeChannelMode(item.mediaKind || item.type);
    const channel = channelConfig(mode);
    const bottomMode = mode === "movie" || mode === "tv" || mode === "anime" ? "media" : mode;
    const sourceUrl = playbackContext.sourceUrl || getActiveUrl();
    const streamUrl = mediaPlaybackUrl(sourceUrl, item.streamUrl);
    const suffix = cacheEntry ? ` · 缓存 ${cacheAgeText(cacheEntry.updatedAt)}` : "";
    const meta = [item.ext ? item.ext.toUpperCase() : "", formatBytes(item.size), item.exists === false ? "文件不可用" : ""]
      .filter(Boolean)
      .join(" · ");

    setActiveBottom(bottomMode);
    if (els.contentPanel) els.contentPanel.dataset.channelMode = mode;
    els.viewKicker.textContent = [channel.label, item.seriesName || item.category].filter(Boolean).join(" · ");
    els.viewTitle.textContent = mediaDisplayTitle(item, channel);
    els.viewMeta.textContent = `${meta}${suffix}`;
    els.viewContent.innerHTML = "";
    recordMediaRecent(item, channel, mode);

    els.viewContent.append(createMediaPlayerPanel(item, streamUrl, channel, { ...playbackContext, sourceUrl }));
    if (item.metadataWarning) {
      const warning = document.createElement("p");
      warning.className = "media-metadata-warning";
      warning.textContent = item.metadataWarning;
      els.viewContent.append(warning);
    }
    els.viewContent.append(createMediaSummary(item, channel));
  }

  function createMediaSummary(item = {}, channel = CHANNELS.movie) {
    const cinematic = ["movie", "tv", "anime", "media"].includes(normalizeChannelMode(item.mediaKind || item.type));
    const panel = document.createElement(cinematic ? "details" : "div");
    panel.className = "media-detail-summary";

    const title = document.createElement(cinematic ? "summary" : "strong");
    title.textContent = "文件信息";
    const content = document.createElement("div");
    content.className = "media-file-content";

    const facts = document.createElement("div");
    facts.className = "media-detail-facts";
    for (const fact of [
      item.ext ? item.ext.toUpperCase() : "",
      formatBytes(item.size),
      formatDate(item.updatedAt),
      item.rootLabel || ""
    ].filter(Boolean)) {
      const node = document.createElement("span");
      node.textContent = fact;
      facts.append(node);
    }

    if (cinematic) {
      content.append(facts);
      panel.append(title, content);
    } else {
      panel.append(title, facts);
    }
    if (item.relativePath) {
      const path = document.createElement("span");
      path.className = "media-detail-path";
      path.textContent = item.relativePath;
      (cinematic ? content : panel).append(path);
    }
    return panel;
  }

  function mediaDisplayTitle(item = {}, channel = CHANNELS.movie) {
    const mode = normalizeChannelMode(item.mediaKind || item.type);
    if (mode === "tv" || mode === "anime") {
      return [mediaSeriesTitle(item, channel), tvEpisodeDisplayTitle(item)].filter(Boolean).join(" · ") || item.title || channel.label;
    }
    if (mode === "movie" || mode === "media") return mediaCardPresentation(mode, item).title;
    return item.seriesName || item.category || item.personName || item.title || channel.label;
  }

  function mediaDetailModeForItem(mode, item = {}) {
    if (mode !== "media") return mode;
    if (item.type === "movie" || item.mediaKind === "movie") return "movie";
    if (item.type === "tv" || item.mediaKind === "tv") return "tv";
    if (item.type === "anime" || item.mediaKind === "anime") return "anime";
    return mode;
  }

  function createMediaPlayerPanel(item = {}, streamUrl = "", channel = CHANNELS.movie, playbackContext = {}) {
    const panel = document.createElement("div");
    panel.className = "media-player-panel";
    const mode = normalizeChannelMode(item.mediaKind || item.type);
    if (mode === "movie") panel.classList.add("is-movie");

    const head = document.createElement("div");
    head.className = "media-player-head";
    const titleWrap = document.createElement("div");
    titleWrap.className = "media-player-title";
    const title = document.createElement("strong");
    title.textContent = mediaDisplayTitle(item, channel);
    const subtitle = document.createElement("span");
    subtitle.textContent = mediaDisplaySubtitle(item, channel);
    titleWrap.append(title);
    if (subtitle.textContent) titleWrap.append(subtitle);

    const actions = document.createElement("div");
    actions.className = "media-action-row";
    actions.append(createBackButton(), createChannelFavoriteButton(mediaContentItem(item, channel, mode)));
    head.append(titleWrap, actions);

    panel.append(head, createNativePlaySurface(panel, item, streamUrl, channel, playbackContext), createMediaFactRow(item, channel));
    const episodeNav = createTvEpisodeNav(item, playbackContext);
    if (episodeNav) panel.append(episodeNav);
    return panel;
  }

  function createBackButton() {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "media-back-action";
    button.textContent = "返回";
    button.addEventListener("click", goBack);
    return button;
  }

  function createChannelFavoritePanel(item) {
    const panel = document.createElement("div");
    panel.className = "detail-action-row channel-detail-actions";
    panel.append(createChannelFavoriteButton(item));
    return panel;
  }

  function createChannelFavoriteButton(item) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "channel-favorite-action favorite-action";
    syncChannelFavoriteButton(button, item);
    button.addEventListener("click", () => {
      const result = toggleChannelFavorite(item);
      syncChannelFavoriteButton(button, item, result.favorite);
      onChannelFavoriteChange(result.items);
    });
    return button;
  }

  function syncChannelFavoriteButton(button, item, forced = null) {
    const favorite = forced === null ? isChannelFavorite(item) : Boolean(forced);
    button.textContent = favorite ? "已收藏" : "收藏";
    button.classList.toggle("active", favorite);
  }

  async function openNativeMediaPlayer(item = {}, streamUrl = "", channel = CHANNELS.movie, playbackContext = {}) {
    const plugin = window.Capacitor?.Plugins?.FanHaoPlayer;
    const sourceUrl = playbackContext.sourceUrl || getActiveUrl();
    const id = String(item.id || "").trim();
    const isActive = playbackContext.isActive || (() => true);
    if (!plugin?.play || !streamUrl || !id || !isActive()) return false;
    // Read on every launch, including another click on the same detail after the
    // native Activity returns. Cached detail progress is never a launch snapshot.
    const request = { timeoutMs: 12000, signal: playbackContext.signal, cache: "no-store" };
    const [detail, playInfo] = await Promise.all([
      fetchJson(sourceUrl, mediaDetailPath(id), request),
      fetchJson(sourceUrl, `/api/playinfo/${encodeURIComponent(id)}?source=gallery`, request).catch(() => null)
    ]);
    if (!isActive() || playbackContext.signal?.aborted || getActiveUrl() !== sourceUrl) return false;
    const fresh = normalizeMediaMetadataItem(detail?.item);
    if (String(fresh?.id || "") !== id) throw new Error("媒体信息已变化，请返回列表刷新后重试。");
    if (fresh.exists === false) throw new Error("视频文件已移动或离线，请刷新后重试。");
    const url = mediaPlaybackUrl(sourceUrl, fresh.streamUrl);
    if (!url) throw new Error("没有可播放地址。");
    const fallback = playInfo?.mode === "direct" ? playInfo.fallbackStreamUrl : playInfo?.streamUrl;
    const fallbackUrl = mediaPlaybackUrl(sourceUrl, fallback);
    const probedDuration = Number(playInfo?.duration);
    const savedDuration = Number(fresh.progress?.duration);
    const duration = Number.isFinite(probedDuration) && probedDuration > 0 ? probedDuration
      : Number.isFinite(savedDuration) && savedDuration > 0 ? savedDuration : 0;
    playbackContext.onPrepared?.(fresh);
    try {
      const result = await plugin.play({
        url,
        // The native fallback owns seek-offset handling. Do not add t here.
        fallbackUrl,
        progressUrl: absoluteUrl(sourceUrl, `/api/progress/${encodeURIComponent(id)}`),
        title: mediaDisplayTitle(fresh, channel),
        subtitle: mediaDisplaySubtitle(fresh, channel),
        mode: "gallery-media",
        videoId: id,
        progressSessionId: playbackContext.progressSessionId,
        position: mediaResumePosition(fresh.progress),
        duration
      });
      return result?.opened !== false;
    } catch {
      return false;
    }
  }

  function listenForNativeProgress(signal, onCommitted) {
    const plugin = window.Capacitor?.Plugins?.FanHaoPlayer;
    if (!signal || signal.aborted || !plugin?.addListener) return Promise.resolve();
    let listener = null;
    const remove = handle => {
      try { Promise.resolve(handle?.remove()).catch(() => {}); } catch {}
    };
    signal.addEventListener("abort", () => { remove(listener); listener = null; }, { once: true });
    try {
      return Promise.resolve(plugin.addListener("progressCommitted", onCommitted)).then(handle => {
        if (signal.aborted) remove(handle);
        else listener = handle;
      }, () => {});
    } catch {
      // Older bridges may not expose listeners. Focus/visibility remain a fallback.
      return Promise.resolve();
    }
  }

  function createNativePlaySurface(panel, item = {}, streamUrl = "", channel = CHANNELS.movie, playbackContext = {}) {
    const sourceUrl = playbackContext.sourceUrl || getActiveUrl();
    let currentItem = item;
    let progressRevision = 0;
    let progressSessionId = "";
    const button = document.createElement("button");
    button.type = "button";
    button.className = "media-native-play-surface";
    button.setAttribute("aria-label", "播放");

    const visual = document.createElement("span");
    visual.className = "media-native-play-visual";
    visual.textContent = "";

    const cover = item.coverUrl ? absoluteUrl(sourceUrl, item.coverUrl) : "";
    if (cover) {
      loadPreviewImage(visual, cover, {
        cacheBaseUrl: sourceUrl,
        decorate: (img) => {
          img.className = "media-native-play-image";
        }
      });
    }

    const playMark = document.createElement("span");
    playMark.className = "media-native-play-mark";
    playMark.setAttribute("aria-hidden", "true");
    playMark.textContent = "▶";

    const label = document.createElement("span");
    label.className = "media-native-play-label";
    const isActive = () => document.body.contains(button) && getActiveUrl() === sourceUrl
      && !playbackContext.signal?.aborted && (playbackContext.isActive?.() ?? true);
    const syncLabel = () => {
      label.textContent = streamUrl ? mediaPlaybackLabel(currentItem) : "暂无播放地址";
      button.setAttribute("aria-label", label.textContent);
    };
    syncLabel();

    // A native Activity can return without rebuilding this WebView detail.
    // Scope listeners to the view's abort signal so old details cannot accumulate.
    let refreshing = false;
    let refreshPending = false;
    const drainProgressRefresh = async () => {
      if (!refreshPending || !isActive() || button.disabled || refreshing || document.visibilityState === "hidden") return;
      refreshPending = false;
      refreshing = true;
      const revision = progressRevision;
      try {
        const data = await fetchJson(sourceUrl, mediaDetailPath(item.id), {
          timeoutMs: 8000, signal: playbackContext.signal, cache: "no-store"
        });
        if (revision === progressRevision && isActive() && !button.disabled && document.visibilityState !== "hidden" && String(data?.item?.id || "") === String(item.id)) {
          currentItem = data.item;
          syncLabel();
        }
      } catch {} finally {
        refreshing = false;
        // Consume only a return event received during the request. A failure
        // without another event must not turn into an automatic retry loop.
        if (refreshPending) void drainProgressRefresh();
      }
    };
    const refreshProgress = () => {
      if (!isActive() || document.visibilityState === "hidden") return;
      // Keep one pending refresh while a prior read or explicit launch owns
      // the surface; focus/visibility events may arrive before either settles.
      refreshPending = true;
      return drainProgressRefresh();
    };
    if (playbackContext.signal) {
      document.addEventListener("visibilitychange", refreshProgress, { signal: playbackContext.signal });
      window.addEventListener("focus", refreshProgress, { signal: playbackContext.signal });
    }
    const progressListenerReady = playbackContext.setProgressHandler?.(event => {
      if (!isActive() || !progressSessionId || event?.mode !== "gallery-media"
        || event.videoId !== String(item.id)
        || event.progressSessionId !== progressSessionId
        || event.progressUrl !== absoluteUrl(sourceUrl, `/api/progress/${encodeURIComponent(item.id)}`)) return;
      // A final POST may finish after every return-triggered GET. Invalidate
      // older reads, then fetch authoritative progress; the event is not data.
      progressRevision += 1;
      refreshPending = true;
      void drainProgressRefresh();
    });

    button.append(visual, playMark, label);
    button.addEventListener("click", async () => {
      if (button.disabled || !isActive()) return;
      progressRevision += 1;
      progressSessionId = `${Date.now()}-${++mediaPlaybackSessionSequence}`;
      panel.querySelector(".media-player-error")?.remove();
      if (!streamUrl) {
        panel.append(createMediaPlayerError("没有可播放地址。"));
        return;
      }
      playbackContext.onPlayRequested?.();
      const startedAt = performance.now();
      button.disabled = true;
      button.setAttribute("aria-busy", "true");
      label.textContent = "正在打开";
      try {
        await progressListenerReady;
        const opened = await openNativeMediaPlayer(currentItem, streamUrl, channel, {
          sourceUrl, signal: playbackContext.signal, isActive, progressSessionId,
          onPrepared: (fresh) => { currentItem = fresh; }
        });
        if (!opened && isActive()) panel.append(createMediaPlayerError("播放器打开失败。"));
      } catch (error) {
        if (isActive()) panel.append(createMediaPlayerError(error.message || "播放信息读取失败，请重试。"));
      } finally {
        await waitForMinimumOpenTime(startedAt);
        syncLabel();
        button.removeAttribute("aria-busy");
        button.disabled = false;
        if (refreshPending) void drainProgressRefresh();
      }
    });
    return button;
  }

  function waitForMinimumOpenTime(startedAt) {
    const elapsed = performance.now() - startedAt;
    const remaining = PLAY_OPEN_COOLDOWN_MS - elapsed;
    if (remaining <= 0) return Promise.resolve();
    return new Promise((resolve) => window.setTimeout(resolve, remaining));
  }

  function createMediaFactRow(item = {}, channel = CHANNELS.movie) {
    const row = document.createElement("div");
    row.className = "media-player-facts";
    for (const fact of mediaDetailFacts(item, channel).filter(Boolean).slice(0, 5)) {
      const node = document.createElement("span");
      node.textContent = fact;
      row.append(node);
    }
    return row;
  }

  function createTvEpisodeNav(item = {}, playbackContext = {}) {
    const mode = normalizeChannelMode(item.mediaKind || item.type);
    const seriesKey = String(item.seriesKey || item.tvSeries?.seriesKey || "").trim();
    if (!["tv", "anime"].includes(mode) || !seriesKey || !item.id || !showMediaDetail) return null;

    const row = document.createElement("div");
    row.className = "media-episode-nav";
    const sourceUrl = playbackContext.sourceUrl || getActiveUrl();
    const isCurrent = () => document.body.contains(row) && getActiveUrl() === sourceUrl
      && !playbackContext.signal?.aborted && (playbackContext.isActive?.() ?? true);

    const prev = createEpisodeNavButton("上一集");
    const next = createEpisodeNavButton("下一集");
    const status = document.createElement("span");
    status.className = "media-episode-nav-status";
    const label = document.createElement("span");
    label.className = "media-episode-nav-label";
    label.textContent = "正在读取集数";
    const retry = createEpisodeNavButton("重试");
    retry.className = "media-episode-nav-retry";
    retry.setAttribute("aria-label", "重新读取集数");
    retry.hidden = true;
    status.append(label, retry);
    row.append(prev, status, next);

    const pageSize = 240;
    const filters = {
      tvView: "episodes",
      seriesKey,
      category: item.category || item.tvSeries?.category || "",
      sort: "title"
    };
    let loading = false;
    async function loadEpisodes() {
      if (loading || !isCurrent()) return;
      loading = true;
      row.dataset.state = "loading";
      row.setAttribute("aria-busy", "true");
      label.textContent = "正在读取集数";
      retry.hidden = true;
      retry.disabled = true;
      bindEpisodeNavButton(prev, null, isCurrent, mode);
      bindEpisodeNavButton(next, null, isCurrent, mode);
      let offset = 0, total = null, scanRevision = null, previous = null, current = null;
      const seen = new Set();
      const complete = (following) => {
        label.textContent = `第 ${current.position} / ${total} 集`;
        row.dataset.state = "ready";
        bindEpisodeNavButton(prev, current.previous, isCurrent, mode);
        bindEpisodeNavButton(next, following, isCurrent, mode);
      };
      try {
        while (isCurrent()) {
          const data = await fetchJson(sourceUrl, channelItemsPath(mode, pageSize, filters, offset), {
            timeoutMs: 12000, signal: playbackContext.signal, cache: "no-store"
          });
          if (!isCurrent()) return;
          const episodes = data?.items;
          if (!Array.isArray(episodes) || episodes.length > pageSize || data.offset !== offset
            || !Number.isSafeInteger(data.total) || data.total < 0 || offset + episodes.length > data.total
            || (!episodes.length && offset < data.total) || (total !== null && data.total !== total)
            || (scanRevision !== null && String(data.scannedAt || "") !== scanRevision)
            || String(data.seriesKey || "") !== seriesKey) {
            throw new Error("选集目录有变化");
          }
          total = data.total;
          scanRevision = String(data.scannedAt || "");
          for (const episode of episodes) {
            const id = String(episode?.id || "").trim();
            if (!id || seen.has(id) || (episode.seriesKey && episode.seriesKey !== seriesKey)) throw new Error("选集目录有变化");
            seen.add(id);
          }
          for (let index = 0; index < episodes.length; index += 1) {
            const episode = episodes[index];
            // Stop as soon as the neighbour is known; long series need only
            // bounded pages up to this episode, never a full-library download.
            if (current) { complete(episode); return; }
            if (episode.id === item.id) current = { position: offset + index + 1, previous };
            previous = episode;
          }
          offset += episodes.length;
          if (offset >= total) {
            if (!current) throw new Error("当前集不在目录");
            complete(null);
            return;
          }
        }
      } catch (error) {
        if (!isCurrent()) return;
        row.dataset.state = "error";
        label.textContent = ["选集目录有变化", "当前集不在目录"].includes(error.message) ? error.message : "集数读取失败";
        retry.hidden = false;
        retry.disabled = false;
      } finally {
        loading = false;
        if (isCurrent()) row.removeAttribute("aria-busy");
      }
    }
    retry.addEventListener("click", loadEpisodes);
    // The detail renderer mounts this newly created row synchronously.
    Promise.resolve().then(loadEpisodes);
    return row;
  }

  function createEpisodeNavButton(label) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = label;
    button.disabled = true;
    return button;
  }

  function bindEpisodeNavButton(button, episode, isCurrent = () => true, mode = "tv") {
    if (!episode?.id) {
      button.disabled = true;
      button.onclick = null;
      return;
    }
    button.disabled = false;
    button.onclick = () => {
      if (!button.disabled && isCurrent()) showMediaDetail(episode.id, mode);
    };
  }

  function mediaDetailFacts(item = {}, channel = CHANNELS.movie) {
    const mode = normalizeChannelMode(item.mediaKind || item.type);
    if (["movie", "tv", "anime", "media"].includes(mode)) {
      const metadata = mode === "tv" || mode === "anime" ? item.tvSeries || {} : item.movieMetadata || {};
      const rating = Number(item.rating ?? metadata.rating);
      return [Number.isFinite(rating) && rating > 0 && rating <= 10 ? `豆瓣 ${rating.toFixed(1)}` : "", ...(Array.isArray(metadata.genres) ? metadata.genres : Array.isArray(item.genres) ? item.genres : [])];
    }
    return [
      channel.label,
      mode === "tv" ? item.category : item.seriesName || item.category,
      item.tvSeries?.year || "",
      item.tvSeries?.rating ? `豆瓣 ${Number(item.tvSeries.rating).toFixed(1)}` : "",
      item.ext ? item.ext.toUpperCase() : "",
      formatBytes(item.size)
    ];
  }

  function mediaDisplaySubtitle(item = {}, channel = CHANNELS.movie) {
    const mode = normalizeChannelMode(item.mediaKind || item.type);
    if (["movie", "tv", "anime", "media"].includes(mode)) {
      const metadata = mode === "tv" || mode === "anime" ? item.tvSeries || {} : item.movieMetadata || {};
      return [...new Set([channel.label, item.year || metadata.year, item.category].filter(Boolean))].join(" · ");
    }
    if (mode === "tv" || mode === "anime") {
      return [item.category, item.tvSeries?.year, item.ext ? item.ext.toUpperCase() : "", formatBytes(item.size)].filter(Boolean).join(" · ");
    }
    return [channel.label, item.seriesName || item.category, item.ext ? item.ext.toUpperCase() : "", formatBytes(item.size)].filter(Boolean).join(" · ");
  }

  function mediaSeriesTitle(item = {}, channel = CHANNELS.movie) {
    return item.tvSeries?.title || item.seriesName || item.category || channel.label;
  }

  function tvEpisodeDisplayTitle(item = {}) {
    const match = String(item.title || "").match(/S(\d{1,2})E(\d{1,3})/i);
    if (!match) return item.title || "";
    const season = Number(match[1] || 0);
    const episode = Number(match[2] || 0);
    if (season > 1) return `第 ${season} 季 第 ${episode} 集`;
    return `第 ${episode} 集`;
  }

  function createMediaPlayerError(message) {
    const error = document.createElement("div");
    error.className = "media-player-error";
    error.textContent = message;
    return error;
  }

  function mediaDetailPath(id) {
    return `/api/gallery-media/${encodeURIComponent(String(id || ""))}`;
  }

  async function renderMangaDetail(id, isActive = () => true) {
    cancelChannelRequest();
    resetMangaReaderProgressTracker();
    const mangaId = String(id || "").trim();
    const path = mangaDetailPath(mangaId);
    const activeUrl = getActiveUrl();
    let renderedCache = false;
    let renderedSignature = "";

    setActiveBottom("photo");
    els.viewKicker.textContent = "韩漫";
    els.viewTitle.textContent = "漫画详情";
    els.viewMeta.textContent = "正在读取";
    els.viewContent.replaceChildren(createMangaLoading("正在读取漫画"));

    if (!mangaId) {
      renderMessage("漫画 ID 无效。", "error");
      return;
    }

    const slowTimer = window.setTimeout(() => {
      if (renderedCache || !isActive()) return;
      const detail = els.viewContent.querySelector("[data-manga-loading-detail]");
      if (detail) detail.textContent = "电脑端响应较慢，最多再等待 10 秒";
    }, 2200);

    const cached = await readCachedJson(activeUrl, path).catch(() => null);
    if (!isActive()) return;
    if (cached?.payload?.comic) {
      renderedCache = true;
      renderedSignature = mangaRenderSignature(cached.payload.comic, cached.payload.update);
      renderMangaComic(cached.payload.comic, cached, cached.payload.update);
    }

    try {
      const data = await fetchJson(activeUrl, path, { timeoutMs: 10000, signal: isActive.signal });
      writeCachedJson(activeUrl, path, data).catch(() => {});
      if (!isActive()) return;
      const nextSignature = mangaRenderSignature(data.comic, data.update);
      if (!renderedCache || nextSignature !== renderedSignature) {
        renderMangaComic(data.comic, null, data.update);
      } else {
        const chapters = Array.isArray(data.comic?.chapters) ? data.comic.chapters : [];
        els.viewMeta.textContent = `${formatNumber(chapters.length || data.comic?.chapterCount || 0)} 话 · ${formatNumber(data.comic?.imageCount || 0)} 张`;
      }
      if (data.comic?.id && data.update?.status) mergeMangaTaskJob({ ...data.update, comicId: data.comic.id });
      if (mangaJobRunning(data.update)) void watchMangaUpdate(data.comic.id, data.comic);
    } catch (error) {
      if (!isActive()) return;
      if (renderedCache) {
        prependMangaCacheNotice("电脑端暂时未连接，当前书籍资料和目录来自手机缓存。");
      } else {
        renderMangaDetailFailure(error);
      }
    } finally {
      window.clearTimeout(slowTimer);
    }
  }

  function renderMangaDetailFailure(error) {
    els.viewMeta.textContent = "读取失败";
    els.viewContent.innerHTML = "";
    els.viewContent.append(createMangaFailurePanel({
      title: "漫画资料暂时打不开",
      message: mangaDetailFailureMessage(error),
      primaryLabel: "重新读取",
      primaryAction: () => renderCurrentView(),
      secondaryLabel: "返回书库",
      secondaryAction: () => {
        if (showMangaLibrary) showMangaLibrary();
        else goBack();
      }
    }));
  }

  function mangaDetailFailureMessage(error) {
    const status = Number(error?.status || error?.statusCode || 0);
    if (status === 404) return "这部漫画已从本地书库移除，或书籍资料尚未建立。";
    return mangaConnectionFailureMessage(error, "电脑端没有返回书籍资料，请稍后重新读取。");
  }

  function mangaRenderSignature(...values) {
    try {
      return JSON.stringify(values);
    } catch {
      return "";
    }
  }

  function renderMangaComic(comic = {}, cacheEntry = null, update = null) {
    const chapters = Array.isArray(comic.chapters) ? comic.chapters : [];
    const visible = chapters.slice(0, getChannelLimit());
    const suffix = cacheEntry ? ` · 缓存 ${cacheAgeText(cacheEntry.updatedAt)}` : "";
    const currentUpdate = update
      ? rememberMangaUpdateJob({ ...update, comicId: comic.id })
      : mangaUpdateJobs.get(comic.id) || { status: "idle" };

    els.viewKicker.textContent = "韩漫";
    els.viewTitle.textContent = "书籍详情";
    els.viewMeta.textContent = `${formatNumber(chapters.length || comic.chapterCount || 0)} 话 · ${formatNumber(comic.imageCount || 0)} 张${suffix}`;
    els.viewContent.innerHTML = "";
    recordMangaRecent(comic);
    els.viewContent.append(createMangaSummary(comic, currentUpdate));

    if (!visible.length) {
      renderMessage("这部漫画暂时没有章节。", "quiet", false);
      return;
    }

    const list = document.createElement("div");
    list.className = "manga-chapter-list";
    const section = document.createElement("div");
    section.className = "manga-section-title";
    const sectionTitle = document.createElement("strong");
    sectionTitle.textContent = "章节目录";
    const sectionMeta = document.createElement("span");
    sectionMeta.textContent = `${formatNumber(chapters.length || comic.chapterCount || 0)} 话`;
    section.append(sectionTitle, sectionMeta);
    visible.forEach((chapter) => list.append(createMangaChapterButton(comic, chapter)));
    els.viewContent.append(section, list);

    if (visible.length < chapters.length) {
      els.viewContent.append(createLoadMoreButton(`向下滑动继续显示章节 ${formatNumber(visible.length)} / ${formatNumber(chapters.length)}`, () => {
        increaseChannelLimit(40);
        return renderCurrentViewPreservingScroll();
      }));
    }
  }

  function createMangaSummary(comic = {}, update = {}) {
    const panel = document.createElement("div");
    panel.className = "manga-detail-summary";
    panel.dataset.mangaId = String(comic.id || "");

    const hero = document.createElement("div");
    hero.className = "manga-detail-hero";

    const cover = document.createElement("div");
    cover.className = "manga-detail-cover";
    cover.textContent = thumbFallbackText(comic.title || "漫画");
    const coverUrl = comic.coverUrl ? absoluteUrl(getActiveUrl(), comic.coverUrl) : "";
    if (coverUrl) loadPreviewImage(cover, coverUrl, {
      cacheBaseUrl: getActiveUrl(),
      decorate: (image) => { image.className = "manga-detail-cover"; }
    });

    const body = document.createElement("div");
    body.className = "manga-detail-body";

    const title = document.createElement("strong");
    title.textContent = comic.title || "漫画详情";

    const source = document.createElement("span");
    source.className = "manga-detail-source";
    source.textContent = [comic.site, comic.category].filter(Boolean).join(" · ") || "本地漫画";

    const facts = document.createElement("div");
    facts.className = "manga-detail-facts";
    for (const fact of [
      comic.chapterCount !== null && comic.chapterCount !== undefined ? `${formatNumber(comic.chapterCount)} 话` : "",
      comic.doneChapterCount !== null && comic.doneChapterCount !== undefined ? `完成 ${formatNumber(comic.doneChapterCount)} 话` : "",
      comic.imageCount !== null && comic.imageCount !== undefined ? `${formatNumber(comic.imageCount)} 张` : "",
      formatDate(comic.updatedAt)
    ].filter(Boolean)) {
      const node = document.createElement("span");
      node.textContent = fact;
      facts.append(node);
    }

    const description = document.createElement("p");
    description.className = "manga-detail-description";
    description.textContent = comic.description || "章节目录与下载状态以电脑端采集结果为准。";

    const actions = document.createElement("div");
    actions.className = "manga-detail-actions";
    const readingProgress = readMangaReadingProgress(comic.id);
    const progressChapter = Array.isArray(comic.chapters)
      ? comic.chapters.find((chapter) => Number(chapter.index || 0) === Number(readingProgress?.chapterIndex || 0))
      : null;
    const continueButton = progressChapter ? document.createElement("button") : null;
    if (continueButton) {
      continueButton.type = "button";
      continueButton.className = "manga-continue";
      continueButton.textContent = `继续第 ${formatNumber(progressChapter.index)} 话 · 第 ${formatNumber(readingProgress.pageIndex)} 张`;
      continueButton.addEventListener("click", () => {
        requestMangaResume(comic.id, progressChapter.index, readingProgress.pageIndex);
        showMangaChapter?.(comic.id, progressChapter.index);
      });
    }
    const updateButton = document.createElement("button");
    updateButton.type = "button";
    updateButton.dataset.mangaUpdate = "";
    updateButton.textContent = mangaUpdateButtonLabel(update);
    updateButton.disabled = !comic.sourceUrl || mangaJobRunning(update);
    updateButton.addEventListener("click", () => void startMangaUpdate(comic));

    const wholeDownloadReady = mangaWholeDownloadReady(comic);
    const download = document.createElement(wholeDownloadReady ? "a" : "button");
    if (wholeDownloadReady) {
      download.href = absoluteUrl(getActiveUrl(), `/api/manga/${encodeURIComponent(comic.id)}/download`);
      download.textContent = "下载整本";
    } else {
      download.type = "button";
      download.disabled = true;
      download.textContent = "整本待完成";
      download.title = Number(comic.failedCount || 0) > 0
        ? `还有 ${formatNumber(comic.failedCount)} 个文件失败，请先更新重试`
        : `已完成 ${formatNumber(comic.doneChapterCount || 0)}/${formatNumber(comic.chapterCount || 0)} 话，完成后可下载整本`;
      download.setAttribute("aria-label", download.title);
    }

    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "danger";
    remove.dataset.mangaDelete = "";
    remove.textContent = "删除漫画";
    remove.disabled = mangaJobRunning(update);
    remove.addEventListener("click", () => void deleteMangaComic(comic));
    const favorite = createChannelFavoriteButton(mangaContentItem(comic));
    favorite.classList.add("manga-favorite");
    if (continueButton) actions.append(continueButton);
    actions.append(favorite, updateButton, download, remove);

    const jobSlot = document.createElement("div");
    jobSlot.className = "manga-job-slot";
    if (mangaDetailJobVisible(update)) jobSlot.append(createMangaJobProgress(update));
    else if (mangaTaskNoticeMatchesComic(comic)) jobSlot.append(createMangaCompletionNotice());

    body.append(title, source, facts, description);
    hero.append(cover, body);
    panel.append(hero, actions, jobSlot);
    return panel;
  }

  function mangaUpdateButtonLabel(job = {}) {
    if (mangaJobRunning(job)) {
      const pending = Number(job.pendingChapters || 0);
      const completed = Number(job.completedChapters || 0);
      return pending > 0 ? `更新中 ${Math.min(pending, completed + 1)}/${pending}` : "正在检查更新";
    }
    if (job.status === "failed") return "重试更新";
    if (job.status === "complete") return "再次更新";
    return "更新漫画";
  }

  function mangaDetailJobVisible(job = {}) {
    return mangaJobRunning(job) || job.status === "failed";
  }

  async function startMangaUpdate(comic = {}) {
    const mangaId = String(comic.id || "");
    if (!mangaId || mangaJobRunning(mangaUpdateJobs.get(mangaId))) return;
    const starting = { status: "starting", comicId: mangaId, title: comic.title, startedAt: new Date().toISOString(), message: "正在启动增量更新", progressPercent: 1 };
    mangaUpdateJobs.set(mangaId, starting);
    updateMangaDetailJob(mangaId, starting);
    try {
      const result = await fetchJson(getActiveUrl(), `/api/manga/${encodeURIComponent(mangaId)}/update`, {
        method: "POST",
        timeoutMs: 22000
      });
      const job = mergeMangaTaskJob(result.job || { status: "running", message: "正在检查远程目录" });
      mangaUpdateJobs.set(mangaId, job);
      updateMangaDetailJob(mangaId, job);
      if (mangaJobRunning(job)) void watchMangaUpdate(mangaId, comic);
      else if (job.status === "complete") await refreshMangaDetail(mangaId);
    } catch (error) {
      const failed = { status: "failed", message: error.message || "漫画更新启动失败" };
      mangaUpdateJobs.set(mangaId, failed);
      updateMangaDetailJob(mangaId, failed);
    }
  }

  function watchMangaUpdate(mangaId, comic = {}) {
    if (mangaUpdatePolls.has(mangaId)) return mangaUpdatePolls.get(mangaId);
    const poll = (async () => {
      while (mangaJobRunning(mangaUpdateJobs.get(mangaId))) {
        await mangaPollDelay();
        const data = await fetchJson(getActiveUrl(), `/api/manga/${encodeURIComponent(mangaId)}/update`, {
          timeoutMs: 12000
        });
        const job = mergeMangaTaskJob(data.job || { status: "idle" });
        const currentJob = job.status === "idle" ? job : rememberMangaUpdateJob({ ...job, comicId: mangaId });
        if (job.status === "idle") mangaUpdateJobs.set(mangaId, job);
        updateMangaDetailJob(mangaId, currentJob);
      }
      const job = mangaUpdateJobs.get(mangaId) || { status: "idle" };
      if (job.status === "complete") await refreshMangaDetail(mangaId);
      return job;
    })().catch((error) => {
      const failed = {
        ...(mangaUpdateJobs.get(mangaId) || {}),
        status: "failed",
        message: error.message || `《${comic.title || "漫画"}》更新状态读取失败`
      };
      mangaUpdateJobs.set(mangaId, failed);
      updateMangaDetailJob(mangaId, failed);
      return failed;
    }).finally(() => mangaUpdatePolls.delete(mangaId));
    mangaUpdatePolls.set(mangaId, poll);
    return poll;
  }

  function updateMangaDetailJob(mangaId, job = {}) {
    const panel = els.viewContent.querySelector(".manga-detail-summary");
    if (panel?.dataset.mangaId !== String(mangaId)) return;
    const updateButton = panel.querySelector("[data-manga-update]");
    if (updateButton) {
      updateButton.textContent = mangaUpdateButtonLabel(job);
      updateButton.disabled = mangaJobRunning(job);
    }
    const deleteButton = panel.querySelector("[data-manga-delete]");
    if (deleteButton) deleteButton.disabled = mangaJobRunning(job);
    const slot = panel.querySelector(".manga-job-slot");
    if (slot) {
      slot.replaceChildren();
      if (mangaDetailJobVisible(job)) slot.append(createMangaJobProgress(job));
      else if (job.status === "complete" && mangaTaskNoticeMatchesComic({ id: mangaId })) slot.append(createMangaCompletionNotice());
    }
  }

  async function refreshMangaDetail(mangaId) {
    channelPageState = null;
    const path = mangaDetailPath(mangaId);
    const data = await fetchJson(getActiveUrl(), path, { timeoutMs: 16000 });
    writeCachedJson(getActiveUrl(), path, data).catch(() => {});
    if (els.viewContent.querySelector(".manga-detail-summary")?.dataset.mangaId === String(mangaId)) {
      const finished = mangaUpdateJobs.get(mangaId) || data.update;
      renderMangaComic(data.comic, null, finished);
    } else if (els.viewContent.querySelector("[data-manga-task-manager]")) {
      await refreshMangaLibrary();
    }
  }

  async function deleteMangaComic(comic = {}) {
    const mangaId = String(comic.id || "");
    if (!mangaId || mangaJobRunning(mangaUpdateJobs.get(mangaId))) return;
    const confirmed = await requestConfirmation({
      title: "删除漫画",
      message: `确定删除《${comic.title || "这部漫画"}》吗？文件会移入可恢复的回收区。`,
      confirmLabel: "移入回收站",
      danger: true
    });
    if (!confirmed) return;
    const panel = els.viewContent.querySelector(".manga-detail-summary");
    const button = panel?.querySelector("[data-manga-delete]");
    if (button) {
      button.disabled = true;
      button.textContent = "正在删除";
    }
    try {
      await fetchJson(getActiveUrl(), `/api/manga/${encodeURIComponent(mangaId)}`, {
        method: "DELETE",
        timeoutMs: 22000
      });
      mangaUpdateJobs.delete(mangaId);
      channelPageState = null;
      goBack();
    } catch (error) {
      if (button) {
        button.disabled = false;
        button.textContent = "删除漫画";
      }
      const slot = panel?.querySelector(".manga-job-slot");
      if (slot) {
        const message = document.createElement("p");
        message.className = "manga-operation-error";
        message.textContent = error.message || "漫画删除失败";
        slot.replaceChildren(message);
      }
    }
  }

  function mangaChapterStatusLabel(status) {
    const value = String(status || "").toLowerCase();
    if (value === "done") return "已完成";
    if (value === "repaired") return "已修复";
    if (value === "partial") return "部分完成";
    if (value === "failed") return "失败";
    if (value === "pending") return "等待下载";
    return status || "";
  }

  function createMangaChapterButton(comic, chapter = {}) {
    const card = document.createElement("article");
    card.className = "manga-chapter-card";

    const button = document.createElement("button");
    button.type = "button";
    button.className = "manga-chapter-open";
    const available = Number(chapter.downloadedCount || chapter.imageCount || 0) > 0;
    button.disabled = !available;
    button.addEventListener("click", () => showMangaChapter?.(comic.id, chapter.index));

    const title = document.createElement("strong");
    title.textContent = chapter.title || `第 ${chapter.index || ""} 话`.trim();

    const meta = document.createElement("span");
    const readingProgress = readMangaReadingProgress(comic.id);
    const progressText = Number(readingProgress?.chapterIndex || 0) === Number(chapter.index || 0)
      ? `上次读到 ${formatNumber(readingProgress.pageIndex)} / ${formatNumber(readingProgress.pageTotal)} 张`
      : "";
    meta.textContent = [
      chapter.imageCount !== null && chapter.imageCount !== undefined ? `${formatNumber(chapter.imageCount)} 张` : "",
      chapter.downloadedCount !== null && chapter.downloadedCount !== undefined ? `已缓存 ${formatNumber(chapter.downloadedCount)}` : "",
      mangaChapterStatusLabel(chapter.status),
      progressText
    ].filter(Boolean).join(" · ");

    button.append(title, meta);
    card.append(button);
    if (available) {
      const download = document.createElement("a");
      download.href = absoluteUrl(getActiveUrl(), `/api/manga/${encodeURIComponent(comic.id)}/chapters/${encodeURIComponent(chapter.index)}/download`);
      download.textContent = "下载";
      download.setAttribute("aria-label", `下载${title.textContent}`);
      card.append(download);
    } else {
      const pending = document.createElement("span");
      pending.className = "manga-chapter-pending";
      pending.textContent = "等待下载";
      card.append(pending);
    }
    return card;
  }

  async function renderMangaChapter(id, chapterIndex, isActive = () => true) {
    cancelChannelRequest();
    const previousPosition = resetMangaReaderProgressTracker();
    const mangaId = String(id || "").trim();
    const index = String(chapterIndex || "").trim();
    const resumeRequest = consumeMangaResume(mangaId, index)
      || matchingMangaPosition(previousPosition, mangaId, index);
    const path = mangaChapterPath(mangaId, index);
    const activeUrl = getActiveUrl();
    let renderedCache = false;
    let renderedSignature = "";

    setActiveBottom("photo");
    els.viewKicker.textContent = "韩漫阅读";
    els.viewTitle.textContent = "章节";
    els.viewMeta.textContent = "正在读取";
    els.viewContent.replaceChildren(createMangaLoading("正在读取章节"));

    if (!mangaId || !index) {
      renderMessage("章节参数无效。", "error");
      return;
    }

    const slowTimer = window.setTimeout(() => {
      if (renderedCache || !isActive()) return;
      const detail = els.viewContent.querySelector("[data-manga-loading-detail]");
      if (detail) detail.textContent = "电脑端响应较慢，最多再等待 10 秒";
    }, 2200);

    const cached = await readCachedJson(activeUrl, path).catch(() => null);
    if (!isActive()) return;
    if (cached?.payload?.chapter) {
      renderedCache = true;
      renderedSignature = mangaRenderSignature(cached.payload.comic, cached.payload.chapter);
      renderMangaChapterData(mangaId, cached.payload, cached, resumeRequest, isActive.signal);
    }

    try {
      const data = await fetchJson(activeUrl, path, { timeoutMs: 10000, signal: isActive.signal });
      writeCachedJson(activeUrl, path, data).catch(() => {});
      if (!isActive()) return;
      const nextSignature = mangaRenderSignature(data.comic, data.chapter);
      if (!renderedCache || nextSignature !== renderedSignature) {
        renderMangaChapterData(mangaId, data, null, resumeRequest, isActive.signal);
      } else {
        const images = Array.isArray(data.chapter?.images) ? data.chapter.images : [];
        const navigation = data.chapter?.navigation || {};
        const chapterPositionText = Number(navigation.total || 0) > 0
          ? ` · 第 ${formatNumber(navigation.position)} / ${formatNumber(navigation.total)} 话`
          : "";
        if (!els.viewMeta.textContent.includes("读到")) {
          els.viewMeta.textContent = `${formatNumber(images.length || data.chapter?.imageCount || 0)} 张${chapterPositionText}`;
        }
      }
    } catch (error) {
      if (!isActive()) return;
      if (renderedCache) {
        prependMangaCacheNotice("电脑端暂时未连接，当前章节仍可继续阅读。");
      } else {
        if (resumeRequest) requestMangaResume(mangaId, index, resumeRequest.pageIndex);
        renderMangaChapterFailure(mangaId, error);
      }
    } finally {
      window.clearTimeout(slowTimer);
    }
  }

  function createMangaLoading(titleText) {
    const panel = document.createElement("div");
    panel.className = "loading-row manga-reader-loading";
    panel.setAttribute("role", "status");
    panel.setAttribute("aria-live", "polite");
    const indicator = document.createElement("i");
    indicator.setAttribute("aria-hidden", "true");
    const copy = document.createElement("div");
    const title = document.createElement("strong");
    title.textContent = titleText;
    const detail = document.createElement("span");
    detail.dataset.mangaLoadingDetail = "";
    detail.textContent = "正在连接电脑端";
    copy.append(title, detail);
    panel.append(indicator, copy);
    return panel;
  }

  function prependMangaCacheNotice(detailText) {
    if (els.viewContent.querySelector(".manga-cache-notice")) return;
    const notice = document.createElement("aside");
    notice.className = "manga-cache-notice";
    const copy = document.createElement("div");
    const title = document.createElement("strong");
    title.textContent = "正在使用手机缓存";
    const detail = document.createElement("span");
    detail.textContent = detailText;
    copy.append(title, detail);
    const retry = document.createElement("button");
    retry.type = "button";
    retry.textContent = "重新连接";
    retry.addEventListener("click", () => renderCurrentViewPreservingScroll());
    notice.append(copy, retry);
    els.viewContent.prepend(notice);
  }

  function renderMangaChapterFailure(mangaId, error) {
    els.viewMeta.textContent = "读取失败";
    els.viewContent.innerHTML = "";
    els.viewContent.append(createMangaFailurePanel({
      title: "章节暂时打不开",
      message: mangaChapterFailureMessage(error),
      primaryLabel: "重新读取",
      primaryAction: () => renderCurrentView(),
      secondaryLabel: "返回目录",
      secondaryAction: () => showMangaCatalog?.(mangaId)
    }));
  }

  function createMangaFailurePanel(options = {}) {
    const panel = document.createElement("section");
    panel.className = "manga-connection-failure";
    const mark = document.createElement("span");
    mark.className = "manga-connection-failure-mark";
    mark.textContent = "!";
    mark.setAttribute("aria-hidden", "true");
    const title = document.createElement("strong");
    title.textContent = options.title || "内容暂时打不开";
    const detail = document.createElement("p");
    detail.textContent = options.message || "电脑端暂时没有返回内容。";
    const actions = document.createElement("div");
    actions.className = "manga-connection-failure-actions";
    const retry = document.createElement("button");
    retry.type = "button";
    retry.textContent = options.primaryLabel || "重新读取";
    retry.addEventListener("click", () => options.primaryAction?.());
    actions.append(retry);
    if (options.secondaryLabel && options.secondaryAction) {
      const secondary = document.createElement("button");
      secondary.type = "button";
      secondary.textContent = options.secondaryLabel;
      secondary.addEventListener("click", () => options.secondaryAction());
      actions.append(secondary);
    } else {
      actions.classList.add("single");
    }
    panel.append(mark, title, detail, actions);
    return panel;
  }

  function mangaChapterFailureMessage(error) {
    const status = Number(error?.status || error?.statusCode || 0);
    if (status === 404) return "本话尚未下载完成，或本地章节文件已经移除。";
    return mangaConnectionFailureMessage(error, "电脑端没有返回章节内容，请稍后重新读取。");
  }

  function mangaConnectionFailureMessage(error, fallback) {
    const message = String(error?.message || "");
    if (/超时|failed to fetch|network|load failed|fetch failed/i.test(message)) {
      return "无法连接电脑端，请确认后台已启动，并保持手机与电脑的连接。";
    }
    return message || fallback;
  }

  function matchingMangaPosition(position, mangaId, chapterIndex) {
    return position?.mangaId === mangaId && Number(position.chapterIndex) === Number(chapterIndex) ? position : null;
  }

  function renderMangaChapterData(mangaId, data = {}, cacheEntry = null, requestedPosition = null, signal = null) {
    const previousPosition = resetMangaReaderProgressTracker();
    const comic = data.comic || {};
    const chapter = data.chapter || {};
    const images = Array.isArray(chapter.images) ? chapter.images : [];
    const navigation = chapter.navigation || {};
    const position = matchingMangaPosition(previousPosition, mangaId, chapter.index) || requestedPosition;
    const resumeRequest = position ? {
      ...position,
      pageIndex: Math.min(images.length || 1, Math.max(1, Math.floor(Number(position.pageIndex) || 1)))
    } : null;
    const requiredLimit = resumeRequest?.pageIndex || 1;
    // Slow connections increase the window in small steps; include the target now.
    while (getMangaImageLimit() < requiredLimit) {
      const before = getMangaImageLimit();
      increaseMangaImageLimit(requiredLimit - before);
      if (getMangaImageLimit() <= before) break;
    }
    const visible = images.slice(0, Math.max(getMangaImageLimit(), requiredLimit));
    const suffix = cacheEntry ? ` · 缓存 ${cacheAgeText(cacheEntry.updatedAt)}` : "";
    const chapterPositionText = Number(navigation.total || 0) > 0
      ? ` · 第 ${formatNumber(navigation.position)} / ${formatNumber(navigation.total)} 话`
      : "";

    els.viewKicker.textContent = comic.title || "韩漫阅读";
    els.viewTitle.textContent = chapter.title || `第 ${chapter.index || ""} 话`.trim();
    els.viewMeta.textContent = `${formatNumber(images.length || chapter.imageCount || 0)} 张${chapterPositionText}${suffix}`;
    els.viewContent.innerHTML = "";
    recordMangaChapterRecent(mangaId, comic, chapter);
    els.viewContent.append(createMangaChapterNavigation(mangaId, navigation, { chapterIndex: chapter.index }));

    if (!visible.length) {
      renderMessage("这一话暂时没有图片。", "quiet", false);
      return;
    }

    const list = document.createElement("div");
    list.className = "manga-reader-list";
    const viewerItems = images
      .map((image) => ({
        url: absoluteUrl(getActiveUrl(), image.url),
        title: image.name || `${chapter.title || "章节"} ${image.index || ""}`.trim()
      }))
      .filter((item) => item.url);
    visible.forEach((image, position) => list.append(createMangaPage(mangaId, chapter, image, viewerItems, { position: position + 1 })));
    const progress = createMangaReaderProgress(mangaId, comic, chapter, images, navigation, list, {
      suppressResume: Boolean(resumeRequest)
    });
    els.viewContent.append(progress, list);

    let visibleCount = visible.length;
    const makeLoadMore = () => {
      const trigger = createLoadMoreButton(`向下滑动继续显示 ${formatNumber(visibleCount)} / ${formatNumber(images.length)}`, () => {
        increaseMangaImageLimit(12);
        const nextLimit = Math.min(images.length, Math.max(visibleCount + 12, getMangaImageLimit()));
        const nextPages = images.slice(visibleCount, nextLimit).map((image, offset) =>
          createMangaPage(mangaId, chapter, image, viewerItems, { position: visibleCount + offset + 1 }));
        list.append(...nextPages);
        tracker.observePages(nextPages);
        visibleCount = nextLimit;
        if (visibleCount < images.length) trigger.replaceWith(makeLoadMore());
        else trigger.remove();
      });
      return trigger;
    };
    if (visible.length < images.length) {
      els.viewContent.append(makeLoadMore());
    }
    els.viewContent.append(createMangaChapterNavigation(mangaId, navigation, {
      bottom: true,
      chapterIndex: chapter.index
    }));
    const tracker = bindMangaReaderProgress(mangaId, comic, chapter, images, navigation, list, progress, { resumeRequest, signal });
    restoreRequestedMangaPage(resumeRequest, list, tracker);
  }

  function createMangaChapterNavigation(mangaId, navigation = {}, options = {}) {
    const row = document.createElement("nav");
    row.className = `manga-chapter-navigation${options.bottom ? " is-bottom" : ""}`;
    row.setAttribute("aria-label", options.bottom ? "章节末尾导航" : "章节导航");

    const previous = document.createElement("button");
    previous.type = "button";
    previous.textContent = "上一话";
    previous.disabled = !navigation.previous?.index;
    if (navigation.previous?.index) {
      previous.setAttribute("aria-label", `上一话：${navigation.previous.title || navigation.previous.index}`);
      previous.addEventListener("click", () => showMangaChapter?.(mangaId, navigation.previous.index, { replace: true }));
    }

    const catalog = document.createElement("button");
    catalog.type = "button";
    catalog.className = "manga-chapter-position";
    catalog.textContent = Number(navigation.total || 0) > 0
      ? `目录 ${formatNumber(navigation.position)}/${formatNumber(navigation.total)}`
      : "目录";
    catalog.setAttribute("aria-label", "返回章节目录");
    catalog.addEventListener("click", () => showMangaCatalog?.(mangaId));

    const download = document.createElement("a");
    download.className = "manga-chapter-download";
    download.href = absoluteUrl(getActiveUrl(), `/api/manga/${encodeURIComponent(mangaId)}/chapters/${encodeURIComponent(options.chapterIndex || "")}/download`);
    download.textContent = "下载";
    download.setAttribute("aria-label", "下载本话");

    const next = document.createElement("button");
    next.type = "button";
    next.textContent = "下一话";
    next.disabled = !navigation.next?.index;
    if (navigation.next?.index) {
      next.setAttribute("aria-label", `下一话：${navigation.next.title || navigation.next.index}`);
      next.addEventListener("click", () => showMangaChapter?.(mangaId, navigation.next.index, { replace: true }));
    }

    row.append(previous, catalog, download, next);
    return row;
  }

  function createMangaReaderProgress(mangaId, comic = {}, chapter = {}, images = [], navigation = {}, list, options = {}) {
    const progress = document.createElement("div");
    progress.className = "manga-reader-progress";
    const copy = document.createElement("div");
    const current = document.createElement("strong");
    current.dataset.mangaProgressCurrent = "";
    current.textContent = `第 1 / ${formatNumber(images.length || chapter.imageCount || 0)} 张`;
    const chapterCopy = document.createElement("span");
    chapterCopy.textContent = Number(navigation.total || 0) > 0
      ? `第 ${formatNumber(navigation.position)} / ${formatNumber(navigation.total)} 话`
      : (chapter.title || "本话");
    copy.append(current, chapterCopy);

    const track = document.createElement("div");
    track.className = "manga-reader-progress-track";
    track.setAttribute("role", "progressbar");
    track.setAttribute("aria-label", "本话阅读进度");
    track.setAttribute("aria-valuemin", "1");
    track.setAttribute("aria-valuemax", String(Math.max(1, images.length || chapter.imageCount || 1)));
    track.setAttribute("aria-valuenow", "1");
    const fill = document.createElement("i");
    fill.dataset.mangaProgressFill = "";
    fill.style.width = `${images.length ? 100 / images.length : 0}%`;
    track.append(fill);
    progress.append(copy, track);

    const saved = readMangaReadingProgress(mangaId);
    if (!options.suppressResume && Number(saved?.chapterIndex || 0) === Number(chapter.index || 0) && Number(saved?.pageIndex || 0) > 1) {
      const resume = document.createElement("button");
      resume.type = "button";
      resume.className = "manga-reader-resume";
      resume.textContent = `回到第 ${formatNumber(saved.pageIndex)} 张`;
      resume.addEventListener("click", () => {
        requestMangaResume(mangaId, chapter.index, saved.pageIndex);
        renderCurrentView();
      });
      progress.append(resume);
    }
    return progress;
  }

  function bindMangaReaderProgress(mangaId, comic = {}, chapter = {}, images = [], navigation = {}, list, progress, options = {}) {
    resetMangaReaderProgressTracker();
    const pages = [...(list?.querySelectorAll(".manga-reader-page") || [])];
    if (!pages.length) return;
    const total = Math.max(1, Number(images.length || chapter.imageCount || pages.length));
    let activePage = 0;
    let recordedPage = 0;
    let pendingProgress = null;
    let timer = 0;
    let observer = null;
    let disposed = false;
    let restoring = Boolean(options.resumeRequest);
    let restoreCleanup = () => {};
    const visiblePages = new Map();

    const flush = () => {
      window.clearTimeout(timer);
      timer = 0;
      if (!pendingProgress) return;
      const readingProgress = pendingProgress;
      pendingProgress = null;
      writeMangaReadingProgress(mangaId, readingProgress);
      recordRecentContent({
        ...mangaChapterContentItem(mangaId, comic, chapter),
        meta: `第 ${formatNumber(navigation.position || chapter.index)} 话 · 读到 ${formatNumber(readingProgress.pageIndex)} / ${formatNumber(total)} 张`
      });
    };

    const update = (pageIndex, persist = true) => {
      if (disposed || !list.isConnected) return;
      const current = Math.min(total, Math.max(1, Number(pageIndex || 1)));
      if (current === activePage && persist && recordedPage === current) return;
      activePage = current;
      const label = progress?.querySelector("[data-manga-progress-current]");
      const fill = progress?.querySelector("[data-manga-progress-fill]");
      const track = fill?.parentElement;
      if (label) label.textContent = `第 ${formatNumber(current)} / ${formatNumber(total)} 张`;
      if (fill) fill.style.width = `${Math.min(100, (current / total) * 100)}%`;
      track?.setAttribute("aria-valuenow", String(current));
      const chapterText = Number(navigation.total || 0) > 0
        ? ` · 第 ${formatNumber(navigation.position)} / ${formatNumber(navigation.total)} 话`
        : "";
      els.viewMeta.textContent = `${formatNumber(total)} 张 · 读到第 ${formatNumber(current)} 张${chapterText}`;
      if (!persist) return;
      recordedPage = current;
      pendingProgress = {
        chapterIndex: chapter.index,
        chapterTitle: chapter.title,
        chapterPosition: navigation.position,
        chapterTotal: navigation.total,
        pageIndex: current,
        pageTotal: total
      };
      window.clearTimeout(timer);
      timer = window.setTimeout(flush, 420);
    };

    const onHidden = () => {
      if (document.visibilityState === "hidden") onPageHide();
    };
    const onPageHide = () => { restoreCleanup(); flush(); };
    const onAbort = () => {
      if (mangaReaderProgressTracker === tracker) resetMangaReaderProgressTracker();
    };
    const tracker = {
      update,
      observePages: (nextPages) => {
        if (disposed) return;
        pages.push(...nextPages);
        nextPages.forEach((page) => observer?.observe(page));
      },
      setRestoring: (value) => { restoring = value; },
      setRestoreCleanup: (cleanup) => { restoreCleanup(); restoreCleanup = cleanup; },
      snapshot: () => ({
        mangaId, chapterIndex: chapter.index, pageIndex: activePage || 1,
        offset: !restoring && pages[activePage - 1]?.isConnected
          ? pages[activePage - 1].getBoundingClientRect().top
          : Number(options.resumeRequest?.offset ?? 60)
      }),
      dispose: () => {
        restoreCleanup();
        flush();
        disposed = true;
        observer?.disconnect();
        document.removeEventListener("visibilitychange", onHidden);
        window.removeEventListener("pagehide", onPageHide);
        options.signal?.removeEventListener("abort", onAbort);
      }
    };
    mangaReaderProgressTracker = tracker;
    document.addEventListener("visibilitychange", onHidden);
    window.addEventListener("pagehide", onPageHide);
    options.signal?.addEventListener("abort", onAbort, { once: true });

    update(options.resumeRequest?.pageIndex || 1, false);
    if ("IntersectionObserver" in window) {
      observer = new IntersectionObserver((entries) => {
        if (disposed || !list.isConnected) return;
        for (const entry of entries) {
          if (entry.isIntersecting) visiblePages.set(entry.target, entry);
          else visiblePages.delete(entry.target);
        }
        if (restoring || !visiblePages.size) return;
        const best = [...visiblePages.values()].sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0];
        update(Number(best.target.dataset.mangaPagePosition || 1));
      }, {
        root: null,
        rootMargin: "-38% 0px -46% 0px",
        threshold: [0, 0.01, 0.25, 0.6]
      });
      pages.forEach((page) => observer.observe(page));
    } else update(activePage);
    return tracker;
  }

  function restoreRequestedMangaPage(request, list, tracker) {
    if (!request || !tracker) return;
    const target = list?.querySelector(`[data-manga-page-position="${Number(request.pageIndex)}"]`);
    if (!target) return;
    let frame = 0;
    let stopped = false;
    let resizeObserver = null;
    const offset = Number.isFinite(Number(request.offset)) ? Number(request.offset) : 60;
    const align = () => {
      frame = 0;
      if (stopped || !target.isConnected) return;
      const distance = target.getBoundingClientRect().top - offset;
      if (Math.abs(distance) > 1) window.scrollBy({ top: distance, behavior: "instant" });
    };
    const schedule = () => {
      if (!stopped && !frame) frame = window.requestAnimationFrame(align);
    };
    const onKey = (event) => {
      if (["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "].includes(event.key)) stop();
    };
    const stop = () => {
      if (stopped) return;
      stopped = true;
      window.cancelAnimationFrame(frame);
      window.clearTimeout(timeout);
      resizeObserver?.disconnect();
      list.removeEventListener("load", schedule, true);
      list.removeEventListener("error", schedule, true);
      window.removeEventListener("wheel", stop);
      window.removeEventListener("touchstart", stop);
      window.removeEventListener("pointerdown", stop);
      window.removeEventListener("keydown", onKey);
      tracker.setRestoring(false);
    };
    const timeout = window.setTimeout(stop, 10_000);
    tracker.setRestoreCleanup(stop);
    tracker.setRestoring(true);
    tracker.update(request.pageIndex);
    // Keep the anchor stable as slow images expand, but never fight user scrolling.
    list.addEventListener("load", schedule, true);
    list.addEventListener("error", schedule, true);
    window.addEventListener("wheel", stop, { passive: true });
    window.addEventListener("touchstart", stop, { passive: true });
    window.addEventListener("pointerdown", stop, { passive: true });
    window.addEventListener("keydown", onKey);
    if ("ResizeObserver" in window) {
      resizeObserver = new ResizeObserver(schedule);
      resizeObserver.observe(els.viewContent);
    }
    schedule();
  }

  function resetMangaReaderProgressTracker() {
    const tracker = mangaReaderProgressTracker;
    const position = tracker?.snapshot() || null;
    mangaReaderProgressTracker = null;
    tracker?.dispose();
    return position;
  }

  function createMangaPage(mangaId, chapter = {}, image = {}, viewerItems = [], options = {}) {
    const imageUrl = absoluteUrl(getActiveUrl(), image.url);
    const page = document.createElement("div");
    page.className = "manga-reader-page";
    page.dataset.mangaPagePosition = String(Math.max(1, Number(options.position || image.index || 1)));

    const fallback = document.createElement("span");
    fallback.textContent = formatNumber(image.index || 0);
    page.append(fallback);

    if (imageUrl) {
      const img = document.createElement("img");
      img.alt = image.name || `${chapter.title || "章节"} ${image.index || ""}`.trim();
      if (Number(image.width || 0) > 0 && Number(image.height || 0) > 0) {
        img.width = Number(image.width);
        img.height = Number(image.height);
      }
      img.loading = Number(image.index || 0) <= 2 ? "eager" : "lazy";
      if (img.loading === "eager") img.fetchPriority = "high";
      img.decoding = "async";
      img.referrerPolicy = "no-referrer";
      img.src = imageUrl;
      page.append(img);
    }

    return page;
  }

  function mangaDetailPath(id) {
    return `/api/manga/${encodeURIComponent(String(id || ""))}`;
  }

  function mangaChapterPath(id, chapterIndex) {
    return `/api/manga/${encodeURIComponent(String(id || ""))}/chapters/${encodeURIComponent(String(chapterIndex || ""))}`;
  }

  function photoContentItem(album = {}) {
    return {
      view: "photoDetail",
      params: { id: album.id },
      type: "photo",
      label: "套图",
      title: album.title || album.personName || "套图详情",
      subtitle: [album.category, album.personName].filter(Boolean).join(" · "),
      meta: [
        album.imageCount !== null && album.imageCount !== undefined ? `${formatNumber(album.imageCount)} 张` : "",
        formatBytes(album.size)
      ].filter(Boolean).join(" · "),
      coverUrl: album.coverUrl || album.images?.[0]?.url || "",
      fallback: album.title || album.personName || "套图"
    };
  }

  function recordPhotoRecent(album = {}) {
    if (!album.id) return;
    recordRecentContent(photoContentItem(album));
  }

  function mangaContentItem(comic = {}) {
    return {
      view: "mangaDetail",
      params: { id: comic.id },
      type: "manga",
      label: "韩漫",
      title: comic.title || "漫画详情",
      subtitle: [comic.site, comic.category].filter(Boolean).join(" · "),
      meta: [
        comic.chapterCount !== null && comic.chapterCount !== undefined ? `${formatNumber(comic.chapterCount)} 话` : "",
        comic.imageCount !== null && comic.imageCount !== undefined ? `${formatNumber(comic.imageCount)} 张` : ""
      ].filter(Boolean).join(" · "),
      coverUrl: comic.coverUrl || "",
      fallback: comic.title || "韩漫"
    };
  }

  function recordMangaRecent(comic = {}) {
    if (!comic.id) return;
    recordRecentContent(mangaContentItem(comic));
  }

  function mangaChapterContentItem(mangaId, comic = {}, chapter = {}) {
    return {
      view: "mangaChapter",
      params: { id: mangaId, chapterIndex: chapter.index },
      type: "manga",
      label: "韩漫阅读",
      title: comic.title || chapter.title || "漫画章节",
      subtitle: chapter.title || "",
      meta: chapter.imageCount !== null && chapter.imageCount !== undefined ? `${formatNumber(chapter.imageCount)} 张` : "",
      coverUrl: chapter.coverUrl || chapter.images?.[0]?.url || comic.coverUrl || "",
      fallback: comic.title || chapter.title || "韩漫"
    };
  }

  function recordMangaChapterRecent(mangaId, comic = {}, chapter = {}) {
    if (!mangaId || !chapter.index) return;
    recordRecentContent(mangaChapterContentItem(mangaId, comic, chapter));
  }

  function mediaContentItem(item = {}, channel = CHANNELS.movie, mode = "movie") {
    return {
      view: "mediaDetail",
      params: { id: item.id, mode },
      type: mode,
      label: channel.label,
      title: mediaDisplayTitle(item, channel),
      subtitle: [item.seriesName, item.category].filter(Boolean).join(" · "),
      meta: [item.ext ? item.ext.toUpperCase() : "", formatBytes(item.size)].filter(Boolean).join(" · "),
      coverUrl: item.coverUrl || "",
      fallback: mediaDisplayTitle(item, channel)
    };
  }

  function recordMediaRecent(item = {}, channel = CHANNELS.movie, mode = "movie") {
    if (!item.id) return;
    recordRecentContent(mediaContentItem(item, channel, mode));
  }

  return {
    deactivate: () => { cancelChannelRequest(); resetPreviewImageObserver(); resetMangaReaderProgressTracker(); },
    renderChannel,
    renderPhotoDetail,
    renderMangaDetail,
    renderMangaChapter,
    renderMediaDetail,
    channelLabel: (mode) => channelConfig(mode).label
  };
}







