import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  galleryMediaSources,
  parseLibraryRoots,
  parseMusicRoots,
  parsePhotoSetRoots,
  parseRootList,
  parseShortVideoRoots
} from "../platform/server/root-config.js";

const DEFAULT_PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

export function createServerConfig({
  env = process.env,
  homeDirectory = os.homedir(),
  projectRoot = DEFAULT_PROJECT_ROOT,
  spawn = spawnSync
} = {}) {
  const DATA_DIR = path.join(projectRoot, "data");
  const FFMPEG_PATH = env.FFMPEG_PATH || "ffmpeg";
  const TXT_TOOL_MAX_FILE_BYTES = 24 * 1024 * 1024;

  return {
    PROJECT_ROOT: projectRoot,
    MODULES_DIR: path.join(projectRoot, "src", "modules"),
    ARCHIVE_READER_HELPER_PATH: path.join(projectRoot, "tools", "archive_image_reader.py"),
    PORT: Number(env.PORT || 29998),
    HOST: env.HOST || "0.0.0.0",
    LIBRARY_ROOTS: parseLibraryRoots(env),
    PUBLIC_DIR: path.join(projectRoot, "public"),
    DATA_DIR,
    MANGA_LIBRARY_ROOT: env.FANHAO_MANGA_ROOT || "E:\\https-smtt6-com-man-hua-yue",
    PHOTO_SET_ROOTS: parsePhotoSetRoots(env),
    GALLERY_MEDIA_SOURCES: galleryMediaSources(env),
    WESTERN_LIBRARY_ROOTS: parseRootList(env.FANHAO_WESTERN_ROOTS, "R:\\"),
    IMAGE_LIBRARY_INDEX_PATH: path.join(DATA_DIR, "image-library-index.json"),
    USER_STATE_PATH: path.join(DATA_DIR, "user-state.json"),
    CORE_DB_PATH: path.join(DATA_DIR, "fanhao-core-v2.sqlite"),
    IMAGE_GALLERY_DB_PATH: path.join(DATA_DIR, "image-gallery.sqlite"),
    NOVEL_DB_PATH: path.join(DATA_DIR, "novels.sqlite"),
    MUSIC_DB_PATH: path.join(DATA_DIR, "music.sqlite"),
    MUSIC_ROOTS: parseMusicRoots(env),
    SHORT_VIDEO_DB_PATH: path.join(DATA_DIR, "short-videos.sqlite"),
    SHORT_VIDEO_ROOTS: parseShortVideoRoots(env),
    SHORT_VIDEO_DOWNLOAD_MANAGER_DB_PATH: env.FANHAO_DOUYIN_DOWNLOAD_MANAGER_DB
      || path.join(homeDirectory, "Desktop", "Tool", "douyin-download-manager", "data", "douyin_downloads.sqlite"),
    SHORT_VIDEO_DOWNLOAD_MANAGER_SYNC_MS: Number(env.FANHAO_DOUYIN_SYNC_MS || 60 * 1000),
    NOVEL_UPLOAD_MAX_BODY_BYTES: 80 * 1024 * 1024,
    APP_CONFIG_PATH: path.join(DATA_DIR, "app-config.json"),
    AUTH_SECRET_PATH: path.join(DATA_DIR, "auth-secret.txt"),
    ACCESS_LOG_PATH: path.join(projectRoot, "logs", "access.log"),
    ADMIN_TASKS_PATH: path.join(DATA_DIR, "admin-tasks.json"),
    DOUBAN_COOKIE_PATH: path.join(DATA_DIR, "douban-cookie.txt"),
    JAVDB_115_COOKIE_PROFILE_DIR: path.join(env.LOCALAPPDATA || "", "115Chrome", "User Data"),
    TOOL_DOWNLOAD_DIR: path.join(DATA_DIR, "tool-downloads"),
    ANDROID_UPDATE_DIR: path.join(DATA_DIR, "android-update"),
    IMAGE_READER_CACHE_DIR: path.join(DATA_DIR, "image-reader-cache"),
    FFMPEG_PATH,
    FFPROBE_PATH: env.FFPROBE_PATH || "ffprobe",
    PYTHON_PATH: env.PYTHON || "python",
    REMOTE_WEB_PASSWORD: env.FANHAO_WEB_PASSWORD || "xincheng",
    EXCLUDED_DIRS: new Set(["$RECYCLE.BIN", "System Volume Information", "Recovery"]),
    VIDEO_EXTS: new Set([".mp4", ".mkv", ".avi", ".mov", ".wmv", ".flv", ".m4v", ".ts", ".m2ts", ".webm", ".iso"]),
    PLAYABLE_VIDEO_EXTS: new Set([".mp4", ".m4v", ".mov", ".webm"]),
    DIRECT_VIDEO_EXTS: new Set([".mp4", ".m4v", ".webm"]),
    IMAGE_EXTS: new Set([".jpg", ".jpeg", ".png", ".webp", ".bmp", ".gif"]),
    INFO_EXTS: new Set([".nfo", ".txt", ".json", ".xml", ".html", ".htm", ".csv", ".md", ".srt", ".ass", ".ssa"]),
    COVER_HINTS: new Set(["cover", "poster", "folder", "front", "fanart", "thumb", "thumbnail", "封面"]),
    MAX_INFO_BYTES: 1024 * 1024,
    DEFAULT_WORK_LIMIT: 160,
    MAX_WORK_LIMIT: 16000,
    MAX_IMAGE_LIBRARY_ITEM_LIMIT: 12000,
    HAS_NVENC: detectNvenc({ disabled: env.FANHAO_DISABLE_NVENC === "1", ffmpegPath: FFMPEG_PATH, spawn }),
    VIDEO_PROBE_CACHE_LIMIT: 512,
    DEFAULT_VIDEO_CHUNK_BYTES: 4 * 1024 * 1024,
    DEFAULT_IMAGE_READER_CACHE_MAX_BYTES: 2 * 1024 * 1024 * 1024,
    MIN_IMAGE_READER_CACHE_MAX_BYTES: 128 * 1024 * 1024,
    MAX_IMAGE_READER_CACHE_MAX_BYTES: 200 * 1024 * 1024 * 1024,
    IMAGE_READER_CACHE_CLEANUP_INTERVAL_MS: 10 * 60 * 1000,
    IMAGE_READER_CACHE_CLEANUP_TARGET_RATIO: 0.9,
    IMAGE_READER_CACHE_TOUCH_THROTTLE_MS: 30 * 1000,
    IMAGE_READER_LIST_CACHE_TTL_MS: 6 * 60 * 60 * 1000,
    ARCHIVE_IMAGE_EXTS: new Set([".jpg", ".jpeg", ".png", ".webp", ".bmp", ".gif"]),
    ARCHIVE_EXTS: new Set([".zip", ".cbz", ".rar", ".7z"]),
    PHOTO_SET_COVER_GENERATOR_VERSION: 2,
    GALLERY_MEDIA_COVER_GENERATOR_VERSION: 1,
    IMAGE_GALLERY_COVER_MAX_BYTES: 1024 * 1024,
    IMAGE_GALLERY_COVER_BOX_SIZE: 640,
    LOCAL_ACTOR_AVATAR_SOURCE: "local-avatar",
    MAX_ACTOR_AVATAR_BYTES: 8 * 1024 * 1024,
    MAX_REMOTE_IMAGE_BYTES: 8 * 1024 * 1024,
    ACTOR_AVATAR_EXTS: new Set([".jpg", ".jpeg", ".png", ".webp"]),
    DEFAULT_FAVORITE_FOLDER_ID: "default",
    DEFAULT_FAVORITE_FOLDER_NAME: "默认收藏",
    MAX_FAVORITE_FOLDERS: 30,
    RECENT_WATCHED_DAYS: 30,
    ADMIN_TASK_HISTORY_LIMIT: 100,
    TOOL_DOWNLOAD_TTL_MS: 10 * 60 * 1000,
    TXT_TOOL_MAX_FILE_BYTES,
    TXT_TOOL_MAX_BODY_BYTES: Math.ceil(TXT_TOOL_MAX_FILE_BYTES * 1.4) + 128 * 1024,
    TXT_TOOL_PREVIEW_BYTES: 256 * 1024,
    PHOTO_COLLECTION_ROOT_VALUE: "__fanhao_photo_collection_root__",
    MIME_TYPES: {
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
      ".flac": "audio/flac",
      ".mp3": "audio/mpeg",
      ".m4a": "audio/mp4",
      ".aac": "audio/aac",
      ".wav": "audio/wav",
      ".ogg": "audio/ogg",
      ".opus": "audio/ogg",
      ".iso": "application/octet-stream",
      ".txt": "text/plain; charset=utf-8",
      ".nfo": "text/plain; charset=utf-8",
      ".srt": "text/plain; charset=utf-8",
      ".ass": "text/plain; charset=utf-8",
      ".ssa": "text/plain; charset=utf-8",
      ".md": "text/markdown; charset=utf-8",
      ".xml": "application/xml; charset=utf-8",
      ".csv": "text/csv; charset=utf-8"
    }
  };
}

export const SERVER_CONFIG = createServerConfig();

function detectNvenc({ disabled, ffmpegPath, spawn }) {
  if (disabled) return false;
  try {
    const result = spawn(ffmpegPath, ["-hide_banner", "-encoders"], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 3000
    });
    return `${result.stdout || ""}${result.stderr || ""}`.includes("h264_nvenc");
  } catch {
    return false;
  }
}
