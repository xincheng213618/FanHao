package local.fanhao.library;

import android.content.Intent;
import android.util.Log;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

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

    Intent intent = new Intent(getActivity(), NativeShortVideoActivity.class);
    intent.putExtra(NativeShortVideoActivity.EXTRA_VIDEOS_JSON, videosJson);
    intent.putExtra(NativeShortVideoActivity.EXTRA_START_INDEX, call.getInt("startIndex", 0));
    intent.putExtra(NativeShortVideoActivity.EXTRA_BASE_URL, call.getString("baseUrl"));
    intent.putExtra(NativeShortVideoActivity.EXTRA_FEED_URL, call.getString("feedUrl"));
    intent.putExtra(NativeShortVideoActivity.EXTRA_NEXT_OFFSET, call.getInt("nextOffset", 0));
    intent.putExtra(NativeShortVideoActivity.EXTRA_HAS_MORE, call.getBoolean("hasMore", false));
    Log.i(TAG, "Opening native short video feed");
    getActivity().startActivity(intent);
    getActivity().overridePendingTransition(0, 0);

    JSObject result = new JSObject();
    result.put("opened", true);
    call.resolve(result);
  }
}
