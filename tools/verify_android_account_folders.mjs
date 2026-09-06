import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright-core";
import { indexedDB } from "fake-indexeddb";
import { createFavoriteFolderFeature } from "../android-client/www/modules/fanhao/features/works/favorite-folders.js";
import { captureAccountOwner, setAccountOwner } from "../android-client/www/js/account-owner.js";
import * as cache from "../android-client/www/js/cache.js";
import { createAccountLibraryFixture } from "./fixtures/account-library.mjs";

globalThis.window = globalThis;
globalThis.indexedDB = indexedDB;
Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem: () => null, setItem() {} } });
const tick = () => new Promise(resolve => setImmediate(resolve));
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
const folder = (id, name, count = 0) => ({ id, name, count, createdAt: "2026-01-01" });
const defaults = count => folder("default", "默认收藏", count);

{
  const origin = "http://folder-order.fixture";
  setAccountOwner(origin, "account:alpha");
  let current = [defaults(0), folder("later", "稍后看", 1)];
  const moving = deferred(); const deleting = deferred(); const oldList = deferred(); const calls = [];
  let staleList = true;
  const feature = createFavoriteFolderFeature({ getActiveUrl: () => origin, clearCachedJsonByPrefix: async () => {}, api: async (_base, pathname, options) => {
    if (pathname === "/api/favorite-folders" && !options.method) { if (staleList) { staleList = false; return oldList.promise; } return { folders: structuredClone(current) }; }
    calls.push([options.method, pathname]);
    if (options.method === "DELETE") { const result = await deleting.promise; current = result.folders; return result; }
    if (options.method === "POST" && pathname === "/api/favorite-folders") { current = [...current, folder("later", options.body.name)]; return { folder: current.at(-1), folders: structuredClone(current) }; }
    return moving.promise;
  } });
  feature.rememberFolders(current);
  const watched = { id: "101", favorite: true, favoriteFolderId: "later", favoriteFolderName: "稍后看" };
  feature.rememberWorks([watched]);
  const stale = feature.loadFolders(true);
  const first = feature.toggleFavorite({ id: "102", favorite: false });
  const remove = feature.deleteFolder("later");
  await tick(); assert.deepEqual(calls, [["POST", "/api/favorites/102"]], "folder deletion waits for prior work mutations");
  moving.resolve({ favorite: true, favoriteFolder: { folderId: "default", folderName: "默认收藏" }, folders: [defaults(1), folder("later", "稍后看", 1)] });
  await first; await tick(); assert.equal(calls.at(-1)[0], "DELETE");
  deleting.resolve({ deletedFolderId: "later", movedCount: 1, defaultFolder: defaults(2), folders: [defaults(2)] });
  await remove;
  oldList.resolve({ folders: [defaults(0), folder("later", "旧响应", 1)] }); await stale; await tick();
  assert.deepEqual(feature.folders().map(value => value.id), ["default"], "older list cannot resurrect deleted folder");
  assert.equal(watched.favorite, true); assert.equal(watched.favoriteFolderId, "default");
  assert.equal(watched.favoriteFolderName, "默认收藏");
  await feature.createFolder("稍后看");
  assert.equal(feature.folders().find(value => value.id === "later")?.name, "稍后看", "recreating a name may legitimately reuse its folder ID");
  assert.throws(() => feature.deleteFolder("default"), /默认/);
  assert.throws(() => feature.renameFolder("default", "new"), /默认/);
  await assert.rejects(feature.renameFolder("later", "  "), /请输入/);
}

{
  const origin = "http://folder-renames.fixture";
  setAccountOwner(origin, "account:alpha");
  const first = deferred(); const second = deferred(); let requests = 0;
  let current = [defaults(0), folder("later", "旧名", 1)];
  const feature = createFavoriteFolderFeature({ getActiveUrl: () => origin, clearCachedJsonByPrefix: async () => {}, api: async (_base, pathname, options) => {
    if (!options.method) return { folders: current };
    requests += 1;
    const result = await (requests === 1 ? first.promise : second.promise); current = result.folders; return result;
  } });
  feature.rememberFolders(current);
  const work = { id: "101", favorite: true, favoriteFolderId: "later", favoriteFolderName: "旧名" }; feature.rememberWorks([work]);
  const one = feature.renameFolder("later", "中间名"); const two = feature.renameFolder("later", "最后名");
  await tick(); assert.equal(requests, 1, "structural changes serialize even across different controls");
  first.resolve({ folder: folder("later", "中间名", 1), folders: [defaults(0), folder("later", "中间名", 1)] }); await one; await tick();
  second.resolve({ folder: folder("later", "最后名", 1), folders: [defaults(0), folder("later", "最后名", 1)] }); await two;
  assert.equal(work.favoriteFolderName, "最后名");
  assert.equal(feature.folders().find(value => value.id === "later").name, "最后名");
}

{
  let origin = "http://folder-switch.fixture";
  setAccountOwner(origin, "account:alpha");
  const clearing = deferred(); let clears = 0;
  const workA = { id: "101", favorite: true, favoriteFolderId: "later", favoriteFolderName: "甲的夹" };
  const workB = { id: "101", favorite: true, favoriteFolderId: "later", favoriteFolderName: "乙的夹" };
  let library = { works: [workA] };
  const feature = createFavoriteFolderFeature({ getActiveUrl: () => origin, getLibrary: () => library,
    clearCachedJsonByPrefix: async () => { clears += 1; return clearing.promise; }, api: async (_base, _pathname, options) => options.method
      ? { folder: folder("later", "甲的新名"), folders: [defaults(0), folder("later", "甲的新名")] } : { folders: [defaults(0)] } });
  const rename = feature.renameFolder("later", "甲的新名"); await tick(); assert.equal(clears, 1);
  setAccountOwner(origin, "account:beta"); library = { works: [workB] }; feature.reset();
  clearing.resolve(); await assert.rejects(rename, { code: "ACCOUNT_CHANGED" });
  assert.equal(clears, 1, "cache invalidation stops across an awaited account switch");
  assert.equal(workB.favoriteFolderName, "乙的夹"); assert.deepEqual(feature.folders(), []);
}

{
  for (const method of ["toggle", "move"]) {
    const serverA = `http://folder-${method}-rollback-a.fixture`; const serverB = `http://folder-${method}-rollback-b.fixture`;
    let origin = serverA; const response = deferred(); const callbacks = [];
    const original = { id: "101", favorite: method === "move", favoriteFolderId: method === "move" ? "default" : "", favoriteFolderName: method === "move" ? "默认收藏" : "" };
    const oldWork = { ...original }; const currentWork = { id: "101", favorite: true, favoriteFolderId: "beta", favoriteFolderName: "乙的夹" };
    let library = { works: [oldWork] };
    const feature = createFavoriteFolderFeature({ getActiveUrl: () => origin, getLibrary: () => library, clearCachedJsonByPrefix: async () => {}, api: async () => response.promise });
    feature.rememberFolders([defaults(1), folder("later", "稍后看")]);
    const operation = method === "toggle" ? feature.toggleFavorite(oldWork, () => callbacks.push(origin)) : feature.moveFavorite(oldWork, "later", () => callbacks.push(origin));
    await tick(); origin = serverB; library = { works: [currentWork] };
    if (method === "toggle") response.resolve({ favorite: true, favoriteFolder: { folderId: "default", folderName: "默认收藏" }, folders: [defaults(1)] });
    else response.reject(new Error("A move failed"));
    await assert.rejects(operation, method === "toggle" ? /服务器已切换/ : /A move failed/);
    assert.deepEqual(oldWork, original, `${method}: switching servers must restore the original passed object`);
    assert.deepEqual(currentWork, { id: "101", favorite: true, favoriteFolderId: "beta", favoriteFolderName: "乙的夹" });
    assert.deepEqual(callbacks, [serverA], `${method}: old operations must not notify the new server's view`);
  }
}

{
  for (const method of ["toggle", "move"]) for (const settleNewFirst of [false, true]) {
    const origin = `http://folder-${method}-reused-${settleNewFirst}.fixture`;
    setAccountOwner(origin, "account:alpha");
    const oldResponse = deferred(); const newResponse = deferred();
    const feature = createFavoriteFolderFeature({ getActiveUrl: () => origin, clearCachedJsonByPrefix: async () => {}, api: async (_base, _path, options) => {
      if (!options.method) return { folders: [defaults(0), folder("beta", "乙的夹", 1)] };
      return options.accountScope.owner === "account:alpha" ? oldResponse.promise : newResponse.promise;
    } });
    feature.rememberFolders([defaults(1), folder("later", "甲的夹")]);
    const work = { id: "101", favorite: true, favoriteFolderId: "default", favoriteFolderName: "默认收藏" };
    const oldOperation = method === "toggle" ? feature.toggleFavorite(work) : feature.moveFavorite(work, "later"); await tick();
    setAccountOwner(origin, "account:beta"); feature.reset();
    Object.assign(work, { favorite: true, favoriteFolderId: "default", favoriteFolderName: "乙的默认" });
    feature.rememberFolders([defaults(0), folder("beta", "乙的夹", 1)]);
    const newOperation = feature.moveFavorite(work, "beta"); await tick();
    const newResult = { favorite: { folderId: "beta", folderName: "乙的夹" }, folders: [defaults(0), folder("beta", "乙的夹", 1)] };
    if (settleNewFirst) { newResponse.resolve(newResult); await newOperation; }
    oldResponse.resolve({ favorite: true, favoriteFolder: { folderId: "later", folderName: "甲的夹" }, folders: [defaults(0), folder("later", "甲的夹", 1)] });
    await assert.rejects(oldOperation, { code: "ACCOUNT_CHANGED" });
    assert.deepEqual(work, { id: "101", favorite: true, favoriteFolderId: "beta", favoriteFolderName: "乙的夹" }, `${method}: an old rollback must preserve a reused object's ${settleNewFirst ? "completed" : "pending"} new operation`);
    if (!settleNewFirst) { newResponse.resolve(newResult); await newOperation; }
  }
}

{
  const origin = "http://folder-queued-rollback.fixture"; const failures = [deferred(), deferred()]; let requests = 0;
  const feature = createFavoriteFolderFeature({ getActiveUrl: () => origin, clearCachedJsonByPrefix: async () => {}, api: async (_base, _path, options) => {
    if (!options.method) return { folders: [defaults(1), folder("one", "一"), folder("two", "二")] };
    return failures[requests++].promise;
  } });
  feature.rememberFolders([defaults(1), folder("one", "一"), folder("two", "二")]);
  const work = { id: "101", favorite: true, favoriteFolderId: "default", favoriteFolderName: "默认收藏" };
  const first = assert.rejects(feature.moveFavorite(work, "one"), /first failed/);
  const second = assert.rejects(feature.moveFavorite(work, "two"), /second failed/);
  await tick(); assert.equal(requests, 1); failures[0].reject(new Error("first failed")); await first; await tick();
  assert.equal(requests, 2); failures[1].reject(new Error("second failed")); await second;
  assert.deepEqual(work, { id: "101", favorite: true, favoriteFolderId: "default", favoriteFolderName: "默认收藏" }, "serialized failed moves must capture the restored previous snapshot");
}

{
  for (const method of ["toggle", "move"]) for (const change of ["navigate", "account", "reuse"]) {
    const serverA = `http://folder-cache-${method}-${change}-a.fixture`; const serverB = `http://folder-cache-${method}-${change}-b.fixture`;
    setAccountOwner(serverA, "account:alpha"); setAccountOwner(serverB, "account:beta");
    let origin = serverA; const release = deferred(); const clears = [];
    const work = { id: "101", favorite: method === "move", favoriteFolderId: "default", favoriteFolderName: "默认收藏" };
    const feature = createFavoriteFolderFeature({ getActiveUrl: () => origin,
      clearCachedJsonByPrefix: async (baseUrl, prefix, options) => { clears.push([baseUrl, prefix, options.accountScope.owner]); if (clears.length === 1) await release.promise; },
      api: async (_base, _path, options) => !options.method ? { folders: [] } : method === "toggle"
        ? { favorite: true, favoriteFolder: { folderId: "default", folderName: "默认收藏" }, folders: [defaults(1)] }
        : { favorite: { folderId: "later", folderName: "稍后看" }, folders: [defaults(0), folder("later", "稍后看", 1)] }
    });
    feature.rememberFolders([defaults(1), folder("later", "稍后看")]);
    const operation = method === "toggle" ? feature.toggleFavorite(work) : feature.moveFavorite(work, "later"); await tick();
    assert.equal(clears.length, 1); origin = serverB;
    if (change === "account") setAccountOwner(serverA, "account:gamma");
    if (change === "reuse") { Object.assign(work, { favorite: false, favoriteFolderId: "beta", favoriteFolderName: "乙的夹" }); feature.rememberWorks([work]); }
    release.resolve();
    if (change === "navigate") { await operation; assert.equal(clears.length, 3); assert.equal(work.favorite, true); }
    else { await assert.rejects(operation, { code: "ACCOUNT_CHANGED" }); assert.equal(clears.length, 1); }
    if (change === "reuse") assert.deepEqual(work, { id: "101", favorite: false, favoriteFolderId: "beta", favoriteFolderName: "乙的夹" });
    assert(clears.every(([baseUrl, _prefix, owner]) => baseUrl === serverA && owner === "account:alpha"), "accepted work cleanup must stay on its original server and account");
  }
}

{
  const origin = "http://folder-refresh-switch.fixture";
  setAccountOwner(origin, "account:alpha");
  const oldRefresh = deferred(); const newRename = deferred(); let alphaReads = 0; let betaReads = 0;
  const feature = createFavoriteFolderFeature({ getActiveUrl: () => origin, clearCachedJsonByPrefix: async () => {}, api: async (_base, _pathname, options) => {
    const alpha = options.accountScope.owner === "account:alpha";
    if (!options.method) {
      if (alpha) { alphaReads += 1; return oldRefresh.promise; }
      betaReads += 1;
      return { folders: [defaults(0), folder("later", "乙的权威名称", 1)] };
    }
    if (!alpha) return newRename.promise;
    return { folder: folder("later", "甲的新名", 1), folders: [defaults(0), folder("later", "甲的新名", 1)] };
  } });
  await feature.renameFolder("later", "甲的新名"); await tick(); assert.equal(alphaReads, 1);
  setAccountOwner(origin, "account:beta"); feature.reset();
  const rename = feature.renameFolder("later", "乙的新名"); await tick();
  oldRefresh.resolve({ folders: [defaults(0), folder("later", "甲的迟到名称", 1)] }); await tick();
  newRename.resolve({ folder: folder("later", "乙的新名", 1), folders: [defaults(0), folder("later", "乙的新名", 1)] });
  await rename; await tick();
  assert.equal(betaReads, 1, "an old account refresh failure must not suppress the new account's authoritative refresh");
  assert.equal(feature.folders().find(value => value.id === "later").name, "乙的权威名称");
}

{
  const origin = "http://folder-cache.fixture";
  setAccountOwner(origin, "account:alpha");
  await cache.writeCachedJson(origin, "/api/favorites", { owner: "alpha" }, { fence: cache.captureCachedJsonFence(origin) });
  const scopeA = captureAccountOwner(origin);
  setAccountOwner(origin, "account:beta");
  await cache.writeCachedJson(origin, "/api/favorites", { owner: "beta" }, { fence: cache.captureCachedJsonFence(origin) });
  await cache.clearCachedJsonByPrefix(origin, "/api/favorites", { accountScope: scopeA });
  assert.equal((await cache.readCachedJson(origin, "/api/favorites")).payload.owner, "beta");
  setAccountOwner(origin, "account:alpha");
  const clear = cache.clearCachedJsonByPrefix(origin, "/api/favorites", { accountScope: captureAccountOwner(origin) });
  setAccountOwner(origin, "account:beta"); await clear;
  assert.equal((await cache.readCachedJson(origin, "/api/favorites")).payload.owner, "beta", "an IndexedDB wait cannot clear the next account");
}
console.log("android-account-folders-state: passed (operation ordering, delete/recreate, object updates, account switch, refresh isolation and scoped cache cleanup)");
if (process.env.FANHAO_FOLDER_STATE_ONLY === "1") process.exit(0);

const executablePath = [process.env.CHROME_PATH, "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe", "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe"].find(file => file && fs.existsSync(file));
assert(executablePath);
const fixture = createAccountLibraryFixture(); const origin = await fixture.listen();
const browser = await chromium.launch({ executablePath, headless: true });
const output = path.resolve(".codex-artifacts/accounts"); fs.mkdirSync(output, { recursive: true });
let token = "";
async function api(pathname, method = "GET", body) {
  const response = await fetch(origin + pathname, { method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { "Content-Type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const data = await response.json(); assert(response.ok, JSON.stringify(data)); return data;
}
try {
  const account = await api("/api/accounts/register", "POST", { username: "folder-owner", password: "Folder-fixture-123", client: "android" }); token = account.token;
  const later = (await api("/api/favorite-folders", "POST", { name: "稍后再看" })).folder;
  await api("/api/favorite-folders", "POST", { name: "重名测试" });
  await api("/api/favorites/101", "POST", {});
  await api("/api/favorites/101/folder", "PUT", { folderId: later.id });
  const page = await browser.newPage({ viewport: { width: 412, height: 915 } }); const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.route(origin + "/android/**", async route => {
    const relative = new URL(route.request().url()).pathname.slice("/android/".length); const root = path.resolve("android-client/www"); const file = path.resolve(root, relative);
    if (!file.startsWith(root + path.sep) || !fs.existsSync(file)) return route.abort();
    await route.fulfill({ contentType: file.endsWith(".css") ? "text/css; charset=utf-8" : "text/javascript; charset=utf-8", body: fs.readFileSync(file) });
  });
  await page.route(origin + "/android-folder-fixture", route => route.fulfill({ contentType: "text/html; charset=utf-8", body: `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>收藏夹管理</title><link rel="stylesheet" href="/android/styles.css"><link rel="stylesheet" href="/android/modules/fanhao/styles.css"><body style="padding:18px;background:var(--surface)"><main><small id="kicker"></small><h1 id="title"></h1><p id="meta"></p><div id="content"></div></main><script type="module" src="/android-folder-fixture.js"></script></body></html>` }));
  await page.route(origin + "/android-folder-fixture.js", route => route.fulfill({ contentType: "text/javascript; charset=utf-8", body: `
    import { createFavoriteWorkViews } from '/android/modules/fanhao/features/works/favorite-page.js';
    import { createWorkPageDataService } from '/android/modules/fanhao/features/works/page-data-service.js';
    import { fetchJson } from '/android/js/api.js'; import * as cache from '/android/js/cache.js'; import { setAccountOwner } from '/android/js/account-owner.js';
    setAccountOwner(location.origin, ${JSON.stringify(`account:${account.user.id}`)});
    const original=fetch.bind(window); window.fetch=(input,options={})=>original(input,{...options,headers:{...options.headers,Authorization:${JSON.stringify(`Bearer ${token}`)}}});
    let params={favorite:'1',folder:${JSON.stringify(later.id)}}; let revision=0; let currentWorks=[];
    const els={viewKicker:document.querySelector('#kicker'),viewTitle:document.querySelector('#title'),viewMeta:document.querySelector('#meta'),viewContent:document.querySelector('#content')};
    const pageDataService=createWorkPageDataService({fetchJson,readCachedJson:cache.readCachedJson,writeCachedJson:cache.writeCachedJson});
    function render(){const expected=++revision; return views.render(params,()=>expected===revision);}
    const views=createFavoriteWorkViews({els,pageDataService,getActiveUrl:()=>location.origin,getLibrary:()=>({works:currentWorks}),getWorksLimit:()=>48,
      renderCurrentView:render,replaceViewParams:(_view,next)=>{params=next;},showView:(_view,next)=>{params=next;return render();},setActiveBottom(){},onUserStateChange(){},
      renderMessage:(message)=>{els.viewMeta.textContent=message;},workDataSignature:JSON.stringify,serverContinuationOptions:()=>({}),
      renderWorks(works,empty){currentWorks=works;const list=document.createElement('div');list.className='account-folder-fixture-works';for(const work of works){const row=document.createElement('p');row.textContent=work.title+' · '+work.favoriteFolderName;list.append(row);}if(!works.length)list.textContent=empty;els.viewContent.append(list);}});
    window.folderFixture={views,getParams:()=>params,getWorks:()=>currentWorks,render};await render();` }));
  await page.goto(origin + "/android-folder-fixture");
  await page.getByText("ABC-101 · 稍后再看", { exact: true }).waitFor();
  await page.getByRole("button", { name: "管理收藏夹", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "管理收藏夹", exact: true });
  await dialog.getByLabel("收藏夹新名称").waitFor();
  assert.equal(await dialog.getByRole("button", { name: /默认收藏.*不可改名或删除/ }).isDisabled(), true);
  await dialog.getByLabel("收藏夹新名称").fill("重名测试"); await dialog.getByRole("button", { name: "保存名称" }).click();
  await dialog.getByText(/已存在/).waitFor();
  await dialog.getByLabel("收藏夹新名称").fill("周末清单"); await dialog.getByRole("button", { name: "保存名称" }).click();
  await dialog.waitFor({ state: "hidden" }); await page.getByText("ABC-101 · 周末清单", { exact: true }).waitFor();
  await page.getByRole("button", { name: "管理收藏夹", exact: true }).click();
  await dialog.getByRole("button", { name: "删除收藏夹", exact: true }).click();
  await dialog.getByText("删除“周末清单”？其中 1 个收藏会移回默认收藏，不会取消收藏。", { exact: true }).waitFor();
  await page.screenshot({ path: path.join(output, "android-folder-delete-confirm.png"), fullPage: true });
  await dialog.getByRole("button", { name: "取消", exact: true }).click();
  assert.equal((await api("/api/favorite-folders")).folders.some(value => value.id === later.id), true);
  await dialog.getByRole("button", { name: "删除收藏夹", exact: true }).click(); await dialog.getByRole("button", { name: "确认删除并移回默认" }).click();
  await dialog.waitFor({ state: "hidden" }); await page.getByText("ABC-101 · 默认收藏", { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => folderFixture.getParams().folder), "default");
  assert.equal(await page.evaluate(() => folderFixture.getWorks()[0].favorite), true);
  assert.equal((await api("/api/favorite-folders")).folders.some(value => value.id === later.id), false);
  await page.screenshot({ path: path.join(output, "android-folder-moved-default.png"), fullPage: true });
  await page.getByRole("button", { name: "新建收藏夹" }).click();
  const create = page.getByRole("dialog", { name: "新建收藏夹", exact: true });
  await create.getByLabel("收藏夹名称", { exact: true }).fill("稍后再看"); await create.getByRole("button", { name: "新建", exact: true }).click();
  await create.waitFor({ state: "hidden" }); await page.getByRole("button", { name: "稍后再看，0 个作品", exact: true }).waitFor();
  const cacheResults = await page.evaluate(async () => {
    const [{ createFavoriteFolderFeature }, { createWorkActions }, cache, owner] = await Promise.all([
      import('/android/modules/fanhao/features/works/favorite-folders.js'), import('/android/modules/fanhao/features/works/actions.js'),
      import('/android/js/cache.js'), import('/android/js/account-owner.js')
    ]);
    const wait = () => new Promise(resolve => setTimeout(resolve, 0));
    const until = async predicate => { for (let n = 0; n < 100; n += 1) { const value = await predicate(); if (value) return value; await wait(); } throw new Error('action cache fixture timed out'); };
    const results = [];
    for (const change of ['navigate', 'account', 'reuse-during', 'reuse-after']) {
      const scopeA = `http://action-${change}-a.fixture`; const scopeB = `http://action-${change}-b.fixture`; const pathname = '/api/works/shared';
      owner.setAccountOwner(scopeA, 'account:alpha'); owner.setAccountOwner(scopeB, 'account:beta');
      let activeUrl = scopeA; let enter; let release;
      const entered = new Promise(resolve => { enter = resolve; }); const held = new Promise(resolve => { release = resolve; });
      const messages = []; let clears = 0;
      const work = { id: 'shared', favorite: false, title: 'A title', infoSummary: { description: 'A metadata' } };
      const sentinel = { sentinel: 'B unchanged', work: { id: 'shared', favorite: false, title: 'B cached' } };
      await cache.writeCachedJson(scopeB, pathname, sentinel, { fence: cache.captureCachedJsonFence(scopeB) });
      const feature = createFavoriteFolderFeature({ getActiveUrl: () => activeUrl, getLibrary: () => ({ works: [work] }),
        api: async (_base, path) => path === '/api/favorite-folders' ? { folders: [] }
          : { favorite: true, favoriteFolder: { folderId: 'a-default', folderName: 'A folder' }, folders: [] },
        clearCachedJsonByPrefix: async (base, prefix, options) => { if (clears++ === 0) { enter(); await held; } return cache.clearCachedJsonByPrefix(base, prefix, options); }
      });
      const reuse = () => { activeUrl = scopeB; work.title = 'B live title'; work.infoSummary.description = 'B live metadata'; work.favorite = false; work.favoriteFolderId = 'b-only'; feature.rememberWorks([work]); };
      const actions = createWorkActions({ getActiveUrl: () => activeUrl, favoriteFolders: change === 'reuse-after'
        ? { toggleFavorite: async (...args) => { const data = await feature.toggleFavorite(...args); reuse(); return data; } } : feature,
        detailErrorMessage: error => error.message, extractWorkCode: () => '', formatNumber: String, renderMessage: message => messages.push(message), renderWorkDetail() {} });
      const row = actions.createActionRow(work); document.body.append(row); const button = row.querySelector('.favorite-action'); button.click();
      await entered;
      if (change !== 'reuse-after') activeUrl = scopeB;
      if (change === 'reuse-during') reuse();
      if (change === 'account') {
        owner.setAccountOwner(scopeA, 'account:gamma');
        await cache.writeCachedJson(scopeA, pathname, { sentinel: 'new account unchanged' }, { fence: cache.captureCachedJsonFence(scopeA) });
      }
      release(); await until(() => !button.classList.contains('pending'));
      const succeeds = change === 'navigate' || change === 'reuse-after';
      const entryA = succeeds ? await until(async () => { const entry = await cache.readCachedJson(scopeA, pathname); return entry?.payload?.work?.favorite ? entry : null; }) : await cache.readCachedJson(scopeA, pathname);
      const entryB = await cache.readCachedJson(scopeB, pathname);
      results.push({ change, a: entryA?.payload ?? null, b: entryB?.payload, sentinel, messages }); row.remove();
    }
    return results;
  });
  for (const result of cacheResults) {
    assert.deepEqual(result.b, result.sentinel, `${result.change}: an old action cannot modify B's same-ID detail cache`);
    if (result.change === 'navigate' || result.change === 'reuse-after') {
      assert.equal(result.a.work.favorite, true); assert.equal(result.a.work.favoriteFolderId, 'a-default');
      assert.equal(result.a.work.title, 'A title'); assert.equal(result.a.work.infoSummary.description, 'A metadata');
      assert.deepEqual(result.messages, []);
    } else if (result.change === 'account') assert.deepEqual(result.a, { sentinel: 'new account unchanged' });
    else assert.equal(result.a, null);
  }
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  assert.deepEqual(errors, []);
  console.log("android-account-folders-browser: passed (management drawer, rename/delete/default migration/recreation, captured-server action cache and account/object reuse fences)");
} finally { await browser.close(); await fixture.close(); }
