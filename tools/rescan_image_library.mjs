import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "..");
const DATA_DIR = path.join(REPO_ROOT, "data");
const IMAGE_LIBRARY_INDEX_PATH = path.join(DATA_DIR, "image-library-index.json");

const EXCLUDED_DIRS = new Set(["$RECYCLE.BIN", "System Volume Information", "Recovery"]);
const ARCHIVE_EXTS = new Set([".zip", ".cbz", ".rar", ".7z"]);
const VIDEO_EXTS = new Set([".mp4", ".mkv", ".avi", ".mov", ".wmv", ".flv", ".m4v", ".ts", ".m2ts", ".webm", ".iso"]);
const DIRECT_VIDEO_EXTS = new Set([".mp4", ".m4v", ".webm"]);
const PHOTO_COLLECTION_ROOT_VALUE = "__fanhao_photo_collection_root__";
const VALID_SCAN_SCOPES = new Set(["all", "photo", "media", "movie", "tv"]);

function normalizeExt(fileName) {
  return path.extname(fileName).toLowerCase();
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

function readJsonFile(filePath, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
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

function parseArgs(argv) {
  const options = { scope: "all" };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--scope") {
      options.scope = String(argv[++index] || "all").trim().toLowerCase();
    } else if (arg === "--photo-only") {
      options.scope = "photo";
    } else if (arg === "--media-only") {
      options.scope = "media";
    } else if (arg === "--western-only") {
      options.scope = "media";
    } else if (arg === "--movie-only") {
      options.scope = "movie";
    } else if (arg === "--tv-only") {
      options.scope = "tv";
    }
  }
  if (options.scope === "movies") options.scope = "movie";
  if (options.scope === "television") options.scope = "tv";
  if (options.scope === "western") options.scope = "media";
  if (!VALID_SCAN_SCOPES.has(options.scope)) options.scope = "all";
  return options;
}

function isExcludedDirName(name) {
  const lower = name.toLowerCase();
  return EXCLUDED_DIRS.has(name) || name.startsWith("$") || name.startsWith(".") || lower.startsWith("found.");
}

function isArchiveFile(fileName) {
  return ARCHIVE_EXTS.has(normalizeExt(fileName));
}

function isVideo(fileName) {
  return VIDEO_EXTS.has(normalizeExt(fileName));
}

function imageLibraryRootLabel(rootPath) {
  const parsed = path.parse(rootPath);
  const trimmed = String(rootPath || "").replace(/[\\/]+$/g, "");
  return path.basename(trimmed) || parsed.root || rootPath;
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

function walkMatchingFiles(rootPath, predicate, label) {
  const results = [];
  const root = path.resolve(rootPath);
  if (!safeStat(root)?.isDirectory()) return results;
  const stack = [root];
  let visitedDirs = 0;
  while (stack.length) {
    const current = stack.pop();
    visitedDirs += 1;
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
      if (entry.isFile() && predicate(entry.name)) results.push(fullPath);
    }

    if (visitedDirs % 2000 === 0) {
      console.log(`[${label}] visited ${visitedDirs.toLocaleString()} dirs, found ${results.length.toLocaleString()} files`);
    }
  }
  results.sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" }));
  return results;
}

function photoSetCoverUrl(albumId, updatedAt = "") {
  const suffix = updatedAt ? `?v=${encodeURIComponent(updatedAt)}` : "";
  return `/media/gallery-cover/${encodeURIComponent(albumId)}${suffix}`;
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

function rootStatuses(roots) {
  return roots.map((root) => {
    const stat = safeStat(root);
    return {
      root,
      label: imageLibraryRootLabel(root),
      exists: Boolean(stat?.isDirectory())
    };
  });
}

function mediaRootStatuses(sources) {
  return sources.flatMap((source) =>
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

function scanPhotoSetLibrary(photoRoots) {
  const roots = rootStatuses(photoRoots);
  const albums = [];
  const seen = new Set();
  for (const root of roots) {
    if (!root.exists) {
      console.log(`[photo] missing ${root.root}`);
      continue;
    }
    console.log(`[photo] scanning ${root.root}`);
    const files = walkMatchingFiles(root.root, isArchiveFile, "photo");
    console.log(`[photo] ${root.root}: ${files.length.toLocaleString()} archives`);
    for (const filePath of files) {
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
  return { roots, photoSets: albums };
}

function scanGalleryMediaLibrary(sources) {
  const roots = mediaRootStatuses(sources);
  const items = [];
  const seen = new Set();
  for (const source of sources) {
    for (const rootPath of source.roots) {
      if (!safeStat(rootPath)?.isDirectory()) {
        console.log(`[${source.kind}] missing ${rootPath}`);
        continue;
      }
      console.log(`[${source.kind}] scanning ${rootPath}`);
      const files = walkMatchingFiles(rootPath, isVideo, source.kind);
      console.log(`[${source.kind}] ${rootPath}: ${files.length.toLocaleString()} videos`);
      for (const filePath of files) {
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
  return { mediaRoots: roots, mediaItems: items };
}

function sortGalleryMediaItems(items) {
  return (items || []).slice().sort((a, b) => {
    if (a.mediaKind !== b.mediaKind) return a.mediaKind.localeCompare(b.mediaKind);
    const timeDiff = new Date(b.updatedAt || 0).getTime() - new Date(a.updatedAt || 0).getTime();
    return timeDiff || a.title.localeCompare(b.title, undefined, { numeric: true, sensitivity: "base" });
  });
}

function writeIndex(index) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tempPath = path.join(DATA_DIR, `image-library-index.${process.pid}.${Date.now()}.tmp`);
  fs.writeFileSync(tempPath, `${JSON.stringify(index, null, 2)}\n`, "utf8");
  fs.renameSync(tempPath, IMAGE_LIBRARY_INDEX_PATH);
}

function buildIndex(options) {
  const existing = readJsonFile(IMAGE_LIBRARY_INDEX_PATH, {});
  const photoRoots = parseRootList(process.env.FANHAO_PHOTO_SET_ROOTS, "T:\\;T:\\[套图1]");
  const mediaSources = [
    { kind: "movie", label: "电影", roots: parseRootList(process.env.FANHAO_MOVIE_ROOTS, "Z:\\") },
    { kind: "tv", label: "电视剧", roots: parseRootList(process.env.FANHAO_TV_ROOTS, "Y:\\") }
  ];

  const scanPhoto = options.scope === "all" || options.scope === "photo";
  const scanMedia = options.scope === "all" || options.scope === "media" || ["movie", "tv"].includes(options.scope);
  const selectedMediaSources = ["movie", "tv"].includes(options.scope)
    ? mediaSources.filter((source) => source.kind === options.scope)
    : mediaSources;
  const photo = scanPhoto ? scanPhotoSetLibrary(photoRoots) : {
    roots: existing.roots || rootStatuses(photoRoots),
    photoSets: Array.isArray(existing.photoSets) ? existing.photoSets : []
  };
  let media;
  if (scanMedia) {
    const scannedMedia = scanGalleryMediaLibrary(selectedMediaSources);
    if (["movie", "tv"].includes(options.scope)) {
      media = {
        mediaRoots: mediaRootStatuses(mediaSources),
        mediaItems: sortGalleryMediaItems([
          ...(Array.isArray(existing.mediaItems) ? existing.mediaItems.filter((item) => item.mediaKind !== options.scope) : []),
          ...scannedMedia.mediaItems
        ])
      };
    } else {
      media = scannedMedia;
    }
  } else {
    media = {
      mediaRoots: existing.mediaRoots || mediaRootStatuses(mediaSources),
      mediaItems: Array.isArray(existing.mediaItems) ? existing.mediaItems : []
    };
  }

  return {
    schemaVersion: 2,
    scannedAt: new Date().toISOString(),
    roots: photo.roots,
    photoSets: photo.photoSets,
    mediaRoots: media.mediaRoots,
    mediaItems: media.mediaItems
  };
}

const startedAt = Date.now();
const options = parseArgs(process.argv.slice(2));
console.log(`[image-library] scope=${options.scope}`);
console.log(`[image-library] cache=${IMAGE_LIBRARY_INDEX_PATH}`);
const index = buildIndex(options);
writeIndex(index);
console.log(
  [
    `[image-library] done in ${Math.round((Date.now() - startedAt) / 1000)}s`,
    `photoSets=${(index.photoSets || []).length.toLocaleString()}`,
    `mediaItems=${(index.mediaItems || []).length.toLocaleString()}`,
    `size=${fs.statSync(IMAGE_LIBRARY_INDEX_PATH).size.toLocaleString()} bytes`,
    `host=${os.hostname()}`
  ].join(" ")
);
