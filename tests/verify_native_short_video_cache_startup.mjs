import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// Actual Activity init/resource/release methods, actual lifecycle and dynamic
// factory. Controlled SimpleCache reproduces the installed SDK monitor protocol;
// the SDK bytecode is checked separately below. No real cache, service or device.
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"..");
const native=path.join(root,"android-client/android/app/src/main/java/local/fanhao/library");
const activity=fs.readFileSync(path.join(native,"NativeShortVideoActivity.java"),"utf8").replace(/\r\n/g,"\n");
function block(start){let index=activity.indexOf("{",start)+1,depth=1;for(;index<activity.length&&depth;index++){if(activity[index]==="{")depth++;else if(activity[index]==="}")depth--;}return activity.slice(start,index);}
function member(name){const found=new RegExp(`^  (?:private|protected) [^\\n]* ${name}\\([^\\n]*`,"m").exec(activity);assert(found,name);return block(found.index);}
const resourceIndex=activity.indexOf("  private static final class VideoCacheResource {");assert(resourceIndex>=0);
const resource=block(resourceIndex);
const methods=["initializeVideoCache","createVideoCacheResource","releaseVideoCache","stopVideoPrefetch"].map(member).join("\n");
const create=member("onCreate"),initCall="    initializeVideoCache();";
const prelude=create.slice(0,create.indexOf(initCall)+initCall.length).replace("@Nullable ","")+"\n    buildUi();\n  }";
const destroy=member("onDestroy"),drain=destroy.slice(destroy.indexOf("    releaseAllPlayers();"),destroy.indexOf("    frameCache.evictAll();"));
assert(drain.includes("stopVideoPrefetch();")&&drain.includes("releaseVideoCache();"));
const factory=fs.readFileSync(path.join(native,"NativeShortVideoCacheDataSourceFactory.java"),"utf8");
const lifecycle=fs.readFileSync(path.join(native,"NativeShortVideoCacheLifecycle.java"),"utf8");
const temporary=fs.mkdtempSync(path.join(os.tmpdir(),"fanhao-cache-startup-"));
const javaHome=process.env.JAVA_HOME||"C:/Program Files/Android/openjdk/jdk-21.0.8";
const tool=name=>path.join(javaHome,"bin",`${name}.exe`);
function write(folder,name,text){const target=path.join(folder,name);fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,text);return target;}
function compile(label,factorySource=factory,activityMethods=methods){
  const folder=path.join(temporary,label);fs.mkdirSync(folder,{recursive:true});
  const dataSource=write(folder,"androidx/media3/datasource/DataSource.java",`package androidx.media3.datasource;public interface DataSource{interface Factory{DataSource createDataSource();}}`);
  const factoryFile=write(folder,"NativeShortVideoCacheDataSourceFactory.java",factorySource);
  const lifecycleFile=write(folder,"NativeShortVideoCacheLifecycle.java",lifecycle);
  const harness=write(folder,"NativeCacheStartupHarness.java",`package local.fanhao.library;
import java.io.*;import java.util.*;import java.util.concurrent.*;import java.util.concurrent.atomic.*;import androidx.media3.datasource.DataSource;
public final class NativeCacheStartupHarness extends Base {
  static final String TAG="fixture";static final long VIDEO_CACHE_MAX_BYTES=512L*1024L*1024L;
  long createdAtMs,videoPrefetchGeneration;String videoPrefetchOwner="";volatile boolean destroying,built;boolean activityResumed=true;int currentIndex=0;int prefetches;
  final Config config;final Handler mainHandler=new Handler();final NativeShortVideoPrefetchController videoPrefetch=new NativeShortVideoPrefetchController();
  NativeShortVideoCacheLifecycle<VideoCacheResource> videoCacheLifecycle;DataSource.Factory videoPlaybackDataSourceFactory;
  NativeShortVideoRecovery.NativeOwner nativeSession;
  NativeCacheStartupHarness(Config config){this.config=config;config.owner=this;}
  Object getApplicationContext(){return config;}File getCacheDir(){return new File("controlled-unused-cache-path");}
  void requestWindowFeature(int value){}void setRequestedOrientation(int value){}void hideSystemBars(){}void readControlPreferences(){}void initializeAudioInterruptionHandling(){}
  void buildUi(){built=true;}void scheduleVideoPrefetch(int index){prefetches++;}void releaseAllPlayers(){config.playersReleased=true;}void finish(){throw new AssertionError("unmanaged cache fixture must not reject startup");}
  ${prelude}
  ${resource}
  ${activityMethods}
  void destroy(){destroying=true;${drain}}
  static void check(boolean value,String message){if(!value)throw new AssertionError(message);}
  static void waitFor(java.util.function.BooleanSupplier condition,String message)throws Exception{long end=System.nanoTime()+TimeUnit.SECONDS.toNanos(3);while(!condition.getAsBoolean()&&System.nanoTime()<end)Thread.sleep(2);check(condition.getAsBoolean(),message);}
  static boolean initializing(NativeShortVideoCacheLifecycle<?> owner){try{java.lang.reflect.Field field=NativeShortVideoCacheLifecycle.class.getDeclaredField("initializing");field.setAccessible(true);synchronized(owner){return field.getBoolean(owner);}}catch(Exception error){throw new RuntimeException(error);}}
  static void ready(NativeCacheStartupHarness host)throws Exception{waitFor(()->host.videoCacheLifecycle.ready()!=null,"cache becomes ready");}
  static Source source(NativeCacheStartupHarness host){return (Source)host.videoPlaybackDataSourceFactory.createDataSource();}
  static void cleanup(NativeCacheStartupHarness host)throws Exception{host.destroy();host.config.allowInit.countDown();waitFor(()->host.config.instances.stream().allMatch(value->value.released.get()==1),"owned cache cleanup");}
  public static void main(String[]args)throws Exception{
    int checks=0;SystemClock.now.set(0);
    {
      Config config=new Config(new Directory());NativeCacheStartupHarness host=new NativeCacheStartupHarness(config);
      try{Thread ui=new Thread(()->host.onCreate(null),"controlled-ui");ui.start();check(config.lockAcquired.await(2,TimeUnit.SECONDS),"cache init monitor held on worker");ui.join(500);
        check(host.built&&!ui.isAlive(),"actual onCreate/init path must reach buildUi before slow cache initialization");check(host.videoCacheLifecycle.ready()==null,"uninitialised cache must not publish");
        Source first=source(host);first.open();check(first.kind.equals("network"),"first slow-init source uses network without cache lock");check(config.initializationThreads.stream().noneMatch(value->value.equals("controlled-ui")),"creation is off UI");checks++;
        config.allowInit.countDown();ready(host);check(config.checks.get()==1&&config.spaceReads.get()==1,"checkInitialization and getCacheSpace run before ready");check(config.lockAccessThreads.stream().allMatch(value->value.equals("short-video-cache-init")),"cache init checks and space log never acquire cache monitor on UI");
        Source next=source(host);next.open();check(next.kind.equals("cache"),"next source naturally adopts ready cache");check(first.kind.equals("network")&&first.opens==1,"current opened network source was never replaced or reopened");checks++;
        waitFor(()->!host.mainHandler.jobs.isEmpty(),"actual ready callback posts its UI continuation");host.mainHandler.runPending();check(host.prefetches==1,"ready callback schedules eligible future speculation without player reload");checks++;
      }finally{cleanup(host);}
    }
    {
      Config config=new Config(new Directory());NativeCacheStartupHarness host=new NativeCacheStartupHarness(config);
      host.onCreate(null);check(config.lockAcquired.await(2,TimeUnit.SECONDS),"late init entered");long before=System.nanoTime();host.destroy();
      check(TimeUnit.NANOSECONDS.toMillis(System.nanoTime()-before)<100,"destroy must not await init monitor");config.allowInit.countDown();
      waitFor(()->config.instances.get(0).released.get()==1,"late init releases only its own unaccepted cache");host.mainHandler.runPending();check(host.prefetches==0&&host.videoCacheLifecycle==null,"destroyed owner cannot publish or schedule from late ready");checks++;
    }
    {
      Config config=new Config(new Directory());config.allowInit.countDown();NativeCacheStartupHarness host=new NativeCacheStartupHarness(config);host.onCreate(null);ready(host);
      waitFor(()->!host.mainHandler.jobs.isEmpty(),"ready callback queued before owner closes");SimpleCache cache=config.instances.get(0);host.destroy();host.mainHandler.runPending();waitFor(()->cache.released.get()==1,"ready owned cache released");check(!cache.releaseThread.equals(Thread.currentThread().getName()),"ready cache release stays off UI");check(host.prefetches==0,"posted ready callback rechecks closed Activity owner");
      try{source(host);throw new AssertionError("closed source factory must reject");}catch(IllegalStateException expected){}host.destroy();check(cache.released.get()==1,"release is idempotent");checks++;
    }
    {
      Directory directory=new Directory();Config oldConfig=new Config(directory);NativeCacheStartupHarness old=new NativeCacheStartupHarness(oldConfig);old.onCreate(null);check(oldConfig.lockAcquired.await(2,TimeUnit.SECONDS),"old init owns folder");old.destroy();
      Config freshConfig=new Config(directory);freshConfig.allowInit.countDown();NativeCacheStartupHarness fresh=new NativeCacheStartupHarness(freshConfig);fresh.onCreate(null);
      try{waitFor(()->freshConfig.attempts.get()==1&&!initializing(fresh.videoCacheLifecycle),"new Activity first attempt sees old owned folder lock");check(source(fresh).kind.equals("network"),"folder lock failure retains a usable network source");
        for(int i=0;i<100;i++)source(fresh);check(freshConfig.attempts.get()==1,"new-source retries are throttled; no hot polling");
        oldConfig.allowInit.countDown();waitFor(()->oldConfig.instances.get(0).released.get()==1,"only old instance releases its old folder ownership");
        SystemClock.now.set(600);source(fresh);ready(fresh);check(freshConfig.attempts.get()==2,"later explicit source retries after backoff");
        check(source(fresh).kind.equals("cache"),"retry restores caching rather than permanently degrading");check(freshConfig.instances.get(0).released.get()==0,"old lifecycle must not close new cache");checks++;
      }finally{cleanup(fresh);}
    }
    {
      Config config=new Config(new Directory());config.allowInit.countDown();config.checkFailures.set(1);NativeCacheStartupHarness host=new NativeCacheStartupHarness(config);host.onCreate(null);
      try{waitFor(()->config.attempts.get()==1&&!initializing(host.videoCacheLifecycle),"failed init check settles");check(config.instances.get(0).released.get()==1,"partial cache released on init failure");
        SystemClock.now.addAndGet(600);source(host);ready(host);check(source(host).kind.equals("cache"),"partial init failure also retries on a later source");checks++;
      }finally{cleanup(host);}
    }
    {
      Config config=new Config(new Directory());config.allowInit.countDown();NativeCacheStartupHarness host=new NativeCacheStartupHarness(config);host.onCreate(null);ready(host);SimpleCache cache=config.instances.get(0);
      CountDownLatch entered=new CountDownLatch(1),readReturns=new CountDownLatch(1);host.videoPrefetch.offer("owned","url",()->true,lease->{lease.attach(()->{});entered.countDown();readReturns.await();});check(entered.await(2,TimeUnit.SECONDS),"physical prefetch held");
      host.destroy();check(config.playersReleased,"players released first by actual destroy cleanup sequence");check(cache.released.get()==0,"ready cache cannot close before physical prefetch drain");readReturns.countDown();waitFor(()->cache.released.get()==1,"cache closes after last actual physical worker");checks++;
    }
    System.out.println("native-short-video-cache-startup: "+checks+" actual Activity/lifecycle/factory startup, next-source, retry, ownership and physical-drain cases passed");
  }
}
class Base{protected void onCreate(Bundle value){}}class Bundle{}class Window{static final int FEATURE_NO_TITLE=1;}class ActivityInfo{static final int SCREEN_ORIENTATION_PORTRAIT=1;}
// Session authorization is independent of cache startup; the session verifier
// exercises the real owner. This fixture intentionally launches unmanaged.
class NativeShortVideoRecovery{static NativeOwner attach(Object host,Object saved){return new NativeOwner();}static class NativeOwner{boolean isRejected(){return false;}}}
class Handler{final Queue<Runnable> jobs=new ConcurrentLinkedQueue<>();void post(Runnable job){jobs.add(job);}void runPending(){Runnable job;while((job=jobs.poll())!=null)job.run();}}
class Directory{SimpleCache owner; synchronized void claim(SimpleCache value){if(owner!=null)throw new IllegalStateException("cache folder locked");owner=value;}synchronized void release(SimpleCache value){if(owner==value)owner=null;}}
class Config{final Directory directory;final CountDownLatch lockAcquired=new CountDownLatch(1),allowInit=new CountDownLatch(1);final AtomicInteger attempts=new AtomicInteger(),checks=new AtomicInteger(),spaceReads=new AtomicInteger(),checkFailures=new AtomicInteger();final List<SimpleCache> instances=new CopyOnWriteArrayList<>();final List<String> initializationThreads=new CopyOnWriteArrayList<>(),lockAccessThreads=new CopyOnWriteArrayList<>();volatile boolean playersReleased;NativeCacheStartupHarness owner;Config(Directory directory){this.directory=directory;}}
class StandaloneDatabaseProvider{final Config config;StandaloneDatabaseProvider(Object context){config=(Config)context;}}
class LeastRecentlyUsedCacheEvictor{LeastRecentlyUsedCacheEvictor(long max){}}
class SimpleCache{
  final Config config;final AtomicInteger released=new AtomicInteger();final CountDownLatch opened=new CountDownLatch(1);volatile boolean initialized;volatile String releaseThread="";
  SimpleCache(File ignored,LeastRecentlyUsedCacheEvictor evictor,StandaloneDatabaseProvider provider)throws Exception{config=provider.config;config.attempts.incrementAndGet();config.initializationThreads.add(Thread.currentThread().getName());config.directory.claim(this);config.instances.add(this);
    Thread init=new Thread(()->{synchronized(this){opened.countDown();config.lockAcquired.countDown();try{config.allowInit.await();initialized=true;}catch(InterruptedException error){throw new RuntimeException(error);}}},"controlled-Media3-init");init.setDaemon(true);init.start();opened.await();}
  synchronized void checkInitialization()throws Exception{config.lockAccessThreads.add(Thread.currentThread().getName());config.checks.incrementAndGet();if(config.checkFailures.getAndUpdate(value->Math.max(0,value-1))>0)throw new IOException("index unavailable");}
  synchronized long getCacheSpace(){config.lockAccessThreads.add(Thread.currentThread().getName());config.spaceReads.incrementAndGet();return 0;}
  synchronized void release(){releaseThread=Thread.currentThread().getName();released.incrementAndGet();config.directory.release(this);}
}
class Source implements DataSource{final String kind;int opens;Source(String kind){this.kind=kind;}void open(){opens++;}}
class DefaultHttpDataSource{static class Factory{Factory setConnectTimeoutMs(int value){return this;}Factory setReadTimeoutMs(int value){return this;}Factory setAllowCrossProtocolRedirects(boolean value){return this;}Factory setDefaultRequestProperties(Map<String,String> value){return this;}}}
class DefaultDataSource{static class Factory implements DataSource.Factory{Factory(Object context,DefaultHttpDataSource.Factory upstream){}public DataSource createDataSource(){return new Source("network");}}}
class CacheDataSource{static final int FLAG_IGNORE_CACHE_ON_ERROR=1;static class Factory implements DataSource.Factory{SimpleCache cache;Factory setCache(SimpleCache cache){this.cache=cache;return this;}Factory setUpstreamDataSourceFactory(DataSource.Factory upstream){return this;}Factory setFlags(int value){return this;}public DataSource createDataSource(){if(!cache.initialized)throw new AssertionError("unready cache source published");return new Source("cache");}}}
class Log{static int i(String tag,String value){return 0;}static int w(String tag,String value,Exception error){return 0;}}
class SystemClock{static final AtomicLong now=new AtomicLong();static long elapsedRealtime(){return now.get();}}
class ExtractAar{public static void main(String[]args)throws Exception{try(java.util.zip.ZipFile zip=new java.util.zip.ZipFile(args[0]);InputStream input=zip.getInputStream(zip.getEntry("classes.jar"))){java.nio.file.Files.copy(input,java.nio.file.Path.of(args[1]));}}}
`);
  const compiled=spawnSync(tool("javac"),["-encoding","UTF-8","-d",folder,dataSource,lifecycleFile,factoryFile,path.join(native,"NativeShortVideoPrefetchController.java"),harness],{encoding:"utf8",timeout:20000});
  assert.equal(compiled.status,0,compiled.stderr||compiled.error?.message);return folder;
}
function run(folder){return spawnSync(tool("java"),["-cp",folder,"local.fanhao.library.NativeCacheStartupHarness"],{encoding:"utf8",timeout:15000});}
try{
  const folder=compile("current"),result=run(folder);assert.equal(result.status,0,result.stderr||result.error?.message);process.stdout.write(result.stdout);
  const unsafeFactory=factory.replace("return (factory == null ? network : factory).createDataSource();","return network.createDataSource();");assert.notEqual(unsafeFactory,factory);
  const permanentNetwork=run(compile("permanent-network",unsafeFactory));assert.notEqual(permanentNetwork.status,0);assert.match(permanentNetwork.stderr,/next source naturally adopts ready cache/);
  const unsafeReady=methods.replace("      cache.checkInitialization();","").replace('      Log.i(TAG, "video cache ready bytes=" + cache.getCacheSpace());',"");assert.notEqual(unsafeReady,methods);
  const earlyPublish=run(compile("unready-publish",factory,unsafeReady));assert.notEqual(earlyPublish.status,0);assert.match(earlyPublish.stderr,/uninitialised cache must not publish|unready cache source published|checkInitialization and getCacheSpace run before ready/);
  console.log("native-short-video-cache-startup: permanent network fallback and early cache-publication negative controls rejected");
  const gradleHome=process.env.GRADLE_USER_HOME||path.join(os.homedir(),".gradle");
  const aarRoot=path.join(gradleHome,"caches/modules-2/files-2.1/androidx.media3/media3-datasource/1.10.1");
  const aar=fs.readdirSync(aarRoot,{withFileTypes:true}).filter(value=>value.isDirectory()).flatMap(value=>fs.readdirSync(path.join(aarRoot,value.name)).filter(name=>name.endsWith(".aar")).map(name=>path.join(aarRoot,value.name,name)))[0];
  assert(aar,"requires the existing product Media3 1.10.1 dependency, never downloads a new SDK");
  const jar=path.join(temporary,"media3-existing-classes.jar");
  const extract=spawnSync(tool("java"),["-cp",folder,"local.fanhao.library.ExtractAar",aar,jar],{encoding:"utf8",timeout:10000});assert.equal(extract.status,0,extract.stderr);
  const simple=spawnSync(tool("javap"),["-classpath",jar,"-c","-p","androidx.media3.datasource.cache.SimpleCache"],{encoding:"utf8",timeout:10000});
  const init=spawnSync(tool("javap"),["-classpath",jar,"-c","-p","androidx.media3.datasource.cache.SimpleCache$1"],{encoding:"utf8",timeout:10000});
  assert.equal(simple.status,0,simple.stderr);assert.equal(init.status,0,init.stderr);
  assert.match(simple.stdout,/public synchronized long getCacheSpace\(\)/);assert.match(simple.stdout,/public synchronized void checkInitialization\(\)/);assert.match(simple.stdout,/java\/io\/File.listFiles/);
  assert.match(init.stdout,/monitorenter[\s\S]*ConditionVariable.open[\s\S]*SimpleCache.access\$000[\s\S]*monitorexit/);
  console.log("native-short-video-cache-startup: installed Media3 1.10.1 bytecode confirms init monitor, filesystem scan and synchronized cache access");
}finally{const resolved=path.resolve(temporary);assert(resolved.startsWith(path.resolve(os.tmpdir())+path.sep));fs.rmSync(resolved,{recursive:true,force:true});}
