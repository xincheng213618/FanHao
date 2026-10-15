import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { createFileWorkflowService } from "../src/modules/fanhao/server/workflows/file-workflow-service.js";
import { routeFileWorkflows } from "../src/modules/fanhao/server/workflows/routes.js";
import { createStaticFileServer } from "../src/platform/server/static-files.js";
import { readJsonBody } from "../src/platform/server/request-io.js";
import { sendJson, notFound } from "../src/platform/server/responses.js";
import { createVerifiedTempDir } from "./verified-temp-cleanup.mjs";

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const temporary = createVerifiedTempDir("fanhao-workflows-ui-");
const source = path.join(temporary.tempDir, "incoming"), target = path.join(temporary.tempDir, "library");
fs.mkdirSync(source); fs.mkdirSync(target);
fs.writeFileSync(path.join(source, "ABC-123-U.mp4"), "synthetic-media-fixture");
fs.writeFileSync(path.join(source, "DEF-456.mp4"), "indexed-fixture");
fs.writeFileSync(path.join(source, "notes.txt"), "notes-fixture");
const service = createFileWorkflowService({ dataDir: path.join(temporary.tempDir, "state"), roots: [source, target], indexedPaths: () => [path.join(source, "DEF-456.mp4")] });
const staticFiles = createStaticFileServer({ publicDir: path.join(repository, "public"),
  mimeTypes: { ".html": "text/html; charset=utf-8", ".css": "text/css", ".js": "text/javascript", ".svg": "image/svg+xml" },
  normalizeExt: (file) => path.extname(file), notFound });
const prefix = "/api/fanhao/file-workflows";
const jobA = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", jobB = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
let scenario = null;
const server = http.createServer(async (req, res) => {
  const current = scenario;
  try {
    const url = new URL(req.url, "http://fixture");
    if (current && url.pathname.startsWith(prefix)) {
      const key = `${req.method} ${url.pathname}`;
      assert(current.allowed.has(key), `Unexpected synthetic request: ${key}`);
      current.requests.push(key);
      const gate = current.gates.find((item) => item.key === key && !item.started);
      if (gate) {
        gate.started = true; gate.response = res; gate.requested.resolve();
        await gate.release.promise;
        if (gate.error) { sendJson(res, 503, { error: gate.error }); return; }
      }
    }
    if (await routeFileWorkflows(req, res, url, { service: current?.service || service, requireLocalAdmin: () => true, readJsonBody, sendJson })) return;
    await staticFiles.serveStatic(req, res, url.pathname);
  } catch (error) { current?.errors.push(error.message); sendJson(res, 500, { error: error.message }); }
});
function syntheticScenario() {
  const makeJob = (id, status) => ({ id, status, kind: "organize", source: `/synthetic/${id}`, target: "/synthetic/target", totalFiles: 1, totalBytes: 20, skippedFiles: 0, completedFiles: 0,
    items: [{ source: `/synthetic/${id}.mp4`, target: `/synthetic/target/${id}.mp4`, bytes: 20, phase: "planned" }] });
  const jobs = new Map([[jobA, makeJob(jobA, "running")], [jobB, makeJob(jobB, "preview")]]);
  const current = {
    requests: [], errors: [], gates: [],
    allowed: new Set([`GET ${prefix}`, `GET ${prefix}/config`, `GET ${prefix}/${jobA}`, `GET ${prefix}/${jobB}`, `POST ${prefix}/${jobA}/stop`]),
    service: {
      config: () => ({ roots: ["/synthetic/source", "/synthetic/target"] }),
      list: () => [...jobs.values()], detail: (id) => jobs.get(id),
      stop: (id) => { const job = { ...jobs.get(id), status: "stopping" }; jobs.set(id, job); return job; },
      preview: () => jobs.get(jobB),
      run: (id) => { const job = { ...jobs.get(id), status: "running" }; jobs.set(id, job); return job; },
    },
    gate(key, error = "") {
      const gate = { key, error, requested: Promise.withResolvers(), release: Promise.withResolvers(), started: false };
      this.gates.push(gate); return gate;
    },
    count(key) { return this.requests.filter((item) => item === key).length; },
  };
  return current;
}
async function waitRequested(gate) {
  await Promise.race([gate.requested.promise, new Promise((_, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Request did not start: ${gate.key}`)), 5000);
    gate.requested.promise.finally(() => clearTimeout(timeout));
  })]);
}
async function settle(page, key, count = 1) {
  await page.waitForFunction(({ key, count }) => window.__workflowSettled.filter((item) => item === key).length >= count, { key, count });
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}
async function snapshot(page) {
  return page.evaluate(() => Object.fromEntries(["statusBadge", "notice", "files", "progressText", "execute", "stop", "preview"].map((id) => {
    const element = document.getElementById(id); return [id, [element.textContent, element.disabled, element.className]];
  })));
}
async function selectJob(page, index) {
  await page.locator(".history-item").nth(index).click();
  await settle(page, `GET ${prefix}/${index ? jobB : jobA}`);
}
async function holdPoll(page) {
  await page.evaluate(() => { window.__savedWorkflowPoll = [...window.__workflowTimers.values()][0]; });
  assert.equal(await page.evaluate(() => typeof window.__savedWorkflowPoll), "function", "active job must schedule a poll");
}
async function fireSavedPoll(page) { await page.evaluate(() => window.__savedWorkflowPoll()); }
async function verifyOwnership(browser, baseUrl) {
  const cases = [];
  for (const retry of [false, true]) cases.push([`${retry ? "retry" : "poll"} callback cannot reclaim a newer selection`, async (page, current) => {
    await selectJob(page, 0);
    if (retry) {
      const failure = current.gate(`GET ${prefix}/${jobA}`, "poll failed"); failure.release.resolve();
      await holdPoll(page); await fireSavedPoll(page); await settle(page, `GET ${prefix}/${jobA}`, 2);
      assert.equal(await page.locator("#notice").textContent(), "poll failed");
    }
    await holdPoll(page);
    const before = current.count(`GET ${prefix}/${jobA}`), next = current.gate(`GET ${prefix}/${jobB}`);
    await page.locator(".history-item").nth(1).click(); await waitRequested(next);
    const timers = await page.evaluate(() => window.__workflowTimers.size);
    await fireSavedPoll(page); next.release.resolve(); await settle(page, `GET ${prefix}/${jobB}`);
    assert.equal(current.count(`GET ${prefix}/${jobA}`), before, "dispatched old timer must not request or render A");
    assert.equal(timers, 0, "selecting B cancels A's queued timer");
    assert((await page.locator("#files").textContent()).includes(jobB));
    assert.equal(await page.locator("#stop").isDisabled(), true);
  }]);
  for (const pending of [false, true]) for (const fail of [false, true]) cases.push([`late stop ${fail ? "failure" : "success"} preserves ${pending ? "pending" : "loaded"} B`, async (page, current) => {
    await selectJob(page, 0);
    const stop = current.gate(`POST ${prefix}/${jobA}/stop`, fail ? "stop failed" : "");
    await page.locator("#stop").click(); await waitRequested(stop);
    const next = pending ? current.gate(`GET ${prefix}/${jobB}`) : null;
    await page.locator(".history-item").nth(1).click();
    if (next) await waitRequested(next); else await settle(page, `GET ${prefix}/${jobB}`);
    const before = await snapshot(page);
    assert.equal(stop.response.destroyed, false, "navigation must not cancel the stop write");
    stop.release.resolve(); await settle(page, `POST ${prefix}/${jobA}/stop`);
    assert.deepEqual(await snapshot(page), before, "old stop must not replace the selection or its notice");
    if (next) { next.release.resolve(); await settle(page, `GET ${prefix}/${jobB}`); }
    assert((await page.locator("#files").textContent()).includes(jobB));
    assert.equal(current.count(`POST ${prefix}/${jobA}/stop`), 1, "stop must not retry");
  }]);
  for (const fail of [false, true]) cases.push([`pagehide ignores stop ${fail ? "failure" : "success"} and dispatched poll`, async (page, current) => {
    await selectJob(page, 0); await holdPoll(page);
    const stop = current.gate(`POST ${prefix}/${jobA}/stop`, fail ? "stop failed" : "");
    await page.locator("#stop").click(); await waitRequested(stop);
    await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent("pagehide")));
    const before = await snapshot(page), reads = current.count(`GET ${prefix}/${jobA}`);
    await fireSavedPoll(page);
    assert.equal(stop.response.destroyed, false, "pagehide must not cancel the stop write");
    stop.release.resolve(); await settle(page, `POST ${prefix}/${jobA}/stop`);
    assert.deepEqual(await snapshot(page), before);
    assert.equal(current.count(`GET ${prefix}/${jobA}`), reads);
    assert.equal(await page.evaluate(() => window.__workflowTimers.size), 0);
    assert.equal(current.count(`POST ${prefix}/${jobA}/stop`), 1);
  }]);
  for (const fail of [false, true]) cases.push([`current stop ${fail ? "failure" : "success"} remains visible`, async (page, current) => {
    await selectJob(page, 0);
    const stop = current.gate(`POST ${prefix}/${jobA}/stop`, fail ? "stop failed" : "");
    await page.locator("#stop").click(); await waitRequested(stop); stop.release.resolve();
    await settle(page, `POST ${prefix}/${jobA}/stop`);
    assert.equal(await page.locator("#statusBadge").textContent(), fail ? "执行中" : "停止中");
    assert.equal(await page.locator("#stop").isDisabled(), !fail);
    assert.equal((await page.locator("#notice").textContent()).includes("stop failed"), fail);
    assert.equal(await page.evaluate(() => window.__workflowTimers.size), 1);
    assert.equal(current.count(`POST ${prefix}/${jobA}/stop`), 1);
  }]);
  for (const first of ["preview", "run"]) cases.push([`${first} history completion cannot release a newer write`, async (page, current) => {
    current.allowed.add(`POST ${prefix}/preview`); current.allowed.add(`POST ${prefix}/${jobB}/run`);
    await selectJob(page, 1);
    await page.locator("#source").fill("/synthetic/source"); await page.locator("#target").fill("/synthetic/target");
    const history = current.gate(`GET ${prefix}`);
    const run = async () => { await page.locator("#execute").click(); await page.getByRole("button", { name: "开始执行" }).click(); };
    if (first === "preview") await page.locator("#preview").click(); else await run();
    await waitRequested(history);
    const secondKey = first === "preview" ? `POST ${prefix}/${jobB}/run` : `POST ${prefix}/preview`;
    const second = current.gate(secondKey);
    if (first === "preview") await run(); else await page.locator("#preview").click();
    await waitRequested(second);
    const reads = current.count(`GET ${prefix}/${jobB}`);
    history.release.resolve(); await settle(page, `GET ${prefix}`, 2);
    await page.locator(".history-item").nth(1).click();
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.equal(current.count(`GET ${prefix}/${jobB}`), reads, "old history completion must not unlock navigation during the newer write");
    if (first === "run") assert.equal(await page.locator("#preview").isDisabled(), true);
    second.release.resolve(); await settle(page, secondKey);
    assert.equal(current.count(secondKey), 1, "new write is performed exactly once");
  }]);
  for (const action of ["preview", "run"]) for (const fail of [false, true]) cases.push([`pagehide ignores ${action} ${fail ? "failure" : "success"}`, async (page, current) => {
    const key = action === "preview" ? `POST ${prefix}/preview` : `POST ${prefix}/${jobB}/run`;
    current.allowed.add(key); await selectJob(page, 1);
    await page.locator("#source").fill("/synthetic/source"); await page.locator("#target").fill("/synthetic/target");
    const write = current.gate(key, fail ? `${action} failed` : "");
    if (action === "preview") await page.locator("#preview").click();
    else { await page.locator("#execute").click(); await page.getByRole("button", { name: "开始执行" }).click(); }
    await waitRequested(write);
    await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent("pagehide")));
    const before = await snapshot(page), reads = current.count(`GET ${prefix}`);
    assert.equal(write.response.destroyed, false, "pagehide must not cancel the write");
    write.release.resolve(); await settle(page, key);
    assert.deepEqual(await snapshot(page), before, "hidden page must not render write results or change buttons");
    assert.equal(await page.evaluate(() => window.__workflowTimers.size), 0);
    assert.equal(current.count(`GET ${prefix}`), reads, "hidden write completion must not refresh history");
    assert.equal(current.count(key), 1);
  }]);
  for (const action of ["preview", "run"]) cases.push([`current ${action} failure releases controls`, async (page, current) => {
    const key = action === "preview" ? `POST ${prefix}/preview` : `POST ${prefix}/${jobB}/run`;
    current.allowed.add(key); await selectJob(page, 1);
    await page.locator("#source").fill("/synthetic/source"); await page.locator("#target").fill("/synthetic/target");
    const write = current.gate(key, `${action} failed`);
    if (action === "preview") await page.locator("#preview").click();
    else { await page.locator("#execute").click(); await page.getByRole("button", { name: "开始执行" }).click(); }
    await waitRequested(write); write.release.resolve(); await settle(page, key);
    assert.equal(await page.locator("#notice").textContent(), `${action} failed`);
    assert.equal(await page.locator(action === "preview" ? "#preview" : "#execute").isDisabled(), false);
    await page.locator(".history-item").nth(1).click(); await settle(page, `GET ${prefix}/${jobB}`, 2);
    assert.equal(current.count(key), 1);
  }]);
  cases.push(["run invalidates a read already in flight", async (page, current) => {
    current.allowed.add(`POST ${prefix}/${jobB}/run`); await selectJob(page, 1);
    const read = current.gate(`GET ${prefix}/${jobB}`);
    await page.locator("#refresh").click(); await waitRequested(read);
    const run = current.gate(`POST ${prefix}/${jobB}/run`);
    await page.locator("#execute").click(); await page.getByRole("button", { name: "开始执行" }).click(); await waitRequested(run);
    const before = await snapshot(page), detail = current.service.detail;
    current.service.detail = (id) => ({ ...detail(id), status: "running" });
    read.release.resolve(); await settle(page, `GET ${prefix}/${jobB}`, 2); current.service.detail = detail;
    assert.deepEqual(await snapshot(page), before, "older reads cannot render during run submission");
    assert.equal(await page.evaluate(() => window.__workflowTimers.size), 0);
    run.release.resolve(); await settle(page, `POST ${prefix}/${jobB}/run`);
    assert.equal(await page.locator("#statusBadge").textContent(), "执行中");
    assert.equal(current.count(`POST ${prefix}/${jobB}/run`), 1);
  }]);
  for (const fail of [false, true]) cases.push([`refresh during run preserves current ${fail ? "failure" : "success"}`, async (page, current) => {
    const key = `POST ${prefix}/${jobB}/run`; current.allowed.add(key); await selectJob(page, 1);
    const run = current.gate(key, fail ? "run failed" : "");
    await page.locator("#execute").click(); await page.getByRole("button", { name: "开始执行" }).click(); await waitRequested(run);
    const requests = current.requests.length;
    await page.locator("#refresh").click();
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.equal(current.requests.length, requests, "refresh must not supersede an in-flight write");
    run.release.resolve(); await settle(page, key);
    assert.equal(await page.locator("#statusBadge").textContent(), fail ? "待确认" : "执行中");
    assert.equal(await page.locator("#execute").isDisabled(), !fail);
    assert.equal((await page.locator("#notice").textContent()).includes("run failed"), fail);
    assert.equal(current.count(key), 1);
  }]);
  const failures = [];
  for (const [name, check] of cases) {
    const current = scenario = syntheticScenario(), page = await browser.newPage();
    page.on("pageerror", (error) => current.errors.push(error.message));
    await page.addInitScript(() => {
      const set = window.setTimeout.bind(window), clear = window.clearTimeout.bind(window), fetch = window.fetch.bind(window);
      window.__workflowTimers = new Map(); window.__workflowSettled = []; let next = -1;
      window.setTimeout = (callback, delay, ...args) => {
        if (delay !== 1500 && delay !== 3000) return set(callback, delay, ...args);
        const id = next--; window.__workflowTimers.set(id, () => { window.__workflowTimers.delete(id); return callback(...args); }); return id;
      };
      window.clearTimeout = (id) => { window.__workflowTimers.delete(id); clear(id); };
      window.fetch = async (input, init) => {
        const response = await fetch(input, init), json = response.json.bind(response);
        response.json = async () => { try { return await json(); } finally { window.__workflowSettled.push(`${init?.method || "GET"} ${new URL(input, location.href).pathname}`); } };
        return response;
      };
    });
    try {
      await page.goto(`${baseUrl}/fanhao/file-workflows`); await page.locator(".history-item").nth(1).waitFor();
      await check(page, current); assert.deepEqual(current.errors, []); console.log(`  passed: ${name}`);
    } catch (error) { failures.push(`${name}: ${error.message}`); }
    finally { for (const gate of current.gates) gate.release.resolve(); await page.close(); scenario = null; }
  }
  if (failures.length) assert.fail(`file-workflows ownership regressions (${failures.length}/${cases.length}):\n${failures.join("\n")}`);
  console.log(`file-workflows-ui: ${cases.length} controlled selection, stop, pagehide and write ownership cases passed`);
}
let browser;
try {
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const executablePath = [process.env.CHROME_PATH, "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe", "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe", "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe"].find((file) => file && fs.existsSync(file));
  assert(executablePath, "Set CHROME_PATH to Chrome or Edge for the UI fixture");
  browser = await chromium.launch({ executablePath, headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
  const errors = []; page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}/fanhao/file-workflows`);
  await page.waitForFunction(() => document.querySelectorAll("#allowedRoots li").length === 2);
  await page.locator("#source").fill(source); await page.locator("#target").fill(target);
  await page.locator("#preview").click();
  await page.waitForFunction(() => document.getElementById("statusBadge").textContent === "待确认");
  assert.equal(await page.locator("#totalFiles").textContent(), "1");
  assert.equal(await page.locator("#skippedFiles").textContent(), "2");
  assert((await page.locator("#files").textContent()).includes("已入库文件"));
  assert(fs.existsSync(path.join(source, "ABC-123-U.mp4"))); assert.equal(fs.readdirSync(target).length, 0);
  await page.locator("#execute").click(); await page.getByRole("button", { name: "返回检查" }).click();
  assert(fs.existsSync(path.join(source, "ABC-123-U.mp4")), "cancelling confirmation must preserve source");
  const artifacts = path.join(repository, ".codex-artifacts", "product-split"); fs.mkdirSync(artifacts, { recursive: true });
  await page.screenshot({ path: path.join(artifacts, "file-workflows-desktop.png"), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "mobile page must not overflow");
  await page.screenshot({ path: path.join(artifacts, "file-workflows-mobile.png"), fullPage: true });
  await page.locator("#execute").click(); await page.getByRole("button", { name: "开始执行" }).click();
  await page.waitForFunction(() => document.getElementById("statusBadge").textContent === "已完成");
  assert.equal(fs.readFileSync(path.join(target, "ABC-123", "ABC-123-U.mp4"), "utf8"), "synthetic-media-fixture");
  assert(fs.existsSync(path.join(source, "DEF-456.mp4")));
  await page.reload(); await page.locator(".history-item").first().click();
  await page.waitForFunction(() => document.getElementById("statusBadge").textContent === "已完成");
  assert.equal(await page.locator("#execute").isDisabled(), true); assert.deepEqual(errors, []);
  await page.close();
  await verifyOwnership(browser, `http://127.0.0.1:${server.address().port}`);
  console.log("file-workflows-ui: desktop/mobile layout, preview, cancel, confirm, execution and persisted history passed (temporary fixtures only)");
} finally {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
  await service.close(); temporary.cleanup();
}
