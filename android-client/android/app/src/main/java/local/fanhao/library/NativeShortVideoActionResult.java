package local.fanhao.library;

import android.content.Intent;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.util.Map;

/** Activity-result transport for server-acknowledged native short-video actions. */
final class NativeShortVideoActionResult {
  static final String EXTRA_SERVER_BASE = "actionServerBase";
  static final String EXTRA_SNAPSHOTS_JSON = "actionSnapshotsJson";
  private final NativeShortVideoActionSnapshots acknowledged = new NativeShortVideoActionSnapshots();

  void accept(String videoId, NativeShortVideoActionSnapshots.Snapshot snapshot) {
    acknowledged.accept(videoId, snapshot);
  }

  JSONArray toJson() {
    JSONArray rows = new JSONArray();
    for (Map.Entry<String, NativeShortVideoActionSnapshots.Snapshot> entry : acknowledged.snapshotMap().entrySet()) {
      NativeShortVideoActionSnapshots.Snapshot snapshot = entry.getValue();
      try {
        JSONObject row = new JSONObject().put("videoId", entry.getKey());
        if (snapshot.hasLiked) row.put("liked", snapshot.liked);
        if (snapshot.hasCollected) row.put("collected", snapshot.collected);
        if (snapshot.hasLikes) row.put("likes", snapshot.likes);
        if (snapshot.hasCollects) row.put("collects", snapshot.collects);
        rows.put(row);
      } catch (JSONException ignored) {}
    }
    return rows;
  }

  Intent intent(String serverBase) {
    return new Intent()
      .putExtra(EXTRA_SERVER_BASE, NativeShortVideoActionState.serverScope(serverBase))
      .putExtra(EXTRA_SNAPSHOTS_JSON, toJson().toString());
  }
}
