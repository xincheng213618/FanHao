package local.fanhao.library;

import androidx.annotation.Nullable;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.Collections;
import java.util.HashSet;
import java.util.List;
import java.util.Set;

final class FeedPage {
  final List<ShortVideoItem> items = new ArrayList<>();
  int offset = 0;
  int limit = ShortVideoFeedContract.DEFAULT_PAGE_LIMIT;
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

final class CachedFeedPage {
  final FeedPage page;
  final long cachedAtMs;

  CachedFeedPage(FeedPage page, long cachedAtMs) {
    this.page = page;
    this.cachedAtMs = cachedAtMs;
  }
}

final class FeedStats {
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

final class DeleteResult {
  final Set<String> ids = new HashSet<>();
  int count;
  int deletedFiles;

  static DeleteResult fromJson(JSONObject row, ShortVideoItem fallback) {
    DeleteResult result = new DeleteResult();
    JSONArray ids = row == null ? null : row.optJSONArray("ids");
    if (ids != null) {
      for (int index = 0; index < ids.length(); index++) {
        String id = ids.optString(index, "").trim();
        if (id.length() > 0) result.ids.add(id);
      }
    }
    if (result.ids.isEmpty() && fallback != null && fallback.id.length() > 0) result.ids.add(fallback.id);
    result.count = row == null ? result.ids.size() : Math.max(result.ids.size(), row.optInt("count", result.ids.size()));
    JSONArray files = row == null ? null : row.optJSONArray("deletedFiles");
    result.deletedFiles = files == null ? 0 : files.length();
    return result;
  }
}

final class ShortVideoItem {
  final String id;
  final String awemeId;
  final String mediaType;
  final String streamUrl;
  final String coverUrl;
  final List<GalleryMedia> galleryItems;
  final ShortVideoSound sound;
  final String title;
  final String authorId;
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
  boolean authorFollowing;
  final String publishedAt;
  final long durationMs;
  final int width;
  final int height;
  final long likes;
  final long comments;
  final long collects;
  final long shares;
  final long plays;
  final boolean libraryLiked;
  final String shareUrl;
  final String originalUrl;

  ShortVideoItem(String id, String awemeId, String mediaType, String streamUrl, String coverUrl, List<GalleryMedia> galleryItems, ShortVideoSound sound, String title, String authorId, String author, String authorSecUid, String authorUid, String authorAvatarUrl, String authorProfileUrl, String authorUniqueId, String authorShortId, String authorSignature, String authorIpLocation, long authorFollowerCount, long authorFollowingCount, long authorTotalFavorited, long authorAwemeCount, long authorFavoritingCount, int authorGender, int authorAge, String authorVerification, String authorProfileCollectedAt, boolean authorFollowing, String publishedAt, long durationMs, int width, int height, long likes, long comments, long collects, long shares, long plays, boolean libraryLiked, String shareUrl, String originalUrl) {
    this.id = id == null ? "" : id;
    this.awemeId = awemeId == null ? "" : awemeId;
    this.mediaType = mediaType == null ? "video" : mediaType;
    this.streamUrl = streamUrl == null ? "" : streamUrl;
    this.coverUrl = coverUrl == null ? "" : coverUrl;
    this.galleryItems = galleryItems == null ? Collections.emptyList() : Collections.unmodifiableList(new ArrayList<>(galleryItems));
    this.sound = sound == null ? ShortVideoSound.EMPTY : sound;
    this.title = title == null ? "" : title;
    this.authorId = authorId == null ? "" : authorId;
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
    this.authorFollowing = authorFollowing;
    this.publishedAt = publishedAt == null ? "" : publishedAt;
    this.durationMs = durationMs;
    this.width = Math.max(0, width);
    this.height = Math.max(0, height);
    this.likes = likes;
    this.comments = comments;
    this.collects = collects;
    this.shares = shares;
    this.plays = plays;
    this.libraryLiked = libraryLiked;
    this.shareUrl = shareUrl == null ? "" : shareUrl;
    this.originalUrl = originalUrl == null ? "" : originalUrl;
  }

  boolean isGallery() {
    return "gallery".equals(mediaType) && !galleryItems.isEmpty();
  }
}

final class GalleryMedia {
  final String type;
  final String url;

  GalleryMedia(String type, String url) {
    this.type = "video".equals(type) ? "video" : "image";
    this.url = url == null ? "" : url;
  }

  boolean isVideo() {
    return "video".equals(type);
  }
}

final class ShortVideoSound {
  static final ShortVideoSound EMPTY = new ShortVideoSound("", "", "", "", "", "", "", false, false);
  final String key;
  final String id;
  final String title;
  final String author;
  final String coverUrl;
  final String previewUrl;
  final String previewSource;
  final boolean localAvailable;
  final boolean original;

  ShortVideoSound(String key, String id, String title, String author, String coverUrl, String previewUrl, String previewSource, boolean localAvailable, boolean original) {
    this.key = key == null ? "" : key;
    this.id = id == null ? "" : id;
    this.title = title == null ? "" : title;
    this.author = author == null ? "" : author;
    this.coverUrl = coverUrl == null ? "" : coverUrl;
    this.previewUrl = previewUrl == null ? "" : previewUrl;
    this.previewSource = previewSource == null ? "" : previewSource;
    this.localAvailable = localAvailable;
    this.original = original;
  }

  boolean isPlayable() {
    return previewUrl.length() > 0;
  }
}
