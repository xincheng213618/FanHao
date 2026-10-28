import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// Actual gallery timer/end callbacks, owned continuation, onResume/overlay
// restoration and loadMoreIfNeeded commit chain. Only UI, HTTP delivery, media
// and time leaves are controlled; no device, real media, service or DB is used.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const nativeRoot = path.join(root, "android-client/android/app/src/main/java/local/fanhao/library");
const interactionFile = new URL("./verify_native_short_video_interaction.mjs", import.meta.url);
const interaction = fs.readFileSync(interactionFile, "utf8").replace(/\r\n/g, "\n");
const start = interaction.indexOf("// Reuse the native playback"), end = interaction.indexOf('doubles["local/fanhao/library/NativeShortVideoInteractionHarness.java"] =');
assert(start >= 0 && end > start);
const environment = vm.createContext({ fs, path, assert, os, vm, spawnSync, fileURLToPath, process });
vm.runInContext(`${interaction.slice(start, end).replaceAll("import.meta.url", JSON.stringify(interactionFile.href))}\nglobalThis.fixture={doubles,activity};`, environment);
const { doubles, activity } = environment.fixture;
function member(name) {
  const found = new RegExp(`^  private [^\n]* ${name}\\([^\n]*` , "m").exec(activity); assert(found, name);
  return block(found.index).replace("private ", "");
}
function block(start) {
  let index = activity.indexOf("{", start) + 1, depth = 1;
  for (; index < activity.length && depth; index++) { if (activity[index] === "{") depth++; else if (activity[index] === "}") depth--; }
  return activity.slice(start, index);
}
const ownerStart = activity.indexOf("  private final class GalleryContinuation {"); assert(ownerStart >= 0);
const implementation = block(ownerStart).replace("private ", "") + "\n" + ["flushGalleryContinuation", "beginGalleryContinuation", "pauseGalleryContinuation", "cancelGalleryContinuation", "invalidateGalleryContinuation"].map(member).join("\n");
const feed = "local/fanhao/library/NativeShortVideoFeedPlaybackHost.java";
doubles[feed] = doubles[feed]
  .replace("class NativeShortVideoFeedPlaybackHost extends NativeShortVideoPlaybackHost {", `class NativeShortVideoFeedPlaybackHost extends NativeShortVideoPlaybackHost {
    GalleryContinuation galleryContinuation;${implementation}
    static final int FEED_PAGE_LIMIT=30;static final String PREF_AUTO_NEXT="autoNext";String status="";int readCount;
    NativeShortVideoFeedPaging.ReadResult<FeedPage> response;
    String pagedFeedUrl(String url,int offset,String cursor,int limit){return url+"?cursor="+cursor;}
    NativeShortVideoFeedPaging.ReadResult<FeedPage> readFeedPage(String url,ReadRequests.Token token){readCount++;return response;}
    void acceptServerActionSnapshots(List<ShortVideoItem> items,long revision){}void showTransientStatus(String message){status=message;}
    void writeControlPreference(String key,boolean value){}void refreshVisibleRails(){}
    final RootView rootView=new RootView();class RootView{void removeView(Object view){}}
    ${member("toggleAutoNext")}${member("applyPlaybackControlState")}
  `)
  .replace("final FeedPaging feedPaging = new FeedPaging();", "final NativeShortVideoFeedPaging feedPaging=new NativeShortVideoFeedPaging();")
  .replace("static class ActionSnapshots {", "static class ActionSnapshots {long revision(){return 0;}")
  .replace("void loadMoreIfNeeded(int index) {}", member("loadMoreIfNeeded"))
  .replace("void showStatus(String message) {}", "void showStatus(String message){status=message;}")
  .replace("void hideStatus() {}", "void hideStatus(){status=\"\";}")
  .replace("void dismissPlaybackToolbar() {}", member("dismissPlaybackToolbar"))
  .replace("static class ReadRequests { void cancel() {} }", `static class ReadRequests {static class Token{boolean active=true;boolean isCurrent(){return active;}}Token token;java.util.function.Consumer<Token> pending;
    void cancel(){if(token!=null)token.active=false;pending=null;}void replace(java.util.function.Consumer<Token> work){cancel();token=new Token();pending=work;}
    void reply(){java.util.function.Consumer<Token> work=pending;pending=null;if(work==null)throw new AssertionError("missing controlled HTTP read");work.accept(token);}}
  `)
  .replace("void notifyDataSetChanged() {", "void notifyItemRangeInserted(int index,int count){for(int i=index;i<index+count;i++)attachedHolders.put(i,new ShortVideoHolder(i));}void notifyDataSetChanged() {");
doubles["androidx/media3/exoplayer/ExoPlayer.java"] = doubles["androidx/media3/exoplayer/ExoPlayer.java"]
  .replace("public boolean playWhenReady", "public int repeatMode;public boolean playWhenReady")
  .replace("public void setRepeatMode(int value) {}", "public void setRepeatMode(int value){repeatMode=value;}");
doubles["local/fanhao/library/FeedPage.java"] = doubles["local/fanhao/library/FeedPage.java"].replace("int nextOffset() { return items.size(); }", "int offset;int nextOffset(){return offset;}");
doubles["local/fanhao/library/NativeGalleryContinuationHarness.java"] = `package local.fanhao.library;
import java.util.*;import android.os.SystemClock;import android.net.Uri;import androidx.media3.common.Player;import androidx.media3.common.MediaItem;import androidx.media3.exoplayer.ExoPlayer;
public final class NativeGalleryContinuationHarness {
static int cases;static final List<String> failures=new ArrayList<>();static void require(boolean condition,String why){if(!condition)throw new AssertionError(why);}
static void check(String name,Runnable test){cases++;try{test.run();}catch(Throwable error){failures.add(name+": "+error.getMessage());}}
static final class Fixture extends NativeShortVideoFeedPlaybackHost {
 final boolean video;final ShortVideoItem item;
 Fixture(boolean video,int count,boolean enabled,boolean next){SystemClock.now=0;this.video=video;autoNext=enabled;item=new ShortVideoItem("gallery");for(int i=0;i<count;i++)item.galleryItems.add(new GalleryMedia(video,"http://fixture/gallery/"+i));videos.add(item);if(next)videos.add(new ShortVideoItem("next"));adapter.notifyDataSetChanged();currentIndex=-1;currentScreen=captureFeedScreen();startPlaybackAt(0);drain();}
 ShortVideoHolder holder(){return attachedHolders.get(0);}void last(){bindGallery(holder(),item,item.galleryItems.size()-1,0);}
 void more(){hasMoreVideos=true;nextFeedCursor="start";feedPaging.replaceFeed(pendingFeedUrl,nextFeedCursor,true);}
 void finish(){if(video){gallerySegmentPlayer.bufferAfterEndedSeek=true;gallerySegmentPlayer.playbackState=Player.STATE_ENDED;gallerySegmentPlayer.playWhenReady=true;galleryStateChanged(gallerySegmentPlayer,Player.STATE_ENDED);drain();}else{Runnable timer=galleryAutoAdvanceRunnable;require(timer!=null,"missing image timer");SystemClock.now+=GALLERY_IMAGE_AUTO_ADVANCE_MS;timer.run();}}
 void page(String cursor,boolean more,boolean add){FeedPage page=new FeedPage();page.nextCursor=cursor;page.offset=nextFeedOffset+1;page.hasMore=more;if(add)page.items.add(new ShortVideoItem("loaded-next"));response=NativeShortVideoFeedPaging.ReadResult.success(page,more,cursor);feedRequests.reply();drain();}
 Runnable overlay(String name){if(name.equals("search")){Runnable close=pausePlaybackForFeedSearch();feedSearchController.overlay=new Object();return ()->{feedSearchController.overlay=null;close.run();};}if(name.equals("comments")){pauseForCommentsOverlay();comments=true;return ()->{comments=false;resumeAfterCommentsOverlay(true);};}playbackToolbarOverlay=new Object();return this::dismissPlaybackToolbar;}
}
public static void main(String[]args){
for(boolean video:new boolean[]{false,true})for(int count:new int[]{1,2})for(boolean enabled:new boolean[]{false,true})check("known next "+video+" "+count+" "+enabled,()->{
 Fixture f=new Fixture(video,count,enabled,true);f.last();if(video)require(f.gallerySegmentPlayer.repeatMode==(count==1&&!enabled?Player.REPEAT_MODE_ONE:Player.REPEAT_MODE_OFF),"single LivePhoto repeat disagrees with autoNext");
 if(!video&&count==1&&!enabled){require(f.galleryAutoAdvanceRunnable==null,"single image loop unexpectedly advances");return;}f.finish();require(f.pager.getCurrentItem()==(enabled?1:0),"last gallery entry ignored next-work policy");if(!enabled)require(f.holder().galleryIndex==0,"single-work mode failed to wrap gallery");
});
for(boolean video:new boolean[]{false,true})check("middle item stays within work "+video,()->{Fixture f=new Fixture(video,2,true,true);f.finish();require(f.pager.getCurrentItem()==0&&f.holder().galleryIndex==1,"middle item skipped remaining media");});
for(boolean video:new boolean[]{false,true})for(int count:new int[]{1,2})check("known boundary replays current work "+video+" "+count,()->{Fixture f=new Fixture(video,count,true,false);f.last();f.finish();require(f.pager.getCurrentItem()==0&&f.holder().galleryIndex==0,"known feed boundary navigated beyond list");if(video)require(f.gallerySegmentPlayer.position==0||count>1,"single LivePhoto failed to rewind at native feed boundary");if(count==1){int seeks=video?f.gallerySegmentPlayer.seeks:0;f.finish();if(video)require(f.gallerySegmentPlayer.seeks>seeks,"completed continuation blocked the next single-media replay cycle");else require(f.galleryAutoAdvanceRunnable!=null,"single image did not rearm after feed boundary");}});
for(boolean video:new boolean[]{false,true})check("paged next and duplicate completion "+video,()->{Fixture f=new Fixture(video,2,true,false);f.more();f.last();f.finish();require(f.loadingMoreVideos&&f.feedPaging.isPendingAutoAdvance(0),"gallery did not enter owned page continuation");f.advanceGallerySequence(0,1,video?"video":"image");require(f.readCount==0,"HTTP should remain controlled until reply");f.page("end",false,true);require(f.pager.getCurrentItem()==1&&f.videos.size()==2,"page reply failed to advance gallery");f.advanceGallerySequence(0,1,video?"video":"image");require(f.pager.getCurrentItem()==1,"duplicate gallery completion changed selected page");});
for(boolean video:new boolean[]{false,true})check("empty pages then explicit end "+video,()->{Fixture f=new Fixture(video,2,true,false);f.more();f.last();f.finish();f.page("empty-1",true,false);require(f.loadingMoreVideos&&f.pager.getCurrentItem()==0,"empty continuation dropped loading intent");f.page("empty-2",true,false);f.page("end",false,false);require(!f.loadingMoreVideos&&f.holder().galleryIndex==0&&f.pager.getCurrentItem()==0,"paged native boundary did not replay current work");});
for(boolean video:new boolean[]{false,true})for(String overlay:List.of("search","comments","toolbar","background"))check("page reply deferred under "+overlay+" "+video,()->{Fixture f=new Fixture(video,2,true,false);f.more();f.last();f.finish();Runnable close=null;if(overlay.equals("background"))f.onPause();else close=f.overlay(overlay);f.page("end",false,true);require(f.pager.getCurrentItem()==0,"page reply stole foreground during overlay/background");if(close!=null)close.run();else f.onResume();require(f.pager.getCurrentItem()==1,"owned completed gallery did not flush after visibility return");});
for(boolean video:new boolean[]{false,true})for(String changed:List.of("off","pager","media","holder","source","epoch","touch","zoom","pause"))check("retired page intent "+changed+" "+video,()->{
 Fixture f=new Fixture(video,2,true,false);f.more();f.last();f.finish();
 if(changed.equals("off"))f.toggleAutoNext();if(changed.equals("pager"))f.pager.setCurrentItem(2,true);if(changed.equals("media"))f.bindGallery(f.holder(),f.item,0,0);if(changed.equals("holder"))f.attachedHolders.put(0,new ShortVideoHolder(0));
 if(changed.equals("source")){f.item.galleryItems.set(1,new GalleryMedia(video,"http://fixture/replaced"));if(video)f.gallerySegmentPlayer.setMediaItem(MediaItem.fromUri(Uri.parse("http://fixture/replaced")));}
 if(changed.equals("epoch"))f.feedPlayback.interruptAudio();if(changed.equals("touch"))f.holder().touchActive=true;if(changed.equals("zoom"))f.holder().galleryZoomScale=2f;if(changed.equals("pause")&&video)f.gallerySegmentPlayer.pause();
 f.page("end",false,true);if(changed.equals("pause")&&!video){require(f.pager.getCurrentItem()==1,"independent soundtrack pause must not stop image timing");return;}
 require(f.pager.getCurrentItem()!=1,"retired gallery continuation stole selection");require(f.galleryContinuation==null||changed.equals("off"),"retired continuation remained pending");
 if(changed.equals("touch")||changed.equals("zoom")){f.holder().touchActive=false;f.holder().galleryZoomScale=1f;f.flushGalleryContinuation();require(f.pager.getCurrentItem()==0,"releasing interaction resurrected a cancelled intent");f.bindGallery(f.holder(),f.item,0,0);f.last();f.finish();require(f.pager.getCurrentItem()==1,"new explicit playback could not create its own continuation");}
});
check("turn on autoNext schedules single image",()->{Fixture f=new Fixture(false,1,false,true);require(f.galleryAutoAdvanceRunnable==null,"initial single image should stay");f.toggleAutoNext();f.finish();require(f.pager.getCurrentItem()==1,"enabling next failed to schedule single-image timing");});
check("old image timer rejects replacement media",()->{Fixture f=new Fixture(false,2,true,true);f.last();Runnable old=f.galleryAutoAdvanceRunnable;f.item.galleryItems.set(1,new GalleryMedia(false,"http://fixture/new-image"));old.run();require(f.pager.getCurrentItem()==0&&f.galleryContinuation==null,"old image timer advanced a replacement source");});
for(String changed:List.of("media","source"))check("queued video end rejects "+changed,()->{Fixture f=new Fixture(true,2,true,true);f.last();ExoPlayer player=f.gallerySegmentPlayer;player.playbackState=Player.STATE_ENDED;f.galleryStateChanged(player,Player.STATE_ENDED);if(changed.equals("media"))f.bindGallery(f.holder(),f.item,0,0);else player.setMediaItem(MediaItem.fromUri(Uri.parse("http://fixture/new-source")));f.drain();require(f.pager.getCurrentItem()==0&&f.galleryContinuation==null,"old ENDED callback advanced another media binding");});
for(boolean video:new boolean[]{false,true})check("failed page retires gallery waiting state "+video,()->{Fixture f=new Fixture(video,2,true,false);f.more();f.last();f.finish();f.response=NativeShortVideoFeedPaging.ReadResult.failure(NativeShortVideoFeedPaging.Failure.TIMEOUT);f.feedRequests.reply();f.drain();require(f.galleryContinuation==null&&!f.loadingMoreVideos&&f.pager.getCurrentItem()==0&&!f.status.equals("正在加载下一条"),"page failure left an immortal waiting continuation");});
if(!failures.isEmpty())throw new AssertionError(String.join("\\n",failures));System.out.println("native-gallery-continuation: "+cases+" actual image/video/single-media/pagination/owner cases passed");}
}`;
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "fanhao-native-gallery-continuation-"));
const javaHome = process.env.JAVA_HOME || "C:/Program Files/Android/openjdk/jdk-21.0.8";
const exe = name => fs.existsSync(path.join(javaHome, "bin", `${name}.exe`)) ? path.join(javaHome, "bin", `${name}.exe`) : name;
function run(label, host = doubles[feed]) {
  const folder = path.join(temporary, label); fs.mkdirSync(folder, { recursive: true }); const files=[];
  for(const [relative,text] of Object.entries({...doubles,[feed]:host})){const target=path.join(folder,relative);fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,text);files.push(target);}
  for(const name of ["NativeShortVideoPlaybackFallback.java","NativeShortVideoFeedPlayback.java","NativeShortVideoScreenState.java","NativeShortVideoSeekSession.java","NativeShortVideoFeedPaging.java","NativeShortVideoFeedAutoAdvance.java"])files.push(path.join(nativeRoot,name));
  const compiled=spawnSync(exe("javac"),["-encoding","UTF-8","-d",folder,...files],{encoding:"utf8",timeout:20000});assert.equal(compiled.status,0,compiled.stderr);
  return spawnSync(exe("java"),["-cp",folder,"local.fanhao.library.NativeGalleryContinuationHarness"],{encoding:"utf8",timeout:20000});
}
try{
 const result=run("current");assert.equal(result.status,0,result.stderr);process.stdout.write(result.stdout);
 const ignoredNext=doubles[feed].replace("if (autoNext && mediaIndex == item.galleryItems.size() - 1)","if (false && autoNext && mediaIndex == item.galleryItems.size() - 1)");assert.notEqual(ignoredNext,doubles[feed]);const negative=run("old-modulo",ignoredNext);assert.notEqual(negative.status,0);assert.match(negative.stderr,/ignored next-work policy|owned page continuation/);console.log("native-gallery-continuation: old unconditional gallery loop negative control rejected");
}finally{const target=fs.realpathSync(temporary),parent=fs.realpathSync(os.tmpdir());assert.equal(path.dirname(target),parent);assert(path.basename(target).startsWith("fanhao-native-gallery-continuation-"));fs.rmSync(target,{recursive:true,force:true});}
