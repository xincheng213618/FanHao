import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { inflateRawSync } from "node:zlib";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// Reuse Android/player leaves; execute the real Activity overlay/navigation/
// lifecycle methods and FeedPlayback. The installed Media3 noisy class is only
// needed by the shared Activity adapter. No device, media or service is used.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const audioFile = new URL("./verify_native_short_video_audio.mjs", import.meta.url);
const audio = fs.readFileSync(audioFile, "utf8").replace(/\r\n/g, "\n");
const begin = audio.indexOf("const root = "), end = audio.indexOf('doubles["local/fanhao/library/NativeShortVideoAudioHarness.java"] =');
assert(begin >= 0 && end > begin);
const environment = vm.createContext({ assert, fs, os, path, vm, spawnSync, fileURLToPath, process, URL });
const bootstrap = audio.slice(begin, end)
  .replaceAll("fileURLToPath(import.meta.url)", `fileURLToPath(${JSON.stringify(audioFile.href)})`)
  .replaceAll(", import.meta.url)", `, ${JSON.stringify(audioFile.href)})`);
vm.runInContext(`${bootstrap}\nglobalThis.fixture={doubles,nativeRoot};`, environment);
const { doubles, nativeRoot } = environment.fixture;
const dependencyBegin = audio.indexOf("const gradle = "), dependencyEnd = audio.indexOf("const tempRoot = ");
assert(dependencyBegin > end && dependencyEnd > dependencyBegin);
const dependencies = vm.createContext({ assert, fs, os, path, process, root, inflateRawSync, Buffer });
vm.runInContext(`${audio.slice(dependencyBegin, dependencyEnd)}\nglobalThis.dependencies={aar,zipEntry};`, dependencies);
const { aar, zipEntry } = dependencies.dependencies;
const activity = fs.readFileSync(path.join(nativeRoot, "NativeShortVideoActivity.java"), "utf8").replace(/\r\n/g, "\n");
const activityMethod = name => {const value=activity.match(new RegExp(`  private [^\\n]+ ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n  \\}`))?.[0];assert(value,name);return value.replace("private ", "");};
// Execute the actual cache-hit/single-player reuse prefix; Android player
// creation remains the existing leaf for each fixture's initial player only.
const prepare = activityMethod("preparePlayerAt"), builderAt = prepare.indexOf("    ExoPlayer.Builder playerBuilder =");assert(builderAt>0);
const reuse = prepare.slice(0,builderAt).replace("ExoPlayer preparePlayerAt(","ExoPlayer prepareReusedPlayerAt(")+`throw new AssertionError("expected the actual reused-player branch");\n  }`;
const feedPath = "local/fanhao/library/NativeShortVideoFeedPlaybackHost.java";
// Match Media3's one-argument source replacement starting at position zero.
doubles["androidx/media3/exoplayer/ExoPlayer.java"]=doubles["androidx/media3/exoplayer/ExoPlayer.java"].replace("public void setMediaItem(MediaItem value) { touch(); media = value; }","public void setMediaItem(MediaItem value) { touch(); media = value; position=0; }");
doubles[feedPath]=doubles[feedPath].replace("void ensurePlayerViewAt(int index) {}", "PlayerView ensurePlayerViewAt(int index){return playerViews.computeIfAbsent(index,key->new PlayerView());}")
 .replace(/      void stopGallerySegmentPlayback\([^)]*\) \{[\s\S]*?\n      \}/,activityMethod("stopGallerySegmentPlayback").replace("@Nullable ",""))
 .replace("else {completeGalleryImageForTest(holder,item,galleryIndex);if(holder.index==currentIndex)scheduleGalleryAutoAdvance(holder,item,galleryIndex);}",`else {
          if (currentGallery && (gallerySegmentFeedIndex == holder.index || gallerySegmentView == holder.galleryVideo)) stopGallerySegmentPlayback(holder, false);
          holder.galleryVideo.setVisibility(View.GONE);
          completeGalleryImageForTest(holder,item,galleryIndex);
          if(holder.index==currentIndex)scheduleGalleryAutoAdvance(holder,item,galleryIndex);
        }`)
 .replace("\n    }\n    class View", `
   final Map<Integer,PlayerView> playerViews=new HashMap<>();
   ${reuse}
   ${activityMethod("setPlayerMedia")}
    }
    class PlayerView extends Surface {Object getParent(){return null;}}
    class ViewGroup {void removeView(Object view){}}
    class View`);
doubles["local/fanhao/library/NativeShortVideoOverlayHarness.java"] = `package local.fanhao.library;
import java.util.*;import androidx.media3.common.MediaItem;import androidx.media3.common.Player;import androidx.media3.common.PlaybackException;import androidx.media3.exoplayer.ExoPlayer;import android.net.Uri;
public final class NativeShortVideoOverlayHarness {
static int cases;static final List<String> failures=new ArrayList<>();static void require(boolean condition,String why){if(!condition)throw new AssertionError(why);}
static void check(String name,Runnable test){cases++;try{test.run();}catch(Throwable error){failures.add(name+": "+error.getMessage());}}
static final class Fixture extends NativeShortVideoFeedPlaybackHost {
  final int kind;
  ExoPlayer preparePlayerAt(int index){return reuseActivePlayer?prepareReusedPlayerAt(index):super.preparePlayerAt(index);}
  Fixture(int kind){this.kind=kind;ShortVideoItem item=new ShortVideoItem("current");if(kind!=0)item.galleryItems.add(new GalleryMedia(kind==1));videos.add(item);adapter.notifyDataSetChanged();currentIndex=-1;currentScreen=captureFeedScreen();startPlaybackAt(0);drain();}
  ExoPlayer player(){return kind==0?activePlayer:kind==1?gallerySegmentPlayer:gallerySoundPlayer;}
  Runnable open(String overlay){if(overlay.equals("search")){Runnable close=pausePlaybackForFeedSearch();feedSearchController.overlay=new Object();return ()->{feedSearchController.overlay=null;close.run();};}pauseForCommentsOverlay();comments=true;return ()->{comments=false;resumeAfterCommentsOverlay(true);};}
  void setPlayer(ExoPlayer player){if(kind==0)activePlayer=player;else if(kind==1){gallerySegmentPlayer=player;activePlayer=player;}else gallerySoundPlayer=player;}
}
public static void main(String[]args){
for(String overlay:List.of("search","comments"))for(int kind=0;kind<3;kind++)for(int state:new int[]{Player.STATE_READY,Player.STATE_BUFFERING})for(boolean requested:new boolean[]{false,true}){final int type=kind;check("two lifecycle rounds "+overlay+" "+kind+" "+state+" "+requested,()->{
  Fixture f=new Fixture(type);ExoPlayer player=f.player();player.playbackState=state;player.setPlayWhenReady(requested);player.position=20000;Runnable close=f.open(overlay);
  f.onPause();f.onResume();f.drain();require(!player.getPlayWhenReady(),"open overlay resumed playback");player.seekTo(25000);int seeks=player.seeks;close.run();
  require(player.getPlayWhenReady()==requested,"closing overlay lost captured intent");require(player.position==25000&&player.seeks==seeks,"overlay restored an obsolete position");
  if(type==2)require(!f.feedPlayback.awaitingSound(player,f.videos.get(0).id),"overlay retained pending sound restore");
  for(int round=0;round<2;round++){f.onPause();f.onResume();f.drain();require(player.getPlayWhenReady()==requested,"second foreground lost captured overlay intent");require(player.position==25000,"later lifecycle rewound media");}
});}
for(String overlay:List.of("search","comments"))for(int kind=0;kind<3;kind++){final int type=kind;check("author snapshot then overlay "+overlay+" "+kind,()->{
  Fixture f=new Fixture(type);f.player().position=12345;f.showAuthorPanel(f.videos.get(0));f.navigateBack();f.drain();ExoPlayer player=f.player();Runnable close=f.open(overlay);f.onPause();f.onResume();f.drain();player.seekTo(18000);close.run();
  require(player.getPlayWhenReady()&&player.position==18000,"snapshot overlay restore lost current position/intent");f.onPause();f.onResume();require(player.getPlayWhenReady()&&player.position==18000,"snapshot pending restore survived overlay consumption");
});}
for(String overlay:List.of("search","comments"))for(int kind=0;kind<3;kind++)for(String changed:List.of("source","player","item","holder","epoch","background","destroyed","author","other-overlay")){final int type=kind;check("reject retired overlay "+overlay+" "+kind+" "+changed,()->{
  Fixture f=new Fixture(type);ExoPlayer player=f.player();player.playbackState=Player.STATE_READY;Runnable close=f.open(overlay);ExoPlayer replacement=null;
  if(changed.equals("source")){if(type==0)f.playbackFallback.mediaUri(player,f.videos.get(0));player.setMediaItem(MediaItem.fromUri(Uri.parse("http://fixture/new-source")));}
  if(changed.equals("player")){replacement=new ExoPlayer();f.setPlayer(replacement);}
  if(changed.equals("item"))f.videos.set(0,new ShortVideoItem("replacement-item"));
  if(changed.equals("holder"))f.attachedHolders.put(0,new ShortVideoHolder(0));
  if(changed.equals("epoch"))f.feedPlayback.interruptAudio();
  if(changed.equals("background"))f.onPause();
  if(changed.equals("destroyed"))f.destroying=true;
  if(changed.equals("author"))f.authorOverlay=new Object();
  if(changed.equals("other-overlay")){if(overlay.equals("search"))f.comments=true;else f.feedSearchController.overlay=new Object();}
  close.run();require(!player.getPlayWhenReady(),"retired owner resumed playback");if(replacement!=null)require(!replacement.getPlayWhenReady(),"old intent affected replacement player");
});}
for(String overlay:List.of("search","comments"))check("same work compatible rendition keeps overlay intent "+overlay,()->{
  Fixture f=new Fixture(0);ExoPlayer player=f.player();ShortVideoItem item=f.videos.get(0);Object owner=f.playbackFallback.bindingOwner(player);Runnable close=f.open(overlay);
  require(f.playbackFallback.handle(player,item,new PlaybackException(),()->false),"fixture did not enter compatible rendition");
  require(owner==f.playbackFallback.bindingOwner(player),"internal rendition changed logical source owner");close.run();require(player.getPlayWhenReady(),"legitimate compatible rendition lost overlay intent");
});
for(String overlay:List.of("search","comments"))check("new explicit pause after overlay remains paused "+overlay,()->{
  Fixture f=new Fixture(2);Runnable close=f.open(overlay);f.onPause();f.onResume();close.run();f.player().pause();f.onPause();f.onResume();require(!f.player().getPlayWhenReady(),"consumed overlay restore overrode newer explicit pause");
});
for(String overlay:List.of("search","comments"))for(boolean paused:new boolean[]{false,true})check("fresh reused works do not inherit overlay pause "+overlay+" "+paused,()->{
  Fixture f=new Fixture(0);ExoPlayer player=f.activePlayer;player.playbackState=Player.STATE_READY;if(paused)f.toggleActivePlayback();
  require(player.getPlayWhenReady()!=paused,"real initial stage toggle did not establish the requested intent");Runnable close=f.open(overlay);close.run();f.reuseActivePlayer=true;
  f.selectForTest(0);require(player.getPlayWhenReady()!=paused,"same-work repeat binding lost the overlay pause/play intent");
  for(String id:List.of("B","C","D"))f.videos.add(new ShortVideoItem(id));f.adapter.notifyDataSetChanged();
  for(int index=1;index<=3;index++){f.selectForTest(index);f.drain();require(f.activePlayer==player&&f.playerCache.get(index)==player,"fixture did not reuse the same native player");require(player.getPlayWhenReady(),"previous work's overlay pause infected fresh work "+index);}
});
for(String overlay:List.of("search","comments"))for(boolean viaImage:new boolean[]{false,true})for(boolean soundRequested:new boolean[]{false,true})check("new gallery media owns video intent "+overlay+" "+viaImage+" "+soundRequested,()->{
  Fixture f=new Fixture(1);ShortVideoItem item=f.videos.get(0);item.galleryItems.add(new GalleryMedia(!viaImage,"http://fixture/second"));if(viaImage)item.galleryItems.add(new GalleryMedia(true,"http://fixture/third"));
  ExoPlayer player=f.gallerySegmentPlayer,sound=f.gallerySoundPlayer;player.seekTo(12345);player.pause();sound.seekTo(7654);sound.setPlayWhenReady(soundRequested);Runnable close=f.open(overlay);close.run();
  require(!player.getPlayWhenReady(),"overlay did not retain the old segment's explicit pause");
  f.bindGallery(f.attachedHolders.get(0),item,1,1);if(viaImage)f.bindGallery(f.attachedHolders.get(0),item,2,1);
  require(f.gallerySegmentPlayer==player&&player.getPlayWhenReady(),"new gallery media inherited the previous entry's overlay pause");
  require(sound.getPlayWhenReady()==soundRequested&&sound.position==7654,"video entry change altered independent soundtrack intent/position");
});
for(String overlay:List.of("search","comments"))check("same gallery media retains paused overlay intent "+overlay,()->{
  Fixture f=new Fixture(1);ExoPlayer player=f.gallerySegmentPlayer,sound=f.gallerySoundPlayer;player.seekTo(12345);player.pause();sound.pause();Runnable close=f.open(overlay);close.run();
  f.bindGallery(f.attachedHolders.get(0),f.videos.get(0),0,0);f.selectForTest(0);f.onPause();f.onResume();f.drain();
  require(!player.getPlayWhenReady()&&player.position==12345&&!sound.getPlayWhenReady(),"same-media rebind discarded a legitimate overlay pause");
});
for(boolean requested:new boolean[]{false,true})check("author snapshot retains selected gallery media "+requested,()->{
  NativeShortVideoFeedPlayback intent=new NativeShortVideoFeedPlayback();ExoPlayer old=new ExoPlayer(),sound=new ExoPlayer();old.seekTo(12345);old.setPlayWhenReady(requested);sound.seekTo(7654);sound.pause();
  intent.select("A");intent.selectGalleryMedia("A",1);NativeShortVideoFeedPlayback.Snapshot snapshot=intent.captureCurrent("A",1,old,sound);intent.selectGalleryMedia("A",2);intent.restore(snapshot);intent.select("A");intent.selectGalleryMedia("A",1);
  ExoPlayer restored=new ExoPlayer(),restoredSound=new ExoPlayer();intent.start(restored,false,"A",true);intent.start(restoredSound,true,"A",true);
  require(restored.getPlayWhenReady()==requested&&restored.position==12345&&!restoredSound.getPlayWhenReady()&&restoredSound.position==7654,"gallery selection tracking consumed the author snapshot's current media restore");
});
check("noisy same gallery media does not regain old playback",()->{
  Fixture f=new Fixture(1);Runnable close=f.open("search");close.run();f.feedPlayback.interruptAudio();f.gallerySegmentPlayer.pause();f.gallerySoundPlayer.pause();
  f.bindGallery(f.attachedHolders.get(0),f.videos.get(0),0,0);f.selectForTest(0);f.onPause();f.onResume();f.drain();
  require(!f.gallerySegmentPlayer.getPlayWhenReady()&&!f.gallerySoundPlayer.getPlayWhenReady()&&!f.feedPlayback.allowsAutomaticAdvance(),"same-media selection revived an interrupted playback intent");
});
for(String overlay:List.of("search","comments"))for(boolean changed:new boolean[]{false,true})for(boolean requested:new boolean[]{false,true})check("gallery source ownership "+overlay+" "+changed+" "+requested,()->{
  Fixture f=new Fixture(1);ExoPlayer player=f.gallerySegmentPlayer,sound=f.gallerySoundPlayer;player.seekTo(12345);player.setPlayWhenReady(requested);sound.seekTo(7654);sound.pause();Runnable close=f.open(overlay);close.run();int prepares=player.prepares;String url=f.videos.get(0).galleryItems.get(0).url;
  f.videos.get(0).galleryItems.set(0,new GalleryMedia(true,changed?"http://fixture/new-source":url));f.bindGallery(f.attachedHolders.get(0),f.videos.get(0),0,0);
  require(player.getPlayWhenReady()==(changed||requested),"gallery source change retained a departed overlay pause");
  require(!sound.getPlayWhenReady()&&sound.position==7654,"gallery source change altered independent soundtrack intent/position");
  require(changed?player.prepares==prepares+1&&player.position==0:player.prepares==prepares&&player.position==12345,"stable URL replacement lost pause/position or new source failed to start from zero");
});
for(boolean changed:new boolean[]{false,true})for(boolean requested:new boolean[]{false,true})check("author snapshot gallery source ownership "+changed+" "+requested,()->{
  Fixture f=new Fixture(1);ShortVideoItem seed=f.videos.get(0);String url=seed.galleryItems.get(0).url;f.gallerySegmentPlayer.seekTo(12345);f.gallerySegmentPlayer.setPlayWhenReady(requested);f.gallerySoundPlayer.seekTo(7654);f.gallerySoundPlayer.setPlayWhenReady(!requested);
  f.showAuthorPanel(seed);seed.galleryItems.set(0,new GalleryMedia(true,changed?"http://fixture/author-replaced-source":url));f.navigateBack();f.drain();
  require(f.gallerySegmentPlayer.getPlayWhenReady()==(changed||requested)&&f.gallerySegmentPlayer.position==(changed?0:12345),"author snapshot applied a departed source's pause/position or lost the unchanged source");
  require(f.gallerySoundPlayer.getPlayWhenReady()==!requested&&f.gallerySoundPlayer.position==7654,"author source replacement lost independent soundtrack restore");
});
for(String overlay:List.of("search","comments"))check("same-index image/video type changes own separate video intent "+overlay,()->{
  Fixture f=new Fixture(1);ShortVideoItem item=f.videos.get(0);String url=item.galleryItems.get(0).url;f.gallerySegmentPlayer.pause();f.gallerySoundPlayer.pause();Runnable close=f.open(overlay);close.run();
  item.galleryItems.set(0,new GalleryMedia(false,url));f.bindGallery(f.attachedHolders.get(0),item,0,0);require(f.activePlayer==null,"image did not retire video stage ownership");
  item.galleryItems.set(0,new GalleryMedia(true,url));f.bindGallery(f.attachedHolders.get(0),item,0,0);require(f.gallerySegmentPlayer.getPlayWhenReady()&&!f.gallerySoundPlayer.getPlayWhenReady(),"same URL changed media type inherited a retired video pause or resumed sound");
});
check("unknown legacy snapshot source retains its initial media restore",()->{
  NativeShortVideoFeedPlayback intent=new NativeShortVideoFeedPlayback();ExoPlayer old=new ExoPlayer();old.seekTo(12345);old.pause();intent.restore(NativeShortVideoFeedPlayback.capture("A",0,old,null));intent.select("A");intent.selectGalleryMedia("A",0,"video:http://fixture/known-now");ExoPlayer current=new ExoPlayer();intent.start(current,false,"A",true);
  require(!current.getPlayWhenReady()&&current.position==12345,"first known gallery source discarded an unknown legacy snapshot's exact media restore");
});
if(!failures.isEmpty())throw new AssertionError(String.join("\\n",failures));System.out.println("native-short-video-overlay-playback: "+cases+" actual overlay/lifecycle/source/snapshot intent cases passed");}
}`;
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "fanhao-native-overlay-playback-"));
const javaHome = process.env.JAVA_HOME || "C:/Program Files/Android/openjdk/jdk-21.0.8";
const exe = name => fs.existsSync(path.join(javaHome, "bin", `${name}.exe`)) ? path.join(javaHome, "bin", `${name}.exe`) : name;
const playback = fs.readFileSync(path.join(nativeRoot, "NativeShortVideoFeedPlayback.java"), "utf8").replace(/\r\n/g, "\n");
function run(label, implementation = playback) {
  const folder = path.join(temporary, label); fs.mkdirSync(folder, { recursive: true });
  const jar = path.join(folder, "media3-common.jar"); fs.writeFileSync(jar, zipEntry(aar, "classes.jar"));
  const sources = [];
  for (const [relative, source] of Object.entries(doubles)) { const file = path.join(folder, relative); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, source); sources.push(file); }
  const owner = path.join(folder, "NativeShortVideoFeedPlayback.java"); fs.writeFileSync(owner, implementation); sources.push(owner);
  for (const name of ["NativeShortVideoPlaybackFallback.java", "NativeShortVideoScreenState.java", "NativeShortVideoSeekSession.java"]) sources.push(path.join(nativeRoot, name));
  const compiled = spawnSync(exe("javac"), ["-encoding", "UTF-8", "-cp", jar, "-d", folder, ...sources], { encoding: "utf8", timeout: 20000 });
  assert.equal(compiled.status, 0, `overlay fixture must compile:\n${compiled.stderr}`);
  return spawnSync(exe("java"), ["-cp", folder + path.delimiter + jar, "local.fanhao.library.NativeShortVideoOverlayHarness"], { encoding: "utf8", timeout: 20000 });
}
try {
  const result = run("current"); assert.equal(result.status, 0, `overlay fixture must pass:\n${result.stderr}`); process.stdout.write(result.stdout);
  const staleRestore = playback.replace("    Restore current = new Restore(new Track(Math.max(0L, player.getCurrentPosition()), requested));\n    current.player = player;\n    current.awaitingForeground = false;\n    if (soundtrack) { sound = current; lifecycleSoundItemId = itemId; }\n    else video = current;\n", "");
  assert.notEqual(staleRestore, playback, "pending restore negative control must mutate the real method");
  const negative = run("retained-pending", staleRestore); assert.notEqual(negative.status, 0); assert.match(negative.stderr, /retained pending sound restore|second foreground|snapshot pending restore/);
  const leakedVideo = playback.replace("if (!repeated && snapshot == null) { video = null; sound = null; lifecycleSoundItemId = null; }", "if (!repeated && snapshot == null) { sound = null; lifecycleSoundItemId = null; }");
  assert.notEqual(leakedVideo,playback,"fresh work must clear the old video restore");const leaked=run("retained-video-owner",leakedVideo);assert.equal(leaked.status,1);assert.match(leaked.stderr,/previous work's overlay pause infected fresh work/);
  const leakedGallery=playback.replace("changedIndex || changedSource","snapshot != null && snapshot.itemId.equals(itemId) && snapshot.mediaIndex != mediaIndex");
  assert.notEqual(leakedGallery,playback,"gallery entry selection must release the departed video restore");const gallery=run("retained-gallery-video-owner",leakedGallery);assert.equal(gallery.status,1);assert.match(gallery.stderr,/new gallery media inherited the previous entry's overlay pause/);
  const eagerGallery=playback.replace("if (changedIndex || changedSource) video = null;","video = null;");
  assert.notEqual(eagerGallery,playback,"same gallery entry must retain its restore");const eager=run("discarded-same-gallery-restore",eagerGallery);assert.equal(eager.status,1);assert.match(eager.stderr,/same-media rebind discarded|author snapshot's current media restore|second foreground|snapshot pending restore/);
  const leakedSource=playback.replace("if (changedIndex || changedSource) video = null;","if (changedIndex) video = null;");assert.notEqual(leakedSource,playback);const source=run("retained-gallery-source-owner",leakedSource);assert.equal(source.status,1);assert.match(source.stderr,/gallery source change retained a departed overlay pause|author snapshot applied a departed source/);
  const unversionedSnapshot=playback.replace("selectedGallerySourceKey = snapshot == null ? null : snapshot.gallerySourceKey;","selectedGallerySourceKey = null;");assert.notEqual(unversionedSnapshot,playback);const snapshot=run("unversioned-gallery-snapshot",unversionedSnapshot);assert.equal(snapshot.status,1);assert.match(snapshot.stderr,/author snapshot applied a departed source/);
  const typedHost=doubles[feedPath];const untypedHost=typedHost.replace('(targetMedia.isVideo() ? "video:" : "image:") + targetMedia.url','targetMedia.url');assert.notEqual(untypedHost,typedHost,"Activity must pass the selected media type as part of stable source ownership");
  try{doubles[feedPath]=untypedHost;const untyped=run("gallery-source-without-type");assert.equal(untyped.status,1);assert.match(untyped.stderr,/same URL changed media type inherited/);}finally{doubles[feedPath]=typedHost;}
  console.log("native-short-video-overlay-playback: seven pending/work/media/source/type/snapshot/unconditional-clear compiled negative controls rejected");
} finally {
  const target = fs.realpathSync(temporary), parent = fs.realpathSync(os.tmpdir()); assert.equal(path.dirname(target), parent); assert(path.basename(target).startsWith("fanhao-native-overlay-playback-")); fs.rmSync(target, { recursive: true, force: true });
}
