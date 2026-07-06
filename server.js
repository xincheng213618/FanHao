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
import { createAdminScriptService } from "./src/server/admin-script-service.js";
import { createAdminTaskService } from "./src/server/admin-task-service.js";
import { createAccessLogger } from "./src/server/access-log.js";
import { createActorAvatarService } from "./src/server/actor-avatar-service.js";
import { createAndroidUpdateService } from "./src/server/android-update-service.js";
import { createAppConfigService } from "./src/server/app-config-service.js";
import { createAuthServices } from "./src/server/auth.js";
import { createDoubanCookieService } from "./src/server/douban-cookie-service.js";
import { createFileServer } from "./src/server/file-server.js";
import { createRequestHandler } from "./src/server/http-app.js";
import { createImageReaderCacheService } from "./src/server/image-reader-cache-service.js";
import { createImageLibraryIndexService } from "./src/server/image-library-index-service.js";
import { createGalleryMetadataService } from "./src/server/gallery-metadata-service.js";
import { createGalleryMediaService } from "./src/server/gallery-media-service.js";
import { createImageLibraryService } from "./src/server/image-library-service.js";
import { createLibraryPathServices } from "./src/server/library-paths.js";
import { createLocalOpenService } from "./src/server/local-open-service.js";
import { createMangaService } from "./src/server/manga-service.js";
import { createPersonLibraryService } from "./src/server/person-library-service.js";
import { createPhotoSetService } from "./src/server/photo-set-service.js";
import { createAdminModule } from "./src/server/modules/admin.js";
import { createAndroidUpdateModule } from "./src/server/modules/android-update.js";
import { createCatalogModule } from "./src/server/modules/catalog.js";
import { createGalleryModule } from "./src/server/modules/gallery.js";
import { createLibraryModule } from "./src/server/modules/library.js";
import { createLocalOpenModule } from "./src/server/modules/local-open.js";
import { createNovelsModule } from "./src/server/modules/novels.js";
import { createShortVideosModule } from "./src/server/modules/short-videos.js";
import { createStatusModule } from "./src/server/modules/status.js";
import { createToolsModule } from "./src/server/modules/tools.js";
import { createUserStateModule } from "./src/server/modules/user-state.js";
import { createVideoLibraryModule } from "./src/server/modules/video-library.js";
import { galleryMediaSources, parseLibraryRoots, parsePhotoSetRoots, parseRootList, parseShortVideoRoots } from "./src/server/root-config.js";
import { readBodyText, readJsonBody, readJsonFile, safeChildPath } from "./src/server/request-io.js";
import { sendJson, sendText, sendHtml, redirect, notFound } from "./src/server/responses.js";
import { createStaticFileServer } from "./src/server/static-files.js";
import { createTxtFormatToolService } from "./src/server/txt-format-tool-service.js";
import { createUserStateService } from "./src/server/user-state-service.js";
import { createVideoProbeService } from "./src/server/video-probe-service.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT || 29998);
const HOST = process.env.HOST || "0.0.0.0";
const LIBRARY_ROOTS = parseLibraryRoots();
const PUBLIC_DIR = path.join(__dirname, "public");
const DATA_DIR = path.join(__dirname, "data");
const MANGA_LIBRARY_ROOT = process.env.FANHAO_MANGA_ROOT || "E:\\https-smtt6-com-man-hua-yue";
const PHOTO_SET_ROOTS = parsePhotoSetRoots();
const GALLERY_MEDIA_SOURCES = galleryMediaSources();
const WESTERN_LIBRARY_ROOTS = parseRootList(process.env.FANHAO_WESTERN_ROOTS, "R:\\");
const IMAGE_LIBRARY_INDEX_PATH = path.join(DATA_DIR, "image-library-index.json");
const USER_STATE_PATH = path.join(DATA_DIR, "user-state.json");
const CORE_DB_PATH = path.join(DATA_DIR, "fanhao-core-v2.sqlite");
const IMAGE_GALLERY_DB_PATH = path.join(DATA_DIR, "image-gallery.sqlite");
const NOVEL_DB_PATH = path.join(DATA_DIR, "novels.sqlite");
const SHORT_VIDEO_DB_PATH = path.join(DATA_DIR, "short-videos.sqlite");
const SHORT_VIDEO_ROOTS = parseShortVideoRoots();
const NOVEL_UPLOAD_MAX_BODY_BYTES = 80 * 1024 * 1024;
const APP_CONFIG_PATH = path.join(DATA_DIR, "app-config.json");
const AUTH_SECRET_PATH = path.join(DATA_DIR, "auth-secret.txt");
const ACCESS_LOG_PATH = path.join(__dirname, "logs", "access.log");
const ADMIN_TASKS_PATH = path.join(DATA_DIR, "admin-tasks.json");
const DOUBAN_COOKIE_PATH = path.join(DATA_DIR, "douban-cookie.txt");
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
const { serveInlineFile, serveRangedFile } = createFileServer({
  defaultChunkBytes: DEFAULT_VIDEO_CHUNK_BYTES,
  mimeTypes: MIME_TYPES,
  normalizeExt,
  notFound,
  safeStat
});
const novelsModule = createNovelsModule({
  dbPath: NOVEL_DB_PATH,
  novelUploadMaxBodyBytes: NOVEL_UPLOAD_MAX_BODY_BYTES,
  notFound,
  readJsonBody,
  sendJson
});
const shortVideosModule = createShortVideosModule({
  dbPath: SHORT_VIDEO_DB_PATH,
  ffmpegPath: FFMPEG_PATH,
  roots: SHORT_VIDEO_ROOTS,
  notFound,
  readJsonBody,
  requireLocalAdmin,
  sendJson,
  serveImage,
  serveVideo
});
const mangaService = createMangaService({
  root: MANGA_LIBRARY_ROOT,
  mimeTypes: MIME_TYPES,
  normalizeExt,
  notFound,
  safeStat,
  serveArchiveMemberImage
});
const imageLibraryIndexService = createImageLibraryIndexService({
  archiveExts: ARCHIVE_EXTS,
  createId,
  directVideoExts: DIRECT_VIDEO_EXTS,
  ensureDataDir,
  galleryMediaSources: GALLERY_MEDIA_SOURCES,
  imageLibraryIndexPath: IMAGE_LIBRARY_INDEX_PATH,
  isExcludedDirName,
  isVideo,
  normalizeExt,
  photoSetCoverUrl,
  photoSetRoots: PHOTO_SET_ROOTS,
  readJsonFile,
  safeStat
});
const photoSetService = createPhotoSetService({
  archiveImageExts: ARCHIVE_IMAGE_EXTS,
  archiveImagesPayload,
  compressImageFileToJpeg,
  coverGeneratorVersion: PHOTO_SET_COVER_GENERATOR_VERSION,
  coverHints: COVER_HINTS,
  coverMaxBytes: IMAGE_GALLERY_COVER_MAX_BYTES,
  extractArchiveMemberToCache,
  fileBase,
  getImageGalleryDb,
  getImageLibraryIndex: imageLibraryIndexService.getIndex,
  listArchiveImages,
  mimeTypes: MIME_TYPES,
  normalizeExt,
  notFound,
  safeChildPath,
  safeStat,
  serveArchiveMemberImage
});
const galleryMetadataService = createGalleryMetadataService({
  createId,
  getImageGalleryDb,
  notFound
});
const appConfigService = createAppConfigService({
  configPath: APP_CONFIG_PATH,
  defaultImageReaderCacheMaxBytes: DEFAULT_IMAGE_READER_CACHE_MAX_BYTES,
  ensureDataDir,
  maxImageReaderCacheMaxBytes: MAX_IMAGE_READER_CACHE_MAX_BYTES,
  minImageReaderCacheMaxBytes: MIN_IMAGE_READER_CACHE_MAX_BYTES
});
const userStateService = createUserStateService({
  defaultFavoriteFolderId: DEFAULT_FAVORITE_FOLDER_ID,
  defaultFavoriteFolderName: DEFAULT_FAVORITE_FOLDER_NAME,
  ensureDataDir,
  statePath: USER_STATE_PATH
});
const imageReaderCacheService = createImageReaderCacheService({
  cleanupIntervalMs: IMAGE_READER_CACHE_CLEANUP_INTERVAL_MS,
  cleanupTargetRatio: IMAGE_READER_CACHE_CLEANUP_TARGET_RATIO,
  getMaxBytes: () => appConfigService.imageReaderCacheMaxBytes(),
  rootDir: IMAGE_READER_CACHE_DIR,
  safeStat,
  touchThrottleMs: IMAGE_READER_CACHE_TOUCH_THROTTLE_MS
});
const imageLibraryService = createImageLibraryService({
  clampInteger,
  galleryMediaRootStatuses: imageLibraryIndexService.galleryMediaRootStatuses,
  getImageLibraryIndex: imageLibraryIndexService.getIndex,
  imageReaderCacheStatus: imageReaderCacheService.status,
  mangaService,
  maxItemLimit: MAX_IMAGE_LIBRARY_ITEM_LIMIT,
  metadataService: galleryMetadataService,
  photoCollectionRootValue: PHOTO_COLLECTION_ROOT_VALUE,
  photoSetRootStatuses: imageLibraryIndexService.photoSetRootStatuses,
  photoSetService
});
const videoProbeService = createVideoProbeService({
  cacheLimit: VIDEO_PROBE_CACHE_LIMIT,
  directVideoExts: DIRECT_VIDEO_EXTS,
  ffprobePath: FFPROBE_PATH,
  hasNvenc: HAS_NVENC,
  safeStat
});
const galleryMediaService = createGalleryMediaService({
  coverBoxSize: IMAGE_GALLERY_COVER_BOX_SIZE,
  coverGeneratorVersion: GALLERY_MEDIA_COVER_GENERATOR_VERSION,
  coverMaxBytes: IMAGE_GALLERY_COVER_MAX_BYTES,
  directVideoExts: DIRECT_VIDEO_EXTS,
  ffmpegPath: FFMPEG_PATH,
  getImageGalleryDb,
  getImageLibraryIndex: imageLibraryIndexService.getIndex,
  getVideoProgress,
  normalizeExt,
  notFound,
  publicGalleryMediaItem: imageLibraryService.publicGalleryMediaItem,
  safeChildPath,
  safeStat,
  serveVideo,
  videoProbeCached: videoProbeService.probeCached
});
const galleryModule = createGalleryModule({
  cleanupImageReaderCache: imageReaderCacheService.cleanup,
  galleryMediaService,
  imageLibraryService,
  imageReaderCacheStatus: imageReaderCacheService.status,
  mangaService,
  notFound,
  photoSetService,
  publicAppConfig: appConfigService.publicConfig,
  requireLocalAdmin,
  sendJson,
  galleryMetadataService,
  serveTranscodedVideo
});
const catalogModule = createCatalogModule({
  notFound,
  rankingSummaries,
  rankingWorksPayload,
  sendJson,
  studioDetailPayload,
  studioSummaries
});
const videoLibraryModule = createVideoLibraryModule({
  actorProfileMergeCandidates,
  actorProfileRow,
  actorMissingSearchWorks,
  allWorks,
  coreMissingWorksForPerson,
  corePersonFallbackRecord,
  correctWorkActorFromLocalFolder,
  dedupeWorksForDisplay,
  deletePersonLocalFiles,
  deleteWorkLocalFiles,
  enrichLocalWorksWithActorMovieIndex,
  enrichLocalWorksWithActorMovieInfo,
  galleryMediaService,
  generateWorkCover,
  getLibrary: () => library,
  matchesWorkSearch,
  maxActorAvatarBytes: MAX_ACTOR_AVATAR_BYTES,
  mergePeopleIntoTarget,
  mergedActorMovieRows,
  mergedPersonRecord,
  missingActorWorksForPerson,
  moveWorkToPerson,
  notFound,
  normalizePeopleScope,
  pagedWorksPayload,
  personMatchesPeopleScope,
  prewarmRemoteImagesForWorks,
  publicActorProfile,
  publicPerson,
  publicWork,
  rankingMissingSearchWorks,
  readJsonBody,
  requireLocalAdmin,
  requireTrustedFileMutation,
  resolveLibraryPersonByPublicId,
  resolveLibraryWorkByPublicId,
  resolveVideoFileByPublicId,
  searchPeople,
  sendJson,
  serveActorAvatar,
  serveCoreImage,
  serveImage,
  serveInfo,
  serveTranscodedVideo,
  serveVideo,
  serveWorkCover,
  setPersonManualCover,
  setPersonUploadedCover,
  setWorkLocalMarker,
  setWorkManualCover,
  sortWorkList,
  storedWorkCodeKey,
  upsertActorProfile,
  videoProbeService,
  workCodeKeySetForWorks,
  workFacets,
  workMatchesFilter,
  workMatchesPeopleScope
});
const adminScriptService = createAdminScriptService({
  definitions: ADMIN_SCRIPT_DEFINITIONS,
  hasPerson: (personId) => library.peopleById.has(String(personId || "")),
  nodeCommand: process.execPath
});
const adminTaskService = createAdminTaskService({
  cwd: __dirname,
  ensureDataDir,
  historyLimit: ADMIN_TASK_HISTORY_LIMIT,
  onTaskDone: applyAdminTaskInvalidations,
  tasksPath: ADMIN_TASKS_PATH
});
const doubanCookieService = createDoubanCookieService({
  cookiePath: DOUBAN_COOKIE_PATH
});
const txtFormatToolService = createTxtFormatToolService({
  cwd: __dirname,
  maxBodyBytes: TXT_TOOL_MAX_BODY_BYTES,
  maxFileBytes: TXT_TOOL_MAX_FILE_BYTES,
  previewBytes: TXT_TOOL_PREVIEW_BYTES,
  sendJson,
  toolDownloadDir: TOOL_DOWNLOAD_DIR,
  ttlMs: TOOL_DOWNLOAD_TTL_MS
});
const toolsModule = createToolsModule({
  readJsonBody,
  sendJson,
  txtFormatToolService
});
const androidUpdateService = createAndroidUpdateService({
  clampInteger,
  normalizeExt,
  notFound,
  port: PORT,
  readJsonFile,
  safeChildPath,
  updateDir: ANDROID_UPDATE_DIR
});
const androidUpdateModule = createAndroidUpdateModule({
  androidUpdateService,
  sendJson
});
const actorAvatarService = createActorAvatarService({
  avatarExts: ACTOR_AVATAR_EXTS,
  fileBase,
  getCoreDb,
  getPeople: () => library.people,
  getPersonById: (personId) => library.peopleById.get(personId),
  getProfileRow: actorProfileRow,
  getPublicProfile: (personId) => publicActorProfile(actorProfileRow(personId)),
  getSearchNames: actorProfileSearchNames,
  invalidateProfiles: () => {
    invalidateTableStamp("actor_profiles");
    actorProfileCache = null;
    personMergeCache = null;
  },
  localAvatarSource: LOCAL_ACTOR_AVATAR_SOURCE,
  maxBytes: MAX_ACTOR_AVATAR_BYTES,
  normalizeExt,
  publicPerson,
  safeStat
});
let library = emptyLibrary();
let lastScanError = null;
const statusModule = createStatusModule({
  getLastScanError: () => lastScanError,
  getLibrary: () => library,
  requestAccess: (req) => requestAccess(req),
  sendJson
});
const libraryModule = createLibraryModule({
  appConfigService,
  getLastScanError: () => lastScanError,
  getLibrary: () => library,
  mainLibraryPeople,
  normalizePeopleScope,
  publicPerson,
  refreshLibrary,
  requestAccess: (req) => requestAccess(req),
  requireLocalAdmin,
  sendJson,
  userStateSummary
});
const userState = userStateService.state;
const userStateModule = createUserStateModule({
  clampInteger,
  createFavoriteFolder,
  favoriteFolderCounts,
  favoriteWorks,
  getLibrary: () => library,
  getVideoProgress,
  historyEntries,
  maxWorkLimit: MAX_WORK_LIMIT,
  moveFavoriteToFolder,
  notFound,
  publicFavoriteFolders,
  publicFavoriteForWork,
  publicWork,
  readJsonBody,
  recentWatchedDays: RECENT_WATCHED_DAYS,
  resolvePlayableVideoFile,
  sendJson,
  userState,
  userStateService,
  userStateSummary
});
let coreDb = null;
let imageGalleryDb = null;
let workInfoCache = null;
let actorProfileCache = null;
let coreMapCache = null;
let actorMovieCache = null;
let actorMovieByCodeKeyCache = null;
let personMergeCache = null;
let peopleScopeIndexCache = null;
let studioHierarchyCache = null;
let localWorkCodeKeyCache = null;
let localWorkByCodeKeyCache = null;
let rankingMissingSearchCache = null;
let actorMissingSearchCache = null;
let workSearchTextCache = null;
let tableStampCache = new Map();
const archiveImageListCache = new Map();
const remoteImageWarmQueue = [];
const remoteImageWarmQueued = new Set();
let remoteImageWarmActive = 0;
const REMOTE_IMAGE_WARM_CONCURRENCY = 6;
const TABLE_STAMP_CACHE_MS = 1000;
const {
  libraryOpenRoots,
  pathWithinRoot,
  relativeFromRoot,
  rootLabel,
  sourcePathToAbsolute
} = createLibraryPathServices({
  libraryRoots: LIBRARY_ROOTS,
  extraOpenRoots: GALLERY_MEDIA_SOURCES.flatMap((source) => source.roots || []),
  getAvailableRoots: () => library.availableRoots
});
const personLibraryService = createPersonLibraryService({
  actorProfileSearchNames,
  compareNaturalTitle,
  getLibrary: () => library,
  libraryOpenRoots,
  libraryRoots: LIBRARY_ROOTS,
  normalizeSourcePath,
  pathWithinRoot,
  registerFiles,
  relativeFromRoot,
  replaceCoreLocalFilesForWork,
  rootLabel,
  safeStat,
  saveLibraryCache,
  scanPersonDirectory,
  sourcePathToAbsolute,
  invalidateLibraryDerivedCaches
});
const adminModule = createAdminModule({
  actorMovieRows,
  actorProfileRow,
  actorAvatarService,
  adminScriptService,
  adminTaskService,
  clearSearchSourceCaches,
  clampInteger,
  coverGenerationStatus,
  doubanCookieService,
  enrichLocalWorksWithActorMovieInfo,
  getLibrary: () => library,
  invalidateTableStamp,
  personLibraryService,
  appConfigService,
  publicPerson,
  pagedWorksPayload,
  readJsonBody,
  refreshLibrary,
  requireLocalAdmin,
  resolveLibraryPersonByPublicId,
  sendJson,
  setActorMovieCache: (value) => {
    actorMovieCache = value;
    actorMovieByCodeKeyCache = null;
    personMergeCache = null;
  },
  setLocalWorkCachesDirty: () => {
    localWorkCodeKeyCache = null;
    localWorkByCodeKeyCache = null;
  },
  setWorkInfoCache: (value) => {
    workInfoCache = value;
  },
  sortWorkList
});
const localOpenService = createLocalOpenService({
  libraryOpenRoots,
  pathWithinRoot,
  relativeFromRoot,
  safeStat,
  sourcePathToAbsolute
});
const localOpenModule = createLocalOpenModule({
  localOpenService,
  readJsonBody,
  requireTrustedNetworkPage,
  resolvePlayableVideoFile,
  sendJson
});

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

const {
  applyAppCookie,
  isSameTrustedNetworkOrigin,
  isTrustedNetworkAccess,
  requestAccess,
  requestAuthState,
  routeAuth,
  sendLoginRequired
} = createAuthServices({
  authSecretPath: AUTH_SECRET_PATH,
  remoteWebPassword: REMOTE_WEB_PASSWORD,
  ensureDataDir,
  readBodyText,
  sendJson,
  sendHtml,
  redirect
});
const attachAccessLogger = createAccessLogger({ accessLogPath: ACCESS_LOG_PATH });

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

function normalizePeopleScope(value) {
  return String(value || "").trim().toLowerCase() === "western" ? "western" : "main";
}

function sourcePathWithinAnyRoot(sourcePath, roots) {
  const absolutePath = sourcePathToAbsolute(sourcePath);
  return Boolean(absolutePath && roots.some((rootPath) => pathWithinRoot(absolutePath, rootPath)));
}

function sourcePathInWesternRoots(sourcePath) {
  return sourcePathWithinAnyRoot(sourcePath, WESTERN_LIBRARY_ROOTS);
}

function workInRoots(work, roots) {
  const paths = [
    work?.relativePath,
    ...(work?.videos || []).map((file) => file.relativePath || file.path),
    ...(work?.images || []).map((file) => file.relativePath || file.path),
    ...(work?.infos || []).map((file) => file.relativePath || file.path)
  ];
  return paths.some((sourcePath) => sourcePathWithinAnyRoot(sourcePath, roots));
}

function personInRoots(person, roots) {
  const paths = [person?.relativePath, ...(person?.sourcePaths || [])].filter(Boolean);
  if (paths.some((sourcePath) => sourcePathWithinAnyRoot(sourcePath, roots))) return true;
  return (person?.works || []).some((workId) => workInRoots(library.worksById.get(workId), roots));
}

function personHasNonWesternLocalSource(person) {
  const paths = [person?.relativePath, ...(person?.sourcePaths || [])].filter(Boolean);
  if (paths.some((sourcePath) => !sourcePathWithinAnyRoot(sourcePath, WESTERN_LIBRARY_ROOTS))) return true;
  return (person?.works || []).some((workId) => {
    const work = library.worksById.get(workId);
    return work && !workInRoots(work, WESTERN_LIBRARY_ROOTS);
  });
}

function personMatchesPeopleScope(person, scope) {
  const index = peopleScopeIndex();
  const personId = String(person?.id || "");
  if (personId && index.knownPersonIds.has(personId)) {
    return scope === "western" ? index.westernPersonIds.has(personId) : index.mainPersonIds.has(personId);
  }
  if (scope === "western") return personInRoots(person, WESTERN_LIBRARY_ROOTS);
  return !personInRoots(person, WESTERN_LIBRARY_ROOTS) || personHasNonWesternLocalSource(person);
}

function workMatchesPeopleScope(work, scope) {
  const index = peopleScopeIndex();
  const workId = String(work?.id || "");
  if (workId && index.knownWorkIds.has(workId)) {
    return scope === "western" ? index.westernWorkIds.has(workId) : index.mainWorkIds.has(workId);
  }
  if (scope === "western") return workInRoots(work, WESTERN_LIBRARY_ROOTS);
  return !workInRoots(work, WESTERN_LIBRARY_ROOTS);
}

function peopleScopeCacheKey() {
  return [
    library.scannedAt || "",
    library.people?.length || 0,
    library.worksById?.size || 0,
    library.totals?.videos || 0,
    library.totals?.images || 0,
    library.totals?.infoFiles || 0,
    WESTERN_LIBRARY_ROOTS.join("|")
  ].join("::");
}

function peopleScopeIndex() {
  const key = peopleScopeCacheKey();
  if (peopleScopeIndexCache?.key === key) return peopleScopeIndexCache.index;

  const westernWorkIds = new Set();
  const mainWorkIds = new Set();
  const knownWorkIds = new Set();
  for (const work of library.worksById.values()) {
    const workId = String(work?.id || "");
    if (!workId) continue;
    knownWorkIds.add(workId);
    if (workInRoots(work, WESTERN_LIBRARY_ROOTS)) {
      westernWorkIds.add(workId);
    } else {
      mainWorkIds.add(workId);
    }
  }

  const westernPersonIds = new Set();
  const mainPersonIds = new Set();
  const knownPersonIds = new Set();
  const seen = new Set();
  for (const person of library.people) {
    const merged = mergedPersonRecord(person);
    const personId = String(merged?.id || "");
    if (!personId || seen.has(personId)) continue;
    seen.add(personId);
    knownPersonIds.add(personId);

    const paths = [merged.relativePath, ...(merged.sourcePaths || [])].filter(Boolean);
    const hasWesternPath = paths.some(sourcePathInWesternRoots);
    const hasNonWesternPath = paths.some((sourcePath) => !sourcePathInWesternRoots(sourcePath));
    const workIds = (merged.works || []).map((workId) => String(workId || "")).filter(Boolean);
    const hasWesternWork = workIds.some((workId) => westernWorkIds.has(workId));
    const hasNonWesternWork = workIds.some((workId) => knownWorkIds.has(workId) && !westernWorkIds.has(workId));
    const isWestern = hasWesternPath || hasWesternWork;
    const isMain = !isWestern || hasNonWesternPath || hasNonWesternWork;

    if (isWestern) westernPersonIds.add(personId);
    if (isMain) mainPersonIds.add(personId);
  }

  const index = { westernWorkIds, mainWorkIds, knownWorkIds, westernPersonIds, mainPersonIds, knownPersonIds };
  peopleScopeIndexCache = { key, index };
  return index;
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

function actorProfileJavdbRefs(personOrRow) {
  try {
    const parsed = personOrRow?.javdb_refs_json ? JSON.parse(personOrRow.javdb_refs_json) : [];
    if (!Array.isArray(parsed)) return [];
    const refs = [];
    const seen = new Set();
    for (const item of parsed) {
      const actorId = cleanJavdbActorId(item?.actorId || actorIdFromJavdbUrl(item?.url || ""));
      const url = canonicalJavdbActorUrl(item?.url || actorId);
      if (!actorId || !url || seen.has(actorId)) continue;
      seen.add(actorId);
      refs.push({ actorId, url });
    }
    return refs;
  } catch {
    return [];
  }
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
          CASE
            WHEN source IN ('manual_upload', 'manual_person_cover', 'manual') THEN 0
            WHEN source = 'actor_profiles' THEN 1
            ELSE 2
          END,
          CASE WHEN image_blob IS NOT NULL THEN 0 ELSE 1 END,
          updated_at DESC,
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
    updatedAt: row.updated_at || "",
    coverWorkId: row.source === "manual_person_cover" ? String(row.legacy_key || "") : ""
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
          (
            SELECT json_group_array(json_object('actorId', pref.external_key, 'url', pref.url))
            FROM person_external_refs pref
            WHERE pref.person_id = p.id
              AND pref.provider = 'javdb-actor'
          ) AS javdb_refs_json,
          (
            SELECT pref.external_key
            FROM person_external_refs pref
            WHERE pref.person_id = p.id
              AND pref.provider = 'javdb-actor'
            ORDER BY pref.id
            LIMIT 1
          ) AS javdb_actor_id,
          (
            SELECT pref.url
            FROM person_external_refs pref
            WHERE pref.person_id = p.id
              AND pref.provider = 'javdb-actor'
            ORDER BY pref.id
            LIMIT 1
          ) AS javdb_url,
          avatar.remote_url AS avatar_url,
          avatar.mime AS avatar_mime,
          NULL AS avatar_blob,
          (
            SELECT json_group_array(alias)
            FROM person_aliases pa
            WHERE pa.person_id = p.id
          ) AS aliases_json
        FROM people p
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
        WHERE EXISTS (SELECT 1 FROM person_external_refs pref WHERE pref.person_id = p.id AND pref.provider = 'javdb-actor')
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
  const javdbRefs = actorProfileJavdbRefs(row);
  const primaryJavdb = javdbRefs[0] || { actorId: row.javdb_actor_id || "", url: row.javdb_url || "" };

  return {
    personId: String(row.person_id || ""),
    personName: row.person_name,
    javdbActorId: primaryJavdb.actorId || "",
    javdbUrl: primaryJavdb.url || "",
    javdbRefs,
    javdbUrls: javdbRefs.map((ref) => ref.url),
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
      duration: videoProbeService.probeCached(video)?.duration,
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
          ON pref.id = (
            SELECT pref2.id
            FROM person_external_refs pref2
            WHERE pref2.person_id = p.id
              AND pref2.provider = 'javdb-actor'
            ORDER BY pref2.id ASC
            LIMIT 1
          )
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

function mainLibraryPeople(scope = "main") {
  const people = [];
  const seen = new Set();
  const normalizedScope = normalizePeopleScope(scope);
  for (const person of library.people) {
    const merged = mergedPersonRecord(person);
    if (!merged || seen.has(merged.id)) continue;
    seen.add(merged.id);
    if (!personMatchesPeopleScope(merged, normalizedScope)) continue;
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
          ON pref.id = (
            SELECT pref2.id
            FROM person_external_refs pref2
            WHERE pref2.person_id = wp.person_id
              AND pref2.provider = 'javdb-actor'
            ORDER BY pref2.id ASC
            LIMIT 1
          )
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

function displayWorkDedupeKey(work) {
  const codeKey = storedWorkCodeKey(work?.infoSummary?.code || work?.directoryName || work?.title);
  if (codeKey) return `code:${codeKey}`;
  return work?.id ? `id:${work.id}` : "";
}

function workHasDisplayCover(work) {
  return Boolean(work?.coverId || work?.remoteCoverUrl || work?.infoSummary?.imageUrl);
}

function preferredDisplayWork(existing, next) {
  if (!existing) return next;
  if (Boolean(existing.missingLocal) !== Boolean(next?.missingLocal)) {
    return existing.missingLocal ? next : existing;
  }
  if (workHasDisplayCover(existing) !== workHasDisplayCover(next)) {
    return workHasDisplayCover(next) ? next : existing;
  }
  return existing;
}

function dedupeWorksForDisplay(works = []) {
  const byKey = new Map();
  const unkeyed = [];
  for (const work of works || []) {
    const key = displayWorkDedupeKey(work);
    if (!key) {
      unkeyed.push(work);
      continue;
    }
    byKey.set(key, preferredDisplayWork(byKey.get(key), work));
  }
  return [...byKey.values(), ...unkeyed];
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
  try {
    const url = new URL(raw);
    const match = /^\/actors\/([^/?#]+)/.exec(url.pathname);
    return match ? cleanJavdbActorId(decodeURIComponent(match[1])) : "";
  } catch {
    const match = /javdb\.com\/actors\/([^/?#\s]+)/i.exec(raw);
    return match ? cleanJavdbActorId(decodeURIComponent(match[1])) : "";
  }
}

function cleanJavdbActorId(actorId) {
  return /^[A-Za-z0-9]{3,24}$/.test(actorId || "") ? actorId : "";
}

function canonicalJavdbActorUrl(value) {
  const actorId = actorIdFromJavdbUrl(value);
  return actorId ? `https://javdb.com/actors/${actorId}` : "";
}

function canonicalJavdbActorUrls(value) {
  const rawValues = Array.isArray(value)
    ? value
    : String(value || "")
      .split(/\r?\n|[,，、;]/)
      .map((item) => item.trim());
  const urls = [];
  const seen = new Set();
  for (const raw of rawValues) {
    const url = canonicalJavdbActorUrl(raw);
    const actorId = actorIdFromJavdbUrl(url);
    if (!raw || !url || !actorId || seen.has(actorId)) continue;
    seen.add(actorId);
    urls.push(url);
  }
  return urls;
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
  const hasActorUrlInput = Object.hasOwn(payload, "javdbUrl") || Object.hasOwn(payload, "javdbUrls") || Object.hasOwn(payload, "actorUrls");
  const rawActorUrls = Object.hasOwn(payload, "javdbUrls")
    ? payload.javdbUrls
    : Object.hasOwn(payload, "actorUrls")
      ? payload.actorUrls
      : payload.javdbUrl;
  const javdbUrls = hasActorUrlInput ? canonicalJavdbActorUrls(rawActorUrls) : [];
  const inputActorText = Array.isArray(rawActorUrls) ? rawActorUrls.join("\n") : String(rawActorUrls || "").trim();
  if (inputActorText && !javdbUrls.length) {
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

  if (hasActorUrlInput) {
    db.prepare("DELETE FROM person_external_refs WHERE person_id = ? AND provider = 'javdb-actor'").run(corePersonId);
    const insertRef = db.prepare(
      `
      INSERT INTO person_external_refs(person_id, provider, external_key, url, source, created_at, updated_at)
      VALUES (?, 'javdb-actor', ?, ?, ?, ?, ?)
      ON CONFLICT(provider, external_key) DO UPDATE SET
        person_id = excluded.person_id,
        url = excluded.url,
        source = excluded.source,
        updated_at = excluded.updated_at
      `
    );
    for (const url of javdbUrls) {
      insertRef.run(corePersonId, actorIdFromJavdbUrl(url), url, payload.source || "manual", now, now);
    }
  } else if (payload.javdbActorId || existing?.javdb_actor_id) {
    const actorKey = payload.javdbActorId || existing?.javdb_actor_id || "";
    const finalJavdbUrl = existing?.javdb_url || (actorKey ? `https://javdb.com/actors/${actorKey}` : "");
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
  }

  if (hasAliasesInput) {
    const aliasSource = payload.source || "manual";
    db.prepare("DELETE FROM person_aliases WHERE person_id = ? AND source = ?").run(corePersonId, aliasSource);
    const insertAlias = db.prepare("INSERT OR IGNORE INTO person_aliases(person_id, alias, alias_search, source) VALUES (?, ?, ?, ?)");
    for (const alias of aliases) insertAlias.run(corePersonId, alias, normalizePersonSearchValue(alias), aliasSource);
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

  if (hasActorUrlInput) {
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

function actorProfileMergeCandidates(personId, names = []) {
  const targetId = String(personId || "");
  const keys = new Set(uniquePersonNames(names).map(normalizePersonSearchValue).filter(Boolean));
  if (!targetId || !keys.size || !hasCoreDb()) return [];

  const db = getCoreDb();
  const matches = new Map();
  const addMatch = (person, matchedName) => {
    const id = String(person?.id || "");
    if (!id || id === targetId) return;
    if (!matches.has(id)) {
      matches.set(id, {
        id,
        name: person.name || "",
        displayName: person.display_name || person.name || "",
        matchedNames: new Set()
      });
    }
    if (matchedName) matches.get(id).matchedNames.add(matchedName);
  };

  for (const row of db.prepare("SELECT id, name, display_name FROM people WHERE CAST(id AS TEXT) <> ?").all(targetId)) {
    for (const name of [row.name, row.display_name]) {
      const key = normalizePersonSearchValue(name);
      if (key && keys.has(key)) addMatch(row, name);
    }
  }

  for (const row of db
    .prepare(
      `
      SELECT pa.person_id AS id, p.name, p.display_name, pa.alias
      FROM person_aliases pa
      JOIN people p ON p.id = pa.person_id
      WHERE CAST(pa.person_id AS TEXT) <> ?
      `
    )
    .all(targetId)) {
    const key = normalizePersonSearchValue(row.alias);
    if (key && keys.has(key)) addMatch(row, row.alias);
  }

  const workCountStmt = db.prepare("SELECT COUNT(DISTINCT work_id) AS count FROM work_people WHERE person_id = ? AND role = 'actor'");
  return [...matches.values()]
    .map((item) => ({
      ...item,
      matchedNames: [...item.matchedNames],
      workCount: Number(workCountStmt.get(Number(item.id))?.count || 0)
    }))
    .sort((a, b) => b.workCount - a.workCount || a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }));
}

function mergePeopleIntoTarget(targetPersonId, sourcePersonIds = []) {
  if (!hasCoreDb()) {
    const error = new Error("core DB 不可用");
    error.statusCode = 500;
    throw error;
  }
  const targetId = Number(targetPersonId);
  const sourceIds = uniqueTextArray(sourcePersonIds).map(Number).filter((id) => Number.isFinite(id) && id !== targetId);
  if (!Number.isFinite(targetId) || !sourceIds.length) {
    const error = new Error("合并人物参数无效");
    error.statusCode = 400;
    throw error;
  }

  const db = getCoreDb();
  const target = db.prepare("SELECT id, name, display_name FROM people WHERE id = ?").get(targetId);
  if (!target?.id) {
    const error = new Error("目标人物不存在");
    error.statusCode = 404;
    throw error;
  }

  const sources = sourceIds.map((id) => db.prepare("SELECT id, name, display_name FROM people WHERE id = ?").get(id)).filter(Boolean);
  if (!sources.length) {
    const error = new Error("没有可合并的来源人物");
    error.statusCode = 404;
    throw error;
  }

  const now = new Date().toISOString();
  const targetPrimaryKeys = new Set(uniquePersonNames([target.name, target.display_name]).map(normalizePersonSearchValue).filter(Boolean));
  const insertAlias = db.prepare("INSERT OR IGNORE INTO person_aliases(person_id, alias, alias_search, source) VALUES (?, ?, ?, 'manual_merge')");
  const sourceAliases = db.prepare("SELECT alias FROM person_aliases WHERE person_id = ? ORDER BY id");
  const sourceWorkPeople = db.prepare("SELECT work_id, role, sort_order, source, created_at FROM work_people WHERE person_id = ?");
  const insertWorkPerson = db.prepare(
    `
    INSERT OR IGNORE INTO work_people (work_id, person_id, role, sort_order, source, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'manual_merge', ?, ?)
    `
  );
  const sourceRefs = db.prepare("SELECT id, provider, external_key, url, source, created_at FROM person_external_refs WHERE person_id = ?");
  const targetRefExists = db.prepare("SELECT id FROM person_external_refs WHERE person_id = ? AND provider = ? AND external_key = ?");
  const updateRef = db.prepare("UPDATE person_external_refs SET person_id = ?, source = 'manual_merge', updated_at = ? WHERE id = ?");
  const deleteRef = db.prepare("DELETE FROM person_external_refs WHERE id = ?");

  db.exec("BEGIN IMMEDIATE");
  try {
    for (const source of sources) {
      for (const alias of uniquePersonNames([source.name, source.display_name, ...sourceAliases.all(source.id).map((row) => row.alias)])) {
        const key = normalizePersonSearchValue(alias);
        if (key && !targetPrimaryKeys.has(key)) insertAlias.run(targetId, alias, key);
      }

      for (const row of sourceWorkPeople.all(source.id)) {
        insertWorkPerson.run(row.work_id, targetId, row.role || "actor", row.sort_order || 0, row.created_at || now, now);
      }
      db.prepare("DELETE FROM work_people WHERE person_id = ?").run(source.id);

      for (const ref of sourceRefs.all(source.id)) {
        if (ref.provider === "javdb-actor" && targetRefExists.get(targetId, ref.provider, ref.external_key)) {
          deleteRef.run(ref.id);
          continue;
        }
        if (targetRefExists.get(targetId, ref.provider, ref.external_key)) {
          deleteRef.run(ref.id);
        } else {
          updateRef.run(targetId, now, ref.id);
        }
      }

      db.prepare("UPDATE images SET owner_id = ?, updated_at = ? WHERE owner_type = 'person' AND owner_id = ?").run(targetId, now, source.id);
      db.prepare("DELETE FROM person_aliases WHERE person_id = ?").run(source.id);
      db.prepare("DELETE FROM people WHERE id = ?").run(source.id);
    }
    db.prepare("UPDATE people SET updated_at = ? WHERE id = ?").run(now, targetId);
    db.exec("COMMIT");
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {}
    throw error;
  }

  invalidateTableStamp("actor_profiles", "actor_movies", "work_info", "work_covers");
  actorProfileCache = null;
  actorMovieCache = null;
  actorMovieByCodeKeyCache = null;
  personMergeCache = null;
  workSearchTextCache = null;
  refreshLibrary();

  const nextPerson = resolveLibraryPersonByPublicId(String(targetId)) || corePersonFallbackRecord(String(targetId));
  return {
    targetPersonId: String(targetId),
    mergedPersonIds: sources.map((source) => String(source.id)),
    person: nextPerson ? publicPerson(mergedPersonRecord(nextPerson) || nextPerson) : null
  };
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
    } else if (stat?.isFile()) {
      try {
        fs.unlinkSync(dirPath);
        deletedPaths.push(relativeFromRoot(dirPath));
        emptyRemovedPaths.push(...removeEmptyLibraryParents(dirPath));
      } catch (error) {
        const wrapped = new Error(`删除作品文件失败：${error.message}`);
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
    peopleScopeIndex();
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
  peopleScopeIndexCache = null;
  localWorkCodeKeyCache = null;
  localWorkByCodeKeyCache = null;
  invalidateTableStamp();
  clearSearchSourceCaches();
  videoProbeService.clearCache();
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

function applyAdminTaskInvalidations(task) {
  const script = task.scriptId ? adminScriptService.byId(task.scriptId) : null;
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
    imageLibraryIndexService.invalidate();
    archiveImageListCache.clear();
  }
  if (invalidates.has("tvMetadata") || invalidates.has("movieMetadata") || invalidates.has("galleryMediaCovers")) {
    imageLibraryIndexService.invalidate();
  }
  if (invalidates.has("novels")) {
    novelsModule.invalidate();
  }
  if (invalidates.has("userState")) userStateService.load();
}

function isFavoriteWork(workId) {
  return Boolean(userState.favorites[workId]);
}

function favoriteRecord(workId) {
  const favorite = userState.favorites[workId];
  return favorite ? userStateService.normalizeFavoriteRecord(favorite, userState.favoriteFolders) : null;
}

function favoriteFolderName(folderId) {
  return userState.favoriteFolders?.[folderId]?.name || DEFAULT_FAVORITE_FOLDER_NAME;
}

function favoriteFolderCounts() {
  const counts = new Map(Object.keys(userState.favoriteFolders || userStateService.defaultFavoriteFolders()).map((folderId) => [folderId, 0]));
  for (const [workId, favorite] of Object.entries(userState.favorites || {})) {
    if (!library.worksById.has(workId)) continue;
    const folderId = userStateService.normalizeFavoriteFolderId(favorite?.folderId);
    counts.set(folderId, (counts.get(folderId) || 0) + 1);
  }
  return counts;
}

function publicFavoriteFolders() {
  const counts = favoriteFolderCounts();
  return Object.entries(userState.favoriteFolders || userStateService.defaultFavoriteFolders())
    .map(([id, folder]) => ({
      id,
      name: userStateService.cleanFavoriteFolderName(folder?.name) || DEFAULT_FAVORITE_FOLDER_NAME,
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
  const folderId = userStateService.normalizeFavoriteFolderId(favorite.folderId);
  return {
    createdAt: favorite.createdAt || "",
    folderId,
    folderName: favoriteFolderName(folderId)
  };
}

function manualCoverRecord(workId) {
  const record = userStateService.normalizeManualCoverRecord(userState.manualCovers?.[workId]);
  return record || null;
}

function manualCoverForWork(work) {
  if (!work?.id) return null;
  const record = manualCoverRecord(work.id);
  if (!record) return null;
  const image = (work.images || []).find((item) => item.id === record.imageId);
  return image ? { image, record } : null;
}

function setWorkManualCover(workId, imageId) {
  const work = resolveLibraryWorkByPublicId(workId);
  if (!work || work.missingLocal) {
    const error = new Error("作品不存在");
    error.statusCode = 404;
    throw error;
  }

  const id = String(imageId || "").trim();
  userState.manualCovers = userState.manualCovers && typeof userState.manualCovers === "object" ? userState.manualCovers : {};

  if (!id) {
    delete userState.manualCovers[work.id];
  } else {
    const image = (work.images || []).find((item) => item.id === id);
    if (!image) {
      const error = new Error("只能选择这个作品自己的图片作为封面");
      error.statusCode = 400;
      throw error;
    }
    userState.manualCovers[work.id] = {
      imageId: image.id,
      updatedAt: new Date().toISOString()
    };
  }

  userStateService.save();
  return {
    manualCoverId: manualCoverRecord(work.id)?.imageId || "",
    work: publicWork(work, true),
    user: userStateSummary()
  };
}

function cleanAvatarMime(value, fallback = "image/jpeg") {
  const mime = String(value || "").trim().toLowerCase();
  return /^image\/(?:jpeg|png|webp|gif|bmp)$/.test(mime) ? mime : fallback;
}

function localImageBlobForAvatar(file) {
  const stat = safeStat(file?.path);
  if (!stat?.isFile() || stat.size <= 0 || stat.size > MAX_ACTOR_AVATAR_BYTES) return null;
  return fs.readFileSync(file.path);
}

function personAvatarPayloadFromWork(work) {
  if (!work || work.missingLocal) return null;
  const now = new Date().toISOString();
  const manualCover = manualCoverForWork(work);
  const manualImage = manualCover?.image || null;
  if (manualImage?.id) {
    const blob = localImageBlobForAvatar(manualImage);
    if (!blob) return null;
    return {
      sourceType: "copied",
      localPath: "",
      remoteUrl: "",
      mime: localImageMime(manualImage),
      blob,
      byteSize: blob?.length || manualImage.size || null,
      source: "manual_person_cover",
      legacyKey: work.id,
      now
    };
  }

  const coreCover = coreWorkCoverRow(work.id);
  if (coreCover) {
    const blob = coreCover.image_blob ? Buffer.from(coreCover.image_blob) : null;
    if (!blob && coreCover.local_path && !coreCover.remote_url) return null;
    return {
      sourceType: blob ? "copied" : coreCover.remote_url ? "remote" : coreCover.local_path ? "local" : "unknown",
      localPath: coreCover.local_path || "",
      remoteUrl: coreCover.remote_url || "",
      mime: cleanAvatarMime(coreCover.mime),
      blob,
      byteSize: blob?.length || coreCover.byte_size || null,
      source: "manual_person_cover",
      legacyKey: work.id,
      now
    };
  }

  if (work.coverId) {
    const image = (work.images || []).find((item) => item.id === work.coverId);
    if (image) {
      const blob = localImageBlobForAvatar(image);
      if (!blob) return null;
      return {
        sourceType: "copied",
        localPath: "",
        remoteUrl: "",
        mime: localImageMime(image),
        blob,
        byteSize: blob?.length || image.size || null,
        source: "manual_person_cover",
        legacyKey: work.id,
        now
      };
    }
  }

  const cachedCover = workCoverRow(work.id);
  if (cachedCover?.cover_blob) {
    const blob = Buffer.from(cachedCover.cover_blob);
    return {
      sourceType: "copied",
      localPath: "",
      remoteUrl: cachedCover.cover_url || "",
      mime: cleanAvatarMime(cachedCover.cover_mime),
      blob,
      byteSize: blob.length,
      source: "manual_person_cover",
      legacyKey: work.id,
      now
    };
  }

  const infoSummary = publicWorkInfoSummary(workInfoRow(work.id), work.infoSummary);
  const remoteUrl = work.remoteCoverUrl || infoSummary?.imageUrl || "";
  if (!remoteUrl) return null;
  return {
    sourceType: "remote",
    localPath: "",
    remoteUrl,
    mime: "image/jpeg",
    blob: null,
    byteSize: null,
    source: "manual_person_cover",
    legacyKey: work.id,
    now
  };
}

function personAvatarPayloadFromUpload(payload) {
  const base64 = String(payload.imageBase64 || payload.avatarBase64 || "").replace(/^data:image\/[a-z0-9.+-]+;base64,/i, "");
  if (!base64) return null;
  const blob = Buffer.from(base64, "base64");
  if (!blob.length || blob.length > MAX_ACTOR_AVATAR_BYTES) {
    const error = new Error(`图片不能超过 ${Math.floor(MAX_ACTOR_AVATAR_BYTES / 1024 / 1024)}MB`);
    error.statusCode = 413;
    throw error;
  }
  const now = new Date().toISOString();
  return {
    sourceType: "uploaded",
    localPath: "",
    remoteUrl: "",
    mime: cleanAvatarMime(payload.imageMime || payload.avatarMime),
    blob,
    byteSize: blob.length,
    source: "manual_upload",
    legacyKey: String(payload.fileName || payload.name || "uploaded-avatar").slice(0, 260),
    now
  };
}

function replaceManualPersonAvatar(personId, payload) {
  const corePersonId = Number(personId);
  if (!Number.isFinite(corePersonId)) {
    const error = new Error("人物不存在");
    error.statusCode = 404;
    throw error;
  }
  const db = getCoreDb();
  db.prepare("DELETE FROM images WHERE owner_type = 'person' AND owner_id = ? AND kind = 'avatar' AND source IN ('manual_person_cover', 'manual_upload')").run(corePersonId);
  if (!payload) {
    invalidateTableStamp("actor_profiles");
    actorProfileCache = null;
    return;
  }
  db.prepare(
    `
    INSERT INTO images (
      owner_type, owner_id, kind, source_type, local_path, remote_url, mime, image_blob, byte_size,
      sort_order, status, source, legacy_table, legacy_key, created_at, updated_at
    )
    VALUES ('person', ?, 'avatar', ?, ?, ?, ?, ?, ?, 0, 'ok', ?, 'manual_person_avatar', ?, ?, ?)
    `
  ).run(
    corePersonId,
    payload.sourceType || "unknown",
    payload.localPath || "",
    payload.remoteUrl || "",
    payload.mime || "image/jpeg",
    payload.blob || null,
    payload.byteSize || null,
    payload.source || "manual",
    payload.legacyKey || String(personId),
    payload.now,
    payload.now
  );
  invalidateTableStamp("actor_profiles");
  actorProfileCache = null;
}

function setPersonManualCover(personId, workId) {
  const person = resolveLibraryPersonByPublicId(personId) || corePersonFallbackRecord(personId);
  const mergedPerson = mergedPersonRecord(person);
  if (!mergedPerson) {
    const error = new Error("人物不存在");
    error.statusCode = 404;
    throw error;
  }

  const id = String(workId || "").trim();
  if (!id) {
    replaceManualPersonAvatar(mergedPerson.id, null);
  } else {
    const work = library.worksById.get(id);
    if (!work || !(mergedPerson.works || []).includes(work.id)) {
      const error = new Error("只能选择这个人物自己的作品封面");
      error.statusCode = 400;
      throw error;
    }
    const avatar = personAvatarPayloadFromWork(work);
    if (!avatar) {
      const error = new Error("这个作品没有可用封面");
      error.statusCode = 400;
      throw error;
    }
    replaceManualPersonAvatar(mergedPerson.id, avatar);
  }

  return {
    person: publicPerson(mergedPerson),
    user: userStateSummary()
  };
}

function setPersonUploadedCover(personId, payload) {
  const person = resolveLibraryPersonByPublicId(personId) || corePersonFallbackRecord(personId);
  const mergedPerson = mergedPersonRecord(person);
  if (!mergedPerson) {
    const error = new Error("人物不存在");
    error.statusCode = 404;
    throw error;
  }
  const avatar = personAvatarPayloadFromUpload(payload);
  if (!avatar) {
    const error = new Error("请选择要上传的图片");
    error.statusCode = 400;
    throw error;
  }
  replaceManualPersonAvatar(mergedPerson.id, avatar);
  return {
    person: publicPerson(mergedPerson),
    user: userStateSummary()
  };
}

function createFavoriteFolder(name) {
  const cleanName = userStateService.cleanFavoriteFolderName(name);
  if (!cleanName) {
    const error = new Error("请输入收藏夹名称");
    error.statusCode = 400;
    throw error;
  }

  const folders = userState.favoriteFolders || userStateService.defaultFavoriteFolders();
  const existing = Object.entries(folders).find(([, folder]) => userStateService.cleanFavoriteFolderName(folder?.name) === cleanName);
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
  favorite.folderId = userStateService.normalizeFavoriteFolderId(folderId);
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
  return path.join(imageReaderCacheService.rootDir, sourceType, archiveHash, `${memberHash}${ext}`);
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

  imageReaderCacheService.touch(cachePath);
  imageReaderCacheService.scheduleCleanup();
  serveInlineFile(res, cachePath, options.contentType || MIME_TYPES[normalizeExt(memberPath)] || "");
}

function photoSetCoverUrl(albumId, updatedAt = "") {
  if (!albumId) return "";
  const suffix = updatedAt ? `?v=${encodeURIComponent(updatedAt)}` : "";
  return `/media/gallery-cover/${encodeURIComponent(albumId)}${suffix}`;
}

function resolvePlayableVideoFile(videoId) {
  const file = library.filesById.get(String(videoId || ""));
  if (file?.type === "video") return file;
  return galleryMediaService.videoFile(galleryMediaService.byId(videoId));
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

function serveVideo(req, res, file) {
  serveRangedFile(req, res, file);
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

    const cover = publicWorkCoverAvatar(work, person.id);
    if (cover) return { ...cover, fallbackWorkId: String(work.id || "") };
  }
  return null;
}

function publicWorkCoverAvatar(work, personId, source = "work_cover") {
  if (!work || work.missingLocal) return null;

  const manualCover = manualCoverForWork(work);
  if (manualCover?.image?.id) {
    return {
      personId: String(personId || ""),
      avatarUrl: `/media/image/${encodeURIComponent(manualCover.image.id)}`,
      sourceAvatarUrl: manualCover.image.relativePath || manualCover.image.path || "",
      source: "manual_work_cover",
      updatedAt: manualCover.record?.updatedAt || manualCover.image.modifiedAt || "",
      coverWorkId: String(work.id || "")
    };
  }

  const coreCover = publicCoreWorkCover(work.id);
  if (coreCover?.coverUrl) {
    return {
      personId: String(personId || ""),
      avatarUrl: coreCover.coverUrl,
      sourceAvatarUrl: coreCover.sourceCoverUrl || "",
      source: coreCover.source || source,
      updatedAt: coreCover.updatedAt || "",
      coverWorkId: String(work.id || "")
    };
  }

  if (work.coverId) {
    return {
      personId: String(personId || ""),
      avatarUrl: `/media/image/${encodeURIComponent(work.coverId)}`,
      sourceAvatarUrl: work.relativePath || "",
      source,
      updatedAt: work.modifiedAt || "",
      coverWorkId: String(work.id || "")
    };
  }

  const cachedCover = publicWorkCover(workCoverRow(work.id));
  if (cachedCover?.coverUrl) {
    return {
      personId: String(personId || ""),
      avatarUrl: cachedCover.coverUrl,
      sourceAvatarUrl: cachedCover.sourceCoverUrl || "",
      source: cachedCover.source || source,
      updatedAt: cachedCover.updatedAt || "",
      coverWorkId: String(work.id || "")
    };
  }

  const infoSummary = publicWorkInfoSummary(workInfoRow(work.id), work.infoSummary);
  const remoteUrl = proxiedRemoteImageUrl(work.remoteCoverUrl) || work.remoteCoverUrl || infoSummary?.imageUrl || "";
  if (!remoteUrl) return null;
  return {
    personId: String(personId || ""),
    avatarUrl: remoteUrl,
    sourceAvatarUrl: work.remoteCoverUrl || infoSummary?.imageUrl || "",
    source,
    updatedAt: work.modifiedAt || "",
    coverWorkId: String(work.id || "")
  };
}

function publicPerson(person, options = {}) {
  const actorProfile = publicActorProfile(actorProfileRow(person.id));
  const avatar = publicPersonAvatar(person.id);
  const fallbackAvatar = avatar?.avatarUrl || actorProfile?.avatarUrl || options.skipFallbackAvatar ? null : publicPersonFallbackAvatar(person);
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
    manualCoverWorkId: avatar?.source === "manual_person_cover" ? avatar.coverWorkId || "" : "",
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
      manualCoverId: "",
      autoCoverId: "",
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
  const manualCover = manualCoverForWork(work);
  const cachedCover = manualCover ? null : coreCover || (work.coverId ? null : publicWorkCover(workCoverRow(work.id)));
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
    coverId: manualCover?.image.id || (coreCover ? null : work.coverId),
    manualCoverId: manualCover?.image.id || "",
    autoCoverId: work.coverId || "",
    cachedCover,
    videoCount: work.videoCount,
    playableCount: work.playableCount,
    imageCount: work.imageCount,
    infoCount: work.infoCount,
    videoSize: videos.reduce((sum, video) => sum + Number(video.size || 0), 0),
    canGenerateCover: !manualCover && !work.coverId && !cachedCover && videos.length > 0,
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
  const selectedFolderId = folderId ? userStateService.normalizeFavoriteFolderId(folderId) : "";
  return Object.entries(userState.favorites)
    .map(([workId, favorite]) => ({ work: library.worksById.get(workId), favorite: userStateService.normalizeFavoriteRecord(favorite, userState.favoriteFolders) }))
    .filter((item) => item.work)
    .filter((item) => !selectedFolderId || userStateService.normalizeFavoriteFolderId(item.favorite.folderId) === selectedFolderId)
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

function requireTrustedNetworkPage(req, res, errorMessage) {
  const access = requestAccess(req);
  if (!isTrustedNetworkAccess(access) || !isSameTrustedNetworkOrigin(req, access)) {
    sendJson(res, 403, { error: errorMessage });
    return false;
  }
  return true;
}

function requireLocalAdmin(req, res) {
  return requireTrustedNetworkPage(req, res, "后台管理只能在本机或局域网同源页面使用");
}

function requireTrustedFileMutation(req, res) {
  return requireTrustedNetworkPage(req, res, "删除本地文件只能在本机或局域网同源页面使用");
}

async function routeApi(req, res, url) {
  if (await statusModule.routeApi(req, res, url)) return true;

  if (await androidUpdateModule.routeApi(req, res, url)) return true;

  if (await libraryModule.routeReadApi(req, res, url)) return true;

  if (await catalogModule.routeApi(req, res, url)) return true;

  if (await galleryModule.routeApi(req, res, url)) return true;

  if (await shortVideosModule.routeApi(req, res, url)) return true;

  if (await novelsModule.routeApi(req, res, url)) return true;

  if (await libraryModule.routeMutationApi(req, res, url)) return true;

  if (await toolsModule.routeApi(req, res, url)) return true;

  if (await adminModule.routeApi(req, res, url)) return true;

  if (await localOpenModule.routeApi(req, res, url)) return true;

  if (await userStateModule.routeApi(req, res, url)) return true;

  if (await videoLibraryModule.routeApi(req, res, url)) return true;

  return false;
}

async function routeMedia(req, res, url) {
  if (url.pathname === "/media/remote-image" && req.method === "GET") {
    await serveCachedRemoteImage(req, res, url);
    return true;
  }

  if (await videoLibraryModule.routeMedia(req, res, url)) return true;

  if (await galleryModule.routeMedia(req, res, url)) return true;

  if (await shortVideosModule.routeMedia(req, res, url)) return true;

  return false;
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

userStateService.load();
appConfigService.load();
txtFormatToolService.cleanup();
imageReaderCacheService.startCleanupTimer();
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

const requestHandler = createRequestHandler({
  applyAppCookie,
  attachAccessLogger,
  requestAuthState,
  routeAuth,
  sendLoginRequired,
  routeApi,
  routeMedia,
  renderAndroidUpdatePage: androidUpdateService.renderPage,
  serveStatic,
  sendHtml,
  sendJson,
  sendText
});

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
