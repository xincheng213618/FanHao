export async function routeAndroidUpdateApi(req, res, url, deps) {
  const {
    androidUpdateService,
    sendJson
  } = deps;

  if (url.pathname === "/api/android/update" && req.method === "GET") {
    const manifest = await androidUpdateService.publicManifest(req, url);
    if (!req.aborted && !res.destroyed && !res.writableEnded) sendJson(res, 200, manifest);
    return true;
  }

  const androidUpdateApkMatch = /^\/api\/android\/update\/apk\/([^/]+)\/([^/]+)$/.exec(url.pathname);
  if (androidUpdateApkMatch && (req.method === "GET" || req.method === "HEAD")) {
    await androidUpdateService.serveApk(req, res, androidUpdateApkMatch[1], androidUpdateApkMatch[2]);
    return true;
  }

  return false;
}
