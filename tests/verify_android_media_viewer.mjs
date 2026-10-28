import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

// Actual viewer and full Android CSS, private Chromium and synthetic SVG only.
// Image responses are gated; no library server, media, account or device is used.
const root = fileURLToPath(new URL("..", import.meta.url));
const www = path.join(root, "android-client/www");
const executablePath = [process.env.CHROME_PATH, "C:/Program Files/Google/Chrome/Application/chrome.exe", "C:/Program Files/Microsoft/Edge/Application/msedge.exe"].filter(Boolean).find(value => fs.existsSync(value));
assert(executablePath, "Chrome or Edge required for Android viewer fixture");
let source = fs.readFileSync(path.join(www, "js/media-viewer.js"), "utf8");
let viewerCss = fs.readFileSync(path.join(www, "css/media-viewer.css"), "utf8");
if (process.argv.includes("--legacy-nav-press")) {
  const marker = /\.media-viewer-nav:active\s*\{\s*transform: translateY\(-50%\);\s*\}/g;
  assert.equal([...viewerCss.matchAll(marker)].length, 1);
  viewerCss = viewerCss.replace(marker, "");
}
if (process.argv.includes("--legacy-image-loading")) {
  const marker = "    loadCurrentImage(item);";
  assert.equal(source.split(marker).length, 2);
  source = source.replace(marker, "    img.alt = item.title || ''; img.src = item.url;");
}
if (process.argv.includes("--legacy-image-ownership")) {
  const marker = "const isCurrent = () => activeImage === img && overlay?.contains(img);";
  assert.equal(source.split(marker).length, 2);
  source = source.replace(marker, "const isCurrent = () => Boolean(overlay);");
}
const svg = color => `<svg xmlns="http://www.w3.org/2000/svg" width="300" height="400"><rect width="300" height="400" fill="${color}"/></svg>`;
const unexpected = [], faults = [];
const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://fixture");
    if (url.pathname === "/") {
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      return res.end(`<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1,viewport-fit=cover"><link rel=stylesheet href=/android/styles.css><button id=trigger>打开图片</button><script type=module>import{createMediaViewer}from'/android/js/media-viewer.js';window.viewer=createMediaViewer();window.openViewer=(urls,index=0)=>viewer.openImage(urls[index], '合成图片', {items:urls.map((url,i)=>({url,title:'合成图片 '+(i+1)})),index});</script>`);
    }
    if (url.pathname === "/favicon.ico") { res.writeHead(204); return res.end(); }
    assert(url.pathname.startsWith("/android/"), "only private static assets are served");
    const target = path.resolve(www, url.pathname.slice("/android/".length));
    assert(target.startsWith(www + path.sep));
    res.setHeader("Content-Type", target.endsWith(".js") ? "text/javascript" : "text/css");
    res.end(target === path.join(www, "js/media-viewer.js") ? source : target === path.join(www, "css/media-viewer.css") ? viewerCss : await fs.promises.readFile(target));
  } catch (error) { unexpected.push(error.message); res.writeHead(500); res.end(error.message); }
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${server.address().port}`;
let browser, checks = 0;
const run = async (name, task) => { await task(); checks++; console.log(`PASS ${name}`); };
const snapshot = page => page.evaluate(() => {
  const stage = document.querySelector(".media-viewer-stage"), img = stage?.querySelector("img");
  return { state: stage?.dataset.imageState, busy: stage?.getAttribute("aria-busy"), image: img?.getAttribute("src"), visible: img ? getComputedStyle(img).visibility : "", count: document.querySelector(".media-viewer-count")?.textContent };
});
async function newPage() {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  page.setDefaultTimeout(5000);
  page.on("pageerror", error => faults.push(error.message));
  await page.route("**/images/**", route => route.fulfill({ contentType: "image/svg+xml", body: svg("#38806a") }));
  await page.goto(base);
  await page.waitForFunction(() => Boolean(window.viewer));
  return page;
}
try {
  browser = await chromium.launch({ executablePath, headless: true });
  await run("ready images render and same-image list hydration preserves the request and element", async () => {
    const page = await newPage();
    try {
      await page.evaluate(() => openViewer(["/images/ready.svg"]));
      await page.waitForFunction(() => document.querySelector(".media-viewer-stage img")?.naturalWidth > 0);
      assert.equal((await snapshot(page)).state, "ready");
      assert.equal((await snapshot(page)).visible, "visible");
      assert.equal(await page.locator(".media-viewer-feedback").isVisible(), false);
      await page.evaluate(() => { window.savedImage = document.querySelector(".media-viewer-stage img"); viewer.updateItems([{ url: "/images/ready.svg", title: "更新标题" }, { url: "/images/next.svg" }]); });
      assert.equal(await page.evaluate(() => savedImage === document.querySelector(".media-viewer-stage img")), true);
      assert.equal(await page.locator(".media-viewer-head strong").textContent(), "更新标题");
      assert.equal((await snapshot(page)).count, "1 / 2");
    } finally { await page.close(); }
  });
  await run("slow next image hides the old frame; late load/error callbacks cannot replace a newer image", async () => {
    const page = await newPage();
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    await page.route("**/images/slow.svg", async route => { await gate; await route.fulfill({ contentType: "image/svg+xml", body: svg("#c04040") }).catch(() => {}); });
    try {
      await page.evaluate(() => openViewer(["/images/ready.svg", "/images/slow.svg", "/images/latest.svg"]));
      await page.waitForFunction(() => document.querySelector(".media-viewer-stage").dataset.imageState === "ready");
      await page.locator(".media-viewer-nav.next").tap();
      await page.waitForFunction(() => document.querySelector(".media-viewer-count").textContent === "2 / 3");
      assert.deepEqual(await snapshot(page), { state: "loading", busy: "true", image: "/images/slow.svg", visible: "hidden", count: "2 / 3" });
      assert.equal(await page.locator(".media-viewer-status").textContent(), "正在加载图片");
      await page.evaluate(() => { const image = document.querySelector(".media-viewer-stage img"); window.oldLoad = image.onload; window.oldError = image.onerror; });
      await page.locator(".media-viewer-nav.next").tap();
      await page.waitForFunction(() => document.querySelector(".media-viewer-count").textContent === "3 / 3");
      await page.waitForFunction(() => document.querySelector(".media-viewer-stage").dataset.imageState === "ready");
      await page.evaluate(() => oldError());
      assert.equal((await snapshot(page)).state, "ready");
      await page.evaluate(() => oldLoad());
      assert.equal((await snapshot(page)).state, "ready");
      assert.equal((await snapshot(page)).image, "/images/latest.svg");
      assert.equal(await page.locator(".media-viewer-feedback").isVisible(), false);
      release();
    } finally { release(); await page.close(); }
  });
  await run("failed images can be retried by touch at the same position without closing the viewer", async () => {
    const page = await newPage();
    let succeeds = false, requests = 0;
    await page.route("**/images/retry.svg", route => { requests++; return route.fulfill(succeeds ? { contentType: "image/svg+xml", body: svg("#38806a") } : { status: 503, body: "synthetic offline" }); });
    try {
      await page.evaluate(() => openViewer(["/images/retry.svg"]));
      await page.locator(".media-viewer-retry").waitFor({ state: "visible" });
      assert.equal((await snapshot(page)).state, "error");
      assert.equal((await snapshot(page)).visible, "hidden");
      assert.equal((await snapshot(page)).busy, "false");
      for (const viewport of [{ width: 320, height: 568 }, { width: 844, height: 390 }]) {
        await page.setViewportSize(viewport);
        const box = await page.locator(".media-viewer-retry").boundingBox();
        assert(box.height >= 44 && box.x >= 0 && box.x + box.width <= viewport.width);
        assert(box.y >= 0 && box.y + box.height <= viewport.height);
      }
      if (process.env.FANHAO_VIEWER_SCREENSHOT) await page.screenshot({ path: process.env.FANHAO_VIEWER_SCREENSHOT });
      succeeds = true;
      await page.locator(".media-viewer-retry").tap();
      await page.waitForFunction(() => document.querySelector(".media-viewer-stage").dataset.imageState === "ready");
      assert.equal(requests, 2);
      assert.equal((await snapshot(page)).count, "1 / 1");
      assert.equal(await page.locator(".media-viewer-feedback").isVisible(), false);
      assert.equal(await page.locator(".media-viewer").isVisible(), true);
    } finally { await page.close(); }
  });
  await run("closing and reopening detaches old callbacks; swiping and Escape still work", async () => {
    const page = await newPage();
    try {
      await page.evaluate(() => { document.getElementById("trigger").focus(); openViewer(["/images/first.svg"]); window.closedCallback = document.querySelector(".media-viewer-stage img").onerror; viewer.close(); openViewer(["/images/new.svg", "/images/last.svg"]); });
      await page.waitForFunction(() => document.querySelector(".media-viewer-stage").dataset.imageState === "ready");
      await page.evaluate(() => closedCallback());
      assert.equal((await snapshot(page)).state, "ready");
      const touch = await page.context().newCDPSession(page);
      await touch.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: 280, y: 200 }] });
      await touch.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: 100, y: 200 }] });
      await touch.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
      await touch.detach();
      assert.equal((await snapshot(page)).count, "2 / 2");
      await page.keyboard.press("Escape");
      assert.equal(await page.locator(".media-viewer").count(), 0);
      assert.equal(await page.evaluate(() => document.activeElement?.id), "trigger");
      assert.equal(await page.evaluate(() => document.body.classList.contains("media-viewer-open")), false);
    } finally { await page.close(); }
  });
  await run("empty-alt image triggers have accessible names, open by Enter or Space and regain focus after closing", async () => {
    const page = await newPage();
    const avatars = [
      { id: "named-avatar", title: "  合成人物甲  ", name: "查看图片：合成人物甲" },
      { id: "untitled-avatar", title: "", name: "查看图片" }
    ];
    try {
      await page.evaluate(avatars => {
        for (const avatar of avatars) {
          const image = document.createElement("img"), url = `/images/${avatar.id}.svg`;
          image.id = avatar.id; image.alt = ""; image.src = url; image.width = 64; image.height = 64;
          document.body.append(image);
          viewer.bindImageTrigger(image, url, avatar.title);
        }
      }, avatars);
      for (const avatar of avatars) {
        const trigger = page.getByRole("button", { name: avatar.name, exact: true });
        assert.equal(await trigger.count(), 1, "the real browser exposes the bound image by its accessible name");
        assert.equal(await trigger.getAttribute("id"), avatar.id);
        assert.equal(await trigger.getAttribute("alt"), "");
        for (const key of ["Enter", "Space"]) {
          await trigger.focus(); await page.keyboard.press(key);
          await page.getByRole("dialog", { name: "图片预览", exact: true }).waitFor();
          await page.waitForFunction(() => document.querySelector(".media-viewer-stage")?.dataset.imageState === "ready");
          assert.equal(await page.locator(".media-viewer").count(), 1);
          assert.equal((await snapshot(page)).image, `/images/${avatar.id}.svg`);
          await page.getByRole("button", { name: "关闭", exact: true }).click();
          assert.equal(await page.locator(".media-viewer").count(), 0);
          assert.equal(await page.evaluate(id => document.activeElement === document.getElementById(id), avatar.id), true,
            `${key} preview closing returns focus to its original image`);
        }
      }
    } finally { await page.close(); }
  });
  assert.deepEqual(faults, []);
  assert.deepEqual(unexpected, []);
  console.log(`Android media viewer: ${checks} browser cases PASS`);
} finally {
  if (browser) await browser.close();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
