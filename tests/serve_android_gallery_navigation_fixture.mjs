import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createServer, request as httpRequest } from "node:http";
import { createHash, randomUUID } from "node:crypto";

// Synthetic-only localhost fixture. No proxy/fetch to a backend, database reads,
// production writes, or arbitrary filesystem HTTP routes exist here.
const webRoot = fs.realpathSync(path.resolve(import.meta.dirname, "../android-client/www"));
const fixtureRoot = path.join(import.meta.dirname, "fixtures");
const fixtureHtml = fs.readFileSync(path.join(fixtureRoot, "android-gallery-navigation-browser.html"));
const fixtureBootstrap = fs.readFileSync(path.join(fixtureRoot, "android-gallery-navigation-browser.mjs"));
const moduleIds = ["fanhao", "photos", "media", "novels", "short-videos", "music", "tools"];
const mime = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".ico": "image/x-icon", ".woff": "font/woff", ".woff2": "font/woff2" };
const runs = new Map();
const requests = [];
const timestamp = "2026-08-31T00:00:00.000Z";
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const csp = "default-src 'self'; script-src 'self'; connect-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; style-src 'self' 'unsafe-inline'; font-src 'self' data:; object-src 'none'; worker-src 'none'; frame-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'";

function freezeSources() {
  const files = new Map();
  const pending = ["index.html", "app.js", "styles.css", ...moduleIds.map((id) => `modules/${id}/android-module.js`)];
  let totalBytes = 0;
  while (pending.length) {
    const relative = pending.pop();
    if (files.has(relative)) continue;
    assert.ok(relative && !relative.startsWith("../") && !path.posix.isAbsolute(relative), `Unsafe asset: ${relative}`);
    const extension = path.extname(relative).toLowerCase();
    assert.ok(mime[extension], `Asset type is not allowed: ${relative}`);
    const absolute = fs.realpathSync(path.resolve(webRoot, relative));
    const within = path.relative(webRoot, absolute);
    assert.ok(within && !within.startsWith("..") && !path.isAbsolute(within), `Asset escapes www: ${relative}`);
    assert.ok(fs.statSync(absolute).isFile(), `Asset is not a file: ${relative}`);
    const data = fs.readFileSync(absolute);
    totalBytes += data.byteLength;
    assert.ok(files.size < 300 && totalBytes < 24 * 1024 * 1024, "Static dependency closure is unexpectedly large");
    files.set(relative, { data, sha256: sha256(data), type: mime[extension] });
    const text = data.toString("utf8");
    const references = extension === ".js"
      ? [...text.matchAll(/(?:\bfrom\s*|\bimport\s*(?:\(\s*)?)["']([^"']+)["']/g)].map((match) => match[1])
      : extension === ".css"
        ? [...text.matchAll(/@import\s+["']([^"']+)["']|url\(\s*["']?([^\s"')]+)["']?\s*\)/g)].map((match) => match[1] || match[2])
        : extension === ".html"
          ? [...text.matchAll(/(?:src|href)=["']([^"']+)["']/g)].map((match) => match[1]) : [];
    for (const reference of references) {
      if (!reference.startsWith(".")) continue;
      const target = path.posix.normalize(path.posix.join(path.posix.dirname(relative), reference.split(/[?#]/)[0]));
      if (!files.has(target)) pending.push(target);
    }
  }
  // Only configuration defaults are replaced. App/module/navigation source is
  // byte-for-byte frozen; the index only gains the pre-app isolation bootstrap.
  const config = files.get("js/config.js");
  const source = config.data.toString("utf8");
  const urlPattern = /export const DEFAULT_URL = [^;]+;/g;
  const updatePattern = /export const DEFAULT_UPDATE_URLS = Object\.freeze\(\[[\s\S]*?\]\);/g;
  assert.equal([...source.matchAll(urlPattern)].length, 1, "DEFAULT_URL replacement must be exact");
  assert.equal([...source.matchAll(updatePattern)].length, 1, "Update URL replacement must be exact");
  config.served = Buffer.from(source.replace(urlPattern, "export const DEFAULT_URL = location.origin;")
    .replace(updatePattern, "export const DEFAULT_UPDATE_URLS = Object.freeze([location.origin]);"));
  assert.equal([...files.get("index.html").data.toString("utf8").matchAll(/<head>/g)].length, 1);
  const runId = randomUUID();
  files.get("index.html").served = Buffer.from(files.get("index.html").data.toString("utf8").replace("<head>",
    `<head>\n    <script src="/fixture/browser.mjs?run=${runId}"></script>`));
  return { runId, files, totalBytes, createdAt: new Date().toISOString() };
}

const movieItems = [
  { id: "fixture-movie-one", title: "合成电影：远航计划", year: 2026, category: "科幻", coverUrl: "/fixture/poster/movie-one.svg" },
  { id: "fixture-movie-two", title: "合成电影：暮色列车", year: 2025, category: "剧情", coverUrl: "/fixture/poster/movie-two.svg" }
].map((item) => ({ ...item, type: "movie", mediaKind: "movie", ext: "mp4", size: 1024 * 1024, updatedAt: timestamp, exists: false, streamUrl: "" }));
const tvSeries = { id: "fixture-series-one", seriesKey: "fixture-series-one", type: "tvSeries", title: "合成剧集：春日车站", category: "剧情", year: 2026, chapterCount: 2, episodeCount: 2, coverUrl: "/fixture/poster/tv-one.svg", updatedAt: timestamp };
const episodes = ["第01集 出发", "第02集 归来"].map((title, index) => ({
  id: `fixture-episode-${index + 1}`, title, type: "tv", mediaKind: "tv", seriesKey: tvSeries.seriesKey,
  seriesName: tvSeries.title, tvSeries: { title: tvSeries.title }, episodeNumber: index + 1,
  category: "剧情", ext: "mp4", coverUrl: tvSeries.coverUrl, size: 1024, updatedAt: timestamp, exists: false, streamUrl: ""
}));

function apiData(url) {
  const pathname = url.pathname;
  if (pathname === "/api/modules") return { modules: [] };
  if (pathname === "/api/library") return { people: [], totals: { people: 0, videos: 0, works: 0, infoFiles: 0 }, user: { historyCount: 0, favorites: [] }, availableRoots: [], access: {} };
  if (pathname === "/api/history") return { works: [], total: 0 };
  if (pathname === "/api/image-library/summary") return { totals: { photoAlbums: 1, mangaComics: 1, movieVideos: 2, tvVideos: 2 }, channels: [], photoRoots: [], mediaRoots: [], scannedAt: timestamp };
  if (["/api/novels/summary", "/api/music/summary", "/api/short-videos/summary"].includes(pathname)) return { totals: {}, items: [] };
  if (pathname === "/api/manga/jobs") return { jobs: [] };
  if (pathname === "/api/android/update") return { available: false, message: "隔离夹具不提供 APK", versionCode: 0 };
  if (pathname.startsWith("/api/gallery-media/")) {
    const id = decodeURIComponent(pathname.slice("/api/gallery-media/".length));
    const item = [...movieItems, ...episodes].find((candidate) => candidate.id === id);
    return item ? { item } : null;
  }
  if (pathname !== "/api/image-library/items") return null;
  const mode = url.searchParams.get("mode") || "photo";
  if (!["photo", "manga", "movie", "tv", "media"].includes(mode)) return null;
  const query = url.searchParams.get("query") || "";
  const collection = url.searchParams.get("collection") || "";
  const seriesKey = url.searchParams.get("seriesKey") || "";
  const tvView = url.searchParams.get("tvView") === "episodes" ? "episodes" : "series";
  const category = url.searchParams.get("category") || (mode === "photo" ? "我喜欢的" : "");
  const photoView = collection ? "albums" : "collections";
  let items;
  if (mode === "movie") items = movieItems;
  else if (mode === "tv" || mode === "media") items = tvView === "episodes" ? (seriesKey === tvSeries.seriesKey ? episodes : []) : [tvSeries];
  else if (mode === "manga") items = [{ id: "fixture-manga", type: "manga", title: "合成韩漫：晴空日记", chapterCount: 0, imageCount: 0, coverUrl: "/fixture/poster/manga-one.svg" }];
  else items = collection
    ? [{ id: "fixture-photo-album", type: "photo", title: "合成套图：湖畔晨光", category, imageCount: 0, coverUrl: "/fixture/poster/photo-one.svg" }]
    : [{ type: "photoCollectionCategory", category, collections: [{ id: "fixture-photo", collectionId: "fixture-photo", type: "photoCollection", title: "合成套图合集", category, albumCount: 1, coverUrl: "/fixture/poster/photo-one.svg" }] }];
  if (query) items = items.filter((item) => String(item.title || "").includes(query));
  const offset = Math.max(0, Number(url.searchParams.get("offset")) || 0);
  const limit = Math.min(100, Math.max(1, Number(url.searchParams.get("limit")) || 40));
  return { mode, query, category, collection, photoView, tvView, seriesKey, sort: url.searchParams.get("sort") || "updated",
    items: items.slice(offset, offset + limit), total: items.length, offset, limit, facets: { categories: [], people: [] },
    collectionSummary: collection ? { title: "合成套图合集", category, count: 1 } : null,
    seriesSummary: seriesKey ? { ...tvSeries, count: 2 } : null };
}

function describeRun(run) {
  return { runId: run.runId, url: `/run/${run.runId}/www/index.html`, createdAt: run.createdAt, totalBytes: run.totalBytes,
    files: [...run.files].map(([name, item]) => ({ name, sha256: item.sha256, servedSha256: sha256(item.served || item.data), transformed: Boolean(item.served) })) };
}

let origin;
const server = createServer((request, response) => {
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("Content-Security-Policy", csp);
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("Referrer-Policy", "same-origin");
  let url;
  try { url = new URL(request.url, origin); } catch { response.writeHead(400).end(); return; }
  const send = (status, type, body) => { response.writeHead(status, { "Content-Type": `${type}; charset=utf-8` }); response.end(body); };
  const json = (status, body) => send(status, "application/json", JSON.stringify(body, null, 2));
  let referencedRun = "";
  try { referencedRun = /^\/run\/([a-f0-9-]{36})\//.exec(new URL(request.headers.referer || origin, origin).pathname)?.[1] || ""; }
  catch { /* An invalid diagnostic Referer must never crash the fixture. */ }
  const record = (status) => {
    requests.push({ sequence: requests.length ? requests.at(-1).sequence + 1 : 1, runId: referencedRun, method: request.method, path: url.pathname, query: Object.fromEntries(url.searchParams), status });
    if (requests.length > 4000) requests.shift();
  };
  if (request.headers.host !== new URL(origin).host || (request.headers.origin && request.headers.origin !== origin) || request.headers["sec-fetch-site"] === "cross-site") {
    record(403); return json(403, { error: "Only this loopback fixture origin is allowed" });
  }
  if (request.method === "POST" && url.pathname === "/fixture/new-run") {
    if (runs.size >= 12) return json(429, { error: "运行数量已达 12，请重启夹具（不删除浏览器数据）" });
    try { const run = freezeSources(); runs.set(run.runId, run); return json(200, describeRun(run)); }
    catch (error) { return json(500, { error: error.message }); }
  }
  if (request.method !== "GET") { record(405); return json(405, { error: "Synthetic fixture is read-only" }); }
  if (url.pathname === "/") return send(200, "text/html", fixtureHtml);
  if (url.pathname === "/fixture/browser.mjs") return send(200, "text/javascript", fixtureBootstrap);
  if (url.pathname === "/fixture/requests") {
    const runId = url.searchParams.get("run");
    return json(200, { scope: "Synthetic API only; no production proxy", runs: [...runs.values()].filter((run) => !runId || run.runId === runId).map(describeRun), requests: requests.filter((entry) => !runId || entry.runId === runId) });
  }
  const poster = /^\/fixture\/poster\/(movie-one|movie-two|tv-one|photo-one|manga-one)\.svg$/.exec(url.pathname);
  if (poster) {
    const color = { "movie-one": "#1d5774", "movie-two": "#704239", "tv-one": "#346652", "photo-one": "#417b7c", "manga-one": "#665189" }[poster[1]];
    return send(200, "image/svg+xml", `<svg xmlns="http://www.w3.org/2000/svg" width="360" height="480" viewBox="0 0 360 480"><rect width="360" height="480" fill="${color}"/><circle cx="240" cy="140" r="94" fill="#fff" opacity=".12"/><path d="M0 420 150 240 360 420v60H0" fill="#fff" opacity=".16"/><text x="24" y="400" fill="#fff" font-family="sans-serif" font-size="28">SYNTHETIC</text><text x="24" y="440" fill="#fff" font-family="sans-serif" font-size="22">${poster[1]}</text></svg>`);
  }
  if (url.pathname.startsWith("/api/")) {
    const result = apiData(url);
    record(result ? 200 : 404);
    return json(result ? 200 : 404, result || { error: "Unknown synthetic API; no proxy fallback" });
  }
  const asset = /^\/run\/([a-f0-9-]{36})\/www\/(.+)$/.exec(url.pathname);
  if (asset) {
    let relative;
    try { relative = decodeURIComponent(asset[2]); } catch { return json(400, { error: "Invalid asset path" }); }
    const item = runs.get(asset[1])?.files.get(relative);
    if (item) return send(200, item.type, item.served || item.data);
  }
  record(404);
  return json(404, { error: "Not in the frozen static allowlist" });
});

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
origin = `http://127.0.0.1:${server.address().port}`;
if (process.argv.includes("--smoke")) {
  let checks = 0;
  const check = (condition, message) => { assert.ok(condition, message); checks += 1; };
  try {
    check((await fetch(origin)).status === 200, "launcher");
    const response = await fetch(`${origin}/fixture/new-run`, { method: "POST" });
    check(response.status === 200, "new run");
    const run = await response.json();
    check(run.files.length > 30, "real dependency closure, not a replacement navigation mock");
    const headers = { Referer: `${origin}${run.url}` };
    for (const asset of run.files) {
      const served = await fetch(`${origin}/run/${run.runId}/www/${asset.name}`, { headers });
      check(served.status === 200, `frozen ${asset.name}`);
      check(sha256(Buffer.from(await served.arrayBuffer())) === asset.servedSha256, `frozen hash ${asset.name}`);
      if (!asset.transformed) check(asset.sha256 === asset.servedSha256, `real unchanged asset ${asset.name}`);
    }
    const index = await (await fetch(`${origin}${run.url}`)).text();
    check(index.indexOf("/fixture/browser.mjs") < index.indexOf('src="./app.js'), "bootstrap before actual app");
    const config = await (await fetch(`${origin}/run/${run.runId}/www/js/config.js`)).text();
    check(config.includes("DEFAULT_URL = location.origin") && !/https?:/.test(config), "only fixture backend defaults");
    for (const mode of ["photo", "manga", "movie", "tv"]) {
      const result = await (await fetch(`${origin}/api/image-library/items?mode=${mode}`, { headers })).json();
      check(result.mode === mode && result.items.length > 0, `synthetic ${mode} list`);
    }
    const episodesResponse = await (await fetch(`${origin}/api/image-library/items?mode=tv&tvView=episodes&seriesKey=fixture-series-one`, { headers })).json();
    check(episodesResponse.items.length === 2 && episodesResponse.items.every((item) => item.type === "tv"), "actual tv drilldown API shape");
    check((await fetch(`${origin}/api/gallery-media/fixture-movie-one`, { headers })).status === 200, "synthetic detail");
    check((await fetch(`${origin}/api/library`, { method: "DELETE" })).status === 405, "no API writes");
    check((await fetch(`${origin}/api/not-implemented`)).status === 404, "no proxy fallback");
    check((await fetch(`${origin}/run/${run.runId}/www/%2e%2e%2f%2e%2e%2fAGENTS.md`)).status === 404, "no traversal");
    check((await fetch(`${origin}/run/${run.runId}/www/package.json`)).status === 404, "no arbitrary workspace files");
    check((await fetch(origin, { headers: { Origin: "http://example.invalid" } })).status === 403, "cross-origin rejected");
    const hostileHostStatus = await new Promise((resolve, reject) => {
      const probe = httpRequest(origin, { headers: { Host: "example.invalid" } }, (result) => { result.resume(); resolve(result.statusCode); });
      probe.on("error", reject);
      probe.end();
    });
    check(hostileHostStatus === 403, "DNS rebinding rejected");
    const second = await (await fetch(`${origin}/fixture/new-run`, { method: "POST" })).json();
    check(second.runId !== run.runId, "fresh storage namespace per run");
    const log = await (await fetch(`${origin}/fixture/requests?run=${run.runId}`)).json();
    check(log.requests.some((entry) => entry.query.mode === "movie") && log.requests.some((entry) => entry.query.mode === "tv"), "real HTTP request log");
    check((await fetch(`${origin}${run.url}`)).headers.get("content-security-policy").includes("connect-src 'self'"), "browser network fence supplied");
    console.log(JSON.stringify({ result: "PASS", checks, frozenFiles: run.files.length, bytes: run.totalBytes, boundary: "HTTP/source isolation only; browser layout, CSP enforcement, routing, and native behavior not asserted" }, null, 2));
  } finally { await new Promise((resolve) => server.close(resolve)); }
} else {
  console.log(`Android gallery navigation fixture: ${origin}/`);
  console.log("Create a fresh run from the launcher after production changes; same-run reload preserves navigation.");
  for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => server.close(() => process.exit(0)));
}
