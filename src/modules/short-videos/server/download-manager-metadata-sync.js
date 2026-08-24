import { LOCAL_SHORT_VIDEO_USER_ID } from "./constants.js";
import { refreshShortVideoRelationshipFlags } from "./schema.js";

export function syncDownloadManagerSourceMemberships(targetDb, sourceDb, now = new Date().toISOString()) {
  const linkColumns = new Set(sourceDb.prepare("PRAGMA table_info(links)").all().map((row) => row.name));
  const lastSeenSql = linkColumns.has("last_seen_at")
    ? "MAX(NULLIF(l.last_seen_at, ''))"
    : linkColumns.has("downloaded_at")
      ? "MAX(NULLIF(l.downloaded_at, ''))"
      : "NULL";
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
      COALESCE(${lastSeenSql}, '') AS last_seen_at,
      ${missingFlagSql} AS is_missing_from_profile,
      ${missingAtSql} AS missing_from_profile_at
    FROM links l
    JOIN profiles p ON p.id = l.profile_id
    WHERE p.tab IN ('like', 'post')
      AND TRIM(COALESCE(l.aweme_id, '')) <> ''
    GROUP BY l.aweme_id, p.tab, p.id
  `).all(now);
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
      last_seen_at = CASE
        WHEN excluded.last_seen_at > short_video_source_memberships.last_seen_at THEN excluded.last_seen_at
        ELSE short_video_source_memberships.last_seen_at
      END,
      is_missing_from_profile = excluded.is_missing_from_profile,
      missing_from_profile_at = excluded.missing_from_profile_at,
      updated_at = excluded.updated_at
    WHERE
      (short_video_source_memberships.first_seen_at = '' AND excluded.first_seen_at <> '')
      OR excluded.last_seen_at > short_video_source_memberships.last_seen_at
      OR short_video_source_memberships.is_missing_from_profile IS NOT excluded.is_missing_from_profile
      OR short_video_source_memberships.missing_from_profile_at IS NOT excluded.missing_from_profile_at
  `);
  const remove = targetDb.prepare(`
    DELETE FROM short_video_source_memberships
    WHERE aweme_id = ? AND source_type = ? AND source_profile_id = ?
  `);
  let membershipsChanged = 0;
  let actionsChanged = 0;
  let originsChanged = 0;
  let relationshipFlagsChanged = 0;
  targetDb.exec("BEGIN");
  try {
    for (const row of sourceRows) {
      const isMissing = Number(row.is_missing_from_profile || 0) ? 1 : 0;
      membershipsChanged += changedRows(upsert.run(
        row.aweme_id,
        row.source_type,
        row.source_profile_id,
        row.first_seen_at || now,
        row.last_seen_at || "",
        isMissing,
        isMissing ? row.missing_from_profile_at || "" : "",
        now
      ));
    }
    for (const row of existingRows) {
      const key = `${row.aweme_id}\u0000${row.source_type}\u0000${row.source_profile_id}`;
      if (!desiredKeys.has(key)) {
        membershipsChanged += changedRows(remove.run(row.aweme_id, row.source_type, row.source_profile_id));
      }
    }

    actionsChanged += changedRows(targetDb.prepare(`
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
    `).run(LOCAL_SHORT_VIDEO_USER_ID));
    actionsChanged += changedRows(targetDb.prepare(`
      INSERT INTO short_video_user_actions (
        local_user_id, video_id, action_type, active, source, baseline_active, acted_at, updated_at
      )
      SELECT ?, v.id, 'like', 1, 'download_manager', 1,
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
        source = 'download_manager',
        baseline_active = 1,
        updated_at = excluded.updated_at
      WHERE short_video_user_actions.source <> 'local_web'
        AND (short_video_user_actions.active IS NOT 1
          OR short_video_user_actions.source IS NOT 'download_manager'
          OR short_video_user_actions.baseline_active IS NOT 1)
    `).run(LOCAL_SHORT_VIDEO_USER_ID, now, now));

    originsChanged += changedRows(targetDb.prepare(`
      WITH computed AS (
        SELECT
          short_videos.id,
          CASE
            WHEN EXISTS (
              SELECT 1 FROM short_video_source_memberships membership
              WHERE membership.aweme_id = short_videos.aweme_id AND membership.source_type = 'like'
            ) THEN 'douyin_download_manager_like'
            WHEN EXISTS (
              SELECT 1 FROM short_video_source_memberships membership
              WHERE membership.aweme_id = short_videos.aweme_id AND membership.source_type = 'post'
            ) THEN 'douyin_download_manager_post'
            WHEN short_videos.origin = 'douyin_like_import' THEN 'local_import'
            ELSE short_videos.origin
          END AS next_origin
        FROM short_videos
        WHERE short_videos.origin IN ('douyin_like_import', 'douyin_download_manager_like', 'douyin_download_manager_post')
           OR EXISTS (
             SELECT 1 FROM short_video_source_memberships membership
             WHERE membership.aweme_id = short_videos.aweme_id
           )
      )
      UPDATE short_videos
      SET origin = computed.next_origin,
          updated_at = ?
      FROM computed
      WHERE short_videos.id = computed.id
        AND short_videos.origin IS NOT computed.next_origin
    `).run(now));
    refreshShortVideoRelationshipFlags(targetDb);
    relationshipFlagsChanged = lastStatementChanges(targetDb);
    targetDb.exec("COMMIT");
  } catch (error) {
    try {
      targetDb.exec("ROLLBACK");
    } catch {}
    throw error;
  }
  return {
    membershipsSeen: sourceRows.length,
    membershipsChanged,
    actionsChanged,
    originsChanged,
    relationshipFlagsChanged,
    catalogChanges: membershipsChanged + actionsChanged + originsChanged + relationshipFlagsChanged
  };
}

export function syncDownloadManagerProfiles(targetDb, sourceDb, userUpsert, now = new Date().toISOString()) {
  const profileColumns = new Set(sourceDb.prepare("PRAGMA table_info(profiles)").all().map((row) => row.name));
  if (!profileColumns.has("sec_uid")) return emptyProfileSyncResult();
  const profileRows = sourceDb.prepare(`
    SELECT *
    FROM profiles
    WHERE TRIM(COALESCE(sec_uid, '')) <> ''
  `).all();
  const hasNicknameHistory = profileColumns.has("nickname_history_json");
  const hasFavoritedHistory = profileColumns.has("total_favorited_history_json");
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
    SET author_name = ?1,
        updated_at = ?2
    WHERE author_sec_uid = ?3
      AND ?1 <> ''
      AND COALESCE(author_name, '') IS NOT ?1
  `);
  const targetProfileHistory = targetDb.prepare(`
    SELECT nickname, total_favorited, nickname_history_json, total_favorited_history_json,
           profile_collected_at, updated_at
    FROM short_video_users
    WHERE id = ?
  `);
  const profileHistoryUpdate = targetDb.prepare(`
    UPDATE short_video_users
    SET nickname_history_json = ?1,
        total_favorited_history_json = ?2,
        updated_at = ?3
    WHERE id = ?4
      AND (
        nickname_history_json IS NOT ?1
        OR total_favorited_history_json IS NOT ?2
      )
  `);
  const accountStateUpdate = profileColumns.has("account_status")
    ? targetDb.prepare(`
        UPDATE short_video_users
        SET account_status = ?1,
            account_status_reason = ?2,
            account_status_detected_at = ?3,
            updated_at = ?4
        WHERE id = ?5
          AND (
            account_status IS NOT ?1
            OR account_status_reason IS NOT ?2
            OR account_status_detected_at IS NOT ?3
          )
      `)
    : null;
  let profileUsersChanged = 0;
  let accountStatesChanged = 0;
  let videoAuthorsChanged = 0;
  let profileHistoriesChanged = 0;
  targetDb.exec("BEGIN");
  try {
    for (const [secUid, candidate] of bestBySecUid) {
      const row = candidate.row;
      const nickname = String(row.nickname || "").trim();
      const userId = `douyin:${secUid}`;
      const previous = targetProfileHistory.get(userId) || {};
      profileUsersChanged += changedRows(userUpsert.run(
        userId,
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
      ));
      const observedAt = String(row.profile_collected_at || row.updated_at || now);
      const previousAt = String(previous.profile_collected_at || previous.updated_at || observedAt);
      const nicknameHistory = mergeProfileObservationHistory(
        [previous.nickname_history_json, hasNicknameHistory ? row.nickname_history_json : "[]"],
        [{ value: previous.nickname, observedAt: previousAt }, { value: nickname, observedAt }]
      );
      const favoritedHistory = mergeProfileObservationHistory(
        [previous.total_favorited_history_json, hasFavoritedHistory ? row.total_favorited_history_json : "[]"],
        [{ value: previous.total_favorited, observedAt: previousAt }, { value: row.total_favorited, observedAt }],
        { numeric: true }
      );
      profileHistoriesChanged += changedRows(profileHistoryUpdate.run(
        nicknameHistory,
        favoritedHistory,
        now,
        userId
      ));
      const accountState = accountStateBySecUid.get(secUid);
      if (accountStateUpdate && accountState) {
        accountStatesChanged += changedRows(accountStateUpdate.run(
          accountState.status,
          accountState.reason,
          accountState.detectedAt,
          now,
          userId
        ));
      }
      videoAuthorsChanged += changedRows(videoAuthorNameUpdate.run(nickname, now, secUid));
    }
    targetDb.exec("COMMIT");
  } catch (error) {
    try {
      targetDb.exec("ROLLBACK");
    } catch {}
    throw error;
  }
  return {
    profilesSeen: bestBySecUid.size,
    profilesChanged: profileUsersChanged + accountStatesChanged + videoAuthorsChanged + profileHistoriesChanged,
    profileUsersChanged,
    accountStatesChanged,
    videoAuthorsChanged,
    profileHistoriesChanged
  };
}

function emptyProfileSyncResult() {
  return {
    profilesSeen: 0,
    profilesChanged: 0,
    profileUsersChanged: 0,
    accountStatesChanged: 0,
    videoAuthorsChanged: 0,
    profileHistoriesChanged: 0
  };
}

function changedRows(result) {
  return Number(result?.changes || 0);
}

function lastStatementChanges(db) {
  return Number(db.prepare("SELECT changes() AS value").get()?.value || 0);
}

function optionalInteger(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? Math.floor(number) : null;
}

function mergeProfileObservationHistory(rawHistories, observations, options = {}) {
  const numeric = options.numeric === true;
  const byValue = new Map();
  const append = (value, firstSeenAt = "", lastSeenAt = firstSeenAt) => {
    const normalized = numeric ? optionalInteger(value) : String(value || "").trim();
    if (normalized === null || normalized === "") return;
    const key = `${typeof normalized}:${normalized}`;
    const first = String(firstSeenAt || lastSeenAt || "");
    const last = String(lastSeenAt || firstSeenAt || "");
    const current = byValue.get(key);
    if (current) {
      current.first_seen_at = [current.first_seen_at, first].filter(Boolean).sort()[0] || "";
      current.last_seen_at = [current.last_seen_at, last].filter(Boolean).sort().at(-1) || "";
      return;
    }
    byValue.set(key, { value: normalized, first_seen_at: first, last_seen_at: last });
  };
  for (const raw of rawHistories || []) {
    let entries = raw;
    if (typeof raw === "string") {
      try { entries = JSON.parse(raw); } catch { entries = []; }
    }
    for (const item of Array.isArray(entries) ? entries : []) {
      if (item && typeof item === "object") append(item.value, item.first_seen_at, item.last_seen_at);
      else append(item);
    }
  }
  for (const observation of observations || []) {
    append(observation?.value, observation?.observedAt, observation?.observedAt);
  }
  return JSON.stringify([...byValue.values()]
    .sort((left, right) => String(left.last_seen_at).localeCompare(String(right.last_seen_at)) || String(left.value).localeCompare(String(right.value), "zh-CN"))
    .slice(-64));
}
