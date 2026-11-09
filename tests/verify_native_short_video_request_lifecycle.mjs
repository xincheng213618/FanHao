import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createShortVideoApi } from "../android-client/www/modules/short-videos/api.js";
import { createShortVideoListController } from "../android-client/www/modules/short-videos/list/controller.js";
import { createShortVideoNativeFeed } from "../android-client/www/modules/short-videos/player/native-feed.js";
import { createShortVideoSearch } from "../android-client/www/modules/short-videos/search.js";

// Actual WebView factories and extracted Activity methods, real JVM feed
// scheduler/reader/transport, controlled JSON/layout boundaries and private HTTP.
// Never installs an APK, contacts a service, or reads/writes application data.
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"..");
const javaRoot=path.join(root,"android-client/android/app/src/main/java/local/fanhao/library");
const originalWindow=globalThis.window;
let cases=0;
function fixture(factory=createShortVideoListController, apiFactory) {
  let base="http://old.fixture:29998";
  const requests=[],suggestionRequests=[],searchCancellations=[],launches=[],toasts=[],external=[];
  const listState={query:"",author:"all",source:"authors",sort:"published",data:{videos:[]},searchPage:false};
  globalThis.window={open:(...args)=>external.push(args),Capacitor:{Plugins:{FanHaoPlayer:{async playShortFeed(payload){launches.push(payload);return {serverBase:payload.baseUrl,snapshots:[]};}}}}};
  const context={getActiveUrl:()=>base,listState,showView(){},renderListShell(){},shortVideoToast:value=>toasts.push(value),
    invalidateShortVideoCache:async()=>{},
    api:{fetchCached(url,route,options){return new Promise((resolve,reject)=>requests.push({url,route,options,reject,
      resolve:(data,source="network")=>resolve(options?.withSource?{data,source}:data)}));},
      fetch(url,route,options){return new Promise((resolve,reject)=>suggestionRequests.push({url,route,options,resolve,reject}));}}
  };
  if (apiFactory) context.api = apiFactory(context.getActiveUrl);
  Object.assign(context,factory(context));Object.assign(context,createShortVideoNativeFeed(context));
  const search=createShortVideoSearch(context);
  Object.assign(context,search);
  // Record the entry factory's cancellation contract while executing the real
  // search controller; keep suggestion and native-author HTTP boundaries apart.
  context.cancelSearchSuggestions=(...args)=>{searchCancellations.push(args);return search.cancelSearchSuggestions(...args);};
  return {context,listState,requests,suggestionRequests,searchCancellations,launches,toasts,external,setBase:value=>{base=value;}};
}
const item=id=>({id,streamUrl:`/fixture/${id}.mp4`});
const flush=async()=>{for(let turn=0;turn<25;turn++)await Promise.resolve();};
async function obsoleteAuthorCannotLaunch(factory=createShortVideoListController) {
  const f=fixture(factory),opening=f.context.openShortVideoAuthor({secUid:"A"});
  f.context.applyListParams({source:"liked",query:"new"});
  assert.equal(f.requests[0].options.signal.aborted,true);
  f.requests[0].resolve({videos:[item("old")]});await opening;
  assert.equal(f.launches.length,0,"obsolete author lookup cannot launch a native player after a new scope");
}

async function sameAuthorReplacementOwnsItsRequest() {
  const cacheWrites = [], network = [], openings = [];
  const f = fixture(createShortVideoListController, getActiveUrl => createShortVideoApi({
    getActiveUrl,
    async writeResponseCache(_baseUrl, route, data) { cacheWrites.push({ route, id: data.videos[0].id }); }
  }));
  f.setBase("http://author-reopen.fixture:29998");
  Object.assign(globalThis.window, { setTimeout, clearTimeout });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (url, { signal }) => new Promise(resolve => network.push({ url, signal, resolve }));
  const respond = (read, id) => read.resolve(new Response(JSON.stringify({ videos: [item(id)], hasMore: true })));
  try {
    const author = { secUid: "same-author" };
    openings.push(f.context.openShortVideoAuthor(author));
    await flush();
    assert.equal(network.length, 1, "the first author open starts a physical request");

    openings.push(f.context.openShortVideoAuthor(author));
    await flush();
    assert.equal(network[0].signal.aborted, true, "replacement aborts the retired author request");
    assert.equal(network.length, 2, "same-author replacement must start its own request while the retired fetch is held");
    assert.equal(network[1].signal.aborted, false);
    assert.equal(network[1].url, network[0].url, "this must exercise same-URL request ownership");
    assert.equal(new URL(network[1].url).searchParams.get("refresh"), "1");

    respond(network[1], "current-author-item");
    assert.equal(await openings[1], true);
    assert.deepEqual(f.launches.map(value => value.startId), ["current-author-item"]);
    assert.equal(f.launches[0].openAuthorPanel, true);
    assert.equal(cacheWrites.length, 1);
    const canonical = new URL(cacheWrites[0].route, f.context.getActiveUrl());
    assert.equal(canonical.searchParams.get("author"), author.secUid);
    assert.equal(canonical.searchParams.has("refresh"), false);

    // Even a valid reply arriving after abort cannot publish or relaunch.
    respond(network[0], "retired-author-item");
    assert.equal(await openings[0], false);
    assert.deepEqual(f.launches.map(value => value.startId), ["current-author-item"]);
    assert.deepEqual(cacheWrites.map(write => write.id), ["current-author-item"]);
    assert.equal(f.toasts.length, 0);
  } finally {
    f.context.cancelShortVideoNativeOpen();
    for (const read of network) respond(read, "cleanup");
    await Promise.allSettled(openings);
    globalThis.fetch = originalFetch;
  }
}

try {
  await obsoleteAuthorCannotLaunch();cases++;
  await sameAuthorReplacementOwnsItsRequest();cases++;
  for(const action of ["server","leave","direct-video","new-author","scope-aba"]) {
    const f=fixture(),opening=f.context.openShortVideoAuthor({secUid:"A"});
    if(action==="server")f.setBase("http://new.fixture:29998");
    if(action==="leave") {
      const suggestion=f.context.fetchSearchSuggestions("leaving fixture");
      assert.equal(f.suggestionRequests.length,1,"actual search controller starts its controlled read");
      assert.equal(f.suggestionRequests[0].options.signal.aborted,false);
      const source=fs.readFileSync(path.join(root,"android-client/www/modules/short-videos/index.js"),"utf8");
      const start=source.indexOf("  function deactivateTransientUi()"),end=source.indexOf("\n  }",start)+4;
      const env=vm.createContext({context:f.context,document:{querySelector:()=>null}});
      vm.runInContext(`${source.slice(start,end)}\ndeactivateTransientUi();`,env);
      assert.equal(f.searchCancellations.length,1,"actual entry deactivation invokes search cancellation exactly once");
      assert.deepEqual(f.searchCancellations[0],[],"deactivation uses the search controller's no-argument cancellation contract");
      assert.equal(f.suggestionRequests[0].options.signal.aborted,true,"leaving aborts the actual suggestion controller");
      f.suggestionRequests[0].resolve({suggestions:[{query:"retired fixture"}]});
      assert.equal(await suggestion,null,"a cancelled suggestion reply remains retired even if transport completes");
    }
    if(action==="direct-video") {f.listState.data.videos=[item("B")];await f.context.openShortVideoFromList(f.listState.data.videos[0]);}
    if(action==="new-author")f.context.openShortVideoAuthor({secUid:"B"});
    if(action==="scope-aba") {f.context.applyListParams({source:"liked"});f.context.applyListParams({source:"authors"});}
    f.requests[0].resolve({videos:[item("old")]});assert.equal(await opening,false);
    assert.equal(f.launches.some(launch=>launch.startId==="old"),false);assert.equal(f.toasts.length,0);
    if(action==="new-author"){f.requests[1].resolve({videos:[item("B")]});await flush();assert.equal(f.launches[0].startId,"B");}
    cases++;
  }
  {
    const f=fixture(),opening=f.context.openShortVideoAuthor({secUid:"A"});
    f.requests[0].resolve({videos:[item("A")],hasMore:true});assert.equal(await opening,true);
    assert.equal(f.launches[0].baseUrl,"http://old.fixture:29998");
    assert.equal(new URL(f.launches[0].feedUrl).searchParams.get("author"),"A");
    assert.equal(f.launches[0].openAuthorPanel,true);cases++;
  }
  {
    const f = fixture();
    const opening = f.context.openShortVideoAuthor({ secUid: "offline-author", profileUrl: "https://fixture.invalid/author" });
    assert.equal(f.requests[0].options.withSource, true);
    f.requests[0].resolve({ videos: [], offline: true, stale: true, cacheState: "offline" }, "fallback");
    assert.equal(await opening, false);
    assert.deepEqual(f.external, [], "an offline empty page cannot authorize opening an external profile");
    assert.deepEqual(f.launches, []);
    assert.equal(f.toasts.length, 1, "the user gets feedback when the author list is unavailable");
    cases++;
  }
  for(const error of [false,true]) {
    const f=fixture(),opening=f.context.openShortVideoAuthor({secUid:"A",profileUrl:"https://fixture.invalid/author"});
    f.context.cancelShortVideoNativeOpen();
    if(error)f.requests[0].reject(new Error("late failure"));else f.requests[0].resolve({videos:[]});
    assert.equal(await opening,false);assert.equal(f.external.length,0);assert.equal(f.toasts.length,0);cases++;
  }
  {
    const f=fixture(),opening=f.context.openShortVideoAuthor({secUid:"A"});
    await f.context.openNativeShortVideoFeed(item("B"),{videos:[item("B")]});
    f.requests[0].resolve({videos:[item("A")]});assert.equal(await opening,false);
    assert.deepEqual(f.launches.map(value=>value.startId),["B"]);
    f.setBase("http://new.fixture:29998");
    assert.equal(await f.context.openNativeShortVideoFeed(item("old"),{videos:[item("old")],baseUrl:"http://old.fixture:29998"}),false);
    assert.equal(f.launches.length,1);cases++;
  }
  {
    const url=new URL("../android-client/www/modules/short-videos/list/controller.js",import.meta.url);
    let source=fs.readFileSync(url,"utf8").replace(/\r\n/g,"\n");
    const unsafe=source.replace(/owner\.isCurrent = \(\) => nativeOpenOwner === owner && !owner\.controller\.signal\.aborted\s*&& owner\.scope === listScopeKey\(getActiveUrl\(\)\);/,"owner.isCurrent = () => true;");
    assert.notEqual(unsafe,source);
    source=unsafe.replace(/from "(\.\.?\/[^\"]+)"/g,(_,relative)=>`from ${JSON.stringify(new URL(relative,url).href)}`);
    const module=await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
    await assert.rejects(obsoleteAuthorCannotLaunch(module.createShortVideoListController),/obsolete author lookup cannot launch/);cases++;
  }
} finally {globalThis.window=originalWindow;}

const activity=fs.readFileSync(path.join(javaRoot,"NativeShortVideoActivity.java"),"utf8").replace(/\r\n/g,"\n");
function member(name){const match=new RegExp(`^  private [^\\n]* ${name}\\([^\\n]*`,"m").exec(activity);assert(match,name);const first=activity.indexOf("{",match.index);let pos=first+1,depth=1;for(;pos<activity.length&&depth;pos++){if(activity[pos]==="{")depth++;else if(activity[pos]==="}")depth--;}return activity.slice(match.index,pos);}
const temp=fs.mkdtempSync(path.join(os.tmpdir(),"fanhao-native-request-"));
function write(relative,source){const target=path.join(temp,relative);fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,source);return target;}
try {
  const stubs=[
    write("android/os/SystemClock.java",`package android.os;public class SystemClock{public static long elapsedRealtime(){return System.nanoTime()/1000000;}}`),
    write("android/util/Log.java",`package android.util;public class Log{public static int i(String tag,String value){return 0;}}`),
    write("android/util/LruCache.java",`package android.util;import java.util.*;public class LruCache<K,V>{private final Map<K,V> map=new LinkedHashMap<>();private final int max;public LruCache(int max){this.max=max;}public synchronized V get(K key){return map.get(key);}public synchronized V put(K key,V value){V old=map.put(key,value);while(map.size()>max)map.remove(map.keySet().iterator().next());return old;}public synchronized void evictAll(){map.clear();}}`),
    write("android/net/Uri.java",`package android.net;
import java.net.*;
import java.nio.charset.StandardCharsets;
public class Uri {
  private final URI uri;
  private Uri(URI value) { uri = value; }
  public static Uri parse(String value) { return new Uri(URI.create(value)); }
  public String getPath() { return uri.getPath(); }
  public String getQueryParameter(String name) {
    String query = uri.getRawQuery();
    if (query == null) return null;
    for (String pair : query.split("&")) {
      String[] parts = pair.split("=", 2);
      if (URLDecoder.decode(parts[0], StandardCharsets.UTF_8).equals(name)) {
        return parts.length == 2 ? URLDecoder.decode(parts[1], StandardCharsets.UTF_8) : "";
      }
    }
    return null;
  }
  public Builder buildUpon() { return new Builder(uri); }
  public String toString() { return uri.toString(); }
  public static class Builder {
    private final String origin;
    private String path, query, fragment;
    Builder(URI value) {
      origin = value.getScheme() + "://" + value.getRawAuthority();
      path = value.getRawPath(); query = value.getRawQuery(); fragment = value.getRawFragment();
    }
    public Builder encodedPath(String value) { path = value; return this; }
    public Builder encodedQuery(String value) { query = value; return this; }
    public Builder fragment(String value) { fragment = value; return this; }
    public Builder appendQueryParameter(String name, String value) {
      String param = URLEncoder.encode(name, StandardCharsets.UTF_8) + "=" + URLEncoder.encode(value, StandardCharsets.UTF_8);
      query = query == null || query.isEmpty() ? param : query + "&" + param;
      return this;
    }
    public Uri build() {
      return Uri.parse(origin + (path == null ? "" : path) + (query == null ? "" : "?" + query) + (fragment == null ? "" : "#" + fragment));
    }
  }
}`),
    write("org/json/JSONObject.java",String.raw`package org.json;
import java.util.*;
import java.util.regex.*;
public class JSONObject {
  private final String raw;
  public JSONObject(String raw) { this.raw = raw; }
  private String token(String key, String pattern) {
    Matcher matcher = Pattern.compile("\"" + Pattern.quote(key) + "\"\\s*:\\s*(" + pattern + ")").matcher(raw);
    return matcher.find() ? matcher.group(1) : null;
  }
  public JSONArray optJSONArray(String key) {
    if (token(key, "\\[") == null) return null;
    List<JSONObject> rows = new ArrayList<>();
    Matcher matcher = Pattern.compile("\\{\\s*\"id\"\\s*:\\s*\"[^\"]+\"\\s*\\}").matcher(raw);
    while (matcher.find()) rows.add(new JSONObject(matcher.group()));
    return new JSONArray(rows);
  }
  public JSONObject optJSONObject(String key) { return null; }
  public int optInt(String key, int fallback) {
    String value = token(key, "-?[0-9]+");
    return value == null ? fallback : Integer.parseInt(value);
  }
  public boolean optBoolean(String key, boolean fallback) {
    String value = token(key, "true|false");
    return value == null ? fallback : Boolean.parseBoolean(value);
  }
  public String optString(String key, String fallback) {
    String value = token(key, "\"[^\"]*\"");
    return value == null ? fallback : value.substring(1, value.length() - 1);
  }
}`),
    write("org/json/JSONArray.java",`package org.json;import java.util.*;public class JSONArray{final List<JSONObject> rows;JSONArray(List<JSONObject> rows){this.rows=rows;}public int length(){return rows.size();}public JSONObject optJSONObject(int index){return rows.get(index);}}`)
  ];
  const harness=write("local/fanhao/library/NativeShortVideoRequestLifecycleHarness.java",`package local.fanhao.library;
import java.net.*;import java.util.*;import java.util.concurrent.*;import java.util.concurrent.atomic.*;import com.sun.net.httpserver.*;import android.util.Log;
public final class NativeShortVideoRequestLifecycleHarness {
  static void check(boolean value,String message){if(!value)throw new AssertionError(message);}
  static void waitFor(java.util.function.BooleanSupplier condition,String message)throws Exception{long end=System.nanoTime()+TimeUnit.SECONDS.toNanos(3);while(!condition.getAsBoolean()&&System.nanoTime()<end)Thread.sleep(5);check(condition.getAsBoolean(),message);}
  static int activeReads(NativeShortVideoFeedRequests requests){try{java.lang.reflect.Field field=NativeShortVideoFeedRequests.class.getDeclaredField("reads");field.setAccessible(true);return ((ThreadPoolExecutor)field.get(requests)).getActiveCount();}catch(Exception error){throw new RuntimeException(error);}}
  static class Gate{final CountDownLatch entered=new CountDownLatch(1),release=new CountDownLatch(1);boolean body;Gate(boolean body){this.body=body;}}
  static class Handler{final Queue<Runnable> callbacks=new ConcurrentLinkedQueue<>();void post(Runnable callback){callbacks.add(callback);}void drain(){Runnable callback;while((callback=callbacks.poll())!=null)callback.run();}}
  static class Host implements AutoCloseable {
    final NativeShortVideoFeedRequests feedRequests=new NativeShortVideoFeedRequests();final NativeShortVideoFeedPaging feedPaging=new NativeShortVideoFeedPaging();
    final NativeShortVideoFeedReader feedReader=new NativeShortVideoFeedReader(12,60000);final Handler mainHandler=new Handler();
    final List<ShortVideoItem> videos=new ArrayList<>();final List<ScreenState> navigationStack=new ArrayList<>();
    final Snapshots actionSnapshots=new Snapshots();final Preferences actionPreferences=new Preferences();final Adapter adapter=new Adapter();final Pager pager=new Pager();
    String pendingFeedUrl,nextFeedCursor="",applied="",status="";int nextFeedOffset,currentIndex=1;boolean loadingMoreVideos,hasMoreVideos=true,openAuthorPanelOnStart,canAdvance;
    Object currentScreen;Runnable retry;static final String TAG="fixture";static final int FEED_PAGE_LIMIT=12;
    Host(String base){pendingFeedUrl=base;feedPaging.replaceFeed(base,"",true);}
    static class Snapshots{long revision(){return 0;}void applyAll(List<ShortVideoItem> rows){}}
    static class Preferences{void reconcile(List<ShortVideoItem> rows){}}
    static class Adapter{void notifyDataSetChanged(){}void notifyItemRangeInserted(int index,int count){}}
    static class Pager{int moves;void setCurrentItem(int index,boolean animated){moves++;}}
    String normalizeSortParam(String value){return value;}String authorSortLabel(String value){return value;}
    String feedUrlWithSort(String base,String sort){return appendQuery(base,"sort="+sort);}String normalizeFeedUrl(String value){return value;}
    String currentFeedQuery(){return "";}String feedUrlWithQuery(String base,String query){return appendQuery(base,"q="+query);}
    String pagedFeedUrl(String base,int offset,String cursor,int limit){return appendQuery(base,"page=next");}
    void showStatus(String value){status=value;retry=null;}void showTransientStatus(String value){showStatus(value);}void hideStatus(){showStatus("");}
    void showFeedReadRetry(String value, Runnable action){showStatus(value);retry=action;}
    void retryFeedRead(){Runnable action=retry;check(action!=null,"failed feed read must offer explicit retry");retry=null;action.run();}
    void applyLocalFeedSort(String sort,String message){}void acceptServerActionSnapshots(List<ShortVideoItem> rows,long revision){}
    void syncPendingVideoActions(boolean force){}Object captureFeedScreen(){return new Object();}ScreenState captureCurrentScreen(){return new ScreenState();}
    void openInitialAuthorScreen(int index){}void startPlaybackAt(int index){applied=videos.get(index).id;}
    void replaceFeedWithPage(FeedPage page,String url,int index){applied=page.items.get(0).id;}
    void prepareAround(int index){}void preparePlayersAround(int index){}void scheduleVideoPrefetch(int index){}void cancelVideoPrefetch(){}void pauseFrameLoading(){}void advanceAfterEnded(int index){}
    Object galleryContinuation;void cancelGalleryContinuation(){galleryContinuation=null;}boolean flushGalleryContinuation(){return false;}
    boolean canAdvanceAfterEnded(int index){return canAdvance;}
    NativeShortVideoFeedPaging.ReadResult<FeedPage> readFeedPage(String url,NativeShortVideoFeedTransport.Cancellation token){return feedReader.read(url,token);}
    ${member("applyFeedSort")}
    ${member("applyFeedSearch")}
    ${member("loadFeedAsync")}
    ${member("loadMoreIfNeeded")}
    public void close(){feedRequests.close();feedReader.clear();}
  }
  static class ScreenState{}
  static String appendQuery(String url, String params) { return url + (url.contains("?") ? "&" : "?") + params; }

  static Map<String, String> queryParams(URI uri) {
    Map<String, String> params = new HashMap<>();
    String query = uri.getRawQuery();
    if (query == null) return params;
    for (String pair : query.split("&")) {
      String[] parts = pair.split("=", 2);
      params.put(URLDecoder.decode(parts[0], java.nio.charset.StandardCharsets.UTF_8),
        URLDecoder.decode(parts.length == 2 ? parts[1] : "", java.nio.charset.StandardCharsets.UTF_8));
    }
    return params;
  }

  static void drainFeedCallback(Host host) throws Exception {
    waitFor(() -> !host.mainHandler.callbacks.isEmpty(), "feed callback posted");
    host.mainHandler.drain();
  }

  static int verifyFeedAuthority(HttpServer server, String origin) throws Exception {
    String catalog = origin + "/api/short-videos";
    Map<String, AtomicInteger> hits = new ConcurrentHashMap<>();
    Queue<URI> requests = new ConcurrentLinkedQueue<>();
    Gate retiredRefresh = new Gate(false);
    server.createContext("/api/short-videos", exchange -> {
      try {
        URI uri = exchange.getRequestURI();
        requests.add(uri);
        Map<String, String> params = queryParams(uri);
        String scenario = params.get("fixture");
        boolean refresh = "1".equals(params.get("refresh"));
        int attempt = hits.computeIfAbsent(scenario + (refresh ? ":refresh" : ":original"), key -> new AtomicInteger()).incrementAndGet();
        String state = "fresh";
        if (attempt == 1 && !refresh) {
          state = switch (String.valueOf(scenario)) {
            case "offline-page", "offline-cold" -> "offline";
            case "offline-search" -> "offline-flag";
            case "refresh-sort", "refresh-page", "cancel-refresh", "custom" -> "stale-refreshing";
            default -> state;
          };
        }
        if ("refresh-sort".equals(scenario) && refresh) state = "stale-flag";
        if ("already-forced".equals(scenario)) state = "stale-refreshing";
        if ("cancel-refresh".equals(scenario) && refresh) {
          retiredRefresh.entered.countDown();
          retiredRefresh.release.await(5, TimeUnit.SECONDS);
        }
        boolean fresh = state.equals("fresh");
        String currentId = "offline-page".equals(scenario) ? "next-item" : "current";
        String id = !fresh ? "obsolete" : refresh ? "refreshed" : currentId;
        String quote = Character.toString('"');
        String authority = switch (state) {
          case "offline-flag" -> quote + "offline" + quote + ":true";
          case "stale-flag" -> quote + "stale" + quote + ":true";
          default -> quote + "cacheState" + quote + ":" + quote + state + quote;
        };
        byte[] body = """
          {"videos":[{"id":"%s"}],"offset":24,"limit":12,"total":72,"hasMore":%s,"nextCursor":"%s",%s}
          """.formatted(id, fresh, fresh ? "next-current" : "", authority).getBytes(java.nio.charset.StandardCharsets.UTF_8);
        exchange.sendResponseHeaders(200, body.length);
        exchange.getResponseBody().write(body);
      } catch (Exception ignored) {
      } finally {
        exchange.close();
      }
    });

    try {
      try (Host host = new Host(catalog + "?fixture=offline-page")) {
        host.videos.add(new ShortVideoItem("first"));
        host.videos.add(new ShortVideoItem("current"));
        host.nextFeedOffset = 24;
        host.nextFeedCursor = "prior-cursor";
        host.loadMoreIfNeeded(1);
        drainFeedCallback(host);
        check(host.videos.size() == 2 && host.videos.get(1).id.equals("current"), "offline continuation must preserve the loaded rows");
        check(host.hasMoreVideos && host.feedPaging.hasMore(), "offline continuation must not falsely end the feed");
        check(host.nextFeedOffset == 24 && host.nextFeedCursor.equals("prior-cursor") && host.feedPaging.cursor().equals("prior-cursor"),
          "offline continuation must preserve its prior offset and cursor");
        check(!hits.containsKey("offline-page:refresh"), "offline response must not launch another query");
        host.retryFeedRead();
        drainFeedCallback(host);
        check(hits.get("offline-page:original").get() == 2, "same-URL continuation retry must reach the recovered server");
        check(host.videos.size() == 3 && host.videos.get(2).id.equals("next-item") && host.nextFeedOffset == 36
          && host.nextFeedCursor.equals("next-current") && host.hasMoreVideos, "authoritative retry appends and advances offset and cursor");
      }
      try (Host host = new Host(catalog + "?fixture=offline-search")) {
        host.applied = "previous";
        host.applyFeedSearch("animal");
        drainFeedCallback(host);
        check(host.applied.equals("previous") && host.navigationStack.isEmpty(), "offline search must retain current screen and history");
        check(!hits.containsKey("offline-search:refresh"), "offline search must not make a foreground retry");
        host.retryFeedRead();
        drainFeedCallback(host);
        check(hits.get("offline-search:original").get() == 2 && host.applied.equals("current"), "same-URL search retry must show current data");
      }
      try (Host host = new Host(catalog + "?fixture=offline-cold")) {
        host.loadFeedAsync(host.pendingFeedUrl, 0);
        drainFeedCallback(host);
        check(host.videos.isEmpty() && host.applied.isEmpty(), "cold offline snapshot must not become a live feed");
        check(!hits.containsKey("offline-cold:refresh"), "cold offline response must not launch another query");
        host.retryFeedRead();
        drainFeedCallback(host);
        check(hits.get("offline-cold:original").get() == 2 && host.applied.equals("current"), "cold feed retry must open current data");
      }
      try (Host host = new Host(catalog + "?fixture=refresh-sort")) {
        host.applied = "previous";
        host.applyFeedSort("likes");
        drainFeedCallback(host);
        check(host.applied.equals("previous"), "sort must preserve current screen when foreground refresh is still stale");
        check(hits.get("refresh-sort:original").get() == 1 && hits.get("refresh-sort:refresh").get() == 1, "stale sort gets exactly one foreground refresh");
        host.retryFeedRead();
        drainFeedCallback(host);
        check(hits.get("refresh-sort:original").get() == 2 && host.applied.equals("current"), "stale retry must not enter the Reader LRU");
      }
      {
        NativeShortVideoFeedReader reader = new NativeShortVideoFeedReader(12, 60000);
        String url = catalog + "?fixture=refresh-page&q=cat%26dog&cursor=a%2Bb&stats=0&users=0";
        NativeShortVideoFeedPaging.ReadResult<FeedPage> result = reader.read(url);
        check(result.succeeded() && result.value.items.get(0).id.equals("refreshed") && result.nextCursor.equals("next-current"),
          "foreground refresh must supply the authoritative page");
        URI refresh = requests.stream().filter(uri -> "refresh-page".equals(queryParams(uri).get("fixture"))
          && "1".equals(queryParams(uri).get("refresh"))).findFirst().orElseThrow();
        Map<String, String> params = queryParams(refresh);
        check("cat&dog".equals(params.get("q")) && "a+b".equals(params.get("cursor"))
          && "0".equals(params.get("stats")) && "0".equals(params.get("users")), "foreground refresh must preserve query and cursor");
        check(reader.read(url).value.items.get(0).id.equals("refreshed") && hits.get("refresh-page:original").get() == 1
          && hits.get("refresh-page:refresh").get() == 1, "only the fresh reply is cached under the canonical URL");
      }
      try (Host host = new Host(catalog + "?fixture=cancel-refresh")) {
        host.applyFeedSearch("retired");
        check(retiredRefresh.entered.await(2, TimeUnit.SECONDS), "retired search foreground refresh must be held");
        host.applyFeedSort("likes");
        waitFor(() -> { host.mainHandler.drain(); return host.applied.equals("current"); }, "new sort settles while old refresh is held");
        check(host.applied.equals("current") && host.navigationStack.isEmpty(), "new sort must apply while old foreground refresh is held");
        retiredRefresh.release.countDown();
        waitFor(() -> activeReads(host.feedRequests) == 0, "cancelled foreground refresh must retire");
        host.mainHandler.drain();
        check(host.applied.equals("current") && host.navigationStack.isEmpty() && host.retry == null,
          "retired foreground refresh cannot change current UI, history or retry status");
        check(host.feedReader.read(catalog + "?fixture=cancel-refresh&q=retired").value.items.get(0).id.equals("current"),
          "retired foreground refresh cannot populate the Reader LRU");
        check(hits.get("cancel-refresh:original").get() == 3 && hits.get("cancel-refresh:refresh").get() == 1,
          "retry after cancellation reads the authoritative server once");
      }
      {
        NativeShortVideoFeedReader reader = new NativeShortVideoFeedReader(12, 60000);
        String url = catalog + "?fixture=already-forced&refresh=1";
        check(!reader.read(url).succeeded() && hits.get("already-forced:refresh").get() == 1, "already forced stale URL must not refresh again");
      }
      {
        NativeShortVideoFeedReader reader = new NativeShortVideoFeedReader(12, 60000);
        String url = catalog + "/collections/fixture/videos?fixture=custom";
        check(!reader.read(url).succeeded(), "marked stale custom feed is not an authoritative page");
        check(!hits.containsKey("custom:refresh"), "custom feed must not get a catalog refresh parameter");
        check(reader.read(url).succeeded() && hits.get("custom:original").get() == 2, "custom feed can recover on the next read");
      }
      return 8;
    } finally {
      retiredRefresh.release.countDown();
    }
  }

  public static void main(String[] args)throws Exception{
    HttpServer server=HttpServer.create(new InetSocketAddress("127.0.0.1",0),0);ExecutorService serverThreads=Executors.newCachedThreadPool();server.setExecutor(serverThreads);
    Map<String,Gate> gates=new ConcurrentHashMap<>();Map<String,AtomicInteger> hits=new ConcurrentHashMap<>();
    server.createContext("/feed",exchange->{String query=exchange.getRequestURI().getQuery();String key=query==null?"plain":query.substring(query.indexOf('=')+1);hits.computeIfAbsent(key,k->new AtomicInteger()).incrementAndGet();Gate gate=gates.get(key);
      try{String quote=Character.toString((char)34);byte[] body=("{"+quote+"videos"+quote+":[{"+quote+"id"+quote+":"+quote+key+quote+"}],"+quote+"hasMore"+quote+":false}").getBytes(java.nio.charset.StandardCharsets.UTF_8);
        if(gate!=null){if(gate.body){exchange.sendResponseHeaders(200,0);exchange.getResponseBody().write(body,0,1);exchange.getResponseBody().flush();}gate.entered.countDown();gate.release.await(5,TimeUnit.SECONDS);}
        if(gate==null||!gate.body)exchange.sendResponseHeaders(200,body.length);exchange.getResponseBody().write(body,gate!=null&&gate.body?1:0,body.length-(gate!=null&&gate.body?1:0));
      }catch(Exception ignored){}finally{exchange.close();}});
    server.start();String origin="http://127.0.0.1:"+server.getAddress().getPort();String base=origin+"/feed";int checks=0;
    try{
      for(boolean body:new boolean[]{false,true}){
        Host host=new Host(base);String old=body?"body":"headers";Gate gate=new Gate(body);gates.put(old,gate);
        try{host.applyFeedSort(old);check(gate.entered.await(2,TimeUnit.SECONDS),"old HTTP must be held");long before=System.nanoTime();host.applyFeedSort("latest-"+old);long ms=TimeUnit.NANOSECONDS.toMillis(System.nanoTime()-before);
          check(ms<100,"cancel must not wait on UI socket locks: "+ms);waitFor(()->hits.containsKey("latest-"+old),"latest filter must dispatch while old HTTP is still held");
          waitFor(()->{host.mainHandler.drain();return host.applied.equals("latest-"+old);},"latest owner applies (status="+host.status+")");
          gate.release.countDown();Thread.sleep(40);host.mainHandler.drain();check(host.applied.equals("latest-"+old),"old callback cannot replace newest feed");checks++;
        }finally{gate.release.countDown();host.close();}
      }
      {
        NativeShortVideoFeedRequests requests=new NativeShortVideoFeedRequests();CountDownLatch both=new CountDownLatch(2),release=new CountDownLatch(1),latest=new CountDownLatch(1);AtomicInteger obsolete=new AtomicInteger();
        NativeShortVideoFeedRequests.Read block=token->{both.countDown();boolean done=false;while(!done)try{release.await();done=true;}catch(InterruptedException ignored){}};
        requests.replace(block);waitFor(()->both.getCount()==1,"first ignored-cancel worker started");requests.replace(block);check(both.await(2,TimeUnit.SECONDS),"two ignored-cancel workers");
        requests.replace(token->obsolete.incrementAndGet());requests.replace(token->latest.countDown());
        java.lang.reflect.Field field=NativeShortVideoFeedRequests.class.getDeclaredField("reads");field.setAccessible(true);ThreadPoolExecutor reads=(ThreadPoolExecutor)field.get(requests);
        check(reads.getQueue().size()<=1,"only latest queued request retained");release.countDown();check(latest.await(2,TimeUnit.SECONDS),"latest queued task runs");check(obsolete.get()==0,"obsolete queued task cannot dispatch");requests.close();checks++;
      }
      {
        Host host=new Host(base);host.applyFeedSort("callback-old");waitFor(()->!host.mainHandler.callbacks.isEmpty(),"old callback posted");host.applyFeedSort("callback-new");
        host.mainHandler.drain();check(!host.applied.equals("callback-old"),"posted old completion invalidated before UI dispatch");waitFor(()->!host.mainHandler.callbacks.isEmpty(),"new callback posted");host.mainHandler.drain();check(host.applied.equals("callback-new"),"new callback remains valid");host.close();checks++;
      }
      {
        Host host=new Host(base);Gate gate=new Gate(true);gates.put("destroy",gate);host.applyFeedSort("destroy");check(gate.entered.await(2,TimeUnit.SECONDS),"destroy read held");long before=System.nanoTime();host.close();check(TimeUnit.NANOSECONDS.toMillis(System.nanoTime()-before)<100,"destroy must be nonblocking");
        gate.release.countDown();Thread.sleep(50);host.mainHandler.drain();check(host.applied.isEmpty(),"destroyed owner cannot apply a late feed");check(host.feedRequests.replace(token->{throw new AssertionError("closed dispatch");})==null,"closed scheduler refuses work");checks++;
      }
      {
        Host host=new Host(base);ShortVideoFeedContract.blockId="parse-old";ShortVideoFeedContract.entered=new CountDownLatch(1);ShortVideoFeedContract.release=new CountDownLatch(1);
        host.applyFeedSort("parse-old");check(ShortVideoFeedContract.entered.await(2,TimeUnit.SECONDS),"actual Reader parser entered");host.applyFeedSort("parse-new");
        ShortVideoFeedContract.release.countDown();waitFor(()->activeReads(host.feedRequests)==0,"cancelled parser and replacement both complete");host.mainHandler.drain();
        ShortVideoFeedContract.blockId="";int before=hits.get("parse-old").get();host.feedReader.read(base+"?sort=parse-old");check(hits.get("parse-old").get()==before+1,"cancelled Reader parser must not publish old cache");host.close();checks++;
      }
      {
        Host host=new Host(base);host.applyFeedSearch("search-current");waitFor(()->!host.mainHandler.callbacks.isEmpty(),"search callback");host.mainHandler.drain();check(host.applied.equals("search-current"),"actual search uses request owner");host.loadFeedAsync(base,0);waitFor(()->!host.mainHandler.callbacks.isEmpty(),"cold load callback");host.mainHandler.drain();check(host.applied.equals("plain"),"actual cold feed read remains functional");host.close();checks++;
      }
      for(boolean allowed:new boolean[]{false,true}){
        Host host=new Host(base);host.videos.add(new ShortVideoItem("a"));host.videos.add(new ShortVideoItem("b"));host.currentIndex=1;host.feedPaging.markPendingAutoAdvance(1);host.canAdvance=allowed;host.loadMoreIfNeeded(1);
        waitFor(()->!host.mainHandler.callbacks.isEmpty(),"paging callback");host.mainHandler.drain();check(host.videos.size()==3,"paging appends while intent changes");check(host.pager.moves==(allowed?1:0),"late page auto-advance obeys current playback intent");host.close();checks++;
      }
      checks += verifyFeedAuthority(server, origin);
      System.out.println("native-short-video-request-lifecycle: "+checks+" actual JVM scheduler/Activity/Reader/HTTP groups passed");
    }finally{for(Gate gate:gates.values())gate.release.countDown();server.stop(0);serverThreads.shutdownNow();}
  }
}
class ShortVideoItem{final String id;ShortVideoItem(String id){this.id=id;}}
class FeedStats{static FeedStats fromJson(org.json.JSONObject value){return new FeedStats();}static FeedStats fromItems(List<ShortVideoItem> rows){return new FeedStats();}boolean isEmpty(){return true;}}
class FeedPage{int offset,limit=12,total;boolean hasMore;String nextCursor="";FeedStats stats=new FeedStats();final List<ShortVideoItem> items=new ArrayList<>();int nextOffset(){return offset+limit;}FeedPage copy(){FeedPage page=new FeedPage();page.offset=offset;page.limit=limit;page.total=total;page.hasMore=hasMore;page.nextCursor=nextCursor;page.items.addAll(items);return page;}}
class CachedFeedPage{final FeedPage page;final long cachedAtMs;CachedFeedPage(FeedPage page,long at){this.page=page;cachedAtMs=at;}}
class ShortVideoFeedContract{static volatile String blockId="";static CountDownLatch entered,release;static ShortVideoItem itemFromJson(org.json.JSONObject object,String base,String fallback){String id=object.optString("id",fallback);if(id.equals(blockId)){entered.countDown();boolean done=false;while(!done)try{release.await();done=true;}catch(InterruptedException ignored){}}return new ShortVideoItem(id);}}
`);
  const javaHome=String(process.env.JAVA_HOME||"C:/Program Files/Android/openjdk/jdk-21.0.8");
  const sources=["NativeShortVideoFeedRequests.java","NativeShortVideoFeedReader.java","NativeShortVideoFeedTransport.java","NativeShortVideoFeedPaging.java","NativeShortVideoFeedAutoAdvance.java","NativeShortVideoHttpResponse.java"].map(name=>path.join(javaRoot,name));
  const compiled=spawnSync(path.join(javaHome,"bin/javac.exe"),["--add-modules","jdk.httpserver","-encoding","UTF-8","-d",temp,...sources,...stubs,harness],{encoding:"utf8",timeout:30000});
  assert.equal(compiled.status,0,compiled.stderr||compiled.error?.message);
  const executed=spawnSync(path.join(javaHome,"bin/java.exe"),["--add-modules","jdk.httpserver","-cp",temp,"local.fanhao.library.NativeShortVideoRequestLifecycleHarness"],{encoding:"utf8",timeout:20000});
  assert.equal(executed.status,0,executed.stderr||executed.error?.message);process.stdout.write(executed.stdout);
  console.log(`native-short-video-request-lifecycle: ${cases} actual WebView owner/base/scope/leave/native launch groups passed, including negative control`);
} finally {
  const resolved=path.resolve(temp);assert(resolved.startsWith(path.resolve(os.tmpdir())+path.sep));fs.rmSync(resolved,{recursive:true,force:true});
}
