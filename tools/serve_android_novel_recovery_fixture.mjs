import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { createServer } from "node:http";

// Closed localhost fixture: whole real views/storage, synthetic API/native export.
// Each page creates one frozen run and two uniquely named test databases.
const root = path.resolve(import.meta.dirname, "..");
const fixtureRoot = path.join(import.meta.dirname, "fixtures");
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const sourceFiles = [
  "modules/novels/novel-views.js", "modules/novels/styles.css",
  "js/local-novels.js", "js/novel-chapter-identity.js", "js/api.js", "js/cache.js", "js/config.js",
  "js/format.js", "js/mobile-action-sheet.js", "css/base.css"
];
const runs = new Map();
const sha256 = source => crypto.createHash("sha256").update(source).digest("hex");
let lastReport = { status: "not-run" };
function replaceOne(source, needle, replacement) {
  if (source.split(needle).length !== 2) throw new Error("Expected exactly one fixture source boundary: " + needle);
  return source.replace(needle, replacement);
}
function freezeRun() {
  const id = crypto.randomUUID();
  const source = new Map(sourceFiles.map(file => [file, fs.readFileSync(path.join(root, "android-client/www", file), "utf8")]));
  const hashes = Object.fromEntries([...source].map(([file, text]) => [file, sha256(text)]));
  const databaseName = "fanhao-recovery-ui-" + id;
  const cacheDatabaseName = "fanhao-recovery-ui-cache-" + id;
  const run = { id, source, hashes, databaseName, cacheDatabaseName, served: [] };
  // Validate substitutions before any browser code is served.
  transformed(run, "js/local-novels.js");
  transformed(run, "js/cache.js");
  transformed(run, "modules/novels/novel-views.js");
  runs.set(id, run);
  return run;
}
function transformed(run, file) {
  const source = run.source.get(file);
  if (file === "js/local-novels.js") return replaceOne(source, 'const LOCAL_NOVEL_DB_NAME = "fanhao-local-novels";', 'const LOCAL_NOVEL_DB_NAME = "' + run.databaseName + '";');
  if (file === "js/cache.js") return replaceOne(source, 'const DB_NAME = "fanhao-android-cache";', 'const DB_NAME = "' + run.cacheDatabaseName + '";');
  if (file === "modules/novels/novel-views.js") {
    const matches = [...source.matchAll(/"\.\.\/\.\.\/js\/local-novels\.js[^"]*"/g)];
    if (matches.length !== 1) throw new Error("Expected exactly one views persistence import");
    return source.replace(matches[0][0], '"/run/' + run.id + '/storage-wrapper.js"');
  }
  return source;
}
function storageWrapper(run) {
  const location = "/run/" + run.id + "/android-client/js/local-novels.js";
  return [
    'import * as storage from "' + location + '";',
    'export * from "' + location + '";',
    "export async function listLocalNovelRecoveryBooks(options) {",
    "  const state = window.novelRecoveryFixture;",
    "  state.calls.push({method:'list',expectedVersion:options?.expectedVersion,hasCursor:options?.afterKey!==undefined});",
    "  state.refresh();",
    "  const value = await storage.listLocalNovelRecoveryBooks(options);",
    "  if (state.holdList) await new Promise(resolve => state.listReleases.push(resolve));",
    "  return value;",
    "}",
    "export async function readLocalNovelRecoveryEntry(key, options) {",
    "  const state = window.novelRecoveryFixture;",
    "  state.calls.push({method:'entry',key,expectedVersion:options?.expectedVersion});",
    "  state.refresh();",
    "  const value = await storage.readLocalNovelRecoveryEntry(key, options);",
    "  if (state.holdEntry) await new Promise(resolve => state.entryReleases.push(resolve));",
    "  return value;",
    "}"
  ].join("\n");
}
const server = createServer(async (request, response) => {
  const origin = "http://127.0.0.1:" + server.address().port;
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
  if (request.headers.host !== new URL(origin).host || (request.headers.origin && request.headers.origin !== origin)) return fail(403, "Wrong origin");
  try {
    const url = new URL(request.url, origin);
    if (request.method === "GET" && url.pathname === "/") return sendFile("android-novel-recovery-browser.html", "text/html");
    if (request.method === "GET" && url.pathname === "/fixture.mjs") return sendFile("android-novel-recovery-browser.mjs", "text/javascript");
    if (request.method === "POST" && url.pathname === "/start") {
      if (request.headers["content-type"] !== "application/json") return fail(415, "JSON required");
      request.resume();
      if (runs.size >= 12) return fail(429, "Fixture run limit reached; restart the fixture");
      const run = freezeRun();
      return json({ runId: run.id, databaseName: run.databaseName, cacheDatabaseName: run.cacheDatabaseName, hashes: run.hashes });
    }
    if (request.method === "GET" && url.pathname === "/report") return json(lastReport);
    if (request.method === "POST" && url.pathname === "/report") {
      if (request.headers["content-type"] !== "application/json") return fail(415, "JSON required");
      let body = "";
      for await (const chunk of request) {
        body += chunk;
        if (Buffer.byteLength(body) > 1024 * 1024) return fail(413, "Report too large");
      }
      const report = JSON.parse(body);
      if (!report || !uuid.test(report.runId || "") || !runs.has(report.runId)) return fail(400, "Unknown run");
      const run = runs.get(report.runId);
      lastReport = { ...report, sourceHashes: run.hashes, served: run.served };
      return json({ accepted: true });
    }
    if (url.pathname.startsWith("/api/novels") && request.method === "GET") {
      return json({
        books: [{ id: "fixture-remote", title: "远程合成书（服务正常）", author: "隔离夹具", chapterCount: 2, charCount: 200 }],
        total: 1, facets: [], summary: { totals: { books: 1, chapters: 2, chars: 200, bytes: 0 }, categories: [], recent: [] }
      });
    }
    const match = /^\/run\/([^/]+)\/(.*)$/.exec(url.pathname);
    if (request.method === "GET" && match && uuid.test(match[1]) && runs.has(match[1])) {
      const run = runs.get(match[1]);
      if (match[2] === "storage-wrapper.js") return send(storageWrapper(run), "text/javascript");
      const prefix = "android-client/";
      const file = match[2].startsWith(prefix) ? match[2].slice(prefix.length) : "";
      if (!run.source.has(file)) return fail(404, "Not a frozen fixture dependency");
      run.served.push({ file, sha256: run.hashes[file] });
      return send(transformed(run, file), file.endsWith(".css") ? "text/css" : "text/javascript");
    }
    return fail(404, "Not on fixture allowlist");
  } catch (error) { return fail(500, String(error.message || error)); }
  function sendFile(name, type) { return send(fs.readFileSync(path.join(fixtureRoot, name)), type); }
  function send(value, type) { response.setHeader("Content-Type", type + "; charset=utf-8"); response.end(value); }
  function json(value) { return send(JSON.stringify(value, null, 2), "application/json"); }
  function fail(status, message) { response.writeHead(status, { "Content-Type": "text/plain; charset=utf-8" }); response.end(message); }
});
server.listen(0, "127.0.0.1", () => console.log("Android novel recovery UI fixture: http://127.0.0.1:" + server.address().port + "/"));
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => server.close(() => process.exit(0)));
