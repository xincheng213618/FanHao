export async function routeMediaApi(req, res, url, deps) {
  const { galleryMediaService, notFound, sendJson } = deps;
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
