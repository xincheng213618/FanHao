export async function routeCatalogApi(req, res, url, deps) {
  const {
    notFound,
    rankingService,
    sendJson,
    studioService
  } = deps;

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
