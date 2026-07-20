#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { decodeInfoBuffer, isSubtitleLikeInfoText, parseInfoMetadata } from "../lib/info-metadata.js";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_DB_PATH = path.join(PROJECT_ROOT, "data", "fanhao-core-v2.sqlite");
const MAX_INFO_BYTES = 1024 * 1024;
const MAX_JAVDB_RATING = 5;

const options = parseArgs(process.argv.slice(2));
const dbPath = path.resolve(options.dbPath || DEFAULT_DB_PATH);
if (!fs.existsSync(dbPath)) throw new Error(`找不到番号核心数据库：${dbPath}`);

const db = new DatabaseSync(dbPath, { readOnly: !options.write });
db.exec("PRAGMA busy_timeout = 5000");

const candidates = db.prepare(`
  SELECT
    w.id,
    w.code,
    w.title,
    w.rating,
    w.rating_count,
    w.source,
    (
      SELECT lw.source_info_path
      FROM local_works lw
      WHERE lw.work_id = w.id
        AND lw.source_info_path IS NOT NULL
        AND lw.source_info_path <> ''
      ORDER BY lw.id
      LIMIT 1
    ) AS source_info_path
  FROM works w
  WHERE w.rating > ?
  ORDER BY w.id
`).all(MAX_JAVDB_RATING);

const repairs = candidates.map(planRepair);
const summary = repairs.reduce(
  (result, item) => {
    result[item.action] += 1;
    if (item.error) result.infoErrors += 1;
    return result;
  },
  { restore: 0, clear: 0, infoErrors: 0 }
);

console.log(`番号评分修复：${options.write ? "write" : "dry-run"}`);
console.log(`数据库：${dbPath}`);
console.log(`越界评分：${repairs.length} · 可由本地资料恢复：${summary.restore} · 清空错误值：${summary.clear}`);
if (summary.infoErrors) console.log(`资料文件读取失败：${summary.infoErrors}`);

for (const item of repairs.filter((entry) => entry.action === "restore").slice(0, 12)) {
  console.log(`[restore] ${item.code || item.id}: ${item.rating} -> ${item.nextRating} (${item.nextRatingCount || 0} 人)`);
}
for (const item of repairs.filter((entry) => entry.action === "clear").slice(0, 8)) {
  console.log(`[clear] ${item.code || item.id}: ${item.rating} (${item.source || "unknown"})`);
}

if (!options.write) {
  console.log("未写入；加 --write 执行修复。");
  db.close();
  process.exit(0);
}

const update = db.prepare(`
  UPDATE works
  SET rating = ?, rating_count = ?, updated_at = ?
  WHERE id = ? AND rating > ?
`);
const updatedAt = new Date().toISOString();
const auditPath = path.join(os.tmpdir(), `fanhao-rating-repair-${updatedAt.replace(/[:.]/g, "-")}.json`);
fs.writeFileSync(
  auditPath,
  JSON.stringify(
    {
      createdAt: updatedAt,
      database: dbPath,
      items: repairs.map((item) => ({
        id: item.id,
        code: item.code,
        source: item.source,
        rating: item.rating,
        ratingCount: item.rating_count,
        nextRating: item.nextRating,
        nextRatingCount: item.nextRatingCount,
        action: item.action
      }))
    },
    null,
    2
  ),
  "utf8"
);
console.log(`回滚审计：${auditPath}`);
db.exec("BEGIN IMMEDIATE");
try {
  for (const item of repairs) {
    update.run(item.nextRating, item.nextRatingCount, updatedAt, item.id, MAX_JAVDB_RATING);
  }
  db.exec("COMMIT");
} catch (error) {
  db.exec("ROLLBACK");
  throw error;
}

const remaining = db.prepare("SELECT COUNT(*) AS count FROM works WHERE rating > ?").get(MAX_JAVDB_RATING).count;
db.close();
if (remaining !== 0) throw new Error(`修复后仍有 ${remaining} 条越界评分`);
console.log(`修复完成：写入 ${repairs.length} 条 · 剩余越界评分 ${remaining}`);

function planRepair(row) {
  const base = {
    ...row,
    code: String(row.code || "").trim(),
    nextRating: null,
    nextRatingCount: null,
    action: "clear",
    error: ""
  };
  const infoPath = String(row.source_info_path || "").trim();
  if (!infoPath) return base;

  try {
    const stat = fs.statSync(infoPath);
    if (!stat.isFile()) return { ...base, error: "资料路径不是文件" };
    if (stat.size > MAX_INFO_BYTES) return { ...base, error: `资料文件超过 ${MAX_INFO_BYTES} bytes` };

    const text = decodeInfoBuffer(fs.readFileSync(infoPath));
    if (isSubtitleLikeInfoText(text)) return { ...base, error: "资料文件疑似字幕" };
    const parsed = parseInfoMetadata(text, { title: row.title || row.code || "" });
    const rating = parsed.rating;
    if (!Number.isFinite(rating) || rating < 0 || rating > MAX_JAVDB_RATING) return base;

    const ratingCount = parsed.ratingCount;
    return {
      ...base,
      action: "restore",
      nextRating: rating,
      nextRatingCount: Number.isSafeInteger(ratingCount) && ratingCount >= 0 ? ratingCount : null
    };
  } catch (error) {
    return { ...base, error: String(error?.message || error) };
  }
}

function parseArgs(argv) {
  const result = { write: false, dbPath: "" };
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (item === "--write") result.write = true;
    else if (item === "--db") result.dbPath = argv[++index] || "";
    else if (item.startsWith("--db=")) result.dbPath = item.slice("--db=".length);
    else throw new Error(`未知参数：${item}`);
  }
  return result;
}
