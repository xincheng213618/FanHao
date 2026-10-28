import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createShortVideoNativeFeed } from "../android-client/www/modules/short-videos/player/native-feed.js";

const moduleUrl = new URL("../android-client/www/modules/short-videos/player/native-feed.js", import.meta.url);
const settle = () => new Promise((resolve) => setImmediate(resolve));
const snapshot = { videoId: "B", liked: false, collected: false, likes: 0, collects: 0 };
const result = { opened: true, canceled: false, serverBase: "http://one.invalid", snapshots: [snapshot] };

function fixture(factory, overrides = {}) {
  const video = { id: "B", streamUrl: "http://one.invalid/media/B", actions: { liked: true, collected: true }, stats: { likes: 4, collects: 3 } };
  const listState = { data: { videos: [video], hasMore: false }, source: "all", sort: "published" };
  const refreshed = [], invalidated = [], events = new Map();
  let activeUrl = "http://one.invalid";
  const plugin = {
    addListener(name, listener) { events.set(name, listener); return Promise.resolve({ remove() {} }); },
    async playShortFeed() { return result; },
    ...overrides
  };
  globalThis.window = { Capacitor: { Plugins: { FanHaoPlayer: plugin } } };
  const native = factory({
    listState, getActiveUrl: () => activeUrl, shortVideoApiSource: () => "all",
    refreshVideoCards: (entry) => refreshed.push(entry.id),
    invalidateShortVideoCache: async (...args) => { invalidated.push(args); },
    shortVideoToast() {}
  });
  return { video, native, events, refreshed, invalidated, setActive: (value) => { activeUrl = value; } };
}

async function verify(factory) {
  const current = fixture(factory);
  assert.equal(current.events.size, 1, "one retained result subscription per module lifetime");
  const receive = current.events.get("shortFeedRestored");
  assert.equal(typeof receive, "function", "restored Native results must have a consumer in the new WebView");
  receive(result);
  await settle();
  assert.deepEqual(current.video.actions, { liked: false, collected: false }, "restored acknowledgements preserve false values");
  assert.deepEqual(current.video.stats, { likes: 0, collects: 0 }, "acknowledged zero counts must replace old counts");
  assert.deepEqual(current.refreshed, ["B"], "both action fields refresh the visible card once");
  assert.deepEqual(current.invalidated, [["http://one.invalid", "/api/short-videos"]]);

  const changedServer = fixture(factory);
  changedServer.setActive("http://two.invalid");
  changedServer.events.get("shortFeedRestored")(result);
  await settle();
  assert.equal(changedServer.video.actions.liked, true, "old-server results must not patch the current library");
  assert.deepEqual(changedServer.refreshed, []);
  assert.deepEqual(changedServer.invalidated, [["http://one.invalid", "/api/short-videos"]], "invalidate only the result's original server");

  for (const invalid of [
    { ...result, canceled: true },
    { ...result, opened: false },
    { ...result, serverBase: "file:///private" },
    { ...result, snapshots: [snapshot, { videoId: "B", likes: -1 }] },
    { ...result, snapshots: [snapshot, { videoId: "B", liked: "false" }] },
    { ...result, snapshots: Array.from({ length: 513 }, () => snapshot) }
  ]) {
    const rejected = fixture(factory);
    rejected.events.get("shortFeedRestored")(invalid);
    await settle();
    assert.equal(rejected.video.actions.liked, true, "reject the whole invalid or canceled result before partial patching");
    assert.deepEqual(rejected.invalidated, []);
  }

  const launch = fixture(factory);
  const openedFrom = [{ ...launch.video, actions: { liked: true } }];
  assert.equal(await launch.native.openNativeShortVideoFeed(launch.video, { videos: openedFrom }), true);
  assert.equal(launch.video.actions.liked, false, "normal launches retain their action-result path");
  assert.equal(openedFrom[0].actions.liked, false, "normal launches still patch the original launch list");
  assert.deepEqual(launch.refreshed, ["B"]);

  const wrongReturn = fixture(factory, { async playShortFeed() { return { ...result, serverBase: "http://two.invalid" }; } });
  assert.equal(await wrongReturn.native.openNativeShortVideoFeed(wrongReturn.video), true);
  assert.equal(wrongReturn.video.actions.liked, true, "ordinary return data must match the launch server");
  assert.deepEqual(wrongReturn.invalidated, []);

  for (const addListener of [undefined, () => { throw new Error("bridge not ready"); }, () => Promise.reject(new Error("registration rejected"))]) {
    const unavailable = fixture(factory, { addListener });
    assert.equal(await unavailable.native.openNativeShortVideoFeed(unavailable.video), true, "listener failure must not block direct playback");
    await settle();
  }
}

const previousWindow = globalThis.window;
try {
  await verify(createShortVideoNativeFeed);
  const source = await readFile(moduleUrl, "utf8");
  const variants = [
    ["unwired restored result", "applyNativeActionResult(result, launchServerBase).catch(() => {});", "Promise.resolve().catch(() => {});"],
    ["cross-server patch", "if (normalizeServerBase(getActiveUrl()) === launchServerBase) {", "if (true) {"],
    ["partial malformed result", "const snapshots = normalizeActionSnapshots(result?.snapshots);", "const snapshots = result?.snapshots || [];"],
    ["canceled result replay", "if (result?.opened !== true || result?.canceled !== false) return;", "if (result?.opened !== true) return;"]
  ];
  for (const [name, before, after] of variants) {
    assert(source.includes(before), `negative control boundary remains present: ${name}`);
    const mutated = source.replace(before, after).replace(/from "([.][^"]+)"/g, (_, specifier) => `from "${new URL(specifier, moduleUrl).href}"`);
    const candidate = await import(`data:text/javascript;base64,${Buffer.from(mutated).toString("base64")}`);
    await assert.rejects(() => verify(candidate.createShortVideoNativeFeed), undefined, `negative control must fail: ${name}`);
  }
  console.log("short-video-restored-actions: actual new-WebView result delivery, scopes, acknowledgement validation, ordinary launches and listener failures passed; 4 negative controls rejected");
} finally {
  if (previousWindow === undefined) delete globalThis.window;
  else globalThis.window = previousWindow;
}
