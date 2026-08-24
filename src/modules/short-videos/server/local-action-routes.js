import { sendShortVideoPublicError } from "./public-errors.js";

export async function routeShortVideoLocalActionApi(req, res, url, deps) {
  const match = /^\/api\/short-videos\/([^/]+)\/local-action$/.exec(url.pathname);
  if (!match || req.method !== "POST") return false;
  if (!deps.requireLocalAdmin(req, res)) return true;

  try {
    const id = decodeURIComponent(match[1]);
    const body = await deps.readJsonBody(req);
    const result = deps.localActions.schedule(id, body?.action);
    deps.sendJson(res, 200, { ok: true, ...result });
  } catch (error) {
    sendShortVideoPublicError(res, deps.sendJson, error, "本地文件操作失败");
  }
  return true;
}
