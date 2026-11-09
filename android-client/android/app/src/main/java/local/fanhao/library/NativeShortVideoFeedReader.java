package local.fanhao.library;

import android.net.Uri;
import android.os.SystemClock;
import android.util.Log;
import android.util.LruCache;

import org.json.JSONArray;
import org.json.JSONObject;

final class NativeShortVideoFeedReader {
  private static final String TAG = "NativeShortVideo";
  private final int defaultPageLimit;
  private final long cacheMaxAgeMs;
  private final LruCache<String, CachedFeedPage> cache = new LruCache<>(24);
  private final NativeShortVideoFeedTransport transport = new NativeShortVideoFeedTransport(8000, 12000);

  NativeShortVideoFeedReader(int defaultPageLimit, long cacheMaxAgeMs) {
    this.defaultPageLimit = Math.max(1, defaultPageLimit);
    this.cacheMaxAgeMs = Math.max(0, cacheMaxAgeMs);
  }

  void clear() {
    cache.evictAll();
  }

  NativeShortVideoFeedPaging.ReadResult<FeedPage> read(String feedUrl) {
    return read(feedUrl, null);
  }

  NativeShortVideoFeedPaging.ReadResult<FeedPage> read(String feedUrl, NativeShortVideoFeedTransport.Cancellation cancellation) {
    if (cancelled(cancellation)) return NativeShortVideoFeedPaging.ReadResult.failure(NativeShortVideoFeedPaging.Failure.OFFLINE);
    CachedFeedPage cached = cache.get(feedUrl);
    if (cached != null && SystemClock.elapsedRealtime() - cached.cachedAtMs <= cacheMaxAgeMs) {
      Log.i(TAG, "feed cache hit " + feedUrl);
      FeedPage page = cached.page.copy();
      return cancelled(cancellation) ? NativeShortVideoFeedPaging.ReadResult.failure(NativeShortVideoFeedPaging.Failure.OFFLINE)
        : NativeShortVideoFeedPaging.ReadResult.success(page, page.hasMore, page.nextCursor);
    }
    NativeShortVideoFeedPaging.ReadResult<FeedPage> result = readUncached(feedUrl, cancellation);
    if (result.failure == NativeShortVideoFeedPaging.Failure.STALE_CACHE && !cancelled(cancellation)) {
      String refreshUrl = forceRefreshUrl(feedUrl);
      if (refreshUrl != null) result = readUncached(refreshUrl, cancellation);
    }
    if (cancelled(cancellation)) return NativeShortVideoFeedPaging.ReadResult.failure(NativeShortVideoFeedPaging.Failure.OFFLINE);
    if (result.succeeded() && !result.value.items.isEmpty()) {
      FeedPage page = result.value;
      // A successful refresh belongs to the original page key. Neither the
      // stale response nor a retired request may populate the local cache.
      Runnable publish = () -> cache.put(feedUrl, new CachedFeedPage(page.copy(), SystemClock.elapsedRealtime()));
      if (cancellation == null) publish.run();
      else if (!cancellation.publish(publish)) return NativeShortVideoFeedPaging.ReadResult.failure(NativeShortVideoFeedPaging.Failure.OFFLINE);
    }
    return result;
  }

  private NativeShortVideoFeedPaging.ReadResult<FeedPage> readUncached(String feedUrl, NativeShortVideoFeedTransport.Cancellation cancellation) {
    FeedPage page = new FeedPage();
    try {
      Uri uri = Uri.parse(feedUrl);
      page.offset = Math.max(0, Integer.parseInt(uri.getQueryParameter("offset") == null ? "0" : uri.getQueryParameter("offset")));
      page.limit = Math.max(1, Integer.parseInt(uri.getQueryParameter("limit") == null ? String.valueOf(defaultPageLimit) : uri.getQueryParameter("limit")));
    } catch (Exception ignored) {}
    return transport.read(feedUrl, body -> {
      if (cancelled(cancellation)) throw new java.io.InterruptedIOException("feed read cancelled");
      JSONObject data = new JSONObject(body);
      String cacheState = data.optString("cacheState", "");
      if (data.optBoolean("offline", false) || "offline".equals(cacheState)) {
        return NativeShortVideoFeedTransport.Parsed.reject(NativeShortVideoFeedPaging.Failure.OFFLINE_CACHE);
      }
      if (data.optBoolean("stale", false) || "stale-refreshing".equals(cacheState)) {
        return NativeShortVideoFeedTransport.Parsed.reject(NativeShortVideoFeedPaging.Failure.STALE_CACHE);
      }
      page.offset = Math.max(0, data.optInt("offset", page.offset));
      page.limit = Math.max(1, data.optInt("limit", page.limit));
      page.total = Math.max(0, data.optInt("total", 0));
      page.stats = FeedStats.fromJson(data.optJSONObject("stats"));
      page.hasMore = data.optBoolean("hasMore", false);
      page.nextCursor = data.optString("nextCursor", "");
      JSONArray rows = data.optJSONArray("videos");
      if (rows == null) throw new IllegalArgumentException("videos array missing");
      String baseUrl = baseFromUrl(feedUrl);
      for (int i = 0; i < rows.length(); i++) {
        ShortVideoItem item = ShortVideoFeedContract.itemFromJson(rows.optJSONObject(i), baseUrl, String.valueOf(i));
        if (item != null) page.items.add(item);
      }
      if (page.total == 0) page.total = page.items.size();
      if (page.stats.isEmpty()) page.stats = FeedStats.fromItems(page.items);
      if (cancelled(cancellation)) throw new java.io.InterruptedIOException("feed read cancelled");
      return new NativeShortVideoFeedTransport.Parsed<>(page, page.hasMore, page.nextCursor);
    }, cancellation);
  }

  private boolean cancelled(NativeShortVideoFeedTransport.Cancellation cancellation) {
    return cancellation != null && cancellation.isCancelled();
  }

  private String forceRefreshUrl(String feedUrl) {
    try {
      Uri uri = Uri.parse(feedUrl);
      if (!"/api/short-videos".equals(uri.getPath()) || uri.getQueryParameter("refresh") != null) return null;
      return uri.buildUpon().appendQueryParameter("refresh", "1").build().toString();
    } catch (Exception ignored) {
      return null;
    }
  }

  private String baseFromUrl(String value) {
    try {
      Uri uri = Uri.parse(value);
      return uri.buildUpon().encodedPath("").encodedQuery(null).fragment(null).build().toString().replaceAll("/$", "");
    } catch (Exception ignored) {
      return "";
    }
  }
}
