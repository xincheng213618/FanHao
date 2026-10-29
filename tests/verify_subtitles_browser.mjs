import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createServer } from "node:http";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const root = fileURLToPath(new URL("../public/", import.meta.url));
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "fanhao-subtitles-browser-"));
const mediaPath = path.join(temporary, "neutral.mp4");
const ffmpeg = spawnSync(process.env.FFMPEG_PATH || "ffmpeg", ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=0x263d36:s=320x180:r=2", "-t", "60", "-an", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-movflags", "+faststart", "-y", mediaPath], { encoding: "utf8", windowsHide: true, timeout: 30_000 });
assert.equal(ffmpeg.status, 0, `synthetic neutral media generation failed: ${ffmpeg.stderr || ffmpeg.error || ""}`);
const media = fs.readFileSync(mediaPath);
const work = { id: "subtitle-work", title: "中性字幕验证视频", relativePath: "fixture", videos: ["a", "b"].map((id) => ({ id: `subtitle-${id}`, name: `TEST-001 中性片段 ${id}.mp4`, playable: true, ext: ".mp4", size: media.length, relativePath: `fixture/${id}.mp4` })), infos: [], images: [], infoSummary: { code: "错误的人物资料" }, people: [] };
const requests = [];
const uploaded = [];
let mode = "direct", failList = false, delaySearch = false, probedDuration = 60;
const extraTracks = new Map();
function track(id, label, language = "zh", autoSelect = false) { return { id, label, language, autoSelect, format: "srt", match: "exact", source: "local", url: `/api/works/subtitle-work/subtitles/vtt/${id}?videoId=subtitle-a`, downloadUrl: `/api/works/subtitle-work/subtitles/original/${id}?videoId=subtitle-a` }; }
function tracks(videoId) { return videoId === "subtitle-a" ? [track("zh", "简体中文 · 精确匹配", "zh-Hans", true), track("en", "English", "en"), track("ambiguous", "中文 · 待核对", "zh", false), ...extraTracks.values()] : []; }
function time(seconds) { const value = Math.max(0, seconds); return `00:00:${String(Math.floor(value)).padStart(2, "0")}.000`; }
function vtt(id, offset) {
  const text = id === "en" ? "English subtitle fixture" : id === "uploaded" ? "本地字幕验证" : "中文字幕测试";
  const cues = [[5, 9], [21, 29], [40, 49]].filter(([, end]) => end + offset > 0).map(([start, end]) => `${time(start + offset)} --> ${time(end + offset)}\n${text}\n`);
  return `WEBVTT\n\n${cues.join("\n")}`;
}
const drawerHtml = `<!doctype html><html lang="zh"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/css/foundation.css"><link rel="stylesheet" href="/css/player.css"><style>body{margin:0;background:#e8eeeb}.detail-drawer{position:relative;display:block;width:100%;height:100vh;transform:none!important;visibility:visible!important}#playerArea{position:relative;height:70vh;min-height:420px}#drawerSide{height:28vh;overflow:auto}#drawerTitle,#drawerPath{margin:0}.drawer-backdrop{display:none}</style></head><body><div id="backdrop"></div><section id="drawer" class="detail-drawer"><button id="close">关闭播放器</button><h2 id="drawerTitle"></h2><p id="drawerPath"></p><div id="playerArea"></div><div id="drawerSide"><div id="metaArea"></div><div id="infoArea"></div></div></section><script type="module">
import { createWorkDetailPage } from '/modules/fanhao/work-detail-page.js';
const ids = {detailDrawer:'drawer',drawerBackdrop:'backdrop',closeDrawer:'close',drawerTitle:'drawerTitle',drawerPath:'drawerPath',playerArea:'playerArea',drawerSide:'drawerSide',metaArea:'metaArea',infoArea:'infoArea'};
const els = Object.fromEntries(Object.entries(ids).map(([key,id])=>[key,document.getElementById(id)]));
const state = {works:[],people:[],library:{user:{}},accessHints:{},currentStreamOffset:0,favoriteFolders:[]};
const api = async (url,opts={}) => { const response=await fetch(url,{...opts,headers:{'Content-Type':'application/json'},body:opts.body?JSON.stringify(opts.body):undefined}); const data=await response.json();if(!response.ok)throw new Error(data.error);return data; };
const noop=()=>{};
const detail=createWorkDetailPage({api,state,els,addQueryParam:(url,key,value)=>url+(url.includes('?')?'&':'?')+key+'='+encodeURIComponent(value),coverRetryDelays:[],formatBytes:(v)=>v+' B',formatLibraryPath:(v)=>v||'',formatTime:(v)=>String(Math.floor(v)),goToPerson:noop,searchWorksByText:noop,openWorkCard:noop,renderFavoriteFolderControls:noop,renderStatsForWorks:noop,renderWorks:noop,retryCoverUrl:(v)=>v,syncRouteAfterNavigation:noop,workCoverUrl:()=>'',workPersonDisplayName:()=>''});
window.fixtureDetail=detail;document.getElementById('close').addEventListener('click',()=>detail.closeDrawer());await detail.openWork('subtitle-work');window.fixtureDrawerProblem=document.getElementById('drawerTitle').textContent==='打开失败'?document.getElementById('playerArea').textContent:'';
</script></body></html>`.replace(".detail-drawer{position:relative;", ".detail-drawer{position:relative;left:0!important;top:0!important;");

const server = createServer(async (req, res) => {
  const url = new URL(req.url, "http://fixture");
  requests.push({ method: req.method, url });
  if (url.pathname === "/fixture-drawer") { res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }); res.end(drawerHtml); return; }
  if (url.pathname === "/fixture-media.mp4") {
    const range = /bytes=(\d+)-(\d*)/.exec(req.headers.range || "");
    const start = Number(range?.[1] || 0), end = range?.[2] ? Math.min(Number(range[2]), media.length - 1) : media.length - 1;
    res.writeHead(range ? 206 : 200, { "Content-Type": "video/mp4", "Accept-Ranges": "bytes", "Content-Length": end - start + 1, ...(range ? { "Content-Range": `bytes ${start}-${end}/${media.length}` } : {}) }); res.end(media.subarray(start, end + 1)); return;
  }
  if (url.pathname.includes("/subtitles/vtt/")) { res.writeHead(200, { "Content-Type": "text/vtt; charset=utf-8" }); res.end(vtt(url.pathname.split("/").at(-1), Number(url.searchParams.get("offsetSeconds")) || 0)); return; }
  if (url.pathname.includes("/subtitles/original/")) { res.writeHead(200, { "Content-Type": "application/x-subrip", "Content-Disposition": 'attachment; filename="fixture.srt"' }); res.end("1\n00:00:05,000 --> 00:00:09,000\nneutral fixture\n"); return; }
  if (url.pathname.startsWith("/api/")) {
    let payload = {}, status = 200;
    if (url.pathname === "/api/works/subtitle-work") payload = { work };
    else if (url.pathname.startsWith("/api/playinfo/")) payload = { mode, streamUrl: "/fixture-media.mp4", duration: probedDuration, label: mode === "direct" ? "直接播放" : "转码测试" };
    else if (url.pathname.endsWith("/subtitles")) { payload = failList ? { error: "字幕列表测试失败" } : { query: "TEST-001", tracks: tracks(url.searchParams.get("videoId")) }; status = failList ? 503 : 200; }
    else if (url.pathname.endsWith("/subtitles/search")) {
      if (delaySearch) await new Promise((resolve) => setTimeout(resolve, 600));
      payload = { source: "SubtitleCat", query: url.searchParams.get("query"), results: [{ id: "result-1", title: 'TEST-001 <img> 中性测试字幕', pageUrl: "https://www.subtitlecat.com/subs/fixture.html" }] };
    } else if (url.pathname.endsWith("/files")) payload = { files: [{ id: "file-zh", name: "Chinese.srt", language: "Chinese" }] };
    else if (url.pathname.endsWith("/download") || url.pathname.endsWith("/upload")) {
      let body = ""; for await (const chunk of req) body += chunk;
      const data = JSON.parse(body); const upload = url.pathname.endsWith("/upload");
      if (upload) uploaded.push(data);
      const saved = track(upload ? "uploaded" : "online", upload ? "本地导入字幕" : "在线下载中文"); extraTracks.set(saved.id, saved);
      payload = { track: saved, tracks: tracks(data.videoId), sidecarName: saved.name || `${saved.id}.srt`, savedBesideVideo: true };
    } else if (url.pathname.startsWith("/api/progress/")) payload = { progress: {} };
    res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" }); res.end(JSON.stringify(payload)); return;
  }
  const target = path.resolve(root, `.${url.pathname}`);
  if (!target.startsWith(`${path.resolve(root)}${path.sep}`) || !fs.statSync(target, { throwIfNoEntry: false })?.isFile()) { res.writeHead(404); res.end(); return; }
  const type = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml" }[path.extname(target)] || "application/octet-stream";
  res.writeHead(200, { "Content-Type": `${type}; charset=utf-8` }); fs.createReadStream(target).pipe(res);
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
let browser;
try {
  const executablePath = process.env.FANHAO_CHROME_PATH || ["C:/Program Files/Google/Chrome/Application/chrome.exe", "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", "/usr/bin/chromium", "/usr/bin/google-chrome"].find((candidate) => fs.existsSync(candidate));
  assert(executablePath, "a Chromium browser is required");
  browser = await chromium.launch({ executablePath, headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 850 }, acceptDownloads: true });
  const errors = []; page.on("pageerror", (error) => errors.push(error.message));
  const address = `http://127.0.0.1:${server.address().port}`;
  const screenshotIndex = process.argv.indexOf("--screenshots");
  const screenshotDir = screenshotIndex >= 0 ? path.resolve(process.argv[screenshotIndex + 1]) : null;
  if (screenshotDir) fs.mkdirSync(screenshotDir, { recursive: true });
  await page.addInitScript(() => {
    window.fixtureObjectUrls = { created: 0, revoked: 0 };
    const create = URL.createObjectURL.bind(URL), revoke = URL.revokeObjectURL.bind(URL);
    URL.createObjectURL = (...args) => { window.fixtureObjectUrls.created++; return create(...args); };
    URL.revokeObjectURL = (...args) => { window.fixtureObjectUrls.revoked++; return revoke(...args); };
  });
  async function waitTrack(id, offset = 0) {
    await page.waitForFunction(({ id, offset }) => {
      const track = document.querySelector("video track[data-subtitle-id]");
      return track?.dataset.subtitleId === id && track.readyState === 2 && Number(new URL(track.src).searchParams.get("offsetSeconds")) === offset;
    }, { id, offset });
  }
  async function pauseAt(time) { await page.locator("video").evaluate((video, at) => { video.pause(); video.currentTime = at; }, time); }
  async function openControls() { const details = page.locator(".subtitle-controls"); if (!await details.evaluate((element) => element.open)) await details.locator("summary").click(); }
  async function checkCaption(text) { await page.waitForFunction((value) => document.querySelector(".fanhao-subtitle-cues")?.textContent.includes(value), text); }
  async function clickFullscreen(button, surface) {
    // Wake the same hover/idle lifecycle a person uses before targeting controls.
    await surface.hover({ position: { x: 40, y: 40 } });
    const element = await button.elementHandle();
    try {
      await page.waitForFunction((target) => {
        if (!target?.isConnected) return false;
        const controls = target.closest(".plyr__controls,.player-chrome-bottom");
        if (!controls) return false;
        const style = getComputedStyle(controls);
        if (style.visibility !== "visible" || Number(style.opacity) < 0.99 || style.pointerEvents === "none"
          || controls.getAnimations().some((animation) => animation.playState === "running")) return false;
        const rect = target.getBoundingClientRect();
        const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
        return rect.width > 0 && rect.height > 0 && Boolean(hit && target.contains(hit));
      }, element);
      await button.hover();
      await button.click();
    } finally { await element?.dispose(); }
  }

  for (const scenario of [{ hint: 60, steps: 6 }, { hint: 600, steps: 9 }]) {
    probedDuration = scenario.hint;
    let release;
    const held = new Promise(resolve => { release = resolve; });
    const holdMedia = async route => { await held; await route.continue(); };
    await page.route("**/fixture-media.mp4", holdMedia);
    try {
      await page.goto(`${address}/player.html?workId=subtitle-work`, { waitUntil: "domcontentloaded" });
      await page.waitForFunction(() => document.querySelector("#playerVideo")?.src.endsWith("/fixture-media.mp4") && !document.querySelector("#playerVideo").hidden);
      assert.equal(await page.locator("#playerVideo").evaluate(video => video.readyState), 0, "the synthetic MP4 is held before metadata");
      for (let index = 0; index < scenario.steps; index++) await page.keyboard.press("ArrowRight");
      const corrected = scenario.hint === 600 ? page.waitForResponse(response => response.url().endsWith("/api/progress/subtitle-a")
        && response.request().postDataJSON()?.position === 60 && response.request().postDataJSON()?.duration === 60) : null;
      release();
      await page.waitForFunction(() => {
        const video = document.querySelector("#playerVideo");
        return video?.readyState >= 2 && !video.seeking && video.currentTime >= video.duration - .05;
      });
      assert.equal(await page.locator("#playerVideo").evaluate(video => video.paused), true, "terminal pending seeks must not replay the decoded MP4");
      if (corrected) await corrected;
      await page.keyboard.press("Space");
      await page.waitForFunction(() => {
        const video = document.querySelector("#playerVideo");
        return video && !video.paused && video.currentTime < 2;
      });
      console.log(`PASS decoded MP4 terminal seek and explicit replay (duration hint ${scenario.hint}s, actual 60s)`);
    } finally {
      release();
      await page.unroute("**/fixture-media.mp4", holdMedia);
    }
  }
  probedDuration = 60;
  for (const scenario of [{ playbackMode: "direct", position: 6.5, relative: 6.5 }, { playbackMode: "transcode", position: 20.25, relative: .25 }]) {
    mode = scenario.playbackMode;
    let release;
    const held = new Promise(resolve => { release = resolve; });
    const holdMedia = async route => { await held; await route.continue(); };
    await page.route("**/fixture-media.mp4*", holdMedia);
    try {
      await page.goto(`${address}/player.html?workId=subtitle-work&t=${scenario.position}`, { waitUntil: "domcontentloaded" });
      await page.waitForFunction(() => document.querySelector("#playerVideo")?.src.includes("/fixture-media.mp4") && !document.querySelector("#playerVideo").hidden);
      if (await page.locator("#playerVideo").evaluate(video => video.paused)) await page.keyboard.press("k");
      await page.keyboard.press("k");
      release();
      await page.waitForFunction(() => { const video = document.querySelector("#playerVideo"); return video?.readyState >= 2 && !video.seeking; });
      const position = await page.locator("#playerVideo").evaluate(video => ({ time: video.currentTime, paused: video.paused }));
      assert(Math.abs(position.time - scenario.relative) < .01, `URL time must select its native decoded position in ${scenario.playbackMode}: ${position.time}`);
      assert.equal(position.paused, true, "the pending link must preserve an explicit pause before metadata");
      console.log(`PASS decoded MP4 URL position ${scenario.position}s (${scenario.playbackMode})`);
      if (scenario.playbackMode === "direct") {
        await page.locator("#playerTimeJumpButton").click();
        const dialog = page.getByRole("dialog", { name: "跳到时间", exact: true });
        await dialog.getByLabel("播放位置", { exact: true }).fill("0:11.75");
        await dialog.getByRole("button", { name: "跳转", exact: true }).click();
        await page.waitForFunction(() => { const video = document.querySelector("#playerVideo"); return !video.seeking && Math.abs(video.currentTime - 11.75) < .01; });
        assert.equal(await page.locator("#playerVideo").evaluate(video => video.paused), true, "manual time jump must preserve an actually decoded video's explicit pause");
        console.log("PASS decoded MP4 manual time jump to 11.75s remains paused");
      }
    } finally { release(); await page.unroute("**/fixture-media.mp4*", holdMedia); }
  }
  mode = "direct";
  await page.goto(`${address}/player.html?workId=subtitle-work`); await waitTrack("zh");
  await pauseAt(6); await checkCaption("中文字幕测试");
  await clickFullscreen(page.locator('[data-plyr="fullscreen"]'), page.locator(".plyr"));
  await page.waitForFunction(() => document.fullscreenElement?.contains(document.querySelector(".fanhao-subtitle-cues")));
  assert(await page.locator(".fanhao-subtitle-cues").isVisible(), "the subtitle overlay remains visible inside Plyr fullscreen");
  await page.keyboard.press("g");
  const fullscreenJump = page.getByRole("dialog", { name: "跳到时间", exact: true });
  await fullscreenJump.waitFor({ state: "visible" });
  await fullscreenJump.getByLabel("播放位置", { exact: true }).fill("6.25");
  await fullscreenJump.getByRole("button", { name: "跳转", exact: true }).click();
  await page.waitForFunction(() => { const video = document.querySelector("#playerVideo"); return !video.seeking && Math.abs(video.currentTime - 6.25) < .01; });
  assert.equal(await page.locator("#playerVideo").evaluate(video => video.paused && document.fullscreenElement?.contains(video)), true, "fullscreen time jump must preserve decoded playback pause and fullscreen ownership");
  console.log("PASS decoded MP4 G time jump remains paused inside fullscreen");
  await page.evaluate(() => document.exitFullscreen());
  await openControls();
  assert.equal(await page.getByRole("searchbox", { name: "字幕搜索番号" }).inputValue(), "TEST-001", "the API-derived video code overrides incorrect work metadata");
  await page.getByRole("searchbox", { name: "字幕搜索番号" }).fill("CUSTOM-999");
  const previousTrack = await page.locator("video track[data-subtitle-id]").elementHandle();
  await page.getByRole("button", { name: "重新读取", exact: true }).click();
  await page.waitForFunction((element) => !element.isConnected, previousTrack);
  await waitTrack("zh");
  await previousTrack.dispose();
  assert.equal(await page.getByRole("searchbox", { name: "字幕搜索番号" }).inputValue(), "CUSTOM-999", "reloading tracks preserves a manually edited query");
  assert.equal(await page.getByRole("combobox", { name: "字幕轨道" }).inputValue(), "zh", "only explicitly safe Chinese tracks auto-select");
  await page.getByRole("combobox", { name: "字幕轨道" }).selectOption("");
  assert.equal(await page.locator("video track[data-subtitle-id]").count(), 0);
  assert.equal(await page.locator(".fanhao-subtitle-cues").innerText(), "");
  await page.getByRole("combobox", { name: "字幕轨道" }).selectOption("en"); await waitTrack("en");
  await pauseAt(6); await checkCaption("English subtitle fixture");
  const before = await page.locator("video").evaluate((video) => video.currentTime);
  await page.getByRole("searchbox", { name: "字幕搜索番号" }).fill("TEST-001");
  await page.getByRole("button", { name: "搜索字幕", exact: true }).click();
  await page.getByRole("button", { name: "查看语言与文件" }).click();
  assert.equal(await page.locator(".subtitle-online-results img").count(), 0);
  await page.getByRole("button", { name: /下载并使用/ }).click(); await waitTrack("online");
  assert.equal(await page.locator("video").evaluate((video) => video.currentTime), before, "search/download do not seek or restart playback");
  const gbBytes = Buffer.from([49, 10, 48, 48, 58, 48, 48, 58, 48, 53, 44, 48, 48, 48, 32, 45, 45, 62, 32, 48, 48, 58, 48, 48, 58, 48, 57, 44, 48, 48, 48, 10, 0xd6, 0xd0, 0xce, 0xc4]);
  await page.getByLabel("加载本地字幕", { exact: true }).setInputFiles({ name: "local-gb.srt", mimeType: "application/x-subrip", buffer: gbBytes }); await waitTrack("uploaded");
  assert.deepEqual(Buffer.from(uploaded.at(-1).contentBase64, "base64"), gbBytes, "uploads preserve original bytes for legacy encoding conversion");
  assert.equal(await page.locator("video").evaluate((video) => video.currentTime), before);
  const downloadEvent = page.waitForEvent("download"); await page.getByRole("link", { name: "下载原字幕" }).click();
  assert.match((await downloadEvent).suggestedFilename(), /fixture.srt/);
  failList = true; await page.getByRole("button", { name: "重新读取", exact: true }).click();
  await page.getByRole("button", { name: "重试", exact: true }).waitFor();
  failList = false; await page.getByRole("button", { name: "重试", exact: true }).click(); await waitTrack("uploaded");
  if (screenshotDir) { await pauseAt(6); await page.screenshot({ path: path.join(screenshotDir, "subtitles-player-neutral.png") }); }
  await page.setViewportSize({ width: 390, height: 844 });
  if (await page.locator("#toggleSidebarButton").getAttribute("aria-expanded") === "true") await page.locator("#toggleSidebarButton").click();
  await page.waitForFunction(() => getComputedStyle(document.getElementById("playerSidebar")).opacity === "0");
  await openControls();
  await page.getByRole("combobox", { name: "字幕轨道" }).waitFor({ state: "visible" });
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), "the subtitle panel must fit a 390px screen");
  if (screenshotDir) await page.screenshot({ path: path.join(screenshotDir, "subtitles-player-mobile-neutral.png") });
  await page.setViewportSize({ width: 1280, height: 850 });
  delaySearch = true; await page.getByRole("button", { name: "搜索字幕", exact: true }).click();
  await page.getByRole("button", { name: "取消请求", exact: true }).click();
  if (await page.locator("#toggleSidebarButton").getAttribute("aria-expanded") === "false") await page.locator("#toggleSidebarButton").click();
  await page.locator("#playerFiles button").nth(1).click();
  await page.waitForFunction(() => document.querySelector(".subtitle-status")?.textContent.includes("没有匹配字幕"));
  await page.waitForTimeout(700);
  assert.equal(await page.locator(".subtitle-result").count(), 0, "cancelled searches cannot paint after switching files");
  assert.equal(await page.locator("video track[data-subtitle-id]").count(), 0);
  delaySearch = false;

  mode = "transcode";
  await page.goto(`${address}/player.html?workId=subtitle-work`); await waitTrack("zh"); await pauseAt(6);
  await openControls(); await page.getByRole("combobox", { name: "字幕轨道" }).selectOption("en"); await waitTrack("en");
  const streamsBeforePausedSeek = requests.filter((request) => request.url.pathname === "/fixture-media.mp4").length;
  await page.locator("#playerSeekRange").evaluate((seek) => { seek.value = "20"; seek.dispatchEvent(new Event("change", { bubbles: true })); });
  await waitTrack("en", -20);
  assert.equal(await page.locator("video").evaluate((video) => video.paused && video.readyState === 0), true, "paused compatibility seeking must defer media activation even after its VTT has loaded");
  assert.equal(requests.filter((request) => request.url.pathname === "/fixture-media.mp4").length, streamsBeforePausedSeek, "a paused compatibility seek must not silently start a new media request");
  // VTT loading alone does not establish a media timeline. Start the deferred
  // source through its actual user control before seeking into an active cue.
  await page.getByRole("button", { name: "开始播放", exact: true }).click();
  await page.waitForFunction(() => document.querySelector("video").readyState >= 2 && !document.querySelector("video").paused);
  await pauseAt(2); await checkCaption("English subtitle fixture");
  assert.equal(await page.getByRole("combobox", { name: "字幕轨道" }).inputValue(), "en");
  await page.getByRole("combobox", { name: "字幕轨道" }).selectOption("");
  await page.locator("#playerSeekRange").evaluate((seek) => { seek.value = "30"; seek.dispatchEvent(new Event("change", { bubbles: true })); });
  assert.equal(await page.locator("video track[data-subtitle-id]").count(), 0, "off remains off across segmented seeks");

  await page.goto(`${address}/fixture-drawer`); await waitTrack("zh"); await pauseAt(6); await checkCaption("中文字幕测试");
  assert.equal(await page.evaluate(() => window.fixtureDrawerProblem), "", "the drawer fixture must complete its normal work open flow");
  await openControls(); await page.getByRole("combobox", { name: "字幕轨道" }).selectOption("en"); await waitTrack("en");
  await page.locator(".player-chrome-seek").evaluate((seek) => { seek.value = "20"; seek.dispatchEvent(new Event("change", { bubbles: true })); });
  await waitTrack("en", -20); await pauseAt(2); await checkCaption("English subtitle fixture");
  await openControls();
  assert.equal(await page.getByRole("combobox", { name: "字幕轨道" }).inputValue(), "en", "drawer stream reconstruction retains selection");
  {
    const full = page.locator('.player-chrome-bottom button').filter({ hasText: /^全屏$/ });
    await clickFullscreen(full, page.locator(".web-player-shell"));
    await page.waitForFunction(() => document.fullscreenElement?.contains(document.querySelector(".fanhao-subtitle-cues")));
    assert(await page.locator(".fanhao-subtitle-cues").isVisible(), "drawer fullscreen keeps its subtitle layer");
    await page.evaluate(() => document.exitFullscreen());
  }
  if (screenshotDir) await page.screenshot({ path: path.join(screenshotDir, "subtitles-drawer-neutral.png") });
  await page.getByRole("button", { name: "关闭播放器", exact: true }).click();
  assert.equal(await page.locator("video track[data-subtitle-id]").count(), 0);
  mode = "direct";
  await page.goto(`${address}/fixture-drawer`); await waitTrack("zh"); await pauseAt(6); await checkCaption("中文字幕测试");
  await openControls(); await page.getByRole("combobox", { name: "字幕轨道" }).selectOption("en"); await waitTrack("en");
  await page.locator(".player-chrome-seek").evaluate((seek) => { seek.value = "22"; seek.dispatchEvent(new Event("change", { bubbles: true })); });
  await checkCaption("English subtitle fixture"); await waitTrack("en", 0);
  assert.equal(await page.locator("video").evaluate((video) => video.currentTime), 22, "direct drawer seeks retain the original subtitle timebase");
  await page.getByRole("button", { name: "关闭播放器", exact: true }).click();
  assert.deepEqual(await page.evaluate(() => window.fixtureObjectUrls), { created: 0, revoked: 0 }, "subtitle loading uses server URLs and leaves no object URLs to leak");
  assert.deepEqual(errors, []);
  assert(requests.some(({ url }) => url.pathname.includes("/subtitles/vtt/en") && url.searchParams.get("offsetSeconds") === "-20"));
  console.log("Subtitle browser checks passed: both players render real VTT cues on synthetic media, safe Chinese auto-selection, off/manual tracks, online search/download, original-byte upload, download, retry, cancellation, file switching, 390px panel and segmented seek offsets.");
} finally {
  await browser?.close(); await new Promise((resolve) => server.close(resolve));
  fs.unlinkSync(mediaPath); fs.rmdirSync(temporary);
}
