import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { EventEmitter } from "node:events";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { CURRENT_INDEX_SCHEMA, PARSER_VERSION, imageLibraryCacheIdentity } from "../src/modules/content-index/server/image-library-index-contract.js";
import { createImageLibraryIndexService } from "../src/modules/content-index/server/image-library-index-service.js";
import { createPhotoSetService } from "../src/modules/photos/server/photo-set-service.js";
import { createPhotosRuntime } from "../src/modules/photos/server/runtime.js";
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
    FANHAO_DATA_DIR: dataDir,
    FANHAO_PHOTO_SET_ROOTS: photoRoot,
    FANHAO_MOVIE_ROOTS: movieRoot,
    FANHAO_TV_ROOTS: tvRoot,
    FANHAO_ANIME_ROOTS: animeRoot
  };
  const run = () => spawnSync(process.execPath, ["tools/rescan_image_library.mjs", "--scope", "all"], {
    cwd: repoRoot, encoding: "utf8", env, windowsHide: true
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
  const first = JSON.parse(fs.readFileSync(indexPath, "utf8"));
  assert.equal(first.schemaVersion, CURRENT_INDEX_SCHEMA);
  assert.equal(first.parserVersion, PARSER_VERSION);
  assert.deepEqual(first.photoSets.map((item) => item.title), ["fixture"]);
  assert.deepEqual(first.mediaItems.map((item) => [item.mediaKind, item.title]), [["anime", "第1话"], ["movie", "fixture"]]);
  assert.equal(first.mediaItems.find((item) => item.mediaKind === "anime")?.seriesName, "示例动漫");
  fs.writeFileSync(indexPath, JSON.stringify({ ...first, cacheIdentity: "wrong", photoSets: [{ title: "stale" }] }));
  const secondRun = run();
  assert.equal(secondRun.status, 0, secondRun.stderr || secondRun.stdout);
  const second = JSON.parse(fs.readFileSync(indexPath, "utf8"));
  assert.deepEqual(second.photoSets.map((item) => item.title), ["fixture"], "rescan must reject an incompatible persisted index");
  assert.equal(second.mediaItems.filter((item) => item.mediaKind === "anime").length, 1);
  await verifyPhotoSetLookup(photoRoot, dataDir);
  console.log("rescan-image-library: ok");
} finally {
  removeVerifiedTempDir(tempDir);
}

async function verifyPhotoSetLookup(photoRoot, dataDir) {
  const serverSource = fs.readFileSync(path.join(repoRoot, "server.js"), "utf8").replaceAll("\r\n", "\n");
  const serviceAssembly = serverSource.match(/const photoSetService = withGallery \? createPhotoSetService\(\{[\s\S]+?\}\) : null;/u)?.[0];
  const runtimeAssembly = serverSource.match(/\n      photos: \{([\s\S]+?)\n      \},\n      media:/u)?.[1];
  assert(serviceAssembly && runtimeAssembly, "execute the actual server photo service and runtime dependency assembly");
  const imageRows = Array.from({ length: 20 }, (_, index) => ({ path: `page-${index + 1}.jpg`, name: `Page ${index + 1}`, bytes: 10 }));
  const configuration = { archiveExts: new Set([".zip"]), directVideoExts: new Set([".mp4"]), galleryMediaSources: [], photoSetRoots: [photoRoot], videoExts: [".mp4"] };
  const identity = imageLibraryCacheIdentity(configuration);
  function response() {
    const res = new EventEmitter();
    Object.assign(res, { destroyed: false, writableEnded: false, status: null, headers: null, body: null });
    res.writeHead = (status, headers) => { res.status = status; res.headers = headers || null; };
    res.end = body => { res.body = body; res.writableEnded = true; };
    return res;
  }
  function fixture(indexed) {
    const counts = { elements: 0, persistedReads: 0, lookupCalls: 0, signatures: 0, dbReads: 0, imageLists: 0, mediaSends: 0, releases: 0 };
    const raw = Array.from({ length: 12000 }, (_, index) => ({ id: `album-${index}`, title: `Synthetic album ${index}`, sourceRoot: photoRoot, relativePath: `${index}.zip`, updatedAt: "before", imageCount: 20, coverUrl: "" }));
    raw[0].id = "duplicate"; raw[1].id = "duplicate"; raw[2].id = 123;
    const counted = rows => new Proxy(rows, { get(target, key, receiver) { if (typeof key === "string" && /^\d+$/u.test(key)) counts.elements++; return Reflect.get(target, key, receiver); } });
    let persisted = { schemaVersion: CURRENT_INDEX_SCHEMA, parserVersion: PARSER_VERSION, cacheIdentity: identity, photoSets: counted(raw), mediaItems: [], scannedAt: "synthetic" };
    const owner = createImageLibraryIndexService({ ...configuration, imageLibraryIndexPath: path.join(dataDir, `lookup-${indexed}.json`),
      ensureDataDir() {}, createId: (_prefix, value) => value, normalizeExt: value => path.extname(value).toLowerCase(),
      isExcludedDirName: () => false, isVideo: () => false, photoSetCoverUrl: id => `/media/gallery-cover/${encodeURIComponent(id)}`,
      readJsonFile: () => { counts.persistedReads++; return persisted; }, safeStat: target => fs.statSync(target, { throwIfNoEntry: false }) });
    const lookup = owner.photoSetById, release = owner.clearPhotoSetLookup;
    owner.photoSetById = indexed ? id => { counts.lookupCalls++; return lookup(id); } : undefined;
    owner.clearPhotoSetLookup = () => { counts.releases++; release(); };
    const db = { prepare() { return { get(id) { counts.dbReads++; const album = raw.find(value => value.id === id); return {
      album_id: id, archive_path: path.resolve(album.sourceRoot, album.relativePath), archive_size: 32, archive_mtime_ms: 1,
      archive_identity: "synthetic", generator_version: 2, cover_mime: "image/jpeg", cover_blob: Buffer.from("SYNTHETIC_COVER"), status: "ok"
    }; } }; } };
    const context = {
      withGallery: true, createPhotoSetService, createPhotosRuntime, imageLibraryIndexService: owner,
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
    return { counts, raw, counted, owner, lookup, context, service: context.photoSetService, runtime: context.runtime, setPersisted(value) { persisted = value; } };
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
      assert.equal(f.counts.elements, indexed ? 12000 : 612000, "actual production owner getter must index once instead of scanning every image and cover authority lookup");
      assert.equal(f.counts.lookupCalls, indexed ? 51 : 0, "every detail, image and cover authority read uses the injected production capability");
      assert.equal(f.counts.persistedReads, 1); assert.equal(f.counts.imageLists, 32); assert.equal(f.counts.signatures, 12); assert.equal(f.counts.dbReads, 24);
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
        const beforeRelease = f.counts.elements; await f.runtime.stop(); assert.equal(f.counts.releases, 1);
        f.lookup(id); assert.equal(f.counts.elements, beforeRelease + 12000, "successful runtime stop releases the owner lookup");
        const refreshed = f.owner.getIndex({ refresh: true }); assert.equal(refreshed.photoSets.length, 1);
        assert.equal(f.lookup(id), null, "scan refresh cannot retain IDs from an older snapshot");
        const replacement = { ...refreshed, photoSets: f.counted([{ id: "replacement", title: "Replacement" }]) };
        f.setPersisted(replacement); f.owner.invalidate(); assert.equal(f.lookup("replacement").title, "Replacement"); assert.equal(f.lookup(id), null);
        replacement.photoSets = f.counted([{ id: "new-array", title: "New array" }]);
        assert.equal(f.lookup("replacement"), null); assert.equal(f.lookup("new-array").title, "New array");
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
  console.log("photo-set owner lookup: production assembly, invalidation, refresh, stop, duplicate/type/DTO and mutable fallback checks passed");
}
