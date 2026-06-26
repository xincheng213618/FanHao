import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { DEFAULT_MAX_COVER_BYTES, extractCoverFrame } from "./lib/cover-frame.js";
import { normalizeWorkCode as parseNormalizedWorkCode, workCodeKey } from "./lib/code-parser.js";
import { decodeInfoBuffer, isSubtitleLikeInfoText, parseInfoMetadata, renderInfoMetadataText } from "./lib/info-metadata.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT || 29998);
const HOST = process.env.HOST || "0.0.0.0";
const LIBRARY_ROOTS = parseLibraryRoots();
const PUBLIC_DIR = path.join(__dirname, "public");
const DATA_DIR = path.join(__dirname, "data");
const INDEX_CACHE_PATH = path.join(DATA_DIR, "library-index.json");
const USER_STATE_PATH = path.join(DATA_DIR, "user-state.json");
const ACTOR_PROFILE_DB_PATH = path.join(DATA_DIR, "actor-profiles.sqlite");
const APP_CONFIG_PATH = path.join(DATA_DIR, "app-config.json");
const FFMPEG_PATH = process.env.FFMPEG_PATH || "ffmpeg";
const FFPROBE_PATH = process.env.FFPROBE_PATH || "ffprobe";

const EXCLUDED_DIRS = new Set(["$RECYCLE.BIN", "System Volume Information", "Recovery"]);
const VIDEO_EXTS = new Set([".mp4", ".mkv", ".avi", ".mov", ".wmv", ".flv", ".m4v", ".ts", ".webm", ".iso"]);
const PLAYABLE_VIDEO_EXTS = new Set([".mp4", ".m4v", ".mov", ".webm"]);
const DIRECT_VIDEO_EXTS = new Set([".mp4", ".m4v", ".webm"]);
const IMAGE_EXTS = new Set([".jpg", ".jpeg", ".png", ".webp", ".bmp", ".gif"]);
const INFO_EXTS = new Set([".nfo", ".txt", ".json", ".xml", ".html", ".htm", ".csv", ".md", ".srt", ".ass", ".ssa"]);
const COVER_HINTS = new Set(["cover", "poster", "folder", "front", "fanart", "thumb", "thumbnail"]);
const MAX_INFO_BYTES = 1024 * 1024;
const MAX_GENERATED_COVER_BYTES = DEFAULT_MAX_COVER_BYTES;
const DEFAULT_WORK_LIMIT = 160;
const MAX_WORK_LIMIT = 1200;
const HAS_NVENC = detectNvenc();
const VIDEO_PROBE_CACHE_LIMIT = 512;
const videoProbeCache = new Map();
const DEFAULT_APP_CONFIG = {
  compilationPrefixes: ["OFJE", "THN", "THU"],
  compilationKeywords: ["合集", "総集編", "総集", "コンプリート", "全タイトル", "ベスト盤"],
  actorAvatarDataPath: ""
};
const LOCAL_ACTOR_AVATAR_SOURCE = "local-avatar";
const MAX_ACTOR_AVATAR_BYTES = 8 * 1024 * 1024;
const ACTOR_AVATAR_EXTS = new Set([".jpg", ".jpeg", ".png", ".webp"]);
const DEFAULT_FAVORITE_FOLDER_ID = "default";
const DEFAULT_FAVORITE_FOLDER_NAME = "默认收藏";
const MAX_FAVORITE_FOLDERS = 30;
const RECENT_WATCHED_DAYS = 30;

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".bmp": "image/bmp",
  ".mp4": "video/mp4",
  ".m4v": "video/mp4",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
  ".mkv": "video/x-matroska",
  ".avi": "video/x-msvideo",
  ".wmv": "video/x-ms-wmv",
  ".flv": "video/x-flv",
  ".ts": "video/mp2t",
  ".iso": "application/octet-stream",
  ".txt": "text/plain; charset=utf-8",
  ".nfo": "text/plain; charset=utf-8",
  ".srt": "text/plain; charset=utf-8",
  ".ass": "text/plain; charset=utf-8",
  ".ssa": "text/plain; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".xml": "application/xml; charset=utf-8",
  ".csv": "text/csv; charset=utf-8"
};

let library = emptyLibrary();
let lastScanError = null;
let userState = emptyUserState();
let appConfig = defaultAppConfig();
let actorDb = null;
let workInfoCache = null;
let actorProfileCache = null;
let actorMovieCache = null;
let localWorkCodeKeyCache = null;
let localWorkByCodeKeyCache = null;
let rankingMissingSearchCache = null;
let actorMissingSearchCache = null;
let workSearchTextCache = null;
let adminTaskSeq = 0;
const adminTasks = [];

function parseLibraryRoots() {
  const raw =
    process.env.LIBRARY_ROOTS ||
    process.env.LIBRARY_ROOT ||
    "G:\\;F:\\;O:\\;O:\\[珍藏]\\;O:\\[珍藏1]\\;V:\\[A]\\;V:\\[A1]\\;V:\\AV\\";
  const roots = raw
    .split(/[;,|]/)
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => {
      const parsed = path.parse(item);
      const root = item.endsWith("\\") || item.endsWith("/") ? item : item + path.sep;
      return parsed.root ? root : path.resolve(root);
    });

  return [...new Set(roots)];
}

function emptyLibrary() {
  return {
    root: LIBRARY_ROOTS.join(";"),
    roots: LIBRARY_ROOTS,
    availableRoots: [],
    missingRoots: [],
    scannedAt: null,
    people: [],
    peopleById: new Map(),
    worksById: new Map(),
    filesById: new Map(),
    totals: {
      people: 0,
      works: 0,
      videos: 0,
      playableVideos: 0,
      images: 0,
      infoFiles: 0
    }
  };
}

function emptyUserState() {
  return {
    version: 2,
    favoriteFolders: {
      [DEFAULT_FAVORITE_FOLDER_ID]: {
        name: DEFAULT_FAVORITE_FOLDER_NAME,
        createdAt: ""
      }
    },
    favorites: {},
    progress: {}
  };
}

function defaultAppConfig() {
  return {
    compilationPrefixes: [...DEFAULT_APP_CONFIG.compilationPrefixes],
    compilationKeywords: [...DEFAULT_APP_CONFIG.compilationKeywords]
  };
}

function uniqueTrimmedStrings(values, options = {}) {
  const seen = new Set();
  const result = [];
  const maxLength = options.maxLength || 40;
  const transform = options.transform || ((value) => value);
  for (const value of Array.isArray(values) ? values : []) {
    const normalized = transform(String(value || "").trim());
    if (!normalized || normalized.length > maxLength || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
  }
  return result.slice(0, options.maxItems || 100);
}

function normalizeCompilationPrefix(value) {
  return String(value || "")
    .trim()
    .replace(/[-_\s]+$/g, "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
}

function normalizeAppConfig(value = {}) {
  const fallback = defaultAppConfig();
  const input = value && typeof value === "object" ? value : {};
  const prefixes = uniqueTrimmedStrings(input.compilationPrefixes, {
    maxLength: 16,
    maxItems: 80,
    transform: normalizeCompilationPrefix
  });
  const keywords = uniqueTrimmedStrings(input.compilationKeywords, {
    maxLength: 40,
    maxItems: 120
  });

  return {
    compilationPrefixes: prefixes.length ? prefixes : fallback.compilationPrefixes,
    compilationKeywords: keywords.length ? keywords : fallback.compilationKeywords,
    actorAvatarDataPath: String(input.actorAvatarDataPath || "").trim().slice(0, 1000)
  };
}

function loadAppConfig() {
  appConfig = defaultAppConfig();
  if (!fs.existsSync(APP_CONFIG_PATH)) return;

  try {
    appConfig = normalizeAppConfig(JSON.parse(fs.readFileSync(APP_CONFIG_PATH, "utf8")));
  } catch (error) {
    console.warn(`[config] failed to load app config: ${error.message}`);
    appConfig = defaultAppConfig();
  }
}

function saveAppConfig() {
  ensureDataDir();
  fs.writeFileSync(APP_CONFIG_PATH, JSON.stringify(appConfig, null, 2), "utf8");
}

function publicAppConfig() {
  return {
    compilationPrefixes: [...appConfig.compilationPrefixes],
    compilationKeywords: [...appConfig.compilationKeywords],
    actorAvatarDataPath: appConfig.actorAvatarDataPath || ""
  };
}

function isExcludedDirName(name) {
  const lower = name.toLowerCase();
  return EXCLUDED_DIRS.has(name) || name.startsWith("$") || name.startsWith(".") || lower.startsWith("found.");
}

function normalizeExt(fileName) {
  return path.extname(fileName).toLowerCase();
}

function isVideo(fileName) {
  return VIDEO_EXTS.has(normalizeExt(fileName));
}

function isPlayableVideo(fileName) {
  return PLAYABLE_VIDEO_EXTS.has(normalizeExt(fileName));
}

function isImage(fileName) {
  return IMAGE_EXTS.has(normalizeExt(fileName));
}

function isInfo(fileName) {
  return INFO_EXTS.has(normalizeExt(fileName));
}

function fileBase(fileName) {
  return path.basename(fileName, path.extname(fileName));
}

function createId(prefix, value) {
  return `${prefix}_${Buffer.from(value).toString("base64url")}`;
}

function cleanFavoriteFolderName(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 32);
}

function defaultFavoriteFolders() {
  return {
    [DEFAULT_FAVORITE_FOLDER_ID]: {
      name: DEFAULT_FAVORITE_FOLDER_NAME,
      createdAt: ""
    }
  };
}

function normalizeFavoriteFolders(value) {
  const folders = defaultFavoriteFolders();
  if (!value || typeof value !== "object") return folders;

  for (const [rawId, rawFolder] of Object.entries(value)) {
    const id = String(rawId || "").trim();
    if (!id || id.length > 96) continue;
    const folder = rawFolder && typeof rawFolder === "object" ? rawFolder : {};
    const name = cleanFavoriteFolderName(folder.name) || (id === DEFAULT_FAVORITE_FOLDER_ID ? DEFAULT_FAVORITE_FOLDER_NAME : "");
    if (!name) continue;
    folders[id] = {
      name,
      createdAt: String(folder.createdAt || "")
    };
  }

  folders[DEFAULT_FAVORITE_FOLDER_ID].name = folders[DEFAULT_FAVORITE_FOLDER_ID].name || DEFAULT_FAVORITE_FOLDER_NAME;
  return folders;
}

function normalizeFavoriteFolderId(value, folders = userState.favoriteFolders) {
  const id = String(value || "").trim();
  return id && folders?.[id] ? id : DEFAULT_FAVORITE_FOLDER_ID;
}

function normalizeFavoriteRecord(value, folders) {
  const record = value && typeof value === "object" ? value : {};
  return {
    createdAt: String(record.createdAt || ""),
    folderId: normalizeFavoriteFolderId(record.folderId, folders)
  };
}

function normalizeFavorites(value, folders) {
  const favorites = {};
  if (!value || typeof value !== "object") return favorites;
  for (const [workId, favorite] of Object.entries(value)) {
    if (!workId) continue;
    favorites[workId] = normalizeFavoriteRecord(favorite, folders);
  }
  return favorites;
}

function rootLabel(rootPath) {
  return rootPath.replace(/[\\/]+$/, "").replaceAll(path.sep, "/");
}

function relativeFromRoot(fullPath) {
  const matchingRoot = [...LIBRARY_ROOTS]
    .sort((a, b) => b.length - a.length)
    .find((rootPath) => {
      const relative = path.relative(rootPath, fullPath);
      return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
    });

  if (!matchingRoot) {
    return fullPath.replaceAll(path.sep, "/");
  }

  const relative = path.relative(matchingRoot, fullPath).replaceAll(path.sep, "/");
  const label = rootLabel(matchingRoot);
  return relative ? `${label}/${relative}` : label;
}

function sourcePathToAbsolute(sourcePath) {
  const raw = String(sourcePath || "").trim();
  if (!raw) return "";
  return path.resolve(raw.replaceAll("/", path.sep));
}

function pathWithinRoot(targetPath, rootPath) {
  const target = path.resolve(targetPath).toLowerCase();
  const root = path.resolve(rootPath).toLowerCase();
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function libraryOpenRoots() {
  return [...new Set([...(library.availableRoots || []), ...LIBRARY_ROOTS])];
}

function resolveLocalFolderTarget(sourcePath) {
  const absolutePath = sourcePathToAbsolute(sourcePath);
  if (!absolutePath) {
    return { error: "缺少文件夹路径" };
  }

  const allowed = libraryOpenRoots().some((rootPath) => pathWithinRoot(absolutePath, rootPath));
  if (!allowed) {
    return { error: "只能打开资料库根目录内的文件夹" };
  }

  const stat = safeStat(absolutePath);
  if (!stat) {
    return { error: "本地文件夹不存在" };
  }

  return { folderPath: stat.isDirectory() ? absolutePath : path.dirname(absolutePath) };
}

function openFolderInSystem(folderPath) {
  const platform = process.platform;
  const command = platform === "win32" ? process.env.ComSpec || "cmd.exe" : platform === "darwin" ? "open" : "xdg-open";
  const args = platform === "win32" ? ["/d", "/c", "start", "", folderPath] : [folderPath];
  const child = spawn(command, args, {
    detached: true,
    stdio: "ignore",
    windowsHide: true
  });
  child.unref();
}

function scheduleOpenFolder(folderPath) {
  setTimeout(() => {
    try {
      openFolderInSystem(folderPath);
    } catch (error) {
      console.warn("[open-folder]", error.message);
    }
  }, 25);
}

function safeStat(filePath) {
  try {
    return fs.statSync(filePath);
  } catch {
    return null;
  }
}

function walkFiles(rootDir) {
  const results = [];
  const stack = [rootDir];

  while (stack.length) {
    const current = stack.pop();
    let entries = [];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!isExcludedDirName(entry.name)) {
          stack.push(path.join(current, entry.name));
        }
        continue;
      }

      if (entry.isFile()) {
        results.push(path.join(current, entry.name));
      }
    }
  }

  return results;
}

function directChildDirectories(rootDir) {
  try {
    return fs
      .readdirSync(rootDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !isExcludedDirName(entry.name))
      .map((entry) => path.join(rootDir, entry.name));
  } catch {
    return [];
  }
}

function directFiles(rootDir) {
  try {
    return fs
      .readdirSync(rootDir, { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => path.join(rootDir, entry.name));
  } catch {
    return [];
  }
}

function toMediaFile(fullPath, type) {
  const stat = safeStat(fullPath);
  return {
    id: createId(type[0], fullPath),
    type,
    name: path.basename(fullPath),
    title: fileBase(path.basename(fullPath)),
    ext: normalizeExt(fullPath),
    path: fullPath,
    relativePath: relativeFromRoot(fullPath),
    size: stat?.size || 0,
    modifiedAt: stat?.mtime?.toISOString() || null,
    playable: type === "video" ? isPlayableVideo(fullPath) : undefined
  };
}

function chooseCover(images, preferredBaseName, workDir) {
  if (!images.length) {
    return null;
  }

  const preferred = preferredBaseName.toLowerCase();
  const scored = images.map((image, index) => {
    const base = fileBase(image.name).toLowerCase();
    const depth = path.relative(workDir, image.path).split(path.sep).filter(Boolean).length;
    let score = 0;

    if (COVER_HINTS.has(base)) score += 120;
    if (base === preferred) score += 100;
    if (base.includes(preferred) || preferred.includes(base)) score += 30;
    if (depth <= 1) score += 20;
    if ([".jpg", ".jpeg", ".webp", ".png"].includes(image.ext)) score += 5;

    return { image, score, index };
  });

  scored.sort((a, b) => b.score - a.score || a.index - b.index);
  return scored[0].image;
}

function collectMediaFiles(files) {
  const videos = [];
  const images = [];
  const infos = [];

  for (const fullPath of files) {
    const name = path.basename(fullPath);
    if (isVideo(name)) {
      videos.push(toMediaFile(fullPath, "video"));
    } else if (isImage(name)) {
      images.push(toMediaFile(fullPath, "image"));
    } else if (isInfo(name)) {
      infos.push(toMediaFile(fullPath, "info"));
    }
  }

  videos.sort(compareNaturalName);
  images.sort(compareNaturalName);
  infos.sort(compareNaturalName);

  return { videos, images, infos };
}

function compareNaturalName(a, b) {
  return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });
}

function compareNaturalTitle(a, b) {
  return a.title.localeCompare(b.title, undefined, { numeric: true, sensitivity: "base" });
}

function detectNvenc() {
  if (process.env.FANHAO_DISABLE_NVENC === "1") return false;
  try {
    const result = spawnSync(FFMPEG_PATH, ["-hide_banner", "-encoders"], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 3000
    });
    return `${result.stdout || ""}${result.stderr || ""}`.includes("h264_nvenc");
  } catch {
    return false;
  }
}

function normalizeSearchValue(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[\s._\-()[\]【】（）]+/g, "");
}

function normalizePersonSearchValue(value) {
  return String(value || "").trim().toLowerCase().replace(/\s+/g, "");
}

function cleanPersonNamePart(value) {
  return String(value || "").trim();
}

function splitPersonNameParts(value) {
  return cleanPersonNamePart(value)
    .split(/[、,，/|;；]+/g)
    .map(cleanPersonNamePart)
    .filter(Boolean);
}

function uniquePersonNames(values) {
  const names = [];
  const seen = new Set();
  for (const value of values.flatMap((item) => splitPersonNameParts(item))) {
    const key = normalizePersonSearchValue(value);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    names.push(value);
  }
  return names;
}

function parseActorAliasesJson(value) {
  try {
    const parsed = value ? JSON.parse(value) : [];
    return Array.isArray(parsed) ? uniquePersonNames(parsed) : [];
  } catch {
    return [];
  }
}

function actorProfileAliases(personOrRow) {
  return parseActorAliasesJson(personOrRow?.aliases_json);
}

function actorProfileDisplayName(person) {
  const row = person?.id ? actorProfileRow(person.id) : null;
  return cleanPersonNamePart(row?.display_name) || person?.name || "";
}

function actorProfileSearchNames(person) {
  if (!person) return [];
  const row = actorProfileRow(person.id);
  return uniquePersonNames([
    person.name,
    row?.person_name,
    row?.display_name,
    ...actorProfileAliases(row)
  ]);
}

function normalizeActorAvatarNameKey(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[\s._\-()[\]【】（）「」『』"'’‘“”・·,，、|/]+/g, "")
    .trim();
}

function actorAvatarNameFromFiletreeKey(value) {
  const text = String(value || "").split("?", 1)[0].replaceAll("\\", "/").split("/").pop() || "";
  return fileBase(text);
}

function actorAvatarMime(filePath) {
  const ext = normalizeExt(filePath);
  if (ext === ".png") return "image/png";
  if (ext === ".webp") return "image/webp";
  return "image/jpeg";
}

function resolveInside(baseDir, parts) {
  const base = path.resolve(baseDir);
  const target = path.resolve(base, ...parts);
  const relative = path.relative(base, target);
  if (relative.startsWith("..") || path.isAbsolute(relative)) return null;
  return target;
}

function actorAvatarTargetPath(rootPath, groupName, targetValue) {
  const contentDir = path.resolve(rootPath, "Content");
  const groupPath = resolveInside(contentDir, [String(groupName || "")]);
  if (!groupPath) return null;

  const rawTarget = String(targetValue || "").split("?", 1)[0].replaceAll("\\", "/");
  const parts = rawTarget.split("/").map((part) => part.trim()).filter(Boolean);
  if (!parts.length) return null;
  return resolveInside(groupPath, parts);
}

function actorAvatarPersonIndex() {
  const index = new Map();
  const ambiguous = new Set();
  for (const person of library.people) {
    for (const name of actorProfileSearchNames(person)) {
      const key = normalizeActorAvatarNameKey(name);
      if (!key) continue;
      const existing = index.get(key);
      if (existing && existing.id !== person.id) {
        ambiguous.add(key);
        index.delete(key);
        continue;
      }
      if (!ambiguous.has(key)) index.set(key, person);
    }
  }
  return { index, ambiguous };
}

function readActorAvatarFiletree(rootPath) {
  const root = path.resolve(String(rootPath || "").trim());
  const filetreePath = path.join(root, "Filetree.json");
  const contentDir = path.join(root, "Content");
  if (!rootPath) {
    const error = new Error("请先填写演员头像目录。");
    error.statusCode = 400;
    throw error;
  }
  if (!safeStat(filetreePath)?.isFile()) {
    const error = new Error("该路径下未找到 Filetree.json。");
    error.statusCode = 400;
    throw error;
  }
  if (!safeStat(contentDir)?.isDirectory()) {
    const error = new Error("该路径下未找到 Content 目录。");
    error.statusCode = 400;
    throw error;
  }

  let filetree = null;
  try {
    filetree = JSON.parse(fs.readFileSync(filetreePath, "utf8"));
  } catch (error) {
    const wrapped = new Error(`读取 Filetree.json 失败：${error.message}`);
    wrapped.statusCode = 400;
    throw wrapped;
  }

  const content = filetree?.Content || filetree?.content;
  if (!content || typeof content !== "object") {
    const error = new Error("Filetree.json 中未找到 Content 节点。");
    error.statusCode = 400;
    throw error;
  }
  return { root, content };
}

function actorAvatarEntriesFromFiletree(rootPath) {
  const { root, content } = readActorAvatarFiletree(rootPath);
  const entries = [];
  const summary = {
    groups: 0,
    filetreeItems: 0,
    usable: 0,
    missingFiles: 0,
    unsupported: 0,
    tooLarge: 0,
    unsafePath: 0
  };

  for (const [groupName, mapping] of Object.entries(content)) {
    if (!mapping || typeof mapping !== "object") continue;
    summary.groups += 1;
    for (const [actorKey, targetValue] of Object.entries(mapping)) {
      const values = Array.isArray(targetValue) ? targetValue : [targetValue];
      for (const value of values) {
        summary.filetreeItems += 1;
        const fullPath = actorAvatarTargetPath(root, groupName, value || actorKey);
        if (!fullPath) {
          summary.unsafePath += 1;
          continue;
        }
        const ext = normalizeExt(fullPath);
        if (!ACTOR_AVATAR_EXTS.has(ext)) {
          summary.unsupported += 1;
          continue;
        }
        const stat = safeStat(fullPath);
        if (!stat?.isFile()) {
          summary.missingFiles += 1;
          continue;
        }
        if (stat.size > MAX_ACTOR_AVATAR_BYTES) {
          summary.tooLarge += 1;
          continue;
        }
        const actorName = actorAvatarNameFromFiletreeKey(actorKey);
        const key = normalizeActorAvatarNameKey(actorName);
        if (!key) continue;
        const relPath = path.relative(root, fullPath).replaceAll(path.sep, "/");
        entries.push({
          actorName,
          key,
          fullPath,
          relPath,
          mime: actorAvatarMime(fullPath),
          size: stat.size
        });
        summary.usable += 1;
      }
    }
  }

  return { root, entries, summary };
}

function actorAvatarCandidatesFromFiletree(rootPath, options = {}) {
  const { root, entries, summary } = actorAvatarEntriesFromFiletree(rootPath);
  const { index, ambiguous } = actorAvatarPersonIndex();
  const personIdFilter = String(options.personId || "").trim();
  const limit = Math.max(0, Number(options.limit || 0) || 0);
  const byPerson = new Map();
  let matched = 0;
  let skippedAmbiguous = 0;
  let skippedUnmatched = 0;

  for (const entry of entries) {
    if (ambiguous.has(entry.key)) {
      skippedAmbiguous += 1;
      continue;
    }
    const person = index.get(entry.key);
    if (!person) {
      skippedUnmatched += 1;
      continue;
    }
    if (personIdFilter && person.id !== personIdFilter) continue;
    matched += 1;

    if (!byPerson.has(person.id)) {
      const profile = publicActorProfile(actorProfileRow(person.id));
      byPerson.set(person.id, {
        personId: person.id,
        personName: person.name,
        displayName: profile?.displayName || person.name,
        hasAvatar: Boolean(profile?.avatarUrl),
        candidates: []
      });
    }

    byPerson.get(person.id).candidates.push(publicActorAvatarCandidate(entry));
  }

  const people = [...byPerson.values()]
    .map((person) => ({
      ...person,
      candidates: person.candidates.sort((a, b) => a.relPath.localeCompare(b.relPath, undefined, { numeric: true, sensitivity: "base" }))
    }))
    .sort((a, b) => Number(a.hasAvatar) - Number(b.hasAvatar) || a.displayName.localeCompare(b.displayName, "zh-Hans-CN"))
    .slice(0, limit || Number.MAX_SAFE_INTEGER);

  return {
    root,
    ...summary,
    matched,
    matchedPeople: byPerson.size,
    returnedPeople: people.length,
    skippedAmbiguous,
    skippedUnmatched,
    people
  };
}

function publicActorAvatarCandidate(entry) {
  return {
    actorName: entry.actorName,
    relPath: entry.relPath,
    size: entry.size,
    mime: entry.mime
  };
}

function upsertActorAvatar(person, entry, existing, now) {
  const db = getActorDb();
  const upsert = db.prepare(`
    INSERT INTO actor_profiles (
      person_id, person_name, javdb_actor_id, javdb_url, display_name, aliases_json,
      movie_count, avatar_url, avatar_mime, avatar_blob, source, status, error, fetched_at, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ok', NULL, ?, ?)
    ON CONFLICT(person_id) DO UPDATE SET
      person_name = excluded.person_name,
      javdb_actor_id = COALESCE(actor_profiles.javdb_actor_id, excluded.javdb_actor_id),
      javdb_url = COALESCE(actor_profiles.javdb_url, excluded.javdb_url),
      display_name = COALESCE(actor_profiles.display_name, excluded.display_name),
      aliases_json = COALESCE(actor_profiles.aliases_json, excluded.aliases_json),
      movie_count = COALESCE(actor_profiles.movie_count, excluded.movie_count),
      avatar_url = excluded.avatar_url,
      avatar_mime = excluded.avatar_mime,
      avatar_blob = excluded.avatar_blob,
      source = excluded.source,
      status = excluded.status,
      error = excluded.error,
      fetched_at = COALESCE(actor_profiles.fetched_at, excluded.fetched_at),
      updated_at = excluded.updated_at
  `);

  const buffer = fs.readFileSync(entry.fullPath);
  const aliases = existing?.aliases_json || JSON.stringify(actorProfileAliases(existing));
  upsert.run(
    person.id,
    person.name,
    existing?.javdb_actor_id || null,
    existing?.javdb_url || null,
    existing?.display_name || person.name,
    aliases,
    existing?.movie_count ?? null,
    `${LOCAL_ACTOR_AVATAR_SOURCE}:${entry.relPath}`,
    entry.mime,
    buffer,
    LOCAL_ACTOR_AVATAR_SOURCE,
    existing?.fetched_at || now,
    now
  );
}

function importActorAvatarCandidate(rootPath, personId, relPath, options = {}) {
  const person = library.peopleById.get(String(personId || ""));
  if (!person) {
    const error = new Error("人物不存在");
    error.statusCode = 404;
    throw error;
  }

  const cleanRelPath = String(relPath || "").replaceAll("\\", "/").trim();
  const { entries } = actorAvatarEntriesFromFiletree(rootPath);
  const { index, ambiguous } = actorAvatarPersonIndex();
  const entry = entries.find((item) => item.relPath === cleanRelPath);
  if (!entry) {
    const error = new Error("候选头像不存在或不可用");
    error.statusCode = 404;
    throw error;
  }
  if (ambiguous.has(entry.key)) {
    const error = new Error("候选头像名称匹配到多个人物，请先补充别名后再选择");
    error.statusCode = 409;
    throw error;
  }
  const matchedPerson = index.get(entry.key);
  if (matchedPerson?.id !== person.id && !options.force) {
    const error = new Error("候选头像与当前人物不匹配");
    error.statusCode = 400;
    throw error;
  }

  if (!options.dryRun) {
    const now = new Date().toISOString();
    const existing = actorProfileRow(person.id);
    upsertActorAvatar(person, entry, existing, now);
    actorProfileCache = null;
  }
  return {
    dryRun: Boolean(options.dryRun),
    person: publicPerson(person),
    candidate: publicActorAvatarCandidate(entry)
  };
}

function importActorAvatarsFromFiletree(rootPath, options = {}) {
  const { root, entries, summary } = actorAvatarEntriesFromFiletree(rootPath);
  const { index, ambiguous } = actorAvatarPersonIndex();
  const replace = Boolean(options.replace);
  const importedPersonIds = new Set();
  const seenAvatarKeys = new Set();
  const now = new Date().toISOString();
  let matched = 0;
  let imported = 0;
  let skippedExisting = 0;
  let skippedDuplicate = 0;
  let skippedAmbiguous = 0;
  let skippedUnmatched = 0;

  for (const entry of entries) {
    if (ambiguous.has(entry.key)) {
      skippedAmbiguous += 1;
      continue;
    }
    const person = index.get(entry.key);
    if (!person) {
      skippedUnmatched += 1;
      continue;
    }
    matched += 1;

    if (importedPersonIds.has(person.id) || seenAvatarKeys.has(`${person.id}:${entry.relPath}`)) {
      skippedDuplicate += 1;
      continue;
    }

    const existing = actorProfileRow(person.id);
    if (existing?.avatar_blob && !replace) {
      skippedExisting += 1;
      continue;
    }

    upsertActorAvatar(person, entry, existing, now);
    importedPersonIds.add(person.id);
    seenAvatarKeys.add(`${person.id}:${entry.relPath}`);
    imported += 1;
  }

  actorProfileCache = null;
  return {
    root,
    replace,
    ...summary,
    matched,
    imported,
    skippedExisting,
    skippedDuplicate,
    skippedAmbiguous,
    skippedUnmatched
  };
}

function isBracketedSearch(value) {
  const text = String(value || "").trim();
  return /^(\[[^\]]+\]|【[^】]+】|（[^）]+）|\([^)]+\))$/.test(text);
}

function searchPeople(rawQuery) {
  const query = String(rawQuery || "").trim();
  if (!query) return { exact: [], fuzzy: [], people: [] };

  const exactName = normalizePersonSearchValue(query);
  const normalizedQuery = normalizeSearchValue(query);
  const bracketed = isBracketedSearch(query);
  const exact = [];
  const fuzzy = [];
  const lowerQuery = query.toLowerCase();

  for (const person of library.people) {
    const names = actorProfileSearchNames(person);
    if (names.some((name) => normalizePersonSearchValue(name) === exactName)) {
      exact.push(person);
      continue;
    }

    if (bracketed) continue;

    if (names.some((name) => {
      const lowerName = name.toLowerCase();
      const normalizedName = normalizeSearchValue(name);
      return lowerName.includes(lowerQuery) || (normalizedQuery.length >= 2 && normalizedName.includes(normalizedQuery));
    })) {
      fuzzy.push(person);
    }
  }

  const sortPeople = (people) =>
    people.sort((a, b) => b.workCount - a.workCount || actorProfileDisplayName(a).localeCompare(actorProfileDisplayName(b), undefined, { numeric: true, sensitivity: "base" }));

  sortPeople(exact);
  sortPeople(fuzzy);
  return { exact, fuzzy, people: exact.length ? exact : fuzzy.slice(0, 20) };
}

function buildWorkSearchText(work) {
  const person = library.peopleById.get(work.personId);
  const info = workInfoRow(work.id);
  const infoFields = parseJsonArray(info?.fields_json).flatMap((field) => [field?.label, field?.value]);
  return [
    work.title,
    work.directoryName,
    work.relativePath,
    work.personName,
    person?.name,
    ...actorProfileSearchNames(person),
    info?.code,
    info?.title,
    info?.person_name,
    info?.director,
    info?.maker,
    info?.label,
    info?.series,
    ...parseJsonTextArray(info?.actors_json),
    ...parseJsonTextArray(info?.tags_json),
    ...infoFields,
    info?.raw_text,
    ...(work.videos || []).flatMap((video) => [video.name, video.title, video.relativePath]),
    ...(work.images || []).flatMap((image) => [image.name, image.title]),
    ...(work.infos || []).flatMap((info) => [info.name, info.title])
  ]
    .filter(Boolean)
    .join("\n")
    .toLowerCase();
}

function workSearchTextEntry(work) {
  const stamp = searchSourceStamp();
  if (workSearchTextCache?.stamp !== stamp) {
    workSearchTextCache = { stamp, rows: new Map() };
  }

  const key = work?.id || `${work?.personId || ""}:${work?.directoryName || ""}:${work?.title || ""}`;
  const cached = workSearchTextCache.rows.get(key);
  if (cached) return cached;

  const text = buildWorkSearchText(work);
  const entry = {
    text,
    normalized: normalizeSearchValue(text)
  };
  workSearchTextCache.rows.set(key, entry);
  return entry;
}

function workSearchText(work) {
  return workSearchTextEntry(work).text;
}

function matchesWorkSearch(work, query) {
  if (!query) return true;
  const { text, normalized } = workSearchTextEntry(work);
  const normalizedQuery = normalizeSearchValue(query);
  return text.includes(query) || (normalizedQuery.length >= 2 && normalized.includes(normalizedQuery));
}

function registerFiles(index, files) {
  for (const file of files) {
    index.filesById.set(file.id, file);
  }
}

function ensureDataDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function getActorDb() {
  if (!actorDb) {
    ensureDataDir();
    actorDb = new DatabaseSync(ACTOR_PROFILE_DB_PATH);
    actorDb.exec(`
      CREATE TABLE IF NOT EXISTS actor_profiles (
        person_id TEXT PRIMARY KEY,
        person_name TEXT NOT NULL,
        javdb_actor_id TEXT,
        javdb_url TEXT,
        display_name TEXT,
        aliases_json TEXT,
        movie_count INTEGER,
        avatar_url TEXT,
        avatar_mime TEXT,
        avatar_blob BLOB,
        source TEXT,
        status TEXT NOT NULL DEFAULT 'ok',
        error TEXT,
        fetched_at TEXT,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_actor_profiles_name ON actor_profiles(person_name);
      CREATE INDEX IF NOT EXISTS idx_actor_profiles_javdb_actor_id ON actor_profiles(javdb_actor_id);
      CREATE TABLE IF NOT EXISTS work_covers (
        work_id TEXT PRIMARY KEY,
        person_id TEXT NOT NULL,
        person_name TEXT NOT NULL,
        video_id TEXT,
        title TEXT,
        cover_url TEXT,
        cover_mime TEXT,
        cover_blob BLOB,
        source TEXT,
        fetched_at TEXT,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_work_covers_person_id ON work_covers(person_id);
      CREATE INDEX IF NOT EXISTS idx_work_covers_video_id ON work_covers(video_id);
      CREATE TABLE IF NOT EXISTS work_info (
        work_id TEXT PRIMARY KEY,
        person_id TEXT NOT NULL,
        person_name TEXT NOT NULL,
        source_info_id TEXT,
        source_name TEXT,
        source_path TEXT,
        source_size INTEGER,
        source_mtime TEXT,
        code TEXT,
        title TEXT,
        release_date TEXT,
        duration_minutes INTEGER,
        rating REAL,
        rating_count INTEGER,
        director TEXT,
        maker TEXT,
        label TEXT,
        series TEXT,
        javdb_url TEXT,
        image_url TEXT,
        preview_images_json TEXT,
        preview_video_url TEXT,
        actors_json TEXT,
        tags_json TEXT,
        fields_json TEXT,
        raw_text TEXT,
        raw_truncated INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'ok',
        error TEXT,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_work_info_person_id ON work_info(person_id);
      CREATE INDEX IF NOT EXISTS idx_work_info_code ON work_info(code);
      CREATE INDEX IF NOT EXISTS idx_work_info_rating ON work_info(rating);
      CREATE INDEX IF NOT EXISTS idx_work_info_release_date ON work_info(release_date);
      CREATE INDEX IF NOT EXISTS idx_work_info_status ON work_info(status);
      CREATE TABLE IF NOT EXISTS actor_movies (
        person_id TEXT NOT NULL,
        person_name TEXT NOT NULL,
        javdb_actor_id TEXT,
        actor_url TEXT NOT NULL,
        code TEXT NOT NULL,
        code_key TEXT NOT NULL,
        title TEXT,
        detail_url TEXT,
        image_url TEXT,
        release_date TEXT,
        rating REAL,
        rating_count INTEGER,
        page_index INTEGER,
        position_index INTEGER,
        fetched_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(person_id, code_key)
      );
      CREATE INDEX IF NOT EXISTS idx_actor_movies_person_id ON actor_movies(person_id);
      CREATE INDEX IF NOT EXISTS idx_actor_movies_code_key ON actor_movies(code_key);
      CREATE INDEX IF NOT EXISTS idx_actor_movies_actor_url ON actor_movies(actor_url);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_actor_movies_person_code_key ON actor_movies(person_id, code_key);
      CREATE TABLE IF NOT EXISTS javdb_rankings (
        list_type TEXT NOT NULL,
        list_key TEXT NOT NULL DEFAULT '',
        list_label TEXT,
        rank_no INTEGER NOT NULL,
        code TEXT NOT NULL,
        code_key TEXT NOT NULL,
        title TEXT,
        detail_url TEXT,
        image_url TEXT,
        release_date TEXT,
        rating REAL,
        rating_count INTEGER,
        page_url TEXT,
        fetched_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(list_type, list_key, code_key)
      );
      CREATE INDEX IF NOT EXISTS idx_javdb_rankings_list ON javdb_rankings(list_type, list_key, rank_no);
      CREATE INDEX IF NOT EXISTS idx_javdb_rankings_code_key ON javdb_rankings(code_key);
    `);
    ensureColumn(actorDb, "work_info", "javdb_url", "TEXT");
    ensureColumn(actorDb, "work_info", "preview_images_json", "TEXT");
    ensureColumn(actorDb, "work_info", "preview_video_url", "TEXT");
    ensureColumn(actorDb, "actor_movies", "code_key", "TEXT");
    ensureColumn(actorDb, "actor_movies", "release_date", "TEXT");
    ensureColumn(actorDb, "actor_movies", "rating", "REAL");
    ensureColumn(actorDb, "actor_movies", "rating_count", "INTEGER");
    ensureColumn(actorDb, "actor_movies", "page_index", "INTEGER");
    ensureColumn(actorDb, "actor_movies", "position_index", "INTEGER");
    ensureColumn(actorDb, "javdb_rankings", "list_label", "TEXT");
    ensureColumn(actorDb, "javdb_rankings", "release_date", "TEXT");
    ensureColumn(actorDb, "javdb_rankings", "rating", "REAL");
    ensureColumn(actorDb, "javdb_rankings", "rating_count", "INTEGER");
    ensureColumn(actorDb, "javdb_rankings", "page_url", "TEXT");
    actorDb.exec("CREATE INDEX IF NOT EXISTS idx_work_info_javdb_url ON work_info(javdb_url)");
  }
  return actorDb;
}

function ensureColumn(db, table, column, definition) {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!rows.some((row) => row.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

function actorProfileRowsById() {
  const stamp = workInfoStamp();
  if (actorProfileCache?.stamp === stamp) return actorProfileCache.rows;

  const rows = new Map();
  try {
    const db = getActorDb();
    for (const row of db.prepare("SELECT * FROM actor_profiles").all()) {
      rows.set(row.person_id, row);
    }
  } catch (error) {
    console.warn("[actor-db]", error.message);
  }

  actorProfileCache = { stamp, rows };
  return rows;
}

function actorProfileRow(personId) {
  return actorProfileRowsById().get(personId) || null;
}

function publicActorProfile(row) {
  if (!row) return null;

  const aliases = actorProfileAliases(row);

  return {
    personId: row.person_id,
    personName: row.person_name,
    javdbActorId: row.javdb_actor_id || "",
    javdbUrl: row.javdb_url || "",
    displayName: cleanPersonNamePart(row.display_name) || row.person_name,
    aliases,
    movieCount: row.movie_count ?? null,
    avatarUrl: row.avatar_blob ? `/media/actor/${encodeURIComponent(row.person_id)}/avatar?v=${encodeURIComponent(row.updated_at || "")}` : "",
    sourceAvatarUrl: row.avatar_url || "",
    source: row.source || "",
    status: row.status || "ok",
    error: row.error || "",
    fetchedAt: row.fetched_at || "",
    updatedAt: row.updated_at || ""
  };
}

function normalizeSourcePath(value) {
  let normalized = String(value || "").trim().replaceAll("\\", "/").toLowerCase();
  normalized = normalized.replace(/\/+$/, "");
  if (/^[a-z]$/.test(normalized)) normalized = `${normalized}:`;
  return normalized;
}

function sourcePathMatchesPrefix(sourcePath, prefix) {
  const normalizedPath = normalizeSourcePath(sourcePath);
  const normalizedPrefix = normalizeSourcePath(prefix);
  if (!normalizedPath || !normalizedPrefix) return false;
  return normalizedPath === normalizedPrefix || normalizedPath.startsWith(`${normalizedPrefix}/`);
}

function isGPerson(person) {
  const paths = [person?.relativePath || "", ...(person?.sourcePaths || [])];
  return paths.some((sourcePath) => sourcePathMatchesPrefix(sourcePath, "G:/"));
}

function normalizeWorkCode(value) {
  return parseNormalizedWorkCode(value);
}

function looseWorkCodeKey(value) {
  return workCodeKey(value);
}

function storedWorkCodeKey(value) {
  return String(value || "").replace(/[^A-Za-z0-9]/g, "").toLowerCase();
}

function workCoverRow(workId) {
  try {
    return getActorDb().prepare("SELECT * FROM work_covers WHERE work_id = ?").get(workId) || null;
  } catch (error) {
    console.warn("[work-cover-db]", error.message);
    return null;
  }
}

function publicWorkCover(row) {
  if (!row?.cover_blob) return null;

  return {
    workId: row.work_id,
    personId: row.person_id,
    videoId: row.video_id || "",
    title: row.title || "",
    coverUrl: `/media/work/${encodeURIComponent(row.work_id)}/cover?v=${encodeURIComponent(row.updated_at || "")}`,
    sourceCoverUrl: row.cover_url || "",
    source: row.source || "",
    fetchedAt: row.fetched_at || "",
    updatedAt: row.updated_at || ""
  };
}

function cachedWorkCoverIds() {
  try {
    const rows = getActorDb()
      .prepare("SELECT work_id FROM work_covers WHERE cover_blob IS NOT NULL AND length(cover_blob) > 0")
      .all();
    return new Set(rows.map((row) => row.work_id));
  } catch (error) {
    console.warn("[work-cover-db]", error.message);
    return new Set();
  }
}

function chooseCoverVideo(work) {
  return (work.videos || []).find((video) => safeStat(video.path)) || null;
}

function coverGenerationStatus(sampleLimit = 8) {
  const cachedCoverIds = cachedWorkCoverIds();
  const candidates = allWorks()
    .filter((work) => !work.missingLocal)
    .filter((work) => !work.coverId)
    .filter((work) => !cachedCoverIds.has(work.id))
    .filter((work) => (work.videos || []).length > 0)
    .sort((a, b) => String(b.modifiedAt || "").localeCompare(String(a.modifiedAt || "")));

  const sample = [];
  let ready = 0;
  let missingVideo = 0;
  for (const work of candidates) {
    const video = chooseCoverVideo(work);
    if (video) {
      ready += 1;
      if (sample.length < sampleLimit) {
        sample.push({
          workId: work.id,
          personId: work.personId || "",
          title: work.title || work.directoryName || "",
          videoCount: (work.videos || []).length,
          modifiedAt: work.modifiedAt || ""
        });
      }
      continue;
    }
    missingVideo += 1;
  }

  return {
    candidates: candidates.length,
    ready,
    missingVideo,
    sample
  };
}

function generateWorkCover(work) {
  if (work.coverId) {
    const error = new Error("这个作品已经有本地封面");
    error.statusCode = 400;
    throw error;
  }

  const video = chooseCoverVideo(work);
  if (!video) {
    const error = new Error("这个作品没有可读取的视频文件");
    error.statusCode = 400;
    throw error;
  }

  let coverBlob;
  try {
    coverBlob = extractCoverFrame(video.path, {
      ffmpegPath: FFMPEG_PATH,
      ffprobePath: FFPROBE_PATH,
      duration: videoProbeCached(video)?.duration,
      maxBytes: MAX_GENERATED_COVER_BYTES
    });
  } catch (error) {
    error.statusCode = error.statusCode || 500;
    throw error;
  }
  const now = new Date().toISOString();
  const person = library.peopleById.get(work.personId);
  getActorDb()
    .prepare(
      `
      INSERT INTO work_covers (
        work_id, person_id, person_name, video_id, title,
        cover_url, cover_mime, cover_blob, source, fetched_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(work_id) DO UPDATE SET
        person_id = excluded.person_id,
        person_name = excluded.person_name,
        video_id = excluded.video_id,
        title = excluded.title,
        cover_url = excluded.cover_url,
        cover_mime = excluded.cover_mime,
        cover_blob = excluded.cover_blob,
        source = excluded.source,
        fetched_at = excluded.fetched_at,
        updated_at = excluded.updated_at
      `
    )
    .run(
      work.id,
      work.personId || "",
      person?.name || "",
      video.id,
      work.title || work.directoryName || video.title || "",
      video.relativePath || video.path || "",
      "image/jpeg",
      coverBlob,
      "ffmpeg-frame",
      now,
      now
    );

  workInfoCache = null;
  workSearchTextCache = null;
  return publicWorkCover(workCoverRow(work.id));
}

function workInfoStamp() {
  const main = safeStat(ACTOR_PROFILE_DB_PATH)?.mtimeMs || 0;
  const wal = safeStat(`${ACTOR_PROFILE_DB_PATH}-wal`)?.mtimeMs || 0;
  return `${main}:${wal}`;
}

function searchSourceStamp() {
  return `${library.scannedAt || ""}:${workInfoStamp()}`;
}

function clearSearchSourceCaches() {
  rankingMissingSearchCache = null;
  actorMissingSearchCache = null;
  workSearchTextCache = null;
}

function workInfoRowsById() {
  const stamp = workInfoStamp();
  if (workInfoCache?.stamp === stamp) return workInfoCache.rows;

  const rows = new Map();
  try {
    const db = getActorDb();
    for (const row of db.prepare("SELECT * FROM work_info WHERE status = 'ok'").all()) {
      rows.set(row.work_id, row);
    }
  } catch (error) {
    console.warn("[work-info]", error.message);
  }

  workInfoCache = { stamp, rows };
  return rows;
}

function workInfoRow(workId) {
  return workInfoRowsById().get(workId) || null;
}

function actorMovieRowsByPerson() {
  const stamp = workInfoStamp();
  if (actorMovieCache?.stamp === stamp) return actorMovieCache.rows;

  const rowsByPerson = new Map();
  try {
    const db = getActorDb();
    const rows = db
      .prepare(
        `
        SELECT *
        FROM actor_movies
        ORDER BY person_id, COALESCE(page_index, 999999), COALESCE(position_index, 999999), code
        `
      )
      .all();
    for (const row of rows) {
      if (!rowsByPerson.has(row.person_id)) rowsByPerson.set(row.person_id, []);
      rowsByPerson.get(row.person_id).push(row);
    }
  } catch (error) {
    console.warn("[actor-movies]", error.message);
  }

  actorMovieCache = { stamp, rows: rowsByPerson };
  return rowsByPerson;
}

function actorMovieRows(personId) {
  return actorMovieRowsByPerson().get(personId) || [];
}

function localWorkCodeKeys() {
  const stamp = `${library.scannedAt || ""}:${workInfoStamp()}`;
  if (localWorkCodeKeyCache?.stamp === stamp) return localWorkCodeKeyCache.keys;

  const keys = new Set();
  for (const work of library.worksById.values()) {
    const info = workInfoRow(work.id);
    const values = [
      info?.code,
      work.title,
      work.directoryName,
      work.relativePath,
      ...(work.videos || []).flatMap((video) => [video.name, video.title, video.relativePath]),
      ...(work.images || []).flatMap((image) => [image.name, image.title]),
      ...(work.infos || []).flatMap((infoFile) => [infoFile.name, infoFile.title])
    ];

    for (const value of values) {
      const key = looseWorkCodeKey(value);
      if (key) keys.add(key);
    }
  }
  localWorkCodeKeyCache = { stamp, keys };
  return keys;
}

function localWorkByCodeKey() {
  const stamp = `${library.scannedAt || ""}:${workInfoStamp()}`;
  if (localWorkByCodeKeyCache?.stamp === stamp) return localWorkByCodeKeyCache.rows;

  const rows = new Map();
  for (const work of library.worksById.values()) {
    const info = workInfoRow(work.id);
    const values = [
      info?.code,
      work.title,
      work.directoryName,
      work.relativePath,
      ...(work.videos || []).flatMap((video) => [video.name, video.title, video.relativePath]),
      ...(work.images || []).flatMap((image) => [image.name, image.title]),
      ...(work.infos || []).flatMap((infoFile) => [infoFile.name, infoFile.title])
    ];

    for (const value of values) {
      const key = looseWorkCodeKey(value);
      if (key && !rows.has(key)) rows.set(key, work);
    }
  }

  localWorkByCodeKeyCache = { stamp, rows };
  return rows;
}

function rankingListLabel(listType, listKey, fallback = "") {
  const key = String(listKey || "");
  if (fallback) return fallback;
  if (listType === "top") {
    if (!key || key === "all") return "TOP250 全部";
    if (key === "censored") return "TOP250 有码";
    if (key === "uncensored") return "TOP250 无码";
    if (key === "western") return "TOP250 欧美";
    if (key === "fc2") return "TOP250 FC2";
    const year = /^y?(\d{4})$/i.exec(key)?.[1];
    if (year) return `TOP250 ${year}`;
  }
  return key ? `${listType} ${key}` : listType;
}

function rankingSummaries() {
  const localKeys = localWorkCodeKeys();
  const summaries = [];
  try {
    const rows = getActorDb()
      .prepare(
        `
        SELECT list_type, list_key, COALESCE(NULLIF(list_label, ''), '') AS list_label,
               COUNT(*) AS total, MAX(updated_at) AS updated_at, MAX(page_url) AS page_url
        FROM javdb_rankings
        GROUP BY list_type, list_key
        ORDER BY
          CASE WHEN list_key GLOB 'y[0-9][0-9][0-9][0-9]' THEN 0 ELSE 1 END,
          list_key DESC
        `
      )
      .all();

    for (const row of rows) {
      const listRows = getActorDb()
        .prepare("SELECT code_key FROM javdb_rankings WHERE list_type = ? AND list_key = ?")
        .all(row.list_type, row.list_key || "");
      const localTotal = listRows.filter((item) => localKeys.has(storedWorkCodeKey(item.code_key))).length;
      summaries.push({
        type: row.list_type,
        key: row.list_key || "",
        label: rankingListLabel(row.list_type, row.list_key, row.list_label),
        total: Number(row.total || 0),
        localTotal,
        missingTotal: Math.max(0, Number(row.total || 0) - localTotal),
        updatedAt: row.updated_at || "",
        pageUrl: row.page_url || ""
      });
    }
  } catch (error) {
    console.warn("[rankings]", error.message);
  }
  return summaries;
}

function rankingRows(listType = "top", listKey = "") {
  try {
    return getActorDb()
      .prepare(
        `
        SELECT *
        FROM javdb_rankings
        WHERE list_type = ? AND list_key = ?
        ORDER BY rank_no ASC, code ASC
        `
      )
      .all(listType, listKey || "");
  } catch (error) {
    console.warn("[rankings]", error.message);
    return [];
  }
}

function rankingWorkFromRow(row, localByCode = localWorkByCodeKey()) {
  const codeKey = storedWorkCodeKey(row.code_key) || looseWorkCodeKey(row.code);
  const localWork = codeKey ? localByCode.get(codeKey) : null;
  const ranking = {
    type: row.list_type || "top",
    key: row.list_key || "",
    label: rankingListLabel(row.list_type || "top", row.list_key || "", row.list_label || ""),
    rankNo: Number(row.rank_no || 0),
    pageUrl: row.page_url || "",
    updatedAt: row.updated_at || ""
  };

  if (localWork) {
    return { ...localWork, ranking, missingLocal: false };
  }

  const code = normalizeWorkCode(row.code) || row.code || "";
  const title = row.title && row.title !== row.code ? row.title : code || row.title || "未下载作品";
  return {
    id: createId("r", `${row.list_type || "top"}|${row.list_key || ""}|${codeKey || row.code || row.rank_no}`),
    personId: "",
    personName: "",
    title,
    directoryName: code,
    relativePath: "",
    coverId: null,
    remoteCoverUrl: row.image_url || "",
    videoCount: 0,
    playableCount: 0,
    imageCount: 0,
    infoCount: 0,
    videos: [],
    images: [],
    infos: [],
    modifiedAt: "",
    missingLocal: true,
    javdbUrl: row.detail_url || "",
    actorUrl: "",
    ranking,
    infoSummary: {
      code,
      title: row.title || "",
      releaseDate: row.release_date || "",
      durationMinutes: null,
      rating: row.rating ?? null,
      ratingCount: row.rating_count ?? null
    }
  };
}

function rankingWorksPayload(url, listType = "top") {
  const listKey = url.searchParams.get("key") || "";
  const rows = rankingRows(listType, listKey);
  const localByCode = localWorkByCodeKey();
  const allWorks = rows.map((row) => rankingWorkFromRow(row, localByCode));
  const localTotal = allWorks.filter((work) => !work.missingLocal).length;
  const missingTotal = allWorks.length - localTotal;
  const onlyMissing = ["1", "true", "yes"].includes(String(url.searchParams.get("missing") || "").toLowerCase());
  const sourceWorks = onlyMissing ? allWorks.filter((work) => work.missingLocal) : allWorks;
  const limit = clampInteger(url.searchParams.get("limit"), MAX_WORK_LIMIT, 1, MAX_WORK_LIMIT);
  const offset = clampInteger(url.searchParams.get("offset"), 0, 0, Number.MAX_SAFE_INTEGER);
  const page = sourceWorks.slice(offset, offset + limit).map((work) => publicWork(work));
  for (const work of page) {
    const source = sourceWorks.find((item) => item.id === work.id);
    if (source?.ranking) work.ranking = source.ranking;
  }
  return {
    type: listType,
    key: listKey,
    label: rankingListLabel(listType, listKey, rows[0]?.list_label || ""),
    count: page.length,
    total: sourceWorks.length,
    rankingTotal: allWorks.length,
    localTotal,
    missingTotal,
    limit,
    offset,
    updatedAt: rows[0]?.updated_at || "",
    pageUrl: rows[0]?.page_url || "",
    works: page
  };
}

function rankingMissingSearchWorks() {
  const stamp = searchSourceStamp();
  if (rankingMissingSearchCache?.stamp === stamp) return rankingMissingSearchCache.works;

  const localByCode = localWorkByCodeKey();
  const seen = new Set();
  const works = [];

  try {
    const rows = getActorDb()
      .prepare(
        `
        SELECT *
        FROM javdb_rankings
        ORDER BY rank_no ASC, updated_at DESC, list_key DESC, code ASC
        `
      )
      .all();

    for (const row of rows) {
      const codeKey = storedWorkCodeKey(row.code_key) || looseWorkCodeKey(row.code);
      if (!codeKey || seen.has(codeKey) || localByCode.has(codeKey)) continue;
      seen.add(codeKey);
      works.push(rankingWorkFromRow(row, localByCode));
    }
  } catch (error) {
    console.warn("[rankings-search]", error.message);
  }

  rankingMissingSearchCache = { stamp, works };
  return works;
}

function actorMissingWorkFromRow(person, row, codeKey = "") {
  const code = normalizeWorkCode(row.code) || row.code || "";
  const title = row.title && row.title !== row.code ? row.title : code || row.title || "未下载作品";
  return {
    id: createId("m", `${person.id}|${row.detail_url || codeKey}`),
    personId: person.id,
    personName: person.name,
    title,
    directoryName: code,
    relativePath: "",
    coverId: null,
    remoteCoverUrl: row.image_url || "",
    videoCount: 0,
    playableCount: 0,
    imageCount: 0,
    infoCount: 0,
    videos: [],
    images: [],
    infos: [],
    modifiedAt: "",
    missingLocal: true,
    javdbUrl: row.detail_url || "",
    actorUrl: row.actor_url || "",
    infoSummary: {
      code,
      title: row.title || "",
      releaseDate: row.release_date || "",
      durationMinutes: null,
      rating: row.rating ?? null,
      ratingCount: row.rating_count ?? null
    }
  };
}

function actorMissingSearchWorks(excludedCodeKeys = new Set()) {
  const stamp = searchSourceStamp();
  if (actorMissingSearchCache?.stamp === stamp) {
    return filterExcludedMissingWorks(actorMissingSearchCache.works, excludedCodeKeys);
  }

  const localKeys = localWorkCodeKeys();
  const seen = new Set();
  const works = [];
  const rowsByPerson = actorMovieRowsByPerson();

  for (const person of library.people) {
    const rows = rowsByPerson.get(person.id) || [];
    for (const row of rows) {
      const codeKey = storedWorkCodeKey(row.code_key) || looseWorkCodeKey(row.code);
      if (!codeKey || seen.has(codeKey) || localKeys.has(codeKey)) continue;
      seen.add(codeKey);
      works.push(actorMissingWorkFromRow(person, row, codeKey));
    }
  }

  actorMissingSearchCache = { stamp, works };
  return filterExcludedMissingWorks(works, excludedCodeKeys);
}

function filterExcludedMissingWorks(works, excludedCodeKeys = new Set()) {
  if (!excludedCodeKeys?.size) return works;
  return works.filter((work) => {
    const codeKey = storedWorkCodeKey(work.infoSummary?.code || work.directoryName || work.title);
    return !codeKey || !excludedCodeKeys.has(codeKey);
  });
}

function missingActorWorksForPerson(person, rows = actorMovieRows(person.id)) {
  const localKeys = localWorkCodeKeys();
  const seen = new Set();
  const missing = [];

  for (const row of rows) {
    const codeKey = storedWorkCodeKey(row.code_key) || looseWorkCodeKey(row.code);
    if (!codeKey || seen.has(codeKey) || localKeys.has(codeKey)) continue;
    seen.add(codeKey);
    missing.push(actorMissingWorkFromRow(person, row, codeKey));
  }

  return missing;
}

function parseJsonArray(value) {
  try {
    const parsed = value ? JSON.parse(value) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function uniqueTextArray(values, options = {}) {
  const result = [];
  const seen = new Set();
  const maxLength = options.maxLength || 80;
  for (const value of Array.isArray(values) ? values : []) {
    const text = String(value || "").replace(/\s+/g, " ").trim();
    if (!text || text.length > maxLength) continue;
    const key = text.toLocaleLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(text);
  }
  return result.slice(0, options.maxItems || 120);
}

function parseJsonTextArray(value, options = {}) {
  return uniqueTextArray(parseJsonArray(value), options);
}

function publicRemoteUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  try {
    const parsed = new URL(raw);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.toString() : "";
  } catch {
    return "";
  }
}

function publicRemoteUrlArray(values) {
  const urls = [];
  const seen = new Set();
  for (const value of Array.isArray(values) ? values : []) {
    const url = publicRemoteUrl(value);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    urls.push(url);
  }
  return urls;
}

function firstPresentValue(...values) {
  for (const value of values) {
    if (value === null || value === undefined) continue;
    if (typeof value === "string" && !value.trim()) continue;
    return value;
  }
  return null;
}

function firstPresentText(...values) {
  const value = firstPresentValue(...values);
  return value === null ? "" : String(value);
}

function firstPresentNumber(...values) {
  const value = firstPresentValue(...values);
  if (value === null) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function publicWorkInfoSummary(row, fallback = null) {
  if (!row && !fallback) return null;
  const actors = parseJsonTextArray(row?.actors_json);
  const tags = parseJsonTextArray(row?.tags_json);
  const previewImages = publicRemoteUrlArray(parseJsonArray(row?.preview_images_json));
  return {
    code: firstPresentText(row?.code, fallback?.code),
    title: firstPresentText(row?.title, fallback?.title),
    releaseDate: firstPresentText(row?.release_date, fallback?.releaseDate),
    durationMinutes: firstPresentNumber(row?.duration_minutes, fallback?.durationMinutes),
    rating: firstPresentNumber(row?.rating, fallback?.rating),
    ratingCount: firstPresentNumber(row?.rating_count, fallback?.ratingCount),
    director: firstPresentText(row?.director, fallback?.director),
    maker: firstPresentText(row?.maker, fallback?.maker),
    label: firstPresentText(row?.label, fallback?.label),
    series: firstPresentText(row?.series, fallback?.series),
    actors: actors.length ? actors : uniqueTextArray(fallback?.actors),
    tags: tags.length ? tags : uniqueTextArray(fallback?.tags),
    imageUrl: publicRemoteUrl(firstPresentValue(row?.image_url, fallback?.imageUrl)),
    previewImages: previewImages.length ? previewImages : publicRemoteUrlArray(fallback?.previewImages),
    previewVideoUrl: publicRemoteUrl(firstPresentValue(row?.preview_video_url, fallback?.previewVideoUrl))
  };
}

function publicWorkInfoMetadata(row) {
  if (!row) return null;
  const info = {
    code: row.code || "",
    title: row.title || "",
    releaseDate: row.release_date || "",
    durationMinutes: row.duration_minutes ?? null,
    rating: row.rating ?? null,
    ratingCount: row.rating_count ?? null,
    director: row.director || "",
    maker: row.maker || "",
    label: row.label || "",
    series: row.series || "",
    javdbUrl: row.javdb_url || "",
    imageUrl: publicRemoteUrl(row.image_url),
    previewImages: publicRemoteUrlArray(parseJsonArray(row.preview_images_json)),
    previewVideoUrl: publicRemoteUrl(row.preview_video_url),
    actors: parseJsonTextArray(row.actors_json),
    tags: parseJsonTextArray(row.tags_json),
    fields: parseJsonArray(row.fields_json),
    rawText: row.raw_text || "",
    rawTextTruncated: Boolean(row.raw_truncated),
    sourceName: row.source_name || "",
    updatedAt: row.updated_at || ""
  };
  if (!info.rawText && info.fields?.length) info.rawText = renderInfoMetadataText(info);
  return info;
}

function actorIdFromJavdbUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  const direct = /^[A-Za-z0-9]{3,24}$/.test(raw) ? raw : "";
  if (direct) return direct;
  const cleanActorId = (actorId) => (/^[A-Za-z0-9]{3,24}$/.test(actorId || "") ? actorId : "");
  try {
    const url = new URL(raw);
    const match = /^\/actors\/([^/?#]+)/.exec(url.pathname);
    return match ? cleanActorId(decodeURIComponent(match[1])) : "";
  } catch {
    const match = /javdb\.com\/actors\/([^/?#\s]+)/i.exec(raw);
    return match ? cleanActorId(decodeURIComponent(match[1])) : "";
  }
}

function canonicalJavdbActorUrl(value) {
  const actorId = actorIdFromJavdbUrl(value);
  return actorId ? `https://javdb.com/actors/${actorId}` : "";
}

function upsertActorProfile(person, payload) {
  const now = new Date().toISOString();
  const inputActorUrl = typeof payload.javdbUrl === "string" ? payload.javdbUrl.trim() : "";
  const javdbUrl = inputActorUrl ? canonicalJavdbActorUrl(inputActorUrl) : "";
  if (inputActorUrl && !javdbUrl) {
    const error = new Error("请输入 JavDB actor 页面链接，例如 https://javdb.com/actors/BzpA");
    error.statusCode = 400;
    throw error;
  }

  const avatarBase64 = typeof payload.avatarBase64 === "string" ? payload.avatarBase64 : "";
  const avatarBlob = avatarBase64 ? Buffer.from(avatarBase64, "base64") : null;
  const movieCount = Number.isFinite(Number(payload.movieCount)) ? Number(payload.movieCount) : null;

  const existing = actorProfileRow(person.id);
  const existingAliases = actorProfileAliases(existing);
  const displayName = cleanPersonNamePart(payload.displayName) || existing?.display_name || person.name;
  const hasAliasesInput = Array.isArray(payload.aliases) || typeof payload.aliases === "string";
  const inputAliases = Array.isArray(payload.aliases)
    ? payload.aliases
    : typeof payload.aliases === "string"
      ? [payload.aliases]
      : [];
  const displayNameKey = normalizePersonSearchValue(displayName);
  const aliases = uniquePersonNames(inputAliases).filter((alias) => normalizePersonSearchValue(alias) !== displayNameKey);
  const avatarMime = payload.avatarMime || (avatarBlob ? "image/jpeg" : existing?.avatar_mime || null);

  getActorDb()
    .prepare(
      `
      INSERT INTO actor_profiles (
        person_id, person_name, javdb_actor_id, javdb_url, display_name, aliases_json,
        movie_count, avatar_url, avatar_mime, avatar_blob, source, status, error, fetched_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(person_id) DO UPDATE SET
        person_name = excluded.person_name,
        javdb_actor_id = excluded.javdb_actor_id,
        javdb_url = excluded.javdb_url,
        display_name = excluded.display_name,
        aliases_json = excluded.aliases_json,
        movie_count = excluded.movie_count,
        avatar_url = excluded.avatar_url,
        avatar_mime = excluded.avatar_mime,
        avatar_blob = COALESCE(excluded.avatar_blob, actor_profiles.avatar_blob),
        source = excluded.source,
        status = excluded.status,
        error = excluded.error,
        fetched_at = excluded.fetched_at,
        updated_at = excluded.updated_at
      `
    )
    .run(
      person.id,
      person.name,
      payload.javdbActorId || actorIdFromJavdbUrl(javdbUrl) || existing?.javdb_actor_id || null,
      javdbUrl || existing?.javdb_url || null,
      displayName,
      JSON.stringify(hasAliasesInput ? aliases : existingAliases),
      movieCount,
      payload.sourceAvatarUrl || payload.avatarUrl || existing?.avatar_url || null,
      avatarMime,
      avatarBlob,
      payload.source || existing?.source || "manual",
      payload.status || "ok",
      payload.error || null,
      payload.fetchedAt || now,
      now
    );

  if (javdbUrl && existing?.javdb_url && canonicalJavdbActorUrl(existing.javdb_url) !== javdbUrl) {
    getActorDb().prepare("DELETE FROM actor_movies WHERE person_id = ?").run(person.id);
  }
  actorProfileCache = null;
  actorMovieCache = null;

  return publicActorProfile(actorProfileRow(person.id));
}

function serializeLibrary(index) {
  return {
    version: 2,
    root: index.root,
    roots: index.roots,
    availableRoots: index.availableRoots,
    missingRoots: index.missingRoots,
    scannedAt: index.scannedAt,
    totals: index.totals,
    people: index.people,
    works: [...index.worksById.values()]
  };
}

function hydrateLibrary(data) {
  const index = emptyLibrary();
  index.root = data.root || LIBRARY_ROOTS.join(";");
  index.roots = data.roots || LIBRARY_ROOTS;
  index.availableRoots = data.availableRoots || [];
  index.missingRoots = data.missingRoots || [];
  index.scannedAt = data.scannedAt || null;
  index.totals = data.totals || index.totals;
  index.people = data.people || [];

  for (const person of index.people) {
    index.peopleById.set(person.id, person);
  }

  for (const work of data.works || []) {
    index.worksById.set(work.id, work);
    registerFiles(index, [...(work.videos || []), ...(work.images || []), ...(work.infos || [])]);
  }

  return index;
}

function loadLibraryCache() {
  try {
    if (!fs.existsSync(INDEX_CACHE_PATH)) {
      return null;
    }

    const data = JSON.parse(fs.readFileSync(INDEX_CACHE_PATH, "utf8"));
    if (!Array.isArray(data.roots) || data.roots.join(";") !== LIBRARY_ROOTS.join(";")) {
      return null;
    }

    return hydrateLibrary(data);
  } catch (error) {
    console.warn("[cache]", error.message);
    return null;
  }
}

function saveLibraryCache(index) {
  try {
    ensureDataDir();
    fs.writeFileSync(INDEX_CACHE_PATH, JSON.stringify(serializeLibrary(index)), "utf8");
  } catch (error) {
    console.warn("[cache]", error.message);
  }
}

function loadUserState() {
  try {
    if (!fs.existsSync(USER_STATE_PATH)) {
      userState = emptyUserState();
      return;
    }

    const data = JSON.parse(fs.readFileSync(USER_STATE_PATH, "utf8"));
    const favoriteFolders = normalizeFavoriteFolders(data.favoriteFolders);
    userState = {
      version: 2,
      favoriteFolders,
      favorites: normalizeFavorites(data.favorites, favoriteFolders),
      progress: data.progress && typeof data.progress === "object" ? data.progress : {}
    };
  } catch (error) {
    console.warn("[state]", error.message);
    userState = emptyUserState();
  }
}

function saveUserState() {
  try {
    ensureDataDir();
    fs.writeFileSync(USER_STATE_PATH, JSON.stringify(userState, null, 2), "utf8");
  } catch (error) {
    console.warn("[state]", error.message);
  }
}

function createWork(personId, title, workDir, files, fallbackVideo = null) {
  const { videos, images, infos } = collectMediaFiles(files);
  if (!videos.length && fallbackVideo) {
    videos.push(fallbackVideo);
  }

  if (!videos.length) {
    return null;
  }

  const preferredBaseName = fallbackVideo ? fileBase(fallbackVideo.name) : path.basename(workDir);
  const cover = chooseCover(images, preferredBaseName, workDir);
  const playableCount = videos.filter((video) => video.playable).length;
  const modifiedAt = videos
    .map((video) => video.modifiedAt)
    .filter(Boolean)
    .sort()
    .at(-1) || null;

  return {
    id: createId("w", `${personId}|${workDir}|${title}`),
    personId,
    title,
    directoryName: path.basename(workDir),
    relativePath: relativeFromRoot(workDir),
    coverId: cover?.id || null,
    videoCount: videos.length,
    playableCount,
    imageCount: images.length,
    infoCount: infos.length,
    modifiedAt,
    videos,
    images,
    infos
  };
}

function scanPersonDirectory(personId, personDir) {
  const works = [];

  const childDirs = directChildDirectories(personDir);
  for (const childDir of childDirs) {
    const childFiles = walkFiles(childDir);
    const work = createWork(personId, path.basename(childDir), childDir, childFiles);
    if (work) {
      works.push(work);
    }
  }

  const rootFiles = directFiles(personDir);
  const rootMedia = collectMediaFiles(rootFiles);
  for (const video of rootMedia.videos) {
    const matchingFiles = rootFiles.filter((fullPath) => {
      const ext = normalizeExt(fullPath);
      const base = fileBase(path.basename(fullPath));
      return fullPath === video.path || (base === fileBase(video.name) && (IMAGE_EXTS.has(ext) || INFO_EXTS.has(ext)));
    });
    const work = createWork(personId, video.name, personDir, matchingFiles, video);
    if (work) {
      works.push(work);
    }
  }

  return works;
}

function scanLibrary() {
  const index = emptyLibrary();
  const personBuckets = new Map();

  for (const rootPath of LIBRARY_ROOTS) {
    if (!fs.existsSync(rootPath)) {
      index.missingRoots.push(rootPath);
      continue;
    }

    index.availableRoots.push(rootPath);
    const personDirs = directChildDirectories(rootPath)
      .filter((dir) => !EXCLUDED_DIRS.has(path.basename(dir)))
      .sort((a, b) => path.basename(a).localeCompare(path.basename(b), undefined, { numeric: true, sensitivity: "base" }));

    for (const personDir of personDirs) {
      const personName = path.basename(personDir);
      const personId = createId("p", personName);
      let bucket = personBuckets.get(personName);

      if (!bucket) {
        bucket = {
          id: personId,
          name: personName,
          sourcePaths: [],
          works: []
        };
        personBuckets.set(personName, bucket);
      }

      bucket.sourcePaths.push(relativeFromRoot(personDir));
      bucket.works.push(...scanPersonDirectory(bucket.id, personDir));
    }
  }

  if (!index.availableRoots.length) {
    throw new Error(`资料库路径不存在：${LIBRARY_ROOTS.join("; ")}`);
  }

  const buckets = [...personBuckets.values()].sort((a, b) =>
    a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" })
  );

  for (const bucket of buckets) {
    const works = bucket.works.sort(compareNaturalTitle);

    for (const work of works) {
      registerFiles(index, [...work.videos, ...work.images, ...work.infos]);
      index.worksById.set(work.id, work);
    }

    const coverId = works.find((work) => work.coverId)?.coverId || null;
    const videoCount = works.reduce((sum, work) => sum + work.videoCount, 0);
    const playableCount = works.reduce((sum, work) => sum + work.playableCount, 0);
    const infoCount = works.reduce((sum, work) => sum + work.infoCount, 0);
    const imageCount = works.reduce((sum, work) => sum + work.imageCount, 0);
    const modifiedAt = works
      .map((work) => work.modifiedAt)
      .filter(Boolean)
      .sort()
      .at(-1) || null;

    const person = {
      id: bucket.id,
      name: bucket.name,
      relativePath: bucket.sourcePaths[0] || "",
      sourcePaths: bucket.sourcePaths,
      sourceCount: bucket.sourcePaths.length,
      coverId,
      workCount: works.length,
      videoCount,
      playableCount,
      imageCount,
      infoCount,
      modifiedAt,
      works: works.map((work) => work.id)
    };

    index.people.push(person);
    index.peopleById.set(person.id, person);
  }

  index.scannedAt = new Date().toISOString();
  index.totals.people = index.people.length;
  index.totals.works = index.worksById.size;
  index.totals.videos = [...index.filesById.values()].filter((file) => file.type === "video").length;
  index.totals.playableVideos = [...index.filesById.values()].filter((file) => file.type === "video" && file.playable).length;
  index.totals.images = [...index.filesById.values()].filter((file) => file.type === "image").length;
  index.totals.infoFiles = [...index.filesById.values()].filter((file) => file.type === "info").length;

  return index;
}

function refreshLibrary() {
  try {
    library = scanLibrary();
    saveLibraryCache(library);
    invalidateLibraryDerivedCaches();
    lastScanError = null;
    console.log(
      `[scan] ${library.totals.people} people, ${library.totals.works} works, ${library.totals.videos} videos, ${library.totals.images} images`
    );
  } catch (error) {
    lastScanError = error;
    console.error("[scan]", error.message);
  }
}

function invalidateLibraryDerivedCaches() {
  workInfoCache = null;
  actorProfileCache = null;
  actorMovieCache = null;
  localWorkCodeKeyCache = null;
  localWorkByCodeKeyCache = null;
  clearSearchSourceCaches();
  videoProbeCache.clear();
}

function recalculateLibraryTotals() {
  library.scannedAt = new Date().toISOString();
  library.totals.people = library.people.length;
  library.totals.works = library.worksById.size;
  const files = [...library.filesById.values()];
  library.totals.videos = files.filter((file) => file.type === "video").length;
  library.totals.playableVideos = files.filter((file) => file.type === "video" && file.playable).length;
  library.totals.images = files.filter((file) => file.type === "image").length;
  library.totals.infoFiles = files.filter((file) => file.type === "info").length;
}

function personRecordFromWorks(person, sourcePaths, works) {
  const sortedWorks = works.sort(compareNaturalTitle);
  const coverId = sortedWorks.find((work) => work.coverId)?.coverId || null;
  const videoCount = sortedWorks.reduce((sum, work) => sum + work.videoCount, 0);
  const playableCount = sortedWorks.reduce((sum, work) => sum + work.playableCount, 0);
  const infoCount = sortedWorks.reduce((sum, work) => sum + work.infoCount, 0);
  const imageCount = sortedWorks.reduce((sum, work) => sum + work.imageCount, 0);
  const modifiedAt = sortedWorks
    .map((work) => work.modifiedAt)
    .filter(Boolean)
    .sort()
    .at(-1) || null;

  return {
    id: person.id,
    name: person.name,
    relativePath: sourcePaths[0] || person.relativePath || "",
    sourcePaths,
    sourceCount: sourcePaths.length,
    coverId,
    workCount: sortedWorks.length,
    videoCount,
    playableCount,
    imageCount,
    infoCount,
    modifiedAt,
    works: sortedWorks.map((work) => work.id)
  };
}

function refreshPersonLibrary(personId) {
  const person = library.peopleById.get(personId);
  if (!person) {
    const error = new Error("人物不存在");
    error.statusCode = 404;
    throw error;
  }

  const sourcePaths = [...new Set([...(person.sourcePaths || []), person.relativePath].filter(Boolean))];
  if (!sourcePaths.length) {
    const error = new Error("这个人物没有本地来源路径");
    error.statusCode = 400;
    throw error;
  }

  const works = [];
  const existingSourcePaths = [];
  for (const sourcePath of sourcePaths) {
    const absolutePath = sourcePathToAbsolute(sourcePath);
    const stat = safeStat(absolutePath);
    if (!stat?.isDirectory()) continue;
    existingSourcePaths.push(relativeFromRoot(absolutePath));
    works.push(...scanPersonDirectory(person.id, absolutePath));
  }

  if (!existingSourcePaths.length) {
    const error = new Error("本地人物文件夹不存在");
    error.statusCode = 404;
    throw error;
  }

  for (const workId of person.works || []) {
    const oldWork = library.worksById.get(workId);
    if (!oldWork) continue;
    for (const file of [...(oldWork.videos || []), ...(oldWork.images || []), ...(oldWork.infos || [])]) {
      library.filesById.delete(file.id);
    }
    library.worksById.delete(workId);
  }

  for (const work of works) {
    registerFiles(library, [...work.videos, ...work.images, ...work.infos]);
    library.worksById.set(work.id, work);
  }

  const nextPerson = personRecordFromWorks(person, existingSourcePaths, works);
  const personIndex = library.people.findIndex((item) => item.id === person.id);
  if (personIndex >= 0) library.people[personIndex] = nextPerson;
  library.peopleById.set(person.id, nextPerson);
  recalculateLibraryTotals();
  saveLibraryCache(library);
  invalidateLibraryDerivedCaches();
  return nextPerson;
}

function publicAdminTask(task) {
  return {
    id: task.id,
    type: task.type,
    label: task.label,
    personId: task.personId || "",
    personName: task.personName || "",
    status: task.status,
    exitCode: task.exitCode ?? null,
    startedAt: task.startedAt,
    finishedAt: task.finishedAt || "",
    logs: task.logs.slice(-120)
  };
}

function pushAdminLog(task, chunk) {
  const lines = String(chunk || "").split(/\r?\n/).filter(Boolean);
  for (const line of lines) {
    task.logs.push(line);
  }
  if (task.logs.length > 400) task.logs.splice(0, task.logs.length - 400);
}

function startAdminProcessTask({ type, label, person, command, args, onDone }) {
  const task = {
    id: `task_${++adminTaskSeq}`,
    type,
    label,
    personId: person?.id || "",
    personName: person?.name || "",
    status: "running",
    exitCode: null,
    startedAt: new Date().toISOString(),
    finishedAt: "",
    logs: []
  };
  adminTasks.unshift(task);
  if (adminTasks.length > 20) adminTasks.length = 20;

  pushAdminLog(task, `${command} ${args.join(" ")}`);
  const child = spawn(command, args, { cwd: __dirname, windowsHide: true });
  child.stdout.on("data", (chunk) => pushAdminLog(task, chunk));
  child.stderr.on("data", (chunk) => pushAdminLog(task, chunk));
  child.on("error", (error) => {
    task.status = "error";
    task.finishedAt = new Date().toISOString();
    pushAdminLog(task, error.message);
  });
  child.on("close", (code) => {
    task.exitCode = code;
    task.status = code === 0 ? "done" : "error";
    task.finishedAt = new Date().toISOString();
    pushAdminLog(task, `退出码 ${code}`);
    onDone?.(task);
  });

  return task;
}

function isFavoriteWork(workId) {
  return Boolean(userState.favorites[workId]);
}

function favoriteRecord(workId) {
  const favorite = userState.favorites[workId];
  return favorite ? normalizeFavoriteRecord(favorite, userState.favoriteFolders) : null;
}

function favoriteFolderName(folderId) {
  return userState.favoriteFolders?.[folderId]?.name || DEFAULT_FAVORITE_FOLDER_NAME;
}

function favoriteFolderCounts() {
  const counts = new Map(Object.keys(userState.favoriteFolders || defaultFavoriteFolders()).map((folderId) => [folderId, 0]));
  for (const [workId, favorite] of Object.entries(userState.favorites || {})) {
    if (!library.worksById.has(workId)) continue;
    const folderId = normalizeFavoriteFolderId(favorite?.folderId);
    counts.set(folderId, (counts.get(folderId) || 0) + 1);
  }
  return counts;
}

function publicFavoriteFolders() {
  const counts = favoriteFolderCounts();
  return Object.entries(userState.favoriteFolders || defaultFavoriteFolders())
    .map(([id, folder]) => ({
      id,
      name: cleanFavoriteFolderName(folder?.name) || DEFAULT_FAVORITE_FOLDER_NAME,
      count: counts.get(id) || 0,
      createdAt: String(folder?.createdAt || "")
    }))
    .sort((a, b) => {
      if (a.id === DEFAULT_FAVORITE_FOLDER_ID) return -1;
      if (b.id === DEFAULT_FAVORITE_FOLDER_ID) return 1;
      return String(a.createdAt || "").localeCompare(String(b.createdAt || "")) || a.name.localeCompare(b.name, "zh-Hans-CN");
    });
}

function publicFavoriteForWork(workId) {
  const favorite = favoriteRecord(workId);
  if (!favorite) return null;
  const folderId = normalizeFavoriteFolderId(favorite.folderId);
  return {
    createdAt: favorite.createdAt || "",
    folderId,
    folderName: favoriteFolderName(folderId)
  };
}

function createFavoriteFolder(name) {
  const cleanName = cleanFavoriteFolderName(name);
  if (!cleanName) {
    const error = new Error("请输入收藏夹名称");
    error.statusCode = 400;
    throw error;
  }

  const folders = userState.favoriteFolders || defaultFavoriteFolders();
  const existing = Object.entries(folders).find(([, folder]) => cleanFavoriteFolderName(folder?.name) === cleanName);
  if (existing) return { id: existing[0], ...existing[1] };

  if (Object.keys(folders).length >= MAX_FAVORITE_FOLDERS) {
    const error = new Error(`收藏夹最多 ${MAX_FAVORITE_FOLDERS} 个`);
    error.statusCode = 400;
    throw error;
  }

  const baseId = createId("ff", cleanName).slice(0, 80);
  let id = baseId;
  let suffix = 2;
  while (folders[id]) {
    id = `${baseId}_${suffix}`;
    suffix += 1;
  }

  folders[id] = {
    name: cleanName,
    createdAt: new Date().toISOString()
  };
  userState.favoriteFolders = folders;
  return { id, ...folders[id] };
}

function moveFavoriteToFolder(workId, folderId) {
  const favorite = userState.favorites[workId];
  if (!favorite) {
    const error = new Error("作品尚未收藏");
    error.statusCode = 400;
    throw error;
  }
  favorite.folderId = normalizeFavoriteFolderId(folderId);
  return publicFavoriteForWork(workId);
}

function getVideoProgress(videoId) {
  const progress = userState.progress[videoId];
  if (!progress || !Number.isFinite(progress.position) || !Number.isFinite(progress.duration) || progress.duration <= 0) {
    return null;
  }

  const percent = Math.max(0, Math.min(100, (progress.position / progress.duration) * 100));
  return {
    videoId,
    workId: progress.workId || null,
    position: progress.position,
    duration: progress.duration,
    percent,
    updatedAt: progress.updatedAt || null
  };
}

function getWorkProgress(work) {
  const candidates = (work.videos || [])
    .map((video) => getVideoProgress(video.id))
    .filter(Boolean)
    .sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")));
  return candidates[0] || null;
}

function progressUpdatedTime(progress) {
  const timestamp = Date.parse(progress?.updatedAt || "");
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function progressWork(videoId, progress) {
  if (progress?.workId && library.worksById.has(progress.workId)) {
    return library.worksById.get(progress.workId);
  }

  const file = library.filesById.get(videoId);
  if (!file || file.type !== "video") return null;
  for (const work of library.worksById.values()) {
    if ((work.videos || []).some((video) => video.id === videoId)) return work;
  }
  return null;
}

function historyEntries(options = {}) {
  const days = Number(options.days || 0);
  const cutoff = days > 0 ? Date.now() - days * 24 * 60 * 60 * 1000 : 0;
  const byWorkId = new Map();

  for (const [videoId, progress] of Object.entries(userState.progress)) {
    const updatedTime = progressUpdatedTime(progress);
    if (cutoff && (!updatedTime || updatedTime < cutoff)) continue;
    const work = progressWork(videoId, progress);
    if (!work) continue;

    const existing = byWorkId.get(work.id);
    if (!existing || updatedTime > existing.updatedTime) {
      byWorkId.set(work.id, {
        work,
        updatedAt: progress?.updatedAt || "",
        updatedTime
      });
    }
  }

  const entries = [...byWorkId.values()].sort((a, b) => b.updatedTime - a.updatedTime || String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")));
  const limit = Number(options.limit || 0);
  return limit > 0 ? entries.slice(0, limit) : entries;
}

function userStateSummary() {
  const favoriteCount = Object.keys(userState.favorites).filter((workId) => library.worksById.has(workId)).length;
  const allHistory = historyEntries();
  const recentHistory = historyEntries({ days: RECENT_WATCHED_DAYS });

  return {
    favoriteCount,
    historyCount: allHistory.length,
    recentWatchedCount: recentHistory.length,
    recentWatchedDays: RECENT_WATCHED_DAYS,
    latestProgressAt: allHistory[0]?.updatedAt || "",
    favoriteFolders: publicFavoriteFolders()
  };
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1024 * 1024) {
        reject(new Error("请求体太大"));
        req.destroy();
      }
    });
    req.on("end", () => {
      if (!body.trim()) {
        resolve({});
        return;
      }

      try {
        resolve(JSON.parse(body));
      } catch {
        reject(new Error("JSON 格式无效"));
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Content-Length": Buffer.byteLength(body)
  });
  res.end(body);
}

function sendText(res, status, text) {
  res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8" });
  res.end(text);
}

function notFound(res) {
  sendJson(res, 404, { error: "Not found" });
}

function publicFilePath(urlPath) {
  const requested = urlPath === "/" ? "/index.html" : urlPath;
  const decoded = decodeURIComponent(requested);
  const normalized = path.normalize(decoded).replace(/^(\.\.[/\\])+/, "");
  const target = path.join(PUBLIC_DIR, normalized);
  const relative = path.relative(PUBLIC_DIR, target);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    return null;
  }
  return target;
}

function serveStatic(req, res, urlPath) {
  const target = publicFilePath(urlPath);
  if (!target || !fs.existsSync(target) || !fs.statSync(target).isFile()) {
    notFound(res);
    return;
  }

  const ext = normalizeExt(target);
  res.writeHead(200, {
    "Content-Type": MIME_TYPES[ext] || "application/octet-stream",
    "Cache-Control": "no-store"
  });
  fs.createReadStream(target).pipe(res);
}

function serveImage(res, file) {
  const stat = safeStat(file.path);
  if (!stat) {
    notFound(res);
    return;
  }

  res.writeHead(200, {
    "Content-Type": MIME_TYPES[file.ext] || "application/octet-stream",
    "Content-Length": stat.size,
    "Cache-Control": "public, max-age=3600",
    "Content-Disposition": "inline"
  });
  fs.createReadStream(file.path).pipe(res);
}

function serveActorAvatar(res, personId) {
  const row = actorProfileRow(personId);
  if (!row?.avatar_blob) {
    notFound(res);
    return;
  }

  const buffer = Buffer.from(row.avatar_blob);
  res.writeHead(200, {
    "Content-Type": row.avatar_mime || "image/jpeg",
    "Content-Length": buffer.length,
    "Cache-Control": "public, max-age=86400",
    "Content-Disposition": "inline"
  });
  res.end(buffer);
}

function serveWorkCover(res, workId) {
  const row = workCoverRow(workId);
  if (!row?.cover_blob) {
    notFound(res);
    return;
  }

  const buffer = Buffer.from(row.cover_blob);
  res.writeHead(200, {
    "Content-Type": row.cover_mime || "image/jpeg",
    "Content-Length": buffer.length,
    "Cache-Control": "public, max-age=86400",
    "Content-Disposition": "inline"
  });
  res.end(buffer);
}

function parseRange(rangeHeader, size) {
  const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader || "");
  if (!match) return null;

  let start = match[1] ? Number(match[1]) : 0;
  let end = match[2] ? Number(match[2]) : size - 1;

  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start < 0 || end >= size) {
    return null;
  }

  return { start, end };
}

function serveVideo(req, res, file) {
  const stat = safeStat(file.path);
  if (!stat) {
    notFound(res);
    return;
  }

  const range = parseRange(req.headers.range, stat.size);
  const contentType = MIME_TYPES[file.ext] || "application/octet-stream";

  if (range) {
    res.writeHead(206, {
      "Content-Type": contentType,
      "Accept-Ranges": "bytes",
      "Content-Range": `bytes ${range.start}-${range.end}/${stat.size}`,
      "Content-Length": range.end - range.start + 1,
      "Cache-Control": "no-store",
      "Content-Disposition": "inline"
    });
    fs.createReadStream(file.path, range).pipe(res);
    return;
  }

  res.writeHead(200, {
    "Content-Type": contentType,
    "Accept-Ranges": "bytes",
    "Content-Length": stat.size,
    "Cache-Control": "no-store",
    "Content-Disposition": "inline"
  });
  fs.createReadStream(file.path).pipe(res);
}

function serveTranscodedVideo(req, res, file, url) {
  const stat = safeStat(file.path);
  if (!stat) {
    notFound(res);
    return;
  }

  const mode = url.searchParams.get("mode") === "remux" ? "remux" : "transcode";
  const audio = url.searchParams.get("audio") === "copy" ? "copy" : "aac";
  const startAt = Math.max(0, Number(url.searchParams.get("t") || 0) || 0);
  const args = ["-hide_banner", "-loglevel", "error"];
  if (startAt > 0) args.push("-ss", String(Math.floor(startAt)));
  args.push("-i", file.path, "-map", "0:v:0?", "-map", "0:a:0?", "-sn", "-dn");

  if (mode === "remux") {
    args.push("-c:v", "copy", "-c:a", audio === "copy" ? "copy" : "aac", "-b:a", "160k");
  } else {
    if (HAS_NVENC) {
      args.push("-c:v", "h264_nvenc", "-preset", "p4", "-cq", "24");
    } else {
      args.push("-c:v", "libx264", "-preset", "veryfast", "-crf", "23");
    }
    args.push("-c:a", "aac", "-b:a", "160k");
  }

  args.push("-movflags", "frag_keyframe+empty_moov+default_base_moof", "-f", "mp4", "pipe:1");

  res.writeHead(200, {
    "Content-Type": "video/mp4",
    "Cache-Control": "no-store",
    "Content-Disposition": "inline"
  });

  const child = spawn(FFMPEG_PATH, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.pipe(res);
  child.stderr.on("data", (chunk) => {
    const text = String(chunk || "").trim();
    if (text) console.warn("[ffmpeg]", text);
  });
  child.on("error", (error) => {
    console.warn("[ffmpeg]", error.message);
    if (!res.headersSent) sendJson(res, 500, { error: "FFmpeg 启动失败" });
    else res.destroy(error);
  });
  req.on("close", () => {
    if (!child.killed) child.kill("SIGKILL");
  });
}

function serveInfo(res, file) {
  const stat = safeStat(file.path);
  if (!stat) {
    notFound(res);
    return;
  }

  if (stat.size > MAX_INFO_BYTES) {
    sendJson(res, 413, { error: "资料文件太大，已跳过预览。", size: stat.size });
    return;
  }

  const buffer = fs.readFileSync(file.path);
  const content = decodeInfoBuffer(buffer);
  let metadata = null;
  if (!isSubtitleLikeInfoText(content)) {
    try {
      metadata = parseInfoMetadata(content, {
        title: "",
        fileName: file.name || "",
        directoryName: path.basename(path.dirname(file.relativePath || file.path || ""))
      });
    } catch {
      metadata = null;
    }
  }
  sendJson(res, 200, {
    id: file.id,
    name: file.name,
    ext: file.ext,
    size: file.size,
    relativePath: file.relativePath,
    content,
    metadata
  });
}

function publicPerson(person, options = {}) {
  const actorProfile = publicActorProfile(actorProfileRow(person.id));
  const isGSource = isGPerson(person);
  return {
    id: person.id,
    name: person.name,
    relativePath: person.relativePath,
    sourcePaths: person.sourcePaths,
    sourceCount: person.sourceCount,
    coverId: person.coverId,
    workCount: person.workCount,
    videoCount: person.videoCount,
    playableCount: person.playableCount,
    imageCount: person.imageCount,
    infoCount: person.infoCount,
    modifiedAt: person.modifiedAt,
    isGSource,
    actorMovieCount: options.actorMovieCount ?? null,
    missingLocalWorkCount: options.missingLocalWorkCount ?? null,
    actorProfile
  };
}

function publicWork(work, includeFiles = false) {
  if (work.missingLocal) {
    const person = library.peopleById.get(work.personId);
    const profileRow = person ? actorProfileRow(person.id) : null;
    const base = {
      id: work.id,
      personId: work.personId,
      personName: work.personName || "",
      personDisplayName: person ? cleanPersonNamePart(profileRow?.display_name) || person.name : work.personName || "",
      personAliases: actorProfileAliases(profileRow),
      title: work.title || work.directoryName || "未下载作品",
      directoryName: work.directoryName || "",
      relativePath: work.relativePath || "",
      coverId: null,
      cachedCover: null,
      remoteCoverUrl: work.remoteCoverUrl || "",
      videoCount: 0,
      playableCount: 0,
      imageCount: 0,
      infoCount: 0,
      videoSize: 0,
      canGenerateCover: false,
      modifiedAt: work.modifiedAt || "",
      infoSummary: work.infoSummary || null,
      favorite: false,
      progress: null,
      missingLocal: true,
      javdbUrl: work.javdbUrl || "",
      actorUrl: work.actorUrl || "",
      ranking: work.ranking || null
    };

    if (includeFiles) {
      base.videos = [];
      base.images = [];
      base.infos = [];
      base.infoMetadata = null;
    }

    return base;
  }

  const person = library.peopleById.get(work.personId);
  const profileRow = person ? actorProfileRow(person.id) : null;
  const cachedCover = work.coverId ? null : publicWorkCover(workCoverRow(work.id));
  const infoRow = workInfoRow(work.id);
  const videos = work.videos || [];
  const favorite = publicFavoriteForWork(work.id);
  const base = {
    id: work.id,
    personId: work.personId,
    personName: person?.name || "",
    personDisplayName: person ? cleanPersonNamePart(profileRow?.display_name) || person.name : "",
    personAliases: actorProfileAliases(profileRow),
    title: work.title,
    directoryName: work.directoryName,
    relativePath: work.relativePath,
    coverId: work.coverId,
    cachedCover,
    videoCount: work.videoCount,
    playableCount: work.playableCount,
    imageCount: work.imageCount,
    infoCount: work.infoCount,
    videoSize: videos.reduce((sum, video) => sum + Number(video.size || 0), 0),
    canGenerateCover: !work.coverId && !cachedCover && videos.length > 0,
    modifiedAt: work.modifiedAt,
    infoSummary: publicWorkInfoSummary(infoRow, work.infoSummary),
    favorite: Boolean(favorite),
    favoriteFolderId: favorite?.folderId || "",
    favoriteFolderName: favorite?.folderName || "",
    progress: getWorkProgress(work)
  };
  if (work.ranking) base.ranking = work.ranking;

  if (includeFiles) {
    base.videos = videos.map(publicMediaFile);
    base.images = (work.images || []).map(publicMediaFile);
    base.infos = (work.infos || []).map(publicMediaFile);
    base.infoMetadata = publicWorkInfoMetadata(infoRow);
  }

  return base;
}

function publicMediaFile(file) {
  return {
    id: file.id,
    type: file.type,
    name: file.name,
    title: file.title,
    ext: file.ext,
    relativePath: file.relativePath,
    size: file.size,
    modifiedAt: file.modifiedAt,
    playable: file.playable,
    progress: file.type === "video" ? getVideoProgress(file.id) : null
  };
}

function favoriteWorks(folderId = "") {
  const selectedFolderId = folderId ? normalizeFavoriteFolderId(folderId) : "";
  return Object.entries(userState.favorites)
    .map(([workId, favorite]) => ({ work: library.worksById.get(workId), favorite: normalizeFavoriteRecord(favorite, userState.favoriteFolders) }))
    .filter((item) => item.work)
    .filter((item) => !selectedFolderId || normalizeFavoriteFolderId(item.favorite.folderId) === selectedFolderId)
    .sort((a, b) => String(b.favorite.createdAt || "").localeCompare(String(a.favorite.createdAt || "")))
    .map((item) => item.work);
}

function historyWorks(options = {}) {
  return historyEntries(options).map((item) => item.work);
}

function requestHostName(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  try {
    return new URL(`http://${raw}`).hostname.toLowerCase();
  } catch {
    return raw.split(":")[0].toLowerCase();
  }
}

function isLocalHostName(host) {
  return ["localhost", "127.0.0.1", "::1", "[::1]"].includes(host);
}

function isSameLocalOrigin(req) {
  const origin = String(req.headers.origin || "").trim();
  if (!origin) return true;

  try {
    const originUrl = new URL(origin);
    const requestHost = String(req.headers.host || "").toLowerCase();
    return originUrl.host.toLowerCase() === requestHost && isLocalHostName(originUrl.hostname.toLowerCase());
  } catch {
    return false;
  }
}

function requestAccess(req) {
  const host = requestHostName(req.headers.host);
  const forwarded = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
  const remote = forwarded || req.socket.remoteAddress || "";
  const isLocalHost = isLocalHostName(host);
  const isLan = isLanHost(host);
  const mode = isLocalHost ? "local" : isLan ? "lan" : "remote";
  return {
    mode,
    isLocal: mode === "local",
    host,
    clientAddress: remote,
    hints: {
      workPageSize: mode === "local" ? 1000 : 80,
      videoPreload: mode === "local" ? "metadata" : "none",
      transcode: mode === "local" ? "manual" : "prefer"
    }
  };
}

function isLanHost(host) {
  const match = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(host || "");
  if (!match) return false;
  const first = Number(match[1]);
  const second = Number(match[2]);
  return first === 10 || (first === 172 && second >= 16 && second <= 31) || (first === 192 && second === 168) || (first === 169 && second === 254);
}

function clampInteger(value, fallback, min, max) {
  if (value === null || value === undefined || String(value).trim() === "") return fallback;
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(number)));
}

function allWorks() {
  return [...library.worksById.values()];
}

function workRating(work) {
  return firstPresentNumber(workInfoRow(work.id)?.rating, work.infoSummary?.rating);
}

function workRatingCount(work) {
  return firstPresentNumber(workInfoRow(work.id)?.rating_count, work.infoSummary?.ratingCount) || 0;
}

function workReleaseDate(work) {
  return firstPresentText(workInfoRow(work.id)?.release_date, work.infoSummary?.releaseDate);
}

function isVrWork(work) {
  const text = `${work.relativePath || ""}\n${work.title || ""}\n${work.directoryName || ""}`.toLowerCase();
  return text.includes("v:/") || text.includes("[vr]") || /\bvr\b/i.test(text);
}

function workMatchesFilter(work, filter) {
  switch (filter) {
    case "localOnly":
      return !work.missingLocal;
    case "missingLocal":
      return Boolean(work.missingLocal);
    case "playable":
      return Number(work.playableCount || 0) > 0;
    case "favorite":
      return isFavoriteWork(work.id);
    case "progress":
      return Boolean(getWorkProgress(work));
    case "info":
      return Boolean(workInfoRow(work.id)) || Number(work.infoCount || 0) > 0;
    case "rated":
      return workRating(work) !== null;
    case "highRating": {
      const rating = workRating(work);
      return rating !== null && rating >= 4;
    }
    case "vr":
      return isVrWork(work);
    case "missingCover":
      if (work.missingLocal) return false;
      return !work.coverId && !workCoverRow(work.id);
    case "all":
    default:
      return true;
  }
}

function sortWorkList(works, sort) {
  const list = [...works];
  list.sort((a, b) => {
    if (sort === "releaseDesc" || sort === "releaseAsc") {
      const aDate = workReleaseDate(a);
      const bDate = workReleaseDate(b);
      const aHas = Boolean(aDate);
      const bHas = Boolean(bDate);
      if (aHas !== bHas) return aHas ? -1 : 1;
      if (aDate !== bDate) return sort === "releaseAsc" ? aDate.localeCompare(bDate) : bDate.localeCompare(aDate);
    }

    if (sort === "ratingAsc" || sort === "ratingDesc") {
      const aRating = workRating(a);
      const bRating = workRating(b);
      const aHas = aRating !== null;
      const bHas = bRating !== null;
      if (aHas !== bHas) return aHas ? -1 : 1;
      if (aHas && aRating !== bRating) return sort === "ratingAsc" ? aRating - bRating : bRating - aRating;
      const countDiff = workRatingCount(b) - workRatingCount(a);
      if (countDiff) return countDiff;
    }

    if (sort === "size" || sort === "sizeDesc" || sort === "sizeAsc") {
      const aSize = (a.videos || []).reduce((sum, video) => sum + Number(video.size || 0), 0);
      const bSize = (b.videos || []).reduce((sum, video) => sum + Number(video.size || 0), 0);
      if (aSize !== bSize) return sort === "sizeAsc" ? aSize - bSize : bSize - aSize;
    }

    if (sort === "duration" || sort === "durationDesc" || sort === "durationAsc") {
      const aDuration = Number(a.infoSummary?.durationMinutes ?? workInfoRow(a.id)?.duration_minutes ?? 0);
      const bDuration = Number(b.infoSummary?.durationMinutes ?? workInfoRow(b.id)?.duration_minutes ?? 0);
      if (aDuration !== bDuration) return sort === "durationAsc" ? aDuration - bDuration : bDuration - aDuration;
    }

    if (sort === "codeAsc" || sort === "codeDesc") {
      const aCode = a.infoSummary?.code || workInfoRow(a.id)?.code || a.title || a.directoryName || "";
      const bCode = b.infoSummary?.code || workInfoRow(b.id)?.code || b.title || b.directoryName || "";
      const result = aCode.localeCompare(bCode, undefined, { numeric: true, sensitivity: "base" });
      if (result) return sort === "codeDesc" ? -result : result;
    }

    return String(b.modifiedAt || "").localeCompare(String(a.modifiedAt || ""));
  });
  return list;
}

function workFacets(works = allWorks()) {
  return {
    all: works.length,
    playable: works.filter((work) => workMatchesFilter(work, "playable")).length,
    favorite: works.filter((work) => workMatchesFilter(work, "favorite")).length,
    progress: works.filter((work) => workMatchesFilter(work, "progress")).length,
    info: works.filter((work) => workMatchesFilter(work, "info")).length,
    localOnly: works.filter((work) => workMatchesFilter(work, "localOnly")).length,
    missingLocal: works.filter((work) => workMatchesFilter(work, "missingLocal")).length,
    rated: works.filter((work) => workRating(work) !== null).length,
    highRating: works.filter((work) => {
      const rating = workRating(work);
      return rating !== null && rating >= 4;
    }).length,
    vr: works.filter((work) => workMatchesFilter(work, "vr")).length,
    missingCover: works.filter((work) => workMatchesFilter(work, "missingCover")).length
  };
}

function pagedWorksPayload(works, url, extra = {}) {
  const limit = clampInteger(url.searchParams.get("limit"), DEFAULT_WORK_LIMIT, 1, MAX_WORK_LIMIT);
  const offset = clampInteger(url.searchParams.get("offset"), 0, 0, Number.MAX_SAFE_INTEGER);
  const sort = url.searchParams.get("sort") || "updated";
  const total = works.length;
  const page = works.slice(offset, offset + limit).map((work) => publicWork(work));
  return { ...extra, count: page.length, total, limit, offset, sort, works: page };
}

function requireLocalAdmin(req, res) {
  const access = requestAccess(req);
  if (!access.isLocal || !isSameLocalOrigin(req)) {
    sendJson(res, 403, { error: "后台管理只能在本机页面使用" });
    return false;
  }
  return true;
}

function videoProbe(file) {
  try {
    const result = spawnSync(
      FFPROBE_PATH,
      ["-v", "error", "-show_entries", "format=duration", "-show_streams", "-of", "json", file.path],
      { encoding: "utf8", windowsHide: true, timeout: 8000, maxBuffer: 2 * 1024 * 1024 }
    );
    if (result.status !== 0 || !result.stdout) return null;
    const data = JSON.parse(result.stdout);
    const video = (data.streams || []).find((stream) => stream.codec_type === "video") || {};
    const audio = (data.streams || []).find((stream) => stream.codec_type === "audio") || {};
    return {
      duration: Number(data.format?.duration || 0) || null,
      videoCodec: video.codec_name || "",
      audioCodec: audio.codec_name || "",
      width: video.width || null,
      height: video.height || null
    };
  } catch {
    return null;
  }
}

function videoProbeCached(file) {
  const stat = safeStat(file.path);
  const cacheKey = stat ? `${file.id}:${file.path}:${stat.size}:${stat.mtimeMs}` : `${file.id}:${file.path}:missing`;
  if (videoProbeCache.has(cacheKey)) {
    const cached = videoProbeCache.get(cacheKey);
    videoProbeCache.delete(cacheKey);
    videoProbeCache.set(cacheKey, cached);
    return cached;
  }

  const result = stat ? videoProbe(file) : null;
  videoProbeCache.set(cacheKey, result);
  if (videoProbeCache.size > VIDEO_PROBE_CACHE_LIMIT) {
    videoProbeCache.delete(videoProbeCache.keys().next().value);
  }
  return result;
}

function playInfoForFile(file) {
  const probe = videoProbeCached(file) || {};
  const videoCodec = String(probe.videoCodec || "").toLowerCase();
  const audioCodec = String(probe.audioCodec || "").toLowerCase();
  const canDirect = DIRECT_VIDEO_EXTS.has(file.ext) && (!videoCodec || ["h264", "avc1", "hevc", "h265", "vp8", "vp9", "av1"].includes(videoCodec));

  if (canDirect) {
    return {
      mode: "direct",
      label: "直连播放",
      streamUrl: `/media/video/${encodeURIComponent(file.id)}`,
      duration: probe.duration || null,
      videoCodec,
      audioCodec,
      hasNvenc: HAS_NVENC
    };
  }

  const canRemux = videoCodec === "h264" || videoCodec === "avc1";
  const mode = canRemux ? "remux" : "transcode";
  const params = new URLSearchParams({
    mode,
    audio: audioCodec === "aac" ? "copy" : "aac"
  });
  return {
    mode,
    label: mode === "remux" ? "快速重封装" : HAS_NVENC ? "GPU 转码" : "智能转码",
    streamUrl: `/media/video/${encodeURIComponent(file.id)}/transcode?${params}`,
    duration: probe.duration || null,
    videoCodec,
    audioCodec,
    hasNvenc: HAS_NVENC
  };
}

async function routeApi(req, res, url) {
  if (url.pathname === "/api/health" && req.method === "GET") {
    sendJson(res, 200, {
      ok: true,
      scannedAt: library.scannedAt,
      totals: library.totals,
      availableRootCount: library.availableRoots.length,
      missingRootCount: library.missingRoots.length,
      access: requestAccess(req),
      lastScanError: lastScanError?.message || null
    });
    return true;
  }

  if (url.pathname === "/api/library" && req.method === "GET") {
    const user = userStateSummary();
    sendJson(res, 200, {
      root: library.root,
      roots: library.roots,
      availableRoots: library.availableRoots,
      missingRoots: library.missingRoots,
      scannedAt: library.scannedAt,
      totals: library.totals,
      user,
      uiConfig: publicAppConfig(),
      access: requestAccess(req),
      lastScanError: lastScanError?.message || null,
      people: library.people.map(publicPerson)
    });
    return true;
  }

  if (url.pathname === "/api/rankings" && req.method === "GET") {
    sendJson(res, 200, { lists: rankingSummaries() });
    return true;
  }

  if (url.pathname === "/api/rankings/top" && req.method === "GET") {
    sendJson(res, 200, rankingWorksPayload(url, "top"));
    return true;
  }

  if (url.pathname === "/api/rescan" && req.method === "POST") {
    refreshLibrary();
    sendJson(res, lastScanError ? 500 : 200, {
      ok: !lastScanError,
      error: lastScanError?.message || null,
      scannedAt: library.scannedAt,
      roots: library.roots,
      availableRoots: library.availableRoots,
      missingRoots: library.missingRoots,
      totals: library.totals,
      user: userStateSummary()
    });
    return true;
  }

  if (url.pathname === "/api/admin/tasks" && req.method === "GET") {
    if (!requireLocalAdmin(req, res)) return true;
    sendJson(res, 200, { tasks: adminTasks.map(publicAdminTask) });
    return true;
  }

  if (url.pathname === "/api/admin/config" && req.method === "GET") {
    if (!requireLocalAdmin(req, res)) return true;
    sendJson(res, 200, { config: publicAppConfig() });
    return true;
  }

  if (url.pathname === "/api/admin/config" && req.method === "PUT") {
    if (!requireLocalAdmin(req, res)) return true;
    const body = await readJsonBody(req);
    appConfig = normalizeAppConfig(body.config || body);
    saveAppConfig();
    sendJson(res, 200, { ok: true, config: publicAppConfig() });
    return true;
  }

  if (url.pathname === "/api/admin/import-actor-avatars" && req.method === "POST") {
    if (!requireLocalAdmin(req, res)) return true;
    const body = await readJsonBody(req);
    const nextConfig = normalizeAppConfig({
      ...appConfig,
      actorAvatarDataPath: body.rootPath ?? body.actorAvatarDataPath ?? appConfig.actorAvatarDataPath
    });
    appConfig = nextConfig;
    saveAppConfig();

    try {
      const summary = importActorAvatarsFromFiletree(appConfig.actorAvatarDataPath, { replace: Boolean(body.replace) });
      sendJson(res, 200, { ok: true, config: publicAppConfig(), summary });
    } catch (error) {
      sendJson(res, error.statusCode || 500, { error: error.message || "扫描演员头像失败", config: publicAppConfig() });
    }
    return true;
  }

  if (url.pathname === "/api/admin/actor-avatar-candidates" && req.method === "POST") {
    if (!requireLocalAdmin(req, res)) return true;
    const body = await readJsonBody(req);
    appConfig = normalizeAppConfig({
      ...appConfig,
      actorAvatarDataPath: body.rootPath ?? body.actorAvatarDataPath ?? appConfig.actorAvatarDataPath
    });
    saveAppConfig();
    try {
      const summary = actorAvatarCandidatesFromFiletree(appConfig.actorAvatarDataPath, {
        personId: body.personId,
        limit: clampInteger(body.limit, 24, 1, 200)
      });
      sendJson(res, 200, { ok: true, config: publicAppConfig(), summary });
    } catch (error) {
      sendJson(res, error.statusCode || 500, { error: error.message || "读取演员头像候选失败", config: publicAppConfig() });
    }
    return true;
  }

  if (url.pathname === "/api/admin/apply-actor-avatar-candidate" && req.method === "POST") {
    if (!requireLocalAdmin(req, res)) return true;
    const body = await readJsonBody(req);
    appConfig = normalizeAppConfig({
      ...appConfig,
      actorAvatarDataPath: body.rootPath ?? body.actorAvatarDataPath ?? appConfig.actorAvatarDataPath
    });
    saveAppConfig();
    try {
      const result = importActorAvatarCandidate(appConfig.actorAvatarDataPath, body.personId, body.relPath, { dryRun: Boolean(body.dryRun) });
      sendJson(res, 200, { ok: true, config: publicAppConfig(), ...result });
    } catch (error) {
      sendJson(res, error.statusCode || 500, { error: error.message || "应用演员头像候选失败", config: publicAppConfig() });
    }
    return true;
  }

  if (url.pathname === "/api/admin/rescan-person" && req.method === "POST") {
    if (!requireLocalAdmin(req, res)) return true;
    const body = await readJsonBody(req);
    const person = library.peopleById.get(body.personId);
    if (!person) {
      sendJson(res, 404, { error: "人物不存在" });
      return true;
    }

    try {
      const nextPerson = refreshPersonLibrary(person.id);
      const works = sortWorkList(
        nextPerson.works
          .map((workId) => library.worksById.get(workId))
          .filter(Boolean),
        url.searchParams.get("sort") || "title"
      );
      sendJson(res, 200, {
        ok: true,
        person: publicPerson(nextPerson),
        ...pagedWorksPayload(works, url, {})
      });
    } catch (error) {
      sendJson(res, error.statusCode || 500, { error: error.message || "刷新人物失败" });
    }
    return true;
  }

  if (url.pathname === "/api/admin/refresh-actor-movies" && req.method === "POST") {
    if (!requireLocalAdmin(req, res)) return true;
    const body = await readJsonBody(req);
    const person = library.peopleById.get(body.personId);
    if (!person) {
      sendJson(res, 404, { error: "人物不存在" });
      return true;
    }

    const profile = actorProfileRow(person.id);
    if (!profile?.javdb_url) {
      sendJson(res, 400, { error: "这个人物还没有配置 JavDB actor 页" });
      return true;
    }

    const sleep = clampInteger(body.sleep, 2, 0, 60);
    const args = [
      "-u",
      path.join("tools", "backfill_javdb_actor_page.py"),
      "--write",
      "--all-sources",
      "--person-id",
      person.id,
      "--actor-movies-only",
      "--fast",
      "--sleep",
      String(sleep),
      "--jitter",
      "0"
    ];
    const task = startAdminProcessTask({
      type: "actor-movies",
      label: "刷新缺失检测",
      person,
      command: "python",
      args,
      onDone: () => {
        actorMovieCache = null;
        localWorkCodeKeyCache = null;
        localWorkByCodeKeyCache = null;
        clearSearchSourceCaches();
      }
    });
    sendJson(res, 202, { ok: true, task: publicAdminTask(task) });
    return true;
  }

  if (url.pathname === "/api/admin/refresh-rankings" && req.method === "POST") {
    if (!requireLocalAdmin(req, res)) return true;
    const body = await readJsonBody(req);
    const rawKeys = Array.isArray(body.keys) ? body.keys : [body.key || "y2025"];
    const keys = rawKeys
      .map((item) => String(item || "").trim())
      .filter((item, index, list) => list.indexOf(item) === index)
      .slice(0, 12);
    const sleep = clampInteger(body.sleep, 2, 0, 60);
    const args = ["-u", path.join("tools", "cache_javdb_rankings.py"), "--write", "--fast", "--sleep", String(sleep), "--jitter", "0.5"];
    for (const key of keys.length ? keys : ["y2025"]) {
      args.push("--list", key || "all");
    }
    const task = startAdminProcessTask({
      type: "rankings",
      label: "刷新排行榜缓存",
      person: null,
      command: "python",
      args,
      onDone: () => {
        localWorkCodeKeyCache = null;
        localWorkByCodeKeyCache = null;
        clearSearchSourceCaches();
      }
    });
    sendJson(res, 202, { ok: true, task: publicAdminTask(task) });
    return true;
  }

  if (url.pathname === "/api/admin/cover-cache-status" && req.method === "GET") {
    if (!requireLocalAdmin(req, res)) return true;
    const sampleLimit = clampInteger(url.searchParams.get("limit"), 8, 0, 50);
    sendJson(res, 200, coverGenerationStatus(sampleLimit));
    return true;
  }

  if (url.pathname === "/api/admin/generate-missing-covers" && req.method === "POST") {
    if (!requireLocalAdmin(req, res)) return true;
    const body = await readJsonBody(req);
    const limit = clampInteger(body.limit, 20, 1, 200);
    const args = [path.join("tools", "generate_missing_covers.mjs"), "--write", "--limit", String(limit)];
    const task = startAdminProcessTask({
      type: "covers",
      label: `批量补封面 ${limit}`,
      person: null,
      command: process.execPath,
      args,
      onDone: () => {
        workInfoCache = null;
        clearSearchSourceCaches();
      }
    });
    sendJson(res, 202, { ok: true, task: publicAdminTask(task) });
    return true;
  }

  if (url.pathname === "/api/open-folder" && req.method === "POST") {
    const access = requestAccess(req);
    if (!access.isLocal || !isSameLocalOrigin(req)) {
      sendJson(res, 403, { error: "只能在本机页面打开本地文件夹" });
      return true;
    }

    const body = await readJsonBody(req);
    const target = resolveLocalFolderTarget(body.sourcePath || body.path);
    if (target.error) {
      sendJson(res, 400, { error: target.error });
      return true;
    }

    sendJson(res, 200, { ok: true, path: relativeFromRoot(target.folderPath) });
    scheduleOpenFolder(target.folderPath);
    return true;
  }

  if (url.pathname === "/api/favorites" && req.method === "GET") {
    const rawFolderId = url.searchParams.get("folder") || "";
    const selectedFolderId = rawFolderId ? normalizeFavoriteFolderId(rawFolderId) : "";
    const works = favoriteWorks(selectedFolderId).map((work) => publicWork(work));
    sendJson(res, 200, {
      count: works.length,
      works,
      folders: publicFavoriteFolders(),
      selectedFolderId: selectedFolderId || "all"
    });
    return true;
  }

  if (url.pathname === "/api/favorite-folders" && req.method === "GET") {
    sendJson(res, 200, { folders: publicFavoriteFolders() });
    return true;
  }

  if (url.pathname === "/api/favorite-folders" && req.method === "POST") {
    const body = await readJsonBody(req);
    try {
      const folder = createFavoriteFolder(body.name);
      saveUserState();
      sendJson(res, 200, { ok: true, folder: { ...folder, count: favoriteFolderCounts().get(folder.id) || 0 }, folders: publicFavoriteFolders(), user: userStateSummary() });
    } catch (error) {
      sendJson(res, error.statusCode || 400, { error: error.message || "创建收藏夹失败" });
    }
    return true;
  }

  if (url.pathname === "/api/history" && req.method === "GET") {
    const rawDays = String(url.searchParams.get("days") || "").trim().toLowerCase();
    const days = rawDays && rawDays !== "all" ? clampInteger(rawDays, 0, 1, 3650) : 0;
    const limit = clampInteger(url.searchParams.get("limit"), 0, 0, MAX_WORK_LIMIT);
    const entries = historyEntries({ days });
    const page = limit ? entries.slice(0, limit) : entries;
    const works = page.map((entry) => publicWork(entry.work));
    sendJson(res, 200, {
      count: works.length,
      total: entries.length,
      days,
      recentWatchedDays: RECENT_WATCHED_DAYS,
      works
    });
    return true;
  }

  if (url.pathname === "/api/works" && req.method === "GET") {
    const filter = url.searchParams.get("filter") || "all";
    const sort = url.searchParams.get("sort") || "updated";
    const filtered = allWorks().filter((work) => workMatchesFilter(work, filter));
    const sorted = sortWorkList(filtered, sort);
    sendJson(res, 200, pagedWorksPayload(sorted, url, { filter, facets: workFacets() }));
    return true;
  }

  if (url.pathname === "/api/search" && req.method === "GET") {
    const rawQuery = (url.searchParams.get("q") || "").trim();
    const query = rawQuery.toLowerCase();
    const filter = url.searchParams.get("filter") || "all";
    const sort = url.searchParams.get("sort") || "updated";
    const peopleSearch = searchPeople(rawQuery);
    const exactPersonIds = new Set(peopleSearch.exact.map((person) => person.id));
    const localMatches = allWorks().filter((work) => {
      return exactPersonIds.has(work.personId) || matchesWorkSearch(work, query);
    });
    const rankingMissingWorks = rankingMissingSearchWorks();
    const rankingMissingKeys = new Set(rankingMissingWorks.map((work) => storedWorkCodeKey(work.infoSummary?.code || work.directoryName || work.title)).filter(Boolean));
    const rankingMissingMatches = rankingMissingWorks.filter((work) => matchesWorkSearch(work, query));
    const actorMissingMatches = actorMissingSearchWorks(rankingMissingKeys).filter((work) => matchesWorkSearch(work, query));
    const matchedWorks = [...localMatches, ...rankingMissingMatches, ...actorMissingMatches];
    const facets = workFacets(matchedWorks);
    const works = sortWorkList(matchedWorks.filter((work) => workMatchesFilter(work, filter)), sort);
    sendJson(res, 200, pagedWorksPayload(works, url, {
      filter,
      q: rawQuery,
      facets,
      people: peopleSearch.people.map(publicPerson)
    }));
    return true;
  }

  const actorProfileMatch = /^\/api\/actor-profiles\/([^/]+)$/.exec(url.pathname);
  if (actorProfileMatch && req.method === "GET") {
    const personId = decodeURIComponent(actorProfileMatch[1]);
    if (!library.peopleById.has(personId)) {
      notFound(res);
      return true;
    }

    sendJson(res, 200, { profile: publicActorProfile(actorProfileRow(personId)) });
    return true;
  }

  if (actorProfileMatch && req.method === "PUT") {
    const personId = decodeURIComponent(actorProfileMatch[1]);
    const person = library.peopleById.get(personId);
    if (!person) {
      notFound(res);
      return true;
    }

    const body = await readJsonBody(req);
    try {
      const profile = upsertActorProfile(person, body);
      sendJson(res, 200, { ok: true, profile });
    } catch (error) {
      sendJson(res, error.statusCode || 400, { error: error.message || "资料页配置失败" });
    }
    return true;
  }

  const favoriteFolderMatch = /^\/api\/favorites\/([^/]+)\/folder$/.exec(url.pathname);
  if (favoriteFolderMatch && req.method === "PUT") {
    const workId = decodeURIComponent(favoriteFolderMatch[1]);
    if (!library.worksById.has(workId)) {
      notFound(res);
      return true;
    }

    const body = await readJsonBody(req);
    try {
      const favorite = moveFavoriteToFolder(workId, body.folderId);
      saveUserState();
      sendJson(res, 200, {
        ok: true,
        workId,
        favorite,
        folders: publicFavoriteFolders(),
        user: userStateSummary()
      });
    } catch (error) {
      sendJson(res, error.statusCode || 400, { error: error.message || "移动收藏夹失败" });
    }
    return true;
  }

  const favoriteMatch = /^\/api\/favorites\/([^/]+)$/.exec(url.pathname);
  if (favoriteMatch && req.method === "POST") {
    const workId = decodeURIComponent(favoriteMatch[1]);
    if (!library.worksById.has(workId)) {
      notFound(res);
      return true;
    }

    if (userState.favorites[workId]) {
      delete userState.favorites[workId];
    } else {
      const body = await readJsonBody(req);
      userState.favorites[workId] = {
        createdAt: new Date().toISOString(),
        folderId: normalizeFavoriteFolderId(body.folderId)
      };
    }

    saveUserState();
    sendJson(res, 200, {
      workId,
      favorite: Boolean(userState.favorites[workId]),
      favoriteFolder: publicFavoriteForWork(workId),
      folders: publicFavoriteFolders(),
      user: userStateSummary()
    });
    return true;
  }

  const progressMatch = /^\/api\/progress\/([^/]+)$/.exec(url.pathname);
  if (progressMatch && req.method === "POST") {
    const videoId = progressMatch[1];
    const file = library.filesById.get(videoId);
    if (!file || file.type !== "video") {
      notFound(res);
      return true;
    }

    const body = await readJsonBody(req);
    const position = Number(body.position || 0);
    const duration = Number(body.duration || body.total || 0);
    const workId = body.workId && library.worksById.has(body.workId) ? body.workId : null;

    if (!Number.isFinite(position) || !Number.isFinite(duration) || duration <= 0) {
      sendJson(res, 400, { error: "播放进度无效" });
      return true;
    }

    userState.progress[videoId] = {
      workId,
      position: Math.max(0, position),
      duration,
      updatedAt: new Date().toISOString()
    };
    saveUserState();
    sendJson(res, 200, { ok: true, progress: getVideoProgress(videoId), user: userStateSummary() });
    return true;
  }

  const personMatch = /^\/api\/people\/([^/]+)$/.exec(url.pathname);
  if (personMatch && req.method === "GET") {
    const person = library.peopleById.get(personMatch[1]);
    if (!person) {
      notFound(res);
      return true;
    }

    const filter = url.searchParams.get("filter") || "all";
    const sort = url.searchParams.get("sort") || "updated";
    const localWorks = person.works
      .map((workId) => library.worksById.get(workId))
      .filter(Boolean);
    const actorRows = actorMovieRows(person.id);
    const missingWorks = missingActorWorksForPerson(person, actorRows);
    const allPersonWorks = [...localWorks, ...missingWorks];
    const works = sortWorkList(allPersonWorks.filter((work) => workMatchesFilter(work, filter)), sort);
    sendJson(res, 200, {
      person: publicPerson(person, {
        actorMovieCount: actorRows.length,
        missingLocalWorkCount: missingWorks.length
      }),
      ...pagedWorksPayload(works, url, { filter, facets: workFacets(allPersonWorks) })
    });
    return true;
  }

  const playInfoMatch = /^\/api\/playinfo\/([^/]+)$/.exec(url.pathname);
  if (playInfoMatch && req.method === "GET") {
    const videoId = decodeURIComponent(playInfoMatch[1]);
    const file = library.filesById.get(videoId);
    if (!file || file.type !== "video") {
      notFound(res);
      return true;
    }

    sendJson(res, 200, playInfoForFile(file));
    return true;
  }

  const coverGenerateMatch = /^\/api\/works\/([^/]+)\/cover\/generate$/.exec(url.pathname);
  if (coverGenerateMatch && req.method === "POST") {
    const work = library.worksById.get(decodeURIComponent(coverGenerateMatch[1]));
    if (!work) {
      notFound(res);
      return true;
    }
    try {
      const cover = generateWorkCover(work);
      sendJson(res, 200, { ok: true, cover, work: publicWork(work, true) });
    } catch (error) {
      sendJson(res, error.statusCode || 500, { error: error.message || "生成封面失败", work: publicWork(work, true) });
    }
    return true;
  }

  const workMatch = /^\/api\/works\/([^/]+)$/.exec(url.pathname);
  if (workMatch && req.method === "GET") {
    const work = library.worksById.get(decodeURIComponent(workMatch[1]));
    if (!work) {
      notFound(res);
      return true;
    }

    const person = library.peopleById.get(work.personId);
    sendJson(res, 200, { work: publicWork(work, true), person: person ? publicPerson(person) : null });
    return true;
  }

  const infoMatch = /^\/api\/info\/([^/]+)$/.exec(url.pathname);
  if (infoMatch && req.method === "GET") {
    const file = library.filesById.get(infoMatch[1]);
    if (!file || file.type !== "info") {
      notFound(res);
      return true;
    }

    serveInfo(res, file);
    return true;
  }

  return false;
}

function routeMedia(req, res, url) {
  const actorAvatarMatch = /^\/media\/actor\/([^/]+)\/avatar$/.exec(url.pathname);
  if (actorAvatarMatch && req.method === "GET") {
    serveActorAvatar(res, decodeURIComponent(actorAvatarMatch[1]));
    return true;
  }

  const workCoverMatch = /^\/media\/work\/([^/]+)\/cover$/.exec(url.pathname);
  if (workCoverMatch && req.method === "GET") {
    serveWorkCover(res, decodeURIComponent(workCoverMatch[1]));
    return true;
  }

  const imageMatch = /^\/media\/image\/([^/]+)$/.exec(url.pathname);
  if (imageMatch && req.method === "GET") {
    const file = library.filesById.get(imageMatch[1]);
    if (!file || file.type !== "image") {
      notFound(res);
      return true;
    }

    serveImage(res, file);
    return true;
  }

  const transcodeMatch = /^\/media\/video\/([^/]+)\/transcode$/.exec(url.pathname);
  if (transcodeMatch && req.method === "GET") {
    const file = library.filesById.get(decodeURIComponent(transcodeMatch[1]));
    if (!file || file.type !== "video") {
      notFound(res);
      return true;
    }

    serveTranscodedVideo(req, res, file, url);
    return true;
  }

  const videoMatch = /^\/media\/video\/([^/]+)$/.exec(url.pathname);
  if (videoMatch && req.method === "GET") {
    const file = library.filesById.get(decodeURIComponent(videoMatch[1]));
    if (!file || file.type !== "video") {
      notFound(res);
      return true;
    }

    serveVideo(req, res, file);
    return true;
  }

  return false;
}

async function requestHandler(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,HEAD,POST,PUT,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type,Accept,Range");
  res.setHeader("Access-Control-Expose-Headers", "Content-Length,Content-Range,Accept-Ranges");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  try {
    if (await routeApi(req, res, url)) return;
    if (routeMedia(req, res, url)) return;

    if (req.method !== "GET" && req.method !== "HEAD") {
      sendText(res, 405, "Method not allowed");
      return;
    }

    serveStatic(req, res, url.pathname);
  } catch (error) {
    console.error("[request]", error);
    sendJson(res, 500, { error: error.message || "Internal server error" });
  }
}

function getLanAddresses() {
  const addresses = [];
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries || []) {
      if (entry.family === "IPv4" && !entry.internal) {
        addresses.push(entry.address);
      }
    }
  }
  return addresses;
}

loadUserState();
loadAppConfig();
const cachedLibrary = loadLibraryCache();
if (cachedLibrary) {
  library = cachedLibrary;
  console.log(
    `[cache] ${library.totals.people} people, ${library.totals.works} works, ${library.totals.videos} videos, ${library.totals.images} images`
  );
} else {
  refreshLibrary();
}

const server = http.createServer(requestHandler);
server.listen(PORT, HOST, () => {
  console.log(`Local:   http://127.0.0.1:${PORT}`);
  for (const address of getLanAddresses()) {
    console.log(`LAN:     http://${address}:${PORT}`);
  }
  console.log(`Library: ${library.availableRoots.join("; ")}`);
  if (library.missingRoots.length) {
    console.log(`Missing: ${library.missingRoots.join("; ")}`);
  }
});
