import assert from "node:assert/strict";
import { createShortVideoPictureInPictureController } from "../public/modules/short-videos/picture-in-picture-controller.js";
import { createShortVideoPlayerSourceLifecycle, disposeShortVideoMedia } from "../public/modules/short-videos/player-source-lifecycle.js";

// Native PiP is represented by independently settled requests and events.
// No actual browser window, service, media file or OS PiP is opened.
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
async function settle() { for (let i = 0; i < 12; i++) await Promise.resolve(); }
function fixture() {
  const requests = [], exits = [], nativeClosed = [], errors = [], changes = [];
  let currentPlayer, activation = false, exitPending = null;
  const document = { pictureInPictureEnabled: true, pictureInPictureElement: null,
    exitPictureInPicture() {
      exits.push(document.pictureInPictureElement);
      const closeCurrent = () => { nativeClosed.push(document.pictureInPictureElement); document.pictureInPictureElement = null; };
      if (exitPending) return exitPending.promise.then(closeCurrent);
      closeCurrent();
      return Promise.resolve();
    }
  };
  function player(id) {
    const classes = new Set();
    const result = { id, isConnected: true, paused: false, muted: false, pauseCalls: 0, readyState: 3,
      src: `/fixture/${id}`, dataset: { videoId: id, shortVideoSlot: "current", shortVideoSourceGeneration: "1" },
      classList: { contains: name => classes.has(name), add: name => classes.add(name) },
      getAttribute(name) { return name === "src" ? this.src : null; },
      pause() { this.pauseCalls++; this.paused = true; },
      requestPictureInPicture() {
        const request = { ...deferred(), player: result, activation };
        requests.push(request);
        return request.promise.then(() => { document.pictureInPictureElement = result; });
      }
    };
    return result;
  }
  const a = player("A"), b = player("B"), foreign = player("foreign"); currentPlayer = a;
  const controller = createShortVideoPictureInPictureController({ document, getPlayer: () => currentPlayer,
    isCurrentPlayer: candidate => candidate === currentPlayer,
    onChange: () => changes.push({ active: controller.isActive(), pending: controller.isPending(), closing: controller.isClosing() }),
    onError: error => errors.push(error) });
  const click = expected => { activation = true; const result = controller.toggle(expected); activation = false; return result; };
  return { controller, document, a, b, foreign, requests, exits, nativeClosed, errors, changes, click,
    setCurrent: player => { currentPlayer = player; }, deferExit: () => { exitPending = deferred(); return exitPending; } };
}

{
  const f = fixture();
  assert.equal(f.changes.length, 0, "construction must not call onChange before the caller assigns the controller");
  const pending = f.click();
  assert.equal(f.requests.length, 1, "native entry starts synchronously in the click stack");
  assert.equal(f.requests[0].activation, true);
  assert.equal(f.controller.isPending(), true);
  f.requests[0].resolve(); assert.equal(await pending, true);
  assert.equal(f.controller.isActive(), true); assert.equal(f.controller.isPending(), false);
  assert.equal(await f.click(), true);
  assert.equal(f.exits.length, 1); assert.equal(f.controller.isActive(), false);
}

{
  const f = fixture(), first = f.click(), second = f.click();
  assert.equal(first, second); assert.equal(f.requests.length, 1, "two clicks share one pending native request");
  f.requests[0].resolve(); assert.equal(await first, false);
  assert.equal(f.document.pictureInPictureElement, null, "second click cancels the desired entry");
  assert.deepEqual(f.exits, [f.a]);
}

{
  const f = fixture(), first = f.click(); f.click(); const third = f.click();
  assert.equal(first, third); assert.equal(f.requests.length, 1);
  f.requests[0].resolve(); assert.equal(await first, true);
  assert.equal(f.document.pictureInPictureElement, f.a, "third click restores the desired entry without another native request");
  assert.equal(f.exits.length, 0);
}

for (const kind of ["next-video", "list", "source", "source-generation", "video-id", "slot", "promotion", "detached", "ghost"]) {
  const f = fixture(), pending = f.click();
  if (kind === "next-video") f.setCurrent(f.b);
  if (kind === "list") f.setCurrent(null);
  if (kind === "source") f.a.src = "/fixture/new-source";
  if (kind === "source-generation") f.a.dataset.shortVideoSourceGeneration = "2";
  if (kind === "video-id") f.a.dataset.videoId = "B";
  if (kind === "slot") f.a.dataset.shortVideoSlot = "prev";
  if (kind === "promotion") f.a.dataset.shortVideoPromotedAt = "new-promotion";
  if (kind === "detached") f.a.isConnected = false;
  if (kind === "ghost") f.a.classList.add("is-ghost");
  f.controller.changed(); f.requests[0].resolve();
  assert.equal(await pending, false, `${kind} invalidates a pending PiP entry`);
  assert.equal(f.document.pictureInPictureElement, null);
  assert.equal(f.exits.length, 1, `${kind} closes the late old window`);
  assert.equal(f.errors.length, 0);
}

{
  const f = fixture(), pending = f.click();
  f.a.paused = true; f.a.muted = true; f.a.dataset.shortVideoPlaybackIntentGeneration = "user-paused";
  f.a.dataset.shortVideoSoundIntentGeneration = "user-muted";
  f.controller.changed(); f.requests[0].resolve();
  assert.equal(await pending, true, "pause and mute preserve the current video PiP request");
  assert.equal(f.a.pauseCalls, 0);
}

{
  const f = fixture(); f.a.paused = true;
  const pending = f.click(); f.requests[0].resolve();
  assert.equal(await pending, true, "paused media can enter PiP without being played");
  assert.equal(f.a.paused, true);
}

for (const kind of ["next-video", "list", "source-generation"]) {
  const f = fixture(), pending = f.click(); f.requests[0].resolve(); await pending;
  if (kind === "next-video") f.setCurrent(f.b);
  if (kind === "list") f.setCurrent(null);
  if (kind === "source-generation") f.a.dataset.shortVideoSourceGeneration = "new-source";
  f.controller.changed(); await settle();
  assert.equal(f.document.pictureInPictureElement, null, `${kind} closes an already active old window without a native event`);
  assert.deepEqual(f.exits, [f.a]);
  assert.equal(f.controller.isPending(), false);
  assert.deepEqual(f.errors, []);
}

{
  const f = fixture(), pending = f.click(); f.requests[0].resolve(); await pending;
  f.a.paused = true; f.a.muted = true; f.controller.changed(); await settle();
  assert.equal(f.controller.isActive(), true);
  assert.equal(f.exits.length, 0, "pause/mute alone preserve an already active window too");
  await f.controller.cancel(f.b);
  assert.equal(f.document.pictureInPictureElement, f.a, "a release hook for an unrelated player cannot close A");
}

{
  const f = fixture(); f.setCurrent(f.b);
  assert.equal(await f.click(f.a), false, "a stale settings closure cannot operate its captured old player");
  assert.equal(f.requests.length, 0);
  assert.equal(f.exits.length, 0);
}

{
  const f = fixture(), pending = f.click();
  f.setCurrent(f.b); f.controller.changed(); f.requests[0].reject(new Error("old request failed"));
  assert.equal(await pending, false); assert.deepEqual(f.errors, []);
  const current = f.click(); const error = Object.assign(new Error("not ready"), { name: "InvalidStateError" });
  f.requests[1].reject(error); assert.equal(await current, false);
  assert.deepEqual(f.errors, [error]);
}

{
  const f = fixture(), pending = f.click(); f.click();
  f.requests[0].reject(new Error("cancelled request failure")); await pending;
  assert.deepEqual(f.errors, [], "a cancelled desired entry does not show a failure");
}

{
  const f = fixture(), first = f.click();
  f.setCurrent(f.b); f.controller.changed();
  const second = f.click();
  f.requests[0].resolve(); await first;
  assert.equal(f.document.pictureInPictureElement, null);
  assert.deepEqual(f.exits, [f.a], "stale A completion closes A while B remains a pending intent");
  f.requests[1].resolve(); assert.equal(await second, true);
  assert.equal(f.document.pictureInPictureElement, f.b);
}

{
  const f = fixture(), first = f.click();
  // Settle native entry but change ownership before its promise handlers run.
  f.requests[0].resolve(); await Promise.resolve();
  f.setCurrent(f.b);
  f.document.pictureInPictureElement = f.b;
  f.controller.changed({ type: "enterpictureinpicture", target: f.b });
  await first;
  assert.equal(f.exits.includes(f.b), false, "late cleanup cannot close a newer element's PiP window");
  assert.equal(f.document.pictureInPictureElement, f.b);
}

{
  const f = fixture(), pending = f.click(); f.controller.cancel();
  f.requests[0].resolve(); await Promise.resolve();
  f.document.pictureInPictureElement = f.foreign;
  await pending;
  assert.equal(f.document.pictureInPictureElement, f.foreign, "cleanup preserves a foreign player window");
  assert.equal(f.exits.includes(f.foreign), false);
}

{
  const f = fixture(), first = f.click();
  f.setCurrent(f.b); f.controller.changed();
  const second = f.click(); f.requests[1].resolve(); await second;
  await f.controller.cancel(f.a);
  assert.equal(f.document.pictureInPictureElement, f.b, "disposing A cannot cancel a newer B window");
  assert.equal(f.controller.isActive(), true);
  f.requests[0].reject(new Error("old A settles")); await first;
  assert.equal(f.document.pictureInPictureElement, f.b);
  assert.deepEqual(f.errors, []);
}

{
  const f = fixture(), first = f.click();
  f.setCurrent(f.b); f.controller.changed(); const second = f.click();
  await f.controller.cancel(f.a);
  assert.equal(f.controller.isPending(), true, "disposing old A preserves B's pending user request");
  f.requests[0].resolve(); await first;
  f.requests[1].resolve(); assert.equal(await second, true);
  assert.equal(f.document.pictureInPictureElement, f.b);
}

{
  const f = fixture(); f.document.pictureInPictureElement = f.a;
  f.controller.changed({ type: "enterpictureinpicture", target: f.a });
  assert.equal(f.controller.isActive(), true);
  assert.equal(f.exits.length, 0, "a native-menu entry on the current video is adopted");
  f.setCurrent(f.b); f.controller.changed(); await settle();
  assert.equal(f.document.pictureInPictureElement, null, "navigation closes a native-menu window owned by the old video");
  assert.deepEqual(f.exits, [f.a]);
}

{
  const f = fixture(), pending = f.click(); await f.controller.cancel(f.a);
  f.document.pictureInPictureElement = f.a;
  f.controller.changed({ type: "enterpictureinpicture", target: f.a }); await settle();
  assert.equal(f.document.pictureInPictureElement, null, "a late cancelled native event cannot be mistaken for a new menu intent");
  f.requests[0].resolve(); await pending;
  f.document.pictureInPictureElement = f.a;
  f.controller.changed({ type: "enterpictureinpicture", target: f.a });
  assert.equal(f.controller.isActive(), true, "after the cancelled request settles, a real new native-menu intent can be adopted");
  assert.equal(f.document.pictureInPictureElement, f.a);
}

{
  const f = fixture(); f.document.pictureInPictureElement = f.foreign;
  f.controller.changed({ type: "enterpictureinpicture", target: f.foreign });
  await f.controller.cancel(f.a);
  assert.equal(f.document.pictureInPictureElement, f.foreign);
  assert.equal(f.exits.length, 0, "foreign native-menu windows are not adopted or closed");
}

{
  const f = fixture(), pending = f.click(); f.requests[0].resolve(); await pending;
  f.document.pictureInPictureElement = null;
  f.controller.changed({ type: "leavepictureinpicture", target: f.a }); await settle();
  assert.equal(f.controller.isActive(), false);
  assert.equal(f.requests.length, 1, "native close never automatically reopens a window");
  const again = f.click(); assert.equal(f.requests.length, 2);
  f.requests[1].resolve(); assert.equal(await again, true, "a later real click can reopen PiP");
}

{
  const f = fixture(), pending = f.click();
  f.document.pictureInPictureElement = f.a;
  f.controller.changed({ type: "enterpictureinpicture", target: f.a });
  f.document.pictureInPictureElement = null;
  f.controller.changed({ type: "leavepictureinpicture", target: f.a });
  f.requests[0].resolve(); await pending;
  assert.equal(f.document.pictureInPictureElement, null, "native close during a pending request cancels its late acknowledgement");
  assert.equal(f.requests.length, 1);
}

{
  const f = fixture(), pending = f.click(); f.requests[0].resolve(); await pending;
  const exit = f.deferExit(); const first = f.click(), second = f.click();
  assert.equal(f.exits.length, 1, "repeated exit clicks do not send competing native exits");
  assert.equal(f.requests.length, 1);
  exit.resolve(); await Promise.all([first, second]);
  assert.equal(f.document.pictureInPictureElement, null);
  assert.equal(f.requests.length, 1, "exit completion does not request a new window without activation");
}

for (const kind of ["navigation-cleanup", "user-exit"]) {
  const f = fixture(), entered = f.click(); f.requests[0].resolve(); await entered;
  const exit = f.deferExit();
  const pendingExit = kind === "user-exit" ? f.click() : null;
  f.setCurrent(f.b); f.controller.changed();
  assert.equal(f.controller.isClosing(), true);
  assert.equal(f.controller.isPending(), true, "document-wide native cleanup remains pending after its old owner was cancelled");
  const blocked = f.click();
  assert.equal(f.requests.length, 1, "blocked clicks must not enqueue native entry or an asynchronous reopen");
  assert.equal(await blocked, false, "a new app entry is blocked until the old global exit algorithm settles");
  exit.resolve(); if (pendingExit) await pendingExit; await settle();
  assert.equal(f.controller.isClosing(), false);
  assert.equal(f.controller.isPending(), false);
  assert.deepEqual(f.nativeClosed, [f.a], "the gated native algorithm closes the document's actual current window, which is still A");
  assert.equal(f.document.pictureInPictureElement, null);
  assert.equal(f.requests.length, 1);
  const realNewClick = f.click(); assert.equal(f.requests.length, 2);
  assert.equal(f.requests[1].activation, true, "B is requested only by a fresh user activation after cleanup");
  f.requests[1].resolve(); assert.equal(await realNewClick, true);
  assert.equal(f.document.pictureInPictureElement, f.b);
}

{
  const f = fixture(), old = f.click(), exit = f.deferExit();
  await f.controller.cancel(f.a); f.setCurrent(f.b);
  f.requests[0].resolve(); await settle();
  assert.equal(f.controller.isClosing(), true, "a late cancelled native entry also acquires the document-wide exit barrier");
  assert.equal(f.controller.isPending(), true);
  const blocked = f.click();
  assert.equal(f.requests.length, 1);
  assert.equal(await blocked, false);
  exit.resolve(); await old;
  assert.equal(f.controller.isClosing(), false);
  assert.deepEqual(f.nativeClosed, [f.a]);
  assert.equal(f.requests.length, 1, "late cleanup does not automatically request B outside a gesture");
}

{
  const f = fixture(); f.a.readyState = 0;
  assert.equal(f.controller.isSupported(), true, "API support is independent of loaded metadata");
  const error = Object.assign(new Error("metadata unavailable"), { name: "InvalidStateError" });
  f.a.requestPictureInPicture = () => { throw error; };
  assert.equal(await f.click(), false); assert.deepEqual(f.errors, [error]);
  assert.equal(f.controller.isPending(), false);
  f.document.pictureInPictureEnabled = false;
  assert.equal(f.controller.isSupported(), false); assert.equal(await f.click(), false);
}

for (const synchronous of [false, true]) {
  const f = fixture(), error = Object.assign(new Error("Picture-in-Picture is not available."), { name: "NotSupportedError" });
  let nativeCalls = 0;
  if (synchronous) f.a.requestPictureInPicture = () => { nativeCalls++; throw error; };
  const pending = f.click();
  if (!synchronous) f.requests[0].reject(error);
  assert.equal(await pending, false);
  assert.equal(f.controller.isSupported(), false, "an effective native NotSupportedError is cached for this controller");
  assert.equal(await f.click(), false);
  assert.equal(synchronous ? nativeCalls : f.requests.length, 1, "unsupported browsers do not receive repeated native requests");
  assert.deepEqual(f.errors, [error], "the first effective unsupported error is reported once");
  assert.equal(f.changes.at(-1).pending, false);
}

{
  const f = fixture(), first = f.click();
  f.requests[0].reject(Object.assign(new Error("user activation required"), { name: "NotAllowedError" }));
  await first; assert.equal(f.controller.isSupported(), true, "activation errors do not permanently disable PiP");
  const retry = f.click(); assert.equal(f.requests.length, 2);
  f.requests[1].resolve(); assert.equal(await retry, true);
  assert.equal(f.errors.length, 1);
}

{
  const f = fixture(), old = f.click();
  f.setCurrent(f.b); f.controller.changed();
  f.requests[0].reject(Object.assign(new Error("old unavailable result"), { name: "NotSupportedError" }));
  await old;
  assert.equal(f.controller.isSupported(), true, "a stale A error cannot disable a newer B context");
  assert.deepEqual(f.errors, []);
  const current = f.click(); assert.equal(f.requests.length, 2);
  f.requests[1].resolve(); assert.equal(await current, true);
}

{
  const f = fixture(), pending = f.click();
  f.requests[0].reject(Object.assign(new Error("unavailable API"), { name: "NotSupportedError" })); await pending;
  f.document.pictureInPictureEnabled = false;
  f.a.disablePictureInPicture = true;
  f.document.pictureInPictureElement = f.a;
  f.controller.changed({ type: "enterpictureinpicture", target: f.a });
  assert.equal(f.controller.isActive(), true, "a native-menu window is still tracked after entry support is disabled");
  assert.equal(f.controller.isSupported(), false);
  assert.equal(await f.click(), true, "cached unsupported status cannot prevent exiting an owned window");
  assert.equal(f.document.pictureInPictureElement, null);
  assert.deepEqual(f.exits, [f.a]);
  assert.equal(f.requests.length, 1);
  assert.equal(f.errors.length, 1);
}

{
  const f = fixture(), entered = f.click(); f.requests[0].resolve(); await entered;
  f.document.pictureInPictureEnabled = false; f.a.disablePictureInPicture = true;
  f.a.requestPictureInPicture = undefined;
  assert.equal(await f.click(), true, "exit remains available when entry APIs or element permissions change while active");
  assert.deepEqual(f.exits, [f.a]);
  assert.equal(f.document.pictureInPictureElement, null);
}

for (const pendingEntry of [false, true]) {
  const f = fixture(), pending = f.click(), hooks = [];
  if (!pendingEntry) { f.requests[0].resolve(); await pending; }
  f.a.shortVideoCancelPictureInPicture = () => {
    hooks.push({ source: f.a.src, generation: f.a.dataset.shortVideoSourceGeneration });
    return f.controller.cancel(f.a);
  };
  f.a.load = () => {};
  const lifecycle = createShortVideoPlayerSourceLifecycle({ markPerformance() {}, playbackUrl: () => "/fixture/restored", waitForFirstFrame: async () => true });
  assert.equal(lifecycle.ensureShortVideoPlayerSource(f.a, { id: "A" }, { forceReload: true }), true);
  assert.deepEqual(hooks, [{ source: "/fixture/A", generation: "1" }], "actual source restoration cancels the expected player's native owner before rebinding its source");
  assert.equal(f.a.src, "/fixture/restored");
  if (pendingEntry) { f.requests[0].resolve(); await pending; }
  await settle();
  assert.equal(f.document.pictureInPictureElement, null, "source restore closes both active and late pending PiP entries");
  assert.equal(f.exits.length, 1);
  assert.deepEqual(f.errors, []);
}

{
  const f = fixture(), old = f.click();
  f.setCurrent(f.b); f.controller.changed();
  const latest = f.click(); f.requests[1].resolve(); await latest;
  let releases = 0;
  f.a.shortVideoCancelPictureInPicture = () => { releases++; return f.controller.cancel(f.a); };
  f.a.removeAttribute = name => { if (name === "src") f.a.src = ""; };
  f.a.load = () => {};
  const root = { querySelectorAll: selector => selector === "video, audio" ? [f.a] : [] };
  disposeShortVideoMedia(root);
  assert.equal(releases, 1, "actual disposal uses the source player's scoped native cancellation hook");
  assert.equal(f.a.paused, true); assert.equal(f.a.src, "");
  assert.equal(f.document.pictureInPictureElement, f.b, "disposing the outgoing A source preserves B's active PiP");
  f.requests[0].reject(new Error("disposed A request aborted")); await old;
  assert.equal(f.document.pictureInPictureElement, f.b);
  assert.equal(f.exits.includes(f.b), false);
  assert.deepEqual(f.errors, []);
}

console.log("short-video-picture-in-picture: passed synchronous activation, desired intent, media ownership, late native completion/error, foreign-window safety and native close");
