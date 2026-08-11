import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { attachCoreImageStore } from "../src/platform/server/core-image-store.js";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DATA_DIR = path.join(PROJECT_ROOT, "data");
const DEFAULT_CORE_DB_PATH = path.join(DATA_DIR, "fanhao-core-v2.sqlite");
const DEFAULT_IMAGE_DB_PATH = path.join(DATA_DIR, "fanhao-core-images.sqlite");
const SPLIT_TABLES = ["images", "local_image_cache", "remote_image_cache"];

const args = parseArgs(process.argv.slice(2));
const coreDbPath = path.resolve(args["core-db"] || DEFAULT_CORE_DB_PATH);
const imageDbPath = path.resolve(args["image-db"] || DEFAULT_IMAGE_DB_PATH);
const compactPath = path.resolve(args["compact-path"] || `${coreDbPath}.compact`);
const sourceBackupPath = path.resolve(args["source-backup"] || `${coreDbPath}.pre-image-split`);
const write = Boolean(args.write);
const finalize = Boolean(args.finalize);
const compact = Boolean(args.compact);
const replaceCore = Boolean(args["replace-core"]);
const busyTimeoutMs = positiveInteger(args["busy-timeout-ms"]) || 30000;

if (finalize && !write) throw new Error("--finalize requires --write");
if (compact && !finalize) throw new Error("--compact requires --finalize");
if (replaceCore && !compact) throw new Error("--replace-core requires --compact");
if (!fs.existsSync(coreDbPath)) throw new Error(`core database not found: ${coreDbPath}`);
if (finalize && !fs.existsSync(imageDbPath)) throw new Error(`image database not found for --finalize: ${imageDbPath}`);
if (finalize) assertCoreReplaceable(coreDbPath);
fs.mkdirSync(path.dirname(imageDbPath), { recursive: true });

let db = new DatabaseSync(coreDbPath);
db.exec(`PRAGMA busy_timeout = ${busyTimeoutMs}; PRAGMA foreign_keys = OFF;`);
attachCoreImageStore(db, { dbPath: imageDbPath, ensureSchema: false, allowLegacyMainTables: true });
assertMigrationPreflight(db, "before image schema");
attachCoreImageStore(db, { dbPath: imageDbPath, allowLegacyMainTables: true });
assertMigrationPreflight(db, "before copy");

const mainTables = new Set(db.prepare("SELECT name FROM main.sqlite_schema WHERE type = 'table'").all().map((row) => row.name));
const before = SPLIT_TABLES.map((table) => summarizeTable(db, "main", table, mainTables.has(table)));
printSummary("core before", before);

if (!write) {
  printSummary("image store current", SPLIT_TABLES.map((table) => summarizeTable(db, "fanhao_images", table, true)));
  db.close();
  console.log("dry run only; add --write to copy image tables");
  process.exit(0);
}

if (SPLIT_TABLES.some((table) => !mainTables.has(table))) {
  db.close();
  throw new Error("one or more image tables are already absent from the core database; refusing a partial recopy");
}

db.exec("BEGIN IMMEDIATE");
try {
  for (const table of [...SPLIT_TABLES].reverse()) db.exec(`DELETE FROM fanhao_images.${table}`);
  db.exec("DELETE FROM fanhao_images.sqlite_sequence WHERE name = 'images'");
  for (const table of SPLIT_TABLES) db.exec(`INSERT INTO fanhao_images.${table} SELECT * FROM main.${table}`);
  db.exec("COMMIT");
} catch (error) {
  db.exec("ROLLBACK");
  throw error;
}

const copied = SPLIT_TABLES.map((table) => summarizeTable(db, "fanhao_images", table, true));
printSummary("image store copied", copied);
assertMatchingSummaries(before, copied);
assertMatchingContents(db);
assertMigrationPreflight(db, "after copy");
console.log("copy verification passed");

if (!finalize) {
  db.close();
  console.log("copy completed; core tables were kept (add --finalize after stopping the server)");
  process.exit(0);
}

db.exec("BEGIN IMMEDIATE");
try {
  const finalMain = SPLIT_TABLES.map((table) => summarizeTable(db, "main", table, true));
  const finalImage = SPLIT_TABLES.map((table) => summarizeTable(db, "fanhao_images", table, true));
  assertMatchingSummaries(finalMain, finalImage);
  assertMatchingContents(db);
  for (const table of [...SPLIT_TABLES].reverse()) db.exec(`DROP TABLE main.${table}`);
  db.exec("COMMIT");
} catch (error) {
  db.exec("ROLLBACK");
  throw error;
}

const remaining = new Set(db.prepare("SELECT name FROM main.sqlite_schema WHERE type = 'table'").all().map((row) => row.name));
for (const table of SPLIT_TABLES) {
  if (remaining.has(table)) throw new Error(`failed to remove main.${table}`);
}
console.log("core image tables removed");

if (!compact) {
  db.close();
  process.exit(0);
}

db.exec("PRAGMA main.wal_checkpoint(TRUNCATE)");
removeIfExists(compactPath);
removeIfExists(`${compactPath}-wal`);
removeIfExists(`${compactPath}-shm`);
db.exec(`VACUUM main INTO ${sqlString(compactPath)}`);
db.close();
db = null;

const compactDb = new DatabaseSync(compactPath, { readOnly: true });
const integrity = compactDb.prepare("PRAGMA integrity_check").get();
const compactTables = new Set(compactDb.prepare("SELECT name FROM sqlite_schema WHERE type = 'table'").all().map((row) => row.name));
compactDb.close();
if (String(integrity?.integrity_check || "") !== "ok") throw new Error(`compact core integrity check failed: ${JSON.stringify(integrity)}`);
for (const table of SPLIT_TABLES) {
  if (compactTables.has(table)) throw new Error(`compact core still contains ${table}`);
}
console.log(`compact core verified: ${compactPath} (${formatBytes(fs.statSync(compactPath).size)})`);

if (!replaceCore) {
  console.log("compact database is ready; add --replace-core to atomically install it");
  process.exit(0);
}

if (fs.existsSync(sourceBackupPath)) throw new Error(`source backup path already exists: ${sourceBackupPath}`);
fs.renameSync(coreDbPath, sourceBackupPath);
try {
  moveSidecarToBackup("-wal");
  moveSidecarToBackup("-shm");
  fs.renameSync(compactPath, coreDbPath);
} catch (error) {
  restoreSidecarFromBackup("-wal");
  restoreSidecarFromBackup("-shm");
  fs.renameSync(sourceBackupPath, coreDbPath);
  throw error;
}
console.log(`core database replaced; temporary rollback source: ${sourceBackupPath}`);

function summarizeTable(database, schema, table, exists) {
  if (!exists) return { table, rows: null, blobRows: null, blobBytes: null };
  const blobColumn = table === "images" ? "image_blob" : "image_blob";
  const row = database.prepare(`
    SELECT
      COUNT(*) AS rows,
      COUNT(${blobColumn}) AS blob_rows,
      COALESCE(SUM(length(${blobColumn})), 0) AS blob_bytes
    FROM ${schema}.${table}
  `).get();
  return {
    table,
    rows: Number(row.rows || 0),
    blobRows: Number(row.blob_rows || 0),
    blobBytes: Number(row.blob_bytes || 0)
  };
}

function assertMatchingSummaries(expected, actual) {
  for (let index = 0; index < expected.length; index += 1) {
    const left = expected[index];
    const right = actual[index];
    if (left.table !== right.table || left.rows !== right.rows || left.blobRows !== right.blobRows || left.blobBytes !== right.blobBytes) {
      throw new Error(`copy mismatch for ${left.table}: ${JSON.stringify({ expected: left, actual: right })}`);
    }
  }
}

function assertMatchingContents(database) {
  const keyColumns = {
    images: "id",
    local_image_cache: "file_id",
    remote_image_cache: "url"
  };
  for (const table of SPLIT_TABLES) {
    const mainColumns = database.prepare(`PRAGMA main.table_info(${table})`).all().map((row) => String(row.name || ""));
    const imageColumns = database.prepare(`PRAGMA fanhao_images.table_info(${table})`).all().map((row) => String(row.name || ""));
    if (!mainColumns.length || JSON.stringify(mainColumns) !== JSON.stringify(imageColumns)) {
      throw new Error(`column mismatch for ${table}: ${JSON.stringify({ main: mainColumns, fanhaoImages: imageColumns })}`);
    }
    const key = keyColumns[table];
    if (!mainColumns.includes(key)) throw new Error(`missing comparison key ${table}.${key}`);
    const quotedTable = quoteIdentifier(table);
    const quotedKey = quoteIdentifier(key);
    const changedColumns = mainColumns
      .filter((column) => column !== key)
      .map((column) => `source.${quoteIdentifier(column)} IS NOT target.${quoteIdentifier(column)}`)
      .join(" OR ");
    const mainMismatch = database.prepare(`
      SELECT 1 AS mismatch
      FROM main.${quotedTable} source
      LEFT JOIN fanhao_images.${quotedTable} target
        ON source.${quotedKey} = target.${quotedKey}
      WHERE target.${quotedKey} IS NULL${changedColumns ? ` OR ${changedColumns}` : ""}
      LIMIT 1
    `).get();
    const imageMismatch = database.prepare(`
      SELECT 1 AS mismatch
      FROM fanhao_images.${quotedTable} source
      LEFT JOIN main.${quotedTable} target
        ON source.${quotedKey} = target.${quotedKey}
      WHERE target.${quotedKey} IS NULL${changedColumns ? ` OR ${changedColumns}` : ""}
      LIMIT 1
    `).get();
    if (mainMismatch || imageMismatch) throw new Error(`content mismatch for ${table}`);
  }
}

function assertMigrationPreflight(database, label) {
  const mainQuickCheck = assertQuickCheck(database, "main", "core database");
  const imageQuickCheck = assertQuickCheck(database, "fanhao_images", "image database");
  const mainCheckpoint = assertCheckpoint(database, "main", "core database");
  const imageCheckpoint = assertCheckpoint(database, "fanhao_images", "image database");
  const result = { mainQuickCheck, imageQuickCheck, mainCheckpoint, imageCheckpoint };
  console.log(`${label}: ${JSON.stringify(result)}`);
  return result;
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

function printSummary(label, summaries) {
  console.log(label);
  for (const item of summaries) {
    console.log(`  ${item.table}: rows=${item.rows ?? "absent"}, blobs=${item.blobRows ?? "absent"}, bytes=${item.blobBytes == null ? "absent" : formatBytes(item.blobBytes)}`);
  }
}

function parseArgs(values) {
  const parsed = {};
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (!value.startsWith("--")) continue;
    const key = value.slice(2);
    const next = values[index + 1];
    if (next && !next.startsWith("--")) {
      parsed[key] = next;
      index += 1;
    } else {
      parsed[key] = true;
    }
  }
  return parsed;
}

function positiveInteger(value) {
  const number = Number(value || 0);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : 0;
}

function formatBytes(value) {
  return `${(Number(value || 0) / (1024 ** 3)).toFixed(2)} GiB`;
}

function removeIfExists(filePath) {
  if (fs.existsSync(filePath)) fs.rmSync(filePath);
}

function moveSidecarToBackup(suffix) {
  const source = `${coreDbPath}${suffix}`;
  if (fs.existsSync(source)) fs.renameSync(source, `${sourceBackupPath}${suffix}`);
}

function restoreSidecarFromBackup(suffix) {
  const source = `${sourceBackupPath}${suffix}`;
  if (fs.existsSync(source)) fs.renameSync(source, `${coreDbPath}${suffix}`);
}

function sqlString(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function quoteIdentifier(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

function assertCoreReplaceable(filePath) {
  const probePath = `${filePath}.replace-probe`;
  if (fs.existsSync(probePath)) throw new Error(`replace probe already exists: ${probePath}`);
  try {
    fs.renameSync(filePath, probePath);
    fs.renameSync(probePath, filePath);
  } catch (error) {
    if (!fs.existsSync(filePath) && fs.existsSync(probePath)) {
      try {
        fs.renameSync(probePath, filePath);
      } catch {}
    }
    throw new Error(`core database is still open; stop FanHao and stale SQLite readers before --finalize: ${error.message}`);
  }
}
