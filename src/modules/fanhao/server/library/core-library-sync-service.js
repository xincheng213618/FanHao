import fs from "node:fs";

import { parseCoreInfoCandidates, applyParsedInfoToCoreWork } from "../../../../../lib/core-info-metadata.js";

export function createCoreLibrarySyncService({
  fileBase,
  getCoreDb,
  hasCoreDb,
  normalizeExt,
  normalizeWorkCode,
  pathExists = fs.existsSync,
  relativeFromRoot,
  sourcePathToAbsolute,
  storedWorkCodeKey,
  workCodeKeys
}) {
  const parsedInfoByWork = new WeakMap();

  function parsedInfoForWork(work) {
    if (!work || typeof work !== "object") return { status: "missing", file: null, parsed: null };
    const cached = parsedInfoByWork.get(work);
    if (cached) return cached;
    const result = parseCoreInfoCandidates(work.infos || [], {
      title: work.title || "",
      directoryName: work.directoryName || ""
    });
    parsedInfoByWork.set(work, result);
    return result;
  }

  function normalizedLocalPath(value) {
    return String(value || "")
      .trim()
      .replace(/\\/g, "/")
      .replace(/\/+$/, "")
      .toLowerCase();
  }

  function localPathExists(value) {
    const localPath = String(value || "").trim();
    if (!localPath) return false;
    try {
      return Boolean(pathExists(localPath));
    } catch {
      // A transient filesystem error must never make an existing row eligible
      // for destructive path migration.
      return true;
    }
  }

  function ambiguousBindingError(personId, work, localPath, candidates, reason) {
    const candidateWorkIds = candidates.map((candidate) => candidate.workId).join(", ");
    const detectedCode = workCodeKeys(work)[0] || work?.infoSummary?.code || work?.title || "unknown";
    const error = new Error(
      `[AMBIGUOUS_LOCAL_WORK_BINDING] personId=${personId} code=${detectedCode} `
      + `localPath=${localPath || "unknown"} candidateWorkIds=${candidateWorkIds || "none"}: ${reason}`
    );
    error.code = "AMBIGUOUS_LOCAL_WORK_BINDING";
    return error;
  }

  function workIdForScannedWork(personId, work) {
    if (!hasCoreDb() || !personId || !work) return null;
    const corePersonId = Number(personId);
    if (!Number.isFinite(corePersonId)) return null;
    const codeKeys = workCodeKeys(work);
    if (!codeKeys.length) return null;

    const db = getCoreDb();
    const lookup = db.prepare(
      `
      SELECT w.id, lw.id AS local_work_id, lw.local_path
      FROM works w
      JOIN work_people wp ON wp.work_id = w.id
      LEFT JOIN local_works lw ON lw.work_id = w.id
      WHERE w.code_search = ?
        AND wp.person_id = ?
        AND wp.role = 'actor'
      ORDER BY wp.sort_order ASC, w.id ASC, lw.id ASC
      `
    );
    const candidatesByWorkId = new Map();
    for (const codeKey of codeKeys) {
      for (const row of lookup.all(codeKey, corePersonId)) {
        const workId = String(row.id || "");
        if (!workId) continue;
        if (!candidatesByWorkId.has(workId)) {
          candidatesByWorkId.set(workId, { workId, localWorks: new Map() });
        }
        if (row.local_work_id) {
          candidatesByWorkId
            .get(workId)
            .localWorks.set(Number(row.local_work_id), String(row.local_path || ""));
        }
      }
    }
    const candidates = [...candidatesByWorkId.values()].map((candidate) => ({
      workId: candidate.workId,
      localWorks: [...candidate.localWorks].map(([id, localPath]) => ({ id, localPath }))
    }));
    if (!candidates.length) return null;

    const localPath = sourcePathToAbsolute(work.relativePath) || work.relativePath || "";
    const localPathKey = normalizedLocalPath(localPath);
    const exactCandidates = candidates.filter((candidate) =>
      candidate.localWorks.some((localWork) => normalizedLocalPath(localWork.localPath) === localPathKey)
    );
    if (exactCandidates.length === 1) return exactCandidates[0].workId;
    if (exactCandidates.length > 1) {
      throw ambiguousBindingError(
        corePersonId,
        work,
        localPath,
        exactCandidates,
        "multiple core works already claim the scanned local path"
      );
    }

    if (candidates.length === 1) return candidates[0].workId;

    const missingPathCandidates = candidates.filter((candidate) =>
      candidate.localWorks.length === 1 && !localPathExists(candidate.localWorks[0].localPath)
    );
    if (missingPathCandidates.length === 1) return missingPathCandidates[0].workId;
    if (missingPathCandidates.length > 1) {
      throw ambiguousBindingError(
        corePersonId,
        work,
        localPath,
        missingPathCandidates,
        "multiple core works have a missing local path that could be migrated"
      );
    }

    const noLocalCandidates = candidates.filter((candidate) => candidate.localWorks.length === 0);
    if (noLocalCandidates.length === 1) return noLocalCandidates[0].workId;
    throw ambiguousBindingError(
      corePersonId,
      work,
      localPath,
      noLocalCandidates.length ? noLocalCandidates : candidates,
      noLocalCandidates.length
        ? "multiple core works have no local path"
        : "duplicate code candidates cannot be matched safely"
    );
  }

  function linkedScannedWork(personId, work) {
    const coreWorkId = workIdForScannedWork(personId, work);
    if (!coreWorkId) return work;
    const parsedInfo = parsedInfoForWork(work);
    const parsed = parsedInfo.status === "parsed" ? parsedInfo.parsed : null;
    const linked = {
      ...work,
      id: coreWorkId,
      title: parsed?.title || work.title,
      infoSummary: parsed
        ? {
            ...(work.infoSummary || {}),
            code: parsed.code || work.infoSummary?.code || "",
            title: parsed.title || work.infoSummary?.title || work.title || "",
            releaseDate: parsed.releaseDate || work.infoSummary?.releaseDate || "",
            durationMinutes: parsed.durationMinutes ?? work.infoSummary?.durationMinutes ?? null,
            rating: parsed.rating ?? work.infoSummary?.rating ?? null,
            ratingCount: parsed.ratingCount ?? work.infoSummary?.ratingCount ?? null,
            director: parsed.director || work.infoSummary?.director || "",
            actors: parsed.actors?.length ? parsed.actors : (work.infoSummary?.actors || []),
            tags: parsed.tags?.length ? parsed.tags : (work.infoSummary?.tags || [])
          }
        : work.infoSummary
    };
    parsedInfoByWork.set(linked, parsedInfo);
    return linked;
  }

  function localWorkKey(workId, localPath) {
    const coreWorkId = Number(workId);
    const normalizedPath = normalizedLocalPath(localPath);
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
    const parsedInfo = parsedInfoForWork(work);
    const sourceInfo = parsedInfo.file || work.infos?.[0] || null;
    const sourceVideo = work.videos?.[0] || null;
    const detectedCode = normalizeWorkCode(work.infoSummary?.code || work.title || work.directoryName || work.relativePath);
    const detectedCodeSearch = workCodeKeys(work)[0] || storedWorkCodeKey(detectedCode);
    db.exec("BEGIN IMMEDIATE");
    try {
      const existingLocalWorks = db
        .prepare("SELECT id, local_path FROM local_works WHERE work_id = ? ORDER BY id ASC")
        .all(coreWorkId);
      const exactLocalWorks = existingLocalWorks.filter(
        (candidate) => normalizedLocalPath(candidate.local_path) === normalizedLocalPath(localPath)
      );
      if (exactLocalWorks.length > 1) {
        throw ambiguousBindingError(
          work.personId || "unknown",
          work,
          localPath,
          [{ workId: String(coreWorkId), localWorks: exactLocalWorks }],
          "multiple local_works rows already claim the scanned local path"
        );
      }
      let localWork = exactLocalWorks[0] || null;
      if (!localWork && existingLocalWorks.length === 1 && !localPathExists(existingLocalWorks[0].local_path)) {
        localWork = existingLocalWorks[0];
      }
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
      if (parsedInfo.status === "parsed") {
        applyParsedInfoToCoreWork(db, coreWorkId, parsedInfo.parsed, { write: true, now });
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
