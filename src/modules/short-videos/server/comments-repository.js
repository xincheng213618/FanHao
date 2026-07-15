import crypto from "node:crypto";

import { LOCAL_SHORT_VIDEO_USER_ID } from "./constants.js";

export function createShortVideoCommentsRepository({ database, resolveVideo }) {
  function localComments(id) {
    const db = database();
    const currentVideo = resolveVideo(db, id);
    if (!currentVideo?.id) return null;
    const rows = db.prepare(`
      SELECT id, body, created_at, updated_at
      FROM short_video_local_comments
      WHERE local_user_id = ? AND video_id = ?
      ORDER BY created_at DESC, id DESC
      LIMIT 200
    `).all(LOCAL_SHORT_VIDEO_USER_ID, currentVideo.id);
    const remoteRows = db.prepare(`
      SELECT id, parent_id, user_id, user_name, user_avatar_url, body,
             digg_count, reply_count, ip_label, created_at, synced_at
      FROM short_video_remote_comments
      WHERE video_id = ?
      ORDER BY digg_count DESC, created_at DESC, id DESC
      LIMIT 200
    `).all(currentVideo.id);
    return {
      videoId: currentVideo.id,
      total: rows.length,
      comments: rows.map(publicLocalComment),
      remoteTotal: remoteRows.length,
      remoteComments: remoteRows.map(publicRemoteComment),
      remoteSyncedAt: String(remoteRows[0]?.synced_at || "")
    };
  }

  function importRemoteComments(id, items = [], options = {}) {
    const db = database();
    const currentVideo = requireVideo(db, id);
    const comments = Array.isArray(items) ? items.slice(0, 500) : [];
    const now = new Date().toISOString();
    const statement = db.prepare(`
      INSERT INTO short_video_remote_comments (
        id, video_id, parent_id, user_id, user_name, user_avatar_url, body,
        digg_count, reply_count, ip_label, created_at, raw_json, synced_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        video_id=excluded.video_id,
        parent_id=excluded.parent_id,
        user_id=excluded.user_id,
        user_name=excluded.user_name,
        user_avatar_url=excluded.user_avatar_url,
        body=excluded.body,
        digg_count=excluded.digg_count,
        reply_count=excluded.reply_count,
        ip_label=excluded.ip_label,
        created_at=excluded.created_at,
        raw_json=excluded.raw_json,
        synced_at=excluded.synced_at
    `);
    let imported = 0;
    db.exec("BEGIN IMMEDIATE");
    try {
      for (const item of comments) {
        const cid = String(item?.cid || item?.comment_id || "").trim();
        const body = String(item?.text || item?.body || "").trim();
        if (!cid || !body) continue;
        const user = item?.user && typeof item.user === "object" ? item.user : {};
        const avatarList = user?.avatar_thumb?.url_list || user?.avatarThumb?.urlList || [];
        const createdTimestamp = Number(item?.create_time || item?.createTime || 0);
        statement.run(
          `douyin:${cid}`,
          currentVideo.id,
          String(item?.reply_id || item?.replyId || ""),
          String(user?.sec_uid || user?.uid || ""),
          String(user?.nickname || "抖音用户"),
          String(Array.isArray(avatarList) ? avatarList[0] || "" : ""),
          body,
          Math.max(0, Number(item?.digg_count || item?.diggCount || 0)),
          Math.max(0, Number(item?.reply_comment_total || item?.replyCommentTotal || 0)),
          String(item?.ip_label || item?.ipLabel || ""),
          createdTimestamp > 0 ? new Date(createdTimestamp * 1000).toISOString() : "",
          JSON.stringify(item),
          now
        );
        imported += 1;
      }
      db.exec("COMMIT");
    } catch (error) {
      try { db.exec("ROLLBACK"); } catch {}
      throw error;
    }
    return {
      ok: true,
      imported,
      availableTotal: Math.max(imported, Number(options.availableTotal || 0)),
      ...localComments(currentVideo.id)
    };
  }

  function createLocalComment(id, options = {}) {
    const db = database();
    const currentVideo = requireVideo(db, id);
    const body = normalizeLocalCommentBody(options.body ?? options.text);
    if (!body) throw httpError("请输入评论内容", 400);
    const commentId = `local:${crypto.randomUUID()}`;
    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO short_video_local_comments (
        id, local_user_id, video_id, body, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(commentId, LOCAL_SHORT_VIDEO_USER_ID, currentVideo.id, body, now, now);
    return {
      ok: true,
      videoId: currentVideo.id,
      comment: publicLocalComment({ id: commentId, body, created_at: now, updated_at: now }),
      ...localComments(currentVideo.id)
    };
  }

  function deleteLocalComment(id, commentId) {
    const db = database();
    const currentVideo = requireVideo(db, id);
    const normalizedCommentId = String(commentId || "").trim();
    const result = db.prepare(`
      DELETE FROM short_video_local_comments
      WHERE id = ? AND local_user_id = ? AND video_id = ?
    `).run(normalizedCommentId, LOCAL_SHORT_VIDEO_USER_ID, currentVideo.id);
    if (!Number(result.changes || 0)) throw httpError("本地评论不存在", 404);
    return {
      ok: true,
      deletedId: normalizedCommentId,
      ...localComments(currentVideo.id)
    };
  }

  function requireVideo(db, id) {
    const video = resolveVideo(db, id);
    if (!video?.id) throw httpError("短视频不存在", 404);
    return video;
  }

  return {
    createLocalComment,
    deleteLocalComment,
    importRemoteComments,
    localComments
  };
}

function publicLocalComment(row = {}) {
  return {
    id: String(row.id || ""),
    body: String(row.body || ""),
    createdAt: String(row.created_at || ""),
    updatedAt: String(row.updated_at || row.created_at || "")
  };
}

function publicRemoteComment(row = {}) {
  return {
    id: String(row.id || ""),
    parentId: String(row.parent_id || ""),
    userId: String(row.user_id || ""),
    userName: String(row.user_name || "抖音用户"),
    userAvatarUrl: String(row.user_avatar_url || ""),
    body: String(row.body || ""),
    likes: Math.max(0, Number(row.digg_count || 0)),
    replyCount: Math.max(0, Number(row.reply_count || 0)),
    ipLabel: String(row.ip_label || ""),
    createdAt: String(row.created_at || ""),
    syncedAt: String(row.synced_at || "")
  };
}

function normalizeLocalCommentBody(value) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, 2000);
}

function httpError(message, statusCode) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}
