#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { createShortVideoStore } from "../src/modules/short-videos/server/store.js";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, "..");
const DEFAULT_DAMAGED_DB = path.join(REPO_ROOT, "data", "short-videos.sqlite");
const DEFAULT_OUTPUT_DB = path.join(REPO_ROOT, "tmp", "short-videos-rebuilt.sqlite");

function printHelp() {
  console.log(`Usage:
  node tools/rebuild_short_video_database.mjs --fallback-db <healthy.sqlite> [options]

Options:
  --damaged-db <path>   Damaged database to recover (default: data/short-videos.sqlite).
  --fallback-db <path>  Healthy database used only for unreadable video rows (required).
  --output <path>       New database path (default: tmp/short-videos-rebuilt.sqlite).
  --force               Replace an existing output file.
  --help                Show this help.

The source databases are opened read-only. The script creates a fresh current-schema
database, reads video ids through the primary-key index, falls back row-by-row when a
damaged payload cannot be read, copies the latest auxiliary/user-state tables, rebuilds
indexes and triggers, and requires PRAGMA integrity_check to return ok.`);
}

function parseArgs(argv) {
  const options = {
    damagedDb: DEFAULT_DAMAGED_DB,
    fallbackDb: "",
    outputDb: DEFAULT_OUTPUT_DB,
    force: false,
    help: false
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--damaged-db") options.damagedDb = requireValue(argv, ++index, arg);
    else if (arg === "--fallback-db") options.fallbackDb = requireValue(argv, ++index, arg);
    else if (arg === "--output") options.outputDb = requireValue(argv, ++index, arg);
    else if (arg === "--force") options.force = true;
    else if (arg === "--help" || arg === "-h") options.help = true;
    else throw new Error(`Unknown option: ${arg}`);
  }
  options.damagedDb = path.resolve(options.damagedDb);
  options.fallbackDb = options.fallbackDb ? path.resolve(options.fallbackDb) : "";
  options.outputDb = path.resolve(options.outputDb);
  return options;
}

function requireValue(argv, index, option) {
  const value = argv[index];
  if (!value || value.startsWith("--")) throw new Error(`${option} requires a value`);
  return value;
}

function assertInput(filePath, label) {
  if (!filePath) throw new Error(`${label} is required`);
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    throw new Error(`${label} does not exist: ${filePath}`);
  }
}

function quoteIdentifier(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

function tableColumns(db, table) {
  return db.prepare(`PRAGMA table_info(${quoteIdentifier(table)})`).all().map((row) => row.name);
}

function tableNames(db) {
  return db.prepare(`
    SELECT name
    FROM sqlite_master
    WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
    ORDER BY name
  `).all().map((row) => row.name);
}

function removeOutputArtifacts(outputDb, force) {
  const files = [outputDb, `${outputDb}-wal`, `${outputDb}-shm`];
  const existing = files.filter((file) => fs.existsSync(file));
  if (existing.length && !force) {
    throw new Error(`Output already exists; use --force to replace it: ${outputDb}`);
  }
  for (const file of existing) fs.rmSync(file, { force: true });
}

function initializeCurrentSchema(outputDb) {
  const store = createShortVideoStore({
    dbPath: outputDb,
    roots: [],
    coverCacheDir: path.join(path.dirname(outputDb), "short-video-rebuild-covers")
  });
  try {
    store.summary();
  } finally {
    store.close();
  }
}

function schemaObjectsForVideoTable(db) {
  return db.prepare(`
    SELECT type, name, sql
    FROM sqlite_master
    WHERE tbl_name = 'short_videos'
      AND type IN ('index', 'trigger')
      AND sql IS NOT NULL
    ORDER BY CASE type WHEN 'index' THEN 1 ELSE 2 END, name
  `).all();
}

function dropSchemaObjects(db, objects) {
  for (const object of [...objects].reverse()) {
    db.exec(`DROP ${object.type.toUpperCase()} IF EXISTS ${quoteIdentifier(object.name)}`);
  }
}

function copyVideos(output, damaged, fallback) {
  const outputColumns = tableColumns(output, "short_videos");
  const damagedColumns = new Set(tableColumns(damaged, "short_videos"));
  const fallbackColumns = new Set(tableColumns(fallback, "short_videos"));
  const columns = outputColumns.filter((column) => damagedColumns.has(column) && fallbackColumns.has(column));
  if (!columns.includes("id")) throw new Error("short_videos.id is unavailable in one of the databases");

  const ids = damaged.prepare(`
    SELECT id
    FROM short_videos INDEXED BY sqlite_autoindex_short_videos_1
    ORDER BY id
  `).all().map((row) => row.id);
  const selectSql = `SELECT ${columns.map(quoteIdentifier).join(", ")} FROM short_videos WHERE id = ?`;
  const readDamaged = damaged.prepare(selectSql);
  const readFallback = fallback.prepare(selectSql);
  const insert = output.prepare(`
    INSERT INTO short_videos (${columns.map(quoteIdentifier).join(", ")})
    VALUES (${columns.map(() => "?").join(", ")})
  `);
  const fallbackRows = [];

  output.exec("BEGIN");
  try {
    for (let index = 0; index < ids.length; index += 1) {
      const id = ids[index];
      let row;
      try {
        row = readDamaged.get(id);
      } catch (error) {
        row = readFallback.get(id);
        if (!row) throw new Error(`Unreadable video ${id} is also absent from fallback: ${error.message}`);
        fallbackRows.push({ id, error: error.message });
      }
      if (!row) throw new Error(`Video id from primary-key index cannot be read: ${id}`);
      insert.run(...columns.map((column) => row[column] ?? null));
      if ((index + 1) % 5000 === 0 || index + 1 === ids.length) {
        console.log(`[videos] ${index + 1}/${ids.length}`);
      }
    }
    output.exec("COMMIT");
  } catch (error) {
    output.exec("ROLLBACK");
    throw error;
  }
  return { total: ids.length, fallbackRows };
}

function copyTable(output, damaged, table) {
  const outputColumns = new Set(tableColumns(output, table));
  const columns = tableColumns(damaged, table).filter((column) => outputColumns.has(column));
  if (!columns.length) return 0;
  const quotedTable = quoteIdentifier(table);
  const select = damaged.prepare(`SELECT ${columns.map(quoteIdentifier).join(", ")} FROM ${quotedTable}`);
  const insert = output.prepare(`
    INSERT OR REPLACE INTO ${quotedTable} (${columns.map(quoteIdentifier).join(", ")})
    VALUES (${columns.map(() => "?").join(", ")})
  `);
  let count = 0;
  output.exec("BEGIN");
  try {
    for (const row of select.iterate()) {
      insert.run(...columns.map((column) => row[column] ?? null));
      count += 1;
    }
    output.exec("COMMIT");
  } catch (error) {
    output.exec("ROLLBACK");
    throw new Error(`Failed to copy ${table}: ${error.message}`);
  }
  return count;
}

function copyAuxiliaryTables(output, damaged) {
  const outputTables = new Set(tableNames(output));
  const copied = {};
  for (const table of tableNames(damaged)) {
    if (table === "short_videos" || table === "short_video_meta" || !outputTables.has(table)) continue;
    copied[table] = copyTable(output, damaged, table);
    console.log(`[table] ${table}: ${copied[table]}`);
  }
  return copied;
}

function copyMetadata(output, damaged) {
  const rows = damaged.prepare("SELECT key, value FROM short_video_meta WHERE key <> 'schema_version'").all();
  const insert = output.prepare("INSERT OR REPLACE INTO short_video_meta (key, value) VALUES (?, ?)");
  output.exec("BEGIN");
  try {
    for (const row of rows) insert.run(row.key, row.value);
    output.exec("COMMIT");
  } catch (error) {
    output.exec("ROLLBACK");
    throw error;
  }
  return rows.length;
}

function verifyOutput(db, expectedVideos) {
  const videos = Number(db.prepare("SELECT COUNT(*) AS count FROM short_videos").get().count || 0);
  if (videos !== expectedVideos) {
    throw new Error(`Recovered video count mismatch: expected ${expectedVideos}, got ${videos}`);
  }
  const integrityRows = db.prepare("PRAGMA integrity_check").all();
  const integrity = integrityRows.map((row) => row.integrity_check);
  if (integrity.length !== 1 || integrity[0] !== "ok") {
    throw new Error(`Recovered database failed integrity_check: ${integrity.join(" | ")}`);
  }
  return { videos, integrity: integrity[0] };
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }
  assertInput(options.damagedDb, "--damaged-db");
  assertInput(options.fallbackDb, "--fallback-db");
  if (options.outputDb === options.damagedDb || options.outputDb === options.fallbackDb) {
    throw new Error("Output must be different from both input databases");
  }
  fs.mkdirSync(path.dirname(options.outputDb), { recursive: true });
  removeOutputArtifacts(options.outputDb, options.force);
  initializeCurrentSchema(options.outputDb);

  const output = new DatabaseSync(options.outputDb);
  const damaged = new DatabaseSync(options.damagedDb, { readOnly: true });
  const fallback = new DatabaseSync(options.fallbackDb, { readOnly: true });
  let result;
  try {
    const fallbackCheck = fallback.prepare("PRAGMA quick_check(1)").get()?.quick_check;
    if (fallbackCheck !== "ok") throw new Error(`Fallback database is not healthy: ${fallbackCheck}`);
    output.exec(`
      PRAGMA journal_mode = OFF;
      PRAGMA synchronous = OFF;
      PRAGMA temp_store = MEMORY;
      PRAGMA cache_size = -131072;
      PRAGMA mmap_size = 536870912;
    `);
    const schemaObjects = schemaObjectsForVideoTable(output);
    dropSchemaObjects(output, schemaObjects);
    const videos = copyVideos(output, damaged, fallback);
    const tables = copyAuxiliaryTables(output, damaged);
    const metadataRows = copyMetadata(output, damaged);
    for (const object of schemaObjects) output.exec(object.sql);
    output.exec("PRAGMA journal_mode = WAL");
    const verification = verifyOutput(output, videos.total);
    result = {
      outputDb: options.outputDb,
      videos,
      tables,
      metadataRows,
      verification
    };
  } finally {
    fallback.close();
    damaged.close();
    output.close();
  }
  console.log(JSON.stringify(result, null, 2));
}

try {
  main();
} catch (error) {
  console.error(`Short-video database rebuild failed: ${error?.stack || error}`);
  process.exitCode = 1;
}
