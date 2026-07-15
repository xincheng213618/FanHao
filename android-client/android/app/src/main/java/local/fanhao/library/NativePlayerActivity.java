package local.fanhao.library;

import android.app.Activity;
import android.content.pm.ActivityInfo;
import android.graphics.Color;
import android.graphics.Typeface;
import android.net.Uri;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;
import android.view.Gravity;
import android.view.MotionEvent;
import android.view.View;
import android.view.ViewGroup;
import android.view.Window;
import android.view.WindowInsets;
import android.view.WindowInsetsController;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.TextView;

import androidx.annotation.Nullable;
import androidx.media3.common.MediaItem;
import androidx.media3.common.PlaybackException;
import androidx.media3.common.Player;
import androidx.media3.common.util.UnstableApi;
import androidx.media3.exoplayer.ExoPlayer;
import androidx.media3.ui.PlayerView;

import org.json.JSONObject;

import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

@UnstableApi
public class NativePlayerActivity extends Activity {
  private static final String TAG = "FanHaoNativePlayer";
  private static final int CHROME_HIDE_TIMEOUT_MS = 2500;
  public static final String EXTRA_URL = "url";
  public static final String EXTRA_FALLBACK_URL = "fallbackUrl";
  public static final String EXTRA_TITLE = "title";
  public static final String EXTRA_SUBTITLE = "subtitle";
  public static final String EXTRA_PROGRESS_URL = "progressUrl";
  public static final String EXTRA_WORK_ID = "workId";
  public static final String EXTRA_VIDEO_ID = "videoId";
  public static final String EXTRA_MODE = "mode";
  public static final String EXTRA_POSITION = "position";
  public static final String EXTRA_DURATION = "duration";

  private final Handler handler = new Handler(Looper.getMainLooper());
  private final ExecutorService executor = Executors.newSingleThreadExecutor();
  private ExoPlayer player;
  private PlayerView playerView;
  private TextView statusView;
  private View topOverlay;
  private TextView titleView;
  private TextView subtitleView;
  private String title;
  private String subtitle;
  private String progressUrl;
  private String workId;
  private String fallbackUrl;
  private double probedDurationSeconds;
  private boolean fallbackTried;
  private long lastProgressAt;

  private final Runnable statusHideRunnable = new Runnable() {
    @Override
    public void run() {
      if (statusView != null) statusView.setVisibility(View.GONE);
    }
  };

  private final Runnable overlayHideRunnable = new Runnable() {
    @Override
    public void run() {
      hidePlayerChrome();
    }
  };

  private final Runnable progressTicker = new Runnable() {
    @Override
    public void run() {
      reportProgress(false);
      handler.postDelayed(this, 5000);
    }
  };

  @Override
  protected void onCreate(@Nullable Bundle savedInstanceState) {
    super.onCreate(savedInstanceState);
    requestWindowFeature(Window.FEATURE_NO_TITLE);
    setRequestedOrientation(ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE);

    String url = stringExtra(EXTRA_URL);
    fallbackUrl = stringExtra(EXTRA_FALLBACK_URL);
    title = stringExtra(EXTRA_TITLE);
    subtitle = stringExtra(EXTRA_SUBTITLE);
    progressUrl = stringExtra(EXTRA_PROGRESS_URL);
    workId = stringExtra(EXTRA_WORK_ID);
    probedDurationSeconds = getIntent().getDoubleExtra(EXTRA_DURATION, 0.0);
    double positionSeconds = getIntent().getDoubleExtra(EXTRA_POSITION, 0.0);

    buildUi();
    hideSystemBars();
    player = new ExoPlayer.Builder(this).build();
    playerView.setPlayer(player);
    player.addListener(new Player.Listener() {
      @Override
      public void onPlaybackStateChanged(int playbackState) {
        if (playbackState == Player.STATE_READY) {
          showStatus("正在播放", false);
          playerView.postDelayed(() -> {
            hidePlayerChrome();
          }, 900);
        } else if (playbackState == Player.STATE_BUFFERING) {
          showStatus("正在缓冲", true);
        } else if (playbackState == Player.STATE_ENDED) {
          showStatus("播放结束", true);
          reportProgress(true);
        }
      }

      @Override
      public void onPlayerError(PlaybackException error) {
        if (!fallbackTried && hasText(fallbackUrl) && !sameUrl(url, fallbackUrl)) {
          fallbackTried = true;
          showStatus("直连失败，切换智能播放", true);
          playUrl(withFallbackSeek(fallbackUrl), Math.max(0, player.getCurrentPosition()));
          return;
        }
        showStatus("播放失败：" + error.getErrorCodeName(), true);
      }
    });

    playUrl(url, secondsToMs(positionSeconds));
    handler.post(progressTicker);
  }

  @Override
  protected void onPause() {
    super.onPause();
    reportProgress(true);
    if (player != null) player.pause();
  }

  @Override
  protected void onResume() {
    super.onResume();
    hideSystemBars();
  }

  @Override
  public void onWindowFocusChanged(boolean hasFocus) {
    super.onWindowFocusChanged(hasFocus);
    if (hasFocus) hideSystemBars();
  }

  @Override
  protected void onDestroy() {
    reportProgress(true);
    handler.removeCallbacks(progressTicker);
    handler.removeCallbacks(statusHideRunnable);
    handler.removeCallbacks(overlayHideRunnable);
    if (player != null) {
      player.release();
      player = null;
    }
    executor.shutdownNow();
    super.onDestroy();
  }

  private void buildUi() {
    FrameLayout root = new FrameLayout(this);
    root.setBackgroundColor(Color.BLACK);

    playerView = new PlayerView(this);
    playerView.setUseController(true);
    playerView.setControllerAutoShow(false);
    playerView.setControllerHideOnTouch(false);
    playerView.setControllerShowTimeoutMs(CHROME_HIDE_TIMEOUT_MS);
    playerView.setControllerAnimationEnabled(false);
    playerView.setKeepContentOnPlayerReset(true);
    removeControllerScrims();
    playerView.setControllerVisibilityListener((PlayerView.ControllerVisibilityListener) visibility ->
      syncPlayerChrome(visibility == View.VISIBLE)
    );
    root.addView(playerView, new FrameLayout.LayoutParams(
      ViewGroup.LayoutParams.MATCH_PARENT,
      ViewGroup.LayoutParams.MATCH_PARENT
    ));

    topOverlay = createTopOverlay();
    root.addView(topOverlay, new FrameLayout.LayoutParams(
      ViewGroup.LayoutParams.MATCH_PARENT,
      ViewGroup.LayoutParams.WRAP_CONTENT,
      Gravity.TOP
    ));
    topOverlay.setVisibility(View.GONE);

    statusView = new TextView(this);
    statusView.setText("正在启动播放");
    statusView.setTextColor(Color.WHITE);
    statusView.setTextSize(12);
    statusView.setGravity(Gravity.CENTER);
    statusView.setMaxLines(2);
    statusView.setPadding(dp(14), dp(8), dp(14), dp(8));
    statusView.setBackgroundColor(0x99000000);

    FrameLayout.LayoutParams statusParams = new FrameLayout.LayoutParams(
      ViewGroup.LayoutParams.WRAP_CONTENT,
      ViewGroup.LayoutParams.WRAP_CONTENT
    );
    statusParams.gravity = Gravity.CENTER;
    statusParams.leftMargin = dp(24);
    statusParams.rightMargin = dp(24);
    root.addView(statusView, statusParams);

    setContentView(root);
  }

  @Override
  public boolean dispatchTouchEvent(MotionEvent event) {
    if (playerView != null) {
      int action = event.getActionMasked();
      if (action == MotionEvent.ACTION_DOWN) {
        showPlayerChrome();
      } else if (action == MotionEvent.ACTION_MOVE || action == MotionEvent.ACTION_UP) {
        schedulePlayerChromeHide();
      }
    }
    return super.dispatchTouchEvent(event);
  }

  private View createTopOverlay() {
    LinearLayout bar = new LinearLayout(this);
    bar.setOrientation(LinearLayout.HORIZONTAL);
    bar.setGravity(Gravity.CENTER_VERTICAL);
    bar.setPadding(dp(14), dp(10), dp(18), dp(10));
    bar.setBackgroundColor(Color.TRANSPARENT);

    TextView back = new TextView(this);
    back.setText("‹");
    back.setTextColor(Color.WHITE);
    back.setTextSize(38);
    back.setTypeface(Typeface.DEFAULT_BOLD);
    back.setShadowLayer(dp(2), 0, dp(1), 0xCC000000);
    back.setGravity(Gravity.CENTER);
    back.setBackgroundColor(Color.TRANSPARENT);
    back.setContentDescription("返回");
    back.setOnClickListener(view -> finish());
    bar.addView(back, new LinearLayout.LayoutParams(dp(48), dp(48)));

    LinearLayout textColumn = new LinearLayout(this);
    textColumn.setOrientation(LinearLayout.VERTICAL);
    textColumn.setGravity(Gravity.CENTER_VERTICAL);
    textColumn.setPadding(dp(10), 0, 0, 0);

    titleView = new TextView(this);
    titleView.setText(hasText(title) ? title : "播放");
    titleView.setTextColor(Color.WHITE);
    titleView.setTextSize(18);
    titleView.setTypeface(Typeface.DEFAULT_BOLD);
    titleView.setShadowLayer(dp(2), 0, dp(1), 0xCC000000);
    titleView.setSingleLine(true);
    titleView.setEllipsize(android.text.TextUtils.TruncateAt.END);

    subtitleView = new TextView(this);
    subtitleView.setText(subtitle);
    subtitleView.setTextColor(0xCCFFFFFF);
    subtitleView.setTextSize(12);
    subtitleView.setShadowLayer(dp(2), 0, dp(1), 0xCC000000);
    subtitleView.setSingleLine(true);
    subtitleView.setEllipsize(android.text.TextUtils.TruncateAt.END);
    subtitleView.setVisibility(hasText(subtitle) ? View.VISIBLE : View.GONE);

    textColumn.addView(titleView, new LinearLayout.LayoutParams(
      ViewGroup.LayoutParams.MATCH_PARENT,
      ViewGroup.LayoutParams.WRAP_CONTENT
    ));
    textColumn.addView(subtitleView, new LinearLayout.LayoutParams(
      ViewGroup.LayoutParams.MATCH_PARENT,
      ViewGroup.LayoutParams.WRAP_CONTENT
    ));
    bar.addView(textColumn, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1));
    return bar;
  }

  private void removeControllerScrims() {
    if (playerView == null) return;
    View controlsBackground = playerView.findViewById(androidx.media3.ui.R.id.exo_controls_background);
    if (controlsBackground != null) controlsBackground.setBackgroundColor(Color.TRANSPARENT);
    View bottomBar = playerView.findViewById(androidx.media3.ui.R.id.exo_bottom_bar);
    if (bottomBar != null) bottomBar.setBackgroundColor(Color.TRANSPARENT);
  }

  private void syncPlayerChrome(boolean visible) {
    handler.removeCallbacks(overlayHideRunnable);
    if (topOverlay == null) return;
    if (visible) {
      showTopOverlay();
    } else {
      topOverlay.setVisibility(View.GONE);
      hideSystemBars();
    }
  }

  private void showPlayerChrome() {
    if (playerView != null && !playerView.isControllerFullyVisible()) playerView.showController();
    showTopOverlay();
  }

  private void showTopOverlay() {
    if (topOverlay == null) return;
    topOverlay.setVisibility(View.VISIBLE);
    schedulePlayerChromeHide();
  }

  private void schedulePlayerChromeHide() {
    handler.removeCallbacks(overlayHideRunnable);
    handler.postDelayed(overlayHideRunnable, CHROME_HIDE_TIMEOUT_MS);
  }

  private void hidePlayerChrome() {
    handler.removeCallbacks(overlayHideRunnable);
    if (playerView != null) playerView.hideController();
    if (topOverlay != null) topOverlay.setVisibility(View.GONE);
    hideSystemBars();
  }

  private void playUrl(String url, long positionMs) {
    if (player == null || !hasText(url)) return;
    Log.i(TAG, "playUrl: " + url);
    player.setMediaItem(MediaItem.fromUri(Uri.parse(url)));
    player.prepare();
    if (positionMs > 5000) player.seekTo(positionMs);
    player.setPlayWhenReady(true);
  }

  private void showStatus(String message, boolean persistent) {
    if (statusView == null) return;
    handler.removeCallbacks(statusHideRunnable);
    statusView.setText(message);
    statusView.setVisibility(View.VISIBLE);
    if (!persistent) handler.postDelayed(statusHideRunnable, 900);
  }

  private void reportProgress(boolean force) {
    if (!hasText(progressUrl) || player == null) return;
    long now = System.currentTimeMillis();
    if (!force && now - lastProgressAt < 4500) return;
    long positionMs = Math.max(0, player.getCurrentPosition());
    long durationMs = player.getDuration();
    if (durationMs <= 0 && probedDurationSeconds > 0) durationMs = secondsToMs(probedDurationSeconds);
    if (durationMs <= 0) return;
    lastProgressAt = now;

    double position = positionMs / 1000.0;
    double duration = durationMs / 1000.0;
    executor.execute(() -> postProgress(position, duration));
  }

  private void postProgress(double position, double duration) {
    HttpURLConnection connection = null;
    try {
      JSONObject body = new JSONObject();
      body.put("workId", workId);
      body.put("position", position);
      body.put("duration", duration);
      byte[] payload = body.toString().getBytes(StandardCharsets.UTF_8);

      connection = (HttpURLConnection) new URL(progressUrl).openConnection();
      connection.setConnectTimeout(3500);
      connection.setReadTimeout(3500);
      connection.setRequestMethod("POST");
      connection.setDoOutput(true);
      connection.setRequestProperty("Content-Type", "application/json; charset=utf-8");
      connection.setFixedLengthStreamingMode(payload.length);
      try (OutputStream output = connection.getOutputStream()) {
        output.write(payload);
      }
      connection.getResponseCode();
    } catch (Exception ignored) {
      // Progress is best effort; playback should never stop because state sync failed.
    } finally {
      if (connection != null) connection.disconnect();
    }
  }

  private String withFallbackSeek(String url) {
    if (!hasText(url) || player == null) return url;
    long seconds = Math.max(0, player.getCurrentPosition() / 1000);
    if (seconds <= 0) return url;
    Uri uri = Uri.parse(url);
    if (uri.getQueryParameter("t") != null) return url;
    return uri.buildUpon().appendQueryParameter("t", String.valueOf(seconds)).build().toString();
  }

  private void hideSystemBars() {
    Window window = getWindow();
    window.setStatusBarColor(Color.BLACK);
    window.setNavigationBarColor(Color.BLACK);
    View decorView = window.getDecorView();
    if (decorView == null) return;

    if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.R) {
      WindowInsetsController controller = decorView.getWindowInsetsController();
      if (controller != null) {
        controller.hide(WindowInsets.Type.statusBars() | WindowInsets.Type.navigationBars());
        controller.setSystemBarsBehavior(WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
      }
      return;
    }

    decorView.setSystemUiVisibility(
      View.SYSTEM_UI_FLAG_FULLSCREEN
        | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
        | View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
        | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
        | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
        | View.SYSTEM_UI_FLAG_LAYOUT_STABLE
    );
  }

  private String stringExtra(String key) {
    String value = getIntent().getStringExtra(key);
    return value == null ? "" : value;
  }

  private long secondsToMs(double seconds) {
    if (!Double.isFinite(seconds) || seconds <= 0) return 0;
    return Math.round(seconds * 1000.0);
  }

  private boolean sameUrl(String left, String right) {
    return left != null && right != null && left.equals(right);
  }

  private boolean hasText(String value) {
    return value != null && !value.trim().isEmpty();
  }

  private int dp(int value) {
    return Math.round(value * getResources().getDisplayMetrics().density);
  }
}
