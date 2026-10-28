import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// Current Activity read/close/navigation methods and real request scheduler,
// result contract and screen models. HTTP, View/Handler and media are controlled
// boundaries; cancelled reads deliberately complete to exercise late UI replies.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const javaRoot = path.join(root, "android-client/android/app/src/main/java/local/fanhao/library");
const activity = fs.readFileSync(path.join(javaRoot, "NativeShortVideoActivity.java"), "utf8").replace(/\r\n/g, "\n");
function member(name) {
  const match = new RegExp(`^  private [^\\n]* ${name}\\([^\\n]*`, "m").exec(activity);
  assert(match, name);
  const open = activity.indexOf("{", match.index);
  let index = open + 1, depth = 1;
  for (; index < activity.length && depth; index++) {
    if (activity[index] === "{") depth++;
    else if (activity[index] === "}") depth--;
  }
  return activity.slice(match.index, index);
}
const methods = ["ownsAuthorScreen", "loadInitialAuthorPage", "applyAuthorSort", "loadMoreAuthorPage", "removeAuthorOverlay",
  "navigateBack", "syncAuthorReturnState", "pushCurrentScreen", "captureCurrentScreen", "renderScreen"];
const production = methods.map(member).join("\n");
assert(activity.includes("if (shouldLoadInitialAuthorPage) loadInitialAuthorPage(screen, pageRef, render);"), "actual overlay uses its guarded initial read");
assert(/removeAuthorOverlay\(\);\s*screen.loadingMore = false;/.test(activity), "reopened author does not inherit a cancelled loading flag");
assert(activity.includes("(values[which].equals(screen.sort) && !screen.loadingMore)"), "choosing the committed sort can replace a pending read");

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "fanhao-author-requests-"));
const javaHome = String(process.env.JAVA_HOME || "C:/Program Files/Android/openjdk/jdk-21.0.8");
function write(relative, source) {
  const target = path.join(temp, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, source);
  return target;
}
const stubs = [
  write("androidx/annotation/Nullable.java", "package androidx.annotation; public @interface Nullable {}"),
  write("android/widget/ScrollView.java", "package android.widget; public class ScrollView {}")
];
const harness = code => `package local.fanhao.library;
import java.util.*; import java.util.concurrent.*; import java.util.function.BooleanSupplier;
public class AuthorRequestsHarness {
  static int cases; static String selected="all";
  interface Checked { void run() throws Exception; }
  static void test(String name, Checked work)throws Exception { if(!selected.equals("all")&&!selected.equals(name))return; work.run(); cases++; }
  static void require(boolean value,String message){if(!value)throw new AssertionError(message);}
  static void await(BooleanSupplier ready,String message)throws Exception {long end=System.nanoTime()+TimeUnit.SECONDS.toNanos(4);while(!ready.getAsBoolean()){require(System.nanoTime()<end,message);Thread.sleep(1);}}
  static FeedPage page(String... ids){FeedPage p=new FeedPage();for(String id:ids)p.items.add(new ShortVideoItem(id));p.total=p.items.size()+18;p.hasMore=true;return p;}
  static final class View {}
  static final class Root {int removals;void removeView(View view){removals++;}}
  static final class Handler {final Queue<Runnable> pending=new ConcurrentLinkedQueue<>();void post(Runnable r){pending.add(r);}void drain(){Runnable r;while((r=pending.poll())!=null)r.run();}}
  static final class Gate {final String url;final NativeShortVideoFeedTransport.Cancellation token;final CountDownLatch release=new CountDownLatch(1);volatile NativeShortVideoFeedPaging.ReadResult<FeedPage> result;Gate(String url,NativeShortVideoFeedTransport.Cancellation token){this.url=url;this.token=token;}void success(FeedPage page){result=NativeShortVideoFeedPaging.ReadResult.success(page,page.hasMore,page.nextCursor);release.countDown();}void fail(){result=NativeShortVideoFeedPaging.ReadResult.failure(NativeShortVideoFeedPaging.Failure.TIMEOUT);release.countDown();}}
  static final class Revision {long revision(){return 7L;}}
  static final class Preferences {int reconciled;void reconcile(List<ShortVideoItem> rows){reconciled++;}}
  static final class Log {static void i(String tag,String text){}}
  static final class Host implements AutoCloseable {
    static final String TAG="fixture";static final int AUTHOR_PAGE_LIMIT=18;
    final NativeShortVideoFeedRequests feedRequests=new NativeShortVideoFeedRequests();final Handler mainHandler=new Handler();final Root rootView=new Root();final Revision actionSnapshots=new Revision();final Preferences actionPreferences=new Preferences();final List<Gate> reads=new CopyOnWriteArrayList<>();final List<String> messages=new ArrayList<>();final List<ScreenState> navigationStack=new ArrayList<>();final List<ShortVideoItem> videos=new ArrayList<>();
    ScreenState currentScreen;View authorOverlay;boolean destroying,finishing,local;int rendered,accepted,hides,currentIndex=-1,finished;String status="",openedFeed="";
    boolean isFinishing(){return finishing;}String normalizeSortParam(String value){return value;}String authorSortLabel(String value){return value;}String displayAuthor(ShortVideoItem item){return item.id;}
    String authorFeedUrl(ShortVideoItem seed,int offset,int limit,String sort){return local?"":seed.id+":"+sort+":"+offset;}
    NativeShortVideoFeedPaging.ReadResult<FeedPage> readFeedPage(String url,NativeShortVideoFeedTransport.Cancellation token){Gate gate=new Gate(url,token);reads.add(gate);boolean done=false;while(!done)try{gate.release.await();done=true;}catch(InterruptedException ignored){}return gate.result==null?NativeShortVideoFeedPaging.ReadResult.failure(NativeShortVideoFeedPaging.Failure.OFFLINE):gate.result;}
    FeedPage sortedLocalAuthorPage(ShortVideoItem seed,String sort){return page("local-"+sort);}
    void acceptServerActionSnapshots(List<ShortVideoItem> rows,long revision){require(revision==7L,"action revision lost");accepted++;}void showStatus(String text){status=text;}void hideStatus(){status="";hides++;}void showTransientStatus(String text){messages.add(text);}void hideSystemBars(){}
    void dismissPlaybackToolbar(){}void finishWithActionResult(){feedRequests.cancel();finished++;}void applyCanonicalActionSnapshots(ScreenState screen){}
    boolean sameAuthor(ShortVideoItem a,ShortVideoItem b){return true;}int findVideoIndex(List<ShortVideoItem> rows,String id){for(int i=0;i<rows.size();i++)if(rows.get(i).id.equals(id))return i;return -1;}
    FeedScreenState captureFeedScreen(){return new FeedScreenState(videos,"feed",0,"",false,Math.max(0,currentIndex));}
    void renderFeedScreen(FeedScreenState screen){removeAuthorOverlay();currentScreen=screen;openedFeed=screen.feedUrl;}
    // Android layout is the controlled boundary. The exact production entry
    // resets the transient flag after removeAuthorOverlay (asserted above).
    void renderAuthorScreen(AuthorScreenState screen){removeAuthorOverlay();screen.loadingMore=false;authorOverlay=new View();currentScreen=screen;}
    ${code}
    @Override public void close(){destroying=true;feedRequests.close();for(Gate gate:reads)gate.release.countDown();mainHandler.drain();}
  }
  static final class Session {
    final Host h;final AuthorScreenState screen;final FeedPage[] pages;final String[] tab={"works"};final Runnable[] render;
    Session(Host host,String seed){h=host;screen=new AuthorScreenState(new ShortVideoItem(seed),page("old"),"works","published");pages=new FeedPage[]{screen.page};render=new Runnable[]{()->{h.rendered++;screen.page=pages[0].copy();h.currentScreen=screen;}};h.renderAuthorScreen(screen);}
    void sort(String value){h.applyAuthorSort(screen,pages,tab,render,value);}void more(){h.loadMoreAuthorPage(screen,pages,render);}void initial(){h.loadInitialAuthorPage(screen,pages,render);}String first(){return pages[0].items.get(0).id;}
  }
  static Gate read(Host h,int index)throws Exception{await(()->h.reads.size()>index,"read did not start "+index);return h.reads.get(index);}
  static void deliver(Host h,Gate gate,FeedPage page)throws Exception{gate.success(page);await(()->!h.mainHandler.pending.isEmpty(),"UI completion not posted");h.mainHandler.drain();}
  static void fail(Host h,Gate gate)throws Exception{gate.fail();await(()->!h.mainHandler.pending.isEmpty(),"failure not posted");h.mainHandler.drain();}
  public static void main(String[] args)throws Exception {
    if(args.length>0)selected=args[0];
    test("initial_replaced_by_sort",()->{try(Host h=new Host()){Session s=new Session(h,"a");s.initial();Gate initial=read(h,0);require(s.screen.loadingMore,"initial read must block pagination");s.sort("likes");Gate sorted=read(h,1);deliver(h,sorted,page("likes-current"));deliver(h,initial,page("initial-stale"));require(s.first().equals("likes-current")&&s.screen.sort.equals("likes"),"stale initial reply replaced selected sort");require(h.rendered==1&&h.accepted==1&&!s.screen.loadingMore,"stale initial reply changed UI/loading/actions");}});
    test("rapid_sort_posted_completion",()->{try(Host h=new Host()){Session s=new Session(h,"a");s.sort("likes");Gate old=read(h,0);old.success(page("likes-stale"));await(()->!h.mainHandler.pending.isEmpty(),"old sort not posted");s.sort("duration");Gate latest=read(h,1);h.mainHandler.drain();require(s.screen.loadingMore&&s.first().equals("old"),"posted old reply cleared new loading flag");deliver(h,latest,page("duration-current"));require(s.first().equals("duration-current")&&s.screen.sort.equals("duration")&&h.accepted==1,"latest sort not retained");}});
    test("old_page_after_new_sort",()->{try(Host h=new Host()){Session s=new Session(h,"a");s.more();Gate old=read(h,0);s.sort("duration");Gate latest=read(h,1);deliver(h,latest,page("duration-current"));deliver(h,old,page("published-stale"));require(s.first().equals("duration-current")&&s.pages[0].items.size()==1,"old page replaced new sort");require(h.accepted==1&&!s.screen.loadingMore,"obsolete page changed actions/loading");}});
    test("sort_failure_preserves_committed_page",()->{try(Host h=new Host()){Session s=new Session(h,"a");s.sort("likes");Gate old=read(h,0);s.sort("duration");Gate latest=read(h,1);fail(h,latest);require(s.screen.sort.equals("published")&&s.first().equals("old")&&!s.screen.loadingMore,"failed sort broke page/sort consistency");int before=h.messages.size();fail(h,old);require(h.messages.size()==before,"stale failure surfaced after latest failure");s.more();Gate more=read(h,2);require(more.url.contains(":published:"),"retry pagination used failed sort");deliver(h,more,page("new-page"));require(s.pages[0].items.size()==2,"pagination after sort failure did not recover");}});
    test("pending_sort_blocks_old_pagination",()->{try(Host h=new Host()){Session s=new Session(h,"a");s.sort("likes");Gate sort=read(h,0);s.more();Thread.sleep(25);require(h.reads.size()==1&&s.screen.loadingMore,"old page pagination replaced pending sort");deliver(h,sort,page("sorted"));s.more();Gate more=read(h,1);require(more.url.contains(":likes:"),"fresh pagination lost committed sort");deliver(h,more,page("more"));require(s.pages[0].items.size()==2,"fresh pagination failed");}});
    test("close_and_reopen",()->{for(boolean error:new boolean[]{false,true})try(Host h=new Host()){Session old=new Session(h,"a");old.more();Gate obsolete=read(h,0);h.removeAuthorOverlay();require(obsolete.token.isCancelled()&&!old.screen.loadingMore,"close did not cancel/reset author read");Session next=new Session(h,"a");next.initial();Gate fresh=read(h,1);int renders=h.rendered;if(error)fail(h,obsolete);else deliver(h,obsolete,page("stale"));require(h.currentScreen==next.screen&&h.rendered==renders&&next.screen.loadingMore&&h.messages.isEmpty(),"closed author changed reopened state");deliver(h,fresh,page("fresh"));require(next.first().equals("fresh")&&!next.screen.loadingMore,"reopened author cannot load");}});
    test("screen_identity_guard",()->{try(Host h=new Host()){Session s=new Session(h,"a");s.sort("likes");Gate old=read(h,0);ScreenState next=new AuthorScreenState(new ShortVideoItem("b"),page("b"),"works","published");h.currentScreen=next;deliver(h,old,page("stale"));require(h.currentScreen==next&&h.accepted==0&&h.rendered==0,"obsolete screen restored by callback");}});
    test("page_identity_guard",()->{try(Host h=new Host()){Session s=new Session(h,"a");s.more();Gate old=read(h,0);s.pages[0]=page("replacement");deliver(h,old,page("stale"));require(s.first().equals("replacement")&&h.accepted==0,"obsolete page appended to replacement");}});
    test("stale_failure_keeps_latest_loading",()->{try(Host h=new Host()){Session s=new Session(h,"a");s.initial();Gate old=read(h,0);s.sort("likes");Gate latest=read(h,1);fail(h,old);require(s.screen.loadingMore&&h.messages.isEmpty()&&h.hides==0,"stale failure settled new read");deliver(h,latest,page("latest"));require(!s.screen.loadingMore,"latest read remained pending");}});
    test("normal_deduplicated_pagination",()->{try(Host h=new Host()){Session s=new Session(h,"a");s.more();Gate more=read(h,0);FeedPage next=page("old","new","new");next.offset=1;next.limit=18;next.hasMore=false;next.nextCursor="end";deliver(h,more,next);require(s.pages[0].items.size()==2&&s.pages[0].items.get(1).id.equals("new"),"page deduplication changed");require(!s.pages[0].hasMore&&s.pages[0].nextCursor.equals("end")&&s.pages[0].nextOffset()==19&&!s.screen.loadingMore,"paging metadata/loading changed");int reads=h.reads.size();s.more();Thread.sleep(25);require(h.reads.size()==reads,"exhausted page issued a request");}});
    test("local_sort_cancels_remote",()->{try(Host h=new Host()){Session s=new Session(h,"a");s.sort("likes");Gate old=read(h,0);h.local=true;s.sort("duration");require(s.first().equals("local-duration")&&s.screen.sort.equals("duration")&&!s.screen.loadingMore,"local sort not applied");deliver(h,old,page("old"));require(s.first().equals("local-duration")&&h.accepted==0,"remote reply replaced local sort");}});
    test("back_keeps_committed_author_context",()->{try(Host h=new Host()){Session s=new Session(h,"a");s.sort("duration");Gate old=read(h,0);h.pushCurrentScreen();AuthorScreenState saved=(AuthorScreenState)h.navigationStack.get(0);require(saved.sort.equals("published")&&saved.page.items.get(0).id.equals("old"),"pending sort corrupted Back snapshot");h.renderFeedScreen(new FeedScreenState(List.of(new ShortVideoItem("playing")),"published-feed",0,"",false,0));h.currentIndex=0;h.videos.add(new ShortVideoItem("playing"));h.navigateBack();require(h.currentScreen instanceof AuthorScreenState&&h.currentScreen!=saved,"Back must create a fresh author owner");AuthorScreenState restored=(AuthorScreenState)h.currentScreen;require(restored.sort.equals("published")&&!restored.loadingMore&&restored.currentItem.id.equals("playing")&&restored.hasPlaybackContext,"Back lost committed sort/playback context");deliver(h,old,page("stale"));require(h.currentScreen==restored&&restored.sort.equals("published"),"old request corrupted returned author");}});
    test("finish_and_destroy_reject_callbacks",()->{for(boolean finishing:new boolean[]{false,true})try(Host h=new Host()){Session s=new Session(h,"a");s.initial();Gate old=read(h,0);if(finishing)h.finishing=true;else h.destroying=true;deliver(h,old,page("stale"));require(h.accepted==0&&h.rendered==0,"dead Activity accepted author reply");}});
    System.out.println("native-short-video-author-requests: "+cases+" actual Activity/scheduler/navigation groups passed");
  }
}
final class ShortVideoItem {final String id;ShortVideoItem(String id){this.id=id;}}
final class FeedStats {boolean isEmpty(){return false;}static FeedStats fromItems(List<ShortVideoItem> rows){return new FeedStats();}}
final class FeedPage {int offset,limit=18,total;boolean hasMore;String nextCursor="";FeedStats stats=new FeedStats();final List<ShortVideoItem> items=new ArrayList<>();int nextOffset(){return offset+Math.max(limit,items.size());}FeedPage copy(){FeedPage p=new FeedPage();p.offset=offset;p.limit=limit;p.total=total;p.hasMore=hasMore;p.nextCursor=nextCursor;p.items.addAll(items);p.stats=stats;return p;}}
final class NativeShortVideoFeedPlayback {static final class Snapshot {String itemId;}}
`;
function compileAndRun(name, code, mode = "all", failure = "") {
  const directory = path.join(temp, name);
  fs.mkdirSync(directory, { recursive: true });
  const file = write(`${name}/AuthorRequestsHarness.java`, harness(code));
  const sources = ["NativeShortVideoFeedRequests.java", "NativeShortVideoFeedPaging.java", "NativeShortVideoFeedTransport.java", "NativeShortVideoHttpResponse.java", "NativeShortVideoScreenState.java"].map(file => path.join(javaRoot, file));
  const compiled = spawnSync(path.join(javaHome, "bin/javac.exe"), ["-encoding", "UTF-8", "-d", directory, ...sources, ...stubs, file], { encoding: "utf8", timeout: 30000 });
  assert.equal(compiled.status, 0, compiled.stderr || compiled.error?.message);
  const executed = spawnSync(path.join(javaHome, "bin/java.exe"), ["-cp", directory, "local.fanhao.library.AuthorRequestsHarness", mode], { encoding: "utf8", timeout: 20000 });
  if (failure) {
    assert.notEqual(executed.status, 0, `${name}: negative control survived`);
    assert((executed.stderr || "").includes(failure), `${name}: wrong failure: ${executed.stderr || executed.error?.message}`);
  } else {
    assert.equal(executed.status, 0, executed.stderr || executed.error?.message);
    process.stdout.write(executed.stdout);
  }
}
try {
  compileAndRun("production", production);
  const mutations = [
    ["posted-token", production.replaceAll("!token.isCurrent() || ", ""), "rapid_sort_posted_completion", "posted old reply cleared new loading flag"],
    ["screen-owner", production.replace(/return !destroying && !isFinishing\(\) && overlay != null && authorOverlay == overlay && currentScreen == screen;/, "return overlay != null;"), "screen_identity_guard", "obsolete screen restored by callback"],
    ["page-owner", production.replace(" || pageRef[0] != current", ""), "page_identity_guard", "obsolete page appended to replacement"],
    ["close-cancel", production.replace("feedRequests.cancel();\n      if (currentScreen", "/* cancellation omitted */\n      if (currentScreen"), "close_and_reopen", "close did not cancel/reset author read"],
    ["pending-pagination", production.replace("screen.loadingMore = true;\n    showStatus", "screen.loadingMore = false;\n    showStatus"), "pending_sort_blocks_old_pagination", "old page pagination replaced pending sort"],
    ["eager-sort", production.replace("String requestedSort = normalizeSortParam(sort);", "String requestedSort = normalizeSortParam(sort); screen.sort = requestedSort;"), "sort_failure_preserves_committed_page", "failed sort broke page/sort consistency"]
  ];
  for (const [name, code, mode, failure] of mutations) {
    assert.notEqual(code, production, `${name}: mutation did not change current implementation`);
    compileAndRun(name, code, mode, failure);
  }
  console.log(`native-short-video-author-requests: ${mutations.length} compiled behavioral negative controls rejected`);
} finally {
  const resolved = path.resolve(temp);
  assert(resolved.startsWith(path.resolve(os.tmpdir()) + path.sep));
  if (process.platform === "win32") {
    const cleanup = spawnSync("powershell.exe", ["-NoProfile", "-Command", "$authorTestRoot = [IO.Path]::GetFullPath($env:FANHAO_AUTHOR_TEST_ROOT); $authorTempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()); if (-not $authorTestRoot.StartsWith($authorTempRoot, [StringComparison]::OrdinalIgnoreCase)) { throw 'Unsafe author-test cleanup target' }; Remove-Item -LiteralPath $authorTestRoot -Recurse -Force"], { encoding: "utf8", env: { ...process.env, FANHAO_AUTHOR_TEST_ROOT: resolved }, timeout: 30000 });
    assert.equal(cleanup.status, 0, cleanup.stderr || cleanup.error?.message);
  } else fs.rmSync(resolved, { recursive: true, force: true });
}
