import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { shouldHandleShortVideoShortcut } from "../public/modules/short-videos/playback-keyboard-policy.js";

// Execute the current page's registered handler, rather than a second copy of
// its dispatch logic. DOM targets and native activation are controlled here;
// no service, media files, database or browser profile is needed.
const source = fs.readFileSync(new URL("../public/modules/short-videos/short-video-page.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");
const handlerStart = source.indexOf('    window.addEventListener("keydown", (event) => {');
const handlerEnd = source.indexOf('    document.addEventListener("visibilitychange",', handlerStart);
assert(handlerStart >= 0 && handlerEnd > handlerStart, "the page must register its playback keyboard handler");
const handlerSource = source.slice(handlerStart, handlerEnd);

class Target {
  constructor(tag = "div", attributes = {}, parentElement = null) {
    this.tagName = tag;
    this.attributes = attributes;
    this.parentElement = parentElement;
    this.nodeType = 1;
  }
  closest(selector) {
    for (let item = this; item; item = item.parentElement) {
      if (selector.split(",").some((part) => item.matches(part.trim()))) return item;
    }
    return null;
  }
  matches(selector) {
    if (selector.startsWith(".")) return String(this.attributes.class || "").split(/\s+/).includes(selector.slice(1));
    if (selector.startsWith("[contenteditable]")) {
      return Object.hasOwn(this.attributes, "contenteditable") && this.attributes.contenteditable !== "false";
    }
    const attribute = selector.match(/^\[([^=\]]+)(?:=['"]([^'"]+)['"])?\]$/);
    if (attribute) return Object.hasOwn(this.attributes, attribute[1]) && (attribute[2] === undefined || this.attributes[attribute[1]] === attribute[2]);
    return this.tagName === selector;
  }
}

function fixture({ gallery = false, settings = false, search = false } = {}) {
  const calls = [];
  const browser = { shortVideoRevealControls: () => calls.push("reveal") };
  const settingsOverlay = settings ? new Target("div", { class: "short-video-more-overlay" }) : null;
  const searchOverlay = search ? new Target("div", { class: "short-video-search-overlay" }) : null;
  const state = { activeView: "shortVideos", shortVideo: { current: { id: "fixture" } } };
  let handler;
  const overlaySelector = ".short-video-search-overlay, .short-video-author-sheet, .short-video-share-panel, .short-video-more-overlay";
  vm.runInNewContext(handlerSource, {
    window: { addEventListener: (name, callback) => { assert.equal(name, "keydown"); handler = callback; } },
    document: { fullscreenElement: false }, state, shortVideoWheelController: null,
    cancelShortVideoPanelLoading() {},
    shortVideoFullscreenController: null, cancelShortVideoFullscreen() {},
    els: { workGrid: { querySelector: (selector) => ({
      ".short-video-more-overlay": settingsOverlay,
      ".short-video-search-overlay": searchOverlay,
      ".short-video-browser": browser
    })[selector] || null } },
    shouldHandleShortVideoShortcut,
    isShortVideoOverlayTarget: (target) => Boolean(target?.closest?.(overlaySelector)),
    closePlaybackSettings: () => calls.push("close-settings"),
    closeShortVideoSearchOverlay: () => calls.push("close-search"),
    closeAuthorPanel: () => calls.push("close-author-panel"),
    closeOrRevealBrowser: () => calls.push("close-player-or-panel"),
    isGalleryPost: () => gallery,
    stepActiveGallery: (direction) => calls.push(`gallery:${direction}`),
    seekActiveVideo: (seconds) => calls.push(`seek:${seconds}`),
    openAdjacent: async (direction) => { calls.push(`adjacent:${direction}`); },
    toggleActivePlayer: () => calls.push("toggle-play"),
    toggleActiveMute: async () => { calls.push("toggle-mute"); return true; },
    toggleClearScreen: () => calls.push("toggle-clear"),
    toggleShortVideoFullscreen: () => calls.push("toggle-fullscreen"),
    showBrowserToast() {},
    showError: (error) => { throw error; }
  });
  const dispatch = (key, target = new Target(), options = {}) => {
    const event = {
      key, target, defaultPrevented: false, ...options,
      preventDefault() { this.defaultPrevented = true; }
    };
    handler(event);
    if (!event.defaultPrevented && (key === " " || key === "Enter") && target?.closest?.("button, a, summary, [role='button'], [role='switch']")) {
      calls.push("native-activate");
    }
    return event;
  };
  return { calls, dispatch, state };
}

for (const tag of ["button", "a"]) {
  const f = fixture();
  const focusedControl = new Target(tag);
  f.dispatch("ArrowDown", focusedControl);
  f.dispatch("ArrowUp", focusedControl);
  f.dispatch("ArrowRight", focusedControl);
  f.dispatch("ArrowLeft", focusedControl);
  f.dispatch("m", focusedControl);
  f.dispatch("F", focusedControl);
  f.dispatch("j", focusedControl);
  f.dispatch("Escape", focusedControl);
  assert.deepEqual(f.calls.filter((call) => call !== "reveal"), [
    "adjacent:1", "adjacent:-1", "seek:5", "seek:-5", "toggle-mute", "toggle-fullscreen", "toggle-clear", "close-player-or-panel"
  ], `playback shortcuts remain usable after focusing a ${tag}`);
}

for (const target of [new Target("button"), new Target("span", {}, new Target("button")), new Target("a"), new Target("summary"), new Target("div", { role: "button" }), new Target("div", { role: "switch" })]) {
  const f = fixture();
  const event = f.dispatch(" ", target);
  assert.equal(event.defaultPrevented, false, "Space keeps the control's native activation");
  assert.deepEqual(f.calls, ["native-activate"], "Space must not both pause and activate the focused control");
  f.calls.length = 0;
  f.dispatch("Enter", target);
  assert.deepEqual(f.calls, ["native-activate"], "Enter must retain exactly one native activation");
}

for (const target of [
  new Target("input"), new Target("textarea"), new Target("select"),
  new Target("div", { role: "slider" }), new Target("div", { role: "textbox" }),
  new Target("span", {}, new Target("div", { contenteditable: "" })),
  new Target("span", {}, new Target("div", { contenteditable: "plaintext-only" })),
  new Target("button", {}, new Target("div", { role: "menu" })),
  new Target("button", { role: "tab" }), new Target("div", { role: "listbox" })
]) {
  const f = fixture();
  for (const key of ["ArrowDown", "ArrowLeft", "PageUp", "m", "f", "j", "Escape"]) {
    assert.equal(f.dispatch(key, target).defaultPrevented, false);
  }
  assert.deepEqual(f.calls, [], "inputs, sliders and composite widgets own their keys");
}

for (const options of [{ defaultPrevented: true }, { isComposing: true }, { keyCode: 229 }, { ctrlKey: true }, { altKey: true }, { metaKey: true }, { shiftKey: true }]) {
  const f = fixture();
  f.dispatch("ArrowDown", new Target("button"), options);
  assert.deepEqual(f.calls, [], "modified, composing and already handled navigation must not switch videos");
}

{
  const f = fixture();
  f.dispatch("M", new Target("button"), { shiftKey: true });
  assert.deepEqual(f.calls, ["reveal", "toggle-mute"], "uppercase letter shortcuts stay usable");
  f.calls.length = 0;
  f.dispatch(" ");
  assert.deepEqual(f.calls, ["reveal", "toggle-play"], "Space on the player toggles playback once");
  f.calls.length = 0;
  f.dispatch("ArrowDown", { nodeType: 3, parentElement: new Target("button") });
  assert.deepEqual(f.calls, ["reveal", "adjacent:1"], "text-node targets resolve their containing control");
}

{
  const f = fixture({ gallery: true });
  f.dispatch("ArrowRight", new Target("button"));
  assert.deepEqual(f.calls, ["reveal", "gallery:1"], "gallery arrows move images instead of seeking video");
}

{
  const f = fixture({ settings: true });
  f.dispatch("ArrowDown", new Target("button"));
  assert.deepEqual(f.calls, [], "an open settings/share modal blocks background reel navigation");
  f.dispatch("Escape", new Target("button"));
  assert.deepEqual(f.calls, ["close-settings"], "Escape closes the modal once before the player");
  f.calls.length = 0;
  f.dispatch("Escape", new Target("button"), { isComposing: true });
  assert.deepEqual(f.calls, [], "IME Escape must not close the modal");
}

{
  const f = fixture();
  const authorPanel = new Target("section", { class: "short-video-author-panel", role: "dialog" });
  const sheet = new Target("div", { class: "short-video-author-sheet" }, authorPanel);
  const comments = new Target("section", { class: "short-video-comments" }, sheet);
  const panelButton = new Target("button", {}, comments);
  f.dispatch("ArrowDown", panelButton);
  f.dispatch("m", panelButton);
  assert.deepEqual(f.calls, [], "author/comment panels own their navigation keys");
  f.dispatch("Escape", panelButton);
  assert.deepEqual(f.calls, ["close-author-panel"], "Escape closes the actual desktop author/comment panel without exiting playback");
}

{
  const f = fixture({ search: true });
  const searchButton = new Target("button");
  f.dispatch("ArrowDown", searchButton);
  assert.deepEqual(f.calls, [], "an open search modal blocks background navigation even before focus moves");
  f.dispatch("Escape", searchButton);
  assert.deepEqual(f.calls, ["close-search"], "a bubbling search Escape must close search rather than return home");
  f.calls.length = 0;
  f.dispatch("Escape", searchButton, { defaultPrevented: true });
  assert.deepEqual(f.calls, [], "locally handled search Escape must not close twice");
}

{
  const f = fixture();
  const shareOverlay = new Target("div", { class: "short-video-more-overlay short-video-share-overlay" });
  const shareButton = new Target("button", {}, shareOverlay);
  f.dispatch("ArrowDown", shareButton);
  assert.deepEqual(f.calls, [], "share controls must not navigate the reel");
  f.dispatch("Escape", shareButton);
  assert.deepEqual(f.calls, ["close-settings"], "a bubbling share Escape uses its actual more-overlay close path");
  f.calls.length = 0;
  const unrelatedOverlayButton = new Target("button", {}, new Target("div", { class: "short-video-share-panel" }));
  f.dispatch("Escape", unrelatedOverlayButton);
  assert.deepEqual(f.calls, [], "unknown/legacy overlay targets must never fall through to return home");
}

{
  const f = fixture();
  f.state.activeView = "home";
  f.dispatch("ArrowDown", new Target("button"));
  assert.deepEqual(f.calls, [], "the inactive player must not handle keys from another view");
}

console.log("short-video keyboard verification passed");
