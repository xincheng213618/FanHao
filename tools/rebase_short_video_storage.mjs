import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import crypto from "node:crypto";
import { backup, DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const defaults = {
  from: "D:\\Media\\FanHao\\ShortVideos\\Douyin\\Library",
  to: "D:\\Media\\ShortVideos",
  storageRoot: "D:\\Media",
  managerDb: path.join(projectRoot, "src", "modules", "short-videos", "download-manager", "data", "douyin_downloads.sqlite"),
  fanhaoDb: path.join(projectRoot, "data", "short-videos.sqlite")
};

const args = parseArgs(process.argv.slice(2));
const source = path.resolve(args.from || defaults.from);
const destination = path.resolve(args.to || defaults.to);
const storageRoot = path.resolve(args["storage-root"] || defaults.storageRoot);
const apply = Boolean(args.apply);
if (apply && !args["offline-confirmed"]) {
  throw new Error("存储重定位必须先停止 FanHao/下载器写入，再显式传入 --offline-confirmed");
}

if (!fs.existsSync(destination) && (apply || !args["allow-missing-destination"])) throw new Error(`目标媒体库不存在：${destination}`);
if (source.toLowerCase() === destination.toLowerCase()) throw new Error("新旧媒体库路径相同");

const databases = [
  { kind: "manager", file: path.resolve(args["manager-db"] || defaults.managerDb) },
  { kind: "fanhao", file: path.resolve(args["fanhao-db"] || defaults.fanhaoDb) }
];

// Validate all databases before the manager can be changed. Historical delete
// receipts remain immutable; a completed tombstone may only gain a new alias.
for (const target of databases) {
  if (!fs.existsSync(target.file)) throw new Error(`数据库不存在：${target.file}`);
  if (target.kind === "fanhao" && (apply || args["check-offline"])) {
    const db = new DatabaseSync(target.file, { readOnly: true });
    try { assertDeleteProtocolOfflineBoundary(db, source); } finally { db.close(); }
  }
}
if (args["preflight-only"]) {
  if (!args["check-offline"] || apply) throw new Error("--preflight-only 必须配合 --check-offline，且不能配合 --apply");
  if (args["cover-db"] && !fs.existsSync(path.resolve(args["cover-db"]))) throw new Error("封面数据库不存在");
  console.log("离线边界和数据库路径预检通过；未修改数据。");
  process.exit(0);
}

let totalMatches = 0;
let totalChanges = 0;
for (const target of databases) {
  if (!fs.existsSync(target.file)) throw new Error(`数据库不存在：${target.file}`);
  const result = await inspectOrRebase(target, source, destination, storageRoot, apply);
  totalMatches += result.matches;
  totalChanges += result.changes;
}

console.log(`${apply ? "已更新" : "预检查"}：匹配 ${totalMatches} 处，修改 ${totalChanges} 行`);
if (!apply) console.log("未写入数据库；复制校验通过后使用 --apply 执行切换。");

async function inspectOrRebase(target, from, to, managerStorageRoot, shouldApply) {
  const db = new DatabaseSync(target.file, { readOnly: !shouldApply });
  db.exec("PRAGMA busy_timeout = 10000");
  if (shouldApply && target.kind === "fanhao") assertDeleteProtocolOfflineBoundary(db, from);
  if (shouldApply && !args["no-backup"]) {
    const backupDir = path.join(path.dirname(target.file), "backups");
    fs.mkdirSync(backupDir, { recursive: true });
    const backupPath = path.join(backupDir, `${path.basename(target.file, ".sqlite")}-before-storage-migration-${timestampForFile()}.sqlite`);
    await backup(db, backupPath);
    console.log(`${target.kind}: 已备份 ${backupPath}`);
  }
  if (shouldApply && args["no-backup"]) console.log(`${target.kind}: 按要求跳过数据库备份`);
  let coverRows = [];
  if (shouldApply && target.kind === "fanhao" && args["cover-db"]) {
    const coverPath = path.resolve(args["cover-db"]);
    if (!fs.existsSync(coverPath)) throw new Error(`封面数据库不存在：${coverPath}`);
    db.prepare("ATTACH DATABASE ? AS migration_covers").run(coverPath);
    coverRows = db.prepare(`
      SELECT v.id, v.source_path, v.size_bytes, v.mtime_ms, c.generation_version, c.source_fingerprint
      FROM short_videos v JOIN migration_covers.short_video_covers c ON c.video_id = v.id
      WHERE instr(v.source_path, ?) > 0
    `).all(from);
  }
  const candidates = textColumns(db, {
    excludedTables: target.kind === "fanhao" ? shortVideoDeleteProtocolTables() : new Set()
  });
  const replacements = [[from, to]];
  const escapedFrom = from.replaceAll("\\", "\\\\");
  const escapedTo = to.replaceAll("\\", "\\\\");
  if (escapedFrom !== from) replacements.push([escapedFrom, escapedTo]);
  let matches = 0;
  let changes = 0;

  if (shouldApply) db.exec("BEGIN IMMEDIATE");
  try {
    if (shouldApply && target.kind === "fanhao" && args["preserve-completed-tombstones"]) {
      preserveCompletedTombstoneAliases(db, from, to);
    }
    for (const candidate of candidates) {
      const table = quoteIdentifier(candidate.table);
      const column = quoteIdentifier(candidate.column);
      for (const [oldValue, newValue] of replacements) {
        const count = Number(db.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE instr(${column}, ?) > 0`).get(oldValue)?.count || 0);
        if (!count) continue;
        matches += count;
        console.log(`${target.kind}: ${candidate.table}.${candidate.column} = ${count}${oldValue === escapedFrom && escapedFrom !== from ? " (JSON)" : ""}`);
        if (shouldApply) {
          changes += Number(db.prepare(`UPDATE ${table} SET ${column} = replace(${column}, ?, ?) WHERE instr(${column}, ?) > 0`).run(oldValue, newValue, oldValue).changes);
        }
      }
    }

    if (target.kind === "manager") {
      const settings = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='settings'").get();
      if (settings) {
        for (const [key, value] of [["output_dir", managerStorageRoot], ["library_output_dir", to]]) {
          const current = db.prepare("SELECT value FROM settings WHERE key = ?").get(key)?.value || "";
          if (current !== value) {
            matches += 1;
            console.log(`manager: settings.${key}: ${current} -> ${value}`);
            if (shouldApply) {
              changes += Number(db.prepare("INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(key, value).changes);
            }
          }
        }
      }
    }
    if (shouldApply && coverRows.length) {
      const update = db.prepare("UPDATE migration_covers.short_video_covers SET source_fingerprint = ? WHERE video_id = ? AND source_fingerprint = ?");
      let preserved = 0;
      for (const row of coverRows) {
        if (coverFingerprint(row, row.source_path) !== row.source_fingerprint) continue;
        preserved += Number(update.run(coverFingerprint(row, row.source_path.replaceAll(from, to)), row.id, row.source_fingerprint).changes);
      }
      console.log(`fanhao: 保留 ${preserved} 个已有封面，仅更新路径指纹`);
    }
    if (shouldApply && target.kind === "fanhao") assertShortVideoReferenceProjection(db);
    if (shouldApply) db.exec("COMMIT");
  } catch (error) {
    if (shouldApply) db.exec("ROLLBACK");
    throw error;
  }
  if (shouldApply) db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  db.close();
  return { matches, changes };
}

function textColumns(db, { excludedTables = new Set() } = {}) {
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all();
  const result = [];
  for (const { name } of tables) {
    if (excludedTables.has(name)) continue;
    for (const column of db.prepare(`PRAGMA table_info(${quoteIdentifier(name)})`).all()) {
      const type = String(column.type || "").toUpperCase();
      if (type.includes("TEXT") || type.includes("CHAR") || type.includes("CLOB")) {
        result.push({ table: name, column: column.name });
      }
    }
  }
  return result;
}

function shortVideoDeleteProtocolTables() {
  return new Set([
    "short_video_delete_jobs",
    "short_video_delete_operations",
    "short_video_delete_items",
    "short_video_delete_reservations",
    "short_video_delete_fs_actions",
    "short_video_delete_video_tombstones",
    "short_video_path_references",
    "short_video_path_tombstones"
  ]);
}

function assertDeleteProtocolOfflineBoundary(db, from) {
  const tableNames = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((row) => row.name));
  if (tableNames.has("short_video_delete_jobs")) {
    const active = Number(db.prepare(`
      SELECT COUNT(*) AS count FROM short_video_delete_jobs
      WHERE status IN ('running', 'rollback_pending', 'cleanup_pending') OR owner_id <> ''
    `).get()?.count || 0);
    if (active) throw new Error("短视频删除作业仍在运行；拒绝离线存储重定位");
  }
  if (tableNames.has("short_video_path_tombstones")) {
    const tombstones = Number(db.prepare(`
      SELECT COUNT(*) AS count FROM short_video_path_tombstones
      WHERE state = 'active' AND instr(original_path, ?) > 0
    `).get(from)?.count || 0);
    if (tombstones && !args["preserve-completed-tombstones"]) {
      throw new Error("旧存储根仍有短视频删除墓碑；必须先由受控恢复流程处理，不能批量改写内部安全表");
    }
    if (tombstones) completedTombstoneRows(db, from);
  }
}

function completedTombstoneRows(db, from) {
  const rows = db.prepare(`
    SELECT tombstone.*, job.status AS job_status
    FROM short_video_path_tombstones tombstone
    LEFT JOIN short_video_delete_jobs job ON job.id = tombstone.job_id
    WHERE tombstone.state = 'active' AND instr(tombstone.original_path, ?) > 0
  `).all(from);
  for (const row of rows) {
    if (row.job_status !== "completed") throw new Error("删除墓碑不属于已完成作业，拒绝迁移");
    if (fs.existsSync(row.original_path)) throw new Error("已删除路径仍有文件，拒绝迁移墓碑");
  }
  return rows;
}

function preserveCompletedTombstoneAliases(db, from, to) {
  const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row => row.name));
  if (!tables.has("short_video_path_tombstones")) return;
  const rows = completedTombstoneRows(db, from);
  const insert = db.prepare(`INSERT OR IGNORE INTO short_video_path_tombstones
    (path_key, job_id, original_path, real_path_key, identity_key, state, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
  const read = db.prepare("SELECT * FROM short_video_path_tombstones WHERE path_key = ?");
  const keyFrom = from.replaceAll("\\", "/").toLowerCase();
  const keyTo = to.replaceAll("\\", "/").toLowerCase();
  let added = 0;
  for (const row of rows) {
    const originalPath = row.original_path.replaceAll(from, to);
    const key = row.path_key.replaceAll(keyFrom, keyTo);
    if (fs.existsSync(originalPath)) throw new Error("目标目录出现已删除路径，拒绝切换");
    const current = read.get(key);
    if (current && (current.job_id !== row.job_id || current.state !== row.state || current.original_path !== originalPath)) {
      throw new Error("目标目录删除墓碑冲突，拒绝切换");
    }
    added += Number(insert.run(key, row.job_id, originalPath,
      row.real_path_key.replaceAll(keyFrom, keyTo), row.identity_key,
      row.state, row.created_at, row.updated_at).changes);
  }
  console.log(`fanhao: 保留历史删除回执，新增 ${added} 个目标路径保护`);
}

function coverFingerprint(row, sourcePath) {
  return crypto.createHash("sha1").update([
    sourcePath, Math.max(0, Math.floor(Number(row.size_bytes || 0))),
    Math.max(0, Math.floor(Number(row.mtime_ms || 0))), Number(row.generation_version || 1)
  ].join(":"), "utf8").digest("hex");
}

function assertShortVideoReferenceProjection(db) {
  const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((row) => row.name));
  if (!tables.has("short_video_path_references")) return;
  const mismatch = Number(db.prepare(`
    WITH expected AS (
      SELECT 'short_videos' owner_table, id owner_key, id owner_video_id, 'source_path' path_column,
             trim(source_path) raw_path, lower(replace(trim(source_path), char(92), '/')) path_key
      FROM short_videos WHERE trim(source_path) <> ''
      UNION ALL SELECT 'short_videos', id, id, 'cover_path', trim(cover_path), lower(replace(trim(cover_path), char(92), '/'))
      FROM short_videos WHERE trim(cover_path) <> ''
      UNION ALL SELECT 'short_videos', id, id, 'music_path', trim(music_path), lower(replace(trim(music_path), char(92), '/'))
      FROM short_videos WHERE trim(music_path) <> ''
      UNION ALL SELECT 'short_videos', id, id, 'data_path', trim(data_path), lower(replace(trim(data_path), char(92), '/'))
      FROM short_videos WHERE trim(data_path) <> ''
      UNION ALL SELECT 'short_video_assets', id, video_id, 'local_path', trim(local_path), lower(replace(trim(local_path), char(92), '/'))
      FROM short_video_assets WHERE trim(local_path) <> ''
    )
    SELECT COUNT(*) AS count FROM (
      SELECT * FROM (
        SELECT owner_table, owner_key, owner_video_id, path_column, raw_path, path_key FROM expected
        EXCEPT
        SELECT owner_table, owner_key, owner_video_id, path_column, raw_path, path_key FROM short_video_path_references
      )
      UNION ALL
      SELECT * FROM (
        SELECT owner_table, owner_key, owner_video_id, path_column, raw_path, path_key FROM short_video_path_references
        EXCEPT
        SELECT owner_table, owner_key, owner_video_id, path_column, raw_path, path_key FROM expected
      )
    )
  `).get()?.count || 0);
  if (mismatch) throw new Error("存储重定位后短视频路径引用投影对账失败");
}

function quoteIdentifier(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

function parseArgs(values) {
  const parsed = {};
  for (let index = 0; index < values.length; index += 1) {
    const token = values[index];
    if (!token.startsWith("--")) throw new Error(`无法识别参数：${token}`);
    const key = token.slice(2);
    if (["apply", "offline-confirmed", "no-backup", "allow-missing-destination", "check-offline", "preflight-only", "preserve-completed-tombstones"].includes(key)) {
      parsed[key] = true;
      continue;
    }
    const value = values[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`参数 --${key} 缺少值`);
    parsed[key] = value;
    index += 1;
  }
  return parsed;
}

function timestampForFile() {
  return new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}
