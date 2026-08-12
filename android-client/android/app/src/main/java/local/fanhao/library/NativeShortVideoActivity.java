package local.fanhao.library;

import android.animation.Animator;
import android.animation.AnimatorListenerAdapter;
import android.animation.ValueAnimator;
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
import android.view.ScaleGestureDetector;
import android.view.View;
import android.view.ViewGroup;
import android.view.ViewOutlineProvider;
import android.view.Window;
import android.view.WindowInsets;
import android.view.WindowInsetsController;
import android.view.WindowManager;
import android.view.animation.PathInterpolator;
import android.widget.FrameLayout;
import android.widget.GridLayout;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

import androidx.annotation.NonNull;
import androidx.annotation.Nullable;
import androidx.media3.common.MediaItem;
import androidx.media3.common.PlaybackException;
import androidx.media3.common.Player;
import androidx.media3.common.VideoSize;
import androidx.media3.common.util.UnstableApi;
import androidx.media3.database.StandaloneDatabaseProvider;
import androidx.media3.datasource.DataSpec;
import androidx.media3.datasource.DefaultDataSource;
import androidx.media3.datasource.DefaultHttpDataSource;
import androidx.media3.datasource.cache.CacheDataSource;
import androidx.media3.datasource.cache.CacheKeyFactory;
import androidx.media3.datasource.cache.CacheWriter;
import androidx.media3.datasource.cache.LeastRecentlyUsedCacheEvictor;
import androidx.media3.datasource.cache.SimpleCache;
import androidx.media3.exoplayer.DefaultLoadControl;
import androidx.media3.exoplayer.ExoPlayer;
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory;
import androidx.media3.ui.AspectRatioFrameLayout;
import androidx.media3.ui.PlayerView;
import androidx.recyclerview.widget.RecyclerView;
import androidx.viewpager2.widget.ViewPager2;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
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
import java.util.concurrent.TimeUnit;

@UnstableApi
public class NativeShortVideoActivity extends Activity {
  private static final String TAG = "NativeShortVideo";

  public static final String EXTRA_VIDEOS_JSON = "videosJson";
  public static final String EXTRA_START_INDEX = "startIndex";
  public static final String EXTRA_START_ID = "startId";
  public static final String EXTRA_BASE_URL = "baseUrl";
  public static final String EXTRA_FEED_URL = "feedUrl";
  public static final String EXTRA_NEXT_OFFSET = "nextOffset";
  public static final String EXTRA_NEXT_CURSOR = "nextCursor";
  public static final String EXTRA_HAS_MORE = "hasMore";
  public static final String EXTRA_OPEN_AUTHOR_PANEL = "openAuthorPanel";
  private static final String PREFS_NAME = "fanhao.shortVideo.native";
  private static final String PREF_MUTED = "muted";
  private static final String PREF_VIDEO_FIT_MODE = "videoFitMode";
  private static final String PREF_AUTO_NEXT = "autoNext";
  private static final String PREF_LIKED_VIDEO_KEYS = "likedVideoKeys";
  private static final String PREF_COLLECTED_VIDEO_KEYS = "collectedVideoKeys";
  private static final String PREF_LEGACY_ACTION_SCOPE = "legacyActionScope.v1";
  private static final String PREF_ACTION_STATE_PREFIX = "actionState.v1.";
  private static final String PREF_FOLLOWED_AUTHOR_KEYS = "followedAuthorKeys";
  private static final long STAGE_DOUBLE_TAP_MS = 280;
  private static final long GALLERY_IMAGE_AUTO_ADVANCE_MS = 4000;
  private static final float HORIZONTAL_GESTURE_RATIO = 1.25f;
  private static final int VERTICAL_SWIPE_COMMIT_DISTANCE_DP = 48;
  private static final int LONG_PRESS_CANCEL_DISTANCE_DP = 6;
  private static final PathInterpolator GALLERY_SETTLE_INTERPOLATOR = new PathInterpolator(0.2f, 0.82f, 0.28f, 1f);
  private static final int FEED_PAGE_LIMIT = 18;
  private static final int AUTHOR_PAGE_LIMIT = 18;
  private static final int SEARCH_PAGE_LIMIT = 24;
  private static final long VIDEO_CACHE_MAX_BYTES = 512L * 1024L * 1024L;
  private static final long NEXT_VIDEO_PREFETCH_BYTES = 4L * 1024L * 1024L;
  private static final long FEED_CACHE_MAX_AGE_MS = 5L * 60L * 1000L;
  private static final int FRAME_CACHE_MAX_KB = 48 * 1024;
  private static final int PLAYER_COVER_MAX_WIDTH = 720;
  private static final int PLAYER_COVER_MAX_HEIGHT = 1280;
  private static final int THUMBNAIL_MAX_SIZE = 512;

  private final Handler mainHandler = new Handler(Looper.getMainLooper());
  private final ExecutorService executor = Executors.newFixedThreadPool(4);
  private final ExecutorService videoPrefetchExecutor = Executors.newSingleThreadExecutor();
  private final Set<String> pendingFrameIds = Collections.synchronizedSet(new HashSet<>());
  private final Set<String> pendingAuthorFollowKeys = Collections.synchronizedSet(new HashSet<>());
  private final Set<String> pendingVideoPrefetchIds = Collections.synchronizedSet(new HashSet<>());
  private final Set<String> completedVideoPrefetchIds = Collections.synchronizedSet(new HashSet<>());
  private final LruCache<String, Bitmap> frameCache = new LruCache<String, Bitmap>(FRAME_CACHE_MAX_KB) {
    @Override
    protected int sizeOf(String key, Bitmap value) {
      return Math.max(1, value.getAllocationByteCount() / 1024);
    }
  };
  private final NativeShortVideoFeedReader feedReader = new NativeShortVideoFeedReader(FEED_PAGE_LIMIT, FEED_CACHE_MAX_AGE_MS);
  private final NativeShortVideoFeedPaging feedPaging = new NativeShortVideoFeedPaging();

  private final List<ShortVideoItem> videos = new ArrayList<>();
  private final Map<Integer, ShortVideoHolder> attachedHolders = new HashMap<>();
  private final Map<Integer, ExoPlayer> playerCache = new HashMap<>();
  private final Map<Integer, PlayerView> playerViews = new HashMap<>();
  private final Map<String, int[]> decodedVideoSizes = new HashMap<>();
  private final Map<String, Integer> galleryPositions = new HashMap<>();
  private final Set<Integer> failedPlayerIndexes = new HashSet<>();
  private final Set<String> followedAuthorKeys = new HashSet<>();
  private final List<ScreenState> navigationStack = new ArrayList<>();
  private ExoPlayer activePlayer;
  private ExoPlayer gallerySegmentPlayer;
  private PlayerView gallerySegmentView;
  private int gallerySegmentFeedIndex = -1;
  private int gallerySegmentMediaIndex = -1;
  private String gallerySegmentUrl = "";
  private ExoPlayer gallerySoundPlayer;
  private int gallerySoundFeedIndex = -1;
  private String gallerySoundUrl = "";
  private SimpleCache videoCache;
  private CacheDataSource.Factory videoCacheDataSourceFactory;
  private volatile CacheWriter activeVideoCacheWriter;
  private volatile boolean destroying;
  private ViewPager2 pager;
  private ScaleGestureDetector galleryScaleDetector;
  private ShortVideoHolder galleryScaleHolder;
  private ShortVideoAdapter adapter;
  private TextView statusView;
  private TextView topInfoView;
  private ImageView topSearchButton;
  private ImageView topBackButton;
  private NativeShortVideoFeedSearchController feedSearchController;
  private FrameLayout rootView;
  private View authorOverlay;
  private View playbackToolbarOverlay;
  private NativeShortVideoCommentsController commentsController;
  private ExoPlayer commentsPausedVideo;
  private ExoPlayer commentsPausedGallerySegment;
  private ExoPlayer commentsPausedGallerySound;
  private boolean commentsResumeVideo;
  private boolean commentsResumeGallerySegment;
  private boolean commentsResumeGallerySound;
  private int commentsPausedIndex = -1;
  private ScreenState currentScreen;
  private String apiBaseUrl;
  private String actionServerScope = "";
  private NativeShortVideoActionState actionState = new NativeShortVideoActionState(Collections.emptyList());
  private String pendingFeedUrl;
  private int pendingStartIndex;
  private int nextFeedOffset;
  private String nextFeedCursor = "";
  private boolean hasMoreVideos;
  private boolean loadingMoreVideos;
  private volatile int currentIndex = -1;
  private int pendingPlayIndex = -1;
  private Runnable pendingPrepareRunnable;
  private Runnable progressRunnable;
  private Runnable systemInfoRunnable;
  private Runnable pendingStageTapRunnable;
  private Runnable galleryAutoAdvanceRunnable;
  private int galleryAutoAdvanceFeedIndex = -1;
  private int galleryAutoAdvanceMediaIndex = -1;
  private long lastStageTapAt;
  private long pageSelectedAtMs;
  private long loggedFramePageSelectedAtMs;
  private int pageSelectedIndex = -1;
  private float pagerGestureStartX;
  private float pagerGestureStartY;
  private int pagerGestureStartItem = -1;
  private boolean suppressPagerGestureCommit;
  private int lastStageTapIndex = -1;
  private boolean framePrefetchEnabled;
  private long createdAtMs;
  private boolean loggedFirstFrame;
  private boolean muted;
  private boolean videoFitMode = true;
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
    initializeVideoCache();
    apiBaseUrl = getIntent().getStringExtra(EXTRA_BASE_URL);
    pendingFeedUrl = getIntent().getStringExtra(EXTRA_FEED_URL);
    initializeActionState();
    pendingStartIndex = Math.max(0, getIntent().getIntExtra(EXTRA_START_INDEX, 0));
    nextFeedOffset = Math.max(0, getIntent().getIntExtra(EXTRA_NEXT_OFFSET, 0));
    nextFeedCursor = String.valueOf(getIntent().getStringExtra(EXTRA_NEXT_CURSOR));
    if ("null".equals(nextFeedCursor)) nextFeedCursor = "";
    hasMoreVideos = getIntent().getBooleanExtra(EXTRA_HAS_MORE, false);
    feedPaging.replaceFeed(pendingFeedUrl, nextFeedCursor, hasMoreVideos);
    openAuthorPanelOnStart = getIntent().getBooleanExtra(EXTRA_OPEN_AUTHOR_PANEL, false);
    readVideos();
    reconcileServerActionSnapshots(videos);
    String requestedStartId = String.valueOf(getIntent().getStringExtra(EXTRA_START_ID));
    int requestedStartIndex = findVideoIndex(videos, requestedStartId);
    if (requestedStartIndex >= 0) pendingStartIndex = requestedStartIndex;
    buildUi();
    currentScreen = captureFeedScreen();
    syncPendingVideoActions(false);
    if (!videos.isEmpty()) {
      int initialIndex = Math.max(0, Math.min(pendingStartIndex, videos.size() - 1));
      if (openAuthorPanelOnStart) openInitialAuthorScreen(initialIndex);
      else startPlaybackAt(initialIndex);
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
      && !commentsOpen()
      && activePlayer != null;
    Log.i(TAG, "lifecycle resume shouldPlay=" + shouldResumePlayback);
    if (shouldResumePlayback) {
      activePlayer.play();
      startProgressUpdates();
    } else {
      updateActiveProgress();
    }
    if (gallerySoundPlayer != null && gallerySoundFeedIndex == currentIndex && authorOverlay == null && !commentsOpen()) {
      gallerySoundPlayer.play();
    }
    resumeGalleryAutoAdvanceIfNeeded();
    if (currentIndex >= 0) mainHandler.post(() -> preparePlayersAround(currentIndex));
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
    cancelGalleryAutoAdvance();
    stopSystemInfoUpdates();
    stopProgressUpdates();
    for (ExoPlayer cachedPlayer : playerCache.values()) cachedPlayer.pause();
    if (gallerySegmentPlayer != null) gallerySegmentPlayer.pause();
    if (gallerySoundPlayer != null) gallerySoundPlayer.pause();
    super.onPause();
  }

  @Override
  protected void onDestroy() {
    Log.i(TAG, "destroy");
    destroying = true;
    if (feedSearchController != null) feedSearchController.dismiss(false);
    stopSystemInfoUpdates();
    stopProgressUpdates();
    releaseAllPlayers();
    stopVideoPrefetch();
    releaseVideoCache();
    frameCache.evictAll();
    feedReader.clear();
    pendingFrameIds.clear();
    pendingVideoPrefetchIds.clear();
    completedVideoPrefetchIds.clear();
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
    if (commentsController != null && commentsController.dismiss(true)) return;
    if (feedSearchController != null && feedSearchController.dismiss(true)) return;
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
    feedSearchController = createFeedSearchController();

    pager = new ViewPager2(this);
    galleryScaleDetector = new ScaleGestureDetector(this, new GalleryScaleListener());
    pager.setOrientation(ViewPager2.ORIENTATION_VERTICAL);
    pager.setOffscreenPageLimit(1);
    adapter = new ShortVideoAdapter();
    pager.setAdapter(adapter);
    installPagerGestureCommitObserver();
    pager.registerOnPageChangeCallback(new ViewPager2.OnPageChangeCallback() {
      @Override
      public void onPageSelected(int position) {
        if (openAuthorPanelOnStart || authorOverlay != null) return;
        pageSelectedAtMs = SystemClock.elapsedRealtime();
        pageSelectedIndex = position;
        Log.i(TAG, "page selected " + position);
        pendingPlayIndex = position;
        loadMoreIfNeeded(position);
        preparePlayersAround(position);
        schedulePrepareAround(position, activePlayer == null ? 320 : 120);
        pager.post(() -> playAt(position));
      }

      @Override
      public void onPageScrollStateChanged(int state) {
        if (openAuthorPanelOnStart || authorOverlay != null) return;
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

    topBackButton = new ImageView(this);
    topBackButton.setImageResource(androidx.appcompat.R.drawable.abc_ic_ab_back_material);
    topBackButton.setImageTintList(ColorStateList.valueOf(Color.WHITE));
    topBackButton.setPadding(dp(11), dp(11), dp(11), dp(11));
    topBackButton.setBackgroundColor(Color.TRANSPARENT);
    topBackButton.setContentDescription("返回上一页");
    topBackButton.setOnClickListener(view -> navigateBack());
    FrameLayout.LayoutParams backParams = new FrameLayout.LayoutParams(
      dp(44),
      dp(44),
      Gravity.TOP | Gravity.LEFT
    );
    backParams.topMargin = dp(42);
    backParams.leftMargin = dp(6);
    root.addView(topBackButton, backParams);

    topSearchButton = new ImageView(this);
    topSearchButton.setImageResource(android.R.drawable.ic_menu_search);
    topSearchButton.setImageTintList(ColorStateList.valueOf(Color.WHITE));
    topSearchButton.setPadding(dp(10), dp(10), dp(10), dp(10));
    topSearchButton.setBackgroundColor(Color.TRANSPARENT);
    topSearchButton.setContentDescription("搜索短视频");
    topSearchButton.setOnClickListener(view -> feedSearchController.show());
    FrameLayout.LayoutParams searchParams = new FrameLayout.LayoutParams(
      dp(44),
      dp(44),
      Gravity.TOP | Gravity.RIGHT
    );
    searchParams.topMargin = dp(42);
    searchParams.rightMargin = dp(6);
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

    commentsController = createCommentsController();
    setContentView(root);
    hideSystemBars();
  }

  private NativeShortVideoCommentsController createCommentsController() {
    return new NativeShortVideoCommentsController(this, rootView, executor, mainHandler, new NativeShortVideoCommentsController.Host() {
      @Override public String apiBaseUrl() {
        return NativeShortVideoActivity.this.apiBaseUrl;
      }

      @Override public void beforeCommentsOpen() {
        clearPendingStageTap();
        dismissPlaybackToolbar();
        pauseForCommentsOverlay();
      }

      @Override public void afterCommentsClose(boolean restorePlayback) {
        resumeAfterCommentsOverlay(restorePlayback);
      }

      @Override public void setPlaybackAccessibilitySuppressed(boolean suppressed) {
        suppressPlaybackAccessibility(suppressed);
      }

      @Override public void showTransientStatus(String message) {
        NativeShortVideoActivity.this.showTransientStatus(message);
      }

      @Override public void hideSystemBars() {
        NativeShortVideoActivity.this.hideSystemBars();
      }

      @Override public String originalVideoUrl(ShortVideoItem item) {
        return NativeShortVideoActivity.this.originalVideoUrl(item);
      }

      @Override public void openOriginalVideo(ShortVideoItem item) {
        NativeShortVideoActivity.this.openOriginalVideo(item);
      }
    });
  }

  private NativeShortVideoFeedSearchController createFeedSearchController() {
    return new NativeShortVideoFeedSearchController(this, new NativeShortVideoFeedSearchController.Host() {
      @Override public boolean isFeedLoading() {
        return loadingMoreVideos;
      }

      @Override public String currentQuery() {
        return currentFeedQuery();
      }

      @Override public Runnable pausePlayback() {
        return pausePlaybackForFeedSearch();
      }

      @Override public void applySearch(String query) {
        applyFeedSearch(query);
      }

      @Override public void showTransientStatus(String message) {
        NativeShortVideoActivity.this.showTransientStatus(message);
      }

      @Override public void hideSystemBars() {
        NativeShortVideoActivity.this.hideSystemBars();
      }
    });
  }

  private Runnable pausePlaybackForFeedSearch() {
    ExoPlayer dialogPlayer = activePlayer;
    ExoPlayer dialogGallerySegment = gallerySegmentPlayer;
    ExoPlayer dialogGallerySound = gallerySoundPlayer;
    boolean resumeVideo = dialogPlayer != null && dialogPlayer.isPlaying();
    boolean resumeSegment = dialogGallerySegment != null && dialogGallerySegment.isPlaying();
    boolean resumeSound = dialogGallerySound != null && dialogGallerySound.isPlaying();
    Log.i(TAG, "search overlay open video=" + resumeVideo
      + " segment=" + resumeSegment + " sound=" + resumeSound);
    if (dialogPlayer != null) dialogPlayer.pause();
    if (dialogGallerySegment != null) dialogGallerySegment.pause();
    if (dialogGallerySound != null) dialogGallerySound.pause();
    return () -> {
      if (!activityResumed || authorOverlay != null) return;
      if (resumeVideo && activePlayer == dialogPlayer && dialogPlayer.getPlaybackState() != Player.STATE_ENDED) {
        dialogPlayer.play();
        startProgressUpdates();
      }
      if (resumeSegment && gallerySegmentPlayer == dialogGallerySegment) dialogGallerySegment.play();
      if (resumeSound && gallerySoundPlayer == dialogGallerySound) dialogGallerySound.play();
    };
  }

  private boolean commentsOpen() {
    return commentsController != null && commentsController.isOpen();
  }

  private void installPagerGestureCommitObserver() {
    View child = pager.getChildAt(0);
    if (!(child instanceof RecyclerView)) return;
    RecyclerView recycler = (RecyclerView) child;
    recycler.addOnItemTouchListener(new RecyclerView.SimpleOnItemTouchListener() {
      @Override
      public boolean onInterceptTouchEvent(@NonNull RecyclerView view, @NonNull MotionEvent event) {
        int action = event.getActionMasked();
        if (action == MotionEvent.ACTION_DOWN) {
          pagerGestureStartX = event.getX();
          pagerGestureStartY = event.getY();
          pagerGestureStartItem = pager.getCurrentItem();
          return false;
        }
        if (action == MotionEvent.ACTION_UP) {
          commitShortPagerDragIfNeeded(event.getX(), event.getY());
        } else if (action == MotionEvent.ACTION_CANCEL) {
          pagerGestureStartItem = -1;
        }
        return false;
      }
    });
  }

  private void commitShortPagerDragIfNeeded(float endX, float endY) {
    int startItem = pagerGestureStartItem;
    pagerGestureStartItem = -1;
    if (suppressPagerGestureCommit) {
      suppressPagerGestureCommit = false;
      return;
    }
    if (startItem < 0 || videos.isEmpty()) return;
    float deltaX = endX - pagerGestureStartX;
    float deltaY = endY - pagerGestureStartY;
    if (Math.abs(deltaY) < dp(VERTICAL_SWIPE_COMMIT_DISTANCE_DP)) return;
    if (Math.abs(deltaY) <= Math.abs(deltaX) * 1.1f) return;
    int direction = deltaY < 0 ? 1 : -1;
    int target = startItem + direction;
    if (target < 0 || target >= videos.size()) return;
    mainHandler.postDelayed(() -> {
      if (isFinishing() || authorOverlay != null || pager.getCurrentItem() != startItem) return;
      Log.i(TAG, "gesture commit " + startItem + " -> " + target + " distance=" + Math.round(Math.abs(deltaY)));
      pager.setCurrentItem(target, true);
    }, 64);
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
    screen.hasPlaybackContext = true;
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
    return new FeedScreenState(videos, pendingFeedUrl, nextFeedOffset, nextFeedCursor, hasMoreVideos, index);
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
    currentIndex = -1;
    pendingPlayIndex = -1;
    pendingFeedUrl = screen.feedUrl;
    updateTopSearchButton();
    nextFeedOffset = Math.max(0, screen.nextOffset);
    nextFeedCursor = screen.nextCursor;
    hasMoreVideos = screen.hasMore;
    feedPaging.replaceFeed(pendingFeedUrl, nextFeedCursor, hasMoreVideos);
    videos.clear();
    videos.addAll(screen.items);
    reconcileServerActionSnapshots(videos);
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
    });
  }

  private void openInitialAuthorScreen(int index) {
    if (videos.isEmpty()) return;
    int safeIndex = Math.max(0, Math.min(index, videos.size() - 1));
    ShortVideoItem seed = videos.get(safeIndex);
    openAuthorPanelOnStart = false;
    pendingStartIndex = safeIndex;
    pendingPlayIndex = -1;
    currentIndex = -1;
    navigationStack.clear();
    AuthorScreenState screen = new AuthorScreenState(seed, null, "works", currentFeedSort());
    screen.currentItem = null;
    screen.hasPlaybackContext = false;
    renderAuthorScreen(screen);
    Log.i(TAG, "author direct " + displayAuthor(seed));
  }

  private void playAt(int index) {
    if (index < 0 || index >= videos.size()) return;
    cancelGalleryAutoAdvance();
    currentIndex = index;
    ShortVideoItem item = videos.get(index);
    ShortVideoHolder holder = attachedHolders.get(index);
    if (holder == null) {
      pager.post(() -> playAt(index));
      return;
    }

    if (item.isGallery()) {
      if (activePlayer != null) {
        int previousIndex = playerIndex(activePlayer);
        activePlayer.pause();
        activePlayer.setVolume(0f);
      }
      activePlayer = null;
      stopProgressUpdates();
      resetHolderProgress(holder);
      releaseDistantPlayers(index);
      playGallerySound(index, item);
      bindGallery(holder, item, galleryPositions.getOrDefault(item.id, 0), 0);
      hideStatus();
      loadMoreIfNeeded(index);
      scheduleVideoPrefetch(index + 1);
      Log.i(TAG, "gallery " + index + " media=" + item.galleryItems.size());
      return;
    }

    if (gallerySegmentPlayer != null) stopGallerySegmentPlayback(null, true);
    if (gallerySoundPlayer != null) releaseGallerySoundPlayer();

    applyCachedFrame(holder, item);
    ExoPlayer nextPlayer = preparePlayerAt(index);
    if (nextPlayer == null) return;
    boolean alreadyActive = activePlayer == nextPlayer;
    if (alreadyActive) {
      activePlayer.setRepeatMode(activeRepeatMode());
      activePlayer.setVolume(activeVolume());
      ensurePlayerViewAt(index);
      if (activePlayer.getPlaybackState() == Player.STATE_ENDED) activePlayer.seekTo(0);
      startActivePlaybackIfVisible();
      loadMoreIfNeeded(index);
      scheduleVideoPrefetch(index + 1);
      releaseDistantPlayers(index);
      return;
    }
    if (activePlayer != null && activePlayer != nextPlayer) {
      int previousIndex = playerIndex(activePlayer);
      activePlayer.pause();
      activePlayer.setVolume(0f);
    }
    activePlayer = nextPlayer;
    activePlayer.setRepeatMode(activeRepeatMode());
    activePlayer.setVolume(activeVolume());
    ensurePlayerViewAt(index);
    if (activePlayer.getPlaybackState() == Player.STATE_ENDED) activePlayer.seekTo(0);
    holder.cover.setVisibility(View.VISIBLE);
    framePrefetchEnabled = true;
    startActivePlaybackIfVisible();
    Log.i(TAG, "play " + index + " " + item.streamUrl);
    loadMoreIfNeeded(index);
    scheduleVideoPrefetch(index + 1);
    releaseDistantPlayers(index);
  }

  private void startActivePlaybackIfVisible() {
    if (!activityResumed || authorOverlay != null || activePlayer == null || isFinishing()) return;
    activePlayer.play();
    startProgressUpdates();
  }

  private void initializeVideoCache() {
    try {
      File cacheDirectory = new File(getCacheDir(), "short-video-media");
      StandaloneDatabaseProvider databaseProvider = new StandaloneDatabaseProvider(this);
      videoCache = new SimpleCache(
        cacheDirectory,
        new LeastRecentlyUsedCacheEvictor(VIDEO_CACHE_MAX_BYTES),
        databaseProvider
      );
      Map<String, String> requestHeaders = new HashMap<>();
      requestHeaders.put("X-FanHao-Client", "android");
      requestHeaders.put("X-FanHao-Media-Cache", "1");
      DefaultHttpDataSource.Factory httpDataSourceFactory = new DefaultHttpDataSource.Factory()
        .setConnectTimeoutMs(8000)
        .setReadTimeoutMs(12000)
        .setAllowCrossProtocolRedirects(true)
        .setDefaultRequestProperties(requestHeaders);
      videoCacheDataSourceFactory = new CacheDataSource.Factory()
        .setCache(videoCache)
        .setUpstreamDataSourceFactory(new DefaultDataSource.Factory(this, httpDataSourceFactory))
        .setFlags(CacheDataSource.FLAG_IGNORE_CACHE_ON_ERROR);
      Log.i(TAG, "video cache ready bytes=" + videoCache.getCacheSpace());
    } catch (Exception error) {
      videoCacheDataSourceFactory = null;
      if (videoCache != null) {
        try {
          videoCache.release();
        } catch (Exception ignored) {}
      }
      videoCache = null;
      Log.w(TAG, "video cache unavailable", error);
    }
  }

  private void releaseVideoCache() {
    videoCacheDataSourceFactory = null;
    if (videoCache == null) return;
    try {
      Log.i(TAG, "video cache release bytes=" + videoCache.getCacheSpace());
      videoCache.release();
    } catch (Exception error) {
      Log.w(TAG, "video cache release failed", error);
    }
    videoCache = null;
  }

  private Uri cachedMediaUri(ShortVideoItem item) {
    return cachedMediaUri(item.streamUrl);
  }

  private Uri cachedMediaUri(String url) {
    return Uri.parse(url).buildUpon()
      .appendQueryParameter("fhcache", "1")
      .build();
  }

  private void scheduleVideoPrefetch(int index) {
    if (destroying || index < 0 || index >= videos.size()) return;
    if (videoCache == null || videoCacheDataSourceFactory == null) return;
    ShortVideoItem item = videos.get(index);
    if (item.isGallery() || item.streamUrl.length() == 0) return;
    if (item.id.length() == 0 || completedVideoPrefetchIds.contains(item.id)) return;
    if (!pendingVideoPrefetchIds.add(item.id)) return;

    videoPrefetchExecutor.execute(() -> {
      long startedAtMs = SystemClock.elapsedRealtime();
      try {
        if (destroying) return;
        int liveIndex = index;
        if (liveIndex != currentIndex + 1) return;

        SimpleCache cache = videoCache;
        CacheDataSource.Factory factory = videoCacheDataSourceFactory;
        if (cache == null || factory == null) return;
        DataSpec dataSpec = new DataSpec.Builder()
          .setUri(cachedMediaUri(item))
          .setLength(NEXT_VIDEO_PREFETCH_BYTES)
          .setFlags(DataSpec.FLAG_ALLOW_CACHE_FRAGMENTATION | DataSpec.FLAG_MIGHT_NOT_USE_FULL_NETWORK_SPEED)
          .build();
        String cacheKey = CacheKeyFactory.DEFAULT.buildCacheKey(dataSpec);
        long beforeBytes = cache.getCachedBytes(cacheKey, 0, NEXT_VIDEO_PREFETCH_BYTES);
        if (beforeBytes >= NEXT_VIDEO_PREFETCH_BYTES) {
          completedVideoPrefetchIds.add(item.id);
          Log.i(TAG, "prefetch hit " + liveIndex + " bytes=" + beforeBytes);
          return;
        }

        CacheWriter writer = new CacheWriter(
          factory.createDataSourceForDownloading(),
          dataSpec,
          new byte[64 * 1024],
          null
        );
        activeVideoCacheWriter = writer;
        writer.cache();
        long afterBytes = cache.getCachedBytes(cacheKey, 0, NEXT_VIDEO_PREFETCH_BYTES);
        completedVideoPrefetchIds.add(item.id);
        Log.i(TAG, "prefetch ready " + liveIndex
          + " added=" + Math.max(0, afterBytes - beforeBytes)
          + " bytes=" + afterBytes
          + " in=" + (SystemClock.elapsedRealtime() - startedAtMs) + "ms");
      } catch (Exception error) {
        if (!destroying) Log.w(TAG, "prefetch failed " + index + " " + error.getClass().getSimpleName());
      } finally {
        activeVideoCacheWriter = null;
        pendingVideoPrefetchIds.remove(item.id);
      }
    });
  }

  private void stopVideoPrefetch() {
    CacheWriter writer = activeVideoCacheWriter;
    if (writer != null) writer.cancel();
    videoPrefetchExecutor.shutdownNow();
    try {
      videoPrefetchExecutor.awaitTermination(600, TimeUnit.MILLISECONDS);
    } catch (InterruptedException error) {
      Thread.currentThread().interrupt();
    }
    activeVideoCacheWriter = null;
  }

  private ExoPlayer preparePlayerAt(int index) {
    if (index < 0 || index >= videos.size()) return null;
    if (videos.get(index).isGallery() || videos.get(index).streamUrl.length() == 0) return null;
    ExoPlayer cachedPlayer = playerCache.get(index);
    if (cachedPlayer != null) {
      cachedPlayer.setRepeatMode(activeRepeatMode());
      ensurePlayerViewAt(index);
      return cachedPlayer;
    }

    ShortVideoItem item = videos.get(index);
    if (activePlayer != null && playerCache.containsValue(activePlayer)) {
      int oldIndex = playerIndex(activePlayer);
      PlayerView oldView = oldIndex < 0 ? null : playerViews.remove(oldIndex);
      if (oldIndex >= 0) {
        playerCache.remove(oldIndex);
        failedPlayerIndexes.remove(oldIndex);
        ShortVideoHolder oldHolder = attachedHolders.get(oldIndex);
        if (oldHolder != null) oldHolder.cover.setVisibility(View.VISIBLE);
      }
      if (oldView != null) {
        oldView.setPlayer(null);
        if (oldView.getParent() instanceof ViewGroup) {
          ((ViewGroup) oldView.getParent()).removeView(oldView);
        }
      }
      playerCache.put(index, activePlayer);
      setPlayerMedia(activePlayer, item);
      PlayerView reboundView = ensurePlayerViewAt(index);
      if (reboundView != null) reboundView.setPlayer(activePlayer);
      Log.i(TAG, "reuse " + oldIndex + " -> " + index + " " + item.streamUrl);
      return activePlayer;
    }

    ExoPlayer.Builder playerBuilder = new ExoPlayer.Builder(this)
      .setLoadControl(new DefaultLoadControl.Builder()
        .setBufferDurationsMs(600, 2000, 100, 220)
        .build());
    if (videoCacheDataSourceFactory != null) {
      playerBuilder.setMediaSourceFactory(new DefaultMediaSourceFactory(videoCacheDataSourceFactory));
    }
    ExoPlayer preparedPlayer = playerBuilder.build();
    preparedPlayer.setRepeatMode(activeRepeatMode());
    preparedPlayer.setVolume(0f);
    preparedPlayer.addListener(new Player.Listener() {
      @Override
      public void onRenderedFirstFrame() {
        int liveIndex = playerIndex(preparedPlayer);
        if (liveIndex < 0 || currentIndex != liveIndex) return;
        long frameDelayMs = liveIndex == pageSelectedIndex && pageSelectedAtMs > 0
          ? SystemClock.elapsedRealtime() - pageSelectedAtMs
          : -1;
        if (pageSelectedAtMs != loggedFramePageSelectedAtMs) {
          loggedFramePageSelectedAtMs = pageSelectedAtMs;
          Log.i(TAG, "frame ready " + liveIndex + " after=" + frameDelayMs + "ms");
        }
        failedPlayerIndexes.remove(liveIndex);
        if (!loggedFirstFrame) {
          loggedFirstFrame = true;
          Log.i(TAG, "first frame in " + (SystemClock.elapsedRealtime() - createdAtMs) + "ms");
        }
        ShortVideoHolder holder = attachedHolders.get(liveIndex);
        if (holder != null) holder.cover.setVisibility(View.GONE);
        hideStatus();
        scheduleVideoPrefetch(liveIndex + 1);
        mainHandler.post(() -> preparePlayersAround(liveIndex));
      }

      @Override
      public void onVideoSizeChanged(@NonNull VideoSize videoSize) {
        mainHandler.post(() -> {
          int liveIndex = playerIndex(preparedPlayer);
          if (liveIndex < 0) return;
          rememberDecodedVideoSize(liveIndex, videoSize.width, videoSize.height);
          applyVideoResizeMode(liveIndex, videoSize.width, videoSize.height);
          Log.i(TAG, "video size " + liveIndex + " " + videoSize.width + "x" + videoSize.height
            + " mode=" + (videoFitMode ? "fit" : "crop"));
        });
      }

      @Override
      public void onPlaybackStateChanged(int playbackState) {
        int liveIndex = playerIndex(preparedPlayer);
        if (liveIndex < 0) return;
        if (playbackState == Player.STATE_ENDED && currentIndex == liveIndex && autoNext) {
          mainHandler.post(() -> advanceAfterEnded(liveIndex));
          return;
        }
        if (playbackState != Player.STATE_READY) return;
        failedPlayerIndexes.remove(liveIndex);
        if (currentIndex == liveIndex) hideStatus();
        mainHandler.post(() -> syncPlayIndicator(liveIndex, preparedPlayer));
      }

      @Override
      public void onIsPlayingChanged(boolean isPlaying) {
        mainHandler.post(() -> {
          int liveIndex = playerIndex(preparedPlayer);
          if (liveIndex >= 0) syncPlayIndicator(liveIndex, preparedPlayer);
        });
      }

      @Override
      public void onPlayerError(@NonNull PlaybackException error) {
        mainHandler.post(() -> {
          int liveIndex = playerIndex(preparedPlayer);
          if (liveIndex >= 0) handlePlaybackError(liveIndex, preparedPlayer, error);
        });
      }
    });
    playerCache.put(index, preparedPlayer);
    setPlayerMedia(preparedPlayer, item);
    PlayerView preparedView = ensurePlayerViewAt(index);
    if (preparedView != null) preparedView.setPlayer(preparedPlayer);
    Log.i(TAG, "prepare " + index + " " + item.streamUrl);
    return preparedPlayer;
  }

  private void setPlayerMedia(ExoPlayer player, ShortVideoItem item) {
    player.stop();
    player.clearMediaItems();
    player.setRepeatMode(activeRepeatMode());
    player.setVolume(0f);
    Uri mediaUri = cachedMediaUri(item);
    player.setMediaItem(MediaItem.fromUri(mediaUri));
    player.prepare();
  }

  private ExoPlayer ensureGallerySegmentPlayer() {
    if (gallerySegmentPlayer != null) return gallerySegmentPlayer;
    ExoPlayer.Builder builder = new ExoPlayer.Builder(this)
      .setLoadControl(new DefaultLoadControl.Builder()
        .setBufferDurationsMs(600, 2000, 100, 220)
        .build());
    if (videoCacheDataSourceFactory != null) {
      builder.setMediaSourceFactory(new DefaultMediaSourceFactory(videoCacheDataSourceFactory));
    }
    ExoPlayer player = builder.build();
    player.setRepeatMode(Player.REPEAT_MODE_OFF);
    player.setVolume(0f);
    player.addListener(new Player.Listener() {
      @Override
      public void onRenderedFirstFrame() {
        mainHandler.post(() -> {
          ShortVideoHolder holder = attachedHolders.get(gallerySegmentFeedIndex);
          if (holder == null || holder.galleryIndex != gallerySegmentMediaIndex || gallerySegmentPlayer != player) return;
          holder.cover.setVisibility(View.GONE);
          holder.galleryVideo.setVisibility(View.VISIBLE);
          hideStatus();
          Log.i(TAG, "gallery video frame " + gallerySegmentFeedIndex + " " + (gallerySegmentMediaIndex + 1));
        });
      }

      @Override
      public void onVideoSizeChanged(@NonNull VideoSize videoSize) {
        mainHandler.post(() -> {
          if (gallerySegmentPlayer != player || gallerySegmentView == null) return;
          gallerySegmentView.setResizeMode(activeVideoResizeMode());
        });
      }

      @Override
      public void onPlaybackStateChanged(int playbackState) {
        if (playbackState == Player.STATE_ENDED) {
          int feedIndex = gallerySegmentFeedIndex;
          int mediaIndex = gallerySegmentMediaIndex;
          mainHandler.post(() -> advanceGallerySequence(feedIndex, mediaIndex, "video"));
          return;
        }
        if (playbackState == Player.STATE_READY) {
          mainHandler.post(() -> syncPlayIndicator(gallerySegmentFeedIndex, player));
        }
      }

      @Override
      public void onIsPlayingChanged(boolean isPlaying) {
        mainHandler.post(() -> syncPlayIndicator(gallerySegmentFeedIndex, player));
      }

      @Override
      public void onPlayerError(@NonNull PlaybackException error) {
        mainHandler.post(() -> {
          if (gallerySegmentPlayer != player || currentIndex != gallerySegmentFeedIndex) return;
          ShortVideoHolder holder = attachedHolders.get(gallerySegmentFeedIndex);
          if (holder != null) holder.cover.setVisibility(View.VISIBLE);
          showStatus("图文中的视频播放失败，左右滑可继续查看");
          Log.w(TAG, "gallery video error " + gallerySegmentFeedIndex + " " + error.getErrorCodeName());
        });
      }
    });
    gallerySegmentPlayer = player;
    return player;
  }

  private void playGallerySegment(ShortVideoHolder holder, ShortVideoItem item, int mediaIndex) {
    GalleryMedia media = galleryMediaAt(item, mediaIndex);
    if (holder == null || media == null || !media.isVideo()) return;
    ExoPlayer player = ensureGallerySegmentPlayer();
    if (gallerySegmentView != holder.galleryVideo) {
      if (gallerySegmentView != null) gallerySegmentView.setPlayer(null);
      gallerySegmentView = holder.galleryVideo;
      gallerySegmentView.setPlayer(player);
    }
    gallerySegmentFeedIndex = holder.index;
    gallerySegmentMediaIndex = mediaIndex;
    holder.galleryVideo.setResizeMode(activeVideoResizeMode());
    holder.galleryVideo.setVisibility(View.VISIBLE);
    holder.cover.setVisibility(View.VISIBLE);
    if (!media.url.equals(gallerySegmentUrl)) {
      gallerySegmentUrl = media.url;
      player.stop();
      player.clearMediaItems();
      player.setMediaItem(MediaItem.fromUri(cachedMediaUri(media.url)));
      player.prepare();
    }
    player.setRepeatMode(item.isSingleLivePhoto() ? Player.REPEAT_MODE_ONE : Player.REPEAT_MODE_OFF);
    player.setVolume(0f);
    activePlayer = player;
    if (activityResumed && authorOverlay == null) player.play();
    long soundPosition = gallerySoundPlayer == null ? -1 : gallerySoundPlayer.getCurrentPosition();
    boolean soundPlaying = gallerySoundPlayer != null && gallerySoundPlayer.isPlaying();
    Log.i(TAG, "gallery video play " + holder.index + " " + (mediaIndex + 1) + "/" + item.galleryItems.size()
      + " segmentVolume=0 soundPlaying=" + soundPlaying + " soundPosition=" + soundPosition);
  }

  private void stopGallerySegmentPlayback(@Nullable ShortVideoHolder holder, boolean release) {
    ExoPlayer player = gallerySegmentPlayer;
    if (player != null) {
      try {
        player.pause();
        player.setVolume(0f);
        if (release) {
          player.clearVideoSurface();
          player.stop();
          player.clearMediaItems();
        }
      } catch (Exception ignored) {}
    }
    if (gallerySegmentView != null) {
      gallerySegmentView.setPlayer(null);
      gallerySegmentView.setVisibility(View.GONE);
    }
    if (holder != null) holder.galleryVideo.setVisibility(View.GONE);
    if (activePlayer == player) activePlayer = null;
    gallerySegmentView = null;
    gallerySegmentFeedIndex = -1;
    gallerySegmentMediaIndex = -1;
    gallerySegmentUrl = "";
    if (release && player != null) {
      player.release();
      gallerySegmentPlayer = null;
    }
  }

  private void playGallerySound(int feedIndex, ShortVideoItem item) {
    if (item == null || !item.sound.isPlayable()) {
      releaseGallerySoundPlayer();
      return;
    }
    if (gallerySoundPlayer == null) {
      ExoPlayer.Builder builder = new ExoPlayer.Builder(this)
        .setLoadControl(new DefaultLoadControl.Builder()
          .setBufferDurationsMs(900, 5000, 180, 320)
          .build());
      if (videoCacheDataSourceFactory != null) {
        builder.setMediaSourceFactory(new DefaultMediaSourceFactory(videoCacheDataSourceFactory));
      }
      ExoPlayer player = builder.build();
      player.setRepeatMode(Player.REPEAT_MODE_ONE);
      player.setVolume(0f);
      player.addListener(new Player.Listener() {
        @Override
        public void onPlaybackStateChanged(int playbackState) {
          if (playbackState != Player.STATE_READY) return;
          Log.i(TAG, "gallery sound ready " + gallerySoundFeedIndex + " volume=" + player.getVolume());
          mainHandler.post(NativeShortVideoActivity.this::refreshVisibleRails);
        }

        @Override
        public void onPlayerError(@NonNull PlaybackException error) {
          Log.w(TAG, "gallery sound error " + gallerySoundFeedIndex + " " + error.getErrorCodeName());
          mainHandler.post(() -> {
            if (currentIndex == gallerySoundFeedIndex) showTransientStatus("配乐暂时无法播放，图集内容不受影响");
          });
        }
      });
      gallerySoundPlayer = player;
    }
    gallerySoundFeedIndex = feedIndex;
    ExoPlayer player = gallerySoundPlayer;
    if (!item.sound.previewUrl.equals(gallerySoundUrl)) {
      gallerySoundUrl = item.sound.previewUrl;
      player.stop();
      player.clearMediaItems();
      player.setMediaItem(MediaItem.fromUri(Uri.parse(item.sound.previewUrl)));
      player.prepare();
    }
    player.setRepeatMode(Player.REPEAT_MODE_ONE);
    player.setVolume(activeVolume());
    if (activityResumed && authorOverlay == null) player.play();
    Log.i(TAG, "gallery sound play " + feedIndex + " " + item.sound.title + " source=" + item.sound.previewSource);
  }

  private void releaseGallerySoundPlayer() {
    ExoPlayer player = gallerySoundPlayer;
    gallerySoundPlayer = null;
    gallerySoundFeedIndex = -1;
    gallerySoundUrl = "";
    if (player == null) return;
    try {
      player.stop();
      player.clearMediaItems();
    } catch (Exception ignored) {}
    player.release();
  }

  private int playerIndex(ExoPlayer player) {
    for (Map.Entry<Integer, ExoPlayer> entry : playerCache.entrySet()) {
      if (entry.getValue() == player) return entry.getKey();
    }
    return -1;
  }

  private void advanceAfterEnded(int index) {
    if (!activityResumed || authorOverlay != null || !autoNext || currentIndex != index) return;
    if (index + 1 < videos.size()) {
      pager.setCurrentItem(index + 1, true);
      return;
    }
    if (hasMoreVideos && pendingFeedUrl != null && pendingFeedUrl.trim().length() > 0) {
      feedPaging.markPendingAutoAdvance(index);
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
      if (activePlayer == player) activePlayer = null;
      PlayerView view = playerViews.get(index);
      if (view != null) view.setPlayer(null);
      releasePlayerResources(player);
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
    failedPlayerIndexes.remove(index);
    PlayerView view = playerViews.remove(index);
    if (view != null) {
      view.setPlayer(null);
      if (view.getParent() instanceof ViewGroup) {
        ((ViewGroup) view.getParent()).removeView(view);
      }
    }
    if (player != null) {
      if (player == activePlayer) activePlayer = null;
      releasePlayerResources(player);
    }
  }

  @Nullable
  private PlayerView ensurePlayerViewAt(int index) {
    if (index < 0 || index >= videos.size()) return null;
    if (videos.get(index).isGallery()) return null;
    PlayerView view = playerViews.get(index);
    if (view == null) {
      int[] dimensions = resolvedVideoSize(index);
      view = (PlayerView) getLayoutInflater().inflate(R.layout.native_short_player_view, pager, false);
      view.setClickable(false);
      view.setFocusable(false);
      view.setEnabled(false);
      view.setUseController(false);
      view.setKeepContentOnPlayerReset(false);
      view.setResizeMode(resizeModeFor(dimensions[0], dimensions[1]));
      ExoPlayer cachedPlayer = playerCache.get(index);
      if (cachedPlayer != null) view.setPlayer(cachedPlayer);
      playerViews.put(index, view);
    }

    ShortVideoHolder holder = attachedHolders.get(index);
    if (holder == null) return view;
    boolean reattached = view.getParent() != holder.stage;
    if (reattached) {
      if (view.getParent() instanceof ViewGroup) {
        ((ViewGroup) view.getParent()).removeView(view);
      }
      holder.stage.addView(view, Math.min(1, holder.stage.getChildCount()), new FrameLayout.LayoutParams(
        ViewGroup.LayoutParams.MATCH_PARENT,
        ViewGroup.LayoutParams.MATCH_PARENT
      ));
      ExoPlayer cachedPlayer = playerCache.get(index);
      if (cachedPlayer != null) {
        view.setPlayer(null);
        view.setPlayer(cachedPlayer);
      }
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
    if (index < 0 || index >= videos.size()) return;
    PlayerView view = playerViews.get(index);
    if (view != null) view.setResizeMode(activeVideoResizeMode());
    ShortVideoHolder holder = attachedHolders.get(index);
    if (holder != null) {
      holder.stage.setBackgroundColor(Color.BLACK);
      holder.cover.setScaleType(videoFitMode ? ImageView.ScaleType.FIT_CENTER : ImageView.ScaleType.CENTER_CROP);
      holder.videoBackdrop.setVisibility(View.GONE);
    }
  }

  private int resizeModeFor(int width, int height) {
    return activeVideoResizeMode();
  }

  private int activeVideoResizeMode() {
    return videoFitMode
      ? AspectRatioFrameLayout.RESIZE_MODE_FIT
      : AspectRatioFrameLayout.RESIZE_MODE_ZOOM;
  }

  private void applyVideoFitModeToPlayers() {
    for (Integer index : new ArrayList<>(playerViews.keySet())) {
      int[] dimensions = resolvedVideoSize(index);
      applyVideoResizeMode(index, dimensions[0], dimensions[1]);
    }
    if (gallerySegmentView != null) gallerySegmentView.setResizeMode(activeVideoResizeMode());
    for (ShortVideoHolder holder : attachedHolders.values()) {
      if (holder.index < 0 || holder.index >= videos.size()) continue;
      ShortVideoItem item = videos.get(holder.index);
      GalleryMedia media = item.isGallery() ? galleryMediaAt(item, holder.galleryIndex) : null;
      if (media != null && media.isVideo()) {
        holder.cover.setScaleType(videoFitMode ? ImageView.ScaleType.FIT_CENTER : ImageView.ScaleType.CENTER_CROP);
        holder.galleryVideo.setResizeMode(activeVideoResizeMode());
      }
    }
  }

  private void preparePlayersAround(int index) {
    loadMoreIfNeeded(index);
    preparePlayerAt(index);
    scheduleVideoPrefetch(index + 1);
    releaseDistantPlayers(index);
  }

  private void runNeighborsDuringDrag(int index) {
    if (!activityResumed || authorOverlay != null) return;
    bindFrame(index - 1);
    bindFrame(index + 1);
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

  private void releaseDistantPlayers(int centerIndex) {
    List<Integer> keys = new ArrayList<>(playerCache.keySet());
    for (int key : keys) {
      if (key == centerIndex) continue;
      ExoPlayer stalePlayer = playerCache.remove(key);
      failedPlayerIndexes.remove(key);
      if (stalePlayer == null) continue;
      if (stalePlayer == activePlayer) {
        activePlayer = null;
      }
      PlayerView staleView = playerViews.remove(key);
      if (staleView != null) {
        staleView.setPlayer(null);
        if (staleView.getParent() instanceof ViewGroup) {
          ((ViewGroup) staleView.getParent()).removeView(staleView);
        }
      }
      releasePlayerResources(stalePlayer);
      Log.i(TAG, "release " + key);
    }
  }

  private void releaseAllPlayers() {
    clearPendingStageTap();
    cancelGalleryAutoAdvance();
    dismissPlaybackToolbar();
    stopProgressUpdates();
    for (PlayerView cachedView : playerViews.values()) {
      cachedView.setPlayer(null);
      if (cachedView.getParent() instanceof ViewGroup) {
        ((ViewGroup) cachedView.getParent()).removeView(cachedView);
      }
    }
    for (ExoPlayer cachedPlayer : playerCache.values()) releasePlayerResources(cachedPlayer);
    stopGallerySegmentPlayback(null, true);
    releaseGallerySoundPlayer();
    playerCache.clear();
    playerViews.clear();
    failedPlayerIndexes.clear();
    activePlayer = null;
  }

  private void releasePlayerResources(ExoPlayer player) {
    if (player == null) return;
    try {
      player.clearVideoSurface();
      player.stop();
      player.clearMediaItems();
    } catch (Exception ignored) {}
    player.release();
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
    ShortVideoHolder holder = attachedHolders.get(index);
    long doubleTapWindow = holder != null && videos.get(index).isGallery() && holder.galleryZoomScale > 1.001f
      ? 420L
      : STAGE_DOUBLE_TAP_MS;
    if (pendingStageTapRunnable != null && lastStageTapIndex == index && now - lastStageTapAt <= doubleTapWindow) {
      clearPendingStageTap();
      if (holder != null && videos.get(index).isGallery() && holder.galleryZoomScale > 1.001f) {
        animateGalleryZoomReset(holder, true);
        return;
      }
      float tapX = holder == null ? Float.NaN : holder.lastTapX;
      float tapY = holder == null ? Float.NaN : holder.lastTapY;
      activateLike(videos.get(index), true, tapX, tapY, false);
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
      holder.touchStartAtMs = SystemClock.uptimeMillis();
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
      if (Math.abs(dx) > dp(LONG_PRESS_CANCEL_DISTANCE_DP) || Math.abs(dy) > dp(LONG_PRESS_CANCEL_DISTANCE_DP)) {
        cancelStageLongPress(holder);
      }
      if (!holder.horizontalGesture && Math.abs(dx) > dp(22) && Math.abs(dx) > Math.abs(dy) * HORIZONTAL_GESTURE_RATIO) {
        holder.horizontalGesture = true;
        setParentInterceptDisallowed(view, true);
      }
      if (holder.horizontalGesture) updateGalleryDrag(holder, dx);
      return holder.horizontalGesture;
    }
    if (action == MotionEvent.ACTION_UP) {
      holder.lastTapX = event.getRawX();
      holder.lastTapY = event.getRawY();
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
      if (finishGalleryDrag(holder, dx, galleryDragVelocity(holder, dx))) return true;
      handleHorizontalSwipe(holder.index, dx);
      return true;
    }
    if (action == MotionEvent.ACTION_CANCEL) {
      holder.touchActive = false;
      holder.horizontalGesture = false;
      holder.longPressTriggered = false;
      cancelGalleryDrag(holder);
      cancelStageLongPress(holder);
      setParentInterceptDisallowed(view, false);
    }
    return false;
  }

  private boolean handleGestureLayerTouch(ShortVideoHolder holder, View view, MotionEvent event) {
    if (holder == null || event == null) return true;
    if (handleGalleryScaleAndPanTouch(holder, view, event)) return true;
    int action = event.getActionMasked();
    if (action == MotionEvent.ACTION_DOWN) {
      holder.touchStartX = event.getRawX();
      holder.touchStartY = event.getRawY();
      holder.touchStartAtMs = SystemClock.uptimeMillis();
      holder.touchActive = true;
      holder.horizontalGesture = false;
      holder.verticalGesture = false;
      holder.longPressTriggered = false;
      holder.lastTapX = Float.NaN;
      holder.lastTapY = Float.NaN;
      setParentInterceptDisallowed(view, false);
      scheduleStageLongPress(holder, view);
      return true;
    }
    if (!holder.touchActive) return true;
    if (action == MotionEvent.ACTION_MOVE) {
      float dx = event.getRawX() - holder.touchStartX;
      float dy = event.getRawY() - holder.touchStartY;
      if (Math.abs(dx) > dp(LONG_PRESS_CANCEL_DISTANCE_DP) || Math.abs(dy) > dp(LONG_PRESS_CANCEL_DISTANCE_DP)) {
        cancelStageLongPress(holder);
      }
      if (!holder.horizontalGesture && !holder.verticalGesture && Math.abs(dx) > dp(18) && Math.abs(dx) > Math.abs(dy) * HORIZONTAL_GESTURE_RATIO) {
        holder.horizontalGesture = true;
        setParentInterceptDisallowed(view, true);
      } else if (!holder.horizontalGesture && !holder.verticalGesture && Math.abs(dy) > dp(14) && Math.abs(dy) > Math.abs(dx) * 1.05f) {
        holder.verticalGesture = true;
        setParentInterceptDisallowed(view, false);
      }
      if (holder.horizontalGesture) updateGalleryDrag(holder, dx);
      return true;
    }
    if (action == MotionEvent.ACTION_UP) {
      holder.lastTapX = event.getRawX();
      holder.lastTapY = event.getRawY();
      float dx = event.getRawX() - holder.touchStartX;
      float dy = event.getRawY() - holder.touchStartY;
      boolean consumedLongPress = holder.longPressTriggered;
      boolean horizontal = holder.horizontalGesture || (Math.abs(dx) > dp(72) && Math.abs(dx) > Math.abs(dy) * HORIZONTAL_GESTURE_RATIO);
      boolean vertical = holder.verticalGesture || (Math.abs(dy) > dp(32) && Math.abs(dy) > Math.abs(dx) * 1.05f);
      holder.touchActive = false;
      holder.horizontalGesture = false;
      holder.verticalGesture = false;
      holder.longPressTriggered = false;
      cancelStageLongPress(holder);
      setParentInterceptDisallowed(view, false);
      if (consumedLongPress) return true;
      if (horizontal) {
        if (!finishGalleryDrag(holder, dx, galleryDragVelocity(holder, dx))) handleHorizontalSwipe(holder.index, dx);
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
      cancelGalleryDrag(holder);
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
      if (attachedHolders.get(holder.index) != holder || holder.horizontalGesture || holder.verticalGesture) return;
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

  private boolean handleGalleryScaleAndPanTouch(ShortVideoHolder holder, View view, MotionEvent event) {
    if (holder.index < 0 || holder.index >= videos.size() || !videos.get(holder.index).isGallery()) return false;
    GalleryMedia activeMedia = galleryMediaAt(videos.get(holder.index), holder.galleryIndex);
    if (activeMedia != null && activeMedia.isVideo()) return false;
    galleryScaleHolder = holder;
    if (galleryScaleDetector != null) galleryScaleDetector.onTouchEvent(event);
    int action = event.getActionMasked();
    boolean multiTouch = event.getPointerCount() > 1 || (galleryScaleDetector != null && galleryScaleDetector.isInProgress()) || holder.galleryScaling;
    if (multiTouch) {
      suppressPagerGestureCommit = true;
      clearPendingStageTap();
      cancelStageLongPress(holder);
      holder.touchActive = false;
      holder.horizontalGesture = false;
      holder.verticalGesture = false;
      holder.galleryPanning = false;
      setParentInterceptDisallowed(view, true);
      int remainingIndex = 0;
      if (action == MotionEvent.ACTION_POINTER_UP && event.getPointerCount() > 1 && event.getActionIndex() == 0) remainingIndex = 1;
      if (remainingIndex < event.getPointerCount()) {
        holder.galleryZoomLastX = event.getX(remainingIndex);
        holder.galleryZoomLastY = event.getY(remainingIndex);
      }
      if (action == MotionEvent.ACTION_UP || action == MotionEvent.ACTION_CANCEL) {
        holder.galleryScaling = false;
        setParentInterceptDisallowed(view, false);
        galleryScaleHolder = null;
      }
      return true;
    }
    if (holder.galleryZoomScale <= 1.001f) {
      if (action == MotionEvent.ACTION_UP || action == MotionEvent.ACTION_CANCEL) galleryScaleHolder = null;
      return false;
    }
    suppressPagerGestureCommit = true;
    setParentInterceptDisallowed(view, true);
    if (action == MotionEvent.ACTION_DOWN) {
      holder.galleryPanning = true;
      holder.galleryPanMoved = false;
      holder.longPressTriggered = false;
      holder.galleryZoomLastX = event.getX();
      holder.galleryZoomLastY = event.getY();
      scheduleStageLongPress(holder, view);
      return true;
    }
    if (action == MotionEvent.ACTION_MOVE) {
      float deltaX = event.getX() - holder.galleryZoomLastX;
      float deltaY = event.getY() - holder.galleryZoomLastY;
      holder.galleryZoomLastX = event.getX();
      holder.galleryZoomLastY = event.getY();
      if (Math.abs(deltaX) > dp(1) || Math.abs(deltaY) > dp(1)) {
        holder.galleryPanMoved = true;
        clearPendingStageTap();
        cancelStageLongPress(holder);
      }
      applyGalleryPan(holder, holder.cover.getTranslationX() + deltaX, holder.cover.getTranslationY() + deltaY);
      return true;
    }
    if (action == MotionEvent.ACTION_UP) {
      holder.lastTapX = event.getRawX();
      holder.lastTapY = event.getRawY();
      boolean consumedLongPress = holder.longPressTriggered;
      boolean tap = !holder.galleryPanMoved && !consumedLongPress;
      holder.galleryPanning = false;
      holder.galleryPanMoved = false;
      holder.longPressTriggered = false;
      cancelStageLongPress(holder);
      setParentInterceptDisallowed(view, false);
      galleryScaleHolder = null;
      if (tap) handleStageTap(holder.index);
      return true;
    }
    if (action == MotionEvent.ACTION_CANCEL) {
      holder.galleryPanning = false;
      holder.galleryPanMoved = false;
      holder.longPressTriggered = false;
      cancelStageLongPress(holder);
      clampGalleryPan(holder);
      setParentInterceptDisallowed(view, false);
      galleryScaleHolder = null;
      return true;
    }
    return true;
  }

  private final class GalleryScaleListener extends ScaleGestureDetector.SimpleOnScaleGestureListener {
    @Override
    public boolean onScaleBegin(ScaleGestureDetector detector) {
      ShortVideoHolder holder = galleryScaleHolder;
      if (holder == null || holder.index < 0 || holder.index >= videos.size() || !videos.get(holder.index).isGallery()) return false;
      if (holder.galleryDragSettling) return false;
      if (holder.galleryDragActive) resetGalleryDrag(holder, true);
      suppressPagerGestureCommit = true;
      holder.galleryScaling = true;
      holder.galleryPanning = false;
      clearPendingStageTap();
      cancelStageLongPress(holder);
      Log.i(TAG, "gallery zoom begin " + holder.index);
      return true;
    }

    @Override
    public boolean onScale(ScaleGestureDetector detector) {
      ShortVideoHolder holder = galleryScaleHolder;
      if (holder == null || !holder.galleryScaling) return false;
      float targetScale = Math.max(1f, Math.min(4f, holder.galleryZoomScale * detector.getScaleFactor()));
      applyGalleryZoom(holder, targetScale, detector.getFocusX(), detector.getFocusY());
      return true;
    }

    @Override
    public void onScaleEnd(ScaleGestureDetector detector) {
      ShortVideoHolder holder = galleryScaleHolder;
      if (holder == null) return;
      holder.galleryScaling = false;
      if (holder.galleryZoomScale < 1.04f) animateGalleryZoomReset(holder, false);
      else clampGalleryPan(holder);
      Log.i(TAG, "gallery zoom end " + holder.index + " scale=" + String.format(Locale.ROOT, "%.2f", holder.galleryZoomScale));
    }
  }

  private void applyGalleryZoom(ShortVideoHolder holder, float targetScale, float focusX, float focusY) {
    float oldScale = Math.max(1f, holder.galleryZoomScale);
    float nextScale = Math.max(1f, Math.min(4f, targetScale));
    float ratio = nextScale / oldScale;
    float centerX = holder.cover.getWidth() / 2f;
    float centerY = holder.cover.getHeight() / 2f;
    float translatedX = holder.cover.getTranslationX() * ratio + (focusX - centerX) * (1f - ratio);
    float translatedY = holder.cover.getTranslationY() * ratio + (focusY - centerY) * (1f - ratio);
    holder.galleryZoomScale = nextScale;
    holder.cover.setPivotX(centerX);
    holder.cover.setPivotY(centerY);
    holder.cover.setScaleX(nextScale);
    holder.cover.setScaleY(nextScale);
    applyGalleryPan(holder, translatedX, translatedY);
    syncGalleryZoomCounter(holder);
  }

  private void applyGalleryPan(ShortVideoHolder holder, float requestedX, float requestedY) {
    float[] bounds = galleryPanBounds(holder);
    holder.cover.setTranslationX(Math.max(-bounds[0], Math.min(bounds[0], requestedX)));
    holder.cover.setTranslationY(Math.max(-bounds[1], Math.min(bounds[1], requestedY)));
  }

  private void clampGalleryPan(ShortVideoHolder holder) {
    applyGalleryPan(holder, holder.cover.getTranslationX(), holder.cover.getTranslationY());
  }

  private float[] galleryPanBounds(ShortVideoHolder holder) {
    float viewWidth = Math.max(1f, holder.cover.getWidth());
    float viewHeight = Math.max(1f, holder.cover.getHeight());
    float contentWidth = viewWidth;
    float contentHeight = viewHeight;
    if (holder.cover.getDrawable() != null
      && holder.cover.getDrawable().getIntrinsicWidth() > 0
      && holder.cover.getDrawable().getIntrinsicHeight() > 0) {
      float drawableWidth = holder.cover.getDrawable().getIntrinsicWidth();
      float drawableHeight = holder.cover.getDrawable().getIntrinsicHeight();
      float fitScale = Math.min(viewWidth / drawableWidth, viewHeight / drawableHeight);
      contentWidth = drawableWidth * fitScale;
      contentHeight = drawableHeight * fitScale;
    }
    return new float[] {
      Math.max(0f, (contentWidth * holder.galleryZoomScale - viewWidth) / 2f),
      Math.max(0f, (contentHeight * holder.galleryZoomScale - viewHeight) / 2f)
    };
  }

  private void animateGalleryZoomReset(ShortVideoHolder holder, boolean announce) {
    if (holder == null) return;
    holder.cover.animate().cancel();
    holder.galleryZoomScale = 1f;
    holder.cover.animate()
      .scaleX(1f)
      .scaleY(1f)
      .translationX(0f)
      .translationY(0f)
      .setDuration(220)
      .setInterpolator(GALLERY_SETTLE_INTERPOLATOR)
      .withEndAction(() -> {
        resetGalleryZoom(holder, false);
        if (announce) showTransientStatus("已恢复原图大小");
        Log.i(TAG, "gallery zoom reset " + holder.index);
      })
      .start();
    syncGalleryZoomCounter(holder);
  }

  private void resetGalleryZoom(ShortVideoHolder holder, boolean clearHolder) {
    if (holder == null) return;
    holder.cover.animate().cancel();
    holder.galleryZoomScale = 1f;
    holder.galleryScaling = false;
    holder.galleryPanning = false;
    holder.galleryPanMoved = false;
    holder.cover.setPivotX(holder.cover.getWidth() / 2f);
    holder.cover.setPivotY(holder.cover.getHeight() / 2f);
    holder.cover.setScaleX(1f);
    holder.cover.setScaleY(1f);
    holder.cover.setTranslationX(0f);
    holder.cover.setTranslationY(0f);
    if (!clearHolder) syncGalleryZoomCounter(holder);
  }

  private void syncGalleryZoomCounter(ShortVideoHolder holder) {
    if (holder == null || holder.index < 0 || holder.index >= videos.size()) return;
    ShortVideoItem item = videos.get(holder.index);
    if (!item.isGallery()) return;
    String scale = holder.galleryZoomScale > 1.01f
      ? " · " + String.format(Locale.ROOT, "%.1f×", holder.galleryZoomScale)
      : "";
    GalleryMedia media = galleryMediaAt(item, holder.galleryIndex);
    String kind = media != null && media.isVideo()
      ? " · 视频播放中"
      : (item.galleryItems.size() > 1 ? " · 4秒自动播放" : "");
    if (item.sound.isPlayable()) kind += " · 配乐";
    holder.galleryCounter.setText("图文 · " + (holder.galleryIndex + 1) + " / " + item.galleryItems.size() + kind + scale);
    holder.galleryCounter.setContentDescription("图文第 " + (holder.galleryIndex + 1) + " 项，共 " + item.galleryItems.size()
      + " 项" + (media != null && media.isVideo() ? "，当前为视频" : "")
      + (item.sound.isPlayable() ? "，包含配乐 " + item.sound.title : "")
      + (holder.galleryZoomScale > 1.01f ? "，当前放大 " + String.format(Locale.ROOT, "%.1f 倍", holder.galleryZoomScale) : ""));
  }

  private boolean updateGalleryDrag(ShortVideoHolder holder, float deltaX) {
    if (!isMultiImageGallery(holder) || holder.galleryDragSettling) return false;
    if (holder.galleryZoomScale > 1.001f) return true;
    ShortVideoItem item = videos.get(holder.index);
    int direction = deltaX < 0 ? 1 : (deltaX > 0 ? -1 : 0);
    if (direction == 0) return true;
    if (!holder.galleryDragActive) {
      clearPendingStageTap();
      holder.galleryCurrentLayer.animate().cancel();
      holder.galleryPreviewLayer.animate().cancel();
      holder.galleryDragActive = true;
      holder.galleryDragVisualX = 0f;
    }
    if (direction != holder.galleryDragDirection) prepareGalleryDragPreview(holder, item, direction);
    int targetIndex = holder.galleryIndex + direction;
    boolean canMove = targetIndex >= 0 && targetIndex < item.galleryItems.size();
    float width = Math.max(1f, holder.stage.getWidth());
    float bounded = Math.signum(deltaX) * Math.min(Math.abs(deltaX), width * 1.06f);
    float visualX = canMove ? bounded : deltaX * 0.22f;
    holder.galleryDragVisualX = visualX;
    holder.galleryCurrentLayer.setTranslationX(visualX);
    if (holder.galleryPreviewLayer.getVisibility() == View.VISIBLE && holder.galleryDragTargetIndex == targetIndex) {
      holder.galleryPreviewLayer.setTranslationX(visualX + (direction > 0 ? width : -width));
    }
    return true;
  }

  private void prepareGalleryDragPreview(ShortVideoHolder holder, ShortVideoItem item, int direction) {
    holder.galleryPreviewLayer.animate().cancel();
    holder.galleryPreviewLayer.setVisibility(View.GONE);
    holder.galleryPreview.setImageDrawable(null);
    holder.galleryPreview.setTag(null);
    holder.galleryDragDirection = direction;
    int targetIndex = holder.galleryIndex + direction;
    holder.galleryDragTargetIndex = targetIndex;
    if (targetIndex < 0 || targetIndex >= item.galleryItems.size()) return;
    String key = galleryCacheKey(item, targetIndex);
    Bitmap cached = frameCache.get(key);
    if (cached == null && targetIndex == 0) cached = frameCache.get(item.id);
    if (cached != null) {
      showGalleryDragPreview(holder, item, targetIndex, direction, key, cached);
      return;
    }
    GalleryMedia media = item.galleryItems.get(targetIndex);
    executor.execute(() -> {
      Bitmap bitmap = loadGalleryMediaFrame(media);
      if (bitmap == null) return;
      frameCache.put(key, bitmap);
      mainHandler.post(() -> showGalleryDragPreview(holder, item, targetIndex, direction, key, bitmap));
    });
  }

  private void showGalleryDragPreview(ShortVideoHolder holder, ShortVideoItem item, int targetIndex, int direction, String key, Bitmap bitmap) {
    if (!holder.galleryDragActive || holder.galleryDragSettling) return;
    if (holder.index < 0 || holder.index >= videos.size() || videos.get(holder.index) != item) return;
    if (holder.galleryDragTargetIndex != targetIndex || holder.galleryDragDirection != direction) return;
    float width = Math.max(1f, holder.stage.getWidth());
    holder.galleryPreview.setTag(key);
    holder.galleryPreview.setImageBitmap(bitmap);
    holder.galleryPreview.setScaleType(ImageView.ScaleType.FIT_CENTER);
    holder.galleryPreviewLayer.setTranslationX(holder.galleryDragVisualX + (direction > 0 ? width : -width));
    holder.galleryPreviewLayer.setVisibility(View.VISIBLE);
  }

  private boolean finishGalleryDrag(ShortVideoHolder holder, float deltaX, float velocityX) {
    if (!isMultiImageGallery(holder)) return false;
    if (!holder.galleryDragActive) return stepGallery(holder.index, deltaX);
    ShortVideoItem item = videos.get(holder.index);
    float rawDelta = deltaX != 0f ? deltaX : holder.galleryDragVisualX;
    int direction = rawDelta < 0 ? 1 : (rawDelta > 0 ? -1 : holder.galleryDragDirection);
    int targetIndex = holder.galleryIndex + direction;
    boolean canMove = direction != 0 && targetIndex >= 0 && targetIndex < item.galleryItems.size();
    float width = Math.max(1f, holder.stage.getWidth());
    boolean distanceReady = Math.abs(rawDelta) >= Math.min(dp(116), width * 0.24f);
    float density = getResources().getDisplayMetrics().density;
    boolean velocityReady = Math.abs(velocityX) >= density * 0.5f
      && Math.signum(velocityX) == Math.signum(rawDelta)
      && Math.abs(rawDelta) >= dp(24);
    if (!canMove && direction != 0 && (distanceReady || velocityReady)) {
      commitGalleryBoundary(holder, item, direction, rawDelta, velocityX);
      return true;
    }
    boolean shouldCommit = canMove && (distanceReady || velocityReady);
    String targetKey = canMove ? galleryCacheKey(item, targetIndex) : "";
    boolean previewReady = shouldCommit
      && holder.galleryPreviewLayer.getVisibility() == View.VISIBLE
      && holder.galleryPreview.getDrawable() != null
      && targetKey.equals(holder.galleryPreview.getTag());
    settleGalleryDrag(holder, item, targetIndex, direction, shouldCommit, previewReady, rawDelta, velocityX);
    return true;
  }

  private void commitGalleryBoundary(ShortVideoHolder holder, ShortVideoItem item, int direction, float deltaX, float velocityX) {
    holder.galleryDragActive = false;
    holder.galleryDragSettling = true;
    holder.galleryPreviewLayer.animate().cancel();
    holder.galleryPreviewLayer.setVisibility(View.GONE);
    float target = direction < 0 ? dp(72) : -dp(72);
    holder.galleryCurrentLayer.animate().cancel();
    holder.galleryCurrentLayer.animate()
      .translationX(target)
      .alpha(0.88f)
      .setDuration(140)
      .setInterpolator(GALLERY_SETTLE_INTERPOLATOR)
      .withEndAction(() -> {
        if (attachedHolders.get(holder.index) != holder || holder.index < 0 || holder.index >= videos.size() || videos.get(holder.index) != item) {
          resetGalleryDrag(holder, true);
          return;
        }
        resetGalleryDrag(holder, true);
        holder.itemView.performHapticFeedback(HapticFeedbackConstants.CLOCK_TICK);
        if (direction < 0) {
          Log.i(TAG, "gallery boundary back " + holder.index + " distance=" + Math.round(Math.abs(deltaX))
            + " velocity=" + String.format(Locale.ROOT, "%.2f", Math.abs(velocityX)));
          navigateBack();
        } else if (isViewingAuthorFeed()) {
          Log.i(TAG, "gallery boundary author blocked " + holder.index);
          showTransientStatus("已在作者页，返回可回到上一层");
        } else {
          Log.i(TAG, "gallery boundary author " + holder.index + " distance=" + Math.round(Math.abs(deltaX))
            + " velocity=" + String.format(Locale.ROOT, "%.2f", Math.abs(velocityX)));
          showAuthorPanel(item);
        }
      })
      .start();
  }

  private float galleryDragVelocity(ShortVideoHolder holder, float deltaX) {
    long elapsedMs = Math.max(1L, SystemClock.uptimeMillis() - holder.touchStartAtMs);
    return deltaX / elapsedMs;
  }

  private void settleGalleryDrag(ShortVideoHolder holder, ShortVideoItem item, int targetIndex, int direction, boolean commit, boolean previewReady, float deltaX, float velocityX) {
    holder.galleryDragActive = false;
    holder.galleryDragSettling = true;
    float width = Math.max(1f, holder.stage.getWidth());
    float coverTarget = commit && previewReady ? (direction > 0 ? -width : width) : 0f;
    float previewTarget = commit && previewReady ? 0f : (direction > 0 ? width : -width);
    if (holder.galleryPreviewLayer.getVisibility() == View.VISIBLE) {
      holder.galleryPreviewLayer.animate()
        .translationX(previewTarget)
        .setDuration(220)
        .setInterpolator(GALLERY_SETTLE_INTERPOLATOR)
        .start();
    }
    holder.galleryCurrentLayer.animate()
      .translationX(coverTarget)
      .setDuration(220)
      .setInterpolator(GALLERY_SETTLE_INTERPOLATOR)
      .withEndAction(() -> {
        if (attachedHolders.get(holder.index) != holder || holder.index < 0 || holder.index >= videos.size() || videos.get(holder.index) != item) {
          resetGalleryDrag(holder, true);
          return;
        }
        if (commit && previewReady && holder.galleryPreview.getDrawable() != null) {
          holder.cover.setImageDrawable(holder.galleryPreview.getDrawable());
          holder.cover.setTag(holder.galleryPreview.getTag());
          holder.galleryIndex = targetIndex;
          galleryPositions.put(item.id, targetIndex);
          resetGalleryZoom(holder, true);
          resetGalleryDrag(holder, true);
          bindGallery(holder, item, targetIndex, 0);
          holder.itemView.performHapticFeedback(HapticFeedbackConstants.CLOCK_TICK);
          Log.i(TAG, "gallery drag commit " + holder.index + " " + (targetIndex + 1) + "/" + item.galleryItems.size()
            + " distance=" + Math.round(Math.abs(deltaX)) + " velocity=" + String.format(Locale.ROOT, "%.2f", Math.abs(velocityX)));
          return;
        }
        resetGalleryDrag(holder, true);
        if (commit) {
          bindGallery(holder, item, targetIndex, direction);
          holder.itemView.performHapticFeedback(HapticFeedbackConstants.CLOCK_TICK);
          Log.i(TAG, "gallery drag commit delayed " + holder.index + " " + (targetIndex + 1) + "/" + item.galleryItems.size());
        } else {
          Log.i(TAG, "gallery drag rebound " + holder.index + " distance=" + Math.round(Math.abs(deltaX)));
        }
      })
      .start();
  }

  private boolean cancelGalleryDrag(ShortVideoHolder holder) {
    if (holder == null || !holder.galleryDragActive || holder.index < 0 || holder.index >= videos.size()) return false;
    ShortVideoItem item = videos.get(holder.index);
    settleGalleryDrag(holder, item, holder.galleryIndex, holder.galleryDragDirection, false, false, holder.galleryDragVisualX, 0f);
    return true;
  }

  private boolean isMultiImageGallery(ShortVideoHolder holder) {
    if (holder == null || holder.index < 0 || holder.index >= videos.size()) return false;
    ShortVideoItem item = videos.get(holder.index);
    return item.isGallery() && item.galleryItems.size() > 1;
  }

  private void resetGalleryDrag(ShortVideoHolder holder, boolean clearPreview) {
    if (holder == null) return;
    holder.galleryCurrentLayer.animate().cancel();
    holder.galleryCurrentLayer.setTranslationX(0f);
    holder.galleryCurrentLayer.setAlpha(1f);
    holder.galleryPreviewLayer.animate().cancel();
    holder.galleryPreviewLayer.setTranslationX(0f);
    holder.galleryPreviewLayer.setAlpha(1f);
    if (clearPreview) {
      holder.galleryPreviewLayer.setVisibility(View.GONE);
      holder.galleryPreview.setImageDrawable(null);
      holder.galleryPreview.setTag(null);
    }
    holder.galleryDragActive = false;
    holder.galleryDragSettling = false;
    holder.galleryDragDirection = 0;
    holder.galleryDragTargetIndex = -1;
    holder.galleryDragVisualX = 0f;
  }

  private void handleHorizontalSwipe(int index, float deltaX) {
    if (index < 0 || index >= videos.size()) return;
    clearPendingStageTap();
    if (stepGallery(index, deltaX)) return;
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

  private boolean stepGallery(int index, float deltaX) {
    if (index < 0 || index >= videos.size()) return false;
    ShortVideoItem item = videos.get(index);
    if (!item.isGallery() || item.galleryItems.size() <= 1) return false;
    ShortVideoHolder holder = attachedHolders.get(index);
    if (holder == null) return true;
    if (holder.galleryZoomScale > 1.001f) {
      animateGalleryZoomReset(holder, true);
      return true;
    }
    int direction = deltaX < 0 ? 1 : -1;
    int target = holder.galleryIndex + direction;
    if (target < 0 || target >= item.galleryItems.size()) {
      commitGalleryBoundary(holder, item, direction, deltaX, galleryDragVelocity(holder, deltaX));
      return true;
    }
    bindGallery(holder, item, target, direction);
    holder.itemView.performHapticFeedback(HapticFeedbackConstants.CLOCK_TICK);
    Log.i(TAG, "gallery media " + index + " " + (target + 1) + "/" + item.galleryItems.size());
    return true;
  }

  private void bindGallery(ShortVideoHolder holder, ShortVideoItem item, int requestedIndex, int direction) {
    if (holder == null || item == null || !item.isGallery()) return;
    cancelGalleryAutoAdvance();
    resetGalleryZoom(holder, true);
    int galleryIndex = Math.max(0, Math.min(requestedIndex, item.galleryItems.size() - 1));
    holder.galleryIndex = galleryIndex;
    galleryPositions.put(item.id, galleryIndex);
    holder.cover.setScaleType(ImageView.ScaleType.FIT_CENTER);
    holder.cover.setVisibility(View.VISIBLE);
    holder.playIndicator.setVisibility(View.GONE);
    syncGalleryZoomCounter(holder);
    rebuildGalleryProgress(holder, item.galleryItems.size(), galleryIndex);
    holder.galleryCounter.setVisibility(!controlsHidden && !item.isSingleLivePhoto() ? View.VISIBLE : View.GONE);
    holder.galleryProgress.setVisibility(!controlsHidden && !item.isSingleLivePhoto()
      && item.galleryItems.size() > 1 && item.galleryItems.size() <= 12
      ? View.VISIBLE
      : View.GONE);
    holder.progressTouch.setVisibility(View.GONE);
    GalleryMedia media = galleryMediaAt(item, galleryIndex);
    if (media != null && media.isVideo()) {
      holder.cover.setScaleType(videoFitMode ? ImageView.ScaleType.FIT_CENTER : ImageView.ScaleType.CENTER_CROP);
      holder.galleryVideo.setResizeMode(activeVideoResizeMode());
      holder.cover.setImageDrawable(null);
      holder.cover.setBackgroundColor(Color.BLACK);
      loadGalleryFrame(holder, item, galleryIndex, direction);
      playGallerySegment(holder, item, galleryIndex);
    } else {
      if (gallerySegmentFeedIndex == holder.index || gallerySegmentView == holder.galleryVideo) {
        stopGallerySegmentPlayback(holder, false);
      }
      holder.galleryVideo.setVisibility(View.GONE);
      loadGalleryImage(holder, item, galleryIndex, direction);
      scheduleGalleryAutoAdvance(holder, item, galleryIndex);
    }
    prefetchGalleryMedia(item, galleryIndex - 1);
    prefetchGalleryMedia(item, galleryIndex + 1);
  }

  private void rebuildGalleryProgress(ShortVideoHolder holder, int count, int activeIndex) {
    holder.galleryProgress.removeAllViews();
    if (count <= 1 || count > 12) return;
    for (int index = 0; index < count; index++) {
      View segment = new View(this);
      int color = index == activeIndex ? Color.WHITE : (index < activeIndex ? 0xA3FFFFFF : 0x52FFFFFF);
      segment.setBackground(roundedDrawable(color, dp(2)));
      LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(0, index == activeIndex ? dp(5) : dp(3), 1f);
      params.leftMargin = index == 0 ? 0 : dp(2);
      params.rightMargin = index == count - 1 ? 0 : dp(2);
      params.gravity = Gravity.CENTER_VERTICAL;
      holder.galleryProgress.addView(segment, params);
    }
  }

  private void loadGalleryImage(ShortVideoHolder holder, ShortVideoItem item, int galleryIndex, int direction) {
    if (galleryIndex < 0 || galleryIndex >= item.galleryItems.size()) return;
    String key = galleryCacheKey(item, galleryIndex);
    String url = item.galleryItems.get(galleryIndex).url;
    holder.cover.setTag(key);
    Bitmap cached = frameCache.get(key);
    if (cached == null && galleryIndex == 0) cached = frameCache.get(item.id);
    if (cached != null) {
      showGalleryBitmap(holder, item, galleryIndex, cached, direction);
      return;
    }
    executor.execute(() -> {
      Bitmap bitmap = loadBitmap(url, PLAYER_COVER_MAX_WIDTH, PLAYER_COVER_MAX_HEIGHT);
      if (bitmap == null) return;
      frameCache.put(key, bitmap);
      mainHandler.post(() -> showGalleryBitmap(holder, item, galleryIndex, bitmap, direction));
    });
  }

  private void loadGalleryFrame(ShortVideoHolder holder, ShortVideoItem item, int galleryIndex, int direction) {
    if (galleryIndex < 0 || galleryIndex >= item.galleryItems.size()) return;
    String key = galleryCacheKey(item, galleryIndex);
    GalleryMedia media = item.galleryItems.get(galleryIndex);
    holder.cover.setTag(key);
    Bitmap cached = frameCache.get(key);
    if (cached != null) {
      showGalleryBitmap(holder, item, galleryIndex, cached, direction);
      return;
    }
    executor.execute(() -> {
      Bitmap bitmap = loadGalleryMediaFrame(media);
      if (bitmap == null) return;
      frameCache.put(key, bitmap);
      mainHandler.post(() -> showGalleryBitmap(holder, item, galleryIndex, bitmap, direction));
    });
  }

  private void showGalleryBitmap(ShortVideoHolder holder, ShortVideoItem item, int galleryIndex, Bitmap bitmap, int direction) {
    if (holder.index < 0 || holder.index >= videos.size()) return;
    if (videos.get(holder.index) != item || holder.galleryIndex != galleryIndex) return;
    Object liveTag = holder.cover.getTag();
    if (!galleryCacheKey(item, galleryIndex).equals(liveTag)) return;
    holder.galleryCurrentLayer.animate().cancel();
    holder.cover.setImageBitmap(bitmap);
    holder.galleryCurrentLayer.setAlpha(direction == 0 ? 1f : 0.72f);
    holder.galleryCurrentLayer.setTranslationX(direction == 0 ? 0f : (direction > 0 ? dp(72) : -dp(72)));
    holder.galleryCurrentLayer.animate().alpha(1f).translationX(0f).setDuration(direction == 0 ? 0 : 220).start();
  }

  private void scheduleGalleryAutoAdvance(ShortVideoHolder holder, ShortVideoItem item, int mediaIndex) {
    if (holder == null || item == null || holder.index != currentIndex || item.galleryItems.size() <= 1) return;
    cancelGalleryAutoAdvance();
    GalleryMedia media = galleryMediaAt(item, mediaIndex);
    if (media == null || media.isVideo()) return;
    galleryAutoAdvanceFeedIndex = holder.index;
    galleryAutoAdvanceMediaIndex = mediaIndex;
    galleryAutoAdvanceRunnable = () -> {
      Runnable liveRunnable = galleryAutoAdvanceRunnable;
      galleryAutoAdvanceRunnable = null;
      if (liveRunnable == null) return;
      int feedIndex = galleryAutoAdvanceFeedIndex;
      int liveMediaIndex = galleryAutoAdvanceMediaIndex;
      galleryAutoAdvanceFeedIndex = -1;
      galleryAutoAdvanceMediaIndex = -1;
      ShortVideoHolder liveHolder = attachedHolders.get(feedIndex);
      if (liveHolder == null || currentIndex != feedIndex || liveHolder.galleryIndex != liveMediaIndex) return;
      if (!activityResumed || authorOverlay != null || commentsOpen() || playbackToolbarOverlay != null
        || liveHolder.touchActive || liveHolder.galleryScaling || liveHolder.galleryPanning
        || liveHolder.galleryDragActive || liveHolder.galleryDragSettling || liveHolder.galleryZoomScale > 1.001f) {
        scheduleGalleryAutoAdvance(liveHolder, item, liveMediaIndex);
        return;
      }
      advanceGallerySequence(feedIndex, liveMediaIndex, "image");
    };
    mainHandler.postDelayed(galleryAutoAdvanceRunnable, GALLERY_IMAGE_AUTO_ADVANCE_MS);
    Log.i(TAG, "gallery auto scheduled " + holder.index + " " + (mediaIndex + 1) + "/" + item.galleryItems.size());
  }

  private void resumeGalleryAutoAdvanceIfNeeded() {
    if (currentIndex < 0 || currentIndex >= videos.size()) return;
    ShortVideoItem item = videos.get(currentIndex);
    if (!item.isGallery()) return;
    ShortVideoHolder holder = attachedHolders.get(currentIndex);
    if (holder == null) return;
    GalleryMedia media = galleryMediaAt(item, holder.galleryIndex);
    if (media != null && !media.isVideo() && holder.cover.getDrawable() != null) {
      scheduleGalleryAutoAdvance(holder, item, holder.galleryIndex);
    }
  }

  private void cancelGalleryAutoAdvance() {
    if (galleryAutoAdvanceRunnable != null) mainHandler.removeCallbacks(galleryAutoAdvanceRunnable);
    galleryAutoAdvanceRunnable = null;
    galleryAutoAdvanceFeedIndex = -1;
    galleryAutoAdvanceMediaIndex = -1;
  }

  private void advanceGallerySequence(int feedIndex, int mediaIndex, String source) {
    if (feedIndex < 0 || feedIndex >= videos.size() || currentIndex != feedIndex) return;
    ShortVideoItem item = videos.get(feedIndex);
    ShortVideoHolder holder = attachedHolders.get(feedIndex);
    if (!item.isGallery() || item.galleryItems.size() <= 1 || holder == null || holder.galleryIndex != mediaIndex) return;
    if (!activityResumed || authorOverlay != null || commentsOpen() || playbackToolbarOverlay != null) {
      if ("image".equals(source)) scheduleGalleryAutoAdvance(holder, item, mediaIndex);
      return;
    }
    int nextIndex = (mediaIndex + 1) % item.galleryItems.size();
    bindGallery(holder, item, nextIndex, 1);
    Log.i(TAG, "gallery auto " + source + " " + feedIndex + " " + (mediaIndex + 1) + "->" + (nextIndex + 1)
      + "/" + item.galleryItems.size());
  }

  private void prefetchGalleryMedia(ShortVideoItem item, int galleryIndex) {
    if (item == null || galleryIndex < 0 || galleryIndex >= item.galleryItems.size()) return;
    String key = galleryCacheKey(item, galleryIndex);
    if (frameCache.get(key) != null) return;
    GalleryMedia media = item.galleryItems.get(galleryIndex);
    executor.execute(() -> {
      Bitmap bitmap = loadGalleryMediaFrame(media);
      if (bitmap != null) frameCache.put(key, bitmap);
    });
  }

  private Bitmap loadGalleryMediaFrame(GalleryMedia media) {
    if (media == null || media.url.length() == 0) return null;
    if (media.posterUrl.length() > 0) {
      Bitmap poster = loadBitmap(media.posterUrl, PLAYER_COVER_MAX_WIDTH, PLAYER_COVER_MAX_HEIGHT);
      if (poster != null) return poster;
    }
    return media.isVideo()
      ? extractFirstFrame(media.url)
      : loadBitmap(media.url, PLAYER_COVER_MAX_WIDTH, PLAYER_COVER_MAX_HEIGHT);
  }

  @Nullable
  private GalleryMedia galleryMediaAt(ShortVideoItem item, int index) {
    if (item == null || index < 0 || index >= item.galleryItems.size()) return null;
    return item.galleryItems.get(index);
  }

  private String galleryCacheKey(ShortVideoItem item, int galleryIndex) {
    return "gallery:" + item.id + ":" + galleryIndex;
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
    activateLike(item, showBurst, Float.NaN, Float.NaN, true);
  }

  private void activateLike(ShortVideoItem item, boolean showBurst, float tapX, float tapY, boolean showStatus) {
    if (item == null || item.id.length() == 0) return;
    boolean wasLiked = isLiked(item);
    requestVideoAction(item, NativeShortVideoActionState.Type.LIKE, true, showStatus);
    if (showBurst) showLikeBurst(item, tapX, tapY);
    if (showStatus && wasLiked) showTransientStatus("已点赞");
  }

  private void toggleLike(ShortVideoItem item) {
    if (item == null || item.id.length() == 0) return;
    requestVideoAction(item, NativeShortVideoActionState.Type.LIKE, !isLiked(item), true);
  }

  private long displayLikes(ShortVideoItem item) {
    return item == null ? 0 : item.likes;
  }

  private boolean isLiked(ShortVideoItem item) {
    return item != null && actionState.active(item.id, NativeShortVideoActionState.Type.LIKE, item.userLiked);
  }

  private void toggleCollected(ShortVideoItem item) {
    if (item == null || item.id.length() == 0) return;
    requestVideoAction(item, NativeShortVideoActionState.Type.COLLECT, !isCollected(item), true);
  }

  private long displayCollects(ShortVideoItem item) {
    return item == null ? 0 : item.collects;
  }

  private boolean isCollected(ShortVideoItem item) {
    return item != null && actionState.active(item.id, NativeShortVideoActionState.Type.COLLECT, item.userCollected);
  }

  private void requestVideoAction(ShortVideoItem item, NativeShortVideoActionState.Type type, boolean active, boolean showStatus) {
    NativeShortVideoActionState.Mutation mutation = actionState.request(item.id, type, serverAction(item, type), active);
    persistActionState();
    refreshVisibleRails();
    if (showStatus) {
      String action = type == NativeShortVideoActionState.Type.LIKE ? (active ? "已点赞" : "已取消点赞") : (active ? "已收藏" : "已取消收藏");
      String pending = actionState.pending(item.id, type) ? "，正在同步" : "";
      showTransientStatus(action + pending);
    }
    dispatchVideoAction(mutation);
  }

  private void syncPendingVideoActions(boolean announce) {
    if (actionServerScope.length() == 0 || destroying) return;
    for (NativeShortVideoActionState.Stored stored : actionState.snapshot()) {
      dispatchVideoAction(actionState.resume(stored.videoId, stored.type));
    }
    if (announce && actionState.pendingCount() > 0) showTransientStatus("正在同步 " + actionState.pendingCount() + " 项本机互动");
  }

  private void dispatchVideoAction(@Nullable NativeShortVideoActionState.Mutation mutation) {
    if (mutation == null || destroying || actionServerScope.length() == 0) return;
    String endpoint = actionEndpoint(mutation.videoId, mutation.type);
    if (endpoint.length() == 0) return;
    executor.execute(() -> {
      try {
        JSONObject payload = new JSONObject();
        payload.put("active", mutation.active);
        JSONObject data = requestJson(endpoint, "PUT", payload);
        mainHandler.post(() -> {
          if (destroying || isFinishing()) return;
          applyVideoActionSuccess(mutation, data);
        });
      } catch (Exception error) {
        mainHandler.post(() -> {
          if (destroying || isFinishing()) return;
          applyVideoActionFailure(mutation);
        });
      }
    });
  }

  private void applyVideoActionSuccess(NativeShortVideoActionState.Mutation mutation, JSONObject data) {
    JSONObject updated = data == null ? null : data.optJSONObject("video");
    JSONObject updatedActions = updated == null ? null : updated.optJSONObject("actions");
    boolean active = updatedActions != null
      ? updatedActions.optBoolean(mutation.type == NativeShortVideoActionState.Type.LIKE ? "liked" : "collected", mutation.active)
      : data != null && data.optBoolean("active", mutation.active);
    applyServerActionSnapshot(mutation.videoId, updated, mutation.type, active);
    NativeShortVideoActionState.Completion completion = actionState.completeSuccess(mutation, active);
    clearAcknowledgedLegacyActions();
    persistActionState();
    refreshVisibleRails();
    dispatchVideoAction(completion.next);
  }

  private void applyVideoActionFailure(NativeShortVideoActionState.Mutation mutation) {
    NativeShortVideoActionState.Completion completion = actionState.completeFailure(mutation);
    persistActionState();
    refreshVisibleRails();
    if (completion.rolledBack) {
      String label = mutation.type == NativeShortVideoActionState.Type.LIKE ? "点赞" : "收藏";
      showTransientStatus(label + "未同步，已恢复服务器状态");
    }
    dispatchVideoAction(completion.next);
  }

  private void applyServerActionSnapshot(String videoId, @Nullable JSONObject updated, NativeShortVideoActionState.Type type, boolean fallbackActive) {
    JSONObject actions = updated == null ? null : updated.optJSONObject("actions");
    JSONObject stats = updated == null ? null : updated.optJSONObject("stats");
    boolean liked = actions == null ? (type == NativeShortVideoActionState.Type.LIKE ? fallbackActive : false) : actions.optBoolean("liked", false);
    boolean collected = actions == null ? (type == NativeShortVideoActionState.Type.COLLECT ? fallbackActive : false) : actions.optBoolean("collected", false);
    for (ShortVideoItem item : videos) {
      if (!videoId.equals(item.id)) continue;
      item.userLiked = liked;
      item.userCollected = collected;
      if (stats != null) {
        item.likes = Math.max(0, stats.optLong("likes", item.likes));
        item.collects = Math.max(0, stats.optLong("collects", item.collects));
      }
    }
  }

  private boolean serverAction(ShortVideoItem item, NativeShortVideoActionState.Type type) {
    return item != null && (type == NativeShortVideoActionState.Type.LIKE ? item.userLiked : item.userCollected);
  }

  private String actionEndpoint(String videoId, NativeShortVideoActionState.Type type) {
    if (!NativeShortVideoActionState.isServerVideoId(videoId) || actionServerScope.length() == 0) return "";
    return actionServerScope + "/api/short-videos/" + Uri.encode(videoId) + "/actions/" + type.wireName;
  }

  private String videoInteractionKey(ShortVideoItem item) {
    if (item == null) return "";
    if (item.id.length() > 0) return item.id;
    if (item.awemeId.length() > 0) return "aweme:" + item.awemeId;
    if (item.streamUrl.length() > 0) return "stream:" + item.streamUrl;
    return "";
  }

  private void initializeActionState() {
    actionServerScope = NativeShortVideoActionState.serverScope(apiBase());
    SharedPreferences prefs = getSharedPreferences(PREFS_NAME, MODE_PRIVATE);
    actionState = new NativeShortVideoActionState(readStoredActionStates(prefs, actionServerScope));
    if (actionServerScope.length() == 0) return;
    String legacyScope = prefs.getString(PREF_LEGACY_ACTION_SCOPE, "");
    if (legacyScope.length() == 0) {
      // Old releases did not retain an origin. Bind their one-time migration to
      // the first current server only; later server switches never reuse it.
      prefs.edit().putString(PREF_LEGACY_ACTION_SCOPE, actionServerScope).apply();
    }
  }

  private List<NativeShortVideoActionState.Stored> readStoredActionStates(SharedPreferences prefs, String scope) {
    List<NativeShortVideoActionState.Stored> stored = new ArrayList<>();
    if (scope == null || scope.length() == 0) return stored;
    String encoded = prefs.getString(PREF_ACTION_STATE_PREFIX + scope, "");
    try {
      JSONArray rows = new JSONArray(encoded == null ? "[]" : encoded);
      for (int index = 0; index < rows.length() && stored.size() < NativeShortVideoActionState.MAX_STORED_ACTIONS; index++) {
        JSONObject row = rows.optJSONObject(index);
        if (row == null) continue;
        stored.add(new NativeShortVideoActionState.Stored(
          row.optString("videoId", ""),
          NativeShortVideoActionState.Type.fromWireName(row.optString("type", "")),
          row.optBoolean("confirmed", false),
          row.optBoolean("desired", false),
          row.optBoolean("legacy", false)
        ));
      }
    } catch (Exception ignored) {}
    return stored;
  }

  private void persistActionState() {
    if (actionServerScope.length() == 0) return;
    JSONArray rows = new JSONArray();
    for (NativeShortVideoActionState.Stored stored : actionState.snapshot()) {
      JSONObject row = new JSONObject();
      try {
        row.put("videoId", stored.videoId);
        row.put("type", stored.type.wireName);
        row.put("confirmed", stored.confirmed);
        row.put("desired", stored.desired);
        row.put("legacy", stored.legacy);
        rows.put(row);
      } catch (Exception ignored) {}
    }
    getSharedPreferences(PREFS_NAME, MODE_PRIVATE).edit()
      .putString(PREF_ACTION_STATE_PREFIX + actionServerScope, rows.toString())
      .apply();
  }

  private void reconcileServerActionSnapshots(List<ShortVideoItem> items) {
    if (items == null || actionServerScope.length() == 0) return;
    SharedPreferences prefs = getSharedPreferences(PREFS_NAME, MODE_PRIVATE);
    boolean migrateLegacy = actionServerScope.equals(prefs.getString(PREF_LEGACY_ACTION_SCOPE, ""));
    for (ShortVideoItem item : items) {
      if (item == null || item.id.length() == 0) continue;
      if (migrateLegacy) {
        if (legacyActionMatches(prefs, item, PREF_LIKED_VIDEO_KEYS)) actionState.importLegacy(item.id, NativeShortVideoActionState.Type.LIKE);
        if (legacyActionMatches(prefs, item, PREF_COLLECTED_VIDEO_KEYS)) actionState.importLegacy(item.id, NativeShortVideoActionState.Type.COLLECT);
      }
      actionState.observeServer(item.id, NativeShortVideoActionState.Type.LIKE, item.userLiked);
      actionState.observeServer(item.id, NativeShortVideoActionState.Type.COLLECT, item.userCollected);
    }
    clearAcknowledgedLegacyActions();
    persistActionState();
  }

  private boolean legacyActionMatches(SharedPreferences prefs, ShortVideoItem item, String preferenceKey) {
    Set<String> legacy = prefs.getStringSet(preferenceKey, Collections.emptySet());
    if (legacy == null || legacy.isEmpty()) return false;
    return legacy.contains(item.id)
      || legacy.contains(item.awemeId)
      || legacy.contains("aweme:" + item.awemeId);
  }

  private void clearAcknowledgedLegacyActions() {
    List<NativeShortVideoActionState.Stored> acknowledged = actionState.drainAcknowledgedLegacy();
    if (acknowledged.isEmpty()) return;
    SharedPreferences prefs = getSharedPreferences(PREFS_NAME, MODE_PRIVATE);
    Set<String> likes = new HashSet<>(prefs.getStringSet(PREF_LIKED_VIDEO_KEYS, Collections.emptySet()));
    Set<String> collects = new HashSet<>(prefs.getStringSet(PREF_COLLECTED_VIDEO_KEYS, Collections.emptySet()));
    for (NativeShortVideoActionState.Stored stored : acknowledged) {
      ShortVideoItem item = findVideoById(stored.videoId);
      removeLegacyActionKeys(stored.type == NativeShortVideoActionState.Type.LIKE ? likes : collects, stored.videoId, item == null ? "" : item.awemeId);
    }
    SharedPreferences.Editor editor = prefs.edit()
      .putStringSet(PREF_LIKED_VIDEO_KEYS, likes)
      .putStringSet(PREF_COLLECTED_VIDEO_KEYS, collects);
    if (likes.isEmpty() && collects.isEmpty()) editor.remove(PREF_LEGACY_ACTION_SCOPE);
    editor.apply();
  }

  private void removeLegacyActionKeys(Set<String> values, String videoId, String awemeId) {
    values.remove(videoId);
    if (awemeId != null && awemeId.length() > 0) {
      values.remove(awemeId);
      values.remove("aweme:" + awemeId);
    }
  }

  private void clearLegacyActionsForDeletedVideos(List<ShortVideoItem> source, Set<String> ids) {
    if (source == null || ids == null || ids.isEmpty()) return;
    SharedPreferences prefs = getSharedPreferences(PREFS_NAME, MODE_PRIVATE);
    Set<String> likes = new HashSet<>(prefs.getStringSet(PREF_LIKED_VIDEO_KEYS, Collections.emptySet()));
    Set<String> collects = new HashSet<>(prefs.getStringSet(PREF_COLLECTED_VIDEO_KEYS, Collections.emptySet()));
    for (ShortVideoItem item : source) {
      if (item == null || !ids.contains(item.id)) continue;
      removeLegacyActionKeys(likes, item.id, item.awemeId);
      removeLegacyActionKeys(collects, item.id, item.awemeId);
    }
    prefs.edit().putStringSet(PREF_LIKED_VIDEO_KEYS, likes).putStringSet(PREF_COLLECTED_VIDEO_KEYS, collects).apply();
  }

  @Nullable
  private ShortVideoItem findVideoById(String videoId) {
    for (ShortVideoItem item : videos) if (videoId.equals(item.id)) return item;
    return null;
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
    return item != null && item.authorFollowing;
  }

  private void toggleFollowingAuthor(ShortVideoItem item) {
    toggleFollowingAuthor(item, null);
  }

  private void toggleFollowingAuthor(ShortVideoItem item, @Nullable Runnable onChange) {
    String key = authorInteractionKey(item);
    if (key.length() == 0) {
      showTransientStatus("这个视频没有作者信息");
      return;
    }
    String endpoint = authorFollowEndpoint(item);
    if (endpoint.length() == 0) {
      showTransientStatus("关注状态暂时无法同步");
      return;
    }
    if (!pendingAuthorFollowKeys.add(key)) return;
    boolean wasFollowing = isFollowingAuthor(item);
    boolean nextFollowing = !wasFollowing;
    applyAuthorFollowingState(item, nextFollowing);
    if (onChange != null) onChange.run();
    refreshVisibleRails();
    executor.execute(() -> {
      try {
        JSONObject payload = new JSONObject();
        payload.put("active", nextFollowing);
        JSONObject data = requestJson(endpoint, "PUT", payload);
        boolean following = data.optBoolean("active", nextFollowing);
        mainHandler.post(() -> {
          pendingAuthorFollowKeys.remove(key);
          applyAuthorFollowingState(item, following);
          if (onChange != null) onChange.run();
          refreshVisibleRails();
          showTransientStatus(following ? "已关注 " + displayAuthor(item) : "已取关 " + displayAuthor(item));
        });
      } catch (Exception error) {
        mainHandler.post(() -> {
          pendingAuthorFollowKeys.remove(key);
          applyAuthorFollowingState(item, wasFollowing);
          if (onChange != null) onChange.run();
          refreshVisibleRails();
          showTransientStatus("关注状态保存失败");
        });
      }
    });
  }

  private void applyAuthorFollowingState(ShortVideoItem item, boolean following) {
    String key = authorInteractionKey(item);
    item.authorFollowing = following;
    for (ShortVideoItem candidate : videos) {
      if (key.equals(authorInteractionKey(candidate))) candidate.authorFollowing = following;
    }
    if (following) followedAuthorKeys.add(key);
    else followedAuthorKeys.remove(key);
    persistVideoInteractionKeys(PREF_FOLLOWED_AUTHOR_KEYS, followedAuthorKeys);
  }

  private String authorFollowEndpoint(ShortVideoItem item) {
    if (item == null || apiBaseUrl == null) return "";
    String target = item.authorId.length() > 0 ? item.authorId : item.authorSecUid;
    if (target.length() == 0) return "";
    String base = apiBaseUrl.trim();
    while (base.endsWith("/")) base = base.substring(0, base.length() - 1);
    return base.length() == 0 ? "" : base + "/api/short-videos/authors/" + Uri.encode(target) + "/follow";
  }

  private JSONObject requestJson(String endpoint, String method, @Nullable JSONObject payload) throws Exception {
    HttpURLConnection connection = null;
    try {
      connection = (HttpURLConnection) new URL(endpoint).openConnection();
      connection.setRequestMethod(method);
      connection.setConnectTimeout(8000);
      connection.setReadTimeout(12000);
      connection.setRequestProperty("Accept", "application/json");
      if (payload != null) {
        byte[] bytes = payload.toString().getBytes(StandardCharsets.UTF_8);
        connection.setDoOutput(true);
        connection.setRequestProperty("Content-Type", "application/json; charset=utf-8");
        connection.setFixedLengthStreamingMode(bytes.length);
        connection.getOutputStream().write(bytes);
      }
      int status = connection.getResponseCode();
      String body = NativeShortVideoHttpResponse.readUtf8(connection, status >= 200 && status < 300);
      JSONObject data = body.length() > 0 ? new JSONObject(body) : new JSONObject();
      if (status < 200 || status >= 300) {
        String message = data.optString("error", "");
        throw new Exception(message.length() > 0 ? message : "请求失败");
      }
      return data;
    } finally {
      if (connection != null) connection.disconnect();
    }
  }

  private void bindFollowButton(TextView button, ShortVideoItem item) {
    if (button == null) return;
    boolean following = isFollowingAuthor(item);
    button.setText(following ? "已关注" : "已取关");
    button.setTextColor(following ? 0xFF161823 : Color.WHITE);
    button.setBackground(roundedDrawable(following ? 0xFFEFF1F5 : 0xFFFE2C55, dp(8)));
    button.setContentDescription((following ? "取消关注 " : "关注 ") + displayAuthor(item));
  }

  private void showLikeBurst(ShortVideoItem item, float tapX, float tapY) {
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
    int burstSize = dp(116);
    int[] rootLocation = new int[2];
    holder.itemView.getLocationOnScreen(rootLocation);
    float centerX = Float.isNaN(tapX) ? holder.itemView.getWidth() / 2f : tapX - rootLocation[0];
    float centerY = Float.isNaN(tapY) ? holder.itemView.getHeight() / 2f : tapY - rootLocation[1];
    FrameLayout.LayoutParams burstParams = (FrameLayout.LayoutParams) burst.getLayoutParams();
    burstParams.gravity = Gravity.TOP | Gravity.LEFT;
    burstParams.leftMargin = Math.round(Math.max(0f, Math.min(holder.itemView.getWidth() - burstSize, centerX - burstSize / 2f)));
    burstParams.topMargin = Math.round(Math.max(0f, Math.min(holder.itemView.getHeight() - burstSize, centerY - burstSize / 2f)));
    burst.setLayoutParams(burstParams);
    burst.setTranslationX(0f);
    burst.setTranslationY(0f);
    burst.setRotation((((int) (centerX + centerY)) & 1) == 0 ? -10f : 10f);
    Log.i(TAG, "like burst tap=" + Math.round(tapX) + "," + Math.round(tapY)
      + " local=" + Math.round(centerX) + "," + Math.round(centerY)
      + " root=" + holder.itemView.getWidth() + "x" + holder.itemView.getHeight());
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
        .withEndAction(() -> {
          burst.setVisibility(View.GONE);
          burst.setRotation(0f);
        })
        .start())
      .start();
  }

  private void resetLikeBurst(ShortVideoHolder holder) {
    holder.likeBurst.animate().cancel();
    holder.likeBurst.setVisibility(View.GONE);
    holder.likeBurst.setAlpha(0f);
    holder.likeBurst.setScaleX(0.62f);
    holder.likeBurst.setScaleY(0.62f);
    holder.likeBurst.setRotation(0f);
  }

  private void setControlsHidden(boolean hidden, boolean showToast) {
    if (controlsHidden == hidden && !showToast) return;
    controlsHidden = hidden;
    for (ShortVideoHolder holder : attachedHolders.values()) applyControlsVisibility(holder);
    if (showToast) showTransientStatus(hidden ? "已清屏，点一下恢复控件" : "已显示控件");
  }

  private void applyControlsVisibility(ShortVideoHolder holder) {
    int visibility = controlsHidden ? View.GONE : View.VISIBLE;
    ShortVideoItem item = holder.index >= 0 && holder.index < videos.size() ? videos.get(holder.index) : null;
    boolean gallery = item != null && item.isGallery();
    boolean singleLivePhoto = gallery && item.isSingleLivePhoto();
    int galleryCount = gallery ? item.galleryItems.size() : 0;
    holder.caption.setVisibility(visibility);
    holder.rail.setVisibility(visibility);
    holder.progressTouch.setVisibility(gallery ? View.GONE : visibility);
    holder.galleryCounter.setVisibility(gallery && !singleLivePhoto && !controlsHidden ? View.VISIBLE : View.GONE);
    holder.galleryProgress.setVisibility(gallery && !singleLivePhoto && !controlsHidden && galleryCount > 1 && galleryCount <= 12
      ? View.VISIBLE
      : View.GONE);
    ExoPlayer visiblePlayer = gallery && gallerySegmentFeedIndex == holder.index
      ? gallerySegmentPlayer
      : playerCache.get(holder.index);
    syncPlayIndicator(holder.index, visiblePlayer);
    if (topSearchButton != null) topSearchButton.setVisibility(visibility);
    if (topBackButton != null) topBackButton.setVisibility(visibility);
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
    String time = new SimpleDateFormat("HH:mm", Locale.CHINA).format(new Date());
    int battery = -1;
    try {
      BatteryManager manager = (BatteryManager) getSystemService(BATTERY_SERVICE);
      if (manager != null) battery = manager.getIntProperty(BatteryManager.BATTERY_PROPERTY_CAPACITY);
    } catch (Exception ignored) {}
    topInfoView.setText(battery >= 0 ? time + "  " + battery + "%" : time);
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
    if (videos.size() - index > 4) return;
    NativeShortVideoFeedPaging.Request request = feedPaging.beginLoadMore(pendingFeedUrl, nextFeedCursor, hasMoreVideos);
    if (request == null) return;
    loadingMoreVideos = true;
    String feedUrl = pagedFeedUrl(pendingFeedUrl, nextFeedOffset, nextFeedCursor, FEED_PAGE_LIMIT);
    Log.i(TAG, "load more offset=" + nextFeedOffset + " cursor=" + (nextFeedCursor.length() > 0));
    executor.execute(() -> {
      NativeShortVideoFeedPaging.ReadResult<FeedPage> result = readFeedPage(feedUrl);
      mainHandler.post(() -> {
        NativeShortVideoFeedPaging.Completion completion = feedPaging.complete(request, result);
        if (completion == NativeShortVideoFeedPaging.Completion.STALE) return;
        loadingMoreVideos = feedPaging.isLoading();
        if (completion == NativeShortVideoFeedPaging.Completion.FAILED) {
          showTransientStatus(result == null ? "短视频服务暂时不可用，请重试" : result.publicMessage());
          return;
        }
        FeedPage page = result.value;
        nextFeedOffset = page.nextOffset();
        nextFeedCursor = page.nextCursor;
        hasMoreVideos = page.hasMore;
        Set<String> seen = new HashSet<>();
        for (ShortVideoItem video : videos) seen.add(video.id);
        int inserted = 0;
        for (ShortVideoItem item : page.items) {
          if (seen.contains(item.id)) continue;
          seen.add(item.id);
          videos.add(item);
          inserted++;
        }
        reconcileServerActionSnapshots(videos);
        syncPendingVideoActions(false);
        if (inserted > 0) {
          adapter.notifyItemRangeInserted(videos.size() - inserted, inserted);
          prepareAround(currentIndex);
          preparePlayersAround(currentIndex);
          scheduleVideoPrefetch(currentIndex + 1);
        }
        NativeShortVideoFeedAutoAdvance.Action autoAdvance = NativeShortVideoFeedAutoAdvance.resolve(
          feedPaging,
          index,
          currentIndex,
          videos.size()
        );
        if (autoAdvance == NativeShortVideoFeedAutoAdvance.Action.ADVANCE) {
          hideStatus();
          pager.setCurrentItem(index + 1, true);
        } else if (autoAdvance == NativeShortVideoFeedAutoAdvance.Action.END) {
          hideStatus();
          advanceAfterEnded(index);
        } else if (autoAdvance == NativeShortVideoFeedAutoAdvance.Action.LOAD_MORE) {
          showStatus("正在加载下一条");
          loadMoreIfNeeded(index);
        }
        Log.i(TAG, "loaded more inserted=" + inserted + " nextOffset=" + nextFeedOffset + " nextCursor=" + (nextFeedCursor.length() > 0) + " hasMore=" + hasMoreVideos);
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
      String body = NativeShortVideoHttpResponse.readUtf8(connection, status >= 200 && status < 300);
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
    feedPaging.clearPendingAutoAdvance();
    loadingMoreVideos = false;
    for (String id : ids) actionState.removeVideo(id);
    clearLegacyActionsForDeletedVideos(before, ids);
    persistActionState();
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
        showStatus("正在读取下一批短视频");
        loadFeedAsync(pagedFeedUrl(pendingFeedUrl, nextFeedOffset, nextFeedCursor, FEED_PAGE_LIMIT), 0);
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
    for (int i = index - 1; i <= index + 1; i++) bindFrame(i);
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
    if (item.isGallery()) {
      if (holder != null) bindGallery(holder, item, galleryPositions.getOrDefault(item.id, 0), 0);
      else prefetchGalleryMedia(item, galleryPositions.getOrDefault(item.id, 0));
      return;
    }
    if (holder != null && applyCachedFrame(holder, item)) return;
    if (holder == null && frameCache.get(item.id) != null) return;
    if (item.coverUrl.length() > 0) {
      loadCover(index, item);
      return;
    }
    if (!pendingFrameIds.add(item.id)) return;
    executor.execute(() -> {
      try {
        Bitmap bitmap = extractFirstFrame(item.streamUrl);
        if (bitmap == null) return;
        frameCache.put(item.id, bitmap);
        Bitmap finalBitmap = bitmap;
        mainHandler.post(() -> {
          ShortVideoHolder live = attachedHolders.get(index);
          if (live != null) applyVideoFrame(live, item, finalBitmap);
        });
      } finally {
        pendingFrameIds.remove(item.id);
      }
    });
  }

  private boolean applyCachedFrame(ShortVideoHolder holder, ShortVideoItem item) {
    Bitmap cached = frameCache.get(item.id);
    if (cached == null) return false;
    applyVideoFrame(holder, item, cached);
    return true;
  }

  private void applyVideoFrame(ShortVideoHolder holder, ShortVideoItem item, Bitmap bitmap) {
    if (holder == null || item == null || bitmap == null) return;
    holder.cover.setImageBitmap(bitmap);
    holder.videoBackdrop.setImageBitmap(bitmap);
    holder.cover.setScaleType(videoFitMode ? ImageView.ScaleType.FIT_CENTER : ImageView.ScaleType.CENTER_CROP);
    holder.videoBackdrop.setVisibility(View.GONE);
  }

  private void loadCover(int index, ShortVideoItem item) {
    if (!pendingFrameIds.add(item.id)) return;
    executor.execute(() -> {
      try {
        Bitmap bitmap = loadBitmap(item.coverUrl, PLAYER_COVER_MAX_WIDTH, PLAYER_COVER_MAX_HEIGHT);
        if (bitmap == null) return;
        frameCache.put(item.id, bitmap);
        mainHandler.post(() -> {
          ShortVideoHolder holder = attachedHolders.get(index);
          if (holder != null && holder.index == index) applyVideoFrame(holder, item, bitmap);
        });
      } finally {
        pendingFrameIds.remove(item.id);
      }
    });
  }

  private Bitmap extractFirstFrame(String url) {
    MediaMetadataRetriever retriever = new MediaMetadataRetriever();
    try {
      retriever.setDataSource(url, new HashMap<>());
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
        return retriever.getScaledFrameAtTime(
          0,
          MediaMetadataRetriever.OPTION_CLOSEST_SYNC,
          PLAYER_COVER_MAX_WIDTH,
          PLAYER_COVER_MAX_HEIGHT
        );
      }
      return scaleBitmapToFit(
        retriever.getFrameAtTime(0, MediaMetadataRetriever.OPTION_CLOSEST_SYNC),
        PLAYER_COVER_MAX_WIDTH,
        PLAYER_COVER_MAX_HEIGHT
      );
    } catch (Exception ignored) {
      return null;
    } finally {
      try {
        retriever.release();
      } catch (Exception ignored) {}
    }
  }

  private Bitmap loadBitmap(String url, int maxWidth, int maxHeight) {
    HttpURLConnection connection = null;
    try {
      connection = (HttpURLConnection) new URL(url).openConnection();
      connection.setConnectTimeout(5000);
      connection.setReadTimeout(8000);
      connection.setRequestProperty("Accept", "image/*");
      connection.connect();
      byte[] bytes = NativeShortVideoImageLoader.read(connection);
      BitmapFactory.Options bounds = new BitmapFactory.Options();
      bounds.inJustDecodeBounds = true;
      BitmapFactory.decodeByteArray(bytes, 0, bytes.length, bounds);
      BitmapFactory.Options options = new BitmapFactory.Options();
      options.inSampleSize = bitmapSampleSize(bounds.outWidth, bounds.outHeight, maxWidth, maxHeight);
      return scaleBitmapToFit(
        BitmapFactory.decodeByteArray(bytes, 0, bytes.length, options),
        maxWidth,
        maxHeight
      );
    } catch (Exception ignored) {
      return null;
    } finally {
      if (connection != null) connection.disconnect();
    }
  }

  private int bitmapSampleSize(int width, int height, int maxWidth, int maxHeight) {
    int sample = 1;
    while (width / (sample * 2) >= maxWidth && height / (sample * 2) >= maxHeight) sample *= 2;
    return sample;
  }

  @Nullable
  private Bitmap scaleBitmapToFit(@Nullable Bitmap bitmap, int maxWidth, int maxHeight) {
    if (bitmap == null || bitmap.getWidth() <= 0 || bitmap.getHeight() <= 0) return bitmap;
    float scale = Math.min(1f, Math.min(maxWidth / (float) bitmap.getWidth(), maxHeight / (float) bitmap.getHeight()));
    if (scale >= 1f) return bitmap;
    int width = Math.max(1, Math.round(bitmap.getWidth() * scale));
    int height = Math.max(1, Math.round(bitmap.getHeight() * scale));
    Bitmap scaled = Bitmap.createScaledBitmap(bitmap, width, height, true);
    if (scaled != bitmap) bitmap.recycle();
    return scaled;
  }

  private void readVideos() {
    String baseUrl = getIntent().getStringExtra(EXTRA_BASE_URL);
    String json = getIntent().getStringExtra(EXTRA_VIDEOS_JSON);
    if (json == null) return;
    try {
      videos.addAll(ShortVideoFeedContract.decode(json, baseUrl));
    } catch (Exception error) {
      Log.e(TAG, "Unable to decode initial short-video feed", error);
    }
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
    videoFitMode = prefs.getBoolean(PREF_VIDEO_FIT_MODE, true);
    autoNext = prefs.getBoolean(PREF_AUTO_NEXT, false);
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

  private void toggleVideoFitMode() {
    videoFitMode = !videoFitMode;
    writeControlPreference(PREF_VIDEO_FIT_MODE, videoFitMode);
    applyVideoFitModeToPlayers();
    showTransientStatus(videoFitMode ? "画面已切换为自适应，完整显示视频" : "画面已切换为裁切，铺满屏幕");
  }

  private void toggleAutoNext() {
    autoNext = !autoNext;
    writeControlPreference(PREF_AUTO_NEXT, autoNext);
    feedPaging.clearPendingAutoAdvance();
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
    if (gallerySegmentPlayer != null) {
      ShortVideoItem galleryItem = gallerySegmentFeedIndex >= 0 && gallerySegmentFeedIndex < videos.size() ? videos.get(gallerySegmentFeedIndex) : null;
      gallerySegmentPlayer.setRepeatMode(galleryItem != null && galleryItem.isSingleLivePhoto() ? Player.REPEAT_MODE_ONE : Player.REPEAT_MODE_OFF);
      gallerySegmentPlayer.setVolume(0f);
    }
    if (gallerySoundPlayer != null) {
      gallerySoundPlayer.setRepeatMode(Player.REPEAT_MODE_ONE);
      gallerySoundPlayer.setVolume(activeVolume());
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
    long replacementGeneration = feedPaging.beginFeedReplacement(normalizedFeedUrl);
    executor.execute(() -> {
      NativeShortVideoFeedPaging.ReadResult<FeedPage> result = readFeedPage(normalizedFeedUrl);
      mainHandler.post(() -> {
        if (!feedPaging.finishFeedReplacement(replacementGeneration, normalizedFeedUrl)) return;
        if (!result.succeeded()) {
          loadingMoreVideos = false;
          showStatus(result.publicMessage());
          return;
        }
        FeedPage page = result.value;
        videos.clear();
        videos.addAll(page.items);
        reconcileServerActionSnapshots(videos);
        syncPendingVideoActions(false);
        nextFeedOffset = page.nextOffset();
        nextFeedCursor = page.nextCursor;
        hasMoreVideos = page.hasMore;
        feedPaging.replaceFeed(normalizedFeedUrl, nextFeedCursor, hasMoreVideos);
        currentScreen = captureFeedScreen();
        adapter.notifyDataSetChanged();
        if (videos.isEmpty()) {
          showStatus("暂无短视频");
        } else {
          int safeIndex = Math.max(0, Math.min(startIndex, videos.size() - 1));
          if (openAuthorPanelOnStart) openInitialAuthorScreen(safeIndex);
          else startPlaybackAt(safeIndex);
        }
      });
    });
  }

  private String normalizeFeedUrl(String feedUrl) {
    String normalized = String.valueOf(feedUrl == null ? "" : feedUrl).replace("%26", "&");
    if (!normalized.contains("limit=")) {
      normalized += normalized.contains("?") ? "&limit=" + FEED_PAGE_LIMIT : "?limit=" + FEED_PAGE_LIMIT;
    }
    return normalized;
  }

  private String pagedFeedUrl(String feedUrl, int offset, String cursor, int limit) {
    Uri uri = Uri.parse(normalizeFeedUrl(feedUrl));
    Uri.Builder builder = uri.buildUpon().clearQuery();
    try {
      for (String name : uri.getQueryParameterNames()) {
        if ("offset".equals(name) || "cursor".equals(name) || "limit".equals(name)) continue;
        List<String> values = uri.getQueryParameters(name);
        if (values.isEmpty()) builder.appendQueryParameter(name, "");
        else for (String value : values) builder.appendQueryParameter(name, value);
      }
    } catch (Exception ignored) {}
    String normalizedCursor = cursor == null ? "" : cursor.trim();
    if (normalizedCursor.length() > 0) builder.appendQueryParameter("cursor", normalizedCursor);
    else builder.appendQueryParameter("offset", String.valueOf(Math.max(0, offset)));
    builder.appendQueryParameter("limit", String.valueOf(Math.max(1, limit)));
    return builder.build().toString();
  }

  private NativeShortVideoFeedPaging.ReadResult<FeedPage> readFeedPage(String feedUrl) {
    return feedReader.read(feedUrl);
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
    cancelGalleryAutoAdvance();
    if (activePlayer != null) {
      activePlayer.pause();
      stopProgressUpdates();
    }
    if (gallerySoundPlayer != null) gallerySoundPlayer.pause();
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
    title.setGravity(Gravity.CENTER);
    LinearLayout.LayoutParams titleParams = new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f);
    top.addView(title, titleParams);
    top.addView(new View(this), new LinearLayout.LayoutParams(dp(42), dp(42)));
    sheet.addView(top, new LinearLayout.LayoutParams(
      ViewGroup.LayoutParams.MATCH_PARENT,
      ViewGroup.LayoutParams.WRAP_CONTENT
    ));

    LinearLayout profileSection = new LinearLayout(this);
    profileSection.setOrientation(LinearLayout.VERTICAL);
    profileSection.setBackgroundColor(0xFFF7F8FA);
    sheet.addView(profileSection, new LinearLayout.LayoutParams(
      ViewGroup.LayoutParams.MATCH_PARENT,
      ViewGroup.LayoutParams.WRAP_CONTENT
    ));

    FrameLayout hero = new FrameLayout(this);
    hero.setBackgroundColor(0xFFF7F8FA);

    LinearLayout heroIdentity = new LinearLayout(this);
    heroIdentity.setOrientation(LinearLayout.HORIZONTAL);
    heroIdentity.setGravity(Gravity.CENTER_VERTICAL);
    heroIdentity.setPadding(dp(16), dp(8), dp(16), dp(8));
    FrameLayout heroAvatarShell = new FrameLayout(this);
    heroAvatarShell.setBackground(circleDrawable(Color.WHITE));
    heroAvatarShell.addView(authorAvatarView(seed, dp(74)), new FrameLayout.LayoutParams(dp(74), dp(74), Gravity.CENTER));
    heroIdentity.addView(heroAvatarShell, new LinearLayout.LayoutParams(dp(80), dp(80)));
    LinearLayout heroInfo = new LinearLayout(this);
    heroInfo.setOrientation(LinearLayout.VERTICAL);
    heroInfo.setGravity(Gravity.CENTER_VERTICAL);
    heroInfo.setPadding(dp(12), 0, 0, 0);
    TextView heroName = new TextView(this);
    heroName.setText(displayAuthor(seed));
    heroName.setTextColor(0xFF161823);
    heroName.setTextSize(21);
    heroName.setTypeface(Typeface.DEFAULT_BOLD);
    heroName.setSingleLine(true);
    heroName.setEllipsize(TextUtils.TruncateAt.END);
    TextView heroHandle = new TextView(this);
    heroHandle.setText(authorHandleText(seed));
    heroHandle.setTextColor(0xFF8A8F99);
    heroHandle.setTextSize(12);
    heroHandle.setPadding(0, dp(5), 0, 0);
    heroHandle.setSingleLine(true);
    heroHandle.setEllipsize(TextUtils.TruncateAt.END);
    heroInfo.addView(heroName);
    heroInfo.addView(heroHandle);
    heroIdentity.addView(heroInfo, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.MATCH_PARENT, 1f));
    hero.addView(heroIdentity, new FrameLayout.LayoutParams(
      ViewGroup.LayoutParams.MATCH_PARENT,
      ViewGroup.LayoutParams.MATCH_PARENT
    ));
    profileSection.addView(hero, new LinearLayout.LayoutParams(
      ViewGroup.LayoutParams.MATCH_PARENT,
      dp(112)
    ));

    LinearLayout head = new LinearLayout(this);
    head.setOrientation(LinearLayout.VERTICAL);
    head.setPadding(dp(14), dp(4), dp(14), dp(5));

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
    profileSection.addView(head);

    final LinearLayout profileStats = authorProfileStatsRow(seed);
    if (profileStats != null) {
      profileStats.setPadding(dp(14), dp(4), dp(14), dp(4));
      LinearLayout.LayoutParams profileStatsParams = new LinearLayout.LayoutParams(
        ViewGroup.LayoutParams.MATCH_PARENT,
        ViewGroup.LayoutParams.WRAP_CONTENT
      );
      profileStatsParams.bottomMargin = dp(6);
      profileSection.addView(profileStats, profileStatsParams);
    }

    final boolean shouldLoadInitialAuthorPage = screen.page == null || screen.page.items.isEmpty();
    final FeedPage[] pageRef = new FeedPage[] { shouldLoadInitialAuthorPage ? sortedLocalAuthorPage(seed, screen.sort) : screen.page.copy() };
    final String[] activeTab = new String[] { screen.activeTab == null ? "works" : screen.activeTab };
    final Runnable[] render = new Runnable[1];
    final boolean[] profileCollapsed = new boolean[] { screen.worksScrollY >= dp(192) };
    final int[] profileExpandedHeight = new int[] { 0 };
    final ValueAnimator[] profileAnimator = new ValueAnimator[1];
    final int[] profileTransitionGestureId = new int[] { -1 };
    final long[] profileTransitionBlockedUntil = new long[] { 0L };
    final Runnable[] updateAuthorChrome = new Runnable[1];

    LinearLayout actions = new LinearLayout(this);
    actions.setOrientation(LinearLayout.HORIZONTAL);
    actions.setGravity(Gravity.CENTER);
    LinearLayout.LayoutParams actionsParams = new LinearLayout.LayoutParams(
      ViewGroup.LayoutParams.MATCH_PARENT,
      dp(42)
    );
    actionsParams.leftMargin = dp(14);
    actionsParams.rightMargin = dp(14);
    actionsParams.bottomMargin = dp(6);
    profileSection.addView(actions, actionsParams);

    TextView follow = authorActionButton("", true, authorInteractionKey(seed).length() > 0, null);
    follow.setOnClickListener(view -> {
      toggleFollowingAuthor(seed, () -> bindFollowButton(follow, seed));
    });
    bindFollowButton(follow, seed);
    LinearLayout.LayoutParams followParams = new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.MATCH_PARENT, 1.35f);
    followParams.rightMargin = dp(6);
    actions.addView(follow, followParams);

    TextView filter = authorActionButton("只看TA", false, seed.authorSecUid.length() > 0, view -> switchToAuthorFeed(screen));
    LinearLayout.LayoutParams filterParams = new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.MATCH_PARENT, .85f);
    filterParams.rightMargin = dp(6);
    actions.addView(filter, filterParams);

    String authorProfileUrl = authorOriginalUrl(seed);
    TextView douyin = authorActionButton("抖音主页", false, authorProfileUrl.length() > 0, view -> openAuthorOriginal(seed));
    actions.addView(douyin, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.MATCH_PARENT, .85f));

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
    LinearLayout.LayoutParams sortParams = new LinearLayout.LayoutParams(dp(100), dp(30));
    sortParams.gravity = Gravity.CENTER_VERTICAL;
    tabBar.addView(sortButton, sortParams);
    sheet.addView(tabBar, new LinearLayout.LayoutParams(
      ViewGroup.LayoutParams.MATCH_PARENT,
      dp(40)
    ));

    updateAuthorChrome[0] = () -> {
      if (profileAnimator[0] != null && profileAnimator[0].isRunning()) return;
      long now = System.currentTimeMillis();
      if (now < profileTransitionBlockedUntil[0]) {
        profileTransitionGestureId[0] = screen.worksGestureId;
        return;
      }
      boolean worksTab = "works".equals(activeTab[0]);
      boolean freshGesture = screen.worksGestureId > 0
        && screen.worksGestureId != profileTransitionGestureId[0];
      boolean shouldCollapse = worksTab
        && !profileCollapsed[0]
        && freshGesture
        && screen.worksGestureDirection < 0
        && screen.worksScrollY >= dp(160);
      boolean shouldExpand = profileCollapsed[0]
        && (!worksTab || (freshGesture && screen.worksGestureDirection > 0 && screen.worksScrollY <= dp(8)));
      if (!shouldCollapse && !shouldExpand) return;
      profileCollapsed[0] = shouldCollapse;
      if (worksTab) profileTransitionGestureId[0] = screen.worksGestureId;
      profileTransitionBlockedUntil[0] = now + 520L;
      title.setText(profileCollapsed[0] ? displayAuthor(seed) : "主页");
      if (shouldExpand && worksTab) resetAuthorWorksScrollToTop(screen);
      animateAuthorProfileSection(profileSection, profileCollapsed[0], profileExpandedHeight, profileAnimator);
      if (shouldExpand && worksTab) {
        profileSection.postDelayed(() -> {
          if (!profileCollapsed[0]) resetAuthorWorksScrollToTop(screen);
        }, 240L);
        profileSection.postDelayed(() -> {
          if (!profileCollapsed[0]) resetAuthorWorksScrollToTop(screen);
        }, 420L);
      }
    };

    profileSection.post(() -> {
      if (profileSection.getHeight() > 0) profileExpandedHeight[0] = profileSection.getHeight();
      if (!profileCollapsed[0]) return;
      ViewGroup.LayoutParams params = profileSection.getLayoutParams();
      params.height = 0;
      profileSection.setLayoutParams(params);
      profileSection.setAlpha(0f);
      profileSection.setTranslationY(-dp(12));
      profileSection.setVisibility(View.INVISIBLE);
      title.setText(displayAuthor(seed));
    });

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

    String authorUrl = authorFeedUrl(seed, 0, AUTHOR_PAGE_LIMIT, screen.sort);
    if (shouldLoadInitialAuthorPage && authorUrl.length() > 0) {
      executor.execute(() -> {
        NativeShortVideoFeedPaging.ReadResult<FeedPage> result = readFeedPage(authorUrl);
        mainHandler.post(() -> {
          if (authorOverlay != overlay) return;
          if (!result.succeeded()) {
            showTransientStatus(result.publicMessage());
            return;
          }
          FeedPage loaded = result.value;
          if (loaded.items.isEmpty()) return;
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

  private void animateAuthorProfileSection(
    LinearLayout section,
    boolean collapsed,
    int[] expandedHeightRef,
    ValueAnimator[] animatorRef
  ) {
    if (section == null || expandedHeightRef == null || animatorRef == null) return;
    if (animatorRef[0] != null) animatorRef[0].cancel();

    int currentHeight = Math.max(0, section.getHeight());
    if (!collapsed && currentHeight == 0 && expandedHeightRef[0] <= 0) {
      ViewGroup.LayoutParams measureParams = section.getLayoutParams();
      measureParams.height = ViewGroup.LayoutParams.WRAP_CONTENT;
      section.setLayoutParams(measureParams);
      section.setVisibility(View.VISIBLE);
      section.post(() -> {
        if (section.getHeight() > 0) expandedHeightRef[0] = section.getHeight();
        animateAuthorProfileSection(section, false, expandedHeightRef, animatorRef);
      });
      return;
    }

    if (collapsed && currentHeight > 0) {
      expandedHeightRef[0] = Math.max(expandedHeightRef[0], currentHeight);
    }
    int targetHeight = collapsed ? 0 : Math.max(1, expandedHeightRef[0]);
    if (currentHeight == targetHeight) {
      section.setVisibility(collapsed ? View.INVISIBLE : View.VISIBLE);
      section.setAlpha(collapsed ? 0f : 1f);
      section.setTranslationY(collapsed ? -dp(12) : 0f);
      return;
    }

    section.setVisibility(View.VISIBLE);
    ValueAnimator animator = ValueAnimator.ofInt(currentHeight, targetHeight);
    animatorRef[0] = animator;
    animator.setDuration(190);
    animator.setInterpolator(GALLERY_SETTLE_INTERPOLATOR);
    animator.addUpdateListener(valueAnimator -> {
      int height = (Integer) valueAnimator.getAnimatedValue();
      ViewGroup.LayoutParams params = section.getLayoutParams();
      params.height = height;
      section.setLayoutParams(params);
      float progress = expandedHeightRef[0] <= 0 ? (collapsed ? 0f : 1f) : Math.min(1f, height / (float) expandedHeightRef[0]);
      section.setAlpha(progress);
      section.setTranslationY(-dp(12) * (1f - progress));
    });
    animator.addListener(new AnimatorListenerAdapter() {
      @Override
      public void onAnimationEnd(Animator animation) {
        if (animatorRef[0] != animator) return;
        ViewGroup.LayoutParams params = section.getLayoutParams();
        params.height = collapsed ? 0 : ViewGroup.LayoutParams.WRAP_CONTENT;
        section.setLayoutParams(params);
        section.setVisibility(collapsed ? View.INVISIBLE : View.VISIBLE);
        section.setAlpha(collapsed ? 0f : 1f);
        section.setTranslationY(collapsed ? -dp(12) : 0f);
        Log.i(TAG, "author profile " + (collapsed ? "collapsed" : "expanded"));
        animatorRef[0] = null;
      }
    });
    animator.start();
  }

  private void resetAuthorWorksScrollToTop(AuthorScreenState screen) {
    if (screen == null || screen.worksScrollView == null) return;
    ScrollView scroll = screen.worksScrollView;
    screen.worksScrollY = 0;
    scroll.fling(0);
    scroll.requestFocus(View.FOCUS_UP);
    scroll.fullScroll(View.FOCUS_UP);
    scroll.scrollTo(0, 0);
    scroll.postOnAnimation(() -> {
      if (screen.worksScrollView != scroll) return;
      screen.worksScrollY = 0;
      scroll.fullScroll(View.FOCUS_UP);
      scroll.scrollTo(0, 0);
    });
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
    String url = authorFeedUrl(screen.seed, 0, AUTHOR_PAGE_LIMIT, screen.sort);
    if (url.length() == 0) {
      pageRef[0] = sortedLocalAuthorPage(screen.seed, screen.sort);
      if (render[0] != null) render[0].run();
      return;
    }
    showStatus("正在按" + authorSortLabel(screen.sort) + "排序");
    executor.execute(() -> {
      NativeShortVideoFeedPaging.ReadResult<FeedPage> result = readFeedPage(url);
      mainHandler.post(() -> {
        hideStatus();
        if (!result.succeeded()) {
          showTransientStatus(result.publicMessage());
          return;
        }
        FeedPage loaded = result.value;
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
    String url = authorFeedUrl(screen.seed, offset, AUTHOR_PAGE_LIMIT, screen.sort);
    if (url.length() == 0) return;
    screen.loadingMore = true;
    Log.i(TAG, "load author more author=" + displayAuthor(screen.seed) + " offset=" + offset + " sort=" + screen.sort);
    if (render[0] != null) render[0].run();
    executor.execute(() -> {
      NativeShortVideoFeedPaging.ReadResult<FeedPage> result = readFeedPage(url);
      mainHandler.post(() -> {
        screen.loadingMore = false;
        if (!result.succeeded()) {
          showTransientStatus(result.publicMessage());
          if (render[0] != null) render[0].run();
          return;
        }
        FeedPage loaded = result.value;
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
          current.nextCursor = loaded.nextCursor;
          current.stats = loaded.stats == null || loaded.stats.isEmpty() ? FeedStats.fromItems(current.items) : loaded.stats;
          Log.i(TAG, "author loaded more inserted=" + inserted + " nextOffset=" + current.nextOffset() + " hasMore=" + current.hasMore);
        } else {
          current.hasMore = loaded.hasMore;
          current.nextCursor = loaded.nextCursor;
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

  private View authorTabButton(String label, String value, String activeTab, AuthorTabCallback callback) {
    boolean active = value.equals(activeTab);
    FrameLayout cell = new FrameLayout(this);
    TextView button = new TextView(this);
    button.setText(label);
    button.setTextColor(active ? 0xFF161823 : 0xFF8A8F99);
    button.setTextSize(15);
    button.setTypeface(Typeface.DEFAULT_BOLD);
    button.setGravity(Gravity.CENTER);
    button.setBackgroundColor(Color.TRANSPARENT);
    cell.addView(button, new FrameLayout.LayoutParams(
      ViewGroup.LayoutParams.MATCH_PARENT,
      ViewGroup.LayoutParams.MATCH_PARENT
    ));
    if (active) {
      View indicator = new View(this);
      indicator.setBackground(roundedDrawable(0xFFFE2C55, dp(2)));
      FrameLayout.LayoutParams indicatorParams = new FrameLayout.LayoutParams(dp(24), dp(3), Gravity.BOTTOM | Gravity.CENTER_HORIZONTAL);
      cell.addView(indicator, indicatorParams);
    }
    cell.setClickable(true);
    cell.setOnClickListener(view -> callback.onTab(value));
    return cell;
  }

  private View authorTabContent(AuthorScreenState screen, FeedPage page, String tab, Runnable loadMore, @Nullable Runnable onAuthorScroll) {
    if ("stats".equals(tab)) return authorStatsContent(screen, page);
    return authorWorksContent(screen, page, loadMore, onAuthorScroll);
  }

  private View authorWorksContent(AuthorScreenState screen, FeedPage page, Runnable loadMore, @Nullable Runnable onAuthorScroll) {
    ScrollView scroll = new ScrollView(this) {
      private float lastTouchY;

      @Override
      public boolean dispatchTouchEvent(MotionEvent event) {
        int action = event.getActionMasked();
        if (action == MotionEvent.ACTION_DOWN) {
          screen.worksGestureId += 1;
          screen.worksGestureDirection = 0;
          lastTouchY = event.getY();
        } else if (action == MotionEvent.ACTION_MOVE) {
          float deltaY = event.getY() - lastTouchY;
          if (Math.abs(deltaY) >= dp(2)) {
            screen.worksGestureDirection = deltaY > 0f ? 1 : -1;
            lastTouchY = event.getY();
          }
        }
        return super.dispatchTouchEvent(event);
      }
    };
    screen.worksScrollView = scroll;
    scroll.setDescendantFocusability(ViewGroup.FOCUS_BLOCK_DESCENDANTS);
    scroll.setFillViewport(false);
    scroll.setVerticalScrollBarEnabled(false);
    scroll.setOverScrollMode(View.OVER_SCROLL_NEVER);
    scroll.setBackgroundColor(0xFFF7F8FA);
    LinearLayout wrap = new LinearLayout(this);
    wrap.setOrientation(LinearLayout.VERTICAL);
    GridLayout grid = new GridLayout(this);
    grid.setColumnCount(3);
    int gridHorizontalPadding = dp(17);
    grid.setPadding(gridHorizontalPadding, dp(6), gridHorizontalPadding, dp(8));
    int screenWidth = getResources().getDisplayMetrics().widthPixels;
    int tileWidth = Math.max(dp(92), (screenWidth - gridHorizontalPadding * 2) / 3);
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

  private View authorStatsContent(AuthorScreenState screen, FeedPage page) {
    ShortVideoItem seed = currentAuthorItem(screen);
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
    if (screen.hasPlaybackContext && seed != null) {
      wrap.addView(statRow("当前视频", shortTitle(seed.title)));
    }
    scroll.addView(wrap, new ScrollView.LayoutParams(
      ViewGroup.LayoutParams.MATCH_PARENT,
      ViewGroup.LayoutParams.WRAP_CONTENT
    ));
    return scroll;
  }

  private View authorVideoTile(ShortVideoItem item, int width, FeedPage page, AuthorScreenState screen) {
    boolean current = screen.hasPlaybackContext && isSameVideo(item, currentAuthorItem(screen));
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
    boolean liked = isLiked(item);
    LinearLayout badge = new LinearLayout(this);
    badge.setOrientation(LinearLayout.HORIZONTAL);
    badge.setGravity(Gravity.CENTER_VERTICAL);
    badge.setBackgroundColor(Color.TRANSPARENT);

    ImageView heart = new ImageView(this);
    heart.setImageResource(liked ? R.drawable.ic_short_heart : R.drawable.ic_short_heart_outline);
    heart.setImageTintList(ColorStateList.valueOf(liked ? 0xFFFF2C55 : Color.WHITE));
    heart.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_NO);
    badge.addView(heart, new LinearLayout.LayoutParams(dp(17), dp(17)));

    TextView likeCount = new TextView(this);
    likeCount.setText(compact(displayLikes(item)));
    likeCount.setTextColor(Color.WHITE);
    likeCount.setTextSize(11);
    likeCount.setTypeface(Typeface.DEFAULT_BOLD);
    likeCount.setIncludeFontPadding(false);
    LinearLayout.LayoutParams likeCountParams = new LinearLayout.LayoutParams(
      ViewGroup.LayoutParams.WRAP_CONTENT,
      ViewGroup.LayoutParams.WRAP_CONTENT
    );
    likeCountParams.leftMargin = dp(3);
    badge.addView(likeCount, likeCountParams);
    FrameLayout.LayoutParams badgeParams = new FrameLayout.LayoutParams(
      ViewGroup.LayoutParams.WRAP_CONTENT,
      ViewGroup.LayoutParams.WRAP_CONTENT,
      Gravity.LEFT | Gravity.BOTTOM
    );
    badgeParams.leftMargin = dp(6);
    badgeParams.bottomMargin = dp(6);
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
    String url = authorFeedUrl(authorScreen.seed, 0, AUTHOR_PAGE_LIMIT, authorScreen.sort);
    if (url.length() == 0) return;
    pushCurrentScreen();
    FeedPage feed = page.copy();
    if (feed.items.isEmpty()) feed.items.add(item);
    int target = findVideoIndex(feed.items, item.id);
    if (target < 0) {
      feed.items.add(item);
      target = feed.items.size() - 1;
    }
    renderFeedScreen(new FeedScreenState(feed.items, url, feed.nextOffset(), feed.nextCursor, feed.hasMore, target));
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
    String url = authorFeedUrl(authorScreen.seed, 0, AUTHOR_PAGE_LIMIT, authorScreen.sort);
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
    renderFeedScreen(new FeedScreenState(feed.items, url, feed.nextOffset(), feed.nextCursor, feed.hasMore, Math.max(0, startIndex)));
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
      .appendQueryParameter("stats", "0")
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
      Bitmap bitmap = loadBitmap(url, THUMBNAIL_MAX_SIZE, THUMBNAIL_MAX_SIZE);
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
    holder.rail.addView(metric(R.drawable.ic_short_comment, item.comments, false, "评论", view -> commentsController.show(item)));
    holder.rail.addView(metric(R.drawable.ic_short_star, displayCollects(item), isCollected(item), "收藏", view -> toggleCollected(item), 0xFFFFD54F));
    holder.rail.addView(metric(R.drawable.ic_short_share, item.shares, false, "分享", view -> shareVideo(item)));
    if (item.isGallery() && item.sound.isPlayable()) {
      holder.rail.addView(railAction(android.R.drawable.ic_lock_silent_mode_off, muted ? "静音" : "配乐", view -> toggleMuted()));
    }
  }

  private void pauseForCommentsOverlay() {
    cancelGalleryAutoAdvance();
    commentsPausedIndex = currentIndex;
    commentsPausedVideo = activePlayer;
    commentsPausedGallerySegment = gallerySegmentPlayer;
    commentsPausedGallerySound = gallerySoundPlayer;
    commentsResumeVideo = commentsPausedVideo != null && commentsPausedVideo.isPlaying();
    commentsResumeGallerySegment = commentsPausedGallerySegment != null && commentsPausedGallerySegment.isPlaying();
    commentsResumeGallerySound = commentsPausedGallerySound != null && commentsPausedGallerySound.isPlaying();
    if (commentsPausedVideo != null) commentsPausedVideo.pause();
    if (commentsPausedGallerySegment != null) commentsPausedGallerySegment.pause();
    if (commentsPausedGallerySound != null) commentsPausedGallerySound.pause();
    stopProgressUpdates();
    Log.i(TAG, "comments open index=" + commentsPausedIndex + " video=" + commentsResumeVideo
      + " segment=" + commentsResumeGallerySegment + " sound=" + commentsResumeGallerySound);
  }

  private void resumeAfterCommentsOverlay(boolean restorePlayback) {
    ExoPlayer pausedVideo = commentsPausedVideo;
    ExoPlayer pausedSegment = commentsPausedGallerySegment;
    ExoPlayer pausedSound = commentsPausedGallerySound;
    boolean resumeVideo = commentsResumeVideo;
    boolean resumeSegment = commentsResumeGallerySegment;
    boolean resumeSound = commentsResumeGallerySound;
    int pausedIndex = commentsPausedIndex;
    commentsPausedVideo = null;
    commentsPausedGallerySegment = null;
    commentsPausedGallerySound = null;
    commentsResumeVideo = false;
    commentsResumeGallerySegment = false;
    commentsResumeGallerySound = false;
    commentsPausedIndex = -1;
    boolean sameWork = restorePlayback && activityResumed && currentIndex == pausedIndex && authorOverlay == null;
    if (sameWork && resumeVideo && pausedVideo == activePlayer) pausedVideo.play();
    if (sameWork && resumeSegment && pausedSegment == gallerySegmentPlayer) pausedSegment.play();
    if (sameWork && resumeSound && pausedSound == gallerySoundPlayer) pausedSound.play();
    if (sameWork && resumeVideo) startProgressUpdates();
    if (sameWork) resumeGalleryAutoAdvanceIfNeeded();
    Log.i(TAG, "comments close restore=" + sameWork + " video=" + resumeVideo
      + " segment=" + resumeSegment + " sound=" + resumeSound);
  }

  private void suppressPlaybackAccessibility(boolean suppressed) {
    int descendants = suppressed ? View.IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS : View.IMPORTANT_FOR_ACCESSIBILITY_AUTO;
    int single = suppressed ? View.IMPORTANT_FOR_ACCESSIBILITY_NO : View.IMPORTANT_FOR_ACCESSIBILITY_AUTO;
    if (pager != null) pager.setImportantForAccessibility(descendants);
    if (topSearchButton != null) topSearchButton.setImportantForAccessibility(single);
    if (topBackButton != null) topBackButton.setImportantForAccessibility(single);
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
    ShortVideoHolder holder = attachedHolders.get(currentIndex);
    GalleryMedia activeGalleryMedia = item.isGallery() && holder != null ? galleryMediaAt(item, holder.galleryIndex) : null;
    if (item.isGallery() && (activeGalleryMedia == null || !activeGalleryMedia.isVideo())) {
      boolean zoomed = holder != null && holder.galleryZoomScale > 1.001f;
      Runnable zoomAction = () -> {
        dismissPlaybackToolbar();
        ShortVideoHolder live = attachedHolders.get(currentIndex);
        if (live == null || currentIndex < 0 || currentIndex >= videos.size() || !videos.get(currentIndex).isGallery()) return;
        if (live.galleryZoomScale > 1.001f) animateGalleryZoomReset(live, true);
        else {
          applyGalleryZoom(live, 2.5f, live.cover.getWidth() / 2f, live.cover.getHeight() / 2f);
          showTransientStatus("已放大到 2.5 倍，拖动查看细节");
        }
      };
      toolbarActions.add(zoomAction);
      row.addView(toolbarButton(android.R.drawable.ic_menu_zoom, zoomed ? "复位" : "放大", zoomed ? "原图" : "看细节", zoomed, view -> zoomAction.run()));
    } else {
      Runnable muteAction = () -> {
        dismissPlaybackToolbar();
        toggleMuted();
      };
      toolbarActions.add(muteAction);
      row.addView(toolbarButton(
        muted ? android.R.drawable.ic_lock_silent_mode : android.R.drawable.ic_lock_silent_mode_off,
        muted ? "开声" : "静音",
        muted ? "静音中" : "有声",
        muted,
        view -> muteAction.run()
      ));

      Runnable fitModeAction = () -> {
        dismissPlaybackToolbar();
        toggleVideoFitMode();
      };
      toolbarActions.add(fitModeAction);
      row.addView(toolbarButton(
        android.R.drawable.ic_menu_view,
        videoFitMode ? "自适应" : "裁切",
        videoFitMode ? "点按裁切" : "点按适应",
        videoFitMode,
        view -> fitModeAction.run()
      ));
    }

    Runnable autoNextAction = () -> {
      dismissPlaybackToolbar();
      toggleAutoNext();
    };
    toolbarActions.add(autoNextAction);
    row.addView(toolbarButton(
      autoNext ? android.R.drawable.ic_media_next : android.R.drawable.ic_popup_sync,
      autoNext ? "连播" : "循环",
      autoNext ? "下一条" : "单条",
      autoNext,
      view -> autoNextAction.run()
    ));

    Runnable clearAction = () -> {
      dismissPlaybackToolbar();
      setControlsHidden(!controlsHidden, true);
    };
    toolbarActions.add(clearAction);
    row.addView(toolbarButton(
      controlsHidden ? android.R.drawable.ic_menu_view : android.R.drawable.ic_menu_close_clear_cancel,
      controlsHidden ? "显示" : "清屏",
      controlsHidden ? "恢复" : "隐藏",
      controlsHidden,
      view -> clearAction.run()
    ));

    Runnable moreAction = () -> {
      dismissPlaybackToolbar();
      showMoreActions(item, shareUrl, originalUrl);
    };
    toolbarActions.add(moreAction);
    row.addView(toolbarButton(android.R.drawable.ic_menu_manage, "更多", "操作", false, view -> moreAction.run()));

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
    sheet.setTranslationY(dp(120));
    sheet.setAlpha(0.72f);
    sheet.animate()
      .translationY(0f)
      .alpha(1f)
      .setDuration(220)
      .setInterpolator(GALLERY_SETTLE_INTERPOLATOR)
      .start();
    hideSystemBars();
  }

  private void dismissPlaybackToolbar() {
    if (playbackToolbarOverlay == null || rootView == null) return;
    rootView.removeView(playbackToolbarOverlay);
    playbackToolbarOverlay = null;
    hideSystemBars();
  }

  private LinearLayout toolbarButton(int iconRes, String title, String subtitle, boolean active, View.OnClickListener listener) {
    LinearLayout view = new LinearLayout(this);
    view.setOrientation(LinearLayout.VERTICAL);
    view.setGravity(Gravity.CENTER);
    view.setPadding(dp(4), dp(7), dp(4), dp(6));
    view.setBackground(roundedDrawable(0xFF2A2D37, dp(14)));

    ImageView icon = new ImageView(this);
    icon.setImageResource(iconRes);
    icon.setColorFilter(active ? 0xFFFE2C55 : Color.WHITE);
    icon.setContentDescription(null);
    view.addView(icon, new LinearLayout.LayoutParams(dp(24), dp(24)));

    TextView titleView = new TextView(this);
    titleView.setText(title);
    titleView.setTextColor(active ? 0xFFFE6A86 : Color.WHITE);
    titleView.setTextSize(13);
    titleView.setTypeface(Typeface.DEFAULT_BOLD);
    titleView.setGravity(Gravity.CENTER);
    LinearLayout.LayoutParams titleParams = new LinearLayout.LayoutParams(
      ViewGroup.LayoutParams.MATCH_PARENT,
      ViewGroup.LayoutParams.WRAP_CONTENT
    );
    titleParams.topMargin = dp(3);
    view.addView(titleView, titleParams);

    TextView subtitleView = new TextView(this);
    subtitleView.setText(subtitle);
    subtitleView.setTextColor(0xFFB9BDC8);
    subtitleView.setTextSize(10);
    subtitleView.setGravity(Gravity.CENTER);
    view.addView(subtitleView, new LinearLayout.LayoutParams(
      ViewGroup.LayoutParams.MATCH_PARENT,
      ViewGroup.LayoutParams.WRAP_CONTENT
    ));

    view.setClickable(true);
    view.setFocusable(true);
    view.setContentDescription(title + "，" + subtitle + (active ? "，已开启" : ""));
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
    long replacementGeneration = feedPaging.beginFeedReplacement(sortedUrl);
    loadingMoreVideos = true;
    executor.execute(() -> {
      NativeShortVideoFeedPaging.ReadResult<FeedPage> result = readFeedPage(sortedUrl);
      mainHandler.post(() -> {
        if (!feedPaging.finishFeedReplacement(replacementGeneration, sortedUrl)) return;
        loadingMoreVideos = feedPaging.isLoading();
        if (!result.succeeded()) {
          feedPaging.replaceFeed(pendingFeedUrl, nextFeedCursor, hasMoreVideos);
          showTransientStatus(result.publicMessage());
          return;
        }
        FeedPage page = result.value;
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
    currentIndex = -1;
    pendingPlayIndex = -1;
    pendingFeedUrl = feedUrl == null ? "" : feedUrl;
    updateTopSearchButton();
    nextFeedOffset = page.nextOffset();
    nextFeedCursor = page.nextCursor;
    hasMoreVideos = page.hasMore;
    feedPaging.replaceFeed(pendingFeedUrl, nextFeedCursor, hasMoreVideos);
    videos.clear();
    videos.addAll(page.items);
    reconcileServerActionSnapshots(videos);
    syncPendingVideoActions(false);
    currentScreen = new FeedScreenState(videos, pendingFeedUrl, nextFeedOffset, nextFeedCursor, hasMoreVideos, startIndex);
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
      builder.appendQueryParameter("limit", String.valueOf(SEARCH_PAGE_LIMIT));
      return builder.build().toString();
    } catch (Exception ignored) {
      return "";
    }
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
    long replacementGeneration = feedPaging.beginFeedReplacement(searchUrl);
    loadingMoreVideos = true;
    executor.execute(() -> {
      NativeShortVideoFeedPaging.ReadResult<FeedPage> result = readFeedPage(searchUrl);
      mainHandler.post(() -> {
        if (!feedPaging.finishFeedReplacement(replacementGeneration, searchUrl)) return;
        loadingMoreVideos = feedPaging.isLoading();
        if (!result.succeeded()) {
          feedPaging.replaceFeed(pendingFeedUrl, nextFeedCursor, hasMoreVideos);
          showTransientStatus(result.publicMessage());
          return;
        }
        FeedPage page = result.value;
        if (page.items.isEmpty()) {
          feedPaging.replaceFeed(pendingFeedUrl, nextFeedCursor, hasMoreVideos);
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
      builder.appendQueryParameter("limit", String.valueOf(SEARCH_PAGE_LIMIT));
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
    button.setLayoutParams(new LinearLayout.LayoutParams(dp(56), dp(56)));

    TextView fallback = new TextView(this);
    fallback.setText(initials(item.author));
    fallback.setTextColor(Color.WHITE);
    fallback.setTextSize(15);
    fallback.setTypeface(Typeface.DEFAULT_BOLD);
    fallback.setGravity(Gravity.CENTER);
    fallback.setBackground(circleDrawable(0xFF22242D));
    setCircleClip(fallback);
    FrameLayout.LayoutParams avatarParams = new FrameLayout.LayoutParams(dp(44), dp(44), Gravity.CENTER);
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
      FrameLayout followTarget = new FrameLayout(this);
      followTarget.setClickable(true);
      followTarget.setFocusable(true);
      followTarget.setContentDescription("关注 " + displayAuthor(item));
      followTarget.setOnClickListener(view -> {
        view.performHapticFeedback(HapticFeedbackConstants.CLOCK_TICK);
        toggleFollowingAuthor(item);
      });
      ImageView followIcon = new ImageView(this);
      followIcon.setImageResource(android.R.drawable.ic_input_add);
      followIcon.setColorFilter(Color.WHITE);
      followIcon.setPadding(dp(3), dp(3), dp(3), dp(3));
      followIcon.setBackground(circleDrawable(0xFFFE2C55));
      followIcon.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_NO);
      FrameLayout.LayoutParams iconParams = new FrameLayout.LayoutParams(dp(20), dp(20), Gravity.BOTTOM | Gravity.CENTER_HORIZONTAL);
      iconParams.bottomMargin = dp(1);
      followTarget.addView(followIcon, iconParams);
      FrameLayout.LayoutParams followParams = new FrameLayout.LayoutParams(dp(32), dp(32), Gravity.BOTTOM | Gravity.CENTER_HORIZONTAL);
      followParams.bottomMargin = dp(-5);
      button.addView(followTarget, followParams);
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
    icon.setBackgroundColor(Color.TRANSPARENT);
    icon.setPadding(dp(2), dp(2), dp(2), dp(2));
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

  private View railAction(int iconResource, String label, View.OnClickListener listener) {
    LinearLayout view = new LinearLayout(this);
    view.setOrientation(LinearLayout.VERTICAL);
    view.setGravity(Gravity.CENTER);
    view.setPadding(0, dp(3), 0, dp(3));
    view.setMinimumWidth(dp(56));
    view.setMinimumHeight(dp(52));
    view.setClickable(true);
    view.setFocusable(true);
    view.setContentDescription(label);

    ImageView icon = new ImageView(this);
    icon.setImageResource(iconResource);
    icon.setImageTintList(ColorStateList.valueOf(Color.WHITE));
    icon.setBackgroundColor(Color.TRANSPARENT);
    icon.setPadding(dp(6), dp(6), dp(6), dp(6));
    icon.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_NO);
    view.addView(icon, new LinearLayout.LayoutParams(dp(32), dp(32)));

    TextView text = new TextView(this);
    text.setText(label);
    text.setTextColor(Color.WHITE);
    text.setTextSize(11);
    text.setGravity(Gravity.CENTER);
    text.setTypeface(Typeface.DEFAULT_BOLD);
    text.setShadowLayer(6, 0, 2, 0xAA000000);
    text.setIncludeFontPadding(false);
    LinearLayout.LayoutParams textParams = new LinearLayout.LayoutParams(
      ViewGroup.LayoutParams.MATCH_PARENT,
      dp(18)
    );
    textParams.topMargin = dp(1);
    view.addView(text, textParams);

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

  private void bindCaption(ShortVideoHolder holder, ShortVideoItem item) {
    String author = item.author.length() > 0 ? item.author : "未知作者";
    String title = item.title.length() > 0 ? item.title : "未命名视频";
    holder.captionAuthor.setText("@" + author);
    holder.captionAuthor.setContentDescription("查看作者 " + author);
    holder.captionAuthor.setOnClickListener(view -> showAuthorPanel(item));
    holder.captionTitle.setText(title);
    holder.captionTitle.setContentDescription("视频说明");
    holder.captionTitle.setOnClickListener(view -> toggleCaptionExpanded(holder));
    holder.captionToggle.setOnClickListener(view -> toggleCaptionExpanded(holder));
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
      return NativeShortVideoPageView.create(
        parent,
        getLayoutInflater(),
        activeVideoResizeMode(),
        NativeShortVideoActivity.this::seekActivePlayerFromTouch
      );
    }

    @Override
    public void onBindViewHolder(@NonNull ShortVideoHolder holder, int position) {
      holder.index = position;
      holder.touchActive = false;
      holder.horizontalGesture = false;
      holder.verticalGesture = false;
      holder.longPressTriggered = false;
      ShortVideoItem item = videos.get(position);
      holder.itemView.setContentDescription((item.isGallery() ? "图文作品" : "短视频") + "，作者 "
        + (item.author.length() > 0 ? item.author : "未知作者")
        + "，" + shortTitle(item.title)
        + (item.isGallery() ? "。左右滑查看图片或视频，上下滑切换作品" : "。点按播放或暂停，使用右侧按钮互动，上下滑切换"));
      holder.itemView.setOnClickListener(view -> handleStageTap(holder.index));
      holder.itemView.setOnTouchListener((view, event) -> handleStageTouch(holder, view, event));
      holder.itemView.setOnLongClickListener(null);
      holder.stage.setOnClickListener(view -> handleStageTap(holder.index));
      holder.stage.setOnTouchListener((view, event) -> handleStageTouch(holder, view, event));
      holder.stage.setOnLongClickListener(null);
      holder.cover.setOnClickListener(view -> handleStageTap(holder.index));
      holder.cover.setOnTouchListener((view, event) -> handleStageTouch(holder, view, event));
      holder.cover.setOnLongClickListener(null);
      holder.gestureLayer.setOnTouchListener((view, event) -> handleGestureLayerTouch(holder, view, event));
      bindCaption(holder, item);
      holder.rail.setOnLongClickListener(null);
      bindRail(holder, item);
      holder.cover.animate().cancel();
      holder.cover.setAlpha(1f);
      holder.cover.setTranslationX(0f);
      holder.cover.setTag(null);
      holder.cover.setImageDrawable(null);
      holder.cover.setVisibility(View.VISIBLE);
      holder.videoBackdrop.setImageDrawable(null);
      holder.videoBackdrop.setVisibility(View.GONE);
      if (gallerySegmentView != holder.galleryVideo) holder.galleryVideo.setPlayer(null);
      holder.galleryVideo.setVisibility(View.GONE);
      resetGalleryZoom(holder, true);
      resetGalleryDrag(holder, true);
      holder.galleryIndex = Math.max(0, galleryPositions.getOrDefault(item.id, 0));
      holder.galleryProgress.removeAllViews();
      holder.galleryProgress.setVisibility(View.GONE);
      holder.galleryCounter.setVisibility(View.GONE);
      resetHolderProgress(holder);
      resetLikeBurst(holder);
      holder.playIndicator.setVisibility(View.GONE);
      attachedHolders.put(position, holder);
      if (item.isGallery()) {
        bindGallery(holder, item, holder.galleryIndex, 0);
      } else {
        holder.cover.setScaleType(ImageView.ScaleType.CENTER_CROP);
        ensurePlayerViewAt(position);
        if (!applyCachedFrame(holder, item) && item.coverUrl.length() > 0) loadCover(position, item);
        if (framePrefetchEnabled) bindFrame(position);
      }
      applyControlsVisibility(holder);
    }

    @Override
    public void onViewRecycled(@NonNull ShortVideoHolder holder) {
      if (gallerySegmentView == holder.galleryVideo) stopGallerySegmentPlayback(holder, true);
      attachedHolders.remove(holder.index);
      cancelStageLongPress(holder);
      hideSeekPreview(holder, false);
      holder.touchActive = false;
      holder.horizontalGesture = false;
      holder.verticalGesture = false;
      holder.longPressTriggered = false;
      holder.captionExpanded = false;
      holder.captionCanExpand = false;
      holder.cover.animate().cancel();
      holder.cover.setTag(null);
      holder.cover.setTranslationX(0f);
      holder.videoBackdrop.setImageDrawable(null);
      holder.videoBackdrop.setVisibility(View.GONE);
      resetGalleryZoom(holder, true);
      resetGalleryDrag(holder, true);
      holder.galleryProgress.removeAllViews();
      holder.galleryProgress.setVisibility(View.GONE);
      holder.galleryCounter.setVisibility(View.GONE);
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

  private abstract static class ScreenState {}

  private static final class FeedScreenState extends ScreenState {
    final List<ShortVideoItem> items = new ArrayList<>();
    final String feedUrl;
    final int nextOffset;
    final String nextCursor;
    final boolean hasMore;
    final int currentIndex;

    FeedScreenState(List<ShortVideoItem> items, String feedUrl, int nextOffset, String nextCursor, boolean hasMore, int currentIndex) {
      if (items != null) this.items.addAll(items);
      this.feedUrl = feedUrl == null ? "" : feedUrl;
      this.nextOffset = Math.max(0, nextOffset);
      this.nextCursor = nextCursor == null ? "" : nextCursor;
      this.hasMore = hasMore;
      this.currentIndex = Math.max(0, currentIndex);
    }

    FeedScreenState copy() {
      return new FeedScreenState(items, feedUrl, nextOffset, nextCursor, hasMore, currentIndex);
    }
  }

  private static final class AuthorScreenState extends ScreenState {
    final ShortVideoItem seed;
    ShortVideoItem currentItem;
    FeedPage page;
    String activeTab;
    String sort;
    boolean loadingMore;
    boolean hasPlaybackContext = true;
    int worksGestureId;
    int worksGestureDirection;
    int worksScrollY;
    @Nullable ScrollView worksScrollView;

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
      copy.hasPlaybackContext = hasPlaybackContext;
      copy.worksScrollY = worksScrollY;
      return copy;
    }
  }

}
