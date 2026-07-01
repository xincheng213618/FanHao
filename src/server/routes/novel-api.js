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
    try {
      const data = novelStore.downloadBook(decodeURIComponent(downloadMatch[1]));
      if (!data) {
        notFound(res);
        return true;
      }
      res.writeHead(200, {
        "Content-Type": "text/plain; charset=utf-8",
        "Content-Disposition": attachmentDisposition(data.fileName),
        "Cache-Control": "no-store"
      });
      res.end(data.content, "utf8");
    } catch (error) {
      sendJson(res, error.statusCode || 500, { error: error.message || "小说下载失败" });
    }
    return true;
  }

  const bookMatch = /^\/api\/novels\/([^/]+)$/.exec(url.pathname);
  if (bookMatch && req.method === "GET") {
    try {
      const data = novelStore.bookDetail(decodeURIComponent(bookMatch[1]));
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
