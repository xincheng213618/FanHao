package local.fanhao.library;

import java.util.Map;

/** Strict client view of the public short-video delete-job status contract. */
final class NativeShortVideoDeleteJobState {
  final String id;
  final String status;
  final String phase;
  final boolean pending;
  final boolean recoverable;
  final boolean requiresAttention;
  final boolean manualInterventionRequired;
  final boolean processRestartRequired;
  final boolean stalled;
  final boolean retryable;
  final String error;

  private NativeShortVideoDeleteJobState(
    String id,
    String status,
    String phase,
    boolean pending,
    boolean recoverable,
    boolean requiresAttention,
    boolean manualInterventionRequired,
    boolean processRestartRequired,
    boolean stalled,
    boolean retryable,
    String error
  ) {
    this.id = id;
    this.status = status;
    this.phase = phase;
    this.pending = pending;
    this.recoverable = recoverable;
    this.requiresAttention = requiresAttention;
    this.manualInterventionRequired = manualInterventionRequired;
    this.processRestartRequired = processRestartRequired;
    this.stalled = stalled;
    this.retryable = retryable;
    this.error = error;
  }

  static NativeShortVideoDeleteJobState fromMap(Map<String, Object> row, String expectedJobId) {
    if (row == null) throw invalid("删除恢复接口返回了无效任务");
    String id = requireString(row, "id");
    String expected = clean(expectedJobId);
    if (!expected.isEmpty() && !expected.equals(id)) throw invalid("删除恢复接口返回了其他任务");
    String status = requireString(row, "status");
    if (!isSupportedStatus(status)) throw invalid("删除恢复接口返回了未知状态");
    boolean pending = requireBoolean(row, "pending");
    boolean expectedPending = isPendingStatus(status);
    if (pending != expectedPending) throw invalid("删除恢复任务状态与 pending 不一致");
    boolean recoverable = optionalBoolean(row, "recoverable", false);
    if (!pending && recoverable) throw invalid("已结束的删除恢复任务不能声明可恢复");
    return new NativeShortVideoDeleteJobState(
      id,
      status,
      clean(row.get("phase")),
      pending,
      recoverable,
      optionalBoolean(row, "requiresAttention", false),
      optionalBoolean(row, "manualInterventionRequired", false),
      optionalBoolean(row, "processRestartRequired", false),
      optionalBoolean(row, "stalled", false),
      optionalBoolean(row, "retryable", false),
      clean(row.get("error"))
    );
  }
  boolean completed() {
    return "completed".equals(status);
  }
  boolean rolledBack() {
    return "rolled_back".equals(status);
  }
  boolean cleanupPending() {
    return "cleanup_pending".equals(status) || "cleanup".equals(phase);
  }
  private static boolean isPendingStatus(String value) {
    return "running".equals(value) || "cleanup_pending".equals(value) || "rollback_pending".equals(value);
  }
  private static boolean isSupportedStatus(String value) {
    return isPendingStatus(value) || "completed".equals(value) || "rolled_back".equals(value);
  }
  private static String requireString(Map<String, Object> row, String key) {
    String value = clean(row.get(key));
    if (value.isEmpty()) throw invalid("删除恢复任务字段 " + key + " 无效");
    return value;
  }

  private static boolean requireBoolean(Map<String, Object> row, String key) {
    if (!(row.get(key) instanceof Boolean)) throw invalid("删除恢复任务字段 " + key + " 无效");
    return (Boolean) row.get(key);
  }

  private static boolean optionalBoolean(Map<String, Object> row, String key, boolean fallback) {
    if (!row.containsKey(key)) return fallback;
    return requireBoolean(row, key);
  }

  private static String clean(Object value) {
    return value == null ? "" : String.valueOf(value).trim();
  }

  private static IllegalArgumentException invalid(String message) {
    return new IllegalArgumentException(message);
  }
}
