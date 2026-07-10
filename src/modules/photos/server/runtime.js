import { routePhotosApi } from "./routes.js";

export function createPhotosRuntime(deps) {
  async function routeApi(req, res, url) {
    return routePhotosApi(req, res, url, deps);
  }

  async function routeMedia(req, res, url) {
    const photoSetCoverMatch = /^\/media\/gallery-cover\/([^/]+)$/.exec(url.pathname);
    if (photoSetCoverMatch && req.method === "GET") {
      deps.photoSetService.serveCover(res, decodeURIComponent(photoSetCoverMatch[1]));
      return true;
    }

    const mangaImageMatch = /^\/media\/manga\/([^/]+)\/([^/]+)\/([^/]+)$/.exec(url.pathname);
    if (mangaImageMatch && req.method === "GET") {
      deps.mangaService.serveImage(res, mangaImageMatch[1], mangaImageMatch[2], mangaImageMatch[3]);
      return true;
    }

    const photoSetImageMatch = /^\/media\/gallery\/([^/]+)\/([^/]+)$/.exec(url.pathname);
    if (photoSetImageMatch && req.method === "GET") {
      deps.photoSetService.serveImage(res, photoSetImageMatch[1], photoSetImageMatch[2]);
      return true;
    }

    return false;
  }

  return { routeApi, routeMedia };
}
