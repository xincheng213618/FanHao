export async function routeToolsApi(req, res, url, deps) {
  const {
    readJsonBody,
    requireLocalAdmin = () => true,
    sendJson,
    txtFormatToolService
  } = deps;

  if (url.pathname === "/api/tools/txt-format" && req.method === "POST") {
    if (!requireLocalAdmin(req, res)) return true;
    try {
      const body = await readJsonBody(req, txtFormatToolService.maxBodyBytes);
      const result = await txtFormatToolService.createDownload(body);
      sendJson(res, 200, result);
    } catch (error) {
      sendJson(res, error.statusCode || 500, { error: error.message || "TXT 格式化失败" });
    }
    return true;
  }

  const txtDownloadMatch = /^\/api\/tools\/txt-format\/download\/([A-Za-z0-9_-]+)$/.exec(url.pathname);
  if (txtDownloadMatch && req.method === "GET") {
    txtFormatToolService.serveDownload(req, res, txtDownloadMatch[1]);
    return true;
  }

  return false;
}
