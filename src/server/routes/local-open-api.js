export async function routeLocalOpenApi(req, res, url, deps) {
  const {
    localOpenService,
    readJsonBody,
    requireTrustedNetworkPage,
    resolvePlayableVideoFile,
    sendJson
  } = deps;

  if (url.pathname === "/api/open-folder" && req.method === "POST") {
    if (!requireTrustedNetworkPage(req, res, "只能在本机或局域网同源页面打开本地文件夹")) return true;

    const body = await readJsonBody(req);
    let target = localOpenService.resolveFolderTarget(body.sourcePath || body.path);
    if (target.error && body.videoId) {
      const file = resolvePlayableVideoFile(body.videoId);
      target = file?.path ? localOpenService.resolveFolderTarget(file.path) : target;
    }
    if (target.error) {
      sendJson(res, 400, { error: target.error });
      return true;
    }

    sendJson(res, 200, { ok: true, path: target.relativePath });
    localOpenService.scheduleOpenFolder(target.folderPath);
    return true;
  }

  if (url.pathname === "/api/open-file" && req.method === "POST") {
    if (!requireTrustedNetworkPage(req, res, "只能在本机或局域网同源页面打开本地文件")) return true;

    const body = await readJsonBody(req);
    const target = localOpenService.resolveFileTarget(body.sourcePath || body.path);
    if (target.error) {
      sendJson(res, 400, { error: target.error });
      return true;
    }

    sendJson(res, 200, { ok: true, path: target.relativePath });
    localOpenService.scheduleOpenFile(target.filePath);
    return true;
  }

  return false;
}
