import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { routeLibraryReadApi } from "../src/modules/fanhao/server/library/routes.js";
import { sendJson, sendJsonParts } from "../src/platform/server/responses.js";

// Actual Android entry on private loopback. Only the API data and metrics are synthetic.
const project = fileURLToPath(new URL("../", import.meta.url));
const www = path.join(project, "android-client/www");
const previousApp = execFileSync("git", ["show", "f110040d02b1eb579461248da9960e97370fa4d2:android-client/www/app.js"], { cwd: project, encoding: "utf8" });
const executablePath = [process.env.CHROME_PATH, "C:/Program Files/Google/Chrome/Application/chrome.exe", "C:/Program Files/Microsoft/Edge/Application/msedge.exe"].filter(Boolean).find(fs.existsSync);
assert(executablePath, "installed private Chromium required");
const errors = [];
const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url, "http://fixture");
    if (url.pathname === "/favicon.ico") { response.writeHead(204); response.end(); return; }
    if (url.pathname.startsWith("/fixture-avatar/")) {
      response.writeHead(200, { "Content-Type": "image/svg+xml", "Cache-Control": "no-store" });
      response.end('<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"><rect width="4" height="4" fill="red"/></svg>');
      return;
    }
    if (url.pathname === "/api/library") {
      assert(await routeLibraryReadApi(request, response, url, conditionalLibraryDeps));
      return;
    }
    const filename = path.resolve(www, `.${url.pathname === "/" ? "/index.html" : url.pathname}`);
    assert(filename.startsWith(`${www}${path.sep}`));
    let source = fs.readFileSync(filename);
    if (url.pathname === "/app.js") {
      source = url.searchParams.get("v") === "fixture-previous" ? previousApp : source.toString("utf8");
      const marker = "function renderDashboard(data) {";
      assert.equal(source.split(marker).length, 2);
      source = source.replace(marker, `${marker}
  const start = performance.now();
  window.__dashboardPeopleRenders?.push(data.people);
  try { return measuredDashboard(data); }
  finally { window.__dashboardTimes.push(performance.now() - start); }
}
function measuredDashboard(data) {`);
      const home = "function showHome(options = {}) {";
      assert.equal(source.split(home).length, 2);
      source = source.replace(home, `${home}
  const start = performance.now();
  try { return measuredHome(options); }
  finally { window.__homeTimes.push(performance.now() - start); }
}
function measuredHome(options = {}) {`);
      const startup = "bootApp().catch((error) => {";
      assert.equal(source.split(startup).length, 2);
      source = source.replace(startup, `window.__dashboardProbe = { showView, loadDashboard, library: () => library,
  pending: () => libraryLoadPromise, moduleReady: (id) => Boolean(androidModuleRegistry?.get(id)) };
window.__dashboardProbe.boot = ${startup}`);
      const cacheWrite = "function scheduleLibraryCacheWrite(write) {";
      source = source.replace(cacheWrite, `${cacheWrite}
  const window = globalThis.__libraryWriteScheduler || globalThis;
  const document = globalThis.__libraryWriteDocument || globalThis.document;`);
    } else if (url.pathname === "/modules/fanhao/people-views.js") {
      source = source.toString("utf8");
      const marker = "  function sortPeople(a, b) {";
      assert.equal(source.split(marker).length, 2);
      source = source.replace(marker, `${marker}\n    window.__previewComparisons++;`);
      const card = 'button.className = mode === "preview" ? "person-card" : "index-person-card";';
      assert.equal(source.split(card).length, 2);
      source = source.replace(card, `${card}\n    if (mode === "preview") button.dataset.fixturePersonId = person.id;`);
    }
    const type = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" }[path.extname(filename)];
    response.writeHead(200, { "Content-Type": type || "text/plain", "Cache-Control": "no-store" });
    response.end(source);
  } catch (error) { errors.push(error.message); response.destroy(); }
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const size = 10000;
const people = Array.from({ length: size }, (_, index) => {
  const person = {
    id: `actor-${index}`, name: `合成人物 ${(index * 5381) % size}`,
    workCount: (index * 19) % 53, sourceCount: index % 7,
    isWestern: index % 19 === 0,
    actorProfile: { gender: index % 7 === 0 ? "male" : "female", avatarUrl: index % 6 === 0 ? "" : `/fixture-avatar/${index}` }
  };
  if (index < 18) {
    person.workCount = index < 6 ? 1000 - index : 900;
    person.sourceCount = 99;
    person.actorProfile.avatarUrl = `/fixture-avatar/${index}`;
    if (index >= 6) person.actorProfile.displayName = "同名演员";
  }
  return person;
});
const snapshot = (prefix = "") => ({
  people: prefix ? people.map(person => ({ ...person, name: prefix + person.name,
    actorProfile: { ...person.actorProfile, ...(person.actorProfile.displayName ? { displayName: prefix + person.actorProfile.displayName } : {}) } })) : people,
  works: [], totals: { people: people.length }, user: {}, availableRoots: [], access: { mode: "loopback" }
});
let conditionalFavoriteCount = 1;
const conditionalLibraryDeps = {
  library: { scannedAt: "android-conditional-fixture", availableRoots: [], totals: { works: 2 } },
  getLastScanError: () => null,
  peopleScopeService: { normalize: () => "main", cacheKey: () => "android-conditional-fixture", personMatches: (person) => person.isWestern },
  personListService: { mainLibraryPeople: () => people },
  publicPerson: (person) => ({ ...person, avatarUrl: person.actorProfile.avatarUrl }),
  userStateSummary: () => ({ favoriteCount: conditionalFavoriteCount }),
  appConfigService: { publicConfig: () => ({}) },
  requestAccess: () => ({ mode: "loopback" }),
  sendJson,
  sendJsonParts
};
let browser;

async function createDashboardContext() {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true });
  await context.addInitScript(() => {
    localStorage.setItem("fanhao.serverUrl", location.origin);
    window.__previewComparisons = 0;
    window.__dashboardTimes = [];
    window.__homeTimes = [];
  });
  return context;
}

async function observeLibraryPersistence(context, initiallyHidden = false) {
  await context.addInitScript((initiallyHidden) => {
    window.__dashboardPeopleRenders = [];
    window.__libraryGets = [];
    window.__libraryPuts = [];
    window.__librarySerializations = 0;
    window.__libraryRecordSummary = (entry) => ({ path: entry.path, bytes: entry.bytes, recordId: entry.recordId,
      people: entry.payload?.people?.length, snapshotRecordId: entry.payload?.snapshotRecordId,
      peopleRevision: entry.payload?.peopleRevision, version: entry.version,
      accessedAt: entry.accessedAt, updatedAt: entry.updatedAt });
    const get = IDBObjectStore.prototype.get;
    IDBObjectStore.prototype.get = function(key) {
      if (this.name === "responses" && typeof key === "string" && key.endsWith(" /api/library")) {
        const read = { mode: this.transaction.mode };
        window.__libraryGets.push(read);
        this.transaction.addEventListener("complete", () => { read.committed = true; }, { once: true });
      }
      return get.call(this, key);
    };
    const stringify = JSON.stringify;
    JSON.stringify = function(value, ...args) {
      if (value?.path === "/api/library" && Array.isArray(value.payload?.people)) window.__librarySerializations++;
      return stringify.call(this, value, ...args);
    };
    const put = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function(entry, ...args) {
      if (this.name === "responses" && entry?.path?.startsWith("/api/library")) {
        const write = window.__libraryRecordSummary(entry);
        window.__libraryPuts.push(write);
        this.transaction.addEventListener("complete", () => { write.committed = true; }, { once: true });
      }
      return put.call(this, entry, ...args);
    };

    // Only the cache-write helper uses this scheduler. The real browser and
    // app retain their normal paint, scrolling, network and database events.
    const frames = new Map(), timers = new Map();
    let id = 0;
    let hidden = initiallyHidden;
    const advance = (queue) => {
      for (const [key, { callback }] of [...queue]) if (queue.delete(key)) callback(performance.now());
    };
    window.__libraryWriteScheduler = {
      requestAnimationFrame(callback) { frames.set(++id, { callback }); return id; },
      cancelAnimationFrame(key) { frames.delete(key); },
      setTimeout(callback, delay) { timers.set(++id, { callback, delay }); return id; },
      clearTimeout(key) { timers.delete(key); },
      addEventListener: window.addEventListener.bind(window),
      removeEventListener: window.removeEventListener.bind(window)
    };
    window.__libraryWriteDocument = {
      get hidden() { return hidden; },
      addEventListener: document.addEventListener.bind(document),
      removeEventListener: document.removeEventListener.bind(document)
    };
    window.__libraryWriteGate = {
      frame: () => advance(frames),
      timer: () => advance(timers),
      setHidden(value) {
        hidden = value;
        document.dispatchEvent(new Event("visibilitychange"));
      },
      pending: () => ({ frames: frames.size, timers: [...timers.values()].map(({ delay }) => delay) })
    };
  }, initiallyHidden);
}

async function expectLibraryPersistencePending(page) {
  await page.locator(".index-person-card").first().waitFor();
  await page.waitForFunction(() => __dashboardProbe.pending() === null);
  assert.deepEqual(await page.evaluate(() => ({
    ...__libraryWriteGate.pending(), serializations: __librarySerializations, puts: __libraryPuts.length
  })), { frames: 1, timers: [150], serializations: 0, puts: 0 });
}

async function expectAgedLibraryTouchPending(page) {
  await expectLibraryPersistencePending(page);
  assert.deepEqual(await page.evaluate(() => __libraryGets), [{ mode: "readonly", committed: true }],
    "cached People renders with only the original canonical read before the touch");
}

async function rewriteStoredLibrary(page, replace = false) {
  return page.evaluate(async (replace) => {
    const { readCachedJson } = await import("/js/cache.js");
    const entry = await readCachedJson(location.origin, "/api/library", { touchIntervalMs: Infinity });
    if (!entry?.recordId) throw new Error("Expected a committed canonical library record in the fixture");
    if (replace) entry.recordId = entry.recordId.replace(/^\d/, (digit) => digit === "1" ? "2" : "1");
    else entry.accessedAt = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const db = await new Promise((resolve, reject) => {
      const open = indexedDB.open("fanhao-android-cache");
      open.onsuccess = () => resolve(open.result);
      open.onerror = () => reject(open.error);
    });
    try {
      await new Promise((resolve, reject) => {
        const transaction = db.transaction("responses", "readwrite");
        transaction.oncomplete = resolve;
        transaction.onabort = () => reject(transaction.error);
        transaction.objectStore("responses").put(entry);
      });
      return __libraryRecordSummary(entry);
    } finally {
      db.close();
    }
  }, replace);
}

const musicModuleEntry = "/modules/music/android-module.js";
const toolsModuleEntry = "/modules/tools/android-module.js";

async function holdModuleEntry(page, entry, failureStatus = 0) {
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  await page.route((url) => url.pathname === entry, async (route) => {
    await held;
    return failureStatus ? route.fulfill({ status: failureStatus }) : route.continue();
  });
  return release;
}

async function verifyPeopleSurvivesSuffix(page, releaseSuffix, toolsReady = true) {
  const card = await page.locator(".index-person-card").first().elementHandle();
  const route = page.url();
  assert.equal(await page.evaluate(() => __dashboardProbe.moduleReady("music")), false);
  releaseSuffix();
  await page.evaluate(() => __dashboardProbe.boot);
  assert.equal(await page.evaluate(() => __dashboardProbe.moduleReady("tools")), toolsReady);
  assert.equal(page.url(), route, "suffix registration preserves the active People route");
  assert.equal(await card.evaluate((node) => node === document.querySelector(".index-person-card")), true,
    "suffix registration preserves the exact People card node");
}

async function fixture(previous, refresh = false) {
  const context = await createDashboardContext();
  const page = await context.newPage();
  page.setDefaultTimeout(10000);
  page.on("pageerror", error => errors.push(error.message));
  await page.route(url => url.origin !== base, route => route.abort());
  if (previous) await page.route("**/app.js?*", route => route.continue({ url: `${base}/app.js?v=fixture-previous` }));
  let namePrefix = "", libraryRequests = 0;
  await page.route("**/api/**", route => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === "/api/library") { libraryRequests++; return route.fulfill({ json: snapshot(namePrefix) }); }
    if (pathname === "/api/modules") return route.fulfill({ json: { modules: [] } });
    return route.fulfill({ json: {} });
  });
  try {
    await page.goto(base);
    await page.locator(".index-person-card").first().waitFor();
    const startup = await page.evaluate(() => ({
      duration: __dashboardTimes[0], comparisons: __previewComparisons,
      previewCards: document.querySelectorAll("#personPreview .person-card").length,
      peopleCards: document.querySelectorAll(".index-person-card").length
    }));
    const readCards = () => page.locator("#personPreview .person-card").evaluateAll(cards => cards.map(card => ({ id: card.dataset.fixturePersonId, name: card.querySelector("strong").textContent })));
    const go = view => page.evaluate(view => __dashboardProbe.showView(view), view);
    await go("home");
    const cards = await readCards();
    assert(cards.length > 0);
    const firstHome = await page.evaluate(() => ({ comparisons: __previewComparisons, duration: __homeTimes[0] }));
    await go("people"); await go("home");
    assert.deepEqual(await readCards(), cards);
    assert.equal(await page.evaluate(() => __previewComparisons), firstHome.comparisons, "same-snapshot home reopen must reuse its cards");
    if (refresh) {
      await go("people");
      namePrefix = "更新 ";
      await page.evaluate(() => __dashboardProbe.loadDashboard());
      assert.equal(libraryRequests, 2);
      assert.equal(await page.evaluate(() => __previewComparisons), firstHome.comparisons, "refresh while People is visible must not sort the hidden preview");
      await go("home");
      const updated = await readCards();
      assert(updated.length > 0 && updated.every(({ name }) => name.startsWith("更新 ")));
    }
    return { ...startup, cards, firstHome };
  } finally { await context.close(); }
}

async function verifyConditionalSnapshot() {
  const context = await createDashboardContext();
  const metadataPath = "/api/library?peopleRevision=metadata";
  let releaseMusic;
  try {
    await observeLibraryPersistence(context);
    let offline = false;
    const revisions = [];
    const createPage = async () => {
      const page = await context.newPage();
      page.setDefaultTimeout(10000);
      page.on("pageerror", (error) => errors.push(error.message));
      await page.route((url) => url.origin !== base, (route) => route.abort());
      await page.route("**/api/**", (route) => {
        const url = new URL(route.request().url());
        if (url.pathname === "/api/library") {
          revisions.push(url.searchParams.get("peopleRevision"));
          return offline ? route.abort() : route.continue();
        }
        return route.fulfill({ json: url.pathname === "/api/modules" ? { modules: [] } : {} });
      });
      return page;
    };
    const page = await createPage();
    await page.goto(base);
    await expectLibraryPersistencePending(page);
    await page.evaluate(() => __libraryWriteGate.frame());
    await expectLibraryPersistencePending(page);
    await page.evaluate(() => __libraryWriteGate.frame());
    await page.waitForFunction(() => __libraryPuts.some((entry) => entry.path === "/api/library" && entry.committed));
    assert.equal(await page.evaluate(() => __librarySerializations), 1, "canonical serialization starts after the second frame");
    const revision = await page.evaluate(() => __dashboardProbe.library().peopleRevision);
    assert.match(revision, /^[a-f0-9]{64}$/);

    conditionalFavoriteCount = 17;
    const response = page.waitForResponse((candidate) => new URL(candidate.url()).searchParams.get("peopleRevision") === revision);
    assert.equal(await page.evaluate(() => {
      __dashboardPeopleRenders.length = 0;
      return __dashboardProbe.loadDashboard();
    }), true);
    const matched = await response;
    assert.equal(matched.status(), 200);
    const metadata = await matched.json();
    assert.equal(metadata.peopleUnchanged, true);
    assert(!Object.hasOwn(metadata, "people"));
    assert.deepEqual(revisions, ["", revision]);
    await page.waitForFunction((key) => __libraryPuts.some((entry) => entry.path === key && entry.committed), metadataPath);
    const warm = await page.evaluate(() => ({
      renders: __dashboardPeopleRenders.length,
      reusedPeople: __dashboardPeopleRenders.every((people) => people === __dashboardProbe.library().people),
      favoriteCount: __dashboardProbe.library().user.favoriteCount,
      writes: __libraryPuts
    }));
    assert.equal(warm.renders, 2);
    assert.equal(warm.reusedPeople, true, "matching refresh reuses the visible cached people array");
    assert.equal(warm.favoriteCount, 17);
    assert.deepEqual(warm.writes.map((entry) => entry.path), ["/api/library", metadataPath], "warm refresh performs no additional full IndexedDB put");
    const [canonical, overlay] = warm.writes;
    assert.equal(canonical.people, size);
    assert(canonical.bytes > 1_000_000 && overlay.bytes < 4096);
    assert.equal(overlay.people, undefined);
    assert(typeof canonical.recordId === "string" && canonical.recordId);
    assert.equal(overlay.snapshotRecordId, canonical.recordId);

    const aged = await rewriteStoredLibrary(page);
    offline = true;
    releaseMusic = await holdModuleEntry(page, musicModuleEntry);
    const failed = page.waitForEvent("requestfailed", (request) => new URL(request.url()).pathname === "/api/library");
    await page.reload({ waitUntil: "commit" });
    assert.equal(new URL((await failed).url()).searchParams.get("peopleRevision"), revision,
      "warm startup revalidates its cached revision while Music is held");
    await page.waitForFunction(() => __dashboardProbe.library()?.user.favoriteCount === 17 && __dashboardProbe.pending() === null);
    await page.locator(".index-person-card").first().waitFor();
    const retained = await page.evaluate(() => ({ people: __dashboardProbe.library().people.length, writes: __libraryPuts.length }));
    assert.deepEqual(retained, { people: size, writes: 0 }, "offline People uses the cached overlay while Music is held");
    await expectAgedLibraryTouchPending(page);
    await page.evaluate(() => __libraryWriteGate.frame());
    await expectAgedLibraryTouchPending(page);
    await page.evaluate(() => __libraryWriteGate.frame());
    await page.waitForFunction(() => __libraryPuts.some((entry) => entry.committed));
    const touched = await page.evaluate(() => ({ gets: __libraryGets, puts: __libraryPuts, serializations: __librarySerializations }));
    assert.deepEqual(touched.gets, [{ mode: "readonly", committed: true }, { mode: "readwrite", committed: true }]);
    assert.equal(touched.serializations, 0);
    assert.equal(touched.puts.length, 1);
    const { accessedAt, committed, ...preserved } = touched.puts[0];
    const { accessedAt: oldAccess, ...agedFields } = aged;
    assert(committed && Date.parse(accessedAt) > Date.parse(oldAccess));
    assert.deepEqual(preserved, agedFields, "the LRU touch preserves the canonical revision, record ID, size and update time");
    await verifyPeopleSurvivesSuffix(page, releaseMusic);
    assert.deepEqual(revisions, ["", revision, revision]);
    console.log("Matching Android library refresh preserves the people array and writes only a small offline metadata overlay.");

    for (const trigger of ["replaced", "account", "clear"]) {
      await rewriteStoredLibrary(page);
      const stalePage = await createPage();
      try {
        await stalePage.goto(base);
        await expectAgedLibraryTouchPending(stalePage);
        if (trigger === "replaced") {
          await rewriteStoredLibrary(stalePage, true);
        } else if (trigger === "account") {
          assert.equal(await stalePage.evaluate(async () => {
            const { setAccountOwner } = await import("/js/account-owner.js");
            setAccountOwner(location.origin, "pending");
            return __dashboardProbe.library();
          }), null);
        } else {
          await stalePage.evaluate(async () => {
            const { clearCachedResponses } = await import("/js/cache.js");
            await clearCachedResponses(location.origin);
          });
        }
        const before = await stalePage.evaluate(() => ({ gets: __libraryGets.length, puts: __libraryPuts.length }));
        await stalePage.evaluate(() => { __libraryWriteGate.frame(); __libraryWriteGate.frame(); });
        if (trigger === "replaced") {
          await stalePage.waitForFunction((count) => __libraryGets[count]?.mode === "readwrite" && __libraryGets[count].committed, before.gets);
        }
        const after = await stalePage.evaluate(async () => {
          await new Promise((resolve) => setTimeout(resolve, 0));
          return { gets: __libraryGets.length, puts: __libraryPuts.length, serializations: __librarySerializations };
        });
        assert.deepEqual(after, { gets: before.gets + Number(trigger === "replaced"), puts: before.puts, serializations: 0 }, trigger);
        if (trigger === "clear") {
          assert.equal(await stalePage.evaluate(async () => {
            const { readCachedJson } = await import("/js/cache.js");
            return readCachedJson(location.origin, "/api/library", { touchIntervalMs: Infinity });
          }), null, "deferred touch cannot repopulate a cleared canonical snapshot");
        }
      } finally {
        await stalePage.close();
      }
    }
    console.log("Aged offline library gives People a paint opportunity, touches once, and skips replaced, cleared and foreign-account records.");
  } finally {
    releaseMusic?.();
    await context.close();
  }
}

async function verifyColdLibraryWriteTrigger(trigger) {
  const context = await createDashboardContext();
  try {
    await observeLibraryPersistence(context, trigger === "hidden");
    const page = await context.newPage();
    page.setDefaultTimeout(10000);
    page.on("pageerror", (error) => errors.push(error.message));
    await page.route((url) => url.origin !== base, (route) => route.abort());
    await page.route("**/api/**", (route) => {
      const { pathname } = new URL(route.request().url());
      if (pathname === "/api/library") return route.continue();
      return route.fulfill({ json: pathname === "/api/modules" ? { modules: [] } : {} });
    });
    await page.goto(base);
    if (trigger !== "hidden") await expectLibraryPersistencePending(page);

    const stale = trigger === "cache-clear" || trigger === "account-change";
    if (trigger === "cache-clear") {
      await page.evaluate(async () => {
        const { clearCachedResponses } = await import("/js/cache.js");
        await clearCachedResponses(location.origin);
      });
    } else if (trigger === "account-change") {
      assert.equal(await page.evaluate(async () => {
        const { setAccountOwner } = await import("/js/account-owner.js");
        setAccountOwner(location.origin, "pending");
        return __dashboardProbe.library();
      }), null);
    } else if (trigger === "visibilitychange") {
      await page.evaluate(() => __libraryWriteGate.setHidden(false));
      await expectLibraryPersistencePending(page);
    }

    await page.evaluate((trigger) => {
      if (trigger === "pagehide") window.dispatchEvent(new Event("pagehide"));
      else if (trigger === "visibilitychange") __libraryWriteGate.setHidden(true);
      else if (trigger !== "hidden") __libraryWriteGate.timer();
    }, trigger);
    if (!stale) await page.waitForFunction(() => __libraryPuts.some((entry) => entry.committed));
    const result = await page.evaluate(async () => {
      __libraryWriteGate.frame();
      __libraryWriteGate.frame();
      __libraryWriteGate.timer();
      window.dispatchEvent(new Event("pagehide"));
      await new Promise((resolve) => setTimeout(resolve, 0));
      return { ...__libraryWriteGate.pending(), serializations: __librarySerializations,
        puts: __libraryPuts.map(({ path, people }) => ({ path, people })) };
    });
    assert.deepEqual(result, { frames: 0, timers: [], serializations: stale ? 0 : 1,
      puts: stale ? [] : [{ path: "/api/library", people: size }] }, trigger);
  } finally {
    await context.close();
  }
}

async function verifyDeferredLibrary({ restoreTools = false, requireAccount = false } = {}) {
  const context = await createDashboardContext();
  let releaseLibrary;
  const heldLibrary = new Promise((resolve) => { releaseLibrary = resolve; });
  try {
    if (restoreTools) await context.addInitScript(() => {
      localStorage.setItem("fanhao.android.lastView", JSON.stringify({ view: "tools", params: {} }));
    });
    const page = await context.newPage();
    page.setDefaultTimeout(10000);
    page.on("pageerror", (error) => errors.push(error.message));
    await page.route((url) => url.origin !== base, (route) => route.abort());
    const revisions = [];
    let authProbes = 0;
    await page.route("**/api/**", async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname === "/api/library") {
        revisions.push(url.searchParams.get("peopleRevision"));
        await heldLibrary;
        return route.continue();
      }
      if (url.pathname === "/api/auth/status") authProbes++;
      if (url.pathname === "/api/modules" && requireAccount) {
        return route.fulfill({ status: 401, json: { error: "访问资料库需要登录用户账号",
          reason: "account-required", accountLoginRequired: true } });
      }
      return route.fulfill({ json: url.pathname === "/api/modules" ? { modules: [] } : {} });
    });

    const catalog = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/modules");
    await page.goto(restoreTools ? base : `${base}/#tools`);
    const toolsRow = page.locator(".tools-native-page .tool-native-row").first();
    await toolsRow.waitFor();
    assert.equal((await catalog).status(), requireAccount ? 401 : 200);
    if (requireAccount) {
      await page.locator("#settingsOverlay .settings-account-group[open]").waitFor();
      assert.match(await page.locator("#statusText").textContent(), /需要用户账号/);
    }
    assert.deepEqual(revisions, [], "Tools startup must not request a people snapshot");
    assert.equal(await page.evaluate(() => __dashboardProbe.pending() === null && __dashboardProbe.library() === null), true,
      "Tools startup must not schedule the snapshot after its first paint");
    assert.equal(authProbes, 0, "the catalog response supplies startup authentication without a separate status request");
    if (requireAccount) return;

    const peopleButton = page.locator('.bottom-nav-item[data-bottom-key="fanhao"]');
    const toolsButton = page.locator('.bottom-nav-item[data-bottom-key="tools"]');
    const peopleCard = page.locator(".index-person-card").first();
    const request = page.waitForRequest((candidate) => new URL(candidate.url()).pathname === "/api/library");
    await peopleButton.click();
    await request;
    assert.equal(await peopleCard.count(), 0, "cold People waits for the full snapshot");

    await toolsButton.click();
    await toolsRow.waitFor();
    await peopleButton.click();
    assert.equal(await page.evaluate(() => Boolean(__dashboardProbe.pending())), true);
    releaseLibrary();
    await peopleCard.waitFor();
    await page.waitForFunction(() => __dashboardProbe.pending() === null);
    assert.equal(await page.evaluate(() => __dashboardProbe.library()?.people.length), size);

    await toolsButton.click();
    await toolsRow.waitFor();
    await peopleButton.click();
    await peopleCard.waitFor();
    assert.deepEqual(revisions, [""], "People shares the first cold request and reuses its full snapshot on later visits");
  } finally {
    releaseLibrary();
    await context.close();
  }
}

async function verifyEarlyLibraryRequest({ toolsDuringStartup = "" } = {}) {
  const context = await createDashboardContext();
  let releaseMusic;
  let releaseTools;
  try {
    const page = await context.newPage();
    page.setDefaultTimeout(10000);
    page.on("pageerror", (error) => errors.push(error.message));
    await page.route((url) => url.origin !== base, (route) => route.abort());
    releaseMusic = await holdModuleEntry(page, musicModuleEntry);
    if (toolsDuringStartup === "fail") releaseTools = await holdModuleEntry(page, toolsModuleEntry, 503);
    const revisions = [];
    await page.route("**/api/**", (route) => {
      const url = new URL(route.request().url());
      if (url.pathname === "/api/library") {
        revisions.push(url.searchParams.get("peopleRevision"));
        return route.continue();
      }
      return route.fulfill({ json: url.pathname === "/api/modules" ? { modules: [] } : {} });
    });

    const musicRequest = page.waitForRequest((request) => new URL(request.url()).pathname === musicModuleEntry);
    const libraryResponse = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/library");
    await page.goto(base, { waitUntil: "commit" });
    await musicRequest;
    const response = await libraryResponse;
    assert.equal(response.status(), 200);
    assert.equal((await response.json()).people.length, size, "the full snapshot arrives while Music remains held");
    await page.locator(".index-person-card").first().waitFor();
    await page.waitForFunction(() => __dashboardProbe.pending() === null);
    assert.equal(await page.evaluate(() => __dashboardProbe.library()?.people.length), size);
    assert.equal(await page.evaluate(() => __dashboardProbe.moduleReady("music")), false,
      "cold People publishes through the ready prefix before Music can load");

    const toolsButton = page.locator('.bottom-nav-item[data-bottom-key="tools"]');
    if (toolsDuringStartup === "stay" || toolsDuringStartup === "leave") {
      await page.evaluate(() => {
        window.__toolsMounts = 0;
        new MutationObserver((records) => {
          for (const record of records) for (const node of record.addedNodes) {
            if (node instanceof Element && node.matches(".tools-profile-header")) window.__toolsMounts++;
          }
        }).observe(document.getElementById("viewContent"), { childList: true });
      });
      await toolsButton.click();
      await page.locator("#viewContent .route-loading").waitFor();
      assert.equal(new URL(page.url()).hash, "#tools");
      assert.equal(await page.evaluate(() => __dashboardProbe.moduleReady("tools")), false);
      assert.equal(await page.locator(".tools-profile-header").count(), 0);
      if (toolsDuringStartup === "leave") {
        await page.locator('.bottom-nav-item[data-bottom-key="fanhao"]').click();
        await page.locator(".index-person-card").first().waitFor();
      }
    }

    if (toolsDuringStartup === "stay") {
      releaseMusic();
      await page.evaluate(() => __dashboardProbe.boot);
      await page.locator(".tools-profile-header").waitFor();
      assert.equal(new URL(page.url()).hash, "#tools");
      assert.equal(await page.evaluate(() => window.__toolsMounts), 1, "a waiting Tools route mounts exactly once");
    } else if (toolsDuringStartup === "fail") {
      const failedModule = page.waitForResponse((candidate) => new URL(candidate.url()).pathname === toolsModuleEntry);
      await verifyPeopleSurvivesSuffix(page, () => { releaseTools(); releaseMusic(); }, false);
      assert.equal((await failedModule).status(), 503);
      await toolsButton.click();
      await page.locator("#viewContent").getByText("页面模块未能加载，可以返回或切换到其他页面。", { exact: true }).waitFor();
      assert.equal(new URL(page.url()).hash, "#tools");
    } else {
      await verifyPeopleSurvivesSuffix(page, releaseMusic);
      if (toolsDuringStartup === "leave") assert.equal(await page.evaluate(() => window.__toolsMounts), 0,
        "registering Tools cannot render an abandoned route");
    }
    assert.deepEqual(revisions, [""], "boot and the People renderer share one cold read");
  } finally {
    releaseMusic?.();
    releaseTools?.();
    await context.close();
  }
}

const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
try {
  browser = await chromium.launch({ executablePath, headless: true });
  const old = [], current = [];
  const baselineOnly = process.argv.includes("--baseline-only");
  for (let round = 0; round < 5; round++) {
    old.push(await fixture(true));
    if (!baselineOnly) current.push(await fixture(false, round === 0));
  }
  assert(old.every(sample => sample.comparisons > 50000 && sample.previewCards > 0));
  console.log(`Default entry baseline (${size} people): ${old[0].comparisons} hidden preview sort comparisons, ${old[0].previewCards} preview cards, dashboard median ${median(old.map(sample => sample.duration)).toFixed(1)} ms.`);
  if (!baselineOnly) {
    for (let i = 0; i < current.length; i++) {
      assert.deepEqual(current[i].cards, old[i].cards, "Home must keep exact rank and stable ties across the selection cutoff");
      assert.equal(current[i].peopleCards, old[i].peopleCards);
      assert.equal(current[i].comparisons, 0);
      assert.equal(current[i].previewCards, 0);
      assert(current[i].firstHome.comparisons < 12000, "Home should only rank the small visible preview");
    }
    console.log(`Default entry current: zero hidden preview sort comparisons or cards, dashboard median ${median(current.map(sample => sample.duration)).toFixed(1)} ms; exact Home preview retained.`);
    console.log(`First Home: ${current[0].firstHome.comparisons} comparisons, median ${median(current.map(sample => sample.firstHome.duration)).toFixed(1)} ms including rendering (legacy Home render ${median(old.map(sample => sample.firstHome.duration)).toFixed(1)} ms after eager preview).`);
    await verifyConditionalSnapshot();
    for (const trigger of ["timer", "pagehide", "visibilitychange", "hidden", "cache-clear", "account-change"]) {
      await verifyColdLibraryWriteTrigger(trigger);
    }
    console.log("Cold library persistence gives People a paint opportunity and handles timeout, backgrounding and stale owners.");
    await verifyDeferredLibrary();
    await verifyDeferredLibrary({ restoreTools: true });
    await verifyDeferredLibrary({ requireAccount: true });
    console.log("Direct and restored Tools skip the library snapshot until People requests it once; denied startup still opens account settings.");
    await verifyEarlyLibraryRequest();
    await verifyEarlyLibraryRequest({ toolsDuringStartup: "stay" });
    await verifyEarlyLibraryRequest({ toolsDuringStartup: "leave" });
    await verifyEarlyLibraryRequest({ toolsDuringStartup: "fail" });
    console.log("Cold and cached People publish before Music; the suffix mounts only the waiting route and contains a failed module to its own route.");
  }
  assert.deepEqual(errors, []);
} finally {
  await browser?.close();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
