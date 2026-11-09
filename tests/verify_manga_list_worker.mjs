import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import fs from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setImmediate } from "node:timers/promises";
import { createImageLibraryService } from "../src/modules/content-index/server/image-library-service.js";
import { createMangaListWorkerClient } from "../src/modules/content-index/server/manga-list-worker-client.js";
import { routeContentIndexApi } from "../src/modules/content-index/server/routes.js";
import { createMangaService } from "../src/modules/photos/server/manga-service.js";
import { sendJson, sendJsonParts } from "../src/platform/server/responses.js";
import { createVerifiedTempDir } from "./verified-temp-cleanup.mjs";

const temp = createVerifiedTempDir("fanhao-manga-list-worker-");
const databases = new Set();
const workers = new Set();
const maxItemLimit = 3;
let server, routeWorker, origin, workerResponses = 0, jsonResponses = 0, fallbackReads = 0;

function addWorker(options) {
  const worker = createMangaListWorkerClient({ workerUrl: new URL("../src/apps/manga-list-worker.js", import.meta.url), ...options });
  workers.add(worker);
  return worker;
}

function withDatabaseHandles(callback) {
  const prepare = DatabaseSync.prototype.prepare;
  DatabaseSync.prototype.prepare = function (...args) {
    databases.add(this);
    return prepare.apply(this, args);
  };
  try { return callback(); }
  finally { DatabaseSync.prototype.prepare = prepare; }
}

function pageUrl({ mode = "manga", limit = 2, offset = 0, sort = "title", q = "" } = {}) {
  const url = new URL("/api/image-library/items", origin);
  url.search = new URLSearchParams({ mode, limit, offset, sort, q });
  return url;
}

function withoutRevision({ listRevision: _revision, ...value }) { return value; }
function titles(page) { return page.items.map(item => item.title); }
function retryable(code) { return { code, statusCode: 503 }; }

async function readPage(url) {
  const response = await fetch(url, { headers: { "Accept-Encoding": "identity" }, signal: AbortSignal.timeout(10000) });
  const bytes = Buffer.from(await response.arrayBuffer());
  assert.equal(response.headers.get("content-type"), "application/json; charset=utf-8");
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(Number(response.headers.get("content-length")), bytes.length);
  return { response, data: JSON.parse(bytes.toString("utf8")) };
}

async function verifyWorkerRoute() {
  const root = path.join(temp.tempDir, "library");
  fs.mkdirSync(root);
  const databasePath = path.join(root, "collector.sqlite");
  const writer = new DatabaseSync(databasePath);
  databases.add(writer);
  writer.exec("PRAGMA journal_mode=WAL");
  const collector = fs.readFileSync(new URL("../tools/manga_collector.py", import.meta.url), "utf8");
  const schema = /    schema = """([\s\S]*?)"""/u.exec(collector)?.[1];
  assert.ok(schema?.includes("CREATE TABLE IF NOT EXISTS manga_comics"));
  writer.exec(schema);

  function addBook(name, title, { managed = false, manifest = true, source = name, downloaded = 1 } = {}) {
    const directory = path.join(root, name);
    fs.mkdirSync(directory);
    const sourceUrl = `https://synthetic.invalid/manga/${source}`;
    const catalog = { title: managed ? "File fallback " + title : title, url: sourceUrl, updated_at: "2026-01-01" };
    fs.writeFileSync(path.join(directory, "catalog.json"), JSON.stringify(catalog));
    fs.writeFileSync(path.join(directory, "catalog.html"), '<div class="sp-book-tags"><a>韩漫</a></div>');
    if (manifest) fs.writeFileSync(path.join(directory, "manifest.json"), JSON.stringify({ chapters: [] }));
    if (managed) {
      writer.prepare(`INSERT INTO manga_comics
        (cache_key,dir_name,site,title,source_url,updated_at,chapter_count,done_chapter_count,image_count,downloaded_count)
        VALUES (?,?,'jmd9',?,?,'2026-01-01',1,1,1,?)`).run(directory, name, title, sourceUrl, downloaded);
      writer.prepare("INSERT INTO manga_chapters(cache_key,chapter_index,title) VALUES (?,1,'Chapter')").run(directory);
      writer.prepare("INSERT INTO manga_images(cache_key,chapter_index,image_index,local_path) VALUES (?,1,1,'synthetic.png')").run(directory);
    }
    return { directory, catalog, sourceUrl };
  }

  const managed = addBook("jmd9_cache_2", "02 SQL 共享", { managed: true, source: "same", downloaded: 2 });
  addBook("jmd9_cache_02", "02 SQL 旧副本", { managed: true, source: "same" });
  const file = addBook("jmd9_cache_1", "01 文件 共享");
  addBook("jmd9_cache_3", "03 另一作品", { managed: true });
  addBook("jmd9_cache_4", "04 文件");
  const pending = addBook("jmd9_cache_5", "05 等待清单", { manifest: false });
  addBook("ignored_directory", "00 非漫画目录");

  // Create the legacy synchronous oracle before introducing the job sentinel.
  const manga = createMangaService({
    root, databasePath,
    safeStat(value) { try { return fs.statSync(value); } catch { return null; } },
    spawnProcess() { assert.fail("the fixture must never start a collector"); }
  });
  const legacy = createImageLibraryService({
    mangaService: manga, maxItemLimit,
    clampInteger(value, fallback, min, max) {
      return value == null || String(value).trim() === "" || !Number.isFinite(Number(value))
        ? fallback : Math.max(min, Math.min(max, Math.floor(Number(value))));
    }
  });
  const sentinelPath = path.join(root, ".manga-jobs.json");
  const sentinel = JSON.stringify({ schemaVersion: 1, jobs: [{
    id: "manga-update-1700000000000-1", kind: "update", cacheDirectory: path.basename(managed.directory),
    sourceUrl: managed.sourceUrl, status: "running", startedAt: "2026-01-01T00:00:00.000Z"
  }] });
  fs.writeFileSync(sentinelPath, sentinel);

  const client = addWorker({ root, databasePath, maxItemLimit, timeoutMs: 10000 });
  routeWorker = client;
  server = createServer((req, res) => {
    const url = new URL(req.url, origin);
    void routeContentIndexApi(req, res, url, {
      mangaListWorker: routeWorker,
      imageLibraryService: {
        itemsPayload(url) {
          fallbackReads++;
          assert.equal(url.searchParams.get("mode"), "movie", "manga must not fall back to synchronous list reads");
          return { mode: "movie", items: [] };
        }
      },
      sendJson(response, status, payload) {
        jsonResponses++;
        sendJson(response, status, payload);
      },
      sendJsonParts(response, status, parts) {
        assert.equal(status, 200);
        assert.equal(parts.length, 1);
        assert.ok(Buffer.isBuffer(parts[0]), "route forwards the worker bytes as a buffer part");
        workerResponses++;
        sendJsonParts(response, status, parts);
      }
    }).then(handled => { if (!handled) res.writeHead(404).end(); }, error => res.destroy(error));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  origin = `http://127.0.0.1:${server.address().port}`;

  async function compare(options) {
    const url = pageUrl(options);
    const { response, data } = await readPage(url);
    assert.equal(response.status, 200, JSON.stringify(data));
    const expected = withDatabaseHandles(() => legacy.itemsPayload(url));
    assert.equal(JSON.stringify(withoutRevision(data)), JSON.stringify(withoutRevision(expected)), url.search);
    assert.match(data.listRevision, /^[a-f0-9]{64}$/u);
    return data;
  }
  const first = await compare({ mode: " MaNgA " });
  const next = await compare({ offset: 2 });
  const eof = await compare({ offset: 4 });
  assert.deepEqual([...titles(first), ...titles(next)], ["01 文件 共享", "02 SQL 共享", "03 另一作品", "04 文件"]);
  assert.deepEqual([first.total, first.nextOffset, next.nextOffset, eof.nextOffset, eof.count], [4, 2, 4, 4, 0]);
  assert.equal(next.listRevision, first.listRevision);
  assert.equal(eof.listRevision, first.listRevision);
  assert.equal((await compare({ limit: 50 })).count, maxItemLimit);
  const searched = await compare({ q: "共享" });
  assert.equal(searched.total, 2);
  assert.equal(searched.sort, "relevance");
  assert.equal(searched.listRevision, first.listRevision);

  const direct = await client.query(pageUrl());
  assert.ok(direct instanceof Uint8Array);
  assert.deepEqual(JSON.parse(new TextDecoder().decode(direct)), first);
  await assert.rejects(client.query(pageUrl({ mode: "photo" })), retryable("MANGA_LIST_UNAVAILABLE"));
  const movie = await readPage(pageUrl({ mode: "movie" }));
  assert.equal(movie.response.status, 200);
  assert.deepEqual(movie.data, { mode: "movie", items: [] });
  assert.equal(fallbackReads, 1);

  const rootStamp = () => withDatabaseHandles(manga.listRevision);
  const originalStamp = rootStamp();
  fs.writeFileSync(path.join(managed.directory, "catalog.html"), '<div class="sp-book-tags"><a>更新分类</a></div>');
  assert.equal(rootStamp(), originalStamp);
  const metadata = await compare();
  assert.equal(metadata.items[1].category, "更新分类");
  assert.notEqual(metadata.listRevision, first.listRevision);
  fs.writeFileSync(path.join(file.directory, "catalog.json"), JSON.stringify({ ...file.catalog, title: "01 文件 更新" }));
  assert.equal(rootStamp(), originalStamp);
  const catalogue = await compare();
  assert.equal(catalogue.items[0].title, "01 文件 更新");
  assert.notEqual(catalogue.listRevision, metadata.listRevision);
  fs.writeFileSync(path.join(file.directory, "manifest.json"), JSON.stringify({
    chapters: [{ index: 1, status: "done", image_count: 7, downloaded_count: 4 }]
  }));
  assert.equal(rootStamp(), originalStamp);
  const manifest = await compare();
  assert.equal(manifest.items[0].imageCount, 7);
  assert.notEqual(manifest.listRevision, catalogue.listRevision);
  fs.writeFileSync(path.join(pending.directory, "manifest.json"), JSON.stringify({ chapters: [] }));
  assert.equal(rootStamp(), originalStamp);
  const membership = await compare({ offset: 4 });
  assert.deepEqual(titles(membership), ["05 等待清单"]);
  assert.equal(membership.total, 5);
  assert.notEqual(membership.listRevision, manifest.listRevision);

  const update = writer.prepare("UPDATE manga_comics SET title=? WHERE cache_key=?");
  writer.exec("BEGIN IMMEDIATE");
  try {
    update.run("02 SQL 未提交", managed.directory);
    const held = await compare();
    assert.equal(held.listRevision, membership.listRevision);
    assert.equal(held.items[1].title, "02 SQL 共享");
  } finally { writer.exec("ROLLBACK"); }
  update.run("02 SQL 已提交", managed.directory);
  const committed = await compare();
  assert.equal(committed.items[1].title, "02 SQL 已提交");
  assert.notEqual(committed.listRevision, membership.listRevision);

  fs.unlinkSync(path.join(managed.directory, "manifest.json"));
  const duplicate = await compare();
  assert.equal(duplicate.items[1].title, "02 SQL 旧副本");
  assert.equal(duplicate.total, committed.total);
  assert.notEqual(duplicate.listRevision, committed.listRevision);
  assert.equal(fs.readFileSync(sentinelPath, "utf8"), sentinel, "the list worker cannot repair or replace live job history");
  assert.ok(workerResponses >= 12);

  client.beginStop();
  await assert.rejects(client.query(pageUrl()), retryable("MANGA_LIST_STOPPED"));
  await client.stop();
  await client.start();
  const restarted = await compare();
  assert.deepEqual(withoutRevision(restarted), withoutRevision(duplicate));
  assert.notEqual(restarted.listRevision, duplicate.listRevision);
  assert.equal(fs.readFileSync(sentinelPath, "utf8"), sentinel);
}

class HeldWorker extends EventEmitter {
  requests = [];
  terminations = 0;
  holdExit = false;

  postMessage(request) {
    this.requests.push(request);
    this.emit("posted", request);
  }

  reply(request, marker) {
    this.emit("message", { id: request.id, body: new TextEncoder().encode(JSON.stringify({ marker })) });
  }

  terminate() {
    this.terminations++;
    if (!this.holdExit) queueMicrotask(() => this.emit("exit", 1));
    return Promise.resolve(1);
  }
}

async function verifyWorkerLifecycle() {
  const instances = [];
  const worker = addWorker({ capacity: 2, timeoutMs: 10000, workerFactory() {
    const instance = new HeldWorker();
    instances.push(instance);
    return instance;
  } });
  let routeSignal;
  routeWorker = { query(url, options) {
    routeSignal = options.signal;
    return worker.query(url, options);
  } };
  const url = pageUrl();
  const active = new AbortController(), pending = new AbortController();
  const activeRejection = assert.rejects(worker.query(url, { signal: active.signal }), retryable("MANGA_LIST_STOPPED"));
  const pendingRejection = assert.rejects(worker.query(pageUrl({ offset: 2 }), { signal: pending.signal }), retryable("MANGA_LIST_STOPPED"));
  const held = instances[0], first = held.requests[0];
  assert.equal(first.query, url.search);
  assert.equal(held.requests.length, 1);

  const busy = await readPage(pageUrl({ offset: 4 }));
  assert.equal(busy.response.status, 503);
  assert.equal(busy.response.headers.get("retry-after"), "1");
  assert.equal(busy.data.code, "MANGA_LIST_BUSY");
  assert.equal(busy.data.retryable, true);
  assert.equal(fallbackReads, 1, "busy worker requests must not switch to synchronous scanning");

  pending.abort();
  await pendingRejection;
  const next = worker.query(pageUrl({ offset: 4 }));
  active.abort();
  await activeRejection;
  assert.equal(held.requests.length, 1, "active abort does not release the physical worker slot");
  held.reply(first, "aborted");
  assert.equal(held.requests.length, 2);
  assert.match(held.requests[1].query, /offset=4/u, "aborting a queued caller removes it");
  held.reply(first, "stale");
  held.reply(held.requests[1], "current");
  assert.equal(JSON.parse(new TextDecoder().decode(await next)).marker, "current");

  const responsesBeforeAbort = [workerResponses, jsonResponses];
  const httpAbort = new AbortController();
  const posted = once(held, "posted", { signal: AbortSignal.timeout(10000) });
  const disconnected = assert.rejects(fetch(url, { signal: httpAbort.signal }), { name: "AbortError" });
  const [httpRequest] = await posted;
  assert.ok(routeSignal instanceof AbortSignal);
  const routeAborted = once(routeSignal, "abort", { signal: AbortSignal.timeout(10000) });
  httpAbort.abort();
  await Promise.all([disconnected, routeAborted]);
  held.reply(httpRequest, "disconnected");
  await setImmediate();
  assert.deepEqual([workerResponses, jsonResponses], responsesBeforeAbort, "a closed HTTP client receives no worker payload or error");

  const stoppedActive = assert.rejects(worker.query(url), retryable("MANGA_LIST_STOPPED"));
  const stoppedPending = assert.rejects(worker.query(url), retryable("MANGA_LIST_STOPPED"));
  held.holdExit = true;
  try {
    const stopped = worker.stop();
    await Promise.all([stoppedActive, stoppedPending]);
    assert.equal(held.terminations, 1);
    await assert.rejects(worker.query(url), retryable("MANGA_LIST_STOPPED"));
    let reopened = false;
    const starting = worker.start().then(() => { reopened = true; });
    await Promise.resolve();
    assert.equal(reopened, false, "resolved terminate request cannot reopen before worker exit");
    held.emit("exit", 1);
    await Promise.all([stopped, starting]);
    const restarted = worker.query(url);
    assert.equal(instances.length, 2);
    const fresh = instances[1];
    held.reply(held.requests.at(-1), "retired");
    fresh.reply(fresh.requests[0], "restarted");
    assert.equal(JSON.parse(new TextDecoder().decode(await restarted)).marker, "restarted");
  } finally {
    held.holdExit = false;
    held.emit("exit", 1);
  }

  const timeout = new HeldWorker();
  routeWorker = addWorker({ capacity: 1, timeoutMs: 20, workerFactory: () => timeout });
  const expired = await readPage(url);
  assert.equal(expired.response.status, 503);
  assert.equal(expired.response.headers.get("retry-after"), "1");
  assert.equal(expired.data.code, "MANGA_LIST_TIMEOUT");
  assert.equal(expired.data.retryable, true);
  assert.equal(timeout.terminations, 1);
}

try {
  await verifyWorkerRoute();
  await verifyWorkerLifecycle();
  console.log(JSON.stringify({ mangaListWorker: "ok", workerResponses, fallbackReads, busyAbortStopTimeout: true }));
} finally {
  if (server?.listening) {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
  try { await Promise.all([...workers].map(worker => worker.stop())); }
  finally {
    for (const database of databases) if (database.isOpen) database.close();
    temp.cleanup();
  }
}
