import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { DEFAULT_MAX_COVER_BYTES, extractCoverFrame } from "./lib/cover-frame.js";
import { ADMIN_SCRIPT_DEFINITIONS } from "./lib/admin-script-registry.js";
import { normalizeWorkCode as parseNormalizedWorkCode, workCodeKey } from "./lib/code-parser.js";
import { decodeInfoBuffer, isSubtitleLikeInfoText, parseInfoMetadata, renderInfoMetadataText } from "./lib/info-metadata.js";
import { createAuthServices } from "./src/server/auth.js";
import { sendJson, sendText, sendHtml, redirect, notFound } from "./src/server/responses.js";
import { createStaticFileServer } from "./src/server/static-files.js";
import { routeAdminApi } from "./src/server/routes/admin-api.js";
import { routeGalleryApi } from "./src/server/routes/gallery-api.js";
import { routeToolsApi } from "./src/server/routes/tools-api.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT || 29998);
const HOST = process.env.HOST || "0.0.0.0";
const LIBRARY_ROOTS = parseLibraryRoots();
const PUBLIC_DIR = path.join(__dirname, "public");
const DATA_DIR = path.join(__dirname, "data");
const LOG_DIR = path.join(__dirname, "logs");
const MANGA_LIBRARY_ROOT = process.env.FANHAO_MANGA_ROOT || "E:\\https-smtt6-com-man-hua-yue";
const PHOTO_SET_ROOTS = parsePhotoSetRoots();
const GALLERY_MEDIA_SOURCES = galleryMediaSources();
const INDEX_CACHE_PATH = path.join(DATA_DIR, "library-index.json");
const IMAGE_LIBRARY_INDEX_PATH = path.join(DATA_DIR, "image-library-index.json");
const USER_STATE_PATH = path.join(DATA_DIR, "user-state.json");
const ACTOR_PROFILE_DB_PATH = path.join(DATA_DIR, "actor-profiles.sqlite");
const IMAGE_GALLERY_DB_PATH = path.join(DATA_DIR, "image-gallery.sqlite");
const APP_CONFIG_PATH = path.join(DATA_DIR, "app-config.json");
const AUTH_SECRET_PATH = path.join(DATA_DIR, "auth-secret.txt");
const ACCESS_LOG_PATH = path.join(LOG_DIR, "access.log");
const ADMIN_TASKS_PATH = path.join(DATA_DIR, "admin-tasks.json");
const TOOL_DOWNLOAD_DIR = path.join(DATA_DIR, "tool-downloads");
const IMAGE_READER_CACHE_DIR = path.join(DATA_DIR, "image-reader-cache");
const FFMPEG_PATH = process.env.FFMPEG_PATH || "ffmpeg";
const FFPROBE_PATH = process.env.FFPROBE_PATH || "ffprobe";
const REMOTE_WEB_PASSWORD = process.env.FANHAO_WEB_PASSWORD || "xincheng";

const EXCLUDED_DIRS = new Set(["$RECYCLE.BIN", "System Volume Information", "Recovery"]);
const VIDEO_EXTS = new Set([".mp4", ".mkv", ".avi", ".mov", ".wmv", ".flv", ".m4v", ".ts", ".m2ts", ".webm", ".iso"]);
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
const DEFAULT_IMAGE_READER_CACHE_MAX_BYTES = 2 * 1024 * 1024 * 1024;
const MIN_IMAGE_READER_CACHE_MAX_BYTES = 128 * 1024 * 1024;
const MAX_IMAGE_READER_CACHE_MAX_BYTES = 200 * 1024 * 1024 * 1024;
const IMAGE_READER_CACHE_CLEANUP_INTERVAL_MS = 10 * 60 * 1000;
const IMAGE_READER_CACHE_CLEANUP_TARGET_RATIO = 0.9;
const IMAGE_READER_CACHE_TOUCH_THROTTLE_MS = 30 * 1000;
const IMAGE_READER_LIST_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const ARCHIVE_IMAGE_EXTS = new Set([".jpg", ".jpeg", ".png", ".webp", ".bmp", ".gif"]);
const ARCHIVE_EXTS = new Set([".zip", ".cbz", ".rar", ".7z"]);
const IMAGE_GALLERY_COVER_MAX_BYTES = 1024 * 1024;
const IMAGE_GALLERY_COVER_BOX_SIZE = 640;
const DEFAULT_APP_CONFIG = {
  compilationPrefixes: ["OFJE", "THN", "THU"],
  compilationKeywords: ["合集", "総集編", "総集", "コンプリート", "全タイトル", "ベスト盤"],
  actorAvatarDataPath: "",
  imageReaderCacheMaxBytes: DEFAULT_IMAGE_READER_CACHE_MAX_BYTES
};
const LOCAL_ACTOR_AVATAR_SOURCE = "local-avatar";
const MAX_ACTOR_AVATAR_BYTES = 8 * 1024 * 1024;
const MAX_REMOTE_IMAGE_BYTES = 8 * 1024 * 1024;
const ACTOR_AVATAR_EXTS = new Set([".jpg", ".jpeg", ".png", ".webp"]);
const DEFAULT_FAVORITE_FOLDER_ID = "default";
const DEFAULT_FAVORITE_FOLDER_NAME = "默认收藏";
const MAX_FAVORITE_FOLDERS = 30;
const RECENT_WATCHED_DAYS = 30;
const ADMIN_TASK_HISTORY_LIMIT = 100;
const TOOL_DOWNLOAD_TTL_MS = 10 * 60 * 1000;
const TXT_TOOL_MAX_FILE_BYTES = 24 * 1024 * 1024;
const TXT_TOOL_MAX_BODY_BYTES = Math.ceil(TXT_TOOL_MAX_FILE_BYTES * 1.4) + 128 * 1024;
const TXT_TOOL_PREVIEW_BYTES = 256 * 1024;

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
  ".m2ts": "video/mp2t",
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

const { serveStatic } = createStaticFileServer({
  publicDir: PUBLIC_DIR,
  mimeTypes: MIME_TYPES,
  normalizeExt,
  notFound
});

let library = emptyLibrary();
let lastScanError = null;
let userState = emptyUserState();
let appConfig = defaultAppConfig();
let actorDb = null;
let imageGalleryDb = null;
let workInfoCache = null;
let actorProfileCache = null;
let actorMovieCache = null;
let localWorkCodeKeyCache = null;
let localWorkByCodeKeyCache = null;
let rankingMissingSearchCache = null;
let actorMissingSearchCache = null;
let workSearchTextCache = null;
let tableStampCache = new Map();
let adminTaskSeq = 0;
const adminTasks = loadAdminTaskHistory();
let adminTaskPersistTimer = null;
const toolDownloads = new Map();
const toolDownloadTimers = new Map();
const imageReaderCacheTouchTimes = new Map();
const archiveImageListCache = new Map();
let imageLibraryCache = null;
let imageReaderCacheCleanupPending = false;
let imageReaderCacheCleanupActive = false;
const remoteImageWarmQueue = [];
const remoteImageWarmQueued = new Set();
let remoteImageWarmActive = 0;
const REMOTE_IMAGE_WARM_CONCURRENCY = 6;
const TABLE_STAMP_CACHE_MS = 1000;

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
    compilationKeywords: [...DEFAULT_APP_CONFIG.compilationKeywords],
    actorAvatarDataPath: DEFAULT_APP_CONFIG.actorAvatarDataPath,
    imageReaderCacheMaxBytes: DEFAULT_APP_CONFIG.imageReaderCacheMaxBytes
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
    actorAvatarDataPath: String(input.actorAvatarDataPath || "").trim().slice(0, 1000),
    imageReaderCacheMaxBytes: normalizeImageReaderCacheLimit(
      input.imageReaderCacheMaxBytes ?? input.mangaImageCacheMaxBytes,
      fallback.imageReaderCacheMaxBytes
    )
  };
}

function normalizeImageReaderCacheLimit(value, fallback = DEFAULT_IMAGE_READER_CACHE_MAX_BYTES) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  if (parsed <= 0) return 0;
  return Math.min(MAX_IMAGE_READER_CACHE_MAX_BYTES, Math.max(MIN_IMAGE_READER_CACHE_MAX_BYTES, Math.floor(parsed)));
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
    actorAvatarDataPath: appConfig.actorAvatarDataPath || "",
    imageReaderCacheMaxBytes: normalizeImageReaderCacheLimit(appConfig.imageReaderCacheMaxBytes)
  };
}

function ensureLogDir() {
  fs.mkdirSync(LOG_DIR, { recursive: true });
}

const {
  applyAppCookie,
  attachAccessLogger,
  isSameLocalOrigin,
  requestAccess,
  requestAuthState,
  routeAuth,
  sendLoginRequired
} = createAuthServices({
  authSecretPath: AUTH_SECRET_PATH,
  accessLogPath: ACCESS_LOG_PATH,
  remoteWebPassword: REMOTE_WEB_PASSWORD,
  ensureDataDir,
  ensureLogDir,
  readBodyText,
  sendJson,
  sendHtml,
  redirect
});

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

function parseRootList(rawValue, fallback) {
  const raw = rawValue || fallback;
  const seen = new Set();
  return raw
    .split(/[;,|]/)
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => {
      const parsed = path.parse(item);
      return parsed.root && parsed.root.toLowerCase() === item.toLowerCase() ? parsed.root : path.resolve(item);
    })
    .filter((item) => {
      const key = item.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

function parsePhotoSetRoots() {
  return parseRootList(process.env.FANHAO_PHOTO_SET_ROOTS, "T:\\;T:\\[套图1]");
}

function galleryMediaSources() {
  return [
    { kind: "western", label: "欧美", roots: parseRootList(process.env.FANHAO_WESTERN_ROOTS, "R:\\") },
    { kind: "movie", label: "电影", roots: parseRootList(process.env.FANHAO_MOVIE_ROOTS, "Z:\\") },
    { kind: "tv", label: "电视剧", roots: parseRootList(process.env.FANHAO_TV_ROOTS, "Y:\\") }
  ];
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
    invalidateTableStamp("actor_profiles");
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
  if (imported) invalidateTableStamp("actor_profiles");
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
    actorDb.exec("PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL;");
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
      CREATE INDEX IF NOT EXISTS idx_actor_profiles_updated_at ON actor_profiles(updated_at);
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
      CREATE INDEX IF NOT EXISTS idx_work_info_updated_at ON work_info(updated_at);
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
      CREATE INDEX IF NOT EXISTS idx_actor_movies_updated_at ON actor_movies(updated_at);
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
      CREATE INDEX IF NOT EXISTS idx_javdb_rankings_updated_at ON javdb_rankings(updated_at);
      CREATE TABLE IF NOT EXISTS remote_image_cache (
        url TEXT PRIMARY KEY,
        url_hash TEXT NOT NULL,
        content_type TEXT,
        image_blob BLOB,
        byte_length INTEGER,
        status TEXT NOT NULL DEFAULT 'ok',
        error TEXT,
        fetched_at TEXT,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_remote_image_cache_hash ON remote_image_cache(url_hash);
      CREATE INDEX IF NOT EXISTS idx_remote_image_cache_status ON remote_image_cache(status);
      CREATE TABLE IF NOT EXISTS local_image_cache (
        file_id TEXT PRIMARY KEY,
        file_path TEXT NOT NULL,
        relative_path TEXT,
        content_type TEXT,
        image_blob BLOB,
        byte_length INTEGER,
        source_size INTEGER,
        source_mtime TEXT,
        status TEXT NOT NULL DEFAULT 'ok',
        error TEXT,
        cached_at TEXT,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_local_image_cache_path ON local_image_cache(file_path);
      CREATE INDEX IF NOT EXISTS idx_local_image_cache_status ON local_image_cache(status);
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
    ensureColumn(actorDb, "remote_image_cache", "url_hash", "TEXT");
    ensureColumn(actorDb, "remote_image_cache", "content_type", "TEXT");
    ensureColumn(actorDb, "remote_image_cache", "image_blob", "BLOB");
    ensureColumn(actorDb, "remote_image_cache", "byte_length", "INTEGER");
    ensureColumn(actorDb, "remote_image_cache", "status", "TEXT NOT NULL DEFAULT 'ok'");
    ensureColumn(actorDb, "remote_image_cache", "error", "TEXT");
    ensureColumn(actorDb, "remote_image_cache", "fetched_at", "TEXT");
    ensureColumn(actorDb, "remote_image_cache", "updated_at", "TEXT");
    ensureColumn(actorDb, "local_image_cache", "file_path", "TEXT");
    ensureColumn(actorDb, "local_image_cache", "relative_path", "TEXT");
    ensureColumn(actorDb, "local_image_cache", "content_type", "TEXT");
    ensureColumn(actorDb, "local_image_cache", "image_blob", "BLOB");
    ensureColumn(actorDb, "local_image_cache", "byte_length", "INTEGER");
    ensureColumn(actorDb, "local_image_cache", "source_size", "INTEGER");
    ensureColumn(actorDb, "local_image_cache", "source_mtime", "TEXT");
    ensureColumn(actorDb, "local_image_cache", "status", "TEXT NOT NULL DEFAULT 'ok'");
    ensureColumn(actorDb, "local_image_cache", "error", "TEXT");
    ensureColumn(actorDb, "local_image_cache", "cached_at", "TEXT");
    ensureColumn(actorDb, "local_image_cache", "updated_at", "TEXT");
    actorDb.exec("CREATE INDEX IF NOT EXISTS idx_work_info_javdb_url ON work_info(javdb_url)");
  }
  return actorDb;
}

function getImageGalleryDb() {
  if (!imageGalleryDb) {
    ensureDataDir();
    imageGalleryDb = new DatabaseSync(IMAGE_GALLERY_DB_PATH);
    imageGalleryDb.exec("PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL;");
    imageGalleryDb.exec(`
      CREATE TABLE IF NOT EXISTS photo_set_covers (
        album_id TEXT PRIMARY KEY,
        archive_path TEXT NOT NULL,
        archive_size INTEGER,
        archive_mtime_ms INTEGER,
        member_path TEXT,
        cover_mime TEXT,
        cover_blob BLOB,
        cover_bytes INTEGER,
        source_bytes INTEGER,
        status TEXT NOT NULL DEFAULT 'ok',
        error TEXT,
        generated_at TEXT,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_photo_set_covers_archive_path ON photo_set_covers(archive_path);
      CREATE INDEX IF NOT EXISTS idx_photo_set_covers_status ON photo_set_covers(status);
      CREATE INDEX IF NOT EXISTS idx_photo_set_covers_updated_at ON photo_set_covers(updated_at);
    `);
    ensureColumn(imageGalleryDb, "photo_set_covers", "archive_size", "INTEGER");
    ensureColumn(imageGalleryDb, "photo_set_covers", "archive_mtime_ms", "INTEGER");
    ensureColumn(imageGalleryDb, "photo_set_covers", "member_path", "TEXT");
    ensureColumn(imageGalleryDb, "photo_set_covers", "cover_mime", "TEXT");
    ensureColumn(imageGalleryDb, "photo_set_covers", "cover_blob", "BLOB");
    ensureColumn(imageGalleryDb, "photo_set_covers", "cover_bytes", "INTEGER");
    ensureColumn(imageGalleryDb, "photo_set_covers", "source_bytes", "INTEGER");
    ensureColumn(imageGalleryDb, "photo_set_covers", "status", "TEXT NOT NULL DEFAULT 'ok'");
    ensureColumn(imageGalleryDb, "photo_set_covers", "error", "TEXT");
    ensureColumn(imageGalleryDb, "photo_set_covers", "generated_at", "TEXT");
    ensureColumn(imageGalleryDb, "photo_set_covers", "updated_at", "TEXT");
  }
  return imageGalleryDb;
}

function ensureColumn(db, table, column, definition) {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!rows.some((row) => row.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

function actorProfileRowsById() {
  const stamp = actorProfileStamp();
  if (actorProfileCache?.stamp === stamp) return actorProfileCache.rows;

  const rows = new Map();
  try {
    const db = getActorDb();
    for (const row of db.prepare("SELECT * FROM actor_profiles").all()) {
      rows.set(row.person_id, row);
    }
  } catch (error) {
    console.warn("[actor-db]", error.message);
    if (actorProfileCache?.rows) return actorProfileCache.rows;
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

function invalidateTableStamp(...tables) {
  if (!tables.length) {
    tableStampCache = new Map();
    return;
  }
  for (const table of tables) tableStampCache.delete(table);
}

function tableDataStamp(table) {
  const now = Date.now();
  const cached = tableStampCache.get(table);
  if (cached && now - cached.checkedAt < TABLE_STAMP_CACHE_MS) return cached.stamp;

  try {
    const row = getActorDb()
      .prepare(`SELECT COUNT(*) AS count, COALESCE(MAX(updated_at), '') AS updated_at FROM ${table}`)
      .get();
    const stamp = `${Number(row?.count || 0)}:${row?.updated_at || ""}`;
    tableStampCache.set(table, { checkedAt: now, stamp });
    return stamp;
  } catch (error) {
    console.warn("[actor-db-stamp]", table, error.message);
    if (cached?.stamp) {
      tableStampCache.set(table, { checkedAt: now, stamp: cached.stamp });
      return cached.stamp;
    }
    const fallback = `${table}:unavailable`;
    tableStampCache.set(table, { checkedAt: now, stamp: fallback });
    return fallback;
  }
}

function actorProfileStamp() {
  return tableDataStamp("actor_profiles");
}

function workInfoStamp() {
  return tableDataStamp("work_info");
}

function actorMovieStamp() {
  return tableDataStamp("actor_movies");
}

function rankingStamp() {
  return tableDataStamp("javdb_rankings");
}

function searchSourceStamp() {
  return `${library.scannedAt || ""}:${workInfoStamp()}:${actorMovieStamp()}:${rankingStamp()}`;
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
    if (workInfoCache?.rows) return workInfoCache.rows;
  }

  workInfoCache = { stamp, rows };
  return rows;
}

function workInfoRow(workId) {
  return workInfoRowsById().get(workId) || null;
}

function actorMovieRowsByPerson() {
  const stamp = actorMovieStamp();
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
    if (actorMovieCache?.rows) return actorMovieCache.rows;
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
    remoteCoverUrl: proxiedRemoteImageUrl(row.image_url),
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
  prewarmRemoteImagesForWorks(page);
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
    remoteCoverUrl: proxiedRemoteImageUrl(row.image_url),
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

function isAllowedRemoteImageUrl(parsed) {
  const hostname = String(parsed.hostname || "").toLowerCase();
  return (
    (parsed.protocol === "https:" || parsed.protocol === "http:") &&
    (hostname === "jdbstatic.com" ||
      hostname.endsWith(".jdbstatic.com") ||
      hostname === "javdb.com" ||
      hostname.endsWith(".javdb.com"))
  );
}

function proxiedRemoteImageUrl(value) {
  const remoteUrl = publicRemoteUrl(value);
  if (!remoteUrl) return "";
  try {
    const parsed = new URL(remoteUrl);
    if (!isAllowedRemoteImageUrl(parsed)) return remoteUrl;
    return `/media/remote-image?url=${encodeURIComponent(remoteUrl)}`;
  } catch {
    return "";
  }
}

function remoteImageTargetUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";

  try {
    if (raw.startsWith("/media/remote-image")) {
      const parsed = new URL(raw, "http://localhost");
      const target = publicRemoteUrl(parsed.searchParams.get("url"));
      return target && isAllowedRemoteImageUrl(new URL(target)) ? target : "";
    }

    const target = publicRemoteUrl(raw);
    return target && isAllowedRemoteImageUrl(new URL(target)) ? target : "";
  } catch {
    return "";
  }
}

function prewarmRemoteImagesForWorks(works, limit = 1000) {
  const seen = new Set();
  let count = 0;
  for (const work of works || []) {
    const previewImages = [
      ...(Array.isArray(work.infoSummary?.previewImages) ? work.infoSummary.previewImages : []),
      ...(Array.isArray(work.infoMetadata?.previewImages) ? work.infoMetadata.previewImages : [])
    ].slice(0, 12);
    const candidates = [
      ...(!work.coverId && !work.cachedCover?.coverUrl ? [work.remoteCoverUrl, work.infoSummary?.imageUrl, work.infoMetadata?.imageUrl] : []),
      ...previewImages
    ];
    for (const candidate of candidates) {
      const remoteUrl = remoteImageTargetUrl(candidate);
      if (!remoteUrl || seen.has(remoteUrl)) continue;
      seen.add(remoteUrl);
      enqueueRemoteImageWarm(remoteUrl);
      count += 1;
      if (count >= limit) return count;
    }
  }
  return count;
}

function proxiedRemoteImageUrlArray(values) {
  const urls = [];
  const seen = new Set();
  for (const value of Array.isArray(values) ? values : []) {
    const targetUrl = remoteImageTargetUrl(value);
    const url = targetUrl ? proxiedRemoteImageUrl(targetUrl) : proxiedRemoteImageUrl(value);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    urls.push(url);
  }
  return urls;
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
  const previewImages = proxiedRemoteImageUrlArray(parseJsonArray(row?.preview_images_json));
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
    imageUrl: proxiedRemoteImageUrl(firstPresentValue(row?.image_url, fallback?.imageUrl)),
    previewImages: previewImages.length ? previewImages : proxiedRemoteImageUrlArray(fallback?.previewImages),
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
    imageUrl: proxiedRemoteImageUrl(row.image_url),
    previewImages: proxiedRemoteImageUrlArray(parseJsonArray(row.preview_images_json)),
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
  invalidateTableStamp("actor_profiles", "actor_movies");
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
  invalidateTableStamp();
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

function adminScriptById(scriptId) {
  return ADMIN_SCRIPT_DEFINITIONS.find((script) => script.id === scriptId) || null;
}

function publicAdminScriptField(field) {
  return {
    name: field.name,
    label: field.label,
    type: field.type,
    flag: field.flag || "",
    positional: Boolean(field.positional),
    default: field.default ?? "",
    placeholder: field.placeholder || "",
    help: field.help || "",
    required: Boolean(field.required),
    min: field.min ?? null,
    max: field.max ?? null,
    step: field.step ?? null,
    options: Array.isArray(field.options) ? field.options.map((option) => ({ ...option })) : []
  };
}

function adminScriptRisk(script) {
  if (script.risk) return script.risk;
  const category = script.category || "";
  if (category === "验证" || category === "报表") return "safe";
  if (category === "维护" || /清理|覆盖|删除/.test(`${script.title} ${script.description}`)) return "danger";
  if ((script.fields || []).some((field) => field.flag === "--write" && field.default === false)) return "danger";
  if ((script.fields || []).some((field) => field.flag === "--overwrite" || field.flag === "--force" || field.flag === "--delete-zero-byte")) return "careful";
  if ((script.invalidates || []).length) return "write";
  return "normal";
}

function adminScriptRiskLabel(risk) {
  return {
    safe: "安全",
    normal: "常规",
    write: "写入",
    careful: "谨慎",
    danger: "高风险"
  }[risk] || "常规";
}

function publicAdminScript(script) {
  const risk = adminScriptRisk(script);
  return {
    id: script.id,
    title: script.title,
    category: script.category,
    description: script.description,
    runtime: script.runtime,
    script: script.script,
    risk,
    riskLabel: adminScriptRiskLabel(risk),
    invalidates: [...(script.invalidates || [])],
    refreshHints: [...(script.refreshHints || [])],
    fields: (script.fields || []).map(publicAdminScriptField)
  };
}

function adminScriptCategories() {
  return [...new Set(ADMIN_SCRIPT_DEFINITIONS.map((script) => script.category || "其他"))];
}

function normalizeAdminListValue(value) {
  const rawItems = Array.isArray(value)
    ? value
    : String(value || "")
        .split(/\r?\n|,/)
        .map((item) => item.trim());
  const seen = new Set();
  const result = [];
  for (const item of rawItems) {
    const text = String(item || "").trim();
    if (!text || text.length > 1000 || seen.has(text)) continue;
    seen.add(text);
    result.push(text);
    if (result.length >= 100) break;
  }
  return result;
}

function normalizeAdminNumberValue(value, field) {
  if (value === null || value === undefined || String(value).trim() === "") {
    return field.default === "" || field.default === undefined ? "" : field.default;
  }
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return field.default === "" || field.default === undefined ? "" : field.default;
  }
  const min = Number.isFinite(Number(field.min)) ? Number(field.min) : Number.MIN_SAFE_INTEGER;
  const max = Number.isFinite(Number(field.max)) ? Number(field.max) : Number.MAX_SAFE_INTEGER;
  const clamped = Math.max(min, Math.min(max, number));
  return Number(field.step) && Number(field.step) < 1 ? clamped : Math.floor(clamped);
}

function normalizeAdminScriptFieldValue(field, input) {
  const value = input[field.name] ?? field.default ?? "";
  if (field.type === "checkbox") return Boolean(value);
  if (field.type === "number") return normalizeAdminNumberValue(value, field);
  if (field.type === "textarea-list") return normalizeAdminListValue(value);
  if (field.type === "select") {
    const allowed = (field.options || []).map((option) => option.value);
    const selected = String(value || field.default || "");
    return allowed.includes(selected) ? selected : allowed[0] || "";
  }
  if (field.type === "person") {
    const personId = String(value || "").trim();
    if (!personId) {
      if (field.required) {
        const error = new Error(`${field.label || "人物"}不能为空`);
        error.statusCode = 400;
        throw error;
      }
      return "";
    }
    if (!library.peopleById.has(personId)) {
      const error = new Error("选择的人物不存在");
      error.statusCode = 400;
      throw error;
    }
    return personId;
  }
  const text = String(value || "").trim().slice(0, field.maxLength || 4000);
  if (field.required && !text) {
    const error = new Error(`${field.label || field.name}不能为空`);
    error.statusCode = 400;
    throw error;
  }
  return text;
}

function normalizeAdminScriptOptions(script, input = {}) {
  const options = {};
  for (const field of script.fields || []) {
    options[field.name] = normalizeAdminScriptFieldValue(field, input);
  }
  return options;
}

function appendAdminScriptFieldArgs(args, field, value) {
  if (field.type === "checkbox") {
    if (value && field.flag) args.push(field.flag);
    return;
  }
  if (field.type === "textarea-list") {
    for (const item of Array.isArray(value) ? value : []) {
      if (field.flag) args.push(field.flag, item);
      else args.push(item);
    }
    return;
  }
  if (value === "" || value === null || value === undefined) return;
  if (field.positional) {
    args.push(String(value));
    return;
  }
  if (field.flag) args.push(field.flag, String(value));
}

function buildAdminScriptCommand(script, options) {
  const args = [];
  if (script.runtime === "python") {
    args.push("-u", script.script);
  } else if (script.runtime === "node") {
    args.push(script.script);
  } else {
    const error = new Error(`不支持的脚本运行时：${script.runtime}`);
    error.statusCode = 400;
    throw error;
  }

  for (const field of script.fields || []) {
    appendAdminScriptFieldArgs(args, field, options[field.name]);
  }

  return {
    command: script.runtime === "python" ? "python" : process.execPath,
    args
  };
}

function quoteCommandPart(value) {
  const text = String(value || "");
  return /\s/.test(text) ? `"${text.replace(/"/g, '\\"')}"` : text;
}

function commandPreview(command, args) {
  return [command, ...args].map(quoteCommandPart).join(" ");
}

function applyAdminTaskInvalidations(task) {
  const script = task.scriptId ? adminScriptById(task.scriptId) : null;
  const invalidates = new Set(script?.invalidates || task.invalidates || []);
  if (invalidates.has("actorProfiles")) {
    invalidateTableStamp("actor_profiles");
    actorProfileCache = null;
  }
  if (invalidates.has("actorMovies")) {
    invalidateTableStamp("actor_movies");
    actorMovieCache = null;
    localWorkCodeKeyCache = null;
    localWorkByCodeKeyCache = null;
    clearSearchSourceCaches();
  }
  if (invalidates.has("workInfo")) {
    invalidateTableStamp("work_info");
    workInfoCache = null;
    clearSearchSourceCaches();
  }
  if (invalidates.has("workCovers")) {
    invalidateTableStamp("work_covers");
    workInfoCache = null;
    clearSearchSourceCaches();
  }
  if (invalidates.has("rankings")) {
    invalidateTableStamp("javdb_rankings");
    rankingMissingSearchCache = null;
    localWorkCodeKeyCache = null;
    localWorkByCodeKeyCache = null;
    clearSearchSourceCaches();
  }
  if (invalidates.has("localImages")) invalidateTableStamp("local_image_cache");
  if (invalidates.has("remoteImages")) invalidateTableStamp("remote_image_cache");
  if (invalidates.has("userState")) loadUserState();
}

function normalizeAdminTaskStatus(status) {
  return ["running", "stopping", "stopped", "done", "error"].includes(status) ? status : "error";
}

function adminTaskDurationMs(task) {
  const started = Date.parse(task.startedAt || "");
  const ended = Date.parse(task.finishedAt || "") || Date.now();
  if (!Number.isFinite(started)) return null;
  return Math.max(0, ended - started);
}

function persistedAdminTask(task) {
  return {
    id: String(task.id || ""),
    type: String(task.type || ""),
    scriptId: String(task.scriptId || ""),
    label: String(task.label || "任务"),
    personId: String(task.personId || ""),
    personName: String(task.personName || ""),
    status: normalizeAdminTaskStatus(task.status),
    exitCode: task.exitCode ?? null,
    pid: task.pid || null,
    refreshHints: Array.isArray(task.refreshHints) ? task.refreshHints.slice(0, 20) : [],
    invalidates: Array.isArray(task.invalidates) ? task.invalidates.slice(0, 20) : [],
    startedAt: String(task.startedAt || ""),
    finishedAt: String(task.finishedAt || ""),
    logs: Array.isArray(task.logs) ? task.logs.slice(-400).map((line) => String(line).slice(0, 4000)) : []
  };
}

function loadAdminTaskHistory() {
  try {
    ensureDataDir();
    if (!fs.existsSync(ADMIN_TASKS_PATH)) return [];
    const parsed = JSON.parse(fs.readFileSync(ADMIN_TASKS_PATH, "utf8"));
    const rawTasks = Array.isArray(parsed?.tasks) ? parsed.tasks : Array.isArray(parsed) ? parsed : [];
    const now = new Date().toISOString();
    const tasks = [];
    let maxSeq = 0;
    for (const rawTask of rawTasks.slice(0, ADMIN_TASK_HISTORY_LIMIT)) {
      const task = persistedAdminTask(rawTask);
      if (!task.id) continue;
      const seq = Number(String(task.id).replace(/^task_/, ""));
      if (Number.isFinite(seq)) maxSeq = Math.max(maxSeq, seq);
      if (task.status === "running" || task.status === "stopping") {
        task.status = "stopped";
        task.finishedAt = task.finishedAt || now;
        task.logs.push("服务重启，未完成任务已标记为中断");
      }
      tasks.push(task);
    }
    adminTaskSeq = maxSeq;
    return tasks;
  } catch (error) {
    console.warn("[admin] 读取任务历史失败：", error.message);
    return [];
  }
}

function persistAdminTaskHistory() {
  try {
    ensureDataDir();
    const payload = {
      version: 1,
      updatedAt: new Date().toISOString(),
      tasks: adminTasks.slice(0, ADMIN_TASK_HISTORY_LIMIT).map(persistedAdminTask)
    };
    const tempPath = `${ADMIN_TASKS_PATH}.tmp`;
    fs.writeFileSync(tempPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    fs.renameSync(tempPath, ADMIN_TASKS_PATH);
  } catch (error) {
    console.warn("[admin] 保存任务历史失败：", error.message);
  }
}

function scheduleAdminTaskPersist() {
  if (adminTaskPersistTimer) return;
  adminTaskPersistTimer = setTimeout(() => {
    adminTaskPersistTimer = null;
    persistAdminTaskHistory();
  }, 250);
}

function adminTaskSummary() {
  const summary = { total: adminTasks.length, running: 0, stopping: 0, done: 0, error: 0, stopped: 0 };
  for (const task of adminTasks) {
    const status = normalizeAdminTaskStatus(task.status);
    summary[status] = (summary[status] || 0) + 1;
  }
  return summary;
}

function publicAdminTask(task) {
  return {
    id: task.id,
    type: task.type,
    scriptId: task.scriptId || "",
    label: task.label,
    personId: task.personId || "",
    personName: task.personName || "",
    status: task.status,
    exitCode: task.exitCode ?? null,
    pid: task.pid || null,
    canStop: Boolean(task.child && (task.status === "running" || task.status === "stopping")),
    refreshHints: [...(task.refreshHints || [])],
    startedAt: task.startedAt,
    finishedAt: task.finishedAt || "",
    durationMs: adminTaskDurationMs(task),
    logs: task.logs.slice(-120)
  };
}

function pushAdminLog(task, chunk) {
  const lines = String(chunk || "").split(/\r?\n/).filter(Boolean);
  for (const line of lines) {
    task.logs.push(line);
  }
  if (task.logs.length > 400) task.logs.splice(0, task.logs.length - 400);
  scheduleAdminTaskPersist();
}

function startAdminProcessTask({ type, label, person, command, args, scriptId = "", refreshHints = [], invalidates = [], onDone }) {
  const task = {
    id: `task_${++adminTaskSeq}`,
    type,
    scriptId,
    label,
    personId: person?.id || "",
    personName: person?.name || "",
    status: "running",
    exitCode: null,
    pid: null,
    child: null,
    stopRequested: false,
    refreshHints,
    invalidates,
    startedAt: new Date().toISOString(),
    finishedAt: "",
    logs: []
  };
  adminTasks.unshift(task);
  if (adminTasks.length > ADMIN_TASK_HISTORY_LIMIT) adminTasks.length = ADMIN_TASK_HISTORY_LIMIT;

  pushAdminLog(task, commandPreview(command, args));
  const child = spawn(command, args, {
    cwd: __dirname,
    windowsHide: true,
    env: { ...process.env, PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1" }
  });
  task.child = child;
  task.pid = child.pid || null;
  if (task.pid) pushAdminLog(task, `PID ${task.pid}`);
  child.stdout.on("data", (chunk) => pushAdminLog(task, chunk));
  child.stderr.on("data", (chunk) => pushAdminLog(task, chunk));
  child.on("error", (error) => {
    task.status = "error";
    task.finishedAt = new Date().toISOString();
    pushAdminLog(task, error.message);
    persistAdminTaskHistory();
  });
  child.on("close", (code) => {
    task.exitCode = code;
    task.status = task.stopRequested ? "stopped" : code === 0 ? "done" : "error";
    task.finishedAt = new Date().toISOString();
    task.child = null;
    pushAdminLog(task, `退出码 ${code}`);
    if (task.status === "done") applyAdminTaskInvalidations(task);
    onDone?.(task);
    persistAdminTaskHistory();
  });
  persistAdminTaskHistory();

  return task;
}

function stopAdminTask(taskId) {
  const task = adminTasks.find((item) => item.id === taskId);
  if (!task) {
    const error = new Error("任务不存在");
    error.statusCode = 404;
    throw error;
  }
  if (!task.child || (task.status !== "running" && task.status !== "stopping")) {
    const error = new Error("任务已经不在运行");
    error.statusCode = 400;
    throw error;
  }
  task.stopRequested = true;
  task.status = "stopping";
  pushAdminLog(task, "收到停止请求");
  persistAdminTaskHistory();
  if (process.platform === "win32" && task.pid) {
    const killer = spawn("taskkill", ["/PID", String(task.pid), "/T", "/F"], { windowsHide: true });
    killer.stdout.on("data", (chunk) => pushAdminLog(task, chunk));
    killer.stderr.on("data", (chunk) => pushAdminLog(task, chunk));
    killer.on("error", (error) => pushAdminLog(task, error.message));
  } else {
    task.child.kill("SIGTERM");
  }
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

function readBodyText(req, maxBytes = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let body = "";
    let done = false;
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      if (done) return;
      body += chunk;
      if (body.length > maxBytes) {
        done = true;
        reject(new Error("请求体太大"));
        req.destroy();
      }
    });
    req.on("end", () => {
      if (done) return;
      done = true;
      resolve(body);
    });
    req.on("error", (error) => {
      if (done) return;
      done = true;
      reject(error);
    });
  });
}

async function readJsonBody(req, maxBytes = 1024 * 1024) {
  const body = await readBodyText(req, maxBytes);
  if (!body.trim()) return {};

  try {
    return JSON.parse(body);
  } catch {
    throw new Error("JSON 格式无效");
  }
}

function readJsonFile(filePath, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

function safeChildPath(rootDir, relativePath) {
  const root = path.resolve(rootDir);
  const normalizedRelative = String(relativePath || "").replace(/[\\/]+/g, path.sep);
  const target = path.resolve(root, normalizedRelative);
  const relative = path.relative(root, target);
  if (relative.startsWith("..") || path.isAbsolute(relative)) return null;
  return target;
}

function mangaRootStatus() {
  const root = path.resolve(MANGA_LIBRARY_ROOT);
  const stat = safeStat(root);
  return {
    root,
    exists: Boolean(stat?.isDirectory())
  };
}

function isMangaCacheDirName(name) {
  return /^(?:smtt6|jmd9)_cache_[A-Za-z0-9_-]+$/i.test(String(name || ""));
}

function mangaSiteFromDirName(name) {
  const lower = String(name || "").toLowerCase();
  if (lower.startsWith("smtt6_")) return "smtt6";
  if (lower.startsWith("jmd9_")) return "jmd9";
  return "local";
}

function mangaCacheDirs() {
  const status = mangaRootStatus();
  if (!status.exists) return [];

  let entries = [];
  try {
    entries = fs.readdirSync(status.root, { withFileTypes: true });
  } catch {
    return [];
  }

  return entries
    .filter((entry) => entry.isDirectory() && isMangaCacheDirName(entry.name))
    .map((entry) => path.join(status.root, entry.name))
    .filter((dirPath) => fs.existsSync(path.join(dirPath, "manifest.json")))
    .sort((a, b) => path.basename(a).localeCompare(path.basename(b), undefined, { numeric: true, sensitivity: "base" }));
}

function mangaIdForDir(dirPath) {
  return createId("mg", path.resolve(dirPath));
}

function mangaCacheById(id) {
  const targetId = String(id || "");
  if (!targetId) return null;
  for (const dirPath of mangaCacheDirs()) {
    if (mangaIdForDir(dirPath) === targetId) return dirPath;
  }
  return null;
}

function mangaChapterImageStats(chapter) {
  const images = Array.isArray(chapter?.images) ? chapter.images : [];
  const downloaded = Number(chapter?.downloaded_count || 0) || images.filter((image) => image?.status === "downloaded").length || images.length;
  return {
    imageCount: Number(chapter?.image_count || 0) || images.length,
    downloadedCount: downloaded,
    failedCount: Number(chapter?.failed_count || 0)
  };
}

function mangaChapterIndex(chapter, fallbackIndex = 0) {
  const value = Number(chapter?.index);
  return Number.isFinite(value) && value > 0 ? value : fallbackIndex + 1;
}

function mangaFirstImage(chapter) {
  const images = Array.isArray(chapter?.images) ? chapter.images : [];
  return images.find((image) => image?.local_path) || images[0] || null;
}

function mangaImageUrl(mangaId, chapterIndex, imageIndex) {
  return `/media/manga/${encodeURIComponent(mangaId)}/${encodeURIComponent(String(chapterIndex))}/${encodeURIComponent(String(imageIndex))}`;
}

function publicMangaSummary(cacheDir) {
  const id = mangaIdForDir(cacheDir);
  const dirName = path.basename(cacheDir);
  const catalog = readJsonFile(path.join(cacheDir, "catalog.json"), {});
  const manifest = readJsonFile(path.join(cacheDir, "manifest.json"), {});
  const chapters = Array.isArray(manifest.chapters) ? manifest.chapters : [];
  let imageTotal = 0;
  let downloadedTotal = 0;
  let failedTotal = 0;
  let doneChapterTotal = 0;
  let coverUrl = "";

  for (let index = 0; index < chapters.length; index += 1) {
    const chapter = chapters[index];
    const stats = mangaChapterImageStats(chapter);
    imageTotal += stats.imageCount;
    downloadedTotal += stats.downloadedCount;
    failedTotal += stats.failedCount;
    if (String(chapter?.status || "").toLowerCase() === "done" || stats.failedCount === 0) doneChapterTotal += 1;
    if (!coverUrl && mangaFirstImage(chapter)) {
      coverUrl = mangaImageUrl(id, mangaChapterIndex(chapter, index), Number(mangaFirstImage(chapter)?.index || 1));
    }
  }

  return {
    id,
    title: String(catalog.title || dirName).trim() || dirName,
    dirName,
    site: mangaSiteFromDirName(dirName),
    sourceUrl: String(catalog.url || "").trim(),
    updatedAt: String(catalog.updated_at || manifest.created_at || "").trim(),
    chapterCount: chapters.length,
    doneChapterCount: doneChapterTotal,
    imageCount: imageTotal,
    downloadedCount: downloadedTotal,
    failedCount: failedTotal,
    coverUrl
  };
}

function publicMangaChapterSummary(mangaId, chapter, index) {
  const chapterIndex = mangaChapterIndex(chapter, index);
  const stats = mangaChapterImageStats(chapter);
  const firstImage = mangaFirstImage(chapter);
  return {
    index: chapterIndex,
    title: String(chapter?.title || `第 ${chapterIndex} 话`).trim(),
    slug: String(chapter?.slug || "").trim(),
    status: String(chapter?.status || "").trim(),
    imageCount: stats.imageCount,
    downloadedCount: stats.downloadedCount,
    failedCount: stats.failedCount,
    coverUrl: firstImage ? mangaImageUrl(mangaId, chapterIndex, Number(firstImage.index || 1)) : ""
  };
}

function publicMangaDetail(cacheDir) {
  const summary = publicMangaSummary(cacheDir);
  const manifest = readJsonFile(path.join(cacheDir, "manifest.json"), {});
  const chapters = Array.isArray(manifest.chapters) ? manifest.chapters : [];
  return {
    ...summary,
    createdAt: String(manifest.created_at || "").trim(),
    chapters: chapters.map((chapter, index) => publicMangaChapterSummary(summary.id, chapter, index))
  };
}

function findMangaChapter(cacheDir, requestedIndex) {
  const detail = readJsonFile(path.join(cacheDir, "manifest.json"), {});
  const chapters = Array.isArray(detail.chapters) ? detail.chapters : [];
  const target = Number(requestedIndex);
  for (let index = 0; index < chapters.length; index += 1) {
    const chapter = chapters[index];
    if (mangaChapterIndex(chapter, index) === target) {
      return { chapter, arrayIndex: index, chapterIndex: target };
    }
  }
  return null;
}

function publicMangaChapter(cacheDir, requestedIndex) {
  const manga = publicMangaSummary(cacheDir);
  const found = findMangaChapter(cacheDir, requestedIndex);
  if (!found) return null;
  const images = Array.isArray(found.chapter.images) ? found.chapter.images : [];
  return {
    ...publicMangaChapterSummary(manga.id, found.chapter, found.arrayIndex),
    images: images.map((image, index) => {
      const imageIndex = Number(image?.index || index + 1);
      return {
        index: imageIndex,
        name: path.basename(String(image?.local_path || "")) || `${String(imageIndex).padStart(3, "0")}`,
        localPath: String(image?.local_path || ""),
        contentType: String(image?.content_type || "").trim(),
        bytes: Number(image?.bytes || 0),
        status: String(image?.status || "").trim(),
        url: mangaImageUrl(manga.id, found.chapterIndex, imageIndex)
      };
    })
  };
}

function mangaImageRecord(cacheDir, chapterIndex, imageIndex) {
  const found = findMangaChapter(cacheDir, chapterIndex);
  if (!found) return null;
  const images = Array.isArray(found.chapter.images) ? found.chapter.images : [];
  const targetImageIndex = Number(imageIndex);
  const image = images.find((item, index) => Number(item?.index || index + 1) === targetImageIndex);
  if (!image?.local_path) return null;
  return { chapter: found.chapter, image, chapterIndex: found.chapterIndex, imageIndex: targetImageIndex || 1 };
}

function mangaChapterDirFromRecord(cacheDir, chapter, image) {
  const candidates = [];
  if (chapter?.html_path) candidates.push(path.dirname(String(chapter.html_path)));
  if (image?.local_path) {
    const imageDir = path.dirname(String(image.local_path));
    candidates.push(path.dirname(imageDir));
  }
  for (const candidate of candidates) {
    if (!candidate || candidate === "." || candidate === path.sep) continue;
    const target = safeChildPath(cacheDir, candidate);
    if (target) return target;
  }
  return null;
}

function archiveReaderHelperPath() {
  return path.join(__dirname, "tools", "archive_image_reader.py");
}

function runArchiveImageHelper(args, options = {}) {
  const result = spawnSync(process.env.PYTHON || "python", [archiveReaderHelperPath(), ...args], {
    cwd: __dirname,
    encoding: "utf8",
    windowsHide: true,
    timeout: options.timeout || 120000
  });

  let payload = null;
  try {
    payload = JSON.parse(result.stdout || "{}");
  } catch {}
  if (result.status !== 0 || !payload?.ok) {
    const message = payload?.error || `${result.stderr || result.stdout || "archive helper failed"}`.trim();
    throw new Error(message || `archive helper failed: ${result.status}`);
  }
  return payload;
}

function archiveListCacheKey(archivePath) {
  const stat = safeStat(archivePath);
  if (!stat?.isFile()) return "";
  return `${path.resolve(archivePath)}|${stat.size}|${Math.floor(stat.mtimeMs || 0)}`;
}

function listArchiveImages(archivePath, options = {}) {
  const key = archiveListCacheKey(archivePath);
  if (!key) return [];
  const now = Date.now();
  const cached = archiveImageListCache.get(key);
  if (cached && now - cached.createdAt < IMAGE_READER_LIST_CACHE_TTL_MS) {
    return cached.images;
  }
  const args = ["list", archivePath];
  if (options.limit) args.push("--limit", String(options.limit));
  const payload = runArchiveImageHelper(args, { timeout: options.timeout || 120000 });
  const images = Array.isArray(payload.images) ? payload.images : [];
  archiveImageListCache.set(key, { createdAt: now, images, imageCount: Number(payload.imageCount || images.length) });
  if (archiveImageListCache.size > 300) {
    const firstKey = archiveImageListCache.keys().next().value;
    if (firstKey) archiveImageListCache.delete(firstKey);
  }
  return images;
}

function archiveImageCacheFile(sourceType, archivePath, memberPath) {
  const stat = safeStat(archivePath);
  const archiveKey = `${path.resolve(archivePath)}|${stat?.size || 0}|${Math.floor(stat?.mtimeMs || 0)}`;
  const archiveHash = crypto.createHash("sha1").update(archiveKey).digest("hex").slice(0, 24);
  const memberHash = crypto.createHash("sha1").update(String(memberPath || "")).digest("hex").slice(0, 24);
  const ext = ARCHIVE_IMAGE_EXTS.has(normalizeExt(memberPath)) ? normalizeExt(memberPath) : ".img";
  return path.join(IMAGE_READER_CACHE_DIR, sourceType, archiveHash, `${memberHash}${ext}`);
}

function touchImageReaderCacheFile(filePath) {
  const now = Date.now();
  const key = path.resolve(filePath);
  if (now - (imageReaderCacheTouchTimes.get(key) || 0) < IMAGE_READER_CACHE_TOUCH_THROTTLE_MS) return;
  imageReaderCacheTouchTimes.set(key, now);
  try {
    const date = new Date(now);
    fs.utimesSync(filePath, date, date);
  } catch {}
}

function extractArchiveMemberToCache(archivePath, memberPath, cachePath) {
  fs.mkdirSync(path.dirname(cachePath), { recursive: true });
  runArchiveImageHelper(["extract", archivePath, memberPath, cachePath], { timeout: 120000 });
}

function compressImageFileToJpeg(filePath) {
  const result = spawnSync(
    FFMPEG_PATH,
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-i",
      filePath,
      "-frames:v",
      "1",
      "-vf",
      `scale=${IMAGE_GALLERY_COVER_BOX_SIZE}:${IMAGE_GALLERY_COVER_BOX_SIZE}:force_original_aspect_ratio=decrease`,
      "-q:v",
      "5",
      "-f",
      "image2pipe",
      "-vcodec",
      "mjpeg",
      "pipe:1"
    ],
    {
      windowsHide: true,
      maxBuffer: IMAGE_GALLERY_COVER_MAX_BYTES,
      timeout: 30000
    }
  );

  if (result.error) {
    throw new Error(result.error.code === "ENOBUFS" ? "压缩后的封面超过大小限制" : `FFmpeg 启动失败：${result.error.message}`);
  }
  if (result.status !== 0 || !result.stdout?.length) {
    const detail = String(result.stderr || "").trim();
    throw new Error(detail ? `封面压缩失败：${detail}` : "封面压缩失败");
  }
  if (result.stdout.length > IMAGE_GALLERY_COVER_MAX_BYTES) {
    throw new Error("压缩后的封面超过大小限制");
  }
  if (result.stdout[0] !== 0xff || result.stdout[1] !== 0xd8) {
    throw new Error("FFmpeg 没有生成有效的 JPEG 封面");
  }
  return result.stdout;
}

function serveInlineFile(res, filePath, contentType = "") {
  const stat = safeStat(filePath);
  if (!stat?.isFile()) {
    notFound(res);
    return false;
  }
  const ext = normalizeExt(filePath);
  res.writeHead(200, {
    "Content-Type": contentType || MIME_TYPES[ext] || "application/octet-stream",
    "Content-Length": stat.size,
    "Cache-Control": "public, max-age=3600",
    "Content-Disposition": "inline"
  });
  fs.createReadStream(filePath).pipe(res);
  return true;
}

function serveArchiveMemberImage(res, options) {
  const archivePath = options.archivePath;
  const memberPath = String(options.memberPath || "").replace(/[\\/]+/g, "/");
  const stat = safeStat(archivePath);
  if (!stat?.isFile() || !memberPath || !ARCHIVE_IMAGE_EXTS.has(normalizeExt(memberPath))) {
    if (options.fallbackPath && serveInlineFile(res, options.fallbackPath, options.contentType)) return;
    notFound(res);
    return;
  }

  const cachePath = archiveImageCacheFile(options.sourceType || "common", archivePath, memberPath);
  if (!safeStat(cachePath)?.isFile()) {
    try {
      extractArchiveMemberToCache(archivePath, memberPath, cachePath);
    } catch (error) {
      console.warn("[image-reader-extract]", error.message || error);
      sendText(res, 500, error.message || "图片缓存抽取失败");
      return;
    }
  }

  touchImageReaderCacheFile(cachePath);
  scheduleImageReaderCacheCleanup();
  serveInlineFile(res, cachePath, options.contentType || MIME_TYPES[normalizeExt(memberPath)] || "");
}

function collectImageReaderCacheEntries() {
  const root = path.resolve(IMAGE_READER_CACHE_DIR);
  const entries = [];
  const stack = [root];
  if (!safeStat(root)?.isDirectory()) return entries;

  while (stack.length) {
    const current = stack.pop();
    let dirEntries = [];
    try {
      dirEntries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of dirEntries) {
      const fullPath = path.join(current, entry.name);
      const relative = path.relative(root, fullPath);
      if (relative.startsWith("..") || path.isAbsolute(relative)) continue;
      if (entry.isDirectory()) {
        stack.push(fullPath);
        continue;
      }
      if (entry.isFile()) {
        const stat = safeStat(fullPath);
        entries.push({
          path: fullPath,
          relativePath: relative,
          bytes: stat?.size || 0,
          touchedAt: stat?.mtimeMs || stat?.ctimeMs || 0
        });
      }
    }
  }
  entries.sort((a, b) => a.touchedAt - b.touchedAt || a.relativePath.localeCompare(b.relativePath, undefined, { numeric: true }));
  return entries;
}

function removeEmptyCacheParents(filePath) {
  const root = path.resolve(IMAGE_READER_CACHE_DIR);
  let current = path.dirname(path.resolve(filePath));
  while (current.startsWith(root) && current !== root) {
    try {
      if (fs.readdirSync(current).length) break;
      fs.rmdirSync(current);
    } catch {
      break;
    }
    current = path.dirname(current);
  }
}

function imageReaderCacheStatus() {
  const entries = collectImageReaderCacheEntries();
  const currentBytes = entries.reduce((sum, entry) => sum + entry.bytes, 0);
  const maxBytes = normalizeImageReaderCacheLimit(appConfig.imageReaderCacheMaxBytes);
  return {
    root: IMAGE_READER_CACHE_DIR,
    exists: Boolean(safeStat(IMAGE_READER_CACHE_DIR)?.isDirectory()),
    maxBytes,
    currentBytes,
    overBytes: Math.max(0, currentBytes - maxBytes),
    fileCount: entries.length,
    cleanupIntervalMs: IMAGE_READER_CACHE_CLEANUP_INTERVAL_MS,
    entries: entries.slice(-12).reverse().map((entry) => ({
      relativePath: entry.relativePath,
      bytes: entry.bytes,
      touchedAt: new Date(entry.touchedAt || 0).toISOString()
    }))
  };
}

function cleanupImageReaderCache(options = {}) {
  if (imageReaderCacheCleanupActive) {
    return { ok: false, skipped: "active", status: imageReaderCacheStatus() };
  }
  imageReaderCacheCleanupActive = true;
  try {
    const maxBytes = normalizeImageReaderCacheLimit(appConfig.imageReaderCacheMaxBytes);
    const entries = collectImageReaderCacheEntries();
    let currentBytes = entries.reduce((sum, entry) => sum + entry.bytes, 0);
    const targetBytes = options.force ? 0 : Math.floor(maxBytes * IMAGE_READER_CACHE_CLEANUP_TARGET_RATIO);
    const removed = [];
    let removedBytes = 0;

    if (options.force || currentBytes > maxBytes) {
      for (const entry of entries) {
        if (currentBytes <= targetBytes) break;
        try {
          fs.rmSync(entry.path, { force: true });
          removeEmptyCacheParents(entry.path);
          currentBytes -= entry.bytes;
          removedBytes += entry.bytes;
          removed.push({ relativePath: entry.relativePath, bytes: entry.bytes });
        } catch (error) {
          console.warn("[image-reader-cache-cleanup]", entry.path, error.message || error);
        }
      }
    }

    return {
      ok: true,
      maxBytes,
      targetBytes,
      removedCount: removed.length,
      removedBytes,
      removed,
      status: imageReaderCacheStatus()
    };
  } finally {
    imageReaderCacheCleanupActive = false;
  }
}

function scheduleImageReaderCacheCleanup() {
  if (imageReaderCacheCleanupPending) return;
  imageReaderCacheCleanupPending = true;
  setTimeout(() => {
    imageReaderCacheCleanupPending = false;
    try {
      cleanupImageReaderCache();
    } catch (error) {
      console.warn("[image-reader-cache-cleanup]", error.message || error);
    }
  }, 1000);
}

function startImageReaderCacheCleanupTimer() {
  setInterval(() => {
    try {
      cleanupImageReaderCache();
    } catch (error) {
      console.warn("[image-reader-cache-cleanup]", error.message || error);
    }
  }, IMAGE_READER_CACHE_CLEANUP_INTERVAL_MS).unref?.();
  scheduleImageReaderCacheCleanup();
}

function serveMangaImage(res, mangaId, chapterIndex, imageIndex) {
  const cacheDir = mangaCacheById(decodeURIComponent(mangaId));
  if (!cacheDir) {
    notFound(res);
    return;
  }
  const record = mangaImageRecord(cacheDir, decodeURIComponent(chapterIndex), decodeURIComponent(imageIndex));
  if (!record) {
    notFound(res);
    return;
  }

  const chapterDir = mangaChapterDirFromRecord(cacheDir, record.chapter, record.image);
  const sourceImagePath = safeChildPath(cacheDir, record.image.local_path);
  if (!chapterDir || !sourceImagePath) {
    notFound(res);
    return;
  }
  const memberPath = path.relative(chapterDir, sourceImagePath).replace(/\\/g, "/");
  const archivePath = `${chapterDir}.zip`;
  serveArchiveMemberImage(res, {
    sourceType: "manga",
    archivePath,
    memberPath,
    fallbackPath: sourceImagePath,
    contentType: record.image.content_type || MIME_TYPES[normalizeExt(memberPath)] || ""
  });
}

function isArchiveFile(fileName) {
  return ARCHIVE_EXTS.has(normalizeExt(fileName));
}

function imageLibraryRootLabel(rootPath) {
  const parsed = path.parse(rootPath);
  const trimmed = String(rootPath || "").replace(/[\\/]+$/g, "");
  return path.basename(trimmed) || parsed.root || rootPath;
}

function photoSetImageUrl(albumId, imageIndex) {
  return `/media/gallery/${encodeURIComponent(albumId)}/${encodeURIComponent(String(imageIndex))}`;
}

function photoSetCoverUrl(albumId, updatedAt = "") {
  const suffix = updatedAt ? `?v=${encodeURIComponent(updatedAt)}` : "";
  return `/media/gallery-cover/${encodeURIComponent(albumId)}${suffix}`;
}

function photoSetArchiveSignature(archivePath) {
  const stat = safeStat(archivePath);
  if (!stat?.isFile()) return null;
  return {
    archivePath: path.resolve(archivePath),
    archiveSize: stat.size || 0,
    archiveMtimeMs: Math.floor(stat.mtimeMs || 0)
  };
}

function photoSetCoverRow(album) {
  try {
    return getImageGalleryDb().prepare("SELECT * FROM photo_set_covers WHERE album_id = ?").get(album.id) || null;
  } catch (error) {
    console.warn("[image-gallery-cover-db]", error.message || error);
    return null;
  }
}

function photoSetCoverMatches(row, signature) {
  return (
    row &&
    signature &&
    path.resolve(row.archive_path || "") === signature.archivePath &&
    Number(row.archive_size || 0) === signature.archiveSize &&
    Number(row.archive_mtime_ms || 0) === signature.archiveMtimeMs
  );
}

function upsertPhotoSetCoverError(album, signature, error) {
  const now = new Date().toISOString();
  try {
    getImageGalleryDb()
      .prepare(
        `
        INSERT INTO photo_set_covers (
          album_id, archive_path, archive_size, archive_mtime_ms, member_path,
          cover_mime, cover_blob, cover_bytes, source_bytes, status, error, generated_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(album_id) DO UPDATE SET
          archive_path = excluded.archive_path,
          archive_size = excluded.archive_size,
          archive_mtime_ms = excluded.archive_mtime_ms,
          member_path = excluded.member_path,
          cover_mime = excluded.cover_mime,
          cover_blob = excluded.cover_blob,
          cover_bytes = excluded.cover_bytes,
          source_bytes = excluded.source_bytes,
          status = excluded.status,
          error = excluded.error,
          generated_at = excluded.generated_at,
          updated_at = excluded.updated_at
        `
      )
      .run(
        album.id,
        signature?.archivePath || "",
        signature?.archiveSize || 0,
        signature?.archiveMtimeMs || 0,
        "",
        "",
        null,
        0,
        0,
        "error",
        error.message || String(error || "封面生成失败"),
        now,
        now
      );
  } catch (dbError) {
    console.warn("[image-gallery-cover-db]", dbError.message || dbError);
  }
}

function upsertPhotoSetCover(album, signature, image, coverBlob) {
  const now = new Date().toISOString();
  getImageGalleryDb()
    .prepare(
      `
      INSERT INTO photo_set_covers (
        album_id, archive_path, archive_size, archive_mtime_ms, member_path,
        cover_mime, cover_blob, cover_bytes, source_bytes, status, error, generated_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(album_id) DO UPDATE SET
        archive_path = excluded.archive_path,
        archive_size = excluded.archive_size,
        archive_mtime_ms = excluded.archive_mtime_ms,
        member_path = excluded.member_path,
        cover_mime = excluded.cover_mime,
        cover_blob = excluded.cover_blob,
        cover_bytes = excluded.cover_bytes,
        source_bytes = excluded.source_bytes,
        status = excluded.status,
        error = excluded.error,
        generated_at = excluded.generated_at,
        updated_at = excluded.updated_at
      `
    )
    .run(
      album.id,
      signature.archivePath,
      signature.archiveSize,
      signature.archiveMtimeMs,
      image.path || "",
      "image/jpeg",
      coverBlob,
      coverBlob.length,
      Number(image.bytes || 0),
      "ok",
      "",
      now,
      now
    );
  return photoSetCoverRow(album);
}

function generatePhotoSetCover(album) {
  const archivePath = photoSetArchivePath(album);
  const signature = photoSetArchiveSignature(archivePath);
  if (!signature) {
    const error = new Error("图包压缩文件不存在");
    error.statusCode = 404;
    throw error;
  }

  const cached = photoSetCoverRow(album);
  if (photoSetCoverMatches(cached, signature)) {
    if (cached.status === "ok" && cached.cover_blob) return cached;
    const error = new Error(cached.error || "图包封面生成失败");
    error.statusCode = 404;
    throw error;
  }

  const images = listArchiveImages(archivePath, { limit: 1, timeout: 120000 });
  const firstImage = images[0];
  if (!firstImage?.path) {
    const error = new Error("图包里没有可用图片");
    error.statusCode = 404;
    upsertPhotoSetCoverError(album, signature, error);
    throw error;
  }

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "fanhao-gallery-cover-"));
  const tempExt = ARCHIVE_IMAGE_EXTS.has(normalizeExt(firstImage.path)) ? normalizeExt(firstImage.path) : ".img";
  const tempPath = path.join(tempDir, `source${tempExt}`);
  try {
    extractArchiveMemberToCache(archivePath, firstImage.path, tempPath);
    const coverBlob = compressImageFileToJpeg(tempPath);
    return upsertPhotoSetCover(album, signature, firstImage, coverBlob);
  } catch (error) {
    upsertPhotoSetCoverError(album, signature, error);
    error.statusCode = error.statusCode || 500;
    throw error;
  } finally {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  }
}

function cleanPhotoPersonCandidate(value) {
  let text = String(value || "")
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .replace(/[【\[][^【】\[\]]*(?:\d+\s*[PpVv]|[KMGT]B|[KMGT])[^\]】]*[】\]]\s*$/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^[\s._-]+|[\s._-]+$/g, "");
  const bracketOnly = text.match(/^\[([^\]]+)\]$/);
  if (bracketOnly) text = bracketOnly[1].trim() || text;
  return text;
}

function isPhotoSetNumberBucket(value) {
  const text = cleanPhotoPersonCandidate(value).toLowerCase();
  return !text || /^(?:vol|no)\.?\s*\d*$/.test(text) || /^第?\d+[期辑部卷]?$/.test(text);
}

function isPhotoSetOrganizationPart(value) {
  const text = cleanPhotoPersonCandidate(value).toLowerCase();
  return /(?:写真|专辑|影像|女神|美腿|尤果|尤物|丝社|爱秀|丽柜|秀人|雅拉伊|ugirls|beautyleg|graphis|ssa|ligui|xiuren|yalayi|ishow|mygirl|tukmo)/i.test(text);
}

function photoPersonFromTail(value) {
  const text = cleanPhotoPersonCandidate(value);
  if (!text) return "";
  const appearance = text.match(/(?:出镜(?:妹子|模特|者)?|模特|model|coser|cn)[:：]\s*([^/|,，;；\[\]【】()（）]+)/i);
  if (appearance) return cleanPhotoPersonCandidate(appearance[1]);
  const tokens = text.split(/\s+/).map(cleanPhotoPersonCandidate).filter(Boolean);
  if (tokens.length > 1) {
    for (let index = tokens.length - 1; index >= 0; index -= 1) {
      if (!isPhotoSetNumberBucket(tokens[index])) return tokens[index];
    }
  }
  return isPhotoSetNumberBucket(text) ? "" : text;
}

function inferPhotoSetPersonFromTitle(title) {
  const base = cleanPhotoPersonCandidate(
    String(title || "")
      .replace(/\.(?:zip|cbz|rar|7z)$/i, "")
      .replace(/^\[[^\]]+\]\s*/g, "")
  );
  if (!base) return "";
  const appearance = base.match(/(?:出镜(?:妹子|模特|者)?|模特|model|coser|cn)[:：]\s*([^/|,，;；\[\]【】()（）]+)/i);
  if (appearance) return cleanPhotoPersonCandidate(appearance[1]);
  const numbered =
    base.match(/(?:VOL|NO)\.?\s*\d+[\s._-]+(.+)$/i) ||
    base.match(/\d{4}[._-]\d{2}[._-]\d{2}[\s._-]+(.+)$/);
  if (numbered) return photoPersonFromTail(numbered[1]);
  const codePrefix = base.match(/^[A-Za-z]{1,6}-?\d+\s+(.+)$/);
  if (codePrefix) return photoPersonFromTail(codePrefix[1]);
  const leadingNumber = base.match(/^\d{2,}[\s._-]+(.+)$/);
  if (leadingNumber) return photoPersonFromTail(leadingNumber[1]);
  const nameBeforeNumber = base.match(/^([^\d].*?)\d{2,}\s+.+$/);
  if (nameBeforeNumber) return cleanPhotoPersonCandidate(nameBeforeNumber[1]);
  return "";
}

function inferPhotoSetPersonFromCategory(category) {
  const text = cleanPhotoPersonCandidate(category);
  const numberedName = text.match(/-\s*\d+\s+(.+)$/);
  return numberedName ? cleanPhotoPersonCandidate(numberedName[1]) : "";
}

function inferPhotoSetPerson(parts, title) {
  const cleanedParts = parts.map((part) => String(part || "").trim()).filter(Boolean);
  const category = cleanedParts[0] || "";
  const isXiuren = category.toLowerCase().includes("xiuren") || category.includes("秀人");
  const pathPersonParts = cleanedParts.slice(1).filter((part) => !isPhotoSetNumberBucket(part));
  const titlePerson = inferPhotoSetPersonFromTitle(title);
  if (category.toLowerCase().includes("cos") && pathPersonParts[0]) return cleanPhotoPersonCandidate(pathPersonParts[0]);
  if (!isXiuren && pathPersonParts.length) {
    const pathPerson = cleanPhotoPersonCandidate(pathPersonParts[pathPersonParts.length - 1]);
    const pathLooksLikeOrganization =
      isPhotoSetOrganizationPart(category) || pathPersonParts.some((part) => isPhotoSetOrganizationPart(part));
    if (titlePerson && pathLooksLikeOrganization) return titlePerson;
    return pathPerson;
  }
  if (titlePerson) return titlePerson;

  if (!isXiuren) return inferPhotoSetPersonFromCategory(category);
  return "";
}

function publicPhotoSetArchive(filePath, rootPath) {
  const stat = safeStat(filePath);
  const relativePath = path.relative(rootPath, filePath);
  const dirParts = path
    .dirname(relativePath)
    .split(/[\\/]+/)
    .filter((part) => part && part !== ".");
  const title = path.basename(filePath, path.extname(filePath));
  const id = createId("ps", path.resolve(filePath));
  const category = dirParts[0] || imageLibraryRootLabel(rootPath);
  const updatedAt = stat ? new Date(stat.mtimeMs).toISOString() : "";
  return {
    id,
    type: "photoSet",
    title,
    category,
    subCategory: dirParts[1] || "",
    personName: inferPhotoSetPerson(dirParts, title),
    rootLabel: imageLibraryRootLabel(rootPath),
    sourceRoot: rootPath,
    relativePath,
    archiveExt: normalizeExt(filePath).slice(1),
    size: stat?.size || 0,
    updatedAt,
    imageCount: null,
    coverUrl: photoSetCoverUrl(id, updatedAt)
  };
}

function photoSetRootStatuses() {
  return PHOTO_SET_ROOTS.map((root) => {
    const stat = safeStat(root);
    return {
      root,
      label: imageLibraryRootLabel(root),
      exists: Boolean(stat?.isDirectory())
    };
  });
}

function galleryMediaRootStatuses() {
  return GALLERY_MEDIA_SOURCES.flatMap((source) =>
    source.roots.map((root) => {
      const stat = safeStat(root);
      return {
        kind: source.kind,
        label: source.label,
        root,
        rootLabel: imageLibraryRootLabel(root),
        exists: Boolean(stat?.isDirectory())
      };
    })
  );
}

function walkArchiveFiles(rootPath) {
  const results = [];
  const root = path.resolve(rootPath);
  if (!safeStat(root)?.isDirectory()) return results;
  const stack = [root];
  while (stack.length) {
    const current = stack.pop();
    let entries = [];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (isExcludedDirName(entry.name)) continue;
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        try {
          const lstat = fs.lstatSync(fullPath);
          if (lstat.isSymbolicLink()) continue;
        } catch {
          continue;
        }
        stack.push(fullPath);
        continue;
      }
      if (entry.isFile() && isArchiveFile(entry.name)) {
        results.push(fullPath);
      }
    }
  }
  results.sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" }));
  return results;
}

function walkVideoFiles(rootPath) {
  const results = [];
  const root = path.resolve(rootPath);
  if (!safeStat(root)?.isDirectory()) return results;
  const stack = [root];
  while (stack.length) {
    const current = stack.pop();
    let entries = [];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (isExcludedDirName(entry.name)) continue;
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        try {
          const lstat = fs.lstatSync(fullPath);
          if (lstat.isSymbolicLink()) continue;
        } catch {
          continue;
        }
        stack.push(fullPath);
        continue;
      }
      if (entry.isFile() && isVideo(entry.name)) {
        results.push(fullPath);
      }
    }
  }
  results.sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" }));
  return results;
}

function mediaKindPrefix(kind) {
  if (kind === "western") return "gw";
  if (kind === "movie") return "gf";
  if (kind === "tv") return "gt";
  return "gm";
}

function mediaTitleFromFile(filePath) {
  return path.basename(filePath, path.extname(filePath)).replace(/[._]+/g, " ").replace(/\s+/g, " ").trim();
}

function publicGalleryMediaFile(filePath, rootPath, source) {
  const stat = safeStat(filePath);
  const relativePath = path.relative(rootPath, filePath);
  const dirParts = path
    .dirname(relativePath)
    .split(/[\\/]+/)
    .filter((part) => part && part !== ".");
  const ext = normalizeExt(filePath);
  const title = mediaTitleFromFile(filePath);
  const id = createId(mediaKindPrefix(source.kind), `${source.kind}|${path.resolve(filePath)}`);
  const parentName = dirParts[dirParts.length - 1] || "";
  const category = dirParts[0] || source.label;
  const seriesName = source.kind === "tv" ? parentName || category : source.kind === "movie" ? parentName : "";
  const personName = source.kind === "western" ? category : source.kind === "tv" ? seriesName : "";
  return {
    id,
    type: "media",
    mediaKind: source.kind,
    kindLabel: source.label,
    title,
    category,
    subCategory: dirParts[1] || "",
    personName,
    seriesName,
    rootLabel: source.label,
    sourceRoot: rootPath,
    relativePath,
    ext: ext.slice(1),
    size: stat?.size || 0,
    updatedAt: stat ? new Date(stat.mtimeMs).toISOString() : "",
    playable: DIRECT_VIDEO_EXTS.has(ext),
    streamUrl: `/media/gallery-video/${encodeURIComponent(id)}`,
    coverUrl: ""
  };
}

function scanGalleryMediaLibrary() {
  const roots = galleryMediaRootStatuses();
  const items = [];
  const seen = new Set();
  for (const source of GALLERY_MEDIA_SOURCES) {
    for (const rootPath of source.roots) {
      if (!safeStat(rootPath)?.isDirectory()) continue;
      for (const filePath of walkVideoFiles(rootPath)) {
        const key = path.resolve(filePath).toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        items.push(publicGalleryMediaFile(filePath, rootPath, source));
      }
    }
  }
  items.sort((a, b) => {
    if (a.mediaKind !== b.mediaKind) return a.mediaKind.localeCompare(b.mediaKind);
    const timeDiff = new Date(b.updatedAt || 0).getTime() - new Date(a.updatedAt || 0).getTime();
    return timeDiff || a.title.localeCompare(b.title, undefined, { numeric: true, sensitivity: "base" });
  });
  return {
    mediaRoots: roots,
    mediaItems: items
  };
}

function scanPhotoSetLibrary() {
  const roots = photoSetRootStatuses();
  const albums = [];
  const seen = new Set();
  for (const root of roots) {
    if (!root.exists) continue;
    for (const filePath of walkArchiveFiles(root.root)) {
      const key = path.resolve(filePath).toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      albums.push(publicPhotoSetArchive(filePath, root.root));
    }
  }
  albums.sort((a, b) => {
    const timeDiff = new Date(b.updatedAt || 0).getTime() - new Date(a.updatedAt || 0).getTime();
    return timeDiff || a.title.localeCompare(b.title, undefined, { numeric: true, sensitivity: "base" });
  });
  return {
    scannedAt: new Date().toISOString(),
    roots,
    photoSets: albums
  };
}

function scanImageLibrary() {
  const photo = scanPhotoSetLibrary();
  const media = scanGalleryMediaLibrary();
  return {
    schemaVersion: 2,
    scannedAt: new Date().toISOString(),
    roots: photo.roots,
    photoSets: photo.photoSets,
    mediaRoots: media.mediaRoots,
    mediaItems: media.mediaItems
  };
}

function loadImageLibraryIndexCache() {
  if (imageLibraryCache) return imageLibraryCache;
  const cached = readJsonFile(IMAGE_LIBRARY_INDEX_PATH, null);
  if (cached && Array.isArray(cached.photoSets)) {
    imageLibraryCache = cached;
    return imageLibraryCache;
  }
  return null;
}

function saveImageLibraryIndexCache(index) {
  ensureDataDir();
  fs.writeFileSync(IMAGE_LIBRARY_INDEX_PATH, JSON.stringify(index, null, 2), "utf8");
}

function getImageLibraryIndex(options = {}) {
  if (!options.refresh) {
    const cached = loadImageLibraryIndexCache();
    if (cached && Array.isArray(cached.mediaItems)) return cached;
    if (cached) {
      const media = scanGalleryMediaLibrary();
      imageLibraryCache = {
        ...cached,
        schemaVersion: 2,
        scannedAt: new Date().toISOString(),
        mediaRoots: media.mediaRoots,
        mediaItems: media.mediaItems
      };
      saveImageLibraryIndexCache(imageLibraryCache);
      return imageLibraryCache;
    }
  }
  imageLibraryCache = scanImageLibrary();
  saveImageLibraryIndexCache(imageLibraryCache);
  return imageLibraryCache;
}

function facetCounts(items, fieldName) {
  const counts = new Map();
  for (const item of items) {
    const value = String(item[fieldName] || "").trim();
    if (!value) continue;
    counts.set(value, (counts.get(value) || 0) + 1);
  }
  return [...counts.entries()]
    .map(([value, count]) => ({ value, count }))
    .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value, undefined, { numeric: true, sensitivity: "base" }));
}

function mediaItemsByKind(items, kind) {
  return items.filter((item) => item.mediaKind === kind);
}

function mediaFacets(items) {
  return {
    categories: facetCounts(items, "category"),
    subCategories: facetCounts(items, "subCategory"),
    people: facetCounts(items, "personName"),
    series: facetCounts(items, "seriesName"),
    roots: facetCounts(items, "rootLabel")
  };
}

function imageLibraryPayload(options = {}) {
  const index = getImageLibraryIndex(options);
  const photoSets = (index.photoSets || []).map((item) => ({
    ...item,
    coverUrl: item.coverUrl || photoSetCoverUrl(item.id, item.updatedAt || "")
  }));
  const mediaItems = Array.isArray(index.mediaItems) ? index.mediaItems : [];
  const westernItems = mediaItemsByKind(mediaItems, "western");
  const movieItems = mediaItemsByKind(mediaItems, "movie");
  const tvItems = mediaItemsByKind(mediaItems, "tv");
  const manga = mangaCacheDirs().map(publicMangaSummary);
  return {
    schemaVersion: 2,
    scannedAt: index.scannedAt || "",
    mangaRoot: mangaRootStatus(),
    photoRoots: index.roots || photoSetRootStatuses(),
    mediaRoots: index.mediaRoots || galleryMediaRootStatuses(),
    cache: imageReaderCacheStatus(),
    totals: {
      manga: manga.length,
      photoSets: photoSets.length,
      western: westernItems.length,
      movies: movieItems.length,
      tv: tvItems.length,
      media: mediaItems.length,
      photoBytes: photoSets.reduce((sum, item) => sum + Number(item.size || 0), 0),
      mediaBytes: mediaItems.reduce((sum, item) => sum + Number(item.size || 0), 0)
    },
    facets: {
      categories: facetCounts(photoSets, "category"),
      subCategories: facetCounts(photoSets, "subCategory"),
      people: facetCounts(photoSets, "personName"),
      roots: facetCounts(photoSets, "rootLabel"),
      western: mediaFacets(westernItems),
      movie: mediaFacets(movieItems),
      tv: mediaFacets(tvItems)
    },
    manga,
    photoSets,
    mediaItems
  };
}

function imageLibrarySummaryPayload(options = {}) {
  const index = getImageLibraryIndex(options);
  const photoSets = Array.isArray(index.photoSets) ? index.photoSets : [];
  const mediaItems = Array.isArray(index.mediaItems) ? index.mediaItems : [];
  const westernItems = mediaItemsByKind(mediaItems, "western");
  const movieItems = mediaItemsByKind(mediaItems, "movie");
  const tvItems = mediaItemsByKind(mediaItems, "tv");
  const manga = mangaCacheDirs().map(publicMangaSummary);
  const cache = imageReaderCacheStatus();
  return {
    schemaVersion: 1,
    scannedAt: index.scannedAt || "",
    mangaRoot: mangaRootStatus(),
    photoRoots: index.roots || photoSetRootStatuses(),
    mediaRoots: index.mediaRoots || galleryMediaRootStatuses(),
    cache: {
      root: cache.root,
      exists: cache.exists,
      maxBytes: cache.maxBytes,
      currentBytes: cache.currentBytes,
      overBytes: cache.overBytes,
      fileCount: cache.fileCount,
      cleanupIntervalMs: cache.cleanupIntervalMs
    },
    totals: {
      manga: manga.length,
      photoSets: photoSets.length,
      western: westernItems.length,
      movies: movieItems.length,
      tv: tvItems.length,
      media: mediaItems.length,
      photoBytes: photoSets.reduce((sum, item) => sum + Number(item.size || 0), 0),
      mediaBytes: mediaItems.reduce((sum, item) => sum + Number(item.size || 0), 0)
    },
    facets: {
      categories: facetCounts(photoSets, "category").slice(0, 12),
      people: facetCounts(photoSets, "personName").slice(0, 12),
      western: mediaFacets(westernItems),
      movie: mediaFacets(movieItems),
      tv: mediaFacets(tvItems)
    }
  };
}

function imageLibraryItemsPayload(url, options = {}) {
  const mode = normalizeImageLibraryMode(url.searchParams.get("mode"));
  const limit = clampInteger(url.searchParams.get("limit"), 48, 1, 120);
  const offset = clampInteger(url.searchParams.get("offset"), 0, 0, Number.MAX_SAFE_INTEGER);
  const query = String(url.searchParams.get("q") || url.searchParams.get("search") || "").trim();
  const sort = String(url.searchParams.get("sort") || "updated").trim();
  const index = getImageLibraryIndex(options);
  const mediaItems = Array.isArray(index.mediaItems) ? index.mediaItems : [];

  let source = [];
  if (mode === "photo") {
    source = (index.photoSets || []).map((item) => publicImageLibraryListItem(item, "photo"));
  } else if (mode === "manga") {
    source = mangaCacheDirs().map((cacheDir) => publicImageLibraryListItem(publicMangaSummary(cacheDir), "manga"));
  } else if (["western", "movie", "tv"].includes(mode)) {
    source = mediaItemsByKind(mediaItems, mode).map((item) => publicImageLibraryListItem(item, mode));
  }

  const filtered = filterImageLibraryItems(source, query);
  const sorted = sortImageLibraryItems(filtered, sort);
  const items = sorted.slice(offset, offset + limit);
  return {
    schemaVersion: 1,
    mode,
    query,
    sort,
    count: items.length,
    total: sorted.length,
    limit,
    offset,
    scannedAt: index.scannedAt || "",
    items
  };
}

function normalizeImageLibraryMode(value) {
  const mode = String(value || "").trim().toLowerCase();
  if (mode === "photos" || mode === "photo-set" || mode === "photo-sets") return "photo";
  if (mode === "movies") return "movie";
  if (["photo", "manga", "western", "movie", "tv"].includes(mode)) return mode;
  return "photo";
}

function publicImageLibraryListItem(item, mode) {
  const normalizedMode = normalizeImageLibraryMode(mode || item?.mediaKind || item?.type);
  return {
    id: String(item?.id || ""),
    type: normalizedMode,
    title: String(item?.title || item?.dirName || "").trim(),
    category: String(item?.category || item?.site || item?.kindLabel || "").trim(),
    subCategory: String(item?.subCategory || "").trim(),
    personName: String(item?.personName || "").trim(),
    seriesName: String(item?.seriesName || "").trim(),
    rootLabel: String(item?.rootLabel || item?.kindLabel || "").trim(),
    ext: String(item?.archiveExt || item?.ext || "").trim(),
    size: Number(item?.size || 0),
    updatedAt: String(item?.updatedAt || "").trim(),
    imageCount: item?.imageCount === null || item?.imageCount === undefined ? null : Number(item.imageCount || 0),
    chapterCount: item?.chapterCount === undefined ? null : Number(item.chapterCount || 0),
    doneChapterCount: item?.doneChapterCount === undefined ? null : Number(item.doneChapterCount || 0),
    downloadedCount: item?.downloadedCount === undefined ? null : Number(item.downloadedCount || 0),
    failedCount: item?.failedCount === undefined ? null : Number(item.failedCount || 0),
    playable: Boolean(item?.playable),
    coverUrl: String(item?.coverUrl || "").trim(),
    routePath: imageLibraryItemRoutePath(normalizedMode, item?.id)
  };
}

function imageLibraryItemRoutePath(mode, id) {
  const encoded = encodeURIComponent(String(id || ""));
  if (!encoded) return "/";
  if (mode === "photo") return `/photo/set/${encoded}`;
  if (mode === "manga") return `/manga/${encoded}`;
  if (mode === "western") return `/western/${encoded}`;
  if (mode === "movie") return `/movies/${encoded}`;
  if (mode === "tv") return `/tv/${encoded}`;
  return "/";
}

function filterImageLibraryItems(items, query) {
  const needle = query.toLowerCase();
  if (!needle) return items;
  return items.filter((item) =>
    [
      item.title,
      item.category,
      item.subCategory,
      item.personName,
      item.seriesName,
      item.rootLabel,
      item.ext
    ]
      .filter(Boolean)
      .some((value) => String(value).toLowerCase().includes(needle))
  );
}

function sortImageLibraryItems(items, sort) {
  const list = [...items];
  if (sort === "title") {
    return list.sort((a, b) => a.title.localeCompare(b.title, undefined, { numeric: true, sensitivity: "base" }));
  }
  if (sort === "size") {
    return list.sort((a, b) => Number(b.size || 0) - Number(a.size || 0) || a.title.localeCompare(b.title, undefined, { numeric: true, sensitivity: "base" }));
  }
  return list.sort((a, b) => {
    const timeDiff = new Date(b.updatedAt || 0).getTime() - new Date(a.updatedAt || 0).getTime();
    return timeDiff || a.title.localeCompare(b.title, undefined, { numeric: true, sensitivity: "base" });
  });
}

function photoSetById(id) {
  const target = String(id || "");
  if (!target) return null;
  const index = getImageLibraryIndex();
  return (index.photoSets || []).find((item) => item.id === target) || null;
}

function galleryMediaById(id) {
  const target = String(id || "");
  if (!target) return null;
  const index = getImageLibraryIndex();
  return (index.mediaItems || []).find((item) => item.id === target) || null;
}

function galleryMediaPath(item) {
  if (!item) return "";
  return safeChildPath(item.sourceRoot, item.relativePath);
}

function photoSetArchivePath(album) {
  if (!album) return "";
  return safeChildPath(album.sourceRoot, album.relativePath);
}

function publicPhotoSetDetail(album) {
  const archivePath = photoSetArchivePath(album);
  const images = listArchiveImages(archivePath);
  return {
    ...album,
    imageCount: images.length,
    images: images.map((image, index) => ({
      index: index + 1,
      name: image.name || path.basename(image.path || ""),
      archivePath: image.path || "",
      bytes: Number(image.bytes || 0),
      url: photoSetImageUrl(album.id, index + 1)
    }))
  };
}

function publicGalleryMediaDetail(item) {
  const filePath = galleryMediaPath(item);
  const stat = safeStat(filePath);
  return {
    ...item,
    size: stat?.size || item.size || 0,
    updatedAt: stat ? new Date(stat.mtimeMs).toISOString() : item.updatedAt || "",
    exists: Boolean(stat?.isFile()),
    streamUrl: `/media/gallery-video/${encodeURIComponent(item.id)}`
  };
}

function servePhotoSetImage(res, albumId, imageIndex) {
  const album = photoSetById(decodeURIComponent(albumId));
  if (!album) {
    notFound(res);
    return;
  }
  const archivePath = photoSetArchivePath(album);
  const images = listArchiveImages(archivePath);
  const image = images[Number(decodeURIComponent(imageIndex)) - 1];
  if (!image?.path) {
    notFound(res);
    return;
  }
  serveArchiveMemberImage(res, {
    sourceType: "photo-set",
    archivePath,
    memberPath: image.path,
    contentType: MIME_TYPES[normalizeExt(image.path)] || ""
  });
}

function serveGalleryVideo(req, res, mediaId) {
  const item = galleryMediaById(decodeURIComponent(mediaId));
  const filePath = galleryMediaPath(item);
  if (!item || !filePath || !safeStat(filePath)?.isFile()) {
    notFound(res);
    return;
  }
  serveVideo(req, res, {
    id: item.id,
    path: filePath,
    name: path.basename(filePath),
    ext: normalizeExt(filePath)
  });
}

function ensureToolDownloadDir() {
  fs.mkdirSync(TOOL_DOWNLOAD_DIR, { recursive: true });
}

function cleanupToolDownloadDir() {
  try {
    fs.rmSync(TOOL_DOWNLOAD_DIR, { recursive: true, force: true });
    ensureToolDownloadDir();
  } catch (error) {
    console.warn("[tool-downloads] 清理临时目录失败：", error.message || error);
  }
}

function sanitizeDownloadFileName(value, fallback = "formatted.txt") {
  const raw = String(value || "").replaceAll("\\", "/");
  const name = path
    .basename(raw)
    .replace(/[\x00-\x1f<>:"/\\|?*]+/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[. ]+$/g, "");
  return (name || fallback).slice(0, 140);
}

function formattedTxtFileName(fileName) {
  const safeName = sanitizeDownloadFileName(fileName, "文本.txt");
  const parsed = path.parse(safeName);
  const base = (parsed.name || "文本").slice(0, 120);
  return `${base}_格式化.txt`;
}

function attachmentDisposition(fileName) {
  const fallback = sanitizeDownloadFileName(fileName, "download.txt").replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  return `attachment; filename="${fallback || "download.txt"}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}

function toolDownloadDirForId(id) {
  return path.join(TOOL_DOWNLOAD_DIR, id);
}

function removeToolDownload(id) {
  if (!id) return;
  const timer = toolDownloadTimers.get(id);
  if (timer) clearTimeout(timer);
  toolDownloadTimers.delete(id);
  const record = toolDownloads.get(id);
  toolDownloads.delete(id);
  const dir = record?.dirPath || toolDownloadDirForId(id);
  try {
    const resolved = path.resolve(dir);
    const root = path.resolve(TOOL_DOWNLOAD_DIR);
    if (resolved === root || !resolved.startsWith(root + path.sep)) return;
    fs.rmSync(resolved, { recursive: true, force: true });
  } catch (error) {
    console.warn("[tool-downloads] 删除临时文件失败：", error.message || error);
  }
}

function registerToolDownload(record) {
  toolDownloads.set(record.id, record);
  const delay = Math.max(0, record.expiresAt - Date.now());
  const timer = setTimeout(() => removeToolDownload(record.id), delay);
  if (typeof timer.unref === "function") timer.unref();
  toolDownloadTimers.set(record.id, timer);
}

function txtToolOptions(input = {}) {
  return {
    indent: input.indent !== false,
    cleanJunk: input.cleanJunk !== false
  };
}

function txtToolInputBuffer(body = {}) {
  const fileName = sanitizeDownloadFileName(body.fileName || body.name || "文本.txt", "文本.txt");
  if (body.contentBase64) {
    const base64 = String(body.contentBase64 || "").replace(/^data:[^,]+,/, "");
    const buffer = Buffer.from(base64, "base64");
    return { fileName, buffer, source: "file" };
  }
  const text = String(body.text || "");
  return { fileName, buffer: Buffer.from(text, "utf8"), source: "text" };
}

function runNovelTextFormatter(inputPath, outputPath, options = {}) {
  return new Promise((resolve, reject) => {
    const args = ["-u", path.join("tools", "novel_text_formatter.py"), inputPath, "--output", outputPath];
    if (!options.indent) args.push("--no-indent");
    if (!options.cleanJunk) args.push("--no-clean-junk");

    const child = spawn("python", args, {
      cwd: __dirname,
      windowsHide: true,
      env: {
        ...process.env,
        PYTHONIOENCODING: "utf-8",
        PYTHONUTF8: "1"
      }
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        const error = new Error(stderr.trim() || stdout.trim() || "TXT 格式化失败");
        error.statusCode = 500;
        reject(error);
        return;
      }
      try {
        resolve(JSON.parse(stdout.trim() || "{}"));
      } catch (error) {
        error.statusCode = 500;
        error.message = `格式化统计解析失败：${error.message}`;
        reject(error);
      }
    });
  });
}

async function createTxtFormatDownload(body = {}) {
  const options = txtToolOptions(body.options || body);
  const { fileName, buffer, source } = txtToolInputBuffer(body);
  if (!buffer.length) {
    const error = new Error("TXT 内容为空");
    error.statusCode = 400;
    throw error;
  }
  if (buffer.length > TXT_TOOL_MAX_FILE_BYTES) {
    const error = new Error(`TXT 文件不能超过 ${Math.round(TXT_TOOL_MAX_FILE_BYTES / 1024 / 1024)} MB`);
    error.statusCode = 413;
    throw error;
  }
  if (source === "file" && path.extname(fileName).toLowerCase() !== ".txt") {
    const error = new Error("只支持 .txt 文档");
    error.statusCode = 400;
    throw error;
  }

  ensureToolDownloadDir();
  const id = crypto.randomBytes(16).toString("base64url");
  const dirPath = toolDownloadDirForId(id);
  fs.mkdirSync(dirPath, { recursive: true });
  const inputPath = path.join(dirPath, "source.txt");
  const outputFileName = formattedTxtFileName(fileName);
  const outputPath = path.join(dirPath, outputFileName);
  fs.writeFileSync(inputPath, buffer);

  try {
    const stats = await runNovelTextFormatter(inputPath, outputPath, options);
    fs.rmSync(inputPath, { force: true });
    const outputBuffer = fs.readFileSync(outputPath);
    const now = Date.now();
    const record = {
      id,
      dirPath,
      filePath: outputPath,
      fileName: outputFileName,
      size: outputBuffer.length,
      createdAt: now,
      expiresAt: now + TOOL_DOWNLOAD_TTL_MS
    };
    registerToolDownload(record);
    const previewText =
      outputBuffer.length <= TXT_TOOL_PREVIEW_BYTES
        ? outputBuffer.toString("utf8")
        : `${outputBuffer.subarray(0, TXT_TOOL_PREVIEW_BYTES).toString("utf8")}\n\n……`;
    return {
      ok: true,
      id,
      fileName: outputFileName,
      size: outputBuffer.length,
      downloadUrl: `/api/tools/txt-format/download/${encodeURIComponent(id)}`,
      expiresAt: new Date(record.expiresAt).toISOString(),
      expiresInSeconds: Math.floor(TOOL_DOWNLOAD_TTL_MS / 1000),
      previewText,
      previewTruncated: outputBuffer.length > TXT_TOOL_PREVIEW_BYTES,
      stats: {
        ...stats,
        input_path: undefined,
        output_path: undefined,
        inputBytes: buffer.length,
        outputBytes: outputBuffer.length
      }
    };
  } catch (error) {
    removeToolDownload(id);
    throw error;
  }
}

function serveTxtToolDownload(req, res, id) {
  const record = toolDownloads.get(id);
  if (!record) {
    sendJson(res, 404, { error: "下载文件不存在或已过期" });
    return;
  }
  if (Date.now() >= record.expiresAt) {
    removeToolDownload(id);
    sendJson(res, 410, { error: "下载文件已过期" });
    return;
  }
  if (!fs.existsSync(record.filePath)) {
    removeToolDownload(id);
    sendJson(res, 404, { error: "下载文件不存在或已过期" });
    return;
  }

  const stat = fs.statSync(record.filePath);
  res.writeHead(200, {
    "Content-Type": "text/plain; charset=utf-8",
    "Content-Length": stat.size,
    "Content-Disposition": attachmentDisposition(record.fileName),
    "Cache-Control": "no-store"
  });
  fs.createReadStream(record.filePath).pipe(res);
}

function localImageMime(file) {
  return MIME_TYPES[file.ext] || "application/octet-stream";
}

function localImageCacheRow(file) {
  try {
    return (
      getActorDb()
        .prepare(
          `
          SELECT *
          FROM local_image_cache
          WHERE file_id = ?
            AND image_blob IS NOT NULL
            AND length(image_blob) > 0
            AND source_size = ?
            AND source_mtime = ?
          `
        )
        .get(file.id, Number(file.size || 0), file.modifiedAt || "") || null
    );
  } catch (error) {
    console.warn("[local-image-cache]", error.message || error);
    return null;
  }
}

function serveLocalImageCacheRow(res, row) {
  if (!row?.image_blob) return false;
  const buffer = Buffer.from(row.image_blob);
  if (!buffer.length) return false;
  res.writeHead(200, {
    "Content-Type": row.content_type || "application/octet-stream",
    "Content-Length": buffer.length,
    "Cache-Control": "public, max-age=86400",
    "Content-Disposition": "inline"
  });
  res.end(buffer);
  return true;
}

function upsertLocalImageCache(file, stat, buffer) {
  const now = new Date().toISOString();
  const sourceMtime = stat?.mtime?.toISOString() || file.modifiedAt || "";
  const sourceSize = Number(stat?.size ?? file.size ?? buffer.length) || 0;
  const contentType = localImageMime(file);
  getActorDb()
    .prepare(
      `
      INSERT INTO local_image_cache (
        file_id, file_path, relative_path, content_type, image_blob, byte_length,
        source_size, source_mtime, status, error, cached_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'ok', '', ?, ?)
      ON CONFLICT(file_id) DO UPDATE SET
        file_path = excluded.file_path,
        relative_path = excluded.relative_path,
        content_type = excluded.content_type,
        image_blob = excluded.image_blob,
        byte_length = excluded.byte_length,
        source_size = excluded.source_size,
        source_mtime = excluded.source_mtime,
        status = 'ok',
        error = '',
        cached_at = COALESCE(local_image_cache.cached_at, excluded.cached_at),
        updated_at = excluded.updated_at
      `
    )
    .run(
      file.id,
      file.path || "",
      file.relativePath || "",
      contentType,
      buffer,
      buffer.length,
      sourceSize,
      sourceMtime,
      now,
      now
    );
  return {
    content_type: contentType,
    image_blob: buffer,
    byte_length: buffer.length
  };
}

function upsertLocalImageCacheError(file, error) {
  try {
    const now = new Date().toISOString();
    getActorDb()
      .prepare(
        `
        INSERT INTO local_image_cache (
          file_id, file_path, relative_path, content_type, image_blob, byte_length,
          source_size, source_mtime, status, error, cached_at, updated_at
        )
        VALUES (?, ?, ?, ?, NULL, 0, ?, ?, 'error', ?, NULL, ?)
        ON CONFLICT(file_id) DO UPDATE SET
          file_path = excluded.file_path,
          relative_path = excluded.relative_path,
          status = 'error',
          error = excluded.error,
          updated_at = excluded.updated_at
        `
      )
      .run(
        file.id,
        file.path || "",
        file.relativePath || "",
        localImageMime(file),
        Number(file.size || 0),
        file.modifiedAt || "",
        String(error?.message || error || "local image cache failed").slice(0, 1000),
        now
      );
  } catch (cacheError) {
    console.warn("[local-image-cache]", cacheError.message || cacheError);
  }
}

function serveImage(res, file) {
  if (serveLocalImageCacheRow(res, localImageCacheRow(file))) {
    return;
  }

  const stat = safeStat(file.path);
  if (!stat) {
    notFound(res);
    return;
  }
  if (stat.size <= 0) {
    upsertLocalImageCacheError(file, new Error("empty local image"));
    notFound(res);
    return;
  }

  let buffer = null;
  try {
    buffer = fs.readFileSync(file.path);
  } catch (error) {
    upsertLocalImageCacheError(file, error);
    console.warn("[local-image-cache]", error.message || error);
    sendText(res, 500, "Local image read failed");
    return;
  }

  try {
    if (serveLocalImageCacheRow(res, upsertLocalImageCache(file, stat, buffer))) return;
  } catch (error) {
    console.warn("[local-image-cache]", error.message || error);
  }

  res.writeHead(200, {
    "Content-Type": localImageMime(file),
    "Content-Length": buffer.length,
    "Cache-Control": "public, max-age=3600",
    "Content-Disposition": "inline"
  });
  res.end(buffer);
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

function servePhotoSetCover(res, albumId) {
  const album = photoSetById(albumId);
  if (!album) {
    notFound(res);
    return;
  }

  let row = photoSetCoverRow(album);
  const signature = photoSetArchiveSignature(photoSetArchivePath(album));
  if (!photoSetCoverMatches(row, signature) || !row?.cover_blob) {
    try {
      row = generatePhotoSetCover(album);
    } catch (error) {
      console.warn("[image-gallery-cover]", album.relativePath || album.id, error.message || error);
      notFound(res);
      return;
    }
  }

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

function remoteImageCacheKey(remoteUrl) {
  return crypto.createHash("sha256").update(remoteUrl).digest("hex");
}

function remoteImageCacheRow(remoteUrl) {
  try {
    return getActorDb().prepare("SELECT * FROM remote_image_cache WHERE url = ?").get(remoteUrl) || null;
  } catch (error) {
    console.warn("[remote-image-cache]", error.message || error);
    return null;
  }
}

function remoteImageMimeFromUrl(remoteUrl) {
  try {
    const ext = normalizeExt(new URL(remoteUrl).pathname);
    return MIME_TYPES[ext] || "";
  } catch {
    return "";
  }
}

function normalizeRemoteImageMime(contentType, remoteUrl) {
  const mime = String(contentType || "").split(";", 1)[0].trim().toLowerCase();
  if (["image/jpeg", "image/png", "image/webp", "image/gif", "image/bmp"].includes(mime)) return mime;
  return remoteImageMimeFromUrl(remoteUrl) || "image/jpeg";
}

function serveRemoteImageRow(res, row) {
  if (!row?.image_blob) return false;
  const buffer = Buffer.from(row.image_blob);

  res.writeHead(200, {
    "Content-Type": row.content_type || "image/jpeg",
    "Content-Length": buffer.length,
    "Cache-Control": "public, max-age=86400",
    "Content-Disposition": "inline"
  });
  res.end(buffer);
  return true;
}

async function downloadRemoteImage(remoteUrl) {
  const response = await fetch(remoteUrl, {
    signal: AbortSignal.timeout(15000),
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36",
      Accept: "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
      Referer: "https://javdb.com/"
    }
  });

  if (!response.ok) {
    const error = new Error(`远程图片请求失败：${response.status}`);
    error.statusCode = 502;
    throw error;
  }

  const declaredLength = Number(response.headers.get("content-length") || 0);
  if (declaredLength > MAX_REMOTE_IMAGE_BYTES) {
    const error = new Error("远程图片过大");
    error.statusCode = 413;
    throw error;
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length > MAX_REMOTE_IMAGE_BYTES) {
    const error = new Error("远程图片过大");
    error.statusCode = 413;
    throw error;
  }

  return {
    buffer,
    contentType: normalizeRemoteImageMime(response.headers.get("content-type"), remoteUrl)
  };
}

function enqueueRemoteImageWarm(remoteUrl) {
  if (remoteImageCacheRow(remoteUrl)?.image_blob || remoteImageWarmQueued.has(remoteUrl)) return;
  remoteImageWarmQueued.add(remoteUrl);
  remoteImageWarmQueue.push(remoteUrl);
  drainRemoteImageWarmQueue();
}

function drainRemoteImageWarmQueue() {
  while (remoteImageWarmActive < REMOTE_IMAGE_WARM_CONCURRENCY && remoteImageWarmQueue.length) {
    const remoteUrl = remoteImageWarmQueue.shift();
    remoteImageWarmActive += 1;
    warmRemoteImage(remoteUrl)
      .catch((error) => {
        console.warn("[remote-image-cache]", error.message || error);
      })
      .finally(() => {
        remoteImageWarmActive -= 1;
        remoteImageWarmQueued.delete(remoteUrl);
        drainRemoteImageWarmQueue();
      });
  }
}

async function warmRemoteImage(remoteUrl) {
  if (remoteImageCacheRow(remoteUrl)?.image_blob) return;
  const downloaded = await downloadRemoteImage(remoteUrl);
  const now = new Date().toISOString();
  getActorDb()
    .prepare(
      `
      INSERT INTO remote_image_cache (
        url, url_hash, content_type, image_blob, byte_length, status, error, fetched_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, 'ok', '', ?, ?)
      ON CONFLICT(url) DO UPDATE SET
        url_hash = excluded.url_hash,
        content_type = excluded.content_type,
        image_blob = excluded.image_blob,
        byte_length = excluded.byte_length,
        status = 'ok',
        error = '',
        fetched_at = excluded.fetched_at,
        updated_at = excluded.updated_at
      `
    )
    .run(remoteUrl, remoteImageCacheKey(remoteUrl), downloaded.contentType, downloaded.buffer, downloaded.buffer.length, now, now);
}

async function serveCachedRemoteImage(req, res, url) {
  const remoteUrl = publicRemoteUrl(url.searchParams.get("url"));
  if (!remoteUrl) {
    sendText(res, 400, "Missing remote image URL");
    return;
  }

  const parsed = new URL(remoteUrl);
  if (!isAllowedRemoteImageUrl(parsed)) {
    sendText(res, 403, "Remote image host is not allowed");
    return;
  }

  if (serveRemoteImageRow(res, remoteImageCacheRow(remoteUrl))) {
    return;
  }

  enqueueRemoteImageWarm(remoteUrl);
  res.writeHead(302, {
    Location: remoteUrl,
    "Cache-Control": "no-store"
  });
  res.end();
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
      remoteCoverUrl: proxiedRemoteImageUrl(work.remoteCoverUrl) || work.remoteCoverUrl || "",
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
  prewarmRemoteImagesForWorks(page);
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

  if (await routeGalleryApi(req, res, url, {
    cleanupImageReaderCache,
    galleryMediaById,
    imageLibraryItemsPayload,
    imageLibraryPayload,
    imageLibrarySummaryPayload,
    imageReaderCacheStatus,
    mangaCacheById,
    mangaCacheDirs,
    mangaRootStatus,
    notFound,
    photoSetById,
    publicAppConfig,
    publicGalleryMediaDetail,
    publicMangaChapter,
    publicMangaDetail,
    publicMangaSummary,
    publicPhotoSetDetail,
    requireLocalAdmin,
    sendJson
  })) return true;

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

  if (await routeToolsApi(req, res, url, {
    createTxtFormatDownload,
    readJsonBody,
    sendJson,
    serveTxtToolDownload,
    txtToolMaxBodyBytes: TXT_TOOL_MAX_BODY_BYTES
  })) return true;

  if (await routeAdminApi(req, res, url, {
    actorAvatarCandidatesFromFiletree,
    actorProfileRow,
    adminScriptById,
    adminScriptCategories,
    adminTaskHistoryLimit: ADMIN_TASK_HISTORY_LIMIT,
    adminTaskSummary,
    adminTasks,
    buildAdminScriptCommand,
    clearSearchSourceCaches,
    clampInteger,
    coverGenerationStatus,
    getAppConfig: () => appConfig,
    importActorAvatarCandidate,
    importActorAvatarsFromFiletree,
    invalidateTableStamp,
    library,
    normalizeAdminScriptOptions,
    normalizeAppConfig,
    publicAdminScript,
    publicAdminTask,
    publicAppConfig,
    publicPerson,
    pagedWorksPayload,
    readJsonBody,
    refreshPersonLibrary,
    requireLocalAdmin,
    scriptDefinitions: ADMIN_SCRIPT_DEFINITIONS,
    sendJson,
    setActorMovieCache: (value) => {
      actorMovieCache = value;
    },
    setAppConfig: (value) => {
      appConfig = value;
      saveAppConfig();
      return appConfig;
    },
    setLocalWorkCachesDirty: () => {
      localWorkCodeKeyCache = null;
      localWorkByCodeKeyCache = null;
    },
    setWorkInfoCache: (value) => {
      workInfoCache = value;
    },
    sortWorkList,
    startAdminProcessTask,
    stopAdminTask
  })) return true;

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
    const publicItem = publicWork(work, true);
    prewarmRemoteImagesForWorks([publicItem], 100);
    sendJson(res, 200, { work: publicItem, person: person ? publicPerson(person) : null });
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

async function routeMedia(req, res, url) {
  if (url.pathname === "/media/remote-image" && req.method === "GET") {
    await serveCachedRemoteImage(req, res, url);
    return true;
  }

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

  const photoSetCoverMatch = /^\/media\/gallery-cover\/([^/]+)$/.exec(url.pathname);
  if (photoSetCoverMatch && req.method === "GET") {
    servePhotoSetCover(res, decodeURIComponent(photoSetCoverMatch[1]));
    return true;
  }

  const mangaImageMatch = /^\/media\/manga\/([^/]+)\/([^/]+)\/([^/]+)$/.exec(url.pathname);
  if (mangaImageMatch && req.method === "GET") {
    serveMangaImage(res, mangaImageMatch[1], mangaImageMatch[2], mangaImageMatch[3]);
    return true;
  }

  const photoSetImageMatch = /^\/media\/gallery\/([^/]+)\/([^/]+)$/.exec(url.pathname);
  if (photoSetImageMatch && req.method === "GET") {
    servePhotoSetImage(res, photoSetImageMatch[1], photoSetImageMatch[2]);
    return true;
  }

  const galleryVideoMatch = /^\/media\/gallery-video\/([^/]+)$/.exec(url.pathname);
  if (galleryVideoMatch && req.method === "GET") {
    serveGalleryVideo(req, res, galleryVideoMatch[1]);
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
  const startedAt = Date.now();
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,HEAD,POST,PUT,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type,Accept,Range,X-FanHao-Client");
  res.setHeader("Access-Control-Expose-Headers", "Content-Length,Content-Range,Accept-Ranges");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  const authState = requestAuthState(req, url);
  applyAppCookie(res, authState);
  attachAccessLogger(req, res, url, authState, startedAt);

  try {
    if (await routeAuth(req, res, url, authState)) return;
    if (!authState.allowed) {
      sendLoginRequired(req, res, url, authState);
      return;
    }

    if (await routeApi(req, res, url)) return;
    if (await routeMedia(req, res, url)) return;

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
cleanupToolDownloadDir();
startImageReaderCacheCleanupTimer();
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
