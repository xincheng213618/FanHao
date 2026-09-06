package local.fanhao.library;

import java.util.ArrayList;
import java.util.EnumSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Random;
import java.util.concurrent.Callable;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.CyclicBarrier;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

/** Pure-JVM behavior checks against the entire production helper, without Android doubles. */
public final class VisionVisibilityVerifier {
  private static final AtomicInteger checks = new AtomicInteger();
  private static final long TRACE_SEED = 0x5EEDCAFEBABEL;
  private static final int[] REASONS = { 1, 2, 4 };
  private static final int[] INVALID_REASONS = { 0, -1, 3, 5, 6, 7, 8, 16, Integer.MIN_VALUE, Integer.MAX_VALUE };

  private interface Scenario { void run() throws Exception; }
  private static void check(boolean condition, String message) {
    checks.incrementAndGet();
    if (!condition) throw new AssertionError(message);
  }
  private static void invalid(Runnable operation, String message) {
    try { operation.run(); }
    catch (IllegalArgumentException expected) { checks.incrementAndGet(); return; }
    throw new AssertionError(message);
  }
  private static void await(CountDownLatch latch) throws Exception {
    check(latch.await(5, TimeUnit.SECONDS), "deterministic worker phase timed out");
  }
  private static void joined(Thread worker) throws Exception {
    worker.join(5000);
    check(!worker.isAlive(), "deterministic worker did not terminate");
  }

  private static void initialContract() {
    VisionCaptureLifecycle owner = new VisionCaptureLifecycle();
    check(VisionCaptureLifecycle.BACKGROUND == 1 && VisionCaptureLifecycle.EXIT_CONFIRMATION == 2
      && VisionCaptureLifecycle.FATAL_ERROR == 4, "reason constants must preserve their published identities");
    check(owner.isAlive() && !owner.isSuspended() && !owner.isCompleted(), "helper initially active for existing callers");
    check(owner.generation() == 0 && owner.accepts(0) && owner.canCapture(0), "initial callback token is usable");
    check(!owner.accepts(-1) && !owner.accepts(1), "only the current generation is accepted");
    for (int reason : REASONS) check(!owner.isSuspended(reason), "no reason is initially held");
  }

  private static void reasonEdges() {
    VisionCaptureLifecycle owner = new VisionCaptureLifecycle();
    for (int reason : REASONS) {
      long activeToken = owner.generation();
      check(owner.suspend(reason), "a new suspension owner must change state");
      check(owner.generation() == activeToken + 1, "suspend edge must increment generation");
      long pausedToken = owner.generation();
      check(owner.isAlive() && owner.isSuspended() && owner.isSuspended(reason), "suspension is not terminal destruction");
      check(!owner.accepts(pausedToken) && !owner.canCapture(pausedToken), "paused accepts must reject even the current token");
      check(!owner.accepts(activeToken), "suspension invalidates the earlier callback");
      check(!owner.suspend(reason), "duplicate suspend must report no change");
      check(owner.generation() == pausedToken, "duplicate suspend must not invalidate again");
      check(owner.resume(reason), "releasing a held reason must change state");
      check(owner.generation() == pausedToken + 1, "resume edge must increment generation");
      long resumedToken = owner.generation();
      check(!owner.isSuspended() && owner.canCapture(resumedToken), "last release re-enables fresh capture");
      check(!owner.accepts(activeToken) && !owner.accepts(pausedToken), "pause and resume must never revive either old token");
      check(!owner.resume(reason), "duplicate resume must report no change");
      check(owner.generation() == resumedToken, "duplicate resume must not invalidate again");
    }
  }

  private static void overlapAllOrders() {
    int[][] permutations = { {1,2,4}, {1,4,2}, {2,1,4}, {2,4,1}, {4,1,2}, {4,2,1} };
    for (int[] acquire : permutations) for (int[] release : permutations) {
      VisionCaptureLifecycle owner = new VisionCaptureLifecycle();
      for (int reason : acquire) check(owner.suspend(reason), "distinct reason acquisition must succeed");
      check(owner.generation() == 3, "three acquisitions have three invalidation edges");
      for (int index = 0; index < release.length; index++) {
        check(owner.resume(release[index]), "releasing one owned reason must succeed");
        for (int later = index + 1; later < release.length; later++) {
          check(owner.isSuspended(release[later]), "resume must not clear another owner's reason");
        }
        check(owner.isSuspended() == (index < 2), "capture stays paused until the last reason is released");
        check(owner.accepts(owner.generation()) == (index == 2), "partial release cannot accept callbacks");
      }
      check(owner.generation() == 6, "three independent releases have three invalidation edges");
      for (long token = 0; token < 6; token++) check(!owner.accepts(token), "overlapping suspensions cannot resurrect earlier tokens");
    }
  }

  private static void pausedCompletion() {
    for (int reason : REASONS) {
      VisionCaptureLifecycle owner = new VisionCaptureLifecycle();
      owner.suspend(reason); long paused = owner.generation();
      check(!owner.markCompleted(), "markCompleted must be rejected while paused");
      check(!owner.isCompleted() && owner.generation() == paused, "rejected completion cannot mutate workflow state");
      check(!owner.deliver() && owner.generation() == paused, "incomplete paused workflow cannot deliver");
      owner.resume(reason);
      check(owner.markCompleted(), "resumed capture may complete");
      long completed = owner.generation();
      check(owner.markCompleted() && owner.generation() == completed, "repeated active completion is idempotent and remains true");
      check(owner.accepts(completed) && !owner.canCapture(completed), "completed callbacks may deliver but never capture again");
      owner.suspend(reason); long completedPaused = owner.generation();
      check(owner.isCompleted() && owner.isAlive(), "suspending completion preserves its state");
      check(!owner.markCompleted(), "even repeated completion cannot bypass suspension");
      check(!owner.deliver(), "deliver must be rejected while paused");
      check(!owner.cancel(), "completed workflow cannot be canceled even while paused");
      check(owner.generation() == completedPaused, "rejected completed operations cannot change generation");
      owner.resume(reason);
      check(!owner.canCapture(owner.generation()), "resume cannot reactivate completed capture");
      check(owner.deliver(), "completed workflow delivers once after final resume");
      check(!owner.deliver() && !owner.isAlive(), "delivery is terminal and one-shot");
    }
  }

  private static void terminalAndDestroy() {
    for (int terminalKind = 0; terminalKind < 3; terminalKind++) {
      VisionCaptureLifecycle owner = new VisionCaptureLifecycle();
      owner.suspend(1); owner.suspend(2);
      if (terminalKind == 0) check(owner.cancel(), "cancellation is allowed under overlapping pauses");
      else if (terminalKind == 1) {
        owner.resume(1); owner.resume(2); owner.markCompleted(); owner.deliver();
      } else check(owner.destroy(), "destroy is allowed under overlapping pauses");
      check(!owner.isAlive(), "cancel, delivery, and destruction all end liveness");
      long generation = owner.generation();
      boolean background = owner.isSuspended(1), exit = owner.isSuspended(2), fatal = owner.isSuspended(4);
      for (int reason : REASONS) {
        check(!owner.suspend(reason) && !owner.resume(reason), "closed owner cannot acquire or release pauses");
      }
      check(owner.generation() == generation, "closed-owner suspension calls are no-ops");
      check(owner.isSuspended(1) == background && owner.isSuspended(2) == exit && owner.isSuspended(4) == fatal,
        "closed-owner reason queries preserve the last known ownership set");
      check(!owner.markCompleted() && !owner.deliver() && !owner.cancel(), "closed owner cannot complete or terminate twice");
      check(!owner.accepts(generation) && !owner.canCapture(generation), "closed owner rejects even its current token");
      owner.nextStep();
      check(owner.generation() == generation + 1 && !owner.isAlive(), "legacy nextStep always invalidates but cannot revive a closed owner");
      check(owner.destroy() == (terminalKind != 2), "first destruction succeeds regardless of terminal state");
      long destroyed = owner.generation();
      check(!owner.destroy() && owner.generation() == destroyed, "destroy is idempotent");
    }
    VisionCaptureLifecycle paused = new VisionCaptureLifecycle(); paused.suspend(4);
    long token = paused.generation(); paused.nextStep();
    check(paused.generation() == token + 1 && paused.isSuspended(4) && !paused.accepts(paused.generation()),
      "nextStep cannot clear suspension or enable capture");
  }

  private static void completedOverlapAndEveryDestroyState() {
    VisionCaptureLifecycle completed = new VisionCaptureLifecycle(); completed.markCompleted();
    for (int reason : REASONS) check(completed.suspend(reason), "completed workflow can acquire each pause owner");
    for (int index = 0; index < REASONS.length; index++) {
      check(completed.resume(REASONS[index]), "completed workflow can release each pause owner");
      check(!completed.canCapture(completed.generation()), "completed workflow cannot recapture during any release stage");
      if (index < REASONS.length - 1) check(!completed.deliver(), "completed workflow must wait for every pause owner");
    }
    check(completed.deliver() && !completed.deliver(), "all resumed completed workflow delivers exactly once");
    for (int state = 0; state < 6; state++) {
      VisionCaptureLifecycle owner = new VisionCaptureLifecycle();
      if (state == 1) owner.suspend(1);
      if (state == 2 || state == 3 || state == 5) owner.markCompleted();
      if (state == 3) { owner.suspend(1); owner.suspend(2); }
      if (state == 4) owner.cancel();
      if (state == 5) owner.deliver();
      long generation = owner.generation(); boolean wasCompleted = owner.isCompleted();
      check(owner.destroy(), "first destroy succeeds in workflow state " + state);
      check(owner.generation() == generation + 1 && !owner.isAlive(), "destroy invalidates and ends liveness in state " + state);
      check(owner.isCompleted() == wasCompleted, "destroy does not fabricate or erase completion in state " + state);
      check(!owner.destroy() && owner.generation() == generation + 1, "second destroy is unchanged in state " + state);
      check(!owner.markCompleted() && !owner.deliver() && !owner.cancel(), "destroyed workflow cannot be reactivated in state " + state);
    }
  }

  private static void invalidReasons() {
    for (int phase = 0; phase < 4; phase++) {
      VisionCaptureLifecycle owner = new VisionCaptureLifecycle(); owner.suspend(1);
      if (phase == 1) owner.cancel();
      if (phase == 2) owner.destroy();
      if (phase == 3) { owner.resume(1); owner.markCompleted(); owner.deliver(); }
      long before = owner.generation(); boolean suspended = owner.isSuspended();
      for (int reason : INVALID_REASONS) {
        invalid(() -> owner.suspend(reason), "invalid suspend reason must throw");
        invalid(() -> owner.resume(reason), "invalid resume reason must throw");
        invalid(() -> owner.isSuspended(reason), "invalid reason query must throw");
        check(owner.generation() == before && owner.isSuspended() == suspended, "invalid reason must not mutate any state");
      }
    }
  }

  private static List<Boolean> simultaneous(int count, Callable<Boolean> operation) throws Exception {
    ExecutorService workers = Executors.newFixedThreadPool(count);
    CyclicBarrier start = new CyclicBarrier(count);
    try {
      List<Future<Boolean>> results = new ArrayList<>();
      for (int index = 0; index < count; index++) results.add(workers.submit(() -> {
        start.await(5, TimeUnit.SECONDS); return operation.call();
      }));
      List<Boolean> values = new ArrayList<>();
      for (Future<Boolean> result : results) values.add(result.get(5, TimeUnit.SECONDS));
      return values;
    } finally {
      workers.shutdownNow();
      check(workers.awaitTermination(5, TimeUnit.SECONDS), "concurrent verifier workers must terminate");
    }
  }
  private static long trueCount(List<Boolean> values) { return values.stream().filter(Boolean::booleanValue).count(); }

  private static void simultaneousOwnership() throws Exception {
    for (int round = 0; round < 12; round++) {
      VisionCaptureLifecycle owner = new VisionCaptureLifecycle();
      check(trueCount(simultaneous(8, () -> owner.suspend(1))) == 1, "concurrent duplicate suspension must have one winner");
      check(owner.generation() == 1 && owner.isSuspended(1), "duplicate workers produce exactly one acquisition edge");
      check(trueCount(simultaneous(8, () -> owner.resume(1))) == 1, "concurrent duplicate resume must have one winner");
      check(owner.generation() == 2 && !owner.isSuspended(), "duplicate workers produce exactly one release edge");
      check(!owner.accepts(0) && !owner.accepts(1), "concurrent edges cannot revive retired tokens");
    }
    VisionCaptureLifecycle completed = new VisionCaptureLifecycle(); completed.markCompleted(); completed.suspend(4);
    check(trueCount(simultaneous(8, completed::deliver)) == 0, "no delivery thread can bypass a fatal pause");
    check(trueCount(simultaneous(8, () -> completed.resume(4))) == 1, "one worker owns the final release");
    check(trueCount(simultaneous(8, completed::deliver)) == 1, "concurrent completed delivery has one winner");
    check(trueCount(simultaneous(8, completed::destroy)) == 1, "concurrent destruction is one-shot after delivery");
  }

  private static void orderedCrossThreadVisibility() throws Exception {
    VisionCaptureLifecycle owner = new VisionCaptureLifecycle();
    long callbackToken = owner.generation();
    CountDownLatch backgroundHeld = new CountDownLatch(1), bothHeld = new CountDownLatch(1);
    CountDownLatch releaseBackground = new CountDownLatch(1), backgroundReleased = new CountDownLatch(1);
    CountDownLatch releaseExit = new CountDownLatch(1), exitReleased = new CountDownLatch(1);
    List<Throwable> errors = java.util.Collections.synchronizedList(new ArrayList<>());
    Thread background = new Thread(() -> {
      try {
        check(owner.suspend(1), "background thread acquires its reason"); backgroundHeld.countDown();
        await(releaseBackground); check(owner.resume(1), "background thread releases only its reason"); backgroundReleased.countDown();
      } catch (Throwable error) { errors.add(error); }
    }, "visibility-background-owner");
    Thread dialog = new Thread(() -> {
      try {
        await(backgroundHeld); check(owner.suspend(2), "dialog thread acquires an overlapping reason"); bothHeld.countDown();
        await(releaseExit); check(owner.resume(2), "dialog thread releases the final reason"); exitReleased.countDown();
      } catch (Throwable error) { errors.add(error); }
    }, "visibility-exit-owner");
    background.start(); dialog.start();
    try {
      await(bothHeld);
      check(owner.generation() == 2 && owner.isSuspended(1) && owner.isSuspended(2), "both thread-owned reasons are visible");
      releaseBackground.countDown(); await(backgroundReleased);
      check(!owner.isSuspended(1) && owner.isSuspended(2) && !owner.accepts(owner.generation()), "background resume cannot dismiss the exit confirmation");
      releaseExit.countDown(); await(exitReleased);
      check(owner.generation() == 4 && owner.canCapture(4), "last owner release enables only generation four");
      check(!owner.accepts(callbackToken), "callback captured before cross-thread pause cycle never revives");
      Future<Boolean> lateCallback = null;
      ExecutorService callback = Executors.newSingleThreadExecutor();
      try {
        lateCallback = callback.submit(() -> owner.accepts(callbackToken) || owner.canCapture(callbackToken));
        check(!lateCallback.get(5, TimeUnit.SECONDS), "late worker observes the same retired token");
      } finally { callback.shutdownNow(); check(callback.awaitTermination(5, TimeUnit.SECONDS), "callback worker stopped"); }
    } finally {
      releaseBackground.countDown(); releaseExit.countDown(); joined(background); joined(dialog);
    }
    check(errors.isEmpty(), "cross-thread worker assertion: " + errors);
  }

  // Independent declarative oracle: workflow phase + a set of pause owners + an
  // append-only invalidation ledger. It has no bitmask or copied helper methods.
  private enum Phase { CAPTURING, COMPLETED, CANCELED, DELIVERED }
  private enum Reason { BACKGROUND, EXIT, FATAL }
  private enum Op { ACQUIRE, RELEASE, COMPLETE, DELIVER, CANCEL, DESTROY, NEXT_STEP }
  private static final class Oracle {
    Phase phase = Phase.CAPTURING;
    boolean destroyed;
    final EnumSet<Reason> holders = EnumSet.noneOf(Reason.class);
    final List<String> invalidations = new ArrayList<>();
    boolean alive() { return !destroyed && phase != Phase.CANCELED && phase != Phase.DELIVERED; }
    boolean completed() { return phase == Phase.COMPLETED || phase == Phase.DELIVERED; }
    boolean accepts(long token) { return alive() && holders.isEmpty() && token == invalidations.size(); }
    boolean apply(Op operation, Reason reason) {
      if (operation == Op.NEXT_STEP) { invalidations.add("explicit callback retirement"); return true; }
      if (operation == Op.DESTROY) {
        if (destroyed) return false;
        destroyed = true; invalidations.add("destroyed owner"); return true;
      }
      if (!alive()) return false;
      if (operation == Op.ACQUIRE || operation == Op.RELEASE) {
        boolean changed = operation == Op.ACQUIRE ? holders.add(reason) : holders.remove(reason);
        if (changed) invalidations.add(operation + " " + reason);
        return changed;
      }
      if (operation == Op.CANCEL) {
        if (phase != Phase.CAPTURING) return false;
        phase = Phase.CANCELED; invalidations.add("explicit cancellation"); return true;
      }
      if (!holders.isEmpty()) return false;
      if (operation == Op.COMPLETE) {
        if (phase == Phase.CAPTURING) { phase = Phase.COMPLETED; invalidations.add("durable completion"); }
        return true;
      }
      if (operation == Op.DELIVER && phase == Phase.COMPLETED) {
        phase = Phase.DELIVERED; invalidations.add("single result delivery"); return true;
      }
      return false;
    }
  }

  private static void checkOracle(VisionCaptureLifecycle actual, Oracle expected, String where) {
    check(actual.generation() == expected.invalidations.size(), where + ": generation differs from transition ledger");
    check(actual.isAlive() == expected.alive(), where + ": liveness differs from workflow phase");
    check(actual.isCompleted() == expected.completed(), where + ": completion state changed unexpectedly");
    check(actual.isSuspended() == !expected.holders.isEmpty(), where + ": combined suspension differs from owner set");
    for (Reason reason : Reason.values()) check(actual.isSuspended(REASONS[reason.ordinal()]) == expected.holders.contains(reason), where + ": wrong owner " + reason);
    long now = expected.invalidations.size();
    check(actual.accepts(now) == expected.accepts(now), where + ": current-token acceptance mismatch");
    check(actual.canCapture(now) == (expected.accepts(now) && expected.phase == Phase.CAPTURING), where + ": capture eligibility mismatch");
    for (long retired = 0; retired < now; retired++) {
      check(!actual.accepts(retired) && !actual.canCapture(retired), where + ": retired token revived: " + retired);
    }
    check(!actual.accepts(now + 1), where + ": future token accepted");
  }

  private static void fixedSeedTraces() {
    Random random = new Random(TRACE_SEED);
    for (int trace = 0; trace < 160; trace++) {
      VisionCaptureLifecycle actual = new VisionCaptureLifecycle(); Oracle expected = new Oracle();
      for (int step = 0; step < 160; step++) {
        int choice = random.nextInt(32);
        Reason reason = Reason.values()[random.nextInt(3)]; int reasonId = REASONS[reason.ordinal()];
        String where = "seed=" + TRACE_SEED + " trace=" + trace + " step=" + step;
        if (choice == 31) {
          int invalidReason = INVALID_REASONS[random.nextInt(INVALID_REASONS.length)];
          invalid(() -> actual.suspend(invalidReason), where + ": invalid acquire accepted");
          invalid(() -> actual.resume(invalidReason), where + ": invalid release accepted");
          invalid(() -> actual.isSuspended(invalidReason), where + ": invalid owner query accepted");
        } else {
          Op operation = choice < 10 ? Op.ACQUIRE : choice < 20 ? Op.RELEASE : choice < 23 ? Op.NEXT_STEP
            : choice < 27 ? Op.COMPLETE : choice < 29 ? Op.DELIVER : choice == 29 ? Op.CANCEL : Op.DESTROY;
          boolean predicted = expected.apply(operation, reason);
          boolean observed;
          switch (operation) {
            case ACQUIRE: observed = actual.suspend(reasonId); break;
            case RELEASE: observed = actual.resume(reasonId); break;
            case COMPLETE: observed = actual.markCompleted(); break;
            case DELIVER: observed = actual.deliver(); break;
            case CANCEL: observed = actual.cancel(); break;
            case DESTROY: observed = actual.destroy(); break;
            case NEXT_STEP: actual.nextStep(); observed = true; break;
            default: throw new AssertionError(operation);
          }
          check(observed == predicted, where + ": transition result differs for " + operation + "/" + reason);
        }
        checkOracle(actual, expected, where);
      }
    }
  }

  public static void main(String[] args) throws Exception {
    Map<String, Scenario> scenarios = new LinkedHashMap<>();
    scenarios.put("initial", VisionVisibilityVerifier::initialContract);
    scenarios.put("reason-edges", VisionVisibilityVerifier::reasonEdges);
    scenarios.put("overlap-orders", VisionVisibilityVerifier::overlapAllOrders);
    scenarios.put("paused-completion", VisionVisibilityVerifier::pausedCompletion);
    scenarios.put("terminal-destroy", VisionVisibilityVerifier::terminalAndDestroy);
    scenarios.put("completed-overlap-and-destroy", VisionVisibilityVerifier::completedOverlapAndEveryDestroyState);
    scenarios.put("invalid-reasons", VisionVisibilityVerifier::invalidReasons);
    scenarios.put("concurrent-duplicates", VisionVisibilityVerifier::simultaneousOwnership);
    scenarios.put("cross-thread-visibility", VisionVisibilityVerifier::orderedCrossThreadVisibility);
    scenarios.put("oracle-traces", VisionVisibilityVerifier::fixedSeedTraces);
    String selected = args.length == 0 ? "all" : args[0];
    check("all".equals(selected) || scenarios.containsKey(selected), "unknown verifier scenario " + selected);
    int ran = 0;
    for (Map.Entry<String, Scenario> scenario : scenarios.entrySet()) {
      if (!"all".equals(selected) && !selected.equals(scenario.getKey())) continue;
      scenario.getValue().run(); ran++;
      System.out.println("PASS " + scenario.getKey());
    }
    System.out.println("vision-visibility-verification: " + ran + " scenarios / " + checks.get()
      + " checks; oracle seed=" + TRACE_SEED + "; full trace=160x160 operations");
  }
}
