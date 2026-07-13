import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { createServerConfig } from "../src/bootstrap/server-config.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const moduleDir = path.join(projectRoot, "src", "modules", "short-videos", "download-manager");
const expectedDbPath = path.join(moduleDir, "data", "douyin_downloads.sqlite");

for (const relativePath of [
  "app.py",
  "extract-links.mjs",
  "extract-following.mjs",
  "cookie-login.mjs",
  "packaging/downloader_entry.py",
  "packaging/DouyinDownloadManager.iss",
  "packaging/README.md",
  "package.json",
  "package-lock.json",
  "run.cmd",
  "run.ps1",
  "static/index.html",
  "static/app.js",
  "static/styles.css",
  "tools/auto_watchdog.py",
  "tools/backfill_covers.py",
  "tools/batch_profile_download.py"
]) {
  assert.equal(fs.existsSync(path.join(moduleDir, relativePath)), true, `missing download-manager file: ${relativePath}`);
}

const config = createServerConfig({ projectRoot });
assert.equal(config.SHORT_VIDEO_DOWNLOAD_MANAGER_DB_PATH, expectedDbPath);
assert.deepEqual(config.SHORT_VIDEO_ROOTS, ["D:\\Media\\ShortVideos"]);

const storageOverride = createServerConfig({
  projectRoot,
  env: { FANHAO_SHORT_VIDEO_STORAGE_ROOT: "R:\\ShortVideoArchive" }
});
assert.deepEqual(storageOverride.SHORT_VIDEO_ROOTS, ["R:\\ShortVideoArchive\\ShortVideos"]);

const overridePath = path.join(projectRoot, "tmp", "custom-douyin.sqlite");
const overridden = createServerConfig({ projectRoot, env: { FANHAO_DOUYIN_DOWNLOAD_MANAGER_DB: overridePath } });
assert.equal(overridden.SHORT_VIDEO_DOWNLOAD_MANAGER_DB_PATH, overridePath);

const appSource = fs.readFileSync(path.join(moduleDir, "app.py"), "utf8");
assert.match(appSource, /FANHAO_PROJECT_ROOT/);
assert.match(appSource, /DOUYIN_MANAGER_PORT/);
assert.match(appSource, /\/api\/auth\/cookie\/import/);
assert.match(appSource, /\/api\/auth\/login\/start/);
assert.doesNotMatch(appSource, /Desktop\\FanHao\\data\\short-videos\.sqlite/);
assert.match(appSource, /FANHAO_SHORT_VIDEO_STORAGE_ROOT/);
assert.match(appSource, /DEFAULT_LIBRARY_OUTPUT_DIR/);

assert.equal(fs.existsSync(path.join(projectRoot, "tools", "migrate_short_video_storage.ps1")), true);
assert.equal(fs.existsSync(path.join(projectRoot, "tools", "rebase_short_video_storage.mjs")), true);

const migrationFixture = fs.mkdtempSync(path.join(projectRoot, "tmp", "short-video-storage-"));
const sourceLibrary = path.join(migrationFixture, "old", "Library");
const destinationLibrary = path.join(migrationFixture, "new", "Library");
const managerFixtureDb = path.join(migrationFixture, "manager.sqlite");
const fanhaoFixtureDb = path.join(migrationFixture, "fanhao.sqlite");
fs.mkdirSync(destinationLibrary, { recursive: true });

const managerFixture = new DatabaseSync(managerFixtureDb);
managerFixture.exec("CREATE TABLE settings(key TEXT PRIMARY KEY, value TEXT); CREATE TABLE links(output_dir TEXT, local_file_paths TEXT)");
managerFixture.prepare("INSERT INTO settings(key, value) VALUES(?, ?)").run("output_dir", path.dirname(sourceLibrary));
managerFixture.prepare("INSERT INTO settings(key, value) VALUES(?, ?)").run("library_output_dir", sourceLibrary);
managerFixture.prepare("INSERT INTO links(output_dir, local_file_paths) VALUES(?, ?)").run(sourceLibrary, JSON.stringify([path.join(sourceLibrary, "clip.mp4")]));
managerFixture.close();

const fanhaoFixture = new DatabaseSync(fanhaoFixtureDb);
fanhaoFixture.exec("CREATE TABLE short_videos(source_path TEXT, cover_path TEXT)");
fanhaoFixture.prepare("INSERT INTO short_videos(source_path, cover_path) VALUES(?, ?)").run(path.join(sourceLibrary, "clip.mp4"), path.join(sourceLibrary, "clip.jpg"));
fanhaoFixture.close();

const migrationResult = spawnSync(process.execPath, [
  path.join(projectRoot, "tools", "rebase_short_video_storage.mjs"),
  "--from", sourceLibrary,
  "--to", destinationLibrary,
  "--storage-root", path.dirname(destinationLibrary),
  "--manager-db", managerFixtureDb,
  "--fanhao-db", fanhaoFixtureDb,
  "--apply"
], { encoding: "utf8" });
assert.equal(migrationResult.status, 0, migrationResult.stderr || migrationResult.stdout);

const migratedManager = new DatabaseSync(managerFixtureDb, { readOnly: true });
assert.equal(migratedManager.prepare("SELECT value FROM settings WHERE key='library_output_dir'").get().value, destinationLibrary);
assert.deepEqual(
  JSON.parse(migratedManager.prepare("SELECT local_file_paths FROM links").get().local_file_paths),
  [path.join(destinationLibrary, "clip.mp4")]
);
migratedManager.close();
const migratedFanhao = new DatabaseSync(fanhaoFixtureDb, { readOnly: true });
assert.equal(migratedFanhao.prepare("SELECT source_path FROM short_videos").get().source_path, path.join(destinationLibrary, "clip.mp4"));
migratedFanhao.close();
fs.rmSync(migrationFixture, { recursive: true, force: true });

const managerHtml = fs.readFileSync(path.join(moduleDir, "static", "index.html"), "utf8");
const managerClient = fs.readFileSync(path.join(moduleDir, "static", "app.js"), "utf8");
assert.match(managerHtml, /打开 Edge 登录/);
assert.match(managerHtml, /导入 Cookie/);
assert.match(managerClient, /refreshAuthStatus/);

const launcherSource = fs.readFileSync(path.join(projectRoot, "start-fanhao.ps1"), "utf8");
assert.match(launcherSource, /short-videos\\download-manager\\run\.ps1/);
assert.equal(fs.existsSync(path.join(projectRoot, "tools", "build_douyin_manager_installer.ps1")), true);

console.log(`douyin-download-manager: ok (${path.relative(projectRoot, moduleDir)})`);
