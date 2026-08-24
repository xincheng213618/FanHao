package local.fanhao.library;

import android.net.Uri;
import android.os.Handler;
import android.util.Log;
import androidx.media3.common.MediaItem;
import androidx.media3.common.PlaybackException;
import androidx.media3.exoplayer.ExoPlayer;
import org.json.JSONObject;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Map;
import java.util.Set;
import java.util.WeakHashMap;
import java.util.concurrent.ExecutorService;

final class NativeShortVideoPlaybackFallback {
  private static final String TAG = "NativeShortVideoFallback";
  private static final String SOURCE_PATH = "/media/short-video/";
  private static final String SMOOTH_PATH = "/media/short-video-smooth/";
  private static final String SMOOTH_RENDITION = "mobile-2560-h264-v3";
  private static final int AUTO_RETRIES = 4;
  private static final long RETRY_DELAY_MS = 1200L;
  private final Handler handler;
  private final ExecutorService executor;
  private final Set<String> fallbackIds = new HashSet<>();
  private final Map<String, Integer> retryCounts = new HashMap<>();
  private final Set<String> pendingRetries = new HashSet<>();
  private final Map<ExoPlayer, String> playerBindings = new WeakHashMap<>();
  private String status = "";

  NativeShortVideoPlaybackFallback(Handler handler, ExecutorService executor) {
    this.handler = handler;
    this.executor = executor;
  }

  Uri mediaUri(ExoPlayer player, ShortVideoItem item) {
    playerBindings.put(player, item == null ? "" : item.id);
    return cachedMediaUri(playbackUrl(item));
  }

  String playbackUrl(ShortVideoItem item) {
    if (item == null) return "";
    if (!fallbackIds.contains(item.id)) return item.streamUrl;
    String smoothUrl = smoothPlaybackUrl(item, retryCounts.getOrDefault(item.id, 0));
    return smoothUrl.length() > 0 ? smoothUrl : item.streamUrl;
  }

  String status() {
    return status;
  }

  boolean handle(ExoPlayer player, ShortVideoItem item, PlaybackException error, boolean shouldPlay) {
    if (player == null || item == null || item.id.length() == 0) return false;
    playerBindings.put(player, item.id);
    if (fallbackIds.contains(item.id)) return scheduleRetry(player, item, shouldPlay);
    String smoothUrl = smoothPlaybackUrl(item, 0);
    if (smoothUrl.length() == 0 || smoothUrl.equals(item.streamUrl)) return false;
    fallbackIds.add(item.id);
    switchPlayer(player, smoothUrl, Math.max(0L, player.getCurrentPosition()), shouldPlay);
    status = "当前编码无法解码，正在切换兼容播放";
    reportIssue(item, error);
    Log.w(TAG, "smooth fallback " + item.id + " " + error.getErrorCodeName());
    return true;
  }

  private boolean scheduleRetry(ExoPlayer player, ShortVideoItem item, boolean shouldPlay) {
    if (pendingRetries.contains(item.id)) return true;
    int attempt = retryCounts.getOrDefault(item.id, 0) + 1;
    if (attempt > AUTO_RETRIES) return false;
    retryCounts.put(item.id, attempt);
    pendingRetries.add(item.id);
    long resumePosition = Math.max(0L, player.getCurrentPosition());
    player.stop();
    status = "兼容版本正在生成，自动重试 " + attempt + "/" + AUTO_RETRIES;
    handler.postDelayed(() -> {
      pendingRetries.remove(item.id);
      if (!item.id.equals(playerBindings.get(player))) return;
      String smoothUrl = smoothPlaybackUrl(item, attempt);
      if (smoothUrl.length() == 0) return;
      try {
        switchPlayer(player, smoothUrl, resumePosition, shouldPlay);
      } catch (RuntimeException releasedPlayer) {
        Log.w(TAG, "smooth retry skipped " + item.id, releasedPlayer);
      }
    }, RETRY_DELAY_MS);
    return true;
  }

  private void switchPlayer(ExoPlayer player, String url, long position, boolean shouldPlay) {
    player.stop();
    player.clearMediaItems();
    player.setMediaItem(MediaItem.fromUri(cachedMediaUri(url)));
    if (position > 0L) player.seekTo(position);
    player.prepare();
    player.setPlayWhenReady(shouldPlay);
  }

  private String smoothPlaybackUrl(ShortVideoItem item, int retryAttempt) {
    String raw = item == null ? "" : String.valueOf(item.streamUrl).trim();
    if (raw.length() == 0) return "";
    try {
      Uri source = Uri.parse(raw);
      String sourcePath = source.getPath();
      if (sourcePath == null || sourcePath.contains(SMOOTH_PATH)) return "";
      int marker = sourcePath.indexOf(SOURCE_PATH);
      if (marker < 0) return "";
      String smoothPath = sourcePath.substring(0, marker) + SMOOTH_PATH + sourcePath.substring(marker + SOURCE_PATH.length());
      Uri.Builder builder = source.buildUpon().path(smoothPath)
        .appendQueryParameter("rendition", SMOOTH_RENDITION)
        .appendQueryParameter("wait", "1");
      if (retryAttempt > 0) builder.appendQueryParameter("retry", String.valueOf(retryAttempt));
      return builder.build().toString();
    } catch (Exception ignored) {
      return "";
    }
  }

  private Uri cachedMediaUri(String url) {
    return Uri.parse(url).buildUpon().appendQueryParameter("fhcache", "1").build();
  }

  private void reportIssue(ShortVideoItem item, PlaybackException error) {
    executor.execute(() -> {
      HttpURLConnection connection = null;
      try {
        Uri source = Uri.parse(item.streamUrl);
        String endpoint = source.buildUpon().path("/api/short-videos/playback-issues").clearQuery().fragment(null).build().toString();
        JSONObject payload = new JSONObject();
        payload.put("id", item.id);
        payload.put("reason", "android-decode-error:" + error.getErrorCodeName());
        byte[] bytes = payload.toString().getBytes(StandardCharsets.UTF_8);
        connection = (HttpURLConnection) new URL(endpoint).openConnection();
        connection.setRequestMethod("POST");
        connection.setConnectTimeout(8000);
        connection.setReadTimeout(12000);
        connection.setDoOutput(true);
        connection.setRequestProperty("Accept", "application/json");
        connection.setRequestProperty("Content-Type", "application/json; charset=utf-8");
        connection.setFixedLengthStreamingMode(bytes.length);
        connection.getOutputStream().write(bytes);
        int responseCode = connection.getResponseCode();
        NativeShortVideoHttpResponse.readUtf8(connection, responseCode >= 200 && responseCode < 300);
      } catch (Exception reportError) {
        Log.w(TAG, "playback issue report failed " + item.id, reportError);
      } finally {
        if (connection != null) connection.disconnect();
      }
    });
  }
}
