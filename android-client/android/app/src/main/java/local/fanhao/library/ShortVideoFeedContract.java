package local.fanhao.library;

import android.net.Uri;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;
import java.util.Locale;

final class ShortVideoFeedContract {
  static final int SCHEMA_VERSION = 1;
  static final int DEFAULT_PAGE_LIMIT = 18;

  private ShortVideoFeedContract() {}

  static List<ShortVideoItem> decode(String json, String baseUrl) throws JSONException {
    String normalized = json == null ? "" : json.trim();
    if (normalized.length() == 0) throw new JSONException("short-video feed is empty");
    JSONArray rows;
    if (normalized.charAt(0) == '[') {
      rows = new JSONArray(normalized);
    } else {
      JSONObject envelope = new JSONObject(normalized);
      int schemaVersion = envelope.optInt("schemaVersion", -1);
      if (schemaVersion != SCHEMA_VERSION) {
        throw new JSONException("unsupported short-video feed schema: " + schemaVersion);
      }
      rows = envelope.optJSONArray("videos");
      if (rows == null) throw new JSONException("short-video feed is missing videos");
    }
    List<ShortVideoItem> items = new ArrayList<>();
    for (int index = 0; index < rows.length(); index++) {
      ShortVideoItem item = itemFromJson(rows.optJSONObject(index), baseUrl, String.valueOf(index));
      if (item != null) items.add(item);
    }
    return items;
  }

  static ShortVideoItem itemFromJson(JSONObject row, String baseUrl, String fallbackId) {
    if (row == null) return null;
    String mediaType = row.optString("mediaType", "video").trim().toLowerCase(Locale.ROOT);
    String streamUrl = mobilePlaybackUrl(row, baseUrl);
    List<GalleryMedia> galleryItems = new ArrayList<>();
    JSONArray galleryMedia = row.optJSONArray("galleryItems");
    if (galleryMedia == null || galleryMedia.length() == 0) galleryMedia = row.optJSONArray("galleryImages");
    if (galleryMedia != null) {
      for (int index = 0; index < galleryMedia.length(); index++) {
        JSONObject entry = galleryMedia.optJSONObject(index);
        String url = absoluteUrl(baseUrl, entry == null ? "" : entry.optString("url", ""));
        String posterUrl = absoluteUrl(baseUrl, entry == null ? "" : entry.optString("posterUrl", ""));
        if (url.length() > 0) galleryItems.add(new GalleryMedia(
          entry == null ? "image" : entry.optString("type", "image"),
          url,
          posterUrl
        ));
      }
    }
    if (streamUrl.length() == 0 && galleryItems.isEmpty()) return null;
    if (!galleryItems.isEmpty()) mediaType = "gallery";
    JSONObject soundJson = row.optJSONObject("sound");
    ShortVideoSound sound = soundJson == null
      ? ShortVideoSound.EMPTY
      : new ShortVideoSound(
        soundJson.optString("key", ""),
        soundJson.optString("id", ""),
        soundJson.optString("title", ""),
        soundJson.optString("author", ""),
        absoluteUrl(baseUrl, soundJson.optString("coverUrl", "")),
        absoluteUrl(baseUrl, soundJson.optString("previewUrl", "")),
        soundJson.optString("previewSource", ""),
        soundJson.optBoolean("localAvailable", false),
        soundJson.optBoolean("original", false)
      );
    JSONObject author = row.optJSONObject("author");
    JSONObject stats = row.optJSONObject("stats");
    JSONObject actions = row.optJSONObject("actions");
    JSONObject actualVideo = row.optJSONObject("actualVideo");
    int width = row.optInt("width", actualVideo == null ? 0 : actualVideo.optInt("width", 0));
    int height = row.optInt("height", actualVideo == null ? 0 : actualVideo.optInt("height", 0));
    return new ShortVideoItem(
      row.optString("id", fallbackId),
      row.optString("awemeId", ""),
      mediaType,
      streamUrl,
      absoluteUrl(baseUrl, row.optString("coverUrl", "")),
      row.optString("galleryPresentation", ""),
      galleryItems,
      sound,
      row.optString("title", ""),
      author == null ? "" : author.optString("id", ""),
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
      author != null && author.optBoolean("following", false),
      row.optString("publishedAt", ""),
      row.optLong("durationMs", 0),
      width,
      height,
      stats == null ? 0 : stats.optLong("likes", 0),
      stats == null ? 0 : stats.optLong("comments", 0),
      stats == null ? 0 : stats.optLong("collects", 0),
      stats == null ? 0 : stats.optLong("shares", 0),
      stats == null ? 0 : stats.optLong("plays", 0),
      row.optBoolean("libraryLiked", false),
      actions != null && actions.optBoolean("liked", false),
      actions != null && actions.optBoolean("collected", false),
      row.optString("shareUrl", ""),
      row.optString("originalUrl", "")
    );
  }

  private static String mobilePlaybackUrl(JSONObject row, String baseUrl) {
    String mobileStreamUrl = row.optString("mobileStreamUrl", "").trim();
    return absoluteUrl(baseUrl, mobileStreamUrl.length() > 0 ? mobileStreamUrl : row.optString("streamUrl", ""));
  }

  private static String absoluteUrl(String baseUrl, String value) {
    if (value == null || value.trim().isEmpty()) return "";
    String trimmed = value.trim();
    if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) return trimmed;
    if (baseUrl == null || baseUrl.trim().isEmpty()) return trimmed;
    Uri base = Uri.parse(baseUrl);
    return base.buildUpon().encodedPath(trimmed.startsWith("/") ? trimmed : "/" + trimmed).encodedQuery(null).fragment(null).build().toString();
  }
}
