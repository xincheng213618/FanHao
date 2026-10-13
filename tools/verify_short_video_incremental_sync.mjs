import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { spawnSync } from "node:child_process";
import { createShortVideoStore } from "../src/modules/short-videos/server/store.js";
import { createDownloadManagerSyncService } from "../src/modules/short-videos/server/download-manager-sync-service.js";
import { DOWNLOAD_MANAGER_CHANGE_CURSOR } from "../src/modules/short-videos/server/download-manager-change-journal.js";
import { installFixtureSyncJournal } from "./fixtures/short-video-sync-journal.mjs";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "fanhao-incremental-sync-"));
const sourcePath = path.join(root, "manager.sqlite"), targetPath = path.join(root, "catalog.sqlite");
let source, target, store, service;
const originalPrepare = DatabaseSync.prototype.prepare;
let trace = null;
DatabaseSync.prototype.prepare = function(sql) {
  const statement = originalPrepare.call(this, sql);
  if (!trace || path.resolve(this.location() || "") !== sourcePath) return statement;
  const entry = { sql, rows: 0, calls: 0, plan: [] };
  if (/^\s*SELECT\b/i.test(sql) && /\b(?:links|profiles|library_sync_memberships)\b/.test(sql)) {
    entry.plan = originalPrepare.call(this, `EXPLAIN QUERY PLAN ${sql}`).all(...Array(statement.expandedSQL.split("?").length - 1).fill(null));
  }
  trace.push(entry);
  return new Proxy(statement, { get(target, key) {
    const value = Reflect.get(target, key, target);
    if (typeof value !== "function") return value;
    return (...args) => {
      const result = Reflect.apply(value, target, args);
      entry.calls++;
      if (key === "all") entry.rows += result.length;
      else if (key === "get" && result) entry.rows++;
      return result;
    };
  } });
};

function ioReadBytes() {
  if (process.platform === "win32") {
    const result = spawnSync("powershell.exe", ["-NoProfile", "-Command",
      `(Get-CimInstance Win32_Process -Filter 'ProcessId = ${process.pid}').ReadTransferCount`], { encoding: "utf8", timeout: 10_000 });
    return result.status === 0 && /^\s*\d+\s*$/.test(result.stdout) ? Number(result.stdout.trim()) : null;
  }
  try { return Number(fs.readFileSync("/proc/self/io", "utf8").match(/^rchar:\s*(\d+)/m)?.[1]); } catch { return null; }
}
function measured(label, run) {
  const before = ioReadBytes(); trace = [];
  const start = performance.now();
  try {
    const result = run(), ms = performance.now() - start, queries = trace;
    trace = null;
    const after = ioReadBytes();
    const measurement = { label, ms: Math.round(ms * 100) / 100,
      logicalReadBytes: before === null || after === null ? null : after - before,
      sourceRows: queries.filter(q => /^\s*SELECT\b/i.test(q.sql) && /\b(?:links|profiles|library_sync_memberships)\b/.test(q.sql)).reduce((sum,q) => sum + q.rows, 0) };
    console.log(JSON.stringify(measurement));
    return { result, queries, ...measurement };
  } finally { trace = null; }
}
function sync(extra = {}) { return store.importDownloadManagerDb(sourcePath, { incremental: true, includePosts: true, skipSummary: true, ...extra }); }
function drain(extra = {}) {
  const results = [];
  for (let i = 0; i < 100; i++) {
    const result = sync(extra); results.push(result);
    assert.ok(result.ok);
    assert.ok((result.changesRead || 0) + (result.repairCount || 0) <= (extra.batchSize || 500));
    if (!result.hasMore) return results;
  }
  throw new Error("fixture backlog did not drain");
}
function video(id) { return target.prepare("SELECT id,title,author_name,is_liked,digg_count,source_path FROM short_videos WHERE id=?").get(id); }
function cursor() { return target.prepare("SELECT value FROM short_video_meta WHERE key=?").get(DOWNLOAD_MANAGER_CHANGE_CURSOR)?.value; }
function addLink(id, profileId, aweme, status = "downloaded", metadata = "{}") {
  const media = path.join(root, `${aweme}.mp4`);
  if (status === "downloaded") fs.writeFileSync(media, "fixture media");
  source.prepare(`INSERT INTO links(id,profile_id,aweme_id,status,kind,media_type,local_file_paths,
    downloaded_at,metadata_json,last_seen_at,digg_count,desc)
    VALUES(?,?,?,?,'video','video',?,'2026-01-01',?,'2026-01-01',1,?)`)
    .run(id,profileId,aweme,status,JSON.stringify([media]),metadata,`video ${aweme}`);
}

try {
  source = new DatabaseSync(sourcePath);
  source.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
    CREATE TABLE profiles(id INTEGER PRIMARY KEY,sec_uid TEXT,tab TEXT,url TEXT,nickname TEXT,
      profile_collected_at TEXT,updated_at TEXT,account_status TEXT DEFAULT 'active',account_status_reason TEXT,
      account_status_detected_at TEXT);
    CREATE TABLE links(id INTEGER PRIMARY KEY,profile_id INTEGER REFERENCES profiles(id) ON DELETE SET NULL,
      aweme_id TEXT,status TEXT,kind TEXT,media_type TEXT,local_file_paths TEXT,downloaded_at TEXT,
      metadata_json TEXT,last_seen_at TEXT,is_missing_from_profile INTEGER DEFAULT 0,missing_from_profile_at TEXT,
      digg_count INTEGER,comment_count INTEGER DEFAULT 0,collect_count INTEGER DEFAULT 0,share_count INTEGER DEFAULT 0,
      desc TEXT,attempts INTEGER DEFAULT 0,last_error TEXT, UNIQUE(profile_id,aweme_id));
    CREATE INDEX idx_links_aweme ON links(aweme_id);
    CREATE INDEX idx_links_status ON links(status,id);
    CREATE INDEX idx_links_library_order ON links(status,COALESCE(downloaded_at,last_seen_at) DESC,id DESC) WHERE status='downloaded';
    CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT);
    INSERT INTO profiles VALUES(1,'author','like','','Author','2026-01-01','2026-01-01','active','','');
    INSERT INTO profiles VALUES(2,'author','post','','Author','2026-01-01','2026-01-01','active','','');
  `);
  source.exec("BEGIN");
  const padding = JSON.stringify({ fixturePadding: "x".repeat(8192) });
  for (let i = 10; i < 2010; i++) addLink(i, 2, `pending-${i}`, "pending", padding);
  addLink(1, 1, "100000000000000001");
  addLink(2, 2, "100000000000000002");
  source.exec("COMMIT");
  store = createShortVideoStore({ dbPath: targetPath, roots: [root], skipStartupMaintenance: true });
  sync(); // old format baseline before installing the downloader migration
  const legacy = measured("legacy idle sync / 2002 works", () => sync());
  installFixtureSyncJournal(sourcePath);
  target = new DatabaseSync(targetPath);
  // A stale membership absent before the journal was installed must be removed.
  target.prepare(`INSERT INTO short_video_source_memberships(aweme_id,source_type,source_profile_id,first_seen_at,last_seen_at,updated_at)
    VALUES('stale','like','1','','','')`).run();
  const bootstrap = drain({ batchSize: 200 });
  assert.ok(bootstrap.length > 1);
  assert.equal(target.prepare("SELECT 1 FROM short_video_source_memberships WHERE aweme_id='stale'").get(), undefined);
  const checkpoint = cursor();
  const idle = measured("journal idle sync / 2002 works", () => sync());
  assert.equal(idle.result.advanced, false);
  assert.equal(idle.result.catalogChanged, false);
  assert.equal(idle.sourceRows, 0);
  assert.equal(cursor(), checkpoint);
  drain({ includePosts: false });
  assert.equal(JSON.parse(cursor()).includePosts, false, "changing import scope must reset its checkpoint");
  drain();
  assert.equal(JSON.parse(cursor()).includePosts, true);
  if (legacy.logicalReadBytes > 100_000 && idle.logicalReadBytes !== null) {
    assert.ok(idle.logicalReadBytes < legacy.logicalReadBytes / 10, "idle reads should be at least 90% lower");
  }

  source.exec("INSERT INTO settings VALUES('queue-heartbeat','1'); UPDATE links SET attempts=attempts+1 WHERE id=10;");
  assert.equal(sync().advanced, false, "queue/settings changes must not create library changes");
  source.exec("UPDATE links SET last_seen_at='2026-02-01' WHERE id=1");
  const seen = measured("membership timestamp only", () => sync());
  assert.equal(seen.result.updated, 0);
  assert.ok(!seen.queries.some(q => /\bFROM links\b|\bJOIN links\b/.test(q.sql) && q.calls), "timestamp sync must not read rich link rows");
  assert.equal(target.prepare("SELECT last_seen_at FROM short_video_source_memberships WHERE aweme_id='100000000000000001'").get().last_seen_at, "2026-02-01");

  source.exec("UPDATE links SET digg_count=99,desc='changed' WHERE id=1");
  const changed = measured("one metadata update / 2002 works", () => sync());
  assert.equal(changed.result.updated, 1);
  assert.equal(video("100000000000000001").digg_count, 99);
  assert.equal(video("100000000000000001").title, "changed");
  const workQuery = changed.queries.find(q => q.sql.includes("l.*"));
  assert.equal(workQuery.rows, 1);
  assert.ok(workQuery.plan.some(p => /SEARCH l USING INDEX idx_links_aweme/.test(p.detail)), "source lookup must seek changed work IDs");
  assert.ok(!workQuery.plan.some(p => /^SCAN l\b/.test(p.detail)));
  assert.ok(workQuery.plan.some(p => /SEARCH liked_link USING INDEX idx_links_aweme/.test(p.detail)),
    "the nested like lookup must seek the work ID instead of rescanning downloaded works for every result");

  source.exec("UPDATE profiles SET nickname='Renamed',profile_collected_at='2026-03-01',account_status='banned' WHERE id=2");
  const profile = sync();
  assert.equal(profile.updated, 0);
  assert.ok(profile.profilesChanged > 0);
  assert.equal(video("100000000000000001").author_name, "Renamed");
  assert.equal(target.prepare("SELECT account_status FROM short_video_users WHERE sec_uid='author'").get().account_status, "banned");

  // Same timestamp, decreasing statistics, identity changes and deletions are
  // journal events rather than timestamp-watermark guesses.
  source.exec("UPDATE links SET digg_count=100 WHERE id=1");
  const beforeFailure = cursor();
  assert.throws(() => sync({ syncTestHooks: { beforeCheckpoint() { throw new Error("injected checkpoint failure"); } } }), /checkpoint failure/);
  assert.equal(cursor(), beforeFailure);
  assert.equal(video("100000000000000001").digg_count, 99, "target rows and cursor roll back together");
  sync();
  assert.equal(video("100000000000000001").digg_count, 100);
  assert.equal(video("100000000000000001").author_name, "Renamed", "metadata imports retain the best current author profile");
  source.exec("UPDATE links SET digg_count=101 WHERE id=1");
  sync({ syncTestHooks: { afterSnapshot() { source.exec("UPDATE links SET digg_count=102 WHERE id=1"); } } });
  assert.equal(video("100000000000000001").digg_count, 101, "a batch reads one coherent source snapshot");
  sync();
  assert.equal(video("100000000000000001").digg_count, 102, "writes during the snapshot survive the acknowledgement");
  source.exec("BEGIN; UPDATE links SET digg_count=777 WHERE id=1; ROLLBACK");
  assert.equal(sync().advanced, false, "rolled-back writes must not leak into the journal");
  source.exec("UPDATE links SET digg_count=7 WHERE id=1");
  const decreased = sync();
  assert.equal(decreased.updated, 1, "a decrease is consumed even without changing timestamps");
  assert.equal(video("100000000000000001").digg_count, 102, "the existing maximum-statistics import policy is preserved");

  source.exec("DELETE FROM links WHERE id=1");
  sync();
  assert.equal(video("100000000000000001").is_liked, 0);
  assert.ok(fs.existsSync(video("100000000000000001").source_path), "source tombstones must preserve local media");
  addLink(3, 1, "100000000000000002", "pending");
  sync();
  assert.equal(video("100000000000000002").is_liked, 1);
  source.exec("UPDATE profiles SET tab='post' WHERE id=1");
  drain();
  assert.equal(video("100000000000000002").is_liked, 0, "profile identity changes must refresh affected memberships");
  source.exec("DELETE FROM profiles WHERE id=2");
  drain();
  assert.equal(target.prepare("SELECT COUNT(*) AS count FROM short_video_source_memberships WHERE source_profile_id='2'").get().count, 0);

  // Re-opening a store does not replay acknowledged changes. A new source
  // generation re-enters bounded reconciliation instead of silently skipping.
  store.close(); store = createShortVideoStore({ dbPath: targetPath, roots: [root], skipStartupMaintenance: true });
  assert.equal(sync().advanced, false);
  source.exec("UPDATE library_sync_state SET generation='replacement-generation' WHERE id=1");
  drain({ batchSize: 150 });
  assert.equal(JSON.parse(cursor()).generation, "replacement-generation");
  const revisions = source.prepare("SELECT COUNT(*) AS count FROM library_sync_changes").get().count;
  for (let i = 0; i < 100; i++) source.prepare("UPDATE links SET last_seen_at=? WHERE id=3").run(`2026-repeat-${i}`);
  assert.equal(source.prepare("SELECT COUNT(*) AS count FROM library_sync_changes").get().count, revisions, "journal coalesces repeated changes");
  drain();

  // The production worker must neither fall back to a full scan on an old
  // downloader nor leave a draining backlog alive after stop().
  source.exec("UPDATE links SET last_seen_at='worker'");
  service = createDownloadManagerSyncService({ sourceDbPath: sourcePath, dbPath: targetPath, roots: [root], intervalMs: 60_000 });
  const worker = await service.sync({ force: true });
  assert.equal(worker.ok, true);
  assert.equal(worker.changeJournal, true);
  assert.equal(worker.hasMore, true);
  await service.stop(); service = null;
  const stoppedCursor = cursor();
  await new Promise(resolve => setTimeout(resolve, 250));
  assert.equal(cursor(), stoppedCursor, "stop must cancel scheduled backlog continuation");
  drain();
  source.exec("ALTER TABLE library_sync_state RENAME TO unavailable_library_sync_state");
  service = createDownloadManagerSyncService({ sourceDbPath: sourcePath, dbPath: targetPath, roots: [root], intervalMs: 60_000 });
  const unavailable = await service.sync({ force: true });
  assert.equal(unavailable.requiresJournalUpgrade, true);
  console.log("short-video-incremental-sync: correctness, rollback, concurrency, restart, query and IO budgets passed");
} finally {
  trace = null; DatabaseSync.prototype.prepare = originalPrepare;
  await service?.stop(); store?.close(); source?.close(); target?.close();
  const resolved = fs.realpathSync(root);
  assert.ok(resolved.startsWith(fs.realpathSync(os.tmpdir()) + path.sep));
  fs.rmSync(resolved, { recursive: true, force: true });
}
