import { LOCAL_SHORT_VIDEO_USER_ID } from "./constants.js";

export function normalizedWatchTimestamp(value) {
  const timestamp = Date.parse(String(value || ""));
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : new Date().toISOString();
}

export function watchReceiptFromDatabase(database, videoId, acceptedAt) {
  if (!videoId) return null;
  const receiptAt = normalizedWatchTimestamp(acceptedAt);
  const savedWatch = database.prepare(`
    SELECT progress_ms, completed_count, last_watched_at
    FROM short_video_watch_history
    WHERE local_user_id = ? AND video_id = ? AND last_watched_at = ?
  `).get(LOCAL_SHORT_VIDEO_USER_ID, videoId, receiptAt);
  if (!savedWatch) return null;
  const completedCount = Math.max(0, Number(savedWatch.completed_count || 0));
  return {
    ok: true,
    videoId,
    watch: {
      progressMs: Math.max(0, Number(savedWatch.progress_ms || 0)),
      completedCount,
      completed: completedCount > 0,
      lastWatchedAt: savedWatch.last_watched_at || receiptAt
    }
  };
}
