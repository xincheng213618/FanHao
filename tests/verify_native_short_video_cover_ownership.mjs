import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

// Actual Activity cover/extracted-frame/cache methods, four real Java workers
// and a controlled decode latch. Bitmap/Android leaves contain synthetic labels;
// no browser, device, codec, network, real media, database or service is used.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const activity = fs.readFileSync(path.join(root, "android-client/android/app/src/main/java/local/fanhao/library/NativeShortVideoActivity.java"), "utf8").replace(/\r\n/g, "\n");
const take = (name, optional = false) => {
  if (name === "requestFrame") {
    const methods = [...activity.matchAll(/  private void requestFrame\([^)]*\) \{[\s\S]*?\n  \}/g)].map(value=>value[0].replace("private ",""));
    assert(methods.length === 2, "requestFrame optional failure overloads"); return methods.join("\n");
  }
  const method = activity.match(new RegExp(`  private [^\\n]+ ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n  \\}`))?.[0];
  assert(optional || method, name); return method?.replace("private ", "") || "";
};
const implementation = [take("normalVideoFrameKey", true), take("isBoundVideoFrame", true), take("applyLoadedVideoFrame", true), take("requestFrame"),
  ...["bindFrame", "applyCachedFrame", "applyVideoFrame", "loadCover"].map(name => take(name))].join("\n");
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "fanhao-native-cover-ownership-"));
const javaHome = process.env.JAVA_HOME || "C:/Program Files/Android/openjdk/jdk-21.0.8";
const executable = name => fs.existsSync(path.join(javaHome, "bin", `${name}.exe`)) ? path.join(javaHome, "bin", `${name}.exe`) : name;
const harness = `package local.fanhao.library;
  import java.util.*; import java.util.concurrent.*; import java.util.concurrent.atomic.AtomicInteger; import java.util.function.*;
  public final class CoverOwnerProbe implements AutoCloseable {
    static class View {static final int GONE=8,VISIBLE=0;int visibility;void setVisibility(int value){visibility=value;}}
    static final class Bitmap {final String source;Bitmap(String source){this.source=source;}public String toString(){return source;}}
    static final class ImageView extends View {enum ScaleType {FIT_CENTER,CENTER_CROP}Bitmap bitmap;void setImageBitmap(Bitmap value){bitmap=value;}void setScaleType(ScaleType value){}}
    static final class ShortVideoHolder {final int index;final ImageView cover=new ImageView(),videoBackdrop=new ImageView();ShortVideoHolder(int index){this.index=index;}}
    static final class ShortVideoItem {
      final String id,streamUrl,coverUrl;boolean gallery;
      ShortVideoItem(String id,String source,boolean cover){this.id=id;streamUrl="stream:"+source;coverUrl=cover?"cover:"+source:"";}
      boolean isGallery(){return gallery;}
    }
    static final class UiQueue {
      final List<Runnable> pending=new ArrayList<>();
      synchronized void post(Runnable task){pending.add(task);notifyAll();}
      synchronized void awaitReply()throws Exception {long end=System.currentTimeMillis()+3000;while(pending.isEmpty()){long left=end-System.currentTimeMillis();if(left<=0)throw new AssertionError("missing decode reply");wait(left);}}
      void drain(){List<Runnable> batch;synchronized(this){batch=new ArrayList<>(pending);pending.clear();}for(Runnable task:batch)task.run();}
    }
    final ExecutorService executor=Executors.newFixedThreadPool(4);
    final NativeShortVideoFrameLoader<Bitmap> frameLoading=new NativeShortVideoFrameLoader<>(executor);
    // Viewer-window scheduling has its own actual integration suite. This
    // fixture keeps every synthetic source eligible to isolate paint/cache.
    static final class FrameLoadingWindow {final Set<String> wanted;final String current;FrameLoadingWindow(Set<String> wanted,String current){this.wanted=wanted;this.current=current;}}
    volatile FrameLoadingWindow frameLoadingWindow=new FrameLoadingWindow(new AbstractSet<String>(){
      public boolean contains(Object value){return true;}public int size(){return 0;}public Iterator<String> iterator(){return Collections.emptyIterator();}
    },"");
    void refreshFrameLoadingWindow(){}
    final UiQueue mainHandler=new UiQueue();
    final CountDownLatch oldStarted=new CountDownLatch(1),releaseOld=new CountDownLatch(1);
    final CountDownLatch newStarted=new CountDownLatch(1),releaseNew=new CountDownLatch(1);
    final Set<String> pendingFrameIds=Collections.synchronizedSet(new HashSet<>());
    final Map<String,Bitmap> frameCache=new ConcurrentHashMap<>();
    final List<ShortVideoItem> videos=new ArrayList<>();
    final Map<Integer,ShortVideoHolder> attachedHolders=new HashMap<>();
    final Map<String,Integer> galleryPositions=new HashMap<>();
    final AtomicInteger decodes=new AtomicInteger();
    static final int PLAYER_COVER_MAX_WIDTH=720,PLAYER_COVER_MAX_HEIGHT=1280;
    volatile boolean destroying,holdNew;boolean videoFitMode;int galleryBinds,galleryPrewarms;
    Bitmap decode(String source){
      decodes.incrementAndGet();
      if(source.endsWith("old")){oldStarted.countDown();try{if(!releaseOld.await(3,TimeUnit.SECONDS))throw new AssertionError("old decode not released");}catch(InterruptedException error){Thread.currentThread().interrupt();throw new RuntimeException(error);}}
      if(source.endsWith("new")&&holdNew){newStarted.countDown();try{if(!releaseNew.await(3,TimeUnit.SECONDS))throw new AssertionError("new decode not released");}catch(InterruptedException error){Thread.currentThread().interrupt();throw new RuntimeException(error);}}
      return source.endsWith("fail")?null:new Bitmap(source);
    }
    Bitmap loadBitmap(String source,int width,int height){return decode(source);}
    Bitmap extractFirstFrame(String source){return decode(source);}
    void bindGallery(ShortVideoHolder holder,ShortVideoItem item,int mediaIndex,int direction){galleryBinds++;}
    void prefetchGalleryMedia(ShortVideoItem item,int mediaIndex){galleryPrewarms++;}
    ${implementation}
    void select(ShortVideoItem item){videos.clear();videos.add(item);attachedHolders.clear();attachedHolders.put(0,new ShortVideoHolder(0));}
    void reply()throws Exception{mainHandler.awaitReply();mainHandler.drain();}
    void waitOld()throws Exception{require(oldStarted.await(3,TimeUnit.SECONDS),"actual old worker must be in flight");}
    public void close()throws Exception{releaseOld.countDown();releaseNew.countDown();frameLoading.close();executor.shutdownNow();require(executor.awaitTermination(3,TimeUnit.SECONDS),"physical Java workers failed to drain");}
    static final List<String> failures=new ArrayList<>();static int cases;static String selected;
    interface Case {void run()throws Exception;}
    static void check(String name,Case test){if(!selected.equals("all")&&!selected.equals(name))return;cases++;try{test.run();}catch(Throwable error){failures.add(name+": "+error.getMessage());}}
    static void require(boolean condition,String message){if(!condition)throw new AssertionError(message);}
    public static void main(String[] args)throws Exception {
      selected=args.length==0?"all":args[0];
      for(boolean cover:List.of(false,true)) {
        check("late_other_item_"+cover,()->{try(CoverOwnerProbe h=new CoverOwnerProbe()){
          h.select(new ShortVideoItem("A","old",cover));h.bindFrame(0);h.waitOld();
          ShortVideoItem current=new ShortVideoItem("B","new",cover);h.select(current);ShortVideoHolder holder=h.attachedHolders.get(0);
          h.bindFrame(0);h.reply();Bitmap fresh=holder.cover.bitmap;require(fresh!=null&&fresh.source.endsWith("new"),"B must paint before old A finishes");
          h.releaseOld.countDown();h.reply();require(holder.cover.bitmap==fresh,"late A painted the current B holder");
          require(h.applyCachedFrame(holder,current)&&holder.cover.bitmap==fresh,"late A corrupted B's cache hit");
        }});
        check("same_id_source_cache_"+cover,()->{try(CoverOwnerProbe h=new CoverOwnerProbe()){
          h.select(new ShortVideoItem("same","old",cover));h.bindFrame(0);h.waitOld();
          ShortVideoItem current=new ShortVideoItem("same","new",cover);h.select(current);ShortVideoHolder holder=h.attachedHolders.get(0);
          h.releaseOld.countDown();h.reply();holder.cover.bitmap=null;
          require(!h.applyCachedFrame(holder,current)&&holder.cover.bitmap==null,"old-source cache was reused for the same id with a new source");
          h.bindFrame(0);h.reply();require(holder.cover.bitmap!=null&&holder.cover.bitmap.source.endsWith("new"),"new source must still load and paint");
        }});
        check("same_id_parallel_new_source_"+cover,()->{try(CoverOwnerProbe h=new CoverOwnerProbe()){
          h.select(new ShortVideoItem("same","old",cover));h.bindFrame(0);h.waitOld();
          h.holdNew=true;ShortVideoItem current=new ShortVideoItem("same","new",cover);h.select(current);ShortVideoHolder holder=h.attachedHolders.get(0);h.bindFrame(0);
          require(h.frameLoading.activeCount()+h.frameLoading.queuedCount()==2,"pending old source blocked the same id's new source");
          require(h.newStarted.await(3,TimeUnit.SECONDS),"same-id new source must get its own worker");h.releaseNew.countDown();
          h.reply();Bitmap fresh=holder.cover.bitmap;h.releaseOld.countDown();h.reply();
          require(fresh!=null&&fresh.source.endsWith("new")&&holder.cover.bitmap==fresh,"late same-id source replaced the fresh bitmap");
        }});
        check("same_source_reuses_cache_"+cover,()->{try(CoverOwnerProbe h=new CoverOwnerProbe()){
          h.select(new ShortVideoItem("same","unchanged",cover));h.bindFrame(0);h.reply();Bitmap first=h.attachedHolders.get(0).cover.bitmap;
          ShortVideoItem replacement=new ShortVideoItem("same","unchanged",cover);h.select(replacement);
          require(h.applyCachedFrame(h.attachedHolders.get(0),replacement)&&h.attachedHolders.get(0).cover.bitmap==first,"legitimate unchanged source lost its cache hit");
          h.bindFrame(0);require(h.decodes.get()==1,"unchanged source started another decode");
        }});
        check("pending_same_source_refresh_shares_result_"+cover,()->{try(CoverOwnerProbe h=new CoverOwnerProbe()){
          h.select(new ShortVideoItem("same","old",cover));h.bindFrame(0);h.waitOld();
          ShortVideoItem refreshed=new ShortVideoItem("same","old",cover);h.select(refreshed);ShortVideoHolder holder=h.attachedHolders.get(0);h.bindFrame(0);
          require(h.frameLoading.activeCount()+h.frameLoading.queuedCount()==1,"unchanged source failed to share its pending decode");
          h.releaseOld.countDown();h.reply();require(holder.cover.bitmap!=null&&h.applyCachedFrame(holder,refreshed),"refreshed current record never received its legitimate shared bitmap");
          require(h.decodes.get()==1,"metadata refresh decoded an identical source again");
        }});
        check("destroyed_reply_"+cover,()->{try(CoverOwnerProbe h=new CoverOwnerProbe()){
          h.select(new ShortVideoItem("A","old",cover));h.bindFrame(0);h.waitOld();ShortVideoHolder holder=h.attachedHolders.get(0);
          h.destroying=true;h.releaseOld.countDown();h.executor.shutdown();require(h.executor.awaitTermination(3,TimeUnit.SECONDS),"destroyed read did not physically finish");h.mainHandler.drain();require(holder.cover.bitmap==null,"destroyed Activity painted a late bitmap");
        }});
      }
      check("retired_holder_and_item_cannot_paint",()->{try(CoverOwnerProbe h=new CoverOwnerProbe()){
        ShortVideoItem first=new ShortVideoItem("same","one",true);h.select(first);ShortVideoHolder retired=h.attachedHolders.get(0);
        h.attachedHolders.put(0,new ShortVideoHolder(0));h.applyVideoFrame(retired,first,new Bitmap("retired"));require(retired.cover.bitmap==null,"retired holder accepted a bitmap");
        ShortVideoItem replacement=new ShortVideoItem("same","two",true);h.videos.set(0,replacement);ShortVideoHolder current=h.attachedHolders.get(0);
        h.applyVideoFrame(current,first,new Bitmap("old-source"));require(current.cover.bitmap==null,"replaced same-id item accepted an old body");
        h.applyVideoFrame(new ShortVideoHolder(-1),replacement,new Bitmap("invalid"));
      }});
      check("neighbor_cover_cache_remains_legal",()->{try(CoverOwnerProbe h=new CoverOwnerProbe()){
        ShortVideoItem current=new ShortVideoItem("current","current",true),neighbor=new ShortVideoItem("neighbor","neighbor",true);h.select(current);h.videos.add(neighbor);
        h.bindFrame(1);h.reply();h.attachedHolders.put(1,new ShortVideoHolder(1));
        require(h.applyCachedFrame(h.attachedHolders.get(1),neighbor)&&h.attachedHolders.get(1).cover.bitmap.source.endsWith("neighbor"),"a legitimate neighbor lost its preloaded cache");
      }});
      check("cached_cover_never_reveals_over_rendered_video",()->{try(CoverOwnerProbe h=new CoverOwnerProbe()){
        ShortVideoItem item=new ShortVideoItem("current","current",true);h.select(item);ShortVideoHolder holder=h.attachedHolders.get(0);holder.cover.setVisibility(View.GONE);
        h.bindFrame(0);h.reply();require(holder.cover.visibility==View.GONE,"late valid poster covered an already rendered video frame");
      }});
      check("gallery_keeps_its_own_binding_path",()->{try(CoverOwnerProbe h=new CoverOwnerProbe()){
        ShortVideoItem item=new ShortVideoItem("gallery","gallery",true);item.gallery=true;h.select(item);h.bindFrame(0);h.attachedHolders.clear();h.bindFrame(0);
        require(h.galleryBinds==1&&h.galleryPrewarms==1&&h.decodes.get()==0,"normal cover ownership changed gallery loading");
      }});
      check("null_decode_releases_pending_owner",()->{try(CoverOwnerProbe h=new CoverOwnerProbe()){
        ShortVideoItem item=new ShortVideoItem("fail","fail",true);h.select(item);h.bindFrame(0);h.executor.shutdown();require(h.executor.awaitTermination(3,TimeUnit.SECONDS),"decode did not finish");
        require(h.frameLoading.activeCount()==0&&h.frameLoading.queuedCount()==0&&h.frameCache.isEmpty(),"failed decode retained a pending/cache entry");
      }});
      if(!failures.isEmpty())throw new AssertionError(String.join("\\n",failures));require(cases>0,"unknown case");
      System.out.println("native-short-video-cover-ownership: "+cases+" actual async cover/cache ownership cases passed");
    }
  }`;
function compile(name, code) {
  const folder = path.join(temp, name, "local/fanhao/library"), target = path.join(folder, "CoverOwnerProbe.java");
  fs.mkdirSync(folder, { recursive: true }); fs.writeFileSync(target, code);
  const result = spawnSync(executable("javac"), ["-encoding", "UTF-8", "-d", path.join(temp, name), target,
    path.join(root, "android-client/android/app/src/main/java/local/fanhao/library/NativeShortVideoFrameLoader.java")], { encoding: "utf8", timeout: 30000 });
  assert.equal(result.status, 0, result.stderr); return path.join(temp, name);
}
function run(folder, name = "all") {
  return spawnSync(executable("java"), ["-cp", folder, "local.fanhao.library.CoverOwnerProbe", name], { encoding: "utf8", timeout: 30000 });
}
try {
  const current = run(compile("current", harness)); assert.equal(current.status, 0, current.stderr); process.stdout.write(current.stdout);
  const noOwner = harness.replace("if (bitmap == null || !isBoundVideoFrame(holder, item)) return;", "if (holder == null || item == null || bitmap == null) return;");
  assert.notEqual(noOwner, harness, "paint guard mutation anchor");
  const stale = run(compile("no-owner", noOwner), "retired_holder_and_item_cannot_paint"); assert.equal(stale.status, 1); assert.match(stale.stderr, /retired_holder_and_item_cannot_paint/);
  const noLoadedSource = harness.replace("if (!frameKey.equals(normalVideoFrameKey(current))) return;", ""); assert.notEqual(noLoadedSource, harness, "late loaded source mutation anchor");
  const late = run(compile("no-loaded-source", noLoadedSource), "late_other_item_true"); assert.equal(late.status, 1); assert.match(late.stderr, /late_other_item_true/);
  const noSource = harness.replace(/return "video-frame:"[^;]+;/, "return item.id;"); assert.notEqual(noSource, harness, "source key mutation anchor");
  const poisoned = run(compile("no-source", noSource), "same_id_source_cache_true"); assert.equal(poisoned.status, 1); assert.match(poisoned.stderr, /same_id_source_cache_true/);
  console.log("native-short-video-cover-ownership: retired-holder, stale-source paint and same-id cache-poisoning negative controls rejected");
} finally {
  const resolved = fs.realpathSync(temp); assert.equal(path.dirname(resolved), fs.realpathSync(os.tmpdir()));
  assert(path.basename(resolved).startsWith("fanhao-native-cover-ownership-"));
  const cleanup = spawnSync("powershell.exe", ["-NoProfile", "-Command", `Remove-Item -LiteralPath '${resolved.replace(/'/g, "''")}' -Recurse -Force`], { encoding: "utf8", timeout: 10000 });
  assert.equal(cleanup.status, 0, cleanup.stderr);
}
