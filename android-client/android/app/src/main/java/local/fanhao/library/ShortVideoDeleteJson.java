package local.fanhao.library;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

final class ShortVideoDeleteJson {
  private ShortVideoDeleteJson() {}

  static DeleteResult parse(int httpStatus, JSONObject data, String expectedId) {
    Map<String, Object> values = new HashMap<>();
    for (String key : new String[] {
      "ok", "accepted", "pending", "status", "jobId", "logicalDeleteCommitted",
      "physicalCleanupComplete", "cleanupPendingFiles", "recoveryRequired", "retryable",
      "ids", "count", "deletedFiles", "error"
    }) {
      if (!data.has(key) || data.isNull(key)) continue;
      Object value = data.opt(key);
      if (value instanceof JSONArray) {
        JSONArray array = (JSONArray) value;
        List<Object> items = new ArrayList<>();
        for (int index = 0; index < array.length(); index++) {
          Object item = array.opt(index);
          items.add(item == JSONObject.NULL ? null : item);
        }
        values.put(key, items);
      } else if (value != JSONObject.NULL) {
        values.put(key, value);
      }
    }
    return DeleteResult.fromHttp(httpStatus, values, expectedId);
  }
}
