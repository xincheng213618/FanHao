import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createImageGalleryDbService } from "../src/modules/content-index/server/image-gallery-db-service.js";
import { removeVerifiedTempDir } from "./verified-temp-cleanup.mjs";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "fanhao-gallery-db-"));
const dbPath = path.join(tempDir, "image-gallery.sqlite");
const service = createImageGalleryDbService({
  dbPath,
  ensureDataDir: () => fs.mkdirSync(tempDir, { recursive: true })
});

try {
  const db = service.getDb();
  const tableNames = new Set(
    db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => row.name)
  );
  for (const table of ["photo_set_covers", "photo_set_image_indexes", "tv_series_metadata", "movie_metadata", "gallery_media_covers"]) {
    assert(tableNames.has(table), `missing table: ${table}`);
  }

  const requiredColumns = {
    photo_set_covers: ["album_id", "archive_path", "cover_blob", "generator_version", "updated_at"],
    photo_set_image_indexes: ["archive_path", "images_json", "indexer_version", "updated_at"],
    tv_series_metadata: ["series_key", "douban_id", "cover_blob", "status", "updated_at"],
    movie_metadata: ["media_id", "douban_id", "cover_blob", "status", "updated_at"],
    gallery_media_covers: ["media_id", "source_path", "cover_blob", "generator_version", "updated_at"]
  };
  for (const [table, expected] of Object.entries(requiredColumns)) {
    const columns = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name));
    for (const column of expected) assert(columns.has(column), `missing column: ${table}.${column}`);
  }

  assert.strictEqual(service.getDb(), db, "gallery DB service should reuse its connection");
  service.close();
  const legacyDb = new DatabaseSync(dbPath);
  legacyDb.exec("DROP TABLE photo_set_image_indexes; CREATE TABLE photo_set_image_indexes (archive_path TEXT PRIMARY KEY, images_json TEXT NOT NULL, updated_at TEXT NOT NULL);");
  legacyDb.close();
  const migratedDb = service.getDb();
  const migratedColumns = new Set(migratedDb.prepare("PRAGMA table_info(photo_set_image_indexes)").all().map((row) => row.name));
  assert(migratedColumns.has("indexer_version"), "old persisted image indexes must migrate the indexer version column");
  console.log("image-gallery-db: ok");
} finally {
  service.close();
  removeVerifiedTempDir(tempDir);
}
