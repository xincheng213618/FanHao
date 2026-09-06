import assert from "node:assert/strict";
import { indexedDB } from "fake-indexeddb";
import { createRankingViews } from "../android-client/www/modules/fanhao/features/rankings/ranking-views.js";
import { createFavoriteFolderFeature } from "../android-client/www/modules/fanhao/features/works/favorite-folders.js";
import { setAccountOwner } from "../android-client/www/js/account-owner.js";
import { readCachedJson } from "../android-client/www/js/cache.js";

// Production controllers, fetchJson and cache modules; only HTTP, DOM sinks and
// IndexedDB are synthetic. No browser, native service or real library is used.
globalThis.window = globalThis;
globalThis.indexedDB = indexedDB;
Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
  getItem: () => null, setItem() {}
} });
const networks = new Map();
globalThis.fetch = (input, options) => {
  const url = new URL(input);
  const network = networks.get(url.origin);
  assert(network, `unexpected network origin: ${url.origin}`);
  return network(url, options);
};

const tick = () => new Promise(resolve => setImmediate(resolve));
async function until(check, message) {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 1));
  }
  assert.fail(message);
}
function deferred() {
  let resolve;
  const promise = new Promise(yes => { resolve = yes; });
  return { promise, resolve };
}
const topPath = key => `/api/rankings/top?${new URLSearchParams({ key, limit: "48", offset: "0" })}`;
const top = (key, name) => ({ key, total: 1, localTotal: 1, works: [{
  id: key, favorite: true, favoriteFolderId: "later", favoriteFolderName: name
}] });

function harness(name, keys = ["y2025", "y2024"]) {
  const origin = `http://${name}.fixture`;
  setAccountOwner(origin, "account:alpha");
  const calls = [];
  const rendered = [];
  let folderName = "旧收藏夹";
  const folder = () => ({ id: "later", name: folderName, count: 1, createdAt: "2026-01-01" });
  const folders = () => [{ id: "default", name: "默认收藏", count: 0, createdAt: "2026-01-01" }, folder()];
  const response = payload => new Response(JSON.stringify(payload), { status: 200, headers: {
    "Content-Type": "application/json", "X-FanHao-Account-Owner": "account:alpha"
  } });
  networks.set(origin, (url, options = {}) => {
    if (url.pathname === "/api/favorite-folders/later" && options.method === "PATCH") {
      folderName = JSON.parse(options.body).name;
      return Promise.resolve(response({ ok: true, folder: folder(), folders: folders() }));
    }
    if (url.pathname === "/api/favorite-folders") return Promise.resolve(response({ folders: folders() }));
    assert(["/api/rankings", "/api/rankings/top"].includes(url.pathname), `unexpected request: ${url}`);
    const pending = deferred();
    calls.push({ path: url.pathname, key: url.searchParams.get("key"), taken: false,
      reply(payload) { pending.resolve(response(payload)); } });
    return pending.promise;
  });
  const node = () => ({ textContent: "", innerHTML: "", setAttribute() {}, removeAttribute() {} });
  const controller = createRankingViews({
    els: { viewKicker: node(), viewTitle: node(), viewMeta: node(), viewContent: node(), rankingsCount: node() },
    getActiveUrl: () => origin, refreshChrome() {}, renderCurrentView() {}, renderCurrentViewPreservingScroll() {},
    renderMessage() {}, setActiveBottom() {}, renderWorks: works => rendered.push(structuredClone(works)),
    workListState: { getSortMode: () => "updated", getSortOptions: () => [], setSortMode() {} }
  });
  const favoriteFolders = createFavoriteFolderFeature({ getActiveUrl: () => origin });
  async function take(path, key = null) {
    let request;
    await until(() => {
      request = calls.find(call => !call.taken && call.path === path && call.key === key);
      return request;
    }, `missing ${name} request: ${path} ${key || ""}`);
    request.taken = true;
    return request;
  }
  const summary = marker => ({ marker, lists: keys.map(key => ({ key, label: key, total: 1, localTotal: 1 })) });
  async function cachedTop(key, expectedName) {
    await until(async () => (await readCachedJson(origin, topPath(key)))?.payload.works[0].favoriteFolderName === expectedName,
      `missing current ${key} cached folder name: ${expectedName}`);
    await tick();
  }
  return { origin, controller, rendered, take, summary, cachedTop,
    rename: value => favoriteFolders.renameFolder("later", value) };
}

{
  const h = harness("ranking-pending-write", ["y2025"]);
  const pending = h.controller.refreshRankingCache();
  const [summary, ranking] = await Promise.all([h.take("/api/rankings"), h.take("/api/rankings/top", "y2025")]);
  // Real folder mutation uses real scoped IndexedDB invalidation while both
  // controller requests still hold the pre-rename server snapshot.
  await h.rename("新收藏夹");
  summary.reply(h.summary("old"));
  ranking.reply(top("y2025", "旧收藏夹"));
  await pending;
  assert.equal(await readCachedJson(h.origin, "/api/rankings"), null,
    "fetchBundle must pass its request-start fence when the old summary arrives after rename");
  assert.equal(await readCachedJson(h.origin, topPath("y2025")), null,
    "fetchTop must pass its request-start fence when the old ranking arrives after rename");

  const fresh = h.controller.refreshRankingCache();
  (await h.take("/api/rankings")).reply(h.summary("new"));
  (await h.take("/api/rankings/top", "y2025")).reply(top("y2025", "新收藏夹"));
  await fresh;
  assert.equal((await readCachedJson(h.origin, "/api/rankings"))?.payload.marker, "new",
    "a new summary request remains cacheable after invalidation");
  await h.cachedTop("y2025", "新收藏夹");
}

{
  const h = harness("ranking-memory-invalidation");
  const render = h.controller.renderRankings();
  (await h.take("/api/rankings")).reply(h.summary("old"));
  (await h.take("/api/rankings/top", "y2025")).reply(top("y2025", "旧收藏夹"));
  await render;
  (await h.take("/api/rankings/top", "y2024")).reply(top("y2024", "旧收藏夹"));
  await h.cachedTop("y2024", "旧收藏夹");
  const beforeValid = h.rendered.length;
  assert.equal(h.controller.selectYear("y2024"), true);
  assert.equal(h.rendered.length, beforeValid + 1, "valid warmed data renders synchronously before its network refresh");
  (await h.take("/api/rankings/top", "y2024")).reply(top("y2024", "旧收藏夹"));
  await until(() => h.rendered.length === beforeValid + 2, "selected year did not finish its network refresh");

  await h.rename("新收藏夹");
  const afterRename = h.rendered.length;
  assert.equal(h.controller.selectYear("y2025"), true);
  const refreshed = await h.take("/api/rankings/top", "y2025");
  assert.equal(h.rendered.length, afterRename, "selectYear must not render an invalidated in-memory folder name");
  refreshed.reply(top("y2025", "新收藏夹"));
  await until(() => h.rendered.length === afterRename + 1, "selected year did not render its new folder name");
  // The warmer must refetch the other invalidated year instead of treating its
  // old Map entry as a cache hit.
  (await h.take("/api/rankings/top", "y2024")).reply(top("y2024", "新收藏夹"));
  await h.cachedTop("y2024", "新收藏夹");
  assert.equal(h.controller.selectYear("y2024"), true);
  assert.equal(h.rendered.at(-1)[0].favoriteFolderName, "新收藏夹");
  (await h.take("/api/rankings/top", "y2024")).reply(top("y2024", "新收藏夹"));
  await until(() => h.rendered.length === afterRename + 3, "refreshed warmed year did not complete");
  assert(h.rendered.slice(afterRename).every(works => works[0].favoriteFolderName === "新收藏夹"),
    "neither selection nor warm reuse can render an old name after invalidation");
}

{
  const h = harness("ranking-late-memory");
  const render = h.controller.renderRankings();
  const [summary, ranking] = await Promise.all([h.take("/api/rankings"), h.take("/api/rankings/top", "y2025")]);
  await h.rename("新收藏夹");
  summary.reply(h.summary("old"));
  ranking.reply(top("y2025", "旧收藏夹"));
  await render;
  (await h.take("/api/rankings/top", "y2024")).reply(top("y2024", "新收藏夹"));
  await h.cachedTop("y2024", "新收藏夹");
  assert.equal(h.controller.selectYear("y2024"), true);
  (await h.take("/api/rankings/top", "y2024")).reply(top("y2024", "新收藏夹"));
  const warming = await h.take("/api/rankings/top", "y2025");
  const beforeSelect = h.rendered.length;
  assert.equal(h.controller.selectYear("y2025"), true);
  const selected = await h.take("/api/rankings/top", "y2025");
  assert.equal(h.rendered.length, beforeSelect,
    "data received after invalidation retains its original fence when stored in memory");
  warming.reply(top("y2025", "新收藏夹"));
  selected.reply(top("y2025", "新收藏夹"));
  await until(() => h.rendered.length === beforeSelect + 1, "late-data replacement did not render");
  assert.equal(h.rendered.at(-1)[0].favoriteFolderName, "新收藏夹");
}

console.log("android-ranking-cache-fence: passed (actual controllers, delayed summary/top writes, valid cache reuse, invalidated year selection/warming, late-response memory provenance)");
console.log("Boundary: synthetic HTTP/DOM and fake-indexeddb only; no real service, browser, account database or media was used.");
