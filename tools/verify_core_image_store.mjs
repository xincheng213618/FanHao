import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { attachCoreImageStore } from "../src/platform/server/core-image-store.js";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "fanhao-core-images-"));
const corePath = path.join(tempDir, "core.sqlite");
const imagePath = path.join(tempDir, "images.sqlite");

try {
  const db = new DatabaseSync(corePath);
  try {
    db.exec(`
      CREATE TABLE images (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        owner_type TEXT NOT NULL,
        owner_id INTEGER NOT NULL,
        kind TEXT NOT NULL,
        source_type TEXT NOT NULL,
        local_path TEXT,
        remote_url TEXT,
        storage_path TEXT,
        mime TEXT,
        image_blob BLOB,
        width INTEGER,
        height INTEGER,
        byte_size INTEGER,
        sort_order INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'ok',
        error TEXT,
        source TEXT NOT NULL DEFAULT 'migration',
        legacy_table TEXT,
        legacy_key TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      INSERT INTO images (id, owner_type, owner_id, kind, source_type, mime, image_blob, byte_size)
      VALUES (1, 'work', 10, 'cover', 'remote', 'image/jpeg', X'0102', 2);
    `);

    attachCoreImageStore(db, { dbPath: imagePath });
    db.exec("INSERT INTO fanhao_images.images SELECT * FROM main.images");
    assert.equal(db.prepare("SELECT hex(image_blob) AS value FROM images WHERE id = 1").get().value, "0102");

    db.exec("DROP TABLE main.images");
    const resolved = db.prepare("SELECT owner_id, hex(image_blob) AS value FROM images WHERE id = 1").get();
    assert.equal(resolved.owner_id, 10);
    assert.equal(resolved.value, "0102");

    db.prepare(`
      INSERT INTO remote_image_cache (url, url_hash, content_type, image_blob, byte_length, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run("https://example.com/cover.jpg", "hash", "image/jpeg", Buffer.from([3, 4]), 2, "2026-07-18T00:00:00Z");
    assert.equal(db.prepare("SELECT hex(image_blob) AS value FROM fanhao_images.remote_image_cache").get().value, "0304");
  } finally {
    db.close();
  }

  const imageDb = new DatabaseSync(imagePath, { readOnly: true });
  assert.equal(imageDb.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
  assert.equal(imageDb.prepare("SELECT COUNT(*) AS count FROM images").get().count, 1);
  imageDb.close();
  console.log("core image store verification passed");
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
