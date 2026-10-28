package local.fanhao.library;

import java.net.HttpURLConnection;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.Set;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.FutureTask;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;

/** Owns replaceable reads only. Accepted mutations use their existing runner. */
final class NativeShortVideoFeedRequests implements AutoCloseable {
  interface Read { void run(Request request); }

  private final ThreadPoolExecutor reads = executor(2, 1, "short-feed-read");
  private final ThreadPoolExecutor disconnects = executor(1, 2, "short-feed-cancel");
  private final Set<Request> pending = new HashSet<>();
  private Request current;
  private boolean closed;

  private static ThreadPoolExecutor executor(int threads, int capacity, String name) {
    return new ThreadPoolExecutor(threads, threads, 0L, TimeUnit.MILLISECONDS,
      new ArrayBlockingQueue<>(capacity), job -> {
        Thread thread = new Thread(job, name);
        thread.setDaemon(true);
        return thread;
      }, new ThreadPoolExecutor.AbortPolicy());
  }

  synchronized Request replace(Read read) {
    if (closed) return null;
    if (current != null) current.cancel();
    Request request = new Request();
    current = request;
    pending.add(request);
    request.future = new FutureTask<>(() -> {
      try { if (request.isCurrent()) read.run(request); }
      finally { synchronized (NativeShortVideoFeedRequests.this) { pending.remove(request); } }
      return null;
    });
    try { reads.execute(request.future); }
    catch (RejectedExecutionException error) {
      // The sole queued entry belongs to an obsolete intent. It can never be
      // allowed to delay the new owner or begin a physical HTTP request.
      reads.getQueue().clear();
      try { reads.execute(request.future); }
      catch (RejectedExecutionException ignored) { request.cancel(); pending.remove(request); }
    }
    return request;
  }

  synchronized void cancel() {
    current = null;
    for (Request request : new ArrayList<>(pending)) request.cancel();
    reads.purge();
  }

  @Override public synchronized void close() {
    if (closed) return;
    closed = true;
    cancel();
    reads.shutdownNow();
    // Disconnect can wait on a platform socket lock. Never wait for it on the
    // Activity thread, including during destroy.
    disconnects.shutdown();
  }

  private void disconnect(HttpURLConnection connection) {
    try { disconnects.execute(connection::disconnect); }
    catch (RejectedExecutionException ignored) {
      // At most two read workers own sockets. An interrupted read still has
      // its finite socket timeout and always disconnects in Transport.finally.
    }
  }

  final class Request implements NativeShortVideoFeedTransport.Cancellation {
    private volatile boolean cancelled;
    private volatile FutureTask<?> future;
    private HttpURLConnection connection;

    boolean isCurrent() {
      synchronized (NativeShortVideoFeedRequests.this) { return !closed && !cancelled && current == this; }
    }

    @Override public boolean isCancelled() { return !isCurrent(); }

    @Override public boolean publish(Runnable action) {
      synchronized (NativeShortVideoFeedRequests.this) {
        if (!isCurrent()) return false;
        action.run();
        return true;
      }
    }

    @Override public synchronized boolean attach(HttpURLConnection value) {
      if (cancelled) { disconnect(value); return false; }
      connection = value;
      return true;
    }

    @Override public synchronized void detach(HttpURLConnection value) {
      if (connection == value) connection = null;
    }

    private void cancel() {
      HttpURLConnection value;
      synchronized (this) {
        if (cancelled) return;
        cancelled = true;
        value = connection;
        connection = null;
      }
      FutureTask<?> job = future;
      if (job != null) {
        job.cancel(true);
        reads.remove(job);
      }
      pending.remove(this);
      if (value != null) disconnect(value);
    }
  }
}
