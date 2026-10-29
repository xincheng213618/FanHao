import assert from "node:assert/strict";
import { runShortVideoRead } from "../public/modules/short-videos/read-request.js";
import fs from "node:fs";
import vm from "node:vm";
import { createShortVideoInteractionState } from "../public/modules/short-videos/interaction-state.js";
import { createShortVideoActionsController } from "../public/modules/short-videos/actions-controller.js";
import { createShortVideoMediaCache } from "../public/modules/short-videos/media-cache.js";
import { createShortVideoCollectionsController } from "../public/modules/short-videos/collections-controller.js";

// Actual mutation coordinator, actions/cache/collection modules and page
// hydration. All requests are controlled promises; no real state is changed.
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const settle = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
const video = (id = "A") => ({ id, title: "cached", ownerUserId: "author", author: { id: "author", secUid: "sec", name: "Fixture", following: false },
  actions: { liked: false, collected: false, disliked: false }, stats: { likes: 10, collects: 5, comments: 7 } });
class Element {
  constructor(tag) { this.tagName = tag; this.children = []; this.dataset = {}; this.attributes = new Map(); this.listeners = new Map(); this.className = ""; this.isConnected = true;
    this.classList = { contains: name => this.className.split(/\s+/).includes(name),
      add: (...names) => { this.className = [...new Set([...this.className.split(/\s+/).filter(Boolean), ...names])].join(" "); },
      remove: (...names) => { this.className = this.className.split(/\s+/).filter(name => !names.includes(name)).join(" "); },
      toggle: (name, active) => { this.classList[active ? "add" : "remove"](name); } };
  }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  removeAttribute(name) { this.attributes.delete(name); }
  addEventListener(name, handler) { this.listeners.set(name, handler); }
  emit(name) { return this.listeners.get(name)?.({ currentTarget: this, target: this, preventDefault() {}, stopPropagation() {} }); }
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this.children = nodes; }
  getBoundingClientRect() { return { width: 100, height: 30 }; }
  matches(selector) { return selector.split(".").filter(Boolean).every(name => this.classList.contains(name)); }
  querySelector(selector) { return selector === ":scope > span" ? this.children[0] : null; }
}
function fixture(initial = video()) {
  const shared = createShortVideoInteractionState(), requests = [], notices = [], buttons = [];
  const state = { activeView: "shortVideos", shortVideo: { current: initial, data: { videos: [structuredClone(initial)] }, collectionData: { videos: [structuredClone(initial)] }, authors: [structuredClone(initial.author)] } };
  globalThis.window = { matchMedia: () => ({ matches: true }), setTimeout: () => 1, clearTimeout() {} };
  globalThis.document = { createElement: tag => new Element(tag) };
  const actions = createShortVideoActionsController({ state, interactionState: shared, requestPanel: () => false,
    api: (url, options) => { const request = { ...deferred(), url, options }; requests.push(request); return request.promise; },
    getWorkGrid: () => ({ querySelectorAll: selector => selector === "[data-author-follow-key]"
      ? buttons.filter(button => button.dataset.authorFollowKey != null) : buttons.filter(button => button.matches(selector)) }),
    showToast: message => notices.push(message) });
  const rail = type => { const button = new Element("button"); button.className = `short-video-rail-button is-${type}`; button.dataset = { videoId: initial.id, metricValue: String(initial.stats?.[type === "like" ? "likes" : "collects"] || 0) }; button.append(new Element("span")); buttons.push(button); return button; };
  const follow = (source = initial) => { const button = actions.createAuthorFollowButton(source); buttons.push(button); return button; };
  return { shared, actions, state, requests, notices, rail, follow, buttons };
}

{
  const f = fixture(), like = f.rail("like"), collect = f.rail("collect");
  const a = f.actions.toggleShortVideoAction(f.state.shortVideo.current, "like", like);
  const b = f.actions.toggleShortVideoAction(f.state.shortVideo.current, "collect", collect);
  assert.equal(f.state.shortVideo.current.actions.liked, true); assert.equal(f.state.shortVideo.current.actions.collected, true);
  assert.equal(f.state.shortVideo.data.videos[0].actions.collected, true);
  assert.equal(f.state.shortVideo.collectionData.videos[0].actions.liked, true);
  f.requests[1].resolve({ video: { ...video(), actions: { liked: true, collected: true }, stats: { likes: 11, collects: 6, comments: 999 } } }); await b;
  f.requests[0].resolve({ video: { ...video(), actions: { liked: true, collected: false }, stats: { likes: 11, collects: 5 } } }); await a;
  assert.equal(f.state.shortVideo.current.actions.collected, true, "a like reply cannot overwrite a separately acknowledged collect");
  assert.equal(f.state.shortVideo.current.stats.collects, 6);
  assert.equal(f.state.shortVideo.current.stats.comments, 7, "mutation replies patch their own fields only");
}

{
  const f = fixture(), first = f.rail("like"), second = f.rail("like");
  const a = f.actions.toggleShortVideoAction(f.state.shortVideo.current, "like", first);
  assert.equal(second.classList.contains("is-liked"), true, "all same-key controls receive optimistic intent");
  const b = f.actions.toggleShortVideoAction(f.state.shortVideo.current, "like", second);
  assert.equal(f.requests.length, 1, "opposite intent queues behind the in-flight server write");
  assert.equal(f.state.shortVideo.current.actions.liked, false);
  f.requests[0].resolve({ video: { ...video(), actions: { liked: true }, stats: { likes: 11 } } }); await settle();
  assert.equal(f.requests.length, 2); assert.equal(f.requests[1].options.body.active, false);
  assert.equal(f.state.shortVideo.current.actions.liked, false, "the intermediate server acknowledgement cannot erase the queued intent");
  f.requests[1].resolve({ video: video() }); await Promise.all([a, b]);
  assert.equal(first.classList.contains("is-liked"), false); assert.equal(second.classList.contains("is-liked"), false);
  assert.equal(first.getAttribute("aria-busy"), null); assert.equal(f.notices.length, 1);
}

{
  const f = fixture(), stale = video();
  const first = f.actions.toggleShortVideoDislike(f.state.shortVideo.current);
  f.requests[0].resolve({ active: true }); await first;
  const undo = f.actions.toggleShortVideoDislike(stale);
  assert.equal(f.requests[1].options.body.active, false, "dislike toggles use shared latest intent rather than a stale caller's snapshot");
  f.requests[1].resolve({ active: false }); await undo;
  assert.equal(f.state.shortVideo.current.actions.disliked, false);
}

{
  const f = fixture(), a = f.rail("like"), b = f.rail("collect");
  const like = f.actions.toggleShortVideoAction(f.state.shortVideo.current, "like", a), collect = f.actions.toggleShortVideoAction(f.state.shortVideo.current, "collect", b);
  f.requests[1].resolve({ active: true, video: { ...video(), actions: { collected: true }, stats: { collects: 6 } } }); await collect;
  f.requests[0].reject(new Error("like failed")); await like;
  assert.equal(f.state.shortVideo.current.actions.liked, false); assert.equal(f.state.shortVideo.current.stats.likes, 10);
  assert.equal(f.state.shortVideo.current.actions.collected, true); assert.equal(f.state.shortVideo.current.stats.collects, 6);
}

{
  const f = fixture(), button = f.rail("like");
  const first = f.actions.toggleShortVideoAction(f.state.shortVideo.current, "like", button);
  const latest = f.actions.toggleShortVideoAction(f.state.shortVideo.current, "like", button);
  f.requests[0].reject(new Error("ambiguous server acknowledgement")); await settle();
  assert.equal(f.requests.length, 2, "a queued final value is sent even when a failed prior write might already have committed");
  assert.equal(f.requests[1].options.body.active, false);
  f.requests[1].resolve({ active: false }); await Promise.all([first, latest]);
  assert.equal(f.state.shortVideo.current.actions.liked, false);
  assert.equal(f.notices.length, 1);
}

{
  const f = fixture(), a = f.follow(), b = f.follow();
  const first = a.emit("click"); assert.equal(f.state.shortVideo.current.author.following, true);
  assert.equal(b.classList.contains("is-following"), true);
  const last = b.emit("click"); assert.equal(f.requests.length, 1);
  f.requests[0].resolve({ active: true, targetUserId: "author", secUid: "sec" }); await settle();
  assert.equal(f.requests.length, 2); assert.equal(f.requests[1].options.body.active, false);
  f.requests[1].resolve({ active: false, targetUserId: "author", secUid: "sec" }); await Promise.all([first, last]);
  assert.equal(f.state.shortVideo.current.author.following, false);
  assert.equal(f.state.shortVideo.authors[0].following, false);
  assert.equal(a.classList.contains("is-following"), false);
}

{
  const skinny = { ...video(), ownerUserId: "", author: { name: "Skinny" } }, f = fixture(skinny), button = f.follow();
  assert.equal(button.disabled, true);
  const rich = { ...skinny, author: { id: "rich-author", secUid: "rich-sec", name: "Rich", following: false } };
  assert.equal(button.shortVideoUpdateMetadata(rich), true); assert.equal(button.disabled, false);
  const pending = button.emit("click"); assert.equal(f.requests.length, 1);
  const late = { ...rich, author: { ...rich.author, following: false, signature: "new profile" } };
  button.shortVideoUpdateMetadata(late);
  assert.equal(button.classList.contains("is-following"), true, "late rich profile cannot erase pending follow intent");
  f.requests[0].resolve({ active: true, targetUserId: "rich-author", secUid: "rich-sec" }); await pending;
  assert.equal(button.getAttribute("aria-busy"), null);
}

{
  const f = fixture(), author = { id: "profile-only", name: "No local videos", following: false };
  const button = f.actions.createAuthorFollowButton({}, author, "page"); f.buttons.push(button);
  assert.equal(button.disabled, false, "an author profile needs an author key, not a local video id");
  const followed = button.emit("click"); assert.equal(author.following, true);
  assert(f.requests[0].url.endsWith("/authors/profile-only/follow"));
  f.requests[0].resolve({ active: true, targetUserId: "profile-only" }); await followed;
  assert.equal(button.textContent, "已关注");
  const unfollowed = button.emit("click"); f.requests[1].resolve({ active: false, targetUserId: "profile-only" }); await unfollowed;
  assert.equal(author.following, false); assert.equal(button.textContent, "已取关");
}

{
  const skinny = { ...video(), ownerUserId: "", author: { secUid: "sec-only", following: false } }, f = fixture(skinny), button = f.follow();
  const pending = button.emit("click");
  const rich = { ...skinny, ownerUserId: "paired-id", author: { id: "paired-id", secUid: "sec-only", following: false } };
  button.shortVideoUpdateMetadata(rich); assert.equal(button.classList.contains("is-following"), true);
  f.requests[0].resolve({ active: true, targetUserId: "paired-id", secUid: "sec-only" }); await pending;
  const paired = f.shared.mergeVideo({ id: "B", author: { id: "paired-id", following: false } }, 0);
  assert.equal(paired.author.following, true, "explicitly paired server identity preserves author intent across richer records");
}

{
  const f = fixture(), button = f.follow(), pending = button.emit("click");
  const other = { ...video(), author: { id: "other", secUid: "other-sec", following: false } };
  f.state.shortVideo.current = other; button.shortVideoUpdateMetadata(other);
  f.requests[0].resolve({ active: true, targetUserId: "author", secUid: "sec" }); await pending;
  assert.equal(other.author.following, false, "a truly different author identity is not updated by an old request");
  assert.equal(button.classList.contains("is-following"), false);
  assert.equal(button.getAttribute("aria-busy"), null);
}

{
  const f = fixture(), gate = deferred(), authorCache = new Map();
  const cache = createShortVideoMediaCache({ interactionState: f.shared, api: () => gate.promise,
    getFeedParams: () => "source=all", markPerformance() {}, cachedAuthorPanelVideo: id => authorCache.get(id), cacheAuthorPanelVideo: item => authorCache.set(item.id, item) });
  const detail = cache.fetchDetail("A"), owner = { id: "A" }, panels = [];
  const source = fs.readFileSync(new URL("../public/modules/short-videos/short-video-page.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");
  const start = source.indexOf("  async function hydratePromotedShortVideo("), implementation = source.slice(start, source.indexOf("\n  }", start) + 4);
  const env = vm.createContext({ state: f.state, shortVideoNavigationState: owner, shortVideoInteractionState: f.shared, queuedAdjacentDirection: 0, runShortVideoRead,
    contextualShortVideoDetail: () => detail, isCurrentShortVideoNavigation: candidate => candidate === owner,
    activePlayer: () => null, activeGalleryPlayer: () => null, els: { workGrid: { querySelector: () => ({ shortVideoUpdateMetadata: item => panels.push(item) }) } },
    syncActiveControlBar() {}, cacheAuthorPanelVideo: item => authorCache.set(item.id, item), collectionsController: { collectionNavigation: () => null },
    cachedShortVideo: () => null, syncCurrentNavigationDom() {}, flushQueuedAdjacent() {}, flushShortVideoAutoNext() {}, loadAdjacentVideos: async () => true,
    refreshAdjacentPanelsDom() {}, syncAuthorPanelCurrentTile() {}, showBrowserToast() {} });
  vm.runInContext(`${implementation}\nglobalThis.hydrate = hydratePromotedShortVideo;`, env);
  const hydration = env.hydrate(f.state.shortVideo.current, owner); await settle();
  const pending = f.actions.toggleShortVideoAction(f.state.shortVideo.current, "like", f.rail("like"));
  f.requests[0].resolve({ active: true, video: { ...video(), actions: { liked: true }, stats: { likes: 11 } } }); await pending;
  const following = f.follow().emit("click");
  f.requests[1].resolve({ active: true, targetUserId: "author", secUid: "sec" }); await following;
  gate.resolve({ video: { ...video(), title: "richer title" }, prevId: "", nextId: "" }); await hydration;
  assert.equal(f.state.shortVideo.current.actions.liked, true, "actual late hydration preserves the acknowledged mutation");
  assert.equal(f.state.shortVideo.current.title, "richer title");
  assert.equal(f.state.shortVideo.current.author.following, true, "late detail also preserves author-level following intent");
  assert.equal(cache.cachedVideo("A").actions.liked, true); assert.equal(cache.resolvedDetail("A").video.actions.liked, true);
  assert.equal(authorCache.get("A").actions.liked, true);
  assert.equal(panels.at(-1).actions.liked, true, "soft reel metadata receives protected interaction fields");
  assert.equal(cache.fetchDetail("A"), detail, "cached promise reuse retains the original read provenance");
}

{
  const f = fixture(), gate = deferred();
  const collections = createShortVideoCollectionsController({ state: f.state, interactionState: f.shared, api: () => gate.promise });
  f.state.shortVideo.collectionId = "fixture-collection";
  const read = collections.loadCollectionVideoDetail("A");
  const pending = f.actions.toggleShortVideoAction(f.state.shortVideo.current, "collect", f.rail("collect"));
  f.requests[0].resolve({ active: true }); await pending;
  gate.resolve({ video: video() }); const detail = await read;
  assert.equal(f.shared.mergeVideo(detail.video).actions.collected, true, "collection detail records provenance before its actual GET too");
}

{
  const f = fixture(), pending = f.actions.toggleShortVideoAction(f.state.shortVideo.current, "like", f.rail("like"));
  const duringPending = f.shared.captureRead();
  f.requests[0].resolve({ active: true }); await pending;
  assert.equal(f.shared.mergeVideo(video(), duringPending).actions.liked, true, "GETs started while a PUT was pending remain older than its acknowledgement");
  const fresh = f.shared.captureRead();
  const validated = f.shared.mergeVideo(video(), fresh);
  assert.equal(validated.actions.liked, false, "a genuinely fresh server read can revalidate completed intent");
  assert.equal(f.shared.mergeVideo(video(), 0).actions.liked, false, "old caches inherit the newer verified state rather than resurrecting the old mutation");
}

{
  const f = fixture(), reads = [];
  const cache = createShortVideoMediaCache({ interactionState: f.shared, api: () => { const request = deferred(); reads.push(request); return request.promise; },
    getFeedParams: () => "scope=old", markPerformance() {}, cachedAuthorPanelVideo: () => null });
  const original = cache.fetchDetail("A"); reads[0].resolve({ video: video(), prevId: "", nextId: "" });
  const old = await original;
  const mutation = f.actions.toggleShortVideoAction(f.state.shortVideo.current, "like", f.rail("like")); f.requests[0].resolve({ active: true }); await mutation;
  const reused = cache.fetchDetail("A"); assert.equal(reused, original);
  assert.equal((await reused).video.actions.liked, true, "reusing a resolved promise reapplies local intent using its original read epoch");
  assert.equal(reads.length, 1);
  const fresh = cache.fetchDetail("A", "scope=fresh"); reads[1].resolve({ video: video(), prevId: "", nextId: "" });
  assert.equal((await fresh).video.actions.liked, false, "an actual later cache GET can revalidate the completed mutation");
  assert.equal(f.shared.mergeVideo(old.video).actions.liked, false, "older retained cache references see the newer verified state");
}

{
  const f = fixture(), pending = f.actions.toggleShortVideoAction(f.state.shortVideo.current, "like", f.rail("like"));
  f.requests[0].resolve({ active: true }); await pending;
  const skinny = f.shared.mergeVideo({ id: "A", title: "partial" }, f.shared.captureRead());
  assert.equal(skinny.actions.liked, true, "omitted fields are not authoritative false values");
  assert.equal(skinny.stats.likes, 11);
}

{
  const state = createShortVideoInteractionState({ completedLimit: 3 });
  for (let i = 0; i < 12; i++) await state.mutateVideo(video(String(i)), "like", true, { send: async () => ({ active: true }) });
  assert.equal(state.stats().pending, 0); assert.equal(state.stats().entries, 3, "completed mutation history is bounded independently of media caches");
}

for (const newerFirst of [false, true]) {
  for (const newestValue of [false, true]) {
    const shared = createShortVideoInteractionState(), reads = [];
    await shared.mutateVideo(video(), "like", true, { send: async () => ({ active: true, video: { ...video(), actions: { liked: true }, stats: { likes: 11 } } }) });
    const cache = createShortVideoMediaCache({ interactionState: shared, api: () => { const request = deferred(); reads.push(request); return request.promise; },
      getFeedParams: () => "", markPerformance() {}, cachedAuthorPanelVideo: () => null });
    const older = cache.fetchDetail("A", "scope=older"), newer = cache.fetchDetail("A", "scope=newer");
    const payload = active => ({ video: { ...video(), actions: { liked: active }, stats: { likes: active ? 11 : 10 } }, prevId: "", nextId: "" });
    if (newerFirst) { reads[1].resolve(payload(newestValue)); await newer; reads[0].resolve(payload(!newestValue)); }
    else { reads[0].resolve(payload(!newestValue)); await older; reads[1].resolve(payload(newestValue)); }
    await Promise.all([older, newer]);
    assert.equal(shared.videoState(video(), "like").active, newestValue, "request start order fences both changed and unchanged GET validation");
    assert.equal(cache.resolvedDetail("A", "scope=newer").video.actions.liked, newestValue);
    assert.equal((await cache.fetchDetail("A", "scope=older")).video.actions.liked, newestValue, "reusing the older cached response cannot make it fresh");
    assert.equal(reads.length, 2);
  }
}

for (const discovery of ["detail", "response"]) {
  for (const newerFirst of [false, true]) {
    const shared = createShortVideoInteractionState(), writes = [], changes = [];
    const byId = { id: "id-video", author: { id: "user", following: false } };
    const bySec = { id: "sec-video", author: { secUid: "sec-only", following: true } };
    const send = alias => active => { const request = { ...deferred(), alias, active }; writes.push(request); return request.promise; };
    const older = shared.mutateFollow(byId, byId.author, true, { send: send("id"), onChange: value => changes.push(value.active) });
    const newer = shared.mutateFollow(bySec, bySec.author, false, { send: send("sec"), onChange: value => changes.push(value.active) });
    assert.equal(writes.length, 2, "unpaired identities can initially have independent in-flight writes");
    if (discovery === "detail") {
      const paired = shared.mergeVideo({ id: "paired", author: { id: "user", secUid: "sec-only", following: false } }, 0);
      assert.equal(paired.author.following, false);
      assert.equal(shared.followState(byId).active, false, "pairing picks the latest intent, regardless of which identity was selected first");
      assert.equal(shared.stats().pending, 1, "explicit pairing unifies pending records as well as aliases");
      assert.equal(changes.at(-1), false);
    }
    const respond = index => writes[index].resolve({ active: writes[index].active, targetUserId: "user", secUid: "sec-only" });
    respond(newerFirst ? 1 : 0); await settle();
    assert.equal(writes.length, 2, "merged in-flight writes form a barrier before the final reconciliation PUT");
    assert.equal(shared.followState(byId).active, false);
    respond(newerFirst ? 0 : 1); await settle();
    assert.equal(writes.length, 3, "once both old writes settle, the latest desired value is written last");
    assert.equal(writes[2].active, false); assert.equal(writes[2].alias, "sec");
    respond(2); const results = await Promise.all([older, newer]);
    assert.equal(results[0].superseded, true); assert.equal(results[1].superseded, false);
    assert.equal(shared.followState(byId).active, false); assert.equal(shared.followState(bySec).active, false);
    assert.equal(shared.stats().pending, 0); assert.equal(shared.stats().entries, 1);
  }
}

{
  const shared = createShortVideoInteractionState(), writes = [];
  const id = { id: "A", author: { id: "user", following: false } }, sec = { id: "B", author: { secUid: "sec", following: true } };
  const send = active => { const request = { ...deferred(), active }; writes.push(request); return request.promise; };
  const first = shared.mutateFollow(id, id.author, true, { send });
  const second = shared.mutateFollow(sec, sec.author, false, { send });
  shared.mergeVideo({ id: "C", author: { id: "user", secUid: "sec" } }, 0);
  const last = shared.mutateFollow(id, id.author, true, { send });
  assert.equal(writes.length, 2, "new intent during the merged barrier does not race either existing server write");
  writes[1].resolve({ active: false }); await settle(); writes[0].resolve({ active: true }); await settle();
  assert.equal(writes.length, 3); assert.equal(writes[2].active, true);
  writes[2].resolve({ active: true }); await Promise.all([first, second, last]);
  assert.equal(shared.followState(sec).active, true);
}

{
  const shared = createShortVideoInteractionState(), a = deferred(), b = deferred();
  const id = { id: "A", author: { id: "one", name: "Same name", following: false } };
  const sec = { id: "B", author: { secUid: "other-sec", name: "Same name", following: true } };
  const first = shared.mutateFollow(id, id.author, true, { send: () => a.promise });
  const second = shared.mutateFollow(sec, sec.author, false, { send: () => b.promise });
  shared.mergeVideo({ id: "C", author: { id: "one", secUid: "one-sec", name: "Same name" } }, 0);
  assert.equal(shared.stats().pending, 2, "matching names without a paired identity do not merge author operations");
  a.resolve({ active: true, targetUserId: "one", secUid: "one-sec" }); b.resolve({ active: false, secUid: "other-sec" });
  await Promise.all([first, second]);
  assert.equal(shared.followState(id).active, true); assert.equal(shared.followState(sec).active, false);
}

console.log("short-video-interaction-state: passed actual actions/cache/hydration races, field isolation, serial final intent, optimistic clones, follow rebinding, read provenance, rollback and bounded history");
