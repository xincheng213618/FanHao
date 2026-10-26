import { createTasteService } from "./service.js";

export function createTasteRuntime({ dbPath, requireLocalAdmin, sendJson, service = createTasteService({ dbPath }) }) {
  async function routeApi(req, res, url) {
    if (url.pathname !== "/api/fanhao/taste") return false;
    if (!requireLocalAdmin(req, res)) return true;
    if (req.method !== "GET") { sendJson(res, 405, { error: "请求方法不支持" }); return true; }
    try { sendJson(res, 200, await service.profile()); }
    catch { sendJson(res, 503, { error: "口味分析暂时不可用，请稍后重试。", retryable: true }); }
    return true;
  }
  return { routeApi, beginStop: service.beginStop, stop: service.stop };
}
