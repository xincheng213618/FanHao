package local.fanhao.library;

import java.util.concurrent.ExecutorService;
import java.util.function.Consumer;

/**
 * Frozen pre-fix NativePlayerActivity progress/lifecycle methods, captured before
 * the delivery helper was introduced. Only the network endpoint and Android host
 * are doubles. Shared assertions must reject this baseline to show that the
 * regressions can actually detect the old bug, not merely match source strings.
 */
final class LegacyNativeVideoProgressHost extends NativeVideoProgressHostBase {
  private final ExecutorService executor;
  private final Consumer<NativePlaybackProgress.Snapshot> delivered;

  LegacyNativeVideoProgressHost(ExecutorService executor, Consumer<NativePlaybackProgress.Snapshot> delivered) {
    this.executor = executor;
    this.delivered = delivered;
  }

  @Override Runnable ticker() { return progressTicker; }

  private final Runnable progressTicker = new Runnable() {
    @Override
    public void run() {
      reportProgress(false);
      handler.postDelayed(this, 5000);
    }
  };

  @Override
  protected void onPause() {
    super.onPause();
    reportProgress(true);
    if (player != null) player.pause();
  }

  @Override
  protected void onResume() {
    super.onResume();
    hideSystemBars();
  }

  @Override
  protected void onDestroy() {
    reportProgress(true);
    handler.removeCallbacks(progressTicker);
    handler.removeCallbacks(statusHideRunnable);
    handler.removeCallbacks(overlayHideRunnable);
    if (player != null) {
      player.release();
      player = null;
    }
    executor.shutdownNow();
    super.onDestroy();
  }

  @Override
  final void reportProgress(boolean force) {
    if (!hasText(progressUrl) || player == null) return;
    long now = System.currentTimeMillis();
    if (!force && now - lastProgressAt < 4500) return;
    long positionMs = Math.max(0, streamOffsetMs + player.getCurrentPosition());
    long durationMs = player.getDuration();
    if (durationMs > 0 && streamOffsetMs > 0) durationMs += streamOffsetMs;
    if (durationMs <= 0 && probedDurationSeconds > 0) durationMs = secondsToMs(probedDurationSeconds);
    if (durationMs <= 0) return;
    lastProgressAt = now;

    double position = positionMs / 1000.0;
    double duration = durationMs / 1000.0;
    executor.execute(() -> postProgress(position, duration));
  }

  private void postProgress(double position, double duration) {
    // The former network method read Activity fields only when its queued task ran.
    delivered.accept(new NativePlaybackProgress.Snapshot(progressUrl, workId, position, duration));
  }

  private long secondsToMs(double seconds) {
    if (!Double.isFinite(seconds) || seconds <= 0) return 0;
    return Math.round(seconds * 1000.0);
  }

  private boolean hasText(String value) {
    return value != null && !value.trim().isEmpty();
  }
}
