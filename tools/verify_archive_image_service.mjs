import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { ARCHIVE_IMAGE_INDEXER_VERSION, createArchiveImageService } from "../src/platform/server/archive-image-service.js";
import { removeVerifiedTempDir } from "./verified-temp-cleanup.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixture = path.join(root, "tools", "fixtures", "archive_image_helper_fixture.mjs");
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "fanhao-archive-service-"));

try {
  const archivePath = path.join(tempDir, "sample.zip");
  const cachePath = path.join(tempDir, "cache", "cover.jpg");
  fs.writeFileSync(archivePath, "fixture");
  const imageReaderCacheService = {
    rootDir: path.join(tempDir, "reader-cache"),
    scheduleCleanup() {},
    touch() {}
  };
  let archiveStatCount = 0;
  let archiveSyncStatCount = 0;
  let persistedIndex = {
    archive_path: archivePath,
    archive_size: fs.statSync(archivePath).size,
    archive_mtime_ms: Math.floor(fs.statSync(archivePath).mtimeMs),
    image_count: 1,
    images_json: JSON.stringify([{ path: "stale.jpg" }]),
    indexer_version: ARCHIVE_IMAGE_INDEXER_VERSION - 1
  };
  const database = {
    prepare: (sql) => ({
      get: () => sql.startsWith("SELECT") ? persistedIndex : null,
      run: (...args) => {
        if (sql.includes("INSERT INTO photo_set_image_indexes")) persistedIndex = {
          archive_path: args[0], archive_size: args[1], archive_mtime_ms: args[2], image_count: args[3],
          images_json: args[4], indexer_version: args[5], archive_identity: args[8]
        };
        return { changes: 1 };
      }
    })
  };
  const service = createArchiveImageService({
    archiveImageExts: new Set([".jpg"]),
    coverBoxSize: 480,
    coverMaxBytes: 1024 * 1024,
    ffmpegPath: process.execPath,
    getImageGalleryDb: () => database,
    helperPath: fixture,
    imageReaderCacheService,
    listCacheTtlMs: 60_000,
    signatureCacheTtlMs: 60_000,
    mimeTypes: { ".jpg": "image/jpeg" },
    normalizeExt: (value) => path.extname(String(value || "")).toLowerCase(),
    notFound() {},
    projectRoot: root,
    pythonPath: process.execPath,
    safeStat: (value) => {
      try {
        if (path.resolve(value) === path.resolve(archivePath)) archiveSyncStatCount += 1;
        return fs.statSync(value);
      } catch {
        return null;
      }
    },
    statFile: async value => { if (path.resolve(value) === path.resolve(archivePath)) archiveStatCount++; return fs.promises.stat(value); },
    sendText() {},
    serveInlineFile: () => true,
    warn() {}
  });

  let eventLoopReleased = false;
  const loopProbe = new Promise((resolve) => setTimeout(() => {
    eventLoopReleased = true;
    resolve();
  }, 20));
  const [left, right] = await Promise.all([
    service.archiveImagesPayload(archivePath),
    service.archiveImagesPayload(archivePath)
  ]);
  await loopProbe;
  assert(eventLoopReleased, "archive helper execution must not block the Node event loop");
  assert.deepEqual(left, right);
  assert.equal(left.images[0]?.path, "cover.jpg");
  assert.equal(persistedIndex.indexer_version, ARCHIVE_IMAGE_INDEXER_VERSION, "an older archive indexer version must re-list and replace its persisted row");
  assert.equal(countInvocations(`${archivePath}.list.count`), 1, "concurrent archive lists must share one subprocess");

  await service.archiveImagesPayload(archivePath);
  assert.equal(countInvocations(`${archivePath}.list.count`), 1, "fresh archive lists must reuse the memory cache");
  assert.equal(archiveStatCount, 4, "coalesced cold list and warm list must each check physical identity before and after loading");
  assert.equal(archiveSyncStatCount, 0, "archive identity validation must not block the main thread on sync stat");

  await Promise.all([
    service.extractArchiveMemberToCache(archivePath, "cover.jpg", cachePath),
    service.extractArchiveMemberToCache(archivePath, "cover.jpg", cachePath)
  ]);
  assert.equal(countInvocations(`${archivePath}.extract.count`), 1, "concurrent member extractions must share one subprocess");
  assert.equal(fs.readFileSync(cachePath, "utf8"), "cover.jpg:sample.zip");

  await service.serveArchiveMemberImage({}, {
    sourceType: "photo-set",
    archivePath,
    memberPath: "cover.jpg",
    contentType: "image/jpeg"
  });
  assert.equal(archiveStatCount, 9, "member extraction and serving must recheck physical archive identity");

  console.log("archive-image-service: ok");
} finally {
  if (process.platform === "win32") {
    const resolved = fs.realpathSync(tempDir), temporary = fs.realpathSync(os.tmpdir());
    assert.equal(path.dirname(resolved).toLowerCase(), temporary.toLowerCase());
    assert.ok(path.basename(resolved).startsWith("fanhao-archive-service-"));
    const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "$ErrorActionPreference='Stop'; $target=(Resolve-Path -LiteralPath $env:FANHAO_ARCHIVE_SERVICE_CLEANUP).ProviderPath; $temporary=(Resolve-Path -LiteralPath ([IO.Path]::GetTempPath())).ProviderPath.TrimEnd('\\'); if (-not [string]::Equals([IO.Path]::GetDirectoryName($target),$temporary,[StringComparison]::OrdinalIgnoreCase)) { throw 'Invalid fixture parent' }; if (-not [IO.Path]::GetFileName($target).StartsWith('fanhao-archive-service-')) { throw 'Invalid fixture name' }; Remove-Item -LiteralPath $target -Recurse -Force"], { env: { ...process.env, FANHAO_ARCHIVE_SERVICE_CLEANUP: resolved }, encoding: "utf8", windowsHide: true });
    assert.equal(result.status, 0, result.stderr);
  } else removeVerifiedTempDir(tempDir);
}

function countInvocations(filePath) {
  return fs.readFileSync(filePath, "utf8").trim().split(/\r?\n/).filter(Boolean).length;
}
