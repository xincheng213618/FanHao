import fs from "node:fs";
import path from "node:path";
import process from "node:process";
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

if (!fs.existsSync(destination)) throw new Error(`目标媒体库不存在：${destination}`);
if (source.toLowerCase() === destination.toLowerCase()) throw new Error("新旧媒体库路径相同");

const databases = [
  { kind: "manager", file: path.resolve(args["manager-db"] || defaults.managerDb) },
  { kind: "fanhao", file: path.resolve(args["fanhao-db"] || defaults.fanhaoDb) }
];

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
  if (shouldApply) {
    const backupDir = path.join(path.dirname(target.file), "backups");
    fs.mkdirSync(backupDir, { recursive: true });
    const backupPath = path.join(backupDir, `${path.basename(target.file, ".sqlite")}-before-storage-migration-${timestampForFile()}.sqlite`);
    await backup(db, backupPath);
    console.log(`${target.kind}: 已备份 ${backupPath}`);
  }
  const candidates = textColumns(db);
  const replacements = [[from, to]];
  const escapedFrom = from.replaceAll("\\", "\\\\");
  const escapedTo = to.replaceAll("\\", "\\\\");
  if (escapedFrom !== from) replacements.push([escapedFrom, escapedTo]);
  let matches = 0;
  let changes = 0;

  if (shouldApply) db.exec("BEGIN IMMEDIATE");
  try {
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
    if (shouldApply) db.exec("COMMIT");
  } catch (error) {
    if (shouldApply) db.exec("ROLLBACK");
    throw error;
  }
  if (shouldApply) db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  db.close();
  return { matches, changes };
}

function textColumns(db) {
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all();
  const result = [];
  for (const { name } of tables) {
    for (const column of db.prepare(`PRAGMA table_info(${quoteIdentifier(name)})`).all()) {
      const type = String(column.type || "").toUpperCase();
      if (type.includes("TEXT") || type.includes("CHAR") || type.includes("CLOB")) {
        result.push({ table: name, column: column.name });
      }
    }
  }
  return result;
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
    if (key === "apply") {
      parsed.apply = true;
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
