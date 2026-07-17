import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createArchiveImageService } from "../src/platform/server/archive-image-service.js";

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
  const service = createArchiveImageService({
    archiveImageExts: new Set([".jpg"]),
    coverBoxSize: 480,
    coverMaxBytes: 1024 * 1024,
    ffmpegPath: process.execPath,
    getImageGalleryDb: () => ({
      prepare: () => ({ get: () => null, run: () => ({ changes: 1 }) })
    }),
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
        if (path.resolve(value) === path.resolve(archivePath)) archiveStatCount += 1;
        return fs.statSync(value);
      } catch {
        return null;
      }
    },
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
  assert.equal(countInvocations(`${archivePath}.list.count`), 1, "concurrent archive lists must share one subprocess");

  await service.archiveImagesPayload(archivePath);
  assert.equal(countInvocations(`${archivePath}.list.count`), 1, "fresh archive lists must reuse the memory cache");
  assert.equal(archiveStatCount, 1, "one reading burst must reuse the archive signature instead of blocking on repeated stats");

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
  assert.equal(archiveStatCount, 1, "serving a member must reuse the signature already resolved for its image list");

  console.log("archive-image-service: ok");
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}

function countInvocations(filePath) {
  return fs.readFileSync(filePath, "utf8").trim().split(/\r?\n/).filter(Boolean).length;
}
