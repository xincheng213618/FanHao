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
const DEFAULT_COVER_GENERATE_LIMIT = 24;

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
      ensureSchema(db);
    }
    return db;
  }

  function close() {
    if (!db) return;
    try {
      db.close();
    } catch {}
    db = null;
  }

  function summary() {
    const database = databaseOrOpen();
    const totals = database.prepare(`
      SELECT
        COUNT(*) AS videos,
        COUNT(DISTINCT author_sec_uid) AS authors,
        COALESCE(SUM(size_bytes), 0) AS bytes,
        COALESCE(SUM(duration_ms), 0) AS durationMs
      FROM short_videos
    `).get();
    const scannedAt = metaValue(database, "scanned_at");
    const sourceRoot = metaValue(database, "source_root");
    const authorRows = database.prepare(`
      SELECT author_sec_uid, author_name, COUNT(*) AS count
      FROM short_videos
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
    const where = filter.where ? `WHERE ${filter.where}` : "";
    const orderBy = {
      liked: "liked_at DESC, mtime_ms DESC",
      published: "published_at DESC, liked_at DESC",
      likes: "digg_count DESC, liked_at DESC",
      comments: "comment_count DESC, liked_at DESC",
      duration: "duration_ms DESC, liked_at DESC"
    }[sort] || "published_at DESC, liked_at DESC";
    const database = databaseOrOpen();
    const total = database.prepare(`SELECT COUNT(*) AS count FROM short_videos ${where}`).get(...filter.args)?.count || 0;
    const rows = database.prepare(`
      SELECT *
      FROM short_videos
      ${where}
      ORDER BY ${orderBy}, id DESC
      LIMIT ? OFFSET ?
    `).all(...filter.args, limit, offset);
    ensureGeneratedCovers(database, rows, coverGenerateLimit);
    return {
      summary: summary(),
      total: Number(total || 0),
      limit,
      offset,
      hasMore: offset + rows.length < Number(total || 0),
      query: filter.q,
      author: filter.author,
      sort,
      authors: authorFacet(database),
      videos: rows.map(publicVideo)
    };
  }

  function videoDetail(id, urlOrOptions = {}) {
    const database = databaseOrOpen();
    const row = database.prepare("SELECT * FROM short_videos WHERE id = ? OR aweme_id = ?").get(id, id);
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
    const current = database.prepare("SELECT id, liked_at FROM short_videos WHERE id = ? OR aweme_id = ?").get(id, id);
    if (!current) return null;
    const fullCurrent = database.prepare("SELECT * FROM short_videos WHERE id = ?").get(current.id);
    const filter = videoFilter(urlOrOptions?.searchParams || new URLSearchParams());
    const row = adjacentRow(database, fullCurrent, direction, adjacentOrder(urlOrOptions), true, filter);
    if (row) ensureGeneratedCovers(database, [row], 1);
    return row ? publicVideo(row, { detail: true }) : null;
  }

  function videoFile(id, options = {}) {
    const row = databaseOrOpen().prepare("SELECT id, source_path FROM short_videos WHERE id = ? OR aweme_id = ?").get(id, id);
    if (options.allowMissing && row?.source_path) {
      return { id: row.id || id, path: path.resolve(row.source_path), type: "video", ext: path.extname(row.source_path).toLowerCase() };
    }
    return fileFromRow(row, "video");
  }

  function coverFile(id) {
    const database = databaseOrOpen();
    const row = database.prepare("SELECT * FROM short_videos WHERE id = ? OR aweme_id = ?").get(id, id);
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
      generated += 1;
      database.prepare("UPDATE short_videos SET cover_path = ?, updated_at = ? WHERE id = ?").run(
        coverPath,
        new Date().toISOString(),
        row.id
      );
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
    const upsert = database.prepare(`
      INSERT INTO short_videos (
        id, aweme_id, author_sec_uid, author_uid, author_name, author_avatar_url,
        title, description, tags_json, tags_text, create_time, published_at, liked_at,
        duration_ms, width, height, digg_count, comment_count, collect_count,
        share_count, play_count, share_url, source_path, cover_path, music_path,
        data_path, relative_path, file_name, size_bytes, mtime_ms, imported_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
        source_path = excluded.source_path,
        cover_path = excluded.cover_path,
        music_path = excluded.music_path,
        data_path = excluded.data_path,
        relative_path = excluded.relative_path,
        file_name = excluded.file_name,
        size_bytes = excluded.size_bytes,
        mtime_ms = excluded.mtime_ms,
        updated_at = excluded.updated_at
    `);
    const writeBatch = (items) => {
      if (!items.length) return;
      database.exec("BEGIN");
      try {
        for (const item of items) {
          foundIds.add(item.id);
          upsert.run(...videoRowValues(item, now));
        }
        database.prepare("INSERT OR REPLACE INTO short_video_meta (key, value) VALUES ('scanned_at', ?)").run(now);
        database.prepare("INSERT OR REPLACE INTO short_video_meta (key, value) VALUES ('source_root', ?)").run(root);
        database.prepare("INSERT OR REPLACE INTO short_video_meta (key, value) VALUES ('scanner_version', '1')").run();
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
    if (foundIds.size) {
      const placeholders = [...foundIds].map(() => "?").join(",");
      database.prepare(`DELETE FROM short_videos WHERE id NOT IN (${placeholders})`).run(...foundIds);
    } else {
      database.prepare("DELETE FROM short_videos").run();
    }
    return { ok: true, root, scannedFiles, imported, scannedAt: now, summary: summary() };
  }

  function databaseOrOpen() {
    return database();
  }

  return {
    adjacentVideo,
    close,
    coverFile,
    dbPath,
    listVideos,
    roots,
    scan,
    summary,
    videoDetail,
    videoFile
  };
}

function ensureSchema(db) {
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
      source_path TEXT NOT NULL,
      cover_path TEXT NOT NULL DEFAULT '',
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
  `);
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
    shareUrl: String(data?.share_url || "").trim(),
    sourcePath: path.resolve(filePath),
    coverPath,
    musicPath,
    dataPath,
    relativePath: path.relative(root, filePath),
    fileName: path.basename(filePath),
    sizeBytes: stat.size,
    mtimeMs: Math.floor(stat.mtimeMs || 0)
  };
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
    item.sourcePath,
    item.coverPath,
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

function publicVideo(row, options = {}) {
  const id = row.id || row.aweme_id || "";
  return {
    id,
    awemeId: row.aweme_id || "",
    title: row.title || row.description || row.file_name || "",
    description: row.description || "",
    tags: parseJsonArray(row.tags_json),
    author: {
      secUid: row.author_sec_uid || "",
      uid: row.author_uid || "",
      name: row.author_name || "未知作者",
      avatarUrl: row.author_avatar_url || ""
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
    shareUrl: row.share_url || "",
    streamUrl: `/media/short-video/${encodeURIComponent(id)}`,
    coverUrl: row.cover_path ? `/media/short-video-cover/${encodeURIComponent(id)}?v=${encodeURIComponent(String(row.mtime_ms || ""))}` : "",
    fileName: row.file_name || "",
    relativePath: row.relative_path || "",
    size: Number(row.size_bytes || 0),
    ...(options.detail ? { sourcePath: row.source_path || "", dataPath: row.data_path || "", musicPath: row.music_path || "" } : {})
  };
}

function authorFacet(db) {
  return db.prepare(`
    SELECT author_sec_uid AS secUid, author_name AS name, COUNT(*) AS count
    FROM short_videos
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
  return "";
}

function tagsFromText(text) {
  const tags = [];
  for (const match of String(text || "").matchAll(/[#_＃]([^\s#_＃@，,。；;]+)/gu)) {
    const tag = match[1].trim();
    if (tag && tag.length <= 30 && !tags.includes(tag)) tags.push(tag);
  }
  return tags.slice(0, 20);
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
    FROM short_videos
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

function parseJsonArray(value) {
  try {
    const parsed = JSON.parse(value || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}
