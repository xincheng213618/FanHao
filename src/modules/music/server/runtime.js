import { createMusicStore } from "./store.js";
import { routeMusicApi } from "./routes.js";

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
  scanWorkerOptions = {}
}) {
  const store = createMusicStore({ dbPath, ffprobePath, roots, ...scanWorkerOptions });
  let stopping = null;

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
      const file = store.coverFile(decodeURIComponent(coverMatch[1]));
      if (!file || file.type !== "image") {
        notFound(res);
        return true;
      }
      mediaResponseService.serveImage(res, file);
      return true;
    }

    const trackMatch = /^\/media\/music\/([^/]+)$/.exec(url.pathname);
    if (trackMatch && (req.method === "GET" || req.method === "HEAD")) {
      const file = store.trackFile(decodeURIComponent(trackMatch[1]));
      if (!file || file.type !== "audio") {
        notFound(res);
        return true;
      }
      mediaStreamService.serveVideo(req, res, { ...file, maxRangeBytes: MUSIC_STREAM_CHUNK_BYTES });
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
      serveDownloadFile(req, res, file, musicDownloadFileName(detail.track, file));
      return true;
    }

    return false;
  }

  function invalidate() {
    store.invalidate();
  }

  function start() {
    return store.start();
  }

  function stopMusic() {
    if (!stopping) {
      stopping = Promise.resolve()
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
    store
  };
}

function musicDownloadFileName(track = {}, file = {}) {
  const ext = file.ext || "";
  const base = [track.artist || "", track.title || file.id || "music"].filter(Boolean).join(" - ");
  const clean = base.replace(/[<>:"/\\|?*\u0000-\u001f]+/g, " ").replace(/\s+/g, " ").trim() || "music";
  return `${clean}${ext && !clean.toLowerCase().endsWith(ext.toLowerCase()) ? ext : ""}`;
}
