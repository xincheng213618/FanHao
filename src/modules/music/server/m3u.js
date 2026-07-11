// Music store sub-module: m3u
import path from "node:path";
import { MAX_LIMIT, MAX_M3U_BYTES } from "./constants.js";
import { httpError, safeStat } from "./helpers.js";
import { readSmallText } from "./scan.js";

export function readM3uInput(input = {}) {
  const rawContent = typeof input.content === "string" ? input.content : "";
  if (rawContent.trim()) {
    return {
      content: rawContent,
      baseDir: "",
      name: String(input.name || "").trim(),
      source: "content"
    };
  }
  const rawPath = String(input.path || input.filePath || "").trim();
  if (!rawPath) throw httpError(400, "缺少 M3U 文件路径或内容");
  const filePath = path.resolve(rawPath);
  const stat = safeStat(filePath);
  if (!stat?.isFile()) throw httpError(404, "M3U 文件不存在");
  if (stat.size > MAX_M3U_BYTES) throw httpError(400, "M3U 文件过大");
  return {
    content: readSmallText(filePath, MAX_M3U_BYTES),
    baseDir: path.dirname(filePath),
    name: path.basename(filePath, path.extname(filePath)),
    source: filePath
  };
}

export function parseM3u(content = "") {
  const entries = [];
  let name = "";
  for (const rawLine of String(content || "").replace(/^\uFEFF/u, "").split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line.startsWith("#")) {
      if (line.toUpperCase().startsWith("#PLAYLIST:")) name = line.slice(line.indexOf(":") + 1).trim();
      continue;
    }
    entries.push(line);
  }
  return { name, entries };
}


export function createM3uTrackMatcher(db) {
  const rows = db.prepare("SELECT id, source_path, relative_path, file_name FROM music_tracks WHERE status = 'ok'").all();
  const byAbsolute = new Map();
  const byRelative = new Map();
  const byFileName = new Map();
  for (const row of rows) {
    addUnique(byAbsolute, normalizeM3uPathKey(row.source_path), row);
    addUnique(byRelative, normalizeM3uPathKey(row.relative_path), row);
    addUnique(byFileName, normalizeM3uPathKey(row.file_name), row);
  }
  return {
    match(entry, baseDir = "") {
      const candidates = m3uCandidateKeys(entry, baseDir);
      for (const key of candidates.absolute) {
        const match = byAbsolute.get(key);
        if (match) return match;
      }
      for (const key of candidates.relative) {
        const match = byRelative.get(key);
        if (match) return match;
      }
      for (const key of candidates.fileName) {
        const match = byFileName.get(key);
        if (match) return match;
      }
      return null;
    }
  };
}


export function addUnique(map, key, row) {
  if (!key) return;
  if (map.has(key)) {
    map.set(key, null);
    return;
  }
  map.set(key, row);
}


export function m3uCandidateKeys(entry, baseDir = "") {
  const raw = decodeM3uPath(entry);
  const absolute = new Set();
  const relative = new Set();
  const fileName = new Set();
  const addPath = (value) => {
    const key = normalizeM3uPathKey(value);
    if (!key) return;
    if (looksAbsolutePath(value)) absolute.add(normalizeM3uPathKey(path.resolve(value)));
    relative.add(key);
    fileName.add(normalizeM3uPathKey(path.basename(value)));
    fileName.add(normalizeM3uPathKey(path.win32.basename(value)));
    fileName.add(normalizeM3uPathKey(path.posix.basename(value)));
  };
  addPath(raw);
  if (baseDir && raw && !looksAbsolutePath(raw) && !/^[a-z][a-z0-9+.-]*:\/\//iu.test(raw)) {
    absolute.add(normalizeM3uPathKey(path.resolve(baseDir, raw)));
  }
  if (looksAbsolutePath(raw)) absolute.add(normalizeM3uPathKey(path.resolve(raw)));
  return { absolute, relative, fileName };
}


export function decodeM3uPath(value) {
  const raw = String(value || "").trim();
  if (/^file:\/\//iu.test(raw)) {
    try {
      return decodeURIComponent(new URL(raw).pathname).replace(/^\/([A-Za-z]:\/)/u, "$1");
    } catch {
      return raw.replace(/^file:\/+/iu, "");
    }
  }
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}


export function normalizeM3uPathKey(value) {
  return String(value || "").trim().replace(/\\/g, "/").replace(/\/+/g, "/").toLowerCase();
}


export function looksAbsolutePath(value) {
  const raw = String(value || "");
  return path.isAbsolute(raw) || /^[A-Za-z]:[\\/]/u.test(raw) || /^\/[A-Za-z]:\//u.test(raw.replace(/\\/g, "/"));
}


export function formatM3uPlaylist(playlist, tracks = [], pathMode = "absolute") {
  const lines = ["#EXTM3U", `#PLAYLIST:${m3uText(playlist.name || "FanHao 歌单")}`];
  for (const track of tracks) {
    const seconds = Math.round(Number(track.duration_ms || 0) / 1000);
    const artist = track.display_artist || "";
    const title = track.title || path.basename(track.file_name || track.source_path || "music", path.extname(track.file_name || ""));
    const label = artist ? `${artist} - ${title}` : title;
    const target = pathMode === "relative" ? track.relative_path || track.file_name || track.source_path || "" : track.source_path || track.relative_path || track.file_name || "";
    lines.push(`#EXTINF:${seconds > 0 ? seconds : -1},${m3uText(label)}`);
    lines.push(m3uPath(target));
  }
  return `${lines.join("\n")}\n`;
}


export function m3uText(value) {
  return String(value || "").replace(/[\r\n]+/g, " ").trim();
}


export function m3uPath(value) {
  return String(value || "").replace(/[\r\n]+/g, " ").trim();
}


export function safePlaylistFileName(value) {
  return String(value || "FanHao 歌单")
    .replace(/[<>:"/\\|?*\u0000-\u001f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80) || "FanHao 歌单";
}


export function playlistTrackIdsFromInput(input = {}) {
  const source = Array.isArray(input.trackIds) ? input.trackIds : Array.isArray(input.tracks) ? input.tracks : [];
  const seen = new Set();
  const result = [];
  for (const item of source) {
    const id = String(typeof item === "object" && item ? item.id || item.trackId || item.track_id || "" : item || "").trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    result.push(id);
    if (result.length >= MAX_LIMIT) break;
  }
  return result;
}
