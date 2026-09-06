import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { createHash } from "node:crypto";
import { createNavigationFixtureDocument } from "./fixtures/android-gallery-navigation-harness.mjs";
import { captureMediaTrail, mediaBackTarget } from "../android-client/www/js/media-navigation-state.js";
import { formatBytes, formatDate, formatNumber, formatTime } from "../android-client/www/js/format.js";
import { absoluteUrl } from "../android-client/www/js/image.js";

// Full actual Android channel module + media adapter execute. DOM, cache, HTTP,
// image loading, clocks and native bridge are controlled synthetic boundaries.
// This is legacy-server response compatibility, not a real metadata scrape,
// media reclassification, image-content inspection or device playback test.
const read = name => fs.readFileSync(new URL(`../${name}`, import.meta.url), "utf8");
const source = read("android-client/www/platform/content-index/channel-views.js");
const mediaSource = read("android-client/www/modules/media/android-module.js");
const legacyText = read("tools/fixtures/android-media-metadata-before-guard.json");
assert.equal(createHash("sha256").update(legacyText).digest("hex"), "cb2d7de19aece1413307ada8b4d832d7e66dbe4b0d8557339db0632110f706bc", "Frozen actual old-method fixture checksum");
const legacy = JSON.parse(legacyText);
assert.equal(legacy.sourceSha256, "50c1f442cd3965b24df72db9fdf77d59f2f07e9f59ecadc91086a745a5fba602", "Verified pre-guard full source snapshot identity");
const ORIGIN = "https://synthetic.invalid";
const ID = "gf_synthetic movie/3#%";
const LOCAL_TITLE = "唐顿庄园3 Downton Abbey The Grand Finale";
const BAD_TITLE = "唐顿庄园 第一季";
const WARNING = "电影资料与剧集信息不符，已显示本地信息。";
const plain = value => JSON.parse(JSON.stringify(value));
const strip = text => text.replace(/^import .*;\r?\n/gm, "").replace(/^export /gm, "");
function conflictItem({ detail = false } = {}) {
  return { id: ID, type: detail ? "media" : "movie", mediaKind: "movie", title: detail ? LOCAL_TITLE : `${BAD_TITLE} (2010)`, category: "本地电影目录",
    ext: "mkv", size: 2048, updatedAt: "2026-08-01T00:00:00Z", exists: true,
    streamUrl: `/media/gallery-video/${encodeURIComponent(ID)}`, coverUrl: `/media/movie-cover/${encodeURIComponent(ID)}`,
    year: "2010", rating: 9.4, ratingCount: 700, genres: ["剧情"], progress: { position: 73, duration: 7200 },
    movieMetadata: { mediaId: ID, movieTitle: LOCAL_TITLE, title: BAD_TITLE, year: "2010", rating: 9.4, genres: ["剧情"],
      seasonCount: null, episodeCount: null, episodeDuration: "", info: { 首播: "2010-09-26(英国)", 季数: "1", 集数: "7", 单集片长: "50分钟" } }
  };
}
function validMovie() {
  const item = conflictItem(); item.title = "合成电影 (2025)"; item.year = "2025"; item.rating = 7.6; item.genres = ["科幻"];
  item.movieMetadata = { movieTitle: "合成电影", title: "合成电影", year: "2025", rating: 7.6, genres: ["科幻"], info: { 上映日期: "2025", 片长: "123分钟" } };
  return item;
}
function listPayload(item, mode = "movie") { return { mode, total: 1, items: [item], facets: {}, offset: 0, limit: 40 }; }
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
function legacyInput() {
  let result = source;
  for (const [name, old] of Object.entries(legacy.functions)) {
    const at = new RegExp(`^${old.indent}(?:export )?(?:async )?function ${name}\\(`, "m").exec(result); assert(at, name);
    const tail = result.slice(at.index), end = new RegExp(`^${old.indent}\\}`, "m").exec(tail); assert(end, name);
    result = result.slice(0, at.index) + old.source + result.slice(at.index + end.index + old.indent.length + 1);
  }
  assert.notEqual(result, source, "Actual pre-guard methods must change the current source"); return result;
}

function harness(input = source, options = {}) {
  const document = createNavigationFixtureDocument(), proto = Object.getPrototypeOf(document.body);
  if (!Object.getOwnPropertyDescriptor(proto, "childElementCount")) Object.defineProperty(proto, "childElementCount", { get() { return this.children.length; } });
  if (!Object.getOwnPropertyDescriptor(proto, "isConnected")) Object.defineProperty(proto, "isConnected", { get() { return this.ownerDocument.body.contains(this); } });
  proto.remove = function () { if (this.parentNode) this.parentNode.children = this.parentNode.children.filter(value => value !== this); this.parentNode = null; };
  proto.prepend = function (...nodes) { const children = [...this.children]; this.replaceChildren(...nodes, ...children); };
  const els = Object.fromEntries(["viewContent", "viewTitle", "viewMeta", "viewKicker", "contentPanel"].map(key => [key, document.createElement("div")]));
  document.body.append(...Object.values(els));
  const calls = { fetch: [], images: [], bridge: [], navigation: [], cacheWrites: [], recent: [], errors: [] };
  const createElement = document.createElement;
  document.createElement = tag => {
    const node = createElement(tag), add = node.addEventListener.bind(node);
    node.addEventListener = (type, callback) => add(type, event => {
      try { const result = callback(event); result?.catch?.(error => calls.errors.push(error)); return result; }
      catch (error) { calls.errors.push(error); }
    }); return node;
  };
  const timers = new Map(), queued = [], controller = new AbortController();
  let clockId = 0, now = 0, active = true, mode = options.mode || "movie";
  const guard = () => active; guard.signal = controller.signal;
  const item = options.item || conflictItem(), detailItem = options.detailItem || conflictItem({ detail: true });
  const c = vm.createContext({ document, console, URL, URLSearchParams, AbortController, captureMediaTrail, mediaBackTarget,
    performance: { now: () => now }, window: { history: { back() {} }, addEventListener() {}, removeEventListener() {},
      setTimeout(fn, delay) { const id = ++clockId; timers.set(id, { fn, delay }); return id; }, clearTimeout(id) { timers.delete(id); },
      Capacitor: { Plugins: { FanHaoPlayer: { async play(payload) { calls.bridge.push(plain(payload)); return { opened: true }; } } } } },
    formatBytes, formatDate, formatNumber, formatTime, absoluteUrl, cacheAgeText: () => "合成缓存", photoCatalogCollections: items => items,
    isChannelFavorite: () => false, toggleChannelFavorite: () => ({ favorite: true, items: [] }), enhanceAutoLoadMore() {},
    loadPreviewImage: (node, url, imageOptions) => { calls.images.push({ node, url, options: imageOptions }); },
    readCachedJson: async () => options.cached || null, writeCachedJson: async (...args) => { calls.cacheWrites.push(plain(args)); },
    async fetchJson(base, path, request = {}) {
      calls.fetch.push({ base, path, request }); assert.equal(base, ORIGIN, "Fixture never leaves synthetic origin");
      if (queued.length) { const next = queued.shift(); if (next instanceof Error) throw next; return await next; }
      if (path.startsWith("/api/image-library/items?")) return listPayload(item, mode);
      if (path.startsWith("/api/gallery-media/")) return { item: detailItem };
      if (path.startsWith("/api/playinfo/")) return { mode: "direct", streamUrl: detailItem.streamUrl, duration: 7200 };
      throw new Error(`Unexpected fixture request: ${path}`);
    }
  });
  const exposure = /  return \{\r?\n    deactivate: resetMangaReaderProgressTracker,/;
  assert(exposure.test(input), "Exact actual factory return needed for direct-entry testing");
  const executable = input.replace(exposure, "  return {\n    __testCreateCard: createChannelCard,\n    deactivate: resetMangaReaderProgressTracker,");
  vm.runInContext(strip(executable), c, { filename: "actual-channel-views.js" });
  const host = { els, normalizeChannelMode: c.normalizeChannelMode, getActiveUrl: () => ORIGIN,
    limits: { getChannel: () => 40, increaseChannel() {} }, recent: { record: value => calls.recent.push(plain(value)) }, favorites: { onChannelFavoriteChange() {} },
    navigation: { currentView: () => "channel", currentParams: () => ({ mode }), returnToStackView: () => false,
      showView: (...args) => calls.navigation.push(plain(args)), goBack() {}, openInLibrary() {} },
    ui: { setActiveBottom() {}, scrollToTop() {}, renderCurrentView() {}, renderCurrentViewPreservingScroll() {}, refreshChrome() {}, openSearch() {} },
    contentIndex: { updateChannelQuery() {}, updateChannelParams() {}, updateSearch() {} } };
  const factory = vm.runInContext(`(function(){\n${strip(mediaSource)}\nreturn createAndroidModule;\n})()`, c), module = factory({ host });
  const result = { c, module, calls, els, document, item, detailItem,
    queue(value) { queued.push(value); }, leave() { active = false; controller.abort(); els.viewContent.replaceChildren(); },
    async settle(rounds = 40) { for (let i = 0; i < rounds; i++) { await Promise.resolve(); for (const [id, timer] of [...timers]) if (timers.delete(id)) { now += timer.delay; timer.fn(); } }
      assert.equal(calls.errors.length, 0, `Actual callback error: ${calls.errors[0]?.stack || ""}`); },
    async list(nextMode = mode) { mode = nextMode; await module.api.channelViews.renderChannel({ mode }, guard); await result.settle(); },
    async detail() { await module.api.channelViews.renderMediaDetail(detailItem.id, mode, guard); await result.settle(); },
    async play() { const button = els.viewContent.querySelector(".media-native-play-surface"); assert(button, "Actual detail play surface must exist"); button.click(); await result.settle(); }
  }; return result;
}
function assertSafeCard(h) {
  const card = h.els.viewContent.querySelector(".media-poster-card"); assert(card, "Actual list must render its movie card");
  assert.equal(card.querySelector("strong").textContent, "唐顿庄园3");
  assert.equal(card.querySelector(".media-card-meta").textContent, "资料待核对");
  assert.equal(card.querySelector(".media-poster-rating"), null); assert.equal(card.textContent.includes("2010"), false); assert.equal(card.textContent.includes(BAD_TITLE), false);
  assert(h.calls.images.length > 0); assert.equal(new URL(h.calls.images.at(-1).url).pathname, `/media/gallery-media-cover/${encodeURIComponent(ID)}`);
  return card;
}
function assertSafeDetail(h) {
  assert.equal(h.els.viewTitle.textContent, "唐顿庄园3");
  assert(h.els.viewContent.textContent.includes(WARNING), "Conflict warning is actually visible in the detail DOM");
  const facts = h.els.viewContent.querySelector(".media-player-facts"); assert(facts);
  assert.equal(facts.textContent.includes("9.4"), false); assert.equal(facts.textContent.includes("剧情"), false);
  assert.equal(h.els.viewContent.textContent.includes(BAD_TITLE), false); assert.equal(h.els.viewContent.textContent.includes("2010"), false);
  assert.equal(new URL(h.calls.images.at(-1).url).pathname, `/media/gallery-media-cover/${encodeURIComponent(ID)}`);
}
const tests = [], test = (name, run) => tests.push({ name, run });
test("info-only legacy movie/series conflict is recognized despite null structured fields", input => {
  const h = harness(input), original = conflictItem(), before = structuredClone(original);
  assert.equal(h.c.movieMetadataHasSeriesConflict(original.movieMetadata), true);
  const result = h.c.normalizeMediaMetadataItem(original);
  assert.equal(result.title, LOCAL_TITLE); assert.equal(result.movieMetadata, null); assert.equal(result.rating, null); assert.equal(result.ratingCount, null); assert.equal(result.year, ""); assert.deepEqual(plain(result.genres), []);
  assert.equal(result.metadataWarning, WARNING); assert.equal(new URL(result.coverUrl, ORIGIN).pathname, `/media/gallery-media-cover/${encodeURIComponent(ID)}`);
  for (const key of ["id", "type", "mediaKind", "streamUrl", "progress"]) assert.deepEqual(plain(result[key]), plain(original[key]));
  assert.notEqual(result, original); assert.deepEqual(original, before, "Guard must not mutate a cached/source object");
});
for (const mode of ["movie", "media"]) test(`${mode}: fresh list shows local title/frame and original detail identity`, async input => {
  const h = harness(input, { mode }); await h.list(); const card = assertSafeCard(h); card.click();
  assert.equal(h.calls.navigation.length, 1); assert.equal(h.calls.navigation[0][0], "mediaDetail"); assert.equal(h.calls.navigation[0][1].id, ID); assert.equal(h.calls.navigation[0][1].mode, "movie");
});
for (const mode of ["movie", "media"]) test(`${mode}: cached conflict is normalized before a fresh response arrives`, async input => {
  const old = listPayload(conflictItem(), mode), before = structuredClone(old), h = harness(input, { mode, cached: { payload: old, updatedAt: "synthetic" } }), pending = deferred();
  h.queue(pending.promise); const rendering = h.list(); await h.settle(); assertSafeCard(h);
  pending.resolve(listPayload(conflictItem(), mode)); await rendering; assertSafeCard(h); assert.deepEqual(old, before);
});
test("offline cached movie list never revives mismatched remote metadata", async input => {
  const h = harness(input, { cached: { payload: listPayload(conflictItem()), updatedAt: "synthetic" } }); h.queue(new Error("synthetic offline")); await h.list(); assertSafeCard(h);
});
test("fresh detail warns and uses local title/frame while native launch keeps same ID", async input => {
  const h = harness(input); await h.detail(); assertSafeDetail(h); await h.play();
  assert.equal(h.calls.bridge.length, 1); const payload = h.calls.bridge[0];
  assert.equal(payload.videoId, ID); assert.equal(payload.url, `${ORIGIN}/media/gallery-video/${encodeURIComponent(ID)}`);
  assert.equal(payload.progressUrl, `${ORIGIN}/api/progress/${encodeURIComponent(ID)}`); assert.equal(payload.position, 73); assert.equal(payload.title, "唐顿庄园3");
  assert.equal(payload.subtitle.includes("2010"), false); assert.equal(payload.subtitle.includes("剧情"), false);
});
test("cached detail warns before fresh detail then preserves corrected display", async input => {
  const cached = { item: conflictItem({ detail: true }) }, before = structuredClone(cached), h = harness(input, { cached: { payload: cached, updatedAt: "synthetic" } }), pending = deferred();
  h.queue(pending.promise); const rendering = h.detail(); await h.settle(); assertSafeDetail(h);
  pending.resolve({ item: conflictItem({ detail: true }) }); await rendering; assertSafeDetail(h); assert.deepEqual(cached, before);
});
test("valid fresh movie metadata replaces a corrected cached conflict normally", async input => {
  const h = harness(input, { cached: { payload: listPayload(conflictItem()), updatedAt: "synthetic" }, item: validMovie() }), pending = deferred();
  h.queue(pending.promise); const rendering = h.list(); await h.settle(); assertSafeCard(h); pending.resolve(listPayload(validMovie())); await rendering;
  const card = h.els.viewContent.querySelector(".media-poster-card"); assert.equal(card.querySelector("strong").textContent, "合成电影");
  assert.equal(card.querySelector(".media-poster-rating").textContent, "7.6"); assert.equal(card.querySelector(".media-card-meta").textContent, "2025 · 科幻");
});
test("movie title/year alone never establish a series conflict or reclassify the item", input => {
  const h = harness(input), item = validMovie(); item.title = "第一季的电影 2010"; item.movieMetadata.title = "第一季的电影"; item.movieMetadata.year = "2010";
  item.movieMetadata.info = { 上映日期: "2010", 片长: "123分钟" };
  assert.equal(h.c.movieMetadataHasSeriesConflict(item.movieMetadata), false);
  const next = h.c.normalizeMediaMetadataItem(item); assert(next.movieMetadata); assert.equal(next.type, "movie"); assert.equal(next.mediaKind, "movie");
  assert.equal(next.metadataWarning, undefined);
});
test("normal TV episode metadata and classification remain intact", async input => {
  const item = { id: "gt_synthetic-episode", type: "tv", mediaKind: "tv", title: "Synthetic.S01E02.mkv", category: "合成电视剧", ext: "mkv", size: 2048,
    coverUrl: "/synthetic-tv-cover.jpg", tvSeries: { title: "合成电视剧", year: "2010", rating: 9.4, episodeCount: 7 }, streamUrl: "/media/gallery-video/gt_synthetic-episode" };
  const h = harness(input, { mode: "tv", item, detailItem: item }); assert.deepEqual(plain(h.c.normalizeMediaMetadataItem(item)), item);
  await h.list(); const card = h.els.viewContent.querySelector(".media-episode-card"); assert(card); assert.equal(card.querySelector("strong").textContent, "第 2 集");
  card.click(); assert.equal(h.calls.navigation[0][1].id, item.id); assert.equal(h.calls.navigation[0][1].mode, "tv");
});
test("detail response arriving after navigation cannot restore metadata or warning on a new page", async input => {
  const h = harness(input), pending = deferred(); h.queue(pending.promise); const rendering = h.detail(); await h.settle(); h.leave(); pending.resolve({ item: conflictItem({ detail: true }) }); await rendering;
  assert.equal(h.els.viewContent.children.length, 0); assert.equal(h.calls.images.length, 0); assert.equal(h.calls.bridge.length, 0);
});
test("direct card entry normalizes its cover and caption without relying on a list wrapper", input => {
  const h = harness(input), raw = conflictItem(), before = structuredClone(raw);
  const card = h.module.api.channelViews.__testCreateCard("movie", raw, { index: 0 }); h.els.viewContent.append(card); assertSafeCard(h); assert.deepEqual(raw, before);
});
test("pure presentation agrees with DOM guard for an unnormalized legacy item", input => {
  const h = harness(input), presentation = h.c.mediaCardPresentation("movie", conflictItem());
  assert.equal(presentation.title, "唐顿庄园3"); assert.equal(presentation.meta, "资料待核对"); assert.equal(presentation.rating, ""); assert.equal(presentation.episode, false);
});
test("structured and literal-info evidence is sufficient independently", input => {
  const h = harness(input);
  for (const fields of [{ seasonCount: 1 }, { episodeCount: 7 }, { episodeDuration: "50分钟" },
    { info: { 季数: "1" } }, { info: { 集数: "7 集" } }, { info: { 单集片长: "50分钟" } },
    { subjectType: "TVSeries" }, { "@type": ["Movie", "https://schema.org/TVSeason"] }, { episodeDuration: "PT50M" }]) {
    assert.equal(h.c.movieMetadataHasSeriesConflict({ movieTitle: LOCAL_TITLE, ...fields }), true, JSON.stringify(fields));
  }
});
test("non-evidence and malformed metadata do not reject a movie", input => {
  const h = harness(input);
  for (const metadata of [null, false, [], "first season", {}, { title: BAD_TITLE, year: "2010" }, { info: { 首播: "2010" } },
    { seasonCount: 0, episodeCount: -1, episodeDuration: "未知" }, { seasonCount: true, episodeCount: "N/A" },
    { episodeCount: Infinity }, { episodeDuration: "00:00" }, { subjectType: "Movie", info: { 片长: "120分钟" } }]) {
    assert.equal(h.c.movieMetadataHasSeriesConflict(metadata), false, JSON.stringify(metadata));
  }
});
test("payload guard is pure, idempotent and limited to movie-bearing list items", input => {
  const h = harness(input), valid = validMovie(), bad = conflictItem(), tv = { ...conflictItem(), id: "gt-synthetic", type: "tv", mediaKind: "tv" };
  const payload = { mode: "media", total: 3, items: [bad, valid, tv] }, before = structuredClone(payload), next = h.c.normalizeMediaMetadataPayload(payload);
  assert.notEqual(next, payload); assert.equal(next.total, 3); assert.equal(next.items[0].movieMetadata, null);
  assert.deepEqual(plain(next.items[1]), valid); assert.deepEqual(plain(next.items[2]), tv); assert.deepEqual(payload, before);
  assert.deepEqual(plain(h.c.normalizeMediaMetadataPayload(next)), plain(next), "Already-corrected cache does not resurrect metadata");
  assert.equal(h.c.normalizeMediaMetadataPayload(payload, "tv"), payload);
});
test("Western photo and manga data are not normalized as movies", input => {
  const h = harness(input);
  for (const mode of ["western", "photo", "manga"]) {
    const item = { ...conflictItem(), type: mode, mediaKind: mode }; assert.equal(h.c.normalizeMediaMetadataItem(item, "movie"), item);
  }
});
test("list entry invokes the real payload guard in addition to card-level defenses", async input => {
  const h = harness(input), original = h.c.normalizeMediaMetadataPayload; let calls = 0;
  // Transparent observation only: the real guard still computes every returned
  // object. This wiring assertion is separate from the rendered safety checks;
  // redundant card defenses may also keep the DOM safe if this call is removed.
  h.c.normalizeMediaMetadataPayload = (...args) => { calls++; return original(...args); };
  await h.list(); assert(calls > 0, "The actual list entry must normalize its payload"); assertSafeCard(h);
});
test("count and duration formatting accepts bounded equivalents and rejects malformed or overflowing values", input => {
  const h = harness(input);
  for (const metadata of [{ info: { 集数: "共 7 集" } }, { seasonCount: "1.0" }, { episodeCount: "7.00 episodes" },
    { episodeDuration: "约 50分钟" }, { info: { 单集片长: "50秒钟" } }, { episodeDuration: "00:50:00" }]) {
    assert.equal(h.c.movieMetadataHasSeriesConflict(metadata), true, JSON.stringify(metadata));
  }
  for (const metadata of [{ episodeCount: "7.5集" }, { seasonCount: "9".repeat(400) }, { episodeDuration: `${"9".repeat(400)}分钟` },
    { episodeDuration: `PT${"9".repeat(400)}M` }, { episodeDuration: "01:99:00" }, { episodeDuration: "01:20:99" }]) {
    assert.equal(h.c.movieMetadataHasSeriesConflict(metadata), false, "Non-finite or malformed evidence must not re-label a movie");
  }
});

const mutations = [
  { name: "literal info count evidence ignored", target: "structured and literal", from: ', info["季数"], info["集数"]', to: "" },
  { name: "local title anchor ignored", target: "info-only", from: 'item.movieMetadata.movieTitle || item.title || "影片"', to: 'item.title || "影片"' },
  { name: "promoted year remains contaminated", target: "info-only", from: '    year: "",', to: "" },
  { name: "card image bypasses item normalization", target: "direct card", from: '    if (["movie", "media"].includes(mode)) item = normalizeMediaMetadataItem(item, mode);', to: "" },
  { name: "pure presentation bypasses item normalization", target: "pure presentation", from: "  item = normalizeMediaMetadataItem(item, mode);", to: "" },
  { name: "detail bypasses item normalization", target: "fresh detail", from: "    item = normalizeMediaMetadataItem(item);", to: "" },
  { name: "fresh launch resurrects old server metadata", target: "fresh detail", from: "const fresh = normalizeMediaMetadataItem(detail?.item);", to: "const fresh = detail?.item;" },
  { name: "payload guard preserves contaminated array", target: "payload guard", from: "data.items.map((item) => normalizeMediaMetadataItem(item, mode))", to: "data.items" },
  { name: "list entry loses its redundant payload guard wiring", target: "list entry", from: "    data = normalizeMediaMetadataPayload(data, mode);", to: "" }
];
let passed = 0, failed = 0, legacyRejected = 0, mutantsRejected = 0;
for (const item of tests) { try { await item.run(source); passed++; console.log(`PASS ${item.name}`); } catch (error) { failed++; console.error(`FAIL ${item.name}\n${error.stack}`); } }
if (!failed) {
  const before = legacyInput();
  for (const target of ["movie: fresh", "media: fresh", "movie: cached", "fresh detail", "cached detail"]) {
    try { let failure; try { await tests.find(item => item.name.startsWith(target)).run(before); } catch (error) { failure = error; }
      assert(failure instanceof assert.AssertionError, `Actual old method must fail display/identity assertion, not runtime setup: ${target}: ${failure?.stack || "unexpected pass"}`);
      assert.equal(failure.actual, BAD_TITLE, "Legacy control must reproduce the actual wrong title, not merely fail unrelated setup");
      legacyRejected++; console.log(`REJECT actual old ${target}`);
    } catch (error) { failed++; console.error(`FAIL old control ${target}\n${error.stack}`); }
  }
}
if (!failed) for (const mutation of mutations) {
  try {
    assert.equal(source.split(mutation.from).length - 1, 1, `One actual mutation target: ${mutation.name}`);
    const changed = source.replace(mutation.from, mutation.to); let failure;
    try { await tests.find(item => item.name.startsWith(mutation.target)).run(changed); } catch (error) { failure = error; }
    assert(failure instanceof assert.AssertionError, `Mutation must fail a declared assertion, not runtime setup: ${mutation.name}: ${failure?.stack || "unexpected pass"}`);
    mutantsRejected++; console.log(`REJECT mutant ${mutation.name}`);
  } catch (error) { failed++; console.error(`FAIL mutant ${mutation.name}\n${error.stack}`); }
}
console.log(`Media metadata: ${passed}/${tests.length} scenarios; ${legacyRejected}/5 actual old-source controls; ${mutantsRejected}/${mutations.length} safety/wiring mutants; ${failed} failures.`);
console.log(`Current channel SHA256: ${createHash("sha256").update(source).digest("hex")}`);
process.exitCode = failed ? 1 : 0;
