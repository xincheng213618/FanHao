package local.fanhao.library;

import java.util.Objects;
import java.util.function.LongSupplier;

/** Keeps only the currently visible playback stage awake, never a cached player. */
final class NativeShortVideoScreenAwake implements AutoCloseable {
  static final long BUFFERING_LIMIT_MS = 12000L;

  interface Host {
    State readState();
    void setKeepScreenOn(boolean keep);
  }

  interface Scheduler {
    void postDelayed(Runnable callback, long delayMs);
    void removeCallbacks(Runnable callback);
  }

  static final class State {
    // A stable logical stage/source/retry key, not a freshly captured listener.
    final String ownerKey;
    final boolean visible;
    final boolean playing;
    final boolean bufferingRequested;
    final boolean imageTiming;

    State(String ownerKey, boolean visible, boolean playing, boolean bufferingRequested, boolean imageTiming) {
      this.ownerKey = ownerKey;
      this.visible = visible;
      this.playing = playing;
      this.bufferingRequested = bufferingRequested;
      this.imageTiming = imageTiming;
    }
  }

  private Host host;
  private Scheduler scheduler;
  private LongSupplier clock;
  private String ownerKey;
  private long bufferingDeadline = -1L;
  private Runnable pending;
  private boolean keeping;
  private boolean closed;

  NativeShortVideoScreenAwake(Host host, Scheduler scheduler, LongSupplier clock) {
    this.host = Objects.requireNonNull(host);
    this.scheduler = Objects.requireNonNull(scheduler);
    this.clock = Objects.requireNonNull(clock);
  }

  // Called on the UI thread. Callbacks request a fresh state read, never retain
  // a prior player's isPlaying/position/visibility decision.
  void refresh() {
    if (closed) return;
    State current;
    try { current = host.readState(); }
    catch (RuntimeException retiredOwner) { current = null; }
    if (current == null || !current.visible || current.ownerKey == null || current.ownerKey.length() == 0) {
      // Hiding or briefly losing a state read releases the flag, but it is not
      // evidence of real playback or a new request for the same stalled source.
      cancelPending();
      apply(false);
      return;
    }
    if (!current.ownerKey.equals(ownerKey)) {
      resetOwner();
      ownerKey = current.ownerKey;
    }
    if (current.playing || current.imageTiming) {
      bufferingDeadline = -1L;
      cancelPending();
      apply(true);
      return;
    }
    if (!current.bufferingRequested) {
      // READY-but-not-playing, pause or error must release the view flag, but
      // cannot silently renew a stalled source's already consumed budget.
      cancelPending();
      apply(false);
      return;
    }
    long now = clock.getAsLong();
    if (bufferingDeadline < 0L) bufferingDeadline = now + BUFFERING_LIMIT_MS;
    boolean withinBudget = now < bufferingDeadline;
    apply(withinBudget);
    if (!withinBudget) { cancelPending(); return; }
    if (pending == null) {
      pending = new Runnable() {
        @Override public void run() {
          if (pending != this || closed) return;
          pending = null;
          refresh();
        }
      };
      scheduler.postDelayed(pending, Math.max(1L, bufferingDeadline - now));
    }
  }

  boolean isKeepingScreenOn() { return keeping; }

  private void apply(boolean keep) {
    if (keep == keeping) return;
    keeping = keep;
    host.setKeepScreenOn(keep);
  }

  private void resetOwner() {
    cancelPending();
    ownerKey = null;
    bufferingDeadline = -1L;
  }

  private void cancelPending() {
    if (pending != null) scheduler.removeCallbacks(pending);
    pending = null;
  }

  @Override public void close() {
    if (closed) return;
    closed = true;
    resetOwner();
    apply(false);
    host = null;
    scheduler = null;
    clock = null;
  }
}
