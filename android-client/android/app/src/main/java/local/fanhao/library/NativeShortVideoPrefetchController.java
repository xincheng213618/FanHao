package local.fanhao.library;

import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import java.util.function.BooleanSupplier;

/** Replaceable speculative work. A cancelled physical read keeps its slot until it returns. */
final class NativeShortVideoPrefetchController implements AutoCloseable {
  interface Work { void run(Lease lease) throws Exception; }
  interface Cancellation { void cancel(); }

  private static final ExecutorService CLEANUP = Executors.newSingleThreadExecutor(job -> {
    Thread thread = new Thread(job, "short-video-cache-release");
    thread.setDaemon(true);
    return thread;
  });
  private final ThreadPoolExecutor workers = new ThreadPoolExecutor(2, 2, 0L, TimeUnit.MILLISECONDS,
    new ArrayBlockingQueue<>(2), job -> {
      Thread thread = new Thread(job, "short-video-prefetch");
      thread.setDaemon(true);
      return thread;
    });
  private final Set<Lease> running = new HashSet<>();
  private final List<Runnable> idleCallbacks = new ArrayList<>();
  private Lease current, pending;
  private boolean closed;

  synchronized void offer(String owner, String cacheKey, BooleanSupplier isCurrent, Work work) {
    if (closed) return;
    if (current != null && current.owner.equals(owner) && current.cacheKey.equals(cacheKey) && current.isCurrent()) return;
    cancel();
    Lease lease = new Lease(owner, cacheKey, isCurrent, work);
    current = pending = lease;
    pump();
  }

  synchronized void cancel() {
    current = null;
    if (pending != null) pending.cancel();
    pending = null;
    for (Lease lease : running) lease.cancel();
  }

  private synchronized void pump() {
    Lease lease = pending;
    if (lease == null || closed || running.size() >= 2) return;
    if (!lease.isCurrent()) { pending = null; return; }
    // CacheDataSource/CacheWriter own cache span locks. Never create concurrent
    // writers for the same cache URL, including after a cancelled read.
    for (Lease active : running) if (active.cacheKey.equals(lease.cacheKey)) return;
    pending = null;
    running.add(lease);
    workers.execute(() -> {
      try { if (lease.isCurrent()) lease.work.run(lease); }
      catch (Exception ignored) { /* Each Activity work item records its useful errors. */ }
      finally {
        synchronized (NativeShortVideoPrefetchController.this) {
          running.remove(lease);
          if (current == lease) current = null;
          pump();
          notifyIdle();
        }
      }
    });
  }

  synchronized void whenIdle(Runnable action) {
    idleCallbacks.add(action);
    notifyIdle();
  }

  private void notifyIdle() {
    if (!running.isEmpty()) return;
    for (Runnable action : idleCallbacks) CLEANUP.execute(action);
    idleCallbacks.clear();
  }

  @Override public synchronized void close() {
    if (closed) return;
    closed = true;
    cancel();
    // No UI-thread await or unsafe cross-thread DataSource.close(). CacheWriter
    // cooperates with cancel after its current read; each physical job drains.
    workers.shutdown();
    notifyIdle();
  }

  synchronized int activeCount() { return running.size(); }
  synchronized int queuedCount() { return pending == null ? 0 : 1; }

  final class Lease {
    private final String owner, cacheKey;
    private final BooleanSupplier predicate;
    private final Work work;
    private boolean cancelled;
    private Cancellation cancellation;

    private Lease(String owner, String cacheKey, BooleanSupplier predicate, Work work) {
      this.owner = owner;
      this.cacheKey = cacheKey;
      this.predicate = predicate;
      this.work = work;
    }

    boolean isCurrent() {
      synchronized (NativeShortVideoPrefetchController.this) {
        return !closed && !cancelled && current == this && predicate.getAsBoolean();
      }
    }

    boolean attach(Cancellation value) {
      synchronized (NativeShortVideoPrefetchController.this) {
        if (!isCurrent()) { value.cancel(); return false; }
        cancellation = value;
        return true;
      }
    }

    private void cancel() {
      if (cancelled) return;
      cancelled = true;
      // CacheWriter.cancel() only marks its cooperative cancellation flag.
      if (cancellation != null) cancellation.cancel();
    }
  }
}
