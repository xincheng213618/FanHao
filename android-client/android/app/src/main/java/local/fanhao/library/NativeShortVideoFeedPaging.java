package local.fanhao.library;

/**
 * Owns the identity of the currently visible feed and its one in-flight continuation request.
 * This class deliberately has no Android dependencies so its race/error contract can run under javac.
 */
final class NativeShortVideoFeedPaging {
  enum Completion {
    APPLIED,
    FAILED,
    STALE
  }

  enum Failure {
    HTTP,
    OFFLINE,
    TIMEOUT,
    PARSE
  }

  static final class ReadResult<T> {
    final T value;
    final Failure failure;
    final boolean hasMore;
    final String nextCursor;

    private ReadResult(T value, Failure failure, boolean hasMore, String nextCursor) {
      this.value = value;
      this.failure = failure;
      this.hasMore = hasMore;
      this.nextCursor = clean(nextCursor);
    }

    static <T> ReadResult<T> success(T value, boolean hasMore, String nextCursor) {
      if (value == null) throw new IllegalArgumentException("successful feed result requires a value");
      return new ReadResult<>(value, null, hasMore, nextCursor);
    }

    static <T> ReadResult<T> failure(Failure failure) {
      if (failure == null) throw new IllegalArgumentException("failed feed result requires a category");
      return new ReadResult<>(null, failure, false, "");
    }

    boolean succeeded() {
      return failure == null;
    }

    String publicMessage() {
      if (failure == Failure.TIMEOUT) return "短视频加载超时，请重试";
      if (failure == Failure.OFFLINE) return "网络不可用，短视频加载失败，请重试";
      if (failure == Failure.PARSE) return "短视频响应格式异常，请重试";
      return "短视频服务暂时不可用，请重试";
    }
  }

  static final class Request {
    final long generation;
    final long requestId;
    final String feedUrl;
    final String cursor;

    private Request(long generation, long requestId, String feedUrl, String cursor) {
      this.generation = generation;
      this.requestId = requestId;
      this.feedUrl = feedUrl;
      this.cursor = cursor;
    }
  }

  private long generation;
  private long requestSequence;
  private long activeRequestId;
  private String feedUrl = "";
  private String cursor = "";
  private boolean hasMore;
  private boolean loading;
  private int pendingAutoAdvanceIndex = -1;

  void replaceFeed(String feedUrl, String cursor, boolean hasMore) {
    generation++;
    activeRequestId = 0;
    loading = false;
    pendingAutoAdvanceIndex = -1;
    this.feedUrl = clean(feedUrl);
    this.cursor = clean(cursor);
    this.hasMore = hasMore;
  }

  long beginFeedReplacement(String feedUrl) {
    generation++;
    activeRequestId = 0;
    loading = true;
    pendingAutoAdvanceIndex = -1;
    this.feedUrl = clean(feedUrl);
    this.cursor = "";
    this.hasMore = false;
    return generation;
  }

  boolean finishFeedReplacement(long expectedGeneration, String expectedFeedUrl) {
    if (generation != expectedGeneration || !feedUrl.equals(clean(expectedFeedUrl))) return false;
    loading = false;
    return true;
  }

  Request beginLoadMore(String feedUrl, String cursor, boolean hasMore) {
    if (loading || !hasMore) return null;
    String normalizedUrl = clean(feedUrl);
    String normalizedCursor = clean(cursor);
    if (!this.feedUrl.equals(normalizedUrl) || !this.cursor.equals(normalizedCursor)) {
      replaceFeed(normalizedUrl, normalizedCursor, hasMore);
    }
    loading = true;
    activeRequestId = ++requestSequence;
    return new Request(generation, activeRequestId, normalizedUrl, normalizedCursor);
  }

  Completion complete(Request request, ReadResult<?> result) {
    if (!matches(request)) return Completion.STALE;
    loading = false;
    activeRequestId = 0;
    if (result == null || !result.succeeded()) {
      pendingAutoAdvanceIndex = -1;
      return Completion.FAILED;
    }
    cursor = result.nextCursor;
    hasMore = result.hasMore;
    return Completion.APPLIED;
  }

  boolean isLoading() {
    return loading;
  }

  boolean hasMore() {
    return hasMore;
  }

  String cursor() {
    return cursor;
  }

  long generation() {
    return generation;
  }

  void markPendingAutoAdvance(int index) {
    pendingAutoAdvanceIndex = index;
  }

  boolean isPendingAutoAdvance(int index) {
    return pendingAutoAdvanceIndex == index;
  }

  int pendingAutoAdvanceIndex() {
    return pendingAutoAdvanceIndex;
  }

  void clearPendingAutoAdvance() {
    pendingAutoAdvanceIndex = -1;
  }

  private boolean matches(Request request) {
    return request != null
      && request.generation == generation
      && request.requestId == activeRequestId
      && request.feedUrl.equals(feedUrl)
      && request.cursor.equals(cursor);
  }

  private static String clean(String value) {
    return value == null ? "" : value.trim();
  }
}
