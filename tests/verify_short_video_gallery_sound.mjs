import assert from "node:assert/strict";
import fs from "node:fs";

// Exercise the actual gallery factory with deferred native audio requests. The
// shared controlled DOM uses synthetic media, timers and frames only.
const helpersFile = new URL("./verify_short_video_gallery_metadata.mjs", import.meta.url);
let helpers = fs.readFileSync(helpersFile, "utf8");
helpers = helpers.slice(0, helpers.indexOf("\n{\n  const f = fixture();"));
helpers = helpers.replace("clearPlayerSoundBlocked() {}", 'clearPlayerSoundBlocked: stage => stage?.classList.remove("is-sound-blocked")');
helpers = helpers.replace("markPlayerSoundBlocked() {}", 'markPlayerSoundBlocked: stage => stage?.classList.add("is-sound-blocked")');
helpers = helpers.replace(/from "(\.\.\/public\/[^\"]+)"/g, (_, relative) => `from "${new URL(relative, helpersFile).href}"`);
const loadFixture = async (source = helpers) => (await import(`data:text/javascript;base64,${Buffer.from(`${source}\nexport { fixture };`).toString("base64")}`)).fixture;
const galleryFixture = await loadFixture();
const settle = async () => { for (let index = 0; index < 16; index++) await Promise.resolve(); };
const localSound = { localAvailable: true, previewUrl: "/fixture/background" };
const denied = () => new DOMException("autoplay denied", "NotAllowedError");

async function fixture({ paused = false, live = false, factory = galleryFixture } = {}) {
  const f = factory({ live }); await f.readyAll();
  if (paused) f.gallery.shortVideoGalleryPause("user");
  f.gallery.shortVideoGalleryUpdateMetadata({ id: f.video.id, sound: localSound });
  const audio = f.gallery.querySelector("audio"), requests = [];
  let pauseCalls = 0;
  const pause = audio.pause;
  audio.pause = () => { pauseCalls++; pause(); };
  audio.play = () => {
    audio.playCalls++; audio.paused = false; audio.dispatchEvent(new Event("play"));
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    requests.push({ resolve, reject, promise, muted: audio.muted });
    return promise;
  };
  const snapshot = () => ({
    muted: audio.muted, paused: audio.paused, volume: audio.volume, source: audio.src,
    calls: audio.playCalls, pauseCalls, error: f.gallery.dataset.gallerySoundError,
    soundState: f.gallery.dataset.gallerySoundState, soundMuted: f.gallery.dataset.gallerySoundMuted,
    blocked: f.stage.classList.contains("is-sound-blocked"), preference: f.state.shortVideo.muted,
    galleryPaused: f.gallery.shortVideoGalleryIsPaused(), index: f.gallery.dataset.galleryIndex
  });
  return { ...f, audio, requests, snapshot };
}

async function newerPlaySurvives(factory = galleryFixture) {
  const f = await fixture({ factory }); await f.flushFrames();
  f.gallery.shortVideoGalleryPause("user"); f.gallery.shortVideoGalleryResume("user");
  assert.equal(f.requests.length, 2);
  f.requests[1].resolve(); await settle(); const before = f.snapshot();
  f.requests[0].reject(denied()); await settle();
  assert.deepEqual(f.snapshot(), before, "old permission failure cannot mute or retry a newer successful play");
  await f.dispose();
}
await newerPlaySurvives();

{
  const f = await fixture(); await f.flushFrames();
  const newer = f.gallery.shortVideoGalleryPlaySound();
  f.audio.paused = true;
  f.requests[1].reject(new DOMException("new request interrupted", "AbortError")); await newer;
  const before = f.snapshot(); f.requests[0].resolve(); await settle();
  assert.deepEqual(f.snapshot(), before, "old success cannot erase the current request's error");
  assert.equal(f.audio.playCalls, 2); assert.equal(before.blocked, false); assert.equal(before.muted, false);
  await f.dispose();
}

for (const completion of ["resolve", "reject"]) {
  const f = await fixture(); await f.flushFrames(); f.gallery.shortVideoGalleryPause("user");
  const before = f.snapshot(); f.requests[0][completion](denied()); await settle();
  assert.deepEqual(f.snapshot(), before, `pending ${completion} cannot override a user pause`);
  f.gallery.shortVideoGalleryResume("user"); f.requests[1].resolve(); await settle();
  assert.equal(f.audio.paused, false); assert.equal(f.audio.muted, false);
  await f.dispose();
}

for (const [name, invalidate] of [
  ["gallery seek", async f => { f.gallery.shortVideoGalleryMove(1); await settle(); }],
  ["audio seek", f => { f.audio.currentTime = 7; f.audio.dispatchEvent(new Event("seeking")); }],
  ["source replacement", f => { f.audio.src = "/fixture/replaced"; }],
  ["same-source reload generation", f => { f.audio.dataset.shortVideoSourceGeneration = "1"; }],
  ["native source reset", f => { f.audio.dispatchEvent(new Event("emptied")); }],
  ["sound intent with unchanged mute", f => { f.audio.dataset.shortVideoSoundIntentGeneration = "1"; }],
  ["muted preference", f => { f.state.shortVideo.muted = true; f.audio.muted = true; }],
  ["demotion", f => f.gallery.shortVideoGallerySetActive(false)],
  ["disposal", f => f.gallery.shortVideoGalleryDispose()],
  ["detach", f => f.gallery.remove()]
]) {
  for (const completion of ["resolve", "reject"]) {
    const f = await fixture({ live: name === "gallery seek" }); await f.flushFrames();
    await invalidate(f); const before = f.snapshot();
    f.requests[0][completion](denied()); await settle();
    assert.deepEqual(f.snapshot(), before, `${name} prevents old ${completion} from changing sound or timing`);
    await f.dispose();
  }
}

{
  const f = await fixture(); await f.flushFrames();
  f.gallery.shortVideoGallerySetActive(false); f.gallery.shortVideoGallerySetActive(true);
  assert.equal(f.requests.length, 2); f.requests[1].resolve(); await settle();
  const before = f.snapshot(); f.requests[0].reject(denied()); await settle();
  assert.deepEqual(f.snapshot(), before, "old role cannot affect the same gallery after promotion");
  await f.dispose();
}

for (const name of ["AbortError", "NotSupportedError", "NetworkError"]) {
  const f = await fixture(); await f.flushFrames(); f.audio.paused = true;
  f.requests[0].reject(new DOMException("native media failure", name)); await settle();
  assert.equal(f.stage.classList.contains("is-sound-blocked"), false, `${name} is not an autoplay permission failure`);
  assert.equal(f.audio.muted, false); assert.equal(f.audio.playCalls, 1);
  assert.equal(f.gallery.dataset.gallerySoundError, `${name}: native media failure`);
  await f.dispose();
}

{
  const f = await fixture(); f.state.shortVideo.muted = true; f.audio.muted = true;
  await f.flushFrames(); f.audio.paused = true; f.requests[0].reject(denied()); await settle();
  assert.equal(f.audio.playCalls, 1, "a request already muted cannot gain anything from a muted retry");
  assert.equal(f.stage.classList.contains("is-sound-blocked"), false);
  await f.dispose();
}

for (const completion of ["resolve", "reject"]) {
  const f = await fixture(); await f.flushFrames(); f.audio.paused = true;
  f.requests[0].reject(denied()); await settle();
  assert.equal(f.audio.playCalls, 2); assert.equal(f.audio.muted, true);
  assert.equal(f.state.shortVideo.muted, false, "permission fallback cannot change the user's sound preference");
  assert.equal(f.stage.classList.contains("is-sound-blocked"), true);
  f.requests[1][completion](new DOMException("muted denied", "NotAllowedError")); await settle();
  assert.equal(f.audio.playCalls, 2, "muted fallback is bounded to one attempt");
  assert.equal(f.gallery.dataset.gallerySoundError.includes("muted retry"), completion === "reject");
  const restored = f.gallery.shortVideoGalleryRestoreSound();
  assert.equal(f.audio.muted, false); assert.equal(f.stage.classList.contains("is-sound-blocked"), false);
  f.requests[2].resolve(); assert.equal(await restored, "playing");
  assert.equal(f.gallery.dataset.gallerySoundError, undefined);
  await f.dispose();
}

for (const completion of ["resolve", "reject"]) {
  const f = await fixture(); await f.flushFrames(); f.audio.paused = true;
  f.requests[0].reject(denied()); await settle();
  const restored = f.gallery.shortVideoGalleryRestoreSound();
  f.requests[2].resolve(); assert.equal(await restored, "playing"); const before = f.snapshot();
  f.requests[1][completion](new DOMException("old muted failure", "NotAllowedError")); await settle();
  assert.deepEqual(f.snapshot(), before, `old fallback ${completion} cannot pause, reblock or rewrite a successful restore`);
  await f.dispose();
}

{
  const f = await fixture(); await f.flushFrames(); f.audio.paused = true;
  f.requests[0].reject(denied()); await settle(); f.gallery.shortVideoGalleryPause("user");
  const before = f.snapshot(); f.requests[1].resolve(); await settle();
  assert.deepEqual(f.snapshot(), before, "late muted fallback cannot revive user-paused playback");
  await f.dispose();
}

{
  const f = await fixture(); await f.flushFrames(); const outer = {}, inner = {};
  f.gallery.shortVideoGalleryPause(outer); f.gallery.shortVideoGalleryPause(inner);
  f.requests[0].resolve(); await settle();
  assert.equal(f.audio.paused, true, "an unfinished request waits for independent timing pause owners");
  f.gallery.shortVideoGalleryResume(outer); await settle(); assert.equal(f.audio.playCalls, 1);
  f.gallery.shortVideoGalleryResume(inner); assert.equal(f.audio.playCalls, 2);
  f.requests[1].resolve(); await settle(); assert.equal(f.audio.paused, false);
  const before = f.snapshot(); f.gallery.shortVideoGalleryPause(outer); f.gallery.shortVideoGalleryResume(outer);
  assert.deepEqual(f.snapshot(), before, "established music keeps playing across a timing-only modal pause");
  await f.dispose();
}

{
  const f = await fixture({ paused: true }); await f.flushFrames(); assert.equal(f.audio.playCalls, 0);
  f.gallery.shortVideoGalleryResume("user"); f.requests[0].resolve(); await settle();
  assert.equal(f.audio.playCalls, 1); assert.equal(f.audio.paused, false);
  await f.dispose();
}
{
  const f = await fixture(); const play = f.gallery.shortVideoGalleryPlaySound();
  await f.flushFrames(); assert.equal(f.audio.playCalls, 1, "late metadata's queued attachment cannot duplicate a newer explicit play");
  f.requests[0].resolve(); assert.equal(await play, true); await f.dispose();
}
{
  const f = await fixture(); f.gallery.shortVideoGallerySetActive(false); f.gallery.shortVideoGallerySetActive(true);
  await f.flushFrames(); assert.equal(f.audio.playCalls, 1, "an old attachment frame cannot duplicate the promoted role's play");
  f.requests[0].resolve(); await settle(); await f.dispose();
}
{
  const f = await fixture(); await f.flushFrames();
  document.hidden = true; f.requests[0].resolve(); await settle();
  assert.equal(f.audio.paused, false, "visibility alone keeps the current gallery's existing playback policy");
  f.gallery.shortVideoGalleryPause("user"); const before = f.snapshot();
  document.hidden = false; await f.flushFrames(); assert.deepEqual(f.snapshot(), before, "becoming visible cannot undo user pause");
  await f.dispose();
}
for (const invalidate of [f => f.gallery.shortVideoGallerySetActive(false), f => f.gallery.shortVideoGalleryDispose(), f => f.gallery.remove()]) {
  const f = await fixture(); invalidate(f); f.state.shortVideo.muted = true; const before = f.snapshot();
  assert.equal(await f.gallery.shortVideoGalleryRestoreSound(), "missing");
  assert.deepEqual(f.snapshot(), before, "stale restore cannot alter global preferences, audio or blocked UI");
  await f.dispose();
}

// The negative control runs the same factory with just its ownership gate
// removed in memory. It proves these assertions detect the asynchronous race.
const galleryFile = new URL("../public/modules/short-videos/gallery-player.js", import.meta.url);
let unguarded = fs.readFileSync(galleryFile, "utf8");
assert(unguarded.includes("if (!ownsSound()) return true;"));
unguarded = unguarded.replace("if (!ownsSound()) return true;", "if (false) return true;");
unguarded = unguarded.replace(/from "(\.\/[^\"]+)"/g, (_, relative) => `from "${new URL(relative, galleryFile).href}"`);
const unguardedUrl = `data:text/javascript;base64,${Buffer.from(unguarded).toString("base64")}`;
const unguardedFixture = await loadFixture(helpers.replace(galleryFile.href, unguardedUrl));
await assert.rejects(newerPlaySurvives(unguardedFixture), /old permission failure cannot mute or retry/);

delete globalThis.window; delete globalThis.document;
console.log("short-video-gallery-sound: passed actual request/source/role/intent ownership, permission fallback, deferred music and stale completion negative control");
