package local.fanhao.library;

import android.app.Activity;
import android.content.pm.ActivityInfo;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Color;
import android.graphics.Outline;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.media.MediaMetadataRetriever;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.util.LruCache;
import android.util.Log;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.view.ViewOutlineProvider;
import android.view.Window;
import android.view.WindowInsets;
import android.view.WindowInsetsController;
import android.widget.FrameLayout;
import android.widget.GridLayout;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

import androidx.annotation.NonNull;
import androidx.annotation.Nullable;
import androidx.media3.common.MediaItem;
import androidx.media3.common.Player;
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
import java.util.ArrayList;
import java.util.Collections;
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
  public static final String EXTRA_BASE_URL = "baseUrl";
  public static final String EXTRA_FEED_URL = "feedUrl";
  public static final String EXTRA_NEXT_OFFSET = "nextOffset";
  public static final String EXTRA_HAS_MORE = "hasMore";

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
  private final Set<Integer> primedPlayerIndexes = new HashSet<>();
  private final Set<Integer> primeRequestedIndexes = new HashSet<>();
  private final Set<Integer> primeCountdownIndexes = new HashSet<>();
  private final List<ScreenState> navigationStack = new ArrayList<>();
  private ExoPlayer activePlayer;
  private ViewPager2 pager;
  private ShortVideoAdapter adapter;
  private TextView statusView;
  private FrameLayout rootView;
  private View authorOverlay;
  private ScreenState currentScreen;
  private String pendingFeedUrl;
  private int pendingStartIndex;
  private int nextFeedOffset;
  private boolean hasMoreVideos;
  private boolean loadingMoreVideos;
  private int currentIndex = -1;
  private int pendingPlayIndex = -1;
  private Runnable pendingPrepareRunnable;
  private boolean framePrefetchEnabled;
  private long createdAtMs;
  private boolean loggedFirstFrame;

  @Override
  protected void onCreate(@Nullable Bundle savedInstanceState) {
    super.onCreate(savedInstanceState);
    createdAtMs = SystemClock.elapsedRealtime();
    requestWindowFeature(Window.FEATURE_NO_TITLE);
    setRequestedOrientation(ActivityInfo.SCREEN_ORIENTATION_PORTRAIT);
    pendingFeedUrl = getIntent().getStringExtra(EXTRA_FEED_URL);
    pendingStartIndex = Math.max(0, getIntent().getIntExtra(EXTRA_START_INDEX, 0));
    nextFeedOffset = Math.max(0, getIntent().getIntExtra(EXTRA_NEXT_OFFSET, 0));
    hasMoreVideos = getIntent().getBooleanExtra(EXTRA_HAS_MORE, false);
    readVideos();
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
    hideSystemBars();
    if (activePlayer != null) activePlayer.play();
  }

  @Override
  protected void onPause() {
    for (ExoPlayer cachedPlayer : playerCache.values()) cachedPlayer.pause();
    super.onPause();
  }

  @Override
  protected void onDestroy() {
    Log.i(TAG, "destroy");
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

    TextView back = new TextView(this);
    back.setText("‹");
    back.setTextColor(Color.WHITE);
    back.setTextSize(36);
    back.setTypeface(Typeface.DEFAULT_BOLD);
    back.setGravity(Gravity.CENTER);
    back.setBackgroundColor(0x66000000);
    back.setOnClickListener(view -> navigateBack());
    FrameLayout.LayoutParams backParams = new FrameLayout.LayoutParams(dp(44), dp(44));
    backParams.leftMargin = dp(14);
    backParams.topMargin = dp(18);
    root.addView(back, backParams);

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
    if (navigationStack.isEmpty()) {
      finish();
      return;
    }
    ScreenState previous = navigationStack.remove(navigationStack.size() - 1);
    renderScreen(previous);
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
    currentIndex = -1;
    pendingPlayIndex = -1;
    pendingFeedUrl = screen.feedUrl;
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
    });
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
      activePlayer.setVolume(1f);
      ensurePlayerViewAt(index);
      if (activePlayer.getPlaybackState() == Player.STATE_READY) holder.cover.setVisibility(View.GONE);
      activePlayer.play();
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
    activePlayer.setVolume(1f);
    ensurePlayerViewAt(index);
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
    activePlayer.play();
    Log.i(TAG, "play " + index + " " + item.streamUrl);
    loadMoreIfNeeded(index);
  }

  private ExoPlayer preparePlayerAt(int index) {
    if (index < 0 || index >= videos.size()) return null;
    ExoPlayer cachedPlayer = playerCache.get(index);
    if (cachedPlayer != null) {
      ensurePlayerViewAt(index);
      return cachedPlayer;
    }

    ShortVideoItem item = videos.get(index);
    ExoPlayer preparedPlayer = new ExoPlayer.Builder(this)
      .setLoadControl(new DefaultLoadControl.Builder()
        .setBufferDurationsMs(600, 2000, 100, 220)
        .build())
      .build();
    preparedPlayer.setRepeatMode(Player.REPEAT_MODE_ONE);
    preparedPlayer.setVolume(0f);
    preparedPlayer.setMediaItem(MediaItem.fromUri(Uri.parse(item.streamUrl)));
    preparedPlayer.addListener(new Player.Listener() {
      @Override
      public void onRenderedFirstFrame() {
        if (currentIndex != index) return;
        if (!loggedFirstFrame) {
          loggedFirstFrame = true;
          Log.i(TAG, "first frame in " + (SystemClock.elapsedRealtime() - createdAtMs) + "ms");
        }
        ShortVideoHolder holder = attachedHolders.get(index);
        if (holder != null) holder.cover.setVisibility(View.GONE);
        mainHandler.post(() -> preparePlayersAround(index));
      }

      @Override
      public void onPlaybackStateChanged(int playbackState) {
        if (playbackState != Player.STATE_READY) return;
        if (currentIndex == index) {
          ShortVideoHolder holder = attachedHolders.get(index);
          if (holder != null) {
            holder.cover.postDelayed(() -> {
              if (currentIndex == index) holder.cover.setVisibility(View.GONE);
            }, 80);
          }
        } else if (primeRequestedIndexes.contains(index)) {
          startPrimeCountdown(index, preparedPlayer);
        }
      }
    });
    preparedPlayer.prepare();
    playerCache.put(index, preparedPlayer);
    PlayerView preparedView = ensurePlayerViewAt(index);
    if (preparedView != null) preparedView.setPlayer(preparedPlayer);
    Log.i(TAG, "prepare " + index + " " + item.streamUrl);
    return preparedPlayer;
  }

  @Nullable
  private PlayerView ensurePlayerViewAt(int index) {
    if (index < 0 || index >= videos.size()) return null;
    PlayerView view = playerViews.get(index);
    if (view == null) {
      view = (PlayerView) getLayoutInflater().inflate(R.layout.native_short_player_view, pager, false);
      view.setClickable(false);
      view.setFocusable(false);
      view.setEnabled(false);
      view.setUseController(false);
      view.setKeepContentOnPlayerReset(true);
      view.setResizeMode(AspectRatioFrameLayout.RESIZE_MODE_ZOOM);
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
    return view;
  }

  private void preparePlayersAround(int index) {
    loadMoreIfNeeded(index);
    for (int i = index - 1; i <= index + 1; i++) {
      ExoPlayer preparedPlayer = preparePlayerAt(i);
      if (i != index) primeNeighborPlayer(i, preparedPlayer);
    }
    releaseDistantPlayers(index);
  }

  private void runNeighborsDuringDrag(int index) {
    for (int i = index - 1; i <= index + 1; i++) {
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
      if (Math.abs(key - centerIndex) <= 1) continue;
      ExoPlayer stalePlayer = playerCache.remove(key);
      primedPlayerIndexes.remove(key);
      primeRequestedIndexes.remove(key);
      primeCountdownIndexes.remove(key);
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
    activePlayer = null;
  }

  private void loadMoreIfNeeded(int index) {
    if (loadingMoreVideos || !hasMoreVideos || pendingFeedUrl == null || pendingFeedUrl.trim().isEmpty()) return;
    if (videos.size() - index > 3) return;
    loadingMoreVideos = true;
    String feedUrl = pagedFeedUrl(pendingFeedUrl, nextFeedOffset, 40);
    Log.i(TAG, "load more offset=" + nextFeedOffset);
    executor.execute(() -> {
      FeedPage page = readFeedPage(feedUrl);
      mainHandler.post(() -> {
        loadingMoreVideos = false;
        if (page.items.isEmpty()) {
          hasMoreVideos = false;
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
        nextFeedOffset = page.offset + page.limit;
        hasMoreVideos = page.hasMore;
        if (inserted > 0) {
          adapter.notifyItemRangeInserted(videos.size() - inserted, inserted);
          prepareAround(currentIndex);
          preparePlayersAround(currentIndex);
        }
        Log.i(TAG, "loaded more inserted=" + inserted + " nextOffset=" + nextFeedOffset + " hasMore=" + hasMoreVideos);
      });
    });
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
      streamUrl,
      absoluteUrl(baseUrl, row.optString("coverUrl", "")),
      row.optString("title", ""),
      author == null ? "" : author.optString("name", ""),
      author == null ? "" : author.optString("secUid", ""),
      absoluteUrl(baseUrl, author == null ? "" : author.optString("avatarUrl", "")),
      author == null ? "" : author.optString("profileUrl", ""),
      row.optString("publishedAt", ""),
      row.optLong("durationMs", 0),
      stats == null ? 0 : stats.optLong("likes", 0),
      stats == null ? 0 : stats.optLong("comments", 0),
      stats == null ? 0 : stats.optLong("collects", 0),
      stats == null ? 0 : stats.optLong("shares", 0)
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

  private void loadFeedAsync(String feedUrl, int startIndex) {
    String normalizedFeedUrl = normalizeFeedUrl(feedUrl);
    executor.execute(() -> {
      FeedPage page = readFeedPage(normalizedFeedUrl);
      mainHandler.post(() -> {
        videos.clear();
        videos.addAll(page.items);
        nextFeedOffset = page.offset + Math.max(page.limit, page.items.size());
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
    renderAuthorScreen(new AuthorScreenState(seed, null, "works"));
  }

  private void renderAuthorScreen(AuthorScreenState screen) {
    ShortVideoItem seed = screen.seed;
    removeAuthorOverlay();
    if (activePlayer != null) activePlayer.pause();
    currentScreen = screen;

    FrameLayout overlay = new FrameLayout(this);
    overlay.setBackgroundColor(0xFF151720);
    overlay.setClickable(true);

    LinearLayout sheet = new LinearLayout(this);
    sheet.setOrientation(LinearLayout.VERTICAL);
    sheet.setPadding(dp(16), dp(18), dp(16), dp(18));
    sheet.setBackgroundColor(0xFF151720);
    sheet.setClickable(true);
    FrameLayout.LayoutParams sheetParams = new FrameLayout.LayoutParams(
      ViewGroup.LayoutParams.MATCH_PARENT,
      ViewGroup.LayoutParams.MATCH_PARENT
    );
    overlay.addView(sheet, sheetParams);

    LinearLayout top = new LinearLayout(this);
    top.setOrientation(LinearLayout.HORIZONTAL);
    top.setGravity(Gravity.CENTER_VERTICAL);
    TextView close = iconText("‹", 34, Color.TRANSPARENT);
    close.setContentDescription("返回");
    close.setOnClickListener(view -> navigateBack());
    top.addView(close, new LinearLayout.LayoutParams(dp(44), dp(44)));
    TextView title = new TextView(this);
    title.setText("作者主页");
    title.setTextColor(Color.WHITE);
    title.setTextSize(16);
    title.setTypeface(Typeface.DEFAULT_BOLD);
    title.setGravity(Gravity.CENTER_VERTICAL);
    LinearLayout.LayoutParams titleParams = new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f);
    top.addView(title, titleParams);
    sheet.addView(top, new LinearLayout.LayoutParams(
      ViewGroup.LayoutParams.MATCH_PARENT,
      ViewGroup.LayoutParams.WRAP_CONTENT
    ));

    LinearLayout head = new LinearLayout(this);
    head.setOrientation(LinearLayout.HORIZONTAL);
    head.setGravity(Gravity.CENTER_VERTICAL);
    head.setPadding(0, dp(6), 0, dp(12));
    head.addView(authorAvatarView(seed, dp(64)), new LinearLayout.LayoutParams(dp(64), dp(64)));
    LinearLayout info = new LinearLayout(this);
    info.setOrientation(LinearLayout.VERTICAL);
    info.setPadding(dp(12), 0, 0, 0);
    TextView name = new TextView(this);
    name.setText("@" + displayAuthor(seed));
    name.setTextColor(Color.WHITE);
    name.setTextSize(20);
    name.setTypeface(Typeface.DEFAULT_BOLD);
    TextView handle = new TextView(this);
    handle.setText(seed.authorSecUid.length() > 0 ? "抖音号 " + seed.authorSecUid : "本地作者");
    handle.setTextColor(0xB3FFFFFF);
    handle.setTextSize(12);
    handle.setTypeface(Typeface.DEFAULT_BOLD);
    info.addView(name);
    info.addView(handle);
    head.addView(info, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));
    sheet.addView(head);

    LinearLayout statsRow = new LinearLayout(this);
    statsRow.setOrientation(LinearLayout.HORIZONTAL);
    statsRow.setGravity(Gravity.CENTER);
    statsRow.setPadding(0, dp(2), 0, dp(10));
    sheet.addView(statsRow, new LinearLayout.LayoutParams(
      ViewGroup.LayoutParams.MATCH_PARENT,
      ViewGroup.LayoutParams.WRAP_CONTENT
    ));

    TextView filter = new TextView(this);
    filter.setText("只看 TA");
    filter.setTextColor(Color.WHITE);
    filter.setTextSize(15);
    filter.setTypeface(Typeface.DEFAULT_BOLD);
    filter.setGravity(Gravity.CENTER);
    filter.setBackground(roundedDrawable(seed.authorSecUid.length() > 0 ? 0xFFFE2C55 : 0xFF2A2D37, dp(10)));
    filter.setEnabled(seed.authorSecUid.length() > 0);
    filter.setAlpha(seed.authorSecUid.length() > 0 ? 1f : 0.52f);
    filter.setOnClickListener(view -> switchToAuthorFeed(screen));
    LinearLayout.LayoutParams filterParams = new LinearLayout.LayoutParams(
      ViewGroup.LayoutParams.MATCH_PARENT,
      dp(46)
    );
    filterParams.bottomMargin = dp(10);
    sheet.addView(filter, filterParams);

    LinearLayout tabs = new LinearLayout(this);
    tabs.setOrientation(LinearLayout.HORIZONTAL);
    tabs.setGravity(Gravity.CENTER);
    sheet.addView(tabs, new LinearLayout.LayoutParams(
      ViewGroup.LayoutParams.MATCH_PARENT,
      dp(42)
    ));

    FrameLayout content = new FrameLayout(this);
    sheet.addView(content, new LinearLayout.LayoutParams(
      ViewGroup.LayoutParams.MATCH_PARENT,
      0,
      1f
    ));

    final FeedPage[] pageRef = new FeedPage[] { screen.page == null ? localAuthorPage(seed) : screen.page.copy() };
    final String[] activeTab = new String[] { screen.activeTab == null ? "works" : screen.activeTab };
    final Runnable[] render = new Runnable[1];
    render[0] = () -> {
      screen.page = pageRef[0].copy();
      screen.activeTab = activeTab[0];
      currentScreen = screen;
      renderAuthorStats(statsRow, pageRef[0]);
      renderAuthorTabs(tabs, activeTab[0], nextTab -> {
        activeTab[0] = nextTab;
        screen.activeTab = nextTab;
        render[0].run();
      });
      content.removeAllViews();
      content.addView(authorTabContent(screen, pageRef[0], activeTab[0]), new FrameLayout.LayoutParams(
        ViewGroup.LayoutParams.MATCH_PARENT,
        ViewGroup.LayoutParams.MATCH_PARENT
      ));
    };
    render[0].run();

    rootView.addView(overlay, new FrameLayout.LayoutParams(
      ViewGroup.LayoutParams.MATCH_PARENT,
      ViewGroup.LayoutParams.MATCH_PARENT
    ));
    authorOverlay = overlay;

    String authorUrl = authorFeedUrl(seed, 0, 36);
    if (authorUrl.length() > 0) {
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

  private FeedPage localAuthorPage(ShortVideoItem seed) {
    FeedPage page = new FeedPage();
    for (ShortVideoItem item : videos) {
      if (!sameAuthor(seed, item)) continue;
      page.items.add(item);
    }
    if (page.items.isEmpty()) page.items.add(seed);
    page.total = page.items.size();
    page.limit = page.items.size();
    page.hasMore = seed.authorSecUid.length() > 0;
    page.stats = FeedStats.fromItems(page.items);
    return page;
  }

  private boolean sameAuthor(ShortVideoItem left, ShortVideoItem right) {
    if (left == null || right == null) return false;
    if (left.authorSecUid.length() > 0 && right.authorSecUid.length() > 0) {
      return left.authorSecUid.equals(right.authorSecUid);
    }
    return left.author.length() > 0 && left.author.equals(right.author);
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
      value.setTextColor(Color.WHITE);
      value.setTextSize(17);
      value.setTypeface(Typeface.DEFAULT_BOLD);
      value.setGravity(Gravity.CENTER);
      TextView label = new TextView(this);
      label.setText(item[1]);
      label.setTextColor(0x99FFFFFF);
      label.setTextSize(11);
      label.setGravity(Gravity.CENTER);
      cell.addView(value);
      cell.addView(label);
      statsRow.addView(cell, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));
    }
  }

  private void renderAuthorTabs(LinearLayout tabs, String activeTab, AuthorTabCallback callback) {
    tabs.removeAllViews();
    tabs.addView(authorTabButton("作品", "works", activeTab, callback), new LinearLayout.LayoutParams(0, dp(38), 1f));
    tabs.addView(authorTabButton("数据", "stats", activeTab, callback), new LinearLayout.LayoutParams(0, dp(38), 1f));
  }

  private TextView authorTabButton(String label, String value, String activeTab, AuthorTabCallback callback) {
    boolean active = value.equals(activeTab);
    TextView button = new TextView(this);
    button.setText(label);
    button.setTextColor(active ? Color.WHITE : 0x99FFFFFF);
    button.setTextSize(14);
    button.setTypeface(Typeface.DEFAULT_BOLD);
    button.setGravity(Gravity.CENTER);
    button.setBackground(roundedDrawable(active ? 0xFF2A2D37 : Color.TRANSPARENT, dp(10)));
    button.setOnClickListener(view -> callback.onTab(value));
    return button;
  }

  private View authorTabContent(AuthorScreenState screen, FeedPage page, String tab) {
    if ("stats".equals(tab)) return authorStatsContent(screen.seed, page);
    return authorWorksContent(screen, page);
  }

  private View authorWorksContent(AuthorScreenState screen, FeedPage page) {
    ScrollView scroll = new ScrollView(this);
    scroll.setFillViewport(false);
    GridLayout grid = new GridLayout(this);
    grid.setColumnCount(3);
    grid.setPadding(0, dp(8), 0, dp(22));
    int screenWidth = getResources().getDisplayMetrics().widthPixels;
    int tileWidth = Math.max(dp(92), (screenWidth - dp(40)) / 3);
    if (page.items.isEmpty()) {
      TextView empty = emptyPanel("没有本地作品");
      scroll.addView(empty, new ScrollView.LayoutParams(
        ViewGroup.LayoutParams.MATCH_PARENT,
        ViewGroup.LayoutParams.WRAP_CONTENT
      ));
      return scroll;
    }
    for (ShortVideoItem item : page.items) {
      grid.addView(authorVideoTile(item, tileWidth, page, screen));
    }
    scroll.addView(grid, new ScrollView.LayoutParams(
      ViewGroup.LayoutParams.MATCH_PARENT,
      ViewGroup.LayoutParams.WRAP_CONTENT
    ));
    return scroll;
  }

  private View authorStatsContent(ShortVideoItem seed, FeedPage page) {
    ScrollView scroll = new ScrollView(this);
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
    LinearLayout tile = new LinearLayout(this);
    tile.setOrientation(LinearLayout.VERTICAL);
    tile.setPadding(dp(2), dp(2), dp(2), dp(8));
    tile.setClickable(true);
    tile.setOnClickListener(view -> openAuthorVideo(item, page, screen));
    GridLayout.LayoutParams params = new GridLayout.LayoutParams();
    params.width = width;
    params.height = ViewGroup.LayoutParams.WRAP_CONTENT;
    tile.setLayoutParams(params);

    FrameLayout media = new FrameLayout(this);
    media.setBackgroundColor(0xFF0D0E13);
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
    tile.addView(media, new LinearLayout.LayoutParams(width - dp(4), Math.round((width - dp(4)) * 1.34f)));

    TextView caption = new TextView(this);
    caption.setText(shortTitle(item.title));
    caption.setTextColor(0xE6FFFFFF);
    caption.setTextSize(11);
    caption.setMaxLines(2);
    caption.setPadding(0, dp(5), 0, 0);
    tile.addView(caption, new LinearLayout.LayoutParams(
      ViewGroup.LayoutParams.MATCH_PARENT,
      ViewGroup.LayoutParams.WRAP_CONTENT
    ));
    return tile;
  }

  private TextView statRow(String label, String value) {
    TextView row = new TextView(this);
    row.setText(label + "  " + value);
    row.setTextColor(0xE6FFFFFF);
    row.setTextSize(14);
    row.setTypeface(Typeface.DEFAULT_BOLD);
    row.setGravity(Gravity.CENTER_VERTICAL);
    row.setPadding(dp(12), 0, dp(12), 0);
    row.setBackground(roundedDrawable(0xFF20232C, dp(10)));
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
    empty.setTextColor(0x99FFFFFF);
    empty.setTextSize(14);
    empty.setGravity(Gravity.CENTER);
    empty.setTypeface(Typeface.DEFAULT_BOLD);
    empty.setMinHeight(dp(180));
    return empty;
  }

  private void openAuthorVideo(ShortVideoItem item, FeedPage page, AuthorScreenState authorScreen) {
    String url = authorFeedUrl(authorScreen.seed, 0, 80);
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

  private void switchToAuthorFeed(AuthorScreenState authorScreen) {
    String url = authorFeedUrl(authorScreen.seed, 0, 80);
    if (url.length() == 0) return;
    pushCurrentScreen();
    FeedPage feed = authorScreen.page == null ? localAuthorPage(authorScreen.seed) : authorScreen.page.copy();
    if (feed.items.isEmpty()) feed.items.add(authorScreen.seed);
    renderFeedScreen(new FeedScreenState(feed.items, url, feed.nextOffset(), feed.hasMore, 0));
  }

  private String authorFeedUrl(ShortVideoItem seed, int offset, int limit) {
    if (seed == null || seed.authorSecUid.length() == 0) return "";
    String base = baseFromUrl(pendingFeedUrl != null && pendingFeedUrl.length() > 0 ? pendingFeedUrl : seed.streamUrl);
    if (base.length() == 0) return "";
    return Uri.parse(base + "/api/short-videos").buildUpon()
      .appendQueryParameter("author", seed.authorSecUid)
      .appendQueryParameter("source", "all")
      .appendQueryParameter("sort", "published")
      .appendQueryParameter("facets", "0")
      .appendQueryParameter("offset", String.valueOf(Math.max(0, offset)))
      .appendQueryParameter("limit", String.valueOf(Math.max(1, limit)))
      .build()
      .toString();
  }

  private View authorAvatarView(ShortVideoItem item, int size) {
    FrameLayout wrap = new FrameLayout(this);
    TextView fallback = new TextView(this);
    fallback.setText(initials(item.author));
    fallback.setTextColor(Color.WHITE);
    fallback.setTextSize(20);
    fallback.setTypeface(Typeface.DEFAULT_BOLD);
    fallback.setGravity(Gravity.CENTER);
    fallback.setBackground(circleDrawable(0xFF282B35));
    setCircleClip(fallback);
    wrap.addView(fallback, new FrameLayout.LayoutParams(size, size, Gravity.CENTER));
    if (item.authorAvatarUrl.length() > 0) {
      ImageView image = new ImageView(this);
      image.setScaleType(ImageView.ScaleType.CENTER_CROP);
      image.setBackground(circleDrawable(0xFF282B35));
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
    if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.R) {
      window.setDecorFitsSystemWindows(false);
      WindowInsetsController controller = window.getInsetsController();
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

  private final class ShortVideoAdapter extends RecyclerView.Adapter<ShortVideoHolder> {
    @NonNull
    @Override
    public ShortVideoHolder onCreateViewHolder(@NonNull ViewGroup parent, int viewType) {
      FrameLayout root = new FrameLayout(parent.getContext());
      root.setBackgroundColor(Color.BLACK);
      root.setClipChildren(false);
      root.setClipToPadding(false);
      root.setLayoutParams(new ViewGroup.LayoutParams(
        ViewGroup.LayoutParams.MATCH_PARENT,
        ViewGroup.LayoutParams.MATCH_PARENT
      ));

      FrameLayout stage = new FrameLayout(parent.getContext());
      root.addView(stage, new FrameLayout.LayoutParams(
        ViewGroup.LayoutParams.MATCH_PARENT,
        ViewGroup.LayoutParams.MATCH_PARENT
      ));

      ImageView cover = new ImageView(parent.getContext());
      cover.setScaleType(ImageView.ScaleType.CENTER_CROP);
      cover.setBackgroundColor(Color.BLACK);
      stage.addView(cover, new FrameLayout.LayoutParams(
        ViewGroup.LayoutParams.MATCH_PARENT,
        ViewGroup.LayoutParams.MATCH_PARENT
      ));

      TextView caption = new TextView(parent.getContext());
      caption.setTextColor(Color.WHITE);
      caption.setTextSize(15);
      caption.setTypeface(Typeface.DEFAULT_BOLD);
      caption.setMaxLines(4);
      caption.setShadowLayer(6, 0, 2, 0xAA000000);
      FrameLayout.LayoutParams captionParams = new FrameLayout.LayoutParams(
        ViewGroup.LayoutParams.MATCH_PARENT,
        ViewGroup.LayoutParams.WRAP_CONTENT,
        Gravity.BOTTOM | Gravity.LEFT
      );
      captionParams.leftMargin = dp(14);
      captionParams.rightMargin = dp(96);
      captionParams.bottomMargin = dp(40);
      root.addView(caption, captionParams);

      LinearLayout rail = new LinearLayout(parent.getContext());
      rail.setOrientation(LinearLayout.VERTICAL);
      rail.setGravity(Gravity.CENTER);
      rail.setClipChildren(false);
      rail.setClipToPadding(false);
      FrameLayout.LayoutParams railParams = new FrameLayout.LayoutParams(dp(64), ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.RIGHT | Gravity.CENTER_VERTICAL);
      railParams.rightMargin = dp(8);
      root.addView(rail, railParams);

      return new ShortVideoHolder(root, stage, cover, caption, rail);
    }

    @Override
    public void onBindViewHolder(@NonNull ShortVideoHolder holder, int position) {
      holder.index = position;
      ShortVideoItem item = videos.get(position);
      holder.caption.setText("@" + (item.author.length() > 0 ? item.author : "未知作者") + "\n" + item.title);
      holder.caption.setOnClickListener(view -> showAuthorPanel(item));
      holder.rail.removeAllViews();
      holder.rail.addView(authorAvatarButton(item));
      holder.rail.addView(metric("♥", item.likes));
      holder.rail.addView(metric("●", item.comments));
      holder.rail.addView(metric("★", item.collects));
      holder.rail.addView(metric("↗", item.shares));
      holder.cover.setImageDrawable(null);
      holder.cover.setVisibility(View.VISIBLE);
      attachedHolders.put(position, holder);
      ensurePlayerViewAt(position);
      if (!applyCachedFrame(holder, item) && item.coverUrl.length() > 0) loadCover(holder, item);
      if (framePrefetchEnabled) bindFrame(position);
    }

    @Override
    public void onViewRecycled(@NonNull ShortVideoHolder holder) {
      attachedHolders.remove(holder.index);
      PlayerView cachedView = playerViews.get(holder.index);
      if (cachedView != null && cachedView.getParent() == holder.stage) holder.stage.removeView(cachedView);
      super.onViewRecycled(holder);
    }

    @Override
    public int getItemCount() {
      return videos.size();
    }

    private View authorAvatarButton(ShortVideoItem item) {
      FrameLayout button = new FrameLayout(NativeShortVideoActivity.this);
      button.setClickable(true);
      button.setFocusable(true);
      button.setContentDescription(item.author.length() > 0 ? "查看作者 " + item.author : "查看作者");
      button.setOnClickListener(view -> showAuthorPanel(item));
      button.setClipChildren(false);
      button.setClipToPadding(false);
      LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(dp(64), dp(64));
      button.setLayoutParams(params);

      TextView fallback = new TextView(NativeShortVideoActivity.this);
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
        ImageView avatar = new ImageView(NativeShortVideoActivity.this);
        avatar.setScaleType(ImageView.ScaleType.CENTER_CROP);
        avatar.setBackground(circleDrawable(0xFF22242D));
        setCircleClip(avatar);
        button.addView(avatar, avatarParams);
        loadImageInto(avatar, item.authorAvatarUrl, item.authorSecUid.length() > 0 ? "avatar:" + item.authorSecUid : item.authorAvatarUrl);
      }
      return button;
    }

    private TextView metric(String icon, long value) {
      TextView view = new TextView(NativeShortVideoActivity.this);
      view.setText(icon + "\n" + compact(value));
      view.setTextColor(Color.WHITE);
      view.setTextSize(13);
      view.setGravity(Gravity.CENTER);
      view.setTypeface(Typeface.DEFAULT_BOLD);
      view.setShadowLayer(6, 0, 2, 0xAA000000);
      view.setPadding(0, dp(8), 0, dp(8));
      return view;
    }
  }

  private static final class ShortVideoHolder extends RecyclerView.ViewHolder {
    final FrameLayout stage;
    final ImageView cover;
    final TextView caption;
    final LinearLayout rail;
    int index = -1;

    ShortVideoHolder(@NonNull FrameLayout root, FrameLayout stage, ImageView cover, TextView caption, LinearLayout rail) {
      super(root);
      this.stage = stage;
      this.cover = cover;
      this.caption = caption;
      this.rail = rail;
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
    FeedPage page;
    String activeTab;

    AuthorScreenState(ShortVideoItem seed, @Nullable FeedPage page, String activeTab) {
      this.seed = seed;
      this.page = page == null ? null : page.copy();
      this.activeTab = activeTab == null || activeTab.length() == 0 ? "works" : activeTab;
    }

    AuthorScreenState copy() {
      return new AuthorScreenState(seed, page, activeTab);
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
      return offset + Math.max(limit, items.size());
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

  private static final class ShortVideoItem {
    final String id;
    final String streamUrl;
    final String coverUrl;
    final String title;
    final String author;
    final String authorSecUid;
    final String authorAvatarUrl;
    final String authorProfileUrl;
    final String publishedAt;
    final long durationMs;
    final long likes;
    final long comments;
    final long collects;
    final long shares;

    ShortVideoItem(String id, String streamUrl, String coverUrl, String title, String author, String authorSecUid, String authorAvatarUrl, String authorProfileUrl, String publishedAt, long durationMs, long likes, long comments, long collects, long shares) {
      this.id = id;
      this.streamUrl = streamUrl == null ? "" : streamUrl;
      this.coverUrl = coverUrl == null ? "" : coverUrl;
      this.title = title == null ? "" : title;
      this.author = author == null ? "" : author;
      this.authorSecUid = authorSecUid == null ? "" : authorSecUid;
      this.authorAvatarUrl = authorAvatarUrl == null ? "" : authorAvatarUrl;
      this.authorProfileUrl = authorProfileUrl == null ? "" : authorProfileUrl;
      this.publishedAt = publishedAt == null ? "" : publishedAt;
      this.durationMs = durationMs;
      this.likes = likes;
      this.comments = comments;
      this.collects = collects;
      this.shares = shares;
    }
  }
}
