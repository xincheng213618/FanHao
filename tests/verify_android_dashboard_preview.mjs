import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

// Actual Android entry on private loopback. Only the API data and metrics are synthetic.
const project = fileURLToPath(new URL("../", import.meta.url));
const www = path.join(project, "android-client/www");
const previousApp = execFileSync("git", ["show", "f110040d02b1eb579461248da9960e97370fa4d2:android-client/www/app.js"], { cwd: project, encoding: "utf8" });
const executablePath = [process.env.CHROME_PATH, "C:/Program Files/Google/Chrome/Application/chrome.exe", "C:/Program Files/Microsoft/Edge/Application/msedge.exe"].filter(Boolean).find(fs.existsSync);
assert(executablePath, "installed private Chromium required");
const errors = [];
const server = createServer((request, response) => {
  try {
    const url = new URL(request.url, "http://fixture");
    if (url.pathname === "/favicon.ico") { response.writeHead(204); response.end(); return; }
    const filename = path.resolve(www, `.${url.pathname === "/" ? "/index.html" : url.pathname}`);
    assert(filename.startsWith(`${www}${path.sep}`));
    let source = fs.readFileSync(filename);
    if (url.pathname === "/app.js") {
      source = url.searchParams.get("v") === "fixture-previous" ? previousApp : source.toString("utf8");
      const marker = "function renderDashboard(data) {";
      assert.equal(source.split(marker).length, 2);
      source = source.replace(marker, `${marker}
  const start = performance.now();
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
      source = source.replace(startup, `window.__dashboardProbe = { showView, loadDashboard };\n${startup}`);
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
let browser;

async function fixture(previous, refresh = false) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true });
  await context.addInitScript(() => {
    localStorage.setItem("fanhao.serverUrl", location.origin);
    window.__previewComparisons = 0;
    window.__dashboardTimes = [];
    window.__homeTimes = [];
  });
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
  await page.route("**/fixture-avatar/**", route => route.fulfill({ contentType: "image/svg+xml", body: '<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"><rect width="4" height="4" fill="red"/></svg>' }));
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
  }
  assert.deepEqual(errors, []);
} finally {
  await browser?.close();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
