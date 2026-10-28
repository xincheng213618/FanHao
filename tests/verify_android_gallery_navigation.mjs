import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
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

test("inactive click restores its category; repeated root taps preserve filters and scroll to top", input => {
  const h = harness(input);
  h.button().querySelector(".bottom-nav-label").click(); routed(h, "photo");
  h.context.currentViewParams.category = "synthetic-filter";
  h.context.channelLimit = 108;
  for (let index = 0; index < 5; index++) h.button().querySelector(".bottom-nav-label").click();
  assert.equal(h.route().params.mode, "photo");
  assert.equal(h.route().params.category, "synthetic-filter");
  assert.equal(h.context.channelLimit, 108);
  assert.equal(h.observations.renders.length, 1);
  assert.equal(h.observations.scrolls, 6);
  assert.deepEqual(plain(h.context.viewStack), []);
  assert.equal(h.observations.unrelated.length, 0);
});

test("visible gallery selector lists every category and routes explicit choices only on root pages", input => {
  const h = harness(input);
  h.context.els.moduleModeSwitch = h.document.createElement("div");
  const select = h.context.els.moduleModeSelect = h.document.createElement("select");
  vm.runInContext(appFunction(input.app, "syncModuleModeSwitch"), h.context);
  const start = input.app.indexOf('els.moduleModeSelect?.addEventListener("change"');
  const end = input.app.indexOf('els.profileSettingsButton?.addEventListener', start);
  assert(start >= 0 && end > start);
  vm.runInContext(input.app.slice(start, end), h.context);
  h.context.navigateToGalleryMode("photo");
  for (const mode of MODES) {
    assert.equal(h.context.els.moduleModeSwitch.hidden, false);
    assert.deepEqual(select.children.map(option => option.value), MODES);
    select.value = mode; h.fire(select, "change"); routed(h, mode);
    assert.equal(select.children.find(option => option.selected).value, mode);
  }
  h.context.showView("mediaDetail", { id: "synthetic", mode: "anime" });
  assert.equal(h.context.els.moduleModeSwitch.hidden, true, "The selector must leave detail space to the content");
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
    restarted.button().click(); routed(restarted, selected);
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

test("photo/manga detail bottom taps return to their own category", input => {
  for (const [view, selected] of [["photoDetail", "photo"], ["mangaDetail", "manga"], ["mangaChapter", "manga"]]) {
    const h = harness(input); h.context.showView(view, { id: "synthetic", chapterIndex: 1 });
    selection(h, selected); h.button().click(); routed(h, selected);
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
  const card = h.document.createElement("button"); h.document.body.append(card);
  let underlyingClicks = 0; card.addEventListener("click", () => underlyingClicks++);
  assert.equal(h.fire(card, "pointerdown").defaultPrevented, true);
  card.click();
  assert.equal(underlyingClicks, 0, "Dismissing the picker must consume the underlying card click in capture phase");
  assert.equal(picker.hidden, true); selection(h, "tv");
  h.fire(card, "pointerdown"); card.click();
  assert.equal(underlyingClicks, 1, "The next deliberate gesture must still work");
  h.context.openGalleryModePicker(); menu(h, "tv");
});

test("a long press without a synthetic click cannot swallow the next physical bottom tap", input => {
  const h = harness(input); h.context.navigateToGalleryMode("movie");
  h.fire(h.button(), "touchstart", { touches: [{ clientX: 14, clientY: 16 }] });
  h.elapse(520); h.fire(h.button(), "touchend");
  h.context.showView("mediaDetail", { id: "synthetic", mode: "movie" });
  h.fire(h.button(), "pointerdown"); h.button().click();
  routed(h, "movie");
});

const MENU_FAMILIES = [
  { kind: "home", trigger: "[data-home-switcher]", choices: "[data-home-mode-choice]", choiceKey: "homeModeChoice",
    storage: "fanhao.android.homeMode.v1", selected: "western", view: "people", params: { scope: "western" }, other: "fanhao" },
  { kind: "gallery", trigger: "[data-gallery-switcher]", choices: "[data-gallery-mode-choice]", choiceKey: "galleryModeChoice",
    storage: STORAGE_KEY, selected: "tv", view: "channel", params: { mode: "tv" }, other: "anime" },
  { kind: "reading", trigger: "[data-reading-switcher]", choices: "[data-reading-mode-choice]", choiceKey: "readingModeChoice",
    storage: "fanhao.android.readingMode.v1", selected: "music", view: "music", params: {}, other: "novels" }
];

function familyHarness(input, family) {
  const h = harness(input, { initialView: family.view, initialParams: { ...family.params }, storage: new Map([[family.storage, family.selected]]) });
  const trigger = () => h.bar.querySelector(family.trigger), picker = () => h.bar.querySelector(`.bottom-nav-${family.kind}-picker`);
  const choices = () => picker()?.querySelectorAll(family.choices) || [];
  const open = () => {
    trigger().focus(); const event = h.fire(trigger(), "contextmenu"); assert.equal(event.defaultPrevented, true);
    assert(picker() && !picker().hidden); assert.equal(trigger().getAttribute("aria-expanded"), "true");
    const selected = choices().find(node => node.dataset[family.choiceKey] === family.selected);
    assert(h.document.activeElement === selected, "opening a real bottom menu focuses its checked option");
    return selected;
  };
  const snapshot = () => ({ route: plain(h.route()), storage: [...h.storage.entries()], renders: h.observations.renders.length,
    histories: plain(h.observations.histories), scrolls: h.observations.scrolls, back: [...h.observations.back] });
  const closed = () => {
    assert.equal(picker().hidden, true); assert.equal(trigger().getAttribute("aria-expanded"), "false");
    assert.equal(h.document.body.classList.contains(`${family.kind}-mode-picker-open`), false);
  };
  return { ...h, family, trigger, modePicker: picker, modeChoices: choices, open, snapshot, closed };
}

test("real document Escape closes each menu from its trigger or choice without touching lower navigation", input => {
  for (const family of MENU_FAMILIES) for (const focused of ["trigger", "choice"]) {
    const h = familyHarness(input, family), choice = h.open(), before = h.snapshot();
    const target = focused === "trigger" ? h.trigger() : choice; target.focus();
    const event = h.fire(target, "keydown", { key: "Escape" });
    assert.equal(event.defaultPrevented, true, "the registered document listener consumes menu Escape"); h.closed();
    assert(h.document.activeElement === h.trigger(), "menu Escape restores the exact current trigger");
    assert.deepEqual(h.snapshot(), before, "Escape dismissal cannot navigate render scroll write memory or call lower Back");
  }
});

test("real NativeBack consumes each open menu before module root or history Back", input => {
  for (const family of MENU_FAMILIES) {
    const h = familyHarness(input, family); h.open(); const before = h.snapshot();
    assert.equal(h.back(), true, "the actual NativeBack dispatcher consumes the open menu"); h.closed();
    assert(h.document.activeElement === h.trigger()); assert.deepEqual(h.snapshot(), before);
    assert.equal(h.back(), false, "the following Back resumes the actual root-navigation fallback");
    assert.deepEqual(h.observations.back, ["module"], "only the following Back may reach the underlying module");
    assert.deepEqual(h.route(), before.route);
  }
});

test("Escape and NativeBack do not let long-press suppression swallow the next keyboard click", input => {
  for (const family of MENU_FAMILIES) for (const dismissal of ["Escape", "NativeBack"]) {
    const h = familyHarness(input, family); h.open();
    if (dismissal === "Escape") h.fire(h.document.activeElement, "keydown", { key: "Escape" }); else assert.equal(h.back(), true);
    const scrolls = h.observations.scrolls, renders = h.observations.renders.length;
    h.fire(h.trigger(), "click", { detail: 0 });
    assert.equal(h.observations.scrolls, scrolls + 1, "the next independent keyboard click keeps the ordinary active-root action");
    assert.equal(h.observations.renders.length, renders); h.closed();
  }
});

test("real menu Arrow Home End and Tab listeners move roving focus and keep keyboard choices navigable", input => {
  for (const family of MENU_FAMILIES) {
    const h = familyHarness(input, family); h.trigger().focus();
    assert.equal(h.fire(h.trigger(), "keydown", { key: "ArrowDown" }).defaultPrevented, true);
    const choices = h.modeChoices(); assert(choices.includes(h.document.activeElement));
    const initial = choices.indexOf(h.document.activeElement), before = h.snapshot();
    h.fire(h.document.activeElement, "keydown", { key: "ArrowDown" });
    assert(h.document.activeElement === choices[(initial + 1) % choices.length]);
    h.fire(h.document.activeElement, "keydown", { key: "ArrowUp" }); assert(h.document.activeElement === choices[initial]);
    h.fire(h.document.activeElement, "keydown", { key: "Home" }); assert(h.document.activeElement === choices[0]);
    h.fire(h.document.activeElement, "keydown", { key: "End" }); assert(h.document.activeElement === choices.at(-1));
    assert.deepEqual(choices.map(choice => choice.tabIndex), choices.map(choice => choice === choices.at(-1) ? 0 : -1));
    const tab = h.fire(h.document.activeElement, "keydown", { key: "Tab" });
    assert.equal(tab.defaultPrevented, false, "native Tab default navigation is left to the browser"); h.closed();
    assert(h.document.activeElement === h.trigger()); assert.deepEqual(h.snapshot(), before);
    assert.equal(h.fire(h.trigger(), "keydown", { key: "ArrowUp" }).defaultPrevented, true);
    const reverseTab = h.fire(h.document.activeElement, "keydown", { key: "Tab", shiftKey: true });
    assert.equal(reverseTab.defaultPrevented, false); h.closed();
    h.open(); const other = h.modeChoices().find(choice => choice.dataset[family.choiceKey] === family.other);
    other.focus(); h.fire(other, "click", { detail: 0 }); h.closed();
    assert.equal(h.storage.get(family.storage), family.other);
    if (family.kind === "home") assert.deepEqual(h.route(), { view: "people", params: { scope: "main" } });
    else if (family.kind === "reading") assert.deepEqual(h.route(), { view: "novels", params: {} });
    else assert.equal(h.route().params.mode, "anime");
  }
});

test("outside dismissal consumes pointer clicks while an independent keyboard click still reaches its target", input => {
  for (const family of MENU_FAMILIES) {
    const h = familyHarness(input, family); h.open();
    const target = h.document.createElement("button"); h.document.body.append(target); let clicks = 0;
    target.addEventListener("click", () => clicks++);
    assert.equal(h.fire(target, "pointerdown").defaultPrevented, true); h.closed();
    h.fire(target, "click", { detail: 0 });
    assert.equal(clicks, 1, "an independent keyboard click cannot inherit outside pointer suppression");
  }
});

test("already queued long-press callbacks retire on cancellation generation route source and replaced controls", input => {
  const family = MENU_FAMILIES[1];
  for (const transition of ["cancel", "generation", "route", "source", "new controls", "new press", "view event", "pagehide"]) {
    const h = familyHarness(input, family), old = h.trigger();
    h.fire(old, "touchstart", { touches: [{ clientX: 14, clientY: 16 }] });
    const timer = h.pendingTimers().find(item => item.delay === 520); assert(timer);
    if (transition === "cancel") h.fire(old, "touchcancel");
    if (transition === "generation") h.context.renderCurrentView();
    if (transition === "route") h.context.currentViewParams = { ...h.context.currentViewParams, category: "new category" };
    if (transition === "source") h.context.activeUrl = "https://other-menu.fixture.invalid";
    if (transition === "new controls") h.replaceNavigation();
    if (transition === "view event") h.emit("fanhaoViewWillRender");
    if (transition === "pagehide") h.emit("pagehide");
    if (transition === "new press") {
      h.fire(old, "touchcancel"); h.fire(h.bar.querySelector(MENU_FAMILIES[0].trigger), "touchstart", { touches: [{ clientX: 16, clientY: 16 }] });
    }
    const before = h.snapshot(); timer.fn();
    assert(!h.modePicker() || h.modePicker().hidden, "retired long-press callback cannot open a menu");
    assert.deepEqual(h.snapshot(), before);
    if (transition === "new press") {
      h.elapse(520); assert.equal(h.bar.querySelector(".bottom-nav-home-picker").hidden, false, "old callback cannot cancel the newer actual press");
    }
  }
});

test("retired menu choices cannot navigate and stale scope cannot restore focus to old or replacement triggers", input => {
  for (const transition of ["route", "source", "new controls"]) {
    const h = familyHarness(input, MENU_FAMILIES[1]); h.open(); const choice = h.modeChoices().at(-1);
    if (transition === "route") h.context.showView("tools", {}, { skipHistory: true });
    if (transition === "source") h.context.activeUrl = "https://other-menu.fixture.invalid";
    if (transition === "new controls") h.replaceNavigation();
    const before = h.snapshot(), destination = h.document.createElement("button"); h.document.body.append(destination); destination.focus();
    h.fire(choice, "click", { detail: 0 }); assert.deepEqual(h.snapshot(), before, "retired choices cannot start routing or write mode memory");
    h.fire(destination, "keydown", { key: "Escape" });
    assert(h.document.activeElement === destination, "invalid menu scope cannot restore focus over the current destination");
  }
});

test("real shell Escape and NativeBack keep higher overlays ahead of the navigation menu", input => {
  const h = familyHarness(input, MENU_FAMILIES[1]); h.open();
  h.fire(h.document.activeElement, "keydown", { key: "Escape", defaultPrevented: true }); assert.equal(h.modePicker().hidden, false);
  h.context.els.appConfirmOverlay.hidden = false;
  h.fire(h.document.activeElement, "keydown", { key: "Escape" });
  assert.deepEqual(h.observations.back, ["confirmation"]); assert.equal(h.modePicker().hidden, false);
  h.context.els.settingsOverlay.hidden = false; assert.equal(h.back(), true);
  assert.deepEqual(h.observations.back, ["confirmation", "settings"]); assert.equal(h.modePicker().hidden, false);
  assert.equal(h.back(), true); h.closed(); assert.deepEqual(h.observations.back, ["confirmation", "settings"]);
});

function longPressMenu(h) {
  h.trigger().focus(); h.fire(h.trigger(), "touchstart", { touches: [{ clientX: 14, clientY: 16 }] });
  h.elapse(520); h.fire(h.trigger(), "touchend");
  assert(h.modePicker() && !h.modePicker().hidden, "the real long-press timer opens its menu before compatibility mouse events");
}

test("long-press compatibility mouse focus returns to the current roving choice without navigating", input => {
  for (const family of MENU_FAMILIES) {
    const h = familyHarness(input, family); longPressMenu(h);
    h.fire(h.document.activeElement, "keydown", { key: "ArrowDown" });
    const roving = h.document.activeElement, checked = h.modeChoices().find(choice => choice.getAttribute("aria-checked") === "true");
    assert(h.modeChoices().includes(roving) && roving !== checked, "the representative must distinguish roving menu focus from the checked mode");
    const before = h.snapshot(); h.compatibilityMouseDown(h.trigger());
    assert(h.document.activeElement === h.trigger(), "compatibility mousedown first transfers native focus to the trigger");
    const click = h.compatibilityRelease(h.trigger());
    assert.equal(click.defaultPrevented, true);
    assert(h.document.activeElement === roving, "consumed compatibility click restores the current roving menu choice");
    assert.equal(roving.tabIndex, 0); assert.equal(checked.getAttribute("aria-checked"), "true");
    assert.equal(h.modePicker().hidden, false); assert.equal(h.trigger().getAttribute("aria-expanded"), "true");
    assert.deepEqual(h.snapshot(), before, "compatibility release cannot navigate or change the checked mode");
  }
});

test("closed or stale long-press menus cannot steal focus or navigate from a late compatibility release", input => {
  for (const family of MENU_FAMILIES) for (const dismissal of ["Escape", "NativeBack"]) {
    const h = familyHarness(input, family); longPressMenu(h); h.compatibilityMouseDown(h.trigger());
    if (dismissal === "Escape") h.fire(h.trigger(), "keydown", { key: "Escape" }); else assert.equal(h.back(), true);
    h.closed();
    const destination = h.document.createElement("button"); h.document.body.append(destination); destination.focus();
    const before = h.snapshot(); const click = h.compatibilityRelease(h.trigger());
    assert.equal(click.defaultPrevented, true); h.closed();
    assert(h.document.activeElement === destination, "a release after menu close cannot focus hidden choices or restore an old trigger");
    assert.deepEqual(h.snapshot(), before);
  }
  for (const transition of ["source", "generation"]) {
    const h = familyHarness(input, MENU_FAMILIES[1]); longPressMenu(h); h.compatibilityMouseDown(h.trigger());
    if (transition === "source") h.context.activeUrl = "https://other-menu.fixture.invalid";
    else h.context.renderCurrentView();
    const destination = h.document.createElement("button"); h.document.body.append(destination); destination.focus();
    const before = h.snapshot(); h.compatibilityRelease(h.trigger());
    assert(h.document.activeElement === destination, "a release under a retired scope cannot restore menu focus");
    assert.deepEqual(h.snapshot(), before);
  }
});

const controls = [
  { name: "missing anime menu choice", target: 0, mutate: input => ({ ...input, app: replaceFunction(input.app, "ensureGalleryModePicker", text => text.replace("GALLERY_MODE_OPTIONS", 'GALLERY_MODE_OPTIONS.filter(option => option.mode !== "anime")')) }) },
  { name: "missing movie/tv menu choices", target: 0, mutate: input => ({ ...input, app: replaceFunction(input.app, "ensureGalleryModePicker", text => text.replace("GALLERY_MODE_OPTIONS", "GALLERY_MODE_OPTIONS.slice(0, 2)")) }) },
  { name: "photo-only parameters leak into movie", target: "raw movie navigation", mutate: input => ({ ...input, app: replaceFunction(input.app, "galleryNavigationParams", () => 'function galleryNavigationParams(mode = preferredGalleryMode()) { return { mode, photoView: "collections" }; }') }) },
  { name: "media registry still selects FanHao", target: "movie direct and registry", mutate: input => ({ ...input, app: replaceFunction(input.app, "bottomNavKeyFor", text => text.replace('if (resolvedKey === "media") return "photo";', 'if (resolvedKey === "media") return "fanhao";')) }) },
  { name: "repeated root tap rerenders and loses filters", target: "inactive click", mutate: input => ({ ...input, app: input.app.replace('button.classList.contains("active") && isRootNavigationView()', 'button.classList.contains("active") && false') }) },
  { name: "outside dismissal lets the underlying click through", target: "outside pointer", mutate: input => ({ ...input, app: input.app.replace('if (!dismissModePickerClick) return;', 'if (true) return;') }) },
  { name: "long-press suppression leaks into next physical gesture", target: "a long press without", mutate: input => ({ ...input, app: input.app.replace('  suppressedBottomNavButton = null;\n  dismissModePickerClick = false;', '  dismissModePickerClick = false;') }) },
  { name: "gallery choice listener disconnected", target: "long press chooses tv", mutate: input => ({ ...input, app: input.app.replace('navigateToGalleryMode(button.dataset.galleryModeChoice);', 'void button.dataset.galleryModeChoice;') }) },
  { name: "showView forgets gallery memory", target: "media detail tv", mutate: input => ({ ...input, app: replaceFunction(input.app, "showView", text => text.replace('rememberGalleryMode(currentView, currentViewParams);', 'void currentViewParams;')) }) },
  { name: "document Escape menu branch disconnected", target: "real document Escape", mutate: input => ({ ...input,
    app: input.app.replace('else if (!closeMobileActionSheet() && !closeActiveModePicker(true)) return;', 'else if (!closeMobileActionSheet()) return;') }) },
  { name: "NativeBack menu branch disconnected", target: "real NativeBack", mutate: input => ({ ...input,
    app: input.app.replace('if (closeActiveModePicker(true)) return true;', 'if (false) return true;') }) },
  { name: "menu closing omits trigger focus restoration", target: "real document Escape", mutate: input => ({ ...input,
    app: input.app.replace('if (restore) session.trigger.focus({ preventScroll: true });', 'if (restore) void session.trigger;') }) },
  { name: "pointer suppression consumes a subsequent keyboard click", target: "Escape and NativeBack", mutate: input => ({ ...input,
    app: input.app.replace('if (suppressedBottomNavButton === button && event.detail !== 0)', 'if (suppressedBottomNavButton === button)') }) },
  { name: "retired press identity no longer guards the queued timer", target: "already queued long-press", mutate: input => ({ ...input,
    app: input.app.replace(/if \(bottomNavPress !== press \|\| bottomNavLongPressButton !== button\r?\n\s*\|\| /, 'if (') }) },
  { name: "compatibility click no longer restores the roving menu focus", target: "long-press compatibility mouse", mutate: input => ({ ...input,
    app: input.app.replace('if (modePickerSessionMounted(session) && modePickerScopeCurrent(session.scope) && session.trigger === button) {',
      'if (false && modePickerSessionMounted(session) && modePickerScopeCurrent(session.scope) && session.trigger === button) {') }) }
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
