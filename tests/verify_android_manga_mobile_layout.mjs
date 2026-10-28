import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { chromium } from "playwright-core";

// Real launcher/index/app/modules/styles and browser navigation. All content
// and image responses come from the synthetic-only, run-scoped loopback server.
const root = path.resolve(import.meta.dirname, "..");
const executablePath = [process.env.CHROME_PATH, "C:/Program Files/Google/Chrome/Application/chrome.exe", "C:/Program Files/Microsoft/Edge/Application/msedge.exe"].filter(Boolean).find(file => fs.existsSync(file));
assert(executablePath, "Chrome or Edge required for the actual Android manga fixture");
const caseFilter = process.argv.find(value => value.startsWith("--case="))?.slice(7) || "";
const negative = ["description", "touch", "reader-width", "title-wrap", "panels-touch", "panels-wrap", "panels-focus", "panels-label", "panels-poll-focus",
  "recovery-form", "recovery-readonly", "recovery-alert", "recovery-submit-focus", "recovery-shell-retain", "recovery-final-retain"].find(key => process.argv.includes(`--legacy-${key}`));
const panelsOnly = process.argv.includes("--panels-only") || negative?.startsWith("panels-");
const recoveryOnly = Boolean(process.argv.includes("--recovery-only") || negative?.startsWith("recovery-"));
const sourceNegative = ["panels-focus", "panels-label", "panels-poll-focus"].includes(negative) || negative?.startsWith("recovery-");
const recoveryUrl = "https://manga-recovery.invalid/comic/synthetic-recovery";
const recoveryProfiles = ["immediate-failure", "delayed-failure", "retry-complete"];
const service = spawn(process.execPath, ["tests/serve_android_gallery_navigation_fixture.mjs"], { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
const serviceExit = new Promise(resolve => service.once("exit", resolve));
const faults = [], profiles = [], frozenRuns = [], network = new WeakMap();
const viewports = [{ width: 320, height: 568 }, { width: 390, height: 844 }, { width: 568, height: 320 }];
const frames = page => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
let browser, origin, checks = 0;
async function run(name, task) {
  if (caseFilter && !name.includes(caseFilter)) return;
  if (recoveryOnly !== name.startsWith("recovery:")) return;
  if (panelsOnly && !name.startsWith("panels:")) return;
  if (negative && !name.startsWith(negative.startsWith("recovery-") ? "recovery:" : negative.startsWith("panels-") ? "panels:" : negative === "reader-width" ? "reader:" : "details:")) return;
  await task(); checks++; console.log(`PASS ${name}`);
}

try {
  origin = await new Promise((resolve, reject) => {
    let output = "";
    const timer = setTimeout(() => reject(new Error("synthetic manga fixture startup timed out")), 15000);
    service.stdout.on("data", bytes => { output += bytes; const match = /http:\/\/127\.0\.0\.1:\d+/.exec(output); if (match) { clearTimeout(timer); resolve(match[0]); } });
    service.once("error", error => { clearTimeout(timer); reject(error); });
    service.once("exit", code => { clearTimeout(timer); reject(new Error(`fixture exited before startup (${code})`)); });
  });
  browser = await chromium.launch({ executablePath, headless: true });
  for (const viewport of viewports) {
    const profile = `${viewport.width}x${viewport.height}`;
    await run(`details: ${profile} long, short and fallback text remain readable with local-only expansion`, async () => {
      const page = await launch(viewport);
      let retiredToggle;
      try {
        for (let index = 0; index < 3; index++) {
          const title = await page.locator(".channel-card.manga strong").nth(index).textContent();
          await page.locator(".channel-card.manga").nth(index).click();
          await page.locator(".manga-detail-summary").waitFor();
          await page.waitForLoadState("networkidle"); await frames(page);
          const titleLayout = await visibleTail(page.locator(".manga-detail-body > strong"), `${profile} manga detail title`);
          assert.equal(await page.locator(".manga-detail-body > strong").textContent(), title);
          const description = page.locator(".manga-detail-description"), toggle = page.locator(".manga-detail-description-toggle");
          assert.equal(await page.locator(".manga-chapter-card").count(), 3);
          if (index === 0) {
            assert.equal(await toggle.count(), 1); assert.equal(await toggle.getAttribute("aria-expanded"), "false");
            const controlled = await toggle.getAttribute("aria-controls"); assert(controlled);
            assert.equal(await description.getAttribute("id"), controlled);
            assert.equal(await page.locator(`#${controlled}`).count(), 1, "description control names exactly one paragraph");
            const nodes = await Promise.all([".manga-detail-summary", ".manga-detail-body > strong", ".manga-detail-description", ".manga-chapter-list", ".manga-detail-description-toggle"].map(selector => page.locator(selector).elementHandle()));
            const before = await uiSnapshot(page), requests = network.get(page).length;
            await toggle.click(); await frames(page);
            assert.equal(await toggle.getAttribute("aria-expanded"), "true"); assert.equal(await toggle.textContent(), "收起简介");
            const descriptionLayout = await visibleTail(description, `${profile} expanded description`);
            assert.equal(await toggle.evaluate(node => document.activeElement === node), true, "expanding retains native button focus");
            await page.keyboard.press("Enter"); await frames(page);
            assert.equal(await toggle.getAttribute("aria-expanded"), "false"); assert.equal(await toggle.textContent(), "展开简介");
            assert.equal(await toggle.evaluate(node => document.activeElement === node), true, "collapsing retains native button focus");
            const collapsed = await description.evaluate(node => ({ height: node.getBoundingClientRect().height, lineHeight: parseFloat(getComputedStyle(node).lineHeight) }));
            assert(collapsed.height <= 4 * collapsed.lineHeight + 1, "long description returns to four visible lines");
            assert.deepEqual(await uiSnapshot(page), before, "description toggle preserves route, history and browser storage");
            assert.equal(network.get(page).length, requests, "description toggle performs no HTTP requests");
            for (const node of nodes) assert.equal(await node.evaluate(value => value.isConnected), true, "description toggle preserves the mounted nodes");
            retiredToggle = nodes.at(-1);
            profiles.push({ profile, case: "long", title: titleLayout, description: descriptionLayout });
          } else {
            assert.equal(await toggle.count(), 0, "short and fallback descriptions have no expansion control");
            assert.equal(await description.getAttribute("aria-expanded"), null);
            const descriptionLayout = await visibleTail(description, `${profile} ${index === 1 ? "short" : "fallback"} description`);
            if (index === 1) {
              const before = await uiSnapshot(page), requests = network.get(page).length;
              await retiredToggle.evaluate(node => node.click()); await frames(page);
              assert.equal(await retiredToggle.getAttribute("aria-expanded"), "false", "a retired description control cannot toggle its old panel");
              assert.deepEqual(await uiSnapshot(page), before); assert.equal(network.get(page).length, requests);
              assert.equal(await description.evaluate(node => node.classList.contains("is-collapsed")), false);
            } else assert.equal(await description.textContent(), "章节目录与下载状态以电脑端采集结果为准。");
            profiles.push({ profile, case: index === 1 ? "short" : "fallback", title: titleLayout, description: descriptionLayout });
          }
          await assertTargets(page, ".manga-detail-actions button, .manga-detail-actions a, .manga-chapter-open, .manga-chapter-card > a, .manga-detail-description-toggle", `${profile} detail`);
          await assertHorizontalBounds(page);
          assert.equal(await page.evaluate(() => window.fanhaoHandleNativeBack()), true);
          await page.locator(".channel-card.manga").first().waitFor(); assert.equal(await page.locator(".channel-card.manga").count(), 3);
        }
      } finally { await page.close(); }
    });
    await run(`reader: ${profile} full chapter heading, real next/catalog and saved-page resume stay usable`, async () => {
      const page = await launch(viewport);
      try {
        await page.locator(".channel-card.manga").first().click(); await page.locator(".manga-chapter-open").first().waitFor();
        const chapterTitle = await page.locator(".manga-chapter-open strong").first().textContent();
        await page.locator(".manga-chapter-open").first().click(); await waitReader(page, 1);
        const heading = await visibleTail(page.locator("h3.manga-reader-title"), `${profile} normal-flow chapter title`);
        assert.equal(await page.locator("h3.manga-reader-title").textContent(), chapterTitle);
        assert.equal(await page.locator(".manga-reader-page img").count(), 3);
        await assertHorizontalBounds(page, true);
        await assertTargets(page, ".manga-chapter-navigation button, .manga-chapter-navigation a", `${profile} reader`);
        const topNav = page.getByRole("navigation", { name: "章节导航", exact: true });
        assert.equal(await topNav.getByRole("button", { name: "上一话", exact: true }).isEnabled(), false);
        await topNav.getByRole("button", { name: /^下一话：/ }).click(); await waitReader(page, 2);
        await assertHorizontalBounds(page, true);
        await topNav.getByRole("button", { name: "返回章节目录", exact: true }).click();
        await page.locator(".manga-chapter-open").first().waitFor(); assert.equal(await page.locator(".manga-chapter-open").count(), 3);
        await page.locator(".manga-chapter-open").first().click(); await waitReader(page, 1);
        await scrollToSecondPage(page, viewport);
        assert.equal(await page.evaluate(() => window.fanhaoHandleNativeBack()), true);
        const continuation = page.locator(".manga-continue"); await continuation.waitFor();
        assert.match(await continuation.textContent(), /继续第 1 话 · 第 2 张/);
        await assertTargets(page, ".manga-continue", `${profile} saved-page continuation`);
        await continuation.click(); await waitReader(page, 1);
        await page.waitForFunction(() => document.querySelector("[data-manga-progress-current]")?.textContent === "第 2 / 3 张");
        const restored = await page.locator(".manga-reader-page").nth(1).boundingBox();
        assert(restored.y >= -1 && restored.y < viewport.height / 2, `continued page is restored in the viewport: ${JSON.stringify(restored)}`);
        assert.equal(await page.evaluate(() => window.fanhaoHandleNativeBack()), true); await page.locator(".manga-chapter-open").first().waitFor();
        await page.locator(".manga-chapter-open").first().click(); await waitReader(page, 1);
        const resume = page.locator(".manga-reader-resume"); await resume.waitFor(); await assertTargets(page, ".manga-reader-resume", `${profile} reader resume`);
        await resume.click();
        await page.waitForFunction(() => document.querySelector("[data-manga-progress-current]")?.textContent === "第 2 / 3 张");
        await assertHorizontalBounds(page, true); profiles.push({ profile, case: "reader", heading, resumedPage: 2 });
      } finally { await page.close(); }
    });
    await run(`panels: ${profile} accessible add controls, full task text and poll focus stay usable without writes`, async () => {
      const page = await launch(viewport, "manga-panels");
      try {
        await page.locator('[data-manga-task-id="fixture-manga-panels-running"]').waitFor();
        await page.waitForLoadState("networkidle"); await frames(page);
        const before = await uiSnapshot(page);
        const add = page.locator("[data-manga-add-toggle]");
        assert.equal(await add.getAttribute("aria-expanded"), "false");
        await add.click(); await frames(page);
        const input = page.locator(".manga-add-form input");
        assert.equal(await page.getByRole("textbox", { name: "漫画作品链接", exact: true }).count(), 1, "add URL input has an explicit accessible name");
        assert.equal(await input.evaluate(node => document.activeElement === node), true, "opening the add form focuses its new input");
        const formId = await add.getAttribute("aria-controls"); assert(formId);
        assert.equal(await input.locator("..").getAttribute("id"), formId); assert.equal(await page.locator(`#${formId}`).count(), 1);
        assert.equal(await add.getAttribute("aria-expanded"), "true");
        const draft = "https://manga-fixture.invalid/comic/layout-only.html";
        await input.fill(draft); await add.click(); await frames(page);
        assert.equal(await add.getAttribute("aria-expanded"), "false"); assert.equal(await input.count(), 0);
        assert.equal(await add.evaluate(node => document.activeElement === node), true, "closing the add form focuses its replacement trigger");
        await add.click(); await frames(page); assert.equal(await input.inputValue(), draft);
        assert.equal(await input.evaluate(node => document.activeElement === node), true);
        const history = page.locator(".manga-task-history-toggle");
        await history.click();
        await page.waitForFunction(() => document.querySelectorAll(".manga-task-card").length === 3);
        await page.waitForLoadState("networkidle"); await frames(page);
        assert.equal(await history.getAttribute("aria-expanded"), "true");
        assert.equal(await page.locator(".manga-task-card").count(), 3, "history renders all three distinct logical comic jobs");
        const textLayouts = [];
        for (const status of ["running", "failed", "complete"]) {
          const card = page.locator(`.manga-task-card.is-${status}`); assert.equal(await card.count(), 1);
          const title = await visibleTail(card.locator(".manga-task-card-head > div > strong"), `${profile} ${status} task title`);
          const message = await visibleTail(card.locator(".manga-job-progress-head > strong"), `${profile} ${status} task message`);
          const chapter = await visibleTail(card.locator(".manga-job-current"), `${profile} ${status} current chapter`);
          assert.equal(await card.getByRole("progressbar").getAttribute("aria-valuenow"), { running: "16", failed: "44", complete: "100" }[status]);
          textLayouts.push({ status, title, message, chapter });
        }
        await assertTargets(page, ".manga-library-actions button, .manga-add-form input, .manga-task-manager button", `${profile} panels`);
        await assertHorizontalBounds(page);
        const taskAction = page.locator('[data-manga-task-id="fixture-manga-panels-running"]').getByRole("button", { name: "书页", exact: true });
        const oldTaskAction = await taskAction.elementHandle(); await taskAction.focus();
        await observePoll(page);
        assert.equal(await oldTaskAction.evaluate(node => node.isConnected), false, "a real successful poll replaces the old task manager");
        assert.equal(await taskAction.evaluate(node => document.activeElement === node), true, "poll hands focus to the same job/action in the replacement manager");
        const inputNode = await input.elementHandle(); await input.click(); await observePoll(page);
        assert.equal(await inputNode.evaluate(node => node.isConnected && document.activeElement === node), true, "task polling preserves the user's newer input focus");
        assert.equal(await input.inputValue(), draft);
        await history.click(); await frames(page);
        assert.equal(await history.getAttribute("aria-expanded"), "false");
        assert.equal(await history.evaluate(node => document.activeElement === node), true);
        assert.equal(await page.locator(".manga-task-card").count(), 2, "collapsed history keeps only running and failed attention records");
        assert.deepEqual(await uiSnapshot(page), before, "read-only form/history interactions preserve route, history and browser storage");
        profiles.push({ profile, case: "panels", taskCount: 3, textLayouts, sameActionFocusAfterPoll: true, newerInputFocusPreserved: true });
      } finally { await page.close(); }
    });
    for (const recoveryProfile of recoveryProfiles) await run(`recovery: ${profile} ${recoveryProfile} preserves real form ownership through synthetic receipts`, async () => {
      await verifyRecovery(viewport, recoveryProfile);
    });
  }
  assert(checks > 0); assert.deepEqual(faults, []);
  console.log(JSON.stringify({ result: "PASS", scenarios: checks, profiles, frozenRuns,
    boundary: "Actual Chromium full shell, run-isolated synthetic GET DTOs and geometry SVGs; no production service, archive download or native device claim" }, null, 2));
} finally {
  await browser?.close(); service.kill("SIGTERM"); await Promise.race([serviceExit, new Promise(resolve => setTimeout(resolve, 3000))]);
}

async function launch(viewport, scenario = "manga-layout", profile = "") {
  const page = await browser.newPage({ viewport }); network.set(page, []);
  page.on("pageerror", error => faults.push(error.message));
  page.on("request", request => network.get(page).push({ method: request.method(), url: request.url() }));
  await page.route("**/*", async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin !== origin && !["data:", "blob:"].includes(url.protocol)) { faults.push(`external ${url.origin}${url.pathname}`); return route.abort(); }
    const exactRecoveryPost = scenario === "manga-recovery" && recoveryProfiles.includes(profile) && request.method() === "POST"
      && url.pathname === "/api/manga/add" && !url.search && request.postData() === JSON.stringify({ url: recoveryUrl });
    if (!["GET", "HEAD"].includes(request.method()) && url.pathname !== "/fixture/new-run" && !exactRecoveryPost) { faults.push(`unexpected write ${request.method()} ${url.pathname}`); return route.abort(); }
    if (/^\/media\//.test(url.pathname) || /\/download$/.test(url.pathname)) { faults.push(`unexpected media/download ${url.pathname}`); return route.abort(); }
    await route.continue();
  });
  if (negative && !sourceNegative) await page.route(url => url.pathname.endsWith("/modules/photos/styles.css"), async route => {
    const response = await route.fetch(); let body = (await response.text()).replaceAll("\r\n", "\n");
    const rules = {
      description: '.content-panel[data-view="mangaDetail"] .manga-detail-description {\n  display: block;\n  overflow: visible;\n  overflow-wrap: anywhere;\n  -webkit-line-clamp: unset;\n  -webkit-box-orient: initial;\n}',
      touch: '.content-panel[data-view="mangaDetail"] .manga-detail-actions button,\n.content-panel[data-view="mangaDetail"] .manga-detail-actions a,\n.content-panel[data-view="mangaDetail"] .manga-chapter-card > a,\n.content-panel[data-view="mangaChapter"] .manga-chapter-navigation button,\n.content-panel[data-view="mangaChapter"] .manga-chapter-navigation a,\n.content-panel[data-view="mangaChapter"] .manga-reader-resume {\n  min-height: 44px;\n}',
      "title-wrap": '.content-panel[data-view="mangaDetail"] .manga-detail-body > strong {\n  overflow: visible;\n  overflow-wrap: anywhere;\n}',
      "reader-width": '@media (max-width: 390px) {\n  .content-panel[data-view="mangaChapter"] {\n    width: calc(100% + 24px);\n    margin-inline: -12px;\n  }\n}',
      "panels-touch": '.content-panel[data-channel-mode="manga"] .manga-library-actions button,\n.content-panel[data-channel-mode="manga"] .manga-add-form input,\n.content-panel[data-channel-mode="manga"] .manga-task-manager button,\n.content-panel .manga-cache-notice button {\n  min-width: 44px;\n  min-height: 44px;\n}'
    };
    if (negative === "panels-wrap") {
      const prefix = '.content-panel:is([data-channel-mode="manga"], [data-view="mangaDetail"])';
      const marker = [
        `${prefix} :is(.manga-task-manager, .manga-task-list, .manga-task-card, .manga-job-progress) {\n  min-width: 0;\n  max-width: 100%;\n  grid-template-columns: minmax(0, 1fr);\n}`,
        `${prefix} :is(.manga-task-manager-head, .manga-task-card-head, .manga-job-progress-head) {\n  min-width: 0;\n  max-width: 100%;\n  align-items: flex-start;\n}`,
        `${prefix} :is(.manga-task-manager-head, .manga-task-card-head) > div:first-child,\n${prefix} .manga-job-progress-head > strong {\n  flex: 1 1 0;\n  min-width: 0;\n}`,
        `${prefix} :is(.manga-task-manager-head strong, .manga-task-manager-head span, .manga-task-card-head strong, .manga-task-card-head span, .manga-job-progress-head strong, .manga-job-current, .manga-operation-error, .manga-job-progress-meta > span, .manga-task-notice strong, .manga-task-notice small) {\n  min-width: 0;\n  max-width: 100%;\n  overflow: visible;\n  overflow-wrap: anywhere;\n  text-overflow: clip;\n  white-space: normal;\n}`,
        `${prefix} .manga-job-progress-head > span {\n  flex: 0 0 auto;\n  white-space: nowrap;\n}`
      ].join("\n\n");
      assert.equal(body.split(marker).length, 2, "task text negative removes the exact actual scoped wrap block");
      body = body.replace(marker, "/* task text wrapping omitted */");
    } else {
      const marker = rules[negative]; assert(marker); assert.equal(body.split(marker).length, 2, `negative removes one actual ${negative} product rule`);
      body = body.replace(marker, `/* ${negative} layout rule omitted */`);
    }
    await route.fulfill({ response, body });
  });
  if (sourceNegative) await page.route(url => url.pathname.endsWith("/platform/content-index/channel-views.js"), async route => {
    const response = await route.fetch(); let body = await response.text();
    if (negative === "recovery-readonly") {
      const marker = "    input.readOnly = mangaJobRunning(mangaAddJob);";
      assert.equal(body.split(marker).length, 3, "pending negative replaces both actual readonly assignments");
      body = body.replaceAll(marker, "    input.disabled = mangaJobRunning(mangaAddJob);");
    } else {
      const changes = {
        "panels-focus": ["      target?.focus({ preventScroll: true });", "/* add-toggle focus omitted */"],
        "panels-label": ['    input.setAttribute("aria-label", "漫画作品链接");', "/* URL accessible name omitted */"],
        "panels-poll-focus": ["      if (target?.isConnected && !target.disabled && els.viewContent.contains(target)) target.focus({ preventScroll: true });", "/* task poll focus omitted */"],
        "recovery-form": ["    if (view.open === mangaAddOpen) {", "    if (false && view.open === mangaAddOpen) {"],
        "recovery-alert": ['        view.error.setAttribute("role", "alert");', "/* error alert role omitted */"],
        "recovery-submit-focus": ["      input.focus({ preventScroll: true });", "/* explicit submit input focus omitted */"],
        "recovery-final-retain": ['    const retainedActions = mode === "manga" && retainMangaLibraryActions();', '    const retainedActions = mode === "manga" && Boolean(cacheEntry) && retainMangaLibraryActions();'],
        "recovery-shell-retain": ["      await renderCurrentViewPreservingScroll({ preserveMangaLibraryActions });", "      await renderCurrentViewPreservingScroll({ preserveMangaLibraryActions: false });"]
      };
      const [marker, replacement] = changes[negative];
      assert.equal(body.split(marker).length, 2, `negative changes one actual ${negative} product hook`); body = body.replace(marker, replacement);
    }
    await route.fulfill({ response, body });
  });
  const launcherLabel = scenario === "manga-recovery" ? { "immediate-failure": "漫画采集失败恢复（立即失败）", "delayed-failure": "漫画采集失败恢复（延迟失败）", "retry-complete": "漫画采集失败恢复（失败后重试完成）" }[profile]
    : scenario === "manga-panels" ? "漫画添加与下载记录面板（长任务信息）" : "漫画详情与阅读布局（长简介与章节）";
  await page.goto(origin); await page.getByRole("button", { name: launcherLabel, exact: true }).click();
  await page.waitForURL(url => url.pathname.startsWith("/run/"));
  const runId = new URL(page.url()).pathname.split("/")[2];
  const frozen = (await (await page.request.get(`${origin}/fixture/requests?run=${runId}`)).json()).runs[0];
  frozenRuns.push({ runId, scenario: frozen.scenario, ...(frozen.profile ? { profile: frozen.profile } : {}), files: frozen.files.filter(file => ["app.js", "modules/photos/styles.css", "platform/content-index/channel-views.js"].includes(file.name)).map(file => ({ name: file.name, sha256: file.servedSha256 })) });
  await page.locator(".channel-card.manga").first().waitFor(); await frames(page); return page;
}
async function uiSnapshot(page) {
  return page.evaluate(() => {
    const storage = value => Object.fromEntries(Array.from({ length: value.length }, (_, index) => value.key(index)).sort().map(key => [key, value.getItem(key)]));
    return { url: location.href, history: history.length, local: storage(localStorage), session: storage(sessionStorage) };
  });
}
async function visibleTail(locator, label) {
  const geometry = await locator.evaluate(node => {
    const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT), texts = [];
    while (walker.nextNode()) if (walker.currentNode.textContent) texts.push(walker.currentNode);
    const last = texts.at(-1), range = document.createRange(); range.setStart(last, Math.max(0, last.textContent.length - 12)); range.setEnd(last, last.textContent.length);
    return { text: node.textContent, box: node.getBoundingClientRect().toJSON(), tails: [...range.getClientRects()].map(rect => rect.toJSON()),
      width: node.clientWidth, scrollWidth: node.scrollWidth, viewport: document.documentElement.clientWidth };
  });
  assert(geometry.tails.length > 0, `${label}: trailing text has real layout`);
  for (const tail of geometry.tails) assert(tail.left >= geometry.box.left - 1 && tail.right <= geometry.box.right + 1
    && tail.top >= geometry.box.top - 1 && tail.bottom <= geometry.box.bottom + 1 && tail.left >= -1 && tail.right <= geometry.viewport + 1,
  `${label}: trailing text fits its visible box and viewport: ${JSON.stringify(geometry)}`);
  assert(geometry.scrollWidth <= geometry.width + 1, `${label}: no internal horizontal overflow: ${JSON.stringify(geometry)}`);
  return { length: geometry.text.length, height: geometry.box.height };
}
async function assertTargets(page, selector, label) {
  const controls = await page.locator(selector).evaluateAll(nodes => nodes.filter(node => node.getClientRects().length).map(node => ({ text: node.textContent.trim(), width: node.getBoundingClientRect().width, height: node.getBoundingClientRect().height })));
  assert(controls.length > 0);
  for (const control of controls) assert(control.width >= 44 && control.height >= 44, `${label}: 44px target: ${JSON.stringify(control)}`);
}
async function assertHorizontalBounds(page, reader = false) {
  const geometry = await page.evaluate(() => ({ client: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth,
    bodyScroll: document.body.scrollWidth, panel: document.querySelector("#contentPanel").getBoundingClientRect().toJSON() }));
  assert(geometry.scroll <= geometry.client + 1 && geometry.bodyScroll <= geometry.client + 1, `page has no horizontal overflow: ${JSON.stringify(geometry)}`);
  if (reader) assert(geometry.panel.left >= -1 && geometry.panel.right <= geometry.client + 1, `reader panel fits the document: ${JSON.stringify(geometry)}`);
}
async function waitReader(page, index) {
  await page.waitForURL(url => new URLSearchParams(url.hash.split("?")[1]).get("chapterIndex") === String(index));
  await page.locator("h3.manga-reader-title").waitFor();
  await page.waitForFunction(() => { const image = document.querySelector(".manga-reader-page img"); return image?.complete && image.naturalWidth === 720 && image.naturalHeight === 1080; });
  await frames(page);
}
async function scrollToSecondPage(page, viewport) {
  const box = await page.locator(".manga-reader-page").nth(1).boundingBox();
  await page.mouse.move(viewport.width / 2, viewport.height / 2);
  await page.mouse.wheel(0, box.y + box.height / 2 - viewport.height * .44);
  await page.waitForFunction(() => document.querySelector("[data-manga-progress-current]")?.textContent === "第 2 / 3 张");
}
async function observePoll(page) {
  const response = await page.waitForResponse(value => new URL(value.url()).pathname === "/api/manga/jobs" && value.request().method() === "GET");
  assert.equal(response.status(), 200); await response.finished(); await frames(page);
}
async function recoveryResponse(page) {
  const response = await page.waitForResponse(value => new URL(value.url()).pathname === "/api/manga/add" && value.request().method() === "POST");
  const payload = await response.json(); await frames(page); return { status: response.status(), payload };
}
async function assertSameNode(handle, selector, label) {
  assert.equal(await handle.evaluate((node, selector) => node.isConnected && document.querySelector(selector) === node, selector), true, label);
}
async function verifyRecovery(viewport, profile) {
  const page = await launch(viewport, "manga-recovery", profile);
  let releaseRefresh = () => {};
  try {
    await page.waitForLoadState("networkidle");
    const before = await uiSnapshot(page), postCount = () => network.get(page).filter(request => request.method === "POST" && new URL(request.url).pathname === "/api/manga/add").length;
    await page.locator("[data-manga-add-toggle]").click();
    const input = page.getByRole("textbox", { name: "漫画作品链接", exact: true }), form = page.locator(".manga-add-form"), submit = form.locator('button[type="submit"]');
    await input.fill(recoveryUrl); await input.press("ArrowLeft"); await input.press("ArrowLeft");
    const selection = await input.evaluate(node => ({ start: node.selectionStart, end: node.selectionEnd }));
    assert.equal(selection.start, recoveryUrl.length - 2, "native URL caret is positioned before submission"); assert.equal(selection.end, selection.start);
    const inputNode = await input.elementHandle(), formNode = await form.elementHandle(), submitNode = await submit.elementHandle();
    const firstResponse = recoveryResponse(page);
    void firstResponse.catch(() => {}); // Negative controls may close a still-pending synthetic response.
    await submit.click();
    let outside;
    if (profile === "delayed-failure") {
      await frames(page);
      await assertSameNode(inputNode, ".manga-add-form input", "pending request keeps the exact URL input mounted");
      assert.deepEqual(await input.evaluate(node => ({ readonly: node.readOnly, disabled: node.disabled, focused: document.activeElement === node })),
        { readonly: true, disabled: false, focused: true }, "pending URL is readonly and focusable while submit is disabled");
      assert.equal(await submit.isDisabled(), true);
      await input.press("Enter"); await frames(page); assert.equal(postCount(), 1, "pending native Enter cannot dispatch duplicate add requests");
      await page.keyboard.press("Tab"); outside = await page.locator(":focus").elementHandle();
      assert(outside && await outside.evaluate(node => node.tagName !== "BODY" && !node.closest(".manga-add-form")), "native Tab moves focus outside the pending form");
    }
    const failed = await firstResponse;
    assert.equal(failed.status, 503); assert.equal(Object.hasOwn(failed.payload, "job"), false);
    await assertSameNode(formNode, ".manga-add-form", "HTTP failure patches the same mounted form");
    await assertSameNode(inputNode, ".manga-add-form input", "HTTP failure keeps the exact URL input");
    await assertSameNode(submitNode, '.manga-add-form button[type="submit"]', "HTTP failure keeps the exact submit control");
    assert.equal(await input.inputValue(), recoveryUrl); assert.equal(await input.evaluate(node => node.readOnly || node.disabled), false);
    assert.deepEqual(await input.evaluate(node => ({ start: node.selectionStart, end: node.selectionEnd })), selection, "pending/failure patches preserve native URL caret position");
    if (outside) assert.equal(await outside.evaluate(node => node.isConnected && document.activeElement === node), true, "late HTTP failure cannot steal the user's newer outside focus");
    else assert.equal(await input.evaluate(node => document.activeElement === node), true, "submitted failure keeps focus on its same URL input");
    const error = page.locator(".manga-library-actions .manga-operation-error");
    await error.waitFor(); assert.equal(await error.getAttribute("role"), "alert", "HTTP failure has alert semantics");
    const errorId = await error.getAttribute("id"); assert(errorId, "failure alert has an ID");
    assert((await input.getAttribute("aria-describedby") || "").split(/\s+/).includes(errorId), "URL input references its failure alert");
    assert([null, "false"].includes(await input.getAttribute("aria-invalid")), "HTTP 503 does not mark a valid URL invalid");
    await visibleTail(error, `${viewport.width}x${viewport.height} recovery alert`);
    assert.equal(await submit.textContent(), "重新采集"); assert.equal(await submit.isEnabled(), true);
    assert.equal(await page.locator(".manga-task-card").count(), 0, "a rejected start never creates an accepted task card");
    const readHeaders = { Referer: page.url() };
    assert.equal((await (await page.request.get(`${origin}/api/manga/jobs`, { headers: readHeaders })).json()).jobs.length, 0);
    await assertTargets(page, ".manga-library-actions button, .manga-add-form input", `${viewport.width}x${viewport.height} recovery`);
    await assertHorizontalBounds(page);
    assert.deepEqual(await uiSnapshot(page), before, "failed synthetic start preserves route, history and browser storage");
    await input.fill(recoveryUrl);
    assert.equal(await error.count(), 0, "editing clears the old alert"); assert.equal(await input.getAttribute("aria-describedby"), null, "editing clears the stale alert association");
    if (profile === "retry-complete") {
      let markRefresh, refreshedTitle; const refreshStarted = new Promise(resolve => { markRefresh = resolve; });
      const refreshGate = new Promise(resolve => { releaseRefresh = resolve; });
      await page.route(url => url.origin === origin && url.pathname === "/api/image-library/items" && url.searchParams.get("mode") === "manga", async route => {
        const response = await route.fetch(), data = await response.json(); assert.equal(data.items.length, 3);
        // A fresh synthetic catalogue keeps the same three known IDs/images.
        // Changed title/order proves that the final accepted response renders,
        // rather than taking the identical-cache signature shortcut.
        const completedItem = { ...data.items[2], title: `${data.items[2].title}（合成回执已刷新）`, updatedAt: "2026-08-31T00:00:02.000Z" };
        refreshedTitle = completedItem.title;
        const freshData = { ...data, items: [completedItem, ...data.items.slice(0, 2)] };
        markRefresh(); await refreshGate; await route.fulfill({ response, body: JSON.stringify(freshData) });
      });
      const secondResponse = recoveryResponse(page);
      await submit.click(); const completed = await secondResponse; assert.equal(completed.status, 202); assert.equal(completed.payload.job.status, "complete");
      await refreshStarted;
      await page.waitForFunction(() => !document.querySelector(".manga-add-form"));
      const closedPanel = await page.locator(".manga-library-actions").elementHandle(), closedToggle = await page.locator("[data-manga-add-toggle]").elementHandle();
      const cachedCard = await page.locator(".channel-card.manga").first().elementHandle();
      const cachedList = await page.locator(".channel-list.manga-list").elementHandle();
      const completionFocus = await closedToggle.evaluate(node => ({ focused: document.activeElement === node, connected: node.isConnected,
        activeTag: document.activeElement.tagName, activeClass: document.activeElement.className, activeText: document.activeElement.textContent.slice(0, 80),
        view: document.querySelector("#contentPanel").dataset.view, mode: document.querySelector("#contentPanel").dataset.channelMode,
        markup: document.querySelector(".manga-library-actions")?.outerHTML.slice(0, 300) }));
      assert.equal(completionFocus.focused, true, `completion initially focuses its closed add trigger: ${JSON.stringify(completionFocus)}`);
      const finishedRefresh = page.waitForResponse(value => new URL(value.url()).pathname === "/api/image-library/items" && new URL(value.url()).searchParams.get("mode") === "manga");
      releaseRefresh(); const fresh = await finishedRefresh; await fresh.finished(); await page.waitForLoadState("networkidle"); await frames(page);
      assert.equal(await page.locator(".channel-card.manga strong").first().textContent(), refreshedTitle, "the accepted fresh catalogue title and ordering are actually rendered");
      assert.equal(await cachedCard.evaluate(node => node.isConnected), false, "the prior cached card is retired by the final accepted render");
      assert.equal(await cachedList.evaluate(node => node.isConnected), false, "the final accepted response rebuilds the real catalogue list");
      await assertSameNode(closedPanel, ".manga-library-actions", "final accepted library render preserves the closed add panel");
      await assertSameNode(closedToggle, "[data-manga-add-toggle]", "final accepted library render preserves the focused add trigger");
      assert.equal(await closedToggle.evaluate(node => document.activeElement === node), true, "focus survives the actual final library GET and render");
      assert.equal(await page.locator(".manga-add-form").count(), 0); assert.equal(await error.count(), 0);
      assert.equal(await page.locator(".channel-card.manga").count(), 3);
      await page.locator(".manga-task-history-toggle").click(); await page.locator(".manga-task-card.is-complete").waitFor();
      const jobs = (await (await page.request.get(`${origin}/api/manga/jobs`, { headers: readHeaders })).json()).jobs;
      assert.equal(jobs.length, 1); assert.equal(jobs[0].id, completed.payload.job.id); assert.equal(jobs[0].progressPercent, 100);
      assert.equal(postCount(), 2); await assertHorizontalBounds(page);
    } else if (profile === "immediate-failure") {
      const again = recoveryResponse(page); await submit.click(); assert.equal((await again).status, 503);
      await assertSameNode(inputNode, ".manga-add-form input", "another failure still keeps the same input");
      assert.equal(await input.inputValue(), recoveryUrl); assert.equal(await page.locator(".manga-task-card").count(), 0); assert.equal(postCount(), 2);
    } else assert.equal(postCount(), 1);
    profiles.push({ profile: `${viewport.width}x${viewport.height}`, case: "recovery", recoveryProfile: profile, syntheticAddPosts: postCount(), nativeCaret: selection, preservedFailureForm: true, acceptedJobOnlyAfterRetry: profile === "retry-complete" });
  } finally { releaseRefresh(); await page.close(); }
}
