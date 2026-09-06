package local.fanhao.library;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;

/** No real content URI is opened. Latches control provider read/main-thread interleavings. */
public final class NativeTextIntentClaimsHarness {
  private static final List<String> failures = new ArrayList<>();
  private static int passed;

  public static void main(String[] args) throws Exception {
    for (boolean failA : new boolean[] { false, true }) {
      check("A " + (failA ? "failure" : "success") + " must not discard newer B", () -> {
        Activity activity = new Activity();
        FanHaoNovelPlugin plugin = new FanHaoNovelPlugin(activity);
        Intent a = deliver(activity, "A");
        block(plugin);
        plugin.failRead = failA;
        PluginCall first = new PluginCall();
        Thread worker = readInBackground(plugin, first);
        Intent b = deliver(activity, "B");
        finish(plugin, worker);
        require(failA ? failed(first) : available(first, "A"), "first read fixture failed");
        plugin.failRead = false;
        PluginCall next = consume(plugin);
        require(available(next, "B"), "B was erased; activity fallback action=" + activity.getIntent().action);
        activity.drainMain();
        require(activity.getIntent() != a, "consumed original A survived");
      });
    }
    check("overlapping plugin instances can claim a delivery only once", () -> {
      Activity activity = new Activity();
      deliver(activity, "A");
      FanHaoNovelPlugin old = new FanHaoNovelPlugin(activity), replacement = new FanHaoNovelPlugin(activity);
      block(old);
      Thread worker = readInBackground(old, new PluginCall());
      PluginCall second = consume(replacement);
      finish(old, worker);
      require(old.reads + replacement.reads == 1, "same A was read by both plugin instances");
      require(second.result != null && Boolean.TRUE.equals(second.result.get("busy")), "in-flight claim must report busy");
      require(Boolean.FALSE.equals(second.result.get("hasPending")), "in-flight is not another queued delivery");
    });
    check("FIFO preserves A then B then C and exposes remaining work", () -> {
      Activity activity = new Activity();
      FanHaoNovelPlugin plugin = new FanHaoNovelPlugin(activity);
      deliver(activity, "A"); block(plugin);
      PluginCall a = new PluginCall(); Thread worker = readInBackground(plugin, a);
      deliver(activity, "B"); deliver(activity, "C");
      finish(plugin, worker);
      require(available(a, "A") && hasPending(a), "A did not report queued B/C");
      PluginCall b = consume(plugin), c = consume(plugin), empty = consume(plugin);
      require(available(b, "B") && hasPending(b), "B was dropped or reordered");
      require(available(c, "C") && !hasPending(c), "C was dropped or reordered");
      require(empty.result != null && !empty.result.available && !hasPending(empty), "FIFO did not drain");
    });
    check("failed A exposes queued B/C without retaining a poison delivery", () -> {
      Activity activity = new Activity(); FanHaoNovelPlugin plugin = new FanHaoNovelPlugin(activity);
      deliver(activity, "A"); deliver(activity, "B"); deliver(activity, "C");
      plugin.failRead = true; PluginCall a = consume(plugin);
      require(a.error == null && failed(a) && hasPending(a), "failure must resolve message/hasPending so JS can drain");
      plugin.failRead = false;
      require(available(consume(plugin), "B"), "failure blocked B");
      require(available(consume(plugin), "C"), "failure blocked C");
      require(!consume(plugin).result.available, "failed A was requeued automatically");
    });
    check("provider failure allows a later explicit reshare of the same text", () -> {
      Activity activity = new Activity(); FanHaoNovelPlugin plugin = new FanHaoNovelPlugin(activity);
      deliver(activity, "A"); plugin.failRead = true;
      require(failed(consume(plugin)), "first request did not fail");
      plugin.failRead = false; deliver(activity, "A");
      require(available(consume(plugin), "A"), "distinct reshare was mistaken for an old delivery");
    });
    check("failure without provider text still gives a visible message and settles once", () -> {
      Activity activity = new Activity(); FanHaoNovelPlugin plugin = new FanHaoNovelPlugin(activity);
      deliver(activity, "A"); plugin.failRead = true; plugin.blankFailure = true;
      PluginCall first = consume(plugin);
      require(first.error == null && failed(first) && !hasPending(first), "blank provider failure lost error feedback");
      plugin.failRead = false;
      require(!consume(plugin).result.available && plugin.reads == 1, "failed delivery retried without reshare");
    });
    check("successful consumption does not replay Activity fallback before UI cleanup", () -> {
      Activity activity = new Activity(); FanHaoNovelPlugin plugin = new FanHaoNovelPlugin(activity);
      activity.setIntent(Intent.text("A"));
      require(available(consume(plugin), "A"), "fallback was not read");
      require(!consume(plugin).result.available && plugin.reads == 1, "consumed fallback replayed");
      activity.drainMain();
      require(!consume(plugin).result.available && plugin.reads == 1, "cleanup recreated fallback work");
    });
    check("duplicate captures of the original Intent never repeat a delivery", () -> {
      Activity activity = new Activity(); FanHaoNovelPlugin plugin = new FanHaoNovelPlugin(activity);
      Intent a = deliver(activity, "A");
      FanHaoNovelPlugin.capturePendingTextIntent(activity, a);
      require(available(consume(plugin), "A"), "first delivery missing");
      FanHaoNovelPlugin.capturePendingTextIntent(activity, a);
      require(!consume(plugin).result.available && plugin.reads == 1, "same original Intent was offered again");
    });
    check("same-text distinct Intents stay distinct FIFO deliveries", () -> {
      Activity activity = new Activity(); FanHaoNovelPlugin plugin = new FanHaoNovelPlugin(activity);
      deliver(activity, "same"); deliver(activity, "same");
      require(available(consume(plugin), "same"), "first equal-content delivery missing");
      require(available(consume(plugin), "same") && plugin.reads == 2, "identity dedupe collapsed distinct deliveries");
    });
    check("queued Intent metadata is a snapshot", () -> {
      Activity activity = new Activity(); FanHaoNovelPlugin plugin = new FanHaoNovelPlugin(activity);
      Intent a = deliver(activity, "original"); a.text = "mutated";
      require(available(consume(plugin), "original"), "external Intent mutation changed captured data");
    });
    check("late A cleanup runs on main and cannot overwrite B fallback", () -> {
      Activity activity = new Activity(); FanHaoNovelPlugin plugin = new FanHaoNovelPlugin(activity);
      deliver(activity, "same"); block(plugin);
      Thread worker = readInBackground(plugin, new PluginCall());
      finish(plugin, worker);
      Intent b = deliver(activity, "same");
      activity.drainMain();
      require(activity.getIntent() == b, "A cleanup cleared the newer B Intent");
      require(activity.offMainIntentWrites == 0, "plugin thread mutated Activity Intent directly");
      require(available(consume(plugin), "same"), "B missing after main-thread cleanup");
    });
    check("busy with B queued reports both busy and pending without reading B", () -> {
      Activity activity = new Activity(); FanHaoNovelPlugin old = new FanHaoNovelPlugin(activity), next = new FanHaoNovelPlugin(activity);
      deliver(activity, "A"); block(old); Thread worker = readInBackground(old, new PluginCall());
      deliver(activity, "B"); PluginCall busy = consume(next);
      finish(old, worker);
      require(busy.result != null && Boolean.TRUE.equals(busy.result.get("busy")) && hasPending(busy), "busy/pending status omitted");
      require(next.reads == 0 && available(consume(next), "B"), "overlapping consume stole queued B");
    });
    check("unsupported delivery reports its message and does not block later text", () -> {
      Activity activity = new Activity(); FanHaoNovelPlugin plugin = new FanHaoNovelPlugin(activity);
      Intent unsupported = new Intent("UNSUPPORTED"); activity.setIntent(unsupported);
      FanHaoNovelPlugin.capturePendingTextIntent(activity, unsupported); deliver(activity, "B");
      PluginCall first = consume(plugin);
      require(failed(first) && hasPending(first), "unsupported response hid queued text");
      require(available(consume(plugin), "B") && plugin.reads == 1, "unsupported delivery invoked reader or blocked B");
    });
    check("released bridge call cannot claim or consume pending text", () -> {
      Activity activity = new Activity(); FanHaoNovelPlugin plugin = new FanHaoNovelPlugin(activity);
      deliver(activity, "A"); PluginCall released = new PluginCall(); released.released = true;
      plugin.consumePendingTextFile(released);
      require(released.result == null && plugin.reads == 0, "released call consumed data");
      require(available(consume(plugin), "A"), "live caller lost released caller's delivery");
    });

    boolean legacy = Arrays.asList(args).contains("--legacy");
    System.out.println((legacy ? "Legacy controls: " : "Native text intent claims: ") + passed + " passed; " + failures.size() + " failed.");
    for (String failure : failures) System.out.println((legacy ? "CONTROL reproduced " : "FAIL ") + failure);
    if (legacy) {
      for (String expected : new String[] { "A success must not discard newer B", "A failure must not discard newer B", "overlapping plugin instances can claim a delivery only once" }) {
        require(failures.stream().anyMatch(failure -> failure.startsWith(expected + ":")), "legacy control no longer reproduces " + expected);
      }
    } else require(failures.isEmpty(), "pending text claim contract failed");
  }

  private interface Check { void run() throws Exception; }
  private static void check(String name, Check check) {
    FanHaoNovelPlugin.testReset();
    try { check.run(); passed++; System.out.println("PASS " + name); }
    catch (Exception | AssertionError error) { failures.add(name + ": " + error.getMessage()); }
  }
  private static Intent deliver(Activity activity, String text) {
    Intent intent = Intent.text(text); activity.setIntent(intent);
    FanHaoNovelPlugin.capturePendingTextIntent(activity, intent); return intent;
  }
  private static void block(FanHaoNovelPlugin plugin) { plugin.entered = new CountDownLatch(1); plugin.release = new CountDownLatch(1); }
  private static Thread readInBackground(FanHaoNovelPlugin plugin, PluginCall call) throws Exception {
    Thread worker = new Thread(() -> plugin.consumePendingTextFile(call)); worker.start();
    require(plugin.entered.await(5, TimeUnit.SECONDS), "read did not start"); return worker;
  }
  private static void finish(FanHaoNovelPlugin plugin, Thread worker) throws Exception {
    plugin.release.countDown(); worker.join(5000); require(!worker.isAlive(), "read did not finish");
    plugin.entered = null; plugin.release = null;
  }
  private static PluginCall consume(FanHaoNovelPlugin plugin) { PluginCall call = new PluginCall(); plugin.consumePendingTextFile(call); return call; }
  private static boolean available(PluginCall call, String text) { return call.result != null && call.result.available && text.equals(call.result.text); }
  private static boolean failed(PluginCall call) {
    Object message = call.result == null ? null : call.result.get("message");
    return call.error != null || call.result != null && !call.result.available && message instanceof String && !((String) message).trim().isEmpty();
  }
  private static boolean hasPending(PluginCall call) { return call.result != null && Boolean.TRUE.equals(call.result.get("hasPending")); }
  private static void require(boolean value, String message) { if (!value) throw new AssertionError(message); }
}
