import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createShortVideoStore } from "../src/modules/short-videos/server/store.js";

const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "fanhao-storage-move-"));
const oldRoot = path.join(fixture, "old", "ShortVideos");
const newRoot = path.join(fixture, "new", "ShortVideos");
const managerPath = path.join(fixture, "manager.sqlite");
const fanhaoPath = path.join(fixture, "fanhao.sqlite");
const coverPath = path.join(fixture, "covers.sqlite");
const tool = path.join(path.dirname(fileURLToPath(import.meta.url)), "rebase_short_video_storage.mjs");
const source = path.join(oldRoot, "视频.mp4");
const missing = path.join(oldRoot, "deleted.mp4");
const missingKey = missing.replaceAll("\\", "/").toLowerCase();
const fingerprint = p => crypto.createHash("sha1").update(`${p}:42:1000:1`).digest("hex");
const args = [tool, "--from", oldRoot, "--to", newRoot, "--storage-root", path.dirname(newRoot),
  "--manager-db", managerPath, "--fanhao-db", fanhaoPath, "--cover-db", coverPath,
  "--no-backup", "--preserve-completed-tombstones"];
function run(extra) { return spawnSync(process.execPath, [...args, ...extra], { encoding: "utf8", windowsHide: true }); }
try {
  fs.mkdirSync(oldRoot, { recursive: true });
  const store = createShortVideoStore({ dbPath: fanhaoPath, roots: [], skipStartupMaintenance: true });
  store.summary();
  store.close();
  const fanhao = new DatabaseSync(fanhaoPath);
  fanhao.prepare("INSERT INTO short_videos(id,source_path,size_bytes,mtime_ms) VALUES(?,?,42,1000)").run("kept-video-id", source);
  fanhao.prepare(`INSERT INTO short_video_delete_jobs(id,status,phase,video_ids_json,quarantine_token,created_at,updated_at)
    VALUES('completed-delete','completed','completed','[]','token','before','before')`).run();
  fanhao.prepare(`INSERT INTO short_video_path_tombstones
    (path_key,job_id,original_path,real_path_key,identity_key,state,created_at,updated_at)
    VALUES(?,'completed-delete',?,?,'old-identity','active','before','before')`).run(missingKey, missing, missingKey);
  const historical = fanhao.prepare("SELECT * FROM short_video_path_tombstones").get();
  fanhao.close();
  const manager = new DatabaseSync(managerPath);
  manager.exec("CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT); CREATE TABLE links(local_file_paths TEXT)");
  manager.prepare("INSERT INTO settings VALUES('library_output_dir',?)").run(oldRoot);
  manager.prepare("INSERT INTO links VALUES(?)").run(JSON.stringify([source]));
  manager.close();
  const covers = new DatabaseSync(coverPath);
  covers.exec("CREATE TABLE short_video_covers(video_id TEXT PRIMARY KEY,source_fingerprint TEXT,generation_version INTEGER,image_blob BLOB)");
  covers.prepare("INSERT INTO short_video_covers VALUES('kept-video-id',?,1,?)").run(fingerprint(source), Buffer.from("keep-image-bytes"));
  covers.close();

  let result = run(["--allow-missing-destination", "--check-offline", "--preflight-only"]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.existsSync(newRoot), false, "preflight must not create the destination");
  const busy = new DatabaseSync(fanhaoPath);
  busy.exec("UPDATE short_video_delete_jobs SET status='cleanup_pending'");
  busy.close();
  fs.mkdirSync(newRoot, { recursive: true });
  result = run(["--apply", "--offline-confirmed"]);
  assert.notEqual(result.status, 0, "active deletion must stop before either DB is mutated");
  const unchangedManager = new DatabaseSync(managerPath, { readOnly: true });
  assert.equal(unchangedManager.prepare("SELECT value FROM settings WHERE key='library_output_dir'").get().value, oldRoot);
  unchangedManager.close();
  const done = new DatabaseSync(fanhaoPath);
  done.exec("UPDATE short_video_delete_jobs SET status='completed'");
  done.close();
  result = run(["--apply", "--offline-confirmed"]);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(fs.existsSync(path.join(fixture, "backups")), false, "explicit no-backup must create no DB copies");
  const migrated = new DatabaseSync(fanhaoPath, { readOnly: true });
  assert.deepEqual(migrated.prepare("SELECT * FROM short_video_path_tombstones WHERE path_key=?").get(missingKey), historical);
  const newMissing = path.join(newRoot, "deleted.mp4");
  assert.equal(migrated.prepare("SELECT original_path FROM short_video_path_tombstones WHERE path_key=?").get(newMissing.replaceAll("\\", "/").toLowerCase()).original_path, newMissing);
  assert.equal(migrated.prepare("SELECT id,source_path FROM short_videos").get().id, "kept-video-id");
  assert.equal(migrated.prepare("SELECT source_path FROM short_videos").get().source_path, path.join(newRoot, "视频.mp4"));
  migrated.close();
  const migratedManager = new DatabaseSync(managerPath, { readOnly: true });
  assert.deepEqual(JSON.parse(migratedManager.prepare("SELECT local_file_paths FROM links").get().local_file_paths), [path.join(newRoot, "视频.mp4")]);
  migratedManager.close();
  const migratedCovers = new DatabaseSync(coverPath, { readOnly: true });
  const cover = migratedCovers.prepare("SELECT * FROM short_video_covers").get();
  assert.equal(cover.source_fingerprint, fingerprint(path.join(newRoot, "视频.mp4")));
  assert.equal(Buffer.from(cover.image_blob).toString(), "keep-image-bytes");
  migratedCovers.close();
  result = run(["--apply", "--offline-confirmed"]);
  assert.equal(result.status, 0, "retry must preserve existing completed tombstone aliases");
  console.log("short-video-storage-rebase: ok (offline preflight, no backup, JSON paths, immutable deletion receipts, cover preservation, retry)");
} finally {
  // Only this freshly-created fixture is removed; never a media root.
  const resolved = path.resolve(fixture);
  assert(resolved.startsWith(path.resolve(os.tmpdir()) + path.sep));
  const cleanup = spawnSync("pwsh", ["-NoProfile", "-Command",
    "$target = [IO.Path]::GetFullPath($env:FANHAO_STORAGE_FIXTURE_ROOT); if (-not $target.StartsWith([IO.Path]::GetFullPath([IO.Path]::GetTempPath()), [StringComparison]::OrdinalIgnoreCase)) { throw 'fixture outside temp root' }; Remove-Item -LiteralPath $target -Recurse -Force"],
    { env: { ...process.env, FANHAO_STORAGE_FIXTURE_ROOT: resolved }, encoding: "utf8", windowsHide: true });
  assert.equal(cleanup.status, 0, cleanup.stderr);
}
