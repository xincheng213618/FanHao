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
const writeChanges = Boolean(options.write);

const index = readJson(indexPath);
const library = collectLibraryIds(index);
const db = new DatabaseSync(dbPath);

const report = {
  actorProfiles: collectActorProfileReport(db, library.validPersonIds),
  actorMovies: collectActorMovieReport(db, library.validPersonIds),
  workInfo: collectWorkInfoReport(db, library),
  workCovers: collectWorkCoverReport(db, library.validWorkIds, library.validVideoIds)
};

printReport(report, { writeChanges, indexPath, dbPath });

if (writeChanges) {
  applyCleanup(db, report);
}

function parseArgs(args) {
  const result = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2);
    if (key === "write") {
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

function collectLibraryIds(index) {
  const validPersonIds = new Set();
  const validWorkIds = new Set();
  const validVideoIds = new Set();
  const worksById = new Map();
  for (const person of index.people || []) {
    if (person?.id) validPersonIds.add(person.id);
  }
  for (const work of index.works || []) {
    if (!work?.id) continue;
    validWorkIds.add(work.id);
    worksById.set(work.id, work);
    for (const video of work.videos || []) {
      if (video?.id) validVideoIds.add(video.id);
    }
  }
  return { validPersonIds, validWorkIds, validVideoIds, worksById };
}

function collectActorProfileReport(db, validPersonIds) {
  const rows = db.prepare("SELECT person_id FROM actor_profiles").all();
  return {
    before: rows.length,
    orphanPersonIds: rows.map((row) => row.person_id).filter((personId) => !validPersonIds.has(personId))
  };
}

function collectActorMovieReport(db, validPersonIds) {
  const rows = db.prepare("SELECT rowid, person_id FROM actor_movies").all();
  return {
    before: rows.length,
    orphanRowIds: rows.filter((row) => !validPersonIds.has(row.person_id)).map((row) => row.rowid)
  };
}

function collectWorkInfoReport(db, library) {
  const rows = db.prepare("SELECT work_id, code, preview_video_url, status FROM work_info").all();
  const externalCodeRows = rows
    .filter((row) => isExternalMetadataCode(row.code))
    .map((row) => {
      const replacementCode = inferWorkCode(library.worksById.get(row.work_id));
      return {
        workId: row.work_id,
        code: String(row.code || ""),
        replacementCode
      };
    });
  return {
    before: rows.length,
    orphanWorkIds: rows.map((row) => row.work_id).filter((workId) => !library.validWorkIds.has(workId)),
    invalidPreviewWorkIds: rows
      .filter((row) => row.preview_video_url && !isHttpUrl(row.preview_video_url))
      .map((row) => row.work_id),
    externalCodeRows,
    errorWorkIds: rows
      .filter((row) => String(row.status || "").toLowerCase() === "error")
      .map((row) => row.work_id)
  };
}

function collectWorkCoverReport(db, validWorkIds, validVideoIds) {
  const rows = db.prepare("SELECT work_id, video_id, source, length(cover_blob) AS cover_bytes FROM work_covers").all();
  return {
    before: rows.length,
    orphanWorkIds: rows.map((row) => row.work_id).filter((workId) => !validWorkIds.has(workId)),
    nonLibraryVideoIds: rows
      .filter((row) => row.video_id && !validVideoIds.has(row.video_id))
      .map((row) => row.work_id),
    emptyBlobWorkIds: rows
      .filter((row) => !Number(row.cover_bytes || 0))
      .map((row) => row.work_id)
  };
}

function isHttpUrl(value) {
  return /^https?:\/\//i.test(String(value || "").trim());
}

function isExternalMetadataCode(value) {
  const text = String(value || "").trim();
  if (!text) return false;
  if (/^(?:tt|nm)-?\d{5,}$/i.test(text)) return true;
  return /^(?:imdb|tmdb|themoviedb|douban|kodi|jellyfin|plex)[:_\s-]+[a-z0-9.-]+$/i.test(text);
}

function inferWorkCode(work) {
  if (!work) return "";
  return normalizeWorkCode(
    [
      work.infoSummary?.code,
      work.directoryName,
      work.title,
      work.relativePath
    ]
      .filter(Boolean)
      .join("\n")
  );
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function applyCleanup(db, report) {
  const deleteActorProfile = db.prepare("DELETE FROM actor_profiles WHERE person_id = ?");
  const deleteActorMovie = db.prepare("DELETE FROM actor_movies WHERE rowid = ?");
  const deleteWorkInfo = db.prepare("DELETE FROM work_info WHERE work_id = ?");
  const clearPreviewVideo = db.prepare("UPDATE work_info SET preview_video_url = NULL WHERE work_id = ?");
  const updateWorkInfoCode = db.prepare("UPDATE work_info SET code = ? WHERE work_id = ?");
  const deleteWorkCover = db.prepare("DELETE FROM work_covers WHERE work_id = ?");

  db.exec("BEGIN");
  try {
    for (const personId of unique(report.actorProfiles.orphanPersonIds)) deleteActorProfile.run(personId);
    for (const rowId of unique(report.actorMovies.orphanRowIds)) deleteActorMovie.run(rowId);
    for (const workId of unique(report.workInfo.orphanWorkIds)) deleteWorkInfo.run(workId);
    for (const workId of unique(report.workInfo.invalidPreviewWorkIds)) clearPreviewVideo.run(workId);
    for (const row of report.workInfo.externalCodeRows) {
      updateWorkInfoCode.run(row.replacementCode || null, row.workId);
    }
    for (const workId of unique([...report.workCovers.orphanWorkIds, ...report.workCovers.emptyBlobWorkIds])) {
      deleteWorkCover.run(workId);
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function printReport(report, options) {
  const coverDeleteIds = unique([
    ...report.workCovers.orphanWorkIds,
    ...report.workCovers.emptyBlobWorkIds
  ]);

  console.log(`metadata-db: ${options.dbPath}`);
  console.log(`library-index: ${options.indexPath}`);
  console.log(options.writeChanges ? "mode: write" : "mode: dry-run");
  console.log("");
  console.log(`actor_profiles: ${report.actorProfiles.before} rows`);
  console.log(`  orphan people removed: ${unique(report.actorProfiles.orphanPersonIds).length}`);
  console.log(`actor_movies: ${report.actorMovies.before} rows`);
  console.log(`  orphan rows removed: ${unique(report.actorMovies.orphanRowIds).length}`);
  console.log(`work_info: ${report.workInfo.before} rows`);
  console.log(`  orphan works removed: ${unique(report.workInfo.orphanWorkIds).length}`);
  console.log(`  invalid preview videos cleared: ${unique(report.workInfo.invalidPreviewWorkIds).length}`);
  console.log(`  external codes repaired: ${report.workInfo.externalCodeRows.filter((row) => row.replacementCode).length}`);
  console.log(`  external codes cleared: ${report.workInfo.externalCodeRows.filter((row) => !row.replacementCode).length}`);
  console.log(`  error rows noted, not removed: ${unique(report.workInfo.errorWorkIds).length}`);
  console.log(`work_covers: ${report.workCovers.before} rows`);
  console.log(`  orphan works removed: ${unique(report.workCovers.orphanWorkIds).length}`);
  console.log(`  non-library video ids noted, not removed: ${unique(report.workCovers.nonLibraryVideoIds).length}`);
  console.log(`  empty blobs removed: ${unique(report.workCovers.emptyBlobWorkIds).length}`);
  console.log(`  total rows removed: ${coverDeleteIds.length}`);
  if (!options.writeChanges) console.log("\nAdd --write to apply these changes.");
}
