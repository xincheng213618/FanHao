package local.fanhao.library;

import java.lang.ref.WeakReference;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Iterator;

/** Process-local FIFO. Only claim bookkeeping is synchronized, never provider I/O. */
final class PendingTextImportQueue<T> {
  static final class Claim<T> {
    final T source;
    final T snapshot;

    Claim(T source, T snapshot) {
      this.source = source;
      this.snapshot = snapshot;
    }
  }

  private final ArrayDeque<Claim<T>> pending = new ArrayDeque<>();
  private final ArrayList<WeakReference<T>> seenSources = new ArrayList<>();
  private Claim<T> inFlight;

  synchronized boolean hasSeen(T source) {
    if (source == null) return false;
    boolean found = false;
    for (Iterator<WeakReference<T>> entries = seenSources.iterator(); entries.hasNext();) {
      T prior = entries.next().get();
      if (prior == null) entries.remove();
      else if (prior == source) found = true;
    }
    return found;
  }

  synchronized void offer(T source, T snapshot) {
    if (source == null || snapshot == null || hasSeen(source)) return;
    seenSources.add(new WeakReference<>(source));
    pending.addLast(new Claim<>(source, snapshot));
  }

  synchronized Claim<T> claim() {
    if (inFlight != null) return null;
    inFlight = pending.pollFirst();
    return inFlight;
  }

  synchronized void complete(Claim<T> claim) {
    if (inFlight == claim) inFlight = null;
  }

  synchronized boolean isBusy() {
    return inFlight != null;
  }

  synchronized boolean hasPending() {
    return !pending.isEmpty();
  }
}
