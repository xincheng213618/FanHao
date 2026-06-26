#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { decodeInfoBuffer, isSubtitleLikeInfoText, parseInfoMetadata, rankInfoFiles } from "../lib/info-metadata.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, "..");
const DEFAULT_INDEX = path.join(PROJECT_ROOT, "data", "library-index.json");
const DEFAULT_DB = path.join(PROJECT_ROOT, "data", "actor-profiles.sqlite");
const MAX_INFO_BYTES = 1024 * 1024;

const args = parseArgs(process.argv.slice(2));
const indexPath = path.resolve(args.index || DEFAULT_INDEX);
const dbPath = path.resolve(args.db || DEFAULT_DB);
const limit = Number(args.limit || 0);
const force = Boolean(args.force);
const dryRun = Boolean(args.dryRun);
const verbose = Boolean(args.verbose);
const workIdFilter = args.workId || "";

if (!fs.existsSync(indexPath)) {
  throw new Error(`找不到索引文件：${indexPath}`);
}

const library = JSON.parse(fs.readFileSync(indexPath, "utf8"));
const peopleById = new Map((library.people || []).map((person) => [person.id, person]));
const works = (library.people || [])
  .flatMap((person) => (person.works || []).map((workId) => findWork(library, workId)))
  .filter(Boolean);

const targetWorks = workIdFilter ? works.filter((work) => work.id === workIdFilter) : works;
const db = new DatabaseSync(dbPath);
ensureSchema(db);

const existingStmt = db.prepare(
  "SELECT source_info_id, source_size, source_mtime, status FROM work_info WHERE work_id = ?"
);
const deleteStmt = db.prepare("DELETE FROM work_info WHERE work_id = ?");
const upsertStmt = db.prepare(`
  INSERT INTO work_info (
    work_id, person_id, person_name, source_info_id, source_name, source_path,
    source_size, source_mtime, code, title, release_date, duration_minutes,
    rating, rating_count, director, maker, label, series, javdb_url, image_url,
    preview_images_json, preview_video_url, actors_json, tags_json, fields_json, raw_text, raw_truncated,
    status, error, updated_at
  )
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(work_id) DO UPDATE SET
    person_id = excluded.person_id,
    person_name = excluded.person_name,
    source_info_id = excluded.source_info_id,
    source_name = excluded.source_name,
    source_path = excluded.source_path,
    source_size = excluded.source_size,
    source_mtime = excluded.source_mtime,
    code = excluded.code,
    title = excluded.title,
    release_date = excluded.release_date,
    duration_minutes = excluded.duration_minutes,
    rating = excluded.rating,
    rating_count = excluded.rating_count,
    director = excluded.director,
    maker = excluded.maker,
    label = excluded.label,
    series = excluded.series,
    javdb_url = excluded.javdb_url,
    image_url = excluded.image_url,
    preview_images_json = excluded.preview_images_json,
    preview_video_url = excluded.preview_video_url,
    actors_json = excluded.actors_json,
    tags_json = excluded.tags_json,
    fields_json = excluded.fields_json,
    raw_text = excluded.raw_text,
    raw_truncated = excluded.raw_truncated,
    status = excluded.status,
    error = excluded.error,
    updated_at = excluded.updated_at
`);

const startedAt = Date.now();
const stats = {
  total: targetWorks.length,
  withInfo: 0,
  imported: 0,
  skipped: 0,
  errors: 0,
  missing: 0,
  dryRun: dryRun ? 1 : 0
};

if (!dryRun) db.exec("BEGIN IMMEDIATE");
try {
  for (const work of targetWorks) {
    if (limit && stats.imported + stats.errors >= limit) break;

    const candidates = rankInfoFiles(work.infos || []);
    if (!candidates.length) {
      if (!dryRun) deleteStmt.run(work.id);
      stats.missing += 1;
      continue;
    }
    stats.withInfo += 1;

    const existing = existingStmt.get(work.id);
    let handled = false;
    let lastError = null;
    let lastErrorSource = null;

    for (const { file: infoFile } of candidates) {
      const stat = safeStat(infoFile.path);
      const sourceSize = stat?.size ?? infoFile.size ?? 0;
      const sourceMtime = stat?.mtime?.toISOString?.() || infoFile.modifiedAt || "";

      if (
        !force &&
        existing?.status === "ok" &&
        existing.source_info_id === infoFile.id &&
        Number(existing.source_size || 0) === Number(sourceSize || 0) &&
        String(existing.source_mtime || "") === String(sourceMtime || "")
      ) {
        stats.skipped += 1;
        handled = true;
        break;
      }

      try {
        if (!stat) throw new Error("资料文件不存在");
        if (stat.size > MAX_INFO_BYTES) throw new Error(`资料文件过大：${stat.size} bytes`);

        const text = decodeInfoBuffer(fs.readFileSync(infoFile.path));
        if (isSubtitleLikeInfoText(text)) {
          throw new Error("像字幕脚本，已跳过");
        }

        const person = peopleById.get(work.personId);
        const parsed = parseInfoMetadata(text, {
          title: work.title,
          directoryName: work.directoryName,
          fileName: infoFile.name
        });

        if (!dryRun) {
          upsertStmt.run(
            work.id,
            work.personId,
            person?.name || "",
            infoFile.id,
            infoFile.name,
            infoFile.relativePath || "",
            sourceSize,
            sourceMtime,
            parsed.code || null,
            parsed.title || null,
            parsed.releaseDate || null,
            parsed.durationMinutes,
            parsed.rating,
            parsed.ratingCount,
            parsed.director || null,
            parsed.maker || null,
            parsed.label || null,
            parsed.series || null,
            parsed.javdbUrl || null,
            parsed.imageUrl || null,
            JSON.stringify(parsed.previewImages || []),
            parsed.previewVideoUrl || null,
            JSON.stringify(parsed.actors || []),
            JSON.stringify(parsed.tags || []),
            JSON.stringify(parsed.fields || []),
            parsed.rawText || "",
            parsed.rawTextTruncated ? 1 : 0,
            "ok",
            null,
            new Date().toISOString()
          );
        }

        stats.imported += 1;
        handled = true;
        if (verbose) {
          console.log(`[ok] ${parsed.code || work.title} <- ${infoFile.relativePath || infoFile.name}`);
        }
        break;
      } catch (error) {
        lastError = error;
        lastErrorSource = { infoFile, sourceSize, sourceMtime };
        if (verbose) console.warn(`[skip] ${work.title}: ${infoFile.relativePath || infoFile.name}: ${error.message}`);
      }
    }

    if (!handled) {
      if (lastError) {
        if (!dryRun) writeErrorRow(work, peopleById.get(work.personId), lastError, lastErrorSource);
        stats.errors += 1;
        if (verbose) console.warn(`[error] ${work.title}: ${lastError.message}`);
      } else {
        if (!dryRun) deleteStmt.run(work.id);
        stats.missing += 1;
      }
    }
  }

  if (!dryRun) db.exec("COMMIT");
} catch (error) {
  if (!dryRun) db.exec("ROLLBACK");
  throw error;
} finally {
  db.close();
}

const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
console.log(
  [
    `info 导入完成：${elapsed}s`,
    `作品 ${stats.total}`,
    `有资料 ${stats.withInfo}`,
    `写入 ${stats.imported}`,
    `跳过 ${stats.skipped}`,
    `无资料 ${stats.missing}`,
    `错误 ${stats.errors}`,
    dryRun ? "dry-run" : ""
  ]
    .filter(Boolean)
    .join(" · ")
);

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (item === "--force") result.force = true;
    else if (item === "--dry-run") result.dryRun = true;
    else if (item === "--verbose") result.verbose = true;
    else if (item.startsWith("--index=")) result.index = item.slice("--index=".length);
    else if (item === "--index") result.index = argv[++index];
    else if (item.startsWith("--db=")) result.db = item.slice("--db=".length);
    else if (item === "--db") result.db = argv[++index];
    else if (item.startsWith("--limit=")) result.limit = item.slice("--limit=".length);
    else if (item === "--limit") result.limit = argv[++index];
    else if (item.startsWith("--work-id=")) result.workId = item.slice("--work-id=".length);
    else if (item === "--work-id") result.workId = argv[++index];
  }
  return result;
}

function ensureSchema(db) {
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS work_info (
      work_id TEXT PRIMARY KEY,
      person_id TEXT NOT NULL,
      person_name TEXT NOT NULL,
      source_info_id TEXT,
      source_name TEXT,
      source_path TEXT,
      source_size INTEGER,
      source_mtime TEXT,
      code TEXT,
      title TEXT,
      release_date TEXT,
      duration_minutes INTEGER,
      rating REAL,
      rating_count INTEGER,
      director TEXT,
      maker TEXT,
      label TEXT,
      series TEXT,
      javdb_url TEXT,
      image_url TEXT,
      preview_images_json TEXT,
      preview_video_url TEXT,
      actors_json TEXT,
      tags_json TEXT,
      fields_json TEXT,
      raw_text TEXT,
      raw_truncated INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'ok',
      error TEXT,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_work_info_person_id ON work_info(person_id);
    CREATE INDEX IF NOT EXISTS idx_work_info_code ON work_info(code);
    CREATE INDEX IF NOT EXISTS idx_work_info_release_date ON work_info(release_date);
    CREATE INDEX IF NOT EXISTS idx_work_info_status ON work_info(status);
  `);
  ensureColumn(db, "work_info", "javdb_url", "TEXT");
  ensureColumn(db, "work_info", "preview_images_json", "TEXT");
  ensureColumn(db, "work_info", "preview_video_url", "TEXT");
  db.exec("CREATE INDEX IF NOT EXISTS idx_work_info_javdb_url ON work_info(javdb_url)");
}

function writeErrorRow(work, person, error, source = {}) {
  const infoFile = source.infoFile || {};
  const message = String(error?.message || error || "资料导入失败").slice(0, 1000);
  upsertStmt.run(
    work.id,
    work.personId,
    person?.name || "",
    infoFile.id || null,
    infoFile.name || null,
    infoFile.relativePath || "",
    source.sourceSize ?? infoFile.size ?? 0,
    source.sourceMtime || infoFile.modifiedAt || "",
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    JSON.stringify([]),
    null,
    JSON.stringify([]),
    JSON.stringify([]),
    JSON.stringify([]),
    "",
    0,
    "error",
    message,
    new Date().toISOString()
  );
}

function ensureColumn(db, table, column, definition) {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!rows.some((row) => row.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

function findWork(library, workId) {
  if (!library.__workMap) {
    library.__workMap = new Map((library.works || []).map((work) => [work.id, work]));
    if (!library.__workMap.size) {
      for (const person of library.people || []) {
        for (const work of person.workItems || []) {
          library.__workMap.set(work.id, work);
        }
      }
    }
  }
  return library.__workMap.get(workId);
}

function safeStat(filePath) {
  try {
    return fs.statSync(filePath);
  } catch {
    return null;
  }
}
