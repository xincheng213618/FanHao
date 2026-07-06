export async function routeShortVideoApi(req, res, url, deps) {
  const { notFound, readJsonBody, requireLocalAdmin, sendJson, shortVideoStore } = deps;

  if (url.pathname === "/api/short-videos/summary" && req.method === "GET") {
    try {
      sendJson(res, 200, shortVideoStore.summary());
    } catch (error) {
      sendJson(res, error.statusCode || 500, { error: error.message || "短视频概览读取失败" });
    }
    return true;
  }

  if (url.pathname === "/api/short-videos" && req.method === "GET") {
    try {
      sendJson(res, 200, shortVideoStore.listVideos(url));
    } catch (error) {
      sendJson(res, error.statusCode || 500, { error: error.message || "短视频列表读取失败" });
    }
    return true;
  }

  if (url.pathname === "/api/short-videos/rescan" && req.method === "POST") {
    if (!requireLocalAdmin(req, res)) return true;
    try {
      const body = await readJsonBody(req);
      sendJson(res, 200, shortVideoStore.scan(body?.root || ""));
    } catch (error) {
      sendJson(res, error.statusCode || 500, { error: error.message || "短视频点赞目录扫描失败" });
    }
    return true;
  }

  const adjacentMatch = /^\/api\/short-videos\/([^/]+)\/adjacent$/.exec(url.pathname);
  if (adjacentMatch && req.method === "GET") {
    const direction = url.searchParams.get("direction") === "prev" ? -1 : 1;
    const video = shortVideoStore.adjacentVideo(decodeURIComponent(adjacentMatch[1]), direction, url);
    if (!video) {
      notFound(res);
      return true;
    }
    sendJson(res, 200, { video });
    return true;
  }

  const detailMatch = /^\/api\/short-videos\/([^/]+)$/.exec(url.pathname);
  if (detailMatch && req.method === "GET") {
    const data = shortVideoStore.videoDetail(decodeURIComponent(detailMatch[1]), url);
    if (!data) {
      notFound(res);
      return true;
    }
    sendJson(res, 200, data);
    return true;
  }

  return false;
}
