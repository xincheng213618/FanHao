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

if (finalize && !write) throw new Error("--finalize requires --write");
if (compact && !finalize) throw new Error("--compact requires --finalize");
if (replaceCore && !compact) throw new Error("--replace-core requires --compact");
if (!fs.existsSync(coreDbPath)) throw new Error(`core database not found: ${coreDbPath}`);
if (finalize) assertCoreReplaceable(coreDbPath);
fs.mkdirSync(path.dirname(imageDbPath), { recursive: true });

let db = new DatabaseSync(coreDbPath);
db.exec("PRAGMA busy_timeout = 30000; PRAGMA foreign_keys = OFF;");
attachCoreImageStore(db, { dbPath: imageDbPath, allowLegacyMainTables: true });

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
console.log("copy verification passed");

if (!finalize) {
  db.close();
  console.log("copy completed; core tables were kept (add --finalize after stopping the server)");
  process.exit(0);
}

db.exec("BEGIN IMMEDIATE");
try {
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
