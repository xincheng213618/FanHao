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
    CachedFeedPage cached = cache.get(feedUrl);
    if (cached != null && SystemClock.elapsedRealtime() - cached.cachedAtMs <= cacheMaxAgeMs) {
      Log.i(TAG, "feed cache hit " + feedUrl);
      FeedPage page = cached.page.copy();
      return NativeShortVideoFeedPaging.ReadResult.success(page, page.hasMore, page.nextCursor);
    }
    FeedPage page = new FeedPage();
    try {
      Uri uri = Uri.parse(feedUrl);
      page.offset = Math.max(0, Integer.parseInt(uri.getQueryParameter("offset") == null ? "0" : uri.getQueryParameter("offset")));
      page.limit = Math.max(1, Integer.parseInt(uri.getQueryParameter("limit") == null ? String.valueOf(defaultPageLimit) : uri.getQueryParameter("limit")));
    } catch (Exception ignored) {}
    return transport.read(feedUrl, body -> {
      JSONObject data = new JSONObject(body);
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
      if (!page.items.isEmpty()) cache.put(feedUrl, new CachedFeedPage(page.copy(), SystemClock.elapsedRealtime()));
      return new NativeShortVideoFeedTransport.Parsed<>(page, page.hasMore, page.nextCursor);
    });
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
