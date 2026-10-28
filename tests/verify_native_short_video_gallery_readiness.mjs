import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { buildGalleryOwnershipDoubles } from "./fixtures/native-gallery-ownership-harness.mjs";

// Real binding/paint/timer/search-pause code, controlled asynchronous image
// replies and clock. Native Android views/bitmaps are leaves; no device, real
// image, network, DB, service or generated APK is used.
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),".."),native=path.join(root,"android-client/android/app/src/main/java/local/fanhao/library");
const activity=fs.readFileSync(path.join(native,"NativeShortVideoActivity.java"),"utf8").replace(/\r\n/g,"\n");
function member(name){const value=activity.match(new RegExp(`  private (?:void|boolean|String|Runnable|NativeShortVideoGalleryImageReadiness) ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n  \\}`))?.[0];assert(value,name);return value.replace("private ","");}
const legacy=JSON.parse(fs.readFileSync(path.join(root,"tests/fixtures/native-gallery-ownership-before-fix.json"),"utf8"));
const methods=Object.fromEntries([...Object.keys(legacy.methods),"isBoundGallery","isGalleryImageReady","scheduleGalleryAutoAdvanceAfter"].map(name=>[name,member(name)]));
// This image fixture binds an already selected holder directly. The separate
// playback-request suite owns the Activity's asynchronous page-selection path.
methods.playAt="  private void playAt(int index) {}";
const verifier=fs.readFileSync(path.join(root,"tests/verify_native_short_video_playback.mjs"),"utf8");
const raw=vm.runInNewContext(verifier.slice(verifier.indexOf("const doubles = "),verifier.indexOf("\ntry {"))+"\ndoubles");
const doubles=buildGalleryOwnershipDoubles(raw,methods,"public void onRenderedFirstFrame() {}");
doubles["android/os/SystemClock.java"]="package android.os;public class SystemClock {public static long now;public static long uptimeMillis(){return now;}public static long elapsedRealtime(){return now;}}";
const pauseClass=activity.match(/  private static final class GallerySearchAdvancePause \{[\s\S]*?\n  \}/)?.[0];assert(pauseClass);
const helperFile=path.join(native,"NativeShortVideoGalleryImageReadiness.java");
const readinessHelpers="";
const toolbarPrelude=member("showPlaybackToolbar").split("    final List<Runnable>")[0]+"playbackToolbarOverlay=new Object();\n  }";
const host="local/fanhao/library/SurfaceCoverProbe.java";
let java=doubles[host].slice(0,doubles[host].indexOf("public static void main(String[] args){"))+"\n}";
java=java
 .replace("import java.util.*;","import java.util.*;import java.util.concurrent.Callable;import java.util.function.Consumer;")
 .replace("Object gallerySearchAdvancePause;","GallerySearchAdvancePause gallerySearchAdvancePause;")
 .replace("boolean feedSearchOpen(){return false;}","boolean feedSearch;boolean feedSearchOpen(){return feedSearch;}")
 .replace("void loadGalleryImage(ShortVideoHolder h,ShortVideoItem i,int n,int d){imageLoads++;h.cover.setTag(galleryCacheKey(i,n));showGalleryBitmap(h,i,n,new Bitmap(),d);}",member("loadGalleryImage"))
 .replace('String galleryCacheKey(ShortVideoItem i,int n){return i.id+":"+n;}',member("galleryCacheKey"))
 .replace("void resumeGalleryAutoAdvanceIfNeeded(){}","")
 .replace("public class SurfaceCoverProbe {",`public class SurfaceCoverProbe {
   final Map<String,Bitmap> frameCache=new HashMap<>();final Map<String,Consumer<Bitmap>> replies=new HashMap<>();final Map<String,Runnable> failures=new HashMap<>();int reads;String status="";
   final FrameReadBoundary frameLoading=new FrameReadBoundary();class FrameReadBoundary{boolean contains(String key){return replies.containsKey(key);}}
   void showStatus(String value){statusGeneration++;status=value;}
   static final int PLAYER_COVER_MAX_WIDTH=720,PLAYER_COVER_MAX_HEIGHT=1280;
   Bitmap loadBitmap(String url,int width,int height){return new Bitmap();}
   final RootView rootView=new RootView();static class RootView{void removeView(Object view){}}void clearPendingStageTap(){}void hideSystemBars(){}
   ${toolbarPrelude}${member("dismissPlaybackToolbar")}
   void requestFrame(String key,Callable<Bitmap> read,Consumer<Bitmap> paint){requestFrame(key,read,paint,null);}
   void requestFrame(String key,Callable<Bitmap> read,Consumer<Bitmap> paint,Runnable failed){reads++;replies.put(key,paint);failures.put(key,failed);}
   void reply(String key,Bitmap bitmap){Consumer<Bitmap> paint=replies.remove(key);Runnable failed=failures.remove(key);if(bitmap!=null&&paint!=null){frameCache.put(key,bitmap);paint.accept(bitmap);}else if(bitmap==null&&failed!=null)failed.run();}
   ${member("ownsGalleryImageRead")}${member("restoreGalleryImageFailureStatus")}
   ${member("restoreGalleryPlaybackStatus")}boolean restoreGallerySegmentFailureStatus(){return false;}
   ${pauseClass.replace("private ","")}${["pauseGalleryAutoAdvanceForSearch","resumeGalleryAutoAdvanceAfterSearch","resumeGalleryAutoAdvanceIfNeeded"].map(member).join("\n")}${readinessHelpers}
   static SurfaceCoverProbe image(int count,boolean enabled){android.os.SystemClock.now=0;SurfaceCoverProbe h=new SurfaceCoverProbe();ShortVideoItem item=h.videos.get(3);item.galleryItems.clear();for(int i=0;i<count;i++){GalleryMedia media=new GalleryMedia();media.video=false;media.url="http://fixture/image/"+i;item.galleryItems.add(media);}h.autoNext=enabled;return h;}
   String key(){ShortVideoHolder holder=attachedHolders.get(3);return galleryCacheKey(videos.get(3),holder.galleryIndex);}
   void bind(int index){bindGallery(attachedHolders.get(3),videos.get(3),index,0);}void ready(){reply(key(),new Bitmap());}
   static void noTimer(SurfaceCoverProbe h,String why){require(h.galleryAutoAdvanceRunnable==null,why);}
   public static void main(String[] args){selected="all";
     check("cold read waits for the current image",()->{SurfaceCoverProbe h=image(2,false);h.bind(0);noTimer(h,"unseen image already owns an advance timer");require(h.replies.containsKey(h.key()),"cold image did not start a real keyed read");android.os.SystemClock.now+=10000;h.ready();require(h.galleryAutoAdvanceDueAtMs==android.os.SystemClock.now+GALLERY_IMAGE_AUTO_ADVANCE_MS,"successful current image did not receive a full visible interval");});
     check("cold single image cannot skip to next work",()->{SurfaceCoverProbe h=image(1,true);h.bind(0);android.os.SystemClock.now+=10000;h.mainHandler.runPending();require(h.advances==0,"single unseen image advanced to another work");});
     check("duplicate bind and paint retain the deadline",()->{SurfaceCoverProbe h=image(2,false);h.bind(0);h.ready();Runnable timer=h.galleryAutoAdvanceRunnable;long due=h.galleryAutoAdvanceDueAtMs;android.os.SystemClock.now+=1700;h.bind(0);h.showGalleryBitmap(h.attachedHolders.get(3),h.videos.get(3),0,new Bitmap(),0);require(h.galleryAutoAdvanceRunnable==timer&&h.galleryAutoAdvanceDueAtMs==due,"same-image bind/paint extended visible time");});
     check("failed replacement does not borrow old drawable",()->{SurfaceCoverProbe h=image(2,false);h.bind(0);h.ready();Bitmap prior=(Bitmap)h.attachedHolders.get(3).cover.drawable;h.bind(1);h.reply(h.key(),null);h.resumeGalleryAutoAdvanceIfNeeded();noTimer(h,"failed current image treated the old drawable as ready");require(h.advances==0&&prior!=null,"failure fixture did not begin from a shown previous image");});
     check("legacy thumbnail never completes the current read",()->{SurfaceCoverProbe h=image(2,false);h.frameCache.put(h.videos.get(3).id,new Bitmap());h.bind(0);noTimer(h,"thumbnail fallback started image timing");require(h.replies.containsKey(h.key()),"thumbnail fallback short-circuited the versioned image read");});
     check("background arrival waits for foreground",()->{SurfaceCoverProbe h=image(2,false);h.bind(0);h.activityResumed=false;h.cancelGalleryAutoAdvance();h.ready();noTimer(h,"background image arrival started timing");android.os.SystemClock.now+=10000;h.activityResumed=true;h.resumeGalleryAutoAdvanceIfNeeded();require(h.galleryAutoAdvanceDueAtMs==android.os.SystemClock.now+GALLERY_IMAGE_AUTO_ADVANCE_MS,"background load consumed visible reading time");});
     check("unready search resumes after image arrives",()->{SurfaceCoverProbe h=image(2,false);h.bind(0);Runnable close=h.pauseGalleryAutoAdvanceForSearch();h.feedSearch=true;h.ready();noTimer(h,"search-covered image started timing");h.feedSearch=false;close.run();require(h.galleryAutoAdvanceRunnable!=null,"search lost the not-yet-ready image timing intent");});
     check("search retains remaining time after a duplicate ready paint",()->{SurfaceCoverProbe h=image(2,false);h.bind(0);h.ready();android.os.SystemClock.now+=1700;Runnable close=h.pauseGalleryAutoAdvanceForSearch();h.feedSearch=true;h.showGalleryBitmap(h.attachedHolders.get(3),h.videos.get(3),0,new Bitmap(),0);android.os.SystemClock.now+=10000;h.feedSearch=false;close.run();require(h.galleryAutoAdvanceDueAtMs==android.os.SystemClock.now+GALLERY_IMAGE_AUTO_ADVANCE_MS-1700,"duplicate paint/reset lost paused remaining time");});
     check("zero remaining time is not a fresh full interval",()->{SurfaceCoverProbe h=image(2,false);h.bind(0);h.ready();android.os.SystemClock.now=h.galleryAutoAdvanceDueAtMs;h.cancelGalleryAutoAdvance();h.resumeGalleryAutoAdvanceIfNeeded();require(h.galleryAutoAdvanceDueAtMs==android.os.SystemClock.now,"expired remaining time reset to full interval");});
     check("late prior source cannot ready the replacement",()->{SurfaceCoverProbe h=image(2,false);h.bind(0);String old=h.key();GalleryMedia media=new GalleryMedia();media.video=false;media.url="http://fixture/replacement";h.videos.get(3).galleryItems.set(0,media);h.bind(0);h.reply(old,new Bitmap());noTimer(h,"old-source reply marked the replacement ready");h.ready();require(h.galleryAutoAdvanceRunnable!=null,"current-source reply could not start timing");});
     check("retired holder reply cannot start a timer",()->{SurfaceCoverProbe h=image(2,false);h.bind(0);String key=h.key();h.attachedHolders.put(3,new ShortVideoHolder(3));h.reply(key,new Bitmap());noTimer(h,"retired holder paint started timing");});
     check("versioned cached image is immediately ready",()->{SurfaceCoverProbe h=image(2,false);Bitmap bitmap=new Bitmap();h.frameCache.put(h.galleryCacheKey(h.videos.get(3),0),bitmap);h.bind(0);require(h.reads==0&&h.attachedHolders.get(3).cover.drawable==bitmap&&h.galleryAutoAdvanceRunnable!=null,"valid cached source did not start visible timing");});
     check("background pause preserves remaining visible time",()->{SurfaceCoverProbe h=image(2,false);h.bind(0);h.ready();android.os.SystemClock.now+=1700;h.activityResumed=false;h.cancelGalleryAutoAdvance();android.os.SystemClock.now+=10000;h.activityResumed=true;h.showGalleryBitmap(h.attachedHolders.get(3),h.videos.get(3),0,new Bitmap(),0);h.resumeGalleryAutoAdvanceIfNeeded();require(h.galleryAutoAdvanceDueAtMs==android.os.SystemClock.now+GALLERY_IMAGE_AUTO_ADVANCE_MS-1700,"foreground duplicate paint reset paused reading budget");});
     check("blocked expiry retains zero until interaction ends",()->{SurfaceCoverProbe h=image(2,false);h.bind(0);h.ready();android.os.SystemClock.now=h.galleryAutoAdvanceDueAtMs;h.attachedHolders.get(3).touchActive=true;h.galleryAutoAdvanceRunnable.run();require(h.advances==0&&h.attachedHolders.get(3).galleryImageReadiness.remainingMs==0,"blocked expiry restarted the reading budget");h.cancelGalleryAutoAdvance();h.attachedHolders.get(3).touchActive=false;h.resumeGalleryAutoAdvanceIfNeeded();require(h.galleryAutoAdvanceDueAtMs==android.os.SystemClock.now,"released expired image received a new full interval");h.galleryAutoAdvanceRunnable.run();require(h.advances==1,"expired ready image did not advance after interaction release");});
     check("search lease cannot reuse timing for replacement source",()->{SurfaceCoverProbe h=image(2,false);h.bind(0);h.ready();android.os.SystemClock.now+=1700;Runnable close=h.pauseGalleryAutoAdvanceForSearch();h.feedSearch=true;GalleryMedia replacement=new GalleryMedia();replacement.video=false;replacement.url="http://fixture/new-under-search";h.videos.get(3).galleryItems.set(0,replacement);h.bind(0);h.ready();android.os.SystemClock.now+=10000;h.feedSearch=false;close.run();require(h.galleryAutoAdvanceDueAtMs==android.os.SystemClock.now+GALLERY_IMAGE_AUTO_ADVANCE_MS,"old source's search lease overwrote the new reading budget");});
     check("changed selected page rejects old image timer",()->{SurfaceCoverProbe h=image(2,false);h.bind(0);h.ready();Runnable old=h.galleryAutoAdvanceRunnable;h.pager.setCurrentItem(2,false);old.run();require(h.advances==0&&h.galleryAutoAdvanceRunnable==null,"old page image advanced while the next selected page awaited binding");});
     check("null paint cannot complete image readiness",()->{SurfaceCoverProbe h=image(2,false);h.bind(0);h.showGalleryBitmap(h.attachedHolders.get(3),h.videos.get(3),0,null,0);noTimer(h,"failed/null image paint started timing");});
     check("toolbar pauses visible time",()->{SurfaceCoverProbe h=image(2,false);h.bind(0);h.ready();android.os.SystemClock.now+=1700;h.showPlaybackToolbar(h.videos.get(3));noTimer(h,"toolbar failed to pause image timer");android.os.SystemClock.now+=10000;h.dismissPlaybackToolbar();require(h.galleryAutoAdvanceDueAtMs==android.os.SystemClock.now+GALLERY_IMAGE_AUTO_ADVANCE_MS-1700,"toolbar consumed the image's visible reading time");});
     check("image arrives behind toolbar",()->{SurfaceCoverProbe h=image(2,false);h.bind(0);h.showPlaybackToolbar(h.videos.get(3));h.ready();noTimer(h,"covered image arrival started timer");android.os.SystemClock.now+=10000;h.dismissPlaybackToolbar();require(h.galleryAutoAdvanceDueAtMs==android.os.SystemClock.now+GALLERY_IMAGE_AUTO_ADVANCE_MS,"covered image arrival lost its full reading interval");});
     check("toolbar preserves already expired zero",()->{SurfaceCoverProbe h=image(2,false);h.bind(0);h.ready();android.os.SystemClock.now=h.galleryAutoAdvanceDueAtMs;h.showPlaybackToolbar(h.videos.get(3));android.os.SystemClock.now+=10000;h.dismissPlaybackToolbar();require(h.galleryAutoAdvanceDueAtMs==android.os.SystemClock.now,"toolbar reset a genuinely expired image to a fresh interval");});
     require(checks==20,"missing readiness cases");System.out.println("native-gallery-readiness: "+checks+" actual asynchronous bind/paint/timer/search cases passed");
   }
 `);
doubles[host]=java;
doubles["local/fanhao/library/GalleryMedia.java"]=doubles["local/fanhao/library/GalleryMedia.java"].replace("boolean video=true;","String posterUrl=\"\";boolean video=true;");
const temporary=fs.mkdtempSync(path.join(os.tmpdir(),"fanhao-native-gallery-readiness-"));
const javaHome=process.env.JAVA_HOME||"C:/Program Files/Android/openjdk/jdk-21.0.8",exe=name=>path.join(javaHome,"bin",name+".exe");
function run(label,implementation=java){const folder=path.join(temporary,label);fs.mkdirSync(folder,{recursive:true});const files=[];for(const[relative,source]of Object.entries({...doubles,[host]:implementation})){const target=path.join(folder,relative);fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,source);files.push(target);}files.push(path.join(native,"NativeShortVideoFeedPlayback.java"));const compiled=spawnSync(exe("javac"),["-encoding","UTF-8","-d",folder,...files],{encoding:"utf8",timeout:20000});assert.equal(compiled.status,0,compiled.stderr);return spawnSync(exe("java"),["-cp",folder,"local.fanhao.library.SurfaceCoverProbe"],{encoding:"utf8",timeout:15000});}
try{const result=run("current");assert.equal(result.status,0,result.stderr);process.stdout.write(result.stdout);
 const eager=java.replace(member("isGalleryImageReady"),"boolean isGalleryImageReady(ShortVideoHolder holder,ShortVideoItem item,int index){return isBoundGallery(holder,item)&&holder.galleryImageReadiness!=null;}")
   .replace("loadGalleryImage(holder, item, galleryIndex, direction);","loadGalleryImage(holder, item, galleryIndex, direction);if(currentGallery)scheduleGalleryAutoAdvance(holder,item,galleryIndex);");
 assert.notEqual(eager,java);const early=run("timer-before-image",eager);assert.notEqual(early.status,0);assert.match(early.stderr,/unseen image already owns an advance timer/);
 const thumbnail=java.replace("    if (cached != null) {","    if(cached==null&&galleryIndex==0)cached=frameCache.get(item.id);\n    if (cached != null) {");assert.notEqual(thumbnail,java);const legacyThumb=run("thumbnail-ready",thumbnail);assert.notEqual(legacyThumb.status,0);assert.match(legacyThumb.stderr,/thumbnail fallback started image timing|thumbnail fallback short-circuited/);
 console.log("native-gallery-readiness: eager pre-paint timer and unversioned-thumbnail readiness negative controls rejected");
}finally{const target=fs.realpathSync(temporary),parent=fs.realpathSync(os.tmpdir());assert.equal(path.dirname(target),parent);assert(path.basename(target).startsWith("fanhao-native-gallery-readiness-"));fs.rmSync(target,{recursive:true,force:true});}
