import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import { createMusicProgressSession, createMusicPlayedReport, musicProgressBody } from "../public/modules/music/progress-session.js";
import { createMusicApi } from "../public/modules/music/api.js";
import { captureMusicProgressOwner, sendMusicProgress } from "../android-client/www/modules/music/progress-transport.js";
import { setAccountOwner } from "../android-client/www/js/account-owner.js";

test("capture ordering remains attached to the owner that measured the position", () => {
  const a = createMusicProgressSession("track", "", 1800000000000);
  const old = a.capture({ trackId: "track", positionMs: 10, durationMs: 100 });
  const newer = a.capture({ trackId: "track", positionMs: 90, durationMs: 100 });
  const b = createMusicProgressSession("track", "", 1800000000001);
  const next = b.capture({ trackId: "track", positionMs: 5, durationMs: 100 });
  assert.equal(old.progressSequence, 1); assert.equal(newer.progressSequence, 2);
  assert.equal(next.progressSequence, 1); assert.notEqual(next.progressSessionId, old.progressSessionId);
  assert.equal(old.positionMs, 10); assert.equal(old.progressSessionStartedAt, 1800000000000);
});

test("server-issued owner is retained while local sequence continues", () => {
  const id = crypto.randomUUID();
  const owner = createMusicProgressSession("track", "", 1800000000000, id);
  assert.equal(owner.id, id); assert.equal(owner.capture({ trackId: "track" }).progressSessionId, id);
  assert.equal(owner.capture({ trackId: "track" }).progressSequence, 2);
  for (const clock of [undefined, NaN, -1, 1.5, "1"]) assert.equal(createMusicProgressSession("track", "", clock), null);
  assert.equal(createMusicProgressSession("track", "", 1, "invalid"), null);
});

test("payload keeps played receipt separate and omits local account metadata", () => {
  const owner = createMusicProgressSession("track", "", 1800000000000);
  const report = createMusicPlayedReport(owner);
  const record = { ...owner.capture({ trackId: "track", positionMs: 42, durationMs: 100 }), ...report,
    accountOwner: "account:fixture", webAccountRevision: "revision", reportKey: "local-key" };
  const normal = musicProgressBody(record, false), played = musicProgressBody(record, true);
  assert(!Object.hasOwn(normal, "playedReportId")); assert.equal(played.playedReportId, report.playedReportId);
  assert.equal(played.playedReportStartedAt, owner.startedAt); assert.equal(played.progressSequence, normal.progressSequence);
  assert(!Object.hasOwn(played, "accountOwner")); assert(!Object.hasOwn(played, "reportKey"));
  assert.deepEqual(musicProgressBody({ positionMs: 0, durationMs: 100 }, true), { positionMs: 0, durationMs: 100, played: true });
});

test("Web claim and leave transports start immediately with encoded track identity", async () => {
  const calls = [];
  const api = createMusicApi((path, options) => { calls.push({ path, options }); return Promise.resolve({ ok: true }); });
  const id = crypto.randomUUID();
  const claim = api.claimProgressSession("track/a", id);
  assert.equal(calls.length, 1); assert.equal(calls[0].path, "/api/music/tracks/track%2Fa/progress-session");
  assert.deepEqual(calls[0].options.body, { previousSessionId: id });
  const leave = api.setProgressKeepalive("track/a", { positionMs: 42 });
  assert.equal(calls.length, 2); assert.equal(calls[1].options.keepalive, true);
  assert.equal(calls[1].options.method, "POST"); await Promise.all([claim, leave]);
});

test("Android leave sends synchronously to the captured server and account", async t => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  const calls = [], base = "http://music-scope-a.invalid:18101";
  setAccountOwner(base, "account:fixture_a");
  globalThis.fetch = (url, options) => {
    calls.push({ url, options });
    return Promise.resolve({ ok: true, status: 200, headers: new Headers(), json: async () => ({ ok: true }) });
  };
  const record = { ...captureMusicProgressOwner(base), trackId: "same/id", positionMs: 12, durationMs: 100 };
  const promise = sendMusicProgress(record, false, true);
  assert.equal(calls.length, 1, "pagehide must not wait for account discovery or a timer");
  assert.equal(calls[0].url, `${base}/api/music/tracks/same%2Fid/progress`);
  assert.equal(calls[0].options.headers["X-FanHao-Account-Owner"], "account:fixture_a");
  assert.equal(calls[0].options.keepalive, true); assert.deepEqual(JSON.parse(calls[0].options.body), { positionMs: 12, durationMs: 100 });
  await promise;
});

test("Android queued work cannot inherit a later account on the same server", async t => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  const base = "http://music-scope-b.invalid:18102";
  setAccountOwner(base, "account:fixture_a");
  const record = { ...captureMusicProgressOwner(base), trackId: "track", positionMs: 12, durationMs: 100 };
  setAccountOwner(base, "account:fixture_b");
  let calls = 0;
  globalThis.fetch = () => { calls++; assert.fail("old account must not issue a network write"); };
  await assert.rejects(sendMusicProgress(record, true, true), error => error.code === "ACCOUNT_CHANGED");
  assert.equal(calls, 0);
});

const SOURCE_ROOT = new URL("../", import.meta.url);
const sourceText = file => fs.readFileSync(new URL(file, SOURCE_ROOT), "utf8");
const webActionsSource = sourceText("public/modules/music/actions.js");
const webPageSource = sourceText("public/modules/music/music-page.js");
const webEngineSource = sourceText("public/modules/music/player/engine.js");
const androidViewsSource = sourceText("android-client/www/modules/music/music-views.js");
const CLOCK = 1800000000000;
const ID = n => "00000000-0000-4000-8000-" + String(n).padStart(12, "0");
const tick = () => new Promise(resolve => setImmediate(resolve));

// Run the actual named function bodies with controlled platform surfaces. The
// extraction leaves business gates/sequence/claim logic unchanged; it replaces
// only HTTP, Audio, DOM presentation and account discovery. No real service,
// browser profile, media, credentials, or SQLite is used by these VM cases.
function sourceFunction(source, name) {
  const expression = new RegExp("^  (?:async )?function " + name + "\\(", "m");
  const start = source.search(expression);
  assert(start >= 0, "actual source function exists: " + name);
  const tail = source.slice(start + 1);
  const end = tail.search(/\n  (?:async )?function /);
  assert(end >= 0, "actual function has a following boundary: " + name);
  return source.slice(start, start + 1 + end);
}
function compile(source, names, setup, expose, deps) {
  return new Function("deps", '"use strict";\n' + setup + "\n" +
    names.map(name => sourceFunction(source, name)).join("\n") + "\nreturn " + expose + ";")(deps);
}

function clientFixture(platform, { modern = true, playId = 1 } = {}) {
  const claims = [], reads = [], saved = [], playedRecords = [], leave = [], audioAttempts = [], loaded = [], retired = [], fades = [];
  const events = {}, media = {};
  const base = "http://scope-a.invalid:19101";
  const deps = { claims, reads, saved, playedRecords, leave, audioAttempts, loaded, retired, fades, events, media,
    createMusicProgressSession, createMusicPlayedReport, captureMusicProgressOwner, CLOCK, ID, modern, playId, base };
  const common = `
    const {claims,reads,saved,playedRecords,leave,audioAttempts,loaded,retired,fades,events,media,
      createMusicProgressSession,createMusicPlayedReport,captureMusicProgressOwner,CLOCK,ID,modern,playId,base}=deps;
    const state={music:{current:{id:"A",durationMs:200000,streamUrl:"/A"},playReportedTrackId:""},
      current:{id:"A",durationMs:200000,streamUrl:"/A"},playReportedTrackId:"",
      queue:[{id:"A",streamUrl:"/A"},{id:"B",streamUrl:"/B"}],gapless:true,
      shuffle:false,repeat:"none",crossfadeSeconds:0,playbackSpeed:1,volume:1,fullscreen:false};
    const music=()=>state.music;
    let selectedUrl=base;
    const getActiveUrl=()=>selectedUrl;
    const audioObject={currentTime:10,duration:200,paused:true,readyState:3};
    let audio=audioObject,playReportSession=playId,progressHidden=false,progressClockRequest=null;
    let currentPlaybackUrl=base;
    let progressSession=modern?createMusicProgressSession("A",base,CLOCK,ID(1)):null;
    let playedReport=null,progressClaimRequired=false,lastProgressSavedAt=0;
    const account={owner:"account:fixture",revision:"revision"};
    const captureWebAccount=()=>({...account});
    const player={getAudio:()=>audio};
    const progressWriter={save(record){if(record)saved.push(record);},
      reportPlayed(record){playedRecords.push(record);},
      flushKeepalive(record){leave.push(record);},resume(){}};
    const fetchJson=(url,path,options)=>new Promise((resolve,reject)=>{
      const target=path.endsWith("/progress-session")?claims:reads;
      target.push({url,path,options,signal:options?.signal,resolve,reject});
    });
    const api={claimProgressSession(trackId,previousSessionId,signal){
      return new Promise((resolve,reject)=>claims.push({trackId,previousSessionId,signal,resolve,reject}));
    }};
  `;
  const webNames = ["reportPlayedOnce", "captureProgressRecord", "cancelProgressClock", "refreshProgressClock",
    "flushProgressKeepalive", "resumeProgress", "saveProgressSoon"];
  const androidNames = ["transitionPreloadEnabled", "scheduleGaplessPreload", "nextQueueCandidate",
    "tryPromoteGaplessPreload", "hydratePromotedTrack", "reportPlayedOnce", "saveProgressSoon", "saveProgress",
    "currentProgressRecord", "cancelProgressClock", "refreshProgressClock", "seekToLyric",
    "installMediaSessionHandlers", "setMediaAction", "seekRelative", "installLifecycle"];
  const androidSetup = `
    const window={addEventListener(name,callback){events[name]=callback;}};
    const navigator={mediaSession:{setActionHandler(name,callback){media[name]=callback;}}};
    const els={viewContent:{querySelector(){return null;}}};
    const document={hidden:false,body:{classList:{remove(){}}},addEventListener(name,callback){events[name]=callback;}};
    const absoluteUrl=(url,relative)=>new URL(relative,url).href;
    const sleepAfterCurrentTimerActive=()=>false;
    const updatePlaybackUi=()=>{},updateLyricHighlight=()=>{},cancelAudioFade=()=>{},
      syncAdjacentIdsFromQueue=()=>{},mergeTrackIntoQueue=()=>{},rememberLastTrack=()=>{},
      renderMusicUiPreservingSearch=()=>{},cancelCrossfade=()=>{},retireAudioElement=target=>{retired.push(target);},
      renderShell=()=>{},cancelMusicPagination=()=>{},disposeMusicSearchPendingWork=()=>{},
      musicListQuery=()=>"";
    let openTrackGeneration=0,pendingTrackSelection=0;
    let gaplessPreloadAudio=null,gaplessPreloadTrackId="",gaplessPreloadActiveUrl="",gaplessHandoffPending=false,
      crossfadeOutgoingAudio=null,currentLyricIndex=-1,mediaSessionInstalled=false;
    const clearGaplessPreload=()=>{
      gaplessPreloadAudio=null;gaplessPreloadTrackId="";gaplessPreloadActiveUrl="";
    };
    class Audio{
      constructor(){this.currentTime=0;this.duration=200;this.paused=true;this.readyState=3;}
      play(){this.paused=false;this.onPlay?.();
        return new Promise((resolve,reject)=>audioAttempts.push({audio:this,resolve,reject}));}
    }
    const installAudioEvents=target=>{target.onPlay=()=>reportPlayedOnce();};
    const audioSourceStore={load(kind,target,url,options){loaded.push({kind,target,url,options});return Promise.resolve(true);}};
    const ensureAudio=()=>{},openTrack=async()=>{},playAdjacent=async()=>{},togglePlayback=()=>{},
      pauseAudio=()=>{audio.paused=true;},playAudio=()=>{audio.paused=false;reportPlayedOnce();},
      crossfadeAudioPair=(outgoing,incoming,duration)=>new Promise((resolve,reject)=>fades.push({outgoing,incoming,duration,resolve,reject}));
  `;
  const expose = `{
    state,account,claim:refreshProgressClock,report:reportPlayedOnce,
    capture:${platform === "Web" ? "captureProgressRecord" : "currentProgressRecord"},
    hide:${platform === "Web" ? "flushProgressKeepalive" : "()=>events.pagehide()"},
    resume:${platform === "Web" ? "resumeProgress" : "()=>events.pageshow()"},
    inspect:()=>({progressSession,playedReport,playReportSession,currentPlaybackUrl,progressClaimRequired,
      progressClockRequest,audio}),
    move(trackId,url=base){state.current={id:trackId};state.music.current={id:trackId};
      currentPlaybackUrl=url;playReportSession++;progressSession=createMusicProgressSession(trackId,url,CLOCK+1,ID(2));},
    setSelectedUrl(url){selectedUrl=url;},
    ${platform === "Android" ? "preload:scheduleGaplessPreload,promote:tryPromoteGaplessPreload,hydrate:hydratePromotedTrack,seekLyric:seekToLyric,seekRelative,media," : ""}
  }`;
  const setup = common + (platform === "Android" ? androidSetup : "");
  const wrapped = compile(platform === "Web" ? webActionsSource : androidViewsSource,
    platform === "Web" ? webNames : androidNames, setup,
    platform === "Android" ? "(installLifecycle(),installMediaSessionHandlers()," + expose + ")" : expose, deps);
  return { ...wrapped, claims, reads, saved, playedRecords, leave, audioAttempts, loaded, retired, fades, events, base };
}

for (const platform of ["Web", "Android"]) {
  test(platform + ": 10,000 same pending claims coalesce and same UUID never resets captured sequence", async () => {
    const f = clientFixture(platform);
    const initial = f.capture();
    for (let n = 0; n < 10000; n++) void f.claim();
    assert.equal(f.claims.length, 1);
    assert.equal(f.claims[0].signal.aborted, false);
    f.claims[0].resolve({progressSessionId:initial.progressSessionId,progressSessionStartedAt:CLOCK});
    await tick();
    assert.equal(f.saved.length, 1);
    assert.equal(f.saved[0].progressSequence, initial.progressSequence + 1);
    const next = f.capture();
    assert.equal(next.progressSequence, initial.progressSequence + 2);
    assert.equal(next.progressSessionId, initial.progressSessionId);
  });

  test(platform + ": late ignored-abort claim cannot replace new track or clear its pending owner", async () => {
    const f = clientFixture(platform);
    void f.claim();
    f.move("B");
    void f.claim();
    assert.equal(f.claims.length, 2);
    assert.equal(f.claims[0].signal.aborted, true);
    f.claims[0].resolve({progressSessionId:ID(80),progressSessionStartedAt:CLOCK+2});
    await tick();
    assert.equal(f.saved.length, 0);
    for (let n = 0; n < 1000; n++) void f.claim();
    assert.equal(f.claims.length, 2, "old finally cannot clear the newer owner");
    f.claims[1].resolve({progressSessionId:ID(81),progressSessionStartedAt:CLOCK+3});
    await tick();
    assert.equal(f.saved.length, 1);assert.equal(f.saved[0].trackId,"B");
    assert.equal(f.saved[0].progressSessionId,ID(81));
    assert.equal(f.saved[0].progressSequence,1);
  });

  test(platform + ": pagehide cancels claim without relabelling the last cursor and pageshow permits a fresh claim", async () => {
    const f = clientFixture(platform);
    const old = f.capture();
    void f.claim();
    f.hide();
    assert.equal(f.claims[0].signal.aborted,true);
    assert.equal(f.leave.length,1);
    assert.equal(f.leave[0].progressSessionId,old.progressSessionId);
    f.claims[0].resolve({progressSessionId:ID(90),progressSessionStartedAt:CLOCK+20});
    await tick();
    assert.equal(f.saved.length,0);
    assert.equal(f.capture().progressSessionId,old.progressSessionId);
    void f.claim();assert.equal(f.claims.length,1,"hidden document cannot reserve another owner");
    f.resume();void f.claim();assert.equal(f.claims.length,2);
    f.claims[1].resolve({progressSessionId:ID(91),progressSessionStartedAt:CLOCK+21});
    await tick();assert.equal(f.saved.at(-1).progressSessionId,ID(91));
  });

  test(platform + ": repeated pause/play and renewed cursor preserve the original played UUID and start", async () => {
    const f = clientFixture(platform);
    f.report();
    const first=f.playedRecords[0];
    assert(first?.playedReportId);
    f.report();f.report();
    assert.equal(f.claims.length,1);
    for(const value of f.playedRecords){
      assert.equal(value.playedReportId,first.playedReportId);
      assert.equal(value.playedReportStartedAt,first.playedReportStartedAt);
      assert.equal(value.session,first.session);
    }
    f.claims[0].resolve({progressSessionId:ID(50),progressSessionStartedAt:CLOCK+100});
    await tick();
    f.report();
    const newer=f.playedRecords.at(-1);
    assert.equal(newer.progressSessionId,ID(50));
    assert.equal(newer.playedReportId,first.playedReportId);
    assert.equal(newer.playedReportStartedAt,first.playedReportStartedAt);
  });
}

test("Web actual MediaSession handlers forward all explicit seek callbacks, with legacy seek fallback retained", () => {
  const names=["installMediaSessionHandlers","setMediaAction"];
  for(const supplied of [true,false]){
    const calls=[],handlers={};
    const result=compile(webEngineSource,names,`
      const {calls,handlers,supplied}=deps;
      let mediaSessionInstalled=false,position=10;
      const supportsMediaSession=()=>true;
      const session={setActionHandler(name,callback){handlers[name]=callback;}};
      const getMediaSession=()=>session;
      const seekRelative=offset=>{position+=offset;calls.push(["fallback-relative",offset]);};
      const seek=time=>{position=time;calls.push(["fallback-to",time]);};
      const callbacks=supplied?{
        onMediaSeekBackward(offset){position-=offset;calls.push(["claim-backward",offset]);},
        onMediaSeekForward(offset){position+=offset;calls.push(["claim-forward",offset]);},
        onMediaSeekTo(time){position=time;calls.push(["claim-to",time]);}
      }:{onTimeUpdate(){calls.push(["update"]);}};
    `,"(installMediaSessionHandlers(),{position:()=>position})",{calls,handlers,supplied});
    handlers.seekbackward({seekOffset:4});handlers.seekforward({seekOffset:8});handlers.seekto({seekTime:42});
    assert.equal(result.position(),42);
    assert.deepEqual(calls,supplied?[["claim-backward",4],["claim-forward",8],["claim-to",42]]
      :[["fallback-relative",-4],["fallback-relative",8],["fallback-to",42],["update"]]);
  }
});

test("Web actual rendered lyric button seeks and claims ownership even while paused", () => {
  class Node{
    constructor(tag){this.tag=tag;this.children=[];this.listeners={};this.dataset={};}
    append(...items){this.children.push(...items);}
    addEventListener(name,callback){this.listeners[name]=callback;}
  }
  const calls=[];
  const result=compile(webPageSource,["renderStageLyrics"],`
    const {Node,calls}=deps;
    const document={createElement:tag=>new Node(tag)};
    const state={music:{lyrics:{lines:[{timeMs:42000,text:"fixture lyric"}]},lyricFollowPaused:false}};
    const lyricFollowButtonEls=[],lyricLineEls=[];
    const resumeLyricFollow=()=>{},pauseLyricFollow=()=>{};
    const player={seekToLyricLine(time){calls.push(["seek",time]);}};
    const actions={claimProgressOwner(){calls.push(["claim"]);}};
  `,"(renderStageLyrics(),{lyricLineEls})",{Node,calls});
  assert.equal(result.lyricLineEls.length,1);
  result.lyricLineEls[0].listeners.click();
  assert.deepEqual(calls,[["seek",42000],["claim"]]);
});

test("Android actual paused MediaSession and lyric seek claims once and persists the final position", async () => {
  const f=clientFixture("Android");
  f.media.seekbackward({seekOffset:4});f.media.seekforward({seekOffset:8});f.media.seekto({seekTime:42});
  assert.equal(f.claims.length,1);assert.equal(f.inspect().audio.currentTime,42);
  f.seekLyric(84000);
  assert.equal(f.claims.length,1,"lyric play and explicit seek share the held claim");
  assert.equal(f.inspect().audio.currentTime,84);
  f.claims[0].resolve({progressSessionId:ID(88),progressSessionStartedAt:CLOCK+1});
  await tick();
  assert.equal(f.saved.at(-1).positionMs,84000);
  assert.equal(f.saved.at(-1).progressSessionId,ID(88));
});

test("Android actual modern gapless stays on playback source and defers UUID receipt until a fresh server birth", async () => {
  const f=clientFixture("Android");
  f.setSelectedUrl("http://scope-b.invalid:19102");
  f.preload();
  assert.equal(f.loaded[0].url,new URL("/B",f.base).href);
  assert.equal(f.promote(),true);
  assert.equal(f.inspect().currentPlaybackUrl,f.base);
  assert.equal(f.claims.length,1);assert.equal(f.claims[0].url,f.base);
  assert.equal(f.playedRecords.length,0,"modern gapless cannot emit legacy played while claim is held");
  const provisional=f.capture();
  assert(provisional.progressSessionId);assert.equal(provisional.progressSessionStartedAt,CLOCK);
  assert.equal(provisional.trackId,"B");assert.equal(provisional.activeUrl,f.base);
  const fresh=CLOCK+24*60*60*1000+1;
  f.claims[0].resolve({progressSessionId:ID(92),progressSessionStartedAt:fresh});
  await tick();
  assert.equal(f.playedRecords.length,1);const report=f.playedRecords[0];
  assert.equal(report.progressSessionId,ID(92));assert.equal(report.playedReportStartedAt,fresh);
  assert(report.playedReportId);assert.equal(f.inspect().progressClaimRequired,false);
  assert.equal(f.claims.length,1,"successful deferred played event does not claim recursively");
  f.audioAttempts[0].resolve();await tick();
  assert.equal(f.reads[0].url,f.base,"metadata hydration retains playback source after library switches server");
  f.reads[0].resolve({track:{id:"B",title:"fresh"},lyrics:{lines:[]}});await tick();
  assert.equal(f.state.current.title,"fresh");
});

test("Android actual legacy gapless without server clock retains its existing unfenced compatibility", () => {
  const f=clientFixture("Android",{modern:false});
  f.preload();assert.equal(f.promote(),true);
  assert.equal(f.inspect().progressClaimRequired,false);
  assert.equal(f.playedRecords.length,1);
  assert.deepEqual(musicProgressBody(f.playedRecords[0],true),{positionMs:0,durationMs:200000,played:true});
});

test("Android gapless failed play restores source, session, stable receipt and cancels the abandoned claim", async () => {
  const f=clientFixture("Android");
  f.report();const outgoing=f.inspect(),outgoingReport=outgoing.playedReport;
  f.claims[0].resolve({progressSessionId:outgoing.progressSession.id,progressSessionStartedAt:CLOCK});
  await tick();
  f.preload();assert.equal(f.promote(),true);
  const newClaim=f.claims.at(-1);
  f.audioAttempts[0].reject(new Error("incoming play rejected"));await tick();
  const restored=f.inspect();
  assert.equal(restored.audio,outgoing.audio);assert.equal(f.state.current.id,"A");
  assert.equal(restored.currentPlaybackUrl,outgoing.currentPlaybackUrl);
  assert.equal(restored.progressSession,outgoing.progressSession);
  assert.equal(restored.playedReport,outgoingReport);assert.equal(restored.playReportSession,outgoing.playReportSession);
  assert.equal(newClaim.signal.aborted,true);
  const savedCount=f.saved.length,playedCount=f.playedRecords.length;
  newClaim.resolve({progressSessionId:ID(99),progressSessionStartedAt:CLOCK+1000});await tick();
  assert.equal(f.saved.length,savedCount);assert.equal(f.playedRecords.length,playedCount);
});

test("Android promoted metadata ignores late same-ID new-play success and error", async () => {
  for(const fail of [false,true]){
    const f=clientFixture("Android");
    void f.hydrate("A");assert.equal(f.reads[0].url,f.base);
    f.move("A","http://scope-c.invalid:19103");f.state.current.title="new-play";
    if(fail)f.reads[0].reject(new Error("old metadata failed"));
    else f.reads[0].resolve({track:{id:"A",title:"old-play"}});
    await tick();
    assert.equal(f.state.current.title,"new-play");assert.equal(f.state.status,undefined);
  }
});

test("Android old gapless play success/rejection cannot restore an old owner or retire reused current audio", async () => {
  for(const trackId of ["C","B"]){
    for(const reject of [false,true]){
      const f=clientFixture("Android");
      f.preload();assert.equal(f.promote(),true);
      const incoming=f.inspect().audio;
      f.move(trackId,"http://new-play.invalid:19104");
      const current=f.inspect();
      if(reject)f.audioAttempts[0].reject(new Error("old incoming play failed"));
      else f.audioAttempts[0].resolve();
      await tick();
      const after=f.inspect();
      assert.equal(f.state.current.id,trackId);
      assert.equal(after.currentPlaybackUrl,current.currentPlaybackUrl);
      assert.equal(after.progressSession,current.progressSession);
      assert.equal(after.playReportSession,current.playReportSession);
      assert.equal(after.audio,incoming);
      assert(!f.retired.includes(incoming),"old continuation cannot retire the reused current audio");
      assert.equal(f.reads.length,0,"old success cannot hydrate a new playback");
      f.claims[0].resolve({progressSessionId:ID(98),progressSessionStartedAt:CLOCK+1000});
      await tick();
      assert.equal(f.inspect().progressSession,current.progressSession);
    }
  }
});

test("Android old crossfade completion after a new playback cannot hydrate or retire the current audio", async () => {
  for(const trackId of ["C","B"]){
    for(const reject of [false,true]){
      const f=clientFixture("Android");
      f.state.crossfadeSeconds=1;
      f.preload();assert.equal(f.promote({crossfade:true}),true);
      f.audioAttempts[0].resolve();await tick();
      assert.equal(f.fades.length,1);assert.equal(f.fades[0].duration,1000);
      const incoming=f.inspect().audio;
      f.move(trackId,"http://crossfade-new.invalid:19105");
      const current=f.inspect();
      if(reject)f.fades[0].reject(new Error("old crossfade failed"));
      else f.fades[0].resolve();
      await tick();
      assert.equal(f.state.current.id,trackId);
      assert.equal(f.inspect().progressSession,current.progressSession);
      assert.equal(f.inspect().currentPlaybackUrl,current.currentPlaybackUrl);
      assert.equal(f.inspect().audio,incoming);
      assert(!f.retired.includes(incoming));assert.equal(f.reads.length,0);
    }
  }
});
