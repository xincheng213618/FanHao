export async function routeGalleryApi(req, res, url, deps) {
  const {
    cleanupImageReaderCache,
    galleryMediaById,
    imageLibraryItemsPayload,
    imageLibraryPayload,
    imageLibrarySummaryPayload,
    imageReaderCacheStatus,
    mangaCacheById,
    mangaCacheDirs,
    mangaRootStatus,
    notFound,
    photoSetById,
    publicAppConfig,
    publicGalleryMediaDetail,
    publicMangaChapter,
    publicMangaDetail,
    publicMangaSummary,
    publicPhotoSetDetail,
    requireLocalAdmin,
    sendJson
  } = deps;

  if (url.pathname === "/api/image-library" && req.method === "GET") {
    try {
      sendJson(res, 200, imageLibraryPayload());
    } catch (error) {
      sendJson(res, error.statusCode || 500, { error: error.message || "图像资料库读取失败" });
    }
    return true;
  }

  if (url.pathname === "/api/image-library/summary" && req.method === "GET") {
    try {
      sendJson(res, 200, imageLibrarySummaryPayload());
    } catch (error) {
      sendJson(res, error.statusCode || 500, { error: error.message || "图像资料库概览读取失败" });
    }
    return true;
  }

  if (url.pathname === "/api/image-library/items" && req.method === "GET") {
    try {
      sendJson(res, 200, imageLibraryItemsPayload(url));
    } catch (error) {
      sendJson(res, error.statusCode || 500, { error: error.message || "频道列表读取失败" });
    }
    return true;
  }

  if (url.pathname === "/api/image-library/rescan" && req.method === "POST") {
    if (!requireLocalAdmin(req, res)) return true;
    sendJson(res, 409, { error: "图库索引刷新已移到后台作业中心，请启动“刷新图库索引”作业。" });
    return true;
  }

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
    const status = mangaRootStatus();
    sendJson(res, 200, {
      root: status.root,
      exists: status.exists,
      cache: imageReaderCacheStatus(),
      comics: mangaCacheDirs().map(publicMangaSummary)
    });
    return true;
  }

  const mangaDetailMatch = /^\/api\/manga\/([^/]+)$/.exec(url.pathname);
  if (mangaDetailMatch && req.method === "GET") {
    const cacheDir = mangaCacheById(decodeURIComponent(mangaDetailMatch[1]));
    if (!cacheDir) {
      notFound(res);
      return true;
    }
    sendJson(res, 200, { comic: publicMangaDetail(cacheDir), cache: imageReaderCacheStatus() });
    return true;
  }

  const mangaChapterMatch = /^\/api\/manga\/([^/]+)\/chapters\/([^/]+)$/.exec(url.pathname);
  if (mangaChapterMatch && req.method === "GET") {
    const cacheDir = mangaCacheById(decodeURIComponent(mangaChapterMatch[1]));
    const chapter = cacheDir ? publicMangaChapter(cacheDir, decodeURIComponent(mangaChapterMatch[2])) : null;
    if (!cacheDir || !chapter) {
      notFound(res);
      return true;
    }
    sendJson(res, 200, { comic: publicMangaSummary(cacheDir), chapter, cache: imageReaderCacheStatus() });
    return true;
  }

  if (url.pathname === "/api/photo-sets" && req.method === "GET") {
    const payload = imageLibraryPayload();
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
    const album = photoSetById(decodeURIComponent(photoSetMatch[1]));
    if (!album) {
      notFound(res);
      return true;
    }
    try {
      sendJson(res, 200, { album: publicPhotoSetDetail(album), cache: imageReaderCacheStatus() });
    } catch (error) {
      sendJson(res, error.statusCode || 500, { error: error.message || "图包读取失败" });
    }
    return true;
  }

  const galleryMediaMatch = /^\/api\/gallery-media\/([^/]+)$/.exec(url.pathname);
  if (galleryMediaMatch && req.method === "GET") {
    const item = galleryMediaById(decodeURIComponent(galleryMediaMatch[1]));
    if (!item) {
      notFound(res);
      return true;
    }
    sendJson(res, 200, { item: publicGalleryMediaDetail(item) });
    return true;
  }

  return false;
}
