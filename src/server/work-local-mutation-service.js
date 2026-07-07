import fs from "node:fs";
import path from "node:path";

export function createWorkLocalMutationService({
  coreMissingWorksForPerson,
  corePersonFallbackRecord,
  ensureLibraryDirectoryPath,
  getCoreDb,
  getPersonById,
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
  relativeFromRoot,
  replacePathPrefix,
  resolveLibraryPersonByPublicId,
  resolveLibraryWorkByPublicId,
  safeStat,
  sourcePathToAbsolute,
  refreshLibrary,
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

    try {
      fs.renameSync(oldDir, newDir);
    } catch (error) {
      const wrapped = new Error(`重命名文件夹失败：${error.message}`);
      wrapped.statusCode = 500;
      throw wrapped;
    }

    const now = new Date().toISOString();
    db.exec("BEGIN IMMEDIATE");
    try {
      const localWorkId = Number(row.id);
      const fileRows = db.prepare("SELECT id, file_path FROM local_files WHERE local_work_id = ?").all(localWorkId);
      const imageRows = db
        .prepare("SELECT id, local_path FROM images WHERE owner_type = 'work' AND owner_id = ? AND local_path IS NOT NULL AND local_path <> ''")
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
        .run(newDir, replacePathPrefix(row.source_info_path || "", oldDir, newDir), now, localWorkId);
      const updateFile = db.prepare("UPDATE local_files SET file_path = ?, relative_path = ?, updated_at = ? WHERE id = ?");
      for (const fileRow of fileRows) {
        const nextPath = replacePathPrefix(fileRow.file_path, oldDir, newDir);
        updateFile.run(nextPath, relativeFromRoot(nextPath), now, fileRow.id);
      }
      const updateImage = db.prepare("UPDATE images SET local_path = ?, updated_at = ? WHERE id = ?");
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

  function clearLocalDbRowsForWork(db, coreWorkId, localWorkIds) {
    if (!localWorkIds.length) return;
    const deleteFiles = db.prepare("DELETE FROM local_files WHERE local_work_id = ?");
    const deleteLocalWork = db.prepare("DELETE FROM local_works WHERE id = ?");
    const now = new Date().toISOString();
    db.exec("BEGIN IMMEDIATE");
    try {
      for (const localWorkId of localWorkIds) {
        deleteFiles.run(localWorkId);
        deleteLocalWork.run(localWorkId);
      }
      db.prepare("UPDATE works SET updated_at = ? WHERE id = ?").run(now, coreWorkId);
      db.exec("COMMIT");
    } catch (error) {
      try {
        db.exec("ROLLBACK");
      } catch {}
      throw error;
    }
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
        SELECT id, local_path
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
    for (const row of rows) {
      const dirPath = ensureLibraryDirectoryPath(row.local_path, "作品文件夹");
      const isRoot = libraryOpenRoots().some((rootPath) => path.resolve(dirPath).toLowerCase() === path.resolve(rootPath).toLowerCase());
      if (isRoot) {
        const error = new Error("拒绝删除资料库根目录");
        error.statusCode = 400;
        throw error;
      }

      const stat = safeStat(dirPath);
      if (stat?.isDirectory()) {
        try {
          fs.rmSync(dirPath, { recursive: true, force: false });
          deletedPaths.push(relativeFromRoot(dirPath));
          emptyRemovedPaths.push(...removeEmptyLibraryParents(dirPath));
        } catch (error) {
          const wrapped = new Error(`删除作品文件夹失败：${error.message}`);
          wrapped.statusCode = 500;
          throw wrapped;
        }
      } else if (stat?.isFile()) {
        try {
          fs.unlinkSync(dirPath);
          deletedPaths.push(relativeFromRoot(dirPath));
          emptyRemovedPaths.push(...removeEmptyLibraryParents(dirPath));
        } catch (error) {
          const wrapped = new Error(`删除作品文件失败：${error.message}`);
          wrapped.statusCode = 500;
          throw wrapped;
        }
      } else {
        missingPaths.push(relativeFromRoot(dirPath));
      }
    }

    clearLocalDbRowsForWork(db, coreWorkId, rows.map((row) => Number(row.id)));
    invalidateWorkCodeIndex();
    resetWorkSearch();
    invalidateTableStamp("local_works", "local_files", "work_info");
    if (options.refresh !== false) refreshLibrary();

    const person = corePersonFallbackRecord(work.personId) || getPersonById(work.personId) || { id: work.personId || "", name: work.personName || "" };
    const missingWork = coreMissingWorksForPerson(person).find((item) => item.id === String(coreWorkId)) || {
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
      deleted: deletedPaths.length > 0 || missingPaths.length > 0,
      deletedPaths,
      missingPaths,
      emptyRemovedPaths: uniqueTextArray(emptyRemovedPaths, { maxLength: 260, maxItems: 80 }),
      work: publicWork(missingWork, true)
    };
  }

  function deletePersonLocalFiles(personId) {
    const person = resolveLibraryPersonByPublicId(personId);
    if (!person) {
      const error = new Error("人物不存在或没有本地作品");
      error.statusCode = 404;
      throw error;
    }

    const workIds = [...(person.works || [])].filter((workId) => {
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
    for (const workId of workIds) {
      const work = getWorkById(workId);
      try {
        const result = deleteWorkLocalFiles(workId, { refresh: false });
        deleted.push({
          workId: String(workId),
          title: work?.title || work?.directoryName || String(workId),
          deletedPaths: result.deletedPaths || [],
          missingPaths: result.missingPaths || []
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

    refreshLibrary();
    return {
      deletedCount: deleted.length,
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
