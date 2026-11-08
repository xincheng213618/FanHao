import { routePhotosApi } from "./routes.js";
import { createPhotosSettingsProvider } from "./settings.js";
import { createPhotoCatalogService } from "./photo-catalog-service.js";
import { createPhotoCatalogIntake } from "./photo-catalog-intake.js";
import { createPhotoCoverWarmJob } from "./photo-cover-warm-job.js";

export function createPhotosRuntime(deps) {
  const settings = createPhotosSettingsProvider(deps);
  const catalog = deps.getImageGalleryDb && createPhotoCatalogService({
    getImageGalleryDb: deps.getImageGalleryDb,
    photoSetById: deps.photoSetService.byId,
    resolvePersonId: deps.resolvePersonId
  });
  const catalogIntake = catalog && createPhotoCatalogIntake({
    catalog,
    getPhotoSets: deps.getPhotoSets,
    describePhotoCollection: deps.imageLibraryService.describePhotoCollection,
    archivePath: deps.photoSetService.archivePath,
    loadPublicSource: deps.loadPublicPhotoSource
  });
  const coverWarmJob = deps.getPhotoCoverWarmPlan && createPhotoCoverWarmJob({
    getDb: deps.getImageGalleryDb,
    buildPlan: deps.getPhotoCoverWarmPlan,
    warmCover: deps.photoSetService.warmImageCover
  });
  const routeDeps = { ...deps, catalog, catalogIntake, coverWarmJob };

  async function routeApi(req, res, url) {
    return routePhotosApi(req, res, url, routeDeps);
  }

  async function routeMedia(req, res, url) {
    if (/^\/photo\/maintenance\/?$/.test(url.pathname) && ["GET", "HEAD"].includes(req.method)) {
      if (deps.requireLocalAdmin(req, res)) await deps.serveStatic(req, res, "/modules/photos/maintenance/index.html");
      return true;
    }

    const mangaCoverMatch = /^\/media\/manga-cover\/([^/]+)$/.exec(url.pathname);
    if (mangaCoverMatch && ["GET", "HEAD"].includes(req.method)) {
      await deps.mangaService.serveCover(req, res, mangaCoverMatch[1]);
      return true;
    }

    const photoSetCoverMatch = /^\/media\/gallery-cover\/([^/]+)$/.exec(url.pathname);
    if (photoSetCoverMatch && req.method === "GET") {
      const fallback = url.searchParams.get("fallback");
      await deps.photoSetService.serveCover(res, decodeURIComponent(photoSetCoverMatch[1]), {
        fallback: fallback === "empty" ? "empty" : fallback === "1",
        ...(url.searchParams.has("cover") ? { revision: url.searchParams.get("cover") } : {})
      });
      return true;
    }

    const mangaImageMatch = /^\/media\/manga\/([^/]+)\/([^/]+)\/([^/]+)$/.exec(url.pathname);
    if (mangaImageMatch && req.method === "GET") {
      await deps.mangaService.serveImage(res, mangaImageMatch[1], mangaImageMatch[2], mangaImageMatch[3]);
      return true;
    }

    const photoSetImageMatch = /^\/media\/gallery\/([^/]+)\/([^/]+)$/.exec(url.pathname);
    if (photoSetImageMatch && req.method === "GET") {
      await deps.photoSetService.serveImage(res, photoSetImageMatch[1], photoSetImageMatch[2]);
      return true;
    }

    const photoVideoMatch = /^\/media\/gallery-archive-video\/([^/]+)\/([a-f0-9]{32})$/.exec(url.pathname);
    if (photoVideoMatch && ["GET", "HEAD"].includes(req.method)) {
      try {
        await deps.photoSetService.serveVideo(req, res, decodeURIComponent(photoVideoMatch[1]), photoVideoMatch[2]);
      } catch (error) {
        if (!res.destroyed && !res.writableEnded) {
          if (res.headersSent) res.destroy();
          else deps.sendJson(res, error.statusCode || 500, { error: error.statusCode ? error.message : "归档视频读取失败" });
        }
      }
      return true;
    }

    return false;
  }

  return { routeApi, routeMedia, settings,
    start: async () => {
      await deps.photoSetService.start?.();
      coverWarmJob?.start();
    },
    beginStop: () => {
      coverWarmJob?.beginStop();
      deps.photoSetService.beginStop?.();
    },
    stop: async () => {
      catalogIntake?.clear();
      deps.mangaService?.clearReaderLookupCaches?.();
      await deps.photoSetService.stop?.();
      await coverWarmJob?.stop();
      deps.releasePhotoSetLookup?.();
    }
  };
}
