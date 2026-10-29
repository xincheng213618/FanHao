import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { createShortVideoCaptionController } from "../public/modules/short-videos/caption-controller.js";
import { createShortVideoCaptionText, captionTitleWithTags } from "../public/modules/short-videos/caption-text.js";
import { railButton } from "../public/modules/short-videos/icons.js";

// Execute the actual reel/author renderers and their metadata hooks. Caption
// parsing/controller and rail badge rendering are real; media and layout are
// controlled without a browser, service, database or actual media file.
class Element extends EventTarget {
  constructor(tag = "div") {
    super(); this.tagName = tag.toUpperCase(); this.nodeType = tag === "#text" ? 3 : 1;
    this.childNodes = []; this.parentElement = null; this.dataset = {}; this.attributes = new Map();
    this.className = ""; this.ownText = ""; this.scrollTop = 0; this.scrollHeight = 100; this.clientHeight = 40; this.clientWidth = 300;
    const properties = new Map();
    this.style = { setProperty: (name, value) => properties.set(name, String(value)), getPropertyValue: name => properties.get(name) || "", removeProperty: name => properties.delete(name) };
    this.classList = {
      contains: value => this.className.split(/\s+/).includes(value),
      toggle: (value, force) => {
        const set = new Set(this.className.split(/\s+/).filter(Boolean)), enabled = force ?? !set.has(value);
        if (enabled) set.add(value); else set.delete(value); this.className = [...set].join(" "); return enabled;
      },
      add: (...values) => values.forEach(value => this.classList.toggle(value, true)),
      remove: (...values) => values.forEach(value => this.classList.toggle(value, false))
    };
  }
  get children() { return this.childNodes.filter(node => node.nodeType === 1); }
  get firstChild() { return this.childNodes[0] || null; }
  get firstElementChild() { return this.children[0] || null; }
  get nextSibling() { const siblings = this.parentElement?.childNodes || []; return siblings[siblings.indexOf(this) + 1] || null; }
  get parentNode() { return this.parentElement; }
  get isConnected() { return this.connected || Boolean(this.parentElement?.isConnected); }
  get textContent() { return this.ownText + this.childNodes.map(node => node.textContent).join(""); }
  set textContent(value) { this.childNodes.forEach(node => { node.parentElement = null; }); this.childNodes = []; this.ownText = String(value); }
  get src() { return this.getAttribute("src") || ""; }
  set src(value) { this.setAttribute("src", value); }
  get currentSrc() { return this.src; }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  hasAttribute(name) { return this.attributes.has(name); }
  removeAttribute(name) { this.attributes.delete(name); }
  append(...nodes) { nodes.forEach(node => { node.remove(); node.parentElement = this; this.childNodes.push(node); }); }
  appendChild(node) { this.append(node); return node; }
  insertBefore(node, reference) { node.remove(); const index = this.childNodes.indexOf(reference); node.parentElement = this; if (index < 0) this.childNodes.push(node); else this.childNodes.splice(index, 0, node); return node; }
  replaceChildren(...nodes) { this.textContent = ""; this.append(...nodes); }
  replaceWith(node) { if (!this.parentElement) return; const parent = this.parentElement, index = parent.childNodes.indexOf(this); node.remove(); parent.childNodes[index] = node; node.parentElement = parent; this.parentElement = null; }
  remove() { if (this.parentElement) this.parentElement.childNodes = this.parentElement.childNodes.filter(node => node !== this); this.parentElement = null; }
  contains(node) { return node === this || this.childNodes.some(child => child.contains(node)); }
  matches(selector) {
    return selector.split(",").some(part => {
      const value = part.trim();
      if (value.startsWith(".")) return value.slice(1).split(".").every(name => this.classList.contains(name));
      return this.tagName.toLowerCase() === value;
    });
  }
  querySelectorAll(selector) {
    if (selector.startsWith(":scope > ")) return this.children.filter(node => node.matches(selector.slice(9)));
    return this.children.flatMap(node => [...(node.matches(selector) ? [node] : []), ...node.querySelectorAll(selector)]);
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  closest(selector) { return this.matches(selector) ? this : this.parentElement?.closest(selector) || null; }
  getBoundingClientRect() { return { left: 0, top: 0, width: this.clientWidth, height: this.clientHeight }; }
  focus() { document.activeElement = this; }
  click() { if (!this.disabled) this.dispatchEvent(new Event("click", { cancelable: true })); }
}

const page = fs.readFileSync(new URL("../public/modules/short-videos/short-video-page.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");
const actions = fs.readFileSync(new URL("../public/modules/short-videos/actions-controller.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");
function sourceFunction(source, name) {
  const match = new RegExp(`^  (?:async )?function ${name}\\(`, "m").exec(source);
  assert(match, `missing current function: ${name}`);
  return source.slice(match.index, source.indexOf("\n  }", match.index) + 4);
}
const implementation = [
  ...["renderReelPanel", "authorCaptionButton", "authorRailButton", "authorAvatar"].map(name => sourceFunction(page, name)),
  ...["applyRailActionButtonState", "railMetric"].map(name => sourceFunction(actions, name))
].join("\n");
const originalGlobals = { document: globalThis.document, window: globalThis.window, Node: globalThis.Node, getComputedStyle: globalThis.getComputedStyle };

function fixture({ canonical = null } = {}) {
  const cached = {
    id: "A", title: "Cached title", tags: ["old-topic"], width: 320, height: 240,
    streamUrl: "/fixture/A", coverUrl: "/fixture/old-cover", publishedAt: "old-date",
    author: { name: "Cached author", secUid: "author-A" },
    stats: { likes: 1, comments: 2, collects: 3, shares: 4 }, actions: { liked: false, collected: false }
  };
  const cachedSnapshot = JSON.stringify(cached), calls = [], frames = new Map(), timers = new Map();
  let sequence = 0, player;
  const win = new EventTarget();
  Object.assign(win, {
    requestAnimationFrame: callback => { const handle = ++sequence; frames.set(handle, callback); return handle; },
    cancelAnimationFrame: handle => frames.delete(handle),
    setTimeout: callback => { const handle = ++sequence; timers.set(handle, callback); return handle; },
    clearTimeout: handle => timers.delete(handle)
  });
  const doc = new EventTarget(); doc.activeElement = null;
  const create = tag => {
    const node = new Element(tag);
    if (tag === "video") {
      Object.assign(node, { currentTime: 12, paused: true, readyState: 3, volume: .5, loadCalls: 0, playCalls: 0, pauseCalls: 0 });
      node.load = () => { node.loadCalls += 1; };
      node.play = async () => { node.playCalls += 1; node.paused = false; };
      node.pause = () => { node.pauseCalls += 1; node.paused = true; };
      player = node;
    }
    return node;
  };
  doc.createElement = create;
  doc.createTextNode = text => { const node = create("#text"); node.textContent = text; return node; };
  Object.assign(globalThis, { document: doc, window: win, Node: Element, getComputedStyle: () => ({ lineHeight: "20px", fontSize: "14px", getPropertyValue: () => "2" }) });
  const state = { activeView: "shortVideos", shortVideo: { current: canonical ? { ...cached, ...canonical } : cached, muted: false, playbackRate: 1 } };
  const context = vm.createContext({
    state, Date, Promise, document: doc, window: win, createShortVideoCaptionController, captionTitleWithTags,
    appendCaptionText: createShortVideoCaptionText({ normalizeTopic: value => String(value || ""), openTopic: (video, topic) => calls.push({ kind: "topic", video, topic }) }),
    setReelPanelInteractionState() {}, isGalleryPost: () => false, takePrewarmedShortVideoPlayer: () => null,
    shortVideoPictureInPictureController: null, playbackRenditionPolicy: { preparePlayer() {} },
    shortVideoPlaybackUrl: video => video.streamUrl,
    ensureShortVideoPlayerSource(media, video, options) { media.src = options.source; media.dataset.streamUrl = options.source; media.load(); },
    currentShortVideoVolume: () => .5, normalizePlaybackRate: value => value,
    createShortVideoFirstFrameController: () => ({ check() {} }), waitForVideoFirstFrame: async () => true,
    SHORT_VIDEO_FIRST_FRAME_TIMEOUT_MS: 1600, SHORT_VIDEO_FIRST_FRAME_RETRY_LIMIT: 4,
    attachPrimaryPlayerControls(stage, media) { stage.append(media); return () => {}; },
    applyVideoOrientation() {}, markShortVideoPerformance() {}, isCurrentShortVideo: video => video.id === state.shortVideo.current.id,
    scheduleShortVideoPlaybackSettingsWarmup() {}, railButton, createIcon: () => create("span"), formatCompact: value => String(value),
    shortVideoAuthorHandle: value => `@${value || "unknown"}`, formatDate: value => value || "", initials: value => String(value).slice(0, 2),
    createAuthorFollowButton(video) {
      const button = create("button"); button.className = "short-video-follow-button";
      button.shortVideoUpdateMetadata = next => {
        calls.push({ kind: "follow-metadata", video: next });
        if (button.getAttribute("aria-busy") !== "true") button.textContent = next.author?.following ? "已关注" : "关注";
      };
      return button;
    },
    toggleShortVideoAction: (video, kind) => calls.push({ kind, video }), showHeartBurst() {},
    showAuthorPanel: (video, options) => { calls.push({ kind: "author", video, options }); return Promise.resolve(); },
    shareShortVideo: video => calls.push({ kind: "share", video }),
    showPlaybackSettings: video => calls.push({ kind: "settings", video }),
    openDouyinLink: video => calls.push({ kind: "external", video }),
    openShortVideoAuthorPage: (author, video) => calls.push({ kind: "author-page", author, video }),
    collectionsController: { showPicker: async video => { calls.push({ kind: "collection", video }); } },
    showBrowserToast() {}, showError(error) { throw error; }
  });
  vm.runInContext(`${implementation}\nglobalThis.render = renderReelPanel;`, context);
  const rendered = context.render(cached), root = create("root"); root.connected = true; root.append(rendered.panel);
  return {
    ...rendered, root, player, cached, cachedSnapshot, state, calls, frames,
    flushFrames() { const pending = [...frames.values()]; frames.clear(); pending.forEach(callback => callback(0)); },
    dispose() { rendered.panel.shortVideoDisposeCaption?.(); root.connected = false; },
    rich(extra = {}) { return {
      ...cached, title: "Hydrated full title", tags: ["new-topic"], publishedAt: "new-date",
      author: { ...cached.author, name: "Hydrated author", avatarUrl: "/fixture/avatar", following: true },
      stats: { likes: 99, comments: 88, collects: 77, shares: 66 }, actions: { liked: true, collected: true },
      actualVideo: { width: 3840, height: 2160 }, coverUrl: "/fixture/new-cover",
      sound: { title: "Hydrated sound", coverUrl: "/fixture/sound-cover" }, ...extra
    }; }
  };
}

try {
  {
    const f = fixture(); f.flushFrames();
    const panel = f.panel, stage = panel.querySelector(".short-video-stage"), player = f.player;
    const caption = panel.querySelector(".short-video-caption-copy"), paragraph = caption.querySelector("p");
    const author = panel.querySelector(".short-video-caption-author"), like = panel.querySelector(".is-like"), follow = panel.querySelector(".short-video-follow-button");
    panel.querySelector(".is-share").click();
    const record = f.calls.find(call => call.kind === "share").video;
    const identities = { author: record.author, stats: record.stats, actions: record.actions };
    assert.notEqual(record, f.cached);
    assert.notEqual(record.author, f.cached.author);
    assert.notEqual(record.stats, f.cached.stats);
    assert.notEqual(record.actions, f.cached.actions);
    const before = { src: player.src, time: player.currentTime, paused: player.paused, poster: player.poster, loads: player.loadCalls, plays: player.playCalls, pauses: player.pauseCalls };
    like.focus();
    const rich = f.rich(), inputSnapshot = JSON.stringify(rich);
    assert.equal(panel.shortVideoUpdateMetadata(rich), true);
    f.flushFrames();
    assert.equal(panel.querySelector(".short-video-stage"), stage);
    assert.equal(panel.querySelector("video"), player);
    assert.equal(panel.querySelector(".short-video-caption-copy"), caption);
    assert.equal(caption.querySelector("p"), paragraph);
    assert.equal(panel.querySelector(".short-video-caption-author"), author);
    assert.equal(panel.querySelector(".is-like"), like);
    assert.equal(panel.querySelector(".short-video-follow-button"), follow);
    assert.equal(document.activeElement, like);
    assert.deepEqual({ src: player.src, time: player.currentTime, paused: player.paused, poster: player.poster, loads: player.loadCalls, plays: player.playCalls, pauses: player.pauseCalls }, before,
      "late metadata cannot reload, seek, pause, play, replace or change the native video poster");
    assert.equal(paragraph.textContent, "Hydrated full title #new-topic");
    assert.equal(author.textContent, "@Hydrated authornew-date");
    assert.equal(panel.querySelector(".is-like").querySelector(":scope > span").textContent, "99");
    assert.equal(panel.querySelector(".is-comment").querySelector(":scope > span").textContent, "88");
    assert.equal(panel.querySelector(".is-collect").querySelector(":scope > span").textContent, "77");
    assert.equal(panel.querySelector(".is-share").querySelector(":scope > span").textContent, "66");
    assert.equal(panel.querySelector(".is-listen").querySelector(":scope > span").textContent, "原声");
    assert.equal(panel.querySelector(".short-video-backdrop-video").src, "/fixture/new-cover");
    assert.equal(panel.querySelector(".short-video-author-avatar").querySelector("img").src, "/fixture/avatar");
    panel.querySelector(".is-share").click(); panel.querySelector(".is-more").click(); panel.querySelector(".is-listen").click();
    panel.querySelector(".is-collection").click(); author.click();
    panel.querySelector(".short-video-caption-tag").click();
    for (const kind of ["share", "settings", "author", "collection", "author-page"]) {
      const call = f.calls.filter(value => value.kind === kind).at(-1);
      assert.equal(call.video, record, `${kind}: handlers keep one updated panel-local metadata record`);
      assert.equal(call.video.title, rich.title);
    }
    assert.equal(f.calls.findLast(call => call.kind === "author").options.initialTab, "sound");
    assert.equal(f.calls.findLast(call => call.kind === "author-page").author.name, "Hydrated author");
    assert.equal(f.calls.findLast(call => call.kind === "topic").topic, "new-topic");
    assert.equal(f.calls.findLast(call => call.kind === "topic").video.title, rich.title, "caption topics use their updated controller-owned record");
    assert.equal(record.author, identities.author); assert.equal(record.stats, identities.stats); assert.equal(record.actions, identities.actions);
    assert.equal(JSON.stringify(f.cached), f.cachedSnapshot, "view hydration cannot mutate the list/navigation cache's metadata");
    assert.equal(JSON.stringify(rich), inputSnapshot, "view hydration cannot mutate the incoming detail payload");
    f.dispose();
  }
  {
    const f = fixture(); f.flushFrames();
    for (const selector of [".is-like", ".is-collect", ".short-video-follow-button"]) {
      const button = f.panel.querySelector(selector); button.setAttribute("aria-busy", "true");
      const label = button.querySelector(":scope > span") || button; label.textContent = "pending-local-state";
    }
    const like = f.panel.querySelector(".is-like"); like.focus();
    f.panel.shortVideoUpdateMetadata(f.rich()); f.flushFrames();
    for (const selector of [".is-like", ".is-collect", ".short-video-follow-button"]) {
      const button = f.panel.querySelector(selector);
      assert.equal(button.getAttribute("aria-busy"), "true");
      assert.equal((button.querySelector(":scope > span") || button).textContent, "pending-local-state", "metadata cannot replace or redraw a busy local action");
    }
    assert.equal(document.activeElement, like);
    f.dispose();
  }
  {
    const f = fixture(); f.flushFrames();
    const before = f.panel.textContent;
    assert.equal(f.panel.shortVideoUpdateMetadata(f.rich({ id: "B" })), false);
    assert.equal(f.panel.textContent, before);
    f.root.connected = false;
    assert.equal(f.panel.shortVideoUpdateMetadata(f.rich()), false, "a detached reel cannot accept late metadata");
    assert.equal(f.panel.textContent, before);
    f.dispose();
  }
  {
    const f = fixture({ canonical: { title: "Canonical current title", actions: { liked: true } } }); f.flushFrames();
    assert(f.panel.querySelector("p").textContent.startsWith("Canonical current title"), "same-id canonical state takes precedence over an older card passed to the renderer");
    assert.equal(f.panel.querySelector(".is-like").getAttribute("aria-pressed"), "true");
    f.dispose();
  }
  {
    const f = fixture(); f.flushFrames();
    const container = f.panel.querySelector(".short-video-caption-copy"), paragraph = container.querySelector("p");
    const expand = container.querySelector(".short-video-caption-expand");
    assert.equal(expand.hidden, false);
    expand.click(); f.flushFrames();
    const topic = paragraph.querySelector(".short-video-caption-tag"); topic.focus(); paragraph.scrollTop = 17;
    f.panel.shortVideoUpdateMetadata(f.rich({ tags: ["old-topic"] })); f.flushFrames();
    assert.equal(container.classList.contains("is-expanded"), true, "hydration preserves the reader's expanded caption");
    assert.equal(paragraph.scrollTop, 17);
    assert.equal(paragraph.querySelector(".short-video-caption-tag"), topic);
    assert.equal(document.activeElement, topic, "a retained topic button keeps focus during metadata hydration");
    topic.click();
    assert.equal(f.calls.findLast(call => call.kind === "topic").video.title, "Hydrated full title");
    f.dispose();
  }
  {
    const f = fixture(); f.flushFrames();
    f.panel.shortVideoUpdateMetadata(f.rich());
    const avatar = f.panel.querySelector(".short-video-author-avatar"), firstImage = avatar.querySelector("img");
    f.panel.shortVideoUpdateMetadata(f.rich({ author: { name: "New avatar", secUid: "author-A", avatarUrl: "/fixture/second-avatar" } }));
    const currentImage = avatar.querySelector("img");
    assert.notEqual(currentImage, firstImage);
    firstImage.dispatchEvent(new Event("error"));
    assert.equal(avatar.querySelector("img"), currentImage, "a replaced avatar's late image error cannot remove the current avatar");
    assert.equal(currentImage.src, "/fixture/second-avatar");
    assert.equal(currentImage.alt, "New avatar");
    f.dispose();
  }
} finally {
  Object.assign(globalThis, originalGlobals);
}

console.log("short-video-reel-metadata: stable view records, live action closures, preserved player/focus and busy-state soft sync passed");
