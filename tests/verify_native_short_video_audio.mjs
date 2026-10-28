import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { inflateRawSync } from "node:zlib";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// Actual Activity construction/lifecycle and FeedPlayback, plus the installed
// Media3 AudioBecomingNoisyManager bytecode. Only Android delivery/clock/UI are
// doubled. No device, APK, service, source media or persistent data is touched.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const interactionFile = new URL("./verify_native_short_video_interaction.mjs", import.meta.url);
const interaction = fs.readFileSync(interactionFile, "utf8").replace(/\r\n/g, "\n");
const start = interaction.indexOf("// Reuse the native playback"), end = interaction.indexOf('doubles["local/fanhao/library/NativeShortVideoInteractionHarness.java"] =');
assert(start >= 0 && end > start);
const bootstrap = interaction.slice(start, end).replaceAll("import.meta.url", JSON.stringify(interactionFile.href));
const environment = vm.createContext({ assert, fs, os, path, vm, spawnSync, fileURLToPath, process });
vm.runInContext(`${bootstrap}\nglobalThis.fixture = { doubles, activity, nativeRoot };`, environment);
const { doubles, activity, nativeRoot } = environment.fixture;
function member(name) {
  const method = activity.match(new RegExp(`  private void ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n  \\}`))?.[0];
  assert(method, `missing native audio intent method ${name}`); return method.replace("private ", "final ");
}
assert.match(activity, /readControlPreferences\(\);\s+initializeAudioInterruptionHandling\(\);/,
  "Activity creation must enable the intent listener before building players");
const destroy = activity.match(/  protected void onDestroy\(\) \{[\s\S]*?\n  \}/)?.[0];
assert(destroy, "Activity destruction method missing");
assert.match(destroy, /destroying = true;[\s\S]*releaseAudioInterruptionHandling\(\);/,
  "Activity destruction must disable the intent listener");

function builder(name, methodName) {
  const method = activity.match(new RegExp(`  private (?:ExoPlayer|void) ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n  \\}`))?.[0];
  assert(method, `missing native player construction ${name}`);
  const begin = method.indexOf("ExoPlayer.Builder "), built = /ExoPlayer (\w+) = \w+\.build\(\);/.exec(method.slice(begin));
  assert(begin >= 0 && built);
  return `ExoPlayer ${methodName}() { ${method.slice(begin, begin + built.index + built[0].length)} return ${built[1]}; }`;
}
const producers = [builder("preparePlayerAt", "video"), builder("ensureGallerySegmentPlayer", "segment"), builder("playGallerySound", "sound")].join("\n");
doubles["androidx/media3/exoplayer/ExoPlayer.java"] = doubles["androidx/media3/exoplayer/ExoPlayer.java"].replace("public class ExoPlayer {", `public class ExoPlayer {
  public boolean noisyEnabled;
  public static class Builder {
    boolean noisy;
    public Builder(Object context) {}
    public Builder setHandleAudioBecomingNoisy(boolean value) { noisy=value;return this; }
    public Builder setAudioAttributes(androidx.media3.common.AudioAttributes value,boolean handleFocus) {return this;}
    public Builder setLoadControl(Object control) { return this; }
    public Builder setMediaSourceFactory(Object factory) { return this; }
    public ExoPlayer build() { ExoPlayer player=new ExoPlayer();player.noisyEnabled=noisy;return player; }
  }
`);
doubles["androidx/media3/exoplayer/DefaultLoadControl.java"] = `package androidx.media3.exoplayer;public class DefaultLoadControl {
  public static class Builder { public Builder setBufferDurationsMs(int a,int b,int c,int d){return this;}public DefaultLoadControl build(){return new DefaultLoadControl();} }
}`;
doubles["androidx/media3/exoplayer/source/DefaultMediaSourceFactory.java"] = "package androidx.media3.exoplayer.source;public class DefaultMediaSourceFactory {public DefaultMediaSourceFactory(Object source){}}";
doubles["androidx/media3/common/C.java"] = "package androidx.media3.common;public class C {public static final int USAGE_MEDIA=1,AUDIO_CONTENT_TYPE_MUSIC=2,AUDIO_CONTENT_TYPE_MOVIE=3;}";
doubles["androidx/media3/common/AudioAttributes.java"] = "package androidx.media3.common;public class AudioAttributes {public static class Builder {public Builder setUsage(int value){return this;}public Builder setContentType(int value){return this;}public AudioAttributes build(){return new AudioAttributes();}}}";
doubles["android/content/Context.java"] = `package android.content;import java.util.*;public class Context {
  public final List<BroadcastReceiver> receivers=new ArrayList<>();
  public Context getApplicationContext(){return this;}
  public Intent registerReceiver(BroadcastReceiver receiver,IntentFilter filter){receivers.add(receiver);return null;}
  public void unregisterReceiver(BroadcastReceiver receiver){receivers.remove(receiver);}
  public void send(String action){for(BroadcastReceiver receiver:new ArrayList<>(receivers))receiver.onReceive(this,new Intent(action));}
}`;
doubles["android/content/BroadcastReceiver.java"] = "package android.content;public abstract class BroadcastReceiver {public abstract void onReceive(Context context,Intent intent);}";
doubles["android/content/Intent.java"] = "package android.content;public class Intent {final String action;public Intent(String action){this.action=action;}public String getAction(){return action;}}";
doubles["android/content/IntentFilter.java"] = "package android.content;public class IntentFilter {public IntentFilter(String action){}}";
doubles["android/os/Looper.java"] = "package android.os;public class Looper {public Handler handler;public Looper(){}public Looper(Handler handler){this.handler=handler;}}";
doubles["android/os/Handler.java"] = doubles["android/os/Handler.java"].replace("public class Handler {", "public class Handler {public interface Callback {}public Looper getLooper(){return new Looper(this);}");
doubles["androidx/media3/common/util/Clock.java"] = "package androidx.media3.common.util;import android.os.*;public interface Clock {Clock DEFAULT=(looper,callback)->task->looper.handler.post(task);HandlerWrapper createHandler(Looper looper,Handler.Callback callback);}";
doubles["androidx/media3/common/util/HandlerWrapper.java"] = "package androidx.media3.common.util;public interface HandlerWrapper {boolean post(Runnable task);}";
doubles["local/fanhao/library/NativeShortVideoPlaybackHost.java"] = doubles["local/fanhao/library/NativeShortVideoPlaybackHost.java"]
  .replace("class NativeShortVideoPlaybackHost {", "class NativeShortVideoPlaybackHost extends android.content.Context {");
doubles["local/fanhao/library/NativeShortVideoFeedPlaybackHost.java"] = doubles["local/fanhao/library/NativeShortVideoFeedPlaybackHost.java"]
  .replace("class NativeShortVideoFeedPlaybackHost extends NativeShortVideoPlaybackHost {", `class NativeShortVideoFeedPlaybackHost extends NativeShortVideoPlaybackHost {
    androidx.media3.common.audio.AudioBecomingNoisyManager audioInterruptionManager;
    ${["initializeAudioInterruptionHandling", "releaseAudioInterruptionHandling", "handleAudioInterruption"].map(member).join("\n")}
  `)
  .replace("import android.os.Handler;", "import android.os.Handler;import androidx.media3.common.audio.AudioBecomingNoisyManager;import androidx.media3.common.util.Clock;");
delete doubles["local/fanhao/library/NativeShortVideoInteractionHarness.java"];
doubles["local/fanhao/library/NativeShortVideoAudioHarness.java"] = `package local.fanhao.library;
import java.util.*;import android.content.Context;import android.os.Looper;
import androidx.media3.common.Player;import androidx.media3.common.C;import androidx.media3.common.AudioAttributes;import androidx.media3.exoplayer.ExoPlayer;import androidx.media3.exoplayer.DefaultLoadControl;
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory;import androidx.media3.common.audio.AudioBecomingNoisyManager;
import androidx.media3.common.util.Clock;

public final class NativeShortVideoAudioHarness {
  static int cases;static final List<String> failures=new ArrayList<>();
  static void require(boolean value,String message){if(!value)throw new AssertionError(message);}
  static void check(String name,Runnable test){cases++;try{test.run();}catch(Throwable error){failures.add(name+": "+error.getMessage());}}
  static final class Producers { Object videoCacheDataSourceFactory,videoPlaybackDataSourceFactory; ${producers} }
  static final class Delivery implements AutoCloseable {
    final Context context=new Context();final List<Runnable> pending=new ArrayList<>();final AudioBecomingNoisyManager manager;
    Delivery(ExoPlayer player,boolean enabled){
      Clock clock=(looper,callback)->task->{pending.add(task);return true;};
      manager=new AudioBecomingNoisyManager(context,new Looper(),new Looper(),()->player.setPlayWhenReady(false),clock);
      manager.setEnabled(enabled);drain();
    }
    void drain(){while(!pending.isEmpty()){List<Runnable>batch=new ArrayList<>(pending);pending.clear();for(Runnable task:batch)task.run();}}
    void unplug(){context.send("android.media.AUDIO_BECOMING_NOISY");drain();}
    void reconnect(){context.send("android.intent.action.HEADSET_PLUG");drain();}
    public void close(){manager.setEnabled(false);drain();require(context.receivers.isEmpty(),"noisy manager receiver leak");}
  }
  static final class Fixture extends NativeShortVideoFeedPlaybackHost {
    static final List<Fixture> all=new ArrayList<>();
    Fixture(boolean gallery,boolean segment,boolean visible){
      all.add(this);initializeAudioInterruptionHandling();
      activityResumed=visible;ShortVideoItem item=new ShortVideoItem("audio-current");if(gallery)item.galleryItems.add(new GalleryMedia(segment));
      videos.add(item);adapter.notifyDataSetChanged();currentIndex=-1;currentScreen=captureFeedScreen();startPlaybackAt(0);drain();
    }
    void unplug(Delivery playerDelivery){send("android.media.AUDIO_BECOMING_NOISY");playerDelivery.unplug();drain();}
    void destroyAudio(){destroying=true;releaseAudioInterruptionHandling();drain();require(receivers.isEmpty(),"Activity intent receiver leak");}
  }
  public static void main(String[]args){
    Producers producers=new Producers();
    for(int kind=0;kind<3;kind++){final int type=kind;check("production builder noisy wiring "+type,()->{
      ExoPlayer player=type==0?producers.video():type==1?producers.segment():producers.sound();
      require(player.noisyEnabled,"production builder left headphone-disconnect handling disabled");player.play();
      try(Delivery delivery=new Delivery(player,player.noisyEnabled)){
        require(delivery.context.receivers.size()==1,"actual Media3 did not subscribe");delivery.unplug();require(!player.getPlayWhenReady(),"noisy did not pause playback");
        int plays=player.plays;delivery.reconnect();require(!player.getPlayWhenReady()&&player.plays==plays,"reconnecting headphones implicitly played media");
      }
    });}
    check("actual Media3 opt-out negative control",()->{
      ExoPlayer player=new ExoPlayer();player.play();try(Delivery delivery=new Delivery(player,false)){
        require(delivery.context.receivers.isEmpty(),"opt-out unexpectedly registered a receiver");delivery.unplug();require(player.getPlayWhenReady(),"opt-out control cannot reproduce the original defect");
      }
    });
    for(int kind=0;kind<3;kind++){final int type=kind;check("noisy pause survives lifecycle "+type,()->{
      Fixture f=new Fixture(type!=0,type==1,true);ExoPlayer player=type==0?f.activePlayer:type==1?f.gallerySegmentPlayer:f.gallerySoundPlayer;
      boolean enabled=(type==0?producers.video():type==1?producers.segment():producers.sound()).noisyEnabled;
      try(Delivery delivery=new Delivery(player,enabled)){
        delivery.unplug();require(!player.getPlayWhenReady(),"noisy did not pause current owner");f.onPause();f.onResume();f.drain();
        require(!player.getPlayWhenReady(),"foreground return undid the headphone-disconnect pause");int plays=player.plays;
        delivery.reconnect();f.onResume();f.drain();require(!player.getPlayWhenReady()&&player.plays==plays,"reconnect or repeated resume restarted paused media");
      }
    });}
    for(int state:new int[]{Player.STATE_READY,Player.STATE_BUFFERING})for(boolean requested:new boolean[]{false,true})check("ordinary sound lifecycle "+state+" "+requested,()->{
      Fixture f=new Fixture(true,false,true);ExoPlayer sound=f.gallerySoundPlayer;sound.playbackState=state;sound.setPlayWhenReady(requested);sound.position=13579;
      f.onPause();f.onResume();f.drain();require(sound.getPlayWhenReady()==requested,"normal pause/buffering intent was lost");require(sound.position==13579,"sound lifecycle rewound position");
      f.onResume();require(sound.getPlayWhenReady()==requested,"duplicate foreground event changed audio intent");
    });
    check("cold gallery sound waits for its first foreground",()->{
      Fixture f=new Fixture(true,false,false);require(f.gallerySoundPlayer==null||!f.gallerySoundPlayer.getPlayWhenReady(),"cold background gallery autoplayed");
      require(f.selectedPlaybackRequest!=null&&!f.selectedPlaybackRequest.committed&&f.selectedPlaybackRequest.item==f.videos.get(0)&&f.selectedPlaybackRequest.index==f.pager.getCurrentItem(),"cold gallery lost its owned pending first-start intent");
      f.onResume();f.drain();require(f.gallerySoundPlayer.getPlayWhenReady(),"first foreground failed to start selected gallery sound");
    });
    check("lifecycle audio restore does not seek back over a new position",()->{
      Fixture f=new Fixture(true,false,true);f.gallerySoundPlayer.position=10000;f.onPause();f.gallerySoundPlayer.seekTo(15000);f.onResume();
      require(f.gallerySoundPlayer.position==15000&&f.gallerySoundPlayer.getPlayWhenReady(),"audio restore applied obsolete position");
    });
    for(String changed:List.of("player","item"))check("sound restore rejects replaced owner "+changed,()->{
      Fixture f=new Fixture(true,false,true);f.onPause();
      if(changed.equals("player"))f.gallerySoundPlayer=new ExoPlayer();else f.videos.set(0,new ShortVideoItem("replacement"));
      f.onResume();require(!f.gallerySoundPlayer.getPlayWhenReady(),"retired sound lease started a different owner");
    });
    check("new gallery selected in background has its own audio intent",()->{
      Fixture f=new Fixture(true,false,true);f.onPause();ShortVideoItem replacement=new ShortVideoItem("selected-new");replacement.galleryItems.add(new GalleryMedia(false));
      f.videos.set(0,replacement);f.adapter.notifyDataSetChanged();f.selectForTest(0);require(!f.gallerySoundPlayer.getPlayWhenReady(),"new hidden selection started too early");
      f.onResume();require(f.gallerySoundPlayer.getPlayWhenReady(),"new explicit selection inherited the departed sound pause");
    });
    for(boolean requested:new boolean[]{false,true})check("author sound awaiting restore "+requested,()->{
      Fixture f=new Fixture(true,false,true);f.gallerySoundPlayer.setPlayWhenReady(requested);f.gallerySoundPlayer.position=24680;
      f.showAuthorPanel(f.videos.get(0));f.onPause();f.navigateBack();f.drain();f.onResume();f.drain();
      require(f.gallerySoundPlayer.getPlayWhenReady()==requested&&f.gallerySoundPlayer.position==24680,"audio guard lost an owned author-return intent");
    });
    for(int kind=0;kind<3;kind++){final int type=kind;check("background pending intent interrupted "+type,()->{
      Fixture f=new Fixture(type!=0,type==1,true);ExoPlayer player=type==0?f.activePlayer:type==1?f.gallerySegmentPlayer:f.gallerySoundPlayer;
      try(Delivery delivery=new Delivery(player,true)){
        f.onPause();long generation=f.feedPlayback.audioInterruptionGeneration();f.unplug(delivery);
        require(f.feedPlayback.audioInterruptionGeneration()==generation+1,"actual SDK listener did not invalidate pending intent while paused");
        f.onResume();f.drain();require(!player.getPlayWhenReady(),"background noisy event revived on resume");
        player.play();f.onPause();f.onResume();f.drain();require(player.getPlayWhenReady(),"new explicit playback was permanently disabled by interruption");
      }
    });}
    for(String overlay:List.of("search","comments"))for(int kind=0;kind<3;kind++){final int type=kind;check("overlay pending intent interrupted "+overlay+" "+type,()->{
      Fixture f=new Fixture(type!=0,type==1,true);ExoPlayer player=type==0?f.activePlayer:type==1?f.gallerySegmentPlayer:f.gallerySoundPlayer;
      try(Delivery delivery=new Delivery(player,true)){
        Runnable restore=null;if(overlay.equals("search"))restore=f.pausePlaybackForFeedSearch();else f.pauseForCommentsOverlay();
        require(!player.getPlayWhenReady(),"overlay did not pause owner");f.unplug(delivery);
        if(restore!=null)restore.run();else f.resumeAfterCommentsOverlay(true);
        require(!player.getPlayWhenReady(),"closing "+overlay+" restored an interrupted audio intent");
        player.play();if(overlay.equals("search")){Runnable fresh=f.pausePlaybackForFeedSearch();fresh.run();}else{f.pauseForCommentsOverlay();f.resumeAfterCommentsOverlay(true);}
        require(player.getPlayWhenReady(),"fresh explicit audio intent could not survive a new overlay");
      }
    });}
    for(int kind=0;kind<3;kind++){final int type=kind;check("archived author snapshot interrupted "+type,()->{
      Fixture f=new Fixture(type!=0,type==1,true);ExoPlayer player=type==0?f.activePlayer:type==1?f.gallerySegmentPlayer:f.gallerySoundPlayer;player.position=17321;
      f.showAuthorPanel(f.videos.get(0));try(Delivery delivery=new Delivery(player,true)){
        f.unplug(delivery);f.navigateBack();f.drain();ExoPlayer restored=type==0?f.activePlayer:type==1?f.gallerySegmentPlayer:f.gallerySoundPlayer;
        require(!restored.getPlayWhenReady()&&restored.position==17321,"old author snapshot replayed or lost its position after interruption");
        restored.play();f.showAuthorPanel(f.videos.get(0));f.navigateBack();f.drain();ExoPlayer fresh=type==0?f.activePlayer:type==1?f.gallerySegmentPlayer:f.gallerySoundPlayer;
        require(fresh.getPlayWhenReady(),"new snapshot inherited an obsolete interruption");
      }
    });}
    check("interruption does not block a newly selected work",()->{
      Fixture f=new Fixture(false,false,true);try(Delivery delivery=new Delivery(f.activePlayer,true)){f.unplug(delivery);}
      f.videos.add(new ShortVideoItem("explicit-next"));f.adapter.notifyDataSetChanged();f.selectForTest(1);f.drain();
      require(f.activePlayer.getPlayWhenReady(),"new work inherited old interrupted intent");
    });
    check("intent listener idempotency and queued destroy",()->{
      Fixture f=new Fixture(false,false,true);f.initializeAudioInterruptionHandling();f.drain();require(f.receivers.size()==1,"repeated initialize registered multiple listeners");
      long generation=f.feedPlayback.audioInterruptionGeneration();f.send("android.media.AUDIO_BECOMING_NOISY");f.send("android.media.AUDIO_BECOMING_NOISY");f.drain();
      require(f.feedPlayback.audioInterruptionGeneration()==generation+2,"repeated SDK delivery lost interruption ownership");
      generation=f.feedPlayback.audioInterruptionGeneration();f.send("android.media.AUDIO_BECOMING_NOISY");f.destroyAudio();f.releaseAudioInterruptionHandling();
      require(f.feedPlayback.audioInterruptionGeneration()==generation,"queued noisy callback mutated destroyed Activity");
      f.send("android.media.AUDIO_BECOMING_NOISY");f.drain();require(f.feedPlayback.audioInterruptionGeneration()==generation,"destroyed listener remained subscribed");
    });
    for(Fixture f:Fixture.all)f.destroyAudio();
    if(!failures.isEmpty())throw new AssertionError(String.join("\\n",failures));
    System.out.println("native-short-video-audio: "+cases+" actual builder/Media3 noisy/lifecycle cases passed");
  }
}`;

// Read the already-installed dependency; never download SDKs or contact a
// repository during this verification. The normal APK build supplies this AAR.
const gradle = fs.readFileSync(path.join(root, "android-client/android/app/build.gradle"), "utf8");
const version = /androidx\.media3:media3-common:([^"\s]+)/.exec(gradle)?.[1]
  || /androidx\.media3:media3-exoplayer:([^"\s]+)/.exec(gradle)?.[1];
assert(version, "Media3 dependency version missing");
const dependencyRoot = path.join(process.env.GRADLE_USER_HOME || path.join(os.homedir(), ".gradle"), "caches/modules-2/files-2.1/androidx.media3/media3-common", version);
const suppliedAar = process.env.FANHAO_TEST_MEDIA3_COMMON_AAR;
const aar = suppliedAar || (fs.existsSync(dependencyRoot) ? fs.readdirSync(dependencyRoot).flatMap(hash => {
  const folder = path.join(dependencyRoot, hash);
  return fs.statSync(folder).isDirectory() ? fs.readdirSync(folder).filter(name => name.endsWith(".aar")).map(name => path.join(folder, name)) : [];
})[0] : "");
assert(aar && fs.existsSync(aar), "cached Media3 common AAR required; build the APK first or set FANHAO_TEST_MEDIA3_COMMON_AAR");
function zipEntry(archive, wanted) {
  const bytes = fs.readFileSync(archive), eocd = bytes.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  assert(eocd >= 0); let cursor = bytes.readUInt32LE(eocd + 16);
  for (let index = 0; index < bytes.readUInt16LE(eocd + 10); index++) {
    assert.equal(bytes.readUInt32LE(cursor), 0x02014b50);
    const compression = bytes.readUInt16LE(cursor + 10), size = bytes.readUInt32LE(cursor + 20), nameLength = bytes.readUInt16LE(cursor + 28);
    const name = bytes.subarray(cursor + 46, cursor + 46 + nameLength).toString("utf8"), local = bytes.readUInt32LE(cursor + 42);
    if (name === wanted) {
      assert.equal(bytes.readUInt32LE(local), 0x04034b50);
      const start = local + 30 + bytes.readUInt16LE(local + 26) + bytes.readUInt16LE(local + 28), compressed = bytes.subarray(start, start + size);
      assert(compression === 0 || compression === 8); return compression === 8 ? inflateRawSync(compressed) : compressed;
    }
    cursor += 46 + nameLength + bytes.readUInt16LE(cursor + 30) + bytes.readUInt16LE(cursor + 32);
  }
  throw new Error(`missing ${wanted} in Media3 AAR`);
}
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "fanhao-native-audio-current-"));
const javaHome = process.env.JAVA_HOME || "C:/Program Files/Android/openjdk/jdk-21.0.8";
const exe = name => fs.existsSync(path.join(javaHome, "bin", `${name}.exe`)) ? path.join(javaHome, "bin", `${name}.exe`) : name;
try {
  const jar = path.join(tempRoot, "media3-common.jar"); fs.writeFileSync(jar, zipEntry(aar, "classes.jar"));
  const sources = [];
  for (const [relative, text] of Object.entries(doubles)) {
    const file = path.join(tempRoot, relative); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); sources.push(file);
  }
  for (const name of ["NativeShortVideoPlaybackFallback.java", "NativeShortVideoScreenState.java", "NativeShortVideoFeedPlayback.java", "NativeShortVideoSeekSession.java"]) sources.push(path.join(nativeRoot, name));
  const compiled = spawnSync(exe("javac"), ["-encoding", "UTF-8", "-cp", jar, "-d", tempRoot, ...sources], { encoding: "utf8", cwd: root });
  assert.equal(compiled.status, 0, `native audio harness must compile:\n${compiled.stderr}`);
  const result = spawnSync(exe("java"), ["-cp", tempRoot + path.delimiter + jar, "local.fanhao.library.NativeShortVideoAudioHarness"], { encoding: "utf8", cwd: root });
  assert.equal(result.status, 0, `native audio harness must pass:\n${result.stderr}`); process.stdout.write(result.stdout);
} finally {
  const target = fs.realpathSync(tempRoot), parent = fs.realpathSync(os.tmpdir());
  assert.equal(path.dirname(target), parent); assert(path.basename(target).startsWith("fanhao-native-audio-current-"));
  fs.rmSync(target, { recursive: true, force: true });
}
