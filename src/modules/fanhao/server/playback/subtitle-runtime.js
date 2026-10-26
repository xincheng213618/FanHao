import { createSubtitleService } from "./subtitle-service.js";

export function createSubtitleRuntime(deps) {
  const service = createSubtitleService(deps);
  async function routeApi(req, res, url) {
    const match = /^\/api\/works\/([^/]+)\/subtitles(?:\/(.*))?$/.exec(url.pathname);
    if (!match) return false;
    const suffix = match[2] || "";
    const controller = new AbortController();
    const abort = () => controller.abort();
    req.once("aborted", abort);
    const close = () => { if (!res.writableEnded) abort(); };
    res.once("close", close);
    if (req.aborted || res.destroyed) abort();
    try {
      let workId;
      try { workId = decodeURIComponent(match[1]); }
      catch { throw Object.assign(new Error("作品标识无效"), { statusCode: 400 }); }
      const videoId = url.searchParams.get("videoId") || "";
      const options = { signal: controller.signal };
      let result;
      if (req.method === "GET" && !suffix) result = await service.list(workId, videoId, options);
      else if (req.method === "GET" && suffix === "search") result = await service.search(workId, videoId, url.searchParams.get("query"), options);
      else if (req.method === "GET" && /^search\/[^/]+\/files$/.test(suffix)) result = await service.files(workId, videoId, decodeURIComponent(suffix.split("/")[1]), options);
      else if (req.method === "POST" && ["download", "upload"].includes(suffix)) {
        if (!deps.requireLocalAdmin(req, res)) return true;
        const body = await deps.readJsonBody(req, 3 * 1024 * 1024);
        result = await service[suffix](workId, body, options);
      } else if (["GET", "HEAD"].includes(req.method) && /^tracks\/[^/]+(?:\/download)?$/.test(suffix)) {
        const offsetSeconds = Number(url.searchParams.get("offsetSeconds") || 0);
        if (!Number.isFinite(offsetSeconds) || Math.abs(offsetSeconds) > 24 * 3600) throw Object.assign(new Error("字幕时间偏移无效"), { statusCode: 400 });
        const download = suffix.endsWith("/download");
        const content = await service.content(workId, videoId, decodeURIComponent(suffix.split("/")[1]), { ...options, offsetSeconds, download });
        if (controller.signal.aborted || res.destroyed) return true;
        res.writeHead(200, { "Content-Type": content.contentType, "Content-Length": content.bytes.length, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff",
          ...(download ? { "Content-Disposition": `attachment; filename="subtitle.${content.name.split(".").at(-1).replace(/[^a-z0-9]/gi, "")}"; filename*=UTF-8''${encodeURIComponent(content.name).replace(/['()*]/g, (char) => '%' + char.charCodeAt(0).toString(16))}` } : {}) });
        res.end(req.method === "HEAD" ? undefined : content.bytes);
        return true;
      } else { deps.sendJson(res, 405, { error: "字幕接口不支持此请求" }); return true; }
      if (!controller.signal.aborted && !res.destroyed) deps.sendJson(res, 200, result);
    } catch (error) {
      if (!controller.signal.aborted && !res.destroyed && !res.writableEnded) {
        const status = error.statusCode || (error instanceof URIError ? 400 : error.code === "ENOENT" ? 404 : 500);
        deps.sendJson(res, status, { error: error.statusCode ? error.message : error.code === "ENOENT" ? "字幕文件不存在，请刷新后重试" : "字幕处理失败，请重试", ...(error.code ? { code: error.code } : {}), ...(error.retryable ? { retryable: true } : {}) });
      }
    } finally { req.removeListener("aborted", abort); res.removeListener("close", close); }
    return true;
  }
  return { routeApi, beginStop: service.beginStop, stop: service.stop };
}
