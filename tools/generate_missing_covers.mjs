import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { DEFAULT_MAX_COVER_BYTES, extractCoverFrame } from "../lib/cover-frame.js";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_INDEX_PATH = path.join(PROJECT_ROOT, "data", "library-index.json");
const DEFAULT_DB_PATH = path.join(PROJECT_ROOT, "data", "actor-profiles.sqlite");

const options = parseArgs(process.argv.slice(2));
const indexPath = path.resolve(options.index || DEFAULT_INDEX_PATH);
const dbPath = path.resolve(options.db || DEFAULT_DB_PATH);
const writeChanges = Boolean(options.write);
const overwrite = Boolean(options.overwrite);
const limit = options.limit === "0" ? 0 : positiveInteger(options.limit) || (writeChanges ? 20 : 20);
const ffmpegPath = options.ffmpeg || process.env.FFMPEG_PATH || "ffmpeg";
const ffprobePath = options.ffprobe || process.env.FFPROBE_PATH || "ffprobe";
const maxBytes = positiveInteger(options["max-bytes"]) || DEFAULT_MAX_COVER_BYTES;

const index = readJson(indexPath);
const db = new DatabaseSync(dbPath);
ensureWorkCoversTable(db);

const peopleById = new Map((index.people || []).map((person) => [person.id, person]));
const existingCoverIds = overwrite ? new Set() : cachedCoverWorkIds(db);
const candidates = coverCandidates(index.works || [], existingCoverIds, options);
const selected = limit > 0 ? candidates.slice(0, limit) : candidates;

const report = {
  candidates: candidates.length,
  selected: selected.length,
  generated: 0,
  skippedMissingVideo: 0,
  errors: []
};

if (!writeChanges) {
  printDryRun(report, selected, { indexPath, dbPath, limit, overwrite });
  process.exit(0);
}

for (const work of selected) {
  const video = chooseVideo(work);
  if (!video) {
    report.skippedMissingVideo += 1;
    continue;
  }

  try {
    const coverBlob = extractCoverFrame(video.path, { ffmpegPath, ffprobePath, maxBytes });
    saveCover(db, work, video, peopleById.get(work.personId), coverBlob);
    report.generated += 1;
    console.log(`OK ${report.generated}/${selected.length} ${work.title || work.directoryName || work.id}`);
  } catch (error) {
    report.errors.push({ workId: work.id, title: work.title || work.directoryName || "", error: error.message });
    console.warn(`ERR ${work.title || work.id}: ${error.message}`);
  }
}

printWriteReport(report, { indexPath, dbPath, limit, overwrite });

function parseArgs(args) {
  const result = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2);
    if (key === "write" || key === "overwrite") {
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

function positiveInteger(value) {
  if (value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.floor(number) : null;
}

function ensureWorkCoversTable(db) {
  db.exec(`
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

function cachedCoverWorkIds(db) {
  return new Set(db.prepare("SELECT work_id FROM work_covers WHERE cover_blob IS NOT NULL AND length(cover_blob) > 0").all().map((row) => row.work_id));
}

function coverCandidates(works, existingCoverIds, options) {
  return works
    .filter((work) => !options["work-id"] || work.id === options["work-id"])
    .filter((work) => !options["person-id"] || work.personId === options["person-id"])
    .filter((work) => !work.coverId)
    .filter((work) => overwrite || !existingCoverIds.has(work.id))
    .filter((work) => (work.videos || []).length > 0)
    .sort((a, b) => String(b.modifiedAt || "").localeCompare(String(a.modifiedAt || "")));
}

function chooseVideo(work) {
  return (work.videos || []).find((video) => video?.path && fs.existsSync(video.path)) || null;
}

function saveCover(db, work, video, person, coverBlob) {
  const now = new Date().toISOString();
  db.prepare(
    `
    INSERT INTO work_covers (
      work_id, person_id, person_name, video_id, title,
      cover_url, cover_mime, cover_blob, source, fetched_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(work_id) DO UPDATE SET
      person_id = excluded.person_id,
      person_name = excluded.person_name,
      video_id = excluded.video_id,
      title = excluded.title,
      cover_url = excluded.cover_url,
      cover_mime = excluded.cover_mime,
      cover_blob = excluded.cover_blob,
      source = excluded.source,
      fetched_at = excluded.fetched_at,
      updated_at = excluded.updated_at
    `
  ).run(
    work.id,
    work.personId || "",
    person?.name || "",
    video.id || "",
    work.title || work.directoryName || video.title || "",
    video.relativePath || video.path || "",
    "image/jpeg",
    coverBlob,
    "ffmpeg-frame-batch",
    now,
    now
  );
}

function printDryRun(report, selected, settings) {
  console.log(`library-index: ${settings.indexPath}`);
  console.log(`metadata-db: ${settings.dbPath}`);
  console.log("mode: dry-run");
  console.log(`overwrite: ${settings.overwrite ? "true" : "false"}`);
  console.log(`missing cover candidates: ${report.candidates}`);
  console.log(`selected sample: ${report.selected}${settings.limit ? ` (limit ${settings.limit})` : ""}`);
  for (const work of selected.slice(0, 10)) {
    const video = chooseVideo(work);
    const status = video ? "video" : "missing-file";
    console.log(`  - ${status} ${work.title || work.directoryName || work.id}`);
  }
  console.log("\nAdd --write to generate cached covers. Use --limit 0 to process all candidates.");
}

function printWriteReport(report, settings) {
  console.log("");
  console.log(`library-index: ${settings.indexPath}`);
  console.log(`metadata-db: ${settings.dbPath}`);
  console.log("mode: write");
  console.log(`overwrite: ${settings.overwrite ? "true" : "false"}`);
  console.log(`selected: ${report.selected}${settings.limit ? ` (limit ${settings.limit})` : ""}`);
  console.log(`generated: ${report.generated}`);
  console.log(`skipped missing video: ${report.skippedMissingVideo}`);
  console.log(`errors: ${report.errors.length}`);
}
