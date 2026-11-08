import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServerConfig } from "../src/bootstrap/server-config.js";
import { createImageGalleryDbService } from "../src/modules/content-index/server/image-gallery-db-service.js";
import { createImageLibraryService } from "../src/modules/content-index/server/image-library-service.js";
import { createPhotoLibraryStore } from "../src/modules/content-index/server/photo-library-store.js";
import { createPhotoCatalogService } from "../src/modules/photos/server/photo-catalog-service.js";
import { ARCHIVE_IMAGE_INDEXER_VERSION } from "../src/platform/server/archive-image-service.js";
import { removeVerifiedTempDir } from "./verified-temp-cleanup.mjs";

const temp = mkdtempSync(path.join(os.tmpdir(), "fanhao-photo-catalog-seed-"));
const root = path.join(temp, "scan-root");
const env = { ...process.env, FANHAO_LOAD_ENV: "0", FANHAO_PRODUCT: "suite", FANHAO_DATA_DIR: temp, FANHAO_PHOTO_SET_ROOTS: root };
const config = createServerConfig({ env });
const dbService = createImageGalleryDbService({ dbPath: config.IMAGE_GALLERY_DB_PATH, ensureDataDir() {} });
try {
  const db = dbService.getDb();
  const updatedAt = "2026-10-05T01:02:03.456Z";
  const row = (title, sourceRoot = root) => {
    const relativePath = path.join("Studio", "Set", `${title}.rar`);
    const archivePath = path.join(sourceRoot, relativePath);
    return { id: `ps_${Buffer.from(archivePath).toString("base64url")}`, type: "photoSet", title, sourceRoot, relativePath,
      rootLabel: "scan-root", category: "Studio", updatedAt, archiveExt: "rar", size: 9000, personName: "档名线索" };
  };
  const sequence = row("包 NO.008 [10P1V-2GB]");
  const issue = row("包 VOL.023 [5P／1G]");
  const store = createPhotoLibraryStore({ getDb: dbService.getDb, archiveExts: config.ARCHIVE_EXTS, photoSetRoots: config.PHOTO_SET_ROOTS,
    project: createImageLibraryService({ photoCollectionRootValue: config.PHOTO_COLLECTION_ROOT_VALUE,
      photoSetService: { coverUrl: () => "" } }).projectPhotoIndex });
  store.publish({ scannedAt: updatedAt, roots: [], photoSets: [sequence, issue, row("unconfigured", path.join(temp, "other-root"))] });

  const measuredPath = path.join(root, issue.relativePath);
  const mtime = Date.parse(updatedAt) + 0.25;
  db.prepare(`INSERT INTO photo_set_image_indexes
    (archive_path,archive_identity,archive_size,archive_mtime_ms,image_count,images_json,indexer_version,indexed_at,updated_at)
    VALUES (?,?,?,?,?,'[]',?,?,?)`).run(measuredPath, JSON.stringify([measuredPath, issue.size, mtime, "1", "2"]), issue.size,
    mtime, 6, ARCHIVE_IMAGE_INDEXER_VERSION, updatedAt, updatedAt);

  const script = fileURLToPath(new URL("../tools/seed_photo_catalog.mjs", import.meta.url));
  function run(...args) {
    const result = spawnSync(process.execPath, [script, ...args], { env, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim().split(/\r?\n/).map(line => JSON.parse(line));
  }
  const [scan] = run();
  assert.deepEqual([scan.candidates, scan.invalid, scan.duplicates, scan.folderCollections], [2, 1, 0, 1]);
  assert.deepEqual([scan.measuredArchives, scan.measuredImages, scan.declaredImages, scan.declaredVideos], [1, 6, 15, 1]);
  assert.equal(db.prepare("SELECT 1 FROM sqlite_schema WHERE name='photo_catalog_works'").get(), undefined);

  const [, committed] = run("--apply");
  assert.deepEqual([committed.inserted, committed.skipped, committed.works, committed.archives, committed.categoryCount], [2, 0, 2, 2, 1]);
  assert.deepEqual([committed.measuredImages, committed.declaredImages, committed.declaredVideos], [6, 15, 1]);
  const catalog = createPhotoCatalogService({ getImageGalleryDb: () => db, photoSetById: () => null });
  const saved = catalog.detail(sequence.id);
  assert.equal(saved.issueCode, "");
  assert.equal(saved.archives[0].issueHint, "NO.008");
  assert.equal(saved.archives[0].personHint, "档名线索");
  assert.deepEqual(saved.people, []);
  assert.equal(catalog.detail(issue.id).issueCode, "VOL.023");
  assert.equal(catalog.list({ category: "Studio" }).total, 2);

  const [, replay] = run("--apply");
  assert.deepEqual([replay.inserted, replay.skipped, replay.works], [0, 2, 2]);
  assert.equal(catalog.detail(sequence.id).id, saved.id);
  console.log("photo-catalog seed: configured scan, bounded idempotent insert, classification and measured versus declared counts passed");
} finally {
  dbService.close();
  removeVerifiedTempDir(temp);
}
