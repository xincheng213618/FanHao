package local.fanhao.library;

/** Resolves end-of-item continuation after a page has been de-duplicated. */
final class NativeShortVideoFeedAutoAdvance {
  enum Action {
    NONE,
    ADVANCE,
    LOAD_MORE,
    END
  }

  static Action resolve(
    NativeShortVideoFeedPaging paging,
    int requestedIndex,
    int currentIndex,
    int itemCount
  ) {
    if (!paging.isPendingAutoAdvance(requestedIndex)) return Action.NONE;
    if (currentIndex != requestedIndex) {
      paging.clearPendingAutoAdvance();
      return Action.NONE;
    }
    if (requestedIndex + 1 < Math.max(0, itemCount)) {
      paging.clearPendingAutoAdvance();
      return Action.ADVANCE;
    }
    if (!paging.hasMore()) {
      paging.clearPendingAutoAdvance();
      return Action.END;
    }
    return Action.LOAD_MORE;
  }

  private NativeShortVideoFeedAutoAdvance() {}
}
