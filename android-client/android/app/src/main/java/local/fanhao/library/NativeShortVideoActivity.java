package local.fanhao.library;

import android.app.Activity;
import android.content.pm.ActivityInfo;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Color;
import android.graphics.Typeface;
import android.media.MediaMetadataRetriever;
import android.net.Uri;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.util.LruCache;
import android.util.Log;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.view.Window;
import android.view.WindowInsets;
import android.view.WindowInsetsController;
import android.widget.FrameLayout;
import android.widget.ImageView;
import android.widget.LinearLayout;
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
  private ExoPlayer activePlayer;
  private ViewPager2 pager;
  private ShortVideoAdapter adapter;
  private TextView statusView;
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

  private void buildUi() {
    FrameLayout root = new FrameLayout(this);
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
    back.setOnClickListener(view -> finish());
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
      page.hasMore = data.optBoolean("hasMore", false);
      JSONArray rows = data.optJSONArray("videos");
      if (rows == null) return page;
      String baseUrl = baseFromUrl(feedUrl);
      for (int i = 0; i < rows.length(); i++) {
        ShortVideoItem item = itemFromJson(rows.optJSONObject(i), baseUrl, String.valueOf(i));
        if (item != null) page.items.add(item);
      }
    } catch (Exception ignored) {
    } finally {
      if (connection != null) connection.disconnect();
    }
    return page;
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
      holder.rail.removeAllViews();
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

  private static final class FeedPage {
    final List<ShortVideoItem> items = new ArrayList<>();
    int offset = 0;
    int limit = 80;
    boolean hasMore = false;
  }

  private static final class ShortVideoItem {
    final String id;
    final String streamUrl;
    final String coverUrl;
    final String title;
    final String author;
    final long likes;
    final long comments;
    final long collects;
    final long shares;

    ShortVideoItem(String id, String streamUrl, String coverUrl, String title, String author, long likes, long comments, long collects, long shares) {
      this.id = id;
      this.streamUrl = streamUrl;
      this.coverUrl = coverUrl;
      this.title = title == null ? "" : title;
      this.author = author == null ? "" : author;
      this.likes = likes;
      this.comments = comments;
      this.collects = collects;
      this.shares = shares;
    }
  }
}
