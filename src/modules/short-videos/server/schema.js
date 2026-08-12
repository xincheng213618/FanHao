import { LOCAL_SHORT_VIDEO_USER_ID, SHORT_VIDEO_RECOMMENDATION_SCORE_SQL } from "./constants.js";

const SHORT_VIDEO_TOPIC_INDEX_VERSION = "1";
const SHORT_VIDEO_SOUND_INDEX_VERSION = "1";

export function ensureShortVideoColumns(db) {
  addColumnIfMissing(db, "short_videos", "owner_user_id", "TEXT NOT NULL DEFAULT ''");
  addColumnIfMissing(db, "short_videos", "origin", "TEXT NOT NULL DEFAULT 'douyin_like_import'");
  addColumnIfMissing(db, "short_videos", "status", "TEXT NOT NULL DEFAULT 'normal'");
  addColumnIfMissing(db, "short_videos", "visibility", "TEXT NOT NULL DEFAULT 'local_only'");
  addColumnIfMissing(db, "short_videos", "media_type", "TEXT NOT NULL DEFAULT 'video'");
  addColumnIfMissing(db, "short_videos", "is_liked", "INTEGER NOT NULL DEFAULT 0");
  addColumnIfMissing(db, "short_videos", "author_following", "INTEGER NOT NULL DEFAULT 0");
  addColumnIfMissing(db, "short_videos", "liked_sort_at", "TEXT NOT NULL DEFAULT ''");
  addColumnIfMissing(db, "short_videos", "liked_sort_time", "REAL");
  addColumnIfMissing(db, "short_videos", "metadata_json", "TEXT NOT NULL DEFAULT '{}'");
  addColumnIfMissing(db, "short_videos", "cover_source", "TEXT NOT NULL DEFAULT ''");
  addColumnIfMissing(db, "short_videos", "actual_width", "INTEGER NOT NULL DEFAULT 0");
  addColumnIfMissing(db, "short_videos", "actual_height", "INTEGER NOT NULL DEFAULT 0");
  addColumnIfMissing(db, "short_videos", "actual_bit_rate", "INTEGER NOT NULL DEFAULT 0");
  addColumnIfMissing(db, "short_videos", "actual_codec", "TEXT NOT NULL DEFAULT ''");
  addColumnIfMissing(db, "short_videos", "actual_frame_rate", "REAL NOT NULL DEFAULT 0");
  addColumnIfMissing(db, "short_videos", "actual_pixels", "INTEGER NOT NULL DEFAULT 0");
  addColumnIfMissing(db, "short_videos", "actual_long_edge", "INTEGER NOT NULL DEFAULT 0");
  addColumnIfMissing(db, "short_videos", "actual_probed_at", "TEXT NOT NULL DEFAULT ''");
  addColumnIfMissing(db, "short_videos", "actual_probe_error", "TEXT NOT NULL DEFAULT ''");
  addColumnIfMissing(db, "short_video_users", "profile_url", "TEXT NOT NULL DEFAULT ''");
  addColumnIfMissing(db, "short_video_users", "unique_id", "TEXT NOT NULL DEFAULT ''");
  addColumnIfMissing(db, "short_video_users", "short_id", "TEXT NOT NULL DEFAULT ''");
  addColumnIfMissing(db, "short_video_users", "ip_location", "TEXT NOT NULL DEFAULT ''");
  addColumnIfMissing(db, "short_video_users", "total_favorited", "INTEGER");
  addColumnIfMissing(db, "short_video_users", "aweme_count", "INTEGER");
  addColumnIfMissing(db, "short_video_users", "favoriting_count", "INTEGER");
  addColumnIfMissing(db, "short_video_users", "gender", "INTEGER");
  addColumnIfMissing(db, "short_video_users", "age", "INTEGER");
  addColumnIfMissing(db, "short_video_users", "verification", "TEXT NOT NULL DEFAULT ''");
  addColumnIfMissing(db, "short_video_users", "profile_collected_at", "TEXT NOT NULL DEFAULT ''");
  addColumnIfMissing(db, "short_video_users", "account_status", "TEXT NOT NULL DEFAULT 'active'");
  addColumnIfMissing(db, "short_video_users", "account_status_reason", "TEXT NOT NULL DEFAULT ''");
  addColumnIfMissing(db, "short_video_users", "account_status_detected_at", "TEXT NOT NULL DEFAULT ''");
  addColumnIfMissing(db, "short_video_source_memberships", "is_missing_from_profile", "INTEGER NOT NULL DEFAULT 0");
  addColumnIfMissing(db, "short_video_source_memberships", "missing_from_profile_at", "TEXT NOT NULL DEFAULT ''");
  addColumnIfMissing(db, "short_video_user_actions", "baseline_active", "INTEGER NOT NULL DEFAULT 0");
  db.exec(`
    UPDATE short_videos
    SET media_type = CASE
      WHEN id IN (SELECT video_id FROM short_video_assets WHERE asset_type = 'video') THEN 'video'
      ELSE 'gallery'
    END
    WHERE media_type NOT IN ('video', 'gallery')
       OR media_type <> CASE
         WHEN id IN (SELECT video_id FROM short_video_assets WHERE asset_type = 'video') THEN 'video'
         ELSE 'gallery'
       END;
    CREATE INDEX IF NOT EXISTS idx_short_videos_owner ON short_videos(owner_user_id);
    CREATE INDEX IF NOT EXISTS idx_short_videos_origin ON short_videos(origin);
    CREATE INDEX IF NOT EXISTS idx_short_videos_media_published
      ON short_videos(media_type, visibility, published_at DESC, liked_at DESC, id DESC);
    CREATE INDEX IF NOT EXISTS idx_short_videos_media_digg
      ON short_videos(media_type, visibility, digg_count DESC, liked_at DESC, id DESC);
    CREATE INDEX IF NOT EXISTS idx_short_videos_smooth_digg
      ON short_videos(digg_count DESC, liked_at DESC, id DESC)
      WHERE visibility = 'local_only'
        AND media_type = 'video'
        AND actual_long_edge >= 2160
        AND source_path <> '';
    CREATE INDEX IF NOT EXISTS idx_short_videos_following_media_digg
      ON short_videos(author_following, media_type, visibility, digg_count DESC, liked_at DESC, id DESC);
    CREATE INDEX IF NOT EXISTS idx_short_videos_following_media_published
      ON short_videos(author_following, media_type, visibility, published_at DESC, liked_at DESC, id DESC);
    CREATE INDEX IF NOT EXISTS idx_short_videos_media_pixels
      ON short_videos(media_type, actual_pixels DESC, id);
    CREATE INDEX IF NOT EXISTS idx_short_videos_liked_sort
      ON short_videos(is_liked, media_type, visibility, liked_sort_time DESC, liked_sort_at DESC, published_at DESC, id DESC);
    CREATE INDEX IF NOT EXISTS idx_short_videos_liked_sort_all
      ON short_videos(is_liked, visibility, liked_sort_time DESC, liked_sort_at DESC, published_at DESC, id DESC);
    CREATE INDEX IF NOT EXISTS idx_short_videos_actual_pixels ON short_videos(actual_pixels DESC, id);
    CREATE INDEX IF NOT EXISTS idx_short_videos_actual_long_edge ON short_videos(actual_long_edge DESC, id);
    CREATE INDEX IF NOT EXISTS idx_short_video_users_unique_id ON short_video_users(unique_id);
    CREATE INDEX IF NOT EXISTS idx_short_video_users_account_status ON short_video_users(account_status, id);
  `);
  refreshShortVideoRelationshipFlags(db);
  refreshShortVideoAuthorFollowingFlags(db);
  backfillShortVideoShareUrls(db);
  migrateShortVideoCoverSources(db);
  ensureShortVideoTopics(db);
  ensureShortVideoSounds(db);
}

export function ensureShortVideoCollectionSchema(db, testHooks = {}) {
  const collectionColumns = new Set(db.prepare("PRAGMA table_info(short_video_collections)").all().map((row) => row.name));
  const foreignKeys = db.prepare("PRAGMA foreign_key_list(short_video_collection_items)").all();
  const cascadeTargets = new Set(foreignKeys
    .filter((row) => String(row.on_delete || "").toUpperCase() === "CASCADE")
    .map((row) => `${row.from}:${row.table}:${row.to}`));
  const hasUniqueName = db.prepare("PRAGMA index_list(short_video_collections)").all().some((index) => {
    if (!Number(index.unique || 0)) return false;
    const columns = db.prepare(`PRAGMA index_info(${quotedSqlIdentifier(index.name)})`).all().map((row) => row.name);
    return columns.length === 2 && columns[0] === "local_user_id" && columns[1] === "normalized_name";
  });
  if (
    collectionColumns.has("normalized_name")
    && hasUniqueName
    && cascadeTargets.has("collection_id:short_video_collections:id")
    && cascadeTargets.has("video_id:short_videos:id")
  ) return;

  const collections = db.prepare(`
    SELECT id, local_user_id, name, sort_order, created_at, updated_at
    FROM short_video_collections
    ORDER BY local_user_id, sort_order, created_at, id
  `).all();
  const migrated = normalizedCollectionRows(collections);
  const originalForeignKeys = Number(db.prepare("PRAGMA foreign_keys").get()?.foreign_keys || 0) === 1;
  db.exec("PRAGMA foreign_keys = OFF");
  try {
    db.exec("BEGIN IMMEDIATE");
    db.exec(`
      DROP TABLE IF EXISTS short_video_collection_items_next;
      DROP TABLE IF EXISTS short_video_collections_next;
      CREATE TABLE short_video_collections_next (
        id TEXT PRIMARY KEY,
        local_user_id TEXT NOT NULL,
        name TEXT NOT NULL,
        normalized_name TEXT NOT NULL,
        sort_order INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT '',
        updated_at TEXT NOT NULL DEFAULT '',
        UNIQUE(local_user_id, normalized_name)
      );
      CREATE TABLE short_video_collection_items_next (
        collection_id TEXT NOT NULL,
        video_id TEXT NOT NULL,
        added_at TEXT NOT NULL DEFAULT '',
        PRIMARY KEY(collection_id, video_id),
        FOREIGN KEY(collection_id) REFERENCES short_video_collections_next(id) ON UPDATE CASCADE ON DELETE CASCADE,
        FOREIGN KEY(video_id) REFERENCES short_videos(id) ON UPDATE CASCADE ON DELETE CASCADE
      );
    `);
    testHooks.afterCreateNextTables?.({ db });
    const insertCollection = db.prepare(`
      INSERT INTO short_video_collections_next (
        id, local_user_id, name, normalized_name, sort_order, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    for (const row of migrated) {
      insertCollection.run(
        row.id,
        row.local_user_id,
        row.name,
        row.normalized_name,
        row.sort_order,
        row.created_at,
        row.updated_at
      );
    }
    db.exec(`
      INSERT OR IGNORE INTO short_video_collection_items_next (collection_id, video_id, added_at)
      SELECT item.collection_id, item.video_id, item.added_at
      FROM short_video_collection_items item
      JOIN short_video_collections_next collection ON collection.id = item.collection_id
      JOIN short_videos video ON video.id = item.video_id;
      DROP TABLE short_video_collection_items;
      DROP TABLE short_video_collections;
      ALTER TABLE short_video_collections_next RENAME TO short_video_collections;
      ALTER TABLE short_video_collection_items_next RENAME TO short_video_collection_items;
    `);
    db.exec("COMMIT");
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch {}
    throw error;
  } finally {
    db.exec(`PRAGMA foreign_keys = ${originalForeignKeys ? "ON" : "OFF"}`);
  }
  const violations = db.prepare("PRAGMA foreign_key_check(short_video_collection_items)").all();
  if (violations.length) throw new Error("short-video collection foreign-key migration failed");
}

function normalizedCollectionRows(rows = []) {
  const used = new Set();
  return rows.map((row, index) => {
    const localUserId = String(row.local_user_id || LOCAL_SHORT_VIDEO_USER_ID);
    const original = normalizedCollectionDisplayName(row.name) || `清单 ${index + 1}`;
    let name = truncateUnicode(original, 40);
    let normalizedName = normalizedCollectionNameKey(name);
    let suffix = 2;
    while (used.has(`${localUserId}\u0000${normalizedName}`)) {
      const marker = ` (${suffix})`;
      name = `${truncateUnicode(original, Math.max(1, 40 - Array.from(marker).length))}${marker}`;
      normalizedName = normalizedCollectionNameKey(name);
      suffix += 1;
    }
    used.add(`${localUserId}\u0000${normalizedName}`);
    return {
      ...row,
      local_user_id: localUserId,
      name,
      normalized_name: normalizedName
    };
  });
}

function normalizedCollectionDisplayName(value) {
  return String(value ?? "").normalize("NFKC").replace(/\s+/gu, " ").trim();
}

function normalizedCollectionNameKey(value) {
  return normalizedCollectionDisplayName(value).toLowerCase();
}

function truncateUnicode(value, maxLength) {
  return Array.from(String(value || "")).slice(0, Math.max(0, Number(maxLength || 0))).join("");
}

function quotedSqlIdentifier(value) {
  return `'${String(value || "").replaceAll("'", "''")}'`;
}

function ensureShortVideoTopics(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS short_video_topics (
      video_id TEXT NOT NULL,
      topic TEXT NOT NULL,
      topic_key TEXT NOT NULL,
      PRIMARY KEY (video_id, topic_key)
    );
    CREATE INDEX IF NOT EXISTS idx_short_video_topics_key ON short_video_topics(topic_key, video_id);
    CREATE INDEX IF NOT EXISTS idx_short_video_topics_video ON short_video_topics(video_id);

    DROP TRIGGER IF EXISTS trg_short_video_topics_insert;
    DROP TRIGGER IF EXISTS trg_short_video_topics_update;
    DROP TRIGGER IF EXISTS trg_short_video_topics_delete;

    CREATE TRIGGER trg_short_video_topics_insert
    AFTER INSERT ON short_videos
    BEGIN
      INSERT OR REPLACE INTO short_video_topics (video_id, topic, topic_key)
      SELECT
        NEW.id,
        TRIM(LTRIM(CAST(topic_tag.value AS TEXT), '#')),
        LOWER(TRIM(LTRIM(CAST(topic_tag.value AS TEXT), '#')))
      FROM json_each(CASE WHEN json_valid(NEW.tags_json) THEN NEW.tags_json ELSE '[]' END) AS topic_tag
      WHERE LENGTH(TRIM(LTRIM(CAST(topic_tag.value AS TEXT), '#'))) BETWEEN 1 AND 48
      GROUP BY LOWER(TRIM(LTRIM(CAST(topic_tag.value AS TEXT), '#')));
    END;

    CREATE TRIGGER trg_short_video_topics_update
    AFTER UPDATE OF tags_json ON short_videos
    BEGIN
      DELETE FROM short_video_topics WHERE video_id = NEW.id;
      INSERT OR REPLACE INTO short_video_topics (video_id, topic, topic_key)
      SELECT
        NEW.id,
        TRIM(LTRIM(CAST(topic_tag.value AS TEXT), '#')),
        LOWER(TRIM(LTRIM(CAST(topic_tag.value AS TEXT), '#')))
      FROM json_each(CASE WHEN json_valid(NEW.tags_json) THEN NEW.tags_json ELSE '[]' END) AS topic_tag
      WHERE LENGTH(TRIM(LTRIM(CAST(topic_tag.value AS TEXT), '#'))) BETWEEN 1 AND 48
      GROUP BY LOWER(TRIM(LTRIM(CAST(topic_tag.value AS TEXT), '#')));
    END;

    CREATE TRIGGER trg_short_video_topics_delete
    AFTER DELETE ON short_videos
    BEGIN
      DELETE FROM short_video_topics WHERE video_id = OLD.id;
    END;
  `);
  if (metaValue(db, "short_video_topic_index_version") === SHORT_VIDEO_TOPIC_INDEX_VERSION) return;
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec(`
      DELETE FROM short_video_topics;
      INSERT OR REPLACE INTO short_video_topics (video_id, topic, topic_key)
      SELECT
        v.id,
        TRIM(LTRIM(CAST(topic_tag.value AS TEXT), '#')),
        LOWER(TRIM(LTRIM(CAST(topic_tag.value AS TEXT), '#')))
      FROM short_videos v
      JOIN json_each(CASE WHEN json_valid(v.tags_json) THEN v.tags_json ELSE '[]' END) AS topic_tag
      WHERE LENGTH(TRIM(LTRIM(CAST(topic_tag.value AS TEXT), '#'))) BETWEEN 1 AND 48
      GROUP BY v.id, LOWER(TRIM(LTRIM(CAST(topic_tag.value AS TEXT), '#')));
      INSERT OR REPLACE INTO short_video_meta (key, value)
      VALUES ('short_video_topic_index_version', '${SHORT_VIDEO_TOPIC_INDEX_VERSION}');
    `);
    db.exec("COMMIT");
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {}
    throw error;
  }
}

export function ensureShortVideoSearchIndex(db) {
  db.exec(`
    DROP TRIGGER IF EXISTS short_video_search_ai;
    DROP TRIGGER IF EXISTS short_video_search_ad;
    DROP TRIGGER IF EXISTS short_video_search_au;
    DROP TABLE IF EXISTS short_video_search;
    CREATE VIRTUAL TABLE short_video_search USING fts5(
      video_id UNINDEXED,
      media_type UNINDEXED,
      visibility UNINDEXED,
      published_at UNINDEXED,
      author_sec_uid UNINDEXED,
      tags_json UNINDEXED,
      title,
      description,
      author_name,
      aweme_id,
      tags_text,
      tokenize = 'trigram'
    );
    CREATE TRIGGER short_video_search_ai AFTER INSERT ON short_videos BEGIN
      INSERT INTO short_video_search(
        rowid, video_id, media_type, visibility, published_at, author_sec_uid, tags_json,
        title, description, author_name, aweme_id, tags_text
      ) VALUES (
        new.rowid, new.id, new.media_type, new.visibility, new.published_at, new.author_sec_uid, new.tags_json,
        new.title, new.description, new.author_name, new.aweme_id, new.tags_text
      );
    END;
    CREATE TRIGGER short_video_search_ad AFTER DELETE ON short_videos BEGIN
      DELETE FROM short_video_search WHERE rowid = old.rowid;
    END;
    CREATE TRIGGER short_video_search_au
    AFTER UPDATE OF
      id, media_type, visibility, published_at, author_sec_uid, tags_json,
      title, description, author_name, aweme_id, tags_text
    ON short_videos BEGIN
      DELETE FROM short_video_search WHERE rowid = old.rowid;
      INSERT INTO short_video_search(
        rowid, video_id, media_type, visibility, published_at, author_sec_uid, tags_json,
        title, description, author_name, aweme_id, tags_text
      ) VALUES (
        new.rowid, new.id, new.media_type, new.visibility, new.published_at, new.author_sec_uid, new.tags_json,
        new.title, new.description, new.author_name, new.aweme_id, new.tags_text
      );
    END;
    INSERT INTO short_video_search(
      rowid, video_id, media_type, visibility, published_at, author_sec_uid, tags_json,
      title, description, author_name, aweme_id, tags_text
    )
    SELECT
      rowid, id, media_type, visibility, published_at, author_sec_uid, tags_json,
      title, description, author_name, aweme_id, tags_text
    FROM short_videos;
  `);
}

function ensureShortVideoSounds(db) {
  const insertNew = shortVideoSoundIndexSelect("NEW");
  db.exec(`
    CREATE TABLE IF NOT EXISTS short_video_sounds (
      video_id TEXT PRIMARY KEY,
      sound_key TEXT NOT NULL,
      sound_id TEXT NOT NULL DEFAULT '',
      title TEXT NOT NULL DEFAULT '',
      author TEXT NOT NULL DEFAULT '',
      cover_url TEXT NOT NULL DEFAULT '',
      preview_url TEXT NOT NULL DEFAULT '',
      local_available INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_short_video_sounds_key ON short_video_sounds(sound_key, video_id);

    CREATE TRIGGER IF NOT EXISTS trg_short_video_sounds_insert
    AFTER INSERT ON short_videos
    BEGIN
      INSERT OR REPLACE INTO short_video_sounds (
        video_id, sound_key, sound_id, title, author, cover_url, preview_url, local_available
      )
      ${insertNew};
    END;

    CREATE TRIGGER IF NOT EXISTS trg_short_video_sounds_update
    AFTER UPDATE OF metadata_json, music_path, author_name ON short_videos
    BEGIN
      DELETE FROM short_video_sounds WHERE video_id = NEW.id;
      INSERT OR REPLACE INTO short_video_sounds (
        video_id, sound_key, sound_id, title, author, cover_url, preview_url, local_available
      )
      ${insertNew};
    END;

    CREATE TRIGGER IF NOT EXISTS trg_short_video_sounds_delete
    AFTER DELETE ON short_videos
    BEGIN
      DELETE FROM short_video_sounds WHERE video_id = OLD.id;
    END;
  `);
  if (metaValue(db, "short_video_sound_index_version") === SHORT_VIDEO_SOUND_INDEX_VERSION) return;
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec(`
      DELETE FROM short_video_sounds;
      INSERT OR REPLACE INTO short_video_sounds (
        video_id, sound_key, sound_id, title, author, cover_url, preview_url, local_available
      )
      ${shortVideoSoundIndexSelect("v", "FROM short_videos v")};
      INSERT OR REPLACE INTO short_video_meta (key, value)
      VALUES ('short_video_sound_index_version', '${SHORT_VIDEO_SOUND_INDEX_VERSION}');
    `);
    db.exec("COMMIT");
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {}
    throw error;
  }
}

function shortVideoSoundIndexSelect(rowReference, fromClause = "") {
  const row = String(rowReference || "v");
  return `
    SELECT
      indexed.video_id,
      indexed.sound_key,
      indexed.sound_id,
      indexed.title,
      indexed.author,
      indexed.cover_url,
      indexed.preview_url,
      indexed.local_available
    FROM (
      SELECT
        source.*,
        CASE
          WHEN source.title <> ''
            AND source.author <> ''
            AND source.is_original_sound = 0
            AND source.title NOT LIKE '%创作的原声%'
            AND LOWER(source.title) <> '模板音乐'
            THEN 'track:' || LOWER(source.title) || CHAR(31) || LOWER(source.author)
          WHEN source.sound_id <> '' THEN 'id:' || source.sound_id
          WHEN source.local_available = 1 THEN 'local:' || source.video_id
          ELSE ''
        END AS sound_key
      FROM (
        SELECT
          ${row}.id AS video_id,
          TRIM(COALESCE(
            CAST(json_extract(${row}.metadata_json, '$.music.id_str') AS TEXT),
            CAST(json_extract(${row}.metadata_json, '$.music.mid') AS TEXT),
            ''
          )) AS sound_id,
          TRIM(COALESCE(CAST(json_extract(${row}.metadata_json, '$.music.title') AS TEXT), '')) AS title,
          TRIM(COALESCE(CAST(json_extract(${row}.metadata_json, '$.music.author') AS TEXT), '')) AS author,
          TRIM(COALESCE(
            CAST(json_extract(${row}.metadata_json, '$.music.cover_medium.url_list[0]') AS TEXT),
            CAST(json_extract(${row}.metadata_json, '$.music.cover_thumb.url_list[0]') AS TEXT),
            ''
          )) AS cover_url,
          TRIM(COALESCE(
            CAST(json_extract(${row}.metadata_json, '$.music.play_url.url_list[0]') AS TEXT),
            CAST(json_extract(${row}.metadata_json, '$.music.play_url.uri') AS TEXT),
            ''
          )) AS preview_url,
          CASE WHEN COALESCE(TRIM(${row}.music_path), '') <> '' THEN 1 ELSE 0 END AS local_available,
          CASE WHEN COALESCE(CAST(json_extract(${row}.metadata_json, '$.music.is_original_sound') AS INTEGER), 0) = 1 THEN 1 ELSE 0 END AS is_original_sound
        ${fromClause}
      ) AS source
    ) AS indexed
    WHERE indexed.sound_key <> ''
  `;
}

function addColumnIfMissing(db, table, column, definition) {
  const columns = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name));
  if (columns.has(column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

function backfillShortVideoShareUrls(db) {
  db.prepare(`
    UPDATE short_videos
    SET share_url = 'https://www.douyin.com/video/' || TRIM(aweme_id),
        updated_at = ?
    WHERE COALESCE(TRIM(share_url), '') = ''
      AND COALESCE(TRIM(aweme_id), '') <> ''
      AND TRIM(aweme_id) NOT GLOB '*[^0-9]*'
      AND LENGTH(TRIM(aweme_id)) >= 8
  `).run(new Date().toISOString());
}

function migrateShortVideoCoverSources(db) {
  const now = new Date().toISOString();
  db.prepare(`
    UPDATE short_videos
    SET cover_source = CASE
          WHEN cover_path LIKE '%short-video-covers%' THEN 'ffmpeg'
          WHEN COALESCE(TRIM(cover_path), '') <> '' THEN 'native'
          ELSE ''
        END,
        updated_at = CASE WHEN COALESCE(updated_at, '') = '' THEN ? ELSE updated_at END
    WHERE COALESCE(TRIM(cover_source), '') = ''
  `).run(now);

  db.prepare(`
    UPDATE short_video_assets
    SET asset_type = CASE
          WHEN local_path LIKE '%short-video-covers%' THEN 'ffmpeg_cover'
          ELSE 'native_cover'
        END,
        id = video_id || ':' || CASE
          WHEN local_path LIKE '%short-video-covers%' THEN 'ffmpeg_cover'
          ELSE 'native_cover'
        END,
        updated_at = CASE WHEN COALESCE(updated_at, '') = '' THEN ? ELSE updated_at END
    WHERE asset_type = 'cover'
  `).run(now);
}

export function recreateShortVideoCatalogView(db) {
  const recommendationScoreSql = SHORT_VIDEO_RECOMMENDATION_SCORE_SQL;
  db.exec(`
    DROP VIEW IF EXISTS short_video_catalog;
    DROP VIEW IF EXISTS short_video_catalog_base;
    CREATE VIEW short_video_catalog_base AS
    SELECT
      v.id,
      v.aweme_id,
      v.owner_user_id,
      v.origin,
      v.status,
      v.visibility,
      v.media_type,
      v.is_liked,
      CASE WHEN EXISTS (
        SELECT 1
        FROM short_video_source_memberships liked_membership
        WHERE liked_membership.aweme_id = v.aweme_id
          AND liked_membership.source_type = 'like'
      ) THEN 1 ELSE 0 END AS library_liked,
      COALESCE(NULLIF(u.sec_uid, ''), v.author_sec_uid) AS author_sec_uid,
      COALESCE(NULLIF(u.uid, ''), v.author_uid) AS author_uid,
      COALESCE(NULLIF(u.nickname, ''), v.author_name, '未知作者') AS author_name,
      COALESCE(NULLIF(u.avatar_url, ''), v.author_avatar_url) AS author_avatar_url,
      COALESCE(NULLIF(u.profile_url, ''), CASE WHEN COALESCE(NULLIF(u.sec_uid, ''), v.author_sec_uid) <> '' THEN 'https://www.douyin.com/user/' || COALESCE(NULLIF(u.sec_uid, ''), v.author_sec_uid) ELSE '' END) AS author_profile_url,
      COALESCE(NULLIF(u.unique_id, ''), '') AS author_unique_id,
      COALESCE(NULLIF(u.short_id, ''), '') AS author_short_id,
      COALESCE(NULLIF(u.signature, ''), '') AS author_signature,
      COALESCE(NULLIF(u.ip_location, ''), '') AS author_ip_location,
      u.follower_count AS author_follower_count,
      u.following_count AS author_following_count,
      u.total_favorited AS author_total_favorited,
      u.aweme_count AS author_aweme_count,
      u.favoriting_count AS author_favoriting_count,
      u.gender AS author_gender,
      u.age AS author_age,
      COALESCE(NULLIF(u.verification, ''), '') AS author_verification,
      COALESCE(NULLIF(u.profile_collected_at, ''), '') AS author_profile_collected_at,
      COALESCE(v.author_following, 0) AS author_following,
      CASE WHEN EXISTS (
        SELECT 1
        FROM short_video_source_memberships missing_membership
        WHERE missing_membership.aweme_id = v.aweme_id
          AND missing_membership.source_type = 'post'
          AND missing_membership.is_missing_from_profile = 1
      ) THEN 1 ELSE 0 END AS author_deleted,
      v.title,
      v.description,
      v.tags_json,
      v.tags_text,
      v.create_time,
      v.published_at,
      v.liked_at,
      v.liked_sort_at,
      v.liked_sort_time,
      v.duration_ms,
      v.width,
      v.height,
      v.actual_width,
      v.actual_height,
      v.actual_bit_rate,
      v.actual_codec,
      v.actual_frame_rate,
      v.actual_pixels,
      v.actual_long_edge,
      v.actual_probed_at,
      v.actual_probe_error,
      COALESCE(s.digg_count, v.digg_count, 0) AS digg_count,
      COALESCE(s.comment_count, v.comment_count, 0) AS comment_count,
      COALESCE(s.collect_count, v.collect_count, 0) AS collect_count,
      COALESCE(s.share_count, v.share_count, 0) AS share_count,
      COALESCE(s.play_count, v.play_count, 0) AS play_count,
      COALESCE(user_like.active, 0) AS user_like_active,
      COALESCE(user_like.source, '') AS user_like_source,
      COALESCE(user_like.baseline_active, 0) AS user_like_baseline_active,
      COALESCE(user_collect.active, 0) AS user_collect_active,
      COALESCE(user_collect.source, '') AS user_collect_source,
      COALESCE(user_dislike.active, 0) AS user_dislike_active,
      COALESCE(user_dislike.source, '') AS user_dislike_source,
      ${recommendationScoreSql} AS recommendation_score,
      COALESCE(watch_history.progress_ms, 0) AS watch_progress_ms,
      COALESCE(watch_history.completed_count, 0) AS watch_completed_count,
      COALESCE(watch_history.last_watched_at, '') AS last_watched_at,
      v.share_url,
      v.metadata_json,
      COALESCE(sound_index.sound_key, '') AS sound_key,
      COALESCE(sound_index.sound_id, '') AS sound_id,
      COALESCE(sound_index.title, '') AS sound_title,
      COALESCE(sound_index.author, '') AS sound_author,
      COALESCE(sound_index.cover_url, '') AS sound_cover_url,
      COALESCE(sound_index.preview_url, '') AS sound_preview_url,
      COALESCE(sound_index.local_available, 0) AS sound_local_available,
      COALESCE(NULLIF(video_asset.local_path, ''), v.source_path) AS source_path,
      COALESCE(
        NULLIF(native_cover_asset.local_path, ''),
        CASE WHEN v.cover_source = 'native' THEN NULLIF(v.cover_path, '') ELSE NULL END,
        NULLIF(ffmpeg_cover_asset.local_path, ''),
        CASE WHEN v.cover_source = 'ffmpeg' THEN NULLIF(v.cover_path, '') ELSE NULL END,
        NULLIF(legacy_cover_asset.local_path, ''),
        NULLIF(v.cover_path, '')
      ) AS cover_path,
      CASE
        WHEN NULLIF(native_cover_asset.local_path, '') IS NOT NULL
          OR (v.cover_source = 'native' AND NULLIF(v.cover_path, '') IS NOT NULL)
          THEN 'native'
        WHEN NULLIF(ffmpeg_cover_asset.local_path, '') IS NOT NULL
          OR (v.cover_source = 'ffmpeg' AND NULLIF(v.cover_path, '') IS NOT NULL)
          THEN 'ffmpeg'
        WHEN NULLIF(legacy_cover_asset.local_path, '') IS NOT NULL
          THEN CASE WHEN legacy_cover_asset.local_path LIKE '%short-video-covers%' THEN 'ffmpeg' ELSE 'native' END
        ELSE COALESCE(NULLIF(v.cover_source, ''), '')
      END AS cover_source,
      COALESCE(NULLIF(music_asset.local_path, ''), v.music_path) AS music_path,
      v.data_path,
      v.relative_path,
      COALESCE(NULLIF(video_asset.file_name, ''), v.file_name) AS file_name,
      COALESCE(NULLIF(video_asset.size_bytes, 0), v.size_bytes, 0) AS size_bytes,
      COALESCE(NULLIF(video_asset.mtime_ms, 0), v.mtime_ms, 0) AS mtime_ms,
      v.imported_at,
      v.updated_at
    FROM short_videos v
    LEFT JOIN short_video_users u ON u.id = v.owner_user_id
    LEFT JOIN short_video_stats s ON s.video_id = v.id
    LEFT JOIN short_video_user_actions user_like
      ON user_like.video_id = v.id
     AND user_like.local_user_id = 'local:self'
     AND user_like.action_type = 'like'
    LEFT JOIN short_video_user_actions user_collect
      ON user_collect.video_id = v.id
     AND user_collect.local_user_id = 'local:self'
     AND user_collect.action_type = 'collect'
    LEFT JOIN short_video_user_actions user_dislike
      ON user_dislike.video_id = v.id
     AND user_dislike.local_user_id = 'local:self'
     AND user_dislike.action_type = 'dislike'
    LEFT JOIN short_video_watch_history watch_history
      ON watch_history.video_id = v.id
     AND watch_history.local_user_id = 'local:self'
    LEFT JOIN short_video_assets video_asset ON video_asset.video_id = v.id AND video_asset.asset_type = 'video'
    LEFT JOIN short_video_assets native_cover_asset ON native_cover_asset.video_id = v.id AND native_cover_asset.asset_type = 'native_cover'
    LEFT JOIN short_video_assets ffmpeg_cover_asset ON ffmpeg_cover_asset.video_id = v.id AND ffmpeg_cover_asset.asset_type = 'ffmpeg_cover'
    LEFT JOIN short_video_assets legacy_cover_asset ON legacy_cover_asset.video_id = v.id AND legacy_cover_asset.asset_type = 'cover'
    LEFT JOIN short_video_assets music_asset ON music_asset.video_id = v.id AND music_asset.asset_type = 'music'
    LEFT JOIN short_video_sounds sound_index ON sound_index.video_id = v.id;

    CREATE VIEW short_video_catalog AS
    SELECT
      short_video_catalog_base.*,
      1 AS recommendation_author_rank,
      recommendation_score AS recommendation_order_score
    FROM short_video_catalog_base;
  `);
}

export function refreshShortVideoRelationshipFlags(db, videoId = "") {
  const targetId = String(videoId || "").trim();
  const targetWhere = targetId ? "WHERE v.id = ?" : "";
  db.prepare(`
    WITH computed AS (
      SELECT
        v.id,
        CASE
          WHEN EXISTS (
            SELECT 1
            FROM short_video_source_memberships membership
            WHERE membership.aweme_id = v.aweme_id
              AND membership.source_type = 'like'
          ) OR EXISTS (
            SELECT 1
            FROM short_video_user_actions manual_like
            WHERE manual_like.video_id = v.id
              AND manual_like.local_user_id = '${LOCAL_SHORT_VIDEO_USER_ID}'
              AND manual_like.action_type = 'like'
              AND manual_like.active = 1
          ) THEN 1
          ELSE 0
        END AS is_liked,
        COALESCE(
          (
            SELECT MIN(NULLIF(liked_membership.first_seen_at, ''))
            FROM short_video_source_memberships liked_membership
            WHERE liked_membership.aweme_id = v.aweme_id
              AND liked_membership.source_type = 'like'
          ),
          NULLIF(v.imported_at, ''),
          NULLIF(v.published_at, ''),
          ''
        ) AS liked_sort_at
      FROM short_videos v
      ${targetWhere}
    )
    UPDATE short_videos
    SET
      is_liked = computed.is_liked,
      liked_sort_at = computed.liked_sort_at,
      liked_sort_time = julianday(NULLIF(computed.liked_sort_at, ''))
    FROM computed
    WHERE short_videos.id = computed.id
      AND (
        short_videos.is_liked <> computed.is_liked
        OR short_videos.liked_sort_at <> computed.liked_sort_at
        OR COALESCE(short_videos.liked_sort_time, -1) <> COALESCE(julianday(NULLIF(computed.liked_sort_at, '')), -1)
      )
  `).run(...(targetId ? [targetId] : []));
}

export function refreshShortVideoAuthorFollowingFlags(db, targetUserId = "") {
  const userId = String(targetUserId || "").trim();
  const where = userId ? "WHERE v.owner_user_id = ?" : "";
  db.prepare(`
    WITH computed AS (
      SELECT
        v.id,
        CASE
          WHEN EXISTS (
            SELECT 1
            FROM short_video_follows user_follow
            WHERE user_follow.local_user_id = '${LOCAL_SHORT_VIDEO_USER_ID}'
              AND user_follow.target_user_id = v.owner_user_id
              AND user_follow.active = 1
          ) THEN 1
          ELSE 0
        END AS author_following
      FROM short_videos v
      ${where}
    )
    UPDATE short_videos
    SET author_following = computed.author_following
    FROM computed
    WHERE short_videos.id = computed.id
      AND short_videos.author_following <> computed.author_following
  `).run(...(userId ? [userId] : []));
}

function metaValue(db, key) {
  return db.prepare("SELECT value FROM short_video_meta WHERE key = ?").get(key)?.value || "";
}
