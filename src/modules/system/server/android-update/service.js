import fs from "node:fs";
import path from "node:path";
import { renderAndroidDownloadPage } from "./page.js";

function sanitizeDownloadFileName(value, fallback = "download") {
  const raw = String(value || "").replaceAll("\\", "/");
  const name = path
    .basename(raw)
    .replace(/[\x00-\x1f<>:"/\\|?*]+/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[. ]+$/g, "");
  return (name || fallback).slice(0, 140);
}

function attachmentDisposition(fileName) {
  const fallback = sanitizeDownloadFileName(fileName, "download").replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  return `attachment; filename="${fallback || "download"}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}

export function createAndroidUpdateService({
  clampInteger,
  normalizeExt,
  notFound,
  port,
  readJsonFile,
  safeChildPath,
  serveWholeFile,
  updateDir
}) {
  function normalizeChannel(value) {
    const channel = String(value || "debug").trim().toLowerCase();
    return channel === "release" ? "release" : "debug";
  }

  function channelDir(channel) {
    return path.join(updateDir, normalizeChannel(channel));
  }

  function manifestPath(channel) {
    return path.join(channelDir(channel), "latest.json");
  }

  function requestBaseUrl(req) {
    const forwardedProtocol = String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim().toLowerCase();
    const protocol = ["http", "https"].includes(forwardedProtocol) ? forwardedProtocol : (req.socket.encrypted ? "https" : "http");
    const host = req.headers.host || `127.0.0.1:${port}`;
    return `${protocol}://${host}`;
  }

  async function readManifest(channel) {
    const manifest = await readJsonFile(manifestPath(channel), null);
    const versionCode = Number(manifest?.versionCode);
    return Number.isSafeInteger(versionCode) && versionCode > 0 ? manifest : null;
  }

  function publishedApk(channel, manifest) {
    const fileName = manifest?.apkFile;
    if (typeof fileName !== "string" || !fileName || sanitizeDownloadFileName(fileName, "") !== fileName) return null;
    const filePath = safeChildPath(channelDir(channel), fileName);
    return filePath && normalizeExt(filePath) === ".apk" ? { fileName, filePath } : null;
  }

  async function publicManifest(req, url) {
    const channel = normalizeChannel(url.searchParams.get("channel"));
    const currentVersionCode = clampInteger(url.searchParams.get("currentVersionCode"), 0, 0, Number.MAX_SAFE_INTEGER);
    const manifest = await readManifest(channel);
    if (!manifest) {
      return {
        ok: true,
        channel,
        available: false,
        currentVersionCode,
        message: channel === "debug" ? "还没有发布调试版 APK" : "还没有发布正式版 APK"
      };
    }

    const apk = publishedApk(channel, manifest);
    const stat = apk && await fs.promises.stat(apk.filePath).catch(() => null);
    const downloadable = stat?.isFile() === true;
    const versionCode = Number(manifest.versionCode);
    const downloadUrl = downloadable
      ? `${requestBaseUrl(req)}/api/android/update/apk/${encodeURIComponent(channel)}/${encodeURIComponent(apk.fileName)}`
      : "";
    return {
      ok: true,
      channel,
      available: downloadable && versionCode > currentVersionCode,
      currentVersionCode,
      versionCode,
      versionName: String(manifest.versionName || versionCode),
      minVersionCode: Number(manifest.minVersionCode || 0),
      required: Boolean(manifest.required),
      notes: Array.isArray(manifest.notes) ? manifest.notes.slice(0, 12) : [],
      updatedAt: String(manifest.updatedAt || ""),
      size: Number(manifest.size || (downloadable ? stat.size : 0)),
      sha256: String(manifest.sha256 || ""),
      fileName: apk?.fileName || "",
      downloadUrl,
      message: downloadable ? "" : apk ? "更新包文件不可用" : "更新包发布记录无效"
    };
  }

  async function renderPage(req, url) {
    const update = await publicManifest(req, url);
    const pageUrl = new URL("/android-update", requestBaseUrl(req));
    if (update.channel === "release") pageUrl.searchParams.set("channel", "release");
    return renderAndroidDownloadPage(update, pageUrl.toString());
  }

  async function serveApk(req, res, channel, fileName) {
    if (req.aborted || res.destroyed || res.writableEnded) return;
    const normalizedChannel = normalizeChannel(channel);
    let requestedName;
    try { requestedName = decodeURIComponent(fileName || ""); }
    catch { notFound(res); return; }
    const apk = publishedApk(normalizedChannel, await readManifest(normalizedChannel));
    if (req.aborted || res.destroyed || res.writableEnded) return;
    if (!apk || requestedName !== apk.fileName) {
      notFound(res);
      return;
    }

    return serveWholeFile(req, res, apk.filePath, stat => ({
      "Content-Type": "application/vnd.android.package-archive",
      "Content-Length": stat.size,
      "Content-Disposition": attachmentDisposition(apk.fileName),
      "Cache-Control": "no-store"
    }));
  }

  return {
    publicManifest,
    renderPage,
    serveApk
  };
}
