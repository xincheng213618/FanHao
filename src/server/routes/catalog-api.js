export async function routeCatalogApi(req, res, url, deps) {
  const {
    notFound,
    rankingSummaries,
    rankingWorksPayload,
    sendJson,
    studioDetailPayload,
    studioSummaries
  } = deps;

  if (url.pathname === "/api/rankings" && req.method === "GET") {
    sendJson(res, 200, { lists: rankingSummaries() });
    return true;
  }

  if (url.pathname === "/api/rankings/top" && req.method === "GET") {
    sendJson(res, 200, rankingWorksPayload(url, "top"));
    return true;
  }

  if (url.pathname === "/api/studios" && req.method === "GET") {
    try {
      sendJson(res, 200, studioSummaries(url));
    } catch (error) {
      sendJson(res, 500, { error: error.message || "读取厂商失败" });
    }
    return true;
  }

  const studioMatch = /^\/api\/studios\/([^/]+)$/.exec(url.pathname);
  if (studioMatch && req.method === "GET") {
    try {
      const payload = studioDetailPayload(decodeURIComponent(studioMatch[1]), url);
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
