import { readJsonBody } from "../../../platform/server/request-io.js";
import { PHOTO_CATEGORY_COVER_MAX_BYTES, PHOTO_CATEGORY_COVER_ROUTE } from "./photo-category-cover-store.js";

const categoryCoverBodyLimit = 4 * Math.ceil(PHOTO_CATEGORY_COVER_MAX_BYTES / 3) + 1024;

export async function routeContentIndexApi(req, res, url, deps) {
  const { imageLibraryService, photoCategoryCoverStore, photoLibraryStore, requireLocalAdmin, sendJson } = deps;

  if (url.pathname === "/api/image-library/photo-card-counts" && req.method === "GET") {
    const ids = [...new Set(url.searchParams.getAll("ids"))];
    if (ids.length > 24 || ids.some(id => !id || id.length > 4096)) {
      sendJson(res, 400, { error: "每次最多查询 24 个有效的套图编号" });
      return true;
    }
    try {
      const counts = ids.length ? Object.fromEntries(photoLibraryStore.contentImageCounts(ids)) : {};
      sendJson(res, 200, { counts });
    } catch {
      sendJson(res, 500, { error: "套图张数读取失败" });
    }
    return true;
  }

  if (url.pathname === PHOTO_CATEGORY_COVER_ROUTE && (req.method === "GET" || req.method === "PUT")) {
    if (!requireLocalAdmin(req, res)) return true;
    try {
      const category = url.searchParams.get("category");
      const result = req.method === "GET" ? photoCategoryCoverStore.read(category, {
        offset: url.searchParams.get("offset"), limit: url.searchParams.get("limit"), q: url.searchParams.get("q")
      }) : { settings: photoCategoryCoverStore.save(category, await readJsonBody(req, categoryCoverBodyLimit)) };
      sendJson(res, 200, result);
    } catch (error) {
      sendJson(res, error.statusCode || 500, { error: error.statusCode ? error.message : "分类封面操作失败" });
    }
    return true;
  }

  if (url.pathname === `${PHOTO_CATEGORY_COVER_ROUTE}/image` && (req.method === "GET" || req.method === "HEAD")) {
    try {
      const version = url.searchParams.get("v");
      const row = photoCategoryCoverStore.image(url.searchParams.get("category"), version);
      if (!row) sendJson(res, 404, { error: "分类封面不存在" });
      else {
        const etag = `"${version}"`;
        const headers = {
          "Cache-Control": "private, max-age=31536000, immutable",
          "Content-Type": row.mime,
          "X-Content-Type-Options": "nosniff",
          ETag: etag
        };
        const validators = req.headers["if-none-match"]?.split(",").map(value => value.trim());
        if (validators?.some(value => value === "*" || value.replace(/^W\//u, "") === etag)) res.writeHead(304, headers).end();
        else res.writeHead(200, { ...headers, "Content-Length": row.image.length }).end(req.method === "HEAD" ? undefined : row.image);
      }
    } catch {
      sendJson(res, 500, { error: "分类封面读取失败" });
    }
    return true;
  }

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
      sendJson(res, 200, imageLibraryService.summaryPayload({
        includeCache: url.searchParams.get("cache") !== "0",
        photoOnly: url.searchParams.get("mode") === "photo"
      }));
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

  if (url.pathname === "/api/image-library/photo-analysis" && req.method === "GET") {
    try {
      sendJson(res, 200, imageLibraryService.photoLibraryAnalysisPayload());
    } catch (error) {
      sendJson(res, error.statusCode || 500, { error: error.message || "套图分析读取失败" });
    }
    return true;
  }

  if (url.pathname === "/api/image-library/photo-collection-health" && req.method === "GET") {
    try {
      sendJson(res, 200, imageLibraryService.photoCollectionHealthPayload(url.searchParams.get("collection")));
    } catch (error) {
      sendJson(res, error.statusCode || 500, { error: error.message || "合集体检读取失败" });
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
