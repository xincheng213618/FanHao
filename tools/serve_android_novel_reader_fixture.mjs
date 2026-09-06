import fs from "node:fs";
import path from "node:path";
import { createServer } from "node:http";

const root = path.resolve(import.meta.dirname, "..");
const webRoot = path.join(root, "android-client/www");
const fixtureRoot = path.join(root, "tools/fixtures");
const progress = [];
const server = createServer((request, response) => {
  const url = new URL(request.url, "http://127.0.0.1");
  response.setHeader("Cache-Control", "no-store");
  if (url.pathname === "/") return send(path.join(fixtureRoot, "android-novel-reader-browser.html"), "text/html");
  if (url.pathname === "/fixture-local-novels.js") return send(path.join(fixtureRoot, "android-novel-reader-browser-storage.js"), "text/javascript");
  if (url.pathname === "/fixture-progress") {
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify(progress));
    return;
  }
  if (url.pathname.startsWith("/api/novels/")) {
    const match = /^\/api\/novels\/([^/]+)\/chapters\/(\d+)$/.exec(url.pathname);
    response.setHeader("Content-Type", "application/json");
    if (match) {
      const index = Number(match[2]);
      response.end(JSON.stringify({
        book: { id: match[1], title: "远程测试书", author: "回归样本", chapterCount: 3 },
        chapter: { index, title: `远程第 ${index} 章`, content: "这是隔离测试正文。\n\n".repeat(150) },
        next: index < 3 ? { index: index + 1 } : null,
        prev: index > 1 ? { index: index - 1 } : null
      }));
    } else if (url.pathname.endsWith("/progress")) {
      let body = "";
      request.on("data", (chunk) => { body += chunk; });
      request.on("end", () => {
        progress.push({ path: url.pathname, body: JSON.parse(body || "{}") });
        response.end("{}");
      });
    } else response.end('{"chapters":[],"total":0}');
    return;
  }
  if (!url.pathname.startsWith("/android-client/")) { response.writeHead(404); response.end(); return; }
  const file = path.resolve(webRoot, decodeURIComponent(url.pathname.slice("/android-client/".length)));
  if (!file.startsWith(webRoot + path.sep) || !fs.statSync(file, { throwIfNoEntry: false })?.isFile()) {
    response.writeHead(404); response.end(); return;
  }
  if (file === path.join(webRoot, "modules/novels/novel-views.js")) {
    const source = fs.readFileSync(file, "utf8");
    response.setHeader("Content-Type", "text/javascript; charset=utf-8");
    // Only the persistence boundary is delayed. The complete real reader executes.
    response.end(source.replace(/"\.\.\/\.\.\/js\/local-novels\.js[^\"]*"/, '"/fixture-local-novels.js"'));
    return;
  }
  send(file, ({ ".js": "text/javascript", ".css": "text/css", ".html": "text/html", ".svg": "image/svg+xml" })[path.extname(file)] || "application/octet-stream");
  function send(filePath, type) {
    response.setHeader("Content-Type", `${type}; charset=utf-8`);
    fs.createReadStream(filePath).pipe(response);
  }
});
server.listen(0, "127.0.0.1", () => console.log(`Android novel reader fixture: http://127.0.0.1:${server.address().port}/`));
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => server.close(() => process.exit(0)));
