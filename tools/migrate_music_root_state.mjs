import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { backup, DatabaseSync } from "node:sqlite";

const args = parseArgs(process.argv.slice(2));
const dbPath = path.resolve(args.db || path.join(process.cwd(), "data", "music.sqlite"));
const sourceDbPath = path.resolve(args["source-db"] || dbPath);
const fromRoot = requirePath(args.from, "--from");
const catalogPath = args.catalog ? path.resolve(args.catalog) : "";
const toRoot = catalogPath ? "" : requireDirectory(args.to, "--to");

const db = new DatabaseSync(dbPath);
const sourceDb = sourceDbPath === dbPath ? db : new DatabaseSync(sourceDbPath, { readOnly: true });
const catalogDb = catalogPath ? new DatabaseSync(catalogPath, { readOnly: true }) : null;
const backupDir = path.join(path.dirname(dbPath), "backups");
fs.mkdirSync(backupDir, { recursive: true });
const backupPath = path.join(backupDir, `music-before-root-migration-${timestampForFile()}.sqlite`);
await backup(db, backupPath);
const catalogLibraryRoot = catalogPath ? path.dirname(path.dirname(catalogPath)) : "";
const catalogTargets = new Map();
for (const row of catalogDb?.prepare(`
  SELECT s.original_relative_path,m.target_relative_path,ms.is_canonical,s.source_id
  FROM sources s
  JOIN media_sources ms ON ms.source_id = s.source_id
  JOIN media m ON m.media_id = ms.media_id
  ORDER BY ms.is_canonical DESC,s.source_id
`).all() || []) {
  const key = String(row.original_relative_path || "").toLowerCase();
  if (!catalogTargets.has(key)) catalogTargets.set(key, row.target_relative_path || "");
}
const tracks = sourceDb.prepare("SELECT id, source_path, size_bytes FROM music_tracks").all();
const mappings = [];
const missingTargets = [];

for (const track of tracks) {
  const relativePath = path.relative(fromRoot, track.source_path);
  if (!relativePath || relativePath.startsWith("..") || path.isAbsolute(relativePath)) continue;
  const catalogTarget = catalogTargets.get(relativePath.toLowerCase())
    || catalogTargets.get(path.win32.join("新增合集", relativePath).toLowerCase());
  const targetPath = catalogTarget
    ? path.resolve(catalogLibraryRoot, catalogTarget)
    : path.resolve(toRoot, relativePath);
  if (!fs.existsSync(targetPath)) {
    missingTargets.push(targetPath);
    continue;
  }
  const targetSize = fs.statSync(targetPath).size;
  if (Number(track.size_bytes || 0) && targetSize !== Number(track.size_bytes)) {
    throw new Error(`目标文件大小不一致: ${targetPath}`);
  }
  mappings.push({ oldId: track.id, newId: trackIdForPath(targetPath) });
}

if (missingTargets.length) {
  throw new Error(`有 ${missingTargets.length} 个迁移目标不存在，示例: ${missingTargets[0]}`);
}
if (!mappings.length) {
  throw new Error(`数据库中没有位于旧根目录下的歌曲: ${fromRoot}`);
}

const selectState = sourceDb.prepare("SELECT * FROM music_track_state WHERE track_id = ?");
const upsertState = db.prepare(`
  INSERT INTO music_track_state (
    track_id, favorite, rating, position_ms, duration_ms, play_count, last_played_at, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(track_id) DO UPDATE SET
    favorite = MAX(music_track_state.favorite, excluded.favorite),
    rating = CASE WHEN excluded.updated_at >= music_track_state.updated_at THEN excluded.rating ELSE music_track_state.rating END,
    position_ms = CASE WHEN excluded.updated_at >= music_track_state.updated_at THEN excluded.position_ms ELSE music_track_state.position_ms END,
    duration_ms = MAX(music_track_state.duration_ms, excluded.duration_ms),
    play_count = MAX(music_track_state.play_count, excluded.play_count),
    last_played_at = MAX(music_track_state.last_played_at, excluded.last_played_at),
    updated_at = MAX(music_track_state.updated_at, excluded.updated_at)
`);
const deleteState = db.prepare("DELETE FROM music_track_state WHERE track_id = ?");
const selectPlaylistItems = sourceDb.prepare("SELECT playlist_id, sort_order, added_at FROM music_playlist_items WHERE track_id = ?");
const insertPlaylistItem = db.prepare(`
  INSERT OR IGNORE INTO music_playlist_items (playlist_id, track_id, sort_order, added_at)
  VALUES (?, ?, ?, ?)
`);
const deletePlaylistItems = db.prepare("DELETE FROM music_playlist_items WHERE track_id = ?");

let migratedStates = 0;
let migratedPlaylistItems = 0;
let prunedOrphanStates = 0;
db.exec("BEGIN IMMEDIATE");
try {
  for (const mapping of mappings) {
    if (mapping.oldId === mapping.newId) continue;
    const state = selectState.get(mapping.oldId);
    if (state) {
      upsertState.run(
        mapping.newId,
        state.favorite,
        state.rating,
        state.position_ms,
        state.duration_ms,
        state.play_count,
        state.last_played_at,
        state.updated_at
      );
      if (sourceDb === db) deleteState.run(mapping.oldId);
      migratedStates += 1;
    }

    const playlistItems = selectPlaylistItems.all(mapping.oldId);
    for (const item of playlistItems) {
      insertPlaylistItem.run(item.playlist_id, mapping.newId, item.sort_order, item.added_at);
      migratedPlaylistItems += 1;
    }
    if (playlistItems.length && sourceDb === db) deletePlaylistItems.run(mapping.oldId);
  }
  if (args["prune-orphans"]) {
    prunedOrphanStates = db.prepare("DELETE FROM music_track_state WHERE track_id NOT IN (SELECT id FROM music_tracks)").run().changes;
    db.prepare("DELETE FROM music_playlist_items WHERE track_id NOT IN (SELECT id FROM music_tracks)").run();
  }
  db.exec("COMMIT");
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
} catch (error) {
  try {
    db.exec("ROLLBACK");
  } catch {}
  throw error;
} finally {
  if (sourceDb !== db) sourceDb.close();
  catalogDb?.close();
  db.close();
}

console.log(JSON.stringify({
  backupPath,
  dbPath,
  sourceDbPath,
  fromRoot,
  toRoot,
  catalogPath,
  mappedTracks: mappings.length,
  migratedStates,
  migratedPlaylistItems,
  prunedOrphanStates
}, null, 2));

function parseArgs(values) {
  const result = {};
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === "--prune-orphans") {
      result["prune-orphans"] = true;
      continue;
    }
    if (!["--db", "--source-db", "--from", "--to", "--catalog"].includes(value)) continue;
    result[value.slice(2)] = values[index + 1] || "";
    index += 1;
  }
  return result;
}

function requirePath(value, flag) {
  if (!value) throw new Error(`缺少 ${flag} 参数`);
  return path.resolve(value);
}

function requireDirectory(value, flag) {
  if (!value) throw new Error(`缺少 ${flag} 参数`);
  const resolved = path.resolve(value);
  if (!fs.statSync(resolved, { throwIfNoEntry: false })?.isDirectory()) {
    throw new Error(`目录不存在: ${resolved}`);
  }
  return resolved;
}

function trackIdForPath(filePath) {
  return crypto
    .createHash("sha1")
    .update(`track:${path.resolve(filePath).toLowerCase()}`)
    .digest("hex")
    .slice(0, 24);
}

function timestampForFile() {
  return new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}
