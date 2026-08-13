package local.fanhao.library;

import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.ThreadFactory;
import java.util.concurrent.TimeUnit;

final class NativeShortVideoDeleteTaskRunner implements NativeShortVideoDeleteController.TaskRunner {
  private final ScheduledExecutorService executor = Executors.newSingleThreadScheduledExecutor(new ThreadFactory() {
    @Override public Thread newThread(Runnable action) {
      Thread thread = new Thread(action, "FanHaoShortVideoDelete");
      thread.setDaemon(true);
      return thread;
    }
  });

  @Override public void execute(Runnable action) {
    executor.execute(action);
  }

  @Override public NativeShortVideoDeleteController.ScheduledTask schedule(Runnable action, long delayMs) {
    ScheduledFuture<?> future = executor.schedule(action, Math.max(0L, delayMs), TimeUnit.MILLISECONDS);
    return () -> future.cancel(true);
  }

  @Override public void shutdownNow() {
    executor.shutdownNow();
  }
}
