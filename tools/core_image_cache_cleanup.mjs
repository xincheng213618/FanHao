import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { attachCoreImageStore } from "../src/platform/server/core-image-store.js";

export function cleanupCoreLocalImageCache({
  coreDbPath,
  coreImageDbPath,
  legacyCoverDir,
  busyTimeoutMs = 10000,
  beforeDelete = null
}) {
  if (!fs.existsSync(coreDbPath)) throw new Error(`core database does not exist: ${coreDbPath}`);
  if (!fs.existsSync(coreImageDbPath)) throw new Error(`core image database does not exist: ${coreImageDbPath}`);

  const database = new DatabaseSync(coreDbPath);
  try {
    database.exec(`PRAGMA busy_timeout = ${positiveInteger(busyTimeoutMs) || 10000};`);
    attachCoreImageStore(database, { dbPath: coreImageDbPath, ensureSchema: false });
    const coreQuickCheck = assertQuickCheck(database, "main", "core database");
    const imageQuickCheck = assertQuickCheck(database, "fanhao_images", "core image database");
    const coreCheckpoint = assertCheckpoint(database, "main", "core database");
    const imageCheckpoint = assertCheckpoint(database, "fanhao_images", "core image database");
    const resolvedRoot = path.resolve(legacyCoverDir);
    const cacheRows = () => database.prepare(`
      SELECT file_id, file_path, byte_length
      FROM fanhao_images.local_image_cache
      WHERE COALESCE(TRIM(file_path), '') <> ''
    `).all().filter((row) => pathWithinDirectory(row.file_path, resolvedRoot));

    if (beforeDelete) beforeDelete();
    let removed = 0;
    let bytes = 0;
    try {
      database.exec("BEGIN IMMEDIATE");
      const rows = cacheRows();
      const statement = database.prepare("DELETE FROM fanhao_images.local_image_cache WHERE file_id = ?");
      for (const row of rows) {
        removed += Number(statement.run(row.file_id)?.changes || 0);
        bytes += Number(row.byte_length || 0);
      }
      database.exec("COMMIT");
    } catch (error) {
      try {
        if (database.isTransaction) database.exec("ROLLBACK");
      } catch {}
      throw error;
    }
    const remaining = cacheRows().length;
    return {
      dbPath: coreDbPath,
      imageDbPath: coreImageDbPath,
      removed,
      bytes,
      remaining,
      coreQuickCheck,
      imageQuickCheck,
      coreCheckpoint,
      imageCheckpoint
    };
  } finally {
    database.close();
  }
}

function assertQuickCheck(database, schema, label) {
  let rows;
  try {
    rows = database.prepare(`PRAGMA ${schema}.quick_check`).all();
  } catch (error) {
    throw new Error(`${label} quick_check could not complete: ${error.message}`);
  }
  const results = rows.map((row) => String(row.quick_check || ""));
  if (results.length !== 1 || results[0] !== "ok") {
    throw new Error(`${label} quick_check failed: ${JSON.stringify(results)}`);
  }
  return "ok";
}

function assertCheckpoint(database, schema, label) {
  let row;
  try {
    row = database.prepare(`PRAGMA ${schema}.wal_checkpoint(TRUNCATE)`).get() || null;
  } catch (error) {
    throw new Error(`${label} WAL checkpoint could not complete: ${error.message}`);
  }
  if (!row || Number(row.busy) !== 0) {
    throw new Error(`${label} WAL checkpoint remained busy: ${JSON.stringify(row)}`);
  }
  return {
    busy: Number(row.busy),
    log: Number(row.log),
    checkpointed: Number(row.checkpointed)
  };
}

function pathWithinDirectory(value, directory) {
  const relative = path.relative(path.resolve(directory), path.resolve(String(value || "")));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function positiveInteger(value) {
  const number = Number(value || 0);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : 0;
}
