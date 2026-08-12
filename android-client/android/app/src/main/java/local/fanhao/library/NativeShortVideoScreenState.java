package local.fanhao.library;

import android.widget.ScrollView;

import androidx.annotation.Nullable;

import java.util.ArrayList;
import java.util.List;

/** Back-stack models kept outside the Activity's lifecycle and HTTP orchestration. */
abstract class ScreenState {}

final class FeedScreenState extends ScreenState {
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

final class AuthorScreenState extends ScreenState {
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
