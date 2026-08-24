import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { DEFAULT_MAX_COVER_BYTES, extractCoverFrameAsync } from "../lib/cover-frame.js";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_DB_PATH = path.join(PROJECT_ROOT, "data", "fanhao-core-v2.sqlite");
const DEFAULT_IMAGE_DB_PATH = path.join(PROJECT_ROOT, "data", "fanhao-core-images.sqlite");
const DEFAULT_WESTERN_ROOTS = ["R:\\"];

const options = parseArgs(process.argv.slice(2));
const dbPath = path.resolve(options.db || DEFAULT_DB_PATH);
const imageDbPath = path.resolve(options["image-db"] || process.env.FANHAO_CORE_IMAGE_DB || DEFAULT_IMAGE_DB_PATH);
const writeChanges = Boolean(options.write);
const overwrite = Boolean(options.overwrite);
const retryErrors = Boolean(options["retry-errors"]);
const scope = options.scope === "western" ? "western" : "all";
const limit = options.limit === "0" ? 0 : positiveInteger(options.limit) ?? 20;
const concurrency = Math.max(1, Math.min(8, positiveInteger(options.concurrency) ?? 3));
const ffmpegPath = options.ffmpeg || process.env.FFMPEG_PATH || "ffmpeg";
const ffprobePath = options.ffprobe || process.env.FFPROBE_PATH || "ffprobe";
const maxBytes = positiveInteger(options["max-bytes"]) || DEFAULT_MAX_COVER_BYTES;
const westernRoots = rootList(options.root || process.env.FANHAO_WESTERN_ROOTS, DEFAULT_WESTERN_ROOTS);

if (!fs.existsSync(dbPath)) throw new Error(`核心数据库不存在：${dbPath}`);
if (!fs.existsSync(imageDbPath)) throw new Error(`图片数据库不存在：${imageDbPath}`);

const db = new DatabaseSync(dbPath);
db.exec("PRAGMA busy_timeout = 30000");
db.prepare("ATTACH DATABASE ? AS fanhao_images").run(imageDbPath);
verifyImageStore(db);

const candidates = loadCandidates(db, {
  overwrite,
  retryErrors,
  scope,
  westernRoots,
  workId: options["work-id"],
  personId: options["person-id"]
});
const selected = limit > 0 ? candidates.slice(0, limit) : candidates;
const report = { candidates: candidates.length, selected: selected.length, generated: 0, skippedMissingVideo: 0, errors: [] };

if (!writeChanges) {
  printDryRun(report, selected);
  db.close();
  process.exit(0);
}

const coverWriter = createCoverWriter(db);
await mapWithConcurrency(selected, concurrency, async (candidate, index) => {
  if (!candidate.video_path || !fs.existsSync(candidate.video_path)) {
    report.skippedMissingVideo += 1;
    coverWriter.saveError(candidate, "视频文件不存在");
    return;
  }
  try {
    const durationSeconds = Number(candidate.duration_minutes || 0) > 0 ? Number(candidate.duration_minutes) * 60 : 0;
    let coverBlob;
    try {
      coverBlob = await extractCoverFrameAsync(candidate.video_path, {
        ffmpegPath,
        ffprobePath,
        duration: durationSeconds,
        maxBytes
      });
    } catch (error) {
      if (durationSeconds > 0 || !shouldRetryAtStart(error)) throw error;
      coverBlob = await extractCoverFrameAsync(candidate.video_path, {
        ffmpegPath,
        ffprobePath,
        duration: 1,
        maxBytes
      });
    }
    coverWriter.saveCover(candidate, coverBlob);
    report.generated += 1;
    if (report.generated === 1 || report.generated % 25 === 0 || index === selected.length - 1) {
      console.log(`[cover] ${report.generated}/${selected.length} ${candidate.title || path.basename(candidate.video_path)}`);
    }
  } catch (error) {
    report.errors.push({ workId: String(candidate.work_id), title: candidate.title || "", error: error.message });
    coverWriter.saveError(candidate, error.message);
    console.warn(`[cover:error] ${candidate.title || candidate.work_id}: ${singleLine(error.message, 240)}`);
  }
});

printWriteReport(report);
db.close();

function parseArgs(args) {
  const result = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2);
    if (["write", "overwrite", "retry-errors"].includes(key)) {
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

function positiveInteger(value) {
  if (value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.floor(number) : null;
}

function rootList(rawValue, fallback) {
  const values = String(rawValue || "").replaceAll("|", ";").split(";").map((value) => value.trim()).filter(Boolean);
  return values.length ? values : fallback;
}

function pathWithinAnyRoot(targetPath, roots) {
  if (!targetPath) return false;
  const target = path.resolve(targetPath);
  return roots.some((rootPath) => {
    const root = path.resolve(rootPath);
    if (path.parse(root).root.toLowerCase() !== path.parse(target).root.toLowerCase()) return false;
    const relative = path.relative(root, target);
    return relative === "" || (!path.isAbsolute(relative) && !relative.startsWith(`..${path.sep}`) && relative !== "..");
  });
}

function shouldRetryAtStart(error) {
  const message = String(error?.message || "").toLowerCase();
  return ![
    "moov atom not found",
    "matches no streams",
    "invalid data found",
    "only rectangular vol supported",
    "header damaged",
    "invalid bitstream",
    "unable to determine channel mode"
  ].some((marker) => message.includes(marker));
}

function singleLine(value, maxLength) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}

function verifyImageStore(database) {
  const row = database.prepare("SELECT name FROM fanhao_images.sqlite_schema WHERE type = 'table' AND name = 'images'").get();
  if (!row) throw new Error("图片数据库缺少 images 表");
}

function loadCandidates(database, filters) {
  const rows = database.prepare(
    `
    WITH ranked_videos AS (
      SELECT
        w.id AS work_id,
        w.title,
        w.duration_minutes,
        lw.id AS local_work_id,
        lw.local_path,
        lf.file_id AS video_id,
        lf.file_path AS video_path,
        lf.relative_path AS video_relative_path,
        lf.modified_at,
        (
          SELECT wp.person_id FROM work_people wp
          WHERE wp.work_id = w.id AND wp.role = 'actor'
          ORDER BY wp.sort_order, wp.person_id LIMIT 1
        ) AS person_id,
        ROW_NUMBER() OVER (PARTITION BY w.id ORDER BY lf.modified_at DESC, lw.id, lf.sort_order, lf.id) AS row_number
      FROM local_works lw
      JOIN works w ON w.id = lw.work_id
      JOIN local_files lf ON lf.local_work_id = lw.id AND lf.file_type = 'video'
      WHERE NOT EXISTS (
        SELECT 1 FROM local_files image_file
        WHERE image_file.local_work_id = lw.id AND image_file.file_type = 'image'
      )
    )
    SELECT * FROM ranked_videos video
    WHERE video.row_number = 1
      AND (
        ? = 1 OR NOT EXISTS (
          SELECT 1 FROM fanhao_images.images image
          WHERE image.owner_type = 'work' AND image.owner_id = video.work_id
            AND image.kind = 'cover' AND image.status = 'ok'
            AND image.image_blob IS NOT NULL AND length(image.image_blob) > 0
        )
      )
      AND (
        ? = 1 OR NOT EXISTS (
          SELECT 1 FROM fanhao_images.images failed_image
          WHERE failed_image.owner_type = 'work' AND failed_image.owner_id = video.work_id
            AND failed_image.kind = 'cover_error' AND failed_image.status = 'error'
            AND failed_image.source = 'ffmpeg-frame-batch'
        )
      )
    ORDER BY video.modified_at DESC, video.work_id DESC
    `
  ).all(filters.overwrite ? 1 : 0, filters.retryErrors ? 1 : 0);

  return rows
    .filter((row) => filters.scope !== "western" || pathWithinAnyRoot(row.local_path, filters.westernRoots))
    .filter((row) => !filters.workId || String(row.work_id) === String(filters.workId))
    .filter((row) => !filters.personId || String(row.person_id) === String(filters.personId));
}

function createCoverWriter(database) {
  const coverStatement = database.prepare(
    `
    INSERT INTO fanhao_images.images (
      owner_type, owner_id, kind, source_type, local_path, mime, image_blob,
      byte_size, sort_order, status, source, legacy_table, legacy_key, created_at, updated_at
    ) VALUES ('work', ?, 'cover', 'generated', ?, 'image/jpeg', ?, ?, 0, 'ok', 'ffmpeg-frame-batch', 'generated', ?, ?, ?)
    ON CONFLICT DO UPDATE SET
      source_type = excluded.source_type,
      local_path = excluded.local_path,
      mime = excluded.mime,
      image_blob = excluded.image_blob,
      byte_size = excluded.byte_size,
      status = excluded.status,
      error = NULL,
      source = excluded.source,
      legacy_table = excluded.legacy_table,
      legacy_key = excluded.legacy_key,
      updated_at = excluded.updated_at
    `
  );
  const errorStatement = database.prepare(
    `
    INSERT INTO fanhao_images.images (
      owner_type, owner_id, kind, source_type, local_path, mime, image_blob,
      byte_size, sort_order, status, error, source, legacy_table, legacy_key, created_at, updated_at
    ) VALUES ('work', ?, 'cover_error', 'generated', ?, 'image/jpeg', NULL, 0, 0, 'error', ?, 'ffmpeg-frame-batch', 'generated', ?, ?, ?)
    ON CONFLICT DO UPDATE SET
      status = excluded.status,
      error = excluded.error,
      source = excluded.source,
      legacy_table = excluded.legacy_table,
      legacy_key = excluded.legacy_key,
      updated_at = excluded.updated_at
    `
  );
  function saveCover(candidate, coverBlob) {
    const now = new Date().toISOString();
    coverStatement.run(
      Number(candidate.work_id),
      candidate.video_relative_path || candidate.video_path || "",
      coverBlob,
      coverBlob.length,
      String(candidate.work_id),
      now,
      now
    );
  }
  function saveError(candidate, errorMessage) {
    const now = new Date().toISOString();
    errorStatement.run(
      Number(candidate.work_id),
      candidate.video_relative_path || candidate.video_path || "",
      singleLine(errorMessage, 1000),
      String(candidate.work_id),
      now,
      now
    );
  }
  return { saveCover, saveError };
}

async function mapWithConcurrency(items, workerCount, mapper) {
  let nextIndex = 0;
  async function worker() {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      await mapper(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(workerCount, items.length) }, worker));
}

function printDryRun(report, sample) {
  console.log(`core-db: ${dbPath}`);
  console.log(`image-db: ${imageDbPath}`);
  console.log("mode: dry-run");
  console.log(`scope: ${scope}`);
  console.log(`overwrite: ${overwrite ? "true" : "false"}`);
  console.log(`retry errors: ${retryErrors ? "true" : "false"}`);
  console.log(`missing cover candidates: ${report.candidates}`);
  console.log(`selected: ${report.selected}${limit ? ` (limit ${limit})` : ""}`);
  for (const candidate of sample.slice(0, 10)) {
    console.log(`  - ${fs.existsSync(candidate.video_path) ? "video" : "missing-file"} ${candidate.title || candidate.video_path}`);
  }
  console.log("\nAdd --write to generate cached covers. Use --limit 0 to process all candidates.");
}

function printWriteReport(report) {
  console.log("");
  console.log(`core-db: ${dbPath}`);
  console.log(`image-db: ${imageDbPath}`);
  console.log("mode: write");
  console.log(`scope: ${scope}`);
  console.log(`selected: ${report.selected}${limit ? ` (limit ${limit})` : ""}`);
  console.log(`generated: ${report.generated}`);
  console.log(`skipped missing video: ${report.skippedMissingVideo}`);
  console.log(`errors: ${report.errors.length}`);
}
