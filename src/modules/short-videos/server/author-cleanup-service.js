export function createShortVideoAuthorCleanupService({ database, deleteVideos }) {
  if (typeof database !== "function" || typeof deleteVideos !== "function") {
    throw new TypeError("author cleanup dependencies are required");
  }

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
    return { preview: publicPreview(analysis), deletion };
  }

  function analyze(value) {
    const secUid = String(value || "").trim();
    if (!secUid || secUid.length > 512) throw publicError("作者标识无效", 400, "SHORT_VIDEO_AUTHOR_CLEANUP_INVALID_AUTHOR");
    const db = database();
    const user = db.prepare(`
      SELECT id, nickname
      FROM short_video_users
      WHERE platform = 'douyin' AND sec_uid = ?
      LIMIT 1
    `).get(secUid);
    const rows = db.prepare(`
      SELECT id, author_name, is_liked, COALESCE(size_bytes, 0) AS size_bytes
      FROM short_videos
      WHERE visibility = 'local_only'
        AND media_type = 'video'
        AND author_sec_uid = ?
      ORDER BY id
    `).all(secUid);
    if (!user && !rows.length) throw publicError("没有找到这个作者的本地视频", 404, "SHORT_VIDEO_AUTHOR_CLEANUP_NOT_FOUND");
    const likedRows = rows.filter((row) => Number(row.is_liked || 0) === 1);
    const deleteRows = rows.filter((row) => Number(row.is_liked || 0) !== 1);
    return {
      secUid,
      name: String(user?.nickname || rows[0]?.author_name || "未知作者").trim() || "未知作者",
      totalCount: rows.length,
      likedCount: likedRows.length,
      likedBytes: sumBytes(likedRows),
      deleteCount: deleteRows.length,
      deleteBytes: sumBytes(deleteRows),
      deleteIds: deleteRows.map((row) => String(row.id || "")).filter(Boolean)
    };
  }

  return Object.freeze({ execute, preview });
}

function publicPreview(analysis) {
  const { deleteIds, ...result } = analysis;
  return result;
}

function assertExpectedSnapshot(analysis, options) {
  for (const [key, label] of [["deleteCount", "待删除数量"], ["likedCount", "保留点赞数量"]]) {
    if (!Object.hasOwn(options, key)) continue;
    const expected = Number(options[key]);
    if (!Number.isSafeInteger(expected) || expected < 0 || expected !== analysis[key]) {
      throw publicError(`${label}已经变化，请重新预览后确认`, 409, "SHORT_VIDEO_AUTHOR_CLEANUP_CHANGED");
    }
  }
}

function sumBytes(rows) {
  return rows.reduce((total, row) => total + Math.max(0, Number(row.size_bytes || 0)), 0);
}

function publicError(message, statusCode, code) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  error.expose = true;
  return error;
}
