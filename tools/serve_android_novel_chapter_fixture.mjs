import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { createServer } from "node:http";

// Narrow, loopback-only synthetic fixture. Never serves app APIs or real data.
const root = path.resolve(import.meta.dirname, "..");
const paths = {
  "storage.js": "android-client/www/js/local-novels.js",
  "novel-chapter-identity.js": "android-client/www/js/novel-chapter-identity.js",
  "legacy.js": "tools/fixtures/android-local-novels-v2-before-chapter-identity.js"
};
const runs = new Map();
const name = 'const LOCAL_NOVEL_DB_NAME = "fanhao-local-novels";';
const uuid = "[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const moduleRoute = new RegExp(`^/run/(${uuid})/(${uuid})/(${uuid})/(storage\\.js|legacy\\.js|novel-chapter-identity\\.js)$`);
let report = { status: "not-run" };
const server = createServer(async (req, res) => {
  const origin = `http://127.0.0.1:${server.address().port}`;
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
  const send = (status, value, type = "application/json") => { res.writeHead(status, { "Content-Type": `${type}; charset=utf-8` }); res.end(type === "application/json" ? JSON.stringify(value) : value); };
  try {
    if (req.headers.host !== new URL(origin).host || (req.headers.origin && req.headers.origin !== origin)) return send(403, { error: "Origin mismatch" });
    const url = new URL(req.url, origin);
    if (req.method === "GET" && url.pathname === "/") return send(200, fs.readFileSync(path.join(root, "tools/fixtures/android-novel-chapter-browser.html"), "utf8"), "text/html");
    if (req.method === "GET" && url.pathname === "/fixture.mjs") return send(200, fs.readFileSync(path.join(root, "tools/fixtures/android-novel-chapter-browser.mjs"), "utf8"), "text/javascript");
    if (req.method === "POST" && url.pathname === "/start") {
      req.resume();
      if (runs.size >= 12) return send(429, { error: "Run limit reached" });
      const sources = Object.fromEntries(Object.entries(paths).map(([key, file]) => [key, fs.readFileSync(path.join(root, file), "utf8")]));
      for (const key of ["storage.js", "legacy.js"]) if (sources[key].split(name).length !== 2) throw new Error("Unsafe DB name substitution");
      const runId = crypto.randomUUID();
      const hashes = Object.fromEntries(Object.entries(sources).map(([key, text]) => [paths[key], crypto.createHash("sha256").update(text).digest("hex")]));
      runs.set(runId, { sources, hashes, served: [] });
      return send(200, { runId, hashes });
    }
    const match = moduleRoute.exec(url.pathname);
    if (req.method === "GET" && match && runs.has(match[1])) {
      const [, runId, caseId, moduleId, key] = match;
      const run = runs.get(runId);
      const replacement = `const LOCAL_NOVEL_DB_NAME = "fanhao-idb-chapter-fixture-${caseId}";`;
      const source = run.sources[key];
      const rewritten = key === "novel-chapter-identity.js" ? source : source.replace(name, replacement);
      if (key !== "novel-chapter-identity.js" && rewritten.replace(replacement, name) !== source) throw new Error("Unexpected source rewrite");
      run.served.push({ caseId, moduleId, file: paths[key], sha256: run.hashes[paths[key]] });
      return send(200, rewritten, "text/javascript");
    }
    if (req.method === "GET" && url.pathname === "/report") return send(200, { ...report, sourceHashes: runs.get(report.runId)?.hashes, served: runs.get(report.runId)?.served });
    if (req.method === "POST" && url.pathname === "/report") {
      let body = "";
      for await (const part of req) { body += part; if (Buffer.byteLength(body) > 1024 * 1024) return send(413, { error: "Report too large" }); }
      const value = JSON.parse(body);
      if (!runs.has(value.runId) || !Array.isArray(value.cases)) return send(400, { error: "Invalid report" });
      report = value;
      return send(200, { accepted: true });
    }
    send(404, { error: "Not on fixture allowlist" });
  } catch (error) { send(500, { error: error.message }); }
});
server.listen(0, "127.0.0.1", () => console.log(`Novel chapter native IndexedDB fixture: http://127.0.0.1:${server.address().port}/`));
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => server.close(() => process.exit(0)));
