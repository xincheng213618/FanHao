import assert from "node:assert/strict";
import test from "node:test";
import { createMusicPlayer } from "../public/modules/music/player/engine.js";
import { createMusicPage } from "../public/modules/music/music-page.js";

// Real client modules with controlled media/DOM surfaces only. No HTTP, database,
// media file, browser profile, or running music service is used by this fixture.
function createFixture(t, { page = false } = {}) {
  const originals = new Map(["Audio", "window", "document"].map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  t.after(() => {
    for (const [name, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
  });
  const attempts = [];
  const errors = [];
  const timers = new Map();
  const events = { play: 0, pause: 0 };
  let nextTimer = 1;
  class ControlledAudio {
    constructor() {
      this.src = "";
      this.paused = true;
      this.currentTime = 0;
      this.duration = 180;
      this.listeners = new Map();
      this.loads = 0;
    }
    addEventListener(name, callback) {
      const listeners = this.listeners.get(name) || [];
      listeners.push(callback);
      this.listeners.set(name, listeners);
    }
    emit(name) {
      for (const callback of this.listeners.get(name) || []) callback();
    }
    load() {
      this.loads += 1;
      this.paused = true;
    }
    play() {
      this.paused = false;
      return new Promise((resolve, reject) => attempts.push({ source: this.src, resolve, reject }));
    }
    pause() {
      this.paused = true;
      this.emit("pause");
    }
    removeAttribute(name) {
      if (name === "src") this.src = "";
    }
  }
  globalThis.Audio = ControlledAudio;
  globalThis.window = {
    location: { href: "http://music-fixture.invalid/music/library" },
    localStorage: { getItem() { return null; }, setItem() {} },
    addEventListener() {},
    requestAnimationFrame() { return 0; },
    cancelAnimationFrame() {},
    setTimeout(callback) { const id = nextTimer++; timers.set(id, callback); return id; },
    setInterval(callback) { const id = nextTimer++; timers.set(id, callback); return id; },
    clearTimeout(id) { timers.delete(id); },
    clearInterval(id) { timers.delete(id); }
  };
  globalThis.document = {
    hidden: false,
    querySelector() { return null; },
    addEventListener() {},
    body: { classList: { toggle() {} } }
  };
  const state = { activeView: "music", music: { current: null, playbackSpeed: 1, playing: false, playbackError: "", data: { tracks: [] } } };
  const player = createMusicPlayer({
    getState: () => state,
    callbacks: {
      onError(message) { state.music.playbackError = message; errors.push(message); },
      onPlay() { events.play += 1; state.music.playbackError = ""; },
      onPause() { events.pause += 1; }
    }
  });
  const fixture = {
    state, player, attempts, errors, timers, events,
    get audio() { return player.getAudio(); },
    load(id, autoplay = true, streamUrl = `/fixture/${id}.mp3`) {
      const track = { id, title: id, streamUrl, durationMs: 180000 };
      state.music.current = track;
      player.load(track, autoplay);
      return track;
    }
  };
  if (page) {
    fixture.page = createMusicPage({
      state, els: {}, formatNumber: String, formatBytes: String,
      api: async (path) => {
        const match = path.match(/^\/api\/music\/tracks\/([^?]+)\?/);
        assert(match, `unexpected fixture API: ${path}`);
        const id = match[1];
        return { track: { id, title: id, streamUrl: `/fixture/${id}.mp3`, durationMs: 180000 }, lyrics: { lines: [{ text: id }] } };
      },
      pushRoute() {}, replaceRoute() {}, hidePersonProfile() {},
      disconnectPeopleIndexAutoload() {}, cancelScheduledWorkRendering() {},
      resetProgressiveCoverLoading() {}, setMainHeader() {}, syncRouteAfterNavigation() {}
    });
  }
  return fixture;
}

const settle = () => new Promise(resolve => setImmediate(resolve));
const interrupted = () => new DOMException("The play() request was interrupted by a new load request.", "AbortError");

test("a cancelled autoplay cannot leave its error on a new paused route track", async t => {
  const fixture = createFixture(t, { page: true });
  await fixture.page.openTrack("A", { autoplay: true });
  fixture.page.applyRouteState({ musicTrackId: "B", musicMode: "library" });
  await fixture.page.openRouteTarget({ musicTrackId: "B" });
  assert.equal(fixture.state.music.current.id, "B");
  assert.equal(fixture.state.music.trackPageOpen, true);
  assert.equal(fixture.attempts.length, 1, "route restoration must preserve autoplay=false");
  fixture.attempts[0].reject(interrupted());
  await settle();
  assert.equal(fixture.state.music.playbackError, "", "the actual page error state must belong to B");
  assert.equal(fixture.state.music.playing, false);
});

test("late old autoplay failure cannot overwrite a newer successful play", async t => {
  const fixture = createFixture(t);
  fixture.load("A");
  fixture.load("B");
  fixture.audio.emit("play");
  fixture.attempts[1].resolve();
  await settle();
  const errors = [...fixture.errors];
  fixture.attempts[0].reject(interrupted());
  await settle();
  assert.deepEqual(fixture.errors, errors);
  assert.equal(fixture.state.music.current.id, "B");
  assert.equal(fixture.state.music.playing, true);
  assert.equal(fixture.state.music.playbackError, "");
});

test("late old autoplay success cannot restart or rewrite a new paused track", async t => {
  const fixture = createFixture(t);
  fixture.load("A");
  fixture.load("B", false);
  const errors = [...fixture.errors];
  fixture.attempts[0].resolve();
  await settle();
  assert.equal(fixture.audio.paused, true);
  assert.equal(fixture.state.music.playing, false);
  assert.equal(fixture.state.music.current.id, "B");
  assert.deepEqual(fixture.errors, errors);
  assert.equal(fixture.attempts.length, 1);
});

test("a new load owns playback even when two track IDs share the source URL", async t => {
  const fixture = createFixture(t);
  fixture.load("A", true, "/fixture/shared.mp3");
  fixture.load("B", false, "/fixture/shared.mp3");
  assert.equal(fixture.audio.loads, 1, "same-source load behavior must stay unchanged");
  fixture.attempts[0].reject(interrupted());
  await settle();
  assert.equal(fixture.state.music.current.id, "B");
  assert.equal(fixture.state.music.playbackError, "");
});

for (const name of ["NotAllowedError", "AbortError"]) {
  test(`a current ${name} remains visible and retryable`, async t => {
    const fixture = createFixture(t);
    fixture.load("A");
    fixture.audio.paused = true;
    fixture.attempts[0].reject(new DOMException("current playback failed", name));
    await settle();
    assert.equal(fixture.state.music.playbackError, "current playback failed");
    fixture.player.play();
    fixture.audio.emit("play");
    fixture.attempts[1].resolve();
    await settle();
    assert.equal(fixture.state.music.playbackError, "");
    assert.equal(fixture.state.music.playing, true);
  });
}

test("a current rejection without a message preserves the fallback error", async t => {
  const fixture = createFixture(t);
  fixture.load("A");
  fixture.attempts[0].reject({});
  await settle();
  assert.equal(fixture.state.music.playbackError, "浏览器阻止了自动播放");
});

test("a newer play attempt on the same track owns errors", async t => {
  const fixture = createFixture(t);
  fixture.load("A");
  fixture.player.play();
  fixture.attempts[0].reject(new Error("old attempt"));
  await settle();
  assert.equal(fixture.state.music.playbackError, "");
  fixture.attempts[1].reject(new Error("current attempt"));
  await settle();
  assert.equal(fixture.state.music.playbackError, "current attempt");
});

for (const route of ["player.pause", "native audio.pause", "sleep timer"]) {
  test(`${route} cancels pending playback errors without a late playing write`, async t => {
    const fixture = createFixture(t);
    fixture.load("A");
    if (route === "player.pause") fixture.player.pause();
    if (route === "native audio.pause") fixture.audio.pause();
    if (route === "sleep timer") {
      fixture.player.setSleepTimer(10);
      fixture.timers.values().next().value();
      assert.equal(fixture.state.music.sleepMinutes, 0);
      assert.equal(fixture.state.music.sleepUntil, 0);
    }
    fixture.attempts[0].reject(interrupted());
    await settle();
    assert.equal(fixture.audio.paused, true);
    assert.equal(fixture.state.music.playing, false);
    assert.equal(fixture.state.music.playbackError, "");
    assert.equal(fixture.events.pause, 1);
  });
}

test("releasing the source makes an outstanding play promise obsolete", async t => {
  const fixture = createFixture(t);
  fixture.load("A");
  fixture.audio.removeAttribute("src");
  fixture.audio.load();
  fixture.attempts[0].reject(interrupted());
  await settle();
  assert.equal(fixture.audio.src, "");
  assert.equal(fixture.audio.paused, true);
  assert.equal(fixture.state.music.playbackError, "");
});

test("an already changed current track cannot receive an old play error", async t => {
  const fixture = createFixture(t);
  fixture.load("A");
  fixture.state.music.current = { id: "B", streamUrl: "/fixture/B.mp3" };
  fixture.attempts[0].reject(interrupted());
  await settle();
  assert.equal(fixture.state.music.playbackError, "");
});

test("queued media events respect a later pause or play intent", async t => {
  const fixture = createFixture(t);
  fixture.load("A");
  fixture.player.pause();
  fixture.audio.emit("play");
  assert.equal(fixture.state.music.playing, false, "a queued play event must not undo pause");
  assert.equal(fixture.events.play, 0);
  fixture.player.play();
  fixture.audio.emit("pause");
  assert.equal(fixture.events.pause, 1, "a queued pause event must not cancel the latest play");
  fixture.attempts[1].reject(new Error("latest playback failed"));
  await settle();
  assert.equal(fixture.state.music.playbackError, "latest playback failed");
  fixture.attempts[0].resolve();
  await settle();
  assert.equal(fixture.state.music.playbackError, "latest playback failed");
});
