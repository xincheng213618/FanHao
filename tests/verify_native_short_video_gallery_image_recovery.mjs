import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { buildGalleryOwnershipDoubles } from "./fixtures/native-gallery-ownership-harness.mjs";

// Real Activity image binding, requestFrame, owned tap, status and lifecycle
// helpers with the real bounded loader. Only Android leaves, decoder outcomes
// and time are controlled. No image, service, database, device or APK is used.
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),".."),native=path.join(root,"android-client/android/app/src/main/java/local/fanhao/library");
const activity=fs.readFileSync(path.join(native,"NativeShortVideoActivity.java"),"utf8").replace(/\r\n/g,"\n");
function member(name){const value=activity.match(new RegExp(`  private [^\\n]+ ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n  \\}`))?.[0];assert(value,name);return value.replace("private ","");}
function methodEnd(source,start){let depth=0,quoted="",escape=false;for(let i=source.indexOf("{",start);i<source.length;i++){const c=source[i];if(quoted){if(escape)escape=false;else if(c==="\\")escape=true;else if(c===quoted)quoted="";continue;}if(c==='"'||c==="'"){quoted=c;continue;}if(c==="{")depth++;if(c==="}"&&!--depth)return i+1;}throw Error("unclosed Java method");}
function replaceMethod(source,name,value){const match=source.match(new RegExp(`(?:public static |static |final |private |public )*(?:void|boolean|Bitmap) ${name}\\([^)]*\\)\\s*\\{`));assert(match,name);return source.slice(0,match.index)+value+source.slice(methodEnd(source,match.index));}
const readinessFile=path.join(root,"tests/verify_native_short_video_gallery_readiness.mjs"),template=fs.readFileSync(readinessFile,"utf8");
const prefix=template.slice(template.indexOf("const root="),template.indexOf("const temporary=")).replaceAll("import.meta.url",JSON.stringify(pathToFileURL(readinessFile).href));
const {doubles,java:base}=vm.runInNewContext(prefix+"\n({doubles,java})",{assert,fs,path,os,vm,spawnSync,fileURLToPath,buildGalleryOwnershipDoubles,process});
const host="local/fanhao/library/SurfaceCoverProbe.java";
doubles["local/fanhao/library/ShortVideoItem.java"]=doubles["local/fanhao/library/ShortVideoItem.java"].replace("class ShortVideoItem {","class ShortVideoItem {String coverUrl=\"\";");
let java=replaceMethod(base,"main","");
java=java.replace("final Map<String,Bitmap> frameCache=new HashMap<>();","final Map<String,Bitmap> frameCache=new java.util.concurrent.ConcurrentHashMap<>();")
 .replace("final FrameReadBoundary frameLoading=new FrameReadBoundary();class FrameReadBoundary{boolean contains(String key){return replies.containsKey(key);}}", "final NativeShortVideoFrameLoader<Bitmap> frameLoading=new NativeShortVideoFrameLoader<>();")
 .replace("void showStatus(String value){statusGeneration++;status=value;}",member("showStatus")+member("showTransientStatus"))
 .replace("void hideStatus(){}",member("hideStatus"))
 .replace("void clearPendingStageTap(){}",member("clearPendingStageTap"))
 .replace("void refreshFrameLoadingWindow(){}",member("refreshFrameLoadingWindow"))
 .replace("void requestFrame(String key,Callable<Bitmap> read,Consumer<Bitmap> paint){requestFrame(key,read,paint,null);}","")
 .replace("void requestFrame(String key,Callable<Bitmap> read,Consumer<Bitmap> paint,Runnable failed){reads++;replies.put(key,paint);failures.put(key,failed);}", [...activity.matchAll(/  private void requestFrame\([^)]*\) \{[\s\S]*?\n  \}/g)].map(m=>m[0].replace("private ","")).join("\n"))
 .replace("Bitmap loadBitmap(String url,int width,int height){return new Bitmap();}",`Bitmap loadBitmap(String url,int width,int height){reads++;ImageRead next=planned.poll();if(next==null)throw new AssertionError("unscripted decode "+url);next.entered.countDown();try{if(!next.release.await(4,java.util.concurrent.TimeUnit.SECONDS))throw new AssertionError("decoder gate timeout");}catch(InterruptedException e){throw new AssertionError(e);}if(next.throwing)throw new IllegalStateException("controlled decode failure");return next.value;}`)
 .replace("class ShortVideoHolder {", "class ShortVideoHolder {float lastTapX,lastTapY;")
 .replace("public class SurfaceCoverProbe {",`public class SurfaceCoverProbe {
   static class TextView extends View{String text="";TextView(){visibility=View.GONE;}void setText(String value){text=value;}}
   final TextView statusView=new TextView();
   static final class ImageRead {final Bitmap value;final boolean throwing;final java.util.concurrent.CountDownLatch entered=new java.util.concurrent.CountDownLatch(1),release=new java.util.concurrent.CountDownLatch(1);ImageRead(Bitmap value,boolean throwing,boolean held){this.value=value;this.throwing=throwing;if(!held)release.countDown();}}
   final java.util.concurrent.BlockingQueue<ImageRead> planned=new java.util.concurrent.LinkedBlockingQueue<>();
   final List<ImageRead> allReads=new ArrayList<>();static final List<SurfaceCoverProbe> fixtures=new ArrayList<>();
   volatile FrameLoadingWindow frameLoadingWindow=new FrameLoadingWindow(Collections.emptySet(),"");
   ${activity.match(/  private static final class FrameLoadingWindow \{[\s\S]*?\n  \}/)[0].replace("private ","")}
   ${member("normalVideoFrameKey")}${member("pauseFrameLoading")}${member("resumeFrameLoading")}${member("retryGalleryImagePlayback")}
   ${activity.match(/  private final class StageGestureOwner \{[\s\S]*?\n  \}/)[0].replace("private ","")}
   ${["stageGestureVisible","captureStageGestureOwner","ownsStageGesture","handleStageTap","handleOwnedStageTap"].map(member).join("\n")}
   ${["pausePlaybackForFeedSearch","overlayPlaybackSourceOwner","pauseForCommentsOverlay","resumeAfterCommentsOverlay"].map(member).join("\n")}
   long commentsAudioInterruptionGeneration;int commentsPausedIndex=-1;String commentsPausedItemId;ShortVideoHolder commentsPausedHolder;
   ExoPlayer commentsPausedVideo,commentsPausedGallerySegment,commentsPausedGallerySound;
   boolean commentsResumeVideo,commentsResumeGallerySegment,commentsResumeGallerySound;
   Object commentsVideoSourceOwner,commentsSegmentSourceOwner,commentsSoundSourceOwner;
   void pauseGalleryContinuation(){}
   StageGestureOwner pendingStageTapOwner;Runnable pendingStageTapRunnable;long stageGestureGeneration,lastStageTapAt;int lastStageTapIndex=-1;
   static final long STAGE_DOUBLE_TAP_MS=280;int likes,retries;
   static class FallbackBoundary{Object bindingOwner(ExoPlayer p){return p.getCurrentMediaItem();}boolean isBound(ExoPlayer p,Object owner){return p.getCurrentMediaItem()==owner;}}
   final FallbackBoundary playbackFallback=new FallbackBoundary();
   void retryPlaybackAt(int index){retries++;}boolean retryGallerySegmentPlayback(){return false;}
   void animateGalleryZoomReset(ShortVideoHolder holder,boolean animate){holder.galleryZoomScale=1;}
   void activateLike(ShortVideoItem item,boolean burst,float x,float y,boolean toast){likes++;}
   void setControlsHidden(boolean hidden,boolean animate){controlsHidden=hidden;}void syncPlayIndicator(int index,ExoPlayer player){}
   ImageRead plan(Bitmap value,boolean throwing,boolean held){ImageRead read=new ImageRead(value,throwing,held);allReads.add(read);planned.add(read);return read;}
   static SurfaceCoverProbe fresh(){SurfaceCoverProbe h=image(2,false);h.activePlayer=null;h.playerCache.clear();h.feedPlayback.select(h.videos.get(3).id);h.feedPlayback.requestExplicitPlayback();fixtures.add(h);return h;}
   void awaitEntered(ImageRead read){try{require(read.entered.await(3,java.util.concurrent.TimeUnit.SECONDS),"read did not start");}catch(InterruptedException e){throw new AssertionError(e);}}
   void settled(){long until=System.nanoTime()+3_000_000_000L;while(frameLoading.activeCount()+frameLoading.queuedCount()>0&&System.nanoTime()<until)Thread.yield();require(frameLoading.activeCount()+frameLoading.queuedCount()==0,"physical read did not settle");}
   void drain(){mainHandler.runPending();}void tick(long delta){SystemClock.now+=delta;drain();}
   NativeShortVideoGalleryImageReadiness state(){return attachedHolders.get(3).galleryImageReadiness;}
   boolean showing(String text){return statusView.visibility==View.VISIBLE&&statusView.text.equals(text);}
   void failed(){plan(null,false,false);bind(0);settled();drain();require(state().failed&&showing("图片加载失败，点一下重试"),"failed image did not expose persistent manual recovery");}
   void tap(){handleStageTap(3);tick(300);}
   Runnable openOverlay(String overlay){if(overlay.equals("search")){Runnable close=pausePlaybackForFeedSearch();feedSearch=true;return ()->{feedSearch=false;close.run();};}if(overlay.equals("comments")){pauseForCommentsOverlay();comments=true;return ()->{comments=false;resumeAfterCommentsOverlay(true);};}showPlaybackToolbar(videos.get(3));return this::dismissPlaybackToolbar;}
   static void disposeFixtures(){for(SurfaceCoverProbe h:fixtures){for(ImageRead r:h.allReads)r.release.countDown();h.destroying=true;h.frameLoading.close();h.settled();}fixtures.clear();}
 `);
// Decoder callbacks are real worker-thread publications. UI queue and clock are
// deterministic, with locking solely around the fake Android Handler leaf.
doubles["android/os/Handler.java"]=`package android.os;import java.util.*;public class Handler {
 public final ArrayList<Runnable> pending=new ArrayList<>();final IdentityHashMap<Runnable,Long> due=new IdentityHashMap<>();
 public boolean post(Runnable r){return postDelayed(r,0);}public synchronized boolean postDelayed(Runnable r,long d){pending.add(r);due.put(r,SystemClock.now+d);return true;}
 public synchronized void removeCallbacks(Runnable r){pending.removeIf(v->v==r);due.remove(r);}
 public void runPending(){for(int n=0;n<100;n++){Runnable next=null;long at=Long.MAX_VALUE;synchronized(this){for(Runnable r:pending){long t=due.getOrDefault(r,0L);if(t<=SystemClock.now&&t<at){next=r;at=t;}}if(next==null)return;removeCallbacks(next);}next.run();}throw new AssertionError("unbounded immediate UI callback loop");}
}`;
java=java.slice(0,java.lastIndexOf("}"))+`
 public static void main(String[] args){selected=args.length==0?"all":args[0];try{
   check("null decode reports failure without auto retry",()->{SurfaceCoverProbe h=fresh();h.videos.get(3).galleryItems.remove(1);h.failed();h.tick(10000);require(h.reads==1&&h.galleryAutoAdvanceRunnable==null&&h.showing("图片加载失败，点一下重试"),"failure retried, advanced, or lost its persistent status");});
   check("exception decode is recoverable",()->{SurfaceCoverProbe h=fresh();h.plan(null,true,false);h.bind(0);h.settled();h.drain();require(h.state().failed&&h.showing("图片加载失败，点一下重试"),"thrown decode was silently discarded");});
   check("owned single tap retries and paints",()->{SurfaceCoverProbe h=fresh();h.videos.get(3).galleryItems.remove(1);h.autoNext=true;h.failed();Bitmap result=new Bitmap();h.plan(result,false,false);long epoch=h.feedPlayback.audioInterruptionGeneration();h.tap();h.settled();h.drain();require(h.reads==2&&h.state().ready&&!h.state().failed&&h.attachedHolders.get(3).cover.drawable==result,"single image tap did not reread/paint");require(h.statusView.visibility==View.GONE&&h.activePlayer==null&&h.feedPlayback.audioInterruptionGeneration()==epoch,"image retry changed playback or failed to clear own status");require(h.galleryAutoAdvanceRunnable!=null,"successful image did not rejoin normal readiness timing");});
   check("slow retry remains visible and repeated taps stay singleflight",()->{SurfaceCoverProbe h=fresh();h.failed();ImageRead read=h.plan(new Bitmap(),false,true);h.tap();h.awaitEntered(read);h.tick(2000);require(h.showing("正在重试图片"),"slow retry lost its waiting feedback at toast timeout");h.tap();h.tick(2000);require(h.reads==2&&h.showing("正在重试图片"),"repeated retry tap launched a second physical read");read.release.countDown();h.settled();h.drain();require(h.state().ready&&h.statusView.visibility==View.GONE,"held retry did not finish normally");});
   check("retry failure returns to explicit retry",()->{SurfaceCoverProbe h=fresh();h.failed();h.plan(null,false,false);h.tap();h.settled();h.drain();require(h.reads==2&&h.state().failed&&h.showing("图片加载失败，点一下重试"),"failed retry lost error state");h.tick(10000);require(h.reads==2,"failure scheduled an unbounded automatic retry");});
   check("old transient timer cannot hide a later failure",()->{SurfaceCoverProbe h=fresh();h.showTransientStatus("已静音");h.failed();h.tick(2000);require(h.showing("图片加载失败，点一下重试"),"old toast timer hid current persistent image failure");});
   check("current transient timer restores current image failure",()->{SurfaceCoverProbe h=fresh();h.failed();h.showTransientStatus("已静音");h.tick(1400);require(h.showing("图片加载失败，点一下重试"),"toast expiry forgot image failure");});
   check("toast expiry restores slow owned retry",()->{SurfaceCoverProbe h=fresh();h.failed();ImageRead read=h.plan(new Bitmap(),false,true);h.tap();h.awaitEntered(read);h.showTransientStatus("音量已调整");h.tick(1400);require(h.showing("正在重试图片"),"toast expiry hid in-flight retry progress");read.release.countDown();h.settled();h.drain();require(h.statusView.visibility==View.GONE,"retry did not clear its restored progress status");});
   check("success cannot hide a newer toast",()->{SurfaceCoverProbe h=fresh();h.failed();ImageRead read=h.plan(new Bitmap(),false,true);h.tap();h.awaitEntered(read);h.showTransientStatus("音量已调整");read.release.countDown();h.settled();h.drain();require(h.state().ready&&h.showing("音量已调整"),"old success hid a newer UI status");h.tick(1400);require(h.statusView.visibility==View.GONE,"success resurrected the retired failure");});
   check("old failed publication cannot overwrite replacement success",()->{SurfaceCoverProbe h=fresh();h.plan(null,false,false);h.bind(0);h.settled();GalleryMedia replacement=new GalleryMedia();replacement.video=false;replacement.url="http://fixture/replacement";h.videos.get(3).galleryItems.set(0,replacement);h.plan(new Bitmap(),false,false);h.bind(0);h.settled();h.drain();require(h.state().ready&&!h.state().failed&&h.statusView.visibility!=View.VISIBLE,"old failure replaced a newer successful source");});
   check("old same-key failure cannot poison a newer attempt",()->{SurfaceCoverProbe h=fresh();h.plan(null,false,false);h.bind(0);h.settled();h.plan(new Bitmap(),false,false);h.loadGalleryImage(h.attachedHolders.get(3),h.videos.get(3),0,0);h.settled();h.drain();require(h.reads==2&&h.state().ready&&!h.state().failed,"late prior-attempt failure poisoned current success");});
   check("hidden failure settles without showing until foreground",()->{SurfaceCoverProbe h=fresh();ImageRead read=h.plan(null,false,true);h.bind(0);h.awaitEntered(read);h.activityResumed=false;h.pauseFrameLoading();read.release.countDown();h.settled();h.drain();require(h.state().failed&&!h.state().loading&&h.statusView.visibility!=View.VISIBLE,"hidden decode failure showed UI or kept loading stuck");h.activityResumed=true;h.resumeFrameLoading();require(h.reads==1&&h.showing("图片加载失败，点一下重试"),"foreground did not restore explicit recovery without an auto loop");});
   for(String overlay:List.of("search","comments","author","toolbar"))check("covered failure remains owned "+overlay,()->{SurfaceCoverProbe h=fresh();ImageRead read=h.plan(null,false,true);h.bind(0);h.awaitEntered(read);if(overlay.equals("search"))h.feedSearch=true;if(overlay.equals("comments"))h.comments=true;if(overlay.equals("author"))h.authorOverlay=new Object();if(overlay.equals("toolbar"))h.playbackToolbarOverlay=new Object();read.release.countDown();h.settled();h.drain();require(h.state().failed&&!h.restoreGalleryImageFailureStatus()&&h.statusView.visibility!=View.VISIBLE,"covered image showed stale retry UI");require(!h.retryGalleryImagePlayback()&&h.reads==1,"covered image accepted manual retry");h.feedSearch=false;h.comments=false;h.authorOverlay=null;h.playbackToolbarOverlay=null;require(h.restoreGalleryImageFailureStatus()&&h.showing("图片加载失败，点一下重试"),"overlay close could not restore current failure");});
   for(String overlay:List.of("search","comments","toolbar"))check("actual close restores image failure "+overlay,()->{SurfaceCoverProbe h=fresh();ImageRead read=h.plan(null,false,true);h.bind(0);h.awaitEntered(read);Runnable close=h.openOverlay(overlay);read.release.countDown();h.settled();h.drain();require(h.state().failed&&h.statusView.visibility!=View.VISIBLE,"covered image failure showed before actual close");close.run();require(h.showing("图片加载失败，点一下重试")&&h.reads==1,"actual overlay close omitted owned image recovery footer");});
   for(String change:List.of("pager","holder","source","background","destroy"))check("queued tap rejects stale image owner "+change,()->{SurfaceCoverProbe h=fresh();h.failed();h.handleStageTap(3);if(change.equals("pager"))h.pager.setCurrentItem(2,false);if(change.equals("holder"))h.attachedHolders.put(3,new ShortVideoHolder(3));if(change.equals("source")){GalleryMedia media=new GalleryMedia();media.video=false;media.url="http://fixture/new-source";h.videos.get(3).galleryItems.set(0,media);}if(change.equals("background"))h.activityResumed=false;if(change.equals("destroy"))h.destroying=true;h.tick(300);require(h.reads==1,"expired tap retried hidden/replaced media");});
   check("departed view cannot revive failure after toast",()->{SurfaceCoverProbe h=fresh();h.failed();h.showTransientStatus("已静音");h.pager.setCurrentItem(2,false);h.tick(1400);require(h.statusView.visibility==View.GONE,"departed image revived its retry prompt");});
   check("destroy suppresses queued failure publication",()->{SurfaceCoverProbe h=fresh();h.plan(null,false,false);h.bind(0);h.settled();h.destroying=true;h.drain();require(!h.state().failed&&h.statusView.visibility!=View.VISIBLE,"late failure wrote a destroyed view");});
   require(args.length!=0||checks==26,"missing image recovery cases: "+checks);System.out.println("native-gallery-image-recovery: "+checks+" actual decoder/request/tap/status/owner cases passed");
 }finally{disposeFixtures();}}
}`;
const temporary=fs.mkdtempSync(path.join(os.tmpdir(),"fanhao-native-gallery-image-recovery-"));
const javaHome=process.env.JAVA_HOME||"C:/Program Files/Android/openjdk/jdk-21.0.8",exe=name=>path.join(javaHome,"bin",name+".exe");
function run(label,implementation=java,selection=[]){const directory=path.join(temporary,label);fs.mkdirSync(directory,{recursive:true});const files=[];for(const[relative,source]of Object.entries({...doubles,[host]:implementation})){const target=path.join(directory,relative);fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,source);files.push(target);}files.push(path.join(native,"NativeShortVideoFeedPlayback.java"),path.join(native,"NativeShortVideoFrameLoader.java"));const compiled=spawnSync(exe("javac"),["-encoding","UTF-8","-d",directory,...files],{encoding:"utf8",timeout:25000});assert.equal(compiled.status,0,compiled.stderr);return spawnSync(exe("java"),["-cp",directory,"local.fanhao.library.SurfaceCoverProbe",...selection],{encoding:"utf8",timeout:20000});}
try{const actual=run("actual");assert.equal(actual.status,0,actual.stderr);process.stdout.write(actual.stdout);
 const silent=java.replace("if (!destroying) failed.run();","if (false) failed.run();");assert.notEqual(silent,java);const noFeedback=run("silent-failure",silent,["null decode reports failure without auto retry"]);assert.notEqual(noFeedback.status,0);assert.match(noFeedback.stderr,/persistent manual recovery/);
 const staleStatus=java.replace("if (generation == statusGeneration && !restoreGalleryPlaybackStatus()) hideStatus();","hideStatus();");assert.notEqual(staleStatus,java);const oldToast=run("old-toast",staleStatus,["old transient timer cannot hide a later failure"]);assert.notEqual(oldToast.status,0);assert.match(oldToast.stderr,/old toast timer hid/);
 console.log("native-gallery-image-recovery: silent decode failure and old-toast status negative controls rejected");
}finally{const target=fs.realpathSync(temporary),parent=fs.realpathSync(os.tmpdir());assert.equal(path.dirname(target),parent);assert(path.basename(target).startsWith("fanhao-native-gallery-image-recovery-"));fs.rmSync(target,{recursive:true,force:true});}
