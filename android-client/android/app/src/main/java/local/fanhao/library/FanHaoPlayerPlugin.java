package local.fanhao.library;

import android.app.Activity;
import android.content.Intent;
import android.util.Log;

import androidx.annotation.OptIn;
import androidx.activity.result.ActivityResult;
import androidx.media3.common.util.UnstableApi;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;

import org.json.JSONArray;

@OptIn(markerClass = UnstableApi.class)
@CapacitorPlugin(name = "FanHaoPlayer")
public class FanHaoPlayerPlugin extends Plugin {
  private static final String TAG = "FanHaoPlayer";

  @PluginMethod
  public void play(PluginCall call) {
    String url = call.getString("url");
    if (url == null || url.trim().isEmpty()) {
      call.reject("缺少播放地址");
      return;
    }

    Intent intent = new Intent(getActivity(), NativePlayerActivity.class);
    intent.putExtra(NativePlayerActivity.EXTRA_URL, url);
    intent.putExtra(NativePlayerActivity.EXTRA_FALLBACK_URL, call.getString("fallbackUrl"));
    intent.putExtra(NativePlayerActivity.EXTRA_TITLE, call.getString("title"));
    intent.putExtra(NativePlayerActivity.EXTRA_SUBTITLE, call.getString("subtitle"));
    intent.putExtra(NativePlayerActivity.EXTRA_PROGRESS_URL, call.getString("progressUrl"));
    intent.putExtra(NativePlayerActivity.EXTRA_WORK_ID, call.getString("workId"));
    intent.putExtra(NativePlayerActivity.EXTRA_VIDEO_ID, call.getString("videoId"));
    intent.putExtra(NativePlayerActivity.EXTRA_MODE, call.getString("mode"));
    intent.putExtra(NativePlayerActivity.EXTRA_POSITION, call.getDouble("position", 0.0));
    intent.putExtra(NativePlayerActivity.EXTRA_DURATION, call.getDouble("duration", 0.0));
    Log.i(TAG, "Opening native player: " + url);
    getActivity().startActivity(intent);

    JSObject result = new JSObject();
    result.put("opened", true);
    call.resolve(result);
  }

  @PluginMethod
  public void playShortFeed(PluginCall call) {
    String videosJson = call.getString("videos");
    if (videosJson == null || videosJson.trim().isEmpty()) {
      call.reject("缺少短视频列表");
      return;
    }
    try {
      if (ShortVideoFeedContract.decode(videosJson, call.getString("baseUrl")).isEmpty()) {
        call.reject("短视频列表中没有可播放内容");
        return;
      }
    } catch (Exception error) {
      Log.w(TAG, "Rejected invalid native short-video feed", error);
      call.reject("短视频列表格式不受支持");
      return;
    }

    Intent intent = new Intent(getActivity(), NativeShortVideoActivity.class);
    intent.putExtra(NativeShortVideoActivity.EXTRA_VIDEOS_JSON, videosJson);
    intent.putExtra(NativeShortVideoActivity.EXTRA_START_INDEX, call.getInt("startIndex", 0));
    intent.putExtra(NativeShortVideoActivity.EXTRA_START_ID, call.getString("startId"));
    intent.putExtra(NativeShortVideoActivity.EXTRA_BASE_URL, call.getString("baseUrl"));
    intent.putExtra(NativeShortVideoActivity.EXTRA_FEED_URL, call.getString("feedUrl"));
    intent.putExtra(NativeShortVideoActivity.EXTRA_NEXT_OFFSET, call.getInt("nextOffset", 0));
    intent.putExtra(NativeShortVideoActivity.EXTRA_NEXT_CURSOR, call.getString("nextCursor"));
    intent.putExtra(NativeShortVideoActivity.EXTRA_HAS_MORE, call.getBoolean("hasMore", false));
    intent.putExtra(NativeShortVideoActivity.EXTRA_OPEN_AUTHOR_PANEL, call.getBoolean("openAuthorPanel", false));
    Log.i(TAG, "Opening native short video feed");
    try {
      startActivityForResult(call, intent, "playShortFeedResult");
      getActivity().overridePendingTransition(0, 0);
    } catch (Exception error) {
      call.reject("无法打开原生短视频", error);
    }
  }

  @ActivityCallback
  private void playShortFeedResult(PluginCall call, ActivityResult activityResult) {
    if (call == null) return;
    String expectedBase = NativeShortVideoActionState.serverScope(call.getString("baseUrl"));
    Intent data = activityResult == null ? null : activityResult.getData();
    boolean completed = activityResult != null && activityResult.getResultCode() == Activity.RESULT_OK && data != null;
    String returnedBase = completed
      ? NativeShortVideoActionState.serverScope(data.getStringExtra(NativeShortVideoActionResult.EXTRA_SERVER_BASE))
      : "";
    JSONArray snapshots = new JSONArray();
    if (completed && expectedBase.length() > 0 && expectedBase.equals(returnedBase)) {
      try {
        snapshots = new JSONArray(data.getStringExtra(NativeShortVideoActionResult.EXTRA_SNAPSHOTS_JSON));
      } catch (Exception error) {
        Log.w(TAG, "Ignored malformed native short-video action result", error);
      }
    }
    JSObject result = new JSObject();
    result.put("opened", true);
    result.put("canceled", !completed);
    result.put("serverBase", expectedBase);
    result.put("snapshots", snapshots);
    call.resolve(result);
  }
}
