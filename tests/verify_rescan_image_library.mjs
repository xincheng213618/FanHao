import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { EventEmitter } from "node:events";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { createServerConfig } from "../src/bootstrap/server-config.js";
import { CURRENT_INDEX_SCHEMA, PARSER_VERSION, imageLibraryCacheIdentity } from "../src/modules/content-index/server/image-library-index-contract.js";
import { createImageLibraryIndexService } from "../src/modules/content-index/server/image-library-index-service.js";
import { createPhotoSetService } from "../src/modules/photos/server/photo-set-service.js";
import { createPhotosRuntime } from "../src/modules/photos/server/runtime.js";
import { galleryMediaSources } from "../src/platform/server/root-config.js";
import { removeVerifiedTempDir } from "./verified-temp-cleanup.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "fanhao-rescan-fixture-"));
assert.throws(() => removeVerifiedTempDir(os.tmpdir()), /Refusing to recursively delete/, "temporary-root cleanup must fail closed");
try {
  const photoRoot = path.join(tempDir, "photos");
  const movieRoot = path.join(tempDir, "movies");
  const tvRoot = path.join(tempDir, "tv");
  const animeRoot = path.join(tempDir, "anime");
  const dataDir = path.join(tempDir, "data");
  fs.mkdirSync(photoRoot, { recursive: true });
  fs.mkdirSync(movieRoot, { recursive: true });
  fs.mkdirSync(tvRoot, { recursive: true });
  fs.mkdirSync(path.join(animeRoot, "示例动漫"), { recursive: true });
  fs.writeFileSync(path.join(photoRoot, "fixture.zip"), "fixture");
  fs.writeFileSync(path.join(movieRoot, "fixture.mp4"), "fixture");
  fs.writeFileSync(path.join(animeRoot, "示例动漫", "第1话.mp4"), "fixture");
  const env = {
    ...process.env,
    FANHAO_LOAD_ENV: "0",
    FANHAO_PRODUCT: "suite",
    FANHAO_DATA_DIR: dataDir,
    FANHAO_PHOTO_SET_ROOTS: photoRoot,
    FANHAO_MOVIE_ROOTS: movieRoot,
    FANHAO_TV_ROOTS: tvRoot,
    FANHAO_ANIME_ROOTS: animeRoot
  };
  const run = (scope = "all", overrides = {}) => spawnSync(process.execPath, ["tools/rescan_image_library.mjs", "--scope", scope], {
    cwd: repoRoot, encoding: "utf8", env: { ...env, ...overrides }, windowsHide: true
  });
  const firstRun = run();
  assert.equal(firstRun.status, 0, firstRun.stderr || firstRun.stdout);
  const progressLines = firstRun.stdout.split(/\r?\n/u).filter((line) => line.startsWith("IMAGE_LIBRARY_PROGRESS "));
  assert(progressLines.length >= 4, "rescan must expose machine-readable progress from scan start through index commit");
  const progress = progressLines.map((line) => JSON.parse(line.slice("IMAGE_LIBRARY_PROGRESS ".length)));
  assert.equal(progress[0].phase, "start");
  assert(progress.some((item) => item.phase === "photo-root" && item.rootIndex === 1 && item.rootTotal === 1));
  assert(progress.some((item) => item.phase === "write" && item.percent === 94));
  assert.equal(progress.at(-1).phase, "complete");
  assert.equal(progress.at(-1).percent, 100);
  assert.equal(progress.at(-1).photoSets, 1);
  const indexPath = path.join(dataDir, "image-library-index.json");
  assert.equal(fs.existsSync(indexPath), false, "a fresh scan never writes a JSON index");
  const first = readPublication(dataDir);
  assert.ok(first.photoRevision);
  assert.equal(first.mediaRevision, first.photoRevision, "an all-scope scan publishes both together");
  assert.deepEqual(first.photoSets.map((item) => item.title), ["fixture"]);
  assert.deepEqual(first.mediaItems.map((item) => [item.mediaKind, item.title]), [["anime", "第1话"], ["movie", "fixture"]]);
  assert.equal(first.mediaItems.find((item) => item.mediaKind === "anime")?.seriesName, "示例动漫");
  fs.writeFileSync(indexPath, "stale and invalid JSON");
  const secondRun = run("photo");
  assert.equal(secondRun.status, 0, secondRun.stderr || secondRun.stdout);
  const second = readPublication(dataDir);
  assert.deepEqual(second.photoSets, first.photoSets);
  assert.notEqual(second.photoRevision, first.photoRevision);
  assert.deepEqual(second.mediaItems, first.mediaItems);
  assert.equal(second.mediaRevision, first.mediaRevision, "a photo scan leaves the published media scope intact");
  assert.equal(fs.readFileSync(indexPath, "utf8"), "stale and invalid JSON", "a scan ignores old JSON entirely");
  verifyExplicitImport({ tempDir, env, run, first });
  const detachedRoot = path.join(tempDir, "detached-photos");
  const detachedData = path.join(tempDir, "detached-data");
  fs.mkdirSync(detachedRoot);
  const detachedConfig = { FANHAO_PHOTO_SET_ROOTS: detachedRoot, FANHAO_DATA_DIR: detachedData };
  const connected = run("photo", detachedConfig);
  assert.equal(connected.status, 0, connected.stderr || connected.stdout);
  const prior = readPublication(detachedData);
  fs.rmdirSync(detachedRoot);
  const disconnected = run("photo", detachedConfig);
  assert.notEqual(disconnected.status, 0);
  assert.match(disconnected.stderr, /原图库目录暂不可用/);
  assert.deepEqual(readPublication(detachedData), prior);
  await verifyPhotoSetLookup(photoRoot);
  verifyScanCollation({ photoRoot, movieRoot, dataDir, env, run });
  console.log("rescan-image-library: ok");
} finally {
  removeVerifiedTempDir(tempDir);
}

function readPublication(dataDir) {
  const db = new DatabaseSync(path.join(dataDir, "image-gallery.sqlite"), { readOnly: true });
  try {
    const rows = table => db.prepare(`SELECT data_json FROM ${table} ORDER BY position`).all().map(row => JSON.parse(row.data_json));
    return {
      photoRevision: db.prepare("SELECT revision FROM photo_library_snapshot WHERE id=1").get()?.revision,
      mediaRevision: db.prepare("SELECT revision FROM gallery_media_library_snapshot WHERE id=1").get()?.revision,
      photoSets: rows("photo_library_archives"), mediaItems: rows("gallery_media_library_items")
    };
  } finally {
    db.close();
  }
}

function verifyExplicitImport({ tempDir, env, run, first }) {
  const target = path.join(tempDir, "import-data");
  const overrides = { FANHAO_DATA_DIR: target };
  const scanned = run("photo", overrides);
  assert.equal(scanned.status, 0, scanned.stderr || scanned.stdout);
  const prior = readPublication(target);
  const config = createServerConfig({ env: { ...env, ...overrides } });
  const legacy = {
    schemaVersion: CURRENT_INDEX_SCHEMA, parserVersion: PARSER_VERSION,
    cacheIdentity: imageLibraryCacheIdentity({ archiveExts: config.ARCHIVE_EXTS, photoSetRoots: config.PHOTO_SET_ROOTS,
      directVideoExts: config.DIRECT_VIDEO_EXTS, galleryMediaSources: config.GALLERY_MEDIA_SOURCES, videoExts: config.VIDEO_EXTS }),
    scannedAt: "2026-10-01T00:00:00Z", roots: [], mediaRoots: [],
    photoSets: [{ ...first.photoSets[0], title: "Superseded fixture" }], mediaItems: first.mediaItems
  };
  const source = path.join(tempDir, "explicit-legacy.json");
  const importIndex = () => spawnSync(process.execPath, ["tools/import_gallery_index.mjs", source], {
    cwd: repoRoot, encoding: "utf8", env: { ...env, ...overrides }, windowsHide: true
  });
  fs.writeFileSync(source, JSON.stringify({ ...legacy, schemaVersion: CURRENT_INDEX_SCHEMA - 1 }));
  const wrong = importIndex();
  assert.notEqual(wrong.status, 0, "old schema files cannot be imported");
  assert.deepEqual(readPublication(target), prior);
  const bytes = JSON.stringify(legacy);
  fs.writeFileSync(source, bytes);
  const result = importIndex();
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.deepEqual(JSON.parse(result.stdout), { importedPhotos: false, importedMedia: true, photoSets: 1, mediaItems: 2 });
  const imported = readPublication(target);
  assert.equal(imported.photoRevision, prior.photoRevision);
  assert.deepEqual(imported.photoSets, prior.photoSets);
  assert.deepEqual(imported.mediaItems, legacy.mediaItems);
  assert.equal(fs.readFileSync(source, "utf8"), bytes, "explicit import leaves the source available for operator verification");
  const again = importIndex();
  assert.equal(again.status, 0, again.stderr || again.stdout);
  assert.deepEqual(JSON.parse(again.stdout), { importedPhotos: false, importedMedia: false, photoSets: 1, mediaItems: 2 });
  assert.deepEqual(readPublication(target), imported);
}

function verifyScanCollation({ photoRoot, movieRoot, dataDir, env, run }) {
  const oldCompare = (left, right) => left.localeCompare(right, undefined, { numeric: true, sensitivity: "base" });
  assert.equal(oldCompare("第02话", "第2话"), 0);
  assert.equal(oldCompare("Épisode 03", "Episode 3"), 0);
  const stamp = new Date("2020-01-01T00:00:00Z");
  const newer = new Date("2020-02-01T00:00:00Z");
  function expectedTitles(root, extension) {
    for (const title of ["第10话", "第02话", "第2话", "第1话", "Épisode 03", "Episode 3", "第99话"]) {
      const file = path.join(root, title + extension);
      fs.writeFileSync(file, "synthetic sort fixture");
      fs.utimesSync(file, stamp, title === "第99话" ? newer : stamp);
    }
    fs.utimesSync(path.join(root, "fixture" + extension), stamp, stamp);
    return fs.readdirSync(root).sort(oldCompare)
      .map(name => ({ title: path.parse(name).name, updatedAt: fs.statSync(path.join(root, name)).mtimeMs }))
      .sort((a, b) => b.updatedAt - a.updatedAt || oldCompare(a.title, b.title)).map(item => item.title);
  }
  const photos = expectedTitles(photoRoot, ".zip");
  const movies = expectedTitles(movieRoot, ".mp4");
  const service = createImageLibraryIndexService({
    archiveExts: new Set([".zip"]), directVideoExts: new Set([".mp4"]), galleryMediaSources: galleryMediaSources(env),
    photoSetRoots: [photoRoot], videoExts: [".mp4"], createId: (prefix, value) => `${prefix}_${value}`,
    normalizeExt: path.extname, isExcludedDirName: () => false, isVideo: name => name.endsWith(".mp4"),
    photoSetCoverUrl: id => id, safeStat: file => fs.statSync(file, { throwIfNoEntry: false })
  });
  function assertOrder(index) {
    assert.deepEqual(index.photoSets.map(item => item.title), photos);
    assert.deepEqual(index.mediaItems.filter(item => item.mediaKind === "movie").map(item => item.title), movies);
  }
  assertOrder(service.scanImageLibrary());
  const all = run();
  assert.equal(all.status, 0, all.stderr || all.stdout);
  const fullIndex = readPublication(dataDir);
  assertOrder(fullIndex);
  const partial = run("movie");
  assert.equal(partial.status, 0, partial.stderr || partial.stdout);
  const mergedIndex = readPublication(dataDir);
  assert.notEqual(mergedIndex.mediaRevision, fullIndex.mediaRevision);
  assert.deepEqual({ ...mergedIndex, mediaRevision: fullIndex.mediaRevision }, fullIndex, "a scoped movie rescan preserves photos, other media kinds and tied order");
}

async function verifyPhotoSetLookup(photoRoot) {
  const serverSource = fs.readFileSync(path.join(repoRoot, "server.js"), "utf8").replaceAll("\r\n", "\n");
  const serviceAssembly = serverSource.match(/const photoSetService = withGallery \? createPhotoSetService\(\{[\s\S]+?\}\) : null;/u)?.[0];
  const runtimeAssembly = serverSource.match(/\n      photos: \{([\s\S]+?)\n      \},\n      media:/u)?.[1];
  assert(serviceAssembly && runtimeAssembly, "execute the actual server photo service and runtime dependency assembly");
  const imageRows = Array.from({ length: 20 }, (_, index) => ({ path: `page-${index + 1}.jpg`, name: `Page ${index + 1}`, bytes: 10 }));
  const configuration = { archiveExts: new Set([".zip"]), directVideoExts: new Set([".mp4"]), galleryMediaSources: [], photoSetRoots: [photoRoot], videoExts: [".mp4"] };
  function response() {
    const res = new EventEmitter();
    Object.assign(res, { destroyed: false, writableEnded: false, status: null, headers: null, body: null });
    res.writeHead = (status, headers) => { res.status = status; res.headers = headers || null; };
    res.end = body => { res.body = body; res.writableEnded = true; };
    return res;
  }
  function fixture(indexed) {
    const counts = { elements: 0, lookupCalls: 0, signatures: 0, dbReads: 0, markReads: 0, imageLists: 0, mediaSends: 0, releases: 0 };
    const raw = Array.from({ length: 12000 }, (_, index) => ({ id: `album-${index}`, title: `Synthetic album ${index}`, sourceRoot: photoRoot, relativePath: `${index}.zip`, updatedAt: "before", imageCount: 20, size: 32, archiveIdentity: "synthetic", coverUrl: "" }));
    raw[0].id = "duplicate"; raw[1].id = "duplicate"; raw[2].id = 123;
    const counted = rows => new Proxy(rows, { get(target, key, receiver) { if (typeof key === "string" && /^\d+$/u.test(key)) counts.elements++; return Reflect.get(target, key, receiver); } });
    const source = { photoSets: counted(raw), mediaItems: [], scannedAt: "synthetic" };
    const rows = new Map();
    for (const row of raw) if (!rows.has(row.id)) rows.set(row.id, row);
    const photoLibraryStore = indexed ? {
      byId(id) { counts.lookupCalls++; return rows.get(id) || null; },
      index: () => assert.fail("point lookups must not materialize the photo index")
    } : undefined;
    const owner = createImageLibraryIndexService({ ...configuration, photoLibraryStore });
    if (!indexed) {
      owner.photoSetById = undefined;
      owner.getIndex = () => source;
    }
    const release = owner.clearPhotoSetLookup;
    owner.clearPhotoSetLookup = () => { counts.releases++; release(); };
    const db = { prepare() { return { get(id) { counts.dbReads++; const album = raw.find(value => value.id === id); return {
      album_id: id, archive_path: path.resolve(album.sourceRoot, album.relativePath), archive_size: 32, archive_mtime_ms: 1,
      archive_identity: "synthetic", generator_version: 2, cover_mime: "image/jpeg", cover_blob: Buffer.from("SYNTHETIC_COVER"), status: "ok"
    }; } }; } };
    const context = {
      withGallery: true, createPhotoSetService, createPhotosRuntime, imageLibraryIndexService: owner,
      photoLibraryStore: { archiveMarks() { counts.markReads++; return new Set(); } },
      ARCHIVE_IMAGE_EXTS: new Set([".jpg"]), PHOTO_SET_COVER_GENERATOR_VERSION: 2, COVER_HINTS: new Set(), IMAGE_GALLERY_COVER_MAX_BYTES: 1024,
      archiveImageSignature: async archivePath => { counts.signatures++; return { archivePath, archiveSize: 32, archiveMtimeMs: 1, archiveIdentity: "synthetic" }; },
      archiveImagesPayload: async (_archive, options) => ({ images: options.limit ? imageRows.slice(0, options.limit) : imageRows, imageCount: 20 }),
      compressImageFileToJpeg: () => assert.fail("cached fixture cover cannot compress media"), extractArchiveMemberToCache: () => assert.fail("cached fixture cover cannot extract media"),
      fileBase: value => path.parse(value).name, getImageGalleryDb: () => db,
      listArchiveImages: async () => { counts.imageLists++; return imageRows; }, MIME_TYPES: { ".jpg": "image/jpeg" }, normalizeExt: value => path.extname(value).toLowerCase(),
      notFound: res => { res.writeHead(404); res.end("missing"); }, safeStat: () => assert.fail("photo serving cannot stat synchronously"),
      safeChildPath(root, relative) { const target = path.resolve(root, relative); assert(target.startsWith(`${path.resolve(root)}${path.sep}`), "fixture source remains inside its owned photo root"); return target; },
      serveArchiveMemberImage: async (res, options) => { counts.mediaSends++; res.writeHead(200, { "Content-Type": options.contentType }); res.end(JSON.stringify(options)); },
      appConfigService: {}, imageLibraryService: {}, mangaService: {}, cleanupImageReaderCache() {}, imageReaderCacheService: { statusAsync: async () => ({ synthetic: true }) },
      readJsonBody() {}, requireLocalAdmin() {}, sendJson(res, status, value) { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(value)); }
    };
    vm.runInNewContext(serviceAssembly.replace("const photoSetService =", "globalThis.photoSetService ="), context);
    vm.runInNewContext(`globalThis.runtime = createPhotosRuntime({${runtimeAssembly}});`, context);
    return { counts, raw, owner, context, service: context.photoSetService, runtime: context.runtime };
  }
  const results = [];
  for (const indexed of [false, true]) {
    const f = fixture(indexed), id = "album-11999", responses = [];
    try {
      const detail = response(); assert.equal(await f.runtime.routeApi({ method: "GET" }, detail, new URL(`http://fixture/api/photo-sets/${id}?imageOffset=3&imageLimit=4`)), true);
      responses.push({ status: detail.status, headers: detail.headers, body: detail.body });
      for (let item = 0; item < 32; item++) {
        const res = response(); assert.equal(await f.runtime.routeMedia({ method: "GET" }, res, new URL(`http://fixture/media/gallery/${id}/${item % 20 + 1}`)), true);
        responses.push({ status: res.status, headers: res.headers, body: res.body });
      }
      for (let item = 0; item < 6; item++) {
        const res = response(); assert.equal(await f.runtime.routeMedia({ method: "GET" }, res, new URL(`http://fixture/media/gallery-cover/${id}`)), true);
        responses.push({ status: res.status, headers: res.headers, body: Buffer.from(res.body).toString("hex") });
      }
      assert.equal(f.counts.elements, indexed ? 0 : 612000, "published detail, image and cover reads do not materialize archive rows");
      assert.equal(f.counts.lookupCalls, indexed ? 39 : 0, "one point lookup serves each indexed detail, image and warm cover request");
      assert.equal(f.counts.imageLists, 32); assert.equal(f.counts.signatures, indexed ? 0 : 12); assert.equal(f.counts.dbReads, indexed ? 6 : 24);
      assert.equal(f.counts.markReads, 1);
      console.log(`photo-set lookup ${indexed ? "indexed" : "fallback"}: ${f.counts.elements} elements, ${f.counts.lookupCalls} owner lookups, 39 actual runtime responses`);
      results.push(responses);
      assert.equal(f.service.byId("duplicate").title, "Synthetic album 0"); assert.equal(f.service.byId("123"), null); assert.equal(f.service.byId(""), null);
      assert.notEqual(f.service.byId(id), f.service.byId(id), "lookup returns a fresh DTO rather than caching serialized metadata");
      f.raw[11999].relativePath = "changed.zip"; f.raw[11999].updatedAt = "changed"; f.raw[11999].title = "Changed title";
      assert.equal(f.service.byId(id).relativePath, "changed.zip"); assert.match(f.service.byId(id).coverUrl, /\?v=changed$/u);
      if (indexed) {
        const disabledContext = { ...f.context, withGallery: false, imageLibraryIndexService: null };
        vm.runInNewContext(serviceAssembly.replace("const photoSetService =", "globalThis.photoSetService ="), disabledContext);
        vm.runInNewContext(`globalThis.photoDeps = {${runtimeAssembly}};`, disabledContext);
        assert.equal(disabledContext.photoSetService, null);
        assert.equal(disabledContext.photoDeps.releasePhotoSetLookup, undefined, "a product without gallery must not dereference its disabled index owner while assembling dependencies");
        await f.runtime.stop(); assert.equal(f.counts.releases, 1);
      } else {
        const snapshot = f.owner.getIndex();
        snapshot.photoSets[0] = { id: "new-id", title: "Same-array replacement" };
        assert.equal(f.service.byId("new-id").title, "Same-array replacement");
        assert.equal(f.service.byId("duplicate").title, "Synthetic album 1", "fallback still returns the current first duplicate after replacing its predecessor");
        snapshot.photoSets[1].id = "renamed"; assert.equal(f.service.byId("duplicate"), null); assert.equal(f.service.byId("renamed").title, "Synthetic album 1");
        snapshot.photoSets.unshift({ id: "renamed", title: "Earlier duplicate" }); assert.equal(f.service.byId("renamed").title, "Earlier duplicate");
      }
    } finally { await f.runtime.stop(); }
  }
  assert.deepEqual(results[1], results[0], "actual server assembly preserves detail/image/cover response bytes and headers");
  let releases = 0;
  const failedRuntime = createPhotosRuntime({ photoSetService: { stop: async () => { throw new Error("held physical cover owner"); } }, releasePhotoSetLookup: () => { releases++; } });
  await assert.rejects(failedRuntime.stop(), /held physical cover owner/u); assert.equal(releases, 0, "failed stop retains the lookup until authority owners drain");
  console.log("photo-set owner lookup: production assembly, point reads, warm covers, stop, duplicate/type/DTO and mutable fallback checks passed");
}
