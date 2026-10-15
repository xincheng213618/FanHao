import assert from "node:assert/strict";
import fs from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import process from "node:process";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const staticRoot = path.join(root, "src", "modules", "short-videos", "download-manager", "static");
await verifyLightweightEndpointRecovery();
const server = await startFixtureServer();
const baseUrl = `http://127.0.0.1:${server.address().port}`;

try {
  const browser = await chromium.launch({ executablePath: chromePath(), headless: true });
  try {
    await verifyProfilesLatestSuccess(browser);
    await verifyProfilesContinuousList(browser);
    await verifyProfilesPartialScope(browser);
    await verifyPageScrollLoadsLinks(browser);
    await verifyProfileManagementMenu(browser);
    await verifyProfilesDerivedPendingCount(browser);
    await verifyProfilesQueueStatus(browser);
    await verifyLibraryLatestFailure(browser);
    await verifyLinksUnavailablePresentation(browser);
    await verifyLinksDownloadProgress(browser);
    await verifyLinksRefreshPreservesInteraction(browser);
    await verifyLinksCursorAndBoundedRefresh(browser);
    await verifyLinksRefreshSupersededAndRecovery(browser);
    await verifyLinksRuntimeRefreshesCompletedRows(browser);
    await verifyKeyedListReorderAndRemoval(browser);
    await verifyLinksResetSupersedesAppend(browser);
    await verifyDownloadProbeClassification(browser);
  } finally {
    await browser.close();
  }
  console.log("Douyin manager latest-request browser checks passed.");
} finally {
  await new Promise((resolve) => server.close(resolve));
}

async function verifyLightweightEndpointRecovery() {
  const appSource = fs.readFileSync(path.join(staticRoot, "app.js"), "utf8");
  const apiSource = fs.readFileSync(path.join(staticRoot, "core", "api.js"), "utf8").replace(/^export /gm, "");
  const helperStart = appSource.indexOf("function createLightweightEndpoint(");
  const helperEnd = appSource.indexOf("function refreshState()", helperStart);
  const renderStart = appSource.indexOf("async function fetchAndRenderStatus()");
  const renderEnd = appSource.indexOf("statePoller = createSingleFlightPoller(", renderStart);
  assert.ok(helperStart >= 0 && helperEnd > helperStart && renderStart >= 0 && renderEnd > renderStart);

  function fixture() {
    let clock = 0;
    const pending = [];
    const calls = [];
    const renders = [];
    const context = vm.createContext({
      Date: { now: () => clock },
      fetch: async (url) => {
        calls.push(url);
        const response = pending.shift();
        assert.ok(response, `Unexpected fixture request: ${url}`);
        assert.equal(url, response.url);
        if (response.error) throw response.error;
        return {
          ok: response.status >= 200 && response.status < 300,
          status: response.status,
          text: async () => response.text ?? JSON.stringify(response.payload),
        };
      },
      profilesFeature: { renderStatus() {} },
      downloadsFeature: { renderStatus() {} },
      linksFeature: { renderRuntime: (state) => renders.push(state) },
      activityFeature: { render: (state) => renders.push(state) },
    });
    vm.runInContext(`${apiSource}\n${appSource.slice(helperStart, helperEnd)}\n${appSource.slice(renderStart, renderEnd)}\nconst statusEndpoint = createLightweightEndpoint('/api/status');\nconst activityEndpoint = createLightweightEndpoint('/api/activity');`, context);
    return {
      calls,
      renders,
      reply(url, status = 200, payload = { fixture: "lightweight" }, extra = {}) {
        pending.push({ url, status, payload, ...extra });
      },
      at(value) { clock = value; },
      run(name = "fetchAndRenderStatus") { return vm.runInContext(`${name}()`, context); },
      confirmed() { return vm.runInContext("statusEndpoint.confirmed", context); },
      evaluate(code) { return vm.runInContext(code, context); },
      assertDrained() { assert.equal(pending.length, 0); },
    };
  }

  const recovery = fixture();
  recovery.reply("/api/status", 503, { message: "Temporarily unavailable" });
  recovery.reply("/api/state?compact=1", 200, { fixture: "fallback" });
  await recovery.run();
  assert.equal(recovery.confirmed(), false);
  recovery.at(4999);
  recovery.reply("/api/state?compact=1");
  await recovery.run();
  recovery.at(5000);
  recovery.reply("/api/status");
  await recovery.run();
  assert.equal(recovery.confirmed(), true);
  assert.equal(recovery.renders.at(-1).fixture, "lightweight");

  // A confirmed capability survives a transport failure and repeated 503s.
  recovery.reply("/api/status", 0, {}, { error: new TypeError("Fixture connection interrupted") });
  recovery.reply("/api/state?compact=1");
  await recovery.run();
  assert.equal(recovery.confirmed(), true);
  recovery.at(10000);
  recovery.reply("/api/status", 503, { message: "Temporarily unavailable again" });
  recovery.reply("/api/state?compact=1");
  await recovery.run();
  recovery.at(15000);
  recovery.reply("/api/state?compact=1");
  await recovery.run();
  recovery.at(20000);
  recovery.reply("/api/status");
  await recovery.run();
  assert.equal(recovery.confirmed(), true);
  // Success resets the backoff, so the next failure retries after five seconds.
  recovery.reply("/api/status", 503);
  recovery.reply("/api/state?compact=1");
  await recovery.run();
  recovery.at(25000);
  recovery.reply("/api/status");
  await recovery.run();
  recovery.assertDrained();

  for (const [status, payload] of [
    [404, { message: "Legacy endpoint absent" }],
    [405, { message: "GET is unsupported" }],
    [501, { message: "Endpoint not implemented" }],
    [200, { ok: false, code: "ENDPOINT_NOT_SUPPORTED", message: "Unsupported endpoint" }],
  ]) {
    const legacy = fixture();
    legacy.reply("/api/status", status, payload);
    legacy.reply("/api/state?compact=1");
    await legacy.run();
    legacy.at(600000);
    legacy.reply("/api/state?compact=1");
    await legacy.run();
    assert.deepEqual(legacy.calls, ["/api/status", "/api/state?compact=1", "/api/state?compact=1"]);
    assert.equal(legacy.confirmed(), false);
    legacy.assertDrained();
  }

  const activity = fixture();
  activity.reply("/api/activity", 503);
  activity.reply("/api/state?compact=1");
  await activity.run("fetchAndRenderActivity");
  activity.at(10000);
  activity.reply("/api/activity");
  await activity.run("fetchAndRenderActivity");
  assert.deepEqual(activity.calls, ["/api/activity", "/api/state?compact=1", "/api/activity"]);
  activity.assertDrained();

  const metadata = fixture();
  for (const [status, payload] of [[404, { message: "Custom missing message" }], [503, { message: "Custom busy message", code: "BUSY" }]]) {
    metadata.reply("/fixture-error", status, payload);
    await assert.rejects(metadata.evaluate("api('/fixture-error')"), (error) => error.status === status && error.code === (payload.code || "") && error.message === payload.message);
  }
  metadata.reply("/fixture-error", 404, {}, { text: "Legacy non-JSON 404" });
  await assert.rejects(metadata.evaluate("api('/fixture-error')"), (error) => error.status === 404 && error.code === "" && error.message === "请求失败：404");
  metadata.assertDrained();
  console.log("Douyin manager lightweight endpoint recovery and API error metadata checks passed.");
}

async function verifyDownloadProbeClassification(browser) {
  const page = await openFixture(browser);
  try {
    const result = await page.evaluate(async () => {
      const { buildProbePresentation } = await import("/manager/features/downloads.js?probe-classification-fixture=1");
      const structured = buildProbePresentation({
        endpoint: "/aweme/v1/web/aweme/detail/",
        transport_ok: true,
        download_ready: false,
        http_status: 403,
        elapsed_ms: 80,
        error: "HTTP 403: Blocked by ArgusSecurityPlugin Signature Not Found",
        diagnostic: {
          outcome: "risk_control",
          rule: "signature.refused",
          label: "签名参数缺失",
          detail: "signature not found",
          action: "更新签名实现",
        },
      });
      const legacy = buildProbePresentation({
        endpoint: "/aweme/v1/web/aweme/detail/",
        transport_ok: true,
        download_ready: false,
        http_status: 403,
        elapsed_ms: 80,
        error: "HTTP 403: Blocked by ArgusSecurityPlugin Sign Invalid",
      });
      const busy = buildProbePresentation({
        ok: false,
        message: "自动下载正在运行，无需单独测试接口",
      });
      return { structured, legacy, busy };
    });
    assert.equal(result.structured.tone, "is-warning");
    assert.match(result.structured.summary, /HTTP 403/);
    assert.equal(result.structured.diagnostic.rule, "signature.refused");
    assert.equal(result.structured.diagnostic.label, "签名参数缺失");
    assert.match(result.structured.rawError, /ArgusSecurityPlugin/);
    assert.equal(result.legacy.diagnostic.rule, "signature.refused");
    assert.equal(result.legacy.diagnostic.label, "签名校验失败");
    assert.equal(result.busy.tone, "is-warning");
    assert.equal(result.busy.diagnostic.rule, "runtime.busy");
    assert.equal(result.busy.diagnostic.label, "自动下载运行中");
    assert.doesNotMatch(result.busy.summary, /连接失败/);
  } finally {
    await page.close();
  }
}

async function verifyProfilesDerivedPendingCount(browser) {
  const page = await openFixture(browser);
  try {
    await page.evaluate(async () => {
      const { createProfilesFeature } = await import("/manager/features/profiles.js?derived-pending-fixture=1");
      const feature = createProfilesFeature({
        settings: {},
        refreshLinks: async () => {},
        refreshState: async () => {},
      });
      window.derivedPendingRequest = feature.activate();
    });
    await waitForRequests(page, 1);
    await settleRequest(page, 0, {
      profiles: [{
        id: 15327,
        nickname: "待确认主页",
        tab: "post",
        total: 42,
        aweme_count: 30,
        has_deleted_works: 0,
        full_scan_required: 0,
        last_full_scan_at: null,
        url: "https://example.invalid/pending",
      }],
      total: 1,
      eligible_count: 0,
      deferred_count: 1,
      full_scan_required_count: 0,
      banned_count: 0,
    });
    await page.evaluate(() => window.derivedPendingRequest);
    const result = await page.evaluate(() => ({
      buttonText: document.getElementById("confirmPendingProfiles").textContent,
      buttonDisabled: document.getElementById("confirmPendingProfiles").disabled,
      list: document.getElementById("profileManagerList").textContent,
    }));
    assert.equal(result.buttonText, "一键确认待全量（1）");
    assert.equal(result.buttonDisabled, false);
    assert.match(result.list, /待全量确认/);
  } finally {
    await page.close();
  }
}

async function verifyProfilesQueueStatus(browser) {
  const page = await openFixture(browser);
  try {
    const result = await page.evaluate(async () => {
      const { createProfilesFeature } = await import("/manager/features/profiles.js?collection-queue-fixture=1");
      const feature = createProfilesFeature({
        settings: {},
        refreshLinks: async () => {},
        refreshState: async () => {},
      });
      feature.renderStatus({
        extract: {
          active: true,
          job_id: 41,
          current: { job_id: 41, type: "refresh", profile_ids: [101], full_scan: false, label: "1 个主页快速采集" },
          queued: 2,
          queue: [
            { job_id: 42, type: "refresh", profile_ids: [202], full_scan: true, label: "1 个主页全量采集" },
            { job_id: 43, type: "following", profile_ids: [], full_scan: false, label: "提取我的关注" },
          ],
        },
      });
      return {
        status: document.getElementById("extractState").textContent,
        statusTitle: document.getElementById("extractState").title,
        extractStart: document.getElementById("extractStart").textContent,
        refreshProfiles: document.getElementById("refreshProfiles").textContent,
        importFollowing: document.getElementById("importFollowing").textContent,
        extractStopHidden: document.getElementById("extractStop").hidden,
        profileStopHidden: document.getElementById("profileRefreshStop").hidden,
      };
    });
    assert.equal(result.status, "正在采集 · 待执行 2");
    assert.match(result.statusTitle, /另有 2 个待执行/);
    assert.equal(result.extractStart, "加入采集队列");
    assert.equal(result.refreshProfiles, "排队智能采集");
    assert.equal(result.importFollowing, "排队提取关注");
    assert.equal(result.extractStopHidden, false);
    assert.equal(result.profileStopHidden, false);
  } finally {
    await page.close();
  }
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

function profileFixtures(count, start = 1) {
  return Array.from({ length: count }, (_, index) => {
    const id = start + index;
    return {
      id, nickname: `作者 ${id}`, tab: "post", total: 12, aweme_count: 1000 - id,
      latest_work_create_time: id, url: "https://example.invalid/profile",
      nickname_history_json: JSON.stringify([`曾用名 ${id}`]),
      avatar_url: "/avatar.gif",
    };
  });
}

async function startProfilesFixture(page) {
  await page.evaluate(async () => {
    const { createProfilesFeature } = await import("/manager/features/profiles.js?continuous-fixture=1");
    window.profilesFeature = createProfilesFeature({
      settings: {}, refreshLinks: async () => {}, refreshState: async () => {},
    });
    window.profilesFeature.bind();
    window.profilesRequest = window.profilesFeature.activate();
  });
  await waitForRequests(page, 1);
}

async function verifyProfilesContinuousList(browser) {
  const page = await openFixture(browser);
  try {
    await startProfilesFixture(page);
    const requestUrl = await page.evaluate(() => window.__managerRequests[0].url);
    assert.equal(new URL(requestUrl, baseUrl).searchParams.get("limit"), "500");
    const profiles = profileFixtures(350);
    const initial = await page.evaluate(async (profiles) => {
      const started = performance.now();
      window.__managerRequests[0].settle({ profiles, total: profiles.length });
      await window.profilesRequest;
      await new Promise(requestAnimationFrame);
      return {
        count: document.querySelectorAll("[data-profile-id]").length,
        hasMore: Boolean(document.querySelector("[data-profile-load-more]")),
        placeholder: Boolean(document.querySelector(".profile-manager-empty")),
        summary: document.getElementById("profileManagerSummary").textContent,
        renderMs: Math.round(performance.now() - started),
      };
    }, profiles);
    assert.equal(initial.count, 350);
    assert.equal(initial.hasMore, false);
    assert.equal(initial.placeholder, false, "loading placeholder must be removed by the keyed list");
    assert.match(initial.summary, /350 个主页 · 全部已加载/);

    // A historical name must be found even near the end of the complete scope.
    await page.locator("#profileManagerSearch").fill("曾用名 349");
    await page.waitForFunction(() => document.querySelectorAll("[data-profile-id]").length === 1);
    assert.equal(await page.locator("[data-profile-id]").getAttribute("data-profile-id"), "349");
    assert.match(await page.locator("#profileManagerSummary").textContent(), /1 个主页 · 全部已加载/);
    await page.locator("#profileManagerSearch").fill("");
    await page.waitForFunction(() => document.querySelectorAll("[data-profile-id]").length === 350);
    await page.evaluate(() => { window.retainedProfile = document.querySelector('[data-profile-id="350"]'); });
    await page.locator("#profileManagerSort").selectOption("works_desc");
    assert.equal(await page.locator("[data-profile-id]").first().getAttribute("data-profile-id"), "1");
    assert.equal(await page.evaluate(() => window.retainedProfile === document.querySelector('[data-profile-id="350"]')), true);
    await page.locator("#profileManagerDeletedWorks").selectOption("pending");
    assert.equal(await page.locator("[data-profile-id]").count(), 0);
    await page.locator("#profileManagerDeletedWorks").selectOption("all");
    assert.equal(await page.locator("[data-profile-id]").count(), 350);
    assert.equal(await page.evaluate(() => window.__managerRequests.length), 1, "complete scopes must search, sort and filter without another API call");

    await page.locator("#profileManagerSort").selectOption("latest_desc");
    await page.waitForFunction(() => document.querySelector('[data-profile-id="350"] img').hasAttribute("src"));
    await page.evaluate(() => {
      window.retainedProfile = document.querySelector('[data-profile-id="350"]');
      window.retainedAvatar = window.retainedProfile.querySelector("img");
      window.retainedButton = window.retainedProfile.querySelector("button");
      window.retainedButton.focus();
      window.profilesRequest = window.profilesFeature.activate();
    });
    await waitForRequests(page, 2);
    await settleRequest(page, 1, { profiles, total: 350 });
    await page.evaluate(() => window.profilesRequest);
    assert.equal(await page.evaluate(() => (
      window.retainedProfile === document.querySelector('[data-profile-id="350"]')
      && window.retainedAvatar === window.retainedProfile.querySelector("img")
      && document.activeElement === window.retainedButton
    )), true, "unchanged refresh must preserve row, loaded avatar and keyboard focus");
    const images = await page.evaluate(() => ({
      loaded: document.querySelectorAll("#profileManagerList img[src]").length,
      deferred: document.querySelectorAll("img[data-profile-avatar-src]").length,
    }));
    assert.ok(images.loaded > 0 && images.deferred > 300, "offscreen avatars must remain deferred");
    console.log(`Profiles fixture: 350 rows rendered in ${initial.renderMs} ms; search/sort/filter used no additional requests; ${images.deferred} avatars deferred.`);

    // Returning to the page refreshes the snapshot, including removed profiles.
    await page.evaluate(() => { window.profilesRequest = window.profilesFeature.activate(); });
    await waitForRequests(page, 3);
    await settleRequest(page, 2, { profiles: profiles.slice(0, 349), total: 349 });
    await page.evaluate(() => window.profilesRequest);
    await page.locator("#profileManagerSearch").fill("曾用名 350");
    await page.waitForFunction(() => document.querySelectorAll("[data-profile-id]").length === 0);
    assert.equal(await page.evaluate(() => window.__managerRequests.length), 3);
  } finally {
    await page.close();
  }
}

async function verifyProfilesPartialScope(browser) {
  const page = await openFixture(browser);
  try {
    await startProfilesFixture(page);
    const profiles = profileFixtures(500);
    await settleRequest(page, 0, { profiles, total: 501 });
    await page.evaluate(() => window.profilesRequest);
    assert.match(await page.locator("#profileManagerSummary").textContent(), /501 个主页 · 已加载 500 个/);
    await page.locator("#profileManagerSearch").fill("作者 501");
    await waitForRequests(page, 2);
    const searchUrl = await page.evaluate(() => window.__managerRequests[1].url);
    assert.equal(new URL(searchUrl, baseUrl).searchParams.get("q"), "作者 501", "partial scopes must query the server, not silently omit unloaded matches");
    await settleRequest(page, 1, { profiles: profileFixtures(1, 501), total: 1 });
    await page.waitForFunction(() => document.querySelectorAll("[data-profile-id]").length === 1);
    await page.locator("#profileManagerSearch").fill("");
    await waitForRequests(page, 3);
    await settleRequest(page, 2, { profiles, total: 501 });
    await page.waitForFunction(() => document.querySelectorAll("[data-profile-id]").length === 500);
    const profileScroll = await page.evaluate(() => {
      location.hash = "profiles";
      window.scrollTo(0, document.documentElement.scrollHeight);
      const list = document.getElementById("profileManagerList");
      return { overflow: getComputedStyle(list).overflowY, innerScroll: list.scrollTop, pageScroll: window.scrollY };
    });
    assert.equal(profileScroll.overflow, "visible");
    assert.equal(profileScroll.innerScroll, 0);
    assert.ok(profileScroll.pageScroll > 0, "the document, not the profile list, must scroll");
    await waitForRequests(page, 4);
    const appendUrl = await page.evaluate(() => window.__managerRequests[3].url);
    assert.equal(new URL(appendUrl, baseUrl).searchParams.get("offset"), "500");
    await settleRequest(page, 3, { profiles: profileFixtures(1, 501), total: 501 });
    await page.waitForFunction(() => document.querySelectorAll("[data-profile-id]").length === 501);
    await page.locator("#profileManagerSearch").fill("作者 501");
    await page.waitForFunction(() => document.querySelectorAll("[data-profile-id]").length === 1);
    assert.equal(await page.evaluate(() => window.__managerRequests.length), 4, "a completed multi-page scope can now be searched locally");
  } finally {
    await page.close();
  }
}

async function verifyPageScrollLoadsLinks(browser) {
  const page = await openFixture(browser);
  try {
    await page.evaluate(async () => {
      const { createLinksFeature } = await import("/manager/features/links.js?page-scroll-fixture=1");
      location.hash = "home";
      window.linksFeature = createLinksFeature({ settings: {}, refreshState: async () => {} });
      window.linksFeature.bind();
      window.linksRequest = window.linksFeature.refresh();
    });
    await waitForRequests(page, 1);
    const links = Array.from({ length: 100 }, (_, index) => ({ id: index + 1, aweme_id: String(index + 1), status: "downloaded", desc: `作品 ${index + 1}` }));
    await settleRequest(page, 0, { links, total: 101 });
    await page.evaluate(() => window.linksRequest);
    const scroll = await page.evaluate(() => {
      window.scrollTo(0, document.documentElement.scrollHeight);
      const list = document.querySelector(".home-links-panel .table-wrap");
      return { overflow: getComputedStyle(list).overflowY, innerScroll: list.scrollTop, pageScroll: window.scrollY };
    });
    assert.equal(scroll.overflow, "visible");
    assert.equal(scroll.innerScroll, 0);
    assert.ok(scroll.pageScroll > 0);
    await waitForRequests(page, 2);
    assert.equal(new URL(await page.evaluate(() => window.__managerRequests[1].url), baseUrl).searchParams.get("offset"), "100");
    await settleRequest(page, 1, { links: [{ id: 101, aweme_id: "101", status: "downloaded", desc: "后续作品" }], total: 101 });
    await page.waitForFunction(() => document.querySelectorAll("#linksBody tr").length === 101);
    assert.equal(await page.locator("#loadMoreLinks").isVisible(), false);
  } finally {
    await page.close();
  }
}

async function verifyProfileManagementMenu(browser) {
  const page = await openFixture(browser);
  try {
    await startProfilesFixture(page);
    await settleRequest(page, 0, { profiles: profileFixtures(1), total: 1 });
    await page.evaluate(() => window.profilesRequest);
    const menu = page.locator(".profile-row-menu");
    await menu.locator("summary").click();
    assert.equal(await menu.locator("[data-profile-full-refresh]").isVisible(), true);
    assert.equal(await menu.locator("[data-profile-auto-collect]").isVisible(), true);
    assert.equal(await menu.locator("[data-profile-delete]").isVisible(), true);
    await menu.locator("summary").press("Escape");
    assert.equal(await menu.getAttribute("open"), null);
    await menu.locator("summary").click();
    await menu.locator("[data-profile-auto-collect]").click();
    await waitForRequests(page, 2);
    const mutation = await page.evaluate(() => ({ url: window.__managerRequests[1].url, body: window.__managerRequests[1].body }));
    assert.equal(mutation.url, "/api/profiles/auto-collect");
    assert.deepEqual(JSON.parse(mutation.body), { profile_id: 1, enabled: false });
    assert.equal(await menu.getAttribute("open"), null, "choosing an action closes the menu");
    await settleRequest(page, 1, { ok: true });
    await waitForRequests(page, 3);
    await settleRequest(page, 2, { profiles: [{ ...profileFixtures(1)[0], auto_collect_enabled: 0 }], total: 1 });
    await page.waitForFunction(() => document.querySelector("[data-profile-auto-collect]").textContent === "加入一键采集");
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

async function verifyLinksUnavailablePresentation(browser) {
  const page = await openFixture(browser);
  try {
    await page.evaluate(async () => {
      const { createLinksFeature } = await import("/manager/features/links.js?unavailable-fixture=1");
      const feature = createLinksFeature({
        settings: { save: async () => {} },
        refreshState: async () => {},
      });
      window.linksUnavailable = feature.refresh();
    });
    await waitForRequests(page, 1);
    await settleRequest(page, 0, {
      links: [{
        ...linkFixture(4, "已下架图文", "failed"),
        last_error: "作品已不可用（作者可能已删除作品或更改可见权限）：7681299406105568677",
      }],
      total: 1,
      summary: { all: 1, pending: 0, failed: 1 },
    });
    await page.evaluate(() => window.linksUnavailable);

    const result = await page.evaluate(() => ({
      row: document.getElementById("linksBody").textContent,
      retryExists: Boolean(document.querySelector("[data-link-retry]")),
      deleteText: document.querySelector("[data-link-delete]")?.textContent,
    }));
    assert.match(result.row, /已不可用/);
    assert.match(result.row, /作者可能已删除作品或更改可见权限；可移除此记录/);
    assert.equal(result.retryExists, false);
    assert.match(result.deleteText || "", /移除已不可用记录/);
  } finally {
    await page.close();
  }
}

async function verifyLinksDownloadProgress(browser) {
  const page = await openFixture(browser);
  try {
    await page.evaluate(async () => {
      const { createLinksFeature } = await import("/manager/features/links.js?download-progress-fixture=1");
      const feature = createLinksFeature({
        settings: { save: async () => {} },
        refreshState: async () => {},
      });
      window.linksProgressFeature = feature;
      window.linksProgressLoad = feature.refresh();
    });
    await waitForRequests(page, 1);
    await settleRequest(page, 0, {
      links: [linkFixture(5, "慢速视频", "downloading")],
      total: 1,
      summary: { all: 1, downloading: 1 },
    });
    await page.evaluate(() => window.linksProgressLoad);
    await page.evaluate(() => window.linksProgressFeature.renderRuntime({
      download: {
        items: [{
          aweme_id: "fixture-5",
          phase: "下载视频",
          elapsed_seconds: 42,
          bytes_downloaded: 5 * 1024 * 1024,
          bytes_total: 10 * 1024 * 1024,
          speed_bytes_per_second: 250000,
          current_file: "fixture-5.mp4",
        }],
      },
    }));

    const result = await page.evaluate(() => ({
      text: document.querySelector("[data-download-progress]")?.textContent,
      title: document.querySelector("[data-download-progress]")?.title,
    }));
    assert.match(result.text || "", /下载视频 · 00:42/);
    assert.match(result.text || "", /5\.0 MB \/ 10\.0 MB · 50%/);
    assert.match(result.text || "", /2\.0 Mbps/);
    assert.equal(result.title, "fixture-5.mp4");
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

async function verifyLinksRefreshPreservesInteraction(browser) {
  const page = await openFixture(browser);
  try {
    await page.evaluate(async () => {
      const { createLinksFeature } = await import("/manager/features/links.js");
      window.stableLinks = createLinksFeature({ settings: {}, refreshState: async () => {} });
      window.stableLoad = window.stableLinks.refresh();
    });
    const payload = { links: [linkFixture(1, "保留展开状态", "downloaded")], total: 1 };
    await waitForRequests(page, 1);
    await settleRequest(page, 0, payload);
    await page.evaluate(() => window.stableLoad);
    await page.locator(".link-row-details summary").click();
    await page.evaluate(() => {
      window.savedRow = document.querySelector("#linksBody tr");
      window.savedFocus = document.activeElement;
      window.stableLoad = window.stableLinks.refreshLoaded();
    });
    await waitForRequests(page, 2);
    await settleRequest(page, 1, payload);
    await page.evaluate(() => window.stableLoad);
    assert.deepEqual(await page.evaluate(() => ({
      sameRow: window.savedRow === document.querySelector("#linksBody tr"),
      open: document.querySelector(".link-row-details").open,
      sameFocus: window.savedFocus === document.activeElement,
    })), { sameRow: true, open: true, sameFocus: true });
    await page.evaluate(() => { window.stableLoad = window.stableLinks.refreshLoaded(); });
    await waitForRequests(page, 3);
    await settleRequest(page, 2, { links: [linkFixture(1, "已更新标题", "failed")], total: 1 });
    await page.evaluate(() => window.stableLoad);
    assert.match(await page.locator("#linksBody").innerText(), /已更新标题/);
    assert.equal(await page.locator(".link-row-details").evaluate((node) => node.open), true, "changed row keeps expanded details");
    assert.equal(await page.evaluate(() => document.activeElement === document.querySelector(".link-row-details summary")), true, "changed row restores focus");
  } finally {
    await page.close();
  }
}

async function verifyLinksCursorAndBoundedRefresh(browser) {
  const page = await openFixture(browser);
  try {
    await page.evaluate(async () => {
      const { createLinksFeature } = await import("/manager/features/links.js");
      window.cursorLinks = createLinksFeature({ settings: {}, refreshState: async () => {} });
      window.cursorLinks.bind();
      window.cursorLoad = window.cursorLinks.refresh();
    });
    const first = Array.from({ length: 100 }, (_, i) => linkFixture(205 - i, `作品 ${205 - i}`, "pending"));
    const second = Array.from({ length: 100 }, (_, i) => linkFixture(105 - i, `作品 ${105 - i}`, "pending"));
    await waitForRequests(page, 1);
    assert.equal(await page.evaluate(() => new URL(window.__managerRequests[0].url, location.href).searchParams.get("paging")), "cursor");
    await settleRequest(page, 0, { links: first, total: 205, paging: "cursor", has_more: true, next_cursor: "cursor-106", page_cursor: "cursor-106" });
    await page.evaluate(() => window.cursorLoad);
    await page.locator("#loadMoreLinks").dispatchEvent("click");
    await waitForRequests(page, 2);
    assert.deepEqual(await page.evaluate(() => {
      const params = new URL(window.__managerRequests[1].url, location.href).searchParams;
      return { cursor: params.get("cursor"), offset: params.get("offset") };
    }), { cursor: "cursor-106", offset: null });
    await settleRequest(page, 1, { links: second, total: 205, paging: "cursor", has_more: true, next_cursor: "cursor-6", page_cursor: "cursor-6" });
    await page.waitForFunction(() => document.querySelectorAll("#linksBody tr[data-link-id]").length === 200);
    await page.evaluate(() => {
      document.querySelector('tr[data-link-id="205"] .link-row-details').open = true;
      window.untouchedLinkRow = document.querySelector('tr[data-link-id="200"]');
      window.scrollTo(0, document.querySelector('tr[data-link-id="140"]').offsetTop);
      window.savedLinkAnchorTop = document.querySelector('tr[data-link-id="140"]').getBoundingClientRect().top;
      window.cursorLoad = window.cursorLinks.refreshLoaded([205, 204]);
    });
    await waitForRequests(page, 3);
    const refresh = await page.evaluate(() => {
      const url = new URL(window.__managerRequests[2].url, location.href);
      return { path: url.pathname, ids: url.searchParams.get("ids").split(",").map(Number), cursor: url.searchParams.get("cursor") };
    });
    assert.equal(refresh.path, "/api/links/refresh");
    assert.equal(refresh.cursor, "cursor-6");
    assert.ok(refresh.ids.length <= 100 && refresh.ids.includes(205) && refresh.ids.includes(204));
    await settleRequest(page, 2, {
      links: [linkFixture(205, "下载已完成", "downloaded"), linkFixture(204, "下载失败", "failed")],
      missing_ids: [203], total: 208, summary: { all: 208, pending: 206, downloaded: 1, failed: 1 },
    });
    await page.evaluate(() => window.cursorLoad);
    assert.equal(await page.locator('tr[data-link-id="205"] .badge.downloaded').count(), 1);
    assert.equal(await page.locator('tr[data-link-id="204"] .badge.failed').count(), 1);
    assert.equal(await page.evaluate(() => window.untouchedLinkRow === document.querySelector('tr[data-link-id="200"]')), true);
    assert.equal(await page.locator('tr[data-link-id="205"] .link-row-details').evaluate((node) => node.open), true);
    assert.equal(await page.locator('[data-link-count="failed"]').textContent(), "1");
    assert.equal(await page.locator('tr[data-link-id="203"]').count(), 0);
    assert.ok(await page.evaluate(() => Math.abs(document.querySelector('tr[data-link-id="140"]').getBoundingClientRect().top - window.savedLinkAnchorTop) < 1), "bounded refresh preserves the visible scroll anchor after removal");
    await page.locator("#loadMoreLinks").dispatchEvent("click");
    await waitForRequests(page, 4);
    assert.equal(await page.evaluate(() => new URL(window.__managerRequests[3].url, location.href).searchParams.get("cursor")), "cursor-6", "passive refresh preserves the traversal boundary");
    await settleRequest(page, 3, {
      links: [5, 4, 3, 2, 1].map((id) => linkFixture(id, `作品 ${id}`, "pending")), total: 208,
      paging: "cursor", has_more: false, next_cursor: null, page_cursor: "cursor-1",
    });
    await page.waitForFunction(() => document.querySelectorAll("#linksBody tr[data-link-id]").length === 204);
    assert.equal(await page.locator("#loadMoreLinks").evaluate((node) => node.hidden), true, "a larger live total must not reopen an exhausted cursor");
    // Rotate refresh coverage while preserving loaded keyed rows.
    await page.evaluate(() => { window.cursorLoad = window.cursorLinks.refreshLoaded(); });
    await waitForRequests(page, 5);
    const rotated = await page.evaluate(() => new URL(window.__managerRequests[4].url, location.href).searchParams.get("ids").split(",").map(Number));
    assert.ok(rotated.some((id) => id < 106), "offscreen loaded IDs receive a rotating refresh budget");
    await settleRequest(page, 4, { links: [], missing_ids: [], total: 208 });
    await page.evaluate(() => window.cursorLoad);
    await page.evaluate(() => { window.cursorLoad = window.cursorLinks.refresh(); });
    await waitForRequests(page, 6);
    assert.equal(await page.evaluate(() => new URL(window.__managerRequests[5].url, location.href).searchParams.get("cursor")), null, "active refresh starts a fresh watermark");
    await settleRequest(page, 5, { links: [linkFixture(208, "新水位作品", "pending")], total: 208, paging: "cursor", has_more: false, next_cursor: null, page_cursor: "new-watermark" });
    await page.evaluate(() => window.cursorLoad);
  } finally { await page.close(); }
}

async function verifyLinksRefreshSupersededAndRecovery(browser) {
  const page = await openFixture(browser);
  try {
    await page.evaluate(async () => {
      const { createLinksFeature } = await import("/manager/features/links.js");
      window.refreshLinks = createLinksFeature({ settings: {}, refreshState: async () => {} });
      window.refreshLinks.bind();
      window.refreshLoad = window.refreshLinks.refresh();
    });
    await waitForRequests(page, 1);
    await settleRequest(page, 0, { links: [linkFixture(1, "旧记录", "pending")], total: 1 });
    await page.evaluate(() => window.refreshLoad);
    await page.evaluate(() => { window.refreshLoad = window.refreshLinks.refreshLoaded(); });
    await waitForRequests(page, 2);
    await page.locator('[data-filter="failed"]').dispatchEvent("click");
    await waitForRequests(page, 3);
    assert.equal(await requestAborted(page, 1), true, "query reset aborts the bounded refresh");
    await settleRequest(page, 2, { links: [linkFixture(2, "失败匹配项", "failed")], total: 1 });
    await settleRequest(page, 1, { links: [linkFixture(1, "过期刷新", "downloaded")], total: 99, summary: { all: 99 } });
    await page.evaluate(() => window.refreshLoad);
    await page.waitForFunction(() => document.querySelector("#linksBody").textContent.includes("失败匹配项"));
    assert.doesNotMatch(await page.locator("#linksBody").innerText(), /过期刷新/);
    await page.evaluate(() => { window.refreshLoad = window.refreshLinks.refreshLoaded().catch((error) => { window.refreshError = error.status; }); });
    await waitForRequests(page, 4);
    await settleRequest(page, 3, { message: "fixture temporary failure" }, 503);
    await page.evaluate(() => window.refreshLoad);
    assert.equal(await page.evaluate(() => window.refreshError), 503);
    await page.evaluate(() => { window.refreshLoad = window.refreshLinks.refreshLoaded(); });
    await waitForRequests(page, 5);
    assert.match(await page.evaluate(() => window.__managerRequests[4].url), /\/api\/links\/refresh\?/);
    await settleRequest(page, 4, { links: [], missing_ids: [2], total: 0, summary: { all: 1, failed: 0 } });
    await page.evaluate(() => window.refreshLoad);
    assert.equal(await page.locator("#linksBody tr[data-link-id]").count(), 0, "changed status removes a nonmatching filtered row");
    // Legacy servers explicitly reject the new endpoint and keep offset compatibility.
    await page.evaluate(() => { window.refreshLoad = window.refreshLinks.refreshLoaded(); });
    await waitForRequests(page, 6);
    await settleRequest(page, 5, { message: "not found" }, 404);
    await waitForRequests(page, 7);
    assert.match(await page.evaluate(() => window.__managerRequests[6].url), /^\/api\/links\?/);
    await settleRequest(page, 6, { links: [], total: 0 });
    await page.evaluate(() => window.refreshLoad);
  } finally { await page.close(); }
}

async function verifyLinksRuntimeRefreshesCompletedRows(browser) {
  const page = await openFixture(browser);
  try {
    await page.evaluate(async () => {
      const { createLinksFeature } = await import("/manager/features/links.js");
      window.activityLinks = createLinksFeature({ settings: {}, refreshState: async () => {} });
      window.activityLoad = window.activityLinks.refresh();
    });
    await waitForRequests(page, 1);
    await settleRequest(page, 0, { links: [linkFixture(1, "活动下载", "downloading")], total: 1 });
    await page.evaluate(() => window.activityLoad);
    await page.evaluate(() => window.activityLinks.renderRuntime({ download: { items: [{ aweme_id: "fixture-1", phase: "下载中" }] } }));
    await waitForRequests(page, 2);
    await settleRequest(page, 1, { links: [linkFixture(1, "活动下载", "downloading")], total: 1 });
    await page.waitForFunction(() => document.querySelector(".badge.downloading"));
    // Finish the microtask chain before the activity disappears.
    await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 0)));
    await page.evaluate(() => window.activityLinks.renderRuntime({ download: { items: [] } }));
    await waitForRequests(page, 3);
    await settleRequest(page, 2, { links: [linkFixture(1, "活动下载", "downloaded")], total: 1, summary: { all: 1, downloaded: 1 } });
    await page.waitForFunction(() => document.querySelector(".badge.downloaded"));
    assert.equal(await page.locator("[data-download-progress]").count(), 0, "completed activity replaces stale downloading progress");
  } finally { await page.close(); }
}

async function verifyKeyedListReorderAndRemoval(browser) {
  const page = await openFixture(browser);
  try {
    const result = await page.evaluate(async () => {
      const { createKeyedListRenderer } = await import("/manager/core/keyed-list.js");
      const grid = document.getElementById("libraryGrid");
      const render = createKeyedListRenderer(grid);
      const key = (id) => id;
      const card = (id) => `<article data-id="${id}"><button>作品 ${id}</button></article>`;
      render([1, 2], key, card);
      const first = grid.children[0];
      const second = grid.children[1];
      first.querySelector("button").focus();
      const focused = document.activeElement;
      render([1, 2, 3], key, card);
      const appendPreserved = grid.children[0] === first && grid.children[1] === second && document.activeElement === focused;
      render([3, 2], key, card);
      const reordered = [...grid.children].map((node) => Number(node.dataset.id));
      const removed = !first.isConnected && grid.children[1] === second;
      render([], key, card, '<p>没有作品</p>');
      const empty = grid.textContent;
      render([4], key, card);
      return { appendPreserved, reordered, removed, empty, restored: grid.children.length === 1 && grid.children[0].dataset.id === "4" };
    });
    assert.deepEqual(result, { appendPreserved: true, reordered: [3, 2], removed: true, empty: "没有作品", restored: true });
  } finally {
    await page.close();
  }
}

async function openFixture(browser) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await page.goto(`${baseUrl}/fixture`, { waitUntil: "domcontentloaded" });
  await page.evaluate(() => {
    window.__managerRequests = [];
    window.fetch = (input, options = {}) => new Promise((resolve) => {
      window.__managerRequests.push({
        signal: options.signal || null,
        body: options.body || null,
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
    if (url.pathname === "/avatar.gif") {
      response.writeHead(200, { "content-type": "image/gif" });
      response.end(Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64"));
      return;
    }
    if (url.pathname === "/fixture") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      response.end(fixtureHtml());
      return;
    }
    if (url.pathname.startsWith("/manager/")) {
      const filePath = path.resolve(staticRoot, url.pathname.slice("/manager/".length));
      const safePath = filePath.startsWith(`${staticRoot}${path.sep}`) && fs.statSync(filePath, { throwIfNoEntry: false })?.isFile();
      if (safePath) {
        response.writeHead(200, { "content-type": filePath.endsWith(".css") ? "text/css; charset=utf-8" : "text/javascript; charset=utf-8", "cache-control": "no-store" });
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
  return `<!doctype html><html><head><link rel="stylesheet" href="/manager/styles/profiles.css"><link rel="stylesheet" href="/manager/styles/links.css"></head><body>
    <div id="toast"></div>
    <input id="profileManagerSearch"><select id="profileManagerScope"><option value="collected">collected</option><option value="all">all</option></select>
    <select id="profileManagerSort"><option value="latest_desc">latest</option><option value="works_desc">works</option></select>
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
