package local.fanhao.library;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.Callable;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import java.util.function.BooleanSupplier;
import java.util.function.Consumer;

/** Bounded media reads. A superseded decoder keeps its physical slot until it returns. */
final class NativeShortVideoFrameLoader<T> implements AutoCloseable {
  private static final int ACTIVE_LIMIT = 2, PENDING_LIMIT = 6;
  private final ExecutorService workers;
  private final Map<String, Task> tasks = new HashMap<>();
  private final Set<Task> running = new HashSet<>();
  private final List<Task> pending = new ArrayList<>();
  private boolean closed;

  NativeShortVideoFrameLoader() {
    this(new ThreadPoolExecutor(ACTIVE_LIMIT, ACTIVE_LIMIT, 0L, TimeUnit.MILLISECONDS,
      new ArrayBlockingQueue<>(ACTIVE_LIMIT), job -> {
        Thread thread = new Thread(job, "short-video-frame");
        thread.setDaemon(true);
        return thread;
      }));
  }

  NativeShortVideoFrameLoader(ExecutorService workers) { this.workers = workers; }

  void offer(String key, BooleanSupplier wanted, BooleanSupplier current, Callable<T> read,
      boolean paints, Consumer<T> complete) {
    offer(key, wanted, current, read, paints, complete, null);
  }

  void offer(String key, BooleanSupplier wanted, BooleanSupplier current, Callable<T> read,
      boolean paints, Consumer<T> complete, Runnable failed) {
    T ready = null;
    Consumer<T> delivery = null;
    synchronized (this) {
      if (closed || key == null || key.length() == 0 || !test(wanted)) return;
      prunePending();
      Task task = tasks.get(key);
      if (task != null) {
        task.wanted = wanted;
        task.current = current;
        if (paints || !task.paints) { task.complete = complete; task.failed = failed; task.paints = paints; }
        if (task.ready) {
          if (task.value != null && paints) { ready = task.value; delivery = complete; }
          else if (task.value == null) { task.read = read; task.rerun = true; }
        }
      } else {
        task = new Task(key, wanted, current, read, paints, complete, failed);
        tasks.put(key, task);
        pending.add(task);
        trimPending();
      }
      pump();
    }
    // A current view can subscribe after the read returns but before its old
    // prefetch publication finishes. It must still receive that same bitmap.
    if (delivery != null) delivery.accept(ready);
  }

  synchronized void prune() { prunePending(); pump(); }

  private void prunePending() {
    for (Task task : new ArrayList<>(pending)) if (!test(task.wanted)) {
      pending.remove(task);
      if (tasks.get(task.key) == task) tasks.remove(task.key);
    }
  }

  private void trimPending() {
    while (pending.size() > PENDING_LIMIT) {
      Task evicted = pending.get(0);
      for (Task candidate : pending) if (!test(candidate.current)) { evicted = candidate; break; }
      pending.remove(evicted);
      if (tasks.get(evicted.key) == evicted) tasks.remove(evicted.key);
    }
  }

  private void pump() {
    prunePending();
    trimPending();
    while (!closed && running.size() < ACTIVE_LIMIT && !pending.isEmpty()) {
      Task next = pending.get(0);
      for (Task candidate : pending) if (test(candidate.current)) { next = candidate; break; }
      pending.remove(next);
      running.add(next);
      Task task = next;
      try { workers.execute(() -> execute(task)); }
      catch (RuntimeException rejected) {
        running.remove(task);
        if (tasks.get(task.key) == task) tasks.remove(task.key);
      }
    }
  }

  private void execute(Task task) {
    boolean readStarted = false;
    try {
      synchronized (this) { readStarted = !closed && test(task.wanted); }
      T value = null;
      if (readStarted) {
        try { value = task.read.call(); }
        catch (Exception readFailure) { /* Null and failed decodes share the owned failure path. */ }
      }
      Consumer<T> delivery;
      Runnable failure;
      synchronized (this) {
        task.ready = true;
        task.value = value;
        delivery = closed ? null : task.complete;
        // Like successful reads, physical failure must let the owner settle its
        // loading state even if it became hidden; UI consumers check ownership.
        failure = !closed && readStarted && task.paints ? task.failed : null;
      }
      if (value != null && delivery != null) delivery.accept(value);
      else if (value == null && failure != null) failure.run();
    } catch (Exception ignored) {
      // A failed image/codec read may be offered again; it never poisons a key.
    } finally {
      synchronized (this) {
        running.remove(task);
        if (!closed && (!readStarted || task.rerun) && test(task.wanted)) {
          task.ready = false;
          task.value = null;
          task.rerun = false;
          pending.add(task);
        } else if (tasks.get(task.key) == task) tasks.remove(task.key);
        pump();
        notifyAll();
      }
    }
  }

  private boolean test(BooleanSupplier predicate) {
    try { return predicate.getAsBoolean(); } catch (RuntimeException retiredOwner) { return false; }
  }

  synchronized int activeCount() { return running.size(); }
  synchronized int queuedCount() { return pending.size(); }
  synchronized boolean contains(String key) { return tasks.containsKey(key); }

  @Override public synchronized void close() {
    if (closed) return;
    closed = true;
    for (Task task : pending) tasks.remove(task.key);
    pending.clear();
    for (Task task : running) { task.complete = null; task.failed = null; }
    workers.shutdown();
    notifyAll();
  }

  private final class Task {
    final String key;
    BooleanSupplier wanted, current;
    Callable<T> read;
    Consumer<T> complete;
    Runnable failed;
    boolean paints, ready, rerun;
    T value;
    Task(String key, BooleanSupplier wanted, BooleanSupplier current, Callable<T> read, boolean paints, Consumer<T> complete, Runnable failed) {
      this.key = key; this.wanted = wanted; this.current = current; this.read = read;
      this.paints = paints; this.complete = complete;
      this.failed = failed;
    }
  }
}
