export async function routeNovelApi(req, res, url, deps) {
  const {
    collectionService,
    novelStore,
    notFound: notFoundResponse,
    readJsonBody,
    reimportService,
    requireLocalAdmin = () => true,
    sendJson: sendJsonResponse,
    novelUploadMaxBodyBytes = 80 * 1024 * 1024
  } = deps;
  const sendJson = (target, ...args) => {
    if (!target.destroyed && !target.writableEnded) sendJsonResponse(target, ...args);
  };
  const notFound = (target) => {
    if (!target.destroyed && !target.writableEnded) notFoundResponse(target);
  };

  if (url.pathname === "/api/novels/collection" && req.method === "GET") {
    if (!requireLocalAdmin(req, res)) return true;
    try {
      sendJson(res, 200, await collectionService.snapshot());
    } catch (error) {
      sendJson(res, error.statusCode || 500, { error: error.message || "小说采集后台读取失败" });
    }
    return true;
  }

  if (url.pathname === "/api/novels/collection/adapters" && req.method === "GET") {
    if (!requireLocalAdmin(req, res)) return true;
    try {
      sendJson(res, 200, await collectionService.listAdapters());
    } catch (error) {
      sendJson(res, error.statusCode || 500, { error: error.message || "采集适配器读取失败" });
    }
    return true;
  }

  if (url.pathname === "/api/novels/collection/adapters" && req.method === "POST") {
    if (!requireLocalAdmin(req, res)) return true;
    try {
      const body = await readJsonBody(req);
      sendJson(res, 201, await collectionService.createAdapter(body || {}));
    } catch (error) {
      sendJson(res, error.statusCode || 500, writeErrorPayload(error, "采集适配器创建失败"));
    }
    return true;
  }

  const adapterMatch = /^\/api\/novels\/collection\/adapters\/([^/]+)$/.exec(url.pathname);
  if (adapterMatch && req.method === "PATCH") {
    if (!requireLocalAdmin(req, res)) return true;
    try {
      const body = await readJsonBody(req);
      sendJson(res, 200, await collectionService.updateAdapter(decodeURIComponent(adapterMatch[1]), body || {}));
    } catch (error) {
      sendJson(res, error.statusCode || 500, writeErrorPayload(error, "采集适配器保存失败"));
    }
    return true;
  }
  if (adapterMatch && req.method === "DELETE") {
    if (!requireLocalAdmin(req, res)) return true;
    try {
      const data = await collectionService.deleteAdapter(decodeURIComponent(adapterMatch[1]));
      if (!data) {
        notFound(res);
        return true;
      }
      sendJson(res, 200, data);
    } catch (error) {
      sendJson(res, error.statusCode || 500, writeErrorPayload(error, "采集适配器删除失败"));
    }
    return true;
  }

  if (url.pathname === "/api/novels/collection/tasks" && req.method === "GET") {
    if (!requireLocalAdmin(req, res)) return true;
    try {
      sendJson(res, 200, await collectionService.listTasks());
    } catch (error) {
      sendJson(res, error.statusCode || 500, { error: error.message || "采集任务读取失败" });
    }
    return true;
  }

  if (url.pathname === "/api/novels/collection/tasks" && req.method === "POST") {
    if (!requireLocalAdmin(req, res)) return true;
    try {
      const body = await readJsonBody(req);
      sendJson(res, 201, await collectionService.createTask(body || {}));
    } catch (error) {
      sendJson(res, error.statusCode || 500, writeErrorPayload(error, "采集任务创建失败"));
    }
    return true;
  }

  const taskActionMatch = /^\/api\/novels\/collection\/tasks\/([^/]+)\/(run|cancel)$/.exec(url.pathname);
  if (taskActionMatch && req.method === "POST") {
    if (!requireLocalAdmin(req, res)) return true;
    try {
      const taskId = decodeURIComponent(taskActionMatch[1]);
      const data = taskActionMatch[2] === "cancel"
        ? await collectionService.cancelTask(taskId)
        : await collectionService.runTask(taskId);
      sendJson(res, 200, data);
    } catch (error) {
      sendJson(res, error.statusCode || 500, writeErrorPayload(error, "采集任务操作失败"));
    }
    return true;
  }

  const taskMatch = /^\/api\/novels\/collection\/tasks\/([^/]+)$/.exec(url.pathname);
  if (taskMatch && req.method === "GET") {
    if (!requireLocalAdmin(req, res)) return true;
    try {
      const task = await collectionService.taskDetail(decodeURIComponent(taskMatch[1]));
      if (!task) {
        notFound(res);
        return true;
      }
      sendJson(res, 200, { task });
    } catch (error) {
      sendJson(res, error.statusCode || 500, { error: error.message || "采集任务读取失败" });
    }
    return true;
  }
  if (taskMatch && req.method === "DELETE") {
    if (!requireLocalAdmin(req, res)) return true;
    try {
      const data = await collectionService.deleteTask(decodeURIComponent(taskMatch[1]));
      if (!data) {
        notFound(res);
        return true;
      }
      sendJson(res, 200, data);
    } catch (error) {
      sendJson(res, error.statusCode || 500, writeErrorPayload(error, "采集任务删除失败"));
    }
    return true;
  }

  if (url.pathname === "/api/novels/summary" && req.method === "GET") {
    try {
      sendJson(res, 200, novelStore.summary());
    } catch (error) {
      sendJson(res, error.statusCode || 500, { error: error.message || "小说概览读取失败" });
    }
    return true;
  }

  if (url.pathname === "/api/novels" && req.method === "GET") {
    try {
      sendJson(res, 200, novelStore.listBooks(url));
    } catch (error) {
      sendJson(res, error.statusCode || 500, { error: error.message || "小说书库读取失败" });
    }
    return true;
  }

  if (url.pathname === "/api/novels/authors" && req.method === "GET") {
    try {
      sendJson(res, 200, novelStore.listAuthors(url));
    } catch (error) {
      sendJson(res, error.statusCode || 500, { error: error.message || "作者列表读取失败" });
    }
    return true;
  }

  const authorMatch = /^\/api\/novels\/authors\/([^/]+)$/.exec(url.pathname);
  if (authorMatch && req.method === "GET") {
    try {
      const data = novelStore.authorDetail(decodeURIComponent(authorMatch[1]), url);
      if (!data) {
        notFound(res);
        return true;
      }
      sendJson(res, 200, data);
    } catch (error) {
      sendJson(res, error.statusCode || 500, { error: error.message || "作者详情读取失败" });
    }
    return true;
  }

  if (url.pathname === "/api/novels/upload" && req.method === "POST") {
    if (!requireLocalAdmin(req, res)) return true;
    try {
      const body = await readJsonBody(req, novelUploadMaxBodyBytes);
      const data = await novelStore.uploadBook(body || {});
      sendJson(res, 201, { ok: true, ...data });
    } catch (error) {
      sendJson(res, error.statusCode || 500, writeErrorPayload(error, "小说上传失败"));
    }
    return true;
  }

  const reimportMatch = /^\/api\/novels\/([^/]+)\/reimport$/.exec(url.pathname);
  if (reimportMatch && req.method === "POST") {
    if (!requireLocalAdmin(req, res)) return true;
    const controller = new AbortController();
    const abort = () => controller.abort();
    const closed = () => { if (!res.writableEnded) abort(); };
    req.once?.("aborted", abort);
    res.once?.("close", closed);
    if (req.aborted || res.destroyed) abort();
    try {
      const body = await readJsonBody(req, novelUploadMaxBodyBytes);
      const data = await reimportService.reimport(decodeURIComponent(reimportMatch[1]), body || {}, { signal: controller.signal });
      if (!data) {
        notFound(res);
        return true;
      }
      sendJson(res, data.kind === "collection" ? 202 : 200, { ok: true, ...data });
    } catch (error) {
      sendJson(res, error.statusCode || 500, writeErrorPayload(error, "小说重新导入失败"));
    } finally {
      req.removeListener?.("aborted", abort);
      res.removeListener?.("close", closed);
    }
    return true;
  }

  const catalogMatch = /^\/api\/novels\/([^/]+)\/catalog$/.exec(url.pathname);
  if (catalogMatch && req.method === "GET") {
    try {
      const data = novelStore.catalog(decodeURIComponent(catalogMatch[1]), url);
      if (!data) {
        notFound(res);
        return true;
      }
      sendJson(res, 200, data);
    } catch (error) {
      sendJson(res, error.statusCode || 500, { error: error.message || "章节目录读取失败" });
    }
    return true;
  }

  const chapterMatch = /^\/api\/novels\/([^/]+)\/chapters\/([^/]+)$/.exec(url.pathname);
  if (chapterMatch && req.method === "GET") {
    try {
      const options = {};
      for (const key of ["sourceRealm", "catalogRevision", "chapterId"]) {
        if (url.searchParams.has(key)) options[key] = url.searchParams.get(key);
      }
      const data = novelStore.chapterDetail(decodeURIComponent(chapterMatch[1]), decodeURIComponent(chapterMatch[2]), options);
      if (!data) {
        notFound(res);
        return true;
      }
      sendJson(res, 200, data);
    } catch (error) {
      sendJson(res, error.statusCode || 500, { error: error.message || "章节读取失败" });
    }
    return true;
  }

  const progressMatch = /^\/api\/novels\/([^/]+)\/progress$/.exec(url.pathname);
  if (progressMatch && req.method === "POST") {
    try {
      const body = await readJsonBody(req);
      const progress = await novelStore.saveProgress(decodeURIComponent(progressMatch[1]), body || {});
      if (!progress) {
        notFound(res);
        return true;
      }
      sendJson(res, 200, { ok: true, progress });
    } catch (error) {
      sendJson(res, error.statusCode || 500, writeErrorPayload(error, "阅读进度保存失败"));
    }
    return true;
  }

  const downloadMatch = /^\/api\/novels\/([^/]+)\/download$/.exec(url.pathname);
  if (downloadMatch && req.method === "GET") {
    let download = null;
    try {
      download = novelStore.openDownload(decodeURIComponent(downloadMatch[1]));
      if (!download) {
        notFound(res);
        return true;
      }
      res.writeHead(200, {
        "Content-Type": "text/plain; charset=utf-8",
        "Content-Disposition": attachmentDisposition(download.fileName),
        "Cache-Control": "no-store"
      });
      if (!(await writeDownloadChunk(res, download.header))) return true;
      while (!res.destroyed && !res.writableEnded) {
        const chunk = download.nextChunk();
        if (chunk === null) break;
        if (!(await writeDownloadChunk(res, chunk))) return true;
      }
      if (!res.destroyed && !res.writableEnded) res.end("\n", "utf8");
    } catch (error) {
      if (!res.headersSent) sendJson(res, error.statusCode || 500, { error: error.message || "小说下载失败" });
      else if (!res.destroyed) res.destroy(error);
    } finally {
      download?.close?.();
    }
    return true;
  }

  const bookMatch = /^\/api\/novels\/([^/]+)$/.exec(url.pathname);
  if (bookMatch && req.method === "DELETE") {
    if (!requireLocalAdmin(req, res)) return true;
    try {
      const sourceRealm = url.searchParams.get("sourceRealm");
      const deleted = await novelStore.deleteBook(decodeURIComponent(bookMatch[1]), sourceRealm === null ? {} : { sourceRealm });
      if (!deleted) {
        notFound(res);
        return true;
      }
      sendJson(res, 200, { ok: true, deleted });
    } catch (error) {
      sendJson(res, error.statusCode || 500, writeErrorPayload(error, "小说删除失败"));
    }
    return true;
  }
  if (bookMatch && req.method === "PATCH") {
    if (!requireLocalAdmin(req, res)) return true;
    try {
      const body = await readJsonBody(req);
      const book = await novelStore.updateBookMetadata(decodeURIComponent(bookMatch[1]), body || {});
      if (!book) {
        notFound(res);
        return true;
      }
      sendJson(res, 200, { ok: true, book });
    } catch (error) {
      sendJson(res, error.statusCode || 500, writeErrorPayload(error, "书籍信息保存失败"));
    }
    return true;
  }
  if (bookMatch && req.method === "GET") {
    try {
      const bookId = decodeURIComponent(bookMatch[1]);
      const data = url.searchParams.get("catalog") === "0"
        ? novelStore.bookMeta(bookId)
        : novelStore.bookDetail(bookId);
      if (!data) {
        notFound(res);
        return true;
      }
      sendJson(res, 200, data);
    } catch (error) {
      sendJson(res, error.statusCode || 500, { error: error.message || "书籍详情读取失败" });
    }
    return true;
  }

  return false;
}

function writeErrorPayload(error, fallback) {
  return {
    error: error.message || fallback,
    ...(error.code === "NOVEL_PROGRESS_SESSION_EXPIRED" || error.code === "NOVEL_PROGRESS_BUSY" ? { code: error.code } : {}),
    ...(error.outcome === "unknown" ? { outcome: "unknown", operationId: error.operationId } : {})
  };
}

function attachmentDisposition(fileName) {
  const name = String(fileName || "小说.txt").replace(/[\\/\u0000-\u001f]/g, "_");
  const fallback = name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_") || "download.txt";
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

function writeDownloadChunk(res, chunk) {
  if (res.destroyed || res.writableEnded) return Promise.resolve(false);
  if (res.write(chunk, "utf8")) return Promise.resolve(true);
  return new Promise((resolve) => {
    const finish = () => {
      res.off("drain", finish);
      res.off("close", finish);
      res.off("error", finish);
      resolve(!res.destroyed && !res.writableEnded);
    };
    res.once("drain", finish);
    res.once("close", finish);
    res.once("error", finish);
  });
}
