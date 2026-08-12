import assert from "node:assert/strict";
import fs from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const staticRoot = path.join(root, "src", "modules", "short-videos", "download-manager", "static");
const server = await startFixtureServer();
const baseUrl = `http://127.0.0.1:${server.address().port}`;

try {
  const browser = await chromium.launch({ executablePath: chromePath(), headless: true });
  try {
    await verifyProfilesLatestSuccess(browser);
    await verifyLibraryLatestFailure(browser);
    await verifyLinksResetSupersedesAppend(browser);
  } finally {
    await browser.close();
  }
  console.log("Douyin manager latest-request browser checks passed.");
} finally {
  await new Promise((resolve) => server.close(resolve));
}

async function verifyProfilesLatestSuccess(browser) {
  const page = await openFixture(browser);
  try {
    await page.evaluate(async () => {
      const { createProfilesFeature } = await import("/manager/features/profiles.js?latest-request-fixture=1");
      const { toast } = await import("/manager/core/dom.js?latest-request-fixture=1");
      const feature = createProfilesFeature({
        settings: {},
        refreshLinks: async () => {},
        refreshState: async () => {},
      });
      document.getElementById("profileManagerScope").value = "all";
      document.getElementById("profileManagerSearch").value = "延迟主页 A";
      window.profileRequestA = feature.activate().catch((error) => toast(error.message));
      document.getElementById("profileManagerSearch").value = "最新主页 B";
      window.profileRequestB = feature.activate().catch((error) => toast(error.message));
    });
    await waitForRequests(page, 2);
    assert.equal(await requestAborted(page, 0), true, "a newer profile reset must abort the delayed request");

    await settleRequest(page, 1, {
      profiles: [{ id: 202, nickname: "最新主页 B", tab: "post", total: 1, url: "https://example.invalid/b" }],
      total: 2,
      eligible_count: 1,
      deferred_count: 1,
      full_scan_required_count: 0,
      banned_count: 0,
    });
    await page.evaluate(() => window.profileRequestB);
    await settleRequest(page, 0, {
      profiles: [{ id: 101, nickname: "延迟主页 A", tab: "post", total: 1, url: "https://example.invalid/a" }],
      total: 99,
      eligible_count: 99,
      deferred_count: 0,
    });
    await page.evaluate(() => window.profileRequestA);

    const result = await page.evaluate(() => ({
      list: document.getElementById("profileManagerList").textContent,
      summary: document.getElementById("profileManagerSummary").textContent,
      toast: document.getElementById("toast").textContent,
    }));
    assert.match(result.list, /最新主页 B/);
    assert.doesNotMatch(result.list, /延迟主页 A/);
    assert.match(result.summary, /2 个主页 · 已加载 1 个/);
    assert.equal(result.toast, "", "a stale profile result must not raise an error prompt");
  } finally {
    await page.close();
  }
}

async function verifyLibraryLatestFailure(browser) {
  const page = await openFixture(browser);
  try {
    await page.evaluate(async () => {
      const { createLibraryFeature } = await import("/manager/features/library.js?latest-request-fixture=1");
      const { toast } = await import("/manager/core/dom.js?latest-request-fixture=1");
      const feature = createLibraryFeature({ showPage() {} });
      document.getElementById("librarySearch").value = "delayed-a";
      window.libraryRequestA = feature.activate().catch((error) => toast(error.message));
      document.getElementById("librarySearch").value = "latest-b";
      window.libraryRequestB = feature.activate().catch((error) => toast(error.message));
    });
    await waitForRequests(page, 2);
    assert.equal(await requestAborted(page, 0), true, "a newer library search must abort the delayed request");

    await settleRequest(page, 1, { ok: false, message: "最新搜索 B 失败" }, 503);
    await page.evaluate(() => window.libraryRequestB);
    await settleRequest(page, 0, {
      items: [{ id: 101, title: "延迟作品 A", media_type: "video", author: "旧作者" }],
      total: 50,
      next_offset: 1,
      has_more: true,
    });
    await page.evaluate(() => window.libraryRequestA);

    const result = await page.evaluate(() => ({
      grid: document.getElementById("libraryGrid").textContent,
      summary: document.getElementById("librarySummary").textContent,
      pagerHidden: document.getElementById("libraryLoadMore").hidden,
      pagerDisabled: document.getElementById("libraryLoadMore").disabled,
      toast: document.getElementById("toast").textContent,
    }));
    assert.doesNotMatch(result.grid, /延迟作品 A/);
    assert.match(result.grid, /还没有可显示的本地作品/);
    assert.equal(result.summary, "已显示 0 / 0 个本地作品");
    assert.equal(result.pagerHidden, true);
    assert.equal(result.pagerDisabled, false);
    assert.equal(result.toast, "最新搜索 B 失败", "the latest failure must remain visible after delayed A settles");
  } finally {
    await page.close();
  }
}

async function verifyLinksResetSupersedesAppend(browser) {
  const page = await openFixture(browser);
  try {
    await page.evaluate(async () => {
      const { createLinksFeature } = await import("/manager/features/links.js?latest-request-fixture=1");
      const feature = createLinksFeature({
        settings: { save: async () => {} },
        refreshState: async () => {},
      });
      feature.bind();
      window.linksInitial = feature.refresh();
    });
    await waitForRequests(page, 1);
    await settleRequest(page, 0, {
      links: [linkFixture(1, "初始作品", "pending")],
      total: 2,
      summary: { all: 2, pending: 2, failed: 0 },
    });
    await page.evaluate(() => window.linksInitial);

    await page.click("#loadMoreLinks");
    await waitForRequests(page, 2);
    await page.click('[data-filter="failed"]');
    await waitForRequests(page, 3);
    assert.equal(await requestAborted(page, 1), true, "a links reset must abort an in-flight append");

    await settleRequest(page, 2, {
      links: [linkFixture(3, "筛选结果 B", "failed")],
      total: 1,
      summary: { all: 1, pending: 0, failed: 1 },
    });
    await settleRequest(page, 1, {
      links: [linkFixture(2, "延迟追加 A", "downloaded")],
      total: 2,
      summary: { all: 88, pending: 0, failed: 0, downloaded: 88 },
    });
    await page.waitForFunction(() => document.getElementById("linksPager").textContent === "已加载 1 / 1");

    const result = await page.evaluate(() => ({
      rows: document.getElementById("linksBody").textContent,
      pager: document.getElementById("linksPager").textContent,
      pagerHidden: document.getElementById("loadMoreLinks").hidden,
      allCount: document.querySelector('[data-link-count="all"]').textContent,
      failedCount: document.querySelector('[data-link-count="failed"]').textContent,
      toast: document.getElementById("toast").textContent,
    }));
    assert.match(result.rows, /筛选结果 B/);
    assert.doesNotMatch(result.rows, /初始作品|延迟追加 A/);
    assert.equal(result.pager, "已加载 1 / 1");
    assert.equal(result.pagerHidden, true);
    assert.equal(result.allCount, "1");
    assert.equal(result.failedCount, "1");
    assert.equal(result.toast, "", "the superseded append must not raise an error prompt");
  } finally {
    await page.close();
  }
}

function linkFixture(id, title, status) {
  return {
    id,
    aweme_id: `fixture-${id}`,
    desc: title,
    status,
    profile_id: 1,
    profile_nickname: "夹具主页",
    profile_tab: "post",
    url: `https://example.invalid/work/${id}`,
    profile_url: "https://example.invalid/profile",
  };
}

async function openFixture(browser) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await page.goto(`${baseUrl}/fixture`, { waitUntil: "domcontentloaded" });
  await page.evaluate(() => {
    window.__managerRequests = [];
    window.fetch = (input, options = {}) => new Promise((resolve) => {
      window.__managerRequests.push({
        signal: options.signal || null,
        settle(payload, status = 200) {
          resolve({
            ok: status >= 200 && status < 300,
            status,
            text: async () => JSON.stringify(payload),
          });
        },
        url: String(input),
      });
    });
  });
  return page;
}

async function waitForRequests(page, count) {
  await page.waitForFunction((expected) => window.__managerRequests.length >= expected, count);
}

async function settleRequest(page, index, payload, status = 200) {
  await page.evaluate(({ requestIndex, responsePayload, responseStatus }) => {
    window.__managerRequests[requestIndex].settle(responsePayload, responseStatus);
  }, { requestIndex: index, responsePayload: payload, responseStatus: status });
}

function requestAborted(page, index) {
  return page.evaluate((requestIndex) => window.__managerRequests[requestIndex].signal?.aborted === true, index);
}

async function startFixtureServer() {
  const server = createServer((request, response) => {
    const url = new URL(request.url || "/", "http://127.0.0.1");
    if (url.pathname === "/fixture") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      response.end(fixtureHtml());
      return;
    }
    if (url.pathname.startsWith("/manager/")) {
      const filePath = path.resolve(staticRoot, url.pathname.slice("/manager/".length));
      const safePath = filePath.startsWith(`${staticRoot}${path.sep}`) && fs.statSync(filePath, { throwIfNoEntry: false })?.isFile();
      if (safePath) {
        response.writeHead(200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store" });
        fs.createReadStream(filePath).pipe(response);
        return;
      }
    }
    response.writeHead(404).end();
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return server;
}

function fixtureHtml() {
  return `<!doctype html><html><body>
    <div id="toast"></div>
    <input id="profileManagerSearch"><select id="profileManagerScope"><option value="collected">collected</option><option value="all">all</option></select>
    <select id="profileManagerSort"><option value="latest_desc">latest</option></select>
    <select id="profileManagerDeletedWorks"><option value="all">all</option><option value="pending">pending</option></select>
    <div id="profileManagerSummary"></div><div id="profileManagerList"></div><button id="confirmPendingProfiles"></button>
    <input id="profileUrl"><button id="extractStart"></button><button id="extractStop"></button><button id="profileRefreshStop"></button>
    <button id="refreshProfiles"></button><button id="importFollowing"></button><div id="extractState"></div>
    <button id="openLibraryQuick"></button><button id="openLibraryHome"></button><button id="libraryRefresh"></button>
    <input id="librarySearch"><div id="libraryGrid"></div><div id="librarySummary"></div><button id="libraryLoadMore"></button>
    <button id="syncManifest"></button><button id="resetFailedCurrent"></button><button id="resetFailedAll"></button>
    <button id="deleteEmptyFailed"></button><button id="deleteAllFailed"></button><input id="linksSearch">
    <button data-filter="" class="active"></button><button data-filter="failed"></button>
    <span data-link-count="all"></span><span data-link-count="failed"></span>
    <section class="home-links-panel"><div class="table-wrap"><table><tbody id="linksBody"></tbody></table></div></section>
    <div id="linksPager"></div><button id="loadMoreLinks"></button><div id="dbPath"></div>
  </body></html>`;
}

function chromePath() {
  const candidates = [
    process.env.CHROME_PATH,
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  ].filter(Boolean);
  const executable = candidates.find((candidate) => fs.existsSync(candidate));
  if (!executable) throw new Error("Chrome or Edge is required for the Douyin manager browser fixture; set CHROME_PATH when needed");
  return executable;
}
