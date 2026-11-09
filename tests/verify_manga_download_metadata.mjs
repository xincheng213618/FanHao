import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import fs from "node:fs";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import { finished } from "node:stream/promises";
import { performance } from "node:perf_hooks";
import { DatabaseSync } from "node:sqlite";
import { createMangaService } from "../src/modules/photos/server/manga-service.js";
import { routePhotosApi } from "../src/modules/photos/server/routes.js";
import { streamStoredZip } from "../src/modules/photos/server/stored-zip-stream.js";
import { createFileServer, entityValidators } from "../src/platform/server/file-server.js";

// Only synthetic files, private SQLite databases and an ephemeral loopback server.
const root = fs.mkdtempSync(path.join(os.tmpdir(), "fanhao-manga-download-metadata-"));
const directories = [root];
const handles = new Set();
const originalRead = fs.readFileSync;
const originalOpen = fs.openSync;
const originalRealpathSync = fs.realpathSync;
const originalStatSync = fs.statSync;
const { realpath: originalRealpath, stat: originalStat } = fs.promises;
const originalPrepare = DatabaseSync.prototype.prepare;
const collector = fs.readFileSync(new URL("../tools/manga_collector.py", import.meta.url), "utf8");
const schema = /    schema = """([\s\S]*?)    """/.exec(collector)?.[1];
assert.ok(schema?.includes("CREATE TABLE IF NOT EXISTS manga_comics"));
let measurement = null;
const metrics = [];

function measurePageCall(operation, field) {
  return function (file, ...args) {
    if (measurement && typeof file === "string" && file.endsWith(".png")) {
      const relative = path.relative(measurement.directory, file);
      if (!path.isAbsolute(relative) && !relative.startsWith(`..${path.sep}`)) measurement[field]++;
    }
    return operation.call(this, file, ...args);
  };
}

fs.realpathSync = measurePageCall(originalRealpathSync, "syncPageRealpaths");
fs.realpathSync.native = measurePageCall(originalRealpathSync.native, "syncPageRealpaths");
fs.statSync = measurePageCall(originalStatSync, "syncPageStats");
fs.promises.realpath = measurePageCall(originalRealpath, "asyncPageRealpaths");
fs.promises.stat = measurePageCall(originalStat, "asyncPageStats");
fs.readFileSync = function (file, ...args) {
  const value = originalRead.call(this, file, ...args);
  if (measurement && file === measurement.manifest) {
    measurement.manifestReads++;
    measurement.manifestBytes += Buffer.byteLength(value);
  }
  return value;
};
fs.openSync = function (file, ...args) {
  if (measurement && String(file).startsWith(measurement.directory + path.sep) && String(file).endsWith(".png")) measurement.imageDimensionReads++;
  return originalOpen.call(this, file, ...args);
};
DatabaseSync.prototype.prepare = function (sql, ...args) {
  handles.add(this);
  const statement = originalPrepare.call(this, sql, ...args);
  if (/SELECT \* FROM manga_chapters WHERE cache_key = \? ORDER BY chapter_index/.test(sql)) {
    const all = statement.all.bind(statement);
    statement.all = (...params) => {
      const rows = all(...params);
      if (measurement) {
        measurement.chapterDirectoryReads++;
        measurement.chapterDirectoryRows += rows.length;
      }
      return rows;
    };
  }
  return statement;
};

try {
  for (const source of ["json", "sqlite"]) {
    await verifyPreparedChapter(source);
    for (const count of [100, 500]) {
      const fixture = createFixture(`${source}-${count}`, source, Array.from({ length: count }, (_, index) => ({ index: index + 1, title: `chapter ${index + 1}` })));
      const result = await measuredDownload(fixture, "HEAD");
      assert.equal(result.status, 200);
      assert.equal(result.body.length, 0, "HEAD must not stream ZIP bytes");
      assert.equal(result.work.imageDimensionReads, 0, "ZIP preparation must not read image dimensions");
      assert.ok(result.work.manifestReads <= 3, `one export must not parse the manifest per chapter: ${result.work.manifestReads}`);
      assert.ok(result.work.chapterDirectoryReads <= 1, "one export must not load the full SQL directory per chapter");
      assert.ok(result.work.chapterDirectoryRows <= count, "SQL directory materialization must remain linear");
      assert.equal(result.work.syncPageRealpaths, 0, "whole-book export must not resolve page paths synchronously");
      assert.equal(result.work.syncPageStats, 0, "whole-book export must not stat pages synchronously");
      assert.equal(result.work.asyncPageRealpaths, count, "whole-book export still resolves every page");
      assert.equal(result.work.asyncPageStats, count, "whole-book export still verifies every page");
      metrics.push({ source, chapters: count, ...result.work });
    }

    const fixture = createFixture(`${source}-content`, source, [
      { index: 7, title: " Seventh / chapter ", imageIndex: 9 },
      { index: 3, title: "", imageIndex: 2 }
    ]);
    const whole = await measuredDownload(fixture, "GET");
    const entries = archiveEntries(whole.body);
    const expected = source === "sqlite"
      ? [["0003_第 3 话/0002.png", fixture.bytes[1]], ["0007_Seventh _ chapter/0009.png", fixture.bytes[0]]]
      : [["0007_Seventh _ chapter/0009.png", fixture.bytes[0]], ["0003_第 3 话/0002.png", fixture.bytes[1]]];
    assert.deepEqual(entries, expected, `${source} must preserve ZIP names, chapter order and image bytes`);
    assert.equal(whole.work.imageDimensionReads, 0);
    assert.match(whole.headers["Content-Disposition"], /^attachment;/);

    const siblingArchive = Buffer.from("private fixture archive outside the manga library");
    fs.writeFileSync(`${fixture.library}.zip`, siblingArchive);
    const single = await download(fixture, "GET", 7);
    assert.notDeepEqual(single.body, siblingArchive, "a root-level page cannot select a ZIP beside the library root");
    assert.deepEqual(archiveEntries(single.body), [["0009.png", fixture.bytes[0]]], "single chapter downloads preserve image indices and contents");
    const singleHead = await download(fixture, "HEAD", 7);
    assert.equal(singleHead.status, 200);
    assert.equal(singleHead.body.length, 0);
    assert.deepEqual(singleHead.headers, single.headers);

    fs.unlinkSync(path.join(fixture.directory, "page-0.png"));
    const missing = await download(fixture, "GET");
    assert.equal(missing.status, 409);
    const missingFiles = JSON.parse(missing.body);
    assert.equal(missingFiles.code, "MANGA_DOWNLOAD_FILES_MISSING");
    assert.equal(missingFiles.expectedFiles, 2);
    assert.equal(missingFiles.availableFiles, 1);
    fixture.writeImage(0);
    fixture.setIncomplete();
    const incomplete = await download(fixture, "GET");
    assert.equal(incomplete.status, 409);
    assert.equal(JSON.parse(incomplete.body).code, "MANGA_DOWNLOAD_INCOMPLETE");

    const traversal = createFixture(`${source}-path`, source, [{ index: 1, title: "outside", localPath: "../outside.png" }]);
    fs.writeFileSync(path.join(traversal.library, "outside.png"), Buffer.from("outside the comic"));
    const blocked = await download(traversal, "GET");
    assert.equal(blocked.status, 409, "an existing file outside the comic must still fail download validation");
    assert.equal(JSON.parse(blocked.body).code, "MANGA_DOWNLOAD_FILES_MISSING");
    assert.equal((await download(traversal, "GET", 1)).status, 404);

    const linked = createFixture(`${source}-linked`, source, [{ index: 1, title: "linked", localPath: "chapters/001/images/page.png" }]);
    const outside = path.join(root, `${source}-external`); mkdir(outside);
    const outsideChapter = path.join(outside, "001"); mkdir(outsideChapter);
    const outsideImages = path.join(outsideChapter, "images"); mkdir(outsideImages);
    fs.writeFileSync(path.join(outside, "001.zip"), siblingArchive);
    fs.writeFileSync(path.join(outsideImages, "page.png"), siblingArchive);
    const chapters = path.join(linked.directory, "chapters");
    const chapter = path.join(chapters, "001");
    const images = path.join(chapter, "images");
    fs.unlinkSync(path.join(images, "page.png"));
    for (const directory of [images, chapter, chapters]) removeEmptyFixtureDirectory(directory);
    fs.symlinkSync(outside, chapters, process.platform === "win32" ? "junction" : "dir");
    assert.equal((await download(linked, "GET", 1)).status, 404, "a junction cannot supply a prepared chapter ZIP");
    const linkedWhole = await download(linked, "GET");
    assert.equal(linkedWhole.status, 409, "a junction cannot supply loose pages for the whole-book ZIP");
    assert.equal(JSON.parse(linkedWhole.body).code, "MANGA_DOWNLOAD_FILES_MISSING");
  }

  const duplicate = createFixture("json-duplicate", "json", [
    { index: 8, title: "first" }, { index: 8, title: "second" }, { index: 0, title: "" }
  ]);
  const duplicateArchive = await download(duplicate, "GET");
  assert.deepEqual(archiveEntries(duplicateArchive.body), [
    ["0008_first/0001.png", duplicate.bytes[0]],
    ["0008_first/0001.png", duplicate.bytes[0]],
    ["0003_第 3 话/0001.png", duplicate.bytes[2]]
  ], "JSON duplicate indices retain first-match semantics; absent indices retain array-position fallback");

  const malformed = createFixture("json-image-indices", "json", Array.from({ length: 5 }, (_, index) => ({ index: index + 1, title: "indices" })));
  fs.writeFileSync(malformed.manifest, JSON.stringify({ chapters: [{
    index: 4, title: "indices", status: "done",
    images: [9, "0", "nonnumeric", 0, null].map((index, position) => ({ index, local_path: `page-${position}.png`, status: "downloaded" }))
  }] }));
  const malformedArchive = await download(malformed, "GET", 4);
  assert.deepEqual(archiveEntries(malformedArchive.body), [9, 2, 3, 4, 5].map((index, position) => [
    `${String(index).padStart(4, "0")}.png`, malformed.bytes[position]
  ]), "JSON image indices must retain both the reader numeric conversion and download fallback");

  const archived = createFixture("existing-archive", "json", [{ index: 5, title: "archived", localPath: "chapters/005/images/page.png" }]);
  const chapterArchive = Buffer.from("already prepared chapter archive");
  fs.writeFileSync(path.join(archived.directory, "chapters", "005.zip"), chapterArchive);
  fs.unlinkSync(path.join(archived.directory, "chapters", "005", "images", "page.png"));
  const existing = await download(archived, "GET", 5);
  assert.deepEqual(existing.body, chapterArchive, "an existing chapter ZIP must still be streamed unchanged when loose pages are absent");
  assert.equal(existing.headers["Content-Length"], chapterArchive.length);

  const openedLoose = createFixture("opened-loose", "json", [{ index: 1, title: "loose" }]);
  await verifyOpenedReplacement(openedLoose, 1, path.join(openedLoose.directory, "page-0.png"));
  await verifyOpenedReplacement(archived, 5, path.join(archived.directory, "chapters", "005.zip"));

  const linkedComic = createFixture("linked-comic", "sqlite", [{ index: 1, title: "linked comic" }]);
  const externalComic = path.join(root, "external-comic"); mkdir(externalComic);
  for (const name of ["catalog.json", "manifest.json", "page-0.png"]) {
    fs.copyFileSync(path.join(linkedComic.directory, name), path.join(externalComic, name));
  }
  const realpath = fs.promises.realpath;
  let swappedComic = false;
  fs.promises.realpath = function (file, ...args) {
    if (!swappedComic && file === linkedComic.directory) {
      swappedComic = true;
      for (const name of ["catalog.json", "manifest.json", "page-0.png"]) fs.unlinkSync(path.join(file, name));
      removeEmptyFixtureDirectory(file);
      fs.symlinkSync(externalComic, file, process.platform === "win32" ? "junction" : "dir");
    }
    return realpath.call(this, file, ...args);
  };
  try {
    assert.equal((await download(linkedComic, "GET")).status, 404, "a cached comic directory cannot resolve outside the manga library");
    assert.equal(swappedComic, true);
  } finally {
    fs.promises.realpath = realpath;
  }

  await verifyDownloadPreflightLifecycle();
  console.log(JSON.stringify({ ok: true, sources: 2, metrics }, null, 2));
} finally {
  measurement = null;
  fs.readFileSync = originalRead;
  fs.openSync = originalOpen;
  fs.realpathSync = originalRealpathSync;
  fs.statSync = originalStatSync;
  fs.promises.realpath = originalRealpath;
  fs.promises.stat = originalStat;
  DatabaseSync.prototype.prepare = originalPrepare;
  for (const database of handles) { try { database.close(); } catch {} }
  // Delete only files in explicitly created fixture directories, deepest first.
  for (const directory of directories.reverse()) {
    assert.ok(directory === root || path.relative(root, directory).split(path.sep)[0] !== "..");
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      assert.equal(entry.isDirectory(), false, "all owned child directories must already be removed");
      fs.unlinkSync(path.join(directory, entry.name));
    }
    fs.rmdirSync(directory);
  }
}

function mkdir(directory) {
  fs.mkdirSync(directory);
  directories.push(directory);
}

function removeEmptyFixtureDirectory(directory) {
  const index = directories.indexOf(directory);
  assert.ok(index > 0 && path.relative(root, directory).split(path.sep)[0] !== "..");
  fs.rmdirSync(directory);
  directories.splice(index, 1);
}

function createFixture(name, source, input) {
  const library = path.join(root, name); mkdir(library);
  const directory = path.join(library, "smtt6_cache_fixture"); mkdir(directory);
  const bytes = [];
  const chapters = input.map(item => ({
    index: item.index, title: item.title, status: "done",
    images: (item.images || [item]).map((page, offset) => {
      const index = bytes.length;
      const image = Buffer.alloc(25);
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(image);
      image.writeUInt32BE(720, 16); image.writeUInt32BE(800 + index, 20); image[24] = index % 256;
      bytes.push(image);
      return { index: page.imageIndex || offset + 1, local_path: page.localPath || `page-${index}.png`, bytes: image.length, status: "downloaded" };
    })
  }));
  const localPaths = chapters.flatMap(chapter => chapter.images.map(image => image.local_path));
  for (const relative of localPaths) {
    if (relative.startsWith("../")) continue;
    let parent = directory;
    for (const part of relative.split("/").slice(0, -1)) {
      parent = path.join(parent, part);
      if (!fs.existsSync(parent)) mkdir(parent);
    }
  }
  function writeImage(index) {
    const relative = localPaths[index];
    if (!relative.startsWith("../")) fs.writeFileSync(path.join(directory, relative), bytes[index]);
  }
  localPaths.forEach((_, index) => writeImage(index));
  const manifest = path.join(directory, "manifest.json");
  fs.writeFileSync(manifest, JSON.stringify({ chapters }));
  const sourceUrl = `https://synthetic.invalid/${name}`;
  fs.writeFileSync(path.join(directory, "catalog.json"), JSON.stringify({ title: name, url: sourceUrl }));
  let database;
  const databasePath = source === "sqlite" ? path.join(library, "manga.sqlite") : "";
  if (databasePath) {
    database = new DatabaseSync(databasePath); handles.add(database); database.exec(schema);
    database.prepare("INSERT INTO manga_comics(cache_key,dir_name,site,title,source_url,chapter_count,done_chapter_count,image_count,downloaded_count) VALUES (?,?,'smtt6',?,?,?,?,?,?)")
      .run(directory, path.basename(directory), name, sourceUrl, chapters.length, chapters.length, localPaths.length, localPaths.length);
    const chapterStatement = database.prepare("INSERT INTO manga_chapters(cache_key,chapter_index,title,image_count,downloaded_count,status) VALUES (?,?,?,?,?,'done')");
    const imageStatement = database.prepare("INSERT INTO manga_images(cache_key,chapter_index,image_index,local_path,bytes,status) VALUES (?,?,?,?,?,'downloaded')");
    database.exec("BEGIN");
    try {
      for (const chapter of chapters) {
        chapterStatement.run(directory, chapter.index, chapter.title, chapter.images.length, chapter.images.length);
        for (const image of chapter.images) imageStatement.run(directory, chapter.index, image.index, image.local_path, image.bytes);
      }
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  }
  const notFound = response => { response.writeHead(404); response.end(); };
  const fileServer = createFileServer({ mimeTypes: {}, normalizeExt: file => path.extname(file), notFound });
  const service = createMangaService({
    root: library, databasePath,
    safeStat(file) { try { return fs.statSync(file); } catch { return null; } },
    notFound,
    serveWholeFile: fileServer.serveWholeFile
  });
  const id = service.publicSummary(directory).id;
  assert.equal(service.cacheById(id), directory, "prime directory identity before measuring export metadata");
  return {
    library, directory, manifest, service, id, bytes, writeImage,
    setIncomplete() {
      if (database) database.prepare("UPDATE manga_comics SET done_chapter_count=0 WHERE cache_key=?").run(directory);
      else { chapters[0].status = "pending"; fs.writeFileSync(manifest, JSON.stringify({ chapters })); }
    }
  };
}

async function download(fixture, method, chapterIndex) {
  const chunks = [];
  const response = new Writable({ write(chunk, _encoding, callback) { chunks.push(Buffer.from(chunk)); callback(); } });
  response.writeHead = function (status, headers = {}) { this.status = status; this.headers = headers; };
  const request = Object.assign(new EventEmitter(), { method });
  const chapterPath = chapterIndex === undefined ? "" : `/chapters/${encodeURIComponent(chapterIndex)}`;
  const url = new URL(`http://fixture/api/manga/${encodeURIComponent(fixture.id)}${chapterPath}/download`);
  assert(await routePhotosApi(request, response, url, { mangaService: fixture.service }));
  await finished(response);
  return { status: response.status, headers: response.headers, body: Buffer.concat(chunks) };
}

async function verifyOpenedReplacement(fixture, chapterIndex, target) {
  const canonical = fs.realpathSync.native(target);
  const open = fs.promises.open;
  let opened, closed = false;
  fs.promises.open = async function (file, ...args) {
    if (file !== canonical) return open.call(this, file, ...args);
    fs.unlinkSync(file);
    fs.writeFileSync(file, Buffer.from("replacement bytes selected after download discovery"));
    opened = await open.call(this, file, ...args);
    const close = opened.close.bind(opened);
    opened.close = async () => { await close(); closed = true; };
    opened.createReadStream = () => assert.fail("an unverified descriptor must not stream replacement bytes");
    return opened;
  };
  try {
    await assert.rejects(download(fixture, "GET", chapterIndex), { code: "ZIP_SOURCE_CHANGED" });
    assert.equal(closed, true, "a rejected source must close its descriptor before the request settles");
  } finally {
    fs.promises.open = open;
    await opened?.close();
  }
}

async function measuredDownload(fixture, method, chapterIndex) {
  measurement = {
    manifest: fixture.manifest, directory: fixture.directory, manifestReads: 0, manifestBytes: 0, imageDimensionReads: 0,
    chapterDirectoryReads: 0, chapterDirectoryRows: 0, syncPageRealpaths: 0, syncPageStats: 0, asyncPageRealpaths: 0, asyncPageStats: 0
  };
  const began = performance.now();
  try {
    const result = await download(fixture, method, chapterIndex);
    const { manifest, directory, ...work } = measurement;
    return { ...result, work: { ...work, elapsedMs: +(performance.now() - began).toFixed(2) } };
  } finally { measurement = null; }
}

async function verifyPreparedChapter(source) {
  const pages = Array.from({ length: 1000 }, (_, index) => ({ localPath: `chapters/001/images/page-${index}.png` }));
  const fixture = createFixture(`prepared-${source}`, source, [{ index: 1, title: "Prepared", images: pages }]);
  const archivePath = path.join(fixture.directory, "chapters", "001.zip");
  const chunks = [];
  const zip = new Writable({ write(chunk, _encoding, callback) { chunks.push(Buffer.from(chunk)); callback(); } });
  assert(await streamStoredZip(zip, pages.map(page => ({
    path: path.join(fixture.directory, page.localPath), name: `images/${path.basename(page.localPath)}`
  }))));
  const preparedBytes = Buffer.concat(chunks);
  assert.equal(archiveEntries(preparedBytes).length, pages.length);
  fs.writeFileSync(archivePath, preparedBytes);

  const get = await measuredDownload(fixture, "GET", 1);
  const head = await measuredDownload(fixture, "HEAD", 1);
  assert.deepEqual(get.body, preparedBytes, "GET streams the already prepared ZIP unchanged");
  assert.equal(head.body.length, 0);
  assert.deepEqual(get.headers, {
    "Content-Type": "application/zip",
    "Content-Length": preparedBytes.length,
    "Content-Disposition": `attachment; filename="prepared-${source} - Prepared.zip"; filename*=UTF-8''prepared-${source}%20-%20Prepared.zip`,
    "Cache-Control": "no-store",
    ...entityValidators({}, fs.statSync(archivePath))
  });
  assert.deepEqual(head.headers, get.headers, "HEAD retains prepared GET headers");
  for (const result of [head, get]) {
    assert.equal(result.status, 200);
    const { syncPageRealpaths, syncPageStats, asyncPageRealpaths, asyncPageStats } = result.work;
    assert.deepEqual([syncPageRealpaths, syncPageStats, asyncPageRealpaths, asyncPageStats], [0, 0, 0, 0],
      `${source} prepared ZIPs must bypass every loose page check`);
  }

  const fallback = createFixture(`prepared-fallback-${source}`, source, [{ index: 1, title: "Loose", images: pages.slice(0, 2) }]);
  const fallbackArchive = path.join(fallback.directory, "chapters", "001.zip");
  for (const unusable of ["missing", "directory"]) {
    if (unusable === "directory") mkdir(fallbackArchive);
    const generated = await download(fallback, "GET", 1);
    assert.equal(generated.status, 200);
    assert.deepEqual(archiveEntries(generated.body), [["0001.png", fallback.bytes[0]], ["0002.png", fallback.bytes[1]]],
      `${unusable} prepared ZIP must still allow the same loose chapter download`);
  }
  fs.unlinkSync(path.join(fallback.directory, pages[0].localPath));
  const partial = await download(fallback, "GET", 1);
  assert.equal(partial.status, 200);
  assert.deepEqual(archiveEntries(partial.body), [["0002.png", fallback.bytes[1]]], "a loose chapter can still include its available pages");
  metrics.push({ source, preparedPages: pages.length, get: get.work, head: head.work });
}

async function verifyDownloadPreflightLifecycle() {
  const fixture = createFixture("preflight-lifecycle", "json", [{ index: 1, title: "Held" }]);
  const page = path.join(fixture.directory, "page-0.png");
  const events = new EventEmitter();
  const event = name => once(events, name, { signal: AbortSignal.timeout(5000) });
  const release = Promise.withResolvers();
  const { realpath, stat, open } = fs.promises;
  const firstClient = new AbortController();
  const routeErrors = [];
  let holding = true, held = 0, stats = 0, opens = 0;
  fs.promises.realpath = function (file, ...args) {
    if (file !== page || !holding) return realpath.call(this, file, ...args);
    if (++held === 2) events.emit("held");
    return release.promise.then(() => realpath.call(this, file, ...args));
  };
  fs.promises.stat = function (file, ...args) {
    if (file === page) stats++;
    return stat.call(this, file, ...args);
  };
  fs.promises.open = function (file, ...args) {
    if (file === page) opens++;
    return open.call(this, file, ...args);
  };
  const server = createServer((req, res) => {
    const url = new URL(req.url, "http://fixture");
    if (url.pathname === "/health") return res.end("ok");
    const id = url.searchParams.get("request");
    const route = routePhotosApi(req, res, url, { mangaService: fixture.service });
    events.emit(`arrived-${id}`);
    void route.catch(error => {
      routeErrors.push(error);
      res.destroy(error);
    }).finally(() => events.emit(`settled-${id}`));
  });
  try {
    server.listen(0, "127.0.0.1");
    await once(server, "listening", { signal: AbortSignal.timeout(5000) });
    const base = `http://127.0.0.1:${server.address().port}`;
    const downloadUrl = `${base}/api/manga/${fixture.id}/download`;
    const request = (id, signal = AbortSignal.timeout(5000)) => fetch(`${downloadUrl}?request=${id}`, { signal });
    const active = event("held");
    void active.catch(() => {});
    const accepted = [];
    for (let index = 0; index < 8; index++) {
      const arrived = event(`arrived-${index}`);
      const signal = index === 0 ? AbortSignal.any([firstClient.signal, AbortSignal.timeout(5000)]) : undefined;
      accepted.push(request(index, signal).then(response => ({ response }), error => ({ error })));
      await arrived;
      if (index === 1) await active;
    }
    const health = await fetch(base + "/health", { signal: AbortSignal.timeout(2000) });
    assert.equal(await health.text(), "ok", "pending preflight I/O must leave unrelated HTTP requests responsive");
    await assertDownloadRetry(await request("overflow"), "MANGA_DOWNLOAD_BUSY");

    const disconnected = event("settled-0");
    firstClient.abort();
    await disconnected;
    assert.equal((await accepted[0]).error?.name, "AbortError");
    assert.equal(held, 2, "cancelling an HTTP consumer must retain its occupied physical slot");
    assert.equal(stats, 0);
    assert.equal(opens, 0);

    let stopped = false;
    const stop = fixture.service.stopChapterReads().then(() => { stopped = true; });
    // Observe a failed stop immediately, while still propagating it below.
    void stop.catch(() => {});
    for (const pending of accepted.slice(1)) {
      const { response } = await pending;
      await assertDownloadRetry(response, "MANGA_DOWNLOAD_STOPPED");
    }
    assert.equal(stopped, false, "shutdown must wait for the physical preflight operations");
    holding = false;
    release.resolve();
    await stop;
    assert.equal(held, 2, "queued preflights never start after shutdown");
    assert.equal(stats, 0, "aborted realpath results must not start a stat");
    assert.equal(opens, 0, "aborted preflights must not open the ZIP sources");
    await assertDownloadRetry(await request("stopped"), "MANGA_DOWNLOAD_STOPPED");

    await fixture.service.startChapterReads();
    const retry = await request("restart");
    assert.equal(retry.status, 200);
    assert.deepEqual(archiveEntries(Buffer.from(await retry.arrayBuffer())), [["0001_Held/0001.png", fixture.bytes[0]]]);
    assert.equal(stats, 1);
    assert.equal(opens, 1);
    assert.deepEqual(routeErrors, []);
  } finally {
    firstClient.abort();
    release.resolve();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await fixture.service.stopChapterReads().catch(() => {});
    fs.promises.realpath = realpath;
    fs.promises.stat = stat;
    fs.promises.open = open;
  }
  metrics.push({ preflightLifecycle: true, active: 2, capacity: 8, retryAfter: 1 });
}

async function assertDownloadRetry(response, code) {
  assert.equal(response?.status, 503);
  assert.equal(response.headers.get("Retry-After"), "1");
  const payload = await response.json();
  assert.equal(payload.code, code);
  assert.equal(payload.retryable, true);
}

function archiveEntries(bytes) {
  assert.equal(bytes.readUInt32LE(bytes.length - 22), 0x06054b50, "ZIP end record must be present");
  let offset = bytes.readUInt32LE(bytes.length - 6);
  return Array.from({ length: bytes.readUInt16LE(bytes.length - 14) }, () => {
    assert.equal(bytes.readUInt32LE(offset), 0x02014b50);
    const size = bytes.readUInt32LE(offset + 24);
    const nameSize = bytes.readUInt16LE(offset + 28);
    const extraSize = bytes.readUInt16LE(offset + 30);
    const commentSize = bytes.readUInt16LE(offset + 32);
    const local = bytes.readUInt32LE(offset + 42);
    const name = bytes.subarray(offset + 46, offset + 46 + nameSize).toString("utf8");
    assert.equal(bytes.readUInt32LE(local), 0x04034b50);
    const body = local + 30 + bytes.readUInt16LE(local + 26) + bytes.readUInt16LE(local + 28);
    offset += 46 + nameSize + extraSize + commentSize;
    return [name, bytes.subarray(body, body + size)];
  });
}
