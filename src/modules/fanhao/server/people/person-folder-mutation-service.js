import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { canonicalPersonId, hasIdentityTable, personLocations, personPathKey } from "./person-identity.js";

const ACTIVE_OPERATION_STATUSES = ["prepared", "filesystem_moved", "applying", "blocked"];

function serviceError(message, statusCode = 400, code = "PERSON_FOLDER_INVALID") {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  return error;
}

function pathKey(value) {
  const resolved = path.resolve(String(value || ""));
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function samePath(first, second) {
  return pathKey(first) === pathKey(second);
}

function pathUsesPrefix(value, prefix) {
  if (!value || !prefix) return false;
  const relative = path.relative(path.resolve(prefix), path.resolve(String(value)));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function pathsOverlap(first, second) {
  return pathUsesPrefix(first, second) || pathUsesPrefix(second, first);
}

function safeFolderName(value) {
  const name = String(value || "").trim();
  if (!name) throw serviceError("请输入新的文件夹名称");
  if (name === "." || name === ".." || /[\\/:*?"<>|\u0000-\u001f]/.test(name) || /[. ]$/.test(name)) {
    throw serviceError("文件夹名称包含 Windows 不允许的字符");
  }
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) {
    throw serviceError("文件夹名称是 Windows 保留名称");
  }
  if (name.length > 120) throw serviceError("文件夹名称不能超过 120 个字符");
  return name;
}

function tableExists(db, schema, table) {
  try {
    return Boolean(db.prepare(`SELECT 1 FROM ${schema}.sqlite_schema WHERE type = 'table' AND name = ?`).get(table));
  } catch {
    return false;
  }
}

export function createPersonFolderMutationService({
  ensureLibraryDirectoryPath,
  fileSystem = fs,
  getCoreDb,
  hasCoreDb,
  now = () => new Date().toISOString(),
  operationId = () => randomUUID(),
  refreshLibrary,
  relativeFromRoot,
  resolveLibraryPersonByPublicId,
  sourcePathToAbsolute,
  warn = console.warn
}) {
  function requireDatabase() {
    if (!hasCoreDb?.()) throw serviceError("番号核心数据库不可用", 503, "PERSON_FOLDER_DB_UNAVAILABLE");
    const db = getCoreDb();
    ensureSchema(db);
    return db;
  }

  function ensureSchema(db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS person_folder_operations (
        operation_id TEXT PRIMARY KEY,
        person_id TEXT NOT NULL,
        mode TEXT NOT NULL CHECK(mode IN ('rename', 'relink')),
        source_path TEXT NOT NULL,
        target_path TEXT NOT NULL,
        status TEXT NOT NULL,
        error TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        completed_at TEXT NOT NULL DEFAULT ''
      );
      CREATE INDEX IF NOT EXISTS idx_person_folder_operations_person
        ON person_folder_operations(person_id, created_at DESC);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_person_folder_operations_active_person
        ON person_folder_operations(person_id)
        WHERE status IN ('prepared', 'filesystem_moved', 'applying', 'blocked');
    `);
  }

  function normalizeSourcePath(value, label) {
    const absolute = sourcePathToAbsolute(value);
    if (!absolute) throw serviceError(`${label}无效`);
    return ensureLibraryDirectoryPath(absolute, label);
  }

  function directoryState(value) {
    try {
      const stat = fileSystem.lstatSync(value);
      return {
        exists: true,
        directory: stat.isDirectory(),
        symbolicLink: stat.isSymbolicLink()
      };
    } catch (error) {
      if (error?.code === "ENOENT") return { exists: false, directory: false, symbolicLink: false };
      throw error;
    }
  }

  function requireRegularDirectory(value, label) {
    const state = directoryState(value);
    if (!state.exists || !state.directory) throw serviceError(`${label}不存在`, 404, "PERSON_FOLDER_NOT_FOUND");
    if (state.symbolicLink) throw serviceError(`${label}是链接目录，不能在这里改名`, 409, "PERSON_FOLDER_LINK_UNSUPPORTED");
  }

  function personLocalWorkRows(db, personId) {
    return db.prepare(`
      SELECT DISTINCT lw.id, lw.work_id, lw.local_path
      FROM local_works lw
      JOIN work_people wp ON wp.work_id = lw.work_id
      WHERE wp.person_id = ? AND wp.role = 'actor'
      ORDER BY lw.id
    `).all(Number(personId));
  }

  function assertPersonSource(db, personId, sourcePath) {
    const row = db.prepare("SELECT id, folder_path FROM people WHERE id = ?").get(Number(personId));
    const libraryPerson = resolveLibraryPersonByPublicId?.(String(personId));
    if (!row?.id && !libraryPerson?.id) throw serviceError("人物不存在", 404, "PERSON_NOT_FOUND");

    const declared = [
      row?.folder_path,
      ...personLocations(db, personId).map((location) => location.path),
      libraryPerson?.relativePath,
      ...(Array.isArray(libraryPerson?.sourcePaths) ? libraryPerson.sourcePaths : [])
    ]
      .filter(Boolean)
      .map(sourcePathToAbsolute)
      .filter(Boolean);
    const localWorks = personLocalWorkRows(db, personId);
    const isDeclared = declared.some((candidate) => samePath(candidate, sourcePath));
    const ownsLocalWorkParent = localWorks.some((item) => {
      const localPath = sourcePathToAbsolute(item.local_path);
      return localPath && (samePath(localPath, sourcePath) || samePath(path.dirname(localPath), sourcePath));
    });
    if (!isDeclared && !ownsLocalWorkParent) {
      throw serviceError("源文件夹不是这个人物当前登记的本地来源", 409, "PERSON_FOLDER_SOURCE_MISMATCH");
    }

    const otherOwners = db.prepare("SELECT id, folder_path FROM people WHERE id <> ? AND folder_path IS NOT NULL AND trim(folder_path) <> ''")
      .all(Number(personId))
      .filter((item) => canonicalPersonId(db, item.id) !== String(personId) && pathsOverlap(sourcePathToAbsolute(item.folder_path), sourcePath));
    if (hasIdentityTable(db, "person_library_locations")) {
      otherOwners.push(...db.prepare("SELECT person_id, path FROM person_library_locations WHERE person_id <> ?").all(Number(personId))
        .filter((item) => pathsOverlap(sourcePathToAbsolute(item.path), sourcePath)));
    }
    if (otherOwners.length) {
      throw serviceError("这个文件夹同时登记给了其他人物，不能直接改名", 409, "PERSON_FOLDER_SHARED");
    }
    return { localWorks, row };
  }

  function assertNoActiveWorkMove(db, sourcePath, targetPath) {
    if (!tableExists(db, "main", "work_move_path_reservations")) return;
    const active = db.prepare(`
      SELECT job_id, old_path, new_path
      FROM work_move_path_reservations
      WHERE released_at = ''
    `).all();
    const conflict = active.find((item) => [item.old_path, item.new_path]
      .filter(Boolean)
      .some((reservedPath) => pathsOverlap(reservedPath, sourcePath) || pathsOverlap(reservedPath, targetPath)));
    if (conflict) {
      throw serviceError(`目录正在被作品移动任务 ${conflict.job_id} 使用`, 409, "PERSON_FOLDER_MOVE_ACTIVE");
    }
  }

  function assertTargetUnowned(db, personId, targetPath) {
    const conflicting = db.prepare("SELECT id, folder_path FROM people WHERE id <> ? AND folder_path IS NOT NULL AND trim(folder_path) <> ''")
      .all(Number(personId))
      .find((item) => canonicalPersonId(db, item.id) !== String(personId) && pathsOverlap(sourcePathToAbsolute(item.folder_path), targetPath));
    const boundConflict = hasIdentityTable(db, "person_library_locations") && db.prepare("SELECT person_id, path FROM person_library_locations WHERE person_id <> ?").all(Number(personId))
      .some((item) => pathsOverlap(sourcePathToAbsolute(item.path), targetPath));
    if (conflicting || boundConflict) {
      throw serviceError("目标文件夹已经登记给其他人物", 409, "PERSON_FOLDER_TARGET_OWNED");
    }
  }

  function expectedRelinkPaths(localWorks, sourcePath, targetPath) {
    return localWorks
      .map((item) => {
        const current = sourcePathToAbsolute(item.local_path);
        if (!current || !pathUsesPrefix(current, sourcePath)) return null;
        const relative = path.relative(sourcePath, current);
        return { current, expected: relative ? path.join(targetPath, relative) : targetPath };
      })
      .filter(Boolean);
  }

  function assertRelinkContents(localWorks, sourcePath, targetPath) {
    const expected = expectedRelinkPaths(localWorks, sourcePath, targetPath);
    const missing = expected.filter((item) => !directoryState(item.expected).directory);
    if (expected.length && missing.length) {
      throw serviceError(
        `目标文件夹缺少 ${missing.length} 个已登记作品目录，已拒绝重新关联`,
        409,
        "PERSON_FOLDER_RELINK_INCOMPLETE"
      );
    }
  }

  function createOperation(db, { mode, personId, sourcePath, targetPath }) {
    const id = operationId();
    const timestamp = now();
    try {
      db.prepare(`
        INSERT INTO person_folder_operations(
          operation_id, person_id, mode, source_path, target_path, status, error, created_at, updated_at, completed_at
        ) VALUES (?, ?, ?, ?, ?, 'prepared', '', ?, ?, '')
      `).run(id, String(personId), mode, sourcePath, targetPath, timestamp, timestamp);
    } catch (error) {
      if (/UNIQUE constraint failed/i.test(String(error?.message || ""))) {
        throw serviceError("这个人物已有未完成的目录操作，请先重试或恢复", 409, "PERSON_FOLDER_OPERATION_ACTIVE");
      }
      throw error;
    }
    return id;
  }

  function updateOperation(db, id, status, error = "", completed = false) {
    const timestamp = now();
    db.prepare(`
      UPDATE person_folder_operations
      SET status = ?, error = ?, updated_at = ?, completed_at = CASE WHEN ? THEN ? ELSE completed_at END
      WHERE operation_id = ?
    `).run(status, String(error || ""), timestamp, completed ? 1 : 0, timestamp, id);
  }

  function rewrittenPath(value, sourcePath, targetPath) {
    if (!value || !pathUsesPrefix(value, sourcePath)) return String(value || "");
    const relative = path.relative(sourcePath, path.resolve(String(value)));
    return relative ? path.join(targetPath, relative) : targetPath;
  }

  function updateTablePaths(db, {
    columns,
    relativeColumn = "",
    schema = "main",
    table,
    timestampColumn = "updated_at",
    where = "",
    whereArgs = []
  }, sourcePath, targetPath, timestamp) {
    if (!tableExists(db, schema, table)) return 0;
    const selectColumns = [...new Set([...columns, relativeColumn].filter(Boolean))];
    const pathArgs = [];
    const pathConditions = columns.map((column) => {
      const normalizedSource = sourcePath.replaceAll("\\", "/");
      const expression = `replace(${column}, char(92), '/')`;
      pathArgs.push(normalizedSource, normalizedSource, normalizedSource, normalizedSource, normalizedSource);
      return `(
        lower(${expression}) = lower(?)
        OR (
          length(${expression}) > length(?)
          AND lower(substr(${expression}, 1, length(?))) = lower(?)
          AND substr(${expression}, length(?) + 1, 1) = '/'
        )
      )`;
    });
    const conditions = [where ? `(${where})` : "", `(${pathConditions.join(" OR ")})`].filter(Boolean);
    const rows = db.prepare(`
      SELECT rowid AS _rowid, ${selectColumns.join(", ")}
      FROM ${schema}.${table}
      WHERE ${conditions.join(" AND ")}
    `).all(...whereArgs, ...pathArgs);
    let updated = 0;
    for (const row of rows) {
      const changes = {};
      for (const column of columns) {
        const nextValue = rewrittenPath(row[column], sourcePath, targetPath);
        if (nextValue !== String(row[column] || "")) changes[column] = nextValue;
      }
      if (!Object.keys(changes).length) continue;
      if (relativeColumn) {
        const primaryPath = changes[columns[0]] || row[columns[0]];
        changes[relativeColumn] = relativeFromRoot(primaryPath);
      }
      if (timestampColumn) changes[timestampColumn] = timestamp;
      const entries = Object.entries(changes);
      const result = db.prepare(`UPDATE ${schema}.${table} SET ${entries.map(([column]) => `${column} = ?`).join(", ")} WHERE rowid = ?`)
        .run(...entries.map(([, value]) => value), row._rowid);
      updated += Number(result.changes || 0);
    }
    return updated;
  }

  function rewriteMetadata(db, operation) {
    const timestamp = now();
    for (const location of personLocations(db, operation.person_id)) {
      const nextPath = rewrittenPath(location.path, operation.source_path, operation.target_path);
      if (nextPath !== location.path) db.prepare("UPDATE person_library_locations SET path = ?, path_key = ?, updated_at = ? WHERE id = ?")
        .run(nextPath, personPathKey(nextPath), timestamp, location.id);
    }
    const counts = {
      people: updateTablePaths(db, {
        table: "people",
        columns: ["folder_path"],
        where: "id = ?",
        whereArgs: [Number(operation.person_id)]
      }, operation.source_path, operation.target_path, timestamp),
      localWorks: updateTablePaths(db, {
        table: "local_works",
        columns: ["local_path", "source_info_path"]
      }, operation.source_path, operation.target_path, timestamp),
      localFiles: updateTablePaths(db, {
        table: "local_files",
        columns: ["file_path"],
        relativeColumn: "relative_path"
      }, operation.source_path, operation.target_path, timestamp),
      probeCache: updateTablePaths(db, {
        table: "video_probe_cache",
        columns: ["file_path"]
      }, operation.source_path, operation.target_path, timestamp),
      images: updateTablePaths(db, {
        schema: "fanhao_images",
        table: "images",
        columns: ["local_path", "storage_path"]
      }, operation.source_path, operation.target_path, timestamp),
      imageCache: updateTablePaths(db, {
        schema: "fanhao_images",
        table: "local_image_cache",
        columns: ["file_path"],
        relativeColumn: "relative_path"
      }, operation.source_path, operation.target_path, timestamp),
      imageStaging: updateTablePaths(db, {
        schema: "fanhao_images",
        table: "actor_profile_image_staging",
        columns: ["local_path"]
      }, operation.source_path, operation.target_path, timestamp)
    };
    return counts;
  }

  function applyMetadataOperation(db, operation) {
    db.exec("BEGIN IMMEDIATE");
    try {
      updateOperation(db, operation.operation_id, "applying");
      assertNoActiveWorkMove(db, operation.source_path, operation.target_path);
      const counts = rewriteMetadata(db, operation);
      updateOperation(db, operation.operation_id, "completed", "", true);
      db.exec("COMMIT");
      return counts;
    } catch (error) {
      try { db.exec("ROLLBACK"); } catch {}
      throw error;
    }
  }

  function refreshResult(operation, counts, { recovered = false } = {}) {
    let refreshError = "";
    try {
      refreshLibrary?.();
    } catch (error) {
      refreshError = error?.message || String(error);
      warn("[person-folder-refresh]", refreshError);
    }
    return {
      ok: true,
      operationId: operation.operation_id,
      mode: operation.mode,
      oldPath: relativeFromRoot(operation.source_path),
      newPath: relativeFromRoot(operation.target_path),
      counts,
      recovered,
      refreshError
    };
  }

  function recoverOperation(db, operation) {
    const source = directoryState(operation.source_path);
    const target = directoryState(operation.target_path);
    if (operation.mode === "rename") {
      if (source.directory && !target.exists) {
        updateOperation(db, operation.operation_id, "failed", "文件系统改名尚未发生");
        return null;
      }
      if (source.exists && target.exists) {
        updateOperation(db, operation.operation_id, "blocked", "源目录和目标目录同时存在，无法自动恢复");
        return null;
      }
      if (!target.directory) {
        updateOperation(db, operation.operation_id, "blocked", "目标目录不存在，无法自动恢复");
        return null;
      }
    } else if (!target.directory) {
      updateOperation(db, operation.operation_id, "blocked", "重新关联的目标目录不存在");
      return null;
    }

    try {
      const counts = applyMetadataOperation(db, operation);
      return refreshResult(operation, counts, { recovered: true });
    } catch (error) {
      updateOperation(db, operation.operation_id, "blocked", error?.message || String(error));
      return null;
    }
  }

  function recoverPendingOperations({ personId = "" } = {}) {
    const db = requireDatabase();
    const placeholders = ACTIVE_OPERATION_STATUSES.map(() => "?").join(", ");
    const personClause = personId ? " AND person_id = ?" : "";
    const rows = db.prepare(`
      SELECT * FROM person_folder_operations
      WHERE status IN (${placeholders})${personClause}
      ORDER BY created_at, operation_id
    `).all(...ACTIVE_OPERATION_STATUSES, ...(personId ? [String(personId)] : []));
    const recovered = [];
    for (const operation of rows) {
      const result = recoverOperation(db, operation);
      if (result) recovered.push(result);
    }
    return recovered;
  }

  function prepareOperation(payload, mode) {
    const db = requireDatabase();
    const personId = canonicalPersonId(db, payload?.personId);
    if (!personId || !/^\d+$/.test(personId)) throw serviceError("人物编号无效");
    recoverPendingOperations({ personId });

    const sourcePath = normalizeSourcePath(payload?.sourcePath, "源人物文件夹");
    const { localWorks } = assertPersonSource(db, personId, sourcePath);
    let targetPath = "";
    if (mode === "rename") {
      requireRegularDirectory(sourcePath, "源人物文件夹");
      const folderName = safeFolderName(payload?.folderName);
      targetPath = normalizeSourcePath(path.join(path.dirname(sourcePath), folderName), "目标人物文件夹");
      if (!samePath(path.dirname(sourcePath), path.dirname(targetPath))) {
        throw serviceError("重命名只能在原目录中修改文件夹名称");
      }
      if (samePath(sourcePath, targetPath)) throw serviceError("新文件夹名称与当前名称相同");
      if (directoryState(targetPath).exists) throw serviceError("目标文件夹已经存在", 409, "PERSON_FOLDER_TARGET_EXISTS");
    } else {
      targetPath = normalizeSourcePath(payload?.targetPath, "重新关联目标文件夹");
      if (directoryState(sourcePath).exists) {
        throw serviceError("源文件夹仍然存在，请使用“重命名文件夹”", 409, "PERSON_FOLDER_SOURCE_STILL_EXISTS");
      }
      requireRegularDirectory(targetPath, "重新关联目标文件夹");
      if (samePath(sourcePath, targetPath)) throw serviceError("新旧文件夹路径相同");
      assertRelinkContents(localWorks, sourcePath, targetPath);
    }
    assertTargetUnowned(db, personId, targetPath);
    assertNoActiveWorkMove(db, sourcePath, targetPath);
    const id = createOperation(db, { mode, personId, sourcePath, targetPath });
    return db.prepare("SELECT * FROM person_folder_operations WHERE operation_id = ?").get(id);
  }

  function renamePersonFolder(payload = {}) {
    const db = requireDatabase();
    const operation = prepareOperation(payload, "rename");
    try {
      fileSystem.renameSync(operation.source_path, operation.target_path);
      updateOperation(db, operation.operation_id, "filesystem_moved");
      const counts = applyMetadataOperation(db, operation);
      return refreshResult(operation, counts);
    } catch (error) {
      const source = directoryState(operation.source_path);
      const target = directoryState(operation.target_path);
      if (!source.exists && target.directory) {
        try {
          fileSystem.renameSync(operation.target_path, operation.source_path);
          updateOperation(db, operation.operation_id, "failed", error?.message || String(error));
        } catch (rollbackError) {
          updateOperation(
            db,
            operation.operation_id,
            "blocked",
            `${error?.message || error}; 回滚失败：${rollbackError?.message || rollbackError}`
          );
        }
      } else {
        updateOperation(db, operation.operation_id, "failed", error?.message || String(error));
      }
      error.operationId = operation.operation_id;
      throw error;
    }
  }

  function relinkPersonFolder(payload = {}) {
    const db = requireDatabase();
    const operation = prepareOperation(payload, "relink");
    try {
      const counts = applyMetadataOperation(db, operation);
      return refreshResult(operation, counts);
    } catch (error) {
      updateOperation(db, operation.operation_id, "failed", error?.message || String(error));
      error.operationId = operation.operation_id;
      throw error;
    }
  }

  return {
    recoverPendingOperations,
    relinkPersonFolder,
    renamePersonFolder
  };
}
