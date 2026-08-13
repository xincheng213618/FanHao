package local.fanhao.library;

import java.net.URI;
import java.util.Locale;

/** Versioned minimal identity needed to resume a pending delete job safely. */
final class NativeShortVideoPendingJob {
  static final int SCHEMA_VERSION = 1;
  static final String KIND_CLEANUP = "cleanup";
  static final String KIND_ROLLBACK = "rollback";

  final String jobId;
  final String apiBaseUrl;
  final String kind;
  final int cleanupPendingFiles;

  NativeShortVideoPendingJob(String jobId, String apiBaseUrl, String kind, int cleanupPendingFiles) {
    this.jobId = validateJobId(jobId);
    this.apiBaseUrl = normalizeApiBase(apiBaseUrl);
    this.kind = validateKind(kind);
    if (cleanupPendingFiles < 0 || cleanupPendingFiles > 1_000_000) {
      throw new IllegalArgumentException("删除恢复任务待清理数量无效");
    }
    this.cleanupPendingFiles = cleanupPendingFiles;
  }

  static String normalizeApiBase(String value) {
    try {
      URI uri = new URI(clean(value));
      String scheme = clean(uri.getScheme()).toLowerCase(Locale.ROOT);
      String host = clean(uri.getHost()).toLowerCase(Locale.ROOT);
      String path = clean(uri.getRawPath());
      if (!("http".equals(scheme) || "https".equals(scheme)) || host.isEmpty()
        || uri.getRawUserInfo() != null || uri.getRawQuery() != null || uri.getRawFragment() != null
        || !(path.isEmpty() || "/".equals(path))) {
        throw new IllegalArgumentException("删除恢复服务地址无效");
      }
      return new URI(scheme, null, host, uri.getPort(), null, null, null).toString();
    } catch (IllegalArgumentException error) {
      throw error;
    } catch (Exception error) {
      throw new IllegalArgumentException("删除恢复服务地址无效", error);
    }
  }

  private static String validateJobId(String value) {
    String id = clean(value);
    if (id.length() < 8 || id.length() > 160 || !id.matches("[A-Za-z0-9._:-]+")) {
      throw new IllegalArgumentException("删除恢复任务 ID 无效");
    }
    return id;
  }

  private static String validateKind(String value) {
    String kind = clean(value);
    if (!KIND_CLEANUP.equals(kind) && !KIND_ROLLBACK.equals(kind)) {
      throw new IllegalArgumentException("删除恢复任务类型无效");
    }
    return kind;
  }

  private static String clean(String value) {
    return value == null ? "" : value.trim();
  }
}
