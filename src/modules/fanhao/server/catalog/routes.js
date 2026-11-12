export async function routeCatalogApi(req, res, url, deps) {
  const {
    codePrefixService,
    notFound,
    rankingService,
    readJsonBody,
    sendJson,
    studioService
  } = deps;

  if (url.pathname === "/api/code-prefixes/lookup" && req.method === "POST") {
    try {
      const body = await readJsonBody(req, 64 * 1024);
      sendJson(res, 200, codePrefixService.lookupPayload(body?.input));
    } catch (error) {
      const status = [400, 413].includes(error.statusCode) ? error.statusCode : 503;
      sendJson(res, status, { error: status < 500 ? error.message : "番号索引暂时读不完整，请重试。" });
    }
    return true;
  }

  if (url.pathname === "/api/code-prefixes" && req.method === "GET") {
    try {
      sendJson(res, 200, codePrefixService.summaries(url));
    } catch (error) {
      sendJson(res, 500, { error: error.message || "读取番号索引失败" });
    }
    return true;
  }

  const codePrefixMatch = /^\/api\/code-prefixes\/([^/]+)$/.exec(url.pathname);
  if (codePrefixMatch && req.method === "GET") {
    try {
      const payload = codePrefixService.detailPayload(decodeURIComponent(codePrefixMatch[1]), url);
      if (!payload) {
        notFound(res);
        return true;
      }
      sendJson(res, 200, payload);
    } catch (error) {
      sendJson(res, 500, { error: error.message || "读取番号作品失败" });
    }
    return true;
  }

  if (url.pathname === "/api/rankings" && req.method === "GET") {
    sendJson(res, 200, { lists: rankingService.summaries() });
    return true;
  }

  if (url.pathname === "/api/rankings/top" && req.method === "GET") {
    sendJson(res, 200, rankingService.worksPayload(url, "top"));
    return true;
  }

  if (url.pathname === "/api/studios" && req.method === "GET") {
    try {
      sendJson(res, 200, studioService.summaries(url));
    } catch (error) {
      sendJson(res, 500, { error: error.message || "读取厂商失败" });
    }
    return true;
  }

  const studioMatch = /^\/api\/studios\/([^/]+)$/.exec(url.pathname);
  if (studioMatch && req.method === "GET") {
    try {
      const payload = studioService.detailPayload(decodeURIComponent(studioMatch[1]), url);
      if (!payload) {
        notFound(res);
        return true;
      }
      sendJson(res, 200, payload);
    } catch (error) {
      sendJson(res, 500, { error: error.message || "读取厂商详情失败" });
    }
    return true;
  }

  return false;
}
