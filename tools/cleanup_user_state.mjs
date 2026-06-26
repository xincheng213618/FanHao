import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_STATE_PATH = path.join(PROJECT_ROOT, "data", "user-state.json");
const DEFAULT_INDEX_PATH = path.join(PROJECT_ROOT, "data", "library-index.json");
const DEFAULT_FAVORITE_FOLDER_ID = "default";
const DEFAULT_FAVORITE_FOLDER_NAME = "默认收藏";

const options = parseArgs(process.argv.slice(2));
const statePath = path.resolve(options.state || DEFAULT_STATE_PATH);
const indexPath = path.resolve(options.index || DEFAULT_INDEX_PATH);
const writeChanges = Boolean(options.write);
const dropZeroProgress = Boolean(options["drop-zero-progress"]);
const historyDays = positiveNumber(options["history-days"]);
const maxHistory = positiveInteger(options["max-history"]);

const state = readJson(statePath);
const index = readJson(indexPath);
const library = collectLibraryIds(index);
const report = {
  favoriteFolders: {
    before: Object.keys(state.favoriteFolders || {}).length,
    removedInvalidFolders: 0,
    addedDefaultFolder: 0,
    after: 0
  },
  favorites: {
    before: Object.keys(state.favorites || {}).length,
    removedMissingWorks: 0,
    repairedFolderIds: 0,
    after: 0
  },
  progress: {
    before: Object.keys(state.progress || {}).length,
    removedMissingVideos: 0,
    removedInvalidRows: 0,
    removedZeroRows: 0,
    removedOldRows: 0,
    removedOverflowRows: 0,
    repairedWorkIds: 0,
    after: 0
  }
};

const favoriteFolders = cleanFavoriteFolders(state.favoriteFolders || {}, report);
const nextState = {
  ...state,
  favoriteFolders,
  favorites: cleanFavorites(state.favorites || {}, library.validWorkIds, favoriteFolders, report),
  progress: cleanProgress(state.progress || {}, library, report)
};

report.favoriteFolders.after = Object.keys(nextState.favoriteFolders).length;
report.favorites.after = Object.keys(nextState.favorites).length;
report.progress.after = Object.keys(nextState.progress).length;

printReport(report, { writeChanges, statePath, indexPath, historyDays, maxHistory, dropZeroProgress });

if (writeChanges) {
  fs.writeFileSync(statePath, `${JSON.stringify(nextState, null, 2)}\n`, "utf8");
}

function parseArgs(args) {
  const result = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2);
    if (key === "write" || key === "drop-zero-progress") {
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
  const validWorkIds = new Set();
  const validVideoIds = new Set();
  const videoWorkIds = new Map();
  for (const work of index.works || []) {
    if (!work?.id) continue;
    validWorkIds.add(work.id);
    for (const video of work.videos || []) {
      if (!video?.id) continue;
      validVideoIds.add(video.id);
      videoWorkIds.set(video.id, work.id);
    }
  }
  return { validWorkIds, validVideoIds, videoWorkIds };
}

function cleanFavoriteFolderName(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 32);
}

function cleanFavoriteFolders(folders, report) {
  const result = {};
  for (const [rawId, rawFolder] of Object.entries(folders || {})) {
    const id = String(rawId || "").trim();
    const folder = rawFolder && typeof rawFolder === "object" ? rawFolder : {};
    const name = cleanFavoriteFolderName(folder.name) || (id === DEFAULT_FAVORITE_FOLDER_ID ? DEFAULT_FAVORITE_FOLDER_NAME : "");
    if (!id || id.length > 96 || !name) {
      report.favoriteFolders.removedInvalidFolders += 1;
      continue;
    }
    result[id] = {
      name,
      createdAt: String(folder.createdAt || "")
    };
  }

  if (!result[DEFAULT_FAVORITE_FOLDER_ID]) {
    result[DEFAULT_FAVORITE_FOLDER_ID] = {
      name: DEFAULT_FAVORITE_FOLDER_NAME,
      createdAt: ""
    };
    report.favoriteFolders.addedDefaultFolder = 1;
  }
  return result;
}

function cleanFavorites(favorites, validWorkIds, folders, report) {
  const result = {};
  for (const [workId, favorite] of Object.entries(favorites)) {
    if (!validWorkIds.has(workId)) {
      report.favorites.removedMissingWorks += 1;
      continue;
    }
    result[workId] = cleanFavoriteRecord(favorite, folders, report);
  }
  return result;
}

function cleanFavoriteRecord(favorite, folders, report) {
  if (!favorite || typeof favorite !== "object" || Array.isArray(favorite)) return favorite;
  const result = { ...favorite };
  const folderId = String(result.folderId || "").trim();
  if (folderId && !folders[folderId]) {
    result.folderId = DEFAULT_FAVORITE_FOLDER_ID;
    report.favorites.repairedFolderIds += 1;
  }
  return result;
}

function cleanProgress(progress, library, report) {
  const rows = [];
  const cutoff = historyDays ? Date.now() - historyDays * 24 * 60 * 60 * 1000 : null;
  for (const [videoId, row] of Object.entries(progress)) {
    if (!library.validVideoIds.has(videoId)) {
      report.progress.removedMissingVideos += 1;
      continue;
    }
    if (!isValidProgress(row)) {
      report.progress.removedInvalidRows += 1;
      continue;
    }
    if (dropZeroProgress && Number(row.position || 0) <= 1) {
      report.progress.removedZeroRows += 1;
      continue;
    }
    const updatedAt = Date.parse(row.updatedAt || "");
    if (cutoff && Number.isFinite(updatedAt) && updatedAt < cutoff) {
      report.progress.removedOldRows += 1;
      continue;
    }

    const nextRow = { ...row };
    const workId = library.videoWorkIds.get(videoId);
    if (workId && row.workId !== workId) {
      nextRow.workId = workId;
      report.progress.repairedWorkIds += 1;
    }
    rows.push([videoId, nextRow]);
  }

  const keptRows = maxHistory ? rows.sort((a, b) => progressTime(b[1]) - progressTime(a[1])).slice(0, maxHistory) : rows;
  report.progress.removedOverflowRows = rows.length - keptRows.length;
  return Object.fromEntries(keptRows);
}

function isValidProgress(row) {
  if (!row || typeof row !== "object") return false;
  const duration = Number(row.duration);
  const position = Number(row.position);
  return Number.isFinite(duration) && duration > 0 && Number.isFinite(position) && position >= 0;
}

function progressTime(row) {
  const timestamp = Date.parse(row.updatedAt || "");
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function positiveNumber(value) {
  if (value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function positiveInteger(value) {
  const number = positiveNumber(value);
  return number ? Math.floor(number) : null;
}

function printReport(report, options) {
  console.log(`user-state: ${options.statePath}`);
  console.log(`library-index: ${options.indexPath}`);
  console.log(options.writeChanges ? "mode: write" : "mode: dry-run");
  if (options.historyDays) console.log(`history-days: ${options.historyDays}`);
  if (options.maxHistory) console.log(`max-history: ${options.maxHistory}`);
  if (options.dropZeroProgress) console.log("drop-zero-progress: true");
  console.log("");
  console.log(`favorite folders: ${report.favoriteFolders.before} -> ${report.favoriteFolders.after}`);
  console.log(`  invalid folders removed: ${report.favoriteFolders.removedInvalidFolders}`);
  console.log(`  default folder added: ${report.favoriteFolders.addedDefaultFolder}`);
  console.log(`favorites: ${report.favorites.before} -> ${report.favorites.after}`);
  console.log(`  missing works removed: ${report.favorites.removedMissingWorks}`);
  console.log(`  folder ids repaired: ${report.favorites.repairedFolderIds}`);
  console.log(`progress: ${report.progress.before} -> ${report.progress.after}`);
  console.log(`  missing videos removed: ${report.progress.removedMissingVideos}`);
  console.log(`  invalid rows removed: ${report.progress.removedInvalidRows}`);
  console.log(`  zero rows removed: ${report.progress.removedZeroRows}`);
  console.log(`  old rows removed: ${report.progress.removedOldRows}`);
  console.log(`  overflow rows removed: ${report.progress.removedOverflowRows}`);
  console.log(`  work ids repaired: ${report.progress.repairedWorkIds}`);
  if (!options.writeChanges) console.log("\nAdd --write to apply these changes.");
}
