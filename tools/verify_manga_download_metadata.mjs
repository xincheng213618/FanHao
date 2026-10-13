import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import { finished } from "node:stream/promises";
import { performance } from "node:perf_hooks";
import { DatabaseSync } from "node:sqlite";
import { createMangaService } from "../src/modules/photos/server/manga-service.js";
import { createFileServer } from "../src/platform/server/file-server.js";

// Only synthetic files and private SQLite databases; no server or collector.
const root = fs.mkdtempSync(path.join(os.tmpdir(), "fanhao-manga-download-metadata-"));
const directories = [root];
const handles = new Set();
const originalRead = fs.readFileSync;
const originalOpen = fs.openSync;
const originalPrepare = DatabaseSync.prototype.prepare;
const collector = fs.readFileSync(new URL("./manga_collector.py", import.meta.url), "utf8");
const schema = /    schema = """([\s\S]*?)    """/.exec(collector)?.[1];
assert.ok(schema?.includes("CREATE TABLE IF NOT EXISTS manga_comics"));
let measurement = null;
const metrics = [];

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
    for (const count of [100, 500]) {
      const fixture = createFixture(`${source}-${count}`, source, Array.from({ length: count }, (_, index) => ({ index: index + 1, title: `chapter ${index + 1}` })));
      const result = await measuredDownload(fixture, "HEAD");
      assert.equal(result.status, 200);
      assert.equal(result.body.length, 0, "HEAD must not stream ZIP bytes");
      assert.equal(result.work.imageDimensionReads, 0, "ZIP preparation must not read image dimensions");
      assert.ok(result.work.manifestReads <= 3, `one export must not parse the manifest per chapter: ${result.work.manifestReads}`);
      assert.ok(result.work.chapterDirectoryReads <= 1, "one export must not load the full SQL directory per chapter");
      assert.ok(result.work.chapterDirectoryRows <= count, "SQL directory materialization must remain linear");
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

    const single = await download(fixture, "GET", 7);
    assert.deepEqual(archiveEntries(single.body), [["0009.png", fixture.bytes[0]]], "single chapter downloads preserve image indices and contents");
    const singleHead = await download(fixture, "HEAD", 7);
    assert.equal(singleHead.status, 200);
    assert.equal(singleHead.body.length, 0);
    assert.deepEqual(singleHead.headers, single.headers);

    fs.unlinkSync(path.join(fixture.directory, "page-0.png"));
    const missing = await download(fixture, "GET");
    assert.equal(missing.status, 409);
    assert.equal(JSON.parse(missing.body).code, "MANGA_DOWNLOAD_FILES_MISSING");
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
  const existing = await download(archived, "GET", 5);
  assert.deepEqual(existing.body, chapterArchive, "an existing chapter ZIP must still be streamed unchanged");
  assert.equal(existing.headers["Content-Length"], chapterArchive.length);

  console.log(JSON.stringify({ ok: true, sources: 2, metrics }, null, 2));
} finally {
  measurement = null;
  fs.readFileSync = originalRead;
  fs.openSync = originalOpen;
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

function createFixture(name, source, input) {
  const library = path.join(root, name); mkdir(library);
  const directory = path.join(library, "smtt6_cache_fixture"); mkdir(directory);
  const bytes = input.map((_, index) => {
    const image = Buffer.alloc(25);
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(image);
    image.writeUInt32BE(720, 16); image.writeUInt32BE(800 + index, 20); image[24] = index % 256;
    return image;
  });
  const chapters = input.map((item, index) => ({
    index: item.index, title: item.title, status: "done",
    images: [{ index: item.imageIndex || 1, local_path: item.localPath || `page-${index}.png`, bytes: bytes[index].length, status: "downloaded" }]
  }));
  for (const chapter of chapters) {
    const relative = chapter.images[0].local_path;
    if (relative.startsWith("../")) continue;
    let parent = directory;
    for (const part of relative.split("/").slice(0, -1)) {
      parent = path.join(parent, part);
      if (!fs.existsSync(parent)) mkdir(parent);
    }
  }
  function writeImage(index) {
    const relative = chapters[index].images[0].local_path;
    if (!relative.startsWith("../")) fs.writeFileSync(path.join(directory, relative), bytes[index]);
  }
  chapters.forEach((_, index) => writeImage(index));
  const manifest = path.join(directory, "manifest.json");
  fs.writeFileSync(manifest, JSON.stringify({ chapters }));
  const sourceUrl = `https://synthetic.invalid/${name}`;
  fs.writeFileSync(path.join(directory, "catalog.json"), JSON.stringify({ title: name, url: sourceUrl }));
  let database;
  const databasePath = source === "sqlite" ? path.join(library, "manga.sqlite") : "";
  if (databasePath) {
    database = new DatabaseSync(databasePath); handles.add(database); database.exec(schema);
    database.prepare("INSERT INTO manga_comics(cache_key,dir_name,site,title,source_url,chapter_count,done_chapter_count,image_count,downloaded_count) VALUES (?,?,'smtt6',?,?,?,?,?,?)")
      .run(directory, path.basename(directory), name, sourceUrl, chapters.length, chapters.length, chapters.length, chapters.length);
    const chapterStatement = database.prepare("INSERT INTO manga_chapters(cache_key,chapter_index,title,image_count,downloaded_count,status) VALUES (?,?,?,1,1,'done')");
    const imageStatement = database.prepare("INSERT INTO manga_images(cache_key,chapter_index,image_index,local_path,bytes,status) VALUES (?,?,?,?,?,'downloaded')");
    for (const chapter of chapters) {
      chapterStatement.run(directory, chapter.index, chapter.title);
      const image = chapter.images[0]; imageStatement.run(directory, chapter.index, image.index, image.local_path, image.bytes);
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
  if (chapterIndex === undefined) await fixture.service.serveComicDownload({ method }, response, fixture.id);
  else await fixture.service.serveChapterDownload({ method }, response, fixture.id, chapterIndex);
  await finished(response);
  return { status: response.status, headers: response.headers, body: Buffer.concat(chunks) };
}

async function measuredDownload(fixture, method) {
  measurement = { manifest: fixture.manifest, directory: fixture.directory, manifestReads: 0, manifestBytes: 0, imageDimensionReads: 0, chapterDirectoryReads: 0, chapterDirectoryRows: 0 };
  const began = performance.now();
  try {
    const result = await download(fixture, method);
    const { manifest, directory, ...work } = measurement;
    return { ...result, work: { ...work, elapsedMs: +(performance.now() - began).toFixed(2) } };
  } finally { measurement = null; }
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
