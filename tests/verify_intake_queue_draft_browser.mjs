import assert from "node:assert/strict";
import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { intakeDraftJobOwns, mergeIntakeQueueDraft } from "../public/modules/fanhao/file-workflows/intake-queue-draft.js";

const root = fileURLToPath(new URL("../public", import.meta.url));
const route = "/fanhao/file-workflows/intake";
const makeItem = (number, directory = "X:\\Fixture") => {
  const code = `FIX-${String(number).padStart(3, "0")}`, name = `${code}.mp4`;
  return { path: `${directory}\\${name}`, code, name, size: 200 + number };
};
const file = makeItem(1);
const folder = "X:\\Fixture\\Bundle";
const bundle = makeItem(2, folder);
bundle.package = { folder, videos: [{ path: bundle.path, name: bundle.name }], ads: [], subtitles: [], extras: 0 };
const active = makeItem(3);
const unavailable = makeItem(4);
const submitting = { id: "fixture-pending-submission", action: "replace", source: file.path, active: true };
const receipt = mergeIntakeQueueDraft({ entries: [], selected: "" }, [file], file.path, [submitting]).entries[0];
assert.equal(receipt.jobId, submitting.id);
assert.equal(intakeDraftJobOwns(receipt, [{ ...submitting, state: "completed", active: false }]), true);
assert.equal(intakeDraftJobOwns(receipt, [{ ...submitting, id: "older-job", state: "completed", active: false }]), false);
const items = new Map([[file.path, file], [bundle.path, bundle], [folder, bundle], [active.path, active], [unavailable.path, unavailable]]);
const reads = [];
let runningJobs = [], failUnavailable = false;
let inFlightScans = 0, maxScans = 0;
const server = createServer(async (request, response) => {
  const url = new URL(request.url, "http://fixture");
  if (url.pathname.startsWith("/api/")) {
    let body = null;
    if (request.method === "POST") {
      let raw = "";
      for await (const chunk of request) raw += chunk;
      body = raw ? JSON.parse(raw) : null;
    }
    const action = url.pathname.split("/").at(-1);
    reads.push({ action, method: request.method, body });
    let payload = {}, status = 200;
    if (action === "jobs") payload = { jobs: runningJobs };
    if (action === "scan") {
      inFlightScans++;
      maxScans = Math.max(maxScans, inFlightScans);
      await new Promise((resolve) => setTimeout(resolve, 25));
      inFlightScans--;
      const item = items.get(body.path);
      if (!item || failUnavailable && body.path === unavailable.path) {
        payload = { error: "测试文件暂时不可读。" };
        status = 503;
      } else payload = { items: [item], unmatched: [] };
    }
    if (action === "compare") {
      const item = items.get(body.path);
      const source = { ...item, flags: {}, subtitles: [], available: true, probe: { width: 1920, height: 1080, duration: 90 } };
      payload = { code: body.code || item.code, source, files: [], works: [], actors: [], package: item.package };
    }
    if (!response.destroyed) {
      response.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      response.end(JSON.stringify(payload));
    }
    return;
  }
  const pathname = url.pathname === route ? "/modules/fanhao/file-workflows/intake.html" : url.pathname;
  const file = path.resolve(root, `.${pathname}`);
  if (!file.startsWith(`${root}${path.sep}`) || !statSync(file, { throwIfNoEntry: false })?.isFile()) return response.writeHead(404).end();
  const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml" };
  response.writeHead(200, { "Content-Type": `${types[path.extname(file)] || "application/octet-stream"}; charset=utf-8` });
  createReadStream(file).pipe(response);
});

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
let browser;
try {
  const executablePath = process.env.FANHAO_CHROME_PATH || [
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
    "/usr/bin/chromium", "/usr/bin/google-chrome"
  ].find(existsSync);
  assert.ok(executablePath, "Chrome or Chromium is required for the intake queue draft fixture");
  browser = await chromium.launch({ executablePath });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const page = await browser.newPage({ viewport: { width: 1100, height: 840 } });
  page.setDefaultTimeout(5000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/*", (intercepted) => intercepted.request().url().startsWith(`${origin}/`) ? intercepted.continue() : intercepted.abort());
  await page.goto(`${origin}${route}`);
  const queued = (item) => page.locator("#queue .queue-pick").filter({ hasText: item.name });
  async function add(item, inputPath = item.path) {
    const input = page.getByRole("textbox", { name: "视频或文件夹完整路径" });
    await input.fill(inputPath);
    await input.press("Enter");
    await queued(item).waitFor();
  }
  await add(file);
  await page.locator("#codeForm").waitFor();
  await page.locator("#code").fill("FIX-011");
  await page.getByRole("button", { name: "重新匹配" }).click();
  await queued(file).getByText("FIX-011", { exact: true }).waitFor();
  await add(bundle, folder);
  await add(active);
  await add(unavailable);
  await queued(bundle).click();
  await page.locator("#compareTable").getByText("下载包", { exact: true }).waitFor();
  assert.equal(await page.locator("#queue .queue-row[aria-current=true] strong").textContent(), bundle.code);

  runningJobs = [{ id: "running-draft", action: "replace", active: true, state: "queued", position: 1, source: active.path, code: active.code }];
  failUnavailable = true;
  const beforeReload = reads.length;
  await page.reload();
  const draft = page.getByRole("region", { name: "恢复洗版待核对清单" });
  await draft.getByText("此标签页有 4 项待核对草稿。").waitFor();
  assert.ok(reads.slice(beforeReload).every(({ method }) => method === "GET"), "reload must not implicitly scan or restore");
  const beforeRestore = reads.length;
  await draft.getByRole("button", { name: "恢复待核对清单" }).click();
  await draft.getByText("还有 1 项未恢复，可重试或清除。").waitFor();
  await queued(file).getByText("FIX-011", { exact: true }).waitFor();
  await page.locator("#compareTable").getByText("下载包", { exact: true }).waitFor();
  assert.equal(await page.locator("#queue .queue-row[aria-current=true] strong").textContent(), bundle.code);
  assert.equal(await queued(active).count(), 0);
  await draft.getByText("查看未恢复项").click();
  await draft.getByText(/FIX-004.*测试文件暂时不可读/).waitFor();
  const restoredCalls = reads.slice(beforeRestore);
  assert.deepEqual(restoredCalls.filter(({ action }) => action === "scan").map(({ body }) => body.path), [file.path, folder, unavailable.path]);
  assert.ok(restoredCalls.every(({ method, action }) => method === "GET" || ["scan", "compare"].includes(action)), "restoring must not start subtitle or file mutations");
  assert.ok(maxScans <= 3);

  failUnavailable = false;
  await draft.getByRole("button", { name: "恢复待核对清单" }).click();
  await queued(unavailable).waitFor();
  await draft.waitFor({ state: "hidden" });
  assert.equal(await page.locator("#queue .queue-row[aria-current=true] strong").textContent(), bundle.code);
  await page.getByRole("button", { name: `从待核对移除 ${unavailable.name}` }).click();
  await page.reload();
  await draft.getByText("此标签页有 2 项待核对草稿。").waitFor();
  await page.setViewportSize({ width: 390, height: 840 });
  const bounds = await draft.boundingBox();
  assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= 390);
  const beforeClear = reads.length;
  await draft.getByRole("button", { name: "清除恢复清单" }).click();
  await draft.waitFor({ state: "hidden" });
  await page.reload();
  await page.locator("#bench[data-view=work]").waitFor();
  assert.equal(await draft.isVisible(), false);
  assert.ok(reads.slice(beforeClear).every(({ method }) => method === "GET"));
  assert.deepEqual(errors, []);
  console.log("Intake queue draft browser verification passed.");
} finally {
  await browser?.close();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}
