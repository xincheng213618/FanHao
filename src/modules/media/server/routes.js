export async function routeMediaApi(req, res, url, deps) {
  const { galleryMediaService, notFound, sendJson } = deps;
  if (url.pathname === "/api/gallery-media/continue-watching" && req.method === "GET") {
    const kind = url.searchParams.get("kind") || "all";
    if (!["all", "movie", "tv", "anime"].includes(kind)) {
      sendJson(res, 400, { error: "未知的影视类型" });
      return true;
    }
    sendJson(res, 200, { items: galleryMediaService.continueWatching(kind, {
      limit: url.searchParams.get("limit"), includeProgressRevision: url.searchParams.get("includeProgressRevision") === "1"
    }) });
    return true;
  }
  const galleryMediaMatch = /^\/api\/gallery-media\/([^/]+)$/.exec(url.pathname);
  if (galleryMediaMatch && req.method === "GET") {
    const item = galleryMediaService.byId(decodeURIComponent(galleryMediaMatch[1]));
    if (!item) {
      notFound(res);
      return true;
    }
    sendJson(res, 200, { item: galleryMediaService.publicDetail(item) });
    return true;
  }
  return false;
}
