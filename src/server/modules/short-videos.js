import { createShortVideoStore } from "../short-video-store.js";
import { routeShortVideoApi } from "../routes/short-video-api.js";

export function createShortVideosModule({
  dbPath,
  ffmpegPath,
  roots,
  notFound,
  readJsonBody,
  requireLocalAdmin,
  sendJson,
  serveImage,
  serveVideo
}) {
  const store = createShortVideoStore({ dbPath, ffmpegPath, roots });

  async function routeApi(req, res, url) {
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
      const file = store.videoFile(decodeURIComponent(videoMatch[1]));
      if (!file || file.type !== "video") {
        notFound(res);
        return true;
      }
      serveVideo(req, res, file);
      return true;
    }

    return false;
  }

  return {
    routeApi,
    routeMedia,
    store
  };
}
