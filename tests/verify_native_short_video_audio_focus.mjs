import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { inflateRawSync } from "node:zlib";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// Execute the current Activity builder snippets, tap/indicator and navigation
// methods with Media3's installed AudioFocusManager bytecode. Android focus
// delivery/request objects and the native player engine are controlled adapters;
// no device, service, downloads, real media or persistent data is used.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const nativeRoot = path.join(root, "android-client/android/app/src/main/java/local/fanhao/library");
const original = fs.readFileSync(path.join(root, "tests/verify_native_short_video_playback.mjs"), "utf8").replace(/\r\n/g, "\n");
const start = original.indexOf("const doubles = {"), end = original.indexOf("  for (const [relative, source] of Object.entries(doubles))");
assert(start >= 0 && end > start);
const environment = vm.createContext({ fs, path, assert, root, nativeRoot, advisories: { check() {} } });
vm.runInContext(`${original.slice(start, end).replace("try {\n  const sources = [];", "const sources = [];")}\nglobalThis.fixture = doubles;`, environment);
const doubles = environment.fixture;
const activity = fs.readFileSync(path.join(nativeRoot, "NativeShortVideoActivity.java"), "utf8").replace(/\r\n/g, "\n");
function method(name) {
  const body = activity.match(new RegExp(`  private (?:void|ExoPlayer) ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n  \\}`))?.[0];
  assert(body, `missing native focus method ${name}`); return body.replace("private ", "final ").replaceAll("@Nullable ", "");
}
function producer(name, target) {
  const body = method(name), begin = body.indexOf("ExoPlayer.Builder ");
  const built = /ExoPlayer (\w+) = \w+\.build\(\);/.exec(body.slice(begin));
  assert(begin >= 0 && built);
  return `ExoPlayer ${target}(){${body.slice(begin, begin + built.index + built[0].length).replaceAll(".Builder(this)", ".Builder(context)")}return ${built[1]};}`;
}
const producers = [producer("preparePlayerAt", "video"), producer("ensureGallerySegmentPlayer", "segment"), producer("playGallerySound", "sound")].join("\n");
doubles["local/fanhao/library/NativeShortVideoFocusProducers.java"] = `package local.fanhao.library;
import android.content.Context;import androidx.media3.common.AudioAttributes;import androidx.media3.common.C;
import androidx.media3.exoplayer.ExoPlayer;import androidx.media3.exoplayer.DefaultLoadControl;import androidx.media3.exoplayer.source.DefaultMediaSourceFactory;
final class NativeShortVideoFocusProducers {final Context context;Object videoCacheDataSourceFactory,videoPlaybackDataSourceFactory;
NativeShortVideoFocusProducers(Context context){this.context=context;}${producers}}
`;
doubles["android/content/Context.java"] = `package android.content;public class Context {public final android.media.AudioManager audio=new android.media.AudioManager();}`;
doubles["android/os/Looper.java"] = "package android.os;public class Looper {}";
doubles["android/os/Handler.java"] = doubles["android/os/Handler.java"].replace("public class Handler {", "public class Handler {public Handler(){}public Handler(Looper looper){}");
doubles["android/media/AudioManager.java"] = `package android.media;import java.util.*;public class AudioManager {
 public interface OnAudioFocusChangeListener {void onAudioFocusChange(int value);}
 public int requests, abandons, requestResult=1;public final List<String> events=new ArrayList<>();
 public final List<OnAudioFocusChangeListener> listeners=new ArrayList<>();
 public void externalFocus(int value){for(OnAudioFocusChangeListener listener:new ArrayList<>(listeners))listener.onAudioFocusChange(value);}
}`;
doubles["androidx/media3/common/C.java"] = "package androidx.media3.common;public class C {public static final int USAGE_MEDIA=1,AUDIO_CONTENT_TYPE_MUSIC=2,AUDIO_CONTENT_TYPE_MOVIE=3;}";
doubles["androidx/media3/common/AudioAttributes.java"] = `package androidx.media3.common;public final class AudioAttributes {
public final int usage,contentType;AudioAttributes(int usage,int contentType){this.usage=usage;this.contentType=contentType;}
public static class Builder {int usage=1,contentType;public Builder setUsage(int value){usage=value;return this;}public Builder setContentType(int value){contentType=value;return this;}public AudioAttributes build(){return new AudioAttributes(usage,contentType);}}}`;
doubles["androidx/media3/common/util/Log.java"] = "package androidx.media3.common.util;public class Log {public static void w(String tag,String message){}}";
doubles["androidx/media3/common/audio/AudioFocusRequestCompat.java"] = `package androidx.media3.common.audio;
import android.media.AudioManager;import android.os.Handler;import androidx.media3.common.AudioAttributes;
public class AudioFocusRequestCompat {public AudioManager.OnAudioFocusChangeListener listener;public AudioAttributes attributes;public boolean delayed;
public Builder buildUpon(){return new Builder(1);}public static class Builder {final AudioFocusRequestCompat result=new AudioFocusRequestCompat();public Builder(int gain){}
public Builder setAudioAttributes(AudioAttributes attributes){result.attributes=attributes;return this;}public Builder setWillPauseWhenDucked(boolean value){return this;}
public Builder setAcceptsDelayedFocusGain(boolean value){result.delayed=value;return this;}
public Builder setOnAudioFocusChangeListener(AudioManager.OnAudioFocusChangeListener listener,Handler handler){result.listener=listener;return this;}public AudioFocusRequestCompat build(){return result;}}}`;
doubles["androidx/media3/common/audio/AudioManagerCompat.java"] = `package androidx.media3.common.audio;import android.content.Context;import android.media.AudioManager;
public class AudioManagerCompat {public static AudioManager getAudioManager(Context context){return context.audio;}
public static int requestAudioFocus(AudioManager manager,AudioFocusRequestCompat request){manager.requests++;manager.events.add("request");if(manager.requestResult!=0&&!manager.listeners.contains(request.listener))manager.listeners.add(request.listener);return manager.requestResult;}
public static int abandonAudioFocusRequest(AudioManager manager,AudioFocusRequestCompat request){manager.abandons++;manager.events.add("abandon");manager.listeners.remove(request.listener);return 1;}}`;
doubles["androidx/media3/exoplayer/DefaultLoadControl.java"] = "package androidx.media3.exoplayer;public class DefaultLoadControl {public static class Builder {public Builder setBufferDurationsMs(int a,int b,int c,int d){return this;}public DefaultLoadControl build(){return new DefaultLoadControl();}}}";
doubles["androidx/media3/exoplayer/source/DefaultMediaSourceFactory.java"] = "package androidx.media3.exoplayer.source;public class DefaultMediaSourceFactory {public DefaultMediaSourceFactory(Object factory){}}";
let player = doubles["androidx/media3/exoplayer/ExoPlayer.java"];
player = player.replace("public class ExoPlayer {", `public class ExoPlayer {
 public boolean focusEnabled,noisyEnabled,suppressed;public float volume=1f,focusMultiplier=1f;public int commands;
 public androidx.media3.common.AudioAttributes attributes;public androidx.media3.common.audio.AudioFocusManager focus;
 public static class Builder {final android.content.Context context;boolean enabled,noisy;androidx.media3.common.AudioAttributes attributes;
 public Builder(Object context){this.context=(android.content.Context)context;}public Builder setAudioAttributes(androidx.media3.common.AudioAttributes value,boolean enabled){attributes=value;this.enabled=enabled;return this;}
 public Builder setHandleAudioBecomingNoisy(boolean value){noisy=value;return this;}public Builder setLoadControl(Object control){return this;}public Builder setMediaSourceFactory(Object factory){return this;}
 public ExoPlayer build(){ExoPlayer player=new ExoPlayer();player.focusEnabled=enabled;player.noisyEnabled=noisy;player.attributes=attributes;
 player.focus=new androidx.media3.common.audio.AudioFocusManager(context,new android.os.Looper(),new androidx.media3.common.audio.AudioFocusManager.PlayerControl(){
 public void executePlayerCommand(int command){player.commands++;player.applyFocusCommand(command);}public void setVolumeMultiplier(float value){player.focusMultiplier=value;}});
 player.focus.setAudioAttributes(enabled?attributes:null);return player;}}
 // These command mappings follow ExoPlayerImplInternal: WAIT preserves PWR
 // and suppresses playback, DO_NOT_PLAY clears PWR, GAIN preserves user pause.
 void applyFocusCommand(int command){playWhenReady=playWhenReady&&command!=-1;suppressed=command==0;}
`);
player = player.replace("return playWhenReady && playbackState == Player.STATE_READY;", "return playWhenReady && playbackState == Player.STATE_READY && !suppressed;")
  .replace("public void setPlayWhenReady(boolean value) { touch(); playWhenReady = value; }", "public void setPlayWhenReady(boolean value) {touch();playWhenReady=value;if(focus!=null)applyFocusCommand(focus.updateAudioFocus(value,playbackState));}")
  .replace("public void stop() { touch(); playbackState = Player.STATE_IDLE; }", "public void stop() {touch();playbackState=Player.STATE_IDLE;if(focus!=null)focus.updateAudioFocus(playWhenReady,playbackState);}")
  .replace("public void release() { touch(); released = true; }", "public void release() {touch();if(focus!=null)focus.release();released=true;}")
  .replace("public void setVolume(float value) {}", "public void setVolume(float value) {volume=value;}");
doubles["androidx/media3/exoplayer/ExoPlayer.java"] = player;
const base = "local/fanhao/library/NativeShortVideoPlaybackHost.java", feed = "local/fanhao/library/NativeShortVideoFeedPlaybackHost.java";
doubles[base] = doubles[base].replace("class NativeShortVideoPlaybackHost {", "class NativeShortVideoPlaybackHost extends android.content.Context {");
doubles[feed] = doubles[feed]
  .replace("prepared++; ExoPlayer player = new ExoPlayer();", "prepared++; ExoPlayer player = new NativeShortVideoFocusProducers(this).video();")
  .replace("gallerySegmentPlayer = new ExoPlayer();", "gallerySegmentPlayer = new NativeShortVideoFocusProducers(this).segment();")
  .replace("gallerySoundPlayer = new ExoPlayer();", "gallerySoundPlayer = new NativeShortVideoFocusProducers(this).sound();")
  .replace("void releaseDistantPlayers(int index) {}", method("releaseDistantPlayers"))
  .replace("void releaseGallerySoundPlayer() {\n        if (gallerySoundPlayer != null) gallerySoundPlayer.release();\n        gallerySoundPlayer = null; gallerySoundUrl = \"\";\n      }", method("releaseGallerySoundPlayer"))
  .replace("class NativeShortVideoFeedPlaybackHost extends NativeShortVideoPlaybackHost {", `class NativeShortVideoFeedPlaybackHost extends NativeShortVideoPlaybackHost {boolean controlsHidden;final Map<Integer,PlayerView> playerViews=new HashMap<>();
    ${method("syncPlayIndicator")}
    `)
  .replace("class View { static final int VISIBLE = 0, GONE = 8; }", "class View {static final int VISIBLE=0,GONE=8;}class ViewGroup {void removeView(Object view){}}class PlayerView {void setPlayer(ExoPlayer player){}Object getParent(){return null;}}")
  .replace("float alpha, scaleX;", "float alpha, scaleX;Surface animate(){return this;}void cancel(){}void setScaleY(float value){}")
  .replace("final Surface cover = new Surface(), galleryVideo = new Surface();", "final Surface playIndicator=new Surface(),cover = new Surface(), galleryVideo = new Surface();");
delete doubles["local/fanhao/library/NativeShortVideoPlaybackHarness.java"];
doubles["local/fanhao/library/NativeShortVideoAudioFocusHarness.java"] = `package local.fanhao.library;
import java.util.*;import android.content.Context;import androidx.media3.common.C;import androidx.media3.common.Player;import androidx.media3.exoplayer.ExoPlayer;
public final class NativeShortVideoAudioFocusHarness {
static int cases;static final List<String> failures=new ArrayList<>();static void require(boolean value,String why){if(!value)throw new AssertionError(why);}
static void check(String name,Runnable action){cases++;try{action.run();}catch(Throwable error){failures.add(name+": "+error.getMessage());}}
static ExoPlayer make(Context context,int kind){NativeShortVideoFocusProducers producers=new NativeShortVideoFocusProducers(context);return kind==0?producers.video():kind==1?producers.sound():producers.segment();}
static final class Fixture extends NativeShortVideoFeedPlaybackHost {Fixture(){ShortVideoItem item=new ShortVideoItem("video");videos.add(item);adapter.notifyDataSetChanged();currentIndex=-1;currentScreen=captureFeedScreen();startPlaybackAt(0);drain();activePlayer.playbackState=Player.STATE_READY;} }
public static void main(String[]args){
for(int kind=0;kind<2;kind++){final int type=kind;
check("production audible attributes "+type,()->{Context context=new Context();ExoPlayer p=make(context,type);require(p.focusEnabled&&p.noisyEnabled,"focus/noisy opt-in missing");require(p.attributes.usage==C.USAGE_MEDIA&&p.attributes.contentType==(type==0?C.AUDIO_CONTENT_TYPE_MOVIE:C.AUDIO_CONTENT_TYPE_MUSIC),"wrong media audio attributes");p.play();require(context.audio.requests==1&&p.getPlayWhenReady(),"actual SDK did not request focus");p.release();require(context.audio.listeners.isEmpty(),"focus listener leaked");});
check("focus refused "+type,()->{Context context=new Context();context.audio.requestResult=0;ExoPlayer p=make(context,type);p.play();require(context.audio.requests==1&&!p.getPlayWhenReady(),"focus refusal still played audio");p.release();});
check("transient loss then gain "+type,()->{Context context=new Context();ExoPlayer p=make(context,type);p.playbackState=Player.STATE_READY;p.play();context.audio.externalFocus(-2);require(p.getPlayWhenReady()&&!p.isPlaying()&&p.suppressed,"transient loss did not suppress existing intent");context.audio.externalFocus(1);require(p.getPlayWhenReady()&&p.isPlaying(),"focus gain lost current intent");p.release();});
check("user pause during transient loss "+type,()->{Context context=new Context();ExoPlayer p=make(context,type);p.playbackState=Player.STATE_READY;p.play();context.audio.externalFocus(-2);p.pause();context.audio.externalFocus(1);require(!p.getPlayWhenReady()&&!p.isPlaying(),"focus gain undid user pause");p.release();});
check("duck and gain "+type,()->{Context context=new Context();ExoPlayer p=make(context,type);p.play();context.audio.externalFocus(-3);require(p.focusMultiplier==0.2f&&p.getPlayWhenReady(),"temporary duck did not lower volume");context.audio.externalFocus(1);require(p.focusMultiplier==1f&&p.getPlayWhenReady(),"gain did not remove ducking");p.release();});
check("permanent loss "+type,()->{Context context=new Context();ExoPlayer p=make(context,type);p.play();context.audio.externalFocus(-1);require(!p.getPlayWhenReady()&&context.audio.listeners.isEmpty(),"permanent loss failed to stop/abandon");p.release();});
check("release abandons focus "+type,()->{Context context=new Context();ExoPlayer p=make(context,type);p.play();int commands=p.commands;p.release();require(context.audio.abandons==1&&context.audio.listeners.isEmpty(),"release did not abandon");context.audio.externalFocus(1);require(p.commands==commands,"released player received focus gain");});
}
check("muted segment never competes for focus",()->{Context context=new Context();ExoPlayer sound=make(context,1),segment=make(context,2);sound.play();segment.setVolume(0);segment.play();require(!segment.focusEnabled&&segment.noisyEnabled&&context.audio.requests==1&&context.audio.listeners.size()==1,"silent segment requested competing focus");segment.release();require(context.audio.listeners.size()==1,"silent segment abandoned soundtrack focus");sound.release();});
check("default disabled negative control",()->{Context context=new Context();ExoPlayer p=new ExoPlayer.Builder(context).setHandleAudioBecomingNoisy(true).build();p.play();context.audio.externalFocus(-2);require(context.audio.requests==0&&p.getPlayWhenReady()&&!p.suppressed,"default control cannot reproduce missing focus policy");p.release();});
check("normal video to gallery releases before requesting",()->{Fixture f=new Fixture();ExoPlayer old=f.activePlayer;ShortVideoItem gallery=new ShortVideoItem("gallery");gallery.galleryItems.add(new GalleryMedia(true));f.videos.add(gallery);f.adapter.notifyDataSetChanged();f.audio.events.clear();f.selectForTest(1);require(old.released,"old source was retained");require(f.audio.events.equals(List.of("abandon","request")),"focus handoff order "+f.audio.events);require(f.gallerySoundPlayer.focusEnabled&&!f.gallerySegmentPlayer.focusEnabled&&f.audio.listeners.size()==1,"gallery has competing owners");f.releaseAllPlayers();require(f.audio.listeners.isEmpty(),"handoff cleanup leaked focus");});
check("gallery to normal video releases before requesting",()->{Fixture f=new Fixture();ShortVideoItem gallery=new ShortVideoItem("gallery");gallery.galleryItems.add(new GalleryMedia(false));f.videos.add(gallery);f.adapter.notifyDataSetChanged();f.selectForTest(1);ExoPlayer old=f.gallerySoundPlayer;f.audio.events.clear();f.selectForTest(0);require(old.released&&f.audio.events.equals(List.of("abandon","request")),"reverse focus handoff order "+f.audio.events);f.releaseAllPlayers();require(f.audio.listeners.isEmpty(),"reverse cleanup leaked focus");});
check("suppressed indicator and tap agree on pause intent",()->{Fixture f=new Fixture();f.audio.externalFocus(-2);require(f.activePlayer.getPlayWhenReady()&&!f.activePlayer.isPlaying(),"control is not focus suppressed");f.syncPlayIndicator(0,f.activePlayer);require(f.attachedHolders.get(0).playIndicator.visibility==View.GONE,"focus suppression displayed a misleading play action");f.toggleActivePlayback();require(!f.activePlayer.getPlayWhenReady(),"tap failed to pause pending playback");f.audio.externalFocus(1);require(!f.activePlayer.getPlayWhenReady(),"gain undid user tap");f.syncPlayIndicator(0,f.activePlayer);require(f.attachedHolders.get(0).playIndicator.visibility==View.VISIBLE,"explicit pause lost play indicator");f.releaseAllPlayers();});
if(!failures.isEmpty())throw new AssertionError(String.join("\\n",failures));System.out.println("native-short-video-audio-focus: "+cases+" actual builder/Media3 focus/intent/handoff cases passed");}
}`;

const gradle = fs.readFileSync(path.join(root, "android-client/android/app/build.gradle"), "utf8");
const version = /androidx\.media3:media3-common:([^"\s]+)/.exec(gradle)?.[1] || /androidx\.media3:media3-exoplayer:([^"\s]+)/.exec(gradle)?.[1];
assert(version);
const cacheRoot = path.join(process.env.GRADLE_USER_HOME || path.join(os.homedir(), ".gradle"), "caches/modules-2/files-2.1");
function cachedFiles(base, suffix) {
  if (!fs.existsSync(base)) return [];
  return fs.readdirSync(base).flatMap(name => { const entry = path.join(base, name); return fs.statSync(entry).isDirectory() ? cachedFiles(entry, suffix) : name.endsWith(suffix) ? [entry] : []; });
}
const aar = process.env.FANHAO_TEST_MEDIA3_COMMON_AAR || cachedFiles(path.join(cacheRoot, "androidx.media3/media3-common", version), ".aar")[0];
const guavas = cachedFiles(path.join(cacheRoot, "com.google.guava/guava"), ".jar");
const guava = guavas.find(file => file.includes("-android")) || guavas[0];
assert(aar && guava, "cached Media3 common AAR/Guava required; normal APK build supplies them");
function zipEntry(archive, wanted) {
  const bytes = fs.readFileSync(archive), eocd = bytes.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06])); assert(eocd >= 0);
  let cursor = bytes.readUInt32LE(eocd + 16);
  for (let index = 0; index < bytes.readUInt16LE(eocd + 10); index++) {
    assert.equal(bytes.readUInt32LE(cursor), 0x02014b50);
    const compression = bytes.readUInt16LE(cursor + 10), size = bytes.readUInt32LE(cursor + 20), length = bytes.readUInt16LE(cursor + 28), local = bytes.readUInt32LE(cursor + 42);
    if (bytes.subarray(cursor + 46, cursor + 46 + length).toString("utf8") === wanted) {
      const begin = local + 30 + bytes.readUInt16LE(local + 26) + bytes.readUInt16LE(local + 28), data = bytes.subarray(begin, begin + size); assert(compression === 0 || compression === 8); return compression === 8 ? inflateRawSync(data) : data;
    }
    cursor += 46 + length + bytes.readUInt16LE(cursor + 30) + bytes.readUInt16LE(cursor + 32);
  }
  throw new Error(`missing ${wanted} in Media3`);
}
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "fanhao-native-audio-focus-"));
const javaHome = process.env.JAVA_HOME || "C:/Program Files/Android/openjdk/jdk-21.0.8";
const exe = name => fs.existsSync(path.join(javaHome, "bin", `${name}.exe`)) ? path.join(javaHome, "bin", `${name}.exe`) : name;
try {
  const jar = path.join(tempRoot, "media3-common.jar"); fs.writeFileSync(jar, zipEntry(aar, "classes.jar"));
  const sources = [];
  for (const [relative, source] of Object.entries(doubles)) { const target = path.join(tempRoot, relative); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, source); sources.push(target); }
  for (const name of ["NativeShortVideoPlaybackFallback.java", "NativeShortVideoScreenState.java", "NativeShortVideoFeedPlayback.java"]) sources.push(path.join(nativeRoot, name));
  const cp = [jar, guava].join(path.delimiter);
  const compiled = spawnSync(exe("javac"), ["-encoding", "UTF-8", "-cp", cp, "-d", tempRoot, ...sources], { encoding: "utf8", cwd: root });
  assert.equal(compiled.status, 0, `focus harness must compile:\n${compiled.stderr}`);
  const result = spawnSync(exe("java"), ["-cp", tempRoot + path.delimiter + cp, "local.fanhao.library.NativeShortVideoAudioFocusHarness"], { encoding: "utf8", cwd: root });
  assert.equal(result.status, 0, `focus harness must pass:\n${result.stderr}`); process.stdout.write(result.stdout);
} finally {
  const target = fs.realpathSync(tempRoot), parent = fs.realpathSync(os.tmpdir()); assert.equal(path.dirname(target), parent); assert(path.basename(target).startsWith("fanhao-native-audio-focus-"));
  fs.rmSync(target, { recursive: true, force: true });
}
