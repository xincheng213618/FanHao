import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { appFunction, createGalleryHarness } from "./fixtures/android-gallery-navigation-harness.mjs";

// No network, database or device. Full production module adapters/registry and
// actual shell showView, search, submit binding and native-back functions run.
// Rendering, DOM focus/default form submission, history and scheduling are
// named boundaries; the separate fresh-browser evidence checks real DOM events.
const read = name => fs.readFileSync(new URL(`../${name}`, import.meta.url), "utf8");
const sources = {
  app: read("android-client/www/app.js"),
  navigation: read("android-client/www/js/module-navigation.js"),
  registry: read("android-client/www/js/android-module-registry.js"),
  media: read("android-client/www/modules/media/android-module.js"),
  photos: read("android-client/www/modules/photos/android-module.js"),
  fanhao: read("android-client/www/modules/fanhao/android-module.js"),
  chrome: read("android-client/www/modules/fanhao/chrome.js"),
  index: read("android-client/www/index.html")
};
const plain = value => JSON.parse(JSON.stringify(value));
const tests = [];
const test = (name, run) => tests.push({ name, run });

// Frozen pre-fix production function, not a fabricated alternate algorithm.
const OLD_RUN_SEARCH = `function runSearch(query) {
  window.clearTimeout(searchPrepareTimer);
  const controller = activeSearchController();
  if (!controller?.submit) return;
  controller.submit(String(query || "").trim(), searchContext());
  searchSurfaceExpanded = false;
  syncSearchSurface();
}`;

function evaluateModule(source, context) {
  return vm.runInContext(`(function(){${source.replace(/^import .*;\r?\n/gm, "").replace(/^export /gm, "")}\nreturn createAndroidModule;})()`, context);
}

function harness(input = sources) {
  const h = createGalleryHarness(input), c = h.context, d = h.document;
  const make = name => c.els[name] = d.createElement(name === "searchInput" ? "input" : name === "searchForm" ? "form" : "button");
  for (const name of ["searchForm", "searchInput", "searchCloseButton", "searchSubmitButton", "searchHistory", "moduleChrome", "viewBack"]) make(name);
  c.els.appConfirmOverlay = { hidden: true };
  c.els.searchInput.value = "";
  d.activeElement = d.body;
  c.els.searchInput.focus = () => {
    if (d.activeElement === c.els.searchInput) return;
    d.activeElement = c.els.searchInput;
    h.fire(c.els.searchInput, "focus", { bubbles: false });
  };
  c.els.searchInput.blur = () => { if (d.activeElement === c.els.searchInput) d.activeElement = d.body; };
  c.els.searchInput.select = () => {};
  Object.assign(c, {
    searchPrepareTimer: 0, renderedSearchController: null,
    requestAnimationFrame: callback => callback(),
    syncModuleChrome: () => false,
    mediaViewer: { close: () => false },
    HISTORY_MARKER: "fixture-search-back",
    settleAppConfirmation: () => { c.els.appConfirmOverlay.hidden = true; },
    closeSettings: () => { c.els.settingsOverlay.hidden = true; },
    searchHistory: { run: () => assert.fail("These real controllers must not route submission through history") }
  });
  c.window.history = { length: 1, state: null, back: () => assert.fail("Unexpected browser back instead of app search handling") };
  const realFunctions = ["syncSearchSurface", "activeSearchController", "searchContext", "runSearch", "focusSearchInput", "openSearchSurface", "closeSearchSurface",
    "updateModuleChannelSearch", "updateCurrentChannelQuery", "goBack", "returnToStackView", "isRootNavigationView", "applyBackState"];
  vm.runInContext(realFunctions.map(name => appFunction(input.app, name)).join("\n"), c);
  // The harness host delegates directly to the actual extracted implementation.
  // Source guards below ensure production host delegation has the same wiring.
  h.host.contentIndex.updateSearch = (...args) => c.updateModuleChannelSearch(...args);
  h.host.contentIndex.updatePhotoSearch = (params, query) => c.updateModuleChannelSearch(params, query, { photo: true });
  h.host.contentIndex.updateChannelQuery = query => c.updateCurrentChannelQuery(query);
  h.host.ui.openSearch = () => c.openSearchSurface();
  const renders = [];
  const renderBoundary = name => (...args) => { renders.push({ name, args }); };
  c.createChannelViews = () => Object.fromEntries(["renderChannel", "renderPhotoDetail", "renderMangaDetail", "renderMangaChapter", "renderMediaDetail", "deactivate"].map(name => [name, renderBoundary(name)]));
  // Full fanhao adapter construction uses these unrelated content renderers.
  const contentViews = () => new Proxy({}, { get: (_value, name) => name === "handleBack" ? () => false : renderBoundary(String(name)) });
  for (const name of ["createWorkViews", "createPeopleViews", "createDetailViews", "createCodePrefixViews"]) c[name] = contentViews;
  const roots = input.chrome.match(/^export const FANHAO_ROOT_VIEWS = .*;$/m);
  assert(roots, "Real fanhao root-view declaration exists");
  vm.runInContext(roots[0].replace(/^export /, ""), c);
  const definitions = c.registryApi.androidModuleFallbackCatalog();
  const media = c.androidModuleRegistry.get("media");
  const photos = c.registryApi.normalizeModule(evaluateModule(input.photos, c)({ host: h.host }), definitions.find(item => item.id === "photos"));
  const fanhao = c.registryApi.normalizeModule(evaluateModule(input.fanhao, c)({ host: h.host }), definitions.find(item => item.id === "fanhao"));
  c.androidModuleRegistry = c.registryApi.createRegistry([fanhao, photos, media]);
  const render = c.renderCurrentView;
  c.renderCurrentView = (...args) => { c.syncSearchSurface(); return render(...args); };
  const start = input.app.indexOf("window.fanhaoHandleNativeBack = () => {");
  const end = input.app.indexOf("\n};", start);
  assert(start >= 0 && end > start, "Actual native-back callback exists");
  vm.runInContext(input.app.slice(start, end + 3), c);
  const submitStart = input.app.indexOf('els.searchForm.addEventListener("submit",');
  const submitEnd = input.app.indexOf("\nels.serverUrl.addEventListener", submitStart);
  assert(submitStart >= 0 && submitEnd > submitStart, "Actual submit/focus/input bindings exist");
  vm.runInContext(input.app.slice(submitStart, submitEnd), c);
  const closeBinding = input.app.match(/^els\.searchCloseButton\?\.addEventListener\("click", closeSearchSurface\);/m);
  assert(closeBinding, "Close button is wired to actual closeSearchSurface");
  vm.runInContext(closeBinding[0], c);
  return {
    ...h, renders,
    enter(mode, params = {}) { c.showView("channel", { mode, ...params }, { resetStack: true }); },
    submit(query, transport = "keyboard") {
      c.openSearchSurface(); c.els.searchInput.value = query;
      h.fire(c.els.searchInput, "input");
      if (transport === "button") d.activeElement = c.els.searchSubmitButton;
      const event = h.fire(c.els.searchForm, "submit", { submitter: transport === "button" ? c.els.searchSubmitButton : null });
      assert.equal(event.defaultPrevented, true, "Actual submit handler prevents document navigation");
    },
    back() { return c.window.fanhaoHandleNativeBack(); },
    close() { d.activeElement = c.els.searchCloseButton; c.els.searchCloseButton.click(); },
    state() { return { ...plain(h.route()), rawExpanded: c.searchSurfaceExpanded, hidden: c.els.searchForm.hidden, input: c.els.searchInput.value }; }
  };
}

for (const mode of ["movie", "tv", "anime", "media"]) for (const transport of ["keyboard", "button"]) {
  test(`${mode} ${transport}: submitted visible search consumes native back`, input => {
    const h = harness(input); h.enter(mode); h.submit(" Alpha ", transport);
    assert.equal(h.state().params.query, "Alpha");
    assert.equal(h.state().hidden, false);
    assert.equal(h.back(), true, "Visible submitted search must consume Android back, not background the task");
    assert.equal(h.state().params.query || "", "");
    assert.equal(h.state().hidden, true);
    assert.equal(h.back(), false, "Once search is closed, a root catalog may release back to Android");
  });
}

for (const mode of ["movie", "tv", "anime"]) {
  test(`${mode}: unsubmitted focused draft is discarded on handled back and reopen`, input => {
    const h = harness(input); h.enter(mode); h.submit("Alpha");
    h.context.els.searchInput.value = "Beta";
    h.fire(h.context.els.searchInput, "input");
    assert.equal(h.state().params.query, "Alpha", "Draft edits do not commit a new query");
    assert.equal(h.back(), true);
    // Browser focus moves away when the search form becomes hidden.
    h.context.els.searchInput.blur(); h.context.openSearchSurface();
    assert.equal(h.state().input, "");
    assert.equal(h.state().params.query || "", "");
  });
  test(`${mode}: close button and empty submit leave no query when reopened`, input => {
    for (const action of ["close", "empty"]) {
      const h = harness(input); h.enter(mode); h.submit("Alpha");
      if (action === "close") h.close(); else h.submit("", "keyboard");
      assert.equal(h.state().hidden, true);
      assert.equal(h.state().params.query || "", "");
      h.context.els.searchInput.blur(); h.context.openSearchSurface();
      assert.equal(h.state().input, "");
    }
  });
  test(`${mode}: query-row clear uses the real shared search updater`, input => {
    const h = harness(input); h.enter(mode); h.submit("Alpha");
    h.document.activeElement = h.document.body;
    h.context.updateCurrentChannelQuery("");
    assert.equal(h.state().params.query || "", "");
    assert.equal(h.state().hidden, true); assert.equal(h.state().input, "");
  });
  test(`${mode}: detail back restores query then next back closes it`, input => {
    const h = harness(input); h.enter(mode); h.submit("Alpha");
    h.document.activeElement = h.document.body;
    h.observations.channelContext.showMediaDetail("synthetic-detail", mode);
    assert.equal(h.state().view, "mediaDetail"); assert.equal(h.state().hidden, true);
    assert.equal(h.back(), true); assert.equal(h.state().view, "channel");
    assert.equal(h.state().params.query, "Alpha"); assert.equal(h.state().input, "Alpha");
    assert.equal(h.back(), true); assert.equal(h.state().params.query || "", "");
  });
}

test("anime detail search stays in anime and preserves explicit relevance sorting", input => {
  const h = harness(input); h.context.showView("mediaDetail", { id: "synthetic-anime", mode: "anime" }, { resetStack: true });
  h.submit("动画", "button"); assert.equal(h.state().view, "channel"); assert.equal(h.state().params.mode, "anime");
  assert.equal(h.state().params.query, "动画"); assert.equal(h.state().params.sort, "relevance");
});

for (const mode of ["photo", "manga"]) {
  test(`${mode}: actual photo search controller retains its mode and closes query`, input => {
    const h = harness(input); h.enter(mode); h.submit("Alpha", "button");
    assert.equal(h.state().params.mode, mode); assert.equal(h.state().params.query, "Alpha");
    assert.equal(h.back(), true); assert.equal(h.state().params.query || "", "");
    assert.equal(h.state().hidden, true);
  });
}
test("photo: entering search clears collection/person and retains the established default category", input => {
  const h = harness(input); h.enter("photo", { collection: "old", category: "old", person: "old" }); h.submit("Alpha");
  assert.equal(h.state().params.photoView, "albums");
  for (const key of ["collection", "person"]) assert.equal(h.state().params[key] || "", "");
  assert.equal(h.state().params.category, h.context.DEFAULT_PHOTO_CATEGORY);
});
for (const scope of ["main", "western"]) test(`fanhao ${scope}: dedicated search stays dedicated and returns through its own controller`, input => {
  const h = harness(input), c = h.context;
  c.showView("people", { scope }, { resetStack: true }); h.submit("Alpha");
  assert.equal(h.state().view, "search");
  assert.equal(h.state().params.category, scope === "western" ? "western" : "censored");
  assert.equal(h.state().hidden, true, "Dedicated fanhao search must not reveal shared channel search form");
  assert.equal(h.back(), true); assert.equal(h.state().view, "people");
  assert.equal(h.state().params.scope, scope); assert.equal(h.state().hidden, true);
});
test("no search controller does not mutate an unrelated expanded state", input => {
  const h = harness(input); h.context.currentView = "tools"; h.context.searchSurfaceExpanded = true;
  h.context.runSearch("Alpha"); assert.equal(h.context.searchSurfaceExpanded, true);
});
test("production host delegates both search modes and Android consumes the actual callback result", input => {
  const host = appFunction(input.app, "createAndroidModuleHost");
  assert.match(host, /updateSearch: \(params, query\) => updateModuleChannelSearch\(params, query\)/);
  assert.match(host, /updatePhotoSearch: \(params, query\) => updateModuleChannelSearch\(params, query, \{ photo: true \}\)/);
  const native = read("android-client/android/app/src/main/java/local/fanhao/library/MainActivity.java");
  assert.match(native, /window\.fanhaoHandleNativeBack && window\.fanhaoHandleNativeBack\(\)/);
  assert.match(native, /if \(!"true"\.equals\(handled\)\)\s*\{\s*moveTaskToBack\(true\)/);
});

let passed = 0, failures = 0, rejected = 0;
for (const item of tests) {
  try { item.run(sources); passed++; console.log(`PASS ${item.name}`); }
  catch (error) { failures++; console.error(`FAIL ${item.name}\n${error.stack}`); }
}
if (!failures) {
  const old = { ...sources, app: sources.app.replace(appFunction(sources.app, "runSearch"), OLD_RUN_SEARCH) };
  assert.notEqual(old.app, sources.app, "Historical negative control must differ from production");
  for (const item of tests.filter(item => /^(movie|tv|anime|media) (keyboard|button):/.test(item.name))) {
    let failure;
    try { item.run(old); } catch (error) { failure = error; }
    try {
      assert(failure instanceof assert.AssertionError, `Historical control must fail a behavior assertion, not compile/runtime: ${item.name}: ${failure?.stack || "unexpected pass"}`);
      assert.match(failure.message, /Visible submitted search must consume Android back/);
      rejected++; console.log(`REJECT historical submit ordering: ${item.name}`);
    } catch (error) { failures++; console.error(`FAIL control ${item.name}\n${error.stack}`); }
  }
}
console.log(`Media search back: ${passed}/${tests.length} scenarios; ${rejected}/8 historical controls; ${failures} failures.`);
process.exitCode = failures ? 1 : 0;
