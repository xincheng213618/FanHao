import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { parentPort, workerData } from "node:worker_threads";

const state = {
  bytes: 0,
  directories: 0,
  errors: 0,
  files: 0,
  lastProgressAt: 0,
  nodes: 0,
  skipped: 0
};

const excludedNames = new Set((workerData.excludedNames || []).map((value) => String(value).toLocaleLowerCase("en-US")));
const allowedLinkedRoots = new Set((workerData.allowedLinkedRoots || []).map(normalizePathKey));
const startedAt = new Date().toISOString();
let database = null;

try {
  fs.mkdirSync(path.dirname(workerData.outputPath), { recursive: true });
  if (fs.statSync(workerData.outputPath, { throwIfNoEntry: false })) fs.rmSync(workerData.outputPath, { force: true });
  database = new DatabaseSync(workerData.outputPath);
  prepareDatabase(database);
  const insertNode = database.prepare(`
    INSERT INTO nodes (
      path, parent_path, name, is_directory, size_bytes, modified_ms,
      extension, file_count, directory_count, error_count, depth
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  database.exec("BEGIN");
  const rootResult = scanDirectory(workerData.root, "", 0, insertNode);
  insertNode.run(
    workerData.root,
    "",
    workerData.root,
    1,
    rootResult.size,
    rootResult.modifiedMs,
    "",
    rootResult.files,
    rootResult.directories,
    rootResult.errors,
    0
  );
  writeMetadata(database, {
    completed_at: new Date().toISOString(),
    directory_count: state.directories,
    error_count: state.errors,
    file_count: state.files,
    root: workerData.root,
    scan_id: workerData.scanId,
    schema_version: 1,
    skipped_count: state.skipped,
    started_at: startedAt,
    total_bytes: rootResult.size
  });
  database.exec("COMMIT");
  database.exec("ANALYZE");
  database.close();
  database = null;

  parentPort?.postMessage({
    type: "complete",
    result: {
      bytes: rootResult.size,
      completedAt: new Date().toISOString(),
      directories: state.directories,
      errors: state.errors,
      files: state.files,
      nodes: state.nodes + 1,
      outputPath: workerData.outputPath,
      root: workerData.root,
      scanId: workerData.scanId,
      skipped: state.skipped,
      startedAt
    }
  });
} catch (error) {
  try {
    database?.exec("ROLLBACK");
  } catch {}
  try {
    database?.close();
  } catch {}
  parentPort?.postMessage({
    type: "failed",
    error: String(error?.message || error || "磁盘扫描失败")
  });
}

function prepareDatabase(db) {
  db.exec(`
    PRAGMA journal_mode = OFF;
    PRAGMA synchronous = OFF;
    PRAGMA temp_store = MEMORY;
    CREATE TABLE metadata (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE nodes (
      path TEXT PRIMARY KEY COLLATE NOCASE,
      parent_path TEXT NOT NULL COLLATE NOCASE,
      name TEXT NOT NULL,
      is_directory INTEGER NOT NULL,
      size_bytes INTEGER NOT NULL,
      modified_ms REAL NOT NULL,
      extension TEXT NOT NULL,
      file_count INTEGER NOT NULL,
      directory_count INTEGER NOT NULL,
      error_count INTEGER NOT NULL,
      depth INTEGER NOT NULL
    );
    CREATE INDEX nodes_parent_size_idx
      ON nodes(parent_path COLLATE NOCASE, size_bytes DESC, name COLLATE NOCASE);
    CREATE INDEX nodes_name_idx
      ON nodes(name COLLATE NOCASE);
  `);
}

function scanDirectory(directoryPath, parentPath, depth, insertNode) {
  let entries = [];
  let directoryModifiedMs = 0;
  try {
    const directoryStat = fs.statSync(directoryPath);
    directoryModifiedMs = Number(directoryStat.mtimeMs || 0);
    entries = fs.readdirSync(directoryPath, { withFileTypes: true });
  } catch (error) {
    state.errors += 1;
    reportProgress(directoryPath, true);
    return { directories: 0, errors: 1, files: 0, modifiedMs: directoryModifiedMs, size: 0 };
  }

  let totalBytes = 0;
  let totalDirectories = 0;
  let totalErrors = 0;
  let totalFiles = 0;

  for (const entry of entries) {
    const entryPath = path.join(directoryPath, entry.name);
    let allowedLinkedDirectory = false;
    if (entry.isSymbolicLink()) {
      if (!allowedLinkedRoots.has(normalizePathKey(entryPath))) {
        state.skipped += 1;
        continue;
      }
      try {
        allowedLinkedDirectory = fs.statSync(entryPath).isDirectory();
      } catch {
        state.errors += 1;
        totalErrors += 1;
        reportProgress(entryPath, true);
        continue;
      }
      if (!allowedLinkedDirectory) {
        state.skipped += 1;
        continue;
      }
    }

    if (entry.isDirectory() || allowedLinkedDirectory) {
      if (excludedNames.has(entry.name.toLocaleLowerCase("en-US"))) {
        state.skipped += 1;
        continue;
      }
      const result = scanDirectory(entryPath, directoryPath, depth + 1, insertNode);
      insertNode.run(
        entryPath,
        directoryPath,
        entry.name,
        1,
        result.size,
        result.modifiedMs,
        "",
        result.files,
        result.directories,
        result.errors,
        depth + 1
      );
      state.directories += 1;
      state.nodes += 1;
      totalBytes += result.size;
      totalFiles += result.files;
      totalDirectories += result.directories + 1;
      totalErrors += result.errors;
      reportProgress(entryPath);
      continue;
    }

    if (!entry.isFile()) {
      state.skipped += 1;
      continue;
    }

    try {
      const stat = fs.statSync(entryPath);
      const size = Math.max(0, Number(stat.size || 0));
      insertNode.run(
        entryPath,
        directoryPath,
        entry.name,
        0,
        size,
        Number(stat.mtimeMs || 0),
        path.extname(entry.name).toLocaleLowerCase("en-US"),
        1,
        0,
        0,
        depth + 1
      );
      state.bytes += size;
      state.files += 1;
      state.nodes += 1;
      totalBytes += size;
      totalFiles += 1;
      reportProgress(entryPath);
    } catch {
      state.errors += 1;
      totalErrors += 1;
      reportProgress(entryPath, true);
    }
  }

  return {
    directories: totalDirectories,
    errors: totalErrors,
    files: totalFiles,
    modifiedMs: directoryModifiedMs,
    size: totalBytes
  };
}

function normalizePathKey(value) {
  return path.resolve(String(value || "")).toLocaleLowerCase("en-US");
}

function reportProgress(currentPath, force = false) {
  const now = Date.now();
  if (!force && state.nodes % 250 !== 0 && now - state.lastProgressAt < 500) return;
  state.lastProgressAt = now;
  parentPort?.postMessage({
    type: "progress",
    progress: {
      bytes: state.bytes,
      currentPath,
      directories: state.directories,
      errors: state.errors,
      files: state.files,
      nodes: state.nodes,
      skipped: state.skipped
    }
  });
}

function writeMetadata(db, values) {
  const statement = db.prepare("INSERT INTO metadata (key, value) VALUES (?, ?)");
  for (const [key, value] of Object.entries(values)) statement.run(key, String(value));
}
