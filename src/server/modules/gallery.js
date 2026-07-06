import { routeGalleryApi } from "../routes/gallery-api.js";

export function createGalleryModule(deps) {
  async function routeApi(req, res, url) {
    return routeGalleryApi(req, res, url, deps);
  }

  async function routeMedia(req, res, url) {
    const photoSetCoverMatch = /^\/media\/gallery-cover\/([^/]+)$/.exec(url.pathname);
    if (photoSetCoverMatch && req.method === "GET") {
      deps.photoSetService.serveCover(res, decodeURIComponent(photoSetCoverMatch[1]));
      return true;
    }

    const tvSeriesCoverMatch = /^\/media\/tv-series-cover\/([^/]+)$/.exec(url.pathname);
    if (tvSeriesCoverMatch && req.method === "GET") {
      deps.galleryMetadataService.serveTvSeriesCover(res, decodeURIComponent(tvSeriesCoverMatch[1]));
      return true;
    }

    const movieCoverMatch = /^\/media\/movie-cover\/([^/]+)$/.exec(url.pathname);
    if (movieCoverMatch && req.method === "GET") {
      deps.galleryMetadataService.serveMovieCover(res, decodeURIComponent(movieCoverMatch[1]));
      return true;
    }

    const galleryMediaCoverMatch = /^\/media\/gallery-media-cover\/([^/]+)$/.exec(url.pathname);
    if (galleryMediaCoverMatch && req.method === "GET") {
      deps.galleryMediaService.serveCover(res, galleryMediaCoverMatch[1]);
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

    const galleryVideoTranscodeMatch = /^\/media\/gallery-video\/([^/]+)\/transcode$/.exec(url.pathname);
    if (galleryVideoTranscodeMatch && req.method === "GET") {
      const file = deps.galleryMediaService.videoFile(deps.galleryMediaService.byId(decodeURIComponent(galleryVideoTranscodeMatch[1])));
      if (!file || file.type !== "video") {
        deps.notFound(res);
        return true;
      }

      deps.serveTranscodedVideo(req, res, file, url);
      return true;
    }

    const galleryVideoMatch = /^\/media\/gallery-video\/([^/]+)$/.exec(url.pathname);
    if (galleryVideoMatch && req.method === "GET") {
      deps.galleryMediaService.serveMedia(req, res, galleryVideoMatch[1]);
      return true;
    }

    return false;
  }

  return {
    routeApi,
    routeMedia
  };
}
