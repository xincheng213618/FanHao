export async function routePhotosApi(req, res, url, deps) {
  const {
    cleanupImageReaderCache,
    imageLibraryService,
    imageReaderCacheStatus,
    mangaService,
    notFound,
    photoSetService,
    publicAppConfig,
    requireLocalAdmin,
    sendJson
  } = deps;

  if (url.pathname === "/api/image-reader/cache" && req.method === "GET") {
    sendJson(res, 200, { cache: imageReaderCacheStatus(), config: publicAppConfig() });
    return true;
  }

  if (url.pathname === "/api/image-reader/cache/cleanup" && req.method === "POST") {
    if (!requireLocalAdmin(req, res)) return true;
    sendJson(res, 200, cleanupImageReaderCache({ force: Boolean(url.searchParams.get("force")) }));
    return true;
  }

  if (url.pathname === "/api/manga" && req.method === "GET") {
    const status = mangaService.rootStatus();
    sendJson(res, 200, {
      root: status.root,
      exists: status.exists,
      cache: imageReaderCacheStatus(),
      comics: mangaService.cacheDirs().map(mangaService.publicSummary)
    });
    return true;
  }

  const mangaDetailMatch = /^\/api\/manga\/([^/]+)$/.exec(url.pathname);
  if (mangaDetailMatch && req.method === "GET") {
    const cacheDir = mangaService.cacheById(decodeURIComponent(mangaDetailMatch[1]));
    if (!cacheDir) {
      notFound(res);
      return true;
    }
    sendJson(res, 200, { comic: mangaService.publicDetail(cacheDir), cache: imageReaderCacheStatus() });
    return true;
  }

  const mangaChapterMatch = /^\/api\/manga\/([^/]+)\/chapters\/([^/]+)$/.exec(url.pathname);
  if (mangaChapterMatch && req.method === "GET") {
    const cacheDir = mangaService.cacheById(decodeURIComponent(mangaChapterMatch[1]));
    const chapter = cacheDir ? mangaService.publicChapter(cacheDir, decodeURIComponent(mangaChapterMatch[2])) : null;
    if (!cacheDir || !chapter) {
      notFound(res);
      return true;
    }
    sendJson(res, 200, { comic: mangaService.publicSummary(cacheDir), chapter, cache: imageReaderCacheStatus() });
    return true;
  }

  if (url.pathname === "/api/photo-sets" && req.method === "GET") {
    const payload = imageLibraryService.payload();
    sendJson(res, 200, {
      scannedAt: payload.scannedAt,
      roots: payload.photoRoots,
      mediaRoots: payload.mediaRoots,
      totals: payload.totals,
      facets: payload.facets,
      cache: payload.cache,
      photoSets: payload.photoSets,
      mediaItems: payload.mediaItems
    });
    return true;
  }

  const photoSetMatch = /^\/api\/photo-sets\/([^/]+)$/.exec(url.pathname);
  if (photoSetMatch && req.method === "GET") {
    const album = photoSetService.byId(decodeURIComponent(photoSetMatch[1]));
    if (!album) {
      notFound(res);
      return true;
    }
    try {
      const rawLimit = String(url.searchParams.get("imageLimit") || url.searchParams.get("imagesLimit") || "").trim().toLowerCase();
      const imageLimit = rawLimit && rawLimit !== "all" ? Number(rawLimit) : 0;
      const imageOffset = Number(url.searchParams.get("imageOffset") || url.searchParams.get("imagesOffset") || 0);
      sendJson(res, 200, {
        album: await photoSetService.publicDetail(album, { imageLimit, imageOffset }),
        cache: imageReaderCacheStatus()
      });
    } catch (error) {
      sendJson(res, error.statusCode || 500, { error: error.message || "套图读取失败" });
    }
    return true;
  }

  return false;
}
