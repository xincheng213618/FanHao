package local.fanhao.library;

import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.function.Consumer;
import java.util.function.LongSupplier;

/** Initialises one owned cache off the UI thread; retries require a new source request. */
final class NativeShortVideoCacheLifecycle<T> {
  interface Initializer<T> { T create() throws Exception; }
  private final Initializer<T> initializer;
  private final Consumer<T> dispose;
  private final Consumer<T> onReady;
  private final Consumer<Exception> onFailure;
  private final LongSupplier clock;
  private final ExecutorService worker = Executors.newSingleThreadExecutor(job -> {
    Thread thread = new Thread(job, "short-video-cache-init");
    thread.setDaemon(true);
    return thread;
  });
  private volatile T ready;
  private volatile boolean closed;
  private boolean initializing;
  private long generation, retryAtMs;
  private int failures;

  NativeShortVideoCacheLifecycle(Initializer<T> initializer, Consumer<T> dispose, Consumer<T> onReady,
    Consumer<Exception> onFailure, LongSupplier clock) {
    this.initializer = initializer;
    this.dispose = dispose;
    this.onReady = onReady;
    this.onFailure = onFailure;
    this.clock = clock;
  }

  T ready() { return ready; }
  boolean isClosed() { return closed; }

  synchronized void requestInitialization() {
    if (closed || ready != null || initializing || clock.getAsLong() < retryAtMs) return;
    initializing = true;
    long owner = ++generation;
    worker.execute(() -> initialize(owner));
  }

  private void initialize(long owner) {
    synchronized (this) {
      if (closed || generation != owner) { initializing = false; return; }
    }
    T result;
    try { result = initializer.create(); }
    catch (Exception error) {
      boolean current;
      synchronized (this) {
        initializing = false;
        current = !closed && generation == owner;
        if (current) {
          failures = Math.min(5, failures + 1);
          retryAtMs = clock.getAsLong() + Math.min(8000L, 500L << (failures - 1));
        }
      }
      if (current) onFailure.accept(error);
      return;
    }
    boolean current;
    synchronized (this) {
      initializing = false;
      current = !closed && generation == owner;
      if (current) { ready = result; failures = 0; retryAtMs = 0; }
    }
    if (current) onReady.accept(result);
    else dispose.accept(result);
  }

  void close(Consumer<T> retireReady) {
    T result;
    synchronized (this) {
      if (closed) return;
      closed = true;
      generation++;
      result = ready;
      ready = null;
      worker.shutdown();
    }
    // The caller owns active players and prefetch spans; it decides when this
    // already published resource has physically drained. Late init never had
    // users and is disposed on the init worker above.
    if (result != null) retireReady.accept(result);
  }
}
