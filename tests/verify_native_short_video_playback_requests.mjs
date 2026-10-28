import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// Actual Activity page-selection, initial-open and play methods; only Android
// delivery/layout/player leaves are controlled. No device, media or service.
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"..");
const native=path.join(root,"android-client/android/app/src/main/java/local/fanhao/library");
const template=fs.readFileSync(path.join(root,"tests/verify_native_short_video_playback.mjs"),"utf8").replace(/\r\n/g,"\n");
const start=template.indexOf("const doubles = {"),end=template.indexOf("  for (const [relative, source] of Object.entries(doubles))");
const context=vm.createContext({fs,path,assert,root,nativeRoot:native,advisories:{check(){}}});
vm.runInContext(`${template.slice(start,end).replace("try {\n  const sources = [];","const sources = [];")}\nglobalThis.generated=doubles;`,context);
const doubles=context.generated;
const activity=fs.readFileSync(path.join(native,"NativeShortVideoActivity.java"),"utf8").replace(/\r\n/g,"\n");
const member=name=>{const value=activity.match(new RegExp(`  private [^\\n]+ ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n  \\}`))?.[0];assert(value,name);return value.replace('private ','final ');};
const selected=activity.match(/      public void onPageSelected\(int position\) \{[\s\S]*?\n      \}/)?.[0];assert(selected);
const state=activity.match(/      public void onPageScrollStateChanged\(int state\) \{[\s\S]*?\n      \}/)?.[0];assert(state);
const host="local/fanhao/library/NativeShortVideoFeedPlaybackHost.java";
function verifyWiring(source){
  const bind=source.slice(source.indexOf('public void onBindViewHolder('),source.indexOf('public void onViewRecycled('));
  assert(bind.indexOf('flushSelectedPlaybackRequest();')>bind.indexOf('applyControlsVisibility(holder);'),'fully bound holder must wake the request');
  const resume=source.match(/  protected void onResume\(\) \{[\s\S]*?\n  \}/)?.[0]||'';
  assert(resume.indexOf('flushSelectedPlaybackRequest();')>resume.indexOf('activityResumed = true;'),'foreground must resume the original request');
}
verifyWiring(activity);
assert.throws(()=>verifyWiring(activity.replace('      flushSelectedPlaybackRequest();','')),assert.AssertionError);
assert.throws(()=>verifyWiring(activity.replace('    flushSelectedPlaybackRequest();\n    resumeFrameLoading();','    resumeFrameLoading();')),assert.AssertionError);
doubles[host]=doubles[host].replace("import android.os.Handler;","import android.os.Handler;import android.os.SystemClock;")
  .replace("void prepareAround(int index) {}","final List<Integer> framePreparations=new ArrayList<>();void prepareAround(int index) {framePreparations.add(index);}")
  .replace("\n    }\n    class View",`
      ${member('handleAudioInterruption')}
      ${selected.replace("public void onPageSelected","void pageSelected")}
      ${state.replace("public void onPageScrollStateChanged","void pageState")}
    }
    class View`);
doubles["android/os/SystemClock.java"]="package android.os;public class SystemClock{public static long elapsedRealtime(){return 100;}}";
doubles["local/fanhao/library/NativePlaybackRequestsHarness.java"]=`package local.fanhao.library;
import java.util.*;import androidx.media3.exoplayer.ExoPlayer;
public final class NativePlaybackRequestsHarness {
  static int checks;static final List<String> failures=new ArrayList<>();
  static void require(boolean value,String message){if(!value)throw new AssertionError(message);}
  static void check(String name,Runnable test){checks++;try{test.run();}catch(Throwable error){failures.add(name+": "+error.getMessage());}}
  static class Fixture extends NativeShortVideoFeedPlaybackHost {
    Fixture(){this(0,true);}
    Fixture(int kind,boolean attached){for(String id:List.of("A","B","C")){ShortVideoItem item=new ShortVideoItem(id);if(kind>0)item.galleryItems.add(new GalleryMedia(kind==2));videos.add(item);}adapter.notifyDataSetChanged();if(!attached)attachedHolders.remove(0);currentIndex=-1;startPlaybackAt(0);drain();stopProgressUpdates();}
    void select(int index){pager.setCurrentItem(index,false);pageSelected(index);}
    Runnable latest(){return pendingPlaybackRunnable;}
    void bound(){attachedHolders.put(pager.getCurrentItem(),new ShortVideoHolder(pager.getCurrentItem()));flushSelectedPlaybackRequest();}
    void noisy(){handleAudioInterruption();if(activePlayer!=null)activePlayer.pause();if(gallerySoundPlayer!=null)gallerySoundPlayer.pause();}
  }
  public static void main(String[]args){
    check("old selected callback cannot return A after B idle",()->{Fixture f=new Fixture();f.select(0);Runnable old=f.latest();f.select(1);f.pageState(0);require(f.currentIndex==1,"B selection did not commit");old.run();require(f.currentIndex==1,"old A callback stole selected B: current="+f.currentIndex);});
    check("initial-open callback belongs to its feed item",()->{Fixture f=new Fixture();f.startPlaybackAt(0);Runnable old=f.latest();f.releaseAllPlayers();f.videos.clear();f.videos.add(new ShortVideoItem("replacement"));f.adapter.notifyDataSetChanged();f.currentIndex=-1;old.run();require(f.currentIndex==-1&&f.activePlayer==null,"old initial callback played the replacement feed");});
    check("missing holder does not spin UI posts",()->{Fixture f=new Fixture();f.attachedHolders.remove(0);f.playAt(0);for(int turn=0;turn<100;turn++)f.drain();require(f.mainHandler.pending.isEmpty(),"missing holder kept reposting after 100 UI batches: "+f.mainHandler.pending.size());});
    for(int target:new int[]{1,2})check("latest rapid selection="+target,()->{Fixture f=new Fixture();f.select(0);Runnable a=f.latest();f.select(1);Runnable b=f.latest();f.select(target);f.pageState(0);a.run();b.run();require(f.currentIndex==target&&f.playerCache.get(target)==f.activePlayer,"retired rapid selection stole the selected player");});
    check("old callback cannot clear latest queued owner",()->{Fixture f=new Fixture();f.select(0);Runnable old=f.latest();f.select(1);Runnable fresh=f.latest();old.run();require(f.pendingPlaybackRunnable==fresh&&f.selectedPlaybackRequest.index==1,"old callback cleared the new request");f.drain();require(f.currentIndex==1,"fresh request was lost");});
    check("A B A selection rejects old A callback",()->{Fixture f=new Fixture();f.select(0);Runnable old=f.latest();f.select(1);f.select(0);Runnable fresh=f.latest();old.run();require(f.pendingPlaybackRunnable==fresh,"old A callback survived request ABA");f.drain();require(f.currentIndex==0,"fresh A selection did not commit");});
    check("direct obsolete index cannot change pager selection",()->{Fixture f=new Fixture();f.select(1);f.pageState(0);ExoPlayer player=f.activePlayer;f.playAt(0);require(f.currentIndex==1&&f.activePlayer==player,"play entry accepted an index the user did not select");});
    check("delayed holder is event driven",()->{Fixture f=new Fixture(0,false);require(f.currentIndex==0&&f.activePlayer==null&&f.pendingPlaybackRunnable==null,"missing page did not settle into one waiting request");for(int turn=0;turn<100;turn++)f.drain();require(f.mainHandler.pending.isEmpty(),"waiting page spun main-loop jobs");f.bound();f.drain();require(f.currentIndex==0&&f.activePlayer!=null&&f.activePlayer.getPlayWhenReady(),"bound current holder did not resume its pending request");});
    check("hidden pending request retains original source owner",()->{Fixture f=new Fixture(0,false);f.onPause();ShortVideoItem replacement=new ShortVideoItem("replacement");f.videos.set(0,replacement);int prepared=f.prepared;f.onResume();f.bound();f.drain();require(f.selectedPlaybackRequest==null&&f.prepared==prepared&&f.activePlayer==null,"resume repackaged a retired source as a fresh request");f.select(0);f.drain();require(f.activePlayer!=null&&f.activePlayer.getPlayWhenReady(),"new explicit selection did not recover after stale pending source");});
    for(int kind:new int[]{0,1,2})check("noisy pending binds paused and remains paused kind="+kind,()->{Fixture f=new Fixture(kind,false);f.noisy();f.bound();f.drain();require(f.currentIndex==0&&f.selectedPlaybackRequest.committed,"noisy request prevented the current page from binding");if(kind!=1)require(f.activePlayer!=null&&!f.activePlayer.getPlayWhenReady(),"old pending video resumed after noisy");if(kind>0)require(f.gallerySoundPlayer!=null&&!f.gallerySoundPlayer.getPlayWhenReady(),"old pending soundtrack resumed after noisy");f.playAt(0);f.onPause();f.onResume();f.drain();if(kind!=1)require(!f.activePlayer.getPlayWhenReady(),"lifecycle/rebind revived old video intent");if(kind>0)require(!f.gallerySoundPlayer.getPlayWhenReady(),"lifecycle/rebind revived old soundtrack intent");if(kind!=1){f.toggleActivePlayback();require(f.activePlayer.getPlayWhenReady(),"new explicit video play was blocked");}f.select(1);f.drain();require(f.currentIndex==1&&(kind==1?f.gallerySoundPlayer:f.activePlayer).getPlayWhenReady(),"fresh selection could not play after noisy pending cancellation");});
    check("noisy while backgrounded cannot be refreshed by resume",()->{Fixture f=new Fixture(0,false);f.onPause();f.noisy();f.bound();f.onResume();f.drain();require(f.activePlayer!=null&&!f.activePlayer.getPlayWhenReady(),"foreground refreshed old audio epoch into an autoplay request");});
    check("initial open before resume binds on first foreground",()->{Fixture f=new Fixture();f.releaseAllPlayers();f.currentIndex=-1;f.activityResumed=false;f.startPlaybackAt(1);require(f.pendingPlaybackRunnable==null,"hidden initial open queued a busy playback loop");f.onResume();f.drain();require(f.currentIndex==1&&f.activePlayer.getPlayWhenReady(),"legal initial selection failed to start on first resume");});
    check("prepare callback cannot clear a new prepare owner",()->{Fixture f=new Fixture();f.schedulePrepareAround(0,120);Runnable old=f.pendingPrepareRunnable;f.select(1);f.pageState(0);f.schedulePrepareAround(1,120);Runnable fresh=f.pendingPrepareRunnable;f.framePreparations.clear();old.run();require(f.pendingPrepareRunnable==fresh&&f.framePreparations.isEmpty(),"old prepare timer cleared or prepared the new owner");fresh.run();require(f.framePreparations.equals(List.of(1)),"current prepare callback failed");});
    check("idle commit still schedules current frame warmup",()->{Fixture f=new Fixture();f.framePreparations.clear();f.select(1);f.pageState(0);Runnable timer=f.pendingPrepareRunnable;f.pageState(0);f.playAt(1);require(f.pendingPrepareRunnable==timer,"duplicate binding replaced or extended the current warmup timer");f.drain();f.drain();require(f.framePreparations.equals(List.of(1)),"current IDLE selection lost or duplicated its delayed frame warmup: "+f.framePreparations);});
    check("request queue stays bounded",()->{Fixture f=new Fixture();for(int turn=0;turn<100;turn++)f.select(turn%3);require(f.pendingPlaybackRunnable!=null&&f.mainHandler.pending.size()==1,"selection queue exceeded one pending delivery: "+f.mainHandler.pending.size());f.drain();require(f.currentIndex==0,"latest bounded selection failed");});
    check("without autoplay preserves snapshot seek and scope restoration",()->{NativeShortVideoFeedPlayback intent=new NativeShortVideoFeedPlayback();ExoPlayer old=new ExoPlayer();old.seekTo(17000);old.play();intent.select("A");intent.restore(intent.captureCurrent("A",-1,old,old));ExoPlayer video=new ExoPlayer(),sound=new ExoPlayer();intent.bindWithoutAutoplay(()->{intent.start(video,false,"A",true);intent.start(sound,true,"A",true);});require(video.position==17000&&sound.position==17000&&!video.getPlayWhenReady()&&!sound.getPlayWhenReady(),"scope lost restored position or applied true intent");intent.start(video,false,"A",true);intent.start(sound,true,"A",true);require(!video.getPlayWhenReady()&&!sound.getPlayWhenReady(),"scope left a true lifecycle request");try{intent.bindWithoutAutoplay(()->{throw new IllegalStateException("controlled");});}catch(IllegalStateException expected){}ExoPlayer fresh=new ExoPlayer();intent.select("B");require(intent.start(fresh,false,"B",true)&&fresh.getPlayWhenReady(),"exception left autoplay permanently suppressed");});
    if(!failures.isEmpty())throw new AssertionError(String.join("\\n",failures));
    System.out.println("native-short-video-playback-requests: "+checks+" actual selection/holder/route cases passed");
  }
}`;
const temp=fs.mkdtempSync(path.join(os.tmpdir(),"fanhao-native-playback-requests-"));
const javaHome=process.env.JAVA_HOME||"C:/Program Files/Android/openjdk/jdk-21.0.8";
const tool=name=>fs.existsSync(path.join(javaHome,"bin",`${name}.exe`))?path.join(javaHome,"bin",`${name}.exe`):name;
function run(label,values){
  const folder=path.join(temp,label),files=[];for(const [relative,source] of Object.entries(values)){const target=path.join(folder,relative);fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,source);files.push(target);}
  files.push(...["NativeShortVideoPlaybackFallback.java","NativeShortVideoFeedPlayback.java","NativeShortVideoScreenState.java"].map(name=>path.join(native,name)));
  const compiled=spawnSync(tool("javac"),["-encoding","UTF-8","-d",folder,...files],{encoding:"utf8",timeout:30000});assert.equal(compiled.status,0,compiled.stderr);
  return spawnSync(tool("java"),["-cp",folder,"local.fanhao.library.NativePlaybackRequestsHarness"],{encoding:"utf8",timeout:15000});
}
try{
  const executed=run('current',doubles);assert.equal(executed.status,0,executed.stderr);process.stdout.write(executed.stdout);
  const mutations=[
    ['queued-owner','if (pendingPlaybackRunnable != this) return;','',/old callback cannot clear latest queued owner/],
    ['selected-page',member('playAt'),member('playAt').replace(' || !isSelectedPlaybackItem(index, videos.get(index))',''),/direct obsolete index cannot change pager selection/],
    ['source-owner',' && videos.get(index) == item','',/hidden pending request retains original source owner/],
    ['missing-holder',member('bindSelectedPlaybackAt'),member('bindSelectedPlaybackAt').replace('    if (holder == null) {','    if (holder == null) { pager.post(() -> playAt(index));'),/missing holder does not spin UI posts/],
    ['noisy-autoplay','feedPlayback.bindWithoutAutoplay(() -> bindSelectedPlaybackAt(index));','bindSelectedPlaybackAt(index);',/noisy pending binds paused and remains paused/],
  ];
  for(const [label,before,after,oracle] of mutations){assert(doubles[host].includes(before),label+' mutation anchor');assert.notEqual(before,after);const result=run(label,{...doubles,[host]:doubles[host].replace(before,after)});assert.equal(result.status,1,label+' did not reject: '+result.stderr);assert.match(result.stderr,oracle);}
  console.log('native-short-video-playback-requests: five compiled owner/selection/source/spin/noisy and two event-wiring negative controls rejected');
}finally{
  const resolved=fs.realpathSync(temp);assert.equal(path.dirname(resolved),fs.realpathSync(os.tmpdir()));assert(path.basename(resolved).startsWith("fanhao-native-playback-requests-"));
  const cleaned=spawnSync("powershell.exe",["-NoProfile","-Command",`Remove-Item -LiteralPath '${resolved.replace(/'/g,"''")}' -Recurse -Force`],{encoding:"utf8",timeout:10000});assert.equal(cleaned.status,0,cleaned.stderr);
}
