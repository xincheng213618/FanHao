import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { createMusicAudioSourceStore, fetchMusicAudioSource, releaseMusicAudioSource } from "../android-client/www/modules/music/music-audio-source.js";

test("authenticated music is fully materialized as a Blob URL", async () => {
  const signal = new AbortController().signal;
  const calls = [];
  const source = await fetchMusicAudioSource("http://music.test/media/music/track", {
    signal,
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return { ok: true, status: 200, blob: async () => new Blob([new Uint8Array([73, 68, 51])], { type: "audio/mpeg" }) };
    },
    createObjectURL(blob) {
      assert.equal(blob.type, "audio/mpeg");
      return "blob:music-fixture";
    }
  });
  assert.deepEqual(source, { objectUrl: "blob:music-fixture", size: 3, type: "audio/mpeg" });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.cache, "no-store");
  assert.equal(calls[0].options.signal, signal);
});

test("HTTP and empty-body failures never create a playable source", async () => {
  await assert.rejects(fetchMusicAudioSource("http://music.test/unauthorized", {
    fetchImpl: async () => ({ ok: false, status: 401 })
  }), /401/);
  await assert.rejects(fetchMusicAudioSource("http://music.test/empty", {
    fetchImpl: async () => ({ ok: true, status: 200, blob: async () => new Blob([]) })
  }), /音频文件为空/);
});

test("an abort after body settlement cannot publish a Blob URL", async () => {
  const controller = new AbortController();
  let created = 0;
  await assert.rejects(fetchMusicAudioSource("http://music.test/late", {
    signal: controller.signal,
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      async blob() {
        controller.abort();
        return new Blob([new Uint8Array([1])]);
      }
    }),
    createObjectURL() {
      created += 1;
      return "blob:must-not-exist";
    }
  }), { name: "AbortError" });
  assert.equal(created, 0);
});

test("released sources revoke only their exact Blob URL", () => {
  const revoked = [];
  releaseMusicAudioSource({ objectUrl: "blob:one" }, { revokeObjectURL: (url) => revoked.push(url) });
  releaseMusicAudioSource("", { revokeObjectURL: (url) => revoked.push(url) });
  assert.deepEqual(revoked, ["blob:one"]);
});

test("the source store cancels stale loads and revokes replaced or retired URLs", async () => {
  const pending = [];
  const revoked = [];
  const target = {
    src: "",
    loads: 0,
    pause() {},
    removeAttribute() { this.src = ""; },
    load() { this.loads += 1; }
  };
  const store = createMusicAudioSourceStore({
    fetchImpl: (url, options) => new Promise((resolve) => pending.push({ url, options, resolve })),
    revokeObjectURL: (url) => revoked.push(url)
  });
  const first = store.load("current", target, "http://music.test/first", { clearBefore: true });
  const second = store.load("current", target, "http://music.test/second", { clearBefore: true });
  pending[0].resolve({ ok: true, status: 200, blob: async () => new Blob(["old"]) });
  pending[1].resolve({ ok: true, status: 200, blob: async () => new Blob(["new"]) });
  assert.equal(await first, false);
  assert.equal(await second, true);
  assert.match(target.src, /^blob:/);
  const active = target.src;
  store.release(target);
  assert.equal(target.src, "");
  assert.deepEqual(revoked, [active]);
});

const views = fs.readFileSync(new URL("../android-client/www/modules/music/music-views.js", import.meta.url), "utf8");
assert.match(views, /await audioSourceStore\.load\("current", targetAudio, target,[\s\S]*?clearBefore: true/,
  "the current Android music track must use the authenticated Blob source");
assert.match(views, /function scheduleGaplessPreload\(\)[\s\S]*?audioSourceStore\.load\("gapless", target, absoluteUrl\(getActiveUrl\(\), candidate\.streamUrl\)/,
  "gapless preload must use the same authenticated Blob source path");
assert.doesNotMatch(views, /audio\.src\s*=\s*target/,
  "the main player must not stream the cross-origin authenticated URL directly through WebView");
assert.doesNotMatch(views, /gaplessPreloadAudio\.src\s*=\s*absoluteUrl/,
  "gapless preload must not bypass authenticated fetch");
