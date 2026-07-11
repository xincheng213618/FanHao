// Music store sub-module: helpers
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

// 歌手/专辑首字母索引导航过滤：A-Z / 0-9 / 待(待识别) / #(其余非字母数字)

export function buildLetterCondition(letter, col, artistCol) {
  if (/^[A-Za-z]$/.test(letter)) {
    return { sql: `UPPER(SUBSTR(${col}, 1, 1)) = ?`, args: [letter.toUpperCase()] };
  }
  if (/^[0-9]$/.test(letter)) {
    return { sql: `SUBSTR(${col}, 1, 1) GLOB '[0-9]'`, args: [] };
  }
  if (letter === "待") {
    return { sql: `${artistCol} = '待识别'`, args: [] };
  }
  if (letter === "#") {
    return { sql: `(UPPER(SUBSTR(${col}, 1, 1)) NOT BETWEEN 'A' AND 'Z' AND SUBSTR(${col}, 1, 1) NOT GLOB '[0-9]')`, args: [] };
  }
  return null;
}


export function metaValue(db, key) {
  try {
    return db.prepare("SELECT value FROM music_meta WHERE key = ?").get(key)?.value || "";
  } catch {
    return "";
  }
}


export function normalizeTrackSort(value) {
  const sort = String(value || "album").trim();
  return ["album", "title", "artist", "duration", "played", "favorite", "rating"].includes(sort) ? sort : "album";
}


export function normalizeAlbumSort(value) {
  const sort = String(value || "updated").trim();
  return ["updated", "title", "year", "tracks"].includes(sort) ? sort : "updated";
}


export function trackOrderSql(sort) {
  if (sort === "title") return "t.title COLLATE NOCASE ASC, t.display_artist COLLATE NOCASE ASC";
  if (sort === "artist") return "t.display_artist COLLATE NOCASE ASC, t.album_title COLLATE NOCASE ASC, t.track_no ASC, t.title COLLATE NOCASE ASC";
  if (sort === "duration") return "t.duration_ms DESC, t.title COLLATE NOCASE ASC";
  if (sort === "played") return "s.last_played_at IS NULL ASC, s.last_played_at DESC, t.album_title COLLATE NOCASE ASC, t.track_no ASC";
  if (sort === "favorite") return "COALESCE(s.favorite, 0) DESC, s.updated_at DESC, t.title COLLATE NOCASE ASC";
  if (sort === "rating") return "COALESCE(s.rating, 0) DESC, s.updated_at DESC, t.title COLLATE NOCASE ASC";
  return "t.album_title COLLATE NOCASE ASC, t.disc_no ASC, t.track_no ASC, t.title COLLATE NOCASE ASC";
}


export function cleanArtistName(value) {
  return String(value || "未知歌手")
    .replace(/[（(]\s*(?:完结|更新中|全集|无损)\s*[）)]/giu, "")
    .replace(/\s+/g, " ")
    .trim() || "未知歌手";
}


export function artistNameForSort(value) {
  return String(value || "")
    .normalize("NFKC")
    .replace(/^[\s\p{P}\p{S}_]+/gu, "")
    .trim();
}


export function cleanAlbumTitle(value) {
  return String(value || "单曲").replace(/\s+/g, " ").trim() || "单曲";
}


export function cleanTrackTitle(value) {
  return String(value || "未命名歌曲")
    .replace(/^\d{1,4}[\s._-]+/u, "")
    .replace(/\s+/g, " ")
    .trim() || "未命名歌曲";
}


export function cleanComparable(value) {
  return String(value || "").replace(/\s+/g, "").toLowerCase();
}


export function sortKey(value) {
  return String(value || "").trim().toLowerCase();
}


export function yearFromText(value) {
  const match = /(19|20)\d{2}/.exec(String(value || ""));
  return match ? match[0] : "";
}


export function numberPrefix(value) {
  const match = /^(\d{1,3})/.exec(String(value || "").trim());
  return match ? Number(match[1]) || 0 : 0;
}


export function isJunkAssetName(name) {
  return /微信公众号|欢迎关注|阿里云盘|达人招募|延期卡|50TB|扫码|二维码/iu.test(String(name || ""));
}


export function normalizedPathKey(value) {
  return path.resolve(String(value || "")).normalize("NFKC").toLocaleLowerCase();
}


export function escapeLike(value) {
  return String(value || "").replace(/[\\%_]/g, (item) => `\\${item}`);
}


export function hashText(value) {
  return crypto.createHash("sha1").update(String(value)).digest("hex");
}


export function parseJsonArray(value) {
  try {
    const parsed = JSON.parse(value || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}


export function parseJsonObject(value) {
  try {
    const parsed = JSON.parse(value || "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}


export function safeReadDir(dir) {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}


export function safeReadDirEntries(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}


export function safeStat(filePath) {
  try {
    return filePath ? fs.statSync(filePath) : null;
  } catch {
    return null;
  }
}


export function httpError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}


export function clampInt(value, fallback, min, max) {
  if (value === null || value === undefined || String(value).trim?.() === "") return fallback;
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(number)));
}
