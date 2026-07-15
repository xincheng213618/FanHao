import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { createServerConfig } from "../src/bootstrap/server-config.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const moduleDir = path.join(projectRoot, "src", "modules", "short-videos", "download-manager");
const expectedDbPath = path.join(moduleDir, "data", "douyin_downloads.sqlite");

function listFilesRecursive(root, predicate) {
  if (!fs.existsSync(root)) return [];
  const files = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (entry.name === "__pycache__" || entry.name === "node_modules") continue;
    const absolutePath = path.join(root, entry.name);
    if (entry.isDirectory()) files.push(...listFilesRecursive(absolutePath, predicate));
    else if (entry.isFile() && predicate(absolutePath)) files.push(absolutePath);
  }
  return files.sort((left, right) => left.localeCompare(right));
}

function combinedSource(files) {
  return files
    .map((filePath) => `\n/* ${path.relative(moduleDir, filePath)} */\n${fs.readFileSync(filePath, "utf8")}`)
    .join("\n");
}

function assertStaticModuleGraph(staticFiles, staticRoot) {
  const importPatterns = [
    /(?:^|\n)\s*(?:import|export)\s+(?:[^'"\n]*?\sfrom\s*)?["']([^"']+)["']/g,
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g
  ];
  for (const filePath of staticFiles) {
    const source = fs.readFileSync(filePath, "utf8");
    for (const pattern of importPatterns) {
      pattern.lastIndex = 0;
      for (let match = pattern.exec(source); match; match = pattern.exec(source)) {
        const specifier = match[1];
        if (!specifier?.startsWith(".")) continue;
        const cleanSpecifier = specifier.split(/[?#]/, 1)[0];
        const resolved = path.resolve(path.dirname(filePath), cleanSpecifier);
        const relative = path.relative(staticRoot, resolved);
        assert.equal(
          relative.startsWith("..") || path.isAbsolute(relative),
          false,
          `static ESM import escapes static root: ${path.relative(moduleDir, filePath)} -> ${specifier}`
        );
        const candidates = [
          resolved,
          `${resolved}.js`,
          `${resolved}.mjs`,
          path.join(resolved, "index.js"),
          path.join(resolved, "index.mjs")
        ];
        assert.equal(
          candidates.some((candidate) => fs.existsSync(candidate) && fs.statSync(candidate).isFile()),
          true,
          `missing static ESM import: ${path.relative(moduleDir, filePath)} -> ${specifier}`
        );
      }
    }
  }
}

function assertStaticStyleGraph(htmlFiles, styleFiles, staticRoot) {
  const pending = [];
  const visited = new Set();
  const resolveStyle = (ownerPath, specifier) => {
    const cleanSpecifier = specifier.split(/[?#]/, 1)[0];
    if (!cleanSpecifier || cleanSpecifier.startsWith("/fanhao/") || /^(?:https?:|data:)/i.test(cleanSpecifier)) {
      return null;
    }
    const resolved = cleanSpecifier.startsWith("/")
      ? path.resolve(staticRoot, `.${cleanSpecifier}`)
      : path.resolve(path.dirname(ownerPath), cleanSpecifier);
    const relative = path.relative(staticRoot, resolved);
    assert.equal(
      relative.startsWith("..") || path.isAbsolute(relative),
      false,
      `static stylesheet escapes static root: ${path.relative(moduleDir, ownerPath)} -> ${specifier}`
    );
    assert.equal(
      fs.existsSync(resolved) && fs.statSync(resolved).isFile(),
      true,
      `missing static stylesheet: ${path.relative(moduleDir, ownerPath)} -> ${specifier}`
    );
    return resolved;
  };

  for (const htmlPath of htmlFiles) {
    const html = fs.readFileSync(htmlPath, "utf8");
    const stylesheetPattern = /<link\b[^>]*\brel=["']stylesheet["'][^>]*\bhref=["']([^"']+)["'][^>]*>/gi;
    for (let match = stylesheetPattern.exec(html); match; match = stylesheetPattern.exec(html)) {
      const resolved = resolveStyle(htmlPath, match[1]);
      if (resolved) pending.push(resolved);
    }
  }

  while (pending.length) {
    const stylePath = pending.pop();
    if (visited.has(stylePath)) continue;
    visited.add(stylePath);
    const source = fs.readFileSync(stylePath, "utf8");
    const importPattern = /@import\s+(?:url\(\s*)?["']([^"']+)["']\s*\)?/gi;
    for (let match = importPattern.exec(source); match; match = importPattern.exec(source)) {
      const resolved = resolveStyle(stylePath, match[1]);
      if (resolved) pending.push(resolved);
    }
  }

  assert.ok(visited.size > 0, "download-manager HTML does not reference any local stylesheet");
  for (const stylePath of styleFiles) {
    assert.equal(
      visited.has(stylePath),
      true,
      `orphan download-manager stylesheet: ${path.relative(moduleDir, stylePath)}`
    );
  }
}

for (const relativePath of [
  "app.py",
  "extract-links.mjs",
  "extract-following.mjs",
  "cookie-login.mjs",
  "fetch-comments.py",
  "packaging/downloader_entry.py",
  "packaging/DouyinDownloadManager.iss",
  "packaging/README.md",
  "packaging/requirements-build.txt",
  "package.json",
  "package-lock.json",
  "run.cmd",
  "run.ps1",
  "tests/test_runtime_characterization.py",
  "static/index.html",
  "static/app.js",
  "static/shared-player.html",
  "static/shared-player.css",
  "tools/auto_watchdog.py",
  "tools/audit_video_quality.py",
  "tools/backfill_covers.py",
  "tools/batch_profile_download.py"
]) {
  assert.equal(fs.existsSync(path.join(moduleDir, relativePath)), true, `missing download-manager file: ${relativePath}`);
}

const config = createServerConfig({ projectRoot });
assert.equal(config.SHORT_VIDEO_DOWNLOAD_MANAGER_DB_PATH, expectedDbPath);
assert.equal(config.SHORT_VIDEO_DOWNLOAD_MANAGER_URL, "http://127.0.0.1:8765");
assert.deepEqual(config.SHORT_VIDEO_ROOTS, ["D:\\Media\\ShortVideos"]);

const storageOverride = createServerConfig({
  projectRoot,
  env: { FANHAO_SHORT_VIDEO_STORAGE_ROOT: "R:\\ShortVideoArchive" }
});
assert.deepEqual(storageOverride.SHORT_VIDEO_ROOTS, ["R:\\ShortVideoArchive\\ShortVideos"]);

const overridePath = path.join(projectRoot, "tmp", "custom-douyin.sqlite");
const overridden = createServerConfig({ projectRoot, env: { FANHAO_DOUYIN_DOWNLOAD_MANAGER_DB: overridePath } });
assert.equal(overridden.SHORT_VIDEO_DOWNLOAD_MANAGER_DB_PATH, overridePath);
const managerUrlOverride = createServerConfig({ projectRoot, env: { FANHAO_DOUYIN_DOWNLOAD_MANAGER_URL: "http://127.0.0.1:9876" } });
assert.equal(managerUrlOverride.SHORT_VIDEO_DOWNLOAD_MANAGER_URL, "http://127.0.0.1:9876");

const managerCoreDir = path.join(moduleDir, "manager_core");
const managerPythonFiles = [
  path.join(moduleDir, "app.py"),
  ...listFilesRecursive(managerCoreDir, (filePath) => filePath.endsWith(".py"))
];
const appSource = combinedSource(managerPythonFiles);
assert.match(appSource, /FANHAO_PROJECT_ROOT/);
assert.match(appSource, /DOUYIN_MANAGER_PORT/);
assert.match(appSource, /\/api\/auth\/cookie\/import/);
assert.match(appSource, /\/api\/auth\/login\/start/);
assert.match(appSource, /\/api\/library\/media/);
assert.match(appSource, /\/api\/short-videos\/summary/);
assert.match(appSource, /shared_player_detail/);
assert.match(appSource, /FANHAO_PUBLIC_DIR/);
assert.match(appSource, /\/api\/app\/quit/);
assert.doesNotMatch(appSource, /webview\.create_window|import webview|DESKTOP_MODE/);
assert.match(appSource, /acquire_single_instance/);
assert.match(appSource, /DOUYIN_MANAGER_SINGLE_INSTANCE/);
assert.match(appSource, /webbrowser\.open/);
assert.match(appSource, /SO_EXCLUSIVEADDRUSE/);
assert.doesNotMatch(appSource, /Desktop\\FanHao\\data\\short-videos\.sqlite/);
assert.match(appSource, /FANHAO_SHORT_VIDEO_STORAGE_ROOT/);
assert.match(appSource, /DEFAULT_LIBRARY_OUTPUT_DIR/);
assert.doesNotMatch(appSource, /FANHAO_DIRECT_IMPORT|FANHAO_SHORT_VIDEO_DB/);
assert.doesNotMatch(
  appSource,
  /(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+short_video_(?:users|videos|assets|follows|source_memberships)/i,
  "the download manager must not write the FanHao catalog schema"
);
for (const removedWriter of ["fanhao_downloads.py", "fanhao_identity.py", "fanhao_merge.py", "fanhao_placeholders.py"]) {
  assert.equal(
    fs.existsSync(path.join(managerCoreDir, removedWriter)),
    false,
    `legacy FanHao direct writer must stay removed: ${removedWriter}`
  );
}
const batchProfileSource = fs.readFileSync(path.join(moduleDir, "tools", "batch_profile_download.py"), "utf8");
assert.doesNotMatch(
  batchProfileSource,
  /FANHAO_SHORT_VIDEO_DB|sqlite3|short_video_(?:users|videos|assets)/,
  "batch download automation must use manager APIs instead of writing the FanHao catalog"
);
assert.match(appSource, /following_discovered_at/);
assert.match(appSource, /\/api\/links\/delete/);
assert.match(appSource, /def delete_link\(/);
assert.match(appSource, /\/api\/comments\/fetch/);
assert.match(appSource, /def fetch_aweme_comments\(/);
assert.match(appSource, /def migrate_self_profile_aliases\(/);
assert.match(appSource, /if sec_uid\.lower\(\) == "self"/);
assert.match(appSource, /QUALITY_UPGRADE_INTENT = "quality_upgrade"/);
assert.match(appSource, /video_quality: highest_resolution/);
assert.match(appSource, /def _claim_quality_queue_batch\(self, limit: int\)/);
assert.match(appSource, /COALESCE\(links\.digg_count, 0\) DESC/);
assert.match(appSource, /CREATE TABLE IF NOT EXISTS video_quality_audit_runs/);
assert.match(appSource, /CREATE TABLE IF NOT EXISTS video_quality_audit_items/);
assert.match(appSource, /redownload_status='completed'/);
assert.match(appSource, /verification_status TEXT NOT NULL DEFAULT 'not_checked'/);
assert.match(appSource, /def probe_actual_video_file\(/);
assert.match(appSource, /\.fanhao-ffprobe/);
assert.match(appSource, /os\.link\(source_path, probe_path\)/);
assert.match(appSource, /def expected_highest_video_dimensions\(/);
assert.match(appSource, /def validate_downloaded_video_quality\(/);
assert.match(appSource, /最高画质校验未通过/);
assert.match(appSource, /require_source_dimensions=verify_reused/);
assert.match(appSource, /旧文件无法确认源最高分辨率，已改为最高画质重下/);
assert.match(appSource, /最高画质已确认/);
assert.match(appSource, /verify_reused=True/);
assert.match(appSource, /continue_download=True/);
assert.match(appSource, /marked_downloaded=marked_downloaded/);
assert.match(appSource, /actual_probed_at/);
assert.match(appSource, /actual_codec/);
assert.match(appSource, /actual_frame_rate/);

const extractLinksSource = fs.readFileSync(path.join(moduleDir, "extract-links.mjs"), "utf8");
assert.match(extractLinksSource, /rawTargetSecUid\.toLowerCase\(\) === "self"/);

const qualityAuditSource = fs.readFileSync(path.join(moduleDir, "tools", "audit_video_quality.py"), "utf8");
assert.match(qualityAuditSource, /MAX\(COALESCE\(l\.digg_count, 0\), COALESCE\(sv\.digg_count, 0\)\)>=\?/);
assert.match(qualityAuditSource, /at or above this like count/);
assert.match(qualityAuditSource, /--all-downloaded/);
assert.match(qualityAuditSource, /already_queued/);
assert.match(qualityAuditSource, /--retry-existing-report/);
assert.match(qualityAuditSource, /--retry-probe-errors-existing-report/);
assert.match(qualityAuditSource, /os\.link\(source_path, probe_path\)/);
assert.match(qualityAuditSource, /--queue-failures-existing-report/);
assert.match(qualityAuditSource, /include_failures=True/);
assert.match(qualityAuditSource, /digg_count=MAX\(COALESCE\(digg_count, 0\), \?\)/);
assert.match(qualityAuditSource, /--request-delay/);
assert.match(qualityAuditSource, /--local-detail-only/);
assert.match(qualityAuditSource, /local_download_detail/);
assert.match(qualityAuditSource, /write_actual_video_metadata/);
assert.match(qualityAuditSource, /--backfill-playback-metadata/);

assert.equal(fs.existsSync(path.join(projectRoot, "tools", "migrate_short_video_storage.ps1")), true);
assert.equal(fs.existsSync(path.join(projectRoot, "tools", "rebase_short_video_storage.mjs")), true);

const migrationFixture = fs.mkdtempSync(path.join(os.tmpdir(), "fanhao-short-video-storage-"));
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
const staticRoot = path.join(moduleDir, "static");
const staticHtmlFiles = listFilesRecursive(staticRoot, (filePath) => filePath.endsWith(".html"));
const staticStyleFiles = listFilesRecursive(staticRoot, (filePath) => filePath.endsWith(".css"));
const staticScriptFiles = listFilesRecursive(
  staticRoot,
  (filePath) => filePath.endsWith(".js") || filePath.endsWith(".mjs")
);
assert.ok(staticScriptFiles.length > 0, "download-manager static scripts are missing");
assertStaticModuleGraph(staticScriptFiles, staticRoot);
assertStaticStyleGraph(staticHtmlFiles, staticStyleFiles, staticRoot);
for (const staticScript of staticScriptFiles) {
  const syntax = spawnSync(process.execPath, ["--check", staticScript], { encoding: "utf8" });
  assert.equal(
    syntax.status,
    0,
    `invalid static script ${path.relative(moduleDir, staticScript)}\n${syntax.stderr || syntax.stdout}`
  );
}
const managerClient = combinedSource(staticScriptFiles);
const sharedPlayerHtml = fs.readFileSync(path.join(moduleDir, "static", "shared-player.html"), "utf8");
assert.match(managerHtml, /打开 Edge 登录/);
assert.match(managerHtml, /导入 Cookie/);
assert.match(managerClient, /export function createAuthFeature/);
assert.match(managerClient, /\/api\/auth\/status/);
assert.match(managerHtml, /提取我的关注/);
assert.match(managerHtml, /已下载作品/);
assert.match(managerHtml, /id="quitApp"/);
assert.match(managerClient, /export function createLibraryFeature/);
assert.match(managerClient, /\/api\/library\?/);
assert.match(managerClient, /export function createDownloadsFeature/);
assert.match(managerClient, /\/api\/app\/quit/);
assert.match(managerClient, /下载管理器已退出/);
assert.match(managerHtml, /id="linksBody"/);
assert.match(managerClient, /data-link-delete/);
assert.match(managerClient, /\/api\/links\/delete/);
assert.match(managerClient, /只会删除数据库记录，不会删除已经下载到本地的文件/);
assert.match(managerClient, /\/short-videos\//);
assert.match(sharedPlayerHtml, /\/fanhao\/short-video-app\.js/);
assert.match(sharedPlayerHtml, /返回下载管理/);

const sharedWebPlayer = fs.readFileSync(path.join(projectRoot, "public", "modules", "short-videos", "short-video-page.js"), "utf8");
const sharedAuthorPages = fs.readFileSync(path.join(projectRoot, "public", "modules", "short-videos", "author-pages.js"), "utf8");
const sharedCommentsView = fs.readFileSync(path.join(projectRoot, "public", "modules", "short-videos", "comments-view.js"), "utf8");
assert.match(sharedWebPlayer, /export function createShortVideoPage/);
assert.match(sharedWebPlayer, /点赞分布/);
assert.match(sharedWebPlayer, /\/api\/short-videos\/like-distribution/);
assert.match(sharedAuthorPages, /快速刷新/);
assert.match(sharedAuthorPages, /全部扫描/);
assert.match(sharedWebPlayer, /comments-view\.js\?v=/);
assert.match(sharedCommentsView, /commentsEndpoint}\/sync/);

const installerBuilder = fs.readFileSync(path.join(projectRoot, "tools", "build_douyin_manager_installer.ps1"), "utf8");
assert.match(installerBuilder, /public'\);fanhao-public/);
assert.match(installerBuilder, /shared short-video player assets are missing/);
assert.match(installerBuilder, /fetch-comments\.py/);
assert.match(installerBuilder, /PackagedCommentHelper/);
assert.doesNotMatch(installerBuilder, /FANHAO_DIRECT_IMPORT|FANHAO_SHORT_VIDEO_DB/);

const launcherSource = fs.readFileSync(path.join(projectRoot, "start-fanhao.ps1"), "utf8");
assert.match(launcherSource, /short-videos\\download-manager\\run\.ps1/);
assert.equal(fs.existsSync(path.join(projectRoot, "tools", "build_douyin_manager_installer.ps1")), true);

const runtimeVerifier = path.join(projectRoot, "tools", "verify_douyin_download_manager_runtime.ps1");
assert.equal(fs.existsSync(runtimeVerifier), true, "missing isolated download-manager runtime verifier");
const runtimeResult = spawnSync(
  process.platform === "win32" ? "powershell.exe" : "pwsh",
  ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", runtimeVerifier],
  {
    cwd: projectRoot,
    encoding: "utf8",
    timeout: 120_000,
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" }
  }
);
assert.equal(
  runtimeResult.status,
  0,
  `isolated download-manager runtime verification failed\n${runtimeResult.stdout || ""}\n${runtimeResult.stderr || ""}`
);
if (runtimeResult.stdout) process.stdout.write(runtimeResult.stdout);
if (runtimeResult.stderr) process.stderr.write(runtimeResult.stderr);

console.log(`douyin-download-manager: ok (${path.relative(projectRoot, moduleDir)})`);
