import { LOCAL_SHORT_VIDEO_USER_ID } from "./constants.js";
import { refreshShortVideoRelationshipFlags } from "./schema.js";

export function syncDownloadManagerSourceMemberships(targetDb, sourceDb, now = new Date().toISOString()) {
  const linkColumns = new Set(sourceDb.prepare("PRAGMA table_info(links)").all().map((row) => row.name));
  const missingFlagSql = linkColumns.has("is_missing_from_profile")
    ? "MAX(COALESCE(l.is_missing_from_profile, 0))"
    : "0";
  const missingAtSql = linkColumns.has("missing_from_profile_at")
    ? "MAX(COALESCE(l.missing_from_profile_at, ''))"
    : "''";
  const sourceRows = sourceDb.prepare(`
    SELECT DISTINCT
      TRIM(COALESCE(l.aweme_id, '')) AS aweme_id,
      LOWER(TRIM(COALESCE(p.tab, ''))) AS source_type,
      CAST(p.id AS TEXT) AS source_profile_id,
      ? AS first_seen_at,
      ? AS last_seen_at,
      ${missingFlagSql} AS is_missing_from_profile,
      ${missingAtSql} AS missing_from_profile_at
    FROM links l
    JOIN profiles p ON p.id = l.profile_id
    WHERE p.tab IN ('like', 'post')
      AND TRIM(COALESCE(l.aweme_id, '')) <> ''
    GROUP BY l.aweme_id, p.tab, p.id
  `).all(now, now);
  const desiredKeys = new Set(sourceRows.map((row) => (
    `${row.aweme_id}\u0000${row.source_type}\u0000${row.source_profile_id}`
  )));
  const existingRows = targetDb.prepare(`
    SELECT aweme_id, source_type, source_profile_id
    FROM short_video_source_memberships
    WHERE source_type IN ('like', 'post')
  `).all();
  const upsert = targetDb.prepare(`
    INSERT INTO short_video_source_memberships (
      aweme_id, source_type, source_profile_id, first_seen_at, last_seen_at,
      is_missing_from_profile, missing_from_profile_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(aweme_id, source_type, source_profile_id) DO UPDATE SET
      first_seen_at = COALESCE(NULLIF(short_video_source_memberships.first_seen_at, ''), excluded.first_seen_at),
      last_seen_at = excluded.last_seen_at,
      is_missing_from_profile = excluded.is_missing_from_profile,
      missing_from_profile_at = excluded.missing_from_profile_at,
      updated_at = excluded.updated_at
  `);
  const remove = targetDb.prepare(`
    DELETE FROM short_video_source_memberships
    WHERE aweme_id = ? AND source_type = ? AND source_profile_id = ?
  `);
  targetDb.exec("BEGIN");
  try {
    for (const row of sourceRows) {
      upsert.run(
        row.aweme_id,
        row.source_type,
        row.source_profile_id,
        row.first_seen_at || now,
        row.last_seen_at || now,
        Number(row.is_missing_from_profile || 0) ? 1 : 0,
        row.missing_from_profile_at || "",
        now
      );
    }
    for (const row of existingRows) {
      const key = `${row.aweme_id}\u0000${row.source_type}\u0000${row.source_profile_id}`;
      if (!desiredKeys.has(key)) remove.run(row.aweme_id, row.source_type, row.source_profile_id);
    }

    targetDb.prepare(`
      DELETE FROM short_video_user_actions
      WHERE local_user_id = ?
        AND action_type = 'like'
        AND source IN ('imported', 'download_manager')
        AND video_id NOT IN (
          SELECT v.id
          FROM short_videos v
          JOIN short_video_source_memberships membership
            ON membership.aweme_id = v.aweme_id
           AND membership.source_type = 'like'
        )
    `).run(LOCAL_SHORT_VIDEO_USER_ID);
    targetDb.prepare(`
      INSERT INTO short_video_user_actions (
        local_user_id, video_id, action_type, active, source, acted_at, updated_at
      )
      SELECT ?, v.id, 'like', 1, 'download_manager',
             COALESCE(NULLIF(v.liked_at, ''), ?), ?
      FROM short_videos v
      WHERE EXISTS (
        SELECT 1
        FROM short_video_source_memberships membership
        WHERE membership.aweme_id = v.aweme_id
          AND membership.source_type = 'like'
      )
      ON CONFLICT(local_user_id, video_id, action_type) DO UPDATE SET
        active = 1,
        source = CASE
          WHEN short_video_user_actions.source = 'local_web' THEN short_video_user_actions.source
          ELSE 'download_manager'
        END,
        updated_at = excluded.updated_at
    `).run(LOCAL_SHORT_VIDEO_USER_ID, now, now);

    targetDb.prepare(`
      UPDATE short_videos
      SET origin = CASE
        WHEN EXISTS (
          SELECT 1 FROM short_video_source_memberships membership
          WHERE membership.aweme_id = short_videos.aweme_id AND membership.source_type = 'like'
        ) THEN 'douyin_download_manager_like'
        WHEN EXISTS (
          SELECT 1 FROM short_video_source_memberships membership
          WHERE membership.aweme_id = short_videos.aweme_id AND membership.source_type = 'post'
        ) THEN 'douyin_download_manager_post'
        WHEN origin = 'douyin_like_import' THEN 'local_import'
        ELSE origin
      END,
      updated_at = ?
      WHERE origin IN ('douyin_like_import', 'douyin_download_manager_like', 'douyin_download_manager_post')
         OR EXISTS (
           SELECT 1 FROM short_video_source_memberships membership
           WHERE membership.aweme_id = short_videos.aweme_id
         )
    `).run(now);
    refreshShortVideoRelationshipFlags(targetDb);
    targetDb.exec("COMMIT");
  } catch (error) {
    try {
      targetDb.exec("ROLLBACK");
    } catch {}
    throw error;
  }
}

export function syncDownloadManagerProfiles(targetDb, sourceDb, userUpsert, now = new Date().toISOString()) {
  const profileColumns = new Set(sourceDb.prepare("PRAGMA table_info(profiles)").all().map((row) => row.name));
  if (!profileColumns.has("sec_uid")) return 0;
  const profileRows = sourceDb.prepare(`
    SELECT *
    FROM profiles
    WHERE TRIM(COALESCE(sec_uid, '')) <> ''
  `).all();
  const bestBySecUid = new Map();
  const accountStateBySecUid = new Map();
  for (const row of profileRows) {
    const secUid = String(row.sec_uid || "").trim();
    if (!secUid) continue;
    const freshness = String(row.profile_collected_at || row.updated_at || "");
    const rank = `${freshness}\u0000${String(row.tab || "") === "post" ? "1" : "0"}`;
    const current = bestBySecUid.get(secUid);
    if (!current || rank >= current.rank) bestBySecUid.set(secUid, { row, rank });
    if (profileColumns.has("account_status")) {
      const status = String(row.account_status || "active").trim().toLowerCase() === "banned" ? "banned" : "active";
      const statusRank = String(row.account_status_detected_at || row.updated_at || row.profile_collected_at || "");
      const currentState = accountStateBySecUid.get(secUid);
      if (!currentState || (status === "banned" && currentState.status !== "banned") || (status === currentState.status && statusRank >= currentState.rank)) {
        accountStateBySecUid.set(secUid, {
          status,
          reason: status === "banned" ? String(row.account_status_reason || "") : "",
          detectedAt: status === "banned" ? String(row.account_status_detected_at || "") : "",
          rank: statusRank
        });
      }
    }
  }
  const videoAuthorNameUpdate = targetDb.prepare(`
    UPDATE short_videos
    SET author_name = ?,
        updated_at = ?
    WHERE author_sec_uid = ?
      AND ? <> ''
      AND COALESCE(author_name, '') <> ?
  `);
  const accountStateUpdate = profileColumns.has("account_status")
    ? targetDb.prepare(`
        UPDATE short_video_users
        SET account_status = ?,
            account_status_reason = ?,
            account_status_detected_at = ?,
            updated_at = ?
        WHERE id = ?
      `)
    : null;
  targetDb.exec("BEGIN");
  try {
    for (const [secUid, candidate] of bestBySecUid) {
      const row = candidate.row;
      const nickname = String(row.nickname || "").trim();
      userUpsert.run(
        `douyin:${secUid}`,
        "douyin",
        secUid,
        String(row.uid || ""),
        nickname,
        String(row.avatar_url || ""),
        String(row.url || ""),
        String(row.signature || ""),
        optionalInteger(row.follower_count),
        optionalInteger(row.following_count),
        String(row.profile_raw_json || "{}"),
        String(row.unique_id || ""),
        String(row.short_id || ""),
        String(row.ip_location || ""),
        optionalInteger(row.total_favorited),
        optionalInteger(row.aweme_count),
        optionalInteger(row.favoriting_count),
        optionalInteger(row.gender),
        optionalInteger(row.age),
        String(row.verification || ""),
        String(row.profile_collected_at || ""),
        String(row.created_at || now),
        now
      );
      const accountState = accountStateBySecUid.get(secUid);
      if (accountStateUpdate && accountState) {
        accountStateUpdate.run(
          accountState.status,
          accountState.reason,
          accountState.detectedAt,
          now,
          `douyin:${secUid}`
        );
      }
      videoAuthorNameUpdate.run(nickname, now, secUid, nickname, nickname);
    }
    targetDb.exec("COMMIT");
  } catch (error) {
    try {
      targetDb.exec("ROLLBACK");
    } catch {}
    throw error;
  }
  return bestBySecUid.size;
}

function optionalInteger(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? Math.floor(number) : null;
}
