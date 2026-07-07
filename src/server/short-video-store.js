import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { DEFAULT_MAX_COVER_BYTES, extractCoverFrame } from "../../lib/cover-frame.js";

const VIDEO_EXTS = new Set([".mp4", ".m4v", ".mov", ".webm"]);
const IMAGE_EXTS = new Set([".jpg", ".jpeg", ".png", ".webp"]);
const AUDIO_EXTS = new Set([".mp3", ".m4a", ".aac", ".wav", ".flac"]);
const DEFAULT_LIMIT = 72;
const MAX_LIMIT = 300;
const DEFAULT_COVER_GENERATE_LIMIT = 0;
const NORMALIZED_SCHEMA_VERSION = "2";
const LOCAL_SHORT_VIDEO_USER_ID = "local:self";
const LIST_VIDEO_COLUMNS = [
  "id",
  "aweme_id",
  "owner_user_id",
  "origin",
  "status",
  "visibility",
  "title",
  "description",
  "tags_json",
  "author_sec_uid",
  "author_uid",
  "author_name",
  "author_avatar_url",
  "author_profile_url",
  "published_at",
  "liked_at",
  "duration_ms",
  "width",
  "height",
  "digg_count",
  "comment_count",
  "collect_count",
  "share_count",
  "play_count",
  "share_url",
  "cover_path",
  "cover_source",
  "mtime_ms",
  "file_name",
  "relative_path",
  "size_bytes"
].join(", ");

export function createShortVideoStore(options = {}) {
  const dbPath = options.dbPath;
  const roots = normalizeRoots(options.roots || []);
  const ffmpegPath = options.ffmpegPath || "ffmpeg";
  const coverCacheDir = options.coverCacheDir || path.join(path.dirname(dbPath || "."), "short-video-covers");
  const coverMaxBytes = clampInt(options.coverMaxBytes, DEFAULT_MAX_COVER_BYTES, 64 * 1024, 16 * 1024 * 1024);
  const coverGenerateLimit = clampInt(options.coverGenerateLimit, DEFAULT_COVER_GENERATE_LIMIT, 0, MAX_LIMIT);
  if (!dbPath) throw new Error("short video dbPath is required");
  let db = null;

  function database() {
    if (!db) {
      fs.mkdirSync(path.dirname(dbPath), { recursive: true });
      db = new DatabaseSync(dbPath);
      ensureSchema(db, coverCacheDir);
      cleanupSupersededFfmpegCovers(db, coverCacheDir);
    }
    return db;
  }

  function close() {
    if (!db) return;
    try {
      db.close();
    } catch {}
    db = null;
    catalogCache.key = null;
    catalogCache.summary = null;
    catalogCache.authors = null;
  }

  // 列表的 summary() 与 authorFacet() 每次分页都会重算（聚合 + GROUP BY），
  // 但二者只在入库（scan / importDownloadManagerDb）改变行集合时才会变化。
  // 用 scanned_at + download_manager_imported_at 两个 meta 戳做缓存键：
  // scan 写入 scanned_at、import 写入 download_manager_imported_at，自动失效，零额外查询。
  const catalogCache = { key: null, summary: null, authors: null };
  function ensureCatalogCacheKey(key) {
    if (catalogCache.key === key) return;
    catalogCache.key = key;
    catalogCache.summary = null;
    catalogCache.authors = null;
  }
  function catalogStamp() {
    const database = databaseOrOpen();
    return `${metaValue(database, "scanned_at")}::${metaValue(database, "download_manager_imported_at")}`;
  }
  function cachedSummary() {
    const key = catalogStamp();
    ensureCatalogCacheKey(key);
    if (catalogCache.key === key && catalogCache.summary) return catalogCache.summary;
    const result = summary();
    catalogCache.summary = result;
    return result;
  }
  function cachedAuthorFacet(database) {
    const key = catalogStamp();
    ensureCatalogCacheKey(key);
    if (catalogCache.key === key && catalogCache.authors) return catalogCache.authors;
    const result = authorFacet(database);
    catalogCache.authors = result;
    return result;
  }

  function facets() {
    const database = databaseOrOpen();
    return {
      summary: cachedSummary(),
      authors: cachedAuthorFacet(database)
    };
  }

  function summary() {
    const database = databaseOrOpen();
    const totals = database.prepare(`
      SELECT
        COUNT(*) AS videos,
        COUNT(DISTINCT author_sec_uid) AS authors,
        COALESCE(SUM(size_bytes), 0) AS bytes,
        COALESCE(SUM(duration_ms), 0) AS durationMs
      FROM short_video_catalog
    `).get();
    const scannedAt = metaValue(database, "scanned_at");
    const sourceRoot = metaValue(database, "source_root");
    const authorRows = database.prepare(`
      SELECT author_sec_uid, author_name, COUNT(*) AS count
      FROM short_video_catalog
      GROUP BY author_sec_uid, author_name
      ORDER BY count DESC, author_name COLLATE NOCASE
      LIMIT 30
    `).all();
    return {
      dbPath,
      roots: roots.map(rootStatus),
      sourceRoot,
      scannedAt,
      totals: {
        videos: Number(totals?.videos || 0),
        authors: Number(totals?.authors || 0),
        bytes: Number(totals?.bytes || 0),
        durationMs: Number(totals?.durationMs || 0)
      },
      topAuthors: authorRows.map((row) => ({
        secUid: row.author_sec_uid || "",
        name: row.author_name || "未知作者",
        count: Number(row.count || 0)
      }))
    };
  }

  function listVideos(urlOrOptions = {}) {
    const params = urlOrOptions?.searchParams || new URLSearchParams();
    const filter = videoFilter(params);
    const sort = normalizeSort(params.get("sort"));
    const limit = clampInt(params.get("limit"), DEFAULT_LIMIT, 1, MAX_LIMIT);
    const offset = clampInt(params.get("offset"), 0, 0, 1000000);
    const includeFacets = params.get("facets") !== "0";
    const where = filter.where ? `WHERE ${filter.where}` : "";
    const orderBy = {
      liked: "liked_at DESC, mtime_ms DESC",
      published: "published_at DESC, liked_at DESC",
      likes: "digg_count DESC, liked_at DESC",
      comments: "comment_count DESC, liked_at DESC",
      duration: "duration_ms DESC, liked_at DESC"
    }[sort] || "published_at DESC, liked_at DESC";
    const database = databaseOrOpen();
    const total = database.prepare(`SELECT COUNT(*) AS count FROM short_video_catalog ${where}`).get(...filter.args)?.count || 0;
    const rows = database.prepare(`
      SELECT ${LIST_VIDEO_COLUMNS}
      FROM short_video_catalog
      ${where}
      ORDER BY ${orderBy}, id DESC
      LIMIT ? OFFSET ?
    `).all(...filter.args, limit, offset);
    ensureGeneratedCovers(database, rows, coverGenerateLimit);
    return {
      summary: includeFacets ? cachedSummary() : null,
      total: Number(total || 0),
      limit,
      offset,
      hasMore: offset + rows.length < Number(total || 0),
      query: filter.q,
      author: filter.author,
      sort,
      authors: includeFacets ? cachedAuthorFacet(database) : [],
      videos: rows.map(publicVideo)
    };
  }

  function videoDetail(id, urlOrOptions = {}) {
    const database = databaseOrOpen();
    const row = database.prepare("SELECT * FROM short_video_catalog WHERE id = ? OR aweme_id = ?").get(id, id);
    if (!row) return null;
    ensureGeneratedCovers(database, [row], 1);
    const order = adjacentOrder(urlOrOptions);
    const filter = videoFilter(urlOrOptions?.searchParams || new URLSearchParams());
    const prev = adjacentRow(database, row, -1, order, false, filter);
    const next = adjacentRow(database, row, 1, order, false, filter);
    return {
      video: publicVideo(row, { detail: true }),
      prevId: prev?.id || "",
      nextId: next?.id || ""
    };
  }

  function adjacentVideo(id, direction, urlOrOptions = {}) {
    const database = databaseOrOpen();
    const current = database.prepare("SELECT id, liked_at FROM short_video_catalog WHERE id = ? OR aweme_id = ?").get(id, id);
    if (!current) return null;
    const fullCurrent = database.prepare("SELECT * FROM short_video_catalog WHERE id = ?").get(current.id);
    const filter = videoFilter(urlOrOptions?.searchParams || new URLSearchParams());
    const row = adjacentRow(database, fullCurrent, direction, adjacentOrder(urlOrOptions), true, filter);
    if (row) ensureGeneratedCovers(database, [row], 1);
    return row ? publicVideo(row, { detail: true }) : null;
  }

  function videoFile(id, options = {}) {
    const row = databaseOrOpen().prepare("SELECT id, source_path FROM short_video_catalog WHERE id = ? OR aweme_id = ?").get(id, id);
    if (options.allowMissing && row?.source_path) {
      return { id: row.id || id, path: path.resolve(row.source_path), type: "video", ext: path.extname(row.source_path).toLowerCase() };
    }
    return fileFromRow(row, "video");
  }

  function coverFile(id) {
    const database = databaseOrOpen();
    const row = database.prepare("SELECT * FROM short_video_catalog WHERE id = ? OR aweme_id = ?").get(id, id);
    if (row) ensureGeneratedCovers(database, [row], 1);
    if (!row?.cover_path) return null;
    return safeStoredFile(row.cover_path, "image");
  }

  function ensureGeneratedCovers(database, rows, maxCount) {
    if (!maxCount || maxCount <= 0) return;
    let generated = 0;
    for (const row of rows) {
      if (generated >= maxCount) return;
      if (!row || (row.cover_path && fs.existsSync(row.cover_path))) continue;
      const coverPath = generateCoverForRow(row);
      if (!coverPath) continue;
      row.cover_path = coverPath;
      row.cover_source = "ffmpeg";
      generated += 1;
      database.prepare(`
        UPDATE short_videos
        SET cover_path = ?,
            cover_source = 'ffmpeg',
            updated_at = ?
        WHERE id = ?
          AND COALESCE(cover_source, '') <> 'native'
      `).run(
        coverPath,
        new Date().toISOString(),
        row.id
      );
      upsertAsset(database, {
        videoId: row.id,
        assetType: "ffmpeg_cover",
        localPath: coverPath,
        fileName: path.basename(coverPath),
        sizeBytes: safeStat(coverPath)?.size || 0,
        mtimeMs: Math.floor(safeStat(coverPath)?.mtimeMs || Date.now())
      }, new Date().toISOString());
    }
  }

  function generateCoverForRow(row) {
    if (!row?.source_path || !fs.existsSync(row.source_path)) return "";
    let tempInput = null;
    try {
      fs.mkdirSync(coverCacheDir, { recursive: true });
      const coverPath = path.join(coverCacheDir, coverFileName(row));
      if (fs.existsSync(coverPath) && safeStat(coverPath)?.size > 0) return coverPath;
      tempInput = asciiInputPath(row.source_path, coverCacheDir);
      const buffer = extractCoverFrame(tempInput.path, {
        duration: Number(row.duration_ms || 0) > 0 ? Number(row.duration_ms) / 1000 : undefined,
        ffmpegPath,
        maxBytes: coverMaxBytes,
        timeoutMs: 15000
      });
      fs.writeFileSync(coverPath, buffer);
      return coverPath;
    } catch (error) {
      console.warn("[short-video-cover]", row.id || row.source_path, error.message || error);
      return "";
    } finally {
      if (tempInput?.cleanup) tempInput.cleanup();
    }
  }

  function scan(inputRoot = "") {
    const root = String(inputRoot || "").trim() ? path.resolve(String(inputRoot).trim()) : roots[0] || "";
    if (!root) {
      const error = new Error("没有配置短视频点赞目录");
      error.statusCode = 400;
      throw error;
    }
    if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
      const error = new Error(`短视频点赞目录不存在：${root}`);
      error.statusCode = 400;
      throw error;
    }

    const now = new Date().toISOString();
    const database = databaseOrOpen();
    const foundIds = new Set();
    const upsert = shortVideoUpsertStatement(database);
    const normalized = normalizedUpsertStatements(database, coverCacheDir);
    const writeBatch = (items) => {
      if (!items.length) return;
      database.exec("BEGIN");
      try {
        for (const item of items) {
          foundIds.add(item.id);
          upsert.run(...videoRowValues(item, now));
          upsertNormalizedItem(normalized, item, now, { actionSource: "imported" });
        }
        database.prepare("INSERT OR REPLACE INTO short_video_meta (key, value) VALUES ('scanned_at', ?)").run(now);
        database.prepare("INSERT OR REPLACE INTO short_video_meta (key, value) VALUES ('source_root', ?)").run(root);
        database.prepare("INSERT OR REPLACE INTO short_video_meta (key, value) VALUES ('scanner_version', '2')").run();
        database.exec("COMMIT");
      } catch (error) {
        try {
          database.exec("ROLLBACK");
        } catch {}
        throw error;
      }
    };

    let scannedFiles = 0;
    let imported = 0;
    const batch = [];
    for (const filePath of walkFiles(root)) {
      if (!VIDEO_EXTS.has(path.extname(filePath).toLowerCase())) continue;
      scannedFiles += 1;
      const item = parseVideoFile(root, filePath);
      if (!item) continue;
      batch.push(item);
      imported += 1;
      if (batch.length >= 500) {
        writeBatch(batch.splice(0));
      }
    }
    if (batch.length) writeBatch(batch.splice(0));
    deleteMissingImportedVideos(database, foundIds);
    return { ok: true, root, scannedFiles, imported, scannedAt: now, summary: summary() };
  }

  function importDownloadManagerDb(inputDbPath, options = {}) {
    const rawSourceDbPath = String(inputDbPath || "").trim();
    if (!rawSourceDbPath) {
      const error = new Error("没有提供抖音下载器数据库路径");
      error.statusCode = 400;
      throw error;
    }
    const sourceDbPath = path.resolve(rawSourceDbPath);
    if (!fs.existsSync(sourceDbPath) || !safeStat(sourceDbPath)?.isFile()) {
      const error = new Error(`抖音下载器数据库不存在：${sourceDbPath}`);
      error.statusCode = 400;
      throw error;
    }

    const now = new Date().toISOString();
    const targetDb = databaseOrOpen();
    const sourceDb = new DatabaseSync(sourceDbPath, { readOnly: true });
    const upsert = shortVideoUpsertStatement(targetDb);
    const normalized = normalizedUpsertStatements(targetDb, coverCacheDir);
    const batchId = `download-manager:${hashText(`${sourceDbPath}:${now}`).slice(0, 24)}`;
    const includePosts = Boolean(options.includePosts);
    const includeSummary = !options.skipSummary;
    const profileWhere = includePosts ? "p.tab IN ('like', 'post')" : "p.tab = 'like'";
    const incremental = Boolean(options.incremental);
    const watermarkKey = "download_manager_downloaded_watermark";
    const previousWatermark = incremental ? metaValue(targetDb, watermarkKey) : "";
    const sourceMaxRow = sourceDb.prepare(`
      SELECT MAX(COALESCE(l.downloaded_at, '')) AS maxDownloadedAt
      FROM links l
      JOIN profiles p ON p.id = l.profile_id
      WHERE ${profileWhere}
        AND l.status = 'downloaded'
    `).get();
    const sourceMaxDownloadedAt = sourceMaxRow?.maxDownloadedAt || "";
    const sourceWhere = [profileWhere, "l.status = 'downloaded'"];
    const sourceArgs = [];
    if (incremental && previousWatermark) {
      sourceWhere.push("COALESCE(l.downloaded_at, '') > ?");
      sourceArgs.push(previousWatermark);
    }
    const sourceRows = sourceDb.prepare(`
      SELECT
        l.*,
        p.tab AS profile_tab,
        p.sec_uid AS profile_sec_uid,
        p.url AS profile_url
      FROM links l
      JOIN profiles p ON p.id = l.profile_id
      WHERE ${sourceWhere.join(" AND ")}
      ORDER BY COALESCE(l.downloaded_at, ''), l.id ASC
    `).all(...sourceArgs);

    let imported = 0;
    let updated = 0;
    let skipped = 0;
    let skippedNoPlayableVideo = 0;
    let skippedNotDownloaded = 0;
    let skippedDuplicate = 0;
    const seenIds = new Set();
    const importedIds = new Set();

    if (!sourceRows.length) {
      try {
        if (sourceMaxDownloadedAt && sourceMaxDownloadedAt !== previousWatermark) {
          targetDb.prepare(`INSERT OR REPLACE INTO short_video_meta (key, value) VALUES (?, ?)`).run(watermarkKey, sourceMaxDownloadedAt);
        }
        return {
          ok: true,
          sourceDbPath,
          batchId: "",
          incremental,
          sourceWatermark: sourceMaxDownloadedAt,
          scanned: 0,
          imported: 0,
          updated: 0,
          skipped: 0,
          skippedNotDownloaded: 0,
          skippedNoPlayableVideo: 0,
          skippedDuplicate: 0,
          totalImportedThisBatch: 0,
          importedAt: now,
          summary: includeSummary ? cachedSummary() : null
        };
      } finally {
        sourceDb.close();
      }
    }

    targetDb.exec("BEGIN");
    try {
      targetDb.prepare(`
        INSERT INTO short_video_import_batches (
          id, source_root, imported_count, started_at, finished_at, scanner_version
        )
        VALUES (?, ?, 0, ?, '', 'download-manager-v1')
      `).run(batchId, sourceDbPath, now);

      for (const row of sourceRows) {
        if (row.status !== "downloaded") {
          skipped += 1;
          skippedNotDownloaded += 1;
          continue;
        }
        const item = downloadManagerRowToItem(row);
        if (!item) {
          skipped += 1;
          skippedNoPlayableVideo += 1;
          continue;
        }
        if (seenIds.has(item.id)) {
          skipped += 1;
          skippedDuplicate += 1;
          continue;
        }
        seenIds.add(item.id);
        const existed = targetDb.prepare("SELECT 1 FROM short_videos WHERE id = ? LIMIT 1").get(item.id);
        upsert.run(...videoRowValues(item, now));
        upsertNormalizedItem(normalized, item, now, { actionSource: "download_manager" });
        targetDb.prepare(`
          INSERT OR REPLACE INTO short_video_import_items (
            batch_id, video_id, source_path, data_path, imported_at
          )
          VALUES (?, ?, ?, ?, ?)
        `).run(batchId, item.id, item.sourcePath || "", item.dataPath || "", now);
        importedIds.add(item.id);
        if (existed) updated += 1;
        else imported += 1;
      }

      targetDb.prepare("UPDATE short_video_import_batches SET imported_count = ?, finished_at = ? WHERE id = ?")
        .run(importedIds.size, new Date().toISOString(), batchId);
      targetDb.prepare("INSERT OR REPLACE INTO short_video_meta (key, value) VALUES ('download_manager_imported_at', ?)").run(now);
      targetDb.prepare("INSERT OR REPLACE INTO short_video_meta (key, value) VALUES ('download_manager_db_path', ?)").run(sourceDbPath);
      if (sourceMaxDownloadedAt) {
        targetDb.prepare(`INSERT OR REPLACE INTO short_video_meta (key, value) VALUES (?, ?)`).run(watermarkKey, sourceMaxDownloadedAt);
      }
      targetDb.exec("COMMIT");
    } catch (error) {
      try {
        targetDb.exec("ROLLBACK");
      } catch {}
      throw error;
    } finally {
      sourceDb.close();
    }

    return {
      ok: true,
      sourceDbPath,
      batchId,
      incremental,
      sourceWatermark: sourceMaxDownloadedAt,
      scanned: sourceRows.length,
      imported,
      updated,
      skipped,
      skippedNotDownloaded,
      skippedNoPlayableVideo,
      skippedDuplicate,
      totalImportedThisBatch: importedIds.size,
      importedAt: now,
      summary: includeSummary ? summary() : null
    };
  }

  function databaseOrOpen() {
    return database();
  }

  return {
    adjacentVideo,
    close,
    coverFile,
    dbPath,
    facets,
    importDownloadManagerDb,
    listVideos,
    roots,
    scan,
    summary: cachedSummary,
    videoDetail,
    videoFile
  };
}

function ensureSchema(db, coverCacheDir = "") {
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS short_video_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS short_videos (
      id TEXT PRIMARY KEY,
      aweme_id TEXT,
      author_sec_uid TEXT NOT NULL DEFAULT '',
      author_uid TEXT NOT NULL DEFAULT '',
      author_name TEXT NOT NULL DEFAULT '',
      author_avatar_url TEXT NOT NULL DEFAULT '',
      title TEXT NOT NULL DEFAULT '',
      description TEXT NOT NULL DEFAULT '',
      tags_json TEXT NOT NULL DEFAULT '[]',
      tags_text TEXT NOT NULL DEFAULT '',
      create_time INTEGER,
      published_at TEXT NOT NULL DEFAULT '',
      liked_at TEXT NOT NULL DEFAULT '',
      duration_ms INTEGER,
      width INTEGER,
      height INTEGER,
      digg_count INTEGER,
      comment_count INTEGER,
      collect_count INTEGER,
      share_count INTEGER,
      play_count INTEGER,
      share_url TEXT NOT NULL DEFAULT '',
      metadata_json TEXT NOT NULL DEFAULT '{}',
      source_path TEXT NOT NULL,
      cover_path TEXT NOT NULL DEFAULT '',
      cover_source TEXT NOT NULL DEFAULT '',
      music_path TEXT NOT NULL DEFAULT '',
      data_path TEXT NOT NULL DEFAULT '',
      relative_path TEXT NOT NULL DEFAULT '',
      file_name TEXT NOT NULL DEFAULT '',
      size_bytes INTEGER NOT NULL DEFAULT 0,
      mtime_ms INTEGER NOT NULL DEFAULT 0,
      imported_at TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL DEFAULT ''
    );
    CREATE INDEX IF NOT EXISTS idx_short_videos_author ON short_videos(author_sec_uid);
    CREATE INDEX IF NOT EXISTS idx_short_videos_liked ON short_videos(liked_at);
    CREATE INDEX IF NOT EXISTS idx_short_videos_published ON short_videos(published_at);
    CREATE INDEX IF NOT EXISTS idx_short_videos_digg ON short_videos(digg_count);
    CREATE INDEX IF NOT EXISTS idx_short_videos_aweme ON short_videos(aweme_id);
    CREATE TABLE IF NOT EXISTS short_video_users (
      id TEXT PRIMARY KEY,
      platform TEXT NOT NULL DEFAULT 'douyin',
      sec_uid TEXT NOT NULL DEFAULT '',
      uid TEXT NOT NULL DEFAULT '',
      nickname TEXT NOT NULL DEFAULT '未知作者',
      avatar_url TEXT NOT NULL DEFAULT '',
      profile_url TEXT NOT NULL DEFAULT '',
      signature TEXT NOT NULL DEFAULT '',
      follower_count INTEGER,
      following_count INTEGER,
      raw_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL DEFAULT ''
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_short_video_users_platform_sec_uid
      ON short_video_users(platform, sec_uid)
      WHERE sec_uid <> '';
    CREATE INDEX IF NOT EXISTS idx_short_video_users_nickname ON short_video_users(nickname);
    CREATE TABLE IF NOT EXISTS short_video_assets (
      id TEXT PRIMARY KEY,
      video_id TEXT NOT NULL,
      asset_type TEXT NOT NULL,
      local_path TEXT NOT NULL DEFAULT '',
      remote_url TEXT NOT NULL DEFAULT '',
      file_name TEXT NOT NULL DEFAULT '',
      file_hash TEXT NOT NULL DEFAULT '',
      size_bytes INTEGER NOT NULL DEFAULT 0,
      mime_type TEXT NOT NULL DEFAULT '',
      codec TEXT NOT NULL DEFAULT '',
      mtime_ms INTEGER NOT NULL DEFAULT 0,
      imported_at TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL DEFAULT '',
      UNIQUE(video_id, asset_type)
    );
    CREATE INDEX IF NOT EXISTS idx_short_video_assets_video ON short_video_assets(video_id);
    CREATE INDEX IF NOT EXISTS idx_short_video_assets_type ON short_video_assets(asset_type);
    CREATE TABLE IF NOT EXISTS short_video_stats (
      video_id TEXT PRIMARY KEY,
      digg_count INTEGER NOT NULL DEFAULT 0,
      comment_count INTEGER NOT NULL DEFAULT 0,
      collect_count INTEGER NOT NULL DEFAULT 0,
      share_count INTEGER NOT NULL DEFAULT 0,
      play_count INTEGER NOT NULL DEFAULT 0,
      snapshot_at TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE IF NOT EXISTS short_video_user_actions (
      local_user_id TEXT NOT NULL,
      video_id TEXT NOT NULL,
      action_type TEXT NOT NULL,
      active INTEGER NOT NULL DEFAULT 1,
      source TEXT NOT NULL DEFAULT '',
      acted_at TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL DEFAULT '',
      PRIMARY KEY(local_user_id, video_id, action_type)
    );
    CREATE INDEX IF NOT EXISTS idx_short_video_actions_video ON short_video_user_actions(video_id, action_type, active);
    CREATE INDEX IF NOT EXISTS idx_short_video_actions_user ON short_video_user_actions(local_user_id, action_type, active, acted_at);
    CREATE TABLE IF NOT EXISTS short_video_collections (
      id TEXT PRIMARY KEY,
      local_user_id TEXT NOT NULL,
      name TEXT NOT NULL,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE IF NOT EXISTS short_video_collection_items (
      collection_id TEXT NOT NULL,
      video_id TEXT NOT NULL,
      added_at TEXT NOT NULL DEFAULT '',
      PRIMARY KEY(collection_id, video_id)
    );
    CREATE INDEX IF NOT EXISTS idx_short_video_collection_items_video ON short_video_collection_items(video_id);
    CREATE TABLE IF NOT EXISTS short_video_follows (
      local_user_id TEXT NOT NULL,
      target_user_id TEXT NOT NULL,
      active INTEGER NOT NULL DEFAULT 1,
      followed_at TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL DEFAULT '',
      PRIMARY KEY(local_user_id, target_user_id)
    );
    CREATE TABLE IF NOT EXISTS short_video_watch_history (
      local_user_id TEXT NOT NULL,
      video_id TEXT NOT NULL,
      progress_ms INTEGER NOT NULL DEFAULT 0,
      completed_count INTEGER NOT NULL DEFAULT 0,
      last_watched_at TEXT NOT NULL DEFAULT '',
      PRIMARY KEY(local_user_id, video_id)
    );
    CREATE INDEX IF NOT EXISTS idx_short_video_watch_history_recent ON short_video_watch_history(local_user_id, last_watched_at);
    CREATE TABLE IF NOT EXISTS short_video_import_batches (
      id TEXT PRIMARY KEY,
      source_root TEXT NOT NULL DEFAULT '',
      imported_count INTEGER NOT NULL DEFAULT 0,
      started_at TEXT NOT NULL DEFAULT '',
      finished_at TEXT NOT NULL DEFAULT '',
      scanner_version TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE IF NOT EXISTS short_video_import_items (
      batch_id TEXT NOT NULL,
      video_id TEXT NOT NULL,
      source_path TEXT NOT NULL DEFAULT '',
      data_path TEXT NOT NULL DEFAULT '',
      imported_at TEXT NOT NULL DEFAULT '',
      PRIMARY KEY(batch_id, video_id)
    );
  `);
  ensureShortVideoColumns(db);
  recreateShortVideoCatalogView(db);
  migrateNormalizedShortVideoData(db, coverCacheDir);
}

function ensureShortVideoColumns(db) {
  addColumnIfMissing(db, "short_videos", "owner_user_id", "TEXT NOT NULL DEFAULT ''");
  addColumnIfMissing(db, "short_videos", "origin", "TEXT NOT NULL DEFAULT 'douyin_like_import'");
  addColumnIfMissing(db, "short_videos", "status", "TEXT NOT NULL DEFAULT 'normal'");
  addColumnIfMissing(db, "short_videos", "visibility", "TEXT NOT NULL DEFAULT 'local_only'");
  addColumnIfMissing(db, "short_videos", "metadata_json", "TEXT NOT NULL DEFAULT '{}'");
  addColumnIfMissing(db, "short_videos", "cover_source", "TEXT NOT NULL DEFAULT ''");
  addColumnIfMissing(db, "short_video_users", "profile_url", "TEXT NOT NULL DEFAULT ''");
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_short_videos_owner ON short_videos(owner_user_id);
    CREATE INDEX IF NOT EXISTS idx_short_videos_origin ON short_videos(origin);
  `);
  backfillShortVideoShareUrls(db);
  migrateShortVideoCoverSources(db);
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

function recreateShortVideoCatalogView(db) {
  db.exec(`
    DROP VIEW IF EXISTS short_video_catalog;
    CREATE VIEW short_video_catalog AS
    SELECT
      v.id,
      v.aweme_id,
      v.owner_user_id,
      v.origin,
      v.status,
      v.visibility,
      COALESCE(NULLIF(u.sec_uid, ''), v.author_sec_uid) AS author_sec_uid,
      COALESCE(NULLIF(u.uid, ''), v.author_uid) AS author_uid,
      COALESCE(NULLIF(u.nickname, ''), v.author_name, '未知作者') AS author_name,
      COALESCE(NULLIF(u.avatar_url, ''), v.author_avatar_url) AS author_avatar_url,
      COALESCE(NULLIF(u.profile_url, ''), CASE WHEN COALESCE(NULLIF(u.sec_uid, ''), v.author_sec_uid) <> '' THEN 'https://www.douyin.com/user/' || COALESCE(NULLIF(u.sec_uid, ''), v.author_sec_uid) ELSE '' END) AS author_profile_url,
      v.title,
      v.description,
      v.tags_json,
      v.tags_text,
      v.create_time,
      v.published_at,
      v.liked_at,
      v.duration_ms,
      v.width,
      v.height,
      COALESCE(s.digg_count, v.digg_count, 0) AS digg_count,
      COALESCE(s.comment_count, v.comment_count, 0) AS comment_count,
      COALESCE(s.collect_count, v.collect_count, 0) AS collect_count,
      COALESCE(s.share_count, v.share_count, 0) AS share_count,
      COALESCE(s.play_count, v.play_count, 0) AS play_count,
      v.share_url,
      v.metadata_json,
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
    LEFT JOIN short_video_assets video_asset ON video_asset.video_id = v.id AND video_asset.asset_type = 'video'
    LEFT JOIN short_video_assets native_cover_asset ON native_cover_asset.video_id = v.id AND native_cover_asset.asset_type = 'native_cover'
    LEFT JOIN short_video_assets ffmpeg_cover_asset ON ffmpeg_cover_asset.video_id = v.id AND ffmpeg_cover_asset.asset_type = 'ffmpeg_cover'
    LEFT JOIN short_video_assets legacy_cover_asset ON legacy_cover_asset.video_id = v.id AND legacy_cover_asset.asset_type = 'cover'
    LEFT JOIN short_video_assets music_asset ON music_asset.video_id = v.id AND music_asset.asset_type = 'music';
  `);
}

function migrateNormalizedShortVideoData(db, coverCacheDir = "") {
  if (metaValue(db, "normalized_schema_version") === NORMALIZED_SCHEMA_VERSION) return;
  const rows = db.prepare("SELECT * FROM short_videos").all();
  const now = new Date().toISOString();
  const normalized = normalizedUpsertStatements(db, coverCacheDir);
  db.exec("BEGIN");
  try {
    for (const row of rows) {
      upsertNormalizedItem(normalized, legacyRowToItem(row), row.updated_at || now, { actionSource: "imported" });
    }
    db.prepare("INSERT OR REPLACE INTO short_video_meta (key, value) VALUES ('normalized_schema_version', ?)").run(NORMALIZED_SCHEMA_VERSION);
    db.exec("COMMIT");
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {}
    throw error;
  }
}

function cleanupSupersededFfmpegCovers(db, coverCacheDir = "") {
  try {
    const rows = db.prepare(`
      SELECT f.video_id, f.local_path, n.local_path AS native_path
      FROM short_video_assets f
      JOIN short_video_assets n
        ON n.video_id = f.video_id
       AND n.asset_type = 'native_cover'
       AND COALESCE(TRIM(n.local_path), '') <> ''
      WHERE f.asset_type = 'ffmpeg_cover'
    `).all();
    if (!rows.length) return;

    db.exec("BEGIN");
    try {
      for (const row of rows) {
        db.prepare(`
          UPDATE short_videos
          SET cover_path = ?,
              cover_source = 'native',
              updated_at = ?
          WHERE id = ?
            AND (
              cover_source = 'ffmpeg'
              OR COALESCE(TRIM(cover_path), '') = ''
              OR cover_path = ?
            )
        `).run(row.native_path || "", new Date().toISOString(), row.video_id, row.local_path || "");
        db.prepare("DELETE FROM short_video_assets WHERE video_id = ? AND asset_type = 'ffmpeg_cover'").run(row.video_id);
      }
      db.exec("COMMIT");
    } catch (error) {
      try {
        db.exec("ROLLBACK");
      } catch {}
      throw error;
    }

    for (const row of rows) removeGeneratedCoverFile(row.local_path, coverCacheDir);
    db.prepare("INSERT OR REPLACE INTO short_video_meta (key, value) VALUES ('cover_cleanup_at', ?)").run(new Date().toISOString());
  } catch (error) {
    console.warn("[short-video-cover-cleanup]", error.message || error);
  }
}

function removeGeneratedCoverFile(filePath, coverCacheDir = "") {
  const rawPath = String(filePath || "").trim();
  if (!rawPath || !coverCacheDir) return;
  const resolvedPath = path.resolve(rawPath);
  const resolvedCacheDir = path.resolve(coverCacheDir);
  if (!resolvedPath.startsWith(`${resolvedCacheDir}${path.sep}`)) return;
  try {
    fs.rmSync(resolvedPath, { force: true });
  } catch {}
}

function parseVideoFile(root, filePath) {
  const stat = safeStat(filePath);
  if (!stat?.isFile()) return null;
  const dir = path.dirname(filePath);
  const author = parseAuthorFolder(root, filePath);
  const files = safeReadDir(dir);
  const dataPath = findCompanion(files, dir, filePath, ".json", (name) => /_data\.json$/i.test(name)) || "";
  const data = readVideoJson(dataPath);
  const parentInfo = parseVideoName(path.basename(dir));
  const fileInfo = parseVideoName(path.basename(filePath, path.extname(filePath)));
  const awemeId = String(data?.aweme_id || parentInfo.awemeId || fileInfo.awemeId || "").trim();
  const id = awemeId || `local-${hashText(path.resolve(filePath)).slice(0, 18)}`;
  const description = String(data?.desc || parentInfo.title || fileInfo.title || path.basename(filePath, path.extname(filePath))).trim();
  const title = description || awemeId || path.basename(filePath, path.extname(filePath));
  const tags = tagsFromText(description);
  const coverPath = findCover(files, dir, filePath, data);
  const musicPath = findCompanion(files, dir, filePath, "", (name) => AUDIO_EXTS.has(path.extname(name).toLowerCase())) || "";
  const createTime = Number(data?.create_time || 0) || null;
  const publishedAt = isoFromCreateTime(createTime) || dateOnlyIso(parentInfo.date || fileInfo.date) || "";
  const likedAt = new Date(stat.mtimeMs || Date.now()).toISOString();
  const video = data?.video || {};
  const statistics = data?.statistics || {};
  const authorData = data?.author || {};
  const finalAuthor = {
    secUid: String(authorData.sec_uid || author.secUid || "").trim(),
    uid: String(authorData.uid || "").trim(),
    name: String(authorData.nickname || author.name || "").trim() || "未知作者",
    avatarUrl: firstUrl(authorData.avatar_thumb)
  };
  return {
    id,
    awemeId,
    author: finalAuthor,
    title,
    description,
    tags,
    createTime,
    publishedAt,
    likedAt,
    durationMs: Number(data?.duration || video.duration || 0) || null,
    width: Number(video.width || video.play_addr?.width || 0) || null,
    height: Number(video.height || video.play_addr?.height || 0) || null,
    diggCount: Number(statistics.digg_count || 0) || 0,
    commentCount: Number(statistics.comment_count || 0) || 0,
    collectCount: Number(statistics.collect_count || 0) || 0,
    shareCount: Number(statistics.share_count || 0) || 0,
    playCount: Number(statistics.play_count || 0) || 0,
    shareUrl: normalizedDouyinShareUrl(data?.share_url, awemeId),
    sourcePath: path.resolve(filePath),
    coverPath,
    coverSource: coverPath ? "native" : "",
    musicPath,
    dataPath,
    relativePath: path.relative(root, filePath),
    fileName: path.basename(filePath),
    sizeBytes: stat.size,
    mtimeMs: Math.floor(stat.mtimeMs || 0)
  };
}

function downloadManagerRowToItem(row) {
  const outputDir = String(row.output_dir || "").trim() ? path.resolve(String(row.output_dir).trim()) : "";
  const localPaths = parseDownloadManagerPaths(row.local_file_paths)
    .map((filePath) => resolveDownloadManagerPath(outputDir, filePath));
  const sourcePath = firstExistingDownloadManagerPath(localPaths, VIDEO_EXTS);
  if (!sourcePath) return null;

  const stat = safeStat(sourcePath);
  if (!stat?.isFile()) return null;
  const dataPath = firstExistingDownloadManagerPath(localPaths, new Set([".json"]));
  const data = readVideoJson(dataPath) || parseJsonObject(row.metadata_json);
  const rawMetadata = rawAwemeMetadata(data);
  const video = data?.video || {};
  const statistics = rawMetadata?.statistics || data?.statistics || {};
  const authorData = rawMetadata?.author || data?.author || {};
  const awemeId = String(row.aweme_id || data?.aweme_id || "").trim();
  const id = awemeId || `local-${hashText(sourcePath).slice(0, 18)}`;
  const description = String(row.desc || data?.desc || path.basename(sourcePath, path.extname(sourcePath))).trim();
  const title = description.split(/\r?\n/)[0]?.trim() || awemeId || path.basename(sourcePath, path.extname(sourcePath));
  const tags = mergeTags(Array.isArray(data?.tags) ? data.tags : [], tagsFromText(description));
  const createTime = Number(row.create_time || data?.create_time || data?.publish_timestamp || 0) || null;
  const likedAt = normalizeIsoDate(row.discovered_at || row.last_seen_at || row.downloaded_at || data?.recorded_at)
    || new Date(stat.mtimeMs || Date.now()).toISOString();
  const publishedAt = isoFromCreateTime(createTime) || dateOnlyIso(data?.date) || "";
  const coverPath = downloadManagerCoverPath(row, localPaths, sourcePath, outputDir);
  const musicPath = firstExistingDownloadManagerPath(localPaths, AUDIO_EXTS);
  const durationMs = Number(row.duration_ms || data?.duration || video.duration || 0) || null;

  const authorSecUid = String(row.author_sec_uid || data?.author_sec_uid || authorData.sec_uid || "").trim();
  const authorProfileUrl = normalizedDouyinUserUrl(row.author_url || data?.author_url, authorSecUid);
  return {
    id,
    awemeId,
    author: {
      secUid: authorSecUid,
      uid: String(row.author_uid || authorData.uid || "").trim(),
      name: String(row.author_nickname || authorData.nickname || data?.author_name || "").trim() || "未知作者",
      avatarUrl: firstUrlAny(row.author_avatar_url, data?.author_avatar_url, authorData.avatar_thumb, authorData.avatar_medium, authorData.avatar_larger),
      profileUrl: authorProfileUrl,
      rawJson: JSON.stringify({
        profileUrl: authorProfileUrl,
        sourceProfileUrl: row.profile_url || "",
        metadata: rawMetadata || data || {}
      })
    },
    title,
    description,
    tags,
    createTime,
    publishedAt,
    likedAt,
    durationMs,
    width: Number(video.width || video.play_addr?.width || 0) || null,
    height: Number(video.height || video.play_addr?.height || 0) || null,
    diggCount: Number(row.digg_count ?? statistics.digg_count ?? 0) || 0,
    commentCount: Number(row.comment_count ?? statistics.comment_count ?? 0) || 0,
    collectCount: Number(row.collect_count ?? statistics.collect_count ?? 0) || 0,
    shareCount: Number(row.share_count ?? statistics.share_count ?? 0) || 0,
    playCount: Number(statistics.play_count || 0) || 0,
    shareUrl: normalizedDouyinShareUrl(row.url || data?.share_url, awemeId),
    metadataJson: JSON.stringify(data || {}),
    sourcePath,
    coverPath,
    coverSource: coverPath ? "native" : "",
    musicPath,
    dataPath,
    relativePath: outputDir ? path.relative(outputDir, sourcePath) : sourcePath,
    fileName: path.basename(sourcePath),
    sizeBytes: stat.size,
    mtimeMs: Math.floor(stat.mtimeMs || 0),
    origin: row.profile_tab === "post" ? "douyin_download_manager_post" : "douyin_download_manager_like"
  };
}

function shortVideoUpsertStatement(db) {
  return db.prepare(`
    INSERT INTO short_videos (
      id, aweme_id, author_sec_uid, author_uid, author_name, author_avatar_url,
      title, description, tags_json, tags_text, create_time, published_at, liked_at,
      duration_ms, width, height, digg_count, comment_count, collect_count,
      share_count, play_count, share_url, metadata_json, source_path, cover_path, cover_source, music_path,
      data_path, relative_path, file_name, size_bytes, mtime_ms, imported_at, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      aweme_id = excluded.aweme_id,
      author_sec_uid = excluded.author_sec_uid,
      author_uid = excluded.author_uid,
      author_name = excluded.author_name,
      author_avatar_url = excluded.author_avatar_url,
      title = excluded.title,
      description = excluded.description,
      tags_json = excluded.tags_json,
      tags_text = excluded.tags_text,
      create_time = excluded.create_time,
      published_at = excluded.published_at,
      liked_at = excluded.liked_at,
      duration_ms = excluded.duration_ms,
      width = excluded.width,
      height = excluded.height,
      digg_count = excluded.digg_count,
      comment_count = excluded.comment_count,
      collect_count = excluded.collect_count,
      share_count = excluded.share_count,
      play_count = excluded.play_count,
      share_url = excluded.share_url,
      metadata_json = excluded.metadata_json,
      source_path = excluded.source_path,
      cover_path = CASE
        WHEN excluded.cover_source = 'native' AND NULLIF(excluded.cover_path, '') IS NOT NULL THEN excluded.cover_path
        WHEN short_videos.cover_source = 'native' AND NULLIF(short_videos.cover_path, '') IS NOT NULL THEN short_videos.cover_path
        WHEN NULLIF(excluded.cover_path, '') IS NOT NULL THEN excluded.cover_path
        ELSE short_videos.cover_path
      END,
      cover_source = CASE
        WHEN excluded.cover_source = 'native' AND NULLIF(excluded.cover_path, '') IS NOT NULL THEN 'native'
        WHEN short_videos.cover_source = 'native' AND NULLIF(short_videos.cover_path, '') IS NOT NULL THEN 'native'
        WHEN NULLIF(excluded.cover_source, '') IS NOT NULL THEN excluded.cover_source
        ELSE short_videos.cover_source
      END,
      music_path = excluded.music_path,
      data_path = excluded.data_path,
      relative_path = excluded.relative_path,
      file_name = excluded.file_name,
      size_bytes = excluded.size_bytes,
      mtime_ms = excluded.mtime_ms,
      updated_at = excluded.updated_at
  `);
}

function videoRowValues(item, now) {
  return [
    item.id,
    item.awemeId,
    item.author.secUid,
    item.author.uid,
    item.author.name,
    item.author.avatarUrl,
    item.title,
    item.description,
    JSON.stringify(item.tags || []),
    (item.tags || []).join(" "),
    item.createTime,
    item.publishedAt,
    item.likedAt,
    item.durationMs,
    item.width,
    item.height,
    item.diggCount,
    item.commentCount,
    item.collectCount,
    item.shareCount,
    item.playCount,
    item.shareUrl,
    item.metadataJson || "{}",
    item.sourcePath,
    item.coverPath,
    item.coverSource || (item.coverPath ? "native" : ""),
    item.musicPath,
    item.dataPath,
    item.relativePath,
    item.fileName,
    item.sizeBytes,
    item.mtimeMs,
    now,
    now
  ];
}

function normalizedUpsertStatements(db, coverCacheDir = "") {
  return {
    coverCacheDir,
    localUser: db.prepare(`
      INSERT INTO short_video_users (
        id, platform, sec_uid, uid, nickname, avatar_url, signature,
        follower_count, following_count, raw_json, created_at, updated_at
      )
      VALUES (?, 'local', '', ?, ?, '', '', NULL, NULL, '{}', ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        nickname = excluded.nickname,
        updated_at = excluded.updated_at
    `),
    user: db.prepare(`
      INSERT INTO short_video_users (
        id, platform, sec_uid, uid, nickname, avatar_url, profile_url, signature,
        follower_count, following_count, raw_json, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, '', NULL, NULL, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        platform = COALESCE(NULLIF(excluded.platform, ''), short_video_users.platform),
        sec_uid = COALESCE(NULLIF(excluded.sec_uid, ''), short_video_users.sec_uid),
        uid = COALESCE(NULLIF(excluded.uid, ''), short_video_users.uid),
        nickname = COALESCE(NULLIF(excluded.nickname, ''), short_video_users.nickname),
        avatar_url = COALESCE(NULLIF(excluded.avatar_url, ''), short_video_users.avatar_url),
        profile_url = COALESCE(NULLIF(excluded.profile_url, ''), short_video_users.profile_url),
        raw_json = CASE
          WHEN excluded.raw_json <> '{}' THEN excluded.raw_json
          ELSE short_video_users.raw_json
        END,
        updated_at = excluded.updated_at
    `),
    videoCore: db.prepare(`
      UPDATE short_videos
      SET owner_user_id = ?, origin = ?, status = ?, visibility = ?, updated_at = ?
      WHERE id = ?
    `),
    stats: db.prepare(`
      INSERT INTO short_video_stats (
        video_id, digg_count, comment_count, collect_count, share_count,
        play_count, snapshot_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(video_id) DO UPDATE SET
        digg_count = excluded.digg_count,
        comment_count = excluded.comment_count,
        collect_count = excluded.collect_count,
        share_count = excluded.share_count,
        play_count = excluded.play_count,
        snapshot_at = excluded.snapshot_at,
        updated_at = excluded.updated_at
    `),
    asset: db.prepare(`
      INSERT INTO short_video_assets (
        id, video_id, asset_type, local_path, remote_url, file_name, file_hash,
        size_bytes, mime_type, codec, mtime_ms, imported_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(video_id, asset_type) DO UPDATE SET
        local_path = excluded.local_path,
        remote_url = excluded.remote_url,
        file_name = excluded.file_name,
        file_hash = excluded.file_hash,
        size_bytes = excluded.size_bytes,
        mime_type = excluded.mime_type,
        codec = excluded.codec,
        mtime_ms = excluded.mtime_ms,
        updated_at = excluded.updated_at
    `),
    ffmpegCoverRows: db.prepare(`
      SELECT local_path
      FROM short_video_assets
      WHERE video_id = ?
        AND asset_type = 'ffmpeg_cover'
        AND COALESCE(TRIM(local_path), '') <> ''
    `),
    deleteFfmpegCover: db.prepare(`
      DELETE FROM short_video_assets
      WHERE video_id = ?
        AND asset_type = 'ffmpeg_cover'
    `),
    action: db.prepare(`
      INSERT INTO short_video_user_actions (
        local_user_id, video_id, action_type, active, source, acted_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(local_user_id, video_id, action_type) DO UPDATE SET
        active = excluded.active,
        source = excluded.source,
        acted_at = excluded.acted_at,
        updated_at = excluded.updated_at
    `)
  };
}

function upsertNormalizedItem(statements, item, now, options = {}) {
  const authorId = shortVideoUserId(item.author || {});
  statements.localUser.run(LOCAL_SHORT_VIDEO_USER_ID, "self", "本地用户", now, now);
  statements.user.run(
    authorId,
    item.awemeId || item.author?.secUid ? "douyin" : "local",
    item.author?.secUid || "",
    item.author?.uid || "",
    item.author?.name || "未知作者",
    item.author?.avatarUrl || "",
    item.author?.profileUrl || douyinUserUrl(item.author?.secUid),
    item.author?.rawJson || "{}",
    now,
    now
  );
  statements.videoCore.run(authorId, shortVideoOrigin(item), "normal", "local_only", now, item.id);
  statements.stats.run(
    item.id,
    Number(item.diggCount || 0),
    Number(item.commentCount || 0),
    Number(item.collectCount || 0),
    Number(item.shareCount || 0),
    Number(item.playCount || 0),
    now,
    now
  );
  runAssetUpsert(statements.asset, {
    videoId: item.id,
    assetType: "video",
    localPath: item.sourcePath || "",
    fileName: item.fileName || path.basename(item.sourcePath || ""),
    sizeBytes: Number(item.sizeBytes || 0),
    mtimeMs: Number(item.mtimeMs || 0),
    mimeType: mimeTypeForPath(item.sourcePath || item.fileName || "")
  }, now);
  if (item.coverPath) {
    const stat = safeStat(item.coverPath);
    const coverAssetType = item.coverSource === "ffmpeg" ? "ffmpeg_cover" : "native_cover";
    runAssetUpsert(statements.asset, {
      videoId: item.id,
      assetType: coverAssetType,
      localPath: item.coverPath,
      fileName: path.basename(item.coverPath),
      sizeBytes: stat?.size || 0,
      mtimeMs: Math.floor(stat?.mtimeMs || 0),
      mimeType: mimeTypeForPath(item.coverPath)
    }, now);
    if (coverAssetType === "native_cover") deleteSupersededFfmpegCover(statements, item.id);
  }
  if (item.musicPath) {
    const stat = safeStat(item.musicPath);
    runAssetUpsert(statements.asset, {
      videoId: item.id,
      assetType: "music",
      localPath: item.musicPath,
      fileName: path.basename(item.musicPath),
      sizeBytes: stat?.size || 0,
      mtimeMs: Math.floor(stat?.mtimeMs || 0),
      mimeType: mimeTypeForPath(item.musicPath)
    }, now);
  }
  if (options.actionSource) {
    statements.action.run(
      LOCAL_SHORT_VIDEO_USER_ID,
      item.id,
      "like",
      1,
      options.actionSource,
      item.likedAt || now,
      now
    );
  }
}

function upsertAsset(db, asset, now = new Date().toISOString()) {
  runAssetUpsert(normalizedUpsertStatements(db).asset, asset, now);
}

function deleteSupersededFfmpegCover(statements, videoId) {
  if (!videoId || !statements?.ffmpegCoverRows || !statements?.deleteFfmpegCover) return;
  const rows = statements.ffmpegCoverRows.all(videoId);
  statements.deleteFfmpegCover.run(videoId);
  for (const row of rows) removeGeneratedCoverFile(row.local_path, statements.coverCacheDir);
}

function runAssetUpsert(statement, asset, now) {
  if (!asset?.videoId || !asset?.assetType || (!asset.localPath && !asset.remoteUrl)) return;
  const id = `${asset.videoId}:${asset.assetType}`;
  statement.run(
    id,
    asset.videoId,
    asset.assetType,
    asset.localPath || "",
    asset.remoteUrl || "",
    asset.fileName || path.basename(asset.localPath || ""),
    asset.fileHash || "",
    Number(asset.sizeBytes || 0),
    asset.mimeType || mimeTypeForPath(asset.localPath || asset.fileName || ""),
    asset.codec || "",
    Number(asset.mtimeMs || 0),
    now,
    now
  );
}

function legacyRowToItem(row) {
  return {
    id: row.id,
    awemeId: row.aweme_id || "",
    author: {
      secUid: row.author_sec_uid || "",
      uid: row.author_uid || "",
      name: row.author_name || "未知作者",
      avatarUrl: row.author_avatar_url || "",
      profileUrl: row.author_profile_url || douyinUserUrl(row.author_sec_uid)
    },
    sourcePath: row.source_path || "",
    coverPath: row.cover_path || "",
    coverSource: row.cover_source || (String(row.cover_path || "").includes("short-video-covers") ? "ffmpeg" : (row.cover_path ? "native" : "")),
    musicPath: row.music_path || "",
    fileName: row.file_name || path.basename(row.source_path || ""),
    sizeBytes: Number(row.size_bytes || 0),
    mtimeMs: Number(row.mtime_ms || 0),
    diggCount: Number(row.digg_count || 0),
    commentCount: Number(row.comment_count || 0),
    collectCount: Number(row.collect_count || 0),
    shareCount: Number(row.share_count || 0),
    playCount: Number(row.play_count || 0),
    likedAt: row.liked_at || row.imported_at || "",
    origin: row.origin || ""
  };
}

function shortVideoUserId(author = {}) {
  if (author.secUid) return `douyin:${author.secUid}`;
  if (author.uid) return `douyin-uid:${author.uid}`;
  return `author:${hashText(author.name || "unknown").slice(0, 18)}`;
}

function shortVideoOrigin(item = {}) {
  if (item.origin) return item.origin;
  return item.awemeId || item.author?.secUid ? "douyin_like_import" : "local_import";
}

function deleteMissingImportedVideos(db, foundIds) {
  const staleIds = foundIds.size
    ? db.prepare(`SELECT id FROM short_videos WHERE origin = 'douyin_like_import' AND id NOT IN (${[...foundIds].map(() => "?").join(",")})`).all(...foundIds).map((row) => row.id)
    : db.prepare("SELECT id FROM short_videos WHERE origin = 'douyin_like_import'").all().map((row) => row.id);
  if (!staleIds.length) return;
  const placeholders = staleIds.map(() => "?").join(",");
  db.prepare(`DELETE FROM short_videos WHERE id IN (${placeholders})`).run(...staleIds);
  deleteNormalizedVideoRows(db, staleIds);
}

function deleteNormalizedVideoRows(db, videoIds) {
  if (!videoIds.length) return;
  const placeholders = videoIds.map(() => "?").join(",");
  for (const [table, column] of [
    ["short_video_assets", "video_id"],
    ["short_video_stats", "video_id"],
    ["short_video_user_actions", "video_id"],
    ["short_video_collection_items", "video_id"],
    ["short_video_watch_history", "video_id"],
    ["short_video_import_items", "video_id"]
  ]) {
    db.prepare(`DELETE FROM ${table} WHERE ${column} IN (${placeholders})`).run(...videoIds);
  }
}

function publicVideo(row, options = {}) {
  const id = row.id || row.aweme_id || "";
  const shareUrl = normalizedDouyinShareUrl(row.share_url, row.aweme_id || id);
  const originalUrl = douyinVideoUrl(row.aweme_id || id) || shareUrl;
  return {
    id,
    awemeId: row.aweme_id || "",
    ownerUserId: row.owner_user_id || "",
    origin: row.origin || "",
    status: row.status || "normal",
    visibility: row.visibility || "local_only",
    title: row.title || row.description || row.file_name || "",
    description: row.description || "",
    tags: parseJsonArray(row.tags_json),
    author: {
      secUid: row.author_sec_uid || "",
      uid: row.author_uid || "",
      name: row.author_name || "未知作者",
      avatarUrl: row.author_avatar_url || "",
      profileUrl: row.author_profile_url || douyinUserUrl(row.author_sec_uid)
    },
    publishedAt: row.published_at || "",
    likedAt: row.liked_at || "",
    durationMs: Number(row.duration_ms || 0) || null,
    width: Number(row.width || 0) || null,
    height: Number(row.height || 0) || null,
    stats: {
      likes: Number(row.digg_count || 0),
      comments: Number(row.comment_count || 0),
      collects: Number(row.collect_count || 0),
      shares: Number(row.share_count || 0),
      plays: Number(row.play_count || 0)
    },
    shareUrl,
    originalUrl,
    streamUrl: `/media/short-video/${encodeURIComponent(id)}`,
    coverUrl: row.cover_path ? `/media/short-video-cover/${encodeURIComponent(id)}?v=${encodeURIComponent(String(row.mtime_ms || ""))}` : "",
    coverSource: row.cover_source || "",
    fileName: row.file_name || "",
    relativePath: row.relative_path || "",
    size: Number(row.size_bytes || 0),
    ...(options.detail ? {
      sourcePath: row.source_path || "",
      dataPath: row.data_path || "",
      musicPath: row.music_path || "",
      metadata: parseJsonObject(row.metadata_json)
    } : {})
  };
}

function authorFacet(db) {
  return db.prepare(`
    SELECT author_sec_uid AS secUid, author_name AS name, COUNT(*) AS count
    FROM short_video_catalog
    GROUP BY author_sec_uid, author_name
    ORDER BY count DESC, name COLLATE NOCASE
    LIMIT 160
  `).all().map((row) => ({ secUid: row.secUid || "", name: row.name || "未知作者", count: Number(row.count || 0) }));
}

function parseAuthorFolder(root, filePath) {
  const relative = path.relative(root, filePath);
  const first = relative.split(/[\\/]/)[0] || "";
  const markerIndex = first.lastIndexOf("_MS4w");
  if (markerIndex >= 0) {
    return {
      name: first.slice(0, markerIndex).trim() || "未命名作者",
      secUid: first.slice(markerIndex + 1).trim()
    };
  }
  return { name: first.trim() || "未知作者", secUid: "" };
}

function parseVideoName(name) {
  const match = /^(20\d{2}-\d{2}-\d{2})_(.+?)_([0-9]{8,})$/u.exec(String(name || ""));
  if (!match) return { date: "", title: "", awemeId: "" };
  return { date: match[1], title: match[2].trim(), awemeId: match[3] };
}

function findCompanion(files, dir, videoPath, ext, predicate) {
  const videoBase = path.basename(videoPath, path.extname(videoPath));
  const exact = files.find((name) => {
    if (ext && path.extname(name).toLowerCase() !== ext) return false;
    return predicate ? predicate(name) : name.startsWith(videoBase);
  });
  if (exact) return path.join(dir, exact);
  const loose = files.find((name) => {
    if (ext && path.extname(name).toLowerCase() !== ext) return false;
    return predicate ? predicate(name) : true;
  });
  return loose ? path.join(dir, loose) : "";
}

function findCover(files, dir, videoPath, data) {
  const videoBase = path.basename(videoPath, path.extname(videoPath)).toLowerCase();
  const local = files.find((name) => {
    const ext = path.extname(name).toLowerCase();
    if (!IMAGE_EXTS.has(ext)) return false;
    const base = path.basename(name, ext).toLowerCase();
    return base.includes("cover") || base.includes("封面") || base.startsWith(videoBase);
  }) || files.find((name) => IMAGE_EXTS.has(path.extname(name).toLowerCase()));
  if (local) return path.join(dir, local);
  return "";
}

function parseDownloadManagerPaths(value) {
  const raw = String(value || "").trim();
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed.flat(Infinity).filter((item) => typeof item === "string" && item.trim());
    if (typeof parsed === "string" && parsed.trim()) return [parsed.trim()];
  } catch {}
  return raw.split(/\r?\n|;/).map((item) => item.trim()).filter(Boolean);
}

function resolveDownloadManagerPath(outputDir, filePath) {
  const value = String(filePath || "").trim();
  if (!value) return "";
  return path.isAbsolute(value) ? path.resolve(value) : path.resolve(outputDir || "", value);
}

function firstExistingDownloadManagerPath(paths, exts, predicate = null) {
  return paths.find((filePath) => {
    if (!filePath || !exts.has(path.extname(filePath).toLowerCase())) return false;
    if (predicate && !predicate(filePath)) return false;
    return safeStat(filePath)?.isFile();
  }) || "";
}

function downloadManagerCoverPath(row, localPaths, sourcePath, outputDir) {
  const rowCoverPath = row.local_cover_path ? resolveDownloadManagerPath(outputDir, row.local_cover_path) : "";
  if (rowCoverPath && IMAGE_EXTS.has(path.extname(rowCoverPath).toLowerCase()) && safeStat(rowCoverPath)?.isFile()) {
    return rowCoverPath;
  }
  const localCover = firstExistingDownloadManagerPath(localPaths, IMAGE_EXTS, (filePath) => {
    const base = path.basename(filePath, path.extname(filePath)).toLowerCase();
    const videoBase = path.basename(sourcePath, path.extname(sourcePath)).toLowerCase();
    return base.includes("cover") || base.includes("封面") || base.startsWith(videoBase);
  }) || firstExistingDownloadManagerPath(localPaths, IMAGE_EXTS);
  if (localCover) return localCover;
  const previewPath = row.preview_path ? resolveDownloadManagerPath(outputDir, row.preview_path) : "";
  if (previewPath && IMAGE_EXTS.has(path.extname(previewPath).toLowerCase()) && safeStat(previewPath)?.isFile()) {
    return previewPath;
  }
  return "";
}

function readVideoJson(filePath) {
  if (!filePath) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function firstUrl(value) {
  const list = value?.url_list;
  if (Array.isArray(list)) return String(list[0] || "").trim();
  if (Array.isArray(value)) return value.map((item) => firstUrl(item)).find(Boolean) || "";
  if (typeof value === "string" && /^https?:\/\//i.test(value.trim())) return value.trim();
  return "";
}

function firstUrlAny(...values) {
  for (const value of values) {
    const url = firstUrl(value);
    if (url) return url;
  }
  return "";
}

function normalizedDouyinShareUrl(value, awemeId = "") {
  const url = String(value || "").trim();
  if (url) return url;
  return douyinVideoUrl(awemeId);
}

function normalizedDouyinUserUrl(value, secUid = "") {
  const url = String(value || "").trim();
  if (url) return url;
  return douyinUserUrl(secUid);
}

function douyinVideoUrl(awemeId) {
  const id = String(awemeId || "").trim();
  if (!/^\d{8,}$/.test(id)) return "";
  return `https://www.douyin.com/video/${id}`;
}

function douyinUserUrl(secUid) {
  const id = String(secUid || "").trim();
  if (!id) return "";
  return `https://www.douyin.com/user/${encodeURIComponent(id)}`;
}

function rawAwemeMetadata(data = {}) {
  const raw = data?.metadata;
  if (!raw) return null;
  if (typeof raw === "object" && !Array.isArray(raw)) return raw;
  if (typeof raw !== "string") return null;
  return parseJsonObject(raw);
}

function tagsFromText(text) {
  const tags = [];
  for (const match of String(text || "").matchAll(/[#_＃]([^\s#_＃@，,。；;]+)/gu)) {
    const tag = match[1].trim();
    if (tag && tag.length <= 30 && !tags.includes(tag)) tags.push(tag);
  }
  return tags.slice(0, 20);
}

function mergeTags(...groups) {
  const tags = [];
  const seen = new Set();
  for (const group of groups) {
    for (const tag of group || []) {
      const value = String(tag || "").trim();
      const key = value.toLowerCase();
      if (!value || seen.has(key)) continue;
      seen.add(key);
      tags.push(value);
      if (tags.length >= 20) return tags;
    }
  }
  return tags;
}

function isoFromCreateTime(value) {
  const seconds = Number(value || 0);
  if (!Number.isFinite(seconds) || seconds <= 0) return "";
  try {
    return new Date(seconds * 1000).toISOString();
  } catch {
    return "";
  }
}

function normalizeIsoDate(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toISOString();
}

function dateOnlyIso(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ""))) return "";
  return `${value}T00:00:00.000Z`;
}

function* walkFiles(root) {
  const stack = [root];
  while (stack.length) {
    const current = stack.pop();
    for (const entry of safeReadDirEntries(current)) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
      } else if (entry.isFile()) {
        yield fullPath;
      }
    }
  }
}

function safeReadDir(dir) {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

function safeReadDirEntries(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

function safeStat(filePath) {
  try {
    return fs.statSync(filePath);
  } catch {
    return null;
  }
}

function fileFromRow(row, type) {
  if (!row?.source_path) return null;
  return safeStoredFile(row.source_path, type, row.id);
}

function safeStoredFile(filePath, type, id = "") {
  const normalized = path.resolve(filePath);
  if (!fs.existsSync(normalized)) return null;
  return { id: id || hashText(normalized).slice(0, 16), path: normalized, type, ext: path.extname(normalized).toLowerCase() };
}

function coverFileName(row) {
  const id = String(row?.id || row?.aweme_id || "short-video").replace(/[^a-z0-9_-]+/gi, "-").slice(0, 80) || "short-video";
  const stamp = String(row?.mtime_ms || "");
  const hash = hashText(`${row?.source_path || ""}:${stamp}`).slice(0, 16);
  return `${id}-${hash}.jpg`;
}

function asciiInputPath(sourcePath, tempDir) {
  if (/^[\x00-\x7F]+$/.test(sourcePath)) return { path: sourcePath, cleanup: null };
  const ext = path.extname(sourcePath) || ".mp4";
  const tempPath = path.join(tempDir, `_short-video-source-${hashText(sourcePath).slice(0, 16)}${ext}`);
  try {
    fs.rmSync(tempPath, { force: true });
  } catch {}
  try {
    fs.linkSync(sourcePath, tempPath);
  } catch {
    fs.copyFileSync(sourcePath, tempPath);
  }
  return {
    path: tempPath,
    cleanup: () => {
      try {
        fs.rmSync(tempPath, { force: true });
      } catch {}
    }
  };
}

function normalizeRoots(values) {
  return [...new Set((Array.isArray(values) ? values : [values]).map((item) => String(item || "").trim()).filter(Boolean).map((item) => path.resolve(item)))];
}

function rootStatus(root) {
  return { path: root, exists: fs.existsSync(root) && fs.statSync(root).isDirectory() };
}

function metaValue(db, key) {
  return db.prepare("SELECT value FROM short_video_meta WHERE key = ?").get(key)?.value || "";
}

function normalizeSort(value) {
  const sort = String(value || "published").trim();
  return ["liked", "published", "likes", "comments", "duration"].includes(sort) ? sort : "published";
}

function videoFilter(params = new URLSearchParams()) {
  const q = String(params.get("q") || params.get("search") || "").trim();
  const author = String(params.get("author") || "").trim();
  const whereParts = [];
  const args = [];
  if (q) {
    const like = `%${escapeLike(q)}%`;
    whereParts.push(`(
      title LIKE ? ESCAPE '\\' OR
      description LIKE ? ESCAPE '\\' OR
      author_name LIKE ? ESCAPE '\\' OR
      aweme_id LIKE ? ESCAPE '\\' OR
      tags_text LIKE ? ESCAPE '\\'
    )`);
    args.push(like, like, like, like, like);
  }
  if (author && author !== "all") {
    whereParts.push("author_sec_uid = ?");
    args.push(author);
  }
  return { q, author, where: whereParts.join(" AND "), args };
}

function adjacentOrder(urlOrOptions = {}) {
  const params = urlOrOptions?.searchParams || new URLSearchParams();
  const sort = normalizeSort(params.get("sort"));
  return {
    liked: { column: "liked_at", fallback: "mtime_ms", numeric: false },
    published: { column: "published_at", fallback: "liked_at", numeric: false },
    likes: { column: "digg_count", fallback: "liked_at", numeric: true },
    comments: { column: "comment_count", fallback: "liked_at", numeric: true },
    duration: { column: "duration_ms", fallback: "liked_at", numeric: true }
  }[sort] || { column: "published_at", fallback: "liked_at", numeric: false };
}

function adjacentRow(database, row, direction, order, includeAllColumns = false, filter = null) {
  if (!row) return null;
  const column = order.column;
  const fallback = order.fallback;
  const value = row[column] ?? (order.numeric ? 0 : "");
  const fallbackValue = row[fallback] ?? (order.numeric ? "" : "");
  const select = includeAllColumns ? "*" : "id";
  const operator = direction < 0 ? ">" : "<";
  const sortDirection = direction < 0 ? "ASC" : "DESC";
  const filterWhere = filter?.where ? `${filter.where} AND ` : "";
  const filterArgs = filter?.args || [];
  return database.prepare(`
    SELECT ${select}
    FROM short_video_catalog
    WHERE ${filterWhere}(
      ${column} ${operator} ?
      OR (${column} = ? AND ${fallback} ${operator} ?)
      OR (${column} = ? AND ${fallback} = ? AND id ${operator} ?)
    )
    ORDER BY ${column} ${sortDirection}, ${fallback} ${sortDirection}, id ${sortDirection}
    LIMIT 1
  `).get(...filterArgs, value, value, fallbackValue, value, fallbackValue, row.id || "");
}

function clampInt(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(number)));
}

function escapeLike(value) {
  return String(value || "").replace(/[\\%_]/g, (match) => `\\${match}`);
}

function hashText(value) {
  return crypto.createHash("sha1").update(String(value)).digest("hex");
}

function mimeTypeForPath(filePath) {
  const ext = path.extname(String(filePath || "")).toLowerCase();
  if ([".mp4", ".m4v"].includes(ext)) return "video/mp4";
  if (ext === ".mov") return "video/quicktime";
  if (ext === ".webm") return "video/webm";
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".png") return "image/png";
  if (ext === ".webp") return "image/webp";
  if (ext === ".mp3") return "audio/mpeg";
  if (ext === ".m4a") return "audio/mp4";
  if (ext === ".aac") return "audio/aac";
  if (ext === ".wav") return "audio/wav";
  if (ext === ".flac") return "audio/flac";
  return "";
}

function parseJsonArray(value) {
  try {
    const parsed = JSON.parse(value || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function parseJsonObject(value) {
  try {
    const parsed = JSON.parse(value || "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}
