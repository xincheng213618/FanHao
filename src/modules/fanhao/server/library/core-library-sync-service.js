export function createCoreLibrarySyncService({
  fileBase,
  getCoreDb,
  hasCoreDb,
  normalizeExt,
  normalizeWorkCode,
  relativeFromRoot,
  sourcePathToAbsolute,
  storedWorkCodeKey,
  workCodeKeys
}) {
  function workIdForScannedWork(personId, work) {
    if (!hasCoreDb() || !personId || !work) return null;
    const corePersonId = Number(personId);
    if (!Number.isFinite(corePersonId)) return null;
    const codeKeys = workCodeKeys(work);
    if (!codeKeys.length) return null;

    const db = getCoreDb();
    const lookup = db.prepare(
      `
      SELECT w.id
      FROM works w
      JOIN work_people wp ON wp.work_id = w.id
      WHERE w.code_search = ?
        AND wp.person_id = ?
        AND wp.role = 'actor'
      ORDER BY wp.sort_order ASC, w.id ASC
      LIMIT 1
      `
    );
    for (const codeKey of codeKeys) {
      const row = lookup.get(codeKey, corePersonId);
      if (row?.id) return String(row.id);
    }
    return null;
  }

  function linkedScannedWork(personId, work) {
    const coreWorkId = workIdForScannedWork(personId, work);
    return coreWorkId ? { ...work, id: coreWorkId } : work;
  }

  function localWorkKey(workId, localPath) {
    const coreWorkId = Number(workId);
    const normalizedPath = String(localPath || "")
      .trim()
      .replace(/\\/g, "/")
      .replace(/\/+$/, "")
      .toLowerCase();
    return Number.isFinite(coreWorkId) && normalizedPath ? `${coreWorkId}|${normalizedPath}` : "";
  }

  function scannedWorkKey(work) {
    const localPath = sourcePathToAbsolute(work?.relativePath) || work?.relativePath || "";
    return localWorkKey(work?.id, localPath);
  }

  function reconcilePersonLocalWorks(previousWorks = [], nextWorks = []) {
    if (!hasCoreDb()) {
      return { deletedLocalWorkIds: [], deletedWorkIds: [] };
    }

    const retainedKeys = new Set(nextWorks.map(scannedWorkKey).filter(Boolean));
    const staleKeys = new Set(
      previousWorks
        .map(scannedWorkKey)
        .filter((key) => key && !retainedKeys.has(key))
    );
    if (!staleKeys.size) {
      return { deletedLocalWorkIds: [], deletedWorkIds: [] };
    }

    const db = getCoreDb();
    const selectRows = db.prepare(
      "SELECT id, work_id, local_path FROM local_works WHERE work_id = ?"
    );
    const staleRows = [];
    const workIds = new Set(
      previousWorks
        .map((work) => Number(work?.id))
        .filter(Number.isFinite)
    );
    for (const workId of workIds) {
      for (const row of selectRows.all(workId)) {
        if (staleKeys.has(localWorkKey(row.work_id, row.local_path))) staleRows.push(row);
      }
    }
    if (!staleRows.length) {
      return { deletedLocalWorkIds: [], deletedWorkIds: [] };
    }

    const deleteFiles = db.prepare("DELETE FROM local_files WHERE local_work_id = ?");
    const deleteLocalWork = db.prepare("DELETE FROM local_works WHERE id = ?");
    db.exec("BEGIN IMMEDIATE");
    try {
      for (const row of staleRows) {
        deleteFiles.run(Number(row.id));
        deleteLocalWork.run(Number(row.id));
      }
      db.exec("COMMIT");
    } catch (error) {
      try {
        db.exec("ROLLBACK");
      } catch {
        // Preserve the original reconciliation error.
      }
      throw error;
    }

    const remainingLocalWork = db.prepare(
      "SELECT 1 FROM local_works WHERE work_id = ? LIMIT 1"
    );
    const deletedWorkIds = [...new Set(staleRows.map((row) => Number(row.work_id)))]
      .filter((workId) => !remainingLocalWork.get(workId))
      .map(String);
    return {
      deletedLocalWorkIds: staleRows.map((row) => Number(row.id)),
      deletedWorkIds
    };
  }

  function replaceLocalFilesForWork(work) {
    if (!hasCoreDb() || !work?.id) return;
    const db = getCoreDb();
    const coreWorkId = Number(work.id);
    if (!Number.isFinite(coreWorkId)) return;
    const localPath = sourcePathToAbsolute(work.relativePath) || work.relativePath || "";
    if (!localPath) return;

    const now = new Date().toISOString();
    const insert = db.prepare(
      `
      INSERT INTO local_files (
        work_id, local_work_id, file_id, file_type, file_path, name, title, ext,
        relative_path, size, modified_at, playable, sort_order, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(file_id) DO UPDATE SET
        work_id = excluded.work_id,
        local_work_id = excluded.local_work_id,
        file_type = excluded.file_type,
        file_path = excluded.file_path,
        name = excluded.name,
        title = excluded.title,
        ext = excluded.ext,
        relative_path = excluded.relative_path,
        size = excluded.size,
        modified_at = excluded.modified_at,
        playable = excluded.playable,
        sort_order = excluded.sort_order,
        updated_at = excluded.updated_at
      `
    );
    const files = [
      ...(work.videos || []).map((file, index) => ({ file, type: "video", index })),
      ...(work.images || []).map((file, index) => ({ file, type: "image", index })),
      ...(work.infos || []).map((file, index) => ({ file, type: "info", index }))
    ];
    const sourceInfo = work.infos?.[0] || null;
    const sourceVideo = work.videos?.[0] || null;
    const detectedCode = normalizeWorkCode(work.infoSummary?.code || work.title || work.directoryName || work.relativePath);
    const detectedCodeSearch = workCodeKeys(work)[0] || storedWorkCodeKey(detectedCode);
    db.exec("BEGIN IMMEDIATE");
    try {
      let localWork = db
        .prepare(
          `
          SELECT id
          FROM local_works
          WHERE work_id = ?
          ORDER BY CASE WHEN local_path = ? THEN 0 ELSE 1 END, id ASC
          LIMIT 1
          `
        )
        .get(coreWorkId, localPath);
      if (!localWork?.id) {
        const result = db
          .prepare(
            `
            INSERT INTO local_works (
              work_id, local_path, source_info_path, source_info_id, source_name,
              source_size, source_mtime, detected_code, detected_code_search,
              matched_by, confidence, created_at, updated_at
            )
            VALUES (?, ?, ?, ?, 'local_scan', ?, ?, ?, ?, 'person_scan_code', 1, ?, ?)
            `
          )
          .run(
            coreWorkId,
            localPath,
            sourceInfo?.path || "",
            sourceInfo?.id || "",
            Number(sourceVideo?.size || 0),
            sourceVideo?.modifiedAt || work.modifiedAt || null,
            detectedCode || "",
            detectedCodeSearch || "",
            now,
            now
          );
        localWork = { id: Number(result.lastInsertRowid) };
      } else {
        db
          .prepare(
            `
            UPDATE local_works
            SET local_path = ?,
                source_info_path = ?,
                source_info_id = ?,
                source_name = 'local_scan',
                source_size = ?,
                source_mtime = ?,
                detected_code = ?,
                detected_code_search = ?,
                matched_by = 'person_scan_code',
                confidence = 1,
                updated_at = ?
            WHERE id = ?
            `
          )
          .run(
            localPath,
            sourceInfo?.path || "",
            sourceInfo?.id || "",
            Number(sourceVideo?.size || 0),
            sourceVideo?.modifiedAt || work.modifiedAt || null,
            detectedCode || "",
            detectedCodeSearch || "",
            now,
            Number(localWork.id)
          );
      }
      db.prepare("DELETE FROM local_files WHERE local_work_id = ?").run(localWork.id);
      for (const item of files) {
        insert.run(
          coreWorkId,
          localWork.id,
          item.file.id,
          item.type,
          item.file.path,
          item.file.name,
          item.file.title || fileBase(item.file.name),
          item.file.ext || normalizeExt(item.file.name),
          item.file.relativePath || relativeFromRoot(item.file.path),
          Number(item.file.size || 0),
          item.file.modifiedAt || null,
          item.type === "video" && item.file.playable ? 1 : 0,
          item.index,
          now,
          now
        );
      }
      db.exec("COMMIT");
    } catch (error) {
      try {
        db.exec("ROLLBACK");
      } catch {
        // Ignore rollback failures; the original write error is more useful.
      }
      throw error;
    }
  }

  return {
    linkedScannedWork,
    reconcilePersonLocalWorks,
    replaceLocalFilesForWork,
    workIdForScannedWork
  };
}
