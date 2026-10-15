import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createImageGalleryDbService } from "../src/modules/content-index/server/image-gallery-db-service.js";
import {
  GALLERY_METADATA_CLOCK_TABLE, GALLERY_METADATA_CLOCK_TRIGGERS,
  GALLERY_METADATA_CLOCK_CONTRACT_SQL, ensureGalleryMetadataClocks, trustedGalleryMetadataClockKinds
} from "../lib/gallery-metadata-revision.js";
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
  assert.equal(trustedGalleryMetadataClockKinds(db.prepare(GALLERY_METADATA_CLOCK_CONTRACT_SQL).all()).size, 2);
  const clock = kind => db.prepare(`SELECT epoch, revision FROM ${GALLERY_METADATA_CLOCK_TABLE} WHERE kind=?`).get(kind);
  const initialMovie = clock("movie"), initialTv = clock("tv");
  db.prepare("INSERT INTO movie_metadata(media_id,movie_title,updated_at) VALUES('synthetic-movie','private','same')").run();
  db.prepare("UPDATE movie_metadata SET rating=8 WHERE media_id='synthetic-movie'").run();
  db.prepare("DELETE FROM movie_metadata WHERE media_id='synthetic-movie'").run();
  assert.equal(clock("movie").revision, initialMovie.revision + 3, "insert/update/delete each advances the movie clock");
  assert.deepEqual(clock("tv"), initialTv, "movie changes cannot advance the TV clock");
  db.prepare("INSERT INTO tv_series_metadata(series_key,series_name,updated_at) VALUES('synthetic-tv','private','same')").run();
  db.prepare("UPDATE tv_series_metadata SET rating=8 WHERE series_key='synthetic-tv'").run();
  db.prepare("DELETE FROM tv_series_metadata WHERE series_key='synthetic-tv'").run();
  assert.equal(clock("tv").revision, initialTv.revision + 3);
  const committedClocks = [clock("movie"), clock("tv")];
  db.exec("BEGIN");
  db.prepare("INSERT INTO movie_metadata(media_id,movie_title,updated_at) VALUES('rolled-back','private','same')").run();
  db.exec("ROLLBACK");
  assert.deepEqual([clock("movie"), clock("tv")], committedClocks, "clocks and metadata commit or roll back together");
  db.prepare("INSERT INTO gallery_media_covers(media_id,source_path,updated_at) VALUES('cover-only','private.mp4','same')").run();
  assert.deepEqual([clock("movie"), clock("tv")], committedClocks);
  service.close();
  const legacyDb = new DatabaseSync(dbPath);
  legacyDb.exec("DROP TABLE photo_set_image_indexes; CREATE TABLE photo_set_image_indexes (archive_path TEXT PRIMARY KEY, images_json TEXT NOT NULL, updated_at TEXT NOT NULL);");
  legacyDb.close();
  const migratedDb = service.getDb();
  const migratedColumns = new Set(migratedDb.prepare("PRAGMA table_info(photo_set_image_indexes)").all().map((row) => row.name));
  assert(migratedColumns.has("indexer_version"), "old persisted image indexes must migrate the indexer version column");
  assert.deepEqual(["movie", "tv"].map(kind => migratedDb.prepare(`SELECT epoch, revision FROM ${GALLERY_METADATA_CLOCK_TABLE} WHERE kind=?`).get(kind)), committedClocks,
    "reopening and additive migrations preserve the installed clock epochs and revisions");
  service.close();
  const damagedLegacy = new DatabaseSync(dbPath);
  try {
    damagedLegacy.exec(`DROP TABLE ${GALLERY_METADATA_CLOCK_TABLE}; CREATE TABLE ${GALLERY_METADATA_CLOCK_TABLE}(kind TEXT PRIMARY KEY)`);
    assert.equal(damagedLegacy.prepare("SELECT count(*) n FROM sqlite_schema WHERE name LIKE 'fanhao_metadata_revision_%'").get().n, 6,
      "the control really retains formerly valid owned triggers pointing at a malformed table");
  } finally { damagedLegacy.close(); }
  const compatibleDb = service.getDb();
  assert.equal(compatibleDb.prepare("SELECT count(*) n FROM sqlite_schema WHERE name LIKE 'fanhao_metadata_revision_%'").get().n, 0);
  compatibleDb.exec("INSERT INTO movie_metadata(media_id,movie_title,updated_at) VALUES('legacy-still-writable','private','same'); UPDATE movie_metadata SET rating=9 WHERE media_id='legacy-still-writable'; DELETE FROM movie_metadata WHERE media_id='legacy-still-writable'");
  compatibleDb.exec("INSERT INTO tv_series_metadata(series_key,series_name,updated_at) VALUES('legacy-tv-writable','private','same'); UPDATE tv_series_metadata SET rating=9 WHERE series_key='legacy-tv-writable'; DELETE FROM tv_series_metadata WHERE series_key='legacy-tv-writable'");
  verifyOptionalClockFailures();
  verifyExistingMetadataInstallation();
  console.log("image-gallery-db: ok");
} finally {
  service.close();
  removeVerifiedTempDir(tempDir);
}

function privateMetadataDb() {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE movie_metadata(media_id TEXT PRIMARY KEY, rating REAL); CREATE TABLE tv_series_metadata(series_key TEXT PRIMARY KEY, rating REAL)");
  return db;
}

function verifyOptionalClockFailures() {
  const atomic = privateMetadataDb();
  try {
    assert.equal(ensureGalleryMetadataClocks({ prepare: sql => atomic.prepare(sql), exec(sql) {
      if (sql.includes("CREATE TRIGGER IF NOT EXISTS fanhao_metadata_revision_tv_update")) throw new Error("controlled partial installation failure");
      return atomic.exec(sql);
    } }), false);
    assert.equal(atomic.prepare("SELECT count(*) n FROM sqlite_schema WHERE name LIKE 'fanhao_metadata_revision_%' OR name=?").get(GALLERY_METADATA_CLOCK_TABLE).n, 0,
      "a failed install leaves neither a partial clock table nor partial triggers");
    atomic.exec("INSERT INTO movie_metadata VALUES('still-writable',8); UPDATE movie_metadata SET rating=9; DELETE FROM movie_metadata");
  } finally { atomic.close(); }

  const malformed = privateMetadataDb();
  try {
    malformed.exec(`CREATE TABLE ${GALLERY_METADATA_CLOCK_TABLE}(kind TEXT PRIMARY KEY)`);
    const owned = GALLERY_METADATA_CLOCK_TRIGGERS.find(trigger => trigger.kind === "movie" && trigger.name.endsWith("_insert"));
    const foreign = GALLERY_METADATA_CLOCK_TRIGGERS.find(trigger => trigger.kind === "movie" && trigger.name.endsWith("_update"));
    malformed.exec(owned.sql);
    malformed.exec(`CREATE TRIGGER ${foreign.name} AFTER UPDATE ON movie_metadata BEGIN SELECT 1; END`);
    const foreignSql = malformed.prepare("SELECT sql FROM sqlite_schema WHERE name=?").get(foreign.name).sql;
    assert.equal(ensureGalleryMetadataClocks(malformed), false);
    assert.equal(malformed.prepare("SELECT sql FROM sqlite_schema WHERE name=?").get(owned.name), undefined,
      "only an exact owned contract may be removed when a malformed clock would break original writes");
    assert.equal(malformed.prepare("SELECT sql FROM sqlite_schema WHERE name=?").get(foreign.name).sql, foreignSql,
      "an external trigger with the same reserved name remains untouched");
    malformed.exec("INSERT INTO movie_metadata VALUES('legacy-writable',8); UPDATE movie_metadata SET rating=9; DELETE FROM movie_metadata");
  } finally { malformed.close(); }

  const collision = privateMetadataDb();
  try {
    const foreign = GALLERY_METADATA_CLOCK_TRIGGERS[0];
    collision.exec(`CREATE TRIGGER ${foreign.name} AFTER INSERT ON movie_metadata BEGIN SELECT 1; END`);
    const foreignSql = collision.prepare("SELECT sql FROM sqlite_schema WHERE name=?").get(foreign.name).sql;
    assert.equal(ensureGalleryMetadataClocks(collision), false);
    assert.equal(collision.prepare("SELECT count(*) n FROM sqlite_schema WHERE name=?").get(GALLERY_METADATA_CLOCK_TABLE).n, 0);
    assert.equal(collision.prepare("SELECT sql FROM sqlite_schema WHERE name=?").get(foreign.name).sql, foreignSql);
    assert.equal(collision.prepare("SELECT count(*) n FROM sqlite_schema WHERE type='trigger'").get().n, 1,
      "rollback preserves the external collision and removes every newly installed trigger");
    collision.exec("INSERT INTO movie_metadata VALUES('collision-writable',8)");
  } finally { collision.close(); }

  const damagedRow = privateMetadataDb();
  try {
    assert.equal(ensureGalleryMetadataClocks(damagedRow), true);
    damagedRow.exec(`PRAGMA ignore_check_constraints=ON; UPDATE ${GALLERY_METADATA_CLOCK_TABLE} SET revision='bad' WHERE kind='movie'; PRAGMA ignore_check_constraints=OFF`);
    assert.equal(ensureGalleryMetadataClocks(damagedRow), false);
    assert.equal(damagedRow.prepare("SELECT count(*) n FROM sqlite_schema WHERE name LIKE 'fanhao_metadata_revision_%'").get().n, 0);
    damagedRow.exec("INSERT INTO movie_metadata VALUES('bad-clock-writable',8); UPDATE movie_metadata SET rating=9; DELETE FROM movie_metadata");
  } finally { damagedRow.close(); }
  console.log("metadata-clocks: PASS atomic partial-install rollback, malformed table/row compatibility, exact owned-trigger cleanup and external-name collision preservation");
}

function verifyExistingMetadataInstallation() {
  const db = privateMetadataDb();
  try {
    const insert = db.prepare("INSERT INTO movie_metadata VALUES(?,?)");
    db.exec("BEGIN");
    for (let index = 0; index < 10000; index += 1) insert.run(`private-${index}`, index);
    db.exec("COMMIT");
    const before = db.prepare("SELECT total_changes() n").get().n;
    const queries = [];
    assert.equal(ensureGalleryMetadataClocks({ exec: sql => db.exec(sql), prepare(sql) { queries.push(sql); return db.prepare(sql); } }), true);
    assert.equal(db.prepare("SELECT total_changes() n").get().n - before, 2, "existing metadata requires just two fixed clock seeds, without backfill updates");
    assert.ok(queries.every(sql => !/FROM\s+(?:movie_metadata|tv_series_metadata)\b/iu.test(sql)), "clock installation must not enumerate metadata content");
    assert.equal(db.prepare("SELECT count(*) n FROM movie_metadata").get().n, 10000);
    const installed = db.prepare(`SELECT kind, epoch, revision FROM ${GALLERY_METADATA_CLOCK_TABLE} ORDER BY kind`).all();
    assert.equal(ensureGalleryMetadataClocks(db), true);
    assert.deepEqual(db.prepare(`SELECT kind, epoch, revision FROM ${GALLERY_METADATA_CLOCK_TABLE} ORDER BY kind`).all(), installed);
    console.log("metadata-clocks: PASS existing 10k metadata install writes exactly two seeds with no content reads or backfill; repeated initialization preserves epochs");
  } finally { db.close(); }
}
