package local.fanhao.library;

import org.json.JSONObject;

/** Decodes an accepted PUT response without inventing fields the server omitted. */
final class NativeShortVideoActionResponse {
  private NativeShortVideoActionResponse() {}

  static NativeShortVideoActionSnapshots.Snapshot snapshot(
      JSONObject video, NativeShortVideoActionState.Type type, boolean fallbackActive) {
    JSONObject actions = video == null ? null : video.optJSONObject("actions");
    JSONObject stats = video == null ? null : video.optJSONObject("stats");
    boolean hasLiked = actions != null && actions.has("liked")
      || actions == null && type == NativeShortVideoActionState.Type.LIKE;
    boolean hasCollected = actions != null && actions.has("collected")
      || actions == null && type == NativeShortVideoActionState.Type.COLLECT;
    return new NativeShortVideoActionSnapshots.Snapshot(
      hasLiked, actions == null ? fallbackActive : actions.optBoolean("liked", false),
      hasCollected, actions == null ? fallbackActive : actions.optBoolean("collected", false),
      stats != null && stats.has("likes"), stats == null ? 0 : stats.optLong("likes", 0),
      stats != null && stats.has("collects"), stats == null ? 0 : stats.optLong("collects", 0)
    );
  }
}
