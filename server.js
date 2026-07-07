import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { ADMIN_SCRIPT_DEFINITIONS } from "./lib/admin-script-registry.js";
import { normalizeWorkCode as parseNormalizedWorkCode, workCodeKey } from "./lib/code-parser.js";
import { decodeInfoBuffer, isSubtitleLikeInfoText, parseInfoMetadata, renderInfoMetadataText } from "./lib/info-metadata.js";
import { createAdminActorAvatarService } from "./src/server/admin-actor-avatar-service.js";
import { createAdminMaintenanceTaskService } from "./src/server/admin-maintenance-task-service.js";
import { createAdminSettingsService } from "./src/server/admin-settings-service.js";
import { createAdminScriptService } from "./src/server/admin-script-service.js";
import { createAdminTaskService } from "./src/server/admin-task-service.js";
import { createAdminTaskOrchestrationService } from "./src/server/admin-task-orchestration-service.js";
import { createAccessLogger } from "./src/server/access-log.js";
import { createAdminCoreMutationService } from "./src/server/admin-core-mutation-service.js";
import { createAdminPersonService } from "./src/server/admin-person-service.js";
import { createActorAvatarService } from "./src/server/actor-avatar-service.js";
import { createActorMovieService } from "./src/server/actor-movie-service.js";
import { createActorProfileService } from "./src/server/actor-profile-service.js";
import { createAndroidUpdateService } from "./src/server/android-update-service.js";
import { createAppConfigService } from "./src/server/app-config-service.js";
import { createAuthServices } from "./src/server/auth.js";
import { createCoreDbService } from "./src/server/core-db-service.js";
import { createCoreLibraryService } from "./src/server/core-library-service.js";
import { createCoreLibrarySyncService } from "./src/server/core-library-sync-service.js";
import { createDoubanCookieService } from "./src/server/douban-cookie-service.js";
import { createFavoriteStateService } from "./src/server/favorite-state-service.js";
import { createFileServer } from "./src/server/file-server.js";
import { createRequestHandler } from "./src/server/http-app.js";
import { createImageReaderCacheService } from "./src/server/image-reader-cache-service.js";
import { createImageLibraryIndexService } from "./src/server/image-library-index-service.js";
import { createGalleryMetadataService } from "./src/server/gallery-metadata-service.js";
import { createGalleryMediaService } from "./src/server/gallery-media-service.js";
import { createImageLibraryService } from "./src/server/image-library-service.js";
import { createLibraryPathServices } from "./src/server/library-paths.js";
import { createLocalLibraryIndexService } from "./src/server/local-library-index-service.js";
import { createLocalLibraryScanService } from "./src/server/local-library-scan-service.js";
import { createLocalOpenService } from "./src/server/local-open-service.js";
import { createMangaService } from "./src/server/manga-service.js";
import { createManualCoverStateService } from "./src/server/manual-cover-state-service.js";
import { createMediaResponseService } from "./src/server/media-response-service.js";
import { createMediaStreamService } from "./src/server/media-stream-service.js";
import { createPersonLibraryService } from "./src/server/person-library-service.js";
import { createPersonListService } from "./src/server/person-list-service.js";
import { createPlaybackProgressService } from "./src/server/playback-progress-service.js";
import { createPersonMergeService } from "./src/server/person-merge-service.js";
import { createPeopleScopeService } from "./src/server/people-scope-service.js";
import { createPhotoSetService } from "./src/server/photo-set-service.js";
import { createRankingService } from "./src/server/ranking-service.js";
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
import { createStudioService } from "./src/server/studio-service.js";
import { createTxtFormatToolService } from "./src/server/txt-format-tool-service.js";
import { createUserStateService } from "./src/server/user-state-service.js";
import { createVideoLibraryImageService } from "./src/server/video-library-image-service.js";
import { createVideoLibraryPresenterService } from "./src/server/video-library-presenter-service.js";
import { createVideoProbeService } from "./src/server/video-probe-service.js";
import { createWorkCodeIndexService } from "./src/server/work-code-index-service.js";
import { createWorkCoverMutationService } from "./src/server/work-cover-mutation-service.js";
import { createWorkInfoService } from "./src/server/work-info-service.js";
import { createWorkLocalMutationService } from "./src/server/work-local-mutation-service.js";

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
const SHORT_VIDEO_DOWNLOAD_MANAGER_DB_PATH = process.env.FANHAO_DOUYIN_DOWNLOAD_MANAGER_DB
  || path.join(os.homedir(), "Desktop", "Tool", "douyin-download-manager", "data", "douyin_downloads.sqlite");
const SHORT_VIDEO_DOWNLOAD_MANAGER_SYNC_MS = Number(process.env.FANHAO_DOUYIN_SYNC_MS || 5 * 60 * 1000);
const NOVEL_UPLOAD_MAX_BODY_BYTES = 80 * 1024 * 1024;
const APP_CONFIG_PATH = path.join(DATA_DIR, "app-config.json");
const AUTH_SECRET_PATH = path.join(DATA_DIR, "auth-secret.txt");
const ACCESS_LOG_PATH = path.join(__dirname, "logs", "access.log");
const ADMIN_TASKS_PATH = path.join(DATA_DIR, "admin-tasks.json");
const DOUBAN_COOKIE_PATH = path.join(DATA_DIR, "douban-cookie.txt");
const JAVDB_115_COOKIE_PROFILE_DIR = path.join(process.env.LOCALAPPDATA || "", "115Chrome", "User Data");
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
const coreDbService = createCoreDbService({
  dbPath: CORE_DB_PATH,
  ensureDataDir
});
let library = emptyLibrary();
let lastScanError = null;
let localLibraryIndexService = null;
let libraryPeopleCacheVersion = 0;
const userState = userStateService.state;
const favoriteStateService = createFavoriteStateService({
  createId,
  defaultFavoriteFolderId: DEFAULT_FAVORITE_FOLDER_ID,
  defaultFavoriteFolderName: DEFAULT_FAVORITE_FOLDER_NAME,
  getLibrary: () => library,
  maxFavoriteFolders: MAX_FAVORITE_FOLDERS,
  userState,
  userStateService
});
const playbackProgressService = createPlaybackProgressService({
  getLibrary: () => library,
  publicFavoriteFolders: () => favoriteStateService.publicFavoriteFolders(),
  recentWatchedDays: RECENT_WATCHED_DAYS,
  userState,
  userStateService
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
const videoLibraryImageService = createVideoLibraryImageService({
  getCoreDb,
  getPersonById: (personId) => library.peopleById.get(String(personId || "")) || null,
  getWorkById: (workId) => library.worksById.get(String(workId || "")) || null,
  hasCoreDb,
  proxiedRemoteImageUrl
});
const mediaResponseService = createMediaResponseService({
  coreImageRow,
  corePersonAvatarRow,
  getCoreDb,
  isAllowedRemoteImageUrl,
  maxRemoteImageBytes: MAX_REMOTE_IMAGE_BYTES,
  mimeTypes: MIME_TYPES,
  normalizeExt,
  notFound,
  proxiedRemoteImageUrl,
  publicRemoteUrl,
  safeStat,
  sendText,
  workCoverRow
});
const mediaStreamService = createMediaStreamService({
  decodeInfoBuffer,
  ffmpegPath: FFMPEG_PATH,
  hasNvenc: HAS_NVENC,
  isSubtitleLikeInfoText,
  maxInfoBytes: MAX_INFO_BYTES,
  notFound,
  parseInfoMetadata,
  safeStat,
  sendJson,
  serveRangedFile
});
const shortVideosModule = createShortVideosModule({
  dbPath: SHORT_VIDEO_DB_PATH,
  ffmpegPath: FFMPEG_PATH,
  roots: SHORT_VIDEO_ROOTS,
  downloadManagerDbPath: SHORT_VIDEO_DOWNLOAD_MANAGER_DB_PATH,
  downloadManagerSyncMs: SHORT_VIDEO_DOWNLOAD_MANAGER_SYNC_MS,
  mediaResponseService,
  mediaStreamService,
  notFound,
  readJsonBody,
  requireLocalAdmin,
  sendJson,
  sharedCache: imageReaderCacheService
});
const galleryMediaService = createGalleryMediaService({
  coverBoxSize: IMAGE_GALLERY_COVER_BOX_SIZE,
  coverGeneratorVersion: GALLERY_MEDIA_COVER_GENERATOR_VERSION,
  coverMaxBytes: IMAGE_GALLERY_COVER_MAX_BYTES,
  directVideoExts: DIRECT_VIDEO_EXTS,
  ffmpegPath: FFMPEG_PATH,
  getImageGalleryDb,
  getImageLibraryIndex: imageLibraryIndexService.getIndex,
  mediaStreamService,
  normalizeExt,
  notFound,
  playbackProgressService,
  publicGalleryMediaItem: imageLibraryService.publicGalleryMediaItem,
  safeChildPath,
  safeStat,
  videoProbeCached: videoProbeService.probeCached
});
const actorProfileService = createActorProfileService({
  actorProfileAliases,
  actorProfileJavdbRefs,
  getCoreDb,
  getStamp: actorProfileStamp,
  mergedPersonAliasNames,
  normalizePersonGender,
  preferredPersonDisplayName,
  publicPersonAvatar,
  uniquePersonNames
});
const workInfoService = createWorkInfoService({
  displayWorkTitle,
  getCoreDb,
  getStamp: workInfoStamp,
  parseJsonArray,
  parseJsonTextArray,
  proxiedRemoteImageUrl,
  proxiedRemoteImageUrlArray,
  publicRemoteUrl,
  renderInfoMetadataText,
  uniqueTextArray
});
const workCodeIndexService = createWorkCodeIndexService({
  getLibrary: () => library,
  getStamp: () => `${library.scannedAt || ""}:${workInfoStamp()}`,
  looseWorkCodeKey,
  storedWorkCodeKey,
  workInfoRow
});
const localLibraryScanService = createLocalLibraryScanService({
  compareNaturalName,
  compareNaturalTitle,
  coverHints: COVER_HINTS,
  createId,
  emptyLibrary,
  excludedDirs: EXCLUDED_DIRS,
  fileBase,
  isExcludedDirName,
  isImage,
  isInfo,
  isPlayableVideo,
  isVideo,
  libraryRoots: LIBRARY_ROOTS,
  linkScannedWork: (personId, work) => localLibraryIndexService?.linkedScannedWork(personId, work) || work,
  normalizeExt,
  relativeFromRoot: (...args) => relativeFromRoot(...args),
  safeStat
});
const coreLibraryService = createCoreLibraryService({
  chooseCover: localLibraryScanService.chooseCover,
  compareNaturalName,
  combinedLocalWorkCodeKeys,
  createId,
  dbBoolOrNull,
  emptyLibrary,
  fileBase,
  getCoreDb,
  hasCoreDb,
  libraryRoots: LIBRARY_ROOTS,
  looseWorkCodeKey,
  normalizeExt,
  normalizePersonSearchValue,
  normalizeWorkCode,
  pathWithinRoot: (...args) => pathWithinRoot(...args),
  parseJsonTextArray,
  personRecordFromWorks,
  proxiedRemoteImageUrl,
  publicRemoteUrl,
  registerFiles: localLibraryScanService.registerFiles,
  relativeFromRoot: (...args) => relativeFromRoot(...args),
  sourcePathToAbsolute: (...args) => sourcePathToAbsolute(...args),
  storedWorkCodeKey,
  uniquePersonNames,
  uniqueTextArray
});
const manualCoverStateService = createManualCoverStateService({
  corePersonFallbackRecord: coreLibraryService.personFallbackRecord,
  coreWorkCoverRow,
  getCoreDb,
  getLibrary: () => library,
  invalidateActorProfiles: () => {
    invalidateTableStamp("actor_profiles");
    actorProfileService.invalidate();
  },
  localImageMime,
  maxActorAvatarBytes: MAX_ACTOR_AVATAR_BYTES,
  mergedPersonRecord,
  publicPerson,
  publicWork,
  publicWorkInfoSummary,
  resolveLibraryPersonByPublicId,
  resolveLibraryWorkByPublicId,
  safeStat,
  userState,
  userStateService,
  userStateSummary: () => playbackProgressService.userStateSummary(),
  workCoverRow,
  workInfoRow
});
const rankingService = createRankingService({
  clampInteger,
  createId,
  dbBoolOrNull,
  getCoreDb,
  getSearchStamp: searchSourceStamp,
  localWorkByCodeKey,
  localWorkCodeKeys,
  looseWorkCodeKey,
  maxWorkLimit: MAX_WORK_LIMIT,
  normalizeWorkCode,
  parseJsonTextArray,
  prewarmRemoteImagesForWorks,
  proxiedRemoteImageUrl,
  publicWork,
  storedWorkCodeKey
});
const actorMovieService = createActorMovieService({
  createId,
  dbBoolOrNull,
  getCoreDb,
  getLibrary: () => library,
  getSearchStamp: searchSourceStamp,
  getStamp: actorMovieStamp,
  localWorkCodeKeys,
  looseWorkCodeKey,
  mergedPersonMembers,
  normalizeWorkCode,
  parseJsonTextArray,
  proxiedRemoteImageUrl,
  publicRemoteUrl,
  storedWorkCodeKey,
  workCodeKeys
});
const studioService = createStudioService({
  clampInteger,
  enrichLocalWorksWithActorMovieIndex,
  getCoreDb,
  getLibrary: () => library,
  getStamp: studioCatalogStamp,
  pagedWorksPayload,
  publicRemoteUrl,
  sortWorkList,
  workFacets
});
const personMergeService = createPersonMergeService({
  actorMovieRows,
  actorProfileAliases,
  actorProfileRow,
  getLibrary: () => library,
  getStamp: personMergeStamp,
  normalizePersonSearchValue,
  normalizeSourcePath,
  personHasVrMergeContent,
  preferredPersonDisplayName,
  uniquePersonNames
});
const peopleScopeService = createPeopleScopeService({
  getLibrary: () => library,
  mergedPersonRecord,
  pathWithinRoot: (...args) => pathWithinRoot(...args),
  sourcePathToAbsolute: (...args) => sourcePathToAbsolute(...args),
  westernRoots: WESTERN_LIBRARY_ROOTS
});
const personListService = createPersonListService({
  actorProfileRow,
  actorMovieService,
  getStamp: libraryPeopleStamp,
  getLibrary: () => library,
  peopleScopeService,
  personMergeService
});
const adminCoreMutationService = createAdminCoreMutationService({
  actorIdFromJavdbUrl,
  actorProfileRow,
  canonicalJavdbActorUrl,
  canonicalJavdbActorUrls,
  cleanPersonNamePart,
  coreLocalPathPersonName: coreLibraryService.localPathPersonName,
  coreLocalPersonSourcePath: coreLibraryService.localPersonSourcePath,
  corePersonFallbackRecord: coreLibraryService.personFallbackRecord,
  ensureLibraryDirectoryPath,
  getCoreDb,
  hasCoreDb,
  invalidateActorMovies: () => actorMovieService.invalidate(),
  invalidateActorProfiles: () => actorProfileService.invalidate(),
  invalidatePersonMerge: () => personMergeService.invalidate(),
  invalidateTableStamp,
  libraryOpenRoots: () => libraryOpenRoots(),
  normalizePersonGender,
  normalizePersonSearchValue,
  parseJsonArray,
  publicActorProfile,
  publicMergedPersonById: (personId) => {
    const person = resolveLibraryPersonByPublicId(String(personId)) || coreLibraryService.personFallbackRecord(String(personId));
    return person ? publicPerson(mergedPersonRecord(person) || person) : null;
  },
  publicPerson,
  publicWork,
  refreshLibrary,
  relativeFromRoot: (...args) => relativeFromRoot(...args),
  replacePathPrefix,
  resolveLibraryPersonByPublicId,
  resolveLibraryWorkByPublicId,
  safeStat,
  sourcePathToAbsolute: (...args) => sourcePathToAbsolute(...args),
  resetWorkSearch: () => {
    workSearchTextCache = null;
  },
  uniqueTextArray,
  uniquePersonNames
});
const workLocalMutationService = createWorkLocalMutationService({
  coreMissingWorksForPerson: coreLibraryService.missingWorksForPerson,
  corePersonFallbackRecord: coreLibraryService.personFallbackRecord,
  ensureLibraryDirectoryPath: (...args) => ensureLibraryDirectoryPath(...args),
  getCoreDb,
  getPersonById: (personId) => library.peopleById.get(String(personId || "")) || null,
  getWorkById: (workId) => library.worksById.get(String(workId || "")) || null,
  hasCoreDb,
  invalidateLibraryDerivedCaches,
  invalidateTableStamp,
  invalidateWorkCodeIndex: () => workCodeIndexService.invalidate(),
  libraryOpenRoots: () => libraryOpenRoots(),
  localWorkMarkerKey,
  markerDirectoryName,
  pathWithinRoot: (...args) => pathWithinRoot(...args),
  publicWork,
  relativeFromRoot: (...args) => relativeFromRoot(...args),
  replacePathPrefix,
  resolveLibraryPersonByPublicId,
  resolveLibraryWorkByPublicId,
  safeStat,
  sourcePathToAbsolute: (...args) => sourcePathToAbsolute(...args),
  refreshLibrary,
  resetWorkSearch: () => {
    workSearchTextCache = null;
  },
  uniqueTextArray,
  workHasLocalMarker
});
const workCoverMutationService = createWorkCoverMutationService({
  ffmpegPath: FFMPEG_PATH,
  ffprobePath: FFPROBE_PATH,
  getCoreDb,
  getWorks: () => [...library.worksById.values()],
  publicCoreWorkCover,
  publicWorkCover,
  resetWorkSearch: () => {
    workSearchTextCache = null;
  },
  safeStat,
  videoProbeService,
  workCoverRow,
  workInfoService
});
const videoLibraryPresenterService = createVideoLibraryPresenterService({
  actorProfileRow,
  dbBoolOrNull,
  displayPersonForWork,
  displayWorkTitle,
  favoriteStateService,
  firstPresentValue,
  getLibrary: () => library,
  isGPerson,
  localWorkMarkers,
  manualCoverStateService,
  playbackProgressService,
  preferredPersonDisplayName,
  proxiedRemoteImageUrl,
  publicActorProfile,
  publicCoreWorkCover,
  publicPersonAvatar,
  publicWorkCover,
  publicWorkInfoMetadata,
  publicWorkInfoSummary,
  uniqueTextArray,
  workCoverRow,
  workInfoRow
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
  mediaStreamService
});
const catalogModule = createCatalogModule({
  notFound,
  rankingService,
  sendJson,
  studioService
});
const videoLibraryModule = createVideoLibraryModule({
  adminCoreMutationService,
  actorProfileMergeCandidates,
  actorProfileRow,
  actorMissingSearchWorks,
  clampInteger,
  coreMissingWorksForPerson: coreLibraryService.missingWorksForPerson,
  corePersonFallbackRecord: coreLibraryService.personFallbackRecord,
  defaultWorkLimit: DEFAULT_WORK_LIMIT,
  dedupeWorksForDisplay,
  enrichLocalWorksWithActorMovieIndex,
  enrichLocalWorksWithActorMovieInfo,
  favoriteStateService,
  galleryMediaService,
  generateWorkCover: workCoverMutationService.generateWorkCover,
  getLibrary: () => library,
  isVrWork,
  matchesWorkSearch,
  maxActorAvatarBytes: MAX_ACTOR_AVATAR_BYTES,
  maxWorkLimit: MAX_WORK_LIMIT,
  manualCoverStateService,
  mediaResponseService,
  mediaStreamService,
  mergedActorMovieRows,
  mergedPersonRecord,
  missingActorWorksForPerson,
  notFound,
  peopleScopeService,
  prewarmRemoteImagesForWorks,
  publicActorProfile,
  publicPerson,
  publicWork,
  publicWorkAvailability,
  rankingMissingSearchWorks,
  readJsonBody,
  requireLocalAdmin,
  requireTrustedFileMutation,
  resolveLibraryPersonByPublicId,
  resolveLibraryWorkByPublicId,
  resolveVideoFileByPublicId,
  searchPeople,
  sendJson,
  storedWorkCodeKey,
  videoProbeService,
  workLocalMutationService,
  workCoverRow,
  workCodeKeySetForWorks,
  workHasLocalMarker,
  workInfoRow,
  playbackProgressService,
  workRating,
  workRatingCount,
  workReleaseDate
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
const adminTaskOrchestrationService = createAdminTaskOrchestrationService({
  adminScriptService,
  adminTaskService,
  resolveLibraryPersonByPublicId
});
const adminMaintenanceTaskService = createAdminMaintenanceTaskService({
  actorProfileRow,
  adminTaskService,
  clearShortVideoListCache: shortVideosModule.clearListCache,
  clearSearchSourceCaches,
  clampInteger,
  coverGenerationStatus: workCoverMutationService.generationStatus,
  cookieProfileDir: JAVDB_115_COOKIE_PROFILE_DIR,
  invalidateTableStamp,
  nodeCommand: process.execPath,
  refreshLibrary,
  resolveLibraryPersonByPublicId,
  setActorMovieCache: (value) => {
    actorMovieService.setRowsCache(value);
    personMergeService.invalidate();
  },
  setLocalWorkCachesDirty: () => {
    workCodeIndexService.invalidate();
  },
  setWorkInfoCache: (value) => {
    workInfoService.setRowsCache(value);
  }
});
const doubanCookieService = createDoubanCookieService({
  cookiePath: DOUBAN_COOKIE_PATH
});
const adminSettingsService = createAdminSettingsService({
  appConfigService,
  doubanCookieService
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
    actorProfileService.invalidate();
    personMergeService.invalidate();
  },
  localAvatarSource: LOCAL_ACTOR_AVATAR_SOURCE,
  maxBytes: MAX_ACTOR_AVATAR_BYTES,
  normalizeExt,
  publicPerson,
  safeStat
});
const adminActorAvatarService = createAdminActorAvatarService({
  actorAvatarService,
  appConfigService,
  clampInteger,
  resolveLibraryPersonByPublicId
});
const statusModule = createStatusModule({
  getLastScanError: () => lastScanError,
  getLibrary: () => library,
  requestAccess: (req) => requestAccess(req),
  sendJson
});
const userStateModule = createUserStateModule({
  clampInteger,
  favoriteStateService,
  getLibrary: () => library,
  maxWorkLimit: MAX_WORK_LIMIT,
  notFound,
  playbackProgressService,
  publicWork,
  readJsonBody,
  recentWatchedDays: RECENT_WATCHED_DAYS,
  resolvePlayableVideoFile,
  sendJson
});
let imageGalleryDb = null;
let coreMapCache = null;
let workSearchTextCache = null;
const archiveImageListCache = new Map();
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
const coreLibrarySyncService = createCoreLibrarySyncService({
  fileBase,
  getCoreDb,
  hasCoreDb,
  normalizeExt,
  normalizeWorkCode,
  relativeFromRoot,
  sourcePathToAbsolute,
  storedWorkCodeKey,
  workCodeKeys
});
localLibraryIndexService = createLocalLibraryIndexService({
  coreLibraryService,
  coreLibrarySyncService,
  emptyLibrary,
  getLibrary: () => library,
  invalidateDerivedCaches: () => invalidateLibraryDerivedCaches(),
  localLibraryScanService,
  onLibraryLoaded: () => {
    peopleScopeService.index();
  },
  setLastScanError: (error) => {
    lastScanError = error;
  },
  setLibrary: (nextLibrary) => {
    library = nextLibrary;
  }
});
const personLibraryService = createPersonLibraryService({
  actorProfileSearchNames,
  compareNaturalTitle,
  getLibrary: () => library,
  libraryIndexService: localLibraryIndexService,
  libraryOpenRoots,
  libraryRoots: LIBRARY_ROOTS,
  normalizeSourcePath,
  pathWithinRoot,
  relativeFromRoot,
  rootLabel,
  safeStat,
  scanPersonDirectory: localLibraryScanService.scanPersonDirectory,
  sourcePathToAbsolute
});
const libraryModule = createLibraryModule({
  appConfigService,
  getLastScanError: () => lastScanError,
  getLibrary: () => library,
  peopleScopeService,
  personListService,
  peoplePayloadStamp: libraryPeopleStamp,
  publicPerson,
  refreshLibrary,
  requestAccess: (req) => requestAccess(req),
  requireLocalAdmin,
  sendJson,
  userStateSummary: () => playbackProgressService.userStateSummary()
});
const adminPersonService = createAdminPersonService({
  actorMovieService,
  enrichLocalWorksWithActorMovieInfo,
  getLibrary: () => library,
  pagedWorksPayload,
  personLibraryService,
  publicPerson,
  resolveLibraryPersonByPublicId,
  sortWorkList
});
const adminModule = createAdminModule({
  adminActorAvatarService,
  adminMaintenanceTaskService,
  adminPersonService,
  adminSettingsService,
  adminTaskOrchestrationService,
  getLibrary: () => library,
  readJsonBody,
  requireLocalAdmin,
  sendJson
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

function safeStat(filePath) {
  try {
    return fs.statSync(filePath);
  } catch {
    return null;
  }
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
  return personMergeService.displayName(person);
}

function actorProfileSearchNames(person) {
  return personMergeService.searchNames(person);
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

function ensureDataDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function getCoreDb() {
  return coreDbService.getDb();
}

function hasCoreDb() {
  return coreDbService.hasDb();
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
  return coreLibraryService.personRow(personId);
}

function coreImageUrl(row) {
  return videoLibraryImageService.coreImageUrl(row);
}

function corePersonAvatarRow(personId, options = {}) {
  return videoLibraryImageService.corePersonAvatarRow(personId, options);
}

function publicPersonAvatar(personId) {
  return videoLibraryImageService.publicPersonAvatar(personId);
}

function coreWorkCoverRow(workId) {
  return videoLibraryImageService.coreWorkCoverRow(workId);
}

function publicCoreWorkCover(workId) {
  return videoLibraryImageService.publicCoreWorkCover(workId);
}

function coreImageRow(imageId) {
  return videoLibraryImageService.coreImageRow(imageId);
}

function actorProfileRowsById() {
  return actorProfileService.rowsById();
}

function actorProfileRow(personId) {
  return actorProfileService.row(personId);
}

function publicActorProfile(row) {
  return actorProfileService.publicProfile(row);
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
  return videoLibraryImageService.workCoverRow(workId);
}

function publicWorkCover(row) {
  return videoLibraryImageService.publicWorkCover(row);
}

function invalidateTableStamp(...tables) {
  coreDbService.invalidateTableStamp(...tables);
  if (!tables.length || tables.some((table) => ["actor_profiles", "actor_movies", "work_info", "work_covers", "images"].includes(table))) {
    libraryPeopleCacheVersion += 1;
  }
}

function tableDataStamp(table) {
  return coreDbService.tableDataStamp(table);
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

function manualCoversStamp() {
  let stamp = "";
  for (const record of Object.values(userState.manualCovers || {})) {
    const updatedAt = String(record?.updatedAt || "");
    if (updatedAt > stamp) stamp = updatedAt;
  }
  return stamp;
}

function libraryPeopleStamp() {
  return `${library.scannedAt || ""}:${libraryPeopleCacheVersion}:${manualCoversStamp()}`;
}

function searchSourceStamp() {
  return `${library.scannedAt || ""}:${workInfoStamp()}:${actorMovieStamp()}:${rankingStamp()}`;
}

function clearSearchSourceCaches() {
  rankingService.invalidateSearch();
  actorMovieService.invalidateSearch();
  workSearchTextCache = null;
}

function workInfoRowsById() {
  return workInfoService.rowsById();
}

function workInfoRow(workId) {
  return workInfoService.row(workId);
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
  return studioService.ensureCatalog({ force });
}

function studioPrefixRowsForMaker(makerId) {
  return studioService.prefixRowsForMaker(makerId);
}

function studioSeriesRowsForMaker(makerId) {
  return studioService.seriesRowsForMaker(makerId);
}

function publicStudioSeries(row, prefixRows = []) {
  return studioService.publicSeries(row, prefixRows);
}

function publicStudioMaker(row, seriesRows = [], prefixRows = []) {
  return studioService.publicMaker(row, seriesRows, prefixRows);
}

function actorMovieRowsByPerson() {
  return actorMovieService.rowsByPerson();
}

function actorMovieRows(personId) {
  return actorMovieService.rows(personId);
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
  return personMergeService.maps();
}

function canonicalPersonId(personId) {
  return personMergeService.canonicalId(personId);
}

function mergedPersonMembers(personId) {
  return personMergeService.members(personId);
}

function mergedPersonAliasNames(personId) {
  return personMergeService.aliasNames(personId);
}

function mergedActorMovieRows(personId) {
  return actorMovieService.mergedRows(personId);
}

function mergedPersonRecord(person) {
  return personMergeService.record(person);
}

function displayPersonForWork(personId) {
  return personMergeService.displayPersonForWork(personId);
}

function actorMovieRowsByCodeKey() {
  return actorMovieService.rowsByCodeKey();
}

function actorMovieRowsForWorks(works = []) {
  return actorMovieService.rowsForWorks(works);
}

function enrichLocalWorksWithActorMovieIndex(localWorks) {
  return actorMovieService.enrichLocalWorksWithIndex(localWorks);
}

function localWorkCodeKeys() {
  return workCodeIndexService.localCodeKeys();
}

function localWorkByCodeKey() {
  return workCodeIndexService.localWorkByCodeKey();
}

function rankingMissingSearchWorks() {
  return rankingService.missingSearchWorks();
}

function actorMissingWorkFromRow(person, row, codeKey = "") {
  return actorMovieService.missingWorkFromRow(person, row, codeKey);
}

function actorMovieInfoSummary(row, fallbackCode = "") {
  return actorMovieService.infoSummary(row, fallbackCode);
}

function workCodeKeys(work) {
  return workCodeIndexService.workCodeKeys(work);
}

function workCodeKeySetForWorks(works = []) {
  return workCodeIndexService.keySetForWorks(works);
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
  return workCodeIndexService.combinedLocalCodeKeys(extraKeys);
}

function enrichLocalWorksWithActorMovieInfo(localWorks, actorRows = []) {
  return actorMovieService.enrichLocalWorks(localWorks, actorRows);
}

function actorMissingSearchWorks(excludedCodeKeys = new Set()) {
  return actorMovieService.missingSearchWorks(excludedCodeKeys);
}

function filterExcludedMissingWorks(works, excludedCodeKeys = new Set()) {
  if (!excludedCodeKeys?.size) return works;
  return works.filter((work) => {
    const codeKey = storedWorkCodeKey(work.infoSummary?.code || work.directoryName || work.title);
    return !codeKey || !excludedCodeKeys.has(codeKey);
  });
}

function missingActorWorksForPerson(person, rows = actorMovieRows(person.id), excludedCodeKeys = new Set()) {
  return actorMovieService.missingWorksForPerson(person, rows, excludedCodeKeys);
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
  return mediaResponseService.remoteImageTargetUrl(value);
}

function prewarmRemoteImagesForWorks(works, limit = 1000) {
  return mediaResponseService.prewarmRemoteImagesForWorks(works, limit);
}

function proxiedRemoteImageUrlArray(values) {
  return mediaResponseService.proxiedRemoteImageUrlArray(values);
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
  return workInfoService.publicSummary(row, fallback);
}

function publicWorkInfoMetadata(row) {
  return workInfoService.publicMetadata(row);
}

function publicEntityLinks(rows, fallback = []) {
  return workInfoService.entityLinks(rows, fallback);
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

function refreshLibrary() {
  return localLibraryIndexService.refreshLibrary();
}

function invalidateLibraryDerivedCaches() {
  workInfoService.invalidate();
  actorProfileService.invalidate();
  coreMapCache = null;
  actorMovieService.invalidate();
  personMergeService.invalidate();
  peopleScopeService.invalidate();
  workCodeIndexService.invalidate();
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
    actorProfileService.invalidate();
    personMergeService.invalidate();
  }
  if (invalidates.has("actorMovies")) {
    invalidateTableStamp("actor_movies");
    actorMovieService.invalidate();
    personMergeService.invalidate();
    workCodeIndexService.invalidate();
    clearSearchSourceCaches();
  }
  if (invalidates.has("workInfo")) {
    invalidateTableStamp("work_info");
    workInfoService.invalidate();
    clearSearchSourceCaches();
  }
  if (invalidates.has("workCovers")) {
    invalidateTableStamp("work_covers");
    workInfoService.invalidate();
    clearSearchSourceCaches();
  }
  if (invalidates.has("rankings")) {
    invalidateTableStamp("javdb_rankings");
    rankingService.invalidateSearch();
    workCodeIndexService.invalidate();
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

function localImageCacheRow(file) {
  return mediaResponseService.localImageCacheRow(file);
}

function localImageMime(file) {
  return mediaResponseService.localImageMime(file);
}

function serveLocalImageCacheRow(res, row) {
  return mediaResponseService.serveLocalImageCacheRow(res, row);
}

function publicPersonFallbackAvatar(person) {
  return videoLibraryPresenterService.publicPersonFallbackAvatar(person);
}

function publicWorkCoverAvatar(work, personId, source = "work_cover") {
  return videoLibraryPresenterService.publicWorkCoverAvatar(work, personId, source);
}

function publicPerson(person, options = {}) {
  return videoLibraryPresenterService.publicPerson(person, options);
}

function publicWorkAvailability(work, infoSummary = null) {
  return videoLibraryPresenterService.publicWorkAvailability(work, infoSummary);
}

function publicWork(work, includeFiles = false) {
  return videoLibraryPresenterService.publicWork(work, includeFiles);
}

function publicMediaFile(file, work = null) {
  return videoLibraryPresenterService.publicMediaFile(file, work);
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
      return favoriteStateService.isFavoriteWork(work.id);
    case "progress":
      return Boolean(playbackProgressService.getWorkProgress(work));
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
    await mediaResponseService.serveCachedRemoteImage(req, res, url);
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
localLibraryIndexService.initializeLibrary();

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
