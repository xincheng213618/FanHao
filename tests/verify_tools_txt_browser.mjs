import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createServer } from "node:http";
import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { createTxtFormatToolService } from "../src/modules/tools/server/txt-format-service.js";
import { routeToolsApi } from "../src/modules/tools/server/routes.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const publicRoot = path.join(root, "public");
const sourcePath = "/modules/tools/txt-format-tool.js";
const text = "第1章 合成测试\n这是第一行\n接着下一行。\n下一页\n";
const file = name => ({ name, mimeType: "text/plain", buffer: Buffer.from(text) });
const sendJson = (res, status, payload) => { res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" }); res.end(JSON.stringify(payload)); };

async function runFixture({ sourceOverride = "", pattern = "" } = {}) {
  const executablePath = [process.env.CHROME_PATH, "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe", "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe", "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe"].filter(Boolean).find(value => fs.existsSync(value));
  assert(executablePath, "private Chrome/Edge is required");
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "fanhao-txt-web-"));
  const downloadDir = path.resolve(temporary, "downloads");
  assert(downloadDir.startsWith(`${path.resolve(temporary)}${path.sep}`));
  const service = createTxtFormatToolService({ cwd: root, toolDownloadDir: downloadDir, maxBodyBytes: 36 * 1024 * 1024,
    maxFileBytes: 24 * 1024 * 1024, previewBytes: 512, ttlMs: 60000, sendJson });
  const gates = [], requests = [], errors = [], unexpected = [], active = new Set();
  let denied = false, bodyReads = 0, checks = 0, browser;
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://fixture");
    try {
      if (url.pathname === "/api/modules") { sendJson(res, 200, { product: { id: "suite" }, modules: [] }); return; }
      const handled = await routeToolsApi(req, res, url, {
        requireLocalAdmin: (_, response) => { if (!denied) return true; sendJson(response, 403, { error: "此操作需要本机管理员权限" }); return false; },
        readJsonBody: async request => { bodyReads++; let data = ""; for await (const chunk of request) data += chunk; return JSON.parse(data); }, sendJson,
        txtFormatToolService: { maxBodyBytes: service.maxBodyBytes, serveDownload: service.serveDownload, serveBatchDownload: service.serveBatchDownload, createDownload: body => {
          const pending = (async () => {
          requests.push(body);
          const gate = gates.find(item => !item.used);
          if (gate) { gate.used = true; gate.start(); await gate.promise; if (gate.error) throw new Error(gate.error); if (gate.receipt) return gate.receipt; }
          return service.createDownload(body);
          })();
          active.add(pending); pending.finally(() => active.delete(pending)).catch(() => {}); return pending;
        } }
      });
      if (handled) return;
      if (url.pathname.startsWith("/api/")) { unexpected.push(url.pathname); sendJson(res, 404, { error: "unmodelled fixture endpoint" }); return; }
      if (url.pathname === "/favicon.ico") { res.writeHead(204); res.end(); return; }
      const target = url.pathname === "/tools" ? path.join(publicRoot, "index.html") : path.resolve(publicRoot, url.pathname.replace(/^\/+/, ""));
      assert(target.startsWith(`${publicRoot}${path.sep}`));
      const content = sourceOverride && url.pathname === sourcePath ? sourceOverride : await fs.promises.readFile(target);
      res.writeHead(200, { "Content-Type": target.endsWith(".html") ? "text/html" : target.endsWith(".js") ? "text/javascript" : "text/css", "Cache-Control": "no-store" }); res.end(content);
    } catch (error) { if (!res.destroyed) sendJson(res, 500, { error: error.message }); }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const run = async (name, task) => { if (pattern && !name.includes(pattern)) return; await task(); checks++; console.log(`PASS ${name}`); };
  const hold = (options = {}) => { let release, start; const value = { ...options, used: false, promise: new Promise(resolve => { release = resolve; }), requested: new Promise(resolve => { start = resolve; }), release, start }; gates.push(value); return value; };
  const started = async gate => { let timer; try { await Promise.race([gate.requested, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("controlled TXT request did not start")), 5000); })]); } finally { clearTimeout(timer); } };
  const newPage = async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, acceptDownloads: true });
    page.on("pageerror", error => errors.push(error.message));
    await page.addInitScript(() => {
      const original = fetch.bind(window); window.__aborted = []; window.__txtSettled = 0;
      // Deliberately ignore abort at transport: UI ownership must stand alone.
      window.fetch = async (url, options = {}) => {
        options.signal?.addEventListener("abort", () => __aborted.push(String(url)));
        const response = await original(url, { ...options, signal: undefined });
        if (String(url) === "/api/tools/txt-format") {
          const json = response.json.bind(response);
          response.json = async () => { try { return await json(); } finally { __txtSettled++; } };
        }
        return response;
      };
      window.__txtFileReads = 0;
      const read = FileReader.prototype.readAsDataURL;
      FileReader.prototype.readAsDataURL = function (...args) { __txtFileReads++; return read.apply(this, args); };
      FileReader.prototype.readAsText = function () { throw new Error("full-book text decoding must stay on the server"); };
    });
    await page.goto(`${base}/tools`); await page.waitForFunction(() => !document.documentElement.classList.contains("app-module-loading"));
    return page;
  };
  const expand = page => page.locator(".txt-format-tool summary").click();
  const choose = (page, value) => page.locator('.txt-format-file input').setInputFiles(value);
  const submit = page => page.getByRole("button", { name: "整理并生成下载", exact: true }).click();
  const finished = page => page.locator(".txt-format-download[href]").waitFor();
  const settle = async (page, gate) => {
    const before = await page.evaluate(() => __txtSettled); gate.release();
    await page.waitForFunction(before => __txtSettled > before, before); await tick(page);
  };
  try {
    browser = await chromium.launch({ executablePath, headless: true });
    await run("actual host TXT formats original bytes and downloads its temporary receipt", async () => {
      const page = await newPage();
      try {
        assert.equal(await page.locator(".game-library-card").count(), 4);
        assert.equal(await page.locator(".txt-format-tool").getAttribute("open"), null, "games retain the default page experience");
        await page.setViewportSize({ width: 320, height: 740 });
        let fileChoosers = 0; page.on("filechooser", () => { fileChoosers++; });
        const route = page.url();
        await page.getByRole("button", { name: "打开 TXT 文本整理", exact: true }).click();
        assert.equal(await page.locator(".txt-format-tool").evaluate(node => node.open), true);
        assert.equal(await page.locator(".txt-format-tool summary").evaluate(node => {
          const box = node.getBoundingClientRect();
          return document.activeElement === node && box.top >= 0 && box.bottom <= innerHeight
            && node.contains(document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2));
        }), true, "the TXT shortcut must scroll to and focus its existing summary on a narrow page");
        assert.equal(page.url(), route); assert.equal(fileChoosers, 0, "the shortcut must not open a file chooser");
        await choose(page, file("合成书籍.TXT")); await submit(page); await finished(page);
        const body = requests.at(-1);
        assert.deepEqual(Buffer.from(body.contentBase64, "base64"), Buffer.from(text));
        assert.equal("text" in body, false); assert.deepEqual(body.options, { indent: true, cleanJunk: true });
        const downloadEvent = page.waitForEvent("download"); await page.locator(".txt-format-download").click(); const download = await downloadEvent;
        assert.equal(download.suggestedFilename(), "合成书籍_格式化.txt");
        const formatted = fs.readFileSync(await download.path(), "utf8");
        assert(formatted.includes("　　这是第一行接着下一行。")); assert(!formatted.includes("下一页"));
        assert.equal(await page.locator(".txt-format-result pre").textContent(), formatted);
        assert((await page.locator(".txt-format-status").textContent()).includes("原文件未修改"));
        if (process.argv.includes("--screenshots")) {
          const output = path.join(root, ".codex-artifacts", "tools");
          fs.mkdirSync(output, { recursive: true });
          await page.setViewportSize({ width: 320, height: 740 });
          await page.locator(".txt-format-tool").screenshot({ path: path.join(output, "txt-format-result-320.png") });
        }
      } finally { await page.close(); }
    });
    await run("TXT preserves legacy bytes and explicit formatting options", async () => {
      const page = await newPage();
      try {
        await expand(page); await choose(page, { name: "legacy.txt", mimeType: "text/plain", buffer: Buffer.from([0xd6, 0xd0, 0xce, 0xc4, 0xa1, 0xa3, 10]) });
        await page.getByLabel("段落首行缩进两格", { exact: true }).uncheck(); await page.getByLabel("清理常见分页和章节导航文字", { exact: true }).uncheck();
        await submit(page); await finished(page);
        assert.deepEqual(requests.at(-1).options, { indent: false, cleanJunk: false });
        assert.equal(await page.locator(".txt-format-result pre").textContent(), "中文。\n");
        assert((await page.locator(".txt-format-result").textContent()).includes("gb18030"));
      } finally { await page.close(); }
    });
    await run("TXT batch formats remaining files after failure and retries only unfinished files", async () => {
      const page = await newPage(), first = hold(), second = hold({ error: "合成单文件失败" });
      const archive = page.locator(".txt-format-archive");
      const rows = page.locator(".txt-format-batch li");
      try {
        await page.setViewportSize({ width: 320, height: 740 });
        await expand(page);
        await choose(page, [file("同名.txt"), file("重试.txt"), file("同名.TXT"), file("invalid.pdf")]);
        const offset = requests.length;
        await submit(page); await started(first);
        assert.equal(requests.length, offset + 1);
        assert.equal(await page.evaluate(() => __txtFileReads), 1, "a batch owns at most one file read before the previous request settles");
        first.release(); await started(second); second.release();
        await page.getByText("已完成 2 / 4 份 · 2 份需处理", { exact: true }).waitFor();
        assert.deepEqual(requests.slice(offset).map(body => body.fileName), ["同名.txt", "重试.txt", "同名.TXT"]);
        assert.equal(await rows.count(), 4);
        assert.equal(await rows.getByText("合成单文件失败", { exact: true }).count(), 1);
        assert(await rows.getByText("只支持 .txt 文档，请重新选择", { exact: true }).isVisible());
        assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
        const href = await archive.getAttribute("href");
        assert.equal(new URL(href, base).searchParams.getAll("id").length, 2);
        denied = true;
        const unauthorized = await fetch(new URL(href, base));
        assert.equal(unauthorized.status, 403);
        await unauthorized.text();
        denied = false;
        await assertZip(page, archive, ["同名_格式化.txt", "同名_格式化 (2).txt"]);
        await page.getByRole("button", { name: "重试未完成", exact: true }).click();
        await page.getByText("已完成 3 / 4 份 · 1 份需处理", { exact: true }).waitFor();
        assert.deepEqual(requests.slice(offset).map(body => body.fileName), ["同名.txt", "重试.txt", "同名.TXT", "重试.txt"]);
        assert.equal(await page.evaluate(() => __txtFileReads), 4);
        await assertZip(page, archive, ["同名_格式化.txt", "重试_格式化.txt", "同名_格式化 (2).txt"]);
        const id = new URL(href, base).searchParams.get("id");
        for (const [ids, code] of [[[id, id], 400], [[id, "unknown"], 410]]) {
          const response = await fetch(`${base}/api/tools/txt-format/batch-download?${new URLSearchParams(ids.map(value => ["id", value]))}`);
          assert.equal(response.status, code);
          await response.text();
        }
      } finally { denied = false; first.release(); second.release(); await page.close(); }
    });
    await run("TXT replacement stops the remaining batch and oversized selections stay local", async () => {
      const page = await newPage(), gate = hold();
      try {
        await expand(page);
        const offset = requests.length;
        await choose(page, Array.from({ length: 17 }, (_, index) => file(`blocked-${index}.txt`)));
        await page.getByText("每次最多选择 16 个 TXT 文件", { exact: true }).waitFor();
        assert.equal(await page.locator(".txt-format-submit").isDisabled(), true);
        assert.equal(await page.evaluate(() => __txtFileReads), 0);
        await choose(page, [file("old-batch-first.txt"), file("old-batch-second.txt")]);
        await submit(page); await started(gate);
        await choose(page, file("replacement.txt")); await submit(page); await finished(page);
        await settle(page, gate);
        assert.deepEqual(requests.slice(offset).map(body => body.fileName), ["old-batch-first.txt", "replacement.txt"]);
        assert.equal(await page.locator(".txt-format-result h4").first().textContent(), "replacement_格式化.txt");
      } finally { gate.release(); await page.close(); }
    });
    await run("TXT stopping a batch retains finished receipts and makes remaining files retryable", async () => {
      const page = await newPage(), first = hold(), second = hold();
      try {
        await expand(page);
        await choose(page, [file("completed.txt"), file("waiting.txt"), file("queued.txt")]);
        const offset = requests.length;
        await submit(page); await started(first); first.release(); await started(second);
        const kept = await page.locator('.txt-format-batch .txt-format-download[href]').getAttribute("href");
        await page.getByRole("button", { name: "停止批量整理", exact: true }).click();
        await settle(page, second);
        assert.deepEqual(requests.slice(offset).map(body => body.fileName), ["completed.txt", "waiting.txt"]);
        assert.equal(await page.locator('.txt-format-batch .txt-format-download[href]').getAttribute("href"), kept);
        await page.getByRole("button", { name: "重试未完成", exact: true }).click();
        await page.getByText("已完成 3 / 3 份", { exact: true }).waitFor();
        assert.deepEqual(requests.slice(offset).map(body => body.fileName), ["completed.txt", "waiting.txt", "waiting.txt", "queued.txt"]);
        assert.equal(await page.locator('.txt-format-batch .txt-format-download[href]').first().getAttribute("href"), kept);
      } finally { first.release(); second.release(); await page.close(); }
    });
    await run("TXT can append through the picker while one file is already being formatted", async () => {
      const page = await newPage(), gate = hold();
      try {
        await expand(page);
        const offset = requests.length;
        const firstChooser = page.waitForEvent("filechooser");
        await page.getByRole("button", { name: "选择 TXT 文件", exact: true }).click();
        await (await firstChooser).setFiles(file("working.txt"));
        await submit(page); await started(gate);
        const addedChooser = page.waitForEvent("filechooser");
        await page.getByRole("button", { name: "追加文件", exact: true }).click();
        await (await addedChooser).setFiles([file("later.txt"), file("skip.txt")]);
        const rows = page.locator(".txt-format-batch li");
        assert.equal(await rows.count(), 3);
        assert.equal(await rows.filter({ hasText: "working.txt" }).getByText("正在整理…", { exact: true }).count(), 1);
        assert.equal(await page.getByRole("button", { name: "移除 skip.txt", exact: true }).isDisabled(), true);
        await settle(page, gate);
        await page.getByText("已完成 1 / 3 份", { exact: true }).waitFor();
        assert.deepEqual(requests.slice(offset).map(body => body.fileName), ["working.txt"]);
        const done = rows.filter({ has: page.getByRole("button", { name: "移除 working.txt", exact: true }) });
        const receipt = done.locator("a.txt-format-download");
        const kept = await receipt.getAttribute("href");
        await done.locator("summary").click();
        await receipt.evaluate(node => { window.__keptTxtLink = node; });
        await page.getByRole("button", { name: "移除 skip.txt", exact: true }).click();
        assert.equal(await done.locator("details").getAttribute("open"), "");
        assert.equal(await receipt.evaluate(node => node === __keptTxtLink), true);
        await page.getByRole("button", { name: "重试未完成", exact: true }).click();
        await page.getByText("已完成 2 / 2 份", { exact: true }).waitFor();
        assert.deepEqual(requests.slice(offset).map(body => body.fileName), ["working.txt", "later.txt"]);
        assert.equal(await receipt.getAttribute("href"), kept);
        await assertZip(page, page.locator(".txt-format-archive"), ["working_格式化.txt", "later_格式化.txt"]);
      } finally { gate.release(); await page.close(); }
    });
    await run("TXT file drops preserve receipts on overflow and can reduce a batch to one result", async () => {
      const page = await newPage();
      const drop = names => page.locator(".txt-format-selection").evaluate((zone, { names, text }) => {
        const data = new DataTransfer();
        for (const name of names) data.items.add(new File([text], name, { type: "text/plain" }));
        const over = new DragEvent("dragover", { dataTransfer: data, bubbles: true, cancelable: true });
        zone.dispatchEvent(over);
        const highlighted = zone.classList.contains("is-dragging");
        const event = new DragEvent("drop", { dataTransfer: data, bubbles: true, cancelable: true });
        zone.dispatchEvent(event);
        return over.defaultPrevented && highlighted && event.defaultPrevented && !zone.classList.contains("is-dragging");
      }, { names, text });
      try {
        await page.setViewportSize({ width: 320, height: 740 }); await expand(page);
        const offset = requests.length;
        assert(await drop(["keep.txt", "remove.txt"]));
        assert.equal(requests.length, offset, "dropping files must only change the selection");
        await submit(page);
        await page.getByText("已完成 2 / 2 份", { exact: true }).waitFor();
        const kept = await page.locator(".txt-format-batch .txt-format-download").first().getAttribute("href");
        const archive = await page.locator(".txt-format-archive").getAttribute("href");
        assert(await drop(Array.from({ length: 15 }, (_, index) => `overflow-${index}.txt`)));
        await page.getByText("本次追加后将超过 16 份，请先移除不需要的文件。", { exact: true }).waitFor();
        assert.equal(await page.locator(".txt-format-archive").getAttribute("href"), archive);
        assert.equal(await page.locator(".txt-format-batch li").count(), 2);
        await choose(page, Array.from({ length: 17 }, (_, index) => file(`replacement-${index}.txt`)));
        await page.getByText("每次最多选择 16 个 TXT 文件", { exact: true }).waitFor();
        assert.equal(await page.locator(".txt-format-archive").getAttribute("href"), archive, "an invalid replacement must preserve the current batch");
        await page.getByRole("button", { name: "移除 remove.txt", exact: true }).press("Enter");
        assert.equal(await page.locator(".txt-format-result h4").first().textContent(), "keep_格式化.txt");
        assert.equal(await page.locator(".txt-format-result .txt-format-download").getAttribute("href"), kept);
        assert.equal(await page.locator(".txt-format-archive").count(), 0);
        assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
        await page.getByRole("button", { name: "清空选择", exact: true }).click();
        assert.equal(await page.locator(".txt-format-result").isVisible(), false);
        assert.equal(await page.locator(".txt-format-submit").isDisabled(), true);
        assert.equal(await page.getByRole("button", { name: "选择 TXT 文件", exact: true }).evaluate(node => node === document.activeElement), true);
        assert(await drop(["one.txt", "two.txt"]));
        await page.evaluate(() => {
          window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: true }));
          window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true }));
        });
        assert.equal(await page.locator(".txt-format-batch li").count(), 2, "the selected files remain editable after a cached page return");
        assert.equal(await page.getByRole("button", { name: "移除 two.txt", exact: true }).isEnabled(), true);
        assert.deepEqual(requests.slice(offset).map(body => body.fileName), ["keep.txt", "remove.txt"]);
      } finally { await page.close(); }
    });
    await run("TXT invalid files are rejected before read or upload and recover at 320px", async () => {
      const page = await newPage();
      try {
        await page.setViewportSize({ width: 320, height: 740 }); await expand(page);
        await page.evaluate(() => { const original = FileReader.prototype.readAsDataURL; window.__fileReads = 0; FileReader.prototype.readAsDataURL = function (...args) { __fileReads++; return original.apply(this, args); }; });
        const before = requests.length;
        for (const value of [{ ...file("bad.pdf") }, { name: "empty.txt", buffer: Buffer.alloc(0) }, { name: "oversized.txt", buffer: Buffer.alloc(24 * 1024 * 1024 + 1) }]) {
          await choose(page, value); assert.equal(await page.locator(".txt-format-submit").isDisabled(), true);
          assert(await page.locator(".txt-format-status.is-error").isVisible());
          await page.locator(".txt-format-tool form").evaluate(form => form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
        }
        assert.equal(requests.length, before); assert.equal(await page.evaluate(() => __fileReads), 0);
        await choose(page, file("恢复测试-".repeat(20) + ".txt")); await submit(page); await finished(page);
        assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "TXT controls and long names must fit 320px");
        assert.equal(await page.locator(".txt-format-download").evaluate(link => { link.scrollIntoView(); const box = link.getBoundingClientRect(); return document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2) === link; }), true);
      } finally { await page.close(); }
    });
    await run("TXT single flight and permission failure remain retryable", async () => {
      const page = await newPage(); const gate = hold({ error: "合成整理失败，请重试" });
      try {
        await expand(page); await choose(page, file("retry.txt")); const before = requests.length;
        await submit(page); await started(gate);
        assert.equal(await page.locator(".txt-format-submit").getAttribute("aria-disabled"), "true");
        await page.locator(".txt-format-tool form").evaluate(form => { for (let i = 0; i < 3; i++) form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); });
        assert.equal(await page.evaluate(() => __txtFileReads), 1, "repeated submits must share one current TXT operation, including file reads");
        await tick(page); assert.equal(requests.length, before + 1, "repeated submits must share one current TXT operation");
        gate.release(); await page.getByText("合成整理失败，请重试", { exact: true }).waitFor();
        denied = true; const reads = bodyReads; await submit(page); await page.getByText("此操作需要本机管理员权限", { exact: true }).waitFor();
        assert.equal(bodyReads, reads, "the actual route rejects permission before reading the file body");
        denied = false; await submit(page); await finished(page);
      } finally { denied = false; gate.release(); await page.close(); }
    });
    for (const lateError of ["", "旧文件的失败"]) await run(`TXT new file owns results after late ${lateError ? "failure" : "success"}`, async () => {
      const page = await newPage(); const gate = hold({ error: lateError });
      try {
        await expand(page); await choose(page, file("old.txt")); await submit(page); await started(gate);
        await choose(page, file("new.txt")); await submit(page); await finished(page);
        await settle(page, gate);
        await page.waitForFunction(() => __aborted.length === 1);
        assert.equal(await page.locator(".txt-format-result h4").first().textContent(), "new_格式化.txt", "an old TXT response must not overwrite the new file result");
        assert(!(await page.locator(".txt-format-status").textContent()).includes("旧文件"));
      } finally { gate.release(); await page.close(); }
    });
    await run("TXT delayed file read and read error recover without obsolete upload", async () => {
      const page = await newPage();
      try {
        await expand(page); await choose(page, file("old-read.txt"));
        await page.evaluate(() => { const original = FileReader.prototype.readAsDataURL; FileReader.prototype.readAsDataURL = function (source) { FileReader.prototype.readAsDataURL = original; window.__releaseRead = () => new Promise(resolve => { this.addEventListener("loadend", resolve, { once: true }); original.call(this, source); }); }; });
        const before = requests.length; await submit(page); await choose(page, file("current.txt")); await submit(page); await finished(page);
        await page.evaluate(() => __releaseRead()); await tick(page);
        assert.equal(requests.length, before + 1); assert.equal(requests.at(-1).fileName, "current.txt");
        await choose(page, file("read-error.txt"));
        await page.evaluate(() => { const original = FileReader.prototype.readAsDataURL; FileReader.prototype.readAsDataURL = function () { FileReader.prototype.readAsDataURL = original; queueMicrotask(() => this.onerror(new Event("error"))); }; });
        await submit(page); await page.getByText("文件读取失败，请重新选择或重试", { exact: true }).waitFor(); await submit(page); await finished(page);
      } finally { await page.close(); }
    });
    await run("TXT option changes and page lifecycle retire pending work", async () => {
      const page = await newPage(); const first = hold(), second = hold();
      try {
        await expand(page); await choose(page, file("options.txt")); await submit(page); await started(first);
        await page.getByLabel("段落首行缩进两格", { exact: true }).uncheck(); await settle(page, first);
        assert.equal(await page.locator(".txt-format-result").isVisible(), false);
        await submit(page); await started(second);
        await page.evaluate(() => dispatchEvent(new PageTransitionEvent("pagehide", { persisted: true })));
        await page.evaluate(() => dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true })));
        await settle(page, second); assert.equal(await page.locator(".txt-format-result").isVisible(), false);
        await submit(page); await finished(page); assert.equal(requests.at(-1).options.indent, false);
      } finally { first.release(); second.release(); await page.close(); }
    });
    await run("TXT completed result clears its success message across page return", async () => {
      const page = await newPage();
      try {
        await expand(page); await choose(page, file("return.txt")); await submit(page); await finished(page);
        await page.evaluate(() => { dispatchEvent(new PageTransitionEvent("pagehide", { persisted: true })); dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true })); });
        assert.equal(await page.locator(".txt-format-result").isVisible(), false);
        assert.equal(await page.locator(".txt-format-status").textContent(), "临时结果已清除，返回后可重新整理。");
        await submit(page); await finished(page);
      } finally { await page.close(); }
    });
    await run("TXT host redraw retires the old form and result", async () => {
      const page = await newPage(); const gate = hold();
      try {
        await expand(page); await choose(page, file("detached.txt")); await submit(page); await started(gate);
        await page.locator(".txt-format-tool form").evaluate(form => { window.__oldTxtForm = form; history.pushState(null, "", "/tools"); dispatchEvent(new PopStateEvent("popstate")); });
        await page.waitForFunction(() => !__oldTxtForm.isConnected); await settle(page, gate);
        const before = requests.length; await page.evaluate(() => __oldTxtForm.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }))); await tick(page);
        assert.equal(requests.length, before); assert.equal(await page.locator(".txt-format-result").isVisible(), false);
        await expand(page); await choose(page, file("fresh.txt")); await submit(page); await finished(page);
      } finally { gate.release(); await page.close(); }
    });
    await run("TXT bounded preview and expired or invalid receipts remain recoverable", async () => {
      const page = await newPage();
      try {
        await expand(page); await choose(page, file("receipt.txt"));
        const expired = hold({ receipt: { id: "expired", downloadUrl: "/api/tools/txt-format/download/expired", expiresAt: new Date(Date.now() - 1000).toISOString(), previewText: "合成".repeat(60000), stats: {} } });
        await submit(page); await started(expired); expired.release(); await page.locator('.txt-format-download[aria-disabled="true"]').waitFor();
        assert.equal(await page.locator(".txt-format-result pre").evaluate(pre => pre.textContent.length), 65536);
        assert.equal(await page.locator(".txt-format-download").getAttribute("href"), null);
        const invalid = hold({ receipt: { id: "invalid", downloadUrl: "https://example.invalid/book.txt", expiresAt: new Date(Date.now() + 10000).toISOString() } });
        await submit(page); await started(invalid); invalid.release(); await page.getByText("下载回执无效，请重新整理", { exact: true }).waitFor();
        assert.equal(await page.locator(".txt-format-result").isVisible(), false); await submit(page); await finished(page);
      } finally { await page.close(); }
    });
    assert(checks > 0); assert.deepEqual(errors, []); assert.deepEqual(unexpected, []);
    return checks;
  } finally {
    for (const gate of gates) gate.release(); if (browser) await browser.close();
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    await Promise.allSettled([...active]);
    // This service owns only the verified private temporary download directory.
    service.cleanup(); fs.rmdirSync(downloadDir); fs.rmdirSync(temporary);
  }
}
async function tick(page) { await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))); }

async function assertZip(page, link, names) {
  const waiting = page.waitForEvent("download");
  await link.click();
  const download = await waiting;
  assert.equal(download.suggestedFilename(), "TXT_整理结果.zip");
  const read = spawnSync("python", ["-c", "import json,sys,zipfile\nwith zipfile.ZipFile(sys.argv[1]) as z: print(json.dumps([z.namelist(), z.testzip(), [z.read(n).decode('utf-8') for n in z.namelist()]]))", await download.path()], { encoding: "utf8", windowsHide: true });
  assert.equal(read.status, 0, read.stderr);
  const [actual, corrupt, contents] = JSON.parse(read.stdout);
  assert.deepEqual(actual, names);
  assert.equal(corrupt, null);
  assert(contents.every(content => content.includes("　　这是第一行接着下一行。") && !content.includes("下一页")));
}

async function verifyArchiveReceiptLifetime() {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "fanhao-txt-archive-lifetime-"));
  const downloads = path.join(parent, "downloads");
  const service = createTxtFormatToolService({ cwd: root, toolDownloadDir: downloads, maxFileBytes: 4096, ttlMs: 700, previewBytes: 256, sendJson });
  class Response extends EventEmitter {
    writeHead(status) { this.status = status; }
    write() { if (this.held) return true; this.held = true; return false; }
    end() { this.writableEnded = true; }
    destroy() { this.destroyed = true; this.emit("close"); }
  }
  let response, download;
  try {
    const receipts = await Promise.all(["one.txt", "two.txt"].map(fileName => service.createDownload({ fileName, text })));
    const ids = receipts.map(receipt => receipt.id);
    response = new Response();
    download = service.serveBatchDownload(response, ids);
    assert.equal(response.status, 200);
    await new Promise(resolve => setTimeout(resolve, Math.max(...receipts.map(receipt => Date.parse(receipt.expiresAt))) - Date.now() + 40));
    const expired = new Response();
    await service.serveBatchDownload(expired, ids);
    assert.equal(expired.status, 410);
    assert.deepEqual(fs.readdirSync(downloads).sort(), [...ids].sort(), "accepted archives retain their files until streaming finishes");
    response.emit("drain"); await download;
    assert.equal(response.writableEnded, true);
    assert.deepEqual(fs.readdirSync(downloads), []);
  } finally {
    response?.destroy(); await download?.catch(() => {});
    service.cleanup(); fs.rmdirSync(downloads); fs.rmdirSync(parent);
  }
}

assert.equal(await runFixture(), 16);
await verifyArchiveReceiptLifetime();
console.log("PASS TXT archive accepted before expiry pins its files through response completion");
const source = fs.readFileSync(path.join(publicRoot, sourcePath), "utf8");
for (const control of [
  { name: "TXT response ownership", marker: "return operation === owner &&", replacement: "return true || operation === owner &&", pattern: "TXT new file owns results after late success", failure: /an old TXT response must not overwrite/ },
  { name: "TXT submission single flight", marker: "if (operation || disposed || suspended || !element.isConnected) return;", replacement: "if (disposed || suspended || !element.isConnected) return;", pattern: "TXT single flight", failure: /repeated submits must share one current TXT operation/ }
]) {
  assert.equal(source.split(control.marker).length, 2);
  await assert.rejects(() => runFixture({ sourceOverride: source.replace(control.marker, control.replacement), pattern: control.pattern }), { name: "AssertionError", message: control.failure });
  console.log(`PASS negative control detects missing ${control.name}`);
}
console.log("Tools TXT passed (16 actual-host Chromium cases, archive lifetime, actual formatter/routes with private temporary files, and 2 behavior negative controls)");
