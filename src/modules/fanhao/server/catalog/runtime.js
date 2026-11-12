import { routeCatalogApi } from "./routes.js";
import { createLtxCatalogService } from "./ltx-catalog-service.js";

export function createCatalogRuntime(deps) {
  const ltxService = deps.ltx ? createLtxCatalogService(deps.ltx) : null;

  async function routeApi(req, res, url) {
    if (ltxService && url.pathname === "/api/fanhao/ltx/sync" && req.method === "POST") {
      if (!deps.ltx.requireLocalAdmin(req, res)) return true;
      try {
        deps.sendJson(res, 200, await ltxService.sync());
      } catch {
        deps.sendJson(res, 503, { error: "同步 LTX 目录失败，请检查上游连接或重试。" });
      }
      return true;
    }
    if (ltxService && url.pathname === "/api/fanhao/ltx/local-media" && req.method === "GET") {
      if (!deps.ltx.requireLocalAdmin(req, res)) return true;
      try {
        deps.sendJson(res, 200, await ltxService.readLocalMedia(url.searchParams.get("code")));
      } catch {
        deps.sendJson(res, 503, { error: "暂时无法读取本地视频参数。" });
      }
      return true;
    }
    if (ltxService && url.pathname === "/api/fanhao/ltx" && req.method === "GET") {
      if (!deps.ltx.requireLocalAdmin(req, res)) return true;
      try {
        deps.sendJson(res, 200, await ltxService.read({ refresh: url.searchParams.get("refresh") === "1" }));
      } catch (error) {
        deps.sendJson(res, 503, { error: error.publicMessage || "读取 LTX 本地目录或文件索引失败，请重试。" });
      }
      return true;
    }
    return routeCatalogApi(req, res, url, deps);
  }

  function start() {
    deps.codePrefixService.prewarm();
    deps.studioService.prewarm();
    deps.rankingService.prewarm();
  }

  return {
    findIntakeMetadata: ltxService?.findIntakeMetadata,
    routeApi,
    start
  };
}
