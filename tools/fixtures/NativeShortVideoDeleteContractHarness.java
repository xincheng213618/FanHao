package local.fanhao.library;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

public final class NativeShortVideoDeleteContractHarness {
  public static void main(String[] args) {
    DeleteResult completed = DeleteResult.fromHttp(200, completed(), "video-1");
    check(completed.committed(), "200 completed must commit");
    check(!completed.cleanupPending(), "200 completed must be terminal");

    DeleteResult cleanup = DeleteResult.fromHttp(202, cleanupPending(), "video-1");
    check(cleanup.committed(), "202 cleanup_pending must commit logical deletion");
    check(cleanup.cleanupPending(), "202 must retain cleanup state");
    equal(cleanup.cleanupMessage(), "资料库记录已移除，2 个文件待清理（任务 #job-cleanup）", "cleanup message");

    for (Map<String, Object> invalid : invalidCleanupPayloads()) {
      rejects(() -> DeleteResult.fromHttp(202, invalid, "video-1"), "malformed 202 must fail closed");
    }

    DeleteResult rollback = DeleteResult.fromHttp(500, rollbackPending(), "video-1");
    check(!rollback.committed(), "500 rollback_pending must not apply deletion");
    equal(rollback.recoveryMessage(), "删除尚未提交，正在安全恢复（任务 #job-rollback）", "rollback message");

    Map<String, Object> malformedRollback = rollbackPending();
    malformedRollback.put("recoveryRequired", false);
    rejects(() -> DeleteResult.fromHttp(500, malformedRollback, "video-1"), "malformed rollback must fail closed");
    rejects(() -> DeleteResult.fromHttp(200, cleanupPending(), "video-1"), "HTTP/status mismatch must fail closed");
    rejects(() -> DeleteResult.fromHttp(202, completed(), "video-1"), "HTTP/status mismatch must fail closed");
    System.out.println("native-short-video-delete-contract: 200, 202, malformed, and rollback checks passed");
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

  private static List<Map<String, Object>> invalidCleanupPayloads() {
    List<Map<String, Object>> rows = new ArrayList<>();
    rows.add(changed(cleanupPending(), "ok", "true"));
    rows.add(changed(cleanupPending(), "accepted", false));
    rows.add(changed(cleanupPending(), "pending", false));
    rows.add(changed(cleanupPending(), "status", "completed"));
    rows.add(changed(cleanupPending(), "jobId", ""));
    rows.add(changed(cleanupPending(), "cleanupPendingFiles", -1));
    rows.add(changed(cleanupPending(), "cleanupPendingFiles", 1.5));
    rows.add(changed(cleanupPending(), "physicalCleanupComplete", true));
    rows.add(changed(cleanupPending(), "logicalDeleteCommitted", false));
    rows.add(changed(cleanupPending(), "ids", List.of()));
    rows.add(changed(cleanupPending(), "count", 2));
    return rows;
  }

  private static Map<String, Object> changed(Map<String, Object> row, String key, Object value) {
    row.put(key, value);
    return row;
  }

  private static void rejects(Runnable action, String message) {
    try {
      action.run();
      throw new AssertionError(message);
    } catch (IllegalArgumentException expected) {
      // Expected contract rejection.
    }
  }

  private static void check(boolean value, String message) {
    if (!value) throw new AssertionError(message);
  }

  private static void equal(Object actual, Object expected, String message) {
    if (!expected.equals(actual)) throw new AssertionError(message + ": expected=" + expected + " actual=" + actual);
  }
}
