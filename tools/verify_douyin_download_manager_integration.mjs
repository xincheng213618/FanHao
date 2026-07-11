import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServerConfig } from "../src/bootstrap/server-config.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const moduleDir = path.join(projectRoot, "src", "modules", "short-videos", "download-manager");
const expectedDbPath = path.join(moduleDir, "data", "douyin_downloads.sqlite");

for (const relativePath of [
  "app.py",
  "extract-links.mjs",
  "extract-following.mjs",
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

const overridePath = path.join(projectRoot, "tmp", "custom-douyin.sqlite");
const overridden = createServerConfig({ projectRoot, env: { FANHAO_DOUYIN_DOWNLOAD_MANAGER_DB: overridePath } });
assert.equal(overridden.SHORT_VIDEO_DOWNLOAD_MANAGER_DB_PATH, overridePath);

const appSource = fs.readFileSync(path.join(moduleDir, "app.py"), "utf8");
assert.match(appSource, /FANHAO_PROJECT_ROOT/);
assert.match(appSource, /DOUYIN_MANAGER_PORT/);
assert.doesNotMatch(appSource, /Desktop\\FanHao\\data\\short-videos\.sqlite/);

const launcherSource = fs.readFileSync(path.join(projectRoot, "start-fanhao.ps1"), "utf8");
assert.match(launcherSource, /short-videos\\download-manager\\run\.ps1/);

console.log(`douyin-download-manager: ok (${path.relative(projectRoot, moduleDir)})`);
