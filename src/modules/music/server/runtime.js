import { createMusicStore } from "./store.js";
import { routeMusicApi } from "./routes.js";
import { boundedInteger } from "../../../platform/server/local-image-read-queue.js";

const MUSIC_STREAM_CHUNK_BYTES = 2 * 1024 * 1024;

export function createMusicRuntime({
  dbPath,
  ffprobePath,
  mediaResponseService,
  mediaStreamService,
  serveDownloadFile,
  notFound,
  readJsonBody,
  requireLocalAdmin,
  roots,
  sendJson,
  scanWorkerOptions = {},
  coverRequestConcurrency = 4,
  coverRequestCapacity = 128
}) {
  const store = createMusicStore({ dbPath, ffprobePath, roots, ...scanWorkerOptions });
  let stopping = null;
  let acceptingCovers = true;
  let lifecycleGeneration = 0;
  const coverResponses = new Set();
  const coverTasks = new Set();
  const coverJobs = new Set();
  const coverQueue = [];
  let coverActive = 0;
  const coverConcurrency = boundedInteger(coverRequestConcurrency, 4, 1, 16);
  const coverCapacity = boundedInteger(coverRequestCapacity, 128, coverConcurrency, 512);

  async function routeApi(req, res, url) {
    return routeMusicApi(req, res, url, {
      musicStore: store,
      notFound,
      readJsonBody,
      requireLocalAdmin,
      sendJson
    });
  }

  async function routeMedia(req, res, url) {
    const coverMatch = /^\/media\/music-cover\/([^/]+)$/.exec(url.pathname);
    if (coverMatch && req.method === "GET") {
      if (!acceptingCovers) {
        sendJson(res, 503, { error: "音乐服务正在停止" });
        return true;
      }
      if (res.destroyed || res.writableEnded) return true;
      if (coverTasks.size >= coverCapacity) { sendJson(res, 503, { error: "音乐封面队列已满，请稍后重试" }); return true; }
      const albumId = decodeURIComponent(coverMatch[1]);
      const intent = lifecycleGeneration;
      const controller = new AbortController();
      let job;
      const disconnect = () => {
        if (res.writableEnded) return;
        controller.abort();
        if (job?.phase === "queued") {
          const index = coverQueue.indexOf(job);
          if (index >= 0) coverQueue.splice(index, 1);
          job.phase = "settled"; job.resolve();
        }
      };
      req.once?.("aborted", disconnect);
      res.once?.("close", disconnect);
      const task = new Promise((resolve, reject) => {
        job = { albumId, res, controller, intent, resolve, reject, phase: "queued", cancel: disconnect };
      });
      coverResponses.add(res);
      coverTasks.add(task);
      coverJobs.add(job);
      coverQueue.push(job);
      if (req.aborted) disconnect();
      drainCoverQueue();
      try {
        await task;
      } finally {
        coverResponses.delete(res);
        coverTasks.delete(task);
        coverJobs.delete(job);
        req.removeListener?.("aborted", disconnect);
        res.removeListener?.("close", disconnect);
      }
      return true;
    }

    const trackMatch = /^\/media\/music\/([^/]+)$/.exec(url.pathname);
    if (trackMatch && (req.method === "GET" || req.method === "HEAD")) {
      const file = store.trackFile(decodeURIComponent(trackMatch[1]));
      if (!file || file.type !== "audio") {
        notFound(res);
        return true;
      }
      await mediaStreamService.serveVideo(req, res, { ...file, maxRangeBytes: MUSIC_STREAM_CHUNK_BYTES });
      return true;
    }

    const downloadMatch = /^\/media\/music-download\/([^/]+)$/.exec(url.pathname);
    if (downloadMatch && (req.method === "GET" || req.method === "HEAD")) {
      const trackId = decodeURIComponent(downloadMatch[1]);
      const file = store.trackFile(trackId);
      const detail = store.trackDetail(trackId);
      if (!file || file.type !== "audio" || !detail?.track) {
        notFound(res);
        return true;
      }
      await serveDownloadFile(req, res, file, musicDownloadFileName(detail.track, file));
      return true;
    }

    return false;
  }

  function drainCoverQueue() {
    while (acceptingCovers && coverActive < coverConcurrency && coverQueue.length) {
      const job = coverQueue.shift(); job.phase = "active"; coverActive++;
      serveCover(job).then(job.resolve, job.reject).finally(() => { coverActive--; job.phase = "settled"; drainCoverQueue(); });
    }
  }

  async function serveCover({ albumId, res, controller, intent }) {
    // Metadata stat shares this admission bound with the subsequent image
    // read. A cancelled stat retains its slot until the OS promise settles.
    const file = await store.coverFileAsync(albumId);
    if (controller.signal.aborted || res.destroyed || res.writableEnded) return;
    if (!acceptingCovers || intent !== lifecycleGeneration) { sendJson(res, 503, { error: "音乐服务正在停止" }); return; }
    if (!file || file.type !== "image") { notFound(res); return; }
    await mediaResponseService.serveImageAsync(res, file, { signal: controller.signal });
  }

  function invalidate() {
    store.invalidate();
  }

  async function start() {
    const intent = ++lifecycleGeneration;
    if (stopping) await stopping;
    if (intent !== lifecycleGeneration) throw Object.assign(new Error("音乐服务正在停止"), { statusCode: 503 });
    await store.start();
    if (intent !== lifecycleGeneration) throw Object.assign(new Error("音乐服务正在停止"), { statusCode: 503 });
    acceptingCovers = true;
  }

  function stopMusic() {
    lifecycleGeneration += 1;
    acceptingCovers = false;
    // HTTP close may be emitted later than destroy(); revoke every consumer
    // synchronously, retaining active physical I/O until its promise settles.
    for (const job of coverJobs) job.cancel();
    for (const response of coverResponses) if (!response.destroyed) response.destroy();
    if (!stopping) {
      stopping = Promise.resolve()
        .then(async () => {
          // Keep the shared cache database alive until dispatched reads have
          // completed. A disconnected response must not leave a late cache
          // write running after the platform's database shutdown.
          await Promise.allSettled([...coverTasks]);
        })
        .then(() => store.stop())
        .finally(() => {
          stopping = null;
        });
    }
    return stopping;
  }

  function beginStop() {
    return stopMusic();
  }

  function stop() {
    return stopMusic();
  }

  return {
    beginStop,
    invalidate,
    routeApi,
    routeMedia,
    start,
    stop,
    store,
    coverDiagnostics: () => ({ accepting: acceptingCovers, active: coverActive, pending: coverQueue.length, retained: coverTasks.size })
  };
}

function musicDownloadFileName(track = {}, file = {}) {
  const ext = file.ext || "";
  const base = [track.artist || "", track.title || file.id || "music"].filter(Boolean).join(" - ");
  const clean = base.replace(/[<>:"/\\|?*\u0000-\u001f]+/g, " ").replace(/\s+/g, " ").trim() || "music";
  return `${clean}${ext && !clean.toLowerCase().endsWith(ext.toLowerCase()) ? ext : ""}`;
}
