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


export function createM3uTrackMatcher(db, requestedEntries = null, baseDir = "") {
  // A bounded import still checks every active row for duplicate keys. Its
  // lookup maps only need keys that can be used by the requested entries.
  const wanted = Array.isArray(requestedEntries) && requestedEntries.length <= MAX_LIMIT
    ? requestedM3uKeys(requestedEntries, baseDir) : null;
  const query = db.prepare("SELECT id, source_path, relative_path, file_name FROM music_tracks WHERE status = 'ok'");
  const arrayRows = wanted && typeof query.setReturnArrays === "function";
  if (arrayRows) query.setReturnArrays(true);
  const rows = wanted ? query.iterate() : query.all();
  const byAbsolute = new Map();
  const byRelative = new Map();
  const byFileName = new Map();
  for (const item of rows) {
    const source_path = arrayRows ? item[1] : item.source_path;
    const relative_path = arrayRows ? item[2] : item.relative_path;
    const file_name = arrayRows ? item[3] : item.file_name;
    const absolute = m3uLookupKey(source_path, wanted?.absolute);
    const relative = m3uLookupKey(relative_path, wanted?.relative);
    const fileName = m3uLookupKey(file_name, wanted?.fileName);
    if (!absolute && !relative && !fileName) continue;
    // Expose the same SQLite row shape while only materializing matched rows.
    const row = arrayRows ? Object.assign(Object.create(null), { id: item[0], source_path, relative_path, file_name }) : item;
    addUnique(byAbsolute, absolute, row);
    addUnique(byRelative, relative, row);
    addUnique(byFileName, fileName, row);
  }
  return {
    match(entry, directory = baseDir) {
      const candidates = m3uCandidatePaths(entry, directory);
      for (const { absolute, relative } of candidates) {
        for (const key of absolute) {
          const match = byAbsolute.get(key);
          if (match) return match;
        }
        for (const key of relative) {
          const match = byRelative.get(key);
          if (match) return match;
        }
      }
      for (const { fileName } of candidates) {
        for (const key of fileName) {
          const match = byFileName.get(key);
          if (match) return match;
        }
      }
      return null;
    }
  };
}

function requestedM3uKeys(entries, baseDir) {
  const wanted = { absolute: new Set(), relative: new Set(), fileName: new Set() };
  for (const entry of entries) {
    for (const candidate of m3uCandidatePaths(entry, baseDir)) {
      for (const scope of ["absolute", "relative", "fileName"]) {
        for (const key of candidate[scope]) wanted[scope].add(key);
      }
    }
  }
  return wanted;
}

function m3uLookupKey(value, wanted) {
  if (wanted?.size === 0) return "";
  const key = normalizeM3uPathKey(value);
  return !wanted || wanted.has(key) ? key : "";
}


export function addUnique(map, key, row) {
  if (!key) return;
  if (map.has(key)) {
    map.set(key, null);
    return;
  }
  map.set(key, row);
}


function m3uCandidatePaths(entry, baseDir) {
  const raw = String(entry || "").trim();
  const decoded = decodeM3uPath(raw);
  // A plain path can contain a literal "%20". Try both of its exact lookup
  // scopes before the decoded variant. Filename-only matches come last.
  return !/^file:\/\//iu.test(raw) && raw !== decoded
    ? [m3uCandidateKeys(raw, baseDir), m3uCandidateKeys(decoded, baseDir)]
    : [m3uCandidateKeys(decoded, baseDir)];
}

function m3uCandidateKeys(value, baseDir) {
  const absolute = new Set();
  const relative = new Set();
  const fileName = new Set();
  const key = normalizeM3uPathKey(value);
  if (key) {
    if (looksAbsolutePath(value)) {
      absolute.add(normalizeM3uPathKey(path.resolve(value)));
      absolute.add(key);
    } else if (baseDir && !/^[a-z][a-z0-9+.-]*:\/\//iu.test(value)) {
      absolute.add(normalizeM3uPathKey(path.resolve(baseDir, value)));
    }
    relative.add(key);
    if (key.startsWith("./")) relative.add(key.slice(2));
    fileName.add(normalizeM3uPathKey(path.basename(value)));
    fileName.add(normalizeM3uPathKey(path.win32.basename(value)));
    fileName.add(normalizeM3uPathKey(path.posix.basename(value)));
  }
  return { absolute, relative, fileName };
}


export function decodeM3uPath(value) {
  const raw = String(value || "").trim();
  if (/^file:\/\//iu.test(raw)) {
    try {
      const url = new URL(raw);
      const pathname = decodeURIComponent(url.pathname);
      // Keep the UNC host so an absolute network path cannot match a local
      // drive's same-named file before the relative-name fallback runs.
      if (url.hostname) return `//${url.hostname}${pathname}`;
      return pathname.replace(/^\/([A-Za-z]:\/)/u, "$1");
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
  let key = String(value || "").trim();
  if (key.includes("\\")) key = key.replaceAll("\\", "/");
  if (key.includes("//")) key = key.replace(/\/+/g, "/");
  return key.toLowerCase();
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
    const entry = m3uPath(target);
    lines.push(entry.startsWith("#") ? `./${entry}` : entry);
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


export function playlistTrackIdsFromInput(input = {}, { limit = MAX_LIMIT } = {}) {
  const source = Array.isArray(input.trackIds) ? input.trackIds : Array.isArray(input.tracks) ? input.tracks : [];
  const seen = new Set();
  const result = [];
  for (const item of source) {
    const id = String(typeof item === "object" && item ? item.id || item.trackId || item.track_id || "" : item || "").trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    result.push(id);
    if (result.length >= limit) break;
  }
  return result;
}
