import fs from "node:fs";
import path from "node:path";
import { createMangaDatabaseReader } from "./manga-database.js";

function createId(prefix, value) {
  return `${prefix}_${Buffer.from(value).toString("base64url")}`;
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

function isMangaCacheDirName(name) {
  return /^(?:smtt6|jmd9)_cache_[A-Za-z0-9_-]+$/i.test(String(name || ""));
}

function mangaSiteFromDirName(name) {
  const lower = String(name || "").toLowerCase();
  if (lower.startsWith("smtt6_")) return "smtt6";
  if (lower.startsWith("jmd9_")) return "jmd9";
  return "local";
}

export function createMangaService({
  root,
  databasePath,
  mimeTypes,
  normalizeExt,
  notFound,
  safeStat,
  serveArchiveMemberImage
}) {
  const database = createMangaDatabaseReader({ dbPath: databasePath });

  function databaseKey(cacheDir) {
    return path.resolve(cacheDir);
  }

  function chapterFromDatabase(row) {
    if (!row) return null;
    return {
      index: Number(row.chapter_index || 0),
      slug: String(row.slug || ""),
      title: String(row.title || ""),
      url: String(row.url || ""),
      html_path: row.html_path || null,
      image_count: Number(row.image_count || 0),
      downloaded_count: Number(row.downloaded_count || 0),
      skipped_count: Number(row.skipped_count || 0),
      failed_count: Number(row.failed_count || 0),
      status: String(row.status || ""),
      error: row.error || null
    };
  }

  function imageFromDatabase(row) {
    if (!row) return null;
    return {
      index: Number(row.image_index || 0),
      source_url: String(row.source_url || ""),
      downloaded_url: row.downloaded_url || null,
      final_url: row.final_url || null,
      local_path: row.local_path || null,
      content_type: row.content_type || null,
      bytes: Number(row.bytes || 0),
      status: String(row.status || ""),
      error: row.error || null
    };
  }

  function sourceUrlForCache(cacheDir, dbComic = null) {
    const catalog = readJsonFile(path.join(cacheDir, "catalog.json"), {});
    const catalogUrl = String(dbComic?.source_url || catalog?.url || "").trim();
    if (catalogUrl) return catalogUrl;
    const manifest = readJsonFile(path.join(cacheDir, "manifest.json"), {});
    const chapterUrl = String(manifest?.chapters?.[0]?.url || "").trim();
    const match = /^(https?:\/\/[^/]+)\/man-hua-yue-du\/([^/]+)(?:\/[^/]+)?\.html$/i.exec(chapterUrl);
    return match ? `${match[1]}/man-hua-yue-du/${match[2]}.html` : chapterUrl;
  }

  function rootStatus() {
    const resolvedRoot = path.resolve(root);
    const stat = safeStat(resolvedRoot);
    return {
      root: resolvedRoot,
      exists: Boolean(stat?.isDirectory())
    };
  }

  function cacheDirs() {
    const status = rootStatus();
    if (!status.exists) return [];

    let entries = [];
    try {
      entries = fs.readdirSync(status.root, { withFileTypes: true });
    } catch {
      return [];
    }

    const candidates = entries
      .filter((entry) => entry.isDirectory() && isMangaCacheDirName(entry.name))
      .map((entry) => path.join(status.root, entry.name))
      .filter((dirPath) => fs.existsSync(path.join(dirPath, "manifest.json")))
      .sort((a, b) => path.basename(a).localeCompare(path.basename(b), undefined, { numeric: true, sensitivity: "base" }));

    // A failed/restarted crawl can leave two cache folders for the same
    // catalog (for example the old zero-image folder and a later *_full
    // folder). Prefer the copy with more downloaded images so the library
    // does not show duplicate comics.
    const bestBySource = new Map();
    for (const dirPath of candidates) {
      const key = databaseKey(dirPath);
      const dbComic = database.comic(key);
      const sourceUrl = sourceUrlForCache(dirPath, dbComic);
      if (!sourceUrl) continue;
      const downloadedCount = Number(dbComic?.downloaded_count || 0);
      const current = bestBySource.get(sourceUrl);
      if (!current || downloadedCount > current.downloadedCount) {
        bestBySource.set(sourceUrl, { dirPath, downloadedCount });
      }
    }
    return candidates.filter((dirPath) => {
      const dbComic = database.comic(databaseKey(dirPath));
      const sourceUrl = sourceUrlForCache(dirPath, dbComic);
      return !sourceUrl || bestBySource.get(sourceUrl)?.dirPath === dirPath;
    });
  }

  function idForDir(dirPath) {
    return createId("mg", path.resolve(dirPath));
  }

  function cacheById(id) {
    const targetId = String(id || "");
    if (!targetId) return null;
    for (const dirPath of cacheDirs()) {
      if (idForDir(dirPath) === targetId) return dirPath;
    }
    return null;
  }

  function chapterImageStats(chapter) {
    const images = Array.isArray(chapter?.images) ? chapter.images : [];
    const downloaded = Number(chapter?.downloaded_count || 0) || images.filter((image) => image?.status === "downloaded").length || images.length;
    return {
      imageCount: Number(chapter?.image_count || 0) || images.length,
      downloadedCount: downloaded,
      failedCount: Number(chapter?.failed_count || 0)
    };
  }

  function chapterIndex(chapter, fallbackIndex = 0) {
    const value = Number(chapter?.index);
    return Number.isFinite(value) && value > 0 ? value : fallbackIndex + 1;
  }

  function firstImage(chapter) {
    const images = Array.isArray(chapter?.images) ? chapter.images : [];
    return images.find((image) => image?.local_path) || images[0] || null;
  }

  function imageUrl(mangaId, chapterNumber, imageIndex) {
    return `/media/manga/${encodeURIComponent(mangaId)}/${encodeURIComponent(String(chapterNumber))}/${encodeURIComponent(String(imageIndex))}`;
  }

  function publicSummary(cacheDir) {
    const id = idForDir(cacheDir);
    const dirName = path.basename(cacheDir);
    const dbComic = database.comic(databaseKey(cacheDir));
    const dbCover = dbComic ? database.firstImage(databaseKey(cacheDir)) : null;
    if (dbComic) {
      return {
        id,
        title: String(dbComic.title || dirName).trim() || dirName,
        dirName,
        site: String(dbComic.site || mangaSiteFromDirName(dirName)),
        sourceUrl: sourceUrlForCache(cacheDir, dbComic),
        updatedAt: String(dbComic.updated_at || dbComic.last_sync_at || "").trim(),
        chapterCount: Number(dbComic.chapter_count || 0),
        doneChapterCount: Number(dbComic.done_chapter_count || 0),
        imageCount: Number(dbComic.image_count || 0),
        downloadedCount: Number(dbComic.downloaded_count || 0),
        failedCount: Number(dbComic.failed_count || 0),
        coverUrl: dbCover
          ? imageUrl(id, Number(dbCover.chapter_index || 1), Number(dbCover.image_index || 1))
          : ""
      };
    }
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
      const stats = chapterImageStats(chapter);
      imageTotal += stats.imageCount;
      downloadedTotal += stats.downloadedCount;
      failedTotal += stats.failedCount;
      if (String(chapter?.status || "").toLowerCase() === "done" || stats.failedCount === 0) doneChapterTotal += 1;
      if (!coverUrl && firstImage(chapter)) {
        coverUrl = imageUrl(id, chapterIndex(chapter, index), Number(firstImage(chapter)?.index || 1));
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

  function publicChapterSummary(mangaId, chapter, index, coverImage = null) {
    const resolvedChapterIndex = chapterIndex(chapter, index);
    const stats = chapterImageStats(chapter);
    const image = coverImage || firstImage(chapter);
    return {
      index: resolvedChapterIndex,
      title: String(chapter?.title || `第 ${resolvedChapterIndex} 话`).trim(),
      slug: String(chapter?.slug || "").trim(),
      status: String(chapter?.status || "").trim(),
      imageCount: stats.imageCount,
      downloadedCount: stats.downloadedCount,
      failedCount: stats.failedCount,
      coverUrl: image ? imageUrl(mangaId, resolvedChapterIndex, Number(image.index || 1)) : ""
    };
  }

  function publicDetail(cacheDir) {
    const summary = publicSummary(cacheDir);
    const dbChapters = database.chapters(databaseKey(cacheDir));
    if (dbChapters.length) {
      return {
        ...summary,
        createdAt: String(database.comic(databaseKey(cacheDir))?.created_at || "").trim(),
        chapters: dbChapters.map((row, index) => {
          const chapter = chapterFromDatabase(row);
          const coverImage = database.firstImage(databaseKey(cacheDir), chapter.index);
          return publicChapterSummary(summary.id, chapter, index, imageFromDatabase(coverImage));
        })
      };
    }
    const manifest = readJsonFile(path.join(cacheDir, "manifest.json"), {});
    const chapters = Array.isArray(manifest.chapters) ? manifest.chapters : [];
    return {
      ...summary,
      createdAt: String(manifest.created_at || "").trim(),
      chapters: chapters.map((chapter, index) => publicChapterSummary(summary.id, chapter, index))
    };
  }

  function findChapter(cacheDir, requestedIndex) {
    const dbChapter = database.chapter(databaseKey(cacheDir), requestedIndex);
    if (dbChapter) {
      return {
        chapter: chapterFromDatabase(dbChapter),
        arrayIndex: Math.max(0, Number(dbChapter.chapter_index || 1) - 1),
        chapterIndex: Number(dbChapter.chapter_index || requestedIndex),
        fromDatabase: true
      };
    }
    const detail = readJsonFile(path.join(cacheDir, "manifest.json"), {});
    const chapters = Array.isArray(detail.chapters) ? detail.chapters : [];
    const target = Number(requestedIndex);
    for (let index = 0; index < chapters.length; index += 1) {
      const chapter = chapters[index];
      if (chapterIndex(chapter, index) === target) {
        return { chapter, arrayIndex: index, chapterIndex: target };
      }
    }
    return null;
  }

  function publicChapter(cacheDir, requestedIndex) {
    const manga = publicSummary(cacheDir);
    const found = findChapter(cacheDir, requestedIndex);
    if (!found) return null;
    const images = found.fromDatabase
      ? database.images(databaseKey(cacheDir), found.chapterIndex).map(imageFromDatabase)
      : Array.isArray(found.chapter.images) ? found.chapter.images : [];
    return {
      ...publicChapterSummary(
        manga.id,
        found.chapter,
        found.arrayIndex,
        found.fromDatabase
          ? imageFromDatabase(database.firstImage(databaseKey(cacheDir), found.chapterIndex))
          : null
      ),
      images: images.map((image, index) => {
        const resolvedImageIndex = Number(image?.index || index + 1);
        return {
          index: resolvedImageIndex,
          name: path.basename(String(image?.local_path || "")) || `${String(resolvedImageIndex).padStart(3, "0")}`,
          localPath: String(image?.local_path || ""),
          contentType: String(image?.content_type || "").trim(),
          bytes: Number(image?.bytes || 0),
          status: String(image?.status || "").trim(),
          url: imageUrl(manga.id, found.chapterIndex, resolvedImageIndex)
        };
      })
    };
  }

  function imageRecord(cacheDir, chapterNumber, imageIndex) {
    const dbImage = database.image(databaseKey(cacheDir), chapterNumber, imageIndex);
    const dbChapter = database.chapter(databaseKey(cacheDir), chapterNumber);
    if (dbImage && dbChapter) {
      const resolvedImage = imageFromDatabase(dbImage);
      if (!resolvedImage?.local_path) return null;
      return {
        chapter: chapterFromDatabase(dbChapter),
        image: resolvedImage,
        chapterIndex: Number(dbChapter.chapter_index || chapterNumber),
        imageIndex: Number(dbImage.image_index || imageIndex)
      };
    }
    const found = findChapter(cacheDir, chapterNumber);
    if (!found) return null;
    const images = Array.isArray(found.chapter.images) ? found.chapter.images : [];
    const targetImageIndex = Number(imageIndex);
    const image = images.find((item, index) => Number(item?.index || index + 1) === targetImageIndex);
    if (!image?.local_path) return null;
    return { chapter: found.chapter, image, chapterIndex: found.chapterIndex, imageIndex: targetImageIndex || 1 };
  }

  function chapterDirFromRecord(cacheDir, chapter, image) {
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

  async function serveImage(res, mangaId, chapterNumber, imageIndex) {
    const cacheDir = cacheById(decodeURIComponent(mangaId));
    if (!cacheDir) {
      notFound(res);
      return;
    }
    const record = imageRecord(cacheDir, decodeURIComponent(chapterNumber), decodeURIComponent(imageIndex));
    if (!record) {
      notFound(res);
      return;
    }

    const chapterDir = chapterDirFromRecord(cacheDir, record.chapter, record.image);
    const sourceImagePath = safeChildPath(cacheDir, record.image.local_path);
    if (!chapterDir || !sourceImagePath) {
      notFound(res);
      return;
    }
    const memberPath = path.relative(chapterDir, sourceImagePath).replace(/\\/g, "/");
    const archivePath = `${chapterDir}.zip`;
    await serveArchiveMemberImage(res, {
      sourceType: "manga",
      archivePath,
      memberPath,
      fallbackPath: sourceImagePath,
      contentType: record.image.content_type || mimeTypes[normalizeExt(memberPath)] || ""
    });
  }

  return {
    cacheById,
    cacheDirs,
    imageUrl,
    publicChapter,
    publicDetail,
    publicSummary,
    rootStatus,
    serveImage,
    databaseStatus: database.status
  };
}
