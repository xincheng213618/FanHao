import { createHash } from "node:crypto";
import path from "node:path";
import { scheduleLocalPathAction } from "./local-actions.js";

export function createDiskUsageRoutes({
  getLibrary = () => null,
  mediaStreamService,
  normalizeExt,
  notFound,
  readJsonBody,
  requireLocalAdmin = () => true,
  requireTrustedNetworkPage = requireLocalAdmin,
  safeStat,
  sendJson,
  serveRangedFile,
  store,
  videoProbeService,
  videoExtensions = new Set()
}) {
  async function routeApi(req, res, url) {
    try {
      if (url.pathname === "/api/disk-usage/summary" && req.method === "GET") {
        sendJson(res, 200, store.summary());
        return true;
      }
      if (url.pathname === "/api/disk-usage/status" && req.method === "GET") {
        sendJson(res, 200, store.status());
        return true;
      }
      if (url.pathname === "/api/disk-usage/tree" && req.method === "GET") {
        sendJson(res, 200, store.tree(
          url.searchParams.get("drive"),
          url.searchParams.get("path"),
          url.searchParams.get("limit"),
          url.searchParams.get("depth")
        ));
        return true;
      }
      if (url.pathname === "/api/disk-usage/search" && req.method === "GET") {
        sendJson(res, 200, store.search(url.searchParams.get("drive"), url.searchParams.get("q"), url.searchParams.get("limit")));
        return true;
      }
      if (url.pathname === "/api/disk-usage/playback-target" && req.method === "GET") {
        const { cached, file } = requireCachedVideo(url.searchParams.get("drive"), url.searchParams.get("path"));
        const indexed = findIndexedVideo(file.path);
        const params = indexed
          ? new URLSearchParams({ workId: indexed.workId, videoId: indexed.videoId, returnTo: "/disk-usage" })
          : new URLSearchParams({ diskDrive: cached.drive.id, diskPath: file.path, returnTo: "/disk-usage" });
        const playerUrl = `/player.html?${params}`;
        if (url.searchParams.get("redirect") === "1") {
          res.writeHead(302, { "Cache-Control": "no-store", Location: playerUrl });
          res.end();
          return true;
        }
        sendJson(res, 200, {
          indexed: Boolean(indexed),
          playerUrl
        });
        return true;
      }
      if (url.pathname === "/api/disk-usage/item" && req.method === "GET") {
        const { cached, file } = requireCachedVideo(url.searchParams.get("drive"), url.searchParams.get("path"));
        sendJson(res, 200, { work: diskVideoAsWork(cached.drive, file) });
        return true;
      }
      if (url.pathname === "/api/disk-usage/playinfo" && req.method === "GET") {
        const { cached, file } = requireCachedVideo(url.searchParams.get("drive"), url.searchParams.get("path"));
        const playInfo = await videoProbeService.playInfoForFileAsync(file, file.id);
        sendJson(res, 200, diskPlayInfo(playInfo, cached.drive.id, file.path));
        return true;
      }
      if (url.pathname === "/api/disk-usage/refresh" && req.method === "POST") {
        if (!requireLocalAdmin(req, res)) return true;
        const body = await readJsonBody(req);
        sendJson(res, 202, { ok: true, task: store.refresh(body.driveId || body.drive) });
        return true;
      }
      if (url.pathname === "/api/disk-usage/open" && req.method === "POST") {
        if (!requireTrustedNetworkPage(req, res, "只能在本机或局域网同源页面打开磁盘路径")) return true;
        const body = await readJsonBody(req);
        const cached = store.cachedNode(body.driveId || body.drive, body.path);
        const stat = safeStat(cached.node.path);
        if (!stat) throw publicError("文件或文件夹当前不存在", 404);
        const action = body.action === "reveal" ? "reveal" : "open";
        sendJson(res, 200, { ok: true, action, path: cached.node.path });
        scheduleLocalPathAction(cached.node.path, { action, isDirectory: stat.isDirectory() });
        return true;
      }
    } catch (error) {
      sendJson(res, Number(error?.statusCode) || 500, { error: error?.message || "磁盘空间操作失败" });
      return true;
    }
    return false;
  }

  async function routeMedia(req, res, url) {
    if (url.pathname !== "/api/disk-usage/media" || !["GET", "HEAD"].includes(req.method)) return false;
    try {
      const cached = store.cachedNode(url.searchParams.get("drive"), url.searchParams.get("path"));
      const stat = safeStat(cached.node.path);
      if (!stat?.isFile()) {
        notFound(res);
        return true;
      }
      const extension = normalizeExt(cached.node.path);
      const file = {
        cacheControl: "private, no-store",
        ext: extension,
        fullResponse: false,
        modifiedAt: stat.mtime?.toISOString?.() || "",
        name: path.basename(cached.node.path),
        path: cached.node.path,
        size: stat.size
      };
      if (["remux", "transcode"].includes(url.searchParams.get("mode")) && videoExtensions.has(extension)) {
        mediaStreamService.serveTranscodedVideo(req, res, file, url);
      } else {
        serveRangedFile(req, res, file);
      }
    } catch (error) {
      sendJson(res, Number(error?.statusCode) || 500, { error: error?.message || "文件播放失败" });
    }
    return true;
  }

  function requireCachedVideo(driveId, requestedPath) {
    const cached = store.cachedNode(driveId, requestedPath);
    const stat = safeStat(cached.node.path);
    const extension = normalizeExt(cached.node.path);
    if (!stat?.isFile() || !videoExtensions.has(extension)) throw publicError("该缓存项目不是可播放的视频", 400);
    return {
      cached,
      file: {
        cacheControl: "private, no-store",
        ext: extension,
        fullResponse: false,
        id: diskVideoId(cached.node.path),
        modifiedAt: stat.mtime?.toISOString?.() || "",
        name: path.basename(cached.node.path),
        path: cached.node.path,
        playable: true,
        relativePath: cached.node.path,
        size: stat.size,
        type: "video"
      }
    };
  }

  function findIndexedVideo(filePath) {
    const library = getLibrary();
    const normalizedPath = path.resolve(filePath).toLocaleLowerCase("en-US");
    const indexedFile = [...(library?.filesById?.values?.() || [])]
      .find((candidate) => candidate?.type === "video" && path.resolve(candidate.path).toLocaleLowerCase("en-US") === normalizedPath);
    if (!indexedFile) return null;
    const work = [...(library?.worksById?.values?.() || [])]
      .find((candidate) => (candidate?.videos || []).some((video) => video.id === indexedFile.id));
    return work ? { videoId: indexedFile.id, workId: work.id } : null;
  }

  return { routeApi, routeMedia };
}

function diskVideoAsWork(drive, file) {
  const title = file.name || path.basename(file.path);
  return {
    id: `disk:${file.id}`,
    type: "disk-usage-media",
    diskUsage: true,
    diskDrive: drive.id,
    title,
    directoryName: path.basename(path.dirname(file.path)),
    relativePath: file.path,
    sourcePaths: [file.path],
    videoCount: 1,
    playableCount: 1,
    videoSize: file.size,
    videos: [{
      ...file,
      diskDrive: drive.id,
      diskPath: file.path,
      title: path.basename(file.name, file.ext)
    }],
    infoSummary: { title }
  };
}

function diskPlayInfo(playInfo, driveId, filePath) {
  const baseParams = new URLSearchParams({ drive: driveId, path: filePath });
  const mediaUrl = (mode = "", audio = "") => {
    const params = new URLSearchParams(baseParams);
    if (mode) params.set("mode", mode);
    if (audio) params.set("audio", audio);
    return `/api/disk-usage/media?${params}`;
  };
  if (playInfo.mode === "direct") {
    return {
      ...playInfo,
      streamUrl: mediaUrl(),
      fallbackStreamUrl: mediaUrl("transcode", "aac")
    };
  }
  return {
    ...playInfo,
    streamUrl: mediaUrl(playInfo.mode, playInfo.audioCodec === "aac" ? "copy" : "aac")
  };
}

function diskVideoId(filePath) {
  return `disk-${createHash("sha1").update(path.resolve(filePath).toLocaleLowerCase("en-US")).digest("hex")}`;
}

function publicError(message, statusCode) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}
