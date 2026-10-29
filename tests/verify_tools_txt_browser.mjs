import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createServer } from "node:http";
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
        txtFormatToolService: { maxBodyBytes: service.maxBodyBytes, serveDownload: service.serveDownload, createDownload: body => {
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

assert.equal(await runFixture(), 11);
const source = fs.readFileSync(path.join(publicRoot, sourcePath), "utf8");
for (const control of [
  { name: "TXT response ownership", marker: "return operation === owner &&", replacement: "return true || operation === owner &&", pattern: "TXT new file owns results after late success", failure: /an old TXT response must not overwrite/ },
  { name: "TXT submission single flight", marker: "if (operation || disposed || suspended || !element.isConnected) return;", replacement: "if (disposed || suspended || !element.isConnected) return;", pattern: "TXT single flight", failure: /repeated submits must share one current TXT operation/ }
]) {
  assert.equal(source.split(control.marker).length, 2);
  await assert.rejects(() => runFixture({ sourceOverride: source.replace(control.marker, control.replacement), pattern: control.pattern }), { name: "AssertionError", message: control.failure });
  console.log(`PASS negative control detects missing ${control.name}`);
}
console.log("Tools TXT passed (11 actual-host Chromium cases, actual formatter/routes with private temporary files, and 2 behavior negative controls)");
