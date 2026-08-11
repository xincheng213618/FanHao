import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { createShortVideoStore } from "../src/modules/short-videos/server/store.js";
import { attachCoreImageStore } from "../src/platform/server/core-image-store.js";
import { cleanupCoreLocalImageCache } from "./core_image_cache_cleanup.mjs";
import { removeVerifiedTempDir } from "./verified-temp-cleanup.mjs";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CORE_MIGRATION = path.join(PROJECT_ROOT, "tools/migrate_core_images_to_sqlite.mjs");
const SHORT_VIDEO_MIGRATION = path.join(PROJECT_ROOT, "tools/migrate_short_video_covers_to_sqlite.mjs");
const REMOTE_CACHE_TOOL = path.join(PROJECT_ROOT, "tools/cache_remote_images_node.mjs");
const SPLIT_TABLES = ["images", "local_image_cache", "remote_image_cache"];

export function verifyDestructiveImageMigrations() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "fanhao-destructive-migrations-"));
  try {
    verifyCoreMigrationRejectsMissingImageStore(tempDir);
    verifyCoreMigrationRejectsCorruptImageStore(tempDir);
    verifyCoreMigrationRejectsCorruptMain(tempDir);
    verifyCoreMigrationRejectsBusyImageCheckpoint(tempDir);
    verifyCoreMigrationRejectsCountMismatch(tempDir);
    verifyCoreMigrationRejectsContentMismatch(tempDir);
    verifyCoreMigrationSuccess(tempDir);
    verifyShortVideoCleanupRejectsCorruptImageStore(tempDir);
    verifyShortVideoCleanupRejectsCorruptMain(tempDir);
    verifyShortVideoCleanupRejectsBusyImageCheckpoint(tempDir);
    verifyShortVideoCleanupRejectsDeleteLockContention(tempDir);
    verifyShortVideoCleanupSuccess(tempDir);
    verifyRemoteCacheDirectIgnoresEnvironment(tempDir);
    verifyRemoteCacheExplicitImageStore(tempDir);
    verifyRemoteCacheCanonicalEnvironmentStore(tempDir);
    verifyRemoteCacheCanonicalDefaultStore(tempDir);
    verifyRemoteCacheRejectsMissingImageStore(tempDir);
    verifyRemoteCacheRejectsCorruptImageStore(tempDir);
  } finally {
    removeVerifiedTempDir(tempDir);
  }
}

function verifyCoreMigrationRejectsMissingImageStore(root) {
  const fixture = createCoreMigrationFixture(root, "core-missing-image");
  const expectedMain = splitSnapshot(fixture.corePath);
  fs.rmSync(fixture.imagePath, { force: true });
  const result = runNode(CORE_MIGRATION, coreMigrationArgs(fixture));
  assertFailure(result, /image database not found for --finalize/);
  assert.equal(fs.existsSync(fixture.imagePath), false, "a missing image store must not be recreated during finalize");
  assertSplitSnapshot(fixture.corePath, expectedMain, "missing image store must preserve main legacy tables");
}

function verifyCoreMigrationRejectsCorruptImageStore(root) {
  const fixture = createCoreMigrationFixture(root, "core-corrupt-image");
  const expectedMain = splitSnapshot(fixture.corePath);
  const expectedImage = splitSnapshot(fixture.imagePath);
  corruptTablePage(fixture.imagePath, "unrelated_attached");
  const result = runNode(CORE_MIGRATION, coreMigrationArgs(fixture));
  assertFailure(result, /image database quick_check|database disk image is malformed/i);
  assertSplitSnapshot(fixture.corePath, expectedMain, "corrupt attached pages must preserve main legacy tables");
  assertSplitSnapshot(fixture.imagePath, expectedImage, "corrupt unrelated attached pages must not clear copied image rows");
}

function verifyCoreMigrationRejectsCorruptMain(root) {
  const fixture = createCoreMigrationFixture(root, "core-corrupt-main");
  const expectedMain = splitSnapshot(fixture.corePath);
  const expectedImage = splitSnapshot(fixture.imagePath);
  corruptTablePage(fixture.corePath, "unrelated_main");
  const result = runNode(CORE_MIGRATION, coreMigrationArgs(fixture));
  assertFailure(result, /core database quick_check|database disk image is malformed/i);
  assertSplitSnapshot(fixture.corePath, expectedMain, "corrupt unrelated main pages must preserve legacy source rows");
  assertSplitSnapshot(fixture.imagePath, expectedImage, "corrupt main pages must not clear the attached destination");
}

function verifyCoreMigrationRejectsBusyImageCheckpoint(root) {
  const fixture = createCoreMigrationFixture(root, "core-busy-image");
  const expectedMain = splitSnapshot(fixture.corePath);
  const reader = holdWalReader(fixture.imagePath, () => {
    const writer = new DatabaseSync(fixture.imagePath);
    try {
      writer.exec("PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0;");
      writer.prepare("UPDATE remote_image_cache SET updated_at = 'busy-writer' WHERE url = 'https://attached.invalid/sentinel.jpg'").run();
    } finally {
      writer.close();
    }
  });
  const expectedImage = splitSnapshot(fixture.imagePath);
  try {
    const result = runNode(CORE_MIGRATION, coreMigrationArgs(fixture));
    assertFailure(result, /image database WAL checkpoint remained busy/i);
    assertSplitSnapshot(fixture.corePath, expectedMain, "a busy image checkpoint must preserve main legacy tables");
    assertSplitSnapshot(fixture.imagePath, expectedImage, "a busy image checkpoint must not clear attached rows");
  } finally {
    reader.exec("ROLLBACK");
    reader.close();
  }
}

function verifyCoreMigrationRejectsCountMismatch(root) {
  const fixture = createCoreMigrationFixture(root, "core-count-mismatch");
  const expectedMain = splitSnapshot(fixture.corePath);
  const db = new DatabaseSync(fixture.imagePath);
  db.exec(`
    CREATE TRIGGER ignore_remote_copy
    BEFORE INSERT ON remote_image_cache
    WHEN NEW.url = 'https://source.invalid/remote.jpg'
    BEGIN
      SELECT RAISE(IGNORE);
    END;
  `);
  db.close();
  const result = runNode(CORE_MIGRATION, coreMigrationArgs(fixture));
  assertFailure(result, /copy mismatch for remote_image_cache/i);
  assertSplitSnapshot(fixture.corePath, expectedMain, "a copied row-count mismatch must preserve main legacy tables");
}

function verifyCoreMigrationRejectsContentMismatch(root) {
  const fixture = createCoreMigrationFixture(root, "core-content-mismatch");
  const expectedMain = splitSnapshot(fixture.corePath);
  const db = new DatabaseSync(fixture.imagePath);
  db.exec(`
    CREATE TRIGGER mutate_image_copy
    AFTER INSERT ON images
    WHEN NEW.id = 1
    BEGIN
      UPDATE images SET remote_url = 'https://mutated.invalid/cover.jpg' WHERE id = NEW.id;
    END;
  `);
  db.close();
  const result = runNode(CORE_MIGRATION, coreMigrationArgs(fixture));
  assertFailure(result, /content mismatch for images/i);
  assertSplitSnapshot(fixture.corePath, expectedMain, "a copied content mismatch must preserve main legacy tables");
}

function verifyCoreMigrationSuccess(root) {
  const fixture = createCoreMigrationFixture(root, "core-success");
  const expectedMain = splitSnapshot(fixture.corePath);
  const result = runNode(CORE_MIGRATION, coreMigrationArgs(fixture));
  assert.equal(result.status, 0, `valid core image migration failed: ${result.stderr || result.stdout}`);
  assert.match(result.stdout, /before copy: .*"mainCheckpoint".*"imageCheckpoint"/, "successful migration must report both pre-copy checkpoints");
  assert.match(result.stdout, /after copy: .*"mainQuickCheck":"ok".*"imageQuickCheck":"ok"/, "successful migration must recheck both databases after copy");
  const core = new DatabaseSync(fixture.corePath, { readOnly: true });
  try {
    for (const table of SPLIT_TABLES) {
      assert.equal(core.prepare("SELECT type FROM sqlite_schema WHERE name = ?").get(table), undefined, `successful finalize must drop main.${table}`);
    }
  } finally {
    core.close();
  }
  assertSplitSnapshot(fixture.imagePath, expectedMain, "successful finalize must preserve exact source content in the image store");
}

function verifyShortVideoCleanupRejectsCorruptImageStore(root) {
  const fixture = createShortVideoCleanupFixture(root, "short-corrupt-image");
  corruptTablePage(fixture.imagePath, "unrelated_attached");
  const result = runNode(SHORT_VIDEO_MIGRATION, shortVideoMigrationArgs(fixture, true));
  assertFailure(result, /core image database quick_check|database disk image is malformed/i);
  assertShortVideoCleanupPreserved(fixture, "corrupt image pages");
}

function verifyShortVideoCleanupRejectsCorruptMain(root) {
  const fixture = createShortVideoCleanupFixture(root, "short-corrupt-main");
  corruptTablePage(fixture.corePath, "unrelated_main");
  const result = runNode(SHORT_VIDEO_MIGRATION, shortVideoMigrationArgs(fixture, true));
  assertFailure(result, /core database quick_check|database disk image is malformed/i);
  assertShortVideoCleanupPreserved(fixture, "corrupt main pages");
}

function verifyShortVideoCleanupRejectsBusyImageCheckpoint(root) {
  const fixture = createShortVideoCleanupFixture(root, "short-busy-image");
  const reader = holdWalReader(fixture.imagePath, () => {
    const writer = new DatabaseSync(fixture.imagePath);
    try {
      writer.exec("PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0;");
      writer.prepare("UPDATE local_image_cache SET updated_at = 'busy-writer' WHERE file_id = 'legacy-cover'").run();
    } finally {
      writer.close();
    }
  });
  try {
    const result = runNode(SHORT_VIDEO_MIGRATION, shortVideoMigrationArgs(fixture, true));
    assertFailure(result, /core image database WAL checkpoint remained busy/i);
    assertShortVideoCleanupPreserved(fixture, "a busy image checkpoint");
  } finally {
    reader.exec("ROLLBACK");
    reader.close();
  }
}

function verifyShortVideoCleanupRejectsDeleteLockContention(root) {
  const fixture = createShortVideoCleanupFixture(root, "short-delete-lock");
  let lock = null;
  try {
    assert.throws(
      () => cleanupCoreLocalImageCache({
        coreDbPath: fixture.corePath,
        coreImageDbPath: fixture.imagePath,
        legacyCoverDir: path.dirname(fixture.legacyCoverPath),
        busyTimeoutMs: 50,
        beforeDelete() {
          lock = new DatabaseSync(fixture.imagePath);
          lock.exec("PRAGMA busy_timeout = 50; BEGIN IMMEDIATE");
        }
      }),
      /database is locked/i,
      "a real BEGIN IMMEDIATE conflict must fail before cache deletion"
    );
    assertShortVideoCleanupPreserved(fixture, "a BEGIN IMMEDIATE lock conflict");
  } finally {
    if (lock) {
      try {
        lock.exec("ROLLBACK");
      } catch {}
      lock.close();
    }
  }
}

function verifyShortVideoCleanupSuccess(root) {
  const fixture = createShortVideoCleanupFixture(root, "short-success");
  const result = runNode(SHORT_VIDEO_MIGRATION, shortVideoMigrationArgs(fixture, false));
  assert.equal(result.status, 0, `valid short-video cache cleanup failed: ${result.stderr || result.stdout}`);
  assert.match(result.stdout, /"coreQuickCheck":"ok".*"imageQuickCheck":"ok".*"coreCheckpoint":\{"busy":0.*"imageCheckpoint":\{"busy":0/, "successful cache cleanup must report both healthy databases and checkpoints");
  const db = new DatabaseSync(fixture.imagePath, { readOnly: true });
  try {
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM local_image_cache WHERE file_id = 'legacy-cover'").get().count, 0, "healthy cache cleanup must delete the attached row");
  } finally {
    db.close();
  }
  assert.equal(fs.existsSync(fixture.legacyCoverPath), true, "cache cleanup without --delete-files must preserve the legacy file");
}

function verifyRemoteCacheDirectIgnoresEnvironment(root) {
  const directory = path.join(root, "remote-direct");
  fs.mkdirSync(directory, { recursive: true });
  const directPath = path.join(directory, "independent-image-cache.sqlite");
  const ignoredImagePath = path.join(directory, "must-not-be-used.sqlite");
  const url = "https://javdb.com/direct-cached.jpg";
  const urlsFile = writeUrlsFile(directory, [url]);
  seedDirectRemoteCache(directPath, url);
  const result = runNode(REMOTE_CACHE_TOOL, remoteCacheArgs(directPath, urlsFile), {
    FANHAO_CORE_IMAGE_DB: ignoredImagePath
  });
  assert.equal(result.status, 0, `independent remote cache failed: ${result.stderr || result.stdout}`);
  assert.match(result.stdout, /"skipped":1/, "independent image databases must be queried directly");
  assert.equal(fs.existsSync(ignoredImagePath), false, "a custom direct database must ignore FANHAO_CORE_IMAGE_DB");
  assertRemoteCacheRow(directPath, url, "independent image database must retain the cached row");
}

function verifyRemoteCacheExplicitImageStore(root) {
  const directory = path.join(root, "remote-explicit-attached");
  fs.mkdirSync(directory, { recursive: true });
  const corePath = path.join(directory, "custom-core-name.sqlite");
  const imagePath = path.join(directory, "explicit-images.sqlite");
  const url = "https://javdb.com/explicit-cached.jpg";
  const urlsFile = writeUrlsFile(directory, [url]);
  seedAttachedRemoteCache(corePath, imagePath, url);
  const result = runNode(REMOTE_CACHE_TOOL, [...remoteCacheArgs(corePath, urlsFile), "--image-db", imagePath], {
    FANHAO_CORE_IMAGE_DB: path.join(directory, "ignored-env.sqlite")
  });
  assert.equal(result.status, 0, `explicit attached remote cache failed: ${result.stderr || result.stdout}`);
  assert.match(result.stdout, /"skipped":1/);
  assertNoMainRemoteCache(corePath, "explicit --image-db must not create main.remote_image_cache");
  assertRemoteCacheRow(imagePath, url, "explicit --image-db must use the attached image store");
}

function verifyRemoteCacheCanonicalEnvironmentStore(root) {
  const directory = path.join(root, "remote-canonical-env");
  fs.mkdirSync(directory, { recursive: true });
  const corePath = path.join(directory, "fanhao-core-v2.sqlite");
  const imagePath = path.join(directory, "env-images.sqlite");
  const url = "https://javdb.com/env-cached.jpg";
  const urlsFile = writeUrlsFile(directory, [url]);
  seedAttachedRemoteCache(corePath, imagePath, url);
  const result = runNode(REMOTE_CACHE_TOOL, remoteCacheArgs(corePath, urlsFile), {
    FANHAO_CORE_IMAGE_DB: imagePath
  });
  assert.equal(result.status, 0, `canonical env remote cache failed: ${result.stderr || result.stdout}`);
  assert.match(result.stdout, /"skipped":1/);
  assertNoMainRemoteCache(corePath, "canonical core env routing must not create main.remote_image_cache");
  assertRemoteCacheRow(imagePath, url, "canonical core env routing must use the configured image store");
}

function verifyRemoteCacheCanonicalDefaultStore(root) {
  const directory = path.join(root, "remote-canonical-default");
  fs.mkdirSync(directory, { recursive: true });
  const corePath = path.join(directory, "fanhao-core-v2.sqlite");
  const imagePath = path.join(directory, "fanhao-core-images.sqlite");
  const url = "https://javdb.com/default-cached.jpg";
  const urlsFile = writeUrlsFile(directory, [url]);
  seedAttachedRemoteCache(corePath, imagePath, url);
  const result = runNode(REMOTE_CACHE_TOOL, remoteCacheArgs(corePath, urlsFile), {
    FANHAO_CORE_IMAGE_DB: null
  });
  assert.equal(result.status, 0, `canonical default remote cache failed: ${result.stderr || result.stdout}`);
  assert.match(result.stdout, /"skipped":1/);
  assertNoMainRemoteCache(corePath, "canonical core default routing must not create main.remote_image_cache");
  assertRemoteCacheRow(imagePath, url, "canonical core default routing must use the sibling image store");
}

function verifyRemoteCacheRejectsMissingImageStore(root) {
  const directory = path.join(root, "remote-missing-image");
  fs.mkdirSync(directory, { recursive: true });
  const corePath = path.join(directory, "custom-core.sqlite");
  const imagePath = path.join(directory, "missing-images.sqlite");
  const urlsFile = writeUrlsFile(directory, []);
  new DatabaseSync(corePath).close();
  const result = runNode(REMOTE_CACHE_TOOL, [...remoteCacheArgs(corePath, urlsFile), "--image-db", imagePath]);
  assertFailure(result, /image database does not exist or is empty/i);
  assert.equal(fs.existsSync(imagePath), false, "a missing explicit image store must not be created");
  assertNoMainRemoteCache(corePath, "a missing explicit image store must fail before main schema creation");
}

function verifyRemoteCacheRejectsCorruptImageStore(root) {
  const directory = path.join(root, "remote-corrupt-image");
  fs.mkdirSync(directory, { recursive: true });
  const corePath = path.join(directory, "custom-core.sqlite");
  const imagePath = path.join(directory, "corrupt-images.sqlite");
  const url = "https://javdb.com/corrupt-cached.jpg";
  const urlsFile = writeUrlsFile(directory, [url]);
  seedAttachedRemoteCache(corePath, imagePath, url, true);
  corruptTablePage(imagePath, "unrelated_attached");
  const result = runNode(REMOTE_CACHE_TOOL, [...remoteCacheArgs(corePath, urlsFile), "--image-db", imagePath]);
  assertFailure(result, /image database quick_check|database disk image is malformed/i);
  assertNoMainRemoteCache(corePath, "a corrupt explicit image store must fail before main schema creation");
  assertRemoteCacheRow(imagePath, url, "a corrupt unrelated image page must preserve existing cache rows");
}

function createCoreMigrationFixture(root, name) {
  const directory = path.join(root, name);
  fs.mkdirSync(directory, { recursive: true });
  const corePath = path.join(directory, "custom-core.sqlite");
  const imagePath = path.join(directory, "custom-images.sqlite");
  const db = new DatabaseSync(corePath);
  try {
    db.exec("PRAGMA main.journal_mode = WAL;");
    attachCoreImageStore(db, { dbPath: imagePath });
    for (const table of SPLIT_TABLES) {
      db.exec(`CREATE TABLE main.${table} AS SELECT * FROM fanhao_images.${table} WHERE 0`);
    }
    seedMainSplitTables(db);
    seedAttachedSentinels(db);
    db.exec(`
      CREATE TABLE main.unrelated_main (id INTEGER PRIMARY KEY, payload BLOB);
      INSERT INTO main.unrelated_main VALUES (1, zeroblob(8192));
      CREATE TABLE fanhao_images.unrelated_attached (id INTEGER PRIMARY KEY, payload BLOB);
      INSERT INTO fanhao_images.unrelated_attached VALUES (1, zeroblob(8192));
    `);
    checkpointBoth(db);
  } finally {
    db.close();
  }
  return { corePath, imagePath };
}

function createShortVideoCleanupFixture(root, name) {
  const directory = path.join(root, name);
  fs.mkdirSync(directory, { recursive: true });
  const shortVideoDbPath = path.join(directory, "short-videos.sqlite");
  const corePath = path.join(directory, "custom-core.sqlite");
  const imagePath = path.join(directory, "custom-images.sqlite");
  const store = createShortVideoStore({ dbPath: shortVideoDbPath, roots: [], skipStartupMaintenance: true });
  const legacyCoverDir = store.coverStorageStatus({ quickCheck: false }).legacyCoverDir;
  store.close();
  fs.mkdirSync(legacyCoverDir, { recursive: true });
  const legacyCoverPath = path.join(legacyCoverDir, "cached-cover.jpg");
  fs.writeFileSync(legacyCoverPath, "fixture");

  const db = new DatabaseSync(corePath);
  try {
    db.exec("PRAGMA main.journal_mode = WAL;");
    attachCoreImageStore(db, { dbPath: imagePath });
    db.prepare(`
      INSERT INTO fanhao_images.local_image_cache (file_id, file_path, byte_length, updated_at)
      VALUES ('legacy-cover', ?, 7, 'fixture')
    `).run(legacyCoverPath);
    db.exec(`
      CREATE TABLE main.unrelated_main (id INTEGER PRIMARY KEY, payload BLOB);
      INSERT INTO main.unrelated_main VALUES (1, zeroblob(8192));
      CREATE TABLE fanhao_images.unrelated_attached (id INTEGER PRIMARY KEY, payload BLOB);
      INSERT INTO fanhao_images.unrelated_attached VALUES (1, zeroblob(8192));
    `);
    checkpointBoth(db);
  } finally {
    db.close();
  }
  return { shortVideoDbPath, corePath, imagePath, legacyCoverPath };
}

function seedMainSplitTables(db) {
  db.exec(`
    INSERT INTO main.images (
      id, owner_type, owner_id, kind, source_type, remote_url, mime, image_blob,
      byte_size, sort_order, status, source, legacy_key, created_at, updated_at
    ) VALUES (
      1, 'work', 101, 'cover', 'remote', 'https://source.invalid/cover.jpg',
      'image/jpeg', X'010203', 3, 0, 'ok', 'fixture', 'source-image', 'fixture', 'fixture'
    );
    INSERT INTO main.local_image_cache (
      file_id, file_path, content_type, image_blob, byte_length, status, updated_at
    ) VALUES (
      'source-local', 'C:/fixture/source.jpg', 'image/jpeg', X'0405', 2, 'ok', 'fixture'
    );
    INSERT INTO main.remote_image_cache (
      url, url_hash, content_type, image_blob, byte_length, status, updated_at
    ) VALUES (
      'https://source.invalid/remote.jpg', 'source-hash', 'image/jpeg', X'0607', 2, 'ok', 'fixture'
    );
  `);
}

function seedAttachedSentinels(db) {
  db.exec(`
    INSERT INTO fanhao_images.images (
      id, owner_type, owner_id, kind, source_type, remote_url, mime, image_blob,
      byte_size, status, source, legacy_key, created_at, updated_at
    ) VALUES (
      900, 'work', 900, 'cover', 'remote', 'https://attached.invalid/sentinel.jpg',
      'image/jpeg', X'90', 1, 'ok', 'fixture', 'attached-image', 'fixture', 'fixture'
    );
    INSERT INTO fanhao_images.local_image_cache (
      file_id, file_path, content_type, image_blob, byte_length, status, updated_at
    ) VALUES (
      'attached-local', 'C:/fixture/attached.jpg', 'image/jpeg', X'91', 1, 'ok', 'fixture'
    );
    INSERT INTO fanhao_images.remote_image_cache (
      url, url_hash, content_type, image_blob, byte_length, status, updated_at
    ) VALUES (
      'https://attached.invalid/sentinel.jpg', 'attached-hash', 'image/jpeg', X'92', 1, 'ok', 'fixture'
    );
  `);
}

function coreMigrationArgs(fixture) {
  return [
    "--core-db", fixture.corePath,
    "--image-db", fixture.imagePath,
    "--write",
    "--finalize",
    "--busy-timeout-ms", "50"
  ];
}

function shortVideoMigrationArgs(fixture, deleteFiles) {
  const args = [
    "--db", fixture.shortVideoDbPath,
    "--core-db", fixture.corePath,
    "--core-image-db", fixture.imagePath,
    "--write",
    "--cleanup-core-cache",
    "--busy-timeout-ms", "50"
  ];
  if (deleteFiles) args.push("--delete-files");
  return args;
}

function runNode(script, args, envOverrides = {}) {
  const env = { ...process.env };
  for (const [key, value] of Object.entries(envOverrides)) {
    if (value == null) delete env[key];
    else env[key] = String(value);
  }
  return spawnSync(process.execPath, [script, ...args], {
    cwd: PROJECT_ROOT,
    encoding: "utf8",
    env,
    windowsHide: true,
    timeout: 20000
  });
}

function remoteCacheArgs(dbPath, urlsFile) {
  return ["--db", dbPath, "--urls-file", urlsFile, "--timeout", "1", "--concurrency", "1"];
}

function writeUrlsFile(directory, urls) {
  const filePath = path.join(directory, "urls.json");
  fs.writeFileSync(filePath, JSON.stringify(urls));
  return filePath;
}

function seedDirectRemoteCache(dbPath, url) {
  const db = new DatabaseSync(dbPath);
  try {
    db.exec(`
      CREATE TABLE remote_image_cache (
        url TEXT PRIMARY KEY,
        url_hash TEXT NOT NULL,
        content_type TEXT,
        image_blob BLOB,
        byte_length INTEGER,
        status TEXT NOT NULL DEFAULT 'ok',
        error TEXT,
        fetched_at TEXT,
        updated_at TEXT NOT NULL
      );
    `);
    db.prepare(`
      INSERT INTO remote_image_cache (url, url_hash, content_type, image_blob, byte_length, status, updated_at)
      VALUES (?, 'fixture-hash', 'image/jpeg', X'0102', 2, 'ok', 'fixture')
    `).run(url);
  } finally {
    db.close();
  }
}

function seedAttachedRemoteCache(corePath, imagePath, url, includeUnrelated = false) {
  const db = new DatabaseSync(corePath);
  try {
    attachCoreImageStore(db, { dbPath: imagePath });
    db.prepare(`
      INSERT INTO fanhao_images.remote_image_cache (url, url_hash, content_type, image_blob, byte_length, status, updated_at)
      VALUES (?, 'fixture-hash', 'image/jpeg', X'0102', 2, 'ok', 'fixture')
    `).run(url);
    if (includeUnrelated) {
      db.exec(`
        CREATE TABLE fanhao_images.unrelated_attached (id INTEGER PRIMARY KEY, payload BLOB);
        INSERT INTO fanhao_images.unrelated_attached VALUES (1, zeroblob(8192));
      `);
    }
    checkpointBoth(db);
  } finally {
    db.close();
  }
}

function assertNoMainRemoteCache(corePath, message) {
  const db = new DatabaseSync(corePath, { readOnly: true });
  try {
    assert.equal(db.prepare("SELECT type FROM sqlite_schema WHERE name = 'remote_image_cache'").get(), undefined, message);
  } finally {
    db.close();
  }
}

function assertRemoteCacheRow(dbPath, url, message) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM remote_image_cache WHERE url = ? AND image_blob IS NOT NULL").get(url).count, 1, message);
  } finally {
    db.close();
  }
}

function assertFailure(result, pattern) {
  assert.notEqual(result.status, 0, `migration unexpectedly succeeded: ${result.stdout}`);
  assert.match(`${result.stderr}\n${result.stdout}`, pattern);
}

function assertShortVideoCleanupPreserved(fixture, reason) {
  const db = new DatabaseSync(fixture.imagePath, { readOnly: true });
  try {
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM local_image_cache WHERE file_id = 'legacy-cover'").get().count, 1, `${reason} must preserve the cache row`);
  } finally {
    db.close();
  }
  assert.equal(fs.existsSync(fixture.legacyCoverPath), true, `${reason} must preserve the legacy file`);
}

function splitSnapshot(filePath) {
  const db = new DatabaseSync(filePath, { readOnly: true });
  try {
    return {
      images: rows(db, `
        SELECT id, owner_type, owner_id, kind, source_type, local_path, remote_url,
               mime, hex(image_blob) AS image_blob, byte_size, sort_order, status, source,
               legacy_table, legacy_key, created_at, updated_at
        FROM images ORDER BY id
      `),
      localImageCache: rows(db, `
        SELECT file_id, file_path, relative_path, content_type, hex(image_blob) AS image_blob,
               byte_length, source_size, source_mtime, status, error, cached_at, updated_at
        FROM local_image_cache ORDER BY file_id
      `),
      remoteImageCache: rows(db, `
        SELECT url, url_hash, content_type, hex(image_blob) AS image_blob, byte_length,
               status, error, fetched_at, updated_at
        FROM remote_image_cache ORDER BY url
      `)
    };
  } finally {
    db.close();
  }
}

function rows(db, sql) {
  return db.prepare(sql).all().map((row) => ({ ...row }));
}

function assertSplitSnapshot(filePath, expected, message) {
  assert.deepEqual(splitSnapshot(filePath), expected, message);
}

function holdWalReader(filePath, writeAfterSnapshot) {
  const reader = new DatabaseSync(filePath);
  reader.exec("PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0; BEGIN");
  reader.prepare("SELECT COUNT(*) AS count FROM remote_image_cache").get();
  writeAfterSnapshot();
  return reader;
}

function corruptTablePage(filePath, table) {
  const db = new DatabaseSync(filePath, { readOnly: true });
  let pageSize;
  let pageNumber;
  try {
    pageSize = Number(db.prepare("PRAGMA page_size").get().page_size);
    pageNumber = Number(db.prepare("SELECT pageno FROM dbstat WHERE name = ? AND pagetype = 'leaf' ORDER BY pageno LIMIT 1").get(table)?.pageno || 0);
  } finally {
    db.close();
  }
  assert(pageSize > 0 && pageNumber > 1, `unable to locate a corruptible page for ${table}`);
  const handle = fs.openSync(filePath, "r+");
  try {
    fs.writeSync(handle, Buffer.from([0]), 0, 1, (pageNumber - 1) * pageSize);
  } finally {
    fs.closeSync(handle);
  }
}

function checkpointBoth(db) {
  const main = db.prepare("PRAGMA main.wal_checkpoint(TRUNCATE)").get();
  const image = db.prepare("PRAGMA fanhao_images.wal_checkpoint(TRUNCATE)").get();
  assert.equal(Number(main?.busy), 0);
  assert.equal(Number(image?.busy), 0);
}
