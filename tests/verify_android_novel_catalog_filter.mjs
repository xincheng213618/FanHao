import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { createReaderHarness, localEntry, settle } from "./fixtures/android-novel-reader-harness.mjs";

// Complete immutable owner, before this optimization. The existing reader
// harness supplies controlled DOM/storage/API boundaries, not native IndexedDB
// or layout evidence; the parent novel UI suite owns those browser contracts.
const ROOT = new URL("../", import.meta.url);
const OWNER = "android-client/www/modules/novels/novel-views.js";
const BEFORE = "63c5fab243233e142cfd62c4eaf13812feb92405";
const BEFORE_SHA256 = "9356d0922883f88b649420b7304648344c60f8c06de13d60d2882537cdda1cc1";
const oldSource = execFileSync("git", ["show", `${BEFORE}:${OWNER}`], { cwd: ROOT, encoding: "utf8" }).replace(/\r\n/g, "\n");
assert.equal(createHash("sha256").update(oldSource).digest("hex"), BEFORE_SHA256);
let currentSource = readFileSync(new URL(OWNER, ROOT), "utf8").replace(/\r\n/g, "\n");
const adapterSource = readFileSync(new URL("android-client/www/modules/novels/android-module.js", ROOT), "utf8");
const legacy = process.argv.includes("--legacy-filter");
if (legacy) {
  const marker = "    function refresh() {\n      order.textContent";
  assert.equal(currentSource.split(marker).length, 2, "narrow filter control must find one catalog refresh");
  currentSource = currentSource.replace(marker, "    function refresh() {\n      preparedLocal = null;\n      order.textContent");
}

const filterExpression = 'source.filter((chapter) => String(chapter.title || "").toLocaleLowerCase("zh-Hans-CN").includes(query) || String(chapter.index || "").includes(query))';
function instrument(source) {
  assert.equal(source.split(filterExpression).length, 2, "measure the actual owner predicate, never a copied filter");
  source = source.replace(filterExpression, 'source.filter((chapter) => (window.__catalogMetrics.sourceRows += 1, String(chapter.title || "").toLocaleLowerCase("zh-Hans-CN").includes(query) || String(chapter.index || "").includes(query)))');
  const marker = "  installReaderProgress();";
  assert.equal(source.split(marker).length, 2);
  source = source.replace(marker, `  window.__catalogProbe = { createCatalogBrowser, catalogState, readerState, detailState,
    update: (shell, rows, state = {}) => catalogBrowserUpdates.get(shell)(rows, state) };
${marker}`);
  // Instrument the VM realm's real String conversion; chapter objects remain
  // ordinary metadata DTOs, without getter/Proxy behavior affecting the plan.
  return `window.__catalogMetrics = { sourceRows: 0, locale: 0, titleLocale: 0 };
const __catalogLower = String.prototype.toLocaleLowerCase;
String.prototype.toLocaleLowerCase = function(...args) {
  window.__catalogMetrics.locale += 1;
  if (String(this).startsWith("Catalog chapter ")) window.__catalogMetrics.titleLocale += 1;
  return __catalogLower.apply(this, args);
};
${source}\nwindow.__catalogFactory = createNovelViews;`;
}

function create(source) {
  const h = createReaderHarness(instrument(source));
  // Mount through the real module adapter, using the complete real factory
  // exposed only in this test evaluation. No product exports or routes change.
  const createModule = new Function("createNovelViews", "window", "openMobileActionSheet",
    adapterSource.replace(/^import .*;\r?\n/gm, "").replace("export function createAndroidModule", "function createAndroidModule") + "\nreturn createAndroidModule;")(
      h.window.__catalogFactory, h.window, async () => null);
  const host = {
    els: h.els, getActiveUrl: () => h.window.__sourceUrl || "http://synthetic.invalid",
    navigation: { showView: (...args) => h.navigations.push(args), goBack() {}, hasBackStack: () => false },
    ui: { setActiveBottom() {}, renderCurrentView() {}, renderCurrentViewPreservingScroll() {}, setStatus() {}, refreshChrome() {}, scrollToTop() {} }
  };
  h.module = createModule({ host });
  h.probe = h.window.__catalogProbe;
  const createElement = h.document.createElement;
  h.dom = { elements: 0, options: 0 };
  h.document.createElement = (tag) => {
    h.dom.elements += 1;
    if (tag === "option") h.dom.options += 1;
    return createElement(tag);
  };
  return h;
}

function plain(value) { return JSON.parse(JSON.stringify(value)); }
function tree(node) {
  return { tag: node.tagName, class: node.className, text: node._textContent,
    attributes: [...node.attributes].sort(), value: node.value,
    disabled: Boolean(node.disabled), selected: Boolean(node.selected),
    children: node.children.map(tree) };
}
function controls(h) {
  const shell = h.shell;
  const pagination = shell.querySelector(".novel-mobile-catalog-pagination");
  return { search: shell.querySelector("input"), order: shell.querySelector(".novel-mobile-catalog-order"),
    previous: pagination.children[0], range: pagination.children[1], next: pagination.children[2],
    list: shell.querySelector(".novel-mobile-catalog-list") };
}
function mount(h, rows, { book = { id: "local:catalog", local: true, title: "Synthetic catalog", progress: { chapterIndex: 1 } }, ...options } = {}) {
  h.meta = h.document.createElement("span");
  h.loads = [];
  h.rows = rows;
  h.book = book;
  h.shell?.remove();
  h.shell = h.probe.createCatalogBrowser(book, rows, { meta: h.meta,
    loadPage: async (request) => { h.loads.push(plain(request)); }, ...options });
  h.els.viewContent.append(h.meta, h.shell);
}
function input(h, query) { const c = controls(h); c.search.value = query; c.search.dispatchEvent(h.event("input")); }
function page(h, value) { const c = controls(h); c.range.value = String(value); c.range.dispatchEvent(h.event("change")); }
function update(h, rows = h.rows, state = {}) { h.rows = rows; h.probe.update(h.shell, rows, state); }
function visible(h) { return controls(h).list.querySelectorAll(".novel-mobile-chapter").map((button) => button.querySelector("strong").textContent); }
function snapshot(h) {
  return { shell: tree(h.shell), meta: tree(h.meta), state: plain(h.probe.catalogState),
    loads: plain(h.loads), navigations: plain(h.navigations) };
}
function expectedLocal(h) {
  const state = h.probe.catalogState;
  const query = String(state.query || "").trim().toLocaleLowerCase("zh-Hans-CN");
  const rows = h.rows.filter((row) => !query || String(row.title || "").toLocaleLowerCase("zh-Hans-CN").includes(query) || String(row.index || "").includes(query));
  if (state.descending) rows.reverse();
  assert.deepEqual(visible(h), rows.slice(state.page * 80, state.page * 80 + 80).map((row) => row.title || `第 ${row.index || ""} 章`.trim()), "visible order follows source order and legacy substring semantics");
}

let comparisons = 0;
function pair() { return [create(oldSource), create(currentSource)]; }
function compare(both, label, local = true) {
  assert.deepEqual(snapshot(both[1]), snapshot(both[0]), label);
  if (local) for (const h of both) expectedLocal(h);
  comparisons += 1;
}
function chapterRows(count) {
  return Array.from({ length: count }, (_, offset) => ({ id: `chapter:${offset}`, index: offset + 1,
    title: `Catalog chapter ${offset + 1}`, charCount: offset * 3 }));
}

async function contracts() {
  const both = pair();
  for (const h of both) {
    const rows = chapterRows(245);
    [rows[0], rows[92]] = [rows[92], rows[0]];
    rows[1].index = 1009;
    rows[2].title = "序章 Ω İ ＡＢＣ 🙂";
    rows[3].title = "双  空白";
    rows[4].title = "双 空白";
    rows[5].title = "";
    mount(h, rows);
  }
  compare(both, "initial raw order / noncontinuous indices");
  for (const query of ["Catalog", "  CATALOG  ", "9", "Ω", "İ", "🙂", "ＡＢＣ", "双  空白", "双 空白", "   ", "no matching chapter"]) {
    for (const h of both) input(h, query);
    compare(both, `query ${JSON.stringify(query)}`);
  }
  for (const h of both) input(h, "chapter");
  for (const requested of [1, 999, -5]) {
    for (const h of both) page(h, requested);
    compare(both, `page clamp ${requested}`);
  }
  for (const h of both) controls(h).order.click();
  compare(both, "descending preserves reversed source order");
  for (const h of both) page(h, 2);
  compare(both, "descending next range");
  for (const h of both) {
    h.rows[1].title = "Catalog chapter changed";
    h.rows.splice(4, 31);
    h.rows.reverse();
    update(h);
  }
  compare(both, "same-array title/splice/reverse update invalidates");
  for (const h of both) update(h, [{ id: "replacement", index: 713, title: "Catalog chapter replacement", charCount: 7 }]);
  compare(both, "source replacement and page clamp");
  for (const h of both) {
    h.probe.readerState.chapter = { index: 713 };
    page(h, 0);
    assert(controls(h).list.children[0].classList.contains("active"));
    h.probe.readerState.chapter = { index: 999 };
    page(h, 0);
    assert(!controls(h).list.children[0].classList.contains("active"));
  }
  compare(both, "active reader chapter stays live on a cached result");
  for (const h of both) update(h, h.rows, { book: { ...h.book, progress: { chapterIndex: 713 } } });
  compare(both, "fresh progress book on callback");
  for (const h of both) {
    controls(h).list.children[0].click();
    assert.equal(h.navigations.at(-1)[0], "novelReader");
    assert.equal(h.navigations.at(-1)[1].chapterIndex, "713");
    assert.equal(h.navigations.at(-1)[1].confirmProgress, "1");
  }
  compare(both, "chapter route receives current row");
  for (const h of both) {
    h.probe.catalogState.total = 1200;
    h.probe.catalogState.filteredTotal = 400;
    h.probe.catalogState.offset = 80;
    update(h, [{ id: "remote", index: 901, title: "remote page ignores local filter", charCount: 5 }], { serverPaged: true });
  }
  compare(both, "local to remote keeps server-selected rows", false);
  for (const h of both) { controls(h).next.click(); controls(h).order.click(); input(h, "remote query"); h.runTimers(260); }
  compare(both, "remote navigation delegates page/query/order", false);
  assert.equal(both[1].loads.length, 3);
  for (const state of [{ serverPaged: true, loading: true }, { serverPaged: true, error: "Synthetic read failed" }, { serverPaged: true }]) {
    for (const h of both) update(h, h.rows, state);
    compare(both, `remote ${JSON.stringify(state)}`, false);
  }
  for (const h of both) { update(h, chapterRows(161)); input(h, "chapter"); }
  compare(both, "remote to local invalidates prepared rows");
  for (const h of both) mount(h, [{ id: "other", index: 99, title: "Other book" }], { book: { id: "local:other", local: true } });
  compare(both, "different book resets query/order/page");
}

async function adapterContracts() {
  const both = pair();
  let savedControls;
  for (const h of both) {
    const entry = localEntry("local:a");
    entry.chapters = chapterRows(161);
    entry.book.chapterCount = 161;
    h.books.set(entry.book.id, entry);
    const route = h.module.routes.find((item) => item.view === "novelDetail");
    await route.render({ id: entry.book.id }, () => true);
    await settle();
    h.shell = h.els.viewContent.querySelector(".novel-mobile-catalog-browser");
    assert(h.shell, "actual module detail route mounts the catalog");
    assert(h.storageCalls.some((call) => call.kind === "catalog"), "metadata-only catalog storage boundary used");
    h.meta = h.shell.parentNode.children[0].children[1];
    h.loads = [];
    h.rows = entry.chapters;
    page(h, 1);
  }
  compare(both, "actual adapter local detail route and paging");
  savedControls = both.map((h) => controls(h));
  for (const h of both) h.leave();
  for (let i = 0; i < both.length; i += 1) {
    const h = both[i], old = savedControls[i];
    const before = plain(h.probe.catalogState);
    old.order.click(); old.next.click(); old.search.value = "stale"; old.search.dispatchEvent(h.event("input")); old.list.children[0].click();
    assert.deepEqual(plain(h.probe.catalogState), before, "detached owner controls cannot mutate the catalog");
    assert.equal(h.navigations.length, 0);
  }
  comparisons += 1;
}

function resetMetrics(h) { Object.assign(h.window.__catalogMetrics, { sourceRows: 0, locale: 0, titleLocale: 0 }); Object.assign(h.dom, { elements: 0, options: 0 }); }
function scale() {
  const both = pair();
  for (const h of both) { mount(h, chapterRows(10_000)); input(h, "chapter"); resetMetrics(h); }
  const timings = [];
  const signatures = [];
  for (const h of both) {
    const pages = [];
    const start = performance.now();
    for (let index = 1; index <= 20; index += 1) {
      controls(h).next.click();
      pages.push({ titles: visible(h), page: h.probe.catalogState.page, status: h.shell.querySelector(".novel-mobile-catalog-status").textContent,
        options: controls(h).range.children.map((node) => [node.value, node.textContent, node.selected]) });
    }
    timings.push(performance.now() - start);
    signatures.push(pages);
  }
  assert.deepEqual(signatures[1], signatures[0], "all 20 warm page contents, options and state match immutable owner");
  comparisons += 20;
  const before = { ...both[0].window.__catalogMetrics, ...both[0].dom };
  const after = { ...both[1].window.__catalogMetrics, ...both[1].dom };
  assert.equal(before.sourceRows, 200_000);
  assert.equal(before.titleLocale, 200_000);
  assert.equal(before.locale, 200_020);
  assert.equal(after.sourceRows, 0, "warm pagination must not re-filter 10k metadata rows");
  assert.equal(after.titleLocale, 0, "warm pagination must not lower-case chapter titles again");
  assert.equal(after.locale, 20, "query normalization remains live each refresh");
  assert.deepEqual({ elements: after.elements, options: after.options }, { elements: before.elements, options: before.options }, "this change retains page DOM work");
  assert.equal(after.options, 2500);
  // Includes counters and visible-result collection in the controlled VM;
  // this diagnostic does not measure native interaction latency.
  console.log(JSON.stringify({ chapters: 10_000, warmPages: 20, before, after,
    instrumentedDiagnosticMs: { before: +timings[0].toFixed(2), after: +timings[1].toFixed(2) } }));
}

await contracts();
await adapterContracts();
console.log(`Catalog semantic contracts passed before work budget (${comparisons} full visible/state/route comparisons).`);
scale();
console.log(`Android novel catalog filter verified: ${comparisons} comparisons; controlled actual owner/adapter, no native layout or storage claim.`);
