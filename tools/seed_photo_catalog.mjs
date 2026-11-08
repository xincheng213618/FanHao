import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as wait } from "node:timers/promises";
import { createServerConfig } from "../src/bootstrap/server-config.js";
import { createImageLibraryService } from "../src/modules/content-index/server/image-library-service.js";
import { createPhotoLibraryStore } from "../src/modules/content-index/server/photo-library-store.js";
import { scannedPhotoCatalogCollection } from "../src/modules/photos/server/photo-catalog-intake.js";
import { photoIssueCode } from "../src/modules/photos/server/photo-catalog-matching.js";
import { createPhotoCatalogService } from "../src/modules/photos/server/photo-catalog-service.js";
import { photoTitleMediaDeclarations } from "../src/modules/photos/server/photo-catalog-source.js";
import { ARCHIVE_IMAGE_INDEXER_VERSION } from "../src/platform/server/archive-image-service.js";
import { safeChildPath } from "../src/platform/server/request-io.js";

const flags = process.argv.slice(2);
if (flags.length > 1 || (flags.length && flags[0] !== "--apply")) throw new Error("Usage: node tools/seed_photo_catalog.mjs [--apply]");
const apply = flags.includes("--apply");
const config = createServerConfig();
const { ARCHIVE_EXTS, IMAGE_GALLERY_DB_PATH, PHOTO_COLLECTION_ROOT_VALUE, PHOTO_SET_ROOTS } = config;
if (config.PRODUCT.id !== "suite") throw new Error("The scan must belong to the FanHao suite product");

const index = readPublishedScan();
if (!index || !Number.isFinite(Date.parse(index.scannedAt))) {
  throw new Error("No compatible photo snapshot is published in SQLite. Refresh the gallery index first.");
}

const imageLibrary = createImageLibraryService({ photoCollectionRootValue: PHOTO_COLLECTION_ROOT_VALUE });
const configuredRoots = new Set(PHOTO_SET_ROOTS.map(root => path.resolve(root)));
const archiveIds = new Set();
const collectionCache = new Map();
const rows = [];
const summary = { scannedAt: index.scannedAt, scanEntries: index.photoSets.length, invalid: 0, duplicates: 0,
  candidates: 0, archiveBytes: 0, folderCollections: 0, archiveIssueHints: 0, archiveIssueCodes: 0, personHints: 0,
  measuredArchives: 0, measuredImages: 0, declaredImageArchives: 0, declaredImages: 0,
  declaredVideoArchives: 0, declaredVideos: 0, alreadyRegistered: 0 };

for (const album of index.photoSets) {
  const { id, title, category, relativePath, rootLabel, archiveExt, size, updatedAt, coverUrl, personName } = album;
  const root = typeof album.sourceRoot === "string" && path.resolve(album.sourceRoot);
  const archivePath = root && configuredRoots.has(root) && typeof relativePath === "string" && relativePath &&
    !path.isAbsolute(relativePath) && safeChildPath(root, relativePath);
  const expectedId = archivePath && `ps_${Buffer.from(archivePath).toString("base64url")}`;
  if (!archivePath || id !== expectedId || !ARCHIVE_EXTS.has(path.extname(archivePath).toLowerCase()) ||
      typeof title !== "string" || !title.trim() || !Number.isSafeInteger(size) || size < 0 || !Number.isFinite(Date.parse(updatedAt))) {
    summary.invalid += 1;
    continue;
  }
  if (archiveIds.has(id)) {
    summary.duplicates += 1;
    continue;
  }
  archiveIds.add(id);
  const description = imageLibrary.describePhotoCollection(album);
  let collection = collectionCache.get(description.key);
  if (!collection) {
    collection = scannedPhotoCatalogCollection(description);
    collectionCache.set(description.key, collection);
  }
  const issueHint = photoIssueCode(title);
  // Historical imports can use NO.* for download order. Keep that in archive hints only.
  const suggestedIssueCode = issueHint.startsWith("NO.") ? "" : issueHint;
  const declarations = photoTitleMediaDeclarations(title);
  const archive = { id, title, category, relativePath, rootLabel, archiveExt, size, modifiedAt: updatedAt, coverUrl, archivePath, ...declarations,
    archiveIdentity: album.archiveIdentity || "", issueHint, personHint: personName || "" };
  rows.push({ archive, collection, suggestedIssueCode });
  summary.archiveBytes += size;
  if (issueHint) summary.archiveIssueHints += 1;
  if (suggestedIssueCode) summary.archiveIssueCodes += 1;
  if (personName) summary.personHints += 1;
  if (declarations.declaredImageCount != null) {
    summary.declaredImageArchives += 1;
    summary.declaredImages += declarations.declaredImageCount;
  }
  if (declarations.declaredVideoCount != null) {
    summary.declaredVideoArchives += 1;
    summary.declaredVideos += declarations.declaredVideoCount;
  }
}

if (!rows.length) throw new Error("The existing scan contains no eligible photo archives");
summary.candidates = rows.length;
summary.folderCollections = collectionCache.size;

function hasTable(db, name) {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name=?").get(name));
}

function readPublishedScan() {
  const db = new DatabaseSync(IMAGE_GALLERY_DB_PATH, { readOnly: true });
  try {
    db.exec("PRAGMA busy_timeout = 5000");
    if (!hasTable(db, "photo_library_snapshot")) return null;
    return createPhotoLibraryStore({ getDb: () => db, archiveExts: ARCHIVE_EXTS, photoSetRoots: PHOTO_SET_ROOTS }).index();
  } finally {
    db.close();
  }
}

function indexedMeasurements(db) {
  if (!hasTable(db, "photo_set_image_indexes")) return new Map();
  return new Map(db.prepare(`SELECT archive_path,archive_identity,archive_size,archive_mtime_ms,image_count
    FROM photo_set_image_indexes WHERE indexer_version=? AND archive_identity IS NOT NULL AND image_count>=0`)
    .all(ARCHIVE_IMAGE_INDEXER_VERSION).map(row => [row.archive_path, row]));
}

const db = new DatabaseSync(IMAGE_GALLERY_DB_PATH, { readOnly: !apply });
try {
  db.exec("PRAGMA busy_timeout = 5000");
  const indexed = indexedMeasurements(db);
  const registered = hasTable(db, "photo_catalog_archives")
    ? new Set(db.prepare("SELECT id FROM photo_catalog_archives").all().map(row => row.id)) : new Set();
  for (const { archive } of rows) {
    if (registered.has(archive.id)) summary.alreadyRegistered += 1;
    const measurement = indexed.get(archive.archivePath);
    if (!measurement || measurement.archive_size !== archive.size || Math.trunc(measurement.archive_mtime_ms) !== Date.parse(archive.modifiedAt)
      || (archive.archiveIdentity && archive.archiveIdentity !== measurement.archive_identity)) continue;
    let signature;
    try { signature = JSON.parse(measurement.archive_identity); } catch { continue; }
    if (!Array.isArray(signature) || signature[0] !== archive.archivePath || signature[1] !== archive.size ||
        Math.trunc(signature[2]) !== Date.parse(archive.modifiedAt)) continue;
    archive.archiveIdentity = measurement.archive_identity;
    summary.measuredArchives += 1;
    summary.measuredImages += measurement.image_count;
  }
  console.log(JSON.stringify({ phase: "scan", ...summary }));
  if (apply) {
    const catalog = createPhotoCatalogService({ getImageGalleryDb: () => db, photoSetById: () => null });
    let inserted = 0, skipped = 0;
    for (let offset = 0; offset < rows.length; offset += 250) {
      const result = catalog.seedScannedArchives(rows.slice(offset, offset + 250));
      inserted += result.inserted;
      skipped += result.skipped;
      if ((offset + 250) % 10_000 === 0) console.log(JSON.stringify({ phase: "batch", inserted, skipped }));
      await wait(12);
    }
    const { categories, ...totals } = catalog.stats();
    console.log(JSON.stringify({ phase: "committed", inserted, skipped, categoryCount: categories.length, ...totals }));
  }
} finally {
  db.close();
}
