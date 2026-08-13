package local.fanhao.library;

import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.ThreadFactory;
import java.util.concurrent.TimeUnit;

/** Owns native delete confirmation, durable job tracking, recovery, and lifecycle cancellation. */
final class NativeShortVideoDeleteController {
  private static final long DEFAULT_POLL_DELAY_MS = 1400L;

  interface Host {
    void post(Runnable action);
    void confirmDelete(String title, String message, Runnable onConfirm);
    void showTransientStatus(String message);
    void showPersistentStatus(String message, String actionLabel, Runnable action);
    void clearPersistentStatus();
    void applyCommittedDelete(DeleteResult result, boolean group);
  }

  interface Transport {
    DeleteResult delete(String url, String expectedVideoId) throws Exception;
    NativeShortVideoDeleteJobState status(String apiBaseUrl, String jobId) throws Exception;
    NativeShortVideoDeleteJobState recover(String apiBaseUrl, String jobId) throws Exception;
    void cancel();
  }

  interface ScheduledTask {
    void cancel();
  }

  interface TaskRunner {
    void execute(Runnable action);
    ScheduledTask schedule(Runnable action, long delayMs);
    void shutdownNow();
  }

  private enum PendingKind {
    CLEANUP,
    ROLLBACK
  }

  private final Host host;
  private final Transport transport;
  private final TaskRunner runner;
  private final long pollDelayMs;
  private volatile boolean destroyed;
  private volatile long generation;
  private volatile ScheduledTask scheduledPoll;
  private volatile String activeJobId = "";
  private volatile String activeApiBaseUrl = "";
  private volatile PendingKind activeKind = PendingKind.ROLLBACK;
  private volatile int cleanupPendingFiles;
  private volatile boolean recoverable;
  private volatile boolean recovering;
  private volatile String pendingError = "";

  NativeShortVideoDeleteController(Host host, Transport transport) {
    this(host, transport, new ExecutorTaskRunner(), DEFAULT_POLL_DELAY_MS);
  }

  NativeShortVideoDeleteController(Host host, Transport transport, TaskRunner runner, long pollDelayMs) {
    if (host == null || transport == null || runner == null) throw new IllegalArgumentException("delete controller dependencies are required");
    this.host = host;
    this.transport = transport;
    this.runner = runner;
    this.pollDelayMs = Math.max(0L, pollDelayMs);
  }

  void confirmDelete(String videoId, String title, boolean group, String deleteUrl, String apiBaseUrl) {
    if (destroyed) return;
    if (!activeJobId.isEmpty()) {
      renderPending(generation);
      host.showTransientStatus("请先等待上一项删除恢复完成");
      return;
    }
    String id = clean(videoId);
    String url = clean(deleteUrl);
    if (id.isEmpty() || url.isEmpty()) {
      host.showTransientStatus("没有可用的删除接口");
      return;
    }
    String promptTitle = group ? "删除同组短视频？" : "删除这条短视频？";
    String displayTitle = clean(title).isEmpty() ? "当前短视频" : clean(title);
    String message = displayTitle + "\n\n" + (group
      ? "会删除同一个本地文件夹下的短视频记录，以及这些记录引用且未被组外引用的本地文件。"
      : "会删除资料库记录以及这条记录引用的本地视频文件。");
    host.confirmDelete(promptTitle, message, () -> startDelete(id, group, url, clean(apiBaseUrl)));
  }

  void destroy() {
    if (destroyed) return;
    destroyed = true;
    generation += 1L;
    cancelScheduledPoll();
    transport.cancel();
    runner.shutdownNow();
  }

  private void startDelete(String videoId, boolean group, String deleteUrl, String apiBaseUrl) {
    if (destroyed) return;
    long token = ++generation;
    cancelScheduledPoll();
    clearActiveJob();
    host.showPersistentStatus(group ? "正在删除同组短视频" : "正在删除短视频", "", null);
    execute(() -> {
      try {
        DeleteResult result = transport.delete(deleteUrl, videoId);
        post(token, () -> handleDeleteResult(token, result, group, apiBaseUrl));
      } catch (Exception error) {
        post(token, () -> {
          host.clearPersistentStatus();
          host.showTransientStatus(errorMessage(error, "短视频删除失败"));
        });
      }
    });
  }

  private void handleDeleteResult(long token, DeleteResult result, boolean group, String apiBaseUrl) {
    if (!current(token) || result == null) return;
    if (result.committed()) host.applyCommittedDelete(result, group);
    if (result.cleanupPending()) {
      startTracking(token, result.jobId, apiBaseUrl, PendingKind.CLEANUP, result.cleanupPendingFiles);
      return;
    }
    if (!result.committed()) {
      startTracking(token, result.jobId, apiBaseUrl, PendingKind.ROLLBACK, 0);
      return;
    }
    host.clearPersistentStatus();
  }

  private void startTracking(long token, String jobId, String apiBaseUrl, PendingKind kind, int pendingFiles) {
    activeJobId = clean(jobId);
    activeApiBaseUrl = clean(apiBaseUrl);
    activeKind = kind;
    cleanupPendingFiles = Math.max(0, pendingFiles);
    recoverable = false;
    recovering = false;
    pendingError = "";
    renderPending(token);
    schedulePoll(token);
  }

  private void schedulePoll(long token) {
    if (!current(token) || activeJobId.isEmpty()) return;
    cancelScheduledPoll();
    try {
      ScheduledTask next = runner.schedule(() -> poll(token, activeJobId), pollDelayMs);
      if (current(token)) scheduledPoll = next;
      else next.cancel();
    } catch (RejectedExecutionException ignored) {
      // Activity teardown can race a poll scheduled by an already-posted callback.
    }
  }

  private void poll(long token, String jobId) {
    if (!currentJob(token, jobId)) return;
    execute(() -> {
      try {
        NativeShortVideoDeleteJobState state = transport.status(activeApiBaseUrl, jobId);
        post(token, () -> handleJobState(token, state));
      } catch (Exception error) {
        post(token, () -> {
          if (!currentJob(token, jobId)) return;
          pendingError = "状态读取失败，将继续重试：" + errorMessage(error, "网络错误");
          renderPending(token);
          schedulePoll(token);
        });
      }
    });
  }

  private void recover(long token, String jobId) {
    if (!currentJob(token, jobId) || !recoverable || recovering) return;
    cancelScheduledPoll();
    recovering = true;
    pendingError = "";
    renderPending(token);
    execute(() -> {
      try {
        NativeShortVideoDeleteJobState state = transport.recover(activeApiBaseUrl, jobId);
        post(token, () -> handleJobState(token, state));
      } catch (Exception error) {
        post(token, () -> {
          if (!currentJob(token, jobId)) return;
          recovering = false;
          pendingError = "恢复失败：" + errorMessage(error, "请稍后重试");
          renderPending(token);
          schedulePoll(token);
        });
      }
    });
  }

  private void handleJobState(long token, NativeShortVideoDeleteJobState state) {
    if (!currentJob(token, state == null ? "" : state.id)) return;
    recovering = false;
    pendingError = state.error;
    recoverable = state.recoverable;
    if (state.completed()) {
      cancelScheduledPoll();
      String jobId = activeJobId;
      clearActiveJob();
      host.showPersistentStatus("短视频文件已安全清理完成（任务 #" + jobId + "）", "知道了", () -> dismiss(token));
      return;
    }
    if (state.rolledBack()) {
      cancelScheduledPoll();
      String jobId = activeJobId;
      clearActiveJob();
      host.showPersistentStatus("删除未生效，文件已安全恢复（任务 #" + jobId + "）", "知道了", () -> dismiss(token));
      return;
    }
    if (state.cleanupPending()) activeKind = PendingKind.CLEANUP;
    else if ("rollback_pending".equals(state.status) || "rollback".equals(state.phase)) activeKind = PendingKind.ROLLBACK;
    renderPending(token);
    schedulePoll(token);
  }

  private void renderPending(long token) {
    if (!current(token)) return;
    String message;
    if (activeKind == PendingKind.CLEANUP) {
      String files = cleanupPendingFiles > 0 ? cleanupPendingFiles + " 个文件" : "文件";
      message = "资料库记录已移除，正在安全清理" + files + "（任务 #" + activeJobId + "）";
    } else {
      message = "删除尚未生效，正在安全恢复（任务 #" + activeJobId + "）";
    }
    if (!pendingError.isEmpty()) message += "\n" + pendingError;
    String actionLabel = recoverable ? (recovering ? "恢复中" : "重试恢复") : "";
    Runnable action = recoverable && !recovering ? () -> recover(token, activeJobId) : null;
    host.showPersistentStatus(message, actionLabel, action);
  }

  private void dismiss(long token) {
    if (!current(token)) return;
    host.clearPersistentStatus();
  }

  private void post(long token, Runnable action) {
    if (!current(token)) return;
    host.post(() -> {
      if (current(token)) action.run();
    });
  }

  private void execute(Runnable action) {
    if (destroyed) return;
    try {
      runner.execute(action);
    } catch (RejectedExecutionException ignored) {
      // Activity teardown can race a queued confirmation callback.
    }
  }

  private boolean current(long token) {
    return !destroyed && token == generation;
  }

  private boolean currentJob(long token, String jobId) {
    return current(token) && !activeJobId.isEmpty() && activeJobId.equals(clean(jobId));
  }

  private void cancelScheduledPoll() {
    ScheduledTask pending = scheduledPoll;
    scheduledPoll = null;
    if (pending != null) pending.cancel();
  }

  private void clearActiveJob() {
    activeJobId = "";
    activeApiBaseUrl = "";
    recoverable = false;
    recovering = false;
    pendingError = "";
    cleanupPendingFiles = 0;
  }

  private static String clean(String value) {
    return value == null ? "" : value.trim();
  }

  private static String errorMessage(Exception error, String fallback) {
    String message = error == null ? "" : clean(error.getMessage());
    return message.isEmpty() ? fallback : message;
  }

  private static final class ExecutorTaskRunner implements TaskRunner {
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

    @Override public ScheduledTask schedule(Runnable action, long delayMs) {
      ScheduledFuture<?> future = executor.schedule(action, Math.max(0L, delayMs), TimeUnit.MILLISECONDS);
      return () -> future.cancel(true);
    }

    @Override public void shutdownNow() {
      executor.shutdownNow();
    }
  }
}
