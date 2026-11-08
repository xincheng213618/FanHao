import assert from "node:assert/strict";
import fs from "node:fs";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const root = fileURLToPath(new URL("../", import.meta.url));
const executablePath = [process.env.CHROME_PATH, "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe"].filter(Boolean).find(fs.existsSync);
assert(executablePath, "installed private Chromium required");
const path = "android-client/www/modules/music/music-views.js";
const originalSource = execFileSync("git", ["show", `f110040d02b1eb579461248da9960e97370fa4d2:${path}`], { cwd: root, encoding: "utf8" });
const originalSelection = originalSource.match(/^  async function openTrack\([\s\S]*?(?=^  function mergeTrackIntoQueue\()/m)?.[0];
assert(originalSelection);

// A silent PCM WAV, generated for this private browser fixture.
const sampleRate = 8000, dataSize = sampleRate * 5 * 2;
const wave = Buffer.alloc(44 + dataSize);
wave.write("RIFF", 0); wave.writeUInt32LE(36 + dataSize, 4); wave.write("WAVEfmt ", 8);
wave.writeUInt32LE(16, 16); wave.writeUInt16LE(1, 20); wave.writeUInt16LE(1, 22);
wave.writeUInt32LE(sampleRate, 24); wave.writeUInt32LE(sampleRate * 2, 28);
wave.writeUInt16LE(2, 32); wave.writeUInt16LE(16, 34); wave.write("data", 36); wave.writeUInt32LE(dataSize, 40);
const track = { id: "synthetic-selection", title: "Synthetic overlap selection", artist: "Fixture",
  durationMs: 5000, positionMs: 0, streamUrl: "/media/music/synthetic-selection" };
const metadataDelayMs = 180, audioDelayMs = 260;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const args = process.argv.slice(2);
assert(args.every(arg => ["--baseline-only", "--current-first"].includes(arg)));
const variants = args.includes("--baseline-only") ? [true] : args.includes("--current-first") ? [false, true] : [true, false];
const server = spawn(process.execPath, ["tests/serve_android_gallery_navigation_fixture.mjs"],
  { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
const serverExit = once(server, "exit");
let browser;
try {
  const origin = await new Promise((resolve, reject) => {
    let output = "";
    const timer = setTimeout(() => reject(Error("private fixture startup timed out")), 10000);
    server.stdout.on("data", bytes => {
      output += bytes;
      const match = /http:\/\/127\.0\.0\.1:\d+/.exec(output);
      if (match) { clearTimeout(timer); resolve(match[0]); }
    });
    server.once("error", error => { clearTimeout(timer); reject(error); });
    server.once("exit", code => { clearTimeout(timer); reject(Error(`private fixture exited (${code})`)); });
  });
  browser = await chromium.launch({ executablePath, headless: true });
  for (const original of variants) {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true });
    const faults = [], requests = [];
    page.on("pageerror", error => faults.push(error.message));
    await page.route(url => url.origin !== origin, route => route.abort());
    if (original) {
      const source = fs.readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
      const pattern = /^  async function openTrack\([\s\S]*?(?=^  function (?:retireTrackAudioPreparation|mergeTrackIntoQueue)\()/m;
      assert(pattern.test(source));
      await page.route(url => url.pathname.endsWith("/modules/music/music-views.js"), route => route.fulfill({
        contentType: "text/javascript", body: source.replace(pattern, () => originalSelection)
      }));
    }
    await page.route(url => url.pathname === "/api/music/tracks", route => route.fulfill({
      json: { total: 1, tracks: [track], limit: 50, offset: 0 }
    }));
    await page.route(url => url.pathname === `/api/music/tracks/${track.id}`, async route => {
      requests.push({ kind: "metadata", start: performance.now() });
      await delay(metadataDelayMs);
      await route.fulfill({ json: { track, lyrics: { lines: [], raw: "" }, serverClockMs: Date.now() } });
    });
    await page.route(url => url.pathname === track.streamUrl, async route => {
      requests.push({ kind: "audio", start: performance.now() });
      await delay(audioDelayMs);
      await route.fulfill({ contentType: "audio/wav", body: wave });
    });
    await page.addInitScript(() => {
      const play = HTMLMediaElement.prototype.play;
      HTMLMediaElement.prototype.play = function(...args) {
        this.addEventListener("playing", () => { globalThis.fixtureStartedPlaying = performance.now(); }, { once: true });
        return play.apply(this, args);
      };
      document.addEventListener("click", event => {
        if (event.target.closest(".music-mobile-track")) globalThis.fixtureSelectedTrack = performance.now();
      }, { capture: true });
    });
    try {
      const run = await page.request.post(`${origin}/fixture/new-run?scenario=music-playlists`);
      assert(run.ok(), await run.text());
      const url = new URL((await run.json()).url, origin);
      url.hash = "music?mode=library&dashboard=0";
      await page.goto(url.href);
      const row = page.locator(".music-mobile-track").filter({ hasText: track.title });
      await row.waitFor({ timeout: 10000 });
      assert.deepEqual(requests, [], "loading the catalogue must not download audio");
      await row.click();
      await page.waitForFunction(() => Number.isFinite(globalThis.fixtureStartedPlaying));
      const playMs = Math.round(await page.evaluate(() => globalThis.fixtureStartedPlaying - globalThis.fixtureSelectedTrack));
      await page.locator(".music-mobile-mini-player.is-playing").waitFor();
      assert.deepEqual(requests.map(({ kind }) => kind).sort(), ["audio", "metadata"], "one audio and one metadata request");
      assert.deepEqual(faults, []);
      const startGapMs = Math.round(Math.abs(requests[0].start - requests[1].start));
      if (original) assert(startGapMs >= metadataDelayMs - 5, "baseline serializes requests");
      else assert(startGapMs < metadataDelayMs / 2, "selection starts both reads before metadata returns");
      console.log(JSON.stringify({ variant: original ? "baseline" : "current", startGapMs, playMs, requests: requests.length, wavBytes: wave.length }));
    } finally {
      await page.close();
    }
  }
} finally {
  await browser?.close();
  server.kill();
  await serverExit;
}
