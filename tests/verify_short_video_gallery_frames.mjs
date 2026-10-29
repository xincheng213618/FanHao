import assert from "node:assert/strict";
import fs from "node:fs";

// Run the actual gallery with controlled DOM geometry, native play promises,
// RAF and timers. Counts describe issued work, not a browser timing benchmark.
const helpersFile = new URL("./verify_short_video_gallery_metadata.mjs", import.meta.url);
let helpers = fs.readFileSync(helpersFile, "utf8");
helpers = helpers.slice(0, helpers.indexOf("\n{\n  const f = fixture();"));
helpers = helpers.replace(/from "(\.\.\/public\/[^\"]+)"/g, (_, relative) => `from "${new URL(relative, helpersFile).href}"`);
const { fixture } = await import(`data:text/javascript;base64,${Buffer.from(`${helpers}\nexport { fixture };`).toString("base64")}`);
const settle = async () => { for (let i = 0; i < 16; i++) await Promise.resolve(); };
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const progressFrames = f => [...f.frames.entries()].filter(([, callback]) => callback.name === "tick");
function geometry(f, initialWidth = 400) {
  let width = initialWidth, reads = 0, writes = 0;
  const operations = [];
  Object.defineProperty(f.gallery, "clientWidth", { get() { reads++; operations.push("read"); return width; } });
  const track = f.gallery.querySelector(".short-video-gallery-track");
  track.style.setProperty = name => { if (name === "--short-video-gallery-drag-x") { writes++; operations.push("write"); } };
  return { get reads() { return reads; }, get writes() { return writes; }, operations,
    resize(value) { width = value; }, reset() { reads = 0; writes = 0; operations.length = 0; } };
}
function settleDrag(f) {
  const duration = Number(f.gallery.dataset.gallerySettleDuration) + 10;
  const found = [...f.timers.entries()].find(([, timer]) => timer.delay === duration);
  assert(found, "drag schedules its settle completion");
  f.timers.delete(found[0]); found[1].callback(); return found[1].callback;
}

{
  const f = fixture(); await f.readyAll(); await f.flushFrames();
  const g = geometry(f); assert(f.gallery.shortVideoGalleryDragStart()); g.reset();
  for (let i = 1; i <= 60; i++) f.gallery.shortVideoGalleryDragMove(-i);
  assert.equal(g.reads, 0, "pointer packets do not synchronously read layout");
  assert.equal(g.writes, 0, "pointer packets do not synchronously write transforms");
  assert.equal(f.frames.size, 1, "60 moves coalesce into one visual frame");
  await f.flushFrames();
  assert.equal(g.reads, 1); assert.equal(g.writes, 1);
  assert.deepEqual(g.operations, ["read", "write"], "measure once before the frame's transform write");
  assert.equal(f.gallery.dataset.galleryDragX, "-60", "the frame consumes the latest pointer position");
  await f.dispose();
}

{
  const f = fixture(); await f.readyAll(); await f.flushFrames();
  const g = geometry(f); f.gallery.shortVideoGalleryDragStart(); g.reset();
  f.gallery.shortVideoGalleryDragMove(-20);
  const staleFrame = [...f.frames.values()][0];
  assert(f.gallery.shortVideoGalleryDragEnd(-250));
  assert.equal(g.reads, 1, "release measures fresh geometry and consumes its final position synchronously");
  assert.equal(f.frames.size, 0, "release cancels the queued drag frame");
  assert.equal(f.gallery.dataset.galleryDragX, "-400", "the final release delta crosses the threshold even before the first frame");
  staleFrame(); assert.equal(f.gallery.dataset.galleryDragX, "-400", "an already queued old frame cannot overwrite settling");
  settleDrag(f); await settle();
  assert.equal(f.gallery.dataset.galleryIndex, "1");
  await f.dispose();
}

{
  const f = fixture(); await f.readyAll(); await f.flushFrames();
  const g = geometry(f, 300); f.gallery.shortVideoGalleryDragStart();
  f.gallery.shortVideoGalleryDragMove(-80); await f.flushFrames();
  g.resize(1000); g.reset();
  f.gallery.shortVideoGalleryDragEnd(-80);
  assert.equal(g.reads, 1, "release does not reuse the previous frame's width after a resize");
  assert.equal(f.gallery.dataset.galleryDragX, "0", "80px rebounds at the new 1000px width");
  settleDrag(f); await settle(); assert.equal(f.gallery.dataset.galleryIndex, "0");
  assert([...f.timers.values()].some(timer => timer.delay === 4000), "rebound preserves normal automatic-advance scheduling");
  await f.dispose();
}

{
  const f = fixture(); await f.readyAll(); await f.flushFrames();
  const g = geometry(f); f.gallery.shortVideoGalleryDragStart();
  f.gallery.shortVideoGalleryDragMove(-200); await f.flushFrames();
  f.gallery.shortVideoGalleryDragEnd(0);
  assert.equal(f.gallery.dataset.galleryDragX, "0", "returning the pointer exactly to the origin consumes zero rather than an old nonzero delta");
  settleDrag(f); await settle(); assert.equal(f.gallery.dataset.galleryIndex, "0");
  f.gallery.shortVideoGalleryDragStart(); g.reset();
  f.gallery.shortVideoGalleryDragMove(-30); const frame = [...f.frames.values()][0];
  f.gallery.shortVideoGalleryDragCancel();
  assert.equal(g.reads, 1); assert.equal(f.frames.size, 0);
  frame(); assert.equal(f.gallery.dataset.galleryDragX, "0");
  settleDrag(f); await f.dispose();
}

{
  const f = fixture(); await f.ready(f.gallery.querySelector(".short-video-gallery-image")); await f.flushFrames();
  geometry(f); assert(f.gallery.shortVideoGalleryDragStart());
  f.gallery.shortVideoGalleryDragMove(-40); await f.flushFrames();
  const preview = f.elements.find(node => node.src === "/fixture/item/1"); assert(preview);
  f.gallery.shortVideoGallerySetActive(false); await f.ready(preview);
  assert.equal(f.gallery.querySelector(".is-drag-preview"), null, "a preview decode cannot append to a demoted gallery");
  assert.equal(f.gallery.classList.contains("is-gallery-dragging"), false);
  assert.equal(f.gallery.classList.contains("is-gallery-settling"), false);
  f.gallery.shortVideoGallerySetActive(true);
  assert.equal(f.gallery.shortVideoGalleryDragStart(), true, "a reactivated gallery can immediately start a fresh drag");
  await f.dispose();
}

{
  const f = fixture(); await f.readyAll(); await f.flushFrames(); geometry(f);
  f.gallery.shortVideoGalleryDragStart(); f.gallery.shortVideoGalleryDragMove(-200); f.gallery.shortVideoGalleryDragEnd(-200);
  const duration = Number(f.gallery.dataset.gallerySettleDuration) + 10;
  const oldSettle = [...f.timers.values()].find(timer => timer.delay === duration).callback;
  f.gallery.shortVideoGallerySetActive(false); f.gallery.shortVideoGallerySetActive(true);
  assert(f.gallery.shortVideoGalleryDragStart()); f.gallery.shortVideoGalleryDragMove(30); await f.flushFrames();
  oldSettle();
  assert.equal(f.gallery.dataset.galleryIndex, "0", "a queued completion from the old role cannot commit its pending page");
  assert.equal(f.gallery.dataset.galleryDragX, "30", "old settling cannot reset the new role's live drag");
  assert.equal(f.gallery.classList.contains("is-gallery-dragging"), true);
  await f.dispose();
}

{
  const f = fixture({ live: true }), first = f.gallery.querySelector(".short-video-gallery-image"), oldPlay = deferred();
  first.play = () => { first.paused = false; first.playCalls++; return oldPlay.promise; }; first.duration = 10;
  await f.readyAll(); f.gallery.shortVideoGalleryMove(1); await settle();
  const current = f.gallery.querySelector(".short-video-gallery-image"); current.duration = 10; current.currentTime = 3;
  await f.flushFrames(); const activeFrame = progressFrames(f)[0]; assert(activeFrame);
  assert.equal(f.gallery.dataset.galleryVideoProgress, "0.3000");
  oldPlay.resolve(); await settle();
  assert.equal(f.gallery.dataset.galleryVideoProgress, "0.3000", "old native play completion cannot paint progress for the previous item");
  assert.equal(progressFrames(f)[0][0], activeFrame[0], "old native completion cannot stop or replace the current item's progress loop");
  assert.equal(current.paused, false); await f.dispose();
}

{
  const f = fixture({ live: true }); await f.readyAll();
  const oldFrame = progressFrames(f)[0]?.[1]; assert(oldFrame);
  f.gallery.shortVideoGalleryMove(1); await settle();
  const current = f.gallery.querySelector(".short-video-gallery-image"); current.duration = 10; current.currentTime = 4;
  await f.flushFrames(); const activeFrame = progressFrames(f)[0]; assert(activeFrame);
  oldFrame();
  assert.equal(f.gallery.dataset.galleryVideoProgress, "0.4000");
  assert.equal(progressFrames(f)[0][0], activeFrame[0], "an already queued old tick cannot steal the new frame handle");
  await f.dispose();
}

{
  const f = fixture({ live: true }), clip = f.gallery.querySelector(".short-video-gallery-image");
  const old = deferred(), latest = deferred(); let plays = 0;
  clip.play = () => { clip.paused = false; return (++plays === 1 ? old : latest).promise; };
  await f.readyAll(); f.gallery.shortVideoGallerySetActive(false); f.gallery.shortVideoGallerySetActive(true);
  clip.duration = 10; clip.currentTime = 2; latest.resolve(); await settle();
  const frame = progressFrames(f)[0]; assert(frame);
  old.resolve(); await settle();
  assert.equal(f.gallery.dataset.galleryVideoProgress, "0.2000");
  assert.equal(progressFrames(f)[0][0], frame[0], "a pre-demotion play result cannot restart the new role's loop");
  await f.dispose();
}

for (const close of ["pause", "demote", "dispose"]) {
  const f = fixture({ live: true }), clip = f.gallery.querySelector(".short-video-gallery-image"), pending = deferred();
  clip.play = () => { clip.paused = false; return pending.promise; };
  await f.readyAll();
  if (close === "pause") f.gallery.shortVideoGalleryPause("user");
  if (close === "demote") f.gallery.shortVideoGallerySetActive(false);
  if (close === "dispose") f.gallery.shortVideoGalleryDispose();
  const progress = f.gallery.dataset.galleryVideoProgress;
  pending.resolve(); await settle();
  assert.equal(progressFrames(f).length, 0, `${close} rejects late native progress-loop start`);
  assert.equal(f.gallery.dataset.galleryVideoProgress, progress, `${close} rejects stale progress DOM writes`);
  if (close === "pause") assert.equal(f.gallery.shortVideoGalleryIsPaused(), true);
  await f.dispose();
}

console.log("short-video-gallery-frames: passed coalesced geometry/painting, final release and resize decisions, role/decode/timer ownership and LivePhoto native/frame handoff");
