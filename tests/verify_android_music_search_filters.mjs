import assert from "node:assert/strict";
import fs from "node:fs";
import { createNavigationFixtureDocument } from "./fixtures/android-gallery-navigation-harness.mjs";

// Exercise the complete music factory, its actual filter controls/request
// builder and API boundary. Only DOM, clocks, storage, Audio and HTTP responses
// are controlled; no browser, media, database or service is accessed.
const sourceUrl = new URL("../android-client/www/modules/music/music-views.js", import.meta.url);
const source = fs.readFileSync(sourceUrl, "utf8").replace(/\r\n/g, "\n");
const originals = Object.fromEntries(["window", "document", "localStorage", "fetch", "__musicFilterFixture"].map(key => [key, globalThis[key]]));
const settle = async () => { for (let i = 0; i < 80; i++) await Promise.resolve(); };
const plain = value => JSON.parse(JSON.stringify(value));
let cases = 0, selectedCase = "", fixtures = 0;

async function importFactory(code = source) {
  const hook = "  installLifecycle();";
  assert.equal(code.split(hook).length, 2);
  const instrumented = code.replace(hook, `
  globalThis.__musicFilterFixture = { state, renderShell, activate() { moduleActive = true; },
    setAudio(value) { audio = value; }, getAudio() { return audio; } };
  installLifecycle();`);
  const imports = instrumented.replace(/from "(\.\.?\/[^\"]+)"/g,
    (_all, relative) => `from ${JSON.stringify(new URL(relative, sourceUrl).href)}`);
  return (await import(`data:text/javascript;base64,${Buffer.from(imports).toString("base64")}`)).createMusicViews;
}

function fixture(createMusicViews, overrides = {}) {
  const document = globalThis.document = createNavigationFixtureDocument();
  const proto = Object.getPrototypeOf(document.body);
  if (!Object.getOwnPropertyDescriptor(proto, "isConnected")) {
    Object.defineProperty(proto, "isConnected", { get() { return this.ownerDocument.body.contains(this); } });
    Object.defineProperty(proto, "childNodes", { get() { return this.children; } });
    proto.blur = function() { if (this.ownerDocument.activeElement === this) this.ownerDocument.activeElement = null; };
    const query = proto.querySelectorAll;
    proto.querySelectorAll = function(selector) {
      const parts = selector.trim().split(/\s+/);
      if (parts.length < 2 || selector.startsWith(":scope")) return query.call(this, selector);
      return query.call(this, parts.at(-1)).filter(node => {
        let ancestor = node.parentNode;
        for (let i = parts.length - 2; i >= 0; i--) {
          while (ancestor && ancestor !== this.parentNode && !ancestor.matches?.(parts[i])) ancestor = ancestor.parentNode;
          if (!ancestor || ancestor === this.parentNode) return false;
          ancestor = ancestor.parentNode;
        }
        return true;
      });
    };
  }
  document.querySelector = selector => document.body.querySelector(selector);
  document.querySelectorAll = selector => document.body.querySelectorAll(selector);
  document.createTextNode = text => { const node = document.createElement("span"); node.textContent = text; return node; };
  const requests = [], routeUpdates = [], storage = new Map(), clocks = new Map();
  const base = `http://music-filters-${++fixtures}.fixture.invalid:29998`;
  const tracks = [
    { id: "favorite-moon", title: "月光一", artist: "合成歌手", album: "合成专辑", favorite: true, rating: 5, hasLyrics: true, format: "flac", durationMs: 120000 },
    { id: "ordinary-moon", title: "月光二", artist: "合成歌手", album: "合成专辑", favorite: false, rating: 3, hasLyrics: false, format: "mp3", durationMs: 120000 },
    { id: "unrated-moon", title: "月光三", artist: "合成歌手", album: "合成专辑", favorite: false, rating: 0, hasLyrics: true, format: "mp3", durationMs: 120000 }
  ];
  const artists = [{ id: "artist", name: "合成歌手", trackCount: 3 }], albums = [{ id: "album", title: "合成专辑", trackCount: 3 }];
  const matches = [{ track: tracks[0], timeMs: 0, text: "合成月光歌词" }];
  const filterTracks = params => tracks.filter(track => (!params.get("favorite") || track.favorite)
    && (!params.get("lyrics") || track.hasLyrics) && track.rating >= Number(params.get("minRating") || 0)
    && (!params.get("quality") || track.format === "flac"));
  globalThis.fetch = async (url, options = {}) => {
    const parsed = new URL(url); assert.equal(parsed.origin, base, "only synthetic fixture HTTP is allowed");
    assert.equal(options.method || "GET", "GET", "filter actions only read the library");
    requests.push(parsed);
    let payload;
    if (parsed.pathname === "/api/music/tracks") { const selected = filterTracks(parsed.searchParams);
      payload = { tracks: selected, total: selected.length, query: parsed.searchParams.get("q"), hasMore: false }; }
    else if (parsed.pathname === "/api/music/artists") payload = { artists, total: artists.length };
    else if (parsed.pathname === "/api/music/albums") payload = { albums, total: albums.length };
    else if (parsed.pathname === "/api/music/lyrics/search") payload = { matches, total: 1, limit: Number(parsed.searchParams.get("limit")), hasMore: false };
    else throw new Error(`Unexpected synthetic API: ${parsed.pathname}`);
    return { ok: true, status: 200, headers: { get: () => null }, json: async () => payload };
  };
  let clockId = 0;
  globalThis.window = { addEventListener() {}, setTimeout(fn) { const id = ++clockId; clocks.set(id, fn); return id; },
    clearTimeout(id) { clocks.delete(id); }, requestAnimationFrame() { return ++clockId; }, cancelAnimationFrame() {},
    setInterval() { return ++clockId; }, clearInterval() {}, scrollY: 0, scrollTo() {}, fetch: globalThis.fetch };
  globalThis.localStorage = { getItem: key => storage.get(key) || null, setItem: (key, value) => storage.set(key, String(value)),
    removeItem: key => storage.delete(key) };
  const els = { viewContent: document.createElement("main"), viewTitle: {}, viewKicker: {}, viewMeta: {} };
  document.body.append(els.viewContent);
  createMusicViews({ els, getActiveUrl: () => base, showView() { throw new Error("Search filtering must not navigate away"); },
    replaceViewParams: (...args) => routeUpdates.push(plain(args)), setActiveBottom() {} });
  const audit = globalThis.__musicFilterFixture; audit.activate();
  const queue = [tracks[0], tracks[1]], audio = { paused: false, currentTime: 37.5, duration: 120, src: "fixture:playing",
    pause() { throw new Error("Filtering must not pause playback"); }, play() { throw new Error("Filtering must not restart playback"); },
    load() { throw new Error("Filtering must not reload audio"); } };
  Object.assign(audit.state, { mode: "library", dashboard: false, searchOpen: true, query: "月光", searchScope: "songs",
    current: tracks[0], playing: true, queue, gapless: false, crossfadeSeconds: 0,
    playlists: [{ id: "playlist", name: "月光歌单", trackCount: 3 }], ...overrides });
  const params = new URLSearchParams();
  if (audit.state.searchFavorite) params.set("favorite", "1");
  if (audit.state.searchLyrics) params.set("lyrics", "1");
  if (audit.state.searchMinRating) params.set("minRating", String(audit.state.searchMinRating));
  if (audit.state.searchQuality) params.set("quality", audit.state.searchQuality);
  const selected = filterTracks(params);
  audit.state.data = { tracks: selected, rawTracks: selected, rawLoaded: selected.length, total: selected.length, hasMore: false, artists, albums };
  Object.assign(audit.state.lyricSearch, { matches, total: 1, limit: 4, loading: false });
  Object.assign(audit.state.searchOverview, { artists, albums, artistTotal: 1, albumTotal: 1, loading: false });
  audit.setAudio(audio); audit.renderShell();
  return { document, els, audit, state: audit.state, tracks, queue, audio, requests, routeUpdates,
    notice: () => document.querySelector(".music-mobile-search-filter-notice"),
    async scope(label) { const button = document.querySelector(".music-mobile-search-scopes").querySelectorAll("button").find(item => item.textContent === label);
      assert(button, `actual scope ${label} is mounted`); button.click(); await settle(); },
    async filter(label) { const menu = document.querySelector(".music-mobile-search-filter-menu"); assert(menu); menu.open = true;
      const button = menu.querySelectorAll("button").find(item => item.textContent === label); assert(button); button.click(); await settle(); }
  };
}

async function assertScopeNotice(createMusicViews) {
  const f = fixture(createMusicViews); await f.filter("已收藏");
  assert.equal(f.state.data.tracks.length, 1); assert.equal(f.state.searchFavorite, true);
  await f.scope("综合");
  assert(f.notice(), "a retained song filter must be visible in comprehensive search");
  assert.equal(f.notice().querySelector("span").textContent, "歌曲筛选：已收藏");
  assert.equal(f.state.searchFavorite, true); assert.equal(f.state.searchScope, "all");
  assert.equal(f.routeUpdates.at(-1)[1].searchFavorite, "1");
  const summary = f.document.querySelector(".music-mobile-search-summary-region");
  assert.equal(summary.children[0].className, "music-mobile-search-scopes"); assert.equal(summary.children[1], f.notice());
  assert.equal(summary.querySelector(".music-mobile-sort"), null, "comprehensive search does not gain a global sorting control");
}

async function check(name, run) { selectedCase = name; await run(); cases++; }

try {
  const createMusicViews = await importFactory();
  await check("switching songs to comprehensive preserves filters and makes their scope visible", () => assertScopeNotice(createMusicViews));
  const four = { searchFavorite: true, searchLyrics: true, searchMinRating: 4, searchQuality: "lossless" };
  await check("all four conditions share labels and active state with the existing song menu", async () => {
    const f = fixture(createMusicViews, { ...four, searchScope: "all" });
    assert.equal(f.notice().querySelector("span").textContent, "歌曲筛选：已收藏 · 有歌词 · 4 分以上 · 无损");
    await f.scope("歌曲"); assert.equal(f.notice(), null);
    const menu = f.document.querySelector(".music-mobile-search-filter-menu");
    assert.equal(menu.querySelector("summary").textContent, "筛选 4");
    assert.deepEqual(menu.querySelectorAll("button").filter(button => button.getAttribute("aria-pressed") === "true").map(button => button.textContent),
      ["已收藏", "有歌词", "4 分以上", "无损"]);
  });
  await check("clear reloads unfiltered songs while retaining query, scope, focus and current playback", async () => {
    const f = fixture(createMusicViews, { ...four, searchScope: "all" }), current = f.state.current;
    const input = f.document.querySelector(".music-mobile-search-input"); input.focus();
    const clear = f.notice().querySelector("button"); assert.equal(clear.getAttribute("aria-label"), "清除歌曲筛选");
    clear.click(); await settle();
    assert.equal(f.notice(), null); assert.equal(f.state.query, "月光"); assert.equal(f.state.searchScope, "all");
    assert.deepEqual([f.state.searchFavorite, f.state.searchLyrics, f.state.searchMinRating, f.state.searchQuality], [false, false, 0, ""]);
    const reads = f.requests.filter(url => url.pathname === "/api/music/tracks"); assert.equal(reads.length, 1);
    assert.equal(reads[0].searchParams.get("q"), "月光");
    for (const field of ["favorite", "lyrics", "minRating", "quality"]) assert.equal(reads[0].searchParams.has(field), false, `clear removes ${field} from the actual request`);
    assert.equal(f.state.data.tracks.length, 3, "the actual request response restores the unfiltered song set");
    assert.equal(f.state.current, current); assert.equal(f.state.queue, f.queue); assert.equal(f.state.playing, true);
    assert.equal(f.audit.getAudio(), f.audio); assert.equal(f.audio.currentTime, 37.5); assert.equal(f.audio.src, "fixture:playing");
    assert.equal(f.document.querySelector(".music-mobile-search-input"), input); assert.equal(f.document.activeElement, input);
    const params = f.routeUpdates.at(-1)[1]; assert.equal(params.query, "月光");
    for (const key of ["searchFavorite", "searchLyrics", "searchMinRating", "searchQuality"]) assert.equal(params[key], undefined);
  });
  await check("a single rating condition only names its active filter", async () => {
    const f = fixture(createMusicViews, { searchScope: "all", searchMinRating: 4 });
    assert.equal(f.notice().querySelector("span").textContent, "歌曲筛选：4 分以上");
  });
  await check("default, blank query and other search scopes do not show the comprehensive notice", async () => {
    for (const options of [{ searchScope: "all" }, { ...four, searchScope: "all", query: "" },
      ...["songs", "lyrics", "playlists"].map(searchScope => ({ ...four, searchScope })),
      ...["artists", "albums"].map(mode => ({ ...four, mode, searchScope: mode }))]) {
      const f = fixture(createMusicViews, options); assert.equal(f.notice(), null);
    }
  });
  await check("negative control: the old summary omits retained filters in comprehensive search", async () => {
    const mutant = source.replace("      region.append(renderSearchFilterNotice());", "      /* previous comprehensive summary hid its filters */");
    assert.notEqual(mutant, source); const createMutant = await importFactory(mutant);
    await assert.rejects(() => assertScopeNotice(createMutant), /retained song filter must be visible/);
  });
  console.log(`Android music search filter verification passed (${cases} scenarios, including 1 negative control; ${fixtures} controlled full-factory fixtures).`);
} catch (error) {
  console.error(`${selectedCase || "fixture setup"}: ${error.name}: ${error.message}`); process.exitCode = 1;
} finally {
  for (const [key, value] of Object.entries(originals)) { if (value === undefined) delete globalThis[key]; else globalThis[key] = value; }
}
