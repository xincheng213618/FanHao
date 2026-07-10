import fs from "node:fs";
import path from "node:path";

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

function htmlEscape(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function formatBytes(size) {
  const value = Number(size || 0);
  if (!Number.isFinite(value) || value <= 0) return "-";
  if (value >= 1024 * 1024 * 1024) return `${(value / 1024 / 1024 / 1024).toFixed(2)} GB`;
  if (value >= 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)} MB`;
  if (value >= 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${value} B`;
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
    const protocol = String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim() || (req.socket.encrypted ? "https" : "http");
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
    const channel = normalizeChannel(update.channel);
    const title = channel === "debug" ? "FanHao 调试版更新" : "FanHao 正式版更新";
    const status = update.versionCode
      ? (update.message || `最新版本 ${update.versionName || update.versionCode}`)
      : update.message;
    const notes = update.notes?.length
      ? update.notes.map((item) => `<li>${htmlEscape(item)}</li>`).join("")
      : "<li>暂无更新说明</li>";
    const downloadButton = update.downloadUrl && !update.message
      ? `<a class="primary" href="${htmlEscape(update.downloadUrl)}">下载 APK</a>`
      : `<button class="primary" type="button" disabled>暂无可下载 APK</button>`;
    const apiUrl = `/api/android/update?channel=${encodeURIComponent(channel)}`;

    return `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
    <title>${htmlEscape(title)}</title>
    <style>
      :root { color-scheme: light dark; --brand: #1f7a62; --text: #17231f; --muted: #64746f; --line: #d9e1de; --panel: #ffffff; --bg: #f5f7f6; }
      @media (prefers-color-scheme: dark) { :root { --text: #edf4f1; --muted: #a6b5b0; --line: #263631; --panel: #101916; --bg: #08110e; } }
      body { margin: 0; background: var(--bg); color: var(--text); font: 16px/1.55 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
      main { width: min(680px, calc(100vw - 32px)); margin: 0 auto; padding: 40px 0; }
      .panel { background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 24px; }
      h1 { margin: 0 0 8px; font-size: clamp(26px, 6vw, 38px); letter-spacing: 0; }
      p { margin: 0; color: var(--muted); }
      dl { display: grid; grid-template-columns: 96px 1fr; gap: 10px 16px; margin: 24px 0; }
      dt { color: var(--muted); }
      dd { margin: 0; word-break: break-all; }
      ul { margin: 8px 0 24px; padding-left: 20px; }
      .actions { display: flex; flex-wrap: wrap; gap: 12px; align-items: center; }
      a, button { border-radius: 8px; padding: 11px 16px; font: inherit; text-decoration: none; }
      .primary { border: 1px solid var(--brand); background: var(--brand); color: #fff; }
      button.primary:disabled { opacity: .55; }
      .secondary { border: 1px solid var(--line); color: var(--text); background: transparent; }
      .hint { margin-top: 16px; font-size: 14px; }
    </style>
  </head>
  <body>
    <main>
      <section class="panel">
        <h1>${htmlEscape(title)}</h1>
        <p>${htmlEscape(status || "等待发布更新包")}</p>
        <dl>
          <dt>通道</dt><dd>${htmlEscape(channel)}</dd>
          <dt>版本</dt><dd>${htmlEscape(update.versionName || "-")}${update.versionCode ? ` (${htmlEscape(update.versionCode)})` : ""}</dd>
          <dt>大小</dt><dd>${htmlEscape(formatBytes(update.size))}</dd>
          <dt>更新时间</dt><dd>${htmlEscape(update.updatedAt || "-")}</dd>
          <dt>文件</dt><dd>${htmlEscape(update.fileName || "-")}</dd>
        </dl>
        <h2>更新说明</h2>
        <ul>${notes}</ul>
        <div class="actions">
          ${downloadButton}
          <a class="secondary" href="${htmlEscape(apiUrl)}">查看 JSON</a>
          <a class="secondary" href="/">返回网页端</a>
        </div>
        <p class="hint">调试阶段使用 debug 包；手机端也会从同一通道检查更新。</p>
      </section>
    </main>
  </body>
</html>`;
  }

  function serveApk(req, res, channel, fileName) {
    const normalizedChannel = normalizeChannel(channel);
    const safeName = sanitizeDownloadFileName(decodeURIComponent(fileName || ""), `fanhao-${normalizedChannel}.apk`);
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
