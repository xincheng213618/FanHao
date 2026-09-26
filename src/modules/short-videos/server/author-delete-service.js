import fs from "node:fs";
import path from "node:path";

export function createShortVideoAuthorDeleteService(options = {}) {
  const {
    database,
    deleteVideos,
    roots = [],
    fsOps = fs
  } = options;
  if (typeof database !== "function" || typeof deleteVideos !== "function") {
    throw new TypeError("author delete dependencies are required");
  }
  const managedRoots = normalizeRoots(roots);

  function preview(secUid) {
    return publicPreview(analyze(secUid));
  }

  async function execute(secUid, options = {}) {
    const analysis = analyze(secUid);
    assertExpectedSnapshot(analysis, options);
    const deletion = analysis.deleteIds.length
      ? await deleteVideos(analysis.deleteIds, {
          deleteFiles: true,
          ...(options.operationId ? { operationId: options.operationId } : {})
        })
      : null;
    const cleanupReady = !deletion || deletion.physicalCleanupComplete === true;
    const folderCleanup = cleanupReady
      ? removeFolders(analysis)
      : { complete: false, removed: [], removedCount: 0 };
    return { preview: publicPreview(analysis), deletion, folderCleanup };
  }

  function deleteRecord(secUid) {
    const analysis = analyze(secUid, { allowMissing: true });
    if (analysis.totalCount > 0) {
      throw publicError("作者仍有本地作品，请刷新后重试", 409, "SHORT_VIDEO_AUTHOR_DELETE_HAS_WORKS");
    }
    const db = database();
    if (!analysis.userId) return { removed: false, userId: "", followRows: 0 };
    db.exec("BEGIN IMMEDIATE");
    try {
      const followRows = Number(db.prepare("DELETE FROM short_video_follows WHERE target_user_id = ?").run(analysis.userId).changes || 0);
      const removed = Number(db.prepare("DELETE FROM short_video_users WHERE id = ? AND sec_uid = ?").run(analysis.userId, analysis.secUid).changes || 0) > 0;
      db.exec("COMMIT");
      return { removed, userId: analysis.userId, followRows };
    } catch (error) {
      try { db.exec("ROLLBACK"); } catch {}
      throw error;
    }
  }

  function analyze(value, options = {}) {
    const secUid = normalizedSecUid(value);
    const db = database();
    const user = db.prepare(`
      SELECT id, nickname
      FROM short_video_users
      WHERE platform = 'douyin' AND sec_uid = ?
      LIMIT 1
    `).get(secUid);
    const columns = "id, author_name, is_liked, media_type, COALESCE(size_bytes, 0) AS size_bytes, source_path";
    const rows = db.prepare(`
      SELECT ${columns}
      FROM short_videos
      WHERE author_sec_uid = ?
      ORDER BY id
    `).all(secUid);
    if (user?.id) {
      rows.push(...db.prepare(`
        SELECT ${columns}
        FROM short_videos
        WHERE owner_user_id = ?
          AND COALESCE(author_sec_uid, '') <> ?
        ORDER BY id
      `).all(user.id, secUid));
    }
    if (!user && !rows.length && !options.allowMissing) {
      throw publicError("没有找到这个作者的本地记录", 404, "SHORT_VIDEO_AUTHOR_DELETE_NOT_FOUND");
    }
    const folders = inspectFolders(secUid, rows);
    return {
      secUid,
      userId: String(user?.id || ""),
      name: String(user?.nickname || rows[0]?.author_name || "未知作者").trim() || "未知作者",
      totalCount: rows.length,
      totalBytes: sumBytes(rows),
      likedCount: rows.filter((row) => Number(row.is_liked || 0) === 1).length,
      galleryCount: rows.filter((row) => row.media_type === "gallery").length,
      folderCount: folders.length,
      folders,
      deleteIds: rows.map((row) => String(row.id || "")).filter(Boolean)
    };
  }

  function inspectFolders(secUid, rows = []) {
    const candidates = new Map();
    for (const row of rows) {
      const sourcePath = String(row?.source_path || "").trim();
      if (!sourcePath) continue;
      const root = managedRoots.find((item) => isInside(sourcePath, item));
      if (!root) continue;
      const relative = path.relative(root, path.resolve(sourcePath));
      const first = relative.split(path.sep).filter(Boolean)[0] || "";
      if (!authorFolderNameMatches(first, secUid)) continue;
      addFolderCandidate(candidates, root, path.join(root, first), secUid);
    }
    for (const root of managedRoots) {
      for (const entry of safeReadDir(root)) {
        if (!entry.isDirectory() || entry.isSymbolicLink() || !authorFolderNameMatches(entry.name, secUid)) continue;
        addFolderCandidate(candidates, root, path.join(root, entry.name), secUid);
      }
    }
    return [...candidates.values()].sort((left, right) => left.path.localeCompare(right.path));
  }

  function addFolderCandidate(candidates, root, candidate, secUid) {
    const rootPath = path.resolve(root);
    const candidatePath = path.resolve(candidate);
    if (path.dirname(candidatePath).toLocaleLowerCase("en-US") !== rootPath.toLocaleLowerCase("en-US")) return;
    if (!authorFolderNameMatches(path.basename(candidatePath), secUid)) return;
    let entry;
    try { entry = fsOps.lstatSync(candidatePath); } catch { return; }
    if (!entry.isDirectory() || entry.isSymbolicLink()) return;
    let rootReal;
    let candidateReal;
    try {
      rootReal = fsOps.realpathSync(rootPath);
      candidateReal = fsOps.realpathSync(candidatePath);
    } catch {
      return;
    }
    if (path.dirname(candidateReal).toLocaleLowerCase("en-US") !== path.resolve(rootReal).toLocaleLowerCase("en-US")) return;
    candidates.set(candidatePath.toLocaleLowerCase("en-US"), { path: candidatePath, root: rootPath, name: path.basename(candidatePath) });
  }

  function removeFolders(analysis) {
    const removed = [];
    for (const folder of inspectFolders(analysis.secUid, analysis.folders.map((item) => ({ source_path: path.join(item.path, "placeholder") })))) {
      const tracked = database().prepare(`
        SELECT owner_id AS id
        FROM (
          SELECT id AS owner_id, source_path AS local_path FROM short_videos
          UNION ALL
          SELECT id, cover_path FROM short_videos
          UNION ALL
          SELECT id, music_path FROM short_videos
          UNION ALL
          SELECT id, data_path FROM short_videos
          UNION ALL
          SELECT video_id, local_path FROM short_video_assets
        ) tracked_path
        WHERE COALESCE(local_path, '') LIKE ? ESCAPE '\\'
        LIMIT 1
      `).get(`${escapeLike(folder.path + path.sep)}%`);
      if (tracked?.id) {
        throw publicError("作者文件夹仍被其他作品使用，已停止删除", 409, "SHORT_VIDEO_AUTHOR_FOLDER_IN_USE");
      }
      try {
        fsOps.rmSync(folder.path, { recursive: true, force: false, maxRetries: 3, retryDelay: 100 });
        removed.push(folder.name);
      } catch (error) {
        if (error?.code === "ENOENT") continue;
        throw publicError(`作者文件夹删除失败：${folder.name}`, 500, "SHORT_VIDEO_AUTHOR_FOLDER_DELETE_FAILED", error);
      }
    }
    return { complete: true, removed, removedCount: removed.length };
  }

  function safeReadDir(root) {
    try { return fsOps.readdirSync(root, { withFileTypes: true }); } catch { return []; }
  }

  return Object.freeze({ deleteRecord, execute, preview });
}

function publicPreview(analysis) {
  const { deleteIds, folders, userId, ...result } = analysis;
  return result;
}

function normalizedSecUid(value) {
  const secUid = String(value || "").trim();
  if (!secUid || secUid.length > 512 || !/^[A-Za-z0-9_-]+$/u.test(secUid)) {
    throw publicError("作者标识无效", 400, "SHORT_VIDEO_AUTHOR_DELETE_INVALID_AUTHOR");
  }
  return secUid;
}

function assertExpectedSnapshot(analysis, options) {
  if (!Object.hasOwn(options, "totalCount")) return;
  const expected = Number(options.totalCount);
  if (!Number.isSafeInteger(expected) || expected < 0 || expected !== analysis.totalCount) {
    throw publicError("作者作品数量已经变化，请重新预览后确认", 409, "SHORT_VIDEO_AUTHOR_DELETE_CHANGED");
  }
}

function normalizeRoots(values) {
  return [...new Set((Array.isArray(values) ? values : [values])
    .map((item) => String(item || "").trim())
    .filter(Boolean)
    .map((item) => path.resolve(item)))];
}

function authorFolderNameMatches(name, secUid) {
  const value = String(name || "");
  return value === secUid || value.endsWith(`_${secUid}`);
}

function isInside(candidate, root) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function escapeLike(value) {
  return String(value || "").replace(/[\\%_]/g, (match) => `\\${match}`);
}

function sumBytes(rows) {
  return rows.reduce((total, row) => total + Math.max(0, Number(row.size_bytes || 0)), 0);
}

function publicError(message, statusCode, code, cause) {
  const error = new Error(message, cause ? { cause } : undefined);
  error.statusCode = statusCode;
  error.code = code;
  error.expose = true;
  return error;
}
