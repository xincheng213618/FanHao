import assert from "node:assert/strict";
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { chromium } from "playwright-core";

const executablePath = [process.env.CHROME_PATH, "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe", "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe"]
  .filter(Boolean).find(path => fs.existsSync(path));
assert(executablePath, "Chrome or Edge required for the private gallery layout fixture");
const legacy = process.argv.includes("--legacy");
const cpuRate = process.argv.includes("--normal-cpu") ? 1 : 4;
const galleryModule = "/modules/short-videos/gallery-player.js";
const source = legacy ? execFileSync("git", ["show", `HEAD:public${galleryModule}`], { cwd: new URL("..", import.meta.url), encoding: "utf8" }) : null;
const browser = await chromium.launch({ executablePath, headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await page.route("**/*", async route => {
    const { pathname } = new URL(route.request().url());
    if (pathname === "/fixture") {
      await route.fulfill({ contentType: "text/html", body: `<!doctype html><meta charset="utf-8">
        ${["viewer", "gallery-navigation", "panels", "responsive"].map(name => `<link rel="stylesheet" href="/modules/short-videos/styles/${name}.css">`).join("")}
        <body class="standalone-module-view short-video-view short-video-browser-active"><main id="workGrid"><section class="short-video-browser"><div class="short-video-reel-stack"><div class="short-video-reel-panel is-current"><div class="short-video-stage is-gallery-stage is-video-ready"></div></div></div></section></main>` });
    } else if (pathname.startsWith("/synthetic/")) {
      await route.fulfill({ contentType: "image/svg+xml", body: '<svg xmlns="http://www.w3.org/2000/svg" width="500" height="800"><rect width="500" height="800" fill="teal"/></svg>' });
    } else if (pathname === galleryModule && source) {
      await route.fulfill({ contentType: "text/javascript", body: source });
    } else if (pathname.startsWith("/modules/short-videos/")) {
      await route.fulfill({ contentType: pathname.endsWith(".css") ? "text/css" : "text/javascript",
        body: fs.readFileSync(new URL(`../public${pathname}`, import.meta.url)) });
    } else await route.abort();
  });
  await page.goto("http://127.0.0.1/fixture");
  await page.evaluate(async galleryModule => {
    const { createShortVideoGalleryPlayer } = await import(galleryModule);
    const stage = document.querySelector(".short-video-stage"), noop = () => {};
    const images = Array.from({ length: 40 }, (_, index) => ({ url: `/synthetic/${index}.svg`, type: "image" }));
    const render = createShortVideoGalleryPlayer({
      applyVideoOrientation: noop, clearPlayerSoundBlocked: noop, createIcon: () => document.createElement("span"),
      currentShortVideoVolume: () => .5, els: { workGrid: document.querySelector("#workGrid") }, galleryImageEntries: () => images,
      handleGalleryAutoNext: noop, markPlayerSoundBlocked: noop, persistShortVideoWatch: noop, setIconButton: noop,
      SHORT_VIDEO_GALLERY_ADVANCE_MS: 4000, state: { shortVideo: { muted: true } }
    });
    const gallery = render({ id: "fixture", title: "Synthetic gallery" }, { stage });
    stage.append(gallery);
    await gallery.shortVideoGalleryReady;
    gallery.shortVideoGalleryPause("user");
    window.stepGallery = index => new Promise((resolve, reject) => {
      const delta = index - Number(gallery.dataset.galleryIndex);
      const button = Math.abs(delta) === 1
        ? gallery.querySelector(`.short-video-gallery-nav.${delta > 0 ? "is-next" : "is-previous"}`)
        : gallery.querySelector(".short-video-gallery-progress").children[index];
      const commit = new MutationObserver(() => {
        if (Number(gallery.dataset.galleryIndex) !== index) return;
        window.clearTimeout(timeout); commit.disconnect(); resolve();
      });
      const timeout = window.setTimeout(() => { commit.disconnect(); reject(new Error(`Gallery did not commit item ${index}`)); }, 5000);
      commit.observe(gallery, { attributes: true, attributeFilter: ["data-gallery-index"] });
      button.click();
    });
  }, galleryModule);
  await page.waitForSelector(".short-video-gallery-track > img");
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Performance.enable");
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: cpuRate });
  const metrics = async () => Object.fromEntries((await cdp.send("Performance.getMetrics")).metrics.map(({ name, value }) => [name, value]));
  const measurements = [];
  for (let repeat = 0; repeat < 3; repeat++) {
    const before = await metrics();
    const sample = await page.evaluate(async () => {
      const gallery = document.querySelector(".short-video-gallery-player"), progress = gallery.querySelector(".short-video-gallery-progress");
      const rect = Element.prototype.getBoundingClientRect;
      let layoutReads = 0, layoutReadMs = 0, selectionWrites = 0;
      Element.prototype.getBoundingClientRect = function (...args) {
        if (!gallery.contains(this)) return rect.apply(this, args);
        const start = performance.now();
        const result = rect.apply(this, args);
        layoutReads++;
        layoutReadMs += performance.now() - start;
        return result;
      };
      const writes = new MutationObserver(records => { selectionWrites += records.length; });
      writes.observe(progress, { subtree: true, attributes: true, attributeFilter: ["aria-selected"] });
      const steps = [...Array.from({ length: 20 }, (_, index) => index + 1), ...Array.from({ length: 20 }, (_, index) => 19 - index)];
      try {
        for (const index of steps) {
          await window.stepGallery(index);
          if ([...progress.children].some((button, offset) => button.getAttribute("aria-selected") !== String(offset === index)
            || button.hasAttribute("aria-current") !== (offset === index) || button.classList.contains("active") !== (offset === index)
            || button.classList.contains("is-past") !== (offset < index))) {
            throw new Error(`incorrect progress tab state after step to ${index}`);
          }
        }
        return { steps: steps.length, layoutReads, layoutReadMs, selectionWrites: selectionWrites + writes.takeRecords().length };
      } finally { writes.disconnect(); Element.prototype.getBoundingClientRect = rect; }
    });
    const after = await metrics();
    measurements.push({ ...sample, layouts: after.LayoutCount - before.LayoutCount, layoutMs: (after.LayoutDuration - before.LayoutDuration) * 1000,
      styleRecalculations: after.RecalcStyleCount - before.RecalcStyleCount, styleMs: (after.RecalcStyleDuration - before.RecalcStyleDuration) * 1000 });
  }
  console.log(`GALLERY_STEP_LAYOUT ${JSON.stringify({ legacy, cpuRate, measurements })}`);
  if (!legacy) for (const sample of measurements) {
    assert.equal(sample.layoutReads, sample.steps, "each accepted step must share one animation style flush");
    assert.equal(sample.selectionWrites, 2 * sample.steps, "only the old and new progress tabs may write aria-selected");
  }

  await cdp.send("Emulation.setCPUThrottlingRate", { rate: 1 });
  const motions = await page.evaluate(async () => {
    const gallery = document.querySelector(".short-video-gallery-player"), samples = [];
    let lastCounter;
    for (const index of [1, 2, 1, 39, 0]) {
      await window.stepGallery(index);
      const animations = gallery.getAnimations({ subtree: true });
      const counter = animations.find(animation => animation.animationName?.startsWith("shortVideoGalleryCounter"));
      const image = animations.find(animation => animation.animationName?.startsWith("shortVideoGalleryEnter"));
      const progress = [...gallery.querySelector(".short-video-gallery-progress").children];
      samples.push({ counter: counter?.animationName, restarted: Boolean(counter && counter !== lastCounter), image: image?.animationName,
        segment: animations.some(animation => animation.animationName === "shortVideoGallerySegmentProgress"),
        selected: progress.findIndex(button => button.getAttribute("aria-selected") === "true"),
        past: progress.filter(button => button.classList.contains("is-past")).length });
      lastCounter = counter;
    }
    return samples;
  });
  assert.deepEqual(motions, [[1, "Next"], [2, "Next"], [1, "Previous"], [39, "Next"], [0, "Previous"]].map(([index, direction]) => ({
    counter: `shortVideoGalleryCounter${direction}`, restarted: true, image: `shortVideoGalleryEnter${direction}`, segment: true,
    selected: index, past: index
  })), "native animations must restart even in the same direction, with the correct progress state after jumps");
  await page.emulateMedia({ reducedMotion: "reduce" });
  assert.deepEqual(await page.evaluate(async () => {
    await window.stepGallery(1);
    const gallery = document.querySelector(".short-video-gallery-player");
    return { index: gallery.dataset.galleryIndex,
      hasMotion: Boolean(gallery.querySelector(".is-page-next, .is-page-previous, .is-entering-next, .is-entering-previous")) };
  }), { index: "1", hasMotion: false }, "reduced motion must skip image and counter entrance animations");
  console.log("Gallery step layout passed native animation restart, tab identity, jumps and reduced motion");
} finally { await browser.close(); }
