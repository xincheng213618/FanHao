package local.fanhao.library;

import org.json.JSONArray;
import org.json.JSONObject;

/** Strict bounded decoder for the Activity result before it crosses into JavaScript. */
final class NativeShortVideoActionResultDecoder {
  static final int MAX_SNAPSHOTS = 512;
  static final int MAX_VIDEO_ID_CHARS = 512;
  static final int MAX_JSON_CHARS = 512 * 1024;
  private static final long MAX_SAFE_JS_INTEGER = 9007199254740991L;

  private NativeShortVideoActionResultDecoder() {}

  static JSONArray decode(String rawJson) {
    if (rawJson == null || rawJson.length() > MAX_JSON_CHARS) return empty();
    try {
      JSONArray source = new JSONArray(rawJson);
      if (source.length() > MAX_SNAPSHOTS) return empty();
      JSONArray decoded = new JSONArray();
      for (int index = 0; index < source.length(); index += 1) {
        JSONObject sourceRow = source.optJSONObject(index);
        if (sourceRow == null) return empty();
        Object rawVideoId = sourceRow.opt("videoId");
        if (!(rawVideoId instanceof String)) return empty();
        String videoId = ((String) rawVideoId).trim();
        if (videoId.length() == 0 || videoId.length() > MAX_VIDEO_ID_CHARS) return empty();
        JSONObject decodedRow = new JSONObject().put("videoId", videoId);
        int fields = 0;
        for (String key : new String[] { "liked", "collected" }) {
          if (!sourceRow.has(key)) continue;
          Object value = sourceRow.opt(key);
          if (!(value instanceof Boolean)) return empty();
          decodedRow.put(key, value);
          fields += 1;
        }
        for (String key : new String[] { "likes", "collects" }) {
          if (!sourceRow.has(key)) continue;
          Object value = sourceRow.opt(key);
          if (!(value instanceof Number)) return empty();
          double numeric = ((Number) value).doubleValue();
          if (!Double.isFinite(numeric) || numeric < 0 || numeric > MAX_SAFE_JS_INTEGER || numeric != Math.rint(numeric)) return empty();
          decodedRow.put(key, ((Number) value).longValue());
          fields += 1;
        }
        if (fields == 0) return empty();
        decoded.put(decodedRow);
      }
      return decoded;
    } catch (Exception ignored) {
      return empty();
    }
  }

  private static JSONArray empty() {
    return new JSONArray();
  }
}
