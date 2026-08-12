package local.fanhao.library;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/** Canonical accepted server action values shared by every screen instance. */
final class NativeShortVideoActionSnapshots {
  private static final int MAX_SNAPSHOTS = 512;
  interface Target {
    String actionVideoId();
    Snapshot currentActionSnapshot();
    void applyActionSnapshot(Snapshot snapshot);
  }

  static final class Snapshot {
    final boolean hasLiked;
    final boolean liked;
    final boolean hasCollected;
    final boolean collected;
    final boolean hasLikes;
    final long likes;
    final boolean hasCollects;
    final long collects;

    Snapshot(boolean hasLiked, boolean liked, boolean hasCollected, boolean collected,
             boolean hasLikes, long likes, boolean hasCollects, long collects) {
      this.hasLiked = hasLiked;
      this.liked = liked;
      this.hasCollected = hasCollected;
      this.collected = collected;
      this.hasLikes = hasLikes;
      this.likes = Math.max(0, likes);
      this.hasCollects = hasCollects;
      this.collects = Math.max(0, collects);
    }
  }

  private final Map<String, Snapshot> byVideoId = new LinkedHashMap<>(16, 0.75f, true);
  private long actionRevision;

  long revision() {
    return actionRevision;
  }

  Snapshot acceptAction(String videoId, Snapshot update) {
    actionRevision++;
    return accept(videoId, update);
  }

  void acceptFeed(List<? extends Target> targets, long requestRevision) {
    if (targets == null) return;
    if (requestRevision != actionRevision) {
      applyAll(targets);
      return;
    }
    for (Target target : targets) {
      if (target != null) accept(target.actionVideoId(), target.currentActionSnapshot());
    }
  }

  Snapshot accept(String videoId, Snapshot update) {
    String id = cleanId(videoId);
    if (id.length() == 0 || update == null) return null;
    Snapshot previous = byVideoId.get(id);
    Snapshot merged = previous == null ? update : new Snapshot(
      update.hasLiked || previous.hasLiked,
      update.hasLiked ? update.liked : previous.liked,
      update.hasCollected || previous.hasCollected,
      update.hasCollected ? update.collected : previous.collected,
      update.hasLikes || previous.hasLikes,
      update.hasLikes ? update.likes : previous.likes,
      update.hasCollects || previous.hasCollects,
      update.hasCollects ? update.collects : previous.collects
    );
    if (previous == null && byVideoId.size() >= MAX_SNAPSHOTS) {
      byVideoId.remove(byVideoId.keySet().iterator().next());
    }
    byVideoId.put(id, merged);
    return merged;
  }

  void apply(Target target) {
    if (target == null) return;
    Snapshot snapshot = byVideoId.get(cleanId(target.actionVideoId()));
    if (snapshot != null) target.applyActionSnapshot(snapshot);
  }

  void applyAll(List<? extends Target> targets) {
    if (targets == null) return;
    for (Target target : targets) apply(target);
  }

  void remove(String videoId) {
    byVideoId.remove(cleanId(videoId));
  }
  Map<String, Snapshot> snapshotMap() { return new LinkedHashMap<>(byVideoId); }

  private static String cleanId(String value) {
    String clean = String.valueOf(value == null ? "" : value).trim();
    return clean.length() <= 512 ? clean : "";
  }
}
