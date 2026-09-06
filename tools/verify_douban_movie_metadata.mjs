// Synthetic-only contract tests: actual collector + matching module, fake HTTP,
// real temporary SQLite. No CLI/main, real index, cookie, service or media read.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import * as matcher from "../lib/douban-movie-match.js";
import { ADMIN_SCRIPT_DEFINITIONS } from "../lib/admin-script-registry.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixturePath = path.join(root, "tools/fixtures/douban-movie-metadata-cases.json");
const fixture = JSON.parse(fs.readFileSync(fixturePath, "utf8"));
const collectorPath = path.join(root, "tools/backfill_douban_tv_metadata.mjs");
const collectorSource = fs.readFileSync(collectorPath, "utf8");
// Refuse the historical eager-CLI entry point rather than accidentally touching data.
assert.match(collectorSource, /export async function run\(/, "safe injectable run must exist before importing collector");
assert.doesNotMatch(collectorSource, /^const options = parseArgs\(process\.argv/m, "unguarded historical main must not execute on import");
const savedFetch = globalThis.fetch;
globalThis.fetch = () => { throw new Error("TEST FORBIDS REAL NETWORK"); };
const collector = await import("../tools/backfill_douban_tv_metadata.mjs");
const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const clone = (value) => structuredClone(value);
const candidates = (item) => item.candidates.map((value) => clone(typeof value === "string" ? fixture.metas[value] : value));
const reviewError = (error) => error?.code === "METADATA_REVIEW_REQUIRED";
const group = { key: "synthetic-movie-one", category: "Synthetic", ...fixture.sequelTarget };
const options = { kind: "movie", write: true, refresh: true, sleep: 0.01, limit: 0, cookie: "" };

test("actual admin descriptor uses guarded browser collector and request pacing controls", () => {
  const definition = ADMIN_SCRIPT_DEFINITIONS.find((item) => item.id === "douban-movie-metadata");
  assert.ok(definition); assert.equal(definition.runtime, "python");
  assert.equal(definition.script, path.join("tools", "backfill_douban_movie_metadata_browser.py"));
  assert.equal(definition.fields.find((field) => field.name === "sleep")?.default, 5);
  assert.equal(definition.fields.some((field) => ["rateLimitWait", "rateLimitRetries"].includes(field.name)), false);
});

function escapeHtml(value) { return String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll('"', "&quot;"); }
function subjectHtml(meta) {
  const info = { ...meta.info, ...(meta.originalTitle ? { 原名: meta.originalTitle } : {}), ...(meta.aliases?.length ? { 又名: meta.aliases.join(" / ") } : {}) };
  return `<!doctype html><html><head><script type="application/ld+json">${JSON.stringify(meta.jsonLd || {})}</script></head><body>
    <h1><span property="v:itemreviewed">${escapeHtml(meta.title)}</span><span class="year">(${escapeHtml(meta.year)})</span></h1>${meta.coverUrl ? `<a class="nbgnbg"><img src="${escapeHtml(meta.coverUrl)}"></a>` : ""}
    <div id="info">${Object.entries(info).map(([key, value]) => `<span class="pl">${escapeHtml(key)}:</span> ${escapeHtml(value)}<br/>`).join("")}</div>
    <strong property="v:average">${meta.rating ?? ""}</strong><span property="v:votes">${meta.ratingCount || 0}</span>
    <span property="v:summary">${escapeHtml(meta.summary)}</span></body></html>`;
}
function searchHtml(urls) {
  return urls.map((url) => `<div class="result"><div class="title"><h3><a href="${escapeHtml(url)}">唐顿庄园 第一季</a></h3></div><span class="rating_nums">9.4</span><span class="subject-cast">2010 / 剧情</span><p>Search snippets are NOT full subject evidence.</p></div>`).join("");
}
function httpResponse(url, body, status = 200, mime = "text/html; charset=utf-8") {
  return { url, status, ok: status >= 200 && status < 300, headers: new Headers({ "content-type": mime }), text: async () => body, arrayBuffer: async () => new TextEncoder().encode(body).buffer };
}
function io({ urls = [fixture.metas.tv.doubanUrl, fixture.metas.sequel.doubanUrl], metas = [fixture.metas.tv, fixture.metas.sequel], overrides = {} } = {}) {
  const events = [], lookup = new Map(metas.map((meta) => [meta.doubanUrl, meta]));
  const fetch = async (input, init) => {
    const url = String(input); events.push({ type: "request", url, init });
    assert.match(url, /^https:\/\/(?:(?:www\.|movie\.)douban\.com|img\.doubanio\.com)\//, "unexpected fetch must not escape synthetic Douban boundary");
    const overridden = overrides[url];
    if (overridden instanceof Error) throw overridden;
    if (overridden) return httpResponse(overridden.url || url, overridden.body || "", overridden.status ?? 200, overridden.mime);
    if (new URL(url).pathname === "/search") return httpResponse(url, searchHtml(urls));
    assert.ok(lookup.has(url), `unplanned synthetic request: ${url}`);
    return httpResponse(url, subjectHtml(lookup.get(url)));
  };
  return { fetch, pause: async (ms) => { events.push({ type: "pause", ms }); }, log: () => {}, events };
}
function assertPaced(events, minimumMs = options.sleep * 1000) {
  let previous = -1;
  for (let index = 0; index < events.length; index += 1) {
    if (events[index].type !== "request") continue;
    if (previous >= 0) assert.ok(events.slice(previous + 1, index).some((event) => event.type === "pause" && event.ms >= minimumMs), `each request after the first requires delay >= ${minimumMs}ms`);
    previous = index;
  }
}
function requests(state) { return state.events.filter((event) => event.type === "request").map((event) => event.url); }
function indexData(two = false) {
  return { mediaItems: ["synthetic-movie-one", ...(two ? ["synthetic-movie-two"] : [])].map((id) => ({ id, mediaKind: "movie", title: fixture.sequelTarget.movieTitle, category: "Synthetic", relativePath: fixture.sequelTarget.samples[0] })) };
}
async function withDb(fn) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fanhao-douban-metadata-node-"));
  const dbPath = path.join(directory, "synthetic.sqlite");
  let db = new DatabaseSync(dbPath);
  try {
    collector.ensureSchema(db);
    await fn(db, () => { db.close(); db = new DatabaseSync(dbPath); return db; });
  } finally {
    db.close();
    const absolute = path.resolve(directory);
    assert.equal(path.dirname(absolute), path.resolve(os.tmpdir()));
    assert.ok(path.basename(absolute).startsWith("fanhao-douban-metadata-node-"));
    fs.rmSync(absolute, { recursive: true, force: true });
  }
}
function rows(db) { return db.prepare("SELECT * FROM movie_metadata ORDER BY media_id").all(); }
function seed(db) {
  collector.upsertOk(db, "movie", group, fixture.metas.sequel, { bytes: Buffer.from("synthetic-cover-bytes"), mime: "image/jpeg" });
  db.prepare("UPDATE movie_metadata SET updated_at='sentinel-updated', fetched_at='sentinel-fetched', error='sentinel-error', summary='sentinel-summary' WHERE media_id=?").run(group.key);
}

for (const item of fixture.canonical) test(`canonical: ${item.input}`, () => assert.equal(matcher.canonicalDoubanSubjectUrl(item.input), item.expected));
for (const item of fixture.clean) test(`clean: ${item.input}`, () => {
  const value = matcher.cleanMovieSearchTitle(item.input);
  for (const part of item.contains) assert.ok(value.includes(part), `${value} lost ${part}`);
  for (const part of item.excludes) assert.ok(!value.includes(part), `${value} retained ${part}`);
});
for (const item of fixture.cases) test(`match: ${item.name}`, () => {
  const inputs = candidates(item), before = clone(inputs);
  if (item.expectedError) assert.throws(() => matcher.chooseMovieMetadata(item.target, inputs), reviewError);
  else { const result = matcher.chooseMovieMetadata(item.target, inputs); assert.equal(result.doubanId, item.expectedId); assert.ok(inputs.includes(result), "return the verified original metadata, not merged search data"); }
  assert.deepEqual(inputs, before, "matching must not mutate input");
});
test("manual override still rejects TV/incomplete but permits explicit alternate film", () => {
  assert.throws(() => matcher.validateManualMovieMetadata(clone(fixture.metas.tv)), reviewError);
  assert.throws(() => matcher.validateManualMovieMetadata({ ...fixture.metas.sequel, detailSource: "search" }), reviewError);
  const other = clone(fixture.metas.war); assert.equal(matcher.validateManualMovieMetadata(other), other);
});
test("real parser + discovery inspect TV first and select full film second, with pacing", async () => {
  const state = io(); const result = await collector.fetchDoubanMeta(group, options, state);
  assert.equal(result.doubanId, "10002"); assert.equal(result.detailSource, "subject");
  assert.deepEqual(requests(state).slice(1), [fixture.metas.tv.doubanUrl, fixture.metas.sequel.doubanUrl]); assertPaced(state.events);
});
test("default request pacing is at least the configured five seconds", async () => {
  const state = io(); await collector.fetchDoubanMeta(group, { kind: "movie" }, state); assertPaced(state.events, 5000);
});
test("partial injection is rejected before file access, opening SQLite or HTTP", async () => {
  const require = createRequire(import.meta.url); const sqlite = require("node:sqlite");
  const originals = { read: fs.readFileSync, exists: fs.existsSync, DatabaseSync: sqlite.DatabaseSync };
  const calls = [];
  fs.readFileSync = (...args) => { calls.push("read-file"); throw new Error("file access denied"); };
  fs.existsSync = (...args) => { calls.push("stat-file"); throw new Error("file access denied"); };
  sqlite.DatabaseSync = class { constructor() { calls.push("open-database"); throw new Error("database access denied"); } };
  syncBuiltinESMExports();
  try {
    for (const key of ["db", "index", "cookieState", "fetch", "pause"]) for (const mode of ["omitted", "null", "undefined"]) {
      const injected = { db: {}, index: {}, cookieState: {}, fetch: () => { calls.push("http"); throw Error("network denied"); }, pause: async () => {} };
      if (mode === "omitted") delete injected[key]; else injected[key] = mode === "null" ? null : undefined;
      await assert.rejects(collector.run(options, injected), (error) => error instanceof TypeError && error.message.includes("同时提供"));
    }
    assert.deepEqual(calls, [], "validation must precede all external boundaries");
  } finally {
    fs.readFileSync = originals.read; fs.existsSync = originals.exists; sqlite.DatabaseSync = originals.DatabaseSync; syncBuiltinESMExports();
  }
});
test("candidate budget at most five unique subject details", async () => {
  const metas = Array.from({ length: 8 }, (_, index) => ({ ...clone(fixture.metas.tv), doubanId: String(20001 + index), doubanUrl: `https://movie.douban.com/subject/${20001 + index}/` }));
  const state = io({ urls: metas.map((meta) => meta.doubanUrl), metas });
  await assert.rejects(collector.fetchDoubanMeta(group, options, state), reviewError);
  assert.equal(requests(state).filter((url) => /\/subject\//.test(url)).length, 5); assertPaced(state.events);
});
test("duplicates and foreign discovery links do not spend requests", async () => {
  const state = io({ urls: ["https://evil.invalid/subject/10002/", fixture.metas.sequel.doubanUrl, fixture.metas.sequel.doubanUrl] });
  assert.equal((await collector.fetchDoubanMeta(group, options, state)).doubanId, "10002");
  assert.equal(requests(state).length, 2);
});
test("candidate detail failure cannot downgrade to search snippet or choose an incompletely checked set", async () => {
  const state = io({ urls: [fixture.metas.sequel.doubanUrl, fixture.metas.tv.doubanUrl], overrides: { [fixture.metas.tv.doubanUrl]: { status: 503, body: "detail unavailable" } } });
  await assert.rejects(collector.fetchDoubanMeta(group, options, state), reviewError); assertPaced(state.events);
});
test("real parser enforces ambiguity after reading all candidate details", async () => {
  const state = io({ urls: [fixture.metas.echo.doubanUrl, fixture.metas.duplicate.doubanUrl], metas: [fixture.metas.echo, fixture.metas.duplicate] });
  await assert.rejects(collector.fetchDoubanMeta({ movieTitle: "归途 2020", samples: [] }, options, state), reviewError);
  assert.equal(requests(state).length, 3);
});
for (const redirect of ["https://evil.invalid/subject/10002/", "https://accounts.douban.com/passport/login", fixture.metas.tv.doubanUrl]) {
  test(`subject response redirect is not verified: ${redirect}`, async () => {
    const state = io({ urls: [fixture.metas.sequel.doubanUrl], overrides: { [fixture.metas.sequel.doubanUrl]: { url: redirect, body: subjectHtml(fixture.metas.sequel) } } });
    await assert.rejects(collector.fetchDoubanMeta(group, options, state), reviewError);
  });
}
for (const [label, failure] of [["403", { status: 403 }], ["418", { status: 418 }], ["429", { status: 429 }], ["captcha", { body: "请输入验证码" }], ["text rate limit", { body: "搜索访问太频繁，请稍后再试" }]]) {
  test(`run ${label} stops next candidate and next target without writes`, () => withDb(async (db) => {
    const state = io({ overrides: { [fixture.metas.tv.doubanUrl]: failure } });
    const result = await collector.run(options, { ...state, db, index: indexData(true), cookieState: { cookie: "", source: "" } });
    assert.equal(result.blocked, true); assert.equal(result.ok, 0); assert.equal(result.total, 2);
    assert.equal(requests(state).length, 2); assert.equal(rows(db).length, 0); assertPaced(state.events);
  }));
}
test("run success persists full verified movie and remains readable after close/reopen", () => withDb(async (db, reopen) => {
  const state = io(); const result = await collector.run(options, { ...state, db, index: indexData(), cookieState: { cookie: "", source: "" } });
  assert.equal(result.ok, 1); assert.equal(result.failed, 0); assert.equal(rows(db)[0].douban_id, "10002");
  const persisted = rows(db); assert.deepEqual(rows(reopen()), persisted); assertPaced(state.events);
}));
test("failed refresh preserves every column of an existing ok row, not only status", () => withDb(async (db, reopen) => {
  seed(db); const before = rows(db); const state = io({ metas: [fixture.metas.tv], urls: [fixture.metas.tv.doubanUrl] });
  const result = await collector.run(options, { ...state, db, index: indexData(), cookieState: { cookie: "", source: "" } });
  assert.equal(result.failed, 1); assert.deepEqual(rows(db), before); assert.deepEqual(rows(reopen()), before);
}));
test("dry-run success and failure never insert/update metadata rows", () => withDb(async (db) => {
  seed(db); const before = rows(db);
  for (const state of [io(), io({ urls: [fixture.metas.tv.doubanUrl], metas: [fixture.metas.tv] })]) {
    await collector.run({ ...options, write: false }, { ...state, db, index: indexData(true), cookieState: { cookie: "", source: "" } });
    assert.deepEqual(rows(db), before); assertPaced(state.events);
  }
}));
for (const status of [500, 403]) test(`new subject cover HTTP ${status} preserves existing ok row entirely`, () => withDb(async (db, reopen) => {
  seed(db); const before = rows(db);
  const meta = { ...clone(fixture.metas.sequel), doubanId: "10012", doubanUrl: "https://movie.douban.com/subject/10012/", coverUrl: "https://img.doubanio.com/synthetic-cover.jpg" };
  const state = io({ urls: [meta.doubanUrl], metas: [meta], overrides: { [meta.coverUrl]: { status } } });
  const result = await collector.run(options, { ...state, db, index: indexData(true), cookieState: { cookie: "", source: "" } });
  assert.deepEqual(rows(db).filter((row) => row.media_id === group.key), before);
  assert.deepEqual(rows(reopen()).filter((row) => row.media_id === group.key), before);
  assert.ok(requests(state).includes(meta.coverUrl));
  if (status === 403) { assert.equal(result.blocked, true); assert.equal(requests(state).length, 3); }
  assertPaced(state.events);
}));
test("different subject without cover cannot inherit prior subject cover", () => withDb(async (db) => {
  seed(db);
  const meta = { ...clone(fixture.metas.sequel), doubanId: "10012", doubanUrl: "https://movie.douban.com/subject/10012/", coverUrl: "" };
  const state = io({ urls: [meta.doubanUrl], metas: [meta] });
  const result = await collector.run(options, { ...state, db, index: indexData(), cookieState: { cookie: "", source: "" } });
  const row = rows(db)[0];
  assert.equal(result.ok, 1); assert.equal(row.douban_id, "10012");
  assert.ok(!row.cover_blob && !row.cover_bytes, "new verified subject must not reuse old subject pixels");
}));
test("pacing spans target boundaries, not just details within one target", () => withDb(async (db) => {
  const state = io({ urls: [fixture.metas.sequel.doubanUrl] });
  const result = await collector.run(options, { ...state, db, index: indexData(true), cookieState: { cookie: "", source: "" } });
  assert.equal(result.ok, 2); assert.equal(requests(state).length, 4); assertPaced(state.events);
}));
test("duplicate index media ID cannot reset its five-detail budget", () => withDb(async (db) => {
  const metas = Array.from({ length: 8 }, (_, index) => ({ ...clone(fixture.metas.tv), doubanId: String(21001 + index), doubanUrl: `https://movie.douban.com/subject/${21001 + index}/` }));
  const state = io({ urls: metas.map((meta) => meta.doubanUrl), metas }); const index = indexData(); index.mediaItems.push(clone(index.mediaItems[0]));
  const result = await collector.run(options, { ...state, db, index, cookieState: { cookie: "", source: "" } });
  assert.equal(result.total, 1); assert.equal(requests(state).filter((url) => /\/subject\//.test(url)).length, 5); assertPaced(state.events);
}));
for (const [label, cover, success, blocked] of [
  ["ordinary HTML", { body: "<html>not a picture</html>", mime: "text/html" }, false, false],
  ["captcha HTML", { body: "请输入验证码", mime: "text/html" }, false, true],
  ["image MIME", { body: "synthetic-image-bytes", mime: "image/jpeg" }, true, false]
]) test(`cover ${label} response respects atomic metadata update`, () => withDb(async (db) => {
  seed(db); const before = rows(db);
  const meta = { ...clone(fixture.metas.sequel), doubanId: "10012", doubanUrl: "https://movie.douban.com/subject/10012/", coverUrl: "https://img.doubanio.com/synthetic-cover.jpg" };
  const state = io({ urls: [meta.doubanUrl], metas: [meta], overrides: { [meta.coverUrl]: cover } });
  const result = await collector.run(options, { ...state, db, index: indexData(), cookieState: { cookie: "", source: "" } });
  assert.equal(result.ok, success ? 1 : 0); assert.equal(result.blocked, blocked);
  if (success) { assert.equal(rows(db)[0].douban_id, "10012"); assert.equal(Buffer.from(rows(db)[0].cover_blob).toString(), cover.body); }
  else assert.deepEqual(rows(db), before);
  assertPaced(state.events);
}));

let legacyPassed = 0;
const legacyTests = [];
function oldContext(extra = {}) {
  const context = vm.createContext({ URL, Buffer, console: { log() {} }, parseSubjectPage: collector.parseSubjectPage, ...extra });
  const functions = { ...fixture.legacy.node.support, ...fixture.legacy.node.functions };
  vm.runInContext(Object.values(functions).join("\n\n"), context, { filename: "frozen-legacy-douban-collector.js" });
  return context;
}
legacyTests.push(["old cleaner drops sequel digit", async () => { const old = oldContext(); const value = old.cleanMovieQueryTitle(fixture.clean[0].input); assert.ok(!value.includes("唐顿庄园3")); assert.match(value, /唐顿庄园/); }]);
legacyTests.push(["old cleaner loses release year of numeric title", async () => { const value = oldContext().cleanMovieQueryTitle(fixture.clean[1].input); assert.ok(!value.includes("2019")); assert.match(value, /1917/); }]);
legacyTests.push(["old URL extractor accepts arbitrary embedded subject", async () => { assert.equal(oldContext().subjectUrlFromValue("evil text https://movie.douban.com/subject/10002/ tail"), fixture.metas.sequel.doubanUrl); }]);
legacyTests.push(["old real discovery selects wrong first TV subject", async () => {
  const state = io(); const old = oldContext({ fetchText: async (url) => (await state.fetch(url)).text(), DoubanSecurityPageError: class extends Error {} });
  const result = await old.fetchDoubanMeta(group, options); assert.equal(result.doubanId, "10001"); assert.match(result.title, /第一季/); assert.equal(requests(state).length, 2);
}]);
legacyTests.push(["old detail failure returns unverified search snippet", async () => {
  const old = oldContext({ fetchText: async (url) => { if (/\/subject\//.test(url)) throw Error("synthetic detail failure"); return searchHtml([fixture.metas.tv.doubanUrl]); }, DoubanSecurityPageError: class extends Error {} });
  const result = await old.fetchDoubanMeta(group, options); assert.equal(result.detailSource, "search"); assert.match(result.title, /第一季/);
}]);
legacyTests.push(["old SQL error upsert corrupts an existing ok row", () => withDb(async (db) => {
  seed(db); const before = rows(db); const old = oldContext({ metadataConfig: () => ({ table: "movie_metadata", keyColumn: "media_id", titleColumn: "movie_title" }), targetTitle: (target) => target.movieTitle });
  old.upsertError(db, "movie", group, new Error("synthetic failure")); assert.equal(rows(db)[0].status, "error"); assert.notDeepEqual(rows(db), before);
})]);

let failed = 0;
try {
  for (const item of tests) { try { await item.fn(); console.log(`PASS ${item.name}`); } catch (error) { failed += 1; console.error(`FAIL ${item.name}\n${error.stack}`); } }
  for (const [name, fn] of legacyTests) { try { await fn(); legacyPassed += 1; console.log(`OLD-RED ${name}`); } catch (error) { failed += 1; console.error(`FAIL old control ${name}\n${error.stack}`); } }
} finally { globalThis.fetch = savedFetch; }
console.log(`Douban movie metadata Node: ${tests.length - (failed - (legacyTests.length - legacyPassed))}/${tests.length} scenarios; ${legacyPassed}/${legacyTests.length} executable old controls`);
console.log(`collector SHA256 ${createHash("sha256").update(collectorSource).digest("hex")}`);
console.log(`matcher SHA256 ${createHash("sha256").update(fs.readFileSync(path.join(root, "lib/douban-movie-match.js"))).digest("hex")}`);
console.log("Boundary: fake HTTP only; real temporary SQLite, not real Douban/live matching or user data.");
if (failed) process.exitCode = 1;
