package local.fanhao.library;

import android.content.Context;
import android.content.SharedPreferences;

import org.json.JSONObject;

/** Atomic single-record SharedPreferences store for a resumable delete job. */
final class NativeShortVideoPendingJobPreferences implements NativeShortVideoDeleteController.PendingJobStore {
  private static final String PREFERENCES = "fanhao-short-video-delete";
  private static final String KEY_PENDING_JOB = "pending-job-v1";
  private final SharedPreferences preferences;

  NativeShortVideoPendingJobPreferences(Context context) {
    preferences = context.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE);
  }

  @Override public NativeShortVideoPendingJob load() throws Exception {
    String raw = preferences.getString(KEY_PENDING_JOB, "");
    if (raw == null || raw.trim().isEmpty()) return null;
    JSONObject row = new JSONObject(raw);
    if (row.length() != 5 || !numberEquals(row.opt("schemaVersion"), NativeShortVideoPendingJob.SCHEMA_VERSION)) {
      throw new IllegalArgumentException("删除恢复记录版本无效");
    }
    Object pendingFiles = row.opt("cleanupPendingFiles");
    if (!(pendingFiles instanceof Number) || ((Number) pendingFiles).doubleValue() != ((Number) pendingFiles).intValue()) {
      throw new IllegalArgumentException("删除恢复记录数量无效");
    }
    return new NativeShortVideoPendingJob(
      strictString(row, "jobId"),
      strictString(row, "apiBaseUrl"),
      strictString(row, "kind"),
      ((Number) pendingFiles).intValue()
    );
  }

  @Override public void save(NativeShortVideoPendingJob job) throws Exception {
    JSONObject row = new JSONObject()
      .put("schemaVersion", NativeShortVideoPendingJob.SCHEMA_VERSION)
      .put("jobId", job.jobId)
      .put("apiBaseUrl", job.apiBaseUrl)
      .put("kind", job.kind)
      .put("cleanupPendingFiles", job.cleanupPendingFiles);
    if (!preferences.edit().putString(KEY_PENDING_JOB, row.toString()).commit()) {
      throw new IllegalStateException("删除恢复记录保存失败");
    }
  }

  @Override public void clear() throws Exception {
    if (!preferences.edit().remove(KEY_PENDING_JOB).commit()) {
      throw new IllegalStateException("删除恢复记录清理失败");
    }
  }

  private static String strictString(JSONObject row, String key) {
    Object value = row.opt(key);
    if (!(value instanceof String)) throw new IllegalArgumentException("删除恢复记录字段 " + key + " 无效");
    return (String) value;
  }

  private static boolean numberEquals(Object value, int expected) {
    return value instanceof Number && ((Number) value).doubleValue() == expected;
  }
}
