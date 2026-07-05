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
import { createNovelStore } from "./src/server/novel-store.js";
import { routeAdminApi } from "./src/server/routes/admin-api.js";
import { routeGalleryApi } from "./src/server/routes/gallery-api.js";
import { routeNovelApi } from "./src/server/routes/novel-api.js";
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
const IMAGE_LIBRARY_INDEX_PATH = path.join(DATA_DIR, "image-library-index.json");
const USER_STATE_PATH = path.join(DATA_DIR, "user-state.json");
const CORE_DB_PATH = path.join(DATA_DIR, "fanhao-core-v2.sqlite");
const IMAGE_GALLERY_DB_PATH = path.join(DATA_DIR, "image-gallery.sqlite");
const NOVEL_DB_PATH = path.join(DATA_DIR, "novels.sqlite");
const NOVEL_UPLOAD_MAX_BODY_BYTES = 80 * 1024 * 1024;
const APP_CONFIG_PATH = path.join(DATA_DIR, "app-config.json");
const AUTH_SECRET_PATH = path.join(DATA_DIR, "auth-secret.txt");
const ACCESS_LOG_PATH = path.join(LOG_DIR, "access.log");
const ADMIN_TASKS_PATH = path.join(DATA_DIR, "admin-tasks.json");
const TOOL_DOWNLOAD_DIR = path.join(DATA_DIR, "tool-downloads");
const ANDROID_UPDATE_DIR = path.join(DATA_DIR, "android-update");
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
const COVER_HINTS = new Set(["cover", "poster", "folder", "front", "fanart", "thumb", "thumbnail", "封面"]);
const MAX_INFO_BYTES = 1024 * 1024;
const MAX_GENERATED_COVER_BYTES = DEFAULT_MAX_COVER_BYTES;
const DEFAULT_WORK_LIMIT = 160;
const MAX_WORK_LIMIT = 16000;
const MAX_IMAGE_LIBRARY_ITEM_LIMIT = 12000;
const HAS_NVENC = detectNvenc();
const VIDEO_PROBE_CACHE_LIMIT = 512;
const DEFAULT_VIDEO_CHUNK_BYTES = 1024 * 1024;
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
const PHOTO_SET_COVER_GENERATOR_VERSION = 2;
const GALLERY_MEDIA_COVER_GENERATOR_VERSION = 1;
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
const PHOTO_COLLECTION_ROOT_VALUE = "__fanhao_photo_collection_root__";

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".apk": "application/vnd.android.package-archive",
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
const novelStore = createNovelStore({ dbPath: NOVEL_DB_PATH });

let library = emptyLibrary();
let lastScanError = null;
let userState = emptyUserState();
let appConfig = defaultAppConfig();
let coreDb = null;
let imageGalleryDb = null;
let workInfoCache = null;
let actorProfileCache = null;
let coreMapCache = null;
let actorMovieCache = null;
let actorMovieByCodeKeyCache = null;
let personMergeCache = null;
let studioHierarchyCache = null;
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
    "G:\\;F:\\;O:\\;O:\\[珍藏]\\;O:\\[珍藏1]\\;O:\\[稀有]\\;O:\\[动漫]\\;V:\\[A]\\;V:\\[A1]\\;V:\\AV\\";
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

function resolveLocalFileTarget(sourcePath) {
  const absolutePath = sourcePathToAbsolute(sourcePath);
  if (!absolutePath) {
    return { error: "缺少文件路径" };
  }

  const allowed = libraryOpenRoots().some((rootPath) => pathWithinRoot(absolutePath, rootPath));
  if (!allowed) {
    return { error: "只能打开资料库根目录内的文件" };
  }

  const stat = safeStat(absolutePath);
  if (!stat) {
    return { error: "本地文件不存在" };
  }
  if (!stat.isFile()) {
    return { error: "目标不是本地文件" };
  }

  return { filePath: absolutePath };
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

function openFileInSystem(filePath) {
  const platform = process.platform;
  const command = platform === "win32" ? "powershell.exe" : platform === "darwin" ? "open" : "xdg-open";
  const args =
    platform === "win32"
      ? ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", "Start-Process -LiteralPath $args[0]", filePath]
      : [filePath];
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

function scheduleOpenFile(filePath) {
  setTimeout(() => {
    try {
      openFileInSystem(filePath);
    } catch (error) {
      console.warn("[open-file]", error.message);
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

function normalizePersonGender(value) {
  const text = String(value || "").trim().toLowerCase();
  if (!text) return "unknown";
  if (["male", "m", "man", "boy"].includes(text) || /男|男優|男优/.test(text)) return "male";
  if (["female", "f", "woman", "girl"].includes(text) || /女|女優|女优/.test(text)) return "female";
  return "unknown";
}

function cleanPersonNamePart(value) {
  return String(value || "").trim();
}

function localWorkMarkerKey(value) {
  const key = String(value || "").trim().toUpperCase();
  return key === "A" ? "A" : "";
}

function localWorkMarkersFromName(value) {
  const name = String(value || "").trim();
  const markers = [];
  if (/^\[A\](?:[.\s_-]*)/i.test(name)) markers.push("A");
  return markers;
}

function stripLocalWorkMarkerPrefix(value) {
  return String(value || "")
    .trim()
    .replace(/^\[A\][.\s_-]*/i, "")
    .trim();
}

function localWorkMarkers(work) {
  const names = [work?.directoryName, path.basename(String(work?.relativePath || ""))].filter(Boolean);
  const markers = new Set();
  for (const name of names) {
    for (const marker of localWorkMarkersFromName(name)) markers.add(marker);
  }
  return [...markers];
}

function workHasLocalMarker(work, marker) {
  const key = localWorkMarkerKey(marker);
  return Boolean(key && localWorkMarkers(work).includes(key));
}

function markerDirectoryName(name, marker, enabled) {
  const key = localWorkMarkerKey(marker);
  if (!key) return String(name || "");
  const clean = stripLocalWorkMarkerPrefix(name);
  if (enabled) return `[${key}].${clean || String(name || "").trim()}`;
  return clean || String(name || "").trim();
}

function displayWorkTitle(value) {
  return stripLocalWorkMarkerPrefix(value);
}

function preferredPersonDisplayName(rowOrPerson, fallback = "") {
  const aliases = rowOrPerson?.aliases_json ? actorProfileAliases(rowOrPerson) : rowOrPerson?.actorProfile?.aliases || [];
  const candidates = uniquePersonNames([
    rowOrPerson?.display_name,
    rowOrPerson?.displayName,
    rowOrPerson?.person_name,
    rowOrPerson?.personName,
    rowOrPerson?.name,
    ...aliases,
    fallback
  ]);
  return candidates[0] || cleanPersonNamePart(fallback);
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
  for (const item of values) {
    const value = cleanPersonNamePart(item);
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
  return row ? preferredPersonDisplayName(row, person?.name || "") : person?.name || "";
}

function actorProfileSearchNames(person) {
  if (!person) return [];
  const row = actorProfileRow(person.id);
  return uniquePersonNames([
    person.name,
    row?.person_name,
    row?.display_name,
    ...actorProfileAliases(row),
    ...mergedPersonAliasNames(person.id)
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
  const buffer = fs.readFileSync(entry.fullPath);
  const corePersonId = Number(person.id);
  const db = getCoreDb();
  db.prepare(
    `
    UPDATE people
    SET display_name = COALESCE(display_name, ?),
        updated_at = ?
    WHERE id = ?
    `
  ).run(existing?.display_name || person.name, now, corePersonId);
  db.prepare(
    `
    INSERT INTO images (
      owner_type, owner_id, kind, source_type, local_path, mime, image_blob, byte_size,
      sort_order, status, source, legacy_table, legacy_key, created_at, updated_at
    )
    VALUES ('person', ?, 'avatar', 'local', ?, ?, ?, ?, 0, 'ok', ?, 'local-avatar', ?, ?, ?)
    ON CONFLICT DO UPDATE SET
      mime = excluded.mime,
      image_blob = excluded.image_blob,
      byte_size = excluded.byte_size,
      status = excluded.status,
      source = excluded.source,
      legacy_table = excluded.legacy_table,
      legacy_key = excluded.legacy_key,
      updated_at = excluded.updated_at
    `
  ).run(corePersonId, entry.fullPath, entry.mime, buffer, buffer.length, LOCAL_ACTOR_AVATAR_SOURCE, person.id, now, now);
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
    personMergeCache = null;
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
    if (existing?.avatar_url && !replace) {
      skippedExisting += 1;
      continue;
    }

    upsertActorAvatar(person, entry, existing, now);
    importedPersonIds.add(person.id);
    seenAvatarKeys.add(`${person.id}:${entry.relPath}`);
    imported += 1;
  }

  actorProfileCache = null;
  personMergeCache = null;
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
  const exactSourceIds = new Set();
  const fuzzySourceIds = new Set();
  const exactCanonicalIds = new Set();
  const fuzzyCanonicalIds = new Set();
  const lowerQuery = query.toLowerCase();

  const addPersonMatch = (list, canonicalIds, person) => {
    const merged = mergedPersonRecord(person);
    if (!merged || canonicalIds.has(merged.id)) return;
    canonicalIds.add(merged.id);
    list.push(merged);
  };

  for (const person of library.people) {
    const names = actorProfileSearchNames(person);
    if (names.some((name) => normalizePersonSearchValue(name) === exactName)) {
      exactSourceIds.add(person.id);
      for (const member of mergedPersonMembers(person.id)) exactSourceIds.add(member.id);
      addPersonMatch(exact, exactCanonicalIds, person);
      continue;
    }

    if (bracketed) continue;

    if (names.some((name) => {
      const lowerName = name.toLowerCase();
      const normalizedName = normalizeSearchValue(name);
      return lowerName.includes(lowerQuery) || (normalizedQuery.length >= 2 && normalizedName.includes(normalizedQuery));
    })) {
      fuzzySourceIds.add(person.id);
      for (const member of mergedPersonMembers(person.id)) fuzzySourceIds.add(member.id);
      addPersonMatch(fuzzy, fuzzyCanonicalIds, person);
    }
  }

  const sortPeople = (people) =>
    people.sort((a, b) => b.workCount - a.workCount || actorProfileDisplayName(a).localeCompare(actorProfileDisplayName(b), undefined, { numeric: true, sensitivity: "base" }));

  sortPeople(exact);
  sortPeople(fuzzy);
  return {
    exact,
    fuzzy,
    matchedPersonIds: [...(exact.length ? exactSourceIds : fuzzySourceIds)],
    people: exact.length ? exact : fuzzy.slice(0, 20)
  };
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

function getCoreDb() {
  if (!coreDb) {
    ensureDataDir();
    coreDb = new DatabaseSync(CORE_DB_PATH);
    coreDb.exec("PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
    try {
      ensureColumn(coreDb, "people", "gender", "TEXT NOT NULL DEFAULT 'unknown'");
      ensureColumn(coreDb, "works", "has_magnet", "INTEGER");
      ensureColumn(coreDb, "works", "is_streamable", "INTEGER");
      ensureColumn(coreDb, "works", "has_subtitles", "INTEGER");
      ensureColumn(coreDb, "works", "javdb_tags_json", "TEXT");
      ensureColumn(coreDb, "images", "image_blob", "BLOB");
      ensureCoreCacheTables(coreDb);
    } catch (error) {
      console.warn("[core-db]", error.message);
    }
  }
  return coreDb;
}

function ensureCoreCacheTables(db) {
  db.exec(`
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
    CREATE TABLE IF NOT EXISTS local_files (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      work_id INTEGER NOT NULL REFERENCES works(id) ON DELETE CASCADE,
      local_work_id INTEGER REFERENCES local_works(id) ON DELETE CASCADE,
      file_id TEXT NOT NULL UNIQUE,
      file_type TEXT NOT NULL CHECK(file_type IN ('video', 'image', 'info')),
      file_path TEXT NOT NULL,
      name TEXT NOT NULL,
      title TEXT,
      ext TEXT,
      relative_path TEXT,
      size INTEGER,
      modified_at TEXT,
      playable INTEGER NOT NULL DEFAULT 0,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_local_files_work ON local_files(work_id, file_type, sort_order);
    CREATE INDEX IF NOT EXISTS idx_local_files_local_work ON local_files(local_work_id);
    CREATE INDEX IF NOT EXISTS idx_local_files_path ON local_files(file_path);
  `);
}

function hasCoreDb() {
  return fs.existsSync(CORE_DB_PATH);
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
        generator_version INTEGER NOT NULL DEFAULT 1,
        status TEXT NOT NULL DEFAULT 'ok',
        error TEXT,
        generated_at TEXT,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_photo_set_covers_archive_path ON photo_set_covers(archive_path);
      CREATE INDEX IF NOT EXISTS idx_photo_set_covers_status ON photo_set_covers(status);
      CREATE INDEX IF NOT EXISTS idx_photo_set_covers_updated_at ON photo_set_covers(updated_at);
      CREATE TABLE IF NOT EXISTS photo_set_image_indexes (
        archive_path TEXT PRIMARY KEY,
        archive_size INTEGER,
        archive_mtime_ms INTEGER,
        image_count INTEGER,
        images_json TEXT NOT NULL,
        indexed_at TEXT,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_photo_set_image_indexes_updated_at ON photo_set_image_indexes(updated_at);
      CREATE TABLE IF NOT EXISTS tv_series_metadata (
        series_key TEXT PRIMARY KEY,
        category TEXT,
        series_name TEXT NOT NULL,
        douban_id TEXT,
        douban_url TEXT,
        douban_title TEXT,
        original_title TEXT,
        aka_json TEXT,
        official_site TEXT,
        year TEXT,
        rating REAL,
        rating_count INTEGER,
        rating_stars_json TEXT,
        rating_better_than_json TEXT,
        directors_json TEXT,
        writers_json TEXT,
        genres_json TEXT,
        actors_json TEXT,
        countries_json TEXT,
        languages_json TEXT,
        pubdate TEXT,
        release_dates_json TEXT,
        season_count INTEGER,
        episode_count INTEGER,
        episode_duration TEXT,
        durations_json TEXT,
        imdb_id TEXT,
        info_json TEXT,
        json_ld_json TEXT,
        summary TEXT,
        cover_url TEXT,
        cover_mime TEXT,
        cover_blob BLOB,
        cover_bytes INTEGER,
        source TEXT,
        detail_source TEXT,
        status TEXT NOT NULL DEFAULT 'ok',
        error TEXT,
        fetched_at TEXT,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_tv_series_metadata_category ON tv_series_metadata(category);
      CREATE INDEX IF NOT EXISTS idx_tv_series_metadata_douban_id ON tv_series_metadata(douban_id);
      CREATE INDEX IF NOT EXISTS idx_tv_series_metadata_status ON tv_series_metadata(status);
      CREATE TABLE IF NOT EXISTS movie_metadata (
        media_id TEXT PRIMARY KEY,
        category TEXT,
        movie_title TEXT NOT NULL,
        douban_id TEXT,
        douban_url TEXT,
        douban_title TEXT,
        original_title TEXT,
        aka_json TEXT,
        official_site TEXT,
        year TEXT,
        rating REAL,
        rating_count INTEGER,
        rating_stars_json TEXT,
        rating_better_than_json TEXT,
        directors_json TEXT,
        writers_json TEXT,
        genres_json TEXT,
        actors_json TEXT,
        countries_json TEXT,
        languages_json TEXT,
        pubdate TEXT,
        release_dates_json TEXT,
        season_count INTEGER,
        episode_count INTEGER,
        episode_duration TEXT,
        durations_json TEXT,
        imdb_id TEXT,
        info_json TEXT,
        json_ld_json TEXT,
        summary TEXT,
        cover_url TEXT,
        cover_mime TEXT,
        cover_blob BLOB,
        cover_bytes INTEGER,
        source TEXT,
        detail_source TEXT,
        status TEXT NOT NULL DEFAULT 'ok',
        error TEXT,
        fetched_at TEXT,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_movie_metadata_category ON movie_metadata(category);
      CREATE INDEX IF NOT EXISTS idx_movie_metadata_douban_id ON movie_metadata(douban_id);
      CREATE INDEX IF NOT EXISTS idx_movie_metadata_status ON movie_metadata(status);
      CREATE TABLE IF NOT EXISTS gallery_media_covers (
        media_id TEXT PRIMARY KEY,
        source_path TEXT NOT NULL,
        source_size INTEGER,
        source_mtime_ms INTEGER,
        cover_mime TEXT,
        cover_blob BLOB,
        cover_bytes INTEGER,
        generator_version INTEGER NOT NULL DEFAULT 1,
        status TEXT NOT NULL DEFAULT 'ok',
        error TEXT,
        generated_at TEXT,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_gallery_media_covers_status ON gallery_media_covers(status);
      CREATE INDEX IF NOT EXISTS idx_gallery_media_covers_updated_at ON gallery_media_covers(updated_at);
    `);
    ensureColumn(imageGalleryDb, "photo_set_covers", "archive_size", "INTEGER");
    ensureColumn(imageGalleryDb, "photo_set_covers", "archive_mtime_ms", "INTEGER");
    ensureColumn(imageGalleryDb, "photo_set_covers", "member_path", "TEXT");
    ensureColumn(imageGalleryDb, "photo_set_covers", "cover_mime", "TEXT");
    ensureColumn(imageGalleryDb, "photo_set_covers", "cover_blob", "BLOB");
    ensureColumn(imageGalleryDb, "photo_set_covers", "cover_bytes", "INTEGER");
    ensureColumn(imageGalleryDb, "photo_set_covers", "source_bytes", "INTEGER");
    ensureColumn(imageGalleryDb, "photo_set_covers", "generator_version", "INTEGER NOT NULL DEFAULT 1");
    ensureColumn(imageGalleryDb, "photo_set_covers", "status", "TEXT NOT NULL DEFAULT 'ok'");
    ensureColumn(imageGalleryDb, "photo_set_covers", "error", "TEXT");
    ensureColumn(imageGalleryDb, "photo_set_covers", "generated_at", "TEXT");
    ensureColumn(imageGalleryDb, "photo_set_covers", "updated_at", "TEXT");
    ensureColumn(imageGalleryDb, "photo_set_image_indexes", "archive_path", "TEXT");
    ensureColumn(imageGalleryDb, "photo_set_image_indexes", "archive_size", "INTEGER");
    ensureColumn(imageGalleryDb, "photo_set_image_indexes", "archive_mtime_ms", "INTEGER");
    ensureColumn(imageGalleryDb, "photo_set_image_indexes", "image_count", "INTEGER");
    ensureColumn(imageGalleryDb, "photo_set_image_indexes", "images_json", "TEXT");
    ensureColumn(imageGalleryDb, "photo_set_image_indexes", "indexed_at", "TEXT");
    ensureColumn(imageGalleryDb, "photo_set_image_indexes", "updated_at", "TEXT");
    ensureColumn(imageGalleryDb, "tv_series_metadata", "category", "TEXT");
    ensureColumn(imageGalleryDb, "tv_series_metadata", "series_name", "TEXT NOT NULL DEFAULT ''");
    ensureColumn(imageGalleryDb, "tv_series_metadata", "douban_id", "TEXT");
    ensureColumn(imageGalleryDb, "tv_series_metadata", "douban_url", "TEXT");
    ensureColumn(imageGalleryDb, "tv_series_metadata", "douban_title", "TEXT");
    ensureColumn(imageGalleryDb, "tv_series_metadata", "original_title", "TEXT");
    ensureColumn(imageGalleryDb, "tv_series_metadata", "aka_json", "TEXT");
    ensureColumn(imageGalleryDb, "tv_series_metadata", "official_site", "TEXT");
    ensureColumn(imageGalleryDb, "tv_series_metadata", "year", "TEXT");
    ensureColumn(imageGalleryDb, "tv_series_metadata", "rating", "REAL");
    ensureColumn(imageGalleryDb, "tv_series_metadata", "rating_count", "INTEGER");
    ensureColumn(imageGalleryDb, "tv_series_metadata", "rating_stars_json", "TEXT");
    ensureColumn(imageGalleryDb, "tv_series_metadata", "rating_better_than_json", "TEXT");
    ensureColumn(imageGalleryDb, "tv_series_metadata", "directors_json", "TEXT");
    ensureColumn(imageGalleryDb, "tv_series_metadata", "writers_json", "TEXT");
    ensureColumn(imageGalleryDb, "tv_series_metadata", "genres_json", "TEXT");
    ensureColumn(imageGalleryDb, "tv_series_metadata", "actors_json", "TEXT");
    ensureColumn(imageGalleryDb, "tv_series_metadata", "countries_json", "TEXT");
    ensureColumn(imageGalleryDb, "tv_series_metadata", "languages_json", "TEXT");
    ensureColumn(imageGalleryDb, "tv_series_metadata", "pubdate", "TEXT");
    ensureColumn(imageGalleryDb, "tv_series_metadata", "release_dates_json", "TEXT");
    ensureColumn(imageGalleryDb, "tv_series_metadata", "season_count", "INTEGER");
    ensureColumn(imageGalleryDb, "tv_series_metadata", "episode_count", "INTEGER");
    ensureColumn(imageGalleryDb, "tv_series_metadata", "episode_duration", "TEXT");
    ensureColumn(imageGalleryDb, "tv_series_metadata", "durations_json", "TEXT");
    ensureColumn(imageGalleryDb, "tv_series_metadata", "imdb_id", "TEXT");
    ensureColumn(imageGalleryDb, "tv_series_metadata", "info_json", "TEXT");
    ensureColumn(imageGalleryDb, "tv_series_metadata", "json_ld_json", "TEXT");
    ensureColumn(imageGalleryDb, "tv_series_metadata", "summary", "TEXT");
    ensureColumn(imageGalleryDb, "tv_series_metadata", "cover_url", "TEXT");
    ensureColumn(imageGalleryDb, "tv_series_metadata", "cover_mime", "TEXT");
    ensureColumn(imageGalleryDb, "tv_series_metadata", "cover_blob", "BLOB");
    ensureColumn(imageGalleryDb, "tv_series_metadata", "cover_bytes", "INTEGER");
    ensureColumn(imageGalleryDb, "tv_series_metadata", "source", "TEXT");
    ensureColumn(imageGalleryDb, "tv_series_metadata", "detail_source", "TEXT");
    ensureColumn(imageGalleryDb, "tv_series_metadata", "status", "TEXT NOT NULL DEFAULT 'ok'");
    ensureColumn(imageGalleryDb, "tv_series_metadata", "error", "TEXT");
    ensureColumn(imageGalleryDb, "tv_series_metadata", "fetched_at", "TEXT");
    ensureColumn(imageGalleryDb, "tv_series_metadata", "updated_at", "TEXT NOT NULL DEFAULT ''");
    ensureColumn(imageGalleryDb, "movie_metadata", "category", "TEXT");
    ensureColumn(imageGalleryDb, "movie_metadata", "movie_title", "TEXT NOT NULL DEFAULT ''");
    ensureColumn(imageGalleryDb, "movie_metadata", "douban_id", "TEXT");
    ensureColumn(imageGalleryDb, "movie_metadata", "douban_url", "TEXT");
    ensureColumn(imageGalleryDb, "movie_metadata", "douban_title", "TEXT");
    ensureColumn(imageGalleryDb, "movie_metadata", "original_title", "TEXT");
    ensureColumn(imageGalleryDb, "movie_metadata", "aka_json", "TEXT");
    ensureColumn(imageGalleryDb, "movie_metadata", "official_site", "TEXT");
    ensureColumn(imageGalleryDb, "movie_metadata", "year", "TEXT");
    ensureColumn(imageGalleryDb, "movie_metadata", "rating", "REAL");
    ensureColumn(imageGalleryDb, "movie_metadata", "rating_count", "INTEGER");
    ensureColumn(imageGalleryDb, "movie_metadata", "rating_stars_json", "TEXT");
    ensureColumn(imageGalleryDb, "movie_metadata", "rating_better_than_json", "TEXT");
    ensureColumn(imageGalleryDb, "movie_metadata", "directors_json", "TEXT");
    ensureColumn(imageGalleryDb, "movie_metadata", "writers_json", "TEXT");
    ensureColumn(imageGalleryDb, "movie_metadata", "genres_json", "TEXT");
    ensureColumn(imageGalleryDb, "movie_metadata", "actors_json", "TEXT");
    ensureColumn(imageGalleryDb, "movie_metadata", "countries_json", "TEXT");
    ensureColumn(imageGalleryDb, "movie_metadata", "languages_json", "TEXT");
    ensureColumn(imageGalleryDb, "movie_metadata", "pubdate", "TEXT");
    ensureColumn(imageGalleryDb, "movie_metadata", "release_dates_json", "TEXT");
    ensureColumn(imageGalleryDb, "movie_metadata", "season_count", "INTEGER");
    ensureColumn(imageGalleryDb, "movie_metadata", "episode_count", "INTEGER");
    ensureColumn(imageGalleryDb, "movie_metadata", "episode_duration", "TEXT");
    ensureColumn(imageGalleryDb, "movie_metadata", "durations_json", "TEXT");
    ensureColumn(imageGalleryDb, "movie_metadata", "imdb_id", "TEXT");
    ensureColumn(imageGalleryDb, "movie_metadata", "info_json", "TEXT");
    ensureColumn(imageGalleryDb, "movie_metadata", "json_ld_json", "TEXT");
    ensureColumn(imageGalleryDb, "movie_metadata", "summary", "TEXT");
    ensureColumn(imageGalleryDb, "movie_metadata", "cover_url", "TEXT");
    ensureColumn(imageGalleryDb, "movie_metadata", "cover_mime", "TEXT");
    ensureColumn(imageGalleryDb, "movie_metadata", "cover_blob", "BLOB");
    ensureColumn(imageGalleryDb, "movie_metadata", "cover_bytes", "INTEGER");
    ensureColumn(imageGalleryDb, "movie_metadata", "source", "TEXT");
    ensureColumn(imageGalleryDb, "movie_metadata", "detail_source", "TEXT");
    ensureColumn(imageGalleryDb, "movie_metadata", "status", "TEXT NOT NULL DEFAULT 'ok'");
    ensureColumn(imageGalleryDb, "movie_metadata", "error", "TEXT");
    ensureColumn(imageGalleryDb, "movie_metadata", "fetched_at", "TEXT");
    ensureColumn(imageGalleryDb, "movie_metadata", "updated_at", "TEXT NOT NULL DEFAULT ''");
    ensureColumn(imageGalleryDb, "gallery_media_covers", "source_path", "TEXT NOT NULL DEFAULT ''");
    ensureColumn(imageGalleryDb, "gallery_media_covers", "source_size", "INTEGER");
    ensureColumn(imageGalleryDb, "gallery_media_covers", "source_mtime_ms", "INTEGER");
    ensureColumn(imageGalleryDb, "gallery_media_covers", "cover_mime", "TEXT");
    ensureColumn(imageGalleryDb, "gallery_media_covers", "cover_blob", "BLOB");
    ensureColumn(imageGalleryDb, "gallery_media_covers", "cover_bytes", "INTEGER");
    ensureColumn(imageGalleryDb, "gallery_media_covers", "generator_version", "INTEGER NOT NULL DEFAULT 1");
    ensureColumn(imageGalleryDb, "gallery_media_covers", "status", "TEXT NOT NULL DEFAULT 'ok'");
    ensureColumn(imageGalleryDb, "gallery_media_covers", "error", "TEXT");
    ensureColumn(imageGalleryDb, "gallery_media_covers", "generated_at", "TEXT");
    ensureColumn(imageGalleryDb, "gallery_media_covers", "updated_at", "TEXT NOT NULL DEFAULT ''");
  }
  return imageGalleryDb;
}

function ensureColumn(db, table, column, definition) {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!rows.some((row) => row.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

function resolveLibraryPersonByPublicId(personId) {
  const value = String(personId || "");
  return library.peopleById.get(value) || null;
}

function resolveLibraryWorkByPublicId(workId) {
  return library.worksById.get(String(workId || "")) || null;
}

function resolveVideoFileByPublicId(videoId) {
  const value = decodeURIComponent(String(videoId || ""));
  const direct = library.filesById.get(value);
  if (direct?.type === "video") return direct;
  return null;
}

function corePersonRow(personId) {
  const coreId = Number(personId);
  if (!Number.isFinite(coreId) || !hasCoreDb()) return null;
  try {
    return getCoreDb().prepare("SELECT * FROM people WHERE id = ?").get(coreId) || null;
  } catch (error) {
    console.warn("[core-person]", error.message);
    return null;
  }
}

function corePersonFallbackRecord(personId) {
  const row = corePersonRow(personId);
  if (!row?.id) return null;
  const sourcePaths = uniqueTextArray([row.folder_path], { maxLength: 260, maxItems: 4 });
  return {
    id: String(row.id),
    name: row.display_name || row.name || String(row.id),
    relativePath: sourcePaths[0] || "",
    sourcePaths,
    sourceCount: sourcePaths.length,
    coverId: null,
    workCount: 0,
    videoCount: 0,
    playableCount: 0,
    imageCount: 0,
    infoCount: 0,
    modifiedAt: row.updated_at || row.created_at || null,
    works: []
  };
}

function coreImageUrl(row) {
  if (!row) return "";
  if (row.image_blob) return `/media/core-image/${encodeURIComponent(String(row.id))}?v=${encodeURIComponent(row.updated_at || "")}`;
  if (row.remote_url) return proxiedRemoteImageUrl(row.remote_url) || row.remote_url || "";
  if (row.local_path) return row.local_path;
  return "";
}

function corePersonAvatarRow(personId, options = {}) {
  const coreId = Number(personId);
  if (!Number.isFinite(coreId) || !hasCoreDb()) return null;
  const source = String(options.source || "").trim();
  try {
    const params = [Number(coreId)];
    if (source) params.push(source);
    return getCoreDb()
      .prepare(
        `
        SELECT *
        FROM images
        WHERE owner_type = 'person'
          AND owner_id = ?
          AND kind = 'avatar'
          ${source ? "AND source = ?" : ""}
        ORDER BY
          CASE WHEN image_blob IS NOT NULL THEN 0 ELSE 1 END,
          CASE WHEN source = 'actor_profiles' THEN 0 ELSE 1 END,
          id ASC
        LIMIT 1
        `
      )
      .get(...params) || null;
  } catch (error) {
    console.warn("[core-image]", error.message);
    return null;
  }
}

function publicPersonAvatar(personId) {
  const row = corePersonAvatarRow(personId);
  const avatarUrl = coreImageUrl(row);
  if (!row || !avatarUrl) return null;
  return {
    personId: String(personId || ""),
    avatarUrl,
    sourceAvatarUrl: row.remote_url || row.local_path || "",
    source: row.source || "",
    updatedAt: row.updated_at || ""
  };
}

function coreWorkCoverRow(workId) {
  const coreId = Number(workId);
  if (!Number.isFinite(coreId) || !hasCoreDb()) return null;
  try {
    return getCoreDb()
      .prepare(
        `
        SELECT *
        FROM images
        WHERE owner_type = 'work'
          AND owner_id = ?
          AND kind = 'cover'
        ORDER BY CASE WHEN image_blob IS NOT NULL THEN 0 ELSE 1 END, sort_order ASC, id ASC
        LIMIT 1
        `
      )
      .get(Number(coreId)) || null;
  } catch (error) {
    console.warn("[core-image]", error.message);
    return null;
  }
}

function publicCoreWorkCover(workId) {
  const row = coreWorkCoverRow(workId);
  const coverUrl = coreImageUrl(row);
  if (!row || !coverUrl) return null;
  return {
    workId: String(workId || ""),
    coverUrl,
    sourceCoverUrl: row.remote_url || row.local_path || "",
    source: row.source || "",
    updatedAt: row.updated_at || ""
  };
}

function coreImageRow(imageId) {
  if (!hasCoreDb()) return null;
  try {
    return getCoreDb().prepare("SELECT * FROM images WHERE id = ?").get(Number(imageId)) || null;
  } catch (error) {
    console.warn("[core-image]", error.message);
    return null;
  }
}

function serveCoreImage(res, imageId) {
  const row = coreImageRow(imageId);
  if (!row?.image_blob) {
    notFound(res);
    return;
  }

  const buffer = Buffer.from(row.image_blob);
  res.writeHead(200, {
    "Content-Type": row.mime || "image/jpeg",
    "Content-Length": buffer.length,
    "Cache-Control": "public, max-age=86400",
    "Content-Disposition": "inline"
  });
  res.end(buffer);
}

function actorProfileRowsById() {
  const stamp = actorProfileStamp();
  if (actorProfileCache?.stamp === stamp) return actorProfileCache.rows;

  const rows = new Map();
  try {
    const db = getCoreDb();
    for (const row of db
      .prepare(
        `
        SELECT
          p.id AS core_person_id,
          CAST(p.id AS TEXT) AS person_id,
          p.name AS person_name,
          p.display_name,
          p.gender,
          p.movie_count,
          p.source,
          p.status,
          p.error,
          p.created_at AS fetched_at,
          p.updated_at,
          ref.external_key AS javdb_actor_id,
          ref.url AS javdb_url,
          avatar.remote_url AS avatar_url,
          avatar.mime AS avatar_mime,
          NULL AS avatar_blob,
          (
            SELECT json_group_array(alias)
            FROM person_aliases pa
            WHERE pa.person_id = p.id
          ) AS aliases_json
        FROM people p
        LEFT JOIN person_external_refs ref
          ON ref.person_id = p.id
         AND ref.provider = 'javdb-actor'
        LEFT JOIN images avatar
          ON avatar.id = (
            SELECT i.id
            FROM images i
            WHERE i.owner_type = 'person'
              AND i.owner_id = p.id
              AND i.kind = 'avatar'
              AND i.source = 'actor_profiles'
            ORDER BY CASE WHEN i.image_blob IS NOT NULL THEN 0 ELSE 1 END, i.id ASC
            LIMIT 1
          )
        WHERE ref.external_key IS NOT NULL
           OR avatar.id IS NOT NULL
           OR EXISTS (SELECT 1 FROM person_aliases pa WHERE pa.person_id = p.id)
           OR COALESCE(NULLIF(LOWER(TRIM(p.gender)), ''), 'unknown') <> 'unknown'
        `
      )
      .all()) {
      rows.set(String(row.core_person_id), { ...row, person_id: String(row.core_person_id) });
    }
  } catch (error) {
    console.warn("[core-actor-profile]", error.message);
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

  const aliases = uniquePersonNames([...actorProfileAliases(row), ...mergedPersonAliasNames(row.person_id)]);
  const displayName = preferredPersonDisplayName(row, row.person_name);
  const avatar = publicPersonAvatar(row.person_id);
  const avatarUrl = avatar?.avatarUrl || (row.avatar_blob ? `/media/actor/${encodeURIComponent(row.person_id)}/avatar?v=${encodeURIComponent(row.updated_at || "")}` : "");

  return {
    personId: String(row.person_id || ""),
    personName: row.person_name,
    javdbActorId: row.javdb_actor_id || "",
    javdbUrl: row.javdb_url || "",
    displayName,
    aliases,
    gender: normalizePersonGender(row.gender),
    movieCount: row.movie_count ?? null,
    avatarUrl,
    sourceAvatarUrl: avatar?.sourceAvatarUrl || row.avatar_url || "",
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
  const coreRow = coreWorkCoverRow(workId);
  if (!coreRow?.image_blob) return null;
  const work = resolveLibraryWorkByPublicId(workId);
  return {
    work_id: work?.id || String(workId || ""),
    person_id: work?.personId || "",
    person_name: work ? library.peopleById.get(work.personId)?.name || "" : "",
    video_id: work?.videos?.[0]?.id || "",
    title: work?.title || "",
    cover_url: coreRow.remote_url || coreRow.local_path || "",
    cover_mime: coreRow.mime || "image/jpeg",
    cover_blob: coreRow.image_blob,
    source: coreRow.source || "",
    fetched_at: coreRow.created_at || "",
    updated_at: coreRow.updated_at || ""
  };
}

function publicWorkCover(row) {
  if (!row?.cover_blob) return null;

  const coreRow = coreWorkCoverRow(row.work_id);
  const coverUrl = coreImageUrl(coreRow) || `/media/work/${encodeURIComponent(row.work_id)}/cover?v=${encodeURIComponent(row.updated_at || "")}`;
  return {
    workId: String(row.work_id || ""),
    personId: String(row.person_id || ""),
    videoId: row.video_id || "",
    title: row.title || "",
    coverUrl,
    sourceCoverUrl: row.cover_url || "",
    source: row.source || "",
    fetchedAt: row.fetched_at || "",
    updatedAt: row.updated_at || ""
  };
}

function cachedWorkCoverIds() {
  try {
    const rows = getCoreDb()
      .prepare(
        `
        SELECT CAST(i.owner_id AS TEXT) AS work_id
        FROM images i
        WHERE i.owner_type = 'work'
          AND i.kind = 'cover'
          AND i.image_blob IS NOT NULL
          AND length(i.image_blob) > 0
        `
      )
      .all();
    return new Set(rows.map((row) => row.work_id));
  } catch (error) {
    console.warn("[core-work-cover]", error.message);
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
  const coreWorkId = Number(work.id);
  getCoreDb()
    .prepare(
      `
      INSERT INTO images (
        owner_type, owner_id, kind, source_type, local_path, mime, image_blob,
        byte_size, sort_order, status, source, legacy_table, legacy_key, created_at, updated_at
      ) VALUES ('work', ?, 'cover', 'generated', ?, ?, ?, ?, 0, 'ok', ?, 'generated', ?, ?, ?)
      ON CONFLICT DO UPDATE SET
        mime = excluded.mime,
        image_blob = excluded.image_blob,
        byte_size = excluded.byte_size,
        status = excluded.status,
        source = excluded.source,
        legacy_table = excluded.legacy_table,
        legacy_key = excluded.legacy_key,
        updated_at = excluded.updated_at
      `
    )
    .run(
      coreWorkId,
      video.relativePath || video.path || "",
      "image/jpeg",
      coverBlob,
      coverBlob.length,
      "ffmpeg-frame",
      work.id,
      now,
      now
    );

  workInfoCache = null;
  workSearchTextCache = null;
  return publicCoreWorkCover(work.id) || publicWorkCover(workCoverRow(work.id));
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
    const tableMap = {
      actor_profiles: "people",
      actor_movies: "work_people",
      work_info: "works",
      work_covers: "images",
      javdb_rankings: "collection_items",
      local_image_cache: "local_image_cache",
      remote_image_cache: "remote_image_cache"
    };
    const safeTable = tableMap[table] || table;
    if (!/^[A-Za-z0-9_]+$/.test(safeTable)) throw new Error(`Invalid table: ${table}`);
    const row = getCoreDb().prepare(`SELECT COUNT(*) AS count, COALESCE(MAX(updated_at), '') AS updated_at FROM ${safeTable}`).get();
    const stamp = `${Number(row?.count || 0)}:${row?.updated_at || ""}`;
    tableStampCache.set(table, { checkedAt: now, stamp });
    return stamp;
  } catch (error) {
    console.warn("[core-db-stamp]", table, error.message);
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
    const db = getCoreDb();
    for (const row of db
      .prepare(
        `
        SELECT
          CAST(w.id AS TEXT) AS work_id,
          CAST(p.id AS TEXT) AS person_id,
          COALESCE(p.name, '') AS person_name,
          lw.source_info_id,
          lw.source_name,
          lw.source_info_path AS source_path,
          lw.source_size,
          lw.source_mtime,
          w.code,
          w.title,
          w.release_date,
          w.duration_minutes,
          w.rating,
          w.rating_count,
          w.director,
          maker.name AS maker,
          label.name AS label,
          series.name AS series,
          vref.url AS javdb_url,
          cover.remote_url AS image_url,
          (
            SELECT json_group_array(i.remote_url)
            FROM images i
            WHERE i.owner_type = 'work'
              AND i.owner_id = w.id
              AND i.kind = 'preview'
              AND i.remote_url IS NOT NULL
              AND i.remote_url <> ''
          ) AS preview_images_json,
          NULL AS preview_video_url,
          (
            SELECT json_group_array(pp.name)
            FROM work_people wpa
            JOIN people pp ON pp.id = wpa.person_id
            WHERE wpa.work_id = w.id
              AND wpa.role = 'actor'
          ) AS actors_json,
          (
            SELECT json_group_array(json_object('name', pp.name, 'url', COALESCE(pref.url, '')))
            FROM work_people wpa
            JOIN people pp ON pp.id = wpa.person_id
            LEFT JOIN person_external_refs pref
              ON pref.person_id = pp.id
             AND pref.provider = 'javdb-actor'
            WHERE wpa.work_id = w.id
              AND wpa.role = 'actor'
          ) AS actor_links_json,
          '[]' AS tags_json,
          '[]' AS tag_links_json,
          maker_ref.url AS maker_url,
          label_ref.url AS label_url,
          series_ref.url AS series_url,
          w.fields_json,
          w.raw_text,
          0 AS raw_truncated,
          w.status,
          w.error,
          w.updated_at
        FROM works w
        LEFT JOIN local_works lw ON lw.work_id = w.id
        LEFT JOIN work_people wp ON wp.work_id = w.id AND wp.role = 'actor'
        LEFT JOIN people p ON p.id = wp.person_id
        LEFT JOIN work_external_refs vref ON vref.work_id = w.id AND vref.provider = 'javdb-video'
        LEFT JOIN images cover
          ON cover.id = (
            SELECT i.id
            FROM images i
            WHERE i.owner_type = 'work'
              AND i.owner_id = w.id
              AND i.kind = 'cover'
            ORDER BY CASE WHEN i.image_blob IS NOT NULL THEN 0 ELSE 1 END, i.id ASC
            LIMIT 1
          )
        LEFT JOIN work_makers maker_link ON maker_link.work_id = w.id AND maker_link.role = 'maker'
        LEFT JOIN makers maker ON maker.id = maker_link.maker_id
        LEFT JOIN maker_external_refs maker_ref ON maker_ref.maker_id = maker.id AND maker_ref.provider = 'javdb-maker'
        LEFT JOIN work_makers label_link ON label_link.work_id = w.id AND label_link.role = 'label'
        LEFT JOIN makers label ON label.id = label_link.maker_id
        LEFT JOIN maker_external_refs label_ref ON label_ref.maker_id = label.id AND label_ref.provider = 'javdb-maker'
        LEFT JOIN work_series ws ON ws.work_id = w.id
        LEFT JOIN series ON series.id = ws.series_id
        LEFT JOIN series_external_refs series_ref ON series_ref.series_id = series.id AND series_ref.provider = 'javdb-series'
        WHERE w.status = 'ok'
          AND lw.id IS NOT NULL
        GROUP BY w.id
        `
      )
      .all()) {
      rows.set(row.work_id, row);
    }
  } catch (error) {
    console.warn("[core-work-info]", error.message);
    if (workInfoCache?.rows) return workInfoCache.rows;
  }

  workInfoCache = { stamp, rows };
  return rows;
}

function workInfoRow(workId) {
  return workInfoRowsById().get(workId) || null;
}

function studioCatalogStamp() {
  return `${library.scannedAt || ""}:${workInfoStamp()}:studio-v1`;
}

function normalizeStudioName(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function workCodePrefix(value) {
  const code = normalizeWorkCode(value) || String(value || "").trim();
  const match = /^([A-Za-z0-9]{2,12})[-_]/.exec(code);
  return match ? match[1].toUpperCase() : "";
}

function studioMakerId(name, url = "") {
  return createId("mk", `${normalizeStudioName(name)}|${publicRemoteUrl(url)}`);
}

function studioSeriesId(makerId, name, kind = "series", url = "") {
  return createId("sr", `${makerId}|${normalizeStudioName(name)}|${kind}|${publicRemoteUrl(url)}`);
}

function countLocalWork(workId) {
  return library.worksById.has(workId) ? 1 : 0;
}

function dateRangePush(stats, releaseDate) {
  const value = String(releaseDate || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return;
  if (!stats.firstReleaseDate || value < stats.firstReleaseDate) stats.firstReleaseDate = value;
  if (!stats.latestReleaseDate || value > stats.latestReleaseDate) stats.latestReleaseDate = value;
}

function incrementStudioStats(stats, row) {
  stats.workCount += 1;
  stats.localWorkCount += countLocalWork(row.work_id);
  dateRangePush(stats, row.release_date);
}

function incrementPrefixStats(stats, row) {
  stats.workCount += 1;
  stats.localWorkCount += countLocalWork(row.work_id);
}

function ensureStudioCatalog({ force = false } = {}) {
  const stamp = studioCatalogStamp();
  if (!force && studioHierarchyCache?.stamp === stamp) return studioHierarchyCache;
  const db = getCoreDb();
  const counts = db
    .prepare(
      `
      SELECT
        (SELECT COUNT(*) FROM makers) AS maker_count,
        (SELECT COUNT(*) FROM series) AS series_count,
        (SELECT COUNT(*) FROM work_makers) AS link_count
      `
    )
    .get();
  studioHierarchyCache = {
    stamp,
    makerCount: Number(counts?.maker_count || 0),
    seriesCount: Number(counts?.series_count || 0),
    prefixCount: 0,
    linkCount: Number(counts?.link_count || 0),
    syncedAt: new Date().toISOString()
  };
  return studioHierarchyCache;
}

function studioPrefixRowsForMaker(makerId) {
  return [];
}

function studioSeriesRowsForMaker(makerId) {
  return getCoreDb()
    .prepare(
      `
      SELECT
        CAST(s.id AS TEXT) AS series_id,
        CAST(s.maker_id AS TEXT) AS maker_id,
        s.name,
        s.name_search AS normalized_name,
        s.kind,
        ref.url AS javdb_url,
        '' AS primary_prefix,
        s.source,
        COUNT(DISTINCT ws.work_id) AS work_count,
        COUNT(DISTINCT lw.work_id) AS local_work_count,
        MIN(w.release_date) AS first_release_date,
        MAX(w.release_date) AS latest_release_date
      FROM series s
      LEFT JOIN series_external_refs ref ON ref.series_id = s.id
      LEFT JOIN work_series ws ON ws.series_id = s.id
      LEFT JOIN works w ON w.id = ws.work_id
      LEFT JOIN local_works lw ON lw.work_id = ws.work_id
      WHERE maker_id = ?
      GROUP BY s.id
      ORDER BY work_count DESC, s.name
      `
    )
    .all(Number(makerId));
}

function publicStudioSeries(row, prefixRows = []) {
  const prefixes = prefixRows
    .filter((item) => item.series_id === row.series_id)
    .map((item) => ({
      prefix: item.prefix,
      source: item.source || "",
      confidence: item.confidence ?? 1,
      workCount: item.work_count || 0,
      localWorkCount: item.local_work_count || 0
    }));
  return {
    id: row.series_id,
    makerId: row.maker_id,
    name: row.name || "",
    kind: row.kind || "series",
    url: publicRemoteUrl(row.javdb_url),
    primaryPrefix: row.primary_prefix || prefixes[0]?.prefix || "",
    prefixes,
    source: row.source || "",
    workCount: row.work_count || 0,
    localWorkCount: row.local_work_count || 0,
    firstReleaseDate: row.first_release_date || "",
    latestReleaseDate: row.latest_release_date || ""
  };
}

function publicStudioMaker(row, seriesRows = [], prefixRows = []) {
  return {
    id: row.maker_id,
    name: row.name || "",
    url: publicRemoteUrl(row.javdb_url),
    source: row.source || "",
    workCount: row.work_count || 0,
    localWorkCount: row.local_work_count || 0,
    firstReleaseDate: row.first_release_date || "",
    latestReleaseDate: row.latest_release_date || "",
    series: seriesRows.map((seriesRow) => publicStudioSeries(seriesRow, prefixRows)),
    prefixes: prefixRows
      .filter((item) => !item.series_id)
      .map((item) => ({
        prefix: item.prefix,
        source: item.source || "",
        confidence: item.confidence ?? 1,
        workCount: item.work_count || 0,
        localWorkCount: item.local_work_count || 0
      }))
  };
}

function studioSummaries(url) {
  const sync = ensureStudioCatalog();
  const limit = clampInteger(url.searchParams.get("limit"), 120, 1, 1000);
  const q = String(url.searchParams.get("q") || "").trim().toLowerCase();
  const rows = getCoreDb()
    .prepare(
      `
      SELECT
        CAST(m.id AS TEXT) AS maker_id,
        m.name,
        m.name_search AS normalized_name,
        ref.url AS javdb_url,
        m.source,
        COUNT(DISTINCT wm.work_id) AS work_count,
        COUNT(DISTINCT lw.work_id) AS local_work_count,
        MIN(w.release_date) AS first_release_date,
        MAX(w.release_date) AS latest_release_date
      FROM makers m
      LEFT JOIN maker_external_refs ref ON ref.maker_id = m.id
      LEFT JOIN work_makers wm ON wm.maker_id = m.id
      LEFT JOIN works w ON w.id = wm.work_id
      LEFT JOIN local_works lw ON lw.work_id = wm.work_id
      WHERE (? = '' OR m.name_search LIKE ? OR m.name LIKE ?)
      GROUP BY m.id
      ORDER BY work_count DESC, name
      LIMIT ?
      `
    )
    .all(q, `%${q}%`, `%${q}%`, limit);
  const makers = rows.map((row) => publicStudioMaker(row, studioSeriesRowsForMaker(row.maker_id), studioPrefixRowsForMaker(row.maker_id)));
  return { sync, count: makers.length, makers };
}

function studioDetailPayload(makerId, url) {
  const sync = ensureStudioCatalog();
  const db = getCoreDb();
  const row = db
    .prepare(
      `
      SELECT
        CAST(m.id AS TEXT) AS maker_id,
        m.name,
        m.name_search AS normalized_name,
        ref.url AS javdb_url,
        m.source,
        COUNT(DISTINCT wm.work_id) AS work_count,
        COUNT(DISTINCT lw.work_id) AS local_work_count,
        MIN(w.release_date) AS first_release_date,
        MAX(w.release_date) AS latest_release_date
      FROM makers m
      LEFT JOIN maker_external_refs ref ON ref.maker_id = m.id
      LEFT JOIN work_makers wm ON wm.maker_id = m.id
      LEFT JOIN works w ON w.id = wm.work_id
      LEFT JOIN local_works lw ON lw.work_id = wm.work_id
      WHERE m.id = ?
      GROUP BY m.id
      `
    )
    .get(Number(makerId));
  if (!row) return null;
  const seriesRows = studioSeriesRowsForMaker(makerId);
  const prefixRows = studioPrefixRowsForMaker(makerId);
  const selectedSeriesId = String(url.searchParams.get("seriesId") || "all").trim() || "all";
  const filterBySeries = selectedSeriesId !== "all";
  const linkRows = filterBySeries
    ? db.prepare("SELECT DISTINCT CAST(wm.work_id AS TEXT) AS work_id FROM work_makers wm JOIN work_series ws ON ws.work_id = wm.work_id JOIN local_works lw ON lw.work_id = wm.work_id WHERE wm.maker_id = ? AND ws.series_id = ?").all(Number(makerId), Number(selectedSeriesId))
    : db.prepare("SELECT DISTINCT CAST(wm.work_id AS TEXT) AS work_id FROM work_makers wm JOIN local_works lw ON lw.work_id = wm.work_id WHERE wm.maker_id = ?").all(Number(makerId));
  const works = enrichLocalWorksWithActorMovieIndex(linkRows.map((item) => library.worksById.get(item.work_id)).filter(Boolean));
  const sorted = sortWorkList(works, url.searchParams.get("sort") || "releaseDesc");
  return {
    sync,
    studio: publicStudioMaker(row, seriesRows, prefixRows),
    selectedSeriesId,
    ...pagedWorksPayload(sorted, url, { facets: workFacets(works) })
  };
}

function actorMovieRowsByPerson() {
  const stamp = actorMovieStamp();
  if (actorMovieCache?.stamp === stamp) return actorMovieCache.rows;

  const rowsByPerson = new Map();
  try {
    const db = getCoreDb();
    const rows = db
      .prepare(
        `
        SELECT
          CAST(p.id AS TEXT) AS person_id,
          p.name AS person_name,
          pref.external_key AS javdb_actor_id,
          pref.url AS actor_url,
          w.code,
          w.code_search AS code_key,
          w.title,
          wref.url AS detail_url,
          cover.remote_url AS image_url,
          w.release_date,
          w.rating,
          w.rating_count,
          w.has_magnet,
          w.is_streamable,
          w.has_subtitles,
          w.javdb_tags_json,
          0 AS page_index,
          wp.sort_order AS position_index,
          wp.created_at AS fetched_at,
          wp.updated_at
        FROM work_people wp
        JOIN people p ON p.id = wp.person_id
        JOIN works w ON w.id = wp.work_id
        LEFT JOIN person_external_refs pref
          ON pref.person_id = p.id
         AND pref.provider = 'javdb-actor'
        LEFT JOIN work_external_refs wref
          ON wref.work_id = w.id
         AND wref.provider = 'javdb-video'
        LEFT JOIN images cover
          ON cover.id = (
            SELECT i.id
            FROM images i
            WHERE i.owner_type = 'work'
              AND i.owner_id = w.id
              AND i.kind = 'cover'
            ORDER BY CASE WHEN i.source = 'actor_movies' THEN 0 ELSE 1 END, i.id ASC
            LIMIT 1
          )
        WHERE wp.source = 'actor_movies'
        ORDER BY person_id, COALESCE(position_index, 999999), code
        `
      )
      .all();
    for (const row of rows) {
      const personId = String(row.person_id || "");
      if (!rowsByPerson.has(personId)) rowsByPerson.set(personId, []);
      rowsByPerson.get(personId).push({ ...row, person_id: personId });
    }
  } catch (error) {
    console.warn("[core-actor-movies]", error.message);
    if (actorMovieCache?.rows) return actorMovieCache.rows;
  }

  actorMovieCache = { stamp, rows: rowsByPerson };
  return rowsByPerson;
}

function actorMovieRows(personId) {
  return actorMovieRowsByPerson().get(personId) || [];
}

function looksLikeVrPersonMergeText(value) {
  return /(^|[\\/[\]【】()\s._-])vr($|[\\/[\]【】()\s._-])/i.test(String(value || ""));
}

function personHasVrMergeContent(person) {
  if (!person) return false;
  const paths = [person.relativePath, ...(person.sourcePaths || [])];
  if (paths.some(looksLikeVrPersonMergeText)) return true;
  return (person.works || [])
    .map((workId) => library.worksById.get(workId))
    .filter(Boolean)
    .some((work) => looksLikeVrPersonMergeText(`${work.title || ""}\n${work.directoryName || ""}\n${work.relativePath || ""}`));
}

function personMergeStamp() {
  return `${library.scannedAt || ""}:${actorProfileStamp()}:${actorMovieStamp()}`;
}

function preferCanonicalMergePerson(a, b) {
  const aF = (a.sourcePaths || []).some((item) => /^f:\//i.test(String(item || "").replaceAll("\\", "/")));
  const bF = (b.sourcePaths || []).some((item) => /^f:\//i.test(String(item || "").replaceAll("\\", "/")));
  return (
    Number(bF) - Number(aF) ||
    actorMovieRows(b.id).length - actorMovieRows(a.id).length ||
    Number(b.workCount || 0) - Number(a.workCount || 0) ||
    Number(b.sourceCount || 0) - Number(a.sourceCount || 0) ||
    String(a.name || "").localeCompare(String(b.name || ""), undefined, { numeric: true, sensitivity: "base" })
  );
}

function personMergeMaps() {
  const stamp = personMergeStamp();
  if (personMergeCache?.stamp === stamp) return personMergeCache.maps;

  const parent = new Map();
  const ensureParent = (personId) => {
    if (!parent.has(personId)) parent.set(personId, personId);
  };
  const find = (personId) => {
    ensureParent(personId);
    const next = parent.get(personId);
    if (next === personId) return personId;
    const root = find(next);
    parent.set(personId, root);
    return root;
  };
  const union = (a, b) => {
    const rootA = find(a);
    const rootB = find(b);
    if (rootA !== rootB) parent.set(rootB, rootA);
  };
  for (const person of library.people) ensureParent(person.id);

  const byActorId = new Map();
  for (const person of library.people) {
    const actorId = String(actorProfileRow(person.id)?.javdb_actor_id || "").trim();
    if (!actorId) continue;
    if (!byActorId.has(actorId)) byActorId.set(actorId, []);
    byActorId.get(actorId).push(person);
  }

  for (const people of byActorId.values()) {
    if (people.length < 2 || people.some(personHasVrMergeContent)) continue;
    for (const person of people.slice(1)) union(people[0].id, person.id);
  }

  const aliasOwners = new Map();
  for (const person of library.people) {
    const row = actorProfileRow(person.id);
    if (!row) continue;
    for (const alias of actorProfileAliases(row)) {
      const key = normalizePersonSearchValue(alias);
      if (!key) continue;
      if (!aliasOwners.has(key)) aliasOwners.set(key, []);
      aliasOwners.get(key).push(person);
    }
  }

  for (const person of library.people) {
    const key = normalizePersonSearchValue(person.name);
    const owners = aliasOwners.get(key) || [];
    for (const owner of owners) {
      if (owner.id === person.id) continue;
      const ownerActorId = String(actorProfileRow(owner.id)?.javdb_actor_id || "").trim();
      const personActorId = String(actorProfileRow(person.id)?.javdb_actor_id || "").trim();
      if (ownerActorId && personActorId && ownerActorId !== personActorId) continue;
      union(owner.id, person.id);
    }
  }

  const components = new Map();
  for (const person of library.people) {
    const root = find(person.id);
    if (!components.has(root)) components.set(root, []);
    components.get(root).push(person);
  }

  const aliasToCanonical = new Map();
  const groupsByCanonical = new Map();
  for (const people of components.values()) {
    if (people.length < 2) continue;
    const canonical = [...people].sort(preferCanonicalMergePerson)[0];
    const memberIds = people.map((person) => person.id);
    groupsByCanonical.set(canonical.id, memberIds);
    for (const memberId of memberIds) aliasToCanonical.set(memberId, canonical.id);
  }

  const maps = { aliasToCanonical, groupsByCanonical };
  personMergeCache = { stamp, maps };
  return maps;
}

function canonicalPersonId(personId) {
  const id = String(personId || "");
  return personMergeMaps().aliasToCanonical.get(id) || id;
}

function mergedPersonMembers(personId) {
  const canonicalId = canonicalPersonId(personId);
  const ids = personMergeMaps().groupsByCanonical.get(canonicalId) || [canonicalId];
  return ids.map((id) => library.peopleById.get(id)).filter(Boolean);
}

function mergedPersonAliasNames(personId) {
  const canonicalId = canonicalPersonId(personId);
  const canonicalRow = actorProfileRow(canonicalId);
  const primary = new Set(
    uniquePersonNames([
      library.peopleById.get(canonicalId)?.name,
      canonicalRow?.person_name,
      canonicalRow?.display_name
    ]).map(normalizePersonSearchValue)
  );
  const names = [];
  for (const person of mergedPersonMembers(canonicalId)) {
    const row = actorProfileRow(person.id);
    names.push(person.name, row?.person_name, row?.display_name, ...actorProfileAliases(row));
  }
  return uniquePersonNames(names).filter((name) => {
    const key = normalizePersonSearchValue(name);
    return key && !primary.has(key);
  });
}

function mergedActorMovieRows(personId) {
  const rows = [];
  const seen = new Set();
  for (const person of mergedPersonMembers(personId)) {
    for (const row of actorMovieRows(person.id)) {
      const key = storedWorkCodeKey(row.code_key) || looseWorkCodeKey(row.code) || row.detail_url || `${row.person_id}:${row.code}:${row.title}`;
      if (key && seen.has(key)) continue;
      if (key) seen.add(key);
      rows.push(row);
    }
  }
  return rows;
}

function mergedPersonRecord(person) {
  if (!person) return null;
  const canonicalId = canonicalPersonId(person.id);
  const canonical = library.peopleById.get(canonicalId) || person;
  const members = mergedPersonMembers(canonicalId);
  if (members.length <= 1) return canonical;

  const sourcePaths = [];
  const sourceSeen = new Set();
  const addSourcePath = (value) => {
    const text = String(value || "").trim();
    const key = normalizeSourcePath(text);
    if (!text || !key || sourceSeen.has(key)) return;
    sourceSeen.add(key);
    sourcePaths.push(text);
  };
  for (const member of [canonical, ...members.filter((item) => item.id !== canonical.id)]) {
    for (const sourcePath of [...(member.sourcePaths || []), member.relativePath]) addSourcePath(sourcePath);
  }

  const works = [];
  const workSeen = new Set();
  for (const member of [canonical, ...members.filter((item) => item.id !== canonical.id)]) {
    for (const workId of member.works || []) {
      if (!workId || workSeen.has(workId)) continue;
      workSeen.add(workId);
      works.push(workId);
    }
  }

  const workRows = works.map((workId) => library.worksById.get(workId)).filter(Boolean);
  const modifiedAt = members
    .map((member) => member.modifiedAt)
    .filter(Boolean)
    .sort()
    .at(-1) || canonical.modifiedAt;

  return {
    ...canonical,
    relativePath: sourcePaths[0] || canonical.relativePath,
    sourcePaths,
    sourceCount: sourcePaths.length,
    works,
    workCount: works.length,
    videoCount: workRows.reduce((sum, work) => sum + Number(work.videoCount || 0), 0),
    playableCount: workRows.reduce((sum, work) => sum + Number(work.playableCount || 0), 0),
    imageCount: workRows.reduce((sum, work) => sum + Number(work.imageCount || 0), 0),
    infoCount: workRows.reduce((sum, work) => sum + Number(work.infoCount || 0), 0),
    modifiedAt
  };
}

function mainLibraryPeople() {
  const people = [];
  const seen = new Set();
  for (const person of library.people) {
    const merged = mergedPersonRecord(person);
    if (!merged || seen.has(merged.id)) continue;
    seen.add(merged.id);
    if (shouldShowPersonInMainList(merged)) people.push(merged);
  }
  return people;
}

function shouldShowPersonInMainList(person) {
  if (!person) return false;
  if (Number(person.workCount || 0) > 0) return true;
  if (actorProfileRow(person.id)) return true;
  return mergedActorMovieRows(person.id).length > 0;
}

function displayPersonForWork(personId) {
  return mergedPersonRecord(library.peopleById.get(canonicalPersonId(personId)));
}

function actorMovieRowsByCodeKey() {
  const stamp = actorMovieStamp();
  if (actorMovieByCodeKeyCache?.stamp === stamp) return actorMovieByCodeKeyCache.rows;

  const rows = new Map();
  for (const personRows of actorMovieRowsByPerson().values()) {
    for (const row of personRows) {
      const codeKey = storedWorkCodeKey(row.code_key) || looseWorkCodeKey(row.code);
      if (codeKey && !rows.has(codeKey)) rows.set(codeKey, row);
    }
  }

  actorMovieByCodeKeyCache = { stamp, rows };
  return rows;
}

function actorMovieRowsForWorks(works = []) {
  if (!works.length) return [];
  const rowsByCodeKey = actorMovieRowsByCodeKey();
  if (!rowsByCodeKey.size) return [];

  const rows = [];
  const seen = new Set();
  for (const work of works) {
    for (const codeKey of workCodeKeys(work)) {
      if (!codeKey || seen.has(codeKey)) continue;
      const row = rowsByCodeKey.get(codeKey);
      if (!row) continue;
      seen.add(codeKey);
      rows.push(row);
      break;
    }
  }
  return rows;
}

function enrichLocalWorksWithActorMovieIndex(localWorks) {
  return enrichLocalWorksWithActorMovieInfo(localWorks, actorMovieRowsForWorks(localWorks));
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
    const rows = getCoreDb()
      .prepare(
        `
        SELECT
          c.id AS collection_id,
          c.name AS list_label,
          c.source_key,
          COUNT(ci.work_id) AS total,
          MAX(ci.updated_at) AS updated_at,
          MAX(c.source_url) AS page_url
        FROM collections c
        JOIN collection_items ci ON ci.collection_id = c.id
        WHERE c.type = 'ranking'
        GROUP BY c.id
        ORDER BY
          CASE WHEN c.source_key GLOB 'top:y[0-9][0-9][0-9][0-9]' THEN 0 ELSE 1 END,
          c.source_key DESC
        `
      )
      .all();

    for (const row of rows) {
      const { listType, listKey } = rankingSourceParts(row.source_key);
      const listRows = getCoreDb()
        .prepare(
          `
          SELECT w.code_search AS code_key
          FROM collection_items ci
          JOIN works w ON w.id = ci.work_id
          WHERE ci.collection_id = ?
          `
        )
        .all(row.collection_id);
      const localTotal = listRows.filter((item) => localKeys.has(storedWorkCodeKey(item.code_key))).length;
      summaries.push({
        type: listType,
        key: listKey,
        label: rankingListLabel(listType, listKey, row.list_label),
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

function rankingSourceParts(sourceKey = "") {
  const [listType = "top", ...rest] = String(sourceKey || "top:").split(":");
  return { listType: listType || "top", listKey: rest.join(":") || "" };
}

function rankingRows(listType = "top", listKey = "") {
  try {
    return getCoreDb()
      .prepare(
        `
        SELECT
          ? AS list_type,
          ? AS list_key,
          c.name AS list_label,
          ci.rank_no,
          w.code,
          w.code_search AS code_key,
          COALESCE(ci.title_snapshot, w.title) AS title,
          wref.url AS detail_url,
          cover.remote_url AS image_url,
          w.release_date,
          COALESCE(ci.rating_snapshot, w.rating) AS rating,
          COALESCE(ci.rating_count_snapshot, w.rating_count) AS rating_count,
          c.source_url AS page_url,
          ci.fetched_at,
          ci.updated_at
        FROM collections c
        JOIN collection_items ci ON ci.collection_id = c.id
        JOIN works w ON w.id = ci.work_id
        LEFT JOIN work_external_refs wref ON wref.work_id = w.id AND wref.provider = 'javdb-video'
        LEFT JOIN images cover
          ON cover.id = (
            SELECT i.id
            FROM images i
            WHERE i.owner_type = 'work'
              AND i.owner_id = w.id
              AND i.kind = 'cover'
            ORDER BY CASE WHEN i.source = 'javdb_rankings' THEN 0 ELSE 1 END, i.id ASC
            LIMIT 1
          )
        WHERE c.type = 'ranking'
          AND c.source_key = ?
        ORDER BY ci.rank_no ASC, w.code ASC
        `
      )
      .all(listType, listKey || "", `${listType}:${listKey || ""}`);
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
      ratingCount: row.rating_count ?? null,
      hasMagnet: dbBoolOrNull(row.has_magnet),
      isStreamable: dbBoolOrNull(row.is_streamable),
      hasSubtitles: dbBoolOrNull(row.has_subtitles),
      javdbTags: parseJsonTextArray(row.javdb_tags_json)
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
    const rows = getCoreDb()
      .prepare(
        `
        SELECT
          substr(c.source_key, 1, instr(c.source_key || ':', ':') - 1) AS list_type,
          substr(c.source_key, instr(c.source_key || ':', ':') + 1) AS list_key,
          c.name AS list_label,
          ci.rank_no,
          w.code,
          w.code_search AS code_key,
          COALESCE(ci.title_snapshot, w.title) AS title,
          wref.url AS detail_url,
          cover.remote_url AS image_url,
          w.release_date,
          COALESCE(ci.rating_snapshot, w.rating) AS rating,
          COALESCE(ci.rating_count_snapshot, w.rating_count) AS rating_count,
          c.source_url AS page_url,
          ci.fetched_at,
          ci.updated_at
        FROM collections c
        JOIN collection_items ci ON ci.collection_id = c.id
        JOIN works w ON w.id = ci.work_id
        LEFT JOIN work_external_refs wref ON wref.work_id = w.id AND wref.provider = 'javdb-video'
        LEFT JOIN images cover
          ON cover.id = (
            SELECT i.id
            FROM images i
            WHERE i.owner_type = 'work'
              AND i.owner_id = w.id
              AND i.kind = 'cover'
            ORDER BY CASE WHEN i.source = 'javdb_rankings' THEN 0 ELSE 1 END, i.id ASC
            LIMIT 1
          )
        WHERE c.type = 'ranking'
        ORDER BY ci.rank_no ASC, ci.updated_at DESC, c.source_key DESC, w.code ASC
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
    infoSummary: actorMovieInfoSummary(row, code)
  };
}

function coreMissingWorkFromRow(person, row) {
  const code = normalizeWorkCode(row.code) || row.code || "";
  const title = row.title && row.title !== row.code ? row.title : code || row.title || "未下载作品";
  return {
    id: String(row.work_id || row.id || ""),
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
    modifiedAt: row.updated_at || "",
    missingLocal: true,
    javdbUrl: publicRemoteUrl(row.detail_url),
    actorUrl: row.actor_url || "",
    infoSummary: {
      code,
      title: row.title || "",
      javdbUrl: publicRemoteUrl(row.detail_url),
      releaseDate: row.release_date || "",
      durationMinutes: row.duration_minutes ?? null,
      rating: row.rating ?? null,
      ratingCount: row.rating_count ?? null,
      hasMagnet: dbBoolOrNull(row.has_magnet),
      isStreamable: dbBoolOrNull(row.is_streamable),
      hasSubtitles: dbBoolOrNull(row.has_subtitles),
      javdbTags: parseJsonTextArray(row.javdb_tags_json)
    }
  };
}

function coreMissingWorksForPerson(person, excludedCodeKeys = new Set()) {
  if (!person?.id || !hasCoreDb()) return [];
  const corePersonId = Number(person.id);
  if (!Number.isFinite(corePersonId)) return [];

  try {
    const rows = getCoreDb()
      .prepare(
        `
        SELECT
          w.id AS work_id,
          w.code,
          w.code_search AS code_key,
          w.title,
          w.release_date,
          w.duration_minutes,
          w.rating,
          w.rating_count,
          w.has_magnet,
          w.is_streamable,
          w.has_subtitles,
          w.javdb_tags_json,
          w.updated_at,
          wref.url AS detail_url,
          pref.url AS actor_url,
          cover.remote_url AS image_url
        FROM work_people wp
        JOIN works w ON w.id = wp.work_id
        LEFT JOIN work_external_refs wref
          ON wref.work_id = w.id
         AND wref.provider = 'javdb-video'
        LEFT JOIN person_external_refs pref
          ON pref.person_id = wp.person_id
         AND pref.provider = 'javdb-actor'
        LEFT JOIN images cover
          ON cover.id = (
            SELECT i.id
            FROM images i
            WHERE i.owner_type = 'work'
              AND i.owner_id = w.id
              AND i.kind = 'cover'
            ORDER BY CASE WHEN i.image_blob IS NOT NULL THEN 0 ELSE 1 END, i.id ASC
            LIMIT 1
          )
        WHERE wp.person_id = ?
          AND wp.role = 'actor'
          AND NOT EXISTS (
            SELECT 1
            FROM local_works lw
            WHERE lw.work_id = w.id
          )
        ORDER BY COALESCE(w.release_date, '') DESC, w.id DESC
        `
      )
      .all(corePersonId);
    const localKeys = combinedLocalWorkCodeKeys(excludedCodeKeys);
    return rows
      .filter((row) => {
        const codeKey = storedWorkCodeKey(row.code_key) || looseWorkCodeKey(row.code);
        return !codeKey || !localKeys.has(codeKey);
      })
      .map((row) => coreMissingWorkFromRow(person, row));
  } catch (error) {
    console.warn("[core-missing-works]", error.message);
    return [];
  }
}

function actorMovieInfoSummary(row, fallbackCode = "") {
  return {
    code: normalizeWorkCode(row?.code) || fallbackCode || row?.code || "",
    title: row?.title || "",
    javdbUrl: publicRemoteUrl(row?.detail_url),
    releaseDate: row?.release_date || "",
    durationMinutes: null,
    rating: row?.rating ?? null,
    ratingCount: row?.rating_count ?? null,
    hasMagnet: dbBoolOrNull(row?.has_magnet),
    isStreamable: dbBoolOrNull(row?.is_streamable),
    hasSubtitles: dbBoolOrNull(row?.has_subtitles),
    javdbTags: parseJsonTextArray(row?.javdb_tags_json)
  };
}

function workCodeKeys(work) {
  const info = workInfoRow(work.id);
  const values = [
    info?.code,
    work.infoSummary?.code,
    work.title,
    work.directoryName,
    work.relativePath,
    ...(work.videos || []).flatMap((video) => [video.name, video.title, video.relativePath]),
    ...(work.images || []).flatMap((image) => [image.name, image.title]),
    ...(work.infos || []).flatMap((infoFile) => [infoFile.name, infoFile.title])
  ];

  const keys = [];
  const seen = new Set();
  for (const value of values) {
    const key = looseWorkCodeKey(value);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    keys.push(key);
  }
  return keys;
}

function workCodeKeySetForWorks(works = []) {
  const keys = new Set();
  for (const work of works || []) {
    for (const codeKey of workCodeKeys(work)) keys.add(codeKey);
  }
  return keys;
}

function combinedLocalWorkCodeKeys(extraKeys = new Set()) {
  const keys = new Set(localWorkCodeKeys());
  for (const key of extraKeys || []) {
    const codeKey = storedWorkCodeKey(key);
    if (codeKey) keys.add(codeKey);
  }
  return keys;
}

function enrichLocalWorksWithActorMovieInfo(localWorks, actorRows = []) {
  if (!actorRows.length || !localWorks.length) return localWorks;

  const localByCodeKey = new Map();
  for (const work of localWorks) {
    for (const codeKey of workCodeKeys(work)) {
      if (!localByCodeKey.has(codeKey)) localByCodeKey.set(codeKey, work);
    }
  }

  const fallbackByWorkId = new Map();
  for (const row of actorRows) {
    const codeKey = storedWorkCodeKey(row.code_key) || looseWorkCodeKey(row.code);
    const work = codeKey ? localByCodeKey.get(codeKey) : null;
    if (!work || fallbackByWorkId.has(work.id)) continue;
    fallbackByWorkId.set(work.id, actorMovieInfoSummary(row, codeKey));
  }

  if (!fallbackByWorkId.size) return localWorks;
  return localWorks.map((work) => {
    const fallback = fallbackByWorkId.get(work.id);
    if (!fallback) return work;
    return {
      ...work,
      infoSummary: {
        ...fallback,
        ...(work.infoSummary || {})
      }
    };
  });
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

function missingActorWorksForPerson(person, rows = actorMovieRows(person.id), excludedCodeKeys = new Set()) {
  const localKeys = combinedLocalWorkCodeKeys(excludedCodeKeys);
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

function dbBoolOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  return Boolean(Number(value));
}

function publicWorkInfoSummary(row, fallback = null) {
  if (!row && !fallback) return null;
  const actors = parseJsonTextArray(row?.actors_json);
  const tags = parseJsonTextArray(row?.tags_json);
  const previewImages = proxiedRemoteImageUrlArray(parseJsonArray(row?.preview_images_json));
  return {
    code: firstPresentText(row?.code, fallback?.code),
    title: displayWorkTitle(firstPresentText(row?.title, fallback?.title)),
    javdbUrl: publicRemoteUrl(firstPresentValue(row?.javdb_url, fallback?.javdbUrl)),
    releaseDate: firstPresentText(row?.release_date, fallback?.releaseDate),
    durationMinutes: firstPresentNumber(row?.duration_minutes, fallback?.durationMinutes),
    rating: firstPresentNumber(row?.rating, fallback?.rating),
    ratingCount: firstPresentNumber(row?.rating_count, fallback?.ratingCount),
    hasMagnet: firstPresentValue(dbBoolOrNull(row?.has_magnet), fallback?.hasMagnet),
    isStreamable: firstPresentValue(dbBoolOrNull(row?.is_streamable), fallback?.isStreamable),
    hasSubtitles: firstPresentValue(dbBoolOrNull(row?.has_subtitles), fallback?.hasSubtitles),
    javdbTags: uniqueTextArray([...parseJsonTextArray(row?.javdb_tags_json), ...(fallback?.javdbTags || [])], { maxLength: 40, maxItems: 16 }),
    director: firstPresentText(row?.director, fallback?.director),
    maker: firstPresentText(row?.maker, fallback?.maker),
    makerUrl: publicRemoteUrl(firstPresentValue(row?.maker_url, fallback?.makerUrl)),
    label: firstPresentText(row?.label, fallback?.label),
    labelUrl: publicRemoteUrl(firstPresentValue(row?.label_url, fallback?.labelUrl)),
    series: firstPresentText(row?.series, fallback?.series),
    seriesUrl: publicRemoteUrl(firstPresentValue(row?.series_url, fallback?.seriesUrl)),
    actors: actors.length ? actors : uniqueTextArray(fallback?.actors),
    actorLinks: publicEntityLinks(parseJsonArray(row?.actor_links_json), fallback?.actorLinks),
    tags: tags.length ? tags : uniqueTextArray(fallback?.tags),
    tagLinks: publicEntityLinks(parseJsonArray(row?.tag_links_json), fallback?.tagLinks),
    imageUrl: proxiedRemoteImageUrl(firstPresentValue(row?.image_url, fallback?.imageUrl)),
    previewImages: previewImages.length ? previewImages : proxiedRemoteImageUrlArray(fallback?.previewImages),
    previewVideoUrl: publicRemoteUrl(firstPresentValue(row?.preview_video_url, fallback?.previewVideoUrl))
  };
}

function publicWorkInfoMetadata(row) {
  if (!row) return null;
  const info = {
    code: row.code || "",
    title: displayWorkTitle(row.title || ""),
    releaseDate: row.release_date || "",
    durationMinutes: row.duration_minutes ?? null,
    rating: row.rating ?? null,
    ratingCount: row.rating_count ?? null,
    director: row.director || "",
    maker: row.maker || "",
    makerUrl: publicRemoteUrl(row.maker_url),
    label: row.label || "",
    labelUrl: publicRemoteUrl(row.label_url),
    series: row.series || "",
    seriesUrl: publicRemoteUrl(row.series_url),
    javdbUrl: row.javdb_url || "",
    imageUrl: proxiedRemoteImageUrl(row.image_url),
    previewImages: proxiedRemoteImageUrlArray(parseJsonArray(row.preview_images_json)),
    previewVideoUrl: publicRemoteUrl(row.preview_video_url),
    actors: parseJsonTextArray(row.actors_json),
    actorLinks: publicEntityLinks(parseJsonArray(row.actor_links_json)),
    tags: parseJsonTextArray(row.tags_json),
    tagLinks: publicEntityLinks(parseJsonArray(row.tag_links_json)),
    fields: parseJsonArray(row.fields_json),
    rawText: row.raw_text || "",
    rawTextTruncated: Boolean(row.raw_truncated),
    sourceName: row.source_name || "",
    updatedAt: row.updated_at || ""
  };
  if (!info.rawText && info.fields?.length) info.rawText = renderInfoMetadataText(info);
  return info;
}

function publicEntityLinks(rows, fallback = []) {
  const candidates = Array.isArray(rows) && rows.length ? rows : Array.isArray(fallback) ? fallback : [];
  const seen = new Set();
  const links = [];
  for (const item of candidates) {
    const name = String(item?.name || item?.label || item?.text || "").trim();
    const url = publicRemoteUrl(item?.url || item?.href || "");
    const key = `${name.toLowerCase()}\n${url.toLowerCase()}`;
    if (!name || !url || seen.has(key)) continue;
    seen.add(key);
    links.push({ name, url });
  }
  return links;
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

function safeDirectoryName(value, fallback = "新人物") {
  const clean = cleanPersonNamePart(value) || fallback;
  const safe = clean
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "")
    .replace(/[. ]+$/g, "")
    .trim();
  return (safe || fallback).slice(0, 120);
}

function libraryRootForNewPerson(value) {
  const raw = String(value || "").trim();
  if (!raw) {
    const error = new Error("请选择保存硬盘");
    error.statusCode = 400;
    throw error;
  }
  const root = sourcePathToAbsolute(raw);
  const matchedRoot = libraryOpenRoots().find((rootPath) => path.resolve(rootPath).toLowerCase() === path.resolve(root).toLowerCase());
  if (!matchedRoot) {
    const error = new Error("保存硬盘不在资料库根目录中");
    error.statusCode = 400;
    throw error;
  }
  if (!safeStat(matchedRoot)?.isDirectory()) {
    const error = new Error("保存硬盘不可用");
    error.statusCode = 404;
    throw error;
  }
  return matchedRoot;
}

function createOrUpdateMoveTargetPerson(db, payload = {}) {
  const displayName = cleanPersonNamePart(payload.displayName || payload.name);
  const name = cleanPersonNamePart(payload.name || displayName);
  const nameSearch = normalizePersonSearchValue(name);
  if (!name || !nameSearch) {
    const error = new Error("请填写演员名");
    error.statusCode = 400;
    throw error;
  }

  const inputActorUrl = String(payload.javdbUrl || payload.actorUrl || "").trim();
  const javdbUrl = canonicalJavdbActorUrl(inputActorUrl);
  if (inputActorUrl && !javdbUrl) {
    const error = new Error("请输入 JavDB actor 页面链接，例如 https://javdb.com/actors/BzpA");
    error.statusCode = 400;
    throw error;
  }
  const actorKey = actorIdFromJavdbUrl(javdbUrl);

  const root = libraryRootForNewPerson(payload.rootPath || payload.root);
  const folderName = safeDirectoryName(payload.folderName || displayName || name, name);
  const folderPath = ensureLibraryDirectoryPath(path.join(root, folderName), "目标人物文件夹");
  fs.mkdirSync(folderPath, { recursive: true });

  const now = new Date().toISOString();
  const existing = db
    .prepare(
      `
      SELECT *
      FROM people
      WHERE name_search = ?
         OR lower(trim(name)) = lower(trim(?))
         OR lower(trim(COALESCE(display_name, ''))) = lower(trim(?))
      ORDER BY
        CASE WHEN name = ? OR display_name = ? THEN 0 ELSE 1 END,
        id ASC
      LIMIT 1
      `
    )
    .get(nameSearch, name, displayName || name, name, displayName || name);

  let personId;
  if (existing?.id) {
    personId = Number(existing.id);
    db
      .prepare(
        `
        UPDATE people
        SET
          display_name = COALESCE(NULLIF(?, ''), display_name),
          folder_path = COALESCE(NULLIF(?, ''), folder_path),
          gender = COALESCE(NULLIF(?, ''), gender),
          source = CASE WHEN source IS NULL OR source = '' THEN 'manual_move' ELSE source END,
          updated_at = ?
        WHERE id = ?
        `
      )
      .run(displayName || name, folderPath, normalizePersonGender(payload.gender || existing.gender || "unknown"), now, personId);
  } else {
    const result = db
      .prepare(
        `
        INSERT INTO people (name, name_search, display_name, folder_path, movie_count, status, error, source, created_at, updated_at, gender)
        VALUES (?, ?, ?, ?, 0, 'ok', NULL, 'manual_move', ?, ?, ?)
        `
      )
      .run(name, nameSearch, displayName || name, folderPath, now, now, normalizePersonGender(payload.gender || "unknown"));
    personId = Number(result.lastInsertRowid);
  }

  if (actorKey) {
    db.prepare(
      `
      INSERT INTO person_external_refs(person_id, provider, external_key, url, source, created_at, updated_at)
      VALUES (?, 'javdb-actor', ?, ?, 'manual_move', ?, ?)
      ON CONFLICT(provider, external_key) DO UPDATE SET
        person_id = excluded.person_id,
        url = excluded.url,
        source = excluded.source,
        updated_at = excluded.updated_at
      `
    ).run(personId, actorKey, javdbUrl, now, now);
  }

  const aliases = uniquePersonNames(Array.isArray(payload.aliases) ? payload.aliases : []);
  if (aliases.length) {
    const insertAlias = db.prepare("INSERT OR IGNORE INTO person_aliases(person_id, alias, alias_search, source) VALUES (?, ?, ?, 'manual_move')");
    const primaryKey = normalizePersonSearchValue(displayName || name);
    for (const alias of aliases) {
      const key = normalizePersonSearchValue(alias);
      if (key && key !== primaryKey) insertAlias.run(personId, alias, key);
    }
  }

  invalidateTableStamp("actor_profiles", "actor_movies");
  actorProfileCache = null;
  personMergeCache = null;
  return {
    id: String(personId),
    name: displayName || name,
    targetDirectory: folderPath,
    created: !existing?.id
  };
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
  const gender = normalizePersonGender(payload.gender || existing?.gender || person.gender || "unknown");
  const hasAliasesInput = Array.isArray(payload.aliases) || typeof payload.aliases === "string";
  const inputAliases = Array.isArray(payload.aliases)
    ? payload.aliases
    : typeof payload.aliases === "string"
      ? [payload.aliases]
      : [];
  const displayNameKey = normalizePersonSearchValue(displayName);
  const aliases = uniquePersonNames(inputAliases).filter((alias) => normalizePersonSearchValue(alias) !== displayNameKey);
  const avatarMime = payload.avatarMime || (avatarBlob ? "image/jpeg" : existing?.avatar_mime || null);

  const corePersonId = Number(person.id);
  const db = getCoreDb();
  db
    .prepare(
      `
      UPDATE people
      SET
        name = COALESCE(NULLIF(?, ''), name),
        name_search = COALESCE(NULLIF(?, ''), name_search),
        display_name = COALESCE(NULLIF(?, ''), display_name),
        gender = ?,
        movie_count = ?,
        source = COALESCE(NULLIF(?, ''), source),
        status = ?,
        error = ?,
        updated_at = ?
      WHERE id = ?
      `
    )
    .run(person.name, normalizePersonSearchValue(person.name), displayName, gender, movieCount, payload.source || existing?.source || "manual", payload.status || "ok", payload.error || null, now, corePersonId);

  const actorKey = payload.javdbActorId || actorIdFromJavdbUrl(javdbUrl) || existing?.javdb_actor_id || "";
  const finalJavdbUrl = javdbUrl || existing?.javdb_url || (actorKey ? `https://javdb.com/actors/${actorKey}` : "");
  if (actorKey) {
    db.prepare(
      `
      INSERT INTO person_external_refs(person_id, provider, external_key, url, source, created_at, updated_at)
      VALUES (?, 'javdb-actor', ?, ?, ?, ?, ?)
      ON CONFLICT(provider, external_key) DO UPDATE SET
        person_id = excluded.person_id,
        url = COALESCE(NULLIF(excluded.url, ''), person_external_refs.url),
        updated_at = excluded.updated_at
      `
    ).run(corePersonId, actorKey, finalJavdbUrl, payload.source || "manual", now, now);
  }

  if (hasAliasesInput) {
    db.prepare("DELETE FROM person_aliases WHERE person_id = ?").run(corePersonId);
    const insertAlias = db.prepare("INSERT OR IGNORE INTO person_aliases(person_id, alias, alias_search, source) VALUES (?, ?, ?, ?)");
    for (const alias of aliases) insertAlias.run(corePersonId, alias, normalizePersonSearchValue(alias), payload.source || "manual");
  }

  const avatarUrl = payload.sourceAvatarUrl || payload.avatarUrl || existing?.avatar_url || "";
  if (avatarBlob || avatarUrl) {
    db.prepare(
      `
      INSERT INTO images (
        owner_type, owner_id, kind, source_type, remote_url, mime, image_blob, byte_size,
        sort_order, status, source, legacy_table, legacy_key, created_at, updated_at
      )
      VALUES ('person', ?, 'avatar', ?, ?, ?, ?, ?, 0, 'ok', ?, 'manual', ?, ?, ?)
      ON CONFLICT DO UPDATE SET
        remote_url = excluded.remote_url,
        mime = COALESCE(excluded.mime, images.mime),
        image_blob = COALESCE(excluded.image_blob, images.image_blob),
        byte_size = COALESCE(excluded.byte_size, images.byte_size),
        status = excluded.status,
        source = excluded.source,
        legacy_table = excluded.legacy_table,
        legacy_key = excluded.legacy_key,
        updated_at = excluded.updated_at
      `
    ).run(
      corePersonId,
      avatarUrl.startsWith("http://") || avatarUrl.startsWith("https://") ? "remote" : avatarUrl ? "local" : "unknown",
      avatarUrl,
      avatarMime || "image/jpeg",
      avatarBlob,
      avatarBlob?.length || null,
      payload.source || "manual",
      person.id,
      now,
      now
    );
  }

  if (javdbUrl && existing?.javdb_url && canonicalJavdbActorUrl(existing.javdb_url) !== javdbUrl) {
    actorMovieCache = null;
    actorMovieByCodeKeyCache = null;
  }
  invalidateTableStamp("actor_profiles", "actor_movies");
  actorProfileCache = null;
  actorMovieCache = null;
  actorMovieByCodeKeyCache = null;
  personMergeCache = null;

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
  return null;
}

function saveLibraryCache(index) {
  return index;
}

function coreLocalPathPersonName(localPath) {
  const fullPath = sourcePathToAbsolute(localPath);
  if (!fullPath) return "";
  const matchingRoot = [...LIBRARY_ROOTS]
    .sort((a, b) => b.length - a.length)
    .find((rootPath) => pathWithinRoot(fullPath, rootPath));
  if (!matchingRoot) {
    return path.basename(path.dirname(fullPath)) || path.basename(fullPath);
  }
  const relative = path.relative(matchingRoot, fullPath);
  return relative.split(/[\\/]+/).filter(Boolean)[0] || path.basename(fullPath);
}

function coreLocalPersonSourcePath(localPath) {
  const fullPath = sourcePathToAbsolute(localPath);
  const personName = coreLocalPathPersonName(fullPath);
  if (!fullPath || !personName) return relativeFromRoot(fullPath);
  const matchingRoot = [...LIBRARY_ROOTS]
    .sort((a, b) => b.length - a.length)
    .find((rootPath) => pathWithinRoot(fullPath, rootPath));
  return matchingRoot ? relativeFromRoot(path.join(matchingRoot, personName)) : relativeFromRoot(path.dirname(fullPath));
}

function corePeopleByFolderName(db) {
  const people = new Map();
  const rows = db.prepare("SELECT id, name, display_name FROM people").all();
  for (const row of rows) {
    const names = uniquePersonNames([row.name, row.display_name]);
    for (const name of names) {
      const key = normalizePersonSearchValue(name);
      if (!key) continue;
      if (!people.has(key)) people.set(key, []);
      const entries = people.get(key);
      if (!entries.some((entry) => Number(entry.id) === Number(row.id))) {
        entries.push({
          id: row.id,
          name: row.name || "",
          displayName: row.display_name || row.name || ""
        });
      }
    }
  }
  return people;
}

function corePersonFromLocalPath(peopleByFolderName, localPath) {
  const folderName = coreLocalPathPersonName(localPath);
  const matches = peopleByFolderName.get(normalizePersonSearchValue(folderName)) || [];
  return matches.length === 1 ? matches[0] : null;
}

function backfillCoreLocalWorkPeopleFromFolders(db) {
  const peopleByFolderName = corePeopleByFolderName(db);
  const rows = db
    .prepare(
      `
      SELECT lw.work_id, lw.local_path
      FROM local_works lw
      WHERE lw.local_path IS NOT NULL
        AND lw.local_path <> ''
        AND NOT EXISTS (
          SELECT 1
          FROM work_people wp
          WHERE wp.work_id = lw.work_id
            AND wp.role = 'actor'
        )
      `
    )
    .all();
  if (!rows.length) return peopleByFolderName;

  const now = new Date().toISOString();
  const insert = db.prepare(
    `
    INSERT INTO work_people (work_id, person_id, role, sort_order, source, created_at, updated_at)
    VALUES (?, ?, 'actor', 0, 'local_folder', ?, ?)
    ON CONFLICT(work_id, person_id, role) DO NOTHING
    `
  );

  db.exec("BEGIN");
  try {
    for (const row of rows) {
      const person = corePersonFromLocalPath(peopleByFolderName, row.local_path);
      if (!person?.id) continue;
      insert.run(Number(row.work_id), Number(person.id), now, now);
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return peopleByFolderName;
}

function coreFileToMediaFile(row) {
  const filePath = String(row.file_path || "");
  const name = String(row.name || path.basename(filePath));
  const type = String(row.file_type || "");
  return {
    id: String(row.file_id || createId(type[0] || "f", filePath)),
    type,
    name,
    title: String(row.title || fileBase(name)),
    ext: String(row.ext || normalizeExt(name)),
    path: filePath,
    relativePath: String(row.relative_path || relativeFromRoot(filePath)),
    size: Number(row.size || 0),
    modifiedAt: row.modified_at || null,
    playable: type === "video" ? Boolean(row.playable) : undefined
  };
}

function coreWorkIdForScannedWork(personId, work) {
  if (!hasCoreDb() || !personId || !work) return null;
  const corePersonId = Number(personId);
  if (!Number.isFinite(corePersonId)) return null;
  const codeKeys = workCodeKeys(work);
  if (!codeKeys.length) return null;

  const db = getCoreDb();
  const lookup = db.prepare(
    `
    SELECT w.id
    FROM works w
    JOIN work_people wp ON wp.work_id = w.id
    WHERE w.code_search = ?
      AND wp.person_id = ?
      AND wp.role = 'actor'
    ORDER BY wp.sort_order ASC, w.id ASC
    LIMIT 1
    `
  );
  for (const codeKey of codeKeys) {
    const row = lookup.get(codeKey, corePersonId);
    if (row?.id) return String(row.id);
  }
  return null;
}

function coreLinkedScannedWork(personId, work) {
  const coreWorkId = coreWorkIdForScannedWork(personId, work);
  return coreWorkId ? { ...work, id: coreWorkId } : work;
}

function coreWorkInfoFallback(row) {
  return {
    code: row.code || "",
    title: row.work_title || "",
    releaseDate: row.release_date || "",
    durationMinutes: row.duration_minutes ?? null,
    rating: row.rating ?? null,
    ratingCount: row.rating_count ?? null,
    hasMagnet: dbBoolOrNull(row.has_magnet),
    isStreamable: dbBoolOrNull(row.is_streamable),
    hasSubtitles: dbBoolOrNull(row.has_subtitles),
    javdbTags: parseJsonTextArray(row.javdb_tags_json),
    director: row.director || "",
    imageUrl: "",
    actors: [],
    tags: [],
    fields: []
  };
}

function loadLibraryFromCoreDb() {
  if (!hasCoreDb()) return null;

  const db = getCoreDb();
  const peopleByFolderName = backfillCoreLocalWorkPeopleFromFolders(db);
  const index = emptyLibrary();
  for (const rootPath of LIBRARY_ROOTS) {
    if (fs.existsSync(rootPath)) {
      index.availableRoots.push(rootPath);
    } else {
      index.missingRoots.push(rootPath);
    }
  }

  const filesByLocalWorkId = new Map();
  for (const row of db
    .prepare(
      `
      SELECT local_work_id, file_id, file_type, file_path, name, title, ext,
             relative_path, size, modified_at, playable, sort_order
      FROM local_files
      ORDER BY local_work_id, file_type, sort_order, name
      `
    )
    .all()) {
    const localWorkId = String(row.local_work_id || "");
    if (!localWorkId) continue;
    if (!filesByLocalWorkId.has(localWorkId)) filesByLocalWorkId.set(localWorkId, []);
    filesByLocalWorkId.get(localWorkId).push(coreFileToMediaFile(row));
  }

  const personBuckets = new Map();
  const localRows = db
    .prepare(
      `
      SELECT
        lw.id AS local_work_id,
        lw.work_id AS core_work_id,
        lw.local_path,
        lw.source_mtime,
        owner.id AS core_person_id,
        owner.name AS core_person_name,
        owner.display_name AS core_person_display_name,
        w.code,
        w.title AS work_title,
          w.release_date,
          w.duration_minutes,
          w.rating,
          w.rating_count,
          w.has_magnet,
          w.is_streamable,
          w.has_subtitles,
          w.javdb_tags_json,
          w.director,
        w.updated_at AS work_updated_at
      FROM local_works lw
      JOIN works w ON w.id = lw.work_id
      LEFT JOIN people owner
        ON owner.id = (
          SELECT wp.person_id
          FROM work_people wp
          JOIN people owner_candidate ON owner_candidate.id = wp.person_id
          WHERE wp.work_id = w.id
            AND wp.role = 'actor'
          ORDER BY
            CASE WHEN owner_candidate.source IN ('manual', 'manual_move') THEN 0 ELSE 1 END,
            CASE WHEN EXISTS (
              SELECT 1
              FROM person_external_refs pref
              WHERE pref.person_id = owner_candidate.id
                AND pref.provider = 'javdb-actor'
            ) THEN 0 ELSE 1 END,
            CASE WHEN EXISTS (
              SELECT 1
              FROM images avatar
              WHERE avatar.owner_type = 'person'
                AND avatar.owner_id = owner_candidate.id
                AND avatar.kind = 'avatar'
            ) THEN 0 ELSE 1 END,
            wp.sort_order ASC,
            wp.person_id ASC
          LIMIT 1
        )
      WHERE lw.local_path IS NOT NULL
        AND lw.local_path <> ''
      ORDER BY lw.local_path
      `
    )
    .all();

  for (const row of localRows) {
    const fallbackPerson = row.core_person_id ? null : corePersonFromLocalPath(peopleByFolderName, row.local_path);
    const corePersonId = row.core_person_id ? String(row.core_person_id) : fallbackPerson?.id ? String(fallbackPerson.id) : "";
    if (!corePersonId) continue;
    const personName = row.core_person_display_name || row.core_person_name || fallbackPerson?.displayName || fallbackPerson?.name || "";
    if (!personName) continue;
    const personId = corePersonId;
    const sourcePath = coreLocalPersonSourcePath(row.local_path);
    if (!personBuckets.has(personId)) {
      personBuckets.set(personId, {
        id: personId,
        name: personName,
        sourcePaths: [],
        works: []
      });
    }
    const bucket = personBuckets.get(personId);
    if (sourcePath && !bucket.sourcePaths.includes(sourcePath)) bucket.sourcePaths.push(sourcePath);

    const files = filesByLocalWorkId.get(String(row.local_work_id)) || [];
    const videos = files.filter((file) => file.type === "video").sort(compareNaturalName);
    const images = files.filter((file) => file.type === "image").sort(compareNaturalName);
    const infos = files.filter((file) => file.type === "info").sort(compareNaturalName);
    videos.forEach((video, index) => {
      video.id = `${row.core_work_id}-${index + 1}`;
    });
    const title = row.work_title || path.basename(sourcePathToAbsolute(row.local_path)) || row.code || "";
    const cover = chooseCover(images, fileBase(title), sourcePathToAbsolute(row.local_path));
    const modifiedAt = [...videos, ...images, ...infos]
      .map((file) => file.modifiedAt)
      .filter(Boolean)
      .sort()
      .at(-1) || row.source_mtime || row.work_updated_at || null;
    const work = {
      id: String(row.core_work_id),
      personId,
      title,
      directoryName: path.basename(sourcePathToAbsolute(row.local_path)),
      relativePath: relativeFromRoot(sourcePathToAbsolute(row.local_path)),
      coverId: cover?.id || null,
      videoCount: videos.length,
      playableCount: videos.filter((video) => video.playable).length,
      imageCount: images.length,
      infoCount: infos.length,
      modifiedAt,
      videos,
      images,
      infos,
      infoSummary: coreWorkInfoFallback(row)
    };
    bucket.works.push(work);
    index.worksById.set(work.id, work);
    registerFiles(index, [...videos, ...images, ...infos]);
  }

  for (const bucket of personBuckets.values()) {
    const person = personRecordFromWorks(bucket, bucket.sourcePaths, bucket.works);
    index.people.push(person);
    index.peopleById.set(person.id, person);
  }

  index.people.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }));
  index.scannedAt = new Date().toISOString();
  index.totals.people = index.people.length;
  index.totals.works = index.worksById.size;
  const files = [...index.filesById.values()];
  index.totals.videos = files.filter((file) => file.type === "video").length;
  index.totals.playableVideos = files.filter((file) => file.type === "video" && file.playable).length;
  index.totals.images = files.filter((file) => file.type === "image").length;
  index.totals.infoFiles = files.filter((file) => file.type === "info").length;
  return index;
}

function replaceCoreLocalFilesForWork(work) {
  if (!hasCoreDb() || !work?.id) return;
  const db = getCoreDb();
  const coreWorkId = Number(work.id);
  if (!Number.isFinite(coreWorkId)) return;
  const localPath = sourcePathToAbsolute(work.relativePath) || work.relativePath || "";
  if (!localPath) return;

  const now = new Date().toISOString();
  const insert = db.prepare(
    `
    INSERT INTO local_files (
      work_id, local_work_id, file_id, file_type, file_path, name, title, ext,
      relative_path, size, modified_at, playable, sort_order, created_at, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(file_id) DO UPDATE SET
      work_id = excluded.work_id,
      local_work_id = excluded.local_work_id,
      file_type = excluded.file_type,
      file_path = excluded.file_path,
      name = excluded.name,
      title = excluded.title,
      ext = excluded.ext,
      relative_path = excluded.relative_path,
      size = excluded.size,
      modified_at = excluded.modified_at,
      playable = excluded.playable,
      sort_order = excluded.sort_order,
      updated_at = excluded.updated_at
    `
  );
  const files = [
    ...(work.videos || []).map((file, index) => ({ file, type: "video", index })),
    ...(work.images || []).map((file, index) => ({ file, type: "image", index })),
    ...(work.infos || []).map((file, index) => ({ file, type: "info", index }))
  ];
  const sourceInfo = work.infos?.[0] || null;
  const sourceVideo = work.videos?.[0] || null;
  const detectedCode = normalizeWorkCode(work.infoSummary?.code || work.title || work.directoryName || work.relativePath);
  const detectedCodeSearch = workCodeKeys(work)[0] || storedWorkCodeKey(detectedCode);
  db.exec("BEGIN IMMEDIATE");
  try {
    let localWork = db
      .prepare(
        `
        SELECT id
        FROM local_works
        WHERE work_id = ?
        ORDER BY CASE WHEN local_path = ? THEN 0 ELSE 1 END, id ASC
        LIMIT 1
        `
      )
      .get(coreWorkId, localPath);
    if (!localWork?.id) {
      const result = db
        .prepare(
          `
          INSERT INTO local_works (
            work_id, local_path, source_info_path, source_info_id, source_name,
            source_size, source_mtime, detected_code, detected_code_search,
            matched_by, confidence, created_at, updated_at
          )
          VALUES (?, ?, ?, ?, 'local_scan', ?, ?, ?, ?, 'person_scan_code', 1, ?, ?)
          `
        )
        .run(
          coreWorkId,
          localPath,
          sourceInfo?.path || "",
          sourceInfo?.id || "",
          Number(sourceVideo?.size || 0),
          sourceVideo?.modifiedAt || work.modifiedAt || null,
          detectedCode || "",
          detectedCodeSearch || "",
          now,
          now
        );
      localWork = { id: Number(result.lastInsertRowid) };
    } else {
      db
        .prepare(
          `
          UPDATE local_works
          SET local_path = ?,
              source_info_path = ?,
              source_info_id = ?,
              source_name = 'local_scan',
              source_size = ?,
              source_mtime = ?,
              detected_code = ?,
              detected_code_search = ?,
              matched_by = 'person_scan_code',
              confidence = 1,
              updated_at = ?
          WHERE id = ?
          `
        )
        .run(
          localPath,
          sourceInfo?.path || "",
          sourceInfo?.id || "",
          Number(sourceVideo?.size || 0),
          sourceVideo?.modifiedAt || work.modifiedAt || null,
          detectedCode || "",
          detectedCodeSearch || "",
          now,
          Number(localWork.id)
        );
    }
    db.prepare("DELETE FROM local_files WHERE local_work_id = ?").run(localWork.id);
    for (const item of files) {
      insert.run(
        coreWorkId,
        localWork.id,
        item.file.id,
        item.type,
        item.file.path,
        item.file.name,
        item.file.title || fileBase(item.file.name),
        item.file.ext || normalizeExt(item.file.name),
        item.file.relativePath || relativeFromRoot(item.file.path),
        Number(item.file.size || 0),
        item.file.modifiedAt || null,
        item.type === "video" && item.file.playable ? 1 : 0,
        item.index,
        now,
        now
      );
    }
    db.exec("COMMIT");
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // Ignore rollback failures; the original write error is more useful.
    }
    throw error;
  }
}

function replacePathPrefix(value, fromDir, toDir) {
  const text = String(value || "");
  if (!text) return text;
  const from = path.resolve(fromDir);
  const target = path.resolve(text);
  const relative = path.relative(from, target);
  if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) {
    return relative ? path.join(toDir, relative) : toDir;
  }
  return text;
}

function updateMemoryWorkPath(work, oldDir, newDir) {
  work.directoryName = path.basename(newDir);
  work.relativePath = relativeFromRoot(newDir);
  for (const file of [...(work.videos || []), ...(work.images || []), ...(work.infos || [])]) {
    file.path = replacePathPrefix(file.path, oldDir, newDir);
    file.relativePath = relativeFromRoot(file.path);
  }
}

function ensureLibraryDirectoryPath(dirPath, label = "文件夹") {
  const fullPath = sourcePathToAbsolute(dirPath);
  if (!fullPath) {
    const error = new Error(`${label}路径无效`);
    error.statusCode = 400;
    throw error;
  }
  const allowed = libraryOpenRoots().some((rootPath) => pathWithinRoot(fullPath, rootPath));
  if (!allowed) {
    const error = new Error(`${label}不在资料库根目录内`);
    error.statusCode = 400;
    throw error;
  }
  return fullPath;
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function isRetryableMoveError(error) {
  return ["EPERM", "EBUSY", "ENOTEMPTY", "EACCES"].includes(String(error?.code || "").toUpperCase());
}

function renameDirectoryWithRetry(oldDir, newDir, options = {}) {
  const attempts = Math.max(1, Number(options.attempts || 1));
  const delayMs = Math.max(0, Number(options.delayMs || 0));
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      fs.renameSync(oldDir, newDir);
      return { mode: attempt > 1 ? "rename-retry" : "rename", attempts: attempt };
    } catch (error) {
      lastError = error;
      if (!isRetryableMoveError(error) || attempt >= attempts) throw error;
      sleepSync(delayMs);
    }
  }
  throw lastError;
}

function moveDirectorySync(oldDir, newDir) {
  try {
    return renameDirectoryWithRetry(oldDir, newDir, { attempts: process.platform === "win32" ? 8 : 2, delayMs: 450 });
  } catch (error) {
    if (String(error?.code || "").toUpperCase() !== "EXDEV") throw error;
  }

  if (process.platform === "win32") {
    const result = spawnSync("robocopy", [oldDir, newDir, "/E", "/MOVE", "/R:1", "/W:1", "/NFL", "/NDL", "/NP"], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 0,
      maxBuffer: 8 * 1024 * 1024
    });
    const status = Number(result.status);
    if (!result.error && Number.isFinite(status) && status < 8) {
      return { mode: "robocopy" };
    }
    try {
      if (fs.existsSync(newDir) && !fs.existsSync(oldDir)) {
        spawnSync("robocopy", [newDir, oldDir, "/E", "/MOVE", "/R:1", "/W:1", "/NFL", "/NDL", "/NP"], {
          encoding: "utf8",
          windowsHide: true,
          timeout: 0,
          maxBuffer: 8 * 1024 * 1024
        });
      }
    } catch {
      // Preserve the original move error.
    }
    const detail = result.error?.message || result.stderr || result.stdout || `robocopy exit ${result.status}`;
    throw new Error(detail.trim());
  }

  try {
    fs.cpSync(oldDir, newDir, {
      recursive: true,
      errorOnExist: true,
      force: false,
      preserveTimestamps: true
    });
    fs.rmSync(oldDir, { recursive: true, force: false });
    return { mode: "copy" };
  } catch (error) {
    try {
      if (fs.existsSync(newDir)) fs.rmSync(newDir, { recursive: true, force: true });
    } catch {
      // Preserve the original move error.
    }
    throw error;
  }
}

function targetDirectoryForPerson(person, db, options = {}) {
  const explicitPath = String(options.targetDirectory || options.targetPath || "").trim();
  if (explicitPath) {
    const fullPath = ensureLibraryDirectoryPath(explicitPath, "目标人物文件夹");
    if (!safeStat(fullPath)?.isDirectory()) {
      const error = new Error("目标人物文件夹不存在");
      error.statusCode = 404;
      throw error;
    }
    return fullPath;
  }

  const sourcePaths = uniqueTextArray([person?.relativePath, ...(person?.sourcePaths || [])]);
  for (const sourcePath of sourcePaths) {
    const fullPath = ensureLibraryDirectoryPath(sourcePath, "目标人物文件夹");
    if (safeStat(fullPath)?.isDirectory()) return fullPath;
  }

  const rows = db
    .prepare(
      `
      SELECT lw.local_path
      FROM local_works lw
      JOIN work_people wp ON wp.work_id = lw.work_id
      WHERE wp.person_id = ?
        AND wp.role = 'actor'
        AND lw.local_path IS NOT NULL
        AND lw.local_path <> ''
      ORDER BY lw.local_path
      `
    )
    .all(Number(person.id));
  for (const row of rows) {
    const fullPath = ensureLibraryDirectoryPath(coreLocalPersonSourcePath(row.local_path), "目标人物文件夹");
    if (safeStat(fullPath)?.isDirectory()) return fullPath;
  }

  const personName = String(person?.name || "").trim();
  for (const rootPath of libraryOpenRoots()) {
    const candidate = path.join(rootPath, personName);
    if (personName && safeStat(candidate)?.isDirectory()) return ensureLibraryDirectoryPath(candidate, "目标人物文件夹");
  }

  const error = new Error("没有找到目标人物文件夹");
  error.statusCode = 404;
  throw error;
}

function setWorkLocalMarker(workId, marker, enabled) {
  const key = localWorkMarkerKey(marker);
  if (!key) {
    const error = new Error("暂时只支持 A 标记");
    error.statusCode = 400;
    throw error;
  }
  const work = resolveLibraryWorkByPublicId(workId);
  if (!work || work.missingLocal) {
    const error = new Error("作品不存在");
    error.statusCode = 404;
    throw error;
  }
  if (!hasCoreDb()) {
    const error = new Error("core DB 不可用");
    error.statusCode = 500;
    throw error;
  }

  const db = getCoreDb();
  const row = db
    .prepare(
      `
      SELECT id, local_path, source_info_path
      FROM local_works
      WHERE work_id = ?
        AND local_path IS NOT NULL
        AND local_path <> ''
      ORDER BY id
      LIMIT 1
      `
    )
    .get(Number(work.id));
  if (!row?.local_path) {
    const error = new Error("这个作品没有本地文件夹");
    error.statusCode = 404;
    throw error;
  }

  const oldDir = sourcePathToAbsolute(row.local_path);
  const stat = safeStat(oldDir);
  if (!stat?.isDirectory()) {
    const error = new Error("本地作品文件夹不存在");
    error.statusCode = 404;
    throw error;
  }
  const allowed = libraryOpenRoots().some((rootPath) => pathWithinRoot(oldDir, rootPath));
  if (!allowed) {
    const error = new Error("作品文件夹不在资料库根目录内");
    error.statusCode = 400;
    throw error;
  }

  const oldBase = path.basename(oldDir);
  const newBase = markerDirectoryName(oldBase, key, Boolean(enabled));
  if (!newBase || newBase === oldBase) {
    return { changed: false, marker: key, enabled: workHasLocalMarker(work, key), work: publicWork(work, true) };
  }

  const newDir = path.join(path.dirname(oldDir), newBase);
  const targetAllowed = libraryOpenRoots().some((rootPath) => pathWithinRoot(newDir, rootPath));
  if (!targetAllowed) {
    const error = new Error("目标文件夹不在资料库根目录内");
    error.statusCode = 400;
    throw error;
  }
  if (fs.existsSync(newDir)) {
    const error = new Error(`目标文件夹已存在：${relativeFromRoot(newDir)}`);
    error.statusCode = 409;
    throw error;
  }

  try {
    fs.renameSync(oldDir, newDir);
  } catch (error) {
    const wrapped = new Error(`重命名文件夹失败：${error.message}`);
    wrapped.statusCode = 500;
    throw wrapped;
  }

  const now = new Date().toISOString();
  db.exec("BEGIN IMMEDIATE");
  try {
    const localWorkId = Number(row.id);
    const fileRows = db.prepare("SELECT id, file_path FROM local_files WHERE local_work_id = ?").all(localWorkId);
    const imageRows = db
      .prepare("SELECT id, local_path FROM images WHERE owner_type = 'work' AND owner_id = ? AND local_path IS NOT NULL AND local_path <> ''")
      .all(Number(work.id));
    db
      .prepare(
        `
        UPDATE local_works
        SET local_path = ?,
            source_info_path = CASE
              WHEN source_info_path IS NOT NULL AND source_info_path <> '' THEN ?
              ELSE source_info_path
            END,
            updated_at = ?
        WHERE id = ?
        `
      )
      .run(newDir, replacePathPrefix(row.source_info_path || "", oldDir, newDir), now, localWorkId);
    const updateFile = db.prepare("UPDATE local_files SET file_path = ?, relative_path = ?, updated_at = ? WHERE id = ?");
    for (const fileRow of fileRows) {
      const nextPath = replacePathPrefix(fileRow.file_path, oldDir, newDir);
      updateFile.run(nextPath, relativeFromRoot(nextPath), now, fileRow.id);
    }
    const updateImage = db.prepare("UPDATE images SET local_path = ?, updated_at = ? WHERE id = ?");
    for (const imageRow of imageRows) {
      updateImage.run(replacePathPrefix(imageRow.local_path, oldDir, newDir), now, imageRow.id);
    }
    db.exec("COMMIT");
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {}
    try {
      if (fs.existsSync(newDir) && !fs.existsSync(oldDir)) fs.renameSync(newDir, oldDir);
    } catch {}
    throw error;
  }

  updateMemoryWorkPath(work, oldDir, newDir);
  invalidateLibraryDerivedCaches();
  return { changed: true, marker: key, enabled: workHasLocalMarker(work, key), work: publicWork(work, true) };
}

function correctedActorFieldsJson(fieldsJson, actorName) {
  const fields = parseJsonArray(fieldsJson);
  const cleanName = String(actorName || "").trim();
  if (!cleanName) return JSON.stringify(fields);

  let replaced = false;
  const nextFields = fields.map((field) => {
    const label = String(field?.label || field?.name || "").trim();
    if (!/^(演员|演員|女优|女優|actor|actors|actor_names)$/i.test(label)) return field;
    replaced = true;
    return { ...field, label: field.label || "演员", value: cleanName };
  });
  if (!replaced) nextFields.push({ label: "演员", value: cleanName });
  return JSON.stringify(nextFields);
}

function findOrCreateCorePersonByName(db, name, folderPath = "") {
  const cleanName = String(name || "").trim();
  const nameSearch = normalizePersonSearchValue(cleanName);
  if (!cleanName || !nameSearch) {
    const error = new Error("演员名无效");
    error.statusCode = 400;
    throw error;
  }

  const existing = db
    .prepare(
      `
      SELECT *
      FROM people
      WHERE name_search = ?
         OR lower(trim(name)) = lower(trim(?))
         OR lower(trim(COALESCE(display_name, ''))) = lower(trim(?))
      ORDER BY
        CASE WHEN name = ? OR display_name = ? THEN 0 ELSE 1 END,
        id ASC
      LIMIT 1
      `
    )
    .get(nameSearch, cleanName, cleanName, cleanName, cleanName);
  if (existing?.id) return existing;

  const now = new Date().toISOString();
  const result = db
    .prepare(
      `
      INSERT INTO people (name, name_search, display_name, folder_path, movie_count, status, error, source, created_at, updated_at, gender)
      VALUES (?, ?, ?, ?, 0, 'ok', NULL, 'local_folder_correction', ?, ?, 'unknown')
      `
    )
    .run(cleanName, nameSearch, cleanName, folderPath || null, now, now);
  invalidateTableStamp("actor_profiles");
  actorProfileCache = null;
  return db.prepare("SELECT * FROM people WHERE id = ?").get(Number(result.lastInsertRowid));
}

function correctWorkActorFromLocalFolder(workId) {
  const work = resolveLibraryWorkByPublicId(workId);
  if (!work || work.missingLocal) {
    const error = new Error("作品本地文件不存在");
    error.statusCode = 404;
    throw error;
  }
  if (!hasCoreDb()) {
    const error = new Error("core DB 不可用");
    error.statusCode = 500;
    throw error;
  }

  const db = getCoreDb();
  const coreWorkId = Number(work.id);
  if (!Number.isFinite(coreWorkId)) {
    const error = new Error("作品编号无效");
    error.statusCode = 400;
    throw error;
  }

  const row = db
    .prepare(
      `
      SELECT local_path
      FROM local_works
      WHERE work_id = ?
        AND local_path IS NOT NULL
        AND local_path <> ''
      ORDER BY id
      LIMIT 1
      `
    )
    .get(coreWorkId);
  const actorName = coreLocalPathPersonName(row?.local_path || "");
  if (!actorName) {
    const error = new Error("没有从本地文件夹识别出演员名");
    error.statusCode = 400;
    throw error;
  }

  const person = findOrCreateCorePersonByName(db, actorName, coreLocalPersonSourcePath(row.local_path));
  const before = db
    .prepare(
      `
      SELECT CAST(wp.person_id AS TEXT) AS person_id, p.name
      FROM work_people wp
      JOIN people p ON p.id = wp.person_id
      WHERE wp.work_id = ?
        AND wp.role = 'actor'
      ORDER BY wp.sort_order, wp.person_id
      `
    )
    .all(coreWorkId);

  const now = new Date().toISOString();
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare("DELETE FROM work_people WHERE work_id = ? AND role = 'actor' AND person_id <> ?").run(coreWorkId, Number(person.id));
    db
      .prepare(
        `
        INSERT INTO work_people (work_id, person_id, role, sort_order, source, created_at, updated_at)
        VALUES (?, ?, 'actor', 0, 'local_folder_correction', ?, ?)
        ON CONFLICT(work_id, person_id, role) DO UPDATE SET
          sort_order = 0,
          source = excluded.source,
          updated_at = excluded.updated_at
        `
      )
      .run(coreWorkId, Number(person.id), now, now);
    const workRow = db.prepare("SELECT fields_json FROM works WHERE id = ?").get(coreWorkId);
    const fieldsJson = correctedActorFieldsJson(workRow?.fields_json, actorName);
    db.prepare("UPDATE works SET fields_json = ?, updated_at = ? WHERE id = ?").run(fieldsJson, now, coreWorkId);
    db.exec("COMMIT");
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {}
    throw error;
  }

  invalidateTableStamp("actor_movies", "work_info", "actor_profiles");
  refreshLibrary();
  const nextWork = resolveLibraryWorkByPublicId(String(coreWorkId));
  const nextPerson = resolveLibraryPersonByPublicId(String(person.id));
  return {
    actorName,
    person: nextPerson ? publicPerson(nextPerson) : { id: String(person.id), name: person.name || actorName },
    before,
    work: nextWork ? publicWork(nextWork, true) : null
  };
}

function moveWorkToPerson(workId, personId, options = {}) {
  const work = resolveLibraryWorkByPublicId(workId);
  if (!work || work.missingLocal) {
    const error = new Error("作品本地文件不存在");
    error.statusCode = 404;
    throw error;
  }
  if (!hasCoreDb()) {
    const error = new Error("core DB 不可用");
    error.statusCode = 500;
    throw error;
  }

  const db = getCoreDb();
  const coreWorkId = Number(work.id);
  if (!Number.isFinite(coreWorkId)) {
    const error = new Error("作品编号无效");
    error.statusCode = 400;
    throw error;
  }

  let createdPerson = null;
  if (!personId && options.createPerson) {
    createdPerson = createOrUpdateMoveTargetPerson(db, options.createPerson);
    personId = createdPerson.id;
    options = {
      ...options,
      targetDirectory: options.targetDirectory || createdPerson.targetDirectory
    };
  }

  const corePersonId = Number(personId);
  if (!Number.isFinite(corePersonId)) {
    const error = new Error("人物编号无效");
    error.statusCode = 400;
    throw error;
  }

  const targetPerson = resolveLibraryPersonByPublicId(String(corePersonId)) || corePersonFallbackRecord(String(corePersonId));
  if (!targetPerson?.id) {
    const error = new Error("目标人物不存在");
    error.statusCode = 404;
    throw error;
  }

  const row = db
    .prepare(
      `
      SELECT id, local_path, source_info_path
      FROM local_works
      WHERE work_id = ?
        AND local_path IS NOT NULL
        AND local_path <> ''
      ORDER BY id
      LIMIT 1
      `
    )
    .get(coreWorkId);
  if (!row?.local_path) {
    const error = new Error("这个作品没有本地文件夹");
    error.statusCode = 404;
    throw error;
  }

  const oldDir = ensureLibraryDirectoryPath(row.local_path, "作品文件夹");
  if (!safeStat(oldDir)?.isDirectory()) {
    const error = new Error("本地作品文件夹不存在");
    error.statusCode = 404;
    throw error;
  }
  const personDir = targetDirectoryForPerson(targetPerson, db, options);
  const newDir = ensureLibraryDirectoryPath(path.join(personDir, path.basename(oldDir)), "目标作品文件夹");
  if (path.resolve(oldDir).toLowerCase() === path.resolve(newDir).toLowerCase()) {
    const error = new Error("作品已经在目标人物文件夹中");
    error.statusCode = 409;
    throw error;
  }
  if (fs.existsSync(newDir)) {
    const error = new Error(`目标文件夹已存在：${relativeFromRoot(newDir)}`);
    error.statusCode = 409;
    throw error;
  }

  const before = db
    .prepare(
      `
      SELECT CAST(wp.person_id AS TEXT) AS person_id, p.name
      FROM work_people wp
      JOIN people p ON p.id = wp.person_id
      WHERE wp.work_id = ?
        AND wp.role = 'actor'
      ORDER BY wp.sort_order, wp.person_id
      `
    )
    .all(coreWorkId);

  let moveResult;
  try {
    moveResult = moveDirectorySync(oldDir, newDir);
  } catch (error) {
    const hint = isRetryableMoveError(error) ? "。请暂停播放并等待几秒，或关闭这个播放页后重试。" : "";
    const wrapped = new Error(`移动作品文件夹失败：${error.message}${hint}`);
    wrapped.statusCode = 500;
    throw wrapped;
  }

  const now = new Date().toISOString();
  try {
    db.exec("BEGIN IMMEDIATE");
    const fileRows = db.prepare("SELECT id, file_path FROM local_files WHERE local_work_id = ?").all(Number(row.id));
    const imageRows = db
      .prepare("SELECT id, local_path FROM images WHERE owner_type = 'work' AND owner_id = ? AND local_path IS NOT NULL AND local_path <> ''")
      .all(coreWorkId);

    db
      .prepare(
        `
        UPDATE local_works
        SET local_path = ?,
            source_info_path = CASE
              WHEN source_info_path IS NOT NULL AND source_info_path <> '' THEN ?
              ELSE source_info_path
            END,
            updated_at = ?
        WHERE id = ?
        `
      )
      .run(newDir, replacePathPrefix(row.source_info_path || "", oldDir, newDir), now, Number(row.id));

    const updateFile = db.prepare("UPDATE local_files SET file_path = ?, relative_path = ?, updated_at = ? WHERE id = ?");
    for (const fileRow of fileRows) {
      const nextPath = replacePathPrefix(fileRow.file_path, oldDir, newDir);
      updateFile.run(nextPath, relativeFromRoot(nextPath), now, fileRow.id);
    }

    const updateImage = db.prepare("UPDATE images SET local_path = ?, updated_at = ? WHERE id = ?");
    for (const imageRow of imageRows) {
      updateImage.run(replacePathPrefix(imageRow.local_path, oldDir, newDir), now, imageRow.id);
    }

    db.prepare("DELETE FROM work_people WHERE work_id = ? AND role = 'actor' AND person_id <> ?").run(coreWorkId, corePersonId);
    db
      .prepare(
        `
        INSERT INTO work_people (work_id, person_id, role, sort_order, source, created_at, updated_at)
        VALUES (?, ?, 'actor', 0, 'manual_move', ?, ?)
        ON CONFLICT(work_id, person_id, role) DO UPDATE SET
          sort_order = 0,
          source = excluded.source,
          updated_at = excluded.updated_at
        `
      )
      .run(coreWorkId, corePersonId, now, now);

    const actorName = targetPerson.name || `#${corePersonId}`;
    const workRow = db.prepare("SELECT fields_json FROM works WHERE id = ?").get(coreWorkId);
    const fieldsJson = correctedActorFieldsJson(workRow?.fields_json, actorName);
    db.prepare("UPDATE works SET fields_json = ?, updated_at = ? WHERE id = ?").run(fieldsJson, now, coreWorkId);
    db.exec("COMMIT");
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {}
    try {
      if (fs.existsSync(newDir) && !fs.existsSync(oldDir)) moveDirectorySync(newDir, oldDir);
    } catch (rollbackError) {
      error.message = `${error.message}; 回滚文件夹移动失败：${rollbackError.message}`;
    }
    throw error;
  }

  refreshLibrary();
  const nextWork = resolveLibraryWorkByPublicId(String(coreWorkId));
  const nextPerson = resolveLibraryPersonByPublicId(String(corePersonId));
  return {
    moved: true,
    moveMode: moveResult?.mode || "",
    oldPath: relativeFromRoot(oldDir),
    newPath: relativeFromRoot(newDir),
    createdPerson: createdPerson ? { id: createdPerson.id, name: createdPerson.name, created: createdPerson.created } : null,
    before,
    person: nextPerson ? publicPerson(nextPerson) : publicPerson(targetPerson),
    work: nextWork ? publicWork(nextWork, true) : null
  };
}

function removeEmptyLibraryParents(filePath) {
  const roots = libraryOpenRoots().map((rootPath) => path.resolve(rootPath));
  let current = path.dirname(path.resolve(filePath));
  const removed = [];

  while (current) {
    const root = roots.find((rootPath) => pathWithinRoot(current, rootPath));
    if (!root || path.resolve(current).toLowerCase() === path.resolve(root).toLowerCase()) break;
    try {
      if (fs.readdirSync(current).length) break;
      fs.rmdirSync(current);
      removed.push(relativeFromRoot(current));
    } catch {
      break;
    }
    current = path.dirname(current);
  }

  return removed;
}

function clearLocalDbRowsForWork(db, coreWorkId, localWorkIds) {
  if (!localWorkIds.length) return;
  const deleteFiles = db.prepare("DELETE FROM local_files WHERE local_work_id = ?");
  const deleteLocalWork = db.prepare("DELETE FROM local_works WHERE id = ?");
  const now = new Date().toISOString();
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const localWorkId of localWorkIds) {
      deleteFiles.run(localWorkId);
      deleteLocalWork.run(localWorkId);
    }
    db.prepare("UPDATE works SET updated_at = ? WHERE id = ?").run(now, coreWorkId);
    db.exec("COMMIT");
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {}
    throw error;
  }
}

function deleteWorkLocalFiles(workId, options = {}) {
  const work = resolveLibraryWorkByPublicId(workId);
  if (!work || work.missingLocal) {
    const error = new Error("作品本地文件不存在");
    error.statusCode = 404;
    throw error;
  }
  if (!hasCoreDb()) {
    const error = new Error("core DB 不可用");
    error.statusCode = 500;
    throw error;
  }

  const coreWorkId = Number(work.id);
  if (!Number.isFinite(coreWorkId)) {
    const error = new Error("作品编号无效");
    error.statusCode = 400;
    throw error;
  }

  const db = getCoreDb();
  const rows = db
    .prepare(
      `
      SELECT id, local_path
      FROM local_works
      WHERE work_id = ?
        AND local_path IS NOT NULL
        AND local_path <> ''
      ORDER BY id
      `
    )
    .all(coreWorkId);
  if (!rows.length) {
    const error = new Error("这个作品没有本地文件夹");
    error.statusCode = 404;
    throw error;
  }

  const deletedPaths = [];
  const missingPaths = [];
  const emptyRemovedPaths = [];
  for (const row of rows) {
    const dirPath = ensureLibraryDirectoryPath(row.local_path, "作品文件夹");
    const isRoot = libraryOpenRoots().some((rootPath) => path.resolve(dirPath).toLowerCase() === path.resolve(rootPath).toLowerCase());
    if (isRoot) {
      const error = new Error("拒绝删除资料库根目录");
      error.statusCode = 400;
      throw error;
    }

    const stat = safeStat(dirPath);
    if (stat?.isDirectory()) {
      try {
        fs.rmSync(dirPath, { recursive: true, force: false });
        deletedPaths.push(relativeFromRoot(dirPath));
        emptyRemovedPaths.push(...removeEmptyLibraryParents(dirPath));
      } catch (error) {
        const wrapped = new Error(`删除作品文件夹失败：${error.message}`);
        wrapped.statusCode = 500;
        throw wrapped;
      }
    } else {
      missingPaths.push(relativeFromRoot(dirPath));
    }
  }

  clearLocalDbRowsForWork(db, coreWorkId, rows.map((row) => Number(row.id)));
  localWorkCodeKeyCache = null;
  localWorkByCodeKeyCache = null;
  workSearchTextCache = null;
  invalidateTableStamp("local_works", "local_files", "work_info");
  if (options.refresh !== false) refreshLibrary();

  const person = corePersonFallbackRecord(work.personId) || library.peopleById.get(work.personId) || { id: work.personId || "", name: work.personName || "" };
  const missingWork = coreMissingWorksForPerson(person).find((item) => item.id === String(coreWorkId)) || {
    ...work,
    missingLocal: true,
    relativePath: "",
    videos: [],
    images: [],
    infos: [],
    videoCount: 0,
    playableCount: 0,
    imageCount: 0,
    infoCount: 0
  };

  return {
    deleted: deletedPaths.length > 0 || missingPaths.length > 0,
    deletedPaths,
    missingPaths,
    emptyRemovedPaths: uniqueTextArray(emptyRemovedPaths, { maxLength: 260, maxItems: 80 }),
    work: publicWork(missingWork, true)
  };
}

function deletePersonLocalFiles(personId) {
  const person = resolveLibraryPersonByPublicId(personId);
  if (!person) {
    const error = new Error("人物不存在或没有本地作品");
    error.statusCode = 404;
    throw error;
  }

  const workIds = [...(person.works || [])].filter((workId) => {
    const work = library.worksById.get(workId);
    return work && !work.missingLocal;
  });
  if (!workIds.length) {
    const error = new Error("这个人物没有可删除的本地作品");
    error.statusCode = 404;
    throw error;
  }

  const deleted = [];
  const failed = [];
  const emptyRemovedPaths = [];
  for (const workId of workIds) {
    const work = library.worksById.get(workId);
    try {
      const result = deleteWorkLocalFiles(workId, { refresh: false });
      deleted.push({
        workId: String(workId),
        title: work?.title || work?.directoryName || String(workId),
        deletedPaths: result.deletedPaths || [],
        missingPaths: result.missingPaths || []
      });
      emptyRemovedPaths.push(...(result.emptyRemovedPaths || []));
    } catch (error) {
      failed.push({
        workId: String(workId),
        title: work?.title || work?.directoryName || String(workId),
        error: error.message || "删除失败"
      });
    }
  }

  refreshLibrary();
  return {
    deletedCount: deleted.length,
    failedCount: failed.length,
    deleted,
    failed,
    emptyRemovedPaths: uniqueTextArray(emptyRemovedPaths, { maxLength: 260, maxItems: 80 })
  };
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
      works.push(coreLinkedScannedWork(personId, work));
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
      works.push(coreLinkedScannedWork(personId, work));
    }
  }

  return works;
}

function personSourcePathCandidates(person, options = {}) {
  if (Array.isArray(options.sourcePaths) && options.sourcePaths.length) {
    const selected = [];
    const seenSelected = new Set();
    for (const sourcePath of options.sourcePaths) {
      const absolutePath = sourcePathToAbsolute(sourcePath);
      const stat = absolutePath ? safeStat(absolutePath) : null;
      if (!stat?.isDirectory() || !libraryOpenRoots().some((rootPath) => pathWithinRoot(absolutePath, rootPath))) continue;
      const normalized = relativeFromRoot(absolutePath);
      const key = normalizeSourcePath(normalized);
      if (!key || seenSelected.has(key)) continue;
      seenSelected.add(key);
      selected.push(normalized);
    }
    return selected;
  }

  const sourcePaths = [];
  const seen = new Set();
  const addSourcePath = (sourcePath) => {
    const normalized = String(sourcePath || "").trim();
    if (!normalized) return;
    const key = normalizeSourcePath(normalized);
    if (!key || seen.has(key)) return;
    seen.add(key);
    sourcePaths.push(normalized);
  };

  for (const name of actorProfileSearchNames(person)) {
    if (!name || /[\\/]/.test(name)) continue;
    for (const rootPath of LIBRARY_ROOTS) {
      const absolutePath = path.join(rootPath, name);
      const stat = safeStat(absolutePath);
      if (stat?.isDirectory()) addSourcePath(relativeFromRoot(absolutePath));
    }
  }

  for (const sourcePath of [...(person.sourcePaths || []), person.relativePath]) {
    const absolutePath = sourcePathToAbsolute(sourcePath);
    const stat = absolutePath ? safeStat(absolutePath) : null;
    if (stat?.isDirectory()) addSourcePath(relativeFromRoot(absolutePath));
  }

  return sourcePaths;
}

function personSourceCandidates(person, options = {}) {
  const currentKeys = new Set([...(person.sourcePaths || []), person.relativePath].filter(Boolean).map(normalizeSourcePath));
  const records = [];
  const seen = new Set();
  const addRecord = (absolutePath, sourceName, reason) => {
    if (!absolutePath) return;
    const sourcePath = relativeFromRoot(absolutePath);
    const key = normalizeSourcePath(sourcePath);
    if (!key || seen.has(key)) return;
    seen.add(key);
    const stat = safeStat(absolutePath);
    const rootIndex = LIBRARY_ROOTS.findIndex((rootPath) => pathWithinRoot(absolutePath, rootPath));
    records.push({
      sourcePath,
      root: rootIndex >= 0 ? rootLabel(LIBRARY_ROOTS[rootIndex]) : "",
      sourceName: sourceName || path.basename(absolutePath),
      exists: Boolean(stat?.isDirectory()),
      selected: currentKeys.has(key),
      reason,
      priority: rootIndex >= 0 ? rootIndex : 999
    });
  };

  for (const name of actorProfileSearchNames(person)) {
    if (!name || /[\\/]/.test(name)) continue;
    for (const rootPath of LIBRARY_ROOTS) {
      addRecord(path.join(rootPath, name), name, "name");
    }
  }

  for (const sourcePath of [...(person.sourcePaths || []), person.relativePath]) {
    addRecord(sourcePathToAbsolute(sourcePath), path.basename(sourcePathToAbsolute(sourcePath) || sourcePath), "current");
  }

  for (const sourcePath of Array.isArray(options.extraSourcePaths) ? options.extraSourcePaths : []) {
    addRecord(sourcePathToAbsolute(sourcePath), path.basename(sourcePathToAbsolute(sourcePath) || sourcePath), "manual");
  }

  return records.sort((a, b) =>
    Number(b.selected) - Number(a.selected) ||
    Number(b.exists) - Number(a.exists) ||
    a.priority - b.priority ||
    a.sourcePath.localeCompare(b.sourcePath, undefined, { numeric: true, sensitivity: "base" })
  );
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
      const personId = personName;
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
    const coreLibrary = loadLibraryFromCoreDb();
    library = coreLibrary || scanLibrary();
    saveLibraryCache(library);
    invalidateLibraryDerivedCaches();
    lastScanError = null;
    console.log(
      `[${coreLibrary ? "core" : "scan"}] ${library.totals.people} people, ${library.totals.works} works, ${library.totals.videos} videos, ${library.totals.images} images`
    );
  } catch (error) {
    lastScanError = error;
    console.error("[scan]", error.message);
  }
}

function invalidateLibraryDerivedCaches() {
  workInfoCache = null;
  actorProfileCache = null;
  coreMapCache = null;
  actorMovieCache = null;
  actorMovieByCodeKeyCache = null;
  personMergeCache = null;
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

function refreshPersonLibrary(personId, options = {}) {
  const person = library.peopleById.get(personId);
  if (!person) {
    const error = new Error("人物不存在");
    error.statusCode = 404;
    throw error;
  }

  const sourcePaths = personSourcePathCandidates(person, options);
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
    try {
      replaceCoreLocalFilesForWork(work);
    } catch (error) {
      console.warn("[core-local-files]", error.message);
    }
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
    personMergeCache = null;
  }
  if (invalidates.has("actorMovies")) {
    invalidateTableStamp("actor_movies");
    actorMovieCache = null;
    actorMovieByCodeKeyCache = null;
    personMergeCache = null;
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
  if (invalidates.has("imageLibrary")) {
    imageLibraryCache = null;
    archiveImageListCache.clear();
  }
  if (invalidates.has("tvMetadata") || invalidates.has("movieMetadata") || invalidates.has("galleryMediaCovers")) {
    imageLibraryCache = null;
  }
  if (invalidates.has("novels")) {
    novelStore.invalidate();
  }
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

function getVideoProgress(videoId, work = null) {
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
    .map((video) => getVideoProgress(video.id, work))
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

function archiveImageListSignature(archivePath) {
  const stat = safeStat(archivePath);
  if (!stat?.isFile()) return null;
  return {
    archivePath: path.resolve(archivePath),
    archiveSize: stat.size || 0,
    archiveMtimeMs: Math.floor(stat.mtimeMs || 0)
  };
}

function archiveListCacheKeyFromSignature(signature) {
  if (!signature) return "";
  return `${signature.archivePath}|${signature.archiveSize}|${signature.archiveMtimeMs}`;
}

function archiveListCacheKey(archivePath) {
  return archiveListCacheKeyFromSignature(archiveImageListSignature(archivePath));
}

function sliceArchiveImagePayload(payload, limit = 0) {
  const images = Array.isArray(payload?.images) ? payload.images : [];
  const safeLimit = Math.max(0, Math.floor(Number(limit || 0)) || 0);
  return {
    imageCount: Number(payload?.imageCount || images.length || 0),
    images: safeLimit > 0 ? images.slice(0, safeLimit) : images
  };
}

function archiveImageIndexRow(signature) {
  if (!signature) return null;
  try {
    return getImageGalleryDb()
      .prepare("SELECT * FROM photo_set_image_indexes WHERE archive_path = ?")
      .get(signature.archivePath) || null;
  } catch {
    return null;
  }
}

function archiveImageIndexMatches(row, signature) {
  return Boolean(
    row &&
    signature &&
    path.resolve(row.archive_path || "") === signature.archivePath &&
    Number(row.archive_size || 0) === signature.archiveSize &&
    Number(row.archive_mtime_ms || 0) === signature.archiveMtimeMs
  );
}

function cachedArchiveImagesPayload(signature) {
  const row = archiveImageIndexRow(signature);
  if (!archiveImageIndexMatches(row, signature)) return null;
  try {
    const images = JSON.parse(row.images_json || "[]");
    if (!Array.isArray(images)) return null;
    return {
      imageCount: Number(row.image_count || images.length || 0),
      images
    };
  } catch {
    return null;
  }
}

function rememberArchiveImagesPayload(key, signature, payload) {
  const images = Array.isArray(payload?.images) ? payload.images : [];
  const imageCount = Number(payload?.imageCount || images.length || 0);
  archiveImageListCache.set(key, { createdAt: Date.now(), images, imageCount });
  if (archiveImageListCache.size > 300) {
    const firstKey = archiveImageListCache.keys().next().value;
    if (firstKey) archiveImageListCache.delete(firstKey);
  }
  if (!signature || !images.length) return;
  try {
    const now = new Date().toISOString();
    getImageGalleryDb()
      .prepare(`
        INSERT INTO photo_set_image_indexes (
          archive_path, archive_size, archive_mtime_ms, image_count,
          images_json, indexed_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(archive_path) DO UPDATE SET
          archive_size = excluded.archive_size,
          archive_mtime_ms = excluded.archive_mtime_ms,
          image_count = excluded.image_count,
          images_json = excluded.images_json,
          indexed_at = excluded.indexed_at,
          updated_at = excluded.updated_at
      `)
      .run(
        signature.archivePath,
        signature.archiveSize,
        signature.archiveMtimeMs,
        imageCount,
        JSON.stringify(images),
        now,
        now
      );
  } catch (error) {
    console.warn("[archive-image-index-cache]", error.message || error);
  }
}

function archiveImagesPayload(archivePath, options = {}) {
  const signature = archiveImageListSignature(archivePath);
  const key = archiveListCacheKeyFromSignature(signature);
  if (!key) return { imageCount: 0, images: [] };
  const now = Date.now();
  const limit = Number(options.limit || 0) || 0;
  const cached = archiveImageListCache.get(key);
  if (cached && now - cached.createdAt < IMAGE_READER_LIST_CACHE_TTL_MS) {
    return sliceArchiveImagePayload(cached, limit);
  }

  const persisted = cachedArchiveImagesPayload(signature);
  if (persisted) {
    rememberArchiveImagesPayload(key, signature, persisted);
    return sliceArchiveImagePayload(persisted, limit);
  }

  const payload = runArchiveImageHelper(["list", archivePath], { timeout: options.timeout || 120000 });
  const images = Array.isArray(payload.images) ? payload.images : [];
  const fullPayload = { images, imageCount: Number(payload.imageCount || images.length) };
  rememberArchiveImagesPayload(key, signature, fullPayload);
  return sliceArchiveImagePayload(fullPayload, limit);
}

function listArchiveImages(archivePath, options = {}) {
  return archiveImagesPayload(archivePath, options).images;
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

function galleryMediaCoverSeekSeconds(duration) {
  const seconds = Number(duration || 0);
  if (!Number.isFinite(seconds) || seconds <= 0) return 8;
  if (seconds < 20) return Math.max(0.1, Math.min(seconds * 0.5, Math.max(0.1, seconds - 0.25)));
  return Math.floor(Math.min(180, Math.max(8, seconds * 0.08)));
}

function extractGalleryMediaCoverFrame(filePath, duration) {
  const seek = galleryMediaCoverSeekSeconds(duration);
  const args = ["-hide_banner", "-loglevel", "error"];
  if (seek > 0) args.push("-ss", String(seek));
  args.push(
    "-i",
    filePath,
    "-map",
    "0:v:0",
    "-frames:v",
    "1",
    "-vf",
    `scale=${IMAGE_GALLERY_COVER_BOX_SIZE}:-2`,
    "-q:v",
    "5",
    "-f",
    "image2pipe",
    "-vcodec",
    "mjpeg",
    "pipe:1"
  );
  const result = spawnSync(FFMPEG_PATH, args, {
    windowsHide: true,
    maxBuffer: IMAGE_GALLERY_COVER_MAX_BYTES,
    timeout: 30000
  });
  if (result.error) {
    throw new Error(result.error.code === "ENOBUFS" ? "生成的分集封面超过大小限制" : `FFmpeg 启动失败：${result.error.message}`);
  }
  if (result.status !== 0 || !result.stdout?.length) {
    const detail = String(result.stderr || "").trim();
    throw new Error(detail ? `FFmpeg 抽帧失败：${detail}` : "FFmpeg 抽帧失败");
  }
  if (result.stdout.length > IMAGE_GALLERY_COVER_MAX_BYTES) throw new Error("生成的分集封面超过大小限制");
  if (result.stdout[0] !== 0xff || result.stdout[1] !== 0xd8) throw new Error("FFmpeg 没有生成有效的 JPEG 封面");
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

function archiveMemberBaseName(memberPath) {
  const parts = String(memberPath || "").replace(/\\/g, "/").split("/").filter(Boolean);
  return parts.pop() || "";
}

function archiveMemberDepth(memberPath) {
  return String(memberPath || "").replace(/\\/g, "/").split("/").filter(Boolean).length;
}

function archiveImageMime(memberPath) {
  return MIME_TYPES[normalizeExt(memberPath)] || "application/octet-stream";
}

function photoSetCoverHintScore(image) {
  const baseName = archiveMemberBaseName(image?.path || image?.name || "");
  const stem = fileBase(baseName).toLowerCase();
  const tokens = stem.split(/[\s._\-()[\]{}【】]+/).filter(Boolean);
  if (!stem) return 0;

  if (stem === "cover" || stem === "封面") return 1000;
  if (tokens.includes("cover") || tokens.includes("封面")) return 940;
  if (stem.includes("cover") || stem.includes("封面")) return 880;
  if (COVER_HINTS.has(stem)) return 760;
  if (tokens.some((token) => COVER_HINTS.has(token))) return 700;
  return 0;
}

function selectPhotoSetCoverImage(images = []) {
  const candidates = images.filter((image) => image?.path);
  if (!candidates.length) return null;

  const explicit = candidates
    .map((image, index) => {
      const hintScore = photoSetCoverHintScore(image);
      const depth = archiveMemberDepth(image.path);
      const ext = normalizeExt(image.path);
      const tieScore = (depth <= 1 ? 40 : Math.max(0, 30 - depth * 5)) + ([".jpg", ".jpeg", ".webp", ".png"].includes(ext) ? 10 : 0);
      return { image, index, score: hintScore + tieScore, hintScore };
    })
    .filter((item) => item.hintScore > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)[0];

  if (explicit) return { image: explicit.image, isExplicitCover: true };
  return { image: candidates[0], isExplicitCover: false };
}

function photoSetCoverBlobFromFile(filePath, image, isExplicitCover) {
  const sourceBytes = safeStat(filePath)?.size || Number(image?.bytes || 0);
  const mime = archiveImageMime(image?.path || image?.name || "");
  if (isExplicitCover && sourceBytes > 0 && sourceBytes <= IMAGE_GALLERY_COVER_MAX_BYTES) {
    return {
      blob: fs.readFileSync(filePath),
      mime,
      sourceBytes
    };
  }

  const blob = compressImageFileToJpeg(filePath);
  return {
    blob,
    mime: "image/jpeg",
    sourceBytes
  };
}

function photoSetCoverMatches(row, signature) {
  return (
    row &&
    signature &&
    path.resolve(row.archive_path || "") === signature.archivePath &&
    Number(row.archive_size || 0) === signature.archiveSize &&
    Number(row.archive_mtime_ms || 0) === signature.archiveMtimeMs &&
    Number(row.generator_version || 1) === PHOTO_SET_COVER_GENERATOR_VERSION
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
          cover_mime, cover_blob, cover_bytes, source_bytes, generator_version, status, error, generated_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(album_id) DO UPDATE SET
          archive_path = excluded.archive_path,
          archive_size = excluded.archive_size,
          archive_mtime_ms = excluded.archive_mtime_ms,
          member_path = excluded.member_path,
          cover_mime = excluded.cover_mime,
          cover_blob = excluded.cover_blob,
          cover_bytes = excluded.cover_bytes,
          source_bytes = excluded.source_bytes,
          generator_version = excluded.generator_version,
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
        PHOTO_SET_COVER_GENERATOR_VERSION,
        "error",
        error.message || String(error || "封面生成失败"),
        now,
        now
      );
  } catch (dbError) {
    console.warn("[image-gallery-cover-db]", dbError.message || dbError);
  }
}

function upsertPhotoSetCover(album, signature, image, cover) {
  const now = new Date().toISOString();
  const coverBlob = Buffer.from(cover.blob);
  getImageGalleryDb()
    .prepare(
      `
      INSERT INTO photo_set_covers (
        album_id, archive_path, archive_size, archive_mtime_ms, member_path,
        cover_mime, cover_blob, cover_bytes, source_bytes, generator_version, status, error, generated_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(album_id) DO UPDATE SET
        archive_path = excluded.archive_path,
        archive_size = excluded.archive_size,
        archive_mtime_ms = excluded.archive_mtime_ms,
        member_path = excluded.member_path,
        cover_mime = excluded.cover_mime,
        cover_blob = excluded.cover_blob,
        cover_bytes = excluded.cover_bytes,
        source_bytes = excluded.source_bytes,
        generator_version = excluded.generator_version,
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
      cover.mime || "image/jpeg",
      coverBlob,
      coverBlob.length,
      Number(cover.sourceBytes || image.bytes || 0),
      PHOTO_SET_COVER_GENERATOR_VERSION,
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

  const images = listArchiveImages(archivePath);
  const selected = selectPhotoSetCoverImage(images);
  if (!selected?.image?.path) {
    const error = new Error("图包里没有可用图片");
    error.statusCode = 404;
    upsertPhotoSetCoverError(album, signature, error);
    throw error;
  }

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "fanhao-gallery-cover-"));
  const tempExt = ARCHIVE_IMAGE_EXTS.has(normalizeExt(selected.image.path)) ? normalizeExt(selected.image.path) : ".img";
  const tempPath = path.join(tempDir, `source${tempExt}`);
  try {
    extractArchiveMemberToCache(archivePath, selected.image.path, tempPath);
    const cover = photoSetCoverBlobFromFile(tempPath, selected.image, selected.isExplicitCover);
    return upsertPhotoSetCover(album, signature, selected.image, cover);
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

function tvSeriesKey(category, seriesName) {
  return createId("tvs", `${String(category || "").trim()}|${String(seriesName || "").trim()}`);
}

function galleryMediaSeriesKey(item) {
  if (!item || item.mediaKind !== "tv") return "";
  return tvSeriesKey(item.category || "", item.seriesName || item.personName || item.subCategory || item.title || "");
}

function tvSeriesCoverUrl(seriesKey, updatedAt = "") {
  if (!seriesKey) return "";
  const suffix = updatedAt ? `?v=${encodeURIComponent(updatedAt)}` : "";
  return `/media/tv-series-cover/${encodeURIComponent(seriesKey)}${suffix}`;
}

function galleryMediaCoverUrl(mediaId, updatedAt = "") {
  if (!mediaId) return "";
  const suffix = updatedAt ? `?v=${encodeURIComponent(updatedAt)}` : "";
  return `/media/gallery-media-cover/${encodeURIComponent(mediaId)}${suffix}`;
}

function movieMetadataCoverUrl(mediaId, updatedAt = "") {
  if (!mediaId) return "";
  const suffix = updatedAt ? `?v=${encodeURIComponent(updatedAt)}` : "";
  return `/media/movie-cover/${encodeURIComponent(mediaId)}${suffix}`;
}

function safeJsonArray(value) {
  try {
    const parsed = JSON.parse(value || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function safeJsonObject(value) {
  try {
    const parsed = JSON.parse(value || "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function tvSeriesMetadataRowsMap() {
  try {
    const rows = getImageGalleryDb().prepare("SELECT * FROM tv_series_metadata").all();
    return new Map(rows.map((row) => [row.series_key, row]));
  } catch (error) {
    console.warn("[tv-series-metadata-db]", error.message || error);
    return new Map();
  }
}

function tvSeriesMetadataRow(seriesKey) {
  if (!seriesKey) return null;
  try {
    return getImageGalleryDb().prepare("SELECT * FROM tv_series_metadata WHERE series_key = ?").get(seriesKey) || null;
  } catch (error) {
    console.warn("[tv-series-metadata-db]", error.message || error);
    return null;
  }
}

function movieMetadataRowsMap() {
  try {
    const rows = getImageGalleryDb().prepare("SELECT * FROM movie_metadata").all();
    return new Map(rows.map((row) => [row.media_id, row]));
  } catch (error) {
    console.warn("[movie-metadata-db]", error.message || error);
    return new Map();
  }
}

function movieMetadataRow(mediaId) {
  if (!mediaId) return null;
  try {
    return getImageGalleryDb().prepare("SELECT * FROM movie_metadata WHERE media_id = ?").get(mediaId) || null;
  } catch (error) {
    console.warn("[movie-metadata-db]", error.message || error);
    return null;
  }
}

function publicMovieMetadata(row) {
  if (!row || row.status !== "ok") return null;
  return {
    mediaId: row.media_id || "",
    category: row.category || "",
    movieTitle: row.movie_title || "",
    doubanId: row.douban_id || "",
    doubanUrl: row.douban_url || "",
    title: row.douban_title || row.movie_title || "",
    originalTitle: row.original_title || "",
    aliases: safeJsonArray(row.aka_json),
    officialSite: row.official_site || "",
    year: row.year || "",
    rating: row.rating === null || row.rating === undefined ? null : Number(row.rating || 0),
    ratingCount: Number(row.rating_count || 0),
    ratingStars: safeJsonObject(row.rating_stars_json),
    ratingBetterThan: safeJsonArray(row.rating_better_than_json),
    directors: safeJsonArray(row.directors_json),
    writers: safeJsonArray(row.writers_json),
    genres: safeJsonArray(row.genres_json),
    actors: safeJsonArray(row.actors_json),
    countries: safeJsonArray(row.countries_json),
    languages: safeJsonArray(row.languages_json),
    pubdate: row.pubdate || "",
    releaseDates: safeJsonArray(row.release_dates_json),
    seasonCount: row.season_count === null || row.season_count === undefined ? null : Number(row.season_count || 0),
    episodeCount: row.episode_count === null || row.episode_count === undefined ? null : Number(row.episode_count || 0),
    episodeDuration: row.episode_duration || "",
    durations: safeJsonArray(row.durations_json),
    imdbId: row.imdb_id || "",
    info: safeJsonObject(row.info_json),
    detailSource: row.detail_source || "",
    summary: row.summary || "",
    coverUrl: row.cover_blob ? movieMetadataCoverUrl(row.media_id, row.updated_at || "") : "",
    fetchedAt: row.fetched_at || "",
    updatedAt: row.updated_at || ""
  };
}

function publicTvSeriesMetadata(row) {
  if (!row || row.status !== "ok") return null;
  return {
    seriesKey: row.series_key || "",
    category: row.category || "",
    seriesName: row.series_name || "",
    doubanId: row.douban_id || "",
    doubanUrl: row.douban_url || "",
    title: row.douban_title || row.series_name || "",
    originalTitle: row.original_title || "",
    aliases: safeJsonArray(row.aka_json),
    officialSite: row.official_site || "",
    year: row.year || "",
    rating: row.rating === null || row.rating === undefined ? null : Number(row.rating || 0),
    ratingCount: Number(row.rating_count || 0),
    ratingStars: safeJsonObject(row.rating_stars_json),
    ratingBetterThan: safeJsonArray(row.rating_better_than_json),
    directors: safeJsonArray(row.directors_json),
    writers: safeJsonArray(row.writers_json),
    genres: safeJsonArray(row.genres_json),
    actors: safeJsonArray(row.actors_json),
    countries: safeJsonArray(row.countries_json),
    languages: safeJsonArray(row.languages_json),
    pubdate: row.pubdate || "",
    releaseDates: safeJsonArray(row.release_dates_json),
    seasonCount: row.season_count === null || row.season_count === undefined ? null : Number(row.season_count || 0),
    episodeCount: row.episode_count === null || row.episode_count === undefined ? null : Number(row.episode_count || 0),
    episodeDuration: row.episode_duration || "",
    durations: safeJsonArray(row.durations_json),
    imdbId: row.imdb_id || "",
    info: safeJsonObject(row.info_json),
    detailSource: row.detail_source || "",
    summary: row.summary || "",
    coverUrl: row.cover_blob ? tvSeriesCoverUrl(row.series_key, row.updated_at || "") : "",
    fetchedAt: row.fetched_at || "",
    updatedAt: row.updated_at || ""
  };
}

function galleryMediaCoverRow(mediaId) {
  if (!mediaId) return null;
  try {
    return getImageGalleryDb().prepare("SELECT * FROM gallery_media_covers WHERE media_id = ?").get(mediaId) || null;
  } catch (error) {
    console.warn("[gallery-media-cover-db]", error.message || error);
    return null;
  }
}

function galleryMediaSignature(item) {
  const filePath = galleryMediaPath(item);
  const stat = safeStat(filePath);
  if (!stat?.isFile()) return null;
  return {
    filePath,
    sourcePath: path.resolve(filePath),
    sourceSize: stat.size || 0,
    sourceMtimeMs: Math.floor(stat.mtimeMs || 0)
  };
}

function galleryMediaCoverMatches(row, signature) {
  return (
    row &&
    signature &&
    path.resolve(row.source_path || "") === signature.sourcePath &&
    Number(row.source_size || 0) === signature.sourceSize &&
    Number(row.source_mtime_ms || 0) === signature.sourceMtimeMs &&
    Number(row.generator_version || 1) === GALLERY_MEDIA_COVER_GENERATOR_VERSION
  );
}

function upsertGalleryMediaCoverError(item, signature, error) {
  const now = new Date().toISOString();
  try {
    getImageGalleryDb()
      .prepare(
        `
        INSERT INTO gallery_media_covers (
          media_id, source_path, source_size, source_mtime_ms, cover_mime,
          cover_blob, cover_bytes, generator_version, status, error, generated_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(media_id) DO UPDATE SET
          source_path = excluded.source_path,
          source_size = excluded.source_size,
          source_mtime_ms = excluded.source_mtime_ms,
          cover_mime = excluded.cover_mime,
          cover_blob = excluded.cover_blob,
          cover_bytes = excluded.cover_bytes,
          generator_version = excluded.generator_version,
          status = excluded.status,
          error = excluded.error,
          generated_at = excluded.generated_at,
          updated_at = excluded.updated_at
        `
      )
      .run(
        item?.id || "",
        signature?.sourcePath || "",
        signature?.sourceSize || 0,
        signature?.sourceMtimeMs || 0,
        "",
        null,
        0,
        GALLERY_MEDIA_COVER_GENERATOR_VERSION,
        "error",
        String(error?.message || error || "分集封面生成失败").slice(0, 1000),
        now,
        now
      );
  } catch (dbError) {
    console.warn("[gallery-media-cover-db]", dbError.message || dbError);
  }
}

function upsertGalleryMediaCover(item, signature, coverBlob) {
  const now = new Date().toISOString();
  const blob = Buffer.from(coverBlob);
  getImageGalleryDb()
    .prepare(
      `
      INSERT INTO gallery_media_covers (
        media_id, source_path, source_size, source_mtime_ms, cover_mime,
        cover_blob, cover_bytes, generator_version, status, error, generated_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(media_id) DO UPDATE SET
        source_path = excluded.source_path,
        source_size = excluded.source_size,
        source_mtime_ms = excluded.source_mtime_ms,
        cover_mime = excluded.cover_mime,
        cover_blob = excluded.cover_blob,
        cover_bytes = excluded.cover_bytes,
        generator_version = excluded.generator_version,
        status = excluded.status,
        error = excluded.error,
        generated_at = excluded.generated_at,
        updated_at = excluded.updated_at
      `
    )
    .run(
      item.id,
      signature.sourcePath,
      signature.sourceSize,
      signature.sourceMtimeMs,
      "image/jpeg",
      blob,
      blob.length,
      GALLERY_MEDIA_COVER_GENERATOR_VERSION,
      "ok",
      "",
      now,
      now
    );
  return galleryMediaCoverRow(item.id);
}

function generateGalleryMediaCover(item) {
  const signature = galleryMediaSignature(item);
  if (!signature) {
    const error = new Error("视频文件不存在");
    error.statusCode = 404;
    throw error;
  }

  const cached = galleryMediaCoverRow(item.id);
  if (galleryMediaCoverMatches(cached, signature)) {
    if (cached.status === "ok" && cached.cover_blob) return cached;
    const error = new Error(cached.error || "分集封面生成失败");
    error.statusCode = 404;
    throw error;
  }

  try {
    const probe = videoProbeCached({ id: item.id, path: signature.filePath }) || {};
    const coverBlob = extractGalleryMediaCoverFrame(signature.filePath, probe.duration);
    return upsertGalleryMediaCover(item, signature, coverBlob);
  } catch (error) {
    upsertGalleryMediaCoverError(item, signature, error);
    error.statusCode = error.statusCode || 500;
    throw error;
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

function mediaItemsByKinds(items, kinds = []) {
  const selected = new Set(kinds);
  return items.filter((item) => selected.has(item.mediaKind));
}

function publicGalleryMediaItem(item, tvMetadataByKey = null, movieMetadataById = null) {
  const seriesKey = galleryMediaSeriesKey(item);
  const tvSeries = seriesKey ? publicTvSeriesMetadata(tvMetadataByKey?.get(seriesKey) || tvSeriesMetadataRow(seriesKey)) : null;
  const movieMetadata = item?.mediaKind === "movie" ? publicMovieMetadata(movieMetadataById?.get(item.id) || movieMetadataRow(item.id)) : null;
  const movieCoverUrl = movieMetadata?.coverUrl || "";
  const fallbackCoverUrl = item.mediaKind === "tv" || item.mediaKind === "movie" ? galleryMediaCoverUrl(item.id, item.updatedAt || "") : "";
  return {
    ...item,
    seriesKey,
    tvSeries,
    movieMetadata,
    coverUrl: movieCoverUrl || fallbackCoverUrl || item.coverUrl || ""
  };
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
  const tvMetadataByKey = tvSeriesMetadataRowsMap();
  const movieMetadataById = movieMetadataRowsMap();
  const mediaItems = (Array.isArray(index.mediaItems) ? index.mediaItems : []).map((item) => publicGalleryMediaItem(item, tvMetadataByKey, movieMetadataById));
  const westernItems = mediaItemsByKind(mediaItems, "western");
  const movieItems = mediaItemsByKind(mediaItems, "movie");
  const tvItems = mediaItemsByKind(mediaItems, "tv");
  const screenItems = mediaItemsByKinds(mediaItems, ["movie", "tv"]);
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
      tv: mediaFacets(tvItems),
      media: mediaFacets(screenItems)
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
  const screenItems = mediaItemsByKinds(mediaItems, ["movie", "tv"]);
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
      tv: mediaFacets(tvItems),
      media: mediaFacets(screenItems)
    }
  };
}

function imageLibraryItemsPayload(url, options = {}) {
  const mode = normalizeImageLibraryMode(url.searchParams.get("mode"));
  const limit = clampInteger(url.searchParams.get("limit"), 48, 1, MAX_IMAGE_LIBRARY_ITEM_LIMIT);
  const offset = clampInteger(url.searchParams.get("offset"), 0, 0, Number.MAX_SAFE_INTEGER);
  const query = String(url.searchParams.get("q") || url.searchParams.get("search") || "").trim();
  const sort = String(url.searchParams.get("sort") || "updated").trim();
  const photoView = normalizePhotoLibraryView(url.searchParams.get("photoView") || url.searchParams.get("view"));
  const tvView = normalizeTvLibraryView(url.searchParams.get("tvView") || url.searchParams.get("view"));
  const category = String(url.searchParams.get("category") || "all").trim() || "all";
  const person = String(url.searchParams.get("person") || "all").trim() || "all";
  const collection = String(url.searchParams.get("collection") || "").trim();
  const seriesKey = String(url.searchParams.get("seriesKey") || "").trim();
  const index = getImageLibraryIndex(options);
  const tvMetadataByKey = tvSeriesMetadataRowsMap();
  const movieMetadataById = movieMetadataRowsMap();
  const mediaItems = (Array.isArray(index.mediaItems) ? index.mediaItems : []).map((item) => publicGalleryMediaItem(item, tvMetadataByKey, movieMetadataById));

  let source = [];
  let facetsSource = [];
  let collectionSummary = null;
  let seriesSummary = null;
  if (mode === "photo") {
    const photoSets = Array.isArray(index.photoSets) ? index.photoSets : [];
    const filteredPhotoSets = filterPhotoSetsForList(photoSets, { category, person, collection });
    facetsSource = collection ? filteredPhotoSets : filterPhotoSetsForList(photoSets, { collection: "", category: "all", person: "all" });
    if (collection) collectionSummary = photoCollectionSummary(filteredPhotoSets, collection);
    source = photoView === "collections" && !collection
      ? photoCollectionGroups(filteredPhotoSets).map(publicPhotoCollectionListItem)
      : filteredPhotoSets.map((item) => publicImageLibraryListItem(item, "photo"));
  } else if (mode === "manga") {
    source = mangaCacheDirs().map((cacheDir) => publicImageLibraryListItem(publicMangaSummary(cacheDir), "manga"));
  } else if (mode === "media") {
    const movieSource = mediaItemsByKind(mediaItems, "movie").map((item) => publicImageLibraryListItem(item, item.mediaKind));
    const tvSource = mediaItemsByKind(mediaItems, "tv").map((item) => publicImageLibraryListItem(item, item.mediaKind));
    const tvSeriesSource = tvSeriesGroups(tvSource).map(publicTvSeriesListItem).filter(Boolean);
    const screenWorksSource = [...movieSource, ...tvSeriesSource];
    facetsSource = screenWorksSource;
    if (seriesKey) {
      const categorySource = filterMediaItemsForList(tvSource, { category });
      source = categorySource.filter((item) => item.seriesKey === seriesKey);
      seriesSummary = publicTvSeriesListItem(tvSeriesGroups(tvSource).find((group) => group.seriesKey === seriesKey) || null);
    } else {
      source = filterMediaItemsForList(screenWorksSource, { category });
    }
  } else if (["western", "movie", "tv"].includes(mode)) {
    const mediaSource = mediaItemsByKind(mediaItems, mode).map((item) => publicImageLibraryListItem(item, mode));
    const categorySource = filterMediaItemsForList(mediaSource, { category });
    if (mode === "tv") {
      const tvSeriesSource = tvSeriesGroups(mediaSource).map(publicTvSeriesListItem);
      facetsSource = tvSeriesSource;
      if (seriesKey) {
        source = categorySource.filter((item) => item.seriesKey === seriesKey);
        seriesSummary = publicTvSeriesListItem(tvSeriesGroups(mediaSource).find((group) => group.seriesKey === seriesKey) || null);
      } else if (tvView === "episodes") {
        source = categorySource;
      } else {
        source = tvSeriesGroups(categorySource).map(publicTvSeriesListItem);
      }
    } else {
      facetsSource = mediaSource;
      source = categorySource;
    }
  }

  const filtered = filterImageLibraryItems(source, query);
  const sorted = sortImageLibraryItems(filtered, sort);
  const items = sorted.slice(offset, offset + limit);
  return {
    schemaVersion: 1,
    mode,
    query,
    sort,
    photoView: mode === "photo" ? (collection ? "albums" : photoView) : "",
    tvView: mode === "tv" ? (seriesKey || tvView === "episodes" ? "episodes" : "series") : mode === "media" && seriesKey ? "episodes" : "",
    category: ["photo", "western", "movie", "tv", "media"].includes(mode) ? category : "",
    person: mode === "photo" ? person : "",
    collection: mode === "photo" ? collection : "",
    collectionSummary,
    seriesKey: ["tv", "media"].includes(mode) ? seriesKey : "",
    seriesSummary,
    facets: mode === "photo" ? photoLibraryFacets(facetsSource) : mediaLibraryFacets(facetsSource),
    count: items.length,
    total: sorted.length,
    limit,
    offset,
    scannedAt: index.scannedAt || "",
    items
  };
}

function normalizePhotoLibraryView(value) {
  const view = String(value || "").trim().toLowerCase();
  return view === "collections" || view === "collection" ? "collections" : "albums";
}

function normalizeTvLibraryView(value) {
  const view = String(value || "").trim().toLowerCase();
  return view === "episodes" || view === "episode" || view === "items" ? "episodes" : "series";
}

function normalizeImageLibraryMode(value) {
  const mode = String(value || "").trim().toLowerCase();
  if (mode === "photos" || mode === "photo-set" || mode === "photo-sets") return "photo";
  if (mode === "movies") return "movie";
  if (["media", "video", "screen", "film", "films"].includes(mode)) return "media";
  if (["photo", "manga", "western", "movie", "tv"].includes(mode)) return mode;
  return "photo";
}

function hasCjkText(value) {
  return /[\u3400-\u9FFF\uF900-\uFAFF]/.test(String(value || ""));
}

function movieChineseTitle(value) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (!hasCjkText(text)) return text;
  const parts = text.split(" ");
  const lastCjk = parts.reduce((last, part, index) => (hasCjkText(part) ? index : last), -1);
  return lastCjk >= 0 ? parts.slice(0, lastCjk + 1).join(" ").trim() : text;
}

function moviePrimaryDisplayTitle(item, metadata) {
  const aliases = Array.isArray(metadata?.aliases) ? metadata.aliases : [];
  const candidates = [
    metadata?.title,
    metadata?.movieTitle,
    ...aliases.filter(hasCjkText),
    item?.title,
    item?.dirName
  ].map((value) => String(value || "").trim()).filter(Boolean);
  const title = candidates.find(hasCjkText) || candidates[0] || "";
  return movieChineseTitle(title);
}

function publicImageLibraryListItem(item, mode) {
  const normalizedMode = normalizeImageLibraryMode(mode || item?.mediaKind || item?.type);
  const movieMetadata = item?.movieMetadata || null;
  const movieTitle = normalizedMode === "movie" ? moviePrimaryDisplayTitle(item, movieMetadata) : "";
  const displayTitle =
    normalizedMode === "movie" && movieTitle
      ? [movieTitle, movieMetadata?.year ? `(${movieMetadata.year})` : ""].filter(Boolean).join(" ")
      : String(item?.title || item?.dirName || "").trim();
  return {
    id: String(item?.id || ""),
    type: normalizedMode,
    title: displayTitle,
    category: String(item?.category || item?.site || item?.kindLabel || "").trim(),
    subCategory: String(item?.subCategory || "").trim(),
    personName: String(item?.personName || "").trim(),
    seriesName: String(item?.seriesName || "").trim(),
    seriesKey: String(item?.seriesKey || "").trim(),
    tvSeries: item?.tvSeries || null,
    movieMetadata,
    rootLabel: String(item?.rootLabel || item?.kindLabel || "").trim(),
    ext: String(item?.archiveExt || item?.ext || "").trim(),
    size: Number(item?.size || 0),
    updatedAt: String(item?.updatedAt || "").trim(),
    imageCount: item?.imageCount === null || item?.imageCount === undefined ? null : Number(item.imageCount || 0),
    chapterCount: item?.chapterCount === undefined ? null : Number(item.chapterCount || 0),
    doneChapterCount: item?.doneChapterCount === undefined ? null : Number(item.doneChapterCount || 0),
    downloadedCount: item?.downloadedCount === undefined ? null : Number(item.downloadedCount || 0),
    failedCount: item?.failedCount === undefined ? null : Number(item.failedCount || 0),
    albumCount: item?.albumCount === undefined ? null : Number(item.albumCount || 0),
    collectionId: normalizedMode === "photo" ? photoCollectionValue(item) : "",
    collectionTitle: normalizedMode === "photo" ? photoCollectionDisplayName(photoCollectionDir(item)) : "",
    playable: Boolean(item?.playable),
    coverUrl: String(item?.coverUrl || (normalizedMode === "photo" ? photoSetCoverUrl(item?.id, item?.updatedAt || "") : "")).trim(),
    rating: item?.movieMetadata?.rating === null || item?.movieMetadata?.rating === undefined ? item?.rating ?? null : Number(item.movieMetadata.rating || 0),
    ratingCount: item?.movieMetadata?.ratingCount === null || item?.movieMetadata?.ratingCount === undefined ? item?.ratingCount ?? null : Number(item.movieMetadata.ratingCount || 0),
    year: String(item?.movieMetadata?.year || item?.year || "").trim(),
    genres: Array.isArray(item?.movieMetadata?.genres) ? item.movieMetadata.genres : Array.isArray(item?.genres) ? item.genres : [],
    routePath: imageLibraryItemRoutePath(normalizedMode, item?.id)
  };
}

function publicPhotoCollectionListItem(group) {
  return {
    id: group.value,
    type: "photoCollection",
    title: group.title,
    category: group.categories.slice(0, 3).join(" · "),
    subCategory: group.subCategories.slice(0, 3).join(" · "),
    personName: "",
    seriesName: "",
    rootLabel: group.rootLabel,
    ext: "",
    size: group.size,
    updatedAt: group.updatedAt,
    imageCount: group.imageCount,
    albumCount: group.count,
    collectionId: group.value,
    collectionTitle: group.title,
    playable: false,
    coverUrl: group.coverUrl,
    routePath: `/photo/collection/${encodeURIComponent(group.value)}`
  };
}

function tvSeriesGroups(items = []) {
  const groups = new Map();
  for (const item of items) {
    const seriesKey = String(item?.seriesKey || "").trim() || tvSeriesKey(item?.category || "", item?.seriesName || item?.personName || item?.subCategory || item?.title || "");
    if (!seriesKey) continue;
    let group = groups.get(seriesKey);
    if (!group) {
      group = {
        seriesKey,
        type: "tvSeries",
        title: item?.tvSeries?.title || item?.seriesName || item?.personName || item?.subCategory || item?.title || "电视剧",
        seriesName: item?.seriesName || item?.personName || item?.subCategory || "",
        category: item?.category || "",
        rootLabel: item?.rootLabel || "",
        tvSeries: item?.tvSeries || null,
        coverUrl: item?.tvSeries?.coverUrl || "",
        size: 0,
        episodeCount: 0,
        playableCount: 0,
        updatedAt: "",
        firstEpisodeId: item?.id || ""
      };
      groups.set(seriesKey, group);
    }
    group.episodeCount += 1;
    if (item?.playable) group.playableCount += 1;
    group.size += Number(item?.size || 0);
    if (!group.coverUrl && item?.tvSeries?.coverUrl) group.coverUrl = item.tvSeries.coverUrl;
    if (!group.tvSeries && item?.tvSeries) group.tvSeries = item.tvSeries;
    if (!group.firstEpisodeId && item?.id) group.firstEpisodeId = item.id;
    if (String(item?.updatedAt || "") > String(group.updatedAt || "")) group.updatedAt = String(item.updatedAt || "");
  }
  return [...groups.values()];
}

function publicTvSeriesListItem(group) {
  if (!group) return null;
  const meta = group.tvSeries || {};
  return {
    id: group.seriesKey,
    type: "tvSeries",
    title: String(meta.title || group.title || group.seriesName || "电视剧").trim(),
    category: String(group.category || meta.category || "").trim(),
    subCategory: String(group.seriesName || "").trim(),
    personName: String(group.seriesName || group.title || "").trim(),
    seriesName: String(group.seriesName || group.title || "").trim(),
    seriesKey: String(group.seriesKey || "").trim(),
    tvSeries: group.tvSeries || null,
    rootLabel: String(group.rootLabel || "").trim(),
    ext: "",
    size: Number(group.size || 0),
    updatedAt: String(group.updatedAt || meta.updatedAt || "").trim(),
    imageCount: null,
    chapterCount: Number(group.episodeCount || 0),
    doneChapterCount: Number(group.playableCount || 0),
    downloadedCount: null,
    failedCount: null,
    albumCount: null,
    collectionId: "",
    collectionTitle: "",
    playable: Boolean(group.playableCount),
    coverUrl: String(group.coverUrl || meta.coverUrl || "").trim(),
    firstEpisodeId: String(group.firstEpisodeId || "").trim(),
    rating: meta.rating === null || meta.rating === undefined ? null : Number(meta.rating || 0),
    ratingCount: meta.ratingCount === null || meta.ratingCount === undefined ? null : Number(meta.ratingCount || 0),
    year: String(meta.year || "").trim(),
    genres: Array.isArray(meta.genres) ? meta.genres : [],
    routePath: `/tv?seriesKey=${encodeURIComponent(String(group.seriesKey || ""))}`
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
      item.ext,
      item.movieMetadata?.title,
      item.movieMetadata?.originalTitle,
      item.movieMetadata?.imdbId,
      ...(item.movieMetadata?.aliases || []),
      ...(item.movieMetadata?.directors || []),
      ...(item.movieMetadata?.writers || []),
      ...(item.movieMetadata?.actors || []),
      ...(item.movieMetadata?.genres || []),
      item.tvSeries?.title,
      item.tvSeries?.originalTitle,
      item.tvSeries?.imdbId,
      ...(item.tvSeries?.aliases || []),
      ...(item.tvSeries?.directors || []),
      ...(item.tvSeries?.writers || []),
      ...(item.tvSeries?.actors || []),
      ...(item.tvSeries?.genres || [])
    ]
      .filter(Boolean)
      .some((value) => String(value).toLowerCase().includes(needle))
  );
}

function filterPhotoSetsForList(items, filters = {}) {
  return (items || []).filter((item) => {
    if (filters.category && filters.category !== "all" && item.category !== filters.category) return false;
    if (filters.person && filters.person !== "all" && item.personName !== filters.person) return false;
    if (filters.collection && photoCollectionValue(item) !== filters.collection) return false;
    return true;
  });
}

function photoLibraryFacets(items = []) {
  return {
    categories: facetCounts(items, "category"),
    people: facetCounts(items, "personName").slice(0, 20)
  };
}

function mediaLibraryFacets(items = []) {
  return {
    categories: facetCounts(items, "category").slice(0, 24),
    people: facetCounts(items, "personName").slice(0, 20),
    roots: facetCounts(items, "rootLabel").slice(0, 12)
  };
}

function filterMediaItemsForList(items, filters = {}) {
  return (items || []).filter((item) => {
    if (filters.category && filters.category !== "all" && item.category !== filters.category) return false;
    return true;
  });
}

function photoCollectionDir(item) {
  const relativePath = String(item?.relativePath || "").replace(/[\\/]+/g, "/");
  const parts = relativePath.split("/").filter(Boolean);
  if (parts.length <= 1) return PHOTO_COLLECTION_ROOT_VALUE;
  return parts.slice(0, -1).join("/");
}

function photoCollectionValue(item) {
  return [item?.sourceRoot || item?.rootLabel || "", photoCollectionDir(item)].join("|");
}

function photoCollectionDisplayName(dirValue) {
  const dir = String(dirValue || "").trim();
  if (!dir || dir === PHOTO_COLLECTION_ROOT_VALUE) return "根目录合集";
  const last = dir.split("/").filter(Boolean).pop() || dir;
  const bracketOnly = last.match(/^\[([^\]]+)\]$/);
  return bracketOnly ? bracketOnly[1].trim() || last : last;
}

function photoCollectionGroups(items = []) {
  const groups = new Map();
  for (const item of items) {
    const dir = photoCollectionDir(item);
    const value = photoCollectionValue(item);
    let group = groups.get(value);
    if (!group) {
      group = {
        value,
        title: photoCollectionDisplayName(dir),
        dir,
        rootLabel: item.rootLabel || "",
        count: 0,
        size: 0,
        imageCount: 0,
        updatedAt: "",
        coverUrl: item.coverUrl || photoSetCoverUrl(item.id, item.updatedAt || ""),
        categories: new Set(),
        subCategories: new Set()
      };
      groups.set(value, group);
    }
    group.count += 1;
    group.size += Number(item.size || 0);
    group.imageCount += Number(item.imageCount || 0);
    if (!group.coverUrl && item.coverUrl) group.coverUrl = item.coverUrl;
    if (item.category) group.categories.add(item.category);
    if (item.subCategory) group.subCategories.add(item.subCategory);
    const itemTime = new Date(item.updatedAt || 0).getTime();
    const groupTime = new Date(group.updatedAt || 0).getTime();
    if (itemTime > groupTime) group.updatedAt = item.updatedAt || group.updatedAt;
  }
  return [...groups.values()]
    .map((group) => ({
      ...group,
      categories: [...group.categories],
      subCategories: [...group.subCategories]
    }))
    .sort((a, b) => b.count - a.count || new Date(b.updatedAt || 0).getTime() - new Date(a.updatedAt || 0).getTime() || a.title.localeCompare(b.title, undefined, { numeric: true, sensitivity: "base" }));
}

function photoCollectionSummary(items = [], collectionValue = "") {
  if (!collectionValue) return null;
  const first = items[0] || {};
  return {
    id: collectionValue,
    title: photoCollectionDisplayName(photoCollectionDir(first)),
    rootLabel: first.rootLabel || "",
    count: items.length,
    size: items.reduce((sum, item) => sum + Number(item.size || 0), 0),
    imageCount: items.reduce((sum, item) => sum + Number(item.imageCount || 0), 0),
    updatedAt: items.reduce((latest, item) => {
      const itemTime = new Date(item.updatedAt || 0).getTime();
      const latestTime = new Date(latest || 0).getTime();
      return itemTime > latestTime ? item.updatedAt : latest;
    }, "")
  };
}

function sortImageLibraryItems(items, sort) {
  const list = [...items];
  if (sort === "title") {
    return list.sort((a, b) => a.title.localeCompare(b.title, undefined, { numeric: true, sensitivity: "base" }));
  }
  if (sort === "size") {
    return list.sort((a, b) => Number(b.size || 0) - Number(a.size || 0) || a.title.localeCompare(b.title, undefined, { numeric: true, sensitivity: "base" }));
  }
  if (sort === "rating") {
    return list.sort((a, b) => {
      const aRating = Number(a.rating || a.tvSeries?.rating || 0);
      const bRating = Number(b.rating || b.tvSeries?.rating || 0);
      const aHasRating = aRating > 0;
      const bHasRating = bRating > 0;
      if (aHasRating !== bHasRating) return aHasRating ? -1 : 1;
      if (aRating !== bRating) return bRating - aRating;
      return a.title.localeCompare(b.title, undefined, { numeric: true, sensitivity: "base" });
    });
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

function publicPhotoSetDetail(album, options = {}) {
  const archivePath = photoSetArchivePath(album);
  const imageOffset = Math.max(0, Math.floor(Number(options.imageOffset || 0)) || 0);
  const rawImageLimit = options.imageLimit;
  const imageLimit = Number.isFinite(Number(rawImageLimit)) && Number(rawImageLimit) > 0
    ? Math.floor(Number(rawImageLimit))
    : 0;
  const payload = archiveImagesPayload(archivePath, {
    limit: imageLimit > 0 ? imageOffset + imageLimit : 0
  });
  const images = Array.isArray(payload.images) ? payload.images : [];
  const imageCount = Number(payload.imageCount || images.length || 0);
  const visibleImages = imageLimit > 0
    ? images.slice(imageOffset, imageOffset + imageLimit)
    : images;
  return {
    ...album,
    imageCount,
    imageOffset,
    imageLimit: imageLimit || images.length,
    imagesTruncated: imageLimit > 0 && imageOffset + visibleImages.length < imageCount,
    images: visibleImages.map((image, index) => ({
      index: imageOffset + index + 1,
      name: image.name || path.basename(image.path || ""),
      archivePath: image.path || "",
      bytes: Number(image.bytes || 0),
      url: photoSetImageUrl(album.id, imageOffset + index + 1)
    }))
  };
}

function publicGalleryMediaDetail(item) {
  const publicItem = publicGalleryMediaItem(item);
  const filePath = galleryMediaPath(item);
  const stat = safeStat(filePath);
  return {
    ...publicItem,
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

function normalizeAndroidUpdateChannel(value) {
  const channel = String(value || "debug").trim().toLowerCase();
  return channel === "release" ? "release" : "debug";
}

function androidUpdateChannelDir(channel) {
  return path.join(ANDROID_UPDATE_DIR, normalizeAndroidUpdateChannel(channel));
}

function androidUpdateManifestPath(channel) {
  return path.join(androidUpdateChannelDir(channel), "latest.json");
}

function requestBaseUrl(req) {
  const protocol = String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim() || (req.socket.encrypted ? "https" : "http");
  const host = req.headers.host || `127.0.0.1:${PORT}`;
  return `${protocol}://${host}`;
}

function htmlEscape(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function formatAndroidUpdateBytes(size) {
  const value = Number(size || 0);
  if (!Number.isFinite(value) || value <= 0) return "-";
  if (value >= 1024 * 1024 * 1024) return `${(value / 1024 / 1024 / 1024).toFixed(2)} GB`;
  if (value >= 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)} MB`;
  if (value >= 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${value} B`;
}

function publicAndroidUpdateManifest(req, url) {
  const channel = normalizeAndroidUpdateChannel(url.searchParams.get("channel"));
  const currentVersionCode = clampInteger(url.searchParams.get("currentVersionCode"), 0, 0, Number.MAX_SAFE_INTEGER);
  const manifest = readJsonFile(androidUpdateManifestPath(channel), null);
  if (!manifest || !Number(manifest.versionCode)) {
    return {
      ok: true,
      channel,
      available: false,
      currentVersionCode,
      message: channel === "debug" ? "还没有发布调试版 APK" : "还没有发布正式版 APK"
    };
  }

  const fileName = sanitizeDownloadFileName(manifest.apkFile || `fanhao-${channel}.apk`, `fanhao-${channel}.apk`);
  const apkPath = safeChildPath(androidUpdateChannelDir(channel), fileName);
  const exists = Boolean(apkPath && fs.existsSync(apkPath));
  const versionCode = Number(manifest.versionCode || 0);
  const available = exists && versionCode > currentVersionCode;
  const downloadPath = `/api/android/update/apk/${encodeURIComponent(channel)}/${encodeURIComponent(fileName)}`;
  return {
    ok: true,
    channel,
    available,
    currentVersionCode,
    versionCode,
    versionName: String(manifest.versionName || versionCode),
    minVersionCode: Number(manifest.minVersionCode || 0),
    required: Boolean(manifest.required),
    notes: Array.isArray(manifest.notes) ? manifest.notes.slice(0, 12) : [],
    updatedAt: String(manifest.updatedAt || ""),
    size: Number(manifest.size || (exists ? fs.statSync(apkPath).size : 0)),
    sha256: String(manifest.sha256 || ""),
    fileName,
    downloadUrl: `${requestBaseUrl(req)}${downloadPath}`,
    message: exists ? "" : "更新包文件不存在"
  };
}

function renderAndroidUpdatePage(req, url) {
  const update = publicAndroidUpdateManifest(req, url);
  const channel = normalizeAndroidUpdateChannel(update.channel);
  const title = channel === "debug" ? "FanHao 调试版更新" : "FanHao 正式版更新";
  const status = update.versionCode
    ? (update.message || `最新版本 ${update.versionName || update.versionCode}`)
    : update.message;
  const notes = update.notes?.length
    ? update.notes.map((item) => `<li>${htmlEscape(item)}</li>`).join("")
    : "<li>暂无更新说明</li>";
  const downloadButton = update.downloadUrl && !update.message
    ? `<a class="primary" href="${htmlEscape(update.downloadUrl)}">下载 APK</a>`
    : `<button class="primary" type="button" disabled>暂无可下载 APK</button>`;
  const apiUrl = `/api/android/update?channel=${encodeURIComponent(channel)}`;

  return `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
    <title>${htmlEscape(title)}</title>
    <style>
      :root { color-scheme: light dark; --brand: #1f7a62; --text: #17231f; --muted: #64746f; --line: #d9e1de; --panel: #ffffff; --bg: #f5f7f6; }
      @media (prefers-color-scheme: dark) { :root { --text: #edf4f1; --muted: #a6b5b0; --line: #263631; --panel: #101916; --bg: #08110e; } }
      body { margin: 0; background: var(--bg); color: var(--text); font: 16px/1.55 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
      main { width: min(680px, calc(100vw - 32px)); margin: 0 auto; padding: 40px 0; }
      .panel { background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 24px; }
      h1 { margin: 0 0 8px; font-size: clamp(26px, 6vw, 38px); letter-spacing: 0; }
      p { margin: 0; color: var(--muted); }
      dl { display: grid; grid-template-columns: 96px 1fr; gap: 10px 16px; margin: 24px 0; }
      dt { color: var(--muted); }
      dd { margin: 0; word-break: break-all; }
      ul { margin: 8px 0 24px; padding-left: 20px; }
      .actions { display: flex; flex-wrap: wrap; gap: 12px; align-items: center; }
      a, button { border-radius: 8px; padding: 11px 16px; font: inherit; text-decoration: none; }
      .primary { border: 1px solid var(--brand); background: var(--brand); color: #fff; }
      button.primary:disabled { opacity: .55; }
      .secondary { border: 1px solid var(--line); color: var(--text); background: transparent; }
      .hint { margin-top: 16px; font-size: 14px; }
    </style>
  </head>
  <body>
    <main>
      <section class="panel">
        <h1>${htmlEscape(title)}</h1>
        <p>${htmlEscape(status || "等待发布更新包")}</p>
        <dl>
          <dt>通道</dt><dd>${htmlEscape(channel)}</dd>
          <dt>版本</dt><dd>${htmlEscape(update.versionName || "-")}${update.versionCode ? ` (${htmlEscape(update.versionCode)})` : ""}</dd>
          <dt>大小</dt><dd>${htmlEscape(formatAndroidUpdateBytes(update.size))}</dd>
          <dt>更新时间</dt><dd>${htmlEscape(update.updatedAt || "-")}</dd>
          <dt>文件</dt><dd>${htmlEscape(update.fileName || "-")}</dd>
        </dl>
        <h2>更新说明</h2>
        <ul>${notes}</ul>
        <div class="actions">
          ${downloadButton}
          <a class="secondary" href="${htmlEscape(apiUrl)}">查看 JSON</a>
          <a class="secondary" href="/">返回网页端</a>
        </div>
        <p class="hint">调试阶段使用 debug 包；手机端也会从同一通道检查更新。</p>
      </section>
    </main>
  </body>
</html>`;
}

function serveAndroidUpdateApk(req, res, channel, fileName) {
  const normalizedChannel = normalizeAndroidUpdateChannel(channel);
  const safeName = sanitizeDownloadFileName(decodeURIComponent(fileName || ""), `fanhao-${normalizedChannel}.apk`);
  const apkPath = safeChildPath(androidUpdateChannelDir(normalizedChannel), safeName);
  if (!apkPath || !fs.existsSync(apkPath) || normalizeExt(apkPath) !== ".apk") {
    notFound(res);
    return;
  }

  const stat = fs.statSync(apkPath);
  res.writeHead(200, {
    "Content-Type": "application/vnd.android.package-archive",
    "Content-Length": stat.size,
    "Content-Disposition": attachmentDisposition(safeName),
    "Cache-Control": "no-store"
  });
  if (req.method === "HEAD") {
    res.end();
    return;
  }
  fs.createReadStream(apkPath).pipe(res);
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
      getCoreDb()
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
  getCoreDb()
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
    getCoreDb()
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
  const row = corePersonAvatarRow(personId);
  if (!row?.image_blob) {
    notFound(res);
    return;
  }

  const buffer = Buffer.from(row.image_blob);
  res.writeHead(200, {
    "Content-Type": row.mime || "image/jpeg",
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

function serveTvSeriesCover(res, seriesKey) {
  const row = tvSeriesMetadataRow(seriesKey);
  if (!row?.cover_blob || row.status !== "ok") {
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

function serveMovieMetadataCover(res, mediaId) {
  const row = movieMetadataRow(mediaId);
  if (!row?.cover_blob || row.status !== "ok") {
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

function serveGalleryMediaCover(res, mediaId) {
  const item = galleryMediaById(decodeURIComponent(mediaId));
  if (!item) {
    notFound(res);
    return;
  }

  let row = galleryMediaCoverRow(item.id);
  const signature = galleryMediaSignature(item);
  if (!galleryMediaCoverMatches(row, signature) || !row?.cover_blob) {
    try {
      row = generateGalleryMediaCover(item);
    } catch (error) {
      console.warn("[gallery-media-cover]", item.relativePath || item.id, error.message || error);
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
    return getCoreDb().prepare("SELECT * FROM remote_image_cache WHERE url = ?").get(remoteUrl) || null;
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
  getCoreDb()
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

function pipeFileRange(req, res, filePath, range) {
  const stream = fs.createReadStream(filePath, range);
  let closed = false;
  const closeStream = () => {
    if (closed) return;
    closed = true;
    stream.destroy();
  };

  req.on("aborted", closeStream);
  res.on("close", closeStream);
  stream.on("error", () => {
    if (!res.headersSent) {
      res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
    }
    res.end();
  });
  stream.pipe(res);
}

function serveVideo(req, res, file) {
  const stat = safeStat(file.path);
  if (!stat) {
    notFound(res);
    return;
  }

  const range = parseRange(req.headers.range, stat.size);
  const contentType = MIME_TYPES[file.ext] || "application/octet-stream";
  const responseRange = range || {
    start: 0,
    end: Math.min(stat.size - 1, DEFAULT_VIDEO_CHUNK_BYTES - 1)
  };

  res.writeHead(206, {
    "Content-Type": contentType,
    "Accept-Ranges": "bytes",
    "Content-Range": `bytes ${responseRange.start}-${responseRange.end}/${stat.size}`,
    "Content-Length": responseRange.end - responseRange.start + 1,
    "Cache-Control": "no-store",
    "Content-Disposition": "inline"
  });
  pipeFileRange(req, res, file.path, responseRange);
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

function publicPersonFallbackAvatar(person) {
  for (const workId of person?.works || []) {
    const work = library.worksById.get(workId);
    if (!work || work.missingLocal) continue;

    const coreCover = publicCoreWorkCover(work.id);
    if (coreCover?.coverUrl) {
      return {
        personId: String(person.id || ""),
        avatarUrl: coreCover.coverUrl,
        sourceAvatarUrl: coreCover.sourceCoverUrl || "",
        source: coreCover.source || "work_cover",
        updatedAt: coreCover.updatedAt || "",
        fallbackWorkId: String(work.id || "")
      };
    }

    if (work.coverId) {
      return {
        personId: String(person.id || ""),
        avatarUrl: `/media/image/${encodeURIComponent(work.coverId)}`,
        sourceAvatarUrl: work.relativePath || "",
        source: "work_cover",
        updatedAt: work.modifiedAt || "",
        fallbackWorkId: String(work.id || "")
      };
    }
  }
  return null;
}

function publicPerson(person, options = {}) {
  const actorProfile = publicActorProfile(actorProfileRow(person.id));
  const avatar = publicPersonAvatar(person.id);
  const fallbackAvatar = avatar?.avatarUrl || actorProfile?.avatarUrl ? null : publicPersonFallbackAvatar(person);
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
    avatarUrl: avatar?.avatarUrl || actorProfile?.avatarUrl || fallbackAvatar?.avatarUrl || "",
    avatarImage: avatar || fallbackAvatar,
    actorProfile
  };
}

function publicWorkAvailability(work, infoSummary = null) {
  const summary = infoSummary || work?.infoSummary || {};
  const tags = uniqueTextArray([...(summary.javdbTags || []), ...(work?.javdbTags || [])], { maxLength: 40, maxItems: 16 });
  return {
    hasMagnet: firstPresentValue(summary.hasMagnet, work?.hasMagnet, dbBoolOrNull(work?.has_magnet)),
    hasSubtitles: firstPresentValue(summary.hasSubtitles, work?.hasSubtitles, dbBoolOrNull(work?.has_subtitles)),
    isStreamable: firstPresentValue(summary.isStreamable, work?.isStreamable, dbBoolOrNull(work?.is_streamable)),
    tags
  };
}

function publicWork(work, includeFiles = false) {
  const markers = localWorkMarkers(work);
  if (work.missingLocal) {
    const person = displayPersonForWork(work.personId);
    const profileRow = person ? actorProfileRow(person.id) : null;
    const infoSummary = work.infoSummary || null;
    const base = {
      id: work.id,
      personId: person?.id || work.personId || "",
      personName: work.personName || "",
      personDisplayName: profileRow ? preferredPersonDisplayName(profileRow, person?.name || work.personName || "") : work.personName || "",
      personAliases: publicActorProfile(profileRow)?.aliases || [],
      title: displayWorkTitle(work.title || work.directoryName || "未下载作品"),
      directoryName: displayWorkTitle(work.directoryName || ""),
      relativePath: work.relativePath || "",
      localMarkers: markers,
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
      infoSummary,
      availability: publicWorkAvailability(work, infoSummary),
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

  const person = displayPersonForWork(work.personId);
  const profileRow = person ? actorProfileRow(person.id) : null;
  const coreCover = publicCoreWorkCover(work.id);
  const cachedCover = coreCover || (work.coverId ? null : publicWorkCover(workCoverRow(work.id)));
  const infoRow = workInfoRow(work.id);
  const infoSummary = publicWorkInfoSummary(infoRow, work.infoSummary);
  const videos = work.videos || [];
  const favorite = publicFavoriteForWork(work.id);
  const base = {
    id: work.id,
    personId: person?.id || work.personId,
    personName: person?.name || "",
    personDisplayName: profileRow ? preferredPersonDisplayName(profileRow, person?.name || "") : person?.name || "",
    personAliases: publicActorProfile(profileRow)?.aliases || [],
    title: displayWorkTitle(work.title || work.directoryName || ""),
    directoryName: displayWorkTitle(work.directoryName),
    relativePath: work.relativePath,
    localMarkers: markers,
    coverId: coreCover ? null : work.coverId,
    cachedCover,
    videoCount: work.videoCount,
    playableCount: work.playableCount,
    imageCount: work.imageCount,
    infoCount: work.infoCount,
    videoSize: videos.reduce((sum, video) => sum + Number(video.size || 0), 0),
    canGenerateCover: !work.coverId && !cachedCover && videos.length > 0,
    modifiedAt: work.modifiedAt,
    infoSummary,
    availability: publicWorkAvailability(work, infoSummary),
    favorite: Boolean(favorite),
    favoriteFolderId: favorite?.folderId || "",
    favoriteFolderName: favorite?.folderName || "",
    progress: getWorkProgress(work)
  };
  if (work.ranking) base.ranking = work.ranking;

  if (includeFiles) {
    base.videos = videos.map((video) => publicMediaFile(video, work));
    base.images = (work.images || []).map((image) => publicMediaFile(image, work));
    base.infos = (work.infos || []).map((infoFile) => publicMediaFile(infoFile, work));
    base.infoMetadata = publicWorkInfoMetadata(infoRow);
  }

  return base;
}

function publicMediaFile(file, work = null) {
  return {
    id: file.id,
    type: file.type,
    name: file.name,
    title: file.title,
    ext: file.ext,
    relativePath: file.relativePath,
    sourcePath: file.path,
    size: file.size,
    modifiedAt: file.modifiedAt,
    playable: file.playable,
    progress: file.type === "video" ? getVideoProgress(file.id, work) : null
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
    case "localMarkedA":
      return workHasLocalMarker(work, "A");
    case "hasMagnet":
      return Boolean(work.missingLocal && publicWorkAvailability(work).hasMagnet);
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
    hasMagnet: works.filter((work) => workMatchesFilter(work, "hasMagnet")).length,
    missingCover: works.filter((work) => workMatchesFilter(work, "missingCover")).length
  };
}

function pagedWorksPayload(works, url, extra = {}) {
  const limit = clampInteger(url.searchParams.get("limit"), DEFAULT_WORK_LIMIT, 1, MAX_WORK_LIMIT);
  const offset = clampInteger(url.searchParams.get("offset"), 0, 0, Number.MAX_SAFE_INTEGER);
  const sort = url.searchParams.get("sort") || "releaseDesc";
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

function playInfoForFile(file, publicVideoId = file.id) {
  const probe = videoProbeCached(file) || {};
  const videoCodec = String(probe.videoCodec || "").toLowerCase();
  const audioCodec = String(probe.audioCodec || "").toLowerCase();
  const canDirect = DIRECT_VIDEO_EXTS.has(file.ext) && (!videoCodec || ["h264", "avc1", "hevc", "h265", "vp8", "vp9", "av1"].includes(videoCodec));

  if (canDirect) {
    return {
      mode: "direct",
      label: "直连播放",
      streamUrl: `/media/video/${encodeURIComponent(publicVideoId)}`,
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
    streamUrl: `/media/video/${encodeURIComponent(publicVideoId)}/transcode?${params}`,
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

  if (url.pathname === "/api/android/update" && req.method === "GET") {
    sendJson(res, 200, publicAndroidUpdateManifest(req, url));
    return true;
  }

  const androidUpdateApkMatch = /^\/api\/android\/update\/apk\/([^/]+)\/([^/]+)$/.exec(url.pathname);
  if (androidUpdateApkMatch && (req.method === "GET" || req.method === "HEAD")) {
    serveAndroidUpdateApk(req, res, androidUpdateApkMatch[1], androidUpdateApkMatch[2]);
    return true;
  }

  if (url.pathname === "/api/library" && req.method === "GET") {
    const user = userStateSummary();
    const people = mainLibraryPeople();
    sendJson(res, 200, {
      root: library.root,
      roots: library.roots,
      availableRoots: library.availableRoots,
      missingRoots: library.missingRoots,
      scannedAt: library.scannedAt,
      totals: {
        ...library.totals,
        people: people.length
      },
      user,
      uiConfig: publicAppConfig(),
      access: requestAccess(req),
      lastScanError: lastScanError?.message || null,
      people: people.map(publicPerson)
    });
    return true;
  }

  if (url.pathname === "/api/library/roots" && req.method === "GET") {
    sendJson(res, 200, {
      roots: library.roots || [],
      availableRoots: library.availableRoots || [],
      defaultRoot: (library.availableRoots || [])[0] || (library.roots || [])[0] || ""
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

  if (await routeNovelApi(req, res, url, {
    notFound,
    novelStore,
    novelUploadMaxBodyBytes: NOVEL_UPLOAD_MAX_BODY_BYTES,
    readJsonBody,
    sendJson
  })) return true;

  if (url.pathname === "/api/rescan" && req.method === "POST") {
    if (!requireLocalAdmin(req, res)) return true;
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
    actorMovieRows,
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
    enrichLocalWorksWithActorMovieInfo,
    invalidateTableStamp,
    library,
    normalizeAdminScriptOptions,
    normalizeAppConfig,
    personSourceCandidates,
    publicAdminScript,
    publicAdminTask,
    publicAppConfig,
    publicPerson,
    pagedWorksPayload,
    readJsonBody,
    refreshPersonLibrary,
    refreshLibrary,
    requireLocalAdmin,
    resolveLibraryPersonByPublicId,
    scriptDefinitions: ADMIN_SCRIPT_DEFINITIONS,
    sendJson,
    setActorMovieCache: (value) => {
      actorMovieCache = value;
      actorMovieByCodeKeyCache = null;
      personMergeCache = null;
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

  if (url.pathname === "/api/open-file" && req.method === "POST") {
    const access = requestAccess(req);
    if (!access.isLocal || !isSameLocalOrigin(req)) {
      sendJson(res, 403, { error: "只能在本机页面打开本地文件" });
      return true;
    }

    const body = await readJsonBody(req);
    const target = resolveLocalFileTarget(body.sourcePath || body.path);
    if (target.error) {
      sendJson(res, 400, { error: target.error });
      return true;
    }

    sendJson(res, 200, { ok: true, path: relativeFromRoot(target.filePath) });
    scheduleOpenFile(target.filePath);
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
    const sort = url.searchParams.get("sort") || "releaseDesc";
    const filtered = enrichLocalWorksWithActorMovieIndex(allWorks()).filter((work) => workMatchesFilter(work, filter));
    const sorted = sortWorkList(filtered, sort);
    sendJson(res, 200, pagedWorksPayload(sorted, url, { filter, facets: workFacets() }));
    return true;
  }

  if (url.pathname === "/api/studios" && req.method === "GET") {
    try {
      sendJson(res, 200, studioSummaries(url));
    } catch (error) {
      sendJson(res, 500, { error: error.message || "读取厂商失败" });
    }
    return true;
  }

  const studioMatch = /^\/api\/studios\/([^/]+)$/.exec(url.pathname);
  if (studioMatch && req.method === "GET") {
    try {
      const payload = studioDetailPayload(decodeURIComponent(studioMatch[1]), url);
      if (!payload) {
        notFound(res);
        return true;
      }
      sendJson(res, 200, payload);
    } catch (error) {
      sendJson(res, 500, { error: error.message || "读取厂商详情失败" });
    }
    return true;
  }

  if (url.pathname === "/api/search" && req.method === "GET") {
    const rawQuery = (url.searchParams.get("q") || "").trim();
    const query = rawQuery.toLowerCase();
    const filter = url.searchParams.get("filter") || "all";
    const sort = url.searchParams.get("sort") || "releaseDesc";
    const peopleSearch = searchPeople(rawQuery);
    const exactPersonIds = new Set(peopleSearch.matchedPersonIds || peopleSearch.exact.map((person) => person.id));
    const localMatches = enrichLocalWorksWithActorMovieIndex(allWorks().filter((work) => {
      return exactPersonIds.has(work.personId) || matchesWorkSearch(work, query);
    }));
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
    const person = resolveLibraryPersonByPublicId(decodeURIComponent(actorProfileMatch[1]));
    if (!person) {
      notFound(res);
      return true;
    }

    sendJson(res, 200, { profile: publicActorProfile(actorProfileRow(person.id)) });
    return true;
  }

  if (actorProfileMatch && req.method === "PUT") {
    const person = resolveLibraryPersonByPublicId(decodeURIComponent(actorProfileMatch[1]));
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
    const videoId = decodeURIComponent(progressMatch[1]);
    const file = library.filesById.get(videoId);
    if (!file || file.type !== "video") {
      notFound(res);
      return true;
    }

    const body = await readJsonBody(req);
    const position = Number(body.position || 0);
    const duration = Number(body.duration || body.total || 0);
    const bodyWorkId = String(body.workId || "");
    const workId = bodyWorkId && library.worksById.has(bodyWorkId) ? bodyWorkId : null;

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
    sendJson(res, 200, { ok: true, progress: getVideoProgress(videoId, library.worksById.get(workId)), user: userStateSummary() });
    return true;
  }

  const personMatch = /^\/api\/people\/([^/]+)$/.exec(url.pathname);
  if (personMatch && req.method === "GET") {
    const rawPerson = resolveLibraryPersonByPublicId(decodeURIComponent(personMatch[1])) || corePersonFallbackRecord(decodeURIComponent(personMatch[1]));
    const person = mergedPersonRecord(rawPerson);
    if (!person) {
      notFound(res);
      return true;
    }

    const filter = url.searchParams.get("filter") || "all";
    const sort = url.searchParams.get("sort") || "releaseDesc";
    const actorRows = mergedActorMovieRows(person.id);
    const rawLocalWorks = person.works
      .map((workId) => library.worksById.get(workId))
      .filter(Boolean);
    const localWorks = enrichLocalWorksWithActorMovieInfo(rawLocalWorks, actorRows);
    const personLocalCodeKeys = workCodeKeySetForWorks(rawLocalWorks);
    const coreMissingWorks = coreMissingWorksForPerson(person, personLocalCodeKeys);
    const coreMissingKeys = new Set(coreMissingWorks.map((work) => storedWorkCodeKey(work.infoSummary?.code || work.directoryName || work.title)).filter(Boolean));
    const missingWorks = [
      ...coreMissingWorks,
      ...missingActorWorksForPerson(person, actorRows, personLocalCodeKeys).filter((work) => {
        const key = storedWorkCodeKey(work.infoSummary?.code || work.directoryName || work.title);
        return !key || !coreMissingKeys.has(key);
      })
    ];
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

  const personLocalDeleteMatch = /^\/api\/people\/([^/]+)\/local-files\/delete$/.exec(url.pathname);
  if (personLocalDeleteMatch && req.method === "POST") {
    if (!requireLocalAdmin(req, res)) return true;
    try {
      const result = deletePersonLocalFiles(decodeURIComponent(personLocalDeleteMatch[1]));
      const rawPerson = resolveLibraryPersonByPublicId(decodeURIComponent(personLocalDeleteMatch[1])) || corePersonFallbackRecord(decodeURIComponent(personLocalDeleteMatch[1]));
      const person = mergedPersonRecord(rawPerson) || rawPerson;
      sendJson(res, 200, {
        ok: result.failedCount === 0,
        ...result,
        person: person ? publicPerson(person) : null
      });
    } catch (error) {
      sendJson(res, error.statusCode || 500, { error: error.message || "批量删除本地作品失败" });
    }
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

    sendJson(res, 200, playInfoForFile(file, videoId));
    return true;
  }

  const coverGenerateMatch = /^\/api\/works\/([^/]+)\/cover\/generate$/.exec(url.pathname);
  if (coverGenerateMatch && req.method === "POST") {
    const work = resolveLibraryWorkByPublicId(decodeURIComponent(coverGenerateMatch[1]));
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

  const workMarkerMatch = /^\/api\/works\/([^/]+)\/local-marker$/.exec(url.pathname);
  if (workMarkerMatch && req.method === "POST") {
    if (!requireLocalAdmin(req, res)) return true;
    const workId = decodeURIComponent(workMarkerMatch[1]);
    const body = await readJsonBody(req);
    try {
      const result = setWorkLocalMarker(workId, body.marker || "A", Boolean(body.enabled));
      sendJson(res, 200, { ok: true, ...result });
    } catch (error) {
      sendJson(res, error.statusCode || 500, { error: error.message || "更新作品标记失败" });
    }
    return true;
  }

  const workCorrectActorMatch = /^\/api\/works\/([^/]+)\/correct-actor-from-folder$/.exec(url.pathname);
  if (workCorrectActorMatch && req.method === "POST") {
    if (!requireLocalAdmin(req, res)) return true;
    const workId = decodeURIComponent(workCorrectActorMatch[1]);
    try {
      const result = correctWorkActorFromLocalFolder(workId);
      sendJson(res, 200, { ok: true, ...result });
    } catch (error) {
      sendJson(res, error.statusCode || 500, { error: error.message || "订正演员失败" });
    }
    return true;
  }

  const workMoveToPersonMatch = /^\/api\/works\/([^/]+)\/move-to-person$/.exec(url.pathname);
  if (workMoveToPersonMatch && req.method === "POST") {
    if (!requireLocalAdmin(req, res)) return true;
    const workId = decodeURIComponent(workMoveToPersonMatch[1]);
    try {
      const body = await readJsonBody(req);
      const result = moveWorkToPerson(workId, body.personId, {
        targetDirectory: body.targetDirectory || body.targetPath || "",
        createPerson: body.createPerson || null
      });
      sendJson(res, 200, { ok: true, ...result });
    } catch (error) {
      sendJson(res, error.statusCode || 500, { error: error.message || "迁移作品失败" });
    }
    return true;
  }

  const workLocalDeleteMatch = /^\/api\/works\/([^/]+)\/local-files\/delete$/.exec(url.pathname);
  if (workLocalDeleteMatch && req.method === "POST") {
    if (!requireLocalAdmin(req, res)) return true;
    try {
      const result = deleteWorkLocalFiles(decodeURIComponent(workLocalDeleteMatch[1]));
      sendJson(res, 200, { ok: true, ...result });
    } catch (error) {
      sendJson(res, error.statusCode || 500, { error: error.message || "删除本地文件失败" });
    }
    return true;
  }

  const workMatch = /^\/api\/works\/([^/]+)$/.exec(url.pathname);
  if (workMatch && req.method === "GET") {
    const work = resolveLibraryWorkByPublicId(decodeURIComponent(workMatch[1]));
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

  const tvSeriesCoverMatch = /^\/media\/tv-series-cover\/([^/]+)$/.exec(url.pathname);
  if (tvSeriesCoverMatch && req.method === "GET") {
    serveTvSeriesCover(res, decodeURIComponent(tvSeriesCoverMatch[1]));
    return true;
  }

  const movieCoverMatch = /^\/media\/movie-cover\/([^/]+)$/.exec(url.pathname);
  if (movieCoverMatch && req.method === "GET") {
    serveMovieMetadataCover(res, decodeURIComponent(movieCoverMatch[1]));
    return true;
  }

  const galleryMediaCoverMatch = /^\/media\/gallery-media-cover\/([^/]+)$/.exec(url.pathname);
  if (galleryMediaCoverMatch && req.method === "GET") {
    serveGalleryMediaCover(res, galleryMediaCoverMatch[1]);
    return true;
  }

  const coreImageMatch = /^\/media\/core-image\/([^/]+)$/.exec(url.pathname);
  if (coreImageMatch && req.method === "GET") {
    serveCoreImage(res, decodeURIComponent(coreImageMatch[1]));
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
    const file = resolveVideoFileByPublicId(transcodeMatch[1]);
    if (!file || file.type !== "video") {
      notFound(res);
      return true;
    }

    serveTranscodedVideo(req, res, file, url);
    return true;
  }

  const videoMatch = /^\/media\/video\/([^/]+)$/.exec(url.pathname);
  if (videoMatch && req.method === "GET") {
    const file = resolveVideoFileByPublicId(videoMatch[1]);
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
    if (url.pathname === "/android-update" && req.method === "GET") {
      sendHtml(res, 200, renderAndroidUpdatePage(req, url));
      return;
    }

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
  const coreLibrary = loadLibraryFromCoreDb();
  if (coreLibrary) {
    library = coreLibrary;
    invalidateLibraryDerivedCaches();
    lastScanError = null;
    console.log(
      `[core] ${library.totals.people} people, ${library.totals.works} works, ${library.totals.videos} videos, ${library.totals.images} images`
    );
  } else {
    refreshLibrary();
  }
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
