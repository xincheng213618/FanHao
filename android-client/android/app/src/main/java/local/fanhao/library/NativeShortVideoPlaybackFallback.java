package local.fanhao.library;

import android.net.Uri;
import android.os.Handler;
import android.util.Log;
import androidx.media3.common.MediaItem;
import androidx.media3.common.PlaybackException;
import androidx.media3.datasource.HttpDataSource;
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
import java.util.function.BooleanSupplier;

final class NativeShortVideoPlaybackFallback {
  private static final String TAG = "NativeShortVideoFallback";
  private static final String SOURCE_PATH = "/media/short-video/";
  private static final String SMOOTH_PATH = "/media/short-video-smooth/";
  private static final String SMOOTH_RENDITION = "mobile-2560-h264-v4-pinned";
  private static final int AUTO_RETRIES = 4;
  private static final long RETRY_DELAY_MS = 1200L;
  private final Handler handler;
  private final ExecutorService executor;
  private final Set<String> fallbackIds = new HashSet<>();
  private final Map<String, Integer> retryCounts = new HashMap<>();
  private final Map<ExoPlayer, Runnable> pendingRetries = new HashMap<>();
  private final Map<ExoPlayer, Binding> playerBindings = new WeakHashMap<>();
  private String status = "";

  private static final class Binding {
    final String id, originalUrl;
    String url;
    Binding(String id, String originalUrl, String url) { this.id = id; this.originalUrl = originalUrl; this.url = url; }
  }

  NativeShortVideoPlaybackFallback(Handler handler, ExecutorService executor) {
    this.handler = handler;
    this.executor = executor;
  }

  Uri mediaUri(ExoPlayer player, ShortVideoItem item) {
    release(player);
    String url = playbackUrl(item);
    playerBindings.put(player, new Binding(item == null ? "" : item.id, item == null ? "" : item.streamUrl, url));
    return cachedMediaUri(url);
  }

  void release(ExoPlayer player) {
    Runnable retry = pendingRetries.remove(player);
    if (retry != null) handler.removeCallbacks(retry);
    playerBindings.remove(player);
  }

  Object bindingOwner(ExoPlayer player) { return playerBindings.get(player); }

  boolean isBoundToItem(ExoPlayer player, ShortVideoItem item) {
    Binding binding = playerBindings.get(player);
    return binding != null && item != null && item.id.equals(binding.id) && item.streamUrl.equals(binding.originalUrl);
  }

  boolean isBound(ExoPlayer player, Object owner) {
    return owner != null && playerBindings.get(player) == owner;
  }

  void releasePlayerResources(ExoPlayer player) {
    if (player == null) return;
    release(player);
    try {
      player.clearVideoSurface();
      player.stop();
      player.clearMediaItems();
    } catch (Exception ignored) {}
    player.release();
  }

  static boolean shouldResume(boolean foreground, boolean unobscured, boolean current, ExoPlayer player) {
    return foreground && unobscured && current && player.getPlayWhenReady();
  }

  String playbackUrl(ShortVideoItem item) {
    if (item == null) return "";
    int attempt = retryCounts.getOrDefault(item.id, 0);
    String url = fallbackIds.contains(item.id) ? smoothPlaybackUrl(item, 0) : item.streamUrl;
    if (url.length() == 0) url = item.streamUrl;
    if (attempt == 0) return url;
    String retryUrl = retryUrl(url, attempt);
    return retryUrl.length() > 0 ? retryUrl : url;
  }

  String status() {
    return status;
  }

  void resetRetryBudget(ShortVideoItem item) {
    if (item != null) retryCounts.remove(item.id);
  }

  boolean handle(ExoPlayer player, ShortVideoItem item, PlaybackException error, BooleanSupplier shouldPlay) {
    if (player == null || item == null || item.id.length() == 0) return false;
    Binding binding = playerBindings.get(player);
    if (binding == null || !item.id.equals(binding.id)) return false;
    if (isTemporaryNetworkError(error)) return scheduleRetry(player, item, shouldPlay, binding);
    if (!isDecodeCapabilityError(error) || isCompatibleUrl(binding.url)) return false;
    String smoothUrl = smoothPlaybackUrl(item, retryCounts.getOrDefault(item.id, 0));
    if (smoothUrl.length() == 0 || smoothUrl.equals(binding.url)) return false;
    Runnable pending = pendingRetries.remove(player);
    if (pending != null) handler.removeCallbacks(pending);
    if (!switchPlayer(player, smoothUrl, Math.max(0L, player.getCurrentPosition()), shouldPlay, binding)) return false;
    fallbackIds.add(item.id);
    status = "当前编码无法解码，正在切换兼容播放";
    reportIssue(item, error);
    Log.w(TAG, "smooth fallback " + item.id + " " + error.getErrorCodeName());
    return true;
  }

  private boolean scheduleRetry(ExoPlayer player, ShortVideoItem item, BooleanSupplier shouldPlay, Binding binding) {
    if (pendingRetries.containsKey(player)) return true;
    int attempt = retryCounts.getOrDefault(item.id, 0) + 1;
    if (attempt > AUTO_RETRIES) return false;
    retryCounts.put(item.id, attempt);
    player.stop();
    status = "网络暂时不可用，自动重试 " + attempt + "/" + AUTO_RETRIES;
    String failedUrl = binding.url;
    Runnable retry = new Runnable() {
      @Override public void run() {
        if (pendingRetries.get(player) != this) return;
        pendingRetries.remove(player);
        if (!isBound(player, binding) || !failedUrl.equals(binding.url)) return;
        String nextUrl = retryUrl(failedUrl, attempt);
        if (nextUrl.length() == 0) return;
        try {
          // stop() retains the timeline; a user can seek while this delayed
          // retry is pending. Read that latest position before resetting media.
          switchPlayer(player, nextUrl, Math.max(0L, player.getCurrentPosition()), shouldPlay, binding);
        } catch (RuntimeException releasedPlayer) {
          Log.w(TAG, "smooth retry skipped " + item.id, releasedPlayer);
        }
      }
    };
    pendingRetries.put(player, retry);
    handler.postDelayed(retry, RETRY_DELAY_MS);
    return true;
  }

  private boolean switchPlayer(ExoPlayer player, String url, long position, BooleanSupplier shouldPlay, Binding binding) {
    // Re-evaluate before mutating the player: lifecycle, overlays and user intent can
    // change while the compatible rendition is being generated.
    boolean playWhenReady = shouldPlay.getAsBoolean();
    if (!isBound(player, binding)) return false;
    binding.url = url;
    player.stop();
    player.clearMediaItems();
    player.setMediaItem(MediaItem.fromUri(cachedMediaUri(url)));
    if (position > 0L) player.seekTo(position);
    player.prepare();
    player.setPlayWhenReady(playWhenReady);
    return true;
  }

  private boolean isCompatibleUrl(String value) {
    try { String path = Uri.parse(value).getPath(); return path != null && path.contains(SMOOTH_PATH); }
    catch (Exception ignored) { return false; }
  }

  private boolean isDecodeCapabilityError(PlaybackException error) {
    if (error == null) return false;
    return error.errorCode == PlaybackException.ERROR_CODE_PARSING_CONTAINER_UNSUPPORTED
      || error.errorCode == PlaybackException.ERROR_CODE_DECODER_INIT_FAILED
      || error.errorCode == PlaybackException.ERROR_CODE_DECODER_QUERY_FAILED
      || error.errorCode == PlaybackException.ERROR_CODE_DECODING_FAILED
      || error.errorCode == PlaybackException.ERROR_CODE_DECODING_FORMAT_EXCEEDS_CAPABILITIES
      || error.errorCode == PlaybackException.ERROR_CODE_DECODING_FORMAT_UNSUPPORTED;
  }

  private boolean isTemporaryNetworkError(PlaybackException error) {
    if (error == null) return false;
    if (error.errorCode == PlaybackException.ERROR_CODE_IO_NETWORK_CONNECTION_FAILED
      || error.errorCode == PlaybackException.ERROR_CODE_IO_NETWORK_CONNECTION_TIMEOUT) return true;
    if (error.errorCode != PlaybackException.ERROR_CODE_IO_BAD_HTTP_STATUS) return false;
    Throwable cause = error;
    for (int depth = 0; cause != null && depth < 8; depth++, cause = cause.getCause()) {
      if (cause instanceof HttpDataSource.InvalidResponseCodeException) {
        int code = ((HttpDataSource.InvalidResponseCodeException) cause).responseCode;
        return code == 500 || code == 502 || code == 503 || code == 504;
      }
    }
    return false;
  }

  private String retryUrl(String raw, int attempt) {
    try {
      Uri uri = Uri.parse(raw);
      Uri.Builder builder = uri.buildUpon().clearQuery();
      for (String name : uri.getQueryParameterNames()) {
        if ("retry".equals(name)) continue;
        for (String value : uri.getQueryParameters(name)) builder.appendQueryParameter(name, value);
      }
      if (attempt > 0) builder.appendQueryParameter("retry", String.valueOf(attempt));
      return builder.build().toString();
    } catch (Exception ignored) { return ""; }
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
      return retryUrl(builder.build().toString(), retryAttempt);
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
