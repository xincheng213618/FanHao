import { createShortVideoStore } from "../short-video-store.js";
import { routeShortVideoApi } from "../routes/short-video-api.js";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export function createShortVideosModule({
  dbPath,
  ffmpegPath,
  roots,
  notFound,
  readJsonBody,
  requireLocalAdmin,
  sendJson,
  serveImage,
  serveVideo,
  sharedCache
}) {
  const store = createShortVideoStore({ dbPath, ffmpegPath, roots });

  async function routeApi(req, res, url) {
    if (url.pathname === "/api/short-videos" && req.method === "GET" && sharedCache) {
      const cachePath = listCachePath(url);
      try {
        const data = store.listVideos(url);
        writeJsonCache(cachePath, data);
        sendJson(res, 200, data);
      } catch (error) {
        const cached = readJsonCache(cachePath);
        if (cached) {
          sendJson(res, 200, { ...cached, cached: true, offline: true });
        } else {
          sendJson(res, error.statusCode || 500, { error: error.message || "短视频列表读取失败" });
        }
      }
      return true;
    }

    return routeShortVideoApi(req, res, url, {
      notFound,
      readJsonBody,
      requireLocalAdmin,
      sendJson,
      shortVideoStore: store
    });
  }

  async function routeMedia(req, res, url) {
    const coverMatch = /^\/media\/short-video-cover\/([^/]+)$/.exec(url.pathname);
    if (coverMatch && req.method === "GET") {
      const file = store.coverFile(decodeURIComponent(coverMatch[1]));
      if (!file || file.type !== "image") {
        notFound(res);
        return true;
      }
      serveImage(res, file);
      return true;
    }

    const videoMatch = /^\/media\/short-video\/([^/]+)$/.exec(url.pathname);
    if (videoMatch && req.method === "GET") {
      const file = videoFileWithCache(decodeURIComponent(videoMatch[1]));
      if (!file || file.type !== "video") {
        notFound(res);
        return true;
      }
      serveVideo(req, res, file);
      return true;
    }

    return false;
  }

  function listCachePath(url) {
    const normalized = new URLSearchParams(url.searchParams);
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

  function readJsonCache(filePath) {
    try {
      if (!fs.existsSync(filePath)) return null;
      sharedCache.touch(filePath);
      return JSON.parse(fs.readFileSync(filePath, "utf8"));
    } catch {
      return null;
    }
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

  return {
    routeApi,
    routeMedia,
    store
  };
}
