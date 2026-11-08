import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../public");
const modulePath = "/modules/fanhao/disk-usage/app.js";
const executablePath = [process.env.CHROME_PATH, "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe", "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe", "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe"].filter(Boolean).find(value => fs.existsSync(value));
assert(executablePath, "Chrome or Edge required for private disk usage fixture");

const drive = { id: "fixture", name: "Fixture", root: "Z:\\", capacity: { available: true, totalBytes: 10000000, freeBytes: 3000000 }, cache: { scanId: "fixture", completedAt: "2026-11-01" } };
const directory = { path: "Z:\\folder", name: "folder", size: 10000, isDirectory: true, parentPath: drive.root };
const subitems = ["alpha", "beta"].map(name => ({ path: `${directory.path}\\${name}.bin`, name, size: 5000, isDirectory: false }));
const children = [directory, ...Array.from({ length: 599 }, (_, index) => ({ path: `Z:\\item-${index}.bin`, name: `item-${index}.bin`, extension: ".bin", size: 10000, isDirectory: false }))];
const faults = [];
const server = createServer(async (req, res) => {
  const url = new URL(req.url, "http://fixture");
  const json = value => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(value)); };
  try {
    if (url.pathname === "/api/modules") return json({ modules: [] });
    if (url.pathname === "/api/disk-usage/summary") return json({ drives: [drive] });
    if (url.pathname === "/api/disk-usage/tree") return json(url.searchParams.get("path") === directory.path
      ? { path: directory.path, node: directory, cache: drive.cache, children: subitems }
      : { path: drive.root, node: { path: drive.root, size: 6000000 }, cache: drive.cache, children });
    if (url.pathname === "/api/disk-usage/search") return json({ items: children.slice(0, 120) });
    if (url.pathname === "/favicon.ico") { res.writeHead(204); res.end(); return; }
    assert(!url.pathname.startsWith("/api/"), `unmodelled fixture path ${url.pathname}`);
    const relative = url.pathname === "/disk-usage" ? "/modules/fanhao/disk-usage/index.html" : url.pathname;
    const file = path.resolve(root, `.${relative}`);
    assert(file.startsWith(`${root}${path.sep}`));
    const type = file.endsWith(".html") ? "text/html" : file.endsWith(".css") ? "text/css" : "text/javascript";
    let source = await fs.promises.readFile(file, "utf8");
    if (relative === modulePath) source += `\nwindow.__diskLinkCounts = () => {
      const groups = state.linkedElements instanceof Map ? [state.linkedElements] : Object.values(state.linkedElements);
      const elements = groups.flatMap(group => [...group.values()].flat());
      return { live: elements.filter(node => node.isConnected).length, detached: elements.filter(node => !node.isConnected).length };
    };`;
    res.writeHead(200, { "content-type": type, "cache-control": "no-store" }); res.end(source);
  } catch (error) { faults.push(error.message); if (!res.headersSent) res.writeHead(500); res.end(); }
});

await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
let browser;
try {
  browser = await chromium.launch({ executablePath, headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
  page.on("pageerror", error => faults.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}/disk-usage`);
  await page.waitForFunction(() => typeof window.__diskLinkCounts === "function" && document.querySelectorAll("#entryList .entry-row").length === 600);
  const initial = await page.evaluate(() => __diskLinkCounts());
  assert(initial.live >= 1000, "fixture must mount a large map as well as its directory list");

  const stableTabs = await page.evaluate(async () => {
    const map = document.querySelector("#treemap"), first = map.firstElementChild;
    const list = document.querySelector("#listViewTab"), tabs = document.querySelector("#mapViewTab");
    let created = 0;
    const count = records => { for (const record of records) created += record.addedNodes.length; };
    const observer = new MutationObserver(count);
    observer.observe(map, { childList: true });
    for (let i = 0; i < 6; i++) {
      list.click(); tabs.click();
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    }
    count(observer.takeRecords()); observer.disconnect();
    return { created, retained: first === map.firstElementChild, ...__diskLinkCounts() };
  });

  const focusedLink = await page.evaluate(() => {
    const tile = document.querySelector("#treemap .treemap-node"), row = document.querySelector("#entryList .entry-row");
    tile.focus({ preventScroll: true });
    return document.activeElement === tile && tile.classList.contains("is-linked") && row.classList.contains("is-linked");
  });
  for (const width of [1480, 1520, 1560, 1600]) {
    await page.evaluate(() => { window.__retiredTile = document.querySelector("#treemap .treemap-node"); });
    await page.setViewportSize({ width, height: 960 });
    await page.waitForFunction(() => !__retiredTile.isConnected && document.querySelector("#treemap .treemap-node"));
  }
  const resized = await page.evaluate(() => ({ ...__diskLinkCounts(), staleFocus: Boolean(document.querySelector(".is-linked")) }));

  for (const value of ["item-a", "item-b", "item-c"]) {
    await page.locator("#pathSearch").fill(value);
    await page.waitForFunction(() => document.querySelectorAll("#entryList .entry-row").length === 120);
    await page.locator("#pathSearch").fill("");
    await page.waitForFunction(() => document.querySelectorAll("#entryList .entry-row").length === 600);
  }
  const searched = await page.evaluate(() => __diskLinkCounts());
  await page.locator("#mapViewTab").click();
  const hover = await page.evaluate(() => {
    const map = document.querySelector("#treemap .treemap-node");
    const entry = [...document.querySelectorAll(".entry-row")].find(row => row.title === map.title.split("\n")[0]);
    const connection = Object.getOwnPropertyDescriptor(Node.prototype, "isConnected");
    let visited = 0;
    Object.defineProperty(Node.prototype, "isConnected", { ...connection, get() { visited++; return connection.get.call(this); } });
    try { map.dispatchEvent(new PointerEvent("pointerenter")); }
    finally { Object.defineProperty(Node.prototype, "isConnected", connection); }
    const linked = map.classList.contains("is-linked") && entry.classList.contains("is-linked");
    map.dispatchEvent(new PointerEvent("pointerleave"));
    const cleared = !map.classList.contains("is-linked") && !entry.classList.contains("is-linked");
    __retiredTile.dispatchEvent(new PointerEvent("pointerenter"));
    return { visited, linked, cleared, staleHighlight: entry.classList.contains("is-linked") };
  });

  await page.locator("#listViewTab").click();
  await page.locator("#entryList .entry-row").first().click();
  await page.waitForFunction(() => document.querySelectorAll("#entryList .entry-row").length === 2 && !document.querySelector("#treemap .treemap-node"));
  await page.locator("#mapViewTab").click();
  await page.waitForFunction(() => document.querySelectorAll("#treemap .treemap-node").length === 2);
  const directoryLinks = await page.evaluate(() => __diskLinkCounts());
  await page.locator("#upButton").click();
  await page.waitForFunction(() => document.querySelectorAll("#entryList .entry-row").length === 600 && document.querySelectorAll("#treemap .treemap-node").length === 600);
  const restoredLinks = await page.evaluate(() => __diskLinkCounts());

  console.log(`MEASURE disk usage Web: ${JSON.stringify({ initial, stableTabs, resized, searched, hover, directoryLinks, restoredLinks })}`);
  assert.deepEqual([stableTabs.created, stableTabs.retained], [0, true], "unchanged tab returns must retain the mounted treemap");
  assert.deepEqual([stableTabs.detached, resized.detached, searched.detached], [0, 0, 0], "linked paths must retain only mounted nodes");
  assert(hover.visited <= 3, "hover must not visit retired representations of a path");
  assert.deepEqual([hover.linked, hover.cleared, hover.staleHighlight], [true, true, false], "only a mounted path owner may highlight current counterparts");
  assert(focusedLink && !resized.staleFocus, "keyboard focus must link current representations and release them on redraw");
  assert.deepEqual(directoryLinks, { live: 4, detached: 0 }, "a folder change with the map hidden must retire the old representations");
  assert.deepEqual(restoredLinks, initial, "returning to the root must register only the current folder");
  assert.deepEqual(faults, []);
  console.log("Disk usage Web fixture passed (actual shell, private Chromium and synthetic tree/search)");
} finally {
  await browser?.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
}
