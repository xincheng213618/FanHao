import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// Real Activity scheduling/cancel/lifecycle/cache-release code and real
// controller. CacheWriter deliberately models cooperative cancel: cancel()
// marks a flag but never releases an in-progress read or closes its DataSource.
// All bytes/cache contents are doubles; no device, network or real cache.
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"..");
const native=path.join(root,"android-client/android/app/src/main/java/local/fanhao/library");
const source=fs.readFileSync(path.join(native,"NativeShortVideoActivity.java"),"utf8").replace(/\r\n/g,"\n");
const controller=fs.readFileSync(path.join(native,"NativeShortVideoPrefetchController.java"),"utf8").replace(/\r\n/g,"\n");
function member(name){const found=new RegExp(`^  (?:private|protected) [^\\n]* ${name}\\([^\\n]*`,"m").exec(source);assert(found,name);const first=source.indexOf("{",found.index);let pos=first+1,depth=1;for(;pos<source.length&&depth;pos++){if(source[pos]==="{")depth++;else if(source[pos]==="}")depth--;}return source.slice(found.index,pos);}
const binding=member("bindSelectedPlaybackAt");const holderBoundary=binding.indexOf("    ShortVideoHolder holder");assert(holderBoundary>0,"binding cancellation must precede holder lookup");const selectPrelude=binding.slice(0,holderBoundary);
const feedPrelude=member("resetFeedScreen").slice(0,member("resetFeedScreen").indexOf("    releaseAllPlayers();"));
const authorPrelude=member("renderAuthorScreen").slice(0,member("renderAuthorScreen").indexOf("    applyCanonicalActionSnapshots(screen);"));
const methods=["scheduleVideoPrefetch","cancelVideoPrefetch","stopVideoPrefetch","releaseVideoCache","onPause","onResume","preparePlayersAround"].map(member).join("\n");
const resourceStart=source.indexOf("  private static final class VideoCacheResource {");
assert(resourceStart>=0);const resource=source.slice(resourceStart,source.indexOf("\n  }",resourceStart)+4);
const temporary=fs.mkdtempSync(path.join(os.tmpdir(),"fanhao-native-prefetch-"));
const javaHome=process.env.JAVA_HOME||"C:/Program Files/Android/openjdk/jdk-21.0.8";
function compileAndRun(label,controllerSource,activityMethods) {
  const directory=path.join(temporary,label);fs.mkdirSync(directory,{recursive:true});
  const controllerPath=path.join(directory,"NativeShortVideoPrefetchController.java");fs.writeFileSync(controllerPath,controllerSource);
  const javaFile=path.join(directory,"NativePrefetchHarness.java");
  fs.writeFileSync(javaFile,`package local.fanhao.library;
import java.util.*;import java.util.concurrent.*;import java.util.concurrent.atomic.*;
public final class NativePrefetchHarness extends Base {
  private final NativeShortVideoPrefetchController videoPrefetch=new NativeShortVideoPrefetchController();
  private volatile long videoPrefetchGeneration;private volatile String videoPrefetchOwner="";
  volatile boolean destroying,activityResumed=true;volatile int currentIndex=0;
  boolean pausedForLifecycle,resumePlaybackAfterPause;Object authorOverlay;int gallerySoundFeedIndex=-1;
  final Handler mainHandler=new Handler();
  SimpleCache videoCache=new SimpleCache();CacheDataSource.Factory videoCacheDataSourceFactory=new CacheDataSource.Factory(videoCache);
  NativeShortVideoCacheLifecycle<VideoCacheResource> videoCacheLifecycle;
  final List<ShortVideoItem> videos=new ArrayList<>();final Map<Integer,ExoPlayer> playerCache=new HashMap<>();
  final FeedPlayback feedPlayback=new FeedPlayback();final ExoPlayer activePlayer=new ExoPlayer();ExoPlayer gallerySegmentPlayer,gallerySoundPlayer;
  static final String TAG="fixture";static final long NEXT_VIDEO_PREFETCH_BYTES=4L*1024L*1024L;
  final Fallback playbackFallback=new Fallback();
  NativePrefetchHarness(){for(int i=0;i<10;i++)videos.add(new ShortVideoItem("v"+i));playerCache.put(0,activePlayer);CountDownLatch ready=new CountDownLatch(1);videoCacheLifecycle=new NativeShortVideoCacheLifecycle<>(()->new VideoCacheResource(videoCache,videoCacheDataSourceFactory),VideoCacheResource::release,value->ready.countDown(),error->{throw new AssertionError(error);},()->0L);videoCacheLifecycle.requestInitialization();try{check(ready.await(2,TimeUnit.SECONDS),"primed cache fixture ready");}catch(InterruptedException error){throw new RuntimeException(error);}}
  Uri cachedMediaUri(String url){return new Uri(url+"?fhcache=1");}
  void cancelProgressSeek(){}void clearPendingStageTap(){}void cancelGalleryAutoAdvance(){}void stopSystemInfoUpdates(){}void stopProgressUpdates(){}
  void hideSystemBars(){}void startSystemInfoUpdates(){}boolean commentsOpen(){return false;}boolean feedSearchOpen(){return false;}boolean isFinishing(){return false;}
  void startActivePlaybackIfVisible(){}void updateActiveProgress(){}void resumeGalleryAutoAdvanceIfNeeded(){}void loadMoreIfNeeded(int index){}void preparePlayerAt(int index){}void releaseDistantPlayers(int index){}
  void invalidateGallerySearchAdvance(int index){}void applyCanonicalActionSnapshots(Object screen){}void feedRequestsCancel(){}
  void refreshFrameLoadingWindow(){}void pauseFrameLoading(){}void resumeFrameLoading(){}
  Object checkpointLifecyclePlayback,checkpointLifecycleItem;void rememberCheckpointLifecycle(){}void refreshScreenAwake(){}
  // This transport fixture is unmanaged; session ownership has its own actual
  // Plugin/Registry/Native verifier and does not alter prefetch lifecycle intent.
  static class SessionBoundary{boolean resumed(){return true;}}SessionBoundary nativeSession;
  void cancelStageGestures(){}
  void pauseSelectedPlaybackRequest(){}void flushSelectedPlaybackRequest(){}
  void cancelGalleryContinuation(){}void pauseGalleryContinuation(){}boolean flushGalleryContinuation(){return false;}
  final Requests feedRequests=new Requests();static class Requests{void cancel(){}}
  static class AuthorScreenState{}static class FeedScreenState{}
  ${selectPrelude} }
  ${feedPrelude} }
  ${authorPrelude} }
  ${resource}
  ${activityMethods}
  void select(int index){bindSelectedPlaybackAt(index);scheduleVideoPrefetch(index+1);}
  void pause(){onPause();}void resume(){onResume();mainHandler.runPending();}
  static void check(boolean value,String message){if(!value)throw new AssertionError(message);}
  static void waitFor(java.util.function.BooleanSupplier condition,String message)throws Exception{long end=System.nanoTime()+TimeUnit.SECONDS.toNanos(3);while(!condition.getAsBoolean()&&System.nanoTime()<end)Thread.sleep(2);check(condition.getAsBoolean(),message);}
  static void idle(NativePrefetchHarness host)throws Exception{waitFor(()->host.videoPrefetch.activeCount()==0&&host.videoPrefetch.queuedCount()==0,"physical prefetch drain");}
  static CacheWriter writer(int index)throws Exception{waitFor(()->CacheWriter.writers.size()>index,"writer "+index+" created");CacheWriter value=CacheWriter.writers.get(index);check(value.entered.await(2,TimeUnit.SECONDS),"writer entered blocked cache read");return value;}
  static void finish(CacheWriter writer){writer.finish.countDown();}
  static void cleanup(NativePrefetchHarness host)throws Exception{host.destroying=true;host.stopVideoPrefetch();for(CacheWriter writer:CacheWriter.writers)finish(writer);idle(host);CacheWriter.writers.clear();CacheWriter.activeByUrl.clear();}
  public static void main(String[] args)throws Exception{
    int checks=0;
    {
      NativePrefetchHarness host=new NativePrefetchHarness();try{
        host.scheduleVideoPrefetch(1);CacheWriter old=writer(0);host.select(2);CacheWriter latest=writer(1);
        check(old.cancelled,"switch cancels old writer cooperatively");check(!latest.cancelled,"latest different URL owns work");
        check(old.finish.getCount()==1,"cancel does not pretend to finish a blocked read");check(host.videoPrefetch.activeCount()==2,"cancelled physical read retains its slot");
        check(latest.uri.contains("v3"),"latest next item starts without waiting for one old blocked URL");checks++;
        host.select(4);host.select(6);check(host.videoPrefetch.activeCount()==2&&host.videoPrefetch.queuedCount()==1,"two physical plus only latest queued");
        check(CacheWriter.writers.size()==2,"queued obsolete v5 has not created media work");finish(old);CacheWriter queued=writer(2);
        check(queued.uri.contains("v7"),"only latest v7 dispatches after a physical slot frees");
        check(CacheWriter.writers.stream().noneMatch(value->value.uri.contains("v5")),"superseded queued work never creates writer");checks++;
      }finally{cleanup(host);}
    }
    for(String replacement:new String[]{"gallery","no-source","end","deleted-next"}){
      NativePrefetchHarness host=new NativePrefetchHarness();try{
        host.scheduleVideoPrefetch(1);CacheWriter old=writer(0);
        if(replacement.equals("gallery"))host.videos.get(1).gallery=true;
        else if(replacement.equals("no-source"))host.videos.get(1).streamUrl="";
        else if(replacement.equals("end"))host.videos.subList(1,host.videos.size()).clear();
        else host.videos.remove(1);
        host.scheduleVideoPrefetch(1);
        check(old.cancelled,"current next replacement must retire its former writer: "+replacement);
        if(replacement.equals("deleted-next")){CacheWriter next=writer(1);check(next.uri.contains("v2"),"surviving next id owns replacement URL");}
        else{Thread.sleep(15);check(CacheWriter.writers.size()==1&&host.videoPrefetch.queuedCount()==0,"no candidate does not retain old work");}
        checks++;
      }finally{cleanup(host);}
    }
    {
      NativePrefetchHarness host=new NativePrefetchHarness();try{
        host.select(2);CacheWriter current=writer(0);host.scheduleVideoPrefetch(1);host.scheduleVideoPrefetch(2);
        check(!current.cancelled,"a stale non-next index callback cannot cancel newer current work");checks++;
      }finally{cleanup(host);}
    }
    {
      NativePrefetchHarness host=new NativePrefetchHarness();try{
        host.scheduleVideoPrefetch(1);CacheWriter old=writer(0);long before=System.nanoTime();host.pause();
        check(TimeUnit.NANOSECONDS.toMillis(System.nanoTime()-before)<100,"onPause must not wait for network");check(old.cancelled,"pause cancels in-flight speculative writer");
        check(host.videoPrefetch.activeCount()==1,"paused blocked read remains physical until it returns");host.scheduleVideoPrefetch(1);Thread.sleep(25);
        check(CacheWriter.writers.size()==1&&host.videoPrefetch.queuedCount()==0,"background must not dispatch or queue new speculative work");
        finish(old);idle(host);check(CacheWriter.writers.size()==1,"old completion cannot start background replacement");checks++;
        host.resume();CacheWriter resumed=writer(1);check(!resumed.cancelled,"normal cancellation leaves controller reusable on resume");checks++;
      }finally{cleanup(host);}
    }
    {
      NativePrefetchHarness host=new NativePrefetchHarness();try{
        host.scheduleVideoPrefetch(1);CacheWriter old=writer(0);host.pause();host.resume();Thread.sleep(25);
        check(host.videoPrefetch.activeCount()==1&&host.videoPrefetch.queuedCount()==1,"same URL replacement waits for cancelled physical owner");check(CacheWriter.writers.size()==1,"same URL writers never overlap");
        finish(old);writer(1);check(CacheWriter.maxSameUrl.get()==1,"cache URL mutex survives cancel/resume");checks++;
      }finally{cleanup(host);}
    }
    {
      NativePrefetchHarness host=new NativePrefetchHarness();try{
        host.scheduleVideoPrefetch(1);CacheWriter first=writer(0);host.scheduleVideoPrefetch(1);Thread.sleep(15);check(CacheWriter.writers.size()==1,"same owner coalesces");
        finish(first);idle(host);check(first.length==4L*1024L*1024L,"maximum requested range remains four MiB");
        host.scheduleVideoPrefetch(1);idle(host);check(CacheWriter.writers.size()==1,"verified cached bytes skip a completed URL");checks++;
        host.videoCache.bytes.clear();host.scheduleVideoPrefetch(1);CacheWriter evicted=writer(1);check(evicted.uri.equals(first.uri),"evicted same URL is eligible again");finish(evicted);idle(host);checks++;
        host.playbackFallback.urls.put("v1","/compat/v1.mp4");host.scheduleVideoPrefetch(1);CacheWriter fallback=writer(2);check(fallback.uri.contains("/compat/"),"same id fallback URL gets its own cache identity");finish(fallback);idle(host);checks++;
        host.videos.get(1).streamUrl="/updated/v1.mp4";host.playbackFallback.urls.clear();host.scheduleVideoPrefetch(1);CacheWriter changed=writer(3);check(changed.uri.contains("/updated/"),"same id changed source is not a permanent completed-id hit");checks++;
      }finally{cleanup(host);}
    }
    {
      NativePrefetchHarness host=new NativePrefetchHarness();try{
        String key=host.cachedMediaUri("/v1.mp4").toString();host.videoCache.lengths.put(key,700L);host.videoCache.bytes.put(key,700L);host.scheduleVideoPrefetch(1);idle(host);
        check(CacheWriter.writers.isEmpty(),"known short media only requires its actual cached length");host.videoCache.bytes.remove(key);host.scheduleVideoPrefetch(1);writer(0);checks++;
      }finally{cleanup(host);}
    }
    for(boolean author:new boolean[]{false,true}){
      NativePrefetchHarness host=new NativePrefetchHarness();try{
        host.scheduleVideoPrefetch(1);CacheWriter old=writer(0);if(author)host.renderAuthorScreen(new AuthorScreenState());else host.resetFeedScreen(new FeedScreenState(),true);
        check(old.cancelled,"feed/author ownership hook cancels old writer");check(host.videoPrefetch.queuedCount()==0,"feed/author does not retain queued intent");checks++;
      }finally{cleanup(host);}
    }
    {
      NativePrefetchHarness host=new NativePrefetchHarness();SimpleCache cache=host.videoCache;try{
        host.scheduleVideoPrefetch(1);CacheWriter old=writer(0);long before=System.nanoTime();host.stopVideoPrefetch();host.releaseVideoCache();
        check(TimeUnit.NANOSECONDS.toMillis(System.nanoTime()-before)<100,"destroy/cache release does not await blocked network");
        check(host.videoCacheLifecycle==null,"destroy disconnects new cache users immediately");check(cache.releases.get()==0,"cache cannot release while its writer is physical");
        finish(old);waitFor(()->cache.releases.get()==1,"cache release only after writer returns");check(!cache.releaseThread.equals(Thread.currentThread().getName()),"cache release is off UI thread");
        check(CacheWriter.activeByUrl.values().stream().allMatch(value->value.get()==0),"no cache release while writer accesses spans");checks++;
      }finally{cleanup(host);}
    }
    {
      NativePrefetchHarness host=new NativePrefetchHarness();try{
        host.scheduleVideoPrefetch(0);host.scheduleVideoPrefetch(2);host.activityResumed=false;host.scheduleVideoPrefetch(1);Thread.sleep(15);
        check(CacheWriter.writers.isEmpty(),"non-next indices and background callbacks cannot create speculative data sources");checks++;
      }finally{cleanup(host);}
    }
    System.out.println("native-short-video-prefetch: "+checks+" actual controller/Activity owner, physical2+latest1, URL mutex, cache/source, cooperative cancellation and drain cases passed");
  }
}
class Base{protected void onPause(){}protected void onResume(){}}
class Handler{final List<Runnable> jobs=new ArrayList<>();void post(Runnable job){jobs.add(job);}void runPending(){List<Runnable> batch=new ArrayList<>(jobs);jobs.clear();batch.forEach(Runnable::run);}}
class ShortVideoItem{final String id;String streamUrl;boolean gallery;ShortVideoItem(String id){this.id=id;streamUrl="/"+id+".mp4";}boolean isGallery(){return gallery;}}
class Uri{final String value;Uri(String value){this.value=value;}public String toString(){return value;}}
class DataSpec{static final int FLAG_ALLOW_CACHE_FRAGMENTATION=1,FLAG_MIGHT_NOT_USE_FULL_NETWORK_SPEED=2;Uri uri;long length;static class Builder{final DataSpec value=new DataSpec();Builder setUri(Uri uri){value.uri=uri;return this;}Builder setLength(long length){value.length=length;return this;}Builder setFlags(int flags){return this;}DataSpec build(){return value;}}}
class CacheKeyFactory{static final CacheKeyFactory DEFAULT=new CacheKeyFactory();String buildCacheKey(DataSpec spec){return spec.uri.toString();}}
class ContentMetadata{final long length;ContentMetadata(long value){length=value;}static long getContentLength(ContentMetadata value){return value.length;}}
class SimpleCache{final Map<String,Long> bytes=new ConcurrentHashMap<>(),lengths=new ConcurrentHashMap<>();final AtomicInteger releases=new AtomicInteger();volatile String releaseThread="";long getCachedBytes(String key,long offset,long length){return Math.min(length,bytes.getOrDefault(key,0L));}ContentMetadata getContentMetadata(String key){return new ContentMetadata(lengths.getOrDefault(key,-1L));}long getCacheSpace(){return bytes.values().stream().mapToLong(Long::longValue).sum();}void release(){releaseThread=Thread.currentThread().getName();releases.incrementAndGet();}}
class CacheDataSource{static class Factory{final SimpleCache cache;Factory(SimpleCache value){cache=value;}SimpleCache createDataSourceForDownloading(){return cache;}}}
class CacheWriter{static final List<CacheWriter> writers=new CopyOnWriteArrayList<>();static final Map<String,AtomicInteger> activeByUrl=new ConcurrentHashMap<>();static final AtomicInteger maxSameUrl=new AtomicInteger();final String uri;final long length;final SimpleCache cache;final CountDownLatch entered=new CountDownLatch(1),finish=new CountDownLatch(1);volatile boolean cancelled;
  CacheWriter(SimpleCache cache,DataSpec spec,byte[] buffer,Object progress){this.cache=cache;uri=spec.uri.toString();length=spec.length;writers.add(this);}
  void cache()throws Exception{AtomicInteger count=activeByUrl.computeIfAbsent(uri,key->new AtomicInteger());maxSameUrl.accumulateAndGet(count.incrementAndGet(),Math::max);entered.countDown();try{finish.await();if(cancelled)throw new java.io.InterruptedIOException();cache.bytes.put(uri,length);}finally{count.decrementAndGet();}}
  void cancel(){cancelled=true;}
}
class Fallback{final Map<String,String> urls=new HashMap<>();String playbackUrl(ShortVideoItem item){return urls.getOrDefault(item.id,item.streamUrl);}}
class SystemClock{static long elapsedRealtime(){return System.nanoTime()/1000000;}}
class Log{static int i(String tag,String value){return 0;}static int w(String tag,String value){return 0;}static int w(String tag,String value,Exception error){return 0;}}
class Player{static final int STATE_ENDED=4;}
class ExoPlayer{boolean paused;boolean getPlayWhenReady(){return true;}int getPlaybackState(){return 3;}void pause(){paused=true;}}
class FeedPlayback{void pauseForLifecycle(ExoPlayer active,ExoPlayer sound){}boolean awaitingVideo(){return false;}boolean awaitingSound(ExoPlayer player,String id){return false;}void start(ExoPlayer player,boolean gallery,String id,boolean visible){}}
`);
  const compiled=spawnSync(path.join(javaHome,"bin/javac.exe"),["-encoding","UTF-8","-d",directory,controllerPath,path.join(native,"NativeShortVideoCacheLifecycle.java"),javaFile],{encoding:"utf8",timeout:20000});
  assert.equal(compiled.status,0,compiled.stderr||compiled.error?.message);
  return spawnSync(path.join(javaHome,"bin/java.exe"),["-cp",directory,"local.fanhao.library.NativePrefetchHarness"],{encoding:"utf8",timeout:15000});
}
try {
  const result=compileAndRun("current",controller,methods);assert.equal(result.status,0,result.stderr||result.error?.message);process.stdout.write(result.stdout);
  const unsafeBackground=methods.replace(" || !activityResumed","").replace("&& activityResumed &&", "&&");assert.notEqual(unsafeBackground,methods);
  const background=compileAndRun("background-unguarded",controller,unsafeBackground);assert.notEqual(background.status,0);assert.match(background.stderr,/background must not dispatch|non-next indices and background/);
  const unsafeUrl=controller.replace('    for (Lease active : running) if (active.cacheKey.equals(lease.cacheKey)) return;',"");assert.notEqual(unsafeUrl,controller);
  const url=compileAndRun("url-mutex-removed",unsafeUrl,methods);assert.notEqual(url.status,0);assert.match(url.stderr,/same URL replacement waits|same URL writers never overlap/);
  console.log("native-short-video-prefetch: unguarded background dispatch and missing same-URL mutex negative controls rejected");
} finally {const resolved=path.resolve(temporary);assert(resolved.startsWith(path.resolve(os.tmpdir())+path.sep));fs.rmSync(resolved,{recursive:true,force:true});}
