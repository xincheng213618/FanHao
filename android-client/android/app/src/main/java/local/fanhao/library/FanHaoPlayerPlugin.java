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
}
