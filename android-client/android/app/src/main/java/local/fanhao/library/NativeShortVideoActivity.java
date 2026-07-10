package local.fanhao.library;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.res.ColorStateList;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.ActivityInfo;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Color;
import android.graphics.Outline;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.media.MediaMetadataRetriever;
import android.net.Uri;
import android.os.BatteryManager;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.text.Layout;
import android.text.TextUtils;
import android.util.LruCache;
import android.util.Log;
import android.view.Gravity;
import android.view.HapticFeedbackConstants;
import android.view.MotionEvent;
import android.view.View;
import android.view.ViewGroup;
import android.view.ViewOutlineProvider;
import android.view.Window;
import android.view.WindowInsets;
import android.view.WindowInsetsController;
import android.view.WindowManager;
import android.widget.FrameLayout;
import android.widget.GridLayout;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.EditText;
import android.widget.ScrollView;
import android.widget.TextView;

import androidx.annotation.NonNull;
import androidx.annotation.Nullable;
import androidx.media3.common.MediaItem;
import androidx.media3.common.PlaybackException;
import androidx.media3.common.Player;
import androidx.media3.common.VideoSize;
import androidx.media3.common.util.UnstableApi;
import androidx.media3.exoplayer.DefaultLoadControl;
import androidx.media3.exoplayer.ExoPlayer;
import androidx.media3.ui.AspectRatioFrameLayout;
import androidx.media3.ui.PlayerView;
import androidx.recyclerview.widget.RecyclerView;
import androidx.viewpager2.widget.ViewPager2;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Date;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

@UnstableApi
public class NativeShortVideoActivity extends Activity {
  private static final String TAG = "NativeShortVideo";

  public static final String EXTRA_VIDEOS_JSON = "videosJson";
  public static final String EXTRA_START_INDEX = "startIndex";
  public static final String EXTRA_START_ID = "startId";
  public static final String EXTRA_BASE_URL = "baseUrl";
  public static final String EXTRA_FEED_URL = "feedUrl";
  public static final String EXTRA_NEXT_OFFSET = "nextOffset";
  public static final String EXTRA_HAS_MORE = "hasMore";
  public static final String EXTRA_OPEN_AUTHOR_PANEL = "openAuthorPanel";
  private static final String PREFS_NAME = "fanhao.shortVideo.native";
  private static final String PREF_MUTED = "muted";
  private static final String PREF_AUTO_NEXT = "autoNext";
  private static final String PREF_LIKED_VIDEO_KEYS = "likedVideoKeys";
  private static final String PREF_COLLECTED_VIDEO_KEYS = "collectedVideoKeys";
  private static final String PREF_FOLLOWED_AUTHOR_KEYS = "followedAuthorKeys";
  private static final long STAGE_DOUBLE_TAP_MS = 280;
  private static final float HORIZONTAL_GESTURE_RATIO = 1.25f;

  private final Handler mainHandler = new Handler(Looper.getMainLooper());
  private final ExecutorService executor = Executors.newFixedThreadPool(4);
  private final Set<String> pendingFrameIds = Collections.synchronizedSet(new HashSet<>());
  private final LruCache<String, Bitmap> frameCache = new LruCache<String, Bitmap>(24) {
    @Override
    protected int sizeOf(String key, Bitmap value) {
      return 1;
    }
  };

  private final List<ShortVideoItem> videos = new ArrayList<>();
  private final Map<Integer, ShortVideoHolder> attachedHolders = new HashMap<>();
  private final Map<Integer, ExoPlayer> playerCache = new HashMap<>();
  private final Map<Integer, PlayerView> playerViews = new HashMap<>();
  private final Map<String, int[]> decodedVideoSizes = new HashMap<>();
  private final Set<Integer> primedPlayerIndexes = new HashSet<>();
  private final Set<Integer> primeRequestedIndexes = new HashSet<>();
  private final Set<Integer> primeCountdownIndexes = new HashSet<>();
  private final Set<Integer> failedPlayerIndexes = new HashSet<>();
  private final Set<String> likedVideoKeys = new HashSet<>();
  private final Set<String> collectedVideoKeys = new HashSet<>();
  private final Set<String> followedAuthorKeys = new HashSet<>();
  private final List<ScreenState> navigationStack = new ArrayList<>();
  private ExoPlayer activePlayer;
  private ViewPager2 pager;
  private ShortVideoAdapter adapter;
  private TextView statusView;
  private TextView topInfoView;
  private TextView topSearchButton;
  private FrameLayout rootView;
  private View authorOverlay;
  private View playbackToolbarOverlay;
  private ScreenState currentScreen;
  private String apiBaseUrl;
  private String pendingFeedUrl;
  private int pendingStartIndex;
  private int nextFeedOffset;
  private boolean hasMoreVideos;
  private boolean loadingMoreVideos;
  private int currentIndex = -1;
  private int pendingPlayIndex = -1;
  private int pendingAutoAdvanceIndex = -1;
  private Runnable pendingPrepareRunnable;
  private Runnable progressRunnable;
  private Runnable systemInfoRunnable;
  private Runnable pendingStageTapRunnable;
  private long lastStageTapAt;
  private int lastStageTapIndex = -1;
  private boolean framePrefetchEnabled;
  private long createdAtMs;
  private boolean loggedFirstFrame;
  private boolean muted;
  private boolean autoNext;
  private boolean controlsHidden;
  private boolean openAuthorPanelOnStart;
  private boolean activityResumed;
  private boolean pausedForLifecycle;
  private boolean resumePlaybackAfterPause;

  @Override
  protected void onCreate(@Nullable Bundle savedInstanceState) {
    super.onCreate(savedInstanceState);
    createdAtMs = SystemClock.elapsedRealtime();
    requestWindowFeature(Window.FEATURE_NO_TITLE);
    setRequestedOrientation(ActivityInfo.SCREEN_ORIENTATION_PORTRAIT);
    hideSystemBars();
    readControlPreferences();
    apiBaseUrl = getIntent().getStringExtra(EXTRA_BASE_URL);
    pendingFeedUrl = getIntent().getStringExtra(EXTRA_FEED_URL);
    pendingStartIndex = Math.max(0, getIntent().getIntExtra(EXTRA_START_INDEX, 0));
    nextFeedOffset = Math.max(0, getIntent().getIntExtra(EXTRA_NEXT_OFFSET, 0));
    hasMoreVideos = getIntent().getBooleanExtra(EXTRA_HAS_MORE, false);
    openAuthorPanelOnStart = getIntent().getBooleanExtra(EXTRA_OPEN_AUTHOR_PANEL, false);
    readVideos();
    String requestedStartId = String.valueOf(getIntent().getStringExtra(EXTRA_START_ID));
    int requestedStartIndex = findVideoIndex(videos, requestedStartId);
    if (requestedStartIndex >= 0) pendingStartIndex = requestedStartIndex;
    buildUi();
    currentScreen = captureFeedScreen();
    if (!videos.isEmpty()) {
      startPlaybackAt(Math.max(0, Math.min(pendingStartIndex, videos.size() - 1)));
    } else if (pendingFeedUrl != null && !pendingFeedUrl.trim().isEmpty()) {
      showStatus("正在读取短视频");
      loadFeedAsync(pendingFeedUrl, pendingStartIndex);
    } else {
      showStatus("没有可播放的短视频");
    }
  }

  @Override
  protected void onResume() {
    super.onResume();
    activityResumed = true;
    hideSystemBars();
    startSystemInfoUpdates();
    boolean shouldResumePlayback = pausedForLifecycle
      && resumePlaybackAfterPause
      && authorOverlay == null
      && activePlayer != null;
    Log.i(TAG, "lifecycle resume shouldPlay=" + shouldResumePlayback);
    if (shouldResumePlayback) {
      activePlayer.play();
      startProgressUpdates();
    } else {
      updateActiveProgress();
    }
    pausedForLifecycle = false;
    resumePlaybackAfterPause = false;
  }

  @Override
  protected void onPause() {
    resumePlaybackAfterPause = authorOverlay == null
      && activePlayer != null
      && activePlayer.getPlayWhenReady()
      && activePlayer.getPlaybackState() != Player.STATE_ENDED;
    pausedForLifecycle = true;
    activityResumed = false;
    Log.i(TAG, "lifecycle pause resumePlayback=" + resumePlaybackAfterPause);
    clearPendingStageTap();
    stopSystemInfoUpdates();
    stopProgressUpdates();
    for (ExoPlayer cachedPlayer : playerCache.values()) cachedPlayer.pause();
    super.onPause();
  }

  @Override
  protected void onDestroy() {
    Log.i(TAG, "destroy");
    stopSystemInfoUpdates();
    stopProgressUpdates();
    releaseAllPlayers();
    executor.shutdownNow();
    super.onDestroy();
  }

  @Override
  public void onWindowFocusChanged(boolean hasFocus) {
    super.onWindowFocusChanged(hasFocus);
    if (hasFocus) hideSystemBars();
  }

  @Override
  public void onBackPressed() {
    if (playbackToolbarOverlay != null) {
      dismissPlaybackToolbar();
      return;
    }
    navigateBack();
  }

  private void buildUi() {
    FrameLayout root = new FrameLayout(this);
    rootView = root;
    root.setBackgroundColor(Color.BLACK);

    pager = new ViewPager2(this);
    pager.setOrientation(ViewPager2.ORIENTATION_VERTICAL);
    pager.setOffscreenPageLimit(2);
    adapter = new ShortVideoAdapter();
    pager.setAdapter(adapter);
    pager.registerOnPageChangeCallback(new ViewPager2.OnPageChangeCallback() {
      @Override
      public void onPageSelected(int position) {
        Log.i(TAG, "page selected " + position);
        pendingPlayIndex = position;
        loadMoreIfNeeded(position);
        if (activePlayer == null) preparePlayerAt(position);
        else preparePlayersAround(position);
        schedulePrepareAround(position, activePlayer == null ? 320 : 120);
        pager.post(() -> playAt(position));
      }

      @Override
      public void onPageScrollStateChanged(int state) {
        if (state == ViewPager2.SCROLL_STATE_DRAGGING) {
          runNeighborsDuringDrag(pager.getCurrentItem());
          return;
        }
        if (state == ViewPager2.SCROLL_STATE_IDLE) {
          int selectedIndex = pendingPlayIndex >= 0 ? pendingPlayIndex : pager.getCurrentItem();
          playAt(selectedIndex);
          pauseInactivePlayers(selectedIndex);
        }
      }
    });
    root.addView(pager, new FrameLayout.LayoutParams(
      ViewGroup.LayoutParams.MATCH_PARENT,
      ViewGroup.LayoutParams.MATCH_PARENT
    ));

    topInfoView = new TextView(this);
    topInfoView.setTextColor(0xE6FFFFFF);
    topInfoView.setTextSize(12);
    topInfoView.setTypeface(Typeface.DEFAULT_BOLD);
    topInfoView.setGravity(Gravity.LEFT | Gravity.CENTER_VERTICAL);
    topInfoView.setShadowLayer(8, 0, 2, 0xAA000000);
    topInfoView.setPadding(dp(14), dp(8), dp(88), dp(4));
    FrameLayout.LayoutParams topInfoParams = new FrameLayout.LayoutParams(
      ViewGroup.LayoutParams.MATCH_PARENT,
      dp(42),
      Gravity.TOP
    );
    root.addView(topInfoView, topInfoParams);
    updateSystemInfo();

    topSearchButton = new TextView(this);
    topSearchButton.setTextColor(Color.WHITE);
    topSearchButton.setTextSize(13);
    topSearchButton.setTypeface(Typeface.DEFAULT_BOLD);
    topSearchButton.setGravity(Gravity.CENTER);
    topSearchButton.setSingleLine(true);
    topSearchButton.setMaxLines(1);
    topSearchButton.setEllipsize(TextUtils.TruncateAt.END);
    topSearchButton.setPadding(dp(10), 0, dp(10), 0);
    topSearchButton.setBackground(roundedDrawable(0x66000000, dp(18)));
    topSearchButton.setContentDescription("搜索短视频");
    topSearchButton.setOnClickListener(view -> showFeedSearchDialog());
    FrameLayout.LayoutParams searchParams = new FrameLayout.LayoutParams(
      dp(70),
      dp(34),
      Gravity.TOP | Gravity.RIGHT
    );
    searchParams.topMargin = dp(5);
    searchParams.rightMargin = dp(12);
    root.addView(topSearchButton, searchParams);
    updateTopSearchButton();

    statusView = new TextView(this);
    statusView.setTextColor(Color.WHITE);
    statusView.setTextSize(15);
    statusView.setGravity(Gravity.CENTER);
    statusView.setBackgroundColor(0x88000000);
    statusView.setPadding(dp(18), dp(10), dp(18), dp(10));
    FrameLayout.LayoutParams statusParams = new FrameLayout.LayoutParams(
      ViewGroup.LayoutParams.WRAP_CONTENT,
      ViewGroup.LayoutParams.WRAP_CONTENT,
      Gravity.CENTER
    );
    root.addView(statusView, statusParams);
    statusView.setVisibility(View.GONE);

    setContentView(root);
    hideSystemBars();
  }

  private void navigateBack() {
    dismissPlaybackToolbar();
    if (navigationStack.isEmpty()) {
      finish();
      return;
    }
    ScreenState previous = navigationStack.remove(navigationStack.size() - 1);
    if (previous instanceof AuthorScreenState) {
      syncAuthorReturnState((AuthorScreenState) previous);
    }
    renderScreen(previous);
  }

  private void syncAuthorReturnState(AuthorScreenState screen) {
    if (!(currentScreen instanceof FeedScreenState) || currentIndex < 0 || currentIndex >= videos.size()) return;
    ShortVideoItem current = videos.get(currentIndex);
    if (!sameAuthor(screen.seed, current)) return;
    screen.currentItem = current;
    if (screen.page != null && findVideoIndex(screen.page.items, current.id) < 0) {
      screen.page.items.add(current);
      screen.page.total = Math.max(screen.page.total, screen.page.items.size());
    }
  }

  private void pushCurrentScreen() {
    ScreenState snapshot = captureCurrentScreen();
    if (snapshot != null) navigationStack.add(snapshot);
  }

  @Nullable
  private ScreenState captureCurrentScreen() {
    if (currentScreen instanceof AuthorScreenState) {
      return ((AuthorScreenState) currentScreen).copy();
    }
    return captureFeedScreen();
  }

  private FeedScreenState captureFeedScreen() {
    int index = currentIndex >= 0 ? currentIndex : (pager == null ? 0 : pager.getCurrentItem());
    return new FeedScreenState(videos, pendingFeedUrl, nextFeedOffset, hasMoreVideos, index);
  }

  private void renderScreen(ScreenState screen) {
    if (screen instanceof AuthorScreenState) {
      renderAuthorScreen(((AuthorScreenState) screen).copy());
      return;
    }
    if (screen instanceof FeedScreenState) {
      renderFeedScreen(((FeedScreenState) screen).copy());
      return;
    }
    finish();
  }

  private void renderFeedScreen(FeedScreenState screen) {
    removeAuthorOverlay();
    releaseAllPlayers();
    attachedHolders.clear();
    loadingMoreVideos = false;
    pendingAutoAdvanceIndex = -1;
    currentIndex = -1;
    pendingPlayIndex = -1;
    pendingFeedUrl = screen.feedUrl;
    updateTopSearchButton();
    nextFeedOffset = Math.max(0, screen.nextOffset);
    hasMoreVideos = screen.hasMore;
    videos.clear();
    videos.addAll(screen.items);
    currentScreen = screen.copy();
    adapter.notifyDataSetChanged();
    if (videos.isEmpty()) {
      if (pendingFeedUrl != null && pendingFeedUrl.trim().length() > 0) {
        showStatus("正在读取短视频");
        loadFeedAsync(pendingFeedUrl, 0);
      } else {
        showStatus("没有可播放的短视频");
      }
      return;
    }
    startPlaybackAt(Math.max(0, Math.min(screen.currentIndex, videos.size() - 1)));
  }

  private void startPlaybackAt(int index) {
    if (videos.isEmpty()) {
      showStatus("没有可播放的短视频");
      return;
    }
    hideStatus();
    int safeIndex = Math.max(0, Math.min(index, videos.size() - 1));
    pendingPlayIndex = safeIndex;
    pager.setCurrentItem(safeIndex, false);
    preparePlayerAt(safeIndex);
    pager.post(() -> {
      playAt(safeIndex);
      schedulePrepareAround(safeIndex, 360);
      openAuthorPanelIfRequested();
    });
  }

  private void openAuthorPanelIfRequested() {
    if (!openAuthorPanelOnStart || videos.isEmpty() || authorOverlay != null) return;
    openAuthorPanelOnStart = false;
    mainHandler.postDelayed(() -> {
      if (videos.isEmpty() || authorOverlay != null) return;
      int index = currentIndex >= 0 ? currentIndex : Math.max(0, Math.min(pendingStartIndex, videos.size() - 1));
      if (index >= 0 && index < videos.size()) showAuthorPanel(videos.get(index));
    }, 360);
  }

  private void playAt(int index) {
    if (index < 0 || index >= videos.size()) return;
    currentIndex = index;
    ShortVideoItem item = videos.get(index);
    ShortVideoHolder holder = attachedHolders.get(index);
    if (holder == null) {
      pager.post(() -> playAt(index));
      return;
    }

    applyCachedFrame(holder, item);
    ExoPlayer nextPlayer = preparePlayerAt(index);
    if (nextPlayer == null) return;
    boolean alreadyActive = activePlayer == nextPlayer;
    if (alreadyActive) {
      activePlayer.setRepeatMode(activeRepeatMode());
      activePlayer.setVolume(activeVolume());
      ensurePlayerViewAt(index);
      if (activePlayer.getPlaybackState() == Player.STATE_READY) holder.cover.setVisibility(View.GONE);
      if (activePlayer.getPlaybackState() == Player.STATE_ENDED) activePlayer.seekTo(0);
      startActivePlaybackIfVisible();
      return;
    }
    if (activePlayer != null && activePlayer != nextPlayer) {
      activePlayer.pause();
      activePlayer.setVolume(0f);
    }
    activePlayer = nextPlayer;
    primedPlayerIndexes.remove(index);
    primeRequestedIndexes.remove(index);
    primeCountdownIndexes.remove(index);
    activePlayer.setRepeatMode(activeRepeatMode());
    activePlayer.setVolume(activeVolume());
    ensurePlayerViewAt(index);
    if (activePlayer.getPlaybackState() == Player.STATE_ENDED) activePlayer.seekTo(0);
    if (activePlayer.getPlaybackState() == Player.STATE_READY) {
      if (activePlayer.getCurrentPosition() > 0) {
        holder.cover.setVisibility(View.GONE);
      } else {
        holder.cover.postDelayed(() -> {
          if (currentIndex == index) holder.cover.setVisibility(View.GONE);
        }, 40);
      }
    } else {
      holder.cover.setVisibility(View.VISIBLE);
    }
    framePrefetchEnabled = true;
    startActivePlaybackIfVisible();
    Log.i(TAG, "play " + index + " " + item.streamUrl);
    loadMoreIfNeeded(index);
  }

  private void startActivePlaybackIfVisible() {
    if (!activityResumed || authorOverlay != null || activePlayer == null || isFinishing()) return;
    activePlayer.play();
    startProgressUpdates();
  }

  private ExoPlayer preparePlayerAt(int index) {
    if (index < 0 || index >= videos.size()) return null;
    ExoPlayer cachedPlayer = playerCache.get(index);
    if (cachedPlayer != null) {
      cachedPlayer.setRepeatMode(activeRepeatMode());
      ensurePlayerViewAt(index);
      return cachedPlayer;
    }

    ShortVideoItem item = videos.get(index);
    ExoPlayer preparedPlayer = new ExoPlayer.Builder(this)
      .setLoadControl(new DefaultLoadControl.Builder()
        .setBufferDurationsMs(600, 2000, 100, 220)
        .build())
      .build();
    preparedPlayer.setRepeatMode(activeRepeatMode());
    preparedPlayer.setVolume(0f);
    preparedPlayer.setMediaItem(MediaItem.fromUri(Uri.parse(item.streamUrl)));
    preparedPlayer.addListener(new Player.Listener() {
      @Override
      public void onRenderedFirstFrame() {
        if (currentIndex != index) return;
        failedPlayerIndexes.remove(index);
        if (!loggedFirstFrame) {
          loggedFirstFrame = true;
          Log.i(TAG, "first frame in " + (SystemClock.elapsedRealtime() - createdAtMs) + "ms");
        }
        ShortVideoHolder holder = attachedHolders.get(index);
        if (holder != null) holder.cover.setVisibility(View.GONE);
        hideStatus();
        mainHandler.post(() -> preparePlayersAround(index));
      }

      @Override
      public void onVideoSizeChanged(@NonNull VideoSize videoSize) {
        mainHandler.post(() -> {
          rememberDecodedVideoSize(index, videoSize.width, videoSize.height);
          applyVideoResizeMode(index, videoSize.width, videoSize.height);
          Log.i(TAG, "video size " + index + " " + videoSize.width + "x" + videoSize.height
            + " mode=" + (isLandscapeVideo(videoSize.width, videoSize.height) ? "fit" : "zoom"));
        });
      }

      @Override
      public void onPlaybackStateChanged(int playbackState) {
        if (playbackState == Player.STATE_ENDED && currentIndex == index && autoNext) {
          mainHandler.post(() -> advanceAfterEnded(index));
          return;
        }
        if (playbackState != Player.STATE_READY) return;
        failedPlayerIndexes.remove(index);
        if (currentIndex == index) {
          hideStatus();
          ShortVideoHolder holder = attachedHolders.get(index);
          if (holder != null) {
            holder.cover.postDelayed(() -> {
              if (currentIndex == index) holder.cover.setVisibility(View.GONE);
            }, 80);
          }
        } else if (primeRequestedIndexes.contains(index)) {
          startPrimeCountdown(index, preparedPlayer);
        }
        mainHandler.post(() -> syncPlayIndicator(index, preparedPlayer));
      }

      @Override
      public void onIsPlayingChanged(boolean isPlaying) {
        mainHandler.post(() -> syncPlayIndicator(index, preparedPlayer));
      }

      @Override
      public void onPlayerError(@NonNull PlaybackException error) {
        mainHandler.post(() -> handlePlaybackError(index, preparedPlayer, error));
      }
    });
    preparedPlayer.prepare();
    playerCache.put(index, preparedPlayer);
    PlayerView preparedView = ensurePlayerViewAt(index);
    if (preparedView != null) preparedView.setPlayer(preparedPlayer);
    Log.i(TAG, "prepare " + index + " " + item.streamUrl);
    return preparedPlayer;
  }

  private void advanceAfterEnded(int index) {
    if (!activityResumed || authorOverlay != null || !autoNext || currentIndex != index) return;
    if (index + 1 < videos.size()) {
      pager.setCurrentItem(index + 1, true);
      return;
    }
    if (hasMoreVideos && pendingFeedUrl != null && pendingFeedUrl.trim().length() > 0) {
      pendingAutoAdvanceIndex = index;
      showStatus("正在加载下一条");
      loadMoreIfNeeded(index);
      return;
    }
    ExoPlayer player = playerCache.get(index);
    if (player != null) {
      player.seekTo(0);
      player.play();
    }
  }

  private void handlePlaybackError(int index, ExoPlayer player, PlaybackException error) {
    if (playerCache.get(index) != player && activePlayer != player) return;
    if (playerCache.get(index) == player) {
      playerCache.remove(index);
      primedPlayerIndexes.remove(index);
      primeRequestedIndexes.remove(index);
      primeCountdownIndexes.remove(index);
      if (activePlayer == player) activePlayer = null;
      PlayerView view = playerViews.get(index);
      if (view != null) view.setPlayer(null);
      player.release();
    }
    failedPlayerIndexes.add(index);
    ShortVideoHolder holder = attachedHolders.get(index);
    if (holder != null) holder.cover.setVisibility(View.VISIBLE);
    if (currentIndex == index) {
      stopProgressUpdates();
      updateActiveProgress();
      showStatus("播放失败，点一下重试");
    }
    Log.w(TAG, "playback error " + index + " " + error.getErrorCodeName());
  }

  private void retryPlaybackAt(int index) {
    if (index < 0 || index >= videos.size()) return;
    failedPlayerIndexes.remove(index);
    showStatus("正在重试播放");
    releasePlayerAt(index);
    preparePlayerAt(index);
    pager.post(() -> playAt(index));
  }

  private void releasePlayerAt(int index) {
    ExoPlayer player = playerCache.remove(index);
    primedPlayerIndexes.remove(index);
    primeRequestedIndexes.remove(index);
    primeCountdownIndexes.remove(index);
    failedPlayerIndexes.remove(index);
    if (player != null) {
      if (player == activePlayer) activePlayer = null;
      player.release();
    }
    PlayerView view = playerViews.remove(index);
    if (view != null) {
      view.setPlayer(null);
      if (view.getParent() instanceof ViewGroup) {
        ((ViewGroup) view.getParent()).removeView(view);
      }
    }
  }

  @Nullable
  private PlayerView ensurePlayerViewAt(int index) {
    if (index < 0 || index >= videos.size()) return null;
    PlayerView view = playerViews.get(index);
    if (view == null) {
      int[] dimensions = resolvedVideoSize(index);
      view = (PlayerView) getLayoutInflater().inflate(R.layout.native_short_player_view, pager, false);
      view.setClickable(false);
      view.setFocusable(false);
      view.setEnabled(false);
      view.setUseController(false);
      view.setKeepContentOnPlayerReset(true);
      view.setResizeMode(resizeModeFor(dimensions[0], dimensions[1]));
      ExoPlayer cachedPlayer = playerCache.get(index);
      if (cachedPlayer != null) view.setPlayer(cachedPlayer);
      playerViews.put(index, view);
    }

    ShortVideoHolder holder = attachedHolders.get(index);
    if (holder == null) return view;
    if (view.getParent() != holder.stage) {
      if (view.getParent() instanceof ViewGroup) {
        ((ViewGroup) view.getParent()).removeView(view);
      }
      holder.stage.addView(view, 0, new FrameLayout.LayoutParams(
        ViewGroup.LayoutParams.MATCH_PARENT,
        ViewGroup.LayoutParams.MATCH_PARENT
      ));
    }
    int[] dimensions = resolvedVideoSize(index);
    applyVideoResizeMode(index, dimensions[0], dimensions[1]);
    return view;
  }

  private void rememberDecodedVideoSize(int index, int width, int height) {
    if (index < 0 || index >= videos.size() || width <= 0 || height <= 0) return;
    String key = videoInteractionKey(videos.get(index));
    if (key.length() > 0) decodedVideoSizes.put(key, new int[] { width, height });
  }

  private int[] resolvedVideoSize(int index) {
    if (index < 0 || index >= videos.size()) return new int[] { 0, 0 };
    ShortVideoItem item = videos.get(index);
    String key = videoInteractionKey(item);
    int[] decoded = key.length() == 0 ? null : decodedVideoSizes.get(key);
    if (decoded != null && decoded.length >= 2 && decoded[0] > 0 && decoded[1] > 0) {
      return decoded;
    }
    return new int[] { item.width, item.height };
  }

  private void applyVideoResizeMode(int index, int width, int height) {
    if (index < 0 || index >= videos.size() || width <= 0 || height <= 0) return;
    boolean landscape = isLandscapeVideo(width, height);
    PlayerView view = playerViews.get(index);
    if (view != null) view.setResizeMode(landscape
      ? AspectRatioFrameLayout.RESIZE_MODE_FIT
      : AspectRatioFrameLayout.RESIZE_MODE_ZOOM);
    ShortVideoHolder holder = attachedHolders.get(index);
    if (holder != null) {
      holder.stage.setBackgroundColor(Color.BLACK);
      holder.cover.setScaleType(landscape ? ImageView.ScaleType.FIT_CENTER : ImageView.ScaleType.CENTER_CROP);
    }
  }

  private int resizeModeFor(int width, int height) {
    return isLandscapeVideo(width, height)
      ? AspectRatioFrameLayout.RESIZE_MODE_FIT
      : AspectRatioFrameLayout.RESIZE_MODE_ZOOM;
  }

  private boolean isLandscapeVideo(int width, int height) {
    return width > 0 && height > 0 && width / (float) height >= 1.08f;
  }

  private void preparePlayersAround(int index) {
    loadMoreIfNeeded(index);
    for (int i = index - 1; i <= index + 2; i++) {
      ExoPlayer preparedPlayer = preparePlayerAt(i);
      if (i != index) primeNeighborPlayer(i, preparedPlayer);
    }
    releaseDistantPlayers(index);
  }

  private void runNeighborsDuringDrag(int index) {
    if (!activityResumed || authorOverlay != null) return;
    for (int i = index - 1; i <= index + 2; i++) {
      if (i == index) continue;
      ExoPlayer preparedPlayer = preparePlayerAt(i);
      if (preparedPlayer == null || preparedPlayer == activePlayer) continue;
      preparedPlayer.setVolume(0f);
      preparedPlayer.play();
      Log.i(TAG, "warm " + i);
    }
  }

  private void pauseInactivePlayers(int activeIndex) {
    for (Map.Entry<Integer, ExoPlayer> entry : playerCache.entrySet()) {
      if (entry.getKey() == activeIndex) continue;
      ExoPlayer cachedPlayer = entry.getValue();
      if (cachedPlayer == activePlayer) continue;
      cachedPlayer.pause();
      cachedPlayer.setVolume(0f);
    }
  }

  private void primeNeighborPlayer(int index, @Nullable ExoPlayer preparedPlayer) {
    if (!activityResumed || authorOverlay != null) return;
    if (preparedPlayer == null || index < 0 || index >= videos.size()) return;
    if (preparedPlayer == activePlayer || primedPlayerIndexes.contains(index) || primeRequestedIndexes.contains(index)) return;
    if (preparedPlayer.getPlaybackState() == Player.STATE_ENDED) preparedPlayer.seekTo(0);
    preparedPlayer.setVolume(0f);
    primeRequestedIndexes.add(index);
    preparedPlayer.play();
    if (preparedPlayer.getPlaybackState() == Player.STATE_READY) {
      startPrimeCountdown(index, preparedPlayer);
    }
  }

  private void startPrimeCountdown(int index, ExoPlayer preparedPlayer) {
    if (preparedPlayer == activePlayer || primeCountdownIndexes.contains(index)) return;
    primeCountdownIndexes.add(index);
    mainHandler.postDelayed(() -> {
      ExoPlayer livePlayer = playerCache.get(index);
      if (livePlayer == null || livePlayer == activePlayer) return;
      livePlayer.pause();
      livePlayer.setVolume(0f);
      primedPlayerIndexes.add(index);
      primeRequestedIndexes.remove(index);
      primeCountdownIndexes.remove(index);
      Log.i(TAG, "prime " + index + " @" + livePlayer.getCurrentPosition() + "ms");
    }, 220);
  }

  private void releaseDistantPlayers(int centerIndex) {
    List<Integer> keys = new ArrayList<>(playerCache.keySet());
    for (int key : keys) {
      if (key >= centerIndex - 1 && key <= centerIndex + 2) continue;
      ExoPlayer stalePlayer = playerCache.remove(key);
      primedPlayerIndexes.remove(key);
      primeRequestedIndexes.remove(key);
      primeCountdownIndexes.remove(key);
      failedPlayerIndexes.remove(key);
      if (stalePlayer == null) continue;
      if (stalePlayer == activePlayer) {
        activePlayer = null;
      }
      stalePlayer.release();
      PlayerView staleView = playerViews.remove(key);
      if (staleView != null) {
        staleView.setPlayer(null);
        if (staleView.getParent() instanceof ViewGroup) {
          ((ViewGroup) staleView.getParent()).removeView(staleView);
        }
      }
      Log.i(TAG, "release " + key);
    }
  }

  private void releaseAllPlayers() {
    clearPendingStageTap();
    dismissPlaybackToolbar();
    stopProgressUpdates();
    for (ExoPlayer cachedPlayer : playerCache.values()) cachedPlayer.release();
    for (PlayerView cachedView : playerViews.values()) {
      cachedView.setPlayer(null);
      if (cachedView.getParent() instanceof ViewGroup) {
        ((ViewGroup) cachedView.getParent()).removeView(cachedView);
      }
    }
    playerCache.clear();
    playerViews.clear();
    primedPlayerIndexes.clear();
    primeRequestedIndexes.clear();
    primeCountdownIndexes.clear();
    failedPlayerIndexes.clear();
    activePlayer = null;
  }

  private void toggleActivePlayback() {
    if (activePlayer == null || currentIndex < 0) return;
    if (activePlayer.getPlaybackState() == Player.STATE_ENDED) activePlayer.seekTo(0);
    if (activePlayer.isPlaying()) {
      activePlayer.pause();
      updateActiveProgress();
    } else {
      activePlayer.play();
      startProgressUpdates();
    }
    syncPlayIndicator(currentIndex, activePlayer);
  }

  private void handleStageTap(int index) {
    if (index < 0 || index >= videos.size()) return;
    long now = SystemClock.uptimeMillis();
    if (pendingStageTapRunnable != null && lastStageTapIndex == index && now - lastStageTapAt <= STAGE_DOUBLE_TAP_MS) {
      clearPendingStageTap();
      activateLike(videos.get(index), true);
      return;
    }
    clearPendingStageTap();
    lastStageTapAt = now;
    lastStageTapIndex = index;
    pendingStageTapRunnable = () -> {
      pendingStageTapRunnable = null;
      lastStageTapAt = 0;
      lastStageTapIndex = -1;
      if (currentIndex != index) return;
      if (failedPlayerIndexes.contains(index)) retryPlaybackAt(index);
      else if (controlsHidden) setControlsHidden(false, true);
      else toggleActivePlayback();
    };
    mainHandler.postDelayed(pendingStageTapRunnable, STAGE_DOUBLE_TAP_MS);
  }

  private boolean handleStageTouch(ShortVideoHolder holder, View view, MotionEvent event) {
    if (holder == null || event == null) return false;
    int action = event.getActionMasked();
    if (action == MotionEvent.ACTION_DOWN) {
      holder.touchStartX = event.getX();
      holder.touchStartY = event.getY();
      holder.touchActive = true;
      holder.horizontalGesture = false;
      holder.longPressTriggered = false;
      scheduleStageLongPress(holder, view);
      return false;
    }
    if (!holder.touchActive) return false;
    if (action == MotionEvent.ACTION_MOVE) {
      float dx = event.getX() - holder.touchStartX;
      float dy = event.getY() - holder.touchStartY;
      if (Math.abs(dx) > dp(12) || Math.abs(dy) > dp(12)) cancelStageLongPress(holder);
      if (!holder.horizontalGesture && Math.abs(dx) > dp(22) && Math.abs(dx) > Math.abs(dy) * HORIZONTAL_GESTURE_RATIO) {
        holder.horizontalGesture = true;
        setParentInterceptDisallowed(view, true);
      }
      return holder.horizontalGesture;
    }
    if (action == MotionEvent.ACTION_UP) {
      float dx = event.getX() - holder.touchStartX;
      float dy = event.getY() - holder.touchStartY;
      boolean horizontal = holder.horizontalGesture || (Math.abs(dx) > dp(72) && Math.abs(dx) > Math.abs(dy) * HORIZONTAL_GESTURE_RATIO);
      holder.touchActive = false;
      holder.horizontalGesture = false;
      boolean consumedLongPress = holder.longPressTriggered;
      holder.longPressTriggered = false;
      cancelStageLongPress(holder);
      setParentInterceptDisallowed(view, false);
      if (consumedLongPress) return true;
      if (!horizontal) return false;
      handleHorizontalSwipe(holder.index, dx);
      return true;
    }
    if (action == MotionEvent.ACTION_CANCEL) {
      holder.touchActive = false;
      holder.horizontalGesture = false;
      holder.longPressTriggered = false;
      cancelStageLongPress(holder);
      setParentInterceptDisallowed(view, false);
    }
    return false;
  }

  private boolean handleGestureLayerTouch(ShortVideoHolder holder, View view, MotionEvent event) {
    if (holder == null || event == null) return true;
    int action = event.getActionMasked();
    if (action == MotionEvent.ACTION_DOWN) {
      holder.touchStartX = event.getRawX();
      holder.touchStartY = event.getRawY();
      holder.touchActive = true;
      holder.horizontalGesture = false;
      holder.verticalGesture = false;
      holder.longPressTriggered = false;
      setParentInterceptDisallowed(view, true);
      scheduleStageLongPress(holder, view);
      return true;
    }
    if (!holder.touchActive) return true;
    if (action == MotionEvent.ACTION_MOVE) {
      float dx = event.getRawX() - holder.touchStartX;
      float dy = event.getRawY() - holder.touchStartY;
      if (Math.abs(dx) > dp(32) || Math.abs(dy) > dp(32)) cancelStageLongPress(holder);
      if (!holder.horizontalGesture && !holder.verticalGesture && Math.abs(dx) > dp(28) && Math.abs(dx) > Math.abs(dy) * HORIZONTAL_GESTURE_RATIO) {
        holder.horizontalGesture = true;
        setParentInterceptDisallowed(view, true);
      } else if (!holder.horizontalGesture && !holder.verticalGesture && Math.abs(dy) > dp(42) && Math.abs(dy) > Math.abs(dx) * 1.1f) {
        holder.verticalGesture = true;
        setParentInterceptDisallowed(view, false);
      }
      return true;
    }
    if (action == MotionEvent.ACTION_UP) {
      float dx = event.getRawX() - holder.touchStartX;
      float dy = event.getRawY() - holder.touchStartY;
      boolean consumedLongPress = holder.longPressTriggered;
      boolean horizontal = holder.horizontalGesture || (Math.abs(dx) > dp(72) && Math.abs(dx) > Math.abs(dy) * HORIZONTAL_GESTURE_RATIO);
      boolean vertical = holder.verticalGesture || (Math.abs(dy) > dp(86) && Math.abs(dy) > Math.abs(dx) * 1.1f);
      holder.touchActive = false;
      holder.horizontalGesture = false;
      holder.verticalGesture = false;
      holder.longPressTriggered = false;
      cancelStageLongPress(holder);
      setParentInterceptDisallowed(view, false);
      if (consumedLongPress) return true;
      if (horizontal) {
        handleHorizontalSwipe(holder.index, dx);
      } else if (!vertical) {
        handleStageTap(holder.index);
      }
      return true;
    }
    if (action == MotionEvent.ACTION_CANCEL) {
      holder.touchActive = false;
      holder.horizontalGesture = false;
      holder.verticalGesture = false;
      holder.longPressTriggered = false;
      cancelStageLongPress(holder);
      setParentInterceptDisallowed(view, false);
    }
    return true;
  }

  private void scheduleStageLongPress(ShortVideoHolder holder, View view) {
    cancelStageLongPress(holder);
    holder.longPressRunnable = () -> {
      holder.longPressRunnable = null;
      if (holder.index < 0 || holder.index >= videos.size()) return;
      if (attachedHolders.get(holder.index) != holder || holder.horizontalGesture) return;
      holder.longPressTriggered = true;
      clearPendingStageTap();
      if (view != null) view.performHapticFeedback(HapticFeedbackConstants.LONG_PRESS);
      showPlaybackToolbar(videos.get(holder.index));
    };
    mainHandler.postDelayed(holder.longPressRunnable, 560);
  }

  private void cancelStageLongPress(ShortVideoHolder holder) {
    if (holder != null && holder.longPressRunnable != null) {
      mainHandler.removeCallbacks(holder.longPressRunnable);
      holder.longPressRunnable = null;
    }
  }

  private void handleHorizontalSwipe(int index, float deltaX) {
    if (index < 0 || index >= videos.size()) return;
    clearPendingStageTap();
    if (deltaX > 0) {
      boolean authorFeed = isViewingAuthorFeed();
      Log.i(TAG, "horizontal swipe right index=" + index + " authorFeed=" + authorFeed);
      if (authorFeed && navigationStack.isEmpty()) {
        showAuthorPanel(videos.get(index));
        return;
      }
      navigateBack();
      return;
    }
    if (isViewingAuthorFeed()) {
      Log.i(TAG, "horizontal swipe left blocked in author feed index=" + index);
      showTransientStatus("已在作者页，右滑返回");
      return;
    }
    Log.i(TAG, "horizontal swipe left open author index=" + index);
    showAuthorPanel(videos.get(index));
  }

  private boolean isViewingAuthorFeed() {
    if (!(currentScreen instanceof FeedScreenState)) return false;
    if (!navigationStack.isEmpty()
      && navigationStack.get(navigationStack.size() - 1) instanceof AuthorScreenState) return true;
    try {
      Uri uri = Uri.parse(pendingFeedUrl == null ? "" : pendingFeedUrl);
      return uri.getQueryParameter("author") != null && uri.getQueryParameter("author").trim().length() > 0;
    } catch (Exception ignored) {
      return false;
    }
  }

  private void clearPendingStageTap() {
    if (pendingStageTapRunnable != null) {
      mainHandler.removeCallbacks(pendingStageTapRunnable);
      pendingStageTapRunnable = null;
    }
    lastStageTapAt = 0;
    lastStageTapIndex = -1;
  }

  private void activateLike(ShortVideoItem item, boolean showBurst) {
    String key = videoInteractionKey(item);
    if (key.length() == 0) return;
    boolean added = likedVideoKeys.add(key);
    if (added) persistVideoInteractionKeys(PREF_LIKED_VIDEO_KEYS, likedVideoKeys);
    refreshVisibleRails();
    if (showBurst) showLikeBurst(item);
    showTransientStatus(added ? "已点赞" : "已点过赞");
  }

  private void toggleLike(ShortVideoItem item) {
    String key = videoInteractionKey(item);
    if (key.length() == 0) return;
    if (!likedVideoKeys.contains(key)) {
      activateLike(item, true);
      return;
    }
    likedVideoKeys.remove(key);
    persistVideoInteractionKeys(PREF_LIKED_VIDEO_KEYS, likedVideoKeys);
    refreshVisibleRails();
    showTransientStatus("已取消点赞");
  }

  private long displayLikes(ShortVideoItem item) {
    return item.likes + (isLiked(item) ? 1 : 0);
  }

  private boolean isLiked(ShortVideoItem item) {
    String key = videoInteractionKey(item);
    return key.length() > 0 && likedVideoKeys.contains(key);
  }

  private void toggleCollected(ShortVideoItem item) {
    String key = videoInteractionKey(item);
    if (key.length() == 0) return;
    boolean collected;
    if (collectedVideoKeys.contains(key)) {
      collectedVideoKeys.remove(key);
      collected = false;
    } else {
      collectedVideoKeys.add(key);
      collected = true;
    }
    persistVideoInteractionKeys(PREF_COLLECTED_VIDEO_KEYS, collectedVideoKeys);
    refreshVisibleRails();
    showTransientStatus(collected ? "已收藏" : "已取消收藏");
  }

  private long displayCollects(ShortVideoItem item) {
    return item.collects + (isCollected(item) ? 1 : 0);
  }

  private boolean isCollected(ShortVideoItem item) {
    String key = videoInteractionKey(item);
    return key.length() > 0 && collectedVideoKeys.contains(key);
  }

  private String videoInteractionKey(ShortVideoItem item) {
    if (item == null) return "";
    if (item.id.length() > 0) return item.id;
    if (item.awemeId.length() > 0) return "aweme:" + item.awemeId;
    if (item.streamUrl.length() > 0) return "stream:" + item.streamUrl;
    return "";
  }

  private String authorInteractionKey(ShortVideoItem item) {
    if (item == null) return "";
    if (item.authorSecUid.length() > 0) return "sec:" + item.authorSecUid;
    if (item.authorUid.length() > 0) return "uid:" + item.authorUid;
    if (item.authorUniqueId.length() > 0) return "unique:" + item.authorUniqueId;
    if (item.author.length() > 0) return "name:" + item.author;
    return "";
  }

  private boolean isFollowingAuthor(ShortVideoItem item) {
    String key = authorInteractionKey(item);
    return key.length() > 0 && followedAuthorKeys.contains(key);
  }

  private void toggleFollowingAuthor(ShortVideoItem item) {
    String key = authorInteractionKey(item);
    if (key.length() == 0) {
      showTransientStatus("这个视频没有作者信息");
      return;
    }
    boolean following;
    if (followedAuthorKeys.contains(key)) {
      followedAuthorKeys.remove(key);
      following = false;
    } else {
      followedAuthorKeys.add(key);
      following = true;
    }
    persistVideoInteractionKeys(PREF_FOLLOWED_AUTHOR_KEYS, followedAuthorKeys);
    refreshVisibleRails();
    showTransientStatus(following ? "已关注 " + displayAuthor(item) : "已取消关注");
  }

  private void bindFollowButton(TextView button, ShortVideoItem item) {
    if (button == null) return;
    boolean following = isFollowingAuthor(item);
    button.setText(following ? "已关注" : "+ 关注");
    button.setTextColor(following ? 0xFF161823 : Color.WHITE);
    button.setBackground(roundedDrawable(following ? 0xFFEFF1F5 : 0xFFFE2C55, dp(8)));
    button.setContentDescription((following ? "取消关注 " : "关注 ") + displayAuthor(item));
  }

  private void showLikeBurst(ShortVideoItem item) {
    ShortVideoHolder holder = null;
    if (currentIndex >= 0 && currentIndex < videos.size() && isSameVideo(videos.get(currentIndex), item)) {
      holder = attachedHolders.get(currentIndex);
    }
    if (holder == null) {
      for (ShortVideoHolder candidate : attachedHolders.values()) {
        if (candidate.index >= 0 && candidate.index < videos.size() && isSameVideo(videos.get(candidate.index), item)) {
          holder = candidate;
          break;
        }
      }
    }
    if (holder == null) return;
    ImageView burst = holder.likeBurst;
    burst.animate().cancel();
    burst.setVisibility(View.VISIBLE);
    burst.setAlpha(0f);
    burst.setScaleX(0.62f);
    burst.setScaleY(0.62f);
    burst.animate()
      .alpha(1f)
      .scaleX(1.12f)
      .scaleY(1.12f)
      .setStartDelay(0)
      .setDuration(120)
      .withEndAction(() -> burst.animate()
        .alpha(0f)
        .scaleX(1.34f)
        .scaleY(1.34f)
        .setStartDelay(160)
        .setDuration(260)
        .withEndAction(() -> burst.setVisibility(View.GONE))
        .start())
      .start();
  }

  private void resetLikeBurst(ShortVideoHolder holder) {
    holder.likeBurst.animate().cancel();
    holder.likeBurst.setVisibility(View.GONE);
    holder.likeBurst.setAlpha(0f);
    holder.likeBurst.setScaleX(0.62f);
    holder.likeBurst.setScaleY(0.62f);
  }

  private void setControlsHidden(boolean hidden, boolean showToast) {
    if (controlsHidden == hidden && !showToast) return;
    controlsHidden = hidden;
    for (ShortVideoHolder holder : attachedHolders.values()) applyControlsVisibility(holder);
    if (showToast) showTransientStatus(hidden ? "已清屏，点一下恢复控件" : "已显示控件");
  }

  private void applyControlsVisibility(ShortVideoHolder holder) {
    int visibility = controlsHidden ? View.GONE : View.VISIBLE;
    holder.caption.setVisibility(visibility);
    holder.rail.setVisibility(visibility);
    holder.progressTouch.setVisibility(visibility);
    syncPlayIndicator(holder.index, playerCache.get(holder.index));
    if (topSearchButton != null) topSearchButton.setVisibility(visibility);
    if (controlsHidden) hideSeekPreview(holder, false);
  }

  private void syncPlayIndicator(int index, @Nullable ExoPlayer player) {
    ShortVideoHolder holder = attachedHolders.get(index);
    if (holder == null) return;
    boolean paused = !controlsHidden
      && currentIndex == index
      && player != null
      && player.getPlaybackState() == Player.STATE_READY
      && !player.isPlaying();
    holder.playIndicator.animate().cancel();
    holder.playIndicator.setVisibility(paused ? View.VISIBLE : View.GONE);
    holder.playIndicator.setAlpha(paused ? 1f : 0f);
    holder.playIndicator.setScaleX(1f);
    holder.playIndicator.setScaleY(1f);
  }

  private void startSystemInfoUpdates() {
    if (systemInfoRunnable != null) mainHandler.removeCallbacks(systemInfoRunnable);
    systemInfoRunnable = new Runnable() {
      @Override
      public void run() {
        updateSystemInfo();
        mainHandler.postDelayed(this, 30000);
      }
    };
    mainHandler.post(systemInfoRunnable);
  }

  private void stopSystemInfoUpdates() {
    if (systemInfoRunnable != null) {
      mainHandler.removeCallbacks(systemInfoRunnable);
      systemInfoRunnable = null;
    }
  }

  private void updateSystemInfo() {
    if (topInfoView == null) return;
    String time = new SimpleDateFormat("MM/dd HH:mm", Locale.CHINA).format(new Date());
    int battery = -1;
    try {
      BatteryManager manager = (BatteryManager) getSystemService(BATTERY_SERVICE);
      if (manager != null) battery = manager.getIntProperty(BatteryManager.BATTERY_PROPERTY_CAPACITY);
    } catch (Exception ignored) {}
    topInfoView.setText(battery >= 0 ? time + "  电量 " + battery + "%" : time);
  }

  private void startProgressUpdates() {
    if (progressRunnable != null) mainHandler.removeCallbacks(progressRunnable);
    progressRunnable = new Runnable() {
      @Override
      public void run() {
        updateActiveProgress();
        if (activePlayer != null && currentIndex >= 0) {
          mainHandler.postDelayed(this, activePlayer.isPlaying() ? 250 : 600);
        }
      }
    };
    mainHandler.post(progressRunnable);
  }

  private void stopProgressUpdates() {
    if (progressRunnable != null) {
      mainHandler.removeCallbacks(progressRunnable);
      progressRunnable = null;
    }
  }

  private void updateActiveProgress() {
    if (currentIndex < 0) return;
    ShortVideoHolder holder = attachedHolders.get(currentIndex);
    if (holder == null || activePlayer == null) return;
    long duration = activePlayer.getDuration();
    long position = activePlayer.getCurrentPosition();
    float ratio = duration > 0 ? Math.max(0f, Math.min(1f, position / (float) duration)) : 0f;
    holder.progressFill.setScaleX(ratio);
    holder.progressTrack.setAlpha(duration > 0 ? 1f : 0f);
  }

  private void resetHolderProgress(ShortVideoHolder holder) {
    holder.progressFill.setScaleX(0f);
    holder.progressTrack.setAlpha(0f);
    hideSeekPreview(holder, false);
  }

  private boolean seekActivePlayerFromTouch(View view, MotionEvent event) {
    if (event == null) return true;
    int action = event.getActionMasked();
    if (action == MotionEvent.ACTION_DOWN || action == MotionEvent.ACTION_MOVE) {
      setParentInterceptDisallowed(view, true);
    } else if (action == MotionEvent.ACTION_UP || action == MotionEvent.ACTION_CANCEL) {
      setParentInterceptDisallowed(view, false);
    }
    ShortVideoHolder holder = attachedHolders.get(currentIndex);
    if (activePlayer == null || currentIndex < 0 || holder == null) return true;
    long duration = activePlayer.getDuration();
    if (duration <= 0) {
      hideSeekPreview(holder, false);
      return true;
    }
    if (action == MotionEvent.ACTION_CANCEL) {
      hideSeekPreview(holder, false);
      return true;
    }
    float width = Math.max(1f, view.getWidth());
    float ratio = Math.max(0f, Math.min(1f, event.getX() / width));
    long targetPosition = Math.max(0, Math.min(duration - 1, (long) (duration * ratio)));
    activePlayer.seekTo(targetPosition);
    updateActiveProgress();
    showSeekPreview(holder, targetPosition, duration, action == MotionEvent.ACTION_UP);
    return true;
  }

  private void showSeekPreview(ShortVideoHolder holder, long position, long duration, boolean scheduleHide) {
    if (holder == null) return;
    if (holder.hideSeekPreviewRunnable != null) {
      mainHandler.removeCallbacks(holder.hideSeekPreviewRunnable);
      holder.hideSeekPreviewRunnable = null;
    }
    holder.progressTime.animate().cancel();
    holder.progressTime.setAlpha(1f);
    holder.progressTime.setText(formatPlaybackTime(position) + " / " + formatPlaybackTime(duration));
    holder.progressTime.setVisibility(controlsHidden ? View.GONE : View.VISIBLE);
    if (!scheduleHide) return;
    holder.hideSeekPreviewRunnable = () -> hideSeekPreview(holder, true);
    mainHandler.postDelayed(holder.hideSeekPreviewRunnable, 1800);
  }

  private void hideSeekPreview(ShortVideoHolder holder, boolean animate) {
    if (holder == null) return;
    if (holder.hideSeekPreviewRunnable != null) {
      mainHandler.removeCallbacks(holder.hideSeekPreviewRunnable);
      holder.hideSeekPreviewRunnable = null;
    }
    if (!animate || holder.progressTime.getVisibility() != View.VISIBLE) {
      holder.progressTime.setVisibility(View.GONE);
      holder.progressTime.setAlpha(1f);
      return;
    }
    holder.progressTime.animate()
      .alpha(0f)
      .setDuration(140)
      .withEndAction(() -> {
        holder.progressTime.setVisibility(View.GONE);
        holder.progressTime.setAlpha(1f);
      })
      .start();
  }

  private void setParentInterceptDisallowed(View view, boolean disallow) {
    if (view != null && view.getParent() != null) {
      view.getParent().requestDisallowInterceptTouchEvent(disallow);
    }
  }

  private void loadMoreIfNeeded(int index) {
    if (loadingMoreVideos || !hasMoreVideos || pendingFeedUrl == null || pendingFeedUrl.trim().isEmpty()) return;
    if (videos.size() - index > 6) return;
    loadingMoreVideos = true;
    String feedUrl = pagedFeedUrl(pendingFeedUrl, nextFeedOffset, 40);
    Log.i(TAG, "load more offset=" + nextFeedOffset);
    executor.execute(() -> {
      FeedPage page = readFeedPage(feedUrl);
      mainHandler.post(() -> {
        loadingMoreVideos = false;
        if (page.items.isEmpty()) {
          hasMoreVideos = false;
          if (pendingAutoAdvanceIndex == index) {
            pendingAutoAdvanceIndex = -1;
            hideStatus();
            advanceAfterEnded(index);
          }
          return;
        }
        Set<String> seen = new HashSet<>();
        for (ShortVideoItem video : videos) seen.add(video.id);
        int inserted = 0;
        for (ShortVideoItem item : page.items) {
          if (seen.contains(item.id)) continue;
          seen.add(item.id);
          videos.add(item);
          inserted++;
        }
        nextFeedOffset = page.nextOffset();
        hasMoreVideos = page.hasMore;
        if (inserted > 0) {
          adapter.notifyItemRangeInserted(videos.size() - inserted, inserted);
          prepareAround(currentIndex);
          preparePlayersAround(currentIndex);
          if (pendingAutoAdvanceIndex == index && currentIndex == index && index + 1 < videos.size()) {
            pendingAutoAdvanceIndex = -1;
            hideStatus();
            pager.setCurrentItem(index + 1, true);
          }
        }
        Log.i(TAG, "loaded more inserted=" + inserted + " nextOffset=" + nextFeedOffset + " hasMore=" + hasMoreVideos);
      });
    });
  }

  private void confirmDeleteVideo(ShortVideoItem item, boolean group) {
    if (item == null || item.id.length() == 0) {
      showTransientStatus("没有可删除的视频记录");
      return;
    }
    String title = group ? "删除同组短视频？" : "删除这条短视频？";
    String message = (item.title.length() > 0 ? item.title : "当前短视频")
      + "\n\n"
      + (group
        ? "会删除同一个本地文件夹下的短视频记录，以及这些记录引用且未被组外引用的本地文件。"
        : "会删除资料库记录以及这条记录引用的本地视频文件。");
    AlertDialog dialog = new AlertDialog.Builder(this)
      .setTitle(title)
      .setMessage(message)
      .setNegativeButton("取消", null)
      .setPositiveButton("删除", (ignored, which) -> deleteVideo(item, group))
      .create();
    dialog.setOnDismissListener(ignored -> hideSystemBars());
    dialog.show();
  }

  private void deleteVideo(ShortVideoItem item, boolean group) {
    String url = deleteVideoUrl(item, group);
    if (url.length() == 0) {
      showTransientStatus("没有可用的删除接口");
      return;
    }
    showStatus(group ? "正在删除同组短视频" : "正在删除短视频");
    executor.execute(() -> {
      try {
        DeleteResult result = requestDeleteVideo(url, item);
        mainHandler.post(() -> applyDeleteResult(item, result, group));
      } catch (Exception error) {
        String message = error.getMessage() == null || error.getMessage().length() == 0 ? "短视频删除失败" : error.getMessage();
        mainHandler.post(() -> showTransientStatus(message));
      }
    });
  }

  private DeleteResult requestDeleteVideo(String url, ShortVideoItem item) throws Exception {
    HttpURLConnection connection = null;
    try {
      connection = (HttpURLConnection) new URL(url).openConnection();
      connection.setRequestMethod("DELETE");
      connection.setConnectTimeout(8000);
      connection.setReadTimeout(16000);
      connection.setRequestProperty("Accept", "application/json");
      connection.connect();
      int status = connection.getResponseCode();
      String body = readConnectionBody(connection, status >= 200 && status < 300);
      JSONObject data = body.length() > 0 ? new JSONObject(body) : new JSONObject();
      if (status < 200 || status >= 300) {
        String message = data.optString("error", "");
        throw new Exception(message.length() > 0 ? message : "短视频删除失败");
      }
      return DeleteResult.fromJson(data, item);
    } finally {
      if (connection != null) connection.disconnect();
    }
  }

  private String readConnectionBody(HttpURLConnection connection, boolean success) {
    try (InputStream input = success ? connection.getInputStream() : connection.getErrorStream()) {
      if (input == null) return "";
      StringBuilder builder = new StringBuilder();
      byte[] buffer = new byte[8192];
      int read;
      while ((read = input.read(buffer)) >= 0) {
        builder.append(new String(buffer, 0, read, StandardCharsets.UTF_8));
      }
      return builder.toString();
    } catch (Exception ignored) {
      return "";
    }
  }

  private void applyDeleteResult(ShortVideoItem seed, DeleteResult result, boolean group) {
    Set<String> ids = result.ids;
    if (ids.isEmpty() && seed.id.length() > 0) ids.add(seed.id);
    if (ids.isEmpty()) {
      showTransientStatus("删除完成");
      return;
    }

    List<ShortVideoItem> before = new ArrayList<>(videos);
    int oldIndex = currentIndex >= 0 ? currentIndex : (pager == null ? 0 : pager.getCurrentItem());
    ShortVideoItem target = nextVideoAfterDelete(before, ids, oldIndex);

    releaseAllPlayers();
    attachedHolders.clear();
    pendingAutoAdvanceIndex = -1;
    loadingMoreVideos = false;
    likedVideoKeys.removeAll(ids);
    collectedVideoKeys.removeAll(ids);
    persistVideoInteractionKeys(PREF_LIKED_VIDEO_KEYS, likedVideoKeys);
    persistVideoInteractionKeys(PREF_COLLECTED_VIDEO_KEYS, collectedVideoKeys);
    videos.clear();
    for (ShortVideoItem item : before) {
      if (!ids.contains(item.id)) videos.add(item);
    }
    purgeDeletedFromNavigationStack(ids);
    adapter.notifyDataSetChanged();

    int deletedCount = Math.max(result.count, before.size() - videos.size());
    String message = group
      ? "已删除 " + Math.max(1, deletedCount) + " 条"
      : "已删除";
    if (result.deletedFiles > 0) message += "，" + result.deletedFiles + " 个文件";

    if (videos.isEmpty()) {
      currentIndex = -1;
      currentScreen = captureFeedScreen();
      if (hasMoreVideos && pendingFeedUrl != null && pendingFeedUrl.trim().length() > 0) {
        nextFeedOffset = 0;
        showStatus("正在读取下一批短视频");
        loadFeedAsync(pendingFeedUrl, 0);
      } else {
        showTransientStatus(message);
      }
      return;
    }

    int targetIndex = target == null ? Math.max(0, Math.min(oldIndex, videos.size() - 1)) : findVideoIndex(videos, target.id);
    if (targetIndex < 0) targetIndex = Math.max(0, Math.min(oldIndex, videos.size() - 1));
    currentScreen = captureFeedScreen();
    startPlaybackAt(targetIndex);
    showTransientStatus(message);
  }

  @Nullable
  private ShortVideoItem nextVideoAfterDelete(List<ShortVideoItem> source, Set<String> deletedIds, int oldIndex) {
    int start = Math.max(0, Math.min(oldIndex, source.size() - 1));
    for (int i = start + 1; i < source.size(); i++) {
      ShortVideoItem item = source.get(i);
      if (!deletedIds.contains(item.id)) return item;
    }
    for (int i = start - 1; i >= 0; i--) {
      ShortVideoItem item = source.get(i);
      if (!deletedIds.contains(item.id)) return item;
    }
    return null;
  }

  private void purgeDeletedFromNavigationStack(Set<String> deletedIds) {
    if (deletedIds.isEmpty()) return;
    for (ScreenState screen : navigationStack) purgeDeletedFromScreen(screen, deletedIds);
    purgeDeletedFromScreen(currentScreen, deletedIds);
  }

  private void purgeDeletedFromScreen(@Nullable ScreenState screen, Set<String> deletedIds) {
    if (screen instanceof FeedScreenState) {
      ((FeedScreenState) screen).items.removeIf(item -> deletedIds.contains(item.id));
    } else if (screen instanceof AuthorScreenState) {
      AuthorScreenState authorScreen = (AuthorScreenState) screen;
      if (authorScreen.page != null) authorScreen.page.items.removeIf(item -> deletedIds.contains(item.id));
      if (authorScreen.currentItem != null && deletedIds.contains(authorScreen.currentItem.id)) {
        authorScreen.currentItem = authorScreen.page != null && !authorScreen.page.items.isEmpty()
          ? authorScreen.page.items.get(0)
          : authorScreen.seed;
      }
    }
  }

  private String deleteVideoUrl(ShortVideoItem item, boolean group) {
    if (item == null || item.id.length() == 0) return "";
    String base = apiBase();
    if (base.length() == 0) base = baseFromUrl(item.streamUrl);
    if (base.length() == 0) return "";
    Uri.Builder builder = Uri.parse(base).buildUpon()
      .appendPath("api")
      .appendPath("short-videos")
      .appendPath(item.id);
    if (group) builder.appendQueryParameter("scope", "group");
    return builder.build().toString();
  }

  private String apiBase() {
    String base = baseFromUrl(pendingFeedUrl);
    if (base.length() > 0) return base;
    base = baseFromUrl(apiBaseUrl);
    if (base.length() > 0) return base;
    String rawBase = apiBaseUrl == null ? "" : apiBaseUrl.trim();
    if (rawBase.startsWith("http://") || rawBase.startsWith("https://")) return rawBase.replaceAll("/$", "");
    return "";
  }

  private void prepareAround(int index) {
    for (int i = index - 3; i <= index + 6; i++) bindFrame(i);
  }

  private void schedulePrepareAround(int index, long delayMs) {
    if (pendingPrepareRunnable != null) mainHandler.removeCallbacks(pendingPrepareRunnable);
    pendingPrepareRunnable = () -> {
      pendingPrepareRunnable = null;
      framePrefetchEnabled = true;
      prepareAround(index);
    };
    mainHandler.postDelayed(pendingPrepareRunnable, delayMs);
  }

  private void bindFrame(int index) {
    if (index < 0 || index >= videos.size()) return;
    ShortVideoHolder holder = attachedHolders.get(index);
    ShortVideoItem item = videos.get(index);
    if (holder != null && applyCachedFrame(holder, item)) return;
    if (holder == null && frameCache.get(item.id) != null) return;
    if (holder != null && item.coverUrl.length() > 0) loadCover(holder, item);
    if (!pendingFrameIds.add(item.id)) return;
    executor.execute(() -> {
      try {
        Bitmap bitmap = extractFirstFrame(item.streamUrl);
        if (bitmap == null && item.coverUrl.length() > 0) bitmap = loadBitmap(item.coverUrl);
        if (bitmap == null) return;
        frameCache.put(item.id, bitmap);
        Bitmap finalBitmap = bitmap;
        mainHandler.post(() -> {
          ShortVideoHolder live = attachedHolders.get(index);
          if (live != null) live.cover.setImageBitmap(finalBitmap);
        });
      } finally {
        pendingFrameIds.remove(item.id);
      }
    });
  }

  private boolean applyCachedFrame(ShortVideoHolder holder, ShortVideoItem item) {
    Bitmap cached = frameCache.get(item.id);
    if (cached == null) return false;
    holder.cover.setImageBitmap(cached);
    return true;
  }

  private void loadCover(ShortVideoHolder holder, ShortVideoItem item) {
    executor.execute(() -> {
      Bitmap bitmap = loadBitmap(item.coverUrl);
      if (bitmap == null) return;
      mainHandler.post(() -> {
        if (attachedHolders.get(holder.index) == holder) holder.cover.setImageBitmap(bitmap);
      });
    });
  }

  private Bitmap extractFirstFrame(String url) {
    MediaMetadataRetriever retriever = new MediaMetadataRetriever();
    try {
      retriever.setDataSource(url, new HashMap<>());
      return retriever.getFrameAtTime(0, MediaMetadataRetriever.OPTION_CLOSEST_SYNC);
    } catch (Exception ignored) {
      return null;
    } finally {
      try {
        retriever.release();
      } catch (Exception ignored) {}
    }
  }

  private Bitmap loadBitmap(String url) {
    HttpURLConnection connection = null;
    try {
      connection = (HttpURLConnection) new URL(url).openConnection();
      connection.setConnectTimeout(5000);
      connection.setReadTimeout(8000);
      connection.connect();
      try (InputStream input = connection.getInputStream()) {
        return BitmapFactory.decodeStream(input);
      }
    } catch (Exception ignored) {
      return null;
    } finally {
      if (connection != null) connection.disconnect();
    }
  }

  private void readVideos() {
    String baseUrl = getIntent().getStringExtra(EXTRA_BASE_URL);
    String json = getIntent().getStringExtra(EXTRA_VIDEOS_JSON);
    if (json == null) return;
    try {
      JSONArray array = new JSONArray(json);
      for (int i = 0; i < array.length(); i++) {
        ShortVideoItem item = itemFromJson(array.optJSONObject(i), baseUrl, String.valueOf(i));
        if (item != null) videos.add(item);
      }
    } catch (Exception ignored) {}
  }

  private ShortVideoItem itemFromJson(JSONObject row, String baseUrl, String fallbackId) {
    if (row == null) return null;
    String streamUrl = absoluteUrl(baseUrl, row.optString("streamUrl", ""));
    if (streamUrl.length() == 0) return null;
    JSONObject author = row.optJSONObject("author");
    JSONObject stats = row.optJSONObject("stats");
    return new ShortVideoItem(
      row.optString("id", fallbackId),
      row.optString("awemeId", ""),
      streamUrl,
      absoluteUrl(baseUrl, row.optString("coverUrl", "")),
      row.optString("title", ""),
      author == null ? "" : author.optString("name", ""),
      author == null ? "" : author.optString("secUid", ""),
      author == null ? "" : author.optString("uid", ""),
      absoluteUrl(baseUrl, author == null ? "" : author.optString("avatarUrl", "")),
      author == null ? "" : author.optString("profileUrl", ""),
      author == null ? "" : author.optString("uniqueId", ""),
      author == null ? "" : author.optString("shortId", ""),
      author == null ? "" : author.optString("signature", ""),
      author == null ? "" : author.optString("ipLocation", ""),
      author == null ? 0 : author.optLong("followerCount", 0),
      author == null ? 0 : author.optLong("followingCount", 0),
      author == null ? 0 : author.optLong("totalFavorited", 0),
      author == null ? 0 : author.optLong("awemeCount", 0),
      author == null ? 0 : author.optLong("favoritingCount", 0),
      author == null ? 0 : author.optInt("gender", 0),
      author == null ? 0 : author.optInt("age", 0),
      author == null ? "" : author.optString("verification", ""),
      author == null ? "" : author.optString("profileCollectedAt", ""),
      row.optString("publishedAt", ""),
      row.optLong("durationMs", 0),
      row.optInt("width", 0),
      row.optInt("height", 0),
      stats == null ? 0 : stats.optLong("likes", 0),
      stats == null ? 0 : stats.optLong("comments", 0),
      stats == null ? 0 : stats.optLong("collects", 0),
      stats == null ? 0 : stats.optLong("shares", 0),
      stats == null ? 0 : stats.optLong("plays", 0),
      row.optString("shareUrl", ""),
      row.optString("originalUrl", "")
    );
  }

  private void showStatus(String text) {
    if (statusView == null) return;
    statusView.setText(text);
    statusView.setVisibility(View.VISIBLE);
  }

  private void hideStatus() {
    if (statusView != null) statusView.setVisibility(View.GONE);
  }

  private void showTransientStatus(String text) {
    showStatus(text);
    mainHandler.postDelayed(this::hideStatus, 1400);
  }

  private void readControlPreferences() {
    SharedPreferences prefs = getSharedPreferences(PREFS_NAME, MODE_PRIVATE);
    muted = prefs.getBoolean(PREF_MUTED, false);
    autoNext = prefs.getBoolean(PREF_AUTO_NEXT, false);
    likedVideoKeys.clear();
    likedVideoKeys.addAll(new HashSet<>(prefs.getStringSet(PREF_LIKED_VIDEO_KEYS, Collections.emptySet())));
    collectedVideoKeys.clear();
    collectedVideoKeys.addAll(new HashSet<>(prefs.getStringSet(PREF_COLLECTED_VIDEO_KEYS, Collections.emptySet())));
    followedAuthorKeys.clear();
    followedAuthorKeys.addAll(new HashSet<>(prefs.getStringSet(PREF_FOLLOWED_AUTHOR_KEYS, Collections.emptySet())));
  }

  private void writeControlPreference(String key, boolean value) {
    getSharedPreferences(PREFS_NAME, MODE_PRIVATE).edit().putBoolean(key, value).apply();
  }

  private void persistVideoInteractionKeys(String key, Set<String> values) {
    getSharedPreferences(PREFS_NAME, MODE_PRIVATE)
      .edit()
      .putStringSet(key, new HashSet<>(values))
      .apply();
  }

  private float activeVolume() {
    return muted ? 0f : 1f;
  }

  private int activeRepeatMode() {
    return autoNext ? Player.REPEAT_MODE_OFF : Player.REPEAT_MODE_ONE;
  }

  private void toggleMuted() {
    muted = !muted;
    writeControlPreference(PREF_MUTED, muted);
    applyPlaybackControlState();
    refreshVisibleRails();
    showTransientStatus(muted ? "已静音" : "已开声");
  }

  private void toggleAutoNext() {
    autoNext = !autoNext;
    writeControlPreference(PREF_AUTO_NEXT, autoNext);
    pendingAutoAdvanceIndex = -1;
    applyPlaybackControlState();
    refreshVisibleRails();
    showTransientStatus(autoNext ? "已开启连播" : "已关闭连播");
  }

  private void applyPlaybackControlState() {
    int repeatMode = activeRepeatMode();
    for (Map.Entry<Integer, ExoPlayer> entry : playerCache.entrySet()) {
      ExoPlayer player = entry.getValue();
      player.setRepeatMode(repeatMode);
      player.setVolume(player == activePlayer ? activeVolume() : 0f);
    }
  }

  private void refreshVisibleRails() {
    for (ShortVideoHolder holder : attachedHolders.values()) {
      if (holder.index < 0 || holder.index >= videos.size()) continue;
      bindRail(holder, videos.get(holder.index));
    }
  }

  private void loadFeedAsync(String feedUrl, int startIndex) {
    String normalizedFeedUrl = normalizeFeedUrl(feedUrl);
    executor.execute(() -> {
      FeedPage page = readFeedPage(normalizedFeedUrl);
      mainHandler.post(() -> {
        videos.clear();
        videos.addAll(page.items);
        nextFeedOffset = page.nextOffset();
        hasMoreVideos = page.hasMore;
        currentScreen = captureFeedScreen();
        adapter.notifyDataSetChanged();
        if (videos.isEmpty()) showStatus("短视频读取失败");
        else startPlaybackAt(Math.max(0, Math.min(startIndex, videos.size() - 1)));
      });
    });
  }

  private String normalizeFeedUrl(String feedUrl) {
    String normalized = String.valueOf(feedUrl == null ? "" : feedUrl).replace("%26", "&");
    if (!normalized.contains("limit=")) {
      normalized += normalized.contains("?") ? "&limit=80" : "?limit=80";
    }
    return normalized;
  }

  private String pagedFeedUrl(String feedUrl, int offset, int limit) {
    Uri uri = Uri.parse(normalizeFeedUrl(feedUrl));
    Uri.Builder builder = uri.buildUpon().clearQuery();
    try {
      for (String name : uri.getQueryParameterNames()) {
        if ("offset".equals(name) || "limit".equals(name)) continue;
        List<String> values = uri.getQueryParameters(name);
        if (values.isEmpty()) builder.appendQueryParameter(name, "");
        else for (String value : values) builder.appendQueryParameter(name, value);
      }
    } catch (Exception ignored) {}
    builder.appendQueryParameter("offset", String.valueOf(Math.max(0, offset)));
    builder.appendQueryParameter("limit", String.valueOf(Math.max(1, limit)));
    return builder.build().toString();
  }

  private FeedPage readFeedPage(String feedUrl) {
    FeedPage page = new FeedPage();
    try {
      Uri uri = Uri.parse(feedUrl);
      page.offset = Math.max(0, Integer.parseInt(uri.getQueryParameter("offset") == null ? "0" : uri.getQueryParameter("offset")));
      page.limit = Math.max(1, Integer.parseInt(uri.getQueryParameter("limit") == null ? "80" : uri.getQueryParameter("limit")));
    } catch (Exception ignored) {}
    HttpURLConnection connection = null;
    try {
      connection = (HttpURLConnection) new URL(feedUrl).openConnection();
      connection.setConnectTimeout(8000);
      connection.setReadTimeout(12000);
      connection.setRequestProperty("Accept", "application/json");
      connection.connect();
      StringBuilder builder = new StringBuilder();
      try (InputStream input = connection.getInputStream()) {
        byte[] buffer = new byte[8192];
        int read;
        while ((read = input.read(buffer)) >= 0) {
          builder.append(new String(buffer, 0, read, StandardCharsets.UTF_8));
        }
      }
      JSONObject data = new JSONObject(builder.toString());
      page.offset = Math.max(0, data.optInt("offset", page.offset));
      page.limit = Math.max(1, data.optInt("limit", page.limit));
      page.total = Math.max(0, data.optInt("total", 0));
      page.stats = FeedStats.fromJson(data.optJSONObject("stats"));
      page.hasMore = data.optBoolean("hasMore", false);
      JSONArray rows = data.optJSONArray("videos");
      if (rows == null) return page;
      String baseUrl = baseFromUrl(feedUrl);
      for (int i = 0; i < rows.length(); i++) {
        ShortVideoItem item = itemFromJson(rows.optJSONObject(i), baseUrl, String.valueOf(i));
        if (item != null) page.items.add(item);
      }
      if (page.total == 0) page.total = page.items.size();
      if (page.stats.isEmpty()) page.stats = FeedStats.fromItems(page.items);
    } catch (Exception ignored) {
    } finally {
      if (connection != null) connection.disconnect();
    }
    return page;
  }

  private void showAuthorPanel(ShortVideoItem seed) {
    if (seed == null) return;
    if (seed.author.length() == 0 && seed.authorSecUid.length() == 0) {
      showStatus("这个视频没有作者信息");
      mainHandler.postDelayed(this::hideStatus, 1600);
      return;
    }
    pushCurrentScreen();
    renderAuthorScreen(new AuthorScreenState(seed, null, "works", currentFeedSort()));
  }

  private void renderAuthorScreen(AuthorScreenState screen) {
    ShortVideoItem seed = screen.seed;
    removeAuthorOverlay();
    if (activePlayer != null) {
      activePlayer.pause();
      stopProgressUpdates();
    }
    currentScreen = screen;

    FrameLayout overlay = new FrameLayout(this) {
      private float authorTouchStartX;
      private float authorTouchStartY;
      private boolean authorHorizontalGesture;
      private boolean authorTouchActive;

      @Override
      public boolean onInterceptTouchEvent(MotionEvent event) {
        if (event == null) return super.onInterceptTouchEvent(event);
        int action = event.getActionMasked();
        if (action == MotionEvent.ACTION_DOWN) {
          authorTouchStartX = event.getX();
          authorTouchStartY = event.getY();
          authorTouchActive = true;
          authorHorizontalGesture = false;
          return super.onInterceptTouchEvent(event);
        }
        if (!authorTouchActive) return super.onInterceptTouchEvent(event);
        if (action == MotionEvent.ACTION_MOVE) {
          float dx = event.getX() - authorTouchStartX;
          float dy = event.getY() - authorTouchStartY;
          if (Math.abs(dx) > dp(22) && Math.abs(dx) > Math.abs(dy) * HORIZONTAL_GESTURE_RATIO) {
            authorHorizontalGesture = true;
            return true;
          }
        }
        if (action == MotionEvent.ACTION_UP || action == MotionEvent.ACTION_CANCEL) {
          authorTouchActive = false;
          authorHorizontalGesture = false;
        }
        return super.onInterceptTouchEvent(event);
      }

      @Override
      public boolean onTouchEvent(MotionEvent event) {
        if (event == null) return true;
        int action = event.getActionMasked();
        if (action == MotionEvent.ACTION_DOWN) {
          authorTouchStartX = event.getX();
          authorTouchStartY = event.getY();
          authorTouchActive = true;
          authorHorizontalGesture = false;
          return true;
        }
        if (!authorTouchActive) return true;
        if (action == MotionEvent.ACTION_UP) {
          float dx = event.getX() - authorTouchStartX;
          float dy = event.getY() - authorTouchStartY;
          boolean horizontal = authorHorizontalGesture || (Math.abs(dx) > dp(72) && Math.abs(dx) > Math.abs(dy) * HORIZONTAL_GESTURE_RATIO);
          authorTouchActive = false;
          authorHorizontalGesture = false;
          if (horizontal) {
            if (dx > 0) navigateBack();
            return true;
          }
        }
        if (action == MotionEvent.ACTION_CANCEL) {
          authorTouchActive = false;
          authorHorizontalGesture = false;
          return true;
        }
        return true;
      }
    };
    overlay.setBackgroundColor(0xFFF7F8FA);
    overlay.setClickable(true);

    LinearLayout sheet = new LinearLayout(this);
    sheet.setOrientation(LinearLayout.VERTICAL);
    sheet.setPadding(0, 0, 0, dp(10));
    sheet.setBackgroundColor(0xFFF7F8FA);
    sheet.setClickable(true);
    FrameLayout.LayoutParams sheetParams = new FrameLayout.LayoutParams(
      ViewGroup.LayoutParams.MATCH_PARENT,
      ViewGroup.LayoutParams.MATCH_PARENT
    );
    overlay.addView(sheet, sheetParams);

    LinearLayout top = new LinearLayout(this);
    top.setOrientation(LinearLayout.HORIZONTAL);
    top.setGravity(Gravity.CENTER_VERTICAL);
    top.setPadding(dp(10), dp(4), dp(10), 0);
    TextView close = iconText("‹", 34, Color.TRANSPARENT);
    close.setTextColor(0xFF161823);
    close.setContentDescription("返回");
    close.setOnClickListener(view -> navigateBack());
    top.addView(close, new LinearLayout.LayoutParams(dp(42), dp(42)));
    TextView title = new TextView(this);
    title.setText("主页");
    title.setTextColor(0xFF161823);
    title.setTextSize(15);
    title.setTypeface(Typeface.DEFAULT_BOLD);
    title.setGravity(Gravity.CENTER_VERTICAL);
    LinearLayout.LayoutParams titleParams = new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f);
    top.addView(title, titleParams);
    sheet.addView(top, new LinearLayout.LayoutParams(
      ViewGroup.LayoutParams.MATCH_PARENT,
      ViewGroup.LayoutParams.WRAP_CONTENT
    ));

    FrameLayout hero = new FrameLayout(this);
    hero.setBackgroundColor(0xFF383B42);
    ImageView heroCover = new ImageView(this);
    heroCover.setScaleType(ImageView.ScaleType.CENTER_CROP);
    heroCover.setBackgroundColor(0xFF383B42);
    hero.addView(heroCover, new FrameLayout.LayoutParams(
      ViewGroup.LayoutParams.MATCH_PARENT,
      ViewGroup.LayoutParams.MATCH_PARENT
    ));
    String heroImageUrl = seed.coverUrl.length() > 0 ? seed.coverUrl : seed.authorAvatarUrl;
    if (heroImageUrl.length() > 0) {
      loadImageInto(heroCover, heroImageUrl, "author-hero:" + authorInteractionKey(seed));
    }
    View heroScrim = new View(this);
    heroScrim.setBackgroundColor(0x66000000);
    hero.addView(heroScrim, new FrameLayout.LayoutParams(
      ViewGroup.LayoutParams.MATCH_PARENT,
      ViewGroup.LayoutParams.MATCH_PARENT
    ));

    LinearLayout heroIdentity = new LinearLayout(this);
    heroIdentity.setOrientation(LinearLayout.HORIZONTAL);
    heroIdentity.setGravity(Gravity.BOTTOM);
    heroIdentity.setPadding(dp(16), dp(10), dp(16), dp(14));
    FrameLayout heroAvatarShell = new FrameLayout(this);
    heroAvatarShell.setBackground(circleDrawable(Color.WHITE));
    heroAvatarShell.addView(authorAvatarView(seed, dp(72)), new FrameLayout.LayoutParams(dp(72), dp(72), Gravity.CENTER));
    heroIdentity.addView(heroAvatarShell, new LinearLayout.LayoutParams(dp(78), dp(78)));
    LinearLayout heroInfo = new LinearLayout(this);
    heroInfo.setOrientation(LinearLayout.VERTICAL);
    heroInfo.setGravity(Gravity.BOTTOM);
    heroInfo.setPadding(dp(12), 0, 0, dp(4));
    TextView heroName = new TextView(this);
    heroName.setText(displayAuthor(seed));
    heroName.setTextColor(Color.WHITE);
    heroName.setTextSize(22);
    heroName.setTypeface(Typeface.DEFAULT_BOLD);
    heroName.setSingleLine(true);
    heroName.setEllipsize(TextUtils.TruncateAt.END);
    heroName.setShadowLayer(8, 0, 2, 0x99000000);
    TextView heroHandle = new TextView(this);
    heroHandle.setText(authorHandleText(seed));
    heroHandle.setTextColor(0xE6FFFFFF);
    heroHandle.setTextSize(12);
    heroHandle.setSingleLine(true);
    heroHandle.setEllipsize(TextUtils.TruncateAt.END);
    heroHandle.setShadowLayer(6, 0, 2, 0x99000000);
    heroInfo.addView(heroName);
    heroInfo.addView(heroHandle);
    heroIdentity.addView(heroInfo, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.MATCH_PARENT, 1f));
    hero.addView(heroIdentity, new FrameLayout.LayoutParams(
      ViewGroup.LayoutParams.MATCH_PARENT,
      ViewGroup.LayoutParams.MATCH_PARENT
    ));
    sheet.addView(hero, new LinearLayout.LayoutParams(
      ViewGroup.LayoutParams.MATCH_PARENT,
      dp(164)
    ));

    LinearLayout head = new LinearLayout(this);
    head.setOrientation(LinearLayout.VERTICAL);
    head.setPadding(dp(14), dp(8), dp(14), dp(6));

    if (seed.authorSignature.length() > 0) {
      TextView signature = new TextView(this);
      signature.setText(seed.authorSignature);
      signature.setTextColor(0xFF343840);
      signature.setTextSize(13);
      signature.setPadding(0, 0, 0, 0);
      signature.setMaxLines(3);
      head.addView(signature);
    }
    String metaText = authorMetaLineText(seed);
    if (metaText.length() > 0) {
      TextView meta = new TextView(this);
      meta.setText(metaText);
      meta.setTextColor(0xFF60646E);
      meta.setTextSize(11);
      meta.setGravity(Gravity.CENTER_VERTICAL);
      meta.setPadding(dp(7), dp(3), dp(7), dp(3));
      meta.setMaxLines(1);
      meta.setBackground(roundedDrawable(0xFFEFF1F5, dp(4)));
      LinearLayout.LayoutParams metaParams = new LinearLayout.LayoutParams(
        ViewGroup.LayoutParams.WRAP_CONTENT,
        ViewGroup.LayoutParams.WRAP_CONTENT
      );
      metaParams.topMargin = dp(6);
      head.addView(meta, metaParams);
    }
    sheet.addView(head);

    final LinearLayout profileStats = authorProfileStatsRow(seed);
    if (profileStats != null) {
      profileStats.setPadding(dp(14), dp(4), dp(14), dp(4));
      LinearLayout.LayoutParams profileStatsParams = new LinearLayout.LayoutParams(
        ViewGroup.LayoutParams.MATCH_PARENT,
        ViewGroup.LayoutParams.WRAP_CONTENT
      );
      profileStatsParams.bottomMargin = dp(8);
      sheet.addView(profileStats, profileStatsParams);
    }

    final boolean shouldLoadInitialAuthorPage = screen.page == null || screen.page.items.isEmpty();
    final FeedPage[] pageRef = new FeedPage[] { shouldLoadInitialAuthorPage ? sortedLocalAuthorPage(seed, screen.sort) : screen.page.copy() };
    final String[] activeTab = new String[] { screen.activeTab == null ? "works" : screen.activeTab };
    final Runnable[] render = new Runnable[1];
    final boolean[] profileCollapsed = new boolean[] { false };
    final Runnable[] updateAuthorChrome = new Runnable[1];

    LinearLayout actions = new LinearLayout(this);
    actions.setOrientation(LinearLayout.HORIZONTAL);
    actions.setGravity(Gravity.CENTER);
    LinearLayout.LayoutParams actionsParams = new LinearLayout.LayoutParams(
      ViewGroup.LayoutParams.MATCH_PARENT,
      dp(40)
    );
    actionsParams.leftMargin = dp(14);
    actionsParams.rightMargin = dp(14);
    actionsParams.bottomMargin = dp(6);
    sheet.addView(actions, actionsParams);

    TextView follow = authorActionButton("", true, authorInteractionKey(seed).length() > 0, null);
    follow.setOnClickListener(view -> {
      toggleFollowingAuthor(seed);
      bindFollowButton(follow, seed);
    });
    bindFollowButton(follow, seed);
    LinearLayout.LayoutParams followParams = new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.MATCH_PARENT, 1f);
    followParams.rightMargin = dp(6);
    actions.addView(follow, followParams);

    TextView filter = authorActionButton("只看 TA", false, seed.authorSecUid.length() > 0, view -> switchToAuthorFeed(screen));
    LinearLayout.LayoutParams filterParams = new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.MATCH_PARENT, 1f);
    filterParams.rightMargin = dp(6);
    actions.addView(filter, filterParams);

    String authorProfileUrl = authorOriginalUrl(seed);
    TextView douyin = authorActionButton("抖音主页", false, authorProfileUrl.length() > 0, view -> openAuthorOriginal(seed));
    actions.addView(douyin, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.MATCH_PARENT, 1f));

    LinearLayout tabBar = new LinearLayout(this);
    tabBar.setOrientation(LinearLayout.HORIZONTAL);
    tabBar.setGravity(Gravity.CENTER_VERTICAL);
    tabBar.setPadding(dp(14), 0, dp(14), 0);
    LinearLayout tabs = new LinearLayout(this);
    tabs.setOrientation(LinearLayout.HORIZONTAL);
    tabs.setGravity(Gravity.CENTER);
    tabBar.addView(tabs, new LinearLayout.LayoutParams(0, dp(38), 1f));

    TextView sortButton = authorActionButton("\u21c5 " + authorSortLabel(screen.sort), false, true, view -> showAuthorSortDialog(screen, pageRef, activeTab, render));
    sortButton.setTextSize(12);
    LinearLayout.LayoutParams sortParams = new LinearLayout.LayoutParams(dp(108), dp(32));
    sortParams.gravity = Gravity.CENTER_VERTICAL;
    tabBar.addView(sortButton, sortParams);
    sheet.addView(tabBar, new LinearLayout.LayoutParams(
      ViewGroup.LayoutParams.MATCH_PARENT,
      dp(40)
    ));

    updateAuthorChrome[0] = () -> {
      boolean collapsed = "works".equals(activeTab[0]) && screen.worksScrollY > dp(24);
      if (profileCollapsed[0] == collapsed) return;
      profileCollapsed[0] = collapsed;
      hero.setVisibility(collapsed ? View.GONE : View.VISIBLE);
      head.setVisibility(collapsed ? View.GONE : View.VISIBLE);
      if (profileStats != null) profileStats.setVisibility(collapsed ? View.GONE : View.VISIBLE);
      actions.setVisibility(collapsed ? View.GONE : View.VISIBLE);
      title.setText(collapsed ? displayAuthor(seed) : "主页");
    };

    FrameLayout content = new FrameLayout(this);
    sheet.addView(content, new LinearLayout.LayoutParams(
      ViewGroup.LayoutParams.MATCH_PARENT,
      0,
      1f
    ));

    render[0] = () -> {
      screen.page = pageRef[0].copy();
      screen.activeTab = activeTab[0];
      currentScreen = screen;
      sortButton.setText("\u21c5 " + authorSortLabel(screen.sort));
      int worksTotal = Math.max(pageRef[0].total, pageRef[0].items.size());
      renderAuthorTabs(tabs, activeTab[0], worksTotal, nextTab -> {
        activeTab[0] = nextTab;
        screen.activeTab = nextTab;
        render[0].run();
      });
      content.removeAllViews();
      content.addView(authorTabContent(screen, pageRef[0], activeTab[0], () -> loadMoreAuthorPage(screen, pageRef, render), updateAuthorChrome[0]), new FrameLayout.LayoutParams(
        ViewGroup.LayoutParams.MATCH_PARENT,
        ViewGroup.LayoutParams.MATCH_PARENT
      ));
      updateAuthorChrome[0].run();
    };
    render[0].run();

    rootView.addView(overlay, new FrameLayout.LayoutParams(
      ViewGroup.LayoutParams.MATCH_PARENT,
      ViewGroup.LayoutParams.MATCH_PARENT
    ));
    authorOverlay = overlay;

    String authorUrl = authorFeedUrl(seed, 0, 60, screen.sort);
    if (shouldLoadInitialAuthorPage && authorUrl.length() > 0) {
      executor.execute(() -> {
        FeedPage loaded = readFeedPage(authorUrl);
        if (loaded.items.isEmpty()) return;
        mainHandler.post(() -> {
          if (authorOverlay != overlay) return;
          pageRef[0] = loaded;
          screen.page = loaded.copy();
          render[0].run();
        });
      });
    }
  }

  private void removeAuthorOverlay() {
    if (authorOverlay != null) {
      rootView.removeView(authorOverlay);
      authorOverlay = null;
    }
    hideSystemBars();
  }

  private TextView authorActionButton(String label, boolean primary, boolean enabled, View.OnClickListener listener) {
    TextView view = new TextView(this);
    view.setText(label);
    view.setTextColor(primary ? Color.WHITE : 0xFF161823);
    view.setTextSize(14);
    view.setTypeface(Typeface.DEFAULT_BOLD);
    view.setGravity(Gravity.CENTER);
    view.setEnabled(enabled);
    view.setAlpha(enabled ? 1f : 0.52f);
    view.setBackground(roundedDrawable(primary ? 0xFFFE2C55 : 0xFFEFF1F5, dp(8)));
    view.setOnClickListener(listener);
    return view;
  }

  private String authorOriginalUrl(ShortVideoItem item) {
    if (item == null) return "";
    String profileUrl = item.authorProfileUrl.trim();
    if (profileUrl.startsWith("http://") || profileUrl.startsWith("https://")) return profileUrl;
    return item.authorSecUid.length() > 0 ? "https://www.douyin.com/user/" + Uri.encode(item.authorSecUid) : "";
  }

  private void openAuthorOriginal(ShortVideoItem item) {
    String url = authorOriginalUrl(item);
    if (url.length() == 0) {
      showTransientStatus("没有作者主页");
      return;
    }
    try {
      startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url)));
    } catch (Exception error) {
      showTransientStatus("无法打开作者主页");
    }
  }

  private void showAuthorSortDialog(AuthorScreenState screen, FeedPage[] pageRef, String[] activeTab, Runnable[] render) {
    String[] labels = new String[] { "时间倒序", "时间正序", "最近点赞", "点赞最多", "点赞最少", "评论最多", "时长最长" };
    String[] values = new String[] { "published", "publishedAsc", "liked", "likes", "likesAsc", "comments", "duration" };
    int checked = 0;
    for (int i = 0; i < values.length; i++) {
      if (values[i].equals(screen.sort)) {
        checked = i;
        break;
      }
    }
    AlertDialog dialog = new AlertDialog.Builder(this)
      .setTitle("作者作品排序")
      .setSingleChoiceItems(labels, checked, (choice, which) -> {
        choice.dismiss();
        if (which < 0 || which >= values.length || values[which].equals(screen.sort)) return;
        applyAuthorSort(screen, pageRef, activeTab, render, values[which]);
      })
      .setNegativeButton("取消", null)
      .create();
    dialog.setOnDismissListener(ignored -> hideSystemBars());
    dialog.show();
  }

  private void applyAuthorSort(AuthorScreenState screen, FeedPage[] pageRef, String[] activeTab, Runnable[] render, String sort) {
    screen.sort = normalizeSortParam(sort);
    screen.worksScrollY = 0;
    activeTab[0] = "works";
    screen.activeTab = "works";
    String url = authorFeedUrl(screen.seed, 0, 60, screen.sort);
    if (url.length() == 0) {
      pageRef[0] = sortedLocalAuthorPage(screen.seed, screen.sort);
      if (render[0] != null) render[0].run();
      return;
    }
    showStatus("正在按" + authorSortLabel(screen.sort) + "排序");
    executor.execute(() -> {
      FeedPage loaded = readFeedPage(url);
      mainHandler.post(() -> {
        hideStatus();
        if (loaded.items.isEmpty()) pageRef[0] = sortedLocalAuthorPage(screen.seed, screen.sort);
        else pageRef[0] = loaded;
        screen.page = pageRef[0].copy();
        if (render[0] != null) render[0].run();
      });
    });
  }

  private void loadMoreAuthorPage(AuthorScreenState screen, FeedPage[] pageRef, Runnable[] render) {
    FeedPage current = pageRef[0];
    if (screen.loadingMore || current == null || !current.hasMore) return;
    int offset = current.nextOffset();
    String url = authorFeedUrl(screen.seed, offset, 60, screen.sort);
    if (url.length() == 0) return;
    screen.loadingMore = true;
    Log.i(TAG, "load author more author=" + displayAuthor(screen.seed) + " offset=" + offset + " sort=" + screen.sort);
    if (render[0] != null) render[0].run();
    executor.execute(() -> {
      FeedPage loaded = readFeedPage(url);
      mainHandler.post(() -> {
        screen.loadingMore = false;
        if (!loaded.items.isEmpty()) {
          Set<String> seen = new HashSet<>();
          for (ShortVideoItem item : current.items) seen.add(item.id);
          int inserted = 0;
          for (ShortVideoItem item : loaded.items) {
            if (seen.contains(item.id)) continue;
            seen.add(item.id);
            current.items.add(item);
            inserted++;
          }
          int loadedEnd = loaded.offset + Math.max(loaded.limit, loaded.items.size());
          current.limit = Math.max(Math.max(current.limit, current.items.size()), loadedEnd - current.offset);
          current.total = Math.max(loaded.total, current.items.size());
          current.hasMore = loaded.hasMore;
          current.stats = loaded.stats == null || loaded.stats.isEmpty() ? FeedStats.fromItems(current.items) : loaded.stats;
          Log.i(TAG, "author loaded more inserted=" + inserted + " nextOffset=" + current.nextOffset() + " hasMore=" + current.hasMore);
        } else {
          current.hasMore = false;
          Log.i(TAG, "author loaded more empty offset=" + offset);
        }
        pageRef[0] = current;
        screen.page = current.copy();
        if (render[0] != null) render[0].run();
      });
    });
  }

  private String authorSortLabel(String sort) {
    switch (normalizeSortParam(sort)) {
      case "publishedAsc": return "时间正序";
      case "liked": return "最近点赞";
      case "likes": return "点赞最多";
      case "likesAsc": return "点赞最少";
      case "comments": return "评论最多";
      case "duration": return "时长最长";
      default: return "时间倒序";
    }
  }

  private FeedPage localAuthorPage(ShortVideoItem seed) {
    FeedPage page = new FeedPage();
    for (ShortVideoItem item : videos) {
      if (!sameAuthor(seed, item)) continue;
      page.items.add(item);
    }
    if (page.items.isEmpty()) page.items.add(seed);
    page.total = page.items.size();
    page.limit = page.items.size();
    page.hasMore = false;
    page.stats = FeedStats.fromItems(page.items);
    return page;
  }

  private FeedPage sortedLocalAuthorPage(ShortVideoItem seed, String sort) {
    FeedPage page = localAuthorPage(seed);
    sortAuthorItems(page.items, sort);
    page.stats = FeedStats.fromItems(page.items);
    return page;
  }

  private void sortAuthorItems(List<ShortVideoItem> items, String sort) {
    sortShortVideoItems(items, sort);
  }

  private void sortShortVideoItems(List<ShortVideoItem> items, String sort) {
    Collections.sort(items, (left, right) -> {
      switch (normalizeSortParam(sort)) {
        case "publishedAsc":
          return left.publishedAt.compareTo(right.publishedAt);
        case "liked":
        case "published":
          return right.publishedAt.compareTo(left.publishedAt);
        case "likesAsc":
          return Long.compare(left.likes, right.likes);
        case "likes":
          return Long.compare(right.likes, left.likes);
        case "comments":
          return Long.compare(right.comments, left.comments);
        case "duration":
          return Long.compare(right.durationMs, left.durationMs);
        default:
          return right.publishedAt.compareTo(left.publishedAt);
      }
    });
  }


  private boolean sameAuthor(ShortVideoItem left, ShortVideoItem right) {
    if (left == null || right == null) return false;
    if (left.authorSecUid.length() > 0 && right.authorSecUid.length() > 0) {
      return left.authorSecUid.equals(right.authorSecUid);
    }
    return left.author.length() > 0 && left.author.equals(right.author);
  }

  private boolean isSameVideo(ShortVideoItem left, ShortVideoItem right) {
    if (left == null || right == null) return false;
    if (left.id.length() > 0 && right.id.length() > 0 && left.id.equals(right.id)) return true;
    return left.awemeId.length() > 0 && right.awemeId.length() > 0 && left.awemeId.equals(right.awemeId);
  }

  private String authorHandleText(ShortVideoItem item) {
    String handle = item.authorShortId.length() > 0 ? item.authorShortId : item.authorUniqueId;
    if (handle.length() > 0) return "抖音号 " + handle;
    if (item.authorSecUid.length() > 0) return "抖音作者";
    return "本地作者";
  }

  private String authorMetaLineText(ShortVideoItem item) {
    List<String> parts = new ArrayList<>();
    String location = item.authorIpLocation.replaceFirst("^IP属地[:：]?\\s*", "").trim();
    if (location.length() > 0) parts.add("IP属地 " + location);
    if (item.authorAge > 0) parts.add(item.authorAge + "岁");
    if (item.authorVerification.length() > 0) parts.add(item.authorVerification);
    return joinParts(parts);
  }

  private LinearLayout authorProfileStatsRow(ShortVideoItem item) {
    LinearLayout row = new LinearLayout(this);
    row.setOrientation(LinearLayout.HORIZONTAL);
    row.setGravity(Gravity.CENTER);
    row.setPadding(0, dp(4), 0, dp(4));
    addAuthorProfileStat(row, "获赞", item.authorTotalFavorited);
    addAuthorProfileStat(row, "关注", item.authorFollowingCount);
    addAuthorProfileStat(row, "粉丝", item.authorFollowerCount);
    return row;
  }

  private void addAuthorProfileStat(LinearLayout row, String label, long value) {
    LinearLayout cell = new LinearLayout(this);
    cell.setOrientation(LinearLayout.HORIZONTAL);
    cell.setGravity(Gravity.CENTER);
    TextView strong = new TextView(this);
    strong.setText(compact(Math.max(0, value)));
    strong.setTextColor(0xFF161823);
    strong.setTextSize(17);
    strong.setTypeface(Typeface.DEFAULT_BOLD);
    strong.setGravity(Gravity.CENTER);
    TextView small = new TextView(this);
    small.setText(label);
    small.setTextColor(0xFF8A8F99);
    small.setTextSize(11);
    small.setGravity(Gravity.CENTER);
    small.setPadding(dp(4), 0, 0, 0);
    cell.addView(strong);
    cell.addView(small);
    row.addView(cell, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));
  }

  private String joinParts(List<String> parts) {
    StringBuilder builder = new StringBuilder();
    for (String part : parts) {
      if (part == null || part.length() == 0) continue;
      if (builder.length() > 0) builder.append(" · ");
      builder.append(part);
    }
    return builder.toString();
  }

  private void renderAuthorStats(LinearLayout statsRow, FeedPage page) {
    statsRow.removeAllViews();
    FeedStats stats = page.stats == null ? FeedStats.fromItems(page.items) : page.stats;
    int total = Math.max(page.total, page.items.size());
    for (String[] item : new String[][] {
      { compact(total), "作品" },
      { compact(stats.likes), "点赞" },
      { compact(stats.comments), "评论" },
      { compact(stats.collects), "收藏" }
    }) {
      LinearLayout cell = new LinearLayout(this);
      cell.setOrientation(LinearLayout.VERTICAL);
      cell.setGravity(Gravity.CENTER);
      TextView value = new TextView(this);
      value.setText(item[0]);
      value.setTextColor(0xFF161823);
      value.setTextSize(17);
      value.setTypeface(Typeface.DEFAULT_BOLD);
      value.setGravity(Gravity.CENTER);
      TextView label = new TextView(this);
      label.setText(item[1]);
      label.setTextColor(0xFF8A8F99);
      label.setTextSize(11);
      label.setGravity(Gravity.CENTER);
      cell.addView(value);
      cell.addView(label);
      statsRow.addView(cell, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));
    }
  }

  private void renderAuthorTabs(LinearLayout tabs, String activeTab, int worksTotal, AuthorTabCallback callback) {
    tabs.removeAllViews();
    String worksLabel = worksTotal > 0 ? "作品 " + compact(worksTotal) : "作品";
    tabs.addView(authorTabButton(worksLabel, "works", activeTab, callback), new LinearLayout.LayoutParams(0, dp(38), 1f));
    tabs.addView(authorTabButton("数据", "stats", activeTab, callback), new LinearLayout.LayoutParams(0, dp(38), 1f));
  }

  private TextView authorTabButton(String label, String value, String activeTab, AuthorTabCallback callback) {
    boolean active = value.equals(activeTab);
    TextView button = new TextView(this);
    button.setText(label);
    button.setTextColor(active ? 0xFF161823 : 0xFF8A8F99);
    button.setTextSize(15);
    button.setTypeface(Typeface.DEFAULT_BOLD);
    button.setGravity(Gravity.CENTER);
    button.setBackgroundColor(Color.TRANSPARENT);
    if (active) button.setPaintFlags(button.getPaintFlags() | android.graphics.Paint.UNDERLINE_TEXT_FLAG);
    else button.setPaintFlags(button.getPaintFlags() & ~android.graphics.Paint.UNDERLINE_TEXT_FLAG);
    button.setOnClickListener(view -> callback.onTab(value));
    return button;
  }

  private View authorTabContent(AuthorScreenState screen, FeedPage page, String tab, Runnable loadMore, @Nullable Runnable onAuthorScroll) {
    if ("stats".equals(tab)) return authorStatsContent(currentAuthorItem(screen), page);
    return authorWorksContent(screen, page, loadMore, onAuthorScroll);
  }

  private View authorWorksContent(AuthorScreenState screen, FeedPage page, Runnable loadMore, @Nullable Runnable onAuthorScroll) {
    ScrollView scroll = new ScrollView(this);
    scroll.setFillViewport(false);
    scroll.setVerticalScrollBarEnabled(false);
    scroll.setOverScrollMode(View.OVER_SCROLL_NEVER);
    scroll.setBackgroundColor(0xFFF7F8FA);
    LinearLayout wrap = new LinearLayout(this);
    wrap.setOrientation(LinearLayout.VERTICAL);
    GridLayout grid = new GridLayout(this);
    grid.setColumnCount(3);
    grid.setPadding(0, dp(6), 0, dp(8));
    int screenWidth = getResources().getDisplayMetrics().widthPixels;
    int tileWidth = Math.max(dp(92), (screenWidth - dp(34)) / 3);
    if (page.items.isEmpty()) {
      TextView empty = emptyPanel("没有本地作品");
      wrap.addView(empty, new LinearLayout.LayoutParams(
        ViewGroup.LayoutParams.MATCH_PARENT,
        ViewGroup.LayoutParams.WRAP_CONTENT
      ));
      scroll.addView(wrap, new ScrollView.LayoutParams(
        ViewGroup.LayoutParams.MATCH_PARENT,
        ViewGroup.LayoutParams.WRAP_CONTENT
      ));
      return scroll;
    }
    for (ShortVideoItem item : page.items) {
      grid.addView(authorVideoTile(item, tileWidth, page, screen));
    }
    wrap.addView(grid, new LinearLayout.LayoutParams(
      ViewGroup.LayoutParams.MATCH_PARENT,
      ViewGroup.LayoutParams.WRAP_CONTENT
    ));
    if (page.hasMore) {
      TextView more = emptyPanel(screen.loadingMore ? "正在加载更多作品" : "继续下滑加载更多");
      more.setMinHeight(dp(72));
      wrap.addView(more, new LinearLayout.LayoutParams(
        ViewGroup.LayoutParams.MATCH_PARENT,
        ViewGroup.LayoutParams.WRAP_CONTENT
      ));
    }
    scroll.addView(wrap, new ScrollView.LayoutParams(
      ViewGroup.LayoutParams.MATCH_PARENT,
      ViewGroup.LayoutParams.WRAP_CONTENT
    ));
    scroll.setOnScrollChangeListener((view, scrollX, scrollY, oldScrollX, oldScrollY) -> {
      screen.worksScrollY = Math.max(0, scrollY);
      if (onAuthorScroll != null) onAuthorScroll.run();
      if (!page.hasMore || screen.loadingMore || loadMore == null) return;
      View child = scroll.getChildAt(0);
      if (child == null) return;
      int remaining = child.getBottom() - (scroll.getHeight() + scrollY);
      if (remaining < dp(260)) loadMore.run();
    });
    scroll.post(() -> {
      if (screen.worksScrollY > 0) scroll.scrollTo(0, screen.worksScrollY);
      if (onAuthorScroll != null) onAuthorScroll.run();
      if (!page.hasMore || screen.loadingMore || loadMore == null) return;
      View child = scroll.getChildAt(0);
      if (child != null && child.getHeight() <= scroll.getHeight() + dp(80)) loadMore.run();
    });
    return scroll;
  }

  private View authorStatsContent(ShortVideoItem seed, FeedPage page) {
    ScrollView scroll = new ScrollView(this);
    scroll.setVerticalScrollBarEnabled(false);
    scroll.setOverScrollMode(View.OVER_SCROLL_NEVER);
    scroll.setBackgroundColor(0xFFF7F8FA);
    LinearLayout wrap = new LinearLayout(this);
    wrap.setOrientation(LinearLayout.VERTICAL);
    wrap.setPadding(0, dp(10), 0, dp(24));
    FeedStats stats = page.stats == null ? FeedStats.fromItems(page.items) : page.stats;
    int total = Math.max(page.total, page.items.size());
    wrap.addView(statRow("本地作品", compact(total)));
    wrap.addView(statRow("累计点赞", compact(stats.likes)));
    wrap.addView(statRow("累计评论", compact(stats.comments)));
    wrap.addView(statRow("累计收藏", compact(stats.collects)));
    wrap.addView(statRow("累计分享", compact(stats.shares)));
    if (stats.plays > 0) wrap.addView(statRow("累计播放", compact(stats.plays)));
    wrap.addView(statRow("总时长", longDuration(stats.durationMs)));
    ShortVideoItem top = topLikedVideo(page.items);
    if (top != null) wrap.addView(statRow("最高点赞", compact(top.likes) + " · " + shortTitle(top.title)));
    wrap.addView(statRow("当前视频", shortTitle(seed.title)));
    scroll.addView(wrap, new ScrollView.LayoutParams(
      ViewGroup.LayoutParams.MATCH_PARENT,
      ViewGroup.LayoutParams.WRAP_CONTENT
    ));
    return scroll;
  }

  private View authorVideoTile(ShortVideoItem item, int width, FeedPage page, AuthorScreenState screen) {
    boolean current = isSameVideo(item, currentAuthorItem(screen));
    LinearLayout tile = new LinearLayout(this);
    tile.setOrientation(LinearLayout.VERTICAL);
    tile.setPadding(dp(1), dp(1), dp(1), dp(2));
    tile.setClickable(true);
    tile.setBackgroundColor(Color.TRANSPARENT);
    tile.setOnClickListener(view -> {
      if (current) {
        showTransientStatus("正在观看这条");
        return;
      }
      openAuthorVideo(item, page, screen);
    });
    GridLayout.LayoutParams params = new GridLayout.LayoutParams();
    params.width = width;
    params.height = ViewGroup.LayoutParams.WRAP_CONTENT;
    tile.setLayoutParams(params);

    FrameLayout media = new FrameLayout(this);
    media.setBackgroundColor(0xFFE9ECF1);
    ImageView cover = new ImageView(this);
    cover.setScaleType(ImageView.ScaleType.CENTER_CROP);
    media.addView(cover, new FrameLayout.LayoutParams(
      ViewGroup.LayoutParams.MATCH_PARENT,
      ViewGroup.LayoutParams.MATCH_PARENT
    ));
    if (item.coverUrl.length() > 0) {
      loadImageInto(cover, item.coverUrl, "cover:" + item.id);
    } else {
      cover.setImageBitmap(frameCache.get(item.id));
    }
    TextView badge = new TextView(this);
    badge.setText("♥ " + compact(item.likes));
    badge.setTextColor(Color.WHITE);
    badge.setTextSize(11);
    badge.setTypeface(Typeface.DEFAULT_BOLD);
    badge.setPadding(dp(6), dp(3), dp(6), dp(3));
    badge.setBackground(roundedDrawable(0x99000000, dp(8)));
    FrameLayout.LayoutParams badgeParams = new FrameLayout.LayoutParams(
      ViewGroup.LayoutParams.WRAP_CONTENT,
      ViewGroup.LayoutParams.WRAP_CONTENT,
      Gravity.LEFT | Gravity.BOTTOM
    );
    badgeParams.leftMargin = dp(5);
    badgeParams.bottomMargin = dp(5);
    media.addView(badge, badgeParams);
    if (current) {
      TextView currentBadge = new TextView(this);
      currentBadge.setText("当前");
      currentBadge.setTextColor(Color.WHITE);
      currentBadge.setTextSize(11);
      currentBadge.setTypeface(Typeface.DEFAULT_BOLD);
      currentBadge.setPadding(dp(7), dp(3), dp(7), dp(3));
      currentBadge.setBackground(roundedDrawable(0xFFFE2C55, dp(8)));
      FrameLayout.LayoutParams currentParams = new FrameLayout.LayoutParams(
        ViewGroup.LayoutParams.WRAP_CONTENT,
        ViewGroup.LayoutParams.WRAP_CONTENT,
        Gravity.RIGHT | Gravity.TOP
      );
      currentParams.rightMargin = dp(5);
      currentParams.topMargin = dp(5);
      media.addView(currentBadge, currentParams);
    }
    tile.addView(media, new LinearLayout.LayoutParams(width - dp(2), Math.round((width - dp(2)) * 1.34f)));
    return tile;
  }

  private ShortVideoItem currentAuthorItem(AuthorScreenState screen) {
    if (screen != null && screen.currentItem != null) return screen.currentItem;
    return screen == null ? null : screen.seed;
  }

  private TextView statRow(String label, String value) {
    TextView row = new TextView(this);
    row.setText(label + "  " + value);
    row.setTextColor(0xFF161823);
    row.setTextSize(14);
    row.setTypeface(Typeface.DEFAULT_BOLD);
    row.setGravity(Gravity.CENTER_VERTICAL);
    row.setPadding(dp(12), 0, dp(12), 0);
    row.setBackground(roundedDrawable(0xFFFFFFFF, dp(8)));
    LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(
      ViewGroup.LayoutParams.MATCH_PARENT,
      dp(44)
    );
    params.bottomMargin = dp(8);
    row.setLayoutParams(params);
    return row;
  }

  private TextView emptyPanel(String text) {
    TextView empty = new TextView(this);
    empty.setText(text);
    empty.setTextColor(0xFF8A8F99);
    empty.setTextSize(14);
    empty.setGravity(Gravity.CENTER);
    empty.setTypeface(Typeface.DEFAULT_BOLD);
    empty.setMinHeight(dp(180));
    return empty;
  }

  private void openAuthorVideo(ShortVideoItem item, FeedPage page, AuthorScreenState authorScreen) {
    String url = authorFeedUrl(authorScreen.seed, 0, 80, authorScreen.sort);
    if (url.length() == 0) return;
    pushCurrentScreen();
    FeedPage feed = page.copy();
    if (feed.items.isEmpty()) feed.items.add(item);
    int target = findVideoIndex(feed.items, item.id);
    if (target < 0) {
      feed.items.add(item);
      target = feed.items.size() - 1;
    }
    renderFeedScreen(new FeedScreenState(feed.items, url, feed.nextOffset(), feed.hasMore, target));
  }

  private int findVideoIndex(List<ShortVideoItem> source, String id) {
    for (int i = 0; i < source.size(); i++) {
      if (source.get(i).id.equals(id)) return i;
    }
    return -1;
  }

  private int findVideoIndex(List<ShortVideoItem> source, ShortVideoItem target) {
    if (target == null) return -1;
    for (int i = 0; i < source.size(); i++) {
      if (isSameVideo(source.get(i), target)) return i;
    }
    return -1;
  }

  private void switchToAuthorFeed(AuthorScreenState authorScreen) {
    String url = authorFeedUrl(authorScreen.seed, 0, 80, authorScreen.sort);
    if (url.length() == 0) return;
    pushCurrentScreen();
    FeedPage feed = authorScreen.page == null ? localAuthorPage(authorScreen.seed) : authorScreen.page.copy();
    if (feed.items.isEmpty()) feed.items.add(authorScreen.seed);
    ShortVideoItem target = currentAuthorItem(authorScreen);
    int startIndex = findVideoIndex(feed.items, target);
    if (startIndex < 0 && sameAuthor(authorScreen.seed, target)) {
      feed.items.add(target);
      startIndex = feed.items.size() - 1;
    }
    renderFeedScreen(new FeedScreenState(feed.items, url, feed.nextOffset(), feed.hasMore, Math.max(0, startIndex)));
  }

  private String authorFeedUrl(ShortVideoItem seed, int offset, int limit, String sort) {
    if (seed == null || seed.authorSecUid.length() == 0) return "";
    String base = baseFromUrl(pendingFeedUrl != null && pendingFeedUrl.length() > 0 ? pendingFeedUrl : seed.streamUrl);
    if (base.length() == 0) return "";
    return Uri.parse(base + "/api/short-videos").buildUpon()
      .appendQueryParameter("author", seed.authorSecUid)
      .appendQueryParameter("source", "all")
      .appendQueryParameter("sort", normalizeSortParam(sort))
      .appendQueryParameter("facets", "0")
      .appendQueryParameter("offset", String.valueOf(Math.max(0, offset)))
      .appendQueryParameter("limit", String.valueOf(Math.max(1, limit)))
      .build()
      .toString();
  }

  private String currentFeedSort() {
    try {
      Uri uri = Uri.parse(pendingFeedUrl == null ? "" : pendingFeedUrl);
      return normalizeSortParam(uri.getQueryParameter("sort"));
    } catch (Exception ignored) {
      return "published";
    }
  }

  private String normalizeSortParam(String value) {
    String sort = value == null ? "" : value.trim();
    switch (sort) {
      case "liked":
      case "published":
      case "publishedAsc":
      case "likes":
      case "likesAsc":
      case "comments":
      case "duration":
        return sort;
      default:
        return "published";
    }
  }

  private View authorAvatarView(ShortVideoItem item, int size) {
    FrameLayout wrap = new FrameLayout(this);
    TextView fallback = new TextView(this);
    fallback.setText(initials(item.author));
    fallback.setTextColor(Color.WHITE);
    fallback.setTextSize(20);
    fallback.setTypeface(Typeface.DEFAULT_BOLD);
    fallback.setGravity(Gravity.CENTER);
    fallback.setBackground(circleDrawable(0xFF8E96A3));
    setCircleClip(fallback);
    wrap.addView(fallback, new FrameLayout.LayoutParams(size, size, Gravity.CENTER));
    if (item.authorAvatarUrl.length() > 0) {
      ImageView image = new ImageView(this);
      image.setScaleType(ImageView.ScaleType.CENTER_CROP);
      image.setBackground(circleDrawable(0xFF8E96A3));
      setCircleClip(image);
      wrap.addView(image, new FrameLayout.LayoutParams(size, size, Gravity.CENTER));
      loadImageInto(image, item.authorAvatarUrl, item.authorSecUid.length() > 0 ? "avatar:" + item.authorSecUid : item.authorAvatarUrl);
    }
    return wrap;
  }

  private void loadImageInto(ImageView image, String url, String cacheKey) {
    String key = cacheKey == null || cacheKey.length() == 0 ? url : cacheKey;
    Bitmap cached = frameCache.get(key);
    image.setTag(key);
    if (cached != null) {
      image.setImageBitmap(cached);
      return;
    }
    executor.execute(() -> {
      Bitmap bitmap = loadBitmap(url);
      if (bitmap == null) return;
      frameCache.put(key, bitmap);
      mainHandler.post(() -> {
        Object liveTag = image.getTag();
        if (liveTag != null && liveTag.equals(key)) image.setImageBitmap(bitmap);
      });
    });
  }

  private ShortVideoItem topLikedVideo(List<ShortVideoItem> items) {
    ShortVideoItem top = null;
    for (ShortVideoItem item : items) {
      if (top == null || item.likes > top.likes) top = item;
    }
    return top;
  }

  private String displayAuthor(ShortVideoItem item) {
    return item.author.length() > 0 ? item.author : "未知作者";
  }

  private String initials(String value) {
    String text = value == null ? "" : value.trim();
    if (text.length() == 0) return "?";
    return text.substring(0, Math.min(1, text.length())).toUpperCase(Locale.CHINA);
  }

  private String shortTitle(String value) {
    String text = value == null ? "" : value.trim().replaceAll("\\s+", " ");
    if (text.length() == 0) return "无标题";
    return text.length() > 24 ? text.substring(0, 24) + "..." : text;
  }

  private String longDuration(long ms) {
    long seconds = Math.max(0, ms / 1000);
    long hours = seconds / 3600;
    long minutes = (seconds % 3600) / 60;
    if (hours > 0) return hours + "小时" + minutes + "分";
    if (minutes > 0) return minutes + "分钟";
    return seconds + "秒";
  }

  private TextView iconText(String text, int textSize, int backgroundColor) {
    TextView view = new TextView(this);
    view.setText(text);
    view.setTextColor(Color.WHITE);
    view.setTextSize(textSize);
    view.setGravity(Gravity.CENTER);
    view.setTypeface(Typeface.DEFAULT_BOLD);
    view.setBackground(circleDrawable(backgroundColor));
    return view;
  }

  private GradientDrawable circleDrawable(int color) {
    GradientDrawable drawable = new GradientDrawable();
    drawable.setShape(GradientDrawable.OVAL);
    drawable.setColor(color);
    return drawable;
  }

  private GradientDrawable roundedDrawable(int color, int radius) {
    GradientDrawable drawable = new GradientDrawable();
    drawable.setColor(color);
    drawable.setCornerRadius(radius);
    return drawable;
  }

  private void setCircleClip(View view) {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.LOLLIPOP) return;
    view.setClipToOutline(true);
    view.setOutlineProvider(new ViewOutlineProvider() {
      @Override
      public void getOutline(View target, Outline outline) {
        outline.setOval(0, 0, target.getWidth(), target.getHeight());
      }
    });
  }

  private interface AuthorTabCallback {
    void onTab(String value);
  }

  private String absoluteUrl(String baseUrl, String value) {
    if (value == null || value.trim().isEmpty()) return "";
    String trimmed = value.trim();
    if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) return trimmed;
    if (baseUrl == null || baseUrl.trim().isEmpty()) return trimmed;
    Uri base = Uri.parse(baseUrl);
    return base.buildUpon().encodedPath(trimmed.startsWith("/") ? trimmed : "/" + trimmed).encodedQuery(null).fragment(null).build().toString();
  }

  private String baseFromUrl(String value) {
    try {
      Uri uri = Uri.parse(value);
      return uri.buildUpon().encodedPath("").encodedQuery(null).fragment(null).build().toString().replaceAll("/$", "");
    } catch (Exception ignored) {
      return "";
    }
  }

  private void hideSystemBars() {
    Window window = getWindow();
    if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.P) {
      WindowManager.LayoutParams attrs = window.getAttributes();
      attrs.layoutInDisplayCutoutMode = WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES;
      window.setAttributes(attrs);
    }
    if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.LOLLIPOP) {
      window.setStatusBarColor(Color.TRANSPARENT);
      window.setNavigationBarColor(Color.TRANSPARENT);
    }
    if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.R) {
      window.setDecorFitsSystemWindows(false);
      View decorView = window.peekDecorView();
      if (decorView == null) return;
      WindowInsetsController controller = decorView.getWindowInsetsController();
      if (controller != null) {
        controller.hide(WindowInsets.Type.statusBars() | WindowInsets.Type.navigationBars());
        controller.setSystemBarsBehavior(WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
      }
    } else {
      window.getDecorView().setSystemUiVisibility(
        View.SYSTEM_UI_FLAG_FULLSCREEN |
          View.SYSTEM_UI_FLAG_HIDE_NAVIGATION |
          View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY |
          View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN |
          View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION |
          View.SYSTEM_UI_FLAG_LAYOUT_STABLE
      );
    }
  }

  private int dp(int value) {
    return Math.round(value * getResources().getDisplayMetrics().density);
  }

  private String compact(long value) {
    if (value >= 10000) return String.format(Locale.CHINA, "%.1f万", value / 10000.0);
    return String.valueOf(value);
  }

  private String formatPlaybackTime(long valueMs) {
    long totalSeconds = Math.max(0, valueMs) / 1000;
    long hours = totalSeconds / 3600;
    long minutes = (totalSeconds % 3600) / 60;
    long seconds = totalSeconds % 60;
    if (hours > 0) return String.format(Locale.CHINA, "%d:%02d:%02d", hours, minutes, seconds);
    return String.format(Locale.CHINA, "%d:%02d", minutes, seconds);
  }

  private void bindRail(ShortVideoHolder holder, ShortVideoItem item) {
    holder.rail.removeAllViews();
    holder.rail.addView(authorAvatarButton(item));
    holder.rail.addView(metric(R.drawable.ic_short_heart, displayLikes(item), isLiked(item), "点赞", view -> toggleLike(item)));
    holder.rail.addView(metric(R.drawable.ic_short_comment, item.comments, false, "评论", view -> showTransientStatus("评论数据尚未导入")));
    holder.rail.addView(metric(R.drawable.ic_short_star, displayCollects(item), isCollected(item), "收藏", view -> toggleCollected(item), 0xFFFFD54F));
    holder.rail.addView(metric(R.drawable.ic_short_share, item.shares, false, "分享", view -> shareVideo(item)));
  }

  private void showPlaybackToolbar(ShortVideoItem item) {
    if (item == null) return;
    clearPendingStageTap();
    dismissPlaybackToolbar();

    final List<Runnable> toolbarActions = new ArrayList<>();
    final LinearLayout[] rowRef = new LinearLayout[1];
    FrameLayout overlay = new FrameLayout(this) {
      @Override
      public boolean dispatchTouchEvent(MotionEvent event) {
        if (event != null && event.getActionMasked() == MotionEvent.ACTION_UP) {
          LinearLayout actionRow = rowRef[0];
          if (actionRow != null) {
            float rawX = event.getRawX();
            float rawY = event.getRawY();
            for (int i = 0; i < actionRow.getChildCount() && i < toolbarActions.size(); i++) {
              View child = actionRow.getChildAt(i);
              int[] location = new int[2];
              child.getLocationOnScreen(location);
              if (rawX >= location[0] && rawX <= location[0] + child.getWidth()
                && rawY >= location[1] && rawY <= location[1] + child.getHeight()) {
                toolbarActions.get(i).run();
                return true;
              }
            }
          }
          dismissPlaybackToolbar();
        }
        return true;
      }
    };
    overlay.setClickable(true);
    overlay.setFocusable(true);
    overlay.setBackgroundColor(0x66000000);

    LinearLayout sheet = new LinearLayout(this);
    sheet.setOrientation(LinearLayout.VERTICAL);
    sheet.setPadding(dp(16), dp(10), dp(16), dp(18));
    sheet.setBackground(roundedDrawable(0xF21B1D25, dp(20)));
    sheet.setClickable(true);
    sheet.setFocusable(true);
    sheet.setOnClickListener(view -> {});

    View handle = new View(this);
    handle.setBackground(roundedDrawable(0x66FFFFFF, dp(2)));
    LinearLayout.LayoutParams handleParams = new LinearLayout.LayoutParams(dp(42), dp(4));
    handleParams.gravity = Gravity.CENTER_HORIZONTAL;
    handleParams.bottomMargin = dp(12);
    sheet.addView(handle, handleParams);

    LinearLayout row = new LinearLayout(this);
    row.setOrientation(LinearLayout.HORIZONTAL);
    row.setGravity(Gravity.CENTER);
    rowRef[0] = row;
    sheet.addView(row, new LinearLayout.LayoutParams(
      ViewGroup.LayoutParams.MATCH_PARENT,
      dp(72)
    ));

    String originalUrl = originalVideoUrl(item);
    String shareUrl = shareVideoUrl(item);
    Runnable muteAction = () -> {
      dismissPlaybackToolbar();
      toggleMuted();
    };
    toolbarActions.add(muteAction);
    row.addView(toolbarButton(muted ? "♪" : "×", muted ? "开声" : "静音", muted ? "静音中" : "有声", muted, view -> muteAction.run()));

    Runnable autoNextAction = () -> {
      dismissPlaybackToolbar();
      toggleAutoNext();
    };
    toolbarActions.add(autoNextAction);
    row.addView(toolbarButton(autoNext ? "↓" : "∞", autoNext ? "连播" : "循环", autoNext ? "下一条" : "单条", autoNext, view -> autoNextAction.run()));

    Runnable clearAction = () -> {
      dismissPlaybackToolbar();
      setControlsHidden(!controlsHidden, true);
    };
    toolbarActions.add(clearAction);
    row.addView(toolbarButton(controlsHidden ? "▣" : "□", controlsHidden ? "显示" : "清屏", controlsHidden ? "恢复" : "隐藏", controlsHidden, view -> clearAction.run()));

    Runnable moreAction = () -> {
      dismissPlaybackToolbar();
      showMoreActions(item, shareUrl, originalUrl);
    };
    toolbarActions.add(moreAction);
    row.addView(toolbarButton("⋯", "更多", "操作", false, view -> moreAction.run()));

    overlay.addView(sheet, new FrameLayout.LayoutParams(
      ViewGroup.LayoutParams.MATCH_PARENT,
      ViewGroup.LayoutParams.WRAP_CONTENT,
      Gravity.BOTTOM
    ));
    playbackToolbarOverlay = overlay;
    rootView.addView(overlay, new FrameLayout.LayoutParams(
      ViewGroup.LayoutParams.MATCH_PARENT,
      ViewGroup.LayoutParams.MATCH_PARENT
    ));
    hideSystemBars();
  }

  private void dismissPlaybackToolbar() {
    if (playbackToolbarOverlay == null || rootView == null) return;
    rootView.removeView(playbackToolbarOverlay);
    playbackToolbarOverlay = null;
    hideSystemBars();
  }

  private TextView toolbarButton(String icon, String title, String subtitle, boolean active, View.OnClickListener listener) {
    TextView view = new TextView(this);
    view.setText(icon + "\n" + title + "\n" + subtitle);
    view.setTextColor(Color.WHITE);
    view.setTextSize(12);
    view.setGravity(Gravity.CENTER);
    view.setTypeface(Typeface.DEFAULT_BOLD);
    view.setLineSpacing(dp(1), 1f);
    view.setPadding(dp(4), 0, dp(4), 0);
    view.setBackground(roundedDrawable(active ? 0xCCFE2C55 : 0xFF2A2D37, dp(14)));
    view.setClickable(true);
    view.setFocusable(true);
    view.setOnClickListener(listener);
    LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.MATCH_PARENT, 1f);
    params.leftMargin = dp(4);
    params.rightMargin = dp(4);
    view.setLayoutParams(params);
    return view;
  }

  private void showMoreActions(ShortVideoItem item, String shareUrl, String originalUrl) {
    List<String> labels = new ArrayList<>();
    List<Runnable> actions = new ArrayList<>();
    if (shareUrl.length() > 0) {
      labels.add("分享短视频");
      actions.add(() -> shareVideo(item));
    }
    if (originalUrl.length() > 0) {
      labels.add("打开抖音原视频");
      actions.add(() -> openOriginalVideo(item));
    }
    if (item.author.length() > 0 || item.authorSecUid.length() > 0) {
      labels.add("查看作者主页");
      actions.add(() -> showAuthorPanel(item));
    }
    String authorUrl = authorOriginalUrl(item);
    if (authorUrl.length() > 0) {
      labels.add("打开抖音作者页");
      actions.add(() -> openAuthorOriginal(item));
    }
    labels.add("排序作品流");
    actions.add(this::showFeedSortDialog);
    labels.add(controlsHidden ? "显示控件" : "清屏观看");
    actions.add(() -> setControlsHidden(!controlsHidden, true));
    labels.add("删除当前短视频");
    actions.add(() -> confirmDeleteVideo(item, false));
    labels.add("删除同组短视频");
    actions.add(() -> confirmDeleteVideo(item, true));
    AlertDialog dialog = new AlertDialog.Builder(this)
      .setTitle("更多操作")
      .setItems(labels.toArray(new CharSequence[0]), (ignored, which) -> {
        if (which >= 0 && which < actions.size()) actions.get(which).run();
      })
      .setNegativeButton("取消", null)
      .create();
    dialog.setOnDismissListener(ignored -> hideSystemBars());
    dialog.show();
  }

  private void showFeedSortDialog() {
    String[] labels = new String[] { "时间倒序", "时间正序", "最近点赞", "点赞最多", "点赞最少", "评论最多", "时长最长" };
    String[] values = new String[] { "published", "publishedAsc", "liked", "likes", "likesAsc", "comments", "duration" };
    String current = currentFeedSort();
    int checked = 0;
    for (int i = 0; i < values.length; i++) {
      if (values[i].equals(current)) {
        checked = i;
        break;
      }
    }
    AlertDialog dialog = new AlertDialog.Builder(this)
      .setTitle("作品流排序")
      .setSingleChoiceItems(labels, checked, (choice, which) -> {
        choice.dismiss();
        if (which < 0 || which >= values.length) return;
        applyFeedSort(values[which]);
      })
      .setNegativeButton("取消", null)
      .create();
    dialog.setOnDismissListener(ignored -> hideSystemBars());
    dialog.show();
  }

  private void applyFeedSort(String sort) {
    String normalized = normalizeSortParam(sort);
    String sortedUrl = feedUrlWithSort(pendingFeedUrl, normalized);
    if (sortedUrl.length() == 0) {
      applyLocalFeedSort(normalized, "已按" + authorSortLabel(normalized) + "本地排序");
      return;
    }
    showStatus("正在按" + authorSortLabel(normalized) + "排序");
    loadingMoreVideos = true;
    executor.execute(() -> {
      FeedPage page = readFeedPage(sortedUrl);
      mainHandler.post(() -> {
        loadingMoreVideos = false;
        if (page.items.isEmpty()) {
          applyLocalFeedSort(normalized, "已按" + authorSortLabel(normalized) + "本地排序");
          return;
        }
        replaceFeedWithPage(page, sortedUrl, 0);
        showTransientStatus("已按" + authorSortLabel(normalized) + "排序");
      });
    });
  }

  private void applyLocalFeedSort(String sort, String message) {
    if (videos.isEmpty()) {
      showTransientStatus("没有可排序的作品");
      return;
    }
    FeedPage page = new FeedPage();
    page.items.addAll(videos);
    sortShortVideoItems(page.items, sort);
    page.total = page.items.size();
    page.limit = page.items.size();
    page.offset = 0;
    page.hasMore = false;
    page.stats = FeedStats.fromItems(page.items);
    replaceFeedWithPage(page, pendingFeedUrl, 0);
    showTransientStatus(message);
  }

  private void replaceFeedWithPage(FeedPage page, String feedUrl, int startIndex) {
    releaseAllPlayers();
    attachedHolders.clear();
    loadingMoreVideos = false;
    pendingAutoAdvanceIndex = -1;
    currentIndex = -1;
    pendingPlayIndex = -1;
    pendingFeedUrl = feedUrl == null ? "" : feedUrl;
    updateTopSearchButton();
    nextFeedOffset = page.nextOffset();
    hasMoreVideos = page.hasMore;
    videos.clear();
    videos.addAll(page.items);
    currentScreen = new FeedScreenState(videos, pendingFeedUrl, nextFeedOffset, hasMoreVideos, startIndex);
    adapter.notifyDataSetChanged();
    if (videos.isEmpty()) {
      showStatus("没有可播放的短视频");
      return;
    }
    startPlaybackAt(Math.max(0, Math.min(startIndex, videos.size() - 1)));
  }

  private String feedUrlWithSort(String feedUrl, String sort) {
    String raw = feedUrl == null ? "" : feedUrl.trim();
    if (raw.length() == 0) return "";
    try {
      Uri uri = Uri.parse(normalizeFeedUrl(raw));
      Uri.Builder builder = uri.buildUpon().clearQuery();
      for (String name : uri.getQueryParameterNames()) {
        if ("offset".equals(name) || "limit".equals(name) || "sort".equals(name)) continue;
        List<String> values = uri.getQueryParameters(name);
        if (values.isEmpty()) builder.appendQueryParameter(name, "");
        else for (String value : values) builder.appendQueryParameter(name, value);
      }
      builder.appendQueryParameter("sort", normalizeSortParam(sort));
      builder.appendQueryParameter("offset", "0");
      builder.appendQueryParameter("limit", "80");
      return builder.build().toString();
    } catch (Exception ignored) {
      return "";
    }
  }

  private void showFeedSearchDialog() {
    if (loadingMoreVideos) {
      showTransientStatus("作品流正在加载");
      return;
    }
    String currentQuery = currentFeedQuery();
    ExoPlayer dialogPlayer = activePlayer;
    boolean resumeAfterDialog = dialogPlayer != null
      && dialogPlayer.getPlayWhenReady()
      && dialogPlayer.getPlaybackState() != Player.STATE_ENDED;
    if (dialogPlayer != null) dialogPlayer.pause();

    EditText input = new EditText(this);
    input.setSingleLine(true);
    input.setHint("标题、文案或作者");
    input.setText(currentQuery);
    input.setSelection(input.getText().length());
    LinearLayout inputWrap = new LinearLayout(this);
    inputWrap.setPadding(dp(20), 0, dp(20), 0);
    inputWrap.addView(input, new LinearLayout.LayoutParams(
      ViewGroup.LayoutParams.MATCH_PARENT,
      ViewGroup.LayoutParams.WRAP_CONTENT
    ));

    AlertDialog dialog = new AlertDialog.Builder(this)
      .setTitle("搜索短视频")
      .setView(inputWrap)
      .setNegativeButton("取消", null)
      .setPositiveButton("搜索", (ignored, which) -> applyFeedSearch(input.getText().toString()))
      .create();
    dialog.setOnShowListener(ignored -> {
      input.requestFocus();
      Window window = dialog.getWindow();
      if (window != null) window.setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_STATE_ALWAYS_VISIBLE);
    });
    dialog.setOnDismissListener(ignored -> {
      hideSystemBars();
      if (resumeAfterDialog
        && activityResumed
        && authorOverlay == null
        && activePlayer == dialogPlayer
        && dialogPlayer.getPlaybackState() != Player.STATE_ENDED) {
        dialogPlayer.play();
        startProgressUpdates();
      }
    });
    dialog.show();
  }

  private void applyFeedSearch(String query) {
    String normalizedQuery = query == null ? "" : query.trim();
    if (normalizedQuery.equals(currentFeedQuery())) return;
    String searchUrl = feedUrlWithQuery(pendingFeedUrl, normalizedQuery);
    if (searchUrl.length() == 0) {
      showTransientStatus("没有可用的搜索接口");
      return;
    }
    ScreenState returnScreen = captureCurrentScreen();
    showStatus(normalizedQuery.length() > 0 ? "正在搜索“" + normalizedQuery + "”" : "正在恢复全部作品");
    loadingMoreVideos = true;
    executor.execute(() -> {
      FeedPage page = readFeedPage(searchUrl);
      mainHandler.post(() -> {
        loadingMoreVideos = false;
        if (page.items.isEmpty()) {
          showTransientStatus(normalizedQuery.length() > 0 ? "没有找到相关短视频" : "没有可播放的短视频");
          return;
        }
        if (returnScreen != null) navigationStack.add(returnScreen);
        replaceFeedWithPage(page, searchUrl, 0);
        showTransientStatus(normalizedQuery.length() > 0 ? "搜索到 " + page.total + " 条" : "已恢复全部作品");
      });
    });
  }

  private String feedUrlWithQuery(String feedUrl, String query) {
    String raw = feedUrl == null ? "" : feedUrl.trim();
    if (raw.length() == 0) {
      String base = apiBase();
      if (base.length() == 0) return "";
      raw = Uri.parse(base).buildUpon().appendPath("api").appendPath("short-videos").build().toString();
    }
    try {
      Uri uri = Uri.parse(normalizeFeedUrl(raw));
      Uri.Builder builder = uri.buildUpon().clearQuery();
      for (String name : uri.getQueryParameterNames()) {
        if ("q".equals(name) || "offset".equals(name) || "limit".equals(name)) continue;
        List<String> values = uri.getQueryParameters(name);
        if (values.isEmpty()) builder.appendQueryParameter(name, "");
        else for (String value : values) builder.appendQueryParameter(name, value);
      }
      if (query != null && query.trim().length() > 0) builder.appendQueryParameter("q", query.trim());
      builder.appendQueryParameter("offset", "0");
      builder.appendQueryParameter("limit", "80");
      return builder.build().toString();
    } catch (Exception ignored) {
      return "";
    }
  }

  private String currentFeedQuery() {
    String raw = pendingFeedUrl == null ? "" : pendingFeedUrl.trim();
    if (raw.length() == 0) return "";
    try {
      String query = Uri.parse(normalizeFeedUrl(raw)).getQueryParameter("q");
      return query == null ? "" : query.trim();
    } catch (Exception ignored) {
      return "";
    }
  }

  private void updateTopSearchButton() {
    if (topSearchButton == null) return;
    String query = currentFeedQuery();
    topSearchButton.setText(query.length() > 0 ? query : "搜索");
    topSearchButton.setContentDescription(query.length() > 0 ? "当前搜索 " + query : "搜索短视频");
  }

  private View authorAvatarButton(ShortVideoItem item) {
    FrameLayout button = new FrameLayout(this);
    button.setClickable(true);
    button.setFocusable(true);
    button.setContentDescription(item.author.length() > 0 ? "查看作者 " + item.author : "查看作者");
    button.setOnClickListener(view -> showAuthorPanel(item));
    button.setClipChildren(false);
    button.setClipToPadding(false);
    button.setLayoutParams(new LinearLayout.LayoutParams(dp(64), dp(64)));

    TextView fallback = new TextView(this);
    fallback.setText(initials(item.author));
    fallback.setTextColor(Color.WHITE);
    fallback.setTextSize(17);
    fallback.setTypeface(Typeface.DEFAULT_BOLD);
    fallback.setGravity(Gravity.CENTER);
    fallback.setBackground(circleDrawable(0xFF22242D));
    setCircleClip(fallback);
    FrameLayout.LayoutParams avatarParams = new FrameLayout.LayoutParams(dp(52), dp(52), Gravity.CENTER);
    button.addView(fallback, avatarParams);

    if (item.authorAvatarUrl.length() > 0) {
      ImageView avatar = new ImageView(this);
      avatar.setScaleType(ImageView.ScaleType.CENTER_CROP);
      avatar.setBackground(circleDrawable(0xFF22242D));
      setCircleClip(avatar);
      button.addView(avatar, avatarParams);
      loadImageInto(avatar, item.authorAvatarUrl, item.authorSecUid.length() > 0 ? "avatar:" + item.authorSecUid : item.authorAvatarUrl);
    }
    if (!isFollowingAuthor(item) && authorInteractionKey(item).length() > 0) {
      TextView follow = new TextView(this);
      follow.setText("+");
      follow.setTextColor(Color.WHITE);
      follow.setTextSize(17);
      follow.setTypeface(Typeface.DEFAULT_BOLD);
      follow.setGravity(Gravity.CENTER);
      follow.setIncludeFontPadding(false);
      follow.setBackground(circleDrawable(0xFFFE2C55));
      follow.setContentDescription("关注 " + displayAuthor(item));
      follow.setOnClickListener(view -> toggleFollowingAuthor(item));
      FrameLayout.LayoutParams followParams = new FrameLayout.LayoutParams(dp(22), dp(22), Gravity.BOTTOM | Gravity.CENTER_HORIZONTAL);
      followParams.bottomMargin = dp(1);
      button.addView(follow, followParams);
    }
    return button;
  }

  private View metric(int iconResource, long value, boolean active, String label, @Nullable View.OnClickListener listener) {
    return metric(iconResource, value, active, label, listener, 0xFFFF4D6D);
  }

  private View metric(int iconResource, long value, boolean active, String label, @Nullable View.OnClickListener listener, int activeColor) {
    LinearLayout view = new LinearLayout(this);
    view.setOrientation(LinearLayout.VERTICAL);
    view.setGravity(Gravity.CENTER);
    view.setPadding(0, dp(5), 0, dp(5));
    view.setMinimumWidth(dp(56));
    view.setMinimumHeight(dp(58));

    ImageView icon = new ImageView(this);
    icon.setImageResource(iconResource);
    icon.setImageTintList(ColorStateList.valueOf(active ? activeColor : Color.WHITE));
    icon.setBackground(circleDrawable(0x2E000000));
    icon.setPadding(dp(3), dp(3), dp(3), dp(3));
    icon.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_NO);
    view.addView(icon, new LinearLayout.LayoutParams(dp(34), dp(34)));

    TextView count = new TextView(this);
    count.setText(compact(value));
    count.setTextColor(Color.WHITE);
    count.setTextSize(12);
    count.setGravity(Gravity.CENTER);
    count.setTypeface(Typeface.DEFAULT_BOLD);
    count.setShadowLayer(6, 0, 2, 0xAA000000);
    count.setIncludeFontPadding(false);
    LinearLayout.LayoutParams countParams = new LinearLayout.LayoutParams(
      ViewGroup.LayoutParams.MATCH_PARENT,
      dp(18)
    );
    countParams.topMargin = dp(1);
    view.addView(count, countParams);

    if (listener != null) {
      view.setClickable(true);
      view.setFocusable(true);
      view.setContentDescription((label == null || label.length() == 0 ? "短视频指标" : label)
        + " " + compact(value) + (active ? "，已选择" : ""));
      view.setOnClickListener(listener);
      view.setOnTouchListener((target, event) -> {
        int action = event.getActionMasked();
        if (action == MotionEvent.ACTION_DOWN) {
          clearPendingStageTap();
          target.setPressed(true);
          target.setAlpha(0.7f);
          setParentInterceptDisallowed(target, true);
          return true;
        }
        if (action == MotionEvent.ACTION_UP) {
          target.setPressed(false);
          target.setAlpha(1f);
          setParentInterceptDisallowed(target, false);
          target.performHapticFeedback(HapticFeedbackConstants.KEYBOARD_TAP);
          target.performClick();
          return true;
        }
        if (action == MotionEvent.ACTION_CANCEL) {
          target.setPressed(false);
          target.setAlpha(1f);
          setParentInterceptDisallowed(target, false);
          return true;
        }
        return true;
      });
    }
    return view;
  }

  private String originalVideoUrl(ShortVideoItem item) {
    String awemeId = item.awemeId.length() > 0 ? item.awemeId : item.id;
    if (awemeId.matches("\\d{8,}")) return "https://www.douyin.com/video/" + awemeId;
    String url = item.originalUrl.length() > 0 ? item.originalUrl : item.shareUrl;
    return url.startsWith("http://") || url.startsWith("https://") ? url : "";
  }

  private String shareVideoUrl(ShortVideoItem item) {
    String url = originalVideoUrl(item);
    if (url.length() > 0) return url;
    return item.streamUrl.startsWith("http://") || item.streamUrl.startsWith("https://") ? item.streamUrl : "";
  }

  private void openOriginalVideo(ShortVideoItem item) {
    String url = originalVideoUrl(item);
    if (url.length() == 0) {
      showTransientStatus("没有原始链接");
      return;
    }
    try {
      startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url)));
    } catch (Exception error) {
      showTransientStatus("无法打开原始链接");
    }
  }

  private void shareVideo(ShortVideoItem item) {
    String url = shareVideoUrl(item);
    if (url.length() == 0) {
      showTransientStatus("没有可分享的链接");
      return;
    }
    String title = item.title.length() > 0 ? item.title : "短视频";
    Intent intent = new Intent(Intent.ACTION_SEND);
    intent.setType("text/plain");
    intent.putExtra(Intent.EXTRA_TITLE, title);
    intent.putExtra(Intent.EXTRA_SUBJECT, title);
    intent.putExtra(Intent.EXTRA_TEXT, title + "\n" + url);
    try {
      startActivity(Intent.createChooser(intent, "分享短视频"));
    } catch (Exception error) {
      showTransientStatus("无法打开分享面板");
    }
  }

  private void bindCaption(ShortVideoHolder holder, ShortVideoItem item, View.OnLongClickListener longPress) {
    String author = item.author.length() > 0 ? item.author : "未知作者";
    String title = item.title.length() > 0 ? item.title : "未命名视频";
    holder.captionAuthor.setText("@" + author);
    holder.captionAuthor.setContentDescription("查看作者 " + author);
    holder.captionAuthor.setOnClickListener(view -> showAuthorPanel(item));
    holder.captionAuthor.setOnLongClickListener(longPress);
    holder.captionTitle.setText(title);
    holder.captionTitle.setContentDescription("视频说明");
    holder.captionTitle.setOnClickListener(view -> toggleCaptionExpanded(holder));
    holder.captionTitle.setOnLongClickListener(longPress);
    holder.captionToggle.setOnClickListener(view -> toggleCaptionExpanded(holder));
    holder.captionToggle.setOnLongClickListener(longPress);
    holder.caption.setOnLongClickListener(longPress);
    setCaptionExpanded(holder, false, false);
    holder.captionTitle.post(() -> updateCaptionExpansionAvailability(holder));
  }

  private void toggleCaptionExpanded(ShortVideoHolder holder) {
    if (holder == null || !holder.captionCanExpand) return;
    holder.caption.performHapticFeedback(HapticFeedbackConstants.KEYBOARD_TAP);
    setCaptionExpanded(holder, !holder.captionExpanded, true);
  }

  private void setCaptionExpanded(ShortVideoHolder holder, boolean expanded, boolean announce) {
    if (holder == null) return;
    holder.captionExpanded = expanded;
    holder.captionTitle.setMaxLines(expanded ? 8 : 2);
    holder.captionTitle.setEllipsize(expanded ? null : TextUtils.TruncateAt.END);
    holder.captionToggle.setText(expanded ? "收起" : "展开");
    holder.captionToggle.setContentDescription(expanded ? "收起视频说明" : "展开视频说明");
    holder.captionToggle.setVisibility(holder.captionCanExpand ? View.VISIBLE : View.GONE);
    holder.captionTitle.setContentDescription(holder.captionCanExpand
      ? (expanded ? "视频说明，点按收起" : "视频说明，点按展开")
      : "视频说明");
    if (announce) holder.caption.announceForAccessibility(expanded ? "已展开视频说明" : "已收起视频说明");
  }

  private void updateCaptionExpansionAvailability(ShortVideoHolder holder) {
    if (holder == null || holder.index < 0 || attachedHolders.get(holder.index) != holder) return;
    boolean needsExpansion = false;
    Layout layout = holder.captionTitle.getLayout();
    if (layout != null && layout.getLineCount() > 0) {
      int lastLine = layout.getLineCount() - 1;
      needsExpansion = needsExpansion || layout.getEllipsisCount(lastLine) > 0;
    }
    holder.captionCanExpand = needsExpansion;
    setCaptionExpanded(holder, false, false);
  }

  private final class ShortVideoAdapter extends RecyclerView.Adapter<ShortVideoHolder> {
    @NonNull
    @Override
    public ShortVideoHolder onCreateViewHolder(@NonNull ViewGroup parent, int viewType) {
      FrameLayout root = new FrameLayout(parent.getContext());
      root.setBackgroundColor(Color.BLACK);
      root.setClipChildren(false);
      root.setClipToPadding(false);
      root.setClickable(true);
      root.setFocusable(true);
      root.setLayoutParams(new ViewGroup.LayoutParams(
        ViewGroup.LayoutParams.MATCH_PARENT,
        ViewGroup.LayoutParams.MATCH_PARENT
      ));

      FrameLayout stage = new FrameLayout(parent.getContext());
      stage.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_NO);
      root.addView(stage, new FrameLayout.LayoutParams(
        ViewGroup.LayoutParams.MATCH_PARENT,
        ViewGroup.LayoutParams.MATCH_PARENT
      ));

      ImageView cover = new ImageView(parent.getContext());
      cover.setScaleType(ImageView.ScaleType.CENTER_CROP);
      cover.setBackgroundColor(Color.BLACK);
      cover.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_NO);
      stage.addView(cover, new FrameLayout.LayoutParams(
        ViewGroup.LayoutParams.MATCH_PARENT,
        ViewGroup.LayoutParams.MATCH_PARENT
      ));

      FrameLayout gestureLayer = new FrameLayout(parent.getContext());
      gestureLayer.setClickable(true);
      gestureLayer.setFocusable(false);
      gestureLayer.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_NO);
      root.addView(gestureLayer, new FrameLayout.LayoutParams(
        ViewGroup.LayoutParams.MATCH_PARENT,
        ViewGroup.LayoutParams.MATCH_PARENT
      ));

      ImageView playIndicator = new ImageView(parent.getContext());
      playIndicator.setImageResource(R.drawable.ic_short_play);
      playIndicator.setImageTintList(ColorStateList.valueOf(Color.WHITE));
      playIndicator.setPadding(dp(20), dp(20), dp(18), dp(20));
      playIndicator.setBackground(circleDrawable(0x73000000));
      playIndicator.setClickable(false);
      playIndicator.setFocusable(false);
      playIndicator.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_NO);
      playIndicator.setVisibility(View.GONE);
      root.addView(playIndicator, new FrameLayout.LayoutParams(dp(72), dp(72), Gravity.CENTER));

      LinearLayout caption = new LinearLayout(parent.getContext());
      caption.setOrientation(LinearLayout.VERTICAL);
      caption.setGravity(Gravity.LEFT);
      caption.setClipChildren(false);
      caption.setClipToPadding(false);

      TextView captionAuthor = new TextView(parent.getContext());
      captionAuthor.setTextColor(Color.WHITE);
      captionAuthor.setTextSize(16);
      captionAuthor.setTypeface(Typeface.DEFAULT_BOLD);
      captionAuthor.setShadowLayer(6, 0, 2, 0xAA000000);
      captionAuthor.setMinHeight(dp(48));
      captionAuthor.setGravity(Gravity.CENTER_VERTICAL);
      captionAuthor.setClickable(true);
      captionAuthor.setFocusable(true);
      caption.addView(captionAuthor, new LinearLayout.LayoutParams(
        ViewGroup.LayoutParams.MATCH_PARENT,
        ViewGroup.LayoutParams.WRAP_CONTENT
      ));

      TextView captionTitle = new TextView(parent.getContext());
      captionTitle.setTextColor(0xF2FFFFFF);
      captionTitle.setTextSize(15);
      captionTitle.setTypeface(Typeface.DEFAULT_BOLD);
      captionTitle.setLineSpacing(dp(2), 1f);
      captionTitle.setMaxLines(2);
      captionTitle.setEllipsize(TextUtils.TruncateAt.END);
      captionTitle.setShadowLayer(6, 0, 2, 0xAA000000);
      captionTitle.setMinHeight(dp(48));
      captionTitle.setClickable(true);
      captionTitle.setFocusable(true);
      caption.addView(captionTitle, new LinearLayout.LayoutParams(
        ViewGroup.LayoutParams.MATCH_PARENT,
        ViewGroup.LayoutParams.WRAP_CONTENT
      ));

      TextView captionToggle = new TextView(parent.getContext());
      captionToggle.setText("展开");
      captionToggle.setTextColor(0xCCFFFFFF);
      captionToggle.setTextSize(12);
      captionToggle.setTypeface(Typeface.DEFAULT_BOLD);
      captionToggle.setGravity(Gravity.CENTER);
      captionToggle.setMinWidth(dp(48));
      captionToggle.setMinHeight(dp(48));
      captionToggle.setPadding(dp(8), 0, dp(8), 0);
      captionToggle.setBackground(roundedDrawable(0x52000000, dp(16)));
      captionToggle.setClickable(true);
      captionToggle.setFocusable(true);
      captionToggle.setVisibility(View.GONE);
      LinearLayout.LayoutParams toggleParams = new LinearLayout.LayoutParams(
        ViewGroup.LayoutParams.WRAP_CONTENT,
        dp(48)
      );
      toggleParams.topMargin = dp(4);
      caption.addView(captionToggle, toggleParams);

      FrameLayout.LayoutParams captionParams = new FrameLayout.LayoutParams(
        ViewGroup.LayoutParams.MATCH_PARENT,
        ViewGroup.LayoutParams.WRAP_CONTENT,
        Gravity.BOTTOM | Gravity.LEFT
      );
      captionParams.leftMargin = dp(14);
      captionParams.rightMargin = dp(96);
      captionParams.bottomMargin = dp(54);
      root.addView(caption, captionParams);

      ImageView likeBurst = new ImageView(parent.getContext());
      likeBurst.setImageResource(R.drawable.ic_short_heart);
      likeBurst.setImageTintList(ColorStateList.valueOf(0xFFFF4D6D));
      likeBurst.setPadding(dp(10), dp(10), dp(10), dp(10));
      likeBurst.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_NO);
      likeBurst.setVisibility(View.GONE);
      root.addView(likeBurst, new FrameLayout.LayoutParams(
        dp(116),
        dp(116),
        Gravity.CENTER
      ));

      LinearLayout rail = new LinearLayout(parent.getContext());
      rail.setOrientation(LinearLayout.VERTICAL);
      rail.setGravity(Gravity.CENTER);
      rail.setClipChildren(false);
      rail.setClipToPadding(false);
      FrameLayout.LayoutParams railParams = new FrameLayout.LayoutParams(dp(64), ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.RIGHT | Gravity.CENTER_VERTICAL);
      railParams.rightMargin = dp(8);
      root.addView(rail, railParams);

      FrameLayout progressTouch = new FrameLayout(parent.getContext());
      progressTouch.setClickable(true);
      progressTouch.setFocusable(true);
      progressTouch.setContentDescription("播放进度，拖动调整");
      progressTouch.setOnTouchListener((view, event) -> seekActivePlayerFromTouch(view, event));
      FrameLayout.LayoutParams progressTouchParams = new FrameLayout.LayoutParams(
        ViewGroup.LayoutParams.MATCH_PARENT,
        dp(48),
        Gravity.BOTTOM
      );
      root.addView(progressTouch, progressTouchParams);

      FrameLayout progressTrack = new FrameLayout(parent.getContext());
      progressTrack.setAlpha(0f);
      progressTrack.setBackgroundColor(0x44FFFFFF);
      FrameLayout.LayoutParams progressParams = new FrameLayout.LayoutParams(
        ViewGroup.LayoutParams.MATCH_PARENT,
        dp(3),
        Gravity.BOTTOM
      );
      progressTouch.addView(progressTrack, progressParams);

      View progressFill = new View(parent.getContext());
      progressFill.setBackgroundColor(0xFFFE2C55);
      progressFill.setPivotX(0f);
      progressFill.setScaleX(0f);
      progressTrack.addView(progressFill, new FrameLayout.LayoutParams(
        ViewGroup.LayoutParams.MATCH_PARENT,
        ViewGroup.LayoutParams.MATCH_PARENT
      ));

      TextView progressTime = new TextView(parent.getContext());
      progressTime.setTextColor(Color.WHITE);
      progressTime.setTextSize(13);
      progressTime.setTypeface(Typeface.DEFAULT_BOLD);
      progressTime.setGravity(Gravity.CENTER);
      progressTime.setPadding(dp(10), dp(5), dp(10), dp(5));
      progressTime.setBackground(roundedDrawable(0xCC161823, dp(6)));
      progressTime.setVisibility(View.GONE);
      FrameLayout.LayoutParams progressTimeParams = new FrameLayout.LayoutParams(
        ViewGroup.LayoutParams.WRAP_CONTENT,
        ViewGroup.LayoutParams.WRAP_CONTENT,
        Gravity.BOTTOM | Gravity.CENTER_HORIZONTAL
      );
      progressTimeParams.bottomMargin = dp(34);
      root.addView(progressTime, progressTimeParams);

      return new ShortVideoHolder(root, stage, cover, gestureLayer, caption, captionAuthor, captionTitle, captionToggle, playIndicator, rail, progressTouch, progressTrack, progressFill, progressTime, likeBurst);
    }

    @Override
    public void onBindViewHolder(@NonNull ShortVideoHolder holder, int position) {
      holder.index = position;
      holder.touchActive = false;
      holder.horizontalGesture = false;
      holder.verticalGesture = false;
      holder.longPressTriggered = false;
      ShortVideoItem item = videos.get(position);
      holder.itemView.setContentDescription("短视频，作者 "
        + (item.author.length() > 0 ? item.author : "未知作者")
        + "，" + shortTitle(item.title)
        + "。点按播放或暂停，使用右侧按钮互动，上下滑切换");
      View.OnLongClickListener longPress = view -> {
        clearPendingStageTap();
        view.performHapticFeedback(HapticFeedbackConstants.LONG_PRESS);
        showPlaybackToolbar(item);
        return true;
      };
      holder.itemView.setOnClickListener(view -> handleStageTap(holder.index));
      holder.itemView.setOnTouchListener((view, event) -> handleStageTouch(holder, view, event));
      holder.itemView.setOnLongClickListener(longPress);
      holder.stage.setOnClickListener(view -> handleStageTap(holder.index));
      holder.stage.setOnTouchListener((view, event) -> handleStageTouch(holder, view, event));
      holder.stage.setOnLongClickListener(longPress);
      holder.cover.setOnClickListener(view -> handleStageTap(holder.index));
      holder.cover.setOnTouchListener((view, event) -> handleStageTouch(holder, view, event));
      holder.cover.setOnLongClickListener(longPress);
      holder.gestureLayer.setOnTouchListener((view, event) -> handleGestureLayerTouch(holder, view, event));
      bindCaption(holder, item, longPress);
      holder.rail.setOnLongClickListener(longPress);
      bindRail(holder, item);
      applyControlsVisibility(holder);
      holder.cover.setImageDrawable(null);
      holder.cover.setVisibility(View.VISIBLE);
      resetHolderProgress(holder);
      resetLikeBurst(holder);
      holder.playIndicator.setVisibility(View.GONE);
      attachedHolders.put(position, holder);
      ensurePlayerViewAt(position);
      if (!applyCachedFrame(holder, item) && item.coverUrl.length() > 0) loadCover(holder, item);
      if (framePrefetchEnabled) bindFrame(position);
    }

    @Override
    public void onViewRecycled(@NonNull ShortVideoHolder holder) {
      attachedHolders.remove(holder.index);
      cancelStageLongPress(holder);
      hideSeekPreview(holder, false);
      holder.touchActive = false;
      holder.horizontalGesture = false;
      holder.verticalGesture = false;
      holder.longPressTriggered = false;
      holder.captionExpanded = false;
      holder.captionCanExpand = false;
      holder.playIndicator.animate().cancel();
      holder.playIndicator.setVisibility(View.GONE);
      PlayerView cachedView = playerViews.get(holder.index);
      if (cachedView != null && cachedView.getParent() == holder.stage) holder.stage.removeView(cachedView);
      resetLikeBurst(holder);
      super.onViewRecycled(holder);
    }

    @Override
    public int getItemCount() {
      return videos.size();
    }

  }

  private static final class ShortVideoHolder extends RecyclerView.ViewHolder {
    final FrameLayout stage;
    final ImageView cover;
    final FrameLayout gestureLayer;
    final LinearLayout caption;
    final TextView captionAuthor;
    final TextView captionTitle;
    final TextView captionToggle;
    final ImageView playIndicator;
    final LinearLayout rail;
    final FrameLayout progressTouch;
    final FrameLayout progressTrack;
    final View progressFill;
    final TextView progressTime;
    final ImageView likeBurst;
    int index = -1;
    float touchStartX;
    float touchStartY;
    boolean touchActive;
    boolean horizontalGesture;
    boolean verticalGesture;
    boolean longPressTriggered;
    boolean captionExpanded;
    boolean captionCanExpand;
    Runnable longPressRunnable;
    Runnable hideSeekPreviewRunnable;

    ShortVideoHolder(@NonNull FrameLayout root, FrameLayout stage, ImageView cover, FrameLayout gestureLayer, LinearLayout caption, TextView captionAuthor, TextView captionTitle, TextView captionToggle, ImageView playIndicator, LinearLayout rail, FrameLayout progressTouch, FrameLayout progressTrack, View progressFill, TextView progressTime, ImageView likeBurst) {
      super(root);
      this.stage = stage;
      this.cover = cover;
      this.gestureLayer = gestureLayer;
      this.caption = caption;
      this.captionAuthor = captionAuthor;
      this.captionTitle = captionTitle;
      this.captionToggle = captionToggle;
      this.playIndicator = playIndicator;
      this.rail = rail;
      this.progressTouch = progressTouch;
      this.progressTrack = progressTrack;
      this.progressFill = progressFill;
      this.progressTime = progressTime;
      this.likeBurst = likeBurst;
    }
  }

  private abstract static class ScreenState {}

  private static final class FeedScreenState extends ScreenState {
    final List<ShortVideoItem> items = new ArrayList<>();
    final String feedUrl;
    final int nextOffset;
    final boolean hasMore;
    final int currentIndex;

    FeedScreenState(List<ShortVideoItem> items, String feedUrl, int nextOffset, boolean hasMore, int currentIndex) {
      if (items != null) this.items.addAll(items);
      this.feedUrl = feedUrl == null ? "" : feedUrl;
      this.nextOffset = Math.max(0, nextOffset);
      this.hasMore = hasMore;
      this.currentIndex = Math.max(0, currentIndex);
    }

    FeedScreenState copy() {
      return new FeedScreenState(items, feedUrl, nextOffset, hasMore, currentIndex);
    }
  }

  private static final class AuthorScreenState extends ScreenState {
    final ShortVideoItem seed;
    ShortVideoItem currentItem;
    FeedPage page;
    String activeTab;
    String sort;
    boolean loadingMore;
    int worksScrollY;

    AuthorScreenState(ShortVideoItem seed, @Nullable FeedPage page, String activeTab, String sort) {
      this.seed = seed;
      this.currentItem = seed;
      this.page = page == null ? null : page.copy();
      this.activeTab = activeTab == null || activeTab.length() == 0 ? "works" : activeTab;
      this.sort = sort == null || sort.length() == 0 ? "published" : sort;
    }

    AuthorScreenState copy() {
      AuthorScreenState copy = new AuthorScreenState(seed, page, activeTab, sort);
      copy.currentItem = currentItem;
      copy.loadingMore = loadingMore;
      copy.worksScrollY = worksScrollY;
      return copy;
    }
  }

  private static final class FeedPage {
    final List<ShortVideoItem> items = new ArrayList<>();
    int offset = 0;
    int limit = 80;
    int total = 0;
    boolean hasMore = false;
    FeedStats stats = new FeedStats();

    int nextOffset() {
      return offset + limit;
    }

    FeedPage copy() {
      FeedPage copy = new FeedPage();
      copy.items.addAll(items);
      copy.offset = offset;
      copy.limit = limit;
      copy.total = total;
      copy.hasMore = hasMore;
      copy.stats = stats == null ? new FeedStats() : stats.copy();
      return copy;
    }
  }

  private static final class FeedStats {
    long likes;
    long comments;
    long collects;
    long shares;
    long plays;
    long bytes;
    long durationMs;

    static FeedStats fromJson(@Nullable JSONObject row) {
      FeedStats stats = new FeedStats();
      if (row == null) return stats;
      stats.likes = row.optLong("likes", 0);
      stats.comments = row.optLong("comments", 0);
      stats.collects = row.optLong("collects", 0);
      stats.shares = row.optLong("shares", 0);
      stats.plays = row.optLong("plays", 0);
      stats.bytes = row.optLong("bytes", 0);
      stats.durationMs = row.optLong("durationMs", 0);
      return stats;
    }

    static FeedStats fromItems(List<ShortVideoItem> items) {
      FeedStats stats = new FeedStats();
      for (ShortVideoItem item : items) {
        stats.likes += item.likes;
        stats.comments += item.comments;
        stats.collects += item.collects;
        stats.shares += item.shares;
        stats.plays += item.plays;
        stats.durationMs += Math.max(0, item.durationMs);
      }
      return stats;
    }

    boolean isEmpty() {
      return likes == 0 && comments == 0 && collects == 0 && shares == 0 && plays == 0 && bytes == 0 && durationMs == 0;
    }

    FeedStats copy() {
      FeedStats copy = new FeedStats();
      copy.likes = likes;
      copy.comments = comments;
      copy.collects = collects;
      copy.shares = shares;
      copy.plays = plays;
      copy.bytes = bytes;
      copy.durationMs = durationMs;
      return copy;
    }
  }

  private static final class DeleteResult {
    final Set<String> ids = new HashSet<>();
    int count;
    int deletedFiles;

    static DeleteResult fromJson(JSONObject row, ShortVideoItem fallback) {
      DeleteResult result = new DeleteResult();
      JSONArray ids = row == null ? null : row.optJSONArray("ids");
      if (ids != null) {
        for (int i = 0; i < ids.length(); i++) {
          String id = ids.optString(i, "").trim();
          if (id.length() > 0) result.ids.add(id);
        }
      }
      if (result.ids.isEmpty() && fallback != null && fallback.id.length() > 0) {
        result.ids.add(fallback.id);
      }
      result.count = row == null ? result.ids.size() : Math.max(result.ids.size(), row.optInt("count", result.ids.size()));
      JSONArray files = row == null ? null : row.optJSONArray("deletedFiles");
      result.deletedFiles = files == null ? 0 : files.length();
      return result;
    }
  }

  private static final class ShortVideoItem {
    final String id;
    final String awemeId;
    final String streamUrl;
    final String coverUrl;
    final String title;
    final String author;
    final String authorSecUid;
    final String authorUid;
    final String authorAvatarUrl;
    final String authorProfileUrl;
    final String authorUniqueId;
    final String authorShortId;
    final String authorSignature;
    final String authorIpLocation;
    final long authorFollowerCount;
    final long authorFollowingCount;
    final long authorTotalFavorited;
    final long authorAwemeCount;
    final long authorFavoritingCount;
    final int authorGender;
    final int authorAge;
    final String authorVerification;
    final String authorProfileCollectedAt;
    final String publishedAt;
    final long durationMs;
    final int width;
    final int height;
    final long likes;
    final long comments;
    final long collects;
    final long shares;
    final long plays;
    final String shareUrl;
    final String originalUrl;

    ShortVideoItem(String id, String awemeId, String streamUrl, String coverUrl, String title, String author, String authorSecUid, String authorUid, String authorAvatarUrl, String authorProfileUrl, String authorUniqueId, String authorShortId, String authorSignature, String authorIpLocation, long authorFollowerCount, long authorFollowingCount, long authorTotalFavorited, long authorAwemeCount, long authorFavoritingCount, int authorGender, int authorAge, String authorVerification, String authorProfileCollectedAt, String publishedAt, long durationMs, int width, int height, long likes, long comments, long collects, long shares, long plays, String shareUrl, String originalUrl) {
      this.id = id == null ? "" : id;
      this.awemeId = awemeId == null ? "" : awemeId;
      this.streamUrl = streamUrl == null ? "" : streamUrl;
      this.coverUrl = coverUrl == null ? "" : coverUrl;
      this.title = title == null ? "" : title;
      this.author = author == null ? "" : author;
      this.authorSecUid = authorSecUid == null ? "" : authorSecUid;
      this.authorUid = authorUid == null ? "" : authorUid;
      this.authorAvatarUrl = authorAvatarUrl == null ? "" : authorAvatarUrl;
      this.authorProfileUrl = authorProfileUrl == null ? "" : authorProfileUrl;
      this.authorUniqueId = authorUniqueId == null ? "" : authorUniqueId;
      this.authorShortId = authorShortId == null ? "" : authorShortId;
      this.authorSignature = authorSignature == null ? "" : authorSignature;
      this.authorIpLocation = authorIpLocation == null ? "" : authorIpLocation;
      this.authorFollowerCount = authorFollowerCount;
      this.authorFollowingCount = authorFollowingCount;
      this.authorTotalFavorited = authorTotalFavorited;
      this.authorAwemeCount = authorAwemeCount;
      this.authorFavoritingCount = authorFavoritingCount;
      this.authorGender = authorGender;
      this.authorAge = authorAge;
      this.authorVerification = authorVerification == null ? "" : authorVerification;
      this.authorProfileCollectedAt = authorProfileCollectedAt == null ? "" : authorProfileCollectedAt;
      this.publishedAt = publishedAt == null ? "" : publishedAt;
      this.durationMs = durationMs;
      this.width = Math.max(0, width);
      this.height = Math.max(0, height);
      this.likes = likes;
      this.comments = comments;
      this.collects = collects;
      this.shares = shares;
      this.plays = plays;
      this.shareUrl = shareUrl == null ? "" : shareUrl;
      this.originalUrl = originalUrl == null ? "" : originalUrl;
    }
  }
}
