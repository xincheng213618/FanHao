import assert from "node:assert/strict";
import fs from "node:fs";
import { createMusicAudioSourceStore } from "../android-client/www/modules/music/music-audio-source.js";
import { createMusicProgressSession } from "../android-client/www/modules/music/progress-session.js";
import { captureMusicProgressOwner } from "../android-client/www/modules/music/progress-transport.js";
import { setAccountOwner } from "../android-client/www/js/account-owner.js";

const sourcePath = new URL("../android-client/www/modules/music/music-views.js", import.meta.url);
const currentSource = fs.readFileSync(sourcePath, "utf8");
const args = process.argv.slice(2);
const selectedCase = args.find(arg => arg.startsWith("--case="))?.slice(7);
const withoutSelectionGuards = args.includes("--without-selection-guards");
assert(args.every(arg => arg.startsWith("--case=") || arg === "--without-selection-guards"), "known fixture arguments");
const CLOCK = 1800000000000;
const BASE = "http://android-music-playback-a.invalid:19111";
const OTHER_BASE = "http://android-music-playback-b.invalid:19112";
const tick = () => new Promise(resolve => setImmediate(resolve));

// Like verify_music_progress_clients, this runs actual named function bodies.
// Only HTTP, Audio and presentation surfaces are controlled. The imported audio
// source store and progress/account helpers are actual modules. All bytes are
// synthetic in-memory Blobs; no service, media, browser or database is accessed.
function sourceFunction(source, name) {
  const start = source.search(new RegExp("^  (?:async )?function " + name + "\\(", "m"));
  assert(start >= 0, "actual source function exists: " + name);
  const end = source.slice(start + 1).search(/\n  (?:async )?function /);
  assert(end >= 0, "actual function has a following boundary: " + name);
  return source.slice(start, start + 1 + end);
}

function deferred() {
  let resolvePromise, rejectPromise;
  const item = { settled: false };
  item.promise = new Promise((resolve, reject) => { resolvePromise = resolve; rejectPromise = reject; });
  item.resolve = value => { assert(!item.settled, "deferred settles once"); item.settled = true; resolvePromise(value); };
  item.reject = error => { assert(!item.settled, "deferred settles once"); item.settled = true; rejectPromise(error); };
  return item;
}

function fixture() {
  const reads = [], blobs = [], plays = [], renders = [], remembered = [], preloads = [], fades = [], revoked = [];
  const sourceLoads = [], audioObjects = [], frames = [];
  setAccountOwner(BASE, "account:playback_fixture_a");
  setAccountOwner(OTHER_BASE, "account:playback_fixture_b");
  const deps = { reads, blobs, plays, renders, remembered, preloads, fades, sourceLoads, audioObjects, frames,
    createMusicProgressSession, captureMusicProgressOwner, BASE, CLOCK };
  const audioSourceStore = createMusicAudioSourceStore({
    fetchImpl(url, options) {
      const request = deferred();
      const body = deferred();
      // The transport deliberately ignores AbortSignal; actual source-store
      // cancellation/ownership must still retire a response after settlement.
      blobs.push(Object.assign(request, { body, url, options }));
      return request.promise;
    },
    revokeObjectURL(url) { revoked.push(url); URL.revokeObjectURL(url); }
  });
  deps.audioSourceStore = audioSourceStore;
  const setup = `
    const {reads,blobs,plays,renders,remembered,preloads,fades,sourceLoads,audioObjects,frames,
      createMusicProgressSession,captureMusicProgressOwner,audioSourceStore,BASE,CLOCK}=deps;
    const old={id:"P",title:"prior",streamUrl:"/media/P",durationMs:200000};
    const neighbour={id:"Q",title:"neighbour",streamUrl:"/media/Q"};
    const primaryData={tracks:[old,neighbour],total:2};
    const state={data:primaryData,current:old,queue:[old,neighbour],lyrics:{lines:[],raw:"prior"},
      loading:false,status:"",prevId:"",nextId:"",playbackSpeed:1.25,volume:0.8,fadeSeconds:0.25,
      fullscreen:false,fullPanel:"cover",playing:false,playReportedTrackId:"P",lyricFollowPaused:true};
    let selectedUrl=BASE,moduleActive=true,audio=null,openTrackGeneration=0,pendingTrackSelection=0;
    let playReportSession=7,currentPlaybackUrl=BASE,progressSession=createMusicProgressSession("P",BASE,CLOCK),
      progressClaimRequired=false,playedReport={prior:true},currentLyricIndex=3,gaplessHandoffPending=false;
    let audioLoadHook=null;
    const getActiveUrl=()=>selectedUrl;
    const window={requestAnimationFrame(callback){frames.push(callback);}};
    const absoluteUrl=(url,path)=>new URL(path,url).href;
    const musicListQuery=()=>"sort=updated&favorite=0";
    const fetchJson=(url,path,options)=>{
      const item=deps.deferred();reads.push(Object.assign(item,{url,path,options}));return item.promise;
    };
    class Audio {
      constructor(){this.src="";this.paused=true;this.readyState=3;this.currentTime=0;this.duration=200;
        this.volume=state.volume;this.playbackRate=1;audioObjects.push(this);}
      pause(){this.paused=true;}
      removeAttribute(name){if(name==="src")this.src="";}
      load(){sourceLoads.push({audio:this,src:this.src});if(this.src)audioLoadHook?.(this);}
      play(){
        const item=deps.deferred();
        const owner=progressSession?.capture({trackId:state.current?.id,positionMs:this.currentTime*1000,
          durationMs:this.duration*1000,...captureMusicProgressOwner(currentPlaybackUrl)});
        plays.push(Object.assign(item,{audio:this,id:state.current?.id,src:this.src,session:playReportSession,
          selection:openTrackGeneration,url:currentPlaybackUrl,owner}));
        this.paused=false;return item.promise;
      }
    }
    const ensureAudio=()=>{audio ||= new Audio();};
    const renderShell=()=>renders.push({current:state.current,loading:state.loading,status:state.status,
      pendingTrackSelection,playReportSession,currentPlaybackUrl});
    const cancelCrossfade=()=>{gaplessHandoffPending=false;};
    const cancelProgressClock=()=>{};
    const cancelAudioFade=()=>{};
    const fadeAudioVolume=(target,to,duration)=>{fades.push({target,to,duration});return Promise.resolve(true);};
    const rememberLastTrack=track=>remembered.push(track);
    const scheduleGaplessPreload=()=>preloads.push(state.current);
    const hasLyrics=()=>Boolean(state.lyrics?.lines?.length);
    const updateLyricHighlight=()=>{};
  `;
  deps.deferred = deferred;
  let bodies = ["openTrack", "mergeTrackIntoQueue", "loadAudioTrack", "playAudio"]
    .map(name => sourceFunction(currentSource, name)).join("\n");
  if (withoutSelectionGuards) {
    // A deliberate in-memory negative control. It preserves source-store slot
    // cancellation, URL/DOM guards and the actual business bodies otherwise.
    bodies = bodies.replace("generation === openTrackGeneration && ", "")
      .replace("&& playReportSession === playbackSession &&", "&&")
      .replace("&& currentPlaybackUrl === playbackUrl && playReportSession === session", "&& currentPlaybackUrl === playbackUrl")
      .replace("&& openTrackGeneration === selection", "");
  }
  const expose = `{
    state,open:openTrack,load:loadAudioTrack,merge:mergeTrackIntoQueue,play:playAudio,
    inspect:()=>({audio,openTrackGeneration,pendingTrackSelection,playReportSession,currentPlaybackUrl,
      progressSession,progressClaimRequired,playedReport,moduleActive}),
    source(url){selectedUrl=url;},background(){moduleActive=false;},
    session(){playReportSession++;},
    playbackSource(url){currentPlaybackUrl=url;},
    audioLoadHook(callback){audioLoadHook=callback;},
    dispose(){openTrackGeneration++;playReportSession++;audioSourceStore.cancel("current");
      audioLoadHook=null;audioSourceStore.release(audio);}
  }`;
  const actual = new Function("deps", '"use strict";\n' + setup + "\n" + bodies + "\nreturn " + expose + ";")(deps);
  return { ...actual, reads, blobs, plays, renders, remembered, preloads, fades, revoked, sourceLoads, audioObjects, frames,
    close() {
      actual.dispose();
      for (const item of reads) if (!item.settled) item.reject(new Error("fixture disposed"));
      for (const item of blobs) {
        if (!item.settled) item.resolve({ ok: true, status: 200, blob: () => item.body.promise });
        if (!item.body.settled) item.body.resolve(new Blob([new Uint8Array([73, 68, 51])], { type: "audio/mpeg" }));
      }
      for (const item of plays) if (!item.settled) item.resolve();
    }
  };
}

function metadata(id, label = "fresh") {
  return { track: { id, title: `${id}:${label}`, streamUrl: `/media/${encodeURIComponent(id)}/${label}`, durationMs: 200000,
    positionMs: 42000 }, lyrics: { lines: [{ timeMs: 0, text: `${id}:${label}` }], raw: `${id}:${label}` },
  prevId: `${id}:prev`, nextId: `${id}:next`, serverClockMs: CLOCK };
}

async function startBody(f, index) {
  const item = f.blobs[index];
  assert(item, "actual metadata continuation issued the audio fetch");
  item.resolve({ ok: true, status: 200, blob: () => item.body.promise });
  await tick();
  return item;
}

async function releaseBody(f, index, outcome = "success") {
  const item = f.blobs[index];
  if (!item.settled) await startBody(f, index);
  if (outcome === "error") item.body.reject(new Error("synthetic Blob failure"));
  else item.body.resolve(new Blob([new Uint8Array([73, 68, 51, index])], { type: "audio/mpeg" }));
  await tick();
}

async function complete(f, pending, readIndex, id, label = "fresh") {
  f.reads[readIndex].resolve(metadata(id, label));
  await tick();
  const blobIndex = f.blobs.length - 1;
  await releaseBody(f, blobIndex);
  await pending;
  return blobIndex;
}

function snapshot(f) {
  const owner = f.inspect();
  return { current: f.state.current, data: f.state.data, queue: f.state.queue, lyrics: f.state.lyrics,
    loading: f.state.loading, status: f.state.status, prevId: f.state.prevId, nextId: f.state.nextId,
    audioSrc: owner.audio?.src || "", audioTime: owner.audio?.currentTime, audioVolume: owner.audio?.volume,
    ...owner, renders: f.renders.length, remembered: f.remembered.length, preloads: f.preloads.length,
    plays: f.plays.length, fades: f.fades.length };
}

function unchanged(f, before, message) {
  const after = snapshot(f);
  for (const key of Object.keys(before)) assert.equal(after[key], before[key], `${message}: ${key}`);
}

const cases = [];
function scenario(name, run) { cases.push({ name, run }); }
async function withFixture(run) {
  const f = fixture();
  try { await run(f); }
  finally { f.close(); await tick(); }
}

scenario("normal-play-queue-owner-and-options", () => withFixture(async f => {
  const primary = f.state.data;
  const neighbour = f.state.queue[1];
  f.merge({ id: "A", title: "queued old", rating: 4 });
  const signal = new AbortController().signal;
  const guard = Object.assign(() => true, { signal });
  const pending = f.open(" A ", { renderGuard: guard, seekMs: 12300, openLyrics: true });
  assert.equal(f.reads.length, 1);
  assert.equal(f.reads[0].url, BASE);
  assert.equal(f.reads[0].path, "/api/music/tracks/A?sort=updated&favorite=0");
  assert.equal(f.reads[0].options.timeoutMs, 18000);
  assert.equal(f.reads[0].options.signal, signal);
  await complete(f, pending, 0, "A");
  const owner = f.inspect();
  assert.equal(f.state.current.id, "A"); assert.equal(f.state.data, primary);
  assert.equal(f.state.queue.filter(track => track.id === "A").length, 1);
  assert.equal(f.state.queue.find(track => track.id === "A").rating, 4);
  assert.equal(f.state.queue.find(track => track.id === "Q"), neighbour);
  assert.equal(f.state.fullPanel, "lyrics"); assert.equal(f.state.loading, false); assert.equal(f.state.status, "");
  assert.equal(owner.pendingTrackSelection, 0); assert.equal(owner.playReportSession, 8);
  assert.equal(owner.audio.currentTime, 12.3); assert.equal(owner.audio.playbackRate, 1.25);
  assert.match(owner.audio.src, /^blob:/); assert.equal(f.blobs[0].url, `${BASE}/media/A/fresh`);
  assert.equal(f.blobs[0].options.cache, "no-store"); assert(f.blobs[0].options.signal instanceof AbortSignal);
  assert.equal(f.plays.length, 1); assert.equal(f.plays[0].owner.accountOwner, "account:playback_fixture_a");
  assert.equal(f.plays[0].owner.progressSessionId, owner.progressSession.id);
  assert.equal(f.plays[0].owner.progressSessionStartedAt, CLOCK); assert.equal(f.plays[0].owner.progressSequence, 1);
  assert.equal(owner.progressSession.trackId, "A"); assert.equal(owner.progressSession.activeUrl, BASE);
  assert.equal(f.preloads.length, 1); assert.equal(f.frames.length, 1);
  f.plays[0].resolve(); await tick(); assert.equal(f.fades.length, 1);
}));

scenario("invalid-initial-guard-and-empty-id-no-get", () => withFixture(async f => {
  const before = snapshot(f);
  await f.open("A", { renderGuard: () => false }); await f.open("   ");
  assert.equal(f.reads.length, 0); assert.equal(f.blobs.length, 0); unchanged(f, before, "invalid initial intent");
}));

for (const outcome of ["success", "error"]) {
  for (const newer of ["pending", "complete"]) {
    scenario(`metadata-old-${outcome}-after-B-${newer}`, () => withFixture(async f => {
      const old = f.open("A");
      const next = f.open("B");
      if (newer === "complete") await complete(f, next, 1, "B");
      const before = snapshot(f);
      if (outcome === "success") f.reads[0].resolve(metadata("A", "old"));
      else f.reads[0].reject(new Error("old metadata error"));
      await tick();
      unchanged(f, before, "old metadata cannot publish or clear latest pending token");
      assert.equal(f.blobs.length, newer === "complete" ? 1 : 0);
      await old;
    }));
  }
  scenario(`metadata-same-id-new-selection-${outcome}`, () => withFixture(async f => {
    const old = f.open("A");
    const next = f.open("A");
    await complete(f, next, 1, "A", "new");
    const before = snapshot(f);
    if (outcome === "success") f.reads[0].resolve(metadata("A", "old"));
    else f.reads[0].reject(new Error("same-id old metadata error"));
    await tick(); unchanged(f, before, "same id still has a newer selection");
    assert.equal(f.blobs.length, 1);
    await old;
  }));
  for (const invalidation of ["source", "session", "renderGuard"]) {
    scenario(`metadata-${invalidation}-switch-${outcome}`, () => withFixture(async f => {
      let valid = true;
      const old = f.open("A", { renderGuard: () => valid });
      if (invalidation === "source") f.source(OTHER_BASE);
      if (invalidation === "session") f.session();
      if (invalidation === "renderGuard") valid = false;
      const before = snapshot(f);
      if (outcome === "success") f.reads[0].resolve(metadata("A", "old"));
      else f.reads[0].reject(new Error("retired metadata error"));
      await tick();
      // The finally block owns only its pending token and may release it.
      const after = snapshot(f); before.pendingTrackSelection = after.pendingTrackSelection;
      assert.equal(after.pendingTrackSelection, 0); unchanged(f, before, "retired metadata result");
      assert.equal(f.blobs.length, 0);
      await old;
    }));
  }
  for (const newer of ["pending", "complete"]) {
    scenario(`blob-old-${outcome}-after-B-${newer}`, () => withFixture(async f => {
      const old = f.open("A"); f.reads[0].resolve(metadata("A", "old")); await tick(); await startBody(f, 0);
      const next = f.open("B");
      if (newer === "complete") await complete(f, next, 1, "B");
      const before = snapshot(f);
      await releaseBody(f, 0, outcome); await old;
      unchanged(f, before, "old Blob must not play, render or clear B pending token");
      assert.equal(f.plays.length, newer === "complete" ? 1 : 0);
      if (newer === "pending" && outcome === "success") assert.equal(f.revoked.length, 1, "unpublished old object URL released");
      if (newer === "complete") assert.equal(f.blobs[0].options.signal.aborted, true);
    }));
  }
  scenario(`blob-same-id-new-selection-${outcome}`, () => withFixture(async f => {
    const old = f.open("A"); f.reads[0].resolve(metadata("A", "old")); await tick(); await startBody(f, 0);
    f.open("A");
    const before = snapshot(f);
    await releaseBody(f, 0, outcome); await old;
    unchanged(f, before, "same-id pending selection retires old Blob"); assert.equal(f.plays.length, 0);
  }));
  for (const invalidation of ["source", "session", "renderGuard"]) {
    scenario(`blob-${invalidation}-switch-${outcome}`, () => withFixture(async f => {
      let valid = true;
      const old = f.open("A", { renderGuard: () => valid });
      f.reads[0].resolve(metadata("A", "old")); await tick(); await startBody(f, 0);
      if (invalidation === "source") f.source(OTHER_BASE);
      if (invalidation === "session") f.session();
      if (invalidation === "renderGuard") valid = false;
      const before = snapshot(f);
      await releaseBody(f, 0, outcome); await old;
      before.pendingTrackSelection = f.inspect().pendingTrackSelection;
      assert.equal(before.pendingTrackSelection, 0); unchanged(f, before, "retired Blob result");
      assert.equal(f.plays.length, 0);
    }));
  }
}

for (const stage of ["metadata", "blob"]) {
  scenario(`current-${stage}-failure-can-retry`, () => withFixture(async f => {
    const failed = f.open("A");
    if (stage === "metadata") f.reads[0].reject(new Error("current metadata failed"));
    else { f.reads[0].resolve(metadata("A")); await tick(); await releaseBody(f, 0, "error"); }
    await failed;
    assert.equal(f.state.loading, false); assert.match(f.state.status, stage === "metadata" ? /current metadata failed/ : /Blob failure/);
    assert.equal(f.inspect().pendingTrackSelection, 0); assert.equal(f.plays.length, 0);
    const retry = f.open("A"); await complete(f, retry, 1, "A", "retry");
    assert.equal(f.state.current.title, "A:retry"); assert.equal(f.state.status, "");
    assert.equal(f.plays.length, 1); assert.equal(f.inspect().pendingTrackSelection, 0);
  }));
}

scenario("manual-background-without-render-guard-can-play", () => withFixture(async f => {
  f.background();
  const pending = f.open("A"); await complete(f, pending, 0, "A");
  assert.equal(f.inspect().moduleActive, false); assert.equal(f.state.current.id, "A");
  assert.equal(f.plays.length, 1); assert.equal(f.preloads.length, 1);
}));

scenario("new-selection-in-audio-load-blocks-post-await-autoplay", () => withFixture(async f => {
  let latest;
  f.audioLoadHook(() => { f.audioLoadHook(null); latest = f.open("B"); });
  const old = f.open("A"); f.reads[0].resolve(metadata("A")); await tick(); await releaseBody(f, 0); await old;
  assert.equal(f.reads.length, 2); assert.equal(f.state.loading, true); assert.equal(f.state.status, "正在打开歌曲");
  assert.equal(f.inspect().pendingTrackSelection, 2); assert.equal(f.plays.length, 0); assert.equal(f.preloads.length, 0);
  assert.equal(f.renders.length, 2, "only the two starting intents render while B is pending");
  await complete(f, latest, 1, "B"); assert.equal(f.plays.length, 1); assert.equal(f.plays[0].id, "B");
}));

for (const outcome of ["success", "error"]) {
  for (const invalidation of ["selection", "source", "session"]) {
    scenario(`play-late-${outcome}-after-${invalidation}`, () => withFixture(async f => {
      const opening = f.open("A"); await complete(f, opening, 0, "A");
      assert.equal(f.plays.length, 1);
      if (invalidation === "selection") f.open("A");
      if (invalidation === "source") f.playbackSource(OTHER_BASE);
      if (invalidation === "session") f.session();
      const before = snapshot(f);
      if (outcome === "success") f.plays[0].resolve(); else f.plays[0].reject(new Error("late play blocked"));
      await tick(); unchanged(f, before, "late Audio.play receipt cannot fade or overwrite newer owner");
    }));
  }
}

scenario("current-play-error-and-manual-retry", () => withFixture(async f => {
  const pending = f.open("A"); await complete(f, pending, 0, "A");
  f.plays[0].reject(new Error("current play blocked")); await tick();
  assert.equal(f.state.status, "current play blocked"); assert.equal(f.fades.length, 0);
  assert.equal(f.inspect().audio.volume, f.state.volume);
  f.inspect().audio.paused = true;
  f.play(); assert.equal(f.plays.length, 2); f.plays[1].resolve(); await tick();
  assert.equal(f.fades.length, 1, "current retry completion can apply its fade");
}));

export async function runAndroidMusicPlaybackRequests({ caseName = selectedCase } = {}) {
  const chosen = caseName ? cases.filter(item => item.name === caseName) : cases;
  assert(chosen.length, "known --case name: " + caseName);
  // Keep account-owner persistence in memory even if the invoking Node process
  // happens to configure a localstorage file. Restore the host surface afterward.
  const priorStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  const storage = new Map();
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
    getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, String(value))
  } });
  try {
    for (const item of chosen) { await item.run(); console.log(`PASS ${item.name}`); }
    console.log(`Android music playback requests: ${chosen.length} cases PASS${withoutSelectionGuards ? " (negative control unexpectedly passed)" : ""}`);
    return chosen.length;
  } finally {
    if (priorStorage) Object.defineProperty(globalThis, "localStorage", priorStorage);
    else delete globalThis.localStorage;
  }
}

if (process.argv[1] && new URL(`file:///${process.argv[1].replace(/\\/g, "/")}`).href === import.meta.url) {
  await runAndroidMusicPlaybackRequests();
}
