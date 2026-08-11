import fs from "node:fs";
import path from "node:path";
import { CURRENT_INDEX_SCHEMA, PARSER_VERSION, imageLibraryCacheIdentity, imageLibraryIndexMatches } from "./image-library-index-contract.js";

export function createImageLibraryIndexService({
  archiveExts,
  createId,
  directVideoExts,
  ensureDataDir,
  galleryMediaSources,
  imageLibraryIndexPath,
  isExcludedDirName,
  isVideo,
  normalizeExt,
  photoSetCoverUrl,
  photoSetRoots,
  readJsonFile,
  safeStat,
  videoExts = []
}) {
  let cache = null;
  const cacheIdentity = imageLibraryCacheIdentity({ archiveExts, directVideoExts, galleryMediaSources, photoSetRoots, videoExts });

  function isArchiveFile(fileName) {
    return archiveExts.has(normalizeExt(fileName));
  }

  function rootLabel(rootPath) {
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

  function publicPhotoSetArchive(filePath, rootPath) {
    const stat = safeStat(filePath);
    const relativePath = path.relative(rootPath, filePath);
    const dirParts = path
      .dirname(relativePath)
      .split(/[\\/]+/)
      .filter((part) => part && part !== ".");
    const title = path.basename(filePath, path.extname(filePath));
    const id = createId("ps", path.resolve(filePath));
    const category = dirParts[0] || rootLabel(rootPath);
    const updatedAt = stat ? new Date(stat.mtimeMs).toISOString() : "";
    return {
      id,
      type: "photoSet",
      title,
      category,
      subCategory: dirParts[1] || "",
      personName: inferPhotoSetPerson(dirParts, title),
      rootLabel: rootLabel(rootPath),
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
    return photoSetRoots.map((root) => {
      const stat = safeStat(root);
      return {
        root,
        label: rootLabel(root),
        exists: Boolean(stat?.isDirectory())
      };
    });
  }

  function galleryMediaRootStatuses() {
    return galleryMediaSources.flatMap((source) =>
      source.roots.map((root) => {
        const stat = safeStat(root);
        return {
          kind: source.kind,
          label: source.label,
          root,
          rootLabel: rootLabel(root),
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
      playable: directVideoExts.has(ext),
      streamUrl: `/media/gallery-video/${encodeURIComponent(id)}`,
      coverUrl: ""
    };
  }

  function scanGalleryMediaLibrary() {
    const roots = galleryMediaRootStatuses();
    const items = [];
    const seen = new Set();
    for (const source of galleryMediaSources) {
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
      schemaVersion: CURRENT_INDEX_SCHEMA,
      parserVersion: PARSER_VERSION,
      cacheIdentity,
      scannedAt: new Date().toISOString(),
      roots: photo.roots,
      photoSets: photo.photoSets,
      mediaRoots: media.mediaRoots,
      mediaItems: media.mediaItems
    };
  }

  function loadCache() {
    if (cache) return cache;
    const cached = readJsonFile(imageLibraryIndexPath, null);
    if (imageLibraryIndexMatches(cached, cacheIdentity)) {
      cache = cached;
      return cache;
    }
    return null;
  }

  function saveCache(index) {
    ensureDataDir();
    fs.writeFileSync(imageLibraryIndexPath, JSON.stringify(index, null, 2), "utf8");
  }

  function getIndex(options = {}) {
    if (!options.refresh) {
      const cached = loadCache();
      if (cached) return cached;
    }
    cache = scanImageLibrary();
    saveCache(cache);
    return cache;
  }

  function invalidate() {
    cache = null;
  }

  return {
    galleryMediaRootStatuses,
    getIndex,
    invalidate,
    photoSetRootStatuses,
    scanImageLibrary
  };
}
