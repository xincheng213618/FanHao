import fs from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream";
import { constants as zlibConstants, createBrotliCompress, createGzip } from "node:zlib";

const COMPRESSIBLE_EXTENSIONS = new Set([
  ".css",
  ".csv",
  ".html",
  ".js",
  ".json",
  ".md",
  ".svg",
  ".txt",
  ".xml"
]);
const STATIC_COMPRESSION_MIN_BYTES = 1024;

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
  "/fanhao/",
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
  function acceptedCompression(req, ext, size) {
    if (!COMPRESSIBLE_EXTENSIONS.has(ext) || size < STATIC_COMPRESSION_MIN_BYTES) return "";
    const accepted = String(req.headers["accept-encoding"] || "").toLowerCase();
    if (/(?:^|,)\s*br(?:\s*;|\s*,|$)/.test(accepted)) return "br";
    if (/(?:^|,)\s*gzip(?:\s*;|\s*,|$)/.test(accepted)) return "gzip";
    return "";
  }

  function cacheControl(req, ext) {
    const versioned = /(?:\?|&)v=[^&]+/.test(String(req.url || ""));
    if (versioned && ext !== ".html") return "public, max-age=31536000, immutable";
    return "no-store";
  }

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
    const stat = target && fs.existsSync(target) ? fs.statSync(target) : null;
    if (!target || !stat?.isFile()) {
      notFound(res);
      return;
    }

    const ext = normalizeExt(target);
    const encoding = acceptedCompression(req, ext, stat.size);
    res.writeHead(200, {
      "Content-Type": mimeTypes[ext] || "application/octet-stream",
      "Cache-Control": cacheControl(req, ext),
      ...(encoding ? { "Content-Encoding": encoding, Vary: "Accept-Encoding" } : { "Content-Length": stat.size })
    });
    if (req.method === "HEAD") {
      res.end();
      return;
    }
    const source = fs.createReadStream(target);
    if (!encoding) {
      pipeline(source, res, () => {});
      return;
    }
    const compressor = encoding === "br"
      ? createBrotliCompress({
          params: {
            [zlibConstants.BROTLI_PARAM_QUALITY]: 5
          }
        })
      : createGzip({ level: 6 });
    pipeline(source, compressor, res, () => {});
  }

  return {
    publicFilePath,
    serveStatic
  };
}
