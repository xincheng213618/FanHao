import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { normalizeWorkCode } from "../lib/code-parser.js";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_INDEX_PATH = path.join(PROJECT_ROOT, "data", "library-index.json");
const DEFAULT_DB_PATH = path.join(PROJECT_ROOT, "data", "actor-profiles.sqlite");

const options = parseArgs(process.argv.slice(2));
const indexPath = path.resolve(options.index || DEFAULT_INDEX_PATH);
const dbPath = path.resolve(options.db || DEFAULT_DB_PATH);
const limit = positiveInteger(options.limit) ?? 20;
const jsonOutput = Boolean(options.json);

const index = readJson(indexPath);
const library = collectLibrary(index);
const db = new DatabaseSync(dbPath);
const cache = collectCache(db);
const report = buildReport(library, cache, limit);

if (jsonOutput) {
  console.log(JSON.stringify({ indexPath, dbPath, ...report }, null, 2));
} else {
  printReport(report, { indexPath, dbPath });
}

function parseArgs(args) {
  const result = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2);
    if (key === "json") {
      result[key] = true;
      continue;
    }
    const value = args[index + 1];
    if (!value || value.startsWith("--")) {
      result[key] = "";
      continue;
    }
    result[key] = value;
    index += 1;
  }
  return result;
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    throw new Error(`读取 JSON 失败: ${filePath}\n${error.message}`);
  }
}

function collectLibrary(index) {
  const people = Array.isArray(index.people) ? index.people.filter(Boolean) : [];
  const works = Array.isArray(index.works) ? index.works.filter((work) => work?.id) : [];
  const worksById = new Map(works.map((work) => [work.id, work]));
  const validWorkIds = new Set(worksById.keys());
  const validVideoIds = new Set();

  for (const work of works) {
    for (const video of work.videos || []) {
      if (video?.id) validVideoIds.add(video.id);
    }
  }

  return { people, works, worksById, validWorkIds, validVideoIds };
}

function collectCache(db) {
  const infoRows = tableExists(db, "work_info")
    ? db.prepare(
        `SELECT work_id, code, title, javdb_url, image_url, preview_images_json, preview_video_url,
                actors_json, tags_json, fields_json, status, error
           FROM work_info`
      ).all()
    : [];
  const coverRows = tableExists(db, "work_covers")
    ? db.prepare("SELECT work_id, video_id, source, cover_url, length(cover_blob) AS cover_bytes FROM work_covers").all()
    : [];

  const okInfoByWorkId = new Map();
  const errorInfoByWorkId = new Map();
  for (const row of infoRows) {
    const status = String(row.status || "").toLowerCase();
    if (status === "ok") okInfoByWorkId.set(row.work_id, row);
    if (status === "error") errorInfoByWorkId.set(row.work_id, row);
  }

  return {
    infoRows,
    coverRows,
    okInfoByWorkId,
    errorInfoByWorkId,
    cachedCoverWorkIds: new Set(coverRows.filter((row) => Number(row.cover_bytes || 0) > 0).map((row) => row.work_id))
  };
}

function tableExists(db, table) {
  return Boolean(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(table));
}

function buildReport(library, cache, limit) {
  const rows = library.works.map((work) => qualityRow(work, cache));
  const okRows = rows.filter((row) => row.hasOkInfo);
  const noOkInfoRows = rows.filter((row) => !row.hasOkInfo);
  const missingInfoSourceRows = noOkInfoRows.filter((row) => !row.hasLocalInfo && !row.hasInfoError);
  const localInfoNotImportedRows = noOkInfoRows.filter((row) => row.hasLocalInfo && !row.hasInfoError);
  const infoErrorRows = rows.filter((row) => row.hasInfoError);
  const missingCoverRows = rows.filter((row) => !row.hasAnyCover);
  const remoteOnlyCoverRows = rows.filter((row) => !row.hasLocalImage && !row.hasCachedCover && row.hasRemoteImage);
  const okMissingCodeRows = okRows.filter((row) => !row.code);
  const okMissingTitleRows = okRows.filter((row) => !row.infoTitle);
  const okMissingJavdbUrlRows = okRows.filter((row) => !row.javdbUrl);
  const invalidJavdbUrlRows = okRows.filter((row) => row.javdbUrl && !isJavdbUrl(row.javdbUrl));
  const invalidImageUrlRows = okRows.filter((row) => row.imageUrl && !isHttpUrl(row.imageUrl));
  const invalidPreviewImageRows = okRows.filter((row) => row.invalidPreviewImages.length);
  const invalidPreviewVideoRows = okRows.filter((row) => row.previewVideoUrl && !isHttpUrl(row.previewVideoUrl));
  const actorTagOverlapRows = okRows.filter((row) => row.actorTagOverlap.length);
  const duplicateActorRows = okRows.filter((row) => row.duplicateActors.length);
  const duplicateTagRows = okRows.filter((row) => row.duplicateTags.length);
  const externalCodeRows = okRows.filter((row) => isExternalMetadataCode(row.code));
  const codeMismatchRows = okRows.filter((row) => row.inferredCode && row.code && normalizeWorkCode(row.code) !== row.inferredCode);

  return {
    totals: {
      people: library.people.length,
      works: library.works.length,
      videos: library.works.reduce((sum, work) => sum + (work.videos || []).length, 0),
      localInfoWorks: rows.filter((row) => row.hasLocalInfo).length,
      localImageWorks: rows.filter((row) => row.hasLocalImage).length,
      okInfoWorks: okRows.length,
      errorInfoWorks: infoErrorRows.length,
      cachedCoverWorks: rows.filter((row) => row.hasCachedCover).length,
      anyCoverWorks: rows.filter((row) => row.hasAnyCover).length,
      remoteOnlyCoverWorks: remoteOnlyCoverRows.length
    },
    issues: {
      missingOkInfo: summarizeRows(noOkInfoRows, limit),
      missingInfoSource: summarizeRows(missingInfoSourceRows, limit),
      localInfoNotImported: summarizeRows(localInfoNotImportedRows, limit),
      infoErrors: summarizeRows(infoErrorRows, limit, (row) => ({ error: row.infoError })),
      missingAnyCover: summarizeRows(missingCoverRows, limit),
      remoteOnlyCover: summarizeRows(remoteOnlyCoverRows, limit, (row) => ({ imageUrl: row.imageUrl })),
      okMissingCode: summarizeRows(okMissingCodeRows, limit),
      okMissingTitle: summarizeRows(okMissingTitleRows, limit),
      okMissingJavdbUrl: summarizeRows(okMissingJavdbUrlRows, limit, (row) => ({ code: row.code })),
      invalidJavdbUrl: summarizeRows(invalidJavdbUrlRows, limit, (row) => ({ javdbUrl: row.javdbUrl })),
      invalidImageUrl: summarizeRows(invalidImageUrlRows, limit, (row) => ({ imageUrl: row.imageUrl })),
      invalidPreviewImages: summarizeRows(invalidPreviewImageRows, limit, (row) => ({ invalidPreviewImages: row.invalidPreviewImages })),
      invalidPreviewVideos: summarizeRows(invalidPreviewVideoRows, limit, (row) => ({ previewVideoUrl: row.previewVideoUrl })),
      actorTagOverlaps: summarizeRows(actorTagOverlapRows, limit, (row) => ({ overlap: row.actorTagOverlap })),
      duplicateActors: summarizeRows(duplicateActorRows, limit, (row) => ({ duplicates: row.duplicateActors })),
      duplicateTags: summarizeRows(duplicateTagRows, limit, (row) => ({ duplicates: row.duplicateTags })),
      externalCodes: summarizeRows(externalCodeRows, limit, (row) => ({ code: row.code, inferredCode: row.inferredCode })),
      codeMismatches: summarizeRows(codeMismatchRows, limit, (row) => ({ code: row.code, inferredCode: row.inferredCode }))
    }
  };
}

function qualityRow(work, cache) {
  const info = cache.okInfoByWorkId.get(work.id) || null;
  const errorInfo = cache.errorInfoByWorkId.get(work.id) || null;
  const actors = parseJsonTextArray(info?.actors_json);
  const tags = parseJsonTextArray(info?.tags_json);
  const previewImages = parseJsonTextArray(info?.preview_images_json);
  const imageUrl = String(info?.image_url || "").trim();
  const inferredCode = normalizeWorkCode(
    [
      work.infoSummary?.code,
      work.directoryName,
      work.title,
      work.relativePath
    ].filter(Boolean).join("\n")
  );
  const hasLocalImage = Boolean(work.coverId) || Boolean((work.images || []).length);
  const hasCachedCover = cache.cachedCoverWorkIds.has(work.id);
  const hasRemoteImage = isHttpUrl(imageUrl);

  return {
    workId: work.id,
    title: work.title || work.directoryName || info?.title || "",
    relativePath: work.relativePath || "",
    code: String(info?.code || "").trim(),
    inferredCode,
    infoTitle: String(info?.title || "").trim(),
    javdbUrl: String(info?.javdb_url || "").trim(),
    imageUrl,
    previewImages,
    invalidPreviewImages: previewImages.filter((url) => !isHttpUrl(url)),
    previewVideoUrl: String(info?.preview_video_url || "").trim(),
    actors,
    tags,
    actorTagOverlap: intersectText(actors, tags),
    duplicateActors: duplicateTextValues(actors),
    duplicateTags: duplicateTextValues(tags),
    hasOkInfo: Boolean(info),
    hasInfoError: Boolean(errorInfo),
    infoError: String(errorInfo?.error || "").trim(),
    hasLocalInfo: Boolean((work.infos || []).length),
    hasLocalImage,
    hasCachedCover,
    hasRemoteImage,
    hasAnyCover: hasLocalImage || hasCachedCover || hasRemoteImage,
    videoCount: (work.videos || []).length,
    infoCount: (work.infos || []).length,
    imageCount: (work.images || []).length
  };
}

function parseJsonTextArray(value) {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((item) => {
      if (Array.isArray(item)) return parseJsonTextArray(JSON.stringify(item));
      return String(item ?? "").split(/[,，、;；|]/);
    }).map((item) => item.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

function intersectText(left, right) {
  const rightByKey = new Map(right.map((value) => [textKey(value), value]));
  return unique(left.map((value) => rightByKey.get(textKey(value))).filter(Boolean));
}

function duplicateTextValues(values) {
  const seen = new Set();
  const duplicates = [];
  for (const value of values) {
    const key = textKey(value);
    if (!key) continue;
    if (seen.has(key)) duplicates.push(value);
    seen.add(key);
  }
  return unique(duplicates);
}

function textKey(value) {
  return String(value || "").trim().toLowerCase();
}

function summarizeRows(rows, limit, extra = null) {
  return {
    count: rows.length,
    samples: rows.slice(0, Math.max(0, limit)).map((row) => ({
      workId: row.workId,
      title: row.title,
      relativePath: row.relativePath,
      ...(extra ? extra(row) : {})
    }))
  };
}

function isHttpUrl(value) {
  return /^https?:\/\//i.test(String(value || "").trim());
}

function isJavdbUrl(value) {
  return /^https?:\/\/(?:www\.)?javdb(?:\d+)?\.[^/\s]+\/v\/[A-Za-z0-9]+/i.test(String(value || "").trim());
}

function isExternalMetadataCode(value) {
  const text = String(value || "").trim();
  if (!text) return false;
  if (/^(?:tt|nm)-?\d{5,}$/i.test(text)) return true;
  return /^(?:imdb|tmdb|themoviedb|douban|kodi|jellyfin|plex)[:_\s-]+[a-z0-9.-]+$/i.test(text);
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function positiveInteger(value) {
  if (value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.floor(number) : null;
}

function pct(value, total) {
  if (!total) return "0.0%";
  return `${((value / total) * 100).toFixed(1)}%`;
}

function printReport(report, options) {
  console.log(`metadata quality: ${options.dbPath}`);
  console.log(`library-index: ${options.indexPath}`);
  console.log("");
  console.log(`works: ${report.totals.works}`);
  console.log(`videos: ${report.totals.videos}`);
  console.log(`people: ${report.totals.people}`);
  console.log("");
  console.log("coverage:");
  console.log(`  ok info: ${report.totals.okInfoWorks} (${pct(report.totals.okInfoWorks, report.totals.works)})`);
  console.log(`  local info files: ${report.totals.localInfoWorks} (${pct(report.totals.localInfoWorks, report.totals.works)})`);
  console.log(`  cached covers: ${report.totals.cachedCoverWorks} (${pct(report.totals.cachedCoverWorks, report.totals.works)})`);
  console.log(`  local images: ${report.totals.localImageWorks} (${pct(report.totals.localImageWorks, report.totals.works)})`);
  console.log(`  any cover/image: ${report.totals.anyCoverWorks} (${pct(report.totals.anyCoverWorks, report.totals.works)})`);
  console.log(`  remote-only cover: ${report.totals.remoteOnlyCoverWorks}`);
  console.log("");
  console.log("quality issues:");
  printIssueLine("missing ok info", report.issues.missingOkInfo);
  printIssueLine("missing info source", report.issues.missingInfoSource);
  printIssueLine("local info not imported", report.issues.localInfoNotImported);
  printIssueLine("info error rows", report.issues.infoErrors);
  printIssueLine("missing any cover/image", report.issues.missingAnyCover);
  printIssueLine("ok info missing code", report.issues.okMissingCode);
  printIssueLine("ok info missing title", report.issues.okMissingTitle);
  printIssueLine("ok info missing JavDB URL", report.issues.okMissingJavdbUrl);
  printIssueLine("invalid JavDB URL", report.issues.invalidJavdbUrl);
  printIssueLine("invalid image URL", report.issues.invalidImageUrl);
  printIssueLine("invalid preview images", report.issues.invalidPreviewImages);
  printIssueLine("invalid preview videos", report.issues.invalidPreviewVideos);
  printIssueLine("actor/tag overlaps", report.issues.actorTagOverlaps);
  printIssueLine("duplicate actors", report.issues.duplicateActors);
  printIssueLine("duplicate tags", report.issues.duplicateTags);
  printIssueLine("external metadata codes", report.issues.externalCodes);
  printIssueLine("code mismatches", report.issues.codeMismatches);
  console.log("");
  printSamples("Missing ok info", report.issues.missingOkInfo.samples);
  printSamples("Missing any cover/image", report.issues.missingAnyCover.samples);
  printSamples("Actor/tag overlaps", report.issues.actorTagOverlaps.samples);
  printSamples("Code mismatches", report.issues.codeMismatches.samples);
}

function printIssueLine(label, issue) {
  console.log(`  ${label}: ${issue.count}`);
}

function printSamples(title, rows) {
  if (!rows.length) return;
  console.log("");
  console.log(`${title}:`);
  for (const row of rows) {
    const details = Object.entries(row)
      .filter(([key]) => !["workId", "title", "relativePath"].includes(key))
      .map(([key, value]) => `${key}=${Array.isArray(value) ? value.join(", ") : value}`)
      .join(" · ");
    console.log(`- ${row.title || row.workId}${details ? ` | ${details}` : ""}`);
    if (row.relativePath) console.log(`  ${row.relativePath}`);
  }
}
