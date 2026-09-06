import assert from "node:assert/strict";
import fs from "node:fs";
import { createGalleryHarness, appFunction } from "./fixtures/android-gallery-navigation-harness.mjs";

// Read-only source + deterministic VM DOM/events. Actual shell functions,
// bottom-nav listener registration, complete navigation renderer and independent
// media module/registry execute. The content renderer, storage, clocks and DOM
// are boundaries; this is not browser layout, Android gestures or media playback.
const read = name => fs.readFileSync(new URL(`../${name}`, import.meta.url), "utf8");
const sources = {
  app: read("android-client/www/app.js"), navigation: read("android-client/www/js/module-navigation.js"),
  registry: read("android-client/www/js/android-module-registry.js"), media: read("android-client/www/modules/media/android-module.js"),
  index: read("android-client/www/index.html")
};
const MODES = ["photo", "manga", "movie", "tv", "anime"];
const LABELS = { photo: "套图", manga: "韩漫", movie: "电影", tv: "电视剧", anime: "动漫" };
const STORAGE_KEY = "fanhao.android.galleryMode.v1";
const tests = [];
const test = (name, run) => tests.push({ name, run });
const plain = value => JSON.parse(JSON.stringify(value));
const harness = (value = sources, options = {}) => createGalleryHarness(value, options);

function menu(h, selected) {
  const choices = h.choices();
  assert.deepEqual(choices.map(node => node.dataset.galleryModeChoice), MODES, "Menu must expose all five destinations in order");
  assert.equal(h.picker().getAttribute("role"), "menu");
  for (const choice of choices) {
    const mode = choice.dataset.galleryModeChoice;
    assert.equal(choice.querySelector("strong").textContent, LABELS[mode]);
    assert.equal(choice.getAttribute("role"), "menuitemradio");
    assert.equal(choice.getAttribute("aria-checked"), String(mode === selected), `Checked option ${mode}`);
    assert.equal(choice.classList.contains("active"), mode === selected);
  }
}
function selection(h, mode) {
  const button = h.button();
  assert.equal(button.dataset.galleryModeCurrent, mode);
  assert.equal(button.querySelector(".bottom-nav-label").textContent, LABELS[mode]);
  assert(button.getAttribute("aria-label").includes(`当前${LABELS[mode]}`), "Accessible label follows selected destination");
  assert.equal(button.classList.contains("active"), true, "Gallery destination must be selected");
  assert.equal(button.getAttribute("aria-current"), "page");
  assert.deepEqual(plain(h.context.els.bottomNav.filter(item => item.classList.contains("active")).map(item => item.dataset.bottomKey)), ["photo"], "Exactly one active gallery destination; never FanHao");
}
function routed(h, mode) {
  assert.equal(h.route().view, "channel");
  assert.equal(h.route().params.mode, mode);
  assert.equal(h.route().params.photoView, mode === "photo" ? "collections" : undefined, "Photo-only collections cannot leak into media/manga");
  selection(h, mode);
  assert.equal(h.storage.get(STORAGE_KEY), mode);
  if (["movie", "tv", "anime"].includes(mode)) {
    assert.equal(h.context.androidModuleRegistry.resolve("channel", h.route().params).module.id, "media", "Media remains independently dispatched");
    assert.deepEqual(h.observations.media.at(-1), { kind: "channel", params: h.route().params });
  }
}
function replaceFunction(input, name, replacement) {
  const old = appFunction(input, name), updated = replacement(old);
  assert.notEqual(updated, old, `Control must change ${name}`);
  return input.replace(old, updated);
}

for (const fallback of [false, true]) {
  test(`${fallback ? "fallback" : "generated"} five-button navigation advertises and opens all five gallery choices`, input => {
    const h = harness(input, { fallback });
    assert.equal(h.context.els.bottomNav.length, 5);
    assert.equal(h.context.els.bottomNav.filter(node => node.dataset.gallerySwitcher !== undefined).length, 1);
    const button = h.button();
    assert.equal(button.getAttribute("aria-haspopup"), "menu");
    assert.equal(button.getAttribute("aria-expanded"), "false");
    for (const label of Object.values(LABELS)) assert(button.title.includes(label), `Long-press hint must mention ${label}`);
    h.fire(button, "contextmenu");
    assert.equal(h.picker().hidden, false); assert.equal(button.getAttribute("aria-expanded"), "true");
    menu(h, "photo");
  });
}

test("inactive click uses remembered destination then active clicks cycle photo/manga/movie/tv/anime", input => {
  const h = harness(input);
  for (const mode of [...MODES, "photo"]) { h.button().querySelector(".bottom-nav-label").click(); routed(h, mode); }
  assert.equal(h.observations.renders.length, MODES.length + 1);
  assert.equal(h.observations.scrolls, MODES.length + 1);
  assert.deepEqual(plain(h.context.viewStack), []);
  assert.equal(h.observations.unrelated.length, 0);
});

for (const mode of MODES) {
  test(`raw ${mode} navigation params keep photo-specific fields exclusive`, input => {
    const h = harness(input);
    assert.deepEqual(plain(h.context.galleryNavigationParams(mode)), mode === "photo" ? { mode, photoView: "collections" } : { mode });
    h.context.navigateToGalleryMode(mode);
    routed(h, mode);
    h.context.openGalleryModePicker(); menu(h, mode);
  });
  test(`long press chooses ${mode}; suppressed synthetic click does not cycle`, input => {
    const h = harness(input), button = h.button();
    h.fire(button, "touchstart", { touches: [{ clientX: 14, clientY: 16 }] });
    h.elapse(519); assert.equal(h.picker(), null);
    h.elapse(520); menu(h, "photo");
    h.fire(button, "touchend");
    button.click(); assert.equal(h.observations.renders.length, 0, "Long press must not also navigate");
    h.choices().find(node => node.dataset.galleryModeChoice === mode).querySelector("strong").click();
    routed(h, mode);
    assert.equal(h.picker().hidden, true); assert.equal(button.getAttribute("aria-expanded"), "false");
    assert.equal(h.document.body.classList.contains("gallery-mode-picker-open"), false);
    assert.equal(h.observations.renders.length, 1);
  });
  test(`${mode} choice persists through real showView and last-view restart`, input => {
    const h = harness(input); h.context.navigateToGalleryMode(mode);
    const restarted = h.reboot(); selection(restarted, mode);
    assert.equal(restarted.route().view, "channel"); assert.equal(restarted.route().params.mode, mode);
    restarted.context.showView("people", { scope: "main" });
    restarted.button().click(); routed(restarted, mode);
  });
}

test("existing photo/manga/movie/tv memory and anime memory work without a schema-key rename", input => {
  for (const mode of MODES) {
    const h = harness(input, { storage: new Map([[STORAGE_KEY, mode]]) });
    assert.equal(h.context.preferredGalleryMode(), mode);
    h.button().click(); routed(h, mode);
  }
  for (const value of ["", "invalid", "western", "media"]) {
    const h = harness(input, { storage: new Map([[STORAGE_KEY, value]]) });
    assert.equal(h.context.preferredGalleryMode(), "photo");
    assert.equal(h.context.alternateGalleryMode(value), "photo");
    h.button().click(); routed(h, "photo");
  }
});

for (const mode of ["movie", "tv", "anime", "media"]) {
  test(`${mode} direct and registry channel keys belong to photo, not FanHao`, input => {
    const h = harness(input);
    assert.equal(h.context.bottomNavKeyFor(mode), "photo");
    h.context.showView("channel", { mode });
    assert.equal(h.context.bottomNavKeyFor(), "photo");
    selection(h, mode === "media" ? "movie" : mode);
    assert.equal(h.context.androidModuleRegistry.resolve("channel", h.route().params).module.id, "media");
    assert.equal(h.observations.media.at(-1).params.mode, mode);
  });
}

for (const mode of ["movie", "tv", "anime", "media", undefined]) {
  test(`media detail ${mode ?? "unspecified"} keeps matching label and gallery selection`, input => {
    const h = harness(input);
    h.observations.channelContext.showMediaDetail("synthetic-media-id", mode);
    assert.equal(h.route().view, "mediaDetail");
    const selected = mode === "tv" || mode === "anime" ? mode : "movie";
    selection(h, selected);
    assert.equal(h.storage.get(STORAGE_KEY), selected, "Direct detail navigation must update durable gallery memory");
    assert.deepEqual(h.observations.media.at(-1), { kind: "detail", id: "synthetic-media-id", mode });
    h.context.openGalleryModePicker(); menu(h, selected);
    const restarted = h.reboot(); selection(restarted, selected);
    restarted.button().click(); routed(restarted, MODES[(MODES.indexOf(selected) + 1) % MODES.length]);
  });
}

test("western stays in FanHao and does not overwrite gallery memory", input => {
  const h = harness(input, { storage: new Map([[STORAGE_KEY, "tv"]]) });
  h.context.showView("mediaDetail", { id: "synthetic-western", mode: "western" });
  assert.equal(h.context.galleryModeForView(), "");
  assert.equal(h.context.bottomNavKeyFor(), "fanhao");
  assert.equal(h.storage.get(STORAGE_KEY), "tv");
  assert.equal(h.button().classList.contains("active"), false);
  h.button().click(); routed(h, "tv");
});

test("photo/manga details retain their existing grouping and cycle position", input => {
  for (const [view, selected, next] of [["photoDetail", "photo", "manga"], ["mangaDetail", "manga", "movie"], ["mangaChapter", "manga", "movie"]]) {
    const h = harness(input); h.context.showView(view, { id: "synthetic", chapterIndex: 1 });
    selection(h, selected); h.button().click(); routed(h, next);
  }
});

test("movement, canceled touch and multiple contacts do not open gallery picker", input => {
  for (const outcome of ["move", "cancel", "multi"]) {
    const h = harness(input), button = h.button();
    h.fire(button, "touchstart", { touches: outcome === "multi" ? [{ clientX: 0, clientY: 0 }, { clientX: 1, clientY: 1 }] : [{ clientX: 0, clientY: 0 }] });
    if (outcome === "move") h.fire(button, "touchmove", { touches: [{ clientX: 40, clientY: 0 }] });
    if (outcome === "cancel") h.fire(button, "touchcancel");
    h.elapse(1000); assert.equal(h.picker(), null); assert.equal(h.observations.renders.length, 0);
  }
});

test("outside pointer closes one existing picker without changing current mode", input => {
  const h = harness(input); h.context.navigateToGalleryMode("tv");
  h.context.openGalleryModePicker(); const picker = h.picker();
  h.context.openGalleryModePicker(); assert.equal(h.picker(), picker);
  assert.equal(h.bar.querySelectorAll(".bottom-nav-gallery-picker").length, 1);
  h.fire(h.document.body, "pointerdown");
  assert.equal(picker.hidden, true); selection(h, "tv");
  h.context.openGalleryModePicker(); menu(h, "tv");
});

const controls = [
  { name: "missing anime menu choice", target: 0, mutate: input => ({ ...input, app: replaceFunction(input.app, "ensureGalleryModePicker", text => text.replace("GALLERY_MODE_OPTIONS", 'GALLERY_MODE_OPTIONS.filter(option => option.mode !== "anime")')) }) },
  { name: "missing movie/tv menu choices", target: 0, mutate: input => ({ ...input, app: replaceFunction(input.app, "ensureGalleryModePicker", text => text.replace("GALLERY_MODE_OPTIONS", "GALLERY_MODE_OPTIONS.slice(0, 2)")) }) },
  { name: "photo-only parameters leak into movie", target: "raw movie navigation", mutate: input => ({ ...input, app: replaceFunction(input.app, "galleryNavigationParams", () => 'function galleryNavigationParams(mode = preferredGalleryMode()) { return { mode, photoView: "collections" }; }') }) },
  { name: "media registry still selects FanHao", target: "movie direct and registry", mutate: input => ({ ...input, app: replaceFunction(input.app, "bottomNavKeyFor", text => text.replace('if (resolvedKey === "media") return "photo";', 'if (resolvedKey === "media") return "fanhao";')) }) },
  { name: "active cycle still stops after two", target: "inactive click", mutate: input => ({ ...input, app: replaceFunction(input.app, "alternateGalleryMode", () => 'function alternateGalleryMode(mode = preferredGalleryMode()) { return mode === "manga" ? "photo" : "manga"; }') }) },
  { name: "gallery choice listener disconnected", target: "long press chooses tv", mutate: input => ({ ...input, app: input.app.replace('navigateToGalleryMode(button.dataset.galleryModeChoice);', 'void button.dataset.galleryModeChoice;') }) },
  { name: "showView forgets gallery memory", target: "media detail tv", mutate: input => ({ ...input, app: replaceFunction(input.app, "showView", text => text.replace('rememberGalleryMode(currentView, currentViewParams);', 'void currentViewParams;')) }) }
];

let failures = 0, passed = 0;
for (const item of tests) {
  try { item.run(sources); passed++; console.log(`PASS ${item.name}`); }
  catch (error) { failures++; console.error(`FAIL ${item.name}\n${error.stack}`); }
}
let rejected = 0;
if (!failures) for (const control of controls) {
  try {
    const changed = control.mutate(sources); assert.notEqual(changed.app, sources.app, `Control ${control.name} made no change`);
    const item = typeof control.target === "number" ? tests[control.target] : tests.find(value => value.name.startsWith(control.target));
    assert(item, `Control target missing: ${control.target}`);
    let failure;
    try { item.run(changed); } catch (error) { failure = error; }
    assert(failure instanceof assert.AssertionError, `Control must fail a safety assertion, not compilation/runtime: ${control.name}: ${failure?.stack || "unexpectedly passed"}`);
    rejected++; console.log(`REJECT ${control.name}`);
  } catch (error) { failures++; console.error(`FAIL control ${control.name}\n${error.stack}`); }
}
console.log(`Gallery navigation: ${passed}/${tests.length} scenarios; ${rejected}/${controls.length} safety controls; ${failures} failures.`);
process.exitCode = failures ? 1 : 0;
