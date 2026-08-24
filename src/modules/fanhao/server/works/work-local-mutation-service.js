import fs from "node:fs";
import path from "node:path";

export function createWorkLocalMutationService({
  ensureLibraryDirectoryPath,
  getCoreDb,
  getWorkById,
  hasCoreDb,
  invalidateLibraryDerivedCaches,
  invalidateTableStamp,
  invalidateWorkCodeIndex,
  libraryOpenRoots,
  localWorkMarkerKey,
  markerDirectoryName,
  pathWithinRoot,
  publicWork,
  reconcileDeletedLocalWorks,
  relativeFromRoot,
  replacePathPrefix,
  resolveLibraryPersonByPublicId,
  resolveLibraryWorkByPublicId,
  safeStat,
  sourcePathToAbsolute,
  resetWorkSearch,
  uniqueTextArray,
  workHasLocalMarker
}) {
  function updateMemoryWorkPath(work, oldDir, newDir) {
    work.directoryName = path.basename(newDir);
    work.relativePath = relativeFromRoot(newDir);
    for (const file of [...(work.videos || []), ...(work.images || []), ...(work.infos || [])]) {
      file.path = replacePathPrefix(file.path, oldDir, newDir);
      file.relativePath = relativeFromRoot(file.path);
    }
  }

  function assertLocalPathsNotReserved(db, rows) {
    const hasReservations = db
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'work_move_path_reservations'")
      .get();
    if (!hasReservations) return;
    const findReservation = db.prepare(`
      SELECT job_id FROM work_move_path_reservations r
      WHERE r.released_at = ''
        AND (
          r.work_id = CAST(? AS TEXT)
          OR r.local_work_id = ?
          OR r.old_path_key = lower(rtrim(replace(COALESCE(?, ''), char(92), '/'), '/'))
          OR r.new_path_key = lower(rtrim(replace(COALESCE(?, ''), char(92), '/'), '/'))
        )
      ORDER BY created_at, job_id LIMIT 1
    `);
    for (const row of rows || []) {
      const reservation = findReservation.get(row.work_id, Number(row.id), row.local_path, row.local_path);
      if (!reservation) continue;
      const error = new Error(`作品正在迁移，暂时不能修改本地文件：${reservation.job_id}`);
      error.statusCode = 409;
      throw error;
    }
  }

  function setWorkLocalMarker(workId, marker, enabled) {
    const key = localWorkMarkerKey(marker);
    if (!key) {
      const error = new Error("暂时只支持 A 标记");
      error.statusCode = 400;
      throw error;
    }
    const work = resolveLibraryWorkByPublicId(workId);
    if (!work || work.missingLocal) {
      const error = new Error("作品不存在");
      error.statusCode = 404;
      throw error;
    }
    if (!hasCoreDb()) {
      const error = new Error("core DB 不可用");
      error.statusCode = 500;
      throw error;
    }

    const db = getCoreDb();
    const row = db
      .prepare(
        `
        SELECT id, local_path, source_info_path
        FROM local_works
        WHERE work_id = ?
          AND local_path IS NOT NULL
          AND local_path <> ''
        ORDER BY id
        LIMIT 1
        `
      )
      .get(Number(work.id));
    if (!row?.local_path) {
      const error = new Error("这个作品没有本地文件夹");
      error.statusCode = 404;
      throw error;
    }

    const oldDir = sourcePathToAbsolute(row.local_path);
    const stat = safeStat(oldDir);
    if (!stat?.isDirectory()) {
      const error = new Error("本地作品文件夹不存在");
      error.statusCode = 404;
      throw error;
    }
    const allowed = libraryOpenRoots().some((rootPath) => pathWithinRoot(oldDir, rootPath));
    if (!allowed) {
      const error = new Error("作品文件夹不在资料库根目录内");
      error.statusCode = 400;
      throw error;
    }

    const oldBase = path.basename(oldDir);
    const newBase = markerDirectoryName(oldBase, key, Boolean(enabled));
    if (!newBase || newBase === oldBase) {
      return { changed: false, marker: key, enabled: workHasLocalMarker(work, key), work: publicWork(work, true) };
    }

    const newDir = path.join(path.dirname(oldDir), newBase);
    const targetAllowed = libraryOpenRoots().some((rootPath) => pathWithinRoot(newDir, rootPath));
    if (!targetAllowed) {
      const error = new Error("目标文件夹不在资料库根目录内");
      error.statusCode = 400;
      throw error;
    }
    if (fs.existsSync(newDir)) {
      const error = new Error(`目标文件夹已存在：${relativeFromRoot(newDir)}`);
      error.statusCode = 409;
      throw error;
    }

    db.exec("BEGIN IMMEDIATE");
    try {
      const localWorkId = Number(row.id);
      const lockedRow = db.prepare("SELECT id, work_id, local_path, source_info_path FROM local_works WHERE id = ? AND work_id = ?").get(localWorkId, Number(work.id));
      if (!lockedRow || path.resolve(String(lockedRow.local_path || "")).toLowerCase() !== path.resolve(oldDir).toLowerCase()) {
        const error = new Error("作品本地路径已被其他操作修改");
        error.statusCode = 409;
        throw error;
      }
      assertLocalPathsNotReserved(db, [lockedRow]);
      try {
        fs.renameSync(oldDir, newDir);
      } catch (error) {
        const wrapped = new Error(`重命名文件夹失败：${error.message}`);
        wrapped.statusCode = 500;
        throw wrapped;
      }

      const now = new Date().toISOString();
      const fileRows = db.prepare("SELECT id, file_path FROM local_files WHERE local_work_id = ?").all(localWorkId);
      const imageRows = db
        .prepare("SELECT id, local_path FROM fanhao_images.images WHERE owner_type = 'work' AND owner_id = ? AND local_path IS NOT NULL AND local_path <> ''")
        .all(Number(work.id));
      db
        .prepare(
          `
          UPDATE local_works
          SET local_path = ?,
              source_info_path = CASE
                WHEN source_info_path IS NOT NULL AND source_info_path <> '' THEN ?
                ELSE source_info_path
              END,
              updated_at = ?
          WHERE id = ?
          `
        )
        .run(newDir, replacePathPrefix(lockedRow.source_info_path || "", oldDir, newDir), now, localWorkId);
      const updateFile = db.prepare("UPDATE local_files SET file_path = ?, relative_path = ?, updated_at = ? WHERE id = ?");
      for (const fileRow of fileRows) {
        const nextPath = replacePathPrefix(fileRow.file_path, oldDir, newDir);
        updateFile.run(nextPath, relativeFromRoot(nextPath), now, fileRow.id);
      }
      const updateImage = db.prepare("UPDATE fanhao_images.images SET local_path = ?, updated_at = ? WHERE id = ?");
      for (const imageRow of imageRows) {
        updateImage.run(replacePathPrefix(imageRow.local_path, oldDir, newDir), now, imageRow.id);
      }
      db.exec("COMMIT");
    } catch (error) {
      try {
        db.exec("ROLLBACK");
      } catch {}
      try {
        if (fs.existsSync(newDir) && !fs.existsSync(oldDir)) fs.renameSync(newDir, oldDir);
      } catch {}
      throw error;
    }

    updateMemoryWorkPath(work, oldDir, newDir);
    invalidateLibraryDerivedCaches();
    return { changed: true, marker: key, enabled: workHasLocalMarker(work, key), work: publicWork(work, true) };
  }

  function removeEmptyLibraryParents(filePath) {
    const roots = libraryOpenRoots().map((rootPath) => path.resolve(rootPath));
    let current = path.dirname(path.resolve(filePath));
    const removed = [];

    while (current) {
      const root = roots.find((rootPath) => pathWithinRoot(current, rootPath));
      if (!root || path.resolve(current).toLowerCase() === path.resolve(root).toLowerCase()) break;
      try {
        if (fs.readdirSync(current).length) break;
        fs.rmdirSync(current);
        removed.push(relativeFromRoot(current));
      } catch {
        break;
      }
      current = path.dirname(current);
    }

    return removed;
  }

  function normalizedLocalPath(value) {
    const fullPath = sourcePathToAbsolute(value);
    return fullPath ? path.resolve(fullPath).toLowerCase() : "";
  }

  function createLocalWorkPathIndex(db) {
    const index = new Map();
    const rows = db
      .prepare(
        `
        SELECT id, work_id, local_path
        FROM local_works
        WHERE local_path IS NOT NULL
          AND local_path <> ''
        ORDER BY id
        `
      )
      .all();
    for (const row of rows) {
      const key = normalizedLocalPath(row.local_path);
      if (!key) continue;
      if (!index.has(key)) index.set(key, []);
      index.get(key).push(row);
    }
    return index;
  }

  function removeLocalWorkRowsFromPathIndex(index, rows) {
    if (!index) return;
    const removedIds = new Set(rows.map((row) => Number(row.id)));
    for (const row of rows) {
      const key = normalizedLocalPath(row.local_path);
      const indexedRows = index.get(key);
      if (!indexedRows) continue;
      const remaining = indexedRows.filter((item) => !removedIds.has(Number(item.id)));
      if (remaining.length) index.set(key, remaining);
      else index.delete(key);
    }
  }

  function localWorkRowsForPath(db, localPath) {
    return db
      .prepare(
        `
        SELECT id, work_id, local_path
        FROM local_works
        WHERE lower(replace(local_path, '/', char(92))) = lower(replace(?, '/', char(92)))
        ORDER BY id
        `
      )
      .all(localPath);
  }

  function clearLocalDbRows(db, localWorkRows, { inTransaction = false } = {}) {
    const rows = [...new Map(localWorkRows.map((row) => [Number(row.id), row])).values()].filter((row) => Number.isFinite(Number(row.id)));
    if (!rows.length) return;
    const deleteFiles = db.prepare("DELETE FROM local_files WHERE local_work_id = ?");
    const deleteLocalWork = db.prepare("DELETE FROM local_works WHERE id = ?");
    const updateWork = db.prepare("UPDATE works SET updated_at = ? WHERE id = ?");
    const now = new Date().toISOString();
    if (!inTransaction) db.exec("BEGIN IMMEDIATE");
    try {
      for (const row of rows) {
        deleteFiles.run(Number(row.id));
        deleteLocalWork.run(Number(row.id));
      }
      for (const workId of new Set(rows.map((row) => Number(row.work_id)).filter(Number.isFinite))) {
        updateWork.run(now, workId);
      }
      if (!inTransaction) db.exec("COMMIT");
    } catch (error) {
      if (!inTransaction) {
        try {
          db.exec("ROLLBACK");
        } catch {}
      }
      throw error;
    }
  }

  function deleteSharedDirectoryWorkFiles(db, coreWorkId, localWorkId, dirPath) {
    const deletedPaths = [];
    const missingPaths = [];
    const emptyRemovedPaths = [];
    const fileRows = db
      .prepare(
        `
        SELECT id, file_path
        FROM local_files
        WHERE local_work_id = ?
          AND file_path IS NOT NULL
          AND file_path <> ''
        ORDER BY id
        `
      )
      .all(Number(localWorkId));
    const sharedFile = db.prepare(
      `
      SELECT 1
      FROM local_files
      WHERE work_id <> ?
        AND lower(replace(file_path, '/', char(92))) = lower(replace(?, '/', char(92)))
      LIMIT 1
      `
    );

    for (const fileRow of fileRows) {
      const filePath = ensureLibraryDirectoryPath(fileRow.file_path, "作品文件");
      if (!pathWithinRoot(filePath, dirPath)) {
        const error = new Error("作品文件不在作品文件夹内");
        error.statusCode = 400;
        throw error;
      }
      if (sharedFile.get(coreWorkId, fileRow.file_path)) continue;

      const stat = safeStat(filePath);
      if (!stat) {
        missingPaths.push(relativeFromRoot(filePath));
        continue;
      }
      if (!stat.isFile()) {
        const error = new Error("作品文件记录不是普通文件");
        error.statusCode = 400;
        throw error;
      }
      try {
        fs.unlinkSync(filePath);
        deletedPaths.push(relativeFromRoot(filePath));
        emptyRemovedPaths.push(...removeEmptyLibraryParents(filePath));
      } catch (error) {
        const wrapped = new Error(`删除作品文件失败：${error.message}`);
        wrapped.statusCode = 500;
        throw wrapped;
      }
    }

    return { deletedPaths, missingPaths, emptyRemovedPaths };
  }

  function deleteWorkLocalFiles(workId, options = {}) {
    const work = resolveLibraryWorkByPublicId(workId);
    if (!work || work.missingLocal) {
      const error = new Error("作品本地文件不存在");
      error.statusCode = 404;
      throw error;
    }
    if (!hasCoreDb()) {
      const error = new Error("core DB 不可用");
      error.statusCode = 500;
      throw error;
    }

    const coreWorkId = Number(work.id);
    if (!Number.isFinite(coreWorkId)) {
      const error = new Error("作品编号无效");
      error.statusCode = 400;
      throw error;
    }

    const db = getCoreDb();
    const rows = db
      .prepare(
        `
        SELECT id, work_id, local_path
        FROM local_works
        WHERE work_id = ?
          AND local_path IS NOT NULL
          AND local_path <> ''
        ORDER BY id
        `
      )
      .all(coreWorkId);
    if (!rows.length) {
      const error = new Error("这个作品没有本地文件夹");
      error.statusCode = 404;
      throw error;
    }

    const deletedPaths = [];
    const missingPaths = [];
    const emptyRemovedPaths = [];
    const localWorkRowsToClear = [...rows];
    const localWorkPathIndex = options.localWorkPathIndex || null;
    db.exec("BEGIN IMMEDIATE");
    try {
      assertLocalPathsNotReserved(db, rows);
      for (const row of rows) {
        const dirPath = ensureLibraryDirectoryPath(row.local_path, "作品文件夹");
        const isRoot = libraryOpenRoots().some((rootPath) => path.resolve(dirPath).toLowerCase() === path.resolve(rootPath).toLowerCase());
        if (isRoot) {
          const error = new Error("拒绝删除资料库根目录");
          error.statusCode = 400;
          throw error;
        }

        const stat = safeStat(dirPath);
        const pathRows = localWorkPathIndex?.get(normalizedLocalPath(row.local_path))
          || localWorkRowsForPath(db, row.local_path)
          || [row];
        const sharedByOtherWork = pathRows.some((item) => Number(item.work_id) !== coreWorkId);
        if (stat?.isDirectory()) {
          if (sharedByOtherWork) {
            const result = deleteSharedDirectoryWorkFiles(db, coreWorkId, row.id, dirPath);
            deletedPaths.push(...result.deletedPaths);
            missingPaths.push(...result.missingPaths);
            emptyRemovedPaths.push(...result.emptyRemovedPaths);
          } else {
            try {
              fs.rmSync(dirPath, {
                recursive: true,
                force: false,
                maxRetries: 5,
                retryDelay: 100
              });
              deletedPaths.push(relativeFromRoot(dirPath));
              emptyRemovedPaths.push(...removeEmptyLibraryParents(dirPath));
            } catch (error) {
              const wrapped = new Error(`删除作品文件夹失败：${error.message}`);
              wrapped.statusCode = 500;
              throw wrapped;
            }
          }
        } else if (stat?.isFile()) {
          if (!sharedByOtherWork) {
            try {
              fs.unlinkSync(dirPath);
              deletedPaths.push(relativeFromRoot(dirPath));
              emptyRemovedPaths.push(...removeEmptyLibraryParents(dirPath));
            } catch (error) {
              const wrapped = new Error(`删除作品文件失败：${error.message}`);
              wrapped.statusCode = 500;
              throw wrapped;
            }
          }
        } else {
          missingPaths.push(relativeFromRoot(dirPath));
          localWorkRowsToClear.push(...pathRows);
        }
      }

      clearLocalDbRows(db, localWorkRowsToClear, { inTransaction: true });
      db.exec("COMMIT");
    } catch (error) {
      try {
        db.exec("ROLLBACK");
      } catch {}
      throw error;
    }
    removeLocalWorkRowsFromPathIndex(localWorkPathIndex, localWorkRowsToClear);
    invalidateWorkCodeIndex();
    resetWorkSearch();
    invalidateTableStamp("local_works", "local_files", "work_info");
    const clearedWorkIds = [...new Set(localWorkRowsToClear.map((row) => String(row.work_id)))];
    if (options.refresh !== false) reconcileDeletedLocalWorks(clearedWorkIds);

    const missingWork = {
      ...work,
      missingLocal: true,
      relativePath: "",
      videos: [],
      images: [],
      infos: [],
      videoCount: 0,
      playableCount: 0,
      imageCount: 0,
      infoCount: 0
    };

    return {
      deleted: localWorkRowsToClear.length > 0,
      deletedPaths,
      missingPaths,
      emptyRemovedPaths: uniqueTextArray(emptyRemovedPaths, { maxLength: 260, maxItems: 80 }),
      clearedWorkIds,
      work: publicWork(missingWork, true)
    };
  }

  function deletePersonLocalFiles(personId, options = {}) {
    const person = resolveLibraryPersonByPublicId(personId);
    if (!person) {
      const error = new Error("人物不存在或没有本地作品");
      error.statusCode = 404;
      throw error;
    }
    if (!hasCoreDb()) {
      const error = new Error("core DB 不可用");
      error.statusCode = 500;
      throw error;
    }

    const hasRequestedWorkIds = Object.prototype.hasOwnProperty.call(options, "workIds");
    if (hasRequestedWorkIds && !Array.isArray(options.workIds)) {
      const error = new Error("workIds 必须是数组");
      error.statusCode = 400;
      throw error;
    }
    const requestedWorkIds = Array.isArray(options.workIds)
      ? [...new Set(options.workIds.map((workId) => String(workId || "").trim()).filter(Boolean))]
      : [];
    if (hasRequestedWorkIds && !requestedWorkIds.length) {
      const error = new Error("请选择要删除的作品");
      error.statusCode = 400;
      throw error;
    }
    const candidateWorkIds = requestedWorkIds.length
      ? requestedWorkIds
      : [...new Set([...(person.works || [])].map((workId) => String(workId)))];
    const workIds = candidateWorkIds.filter((workId) => {
      const work = getWorkById(workId);
      return work && !work.missingLocal;
    });
    if (!workIds.length) {
      const error = new Error("这个人物没有可删除的本地作品");
      error.statusCode = 404;
      throw error;
    }

    const deleted = [];
    const failed = [];
    const emptyRemovedPaths = [];
    const localWorkPathIndex = createLocalWorkPathIndex(getCoreDb());
    const clearedWorkIds = new Set();
    for (const workId of workIds) {
      if (clearedWorkIds.has(String(workId))) continue;
      const work = getWorkById(workId);
      try {
        const result = deleteWorkLocalFiles(workId, { refresh: false, localWorkPathIndex });
        for (const clearedWorkId of result.clearedWorkIds || []) clearedWorkIds.add(String(clearedWorkId));
        deleted.push({
          workId: String(workId),
          title: work?.title || work?.directoryName || String(workId),
          deletedPaths: result.deletedPaths || [],
          missingPaths: result.missingPaths || [],
          clearedWorkIds: result.clearedWorkIds || [String(workId)]
        });
        emptyRemovedPaths.push(...(result.emptyRemovedPaths || []));
      } catch (error) {
        failed.push({
          workId: String(workId),
          title: work?.title || work?.directoryName || String(workId),
          error: error.message || "删除失败"
        });
      }
    }

    reconcileDeletedLocalWorks([...clearedWorkIds]);
    const successfulRequestedCount = workIds.filter((workId) => clearedWorkIds.has(String(workId))).length;
    return {
      requestedCount: workIds.length,
      deletedCount: successfulRequestedCount,
      failedCount: failed.length,
      deleted,
      failed,
      emptyRemovedPaths: uniqueTextArray(emptyRemovedPaths, { maxLength: 260, maxItems: 80 })
    };
  }

  return {
    deletePersonLocalFiles,
    deleteWorkLocalFiles,
    setWorkLocalMarker
  };
}
