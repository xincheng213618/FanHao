import { createMusicStore } from "../music-store.js";
import { routeMusicApi } from "../routes/music-api.js";

export function createMusicModule({
  dbPath,
  ffprobePath,
  mediaResponseService,
  mediaStreamService,
  notFound,
  readJsonBody,
  requireLocalAdmin,
  roots,
  sendJson
}) {
  const store = createMusicStore({ dbPath, ffprobePath, roots });

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
      mediaStreamService.serveVideo(req, res, file);
      return true;
    }

    return false;
  }

  function invalidate() {
    store.invalidate();
  }

  return {
    invalidate,
    routeApi,
    routeMedia,
    store
  };
}
