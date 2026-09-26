import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fork } from "node:child_process";
import { once } from "node:events";
import { DatabaseSync } from "node:sqlite";
import { discoverFanHaoModules } from "../src/fanhao/module-registry.js";
import { createFanhaoProcessAdapter } from "../src/modules/fanhao/server/admin/product-processes.js";
import { createVerifiedTempDir } from "./verified-temp-cleanup.mjs";

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const temporary = createVerifiedTempDir("fanhao-product-boundaries-");
const children = [];
try {
  const poisonedModules = path.join(temporary.tempDir, "discovery");
  fs.mkdirSync(path.join(poisonedModules, "disabled"), { recursive: true });
  fs.writeFileSync(path.join(poisonedModules, "disabled", "module.js"), 'throw new Error("disabled module imported");');
  const empty = await discoverFanHaoModules({ modulesDir: poisonedModules, enabledModules: [], context: {}, sendJson() {} });
  assert.deepEqual(empty.publicManifest(), []);
  await assert.rejects(discoverFanHaoModules({ modulesDir: poisonedModules, enabledModules: ["missing"], context: {}, sendJson() {} }), /missing/);

  for (const product of ["short-videos", "fanhao", "suite"]) {
    const root = path.join(temporary.tempDir, product);
    fs.mkdirSync(root);
    for (const name of ["lib", "src/platform", "src/bootstrap", "src/fanhao", "src/apps", "public"]) {
      fs.cpSync(path.join(repository, name), path.join(root, name), { recursive: true });
    }
    const includedModules = product === "suite" ? fs.readdirSync(path.join(repository, "src/modules")) : product === "fanhao" ? ["fanhao", "system"] : ["short-videos"];
    for (const name of includedModules) {
      fs.cpSync(path.join(repository, "src/modules", name), path.join(root, "src/modules", name), {
        recursive: true, filter: (source) => path.basename(source) !== "download-manager"
      });
    }
    for (const name of ["server.js", "server-fanhao.js", "server-short-videos.js", "package.json"]) fs.copyFileSync(path.join(repository, name), path.join(root, name));
    for (const name of ["pinyin-pro", "ip2region.js", "qrcode-generator"]) {
      const dependency = path.join(repository, "node_modules", name);
      if (fs.existsSync(dependency)) fs.cpSync(dependency, path.join(root, "node_modules", name), { recursive: true });
    }
    const data = path.join(root, "state"), media = path.join(root, "media");
    fs.mkdirSync(data); fs.mkdirSync(media);
    if (product !== "short-videos") createCoreFixture(path.join(data, "fanhao-core-v2.sqlite"));
    const env = { ...process.env, FANHAO_PRODUCT: product, FANHAO_LOAD_ENV: "0", FANHAO_DATA_DIR: data, FANHAO_DISABLE_NVENC: "1",
      FANHAO_CORE_DB: path.join(data, "fanhao-core-v2.sqlite"), FANHAO_CORE_IMAGE_DB: path.join(data, "images.sqlite"),
      FANHAO_SHORT_VIDEO_DB: path.join(data, "short-videos.sqlite"), FANHAO_WORKFLOW_ROOTS: media,
      LIBRARY_ROOTS: media, FANHAO_WESTERN_ROOTS: media, FANHAO_SHORT_VIDEO_ROOTS: media,
      FANHAO_MANGA_ROOT: media, FANHAO_MANGA_DATABASE: path.join(data, "manga.sqlite"),
      FANHAO_PHOTO_SET_ROOTS: media, FANHAO_MUSIC_ROOTS: media, FANHAO_NOVEL_ROOTS: media,
      FANHAO_MOVIE_ROOTS: media, FANHAO_TV_ROOTS: media, FANHAO_ANIME_ROOTS: media,
      FANHAO_DOUYIN_DOWNLOAD_MANAGER_DB: path.join(data, "absent-manager.sqlite"), FANHAO_DOUYIN_SYNC_MS: "0",
      FANHAO_EAGER_PREWARM: "0", PORT: "0", HOST: "127.0.0.1", FANHAO_WEB_PASSWORD: "" };
    const entry = product === "suite" ? "server.js" : product === "fanhao" ? "server-fanhao.js" : "server-short-videos.js";
    const child = fork(path.join(repository, "tools/fixtures/product-process.mjs"), [path.join(root, entry)], { env, cwd: root, silent: true });
    children.push(child);
    let output = "";
    child.stdout.on("data", (data) => { output += data; }); child.stderr.on("data", (data) => { output += data; });
    const ready = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${product} startup timed out\n${output}`)), 20000);
      child.once("message", (message) => { clearTimeout(timer); resolve(message); });
      child.once("exit", (code) => { clearTimeout(timer); reject(new Error(`${product} exited ${code}\n${output}`)); });
    });
    const base = `http://127.0.0.1:${ready.port}`;
    assert.equal((await fetch(`${base}/api/health`)).status, 200);
    const catalog = await (await fetch(`${base}/api/modules`)).json();
    assert.equal(catalog.product.id, product);
    if (product !== "suite") {
      assert.deepEqual(catalog.modules.map((module) => module.id), [product]);
      const forbidden = product === "fanhao" ? "/api/short-videos" : "/api/library";
      assert.equal((await fetch(`${base}${forbidden}`)).status, 404);
    } else {
      assert(catalog.modules.some((module) => module.id === "fanhao"));
      assert(catalog.modules.some((module) => module.id === "short-videos"));
      assert.equal((await fetch(`${base}/api/fanhao/file-workflows/config`)).status, 200);
      assert.equal((await fetch(`${base}/api/short-videos?limit=1`)).status, 200);
    }
    if (product === "fanhao") {
      for (const route of ["/api/library?limit=1", "/api/works?limit=1"]) {
        const response = await fetch(`${base}${route}`);
        assert.equal(response.status, 200, `${route}: ${await response.text()}\n${output}`);
      }
      assert.equal((await fetch(`${base}/api/fanhao/file-workflows/config`)).status, 200);
      assert((await (await fetch(`${base}/fanhao/file-workflows`)).text()).includes("新建文件计划"));
      assert(!fs.existsSync(path.join(data, "short-videos.sqlite")));
      assert(!fs.existsSync(path.join(data, "image-gallery.sqlite")));
    } else if (product === "short-videos") {
      assert(!fs.existsSync(path.join(data, "fanhao-core-v2.sqlite")));
      assert.equal((await fetch(`${base}/short-videos`)).status, 200);
      assert.equal((await fetch(`${base}/api/short-videos?limit=1`)).status, 200);
      if (process.argv.includes("--browser")) await verifyShortVideoBrowser(base);
    }
    const ended = once(child, "exit"); child.send("stop"); const [code] = await ended;
    assert.equal(code, 0, output);
    console.log(`${product}: starts and stops with only its product sources and temporary state`);
  }
  const adapter = createFanhaoProcessAdapter({ CORE_DB_PATH: "fixture.sqlite", CORE_IMAGE_DB_PATH: "images.sqlite", LIBRARY_ROOTS: ["fixture-root"], DATA_DIR: "fixture-state", PYTHON_PATH: "python" });
  assert.throws(() => adapter({ command: "python", args: ["tools/movefile.py"] }), /尚未绑定/);
  const command = adapter({ command: "python", args: ["tools/full_scan_core_library.py", "--db", "wrong.sqlite"] });
  assert.equal(command.args.filter((v) => v === "--db").length, 1);
  assert(command.args.includes("fixture.sqlite"));
  console.log("product-boundaries: disabled imports, product state isolation and script binding passed");
} finally {
  for (const child of children) if (child.exitCode === null && child.signalCode === null) { const ended = once(child, "exit"); child.kill(); await ended; }
  temporary.cleanup();
}

async function verifyShortVideoBrowser(base) {
  const { chromium } = await import("playwright-core");
  const executablePath = [process.env.CHROME_PATH, "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe", "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe"].find((file) => file && fs.existsSync(file));
  const browser = await chromium.launch({ executablePath, headless: true });
  try {
    const page = await browser.newPage(); const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`${base}/short-videos`);
    await page.waitForFunction(() => document.body.dataset.product === "short-videos");
    await page.waitForFunction(() => !document.documentElement.classList.contains("app-module-loading"));
    assert.equal(await page.locator(".product-nav a").count(), 1);
    assert.equal(await page.locator(".product-brand").getAttribute("href"), "/short-videos");
    assert.equal(await page.locator("#topAdminLink").isVisible(), false);
    assert.deepEqual(errors, []);
    console.log("short-videos: standalone browser boot and product-only navigation passed");
  } finally { await browser.close(); }
}

function createCoreFixture(file) {
  const db = new DatabaseSync(file);
  db.exec(`
    CREATE TABLE people(id INTEGER PRIMARY KEY, name TEXT, name_search TEXT, display_name TEXT, folder_path TEXT, gender TEXT, status TEXT, source TEXT, updated_at TEXT, created_at TEXT);
    CREATE TABLE works(id INTEGER PRIMARY KEY, code TEXT, code_search TEXT, title TEXT, release_date TEXT, duration_minutes REAL, rating REAL, rating_count INTEGER, director TEXT, fields_json TEXT, status TEXT, updated_at TEXT, created_at TEXT);
    CREATE TABLE local_works(id INTEGER PRIMARY KEY, work_id INTEGER, local_path TEXT, source_mtime TEXT, updated_at TEXT);
    CREATE TABLE work_people(work_id INTEGER, person_id INTEGER, role TEXT, sort_order INTEGER, source TEXT, updated_at TEXT, created_at TEXT);
    CREATE TABLE person_aliases(id INTEGER PRIMARY KEY, person_id INTEGER, alias TEXT, alias_search TEXT, source TEXT, updated_at TEXT);
    CREATE TABLE person_external_refs(id INTEGER PRIMARY KEY, person_id INTEGER, provider TEXT, external_key TEXT, url TEXT, source TEXT, updated_at TEXT);
    CREATE TABLE work_external_refs(id INTEGER PRIMARY KEY, work_id INTEGER, provider TEXT, external_key TEXT, url TEXT, source TEXT, updated_at TEXT);
    CREATE TABLE collections(id INTEGER PRIMARY KEY, name TEXT, provider TEXT, kind TEXT, source TEXT, updated_at TEXT);
    CREATE TABLE collection_items(collection_id INTEGER, work_id INTEGER, position INTEGER, updated_at TEXT);
  `);
  db.close();
}
