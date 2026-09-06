import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { createServer } from "node:http";

// Deliberately not a general workspace file server. No real DB/reader routes.
const fixtureRoot = path.join(import.meta.dirname, "fixtures");
const sourcePath = path.resolve(import.meta.dirname, "../android-client/www/js/local-novels.js");
const nameDeclaration = /const LOCAL_NOVEL_DB_NAME = "fanhao-local-novels";/g;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
let report = { status: "not-run", scope: "Native browser IndexedDB; synthetic randomly named databases only." };
const runs = new Map();
function describeSource(source) {
  return { sha256: crypto.createHash("sha256").update(source).digest("hex"), version: Number(/LOCAL_NOVEL_DB_VERSION\s*=\s*(\d+)/.exec(source)?.[1]), source: "android-client/www/js/local-novels.js", substitutions: "DB_NAME literal only", frozenSnapshot: true };
}
const server = createServer(async (request, response) => {
  const origin = `http://127.0.0.1:${server.address().port}`;
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
  if (request.headers.host !== new URL(origin).host) return fail(403, "Unexpected Host");
  if (request.headers.origin && request.headers.origin !== origin) return fail(403, "Cross-origin request rejected");
  try {
    const url = new URL(request.url, origin);
    if (request.method === "GET" && url.pathname === "/") return sendFile("android-novel-storage-v2-browser.html", "text/html");
    if (request.method === "GET" && url.pathname === "/fixture.mjs") return sendFile("android-novel-storage-v2-browser.mjs", "text/javascript");
    if (request.method === "GET" && url.pathname === "/source-info") {
      const source = fs.readFileSync(sourcePath, "utf8");
      return json({ ...describeSource(source), frozenSnapshot: false });
    }
    if (request.method === "POST" && url.pathname === "/start") {
      if (request.headers["content-type"] !== "application/json") return fail(415, "JSON only");
      request.resume();
      if (runs.size >= 16) return fail(429, "Restart this fixture after 16 runs to release source snapshots");
      const source = fs.readFileSync(sourcePath, "utf8");
      if ([...source.matchAll(nameDeclaration)].length !== 1) return fail(500, "Production DB_NAME declaration changed; refusing unsafe fixture");
      const runId = crypto.randomUUID();
      const description = describeSource(source);
      runs.set(runId, { source, description, modules: [] });
      return json({ runId, ...description });
    }
    if (request.method === "GET" && url.pathname === "/storage.js") {
      const caseId = url.searchParams.get("case");
      const moduleId = url.searchParams.get("module");
      const runId = url.searchParams.get("run");
      if (!uuid.test(caseId || "") || !uuid.test(runId || "") || !runs.has(runId) || (moduleId !== null && !uuid.test(moduleId)) || [...url.searchParams.keys()].some((key) => !["case", "module", "run"].includes(key))) return fail(400, "A valid frozen run and generated case UUID are required");
      const run = runs.get(runId);
      const source = run.source;
      if ([...source.matchAll(nameDeclaration)].length !== 1) return fail(500, "Production DB_NAME declaration changed; refusing unsafe fixture");
      const replacement = `const LOCAL_NOVEL_DB_NAME = "fanhao-idb-v2-fixture-${caseId}";`;
      const rewritten = source.replace(nameDeclaration, replacement);
      if (rewritten.replace(replacement, 'const LOCAL_NOVEL_DB_NAME = "fanhao-local-novels";') !== source) return fail(500, "Unexpected production source modification");
      response.setHeader("Content-Type", "text/javascript; charset=utf-8");
      response.setHeader("X-Fixture-Source-SHA256", run.description.sha256);
      run.modules.push({ caseId, moduleId, sha256: run.description.sha256 });
      return response.end(rewritten);
    }
    if (request.method === "GET" && url.pathname === "/report") return json({ ...report, servedModules: runs.get(report.runId)?.modules || [] });
    if (request.method === "POST" && url.pathname === "/report") {
      if (request.headers["content-type"] !== "application/json") return fail(415, "JSON only");
      let body = "";
      for await (const chunk of request) {
        body += chunk;
        if (Buffer.byteLength(body) > 1024 * 1024) return fail(413, "Report too large");
      }
      const parsed = JSON.parse(body);
      if (!parsed || !runs.has(parsed.runId) || !["running", "passed", "failed"].includes(parsed.status) || !Array.isArray(parsed.cases)) return fail(400, "Invalid report");
      report = { ...parsed, source: runs.get(parsed.runId).description };
      return json({ accepted: true });
    }
    return fail(404, "Not on fixture allowlist");
  } catch (error) { return fail(500, String(error.message || error)); }
  function sendFile(name, type) {
    response.setHeader("Content-Type", `${type}; charset=utf-8`);
    response.end(fs.readFileSync(path.join(fixtureRoot, name)));
  }
  function json(value) {
    response.setHeader("Content-Type", "application/json; charset=utf-8");
    response.end(JSON.stringify(value, null, 2));
  }
  function fail(status, message) { response.writeHead(status, { "Content-Type": "text/plain; charset=utf-8" }); response.end(message); }
});
server.listen(0, "127.0.0.1", () => console.log(`Native IndexedDB v2 fixture: http://127.0.0.1:${server.address().port}/`));
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => server.close(() => process.exit(0)));
