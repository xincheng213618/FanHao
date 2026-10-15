import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { appFunction, createGalleryHarness } from "./fixtures/android-gallery-navigation-harness.mjs";

// No browser/network/device/storage access. The complete production media
// adapter, registry and pure trail module run with real extracted shell routing,
// hash/last-view/back functions and the shared renderer's actual return button.
// DOM, history, scroll scheduling and content rendering are observable doubles.
const read = name => fs.readFileSync(new URL(`../${name}`, import.meta.url), "utf8");
const sources = {
  app: read("android-client/www/app.js"), navigation: read("android-client/www/js/module-navigation.js"),
  registry: read("android-client/www/js/android-module-registry.js"), media: read("android-client/www/modules/media/android-module.js"),
  index: read("android-client/www/index.html"), helper: read("android-client/www/js/media-navigation-state.js"),
  channel: read("android-client/www/platform/content-index/channel-views.js")
};
const plain = value => JSON.parse(JSON.stringify(value));
const tests = [];
const test = (name, run) => tests.push({ name, run });

function harness(input = sources, { storage = new Map(), hash = "" } = {}) {
  const h = createGalleryHarness(input, { storage }), c = h.context;
  Object.assign(c, vm.runInContext(`(function(){${input.helper.replace(/^export /gm, "")}\nreturn {normalizeMediaTrail,captureMediaTrail,mediaBackTarget};})()`, c));
  let scroll = 0;
  h.observations.restores = []; h.observations.browserBacks = 0; h.observations.searchCloses = 0;
  Object.assign(c, {
    HISTORY_MARKER: "fixture.media-history", mediaViewer: { close: () => false },
    currentScrollY: () => scroll,
    queueScrollRestore: value => h.observations.restores.push(value),
    settleAppConfirmation: () => { c.els.appConfirmOverlay.hidden = true; },
    closeSettings: () => { c.els.settingsOverlay.hidden = true; },
    closeSearchSurface: () => { c.searchSurfaceExpanded = false; h.observations.searchCloses++; }
  });
  c.window.location = { hash };
  c.window.history = {
    state: null, length: 1,
    replaceState(value, title, url) { this.state = plain(value); c.window.location.hash = url; },
    pushState(value, title, url) { this.length++; this.replaceState(value, title, url); },
    back() { h.observations.browserBacks++; }
  };
  c.els.appConfirmOverlay = { hidden: true }; c.els.viewBack = h.document.createElement("button");
  const names = ["goBack", "returnToStackView", "applyBackState", "isRootNavigationView", "readViewStateFromHash", "viewRouteHash",
    "routeHistoryState", "rememberCurrentScrollInHistory", "pushViewHistory", "replaceCurrentHistory", "openNativeLibraryRoute", "decodeRouteSegment"];
  vm.runInContext(names.map(name => appFunction(input.app, name)).join("\n"), c);
  const nativeStart = input.app.indexOf("window.fanhaoHandleNativeBack = () => {");
  const nativeEnd = input.app.indexOf("\n};", nativeStart);
  assert(nativeStart >= 0 && nativeEnd > nativeStart, "Actual native-back callback must exist");
  vm.runInContext(input.app.slice(nativeStart, nativeEnd + 3), c);
  const binding = input.app.match(/^els\.viewBack\.addEventListener\("click", goBack\);/m);
  assert(binding, "Actual page return button must call goBack"); vm.runInContext(binding[0], c);
  const rowStart = input.channel.indexOf("  function createTvSeriesContextRow(");
  const rowTail = input.channel.slice(rowStart), rowEnd = /^  \}/m.exec(rowTail);
  assert(rowStart >= 0 && rowEnd, "Real shared return button method exists");
  const rowContext = vm.createContext({ document: h.document, formatNumber: String, context: h.observations.channelContext,
    updateChannelParams: (...args) => h.observations.channelContext.updateChannelParams(...args) });
  vm.runInContext(rowTail.slice(0, rowEnd.index + rowEnd[0].length), rowContext);
  h.sharedBack = mode => rowContext.createTvSeriesContextRow(null, { mode }).querySelector("button").click();
  h.setScroll = value => { scroll = value; };
  h.cold = (kind = "hash") => {
    const next = harness(input, { storage: kind === "last" ? new Map(storage) : new Map(), hash: kind === "hash" ? c.window.location.hash : "" });
    const state = next.context.readInitialViewState();
    next.context.currentView = state.view; next.context.currentViewParams = state.params;
    next.context.renderCurrentView();
    assert.equal(next.context.viewStack.length, 0, "Cold restart has no warm stack");
    assert.equal(next.context.window.history.length, 1, "Cold restart does not fake browser history");
    return next;
  };
  return h;
}
const route = (h, view, params) => assert.deepEqual(plain(h.route()), { view, params });
const ROOT_TV = { mode: "tv", query: "合成 根筛选", category: "科幻", sort: "rating" };
const EPISODES = { mode: "tv", query: "分集筛选", category: "科幻", sort: "title", tvView: "episodes", seriesKey: "synthetic-series" };
function enterTv(input, h = harness(input)) {
  h.context.showView("channel", ROOT_TV, { resetStack: true });
  h.observations.channelContext.updateChannelParams({ ...EPISODES }, { push: true });
  const parent = h.route();
  assert.deepEqual(JSON.parse(parent.params.mediaTrail), [ROOT_TV]);
  h.observations.channelContext.showMediaDetail("episode-1", "tv");
  assert.deepEqual(JSON.parse(h.route().params.mediaTrail), [ROOT_TV, EPISODES]);
  return h;
}

for (const mode of ["movie", "tv", "anime", "media"]) for (const transport of ["hash", "last"]) {
  test(`${mode} catalog filters survive ${transport} cold detail and page back`, input => {
    const h = harness(input), parent = { mode, query: "合成 query & ? =", category: "合成分类", sort: "size" };
    h.context.showView("channel", parent, { resetStack: true });
    h.observations.channelContext.showMediaDetail("synthetic-detail", mode);
    assert.equal(typeof h.route().params.mediaTrail, "string", "Opening a detail must retain the serialized parent trail");
    assert.deepEqual(JSON.parse(h.route().params.mediaTrail), [parent]);
    const restarted = h.cold(transport);
    assert.deepEqual(plain(restarted.route()), plain(h.route()), "Actual shell transport retains the complete bounded trail");
    restarted.context.els.viewBack.click(); route(restarted, "channel", parent);
    assert.equal(restarted.context.bottomNavKeyFor(), "photo");
    assert.equal(restarted.observations.browserBacks, 0);
  });
}
for (const transport of ["hash", "last"]) {
  test(`TV catalog episodes detail two-level ${transport} restoration`, input => {
    const h = enterTv(input), restarted = h.cold(transport);
    assert.equal(restarted.context.window.fanhaoHandleNativeBack(), true);
    route(restarted, "channel", { ...EPISODES, mediaTrail: JSON.stringify([ROOT_TV]) });
    assert.equal(restarted.context.isRootNavigationView(), false);
    // Search is explicitly closed before the second native Back; it must not
    // accidentally consume the catalog navigation test's first Back instead.
    restarted.context.searchSurfaceExpanded = false;
    assert.equal(restarted.context.window.fanhaoHandleNativeBack(), true);
    route(restarted, "channel", ROOT_TV);
    assert.equal(restarted.context.isRootNavigationView(), true);
  });
}
test("shared return-to-series button restores root filters after cold restart", input => {
  const h = enterTv(input); h.context.els.viewBack.click();
  const restarted = h.cold("last"); restarted.sharedBack("tv"); route(restarted, "channel", ROOT_TV);
});
test("next and previous episode inherit trail without appending detail frames", input => {
  const h = enterTv(input), trail = h.route().params.mediaTrail;
  for (const id of ["episode-2", "episode-3", "episode-2"]) {
    h.observations.channelContext.showMediaDetail(id, "tv");
    assert.equal(h.route().params.mediaTrail, trail, "Episode switch must retain original two-level parents");
  }
  const restarted = h.cold(); restarted.context.els.viewBack.click();
  route(restarted, "channel", { ...EPISODES, mediaTrail: JSON.stringify([ROOT_TV]) });
});
test("warm stack returns exact prior episode/detail and restores original scroll", input => {
  const h = harness(input);
  h.context.showView("channel", ROOT_TV, { resetStack: true }); h.setScroll(812);
  h.observations.channelContext.updateChannelParams({ ...EPISODES }, { push: true }); h.setScroll(377);
  h.observations.channelContext.showMediaDetail("episode-1", "tv");
  h.context.els.viewBack.click();
  route(h, "channel", { ...EPISODES, mediaTrail: JSON.stringify([ROOT_TV]) });
  assert.equal(h.observations.restores.at(-1), 377, "Warm episode scroll is not reset by cold fallback");
  h.context.els.viewBack.click(); route(h, "channel", ROOT_TV);
  assert.equal(h.observations.restores.at(-1), 812, "Warm catalog scroll survives");
});
test("warm next-episode return restores prior detail rather than cold catalog", input => {
  const h = enterTv(input), before = h.route(); h.setScroll(601);
  h.observations.channelContext.showMediaDetail("episode-2", "tv");
  h.context.els.viewBack.click(); route(h, before.view, before.params);
  assert.equal(h.observations.restores.at(-1), 601);
});
for (const [mode, expected] of [["movie", "movie"], ["tv", "tv"], ["anime", "anime"], ["media", "media"], [undefined, "movie"]]) {
  test(`legacy empty-stack detail ${mode ?? "missing"} returns its media catalog`, input => {
    const h = harness(input); h.context.showView("mediaDetail", { id: "legacy", ...(mode ? { mode } : {}) });
    const restarted = h.cold(); restarted.context.els.viewBack.click(); route(restarted, "channel", { mode: expected });
  });
}
test("legacy western empty-stack detail retains Western people fallback", input => {
  const h = harness(input); h.context.showView("mediaDetail", { id: "western", mode: "western" });
  const restarted = h.cold(); assert.equal(restarted.context.window.fanhaoHandleNativeBack(), true);
  route(restarted, "people", { scope: "western" });
});
test("episode channels are nonroot with either seriesKey or episodes discriminator", input => {
  const h = harness(input);
  for (const mode of ["tv", "anime", "media"]) for (const discriminator of [{ seriesKey: "synthetic" }, { tvView: "episodes" }]) {
    if (mode === "anime" && !discriminator.seriesKey) continue;
    h.context.showView("channel", { mode, ...discriminator });
    assert.equal(h.context.isRootNavigationView(), false, "Episode list cannot masquerade as a root and exit app");
    h.context.window.fanhaoHandleNativeBack(); route(h, "channel", { mode });
    assert.equal(h.context.isRootNavigationView(), true);
    assert.equal(h.context.window.fanhaoHandleNativeBack(), false, "Actual root delegates native exit behavior");
  }
});
test("anime episode discriminators without a series key normalize to a catalog", input => {
  const h = harness(input), trail = JSON.stringify([{ mode: "anime", query: "previous" }]);
  for (const params of [{ tvView: "episodes" }, { view: "episodes", seriesKey: "  " }]) {
    h.context.showView("channel", { mode: "anime", ...params, mediaTrail: trail });
    route(h, "channel", { mode: "anime" });
    assert.equal(h.context.isRootNavigationView(), true);
  }
  assert.deepEqual(JSON.parse(h.context.normalizeMediaTrail(JSON.stringify([{ mode: "anime", tvView: "episodes" }]), "anime")), [{ mode: "anime" }]);
  assert.equal(h.context.normalizeMediaTrail(JSON.stringify([{ mode: "anime" }, { mode: "anime", tvView: "episodes" }]), "anime"), "");
});
test("root channels strip stale trails and reject unrelated/wrong-mode navigation frames", input => {
  const c = harness(input).context, valid = JSON.stringify([ROOT_TV]);
  assert.equal(c.sanitizeViewParams("channel", { ...ROOT_TV, mediaTrail: valid }).mediaTrail, undefined);
  for (const value of ["bad-json", "{}", "[]", JSON.stringify([ROOT_TV, EPISODES, EPISODES]),
    JSON.stringify([{ mode: "western" }]), JSON.stringify([{ mode: "photo" }]),
    JSON.stringify([{ mode: "tv", sort: "unsafe" }]), JSON.stringify([{ mode: "tv", query: "x".repeat(2049) }]),
    JSON.stringify([EPISODES, ROOT_TV]), JSON.stringify([ROOT_TV, ROOT_TV])]) {
    assert.equal(c.normalizeMediaTrail(value, "tv"), "");
    assert.equal(c.sanitizeViewParams("mediaDetail", { id: "x", mode: "tv", mediaTrail: value }).mediaTrail, undefined);
  }
  assert.equal(c.normalizeMediaTrail(JSON.stringify([{ mode: "tv" }]), "movie"), "");
  assert.equal(c.normalizeMediaTrail(JSON.stringify([{ mode: "tv" }]), "anime"), "");
  assert.equal(c.normalizeMediaTrail(JSON.stringify([{ mode: "anime" }]), "tv"), "");
  assert.equal(c.normalizeMediaTrail(JSON.stringify([{ mode: "media", seriesKey: "x" }]), "movie"), "");
  assert.deepEqual(JSON.parse(c.normalizeMediaTrail(JSON.stringify([{ mode: "tv", query: " q ", arbitrary: "secret", url: "https://invalid", mediaTrail: valid }]), "tv")), [{ mode: "tv", query: "q" }]);
});
test("generic media catalog can parent TV detail without changing original root mode", input => {
  const h = harness(input), parent = { mode: "media", query: "mixed", sort: "rating" };
  h.context.showView("channel", parent); h.observations.channelContext.showMediaDetail("series-episode", "tv");
  const restarted = h.cold(); restarted.context.els.viewBack.click(); route(restarted, "channel", parent);
});
for (const transport of ["hash", "last"]) test(`anime catalog episodes detail two-level ${transport} restoration`, input => {
  const h = harness(input), root = { mode: "anime", query: "合成动漫", category: "科幻", sort: "rating" };
  const episodes = { mode: "anime", query: "分集", category: "科幻", sort: "title", tvView: "episodes", seriesKey: "anime-series" };
  h.context.showView("channel", root, { resetStack: true }); h.observations.channelContext.updateChannelParams(episodes, { push: true });
  h.observations.channelContext.showMediaDetail("anime-2", "anime"); h.observations.channelContext.showMediaDetail("anime-3", "anime");
  assert.deepEqual(JSON.parse(h.route().params.mediaTrail), [root, episodes]);
  const restarted = h.cold(transport); restarted.context.els.viewBack.click();
  route(restarted, "channel", { ...episodes, mediaTrail: JSON.stringify([root]) }); assert.equal(restarted.context.isRootNavigationView(), false);
  restarted.sharedBack("anime"); route(restarted, "channel", root); assert.equal(restarted.context.bottomNavKeyFor(), "photo");
});
test("anime warm return preserves previous detail and recorded episode scroll", input => {
  const h = harness(input); h.context.showView("channel", { mode: "anime", seriesKey: "anime-series", sort: "title" }); h.setScroll(482);
  h.observations.channelContext.showMediaDetail("anime-1", "anime"); const first = h.route(); h.setScroll(617);
  h.observations.channelContext.showMediaDetail("anime-2", "anime"); h.context.els.viewBack.click(); route(h, first.view, first.params);
  assert.equal(h.observations.restores.at(-1), 617); h.context.els.viewBack.click(); assert.equal(h.route().params.mode, "anime"); assert.equal(h.observations.restores.at(-1), 482);
});
test("actual native anime routes preserve logical mode and encoded series filters", input => {
  for (const path of ["/anime", "/media?kind=anime"]) {
    const h = harness(input), join = path.includes("?") ? "&" : "?";
    const query = new URLSearchParams({ q: "合成 动漫", sort: "rating", category: "日本", seriesKey: "anime/series?#", tvView: "episodes" });
    assert.equal(h.context.openNativeLibraryRoute({ path: `${path}${join}${query}` }), true);
    route(h, "channel", { mode: "anime", query: "合成 动漫", sort: "rating", category: "日本", tvView: "episodes", seriesKey: "anime/series?#" });
    assert.equal(h.context.bottomNavKeyFor(), "photo");
  }
  for (const path of ["/anime/episode%2Fone", "/media/episode%2Fone?kind=anime"]) {
    const h = harness(input); assert.equal(h.context.openNativeLibraryRoute({ path }), true); route(h, "mediaDetail", { id: "episode/one", mode: "anime" });
  }
});
test("anime native back closes explicit episode search before navigation", input => {
  const h = harness(input); h.context.showView("channel", { mode: "anime", seriesKey: "anime-series", sort: "title" });
  h.context.searchSurfaceExpanded = true; const before = h.route(); assert.equal(h.context.window.fanhaoHandleNativeBack(), true); route(h, before.view, before.params);
  assert.equal(h.observations.searchCloses, 1); h.context.window.fanhaoHandleNativeBack(); route(h, "channel", { mode: "anime" });
});
for (const state of ["detail", "episodes"]) test(`native back closes explicit media search on ${state} before consuming navigation trail`, input => {
  const h = enterTv(input).cold();
  if (state === "episodes") h.context.els.viewBack.click();
  h.context.searchSurfaceExpanded = true;
  const before = h.route(); h.context.window.fanhaoHandleNativeBack(); route(h, before.view, before.params);
  assert.equal(h.observations.searchCloses, 1); h.context.window.fanhaoHandleNativeBack();
  if (state === "detail") {
    assert.equal(h.route().view, "channel"); assert.equal(h.route().params.seriesKey, EPISODES.seriesKey);
  } else route(h, "channel", ROOT_TV);
});
test("helper is wired at shell import and real host capabilities remain available", input => {
  assert.match(input.app, /import\s*\{\s*normalizeMediaTrail\s*\}\s*from\s*["'][^"']*media-navigation-state\.js\?v=/);
  const host = appFunction(input.app, "createAndroidModuleHost");
  for (const needle of ["currentView: () => currentView", "currentParams: () => currentViewParams", "returnToStackView,", "goBack,"]) assert(host.includes(needle), `Actual host wiring ${needle}`);
});

const changeFunction = (source, name, transform) => { const old = appFunction(source, name), next = transform(old); assert.notEqual(next, old); return source.replace(old, next); };
const controls = [
  { name: "shell loses serialized trail", target: "movie catalog filters survive hash", mutate: input => ({ ...input, app: changeFunction(input.app, "sanitizeViewParams", text => text.replaceAll("...(mediaTrail ? { mediaTrail } : {})", "...{}")) }) },
  { name: "empty stack falls back to unrelated people", target: "legacy empty-stack detail tv", mutate: input => ({ ...input, media: input.media.replace("if (!target) return false;", "return false;") }) },
  { name: "episode channel incorrectly remains a root", target: "episode channels are nonroot", mutate: input => ({ ...input, media: input.media.replace('isRootView: (view, params) => view === "channel" && !mediaBackTarget(view, params)', "isRootView: () => true") }) },
  { name: "switching episodes drops parent trail", target: "next and previous episode", mutate: input => ({ ...input, helper: input.helper.replace('if (sourceView === "mediaDetail") return normalizeMediaTrail(sourceParams.mediaTrail, targetMode);', 'if (sourceView === "mediaDetail") return "";') }) },
  { name: "cold fallback bypasses warm stack scroll", target: "warm stack returns", mutate: input => ({ ...input, media: input.media.replace("if (host.navigation.returnToStackView()) return true;", "/* no warm stack */") }) },
  { name: "shared return button bypasses restored catalog", target: "shared return-to-series", mutate: input => ({ ...input, channel: input.channel.replace("if (context.returnToMediaCatalog?.()) return;", "/* disconnected */") }) },
  { name: "media back consumes an open search surface", target: "native back closes explicit media search on episodes", mutate: input => ({ ...input, app: input.app.replace('if (searchSurfaceExpanded && (currentView === "mediaDetail" || (currentView === "channel" && ["media", "movie", "tv", "anime"].includes(normalizeChannelMode(currentViewParams.mode))))) {', "if (false) {") }) },
  { name: "anime native URI mistaken for movie", target: "actual native anime routes", mutate: input => ({ ...input, app: input.app.replace('first === "media" && query.get("kind") === "anime" ? "anime" :', 'first === "media" && query.get("kind") === "anime" ? "movie" :') }) },
  { name: "anime removed from episodic trail classification", target: "anime catalog episodes detail two-level hash", mutate: input => ({ ...input, helper: input.helper.replace('["tv", "anime", "media"].includes(params.mode)', '["tv", "media"].includes(params.mode)') }) }
];
let failures = 0, passed = 0, rejected = 0;
for (const item of tests) {
  try { item.run(sources); passed++; console.log(`PASS ${item.name}`); }
  catch (error) { failures++; console.error(`FAIL ${item.name}\n${error.stack}`); }
}
if (!failures) for (const control of controls) {
  try {
    const changed = control.mutate(sources); assert.notEqual(JSON.stringify(changed), JSON.stringify(sources), `No-op control: ${control.name}`);
    const item = tests.find(value => value.name.startsWith(control.target)); assert(item, control.target);
    let failure; try { item.run(changed); } catch (error) { failure = error; }
    assert(failure instanceof assert.AssertionError, `Must reject on safety assertion, not runtime/compile error: ${control.name}: ${failure?.stack || "unexpected pass"}`);
    rejected++; console.log(`REJECT ${control.name}`);
  } catch (error) { failures++; console.error(`FAIL control ${control.name}\n${error.stack}`); }
}
console.log(`Media navigation: ${passed}/${tests.length} scenarios; ${rejected}/${controls.length} safety controls; ${failures} failures.`);
process.exitCode = failures ? 1 : 0;
