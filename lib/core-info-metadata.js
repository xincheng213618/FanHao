import fs from "node:fs";
import path from "node:path";

import { workCodeKey } from "./code-parser.js";
import {
  decodeInfoBuffer,
  isSubtitleLikeInfoText,
  parseInfoMetadata,
  rankInfoFiles
} from "./info-metadata.js";

const MAX_INFO_BYTES = 1024 * 1024;
const LOCAL_METADATA_SOURCES = new Set(["local_full_scan", "local_scan"]);

function candidatePath(file) {
  return String(file?.path || file?.filePath || file?.file_path || "").trim();
}

function normalizedCandidate(file) {
  const filePath = candidatePath(file);
  return {
    ...file,
    path: filePath,
    name: String(file?.name || path.basename(filePath)),
    ext: String(file?.ext || path.extname(filePath)).toLowerCase()
  };
}

function hasText(value) {
  return String(value ?? "").trim().length > 0;
}

function hasNumber(value) {
  return value !== null && value !== undefined && Number.isFinite(Number(value));
}

function sameValue(left, right) {
  if (left === null || left === undefined || left === "") {
    return right === null || right === undefined || right === "";
  }
  if (typeof left === "number" || typeof right === "number") {
    return Number(left) === Number(right);
  }
  return String(left) === String(right);
}

export function parseCoreInfoCandidates(files = [], defaults = {}) {
  const ranked = rankInfoFiles(files.map(normalizedCandidate).filter((file) => file.path));
  if (!ranked.length) return { status: "missing", file: null, parsed: null, error: "没有资料文件" };

  let lastError = null;
  for (const { file } of ranked) {
    try {
      const stat = fs.statSync(file.path);
      if (!stat.isFile()) throw new Error("资料路径不是文件");
      if (stat.size > MAX_INFO_BYTES) throw new Error(`资料文件过大：${stat.size} bytes`);
      const text = decodeInfoBuffer(fs.readFileSync(file.path));
      if (isSubtitleLikeInfoText(text)) throw new Error("资料文件像字幕脚本");
      const parsed = parseInfoMetadata(text, {
        title: defaults.title || "",
        directoryName: defaults.directoryName || "",
        fileName: file.name
      });
      return {
        status: "parsed",
        file,
        parsed,
        sourceSize: stat.size,
        sourceMtime: stat.mtime.toISOString(),
        error: ""
      };
    } catch (error) {
      lastError = error;
    }
  }

  return {
    status: "error",
    file: ranked[0]?.file || null,
    parsed: null,
    error: String(lastError?.message || lastError || "资料解析失败")
  };
}

export function applyParsedInfoToCoreWork(database, workId, parsed, { write = true, now = new Date().toISOString() } = {}) {
  if (!database || !workId || !parsed) return { status: "skipped", changedFields: [] };
  const existing = database.prepare(
    `
    SELECT id, code, code_search, title, release_date, duration_minutes, rating,
           rating_count, director, description, raw_text, fields_json,
           javdb_tags_json, source
    FROM works
    WHERE id = ?
    `
  ).get(Number(workId));
  if (!existing) return { status: "missing-work", changedFields: [] };

  const replaceLocalMetadata = LOCAL_METADATA_SOURCES.has(String(existing.source || ""));
  const chooseText = (current, incoming) => (
    hasText(incoming) && (replaceLocalMetadata || !hasText(current)) ? String(incoming).trim() : current
  );
  const chooseNumber = (current, incoming) => (
    hasNumber(incoming) && (replaceLocalMetadata || !hasNumber(current)) ? Number(incoming) : current
  );

  const parsedCode = hasText(parsed.code) ? String(parsed.code).trim() : "";
  const parsedFields = Array.isArray(parsed.fields) && parsed.fields.length ? JSON.stringify(parsed.fields) : "";
  const parsedTags = Array.isArray(parsed.tags) && parsed.tags.length ? JSON.stringify(parsed.tags) : "";
  const next = {
    code: chooseText(existing.code, parsedCode),
    code_search: existing.code_search,
    title: chooseText(existing.title, parsed.title),
    release_date: chooseText(existing.release_date, parsed.releaseDate),
    duration_minutes: chooseNumber(existing.duration_minutes, parsed.durationMinutes),
    rating: chooseNumber(existing.rating, parsed.rating),
    rating_count: chooseNumber(existing.rating_count, parsed.ratingCount),
    director: chooseText(existing.director, parsed.director),
    description: chooseText(existing.description, parsed.description),
    raw_text: chooseText(existing.raw_text, parsed.rawText),
    fields_json: chooseText(existing.fields_json, parsedFields),
    javdb_tags_json: chooseText(existing.javdb_tags_json, parsedTags)
  };
  if (hasText(next.code) && (replaceLocalMetadata || !hasText(next.code_search))) {
    next.code_search = workCodeKey(next.code);
  }

  const changedFields = Object.keys(next).filter((field) => !sameValue(existing[field], next[field]));
  if (!changedFields.length) return { status: "unchanged", changedFields };
  if (!write) return { status: "would-update", changedFields };

  database.prepare(
    `
    UPDATE works
    SET code = ?, code_search = ?, title = ?, release_date = ?, duration_minutes = ?,
        rating = ?, rating_count = ?, director = ?, description = ?, raw_text = ?,
        fields_json = ?, javdb_tags_json = ?, status = 'ok', error = NULL, updated_at = ?
    WHERE id = ?
    `
  ).run(
    next.code || "",
    next.code_search || "",
    next.title || "",
    next.release_date || null,
    next.duration_minutes ?? null,
    next.rating ?? null,
    next.rating_count ?? null,
    next.director || null,
    next.description || null,
    next.raw_text || null,
    next.fields_json || "[]",
    next.javdb_tags_json || "[]",
    now,
    Number(workId)
  );
  return { status: "updated", changedFields };
}

export function syncCoreWorkInfoCandidates({ database, workId, files = [], defaults = {}, write = true, now } = {}) {
  const parsedResult = parseCoreInfoCandidates(files, defaults);
  if (parsedResult.status !== "parsed") return { ...parsedResult, changedFields: [] };
  const applied = applyParsedInfoToCoreWork(database, workId, parsedResult.parsed, { write, now });
  return { ...parsedResult, ...applied };
}
