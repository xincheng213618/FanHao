import fs from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream";
import { finished } from "node:stream/promises";
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
const CONTENT_HASH_VERSION = /^(?:bundle-|sha256-)[a-f0-9]{12,64}$/i;

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
  "/novel",
  "/novels",
  "/music",
  "/musics",
  "/songs",
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
  "/novel/",
  "/novels/",
  "/music/",
  "/musics/",
  "/songs/",
  "/short-video/",
  "/short-videos/",
  "/douyin/",
  "/tv/"
];

const STANDALONE_PAGE_FILES = new Map([
  ["/fanhao/file-workflows", "/modules/fanhao/file-workflows/index.html"],
  ["/disk-usage", "/modules/fanhao/disk-usage/index.html"],
  ["/system-control", "/modules/system/computer-control/index.html"]
]);

export function isAppPagePath(routePath) {
  return APP_PAGE_PATHS.has(routePath) || APP_PAGE_PREFIXES.some((prefix) => routePath.startsWith(prefix));
}

export function staticCacheControl(requestUrl, ext) {
  if (ext === ".html") return "no-store";
  const version = /(?:\?|&)v=([^&]+)/.exec(String(requestUrl || ""))?.[1] || "";
  try {
    if (CONTENT_HASH_VERSION.test(decodeURIComponent(version))) return "public, max-age=31536000, immutable";
  } catch {}
  return "no-store";
}

export function createStaticFileServer({
  publicDir, mimeTypes, normalizeExt, notFound,
  openFile = (target, flags) => fs.promises.open(target, flags), stopTimeoutMs = 2000
}) {
  const owners = new Set();
  const normalizedStopTimeoutMs = Math.max(1, Math.floor(Number(stopTimeoutMs) || 2000));
  let accepting = true, lifecycleGeneration = 0, stopTask = null;
  const incompleteStop = () => Object.assign(new Error("Static file descriptors have not finished closing"), {
    code: "STATIC_FILE_STOP_INCOMPLETE", statusCode: 503
  });
  function releaseOwner(owner) {
    if (!owner.done || (owner.handle && !owner.closed)) return;
    if (owners.delete(owner)) owner.release();
  }
  function beginStop() {
    accepting = false;
    lifecycleGeneration += 1;
    for (const owner of owners) owner.controller.abort();
  }
  function stop() {
    beginStop();
    if (stopTask) return stopTask;
    let timer;
    const physicalDrain = Promise.all([...owners].map(owner => owner.released));
    const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(incompleteStop()), normalizedStopTimeoutMs); });
    const task = Promise.race([physicalDrain, timeout]).finally(() => {
      clearTimeout(timer);
      if (stopTask === task) stopTask = null;
    });
    stopTask = task;
    return task;
  }
  async function start() {
    const generation = lifecycleGeneration;
    if (stopTask) {
      try { await stopTask; }
      catch (error) { if (owners.size) throw error; }
    }
    if (generation !== lifecycleGeneration) return false;
    if ((!accepting && owners.size) || [...owners].some(owner => owner.closeFailed)) throw incompleteStop();
    accepting = true;
    return true;
  }
  function acceptedCompression(req, ext, size) {
    if (!COMPRESSIBLE_EXTENSIONS.has(ext) || size < STATIC_COMPRESSION_MIN_BYTES) return "";
    const accepted = String(req.headers["accept-encoding"] || "").toLowerCase();
    if (/(?:^|,)\s*br(?:\s*;|\s*,|$)/.test(accepted)) return "br";
    if (/(?:^|,)\s*gzip(?:\s*;|\s*,|$)/.test(accepted)) return "gzip";
    return "";
  }

  function publicFilePath(urlPath) {
    const routePath = String(urlPath || "/").replace(/\/+$/g, "") || "/";
    const requested =
      STANDALONE_PAGE_FILES.get(routePath) ||
      (routePath === "/" || isAppPagePath(routePath)
        ? "/index.html"
        : routePath === "/admin"
          ? "/admin.html"
          : urlPath);
    const decoded = decodeURIComponent(requested);
    const normalized = path.normalize(decoded).replace(/^(\.\.[/\\])+/, "");
    const target = path.join(publicDir, normalized);
    const relative = path.relative(publicDir, target);
    if (relative.startsWith("..") || path.isAbsolute(relative)) return null;
    return target;
  }

  function serveStatic(req, res, urlPath) {
    if (!accepting) {
      if (!req.aborted && !res.destroyed && !res.writableEnded) {
        res.writeHead(503, { "Content-Type": "text/plain; charset=utf-8", "Content-Length": 0, "Cache-Control": "no-store" });
        res.end();
      }
      return Promise.resolve();
    }
    const owner = { controller: new AbortController(), done: false, handle: null, closed: false, closeFailed: false };
    owner.released = new Promise(resolve => { owner.release = resolve; });
    owners.add(owner);
    return runStatic(req, res, urlPath, owner).finally(() => { owner.done = true; releaseOwner(owner); });
  }

  async function runStatic(req, res, urlPath, owner) {
    const disconnected = () => owner.controller.signal.aborted || req.aborted || res.destroyed || res.writableEnded;
    if (disconnected()) return;
    let handle, source, sourceClosed, compressor, compressorClosed;
    const abort = () => {
      source?.destroy(); compressor?.destroy();
      if (!res.destroyed && !res.writableEnded) res.destroy();
    };
    req.once?.("aborted", abort);
    res.once?.("close", abort);
    owner.controller.signal.addEventListener("abort", abort, { once: true });
    try {
      const target = publicFilePath(urlPath);
      if (!target) { notFound(res); return; }
      try {
        handle = await openFile(target, "r");
        owner.handle = handle;
        const closeHandle = handle.close.bind(handle);
        // FileHandle emits close and sets fd=-1 before native close settles.
        // Auto-close and final cleanup must await that same first promise.
        handle.close = () => owner.closePromise ||= Promise.resolve().then(closeHandle);
      } catch (error) {
        if (disconnected()) return;
        if (["ENOENT", "ENOTDIR", "EISDIR", "EACCES", "EPERM"].includes(error?.code)) {
          notFound(res);
          return;
        }
        throw error;
      }
      if (disconnected()) return;
      const stat = await handle.stat();
      if (disconnected()) return;
      if (!stat.isFile()) {
        notFound(res);
        return;
      }
      const ext = normalizeExt(target);
      const encoding = acceptedCompression(req, ext, stat.size);
      const headers = {
        "Content-Type": mimeTypes[ext] || "application/octet-stream",
        "Cache-Control": staticCacheControl(req.url, ext),
        ...(encoding ? { "Content-Encoding": encoding, Vary: "Accept-Encoding" } : { "Content-Length": stat.size })
      };
      if (req.method === "HEAD" || stat.size === 0) {
        res.writeHead(200, headers);
        res.end();
        return;
      }
      // Metadata and bytes share the opened file even if its path is replaced.
      source = handle.createReadStream({ autoClose: true, emitClose: true });
      sourceClosed = new Promise(resolve => source.once("close", resolve));
      compressor = encoding === "br"
        ? createBrotliCompress({ params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 5 } })
        : encoding === "gzip" ? createGzip({ level: 6 }) : null;
      if (compressor) compressorClosed = new Promise(resolve => compressor.once("close", resolve));
      if (disconnected()) {
        source.destroy();
        compressor?.destroy();
        await finished(source, { cleanup: true }).catch(() => {});
        return;
      }
      res.writeHead(200, headers);
      await new Promise(resolve => {
        // Pipeline owns post-header errors and response disconnects. A failed
        // body must destroy the response rather than append a JSON error.
        if (compressor) pipeline(source, compressor, res, () => resolve());
        else pipeline(source, res, () => resolve());
      });
    } catch (error) {
      if (source) {
        source.destroy();
        compressor?.destroy();
        await finished(source, { cleanup: true }).catch(() => {});
      }
      if (!disconnected()) throw error;
    } finally {
      try {
        source?.destroy(); compressor?.destroy();
        if (source && !source.closed) await sourceClosed;
        if (compressor && !compressor.closed) await compressorClosed;
        try {
          await handle?.close();
          owner.closed = true;
        } catch (error) {
          // Neither fd=-1 nor a close event proves a failed native close has
          // released the descriptor. Retain unknown ownership without retry.
          owner.closeFailed = true;
          throw error;
        }
      } finally {
        req.off?.("aborted", abort);
        res.off?.("close", abort);
        owner.controller.signal.removeEventListener("abort", abort);
      }
    }
  }

  return {
    publicFilePath,
    serveStatic,
    start, beginStop, stop,
    diagnostics: () => ({ accepting, active: owners.size, closeFailed: [...owners].filter(owner => owner.closeFailed).length })
  };
}
