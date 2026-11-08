import assert from "node:assert/strict";
import fs from "node:fs";
import { createServer } from "node:http";
import { once } from "node:events";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { createImageGalleryDbService } from "../src/modules/content-index/server/image-gallery-db-service.js";
import { createPhotoCatalogIntake } from "../src/modules/photos/server/photo-catalog-intake.js";
import { createPhotoCatalogService } from "../src/modules/photos/server/photo-catalog-service.js";
import { routePhotosApi } from "../src/modules/photos/server/routes.js";
import { ARCHIVE_IMAGE_INDEXER_VERSION, archiveDiskSignature } from "../src/platform/server/archive-image-service.js";
import { createStaticFileServer } from "../src/platform/server/static-files.js";
import { createVerifiedTempDir } from "./verified-temp-cleanup.mjs";

const executablePath = [
  process.env.CHROME_PATH,
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe"
].find((candidate) => candidate && fs.existsSync(candidate));
assert(executablePath, "Chrome or Edge is required for photo catalog browser verification");
const temp = createVerifiedTempDir("fanhao-photo-catalog-browser-");
const gallery = createImageGalleryDbService({ dbPath: path.join(temp.tempDir, "gallery.sqlite"), ensureDataDir() {} });
const scopedFolder = "fixture|目录 A/[重名] + 100%";
const localArchives = [
  ["already-local", "已有本地包", "原有合集"],
  ["matching-local", "样例 VOL.031", "用于比对"],
  ["local-only", "样例 VOL.041", "待登记目录", scopedFolder, "目录 A/[重名]"],
  ["manifest-only", "样例 VOL.051", "清单目录"],
  ["merge-local", "样例 VOL.032", "用于比对"],
  ["other-folder", "样例 VOL.042", "待登记目录", "fixture|目录 B/[重名] + 100%", "目录 B/[重名]"]
].map(([id, title, group, legacyKey = group, directory]) => ({
  id, title, group, legacyKey, directory, sourceRoot: temp.tempDir, relativePath: `${id}.rar`,
  rootLabel: "测试图库", category: id === "already-local" ? "初始分类" : "合成目录", archiveExt: ".rar", size: 17, personName: "本地推断"
}));
const archivePath = (album) => path.join(album.sourceRoot, album.relativePath);
const origin = "https://www.5280k.com";
const category = `${origin}/category/studios/fixture`;
const directoryUrl = `${origin}/category/zzhj`;
const bulkAggregate = `${origin}/199.html`;
const bulkCategory = `${origin}/category/studios/bulk-fixture`;
const post = (id, title, extra = "", issueLabel = "") => `<article id="post-${id}" class="post-item ${extra}">
  <span class="girl-nums"><b>${issueLabel}</b></span><a href="/${id}.html"><h2 class="entry-title">${title}</h2></a></article>`;
const sourcePages = new Map([
  [directoryUrl, post(11, "样例合集[3套/2G]", "category-zzhj")],
  [`${origin}/11.html`, `<article id="post-11" class="type-post category-zzhj"><h1 class="entry-title">样例合集[3套/2G]</h1><a href="${category}" rel="category tag">分类</a></article>`],
  [category, `${post(11, "样例合集[3套/2G]", "category-zzhj category-sticky")}
    ${post(31, "样例 VOL.031 [17P+1V/1G]", "", "031-2")}${post(32, "样例 VOL.032")}${post(33, "样例 VOL.033")}
    <a rel="next" href="${category}/page/2">下一页</a>`],
  [`${category}/page/2`, post(34, "样例 VOL.034")],
  [bulkAggregate, `<article id="post-199" class="type-post category-zzhj"><h1 class="entry-title">批次合集[42套/8G]</h1><a href="${bulkCategory}" rel="category tag">分类</a></article>`],
  [bulkCategory, `${Array.from({ length: 41 }, (_, index) => post(300 + index, `批次 VOL.${String(index + 1).padStart(3, "0")}`)).join("")}
    <a rel="next" href="${bulkCategory}/page/2">下一页</a>`],
  [`${bulkCategory}/page/2`, post(341, "批次 VOL.042")]
]);
const source = (id, title) => ({ provider: "5280k", externalId: String(id), url: `${origin}/${id}.html`, title });
const catalog = createPhotoCatalogService({
  getImageGalleryDb: gallery.getDb,
  photoSetById: (id) => localArchives.find((album) => album.id === id)
});
const catalogIntake = createPhotoCatalogIntake({
  catalog, archivePath, getPhotoSets: () => localArchives,
  describePhotoCollection: (album) => ({ key: album.legacyKey, title: album.group, directory: album.directory, category: album.category, rootLabel: album.rootLabel }),
  loadPublicSource: async (url) => {
    assert(sourcePages.has(url), `the source fixture must supply ${url}`);
    return { url, html: sourcePages.get(url) };
  }
});
const write = (values, requestId) => {
  const { plan, confirmationToken } = catalog.preview(values);
  return catalog.confirm({ plan, confirmationToken, requestId });
};
const calls = [];
const fixtureErrors = [];
const sendJson = (res, code, payload) => {
  res.writeHead(code, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
};
const notFound = (res) => sendJson(res, 404, { error: "fixture route not found" });
const staticServer = createStaticFileServer({
  publicDir: fileURLToPath(new URL("../public/", import.meta.url)),
  mimeTypes: { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8" },
  normalizeExt: (file) => path.extname(file).toLowerCase(), notFound
});
let failNextCommitResponse = false;
let holdQuery;
let releaseQuery;
let heldQueryStarted;
let heldQueryFinished;
let releaseStats;
const holdStats = new Promise((resolve) => { releaseStats = resolve; });
let initialStats = true;
const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://127.0.0.1");
    if (url.pathname === "/api/photo-catalog/stats") {
      if (req.headers["x-catalog-fixture-stats-error"]) return sendJson(res, 503, { error: "fixture statistics unavailable" });
      if (initialStats) {
        initialStats = false;
        await holdStats;
      }
    }
    if (url.pathname === "/api/photo-catalog" && url.searchParams.get("q") === "延迟测试") {
      heldQueryStarted();
      await holdQuery;
      heldQueryFinished();
    }
    if (url.pathname.startsWith("/api/") && await routePhotosApi(req, res, url, {
      catalog, catalogIntake, notFound,
      sendJson(response, code, data) {
        if (url.pathname.endsWith("/intake/commit") && failNextCommitResponse) {
          failNextCommitResponse = false;
          return sendJson(response, 503, { error: "fixture lost the response after committing" });
        }
        sendJson(response, code, data);
      },
      requireLocalAdmin(request, response) {
        if (!request.headers["x-catalog-fixture-read-only"]) return true;
        sendJson(response, 403, { error: "fixture requires local admin" });
        return false;
      },
      async readJsonBody(request) {
        const chunks = [];
        for await (const chunk of request) chunks.push(chunk);
        const body = JSON.parse(Buffer.concat(chunks).toString());
        calls.push({ path: url.pathname, body });
        return body;
      }
    })) return;
    if (url.pathname === "/photo/catalog" || /^\/(?:modules\/photos\/catalog\/|js\/api\.js$|platform\/accounts\/session-context\.js$)/.test(url.pathname)) {
      await staticServer.serveStatic(req, res, url.pathname);
    } else {
      notFound(res);
    }
  } catch (error) {
    fixtureErrors.push(error);
    if (!res.headersSent) sendJson(res, 500, { error: error.message });
  }
});

let browser;
try {
  for (const album of localArchives) fs.writeFileSync(archivePath(album), "synthetic fixture");
  const measuredArchive = archivePath(localArchives[0]);
  const stamp = archiveDiskSignature(measuredArchive, fs.statSync(measuredArchive));
  const measuredAt = "2026-11-07T00:00:00.000Z";
  gallery.getDb().prepare(`INSERT INTO photo_set_image_indexes(archive_path,archive_size,archive_mtime_ms,
    archive_identity,image_count,images_json,indexer_version,indexed_at,updated_at) VALUES (?,?,?,?,?,'[]',?,?,?)`)
    .run(stamp.archivePath, stamp.archiveSize, stamp.archiveMtimeMs, stamp.archiveIdentity, 7,
      ARCHIVE_IMAGE_INDEXER_VERSION, measuredAt, measuredAt);
  write({
    title: "已有作品", issueCode: "VOL.019", archiveIds: ["already-local"],
    sources: [source(19, "已有来源")],
    collections: [{ provider: "test", externalId: "collection", name: "已有合集" }],
    people: [{ name: "已有作者" }]
  }, "initial-local");
  gallery.getDb().prepare(`UPDATE photo_catalog_archives
    SET data_json=json_set(data_json,'$.declaredImageCount',19,'$.declaredVideoCount',2,'$.personHint','仅作线索')
    WHERE id=?`).run("already-local");
  for (let index = 0; index < 41; index += 1) {
    const title = index === 0 ? "延迟测试" : `来源作品 ${index}`;
    const releaseDate = index === 1 ? "2025-03-02" : index === 2 ? "2026-01-01" : undefined;
    write({ title, releaseDate, sources: [source(100 + index, title)] }, `initial-source-${index}`);
  }
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ executablePath, headless: true });
  const context = await browser.newContext();
  await context.route("**/*", (route) => route.request().url().startsWith(`${base}/`) ? route.continue() : route.abort());
  const page = await context.newPage();
  page.setDefaultTimeout(10_000);
  const requests = [];
  page.on("request", (request) => requests.push(new URL(request.url()).pathname));
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error));
  await page.goto(`${base}/photo/catalog`);
  const directory = page.locator("#directory");
  const intake = page.locator("#intake");
  const search = page.getByRole("searchbox", { name: "搜索" });
  const go = () => page.getByRole("button", { name: "搜索", exact: true }).click();
  const rows = directory.locator("#catalog-results > li");
  const choices = intake.locator("#intake-changes > li");
  const more = directory.getByRole("button", { name: "加载更多" });
  await directory.getByText("已显示 40 / 42 部作品").waitFor();
  assert(await page.getByText("正在读取统计…").isVisible(), "slow statistics must not block catalog results");
  releaseStats();
  const stats = page.locator("#catalog-stats-values");
  const metric = (name) => stats.locator("div").filter({ has: page.getByText(name, { exact: true }) }).locator("dd");
  await stats.waitFor();
  assert.equal(await metric("已登记作品").textContent(), "42");
  assert.equal(await metric("本地归档").textContent(), "1");
  assert.equal(await metric("本地大小").textContent(), "17 B");
  assert.equal(await metric("已实测归档").textContent(), "1 / 1");
  assert.equal(await metric("已实测图片").textContent(), "7 张");
  assert.equal(await metric("文件名标注图片").textContent(), "19 张（1 包）");
  assert.equal(await metric("文件名标注视频").textContent(), "2 段（1 包）");
  assert.equal(await metric("人物线索归档").textContent(), "1 / 1");
  assert(!requests.includes("/api/photo-catalog/intake/options"), "browsing does not read the local scan index");
  assert.equal(await page.locator("#local-count").textContent(), "1");
  assert.equal(await page.locator("#source-count").textContent(), "42");
  await more.click();
  await directory.getByText("已显示 42 / 42 部作品").waitFor();
  assert.equal(await rows.count(), 42);
  assert.equal(await more.isVisible(), false);
  await page.getByText("查看各分类统计（1）", { exact: true }).click();
  const categoryStats = page.getByRole("button", { name: "初始分类 1 部作品 · 1 个归档 · 17 B" });
  await categoryStats.click();
  await page.waitForURL((url) => url.searchParams.get("category") === "初始分类");
  await directory.getByText("已显示 1 / 1 部作品").waitFor();
  assert.equal(await categoryStats.getAttribute("aria-pressed"), "true");
  assert.equal(await page.getByLabel("按分类").inputValue(), "初始分类");
  assert.equal(await rows.getByText(/分类 初始分类/).count(), 1);
  await rows.getByText("文件名标注 19 张 · 2 段视频 · 人物线索 仅作线索", { exact: true }).waitFor();
  await rows.getByText(/本地实测 7 张/).waitFor();
  await page.getByLabel("按分类").selectOption("");
  await directory.getByText("已显示 40 / 42 部作品").waitFor();
  assert.equal(await categoryStats.getAttribute("aria-pressed"), "false");
  await page.getByLabel("按合集").selectOption({ label: "已有合集（1）" });
  await directory.getByText("已显示 1 / 1 部作品").waitFor();
  assert.equal(await rows.getByRole("link", { name: "阅读 已有本地包" }).getAttribute("href"), "/photo/set/already-local");
  await page.getByLabel("按人物").selectOption({ label: "已有作者（1）" });
  await page.waitForURL((url) => url.searchParams.has("collection") && url.searchParams.has("person"));
  await page.goBack();
  assert(!new URL(page.url()).searchParams.has("person"));
  await page.getByLabel("按合集").selectOption("");
  await directory.getByText("已显示 40 / 42 部作品").waitFor();
  await page.getByLabel("可用范围").selectOption("local");
  await directory.getByText("已显示 1 / 1 部作品").waitFor();
  assert.equal(await page.locator("#source-count").textContent(), "42", "source count remains independently visible under the local filter");
  await page.getByLabel("可用范围").selectOption("all");
  await directory.getByText("已显示 40 / 42 部作品").waitFor();
  await page.getByLabel("排序").selectOption("release");
  await page.waitForURL((url) => url.searchParams.get("sort") === "release");
  await rows.first().getByRole("heading", { name: "来源作品 2", exact: true }).waitFor();

  holdQuery = new Promise((resolve) => { releaseQuery = resolve; });
  const queryStarted = new Promise((resolve) => { heldQueryStarted = resolve; });
  const queryFinished = new Promise((resolve) => { heldQueryFinished = resolve; });
  await search.fill("延迟测试");
  await go();
  await queryStarted;
  await search.fill("vol.019");
  await go();
  await rows.getByRole("heading", { name: "已有作品" }).waitFor();
  releaseQuery();
  await queryFinished;
  assert.equal(await rows.count(), 1, "a slow search cannot replace the next filter result");
  assert.equal(await rows.first().getByText("VOL.019").count(), 1);

  const previewButton = intake.getByRole("button", { name: "生成预览" });
  const preview = () => previewButton.click();
  const confirmation = intake.getByRole("checkbox", { name: "确认将选中的资料写入套图目录" });
  const commitButton = intake.getByRole("button", { name: "确认入库", exact: true });
  await page.getByRole("link", { name: "入库工作台" }).click();
  await intake.getByLabel("比对本地合集（选填）").selectOption({ label: "用于比对 · 合成目录 · 测试图库（2 包）" });
  await intake.getByRole("button", { name: "浏览 5280k 合集目录" }).click();
  await intake.getByText("请选择来源合集，继续预览单期。").waitFor();
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], { path: "/api/photo-catalog/intake/preview", body: {
    mode: "source", url: directoryUrl, localCollectionId: await intake.getByLabel("比对本地合集（选填）").inputValue()
  } });
  assert.equal(await commitButton.isVisible(), false);
  await intake.getByRole("button", { name: "预览单期列表" }).click();
  await choices.getByRole("heading", { name: /VOL\.031/ }).waitFor();
  await intake.getByText(/当前来源合集.*来源标注 3套 · 2G/).waitFor();
  assert.equal(await choices.count(), 3);
  assert.equal(calls.filter((call) => call.path.endsWith("/commit")).length, 0);
  assert.equal(await commitButton.isDisabled(), true);
  const first = choices.filter({ has: page.getByRole("heading", { name: /VOL\.031/ }) });
  await first.getByRole("checkbox", { name: "样例 VOL.031 · 本地推断" }).check();
  await first.getByLabel("出镜人物（选填，以逗号分隔）").fill("前端人物、另一位");
  await first.getByLabel("归属/创作者（选填，以逗号分隔）").fill("制作方");
  await first.getByLabel("发行日期（选填）").fill("2024-11-07");
  const second = choices.filter({ has: page.getByRole("heading", { name: /VOL\.032/ }) });
  await second.getByRole("checkbox", { name: "样例 VOL.032 · 本地推断" }).check();
  await choices.filter({ hasText: "VOL.033" }).getByRole("checkbox", { name: "选择此条入库" }).uncheck();
  const priorLocal = write({ archiveIds: ["merge-local"], title: "并发登记的本地作品" }, "preview-race-archive").work;
  const priorSource = write({ title: "并发登记的来源", sources: [source(32, "并发登记的来源")] }, "preview-race").work;
  await confirmation.check();
  const [commitResponse] = await Promise.all([
    page.waitForResponse((response) => response.url().endsWith("/intake/commit")),
    commitButton.click()
  ]);
  const batch = await commitResponse.json();
  assert.equal(batch.imported, 1, JSON.stringify(batch));
  assert.equal(batch.failed, 1, JSON.stringify(batch));
  await intake.getByText("已入库 1 条 · 已处理 0 条 · 失败 1 条").waitFor();
  await metric("已登记作品").getByText("45", { exact: true }).waitFor();
  assert.equal(calls.filter((call) => call.path.endsWith("/commit")).length, 1);
  const firstCommit = calls.find((call) => call.path.endsWith("/commit")).body;
  assert.equal(firstCommit.confirmed, true);
  assert.equal(firstCommit.changes.length, 2);
  assert.deepEqual(firstCommit.changes[0].archiveIds, ["matching-local"]);
  assert.deepEqual(firstCommit.changes[0].people, [
    { name: "前端人物", role: "model" }, { name: "另一位", role: "model" }, { name: "制作方", role: "creator" }
  ]);
  assert.equal(firstCommit.changes[0].releaseDate, "2024-11-07");
  assert.match(await intake.locator("#receipt-results").textContent(), /失败/);
  assert.equal(new URL(page.url()).searchParams.get("q"), "vol.019");
  await intake.getByRole("button", { name: "预览下一批" }).click();
  await choices.getByRole("heading", { name: /VOL\.034/ }).waitFor();
  assert.equal(calls.at(-1).body.url, `${category}/page/2`);
  assert.equal(calls.at(-1).body.localCollectionId, calls[0].body.localCollectionId);
  assert.equal(calls.at(-1).body.sourceCollectionUrl, `${origin}/11.html`);

  await search.fill("vol.031");
  await go();
  await rows.getByText(/本地大小 17 B/).waitFor();
  await rows.getByText(/出镜人物 前端人物、另一位/).waitFor();
  await rows.getByText(/归属\/创作者 制作方/).waitFor();
  await rows.getByRole("link", { name: /来源标注 期号 031-2 · 17 张 · 1 段视频 · 1G/ }).waitFor();
  await intake.getByLabel("来源分类或合集 URL").fill(category);
  await preview();
  const mergeRow = choices.filter({ has: page.getByRole("heading", { name: "并发登记的来源" }) });
  const mergeBox = mergeRow.getByRole("checkbox", { name: "合并两条已有作品" });
  const archiveBox = mergeRow.getByRole("checkbox", { name: "样例 VOL.032 · 本地推断" });
  await archiveBox.check();
  assert(await mergeBox.isVisible());
  assert.equal(await mergeBox.isChecked(), false);
  assert(await confirmation.isDisabled());
  await mergeBox.check();
  await archiveBox.uncheck();
  await archiveBox.check();
  assert.equal(await mergeBox.isChecked(), false, "an archive change clears the separate merge consent");
  await mergeBox.check();
  assert(await confirmation.isDisabled(), "different manual titles require an explicit choice");
  await mergeRow.getByLabel("合并后保留的标题").selectOption({ label: "来源 · 并发登记的来源" });
  for (const row of await choices.all()) {
    if (await row.getByRole("heading", { name: "并发登记的来源" }).count() === 0) {
      await row.getByRole("checkbox", { name: "选择此条入库" }).uncheck();
    }
  }
  await confirmation.check();
  await commitButton.click();
  await intake.getByText("已入库 1 条 · 已处理 0 条 · 失败 0 条").waitFor();
  assert.deepEqual(calls.at(-1).body.changes[0].mergeWorkIds, [priorLocal.id, priorSource.id]);
  assert.equal(calls.at(-1).body.changes[0].title, "并发登记的来源", "the unchanged displayed value is sent explicitly when selected");
  assert.equal(catalog.detail("merge-local").id, priorLocal.id);
  assert.equal(catalog.detail("merge-local").title, "并发登记的来源");
  assert.equal(catalog.detail("merge-local").sources[0].externalId, "32");

  await intake.getByLabel("资料来自").selectOption("local");
  await intake.getByLabel("已扫描合集").selectOption({ label: "待登记目录 · 合成目录 · 目录 A/[重名] · 测试图库（1 包）" });
  await preview();
  await choices.getByRole("heading", { name: /VOL\.041/ }).waitFor();
  assert(await choices.getByRole("checkbox", { name: "样例 VOL.041 · 本地推断" }).isChecked());
  await choices.getByLabel("标题").fill("校正本地标题");
  failNextCommitResponse = true;
  await confirmation.check();
  await commitButton.click();
  await intake.getByText("暂未收到入库回执。可勾选确认后按原选择重试。").waitFor();
  assert(await choices.getByLabel("标题").isDisabled(), "a receipt retry preserves the submitted values");
  await confirmation.check();
  await intake.getByRole("button", { name: "重试确认入库", exact: true }).click();
  await intake.getByText("已入库 0 条 · 已处理 1 条 · 失败 0 条").waitFor();
  const commits = calls.filter((call) => call.path.endsWith("/commit"));
  assert.deepEqual(commits.at(-1).body, commits.at(-2).body);
  await search.fill("校正本地标题");
  await go();
  await rows.getByRole("heading", { name: "校正本地标题" }).waitFor();
  assert.equal(await rows.getByRole("link", { name: /阅读/ }).getAttribute("href"), "/photo/set/local-only");

  await intake.getByLabel("资料来自").selectOption("manifest");
  await page.setViewportSize({ width: 320, height: 850 });
  await intake.getByLabel("JSON 清单", { exact: true }).fill("broken{");
  const priorPreviews = calls.length;
  await preview();
  await intake.getByText("JSON 清单格式有误。请粘贴完整的导入清单。").waitFor();
  assert.equal(calls.length, priorPreviews);
  const manifest = {
    schema_version: 1,
    complete: true,
    plan: { roots: [{ post_id: 12345, destination_name: "清单合集" }] },
    results: [
      { status: "imported", post_id: 12345, sequence: 1, rar_path: archivePath(localArchives[3]), bytes: 17, image_count: 20 },
      { status: "imported", post_id: 12345, sequence: 2, rar_path: path.join(temp.tempDir, "missing.rar"), bytes: 17, image_count: 30 }
    ]
  };
  await intake.getByLabel("选择清单文件（选填）").setInputFiles({
    name: "fixture.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(manifest))
  });
  await preview();
  await choices.getByText("当前套图索引未找到清单中的压缩包").waitFor();
  assert.equal(await choices.getByRole("checkbox", { name: "选择此条入库" }).count(), 1);
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "catalog and preview fit a 320px viewport");
  await confirmation.check();
  await commitButton.click();
  await intake.getByText("已入库 1 条 · 已处理 0 条 · 失败 0 条").waitFor();
  assert.deepEqual(catalog.detail("manifest-only").archives.map(({ id }) => id), ["manifest-only"]);
  assert.equal(catalog.detail("manifest-only").measuredImageCount, null, "a manifest observation is not a measured image count");

  const scoped = await context.newPage();
  const beforeDeepLink = calls.length;
  const options = catalogIntake.options().localCollections;
  const folder = options.find(({ legacyKey }) => legacyKey === scopedFolder);
  assert(folder);
  await scoped.goto(`${base}/photo/catalog?${new URLSearchParams({ localCollection: scopedFolder })}#intake`);
  const chosen = scoped.getByLabel("已扫描合集");
  await scoped.getByRole("link", { name: "查看该合集已登记作品" }).waitFor();
  assert.equal(await scoped.getByLabel("资料来自").inputValue(), "local");
  assert.equal(await chosen.inputValue(), folder.id);
  assert.equal(await chosen.locator("option:checked").textContent(), "待登记目录 · 合成目录 · 目录 A/[重名] · 测试图库（1 包）");
  await scoped.getByLabel("资料来自").selectOption("source");
  assert.equal(await scoped.getByLabel("比对本地合集（选填）").inputValue(), folder.id);
  await scoped.getByLabel("资料来自").selectOption("local");
  assert.equal(await scoped.getByRole("link", { name: /返回图库合集/ }).getAttribute("href"), `/photo/collection/${encodeURIComponent(scopedFolder)}`);
  assert.equal(calls.length, beforeDeepLink, "opening a folder link performs no preview or commit");
  await scoped.getByRole("link", { name: "查看该合集已登记作品" }).click();
  await scoped.waitForURL((url) => url.searchParams.get("collection") === folder.catalogKey && url.hash === "#directory");
  await scoped.locator("#directory").getByText("已显示 1 / 1 部作品").waitFor();
  assert.equal(await scoped.locator("#catalog-results a").getAttribute("href"), "/photo/set/local-only");
  await scoped.getByRole("button", { name: "生成预览" }).click();
  await scoped.locator("#intake-changes").getByText("校正本地标题", { exact: true }).waitFor();
  assert.equal(calls.length, beforeDeepLink + 1);
  assert.deepEqual(calls.at(-1).body, { mode: "local", localCollectionId: folder.id });
  assert(await scoped.getByRole("button", { name: "确认入库", exact: true }).isDisabled());
  await scoped.goto(`${base}/photo/catalog?localCollection=unknown`);
  await scoped.getByText("无法定位链接中的扫描目录，请重新选择。").waitFor();
  assert.equal(await chosen.inputValue(), "");
  assert.equal(calls.length, beforeDeepLink + 1);
  await scoped.close();

  const bulk = await context.newPage();
  await bulk.goto(`${base}/photo/catalog#intake`);
  await bulk.getByLabel("来源分类或合集 URL").fill(bulkAggregate);
  await bulk.getByRole("button", { name: "生成预览" }).click();
  await bulk.getByText(/当前来源合集.*来源标注 42套 · 8G/).waitFor();
  assert.equal(await bulk.locator("#intake-changes > li").count(), 40);
  const nextBatch = bulk.getByRole("button", { name: "预览下一批" });
  await nextBatch.click();
  await bulk.getByRole("heading", { name: "批次 VOL.041" }).waitFor();
  assert.deepEqual(calls.at(-1).body, { mode: "source", url: bulkAggregate, offset: 40 });
  await nextBatch.click();
  await bulk.getByRole("heading", { name: "批次 VOL.042" }).waitFor();
  assert.deepEqual(calls.at(-1).body, { mode: "source", url: `${bulkCategory}/page/2`, sourceCollectionUrl: bulkAggregate });
  await bulk.close();

  const readOnly = await context.newPage();
  await readOnly.setExtraHTTPHeaders({ "x-catalog-fixture-read-only": "1", "x-catalog-fixture-stats-error": "1" });
  await readOnly.goto(`${base}/photo/catalog#intake`);
  await readOnly.getByText("入库工作台需要本机管理员权限。").waitFor();
  assert(await readOnly.getByRole("button", { name: "生成预览" }).isDisabled());
  await readOnly.getByText("目录统计暂不可用。").waitFor();
  await readOnly.locator("#catalog-results > li").first().waitFor();
  await readOnly.getByLabel("按分类").selectOption("初始分类");
  await readOnly.locator("#catalog-results").getByRole("heading", { name: "已有作品" }).waitFor();
  assert.deepEqual(fixtureErrors, []);
  assert.deepEqual(pageErrors, []);
  console.log("Photo catalog browser flow verified with production routes, synthetic archives, public HTML fixtures, and temporary SQLite.");
} finally {
  releaseStats();
  releaseQuery?.();
  await browser?.close();
  if (server.listening) {
    server.close();
    await once(server, "close");
  }
  gallery.close();
  temp.cleanup();
}
