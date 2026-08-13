package local.fanhao.library;

import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

public final class NativeShortVideoDeleteControllerHarness {
  public static void main(String[] args) {
    verifyCompletedAndCleanupPolling();
    verifyRollbackRecoveryFailureAndSuccess();
    verifyPollingCancellation();
    verifyDestroyedCallbackCannotReachHostUi();
    System.out.println("native-short-video-delete-controller: cleanup, rollback, recovery failure, polling cancel, and destroy checks passed");
  }

  private static void verifyCompletedAndCleanupPolling() {
    Fixture completed = new Fixture(DeleteResult.fromHttp(200, completed(), "video-1"));
    completed.confirm();
    equal(completed.host.applied, 1, "200 must apply the committed deletion once");
    equal(completed.runner.pendingSchedules(), 0, "200 must not start job polling");

    Fixture cleanup = new Fixture(DeleteResult.fromHttp(202, cleanupPending(), "video-1"));
    cleanup.transport.statuses.add(job("job-cleanup", "completed", "cleanup", false, false));
    cleanup.confirm();
    equal(cleanup.host.applied, 1, "202 must apply the logical deletion once");
    contains(cleanup.host.persistentMessage, "资料库记录已移除", "cleanup must remain visibly pending");
    cleanup.runner.runNextSchedule();
    contains(cleanup.host.persistentMessage, "已安全清理完成", "completed cleanup must become understandable terminal state");
    equal(cleanup.host.actionLabel, "知道了", "terminal cleanup must be dismissible");
  }

  private static void verifyRollbackRecoveryFailureAndSuccess() {
    Fixture rollback = new Fixture(DeleteResult.fromHttp(500, rollbackPending(), "video-1"));
    rollback.transport.statuses.add(job("job-rollback", "rollback_pending", "rollback", true, true));
    rollback.confirm();
    equal(rollback.host.applied, 0, "rollback_pending must not mutate the activity model");
    contains(rollback.host.persistentMessage, "删除尚未生效", "rollback must remain visibly pending");
    rollback.runner.runNextSchedule();
    equal(rollback.host.actionLabel, "重试恢复", "only recoverable jobs expose recovery");

    rollback.transport.recoveryError = new IllegalStateException("fixture recovery failed");
    rollback.host.runAction();
    contains(rollback.host.persistentMessage, "恢复失败", "recovery failure must remain visible");
    equal(rollback.host.actionLabel, "重试恢复", "recovery failure must retain the controlled retry");

    rollback.transport.recoveryError = null;
    rollback.transport.recovery = job("job-rollback", "rolled_back", "rollback", false, false);
    rollback.host.runAction();
    contains(rollback.host.persistentMessage, "文件已安全恢复", "successful rollback must explain that deletion did not apply");
    equal(rollback.host.applied, 0, "rollback completion must still leave the model untouched");
  }

  private static void verifyPollingCancellation() {
    Fixture fixture = new Fixture(DeleteResult.fromHttp(500, rollbackPending(), "video-1"));
    fixture.confirm();
    equal(fixture.runner.pendingSchedules(), 1, "rollback must schedule polling");
    fixture.controller.destroy();
    fixture.runner.runNextSchedule();
    equal(fixture.transport.statusCalls, 0, "destroy must cancel scheduled polling");
    check(fixture.transport.canceled, "destroy must cancel active HTTP transport");
    check(fixture.runner.shutdown, "destroy must stop the controller runner");
  }

  private static void verifyDestroyedCallbackCannotReachHostUi() {
    Fixture fixture = new Fixture(DeleteResult.fromHttp(200, completed(), "video-1"));
    fixture.host.queuePosts = true;
    fixture.confirm();
    equal(fixture.host.applied, 0, "queued callback must not apply before main-thread delivery");
    fixture.controller.destroy();
    fixture.host.flushPosts();
    equal(fixture.host.applied, 0, "destroyed activity must reject an old queued callback");
  }

  private static Map<String, Object> completed() {
    Map<String, Object> row = new HashMap<>();
    row.put("ok", true);
    row.put("accepted", true);
    row.put("pending", false);
    row.put("status", "completed");
    row.put("jobId", "job-completed");
    row.put("logicalDeleteCommitted", true);
    row.put("physicalCleanupComplete", true);
    row.put("cleanupPendingFiles", 0);
    row.put("ids", List.of("video-1"));
    row.put("count", 1);
    row.put("deletedFiles", List.of("video-1.mp4"));
    return row;
  }

  private static Map<String, Object> cleanupPending() {
    Map<String, Object> row = completed();
    row.put("pending", true);
    row.put("status", "cleanup_pending");
    row.put("jobId", "job-cleanup");
    row.put("physicalCleanupComplete", false);
    row.put("cleanupPendingFiles", 2);
    return row;
  }

  private static Map<String, Object> rollbackPending() {
    Map<String, Object> row = new HashMap<>();
    row.put("ok", false);
    row.put("accepted", false);
    row.put("pending", true);
    row.put("status", "rollback_pending");
    row.put("jobId", "job-rollback");
    row.put("recoveryRequired", true);
    row.put("retryable", true);
    return row;
  }

  private static NativeShortVideoDeleteJobState job(
    String id,
    String status,
    String phase,
    boolean pending,
    boolean recoverable
  ) {
    Map<String, Object> row = new HashMap<>();
    row.put("id", id);
    row.put("status", status);
    row.put("phase", phase);
    row.put("pending", pending);
    row.put("recoverable", recoverable);
    row.put("requiresAttention", recoverable);
    row.put("error", "");
    return NativeShortVideoDeleteJobState.fromMap(row, id);
  }

  private static final class Fixture {
    final FakeHost host = new FakeHost();
    final FakeTransport transport;
    final ManualRunner runner = new ManualRunner();
    final NativeShortVideoDeleteController controller;

    Fixture(DeleteResult result) {
      transport = new FakeTransport(result);
      controller = new NativeShortVideoDeleteController(host, transport, runner, 1L);
    }

    void confirm() {
      controller.confirmDelete("video-1", "测试视频", false, "http://fixture/delete", "http://fixture");
      host.confirm();
    }
  }

  private static final class FakeHost implements NativeShortVideoDeleteController.Host {
    final ArrayDeque<Runnable> posts = new ArrayDeque<>();
    boolean queuePosts;
    Runnable confirmation;
    Runnable action;
    String actionLabel = "";
    String persistentMessage = "";
    int applied;

    @Override public void post(Runnable value) {
      if (queuePosts) posts.add(value);
      else value.run();
    }

    @Override public void confirmDelete(String title, String message, Runnable onConfirm) {
      confirmation = onConfirm;
    }

    @Override public void showTransientStatus(String message) {}

    @Override public void showPersistentStatus(String message, String label, Runnable value) {
      persistentMessage = message;
      actionLabel = label;
      action = value;
    }

    @Override public void clearPersistentStatus() {
      persistentMessage = "";
      actionLabel = "";
      action = null;
    }

    @Override public void applyCommittedDelete(DeleteResult result, boolean group) {
      applied += 1;
    }

    void confirm() {
      Runnable value = confirmation;
      confirmation = null;
      if (value == null) throw new AssertionError("confirmation callback missing");
      value.run();
    }

    void runAction() {
      Runnable value = action;
      if (value == null) throw new AssertionError("status action missing");
      value.run();
    }

    void flushPosts() {
      while (!posts.isEmpty()) posts.removeFirst().run();
    }
  }

  private static final class FakeTransport implements NativeShortVideoDeleteController.Transport {
    final DeleteResult result;
    final ArrayDeque<NativeShortVideoDeleteJobState> statuses = new ArrayDeque<>();
    NativeShortVideoDeleteJobState recovery;
    Exception recoveryError;
    boolean canceled;
    int statusCalls;

    FakeTransport(DeleteResult result) {
      this.result = result;
    }

    @Override public DeleteResult delete(String url, String expectedVideoId) {
      return result;
    }

    @Override public NativeShortVideoDeleteJobState status(String apiBaseUrl, String jobId) {
      statusCalls += 1;
      NativeShortVideoDeleteJobState state = statuses.pollFirst();
      if (state == null) throw new IllegalStateException("fixture status missing");
      return state;
    }

    @Override public NativeShortVideoDeleteJobState recover(String apiBaseUrl, String jobId) throws Exception {
      if (recoveryError != null) throw recoveryError;
      if (recovery == null) throw new IllegalStateException("fixture recovery missing");
      return recovery;
    }

    @Override public void cancel() {
      canceled = true;
    }
  }

  private static final class ManualRunner implements NativeShortVideoDeleteController.TaskRunner {
    final ArrayDeque<Entry> scheduled = new ArrayDeque<>();
    boolean shutdown;

    @Override public void execute(Runnable action) {
      if (!shutdown) action.run();
    }

    @Override public NativeShortVideoDeleteController.ScheduledTask schedule(Runnable action, long delayMs) {
      Entry entry = new Entry(action);
      scheduled.add(entry);
      return () -> entry.canceled = true;
    }

    @Override public void shutdownNow() {
      shutdown = true;
      for (Entry entry : scheduled) entry.canceled = true;
    }

    int pendingSchedules() {
      int count = 0;
      for (Entry entry : scheduled) if (!entry.canceled) count += 1;
      return count;
    }

    void runNextSchedule() {
      while (!scheduled.isEmpty()) {
        Entry entry = scheduled.removeFirst();
        if (!entry.canceled && !shutdown) {
          entry.action.run();
          return;
        }
      }
    }
  }

  private static final class Entry {
    final Runnable action;
    boolean canceled;

    Entry(Runnable action) {
      this.action = action;
    }
  }

  private static void check(boolean value, String message) {
    if (!value) throw new AssertionError(message);
  }

  private static void contains(String actual, String expected, String message) {
    if (actual == null || !actual.contains(expected)) throw new AssertionError(message + ": " + actual);
  }

  private static void equal(Object actual, Object expected, String message) {
    if (!expected.equals(actual)) throw new AssertionError(message + ": expected=" + expected + " actual=" + actual);
  }

  private NativeShortVideoDeleteControllerHarness() {}
}
