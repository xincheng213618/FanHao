export async function routeToolsApi(req, res, url, deps) {
  const {
    createTxtFormatDownload,
    readJsonBody,
    sendJson,
    serveTxtToolDownload,
    txtToolMaxBodyBytes
  } = deps;

  if (url.pathname === "/api/tools/txt-format" && req.method === "POST") {
    try {
      const body = await readJsonBody(req, txtToolMaxBodyBytes);
      const result = await createTxtFormatDownload(body);
      sendJson(res, 200, result);
    } catch (error) {
      sendJson(res, error.statusCode || 500, { error: error.message || "TXT 格式化失败" });
    }
    return true;
  }

  const txtDownloadMatch = /^\/api\/tools\/txt-format\/download\/([A-Za-z0-9_-]+)$/.exec(url.pathname);
  if (txtDownloadMatch && req.method === "GET") {
    serveTxtToolDownload(req, res, txtDownloadMatch[1]);
    return true;
  }

  return false;
}
