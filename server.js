import fs from "node:fs";
import path from "node:path";
import { ADMIN_SCRIPT_DEFINITIONS } from "./lib/admin-script-registry.js";
import { normalizeWorkCode as parseNormalizedWorkCode, workCodeKey } from "./lib/code-parser.js";
import { decodeInfoBuffer, isSubtitleLikeInfoText, parseInfoMetadata, renderInfoMetadataText } from "./lib/info-metadata.js";
import { SERVER_CONFIG } from "./src/bootstrap/server-config.js";
import { discoverFanHaoModules } from "./src/fanhao/module-registry.js";
import { createImageGalleryDbService } from "./src/modules/content-index/server/image-gallery-db-service.js";
import { createImageLibraryIndexService } from "./src/modules/content-index/server/image-library-index-service.js";
import { createImageLibraryService } from "./src/modules/content-index/server/image-library-service.js";
import { createActorAvatarService } from "./src/modules/fanhao/server/people/actor-avatar-service.js";
import { createActorMovieService } from "./src/modules/fanhao/server/people/actor-movie-service.js";
import { createActorProfileService } from "./src/modules/fanhao/server/people/actor-profile-service.js";
import { createAdminActorAvatarService } from "./src/modules/fanhao/server/admin/admin-actor-avatar-service.js";
import { createAdminCoreMutationService } from "./src/modules/fanhao/server/admin/admin-core-mutation-service.js";
import { createAdminMaintenanceTaskService } from "./src/modules/fanhao/server/admin/admin-maintenance-task-service.js";
import { createAdminPersonService } from "./src/modules/fanhao/server/admin/admin-person-service.js";
import { createCoreDbService } from "./src/modules/fanhao/server/library/core-db-service.js";
import { createCoreLibraryService } from "./src/modules/fanhao/server/library/core-library-service.js";
import { createCoreLibrarySyncService } from "./src/modules/fanhao/server/library/core-library-sync-service.js";
import { createFanhaoDependencies } from "./src/modules/fanhao/server/composition.js";
import { createFavoriteStateService } from "./src/modules/fanhao/server/collections/favorite-state-service.js";
import { createLibraryPathServices } from "./src/modules/fanhao/server/library/library-paths.js";
import { createLocalLibraryIndexService } from "./src/modules/fanhao/server/library/local-library-index-service.js";
import { createLocalLibraryScanService } from "./src/modules/fanhao/server/library/local-library-scan-service.js";
import { createManualCoverStateService } from "./src/modules/fanhao/server/works/manual-cover-state-service.js";
import { createPeopleScopeService } from "./src/modules/fanhao/server/people/people-scope-service.js";
import { createPersonLibraryService } from "./src/modules/fanhao/server/people/person-library-service.js";
import { createPersonListService } from "./src/modules/fanhao/server/people/person-list-service.js";
import { createPersonMergeService } from "./src/modules/fanhao/server/people/person-merge-service.js";
import { createPlaybackProgressService } from "./src/modules/fanhao/server/playback/playback-progress-service.js";
import { createRankingService } from "./src/modules/fanhao/server/catalog/ranking-service.js";
import { createStudioService } from "./src/modules/fanhao/server/catalog/studio-service.js";
import { createUserStateService } from "./src/modules/fanhao/server/collections/user-state-service.js";
import { createWorkImageService } from "./src/modules/fanhao/server/works/image-service.js";
import { createWorkPresenterService } from "./src/modules/fanhao/server/works/presenter-service.js";
import { createWorkCodeIndexService } from "./src/modules/fanhao/server/works/work-code-index-service.js";
import { createWorkCoverMutationService } from "./src/modules/fanhao/server/works/work-cover-mutation-service.js";
import { createWorkInfoService } from "./src/modules/fanhao/server/works/work-info-service.js";
import { createWorkLocalMutationService } from "./src/modules/fanhao/server/works/work-local-mutation-service.js";
import { createGalleryMediaService } from "./src/modules/media/server/gallery-media-service.js";
import { createGalleryMetadataService } from "./src/modules/media/server/gallery-metadata-service.js";
import { createMangaService } from "./src/modules/photos/server/manga-service.js";
import { createPhotoSetService } from "./src/modules/photos/server/photo-set-service.js";
import { createAdminScriptService } from "./src/modules/system/server/admin-script-service.js";
import { createAdminSettingsService } from "./src/modules/system/server/admin-settings-service.js";
import { createAdminTaskOrchestrationService } from "./src/modules/system/server/admin-task-orchestration-service.js";
import { createAdminTaskService } from "./src/modules/system/server/admin-task-service.js";
import { createAppConfigService } from "./src/modules/system/server/app-config-service.js";
import { createDoubanCookieService } from "./src/modules/system/server/douban-cookie-service.js";
import { createAccessLogger } from "./src/platform/server/access-log.js";
import { createArchiveImageService } from "./src/platform/server/archive-image-service.js";
import { createAuthServices } from "./src/platform/server/auth.js";
import { createFileServer } from "./src/platform/server/file-server.js";
import { createRequestHandler } from "./src/platform/server/http-app.js";
import { createImageReaderCacheService } from "./src/platform/server/image-reader-cache-service.js";
import { createMediaResponseService } from "./src/platform/server/media-response-service.js";
import { createMediaStreamService } from "./src/platform/server/media-stream-service.js";
import { readBodyText, readJsonBody, readJsonFile, safeChildPath } from "./src/platform/server/request-io.js";
import { sendJson, sendText, sendHtml, redirect, notFound } from "./src/platform/server/responses.js";
import { createServerHost } from "./src/platform/server/server-host.js";
import { createStaticFileServer } from "./src/platform/server/static-files.js";
import { createVideoProbeService } from "./src/platform/server/video-probe-service.js";

const {
  ACCESS_LOG_PATH,
  ACTOR_AVATAR_EXTS,
  ADMIN_TASK_HISTORY_LIMIT,
  ADMIN_TASKS_PATH,
  ANDROID_UPDATE_DIR,
  APP_CONFIG_PATH,
  ARCHIVE_EXTS,
  ARCHIVE_IMAGE_EXTS,
  ARCHIVE_READER_HELPER_PATH,
  AUTH_SECRET_PATH,
  CORE_DB_PATH,
  COVER_HINTS,
  DATA_DIR,
  DEFAULT_FAVORITE_FOLDER_ID,
  DEFAULT_FAVORITE_FOLDER_NAME,
  DEFAULT_IMAGE_READER_CACHE_MAX_BYTES,
  DEFAULT_VIDEO_CHUNK_BYTES,
  DEFAULT_WORK_LIMIT,
  DIRECT_VIDEO_EXTS,
  DOUBAN_COOKIE_PATH,
  EXCLUDED_DIRS,
  FFMPEG_PATH,
  FFPROBE_PATH,
  GALLERY_MEDIA_COVER_GENERATOR_VERSION,
  GALLERY_MEDIA_SOURCES,
  HAS_NVENC,
  HOST,
  IMAGE_EXTS,
  IMAGE_GALLERY_COVER_BOX_SIZE,
  IMAGE_GALLERY_COVER_MAX_BYTES,
  IMAGE_GALLERY_DB_PATH,
  IMAGE_LIBRARY_INDEX_PATH,
  IMAGE_READER_CACHE_CLEANUP_INTERVAL_MS,
  IMAGE_READER_CACHE_CLEANUP_TARGET_RATIO,
  IMAGE_READER_CACHE_DIR,
  IMAGE_READER_CACHE_TOUCH_THROTTLE_MS,
  IMAGE_READER_LIST_CACHE_TTL_MS,
  INFO_EXTS,
  JAVDB_115_COOKIE_PROFILE_DIR,
  LIBRARY_ROOTS,
  LOCAL_ACTOR_AVATAR_SOURCE,
  MANGA_LIBRARY_ROOT,
  MAX_ACTOR_AVATAR_BYTES,
  MAX_FAVORITE_FOLDERS,
  MAX_IMAGE_LIBRARY_ITEM_LIMIT,
  MAX_IMAGE_READER_CACHE_MAX_BYTES,
  MAX_INFO_BYTES,
  MAX_REMOTE_IMAGE_BYTES,
  MAX_WORK_LIMIT,
  MIME_TYPES,
  MIN_IMAGE_READER_CACHE_MAX_BYTES,
  MODULES_DIR,
  MUSIC_DB_PATH,
  MUSIC_ROOTS,
  NOVEL_DB_PATH,
  NOVEL_UPLOAD_MAX_BODY_BYTES,
  PHOTO_COLLECTION_ROOT_VALUE,
  PHOTO_SET_COVER_GENERATOR_VERSION,
  PHOTO_SET_ROOTS,
  PLAYABLE_VIDEO_EXTS,
  PORT,
  PROJECT_ROOT,
  PUBLIC_DIR,
  PYTHON_PATH,
  RECENT_WATCHED_DAYS,
  REMOTE_WEB_PASSWORD,
  SHORT_VIDEO_DB_PATH,
  SHORT_VIDEO_DOWNLOAD_MANAGER_DB_PATH,
  SHORT_VIDEO_DOWNLOAD_MANAGER_URL,
  SHORT_VIDEO_DOWNLOAD_MANAGER_SYNC_MS,
  SHORT_VIDEO_ROOTS,
  TOOL_DOWNLOAD_DIR,
  TOOL_DOWNLOAD_TTL_MS,
  TXT_TOOL_MAX_BODY_BYTES,
  TXT_TOOL_MAX_FILE_BYTES,
  TXT_TOOL_PREVIEW_BYTES,
  USER_STATE_PATH,
  VIDEO_EXTS,
  VIDEO_PROBE_CACHE_LIMIT,
  WESTERN_LIBRARY_ROOTS
} = SERVER_CONFIG;

const { serveStatic } = createStaticFileServer({
  publicDir: PUBLIC_DIR,
  mimeTypes: MIME_TYPES,
  normalizeExt,
  notFound
});
const { serveDownloadFile, serveInlineFile, serveRangedFile } = createFileServer({
  defaultChunkBytes: DEFAULT_VIDEO_CHUNK_BYTES,
  mimeTypes: MIME_TYPES,
  normalizeExt,
  notFound,
  safeStat
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
const imageGalleryDbService = createImageGalleryDbService({
  dbPath: IMAGE_GALLERY_DB_PATH,
  ensureDataDir
});
const getImageGalleryDb = imageGalleryDbService.getDb;
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
let archiveImageService = null;
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
archiveImageService = createArchiveImageService({
  archiveImageExts: ARCHIVE_IMAGE_EXTS,
  coverBoxSize: IMAGE_GALLERY_COVER_BOX_SIZE,
  coverMaxBytes: IMAGE_GALLERY_COVER_MAX_BYTES,
  ffmpegPath: FFMPEG_PATH,
  getImageGalleryDb,
  helperPath: ARCHIVE_READER_HELPER_PATH,
  imageReaderCacheService,
  listCacheTtlMs: IMAGE_READER_LIST_CACHE_TTL_MS,
  mimeTypes: MIME_TYPES,
  normalizeExt,
  notFound,
  projectRoot: PROJECT_ROOT,
  pythonPath: PYTHON_PATH,
  safeStat,
  sendText,
  serveInlineFile,
  warn: console.warn
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
const workImageService = createWorkImageService({
  getCoreDb,
  getPersonById: (personId) => library.peopleById.get(String(personId || "")) || null,
  getStamp: workCoverStamp,
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
  getStamp: () => library.scannedAt || "",
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
  workInfoDetailRow,
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
  prewarmWorkInfoDetails,
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
const workPresenterService = createWorkPresenterService({
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
  workInfoDetailRow,
  workInfoRow
});
const adminScriptService = createAdminScriptService({
  definitions: ADMIN_SCRIPT_DEFINITIONS,
  hasPerson: (personId) => library.peopleById.has(String(personId || "")),
  nodeCommand: process.execPath
});
const adminTaskService = createAdminTaskService({
  cwd: PROJECT_ROOT,
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
  clearShortVideoListCache: () => moduleRegistry.get("short-videos")?.clearListCache?.(),
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
  doubanCookieService,
  getModuleRegistry: () => moduleRegistry
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
let coreMapCache = null;
let workSearchTextCache = null;
let workSearchInfoCache = null;
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
const moduleRegistry = await discoverFanHaoModules({
  modulesDir: MODULES_DIR,
  context: {
    moduleDeps: {
      system: {
        admin: {
          adminActorAvatarService,
          adminMaintenanceTaskService,
          adminPersonService,
          adminSettingsService,
          adminTaskOrchestrationService,
          getLibrary: () => library,
          readJsonBody,
          requireLocalAdmin,
          sendJson
        },
        androidUpdate: {
          clampInteger,
          normalizeExt,
          notFound,
          port: PORT,
          readJsonFile,
          safeChildPath,
          sendJson,
          updateDir: ANDROID_UPDATE_DIR
        },
        localOpen: {
          readJsonBody,
          requireTrustedNetworkPage,
          resolvePlayableVideoFile,
          sendJson,
          service: {
            libraryOpenRoots,
            pathWithinRoot,
            relativeFromRoot,
            safeStat,
            sourcePathToAbsolute
          }
        },
        mediaResponseService,
        status: {
          getLastScanError: () => lastScanError,
          getLibrary: () => library,
          requestAccess: (req) => requestAccess(req),
          sendJson
        }
      },
      fanhao: createFanhaoDependencies({
        adminCoreMutationService,
        actorMovieStamp,
        actorProfileMergeCandidates,
        actorProfileRow,
        actorMissingSearchWorks,
        appConfigService,
        clampInteger,
        coreMissingWorksForPerson: coreLibraryService.missingWorksForPerson,
        corePersonFallbackRecord: coreLibraryService.personFallbackRecord,
        defaultWorkLimit: DEFAULT_WORK_LIMIT,
        dedupeWorksForDisplay,
        enrichLocalWorksWithActorMovieIndex,
        enrichLocalWorksWithActorMovieInfo,
        fastMissingCodeSearch,
        favoriteStateService,
        galleryMediaService,
        generateWorkCover: workCoverMutationService.generateWorkCover,
        getLastScanError: () => lastScanError,
        getLibrary: () => library,
        isVrWork,
        createWorkSearchMatcher,
        maxActorAvatarBytes: MAX_ACTOR_AVATAR_BYTES,
        maxWorkLimit: MAX_WORK_LIMIT,
        manualCoverStateService,
        mediaResponseService,
        mediaStreamService,
        mergedActorMovieRows,
        mergedPersonRecord,
        missingActorWorksForPerson,
        notFound,
        peoplePayloadStamp: libraryPeopleStamp,
        peopleScopeService,
        personListService,
        playbackProgressService,
        prewarmLocalWorkCodeKeys: workCodeIndexService.localCodeKeys,
        prewarmWorkInfoDetails,
        prewarmRemoteImagesForWorks,
        publicActorProfile,
        publicPerson,
        publicWork,
        publicWorkAvailability,
        rankingMissingSearchWorks,
        rankingService,
        readJsonBody,
        recentWatchedDays: RECENT_WATCHED_DAYS,
        refreshLibrary,
        requestAccess: (req) => requestAccess(req),
        requireLocalAdmin,
        requireTrustedFileMutation,
        resolveLibraryPersonByPublicId,
        resolveLibraryWorkByPublicId,
        resolvePlayableVideoFile,
        resolveVideoFileByPublicId,
        searchPeople,
        sendJson,
        storedWorkCodeKey,
        studioService,
        userStateSummary: () => playbackProgressService.userStateSummary(),
        videoProbeService,
        workCodeKeySetForWorks,
        workHasCoreCover,
        workHasLocalMarker,
        workInfoFacetRow,
        workInfoRow,
        workLocalMutationService,
        workQueryStamp,
        workRating,
        workRatingCount,
        workReleaseDate
      }),
      contentIndex: {
        imageLibraryService,
        requireLocalAdmin,
        sendJson
      },
      photos: {
        appConfigService,
        cleanupImageReaderCache: imageReaderCacheService.cleanup,
        imageLibraryService,
        imageReaderCacheStatus: imageReaderCacheService.status,
        mangaService,
        notFound,
        photoSetService,
        publicAppConfig: appConfigService.publicConfig,
        requireLocalAdmin,
        sendJson
      },
      media: {
        doubanCookieService,
        galleryMediaService,
        galleryMetadataService,
        mediaStreamService,
        notFound,
        sendJson
      },
      novels: {
        dbPath: NOVEL_DB_PATH,
        novelUploadMaxBodyBytes: NOVEL_UPLOAD_MAX_BODY_BYTES,
        notFound,
        readJsonBody,
        sendJson
      },
      shortVideos: {
        dbPath: SHORT_VIDEO_DB_PATH,
        downloadManagerDbPath: SHORT_VIDEO_DOWNLOAD_MANAGER_DB_PATH,
        downloadManagerUrl: SHORT_VIDEO_DOWNLOAD_MANAGER_URL,
        downloadManagerSyncMs: SHORT_VIDEO_DOWNLOAD_MANAGER_SYNC_MS,
        ffmpegPath: FFMPEG_PATH,
        ffprobePath: FFPROBE_PATH,
        hasNvenc: HAS_NVENC,
        mediaResponseService,
        mediaStreamService,
        notFound,
        readJsonBody,
        requireLocalAdmin,
        roots: SHORT_VIDEO_ROOTS,
        sendJson,
        sharedCache: imageReaderCacheService
      },
      music: {
        dbPath: MUSIC_DB_PATH,
        ffprobePath: FFPROBE_PATH,
        mediaResponseService,
        mediaStreamService,
        notFound,
        readJsonBody,
        requireLocalAdmin,
        roots: MUSIC_ROOTS,
        sendJson,
        serveDownloadFile
      },
      tools: {
        cwd: PROJECT_ROOT,
        maxBodyBytes: TXT_TOOL_MAX_BODY_BYTES,
        maxFileBytes: TXT_TOOL_MAX_FILE_BYTES,
        previewBytes: TXT_TOOL_PREVIEW_BYTES,
        readJsonBody,
        sendJson,
        toolDownloadDir: TOOL_DOWNLOAD_DIR,
        ttlMs: TOOL_DOWNLOAD_TTL_MS
      }
    }
  },
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
  const info = searchWorkInfoRow(work.id);
  const infoFields = parseJsonArray(info?.fields_json).flatMap((field) => [field?.label, field?.value]);
  return [
    work.title,
    work.directoryName,
    work.relativePath,
    work.personName,
    person?.name,
    info?.code,
    info?.title,
    info?.person_name,
    info?.director,
    info?.maker,
    info?.label,
    info?.series,
    ...(info?.actors || []),
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

function searchWorkInfoRows() {
  const stamp = `${library.scannedAt || ""}:${workInfoStamp()}`;
  if (workSearchInfoCache?.stamp === stamp) return workSearchInfoCache.rows;

  const rows = new Map();
  try {
    const db = getCoreDb();
    for (const row of db.prepare(`
      SELECT CAST(id AS TEXT) AS work_id, code, title, director,
             fields_json, raw_text, javdb_tags_json AS tags_json
      FROM works
      WHERE status = 'ok'
    `).all()) {
      rows.set(row.work_id, { ...row, actors: [] });
    }

    for (const row of db.prepare(`
      SELECT CAST(wp.work_id AS TEXT) AS work_id, p.name
      FROM work_people wp
      JOIN people p ON p.id = wp.person_id
      WHERE wp.role = 'actor'
    `).all()) {
      const info = rows.get(row.work_id);
      if (info && row.name) info.actors.push(row.name);
    }

    for (const row of db.prepare(`
      SELECT CAST(wm.work_id AS TEXT) AS work_id, wm.role, m.name
      FROM work_makers wm
      JOIN makers m ON m.id = wm.maker_id
      WHERE wm.role IN ('maker', 'label')
    `).all()) {
      const info = rows.get(row.work_id);
      if (info && row.name && !info[row.role]) info[row.role] = row.name;
    }

    for (const row of db.prepare(`
      SELECT CAST(ws.work_id AS TEXT) AS work_id, s.name
      FROM work_series ws
      JOIN series s ON s.id = ws.series_id
    `).all()) {
      const info = rows.get(row.work_id);
      if (info && row.name && !info.series) info.series = row.name;
    }
  } catch (error) {
    console.warn("[work-search-index]", error.message || error);
  }

  workSearchInfoCache = { stamp, rows };
  return rows;
}

function searchWorkInfoRow(workId) {
  return searchWorkInfoRows().get(String(workId || "")) || null;
}

function workSearchTextEntry(work, stamp = searchSourceStamp()) {
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

function createWorkSearchMatcher(query) {
  const normalizedQuery = normalizeSearchValue(query);
  const loweredQuery = String(query || "").toLowerCase();
  const stamp = searchSourceStamp();
  if (workSearchTextCache?.stamp !== stamp) {
    workSearchTextCache = { stamp, rows: new Map() };
  }

  return (work) => {
    if (!loweredQuery) return true;
    const { text, normalized } = workSearchTextEntry(work, stamp);
    return text.includes(loweredQuery) || (normalizedQuery.length >= 2 && normalized.includes(normalizedQuery));
  };
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

function coreImageUrl(row) {
  return workImageService.coreImageUrl(row);
}

function corePersonAvatarRow(personId, options = {}) {
  return workImageService.corePersonAvatarRow(personId, options);
}

function publicPersonAvatar(personId) {
  return workImageService.publicPersonAvatar(personId);
}

function coreWorkCoverRow(workId) {
  return workImageService.coreWorkCoverRow(workId);
}

function publicCoreWorkCover(workId) {
  return workImageService.publicCoreWorkCover(workId);
}

function coreImageRow(imageId) {
  return workImageService.coreImageRow(imageId);
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
  return workImageService.workCoverRow(workId);
}

function workHasCoreCover(workId) {
  return workImageService.workHasCoreCover(workId);
}

function publicWorkCover(row) {
  return workImageService.publicWorkCover(row);
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

function workCoverStamp() {
  return tableDataStamp("work_covers");
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

function workQueryStamp() {
  return `${searchSourceStamp()}:${workCoverStamp()}`;
}

function clearSearchSourceCaches() {
  rankingService.invalidateSearch();
  actorMovieService.invalidateSearch();
  workSearchTextCache = null;
  workSearchInfoCache = null;
}

function workInfoRow(workId) {
  return workInfoService.row(workId);
}

function workInfoFacetRow(workId) {
  return workInfoService.facetRow(workId);
}

function workInfoDetailRow(workId) {
  return workInfoService.detailRow(workId);
}

function prewarmWorkInfoDetails(works) {
  return workInfoService.prewarmDetailRows((Array.isArray(works) ? works : []).map((work) => work?.id));
}

function studioCatalogStamp() {
  return `${library.scannedAt || ""}:${workInfoStamp()}:studio-v1`;
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

function fastMissingCodeSearch(rawQuery) {
  const prefix = storedWorkCodeKey(rawQuery);
  if (!prefix) return [];

  try {
    return getCoreDb().prepare(`
      SELECT
        CAST(w.id AS TEXT) AS work_id,
        w.code,
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
        CAST((
          SELECT wp.person_id
          FROM work_people wp
          WHERE wp.work_id = w.id AND wp.role = 'actor'
          ORDER BY wp.sort_order, wp.person_id
          LIMIT 1
        ) AS TEXT) AS person_id,
        (
          SELECT p.name
          FROM work_people wp
          JOIN people p ON p.id = wp.person_id
          WHERE wp.work_id = w.id AND wp.role = 'actor'
          ORDER BY wp.sort_order, wp.person_id
          LIMIT 1
        ) AS person_name,
        (
          SELECT ref.url
          FROM work_external_refs ref
          WHERE ref.work_id = w.id AND ref.provider = 'javdb-video'
          LIMIT 1
        ) AS detail_url,
        (
          SELECT image.remote_url
          FROM images image
          WHERE image.owner_type = 'work'
            AND image.owner_id = w.id
            AND image.kind = 'cover'
          ORDER BY image.id
          LIMIT 1
        ) AS image_url
      FROM works w
      WHERE w.status = 'ok'
        AND w.code_search LIKE ?
        AND NOT EXISTS (
          SELECT 1
          FROM works local_code
          JOIN local_works lw ON lw.work_id = local_code.id
          WHERE local_code.code_search = w.code_search
        )
      ORDER BY w.code_search, w.id
      LIMIT 5000
    `).all(`${prefix}%`).map((row) => {
      const code = normalizeWorkCode(row.code) || row.code || "";
      return {
        id: row.work_id,
        personId: row.person_id || "",
        personName: row.person_name || "",
        title: row.title && row.title !== row.code ? row.title : code || row.title || "未下载作品",
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
        actorUrl: "",
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
    });
  } catch (error) {
    console.warn("[fast-code-search]", error.message || error);
    return [];
  }
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
    archiveImageService?.clearListCache();
  }
  if (invalidates.has("tvMetadata") || invalidates.has("movieMetadata") || invalidates.has("galleryMediaCovers")) {
    imageLibraryIndexService.invalidate();
  }
  if (invalidates.has("novels")) {
    moduleRegistry.get("novels")?.invalidate?.();
  }
  if (invalidates.has("music")) {
    moduleRegistry.get("music")?.invalidate?.();
  }
  if (invalidates.has("shortVideos")) {
    moduleRegistry.get("short-videos")?.clearListCache?.();
  }
  if (invalidates.has("userState")) userStateService.load();
}

async function archiveImagesPayload(archivePath, options = {}) {
  return archiveImageService.archiveImagesPayload(archivePath, options);
}

async function listArchiveImages(archivePath, options = {}) {
  return archiveImageService.listArchiveImages(archivePath, options);
}

async function extractArchiveMemberToCache(archivePath, memberPath, cachePath) {
  return archiveImageService.extractArchiveMemberToCache(archivePath, memberPath, cachePath);
}

async function compressImageFileToJpeg(filePath) {
  return archiveImageService.compressImageFileToJpeg(filePath);
}

async function serveArchiveMemberImage(res, options) {
  return archiveImageService.serveArchiveMemberImage(res, options);
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
  return workPresenterService.publicPersonFallbackAvatar(person);
}

function publicWorkCoverAvatar(work, personId, source = "work_cover") {
  return workPresenterService.publicWorkCoverAvatar(work, personId, source);
}

function publicPerson(person, options = {}) {
  return workPresenterService.publicPerson(person, options);
}

function publicWorkAvailability(work, infoSummary = null) {
  return workPresenterService.publicWorkAvailability(work, infoSummary);
}

function publicWork(work, includeFiles = false, options = {}) {
  return workPresenterService.publicWork(work, includeFiles, options);
}

function publicMediaFile(file, work = null) {
  return workPresenterService.publicMediaFile(file, work);
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
  const pageSource = works.slice(offset, offset + limit);
  prewarmWorkInfoDetails(pageSource);
  const page = pageSource.map((work) => publicWork(work));
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
  return moduleRegistry.routeApi(req, res, url);
}

async function routeMedia(req, res, url) {
  return moduleRegistry.routeMedia(req, res, url);
}

userStateService.load();
appConfigService.load();
imageReaderCacheService.startCleanupTimer();
localLibraryIndexService.initializeLibrary();
await moduleRegistry.start();

const requestHandler = createRequestHandler({
  applyAppCookie,
  attachAccessLogger,
  requestAuthState,
  routeAuth,
  sendLoginRequired,
  routeApi,
  routeMedia,
  renderAndroidUpdatePage: moduleRegistry.get("system").renderAndroidUpdatePage,
  serveStatic,
  sendHtml,
  sendJson,
  sendText
});

const serverHost = createServerHost({
  requestHandler,
  port: PORT,
  host: HOST,
  getLibraryState: () => library,
  stop: () => moduleRegistry.stop()
});

serverHost.listen();
