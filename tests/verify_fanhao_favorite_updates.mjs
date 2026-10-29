import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

// Actual FanHao shell, real pagination and covers; all data/POSTs are synthetic.
// --baseline=<saved public source> measures the pre-change work-actions module.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."), publicRoot = path.join(root, "public");
export async function runFanhaoFavoriteUpdates({ casePattern = "", sourceOverrides = {}, baseline = false, folderFocusMode = "", markerRecoveryMode = "", folderRetryMode = "" } = {}) {
  const executablePath = [process.env.CHROME_PATH, "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe", "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe"].filter(Boolean).find(file => fs.existsSync(file));
  assert(executablePath, "private Chromium required");
  const overrides = new Map(Object.entries(sourceOverrides)), faults = [], gates = new Set();
  let runtime, browser, checks = 0;
  const person = { id: "favorite-person", name: "收藏测试人物", workCount: 1000 };
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://fixture"), current = runtime;
    try {
      if (current?.favoritePendingOnly && url.pathname.startsWith("/api/")) {
        current.favoritePendingApi.push({ method: req.method, path: url.pathname, query: url.search });
        const favoriteWrite = req.method === "POST" && url.pathname === "/api/favorites/f0000";
        const folderWrite = current.allowPendingFolderWrite && req.method === "PUT" && url.pathname === "/api/favorites/f0000/folder";
        if (!["GET", "HEAD"].includes(req.method) && !favoriteWrite && !folderWrite) {
          current.favoritePendingRejected.push(`${req.method} ${url.pathname}`);
          json(res, { error: "Favorite pending fixture rejects unrelated mutations" }, 405); return;
        }
      }
      if (current?.folderRetryOnly && url.pathname.startsWith("/api/")) {
        current.folderRetryApi.push({ method: req.method, path: url.pathname, query: url.search });
        const folderWrite = req.method === "PUT" && /^\/api\/favorites\/f\d+\/folder$/.test(url.pathname);
        if (!["GET", "HEAD"].includes(req.method) && !folderWrite) {
          current.folderRetryRejected.push(`${req.method} ${url.pathname}`);
          json(res, { error: "Folder recovery fixture rejects unrelated mutations" }, 405); return;
        }
      }
      if (current?.markerMode && url.pathname.startsWith("/api/")) {
        current.markerApiCalls.push({ method: req.method, path: url.pathname, query: url.search });
        const markerWrite = req.method === "POST" && /^\/api\/works\/f\d+\/local-marker$/.test(url.pathname);
        const favoriteWrite = current.allowFavoriteWrite && req.method === "POST" && /^\/api\/favorites\/f\d+$/.test(url.pathname);
        if (req.method !== "GET" && !markerWrite && !favoriteWrite) {
          current.rejectedMutations.push(`${req.method} ${url.pathname}`);
          json(res, { error: "Marker fixture rejects unrelated mutations" }, 405); return;
        }
      }
      if (current?.readOnly && url.pathname.startsWith("/api/")) {
        current.apiCalls.push({ method: req.method, path: url.pathname, query: url.search, phase: current.bulkPhase || "initialization" });
        if (req.method !== "GET") {
          current.rejectedMutations.push(`${req.method} ${url.pathname}`);
          json(res, { error: "Bulk-selection fixture rejects every mutation" }, 405); return;
        }
      }
      if (url.pathname.startsWith("/fixture-cover/")) {
        current.coverRequests++; current.lastCoverAt = Date.now();
        respond(res, '<svg xmlns="http://www.w3.org/2000/svg" width="300" height="450"><rect width="300" height="450" fill="#557b73"/></svg>', "image/svg+xml"); return;
      }
      if (url.pathname === "/favicon.ico") { res.writeHead(204); res.end(); return; }
      if (url.pathname === "/api/library") {
        current.reads.push({ path: url.pathname });
        const plan = current.libraryRead;
        plan?.arrived?.(); if (plan?.wait) await plan.wait;
        json(res, { people: [person], works: [], totals: {}, user: {}, access: { mode: "local" } }); return;
      }
      if (url.pathname === "/api/people/favorite-person") {
        const offset = Number(url.searchParams.get("offset") || 0), limit = Number(url.searchParams.get("limit") || 64);
        const favoriteOnly = (url.searchParams.get("filter") || "").split(",").includes("favorite");
        current.reads.push({ path: url.pathname, offset, limit, favoriteOnly });
        if (await failMarkerRead(url, res)) return;
        const all = filterFixtureMarkerRows(favoriteOnly ? current.works.filter(work => current.favorites.has(work.id)) : current.works, url);
        const plan = current.personRead?.offset === offset && !current.personRead.used ? current.personRead : null;
        if (plan) { plan.used = true; plan.arrived(); await plan.wait; }
        const payload = { person, works: all.slice(offset, offset + limit).map(work => fixtureWorkDto(work, undefined, false)), total: all.length, facets: { all: current.works.length, favorite: current.favorites.size }, offset, limit };
        await holdMarkerRead(url, payload); json(res, payload); return;
      }
      if (url.pathname === "/api/search" || url.pathname === "/api/favorites") {
        const query = url.searchParams.get("q"), offset = Number(url.searchParams.get("offset") || 0), limit = Number(url.searchParams.get("limit") || 64);
        const folder = url.searchParams.get("folder") || "all";
        current.reads.push({ path: url.pathname, query, offset, limit, folder });
        if (await failMarkerRead(url, res)) return;
        if (query === "new-error") { json(res, { error: "Synthetic current query failure" }, 503); return; }
        const queried = url.pathname === "/api/favorites" ? current.works.filter(work => current.favorites.has(work.id)
          && (!url.searchParams.get("folder") || (current.folderIds.get(work.id) || "default") === url.searchParams.get("folder")))
          : query === "same-id" ? current.works.slice(0, 1) : current.works;
        const all = filterFixtureMarkerRows(url.pathname === "/api/search" && (url.searchParams.get("filter") || "").split(",").includes("favorite")
          ? queried.filter(work => current.favorites.has(work.id)) : queried, url);
        const payload = { works: all.slice(offset, offset + limit).map(work => fixtureWorkDto(work)), people: [], total: all.length, offset, limit, facets: { all: all.length }, folders: folderDtos(current), selectedFolderId: folder };
        const plan = url.pathname === "/api/favorites" && current.favoriteRead?.folder === folder && !current.favoriteRead.used ? current.favoriteRead : null;
        if (plan) { plan.used = true; plan.arrived?.(); if (plan.wait) await plan.wait; if (plan.error) { json(res, { error: plan.error }, 503); return; } }
        await holdMarkerRead(url, payload); json(res, payload); return;
      }
      if (current?.markerMode && /^\/api\/works\/f\d+\/local-marker$/.test(url.pathname) && req.method === "POST") {
        let body = ""; for await (const chunk of req) body += chunk;
        const payload = JSON.parse(body), id = url.pathname.split("/")[3], work = current.works.find(item => item.id === id);
        assert(work && payload.marker === "A" && typeof payload.enabled === "boolean", "marker fixture accepts only explicit A intent for a synthetic work");
        current.markerWrites.push({ id, ...payload });
        const plan = current.markerMutation;
        const response = { ok: true, changed: current.markers.has(id) !== payload.enabled, marker: "A", enabled: payload.enabled,
          work: fixtureWorkDto(work, payload.enabled) };
        plan?.arrived?.(); if (plan?.wait) await plan.wait;
        if (plan?.error) { json(res, { error: plan.error }, 503); return; }
        if (plan?.invalidReceipt) { json(res, { ...response, work: { ...response.work, id: "invalid-fixture-work" } }); return; }
        if (payload.enabled) current.markers.add(id); else current.markers.delete(id);
        json(res, response); return;
      }
      if (/^\/api\/favorites\/f\d+\/folder$/.test(url.pathname) && req.method === "PUT") {
        let body = ""; for await (const chunk of req) body += chunk;
        const { folderId } = JSON.parse(body), id = url.pathname.split("/").at(-2), plan = current.mutation;
        current.puts++; current.folderWrites.push({ id, folderId }); plan?.arrived?.(); if (plan?.wait) await plan.wait;
        if (plan?.error) { json(res, { error: plan.error }, 503); return; }
        current.folderIds.set(id, folderId);
        json(res, { favorite: { folderId, folderName: folderId === "later" ? "稍后" : "默认" }, folders: folderDtos(current), user: {} }); return;
      }
      if (/^\/api\/favorites\/f\d+$/.test(url.pathname) && req.method === "POST") {
        const id = url.pathname.split("/").at(-1), plan = current.mutation;
        current.posts++; plan?.arrived?.();
        if (plan?.wait) await plan.wait;
        if (plan?.error) { json(res, { error: plan.error }, 503); return; }
        const favorite = !current.favorites.has(id);
        if (favorite) current.favorites.add(id); else current.favorites.delete(id);
        json(res, { favorite, favoriteFolder: { folderId: current.folderIds.get(id) || "default", folderName: "默认" }, folders: folderDtos(current), user: { favoriteCount: current.favorites.size } }); return;
      }
      if (url.pathname.startsWith("/api/")) { json(res, {}); return; }
      if (overrides.has(url.pathname)) { respond(res, overrides.get(url.pathname), "text/javascript"); return; }
      const filename = path.resolve(publicRoot, `.${decodeURIComponent(url.pathname)}`);
      assert(filename.startsWith(`${publicRoot}${path.sep}`), "static paths must remain in public");
      const target = fs.statSync(filename, { throwIfNoEntry: false })?.isFile() ? filename : path.join(publicRoot, "index.html");
      const type = target.endsWith(".js") ? "text/javascript" : target.endsWith(".css") ? "text/css" : target.endsWith(".svg") ? "image/svg+xml" : "text/html; charset=utf-8";
      respond(res, await fs.promises.readFile(target), type);
    } catch (error) { faults.push(error.message); if (!res.destroyed) json(res, { error: error.message }, 500); }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const run = async (name, task) => { if (casePattern && !name.includes(casePattern)) return; await task(); checks++; console.log(`PASS ${name}`); };
  try {
    browser = await chromium.launch({ executablePath, headless: true });
    for (const failed of [false, true]) await run(`${baseline ? "baseline measures" : "1000-card favorite"} ${failed ? "rollback" : "success"}${baseline ? " on 1000 cards" : " retains the live grid"}`, async () => {
      const page = await newPage(1000); runtime.mutation = failed ? { error: "Synthetic favorite failure" } : null;
      try {
        await openSearch(page, "large"); await loadAll(page, 1000);
        const button = star(page, "f0500"); await button.scrollIntoViewIfNeeded(); await button.focus();
        await page.waitForFunction(() => { const image = document.querySelector('[data-work-id="f0500"] img'); return image?.complete && image.naturalWidth > 0; });
        await settleCovers(page); await beginProbe(page, "f0500"); const covers = runtime.coverRequests, reads = runtime.reads.length;
        await postClick(page, button); await settleCovers(page);
        const metrics = await finishProbe(page); metrics.coverRequests = runtime.coverRequests - covers;
        console.log(`MEASURE ${baseline ? "baseline" : overrides.size ? "override" : "current"} ${failed ? "rollback" : "success"} ${JSON.stringify(metrics)}`);
        if (baseline) { assert.equal(metrics.retainedCards, 0); assert(metrics.addedGridElements > 0); }
        else {
          assert.equal(metrics.retainedCards, 1000, "one favorite update must retain all 1000 existing work cards");
          assert.equal(metrics.addedGridElements, failed ? metrics.addedFavoriteErrorElements : 0, "one favorite update may add only its own failure feedback subtree");
          assert.equal(metrics.retainedImages, metrics.initialImages, "favorite updates must retain original cover nodes and their parents");
          assert.equal(metrics.srcAssignments, 0, "favorite updates must not reassign cover sources");
          assert.equal(metrics.coverRequests, 0, "favorite updates must not refetch settled visible covers");
          assert.equal(runtime.reads.length, reads, "favorite updates must not silently reload the current list");
          assert(metrics.focusRetained && Math.abs(metrics.scrollDelta) < 1, "favorite completion must preserve its button focus and scroll anchor");
          assert.equal(await button.getAttribute("aria-label"), failed ? "收藏" : "取消收藏");
          assert.equal(await button.isDisabled(), false);
        }
        assert.equal(runtime.posts, 1); assert.equal(await page.evaluate(() => __alerts.length), baseline && failed ? 1 : 0);
      } finally { await page.close(); }
    });
    if (!baseline) {
      await run("1000-card person bulk selection keeps native cards and covers", verifyPersonBulkNativeSelection);
      await run("person bulk selection all reads the loaded local prefix through append", verifyPersonBulkLoadedPrefix);
      await run("person bulk selection retired controls cannot change a new person view", verifyPersonBulkRetiredControls);
      await run("1000-card local marker native roundtrip retains the current grid", verifyLocalMarkerNativeRoundtrip);
      await run("ordinary favorite pending follows same-ID replacement without duplicate toggles", verifyFavoritePendingReplacement);
      await run("ordinary favorite failure keeps a persistent safe feedback surface", verifyFavoriteFailureFeedback);
      await run("local marker current failure retries without stealing a newer draft", verifyLocalMarkerCurrentFailure);
      await run("local marker native recovery focus preserves visibility and newer intent", verifyLocalMarkerNativeRecoveryFocus);
      for (const failed of [false, true]) await run(`local marker obsolete ${failed ? "failure" : "success"} preserves a newer search error`, () => verifyLocalMarkerObsolete(failed));
      await run("local marker replacement races preserve the latest receipt", verifyLocalMarkerReplacementRaces);
      for (const kind of ["filter", "query"]) await run(`local marker ${kind} membership reloads the current raw prefix`, () => verifyLocalMarkerMembership(kind));
      await run("local marker confirmation retires settled empty search prefetches", verifyLocalMarkerSearchPrefetch);
      await run("local marker confirmation retires settled person detail prefetches", verifyLocalMarkerPersonPrefetch);
      for (const kind of ["query", "filter"]) await run(`local marker accepted empty ${kind} destination rechecks confirmed membership`, () => verifyLocalMarkerAcceptedEmpty(kind));
      for (const kind of ["query", "filter"]) await run(`local marker accepted nonempty ${kind} destination joins confirmed membership`, () => verifyLocalMarkerAcceptedNonempty(kind));
      for (const failed of [false, true]) await run(`late favorite ${failed ? "failure" : "success"} cannot replace a new query error`, async () => {
        const page = await newPage(3), pending = deferred(); runtime.mutation = { ...pending, error: failed ? "Synthetic obsolete favorite failure" : "" };
        try {
          await openSearch(page, "small"); await star(page, "f0000").click(); await pending.requested;
          await openSearch(page, "new-error"); await page.locator(".search-error-state").waitFor();
          await page.locator("#workSearch").fill("后来的中文草稿"); await page.locator("#workSearch").evaluate(input => input.setSelectionRange(1, 4));
          const before = await querySurface(page); await releaseMutation(page, pending);
          assert.deepEqual(await querySurface(page), before, "obsolete favorite completion must not repaint or alert over the newer query/error surface");
        } finally { pending.release(); await page.close(); }
        if (failed) await verifyFavoriteFailurePendingHistory();
      });
      await run("favorite completion synchronizes the same ID in a replacement grid", async () => {
        const page = await newPage(3), pending = deferred(); runtime.mutation = pending;
        try {
          await openSearch(page, "small"); await star(page, "f0000").click(); await pending.requested;
          await openSearch(page, "same-id");
          await page.evaluate(() => { window.__replacementCard = document.querySelector('[data-work-id="f0000"]'); });
          await page.locator("#workSearch").focus(); await releaseMutation(page, pending);
          assert.equal(await star(page, "f0000").getAttribute("aria-label"), "取消收藏", "the current same-ID card must receive confirmed favorite state");
          assert.equal(await page.evaluate(() => __replacementCard.isConnected && document.activeElement.id === "workSearch"), true, "synchronizing a new grid must preserve its owner and newer focus");
        } finally { pending.release(); await page.close(); }
      });
      await run("favorite completion respects a newer input focus in the same grid", async () => {
        const page = await newPage(3), pending = deferred(); runtime.mutation = pending;
        try {
          await openSearch(page, "small"); await star(page, "f0000").click(); await pending.requested;
          await page.locator("#workSearch").fill("未提交草稿"); await page.locator("#workSearch").evaluate(input => input.setSelectionRange(1, 3));
          await releaseMutation(page, pending);
          assert.deepEqual(await page.locator("#workSearch").evaluate(input => [input.value, input.selectionStart, input.selectionEnd, input === document.activeElement]), ["未提交草稿", 1, 3, true]);
          assert.equal(await star(page, "f0000").getAttribute("aria-label"), "取消收藏");
        } finally { pending.release(); await page.close(); }
      });
      await run("mobile favorite removal keeps the 48-to-47 raw page correction", async () => {
        const page = await newPage(60, true, 390);
        try {
          await page.goto(`${base}/fanhao/favorites`); await star(page, "f0000").waitFor();
          assert(runtime.reads.some(read => read.path === "/api/favorites" && read.limit === 48 && !read.offset));
          await postClick(page, star(page, "f0000")); await page.locator('[data-work-id="f0000"]').waitFor({ state: "detached" });
          await loadAll(page, 59);
          assert.deepEqual(runtime.reads.filter(read => read.path === "/api/favorites" && read.offset > 0).map(read => read.offset), [47], "membership removal must adjust the raw cursor before continuing");
          assert.equal(await page.locator('[data-work-id="f0048"]').count(), 1);
        } finally { await page.close(); }
      });
      await run("ordinary unfavorite completion reconciles a newer mobile favorites grid", async () => {
        const page = await newPage(60, true, 390), pending = deferred(); runtime.mutation = pending;
        try {
          await openSearch(page, "small"); await star(page, "f0000").click(); await pending.requested;
          await page.locator("#fanhaoNavigationButton").click(); await page.locator('[data-view="favorites"]').click();
          await star(page, "f0000").waitFor(); await star(page, "f0001").focus();
          await page.evaluate(() => { window.__favoriteRetained = document.querySelector('[data-work-id="f0001"]'); window.__favoriteFocus = document.activeElement; });
          await releaseMutation(page, pending);
          assert.equal(await page.locator('[data-work-id="f0000"]').count(), 0, "late confirmed unfavorite must remove the matching card from the newer favorites page");
          const retained = await page.evaluate(() => ({ card: __favoriteRetained.isConnected, focus: document.activeElement === __favoriteFocus, button: __favoriteFocus.isConnected, active: document.activeElement?.tagName, label: document.activeElement?.getAttribute("aria-label") }));
          assert(retained.card && retained.focus, `membership reconciliation must preserve other cards and newer button focus: ${JSON.stringify(retained)}`);
          assert.equal(await page.locator("#workGrid .load-more-row").count(), 1, "membership reconciliation must retain the server continuation");
          await loadAll(page, 59);
          assert.deepEqual(runtime.reads.filter(read => read.path === "/api/favorites" && read.offset > 0).map(read => read.offset), [47]);
          assert.equal(await page.locator('[data-work-id="f0048"]').count(), 1);
        } finally { pending.release(); await page.close(); }
      });
      await run("unfavoriting a server-filtered person reloads current membership", async () => {
        const page = await newPage(3, true);
        try {
          await page.goto(`${base}/fanhao`); await page.locator(".person-index-card").click(); await star(page, "f0000").waitFor();
          const filtered = page.waitForResponse(response => new URL(response.url()).pathname === "/api/people/favorite-person");
          await page.locator('[data-work-filter="favorite"]').click(); await (await filtered).finished();
          await postClick(page, star(page, "f0000"));
          await page.locator('[data-work-id="f0000"]').waitFor({ state: "detached" });
          assert.equal(await page.locator("#workGrid .work-card").count(), 2);
          assert(runtime.reads.filter(read => read.path === "/api/people/favorite-person" && read.favoriteOnly && read.offset === 0).length >= 2, "server-side favorite filtering must be refreshed after membership changes");
        } finally { await page.close(); }
      });
      for (const replaced of [false, true]) await run(`favorite completion yields to history waiting for the initial library ${replaced ? "after grid replacement" : "with the original grid"}`, async () => {
        const page = await newPage(3, true), library = deferred(), pending = deferred();
        runtime.libraryRead = library; runtime.mutation = pending;
        try {
          await page.addInitScript(() => {
            if (location.pathname === "/fanhao" && location.search === "?q=small") {
              history.replaceState(null, "", "/fanhao");
              history.pushState(null, "", "/fanhao?q=small");
            }
          });
          await page.goto(`${base}/fanhao?q=small`); await star(page, "f0000").waitFor(); await library.requested;
          const filtered = page.waitForResponse(response => new URL(response.url()).pathname === "/api/search" && new URL(response.url()).searchParams.get("filter") === "favorite");
          await page.locator('[data-work-filter="favorite"]').click(); await (await filtered).finished();
          await star(page, "f0000").click(); await pending.requested;
          await page.evaluate(() => { window.__favoriteBeforeHistory = document.querySelector('[data-work-id="f0000"] .favorite-button'); });
          if (replaced) await openSearch(page, "same-id");
          await page.goBack({ waitUntil: "commit" });
          assert.equal(new URL(page.url()).search, "");
          assert.equal(await page.evaluate(() => __favoriteBeforeHistory.isConnected), !replaced, "the original control's lifetime must reflect whether the search grid was replaced");
          assert.equal(await page.locator('.work-card[data-work-id="f0000"]').count(), 1, "a previous search stays visible while the initial library is pending");
          const searches = runtime.reads.filter(read => read.path === "/api/search").length;
          await releaseMutation(page, pending);
          assert.equal(runtime.reads.filter(read => read.path === "/api/search").length, searches, "an obsolete visible favorite control must not restart its old filtered search during history navigation");
          assert.equal(new URL(page.url()).search, "", "the pending history URL must not be replaced by an old favorite-filter refresh");
          library.release(); await page.locator(".person-index-card").waitFor();
          assert.equal(await page.locator(".work-card").count(), 0, "the original history intent must finish after the library arrives");
          assert.equal(new URL(page.url()).search, "");
        } finally { pending.release(); library.release(); await page.close(); }
      });
      await run("favorite completion refreshes a genuinely replaced filtered grid", async () => {
        const page = await newPage(3, true), pending = deferred(); runtime.mutation = pending;
        try {
          await openSearch(page, "small"); await star(page, "f0000").click(); await pending.requested;
          await openSearch(page, "same-id");
          const filtered = page.waitForResponse(response => new URL(response.url()).pathname === "/api/search" && new URL(response.url()).searchParams.get("filter") === "favorite");
          await page.locator('[data-work-filter="favorite"]').click(); await (await filtered).finished();
          await star(page, "f0000").waitFor();
          const rawHistory = page.waitForResponse(response => new URL(response.url()).pathname === "/api/search" && new URL(response.url()).searchParams.get("q") === "same-id");
          await page.evaluate(() => {
            history.replaceState(null, "", "/fanhao?q=%20same-id%20");
            dispatchEvent(new PopStateEvent("popstate"));
          });
          await (await rawHistory).finished(); await star(page, "f0000").waitFor();
          assert.equal(new URL(page.url()).searchParams.get("q"), " same-id ", "the loaded history entry must retain its raw whitespace query");
          await page.locator("#workSearch").fill("新的筛选页草稿");
          const searches = runtime.reads.filter(read => read.path === "/api/search" && read.query === "same-id").length;
          await releaseMutation(page, pending);
          assert.equal(runtime.reads.filter(read => read.path === "/api/search" && read.query === "same-id").length, searches + 1, "a genuinely new filtered grid must still refresh its changed membership");
          await page.waitForFunction(() => document.querySelector("#workGrid .empty-state") && !document.querySelector("#workGrid").textContent.includes("正在全库搜索"));
          assert.equal(await page.locator("#workGrid .work-card").count(), 0);
          assert.equal(new URL(page.url()).searchParams.get("q"), "same-id");
          assert.deepEqual(await page.locator("#workSearch").evaluate(input => [input.value, input === document.activeElement]), ["新的筛选页草稿", true]);
        } finally { pending.release(); await page.close(); }
      });
    }
    if (!baseline) {
      await run("favorite folder destination loaded empty refreshes after the confirmed move", async () => {
        const page = await newPage(3, true), pending = deferred(); runtime.mutation = pending;
        try {
          await page.goto(`${base}/fanhao/favorites`);
          await page.locator('[data-work-id="f0000"] .favorite-folder-select').selectOption('later'); await pending.requested;
          await page.locator('.favorite-folder-controls [data-favorite-folder="later"]').click();
          await page.locator('#workGrid .empty-state').filter({ hasText: '还没有收藏' }).waitFor();
          const reads = runtime.reads.filter(read => read.path === '/api/favorites' && read.folder === 'later').length;
          await releaseMutation(page, pending, 'PUT');
          assert.equal(await page.locator('[data-work-id="f0000"]').count(), 1,
            'a confirmed move must refresh the destination folder that was loaded empty while its write was pending');
          assert.equal(runtime.reads.filter(read => read.path === '/api/favorites' && read.folder === 'later').length, reads + 1);
          assert.equal(await page.locator('#currentPath').textContent(), '稍后 · 1 部');
          assert.equal(await page.locator('[data-work-id="f0000"] .favorite-folder-select').inputValue(), 'later');
        } finally { pending.release(); await page.close(); }
      });
      await run("favorite folder destination held read cannot restore its pre-move empty snapshot", async () => {
        const page = await newPage(3, true, 1280, true), pending = deferred(), read = deferred(); runtime.mutation = pending;
        try {
          await page.goto(`${base}/fanhao/favorites`);
          await page.locator('[data-work-id="f0000"] .favorite-folder-select').selectOption('later'); await pending.requested;
          runtime.favoriteRead = { ...read, folder: 'later' };
          await page.locator('.favorite-folder-controls [data-favorite-folder="later"]').click(); await read.requested;
          await releaseMutation(page, pending, 'PUT');
          assert.equal(await page.locator('[data-work-id="f0000"]').count(), 1,
            'commit must replace the pending destination snapshot with a fresh same-condition read');
          assert.equal(await page.evaluate(() => __favoriteReadAborts.length > 0), true);
          const before = await page.evaluate(() => __favoriteReadSettled.length);
          read.release(); await page.waitForFunction(before => __favoriteReadSettled.length > before, before); await pendingResponse(page);
          assert.equal(await page.locator('[data-work-id="f0000"]').count(), 1, 'the old empty payload must not replace the confirmed destination member');
        } finally { pending.release(); read.release(); await page.close(); }
      });
      await run("favorite folder destination read error remains visible after the confirmed move", async () => {
        const page = await newPage(3, true), pending = deferred(); runtime.mutation = pending;
        try {
          await page.goto(`${base}/fanhao/favorites`);
          await page.locator('[data-work-id="f0000"] .favorite-folder-select').selectOption('later'); await pending.requested;
          runtime.favoriteRead = { folder: 'later', error: 'Synthetic destination folder failure' };
          await page.locator('.favorite-folder-controls [data-favorite-folder="later"]').click();
          await page.locator('#workGrid .empty-state').filter({ hasText: 'Synthetic destination folder failure' }).waitFor();
          const before = await querySurface(page), reads = runtime.reads.length;
          await releaseMutation(page, pending, 'PUT');
          assert.deepEqual(await querySurface(page), before, 'a folder receipt must not cover a newer destination read error');
          assert.equal(runtime.reads.length, reads, 'failed destination reads require explicit user retry');
        } finally { pending.release(); await page.close(); }
      });
      for (const failed of [false, true]) await run(`favorite folder late ${failed ? "failure" : "success"} preserves a newer query error`, async () => {
        const page = await newPage(3, true), pending = deferred(); runtime.mutation = { ...pending, error: failed ? "Synthetic obsolete folder failure" : "" };
        try {
          await page.goto(`${base}/fanhao/favorites`);
          const select = page.locator('[data-work-id="f0000"] .favorite-folder-select');
          await select.selectOption("later"); await pending.requested;
          await openSearch(page, "new-error"); await page.locator(".search-error-state").waitFor();
          await page.locator("#workSearch").fill("新的未提交收藏夹草稿");
          await page.locator("#workSearch").evaluate(input => input.setSelectionRange(1, 4));
          const before = await querySurface(page);
          await releaseMutation(page, pending, "PUT");
          assert.deepEqual(await querySurface(page), before, "a late favorite-folder completion must not repaint or alert over the newer query/error surface");
          assert.equal(runtime.puts, 1);
        } finally { pending.release(); await page.close(); }
      });
      await run("favorite folder pending follows a replacement grid without stealing newer focus", async () => {
        const page = await newPage(3, true, 390), pending = deferred(); runtime.mutation = pending;
        try {
          await page.goto(`${base}/fanhao/favorites`);
          await page.locator('[data-work-id="f0000"] .favorite-folder-select').selectOption("later"); await pending.requested;
          await openSearch(page, "same-id");
          await page.locator("#fanhaoNavigationButton").click(); await page.locator('[data-view="favorites"]').click();
          const replacement = page.locator('[data-work-id="f0000"] .favorite-folder-select'); await replacement.waitFor();
          assert.equal(await replacement.isDisabled(), true, "a replacement folder select must reflect the outstanding same-work write");
          const newFocus = page.locator('.favorite-folder-controls [data-favorite-folder="default"]');
          await newFocus.focus();
          await releaseMutation(page, pending, "PUT");
          assert.equal(await replacement.inputValue(), "later"); assert.equal(await replacement.isDisabled(), false);
          assert.equal(await newFocus.evaluate(node => node === document.activeElement), true, "a folder receipt must preserve the newer focused folder control");
          assert.equal(await newFocus.textContent(), "默认 2");
          assert.equal(await page.locator(".favorite-folder-controls").getByRole("button", { name: "稍后 1", exact: true }).count(), 1);
          assert.equal(runtime.puts, 1);
        } finally { pending.release(); await page.close(); }
      });
      await run("favorite folder selected-folder removal preserves the 48-to-47 continuation", async () => {
        const page = await newPage(60, true, 390);
        try {
          await page.goto(`${base}/fanhao/favorites`);
          await page.locator(".favorite-folder-controls").getByRole("button", { name: "默认 60", exact: true }).click();
          const select = page.locator('[data-work-id="f0000"] .favorite-folder-select'); await select.waitFor();
          const completed = page.waitForResponse(response => response.request().method() === "PUT" && response.url().includes("/folder"));
          await select.selectOption("later"); await (await completed).finished(); await pendingResponse(page);
          assert.equal(await page.locator('[data-work-id="f0000"]').count(), 0);
          assert.equal(await page.locator("#currentPath").textContent(), "默认 · 59 部");
          await loadAll(page, 59);
          assert(runtime.reads.some(read => read.path === "/api/favorites" && read.offset === 47), "moving a member must preserve the adjusted raw continuation offset");
          assert.equal(await page.locator('[data-work-id="f0048"]').count(), 1);
        } finally { await page.close(); }
      });
      await run("favorite folder current failure restores the select without rebuilding its card", verifyFavoriteFolderCurrentFailure);
      await run("favorite folder retry cleanup respects newer viewport intent", verifyFavoriteFolderRetryViewport);
      await run("favorite folder native focus restoration distinguishes browser scroll from user intent", verifyFavoriteFolderNativeFocus);
      await run("favorite folder update retains the 1000-card all-folders grid", async () => {
        const page = await newPage(1000, true);
        try {
          await page.goto(`${base}/fanhao/favorites`); await loadAll(page, 1000);
          const select = page.locator('[data-work-id="f0500"] .favorite-folder-select');
          await select.scrollIntoViewIfNeeded(); await select.focus(); await settleCovers(page);
          await beginProbe(page, "f0500", ".favorite-folder-select");
          const completed = page.waitForResponse(response => response.request().method() === "PUT" && response.url().includes("/folder"));
          await select.selectOption("later"); await (await completed).finished(); await pendingResponse(page); await settleCovers(page);
          const metrics = await finishProbe(page); console.log(`MEASURE favorite folder ${JSON.stringify(metrics)}`);
          assert.equal(metrics.retainedCards, 1000, "a favorite-folder update must retain all 1000 existing work cards");
          assert.equal(metrics.addedGridElements, 0); assert.equal(metrics.srcAssignments, 0);
          assert(metrics.focusRetained && Math.abs(metrics.scrollDelta) < 1, "a favorite-folder update must preserve its select focus and scroll position");
          assert.equal(await select.inputValue(), "later"); assert.equal(await select.isDisabled(), false);
          assert.equal(await page.locator(".favorite-folder-controls").getByRole("button", { name: "稍后 1", exact: true }).count(), 1);
        } finally { await page.close(); }
      });
    }
    assert(checks > 0); assert.deepEqual(faults, [], "favorite fixtures must not hide page/server errors");
    console.log(`FanHao favorite updates passed (${checks} actual-shell cases; synthetic APIs and covers).`); return { checks };
  } finally {
    for (const pending of gates) pending.release();
    await browser?.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  }
  async function newPage(count, favorites = false, width = 1280, ignoreFavoriteAbort = false) {
    runtime = { works: Array.from({ length: count }, (_, index) => ({ id: `f${String(index).padStart(4, "0")}`, title: `Synthetic ${String(index).padStart(4, "0")}`, remoteCoverUrl: `/fixture-cover/${index}.svg`, videoCount: 1, playableCount: 1 })), favorites: new Set(), coverRequests: 0, lastCoverAt: 0, reads: [], posts: 0, mutation: null, libraryRead: null };
    runtime.folderIds = new Map(); runtime.puts = 0; runtime.folderWrites = [];
    if (favorites) runtime.works.forEach(work => runtime.favorites.add(work.id));
    const page = await browser.newPage({ viewport: { width, height: 900 } }); page.on("pageerror", error => faults.push(error.message));
    await page.addInitScript(({ ignoreFavoriteAbort }) => {
      Object.defineProperty(navigator, "connection", { configurable: true, value: { saveData: true } });
      window.__alerts = []; window.alert = message => __alerts.push(String(message));
      window.__favoriteReadAborts = []; window.__favoriteReadSettled = [];
      if (ignoreFavoriteAbort) {
        const fetchImpl = window.fetch.bind(window);
        window.fetch = async (url, options = {}) => {
          if (new URL(String(url), location.href).pathname !== '/api/favorites') return fetchImpl(url, options);
          options.signal?.addEventListener('abort', () => __favoriteReadAborts.push(String(url)), { once: true });
          const response = await fetchImpl(url, { ...options, signal: undefined, cache: 'no-store' }), read = response.json.bind(response);
          response.json = async () => { try { return await read(); } finally { __favoriteReadSettled.push(String(url)); } };
          return response;
        };
      }
      const create = document.createElement;
      document.createElement = function (...args) { if (window.__favoriteProbe) __favoriteProbe.createdElements++; return create.apply(this, args); };
      const descriptor = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, "src");
      Object.defineProperty(HTMLImageElement.prototype, "src", { ...descriptor, set(value) { window.__lastCoverSrcAt = performance.now(); if (window.__favoriteProbe) __favoriteProbe.srcAssignments++; descriptor.set.call(this, value); } });
    }, { ignoreFavoriteAbort });
    return page;
  }
  function deferred() {
    let release, arrived;
    const pending = { requested: new Promise(resolve => { arrived = resolve; }), wait: new Promise(resolve => { release = resolve; }), arrived: () => arrived(), release: () => { gates.delete(pending); release(); } };
    gates.add(pending); return pending;
  }
  function star(page, id) { return page.locator(`.work-card[data-work-id="${id}"] .favorite-button`); }
  async function openSearch(page, query) {
    if (page.url() === "about:blank") { await page.goto(`${base}/fanhao`); await page.locator(".person-index-card").waitFor(); }
    await page.locator("#workSearch").fill(query); await page.locator("#workSearch").press("Enter");
    if (query !== "new-error") await page.locator('.work-card[data-work-id="f0000"]').waitFor();
  }
  async function loadAll(page, count) {
    for (let attempt = 0; attempt < 220 && await page.locator("#workGrid .work-card").count() < count; attempt++) {
      await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight)); await page.waitForTimeout(20);
    }
    assert.equal(await page.locator("#workGrid .work-card").count(), count, "actual progressive/server pagination must expose the entire synthetic list");
    assert.equal(await page.locator("#workGrid .load-more-row").count(), 0);
  }
  async function settleCovers(page) {
    for (let attempt = 0; attempt < 240; attempt++) {
      const quiet = await page.evaluate(() => performance.now() - (window.__lastCoverSrcAt || 0) >= 120);
      if (quiet && Date.now() - runtime.lastCoverAt >= 120) return;
      await page.waitForTimeout(20);
    }
    assert.fail("the normal cover queue must settle before measuring a favorite update");
  }
  async function pendingResponse(page) { await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))); await page.waitForTimeout(30); }
  async function postClick(page, button) {
    const completed = page.waitForResponse(response => response.request().method() === "POST" && response.url().includes("/api/favorites/"));
    await button.click(); await (await completed).finished(); await pendingResponse(page);
  }
  async function releaseMutation(page, pending, method = "POST") {
    const completed = page.waitForResponse(response => response.request().method() === method && response.url().includes("/api/favorites/"));
    pending.release(); await (await completed).finished(); await pendingResponse(page);
  }
  async function querySurface(page) { return page.evaluate(() => { const input = document.querySelector("#workSearch"); return { url: location.href, grid: document.querySelector("#workGrid").textContent, title: document.querySelector("#currentTitle").textContent, draft: input.value, selection: [input.selectionStart, input.selectionEnd], focused: document.activeElement === input, alerts: [...__alerts] }; }); }
  async function newFavoritePendingPage(favorites = false, allowFolderWrite = false) {
    const page = await newPage(30, favorites, 320);
    await page.setViewportSize({ width: 320, height: 360 });
    runtime.favoritePendingOnly = true; runtime.allowPendingFolderWrite = allowFolderWrite;
    runtime.favoritePendingApi = []; runtime.favoritePendingRejected = [];
    return page;
  }
  async function assertFavoritePending(page, label, message) {
    const button = star(page, "f0000");
    assert.equal(await button.isDisabled(), true, message);
    assert.equal(await button.evaluate(node => node.classList.contains("pending")), true, message);
    assert.equal(await button.getAttribute("aria-label"), `${label}中`, message);
  }
  async function clickDisabledFavorite(page) {
    const button = star(page, "f0000");
    assert.equal(await button.isDisabled(), true, "the native suppression probe requires a disabled favorite star");
    await button.scrollIntoViewIfNeeded(); const box = await button.boundingBox(); assert(box);
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await pendingResponse(page);
    assert.equal(runtime.posts, 1, "a native click on the pending replacement must not send another toggle POST");
  }
  async function beginFavoriteReplacementProbe(page) {
    await page.waitForFunction(() => { const image = document.querySelector('.work-card[data-work-id="f0000"] img'); return image?.complete && image.naturalWidth > 0; });
    await settleCovers(page); await beginProbe(page, "f0000");
    await page.evaluate(() => {
      const chain = node => { const nodes = []; for (; node; node = node.parentNode) nodes.push(node); return nodes; };
      const card = document.querySelector('.work-card[data-work-id="f0000"]');
      window.__favoriteReplacementProbe = { card, button: card.querySelector(".favorite-button"), image: card.querySelector("img"), input: document.querySelector("#workSearch"),
        chains: [chain(card), chain(card.querySelector(".favorite-button")), chain(card.querySelector("img")), chain(document.querySelector("#workSearch"))], url: location.href };
    });
  }
  async function assertFavoriteReplacementProbe(page, draft) {
    const metrics = await finishProbe(page);
    assert.equal(metrics.retainedCards, 1); assert.equal(metrics.addedGridElements, 0); assert.equal(metrics.srcAssignments, 0);
    assert.equal(await page.evaluate(() => {
      const probe = __favoriteReplacementProbe, card = document.querySelector('.work-card[data-work-id="f0000"]');
      return probe.card === card && probe.button === card.querySelector(".favorite-button") && probe.image === card.querySelector("img")
        && probe.input === document.querySelector("#workSearch") && probe.url === location.href
        && probe.chains.every(chain => chain.every((node, index) => node.isConnected && (!index || chain[index - 1].parentNode === node)));
    }), true, "favorite settlement must retain the replacement card, cover, input ancestry and route");
    assert.deepEqual(await page.locator("#workSearch").evaluate(node => [node.value, node.selectionStart, node.selectionEnd, node.selectionDirection, node === document.activeElement]), draft,
      "favorite settlement must preserve the newer draft, caret and input focus");
  }
  async function favoritePendingSafety(page, writes) {
    assert.deepEqual(runtime.favoritePendingRejected, []);
    assert.deepEqual(runtime.favoritePendingApi.filter(call => !["GET", "HEAD"].includes(call.method)).map(call => `${call.method} ${call.path}`), writes,
      "favorite pending cases must issue only their explicit synthetic favorite and folder mutations");
    assert.deepEqual(await page.evaluate(() => __alerts), []);
  }
  async function verifyFavoritePendingReplacement() {
    for (const failed of [false, true]) {
      const page = await newFavoritePendingPage(), pending = deferred();
      runtime.mutation = { ...pending, error: failed ? "Synthetic replaced favorite failure" : "" };
      try {
        await openSearch(page, "small"); await loadAll(page, 30);
        const origin = await star(page, "f0000").elementHandle(); await origin.focus(); await origin.press("Enter"); await pending.requested;
        await assertFavoritePending(page, "取消收藏", "the original favorite star must remain pending until its toggle settles");
        await openSearch(page, "same-id");
        assert.equal(await origin.evaluate(node => node.isConnected), false);
        await assertFavoritePending(page, "收藏", "replacement favorite star must reflect the outstanding same-work toggle");
        await clickDisabledFavorite(page);
        await beginFavoriteReplacementProbe(page);
        const draft = ["稍后继续查找中文草稿", 2, 7, "backward", true];
        await page.locator("#workSearch").fill(draft[0]); await page.locator("#workSearch").evaluate(input => input.setSelectionRange(2, 7, "backward"));
        await releaseMutation(page, pending);
        await assertFavoriteReplacementProbe(page, draft);
        const button = star(page, "f0000");
        assert.equal(await button.isDisabled(), false); assert.equal(await button.evaluate(node => node.classList.contains("pending")), false);
        assert.equal(await button.getAttribute("aria-label"), failed ? "收藏" : "取消收藏");
        assert.equal(await button.evaluate(node => node.classList.contains("active")), !failed);
        assert.equal(runtime.favorites.has("f0000"), !failed); assert.equal(runtime.posts, 1);

        // Deliberately controlled dispatch on the retired node checks its owner guard; this is not a native interaction.
        await origin.evaluate(node => node.dispatchEvent(new MouseEvent("click", { bubbles: true }))); await pendingResponse(page);
        assert.equal(runtime.posts, 1, "a retired favorite node must not start another toggle after its original write finishes");
        assert.deepEqual(await page.locator("#workSearch").evaluate(node => [node.value, node.selectionStart, node.selectionEnd, node.selectionDirection, node === document.activeElement]), draft);
        runtime.mutation = null;
        const completed = page.waitForResponse(response => response.request().method() === "POST" && new URL(response.url()).pathname === "/api/favorites/f0000");
        await button.focus(); await button.press("Enter"); await (await completed).finished(); await pendingResponse(page);
        assert.equal(runtime.posts, 2, "the current favorite star must accept exactly one later native Enter toggle");
        assert.equal(await button.getAttribute("aria-label"), failed ? "取消收藏" : "收藏");
        assert.equal(runtime.favorites.has("f0000"), failed); assert.equal(await button.isDisabled(), false);
        await favoritePendingSafety(page, ["POST /api/favorites/f0000", "POST /api/favorites/f0000"]);
      } finally { pending.release(); await page.close(); }
    }
    const page = await newFavoritePendingPage(true, true), pending = deferred(); runtime.mutation = pending;
    try {
      await page.goto(`${base}/fanhao/favorites`); await star(page, "f0000").waitFor();
      await star(page, "f0000").focus(); await star(page, "f0000").press("Enter"); await pending.requested;
      await assertFavoritePending(page, "收藏", "the original favorite star must remain pending until its toggle settles");
      runtime.mutation = null;
      const folderResponse = page.waitForResponse(response => response.request().method() === "PUT" && new URL(response.url()).pathname === "/api/favorites/f0000/folder");
      await page.locator('.work-card[data-work-id="f0000"] .favorite-folder-select').selectOption("later");
      await (await folderResponse).finished(); await pendingResponse(page);
      assert.equal(runtime.folderIds.get("f0000"), "later"); assert.equal(runtime.puts, 1);
      await assertFavoritePending(page, "收藏", "a favorite-folder receipt must preserve the same-work favorite pending star");
      await clickDisabledFavorite(page);
      await releaseMutation(page, pending);
      assert.equal(await star(page, "f0000").count(), 0, "the confirmed cancellation must remove its card from the current favorites list");
      assert.equal(runtime.posts, 1); assert.equal(runtime.favorites.has("f0000"), false);
      await favoritePendingSafety(page, ["POST /api/favorites/f0000", "PUT /api/favorites/f0000/folder"]);
    } finally { pending.release(); await page.close(); }
  }
  async function favoriteFeedback(page, cause) {
    const root = '.work-card[data-work-id="f0000"] .favorite-error';
    assert.equal(await page.locator(root).count(), 1, "a current favorite failure must keep its uncertain result and cause visible");
    const panel = await page.locator(root).elementHandle(), message = await page.locator(`${root} .favorite-error-message`).elementHandle(), dismiss = await page.locator(`${root} .favorite-error-dismiss`).elementHandle();
    assert(panel && message && dismiss);
    assert.equal(await message.textContent(), cause, "favorite failure causes must remain complete plain text");
    assert.equal(await message.getAttribute("role"), "alert"); assert.equal(await message.evaluate(node => node.tabIndex), 0);
    assert.equal(await page.locator(`${root} img, ${root} script`).count(), 0, "favorite failure causes must never become HTML");
    assert.match(await panel.textContent(), /收藏操作未确认/); assert.match(await panel.textContent(), /可刷新页面核对当前收藏状态/);
    assert.equal(await dismiss.getAttribute("aria-label"), "关闭收藏操作未确认提示"); assert.equal(await dismiss.evaluate(node => node.disabled), false);
    const id = await message.getAttribute("id"); assert(id);
    assert.equal(await star(page, "f0000").getAttribute("aria-describedby"), id); assert.equal(await dismiss.getAttribute("aria-describedby"), id);
    assert.equal(await page.locator(`${root} button`).count(), 1, "favorite feedback must offer dismissal without a blind retry toggle");
    assert.deepEqual(await page.evaluate(() => __alerts), []);
    return { panel, message, dismiss };
  }
  async function assertSameFavoriteFeedback(feedback) {
    for (const [handle, selector] of [[feedback.panel, ".favorite-error"], [feedback.message, ".favorite-error-message"], [feedback.dismiss, ".favorite-error-dismiss"]]) {
      assert.equal(await handle.evaluate((node, selector) => node.isConnected && node === document.querySelector(`.work-card[data-work-id="f0000"] ${selector}`), selector), true,
        "repeated favorite failures must retain their original feedback nodes");
    }
  }
  async function captureFavoriteFailureRetention(page) {
    await star(page, "f0000").scrollIntoViewIfNeeded();
    await page.waitForFunction(() => { const image = document.querySelector('.work-card[data-work-id="f0000"] img'); return image?.complete && image.naturalWidth > 0; });
    await settleCovers(page); await beginProbe(page, "f0000");
    await page.evaluate(() => {
      const card = document.querySelector('.work-card[data-work-id="f0000"]'), button = card.querySelector(".favorite-button"), input = document.querySelector("#workSearch");
      const chain = node => { const items = []; for (; node; node = node.parentNode) items.push([node, node.parentNode]); return items; };
      window.__favoriteFailureRetention = { card, button, input, chains: [chain(card), chain(button), chain(input), chain(card.querySelector("img"))], url: location.href };
    });
  }
  async function assertFavoriteFailureRetention(page, draft) {
    assert.equal(await page.evaluate(() => {
      const p = __favoriteFailureRetention;
      return p.card === document.querySelector('.work-card[data-work-id="f0000"]') && p.button === p.card.querySelector(".favorite-button")
        && p.input === document.querySelector("#workSearch") && location.href === p.url
        && p.chains.every(chain => chain.every(([node, parent]) => node.isConnected && node.parentNode === parent));
    }), true, "favorite feedback must retain the original card, cover, controls, input ancestry and route");
    if (draft) assert.deepEqual(await page.locator("#workSearch").evaluate(node => [node.value, node.selectionStart, node.selectionEnd, node.selectionDirection, node === document.activeElement]), draft,
      "favorite feedback must preserve a newer input draft, caret and focus");
  }
  async function nativeFavoritePost(page) {
    const response = page.waitForResponse(item => item.request().method() === "POST" && new URL(item.url()).pathname === "/api/favorites/f0000");
    await star(page, "f0000").focus(); await star(page, "f0000").press("Enter"); await (await response).finished(); await pendingResponse(page);
  }
  async function verifyFavoriteFailureFeedback() {
    const page = await newFavoritePendingPage(), first = deferred(), repeated = deferred(), saved = deferred();
    const cause = '<img src=x onerror="throw new Error(1)"> 收藏未确认首段\n' + "长原因内容，保留完整信息并允许键盘查看。".repeat(100) + "\n收藏未确认尾段";
    runtime.mutation = { ...first, error: cause };
    try {
      await openSearch(page, "small"); await loadAll(page, 30); await captureFavoriteFailureRetention(page);
      const reads = runtime.reads.length;
      await star(page, "f0000").focus(); await star(page, "f0000").press("Enter"); await first.requested;
      const draft = ["后来继续查找的中文草稿", 1, 7, "backward", true];
      await page.locator("#workSearch").fill(draft[0]); await page.locator("#workSearch").evaluate(input => input.setSelectionRange(1, 7, "backward"));
      await releaseMutation(page, first); await assertFavoriteFailureRetention(page, draft);
      const feedback = await favoriteFeedback(page, cause);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true, "long favorite causes must fit a 320px viewport");
      const size = await feedback.dismiss.boundingBox(); assert(size && size.width >= 44 && size.height >= 44, "favorite feedback dismissal must retain a 44px target");
      assert.equal(await feedback.message.evaluate(node => node.scrollHeight > node.clientHeight + 1), true, "long favorite causes need their own scrollable region");
      await feedback.message.focus(); await page.keyboard.press("End");
      await page.waitForFunction(() => document.querySelector(".favorite-error-message").scrollTop > 0); await pendingResponse(page);
      assert.equal(await feedback.message.evaluate(node => document.activeElement === node && node.scrollTop > 0), true, "native End must expose the end of the long favorite cause");
      await page.keyboard.press("Home");
      await page.waitForFunction(() => document.querySelector(".favorite-error-message").scrollTop === 0); await pendingResponse(page);
      assert.equal(await feedback.message.evaluate(node => document.activeElement === node && node.scrollTop === 0), true, "native Home must return to the start of the long favorite cause");

      runtime.mutation = { ...repeated, error: "Synthetic repeated favorite failure" };
      await star(page, "f0000").focus(); await star(page, "f0000").press("Enter"); await repeated.requested;
      await assertSameFavoriteFeedback(feedback); assert.equal(await feedback.message.textContent(), cause);
      assert.equal(await feedback.dismiss.getAttribute("aria-disabled"), "true"); assert.equal(await feedback.dismiss.getAttribute("aria-busy"), "true");
      await feedback.dismiss.focus(); await feedback.dismiss.press("Enter"); await pendingResponse(page);
      assert.equal(runtime.posts, 2, "a busy favorite dismissal must not send a toggle or clear the existing cause");
      assert.equal(await page.locator(".favorite-error").count(), 1, "a busy favorite dismissal must retain its existing feedback");
      await assertSameFavoriteFeedback(feedback); assert.equal(await feedback.message.textContent(), cause);
      await page.locator("#workSearch").fill(draft[0]); await page.locator("#workSearch").evaluate(input => input.setSelectionRange(1, 7, "backward"));
      await releaseMutation(page, repeated); await assertSameFavoriteFeedback(feedback);
      assert.equal(await feedback.message.textContent(), "Synthetic repeated favorite failure", "a repeated favorite failure must update the original cause node");
      await favoriteFeedback(page, "Synthetic repeated favorite failure"); await assertFavoriteFailureRetention(page, draft);
      assert.equal(await feedback.dismiss.getAttribute("aria-disabled"), "false"); assert.equal(await feedback.dismiss.getAttribute("aria-busy"), "false");

      const apiBeforeDismiss = runtime.favoritePendingApi.length;
      await feedback.dismiss.focus(); await feedback.dismiss.press("Enter"); await pendingResponse(page);
      assert.equal(await page.locator(".favorite-error").count(), 0, "explicit favorite dismissal must remove its feedback");
      assert.equal(await star(page, "f0000").getAttribute("aria-describedby"), null);
      assert.equal(await star(page, "f0000").evaluate(node => node === document.activeElement), true);
      assert.equal(runtime.favoritePendingApi.length, apiBeforeDismiss, "favorite dismissal must never issue an API request");
      const beforeRetired = await querySurface(page);
      await feedback.dismiss.evaluate(node => node.dispatchEvent(new MouseEvent("click", { bubbles: true }))); await pendingResponse(page);
      assert.deepEqual(await querySurface(page), beforeRetired); assert.equal(runtime.favoritePendingApi.length, apiBeforeDismiss);

      runtime.mutation = { error: "Synthetic final favorite failure" }; await nativeFavoritePost(page);
      const final = await favoriteFeedback(page, "Synthetic final favorite failure"); runtime.mutation = saved;
      await star(page, "f0000").focus(); await star(page, "f0000").press("Enter"); await saved.requested;
      await assertSameFavoriteFeedback(final); assert.equal(await final.dismiss.getAttribute("aria-busy"), "true");
      await page.locator("#workSearch").fill(draft[0]); await page.locator("#workSearch").evaluate(input => input.setSelectionRange(1, 7, "backward"));
      await releaseMutation(page, saved);
      assert.equal(await page.locator(".favorite-error").count(), 0, "a confirmed favorite success must clear previous failure feedback");
      assert.equal(await star(page, "f0000").getAttribute("aria-describedby"), null); await assertFavoriteFailureRetention(page, draft);
      assert.equal(await star(page, "f0000").getAttribute("aria-label"), "取消收藏"); assert.equal(runtime.favorites.has("f0000"), true);
      const metrics = await finishProbe(page);
      assert.equal(metrics.retainedCards, 30); assert.equal(metrics.retainedImages, metrics.initialImages); assert.equal(metrics.srcAssignments, 0);
      assert.equal(metrics.addedGridElements, metrics.addedFavoriteErrorElements, "favorite recovery may create only its own feedback subtree");
      assert.equal(runtime.reads.length, reads, "favorite feedback and dismissal must not automatically reload data");
      await favoritePendingSafety(page, Array(4).fill("POST /api/favorites/f0000"));
    } finally { first.release(); repeated.release(); saved.release(); await page.close(); }
    await verifyFavoriteFeedbackCleanupFocus(); await verifyFavoriteFailurePendingHistory(true);
  }
  async function verifyFavoriteFeedbackCleanupFocus() {
    for (const wheel of [false, true]) {
      const page = await newFavoritePendingPage(), saved = deferred(); runtime.mutation = { error: "Synthetic favorite cleanup failure" };
      try {
        await openSearch(page, "small"); await nativeFavoritePost(page); const feedback = await favoriteFeedback(page, "Synthetic favorite cleanup failure");
        runtime.mutation = saved;
        await star(page, "f0000").focus(); await star(page, "f0000").press("Enter"); await saved.requested;
        await feedback.dismiss.focus(); assert.equal(await feedback.dismiss.evaluate(node => node === document.activeElement && !node.disabled), true);
        if (wheel) {
          const beforeWheel = await page.evaluate(() => scrollY);
          await page.mouse.move(318, 348); await page.mouse.wheel(0, 240);
          await page.waitForFunction(before => scrollY > before + 1, beforeWheel);
          await page.evaluate(() => new Promise(resolve => {
            let previous = scrollY, stable = 0, frames = 0;
            const frame = () => { const next = scrollY; stable = Math.abs(next - previous) < .5 ? stable + 1 : 0; previous = next;
              if (stable >= 6 || ++frames >= 90) resolve(); else requestAnimationFrame(frame); };
            requestAnimationFrame(frame);
          }));
        }
        await releaseMutation(page, saved);
        assert.equal(await page.locator(".favorite-error").count(), 0);
        const layout = await star(page, "f0000").evaluate(node => {
          const rect = node.getBoundingClientRect(), header = document.querySelector(".product-topbar").getBoundingClientRect();
          return { focused: node === document.activeElement, top: rect.top, bottom: rect.bottom, header: header.bottom, height: innerHeight };
        });
        assert.equal(layout.focused, true, "successful cleanup may restore the star only while focus remains in its panel");
        if (wheel) assert(layout.bottom <= layout.header + 1, "a later wheel gesture must prevent favorite cleanup from revealing its star");
        else assert(layout.top >= layout.header - 1 && layout.bottom <= layout.height + 1, "favorite cleanup must reveal its restored star below the sticky header");
        await favoritePendingSafety(page, Array(2).fill("POST /api/favorites/f0000"));
      } finally { saved.release(); await page.close(); }
    }
  }
  async function verifyFavoriteFailurePendingHistory(existingFeedback = false) {
    const page = await newFavoritePendingPage(), library = deferred(), pending = deferred(), cause = "Synthetic obsolete mounted favorite failure";
    runtime.libraryRead = library; runtime.mutation = existingFeedback ? { error: cause } : { ...pending, error: cause };
    try {
      await page.addInitScript(() => {
        if (location.pathname === "/fanhao" && location.search === "?q=small") {
          history.replaceState(null, "", "/fanhao"); history.pushState(null, "", "/fanhao?q=small");
        }
      });
      await page.goto(`${base}/fanhao?q=small`); await star(page, "f0000").waitFor(); await library.requested;
      const control = await star(page, "f0000").elementHandle(); let feedback;
      if (existingFeedback) { await nativeFavoritePost(page); feedback = await favoriteFeedback(page, cause); }
      else { await control.focus(); await control.press("Enter"); await pending.requested; }
      await page.goBack({ waitUntil: "commit" }); await pendingResponse(page);
      assert.equal(new URL(page.url()).search, ""); assert.equal(await control.evaluate(node => node.isConnected), true, "pending library history must leave the obsolete favorite card mounted");
      await page.locator("#workSearch").fill("历史导航之后的中文草稿"); await page.locator("#workSearch").evaluate(node => node.setSelectionRange(1, 6, "backward"));
      if (existingFeedback) await feedback.dismiss.focus();
      const before = await querySurface(page), reads = runtime.reads.length, calls = runtime.favoritePendingApi.length;
      if (existingFeedback) { await feedback.dismiss.press("Enter"); await pendingResponse(page); }
      else await releaseMutation(page, pending);
      assert.deepEqual(await querySurface(page), before, existingFeedback ? "an obsolete mounted favorite dismissal must not clear its old owner's feedback" : "an obsolete favorite failure must not publish feedback during newer pending history navigation");
      assert.equal(runtime.reads.length, reads); assert.equal(runtime.favoritePendingApi.length, calls);
      assert.equal(await page.locator(".favorite-error").count(), existingFeedback ? 1 : 0);
      library.release(); await page.locator(".person-index-card").waitFor();
      await favoritePendingSafety(page, ["POST /api/favorites/f0000"]);
    } finally { pending.release(); library.release(); await page.close(); }
  }
  async function folderFeedback(page, cause) {
    const root = '.work-card[data-work-id="f0000"] .favorite-folder-error';
    assert.equal(await page.locator(root).count(), 1, "a current favorite-folder failure must keep its cause and explicit retry visible");
    const panel = await page.locator(root).elementHandle(), message = await page.locator(`${root} .favorite-folder-error-message`).elementHandle(), retry = await page.locator(`${root} .favorite-folder-retry`).elementHandle();
    assert(panel && message && retry); assert.equal(await message.textContent(), cause); assert.equal(await message.getAttribute("role"), "alert");
    assert.equal(await retry.getAttribute("aria-label"), "重试移动收藏夹"); assert.equal(await retry.evaluate(node => node.disabled), false);
    assert.deepEqual(await page.evaluate(() => __alerts), [], "favorite-folder recovery must not open a blocking alert");
    return { panel, message, retry };
  }
  async function assertSameFolderFeedback(feedback) {
    for (const [handle, selector] of [[feedback.panel, ".favorite-folder-error"], [feedback.message, ".favorite-folder-error-message"], [feedback.retry, ".favorite-folder-retry"]]) {
      assert.equal(await handle.evaluate((node, selector) => node.isConnected && node === document.querySelector(`.work-card[data-work-id="f0000"] ${selector}`), selector), true, "folder retries must retain their original recovery nodes");
    }
  }
  async function captureFolderRetention(page) {
    await page.evaluate(() => {
      const card = document.querySelector('.work-card[data-work-id="f0000"]'), select = card.querySelector(".favorite-folder-select"), chain = [];
      for (let node = select; node; node = node.parentElement) chain.push([node, node.parentNode]);
      const transform = getComputedStyle(card).transform, translateY = transform === "none" ? 0 : new DOMMatrixReadOnly(transform).m42;
      const active = document.activeElement;
      window.__folderRecovery = { card, select, chain, cards: [...document.querySelectorAll("#workGrid .work-card")], images: [...document.querySelectorAll("#workGrid .work-card img")], documentTop: card.getBoundingClientRect().top + scrollY - translateY,
        beforeMove: { time: performance.now(), selectFocused: active === select, documentHasFocus: document.hasFocus(), visibility: document.visibilityState,
          disabled: select.disabled, value: select.value.slice(0, 128), url: location.href.slice(0, 1024), scrollY, active: { tag: active?.tagName, id: active?.id?.slice(0, 128), className: String(active?.className || "").slice(0, 256) } } };
      window.__favoriteProbe = { createdElements: 0, srcAssignments: 0 };
    });
  }
  async function assertFolderRetention(page) {
    const result = await page.evaluate(() => {
      const probe = __folderRecovery;
      const transform = getComputedStyle(probe.card).transform, translateY = transform === "none" ? 0 : new DOMMatrixReadOnly(transform).m42;
      return { card: probe.card.isConnected && probe.card === document.querySelector('.work-card[data-work-id="f0000"]'),
        select: probe.select.isConnected && probe.select === probe.card.querySelector(".favorite-folder-select"),
        chain: probe.chain.every(([node, parent]) => node.isConnected && node.parentNode === parent),
        cards: probe.cards.every(node => node.isConnected), images: probe.images.every(node => node.isConnected),
        documentDelta: probe.card.getBoundingClientRect().top + scrollY - translateY - probe.documentTop, srcAssignments: __favoriteProbe.srcAssignments };
    });
    assert(result.card && result.select && result.chain && result.cards && result.images, "favorite-folder recovery must retain original cards, covers, select and ancestor chain");
    assert.equal(result.srcAssignments, 0, "favorite-folder recovery must not reassign settled cover sources");
    assert(Math.abs(result.documentDelta) < 1, "favorite-folder recovery must retain the original card's document anchor");
  }
  async function waitFolderMove(page, action) {
    const completed = page.waitForResponse(response => response.request().method() === "PUT" && /\/api\/favorites\/f\d+\/folder$/.test(new URL(response.url()).pathname));
    await action(); await (await completed).finished(); await pendingResponse(page);
  }
  async function verifyFavoriteFolderRetryViewport() {
    const modes = ["retry", "reason", "input", "wheel", "page-down", "repeated", "browser-scroll", "repeated-pointer"];
    assert(!folderRetryMode || modes.includes(folderRetryMode), "folder retry fixtures must select a known semantic mode");
    for (const mode of modes.filter(value => !folderRetryMode || value === folderRetryMode)) {
      const page = await newPage(30, true, 320), saved = deferred(), tabs = [], dialogs = [], faultStart = faults.length;
      await page.setViewportSize({ width: 320, height: 360 });
      Object.assign(runtime, { folderRetryOnly: true, folderRetryApi: [], folderRetryRejected: [], mutation: { error: "Synthetic native folder retry failure" } });
      page.on("dialog", async dialog => { dialogs.push({ type: dialog.type(), message: dialog.message() }); await dialog.dismiss(); });
      const owned = ["retry", "reason", "repeated", "browser-scroll", "repeated-pointer"].includes(mode);
      const capture = phase => page.evaluate(phase => {
        const original = __nativeFolderRetryOriginal, control = original.control, card = original.card, input = original.input, rect = control.getBoundingClientRect(), header = document.querySelector(".product-topbar").getBoundingClientRect();
        const translation = node => { const value = getComputedStyle(node).transform; return value === "none" ? 0 : new DOMMatrixReadOnly(value).m42; };
        const retry = card.querySelector(".favorite-folder-retry"), reason = card.querySelector(".favorite-folder-error-message"), anchor = window.__nativeFolderRetryViewport;
        const hit = document.elementFromPoint((rect.left + rect.right) / 2, (rect.top + rect.bottom) / 2), cardTranslate = translation(card);
        return { phase, active: { tag: document.activeElement.tagName, className: String(document.activeElement.className).slice(0, 256) },
          activeIsControl: document.activeElement === control, activeIsBody: document.activeElement === document.body, activeIsInput: document.activeElement === input, activeIsRetry: document.activeElement === retry, activeIsReason: document.activeElement === reason,
          disabled: control.disabled, value: control.value, sameControl: control === document.querySelector('.work-card[data-work-id="f0000"] .favorite-folder-select'), sameCard: card === control.closest(".work-card"),
          controlChain: original.controlChain.every(([node, parent]) => node.isConnected && node.parentNode === parent), sameInput: input === document.querySelector("#workSearch"), inputChain: original.inputChain.every(([node, parent]) => node.isConnected && node.parentNode === parent),
          inputState: [input.value, input.selectionStart, input.selectionEnd, input.selectionDirection], originalMountedCards: original.cards.length, connectedOriginalCards: original.cards.filter(node => node.isConnected).length,
          allOriginalCardsConnected: original.cards.every(node => node.isConnected), allOriginalImagesConnected: original.images.every(node => node.isConnected),
          cardDocumentTop: card.getBoundingClientRect().top + scrollY - cardTranslate, originalCardDocumentTop: original.cardDocumentTop,
          controlDocumentTop: rect.top + scrollY - cardTranslate - translation(control), originalControlDocumentTop: original.controlDocumentTop,
          rect: { top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right }, headerBottom: header.bottom, viewport: { width: innerWidth, height: innerHeight }, centerHit: hit === control || control.contains(hit),
          scrollY, anchor: anchor ? { id: anchor.dataset.workId, connected: anchor.isConnected, top: anchor.getBoundingClientRect().top - translation(anchor) } : null,
          feedbackRemaining: !!card.querySelector(".favorite-folder-error"), alerts: [...__alerts] };
      }, phase);
      try {
        await page.goto(`${base}/fanhao/favorites`); const control = page.locator('.work-card[data-work-id="f0000"] .favorite-folder-select'); await control.waitFor();
        await page.evaluate(() => {
          const control = document.querySelector('.work-card[data-work-id="f0000"] .favorite-folder-select'), card = control.closest(".work-card"), input = document.querySelector("#workSearch");
          const chain = node => { const result = []; for (; node; node = node.parentElement) result.push([node, node.parentNode]); return result; };
          const translation = node => { const value = getComputedStyle(node).transform; return value === "none" ? 0 : new DOMMatrixReadOnly(value).m42; };
          __nativeFolderRetryOriginal = { control, card, input, controlChain: chain(control), inputChain: chain(input), cards: [...document.querySelectorAll("#workGrid > .work-card")], images: [...document.querySelectorAll("#workGrid .work-card img")],
            cardDocumentTop: card.getBoundingClientRect().top + scrollY - translation(card), controlDocumentTop: control.getBoundingClientRect().top + scrollY - translation(card) - translation(control) };
        });
        await control.focus(); await waitFolderMove(page, () => page.keyboard.press("ArrowDown"));
        assert.equal(await control.inputValue(), "default"); assert.equal(await control.evaluate(node => node.disabled), false);
        const retry = page.locator('.work-card[data-work-id="f0000"] .favorite-folder-retry'); await retry.waitFor();
        for (let step = 0; step < 24 && !await retry.evaluate(node => node === document.activeElement); step++) {
          await page.keyboard.press("Tab"); tabs.push(await page.evaluate(() => ({ tag: document.activeElement.tagName, className: String(document.activeElement.className).slice(0, 256), scrollY })));
        }
        assert.equal(await retry.evaluate(node => node === document.activeElement), true, "native Tab must reach the confirmed folder failure retry");
        const url = page.url(), listReads = runtime.folderRetryApi.filter(call => call.method === "GET" && call.path === "/api/favorites").length;
        runtime.mutation = saved; await page.keyboard.press("Enter"); await saved.requested;
        assert.equal(await control.evaluate(node => node.disabled), true);
        if (mode === "reason") await page.keyboard.press("Shift+Tab");
        if (mode === "input") { await page.locator("#workSearch").fill("收藏夹重试期间的新中文草稿"); await page.locator("#workSearch").evaluate(node => node.setSelectionRange(1, 6, "backward")); }
        if (mode === "wheel") { await page.mouse.move(310, 320); await page.mouse.wheel(0, 96); }
        if (mode === "page-down") await page.keyboard.press("PageDown");
        if (mode === "repeated") { await page.keyboard.press("Enter"); await page.keyboard.press("Space"); }
        let scrollEvidence = null;
        if (mode === "browser-scroll" || mode === "repeated-pointer") {
          scrollEvidence = await page.evaluate(() => new Promise(resolve => {
            const control = document.querySelector('.work-card[data-work-id="f0000"] .favorite-folder-select'), rect = control.getBoundingClientRect(), headerBottom = document.querySelector(".product-topbar").getBoundingClientRect().bottom;
            let delta = rect.top - (headerBottom - 12); if (Math.abs(delta) < 1) delta += 8;
            const observe = event => { if (event.target !== document) return; document.removeEventListener("scroll", observe, true); resolve({ trusted: event.isTrusted, documentTarget: true, delta, headerBottom, selectTop: control.getBoundingClientRect().top, scrollY }); };
            document.addEventListener("scroll", observe, { capture: true }); window.scrollBy({ top: delta, left: 0, behavior: "instant" });
          }));
          assert.equal(scrollEvidence.trusted, true); assert.equal(scrollEvidence.documentTarget, true); assert(scrollEvidence.selectTop < scrollEvidence.headerBottom, "controlled browser-only scroll must expose the hidden-select recovery requirement");
        }
        if (mode === "repeated-pointer") {
          const target = await retry.evaluate(node => { const box = node.getBoundingClientRect(), x = (box.left + box.right) / 2, y = (box.top + box.bottom) / 2, hit = document.elementFromPoint(x, y); return { x, y, hit: hit === node || node.contains(hit) }; });
          assert.equal(target.hit, true, "the pending folder retry center must receive its actual repeated pointer activation"); await page.mouse.click(target.x, target.y);
        }
        const settled = await page.evaluate(() => new Promise(resolve => { let previous = scrollY, stable = 0, frames = 0; const frame = () => { stable = scrollY === previous ? stable + 1 : 0; previous = scrollY; frames++; if (stable >= 3 || frames >= 90) resolve(stable >= 3); else requestAnimationFrame(frame); }; requestAnimationFrame(frame); }));
        assert.equal(settled, true, "the native folder retry viewport must settle before ACK");
        await page.evaluate(() => { __nativeFolderRetryViewport = [...document.querySelectorAll("#workGrid > .work-card")].find(node => { const rect = node.getBoundingClientRect(); return rect.top >= 0 && rect.top < innerHeight; }) || null; });
        const beforeAck = await capture("before ACK");
        assert.deepEqual(runtime.folderWrites, [{ id: "f0000", folderId: "later" }, { id: "f0000", folderId: "later" }], "pending folder retry activation must preserve its explicit target and remain deduplicated");
        if (mode === "reason") assert.equal(beforeAck.activeIsReason, true); else if (mode === "input") assert.equal(beforeAck.activeIsInput, true); else assert.equal(beforeAck.activeIsRetry, true);
        await releaseMutation(page, saved, "PUT"); const afterAck = await capture("after ACK");
        const retained = afterAck.sameControl && afterAck.sameCard && afterAck.controlChain && afterAck.sameInput && afterAck.inputChain && afterAck.allOriginalCardsConnected && afterAck.allOriginalImagesConnected;
        const visible = afterAck.rect.top >= afterAck.headerBottom && afterAck.rect.bottom <= afterAck.viewport.height && afterAck.rect.left >= 0 && afterAck.rect.right <= afterAck.viewport.width && afterAck.centerHit;
        const viewportPreserved = Math.abs(afterAck.scrollY - beforeAck.scrollY) < 1 || beforeAck.anchor && afterAck.anchor && Math.abs(afterAck.anchor.top - beforeAck.anchor.top) < 1;
        const focusPreserved = owned ? afterAck.activeIsControl : mode === "input" ? afterAck.activeIsInput : afterAck.activeIsControl || afterAck.activeIsBody;
        const layoutPreserved = Math.abs(afterAck.cardDocumentTop - afterAck.originalCardDocumentTop) < 1 && Math.abs(afterAck.controlDocumentTop - beforeAck.controlDocumentTop) < 1;
        if (!retained || !focusPreserved || !layoutPreserved || owned && !visible || !owned && !viewportPreserved) {
          try { console.error("FAVORITE_FOLDER_RETRY_VIEWPORT_FAILURE", JSON.stringify({ mode, owned, visible, viewportPreserved, retained, focusPreserved, layoutPreserved, scrollEvidence, beforeAck, afterAck, tabs: tabs.slice(-24), writes: runtime.folderWrites.slice(-8),
            api: runtime.folderRetryApi.slice(-8).map(call => ({ method: call.method, path: String(call.path).slice(0, 256), query: String(call.query || "").slice(0, 128) })), rejected: runtime.folderRetryRejected.slice(-8), dialogs: dialogs.slice(-4), faults: faults.slice(faultStart).slice(-4).map(value => String(value).slice(0, 512)) })); }
          catch (error) { console.error("FAVORITE_FOLDER_RETRY_DIAGNOSTIC_FAILED", String(error?.message || error).slice(0, 512)); }
        }
        assert(retained, "folder retry cleanup must preserve original controls, cards, media and ancestor chains"); assert.equal(afterAck.connectedOriginalCards, afterAck.originalMountedCards);
        assert(layoutPreserved, "folder retry cleanup must preserve original document layout anchors");
        assert.equal(afterAck.value, "later"); assert.equal(afterAck.disabled, false); assert.equal(afterAck.feedbackRemaining, false); assert.deepEqual(afterAck.inputState, beforeAck.inputState);
        assert.deepEqual(runtime.folderWrites, [{ id: "f0000", folderId: "later" }, { id: "f0000", folderId: "later" }]); assert.equal(runtime.puts, 2); assert.equal(runtime.posts, 0); assert.equal(runtime.folderIds.get("f0000"), "later");
        assert.equal(runtime.folderRetryApi.filter(call => call.method === "GET" && call.path === "/api/favorites").length, listReads); assert.equal(page.url(), url); assert.deepEqual(runtime.folderRetryRejected, []); assert.deepEqual(afterAck.alerts, []); assert.deepEqual(dialogs, []); assert.deepEqual(faults.slice(faultStart), []);
        if (owned) { assert.equal(afterAck.activeIsControl, true); assert(visible, "restored folder retry control must be fully visible below the sticky header"); }
        else { if (beforeAck.anchor) assert.equal(afterAck.anchor?.connected, true); assert(viewportPreserved, "new viewport intent must survive successful folder retry cleanup"); assert(focusPreserved); }
      } finally { saved.release(); await page.close(); }
    }
  }
  async function verifyFavoriteFolderCurrentFailure() {
    const page = await newPage(3, true, 320), pending = deferred(), saved = deferred();
    const cause = `Synthetic current folder failure：${"收藏夹目录暂时不可用，请检查后重试。".repeat(12)}${"LONG_UNBROKEN_FOLDER_CAUSE_".repeat(16)}最终原因`;
    runtime.mutation = { ...pending, error: cause };
    try {
      await page.goto(`${base}/fanhao/favorites`); const select = page.locator('.work-card[data-work-id="f0000"] .favorite-folder-select'); await select.focus();
      await captureFolderRetention(page); const reads = runtime.reads.length, url = page.url();
      await select.selectOption("later"); await pending.requested; assert.equal(await select.evaluate(node => node.disabled), true);
      const input = page.locator("#workSearch"); await input.fill("收藏夹失败后更晚的中文草稿"); await input.evaluate(node => node.setSelectionRange(1, 6, "backward"));
      const draft = await input.evaluate(node => [node.value, node.selectionStart, node.selectionEnd, node.selectionDirection, node === document.activeElement]);
      await releaseMutation(page, pending, "PUT");
      assert.equal(await select.inputValue(), "default"); assert.equal(await select.evaluate(node => node.disabled), false);
      assert.equal(runtime.folderIds.get("f0000") || "default", "default"); await assertFolderRetention(page);
      assert.deepEqual(await input.evaluate(node => [node.value, node.selectionStart, node.selectionEnd, node.selectionDirection, node === document.activeElement]), draft, "folder failure must preserve a newer raw draft and input focus after restoring the confirmed selection");
      const feedback = await folderFeedback(page, cause);
      const geometry = await feedback.message.evaluate(node => ({ width: node.clientWidth, scrollWidth: node.scrollWidth, height: node.clientHeight, scrollHeight: node.scrollHeight,
        left: node.getBoundingClientRect().left, right: node.getBoundingClientRect().right, viewport: innerWidth, pageWidth: document.documentElement.scrollWidth }));
      assert(geometry.height > 0 && geometry.scrollHeight > geometry.height, "long folder causes must remain available in a visible scrollable recovery region");
      assert(geometry.scrollWidth <= geometry.width + 1 && geometry.left >= 0 && geometry.right <= geometry.viewport + 1 && geometry.pageWidth <= geometry.viewport + 1, "long folder causes must wrap without horizontal overflow at 320px");
      await feedback.message.focus(); await feedback.message.press("End");
      await page.waitForFunction(() => { const node = document.querySelector(".favorite-folder-error-message"); return node.scrollTop > 0 && node.scrollTop + node.clientHeight >= node.scrollHeight - 2; });
      await feedback.message.press("Home"); await page.waitForFunction(() => document.querySelector(".favorite-folder-error-message").scrollTop <= 1);
      assert.equal(await feedback.message.textContent(), cause);
      const hit = await feedback.retry.evaluate(node => ({ width: node.getBoundingClientRect().width, height: node.getBoundingClientRect().height }));
      assert(hit.width >= 44 && hit.height >= 44, "the native folder retry must retain a 44px touch target");
      runtime.mutation = saved; await feedback.retry.focus(); await feedback.retry.press("Enter"); await saved.requested;
      await assertSameFolderFeedback(feedback); assert.equal(await feedback.message.textContent(), cause);
      assert.equal(await feedback.retry.getAttribute("aria-disabled"), "true"); assert.equal(await feedback.retry.getAttribute("aria-busy"), "true"); assert.equal(await feedback.retry.evaluate(node => node.disabled), false);
      assert.equal(await select.evaluate(node => node.disabled), true); assert.equal(await select.inputValue(), "default");
      await feedback.retry.press("Enter"); await feedback.retry.press("Space"); await pendingResponse(page);
      assert.deepEqual(runtime.folderWrites.map(write => write.folderId), ["later", "later"], "a pending folder retry must retain its failed explicit target and suppress repeated activation");
      assert.equal(runtime.folderIds.get("f0000") || "default", "default");
      await releaseMutation(page, saved, "PUT");
      assert.equal(await select.inputValue(), "later"); assert.equal(await select.evaluate(node => node.disabled), false);
      assert.equal(await select.evaluate(node => node === document.activeElement), true, "a successful focused folder retry must restore the enabled original select");
      assert.equal(await feedback.panel.evaluate(node => node.isConnected), false); assert.equal(await select.getAttribute("aria-describedby"), null);
      assert.equal(runtime.folderIds.get("f0000"), "later"); assert.equal(runtime.puts, 2); assert.equal(runtime.reads.length, reads); assert.equal(page.url(), url);
      await assertFolderRetention(page); assert.deepEqual(await page.evaluate(() => __alerts), []);
    } finally { pending.release(); saved.release(); await page.close(); }
    await verifyFavoriteFolderRepeatedFailure(); await verifyFavoriteFolderRetiredRetry();
  }
  async function verifyFavoriteFolderRepeatedFailure() {
    for (const focusTarget of ["input", "message"]) {
      const page = await newPage(3, true, 320), repeated = deferred(), saved = deferred(); runtime.mutation = { error: "Synthetic initial folder retry failure" };
      try {
        await page.goto(`${base}/fanhao/favorites`); const select = page.locator('.work-card[data-work-id="f0000"] .favorite-folder-select'); await select.focus(); await captureFolderRetention(page);
        await waitFolderMove(page, () => select.selectOption("later")); assert.equal(await select.inputValue(), "default");
        const initialSelectFocused = await select.evaluate(node => node === document.activeElement);
        if (!initialSelectFocused) {
          try {
            const surface = await page.evaluate(() => {
              const probe = window.__folderRecovery, grid = document.querySelector("#workGrid"), card = grid?.querySelector('.work-card[data-work-id="f0000"]');
              const current = card?.querySelector(".favorite-folder-select"), original = probe?.select, active = document.activeElement, input = document.querySelector("#workSearch");
              const selectInfo = node => node ? { connected: node.isConnected, inGrid: grid?.contains(node), disabled: node.disabled, value: node.value.slice(0, 128),
                workId: node.closest(".work-card")?.dataset.workId?.slice(0, 128), focused: node === active } : null;
              return { time: performance.now(), beforeMove: probe?.beforeMove || null, url: location.href.slice(0, 1024), documentHasFocus: document.hasFocus(), visibility: document.visibilityState,
                scrollY, documentHeight: document.documentElement.scrollHeight, maxScroll: Math.max(0, document.documentElement.scrollHeight - innerHeight),
                originalSelect: selectInfo(original), currentSelect: selectInfo(current), sameSelect: original === current, sameCard: probe?.card === card,
                active: { tag: active?.tagName, id: active?.id?.slice(0, 128), className: String(active?.className || "").slice(0, 256), html: active?.outerHTML?.slice(0, 512),
                  isInput: active === input, isRetry: active === card?.querySelector(".favorite-folder-retry"), isReason: active === card?.querySelector(".favorite-folder-error-message") },
                draft: input ? { value: input.value.slice(0, 2048), start: input.selectionStart, end: input.selectionEnd, direction: input.selectionDirection } : null,
                grid: { cards: grid?.querySelectorAll(".work-card").length, folderErrors: grid?.querySelectorAll(".favorite-folder-error").length, text: grid?.textContent?.slice(0, 1024) },
                cardHtml: card?.outerHTML.slice(0, 4096), ownerClosureFlags: "unavailable from the DOM" };
            });
            console.error("FAVORITE_FOLDER_INITIAL_FOCUS_FAILURE", JSON.stringify({ phase: "after-initial-folder-failure", focusTarget, surface,
              puts: runtime.puts, putBodies: runtime.folderWrites.slice(-8).map(write => ({ id: String(write.id).slice(0, 128), folderId: String(write.folderId).slice(0, 128) })),
              reads: runtime.reads.length, lastReads: runtime.reads.slice(-8).map(read => ({ path: String(read.path).slice(0, 256), query: String(read.query || "").slice(0, 128), offset: read.offset, limit: read.limit })),
              faults: faults.slice(-4).map(message => String(message).slice(0, 512)) }));
          } catch (error) {
            console.error("FAVORITE_FOLDER_INITIAL_FOCUS_DIAGNOSTIC_FAILED", JSON.stringify({ phase: "after-initial-folder-failure", focusTarget, error: String(error?.message || error).slice(0, 512) }));
          }
        }
        assert.equal(initialSelectFocused, true, "a current folder failure must restore its original select focus when no newer intent intervenes");
        const feedback = await folderFeedback(page, "Synthetic initial folder retry failure"); runtime.mutation = { ...repeated, error: "Synthetic repeated folder retry failure" };
        const url = page.url(), pages = browser.contexts().flatMap(context => context.pages()).length;
        await feedback.retry.click(); await repeated.requested; await assertSameFolderFeedback(feedback); await releaseMutation(page, repeated, "PUT");
        await assertSameFolderFeedback(feedback); assert.equal(await feedback.message.textContent(), "Synthetic repeated folder retry failure"); assert.equal(await select.inputValue(), "default");
        assert.equal(page.url(), url); assert.equal(browser.contexts().flatMap(context => context.pages()).length, pages, "a native folder retry pointer action must not fall through to playback");
        runtime.mutation = saved; await feedback.retry.press("Enter"); await saved.requested;
        const input = page.locator("#workSearch"); await input.fill("再次重试之后的中文草稿"); await input.evaluate(node => node.setSelectionRange(1, 5, "backward"));
        const draft = await input.evaluate(node => [node.value, node.selectionStart, node.selectionEnd, node.selectionDirection, node === document.activeElement]);
        if (focusTarget === "message") await feedback.message.focus();
        await releaseMutation(page, saved, "PUT"); assert.equal(await feedback.panel.evaluate(node => node.isConnected), false);
        if (focusTarget === "input") assert.deepEqual(await input.evaluate(node => [node.value, node.selectionStart, node.selectionEnd, node.selectionDirection, node === document.activeElement]), draft, "a successful folder retry must preserve newer input focus and draft");
        else assert.equal(await select.evaluate(node => node === document.activeElement), true, "a successful folder retry must restore its enabled select when the removed cause region has keyboard focus");
        assert.equal(await select.inputValue(), "later"); assert.equal(await select.evaluate(node => node.disabled), false);
        assert.deepEqual(runtime.folderWrites.map(write => write.folderId), ["later", "later", "later"]); await assertFolderRetention(page); assert.deepEqual(await page.evaluate(() => __alerts), []);
      } finally { repeated.release(); saved.release(); await page.close(); }
    }
  }
  async function verifyFavoriteFolderRetiredRetry() {
    const page = await newPage(3, true); runtime.mutation = { error: "Synthetic retired folder retry failure" };
    try {
      await page.goto(`${base}/fanhao/favorites`); await waitFolderMove(page, () => page.locator('.work-card[data-work-id="f0000"] .favorite-folder-select').selectOption("later"));
      const feedback = await folderFeedback(page, "Synthetic retired folder retry failure"); await openSearch(page, "same-id"); await pendingResponse(page);
      assert.equal(await feedback.panel.evaluate(node => node.isConnected), false); assert.equal(await page.locator(".favorite-folder-error").count(), 0);
      const before = await querySurface(page), puts = runtime.puts; await feedback.retry.evaluate(node => node.click()); await pendingResponse(page);
      assert.equal(runtime.puts, puts, "a retired folder retry must not restart its old move on a same-ID replacement"); assert.deepEqual(await querySurface(page), before);
      assert.equal(await page.locator('.work-card[data-work-id="f0000"] .favorite-folder-select').count(), 0, "the newer search card must retain its search-view controls");
      assert.equal(runtime.folderIds.get("f0000") || "default", "default", "a retired retry must preserve the confirmed server folder");
    } finally { await page.close(); }
  }
  async function verifyFavoriteFolderNativeFocus() {
    const modes = ["none", "browser-scroll", "wheel", "page-down", "input"];
    assert(!folderFocusMode || modes.includes(folderFocusMode), "native folder focus fixtures must select a known semantic mode");
    for (const mode of modes.filter(value => !folderFocusMode || value === folderFocusMode)) {
      const page = await newPage(30, true, 320), pending = deferred(), cause = "Synthetic native folder focus failure";
      runtime.mutation = { ...pending, error: cause };
      try {
        await page.goto(`${base}/fanhao/favorites`);
        const select = page.locator('.work-card[data-work-id="f0000"] .favorite-folder-select'); await select.waitFor();
        await captureFolderRetention(page); const reads = runtime.reads.length, url = page.url();
        await select.focus();
        await page.keyboard.press("ArrowDown");
        await pending.requested;
        assert.deepEqual(runtime.folderWrites.map(write => write.folderId), ["later"], "native ArrowDown must submit the explicit adjacent folder exactly once");
        assert.equal(await select.evaluate(node => node.disabled), true);
        let scrollNotification = null, draft = null;
        if (mode === "browser-scroll") {
          scrollNotification = await page.evaluate(() => new Promise(resolve => {
            const current = document.querySelector('.work-card[data-work-id="f0000"] .favorite-folder-select'), rect = current.getBoundingClientRect();
            const headerBottom = Math.max(0, document.querySelector(".product-topbar").getBoundingClientRect().bottom);
            let delta = rect.top - (headerBottom - 12); if (Math.abs(delta) < 1) delta += 8;
            const observe = event => {
              if (event.target !== document) return;
              document.removeEventListener("scroll", observe, true);
              resolve({ trusted: event.isTrusted, targetIsDocument: true, scrollY, requestedDelta: delta, headerBottom });
            };
            document.addEventListener("scroll", observe, { capture: true });
            window.scrollBy({ top: delta, left: 0, behavior: "instant" });
          }));
          assert.equal(scrollNotification.trusted, true, "the browser-only branch must observe a real browser scroll notification");
          assert.equal(scrollNotification.targetIsDocument, true);
        } else if (mode === "wheel") {
          await page.mouse.move(300, 880); await page.mouse.wheel(0, 240);
        } else if (mode === "page-down") {
          await page.keyboard.press("PageDown");
        } else if (mode === "input") {
          const input = page.locator("#workSearch"); await input.fill("原生收藏夹保存后更晚的草稿"); await input.evaluate(node => node.setSelectionRange(1, 6, "backward"));
          draft = await input.evaluate(node => [node.value, node.selectionStart, node.selectionEnd, node.selectionDirection, node === document.activeElement]);
        }
        await page.evaluate(() => new Promise(resolve => {
          let previous = scrollY, stable = 0, frames = 0;
          const frame = () => {
            stable = scrollY === previous ? stable + 1 : 0; previous = scrollY; frames++;
            if (stable >= 3 || frames >= 90) resolve(); else requestAnimationFrame(frame);
          };
          requestAnimationFrame(frame);
        }));
        const beforeReceipt = await page.evaluate(() => {
          const layoutTop = node => { const transform = getComputedStyle(node).transform; return node.getBoundingClientRect().top + scrollY - (transform === "none" ? 0 : new DOMMatrixReadOnly(transform).m42); };
          const anchor = [...document.querySelectorAll("#workGrid > .work-card")].find(node => { const rect = node.getBoundingClientRect(); return rect.top >= 0 && rect.top < innerHeight; }) || null;
          const select = document.querySelector('.work-card[data-work-id="f0000"] .favorite-folder-select'), rect = select.getBoundingClientRect();
          window.__nativeFolderViewport = anchor;
          return { scrollY, anchorTop: anchor ? layoutTop(anchor) - scrollY : null, selectTop: rect.top, selectBottom: rect.bottom, documentHasFocus: document.hasFocus(), visibility: document.visibilityState };
        });
        await releaseMutation(page, pending, "PUT");
        const outcome = await page.evaluate(() => {
          const probe = __folderRecovery, current = document.querySelector('.work-card[data-work-id="f0000"] .favorite-folder-select'), active = document.activeElement, anchor = window.__nativeFolderViewport;
          const transform = anchor ? getComputedStyle(anchor).transform : "none", translateY = transform === "none" ? 0 : new DOMMatrixReadOnly(transform).m42;
          const cardTransform = getComputedStyle(probe.card).transform, cardTranslateY = cardTransform === "none" ? 0 : new DOMMatrixReadOnly(cardTransform).m42;
          const rect = current.getBoundingClientRect(), header = document.querySelector(".product-topbar"), headerRect = header?.getBoundingClientRect();
          const headerBottom = headerRect && headerRect.height > 0 && headerRect.bottom > 0 ? Math.min(innerHeight, headerRect.bottom) : 0;
          const centerX = (rect.left + rect.right) / 2, centerY = (rect.top + rect.bottom) / 2, hit = document.elementFromPoint(centerX, centerY);
          return { selectFocused: active === current, bodyFocused: active === document.body, inputFocused: active === document.querySelector("#workSearch"),
            disabled: current.disabled, value: current.value, sameSelect: current === probe.select, sameCard: current.closest(".work-card") === probe.card,
            originalCards: probe.cards.every(node => node.isConnected), originalImages: probe.images.every(node => node.isConnected), chain: probe.chain.every(([node, parent]) => node.isConnected && node.parentNode === parent),
            scrollY, anchorConnected: anchor?.isConnected ?? null, anchorTop: anchor ? anchor.getBoundingClientRect().top - translateY : null,
            cardDocumentDelta: probe.card.getBoundingClientRect().top + scrollY - cardTranslateY - probe.documentTop,
            selectGeometry: { top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right, width: rect.width, height: rect.height, headerBottom, viewportWidth: innerWidth, viewportHeight: innerHeight, centerHit: hit === current || current.contains(hit) } };
        });
        const shouldRestore = mode === "none" || mode === "browser-scroll";
        const expectedFocus = shouldRestore ? "select" : mode === "input" ? "input" : "body";
        const focusMatches = shouldRestore ? outcome.selectFocused : mode === "input" ? outcome.inputFocused : outcome.bodyFocused;
        const geometry = outcome.selectGeometry;
        const restoredVisible = !shouldRestore || geometry.height > 0 && geometry.width > 0 && geometry.top >= geometry.headerBottom + 7 && geometry.bottom <= geometry.viewportHeight - 7
          && geometry.left >= 0 && geometry.right <= geometry.viewportWidth && geometry.centerHit;
        if (!focusMatches || !restoredVisible) {
          try {
            const diagnostic = await page.evaluate(() => {
              const current = document.querySelector('.work-card[data-work-id="f0000"] .favorite-folder-select'), active = document.activeElement, card = current?.closest(".work-card"), input = document.querySelector("#workSearch");
              return { time: performance.now(), beforeMove: __folderRecovery.beforeMove, documentHasFocus: document.hasFocus(), visibility: document.visibilityState, url: location.href.slice(0, 1024), scrollY,
                originalConnected: __folderRecovery.select.isConnected, currentConnected: current?.isConnected, sameSelect: current === __folderRecovery.select, disabled: current?.disabled, value: current?.value,
                active: { tag: active?.tagName, id: active?.id?.slice(0, 128), className: String(active?.className || "").slice(0, 256), html: active?.outerHTML?.slice(0, 512) },
                draft: input ? { value: input.value.slice(0, 2048), start: input.selectionStart, end: input.selectionEnd } : null,
                cardHtml: card?.outerHTML.slice(0, 4096), gridText: document.querySelector("#workGrid")?.textContent?.slice(0, 1024), ownerClosureFlags: "unavailable from the DOM" };
            });
            console.error("FAVORITE_FOLDER_NATIVE_FOCUS_FAILURE", JSON.stringify({ mode, expectedFocus, focusMatches, restoredVisible, preActionSnapshotPhase: "before-native-focus", savedActual: outcome, beforeReceipt, scrollNotification, diagnostic,
              puts: runtime.puts, putBodies: runtime.folderWrites.slice(-8).map(write => ({ id: String(write.id).slice(0, 128), folderId: String(write.folderId).slice(0, 128) })), reads: runtime.reads.length,
              lastReads: runtime.reads.slice(-8).map(read => ({ path: String(read.path).slice(0, 256), query: String(read.query || "").slice(0, 128), offset: read.offset, limit: read.limit })), faults: faults.slice(-4).map(value => String(value).slice(0, 512)) }));
          } catch (error) { console.error("FAVORITE_FOLDER_NATIVE_FOCUS_DIAGNOSTIC_FAILED", JSON.stringify({ mode, expectedFocus, savedActual: outcome, error: String(error?.message || error).slice(0, 512) })); }
        }
        assert.equal(focusMatches, true, mode === "browser-scroll" ? "a folder failure must restore its original select after a browser-only scroll notification"
          : `native folder failure focus must preserve the ${mode} intent contract`);
        if (shouldRestore) assert.equal(restoredVisible, true, "restored folder select must be visible below the sticky header");
        assert.equal(outcome.disabled, false); assert.equal(outcome.value, "default");
        assert(outcome.sameSelect && outcome.sameCard && outcome.originalCards && outcome.originalImages && outcome.chain, "native folder recovery must retain the original control, cards, media and ancestor chain");
        assert(Math.abs(outcome.cardDocumentDelta) < 1, "native folder recovery must preserve the original card's document layout anchor");
        if (!shouldRestore) {
          if (beforeReceipt.anchorTop !== null) { assert.equal(outcome.anchorConnected, true); assert(Math.abs(outcome.scrollY - beforeReceipt.scrollY) < 1 || Math.abs(outcome.anchorTop - beforeReceipt.anchorTop) < 1, "native folder recovery must preserve the user's scroll position or retained viewport layout anchor"); }
          else assert(Math.abs(outcome.scrollY - beforeReceipt.scrollY) < 1, "native folder recovery must preserve a viewport without a visible work anchor");
        }
        if (mode === "input") assert.deepEqual(await page.locator("#workSearch").evaluate(node => [node.value, node.selectionStart, node.selectionEnd, node.selectionDirection, node === document.activeElement]), draft);
        await folderFeedback(page, cause); assert.equal(runtime.folderIds.get("f0000") || "default", "default"); assert.equal(runtime.puts, 1); assert.equal(runtime.reads.length, reads); assert.equal(page.url(), url);
      } finally { pending.release(); await page.close(); }
    }
  }
  async function beginProbe(page, id, selector = ".favorite-button") {
    await page.evaluate(({ id, selector }) => {
      const grid = document.querySelector("#workGrid"), cards = [...grid.querySelectorAll(".work-card")], button = grid.querySelector(`[data-work-id="${id}"] ${selector}`);
      const images = cards.flatMap(card => [...card.querySelectorAll("img")].map(node => [node, node.parentNode]));
      const probe = window.__favoriteProbe = { cards, button, grid, images, scroll: scrollY, createdElements: 0, addedGridElements: 0, addedFavoriteErrorElements: 0, srcAssignments: 0 };
      probe.observe = records => { for (const record of records) for (const node of record.addedNodes) if (node.nodeType === 1) {
        const count = 1 + node.querySelectorAll("*").length; probe.addedGridElements += count;
        const panel = node.closest(".favorite-error");
        if (panel && panel.closest(".work-card") === button.closest(".work-card")) probe.addedFavoriteErrorElements += count;
      } };
      probe.observer = new MutationObserver(probe.observe); probe.observer.observe(grid, { childList: true, subtree: true });
    }, { id, selector });
  }
  async function finishProbe(page) {
    return page.evaluate(() => { const probe = __favoriteProbe; probe.observe(probe.observer.takeRecords()); probe.observer.disconnect();
      const result = { retainedCards: probe.cards.filter(card => card.isConnected && probe.grid.contains(card)).length,
        initialImages: probe.images.length, retainedImages: probe.images.filter(([node, parent]) => node.isConnected && node.parentNode === parent).length,
        createdElements: probe.createdElements, addedGridElements: probe.addedGridElements, addedFavoriteErrorElements: probe.addedFavoriteErrorElements,
        srcAssignments: probe.srcAssignments, scrollDelta: scrollY - probe.scroll, focusRetained: document.activeElement === probe.button }; window.__favoriteProbe = null; return result; });
  }

  async function newBulkPage(count, width = 1280) {
    const page = await newPage(count, false, width);
    runtime.readOnly = true; runtime.apiCalls = []; runtime.rejectedMutations = [];
    await page.addInitScript(() => {
      window.__bulkConfirms = 0;
      window.confirm = () => { window.__bulkConfirms++; return false; };
    });
    return page;
  }
  async function openBulkPerson(page) {
    await page.goto(`${base}/fanhao`);
    await page.locator(".person-index-card").click();
    await page.locator('.work-card[data-work-id="f0000"]').waitFor();
    const entry = await page.locator(".browse-select-works").elementHandle();
    await entry.click();
    await page.locator('.work-card[data-work-id="f0000"] .bulk-delete-select').waitFor();
    return entry;
  }
  async function bulkSummary(page, selected, total) {
    const text = await page.locator(".bulk-delete-controls .stat-inline-summary").textContent();
    assert.equal(text.replace(/[,\s]/g, ""), `已选${selected}/${total}`, "bulk summary must count only the currently loaded local works");
  }
  async function bulkReadOnly(page) {
    assert.deepEqual(runtime.rejectedMutations, [], "selection browsing must never attempt a mutation");
    assert.equal(runtime.posts + runtime.puts, 0);
    assert.equal(await page.evaluate(() => __bulkConfirms), 0, "selection browsing must never open a destructive confirmation");
    assert.deepEqual(await page.evaluate(() => __alerts), []);
  }
  async function beginBulkProbe(page, selector) {
    const control = await page.locator(selector).elementHandle();
    assert(control, `bulk control must exist: ${selector}`);
    await page.evaluate(selector => {
      const grid = document.querySelector("#workGrid"), control = document.querySelector(selector);
      const cards = [...grid.querySelectorAll(".work-card")], images = cards.flatMap(card => [...card.querySelectorAll("img")]);
      const chain = []; for (let node = control; node; node = node.parentElement) chain.push([node, node.parentNode]);
      const toolbarChain = [];
      for (let node = document.querySelector(".bulk-delete-controls"); node; node = node.parentElement) toolbarChain.push([node, node.parentNode]);
      const toolbarControls = [...document.querySelectorAll(".bulk-delete-controls button")];
      const probe = window.__bulkProbe = { control, cards, images, chain, toolbarChain, toolbarControls, scroll: scrollY, blur: 0, removed: 0, addedGridElements: 0 };
      control.addEventListener("blur", () => probe.blur++);
      window.__favoriteProbe = { createdElements: 0, srcAssignments: 0 };
      probe.observer = new MutationObserver(records => {
        for (const record of records) {
          if (grid.contains(record.target)) for (const node of record.addedNodes) if (node.nodeType === 1) probe.addedGridElements += 1 + node.querySelectorAll("*").length;
          for (const node of record.removedNodes) if (node.nodeType === 1 && [...chain, ...toolbarChain].some(([ancestor]) => node === ancestor || node.contains(ancestor))) probe.removed++;
        }
      });
      probe.observer.observe(document.body, { childList: true, subtree: true });
    }, selector);
    return control;
  }
  async function readBulkProbe(page, selector) {
    await pendingResponse(page);
    return page.evaluate(selector => {
      const probe = __bulkProbe, counters = __favoriteProbe;
      return { retainedCards: probe.cards.filter(node => node.isConnected).length, retainedImages: probe.images.filter(node => node.isConnected).length,
        sameControl: probe.control === document.querySelector(selector), ancestry: probe.chain.every(([node, parent]) => node.isConnected && node.parentNode === parent),
        toolbarStable: probe.toolbarChain.every(([node, parent]) => node.isConnected && node.parentNode === parent) && probe.toolbarControls.every(node => node.isConnected),
        blur: probe.blur, removed: probe.removed, focusRetained: document.activeElement === probe.control, scrollDelta: scrollY - probe.scroll,
        createdElements: counters.createdElements, addedGridElements: probe.addedGridElements, srcAssignments: counters.srcAssignments };
    }, selector);
  }
  async function assertBulkRetained(page, selector, count, { grid = true } = {}) {
    const metrics = await readBulkProbe(page, selector);
    if (grid) {
      assert.equal(metrics.retainedCards, count, "bulk selection must retain every original loaded work card");
      assert.equal(metrics.retainedImages, count, "bulk selection must retain every original cover image");
      assert.equal(metrics.addedGridElements, 0, "bulk selection must not reconstruct grid elements");
      assert.equal(metrics.srcAssignments, 0, "bulk selection must not reassign cover sources");
    }
    assert.equal(metrics.sameControl && metrics.ancestry, true, "bulk selection must retain the original native control and its full ancestor chain");
    assert.equal(metrics.toolbarStable, true, "bulk selection must retain the original bulk toolbar and native action buttons");
    assert.equal(metrics.removed, 0, "a bulk control ancestor must never be detached during selection sync");
    assert.equal(metrics.blur, 0, "bulk selection must not blur its original native control");
    assert.equal(metrics.focusRetained, true, "bulk selection must keep native control focus");
    assert(Math.abs(metrics.scrollDelta) < 1, "bulk selection must keep its scroll anchor");
    return metrics;
  }
  async function endBulkProbe(page) {
    await page.evaluate(() => { __bulkProbe.observer.disconnect(); window.__bulkProbe = null; window.__favoriteProbe = null; });
  }
  async function verifyPersonBulkNativeSelection() {
    const page = await newBulkPage(1000);
    try {
      await openBulkPerson(page); await loadAll(page, 1000);
      const selector = '.work-card[data-work-id="f0500"] .bulk-delete-select';
      await page.locator(selector).scrollIntoViewIfNeeded(); await page.locator(selector).focus();
      await settleCovers(page);
      const control = await beginBulkProbe(page, selector), reads = runtime.apiCalls.length;
      await control.press("Enter");
      const metrics = await assertBulkRetained(page, selector, 1000);
      assert.equal(await control.getAttribute("aria-pressed"), "true");
      assert.equal(await page.locator('.work-card[data-work-id="f0500"]').evaluate(node => node.classList.contains("bulk-delete-selected")), true);
      await bulkSummary(page, 1, 1000);
      await control.press("Space"); await assertBulkRetained(page, selector, 1000);
      assert.equal(await control.getAttribute("aria-pressed"), "false"); await bulkSummary(page, 0, 1000);
      assert.equal(runtime.apiCalls.length, reads, "native selection changes must not read or mutate APIs");
      await endBulkProbe(page);
      const coverSelector = '.work-card[data-work-id="f0500"] .work-card-main';
      const coverPhases = [{ phase: "before cover focus", calls: runtime.apiCalls.length }];
      runtime.bulkPhase = "cover focus";
      await page.locator(coverSelector).focus();
      coverPhases.push({ phase: "after cover focus", calls: runtime.apiCalls.length });
      const cover = await beginBulkProbe(page, coverSelector);
      runtime.bulkPhase = "cover Enter";
      await cover.press("Enter"); await assertBulkRetained(page, coverSelector, 1000); await bulkSummary(page, 1, 1000);
      coverPhases.push({ phase: "after cover Enter", calls: runtime.apiCalls.length });
      runtime.bulkPhase = "cover Space";
      await cover.press("Space"); await assertBulkRetained(page, coverSelector, 1000); await bulkSummary(page, 0, 1000);
      coverPhases.push({ phase: "after cover Space", calls: runtime.apiCalls.length });
      if (runtime.apiCalls.length !== reads) console.log(`DIAGNOSTIC person bulk cover ${JSON.stringify({ beforeCover: reads, coverPhases, addedApiCalls: runtime.apiCalls.slice(reads) })}`);
      assert.equal(runtime.apiCalls.length, reads, "a cover activation in bulk mode must select locally instead of opening a work");
      await endBulkProbe(page); await bulkReadOnly(page);
      console.log(`MEASURE person bulk selection ${JSON.stringify(metrics)}`);
    } finally { await page.close(); }
  }
  async function verifyPersonBulkLoadedPrefix() {
    const page = await newBulkPage(60, 390), append = deferred();
    runtime.personRead = { ...append, offset: 48 };
    runtime.works[1].missingLocal = true; runtime.works[3].missingLocal = true;
    try {
      await openBulkPerson(page);
      await bulkSummary(page, 0, 46);
      assert(await page.locator(".work-card").count() < 48, "loaded-prefix profile must start before all 48 DTOs are mounted");
      const selector = '.bulk-delete-controls [data-person-bulk-action="all"]';
      await page.locator(selector).focus();
      const all = await beginBulkProbe(page, selector);
      await all.press("Enter"); await assertBulkRetained(page, selector, 0, { grid: false });
      await bulkSummary(page, 46, 46);
      assert.equal(await all.textContent(), "取消全选");
      assert.equal(await page.locator(".missing-local .bulk-delete-select").count(), 0, "missing-local works must never receive a selection button");
      await all.press("Space"); await assertBulkRetained(page, selector, 0, { grid: false });
      await bulkSummary(page, 0, 46); assert.equal(await all.textContent(), "全选本地");
      await all.press("Enter"); await assertBulkRetained(page, selector, 0, { grid: false }); await bulkSummary(page, 46, 46);
      await endBulkProbe(page);
      for (let attempt = 0; attempt < 100 && !runtime.personRead.used; attempt++) {
        await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight)); await page.waitForTimeout(20);
      }
      assert.equal(runtime.personRead.used, true, "the real person continuation must request offset 48");
      await page.locator('.work-card[data-work-id="f0047"]').waitFor();
      const oldCard = await page.locator('.work-card[data-work-id="f0000"]').elementHandle();
      const loadedIds = await page.locator(".work-card").evaluateAll(nodes => nodes.map(node => node.dataset.workId));
      assert.equal(loadedIds.length, 48, "the controlled continuation must keep the first complete raw prefix");
      assert.equal(await page.locator(".work-card.bulk-delete-selected").count(), 46, "cards created progressively after select-all must reflect the complete local-prefix selection");
      assert.equal(await page.locator(".work-card.missing-local.bulk-delete-selected").count(), 0, "progressive mounting must keep missing-local works unselected");
      const reply = page.waitForResponse(response => new URL(response.url()).pathname === "/api/people/favorite-person" && new URL(response.url()).searchParams.get("offset") === "48");
      append.release(); await (await reply).finished(); await loadAll(page, 60);
      assert.equal(await oldCard.evaluate(node => node.isConnected && node === document.querySelector('.work-card[data-work-id="f0000"]')), true, "append must preserve the selected original card");
      await bulkSummary(page, 46, 58);
      assert.equal(await page.locator('.work-card[data-work-id="f0059"] .bulk-delete-select').getAttribute("aria-pressed"), "false", "newly appended local works must start unselected");
      const next = await page.locator('.work-card[data-work-id="f0059"] .bulk-delete-select').elementHandle();
      await next.focus(); const reads = runtime.apiCalls.length; await next.press("Enter"); await pendingResponse(page);
      await bulkSummary(page, 47, 58); assert.equal(runtime.apiCalls.length, reads, "selecting an appended card must remain local");
      assert.equal(await next.evaluate(node => node.isConnected && node === document.querySelector('.work-card[data-work-id="f0059"] .bulk-delete-select')), true, "the appended card must keep its original native selection button");
      assert.equal(await next.getAttribute("aria-pressed"), "true");
      assert.equal(await page.locator('.work-card[data-work-id="f0059"]').evaluate(node => node.classList.contains("bulk-delete-selected")), true);
      await page.locator(".bulk-delete-controls").getByRole("button", { name: "退出多选", exact: true }).click();
      await page.locator(".browse-select-works").waitFor();
      assert.equal(await page.locator(".bulk-delete-selected").count(), 0, "leaving bulk mode must clear the selection");
      const normalCard = page.locator('.work-card[data-work-id="f0005"]');
      await normalCard.waitFor();
      assert.equal(await normalCard.locator(".work-card-main").getAttribute("data-playback-work-id"), "f0005", "leaving bulk mode must restore ordinary cover playback intent");
      assert.equal(await normalCard.locator(".work-body").getAttribute("data-playback-work-id"), "f0005", "leaving bulk mode must restore ordinary body playback intent");
      const warmPath = "/api/works/f0005/playback-prewarm", url = page.url();
      assert.equal(runtime.apiCalls.filter(call => call.path === warmPath).length, 0, "normal-prefetch restoration must use a previously unwarmed local work");
      const warmed = page.waitForResponse(response => new URL(response.url()).pathname === warmPath);
      runtime.bulkPhase = "normal mode cover focus";
      await normalCard.locator(".work-card-main").focus(); await (await warmed).finished(); await pendingResponse(page);
      assert.equal(runtime.apiCalls.filter(call => call.path === warmPath).length, 1, "normal cover focus must still issue one playback prewarm after leaving bulk mode");
      assert.equal(page.url(), url, "focusing a normal cover must prewarm without opening playback");
      await bulkReadOnly(page);
    } finally { append.release(); await page.close(); }
  }
  async function verifyPersonBulkRetiredControls() {
    const page = await newBulkPage(3);
    try {
      const oldEntry = await openBulkPerson(page);
      const oldSelect = await page.locator('.work-card[data-work-id="f0000"] .bulk-delete-select').elementHandle();
      const oldCover = await page.locator('.work-card[data-work-id="f0000"] .work-card-main').elementHandle();
      const oldAll = await page.locator('.bulk-delete-controls [data-person-bulk-action="all"]').elementHandle();
      const oldCancel = await page.locator(".bulk-delete-controls").getByRole("button", { name: "退出多选", exact: true }).elementHandle();
      await openSearch(page, "same-id"); await page.locator('[data-work-id="f0000"]').waitFor();
      const searchReads = runtime.apiCalls.length, searchUrl = page.url();
      await oldCover.evaluate(node => node.click()); await pendingResponse(page);
      assert.equal(runtime.apiCalls.length, searchReads, "a detached former bulk cover must not fall through to a normal work read in search");
      assert.equal(page.url(), searchUrl);
      await page.goBack({ waitUntil: "commit" });
      const current = page.locator('.work-card[data-work-id="f0001"] .bulk-delete-select');
      await current.waitFor();
      await current.focus(); await current.press("Enter"); await pendingResponse(page); await bulkSummary(page, 1, 3);
      const before = runtime.apiCalls.length, url = page.url();
      await oldSelect.evaluate(node => node.click()); await pendingResponse(page);
      await bulkSummary(page, 1, 3);
      await oldAll.evaluate(node => node.click()); await pendingResponse(page);
      assert.equal((await page.locator(".bulk-delete-controls .stat-inline-summary").textContent()).replace(/[,\s]/g, ""), "已选1/3", "retired select-all must not change the current person selection");
      await oldCover.evaluate(node => node.click()); await oldCancel.evaluate(node => node.click()); await pendingResponse(page);
      await bulkSummary(page, 1, 3);
      await oldEntry.evaluate(node => node.click()); await pendingResponse(page); await bulkSummary(page, 1, 3);
      assert.equal(await current.getAttribute("aria-pressed"), "true");
      assert.equal(page.url(), url); assert.equal(runtime.apiCalls.length, before, "retired controls must not navigate or issue reads");
      await bulkReadOnly(page);
    } finally { await page.close(); }
  }
  function filterFixtureMarkerRows(rows, url) {
    if (!runtime.markerMode) return rows;
    const markedOnly = (url.searchParams.get("filter") || "").split(",").includes("localMarkedA")
      || String(url.searchParams.get("q") || "").trim().toUpperCase() === "[A]";
    return markedOnly ? rows.filter(work => runtime.markers.has(work.id)) : rows;
  }
  function fixtureWorkDto(work, markerEnabled, includeFolder = true) {
    const { markerVideoMetadata, ...fields } = work;
    const dto = { ...fields, favorite: runtime.favorites.has(work.id) };
    if (includeFolder) dto.favoriteFolderId = runtime.folderIds.get(work.id) || "default";
    if (!runtime.markerMode) return dto;
    const enabled = markerEnabled ?? runtime.markers.has(work.id), directory = `fixture-${work.id}`;
    const relativePath = `${enabled ? "[A] " : ""}${directory}`;
    return { ...dto, directoryName: directory, relativePath, localMarkers: enabled ? ["A"] : [],
      videos: [{ id: `${work.id}-video`, name: "video.mp4", sourcePath: `${relativePath}/video.mp4`, relativePath: `${relativePath}/video.mp4`,
        progress: { positionMs: 12000, durationMs: 60000 }, ...(markerVideoMetadata || {}) }],
      images: [{ id: `${work.id}-image`, name: "cover.jpg", sourcePath: `${relativePath}/cover.jpg`, relativePath: `${relativePath}/cover.jpg` }],
      infos: [{ id: `${work.id}-info`, name: "info.json", sourcePath: `${relativePath}/info.json`, relativePath: `${relativePath}/info.json` }] };
  }
  async function holdMarkerRead(url, payload) {
    const plan = runtime.markerMode && runtime.markerRead;
    if (!plan || plan.used || !plan.match(url)) return;
    plan.used = true; plan.snapshot = structuredClone(payload); plan.arrived(); await plan.wait;
  }
  async function failMarkerRead(url, res) {
    const plan = runtime.markerMode && runtime.markerReadFailure;
    if (!plan || plan.used || !plan.match(url)) return false;
    plan.used = true; plan.arrived?.(); if (plan.wait) await plan.wait;
    json(res, { error: plan.error }, 503); return true;
  }
  async function newMarkerPage(count, width = 1280, ignoreMemberAbort = false) {
    const page = await newPage(count, false, width);
    Object.assign(runtime, { markerMode: true, markers: new Set(), markerWrites: [], markerApiCalls: [], rejectedMutations: [], markerMutation: null });
    await page.addInitScript(({ ignoreMemberAbort }) => {
      window.__markerConfirms = 0; window.confirm = () => { window.__markerConfirms++; return false; };
      window.__markerMemberStarted = []; window.__markerMemberSettled = [];
      if (!ignoreMemberAbort) return;
      const fetchImpl = window.fetch.bind(window);
      window.fetch = async (path, options = {}) => {
        const url = new URL(String(path), location.href);
        const memberRead = url.pathname === "/api/search" && url.searchParams.get("q") === "[A]"
          || url.pathname === "/api/people/favorite-person" && (url.searchParams.get("filter") || "").split(",").includes("localMarkedA");
        if (!memberRead) return fetchImpl(path, options);
        const id = __markerMemberStarted.length + 1; __markerMemberStarted.push({ id, url: url.href });
        const response = await fetchImpl(path, { ...options, signal: undefined }), read = response.json.bind(response);
        response.json = async () => { try { return await read(); } finally { __markerMemberSettled.push(id); } };
        return response;
      };
    }, { ignoreMemberAbort });
    return page;
  }
  function marker(page, id = "f0000") { return page.locator(`.work-card[data-work-id="${id}"] .local-marker-button`); }
  async function waitMarkerResponse(page, action) {
    const response = page.waitForResponse(item => item.request().method() === "POST" && /\/api\/works\/f\d+\/local-marker$/.test(new URL(item.url()).pathname));
    await action(); await (await response).finished(); await pendingResponse(page);
  }
  async function markerSafety(page) {
    assert.deepEqual(runtime.rejectedMutations, [], "marker browsing must reject every unrelated mutation");
    assert.equal(await page.evaluate(() => __markerConfirms), 0, "marker checks must never trigger a destructive confirmation");
    assert(runtime.markerWrites.every(write => write.marker === "A" && typeof write.enabled === "boolean"));
  }
  async function verifyLocalMarkerSearchPrefetch() {
    for (const failed of [false, true]) {
      const page = await newMarkerPage(3), pending = deferred();
      runtime.markerMutation = { ...pending, error: failed ? "Synthetic cached marker failure" : "" };
      try {
        await openSearch(page, "same-id");
        await page.evaluate(() => Object.defineProperty(navigator, "connection", { configurable: true, value: { saveData: false } }));
        await marker(page).focus(); await page.keyboard.press("Enter"); await pending.requested;
        const warmedResponse = page.waitForResponse(response => {
          const url = new URL(response.url());
          return response.request().method() === "GET" && url.pathname === "/api/search" && url.searchParams.get("q") === "[A]";
        });
        const input = page.locator("#workSearch"); await input.fill("[A]");
        const warmed = await warmedResponse; await warmed.finished(); const old = await warmed.json(); await pendingResponse(page);
        assert.deepEqual(old.works, [], "the actual native input prefetch must settle with the old empty category before marker confirmation");
        assert.equal(old.total, 0); assert.equal(runtime.markers.has("f0000"), false);
        const queryReads = () => runtime.markerApiCalls.filter(call => call.method === "GET" && call.path === "/api/search" && new URLSearchParams(call.query).get("q") === "[A]");
        assert.equal(queryReads().length, 1);
        const before = { url: page.url(), reads: runtime.markerApiCalls.filter(call => call.method === "GET").length,
          input: await input.evaluate(node => [node.value, node.selectionStart, node.selectionEnd, node === document.activeElement]) };
        await waitMarkerResponse(page, () => pending.release());
        assert.equal(runtime.markers.has("f0000"), !failed);
        assert.equal(page.url(), before.url);
        assert.deepEqual(await input.evaluate(node => [node.value, node.selectionStart, node.selectionEnd, node === document.activeElement]), before.input, "cache maintenance must preserve the current raw input and native focus");
        assert.equal(runtime.markerApiCalls.filter(call => call.method === "GET").length, before.reads, "marker cache invalidation must not issue an automatic read");
        assert.equal(await marker(page).getAttribute("aria-label"), failed ? "添加 A 标记" : "移除 A 标记");
        assert.equal(await page.evaluate(() => __alerts.length), 0);
        assert.equal(await page.locator('.work-card[data-work-id="f0000"] .local-marker-error').count(), failed ? 1 : 0, "only a failed current marker must expose its local recovery feedback");
        if (failed) assert.equal(await page.locator('.work-card[data-work-id="f0000"] .local-marker-error-message').textContent(), "Synthetic cached marker failure");
        await input.press("Enter");
        await page.waitForFunction(() => document.querySelector("#currentTitle")?.textContent.includes("[A]") && !document.querySelector("#workGrid")?.textContent.includes("正在全库搜索"));
        await pendingResponse(page);
        const ids = await page.locator("#workGrid .work-card").evaluateAll(nodes => nodes.map(node => node.dataset.workId));
        if (failed) {
          assert.deepEqual(ids, []); assert.equal(queryReads().length, 1, "a rejected marker must retain the reusable settled prefetch without another GET");
        } else {
          assert.equal(ids.includes("f0000"), true, "a confirmed marker must retire an already settled empty search prefetch");
          assert.equal(queryReads().length, 2, "native submission after marker confirmation must perform exactly one fresh category GET");
          assert.equal(await marker(page).getAttribute("aria-label"), "移除 A 标记", "the newly queried card must expose the confirmed marker state");
          assert.equal(await marker(page).getAttribute("aria-pressed"), "true");
          assert.equal(await page.locator("#statsRow .stat").filter({ hasText: "当前筛选" }).locator("strong").textContent(), "1");
        }
        assert.deepEqual(runtime.markerWrites.map(write => write.enabled), [true]); await markerSafety(page);
      } finally { pending.release(); await page.close(); }
    }
  }
  async function verifyLocalMarkerPersonPrefetch() {
    const page = await newMarkerPage(3), pending = deferred(); runtime.markerMutation = pending;
    try {
      await page.goto(`${base}/fanhao`); await page.locator(".person-index-card").click(); await marker(page).waitFor();
      await marker(page).press("Enter"); await pending.requested;
      await page.locator("#backToPeopleIndex").click(); const card = page.locator(".person-index-card"); await card.waitFor();
      await page.evaluate(() => Object.defineProperty(navigator, "connection", { configurable: true, value: { saveData: false } }));
      const personResponse = () => page.waitForResponse(response => response.request().method() === "GET" && new URL(response.url()).pathname === "/api/people/favorite-person");
      const warming = personResponse(); await card.focus(); const warmed = await warming; await warmed.finished();
      const old = await warmed.json(); await pendingResponse(page);
      assert.deepEqual(old.works[0].localMarkers, []); assert.equal(old.works[0].videos[0].sourcePath, "fixture-f0000/video.mp4");
      const before = runtime.markerApiCalls.filter(call => call.method === "GET").length, url = page.url();
      await waitMarkerResponse(page, () => pending.release());
      assert.equal(runtime.markers.has("f0000"), true); assert.equal(page.url(), url);
      assert.equal(await card.evaluate(node => node === document.activeElement), true);
      assert.equal(runtime.markerApiCalls.filter(call => call.method === "GET").length, before, "marker confirmation on the index must only retire caches");
      const freshResponse = personResponse(); await card.press("Enter"); const fresh = await freshResponse; await fresh.finished();
      await marker(page).waitFor(); await pendingResponse(page);
      const data = await fresh.json();
      assert.deepEqual(data.works[0].localMarkers, ["A"]); assert.equal(data.works[0].videos[0].sourcePath, "[A] fixture-f0000/video.mp4");
      assert.equal(runtime.markerApiCalls.filter(call => call.method === "GET").length, before + 1, "person activation must reread once after a settled old detail prefetch is invalidated");
      assert.equal(await marker(page).getAttribute("aria-label"), "移除 A 标记", "fresh person activation must not replay the old unmarked detail cache");
      assert.equal(await marker(page).getAttribute("aria-pressed"), "true");
      runtime.markerMutation = null; await waitMarkerResponse(page, () => marker(page).press("Enter"));
      assert.deepEqual(runtime.markerWrites.map(write => write.enabled), [true, false], "the fresh person's native next intent must remove its confirmed marker");
      assert.equal(await marker(page).getAttribute("aria-label"), "添加 A 标记"); await markerSafety(page);
    } finally { pending.release(); await page.close(); }
  }
  function markerDestination(kind, url) {
    return url.pathname === (kind === "query" ? "/api/search" : "/api/people/favorite-person")
      && (kind === "query" ? url.searchParams.get("q") === "[A]" : (url.searchParams.get("filter") || "").split(",").includes("localMarkedA"));
  }
  function markerDestinationReads(kind) {
    return runtime.markerApiCalls.filter(call => call.method === "GET" && markerDestination(kind, new URL(`${call.path}${call.query}`, base)));
  }
  async function acceptEmptyMarkerDestination(page, kind, origin) {
    const completed = page.waitForResponse(response => response.request().method() === "GET" && markerDestination(kind, new URL(response.url())));
    if (kind === "query") { await page.locator("#workSearch").fill("[A]"); await page.locator("#workSearch").press("Enter"); }
    else await page.locator('[data-work-filter="localMarkedA"]').click();
    const response = await completed; await response.finished(); const data = await response.json(); await pendingResponse(page);
    assert.deepEqual(data.works, [], "the destination foreground GET must finish with an empty pre-save marker category"); assert.equal(data.total, 0);
    const empty = await page.locator("#workGrid > .empty-state").elementHandle(); assert(empty);
    assert.equal(await page.locator("#workGrid .work-card").count(), 0);
    assert.doesNotMatch(await page.locator("#workGrid").innerText(), /正在全库搜索|正在加载作品/);
    assert.equal(await origin.evaluate(node => node.isConnected), false, "accepted empty destination must retire the originating marker card before its ACK");
    assert.equal(runtime.markers.has("f0000"), false); assert.equal(markerDestinationReads(kind).length, 1);
    if (kind === "query") assert.equal(new URL(page.url()).searchParams.get("q"), "[A]");
    else assert.equal(new URL(page.url()).searchParams.get("personId"), "favorite-person");
    return empty;
  }
  async function verifyLocalMarkerAcceptedEmpty(kind) {
    for (const outcome of ["success", "failure", "invalid"]) {
      const page = await newMarkerPage(3), pending = deferred();
      runtime.markerMutation = { ...pending, error: outcome === "failure" ? "Synthetic accepted destination marker failure" : "", invalidReceipt: outcome === "invalid" };
      try {
        if (kind === "query") await openSearch(page, "small");
        else { await page.goto(`${base}/fanhao`); await page.locator(".person-index-card").click(); await marker(page).waitFor(); }
        const origin = await marker(page).elementHandle(); await origin.press("Enter"); await pending.requested;
        const empty = await acceptEmptyMarkerDestination(page, kind, origin);
        const input = page.locator("#workSearch"); await input.fill("后来未提交的空结果草稿"); await input.evaluate(node => node.setSelectionRange(1, 6, "backward"));
        const before = await querySurface(page), beforeInput = await input.evaluate(node => [node.value, node.selectionStart, node.selectionEnd, node.selectionDirection, node === document.activeElement]);
        const freshResponse = outcome === "success" ? page.waitForResponse(response => response.request().method() === "GET" && markerDestination(kind, new URL(response.url())), { timeout: 5000 }).catch(error => {
          if (error.name === "TimeoutError") return null;
          throw error;
        }) : null;
        await waitMarkerResponse(page, () => pending.release());
        if (outcome === "success") {
          const fresh = await freshResponse; if (fresh) await fresh.finished(); await pendingResponse(page);
          const ids = await page.locator("#workGrid .work-card").evaluateAll(nodes => nodes.map(node => node.dataset.workId));
          assert.equal(ids.includes("f0000"), true, "a confirmed marker must repopulate an already accepted empty marker destination");
          assert.deepEqual(ids, ["f0000"]); assert.equal(runtime.markers.has("f0000"), true);
          assert.equal(markerDestinationReads(kind).length, 2, "accepted empty membership must refresh exactly once after its confirming ACK");
          assert.deepEqual(markerDestinationReads(kind).map(call => Number(new URLSearchParams(call.query).get("offset") || 0)), [0, 0]);
          assert.equal(await empty.evaluate(node => node.isConnected), false);
          assert.equal(await marker(page).getAttribute("aria-pressed"), "true"); assert.equal(await marker(page).getAttribute("aria-label"), "移除 A 标记");
          if (kind === "query") assert.equal(await page.locator("#statsRow .stat").filter({ hasText: "当前筛选" }).locator("strong").textContent(), "1");
          else assert.match(await page.locator(".browse-result-summary").textContent(), /1/);
          assert.equal(page.url(), before.url, "accepted empty refresh must retain its committed canonical destination");
          assert.deepEqual(await input.evaluate(node => [node.value, node.selectionStart, node.selectionEnd, node.selectionDirection, node === document.activeElement]), beforeInput, "accepted empty refresh must preserve the newer raw draft, caret and native focus");
          assert.deepEqual(await page.evaluate(() => __alerts), []);
        } else {
          assert.deepEqual(await querySurface(page), before, "a rejected or invalid marker must preserve the newer accepted empty destination");
          assert.equal(await empty.evaluate(node => node.isConnected), true, "unconfirmed marker results must retain the original accepted empty presentation");
          assert.equal(markerDestinationReads(kind).length, 1); assert.equal(runtime.markers.has("f0000"), false);
        }
        assert.deepEqual(runtime.markerWrites.map(write => write.enabled), [true]); await markerSafety(page);
      } finally { pending.release(); await page.close(); }
    }
  }
  async function verifyLocalMarkerAcceptedNonempty(kind) {
    for (const phase of ["first-page", "appended", "append-error"]) {
      const page = await newMarkerPage(61, 390), pending = deferred(), append = deferred();
      runtime.works.slice(1).forEach(work => runtime.markers.add(work.id)); runtime.markerMutation = pending;
      try {
        if (kind === "query") await openSearch(page, "small");
        else { await page.goto(`${base}/fanhao`); await page.locator(".person-index-card").click(); await marker(page).waitFor(); }
        const origin = await marker(page).elementHandle(); await origin.press("Enter"); await pending.requested;
        const completed = page.waitForResponse(response => response.request().method() === "GET" && markerDestination(kind, new URL(response.url())));
        if (kind === "query") { await page.locator("#workSearch").fill("[A]"); await page.locator("#workSearch").press("Enter"); }
        else await page.locator('[data-work-filter="localMarkedA"]').click();
        const first = await completed; await first.finished(); const old = await first.json();
        for (let attempt = 0; attempt < 80 && await page.locator("#workGrid .work-card").count() < 48; attempt++) {
          await page.evaluate(() => document.querySelector("#workGrid .work-render-sentinel")?.scrollIntoView({ block: "center" }));
          await page.waitForTimeout(20);
        }
        await page.evaluate(() => window.scrollTo(0, 0)); await pendingResponse(page);
        assert.equal(old.total, 60); assert.equal(old.offset, 0); assert.equal(old.limit, 48); assert.equal(old.works.length, 48);
        assert.deepEqual(old.works.map(work => work.id), runtime.works.slice(1, 49).map(work => work.id));
        assert.equal(await page.locator("#workGrid .work-card").count(), 48);
        assert.equal(markerDestinationReads(kind).length, 1, "rendering the accepted loaded prefix must not consume the next server page before its phase begins");
        assert.equal(await marker(page).count(), 0, "the accepted nonempty destination must still lack the pending new member");
        assert.equal(await page.locator("#workGrid > .empty-state").count(), 0);
        assert.equal(await origin.evaluate(node => node.isConnected), false); assert.equal(runtime.markers.has("f0000"), false);
        const retained = await page.locator('.work-card[data-work-id="f0001"]').elementHandle();
        const more = await page.locator("#workGrid .load-more-row button").elementHandle(); assert(more);
        if (phase !== "first-page") {
          const match = url => markerDestination(kind, url) && Number(url.searchParams.get("offset")) === 48;
          if (phase === "append-error") runtime.markerReadFailure = { ...append, match, error: "Synthetic newer marker append failure" };
          else runtime.markerRead = { ...append, match };
          const appended = page.waitForResponse(response => response.request().method() === "GET" && match(new URL(response.url())));
          await more.press("Enter"); await append.requested; append.release();
          const response = await appended; await response.finished(); await pendingResponse(page);
          assert.equal(response.status(), phase === "append-error" ? 503 : 200);
          if (phase === "appended") {
            await page.locator('.work-card[data-work-id="f0060"]').waitFor();
            assert.equal(await page.locator("#workGrid .work-card").count(), 60);
            assert.equal(await page.locator("#workGrid .load-more-row").count(), 0);
            assert.equal(await retained.evaluate(node => node.isConnected), true, "successful old-membership append must retain the first accepted card before the marker ACK");
          } else {
            assert.equal(await page.locator("#workGrid .work-card").count(), 48);
            assert.match(await more.textContent(), /Synthetic newer marker append failure/); assert.equal(await more.isDisabled(), false);
          }
          assert.deepEqual(markerDestinationReads(kind).map(call => Number(new URLSearchParams(call.query).get("offset") || 0)), [0, 48]);
        }
        await page.evaluate(() => window.scrollTo(0, 0));
        const input = page.locator("#workSearch"); await input.fill("后来未提交的非空列表草稿"); await input.evaluate(node => node.setSelectionRange(1, 6, "backward"));
        await pendingResponse(page);
        const before = await querySurface(page), inputBefore = await input.evaluate(node => [node.value, node.selectionStart, node.selectionEnd, node.selectionDirection, node === document.activeElement]);
        const readsBefore = markerDestinationReads(kind).length;
        const freshResponse = phase !== "append-error" ? page.waitForResponse(response => response.request().method() === "GET" && markerDestination(kind, new URL(response.url())) && Number(new URL(response.url()).searchParams.get("offset") || 0) === 0, { timeout: 5000 }).catch(error => {
          if (error.name === "TimeoutError") return null;
          throw error;
        }) : null;
        await waitMarkerResponse(page, () => pending.release());
        assert.equal(runtime.markers.has("f0000"), true);
        if (phase === "append-error") {
          assert.deepEqual(await querySurface(page), before, "a marker ACK must preserve the accepted nonempty list and its newer failed append control");
          assert.equal(await retained.evaluate(node => node.isConnected && node === document.querySelector('.work-card[data-work-id="f0001"]')), true);
          assert.equal(await more.evaluate(node => node.isConnected && node === document.querySelector("#workGrid .load-more-row button")), true, "a newer failed append must keep its original native retry control");
          assert.equal(await more.isDisabled(), false);
          assert.equal(markerDestinationReads(kind).length, readsBefore, "a newer append failure must retire prior accepted-membership maintenance without an automatic GET");
          assert.equal(await marker(page).count(), 0);
        } else {
          const fresh = await freshResponse; if (fresh) await fresh.finished(); await pendingResponse(page);
          assert.equal(await marker(page).count(), 1, "a confirmed marker must join an already accepted nonempty marker destination");
          assert.equal(await marker(page).getAttribute("aria-pressed"), "true"); assert.equal(await marker(page).getAttribute("aria-label"), "移除 A 标记");
          assert(fresh, "confirmed nonempty membership must publish an actual fresh offset-zero GET");
          const data = await fresh.json(); assert.equal(data.total, 61); assert.equal(data.works.length, 48);
          assert.deepEqual(data.works.map(work => work.id), runtime.works.slice(0, 48).map(work => work.id));
          assert.equal(data.works[0].videos[0].sourcePath, "[A] fixture-f0000/video.mp4");
          assert.equal(markerDestinationReads(kind).length, readsBefore + 1, "confirmed nonempty membership must refresh once from offset zero");
          assert.equal(page.url(), before.url);
          assert.deepEqual(await input.evaluate(node => [node.value, node.selectionStart, node.selectionEnd, node.selectionDirection, node === document.activeElement]), inputBefore, "nonempty membership refresh must preserve the later raw draft, caret and native focus");
          if (kind === "query") assert.equal(await page.locator("#statsRow .stat").filter({ hasText: "当前筛选" }).locator("strong").textContent(), "61");
          else assert.match(await page.locator(".browse-result-summary").textContent(), /61/);
          await loadAll(page, 61);
          const ids = await page.locator("#workGrid .work-card").evaluateAll(nodes => nodes.map(node => node.dataset.workId));
          assert.equal(new Set(ids).size, 61); assert.deepEqual([...ids].sort(), runtime.works.map(work => work.id).sort());
          assert(ids.includes("f0048") && ids.includes("f0060"), "confirmed nonempty membership must retain the append boundary and final row");
          assert.deepEqual(markerDestinationReads(kind).slice(readsBefore).map(call => Number(new URLSearchParams(call.query).get("offset") || 0)), [0, 48], "confirmed nonempty membership must reset and continue its actual raw cursor without skipping a row");
        }
        assert.deepEqual(runtime.markerWrites.map(write => write.enabled), [true]); await markerSafety(page);
      } finally { pending.release(); append.release(); await page.close(); }
    }
  }
  async function beginMarkerProbe(page, id) {
    const selector = `.work-card[data-work-id="${id}"] .local-marker-button`;
    const control = await page.locator(selector).elementHandle(); assert(control);
    await page.evaluate(selector => {
      const grid = document.querySelector("#workGrid"), control = document.querySelector(selector), chain = [];
      for (let node = control; node; node = node.parentElement) chain.push([node, node.parentNode]);
      const probe = globalThis.__markerProbe = { control, chain, cards: [...grid.querySelectorAll(".work-card")],
        images: [...grid.querySelectorAll(".work-card img")], scroll: scrollY, cardDocumentTop: control.closest(".work-card").getBoundingClientRect().top + scrollY,
        blur: 0, removed: 0, addedGridElements: 0, feedbackElements: 0 };
      globalThis.__favoriteProbe = { createdElements: 0, srcAssignments: 0 };
      control.addEventListener("blur", () => probe.blur++);
      probe.observer = new MutationObserver(records => {
        for (const record of records) {
          if (grid.contains(record.target)) for (const node of record.addedNodes) if (node.nodeType === 1) {
            const added = 1 + node.querySelectorAll("*").length;
            probe.addedGridElements += added;
            if (node.matches(".local-marker-error") || node.closest(".local-marker-error")) probe.feedbackElements += added;
          }
          for (const node of record.removedNodes) if (node.nodeType === 1 && chain.some(([ancestor]) => node === ancestor || node.contains(ancestor))) probe.removed++;
        }
      });
      probe.observer.observe(document.body, { childList: true, subtree: true });
    }, selector);
    return { control, selector };
  }
  async function assertMarkerProbe(page, selector, count, { focus = true, feedback = false, feedbackRemoval = false } = {}) {
    await pendingResponse(page);
    const actual = await page.evaluate(selector => {
      const probe = __markerProbe;
      return { retainedCards: probe.cards.filter(node => node.isConnected).length, retainedImages: probe.images.filter(node => node.isConnected).length,
        sameControl: probe.control === document.querySelector(selector) && probe.control.isConnected,
        ancestry: probe.chain.every(([node, parent]) => node.isConnected && node.parentNode === parent), removed: probe.removed,
        blur: probe.blur, focused: document.activeElement === probe.control, scrollDelta: scrollY - probe.scroll,
        scrollY, originalScroll: probe.scroll, maxScroll: Math.max(0, document.documentElement.scrollHeight - innerHeight),
        cardDocumentDelta: probe.control.closest(".work-card").getBoundingClientRect().top + scrollY - probe.cardDocumentTop,
        createdElements: __favoriteProbe.createdElements, srcAssignments: __favoriteProbe.srcAssignments, addedGridElements: probe.addedGridElements, feedbackElements: probe.feedbackElements };
    }, selector);
    assert.equal(actual.retainedCards, count, "a local marker receipt must retain every original work card");
    assert.equal(actual.retainedImages, count, "a local marker receipt must retain every original cover");
    assert.equal(actual.sameControl && actual.ancestry, true, "a local marker receipt must keep its original native button and complete ancestor chain");
    assert.equal(actual.removed, 0); assert.equal(actual.addedGridElements, feedback ? actual.feedbackElements : 0, "marker feedback may add only its own recovery subtree without rebuilding other grid elements"); assert.equal(actual.srcAssignments, 0);
    if (focus) { assert.equal(actual.focused, true, "marker completion must preserve the original native keyboard focus"); assert.equal(actual.blur, 0); }
    if (feedbackRemoval) {
      assert(Math.abs(actual.scrollY - Math.min(actual.originalScroll, actual.maxScroll)) < 1, "removing marker feedback may only clamp scroll to the remaining page height");
      assert(Math.abs(actual.cardDocumentDelta) < 1, "removing marker feedback must preserve the original card's document anchor");
    } else assert(Math.abs(actual.scrollDelta) < 1, "marker completion must retain the current scroll anchor");
    return actual;
  }
  async function endMarkerProbe(page) { await page.evaluate(() => { __markerProbe.observer.disconnect(); globalThis.__markerProbe = null; globalThis.__favoriteProbe = null; }); }
  async function markerFeedback(page, cause) {
    const root = '.work-card[data-work-id="f0000"] .local-marker-error';
    assert.equal(await page.locator(root).count(), 1, "a current marker failure must keep its cause and retry visible");
    const panel = await page.locator(root).elementHandle(), message = await page.locator(`${root} .local-marker-error-message`).elementHandle(), retry = await page.locator(`${root} .local-marker-retry`).elementHandle();
    assert(panel && message && retry); assert.equal(await message.textContent(), cause); assert.equal(await message.getAttribute("role"), "alert");
    assert.equal(await retry.getAttribute("aria-label"), "重试添加 A 标记"); assert.equal(await retry.isDisabled(), false);
    assert.deepEqual(await page.evaluate(() => __alerts), [], "local marker recovery must not open a blocking alert");
    return { panel, message, retry };
  }
  async function assertSameMarkerFeedback(feedback) {
    assert.equal(await feedback.panel.evaluate(node => node.isConnected && node === document.querySelector('.work-card[data-work-id="f0000"] .local-marker-error')), true);
    assert.equal(await feedback.message.evaluate(node => node.isConnected && node === document.querySelector('.work-card[data-work-id="f0000"] .local-marker-error-message')), true);
    assert.equal(await feedback.retry.evaluate(node => node.isConnected && node === document.querySelector('.work-card[data-work-id="f0000"] .local-marker-retry')), true, "marker retries must retain their original native retry control");
  }
  async function verifyLocalMarkerNativeRoundtrip() {
    const page = await newMarkerPage(1000), pending = deferred(); runtime.markerMutation = pending;
    try {
      await openSearch(page, "large"); await loadAll(page, 1000);
      await marker(page, "f0500").scrollIntoViewIfNeeded(); await marker(page, "f0500").focus(); await settleCovers(page);
      const { control, selector } = await beginMarkerProbe(page, "f0500"), reads = runtime.reads.length;
      await page.keyboard.press("Enter"); await pending.requested;
      await assertMarkerProbe(page, selector, 1000);
      assert.equal(await control.getAttribute("aria-disabled"), "true"); assert.equal(await control.getAttribute("aria-busy"), "true");
      assert.equal(await control.evaluate(node => node.disabled), false, "a pending native marker button must stay focusable");
      await page.keyboard.press("Enter"); await page.keyboard.press("Space"); await pendingResponse(page);
      assert.equal(runtime.markerWrites.length, 1, "native repeated activation while busy must issue only one marker write");
      await waitMarkerResponse(page, () => pending.release());
      const metrics = await assertMarkerProbe(page, selector, 1000);
      assert.equal(await control.getAttribute("aria-label"), "移除 A 标记"); assert.equal(await control.getAttribute("aria-busy"), "false");
      runtime.markerMutation = null;
      await waitMarkerResponse(page, () => page.keyboard.press("Space")); await assertMarkerProbe(page, selector, 1000);
      assert.deepEqual(runtime.markerWrites.map(write => write.enabled), [true, false], "the same native marker button must reverse the latest confirmed state");
      assert.equal(await control.getAttribute("aria-label"), "添加 A 标记");
      assert.equal(runtime.reads.length, reads, "ordinary marker confirmation must not reload the list");
      assert.deepEqual(await page.evaluate(() => __alerts), []); await markerSafety(page); await endMarkerProbe(page);
      console.log(`MEASURE local marker ${JSON.stringify(metrics)}`);
    } finally { pending.release(); await page.close(); }
  }
  async function verifyLocalMarkerNativeRecoveryFocus() {
    const settleScroll = page => page.evaluate(() => new Promise(resolve => {
      let previous = scrollY, stable = 0, frames = 0;
      const tick = () => { stable = scrollY === previous ? stable + 1 : 0; previous = scrollY; frames++; if (stable >= 3 || frames >= 90) resolve({ stable: stable >= 3, frames }); else requestAnimationFrame(tick); };
      requestAnimationFrame(tick);
    }));
    const modes = ["retry", "reason", "input", "wheel", "page-down", "repeated", "repeated-pointer"];
    assert(!markerRecoveryMode || modes.includes(markerRecoveryMode), "native marker recovery must select a known semantic mode");
    for (const mode of modes.filter(value => !markerRecoveryMode || value === markerRecoveryMode)) {
      const page = await newMarkerPage(30, 320), saved = deferred(), dialogs = [], tabs = [], faultStart = faults.length;
      await page.setViewportSize({ width: 320, height: 360 });
      runtime.markerMutation = { error: "Synthetic native A recovery failure" };
      page.on("dialog", async dialog => { dialogs.push({ type: dialog.type(), message: dialog.message() }); await dialog.dismiss(); });
      const capture = phase => page.evaluate(phase => {
        const original = __nativeMarkerRecovery, control = original.control, card = original.card, input = original.input, rect = control.getBoundingClientRect(), header = document.querySelector('.product-topbar').getBoundingClientRect();
        const translation = node => { const value = getComputedStyle(node).transform; return value === "none" ? 0 : new DOMMatrixReadOnly(value).m42; };
        const cardTranslate = translation(card), ownTranslate = translation(control), cardDocumentTop = card.getBoundingClientRect().top + scrollY - cardTranslate;
        const controlDocumentTop = rect.top + scrollY - cardTranslate - ownTranslate, x = rect.left + rect.width/2, y = rect.top + rect.height/2, hit = document.elementFromPoint(x,y);
        const retry = card.querySelector('.local-marker-retry'), reason = card.querySelector('.local-marker-error-message'), anchor = window.__nativeMarkerViewport;
        return { phase, active: { tag: document.activeElement.tagName, className: document.activeElement.className }, activeIsOriginal: document.activeElement === control, activeIsBody: document.activeElement === document.body,
          activeIsInput: document.activeElement === input, activeIsRetry: document.activeElement === retry, activeIsReason: document.activeElement === reason,
          connected: control.isConnected, sameControl: control === document.querySelector('.work-card[data-work-id="f0000"] .local-marker-button'), sameCard: card === control.closest('.work-card'),
          controlChain: original.controlChain.every(([node,parent]) => node.isConnected && node.parentNode === parent), sameInput: input === document.querySelector('#workSearch'), inputChain: original.inputChain.every(([node,parent]) => node.isConnected && node.parentNode === parent),
          inputState: [input.value,input.selectionStart,input.selectionEnd,input.selectionDirection], originalMountedCards: original.cards.length, originalCardsConnected: original.cards.every(node=>node.isConnected),
          connectedOriginalCards: original.cards.filter(node=>node.isConnected).length, currentMountedCards: document.querySelectorAll('#workGrid > .work-card').length, originalImagesConnected: original.images.every(node=>node.isConnected),
          cardDocumentTop, originalCardDocumentTop: original.cardDocumentTop, controlDocumentTop, originalControlDocumentTop: original.controlDocumentTop,
          rect: { top:rect.top,bottom:rect.bottom,left:rect.left,right:rect.right,width:rect.width,height:rect.height }, header: { top:header.top,bottom:header.bottom,height:header.height }, viewport: { width:innerWidth,height:innerHeight },
          centerHit: hit===control || control.contains(hit), hit: hit && {tag:hit.tagName,className:hit.className}, scrollY, maxScroll:Math.max(0,document.documentElement.scrollHeight-innerHeight),
          anchor: anchor ? {id:anchor.dataset.workId,connected:anchor.isConnected,top:anchor.getBoundingClientRect().top-translation(anchor)} : null,
          pressed:control.getAttribute('aria-pressed'), label:control.getAttribute('aria-label'), feedbackRemaining:!!card.querySelector('.local-marker-error'), alerts:[...__alerts] };
      }, phase);
      try {
        await openSearch(page,"small"); const control = await marker(page).elementHandle();
        await page.evaluate(() => {
          const control=document.querySelector('.work-card[data-work-id="f0000"] .local-marker-button'),card=control.closest('.work-card'),input=document.querySelector('#workSearch');
          const chain=node=>{const result=[];for(;node;node=node.parentElement)result.push([node,node.parentNode]);return result;};
          const translation=node=>{const value=getComputedStyle(node).transform;return value==='none'?0:new DOMMatrixReadOnly(value).m42;};
          __nativeMarkerRecovery={control,card,input,controlChain:chain(control),inputChain:chain(input),cards:[...document.querySelectorAll('#workGrid > .work-card')],images:[...document.querySelectorAll('#workGrid .work-card img')],
            inputState:[input.value,input.selectionStart,input.selectionEnd,input.selectionDirection],cardDocumentTop:card.getBoundingClientRect().top+scrollY-translation(card),controlDocumentTop:control.getBoundingClientRect().top+scrollY-translation(card)-translation(control)};
        });
        await control.focus(); await waitMarkerResponse(page,()=>page.keyboard.press('Enter'));
        const retry=page.locator('.work-card[data-work-id="f0000"] .local-marker-retry');await retry.waitFor();
        for(let step=0;step<24&&!await retry.evaluate(node=>node===document.activeElement);step++) {await page.keyboard.press('Tab');tabs.push(await page.evaluate(()=>({tag:document.activeElement.tagName,className:document.activeElement.className,scrollY})));}
        assert.equal(await retry.evaluate(node=>node===document.activeElement),true,'native Tab must reach the A recovery retry');
        const url=page.url(),listReads=runtime.markerApiCalls.filter(call=>call.method==='GET'&&call.path==='/api/search').length;
        runtime.markerMutation=saved;await page.keyboard.press('Enter');await saved.requested;
        if(mode==='reason')await page.keyboard.press('Shift+Tab');
        if(mode==='input'){await page.locator('#workSearch').fill('原生重试期间的新中文草稿');await page.locator('#workSearch').evaluate(node=>node.setSelectionRange(1,6,'backward'));}
        if(mode==='wheel'){await page.mouse.move(310,320);await page.mouse.wheel(0,96);}
        if(mode==='page-down')await page.keyboard.press('PageDown');
        if(mode==='repeated'){await page.keyboard.press('Enter');await page.keyboard.press('Space');}
        if(mode==='repeated-pointer'){
          const target=await retry.evaluate(node=>{const box=node.getBoundingClientRect(),x=box.left+box.width/2,y=box.top+box.height/2,hit=document.elementFromPoint(x,y);return{x,y,hit:hit===node||node.contains(hit)};});
          assert.equal(target.hit,true,'the pending retry center must receive the actual repeated pointer activation');await page.mouse.click(target.x,target.y);
        }
        const settled=await settleScroll(page);assert.equal(settled.stable,true,'native viewport must settle before the success receipt');
        await page.evaluate(()=>{__nativeMarkerViewport=[...document.querySelectorAll('#workGrid > .work-card')].find(node=>{const box=node.getBoundingClientRect();return box.top>=0&&box.top<innerHeight;})||null;});
        const beforeAck=await capture('before ACK');
        assert.deepEqual(runtime.markerWrites.map(write=>write.enabled),[true,true],'native pending retry activation must remain deduplicated');
        if(mode==='wheel'||mode==='page-down'||mode==='retry'||mode==='repeated'||mode==='repeated-pointer')assert.equal(beforeAck.activeIsRetry,true,'the retry must retain focus before its success receipt');
        if(mode==='reason')assert.equal(beforeAck.activeIsReason,true,'native ShiftTab must focus the held retry cause');
        if(mode==='input')assert.equal(beforeAck.activeIsInput,true);
        await waitMarkerResponse(page,()=>saved.release());const afterAck=await capture('after ACK');
        const owned = ["retry", "reason", "repeated", "repeated-pointer"].includes(mode);
        const visible = afterAck.rect.top >= afterAck.header.bottom && afterAck.rect.bottom <= afterAck.viewport.height && afterAck.rect.left >= 0 && afterAck.rect.right <= afterAck.viewport.width && afterAck.centerHit;
        const viewportPreserved = Math.abs(afterAck.scrollY-beforeAck.scrollY)<1 || beforeAck.anchor && afterAck.anchor && Math.abs(afterAck.anchor.top-beforeAck.anchor.top)<1;
        const retained = afterAck.connected && afterAck.sameControl && afterAck.sameCard && afterAck.controlChain && afterAck.sameInput && afterAck.inputChain && afterAck.originalCardsConnected && afterAck.originalImagesConnected;
        const focusPreserved = owned ? afterAck.activeIsOriginal : mode === "input" ? afterAck.activeIsInput : afterAck.activeIsOriginal || afterAck.activeIsBody;
        if (!retained || !focusPreserved || owned && !visible || !owned && !viewportPreserved) {
          try {
            console.error("LOCAL_MARKER_NATIVE_RECOVERY_FAILURE", JSON.stringify({ mode, owned, visible, viewportPreserved, retained, focusPreserved, beforeAck, afterAck, tabs: tabs.slice(-24),
              writes: runtime.markerWrites.slice(-8), api: runtime.markerApiCalls.slice(-8).map(call => ({ method: call.method, path: String(call.path).slice(0, 256), query: String(call.query || "").slice(0, 128) })),
              dialogs: dialogs.slice(-4), faults: faults.slice(faultStart).slice(-4).map(value => String(value).slice(0, 512)) }));
          } catch (error) { console.error("LOCAL_MARKER_NATIVE_RECOVERY_DIAGNOSTIC_FAILED", String(error?.message || error).slice(0, 512)); }
        }
        assert(afterAck.connected&&afterAck.sameControl&&afterAck.sameCard&&afterAck.controlChain&&afterAck.sameInput&&afterAck.inputChain&&afterAck.originalCardsConnected&&afterAck.originalImagesConnected);
        assert.equal(afterAck.connectedOriginalCards,afterAck.originalMountedCards);assert(Math.abs(afterAck.cardDocumentTop-afterAck.originalCardDocumentTop)<1&&Math.abs(afterAck.controlDocumentTop-afterAck.originalControlDocumentTop)<1,'A/card document layout anchors must remain stable');
        assert.equal(afterAck.pressed,'true');assert.equal(afterAck.label,'移除 A 标记');assert.equal(afterAck.feedbackRemaining,false);assert.equal(page.url(),url);assert.equal(runtime.markerApiCalls.filter(call=>call.method==='GET'&&call.path==='/api/search').length,listReads);
        assert.deepEqual(runtime.markerWrites.map(write=>write.enabled),[true,true]);assert.deepEqual(afterAck.alerts,[]);assert.deepEqual(dialogs,[]);assert.deepEqual(faults.slice(faultStart),[]);await markerSafety(page);
        if(owned){
          assert.equal(afterAck.activeIsOriginal,true);assert(visible,'restored A marker control must be fully visible below the sticky header');
          assert.deepEqual(afterAck.inputState,beforeAck.inputState);
        }else{
          if(beforeAck.anchor)assert.equal(afterAck.anchor?.connected,true);
          assert(Math.abs(afterAck.scrollY-beforeAck.scrollY)<1||beforeAck.anchor&&afterAck.anchor&&Math.abs(afterAck.anchor.top-beforeAck.anchor.top)<1,'new viewport intent must prevent A recovery from pulling back the page');
          if(mode==='input'){assert.equal(afterAck.activeIsInput,true);assert.deepEqual(afterAck.inputState,beforeAck.inputState);}else{assert(afterAck.activeIsOriginal||afterAck.activeIsBody);assert.deepEqual(afterAck.inputState,beforeAck.inputState);}
        }
      }finally{saved.release();await page.close();}
    }
  }
  async function verifyLocalMarkerCurrentFailure() {
    const page = await newMarkerPage(3, 320), pending = deferred(), retrying = deferred();
    const cause = `Synthetic current marker failure：${"目录暂时无法访问，请检查占用后重试。".repeat(12)}${"LONG_UNBROKEN_CAUSE_".repeat(18)}最终原因`;
    runtime.markerMutation = { ...pending, error: cause };
    try {
      await openSearch(page, "small"); await marker(page).focus();
      const { control, selector } = await beginMarkerProbe(page, "f0000");
      await page.keyboard.press("Enter"); await pending.requested;
      const input = page.locator("#workSearch"), raw = "后来的中文标记草稿";
      await input.fill(raw); await input.evaluate(node => node.setSelectionRange(1, 5, "backward"));
      await pendingResponse(page); await page.evaluate(() => { __markerProbe.scroll = scrollY; });
      await waitMarkerResponse(page, () => pending.release());
      await assertMarkerProbe(page, selector, 3, { focus: false, feedback: true });
      assert.deepEqual(await input.evaluate(node => [node.value, node.selectionStart, node.selectionEnd, node.selectionDirection, node === document.activeElement]), [raw, 1, 5, "backward", true], "marker failure must respect a newer draft and input focus");
      assert.equal(await control.getAttribute("aria-label"), "添加 A 标记"); assert.equal(await control.getAttribute("aria-disabled"), "false");
      const feedback = await markerFeedback(page, cause);
      await endMarkerProbe(page);
      const geometry = await feedback.message.evaluate(node => ({ width: node.clientWidth, scrollWidth: node.scrollWidth, height: node.clientHeight, scrollHeight: node.scrollHeight,
        left: node.getBoundingClientRect().left, right: node.getBoundingClientRect().right, viewport: innerWidth, pageWidth: document.documentElement.scrollWidth }));
      assert(geometry.height > 0 && geometry.scrollHeight > geometry.height, "long marker causes must remain available in a visible scrollable recovery region");
      assert(geometry.scrollWidth <= geometry.width + 1 && geometry.left >= 0 && geometry.right <= geometry.viewport + 1 && geometry.pageWidth <= geometry.viewport + 1, "long marker causes must wrap without horizontal overflow at 320px");
      await feedback.message.focus(); await feedback.message.press("End");
      await page.waitForFunction(() => { const node = document.querySelector(".local-marker-error-message"); return node.scrollTop > 0 && node.scrollTop + node.clientHeight >= node.scrollHeight - 2; });
      await feedback.message.press("Home"); await page.waitForFunction(() => document.querySelector(".local-marker-error-message").scrollTop <= 1);
      assert.equal(await feedback.message.textContent(), cause, "keyboard scrolling must keep the first and final cause text available");
      const hit = await feedback.retry.evaluate(node => ({ width: node.getBoundingClientRect().width, height: node.getBoundingClientRect().height }));
      assert(hit.width >= 44 && hit.height >= 44, "the native marker retry must retain a 44px touch target");
      await feedback.retry.focus(); await pendingResponse(page); runtime.markerMutation = retrying;
      const retry = await beginMarkerProbe(page, "f0000"); await feedback.retry.press("Enter"); await retrying.requested;
      await assertSameMarkerFeedback(feedback); assert.equal(await feedback.message.textContent(), cause);
      assert.equal(await feedback.retry.getAttribute("aria-disabled"), "true"); assert.equal(await feedback.retry.getAttribute("aria-busy"), "true"); assert.equal(await feedback.retry.evaluate(node => node.disabled), false);
      await feedback.retry.press("Enter"); await feedback.retry.press("Space"); await pendingResponse(page);
      assert.deepEqual(runtime.markerWrites.map(write => write.enabled), [true, true], "a pending native retry must keep its failed explicit intent and suppress repeated activation");
      await waitMarkerResponse(page, () => retrying.release());
      await assertMarkerProbe(page, retry.selector, 3, { feedbackRemoval: true }); assert.equal(await control.getAttribute("aria-label"), "移除 A 标记");
      assert.equal(await feedback.panel.evaluate(node => node.isConnected), false, "a valid retry receipt must clear its old failure feedback");
      assert.equal(await control.evaluate(node => node === document.activeElement), true, "a successful focused retry must restore the original marker control");
      assert.equal(await control.getAttribute("aria-describedby"), null);
      assert.deepEqual(runtime.markerWrites.map(write => write.enabled), [true, true], "a failed intent must remain explicitly retryable");
      await endMarkerProbe(page); await markerSafety(page);
    } finally { pending.release(); retrying.release(); await page.close(); }
    await verifyLocalMarkerRepeatedFailure();
    await verifyLocalMarkerRetiredRetry();
  }
  async function verifyLocalMarkerRepeatedFailure() {
    for (const focusTarget of ["input", "message"]) {
    const page = await newMarkerPage(3, 320), repeated = deferred(), saved = deferred();
    runtime.markerMutation = { error: "Synthetic initial retry failure" };
    try {
      await openSearch(page, "small"); const control = await marker(page).elementHandle();
      await waitMarkerResponse(page, () => control.press("Enter")); const feedback = await markerFeedback(page, "Synthetic initial retry failure");
      runtime.markerMutation = { ...repeated, error: "Synthetic repeated retry failure" };
      await feedback.retry.focus(); await feedback.retry.press("Enter"); await repeated.requested;
      await assertSameMarkerFeedback(feedback); await waitMarkerResponse(page, () => repeated.release());
      await assertSameMarkerFeedback(feedback); assert.equal(await feedback.message.textContent(), "Synthetic repeated retry failure");
      assert.equal(await feedback.retry.evaluate(node => node === document.activeElement), true); assert.equal(await feedback.retry.getAttribute("aria-disabled"), "false");
      runtime.markerMutation = saved; await feedback.retry.press("Enter"); await saved.requested;
      const input = page.locator("#workSearch"); await input.fill("重试后更晚的中文草稿"); await input.evaluate(node => node.setSelectionRange(1, 6, "backward"));
      const before = await input.evaluate(node => [node.value, node.selectionStart, node.selectionEnd, node.selectionDirection, node === document.activeElement]);
      if (focusTarget === "message") await feedback.message.focus();
      await waitMarkerResponse(page, () => saved.release());
      assert.equal(await feedback.panel.evaluate(node => node.isConnected), false);
      if (focusTarget === "input") assert.deepEqual(await input.evaluate(node => [node.value, node.selectionStart, node.selectionEnd, node.selectionDirection, node === document.activeElement]), before, "successful marker retry must preserve a newer input focus instead of restoring its old control");
      else assert.equal(await control.evaluate(node => node === document.activeElement), true, "successful marker retry must restore the original control when its removed reason region has keyboard focus");
      assert.equal(await control.evaluate(node => node.isConnected), true); assert.equal(await control.getAttribute("aria-label"), "移除 A 标记");
      assert.deepEqual(runtime.markerWrites.map(write => write.enabled), [true, true, true]); assert.deepEqual(await page.evaluate(() => __alerts), []); await markerSafety(page);
    } finally { repeated.release(); saved.release(); await page.close(); }
    }
  }
  async function verifyLocalMarkerRetiredRetry() {
    const page = await newMarkerPage(3); runtime.markerMutation = { error: "Synthetic retired retry failure" };
    try {
      await openSearch(page, "small"); await waitMarkerResponse(page, () => marker(page).press("Enter"));
      const feedback = await markerFeedback(page, "Synthetic retired retry failure"); await openSearch(page, "same-id"); await pendingResponse(page);
      assert.equal(await feedback.panel.evaluate(node => node.isConnected), false); assert.equal(await page.locator(".local-marker-error").count(), 0);
      const before = await querySurface(page), writes = runtime.markerWrites.length;
      await feedback.retry.evaluate(node => node.click()); await pendingResponse(page);
      assert.equal(runtime.markerWrites.length, writes, "a retired marker retry must not restart its old failed intent on a same-ID replacement");
      assert.deepEqual(await querySurface(page), before); assert.equal(await marker(page).getAttribute("aria-label"), "添加 A 标记"); await markerSafety(page);
    } finally { await page.close(); }
  }
  async function verifyLocalMarkerObsolete(failed) {
    const page = await newMarkerPage(3), pending = deferred(); runtime.markerMutation = { ...pending, error: failed ? "Synthetic obsolete marker failure" : "" };
    try {
      await openSearch(page, "small"); const old = await marker(page).elementHandle(); await old.press("Enter"); await pending.requested;
      await openSearch(page, "new-error"); await page.locator(".search-error-state").waitFor();
      await page.locator("#workSearch").fill("新的错误页草稿"); await page.locator("#workSearch").evaluate(node => node.setSelectionRange(1, 4, "backward"));
      const before = await querySurface(page), reads = runtime.reads.length;
      await waitMarkerResponse(page, () => pending.release());
      assert.deepEqual(await querySurface(page), before, "an obsolete marker receipt must not repaint or alert over the newer search error");
      await old.evaluate(node => node.click()); await pendingResponse(page);
      assert.equal(runtime.markerWrites.length, 1, "a detached old marker button must not restart its old write");
      assert.equal(runtime.reads.length, reads); await markerSafety(page);
    } finally { pending.release(); await page.close(); }
    if (failed) await verifyLocalMarkerFailedHistory();
    if (!failed) {
      await verifyLocalMarkerPendingHistory();
      await verifyLocalMarkerAcceptedError();
      await verifyLocalMarkerAcceptedHistory();
    }
  }
  async function verifyLocalMarkerFailedHistory() {
    const page = await newMarkerPage(3), library = deferred(), pending = deferred();
    runtime.libraryRead = library; runtime.markerMutation = { ...pending, error: "Synthetic obsolete mounted marker failure" };
    try {
      await page.addInitScript(() => {
        if (location.pathname === "/fanhao" && location.search === "?q=small") {
          history.replaceState(null, "", "/fanhao"); history.pushState(null, "", "/fanhao?q=small");
        }
      });
      await page.goto(`${base}/fanhao?q=small`); await marker(page).waitFor(); await library.requested;
      const control = await marker(page).elementHandle(); await control.press("Enter"); await pending.requested;
      await page.goBack({ waitUntil: "commit" }); await pendingResponse(page);
      assert.equal(new URL(page.url()).search, ""); assert.equal(await control.evaluate(node => node.isConnected), true, "pending library history must leave the original marker card mounted for its obsolete failure");
      await page.locator("#workSearch").fill("失败回执之后的历史草稿"); await page.locator("#workSearch").evaluate(node => node.setSelectionRange(1, 5, "backward"));
      const before = await querySurface(page), reads = runtime.reads.length;
      await waitMarkerResponse(page, () => pending.release());
      assert.deepEqual(await querySurface(page), before, "an obsolete marker failure must not publish feedback during newer pending history navigation");
      assert.equal(await page.locator(".local-marker-error").count(), 0); assert.deepEqual(await page.evaluate(() => __alerts), []); assert.equal(runtime.reads.length, reads);
      library.release(); await page.locator(".person-index-card").waitFor(); assert.equal(new URL(page.url()).search, "");
      assert.deepEqual(runtime.markerWrites.map(write => write.enabled), [true]); await markerSafety(page);
    } finally { pending.release(); library.release(); await page.close(); }
  }
  async function verifyLocalMarkerAcceptedError() {
    const page = await newMarkerPage(3), pending = deferred(); runtime.markerMutation = pending;
    try {
      await openSearch(page, "small"); const origin = await marker(page).elementHandle(); await origin.press("Enter"); await pending.requested;
      const empty = await acceptEmptyMarkerDestination(page, "query", origin);
      runtime.markerReadFailure = { match: url => markerDestination("query", url), error: "Synthetic newer same-category read failure" };
      const failed = page.waitForResponse(response => response.request().method() === "GET" && markerDestination("query", new URL(response.url())));
      await page.locator("#workSearch").press("Enter"); const response = await failed; await response.finished();
      assert.equal(response.status(), 503); const panel = await page.locator(".search-error-state").elementHandle(); assert(panel);
      await pendingResponse(page); assert.equal(await empty.evaluate(node => node.isConnected), false);
      assert.equal(new URL(page.url()).searchParams.get("q"), "[A]"); assert.equal(runtime.markerReadFailure.used, true);
      await page.locator("#workSearch").fill("后来失败页的中文草稿"); await page.locator("#workSearch").evaluate(node => node.setSelectionRange(1, 5, "backward"));
      const before = await querySurface(page), reads = markerDestinationReads("query").length;
      await waitMarkerResponse(page, () => pending.release());
      assert.equal(runtime.markers.has("f0000"), true);
      assert.deepEqual(await querySurface(page), before, "a marker ACK must preserve a newer failed read of the same accepted marker destination");
      assert.equal(await panel.evaluate(node => node.isConnected && node === document.querySelector(".search-error-state")), true, "the newer same-category recovery panel must retain its original DOM owner");
      assert.equal(markerDestinationReads("query").length, reads, "retired empty membership must not restart over a newer same-category error");
      assert.deepEqual(runtime.markerWrites.map(write => write.enabled), [true]); await markerSafety(page);
    } finally { pending.release(); await page.close(); }
  }
  async function verifyLocalMarkerAcceptedHistory() {
    const page = await newMarkerPage(3), library = deferred(), pending = deferred();
    runtime.libraryRead = library; runtime.markerMutation = pending;
    try {
      await page.addInitScript(() => {
        if (location.pathname === "/fanhao" && location.search === "?q=small") {
          history.replaceState(null, "", "/fanhao"); history.pushState(null, "", "/fanhao?q=small");
        }
      });
      await page.goto(`${base}/fanhao?q=small`); await marker(page).waitFor(); await library.requested;
      const origin = await marker(page).elementHandle(); await origin.press("Enter"); await pending.requested;
      const empty = await acceptEmptyMarkerDestination(page, "query", origin);
      await page.goBack({ waitUntil: "commit" }); await pendingResponse(page);
      assert.equal(new URL(page.url()).search, "");
      assert.equal(await empty.evaluate(node => node.isConnected), true, "pending library history must leave the accepted empty anchor mounted until its navigation can finish");
      await page.locator("#workSearch").fill("历史导航等待中的草稿"); await page.locator("#workSearch").evaluate(node => node.setSelectionRange(1, 5, "backward"));
      const before = await querySurface(page), reads = markerDestinationReads("query").length;
      await waitMarkerResponse(page, () => pending.release());
      assert.equal(runtime.markers.has("f0000"), true);
      assert.deepEqual(await querySurface(page), before, "an accepted empty marker owner must yield to pending canonical history navigation");
      assert.equal(markerDestinationReads("query").length, reads, "an accepted empty marker owner must not restart its old destination while history waits for the library");
      assert.equal(new URL(page.url()).search, "");
      library.release(); await page.locator(".person-index-card").waitFor();
      assert.equal(await page.locator(".work-card").count(), 0); assert.equal(new URL(page.url()).search, "");
      assert.deepEqual(runtime.markerWrites.map(write => write.enabled), [true]); await markerSafety(page);
    } finally { pending.release(); library.release(); await page.close(); }
  }
  async function verifyLocalMarkerPendingHistory() {
    const page = await newMarkerPage(3), library = deferred(), pending = deferred();
    runtime.works.forEach(work => runtime.markers.add(work.id)); runtime.libraryRead = library; runtime.markerMutation = pending;
    try {
      await page.addInitScript(() => {
        if (location.pathname === "/fanhao" && location.search === "?q=small") {
          history.replaceState(null, "", "/fanhao"); history.pushState(null, "", "/fanhao?q=small");
        }
      });
      await page.goto(`${base}/fanhao?q=small`); await marker(page).waitFor(); await library.requested;
      const filtered = page.waitForResponse(response => new URL(response.url()).pathname === "/api/search" && new URL(response.url()).searchParams.get("filter") === "localMarkedA");
      await page.locator('[data-work-filter="localMarkedA"]').click(); await (await filtered).finished();
      const control = await marker(page).elementHandle(); await control.press("Enter"); await pending.requested;
      await openSearch(page, "same-id");
      await page.goBack({ waitUntil: "commit" });
      assert.equal(new URL(page.url()).search, "");
      assert.equal(await control.evaluate(node => node.isConnected), false, "the marker origin is retired while its same-ID replacement remains visible for pending library history");
      assert.equal(await marker(page).count(), 1);
      const searches = runtime.reads.filter(read => read.path === "/api/search").length;
      await waitMarkerResponse(page, () => pending.release());
      assert.equal(runtime.reads.filter(read => read.path === "/api/search").length, searches, "an old marker receipt must not restart its filtered query while history waits for the library");
      assert.equal(new URL(page.url()).search, "", "marker membership maintenance must respect the pending canonical history route");
      library.release(); await page.locator(".person-index-card").waitFor();
      assert.equal(await page.locator(".work-card").count(), 0); assert.equal(new URL(page.url()).search, "");
      assert.deepEqual(runtime.markerWrites.map(write => write.enabled), [false]); await markerSafety(page);
    } finally { pending.release(); library.release(); await page.close(); }
  }
  async function verifyLocalMarkerReplacementRaces() {
    for (const order of ["replacement-first", "marker-first"]) {
      const page = await newMarkerPage(3), pending = deferred(), reading = deferred(); runtime.markerMutation = pending; runtime.allowFavoriteWrite = true;
      try {
        await openSearch(page, "small"); await marker(page).press("Enter"); await pending.requested;
        runtime.works[0].title = "New current marker title";
        runtime.works[0].markerVideoMetadata = { progress: { positionMs: 42000, durationMs: 60000 } };
        if (order === "marker-first") runtime.markerRead = { ...reading, match: url => url.pathname === "/api/search" && url.searchParams.get("q") === "same-id" };
        await page.locator("#workSearch").fill("same-id"); await page.locator("#workSearch").press("Enter");
        if (order === "marker-first") {
          await reading.requested;
          assert.deepEqual(runtime.markerRead.snapshot.works[0].localMarkers, [], "the controlled replacement snapshot must precede marker confirmation");
          await page.locator("#workSearch").fill("更晚的中文草稿"); await page.locator("#workSearch").evaluate(node => node.setSelectionRange(1, 5, "backward"));
          await waitMarkerResponse(page, () => pending.release());
          const response = page.waitForResponse(item => new URL(item.url()).pathname === "/api/search" && new URL(item.url()).searchParams.get("q") === "same-id");
          reading.release(); await (await response).finished(); await marker(page).waitFor();
        } else {
          await marker(page).waitFor();
          assert.equal(await marker(page).getAttribute("aria-disabled"), "true", "a same-ID replacement button must reflect the pending marker write");
          const writes = runtime.markerWrites.length; await marker(page).evaluate(node => node.click()); await pendingResponse(page);
          assert.equal(runtime.markerWrites.length, writes);
          await postClick(page, star(page, "f0000"));
          await page.locator("#workSearch").fill("更晚的中文草稿"); await page.locator("#workSearch").evaluate(node => node.setSelectionRange(1, 5, "backward"));
          await page.evaluate(() => { globalThis.__markerReplacement = document.querySelector('.work-card[data-work-id="f0000"]'); });
          await waitMarkerResponse(page, () => pending.release());
          assert.equal(await page.evaluate(() => __markerReplacement.isConnected && __markerReplacement === document.querySelector('.work-card[data-work-id="f0000"]')), true, "a marker receipt must retain the replacement card");
          assert.equal(await star(page, "f0000").getAttribute("aria-label"), "取消收藏", "old marker metadata must not roll back a newer confirmed favorite");
        }
        await pendingResponse(page);
        assert.equal(await marker(page).getAttribute("aria-label"), "移除 A 标记", "an accepted stale list snapshot must not roll back a newer marker receipt");
        assert.equal(await marker(page).getAttribute("aria-disabled"), "false");
        assert.equal(await page.locator('.work-card[data-work-id="f0000"] .work-title').textContent(), "New current marker title");
        assert.deepEqual(await page.locator("#workSearch").evaluate(node => [node.value, node.selectionStart, node.selectionEnd, node === document.activeElement]), ["更晚的中文草稿", 1, 5, true]);
        await markerSafety(page);
      } finally { pending.release(); reading.release(); await page.close(); }
    }
  }
  async function verifyLocalMarkerMembership(kind) {
    const page = await newMarkerPage(60, 390); runtime.works.forEach(work => runtime.markers.add(work.id));
    try {
      if (kind === "query") await openSearch(page, "[A]");
      else {
        await page.goto(`${base}/fanhao`); await page.locator(".person-index-card").click();
        await page.locator('[data-work-filter="localMarkedA"]').click(); await marker(page).waitFor();
      }
      assert.equal(await page.locator(".work-card").count() < 60, true);
      const before = runtime.reads.length;
      await waitMarkerResponse(page, () => marker(page).press("Enter"));
      await page.waitForFunction(() => !document.querySelector('.work-card[data-work-id="f0000"]'));
      await loadAll(page, 59);
      const ids = await page.locator(".work-card").evaluateAll(nodes => nodes.map(node => node.dataset.workId));
      assert.equal(new Set(ids).size, 59); assert(!ids.includes("f0000")); assert(ids.includes("f0048") && ids.includes("f0059"), "marker membership refresh must not skip a boundary row");
      const reads = runtime.reads.slice(before).filter(read => read.path === (kind === "query" ? "/api/search" : "/api/people/favorite-person"));
      assert.equal(reads[0]?.offset, 0, "marker membership changes must reread the current prefix from zero");
      assert(reads.some(read => read.offset === 48), "the reloaded marker prefix must continue from its consumed raw rows");
      assert.equal(runtime.markerWrites.length, 1); await markerSafety(page);
    } finally { await page.close(); }
    await verifyLocalMarkerPendingMembership(kind);
  }
  async function verifyLocalMarkerPendingMembership(kind) {
    const page = await newMarkerPage(60, 390, true), pending = deferred(), reading = deferred();
    runtime.works.forEach(work => runtime.markers.add(work.id)); runtime.markerMutation = pending;
    const memberPath = kind === "query" ? "/api/search" : "/api/people/favorite-person";
    const memberScope = url => url.pathname === memberPath && (kind === "query" ? url.searchParams.get("q") === "[A]" : (url.searchParams.get("filter") || "").split(",").includes("localMarkedA"));
    try {
      if (kind === "query") await openSearch(page, "small");
      else { await page.goto(`${base}/fanhao`); await page.locator(".person-index-card").click(); await marker(page).waitFor(); }
      await marker(page).press("Enter"); await pending.requested;
      runtime.markerRead = { ...reading, match: url => memberScope(url) && Number(url.searchParams.get("offset") || 0) === 0 };
      if (kind === "query") { await page.locator("#workSearch").fill("[A]"); await page.locator("#workSearch").press("Enter"); }
      else await page.locator('[data-work-filter="localMarkedA"]').click();
      await reading.requested;
      assert.equal(runtime.markerRead.snapshot.total, 60); assert.deepEqual(runtime.markerRead.snapshot.works[0].localMarkers, ["A"]);
      const heldId = await page.evaluate(() => __markerMemberStarted.at(-1).id), before = runtime.markerApiCalls.length;
      await waitMarkerResponse(page, () => pending.release());
      reading.release(); await page.waitForFunction(id => __markerMemberSettled.includes(id), heldId);
      await page.locator('.work-card[data-work-id="f0001"]').waitFor(); await pendingResponse(page);
      assert.equal(await page.locator('.work-card[data-work-id="f0000"]').count(), 0, "a held marked-membership snapshot must not restore a newly unmarked work");
      await loadAll(page, 59);
      const ids = await page.locator(".work-card").evaluateAll(nodes => nodes.map(node => node.dataset.workId));
      assert.equal(new Set(ids).size, 59); assert(ids.includes("f0048") && ids.includes("f0059"));
      const reads = runtime.markerApiCalls.slice(before).filter(read => read.method === "GET" && memberScope(new URL(`${read.path}${read.query}`, base)));
      assert.deepEqual(reads.map(read => Number(new URL(`${read.path}${read.query}`, base).searchParams.get("offset") || 0)), [0, 48], "pending marker membership must refresh once from zero and continue at its raw prefix");
      if (kind === "query") assert.equal(await page.locator("#statsRow .stat").filter({ hasText: "当前筛选" }).locator("strong").textContent(), "59");
      else assert.match(await page.locator(".browse-result-summary").textContent(), /59/);
      assert.equal(runtime.markerWrites.length, 1); await markerSafety(page);
    } finally { pending.release(); reading.release(); await page.close(); }
  }
}
function folderDtos(runtime) {
  return [["default", "默认"], ["later", "稍后"]].map(([id, name]) => ({ id, name,
    count: [...runtime.favorites].filter(workId => (runtime.folderIds.get(workId) || "default") === id).length }));
}
function respond(res, body, type, status = 200) { if (!res.destroyed) { res.writeHead(status, { "Content-Type": type, "Cache-Control": "no-store" }); res.end(body); } }
function json(res, body, status = 200) { respond(res, JSON.stringify(body), "application/json", status); }
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const baselinePath = process.argv.find(value => value.startsWith("--baseline="))?.slice(11);
  const caseOption = process.argv.find(value => value.startsWith("--case=")), negativeOnly = process.argv.includes("--negative-only");
  assert(!(negativeOnly && (baselinePath || caseOption)), "negative-only cannot be combined with baseline or case");
  if (!negativeOnly) await runFanhaoFavoriteUpdates({ baseline: Boolean(baselinePath), casePattern: caseOption?.slice(7) || "", sourceOverrides: baselinePath ? { "/modules/fanhao/features/works/work-actions.js": fs.readFileSync(baselinePath, "utf8") } : {} });
  if (!baselinePath && !caseOption) {
    const app = fs.readFileSync(path.join(publicRoot, "app.js"), "utf8").replaceAll("\r\n", "\n");
    const workActions = fs.readFileSync(path.join(publicRoot, "modules/fanhao/features/works/work-actions.js"), "utf8").replaceAll("\r\n", "\n");
    const collectionPage = fs.readFileSync(path.join(publicRoot, "modules/fanhao/features/collections/collection-page.js"), "utf8").replaceAll("\r\n", "\n");
    for (const negative of [
      { name: "ordinary favorite in-place update", casePattern: "1000-card favorite success", marker: 'if (state.activeView === "favorites") {\n        if (kind === "folder" && !removedWorkIds.length && foldersSynced) return true;\n        return false;\n      }', replacement: "return false;", failure: /one favorite update must retain all 1000 existing work cards/ },
      { name: "obsolete favorite failure feedback ownership", casePattern: "late favorite failure cannot replace a new query error", marker: "if (current) showFavoriteError(workId, control, error, ownsOrigin);", replacement: "showFavoriteError(workId, control, error, ownsOrigin);", failure: /an obsolete favorite failure must not publish feedback during newer pending history navigation/ },
      { name: "same-ID replacement star synchronization", casePattern: "favorite completion synchronizes the same ID in a replacement grid", marker: 'const cards = [...grid.querySelectorAll(".work-card")].filter(card => card.dataset.workId === String(workId));', replacement: "const cards = [];", failure: /the current same-ID card must receive confirmed favorite state/ },
      { name: "same-ID replacement favorite pending initialization", casePattern: "ordinary favorite pending follows same-ID replacement", marker: "const favoritePending = isFavoritePending(work.id);", replacement: "const favoritePending = false;", failure: /replacement favorite star must reflect the outstanding same-work toggle/ },
      { name: "favorite pending survives a folder receipt", casePattern: "ordinary favorite pending follows same-ID replacement", marker: "if (favorite) syncControl(favorite, work.favorite, isFavoritePending(workId));", replacement: "if (favorite) syncControl(favorite, work.favorite, false);", failure: /a favorite-folder receipt must preserve the same-work favorite pending star/ },
      { name: "persistent favorite failure feedback", casePattern: "ordinary favorite failure keeps a persistent safe feedback surface", marker: "if (current) showFavoriteError(workId, control, error, ownsOrigin);", replacement: "if (current) void error;", failure: /a current favorite failure must keep its uncertain result and cause visible/ },
      { name: "stable repeated favorite cause", casePattern: "ordinary favorite failure keeps a persistent safe feedback surface", marker: 'let panel = card.querySelector(":scope > .favorite-error");\n  if (!panel) {', replacement: 'let panel = null;\n  if (!panel) {', failure: /a repeated favorite failure must update the original cause node/ },
      { name: "busy favorite dismissal guard", casePattern: "ordinary favorite failure keeps a persistent safe feedback surface", marker: "if (!ownsOrigin() || panel.parentNode !== card || !dismiss.isConnected || isFavoritePending(workId)) return;", replacement: "if (!ownsOrigin() || panel.parentNode !== card || !dismiss.isConnected) return;", failure: /a busy favorite dismissal must retain its existing feedback/ },
      { name: "favorite cleanup focus ownership", casePattern: "ordinary favorite failure keeps a persistent safe feedback surface", marker: "const restoreFocus = panel.contains(document.activeElement) && ownsOrigin() && !control.disabled;", replacement: "const restoreFocus = ownsOrigin() && !control.disabled;", failure: /favorite feedback must preserve a newer input draft, caret and focus/ },
      { name: "favorite cleanup viewport ownership", casePattern: "ordinary favorite failure keeps a persistent safe feedback surface", marker: "else clearFavoriteError(control, ownsOrigin, !newerFavoriteRecoveryViewportGesture);", replacement: "else clearFavoriteError(control, ownsOrigin, true);", failure: /a later wheel gesture must prevent favorite cleanup from revealing its star/ },
      { name: "mounted obsolete favorite dismissal ownership", casePattern: "ordinary favorite failure keeps a persistent safe feedback surface", marker: "if (!ownsOrigin() || panel.parentNode !== card || !dismiss.isConnected || isFavoritePending(workId)) return;", replacement: "if (panel.parentNode !== card || !dismiss.isConnected || isFavoritePending(workId)) return;", failure: /an obsolete mounted favorite dismissal must not clear its old owner's feedback/ },
      { name: "favorite-folder receipt ownership", source: workActions, path: "/modules/fanhao/features/works/work-actions.js", casePattern: "favorite folder late success", marker: 'const ui = beginFavoriteUi?.({ workId: work.id, control, syncControl: syncFavoriteControl, showError, kind: "folder", requestedFolderId: folderId });', replacement: "const ui = null;", failure: /a late favorite-folder completion must not repaint or alert/ },
      { name: "favorite-folder current failure recovery", casePattern: "favorite folder current failure", marker: "if (current) showFavoriteFolderError(workId, control, error, requestedFolderId, ownsOrigin);", replacement: "if (current) void error;", failure: /a current favorite-folder failure must keep its cause and explicit retry visible/ },
      { name: "favorite-folder browser-only scroll focus ownership", casePattern: "favorite folder native focus restoration", folderFocusMode: "browser-scroll", marker: 'if (kind !== "folder") intentEvents.push("scroll");', replacement: 'intentEvents.push("scroll");', failure: /a folder failure must restore its original select after a browser-only scroll notification/ },
      { name: "favorite-folder restored focus visibility", casePattern: "favorite folder native focus restoration", folderFocusMode: "browser-scroll", marker: 'if (delta) window.scrollBy({ top: delta, left: 0, behavior: "instant" });', replacement: "if (delta) void delta;", failure: /restored folder select must be visible below the sticky header/ },
      { name: "favorite-folder retry cleanup visibility", casePattern: "favorite folder retry cleanup respects newer viewport intent", folderRetryMode: "browser-scroll", marker: "clearFavoriteFolderError(control, ownsOrigin, !newerRecoveryViewportGesture);", replacement: "clearFavoriteFolderError(control, ownsOrigin, false);", failure: /restored folder retry control must be fully visible below the sticky header/ },
      { name: "favorite-folder retry viewport ownership", casePattern: "favorite folder retry cleanup respects newer viewport intent", folderRetryMode: "wheel", marker: "clearFavoriteFolderError(control, ownsOrigin, !newerRecoveryViewportGesture);", replacement: "clearFavoriteFolderError(control, ownsOrigin, true);", failure: /new viewport intent must survive successful folder retry cleanup/ },
      { name: "favorite-folder repeated retry pointer ownership", casePattern: "favorite folder retry cleanup respects newer viewport intent", folderRetryMode: "repeated-pointer", marker: 'if (event.type === "pointerdown" && folderRetry.contains(event.target)) return;', replacement: "", failure: /restored folder retry control must be fully visible below the sticky header/ },
      { name: "favorite-folder in-place update", casePattern: "favorite folder update retains", marker: 'if (kind === "folder" && !removedWorkIds.length && foldersSynced) return true;', replacement: "if (false) return true;", failure: /a favorite-folder update must retain all 1000 existing work cards/ },
      { name: "favorite-folder pending replacement control", casePattern: "favorite folder pending follows", marker: "select.disabled = isFavoriteFolderPending(work.id);", replacement: "select.disabled = false;", failure: /a replacement folder select must reflect the outstanding same-work write/ },
      { name: "pending history URL ownership", casePattern: "favorite completion yields to history waiting for the initial library after grid replacement", marker: 'if (state.activeView !== "search" || (route.view === "search" && route.q === state.searchQuery)) {\n            refreshFavoriteFilteredWorks();\n          }', replacement: "refreshFavoriteFilteredWorks();", failure: /an obsolete visible favorite control must not restart its old filtered search during history navigation/ },
      { name: "raw history query normalization", casePattern: "favorite completion refreshes a genuinely replaced filtered grid", marker: 'const route = normalizeRoute(routeFromUrl());\n          if (state.activeView !== "search"', replacement: 'const route = routeFromUrl();\n          if (state.activeView !== "search"', failure: /a genuinely new filtered grid must still refresh its changed membership/ },
      { name: "pending destination folder shape", source: collectionPage, path: "/modules/fanhao/features/collections/collection-page.js", casePattern: "favorite folder destination held read", marker: "request.favoriteShape = requestShape(path);", replacement: 'request.favoriteShape = "";', failure: /commit must replace the pending destination snapshot with a fresh same-condition read/ },
      { name: "failed destination read ownership", source: collectionPage, path: "/modules/fanhao/features/collections/collection-page.js", casePattern: "favorite folder destination read error", marker: "const pending = pendingRead?.favoriteShape === shape;", replacement: "const pending = true;", failure: /a folder receipt must not cover a newer destination read error/ }
    ]) {
      const source = negative.source || app;
      assert.equal(source.split(negative.marker).length - 1, 1, `negative must modify the current owning behavior: ${negative.name}`);
      await assert.rejects(() => runFanhaoFavoriteUpdates({ casePattern: negative.casePattern, folderFocusMode: negative.folderFocusMode || "", folderRetryMode: negative.folderRetryMode || "", sourceOverrides: { [negative.path || "/app.js"]: source.replace(negative.marker, negative.replacement) } }), { name: "AssertionError", message: negative.failure });
      console.log(`PASS negative control detects missing ${negative.name}`);
    }
  }
}
