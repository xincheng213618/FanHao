import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { createShortVideoSoundPreviewController } from "../public/modules/short-videos/sound-preview-controller.js";

// Actual page ownership/audio-focus bridge and preview controller, plus the
// actual gallery for timing, music and independent modal/user pause reasons.
const helpersFile = new URL("./verify_short_video_gallery_metadata.mjs", import.meta.url);
let helpers = fs.readFileSync(helpersFile, "utf8");
helpers = helpers.slice(0, helpers.indexOf("\n{\n  const f = fixture();"));
helpers = helpers.replace(/from "(\.\.\/public\/[^\"]+)"/g, (_, relative) => `from "${new URL(relative, helpersFile).href}"`);
const { fixture: galleryFixture, Element } = await import(`data:text/javascript;base64,${Buffer.from(`${helpers}\nexport { fixture, Element };`).toString("base64")}`);
const source = fs.readFileSync(new URL("../public/modules/short-videos/short-video-page.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");
function sourceFunction(name) {
  const start = new RegExp(`^  (?:async )?function ${name}\\(`, "m").exec(source)?.index;
  assert(start != null, name);
  return source.slice(start, source.indexOf("\n  }", start) + 4);
}
const names = ["captureShortVideoPlaybackOwner", "ownsShortVideoPlaybackOwner", "shortVideoNavigationScope",
  "stopShortVideoSoundPreview", "acquireShortVideoSoundPreviewPlayback", "toggleActivePlayer", "currentShortVideoVolume",
  "setActiveShortVideoVolume", "toggleActiveMute", "seekActiveVideo"];
const implementation = names.map(sourceFunction).join("\n");
const settle = async () => { for (let turn = 0; turn < 20; turn++) await Promise.resolve(); };

async function fixture({ gallery = false, sound = false, paused = false, live = false } = {}) {
  const g = gallery ? galleryFixture({ live }) : null;
  if (g) {
    await g.readyAll();
    if (sound) { g.gallery.shortVideoGalleryUpdateMetadata({ id: g.video.id, sound: { localAvailable: true, previewUrl: "/fixture/background" } }); await settle(); }
    if (paused) g.gallery.shortVideoGalleryPause("user");
  }
  const root = g?.root || new Element("root"); root.connected = true;
  const state = g?.state || { shortVideo: { current: { id: "video" }, muted: false } };
  state.activeView = "shortVideos"; state.shortVideo.volume = .4;
  const stage = g?.stage || new Element("div"); if (!g) root.append(stage);
  const media = g ? null : new Element("video");
  if (media) {
    media.className = "short-video-player"; media.src = "/fixture/video"; media.currentTime = 5; media.duration = 60; media.muted = false;
    media.paused = paused; media.dataset = { videoId: "video", shortVideoSlot: "current", shortVideoSourceGeneration: "1", shortVideoPlaybackIntentGeneration: "0" };
    media.shortVideoSetPlaybackIntent = playing => {
      media.dataset.shortVideoExplicitPlaybackIntent = playing ? "play" : "pause";
      media.dataset.shortVideoPlaybackIntentGeneration = String(Number(media.dataset.shortVideoPlaybackIntentGeneration || 0) + 1);
    };
    stage.append(media);
  }
  const main = () => media || g?.gallery.querySelector(".short-video-gallery-audio") || null;
  if (g?.gallery.querySelector("audio")) {
    const background = main(); background.dataset.videoId = state.shortVideo.current.id;
    background.dataset.shortVideoSlot = "current";
  }
  const panel = new Element("section"), audio = new Element("audio"), button = new Element("button"), cover = new Element("span");
  root.append(panel); panel.append(audio, button, cover); audio.src = "/fixture/preview";
  const calls = [];
  const context = vm.createContext({
    state, shortVideoSoundPreviewAudio: null, shortVideoNavigationState: { id: state.shortVideo.current.id }, shortVideoOpenRequestId: 1,
    shortVideoPlaybackLifecycleGeneration: 0, shortVideoPageSuspended: false,
    shortVideoWheelController: { cancel: () => calls.push("cancel-wheel") },
    activePlayer: main, activeGalleryPlayer: () => g?.gallery || null, isGalleryPost: () => Boolean(g),
    shortVideoFeedParams: () => `q=${state.shortVideo.query || ""}`,
    cancelShortVideoAutoNext: () => calls.push("cancel-auto"), cancelShortVideoBrowseGestures: () => calls.push("cancel-gesture"), clearPendingPlayerClick() {},
    normalizeShortVideoVolume: value => Math.max(0, Math.min(1, Number(value))), readVolumePreference: () => .4,
    writeMutedPreference: value => calls.push(["muted", value]), writeVolumePreference: value => calls.push(["volume", value]),
    syncActiveControlBar() {}, clearPlayerSoundBlocked() {}, markPlayerSoundBlocked: () => calls.push("blocked"), showKeyboardSeekFeedback() {}
  });
  vm.runInContext(`${implementation}\nglobalThis.focusApi = { ${names.join(", ")} };`, context);
  const api = context.focusApi;
  const controller = createShortVideoSoundPreviewController({ audio, preview: button, cover,
    isCurrent: () => panel.isConnected && audio.isConnected,
    acquirePlayback: () => api.acquireShortVideoSoundPreviewPlayback(audio, panel),
    showError: error => calls.push(["error", error]) });
  const clean = async () => { controller.dispose({ restorePlayback: false }); if (g) await g.dispose(); panel.remove(); };
  return { g, state, root, stage, main, panel, audio, button, controller, api, context, calls, clean };
}

const failures = [];
async function check(name, run) {
  try { await run(); }
  catch (error) { failures.push({ name, error }); console.error(`${name}: ${error.message}`); }
}

await check("video resumes only its captured playback", async () => {
  const f = await fixture();
  await f.controller.toggle();
  assert.equal(f.main().paused, true); assert.equal(f.main().dataset.shortVideoExplicitPlaybackIntent, "pause");
  assert.equal(f.audio.paused, false); assert.equal(f.audio.volume, .4);
  f.controller.stop(); await settle();
  assert.equal(f.main().paused, false); assert.equal(f.main().playCalls, 1);
  assert.equal(f.main().dataset.shortVideoExplicitPlaybackIntent, "play");
  await f.clean();
});

for (const kind of ["initial-pause", "new-user-pause", "seek", "new-navigation", "source-change"]) {
  await check(`${kind} prevents old preview release from resuming`, async () => {
    const f = await fixture({ paused: kind === "initial-pause" }); await f.controller.toggle();
    if (kind === "new-user-pause") f.main().shortVideoSetPlaybackIntent(false);
    if (kind === "seek") f.api.seekActiveVideo(5);
    if (kind === "new-navigation") { f.context.shortVideoNavigationState = { id: "new-owner" }; f.context.shortVideoOpenRequestId++; }
    if (kind === "source-change") f.main().src = "/fixture/replaced";
    f.controller.stop(); await settle();
    assert.equal(f.main().paused, true); assert.equal(f.main().playCalls, 0);
    await f.clean();
  });
}

await check("video main play stops preview without destroying its control", async () => {
  const f = await fixture(); await f.controller.toggle();
  f.api.toggleActivePlayer(); await settle();
  assert.equal(f.main().paused, false); assert.equal(f.audio.paused, true);
  assert.equal(f.audio.src, "/fixture/preview", "user play cancels preview without disposing its source");
  await f.controller.toggle();
  assert.equal(f.audio.paused, false); assert.equal(f.main().paused, true);
  await f.clean();
});

await check("volume and mute update preview without invalidating main resume", async () => {
  const f = await fixture(); await f.controller.toggle();
  f.api.setActiveShortVideoVolume(65);
  assert.equal(f.audio.volume, .65); assert.equal(f.main().paused, true);
  assert.equal(await f.api.toggleActiveMute(), false); assert.equal(f.audio.muted, true); assert.equal(f.main().muted, true);
  f.controller.stop(); await settle();
  assert.equal(f.main().paused, false, "sound preferences are independent of playback intent");
  assert.equal(f.main().muted, true); assert.equal(f.main().volume, .65);
  await f.clean();
});

for (const sound of [false, true]) {
  await check(`gallery ${sound ? "with music" : "without music"} pauses and restores timing`, async () => {
    const f = await fixture({ gallery: true, sound });
    assert.equal(f.g.gallery.classList.contains("is-gallery-timing-paused"), false);
    await f.controller.toggle();
    assert.equal(f.g.gallery.classList.contains("is-gallery-timing-paused"), true);
    if (sound) assert.equal(f.main().paused, true);
    f.controller.stop(); await settle();
    assert.equal(f.g.gallery.classList.contains("is-gallery-timing-paused"), false);
    if (sound) assert.equal(f.main().paused, false);
    await f.clean();
  });
}

for (const reason of ["modal", "user"]) {
  await check(`gallery release preserves independent ${reason} pause`, async () => {
    const f = await fixture({ gallery: true, sound: true }); await f.controller.toggle();
    f.g.gallery.shortVideoGalleryPause(reason);
    f.controller.stop(); await settle();
    assert.equal(f.g.gallery.classList.contains("is-gallery-timing-paused"), true);
    assert.equal(f.main().paused, true);
    f.g.gallery.shortVideoGalleryResume(reason); await settle();
    assert.equal(f.g.gallery.classList.contains("is-gallery-timing-paused"), false, "preview releases only its own pause reason");
    await f.clean();
  });
}

await check("preview release remembers music until the final author modal closes", async () => {
  const f = await fixture({ gallery: true, sound: true });
  await f.g.gallery.shortVideoGalleryPlaySound(); await settle();
  const background = f.main();
  const authorModal = { kind: "author-panel" }, nestedModal = { kind: "nested-author-panel" };
  assert.equal(background.paused, false, "fixture soundtrack is already playing before the author modal opens");
  const initialPlayCalls = background.playCalls;
  f.g.gallery.shortVideoGalleryPause(authorModal);
  assert.equal(f.g.gallery.classList.contains("is-gallery-timing-paused"), true);
  assert.equal(background.paused, false, "opening the author modal pauses timing while keeping existing music playing");
  await f.controller.toggle();
  assert.equal(background.paused, true, "preview takes audio focus from the still-playing gallery soundtrack");
  assert.equal(f.audio.paused, false, "preview itself starts after taking audio focus");
  f.g.gallery.shortVideoGalleryPause(nestedModal);
  f.controller.stop(); await settle();
  assert.equal(f.audio.paused, true);
  assert.equal(background.paused, true, "returning focus cannot play music while an author modal remains open");
  assert.equal(background.playCalls, initialPlayCalls);
  f.g.gallery.shortVideoGalleryResume(authorModal); await settle();
  assert.equal(background.paused, true, "closing one modal preserves the other modal's pause reason");
  assert.equal(background.playCalls, initialPlayCalls);
  f.g.gallery.shortVideoGalleryResume(nestedModal); await settle();
  assert.equal(f.g.gallery.classList.contains("is-gallery-timing-paused"), false);
  assert.equal(background.paused, false, "the last modal restores the soundtrack requested when preview released focus");
  assert.equal(background.playCalls, initialPlayCalls + 1);
  await f.clean();
});

for (const kind of ["no-restore", "new-navigation"]) {
  await check(`gallery ${kind} cannot restart old timing`, async () => {
    const f = await fixture({ gallery: true }); await f.controller.toggle();
    if (kind === "new-navigation") { f.context.shortVideoNavigationState = { id: "other" }; f.context.shortVideoOpenRequestId++; }
    f.controller.stop({ restorePlayback: kind !== "no-restore" }); await settle();
    assert.equal(f.g.gallery.classList.contains("is-gallery-timing-paused"), true);
    await f.clean();
  });
}

await check("gallery main play stops preview and plays current gallery", async () => {
  const f = await fixture({ gallery: true, sound: true }); await f.controller.toggle();
  f.api.toggleActivePlayer(); await settle();
  assert.equal(f.audio.paused, true); assert.equal(f.audio.src, "/fixture/preview");
  assert.equal(f.g.gallery.shortVideoGalleryIsPaused(), false);
  assert.equal(f.g.gallery.classList.contains("is-gallery-timing-paused"), false);
  assert.equal(f.main().paused, false);
  await f.controller.toggle(); assert.equal(f.audio.paused, false);
  await f.clean();
});

assert.equal(failures.length, 0, failures.map(({ name }) => name).join("; "));
console.log("short-video-sound-focus: passed actual video/gallery playback ownership, preview reuse, independent pause reasons and volume/mute controls");
