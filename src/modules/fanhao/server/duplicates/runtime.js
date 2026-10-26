import { createDuplicateService } from "./service.js";
import { createDuplicateIndexCleanup } from "./index-cleanup.js";

export function createDuplicateRuntime(deps) {
  const service = deps.service || createDuplicateService({ ...deps,
    cleanupMissing: deps.getCoreDb ? createDuplicateIndexCleanup(deps) : null });
  async function routeApi(req, res, url) {
    const match = /^\/api\/fanhao\/duplicates(?:\/(.*))?$/.exec(url.pathname);
    if (!match) return false;
    if (!deps.requireLocalAdmin(req, res)) return true;
    const suffix = match[1] || "";
    try {
      let result;
      if (req.method === "GET" && !suffix) result = await service.list({ q: url.searchParams.get("q") || "", offset: Number(url.searchParams.get("offset") || 0), limit: Number(url.searchParams.get("limit") || 20), refresh: url.searchParams.get("refresh") === "1" });
      else if (req.method === "GET" && /^checks\/[a-f0-9-]{36}$/.test(suffix)) result = service.check(suffix.split("/")[1]);
      else if (req.method === "POST" && ["resolve", "recheck", "cleanup", "probe", "check"].includes(suffix)) {
        const body = await deps.readJsonBody(req, 4096);
        if (!body || typeof body !== "object" || Array.isArray(body)) throw Object.assign(new Error("比对请求格式无效。"), { statusCode: 400 });
        result = suffix === "resolve" ? await service.resolve(body.groupId, body.fileId) : suffix === "recheck" ? await service.recheck(body.groupId) : suffix === "cleanup" ? await service.cleanup(body) : suffix === "probe" ? await service.probe(body.groupId, body.fileIds) : await service.startCheck(body.groupId, body.fileIds);
      } else if (req.method === "POST" && /^checks\/[a-f0-9-]{36}\/cancel$/.test(suffix)) result = service.cancel(suffix.split("/")[1]);
      else { deps.sendJson(res, 405, { error: "比对接口不支持此请求。" }); return true; }
      if (!res.destroyed) deps.sendJson(res, 200, result);
    } catch (error) { if (!res.destroyed) deps.sendJson(res, error.statusCode || 503, { error: error.statusCode ? error.message : "重复文件比对暂时不可用，请重试。", code: error.code || "DUPLICATE_UNAVAILABLE" }); }
    return true;
  }
  return { routeApi, beginStop: service.beginStop, stop: service.stop };
}
