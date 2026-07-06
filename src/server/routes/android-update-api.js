export async function routeAndroidUpdateApi(req, res, url, deps) {
  const {
    androidUpdateService,
    sendJson
  } = deps;

  if (url.pathname === "/api/android/update" && req.method === "GET") {
    sendJson(res, 200, androidUpdateService.publicManifest(req, url));
    return true;
  }

  const androidUpdateApkMatch = /^\/api\/android\/update\/apk\/([^/]+)\/([^/]+)$/.exec(url.pathname);
  if (androidUpdateApkMatch && (req.method === "GET" || req.method === "HEAD")) {
    androidUpdateService.serveApk(req, res, androidUpdateApkMatch[1], androidUpdateApkMatch[2]);
    return true;
  }

  return false;
}
