package local.fanhao.library;

import java.util.concurrent.RejectedExecutionException;

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

  interface PendingJobStore {
    NativeShortVideoPendingJob load() throws Exception;
    void save(NativeShortVideoPendingJob job) throws Exception;
    void clear() throws Exception;
  }

  interface ScheduledTask {
    void cancel();
  }
  interface TaskRunner {
    void execute(Runnable action);
    ScheduledTask schedule(Runnable action, long delayMs);
    void shutdownNow();
  }
  private final Host host;
  private final Transport transport;
  private final PendingJobStore pendingJobStore;
  private final TaskRunner runner;
  private final long pollDelayMs;
  private volatile boolean destroyed;
  private volatile boolean requestInFlight;
  private volatile long generation;
  private volatile ScheduledTask scheduledPoll;
  private volatile NativeShortVideoDeleteSession activeSession;
  NativeShortVideoDeleteController(Host host, Transport transport, PendingJobStore pendingJobStore) {
    this(host, transport, pendingJobStore, new NativeShortVideoDeleteTaskRunner(), DEFAULT_POLL_DELAY_MS);
  }

  NativeShortVideoDeleteController(Host host, Transport transport, PendingJobStore pendingJobStore, TaskRunner runner, long pollDelayMs) {
    if (host == null || transport == null || pendingJobStore == null || runner == null) throw new IllegalArgumentException("delete controller dependencies are required");
    this.host = host;
    this.transport = transport;
    this.pendingJobStore = pendingJobStore;
    this.runner = runner;
    this.pollDelayMs = Math.max(0L, pollDelayMs);
  }
  void confirmDelete(String videoId, String title, boolean group, String deleteUrl, String apiBaseUrl) {
    if (destroyed) return;
    if (deleteOperationActive()) {
      showOperationActive();
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
    requestInFlight = false;
    generation += 1L;
    cancelScheduledPoll();
    transport.cancel();
    runner.shutdownNow();
  }
  void restorePending(String currentApiBaseUrl) {
    if (destroyed || deleteOperationActive()) return;
    NativeShortVideoPendingJob pending;
    try {
      pending = pendingJobStore.load();
      if (pending == null) return;
      String currentBase = NativeShortVideoPendingJob.normalizeApiBase(currentApiBaseUrl);
      if (!currentBase.equals(pending.apiBaseUrl)) throw new IllegalArgumentException("上次删除任务属于其他服务");
    } catch (Exception error) {
      clearStoredJob();
      showRestoreNotice("上次删除恢复状态无效，已安全忽略：" + errorMessage(error, "数据损坏"));
      return;
    }
    long token = ++generation;
    activeSession = new NativeShortVideoDeleteSession(pending);
    poll(token, pending.jobId);
  }
  private void startDelete(String videoId, boolean group, String deleteUrl, String apiBaseUrl) {
    if (destroyed) return;
    if (deleteOperationActive()) {
      showOperationActive();
      return;
    }
    requestInFlight = true;
    long token = ++generation;
    cancelScheduledPoll();
    clearActiveJob();
    host.showPersistentStatus(group ? "正在删除同组短视频" : "正在删除短视频", "", null);
    if (!execute(() -> {
      try {
        DeleteResult result = transport.delete(deleteUrl, videoId);
        post(token, () -> handleDeleteResult(token, result, group, apiBaseUrl));
      } catch (Exception error) {
        post(token, () -> {
          requestInFlight = false;
          host.clearPersistentStatus();
          host.showTransientStatus(errorMessage(error, "短视频删除失败"));
        });
      }
    })) {
      requestInFlight = false;
      if (current(token)) {
        host.clearPersistentStatus();
        host.showTransientStatus("短视频删除任务无法启动");
      }
    }
  }
  private void handleDeleteResult(long token, DeleteResult result, boolean group, String apiBaseUrl) {
    if (!current(token)) return;
    if (result == null) {
      requestInFlight = false;
      host.clearPersistentStatus();
      host.showTransientStatus("删除接口没有返回结果");
      return;
    }
    try {
      if (result.cleanupPending()) {
        if (!startTracking(token, result, apiBaseUrl, NativeShortVideoPendingJob.KIND_CLEANUP, result.cleanupPendingFiles)) return;
        try { host.applyCommittedDelete(result, group); }
        catch (RuntimeException error) { activeSession.error = "界面更新失败，将继续跟踪删除任务：" + errorMessage(error, "未知错误"); }
        finishTracking(token);
        return;
      }
      if (!result.committed()) {
        if (startTracking(token, result, apiBaseUrl, NativeShortVideoPendingJob.KIND_ROLLBACK, 0)) finishTracking(token);
        return;
      }
      host.applyCommittedDelete(result, group);
      host.clearPersistentStatus();
    } finally {
      requestInFlight = false;
    }
  }
  private boolean deleteOperationActive() { return requestInFlight || activeSession != null; }
  private void showOperationActive() {
    if (activeSession != null && activeSession.statusLoaded) renderPending(generation);
    host.showTransientStatus("请先等待上一项删除恢复完成");
  }
  private boolean startTracking(long token, DeleteResult result, String apiBaseUrl, String kind, int pendingFiles) {
    try {
      activeSession = new NativeShortVideoDeleteSession(new NativeShortVideoPendingJob(result.jobId, apiBaseUrl, kind, pendingFiles));
      activeSession.statusLoaded = true;
      activeSession.manualIntervention = result.manualInterventionRequired;
      activeSession.processRestartRequired = result.processRestartRequired;
    } catch (Exception error) {
      clearStoredJob();
      host.showPersistentStatus("删除任务已提交，但恢复地址无效，需要人工检查。", "", null);
      return false;
    }
    if (persistActiveJob()) return true;
    finishTracking(token);
    return false;
  }
  private void finishTracking(long token) { renderPending(token); schedulePoll(token); }
  private void schedulePoll(long token) {
    NativeShortVideoDeleteSession session = activeSession;
    if (!current(token) || session == null || session.manualIntervention) return;
    cancelScheduledPoll();
    try {
      ScheduledTask next = runner.schedule(() -> poll(token, session.pendingJob.jobId), pollDelayMs);
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
        NativeShortVideoDeleteSession session = activeSession;
        if (session == null) return;
        NativeShortVideoDeleteJobState state = transport.status(session.pendingJob.apiBaseUrl, jobId);
        post(token, () -> handleJobState(token, state));
      } catch (Exception error) {
        post(token, () -> {
          if (!currentJob(token, jobId)) return;
          if (NativeShortVideoDeleteJobException.isJobNotFound(error)) {
            cancelScheduledPoll();
            clearStoredJob();
            clearActiveJob();
            showRestoreNotice("上次删除恢复记录已失效，已清除。");
            return;
          }
          activeSession.statusLoaded = true;
          activeSession.error = "状态读取失败，将继续重试：" + errorMessage(error, "网络错误");
          renderPending(token);
          schedulePoll(token);
        });
      }
    });
  }
  private void recover(long token, String jobId) {
    NativeShortVideoDeleteSession session = activeSession;
    if (!currentJob(token, jobId) || session == null || !session.recoverable || session.recovering || session.manualIntervention) return;
    cancelScheduledPoll();
    session.recovering = true;
    session.error = "";
    renderPending(token);
    execute(() -> {
      try {
        NativeShortVideoDeleteJobState state = transport.recover(session.pendingJob.apiBaseUrl, jobId);
        post(token, () -> handleJobState(token, state));
      } catch (Exception error) {
        post(token, () -> {
          if (!currentJob(token, jobId)) return;
          activeSession.recovering = false;
          activeSession.error = "恢复失败：" + errorMessage(error, "请稍后重试");
          renderPending(token);
          schedulePoll(token);
        });
      }
    });
  }
  private void handleJobState(long token, NativeShortVideoDeleteJobState state) {
    if (!currentJob(token, state == null ? "" : state.id)) return;
    if (state.completed()) {
      cancelScheduledPoll();
      String jobId = activeSession.pendingJob.jobId;
      clearStoredJob();
      clearActiveJob();
      host.showPersistentStatus("短视频文件已安全清理完成（任务 #" + jobId + "）", "知道了", () -> dismiss(token));
      return;
    }
    if (state.rolledBack()) {
      cancelScheduledPoll();
      String jobId = activeSession.pendingJob.jobId;
      clearStoredJob();
      clearActiveJob();
      host.showPersistentStatus("删除未生效，文件已安全恢复（任务 #" + jobId + "）", "知道了", () -> dismiss(token));
      return;
    }
    activeSession.update(state);
    if (state.cleanupPending()) activeSession = activeSession.withKind(NativeShortVideoPendingJob.KIND_CLEANUP);
    else if ("rollback_pending".equals(state.status) || "rollback".equals(state.phase)) {
      activeSession = activeSession.withKind(NativeShortVideoPendingJob.KIND_ROLLBACK);
    }
    persistActiveJob();
    renderPending(token);
    schedulePoll(token);
  }
  private void renderPending(long token) {
    NativeShortVideoDeleteSession session = activeSession;
    if (!current(token) || session == null) return;
    boolean canRecover = session.recoverable && !session.manualIntervention;
    String actionLabel = canRecover ? (session.recovering ? "恢复中" : "重试恢复") : "";
    Runnable action = canRecover && !session.recovering ? () -> recover(token, session.pendingJob.jobId) : null;
    host.showPersistentStatus(session.message(), actionLabel, action);
  }
  private void dismiss(long token) {
    if (!current(token)) return;
    clearStoredJob();
    host.clearPersistentStatus();
  }
  private void showRestoreNotice(String message) {
    long token = ++generation;
    host.showPersistentStatus(message, "知道了", () -> dismiss(token));
  }
  private boolean persistActiveJob() {
    NativeShortVideoDeleteSession session = activeSession;
    if (session == null) return false;
    try {
      pendingJobStore.save(session.pendingJob);
      return true;
    } catch (Exception error) {
      session.error = "恢复状态无法保存，请保持当前页面：" + errorMessage(error, "存储错误");
      return false;
    }
  }
  private void clearStoredJob() {
    try {
      pendingJobStore.clear();
    } catch (Exception error) {
      host.showTransientStatus("删除恢复记录清理失败，请稍后重试");
    }
  }
  private void post(long token, Runnable action) {
    if (!current(token)) return;
    host.post(() -> {
      if (current(token)) action.run();
    });
  }
  private boolean execute(Runnable action) {
    if (destroyed) return false;
    try {
      runner.execute(action);
      return true;
    } catch (RejectedExecutionException ignored) {
      // Activity teardown can race a queued confirmation callback.
      return false;
    }
  }
  private boolean current(long token) {
    return !destroyed && token == generation;
  }
  private boolean currentJob(long token, String jobId) {
    NativeShortVideoDeleteSession session = activeSession;
    return current(token) && session != null && session.pendingJob.jobId.equals(clean(jobId));
  }
  private void cancelScheduledPoll() {
    ScheduledTask pending = scheduledPoll;
    scheduledPoll = null;
    if (pending != null) pending.cancel();
  }
  private void clearActiveJob() { activeSession = null; }
  private static String clean(String value) { return value == null ? "" : value.trim(); }
  private static String errorMessage(Exception error, String fallback) {
    String message = error == null ? "" : clean(error.getMessage());
    return message.isEmpty() ? fallback : message;
  }
}
