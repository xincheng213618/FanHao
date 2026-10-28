import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

// Actual controller + Activity request/window/normal/gallery methods. Reuse
// synthetic Bitmap/Android leaves; every media worker is a real Java thread.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixturePath = path.join(root, "tests/verify_native_short_video_cover_ownership.mjs");
const fixtureText = fs.readFileSync(fixturePath, "utf8");
const prefix = fixtureText.slice(0, fixtureText.indexOf("\nfunction compile(name, code)"))
  .replace('const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");', `const root = ${JSON.stringify(root)};`);
const { harness, temp, executable, take } = await import(`data:text/javascript;base64,${Buffer.from(`${prefix}\nexport {harness,temp,executable,take};`).toString("base64")}`);
const sourcePath = path.join(root, "android-client/android/app/src/main/java/local/fanhao/library/NativeShortVideoFrameLoader.java");
const controller = fs.readFileSync(sourcePath, "utf8");
let java = harness.replaceAll("CoverOwnerProbe", "FrameLoadingProbe");
java = java.replace("boolean gallery;", "boolean gallery;final List<GalleryMedia> galleryItems=new ArrayList<>();")
  .replace("final int index;final ImageView", "final int index;int galleryIndex;NativeShortVideoGalleryImageReadiness galleryImageReadiness;final ImageView")
  .replace("Bitmap bitmap;void setImageBitmap", "Bitmap bitmap;Object tag;Object getDrawable(){return bitmap;}void setTag(Object value){tag=value;}Object getTag(){return tag;}void setImageDrawable(Object value){if(value==null)bitmap=null;}void setImageBitmap")
  .replace("static final class ShortVideoItem {", "static final class GalleryMedia {final String url,posterUrl;final boolean video;GalleryMedia(String url,String poster,boolean video){this.url=url;posterUrl=poster;this.video=video;}boolean isVideo(){return video;}}\n    static final class ShortVideoItem {");
const windowStart = java.indexOf("    volatile FrameLoadingWindow frameLoadingWindow=");
const windowEnd = java.indexOf("    final UiQueue mainHandler=", windowStart);
assert(windowStart >= 0 && windowEnd > windowStart);
java = java.slice(0, windowStart) + `
    volatile FrameLoadingWindow frameLoadingWindow=new FrameLoadingWindow(Collections.emptySet(),"");
    int currentIndex=-1;boolean activityResumed=true,finishing,comments,search;Object authorOverlay;
    boolean isFinishing(){return finishing;}boolean commentsOpen(){return comments;}boolean feedSearchOpen(){return search;}
    ${take("refreshFrameLoadingWindow")}
    ${take("pauseFrameLoading")}
    ${take("resumeFrameLoading")}
` + java.slice(windowEnd);
const decodeStart = java.indexOf("    Bitmap decode(String source){"), decodeEnd = java.indexOf("    Bitmap loadBitmap(", decodeStart);
java = java.slice(0, decodeStart) + `
    static final class Gate {final CountDownLatch entered=new CountDownLatch(1),release=new CountDownLatch(1);}
    final Map<String,Gate> gates=new ConcurrentHashMap<>();final List<String> reads=Collections.synchronizedList(new ArrayList<>());
    Gate hold(String source){Gate gate=new Gate();gates.put(source,gate);return gate;}
    Bitmap decode(String source){decodes.incrementAndGet();reads.add(source);Gate gate=gates.get(source);if(gate!=null){gate.entered.countDown();try{require(gate.release.await(4,TimeUnit.SECONDS),"read gate timed out: "+source);}catch(InterruptedException error){Thread.currentThread().interrupt();return null;}}return new Bitmap(source);}
` + java.slice(decodeEnd);
// RecyclerView metadata binding is a leaf here: create its initial readiness
// record, then execute the real read/attempt/ownership body unchanged.
const imageRead = take("loadGalleryImage").replace("void loadGalleryImage(", "void loadBoundGalleryImage(") + `
    void loadGalleryImage(ShortVideoHolder holder,ShortVideoItem item,int mediaIndex,int direction){if(holder.galleryImageReadiness==null)holder.galleryImageReadiness=new NativeShortVideoGalleryImageReadiness(galleryCacheKey(item,mediaIndex),4000);loadBoundGalleryImage(holder,item,mediaIndex,direction);}
`;
java = java.replace("void bindGallery(ShortVideoHolder holder,ShortVideoItem item,int mediaIndex,int direction){galleryBinds++;}", "")
  .replace("void prefetchGalleryMedia(ShortVideoItem item,int mediaIndex){galleryPrewarms++;}", `${take("prefetchGalleryMedia")}\n${take("loadGalleryMediaFrame")}\n${imageRead}\n${take("loadGalleryFrame")}\n${take("galleryMediaAt")}\n${take("galleryCacheKey")}\n${take("isBoundGallery")}\n${take("isGalleryImageReady")}\n${take("ownsGalleryImageRead")}\nboolean restoreGalleryImageFailureStatus(){return false;}`);
const show = take("showGalleryBitmap").split("    holder.galleryCurrentLayer.animate().cancel();")[0] + "    holder.cover.setImageBitmap(bitmap);if(holder.galleryImageReadiness!=null){holder.galleryImageReadiness.ready=true;holder.galleryImageReadiness.loading=false;holder.galleryImageReadiness.failed=false;}\n  }";
java = java.replace("    void select(ShortVideoItem item){", `${show}\n    void bindGallery(ShortVideoHolder holder,ShortVideoItem item,int mediaIndex,int direction){holder.galleryIndex=mediaIndex;refreshFrameLoadingWindow();if(item.galleryItems.get(mediaIndex).isVideo())loadGalleryFrame(holder,item,mediaIndex,direction);else{if(holder.galleryImageReadiness==null||!holder.galleryImageReadiness.key.equals(galleryCacheKey(item,mediaIndex)))holder.galleryImageReadiness=new NativeShortVideoGalleryImageReadiness(galleryCacheKey(item,mediaIndex),4000);loadGalleryImage(holder,item,mediaIndex,direction);}}\n    void select(ShortVideoItem item){currentIndex=0;`)
  .replace("public void close()throws Exception{releaseOld.countDown();", "public void close()throws Exception{for(Gate gate:gates.values())gate.release.countDown();releaseOld.countDown();");
const mainStart = java.indexOf("    public static void main(String[] args)throws Exception {");
assert(mainStart > 0);
java = java.slice(0, mainStart) + `
    static final CountDownLatch nullReady=new CountDownLatch(1),nullResume=new CountDownLatch(1);static volatile boolean holdNull;
    static final CountDownLatch failureReady=new CountDownLatch(1),failureResume=new CountDownLatch(1);static volatile boolean holdFailure;
    static void blockNullPublication(String key)throws Exception{if(holdNull&&key.equals("rerun")){nullReady.countDown();require(nullResume.await(4,TimeUnit.SECONDS),"null publication gate timed out");}if(holdFailure&&key.equals("failure-race")){failureReady.countDown();require(failureResume.await(4,TimeUnit.SECONDS),"failure publication gate timed out");}}
    static void entered(Gate gate)throws Exception{require(gate.entered.await(3,TimeUnit.SECONDS),"physical read never started");}
    static void idle(NativeShortVideoFrameLoader<?> loader)throws Exception{synchronized(loader){long end=System.currentTimeMillis()+4000;while(loader.activeCount()!=0||loader.queuedCount()!=0){long left=end-System.currentTimeMillis();require(left>0,"physical jobs did not drain");loader.wait(left);}}}
    static void bitmap(FrameLoadingProbe host,ShortVideoHolder holder)throws Exception{long end=System.currentTimeMillis()+4000;while(holder.cover.bitmap==null){require(System.currentTimeMillis()<end,"current bitmap was never delivered");host.reply();}}
    static ShortVideoItem target(String kind){ShortVideoItem item=new ShortVideoItem("target","target",kind.equals("cover"));if(kind.startsWith("gallery")){item.gallery=true;item.galleryItems.add(new GalleryMedia("gallery:target","",kind.equals("gallery-video")));}return item;}
    static String source(ShortVideoItem item){return item.isGallery()?item.galleryItems.get(0).url:item.coverUrl.length()>0?item.coverUrl:item.streamUrl;}
    static void request(FrameLoadingProbe h,ShortVideoItem item,boolean paint){
      if(item.isGallery()){if(paint){ShortVideoHolder holder=h.attachedHolders.get(2);if(item.galleryItems.get(0).isVideo())h.loadGalleryFrame(holder,item,0,0);else{if(holder.galleryImageReadiness==null)holder.galleryImageReadiness=new NativeShortVideoGalleryImageReadiness(h.galleryCacheKey(item,0),4000);h.loadGalleryImage(holder,item,0,0);}}else h.prefetchGalleryMedia(item,0);}
      else if(paint)h.bindFrame(2);else {String key=h.normalVideoFrameKey(item);h.requestFrame(key,()->h.decode(source(item)),null);}
    }
    public static void main(String[] args)throws Exception {
      selected=args.length==0?"all":args[0];
      check("bounded_latest_current_first",()->{
        NativeShortVideoFrameLoader<Bitmap> loader=new NativeShortVideoFrameLoader<>();Gate a=new Gate(),b=new Gate();List<String> order=Collections.synchronizedList(new ArrayList<>());final String[] current={""};
        try{
          loader.offer("a",()->true,()->false,()->{a.entered.countDown();a.release.await();return new Bitmap("a");},false,x->{});
          loader.offer("b",()->true,()->false,()->{b.entered.countDown();b.release.await();return new Bitmap("b");},false,x->{});entered(a);entered(b);
          for(int index=0;index<40;index++){String key="spec-"+index;loader.offer(key,()->true,()->false,()->{order.add(key);return new Bitmap(key);},false,x->{});require(loader.activeCount()==2&&loader.queuedCount()<=6,"physical or queued budget exceeded");}
          current[0]="current";loader.offer("current",()->true,()->true,()->{order.add("current");return new Bitmap("current");},true,x->{});
          a.release.countDown();synchronized(loader){long end=System.currentTimeMillis()+3000;while(order.isEmpty()){long left=end-System.currentTimeMillis();require(left>0,"current never got a free slot");loader.wait(left);}}
          require(order.get(0).equals("current"),"obsolete FIFO was dispatched before the newest current source");
          b.release.countDown();idle(loader);require(order.size()<=6,"evicted speculative jobs still executed");
        }finally{a.release.countDown();b.release.countDown();loader.close();idle(loader);}
      });
      for(String kind:List.of("cover","frame","gallery-image","gallery-video"))for(boolean running:List.of(false,true)){
        check("prefetch_promotes_and_delivers_"+kind+"_"+running,()->{try(FrameLoadingProbe h=new FrameLoadingProbe()){
          ShortVideoItem left=new ShortVideoItem("left","hold-left",true),focus=new ShortVideoItem("focus","hold-focus",true),item=target(kind);
          h.videos.addAll(List.of(left,focus,item));for(int index=0;index<3;index++)h.attachedHolders.put(index,new ShortVideoHolder(index));h.currentIndex=1;h.refreshFrameLoadingWindow();
          Gate first=h.hold(left.coverUrl),second=h.hold(focus.coverUrl),result=h.hold(source(item));h.bindFrame(0);entered(first);
          if(!running){h.bindFrame(1);entered(second);}request(h,item,false);if(running)entered(result);else require(h.frameLoading.queuedCount()==1,"prefetch must be queued for upgrade");
          h.currentIndex=2;h.refreshFrameLoadingWindow();request(h,item,true);
          if(!running){first.release.countDown();entered(result);}require(h.frameLoading.activeCount()<=2,"promotion created another physical read");
          result.release.countDown();bitmap(h,h.attachedHolders.get(2));require(h.attachedHolders.get(2).cover.bitmap.source.equals(source(item)),"promoted current view did not receive its bitmap");
          require(Collections.frequency(h.reads,source(item))==1,"same-source upgrade decoded twice");
        }});
      }
      for(String kind:List.of("cover","frame","gallery-image","gallery-video")){
        check("foreground_reoffers_cancelled_current_"+kind,()->{try(FrameLoadingProbe h=new FrameLoadingProbe()){
          ShortVideoItem left=new ShortVideoItem("left","hold-left",true),focus=new ShortVideoItem("focus","hold-focus",true),item=target(kind);
          h.videos.addAll(List.of(left,focus,item));for(int index=0;index<3;index++)h.attachedHolders.put(index,new ShortVideoHolder(index));h.currentIndex=1;h.refreshFrameLoadingWindow();
          Gate a=h.hold(left.coverUrl),b=h.hold(focus.coverUrl);h.bindFrame(0);h.bindFrame(1);entered(a);entered(b);request(h,item,false);
          h.currentIndex=2;h.activityResumed=false;h.pauseFrameLoading();require(h.frameLoading.queuedCount()==0&&h.frameLoading.activeCount()==2,"background must discard pending but retain physical reads");
          h.activityResumed=true;h.resumeFrameLoading();require(h.frameLoading.queuedCount()==1,"foreground did not request its still-empty current cover");
          a.release.countDown();bitmap(h,h.attachedHolders.get(2));require(h.attachedHolders.get(2).cover.bitmap.source.equals(source(item)),"foreground current gallery/cover remained blank");
        }});
      }
      check("source_window_prunes_and_retry_releases_key",()->{try(FrameLoadingProbe h=new FrameLoadingProbe()){
        ShortVideoItem a=new ShortVideoItem("a","hold-a",true),b=new ShortVideoItem("b","hold-b",true),c=new ShortVideoItem("c","c",true);h.videos.addAll(List.of(a,b,c));for(int i=0;i<3;i++)h.attachedHolders.put(i,new ShortVideoHolder(i));h.currentIndex=1;h.refreshFrameLoadingWindow();
        Gate ga=h.hold(a.coverUrl),gb=h.hold(b.coverUrl);h.bindFrame(0);h.bindFrame(1);entered(ga);entered(gb);h.bindFrame(2);String key=h.normalVideoFrameKey(c);
        h.pauseFrameLoading();require(!h.frameLoading.contains(key),"cancelled pending source retained its singleflight key");h.currentIndex=2;h.resumeFrameLoading();ga.release.countDown();bitmap(h,h.attachedHolders.get(2));
      }});
      check("gallery_type_url_poster_are_distinct_sources",()->{try(FrameLoadingProbe h=new FrameLoadingProbe()){
        ShortVideoItem item=target("gallery-video");String first=h.galleryCacheKey(item,0);item.galleryItems.set(0,new GalleryMedia("gallery:new","",true));String url=h.galleryCacheKey(item,0);
        item.galleryItems.set(0,new GalleryMedia("gallery:new","poster:new",true));String poster=h.galleryCacheKey(item,0);item.galleryItems.set(0,new GalleryMedia("gallery:new","poster:new",false));String type=h.galleryCacheKey(item,0);
        require(new HashSet<>(List.of(first,url,poster,type)).size()==4,"different gallery source/version/type shared a cache/request key");
        ShortVideoItem latest=target("gallery-image");h.select(latest);h.refreshFrameLoadingWindow();h.loadGalleryImage(h.attachedHolders.get(0),latest,0,0);bitmap(h,h.attachedHolders.get(0));require(h.attachedHolders.get(0).cover.bitmap.source.equals(source(latest)),"current gallery source no longer renders");
      }});
      check("close_retains_physical_slots_and_suppresses_publication",()->{
        NativeShortVideoFrameLoader<Bitmap> loader=new NativeShortVideoFrameLoader<>();Gate gate=new Gate();AtomicInteger results=new AtomicInteger();
        loader.offer("held",()->true,()->true,()->{gate.entered.countDown();gate.release.await();return new Bitmap("old");},true,x->results.incrementAndGet());entered(gate);loader.close();require(loader.activeCount()==1,"close faked physical completion");gate.release.countDown();idle(loader);require(results.get()==0,"closed loader delivered a late bitmap");
      });
      check("rerun_publication_window_keeps_pending_budget",()->{
        NativeShortVideoFrameLoader<Bitmap> loader=new NativeShortVideoFrameLoader<>();Gate blocker=new Gate();List<String> executed=Collections.synchronizedList(new ArrayList<>());holdNull=true;
        try{
          loader.offer("block",()->true,()->false,()->{blocker.entered.countDown();blocker.release.await();return new Bitmap("block");},false,x->{});entered(blocker);
          loader.offer("rerun",()->true,()->true,()->null,true,x->{});require(nullReady.await(3,TimeUnit.SECONDS),"actual null publication window did not open");
          for(int i=0;i<6;i++){String key="q"+i;loader.offer(key,()->true,()->false,()->{executed.add(key);return new Bitmap(key);},false,x->{});}
          loader.offer("rerun",()->true,()->true,()->{executed.add("rerun");return new Bitmap("new");},true,x->{});nullResume.countDown();
          synchronized(loader){long end=System.currentTimeMillis()+3000;while(loader.queuedCount()!=0||!executed.contains("rerun")){require(loader.queuedCount()<=6,"rerun expanded pending beyond six");long left=end-System.currentTimeMillis();require(left>0,"rerun did not finish");loader.wait(left);}}
          require(!executed.contains("q0")&&executed.get(0).equals("rerun"),"rerun failed to trim the oldest speculative pending job");
        }finally{holdNull=false;nullResume.countDown();blocker.release.countDown();loader.close();idle(loader);}
      });
      for(boolean throwsRead:List.of(false,true))check("owned_paint_failure_settles_once_"+throwsRead,()->{
        NativeShortVideoFrameLoader<Bitmap> loader=new NativeShortVideoFrameLoader<>();AtomicInteger failures=new AtomicInteger(),success=new AtomicInteger(),prefetchFailures=new AtomicInteger();
        try{
          loader.offer("failed",()->true,()->true,()->{if(throwsRead)throw new IllegalStateException("controlled decode failure");return null;},true,x->success.incrementAndGet(),failures::incrementAndGet);idle(loader);
          require(failures.get()==1&&success.get()==0&&!loader.contains("failed"),"null/throw must notify exactly one paint failure and release its key");
          loader.offer("prefetch-only",()->true,()->false,()->null,false,x->success.incrementAndGet(),prefetchFailures::incrementAndGet);idle(loader);
          require(prefetchFailures.get()==0&&failures.get()==1,"a speculative failure notified the paint UI");
          loader.offer("failed",()->true,()->true,()->new Bitmap("retried"),true,x->success.incrementAndGet(),failures::incrementAndGet);idle(loader);
          require(failures.get()==1&&success.get()==1,"a physical failure poisoned the key or duplicated failure during retry");
        }finally{loader.close();idle(loader);}
      });
      for(boolean started:List.of(false,true))check("prefetch_failure_upgrade_keeps_paint_consumer_"+started,()->{
        NativeShortVideoFrameLoader<Bitmap> loader=new NativeShortVideoFrameLoader<>();Gate left=new Gate(),right=new Gate(),read=new Gate();AtomicInteger reads=new AtomicInteger(),paintFailures=new AtomicInteger(),prefetchFailures=new AtomicInteger(),success=new AtomicInteger();
        try{
          loader.offer("left",()->true,()->false,()->{left.entered.countDown();left.release.await();return new Bitmap("left");},false,x->{});entered(left);
          if(!started){loader.offer("right",()->true,()->false,()->{right.entered.countDown();right.release.await();return new Bitmap("right");},false,x->{});entered(right);}
          loader.offer("shared",()->true,()->false,()->{reads.incrementAndGet();read.entered.countDown();read.release.await();return null;},false,x->{},prefetchFailures::incrementAndGet);
          if(started)entered(read);else require(loader.queuedCount()==1,"initial speculative failure source should be queued");
          loader.offer("shared",()->true,()->true,()->null,true,x->success.incrementAndGet(),paintFailures::incrementAndGet);
          loader.offer("shared",()->true,()->false,()->null,false,x->{},prefetchFailures::incrementAndGet);
          require(loader.activeCount()<=2&&loader.queuedCount()<=6,"failure subscriber upgrade exceeded the physical/pending budget");
          if(!started){left.release.countDown();entered(read);}read.release.countDown();left.release.countDown();right.release.countDown();idle(loader);
          require(reads.get()==1&&paintFailures.get()==1&&prefetchFailures.get()==0&&success.get()==0,"later prefetch replaced the current paint failure consumer or duplicated its singleflight");
        }finally{left.release.countDown();right.release.countDown();read.release.countDown();loader.close();idle(loader);}
      });
      check("retired_failure_settles_without_notifying_ui",()->{
        NativeShortVideoFrameLoader<Bitmap> loader=new NativeShortVideoFrameLoader<>();Gate read=new Gate();AtomicInteger owner=new AtomicInteger(1),settled=new AtomicInteger(),alerts=new AtomicInteger();
        try{
          loader.offer("old",()->owner.get()==1,()->owner.get()==1,()->{read.entered.countDown();read.release.await();return null;},true,x->{},()->{settled.incrementAndGet();if(owner.get()==1)alerts.incrementAndGet();});entered(read);owner.set(2);loader.prune();require(loader.activeCount()==1,"retiring an owner faked physical completion");read.release.countDown();idle(loader);
          require(settled.get()==1&&alerts.get()==0&&!loader.contains("old"),"retired physical failure did not settle once through its captured owner guard");
        }finally{read.release.countDown();loader.close();idle(loader);}
      });
      check("close_suppresses_inflight_failure_and_retains_slot",()->{
        NativeShortVideoFrameLoader<Bitmap> loader=new NativeShortVideoFrameLoader<>();Gate read=new Gate();AtomicInteger failures=new AtomicInteger();
        try{
          loader.offer("old",()->true,()->true,()->{read.entered.countDown();read.release.await();return null;},true,x->{},failures::incrementAndGet);entered(read);loader.close();require(loader.activeCount()==1,"close released a still-running failure read slot");read.release.countDown();idle(loader);require(failures.get()==0,"closed loader notified a late physical failure");
        }finally{read.release.countDown();loader.close();idle(loader);}
      });
      check("ready_null_snapshot_keeps_retry_failure_owner",()->{
        NativeShortVideoFrameLoader<Bitmap> loader=new NativeShortVideoFrameLoader<>();AtomicInteger owner=new AtomicInteger(1),oldSettled=new AtomicInteger(),oldAlerts=new AtomicInteger(),newFailures=new AtomicInteger(),newResults=new AtomicInteger(),reads=new AtomicInteger();holdFailure=true;
        try{
          loader.offer("failure-race",()->true,()->true,()->{reads.incrementAndGet();return null;},true,x->{},()->{oldSettled.incrementAndGet();if(owner.get()==1)oldAlerts.incrementAndGet();});
          require(failureReady.await(3,TimeUnit.SECONDS),"ready-null failure publication window did not open");owner.set(2);
          loader.offer("failure-race",()->true,()->true,()->{reads.incrementAndGet();return new Bitmap("retry-success");},true,x->newResults.incrementAndGet(),newFailures::incrementAndGet);
          require(loader.activeCount()==1&&loader.queuedCount()==0,"same-key retry faked a second physical read before publication settled");failureResume.countDown();idle(loader);
          require(reads.get()==2&&newResults.get()==1,"same-key ready-null retry did not run and deliver its own result");
          require(oldSettled.get()==1&&oldAlerts.get()==0&&newFailures.get()==0,"old ready-null failure was reported through the new retry consumer");
        }finally{holdFailure=false;failureResume.countDown();loader.close();idle(loader);}
      });
      if(!failures.isEmpty())throw new AssertionError(String.join("\\n",failures));System.out.println("native-short-video-frame-loading: "+cases+" actual bounded worker/window/promotion/foreground cases passed");
    }
  }`;

function compile(name, controllerCode = controller) {
  const folder = path.join(temp, name, "local/fanhao/library"); fs.mkdirSync(folder, { recursive: true });
  const probe = path.join(folder, "FrameLoadingProbe.java"), loader = path.join(folder, "NativeShortVideoFrameLoader.java");
  fs.writeFileSync(probe, java);
  // A single publication gate exposes ready-null -> reoffer -> finally without
  // changing dispatch/ownership/budget code or pretending a decoder has ended.
  const instrumented = controllerCode.replace("      if (value != null && delivery != null)", "      if (value == null) FrameLoadingProbe.blockNullPublication(task.key);\n      if (value != null && delivery != null)");
  assert.notEqual(instrumented, controllerCode, "publication gate anchor"); fs.writeFileSync(loader, instrumented);
  const readiness = path.join(root, "android-client/android/app/src/main/java/local/fanhao/library/NativeShortVideoGalleryImageReadiness.java");
  const compiled = spawnSync(executable("javac"), ["-encoding", "UTF-8", "-d", path.join(temp, name), probe, loader, readiness], { encoding: "utf8", timeout: 30000 });
  assert.equal(compiled.status, 0, compiled.stderr); return path.join(temp, name);
}
function run(folder, name = "all") { return spawnSync(executable("java"), ["-cp", folder, "local.fanhao.library.FrameLoadingProbe", name], { encoding: "utf8", timeout: 45000 }); }
try {
  const passed = run(compile("current")); assert.equal(passed.status, 0, passed.stderr); process.stdout.write(passed.stdout);
  const fifo = controller.replace("for (Task candidate : pending) if (test(candidate.current)) { next = candidate; break; }", ""); assert.notEqual(fifo, controller);
  const rejected = run(compile("fifo", fifo), "bounded_latest_current_first"); assert.equal(rejected.status, 1); assert.match(rejected.stderr, /newest current source/);
  const noDelivery = controller.replace("if (paints || !task.paints) { task.complete = complete; task.failed = failed; task.paints = paints; }", ""); assert.notEqual(noDelivery, controller);
  const missing = run(compile("no-paint-upgrade", noDelivery), "prefetch_promotes_and_delivers_gallery-image_true"); assert.equal(missing.status, 1); assert.match(missing.stderr, /prefetch_promotes_and_delivers_gallery-image_true/);
  const lateFailure = controller.replace("failure = !closed && readStarted && task.paints ? task.failed : null;", "failure = !closed && readStarted && task.paints ? () -> { Runnable latest; synchronized (this) { latest = task.failed; } if (latest != null) latest.run(); } : null;");
  assert.notEqual(lateFailure, controller, "late failure consumer read mutation anchor");
  const wrongAttempt = run(compile("late-failure-owner", lateFailure), "ready_null_snapshot_keeps_retry_failure_owner");assert.equal(wrongAttempt.status, 1);assert.match(wrongAttempt.stderr, /old ready-null failure was reported through the new retry consumer/);
  console.log("native-short-video-frame-loading: FIFO-priority, missing-gallery-delivery and late-failure-owner negative controls rejected");
} finally {
  const resolved = fs.realpathSync(temp); assert.equal(path.dirname(resolved), fs.realpathSync(os.tmpdir()));assert(path.basename(resolved).startsWith("fanhao-native-cover-ownership-"));
  const cleanup = spawnSync("powershell.exe", ["-NoProfile", "-Command", `Remove-Item -LiteralPath '${resolved.replace(/'/g, "''")}' -Recurse -Force`], { encoding: "utf8", timeout: 10000 }); assert.equal(cleanup.status, 0, cleanup.stderr);
}
