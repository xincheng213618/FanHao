import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createCoreDbService } from "../src/modules/fanhao/server/library/core-db-service.js";
import { readTableStampRow } from "../src/modules/fanhao/server/library/table-stamp-query.js";
import { createManualCoverStateService } from "../src/modules/fanhao/server/works/manual-cover-state-service.js";
import { attachCoreImageStore } from "../src/platform/server/core-image-store.js";
import { removeVerifiedTempDir } from "./verified-temp-cleanup.mjs";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "fanhao-core-images-"));
const corePath = path.join(tempDir, "core.sqlite");
const imagePath = path.join(tempDir, "images.sqlite");

try {
  const db = new DatabaseSync(corePath);
  try {
    db.exec(`
      CREATE TABLE Images (
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
      INSERT INTO Images (id, owner_type, owner_id, kind, source_type, mime, image_blob, byte_size)
      VALUES (1, 'work', 10, 'cover', 'remote', 'image/jpeg', X'0102', 2);
      CREATE TABLE Local_Image_Cache (file_id TEXT PRIMARY KEY);
      CREATE TABLE Remote_Image_Cache (url TEXT PRIMARY KEY);
    `);

    attachCoreImageStore(db, { dbPath: imagePath, allowLegacyMainTables: true });
    db.exec("INSERT INTO fanhao_images.images SELECT * FROM main.images");
    assert.equal(db.prepare("SELECT hex(image_blob) AS value FROM fanhao_images.images WHERE id = 1").get().value, "0102");
    assert.throws(
      () => attachCoreImageStore(db, { dbPath: imagePath }),
      /Legacy image tables in main would shadow fanhao_images: images, local_image_cache, remote_image_cache/
    );

    db.exec("DROP TABLE main.images; DROP TABLE main.local_image_cache; DROP TABLE main.remote_image_cache;");
    assert.equal(attachCoreImageStore(db, { dbPath: imagePath }), true);
    const resolved = db.prepare("SELECT owner_id, hex(image_blob) AS value FROM fanhao_images.images WHERE id = 1").get();
    assert.equal(resolved.owner_id, 10);
    assert.equal(resolved.value, "0102");

    db.prepare(`
      INSERT INTO fanhao_images.remote_image_cache (url, url_hash, content_type, image_blob, byte_length, updated_at)
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
  verifyCoreDbInitializationRetry(tempDir);
  verifyManualAvatarRollback(tempDir);
  console.log("core image store verification passed");
} finally {
  removeVerifiedTempDir(tempDir);
}

function verifyCoreDbInitializationRetry(directory) {
  const corePath = path.join(directory, "retry-core.sqlite");
  const imagePath = path.join(directory, "retry-images.sqlite");
  const fixture = new DatabaseSync(corePath);
  fixture.exec(`
    CREATE TABLE works (
      id INTEGER PRIMARY KEY,
      status TEXT,
      code_search TEXT,
      updated_at TEXT
    );
    CREATE TABLE work_people (updated_at TEXT);
    CREATE TABLE collection_items (updated_at TEXT);
    CREATE TABLE local_works (id INTEGER PRIMARY KEY);
    CREATE TABLE person_external_refs (id INTEGER PRIMARY KEY);
    CREATE TABLE work_external_refs (id INTEGER PRIMARY KEY);
    CREATE TABLE person_aliases (id INTEGER PRIMARY KEY);
    CREATE TABLE people (id INTEGER PRIMARY KEY, updated_at TEXT);
    CREATE TABLE idx_local_files_path (id INTEGER PRIMARY KEY);
  `);
  fixture.close();

  let opened = 0;
  let closed = 0;
  const service = createCoreDbService({
    createDatabase(filePath) {
      opened += 1;
      const connection = new DatabaseSync(filePath);
      return new Proxy(connection, {
        get(target, property) {
          if (property === "close") {
            return () => {
              closed += 1;
              return target.close();
            };
          }
          const value = Reflect.get(target, property, target);
          return typeof value === "function" ? value.bind(target) : value;
        }
      });
    },
    dbPath: corePath,
    ensureDataDir() {},
    imageDbPath: imagePath,
    refreshTableStampRow: async () => null,
    warn() {}
  });

  assert.throws(() => service.tableDataStamp("actor_profiles"), /idx_local_files_path|already a table/i);
  assert.equal(opened, 1);
  assert.equal(closed, 1, "a failed schema migration must close its connection");

  const rolledBack = new DatabaseSync(corePath);
  const columnNames = (table) => rolledBack.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name);
  assert.equal(columnNames("people").includes("gender"), false, "a late DDL failure must roll back earlier people migrations");
  for (const column of ["has_magnet", "is_streamable", "has_subtitles", "javdb_tags_json"]) {
    assert.equal(columnNames("works").includes(column), false, `a late DDL failure must roll back works.${column}`);
  }
  for (const table of ["person_external_refs", "work_external_refs", "person_aliases"]) {
    assert.equal(columnNames(table).includes("updated_at"), false, `a late DDL failure must roll back ${table}.updated_at`);
  }
  assert.equal(rolledBack.prepare("SELECT type FROM sqlite_schema WHERE name = 'local_files'").get(), undefined, "a late DDL failure must roll back local_files creation");
  for (const index of [
    "idx_works_updated_at",
    "idx_works_status_code_search",
    "idx_work_people_updated_at",
    "idx_people_updated_at",
    "idx_person_external_refs_updated_at",
    "idx_work_external_refs_updated_at",
    "idx_person_aliases_updated_at",
    "idx_collection_items_updated_at",
    "idx_local_files_work",
    "idx_local_files_local_work"
  ]) {
    assert.equal(rolledBack.prepare("SELECT type FROM sqlite_schema WHERE type = 'index' AND name = ?").get(index), undefined, `a late DDL failure must roll back ${index}`);
  }
  assert.equal(rolledBack.prepare("SELECT type FROM sqlite_schema WHERE name = 'idx_local_files_path'").get().type, "table", "the pre-existing failure fixture must survive rollback");
  assert.equal(rolledBack.prepare("PRAGMA integrity_check").get().integrity_check, "ok", "a rolled-back schema migration must leave the core database healthy");
  rolledBack.exec("DROP TABLE idx_local_files_path");
  rolledBack.close();

  const stamp = service.tableDataStamp("actor_profiles");
  assert.equal(stamp.includes("unavailable"), false, "a retry must not reuse a failed stamp fallback");
  assert.equal(opened, 2, "a failed initialization must be retried with a new connection");
  const retried = service.getDb();
  assert.equal(service.getDb(), retried, "only a fully initialized connection may be cached");
  assert.equal(retried.isTransaction, false, "schema initialization must release its savepoint before publishing the connection");
  assert.equal(retried.prepare("SELECT type FROM sqlite_schema WHERE name = 'local_files'").get().type, "table", "a repaired retry must create local_files");
  assert.equal(retried.prepare("SELECT type FROM sqlite_schema WHERE name = 'idx_local_files_path'").get().type, "index", "a repaired retry must complete the final core index");
  retried.close();
  assert.equal(closed, 2);
}

function verifyManualAvatarRollback(directory) {
  const corePath = path.join(directory, "avatar-core.sqlite");
  const imagePath = path.join(directory, "avatar-images.sqlite");
  const db = new DatabaseSync(corePath);
  try {
    attachCoreImageStore(db, { dbPath: imagePath });
    db.exec(`
      INSERT INTO fanhao_images.images (
        id, owner_type, owner_id, kind, source_type, mime, image_blob, byte_size,
        source, legacy_table, legacy_key, created_at, updated_at
      ) VALUES (
        7, 'person', 42, 'avatar', 'local', 'image/jpeg', X'010203', 3,
        'manual_upload', 'manual_person_avatar', 'old-avatar', '2026-08-11T00:00:00Z', '2026-08-11T00:00:00Z'
      );
      CREATE TRIGGER fanhao_images.fail_new_manual_avatar
      BEFORE INSERT ON images
      WHEN NEW.legacy_key = 'new-avatar'
      BEGIN
        SELECT RAISE(ABORT, 'forced avatar insert failure');
      END;
      CREATE TABLE main.images (
        id INTEGER PRIMARY KEY,
        owner_type TEXT,
        owner_id INTEGER,
        kind TEXT,
        source TEXT
      );
      INSERT INTO main.images VALUES (99, 'person', 42, 'avatar', 'manual_upload');
    `);
    assert.equal(readTableStampRow(db, "images").row_count, 1);
    assert.equal(readTableStampRow(db, "work_covers").row_count, 1);
    assert.equal(readTableStampRow(db, "local_image_cache").row_count, 0);
    assert.equal(readTableStampRow(db, "remote_image_cache").row_count, 0);

    let invalidations = 0;
    const service = createManualCoverStateService({
      getCoreDb: () => db,
      invalidateActorProfiles: () => {
        invalidations += 1;
      }
    });
    assert.throws(
      () => service.replaceManualPersonAvatar(42, {
        sourceType: "local",
        localPath: "",
        remoteUrl: "",
        mime: "image/png",
        blob: Buffer.from([9, 8, 7]),
        byteSize: 3,
        source: "manual_upload",
        legacyKey: "new-avatar",
        now: "2026-08-11T01:00:00Z"
      }),
      /forced avatar insert failure/
    );

    const oldAvatar = db.prepare(`
      SELECT id, hex(image_blob) AS blob, source, legacy_key
      FROM fanhao_images.images
      WHERE owner_type = 'person' AND owner_id = 42
    `).get();
    assert.deepEqual({ ...oldAvatar }, {
      id: 7,
      blob: "010203",
      source: "manual_upload",
      legacy_key: "old-avatar"
    });
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM fanhao_images.images WHERE owner_type = 'person' AND owner_id = 42").get().count, 1);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM fanhao_images.images WHERE legacy_key = 'new-avatar'").get().count, 0);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM main.images WHERE id = 99").get().count, 1);
    assert.equal(invalidations, 0, "a rolled-back replacement must not invalidate committed profile state");
  } finally {
    db.close();
  }
}
