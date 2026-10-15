import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { webcrypto } from "node:crypto";
import { indexedDB } from "fake-indexeddb";
import { chromium } from "playwright-core";
import { createAccountLibraryFixture } from "./fixtures/account-library.mjs";
import * as owner from "../android-client/www/js/account-owner.js";
import * as cache from "../android-client/www/js/cache.js";
import { fetchJson } from "../android-client/www/js/api.js";
import { createWorkPageDataService } from "../android-client/www/modules/fanhao/features/works/page-data-service.js";
import { createFavoriteFolderFeature } from "../android-client/www/modules/fanhao/features/works/favorite-folders.js";

globalThis.window = globalThis;
globalThis.indexedDB = indexedDB;
const saved = new Map();
Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
  getItem: key => saved.get(key) ?? null, setItem: (key, value) => saved.set(key, String(value)), removeItem: key => saved.delete(key)
} });
const base = "http://personal-cache.fixture";
const tick = () => new Promise(resolve => setImmediate(resolve));
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }

const appSource = fs.readFileSync(new URL("../android-client/www/app.js", import.meta.url), "utf8");
const listenerSource = appSource.slice(appSource.indexOf("let accountReloadPending ="), appSource.indexOf("let connectionAttempt ="));
function accountPage() {
  const listeners = {}; const calls = { reload: 0, load: 0, render: 0 };
  const env = { URL, activeUrl: base, library: null, libraryLoadGeneration: 0, libraryLoadPromise: null, workViews: null, androidModuleRegistry: {},
    window: { addEventListener: (name, fn) => { listeners[name] = fn; }, location: { reload: () => { calls.reload += 1; } } },
    document: { querySelectorAll: () => [] }, els: Object.fromEntries(["viewContent", "personPreview", "continuePreview"].map(key => [key, { replaceChildren() {} }])),
    invalidateViewRender() {}, renderUserState() {}, queueMicrotask: fn => fn(), loadDashboard: () => { calls.load += 1; }, renderCurrentView: () => { calls.render += 1; } };
  vm.runInNewContext(listenerSource, env);
  return { calls, change: value => listeners.fanhaoAccountOwnerChanged({ detail: { current: { origin: base, owner: value } } }),
    confirm: value => listeners.fanhaoAccountOwnerConfirmed({ detail: { origin: base, owner: value } }) };
}
const coldPage = accountPage(); coldPage.change("pending"); coldPage.change("account:alpha");
assert.equal(coldPage.calls.reload, 0, "initial owner confirmation never loops the WebView when token digests are unavailable");
assert.equal(coldPage.calls.load, 1);
coldPage.confirm("account:alpha"); coldPage.change("pending"); coldPage.change("account:beta");
assert.equal(coldPage.calls.reload, 1, "switching a page that displayed the old account discards all module closures");

await cache.writeCachedJson(base, "/api/favorites", { works: [{ id: "guest", favorite: true }] });
owner.setAccountOwner(base, "account:alpha");
assert.equal(await cache.readCachedJson(base, "/api/favorites"), null, "new account never inherits legacy guest rows");
const alpha = owner.captureAccountOwner(base);
const alphaPayload = owner.rememberAccountPayload({ works: [{ id: "alpha", favorite: true }] }, alpha);
await cache.writeCachedJson(base, "/api/favorites", alphaPayload);
const alphaFence = cache.captureCachedJsonFence(base);
owner.setAccountOwner(base, "account:beta");
assert.equal(await cache.readCachedJson(base, "/api/favorites"), null);
assert.equal(await cache.writeCachedJson(base, "/api/favorites", alphaPayload), null, "late network payload keeps its original owner");
assert.equal(await cache.writeCachedJson(base, "/api/favorites", alphaPayload, { fence: cache.captureCachedJsonFence(base) }), null, "a newer explicit fence cannot relabel a tagged old response");
assert.equal(await cache.writeCachedJson(base, "/api/works/alpha", { work: alphaPayload.works[0] }, { fence: alphaFence }), null, "rewrapped work uses the captured owner fence");
owner.setAccountOwner(base, "account:alpha");
assert.equal((await cache.readCachedJson(base, "/api/favorites")).payload.works[0].id, "alpha");
owner.setAccountOwner(base, "guest");
assert.equal((await cache.readCachedJson(base, "/api/favorites")).payload.works[0].id, "guest");
await cache.writeCachedImage(base + "/cover", new Blob(["shared-image"]), { baseUrl: base });
owner.setAccountOwner(base, "account:beta");
assert.equal((await cache.readCachedImage(base + "/cover")).blob.size, 12, "media cache stays shared");

const digestBase = "http://digest-failure.fixture";
saved.set("fanhao.android.accountOwner.v1:" + digestBase, JSON.stringify({ owner: "account:alpha", tag: "old-tag" }));
await cache.writeCachedJson(digestBase, "/api/favorites", { works: [{ id: "alpha" }] }, { fence: cache.captureCachedJsonFence(digestBase) });
const digest = deferred();
Object.defineProperty(globalThis, "crypto", { configurable: true, value: { subtle: { digest: () => digest.promise } } });
owner.registerAccountSessionResolver(url => owner.synchronizeAccountToken(url, "usr.new-session"));
const first = owner.prepareAccountOwner(digestBase);
let secondFinished = false;
const second = owner.prepareAccountOwner(digestBase).finally(() => { secondFinished = true; });
await tick(); assert.equal(secondFinished, false, "concurrent owner checks await the same digest");
digest.reject(new Error("digest unavailable"));
await Promise.all([assert.rejects(first, /digest unavailable/), assert.rejects(second, /digest unavailable/)]);
assert.equal(owner.captureAccountOwner(digestBase).owner, "pending");
assert.equal((await owner.prepareAccountOwner(digestBase)).owner, "pending");
assert.equal(await cache.readCachedJson(digestBase, "/api/favorites"), null, "failed digest retry cannot expose the old account cache");
Object.defineProperty(globalThis, "crypto", { configurable: true, value: webcrypto });
owner.registerAccountSessionResolver(null);
owner.registerAccountSessionResolver(() => new Promise(() => {}));
await assert.rejects(fetchJson("http://localhost", "/api/favorites", { timeoutMs: 15 }), /请求超时/);
await assert.rejects(owner.prepareAccountOwner(base, { timeoutMs: 15 }), { name: "AbortError" });
owner.registerAccountSessionResolver(null);

owner.setAccountOwner(base, "account:alpha");
const delayed = deferred(); let sends = 0;
const previousFetch = globalThis.fetch;
globalThis.fetch = async (_url, options) => { sends += 1; assert.equal(options.headers["X-FanHao-Account-Owner"], "account:alpha"); return delayed.promise; };
const oldRequest = fetchJson(base, "/api/favorites");
await tick(); owner.setAccountOwner(base, "account:beta");
delayed.resolve(new Response(JSON.stringify({ works: [{ id: "alpha" }] }), { headers: { "Content-Type": "application/json", "X-FanHao-Account-Owner": "account:alpha" } }));
await assert.rejects(oldRequest, { code: "ACCOUNT_CHANGED" });
assert.equal(sends, 1);
globalThis.fetch = previousFetch;

owner.setAccountOwner(base, "account:alpha");
const warmed = deferred(); let writes = 0;
const pages = createWorkPageDataService({ fetchJson: () => warmed.promise, writeCachedJson: async () => { writes += 1; } });
const warming = pages.warm(base, ["/api/works"]);
await tick(); owner.setAccountOwner(base, "account:beta");
warmed.resolve({ works: [{ id: "alpha" }] }); await warming;
assert.equal(writes, 0, "old in-flight warm cannot write under another owner");

owner.setAccountOwner(base, "account:alpha");
const mutation = deferred(); let mutations = 0;
const folders = createFavoriteFolderFeature({ getActiveUrl: () => base, clearCachedJsonByPrefix: async () => {}, api: async (_base, pathname) => {
  if (pathname === "/api/favorite-folders") return { folders: [] };
  mutations += 1; return mutation.promise;
} });
const item = { id: "101", favorite: false };
const firstMutation = folders.toggleFavorite(item);
const queuedMutation = folders.toggleFavorite(item);
await tick(); owner.setAccountOwner(base, "account:beta");
mutation.resolve({ favorite: true, folders: [] });
await Promise.all([assert.rejects(firstMutation, { code: "ACCOUNT_CHANGED" }), assert.rejects(queuedMutation, { code: "ACCOUNT_CHANGED" })]);
assert.equal(mutations, 1, "queued interaction is not submitted as the next account");
console.log("personal-client-state: passed (guest/account cache, late writes, digest failure/concurrency, warm results, queued favorites)");
if (process.env.FANHAO_PERSONAL_STATE_ONLY === "1") process.exit(0);

const executablePath = [process.env.CHROME_PATH, "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe", "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe"].find(file => file && fs.existsSync(file));
assert(executablePath, "Chrome or Edge is required");
const fixture = createAccountLibraryFixture();
const origin = await fixture.listen();
const browser = await chromium.launch({ executablePath, headless: true });
const output = path.resolve(".codex-artifacts/accounts"); fs.mkdirSync(output, { recursive: true });
const errors = [];
const password = "Personal-fixture-pass-123";
async function request(endpoint, body) {
  const response = await fetch(origin + endpoint, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  assert(response.ok, await response.clone().text()); return response.json();
}
async function routeAssets(page) {
  await page.route(origin + "/android/**", async route => {
    const relative = new URL(route.request().url()).pathname.slice("/android/".length);
    const root = path.resolve("android-client/www"); const file = path.resolve(root, relative);
    if (!file.startsWith(root + path.sep) || !fs.existsSync(file)) return route.abort();
    await route.fulfill({ contentType: file.endsWith(".css") ? "text/css" : "text/javascript", body: fs.readFileSync(file) });
  });
  page.on("pageerror", error => errors.push(error.message));
}
async function signIn(page, username) {
  await page.getByLabel("用户名", { exact: true }).fill(username);
  await page.getByLabel("密码", { exact: true }).fill(password);
  await page.getByRole("button", { name: "登录", exact: true }).last().click();
  await page.getByRole("button", { name: "保存资料", exact: true }).waitFor();
  await page.waitForFunction(() => !document.querySelector(".account-ui")?.hasAttribute("aria-busy"));
}
async function logout(page) {
  await page.getByRole("button", { name: "退出登录", exact: true }).click();
  await page.getByLabel("用户名", { exact: true }).waitFor();
  await page.waitForFunction(() => !document.querySelector(".account-ui")?.hasAttribute("aria-busy"));
}
try {
  await request("/api/accounts/register", { username: "alpha", password, displayName: "账号甲" });
  await request("/api/accounts/register", { username: "beta", password, displayName: "账号乙" });
  const phone = await browser.newPage({ viewport: { width: 412, height: 940 } }); await routeAssets(phone);
  await phone.route(origin + "/personal-android-fixture", route => route.fulfill({ contentType: "text/html", body: `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Account isolation fixture</title><link rel="stylesheet" href="/android/platform/accounts/account.css"><body style="margin:16px;background:#f4f6f3"><div id="root" class="account-ui account-embedded"></div><section class="account-ui"><div class="account-card"><h2>番号收藏</h2><p id="personal">正在读取</p></div></section><script type="module" src="/personal-android-fixture.js"></script></body></html>` }));
  await phone.route(origin + "/personal-android-fixture.js", route => route.fulfill({ contentType: "text/javascript", body: `
    import { createAccountSettings } from '/android/js/account-settings.js';
    import { installServerAuthentication } from '/android/js/server-auth.js';
    import { fetchJson } from '/android/js/api.js';
    import * as cache from '/android/js/cache.js';
    import * as owner from '/android/js/account-owner.js';
    const original=fetch.bind(window); let token=sessionStorage.getItem('fixture-native-session')||'';
    async function login(fields) { const response=await original('/api/accounts/login',{method:'POST',credentials:'omit',headers:{'Content-Type':'application/json'},body:JSON.stringify({...fields,client:'android'})}); const payload=await response.json(); if(!response.ok)throw Error(payload.error); token=payload.token; sessionStorage.setItem('fixture-native-session',token); return payload; }
    window.Capacitor={Plugins:{FanHaoAuth:{getSession:async()=>({token}),loginAccount:login,clearSession:async()=>{token='';sessionStorage.removeItem('fixture-native-session');}}}};
    installServerAuthentication(()=>location.origin);
    async function refresh(){ const data=await fetchJson(location.origin,'/api/favorites'); await cache.writeCachedJson(location.origin,'/api/favorites',data); document.querySelector('#personal').textContent=data.works.length ? data.works.map(work=>work.title).join('、') : '当前账号暂无收藏'; return data; }
    window.personal={fetchJson,cache,owner,refresh}; createAccountSettings(document.querySelector('#root'),{serverUrl:location.origin,onSignedIn:refresh,onSignedOut:refresh}); await refresh();` }));
  await phone.goto(origin + "/personal-android-fixture");
  await phone.getByText("ABC-101", { exact: true }).waitFor();
  await signIn(phone, "alpha"); await phone.getByText("当前账号暂无收藏", { exact: true }).waitFor();
  await phone.evaluate(async () => { await personal.fetchJson(location.origin, "/api/favorites/102", { method: "POST", body: {} }); await personal.fetchJson(location.origin, "/api/progress/v102", { method: "POST", body: { workId: "102", position: 45, duration: 120 } }); await personal.refresh(); });
  await phone.getByText("ABC-102", { exact: true }).waitFor();
  await phone.screenshot({ path: path.join(output, "android-account-alpha-personal.png"), fullPage: true });
  await logout(phone); await signIn(phone, "beta");
  await phone.getByText("当前账号暂无收藏", { exact: true }).waitFor();
  assert.equal(await phone.evaluate(async () => (await personal.fetchJson(location.origin, "/api/history")).works.length), 0);
  assert.equal(await phone.evaluate(async () => (await personal.cache.readCachedJson(location.origin, "/api/favorites")).payload.works.length), 0);
  await phone.screenshot({ path: path.join(output, "android-account-beta-personal.png"), fullPage: true });
  await logout(phone); await signIn(phone, "alpha"); await phone.getByText("ABC-102", { exact: true }).waitFor();
  assert.equal(await phone.evaluate(async () => (await personal.fetchJson(location.origin, "/api/history")).works[0].id), "102");
  await phone.reload(); await phone.getByRole("button", { name: "保存资料" }).waitFor(); await phone.getByText("ABC-102", { exact: true }).waitFor();
  assert.match(await phone.evaluate(() => personal.owner.captureAccountOwner(location.origin).owner), /^account:/, "native session digest restores same owner after cold start");

  const context = await browser.newContext(); const accountA = await context.newPage(); const accountB = await context.newPage();
  accountA.on("pageerror", error => errors.push(error.message)); accountB.on("pageerror", error => errors.push(error.message));
  await accountA.goto(origin + "/account"); await signIn(accountA, "alpha");
  await accountB.goto(origin + "/account"); await accountB.getByRole("button", { name: "保存资料" }).waitFor();
  await logout(accountB); await signIn(accountB, "beta");
  await accountA.getByText("@beta · 普通用户", { exact: true }).waitFor();
  assert.equal(await accountA.getByLabel("昵称", { exact: true }).inputValue(), "账号乙", "old account center refreshes before it can edit the next account");
  await accountA.bringToFront();
  await accountA.waitForFunction(() => !document.querySelector(".account-ui")?.hasAttribute("aria-busy"));
  await accountA.screenshot({ path: path.join(output, "web-account-switch-refresh.png"), fullPage: true });
  assert.deepEqual(errors, []);
  console.log("personal-client-browser: passed (actual account adapter + favorite/history HTTP + offline cache + cold restart + Web account tab switch)");
} finally { await browser.close(); await fixture.close(); }
