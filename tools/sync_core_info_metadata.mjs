#!/usr/bin/env node
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

import { applyParsedInfoToCoreWork, parseCoreInfoCandidates } from "../lib/core-info-metadata.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, "..");
const DEFAULT_DB = path.join(PROJECT_ROOT, "data", "fanhao-core-v2.sqlite");

const args = parseArgs(process.argv.slice(2));
const databasePath = path.resolve(args.db || DEFAULT_DB);
const selectedPersonDirs = args.personDirs.map((item) => path.resolve(item));
const database = new DatabaseSync(databasePath);
database.exec("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");

const rows = database.prepare(
  `
  SELECT lw.id AS local_work_id, lw.work_id, lw.local_path, lw.source_info_path,
         w.code, w.title, lf.file_path, lf.name, lf.ext, lf.size, lf.modified_at
  FROM local_works lw
  JOIN works w ON w.id = lw.work_id
  LEFT JOIN local_files lf
    ON lf.local_work_id = lw.id
   AND lf.file_type = 'info'
  ORDER BY lw.work_id ASC, lw.id ASC, lf.sort_order ASC, lf.id ASC
  `
).all();

const workGroups = new Map();
for (const row of rows) {
  if (selectedPersonDirs.length && !selectedPersonDirs.some((root) => pathWithin(row.local_path, root))) continue;
  const key = Number(row.work_id);
  if (!workGroups.has(key)) {
    workGroups.set(key, {
      workId: key,
      code: String(row.code || ""),
      title: String(row.title || ""),
      directoryName: path.basename(String(row.local_path || "")),
      files: [],
      seenPaths: new Set()
    });
  }
  const group = workGroups.get(key);
  const infoPath = String(row.file_path || row.source_info_path || "").trim();
  const pathKey = normalizedPath(infoPath);
  if (!infoPath || group.seenPaths.has(pathKey)) continue;
  group.seenPaths.add(pathKey);
  group.files.push({
    path: infoPath,
    name: String(row.name || path.basename(infoPath)),
    ext: String(row.ext || path.extname(infoPath)).toLowerCase(),
    size: Number(row.size || 0),
    modifiedAt: row.modified_at || ""
  });
}

const stats = {
  localWorksSeen: new Set(rows.filter((row) => !selectedPersonDirs.length || selectedPersonDirs.some((root) => pathWithin(row.local_path, root))).map((row) => Number(row.local_work_id))).size,
  worksSeen: workGroups.size,
  parsed: 0,
  updated: 0,
  wouldUpdate: 0,
  unchanged: 0,
  missing: 0,
  errors: 0,
  changedFields: {},
  errorItems: []
};
const parsedGroups = [];
for (const group of workGroups.values()) {
  const result = parseCoreInfoCandidates(group.files, {
    title: group.title,
    directoryName: group.directoryName
  });
  if (result.status === "parsed") {
    stats.parsed += 1;
    parsedGroups.push({ group, result });
  } else if (result.status === "missing") {
    stats.missing += 1;
  } else {
    stats.errors += 1;
    if (stats.errorItems.length < 20) {
      stats.errorItems.push({ workId: group.workId, code: group.code, error: result.error });
    }
  }
}

if (args.write) database.exec("BEGIN IMMEDIATE");
try {
  const now = new Date().toISOString();
  for (const { group, result } of parsedGroups) {
    const applied = applyParsedInfoToCoreWork(database, group.workId, result.parsed, {
      write: args.write,
      now
    });
    for (const field of applied.changedFields || []) {
      stats.changedFields[field] = Number(stats.changedFields[field] || 0) + 1;
    }
    if (applied.status === "updated") stats.updated += 1;
    else if (applied.status === "would-update") stats.wouldUpdate += 1;
    else if (applied.status === "unchanged") stats.unchanged += 1;
    else stats.errors += 1;
  }
  if (args.write) database.exec("COMMIT");
} catch (error) {
  if (args.write) {
    try {
      database.exec("ROLLBACK");
    } catch {
      // Preserve the original metadata write failure.
    }
  }
  throw error;
} finally {
  database.close();
}

console.log(`[metadata] mode=${args.write ? "write" : "dry-run"} stats=${JSON.stringify(stats)}`);

function parseArgs(argv) {
  const result = { db: "", personDirs: [], write: false };
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (item === "--write") result.write = true;
    else if (item === "--db") result.db = argv[++index] || "";
    else if (item.startsWith("--db=")) result.db = item.slice("--db=".length);
    else if (item === "--person-dir") result.personDirs.push(argv[++index] || "");
    else if (item.startsWith("--person-dir=")) result.personDirs.push(item.slice("--person-dir=".length));
    else throw new Error(`未知参数：${item}`);
  }
  result.personDirs = result.personDirs.filter(Boolean);
  return result;
}

function normalizedPath(value) {
  return path.resolve(String(value || "")).replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

function pathWithin(value, root) {
  const target = normalizedPath(value);
  const base = normalizedPath(root);
  return target === base || target.startsWith(`${base}/`);
}
