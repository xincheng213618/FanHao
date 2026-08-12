package local.fanhao.library;

import java.util.Collections;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

/** Pure Java validation for the durable short-video deletion response contract. */
final class DeleteResult {
  enum Outcome {
    COMPLETED,
    CLEANUP_PENDING,
    ROLLBACK_PENDING
  }

  final int httpStatus;
  final Outcome outcome;
  final Set<String> ids;
  final int count;
  final int deletedFiles;
  final int cleanupPendingFiles;
  final String jobId;

  private DeleteResult(
    int httpStatus,
    Outcome outcome,
    Set<String> ids,
    int count,
    int deletedFiles,
    int cleanupPendingFiles,
    String jobId
  ) {
    this.httpStatus = httpStatus;
    this.outcome = outcome;
    this.ids = Collections.unmodifiableSet(ids);
    this.count = count;
    this.deletedFiles = deletedFiles;
    this.cleanupPendingFiles = cleanupPendingFiles;
    this.jobId = jobId;
  }

  static DeleteResult fromHttp(int httpStatus, Map<String, Object> row, String expectedId) {
    if (row == null) throw invalid("删除接口返回了无效 JSON");
    if (httpStatus == 200) return committed(httpStatus, row, expectedId, Outcome.COMPLETED);
    if (httpStatus == 202) return committed(httpStatus, row, expectedId, Outcome.CLEANUP_PENDING);
    if (httpStatus == 500 && "rollback_pending".equals(row.get("status"))) return rollbackPending(row);
    String message = stringValue(row.get("error"));
    throw invalid(message.length() > 0 ? message : "短视频删除失败");
  }

  boolean committed() {
    return outcome != Outcome.ROLLBACK_PENDING;
  }

  boolean cleanupPending() {
    return outcome == Outcome.CLEANUP_PENDING;
  }

  String recoveryMessage() {
    return "删除尚未提交，正在安全恢复（任务 #" + jobId + "）";
  }

  String cleanupMessage() {
    return "资料库记录已移除，" + cleanupPendingFiles + " 个文件待清理（任务 #" + jobId + "）";
  }

  private static DeleteResult committed(int httpStatus, Map<String, Object> row, String expectedId, Outcome outcome) {
    boolean cleanupPending = outcome == Outcome.CLEANUP_PENDING;
    requireExact(row, "ok", Boolean.TRUE);
    requireExact(row, "accepted", Boolean.TRUE);
    requireExact(row, "pending", cleanupPending ? Boolean.TRUE : Boolean.FALSE);
    requireExact(row, "status", cleanupPending ? "cleanup_pending" : "completed");
    requireExact(row, "logicalDeleteCommitted", Boolean.TRUE);
    requireExact(row, "physicalCleanupComplete", cleanupPending ? Boolean.FALSE : Boolean.TRUE);

    String jobId = requireString(row, "jobId");
    int cleanupPendingFiles = requireNonNegativeInteger(row, "cleanupPendingFiles");
    if (!cleanupPending && cleanupPendingFiles != 0) {
      throw invalid("已完成的删除响应仍声明有待清理文件");
    }

    Set<String> ids = requireIds(row.get("ids"));
    String expected = expectedId == null ? "" : expectedId.trim();
    if (expected.length() > 0 && !ids.contains(expected)) {
      throw invalid("删除响应未包含请求的记录 ID");
    }
    int count = requireNonNegativeInteger(row, "count");
    if (count != ids.size()) throw invalid("删除响应的记录数量与 ID 列表不一致");
    Object deletedFilesValue = row.get("deletedFiles");
    if (!(deletedFilesValue instanceof List<?>)) throw invalid("删除响应缺少文件结果列表");

    return new DeleteResult(
      httpStatus,
      outcome,
      ids,
      count,
      ((List<?>) deletedFilesValue).size(),
      cleanupPendingFiles,
      jobId
    );
  }

  private static DeleteResult rollbackPending(Map<String, Object> row) {
    requireExact(row, "ok", Boolean.FALSE);
    requireExact(row, "accepted", Boolean.FALSE);
    requireExact(row, "pending", Boolean.TRUE);
    requireExact(row, "status", "rollback_pending");
    requireExact(row, "recoveryRequired", Boolean.TRUE);
    requireExact(row, "retryable", Boolean.TRUE);
    return new DeleteResult(
      500,
      Outcome.ROLLBACK_PENDING,
      new LinkedHashSet<>(),
      0,
      0,
      0,
      requireString(row, "jobId")
    );
  }

  private static Set<String> requireIds(Object value) {
    if (!(value instanceof List<?>)) throw invalid("删除响应缺少已提交的记录 ID");
    Set<String> ids = new LinkedHashSet<>();
    for (Object item : (List<?>) value) {
      if (!(item instanceof String)) throw invalid("删除响应包含无效记录 ID");
      String id = ((String) item).trim();
      if (id.length() == 0) throw invalid("删除响应包含无效记录 ID");
      ids.add(id);
    }
    if (ids.isEmpty()) throw invalid("删除响应缺少已提交的记录 ID");
    return ids;
  }

  private static void requireExact(Map<String, Object> row, String key, Object expected) {
    if (!row.containsKey(key) || !expected.equals(row.get(key))) {
      throw invalid("删除响应字段 " + key + " 无效");
    }
  }

  private static String requireString(Map<String, Object> row, String key) {
    Object value = row.get(key);
    if (!(value instanceof String) || ((String) value).trim().length() == 0) {
      throw invalid("删除响应字段 " + key + " 无效");
    }
    return ((String) value).trim();
  }

  private static int requireNonNegativeInteger(Map<String, Object> row, String key) {
    Object value = row.get(key);
    if (!(value instanceof Number)) throw invalid("删除响应字段 " + key + " 无效");
    double number = ((Number) value).doubleValue();
    if (!Double.isFinite(number) || number < 0 || number != Math.rint(number) || number > Integer.MAX_VALUE) {
      throw invalid("删除响应字段 " + key + " 无效");
    }
    return (int) number;
  }

  private static String stringValue(Object value) {
    return value instanceof String ? ((String) value).trim() : "";
  }

  private static IllegalArgumentException invalid(String message) {
    return new IllegalArgumentException(message);
  }
}
