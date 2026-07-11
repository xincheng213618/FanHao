export async function routeNovelApi(req, res, url, deps) {
  const { novelStore, notFound, readJsonBody, sendJson, novelUploadMaxBodyBytes = 80 * 1024 * 1024 } = deps;

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
    try {
      const body = await readJsonBody(req, novelUploadMaxBodyBytes);
      const data = novelStore.uploadBook(body || {});
      sendJson(res, 201, { ok: true, ...data });
    } catch (error) {
      sendJson(res, error.statusCode || 500, { error: error.message || "小说上传失败" });
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
      const data = novelStore.chapterDetail(decodeURIComponent(chapterMatch[1]), decodeURIComponent(chapterMatch[2]));
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
      const progress = novelStore.saveProgress(decodeURIComponent(progressMatch[1]), body || {});
      if (!progress) {
        notFound(res);
        return true;
      }
      sendJson(res, 200, { ok: true, progress });
    } catch (error) {
      sendJson(res, error.statusCode || 500, { error: error.message || "阅读进度保存失败" });
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
    try {
      const deleted = novelStore.deleteBook(decodeURIComponent(bookMatch[1]));
      if (!deleted) {
        notFound(res);
        return true;
      }
      sendJson(res, 200, { ok: true, deleted });
    } catch (error) {
      sendJson(res, error.statusCode || 500, { error: error.message || "小说删除失败" });
    }
    return true;
  }
  if (bookMatch && req.method === "PATCH") {
    try {
      const body = await readJsonBody(req);
      const book = novelStore.updateBookMetadata(decodeURIComponent(bookMatch[1]), body || {});
      if (!book) {
        notFound(res);
        return true;
      }
      sendJson(res, 200, { ok: true, book });
    } catch (error) {
      sendJson(res, error.statusCode || 500, { error: error.message || "书籍信息保存失败" });
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
