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

  function publicManifest(req, url) {
    const channel = normalizeChannel(url.searchParams.get("channel"));
    const currentVersionCode = clampInteger(url.searchParams.get("currentVersionCode"), 0, 0, Number.MAX_SAFE_INTEGER);
    const manifest = readJsonFile(manifestPath(channel), null);
    if (!manifest || !Number(manifest.versionCode)) {
      return {
        ok: true,
        channel,
        available: false,
        currentVersionCode,
        message: channel === "debug" ? "还没有发布调试版 APK" : "还没有发布正式版 APK"
      };
    }

    const fileName = sanitizeDownloadFileName(manifest.apkFile || `fanhao-${channel}.apk`, `fanhao-${channel}.apk`);
    const apkPath = safeChildPath(channelDir(channel), fileName);
    const exists = Boolean(apkPath && fs.existsSync(apkPath));
    const versionCode = Number(manifest.versionCode || 0);
    const available = exists && versionCode > currentVersionCode;
    const downloadPath = `/api/android/update/apk/${encodeURIComponent(channel)}/${encodeURIComponent(fileName)}`;
    return {
      ok: true,
      channel,
      available,
      currentVersionCode,
      versionCode,
      versionName: String(manifest.versionName || versionCode),
      minVersionCode: Number(manifest.minVersionCode || 0),
      required: Boolean(manifest.required),
      notes: Array.isArray(manifest.notes) ? manifest.notes.slice(0, 12) : [],
      updatedAt: String(manifest.updatedAt || ""),
      size: Number(manifest.size || (exists ? fs.statSync(apkPath).size : 0)),
      sha256: String(manifest.sha256 || ""),
      fileName,
      downloadUrl: `${requestBaseUrl(req)}${downloadPath}`,
      message: exists ? "" : "更新包文件不存在"
    };
  }

  function renderPage(req, url) {
    const update = publicManifest(req, url);
    const pageUrl = new URL("/android-update", requestBaseUrl(req));
    if (update.channel === "release") pageUrl.searchParams.set("channel", "release");
    return renderAndroidDownloadPage(update, pageUrl.toString());
  }

  function serveApk(req, res, channel, fileName) {
    const normalizedChannel = normalizeChannel(channel);
    const safeName = sanitizeDownloadFileName(decodeURIComponent(fileName || ""), `fanhao-${normalizedChannel}.apk`);
    const manifest = readJsonFile(manifestPath(normalizedChannel), null);
    const manifestFileName = String(manifest?.apkFile || "");
    const authorizedName = sanitizeDownloadFileName(manifestFileName, "");
    if (!authorizedName || authorizedName !== manifestFileName || safeName !== authorizedName) {
      notFound(res);
      return;
    }
    const apkPath = safeChildPath(channelDir(normalizedChannel), safeName);
    if (!apkPath || !fs.existsSync(apkPath) || normalizeExt(apkPath) !== ".apk") {
      notFound(res);
      return;
    }

    const stat = fs.statSync(apkPath);
    res.writeHead(200, {
      "Content-Type": "application/vnd.android.package-archive",
      "Content-Length": stat.size,
      "Content-Disposition": attachmentDisposition(safeName),
      "Cache-Control": "no-store"
    });
    if (req.method === "HEAD") {
      res.end();
      return;
    }
    fs.createReadStream(apkPath).pipe(res);
  }

  return {
    publicManifest,
    renderPage,
    serveApk
  };
}
