export async function routeContentIndexApi(req, res, url, deps) {
  const { imageLibraryService, requireLocalAdmin, sendJson } = deps;

  if (url.pathname === "/api/image-library" && req.method === "GET") {
    try {
      sendJson(res, 200, imageLibraryService.payload());
    } catch (error) {
      sendJson(res, error.statusCode || 500, { error: error.message || "图像资料库读取失败" });
    }
    return true;
  }

  if (url.pathname === "/api/image-library/summary" && req.method === "GET") {
    try {
      sendJson(res, 200, imageLibraryService.summaryPayload());
    } catch (error) {
      sendJson(res, error.statusCode || 500, { error: error.message || "图像资料库概览读取失败" });
    }
    return true;
  }

  if (url.pathname === "/api/image-library/items" && req.method === "GET") {
    try {
      sendJson(res, 200, imageLibraryService.itemsPayload(url));
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

  return false;
}
