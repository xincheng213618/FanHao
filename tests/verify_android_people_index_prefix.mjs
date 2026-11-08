import assert from "node:assert/strict";
import fs from "node:fs";
import { spawn } from "node:child_process";
import { chromium } from "playwright-core";

const chrome = [process.env.CHROME_PATH, "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe"].filter(Boolean).find(file => fs.existsSync(file));
assert(chrome, "Chrome or Edge required for Android people fixture");
assert(process.argv.slice(2).every(value => value === "--baseline"), "known fixture arguments");
const baseline = process.argv.includes("--baseline");
const count = 24000;
const people = Array.from({ length: count }, (_, index) => ({
  id: `synthetic-person-${index}`, name: `合成人物 ${(index * 7919) % count}`,
  workCount: index < 130 ? 999 : index % 21, sourceCount: index < 130 ? 8 : index % 5,
  isWestern: index % 23 === 0,
  actorProfile: { gender: index % 9 === 0 ? "male" : "female",
    ...(index < 130 ? { displayName: "合成同名" } : {}),
    avatarUrl: index % 8 === 0 ? "" : "/fixture/poster/person-one.svg" }
}));
const payload = { people, works: [], totals: { people: count }, user: {}, availableRoots: [], access: { mode: "loopback" } };
const body = JSON.stringify(payload);
const legacyPeople = people.slice(0, 900).map((person, index) => ({ ...person,
  workCount: index % 11 === 0 ? "历史计数" : String(index % 19),
  sourceCount: index % 7 === 0 ? "历史计数" : String(index % 4) }));
const legacyBody = JSON.stringify({ ...payload, people: legacyPeople, totals: { people: legacyPeople.length } });
const service = spawn(process.execPath, ["tests/serve_android_gallery_navigation_fixture.mjs"], { cwd: new URL("../", import.meta.url), stdio: ["ignore", "pipe", "inherit"] });
const exit = new Promise(resolve => service.once("exit", resolve));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const median = values => values.toSorted((a, b) => a - b)[Math.floor(values.length / 2)];
let browser;
try {
  const origin = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Synthetic service start timed out")), 15000);
    service.once("error", error => { clearTimeout(timer); reject(error); });
    service.once("exit", code => { clearTimeout(timer); reject(new Error(`Synthetic service exited ${code}`)); });
    let output = "";
    service.stdout.on("data", data => { output += data; const url = /http:\/\/127\.0\.0\.1:\d+/.exec(output); if (url) { clearTimeout(timer); resolve(url[0]); } });
  });
  const created = await fetch(`${origin}/fixture/new-run`, { method: "POST" });
  assert.equal(created.status, 200);
  const { url } = await created.json();
  const entry = `${origin}${url}#people`;
  browser = await chromium.launch({ executablePath: chrome, headless: true });
  for (const rate of [1, 4]) {
    const samples = [];
    for (let iteration = 0; iteration < 4; iteration++) {
      const page = await browser.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
      const errors = [], reads = [];
      let offline = false, legacyCounts = false;
      page.on("pageerror", error => errors.push(error.message));
      try {
        const cdp = await page.context().newCDPSession(page);
        await cdp.send("Emulation.setCPUThrottlingRate", { rate });
        await page.route("**/*", async route => {
          const request = route.request(), url = new URL(request.url());
          if (url.origin !== origin || !["GET", "HEAD"].includes(request.method())) {
            errors.push(`${request.method()} ${url.origin}${url.pathname}`);
            return route.abort();
          }
          if (url.pathname === "/api/library") {
            reads.push(url);
            return offline ? route.abort() : route.fulfill({ contentType: "application/json", body: legacyCounts ? legacyBody : body });
          }
          if (!url.pathname.endsWith("/modules/fanhao/people-views.js")) return route.continue();
          const response = await route.fetch();
          let source = await response.text();
          const replace = (marker, result) => {
            assert.equal(source.split(marker).length, 2, `observe exactly one actual people module hook: ${marker}`);
            source = source.replace(marker, result);
          };
          if (baseline) {
            const marker = "const rankUntil = createPeopleRanker(people, compare, validCounts ? limit + PEOPLE_PAGE_SIZE : people.length);";
            replace(marker, "people.sort(compare); const rankUntil = () => people;");
          }
          const render = "  function renderPeopleData(sourcePeople, scope) {";
          replace(render, `${render}\n    const reading = { start: performance.now(), comparisons: 0 };\n    window.peopleComparison = reading;\n    try { return measuredPeopleData(sourcePeople, scope); }\n    finally { const now = performance.now(); reading.ms = now - reading.start; reading.visibleMs = now - (window.peopleActionStart || 0); window.peopleIndexSamples.push(reading); window.peopleComparison = null; }\n  }\n  function measuredPeopleData(sourcePeople, scope) {`);
          const comparator = "  function comparePeople(a, b, mode, sortFields) {";
          replace(comparator, `${comparator}\n    if (window.peopleComparison) window.peopleComparison.comparisons++;\n    else if (window.peopleContinuation) window.peopleContinuation.comparisons++;`);
          const card = 'button.className = mode === "preview" ? "person-card" : "index-person-card";';
          replace(card, `${card}\n    if (mode === "index") button.dataset.fixturePersonId = person.id;`);
          return route.fulfill({ response, body: source });
        });
        await page.addInitScript(() => {
          window.peopleIndexSamples = [];
          document.addEventListener("click", event => {
            const button = event.target.closest?.("button");
            if (button?.closest(".people-category-strip") || button?.textContent.trim().startsWith("名称排序")) window.peopleActionStart = performance.now();
          }, true);
        });
        await page.goto(entry);
        const cards = page.locator(".index-person-card");
        await cards.first().waitFor();
        const ids = () => cards.evaluateAll(nodes => nodes.map(node => node.dataset.fixturePersonId));
        assert.deepEqual(await ids(), expected("recommended", "smart", 64));
        const filter = page.getByRole("navigation", { name: "演员分类", exact: true });
        await filter.getByRole("button", { name: /^全部/ }).click();
        assert.deepEqual(await ids(), expected("all", "smart", 64));
        await page.getByRole("button", { name: "排序，当前推荐排序", exact: true }).click();
        await page.getByRole("button", { name: /^名称排序/ }).click();
        assert.deepEqual(await ids(), expected("all", "name", 64));
        assert.equal(reads.length, 1, "sorting and filtering use the same dashboard snapshot");
        assert.deepEqual(errors, []);
        const metrics = await page.evaluate(() => peopleIndexSamples.filter(sample => sample.comparisons > 0));
        assert.equal(metrics.length, 3);
        if (iteration > 0) samples.push(metrics.map(({ ms, visibleMs, comparisons }) => ({ ms, visibleMs, comparisons })));
        if (iteration === 0 && rate === 1) {
          const first = await cards.first().elementHandle();
          const extension = [];
          const append = () => page.getByRole("button", { name: /^向下滑动继续加载/ }).evaluate(button => {
            const start = performance.now();
            window.peopleContinuation = { comparisons: 0 };
            button.click();
            const result = { comparisons: window.peopleContinuation.comparisons, ms: performance.now() - start };
            window.peopleContinuation = null;
            return result;
          });
          for (const target of [128, 192, 256, 320]) {
            extension.push(await append());
            assert.deepEqual(await ids(), expected("all", "name", target));
          }
          assert.equal(await first.evaluate(card => card.isConnected), true, "continuation retains the existing mounted cards");
          assert.equal(extension[0].comparisons, 0, "first continuation never repeats ranking");
          if (!baseline) {
            const pageBound = 64 * 2 * Math.ceil(Math.log2(count));
            assert(extension.slice(1).every(row => row.comparisons > 0 && row.comparisons <= pageBound),
              "a deeper continuation extracts only one bounded page");
          }
          console.log(JSON.stringify({ continuation: extension, baseline }));
          if (!baseline) {
            await page.waitForFunction(async () => {
              const { readCachedJson } = await import(new URL("./js/cache.js", location.href));
              return Boolean((await readCachedJson(location.origin, "/api/library"))?.payload?.people?.length);
            });
            offline = true;
            await page.reload(); await cards.first().waitFor();
            assert.deepEqual(await ids(), expected("all", "name", 64), "offline reload uses the same real cached snapshot and persisted filter/sort");
            await page.evaluate(async () => {
              const { setAccountOwner } = await import(new URL("./js/account-owner.js", location.href));
              setAccountOwner(location.origin, "pending");
            });
            assert.equal(await cards.count(), 0, "an account transition retires the mounted ranking");
            assert.deepEqual(errors, []);
            console.log("PASS actual IndexedDB offline reload and account invalidation");

            offline = false;
            legacyCounts = true;
            await page.reload();
            await page.waitForFunction(() => document.getElementById("viewMeta")?.textContent.startsWith("900 位演员"));
            await page.locator('#moduleChrome button[aria-label^="排序"]').click();
            await page.getByRole("button", { name: /^推荐排序/ }).click();
            const oldOrder = await page.evaluate(people => {
              const name = person => person.actorProfile.displayName || person.name;
              return people.sort((a, b) => Number(Boolean(b.actorProfile.avatarUrl)) - Number(Boolean(a.actorProfile.avatarUrl))
                || b.workCount - a.workCount || b.sourceCount - a.sourceCount || name(a).localeCompare(name(b), "zh-Hans-CN"))
                .map(person => person.id);
            }, legacyPeople);
            assert.deepEqual(await ids(), oldOrder.slice(0, 64));
            assert.equal((await append()).comparisons, 0);
            assert.equal((await append()).comparisons, 0, "an old non-numeric count uses the complete original sort, not a heap");
            assert.deepEqual(await ids(), oldOrder.slice(0, 192));
            console.log("PASS historical non-numeric counts keep exact Chromium full-sort order");
          }
        }
      } finally { await page.close(); }
    }
    const actions = ["initial recommended", "filter all", "sort by name"];
    console.log(JSON.stringify({ baseline, rate, count, actions, samples,
      medians: actions.map((_name, index) => ({ ms: median(samples.map(sample => sample[index].ms)), visibleMs: median(samples.map(sample => sample[index].visibleMs)),
        comparisons: median(samples.map(sample => sample[index].comparisons)) })) }));
  }
} finally {
  await browser?.close(); service.kill("SIGTERM"); await Promise.race([exit, delay(3000)]);
}

function expected(filter, sort, visible) {
  const rows = people.filter(person => filter === "all" || !person.isWestern && person.actorProfile.gender !== "male" && person.actorProfile.avatarUrl);
  const name = person => person.actorProfile.displayName || person.name;
  const byName = (a, b) => name(a).localeCompare(name(b), "zh-Hans-CN");
  const byVisual = (a, b) => Number(Boolean(b.actorProfile.avatarUrl)) - Number(Boolean(a.actorProfile.avatarUrl));
  rows.sort((a, b) => sort === "name" ? byName(a, b) || b.workCount - a.workCount || byVisual(a, b)
    : byVisual(a, b) || b.workCount - a.workCount || b.sourceCount - a.sourceCount || byName(a, b));
  return rows.slice(0, visible).map(row => row.id);
}
