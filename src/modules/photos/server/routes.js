import { stat } from "node:fs/promises";
import { ensureRealPathWithinRoots } from "../../../platform/server/library-path-safety.js";
import { scheduleLocalPathAction } from "../../../platform/server/local-path-action.js";

const MANGA_DIMENSIONS_RETRYABLE_CODES = new Set(["MANGA_DIMENSIONS_BUSY", "MANGA_DIMENSIONS_STOPPED"]);

export async function routePhotosApi(req, res, url, deps) {
  const {
    catalog,
    catalogIntake,
    cleanupImageReaderCache,
    coverWarmJob,
    getPhotoIndexScan,
    imageLibraryService,
    imageReaderCacheStatus,
    mangaService,
    notFound,
    photoSetService,
    publicAppConfig,
    readJsonBody,
    requireLocalAdmin,
    schedulePathAction = scheduleLocalPathAction,
    sendJson,
    startPhotoIndexScan
  } = deps;

  const coverWarmMatch = /^\/api\/photo-cover-warm(?:\/(start|pause|resume))?$/.exec(url.pathname);
  if (coverWarmJob && coverWarmMatch && req.method === (coverWarmMatch[1] ? "POST" : "GET")) {
    if (!requireLocalAdmin(req, res)) return true;
    const action = coverWarmMatch[1];
    try {
      sendJson(res, 200, action ? coverWarmJob.change(action) : coverWarmJob.status());
    } catch (error) {
      if (!error.statusCode) throw error;
      sendJson(res, error.statusCode, { error: error.message });
    }
    return true;
  }

  if (getPhotoIndexScan && url.pathname === "/api/photo-maintenance/index" && ["GET", "POST"].includes(req.method)) {
    if (!requireLocalAdmin(req, res)) return true;
    try {
      const starting = req.method === "POST";
      sendJson(res, starting ? 202 : 200, { task: starting ? startPhotoIndexScan() : getPhotoIndexScan() });
    } catch (error) {
      if (!error.statusCode) throw error;
      sendJson(res, error.statusCode, { error: error.message });
    }
    return true;
  }

  if (catalog && url.pathname === "/api/photo-catalog" && req.method === "GET") {
    const filters = Object.fromEntries(["q", "category", "collection", "person", "scope", "sort", "limit", "offset"]
      .map((key) => [key, url.searchParams.get(key)]));
    sendJson(res, 200, catalog.list(filters));
    return true;
  }

  if (catalog && url.pathname === "/api/photo-catalog/stats" && req.method === "GET") {
    sendJson(res, 200, catalog.stats());
    return true;
  }

  const catalogDetailMatch = /^\/api\/photo-catalog\/([^/]+)$/.exec(url.pathname);
  if (catalog && catalogDetailMatch && req.method === "GET") {
    const work = catalog.detail(decodeURIComponent(catalogDetailMatch[1]));
    if (work) sendJson(res, 200, { work });
    else notFound(res);
    return true;
  }

  const intakeMatch = /^\/api\/photo-catalog\/intake\/(options|preview|commit)$/.exec(url.pathname);
  if (catalogIntake && intakeMatch && req.method === (intakeMatch[1] === "options" ? "GET" : "POST")) {
    if (!requireLocalAdmin(req, res)) return true;
    try {
      const action = intakeMatch[1];
      const result = action === "options" ? catalogIntake.options() : await catalogIntake[action](await readJsonBody(req));
      sendJson(res, 200, result);
    } catch (error) {
      if (!error.statusCode) throw error;
      sendJson(res, error.statusCode, { error: error.message });
    }
    return true;
  }

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
      comics: mangaService.publicSummaries?.() ?? mangaService.cacheDirs().map(mangaService.publicSummary)
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
    const controller = new AbortController();
    const abort = () => controller.abort();
    const onClose = () => { if (!res.writableEnded) abort(); };
    const unavailable = () => controller.signal.aborted || req.aborted || res.destroyed || res.writableEnded;
    if (unavailable()) return true;
    req.once?.("aborted", abort);
    res.once?.("close", onClose);
    try {
      const cacheDir = mangaService.cacheById(decodeURIComponent(mangaChapterMatch[1]));
      const manifestContext = {};
      const comic = cacheDir ? mangaService.publicSummary(cacheDir, manifestContext) : null;
      const chapter = cacheDir ? await mangaService.publicChapter(cacheDir, decodeURIComponent(mangaChapterMatch[2]), comic, manifestContext, { signal: controller.signal }) : null;
      if (unavailable()) return true;
      if (!cacheDir || !chapter) {
        notFound(res);
        return true;
      }
      const cache = await imageReaderCacheStatus();
      if (!unavailable()) sendJson(res, 200, { comic, chapter, cache });
    } catch (error) {
      if (unavailable()) return true;
      if (error?.statusCode !== 503 || !MANGA_DIMENSIONS_RETRYABLE_CODES.has(error.code)) throw error;
      res.setHeader?.("Retry-After", "1");
      sendJson(res, 503, { error: "暂时无法读取漫画章节，请稍后重试", code: error.code, retryable: true });
    } finally {
      req.off?.("aborted", abort);
      res.off?.("close", onClose);
    }
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
      photoSets: photoSetService.withCoverOverrides?.(payload.photoSets) ?? payload.photoSets,
      mediaItems: payload.mediaItems
    });
    return true;
  }

  const photoMarkMatch = /^\/api\/photo-sets\/([^/]+)\/mark$/.exec(url.pathname);
  if (photoMarkMatch && req.method === "PUT") {
    if (!requireLocalAdmin(req, res)) return true;
    try {
      const body = await readJsonBody(req, 1024);
      if (typeof body?.markedA !== "boolean") {
        sendJson(res, 400, { error: "markedA 必须是布尔值" });
        return true;
      }
      const result = photoSetService.setArchiveMarkedA(decodeURIComponent(photoMarkMatch[1]), body.markedA);
      if (result) sendJson(res, 200, result);
      else notFound(res);
    } catch (error) {
      if (error instanceof URIError) sendJson(res, 400, { error: "套图 ID 无效" });
      else sendJson(res, error.statusCode || 500, { error: error.statusCode ? error.message : "保存套图标记失败" });
    }
    return true;
  }

  const photoCoverMatch = /^\/api\/photo-sets\/([^/]+)\/cover$/.exec(url.pathname);
  if (photoCoverMatch && req.method === "PUT") {
    if (!requireLocalAdmin(req, res)) return true;
    const controller = new AbortController();
    const disconnect = () => { if (!res.writableEnded) controller.abort(); };
    res.once?.("close", disconnect);
    try {
      const body = await readJsonBody(req, 24 * 1024);
      const cover = await photoSetService.setCover(decodeURIComponent(photoCoverMatch[1]), body || {}, { signal: controller.signal });
      if (!controller.signal.aborted) sendJson(res, 200, cover);
    } catch (error) {
      if (!controller.signal.aborted) sendJson(res, error.statusCode || 500, { error: error.statusCode ? error.message : "保存套图封面失败" });
    } finally {
      res.removeListener?.("close", disconnect);
    }
    return true;
  }

  const photoRevealMatch = /^\/api\/photo-sets\/([^/]+)\/reveal$/.exec(url.pathname);
  if (photoRevealMatch && req.method === "POST") {
    if (!requireLocalAdmin(req, res)) return true;
    try {
      const album = photoSetService.byId(decodeURIComponent(photoRevealMatch[1]));
      const archive = album && photoSetService.archivePath(album);
      if (!archive) {
        notFound(res);
        return true;
      }
      const target = ensureRealPathWithinRoots(archive, [album.sourceRoot], "套图文件");
      if (!(await stat(target)).isFile()) {
        notFound(res);
        return true;
      }
      schedulePathAction(target, { action: "reveal" });
      sendJson(res, 200, { ok: true });
    } catch (error) {
      if (error instanceof URIError) sendJson(res, 400, { error: "套图 ID 无效" });
      else if (["ENOENT", "ENOTDIR"].includes(error.code)) notFound(res);
      else sendJson(res, error.statusCode || 500, { error: error.statusCode ? error.message : "无法定位套图文件" });
    }
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
