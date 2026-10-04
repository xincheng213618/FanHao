import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { createShortVideoStore } from "../src/modules/short-videos/server/store.js";
import { ensureCoreImageStore } from "../src/platform/server/core-image-store.js";
import { createMediaResponseService } from "../src/platform/server/media-response-service.js";
import { localImageDiskIdentity } from "../src/platform/server/local-image-read-queue.js";

// Actual store initialization, catalog/asset queries, and shared image cache.
// SQLite is :memory: only; every media filesystem operation is controlled.
const repository = path.resolve(import.meta.dirname, "..");
const casePattern = process.argv.find(value => value.startsWith("--case="))?.slice(7) || "";
const negativeMetadata = process.argv.includes("--legacy-image-metadata");
const negativeSource = process.argv.includes("--without-source-guard");
const negativeDiskKey = process.argv.includes("--without-disk-cache-identity");
let createStore = createShortVideoStore;
if (negativeMetadata || negativeSource || negativeDiskKey) {
  const file = path.join(repository, "src/modules/short-videos/server/store.js");
  let source = fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n");
  if (negativeMetadata) source = source.replace(
    "      size: stat.size,\n      modifiedAt,\n      cacheMtime: JSON.stringify([modifiedAt, Number(stat.mtimeMs ?? stat.mtime.getTime()), String(stat.dev ?? \"\"), String(stat.ino ?? \"\")]),",
    "      // Controlled old producer: missing source size and timestamp."
  );
  if (negativeSource) source = source.replace(
    "        if (db !== database) return false;",
    "        // Controlled missing source ownership."
  ).replace("return JSON.stringify(readSource()) === identity;", "return true;");
  if (negativeDiskKey) source = source.replace(
    "cacheMtime: JSON.stringify([modifiedAt, Number(stat.mtimeMs ?? stat.mtime.getTime()), String(stat.dev ?? \"\"), String(stat.ino ?? \"\")]),",
    "cacheMtime: modifiedAt,"
  );
  source = source.replace(/from\s+(["'])(\.[^"']+)\1/g, (_match, _quote, relative) =>
    `from ${JSON.stringify(pathToFileURL(path.resolve(path.dirname(file), relative)).href)}`);
  ({ createShortVideoStore: createStore } = await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`));
}

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function image(byte = 65, size = 256) {
  const buffer = Buffer.alloc(size, byte);
  buffer[0] = 0xff; buffer[1] = 0xd8;
  buffer[size - 2] = 0xff; buffer[size - 1] = 0xd9;
  return buffer;
}

function response() {
  return {
    destroyed: false, writableEnded: false,
    writeHead(status, headers = {}) { this.status = status; this.headers = headers; },
    end(buffer) { this.buffer = buffer; this.writableEnded = true; }
  };
}

function codedError(code) { return Object.assign(new Error(`controlled ${code}`), { code }); }

async function fixture(run) {
  const saved = { mkdirSync: fs.mkdirSync, existsSync: fs.existsSync, statSync: fs.statSync,
    readFileSync: fs.readFileSync, stat: fs.promises.stat, readFile: fs.promises.readFile,
    prepare: DatabaseSync.prototype.prepare };
  const base = path.resolve(repository, "__synthetic_short_video_images_never_created__");
  const files = new Map(), statGates = [], readGates = [], warnings = [];
  const counts = { stat: 0, read: 0, syncRead: 0, syncStat: 0, mkdir: 0, sql: 0 };
  const paths = Object.fromEntries(["cover", "coverB", "source", "gallery", "galleryB", "motion"]
    .map(name => [name, path.join(base, `${name}.${name === "source" || name === "motion" ? "mp4" : "jpg"}`)]));
  for (const [index, file] of Object.values(paths).entries()) files.set(file, {
    buffer: image(65 + index), mtimeMs: 1700000000000 + index, dev: 17, ino: 100 + index
  });
  const checkedPath = value => {
    const file = path.resolve(String(value));
    assert(file.startsWith(`${base}${path.sep}`), `unexpected filesystem access: ${file}`);
    return file;
  };
  function stat(file) {
    const entry = files.get(checkedPath(file));
    if (!entry) throw codedError("ENOENT");
    if (entry.error) throw codedError(entry.error);
    return { size: entry.buffer.length, mtimeMs: entry.mtimeMs, mtime: new Date(entry.mtimeMs),
      dev: entry.dev, ino: entry.ino, isFile: () => !entry.directory };
  }
  async function gated(gates, file, current) {
    const gate = gates.find(value => !value.used && value.path === file);
    if (!gate) return current();
    gate.used = true;
    try { gate.snapshot = current(); } catch (error) { gate.snapshotError = error; }
    gate.started.resolve();
    return gate.promise;
  }
  function hold(gates, file) {
    const gate = { ...deferred(), started: deferred(), path: file, used: false };
    gates.push(gate);
    return { started: gate.started.promise, release: () => gate.snapshotError ? gate.reject(gate.snapshotError) : gate.resolve(gate.snapshot),
      fail: code => gate.reject(codedError(code)) };
  }
  fs.mkdirSync = file => {
    assert.equal(path.resolve(file), repository, "only the existing in-memory store parent may be requested");
    counts.mkdir++;
  };
  fs.existsSync = file => files.has(checkedPath(file));
  fs.statSync = file => { counts.syncStat++; return stat(file); };
  fs.readFileSync = file => { counts.syncRead++; return Buffer.from(files.get(checkedPath(file))?.buffer || []); };
  fs.promises.stat = async file => {
    file = checkedPath(file); counts.stat++;
    return gated(statGates, file, () => stat(file));
  };
  fs.promises.readFile = async (file, options = {}) => {
    file = checkedPath(file); counts.read++;
    if (options.signal?.aborted) throw codedError("ABORT_ERR");
    return gated(readGates, file, () => Buffer.from(files.get(file)?.buffer || []));
  };
  let database, capturing = false, media;
  DatabaseSync.prototype.prepare = function(sql, ...args) {
    counts.sql++;
    if (capturing) database = this;
    return saved.prepare.call(this, sql, ...args);
  };
  const store = createStore({ dbPath: ":memory:", roots: [], skipStartupMaintenance: true,
    coverDbPath: path.join(base, "cover-database-must-never-open.sqlite") });
  function open() {
    capturing = true;
    try { store.prepareSchema(); } finally { capturing = false; }
    assert(database);
    database.exec("ATTACH DATABASE ':memory:' AS fanhao_images");
    ensureCoreImageStore(database);
    database.prepare(`INSERT INTO short_videos
      (id,aweme_id,visibility,media_type,source_path,cover_path,cover_source,mtime_ms,updated_at)
      VALUES('item','1234567890123456789','local_only','gallery',?,?,'native',77,'2026-01-01')`)
      .run(paths.source, paths.cover);
    database.prepare(`INSERT INTO short_video_assets
      (id,video_id,asset_type,local_path,size_bytes,mtime_ms,updated_at)
      VALUES('gallery:1','item','gallery_image:0001',?,9999,88,'2026-01-01')`).run(paths.gallery);
    database.prepare(`INSERT INTO short_video_assets
      (id,video_id,asset_type,local_path,size_bytes,mtime_ms,updated_at)
      VALUES('motion:2','item','gallery_video:0002',?,9999,99,'2026-01-01')`).run(paths.motion);
  }
  try {
    open();
    media = createMediaResponseService({ getCoreDb: () => database,
      mimeTypes: { ".jpg": "image/jpeg" }, safeStat: stat,
      notFound: res => { res.writeHead(404); res.end(); },
      sendText: (res, status) => { res.writeHead(status); res.end(); },
      warn: (...args) => warnings.push(args.join(" ")) });
    const context = { store, paths, files, counts, media, open, warnings,
      get db() { return database; }, stat,
      holdStat: file => hold(statGates, file), holdRead: file => hold(readGates, file),
      cover: options => store.coverFileAsync("item", options),
      gallery: (index = 1, options) => store.galleryFileAsync("item", index, options),
      changeCover: () => database.prepare("UPDATE short_videos SET cover_path=?,updated_at='2026-01-02' WHERE id='item'").run(paths.coverB),
      changeGallery: () => database.prepare("UPDATE short_video_assets SET local_path=?,updated_at='2026-01-02' WHERE id='gallery:1'").run(paths.galleryB) };
    await run(context);
  } finally {
    for (const gate of [...statGates, ...readGates]) if (gate.used) gate.resolve(gate.snapshot);
    if (media) await media.stop();
    store.close();
    DatabaseSync.prototype.prepare = saved.prepare;
    Object.assign(fs, { mkdirSync: saved.mkdirSync, existsSync: saved.existsSync,
      statSync: saved.statSync, readFileSync: saved.readFileSync });
    Object.assign(fs.promises, { stat: saved.stat, readFile: saved.readFile });
  }
}

const cases = [];
function scenario(name, run) { cases.push({ name, run }); }

scenario("cover-stat-metadata-and-sync-compatibility", async c => {
  const sync = c.store.coverFile("item");
  assert.equal(sync.path, c.paths.cover); assert.equal(sync.size, undefined);
  const file = await c.cover();
  assert.equal(file.path, sync.path); assert.equal(file.type, sync.type); assert.equal(file.ext, sync.ext);
  assert.equal(file.id, "item:cover"); assert.equal(file.size, c.stat(c.paths.cover).size);
  assert.equal(file.modifiedAt, c.stat(c.paths.cover).mtime.toISOString());
  assert.equal(file.cacheMtime, JSON.stringify([file.modifiedAt, 1700000000000, "17", "100"]));
  assert.equal(file.diskIdentity, localImageDiskIdentity(file.path, c.stat(file.path)));
  assert(file.isCurrentSource()); assert.equal(c.counts.syncStat, 0);
});

scenario("gallery-image-video-fallback-and-legacy-version", async c => {
  const imageFile = await c.gallery(1), videoFile = await c.gallery(2), fallback = await c.gallery(0);
  assert.equal(imageFile.path, c.paths.gallery); assert.equal(imageFile.type, "image");
  assert.equal(imageFile.cacheVersion, "88"); assert.equal(imageFile.size, 256);
  assert.equal(videoFile.path, c.paths.motion); assert.equal(videoFile.type, "video");
  assert.equal(videoFile.cacheVersion, c.store.galleryFile("item", 2).cacheVersion);
  assert.equal(videoFile.cacheVersion, "99"); assert.equal(videoFile.size, 256);
  assert.equal(fallback.path, c.paths.cover);
  assert.equal(fallback.cacheVersion, String(c.stat(c.paths.cover).mtimeMs));
  c.db.prepare("UPDATE short_videos SET cover_path='' WHERE id='item'").run();
  const sourceFallback = await c.gallery(0);
  assert.equal(sourceFallback.path, c.paths.source); assert.equal(sourceFallback.type, "video");
  assert.equal(sourceFallback.cacheVersion, c.store.galleryFile("item", 0).cacheVersion);
  assert.equal(await c.gallery(3), null);
});

for (const kind of ["cover", "gallery"]) scenario(`${kind}-cache-cold-hot-second-through-tenth`, async c => {
  const get = () => kind === "cover" ? c.cover() : c.gallery();
  const filePath = kind === "cover" ? c.paths.cover : c.paths.gallery;
  for (let index = 0; index < 10; index++) {
    const file = await get(), res = response();
    await c.media.serveImageAsync(res, file);
    assert.equal(res.status, 200); assert(res.buffer.equals(c.files.get(filePath).buffer));
    assert.equal(c.counts.read, 1, "only the first cold request may read the image file");
  }
  assert.equal(c.counts.syncRead, 0);
  assert.equal(c.db.prepare("SELECT COUNT(*) AS n FROM fanhao_images.local_image_cache").get().n, 1);
});

scenario("warm-same-size-mtime-new-inode-rereads-current-body", async c => {
  const old = await c.cover(), first = response();
  await c.media.serveImageAsync(first, old); assert.equal(c.counts.read, 1);
  const entry = c.files.get(c.paths.cover);
  entry.buffer = image(90, entry.buffer.length); entry.ino++;
  const current = await c.cover(), next = response();
  assert.equal(current.size, old.size); assert.equal(current.modifiedAt, old.modifiedAt);
  await c.media.serveImageAsync(next, current);
  assert(next.buffer.equals(entry.buffer), "warm cache must not reuse the replaced inode's old body");
  assert.equal(c.counts.read, 2); assert.notEqual(current.cacheMtime, old.cacheMtime);
  assert.equal(c.counts.syncRead, 0);
});

scenario("warm-same-inode-sub-millisecond-time-rereads-current-body", async c => {
  const old = await c.cover(), first = response();
  await c.media.serveImageAsync(first, old); assert.equal(c.counts.read, 1);
  const entry = c.files.get(c.paths.cover);
  entry.buffer = image(91, entry.buffer.length); entry.mtimeMs += 0.25;
  const current = await c.cover(), next = response();
  assert.equal(current.size, old.size); assert.equal(current.modifiedAt, old.modifiedAt);
  await c.media.serveImageAsync(next, current);
  assert(next.buffer.equals(entry.buffer), "warm cache must retain the actual sub-millisecond stat timestamp");
  assert.equal(c.counts.read, 2); assert.notEqual(current.cacheMtime, old.cacheMtime);
});

scenario("missing-empty-directory-images-return-null", async c => {
  c.files.delete(c.paths.cover); assert.equal(await c.cover(), null);
  c.files.get(c.paths.gallery).buffer = Buffer.alloc(0); assert.equal(await c.gallery(), null);
  c.files.get(c.paths.gallery).buffer = image(); c.files.get(c.paths.gallery).directory = true;
  assert.equal(await c.gallery(), null);
});

scenario("current-stat-error-remains-visible-and-retryable", async c => {
  c.files.get(c.paths.cover).error = "EACCES";
  await assert.rejects(c.cover(), error => error.code === "EACCES");
  delete c.files.get(c.paths.cover).error;
  assert((await c.cover()).isCurrentSource());
});

scenario("pre-aborted-producer-does-no-query-or-stat", async c => {
  const controller = new AbortController(); controller.abort();
  const before = { ...c.counts };
  assert.equal(await c.cover({ signal: controller.signal }), null);
  assert.equal(await c.gallery(1, { signal: controller.signal }), null);
  assert.deepEqual(c.counts, before);
});

for (const outcome of ["success", "error"]) scenario(`abort-held-stat-${outcome}`, async c => {
  const controller = new AbortController(), gate = c.holdStat(c.paths.cover);
  const pending = c.cover({ signal: controller.signal }); await gate.started;
  controller.abort(); outcome === "success" ? gate.release() : gate.fail("EACCES");
  assert.equal(await pending, null);
});

for (const kind of ["cover", "gallery"]) for (const outcome of ["success", "error"])
  scenario(`${kind}-old-stat-${outcome}-after-source-change`, async c => {
    const filePath = kind === "cover" ? c.paths.cover : c.paths.gallery;
    const gate = c.holdStat(filePath), pending = kind === "cover" ? c.cover() : c.gallery();
    await gate.started; kind === "cover" ? c.changeCover() : c.changeGallery();
    const current = kind === "cover" ? await c.cover() : await c.gallery();
    assert.equal(current.path, kind === "cover" ? c.paths.coverB : c.paths.galleryB);
    outcome === "success" ? gate.release() : gate.fail("EACCES");
    assert.equal(await pending, null, "old source stat result must not escape into the current route");
    assert(current.isCurrentSource());
  });

scenario("gallery-fallback-loses-to-new-index-zero-asset", async c => {
  const gate = c.holdStat(c.paths.cover), pending = c.gallery(0); await gate.started;
  c.db.prepare(`INSERT INTO short_video_assets(id,video_id,asset_type,local_path)
    VALUES('gallery:0','item','gallery_image:0000',?)`).run(c.paths.galleryB);
  gate.release(); assert.equal(await pending, null);
  assert.equal((await c.gallery(0)).path, c.paths.galleryB);
});

scenario("gallery-fallback-old-error-after-row-path-change", async c => {
  const gate = c.holdStat(c.paths.cover), pending = c.gallery(0); await gate.started;
  c.changeCover(); gate.fail("EACCES"); assert.equal(await pending, null);
  assert.equal((await c.gallery(0)).path, c.paths.coverB);
});

for (const kind of ["cover", "gallery"]) scenario(`${kind}-logical-delete-during-stat`, async c => {
  const gate = c.holdStat(kind === "cover" ? c.paths.cover : c.paths.gallery);
  const pending = kind === "cover" ? c.cover() : c.gallery(); await gate.started;
  c.db.prepare("DELETE FROM short_videos WHERE id='item'").run();
  gate.release(); assert.equal(await pending, null);
});

scenario("returned-source-guards-detect-cover-asset-and-row-deletion", async c => {
  const cover = await c.cover(), gallery = await c.gallery();
  c.changeCover(); assert.equal(cover.isCurrentSource(), false); assert.equal(gallery.isCurrentSource(), false);
  const next = await c.gallery(); c.changeGallery(); assert.equal(next.isCurrentSource(), false);
  const live = await c.cover(); c.db.prepare("DELETE FROM short_videos WHERE id='item'").run();
  assert.equal(live.isCurrentSource(), false);
});

for (const outcome of ["success", "error"]) scenario(`database-close-reopen-discards-held-stat-${outcome}`, async c => {
  const old = await c.cover(), gate = c.holdStat(c.paths.cover), pending = c.cover(); await gate.started;
  assert.equal(c.store.close(), true); c.open();
  assert.equal(old.isCurrentSource(), false);
  const current = await c.cover(); assert(current.isCurrentSource());
  outcome === "success" ? gate.release() : gate.fail("EACCES");
  assert.equal(await pending, null); assert(current.isCurrentSource());
});

for (const retirement of ["logical-delete", "database-close-reopen"])
  scenario(`${retirement}-during-actual-read-hides-old-success-and-error`, async c => {
    const cover = await c.cover(), gallery = await c.gallery();
    const coverGate = c.holdRead(c.paths.cover), galleryGate = c.holdRead(c.paths.gallery);
    const coverResponse = response(), galleryResponse = response();
    const success = c.media.serveImageAsync(coverResponse, cover, { requireCurrentSource: true });
    const failure = c.media.serveImageAsync(galleryResponse, gallery, { requireCurrentSource: true });
    await Promise.all([coverGate.started, galleryGate.started]);
    assert.equal(c.db.prepare("SELECT COUNT(*) AS n FROM fanhao_images.local_image_cache").get().n, 0);
    if (retirement === "logical-delete") c.db.prepare("DELETE FROM short_videos WHERE id='item'").run();
    else { assert.equal(c.store.close(), true); c.open(); }
    assert.equal(cover.isCurrentSource(), false); assert.equal(gallery.isCurrentSource(), false);
    coverGate.release(); galleryGate.fail("EACCES");
    await Promise.all([success, failure]);
    for (const res of [coverResponse, galleryResponse]) {
      assert.equal(res.status, 404, "an invalidated actual SQLite source must retire both old bytes and old errors");
      assert.equal(res.buffer, undefined, "the retired response must contain no old image or error body");
    }
    assert.equal(c.db.prepare("SELECT COUNT(*) AS n FROM fanhao_images.local_image_cache").get().n, 0,
      "an old successful or failed read must not write into the current image cache");
    if (retirement === "database-close-reopen") {
      const current = await c.cover(), res = response();
      assert(current.isCurrentSource());
      await c.media.serveImageAsync(res, current, { requireCurrentSource: true });
      assert.equal(res.status, 200); assert(res.buffer.equals(c.files.get(c.paths.cover).buffer));
      assert.equal(c.db.prepare("SELECT COUNT(*) AS n FROM fanhao_images.local_image_cache").get().n, 1);
    }
  });

let passed = 0;
for (const test of cases.filter(value => !casePattern || value.name.includes(casePattern))) {
  let timer;
  try {
    await Promise.race([fixture(test.run), new Promise((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`${test.name}: controlled operation did not settle`)), 5000);
    })]);
    passed++; console.log(`PASS ${test.name}`);
  } finally { clearTimeout(timer); }
}
assert(passed > 0, `no cases matched ${casePattern}`);
console.log(`short-video-image-sources: ${passed} cases PASS; actual store/cache, memory SQLite and controlled filesystem only`);
