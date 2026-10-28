import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

// Real Activity gesture/intent methods and real fallback/feed owners. Android
// leaves, media and time are controlled; no device, APK, service or network.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const nativeRoot = path.join(root, "android-client/android/app/src/main/java/local/fanhao/library");
const template = fs.readFileSync(path.join(root, "tests/verify_native_short_video_playback.mjs"), "utf8").replace(/\r\n/g, "\n");
const start = template.indexOf("const doubles = {"), end = template.indexOf("  for (const [relative, source] of Object.entries(doubles))");
const environment = vm.createContext({ fs, path, assert, root, nativeRoot, advisories: { check() {} } });
vm.runInContext(`${template.slice(start, end).replace("try {\n  const sources = [];", "const sources = [];")}\nglobalThis.generated=doubles;`, environment);
const doubles = environment.generated;
doubles["local/fanhao/library/NativeShortVideoPlaybackHost.java"] = doubles["local/fanhao/library/NativeShortVideoPlaybackHost.java"]
  .replace("boolean feedSearchOpen() { return false; }", "boolean feedSearch; boolean feedSearchOpen() { return feedSearch; }");
const activity = fs.readFileSync(path.join(nativeRoot, "NativeShortVideoActivity.java"), "utf8").replace(/\r\n/g, "\n");
const member = name => {
  const method = activity.match(new RegExp(`  private [^\\n]+ ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n  \\}`))?.[0];
  assert(method, name); return method.replace("private ", "final ");
};
const owner = activity.match(/  private final class StageGestureOwner \{[\s\S]*?\n  \}/)?.[0]; assert(owner);
const feedPath = "local/fanhao/library/NativeShortVideoFeedPlaybackHost.java";
const gestureMethods = ["stageGestureVisible", "captureStageGestureOwner", "ownsStageGesture", "cancelStageTouch", "cancelStageGestures",
  "invalidateGalleryStageGesture", "rejectStageTouch", "handleStageTap", "handleOwnedStageTap", "handleStageTouch", "handleGestureLayerTouch",
  "scheduleStageLongPress", "cancelStageLongPress", "handleGalleryScaleAndPanTouch", "handleAudioInterruption"];
doubles[feedPath] = doubles[feedPath].replace("void clearPendingStageTap() {}", member("clearPendingStageTap"))
  .replace("package local.fanhao.library;", "package local.fanhao.library; import android.os.SystemClock;")
  .replace("final void retryPlaybackAt(int index) {", "final void retryPlaybackAt(int index) { retries++;")
  .replace("\n    }\n    class View", `
      ${owner.replace("private ", "")}
      ${gestureMethods.map(member).join("\n")}
      StageGestureOwner pendingStageTapOwner,stageTouchOwner;
      ShortVideoHolder stageTouchHolder,galleryScaleHolder;View stageTouchView;
      long stageGestureGeneration,lastStageTapAt;int lastStageTapIndex=-1;
      Runnable pendingStageTapRunnable;
      boolean controlsHidden,suppressPagerGestureCommit;int likes,toolbars,retries,swipes;String likedId;
      static final long STAGE_DOUBLE_TAP_MS=280;static final int LONG_PRESS_CANCEL_DISTANCE_DP=6;static final float HORIZONTAL_GESTURE_RATIO=1.35f;
      ScaleGestureDetector galleryScaleDetector=new ScaleGestureDetector();
      int dp(int value){return value;}
      void setParentInterceptDisallowed(View view,boolean value){if(view!=null)view.intercept=value;}
      void updateGalleryDrag(ShortVideoHolder holder,float dx){}
      boolean finishGalleryDrag(ShortVideoHolder holder,float dx,float velocity){return false;}
      float galleryDragVelocity(ShortVideoHolder holder,float dx){return 0;}
      void handleHorizontalSwipe(int index,float dx){swipes++;}
      boolean cancelGalleryDrag(ShortVideoHolder holder){return false;}
      void applyGalleryPan(ShortVideoHolder holder,float x,float y){}
      void clampGalleryPan(ShortVideoHolder holder){}
      void animateGalleryZoomReset(ShortVideoHolder holder,boolean animate){holder.galleryZoomScale=1f;}
      void setControlsHidden(boolean hidden,boolean animate){controlsHidden=hidden;}
      void activateLike(ShortVideoItem item,boolean burst,float x,float y,boolean status){likes++;likedId=item.id;}
      void showPlaybackToolbar(ShortVideoItem item){toolbars++;playbackToolbarOverlay=new Object();}
    }
    class HapticFeedbackConstants {static final int LONG_PRESS=0;}
    class ScaleGestureDetector {boolean active;int events;void onTouchEvent(MotionEvent event){events++;}boolean isInProgress(){return active;}}
    class MotionEvent {
      static final int ACTION_DOWN=0,ACTION_UP=1,ACTION_MOVE=2,ACTION_CANCEL=3,ACTION_POINTER_DOWN=5,ACTION_POINTER_UP=6;
      final int action,count;final float x,y;
      MotionEvent(int action,int count,float x,float y){this.action=action;this.count=count;this.x=x;this.y=y;}
      int getActionMasked(){return action;}int getPointerCount(){return count;}int getActionIndex(){return 1;}
      float getX(){return x;}float getY(){return y;}float getRawX(){return x;}float getRawY(){return y;}float getX(int index){return x;}float getY(int index){return y;}
    }
    class View`)
  .replace("class View { static final int VISIBLE = 0, GONE = 8; }", `class View {static final int VISIBLE=0,GONE=8;boolean pressed,intercept;int haptics;void setPressed(boolean value){pressed=value;}boolean performHapticFeedback(int value){haptics++;return true;}}`)
  .replace("class ShortVideoHolder {", `class ShortVideoHolder {float touchStartX,touchStartY,lastTapX,lastTapY,galleryZoomScale=1f,galleryZoomLastX,galleryZoomLastY;long touchStartAtMs;boolean touchActive,horizontalGesture,verticalGesture,longPressTriggered,galleryPanning,galleryScaling,galleryPanMoved;Runnable longPressRunnable;`)
  .replace("void setAlpha(float value)", "float getTranslationX(){return 0;}float getTranslationY(){return 0;}void setAlpha(float value)");
doubles["android/os/SystemClock.java"] = "package android.os;public class SystemClock {public static long now;public static long uptimeMillis(){return now;}public static long elapsedRealtime(){return now;}}";
doubles["android/os/Handler.java"] = `package android.os;import java.util.*;public class Handler {
  public final ArrayList<Runnable> pending=new ArrayList<>();public final IdentityHashMap<Runnable,Long> due=new IdentityHashMap<>();
  public boolean post(Runnable task){return postDelayed(task,0);}public boolean postDelayed(Runnable task,long delay){pending.add(task);due.put(task,SystemClock.now+delay);return true;}
  public void removeCallbacks(Runnable task){pending.removeIf(value->value==task);due.remove(task);}
  public void runPending(){for(int count=0;count<100;count++){Runnable next=null;long time=Long.MAX_VALUE;for(Runnable task:pending)if(due.getOrDefault(task,0L)<=SystemClock.now&&due.getOrDefault(task,0L)<time){next=task;time=due.getOrDefault(task,0L);}if(next==null)return;removeCallbacks(next);next.run();}throw new AssertionError("unbounded immediate callback loop");}
}`;
doubles["local/fanhao/library/NativeGestureHarness.java"] = `package local.fanhao.library;
import android.os.SystemClock;import androidx.media3.common.MediaItem;import androidx.media3.common.PlaybackException;import androidx.media3.common.Player;import androidx.media3.exoplayer.ExoPlayer;import java.util.*;
public final class NativeGestureHarness {
  static int cases;static final List<String> failures=new ArrayList<>();
  static void require(boolean value,String message){if(!value)throw new AssertionError(message);}
  static void check(String name,Runnable test){cases++;try{test.run();}catch(Throwable error){failures.add(name+": "+error.getMessage());}}
  static final class Fixture extends NativeShortVideoFeedPlaybackHost {
    final View surface=new View();Fixture(){SystemClock.now=0;videos.add(new ShortVideoItem("A"));adapter.notifyDataSetChanged();currentIndex=-1;startPlaybackAt(0);drain();}
    ShortVideoHolder holder(){return attachedHolders.get(currentIndex);}
    void event(boolean layer,int action,int count,float x,float y){if(layer)handleGestureLayerTouch(holder(),surface,new MotionEvent(action,count,x,y));else handleStageTouch(holder(),surface,new MotionEvent(action,count,x,y));}
    void tick(long ms){SystemClock.now+=ms;mainHandler.runPending();}
    void tap(boolean layer){event(layer,0,1,50,50);tick(10);event(layer,1,1,50,50);}
    void gallery(boolean video){ShortVideoItem item=videos.get(0);item.galleryItems.add(new GalleryMedia(video));item.galleryItems.add(new GalleryMedia(false));playAt(0);}
  }
  public static void main(String[] args){
    for(boolean layer:List.of(false,true))for(boolean playing:List.of(false,true))check("single target layer="+layer+" playing="+playing,()->{
      Fixture f=new Fixture();f.activePlayer.setPlayWhenReady(playing);f.tap(layer);f.tick(280);require(f.activePlayer.getPlayWhenReady()!=playing,"single tap failed to apply its captured target");
    });
    for(boolean layer:List.of(false,true))check("double tap only likes layer="+layer,()->{Fixture f=new Fixture();f.tap(layer);f.tick(80);f.tap(layer);f.tick(600);require(f.likes==1&&f.activePlayer.getPlayWhenReady(),"double tap paused or liked the wrong item");});
    for(boolean layer:List.of(false,true))check("multi finger cancels until fresh down layer="+layer,()->{
      Fixture f=new Fixture();f.event(layer,0,1,50,50);f.tick(10);f.event(layer,5,2,50,50);f.tick(600);require(f.toolbars==0,"two-finger hold opened a long-press menu");
      f.event(layer,6,2,50,50);f.event(layer,1,1,50,50);f.tick(300);require(f.activePlayer.getPlayWhenReady()&&f.likes==0,"multi-touch tail became tap/like");
      f.tap(layer);f.tick(280);require(!f.activePlayer.getPlayWhenReady(),"new DOWN did not recover valid tapping");
    });
    check("noisy revokes pending tap",()->{Fixture f=new Fixture();f.activePlayer.pause();f.handleStageTap(0);f.handleAudioInterruption();f.tick(300);require(!f.activePlayer.getPlayWhenReady()&&f.pendingStageTapRunnable==null,"queued tap undid noisy pause");});
    check("SDK focus pause cannot reverse queued pause target",()->{Fixture f=new Fixture();f.handleStageTap(0);long epoch=f.feedPlayback.audioInterruptionGeneration();f.activePlayer.pause();f.tick(300);require(!f.activePlayer.getPlayWhenReady()&&f.feedPlayback.audioInterruptionGeneration()==epoch,"queued toggle requested playback after focus had paused it");});
    check("internal compatible switch retains legitimate tap",()->{
      Fixture f=new Fixture();ExoPlayer player=f.activePlayer;Object token=f.playbackFallback.bindingOwner(player);f.handleStageTap(0);
      require(f.playbackFallback.handle(player,f.videos.get(0),new PlaybackException(),()->true),"initial compatible switch");require(f.playbackFallback.bindingOwner(player)==token,"internal switch changed logical binding");f.tick(300);require(!player.getPlayWhenReady(),"strict MediaItem ownership dropped a valid same-work pause");
    });
    check("internal delayed retry retains legitimate tap",()->{
      Fixture f=new Fixture();ExoPlayer player=f.activePlayer;f.playbackFallback.handle(player,f.videos.get(0),new PlaybackException(),()->true);f.playbackFallback.handle(player,f.videos.get(0),new PlaybackException(),()->player.getPlayWhenReady());f.handleStageTap(0);f.tick(1300);require(!player.getPlayWhenReady(),"retry/tap ordering discarded pause intent");
    });
    for(String change:List.of("rebind","ABA","holder","item","background","author","comments","search","finishing","destroying"))check("pending tap owner "+change,()->{
      Fixture f=new Fixture();f.handleStageTap(0);ExoPlayer player=f.activePlayer;
      if(change.equals("rebind"))f.playbackFallback.mediaUri(player,f.videos.get(0));
      if(change.equals("ABA")){f.videos.add(new ShortVideoItem("B"));f.adapter.notifyDataSetChanged();f.selectForTest(1);f.selectForTest(0);}
      if(change.equals("holder"))f.attachedHolders.put(0,new ShortVideoHolder(0));
      if(change.equals("item"))f.videos.set(0,new ShortVideoItem("replacement"));
      if(change.equals("background"))f.activityResumed=false;
      if(change.equals("author"))f.authorOverlay=new Object();
      if(change.equals("comments"))f.comments=true;
      if(change.equals("search"))f.feedSearch=true;
      if(change.equals("finishing"))f.finishing=true;
      if(change.equals("destroying"))f.destroying=true;
      ExoPlayer current=f.activePlayer;f.tick(300);require(current.getPlayWhenReady(),"obsolete tap changed the new/hidden playback owner");
    });
    check("old tap callback cannot clear a fresh pending tap",()->{Fixture f=new Fixture();f.handleStageTap(0);Runnable old=f.pendingStageTapRunnable;f.cancelStageGestures();f.handleStageTap(0);Runnable fresh=f.pendingStageTapRunnable;old.run();require(f.pendingStageTapRunnable==fresh,"old timer cleared fresh tap");f.tick(300);require(!f.activePlayer.getPlayWhenReady(),"fresh tap was lost");});
    check("long press only current held owner",()->{Fixture f=new Fixture();f.event(true,0,1,50,50);f.tick(560);require(f.toolbars==1&&f.surface.haptics==1,"legitimate long press did not open toolbar");});
    check("multi noisy and released touch revoke long press",()->{Fixture f=new Fixture();f.event(true,0,1,50,50);Runnable old=f.holder().longPressRunnable;f.handleAudioInterruption();old.run();require(f.toolbars==0,"noisy gesture retained long press");});
    check("old long press cannot clear a new same-holder timer",()->{Fixture f=new Fixture();f.event(true,0,1,50,50);Runnable old=f.holder().longPressRunnable;f.cancelStageGestures();f.event(true,0,1,50,50);Runnable fresh=f.holder().longPressRunnable;old.run();require(f.holder().longPressRunnable==fresh,"old long press cleared fresh timer");f.tick(560);require(f.toolbars==1,"fresh long press was lost");});
    check("touch from an old source cannot become a new tap on UP",()->{Fixture f=new Fixture();f.event(true,0,1,50,50);f.playbackFallback.mediaUri(f.activePlayer,f.videos.get(0));f.event(true,1,1,50,50);f.tick(300);require(f.activePlayer.getPlayWhenReady(),"old touch UP was rebound to the new source");});
    check("failed current work without player still retries",()->{Fixture f=new Fixture();ExoPlayer old=f.activePlayer;f.playbackFallback.releasePlayerResources(old);f.playerCache.clear();f.activePlayer=null;f.failedPlayerIndexes.add(0);f.handleStageTap(0);f.tick(300);require(f.retries==1&&f.activePlayer!=null&&f.activePlayer.getPlayWhenReady(),"null-player failure blocked explicit retry");});
    check("old failed tap cannot retry after noisy",()->{Fixture f=new Fixture();f.playerCache.clear();f.activePlayer=null;f.failedPlayerIndexes.add(0);f.handleStageTap(0);f.handleAudioInterruption();f.tick(300);require(f.retries==0,"old failure tap retried after interruption");});
    check("gallery pinch consumes without click or long press",()->{Fixture f=new Fixture();f.gallery(false);f.event(true,0,1,50,50);f.event(true,5,2,50,50);f.tick(600);f.event(true,6,2,50,50);f.event(true,1,1,50,50);f.tick(300);require(f.likes==0&&f.toolbars==0&&f.galleryScaleDetector.events>=4,"image gallery lost its existing multi-touch route");});
    check("gallery selected media invalidates an old tap",()->{Fixture f=new Fixture();f.gallery(true);f.handleStageTap(0);f.bindGallery(f.holder(),f.videos.get(0),1,1);f.bindGallery(f.holder(),f.videos.get(0),0,1);f.tick(300);require(f.activePlayer.getPlayWhenReady(),"old gallery selection tap survived media ABA");});
    if(!failures.isEmpty())throw new AssertionError(String.join("\\n",failures));System.out.println("native-short-video-gestures: "+cases+" actual tap/long-press/multi-pointer/owner cases passed");
  }
}`;
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "fanhao-native-gestures-"));
const javaHome = process.env.JAVA_HOME || "C:/Program Files/Android/openjdk/jdk-21.0.8";
const executable = name => fs.existsSync(path.join(javaHome, "bin", `${name}.exe`)) ? path.join(javaHome, "bin", `${name}.exe`) : name;
function compile(name, files) {
  const folder = path.join(temp, name);
  const sources = [];
  for (const [relative, source] of Object.entries(files)) { const target = path.join(folder, relative);fs.mkdirSync(path.dirname(target), { recursive: true });fs.writeFileSync(target, source);sources.push(target); }
  sources.push(...["NativeShortVideoPlaybackFallback.java", "NativeShortVideoFeedPlayback.java", "NativeShortVideoScreenState.java"].map(file => path.join(nativeRoot, file)));
  const compiled = spawnSync(executable("javac"), ["-encoding", "UTF-8", "-d", folder, ...sources], { encoding: "utf8", timeout: 30000 });assert.equal(compiled.status, 0, compiled.stderr);
  return folder;
}
function run(folder) { return spawnSync(executable("java"), ["-cp", folder, "local.fanhao.library.NativeGestureHarness"], { encoding: "utf8", timeout: 15000 }); }
try {
  const executed = run(compile("current", doubles));assert.equal(executed.status, 0, executed.stderr);process.stdout.write(executed.stdout);
  const mutations = [
    ["multi-pointer", "if (event.getPointerCount() > 1 || action == MotionEvent.ACTION_POINTER_DOWN || action == MotionEvent.ACTION_POINTER_UP) {", "if (false) {", /multi finger cancels until fresh down/],
    ["tap-timer", "if (pendingStageTapRunnable != this) return;", "", /old tap callback cannot clear a fresh pending tap/],
    ["hold-timer", "if (holder.longPressRunnable != this) return;", "", /old long press cannot clear a new same-holder timer/],
    ["delayed-toggle", "if (play) {", "if (!activePlayer.getPlayWhenReady() || activePlayer.getPlaybackState() == Player.STATE_ENDED) {", /SDK focus pause cannot reverse queued pause target/],
  ];
  for (const [name, from, to, oracle] of mutations) {
    assert(doubles[feedPath].includes(from), `${name} mutation anchor`);
    const rejected = run(compile(name, { ...doubles, [feedPath]: doubles[feedPath].replace(from, to) }));
    assert.equal(rejected.status, 1, `${name} must reject the regressed behavior: ${rejected.stderr}`);
    assert.match(rejected.stderr, oracle, `${name} must fail its specific behavioral oracle`);
  }
  console.log("native-short-video-gestures: four compiled multi-pointer/timer-identity/delayed-toggle negative controls rejected");
} finally {
  const resolved = fs.realpathSync(temp);assert.equal(path.dirname(resolved), fs.realpathSync(os.tmpdir()));assert(path.basename(resolved).startsWith("fanhao-native-gestures-"));
  const cleanup = spawnSync("powershell.exe", ["-NoProfile", "-Command", `Remove-Item -LiteralPath '${resolved.replace(/'/g, "''")}' -Recurse -Force`], { encoding: "utf8", timeout: 10000 });assert.equal(cleanup.status, 0, cleanup.stderr);
}
