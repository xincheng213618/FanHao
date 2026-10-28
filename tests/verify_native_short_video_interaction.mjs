import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// Reuse the native playback test's Android/Media3 adapters. The tested methods
// and seek owner are the current production Java; no device, APK, network,
// downloader, database, media, or persistent user state is accessed.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const nativeRoot = path.join(root, "android-client/android/app/src/main/java/local/fanhao/library");
const original = fs.readFileSync(path.join(root, "tests/verify_native_short_video_playback.mjs"), "utf8").replace(/\r\n/g, "\n");
const start = original.indexOf("const doubles = {"), end = original.indexOf("  for (const [relative, source] of Object.entries(doubles))");
assert(start >= 0 && end > start);
const generation = original.slice(start, end).replace("try {\n  const sources = [];", "const sources = [];");
const environment = vm.createContext({ fs, path, assert, root, nativeRoot, advisories: { check() {} } });
vm.runInContext(`${generation}\nglobalThis.generated = doubles;`, environment);
const doubles = environment.generated;
const activity = fs.readFileSync(path.join(nativeRoot, "NativeShortVideoActivity.java"), "utf8").replace(/\r\n/g, "\n");
function member(name) {
  const match = activity.match(new RegExp(`  private (?:boolean|void|Runnable|Object|long) ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n  \\}`));
  assert(match, `missing production interaction method ${name}`); return match[0].replace("private ", "final ");
}
const basePath = "local/fanhao/library/NativeShortVideoPlaybackHost.java";
assert(doubles[basePath].includes("boolean feedSearchOpen() { return false; }"));
doubles[basePath] = doubles[basePath].replace("boolean feedSearchOpen() { return false; }", `
  NativeShortVideoFeedSearchController feedSearchController = new NativeShortVideoFeedSearchController();
  ${member("feedSearchOpen")}
`);
const feedPath = "local/fanhao/library/NativeShortVideoFeedPlaybackHost.java";
if (!/\bfeedRequests\s*=/.test(doubles[feedPath])) {
  doubles[feedPath] = doubles[feedPath].replace("class NativeShortVideoFeedPlaybackHost extends NativeShortVideoPlaybackHost {",
    "class NativeShortVideoFeedPlaybackHost extends NativeShortVideoPlaybackHost { static class ReadRequests { void cancel() {} } final ReadRequests feedRequests = new ReadRequests();");
}
doubles[feedPath] = doubles[feedPath].replace("\n    }\n    class View", `
      final NativeShortVideoSeekSession progressSeekSession = new NativeShortVideoSeekSession();
      ShortVideoHolder progressSeekHolder;
      Runnable progressSeekFrame;
      ExoPlayer progressDurationPlayer;Object progressDurationSource;long progressDurationMs;
      ${member("seekActivePlayerFromTouch")}
      ${member("progressSeekSourceOwner")}
      ${member("progressDuration")}
      ${member("clearProgressDuration")}
      ${member("ownsProgressSeek")}
      ${member("hasOwnedProgressSeek")}
      ${member("scheduleProgressSeekFrame")}
      ${member("clearProgressSeekFrame")}
      ${member("applyProgressSeek")}
      ${member("cancelProgressSeek")}
      ${member("finishProgressSeek")}
      void setParentInterceptDisallowed(View view, boolean value) { if (view != null) view.intercept = value; }
      void showSeekPreview(ShortVideoHolder holder, long position, long duration, boolean hide) {}
    }
    class View`);
doubles[feedPath] = doubles[feedPath].replace("class View { static final int VISIBLE = 0, GONE = 8; }", `
    class View {
      static final int VISIBLE = 0, GONE = 8;
      final int width; boolean intercept;
      final List<Runnable> frames=new ArrayList<>();
      View(int width) { this.width = width; }
      int getWidth() { return width; }
      void postOnAnimation(Runnable task){frames.add(task);}void removeCallbacks(Runnable task){frames.removeIf(value->value==task);}
      void frame(){List<Runnable> tasks=new ArrayList<>(frames);frames.clear();for(Runnable task:tasks)task.run();}
    }
    class MotionEvent {
      static final int ACTION_DOWN=0, ACTION_UP=1, ACTION_MOVE=2, ACTION_CANCEL=3, ACTION_POINTER_DOWN=5, ACTION_POINTER_UP=6;
      final int action, actionIndex; final int[] ids; final float[] xs;
      MotionEvent(int action, int id, float x) { this(action, 0, new int[] {id}, new float[] {x}); }
      MotionEvent(int action, int actionIndex, int[] ids, float[] xs) { this.action=action;this.actionIndex=actionIndex;this.ids=ids;this.xs=xs; }
      int getActionMasked() { return action; }
      int getActionIndex() { return actionIndex; }
      int getPointerId(int index) { return ids[index]; }
      int findPointerIndex(int id) { for (int index=0;index<ids.length;index++) if(ids[index]==id)return index;return -1; }
      float getX(int index) { return xs[index]; }
    }
`);
doubles[feedPath] = doubles[feedPath].replace("class ShortVideoHolder {", "class ShortVideoHolder { final View progressTouch = new View(100);");
const searchAdvancePause = activity.match(/  private static final class GallerySearchAdvancePause \{[\s\S]*?\n  \}/)?.[0];
assert(searchAdvancePause);
doubles[feedPath] = doubles[feedPath].replace("void scheduleGalleryAutoAdvance(ShortVideoHolder holder, ShortVideoItem item, int index) {}", [
  "scheduleGalleryAutoAdvance", "scheduleGalleryAutoAdvanceAfter", "cancelGalleryAutoAdvance", "resumeGalleryAutoAdvanceIfNeeded",
  "pauseGalleryAutoAdvanceForSearch", "resumeGalleryAutoAdvanceAfterSearch", "invalidateGallerySearchAdvance"
].map(member).join("\n") + searchAdvancePause.replace("private ", "") + `
  Runnable galleryAutoAdvanceRunnable;
  int galleryAutoAdvanceFeedIndex = -1, galleryAutoAdvanceMediaIndex = -1;
  long galleryAutoAdvanceDueAtMs;
  GallerySearchAdvancePause gallerySearchAdvancePause;
`);
doubles[feedPath] = doubles[feedPath].replace("import android.os.Handler;", "import android.os.Handler; import android.os.SystemClock;");
doubles[feedPath] = doubles[feedPath].replace("class ShortVideoHolder {", "class ShortVideoHolder { boolean touchActive,galleryScaling,galleryPanning,galleryDragActive,galleryDragSettling; float galleryZoomScale=1f;");
doubles[feedPath] = doubles[feedPath].replace("else completeGalleryImageForTest(holder,item,galleryIndex);",
  "else {completeGalleryImageForTest(holder,item,galleryIndex);if(holder.index==currentIndex)scheduleGalleryAutoAdvance(holder,item,galleryIndex);}");
doubles["android/os/SystemClock.java"] = `package android.os; public class SystemClock {
  public static long now; public static long uptimeMillis() { return now; } public static long elapsedRealtime() { return now; }
}`;
doubles["android/os/Handler.java"] = `package android.os; import java.util.*; public class Handler {
  public final ArrayList<Runnable> pending = new ArrayList<>(); public final IdentityHashMap<Runnable,Long> due = new IdentityHashMap<>();
  public boolean post(Runnable task) { return postDelayed(task,0); }
  public boolean postDelayed(Runnable task,long delay) { pending.add(task);due.put(task,SystemClock.now+delay);return true; }
  public void removeCallbacks(Runnable task) { pending.removeIf(value -> value==task);due.remove(task); }
  public void runPending() { ArrayList<Runnable> batch=new ArrayList<>(pending);for(Runnable task:batch)if(pending.contains(task)&&due.getOrDefault(task,0L)<=SystemClock.now){removeCallbacks(task);task.run();} }
}`;
if (!doubles["androidx/media3/exoplayer/ExoPlayer.java"].includes("getCurrentMediaItem()")) {
  doubles["androidx/media3/exoplayer/ExoPlayer.java"] = doubles["androidx/media3/exoplayer/ExoPlayer.java"]
    .replace("public MediaItem media;", "public MediaItem media; public MediaItem getCurrentMediaItem() { return media; }");
}
const search = fs.readFileSync(path.join(nativeRoot, "NativeShortVideoFeedSearchController.java"), "utf8");
const isOpen = search.match(/  boolean isOpen\(\) \{[\s\S]*?\n  \}/)?.[0];
assert(isOpen);
doubles["local/fanhao/library/NativeShortVideoFeedSearchController.java"] = `package local.fanhao.library;
  final class NativeShortVideoFeedSearchController { Object overlay; ${isOpen} }
`;
doubles["local/fanhao/library/NativeShortVideoInteractionHarness.java"] = `package local.fanhao.library;
import android.net.Uri;
import android.os.SystemClock;
import androidx.media3.common.MediaItem;
import androidx.media3.common.PlaybackException;
import androidx.media3.common.Player;
import androidx.media3.exoplayer.ExoPlayer;
import java.util.*;

public final class NativeShortVideoInteractionHarness {
  static int cases;
  static final List<String> failures = new ArrayList<>();
  static void require(boolean value, String message) { if (!value) throw new AssertionError(message); }
  static void check(String name, Runnable run) { cases++; try { run.run(); } catch (Throwable error) { failures.add(name+": "+error.getMessage()); } }
  static final class Fixture extends NativeShortVideoFeedPlaybackHost {
    Fixture(boolean gallery, boolean segment) {
      SystemClock.now=0;
      ShortVideoItem item=new ShortVideoItem("first"); if(gallery)item.galleryItems.add(new GalleryMedia(segment));
      videos.add(item); adapter.notifyDataSetChanged();currentIndex=-1;currentScreen=captureFeedScreen();startPlaybackAt(0);drain();
      if(activePlayer!=null)activePlayer.duration=60000;
    }
    View progress() { return attachedHolders.get(currentIndex).progressTouch; }
    void touch(View view,int action,int id,float x) { seekActivePlayerFromTouch(view,new MotionEvent(action,id,x)); }
    Runnable search() { Runnable restore=pausePlaybackForFeedSearch();feedSearchController.overlay=new Object();return restore; }
    void closeSearch(Runnable restore) { feedSearchController.overlay=null;restore.run(); }
    void images() { videos.get(0).galleryItems.add(new GalleryMedia(false));bindGallery(attachedHolders.get(0),videos.get(0),0,0); }
    void tick(long delay) { SystemClock.now+=delay;mainHandler.runPending(); }
  }
  public static void main(String[] args) {
    for(boolean paused:List.of(false,true)) check("normal seek retains playback intent "+paused,()->{
      Fixture f=new Fixture(false,false);if(paused)f.activePlayer.pause();View view=f.progress();
      f.touch(view,MotionEvent.ACTION_DOWN,7,20);f.touch(view,MotionEvent.ACTION_MOVE,7,80);f.touch(view,MotionEvent.ACTION_UP,7,90);
      require(f.activePlayer.position==54000,"UP must commit its exact final target");
      require(f.activePlayer.getPlayWhenReady()!=paused,"seek must preserve the existing pause/play choice");
      require(!view.intercept,"UP must release the original parent interception");
      int seeks=f.activePlayer.seeks;f.touch(view,MotionEvent.ACTION_UP,7,10);require(f.activePlayer.seeks==seeks,"orphan UP must not seek");
    });
    check("old item progress cannot seek a new item",()->{
      Fixture f=new Fixture(false,false);View old=f.progress();f.touch(old,MotionEvent.ACTION_DOWN,7,20);
      f.videos.add(new ShortVideoItem("second"));f.adapter.notifyDataSetChanged();f.selectForTest(1);f.activePlayer.duration=60000;
      long position=f.activePlayer.position;int seeks=f.activePlayer.seeks;f.touch(old,MotionEvent.ACTION_MOVE,7,80);f.touch(old,MotionEvent.ACTION_UP,7,90);
      require(f.activePlayer.position==position&&f.activePlayer.seeks==seeks,"old A's touch moved B");require(!old.intercept,"stale touch retained old interception");
    });
    for(String changed:List.of("player","media","holder"))check("same item replacement invalidates seek "+changed,()->{
      Fixture f=new Fixture(false,false);View old=f.progress();f.touch(old,MotionEvent.ACTION_DOWN,7,20);
      if(changed.equals("player")){f.activePlayer=new ExoPlayer();f.activePlayer.duration=60000;f.playerCache.put(0,f.activePlayer);}
      else if(changed.equals("media"))f.activePlayer.setMediaItem(MediaItem.fromUri(f.playbackFallback.mediaUri(f.activePlayer,f.videos.get(0))));
      else f.attachedHolders.put(0,new ShortVideoHolder(0));
      long position=f.activePlayer.position;int seeks=f.activePlayer.seeks;f.touch(old,MotionEvent.ACTION_MOVE,7,80);
      require(f.activePlayer.position==position&&f.activePlayer.seeks==seeks,"replacement received obsolete seek");require(!old.intercept,"replacement did not release original interception");
    });
    check("secondary pointers do not redirect progress",()->{
      Fixture f=new Fixture(false,false);View view=f.progress();f.touch(view,MotionEvent.ACTION_DOWN,7,20);int seeks=f.activePlayer.seeks;
      f.seekActivePlayerFromTouch(view,new MotionEvent(MotionEvent.ACTION_POINTER_DOWN,1,new int[]{7,9},new float[]{20,95}));
      require(f.activePlayer.seeks==seeks,"secondary DOWN unexpectedly sought");
      f.seekActivePlayerFromTouch(view,new MotionEvent(MotionEvent.ACTION_MOVE,0,new int[]{9,7},new float[]{95,40}));
      view.frame();
      require(f.activePlayer.position==24000,"MOVE used a different finger after pointer reordering");seeks=f.activePlayer.seeks;
      f.seekActivePlayerFromTouch(view,new MotionEvent(MotionEvent.ACTION_POINTER_UP,0,new int[]{9,7},new float[]{95,40}));
      require(f.activePlayer.seeks==seeks&&view.intercept,"secondary UP ended or moved the owning finger");
      f.touch(view,MotionEvent.ACTION_UP,7,50);require(f.activePlayer.position==30000&&!view.intercept,"owning UP failed to finish");
    });
    check("owning pointer UP releases while another finger remains",()->{
      Fixture f=new Fixture(false,false);View view=f.progress();f.touch(view,MotionEvent.ACTION_DOWN,7,20);
      f.seekActivePlayerFromTouch(view,new MotionEvent(MotionEvent.ACTION_POINTER_UP,0,new int[]{7,9},new float[]{60,90}));
      require(f.activePlayer.position==36000&&!view.intercept,"owning POINTER_UP did not commit and release");
    });
    for(String boundary:List.of("cancel","pause","search","comments","author","missing-pointer"))check("seek cancellation "+boundary,()->{
      Fixture f=new Fixture(false,false);View view=f.progress();f.touch(view,MotionEvent.ACTION_DOWN,7,20);int seeks=f.activePlayer.seeks;
      if(boundary.equals("pause")){f.onPause();f.onResume();}
      if(boundary.equals("search"))f.feedSearchController.overlay=new Object();
      if(boundary.equals("comments"))f.comments=true;
      if(boundary.equals("author"))f.authorOverlay=new Object();
      f.touch(view,boundary.equals("cancel")?MotionEvent.ACTION_CANCEL:MotionEvent.ACTION_MOVE,boundary.equals("missing-pointer")?9:7,80);
      require(f.activePlayer.seeks==seeks,"retired gesture moved media");require(!view.intercept,"retired gesture retained parent interception");
    });
    check("inactive progress view cannot begin a seek",()->{
      Fixture f=new Fixture(false,false);View other=new View(100);int seeks=f.activePlayer.seeks;f.touch(other,MotionEvent.ACTION_DOWN,7,80);
      require(f.activePlayer.seeks==seeks&&!other.intercept,"unbound view captured the current player");
    });
    for(String overlay:List.of("search","comments"))for(int state:List.of(Player.STATE_READY,Player.STATE_BUFFERING,Player.STATE_ENDED))for(boolean requested:List.of(false,true))check("soundtrack intent "+overlay+" "+state+" "+requested,()->{
      Fixture f=new Fixture(true,false);f.gallerySoundPlayer.playbackState=state;f.gallerySoundPlayer.setPlayWhenReady(requested);
      if(overlay.equals("search")){Runnable restore=f.search();f.closeSearch(restore);}
      else {f.pauseForCommentsOverlay();f.comments=true;f.comments=false;f.resumeAfterCommentsOverlay(true);}
      require(f.gallerySoundPlayer.getPlayWhenReady()==(requested&&state!=Player.STATE_ENDED),"overlay lost buffering or paused soundtrack intent");
    });
    check("search remains silent across background and normal return",()->{
      Fixture f=new Fixture(true,false);Runnable restore=f.search();require(!f.gallerySoundPlayer.getPlayWhenReady(),"search failed to pause sound");
      f.onPause();f.onResume();f.drain();require(!f.gallerySoundPlayer.getPlayWhenReady(),"onResume restarted sound under search");
      f.selectForTest(0);require(!f.gallerySoundPlayer.getPlayWhenReady(),"late gallery bind restarted sound under search");
      f.closeSearch(restore);require(f.gallerySoundPlayer.getPlayWhenReady(),"closing visible search did not restore sound");
    });
    check("search blocks late video and gallery segment callbacks",()->{
      Fixture video=new Fixture(false,false);Runnable videoClose=video.search();video.startActivePlaybackIfVisible();
      require(!video.activePlayer.getPlayWhenReady(),"late video callback bypassed search");video.closeSearch(videoClose);require(video.activePlayer.getPlayWhenReady(),"video close lost intent");
      Fixture gallery=new Fixture(true,true);Runnable galleryClose=gallery.search();gallery.onPause();gallery.onResume();gallery.selectForTest(0);
      require(!gallery.activePlayer.getPlayWhenReady()&&!gallery.gallerySoundPlayer.getPlayWhenReady(),"late gallery callbacks bypassed search");
      gallery.closeSearch(galleryClose);require(gallery.activePlayer.getPlayWhenReady()&&gallery.gallerySoundPlayer.getPlayWhenReady(),"gallery close lost independent track intents");
    });
    check("fallback visibility independently rejects an open search",()->{
      Fixture f=new Fixture(false,false);ExoPlayer player=f.activePlayer;ShortVideoItem item=f.videos.get(0);
      f.playbackFallback.mediaUri(player,item);f.search();player.setPlayWhenReady(true);
      require(!f.shouldResumeFallbackPlayback(0,player),"fallback visibility treated search as unobscured");
      f.playbackFallback.handle(player,item,new PlaybackException(),()->f.shouldResumeFallbackPlayback(0,player));
      require(!player.getPlayWhenReady(),"fallback restarted playback under search");
    });
    check("search holds image advance and restores the remaining delay",()->{
      Fixture f=new Fixture(true,false);f.images();f.tick(1000);Runnable old=f.galleryAutoAdvanceRunnable;Runnable restore=f.search();
      require(f.galleryAutoAdvanceRunnable==null&&!f.mainHandler.pending.contains(old),"search did not remove the pending image timer");
      f.tick(10000);old.run();require(f.attachedHolders.get(0).galleryIndex==0,"queued old image timer advanced under search");
      f.closeSearch(restore);require(f.attachedHolders.get(0).galleryIndex==0,"search close itself jumped the image");
      require(f.galleryAutoAdvanceDueAtMs==SystemClock.now+3000,"search close reset the full image duration instead of the remaining 3 seconds");
      f.tick(2999);require(f.attachedHolders.get(0).galleryIndex==0,"remaining timer fired early");
      f.tick(1);require(f.attachedHolders.get(0).galleryIndex==1,"normal image advance failed to resume");
    });
    check("foreground search cannot rearm image advance",()->{
      Fixture f=new Fixture(true,false);f.images();f.tick(1000);Runnable restore=f.search();f.onPause();f.tick(10000);f.onResume();f.drain();
      require(f.galleryAutoAdvanceRunnable==null,"foreground resumed a timer behind search");
      f.advanceGallerySequence(0,0,"image");require(f.attachedHolders.get(0).galleryIndex==0,"direct late end callback bypassed search");
      f.closeSearch(restore);require(f.galleryAutoAdvanceDueAtMs==SystemClock.now+3000,"foreground search lost the remaining delay");
    });
    check("background search close defers image restoration until foreground",()->{
      Fixture f=new Fixture(true,false);f.images();f.tick(1500);Runnable restore=f.search();f.onPause();f.closeSearch(restore);
      require(f.galleryAutoAdvanceRunnable==null,"closing search in background rearmed playback");f.tick(10000);f.onResume();
      require(f.galleryAutoAdvanceDueAtMs==SystemClock.now+2500,"foreground failed to restore the paused remaining delay");
      require(f.attachedHolders.get(0).galleryIndex==0,"foreground restoration jumped an image");
    });
    check("search preserves an already paused gallery",()->{
      Fixture f=new Fixture(true,false);f.images();f.cancelGalleryAutoAdvance();f.gallerySoundPlayer.pause();int plays=f.gallerySoundPlayer.plays;
      Runnable restore=f.search();f.onPause();f.onResume();f.closeSearch(restore);f.tick(10000);f.resumeGalleryAutoAdvanceIfNeeded();
      require(f.galleryAutoAdvanceRunnable==null&&f.attachedHolders.get(0).galleryIndex==0,"search created an advance intent for a paused gallery");
      require(!f.gallerySoundPlayer.getPlayWhenReady()&&f.gallerySoundPlayer.plays==plays,"timer restoration played paused audio");
      f.bindGallery(f.attachedHolders.get(0),f.videos.get(0),1,1);require(f.galleryAutoAdvanceRunnable!=null,"an explicit new gallery selection must still advance normally");
    });
    for(String blocker:List.of("comments","toolbar"))check("other overlay retains image timer pause "+blocker,()->{
      Fixture f=new Fixture(true,false);f.images();Runnable restore=f.search();if(blocker.equals("comments"))f.comments=true;else f.playbackToolbarOverlay=new Object();
      f.closeSearch(restore);require(f.galleryAutoAdvanceRunnable==null,"closing search over another overlay rearmed timer");
      f.comments=false;f.playbackToolbarOverlay=null;f.resumeGalleryAutoAdvanceIfNeeded();require(f.galleryAutoAdvanceRunnable!=null,"released remaining image intent cannot resume");
    });
    for(String replacement:List.of("item","holder","media"))check("old search lease rejects a changed gallery "+replacement,()->{
      Fixture f=new Fixture(true,false);f.images();Runnable restore=f.search();
      if(replacement.equals("item"))f.videos.set(0,new ShortVideoItem("replacement"));
      if(replacement.equals("holder"))f.attachedHolders.put(0,new ShortVideoHolder(0));
      if(replacement.equals("media"))f.attachedHolders.get(0).galleryIndex=1;
      f.closeSearch(restore);require(f.galleryAutoAdvanceRunnable==null&&f.gallerySearchAdvancePause==null,"old search lease rearmed a replacement owner");
    });
    if(!failures.isEmpty())throw new AssertionError(String.join("\\n",failures));
    System.out.println("native-short-video-interaction: "+cases+" actual seek/modal/lifecycle cases passed");
  }
}`;

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "fanhao-native-interaction-"));
const javaHome = String(process.env.JAVA_HOME || "").trim() || "C:\\Program Files\\Android\\openjdk\\jdk-21.0.8";
const executable = name => fs.existsSync(path.join(javaHome, "bin", `${name}.exe`)) ? path.join(javaHome, "bin", `${name}.exe`) : name;
try {
  const sources = [];
  for (const [relative, text] of Object.entries(doubles)) {
    const file = path.join(tempRoot, relative); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); sources.push(file);
  }
  for (const file of ["NativeShortVideoPlaybackFallback.java", "NativeShortVideoScreenState.java", "NativeShortVideoFeedPlayback.java", "NativeShortVideoSeekSession.java"]) sources.push(path.join(nativeRoot, file));
  const compiled = spawnSync(executable("javac"), ["-encoding", "UTF-8", "-d", tempRoot, ...sources], { cwd: root, encoding: "utf8" });
  assert.equal(compiled.status, 0, `interaction harness must compile:\n${compiled.stderr || compiled.stdout}`);
  const executed = spawnSync(executable("java"), ["-cp", tempRoot, "local.fanhao.library.NativeShortVideoInteractionHarness"], { cwd: root, encoding: "utf8" });
  assert.equal(executed.status, 0, `interaction harness must pass:\n${executed.stderr || executed.stdout}`); process.stdout.write(executed.stdout);
} finally {
  const target = path.resolve(tempRoot), parent = path.resolve(os.tmpdir());
  assert(target.startsWith(parent + path.sep) && path.basename(target).startsWith("fanhao-native-interaction-"), "cleanup must remain inside its own temporary fixture directory");
  fs.rmSync(target, { recursive: true, force: true });
}
