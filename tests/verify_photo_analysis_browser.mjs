import assert from "node:assert/strict";
import fs from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { createImageGalleryDbService } from "../src/modules/content-index/server/image-gallery-db-service.js";
import { createImageLibraryService } from "../src/modules/content-index/server/image-library-service.js";
import { createPhotoLibraryStore } from "../src/modules/content-index/server/photo-library-store.js";
import { routeContentIndexApi } from "../src/modules/content-index/server/routes.js";
import { createStaticFileServer } from "../src/platform/server/static-files.js";

const executablePath = [
  process.env.CHROME_PATH,
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe"
].find(candidate => candidate && fs.existsSync(candidate));
assert(executablePath, "Chrome or Edge is required for photo analysis browser verification");
const galleryDb = createImageGalleryDbService({ dbPath: ":memory:", ensureDataDir() {} });
const root = path.resolve("synthetic-photo-analysis");
const photoSetService = { coverUrl: id => `/media/gallery-cover/${id}` };
const options = { photoSetService, photoCollectionRootValue: "__root__" };
const store = createPhotoLibraryStore({
  getDb: galleryDb.getDb, photoSetRoots: [root], archiveExts: [".zip"],
  project: createImageLibraryService(options).projectPhotoIndex
});
const service = createImageLibraryService({ ...options, photoLibraryStore: store });

function albums(collection, prefix, issues) {
  return issues.map(issue => {
    const id = `${collection}-${prefix}${issue}`;
    return {
      id, title: `样例 ${prefix}${String(issue).padStart(2, "0")}`, sourceRoot: root,
      relativePath: `合成分类/${collection}/${id}.zip`, category: "合成分类", subCategory: collection,
      rootLabel: "测试图库", size: 29, updatedAt: "2026-10-01T00:00:00Z"
    };
  });
}

store.publish({ photoSets: [
  ...albums("混合合集", "VOL.", [1, 2, 3, 4, 5, 6, 7]),
  ...albums("混合合集", "X", [1, 3, 5, 6, 8]),
  ...albums("混合合集", "Y", [1, 2, 3, 4, 6]),
  ...albums("单系列", "NO.", [1, 2, 4, 5, 6]),
  ...albums("完整合集", "NO.", [1, 2, 3, 4, 5])
] });

const sendJson = (res, code, data) => {
  res.writeHead(code, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data));
};
const notFound = res => sendJson(res, 404, { error: "fixture route not found" });
const staticServer = createStaticFileServer({
  publicDir: fileURLToPath(new URL("../public/", import.meta.url)),
  mimeTypes: { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8" },
  normalizeExt: file => path.extname(file).toLowerCase(), notFound
});
const { promise: holdAnalysis, resolve: releaseAnalysis } = Promise.withResolvers();
const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://127.0.0.1");
    if (url.pathname === "/api/image-library/photo-analysis") await holdAnalysis;
    if (!await routeContentIndexApi(req, res, url, { imageLibraryService: service, sendJson })) {
      await staticServer.serveStatic(req, res, url.pathname);
    }
  } catch (error) {
    sendJson(res, 500, { error: error.message });
  }
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
let browser;
try {
  browser = await chromium.launch({ executablePath });
  const page = await browser.newPage({ viewport: { width: 1160, height: 780 } });
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto(`${origin}/photo/analysis`);
  await page.getByLabel("显示范围").selectOption("missing");
  await page.getByLabel("排序").selectOption("missing");
  releaseAnalysis();

  await page.waitForFunction(() => document.querySelector("#analysis-summary").textContent !== "正在统计…");
  assert.match(await page.locator("#analysis-summary").innerText(), /缺期 5/u, "the summary includes every numbering family's gaps");
  const rows = page.locator("button.analysis-row");
  assert.equal(await rows.count(), 2, "the missing filter includes a collection with gaps outside its largest family");
  assert.match(await rows.first().innerText(), /混合合集/);
  assert.match(await rows.first().innerText(), /另有 2 个系列/);
  assert.match(await rows.nth(1).innerText(), /单系列/);
  assert.equal(await page.locator("#analysis-more").isVisible(), false);

  await rows.first().click();
  await page.getByRole("heading", { name: "缺少的期号 · 4" }).waitFor();
  const details = page.locator(".analysis-detail");
  assert.deepEqual(await details.locator(".analysis-issue-family").allTextContents(), ["X1–8 · 缺 3 期", "Y1–6 · 缺 1 期"]);
  assert.deepEqual(await details.locator(".analysis-chips li").allTextContents(), ["X2", "X4", "X7", "Y5"]);
  assert.equal(await details.getByText("没有发现缺期或重复。").count(), 0);
  assert.deepEqual(errors, [], "filters can be set while the analysis is loading");
  console.log("photo-analysis: aggregate all numbering families, filter, order and drill down in Chromium");
} finally {
  releaseAnalysis();
  if (browser) await browser.close();
  await staticServer.stop();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  galleryDb.close();
}
