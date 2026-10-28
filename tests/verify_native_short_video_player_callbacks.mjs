import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

// Execute the real ordinary-player listener and binding owner, with only the
// Handler/ExoPlayer and UI leaves controlled. No service, media or cache is used.
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"..");
const native=path.join(root,"android-client/android/app/src/main/java/local/fanhao/library");
const activity=fs.readFileSync(path.join(native,"NativeShortVideoActivity.java"),"utf8").replace(/\r\n/g,"\n");
function member(source,name){const match=new RegExp(`^  private [^\\n]* ${name}\\([^\\n]*`,"m").exec(source);if(!match)return "";const open=source.indexOf("{",match.index);let depth=1,pos=open+1;for(;pos<source.length&&depth;pos++){if(source[pos]==="{")depth++;else if(source[pos]==="}")depth--;}return source.slice(match.index,pos);}
const prepare=member(activity,"preparePlayerAt");assert(prepare);
const start=prepare.indexOf("new Player.Listener() {");const end=prepare.indexOf("\n    });\n    playerCache.put(index, preparedPlayer);",start);assert(start>0&&end>start);
const listener=prepare.slice(start,end)+"\n    }";
const ownerHelper=member(activity,"ownsPlayerCallback");
const advanceGate=member(activity,"canAdvanceAfterEnded");assert(advanceGate);
const shared=fs.readFileSync(path.join(root,"tests/verify_native_short_video_playback.mjs"),"utf8").replace(/\r\n/g,"\n");
const doubles=vm.runInNewContext(shared.slice(shared.indexOf("const doubles ="),shared.indexOf("\n\ntry {"))+"\ndoubles;");
doubles["local/fanhao/library/ShortVideoItem.java"]="package local.fanhao.library;final class ShortVideoItem{final String id,streamUrl;ShortVideoItem(String value){id=value;streamUrl=\"https://fixture.invalid/media/short-video/\"+value;}}";
doubles["android/os/SystemClock.java"]="package android.os;public class SystemClock{public static long elapsedRealtime(){return 100;}}";
doubles["androidx/annotation/NonNull.java"]="package androidx.annotation;public @interface NonNull{}";
doubles["androidx/media3/common/VideoSize.java"]="package androidx.media3.common;public class VideoSize{public final int width,height;public VideoSize(int w,int h){width=w;height=h;}}";
doubles["androidx/media3/common/Player.java"]=doubles["androidx/media3/common/Player.java"].replace("int STATE_IDLE",`interface Listener {default void onRenderedFirstFrame(){}default void onVideoSizeChanged(VideoSize value){}default void onPlaybackStateChanged(int value){}default void onIsPlayingChanged(boolean value){}default void onPlayWhenReadyChanged(boolean value,int reason){}default void onPlaybackSuppressionReasonChanged(int reason){}default void onPlayerError(PlaybackException value){}} int STATE_IDLE`);
const temp=fs.mkdtempSync(path.join(os.tmpdir(),"fanhao-native-player-callbacks-"));
const javaHome=process.env.JAVA_HOME||"C:/Program Files/Android/openjdk/jdk-21.0.8";
const tool=name=>path.join(javaHome,"bin",`${name}.exe`);
function write(folder,name,text){const target=path.join(folder,name);fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,text);return target;}
function run(label,callback=listener,helper=ownerHelper,gate=advanceGate){
  const folder=path.join(temp,label);fs.mkdirSync(folder,{recursive:true});const files=Object.entries(doubles).map(([name,text])=>write(folder,name,text));
  files.push(write(folder,"NativeShortVideoPlaybackFallback.java",fs.readFileSync(path.join(native,"NativeShortVideoPlaybackFallback.java"),"utf8")));
  files.push(write(folder,"local/fanhao/library/NativePlayerCallbacksHarness.java",`package local.fanhao.library;
import java.util.*;import java.util.concurrent.*;import android.os.*;import androidx.annotation.NonNull;import android.util.Log;import androidx.media3.common.*;import androidx.media3.exoplayer.ExoPlayer;
public class NativePlayerCallbacksHarness {
  void refreshScreenAwake(){}
  static final String TAG="fixture";static class View{static final int VISIBLE=0,GONE=8;}static class Cover{int visibility=View.VISIBLE;void setVisibility(int value){visibility=value;}}static class ShortVideoHolder{final Cover cover=new Cover();}
  static class Reports extends AbstractExecutorService{public void execute(Runnable task){}public void shutdown(){}public List<Runnable> shutdownNow(){return List.of();}public boolean isShutdown(){return false;}public boolean isTerminated(){return false;}public boolean awaitTermination(long n,TimeUnit unit){return true;}}
  static class Pager{int index;int getCurrentItem(){return index;}void setCurrentItem(int value,boolean smooth){index=value;}}static class PlaybackIntent{boolean allowsAutomaticPlayback(ExoPlayer player){return player.getPlayWhenReady();}}
  final Handler mainHandler=new Handler();final NativeShortVideoPlaybackFallback playbackFallback=new NativeShortVideoPlaybackFallback(mainHandler,new Reports());
  final List<ShortVideoItem> videos=new ArrayList<>(List.of(new ShortVideoItem("A"),new ShortVideoItem("B")));final Map<Integer,ExoPlayer> playerCache=new HashMap<>();final Map<Integer,ShortVideoHolder> attachedHolders=new HashMap<>();final Set<Integer> failedPlayerIndexes=new HashSet<>();
  final List<Integer> errors=new ArrayList<>(),ended=new ArrayList<>(),indicators=new ArrayList<>(),prefetches=new ArrayList<>(),preparations=new ArrayList<>();final Map<Integer,String> sizes=new HashMap<>();
  final Pager pager=new Pager();final PlaybackIntent feedPlayback=new PlaybackIntent();
  ExoPlayer activePlayer=new ExoPlayer();int currentIndex;boolean autoNext=true,activityResumed=true,destroying,finishing,videoFitMode,loggedFirstFrame;Object authorOverlay;long pageSelectedAtMs=1,loggedFramePageSelectedAtMs,createdAtMs;int pageSelectedIndex,hiddenStatus;
  NativePlayerCallbacksHarness(){bind(0);attachedHolders.put(0,new ShortVideoHolder());attachedHolders.put(1,new ShortVideoHolder());}
  void bind(int index){playerCache.clear();playerCache.put(index,activePlayer);currentIndex=index;pager.index=index;activePlayer.setMediaItem(MediaItem.fromUri(playbackFallback.mediaUri(activePlayer,videos.get(index))));activePlayer.setPlayWhenReady(true);}
  boolean isFinishing(){return finishing;}boolean commentsOpen(){return false;}boolean feedSearchOpen(){return false;}boolean hasOwnedProgressSeek(){return false;}
  int playerIndex(ExoPlayer player){for(Map.Entry<Integer,ExoPlayer> entry:playerCache.entrySet())if(entry.getValue()==player)return entry.getKey();return -1;}
  void hideStatus(){hiddenStatus++;}void scheduleVideoPrefetch(int index){prefetches.add(index);}void preparePlayersAround(int index){preparations.add(index);}
  void rememberDecodedVideoSize(int index,int width,int height){sizes.put(index,width+"x"+height);}void applyVideoResizeMode(int index,int width,int height){}
  void syncPlayIndicator(int index,ExoPlayer player){indicators.add(index);}void advanceAfterEnded(int index){if(!canAdvanceAfterEnded(index))return;ended.add(index);pager.setCurrentItem(index+1,true);}void handlePlaybackError(int index,ExoPlayer player,PlaybackException error){errors.add(index);}
${helper}
${gate}
  Player.Listener listener(ExoPlayer preparedPlayer){return ${callback};}
  static void require(boolean value,String message){if(!value)throw new AssertionError(message);}static int cases;
  static void check(String name,Runnable action){try{action.run();cases++;}catch(Throwable error){throw new AssertionError(name+": "+error.getMessage(),error);}}
  public static void main(String[] args){
    check("old error after A to B reuse",()->{NativePlayerCallbacksHarness h=new NativePlayerCallbacksHarness();Player.Listener event=h.listener(h.activePlayer);event.onPlayerError(new PlaybackException());h.bind(1);h.mainHandler.runPending();require(h.errors.isEmpty(),"A queued error reached B handler: "+h.errors);});
    check("old size after A to B reuse",()->{NativePlayerCallbacksHarness h=new NativePlayerCallbacksHarness();Player.Listener event=h.listener(h.activePlayer);event.onVideoSizeChanged(new VideoSize(1080,1920));h.bind(1);h.mainHandler.runPending();require(h.sizes.isEmpty(),"A decoded dimensions were stored against B: "+h.sizes);});
    for(String kind:List.of("error","size","ready","playing","ended")){
      for(String change:List.of("rebind","aba","internal-source","unbound","replaced","destroy","finishing")){
        check(kind+" queued then "+change,()->{NativePlayerCallbacksHarness h=new NativePlayerCallbacksHarness();ExoPlayer player=h.activePlayer;Player.Listener event=h.listener(player);
          if(kind.equals("error"))event.onPlayerError(new PlaybackException());if(kind.equals("size"))event.onVideoSizeChanged(new VideoSize(1920,1080));if(kind.equals("ready"))event.onPlaybackStateChanged(Player.STATE_READY);if(kind.equals("playing"))event.onIsPlayingChanged(true);if(kind.equals("ended"))event.onPlaybackStateChanged(Player.STATE_ENDED);
          if(change.equals("rebind"))h.bind(0);if(change.equals("aba")){h.bind(1);h.bind(0);}if(change.equals("internal-source"))player.setMediaItem(MediaItem.fromUri(android.net.Uri.parse("https://fixture.invalid/changed")));
          if(change.equals("unbound")){h.playerCache.clear();h.playbackFallback.release(player);player.release();}if(change.equals("replaced")){h.activePlayer=new ExoPlayer();h.bind(0);h.playbackFallback.release(player);player.release();}if(change.equals("destroy")){h.destroying=true;h.playbackFallback.release(player);player.release();}if(change.equals("finishing"))h.finishing=true;
          int operations=player.operations;h.mainHandler.runPending();require(h.errors.isEmpty()&&h.sizes.isEmpty()&&h.indicators.isEmpty()&&h.ended.isEmpty(),"retired callback performed a UI/playback action");if(player.released)require(player.operations==operations,"retired callback read a released player");
        });
      }
      check(kind+" fresh callback",()->{NativePlayerCallbacksHarness h=new NativePlayerCallbacksHarness();Player.Listener event=h.listener(h.activePlayer);
        if(kind.equals("error")){event.onPlayerError(new PlaybackException());h.mainHandler.runPending();require(h.errors.equals(List.of(0)),"fresh error not delivered");}
        if(kind.equals("size")){event.onVideoSizeChanged(new VideoSize(1920,1080));h.mainHandler.runPending();require(h.sizes.get(0).equals("1920x1080"),"fresh size not delivered");}
        if(kind.equals("ready")){event.onPlaybackStateChanged(Player.STATE_READY);h.mainHandler.runPending();require(h.indicators.equals(List.of(0)),"fresh ready not delivered");}
        if(kind.equals("playing")){event.onIsPlayingChanged(true);h.mainHandler.runPending();require(h.indicators.equals(List.of(0)),"fresh playing not delivered");}
        if(kind.equals("ended")){h.activePlayer.playbackState=Player.STATE_ENDED;event.onPlaybackStateChanged(Player.STATE_ENDED);h.mainHandler.runPending();require(h.ended.equals(List.of(0)),"fresh ended not delivered");}
      });
    }
    check("fresh event after internal rendition change",()->{NativePlayerCallbacksHarness h=new NativePlayerCallbacksHarness();ExoPlayer player=h.activePlayer;Player.Listener event=h.listener(player);Object owner=h.playbackFallback.bindingOwner(player);require(h.playbackFallback.handle(player,h.videos.get(0),new PlaybackException(),()->false),"actual compatible switch failed");require(h.playbackFallback.bindingOwner(player)==owner,"internal switch unexpectedly changed logical owner");event.onVideoSizeChanged(new VideoSize(720,1280));event.onPlayerError(new PlaybackException());h.mainHandler.runPending();require(h.errors.equals(List.of(0))&&h.sizes.get(0).equals("720x1280"),"current rendition callbacks were rejected");});
    check("old error before actual compatible switch",()->{NativePlayerCallbacksHarness h=new NativePlayerCallbacksHarness();ExoPlayer player=h.activePlayer;Player.Listener event=h.listener(player);Object owner=h.playbackFallback.bindingOwner(player);event.onPlayerError(new PlaybackException());require(h.playbackFallback.handle(player,h.videos.get(0),new PlaybackException(),()->false),"actual compatible switch failed");h.mainHandler.runPending();require(h.errors.isEmpty()&&h.playbackFallback.bindingOwner(player)==owner,"old original error survived an internal source switch with the same logical owner");});
    check("old error before actual same-URL retry",()->{NativePlayerCallbacksHarness h=new NativePlayerCallbacksHarness();ExoPlayer player=h.activePlayer;Player.Listener event=h.listener(player);Object owner=h.playbackFallback.bindingOwner(player);event.onPlayerError(new PlaybackException());MediaItem original=player.getCurrentMediaItem();require(h.playbackFallback.handle(player,h.videos.get(0),new PlaybackException(PlaybackException.ERROR_CODE_IO_NETWORK_CONNECTION_TIMEOUT),()->false),"actual current-URL retry not scheduled");h.mainHandler.pending.get(h.mainHandler.pending.size()-1).run();require(player.getCurrentMediaItem()!=original&&h.playbackFallback.bindingOwner(player)==owner,"internal retry did not exercise new media with the same logical token");h.mainHandler.runPending();require(h.errors.isEmpty(),"old error survived an internal retry MediaItem change");});
    for(String kind:List.of("error","size","ready","playing"))check("background fresh "+kind,()->{NativePlayerCallbacksHarness h=new NativePlayerCallbacksHarness();h.activityResumed=false;Player.Listener event=h.listener(h.activePlayer);if(kind.equals("error"))event.onPlayerError(new PlaybackException());if(kind.equals("size"))event.onVideoSizeChanged(new VideoSize(1280,720));if(kind.equals("ready"))event.onPlaybackStateChanged(Player.STATE_READY);if(kind.equals("playing"))event.onIsPlayingChanged(false);h.mainHandler.runPending();require(!h.errors.isEmpty()||!h.sizes.isEmpty()||!h.indicators.isEmpty(),"ownership guard changed legitimate background listener delivery");});
    check("pending page selection cannot be pulled back by old ended",()->{NativePlayerCallbacksHarness h=new NativePlayerCallbacksHarness();Player.Listener event=h.listener(h.activePlayer);h.activePlayer.playbackState=Player.STATE_ENDED;event.onPlaybackStateChanged(Player.STATE_ENDED);h.pager.index=2;h.mainHandler.runPending();require(h.pager.index==2&&h.ended.isEmpty(),"old ENDED pulled the newly selected page back before playAt rebinding");});
    for(String kind:List.of("error","size"))check("pending page selection keeps cached "+kind+" delivery",()->{NativePlayerCallbacksHarness h=new NativePlayerCallbacksHarness();Player.Listener event=h.listener(h.activePlayer);if(kind.equals("error"))event.onPlayerError(new PlaybackException());else event.onVideoSizeChanged(new VideoSize(640,360));h.pager.index=1;h.mainHandler.runPending();require(kind.equals("error")?h.errors.equals(List.of(0)):h.sizes.get(0).equals("640x360"),"pager movement wrongly suppressed a still-bound cached callback");});
    System.out.println("native-short-video-player-callbacks: "+cases+" actual listener/binding queued callback ownership cases passed");
  }
}`));
  const compiled=spawnSync(tool("javac"),["-encoding","UTF-8","-d",folder,...files],{encoding:"utf8",timeout:15000});assert.equal(compiled.status,0,compiled.stderr||compiled.error?.message);
  return spawnSync(tool("java"),["-Dfile.encoding=UTF-8","-cp",folder,"local.fanhao.library.NativePlayerCallbacksHarness"],{encoding:"utf8",timeout:15000});
}
try{
  const current=run("current");assert.equal(current.status,0,current.stderr||current.error?.message);process.stdout.write(current.stdout);
  assert(ownerHelper,"production queued callbacks need their actual owner guard");
  const unsafe=ownerHelper.replace(/return !destroying[\s\S]*?;/,"return true;");assert.notEqual(unsafe,ownerHelper);const retired=run("owner-removed",listener,unsafe);assert.notEqual(retired.status,0);assert.match(retired.stderr,/A queued error reached B handler|retired callback performed/);
  const noSource=ownerHelper.replace("      && player.getCurrentMediaItem() == mediaItem;",";");assert.notEqual(noSource,ownerHelper);const sourceChanged=run("media-identity-removed",listener,noSource);assert.notEqual(sourceChanged.status,0);assert.match(sourceChanged.stderr,/internal-source: retired callback performed/);
  const noLifecycle=ownerHelper.replace("!destroying && !isFinishing() && ","");assert.notEqual(noLifecycle,ownerHelper);const endedActivity=run("activity-owner-removed",listener,noLifecycle);assert.notEqual(endedActivity.status,0);assert.match(endedActivity.stderr,/finishing: retired callback performed/);
  const noPage=advanceGate.replace("      && pager.getCurrentItem() == index\n","");assert.notEqual(noPage,advanceGate);const pageChanged=run("page-selection-owner-removed",listener,ownerHelper,noPage);assert.notEqual(pageChanged.status,0);assert.match(pageChanged.stderr,/old ENDED pulled the newly selected page back/);
  console.log("native-short-video-player-callbacks: removed binding/source, media identity, Activity and page-selection owner negative controls rejected");
}finally{const resolved=path.resolve(temp);assert(resolved.startsWith(path.resolve(os.tmpdir())+path.sep));fs.rmSync(resolved,{recursive:true,force:true});}
