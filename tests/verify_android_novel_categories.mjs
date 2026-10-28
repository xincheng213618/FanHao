import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { createNavigationFixtureDocument } from "./fixtures/android-gallery-navigation-harness.mjs";

// Execute the real complete module factory and category/sort/search controls.
// Novel catalogue data, DOM geometry, animation frames and host navigation are
// boundaries. Browser verification separately checks the actual CSS width cap.
// No browser, service, database, storage or real books are accessed here.
const source = fs.readFileSync(new URL("../android-client/www/modules/novels/android-module.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");
const plain = value => JSON.parse(JSON.stringify(value));
const categories = Array.from({ length: 7 }, (_, index) => ({ name: `分类${index + 1}`, label: `分类${index + 1}` }));
let cases = 0;

function fixture({ category = "all", width = 200, connected = true, widths = new Map(), code = source, resizeObserver = true } = {}) {
  const document = createNavigationFixtureDocument(), frames = new Map(), allFrames = new Map(), listeners = new Map(), observers = [];
  let frameId = 0;
  const state = { category, categories: categories.map(item => ({ ...item })), sort: "updated" };
  const calls = { renders: 0, scrollTop: 0, pageReveal: 0, routes: [], sheets: [], horizontal: [] };
  const geometry = { width, widths, left: 137, border: 2, gap: 8 };
  const widthOf = node => geometry.widths.get(node.textContent) ?? 56;
  const contentWidth = nav => nav.children.reduce((sum, node) => sum + widthOf(node), 0) + Math.max(0, nav.children.length - 1) * geometry.gap;
  const originalCreate = document.createElement;
  document.createElement = tag => {
    const node = originalCreate(tag); node._scrollLeft = 0;
    Object.defineProperty(node, "isConnected", { get: () => document.body.contains(node) });
    Object.defineProperty(node, "clientWidth", { get: () => geometry.width });
    Object.defineProperty(node, "clientLeft", { get: () => geometry.border });
    Object.defineProperty(node, "scrollLeft", {
      get: () => node._scrollLeft,
      set(value) { const next = Math.max(0, Math.min(Number(value), Math.max(0, contentWidth(node) - geometry.width)));
        calls.horizontal.push({ node, before: node._scrollLeft, after: next }); node._scrollLeft = next; }
    });
    node.getBoundingClientRect = () => {
      const nav = node.parentNode;
      if (node.classList.contains("novel-chrome-tabs")) {
        return { left: geometry.left, right: geometry.left + geometry.width + 2 * geometry.border, top: 84, bottom: 128 };
      }
      if (nav?.classList.contains("novel-chrome-tabs")) {
        const position = nav.children.indexOf(node);
        const offset = nav.children.slice(0, position).reduce((sum, sibling) => sum + widthOf(sibling) + geometry.gap, 0);
        const left = geometry.left + geometry.border + offset - nav.scrollLeft;
        return { left, right: left + widthOf(node), width: widthOf(node), top: 84, bottom: 128 };
      }
      return { left: 0, right: 0, top: 0, bottom: 0 };
    };
    node.scrollIntoView = () => { calls.pageReveal++; window.scrollY += 400; };
    return node;
  };
  const container = document.createElement("header");
  if (connected) document.body.append(container);
  const window = { scrollY: 640,
    addEventListener(type, callback) { const entries = listeners.get(type) || []; entries.push(callback); listeners.set(type, entries); },
    removeEventListener(type, callback) { listeners.set(type, (listeners.get(type) || []).filter(entry => entry !== callback)); },
    dispatchEvent(event) { for (const callback of [...listeners.get(event.type) || []]) callback(event); },
    requestAnimationFrame(callback) { const id = ++frameId; frames.set(id, callback); allFrames.set(id, callback); return id; },
    cancelAnimationFrame(id) { frames.delete(id); },
    scrollTo() { throw new Error("Category reveal must never scroll the page"); }
  };
  if (resizeObserver) window.ResizeObserver = class {
    constructor(callback) { this.callback = callback; this.targets = []; this.disconnected = false; observers.push(this); }
    observe(target) { this.targets.push(target); }
    disconnect() { this.disconnected = true; }
  };
  let module;
  const render = () => { container.replaceChildren(); return module.renderChrome({ container, view: "novels" }); };
  const novelViews = {
    getNovelNavigationState: () => state,
    getNovelSortOptions: () => [{ value: "updated", label: "最近更新" }, { value: "title", label: "书名排序" }],
    setNovelCategory(value) { if (state.category === value) return false; state.category = value; return true; },
    setNovelSort(value) { if (state.sort === value) return false; state.sort = value; return true; }
  };
  const host = { els: {}, getActiveUrl: () => "http://novel-categories.fixture.invalid",
    navigation: { showView: (...args) => calls.routes.push(plain(args)), goBack() {}, hasBackStack: () => true },
    ui: { setActiveBottom() {}, setStatus() {}, renderCurrentView() { calls.renders++; render(); },
      renderCurrentViewPreservingScroll() {}, scrollToTop() { calls.scrollTop++; window.scrollY = 0; }, refreshChrome: render } };
  const context = vm.createContext({ document, window, createNovelViews: () => novelViews,
    openMobileActionSheet: config => calls.sheets.push(config) });
  const create = vm.runInContext(`(function(){${code.replace(/^import[^\n]*\n/gm, "").replace(/^export /gm, "")}\nreturn createAndroidModule;})()`, context);
  module = create({ host }); render();
  return { document, window, state, calls, geometry, container, module, render, frames, allFrames, observers, listeners,
    nav: () => container.querySelector(".novel-chrome-tabs"),
    selected: () => container.querySelector('[aria-pressed="true"]'),
    flush() { const pending = [...frames]; frames.clear(); for (const [, callback] of pending) callback(); },
    resize(nextWidth, reportedWidth = nextWidth) {
      geometry.width = nextWidth;
      const nav = this.nav();
      // Native layout clamps scrollLeft when its viewport grows. This is only
      // the browser's scroll-range boundary, not category-reveal behavior.
      if (nav) nav._scrollLeft = Math.max(0, Math.min(nav._scrollLeft, Math.max(0, contentWidth(nav) - nextWidth)));
      if (resizeObserver) {
        for (const observer of observers.filter(item => !item.disconnected && item.targets.includes(nav))) {
          observer.callback([{ target: nav, contentRect: { width: reportedWidth } }]);
        }
      } else window.dispatchEvent({ type: "resize" });
    },
    visible() { const nav = this.nav(), selected = this.selected();
      const left = nav.getBoundingClientRect().left + nav.clientLeft, right = left + nav.clientWidth;
      const bounds = selected.getBoundingClientRect(); return bounds.left >= left && bounds.right <= right; }
  };
}

function check(name, run) {
  try { run(); cases++; }
  catch (error) { throw new Error(`${name}: ${error.message}`, { cause: error }); }
}

function assertTailVisible(code = source) {
  const f = fixture({ category: "分类7", code }); const nav = f.nav();
  assert.equal(nav.scrollLeft, 0, "reveal waits for its attached layout frame");
  f.flush(); assert(f.visible(), "current tail category must be visible after chrome redraw");
  assert.equal(nav.scrollLeft, 304, "only the right-side overflow is scrolled");
  assert.equal(f.calls.horizontal.length, 1); assert.equal(f.window.scrollY, 640);
  assert.equal(f.calls.pageReveal, 0); assert.equal(f.calls.scrollTop, 0);
}

check("current last category is revealed with the minimum local horizontal scroll", () => assertTailVisible());
check("clicking a tail category reveals it again after the real module rebuilds chrome", () => {
  const f = fixture(); f.flush();
  const tail = f.nav().children.at(-1); tail.click();
  assert.equal(f.calls.renders, 1); assert.equal(f.calls.scrollTop, 1, "existing category navigation still scrolls to top once");
  assert.equal(f.selected().textContent, "分类7"); assert.equal(f.nav().scrollLeft, 0);
  f.flush(); assert(f.visible()); assert.equal(f.window.scrollY, 0); assert.equal(f.calls.scrollTop, 1); assert.equal(f.calls.pageReveal, 0);
});
check("a selected category absent from facets is appended and revealed", () => {
  const f = fixture({ category: "目录返回的未知分类" }); f.flush();
  assert.equal(f.selected().textContent, "目录返回的未知分类"); assert.equal(f.selected().getAttribute("aria-pressed"), "true");
  assert(f.visible()); assert.equal(f.window.scrollY, 640);
});
check("a long label constrained to the nav width retains its full DOM name and becomes fully visible", () => {
  const label = "保留名称开头并省略末尾但完整分类名称仍供读屏使用的很长类别";
  const f = fixture({ category: label, width: 164, widths: new Map([[label, 164]]) });
  f.flush(); assert(f.visible()); assert.equal(f.selected().textContent, label);
  assert.equal(f.selected().getAttribute("aria-pressed"), "true"); assert.equal(f.window.scrollY, 640); assert.equal(f.calls.pageReveal, 0);
});
check("an ordinary already-visible category needs no horizontal movement", () => {
  for (const category of ["all", "分类1", "分类2"]) {
    const f = fixture({ category }); f.flush(); assert(f.visible()); assert.equal(f.calls.horizontal.length, 0); assert.equal(f.window.scrollY, 640);
  }
});
check("partially hidden categories scroll only their clipped edge", () => {
  const left = fixture(); left.nav()._scrollLeft = 17; left.flush();
  assert.equal(left.nav().scrollLeft, 0); assert.equal(left.calls.horizontal[0].before, 17);
  const right = fixture({ category: "分类1", width: 100 }); right.flush();
  assert.equal(right.nav().scrollLeft, 20); assert(right.visible());
});
check("a newly rebuilt chrome retires its detached frame", () => {
  const f = fixture({ category: "分类7" }), oldNav = f.nav(); f.state.category = "分类6"; f.render(); f.flush();
  assert.equal(oldNav.scrollLeft, 0); assert(f.visible()); assert.equal(f.calls.horizontal.length, 1);
});
check("detached and hidden zero-width chrome do not force a geometry scroll", () => {
  const detached = fixture({ category: "分类7", connected: false }); detached.flush(); assert.equal(detached.calls.horizontal.length, 0);
  detached.document.body.append(detached.container); detached.render(); detached.flush(); assert(detached.visible());
  const hidden = fixture({ category: "分类7", width: 0 }); hidden.flush(); assert.equal(hidden.calls.horizontal.length, 0);
});
check("sort and search controls preserve their existing actions", () => {
  const f = fixture(); f.flush();
  f.container.querySelector(".novel-chrome-sort").click(); assert.equal(f.calls.sheets.length, 1);
  const sheet = f.calls.sheets[0]; assert.equal(sheet.title, "小说排序"); assert.equal(sheet.value, "updated");
  assert.deepEqual(plain(sheet.options).map(option => option.label), ["最近更新", "书名排序"]);
  sheet.options[1].select(); assert.equal(f.state.sort, "title"); assert.equal(f.calls.renders, 1); assert.equal(f.calls.scrollTop, 1);
  f.container.querySelector(".module-chrome-search").click();
  assert.deepEqual(f.calls.routes, [["novelSearch", { query: "" }, { push: true }]]); assert.equal(f.calls.scrollTop, 2);
  f.flush(); assert.equal(f.calls.pageReveal, 0);
});
check("non-library routes do not add a category toolbar or schedule scrolling", () => {
  const f = fixture(); f.flush(); f.container.replaceChildren();
  assert.equal(f.module.renderChrome({ container: f.container, view: "novelSearch" }), false);
  f.flush(); assert.equal(f.container.children.length, 0); assert.equal(f.calls.horizontal.length, 0);
});
check("negative control: omitting local reveal reproduces the hidden selected tail", () => {
  const mutant = source.replace("if (delta) nav.scrollLeft += delta;", "/* previous redraw left the current category offscreen */");
  assert.notEqual(mutant, source); assert.throws(() => assertTailVisible(mutant), /current tail category must be visible/);
});
console.log(`Android novel category verification passed (${cases} scenarios, including 1 negative control; real module factory and controlled geometry, no browser/device).`);

// Keep the original eleven registrations above intact. These cases deliver
// actual observer/window callbacks to the real module's width watcher.
const widthTests = [];
const widthTest = (name, run) => widthTests.push({ name, run });
const currentObserver = f => f.observers.filter(observer => !observer.disconnected).at(-1);
const assertNoPageWork = f => {
  assert.equal(f.window.scrollY, 640); assert.equal(f.calls.pageReveal, 0);
  assert.equal(f.calls.scrollTop, 0); assert.equal(f.calls.renders, 0); assert.equal(f.calls.routes.length, 0);
};

widthTest("RO observes only its own nav and a real shrink reveals the current category by the minimum delta", code => {
  const f = fixture({ category: "分类7", code }), nav = f.nav();
  assert.equal(f.observers.length, 1); assert.equal(currentObserver(f).targets.length, 1);
  assert(currentObserver(f).targets[0] === nav); assert.equal((f.listeners.get("resize") || []).length, 0);
  f.flush(); assert.equal(nav.scrollLeft, 304);
  const writes = f.calls.horizontal.length;
  f.resize(80, 999); assert.equal(nav.scrollLeft, 304, "RO defers layout work to its own frame");
  assert.equal(f.frames.size, 1); f.flush();
  assert.equal(nav.scrollLeft, 424, "Only the 120px newly clipped edge is revealed using live clientWidth");
  assert.equal(f.calls.horizontal.length, writes + 1); assert(f.visible());
  assert.equal(f.observers.length, 1); assertNoPageWork(f);
});

widthTest("same-width RO deliveries leave the user's deliberate horizontal pan unchanged", code => {
  const f = fixture({ category: "分类7", code }), nav = f.nav(); f.flush();
  nav.scrollLeft = 0; const writes = f.calls.horizontal.length;
  f.resize(200, 901); f.flush(); f.resize(200, 73); f.flush();
  assert.equal(nav.scrollLeft, 0, "Unchanged width must not snap back to the selected category");
  assert.equal(f.calls.horizontal.length, writes); assertNoPageWork(f);
});

widthTest("hidden zero widths do not scroll and positive recovery reveals even at the previous width", code => {
  for (const initialWidth of [0, 200]) {
    const f = fixture({ category: "分类7", width: initialWidth, code }), nav = f.nav(); f.flush();
    const before = nav.scrollLeft, writes = f.calls.horizontal.length;
    f.resize(0); f.flush(); assert.equal(nav.scrollLeft, before); assert.equal(f.calls.horizontal.length, writes);
    nav._scrollLeft = 0; // A hidden browser layout may reset its scroll box.
    f.resize(200); f.flush();
    assert.equal(nav.scrollLeft, 304); assert(f.visible()); assertNoPageWork(f);
  }
});

widthTest("a burst of width deliveries uses one frame and the final live geometry", code => {
  const f = fixture({ category: "分类7", code }), nav = f.nav(); f.flush();
  const writes = f.calls.horizontal.length;
  f.resize(80); f.resize(120); f.resize(100);
  assert.equal(f.frames.size, 1); assert.equal(f.calls.horizontal.length, writes);
  f.flush(); assert.equal(nav.scrollLeft, 404); assert.equal(f.calls.horizontal.length, writes + 1);
  assert(f.visible()); assertNoPageWork(f);
});

widthTest("rebuilding retires its old RO and pending frame even if the old nav is reattached", code => {
  const f = fixture({ category: "分类7", code }), previous = f.nav(), observer = currentObserver(f);
  const oldFrame = [...f.frames.values()][0]; assert(oldFrame);
  f.state.category = "分类6"; f.render(); const next = f.nav();
  assert.equal(observer.disconnected, true); assert.equal(f.frames.size, 1);
  assert.equal(f.observers.filter(item => !item.disconnected).length, 1);
  f.container.append(previous); assert.equal(previous.isConnected, true);
  f.geometry.width = 80;
  observer.callback([{ target: previous }]); oldFrame();
  assert.equal(previous.scrollLeft, 0, "Connected retired nav must remain untouched");
  assert.equal(next.scrollLeft, 0); assert.equal(f.frames.size, 1, "Old callbacks cannot consume the new owner's frame");
  f.flush(); assert(f.visible()); assertNoPageWork(f);
});

widthTest("non-library rendering and module deactivation release RO and reject connected old callbacks", code => {
  for (const leave of ["non-library", "deactivate"]) {
    const f = fixture({ category: "分类7", code }), nav = f.nav(); f.flush();
    const observer = currentObserver(f); f.resize(80); const queued = [...f.frames.values()][0]; assert(queued);
    if (leave === "non-library") assert.equal(f.module.renderChrome({ container: f.container, view: "novelSearch" }), false);
    else f.module.deactivate();
    assert.equal(observer.disconnected, true); assert.equal(f.frames.size, 0); assert.equal(nav.isConnected, true);
    nav._scrollLeft = 0; observer.callback([{ target: nav }]); queued();
    assert.equal(nav.scrollLeft, 0); assert.equal(f.frames.size, 0);
    f.render(); assert.equal(f.observers.filter(item => !item.disconnected).length, 1); f.flush(); assert(f.visible());
    assertNoPageWork(f);
  }
});

widthTest("a connected nav moved outside its original container loses reveal authority", code => {
  const f = fixture({ category: "分类7", code }), nav = f.nav();
  const observer = currentObserver(f), queued = [...f.frames.values()][0]; assert(queued);
  const other = f.document.createElement("header"); f.document.body.append(other); other.append(nav);
  assert.equal(nav.isConnected, true); f.geometry.width = 80;
  observer.callback([{ target: nav }]); queued(); f.flush();
  assert.equal(nav.scrollLeft, 0, "Connection alone cannot authorize another container's nav");
  f.module.deactivate(); assert.equal(observer.disconnected, true); assertNoPageWork(f);
});

widthTest("no-RO fallback binds once, preserves same-width pan and retires every resize/frame callback", code => {
  const f = fixture({ category: "分类7", code, resizeObserver: false });
  assert.equal(f.observers.length, 0); assert.equal(f.listeners.get("resize").length, 1); f.flush();
  f.resize(80); f.flush(); assert.equal(f.nav().scrollLeft, 424); assert(f.visible());
  f.nav().scrollLeft = 0; const writes = f.calls.horizontal.length;
  f.resize(80); f.flush(); assert.equal(f.nav().scrollLeft, 0); assert.equal(f.calls.horizontal.length, writes);
  f.resize(0); f.flush(); f.resize(80); f.flush(); assert(f.visible());
  const previous = f.nav(), callback = f.listeners.get("resize")[0];
  f.resize(100); const queued = [...f.frames.values()][0]; assert(queued);
  f.render(); assert.equal(f.listeners.get("resize").length, 1); assert.equal(f.frames.size, 1);
  f.container.append(previous); previous._scrollLeft = 0;
  callback({ type: "resize" }); queued(); assert.equal(previous.scrollLeft, 0); assert.equal(f.frames.size, 1);
  f.flush(); assert(f.visible());
  const latest = f.listeners.get("resize")[0], nav = f.nav();
  f.resize(80); const pending = [...f.frames.values()][0]; assert(pending);
  f.module.deactivate(); assert.equal(f.listeners.get("resize").length, 0); assert.equal(f.frames.size, 0);
  nav._scrollLeft = 0; latest({ type: "resize" }); pending();
  assert.equal(nav.scrollLeft, 0); assert.equal(f.frames.size, 0);
  f.render(); assert.equal(f.listeners.get("resize").length, 1);
  assert.equal(f.module.renderChrome({ container: f.container, view: "novelDetail" }), false);
  assert.equal(f.listeners.get("resize").length, 0); assert.equal(f.frames.size, 0); assertNoPageWork(f);
});

function widthMutation(replace) {
  const changed = replace(source); assert.notEqual(changed, source, "Negative control must alter the actual watcher"); return changed;
}
const widthControls = [
  { name: "RO width delivery disconnected", scenario: 0, code: () => widthMutation(text => text.replace("new window.ResizeObserver(scheduleReveal)", "new window.ResizeObserver(() => {})")) },
  { name: "same-width guards removed", scenario: 1, code: () => widthMutation(text => text.replace("if (width === lastWidth) return;", "/* missing revealed-width guard */").replace("if (width === lastWidth || frame) return;", "if (frame) return;")) },
  { name: "retired watcher active guard removed", scenario: 5, code: () => widthMutation(text => text.replace("active && nav.isConnected", "nav.isConnected")) },
  { name: "RO disconnect removed", scenario: 4, code: () => widthMutation(text => text.replace("observer?.disconnect();", "void observer;")) }
];
for (const { name, run } of widthTests) { run(source); console.log(`novel-category-width: ${name}: ok`); }
for (const { name, scenario, code } of widthControls) {
  assert.throws(() => widthTests[scenario].run(code()), { name: "AssertionError" }, `Width negative must fail: ${name}`);
  console.log(`REPRODUCED novel category width regression: ${name}`);
}
console.log(`Android novel width lifecycle verification passed (${widthTests.length} scenarios and ${widthControls.length} negative controls; real module factory, no browser/device).`);
