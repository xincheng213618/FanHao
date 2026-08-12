package local.fanhao.library;

import java.util.ArrayList;
import java.util.List;

/** Applies canonical action values to every model instance held by the UI. */
final class NativeShortVideoActionModels {
  private NativeShortVideoActionModels() {}

  static void applyAll(
      NativeShortVideoActionSnapshots snapshots,
      List<ShortVideoItem> videos,
      ScreenState current,
      List<ScreenState> navigationStack) {
    snapshots.applyAll(videos);
    apply(snapshots, current);
    if (navigationStack != null) for (ScreenState screen : navigationStack) apply(snapshots, screen);
  }

  static void apply(NativeShortVideoActionSnapshots snapshots, ScreenState screen) {
    if (screen instanceof FeedScreenState) {
      snapshots.applyAll(((FeedScreenState) screen).items);
    } else if (screen instanceof AuthorScreenState) {
      AuthorScreenState author = (AuthorScreenState) screen;
      snapshots.apply(author.seed);
      snapshots.apply(author.currentItem);
      if (author.page != null) snapshots.applyAll(author.page.items);
    }
  }
}
