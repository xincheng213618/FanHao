export async function routePhotosApi(req, res, url, deps) {
  const {
    cleanupImageReaderCache,
    imageLibraryService,
    imageReaderCacheStatus,
    mangaService,
    notFound,
    photoSetService,
    publicAppConfig,
    readJsonBody,
    requireLocalAdmin,
    sendJson
  } = deps;

  if (url.pathname === "/api/image-reader/cache" && req.method === "GET") {
    sendJson(res, 200, { cache: await imageReaderCacheStatus(), config: publicAppConfig() });
    return true;
  }

  if (url.pathname === "/api/image-reader/cache/cleanup" && req.method === "POST") {
    if (!requireLocalAdmin(req, res)) return true;
    sendJson(res, 200, await cleanupImageReaderCache({ force: Boolean(url.searchParams.get("force")) }));
    return true;
  }

  if (url.pathname === "/api/manga" && req.method === "GET") {
    const status = mangaService.rootStatus();
    sendJson(res, 200, {
      root: status.root,
      exists: status.exists,
      database: mangaService.databaseStatus(),
      cache: await imageReaderCacheStatus(),
      comics: mangaService.cacheDirs().map(mangaService.publicSummary)
    });
    return true;
  }

  if (url.pathname === "/api/manga/storage" && req.method === "GET") {
    sendJson(res, 200, { storage: mangaService.storageStatus(url.searchParams.get("refresh") === "1") });
    return true;
  }

  if (url.pathname === "/api/manga/trash" && req.method === "DELETE") {
    if (!requireLocalAdmin(req, res)) return true;
    try {
      sendJson(res, 200, mangaService.purgeTrash());
    } catch (error) {
      sendJson(res, error.statusCode || 500, { error: error.message || "漫画回收站清理失败" });
    }
    return true;
  }

  const mangaTrashRestoreMatch = /^\/api\/manga\/trash\/([^/]+)\/restore$/.exec(url.pathname);
  if (mangaTrashRestoreMatch && req.method === "POST") {
    if (!requireLocalAdmin(req, res)) return true;
    try {
      sendJson(res, 200, mangaService.restoreTrashEntry(decodeURIComponent(mangaTrashRestoreMatch[1])));
    } catch (error) {
      sendJson(res, error.statusCode || 500, { error: error.message || "漫画恢复失败" });
    }
    return true;
  }

  if (url.pathname === "/api/manga/add" && req.method === "POST") {
    if (!requireLocalAdmin(req, res)) return true;
    try {
      const body = await readJsonBody(req);
      const result = mangaService.startAdd(body?.url);
      sendJson(res, result.started ? 202 : 200, result);
    } catch (error) {
      sendJson(res, error.statusCode || 500, { error: error.message || "新增漫画启动失败" });
    }
    return true;
  }

  if (url.pathname === "/api/manga/jobs" && req.method === "GET") {
    if (!requireLocalAdmin(req, res)) return true;
    sendJson(res, 200, { jobs: mangaService.listJobs(url.searchParams.get("limit")) });
    return true;
  }

  if (url.pathname === "/api/manga/jobs/history" && req.method === "DELETE") {
    if (!requireLocalAdmin(req, res)) return true;
    try {
      sendJson(res, 200, mangaService.clearFinishedJobs());
    } catch (error) {
      sendJson(res, error.statusCode || 500, { error: error.message || "漫画任务记录清理失败" });
    }
    return true;
  }

  const mangaJobRetryMatch = /^\/api\/manga\/jobs\/([^/]+)\/retry$/.exec(url.pathname);
  if (mangaJobRetryMatch && req.method === "POST") {
    if (!requireLocalAdmin(req, res)) return true;
    try {
      const result = mangaService.retryJob(decodeURIComponent(mangaJobRetryMatch[1]));
      sendJson(res, result.started ? 202 : 200, result);
    } catch (error) {
      sendJson(res, error.statusCode || 500, { error: error.message || "漫画任务重试失败" });
    }
    return true;
  }

  const mangaJobMatch = /^\/api\/manga\/jobs\/([^/]+)$/.exec(url.pathname);
  if (mangaJobMatch && req.method === "GET") {
    if (!requireLocalAdmin(req, res)) return true;
    const job = mangaService.jobStatus(decodeURIComponent(mangaJobMatch[1]));
    if (!job) {
      notFound(res);
      return true;
    }
    sendJson(res, 200, { job });
    return true;
  }

  const mangaUpdateMatch = /^\/api\/manga\/([^/]+)\/update$/.exec(url.pathname);
  if (mangaUpdateMatch && ["GET", "POST"].includes(req.method)) {
    if (!requireLocalAdmin(req, res)) return true;
    const mangaId = decodeURIComponent(mangaUpdateMatch[1]);
    if (req.method === "GET") {
      const job = mangaService.updateStatus(mangaId);
      if (!job) {
        notFound(res);
        return true;
      }
      sendJson(res, 200, { job });
      return true;
    }
    try {
      const result = mangaService.startUpdate(mangaId);
      sendJson(res, result.started ? 202 : 200, result);
    } catch (error) {
      sendJson(res, error.statusCode || 500, { error: error.message || "漫画更新启动失败" });
    }
    return true;
  }

  const mangaDownloadMatch = /^\/api\/manga\/([^/]+)\/download$/.exec(url.pathname);
  if (mangaDownloadMatch && ["GET", "HEAD"].includes(req.method)) {
    await mangaService.serveComicDownload(req, res, mangaDownloadMatch[1]);
    return true;
  }

  const mangaChapterDownloadMatch = /^\/api\/manga\/([^/]+)\/chapters\/([^/]+)\/download$/.exec(url.pathname);
  if (mangaChapterDownloadMatch && ["GET", "HEAD"].includes(req.method)) {
    await mangaService.serveChapterDownload(req, res, mangaChapterDownloadMatch[1], mangaChapterDownloadMatch[2]);
    return true;
  }

  const mangaDetailMatch = /^\/api\/manga\/([^/]+)$/.exec(url.pathname);
  if (mangaDetailMatch && req.method === "DELETE") {
    if (!requireLocalAdmin(req, res)) return true;
    try {
      sendJson(res, 200, mangaService.trashComic(decodeURIComponent(mangaDetailMatch[1])));
    } catch (error) {
      sendJson(res, error.statusCode || 500, { error: error.message || "漫画删除失败" });
    }
    return true;
  }
  if (mangaDetailMatch && req.method === "GET") {
    const mangaId = decodeURIComponent(mangaDetailMatch[1]);
    const cacheDir = mangaService.cacheById(mangaId);
    if (!cacheDir) {
      notFound(res);
      return true;
    }
    sendJson(res, 200, {
      comic: mangaService.publicDetail(cacheDir),
      update: mangaService.updateStatus(mangaId),
      cache: await imageReaderCacheStatus()
    });
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
    sendJson(res, 200, { comic: mangaService.publicSummary(cacheDir), chapter, cache: await imageReaderCacheStatus() });
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
    const controller = new AbortController(), disconnect = () => { if (!res.writableEnded) controller.abort(); };
    res.once?.("close",disconnect);
    try {
      const rawLimit = String(url.searchParams.get("imageLimit") || url.searchParams.get("imagesLimit") || "").trim().toLowerCase();
      const imageLimit = rawLimit && rawLimit !== "all" ? Number(rawLimit) : 0;
      const imageOffset = Number(url.searchParams.get("imageOffset") || url.searchParams.get("imagesOffset") || 0);
      const detail = await photoSetService.publicDetail(album, { imageLimit, imageOffset, signal:controller.signal });
      if (controller.signal.aborted || res.destroyed || res.writableEnded) return true;
      const cache = await imageReaderCacheStatus();
      if (!controller.signal.aborted && !res.destroyed && !res.writableEnded) sendJson(res,200,{album:detail,cache});
    } catch (error) {
      if (!controller.signal.aborted && !res.destroyed && !res.writableEnded) sendJson(res, error.statusCode || 500, { error: error.message || "套图读取失败" });
    } finally { res.removeListener?.("close",disconnect); }
    return true;
  }

  return false;
}
