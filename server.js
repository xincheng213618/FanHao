import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { TextDecoder } from "node:util";

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

const EXCLUDED_DIRS = new Set(["$RECYCLE.BIN", "System Volume Information", "Recovery"]);
const VIDEO_EXTS = new Set([".mp4", ".mkv", ".avi", ".mov", ".wmv", ".flv", ".m4v", ".ts", ".webm", ".iso"]);
const PLAYABLE_VIDEO_EXTS = new Set([".mp4", ".m4v", ".mov", ".webm"]);
const IMAGE_EXTS = new Set([".jpg", ".jpeg", ".png", ".webp", ".bmp", ".gif"]);
const INFO_EXTS = new Set([".nfo", ".txt", ".json", ".xml", ".html", ".htm", ".csv", ".md", ".srt", ".ass", ".ssa"]);
const COVER_HINTS = new Set(["cover", "poster", "folder", "front", "fanart", "thumb", "thumbnail"]);
const MAX_INFO_BYTES = 1024 * 1024;

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
let actorDb = null;

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
    version: 1,
    favorites: {},
    progress: {}
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

function normalizeSearchValue(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[\s._\-()[\]【】（）]+/g, "");
}

function normalizePersonSearchValue(value) {
  return String(value || "").trim().toLowerCase().replace(/\s+/g, "");
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

  for (const person of library.people) {
    const name = person.name || "";
    if (normalizePersonSearchValue(name) === exactName) {
      exact.push(person);
      continue;
    }

    if (bracketed) continue;

    const lowerName = name.toLowerCase();
    const normalizedName = normalizeSearchValue(name);
    if (
      lowerName.includes(query.toLowerCase()) ||
      (normalizedQuery.length >= 2 && normalizedName.includes(normalizedQuery))
    ) {
      fuzzy.push(person);
    }
  }

  const sortPeople = (people) =>
    people.sort((a, b) => b.workCount - a.workCount || a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }));

  sortPeople(exact);
  sortPeople(fuzzy);
  return { exact, fuzzy, people: exact.length ? exact : fuzzy.slice(0, 20) };
}

function workSearchText(work) {
  const person = library.peopleById.get(work.personId);
  return [
    work.title,
    work.directoryName,
    work.relativePath,
    person?.name,
    ...(work.videos || []).flatMap((video) => [video.name, video.title, video.relativePath]),
    ...(work.images || []).flatMap((image) => [image.name, image.title]),
    ...(work.infos || []).flatMap((info) => [info.name, info.title])
  ]
    .filter(Boolean)
    .join("\n")
    .toLowerCase();
}

function matchesWorkSearch(work, query) {
  if (!query) return true;
  const text = workSearchText(work);
  const normalizedQuery = normalizeSearchValue(query);
  return text.includes(query) || (normalizedQuery.length >= 2 && normalizeSearchValue(text).includes(normalizedQuery));
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
    `);
  }
  return actorDb;
}

function actorProfileRow(personId) {
  try {
    return getActorDb().prepare("SELECT * FROM actor_profiles WHERE person_id = ?").get(personId) || null;
  } catch (error) {
    console.warn("[actor-db]", error.message);
    return null;
  }
}

function publicActorProfile(row) {
  if (!row) return null;

  let aliases = [];
  try {
    aliases = row.aliases_json ? JSON.parse(row.aliases_json) : [];
  } catch {
    aliases = [];
  }

  return {
    personId: row.person_id,
    personName: row.person_name,
    javdbActorId: row.javdb_actor_id || "",
    javdbUrl: row.javdb_url || "",
    displayName: row.display_name || row.person_name,
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

function upsertActorProfile(person, payload) {
  const now = new Date().toISOString();
  const avatarBase64 = typeof payload.avatarBase64 === "string" ? payload.avatarBase64 : "";
  const avatarBlob = avatarBase64 ? Buffer.from(avatarBase64, "base64") : null;
  const aliases = Array.isArray(payload.aliases) ? payload.aliases.filter(Boolean).map(String) : [];
  const movieCount = Number.isFinite(Number(payload.movieCount)) ? Number(payload.movieCount) : null;

  const existing = actorProfileRow(person.id);
  let existingAliases = [];
  try {
    existingAliases = existing?.aliases_json ? JSON.parse(existing.aliases_json) : [];
  } catch {
    existingAliases = [];
  }
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
      payload.javdbActorId || existing?.javdb_actor_id || null,
      payload.javdbUrl || existing?.javdb_url || null,
      payload.displayName || existing?.display_name || person.name,
      JSON.stringify(aliases.length ? aliases : existingAliases),
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
    userState = {
      version: 1,
      favorites: data.favorites && typeof data.favorites === "object" ? data.favorites : {},
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
    lastScanError = null;
    console.log(
      `[scan] ${library.totals.people} people, ${library.totals.works} works, ${library.totals.videos} videos, ${library.totals.images} images`
    );
  } catch (error) {
    lastScanError = error;
    console.error("[scan]", error.message);
  }
}

function isFavoriteWork(workId) {
  return Boolean(userState.favorites[workId]);
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

function userStateSummary() {
  const favoriteCount = Object.keys(userState.favorites).filter((workId) => library.worksById.has(workId)).length;
  const historyWorkIds = new Set();
  for (const [videoId, progress] of Object.entries(userState.progress)) {
    if (progress?.workId && library.worksById.has(progress.workId)) {
      historyWorkIds.add(progress.workId);
      continue;
    }

    const file = library.filesById.get(videoId);
    if (!file) continue;
    for (const work of library.worksById.values()) {
      if ((work.videos || []).some((video) => video.id === videoId)) {
        historyWorkIds.add(work.id);
        break;
      }
    }
  }

  return {
    favoriteCount,
    historyCount: historyWorkIds.size
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

function decodeInfoText(buffer) {
  const decoders = ["utf-8", "shift_jis", "gb18030"];
  for (const encoding of decoders) {
    try {
      return new TextDecoder(encoding, { fatal: true }).decode(buffer);
    } catch {
      // Try the next common encoding used by local Japanese or Chinese metadata files.
    }
  }
  return buffer.toString("utf8");
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
  sendJson(res, 200, {
    id: file.id,
    name: file.name,
    ext: file.ext,
    size: file.size,
    relativePath: file.relativePath,
    content: decodeInfoText(buffer)
  });
}

function publicPerson(person) {
  const actorProfile = publicActorProfile(actorProfileRow(person.id));
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
    actorProfile
  };
}

function publicWork(work, includeFiles = false) {
  const person = library.peopleById.get(work.personId);
  const cachedCover = work.coverId ? null : publicWorkCover(workCoverRow(work.id));
  const base = {
    id: work.id,
    personId: work.personId,
    personName: person?.name || "",
    title: work.title,
    directoryName: work.directoryName,
    relativePath: work.relativePath,
    coverId: work.coverId,
    cachedCover,
    videoCount: work.videoCount,
    playableCount: work.playableCount,
    imageCount: work.imageCount,
    infoCount: work.infoCount,
    modifiedAt: work.modifiedAt,
    favorite: isFavoriteWork(work.id),
    progress: getWorkProgress(work)
  };

  if (includeFiles) {
    base.videos = work.videos.map(publicMediaFile);
    base.images = work.images.map(publicMediaFile);
    base.infos = work.infos.map(publicMediaFile);
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

function favoriteWorks() {
  return Object.entries(userState.favorites)
    .map(([workId, favorite]) => ({ work: library.worksById.get(workId), favorite }))
    .filter((item) => item.work)
    .sort((a, b) => String(b.favorite.createdAt || "").localeCompare(String(a.favorite.createdAt || "")))
    .map((item) => item.work);
}

function historyWorks() {
  const byWorkId = new Map();

  for (const [videoId, progress] of Object.entries(userState.progress)) {
    let workId = progress?.workId;
    if (!workId) {
      for (const work of library.worksById.values()) {
        if ((work.videos || []).some((video) => video.id === videoId)) {
          workId = work.id;
          break;
        }
      }
    }

    const work = workId ? library.worksById.get(workId) : null;
    if (!work) continue;

    const existing = byWorkId.get(work.id);
    if (!existing || String(progress.updatedAt || "") > String(existing.updatedAt || "")) {
      byWorkId.set(work.id, { work, updatedAt: progress.updatedAt || "" });
    }
  }

  return [...byWorkId.values()]
    .sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")))
    .map((item) => item.work);
}

async function routeApi(req, res, url) {
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
      lastScanError: lastScanError?.message || null,
      people: library.people.map(publicPerson)
    });
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

  if (url.pathname === "/api/favorites" && req.method === "GET") {
    const works = favoriteWorks().map((work) => publicWork(work));
    sendJson(res, 200, { count: works.length, works });
    return true;
  }

  if (url.pathname === "/api/history" && req.method === "GET") {
    const works = historyWorks().map((work) => publicWork(work));
    sendJson(res, 200, { count: works.length, works });
    return true;
  }

  if (url.pathname === "/api/search" && req.method === "GET") {
    const rawQuery = (url.searchParams.get("q") || "").trim();
    const query = rawQuery.toLowerCase();
    const peopleSearch = searchPeople(rawQuery);
    const exactPersonIds = new Set(peopleSearch.exact.map((person) => person.id));
    const works = [...library.worksById.values()]
      .filter((work) => {
        return exactPersonIds.has(work.personId) || matchesWorkSearch(work, query);
      })
      .sort((a, b) => String(b.modifiedAt || "").localeCompare(String(a.modifiedAt || "")))
      .slice(0, 600)
      .map((work) => publicWork(work));
    sendJson(res, 200, {
      q: rawQuery,
      count: works.length,
      people: peopleSearch.people.map(publicPerson),
      works
    });
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
    const profile = upsertActorProfile(person, body);
    sendJson(res, 200, { ok: true, profile });
    return true;
  }

  const favoriteMatch = /^\/api\/favorites\/([^/]+)$/.exec(url.pathname);
  if (favoriteMatch && req.method === "POST") {
    const workId = favoriteMatch[1];
    if (!library.worksById.has(workId)) {
      notFound(res);
      return true;
    }

    if (userState.favorites[workId]) {
      delete userState.favorites[workId];
    } else {
      userState.favorites[workId] = { createdAt: new Date().toISOString() };
    }

    saveUserState();
    sendJson(res, 200, {
      workId,
      favorite: Boolean(userState.favorites[workId]),
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

    const works = person.works
      .map((workId) => library.worksById.get(workId))
      .filter(Boolean)
      .map((work) => publicWork(work));
    sendJson(res, 200, { person: publicPerson(person), works });
    return true;
  }

  const workMatch = /^\/api\/works\/([^/]+)$/.exec(url.pathname);
  if (workMatch && req.method === "GET") {
    const work = library.worksById.get(workMatch[1]);
    if (!work) {
      notFound(res);
      return true;
    }

    sendJson(res, 200, { work: publicWork(work, true) });
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

  const videoMatch = /^\/media\/video\/([^/]+)$/.exec(url.pathname);
  if (videoMatch && req.method === "GET") {
    const file = library.filesById.get(videoMatch[1]);
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
