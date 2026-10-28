package local.fanhao.library;

import android.app.Activity;
import android.content.Intent;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.ResultReceiver;
import android.util.Log;

import androidx.annotation.OptIn;
import androidx.activity.result.ActivityResult;
import androidx.activity.result.ActivityResultLauncher;
import androidx.activity.result.contract.ActivityResultContracts;
import androidx.media3.common.util.UnstableApi;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;

import org.json.JSONArray;
import java.lang.ref.WeakReference;
import java.util.concurrent.atomic.AtomicLong;

@OptIn(markerClass = UnstableApi.class)
@CapacitorPlugin(name = "FanHaoPlayer")
public class FanHaoPlayerPlugin extends Plugin {
  private static final String TAG = "FanHaoPlayer";
  private volatile ProgressCommitReceiver activeProgressReceiver;
  private volatile boolean destroyed;
  private NativeShortVideoRecovery shortVideoRecovery;
  private ActivityResultLauncher<Intent> shortVideoRecoveryLauncher;
  private final AtomicLong shortFeedEpoch = new AtomicLong();
  private volatile long pendingShortFeedPlay;

  @Override
  public void load() {
    super.load();
    try {
      shortVideoRecoveryLauncher = getActivity().getActivityResultRegistry().register(
        NativeShortVideoRecovery.LAUNCHER_KEY, getActivity(), new ActivityResultContracts.StartActivityForResult(),
        result -> { if (shortVideoRecovery != null) shortVideoRecovery.result(result.getResultCode(), result.getData()); });
      shortVideoRecovery = new NativeShortVideoRecovery(getActivity(), intent -> shortVideoRecoveryLauncher.launch(intent),
        this::publishRestoredShortFeed, () -> pendingShortFeedPlay != 0L || destroyed);
      shortVideoRecovery.restore(getActivity().getSavedStateRegistry().consumeRestoredStateForKey(NativeShortVideoRecovery.STATE_KEY));
      getActivity().getSavedStateRegistry().registerSavedStateProvider(NativeShortVideoRecovery.STATE_KEY,
        () -> shortVideoRecovery == null ? new Bundle() : shortVideoRecovery.save());
    } catch (Exception unavailable) {
      if (shortVideoRecovery != null) shortVideoRecovery.destroy();
      shortVideoRecovery = null;
      Log.w(TAG, "native task recovery unavailable", unavailable);
    }
  }

  @Override protected void handleOnStart() { if (shortVideoRecovery != null) shortVideoRecovery.started(); }
  @Override protected void handleOnResume() { if (shortVideoRecovery != null) shortVideoRecovery.resumed(); }
  @Override protected void handleOnPause() { if (shortVideoRecovery != null) shortVideoRecovery.paused(); }
  @Override protected void handleOnNewIntent(Intent intent) {
    if (shortVideoRecovery != null && shortVideoRecovery.newIntent(intent)) { shortFeedEpoch.incrementAndGet(); pendingShortFeedPlay = 0L; }
  }

  private void publishRestoredShortFeed(String base, int code, Intent data) {
    if (destroyed || code != Activity.RESULT_OK || data == null || pendingShortFeedPlay != 0L || shortVideoRecovery == null) return;
    final long epoch = shortFeedEpoch.get();
    final NativeShortVideoRecovery.ResultTicket ticket = shortVideoRecovery.ticket(data);
    if (ticket == null) return;
    final JSObject result = shortFeedResult(base, code, data);
    try {
      execute(() -> {
        if (destroyed || pendingShortFeedPlay != 0L || epoch != shortFeedEpoch.get() || !ticket.isCurrent() || !ticket.consume()) return;
        if (destroyed || pendingShortFeedPlay != 0L || epoch != shortFeedEpoch.get()) return;
        try { notifyListeners("shortFeedRestored", result, true); }
        catch (RuntimeException unavailable) { Log.w(TAG, "restored short-video listener unavailable", unavailable); }
      });
    } catch (RuntimeException unavailable) { Log.w(TAG, "restored short-video bridge unavailable", unavailable); }
  }

  private static final class ProgressCommitReceiver extends ResultReceiver {
    private final WeakReference<FanHaoPlayerPlugin> owner;
    private final String progressSessionId;
    private final String videoId;
    private final String progressUrl;
    private final String mode;
    private final String ownerToken;

    ProgressCommitReceiver(FanHaoPlayerPlugin plugin, String sessionId, String videoId, String progressUrl, String mode, String ownerToken) {
      super(new Handler(Looper.getMainLooper()));
      owner = new WeakReference<>(plugin);
      this.progressSessionId = sessionId;
      this.videoId = videoId;
      this.progressUrl = progressUrl;
      this.mode = mode;
      this.ownerToken = ownerToken;
    }

    @Override
    protected void onReceiveResult(int resultCode, Bundle ignored) {
      if (resultCode != Activity.RESULT_OK) return;
      FanHaoPlayerPlugin plugin = owner.get();
      if (plugin == null) return;
      try {
        // Capacitor addListener and notifyListeners share ordinary maps. Enter
        // its task handler, and recheck identity there after any newer play.
        plugin.execute(this::deliver);
      } catch (RuntimeException ignoredError) {
        // A destroyed bridge does not turn an already committed POST into work.
      }
    }

    private void deliver() {
      FanHaoPlayerPlugin plugin = owner.get();
      if (plugin == null || plugin.destroyed || plugin.activeProgressReceiver != this) return;
      if (ownerToken == null || !ownerToken.equals(ServerAuthSession.captureToken(progressUrl))) return;
      JSObject receipt = new JSObject();
      receipt.put("progressSessionId", progressSessionId);
      receipt.put("videoId", videoId);
      receipt.put("progressUrl", progressUrl);
      receipt.put("mode", mode);
      try {
        plugin.notifyListeners("progressCommitted", receipt, false);
      } catch (RuntimeException ignored) {
        // The receipt is best effort if its bridge closed during dispatch.
      }
    }
  }

  @Override
  protected void handleOnDestroy() {
    destroyed = true;
    shortFeedEpoch.incrementAndGet(); pendingShortFeedPlay = 0L;
    activeProgressReceiver = null;
    if (shortVideoRecovery != null) shortVideoRecovery.destroy();
    shortVideoRecovery = null;
    if (shortVideoRecoveryLauncher != null) shortVideoRecoveryLauncher.unregister();
    getActivity().getSavedStateRegistry().unregisterSavedStateProvider(NativeShortVideoRecovery.STATE_KEY);
    super.handleOnDestroy();
  }

  @PluginMethod
  public void play(PluginCall call) {
    String url = call.getString("url");
    if (url == null || url.trim().isEmpty()) {
      call.reject("缺少播放地址");
      return;
    }

    if (destroyed) {
      call.reject("播放器连接已关闭");
      return;
    }
    try {
      String sessionId = call.getString("progressSessionId");
      String videoId = call.getString("videoId");
      String progressUrl = call.getString("progressUrl");
      String mode = call.getString("mode");
      String ownerToken = ServerAuthSession.captureToken(progressUrl);
      ProgressCommitReceiver receiver = hasText(sessionId) && hasText(videoId) && hasText(progressUrl)
        ? new ProgressCommitReceiver(this, sessionId, videoId, progressUrl, mode, ownerToken) : null;
      Intent intent = new Intent(getActivity(), NativePlayerActivity.class);
      intent.putExtra(NativePlayerActivity.EXTRA_URL, url);
      intent.putExtra(NativePlayerActivity.EXTRA_FALLBACK_URL, call.getString("fallbackUrl"));
      intent.putExtra(NativePlayerActivity.EXTRA_TITLE, call.getString("title"));
      intent.putExtra(NativePlayerActivity.EXTRA_SUBTITLE, call.getString("subtitle"));
      intent.putExtra(NativePlayerActivity.EXTRA_PROGRESS_URL, progressUrl);
      intent.putExtra(NativePlayerActivity.EXTRA_PROGRESS_AUTH_TOKEN, ownerToken);
      intent.putExtra(NativePlayerActivity.EXTRA_WORK_ID, call.getString("workId"));
      intent.putExtra(NativePlayerActivity.EXTRA_VIDEO_ID, videoId);
      intent.putExtra(NativePlayerActivity.EXTRA_MODE, mode);
      intent.putExtra(NativePlayerActivity.EXTRA_POSITION, call.getDouble("position", 0.0));
      intent.putExtra(NativePlayerActivity.EXTRA_DURATION, call.getDouble("duration", 0.0));
      if (receiver != null) intent.putExtra(NativePlayerActivity.EXTRA_PROGRESS_RECEIVER, receiver);
      Log.i(TAG, "Opening native player: " + url);
      getActivity().startActivity(intent);
      activeProgressReceiver = receiver;

      JSObject result = new JSObject();
      result.put("opened", true);
      call.resolve(result);
    } catch (Exception error) {
      call.reject("无法打开原生播放器", error);
    }
  }

  private static boolean hasText(String value) {
    return value != null && !value.trim().isEmpty();
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
    final long request = shortFeedEpoch.incrementAndGet(); pendingShortFeedPlay = request;
    getActivity().runOnUiThread(() -> {
      if (destroyed || request != shortFeedEpoch.get() || getActivity().isFinishing() || getActivity().isDestroyed()) {
        if (pendingShortFeedPlay == request) pendingShortFeedPlay = 0L;
        call.reject("播放器请求已更新或连接已关闭"); return;
      }
      if (shortVideoRecovery != null) shortVideoRecovery.fresh(intent);
      try {
        startActivityForResult(call, intent, "playShortFeedResult");
        getActivity().overridePendingTransition(0, 0);
      } catch (Exception error) {
        if (shortVideoRecovery != null) shortVideoRecovery.failedOpen(intent);
        call.reject("无法打开原生短视频", error);
      }
      finally { if (pendingShortFeedPlay == request) pendingShortFeedPlay = 0L; }
    });
  }

  @ActivityCallback
  private void playShortFeedResult(PluginCall call, ActivityResult activityResult) {
    if (call == null) return;
    String expectedBase = NativeShortVideoActionState.serverScope(call.getString("baseUrl"));
    Intent data = activityResult == null ? null : activityResult.getData();
    JSObject result = shortFeedResult(expectedBase, activityResult == null ? Activity.RESULT_CANCELED : activityResult.getResultCode(), data);
    if (PluginCall.CALLBACK_ID_DANGLING.equals(call.getCallbackId()) && shortVideoRecovery != null && shortVideoRecovery.acceptsSystemResult(data)) {
      publishRestoredShortFeed(expectedBase, activityResult == null ? Activity.RESULT_CANCELED : activityResult.getResultCode(), data);
    }
    call.resolve(result);
  }

  private JSObject shortFeedResult(String expectedBase, int resultCode, Intent data) {
    boolean completed = resultCode == Activity.RESULT_OK && data != null;
    String returnedBase = completed
      ? NativeShortVideoActionState.serverScope(data.getStringExtra(NativeShortVideoActionResult.EXTRA_SERVER_BASE))
      : "";
    JSONArray snapshots = new JSONArray();
    if (completed && expectedBase.length() > 0 && expectedBase.equals(returnedBase)) {
      snapshots = NativeShortVideoActionResultDecoder.decode(
        data.getStringExtra(NativeShortVideoActionResult.EXTRA_SNAPSHOTS_JSON));
    }
    JSObject result = new JSObject();
    result.put("opened", true);
    result.put("canceled", !completed);
    result.put("serverBase", expectedBase);
    result.put("snapshots", snapshots);
    return result;
  }
}
