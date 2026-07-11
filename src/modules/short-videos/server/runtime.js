import { createShortVideoStore } from "./store.js";
import { routeShortVideoApi } from "./routes.js";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const SHORT_VIDEO_STREAM_CHUNK_BYTES = 2 * 1024 * 1024;
const SHORT_VIDEO_LIST_CACHE_TTL_MS = 2 * 60 * 1000;

export function createShortVideosRuntime({
  dbPath,
  ffmpegPath,
  roots,
  downloadManagerDbPath,
  downloadManagerSyncMs,
  mediaResponseService,
  mediaStreamService,
  notFound,
  readJsonBody,
  requireLocalAdmin,
  sendJson,
  sharedCache
}) {
  const store = createShortVideoStore({ dbPath, ffmpegPath, roots });
  try {
    store.warm();
  } catch (error) {
    console.warn("[short-video-warmup]", error?.message || error);
  }
  let initialSyncTimer = null;
  let syncTimer = null;

  async function routeApi(req, res, url) {
    if (url.pathname === "/api/short-videos" && req.method === "GET" && sharedCache) {
      const cachePath = listCachePath(url);
      const forceRefresh = String(url.searchParams.get("refresh") || "").trim() === "1";
      if (!forceRefresh) {
        const cached = readJsonCache(cachePath, SHORT_VIDEO_LIST_CACHE_TTL_MS);
        if (cached) {
          sendJson(res, 200, { ...cached, cached: true });
          return true;
        }
      }
      try {
        const data = store.listVideos(url);
        writeJsonCache(cachePath, data);
        sendJson(res, 200, data);
      } catch (error) {
        const cached = readJsonCache(cachePath);
        if (cached) {
          sendJson(res, 200, { ...cached, cached: true, offline: true });
        } else {
          sendJson(res, shortVideoErrorStatus(error), { error: shortVideoErrorMessage(error, "短视频列表读取失败") });
        }
      }
      return true;
    }

    return routeShortVideoApi(req, res, url, {
      notFound,
      readJsonBody,
      requireLocalAdmin,
      sendJson,
      shortVideoStore: store,
      onMutation: clearShortVideoListCache
    });
  }

  async function routeMedia(req, res, url) {
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
        file.maxRangeBytes = SHORT_VIDEO_STREAM_CHUNK_BYTES;
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
      mediaResponseService.serveImage(res, file);
      return true;
    }

    const videoMatch = /^\/media\/short-video\/([^/]+)$/.exec(url.pathname);
    if (videoMatch && (req.method === "GET" || req.method === "HEAD")) {
      const id = decodeURIComponent(videoMatch[1]);
      const file = req.method === "HEAD" ? store.videoFile(id, { allowMissing: true }) : videoFileWithCache(id);
      if (!file || file.type !== "video") {
        notFound(res);
        return true;
      }
      const requestedVersion = String(url.searchParams.get("v") || "").trim();
      const currentVersion = String(file.cacheVersion || "").trim();
      file.cacheControl = requestedVersion && currentVersion && requestedVersion === currentVersion
        ? "private, max-age=31536000, immutable"
        : "private, max-age=0, must-revalidate";
      const mediaCacheRequest = String(req.headers["x-fanhao-media-cache"] || "").trim() === "1"
        || String(url.searchParams.get("fhcache") || "").trim() === "1";
      file.maxRangeBytes = mediaCacheRequest ? 0 : SHORT_VIDEO_STREAM_CHUNK_BYTES;
      file.fullResponse = mediaCacheRequest;
      mediaStreamService.serveVideo(req, res, file);
      return true;
    }

    return false;
  }

  function listCachePath(url) {
    const normalized = new URLSearchParams(url.searchParams);
    normalized.delete("refresh");
    normalized.sort?.();
    const hash = hashText(`${url.pathname}?${normalized.toString()}`);
    return path.join(sharedCache.rootDir, "short-videos", "lists", `${hash}.json`);
  }

  function writeJsonCache(filePath, data) {
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, JSON.stringify({ ...data, cachedAt: new Date().toISOString() }));
      sharedCache.touch(filePath);
      sharedCache.scheduleCleanup();
    } catch (error) {
      console.warn("[short-video-list-cache]", error.message || error);
    }
  }

  function readJsonCache(filePath, maxAgeMs = 0) {
    try {
      if (!fs.existsSync(filePath)) return null;
      const stat = fs.statSync(filePath);
      if (maxAgeMs > 0 && Date.now() - Number(stat.mtimeMs || 0) > maxAgeMs) return null;
      sharedCache.touch(filePath);
      return JSON.parse(fs.readFileSync(filePath, "utf8"));
    } catch {
      return null;
    }
  }

  function startDownloadManagerSync() {
    if (initialSyncTimer || syncTimer) return;
    const sourceDbPath = String(downloadManagerDbPath || "").trim();
    const intervalMs = Number(downloadManagerSyncMs || 0);
    if (!sourceDbPath || !Number.isFinite(intervalMs) || intervalMs < 60000) return;
    const run = () => syncDownloadManagerDb(sourceDbPath);
    initialSyncTimer = setTimeout(() => {
      initialSyncTimer = null;
      run();
    }, Math.min(30000, intervalMs));
    initialSyncTimer.unref?.();
    syncTimer = setInterval(run, intervalMs);
    syncTimer.unref?.();
  }

  function stopDownloadManagerSync() {
    if (initialSyncTimer) clearTimeout(initialSyncTimer);
    if (syncTimer) clearInterval(syncTimer);
    initialSyncTimer = null;
    syncTimer = null;
  }

  let syncRunning = false;
  let lastSourceStateKey = "";
  function syncDownloadManagerDb(sourceDbPath) {
    if (syncRunning) return;
    const sourceStateKey = sourceDbStateKey(sourceDbPath);
    if (!sourceStateKey) return;
    if (sourceStateKey === lastSourceStateKey) return;
    syncRunning = true;
    try {
      const result = store.importDownloadManagerDb(sourceDbPath, { incremental: true, includePosts: true, skipSummary: true });
      lastSourceStateKey = sourceStateKey;
      if (result.imported || result.updated) {
        clearShortVideoListCache();
        console.log(`[short-video-sync] imported=${result.imported} updated=${result.updated} backfill=${result.backfillRows || 0} total=${result.summary?.totals?.videos ?? ""}`);
      }
    } catch (error) {
      console.warn("[short-video-sync]", error.message || error);
    } finally {
      syncRunning = false;
    }
  }

  function sourceDbStateKey(sourceDbPath) {
    const files = [sourceDbPath, `${sourceDbPath}-wal`, `${sourceDbPath}-shm`];
    const parts = [];
    for (const filePath of files) {
      const stat = safeStat(filePath);
      if (!stat?.isFile()) continue;
      parts.push(`${path.basename(filePath)}:${stat.size}:${Math.floor(stat.mtimeMs || 0)}`);
    }
    return parts.length ? parts.join("|") : "";
  }

  function clearShortVideoListCache() {
    if (!sharedCache?.rootDir) return;
    try {
      fs.rmSync(path.join(sharedCache.rootDir, "short-videos", "lists"), { recursive: true, force: true });
    } catch {}
  }

  function videoFileWithCache(id) {
    const file = store.videoFile(id, { allowMissing: true });
    const cached = cachedVideoFile(id, file);
    if (cached) return cached;
    return store.videoFile(id);
  }

  function cachedVideoFile(id, file) {
    if (!sharedCache || !file?.path) return null;
    const safeId = safeFilePart(file.id || id || "short-video");
    const ext = file.ext || path.extname(file.path).toLowerCase() || ".mp4";
    const sourceStat = safeStat(file.path);
    const cacheDir = path.join(sharedCache.rootDir, "short-videos", "videos");
    const cachePath = sourceStat
      ? path.join(cacheDir, `${safeId}-${hashText(`${file.path}:${sourceStat.size}:${Math.floor(sourceStat.mtimeMs || 0)}`).slice(0, 18)}${ext}`)
      : latestCachedVideo(cacheDir, safeId);

    if (!cachePath) return null;
    const cachedStat = safeStat(cachePath);
    if (cachedStat?.isFile() && (!sourceStat || cachedStat.size === sourceStat.size)) {
      sharedCache.touch(cachePath);
      return { ...file, path: cachePath, ext, type: "video", cached: true };
    }
    if (!sourceStat?.isFile()) return null;

    const tempPath = `${cachePath}.tmp-${process.pid}`;
    try {
      fs.mkdirSync(cacheDir, { recursive: true });
      fs.rmSync(tempPath, { force: true });
      fs.copyFileSync(file.path, tempPath);
      fs.rmSync(cachePath, { force: true });
      fs.renameSync(tempPath, cachePath);
      sharedCache.touch(cachePath);
      sharedCache.scheduleCleanup();
      return { ...file, path: cachePath, ext, type: "video", cached: true };
    } catch (error) {
      try {
        fs.rmSync(tempPath, { force: true });
      } catch {}
      console.warn("[short-video-cache]", file.id || id, error.message || error);
      return null;
    }
  }

  function latestCachedVideo(cacheDir, safeId) {
    try {
      const prefix = `${safeId}-`;
      return fs.readdirSync(cacheDir)
        .filter((name) => name.startsWith(prefix))
        .map((name) => {
          const filePath = path.join(cacheDir, name);
          const stat = safeStat(filePath);
          return stat?.isFile() ? { path: filePath, mtimeMs: stat.mtimeMs || 0 } : null;
        })
        .filter(Boolean)
        .sort((a, b) => b.mtimeMs - a.mtimeMs)[0]?.path || "";
    } catch {
      return "";
    }
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

  function shortVideoErrorStatus(error) {
    if (isShortVideoDatabaseError(error)) return 503;
    return error.statusCode || 500;
  }

  function shortVideoErrorMessage(error, fallback) {
    if (isShortVideoDatabaseError(error)) return "短视频数据库正在恢复，请稍后重试";
    return error.message || fallback;
  }

  function isShortVideoDatabaseError(error) {
    const message = String(error?.message || error || "");
    return /database disk image|malformed|sqlite/i.test(message);
  }

  return {
    clearListCache: clearShortVideoListCache,
    routeApi,
    routeMedia,
    start: startDownloadManagerSync,
    stop: stopDownloadManagerSync,
    store
  };
}
