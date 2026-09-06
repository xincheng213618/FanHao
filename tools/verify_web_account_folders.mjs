import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright-core";
import { createAccountLibraryFixture } from "./fixtures/account-library.mjs";

const executablePath = [process.env.CHROME_PATH, "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe"].find(file => file && fs.existsSync(file));
assert(executablePath, "Chrome or Edge is required for Web folder verification");
const fixture = createAccountLibraryFixture();
const origin = await fixture.listen();
const browser = await chromium.launch({ executablePath, headless: true });
const errors = [];
const output = path.resolve(".codex-artifacts/accounts");
fs.mkdirSync(output, { recursive: true });
const html = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>个人收藏夹验证</title><link rel="stylesheet" href="/styles.css"><body>
<main style="padding:32px;max-width:1000px;margin:auto"><h1>我的收藏</h1><p>登录后，收藏夹与观看记录按账号保存。</p>
<h2 id="heading"></h2><p id="subtitle"></p><div id="stats"></div><div id="works" class="work-grid"></div></main>
<script type="module" src="/folder-fixture.js"></script></body></html>`;
const script = `
import { createCollectionPage } from '/modules/fanhao/features/collections/collection-page.js';
import { createApiClient } from '/js/api.js';
const state = { activeView:'favorites', selectedFavoriteFolderId:'all', favoriteFolders:[], works:[], library:{works:[]} };
const els = { statsRow:document.querySelector('#stats'), workGrid:document.querySelector('#works') };
const realApi = createApiClient();
let readHold = null;
const api = async (path, options) => {
  const hold = readHold; if (hold && path.startsWith('/api/favorites?')) readHold = null;
  const payload = await realApi(path, options);
  if (hold) { hold.enter(); await hold.promise; }
  return payload;
};
function renderWorks() {
  els.workGrid.replaceChildren(...state.works.map(work => {
    const item=document.createElement('article'); item.className='fixture-work';
    item.style.cssText='border:1px solid var(--line);border-radius:12px;padding:24px;margin-top:20px';
    item.textContent=work.title+' · '+work.favoriteFolderName; return item;
  }));
}
const page = createCollectionPage({api,els,state,formatNumber:String, hidePersonProfile(){},resetWorkPaging(){},
  renderEmpty:message=>{els.workGrid.textContent=message;},renderStatsForWorks:()=>els.statsRow.replaceChildren(),
  renderWorks,appendLoadedWorkPage:renderWorks,
  setMainHeader:(title,subtitle)=>{document.querySelector('#heading').textContent=title;document.querySelector('#subtitle').textContent=subtitle;}
});
window.folderFixture={state,page,api,holdNextRead(){let release,enter;const promise=new Promise(r=>release=r);const entered=new Promise(r=>enter=r);readHold={promise,enter};return {release,entered};}};
await page.loadFavorites(); window.fixtureReady = true;`;

async function api(endpoint, { token, body, method = body ? "POST" : "GET" } = {}) {
  const response = await fetch(origin + endpoint, { method, headers: {
    ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { "Content-Type": "application/json" } : {})
  }, body: body ? JSON.stringify(body) : undefined });
  const payload = await response.json();
  assert(response.ok, JSON.stringify(payload));
  return payload;
}
async function register(username) {
  return api("/api/accounts/register", { body: { username, password: "Folders-fixture-pass-123", client: "android" } });
}
async function mount(context) {
  const page = await context.newPage();
  page.on("pageerror", error => errors.push(error.message));
  await page.route(origin + "/**", async route => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === "/folder-fixture") return route.fulfill({ contentType: "text/html; charset=utf-8", body: html });
    if (pathname === "/folder-fixture.js") return route.fulfill({ contentType: "text/javascript", body: script });
    if (pathname.endsWith(".js") || pathname.endsWith(".css")) {
      const root = path.resolve("public");
      const file = path.resolve(root, "." + pathname);
      if (!file.startsWith(root + path.sep) || !fs.existsSync(file)) return route.abort();
      return route.fulfill({ contentType: pathname.endsWith(".css") ? "text/css" : "text/javascript", body: fs.readFileSync(file) });
    }
    return route.continue();
  });
  await page.goto(origin + "/folder-fixture");
  await page.waitForFunction(() => window.fixtureReady);
  return page;
}
async function ready(page) {
  await page.waitForFunction(() => !document.querySelector('button[data-folder-mutation="create"]')?.disabled);
}
async function select(page, name) {
  await page.getByRole("button", { name: new RegExp(`^${name} \\d+$`) }).click();
  await page.waitForFunction(name => document.querySelector('#subtitle').textContent.startsWith(name + ' · '), name);
}
async function promptRename(page, name) {
  page.once("dialog", dialog => dialog.accept(name));
  await page.locator('[data-folder-mutation="rename"]').click();
}

try {
  const alpha = await register("folder_alpha"), beta = await register("folder_beta");
  const source = (await api("/api/favorite-folders", { token: alpha.token, body: { name: "待观看" } })).folder;
  const sameIdBeta = (await api("/api/favorite-folders", { token: beta.token, body: { name: "待观看" } })).folder;
  assert.equal(source.id, sameIdBeta.id, "fixture makes equal folder IDs in separate accounts");
  await api("/api/favorites/101", { token: alpha.token, body: { folderId: source.id } });
  await api("/api/favorites/102", { token: beta.token, body: { folderId: source.id } });
  await api("/api/favorite-folders", { token: alpha.token, body: { name: "已看" } });
  const context = await browser.newContext({ viewport: { width: 1180, height: 780 } });
  await context.addCookies([{ name: "fanhao_web_auth", value: alpha.token, url: origin }]);
  const page = await mount(context);
  assert.equal(await page.locator('[data-folder-mutation="delete"]').count(), 0, "all folders has no delete action");
  await select(page, "默认收藏");
  assert.equal(await page.locator('[data-folder-mutation="rename"]').count(), 0, "default folder cannot be renamed");
  await select(page, "待观看");
  await page.evaluate(async () => {
    folderFixture.state.library.works = structuredClone(folderFixture.state.works);
    folderFixture.state.currentWork = structuredClone(folderFixture.state.works[0]);
    await folderFixture.page.prefetch('favorites');
  });
  await promptRename(page, "周末观看");
  await ready(page);
  assert.match(await page.locator('#subtitle').textContent(), /^周末观看/);
  assert.match(await page.locator('.fixture-work').textContent(), /周末观看/);
  assert.equal(await page.evaluate(() => folderFixture.state.currentWork.favoriteFolderName), "周末观看");
  assert.equal(await page.evaluate(() => folderFixture.state.library.works[0].favoriteFolderName), "周末观看");
  assert.equal((await api("/api/favorite-folders", { token: beta.token })).folders.find(item => item.id === source.id).name, "待观看");
  await page.screenshot({ path: path.join(output, "web-personal-folders.png"), fullPage: true });

  // Server validation is surfaced without changing the current list.
  const dialogs = [];
  const duplicateDialog = dialog => { dialogs.push(dialog.message()); return dialog.type() === "prompt" ? dialog.accept("已看") : dialog.accept(); };
  page.on("dialog", duplicateDialog);
  await page.locator('[data-folder-mutation="rename"]').click();
  await ready(page);
  page.off("dialog", duplicateDialog);
  assert(dialogs.some(message => /已存在|重名/.test(message)), "duplicate rename displays the server error");
  assert.match(await page.locator('#subtitle').textContent(), /^周末观看/);

  // Cancelled deletion sends no mutation; successful deletion keeps the favorite.
  let deletes = 0;
  page.on("request", request => { if (request.method() === "DELETE") deletes += 1; });
  page.once("dialog", dialog => { assert.match(dialog.message(), /移回.*默认收藏/); return dialog.dismiss(); });
  await page.locator('[data-folder-mutation="delete"]').click();
  assert.equal(deletes, 0);
  page.once("dialog", dialog => dialog.accept());
  await page.locator('[data-folder-mutation="delete"]').click();
  await ready(page);
  assert.equal(deletes, 1);
  assert.match(await page.locator('#subtitle').textContent(), /^默认收藏/);
  assert.match(await page.locator('.fixture-work').textContent(), /ABC-101 · 默认收藏/);
  assert.equal((await api("/api/favorites", { token: alpha.token })).works.length, 1);
  assert.equal((await api("/api/favorites", { token: beta.token })).works[0].favoriteFolderId, source.id);
  assert.equal(await page.evaluate(() => folderFixture.state.currentWork.favoriteFolderId), "default");

  // A prefetched pre-mutation payload may complete late, but must not restore the deleted folder.
  page.once("dialog", dialog => dialog.accept("保留记录"));
  await page.locator('[data-folder-mutation="create"]').click();
  await ready(page);
  await select(page, "保留记录");
  await page.evaluate(async () => {
    const hold = folderFixture.holdNextRead(); window.releaseFolderRead = hold.release;
    folderFixture.page.invalidatePrefetches(); folderFixture.page.prefetch('favorites'); await hold.entered;
  });
  page.once("dialog", dialog => dialog.accept());
  await page.locator('[data-folder-mutation="delete"]').click();
  await ready(page);
  await page.evaluate(() => window.releaseFolderRead());
  await page.evaluate(() => folderFixture.page.loadFavorites());
  assert.equal(await page.getByRole("button", { name: /^保留记录 / }).count(), 0);

  // Account assertion rejects a stale page even when another login only changed the Cookie.
  await select(page, "已看");
  const betaFolder = (await api("/api/favorite-folders", { token: beta.token, body: { name: "已看" } })).folder;
  await context.addCookies([{ name: "fanhao_web_auth", value: beta.token, url: origin }]);
  page.once("dialog", dialog => dialog.accept());
  const rejected = page.waitForResponse(response => response.request().method() === "DELETE");
  await page.locator('[data-folder-mutation="delete"]').click();
  assert.equal((await rejected).status(), 409);
  await page.waitForLoadState("load");
  assert((await api("/api/favorite-folders", { token: beta.token })).folders.some(folder => folder.id === betaFolder.id));
  assert.deepEqual(errors, []);
  console.log("Web personal folders passed: rename/delete UI, account isolation, retained favorites, validation, stale prefetch and stale identity.");
} finally {
  await browser.close();
  await fixture.close();
}
