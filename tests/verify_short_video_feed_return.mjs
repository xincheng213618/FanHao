import assert from "node:assert/strict";
import { createServer } from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const publicRoot = fileURLToPath(new URL("../public/", import.meta.url));
const executablePath = [
  process.env.CHROME_PATH,
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe"
].find(candidate => candidate && fs.existsSync(candidate));
assert(executablePath, "private Chromium fixture requires Chrome or Edge");

const coverUrl = "/fixture-cover.svg";
const count = 144;
const pageSize = 48;
const feedReads = [];
const unexpected = [];

function video(index) {
  return {
    id: `fixture-${index}`, title: `Synthetic post ${index}`,
    author: { name: "Synthetic author", secUid: "fixture-author" }, coverUrl,
    mediaType: "gallery", galleryItems: [{ type: "image", url: coverUrl }],
    stats: {}, actions: {}
  };
}

function api(url, method) {
  if (method === "PUT" && /^\/api\/short-videos\/fixture-\d+\/watch$/.test(url.pathname)) return { ok: true };
  assert.equal(method, "GET");
  if (url.pathname === "/api/modules") return { modules: [] };
  if (url.pathname === "/api/short-videos/collections") return { collections: [] };
  if (url.pathname === "/api/short-videos/summary") return { totals: {}, authors: [], sources: [] };
  if (url.pathname === "/api/short-videos/authors") return { authors: [], total: 0, hasMore: false };
  if (url.pathname === "/api/short-videos/authors/resolve") return { author: video(0).author };
  if (url.pathname === "/api/short-videos") {
    const offset = Number(url.searchParams.get("cursor") || url.searchParams.get("offset") || 0);
    feedReads.push({ offset, query: url.searchParams.get("q") || "", author: url.searchParams.get("author") || "" });
    const end = Math.min(count, offset + pageSize);
    return {
      videos: Array.from({ length: end - offset }, (_, i) => video(offset + i)),
      total: count, hasMore: end < count, nextCursor: end < count ? String(end) : null
    };
  }
  const detail = url.pathname.match(/^\/api\/short-videos\/fixture-(\d+)(\/adjacent)?$/);
  assert(detail, `unexpected private API ${url.pathname}`);
  const index = Number(detail[1]);
  const previous = index > 0 ? video(index - 1) : null;
  const next = index < count - 1 ? video(index + 1) : null;
  if (detail[2]) return { video: url.searchParams.get("direction") === "prev" ? previous : next };
  return { video: video(index), prevId: previous?.id || "", nextId: next?.id || "", prevVideo: previous, nextVideo: next };
}

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url, "http://fixture");
    const send = (body, type) => {
      response.writeHead(200, { "Content-Type": type, "Cache-Control": "no-store" });
      response.end(body);
    };
    if (url.pathname.startsWith("/api/")) return send(JSON.stringify(api(url, request.method)), "application/json");
    if (url.pathname === "/fixture-cover.svg") {
      return send('<svg xmlns="http://www.w3.org/2000/svg" width="240" height="320"><rect width="240" height="320" fill="#718d86"/></svg>', "image/svg+xml");
    }
    if (url.pathname === "/favicon.ico") {
      response.writeHead(204);
      response.end();
      return;
    }
    const pathname = url.pathname.startsWith("/short-videos") ? "/index.html" : url.pathname;
    const file = path.resolve(publicRoot, `.${pathname}`);
    assert(file.startsWith(publicRoot), "private static request stays under public");
    const type = { ".css": "text/css", ".html": "text/html", ".js": "text/javascript", ".svg": "image/svg+xml" };
    return send(await fs.promises.readFile(file), type[path.extname(file)] || "application/octet-stream");
  } catch (error) {
    unexpected.push(`${request.method} ${request.url}: ${error.message}`);
    if (!response.destroyed) {
      response.writeHead(500);
      response.end(error.message);
    }
  }
});

function cardSelector(id) {
  return `.short-video-card[data-video-id="${id}"]`;
}

async function openDeepCard(page) {
  await page.locator(".short-video-home .short-video-card").first().waitFor();
  await page.waitForFunction(last => {
    const end = document.documentElement.scrollHeight - innerHeight;
    if (scrollY < end - 1) window.scrollTo({ top: end, behavior: "instant" });
    return document.querySelector(`.short-video-home [data-video-id="fixture-${last}"]`);
  }, count - 1, { timeout: 8000 });
  await page.evaluate(() => window.scrollTo({ top: Math.round(scrollY * 0.68), behavior: "instant" }));
  const selected = await page.waitForFunction(first => {
    return [...document.querySelectorAll(".short-video-home .short-video-card")].find(item => {
      const rect = item.getBoundingClientRect();
      return Number(item.dataset.videoId.replace("fixture-", "")) >= first && rect.top > 0 && rect.top < innerHeight - 40;
    })?.dataset.videoId;
  }, pageSize, { timeout: 4000 });
  const id = await selected.jsonValue();
  assert(id, "opened a visible card past the first loaded page");
  const button = page.locator(`${cardSelector(id)} .short-video-thumb-open`);
  await button.evaluate(element => element.focus({ preventScroll: true }));
  const position = await button.evaluate(element => {
    const card = element.closest(".short-video-card");
    return { id: card.dataset.videoId, top: card.getBoundingClientRect().top, scroll: window.scrollY };
  });
  assert(position.scroll > 1000, "opened a deeply scrolled card");
  await page.keyboard.press("Enter");
  await page.waitForURL(new RegExp(`/short-videos/${position.id}(\\?|$)`));
  await page.getByRole("button", { name: "返回短视频列表" }).waitFor();
  return position;
}

async function checkPosition(page, position) {
  const button = page.locator(`${cardSelector(position.id)} .short-video-thumb-open`);
  const target = { selector: cardSelector(position.id), top: position.top };
  await page.waitForFunction(({ selector, top }) => {
    const card = document.querySelector(selector);
    return card && Math.abs(card.getBoundingClientRect().top - top) < 3
      && document.activeElement === card.querySelector(".short-video-thumb-open");
  }, target, { timeout: 4000 }).catch(async error => {
    const found = await page.evaluate(selector => ({
      url: location.href, scrollY, state: history.state,
      top: document.querySelector(selector)?.getBoundingClientRect().top,
      focus: document.activeElement?.closest(".short-video-card")?.dataset.videoId
    }), target.selector);
    throw new Error(`Feed position mismatch ${JSON.stringify({ position, found, feedReads, unexpected })}`, { cause: error });
  });
  assert(await button.evaluate(element => document.activeElement === element));
}

let browser;
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
try {
  const origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ executablePath, headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.on("pageerror", error => unexpected.push(error.message));
  await page.route("**/*", route => route.request().url().startsWith(`${origin}/`) ? route.continue() : route.abort());
  await page.goto(`${origin}/short-videos?q=fixture`);
  const position = await openDeepCard(page);
  const viewerHistoryLength = await page.evaluate(() => history.length);
  const listReads = () => feedReads.filter(request => request.offset === 0).length;
  const firstPageReads = listReads();
  await page.keyboard.press("ArrowDown");
  const nextId = `fixture-${Number(position.id.replace("fixture-", "")) + 1}`;
  await page.waitForURL(new RegExp(`/short-videos/${nextId}(\\?|$)`));
  await page.getByRole("button", { name: "返回短视频列表" }).click();
  await page.waitForURL(`${origin}/short-videos?q=fixture`);
  await checkPosition(page, position);
  assert.equal(await page.evaluate(() => history.length), viewerHistoryLength, "viewer Back uses the original list entry");
  assert.equal(listReads(), firstPageReads, "viewer Back retains loaded pages");
  await page.goForward();
  await page.waitForURL(new RegExp(`/short-videos/${nextId}(\\?|$)`));
  await page.getByRole("button", { name: "返回短视频列表" }).waitFor();
  await page.setViewportSize({ width: 1600, height: 900 });
  await page.goBack();
  await checkPosition(page, position);
  assert.equal(listReads(), firstPageReads, "browser Back retains loaded pages at the new viewport width");

  await page.goto(`${origin}/short-videos/authors/fixture-author?source=all`);
  const authorPosition = await openDeepCard(page);
  const authorReads = listReads();
  await page.goBack();
  await checkPosition(page, authorPosition);
  await page.goForward();
  await page.getByRole("button", { name: "返回短视频列表" }).click();
  await checkPosition(page, authorPosition);
  assert.equal(listReads(), authorReads, "author feed survives Back and Forward without a first-page reload");
  assert.deepEqual(unexpected, []);
  console.log("Short video feed return restores paged search and author lists, keyboard focus, and position after a viewport change.");
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
}
