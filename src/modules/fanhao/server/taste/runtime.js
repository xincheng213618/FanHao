import { createTasteService } from "./service.js";

export function createTasteRuntime({ dbPath, requireLocalAdmin, sendJson, service = createTasteService({ dbPath }) }) {
  async function routeApi(req, res, url) {
    const evidence = url.pathname === "/api/fanhao/taste/evidence";
    if (!evidence && url.pathname !== "/api/fanhao/taste") return false;
    if (!requireLocalAdmin(req, res)) return true;
    if (req.method !== "GET") { sendJson(res, 405, { error: "请求方法不支持" }); return true; }
    if (evidence) {
      const params = url.searchParams;
      const snapshot = params.get("snapshot"), dimension = params.get("dimension"), feature = params.get("feature");
      const scope = params.get("scope") || "marked";
      const offset = Number(params.get("offset") || 0);
      if (!snapshot || !dimension || !feature || !["marked", "unmarked"].includes(scope) || !Number.isSafeInteger(offset) || offset < 0) {
        sendJson(res, 400, { error: "缺少有效的分析快照或作品筛选。" });
        return true;
      }
      try { sendJson(res, 200, await service.evidence({ snapshot, dimension, feature, scope, offset })); }
      catch (error) {
        if (error.statusCode === 409) sendJson(res, 409, { code: "TASTE_SNAPSHOT_EXPIRED", error: error.message });
        else if (error.statusCode === 404) sendJson(res, 404, { error: error.message });
        else sendJson(res, 503, { error: "暂时无法读取作品，请稍后重试。", retryable: true });
      }
      return true;
    }
    try { sendJson(res, 200, await service.profile()); }
    catch { sendJson(res, 503, { error: "口味分析暂时不可用，请稍后重试。", retryable: true }); }
    return true;
  }
  return { routeApi, beginStop: service.beginStop, stop: service.stop };
}
