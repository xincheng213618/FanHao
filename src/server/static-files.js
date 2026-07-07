import fs from "node:fs";
import path from "node:path";

const APP_PAGE_PATHS = new Set([
  "/fanhao",
  "/gallery",
  "/photo",
  "/photos",
  "/photo-sets",
  "/manga",
  "/western",
  "/media",
  "/video",
  "/videos",
  "/movie",
  "/movies",
  "/tv",
  "/studios",
  "/vr",
  "/favorites",
  "/history",
  "/rankings",
  "/novels",
  "/music",
  "/short-video",
  "/short-videos",
  "/douyin",
  "/tools"
]);

const APP_PAGE_PREFIXES = [
  "/gallery/",
  "/photo/",
  "/photos/",
  "/photo-sets/",
  "/manga/",
  "/western/",
  "/media/",
  "/video/",
  "/videos/",
  "/movie/",
  "/movies/",
  "/studios/",
  "/vr/",
  "/novels/",
  "/music/",
  "/short-video/",
  "/short-videos/",
  "/douyin/",
  "/tv/"
];

export function isAppPagePath(routePath) {
  return APP_PAGE_PATHS.has(routePath) || APP_PAGE_PREFIXES.some((prefix) => routePath.startsWith(prefix));
}

export function createStaticFileServer({ publicDir, mimeTypes, normalizeExt, notFound }) {
  function publicFilePath(urlPath) {
    const routePath = String(urlPath || "/").replace(/\/+$/g, "") || "/";
    const requested =
      routePath === "/" || isAppPagePath(routePath)
        ? "/index.html"
        : routePath === "/admin"
          ? "/admin.html"
          : urlPath;
    const decoded = decodeURIComponent(requested);
    const normalized = path.normalize(decoded).replace(/^(\.\.[/\\])+/, "");
    const target = path.join(publicDir, normalized);
    const relative = path.relative(publicDir, target);
    if (relative.startsWith("..") || path.isAbsolute(relative)) return null;
    return target;
  }

  function serveStatic(req, res, urlPath) {
    const target = publicFilePath(urlPath);
    if (!target || !fs.existsSync(target) || !fs.statSync(target).isFile()) {
      notFound(res);
      return;
    }

    const ext = normalizeExt(target);
    res.writeHead(200, {
      "Content-Type": mimeTypes[ext] || "application/octet-stream",
      "Cache-Control": "no-store"
    });
    fs.createReadStream(target).pipe(res);
  }

  return {
    publicFilePath,
    serveStatic
  };
}
