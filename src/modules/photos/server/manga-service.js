import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { createMangaDatabaseReader } from "./manga-database.js";
import { streamStoredZip } from "./stored-zip-stream.js";

const imageDimensionCache = new Map();
const MANGA_JOB_HISTORY_SCHEMA_VERSION = 1;
const MAX_MANGA_JOB_HISTORY = 50;

function readImageDimensions(filePath) {
  if (!filePath) return null;
  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch {
    return null;
  }
  if (!stat.isFile() || stat.size < 10) return null;
  const signature = `${stat.size}:${stat.mtimeMs}`;
  const cached = imageDimensionCache.get(filePath);
  if (cached?.signature === signature) return cached.dimensions;

  let handle;
  let dimensions = null;
  try {
    handle = fs.openSync(filePath, "r");
    const buffer = Buffer.allocUnsafe(Math.min(stat.size, 64 * 1024));
    const bytesRead = fs.readSync(handle, buffer, 0, buffer.length, 0);
    dimensions = parseImageDimensions(buffer.subarray(0, bytesRead));
  } catch {
    dimensions = null;
  } finally {
    if (handle !== undefined) {
      try { fs.closeSync(handle); } catch {}
    }
  }

  imageDimensionCache.set(filePath, { signature, dimensions });
  if (imageDimensionCache.size > 20000) {
    imageDimensionCache.delete(imageDimensionCache.keys().next().value);
  }
  return dimensions;
}

function parseImageDimensions(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 10) return null;

  if (buffer.length >= 24 && buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    return validImageDimensions(buffer.readUInt32BE(16), buffer.readUInt32BE(20));
  }

  const header = buffer.subarray(0, 6).toString("ascii");
  if ((header === "GIF87a" || header === "GIF89a") && buffer.length >= 10) {
    return validImageDimensions(buffer.readUInt16LE(6), buffer.readUInt16LE(8));
  }

  if (buffer[0] === 0xff && buffer[1] === 0xd8) {
    let offset = 2;
    while (offset + 9 < buffer.length) {
      if (buffer[offset] !== 0xff) {
        offset += 1;
        continue;
      }
      const marker = buffer[offset + 1];
      if (marker === 0xd8 || marker === 0xd9) {
        offset += 2;
        continue;
      }
      if (offset + 4 > buffer.length) break;
      const segmentLength = buffer.readUInt16BE(offset + 2);
      if (segmentLength < 2 || offset + 2 + segmentLength > buffer.length) break;
      if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
        return validImageDimensions(buffer.readUInt16BE(offset + 7), buffer.readUInt16BE(offset + 5));
      }
      offset += 2 + segmentLength;
    }
  }

  if (buffer.length >= 30 && buffer.subarray(0, 4).toString("ascii") === "RIFF" && buffer.subarray(8, 12).toString("ascii") === "WEBP") {
    const chunk = buffer.subarray(12, 16).toString("ascii");
    if (chunk === "VP8X") {
      const width = 1 + buffer[24] + (buffer[25] << 8) + (buffer[26] << 16);
      const height = 1 + buffer[27] + (buffer[28] << 8) + (buffer[29] << 16);
      return validImageDimensions(width, height);
    }
    if (chunk === "VP8 " && buffer[23] === 0x9d && buffer[24] === 0x01 && buffer[25] === 0x2a) {
      return validImageDimensions(buffer.readUInt16LE(26) & 0x3fff, buffer.readUInt16LE(28) & 0x3fff);
    }
    if (chunk === "VP8L" && buffer[20] === 0x2f) {
      const width = 1 + buffer[21] + ((buffer[22] & 0x3f) << 8);
      const height = 1 + ((buffer[22] & 0xc0) >> 6) + (buffer[23] << 2) + ((buffer[24] & 0x0f) << 10);
      return validImageDimensions(width, height);
    }
  }

  return null;
}

function validImageDimensions(width, height) {
  const resolvedWidth = Number(width || 0);
  const resolvedHeight = Number(height || 0);
  if (!Number.isInteger(resolvedWidth) || !Number.isInteger(resolvedHeight) || resolvedWidth <= 0 || resolvedHeight <= 0) return null;
  return { width: resolvedWidth, height: resolvedHeight };
}

function createId(prefix, value) {
  return `${prefix}_${Buffer.from(value).toString("base64url")}`;
}

function stableMangaId(sourceUrl, dirPath) {
  const value = String(sourceUrl || path.resolve(dirPath)).trim();
  return `manga_${createHash("sha256").update(value).digest("base64url").slice(0, 18)}`;
}

function decodeHtml(value) {
  return String(value || "")
    .replace(/<br\s*\/?\s*>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/\s+/g, " ")
    .trim();
}

function matchValue(html, patterns) {
  for (const pattern of patterns) {
    const match = pattern.exec(html);
    const value = decodeHtml(match?.[1] || "");
    if (value) return value;
  }
  return "";
}

function cleanComicTitle(value, fallback) {
  const title = decodeHtml(value);
  const quoted = /《([^》]+)》/.exec(title)?.[1];
  return String(quoted || title || fallback).replace(/\s*[-–—]\s*(?:色漫天堂|禁漫岛|污污漫畫|汙汙漫畫).*$/i, "").trim();
}

function metadataForCache(cacheDir, dbComic = null) {
  const catalog = readJsonFile(path.join(cacheDir, "catalog.json"), {});
  let html = "";
  try { html = fs.readFileSync(path.join(cacheDir, "catalog.html"), "utf8"); } catch {}
  const description = String(dbComic?.description || catalog.description || matchValue(html, [
    /<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)["']/i,
    /<meta[^>]+content=["']([^"']*)["'][^>]+name=["']description["']/i,
    /(?:简介|剧情)\s*[：:]\s*([\s\S]{1,500}?)(?:<\/li>|<\/div>)/i
  ])).replace(/^《[^》]+》在线阅读，剧情介绍：?/, "").trim();
  const author = String(dbComic?.author || catalog.author || matchValue(html, [
    /sp-book-author[^>]*>\s*作者\s*[：:]\s*([\s\S]*?)<\/p>/i,
    /作者\s*[：:]\s*[\s\S]{0,180}?<a[^>]*>([\s\S]*?)<\/a>/i,
    /video-info-itemtitle[^>]*>\s*作者\s*[：:]\s*<\/span>[\s\S]{0,160}?<div[^>]*>([\s\S]*?)<\/div>/i
  ])).trim();
  const status = String(dbComic?.publication_status || dbComic?.status_text || catalog.status || matchValue(html, [
    /(?:状态|狀態)\s*[：:]\s*<span[^>]*>([\s\S]*?)<\/span>/i,
    /状态\s*[：:]\s*<\/em>\s*<span[^>]*>([\s\S]*?)<\/span>/i,
    /video-info-itemtitle[^>]*>\s*更新\s*[：:]\s*<\/span>[\s\S]{0,120}?<div[^>]*>([\s\S]*?)<\/div>/i
  ])).trim();
  const coverUrl = String(dbComic?.cover_url || catalog.cover_url || matchValue(html, [
    /sp-book-cover[\s\S]{0,500}?data-src=["']([^"']+)["']/i,
    /hl-dc-pic[\s\S]{0,500}?data-original=["']([^"']+)["']/i,
    /module-item-cover[\s\S]{0,500}?data-original=["']([^"']+)["']/i,
    /<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i
  ])).trim();
  const tagBlock = /<div[^>]+class=["'][^"']*sp-book-tags[^"']*["'][^>]*>([\s\S]*?)<\/div>/i.exec(html)?.[1]
    || /(?:TAG|分类|分類)\s*[：:]([\s\S]{0,600}?)(?:<\/li>|<\/div>\s*<div)/i.exec(html)?.[1]
    || "";
  const tags = [...tagBlock.matchAll(/<a[^>]*>([\s\S]*?)<\/a>/gi)].map((match) => decodeHtml(match[1])).filter(Boolean);
  const localCover = String(dbComic?.cover_path || catalog.cover_path || "").trim();
  return {
    author,
    category: tags[0] || "韩漫",
    coverUrl,
    description,
    localCover,
    region: tags.some((tag) => tag.includes("韩漫")) ? "韩国" : String(catalog.region || "").trim(),
    status,
    tags: [...new Set(tags)]
  };
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
  return /^(?:smtt6|jmd9|55comic)_cache_[A-Za-z0-9_-]+$/i.test(String(name || ""));
}

function mangaSiteFromDirName(name) {
  const lower = String(name || "").toLowerCase();
  if (lower.startsWith("smtt6_")) return "smtt6";
  if (lower.startsWith("jmd9_")) return "jmd9";
  if (lower.startsWith("55comic_")) return "55comic";
  return "local";
}

export function mangaWholeDownloadReady(comic = {}) {
  const chapterCount = Math.max(0, Number(comic.chapterCount || 0));
  const doneChapterCount = Math.max(0, Number(comic.doneChapterCount || 0));
  const imageCount = Math.max(0, Number(comic.imageCount || 0));
  const downloadedCount = Math.max(0, Number(comic.downloadedCount || 0));
  const failedCount = Math.max(0, Number(comic.failedCount || 0));
  return chapterCount > 0
    && doneChapterCount >= chapterCount
    && imageCount > 0
    && downloadedCount >= imageCount
    && failedCount === 0;
}

export function createMangaService({
  root,
  databasePath,
  projectRoot = process.cwd(),
  pythonPath = "python",
  spawnProcess = spawn,
  mimeTypes,
  normalizeExt,
  notFound,
  safeStat,
  serveArchiveMemberImage
}) {
  const database = createMangaDatabaseReader({ dbPath: databasePath });
  const resolvedDatabasePath = path.resolve(databasePath || path.join(root, "manga.sqlite"));
  const updateJobs = new Map();
  const jobsById = new Map();
  const resolvedRoot = path.resolve(root);
  const jobHistoryPath = path.join(resolvedRoot, ".manga-jobs.json");
  let updateSequence = 0;
  let lastJobHistorySave = 0;
  let storageSnapshot = null;
  let directoryLookup = null;

  restoreJobHistory();

  function updateError(message, statusCode = 400) {
    const error = new Error(message);
    error.statusCode = statusCode;
    return error;
  }

  function restoreJobHistory() {
    const payload = readJsonFile(jobHistoryPath, null);
    if (payload?.schemaVersion !== MANGA_JOB_HISTORY_SCHEMA_VERSION || !Array.isArray(payload.jobs)) return;
    let repairedInterruptedJob = false;
    const restored = payload.jobs
      .slice(0, MAX_MANGA_JOB_HISTORY * 2)
      .map(restoreJobHistoryRecord)
      .filter(Boolean)
      .sort((a, b) => String(b.startedAt || "").localeCompare(String(a.startedAt || "")));
    for (const job of restored) {
      if (jobsById.has(job.id)) continue;
      if (job.status === "running") {
        job.status = "failed";
        job.finishedAt = new Date().toISOString();
        job.exitCode = null;
        job.error = "后台重启，任务已中断，请重新采集";
        job.message = job.error;
        repairedInterruptedJob = true;
      }
      jobsById.set(job.id, job);
      const cacheKey = databaseKey(job.cacheDir);
      if (!updateJobs.has(cacheKey)) updateJobs.set(cacheKey, job);
      const sequence = Number(String(job.id).match(/-(\d+)$/u)?.[1] || 0);
      if (Number.isSafeInteger(sequence)) updateSequence = Math.max(updateSequence, sequence);
    }
    trimJobHistory();
    if (repairedInterruptedJob) persistJobHistory(true);
  }

  function restoreJobHistoryRecord(record) {
    if (!record || typeof record !== "object") return null;
    const id = String(record.id || "").trim();
    if (!/^manga-update-\d+-\d+$/u.test(id)) return null;
    const cacheDirectory = String(record.cacheDirectory || "").trim();
    if (!cacheDirectory || path.basename(cacheDirectory) !== cacheDirectory || !isMangaCacheDirName(cacheDirectory)) return null;
    const cacheDir = safeChildPath(resolvedRoot, cacheDirectory);
    if (!cacheDir || path.dirname(cacheDir) !== resolvedRoot) return null;
    const sourceUrl = validPersistedSourceUrl(record.sourceUrl);
    if (!sourceUrl) return null;
    const status = ["running", "complete", "failed"].includes(String(record.status || "")) ? String(record.status) : "failed";
    const startedAt = validIsoTime(record.startedAt);
    if (!startedAt) return null;
    const finishedAt = validIsoTime(record.finishedAt) || "";
    return {
      id,
      kind: record.kind === "add" ? "add" : "update",
      comicId: stableMangaId(sourceUrl, cacheDir),
      cacheDir,
      sourceUrl,
      status,
      startedAt,
      finishedAt,
      totalChapters: optionalHistoryCount(record.totalChapters),
      cachedChapters: optionalHistoryCount(record.cachedChapters),
      pendingChapters: optionalHistoryCount(record.pendingChapters),
      processed: historyIndexSet(record.processed),
      completed: historyIndexSet(record.completed),
      failed: historyIndexSet(record.failed),
      currentChapterIndex: optionalHistoryCount(record.currentChapterIndex),
      currentChapterTitle: boundedHistoryText(record.currentChapterTitle, 300),
      completedImages: historyCount(record.completedImages),
      totalImages: historyCount(record.totalImages),
      downloadedImages: historyCount(record.downloadedImages),
      failedImages: historyCount(record.failedImages),
      downloadedBytes: historyCount(record.downloadedBytes),
      progressPercent: Math.max(0, Math.min(100, Number(record.progressPercent || 0))),
      exitCode: Number.isInteger(record.exitCode) ? record.exitCode : null,
      error: boundedHistoryText(record.error, 1200),
      message: boundedHistoryText(record.message, 1200),
      log: [],
      buffers: { stdout: "", stderr: "" }
    };
  }

  function persistedJobRecord(job) {
    const cacheDir = path.resolve(String(job?.cacheDir || ""));
    if (path.dirname(cacheDir) !== resolvedRoot || !isMangaCacheDirName(path.basename(cacheDir))) return null;
    return {
      id: job.id,
      kind: job.kind,
      cacheDirectory: path.basename(cacheDir),
      sourceUrl: job.sourceUrl,
      status: job.status,
      startedAt: job.startedAt,
      finishedAt: job.finishedAt || "",
      totalChapters: job.totalChapters,
      cachedChapters: job.cachedChapters,
      pendingChapters: job.pendingChapters,
      processed: [...job.processed],
      completed: [...job.completed],
      failed: [...job.failed],
      currentChapterIndex: job.currentChapterIndex,
      currentChapterTitle: job.currentChapterTitle,
      completedImages: job.completedImages,
      totalImages: job.totalImages,
      downloadedImages: job.downloadedImages,
      failedImages: job.failedImages,
      downloadedBytes: job.downloadedBytes,
      progressPercent: updateProgressPercent(job),
      exitCode: job.exitCode,
      error: job.error || "",
      message: job.message || ""
    };
  }

  function persistJobHistory(force = false) {
    const now = Date.now();
    if (!force && now - lastJobHistorySave < 1000) return false;
    if (!safeStat(resolvedRoot)?.isDirectory()) return false;
    trimJobHistory();
    const jobs = [...jobsById.values()]
      .sort((a, b) => String(b.startedAt || "").localeCompare(String(a.startedAt || "")))
      .slice(0, MAX_MANGA_JOB_HISTORY)
      .map(persistedJobRecord)
      .filter(Boolean);
    const tempPath = `${jobHistoryPath}.tmp-${process.pid}-${now}`;
    try {
      fs.writeFileSync(tempPath, `${JSON.stringify({
        schemaVersion: MANGA_JOB_HISTORY_SCHEMA_VERSION,
        updatedAt: new Date(now).toISOString(),
        jobs
      }, null, 2)}\n`, "utf8");
      fs.renameSync(tempPath, jobHistoryPath);
      lastJobHistorySave = now;
      return true;
    } catch {
      try { fs.rmSync(tempPath, { force: true }); } catch {}
      return false;
    }
  }

  function trimJobHistory() {
    const ordered = [...jobsById.values()]
      .sort((a, b) => String(b.startedAt || "").localeCompare(String(a.startedAt || "")));
    for (const job of ordered.slice(MAX_MANGA_JOB_HISTORY)) {
      if (job.status === "running") continue;
      jobsById.delete(job.id);
      const cacheKey = databaseKey(job.cacheDir);
      if (updateJobs.get(cacheKey) === job) updateJobs.delete(cacheKey);
    }
  }

  function validPersistedSourceUrl(value) {
    try {
      const parsed = new URL(String(value || "").trim());
      return /^https?:$/.test(parsed.protocol) ? parsed.toString() : "";
    } catch {
      return "";
    }
  }

  function validIsoTime(value) {
    const text = String(value || "").trim();
    return text && Number.isFinite(Date.parse(text)) ? new Date(text).toISOString() : "";
  }

  function boundedHistoryText(value, limit) {
    return String(value || "").trim().slice(0, limit);
  }

  function historyCount(value) {
    const number = Number(value || 0);
    return Number.isFinite(number) ? Math.max(0, Math.trunc(number)) : 0;
  }

  function optionalHistoryCount(value) {
    return value === null || value === undefined ? null : historyCount(value);
  }

  function historyIndexSet(value) {
    return new Set((Array.isArray(value) ? value : [])
      .slice(0, 10000)
      .map(historyCount)
      .filter((index) => index > 0));
  }

  function publicUpdateJob(job) {
    if (!job) return { status: "idle" };
    const presentation = jobPresentation(job);
    return {
      id: job.id,
      kind: job.kind,
      comicId: job.comicId,
      comicAvailable: presentation.comicAvailable,
      title: presentation.title,
      site: presentation.site,
      sourceUrl: job.sourceUrl,
      coverUrl: presentation.coverUrl,
      status: job.status,
      startedAt: job.startedAt,
      finishedAt: job.finishedAt || "",
      totalChapters: job.totalChapters,
      cachedChapters: job.cachedChapters,
      pendingChapters: job.pendingChapters,
      processedChapters: job.processed.size,
      completedChapters: job.completed.size,
      failedChapters: job.failed.size,
      currentChapterIndex: job.currentChapterIndex,
      currentChapterTitle: job.currentChapterTitle,
      completedImages: job.completedImages,
      totalImages: job.totalImages,
      downloadedImages: job.downloadedImages,
      failedImages: job.failedImages,
      downloadedBytes: job.downloadedBytes,
      progressPercent: updateProgressPercent(job),
      exitCode: job.exitCode,
      message: job.message || ""
    };
  }

  function jobPresentation(job) {
    let source = null;
    try { source = new URL(String(job?.sourceUrl || "")); } catch {}
    const site = source?.hostname?.toLowerCase().replace(/^www\./, "") || mangaSiteFromDirName(path.basename(job?.cacheDir || ""));
    const sourceKey = source?.pathname?.split("/").filter(Boolean).pop()?.replace(/\.html$/i, "") || "";
    const fallbackTitle = [site, sourceKey ? `#${sourceKey}` : ""].filter(Boolean).join(" ") || "漫画任务";
    if (!job?.cacheDir || !safeStat(job.cacheDir)?.isDirectory()) {
      return { comicAvailable: false, title: fallbackTitle, site, coverUrl: "" };
    }
    try {
      const comic = publicSummary(job.cacheDir);
      return {
        comicAvailable: true,
        title: comic.title || fallbackTitle,
        site: comic.site || site,
        coverUrl: comic.coverUrl || ""
      };
    } catch {
      return { comicAvailable: true, title: fallbackTitle, site, coverUrl: "" };
    }
  }

  function updateProgressPercent(job) {
    if (job.status === "complete") return 100;
    if (job.status === "failed") return Math.max(0, Number(job.progressPercent || 0));
    if (job.pendingChapters == null) return 3;
    if (job.pendingChapters === 0) return 92;
    const currentChapterAlreadyCompleted = Boolean(
      job.currentChapterIndex && job.completed.has(job.currentChapterIndex)
    );
    const imageRatio = !currentChapterAlreadyCompleted && job.totalImages > 0
      ? Math.min(1, job.completedImages / job.totalImages)
      : 0;
    return Math.max(5, Math.min(99, Math.floor(
      ((job.completed.size + imageRatio) / job.pendingChapters) * 100
    )));
  }

  function updateJobMessage(job) {
    if (job.status === "failed") return job.error || "漫画更新失败";
    if (job.status === "complete") {
      if (job.pendingChapters === 0) return "已是最新，没有新增章节";
      if (job.failed.size) return `更新完成，${job.failed.size} 个章节失败`;
      return `更新完成，共处理 ${job.pendingChapters ?? job.processed.size} 个章节`;
    }
    if (job.pendingChapters == null) return "正在读取远程目录";
    if (job.pendingChapters === 0) return "正在确认本地索引";
    const chapterPosition = Math.min(job.pendingChapters, job.completed.size + 1);
    if (job.totalImages > 0) {
      return `正在更新第 ${chapterPosition}/${job.pendingChapters} 章 · 图片 ${job.completedImages}/${job.totalImages}`;
    }
    return `正在更新章节 ${chapterPosition}/${job.pendingChapters}`;
  }

  function consumeStructuredProgress(job, payload) {
    const event = String(payload?.event || "");
    if (event === "catalog") {
      job.totalChapters = Number(payload.totalChapters || 0);
      job.cachedChapters = Number(payload.cachedChapters || 0);
      job.pendingChapters = Number(payload.pendingChapters || 0);
    } else if (event === "chapter-start") {
      const index = Number(payload.chapterIndex || 0);
      if (index) job.processed.add(index);
      job.currentChapterIndex = index || null;
      job.currentChapterTitle = String(payload.chapterTitle || "");
      job.completedImages = 0;
      job.totalImages = 0;
      job.downloadedImages = 0;
      job.failedImages = 0;
      job.downloadedBytes = 0;
    } else if (event === "chapter-images") {
      job.currentChapterIndex = Number(payload.chapterIndex || job.currentChapterIndex || 0) || null;
      job.currentChapterTitle = String(payload.chapterTitle || job.currentChapterTitle || "");
      job.totalImages = Number(payload.totalImages || 0);
    } else if (event === "image-progress") {
      job.completedImages = Number(payload.completedImages || 0);
      job.totalImages = Number(payload.totalImages || job.totalImages || 0);
      job.downloadedImages = Number(payload.downloadedImages || 0);
      job.failedImages = Number(payload.failedImages || 0);
      job.downloadedBytes = Number(payload.downloadedBytes || 0);
    } else if (event === "chapter-complete") {
      const index = Number(payload.chapterIndex || 0);
      if (index) {
        job.processed.add(index);
        job.completed.add(index);
      }
      if (String(payload.status || "") === "failed") job.failed.add(index);
      job.downloadedImages = Number(payload.downloadedImages || job.downloadedImages || 0);
      job.failedImages = Number(payload.failedImages || job.failedImages || 0);
    }
    job.progressPercent = updateProgressPercent(job);
  }

  function consumeUpdateLine(job, line) {
    const value = String(line || "").trim();
    if (!value) return;
    if (value.startsWith("MANGA_PROGRESS ")) {
      let progressEvent = "";
      try {
        const payload = JSON.parse(value.slice("MANGA_PROGRESS ".length));
        progressEvent = String(payload?.event || "");
        consumeStructuredProgress(job, payload);
      } catch {
        // Keep the human-readable collector output as a compatibility fallback.
      }
      job.message = updateJobMessage(job);
      persistJobHistory(progressEvent !== "image-progress");
      return;
    }
    job.log.push(value);
    if (job.log.length > 30) job.log.splice(0, job.log.length - 30);
    let match = /^Chapters:\s*(\d+)/i.exec(value);
    if (match) job.totalChapters = Number(match[1]);
    match = /^Cached complete:\s*(\d+)/i.exec(value);
    if (match) job.cachedChapters = Number(match[1]);
    match = /^Need update:\s*(\d+)/i.exec(value);
    if (match) job.pendingChapters = Number(match[1]);
    match = /^\[(\d+)\]\s+(?:Fetch page|skipped by robots|failed:)/i.exec(value);
    if (match) job.processed.add(Number(match[1]));
    match = /^\[(\d+)\]\s+failed:/i.exec(value);
    if (match) job.failed.add(Number(match[1]));
    job.message = updateJobMessage(job);
    persistJobHistory();
  }

  function connectUpdateOutput(job, stream, key) {
    if (!stream?.on) return;
    stream.setEncoding?.("utf8");
    stream.on("data", (chunk) => {
      const lines = `${job.buffers[key]}${String(chunk || "")}`.split(/\r?\n/);
      job.buffers[key] = lines.pop() || "";
      lines.forEach((line) => consumeUpdateLine(job, line));
    });
  }

  function finishUpdateJob(job, exitCode, error = null) {
    if (job.finishedAt) return;
    for (const key of ["stdout", "stderr"]) {
      if (job.buffers[key]) consumeUpdateLine(job, job.buffers[key]);
      job.buffers[key] = "";
    }
    job.exitCode = Number.isInteger(exitCode) ? exitCode : null;
    job.finishedAt = new Date().toISOString();
    if (error || job.exitCode !== 0) {
      job.status = "failed";
      job.error = String(error?.message || `采集器退出代码 ${job.exitCode ?? "未知"}`);
    } else {
      job.status = "complete";
    }
    job.message = updateJobMessage(job);
    directoryLookup = null;
    persistJobHistory(true);
  }

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
    const catalogUrl = String(dbComic?.source_url || readJsonFile(path.join(cacheDir, "catalog.json"), {})?.url || "").trim();
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

  function scanStorageTree(directory) {
    const resolvedDirectory = path.resolve(directory);
    const result = { bytes: 0, fileCount: 0 };
    if (!safeStat(resolvedDirectory)?.isDirectory()) return result;
    const pending = [resolvedDirectory];
    while (pending.length) {
      const current = pending.pop();
      let entries = [];
      try {
        entries = fs.readdirSync(current, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (entry.isSymbolicLink()) continue;
        const entryPath = path.join(current, entry.name);
        if (entry.isDirectory()) {
          pending.push(entryPath);
          continue;
        }
        if (!entry.isFile()) continue;
        const stat = safeStat(entryPath);
        if (!stat?.isFile()) continue;
        result.fileCount += 1;
        result.bytes += Math.max(0, Number(stat.size || 0));
      }
    }
    return result;
  }

  function trashEntries() {
    const status = rootStatus();
    const trashRoot = safeChildPath(status.root, ".trash");
    if (!status.exists || !trashRoot || !safeStat(trashRoot)?.isDirectory()) return [];
    let entries = [];
    try {
      entries = fs.readdirSync(trashRoot, { withFileTypes: true });
    } catch {
      return [];
    }
    return entries.filter((entry) => entry.isDirectory() && !entry.isSymbolicLink()).map((entry) => {
      const entryPath = safeChildPath(trashRoot, entry.name);
      if (!entryPath) return null;
      const metadata = readJsonFile(path.join(entryPath, "deleted.json"), {});
      const usage = scanStorageTree(entryPath);
      return {
        name: entry.name,
        title: String(metadata.title || metadata.originalDirectory || entry.name).trim(),
        deletedAt: String(metadata.deletedAt || "").trim(),
        bytes: usage.bytes,
        fileCount: usage.fileCount
      };
    }).filter(Boolean).sort((left, right) => String(right.deletedAt).localeCompare(String(left.deletedAt)));
  }

  function storageStatus(force = false) {
    const now = Date.now();
    if (!force && storageSnapshot && now - storageSnapshot.cachedAt < 15000) return storageSnapshot.payload;
    const status = rootStatus();
    const directories = cacheDirs();
    const summaries = directories.map(publicSummary);
    const trashItems = trashEntries();
    const trash = trashItems.reduce((total, item) => {
      total.bytes += item.bytes;
      total.fileCount += item.fileCount;
      return total;
    }, { itemCount: trashItems.length, bytes: 0, fileCount: 0, items: trashItems.slice(0, 8) });
    const rootUsage = status.exists ? scanStorageTree(status.root) : { bytes: 0, fileCount: 0 };
    const libraryBytes = Math.max(0, rootUsage.bytes - trash.bytes);
    const libraryFiles = Math.max(0, rootUsage.fileCount - trash.fileCount);
    let diskFreeBytes = 0;
    try {
      const disk = status.exists && typeof fs.statfsSync === "function" ? fs.statfsSync(status.root) : null;
      diskFreeBytes = disk ? Number(disk.bavail || 0) * Number(disk.bsize || 0) : 0;
    } catch {}
    const payload = {
      root: status.root,
      exists: status.exists,
      scannedAt: new Date(now).toISOString(),
      comicCount: summaries.length,
      chapterCount: summaries.reduce((sum, comic) => sum + Number(comic.chapterCount || 0), 0),
      imageCount: summaries.reduce((sum, comic) => sum + Number(comic.imageCount || 0), 0),
      downloadedCount: summaries.reduce((sum, comic) => sum + Number(comic.downloadedCount || 0), 0),
      failedCount: summaries.reduce((sum, comic) => sum + Number(comic.failedCount || 0), 0),
      bytes: libraryBytes,
      fileCount: libraryFiles,
      totalBytes: rootUsage.bytes,
      diskFreeBytes,
      trash
    };
    storageSnapshot = { cachedAt: now, payload };
    return payload;
  }

  function purgeTrash() {
    const status = rootStatus();
    const trashRoot = safeChildPath(status.root, ".trash");
    if (!status.exists || !trashRoot || !safeStat(trashRoot)?.isDirectory()) {
      storageSnapshot = null;
      return { ok: true, removedCount: 0, removedBytes: 0, storage: storageStatus(true) };
    }
    const entries = trashEntries();
    let removedCount = 0;
    let removedBytes = 0;
    for (const entry of entries) {
      const target = safeChildPath(trashRoot, entry.name);
      if (!target || path.dirname(target) !== path.resolve(trashRoot) || !safeStat(target)?.isDirectory()) continue;
      fs.rmSync(target, { recursive: true, force: false, maxRetries: 2, retryDelay: 100 });
      removedCount += 1;
      removedBytes += entry.bytes;
    }
    storageSnapshot = null;
    return { ok: true, removedCount, removedBytes, storage: storageStatus(true) };
  }

  function directoryLookupStamp() {
    const stat = safeStat(resolvedRoot);
    return JSON.stringify([
      stat?.isDirectory() ? [stat.dev, stat.ino, stat.birthtimeMs, stat.ctimeMs, stat.mtimeMs] : null,
      database.lookupStamp()
    ]);
  }

  function listRevision() {
    return createHash("sha256").update(directoryLookupStamp()).digest("hex");
  }

  function buildDirectoryLookup(stamp = directoryLookupStamp()) {
    const lookup = { stamp, byId: new Map(), dirs: [], reusable: false };
    directoryLookup = lookup;
    if (!rootStatus().exists) return lookup;

    let entries = [];
    try {
      entries = fs.readdirSync(resolvedRoot, { withFileTypes: true });
    } catch {
      return lookup;
    }

    const directories = entries
      .filter((entry) => entry.isDirectory() && isMangaCacheDirName(entry.name))
      .map((entry) => path.join(resolvedRoot, entry.name))
      .sort((a, b) => path.basename(a).localeCompare(path.basename(b), undefined, { numeric: true, sensitivity: "base" }));
    const candidates = directories.filter(dirPath => fs.existsSync(path.join(dirPath, "manifest.json")));
    const rows = database.comics();
    const comicsByKey = new Map();
    for (const row of rows || []) {
      const key = String(row.cache_key || "");
      // Keep comic().get()'s first-row behavior for legacy duplicate keys.
      if (!comicsByKey.has(key)) comicsByKey.set(key, row);
    }
    let sqlSourcesOnly = rows !== null;
    const records = candidates.map(dirPath => {
      const key = databaseKey(dirPath);
      const dbComic = rows === null ? database.comic(key) : comicsByKey.get(key);
      if (!String(dbComic?.source_url || "").trim()) sqlSourcesOnly = false;
      return { dirPath, sourceUrl: sourceUrlForCache(dirPath, dbComic), downloadedCount: Number(dbComic?.downloaded_count || 0) };
    });

    // A failed/restarted crawl can leave two cache folders for the same
    // catalog (for example the old zero-image folder and a later *_full
    // folder). Prefer the copy with more downloaded images so the library
    // does not show duplicate comics.
    const bestBySource = new Map();
    for (const { dirPath, sourceUrl, downloadedCount } of records) {
      if (!sourceUrl) continue;
      const current = bestBySource.get(sourceUrl);
      if (!current || downloadedCount > current.downloadedCount) {
        bestBySource.set(sourceUrl, { dirPath, downloadedCount });
      }
    }
    for (const { dirPath, sourceUrl } of records) {
      if (sourceUrl && bestBySource.get(sourceUrl)?.dirPath !== dirPath) continue;
      lookup.dirs.push(dirPath);
      for (const id of [stableMangaId(sourceUrl, dirPath), createId("mg", path.resolve(dirPath))]) {
        if (!lookup.byId.has(id)) lookup.byId.set(id, dirPath);
      }
    }
    // File-derived identities can change without updating the root directory.
    // Pending folders can likewise acquire a manifest in place. Rebuild those
    // libraries on every lookup so these changes remain immediately visible.
    lookup.reusable = sqlSourcesOnly && candidates.length === directories.length;
    return lookup;
  }

  function cacheDirs() {
    return buildDirectoryLookup().dirs.slice();
  }

  function idForDir(dirPath) {
    const dbComic = database.comic(databaseKey(dirPath));
    return stableMangaId(sourceUrlForCache(dirPath, dbComic), dirPath);
  }

  function cacheById(id) {
    const targetId = String(id || "");
    if (!targetId) return null;
    const stamp = directoryLookupStamp();
    const reused = directoryLookup?.reusable && directoryLookup.stamp === stamp;
    let lookup = reused ? directoryLookup : buildDirectoryLookup(stamp);
    let dirPath = lookup.byId.get(targetId);
    if (dirPath && safeStat(dirPath)?.isDirectory() && fs.existsSync(path.join(dirPath, "manifest.json"))) return dirPath;
    if (reused) {
      // No negative caching, and a removed winner must expose its next copy.
      lookup = buildDirectoryLookup();
      dirPath = lookup.byId.get(targetId);
      if (dirPath && safeStat(dirPath)?.isDirectory() && fs.existsSync(path.join(dirPath, "manifest.json"))) return dirPath;
    }
    return null;
  }

  function updateStatus(id) {
    const cacheDir = cacheById(id);
    if (!cacheDir) return null;
    return publicUpdateJob(updateJobs.get(databaseKey(cacheDir)));
  }

  function jobStatus(jobId) {
    const job = jobsById.get(String(jobId || ""));
    return job ? publicUpdateJob(job) : null;
  }

  function listJobs(limit = 12) {
    const safeLimit = Math.max(1, Math.min(50, Number(limit) || 12));
    return [...jobsById.values()]
      .sort((a, b) => {
        const runningDelta = Number(b.status === "running") - Number(a.status === "running");
        if (runningDelta) return runningDelta;
        return String(b.startedAt || "").localeCompare(String(a.startedAt || ""));
      })
      .slice(0, safeLimit)
      .map(publicUpdateJob);
  }

  function clearFinishedJobs() {
    let removedCount = 0;
    for (const [jobId, job] of jobsById) {
      if (job.status === "running") continue;
      jobsById.delete(jobId);
      const cacheKey = databaseKey(job.cacheDir);
      if (updateJobs.get(cacheKey) === job) updateJobs.delete(cacheKey);
      removedCount += 1;
    }
    persistJobHistory(true);
    const runningCount = [...jobsById.values()].filter((job) => job.status === "running").length;
    return {
      ok: true,
      removedCount,
      remainingCount: jobsById.size,
      runningCount
    };
  }

  function retryJob(jobId) {
    const previous = jobsById.get(String(jobId || ""));
    if (!previous) throw updateError("没有找到这条漫画任务", 404);
    if (previous.status === "running") {
      return { started: false, job: publicUpdateJob(previous) };
    }
    if (previous.status !== "failed") {
      throw updateError("只有失败的漫画任务可以重试", 409);
    }
    if (previous.kind === "update" && !cacheById(previous.comicId)) {
      throw updateError("这本漫画已不在资料库，不能继续更新", 409);
    }
    return startCollectorJob({
      cacheDir: previous.cacheDir,
      sourceUrl: previous.sourceUrl,
      kind: previous.kind,
      recordSource: previous.kind === "add"
    });
  }

  function parseCatalogSource(value) {
    let parsed;
    try {
      parsed = new URL(String(value || "").trim());
    } catch {
      throw updateError("请输入有效的漫画作品链接");
    }
    if (!/^https?:$/.test(parsed.protocol)) throw updateError("只支持 HTTP 或 HTTPS 漫画链接");
    const host = parsed.hostname.toLowerCase().replace(/^www\./, "");
    const pathname = parsed.pathname.replace(/\/+$/, "");
    let site = "";
    let comicKey = "";
    let catalogPath = "";
    if (host === "smtt6.com") {
      comicKey = /^\/man-hua-yue-du\/([^/.]+)(?:\.html)?$/i.exec(pathname)?.[1] || "";
      site = "smtt6";
      catalogPath = comicKey ? `/man-hua-yue-du/${comicKey}.html` : "";
    } else if (host === "jmd9.com" || host === "91jmd.com") {
      comicKey = /^\/manga\/([^/]+)$/i.exec(pathname)?.[1] || "";
      site = "jmd9";
      catalogPath = comicKey ? `/manga/${comicKey}` : "";
    } else if (host === "55comic.com") {
      comicKey = /^\/book\/([^/]+)$/i.exec(pathname)?.[1] || "";
      site = "55comic";
      catalogPath = comicKey ? `/book/${comicKey}` : "";
    }
    if (!comicKey || !catalogPath) {
      throw updateError("目前只支持 smtt6、jmd9/91jmd 和 55comic 的作品详情链接");
    }
    const sourceUrl = `${parsed.protocol}//${parsed.host}${catalogPath}`;
    return {
      site,
      comicKey,
      sourceUrl,
      cacheDir: path.join(path.resolve(root), `${site}_cache_${comicKey}`)
    };
  }

  function startCollectorJob({ cacheDir, sourceUrl, kind = "update", recordSource = false }) {
    const cacheKey = databaseKey(cacheDir);
    const current = updateJobs.get(cacheKey);
    if (current?.status === "running") {
      return { started: false, job: publicUpdateJob(current) };
    }
    if (!/^https?:\/\//i.test(sourceUrl)) {
      throw updateError("这本漫画没有可用的采集来源地址", 409);
    }
    const collectorPath = path.resolve(projectRoot, "tools", "manga_collector.py");
    if (!fs.existsSync(collectorPath)) {
      throw updateError("漫画采集器不存在", 503);
    }

    const job = {
      id: `manga-update-${Date.now()}-${++updateSequence}`,
      kind,
      comicId: stableMangaId(sourceUrl, cacheDir),
      cacheDir,
      sourceUrl,
      status: "running",
      startedAt: new Date().toISOString(),
      finishedAt: "",
      totalChapters: null,
      cachedChapters: null,
      pendingChapters: null,
      processed: new Set(),
      completed: new Set(),
      failed: new Set(),
      currentChapterIndex: null,
      currentChapterTitle: "",
      completedImages: 0,
      totalImages: 0,
      downloadedImages: 0,
      failedImages: 0,
      downloadedBytes: 0,
      progressPercent: 0,
      exitCode: null,
      error: "",
      message: "正在启动增量更新",
      log: [],
      buffers: { stdout: "", stderr: "" }
    };
    updateJobs.set(cacheKey, job);
    jobsById.set(job.id, job);
    trimJobHistory();
    persistJobHistory(true);

    const args = [
      collectorPath,
      sourceUrl,
      "--out",
      cacheDir,
      "--database",
      resolvedDatabasePath
    ];
    if (recordSource) {
      args.push("--sources-file", path.join(path.resolve(root), "smtt6_sources.txt"));
    } else {
      args.push("--no-record-source");
    }
    let child;
    try {
      child = spawnProcess(pythonPath, args, {
        cwd: path.resolve(projectRoot),
        env: {
          ...process.env,
          FANHAO_MANGA_ROOT: path.resolve(root),
          PYTHONUTF8: "1"
        },
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true
      });
    } catch (error) {
      finishUpdateJob(job, null, error);
      return { started: true, job: publicUpdateJob(job) };
    }
    connectUpdateOutput(job, child.stdout, "stdout");
    connectUpdateOutput(job, child.stderr, "stderr");
    child.once?.("error", (error) => finishUpdateJob(job, null, error));
    child.once?.("close", (code) => finishUpdateJob(job, code));
    return { started: true, job: publicUpdateJob(job) };
  }

  function startUpdate(id) {
    const cacheDir = cacheById(id);
    if (!cacheDir) throw updateError("没有找到这本漫画", 404);
    const cacheKey = databaseKey(cacheDir);
    const sourceUrl = sourceUrlForCache(cacheDir, database.comic(cacheKey));
    return startCollectorJob({ cacheDir, sourceUrl, kind: "update" });
  }

  function startAdd(value) {
    const source = parseCatalogSource(value);
    const existingCache = cacheDirs().find((cacheDir) => (
      sourceIdentity(sourceUrlForCache(cacheDir, database.comic(databaseKey(cacheDir))))
      === sourceIdentity(source.sourceUrl)
    ));
    if (existingCache) {
      const result = startCollectorJob({
        cacheDir: existingCache,
        sourceUrl: source.sourceUrl,
        kind: "update"
      });
      return { ...result, existing: true };
    }
    const result = startCollectorJob({
      cacheDir: source.cacheDir,
      sourceUrl: source.sourceUrl,
      kind: "add",
      recordSource: true
    });
    return { ...result, existing: false };
  }

  function sourceIdentity(value) {
    try {
      const parsed = new URL(String(value || "").trim());
      parsed.hostname = parsed.hostname.toLowerCase().replace(/^www\./, "");
      if (parsed.hostname === "91jmd.com") parsed.hostname = "jmd9.com";
      parsed.hash = "";
      parsed.search = "";
      parsed.pathname = parsed.pathname.replace(/\/+$/, "") || "/";
      return parsed.toString();
    } catch {
      return String(value || "").trim();
    }
  }

  function removeTrackedSource(sourceUrl) {
    const sourcesPath = path.join(path.resolve(root), "smtt6_sources.txt");
    if (!sourceUrl || !fs.existsSync(sourcesPath)) return false;
    const original = fs.readFileSync(sourcesPath, "utf8");
    const newline = original.includes("\r\n") ? "\r\n" : "\n";
    const hadFinalNewline = /\r?\n$/.test(original);
    const target = sourceIdentity(sourceUrl);
    let removed = false;
    const kept = original.split(/\r?\n/).filter((line, index, lines) => {
      if (index === lines.length - 1 && !line && hadFinalNewline) return false;
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) return true;
      const trackedUrl = trimmed.split("|", 1)[0].trim();
      if (sourceIdentity(trackedUrl) !== target) return true;
      removed = true;
      return false;
    });
    if (removed) {
      fs.writeFileSync(
        sourcesPath,
        `${kept.join(newline)}${hadFinalNewline ? newline : ""}`,
        "utf8"
      );
    }
    return removed;
  }

  function addTrackedSource(sourceUrl) {
    const normalizedUrl = String(sourceUrl || "").trim();
    if (!normalizedUrl) return false;
    const sourcesPath = path.join(path.resolve(root), "smtt6_sources.txt");
    let original = "";
    try { original = fs.readFileSync(sourcesPath, "utf8"); } catch {}
    const target = sourceIdentity(normalizedUrl);
    const tracked = original.split(/\r?\n/).some((line) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) return false;
      return sourceIdentity(trimmed.split("|", 1)[0].trim()) === target;
    });
    if (tracked) return false;
    const newline = original.includes("\r\n") ? "\r\n" : "\n";
    const prefix = original && !/\r?\n$/.test(original) ? newline : "";
    fs.appendFileSync(sourcesPath, `${prefix}${normalizedUrl}${newline}`, "utf8");
    return true;
  }

  function trashComic(id) {
    const cacheDir = cacheById(id);
    if (!cacheDir) throw updateError("没有找到这本漫画", 404);
    const cacheKey = databaseKey(cacheDir);
    if (updateJobs.get(cacheKey)?.status === "running") {
      throw updateError("这本漫画正在更新，请等待更新结束后再删除", 409);
    }

    const resolvedRoot = path.resolve(root);
    const relative = path.relative(resolvedRoot, cacheDir);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
      throw updateError("漫画目录不在允许删除的资料库中", 400);
    }
    const comic = publicSummary(cacheDir);
    const trashRoot = path.join(resolvedRoot, ".trash");
    fs.mkdirSync(trashRoot, { recursive: true });
    const suffix = new Date().toISOString().replace(/[-:.TZ]/g, "");
    let trashName = `${path.basename(cacheDir)}__${suffix}`;
    let trashPath = path.join(trashRoot, trashName);
    for (let counter = 2; fs.existsSync(trashPath); counter += 1) {
      trashName = `${path.basename(cacheDir)}__${suffix}_${counter}`;
      trashPath = path.join(trashRoot, trashName);
    }
    fs.renameSync(cacheDir, trashPath);
    directoryLookup = null;
    storageSnapshot = null;

    const deletedAt = new Date().toISOString();
    try {
      fs.writeFileSync(path.join(trashPath, "deleted.json"), JSON.stringify({
        id: comic.id,
        title: comic.title,
        sourceUrl: comic.sourceUrl,
        originalDirectory: path.basename(cacheDir),
        deletedAt
      }, null, 2), "utf8");
    } catch {
      // The directory has already been moved safely; metadata is best effort.
    }
    const sourceRemoved = removeTrackedSource(comic.sourceUrl);
    updateJobs.delete(cacheKey);
    return {
      ok: true,
      deleted: true,
      recoverable: true,
      sourceRemoved,
      deletedAt,
      trashName,
      comic: { id: comic.id, title: comic.title }
    };
  }

  function restoreTrashEntry(name) {
    const status = rootStatus();
    const trashRoot = safeChildPath(status.root, ".trash");
    const entryName = String(name || "").trim();
    if (!status.exists || !trashRoot || !entryName || path.basename(entryName) !== entryName) {
      throw updateError("回收站项目无效", 400);
    }
    const entryPath = safeChildPath(trashRoot, entryName);
    if (!entryPath || path.dirname(entryPath) !== path.resolve(trashRoot) || !safeStat(entryPath)?.isDirectory()) {
      throw updateError("没有找到这项回收内容", 404);
    }
    const metadata = readJsonFile(path.join(entryPath, "deleted.json"), {});
    const originalDirectory = String(metadata.originalDirectory || "").trim();
    if (!isMangaCacheDirName(originalDirectory) || !fs.existsSync(path.join(entryPath, "manifest.json"))) {
      throw updateError("回收内容缺少有效的漫画资料", 400);
    }
    const sourceUrl = String(metadata.sourceUrl || "").trim();
    if (sourceUrl) {
      const duplicate = cacheDirs().find((cacheDir) => sourceIdentity(publicSummary(cacheDir).sourceUrl) === sourceIdentity(sourceUrl));
      if (duplicate) throw updateError("资料库中已经存在同源漫画", 409);
    }
    const targetPath = safeChildPath(status.root, originalDirectory);
    if (!targetPath || path.dirname(targetPath) !== path.resolve(status.root)) {
      throw updateError("原漫画目录无效", 400);
    }
    if (fs.existsSync(targetPath)) throw updateError("原漫画目录已经存在，无法覆盖恢复", 409);
    fs.renameSync(entryPath, targetPath);
    directoryLookup = null;
    try { fs.unlinkSync(path.join(targetPath, "deleted.json")); } catch {}
    const sourceTracked = addTrackedSource(sourceUrl);
    storageSnapshot = null;
    return {
      ok: true,
      restored: true,
      sourceTracked,
      comic: publicSummary(targetPath),
      storage: storageStatus(true)
    };
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
    const metadata = metadataForCache(cacheDir, dbComic);
    const dbCover = dbComic ? database.firstImage(databaseKey(cacheDir)) : null;
    if (dbComic) {
      return {
        id,
        title: cleanComicTitle(dbComic.title, dirName),
        dirName,
        site: String(dbComic.site || mangaSiteFromDirName(dirName)),
        sourceUrl: sourceUrlForCache(cacheDir, dbComic),
        author: metadata.author,
        description: metadata.description,
        status: metadata.status,
        region: metadata.region,
        category: metadata.category,
        tags: metadata.tags,
        updatedAt: String(dbComic.updated_at || dbComic.last_sync_at || "").trim(),
        chapterCount: Number(dbComic.chapter_count || 0),
        doneChapterCount: Number(dbComic.done_chapter_count || 0),
        imageCount: Number(dbComic.image_count || 0),
        downloadedCount: Number(dbComic.downloaded_count || 0),
        failedCount: Number(dbComic.failed_count || 0),
        coverUrl: metadata.localCover
          ? `/media/manga-cover/${encodeURIComponent(id)}`
          : metadata.coverUrl || (dbCover
          ? imageUrl(id, Number(dbCover.chapter_index || 1), Number(dbCover.image_index || 1))
          : "")
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
      if (["done", "repaired"].includes(String(chapter?.status || "").toLowerCase())) doneChapterTotal += 1;
      if (!coverUrl && firstImage(chapter)) {
        coverUrl = imageUrl(id, chapterIndex(chapter, index), Number(firstImage(chapter)?.index || 1));
      }
    }

    return {
      id,
      title: cleanComicTitle(catalog.title, dirName),
      dirName,
      site: mangaSiteFromDirName(dirName),
      sourceUrl: String(catalog.url || "").trim(),
      author: metadata.author,
      description: metadata.description,
      status: metadata.status,
      region: metadata.region,
      category: metadata.category,
      tags: metadata.tags,
      updatedAt: String(catalog.updated_at || manifest.created_at || "").trim(),
      chapterCount: chapters.length,
      doneChapterCount: doneChapterTotal,
      imageCount: imageTotal,
      downloadedCount: downloadedTotal,
      failedCount: failedTotal,
      coverUrl: metadata.localCover
        ? `/media/manga-cover/${encodeURIComponent(id)}`
        : metadata.coverUrl || coverUrl
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

  function publicChapterNavigationItem(chapter, index) {
    if (!chapter) return null;
    const resolvedChapterIndex = chapterIndex(chapter, index);
    const stats = chapterImageStats(chapter);
    return {
      index: resolvedChapterIndex,
      title: String(chapter?.title || `第 ${resolvedChapterIndex} 话`).trim(),
      status: String(chapter?.status || "").trim(),
      imageCount: stats.imageCount,
      downloadedCount: stats.downloadedCount
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
    const cacheKey = databaseKey(cacheDir);
    const manifest = found.fromDatabase ? null : readJsonFile(path.join(cacheDir, "manifest.json"), {});
    const storedChapters = found.fromDatabase
      ? database.chapters(cacheKey).map(chapterFromDatabase)
      : Array.isArray(manifest?.chapters) ? manifest.chapters : [];
    const chapterList = storedChapters.length ? storedChapters : [found.chapter];
    const chapterPosition = Math.max(0, chapterList.findIndex((chapter, index) => chapterIndex(chapter, index) === found.chapterIndex));
    const images = found.fromDatabase
      ? database.images(cacheKey, found.chapterIndex).map(imageFromDatabase)
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
        const localPath = String(image?.local_path || "");
        const dimensions = readImageDimensions(safeChildPath(cacheDir, localPath));
        return {
          index: resolvedImageIndex,
          name: path.basename(localPath) || `${String(resolvedImageIndex).padStart(3, "0")}`,
          localPath,
          contentType: String(image?.content_type || "").trim(),
          bytes: Number(image?.bytes || 0),
          status: String(image?.status || "").trim(),
          ...(dimensions || {}),
          url: imageUrl(manga.id, found.chapterIndex, resolvedImageIndex)
        };
      }),
      navigation: {
        position: chapterPosition + 1,
        total: chapterList.length,
        previous: chapterPosition > 0 ? publicChapterNavigationItem(chapterList[chapterPosition - 1], chapterPosition - 1) : null,
        next: chapterPosition >= 0 && chapterPosition + 1 < chapterList.length
          ? publicChapterNavigationItem(chapterList[chapterPosition + 1], chapterPosition + 1)
          : null
      }
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

  function resolveLocalCover(cacheDir) {
    const dbComic = database.comic(databaseKey(cacheDir));
    const metadata = metadataForCache(cacheDir, dbComic);
    if (metadata.localCover) {
      const configured = safeChildPath(cacheDir, metadata.localCover);
      if (safeStat(configured)?.isFile()) return configured;
    }
    for (const name of ["cover.webp", "cover.jpg", "cover.jpeg", "cover.png"]) {
      const candidate = path.join(cacheDir, name);
      if (safeStat(candidate)?.isFile()) return candidate;
    }
    return null;
  }

  async function serveCover(req, res, mangaId) {
    const cacheDir = cacheById(decodeURIComponent(mangaId));
    const coverPath = cacheDir ? resolveLocalCover(cacheDir) : null;
    if (!coverPath) {
      notFound(res);
      return;
    }
    const stat = safeStat(coverPath);
    res.writeHead(200, {
      "Content-Type": mimeTypes[normalizeExt(coverPath)] || "application/octet-stream",
      "Content-Length": stat.size,
      "Cache-Control": "private, max-age=86400",
      "Content-Disposition": "inline"
    });
    if (req.method === "HEAD") return res.end();
    fs.createReadStream(coverPath).pipe(res);
  }

  function zipPathSegment(value, fallback = "chapter") {
    const cleaned = String(value || "")
      .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_")
      .replace(/\s+/g, " ")
      .trim();
    return (cleaned || fallback).slice(0, 120);
  }

  function chapterDownloadRecord(cacheDir, requestedIndex) {
    const chapter = publicChapter(cacheDir, requestedIndex);
    if (!chapter) return null;
    const firstImagePath = String(chapter.images?.[0]?.localPath || "");
    const chapterDir = firstImagePath
      ? path.dirname(path.dirname(safeChildPath(cacheDir, firstImagePath) || ""))
      : "";
    const archivePath = chapterDir ? `${chapterDir}.zip` : "";
    const existingArchive = archivePath && safeStat(archivePath)?.isFile() ? archivePath : "";
    const files = (Array.isArray(chapter.images) ? chapter.images : []).map((image, index) => {
      const sourcePath = safeChildPath(cacheDir, image.localPath);
      if (!sourcePath || !safeStat(sourcePath)?.isFile()) return null;
      const extension = path.extname(sourcePath).toLowerCase();
      const imageIndex = Math.max(1, Number(image.index || index + 1));
      return {
        path: sourcePath,
        name: `${String(imageIndex).padStart(4, "0")}${extension}`
      };
    }).filter(Boolean);
    return { chapter, path: existingArchive, files };
  }

  function attachmentDisposition(fileName) {
    const name = String(fileName || "漫画.zip").replace(/[\\/\u0000-\u001f]/g, "_");
    const fallback = name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_") || "manga.zip";
    return `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(name)}`;
  }

  async function serveChapterDownload(req, res, mangaId, chapterNumber) {
    const cacheDir = cacheById(decodeURIComponent(mangaId));
    const record = cacheDir ? chapterDownloadRecord(cacheDir, decodeURIComponent(chapterNumber)) : null;
    if (!record || (!record.path && !record.files.length)) {
      notFound(res);
      return;
    }
    const comic = publicSummary(cacheDir);
    const fileName = `${comic.title} - ${record.chapter.title || `第${record.chapter.index}话`}.zip`;
    res.writeHead(200, {
      "Content-Type": "application/zip",
      ...(record.path ? { "Content-Length": safeStat(record.path).size } : {}),
      "Content-Disposition": attachmentDisposition(fileName),
      "Cache-Control": "no-store"
    });
    if (req.method === "HEAD") return res.end();
    if (record.path) {
      fs.createReadStream(record.path).pipe(res);
      return;
    }
    await streamStoredZip(res, record.files);
  }

  async function serveComicDownload(req, res, mangaId) {
    const cacheDir = cacheById(decodeURIComponent(mangaId));
    if (!cacheDir) {
      notFound(res);
      return;
    }
    const comic = publicDetail(cacheDir);
    if (!mangaWholeDownloadReady(comic)) {
      const payload = Buffer.from(JSON.stringify({
        error: "漫画尚未下载完成，整本下载将在全部章节完成后可用",
        code: "MANGA_DOWNLOAD_INCOMPLETE",
        chapterCount: Number(comic.chapterCount || 0),
        doneChapterCount: Number(comic.doneChapterCount || 0),
        failedCount: Number(comic.failedCount || 0)
      }));
      res.writeHead(409, {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Length": payload.length,
        "Cache-Control": "no-store"
      });
      if (req.method === "HEAD") return res.end();
      res.end(payload);
      return;
    }
    const chapterRecords = (comic.chapters || []).map((chapter) => chapterDownloadRecord(cacheDir, chapter.index));
    const files = chapterRecords.flatMap((record) => {
      if (!record) return [];
      const chapterFolder = `${String(record.chapter.index).padStart(4, "0")}_${zipPathSegment(record.chapter.title, `第${record.chapter.index}话`)}`;
      return record.files.map((file) => ({ ...file, name: `${chapterFolder}/${file.name}` }));
    });
    if (chapterRecords.some((record) => !record || !record.files.length) || files.length !== Number(comic.downloadedCount || 0)) {
      const payload = Buffer.from(JSON.stringify({
        error: "漫画文件不完整，请先更新修复后再下载整本",
        code: "MANGA_DOWNLOAD_FILES_MISSING",
        expectedFiles: Number(comic.downloadedCount || 0),
        availableFiles: files.length
      }));
      res.writeHead(409, {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Length": payload.length,
        "Cache-Control": "no-store"
      });
      if (req.method === "HEAD") return res.end();
      res.end(payload);
      return;
    }
    res.writeHead(200, {
      "Content-Type": "application/zip",
      "Content-Disposition": attachmentDisposition(`${comic.title}.zip`),
      "Cache-Control": "no-store"
    });
    if (req.method === "HEAD") return res.end();
    await streamStoredZip(res, files);
  }

  return {
    cacheById,
    cacheDirs,
    clearFinishedJobs,
    imageUrl,
    jobStatus,
    listJobs,
    listRevision,
    publicChapter,
    publicDetail,
    publicSummary,
    purgeTrash,
    restoreTrashEntry,
    rootStatus,
    retryJob,
    storageStatus,
    startAdd,
    startUpdate,
    trashComic,
    serveChapterDownload,
    serveComicDownload,
    serveCover,
    serveImage,
    updateStatus,
    databaseStatus: database.status
  };
}
