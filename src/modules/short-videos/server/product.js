import fs from "node:fs";
import path from "node:path";
import { createShortVideosRuntime } from "./runtime.js";
import { createFileServer } from "../../../platform/server/file-server.js";
import { createImageReaderCacheService } from "../../../platform/server/image-reader-cache-service.js";
import { readJsonBody } from "../../../platform/server/request-io.js";
import { sendJson, notFound } from "../../../platform/server/responses.js";

// Both the aggregate application and the standalone entry use this composition.
// No FanHao catalogue, image database or user-state service is required.
export function createShortVideoProduct({ config, requireLocalAdmin }) {
  const safeStat = (file) => { try { return fs.statSync(file); } catch { return null; } };
  const normalizeExt = (file) => path.extname(file).toLowerCase();
  const files = createFileServer({
    defaultChunkBytes: config.DEFAULT_VIDEO_CHUNK_BYTES,
    mimeTypes: config.MIME_TYPES, normalizeExt, notFound, safeStat
  });
  const images = { serveImage: (res, file) => files.serveInlineFile(res, file.path, config.MIME_TYPES[normalizeExt(file.path)]) };
  const cache = createImageReaderCacheService({
    rootDir: path.join(path.dirname(config.SHORT_VIDEO_DB_PATH), "short-video-cache"),
    cleanupIntervalMs: config.IMAGE_READER_CACHE_CLEANUP_INTERVAL_MS,
    cleanupTargetRatio: config.IMAGE_READER_CACHE_CLEANUP_TARGET_RATIO,
    getMaxBytes: () => config.DEFAULT_IMAGE_READER_CACHE_MAX_BYTES,
    touchThrottleMs: config.IMAGE_READER_CACHE_TOUCH_THROTTLE_MS,
    safeStat
  });
  const settingsPath = path.join(path.dirname(config.SHORT_VIDEO_DB_PATH), "short-video-settings.json");
  let concurrency = 2;
  // Read the former suite setting once as a fallback; all new writes are owned
  // by this product, including when it is composed into the suite.
  try { concurrency = normalizeConcurrency(JSON.parse(fs.readFileSync(config.APP_CONFIG_PATH, "utf8")).shortVideoTranscodeConcurrency); } catch {}
  try { concurrency = normalizeConcurrency(JSON.parse(fs.readFileSync(settingsPath, "utf8")).transcodeConcurrency); } catch {}
  const runtime = createShortVideosRuntime({
    dbPath: config.SHORT_VIDEO_DB_PATH, roots: config.SHORT_VIDEO_ROOTS,
    downloadManagerDbPath: config.SHORT_VIDEO_DOWNLOAD_MANAGER_DB_PATH,
    downloadManagerUrl: config.SHORT_VIDEO_DOWNLOAD_MANAGER_URL,
    downloadManagerSyncMs: config.SHORT_VIDEO_DOWNLOAD_MANAGER_SYNC_MS,
    ffmpegPath: config.FFMPEG_PATH, ffprobePath: config.FFPROBE_PATH, hasNvenc: config.HAS_NVENC,
    mediaResponseService: images, mediaStreamService: { serveVideo: files.serveRangedFile },
    serveDownloadFile: files.serveDownloadFile, sharedCache: cache,
    notFound, readJsonBody, requireLocalAdmin, sendJson,
    getTranscodeConcurrency: () => concurrency,
    setTranscodeConcurrency(value) {
      const next = normalizeConcurrency(value);
      fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
      const temporary = `${settingsPath}.${process.pid}.tmp`;
      fs.writeFileSync(temporary, JSON.stringify({ transcodeConcurrency: next }));
      fs.renameSync(temporary, settingsPath);
      concurrency = next;
      return next;
    }
  });
  return {
    ...runtime,
    async start() { await runtime.start?.(); cache.startCleanupTimer(); },
    async beginStop() { cache.stop(); await runtime.beginStop?.(); },
    async stop() { cache.stop(); await runtime.stop?.(); }
  };
}

function normalizeConcurrency(value) {
  return Math.max(1, Math.min(4, Math.floor(Number(value) || 2)));
}
