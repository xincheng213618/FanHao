import qrcode from "qrcode-generator";

const qrCache = new Map();
const downloadIcon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M12 3v12m-5-5 5 5 5-5M5 16v4h14v-4" stroke-linecap="round" stroke-linejoin="round"/></svg>';

function escape(value) {
  return String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}

function formatBytes(value) {
  const bytes = Number(value);
  if (!Number.isFinite(bytes) || bytes <= 0) return "—";
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}

function formatDate(value) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23"
  }).format(date);
}

function renderQr(pageUrl) {
  if (qrCache.has(pageUrl)) return qrCache.get(pageUrl);
  const code = qrcode(0, "M");
  code.addData(pageUrl);
  code.make();
  const svg = code.createSvgTag({ cellSize: 5, margin: 20, scalable: true })
    .replace("<svg ", '<svg role="img" aria-label="扫码打开 FanHao 下载页" ');
  if (qrCache.size >= 16) qrCache.delete(qrCache.keys().next().value);
  qrCache.set(pageUrl, svg);
  return svg;
}

export function renderAndroidDownloadPage(update, pageUrl) {
  const channel = update.channel === "release" ? "release" : "debug";
  const channelLabel = channel === "release" ? "正式版" : "调试版";
  const downloadable = Boolean(update.downloadUrl && !update.message);
  const downloadPath = `/api/android/update/apk/${channel}/${encodeURIComponent(update.fileName || "")}`;
  const notes = update.notes?.length
    ? update.notes.map((note) => `<li>${escape(note)}</li>`).join("")
    : "<li>暂无更新说明。</li>";
  const download = downloadable
    ? `<a class="download-button" href="${escape(downloadPath)}" download>${downloadIcon}<span>下载最新版 APK</span><span class="button-size">${escape(formatBytes(update.size))}</span></a>`
    : `<button class="download-button" type="button" disabled>${downloadIcon}<span>暂无可下载版本</span></button>`;
  const sha256 = /^[a-f0-9]{64}$/i.test(update.sha256 || "") ? update.sha256 : "暂未提供";

  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
  <meta name="theme-color" content="#f6f8f7" />
  <meta name="description" content="下载 FanHao 安卓版，查看最新版本、更新说明和安装步骤。无需登录即可下载安装。" />
  <title>FanHao 安卓版 · 下载与更新</title>
  <style>
    :root { color-scheme: light dark; --bg:#f6f8f7; --panel:#fff; --ink:#172d25; --muted:#64736c; --line:#dce5df; --brand:#176b50; --soft:#eaf3ee; --on-brand:#fff; }
    * { box-sizing:border-box; }
    body { margin:0; background:var(--bg); color:var(--ink); font:15px/1.7 -apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",sans-serif; -webkit-font-smoothing:antialiased; }
    a { color:var(--brand); text-decoration:none; }
    a:hover { text-decoration:underline; }
    a:focus-visible,button:focus-visible,summary:focus-visible { outline:3px solid var(--brand); outline-offset:5px; }
    .wrap { width:min(1080px,calc(100% - 64px)); margin-inline:auto; }
    .site-header { min-height:100px; display:flex; align-items:center; justify-content:space-between; gap:20px; border-bottom:1px solid var(--line); }
    .brand { display:flex; align-items:center; gap:12px; color:var(--ink); }
    .brand-mark { width:36px; height:36px; display:grid; place-items:center; background:var(--brand); border-radius:10px; color:var(--on-brand); font-size:23px; font-weight:750; }
    .brand-name { font-size:19px; font-weight:750; letter-spacing:-.5px; }
    .brand-caption { margin-left:14px; padding-left:14px; border-left:1px solid var(--line); color:var(--muted); font-size:13px; }
    .library-link { font-size:13px; white-space:nowrap; }
    main { padding:62px 0 0; }
    .hero { display:grid; grid-template-columns:minmax(0,1fr) 260px; gap:64px; align-items:center; }
    .eyebrow { margin:0 0 14px; font-size:11px; font-weight:750; letter-spacing:2.4px; color:var(--brand); }
    h1 { font-size:clamp(32px,4.4vw,48px); letter-spacing:-1.8px; line-height:1.25; margin:0 0 18px; font-weight:750; }
    .intro { max-width:540px; margin:0 0 25px; color:var(--muted); font-size:16px; line-height:1.9; }
    .release-line { display:flex; align-items:center; flex-wrap:wrap; gap:10px; margin-bottom:18px; font-size:13px; }
    .release-badge { display:inline-flex; align-items:center; gap:7px; background:var(--soft); padding:3px 10px; border-radius:6px; color:var(--brand); font-weight:650; }
    .status-dot { width:6px; height:6px; border-radius:50%; background:currentColor; }
    .version { color:var(--muted); overflow-wrap:anywhere; font-variant-numeric:tabular-nums; }
    .download-button { display:inline-flex; align-items:center; justify-content:center; gap:11px; min-height:56px; padding:14px 22px; background:var(--brand); color:var(--on-brand); border:0; border-radius:10px; font:inherit; font-size:16px; line-height:1.5; font-weight:650; cursor:pointer; }
    .download-button:hover { text-decoration:none; filter:brightness(1.08); }
    .download-button svg { width:21px; height:21px; flex:none; }
    .button-size { padding-left:15px; margin-left:5px; border-left:1px solid #ffffff50; font-size:12px; font-weight:450; }
    .download-button:disabled { cursor:default; opacity:.52; filter:none; }
    .download-hint { margin:12px 0 0; color:var(--muted); font-size:12px; }
    .unavailable { margin:0 0 15px; font-size:14px; color:var(--muted); }
    .qr-panel { background:var(--panel); border:1px solid var(--line); border-radius:16px; padding:21px; text-align:center; }
    .qr-panel h2 { font-size:15px; margin:0 0 13px; }
    .qr-image { background:#fff; border-radius:8px; overflow:hidden; max-width:202px; margin:0 auto; }
    .qr-image svg { display:block; width:100%; height:auto; }
    .qr-panel p { margin:12px 0 0; font-size:12px; color:var(--muted); }
    .qr-address { display:block; margin-top:3px; overflow-wrap:anywhere; font-size:11px; line-height:1.6; }
    .release-meta { display:grid; grid-template-columns:1fr 1fr 1.35fr; gap:24px; padding:25px 0; margin:38px 0 32px; border-top:1px solid var(--line); border-bottom:1px solid var(--line); }
    .release-meta div:not(:first-child) { border-left:1px solid var(--line); padding-left:28px; }
    dt { color:var(--muted); font-size:11px; margin-bottom:5px; }
    dd { margin:0; font-size:15px; font-weight:600; font-variant-numeric:tabular-nums; overflow-wrap:anywhere; }
    .details-grid { display:grid; grid-template-columns:minmax(0,1.2fr) minmax(0,1fr); gap:48px; padding-bottom:34px; }
    .section-label { display:flex; align-items:center; gap:10px; margin-bottom:18px; }
    .section-label span { color:var(--brand); font-size:11px; font-weight:650; }
    h2 { font-size:18px; line-height:1.4; margin:0; letter-spacing:-.4px; }
    .release-notes { padding:0 0 0 18px; margin:0; font-size:14px; line-height:1.95; color:var(--muted); }
    .release-notes li { padding-left:4px; margin-bottom:10px; overflow-wrap:anywhere; }
    .release-notes li::marker { color:var(--brand); }
    .install-steps { list-style:none; padding:0; margin:0; display:grid; gap:16px; counter-reset:steps; }
    .install-steps li { position:relative; padding-left:39px; counter-increment:steps; }
    .install-steps li::before { content:counter(steps); position:absolute; left:0; top:2px; width:25px; height:25px; display:grid; place-items:center; border:1px solid var(--line); border-radius:50%; font-size:11px; color:var(--brand); }
    .install-steps strong { display:block; font-size:13px; font-weight:650; margin-bottom:2px; }
    .install-steps p { margin:0; color:var(--muted); font-size:12px; line-height:1.8; }
    .file-details { border-top:1px solid var(--line); padding:18px 0; color:var(--muted); font-size:12px; }
    summary { cursor:pointer; width:fit-content; padding:3px 0; }
    .file-grid { display:grid; grid-template-columns:90px minmax(0,1fr); gap:10px; margin:18px 0 6px; }
    .file-grid dt { margin:0; font-size:12px; }
    .file-grid dd { color:var(--muted); font-size:12px; font-weight:400; }
    code { font-family:ui-monospace,Consolas,monospace; overflow-wrap:anywhere; }
    footer { display:flex; justify-content:space-between; gap:16px; padding:19px 0 30px; border-top:1px solid var(--line); font-size:11px; color:var(--muted); }
    footer p { margin:0; }
    @media (prefers-color-scheme:dark) { :root { --bg:#111916; --panel:#18241e; --ink:#e8f0eb; --muted:#a6b6ad; --line:#314339; --brand:#81d3ae; --soft:#21392d; --on-brand:#10261b; } .button-size { border-color:#10261b40; } }
    @media (max-width:720px) {
      .wrap { width:calc(100% - 40px); }
      .site-header { min-height:78px; }
      .brand-caption { display:none; }
      main { padding-top:36px; }
      .hero { grid-template-columns:minmax(0,1fr); gap:28px; }
      .intro { font-size:14px; margin-bottom:20px; }
      h1 { letter-spacing:-1px; }
      .download-button { width:100%; }
      .qr-panel { display:none; }
      .release-meta { margin:28px 0; grid-template-columns:1fr 1fr; gap:18px; padding:20px 0; }
      .release-meta div:not(:first-child) { padding-left:18px; }
      .release-meta div:last-child { grid-column:1/-1; border:0; padding-left:0; }
      .release-meta dd { font-size:14px; }
      .details-grid { grid-template-columns:minmax(0,1fr); gap:28px; padding-bottom:28px; }
      .section-label { margin-bottom:14px; }
      footer { display:block; padding-bottom:24px; } footer p + p { margin-top:6px; }
    }
    @media (prefers-reduced-motion:no-preference) { .download-button { transition:filter .15s; } }
  </style>
</head>
<body>
  <header class="wrap site-header">
    <div class="brand"><span class="brand-mark" aria-hidden="true">F</span><span class="brand-name">FanHao</span><span class="brand-caption">下载与更新</span></div>
    <a class="library-link" href="/">进入资料库 <span aria-hidden="true">↗</span></a>
  </header>
  <main class="wrap">
    <section class="hero" aria-labelledby="download-title">
      <div>
        <p class="eyebrow">FANHAO FOR ANDROID</p>
        <h1 id="download-title">FanHao 安卓版</h1>
        <p class="intro">把你的资料库带到手机上。<br />全新安装或升级，都从这里开始。</p>
        <div class="release-line"><span class="release-badge"><span class="status-dot" aria-hidden="true"></span>${downloadable ? "当前发布" : "等待发布"} · ${channelLabel}</span><span class="version">${escape(update.versionName || "尚无版本")}</span></div>
        ${update.message ? `<p class="unavailable" role="status">${escape(update.message)}</p>` : ""}
        ${download}
        <p class="download-hint">无需登录下载 · 更新时请直接覆盖安装，无需卸载旧版</p>
      </div>
      <aside class="qr-panel" aria-label="手机扫码下载">
        <h2>用手机扫码打开</h2>
        <div class="qr-image">${renderQr(pageUrl)}</div>
        <p>固定下载入口，每次都是最新版</p>
        <a class="qr-address" href="${escape(pageUrl)}">${escape(pageUrl.replace(/^https?:\/\//, ""))}</a>
      </aside>
    </section>
    <dl class="release-meta" aria-label="版本信息">
      <div><dt>版本编号</dt><dd>${escape(update.versionCode || "—")}</dd></div>
      <div><dt>安装包大小</dt><dd>${escape(formatBytes(update.size))}</dd></div>
      <div><dt>更新时间 · 北京时间</dt><dd>${escape(formatDate(update.updatedAt))}</dd></div>
    </dl>
    <div class="details-grid">
      <section aria-labelledby="release-title"><div class="section-label"><span aria-hidden="true">01</span><h2 id="release-title">本次更新</h2></div><ul class="release-notes">${notes}</ul></section>
      <section aria-labelledby="install-title"><div class="section-label"><span aria-hidden="true">02</span><h2 id="install-title">安装只需三步</h2></div>
        <ol class="install-steps">
          <li><strong>下载 APK</strong><p>点击上方按钮。若在微信等应用内打不开，请选择“在浏览器打开”。</p></li>
          <li><strong>按系统提示完成安装</strong><p>仅为本次使用的浏览器授予安装权限；已有 FanHao 时直接覆盖安装。</p></li>
          <li><strong>打开 App，连接资料库</strong><p>在设置中选择服务地址。远程访问需要输入访问密码，下载页面无需登录。</p></li>
        </ol>
      </section>
    </div>
    <details class="file-details"><summary>安装包信息与校验</summary>
      <dl class="file-grid"><dt>文件名</dt><dd>${escape(update.fileName || "—")}</dd><dt>SHA-256</dt><dd><code>${escape(sha256)}</code></dd><dt>更新接口</dt><dd><a href="/api/android/update?channel=${channel}">查看版本 JSON</a></dd></dl>
    </details>
  </main>
  <footer class="wrap"><p>FanHao · 本地优先的个人资料库</p><p>下载入口公开，资料库访问仍需验证。</p></footer>
</body>
</html>`;
}
