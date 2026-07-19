#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { attachCoreImageStore } from "../src/platform/server/core-image-store.js";
import { fileURLToPath } from "node:url";

import { createShortVideoStore } from "../src/modules/short-videos/server/store.js";
import { parseShortVideoRoots } from "../src/platform/server/root-config.js";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DATA_DIR = path.join(PROJECT_ROOT, "data");
const DEFAULT_DB_PATH = path.join(DATA_DIR, "short-videos.sqlite");
const DEFAULT_CORE_DB_PATH = path.join(DATA_DIR, "fanhao-core-v2.sqlite");
const DEFAULT_CORE_IMAGE_DB_PATH = path.join(DATA_DIR, "fanhao-core-images.sqlite");
const args = parseArgs(process.argv.slice(2));
const dbPath = path.resolve(args.db || DEFAULT_DB_PATH);
const coreDbPath = path.resolve(args["core-db"] || DEFAULT_CORE_DB_PATH);
const coreImageDbPath = path.resolve(args["core-image-db"] || DEFAULT_CORE_IMAGE_DB_PATH);
const write = Boolean(args.write);
const deleteFiles = Boolean(args["delete-files"]);
const cleanupCoreCache = Boolean(args["cleanup-core-cache"]);
const limit = nonNegativeInteger(args.limit) || 0;
const batchSize = positiveInteger(args["batch-size"]) || 250;

if ((deleteFiles || cleanupCoreCache) && !write) {
  throw new Error("--delete-files and --cleanup-core-cache require --write");
}

const store = createShortVideoStore({
  dbPath,
  roots: parseShortVideoRoots(),
  skipStartupMaintenance: true
});

try {
  const before = store.coverStorageStatus();
  printStatus("before", before);
  if (!write) {
    console.log("mode: dry-run");
    console.log("Add --write to migrate referenced generated covers into the dedicated SQLite database.");
    process.exitCode = before.legacyReferences || before.missingLinked || before.orphaned ? 2 : 0;
  } else {
    let lastProgressAt = 0;
    const migrated = store.migrateLegacyCoverFiles({
      batchSize,
      limit,
      onProgress: (progress) => {
        const now = Date.now();
        if (progress.processed < progress.total && now - lastProgressAt < 5000) return;
        lastProgressAt = now;
        console.log(
          `progress: ${progress.processed}/${progress.total} migrated=${progress.migrated} bytes=${progress.migratedBytes} missing=${progress.missingFiles} invalid=${progress.invalidFiles}`
        );
      }
    });
    console.log(`migration: ${JSON.stringify(migrated)}`);

    const reconciled = store.coverStorageStatus({ pruneOrphans: true });
    printStatus("reconciled", reconciled);
    assertStorageReady(reconciled, { allowLegacy: limit > 0 });

    let coreCleanup = null;
    if (cleanupCoreCache) {
      coreCleanup = cleanupCoreLocalImageCache(coreDbPath, reconciled.legacyCoverDir);
      console.log(`core-cache-cleanup: ${JSON.stringify(coreCleanup)}`);
      if (coreCleanup.quickCheck !== "ok") {
        throw new Error(`core database quick_check failed after cache cleanup: ${coreCleanup.quickCheck || "unknown"}`);
      }
    }

    let deletedLegacyDirectory = false;
    if (deleteFiles) {
      if (limit > 0) throw new Error("cannot use --delete-files with a limited migration");
      assertStorageReady(reconciled, { allowLegacy: false });
      deleteLegacyCoverDirectory(reconciled.legacyCoverDir, dbPath);
      deletedLegacyDirectory = !fs.existsSync(reconciled.legacyCoverDir);
      if (!deletedLegacyDirectory) throw new Error("legacy cover directory still exists after deletion");
    }

    const after = store.coverStorageStatus({ pruneOrphans: true });
    printStatus("after", after);
    console.log(JSON.stringify({
      ok: true,
      dbPath,
      coverDbPath: store.coverDbPath,
      migrated: migrated.migrated,
      migratedBytes: migrated.migratedBytes,
      coreCleanup,
      deletedLegacyDirectory,
      storage: after
    }, null, 2));
  }
} finally {
  store.close();
}

function assertStorageReady(status, options = {}) {
  if (status.quickCheck !== "ok") throw new Error(`cover database quick_check failed: ${status.quickCheck || "unknown"}`);
  if (status.invalid !== 0) throw new Error(`cover database has ${status.invalid} invalid rows`);
  if (status.missingLinked !== 0) throw new Error(`cover database is missing ${status.missingLinked} linked rows`);
  if (status.orphaned !== 0) throw new Error(`cover database has ${status.orphaned} orphan rows`);
  if (!options.allowLegacy && status.legacyReferences !== 0) {
    throw new Error(`short-video database still has ${status.legacyReferences} legacy generated-cover references`);
  }
  if (!options.allowLegacy && status.legacyPathReferences !== 0) {
    throw new Error(`short-video database still has ${status.legacyPathReferences} paths inside the legacy cover directory`);
  }
  if (status.count !== status.linked) {
    throw new Error(`cover database count mismatch: stored=${status.count} linked=${status.linked}`);
  }
}

function cleanupCoreLocalImageCache(coreDbPath, legacyCoverDir) {
  if (!fs.existsSync(coreDbPath)) return { dbPath: coreDbPath, removed: 0, bytes: 0, quickCheck: "missing" };
  const database = new DatabaseSync(coreDbPath);
  try {
    database.exec("PRAGMA busy_timeout = 10000;");
    attachCoreImageStore(database, { dbPath: coreImageDbPath });
    const resolvedRoot = path.resolve(legacyCoverDir);
    const rows = database.prepare(`
      SELECT file_id, file_path, byte_length
      FROM local_image_cache
      WHERE COALESCE(TRIM(file_path), '') <> ''
    `).all().filter((row) => {
      const resolved = path.resolve(String(row.file_path || ""));
      return resolved.startsWith(`${resolvedRoot}${path.sep}`);
    });
    let removed = 0;
    let bytes = 0;
    database.exec("BEGIN IMMEDIATE");
    try {
      const statement = database.prepare("DELETE FROM local_image_cache WHERE file_id = ?");
      for (const row of rows) {
        removed += Number(statement.run(row.file_id)?.changes || 0);
        bytes += Number(row.byte_length || 0);
      }
      database.exec("COMMIT");
    } catch (error) {
      try {
        database.exec("ROLLBACK");
      } catch {}
      throw error;
    }
    const quickCheck = String(database.prepare("PRAGMA quick_check").get()?.quick_check || "");
    const checkpoint = database.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get() || null;
    return { dbPath: coreDbPath, removed, bytes, quickCheck, checkpoint };
  } finally {
    database.close();
  }
}

function deleteLegacyCoverDirectory(legacyCoverDir, shortVideoDbPath) {
  const resolved = path.resolve(legacyCoverDir);
  const expected = path.join(path.dirname(path.resolve(shortVideoDbPath)), "short-video-covers");
  if (resolved !== expected || path.basename(resolved) !== "short-video-covers") {
    throw new Error(`refusing to delete unexpected legacy cover directory: ${resolved}`);
  }
  if (!resolved.startsWith(`${path.resolve(PROJECT_ROOT)}${path.sep}`)) {
    throw new Error(`refusing to delete legacy cover directory outside project: ${resolved}`);
  }
  if (fs.existsSync(resolved)) fs.rmSync(resolved, { recursive: true, force: true });
}

function printStatus(label, status) {
  console.log(`${label}: ${JSON.stringify(status)}`);
}

function parseArgs(values) {
  const parsed = {};
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (!value.startsWith("--")) continue;
    const key = value.slice(2);
    const next = values[index + 1];
    if (!next || next.startsWith("--")) {
      parsed[key] = true;
      continue;
    }
    parsed[key] = next;
    index += 1;
  }
  return parsed;
}

function positiveInteger(value) {
  const number = Number(value || 0);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : 0;
}

function nonNegativeInteger(value) {
  const number = Number(value || 0);
  return Number.isFinite(number) && number >= 0 ? Math.floor(number) : 0;
}
