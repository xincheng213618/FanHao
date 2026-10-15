import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const projectRoot = path.resolve(path.dirname(__filename), "..");
const syncScript = path.join(projectRoot, "tools", "sync_core_info_metadata.mjs");
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "fanhao-core-info-sync-"));

try {
  const personRoot = path.join(tempRoot, "Fixture Actor");
  const localWorkDir = path.join(personRoot, "IPZZ-932 local fixture");
  const remoteWorkDir = path.join(personRoot, "REMOTE-001 authority fixture");
  fs.mkdirSync(localWorkDir, { recursive: true });
  fs.mkdirSync(remoteWorkDir, { recursive: true });

  const localInfoPath = path.join(localWorkDir, "info.txt");
  const remoteInfoPath = path.join(remoteWorkDir, "info.txt");
  fs.writeFileSync(localInfoPath, [
    "番号: IPZZ-932",
    "标题: Parsed local title",
    "发行日期: 2026-08-24",
    "时长: 147 分钟",
    "评分: 4.7 分，由 321 人评价",
    "导演: Local Director",
    "简介: Local full scan metadata"
  ].join("\n"), "utf8");
  fs.writeFileSync(remoteInfoPath, [
    "番号: REMOTE-001",
    "标题: Sidecar title must not replace authority",
    "发行日期: 2026-02-03",
    "时长: 98 分钟",
    "评分: 4.2 分，由 45 人评价",
    "导演: Filled Director",
    "简介: Filled from local info"
  ].join("\n"), "utf8");

  const databasePath = path.join(tempRoot, "fanhao-core-v2.sqlite");
  const setupDatabase = new DatabaseSync(databasePath);
  setupDatabase.exec(`
    CREATE TABLE works (
      id INTEGER PRIMARY KEY,
      code TEXT,
      code_search TEXT,
      title TEXT,
      release_date TEXT,
      duration_minutes INTEGER,
      rating REAL,
      rating_count INTEGER,
      director TEXT,
      description TEXT,
      raw_text TEXT,
      fields_json TEXT,
      javdb_tags_json TEXT,
      source TEXT,
      status TEXT,
      error TEXT,
      updated_at TEXT
    );
    CREATE TABLE local_works (
      id INTEGER PRIMARY KEY,
      work_id INTEGER NOT NULL,
      local_path TEXT NOT NULL,
      source_info_path TEXT
    );
    CREATE TABLE local_files (
      id INTEGER PRIMARY KEY,
      local_work_id INTEGER NOT NULL,
      file_path TEXT NOT NULL,
      name TEXT,
      ext TEXT,
      size INTEGER,
      modified_at TEXT,
      file_type TEXT,
      sort_order INTEGER
    );
  `);

  const insertWork = setupDatabase.prepare(`
    INSERT INTO works (
      id, code, code_search, title, release_date, duration_minutes, rating,
      rating_count, director, description, raw_text, fields_json,
      javdb_tags_json, source, status, error, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  insertWork.run(
    1, "OLD-001", "old001", "Stale local title", "1999-01-01", 1, 1.1,
    1, "Stale Director", "Stale description", "stale raw", "[]", "[]",
    "local_full_scan", "pending", "stale metadata", "2000-01-01T00:00:00.000Z"
  );
  insertWork.run(
    2, "REMOTE-001", "remote001", "Authoritative remote title", "2025-04-05", null, null,
    null, null, null, null, "[]", "[]", "actor_movies", "ok", null,
    "2025-04-05T00:00:00.000Z"
  );

  const insertLocalWork = setupDatabase.prepare(
    "INSERT INTO local_works (id, work_id, local_path, source_info_path) VALUES (?, ?, ?, ?)"
  );
  insertLocalWork.run(11, 1, localWorkDir, localInfoPath);
  insertLocalWork.run(22, 2, remoteWorkDir, remoteInfoPath);

  const insertLocalFile = setupDatabase.prepare(`
    INSERT INTO local_files (
      id, local_work_id, file_path, name, ext, size, modified_at, file_type, sort_order
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'info', 0)
  `);
  const localStat = fs.statSync(localInfoPath);
  const remoteStat = fs.statSync(remoteInfoPath);
  insertLocalFile.run(111, 11, localInfoPath, "info.txt", ".txt", localStat.size, localStat.mtime.toISOString());
  insertLocalFile.run(222, 22, remoteInfoPath, "info.txt", ".txt", remoteStat.size, remoteStat.mtime.toISOString());
  setupDatabase.close();

  const beforeDryRun = readWorkRows(databasePath);
  const dryRun = runSync(databasePath, personRoot);
  assert.equal(dryRun.mode, "dry-run");
  assert.deepEqual(pickStats(dryRun.stats), {
    localWorksSeen: 2,
    worksSeen: 2,
    parsed: 2,
    updated: 0,
    wouldUpdate: 2,
    unchanged: 0,
    missing: 0,
    errors: 0
  });
  assert.deepEqual(dryRun.stats.errorItems, []);
  assert.deepEqual(
    readWorkRows(databasePath),
    beforeDryRun,
    "dry-run must report pending changes without mutating core works"
  );

  const writeRun = runSync(databasePath, personRoot, { write: true });
  assert.equal(writeRun.mode, "write");
  assert.equal(writeRun.stats.updated, 2);
  assert.equal(writeRun.stats.wouldUpdate, 0);
  assert.equal(writeRun.stats.errors, 0);

  const [localRow, remoteRow] = readWorkRows(databasePath);
  assert.deepEqual(
    pickMetadata(localRow),
    {
      title: "Parsed local title",
      release_date: "2026-08-24",
      duration_minutes: 147,
      rating: 4.7,
      rating_count: 321
    },
    "local_full_scan works must replace stale core metadata with the complete info.txt payload"
  );
  assert.equal(localRow.code, "IPZZ-932");
  assert.equal(localRow.code_search, "ipzz932");
  assert.equal(localRow.source, "local_full_scan");
  assert.equal(localRow.status, "ok");
  assert.equal(localRow.error, null);

  assert.deepEqual(
    pickMetadata(remoteRow),
    {
      title: "Authoritative remote title",
      release_date: "2025-04-05",
      duration_minutes: 98,
      rating: 4.2,
      rating_count: 45
    },
    "non-local works must preserve authoritative title/date while filling empty numeric metadata"
  );
  assert.equal(remoteRow.director, "Filled Director");
  assert.equal(remoteRow.description, "Filled from local info");
  assert.equal(remoteRow.source, "actor_movies");

  console.log("core info metadata sync regression passed");
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true });
}

function runSync(databasePath, personRoot, options = {}) {
  const args = [syncScript, "--db", databasePath, "--person-dir", personRoot];
  if (options.write) args.push("--write");
  const result = spawnSync(process.execPath, args, {
    cwd: projectRoot,
    encoding: "utf8",
    windowsHide: true
  });
  assert.equal(
    result.status,
    0,
    `metadata sync exited with ${result.status}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`
  );
  const line = String(result.stdout || "").split(/\r?\n/).find((item) => item.startsWith("[metadata] "));
  assert.ok(line, `metadata sync did not print its summary: ${result.stdout}`);
  const match = /^\[metadata\] mode=(dry-run|write) stats=(\{.*\})$/.exec(line);
  assert.ok(match, `metadata sync summary was malformed: ${line}`);
  return { mode: match[1], stats: JSON.parse(match[2]) };
}

function readWorkRows(databasePath) {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    return database.prepare(`
      SELECT id, code, code_search, title, release_date, duration_minutes,
             rating, rating_count, director, description, raw_text,
             fields_json, javdb_tags_json, source, status, error, updated_at
      FROM works
      ORDER BY id ASC
    `).all();
  } finally {
    database.close();
  }
}

function pickMetadata(row) {
  return {
    title: row.title,
    release_date: row.release_date,
    duration_minutes: row.duration_minutes,
    rating: row.rating,
    rating_count: row.rating_count
  };
}

function pickStats(stats) {
  return {
    localWorksSeen: stats.localWorksSeen,
    worksSeen: stats.worksSeen,
    parsed: stats.parsed,
    updated: stats.updated,
    wouldUpdate: stats.wouldUpdate,
    unchanged: stats.unchanged,
    missing: stats.missing,
    errors: stats.errors
  };
}
