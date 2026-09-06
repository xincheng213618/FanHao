package local.fanhao.library;

import androidx.media3.exoplayer.ExoPlayer;
import androidx.media3.common.Player;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLConnection;
import java.net.URLStreamHandler;
import java.nio.charset.StandardCharsets;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.AbstractExecutorService;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

public final class NativeVideoProgressHarness {
  private static final String URL_A = "http://progress.test/api/progress";
  private static final List<String> failures = new ArrayList<>();
  private static int cases, legacyFailures;

  public static void main(String[] args) throws Exception {
    FakeTransport.install();
    check("legacy final-progress regression is detectable", () -> rejectLegacy("destroy final snapshot", NativeVideoProgressHarness::finalProgress));
    check("legacy background ticker regression is detectable", () -> rejectLegacy("background ticker", NativeVideoProgressHarness::backgroundTicker));
    check("legacy late-bound identity regression is detectable", () -> rejectLegacy("snapshot identity", NativeVideoProgressHarness::snapshotIdentity));
    check("legacy unbounded queue regression is detectable", () -> rejectLegacy("bounded queue", NativeVideoProgressHarness::boundedQueue));
    check("destroy preserves the final accepted player position", () -> finalProgress(new Fixture(false)));
    check("pause removes the background ticker", () -> backgroundTicker(new Fixture(false)));
    check("queued snapshot does not retain mutable Activity fields", () -> snapshotIdentity(new Fixture(false)));
    check("rapid reports retain only one bounded latest task", () -> boundedQueue(new Fixture(false)));

    check("legacy startup IDLE reports are rejected by the new safety oracle", () -> rejectLegacy("startup IDLE sample", f -> unreadySample(f, Player.STATE_IDLE, "ticker", 3500)));
    check("legacy loading BUFFERING reports are rejected by the new safety oracle", () -> rejectLegacy("loading BUFFERING sample", f -> unreadySample(f, Player.STATE_BUFFERING, "pause", 3500)));
    check("legacy error-IDLE can overwrite a previously accepted position", () -> rejectLegacy("error IDLE sample", f -> preservesReadySnapshot(f, Player.STATE_IDLE)));
    for (int state : new int[] { Player.STATE_IDLE, Player.STATE_BUFFERING }) {
      for (String entry : new String[] { "ticker", "pause", "destroy" }) {
        check("unready state " + state + " cannot report through " + entry, () -> {
          for (long position : new long[] { 0, 3500 }) {
            Fixture f = new Fixture(false);
            try { unreadySample(f, state, entry, position); } finally { f.finish(); }
          }
        });
      }
      check("unready state " + state + " preserves the last READY snapshot", () -> {
        Fixture f = new Fixture(false);
        try { preservesReadySnapshot(f, state); } finally { f.finish(); }
      });
    }
    for (int state : new int[] { Player.STATE_READY, Player.STATE_ENDED }) {
      check("accepted playback state " + state + " reports through ticker pause and destroy", () -> {
        Fixture f = new Fixture(false); f.host.player.playbackState = state;
        f.host.player.position = 73250; f.host.player.duration = 120000;
        f.host.onResume(); f.host.handler.runPending(); f.executor.runAll();
        near(last(f.sent).position, 73.25, "valid ticker sample");
        f.host.player.position = 75250; f.host.onPause(); f.executor.runAll();
        near(last(f.sent).position, 75.25, "valid pause sample");
        f.host.player.position = 77250; f.host.onDestroy(); f.executor.runAll();
        near(last(f.sent).position, 77.25, "valid final sample");
        require(f.sent.size() == 3, "READY/ENDED samples were suppressed");
      });
    }
    check("loading startup does not throttle the first READY sample", () -> {
      Fixture f = new Fixture(false); f.host.player.playbackState = Player.STATE_BUFFERING;
      f.host.player.position = 0; f.host.player.duration = -1; f.host.probedDurationSeconds = 3600;
      f.host.reportProgress(false); require(f.host.lastProgressAt == 0, "loading startup advanced throttle");
      f.host.player.playbackState = Player.STATE_READY; f.host.player.position = 85400;
      f.host.reportProgress(false); f.executor.runAll();
      near(last(f.sent).position, 85.4, "first READY resume position"); near(last(f.sent).duration, 3600, "probed duration still applies"); f.finish();
    });

    check("resume deduplicates ticker and pause force-reports without autoplay", () -> {
      Fixture f = new Fixture(false);
      f.host.onResume(); f.host.onResume();
      require(f.host.handler.pending.size() == 1, "resume queued duplicate tickers");
      require(f.host.barsHidden == 2, "resume did not restore immersive bars");
      f.host.handler.runPending();
      require(f.host.handler.pending.size() == 1 && f.host.handler.lastDelay == 5000, "ticker must reschedule at five seconds");
      f.host.player.position = 42000;
      f.host.onPause(); f.executor.runAll();
      near(last(f.sent).position, 42, "pause must bypass the ticker throttle");
      require(f.host.player.paused && f.host.player.pauses == 1, "pause did not pause the player");
      require(f.host.handler.pending.isEmpty(), "background ticker remains queued");
      int reads = f.host.player.reads;
      f.host.handler.runPending();
      require(f.host.player.reads == reads, "background handler read the player");
      f.host.onResume();
      require(f.host.handler.pending.size() == 1, "return did not restart ticker");
      require(f.host.player.paused, "return must not discard manual/lifecycle pause");
      f.finish();
    });
    check("destroy cancels all callbacks and releases exactly once", () -> {
      Fixture f = new Fixture(false); ExoPlayer player = f.host.player;
      f.host.onResume();
      f.host.handler.post(f.host.statusHideRunnable); f.host.handler.post(f.host.overlayHideRunnable);
      f.host.onDestroy(); f.host.onDestroy();
      require(f.host.handler.pending.isEmpty(), "destroy left UI callbacks behind");
      require(player.released && player.releases == 1 && f.host.player == null, "destroy release/null ordering is incorrect");
      require(f.executor.shutdownCalls == 1 && f.executor.shutdownNowCalls == 0, "destroy must close without cancelling accepted tasks");
      f.executor.runAll(); f.host.handler.runPending();
      require(f.sent.size() == 1, "idempotent destroy lost/duplicated its final report");
    });
    check("null player lifecycle is safe and never starts ticker", () -> {
      Fixture f = new Fixture(false); f.host.player = null;
      f.host.reportProgress(true); f.host.onResume(); f.host.onPause(); f.host.onDestroy();
      f.host.handler.runPending(); f.executor.runAll();
      require(f.sent.isEmpty() && f.host.handler.pending.isEmpty(), "null player emitted progress or ticker");
    });
    check("ordinary samples respect throttle while forced samples bypass it", () -> {
      Fixture f = new Fixture(false);
      f.host.lastProgressAt = Long.MAX_VALUE; f.host.reportProgress(false);
      require(f.executor.tasks.isEmpty(), "ordinary report bypassed throttle");
      f.host.reportProgress(true); f.executor.runAll();
      require(f.sent.size() == 1, "forced report was throttled"); f.finish();
    });
    check("direct media uses absolute player time in seconds", () -> {
      Fixture f = new Fixture(false); f.host.player.position = 81234; f.host.player.duration = 7312456;
      f.host.reportProgress(true); f.executor.runAll();
      near(last(f.sent).position, 81.234, "direct position"); near(last(f.sent).duration, 7312.456, "direct duration"); f.finish();
    });
    check("fallback stream position and known duration include original offset", () -> {
      Fixture f = new Fixture(false); f.host.streamOffsetMs = 3600123;
      f.host.player.position = 12500; f.host.player.duration = 120000;
      f.host.reportProgress(true); f.executor.runAll();
      near(last(f.sent).position, 3612.623, "fallback absolute position");
      near(last(f.sent).duration, 3720.123, "fallback total duration"); f.finish();
    });
    check("probed duration stays absolute and is not offset twice", () -> {
      Fixture f = new Fixture(false); f.host.streamOffsetMs = 3600000;
      f.host.player.position = 45500; f.host.player.duration = Long.MIN_VALUE + 1;
      f.host.probedDurationSeconds = 7210.875;
      f.host.reportProgress(true); f.executor.runAll();
      near(last(f.sent).position, 3645.5, "probed absolute position");
      near(last(f.sent).duration, 7210.875, "probed duration must not add offset"); f.finish();
    });
    check("temporarily unknown duration preserves the last valid pending snapshot", () -> {
      Fixture f = new Fixture(false); f.host.player.position = 62000; f.host.reportProgress(true);
      f.host.player.position = 79000; f.host.player.duration = Long.MIN_VALUE + 1;
      f.host.onPause(); f.host.onDestroy(); f.executor.runAll();
      require(f.sent.size() == 1, "unknown duration dropped/overwrote valid pending snapshot");
      near(last(f.sent).position, 62, "last valid position"); near(last(f.sent).duration, 120, "last valid duration");
    });
    for (double invalidProbe : new double[] { 0, -5, Double.NaN, Double.POSITIVE_INFINITY }) {
      check("unavailable duration is skipped: probe=" + invalidProbe, () -> {
        Fixture f = new Fixture(false); f.host.player.duration = -1; f.host.probedDurationSeconds = invalidProbe;
        f.host.reportProgress(true); f.host.onDestroy(); f.executor.runAll();
        require(f.sent.isEmpty() && f.host.lastProgressAt == 0, "invalid duration advanced saved progress/throttle");
      });
    }
    check("negative player position is clamped before reporting", () -> {
      Fixture f = new Fixture(false); f.host.player.position = -6000;
      f.host.reportProgress(true); f.executor.runAll(); near(last(f.sent).position, 0, "negative player position"); f.finish();
    });
    check("invalid helper inputs cannot replace a valid pending snapshot", () -> {
      ManualExecutor executor = new ManualExecutor(); List<NativePlaybackProgress.Snapshot> sent = new ArrayList<>();
      NativePlaybackProgress progress = new NativePlaybackProgress(executor, sent::add);
      progress.report(URL_A, "accepted", 15, 120);
      for (String url : new String[] { null, "", "  ", "not a url", "ftp://progress.test/file", "http:///missing-host" }) {
        progress.report(url, "invalid", 99, 120);
      }
      for (double position : new double[] { -1, Double.NaN, Double.POSITIVE_INFINITY, Double.NEGATIVE_INFINITY }) {
        progress.report(URL_A, "invalid", position, 120);
      }
      for (double duration : new double[] { 0, -1, Double.NaN, Double.POSITIVE_INFINITY, Double.NEGATIVE_INFINITY }) {
        progress.report(URL_A, "invalid", 99, duration);
      }
      progress.close(); executor.runAll();
      require(sent.size() == 1 && "accepted".equals(last(sent).workId), "invalid report replaced an accepted snapshot");
      near(last(sent).position, 15, "valid pending position");
    });
    check("close is idempotent and rejects subsequent valid reports", () -> {
      ManualExecutor executor = new ManualExecutor(); List<NativePlaybackProgress.Snapshot> sent = new ArrayList<>();
      NativePlaybackProgress progress = new NativePlaybackProgress(executor, sent::add);
      progress.report(URL_A, "before", 15, 120); progress.close(); progress.close();
      progress.report(URL_A, "after", 99, 120); executor.runAll();
      require(sent.size() == 1 && "before".equals(last(sent).workId), "post-close report was accepted");
      require(executor.shutdownCalls == 1 && executor.shutdownNowCalls == 0, "close must use one orderly shutdown");
    });
    check("empty close schedules nothing", () -> {
      ManualExecutor executor = new ManualExecutor();
      NativePlaybackProgress progress = new NativePlaybackProgress(executor, snapshot -> { throw new AssertionError("unexpected send"); });
      progress.close(); progress.report(URL_A, "after", 15, 120); executor.runAll();
      require(executor.executeCalls == 0 && executor.shutdownCalls == 1, "empty close started work");
    });
    check("send failure still drains newer final snapshot after close", () -> {
      ManualExecutor executor = new ManualExecutor(); List<NativePlaybackProgress.Snapshot> sent = new ArrayList<>();
      NativePlaybackProgress[] owner = new NativePlaybackProgress[1];
      owner[0] = new NativePlaybackProgress(executor, snapshot -> {
        sent.add(snapshot);
        if (sent.size() == 1) {
          for (int index = 2; index <= 5000; index++) owner[0].report(URL_A, "final", index, 6000);
          owner[0].close(); throw new IOException("first request failed");
        }
      });
      owner[0].report(URL_A, "first", 1, 6000); executor.runAll();
      require(sent.size() == 2, "failure did not retain just the latest pending report");
      near(sent.get(0).position, 1, "first in-flight snapshot"); near(sent.get(1).position, 5000, "latest final snapshot");
      require(executor.maximumQueued <= 1 && executor.shutdownNowCalls == 0, "failure recovery grew/cancelled queue");
    });
    check("a drained controller accepts later updates until closed", () -> {
      ManualExecutor executor = new ManualExecutor(); List<NativePlaybackProgress.Snapshot> sent = new ArrayList<>();
      NativePlaybackProgress progress = new NativePlaybackProgress(executor, sent::add);
      progress.report(URL_A, "first", 1, 120); executor.runAll();
      progress.report(URL_A, "second", 2, 120); executor.runAll(); progress.close();
      require(sent.size() == 2, "draining flag stranded a later update");
    });
    check("rejected executor is best effort and a later accepted report recovers", () -> {
      ManualExecutor executor = new ManualExecutor(); List<NativePlaybackProgress.Snapshot> sent = new ArrayList<>();
      NativePlaybackProgress progress = new NativePlaybackProgress(executor, sent::add);
      executor.reject = true; progress.report(URL_A, "rejected", 1, 120);
      executor.reject = false; progress.report(URL_A, "accepted", 2, 120); progress.close(); executor.runAll();
      require(sent.size() == 1 && "accepted".equals(last(sent).workId), "rejection escaped or stranded recovery");
    });
    check("blocked send permits bounded concurrent reports and nonblocking close", NativeVideoProgressHarness::blockedSend);
    check("default sender preserves POST JSON and connection cleanup", () -> transport("success"));
    check("output failure disconnects and keeps final pending transport", () -> transport("write-error"));
    check("response failure disconnects and keeps final pending transport", () -> transport("response-error"));
    if (!failures.isEmpty()) throw new AssertionError(String.join("\n", failures));
    System.out.println("native-video-progress: " + cases + " lifecycle/delivery/transport cases passed; "
      + legacyFailures + " legacy regressions reproduced (no device or network)");
  }

  private static void finalProgress(Fixture f) {
    f.host.reportProgress(true); f.host.player.position = 98765; f.host.onDestroy(); f.executor.runAll();
    require(!f.sent.isEmpty(), "destroy discarded the final queued progress");
    near(last(f.sent).position, 98.765, "destroy final position");
  }

  private static void unreadySample(Fixture f, int state, String entry, long position) {
    f.host.player.playbackState = state; f.host.player.position = position;
    f.host.player.duration = -1; f.host.probedDurationSeconds = 3600;
    if ("ticker".equals(entry)) {
      f.host.handler.post(f.host.ticker()); f.host.handler.runPending();
    } else if ("pause".equals(entry)) f.host.onPause();
    else if ("destroy".equals(entry)) f.host.onDestroy();
    else throw new AssertionError("unknown sample entry " + entry);
    f.executor.runAll();
    require(f.sent.isEmpty(), "unready playback emitted a position that can replace server progress: state=" + state + ", entry=" + entry);
    require(f.host.lastProgressAt == 0, "unready playback advanced the progress throttle");
  }

  private static void preservesReadySnapshot(Fixture f, int nextState) {
    f.host.player.playbackState = Player.STATE_READY; f.host.player.position = 85400;
    f.host.reportProgress(true); // Leave the accepted READY sample pending.
    f.host.player.playbackState = nextState; f.host.player.position = 3500;
    f.host.player.duration = -1; f.host.probedDurationSeconds = 3600;
    f.host.onPause(); f.executor.runAll();
    require(f.sent.size() == 1, "loading/error sample replaced or followed the last READY snapshot");
    near(last(f.sent).position, 85.4, "last READY position survives loading/error state");
  }

  private static void backgroundTicker(Fixture f) {
    f.host.handler.post(f.host.ticker()); f.host.onPause();
    try { require(f.host.handler.pending.isEmpty(), "paused Activity kept its periodic ticker"); }
    finally { f.finish(); }
  }

  private static void snapshotIdentity(Fixture f) {
    f.host.reportProgress(true); f.host.progressUrl = "http://other.test/changed"; f.host.workId = "changed";
    f.host.player.position = 99999; f.host.player.duration = 999999; f.executor.runAll();
    try {
      require(URL_A.equals(last(f.sent).url) && "work-original".equals(last(f.sent).workId), "queued send read mutated Activity identity");
      near(last(f.sent).position, 12.5, "captured position"); near(last(f.sent).duration, 120, "captured duration");
    } finally { f.finish(); }
  }

  private static void boundedQueue(Fixture f) {
    for (int index = 1; index <= 10000; index++) { f.host.player.position = index * 1000L; f.host.reportProgress(true); }
    try {
      require(f.executor.maximumQueued <= 1, "one request per sample grew an unbounded executor queue");
      f.executor.runAll(); require(f.sent.size() == 1, "coalesced pending samples should send only the latest");
      near(last(f.sent).position, 10000, "latest queued position");
    } finally { f.finish(); }
  }

  private static void rejectLegacy(String name, FixtureAssertion assertion) throws Exception {
    Fixture fixture = new Fixture(true);
    try {
      assertion.run(fixture);
    } catch (AssertionError expected) {
      legacyFailures++;
      System.out.println("legacy negative control rejected [" + name + "]: " + expected.getMessage());
      return;
    } finally { fixture.finish(); }
    throw new AssertionError("regression oracle incorrectly accepted the legacy " + name);
  }

  private static void blockedSend() throws Exception {
    RecordingPool executor = new RecordingPool(); ExecutorService producers = Executors.newFixedThreadPool(4);
    CountDownLatch started = new CountDownLatch(1), release = new CountDownLatch(1), finished = new CountDownLatch(1);
    List<NativePlaybackProgress.Snapshot> sent = new CopyOnWriteArrayList<>();
    AtomicInteger active = new AtomicInteger(), maximumActive = new AtomicInteger(), interrupted = new AtomicInteger();
    NativePlaybackProgress progress = new NativePlaybackProgress(executor, snapshot -> {
      int sending = active.incrementAndGet(); maximumActive.accumulateAndGet(sending, Math::max);
      try {
        sent.add(snapshot);
        if (snapshot.position == 1) {
          started.countDown();
          try { require(release.await(5, TimeUnit.SECONDS), "fixture never released blocked send"); }
          catch (InterruptedException error) { interrupted.incrementAndGet(); throw error; }
        }
        if (snapshot.position == 99999) finished.countDown();
      } finally { active.decrementAndGet(); }
    });
    try {
      progress.report(URL_A, "first", 1, 100000); await(started, "first network send did not start");
      List<Future<?>> updates = new ArrayList<>();
      for (int producer = 0; producer < 4; producer++) {
        final int producerId = producer;
        updates.add(producers.submit(() -> {
          for (int index = 0; index < 1000; index++) progress.report(URL_A, "pending", 2 + producerId * 1000 + index, 100000);
        }));
      }
      for (Future<?> update : updates) update.get(2, TimeUnit.SECONDS);
      producers.submit(() -> { progress.report(URL_A, "final", 99999, 100000); progress.close(); }).get(2, TimeUnit.SECONDS);
      require(sent.size() == 1, "pending requests ran while the first request was blocked");
      require(executor.executeCalls.get() == 1 && executor.getQueue().isEmpty(), "slow network accumulated executor jobs");
      require(executor.shutdownNowCalls.get() == 0 && interrupted.get() == 0, "close interrupted the in-flight request");
      release.countDown(); await(finished, "close lost the latest pending final report");
      require(executor.awaitTermination(3, TimeUnit.SECONDS), "closed drain did not terminate");
      require(sent.size() == 2 && maximumActive.get() == 1, "delivery was not serial/latest-only");
      near(sent.get(0).position, 1, "first request ordering"); near(sent.get(1).position, 99999, "final request ordering");
    } finally {
      release.countDown(); progress.close(); producers.shutdown();
      require(producers.awaitTermination(3, TimeUnit.SECONDS), "producer cleanup did not terminate");
      require(executor.awaitTermination(3, TimeUnit.SECONDS), "delivery cleanup did not terminate");
    }
  }

  private static void transport(String mode) throws Exception {
    boolean failure = !"success".equals(mode);
    FakeTransport.reset(failure ? 2 : 1, failure);
    java.net.CookieHandler.setDefault(new ServerAuthSession());
    NativePlaybackProgress progress = new NativePlaybackProgress("http://progress.test", "", null);
    try {
      progress.report("http://progress.test/" + mode, "work-id", 15.25, 9020.5);
      if (failure) {
        await(FakeTransport.entered, "default sender did not reach its fake connection");
        progress.report("http://progress.test/final", "final-work", 33.5, 9020.5);
      }
      progress.close(); FakeTransport.release.countDown();
      await(FakeTransport.disconnected, "default sender failed to disconnect/drain");
      require(FakeTransport.connections.size() == (failure ? 2 : 1), "transport lost its pending final request");
      for (FakeConnection connection : FakeTransport.connections) {
        require(connection.disconnected, "connection was not disconnected");
        require(connection.getConnectTimeout() == 3500 && connection.getReadTimeout() == 3500, "transport timeout contract changed");
        require("POST".equals(connection.getRequestMethod()) && connection.getDoOutput(), "transport must POST its JSON body");
        require("application/json; charset=utf-8".equals(connection.getRequestProperty("Content-Type")), "JSON content type changed");
      }
      FakeConnection delivered = FakeTransport.connections.get(FakeTransport.connections.size() - 1);
      String body = delivered.bytes.toString(StandardCharsets.UTF_8);
      String work = failure ? "final-work" : "work-id";
      String position = failure ? "33.5" : "15.25";
      require(body.equals("{\"workId\":\"" + work + "\",\"position\":" + position + ",\"duration\":9020.5}"), "JSON field/value contract changed: " + body);
      require(delivered.length() == delivered.bytes.size() && delivered.responseRead, "body length/response handling changed");
    } finally { FakeTransport.release.countDown(); progress.close(); }
  }

  private static final class Fixture {
    final ManualExecutor executor = new ManualExecutor();
    final List<NativePlaybackProgress.Snapshot> sent = new ArrayList<>();
    final NativeVideoProgressHostBase host;
    Fixture(boolean legacy) {
      host = legacy ? new LegacyNativeVideoProgressHost(executor, sent::add)
        : new NativeVideoProgressHost(new NativePlaybackProgress(executor, sent::add));
    }
    void finish() {
      if (host.player != null) host.onDestroy();
      executor.runAll();
    }
  }

  private static final class ManualExecutor extends AbstractExecutorService {
    final ArrayDeque<Runnable> tasks = new ArrayDeque<>();
    boolean shutdown, reject;
    int shutdownCalls, shutdownNowCalls, executeCalls, maximumQueued;
    public void shutdown() { shutdownCalls++; shutdown = true; }
    public List<Runnable> shutdownNow() {
      shutdownNowCalls++; shutdown = true; List<Runnable> discarded = new ArrayList<>(tasks); tasks.clear(); return discarded;
    }
    public boolean isShutdown() { return shutdown; }
    public boolean isTerminated() { return shutdown && tasks.isEmpty(); }
    public boolean awaitTermination(long time, TimeUnit unit) { return isTerminated(); }
    public void execute(Runnable task) {
      executeCalls++;
      if (shutdown || reject) throw new RejectedExecutionException("fixture rejection");
      tasks.add(task); maximumQueued = Math.max(maximumQueued, tasks.size());
    }
    void runAll() {
      int budget = 10020;
      while (!tasks.isEmpty()) {
        require(budget-- > 0, "delivery loop did not settle"); tasks.removeFirst().run();
      }
    }
  }

  private static final class RecordingPool extends ThreadPoolExecutor {
    final AtomicInteger executeCalls = new AtomicInteger(), shutdownNowCalls = new AtomicInteger();
    RecordingPool() { super(4, 4, 0, TimeUnit.MILLISECONDS, new LinkedBlockingQueue<>()); }
    @Override public void execute(Runnable task) { executeCalls.incrementAndGet(); super.execute(task); }
    @Override public List<Runnable> shutdownNow() { shutdownNowCalls.incrementAndGet(); return super.shutdownNow(); }
  }

  private static final class FakeTransport {
    static final List<FakeConnection> connections = new CopyOnWriteArrayList<>();
    static CountDownLatch entered, release, disconnected;
    static void install() {
      URL.setURLStreamHandlerFactory(protocol -> {
        if (!"http".equals(protocol) && !"https".equals(protocol)) return null;
        return new URLStreamHandler() {
          @Override protected URLConnection openConnection(URL url) {
            FakeConnection connection = new FakeConnection(url); connections.add(connection); return connection;
          }
        };
      });
    }
    static void reset(int expected, boolean block) {
      connections.clear(); entered = new CountDownLatch(1); release = new CountDownLatch(block ? 1 : 0);
      disconnected = new CountDownLatch(expected);
    }
  }

  private static final class FakeConnection extends HttpURLConnection {
    final ByteArrayOutputStream bytes = new ByteArrayOutputStream();
    volatile boolean disconnected, responseRead;
    FakeConnection(URL url) { super(url); }
    public void connect() {}
    public boolean usingProxy() { return false; }
    public void disconnect() { disconnected = true; FakeTransport.disconnected.countDown(); }
    int length() { return fixedContentLength; }
    public OutputStream getOutputStream() throws IOException {
      FakeTransport.entered.countDown();
      try { require(FakeTransport.release.await(5, TimeUnit.SECONDS), "fake transport was never released"); }
      catch (InterruptedException error) { throw new IOException("transport interrupted", error); }
      if (url.getPath().contains("write-error")) throw new IOException("simulated write error");
      return bytes;
    }
    public int getResponseCode() throws IOException {
      responseRead = true;
      if (url.getPath().contains("response-error")) throw new IOException("simulated response error");
      return 200;
    }
  }

  private interface Case { void run() throws Exception; }
  private interface FixtureAssertion { void run(Fixture fixture) throws Exception; }
  private static void check(String name, Case action) {
    cases++;
    try { action.run(); } catch (Throwable error) { failures.add(name + ": " + error); }
  }
  private static NativePlaybackProgress.Snapshot last(List<NativePlaybackProgress.Snapshot> sent) {
    require(!sent.isEmpty(), "no progress was delivered"); return sent.get(sent.size() - 1);
  }
  private static void await(CountDownLatch latch, String message) throws InterruptedException {
    require(latch.await(3, TimeUnit.SECONDS), message);
  }
  private static void near(double actual, double expected, String message) {
    require(Math.abs(actual - expected) < 0.000001, message + ": expected " + expected + " but got " + actual);
  }
  private static void require(boolean value, String message) { if (!value) throw new AssertionError(message); }
}
