import fs from "node:fs";
import path from "node:path";
import { createShortVideosRuntime } from "./runtime.js";
import { createFileServer } from "../../../platform/server/file-server.js";
import { createImageReaderCacheService } from "../../../platform/server/image-reader-cache-service.js";
import { readJsonBody } from "../../../platform/server/request-io.js";
import { sendJson, sendText, notFound } from "../../../platform/server/responses.js";
import { localImageDiskIdentity } from "../../../platform/server/local-image-read-queue.js";

// Both the aggregate application and the standalone entry use this composition.
// No FanHao catalogue, image database or user-state service is required.
export function createShortVideoProduct({ config, requireLocalAdmin }) {
  const normalizeExt = (file) => path.extname(file).toLowerCase();
  const files = createFileServer({
    defaultChunkBytes: config.DEFAULT_VIDEO_CHUNK_BYTES,
    mimeTypes: config.MIME_TYPES, normalizeExt, notFound
  });
  const images = {
    async serveImageAsync(res, file, { signal } = {}) {
      if (signal?.aborted || res.destroyed || res.writableEnded) return;
      const sourceCurrent = () => {
        try { return !file.isCurrentSource || file.isCurrentSource(); }
        catch { return false; }
      };
      try {
        await files.serveInlineFile(res, file.path, "", {
          signal,
          isCurrent: sourceCurrent,
          throwFileErrors: true,
          validateFile(stat) {
            if (file.diskIdentity && file.diskIdentity !== localImageDiskIdentity(file.path, stat)) {
              throw Object.assign(new Error("Local image source changed"), { statusCode: 404 });
            }
          }
        });
      } catch (error) {
        if (signal?.aborted || res.destroyed || res.writableEnded) return;
        if (res.headersSent) { res.destroy(); return; }
        if (!sourceCurrent() || error.statusCode === 404 || error.code === "ENOENT" || error.code === "ENOTDIR") notFound(res);
        else sendText(res, 500, "Local image read failed");
      }
    }
  };
  const cache = createImageReaderCacheService({
    rootDir: path.join(path.dirname(config.SHORT_VIDEO_DB_PATH), "short-video-cache"),
    cleanupIntervalMs: config.IMAGE_READER_CACHE_CLEANUP_INTERVAL_MS,
    cleanupTargetRatio: config.IMAGE_READER_CACHE_CLEANUP_TARGET_RATIO,
    getMaxBytes: () => config.DEFAULT_IMAGE_READER_CACHE_MAX_BYTES,
    touchThrottleMs: config.IMAGE_READER_CACHE_TOUCH_THROTTLE_MS
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
  let lifecycleGeneration = 0, stopping = null;
  const stoppedError = () => Object.assign(new Error("Short-video product is stopping"), { code: "SHORT_VIDEO_PRODUCT_STOPPED", statusCode: 503 });
  function stopProduct() {
    lifecycleGeneration++;
    files.beginStop();
    cache.beginStop?.();
    if (!stopping) stopping = (async () => {
      const results = await Promise.allSettled([files.stop(), runtime.stop?.(), cache.stop()]);
      const failures = results.filter(result => result.status === "rejected").map(result => result.reason);
      if (failures.length === 1) throw failures[0];
      if (failures.length > 1) throw new AggregateError(failures, "Short-video product resources failed to stop");
    })();
    return stopping;
  }
  return {
    ...runtime,
    async start() {
      const intent = lifecycleGeneration;
      // Resource start methods check current physical owners themselves; a
      // previous stop error must not permanently prevent later recovery.
      if (stopping) await stopping.catch(() => undefined);
      if (intent !== lifecycleGeneration) throw stoppedError();
      stopping = null;
      try {
        const filesStarted = await files.start();
        if (intent !== lifecycleGeneration || filesStarted === false) throw stoppedError();
        const runtimeStarted = await runtime.start?.();
        if (intent !== lifecycleGeneration || runtimeStarted === false) throw stoppedError();
        await cache.start?.({ backgroundInventory: true });
        if (intent !== lifecycleGeneration) throw stoppedError();
      } catch (error) {
        files.beginStop();
        cache.beginStop?.();
        throw error;
      }
      stopping = null;
      cache.startCleanupTimer();
    },
    beginStop: stopProduct,
    stop: stopProduct,
    fileServerDiagnostics: files.diagnostics
  };
}

function normalizeConcurrency(value) {
  return Math.max(1, Math.min(4, Math.floor(Number(value) || 2)));
}
