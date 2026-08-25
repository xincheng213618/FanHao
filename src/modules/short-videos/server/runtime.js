import { createShortVideoStore } from "./store.js";
import { routeShortVideoAuthorCleanup } from "./author-cleanup-route.js";
import { routeShortVideoApi } from "./routes.js";
import { createShortVideoCatalogWorkerClient } from "./catalog-worker-client.js";
import { createShortVideoListStatsService } from "./list-stats-service.js";
import { createShortVideoSmoothWarmupWorkerClient } from "./smooth-warmup-worker-client.js";
import { createShortVideoWatchWriteService } from "./watch-write-service.js";
import { createDownloadManagerSyncService } from "./download-manager-sync-service.js";
import { routeShortVideoLocalActionApi } from "./local-action-routes.js";
import { createShortVideoLocalActions } from "./local-actions.js";
import { decodeShortVideoDetailSegment, SHORT_VIDEO_RESERVED_DETAIL_SEGMENTS } from "./reserved-routes.js";
import { sendShortVideoPublicError } from "./public-errors.js";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";

// Chromium can pause for more than a second before retrying when an initial
// open-ended media request is truncated before the first GOP is decodable.
// Give only the first response two megabytes, then return to one-megabyte
// chunks so rapid swipes still keep transient reads bounded.
const SHORT_VIDEO_STREAM_CHUNK_BYTES = 1 * 1024 * 1024;
const SHORT_VIDEO_INITIAL_STREAM_CHUNK_BYTES = 2 * 1024 * 1024;
const SHORT_VIDEO_STARTUP_CACHE_BYTES = 2 * 1024 * 1024;
const SHORT_VIDEO_STARTUP_CACHE_CANDIDATES = 3;
const SHORT_VIDEO_STARTUP_CACHE_DELAY_MS = 240;
const SHORT_VIDEO_SMOOTH_CACHE_CANDIDATES = 3;
const SHORT_VIDEO_SMOOTH_CONCURRENCY = 2;
const SHORT_VIDEO_SMOOTH_MAX_CONCURRENCY = 4;
const SHORT_VIDEO_SMOOTH_CACHE_BACKLOG_LIMIT = 512;
const SHORT_VIDEO_SMOOTH_CACHE_PAGE_SIZE = 256;
const SHORT_VIDEO_SMOOTH_CACHE_REFILL_LOW_WATERMARK = 256;
const SHORT_VIDEO_SMOOTH_CANDIDATES_PER_TURN = 32;
const SHORT_VIDEO_SMOOTH_WARMUP_DELAY_MS = 1500;
const SHORT_VIDEO_SMOOTH_CACHE_DELAY_MS = 8000;
const SHORT_VIDEO_SMOOTH_CURRENT_DELAY_MS = 1200;
const SHORT_VIDEO_SMOOTH_ON_DEMAND_WAIT_MS = 2800;
const SHORT_VIDEO_SMOOTH_ON_DEMAND_POLL_MS = 25;
const SHORT_VIDEO_SMOOTH_FPS = 30;
const SHORT_VIDEO_SMOOTH_MAX_EDGE = 2560;
const SHORT_VIDEO_SMOOTH_RENDITION_VERSION = 2;
const SHORT_VIDEO_SMOOTH_MIN_LONG_EDGE = 2160;
const SHORT_VIDEO_LIST_CACHE_FRESH_MS = 2 * 60 * 1000;
const SHORT_VIDEO_LIST_CACHE_SCHEMA = "aggregate-search-v5-action-baselines";
const SHORT_VIDEO_LIST_STABLE_QUERY_ATTEMPTS = 3;
const SHORT_VIDEO_SMOOTH_RECENT_JOB_LIMIT = 12;
const STORE_MEDIA_DELETE_METHODS = new Set(["cleanupAuthorUnliked", "deleteVideo", "deleteVideoGroup", "deleteVideos"]);

export function createShortVideosRuntime({
  dbPath,
  ffmpegPath,
  ffprobePath = "ffprobe",
  hasNvenc = false,
  roots,
  downloadManagerDbPath,
  downloadManagerUrl,
  downloadManagerSyncMs,
  mediaResponseService,
  mediaStreamService,
  notFound,
  readJsonBody,
  requireLocalAdmin,
  sendJson,
  serveDownloadFile = null,
  sharedCache,
  catalogWorkerOptions = {},
  smoothWarmupWorkerOptions = {},
  watchWriterOptions = {},
  runtimeTestHooks = {},
  listQuery = null,
  schemaBusyTimeoutMs = 10000,
  autoSmoothWarmup = false,
  getTranscodeConcurrency = () => SHORT_VIDEO_SMOOTH_CONCURRENCY,
  setTranscodeConcurrency = null
}) {
  // Complete versioned schema writes before the read-only catalog worker can
  // observe the database. The store is closed immediately after this preflight.
  const store = createShortVideoStore({
    dbPath,
    downloadManagerDbPath,
    ffmpegPath,
    roots,
    deferDeleteCleanup: true,
    skipStartupMaintenance: true,
    busyTimeoutMs: schemaBusyTimeoutMs,
    deleteJobTestHooks: runtimeTestHooks.deleteJobTestHooks
  });
  const localActions = createShortVideoLocalActions({
    roots,
    getVideoFile: (...args) => store.videoFile(...args),
    openTarget: runtimeTestHooks.openLocalTarget
  });
  let catalogSchemaPrepared = false;
  try {
    store.prepareSchema();
    catalogSchemaPrepared = true;
  } catch {
    // Preserve the route's lazy, sanitized 503 boundary for corrupt or
    // unavailable databases. A readable legacy schema still cannot reach the
    // worker: its read-only store rejects every non-current schema version,
    // and the version is written only after ensureSchema completes.
  } finally {
    store.close();
  }
  const catalogWorker = createShortVideoCatalogWorkerClient({
    ...catalogWorkerOptions,
    dbPath,
    downloadManagerDbPath,
    ffmpegPath,
    roots
  });
  const routeStore = new Proxy(store, {
    get(target, property, receiver) {
      if (property === "likeDistribution") {
        return async (options = {}) => catalogWorker.queryLikeDistribution({
          catalogStamp: await likeDistributionRuntimeStamp(),
          signal: options.signal
        });
      }
      if (STORE_MEDIA_DELETE_METHODS.has(property)) {
        const method = Reflect.get(target, property, receiver);
        return (...args) => {
          stopSmoothVideoQueue({ pause: false });
          return Reflect.apply(method, target, args);
        };
      }
      return Reflect.get(target, property, receiver);
    }
  });
  const ensureCatalogSchema = () => {
    if (catalogSchemaPrepared) return;
    try {
      store.prepareSchema();
    } finally {
      store.close();
    }
    catalogSchemaPrepared = true;
    catalogWorker.reset();
  };
  const listStatsService = createShortVideoListStatsService({ store, catalogWorker, ensureCatalogSchema });
  const smoothWarmupWorker = createShortVideoSmoothWarmupWorkerClient({
    ...smoothWarmupWorkerOptions,
    dbPath,
    downloadManagerDbPath,
    ffmpegPath,
    roots
  });
  const watchWriter = createShortVideoWatchWriteService({
    ...watchWriterOptions,
    dbPath,
    downloadManagerDbPath,
    ffmpegPath,
    roots
  });
  const downloadManagerSync = createDownloadManagerSyncService({
    sourceDbPath: downloadManagerDbPath,
    intervalMs: downloadManagerSyncMs,
    dbPath,
    ffmpegPath,
    roots,
    initialStateKey: () => store.downloadManagerSourceStateKey(),
    onStateKey: (stateKey) => store.downloadManagerSourceStateKey(stateKey),
    onCatalogChanged: () => clearShortVideoListCache(),
    onItemsImported: (result) => {
      console.log(`[short-video-sync] imported=${result.imported} updated=${result.updated} backfill=${result.backfillRows || 0} total=${result.summary?.totals?.videos ?? ""}`);
      if (autoSmoothWarmup) schedule4kSmoothVideoWarmup(250);
    }
  });
  const syncedCollectorJobs = new Set();
  const videoCacheQueue = [];
  const videoCacheJobs = new Map();
  let videoCacheTimer = null;
  let videoCacheActive = false;
  const smoothVideoQueue = [];
  const smoothVideoJobs = new Map();
  const smoothVideoCandidateBacklog = [];
  const smoothVideoCandidateIds = new Set();
  const smoothVideoResolvedVersions = new Map();
  const smoothVideoRenditionVersions = new Map();
  let smoothVideoCandidateScanOffset = 0;
  let smoothVideoCandidateScanComplete = true;
  let smoothVideoCandidateRefill = null;
  let smoothVideoCandidateFillImmediate = null;
  let smoothVideoWarmupGeneration = 0;
  let smoothVideoTimer = null;
  const smoothVideoActiveJobs = new Map();
  const smoothVideoChildren = new Map();
  let smoothVideoPausedByUser = false;
  const smoothVideoRecentJobs = [];
  let smoothVideoWarmupTimer = null;
  let runtimeStarted = false;
  let runtimeDesiredStarted = false;
  let runtimeLifecycleGeneration = 0;
  let runtimeStartPromise = null;
  let runtimeStopPromise = null;
  let lastSmoothVideoWarmupAt = 0;
  let lastSmoothVideoWarmupCandidates = 0;
  let lastSmoothVideoWarmupDurationMs = 0;
  let lastSmoothVideoCacheIndexEntries = 0;
  let smoothVideoCacheEntryNames = new Set();
  const listCacheRefreshJobs = new Map();
  let shortVideoListCacheGeneration = readShortVideoListCacheGeneration();
  const initialWatchCacheState = readShortVideoWatchCacheState();
  let shortVideoWatchCacheGeneration = initialWatchCacheState.generation;
  const shortVideoWatchOverlays = new Map(initialWatchCacheState.entries.map((entry) => [entry.id, entry]));
  let shortVideoWatchCachePersistTimer = null;

  async function routeApi(req, res, url) {
    if (await routeShortVideoLocalActionApi(req, res, url, {
      localActions,
      readJsonBody,
      requireLocalAdmin,
      sendJson
    })) return true;
    if (await routeShortVideoAuthorCleanup({
      req, res, url, store: routeStore, readJsonBody, requireLocalAdmin, sendJson,
      downloadManagerRequest,
      onMutation: clearShortVideoListCache
    })) return true;
    if (url.pathname === "/api/short-videos/playback-cache-status" && req.method === "GET") {
      sendJson(res, 200, shortVideoPlaybackCacheStatus());
      return true;
    }
    if (url.pathname === "/api/short-videos/playback-cache-control" && req.method === "POST") {
      if (!requireLocalAdmin(req, res)) return true;
      try {
        const body = await readJsonBody(req);
        const action = String(body?.action || "").trim().toLowerCase();
        if (!['pause', 'resume', 'set-concurrency'].includes(action)) {
          sendJson(res, 400, { error: "转码控制操作必须是 pause、resume 或 set-concurrency" });
          return true;
        }
        if (action === "set-concurrency") {
          const concurrency = normalizeSmoothVideoConcurrency(body?.concurrency);
          if (typeof setTranscodeConcurrency === "function") setTranscodeConcurrency(concurrency);
          fillSmoothVideoCandidateQueue();
          sortAndScheduleSmoothVideoQueue();
        } else {
          setSmoothVideoPausedByUser(action === "pause");
        }
        sendJson(res, 200, { ok: true, action, status: shortVideoPlaybackCacheStatus() });
      } catch (error) {
        sendShortVideoPublicError(res, sendJson, error, "转码控制失败");
      }
      return true;
    }
    if (url.pathname === "/api/short-videos/playback-issues" && req.method === "POST") {
      if (!requireLocalAdmin(req, res)) return true;
      try {
        const body = await readJsonBody(req);
        const id = String(body?.id || "").trim();
        const reason = String(body?.reason || "playback-stalled").trim().slice(0, 80);
        if (!id || !store.reportSmoothPlaybackIssue(id, reason)) {
          sendJson(res, 404, { error: "没有找到可记录的本地视频" });
          return true;
        }
        const queued = tryQueueSmoothVideoCache(id, { delayMs: 0, kind: "current" });
        schedule4kSmoothVideoWarmup(0);
        sendJson(res, 200, { ok: true, id, reason, queued, status: shortVideoPlaybackCacheStatus() });
      } catch (error) {
        sendShortVideoPublicError(res, sendJson, error, "播放问题记录失败");
      }
      return true;
    }
    if (url.pathname === "/api/short-videos/playback-cache-cleanup" && req.method === "POST") {
      if (!requireLocalAdmin(req, res)) return true;
      if (smoothVideoActiveJobs.size) {
        sendJson(res, 409, { error: "请先停止转码并等待任务退出，再清除转码缓存" });
        return true;
      }
      try {
        const removed = clearSmoothVideoRenditionCache();
        sendJson(res, 200, { ok: true, removed, status: shortVideoPlaybackCacheStatus() });
      } catch (error) {
        sendShortVideoPublicError(res, sendJson, error, "转码缓存清除失败");
      }
      return true;
    }
    const workerCatalogRead = req.method === "GET"
      ? {
          "/api/short-videos/authors": "authors",
          "/api/short-videos/facets": "facets"
        }[url.pathname]
      : "";
    if (workerCatalogRead) {
      try {
        const data = await catalogWorker.query(url, workerCatalogRead);
        sendJson(res, 200, data);
        return true;
      } catch (error) {
        console.warn("[short-video-catalog-worker-fallback]", error.message || error);
      }
    }
    const collectorMatch = /^\/api\/short-videos\/authors\/([^/]+)\/collector$/.exec(url.pathname);
    if (collectorMatch && req.method === "GET") {
      try {
        const secUid = decodeURIComponent(collectorMatch[1]);
        const state = await downloadManagerRequest("/api/state");
        const jobId = Number(url.searchParams.get("jobId") || 0);
        const data = collectorStatus(state, secUid, jobId);
        if (jobId && ["complete", "failed", "stopped"].includes(data.job?.status) && !syncedCollectorJobs.has(jobId)) {
          syncedCollectorJobs.add(jobId);
          data.sync = await downloadManagerSync.sync({ force: true }) || null;
        }
        sendJson(res, 200, data);
      } catch (error) {
        sendShortVideoPublicError(res, sendJson, error, "8765 采集服务不可用", { defaultStatus: 502 });
      }
      return true;
    }

    if (collectorMatch && req.method === "POST") {
      if (!requireLocalAdmin(req, res)) return true;
      try {
        const secUid = decodeURIComponent(collectorMatch[1]);
        const body = await readJsonBody(req);
        const mode = String(body?.mode || "quick").trim().toLowerCase() === "full" ? "full" : "quick";
        const state = await downloadManagerRequest("/api/state");
        const profile = collectorProfile(state, secUid);
        const settings = state?.settings || {};
        const collectorOptions = {
          max: 0,
          scrolls: mode === "full" ? Number(settings.scrolls || 12000) : 120,
          idle_rounds: mode === "full" ? Number(settings.idle_rounds || 160) : 16,
          incremental_stop_existing: mode === "full" ? 0 : 6,
          full_scan: mode === "full"
        };
        const result = await downloadManagerRequest(profile ? "/api/profiles/refresh" : "/api/extract/start", {
          method: "POST",
          body: profile
            ? { max_profiles: 0, profile_ids: [Number(profile.id)], since_date: "", ...collectorOptions }
            : {
                url: `https://www.douyin.com/user/${encodeURIComponent(secUid)}`,
                profile_tab: "post",
                ...collectorOptions
              }
        });
        if (result?.ok === false) {
          const error = new Error(result.message || "8765 采集任务启动失败");
          error.statusCode = 409;
          throw error;
        }
        sendJson(res, 202, {
          ok: true,
          mode,
          jobId: Number(result?.job_id || 0),
          profile: publicCollectorProfile(profile || { sec_uid: secUid, tab: "post" })
        });
      } catch (error) {
        sendShortVideoPublicError(res, sendJson, error, "作者主页采集启动失败", { defaultStatus: 502 });
      }
      return true;
    }

    const commentSyncMatch = /^\/api\/short-videos\/([^/]+)\/comments\/sync$/.exec(url.pathname);
    if (commentSyncMatch && req.method === "POST") {
      if (!requireLocalAdmin(req, res)) return true;
      try {
        const videoId = decodeURIComponent(commentSyncMatch[1]);
        const detail = store.videoDetail(videoId);
        const awemeId = String(detail?.video?.awemeId || detail?.video?.id || "").trim();
        if (!awemeId) {
          const error = new Error("当前作品没有抖音作品 ID");
          error.statusCode = 404;
          throw error;
        }
        const body = await readJsonBody(req);
        const result = await downloadManagerRequest("/api/comments/fetch", {
          method: "POST",
          body: {
            aweme_id: awemeId,
            max_comments: Math.min(200, Math.max(1, Number(body?.maxComments || 100))),
            include_replies: false
          },
          timeoutMs: 90000
        });
        if (result?.ok === false) throw new Error(result.message || "抖音评论拉取失败");
        const imported = store.importRemoteComments(videoId, result?.comments || [], {
          availableTotal: Number(result?.available_total || 0)
        });
        clearShortVideoListCache();
        sendJson(res, 200, imported);
      } catch (error) {
        sendShortVideoPublicError(res, sendJson, error, "抖音评论同步失败", { defaultStatus: 502 });
      }
      return true;
    }

    if (url.pathname === "/api/short-videos" && req.method === "GET" && sharedCache) {
      const cachePath = listCachePath(url);
      const forceRefresh = String(url.searchParams.get("refresh") || "").trim() === "1";
      if (!forceRefresh) {
        const cached = readJsonCache(cachePath);
        if (cached?.fresh) {
          const data = applyShortVideoWatchOverlays(cached.data);
          sendJson(res, 200, applyMobilePlaybackHints({ ...data, cached: true, cacheState: "fresh" }));
          queueStartupVideoCandidates(data.videos);
          queueSmoothVideoCandidates(data.videos);
          return true;
        }
        if (cached?.data && cached.generationCurrent) {
          const data = applyShortVideoWatchOverlays(cached.data);
          sendJson(res, 200, applyMobilePlaybackHints({ ...data, cached: true, stale: true, cacheState: "stale-refreshing" }));
          queueStartupVideoCandidates(data.videos);
          queueSmoothVideoCandidates(data.videos);
          queueListCacheRefresh(url, cachePath);
          return true;
        }
      }
      try {
        const { data, generation, watchGeneration } = await queryStableShortVideoListForRequest(req, url);
        writeJsonCache(cachePath, data, generation, watchGeneration);
        sendJson(res, 200, applyMobilePlaybackHints(data));
        queueStartupVideoCandidates(data.videos);
        queueSmoothVideoCandidates(data.videos);
      } catch (error) {
        const cached = readJsonCache(cachePath);
        if (cached?.data) {
          const data = applyShortVideoWatchOverlays(cached.data);
          sendJson(res, 200, applyMobilePlaybackHints({ ...data, cached: true, stale: true, offline: true, cacheState: "offline" }));
        } else {
          sendShortVideoPublicError(res, sendJson, error, "短视频列表读取失败", { includeRetryable: true });
        }
      }
      return true;
    }

    const detailPlaybackMatch = /^\/api\/short-videos\/([^/]+)$/.exec(url.pathname);
    const detailPlaybackSegment = detailPlaybackMatch
      ? decodeShortVideoDetailSegment(detailPlaybackMatch[1])
      : null;
    if (
      detailPlaybackMatch
      && req.method === "GET"
      && detailPlaybackSegment?.ok
      && !SHORT_VIDEO_RESERVED_DETAIL_SEGMENTS.has(detailPlaybackSegment.value.toLowerCase())
    ) {
      tryQueueStartupVideoCache(detailPlaybackSegment.value, { delayMs: 0 });
    }

    const routeController = new AbortController();
    const onRouteAbort = () => routeController.abort();
    req?.once?.("aborted", onRouteAbort);
    try {
      return await routeShortVideoApi(req, res, url, {
        notFound,
        readJsonBody,
        requestSignal: routeController.signal,
        requireLocalAdmin,
        sendJson,
        shortVideoStore: routeStore,
        listVideos: (requestUrl) => queryShortVideoListForRequest(req, requestUrl),
        recordWatch: (videoId, options) => watchWriter.record(videoId, options),
        onMutation: clearShortVideoListCache,
        onWatchMutation: (...args) => {
          recordShortVideoWatchCacheMutation(...args);
          catalogWorker.invalidateStats();
        },
        refreshLikeDistribution
      });
    } finally {
      req?.off?.("aborted", onRouteAbort);
    }
  }

  async function routeMedia(req, res, url) {
    const smoothVideoMatch = /^\/media\/short-video-smooth\/([^/]+)$/.exec(url.pathname);
    if (smoothVideoMatch && (req.method === "GET" || req.method === "HEAD")) {
      const id = decodeURIComponent(smoothVideoMatch[1]);
      const sourceFile = store.videoFile(id, { allowMissing: true });
      if (!sourceFile || sourceFile.type !== "video") {
        notFound(res);
        return true;
      }
      let smoothFile = cachedSmoothVideoFile(id, sourceFile);
      let sourceCompatible = !smoothFile && isSmoothVideoSourceCompatible(id, sourceFile);
      let playbackPrepare = smoothFile ? "cached" : (sourceCompatible ? "source-compatible" : "source");
      let playbackWaitMs = 0;
      const initialPlaybackRange = req.method === "GET" && isInitialVideoRange(req.headers?.range);
      const androidPlayback = String(req.headers?.["x-fanhao-client"] || "").trim().toLowerCase() === "android";
      const allowPlaybackWait = String(url.searchParams.get("wait") || "1").trim() !== "0";
      if (!smoothFile && !sourceCompatible && initialPlaybackRange && allowPlaybackWait) {
        const waitStartedAt = Date.now();
        tryQueueSmoothVideoCache(id, { delayMs: 0, kind: "current" });
        const prepared = await waitForSmoothVideoPlayback(id, sourceFile, SHORT_VIDEO_SMOOTH_ON_DEMAND_WAIT_MS);
        playbackWaitMs = Date.now() - waitStartedAt;
        smoothFile = cachedSmoothVideoFile(id, sourceFile);
        sourceCompatible = !smoothFile && isSmoothVideoSourceCompatible(id, sourceFile);
        playbackPrepare = smoothFile || sourceCompatible ? "waited" : "wait-timeout";
      } else if (!smoothFile && !sourceCompatible && initialPlaybackRange) {
        playbackPrepare = "source-no-wait";
      }
      const fallbackFile = !androidPlayback && !hasIfRange(req) && req.method === "GET" && isInitialVideoRange(req.headers.range)
        ? cachedStartupVideoFile(id, sourceFile) || sourceFile
        : sourceFile;
      const file = smoothFile || fallbackFile;
      if (!smoothFile && !sourceCompatible) {
        tryQueueStartupVideoCache(id, { delayMs: 0 });
        tryQueueSmoothVideoCache(id, playbackPrepare === "wait-timeout" || playbackPrepare === "source-no-wait" || !initialPlaybackRange
          ? { delayMs: SHORT_VIDEO_SMOOTH_CACHE_DELAY_MS, kind: "background" }
          : { delayMs: SHORT_VIDEO_SMOOTH_CURRENT_DELAY_MS, kind: "current" });
      }
      const requestedVersion = String(url.searchParams.get("v") || "").trim();
      const currentVersion = String(sourceFile.cacheVersion || "").trim();
      const stablePlaybackFile = Boolean(smoothFile || sourceCompatible);
      file.cacheControl = stablePlaybackFile && requestedVersion && currentVersion && requestedVersion === currentVersion
        ? "private, max-age=31536000, immutable"
        : stablePlaybackFile
          ? "private, max-age=0, must-revalidate"
          : "no-store";
      file.maxRangeBytes = androidPlayback
        ? 0
        : initialPlaybackRange
          ? SHORT_VIDEO_INITIAL_STREAM_CHUNK_BYTES
          : SHORT_VIDEO_STREAM_CHUNK_BYTES;
      file.fullResponse = androidPlayback;
      file.responseHeaders = {
        "X-FanHao-Media-Cache": smoothFile
          ? "rendition"
          : file.cachedStartup
            ? "startup"
            : "source",
        "X-FanHao-Playback-Rendition": smoothFile
          ? smoothFile.cachedSmoothLegacy
            ? "smooth-4k30-legacy"
            : "smooth-2k30"
          : sourceCompatible
            ? "source-compatible"
            : "source",
        "X-FanHao-Playback-Prepare": playbackPrepare,
        "X-FanHao-Playback-Wait-Ms": String(playbackWaitMs)
      };
      if (smoothFile?.cachedSmoothLegacy) {
        tryQueueSmoothVideoCache(id, {
          delayMs: SHORT_VIDEO_SMOOTH_CACHE_DELAY_MS,
          kind: "background"
        });
      }
      mediaStreamService.serveVideo(req, res, file);
      return true;
    }

    const galleryMatch = /^\/media\/short-video-gallery\/([^/]+)\/(\d+)$/.exec(url.pathname);
    if (galleryMatch && (req.method === "GET" || req.method === "HEAD")) {
      const file = store.galleryFile(decodeURIComponent(galleryMatch[1]), Number(galleryMatch[2] || 0));
      if (!file || !["image", "video"].includes(file.type)) {
        notFound(res);
        return true;
      }
      if (file.type === "video") {
        const requestedVersion = String(url.searchParams.get("v") || "").trim();
        const currentVersion = String(file.cacheVersion || "").trim();
        file.cacheControl = requestedVersion && currentVersion && requestedVersion === currentVersion
          ? "private, max-age=31536000, immutable"
          : "private, max-age=0, must-revalidate";
        file.maxRangeBytes = isInitialVideoRange(req.headers?.range)
          ? SHORT_VIDEO_INITIAL_STREAM_CHUNK_BYTES
          : SHORT_VIDEO_STREAM_CHUNK_BYTES;
        mediaStreamService.serveVideo(req, res, file);
      } else if (req.method === "HEAD") {
        res.writeHead(200, { "Content-Type": "image/jpeg", "Content-Length": safeStat(file.path)?.size || 0 });
        res.end();
      } else {
        mediaResponseService.serveImage(res, file);
      }
      return true;
    }

    const musicMatch = /^\/media\/short-video-music\/([^/]+)$/.exec(url.pathname);
    if (musicMatch && (req.method === "GET" || req.method === "HEAD")) {
      const file = store.musicFile(decodeURIComponent(musicMatch[1]));
      if (!file || file.type !== "audio") {
        notFound(res);
        return true;
      }
      mediaStreamService.serveVideo(req, res, file);
      return true;
    }

    const coverMatch = /^\/media\/short-video-cover\/([^/]+)$/.exec(url.pathname);
    if (coverMatch && req.method === "GET") {
      const file = store.coverFile(decodeURIComponent(coverMatch[1]));
      if (!file || file.type !== "image") {
        notFound(res);
        return true;
      }
      if (file.buffer) serveShortVideoCoverBlob(res, file);
      else mediaResponseService.serveImage(res, file);
      return true;
    }

    const videoMatch = /^\/media\/short-video\/([^/]+)$/.exec(url.pathname);
    if (videoMatch && (req.method === "GET" || req.method === "HEAD")) {
      const id = decodeURIComponent(videoMatch[1]);
      if (String(url.searchParams.get("download") || "").trim() === "1") {
        try {
          if (typeof serveDownloadFile !== "function") {
            const error = new Error("原文件下载服务暂不可用");
            error.statusCode = 503;
            throw error;
          }
          const originalFile = localActions.sourceFile(id);
          serveDownloadFile(req, res, originalFile, originalFile.fileName || path.basename(originalFile.path));
        } catch (error) {
          if (Number(error?.statusCode || 0) === 404) notFound(res);
          else sendShortVideoPublicError(res, sendJson, error, "短视频原文件下载失败");
        }
        return true;
      }
      const sourceFile = store.videoFile(id, { allowMissing: true });
      if (!sourceFile || sourceFile.type !== "video") {
        notFound(res);
        return true;
      }
      const mediaCacheRequest = String(req.headers["x-fanhao-media-cache"] || "").trim() === "1"
        || String(url.searchParams.get("fhcache") || "").trim() === "1";
      const file = !mediaCacheRequest && !hasIfRange(req) && req.method === "GET" && isInitialVideoRange(req.headers.range)
        ? cachedStartupVideoFile(id, sourceFile) || sourceFile
        : sourceFile;
      const requestedVersion = String(url.searchParams.get("v") || "").trim();
      const currentVersion = String(sourceFile.cacheVersion || "").trim();
      file.cacheControl = requestedVersion && currentVersion && requestedVersion === currentVersion
        ? "private, max-age=31536000, immutable"
        : "private, max-age=0, must-revalidate";
      file.maxRangeBytes = mediaCacheRequest
        ? 0
        : isInitialVideoRange(req.headers?.range)
          ? SHORT_VIDEO_INITIAL_STREAM_CHUNK_BYTES
          : SHORT_VIDEO_STREAM_CHUNK_BYTES;
      file.fullResponse = mediaCacheRequest;
      file.responseHeaders = {
        "X-FanHao-Media-Cache": file.cachedStartup ? "startup" : "source"
      };
      mediaStreamService.serveVideo(req, res, file);
      return true;
    }

    return false;
  }

  function listCachePath(url) {
    const normalized = new URLSearchParams(url.searchParams);
    normalized.delete("refresh");
    normalized.sort?.();
    const hash = hashText(`${SHORT_VIDEO_LIST_CACHE_SCHEMA}:${url.pathname}?${normalized.toString()}`);
    return path.join(sharedCache.rootDir, "short-videos", "lists", `${hash}.json`);
  }

  function writeJsonCache(
    filePath,
    data,
    generation = shortVideoListCacheGeneration,
    watchGeneration = shortVideoWatchCacheGeneration
  ) {
    const tempPath = `${filePath}.tmp-${process.pid}-${crypto.randomBytes(4).toString("hex")}`;
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(tempPath, JSON.stringify({
        ...data,
        cachedAt: new Date().toISOString(),
        cacheGeneration: generation,
        watchCacheGeneration: watchGeneration
      }));
      fs.rmSync(filePath, { force: true });
      fs.renameSync(tempPath, filePath);
      sharedCache.touch(filePath);
      sharedCache.scheduleCleanup();
    } catch (error) {
      console.warn("[short-video-list-cache]", error.message || error);
    } finally {
      try {
        fs.rmSync(tempPath, { force: true });
      } catch {}
    }
  }

  function readJsonCache(filePath) {
    try {
      if (!fs.existsSync(filePath)) return null;
      const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
      const cachedAtMs = Date.parse(String(parsed?.cachedAt || ""));
      const generation = Number(parsed?.cacheGeneration || 0);
      const watchGeneration = Number(parsed?.watchCacheGeneration || 0);
      const data = { ...parsed };
      delete data.cacheGeneration;
      delete data.watchCacheGeneration;
      sharedCache.touch(filePath);
      return {
        data,
        generationCurrent: generation === shortVideoListCacheGeneration
          && (!isWatchSensitiveShortVideoList(data) || watchGeneration === shortVideoWatchCacheGeneration),
        fresh: generation === shortVideoListCacheGeneration
          && (!isWatchSensitiveShortVideoList(data) || watchGeneration === shortVideoWatchCacheGeneration)
          && Number.isFinite(cachedAtMs)
          && Date.now() - cachedAtMs <= SHORT_VIDEO_LIST_CACHE_FRESH_MS
      };
    } catch {
      return null;
    }
  }

  function listCacheGenerationPath() {
    return path.join(path.dirname(dbPath), "short-video-list-cache-generation.json");
  }

  function readShortVideoListCacheGeneration() {
    try {
      const parsed = JSON.parse(fs.readFileSync(listCacheGenerationPath(), "utf8"));
      return Math.max(0, Number(parsed?.generation || 0));
    } catch {
      return 0;
    }
  }

  function persistShortVideoListCacheGeneration() {
    const filePath = listCacheGenerationPath();
    const tempPath = `${filePath}.tmp-${process.pid}-${crypto.randomBytes(4).toString("hex")}`;
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(tempPath, JSON.stringify({ generation: shortVideoListCacheGeneration }));
      fs.rmSync(filePath, { force: true });
      fs.renameSync(tempPath, filePath);
    } finally {
      try {
        fs.rmSync(tempPath, { force: true });
      } catch {}
    }
  }

  function shortVideoWatchCacheStatePath() {
    return path.join(path.dirname(dbPath), "short-video-list-watch-overlays.json");
  }

  function readShortVideoWatchCacheState() {
    try {
      const parsed = JSON.parse(fs.readFileSync(shortVideoWatchCacheStatePath(), "utf8"));
      const entries = (Array.isArray(parsed?.entries) ? parsed.entries : [])
        .map((entry) => ({
          id: String(entry?.id || "").trim(),
          updatedAt: Math.max(0, Number(entry?.updatedAt || 0)),
          watch: normalizeShortVideoWatchState(entry?.watch || {})
        }))
        .filter((entry) => entry.id && entry.watch.lastWatchedAt)
        .slice(-128);
      return {
        generation: Math.max(0, Number(parsed?.generation || 0)),
        entries
      };
    } catch {
      return { generation: 0, entries: [] };
    }
  }

  function scheduleShortVideoWatchCachePersist() {
    if (shortVideoWatchCachePersistTimer) return;
    shortVideoWatchCachePersistTimer = setTimeout(() => {
      shortVideoWatchCachePersistTimer = null;
      persistShortVideoWatchCacheState();
    }, 120);
    shortVideoWatchCachePersistTimer.unref?.();
  }

  function persistShortVideoWatchCacheState() {
    const filePath = shortVideoWatchCacheStatePath();
    const tempPath = `${filePath}.tmp-${process.pid}-${crypto.randomBytes(4).toString("hex")}`;
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(tempPath, JSON.stringify({
        generation: shortVideoWatchCacheGeneration,
        entries: [...shortVideoWatchOverlays.values()].slice(-128)
      }));
      fs.rmSync(filePath, { force: true });
      fs.renameSync(tempPath, filePath);
    } catch (error) {
      console.warn("[short-video-watch-cache]", error.message || error);
    } finally {
      try {
        fs.rmSync(tempPath, { force: true });
      } catch {}
    }
  }

  function recordShortVideoWatchCacheMutation(id, body = {}, data = {}) {
    const videoId = String(data?.videoId || id || "").trim();
    if (!videoId) return;
    const watch = normalizeShortVideoWatchState(data?.watch || body || {});
    if (!watch.lastWatchedAt) watch.lastWatchedAt = new Date().toISOString();
    shortVideoWatchCacheGeneration = Math.max(Date.now(), shortVideoWatchCacheGeneration + 1);
    shortVideoWatchOverlays.delete(videoId);
    shortVideoWatchOverlays.set(videoId, { id: videoId, updatedAt: Date.now(), watch });
    while (shortVideoWatchOverlays.size > 128) {
      shortVideoWatchOverlays.delete(shortVideoWatchOverlays.keys().next().value);
    }
    scheduleShortVideoWatchCachePersist();
  }

  function shortVideoPlaybackCacheStatus() {
    const now = Date.now();
    const orderedQueue = [...smoothVideoQueue].sort((left, right) => left.readyAt - right.readyAt);
    const next = orderedQueue[0] || null;
    const activeJobs = [...smoothVideoActiveJobs.values()]
      .sort((left, right) => Number(left.startedAt || 0) - Number(right.startedAt || 0))
      .map((job) => smoothVideoJobSnapshot(job, now));
    const activeJob = activeJobs[0] || null;
    const concurrency = smoothVideoConcurrency();
    return {
      generatedAt: now,
      smooth: {
        active: activeJobs.length > 0,
        activeCount: activeJobs.length,
        pausedByUser: smoothVideoPausedByUser,
        concurrency,
        activeId: String(activeJob?.id || ""),
        activeIds: activeJobs.map((job) => String(job.id || "")),
        activeKind: String(activeJob?.kind || ""),
        activeJob,
        activeJobs,
        queue: orderedQueue.slice(0, smoothVideoMaterializedJobLimit()).map((job) => smoothVideoJobSnapshot(job, now)),
        recent: smoothVideoRecentJobs.map((job) => ({ ...job })),
        queued: smoothVideoQueue.length,
        jobs: smoothVideoJobs.size,
        backlog: smoothVideoCandidateBacklog.length,
        resolved: smoothVideoResolvedVersions.size,
        scanOffset: smoothVideoCandidateScanOffset,
        scanComplete: smoothVideoCandidateScanComplete,
        nextId: String(next?.id || ""),
        nextKind: String(next?.kind || ""),
        nextReadyInMs: next ? Math.max(0, Number(next.readyAt || 0) - now) : 0,
        warmupAt: lastSmoothVideoWarmupAt,
        warmupCandidates: lastSmoothVideoWarmupCandidates,
        warmupDurationMs: lastSmoothVideoWarmupDurationMs,
        warmupWorker: smoothWarmupWorker.diagnostics(),
        cacheIndexEntries: lastSmoothVideoCacheIndexEntries,
        pipeline: {
          candidatePolicy: "observed-playback-issues",
          candidateOrder: "issue-recent-desc",
          concurrency,
          maxConcurrency: SHORT_VIDEO_SMOOTH_MAX_CONCURRENCY,
          materializedJobs: smoothVideoMaterializedJobLimit(),
          backgroundDelayMs: SHORT_VIDEO_SMOOTH_CACHE_DELAY_MS,
          schedulingPolicy: "continuous",
          encoder: hasNvenc ? "h264_nvenc" : "libx264",
          acceleration: hasNvenc ? "NVIDIA NVENC" : "CPU",
          targetCodec: "h264",
          targetMaxEdge: SHORT_VIDEO_SMOOTH_MAX_EDGE,
          targetFrameRate: SHORT_VIDEO_SMOOTH_FPS,
          targetPixelFormat: "yuv420p",
          targetAudioCodec: "aac"
        }
      },
      startup: {
        active: videoCacheActive,
        queued: videoCacheQueue.length,
        jobs: videoCacheJobs.size
      }
    };
  }

  function clearSmoothVideoRenditionCache() {
    const cacheRoot = path.resolve(sharedCache?.rootDir || "");
    const cacheDir = path.resolve(cacheRoot, "short-videos", "renditions");
    const relative = path.relative(cacheRoot, cacheDir);
    if (!sharedCache?.rootDir || !relative || relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error("转码缓存目录不安全，已拒绝清除");
    }
    let removedCount = 0;
    let removedBytes = 0;
    if (!safeStat(cacheDir)?.isDirectory()) return { path: cacheDir, removedCount, removedBytes };
    for (const entry of fs.readdirSync(cacheDir, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      const filePath = path.join(cacheDir, entry.name);
      const stat = safeStat(filePath);
      fs.rmSync(filePath, { force: true });
      removedCount += 1;
      removedBytes += Math.max(0, Number(stat?.size || 0));
    }
    try { fs.rmdirSync(cacheDir); } catch {}
    smoothVideoCacheEntryNames.clear();
    smoothVideoResolvedVersions.clear();
    smoothVideoRenditionVersions.clear();
    lastSmoothVideoCacheIndexEntries = 0;
    return { path: cacheDir, removedCount, removedBytes };
  }

  function smoothVideoJobSnapshot(job, now = Date.now()) {
    const file = job?.file || {};
    const progress = job?.progress || {};
    const durationMs = Math.max(0, Number(file.durationMs || progress.durationMs || 0));
    const outTimeMs = Math.max(0, Number(progress.outTimeMs || 0));
    const percent = durationMs > 0
      ? Math.max(0, Math.min(100, outTimeMs / durationMs * 100))
      : 0;
    const speed = Math.max(0, Number(progress.speed || 0));
    const etaMs = speed > 0 && durationMs > outTimeMs
      ? Math.max(0, (durationMs - outTimeMs) / speed)
      : 0;
    const startedAt = Math.max(0, Number(job?.startedAt || 0));
    return {
      id: String(job?.id || ""),
      kind: String(job?.kind || "background"),
      phase: String(progress.phase || (job?.active ? "preparing" : "queued")),
      title: String(file.title || file.fileName || path.basename(file.path || "") || job?.id || "未知视频"),
      authorName: String(file.authorName || "未知作者"),
      queuedAt: Math.max(0, Number(job?.queuedAt || 0)),
      readyAt: Math.max(0, Number(job?.readyAt || 0)),
      readyInMs: Math.max(0, Number(job?.readyAt || 0) - now),
      startedAt,
      elapsedMs: startedAt ? Math.max(0, now - startedAt) : 0,
      source: {
        fileName: String(file.fileName || path.basename(file.path || "")),
        path: String(file.path || ""),
        size: Math.max(0, Number(file.size || 0)),
        durationMs,
        width: Math.max(0, Number(file.actualWidth || 0)),
        height: Math.max(0, Number(file.actualHeight || 0)),
        codec: String(file.actualCodec || ""),
        frameRate: Math.max(0, Number(file.actualFrameRate || 0)),
        bitRate: Math.max(0, Number(file.actualBitRate || 0))
      },
      target: {
        path: String(job?.descriptor?.cachePath || ""),
        encoder: hasNvenc ? "h264_nvenc" : "libx264",
        acceleration: hasNvenc ? "NVIDIA NVENC" : "CPU",
        codec: "h264",
        maxEdge: SHORT_VIDEO_SMOOTH_MAX_EDGE,
        frameRate: SHORT_VIDEO_SMOOTH_FPS,
        bitRate: Math.max(0, Number(progress.targetBitRate || 0)),
        maxBitRate: Math.max(0, Number(progress.maxBitRate || 0))
      },
      progress: {
        percent,
        outTimeMs,
        durationMs,
        frame: Math.max(0, Number(progress.frame || 0)),
        fps: Math.max(0, Number(progress.fps || 0)),
        speed,
        outputBytes: Math.max(0, Number(progress.outputBytes || 0)),
        etaMs,
        updatedAt: Math.max(0, Number(progress.updatedAt || 0))
      }
    };
  }

  function recordSmoothVideoJobResult(job, outcome = {}) {
    const endedAt = Date.now();
    smoothVideoRecentJobs.unshift({
      ...smoothVideoJobSnapshot(job, endedAt),
      state: String(outcome.state || "skipped"),
      reason: String(outcome.reason || ""),
      endedAt
    });
    if (smoothVideoRecentJobs.length > SHORT_VIDEO_SMOOTH_RECENT_JOB_LIMIT) {
      smoothVideoRecentJobs.length = SHORT_VIDEO_SMOOTH_RECENT_JOB_LIMIT;
    }
  }

  function setSmoothVideoPausedByUser(paused) {
    smoothVideoPausedByUser = Boolean(paused);
    if (smoothVideoPausedByUser) {
      if (smoothVideoTimer) clearTimeout(smoothVideoTimer);
      smoothVideoTimer = null;
      for (const job of smoothVideoActiveJobs.values()) {
        job.stoppedByUser = true;
        const child = smoothVideoChildren.get(job.key);
        if (child && !child.killed) child.kill("SIGKILL");
      }
      return;
    }
    schedule4kSmoothVideoWarmup(0);
    fillSmoothVideoCandidateQueue();
    sortAndScheduleSmoothVideoQueue();
  }

  function normalizeShortVideoWatchState(watch = {}) {
    const completedCount = Math.max(0, Number(watch?.completedCount || 0));
    return {
      progressMs: Math.max(0, Number(watch?.progressMs || 0)),
      completedCount,
      completed: Boolean(watch?.completed || completedCount > 0),
      lastWatchedAt: String(watch?.lastWatchedAt || "").trim()
    };
  }

  function applyShortVideoWatchOverlays(data = {}) {
    if (!Array.isArray(data?.videos) || !shortVideoWatchOverlays.size) return data;
    let changed = false;
    const videos = data.videos.map((video) => {
      const entry = shortVideoWatchOverlays.get(String(video?.id || ""));
      if (!entry) return video;
      const currentWatchedAt = String(video?.watch?.lastWatchedAt || "");
      if (currentWatchedAt && currentWatchedAt > entry.watch.lastWatchedAt) return video;
      changed = true;
      return { ...video, watch: { ...entry.watch } };
    });
    return changed ? { ...data, videos } : data;
  }

  function applyMobilePlaybackHints(data = {}) {
    if (!Array.isArray(data?.videos)) return data;
    const videos = data.videos.map((video) => {
      const source = String(video?.streamUrl || "").trim();
      if (!source || String(video?.mediaType || "video").toLowerCase() !== "video") return video;
      const version = smoothVideoCandidateVersion(video);
      const ready = version && smoothVideoRenditionVersions.get(String(video.id || "")) === version;
      const mobileStreamUrl = ready
        ? appendPlaybackQuery(source.replace("/media/short-video/", "/media/short-video-smooth/"), {
            rendition: "mobile-2560-h264-v3"
          })
        : source;
      return { ...video, mobileStreamUrl };
    });
    return { ...data, videos };
  }

  function appendPlaybackQuery(source, values = {}) {
    const separator = source.includes("?") ? "&" : "?";
    return `${source}${separator}${new URLSearchParams(values)}`;
  }

  function isWatchSensitiveShortVideoList(data = {}) {
    return String(data?.source || "").toLowerCase() === "history"
      || String(data?.sort || "").toLowerCase() === "watched";
  }

  function queueListCacheRefresh(url, cachePath) {
    if (listCacheRefreshJobs.has(cachePath)) return;
    const generation = shortVideoListCacheGeneration;
    const watchGeneration = shortVideoWatchCacheGeneration;
    const requestUrl = new URL(url.href);
    const timer = setTimeout(async () => {
      try {
        const data = await queryShortVideoList(requestUrl);
        if (generation !== shortVideoListCacheGeneration) return;
        if (isWatchSensitiveShortVideoList(data) && watchGeneration !== shortVideoWatchCacheGeneration) return;
        writeJsonCache(cachePath, data, generation, watchGeneration);
        queueStartupVideoCandidates(data.videos);
        queueSmoothVideoCandidates(data.videos);
      } catch (error) {
        console.warn("[short-video-list-refresh]", error.message || error);
      } finally {
        listCacheRefreshJobs.delete(cachePath);
      }
    }, 25);
    timer.unref?.();
    listCacheRefreshJobs.set(cachePath, timer);
  }

  async function queryShortVideoList(url, options = {}) {
    if (typeof listQuery === "function") {
      return listQuery(url, options, (nextUrl = url, nextOptions = options) => listStatsService.list(nextUrl, nextOptions));
    }
    return listStatsService.list(url, options);
  }

  function isWatchSensitiveShortVideoRequest(url, data = {}) {
    return isWatchSensitiveShortVideoList(data)
      || String(url?.searchParams?.get("source") || "").toLowerCase() === "history"
      || String(url?.searchParams?.get("sort") || "").toLowerCase() === "watched";
  }

  async function queryShortVideoListForRequest(req, url) {
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    req?.once?.("aborted", onAbort);
    try {
      return await queryShortVideoList(url, { signal: controller.signal });
    } finally {
      req?.off?.("aborted", onAbort);
    }
  }

  async function queryStableShortVideoListForRequest(req, url) {
    for (let attempt = 0; attempt < SHORT_VIDEO_LIST_STABLE_QUERY_ATTEMPTS; attempt += 1) {
      const generation = shortVideoListCacheGeneration;
      const watchGeneration = shortVideoWatchCacheGeneration;
      const data = await queryShortVideoListForRequest(req, url);
      const generationStable = generation === shortVideoListCacheGeneration;
      const watchGenerationStable = !isWatchSensitiveShortVideoRequest(url, data)
        || watchGeneration === shortVideoWatchCacheGeneration;
      if (generationStable && watchGenerationStable) return { data, generation, watchGeneration };
    }
    const error = new Error("短视频列表正在更新，请稍后重试");
    error.code = "SHORT_VIDEO_LIST_UNSTABLE";
    error.statusCode = 503;
    error.retryable = true;
    error.expose = true;
    throw error;
  }

  async function stopListServices() {
    const workerStops = [catalogWorker.stop(), smoothWarmupWorker.stop(), watchWriter.stop()];
    for (const timer of listCacheRefreshJobs.values()) clearTimeout(timer);
    listCacheRefreshJobs.clear();
    if (shortVideoWatchCachePersistTimer) {
      clearTimeout(shortVideoWatchCachePersistTimer);
      shortVideoWatchCachePersistTimer = null;
      persistShortVideoWatchCacheState();
    }
    await Promise.all(workerStops);
  }

  function startDownloadManagerSync() {
    if (runtimeStarted && runtimeDesiredStarted && !runtimeStopPromise) return Promise.resolve(true);
    if (runtimeStartPromise && runtimeDesiredStarted) return runtimeStartPromise;
    runtimeDesiredStarted = true;
    const generation = ++runtimeLifecycleGeneration;
    const stopping = runtimeStopPromise;
    const startWork = (async () => {
      if (stopping) await stopping;
      if (!runtimeStartStillCurrent(generation)) return false;
      try {
        const recovery = await store.recoverDeleteJobs();
        if (!runtimeStartStillCurrent(generation)) return false;
        const pending = Math.max(Number(recovery?.pending || 0), Number(recovery?.active || 0));
        if (pending > 0) {
          const error = new Error(`短视频删除恢复仍有 ${pending} 个未完成作业`);
          error.code = "SHORT_VIDEO_DELETE_RECOVERY_PENDING";
          error.statusCode = 503;
          error.retryable = true;
          throw error;
        }
      } catch (error) {
        if (!runtimeStartStillCurrent(generation)) return false;
        runtimeDesiredStarted = false;
        runtimeLifecycleGeneration += 1;
        runtimeStarted = false;
        runtimeTestHooks.onRuntimeStartedChange?.(false);
        store.close();
        throw error;
      }
      if (!runtimeStartStillCurrent(generation)) return false;
      runtimeTestHooks.beforeWritersStart?.();
      if (!runtimeStartStillCurrent(generation)) return false;
      catalogWorker.reopen();
      smoothWarmupWorker.reopen();
      if (!runtimeStartStillCurrent(generation)) return false;
      runtimeTestHooks.beforeWatchWriterStart?.();
      if (!runtimeStartStillCurrent(generation)) return false;
      try {
        await watchWriter.start();
      } catch (error) {
        if (!runtimeStartStillCurrent(generation)) return false;
        runtimeDesiredStarted = false;
        runtimeLifecycleGeneration += 1;
        runtimeStarted = false;
        runtimeTestHooks.onRuntimeStartedChange?.(false);
        await stopListServices();
        store.close();
        throw error;
      }
      if (!runtimeStartStillCurrent(generation)) return false;
      runtimeTestHooks.beforeDownloadManagerSyncStart?.();
      if (!runtimeStartStillCurrent(generation)) return false;
      downloadManagerSync.start();
      if (!runtimeStartStillCurrent(generation)) return false;
      runtimeStarted = true;
      runtimeTestHooks.onRuntimeStartedChange?.(true);
      if (!runtimeStartStillCurrent(generation)) return false;
      if (autoSmoothWarmup) schedule4kSmoothVideoWarmup();
      return true;
    })();
    let trackedStart;
    trackedStart = startWork.finally(() => {
      if (runtimeStartPromise === trackedStart) runtimeStartPromise = null;
    });
    runtimeStartPromise = trackedStart;
    return trackedStart;
  }

  function runtimeStartStillCurrent(generation) {
    return runtimeDesiredStarted
      && generation === runtimeLifecycleGeneration
      && !runtimeStopPromise;
  }

  function stopDownloadManagerSync() {
    if (runtimeDesiredStarted || runtimeStartPromise) {
      runtimeDesiredStarted = false;
      runtimeLifecycleGeneration += 1;
    }
    if (runtimeStopPromise) return runtimeStopPromise;
    const startToDrain = runtimeStartPromise;
    const deleteDrain = store.beginClose();
    runtimeStarted = false;
    runtimeTestHooks.onRuntimeStartedChange?.(false);
    stopVideoCacheQueue();
    stopSmoothVideoQueue();
    const stopWork = (async () => {
      let stopError = null;
      try {
        const syncStop = downloadManagerSync.stop();
        await Promise.all([syncStop, stopListServices()]);
      } catch (error) {
        stopError = error;
      }
      try {
        await deleteDrain;
      } catch (error) {
        stopError ||= error;
      }
      if (startToDrain) await startToDrain.catch(() => undefined);
      const closed = store.close();
      if (!closed && !stopError) {
        stopError = Object.assign(new Error("短视频删除作业未完成，运行时存储无法关闭"), {
          code: "SHORT_VIDEO_DELETE_DRAIN_INCOMPLETE"
        });
      }
      if (stopError) throw stopError;
    })();
    let trackedStop;
    trackedStop = stopWork.finally(() => {
      if (runtimeStopPromise === trackedStop) runtimeStopPromise = null;
    });
    runtimeStopPromise = trackedStop;
    return trackedStop;
  }

  async function downloadManagerRequest(pathname, options = {}) {
    const base = String(downloadManagerUrl || "http://127.0.0.1:8765").replace(/\/+$/, "");
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), Math.max(1000, Number(options.timeoutMs || 10000)));
    timeout.unref?.();
    try {
      const response = await fetch(`${base}${pathname}`, {
        method: options.method || "GET",
        headers: options.body ? { "Content-Type": "application/json" } : undefined,
        body: options.body ? JSON.stringify(options.body) : undefined,
        signal: controller.signal
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        const error = new Error(data?.message || data?.error || `8765 请求失败 (${response.status})`);
        error.statusCode = response.status;
        throw error;
      }
      return data;
    } catch (error) {
      if (error?.name === "AbortError") {
        const timeoutError = new Error("8765 响应超时");
        timeoutError.statusCode = 504;
        throw timeoutError;
      }
      if (!error.statusCode && /fetch failed|ECONNREFUSED/i.test(String(error?.message || error))) error.statusCode = 503;
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  function collectorStatus(state, secUid, jobId = 0) {
    const profile = collectorProfile(state, secUid);
    const jobs = Array.isArray(state?.jobs) ? state.jobs : [];
    const job = jobId ? jobs.find((item) => Number(item?.id || 0) === Number(jobId)) || null : null;
    const progressJobId = Number(state?.extract?.job_id || 0);
    const progressJob = progressJobId
      ? jobs.find((item) => Number(item?.id || 0) === progressJobId) || null
      : null;
    const publicJob = (item) => item ? {
      id: Number(item.id || 0),
      type: String(item.type || ""),
      status: String(item.status || ""),
      message: String(item.message || ""),
      total: Number(item.total || 0),
      processed: Number(item.processed || 0),
      success: Number(item.success || 0),
      failed: Number(item.failed || 0)
    } : null;
    return {
      ok: true,
      available: true,
      linked: Boolean(profile),
      profile: profile ? publicCollectorProfile(profile) : null,
      active: Boolean(state?.extract?.active),
      activeJobId: progressJobId,
      progress: publicJob(progressJob),
      job: publicJob(job)
    };
  }

  function collectorProfile(state, secUid) {
    const target = String(secUid || "").trim();
    if (!target) return null;
    return (Array.isArray(state?.profiles) ? state.profiles : []).find((profile) => String(profile?.sec_uid || "").trim() === target) || null;
  }

  function publicCollectorProfile(profile = {}) {
    return {
      id: Number(profile.id || 0),
      secUid: String(profile.sec_uid || ""),
      name: String(profile.nickname || profile.title || ""),
      tab: String(profile.tab || "post"),
      lastExtractedAt: String(profile.last_extracted_at || "")
    };
  }

  function clearShortVideoListCache() {
    shortVideoListCacheGeneration = Math.max(Date.now(), shortVideoListCacheGeneration + 1);
    try {
      persistShortVideoListCacheGeneration();
    } catch (error) {
      console.warn("[short-video-list-invalidate-persist]", error.message || error);
    }
    try {
      catalogWorker.reset();
    } catch (error) {
      console.warn("[short-video-list-invalidate]", error.message || error);
    }
  }

  async function likeDistributionRuntimeStamp() {
    const managerStamp = await sqliteRuntimeStamp(downloadManagerDbPath);
    return `${shortVideoListCacheGeneration}:manager=${managerStamp}`;
  }

  async function sqliteRuntimeStamp(databasePath) {
    const target = String(databasePath || "").trim();
    if (!target) return "none";
    const [databaseStamp, walStamp] = await Promise.all([
      fileRuntimeStamp(target),
      fileRuntimeStamp(`${target}-wal`, { ignoreEmpty: true })
    ]);
    return `${databaseStamp}|wal=${walStamp}`;
  }

  async function fileRuntimeStamp(filePath, options = {}) {
    try {
      const stat = await fs.promises.stat(filePath, { bigint: true });
      if (options.ignoreEmpty && stat.size === 0n) return "missing";
      return `${stat.size}:${stat.mtimeNs}`;
    } catch {
      return "missing";
    }
  }

  async function refreshLikeDistribution(options = {}) {
    catalogWorker.invalidateLikeDistribution();
    return catalogWorker.queryLikeDistribution({
      catalogStamp: await likeDistributionRuntimeStamp(),
      signal: options.signal
    });
  }

  function cachedStartupVideoFile(id, file) {
    const descriptor = startupVideoCacheDescriptor(id, file);
    if (!descriptor?.cachePath || descriptor.prefixSize <= 0) return null;
    const cachedStat = safeStat(descriptor.cachePath);
    if (!cachedStat?.isFile() || cachedStat.size !== descriptor.prefixSize) return null;
    sharedCache.touch(descriptor.cachePath);
    return {
      ...file,
      path: descriptor.cachePath,
      ext: descriptor.ext,
      type: "video",
      totalSize: descriptor.expectedSize,
      entityMtimeMs: descriptor.expectedMtimeMs,
      cachedStartup: true
    };
  }

  function startupVideoCacheDescriptor(id, file) {
    if (!sharedCache?.rootDir || !file?.path) return null;
    const safeId = safeFilePart(file.id || id || "short-video");
    const ext = file.ext || path.extname(file.path).toLowerCase() || ".mp4";
    const expectedSize = Math.max(0, Number(file.size || 0));
    const expectedMtimeMs = Math.max(0, Math.floor(Number(file.cacheVersion || 0)));
    if (expectedSize <= 0 || expectedMtimeMs <= 0) return null;
    const prefixSize = Math.min(expectedSize, SHORT_VIDEO_STARTUP_CACHE_BYTES);
    const cacheDir = path.join(sharedCache.rootDir, "short-videos", "startup");
    const cachePath = path.join(
      cacheDir,
      `${safeId}-${hashText(`${file.path}:${expectedSize}:${expectedMtimeMs}`).slice(0, 18)}${ext}.start`
    );
    return { cacheDir, cachePath, expectedMtimeMs, expectedSize, ext, prefixSize, safeId };
  }

  function smoothVideoCacheDescriptor(id, file) {
    if (!sharedCache?.rootDir || !file?.path) return null;
    const safeId = safeFilePart(file.id || id || "short-video");
    const expectedSize = Math.max(0, Number(file.size || 0));
    const expectedMtimeMs = Math.max(0, Math.floor(Number(file.cacheVersion || 0)));
    if (expectedSize <= 0 || expectedMtimeMs <= 0) return null;
    const cacheDir = path.join(sharedCache.rootDir, "short-videos", "renditions");
    const version = hashText(`${file.path}:${expectedSize}:${expectedMtimeMs}:h264:${SHORT_VIDEO_SMOOTH_FPS}:${SHORT_VIDEO_SMOOTH_MAX_EDGE}:v${SHORT_VIDEO_SMOOTH_RENDITION_VERSION}`).slice(0, 18);
    const cachePath = path.join(cacheDir, `${safeId}-${version}-2k30-h264.mp4`);
    const legacyVersion = hashText(`${file.path}:${expectedSize}:${expectedMtimeMs}:h264:${SHORT_VIDEO_SMOOTH_FPS}`).slice(0, 18);
    const legacyCachePath = path.join(cacheDir, `${safeId}-${legacyVersion}-4k30-h264.mp4`);
    return {
      cacheDir,
      cachePath,
      legacyCachePath,
      expectedMtimeMs,
      expectedSize,
      safeId,
      skipPath: `${cachePath}.source-ok`
    };
  }

  function cachedSmoothVideoFile(id, servedSourceFile) {
    const originalFile = store.videoFile(id, { allowMissing: true }) || servedSourceFile;
    const descriptor = smoothVideoCacheDescriptor(id, originalFile);
    if (!descriptor?.cachePath) return null;
    const preferredStat = safeStat(descriptor.cachePath);
    const legacyStat = preferredStat?.isFile() ? null : safeStat(descriptor.legacyCachePath);
    const cachePath = preferredStat?.isFile()
      ? descriptor.cachePath
      : legacyStat?.isFile()
        ? descriptor.legacyCachePath
        : "";
    const cachedStat = cachePath ? (preferredStat?.isFile() ? preferredStat : legacyStat) : null;
    if (!cachedStat?.isFile() || cachedStat.size <= 0) return null;
    const cachedSmoothLegacy = cachePath === descriptor.legacyCachePath;
    if (!cachedSmoothLegacy) rememberSmoothVideoResolved(id, descriptor, true);
    sharedCache.touch(cachePath);
    return {
      ...servedSourceFile,
      path: cachePath,
      ext: ".mp4",
      size: cachedStat.size,
      type: "video",
      cacheVersion: originalFile.cacheVersion,
      entityMtimeMs: Math.max(0, Number(cachedStat.mtimeMs || 0)),
      cachedSmooth: true,
      cachedSmoothLegacy
    };
  }

  function isSmoothVideoSourceCompatible(id, servedSourceFile) {
    const originalFile = store.videoFile(id, { allowMissing: true }) || servedSourceFile;
    const descriptor = smoothVideoCacheDescriptor(id, originalFile);
    const skipStat = descriptor?.skipPath ? safeStat(descriptor.skipPath) : null;
    if (!skipStat?.isFile()) return false;
    rememberSmoothVideoResolved(id, descriptor);
    sharedCache.touch(descriptor.skipPath);
    return true;
  }

  function smoothVideoVersion(expectedSize, expectedMtimeMs) {
    const size = Math.max(0, Number(expectedSize || 0));
    const mtimeMs = Math.max(0, Math.floor(Number(expectedMtimeMs || 0)));
    return size > 0 && mtimeMs > 0 ? `${size}:${mtimeMs}` : "";
  }

  function smoothVideoCandidateVersion(video = {}) {
    const streamVersion = /[?&]v=(\d+)/.exec(String(video?.streamUrl || ""))?.[1] || "";
    return smoothVideoVersion(video?.size, streamVersion);
  }

  function smoothVideoCandidateDescriptor(video = {}) {
    const streamVersion = /[?&]v=(\d+)/.exec(String(video?.streamUrl || ""))?.[1] || "";
    return smoothVideoCacheDescriptor(video?.id, {
      id: video?.id,
      path: String(video?.sourcePath || ""),
      size: Math.max(0, Number(video?.size || 0)),
      cacheVersion: Math.max(0, Number(streamVersion || 0))
    });
  }

  async function refreshSmoothVideoCacheEntryIndex() {
    const cacheDir = sharedCache?.rootDir
      ? path.join(sharedCache.rootDir, "short-videos", "renditions")
      : "";
    try {
      smoothVideoCacheEntryNames = new Set(
        (await fs.promises.readdir(cacheDir, { withFileTypes: true }))
          .filter((entry) => entry.isFile())
          .map((entry) => entry.name)
      );
    } catch {
      smoothVideoCacheEntryNames = new Set();
    }
    lastSmoothVideoCacheIndexEntries = smoothVideoCacheEntryNames.size;
  }

  function rememberIndexedSmoothVideoCandidate(video = {}) {
    const descriptor = smoothVideoCandidateDescriptor(video);
    if (!descriptor) return false;
    const currentName = path.basename(descriptor.cachePath);
    const skipName = path.basename(descriptor.skipPath);
    if (!smoothVideoCacheEntryNames.has(currentName) && !smoothVideoCacheEntryNames.has(skipName)) return false;
    rememberSmoothVideoResolved(video.id, descriptor, smoothVideoCacheEntryNames.has(currentName));
    return true;
  }

  function rememberSmoothVideoResolved(id, descriptor, rendition = false) {
    const videoId = String(id || "").trim();
    const version = smoothVideoVersion(descriptor?.expectedSize, descriptor?.expectedMtimeMs);
    if (!videoId || !version) return;
    smoothVideoResolvedVersions.set(videoId, version);
    if (rendition) smoothVideoRenditionVersions.set(videoId, version);
    else smoothVideoRenditionVersions.delete(videoId);
  }

  function queueStartupVideoCandidates(videos = []) {
    let queued = 0;
    for (const video of Array.isArray(videos) ? videos : []) {
      if (queued >= SHORT_VIDEO_STARTUP_CACHE_CANDIDATES) break;
      if (!video?.id || String(video.mediaType || "video").toLowerCase() !== "video") continue;
      const result = tryQueueStartupVideoCache(video.id, {
        delayMs: SHORT_VIDEO_STARTUP_CACHE_DELAY_MS + queued * 80
      });
      if (["queued", "copying"].includes(result?.state)) queued += 1;
    }
  }

  function enqueueSmoothVideoCandidates(videos = []) {
    let added = 0;
    for (const video of Array.isArray(videos) ? videos : []) {
      if (smoothVideoCandidateBacklog.length >= SHORT_VIDEO_SMOOTH_CACHE_BACKLOG_LIMIT) break;
      if (!video?.id || String(video.mediaType || "video").toLowerCase() !== "video") continue;
      if (video.observedPlaybackIssue !== true) continue;
      const id = String(video.id);
      const version = smoothVideoCandidateVersion(video);
      if (version && smoothVideoResolvedVersions.get(id) === version) continue;
      if (rememberIndexedSmoothVideoCandidate(video)) continue;
      if (smoothVideoCandidateIds.has(id) || [...smoothVideoJobs.values()].some((job) => String(job.id) === id)) continue;
      smoothVideoCandidateIds.add(id);
      smoothVideoCandidateBacklog.push(id);
      added += 1;
    }
    return added;
  }

  function queueSmoothVideoCandidates(videos = []) {
    if (!autoSmoothWarmup) return;
    enqueueSmoothVideoCandidates(videos);
    fillSmoothVideoCandidateQueue();
  }

  function schedule4kSmoothVideoWarmup(delayMs = SHORT_VIDEO_SMOOTH_WARMUP_DELAY_MS) {
    if (smoothVideoWarmupTimer) clearTimeout(smoothVideoWarmupTimer);
    const generation = ++smoothVideoWarmupGeneration;
    smoothVideoWarmupTimer = setTimeout(async () => {
      smoothVideoWarmupTimer = null;
      try {
        const warmupStartedAt = Date.now();
        lastSmoothVideoWarmupAt = Date.now();
        const candidateCount = await smoothWarmupWorker.queryCount();
        if (!smoothVideoWarmupStillCurrent(generation)) return;
        lastSmoothVideoWarmupCandidates = Math.max(0, Number(candidateCount || 0));
        await refreshSmoothVideoCacheEntryIndex();
        if (!smoothVideoWarmupStillCurrent(generation)) return;
        smoothVideoCandidateBacklog.length = 0;
        smoothVideoCandidateIds.clear();
        smoothVideoResolvedVersions.clear();
        smoothVideoRenditionVersions.clear();
        smoothVideoCandidateScanOffset = 0;
        smoothVideoCandidateScanComplete = lastSmoothVideoWarmupCandidates <= 0;
        if (!smoothVideoCandidateScanComplete) {
          await refillSmoothVideoCandidateBacklog(generation);
        }
        if (!smoothVideoWarmupStillCurrent(generation)) return;
        fillSmoothVideoCandidateQueue();
        lastSmoothVideoWarmupDurationMs = Date.now() - warmupStartedAt;
      } catch (error) {
        if (smoothVideoWarmupStillCurrent(generation)) {
          console.warn("[short-video-smooth-warmup]", error.message || error);
        }
      }
    }, Math.max(0, Number(delayMs || 0)));
    smoothVideoWarmupTimer.unref?.();
  }

  function smoothVideoWarmupStillCurrent(generation) {
    return runtimeDesiredStarted
      && generation === smoothVideoWarmupGeneration;
  }

  function refillSmoothVideoCandidateBacklog(generation = smoothVideoWarmupGeneration) {
    if (
      !smoothVideoWarmupStillCurrent(generation)
      || smoothVideoCandidateScanComplete
      || smoothVideoCandidateBacklog.length > SHORT_VIDEO_SMOOTH_CACHE_REFILL_LOW_WATERMARK
    ) return Promise.resolve(0);
    if (smoothVideoCandidateRefill?.generation === generation) {
      return smoothVideoCandidateRefill.promise;
    }
    const refill = { generation, promise: null };
    const refillWork = (async () => {
      let scanned = 0;
      while (
        smoothVideoWarmupStillCurrent(generation)
        && !smoothVideoCandidateScanComplete
        && smoothVideoCandidateBacklog.length < SHORT_VIDEO_SMOOTH_CACHE_BACKLOG_LIMIT
      ) {
        const pageLimit = Math.min(
          SHORT_VIDEO_SMOOTH_CACHE_PAGE_SIZE,
          SHORT_VIDEO_SMOOTH_CACHE_BACKLOG_LIMIT - smoothVideoCandidateBacklog.length
        );
        const page = await smoothWarmupWorker.queryCandidates(pageLimit, smoothVideoCandidateScanOffset);
        if (!smoothVideoWarmupStillCurrent(generation)) return scanned;
        smoothVideoCandidateScanOffset += page.length;
        scanned += page.length;
        enqueueSmoothVideoCandidates(page);
        scheduleSmoothVideoCandidateFill();
        if (
          page.length < pageLimit
          || smoothVideoCandidateScanOffset >= lastSmoothVideoWarmupCandidates
        ) smoothVideoCandidateScanComplete = true;
        if (!page.length) break;
      }
      return scanned;
    })();
    refill.promise = refillWork.catch((error) => {
      if (smoothVideoWarmupStillCurrent(generation)) {
        console.warn("[short-video-smooth-warmup]", error.message || error);
      }
      return 0;
    }).finally(() => {
      if (smoothVideoCandidateRefill === refill) smoothVideoCandidateRefill = null;
    });
    smoothVideoCandidateRefill = refill;
    return refill.promise;
  }

  function fillSmoothVideoCandidateQueue() {
    if (smoothVideoPausedByUser) return;
    let processed = 0;
    while (
      smoothVideoJobs.size < smoothVideoMaterializedJobLimit()
      && smoothVideoCandidateBacklog.length
      && processed < SHORT_VIDEO_SMOOTH_CANDIDATES_PER_TURN
    ) {
      const id = smoothVideoCandidateBacklog.shift();
      smoothVideoCandidateIds.delete(id);
      processed += 1;
      tryQueueSmoothVideoCache(id, {
        delayMs: SHORT_VIDEO_SMOOTH_CACHE_DELAY_MS,
        kind: "background"
      });
    }
    if (
      smoothVideoJobs.size < smoothVideoMaterializedJobLimit()
      && smoothVideoCandidateBacklog.length
    ) scheduleSmoothVideoCandidateFill();
    if (
      !smoothVideoCandidateScanComplete
      && smoothVideoCandidateBacklog.length <= SHORT_VIDEO_SMOOTH_CACHE_REFILL_LOW_WATERMARK
    ) void refillSmoothVideoCandidateBacklog();
  }

  function scheduleSmoothVideoCandidateFill() {
    if (smoothVideoPausedByUser || smoothVideoCandidateFillImmediate) return;
    smoothVideoCandidateFillImmediate = setImmediate(() => {
      smoothVideoCandidateFillImmediate = null;
      fillSmoothVideoCandidateQueue();
    });
    smoothVideoCandidateFillImmediate.unref?.();
  }

  function tryQueueSmoothVideoCache(id, options = {}) {
    try {
      return queueSmoothVideoCache(id, options);
    } catch (error) {
      console.warn("[short-video-smooth-cache]", id, error.message || error);
      return { state: "error" };
    }
  }

  function queueSmoothVideoCache(id, options = {}) {
    if (!sharedCache?.rootDir) return { state: "disabled" };
    const file = store.videoFile(id, { allowMissing: true });
    const descriptor = smoothVideoCacheDescriptor(id, file);
    if (!file?.path || !descriptor?.cachePath) return { state: "missing" };
    if (smoothVideoMetadataNeedsRendition(file) === false) {
      rememberSmoothVideoResolved(id, descriptor);
      return { state: "source-ok" };
    }
    if (safeStat(descriptor.cachePath)?.size > 0) {
      rememberSmoothVideoResolved(id, descriptor, true);
      sharedCache.touch(descriptor.cachePath);
      return { state: "cached", path: descriptor.cachePath };
    }
    if (safeStat(descriptor.skipPath)?.isFile()) {
      rememberSmoothVideoResolved(id, descriptor);
      return { state: "source-ok" };
    }
    const key = descriptor.cachePath;
    const readyAt = Date.now() + Math.max(0, Number(options.delayMs || 0));
    const existing = smoothVideoJobs.get(key);
    if (existing) {
      existing.readyAt = Math.min(existing.readyAt, readyAt);
      if (options.kind !== "background" && !existing.active) existing.kind = "current";
      sortAndScheduleSmoothVideoQueue();
      return { state: existing.active ? "transcoding" : "queued", path: descriptor.cachePath };
    }
    const job = {
      active: false,
      descriptor,
      file,
      id,
      key,
      kind: options.kind === "background" ? "background" : "current",
      queuedAt: Date.now(),
      readyAt,
      stoppedByUser: false
    };
    smoothVideoJobs.set(key, job);
    smoothVideoQueue.push(job);
    sortAndScheduleSmoothVideoQueue();
    return { state: "queued", path: descriptor.cachePath };
  }

  function tryQueueStartupVideoCache(id, options = {}) {
    try {
      return queueStartupVideoCache(id, options);
    } catch (error) {
      console.warn("[short-video-startup-cache]", id, error.message || error);
      return { state: "error" };
    }
  }

  function queueStartupVideoCache(id, options = {}) {
    if (!sharedCache?.rootDir) return { state: "disabled" };
    const file = store.videoFile(id, { allowMissing: true });
    const descriptor = startupVideoCacheDescriptor(id, file);
    if (!file?.path || !descriptor?.cachePath) return { state: "missing" };
    if (safeStat(descriptor.cachePath)?.size === descriptor.prefixSize) {
      sharedCache.touch(descriptor.cachePath);
      return { state: "cached", path: descriptor.cachePath };
    }
    const key = descriptor.cachePath;
    const readyAt = Date.now() + Math.max(0, Number(options.delayMs || 0));
    const existing = videoCacheJobs.get(key);
    if (existing) {
      existing.readyAt = Math.min(existing.readyAt, readyAt);
      sortAndScheduleVideoCacheQueue();
      return { state: existing.active ? "copying" : "queued", path: descriptor.cachePath };
    }
    const job = { active: false, descriptor, file, id, key, kind: "startup", readyAt };
    videoCacheJobs.set(key, job);
    videoCacheQueue.push(job);
    sortAndScheduleVideoCacheQueue();
    return { state: "queued", path: descriptor.cachePath };
  }

  function sortAndScheduleVideoCacheQueue() {
    if (videoCacheActive) return;
    videoCacheQueue.sort((left, right) => left.readyAt - right.readyAt);
    if (videoCacheTimer) clearTimeout(videoCacheTimer);
    videoCacheTimer = null;
    const next = videoCacheQueue[0];
    if (!next) return;
    videoCacheTimer = setTimeout(runVideoCacheQueue, Math.max(0, next.readyAt - Date.now()));
    videoCacheTimer.unref?.();
  }

  async function runVideoCacheQueue() {
    videoCacheTimer = null;
    if (videoCacheActive) return;
    videoCacheQueue.sort((left, right) => left.readyAt - right.readyAt);
    const next = videoCacheQueue[0];
    if (!next) return;
    if (next.readyAt > Date.now()) {
      sortAndScheduleVideoCacheQueue();
      return;
    }
    videoCacheQueue.shift();
    next.active = true;
    videoCacheActive = true;
    try {
      await copyVideoStartupToSharedCache(next);
    } catch (error) {
      console.warn("[short-video-cache]", next.file?.id || next.id, error.message || error);
    } finally {
      videoCacheJobs.delete(next.key);
      videoCacheActive = false;
      sortAndScheduleVideoCacheQueue();
    }
  }

  async function copyVideoStartupToSharedCache(job) {
    const { cacheDir, cachePath, expectedSize, prefixSize } = job.descriptor;
    const currentSourceStat = await fs.promises.stat(job.file.path).catch(() => null);
    if (!currentSourceStat?.isFile() || currentSourceStat.size !== expectedSize || prefixSize <= 0) return;
    const cachedStat = safeStat(cachePath);
    if (cachedStat?.isFile() && cachedStat.size === prefixSize) {
      sharedCache.touch(cachePath);
      return;
    }
    const tempPath = `${cachePath}.tmp-${process.pid}-${crypto.randomBytes(4).toString("hex")}`;
    await fs.promises.mkdir(cacheDir, { recursive: true });
    try {
      await pipeline(
        fs.createReadStream(job.file.path, { start: 0, end: prefixSize - 1 }),
        fs.createWriteStream(tempPath, { flags: "wx" })
      );
      const tempStat = await fs.promises.stat(tempPath);
      if (!tempStat.isFile() || tempStat.size !== prefixSize) throw new Error("启动片段缓存大小校验失败");
      await fs.promises.rm(cachePath, { force: true });
      await fs.promises.rename(tempPath, cachePath);
      sharedCache.touch(cachePath);
      sharedCache.scheduleCleanup();
    } finally {
      await fs.promises.rm(tempPath, { force: true }).catch(() => {});
    }
  }

  function sortAndScheduleSmoothVideoQueue() {
    if (smoothVideoTimer) clearTimeout(smoothVideoTimer);
    smoothVideoTimer = null;
    if (smoothVideoPausedByUser || smoothVideoActiveJobs.size >= smoothVideoConcurrency()) return;
    smoothVideoQueue.sort((left, right) => left.readyAt - right.readyAt);
    const next = smoothVideoQueue[0];
    if (!next) return;
    smoothVideoTimer = setTimeout(runSmoothVideoQueue, Math.max(0, next.readyAt - Date.now()));
    smoothVideoTimer.unref?.();
  }

  function runSmoothVideoQueue() {
    smoothVideoTimer = null;
    if (smoothVideoPausedByUser) return;
    smoothVideoQueue.sort((left, right) => left.readyAt - right.readyAt);
    while (smoothVideoActiveJobs.size < smoothVideoConcurrency()) {
      const next = smoothVideoQueue[0];
      if (!next) break;
      if (next.readyAt > Date.now()) break;
      smoothVideoQueue.shift();
      startSmoothVideoJob(next);
    }
    sortAndScheduleSmoothVideoQueue();
  }

  function startSmoothVideoJob(next) {
    next.active = true;
    next.startedAt = Date.now();
    next.progress = {
      phase: "preparing",
      durationMs: Math.max(0, Number(next.file?.durationMs || 0)),
      updatedAt: Date.now()
    };
    smoothVideoActiveJobs.set(next.key, next);
    void executeSmoothVideoJob(next);
  }

  async function executeSmoothVideoJob(next) {
    let outcome = null;
    try {
      outcome = await buildSmoothVideoCache(next);
    } catch (error) {
      outcome = {
        state: next.stoppedByUser ? "stopped" : "failed",
        reason: next.stoppedByUser
          ? "用户已停止后台转码，恢复后会重新排队"
          : String(error?.message || error || "转码失败")
      };
      if (!next.stoppedByUser) {
        console.warn("[short-video-smooth-cache]", next.file?.id || next.id, error.message || error);
      }
    } finally {
      recordSmoothVideoJobResult(next, outcome || { state: "skipped", reason: "任务没有生成流畅版缓存" });
      smoothVideoJobs.delete(next.key);
      smoothVideoActiveJobs.delete(next.key);
      smoothVideoChildren.delete(next.key);
      if (next.stoppedByUser && !smoothVideoCandidateIds.has(String(next.id))) {
        smoothVideoCandidateIds.add(String(next.id));
        smoothVideoCandidateBacklog.unshift(String(next.id));
      }
      fillSmoothVideoCandidateQueue();
      sortAndScheduleSmoothVideoQueue();
    }
  }

  async function buildSmoothVideoCache(job) {
    const { cacheDir, cachePath, expectedSize, skipPath } = job.descriptor;
    const currentSourceStat = await fs.promises.stat(job.file.path).catch(() => null);
    if (!currentSourceStat?.isFile() || currentSourceStat.size !== expectedSize) {
      return { state: "skipped", reason: "源文件不存在或已发生变化" };
    }
    if (safeStat(cachePath)?.size > 0) {
      rememberSmoothVideoResolved(job.id, job.descriptor, true);
      sharedCache.touch(cachePath);
      return { state: "cached", reason: "流畅版缓存已经存在" };
    }

    const inputAlias = await createSmoothVideoInputAlias(job.file.path);
    const mediaInputPath = inputAlias?.path || job.file.path;
    try {
    if (job.stoppedByUser) throw new Error("用户已停止后台转码");
    job.progress.phase = "probing";
    job.progress.updatedAt = Date.now();
    const storedProbe = storedSmoothVideoProbe(job.file);
    const probe = storedProbe || await probeSmoothVideo(mediaInputPath);
    if (!probe) return { state: "skipped", reason: "无法读取源视频编码信息" };
    if (!storedProbe) {
      try {
        const metadataUpdate = store.updateActualVideoPlaybackMetadata(job.id, probe);
        if (metadataUpdate?.changed) clearShortVideoListCache();
      } catch (error) {
        console.warn("[short-video-smooth-metadata]", job.id, error.message || error);
      }
    }
    const longEdge = Math.max(Number(probe.width || 0), Number(probe.height || 0));
    const codec = String(probe.codec || "").toLowerCase();
    const frameRate = Number(probe.frameRate || 0);
    const needsSmoothRendition = longEdge >= SHORT_VIDEO_SMOOTH_MIN_LONG_EDGE
      && (["hevc", "h265", "hev1", "hvc1"].includes(codec) || frameRate > 45);
    await fs.promises.mkdir(cacheDir, { recursive: true });
    if (!needsSmoothRendition) {
      await fs.promises.writeFile(skipPath, JSON.stringify({ codec, frameRate, longEdge }));
      smoothVideoCacheEntryNames.add(path.basename(skipPath));
      rememberSmoothVideoResolved(job.id, job.descriptor);
      sharedCache.touch(skipPath);
      job.progress.phase = "source-compatible";
      job.progress.updatedAt = Date.now();
      return { state: "source-compatible", reason: "源视频已经适合直接播放，无需转码" };
    }

    const tempPath = `${cachePath}.tmp-${process.pid}-${crypto.randomBytes(4).toString("hex")}.mp4`;
    const sourceBitRate = Math.max(0, Number(probe.bitRate || 0));
    const targetBitRate = Math.min(12_000_000, Math.max(3_000_000, Math.round(sourceBitRate * 1.15) || 6_000_000));
    const maxBitRate = Math.min(18_000_000, Math.max(targetBitRate, Math.round(targetBitRate * 1.5)));
    job.progress.phase = "transcoding";
    job.progress.targetBitRate = targetBitRate;
    job.progress.maxBitRate = maxBitRate;
    job.progress.updatedAt = Date.now();
    const args = [
      "-y", "-hide_banner", "-loglevel", "error", "-progress", "pipe:2", "-nostats", "-hwaccel", "auto",
      "-i", mediaInputPath,
      "-map", "0:v:0", "-map", "0:a:0?",
      "-vf", `scale=w='min(iw,${SHORT_VIDEO_SMOOTH_MAX_EDGE})':h='min(ih,${SHORT_VIDEO_SMOOTH_MAX_EDGE})':force_original_aspect_ratio=decrease:force_divisible_by=2,fps=${SHORT_VIDEO_SMOOTH_FPS}`
    ];
    if (hasNvenc) {
      args.push(
        "-c:v", "h264_nvenc", "-preset", "p4", "-tune", "hq",
        "-rc", "vbr", "-cq", "24", "-b:v", String(targetBitRate),
        "-maxrate", String(maxBitRate), "-bufsize", String(maxBitRate * 2)
      );
    } else {
      args.push("-c:v", "libx264", "-preset", "veryfast", "-crf", "23");
    }
    args.push(
      "-g", String(SHORT_VIDEO_SMOOTH_FPS),
      "-pix_fmt", "yuv420p",
      "-c:a", "aac", "-b:a", "160k",
      "-movflags", "+faststart",
      tempPath
    );

    try {
      await runMediaProcess(ffmpegPath, args, {
        trackJobKey: job.key,
        onProgress: (key, value) => updateSmoothVideoProgress(job, key, value)
      });
      job.progress.phase = "finalizing";
      job.progress.updatedAt = Date.now();
      const tempStat = await fs.promises.stat(tempPath);
      if (!tempStat.isFile() || tempStat.size <= 0) throw new Error("流畅播放缓存为空");
      await fs.promises.rm(cachePath, { force: true });
      await fs.promises.rename(tempPath, cachePath);
      smoothVideoCacheEntryNames.add(path.basename(cachePath));
      await fs.promises.rm(skipPath, { force: true }).catch(() => {});
      if (job.descriptor.legacyCachePath !== cachePath) {
        await fs.promises.rm(job.descriptor.legacyCachePath, { force: true }).catch(() => {});
      }
      rememberSmoothVideoResolved(job.id, job.descriptor, true);
      sharedCache.touch(cachePath);
      sharedCache.scheduleCleanup();
      job.progress.outTimeMs = Math.max(job.progress.outTimeMs || 0, Number(job.file.durationMs || 0));
      job.progress.outputBytes = tempStat.size;
      job.progress.phase = "completed";
      job.progress.updatedAt = Date.now();
      console.log(`[short-video-smooth-cache] ready id=${job.id} maxEdge=${SHORT_VIDEO_SMOOTH_MAX_EDGE} fps=${SHORT_VIDEO_SMOOTH_FPS} codec=h264 size=${tempStat.size}`);
      return { state: "completed", reason: "已生成 2K 30fps H.264 流畅版" };
    } finally {
      await fs.promises.rm(tempPath, { force: true }).catch(() => {});
    }
    } finally {
      await cleanupSmoothVideoInputAlias(inputAlias);
    }
  }

  function updateSmoothVideoProgress(job, key, value) {
    if (!job?.progress) return;
    const name = String(key || "").trim();
    const raw = String(value || "").trim();
    if (name === "frame") job.progress.frame = Math.max(0, Number(raw || 0));
    else if (name === "fps") job.progress.fps = Math.max(0, Number(raw || 0));
    else if (name === "speed") job.progress.speed = Math.max(0, Number.parseFloat(raw.replace(/x$/i, "")) || 0);
    else if (name === "total_size") job.progress.outputBytes = Math.max(0, Number(raw || 0));
    else if (name === "out_time") job.progress.outTimeMs = parseFfmpegProgressTime(raw);
    else if (name === "out_time_us" || name === "out_time_ms") {
      job.progress.outTimeMs = Math.max(job.progress.outTimeMs || 0, Number(raw || 0) / 1000);
    } else if (name === "progress" && raw === "end") {
      job.progress.phase = "finalizing";
    }
    job.progress.updatedAt = Date.now();
  }

  function parseFfmpegProgressTime(value) {
    const match = /^(\d+):(\d+):(\d+(?:\.\d+)?)$/.exec(String(value || "").trim());
    if (!match) return 0;
    return (Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3])) * 1000;
  }

  async function createSmoothVideoInputAlias(sourcePath) {
    if (process.platform !== "win32" || String(sourcePath || "").length < 240) return null;
    const resolvedSource = path.resolve(sourcePath);
    const sourceRoot = roots
      .map((root) => path.resolve(root))
      .find((root) => {
        const relative = path.relative(root, resolvedSource);
        return relative && !relative.startsWith("..") && !path.isAbsolute(relative);
      });
    const aliasDir = path.join(sourceRoot || path.dirname(resolvedSource), ".fanhao-ffmpeg");
    const extension = path.extname(resolvedSource).toLowerCase() || ".mp4";
    const aliasPath = path.join(aliasDir, `input-${process.pid}-${crypto.randomBytes(8).toString("hex")}${extension}`);
    await fs.promises.mkdir(aliasDir, { recursive: true });
    await fs.promises.link(resolvedSource, aliasPath);
    return { dir: aliasDir, path: aliasPath };
  }

  async function cleanupSmoothVideoInputAlias(alias) {
    if (!alias?.path) return;
    await fs.promises.rm(alias.path, { force: true }).catch(() => {});
    await fs.promises.rmdir(alias.dir).catch(() => {});
  }

  async function waitForSmoothVideoPlayback(id, file, timeoutMs) {
    const descriptor = smoothVideoCacheDescriptor(id, file);
    if (!descriptor) return false;
    const deadline = Date.now() + Math.max(0, Number(timeoutMs || 0));
    while (Date.now() <= deadline) {
      if (safeStat(descriptor.cachePath)?.size > 0 || safeStat(descriptor.skipPath)?.isFile()) return true;
      await new Promise((resolve) => setTimeout(resolve, SHORT_VIDEO_SMOOTH_ON_DEMAND_POLL_MS));
    }
    return false;
  }

  async function probeSmoothVideo(filePath) {
    try {
      const result = await runMediaProcess(ffprobePath, [
        "-v", "error",
        "-select_streams", "v:0",
        "-show_entries", "stream=codec_name,width,height,avg_frame_rate,r_frame_rate,bit_rate",
        "-of", "json",
        filePath
      ], { captureStdout: true });
      const stream = JSON.parse(result.stdout || "{}").streams?.[0] || {};
      return {
        codec: String(stream.codec_name || ""),
        width: Number(stream.width || 0),
        height: Number(stream.height || 0),
        frameRate: parseFrameRate(stream.avg_frame_rate || stream.r_frame_rate),
        bitRate: Number(stream.bit_rate || 0)
      };
    } catch (error) {
      console.warn("[short-video-smooth-probe]", error.message || error);
      return null;
    }
  }

  function storedSmoothVideoProbe(file = {}) {
    const codec = String(file.actualCodec || "").trim().toLowerCase();
    const frameRate = Math.max(0, Number(file.actualFrameRate || 0));
    const width = Math.max(0, Number(file.actualWidth || 0));
    const height = Math.max(0, Number(file.actualHeight || 0));
    if (!codec || frameRate <= 0 || width <= 0 || height <= 0) return null;
    return {
      codec,
      frameRate,
      width,
      height,
      bitRate: Math.max(0, Number(file.actualBitRate || 0)),
      source: "database"
    };
  }

  function parseFrameRate(value) {
    const text = String(value || "").trim();
    if (!text) return 0;
    const [numerator, denominator = "1"] = text.split("/");
    const result = Number(numerator) / Math.max(1, Number(denominator));
    return Number.isFinite(result) ? result : 0;
  }

  function runMediaProcess(command, args, options = {}) {
    return new Promise((resolve, reject) => {
      const child = spawn(command, args, {
        windowsHide: true,
        stdio: ["ignore", options.captureStdout ? "pipe" : "ignore", "pipe"]
      });
      if (options.trackJobKey) {
        smoothVideoChildren.set(options.trackJobKey, child);
        if (smoothVideoJobs.get(options.trackJobKey)?.stoppedByUser) child.kill("SIGKILL");
      }
      let stdout = "";
      let stderr = "";
      let progressBuffer = "";
      child.stdout?.on("data", (chunk) => {
        if (stdout.length < 2 * 1024 * 1024) stdout += String(chunk || "");
      });
      child.stderr?.on("data", (chunk) => {
        const text = String(chunk || "");
        if (stderr.length < 512 * 1024) stderr += text;
        if (typeof options.onProgress === "function") {
          progressBuffer += text;
          const lines = progressBuffer.split(/\r?\n/);
          progressBuffer = lines.pop() || "";
          for (const line of lines) {
            const separator = line.indexOf("=");
            if (separator <= 0) continue;
            try {
              options.onProgress(line.slice(0, separator), line.slice(separator + 1));
            } catch {}
          }
        }
      });
      child.once("error", reject);
      child.once("exit", (code) => {
        if (progressBuffer && typeof options.onProgress === "function") {
          const separator = progressBuffer.indexOf("=");
          if (separator > 0) {
            try {
              options.onProgress(progressBuffer.slice(0, separator), progressBuffer.slice(separator + 1));
            } catch {}
          }
        }
        if (code === 0) resolve({ stdout, stderr });
        else reject(new Error((stderr || `${path.basename(command)} 退出码 ${code}`).trim().slice(-1200)));
      });
    });
  }

  function stopVideoCacheQueue() {
    if (videoCacheTimer) clearTimeout(videoCacheTimer);
    videoCacheTimer = null;
    videoCacheQueue.length = 0;
    videoCacheJobs.clear();
  }

  function stopSmoothVideoQueue({ pause = true } = {}) {
    smoothVideoWarmupGeneration += 1;
    if (smoothVideoWarmupTimer) clearTimeout(smoothVideoWarmupTimer);
    smoothVideoWarmupTimer = null;
    if (smoothVideoCandidateFillImmediate) clearImmediate(smoothVideoCandidateFillImmediate);
    smoothVideoCandidateFillImmediate = null;
    smoothVideoCandidateRefill = null;
    if (smoothVideoTimer) clearTimeout(smoothVideoTimer);
    smoothVideoTimer = null;
    smoothVideoQueue.length = 0;
    smoothVideoJobs.clear();
    smoothVideoCandidateBacklog.length = 0;
    smoothVideoCandidateIds.clear();
    smoothVideoResolvedVersions.clear();
    smoothVideoRenditionVersions.clear();
    smoothVideoCandidateScanOffset = 0;
    smoothVideoCandidateScanComplete = true;
    if (pause) smoothVideoPausedByUser = true;
    for (const job of smoothVideoActiveJobs.values()) job.stoppedByUser = true;
    for (const child of smoothVideoChildren.values()) {
      if (child && !child.killed) child.kill("SIGKILL");
    }
    smoothVideoActiveJobs.clear();
    smoothVideoChildren.clear();
  }

  function normalizeSmoothVideoConcurrency(value) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return SHORT_VIDEO_SMOOTH_CONCURRENCY;
    return Math.min(SHORT_VIDEO_SMOOTH_MAX_CONCURRENCY, Math.max(1, Math.floor(parsed)));
  }

  function smoothVideoConcurrency() {
    try {
      return normalizeSmoothVideoConcurrency(getTranscodeConcurrency());
    } catch {
      return SHORT_VIDEO_SMOOTH_CONCURRENCY;
    }
  }

  function smoothVideoMaterializedJobLimit() {
    return Math.max(SHORT_VIDEO_SMOOTH_CACHE_CANDIDATES, smoothVideoConcurrency() + 1);
  }

  function smoothVideoMetadataNeedsRendition(video = {}) {
    const actual = video.actualVideo || {};
    const codec = String(actual.codec ?? video.actualCodec ?? "").trim().toLowerCase();
    const frameRate = Math.max(0, Number(actual.frameRate ?? video.actualFrameRate ?? 0));
    const longEdge = Math.max(
      Number(actual.longEdge ?? video.actualLongEdge ?? 0),
      Number(actual.width ?? video.actualWidth ?? video.width ?? 0),
      Number(actual.height ?? video.actualHeight ?? video.height ?? 0)
    );
    if (!codec || frameRate <= 0 || longEdge <= 0) return null;
    return longEdge >= SHORT_VIDEO_SMOOTH_MIN_LONG_EDGE
      && (["hevc", "h265", "hev1", "hvc1"].includes(codec) || frameRate > 45);
  }

  function isInitialVideoRange(rangeHeader) {
    return /^bytes=0-(?:\d*)$/i.test(String(rangeHeader || "").trim());
  }

  function hasIfRange(req) {
    return Boolean(String(req?.headers?.["if-range"] || "").trim());
  }

  function safeStat(filePath) {
    try {
      return fs.statSync(filePath);
    } catch {
      return null;
    }
  }

  function hashText(value) {
    return crypto.createHash("sha1").update(String(value)).digest("hex");
  }

  function safeFilePart(value) {
    return String(value || "").replace(/[^a-z0-9_-]+/gi, "-").slice(0, 96) || "short-video";
  }

  return {
    catalogWorkerDiagnostics: catalogWorker.diagnostics,
    clearListCache: clearShortVideoListCache,
    routeApi,
    routeMedia,
    smoothWarmupWorkerDiagnostics: smoothWarmupWorker.diagnostics,
    start: startDownloadManagerSync,
    stop: stopDownloadManagerSync,
    store,
    syncCatalog: (options = {}) => downloadManagerSync.sync(options)
  };
}

function serveShortVideoCoverBlob(res, file) {
  const buffer = Buffer.from(file.buffer || []);
  const version = String(file.cacheVersion || "").replace(/[^a-z0-9._-]+/gi, "-");
  res.writeHead(200, {
    "Content-Type": file.mimeType || "image/jpeg",
    "Content-Length": buffer.length,
    "Cache-Control": "private, max-age=31536000, immutable",
    "Content-Disposition": "inline",
    ...(version ? { ETag: `\"${version}\"` } : {})
  });
  res.end(buffer);
}
