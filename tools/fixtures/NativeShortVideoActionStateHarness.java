package local.fanhao.library;

import java.util.Arrays;
import java.util.List;

public final class NativeShortVideoActionStateHarness {
  public static void main(String[] args) {
    verifyServerScopeIsolation();
    verifyLatestIntentWinsOverOldCompletion();
    verifyFailureRollsBackOnlyCurrentIntent();
    verifyRestoredAndLegacyResumeAreSingleFlight();
    verifyQueuedOppositeIntentSurvivesSnapshotRestore();
    verifyRestoredFailureRetriesOnlyWhenResumed();
    verifyLegacyFailureEventuallyConverges();
    verifyStaleCompletionsAreRejected();
    verifyNoOpsDoNotConsumeCapacity();
    verifyCapacityRejectionIsExplicit();
    verifyCanonicalSnapshotsReachEveryInstance();
    verifyCanonicalSnapshotsMergeMissingFields();
    verifyCanonicalSnapshotsAreBounded();
    verifyFeedRevisionOrdering();
    verifyRejectedStaleResponseCannotOverwriteRestoredScreen();
    verifyLegacyReconcilesWithoutDowngradingServerTruth();
    System.out.println(
      "native-short-video-action-state: ok "
        + "(scope, single-flight, restore, generation, rollback, capacity, legacy, canonical snapshots)"
    );
  }

  private static void verifyServerScopeIsolation() {
    check(
      "http://example.test".equals(NativeShortVideoActionState.serverScope("http://EXAMPLE.test:80/api/short-videos")),
      "default HTTP port must normalize"
    );
    check(
      "https://example.test:9443".equals(NativeShortVideoActionState.serverScope("https://Example.Test:9443/path?q=1")),
      "non-default port must scope actions"
    );
    check(
      NativeShortVideoActionState.serverScope("not a URL").isEmpty(),
      "invalid server address must never gain a shared action scope"
    );
  }

  private static void verifyLatestIntentWinsOverOldCompletion() {
    NativeShortVideoActionState state = new NativeShortVideoActionState(null);
    NativeShortVideoActionState.Mutation first = state.request(
      "video-1",
      NativeShortVideoActionState.Type.LIKE,
      false,
      true
    ).mutation;
    check(first != null && first.active, "first like must start exactly one request");
    NativeShortVideoActionState.Mutation duplicate = state.request(
      "video-1",
      NativeShortVideoActionState.Type.LIKE,
      false,
      false
    ).mutation;
    check(
      duplicate == null && !state.active("video-1", NativeShortVideoActionState.Type.LIKE, false),
      "new intent must be immediate while old request stays single-flight"
    );
    NativeShortVideoActionState.Completion oldSuccess = state.completeSuccess(first, true);
    check(oldSuccess.accepted, "the active generation must accept its server response");
    check(
      oldSuccess.next != null && !oldSuccess.next.active,
      "old success must schedule the newer unlike intent instead of overwriting it"
    );
    NativeShortVideoActionState.Completion latestSuccess = state.completeSuccess(oldSuccess.next, false);
    check(latestSuccess.accepted, "the queued latest generation must accept its server response");
    check(
      !state.active("video-1", NativeShortVideoActionState.Type.LIKE, false)
        && !state.pending("video-1", NativeShortVideoActionState.Type.LIKE),
      "latest server confirmation must converge after the queued request"
    );
  }

  private static void verifyFailureRollsBackOnlyCurrentIntent() {
    NativeShortVideoActionState state = new NativeShortVideoActionState(null);
    NativeShortVideoActionState.Mutation first = state.request(
      "video-2",
      NativeShortVideoActionState.Type.COLLECT,
      false,
      true
    ).mutation;
    state.request("video-2", NativeShortVideoActionState.Type.COLLECT, false, false);
    NativeShortVideoActionState.Completion oldFailure = state.completeFailure(first);
    check(oldFailure.accepted, "the in-flight failure must be accepted once");
    check(
      !oldFailure.rolledBack
        && oldFailure.next == null
        && !state.active("video-2", NativeShortVideoActionState.Type.COLLECT, false),
      "an old failure must preserve the newer intent when it already matches the confirmed server value"
    );
    NativeShortVideoActionState.Mutation current = state.request(
      "video-2",
      NativeShortVideoActionState.Type.COLLECT,
      false,
      true
    ).mutation;
    NativeShortVideoActionState.Completion currentFailure = state.completeFailure(current);
    check(
      currentFailure.accepted
        && currentFailure.rolledBack
        && !state.active("video-2", NativeShortVideoActionState.Type.COLLECT, false),
      "the current failure must restore the last confirmed server value"
    );
  }

  private static void verifyRestoredAndLegacyResumeAreSingleFlight() {
    NativeShortVideoActionState restored = new NativeShortVideoActionState(Arrays.asList(
      new NativeShortVideoActionState.Stored(
        "restored-video",
        NativeShortVideoActionState.Type.LIKE,
        false,
        true,
        false,
        true
      )
    ));
    NativeShortVideoActionState.Mutation restoredFirst = restored.resume(
      "restored-video",
      NativeShortVideoActionState.Type.LIKE
    );
    NativeShortVideoActionState.Mutation restoredSecond = restored.resume(
      "restored-video",
      NativeShortVideoActionState.Type.LIKE
    );
    check(
      restoredFirst != null && restoredFirst.generation > 0 && restoredSecond == null,
      "a restored pending intent must allocate a non-zero generation and resume only one PUT"
    );

    NativeShortVideoActionState legacy = new NativeShortVideoActionState(null);
    legacy.importLegacy("legacy-video", NativeShortVideoActionState.Type.COLLECT);
    NativeShortVideoActionState.Mutation legacyFirst = legacy.resume(
      "legacy-video",
      NativeShortVideoActionState.Type.COLLECT
    );
    NativeShortVideoActionState.Mutation legacySecond = legacy.resume(
      "legacy-video",
      NativeShortVideoActionState.Type.COLLECT
    );
    check(
      legacyFirst != null && legacyFirst.generation > 0 && legacyFirst.active && legacySecond == null,
      "a legacy migration must resume only one explicit active=true PUT"
    );
  }

  private static void verifyQueuedOppositeIntentSurvivesSnapshotRestore() {
    NativeShortVideoActionState beforeRestart = new NativeShortVideoActionState(null);
    NativeShortVideoActionState.Mutation enabling = beforeRestart.request(
      "restart-video",
      NativeShortVideoActionState.Type.LIKE,
      false,
      true
    ).mutation;
    check(enabling != null && enabling.active, "fixture must start an enabling request");
    check(
      beforeRestart.request("restart-video", NativeShortVideoActionState.Type.LIKE, false, false).mutation == null,
      "the opposite intent must queue behind the enabling request"
    );

    List<NativeShortVideoActionState.Stored> serialized = beforeRestart.snapshot();
    check(serialized.size() == 1, "an in-flight action with a queued opposite intent must be serialized");
    check(
      !serialized.get(0).desired && serialized.get(0).reconcileRequired,
      "the serialized action must retain the latest false intent and require server reconciliation"
    );

    NativeShortVideoActionState restored = new NativeShortVideoActionState(serialized);
    restored.observeServer("unrelated-video", NativeShortVideoActionState.Type.LIKE, false);
    check(
      restored.pending("restart-video", NativeShortVideoActionState.Type.LIKE),
      "an unrelated server snapshot must not settle the restored target"
    );
    restored.observeServer("restart-video", NativeShortVideoActionState.Type.LIKE, true);
    NativeShortVideoActionState.Mutation disabling = restored.resume(
      "restart-video",
      NativeShortVideoActionState.Type.LIKE
    );
    check(
      disabling != null && disabling.generation > 0 && !disabling.active,
      "after observing the target as true, restore must explicitly send the queued active=false intent"
    );
    NativeShortVideoActionState.Completion completion = restored.completeSuccess(disabling, false);
    check(
      completion.accepted && !restored.pending("restart-video", NativeShortVideoActionState.Type.LIKE),
      "the restored opposite intent must converge and leave no pending second authority"
    );
  }

  private static void verifyRestoredFailureRetriesOnlyWhenResumed() {
    NativeShortVideoActionState restored = new NativeShortVideoActionState(Arrays.asList(
      new NativeShortVideoActionState.Stored(
        "retry-video",
        NativeShortVideoActionState.Type.COLLECT,
        false,
        true,
        false,
        true
      )
    ));
    NativeShortVideoActionState.Mutation first = restored.resume(
      "retry-video",
      NativeShortVideoActionState.Type.COLLECT
    );
    NativeShortVideoActionState.Completion failure = restored.completeFailure(first);
    check(
      failure.accepted && failure.rolledBack && failure.next == null,
      "a current restored failure must roll back without an immediate retry loop"
    );
    check(
      restored.pending("retry-video", NativeShortVideoActionState.Type.COLLECT),
      "a failed restored reconciliation must remain explicitly pending for delayed retry"
    );
    NativeShortVideoActionState.Mutation retry = restored.resume(
      "retry-video",
      NativeShortVideoActionState.Type.COLLECT
    );
    check(
      retry != null && !retry.active && retry.generation != first.generation
        && restored.resume("retry-video", NativeShortVideoActionState.Type.COLLECT) == null,
      "delayed retry must use a new generation, send the confirmed explicit value, and remain single-flight"
    );
    NativeShortVideoActionState.Completion success = restored.completeSuccess(retry, false);
    check(
      success.accepted && !restored.pending("retry-video", NativeShortVideoActionState.Type.COLLECT),
      "successful delayed retry must clear reconciliation state"
    );
  }

  private static void verifyLegacyFailureEventuallyConverges() {
    NativeShortVideoActionState state = new NativeShortVideoActionState(null);
    state.importLegacy("legacy-retry-video", NativeShortVideoActionState.Type.LIKE);
    NativeShortVideoActionState.Mutation first = state.resume(
      "legacy-retry-video",
      NativeShortVideoActionState.Type.LIKE
    );
    NativeShortVideoActionState.Completion failure = state.completeFailure(first);
    check(
      failure.accepted && failure.rolledBack && failure.next == null,
      "a legacy failure must roll back without spinning an immediate retry"
    );
    check(
      state.pending("legacy-retry-video", NativeShortVideoActionState.Type.LIKE),
      "failed legacy migration must remain pending"
    );
    NativeShortVideoActionState.Mutation retry = state.resume(
      "legacy-retry-video",
      NativeShortVideoActionState.Type.LIKE
    );
    check(
      retry != null && retry.active && retry.generation != first.generation
        && state.resume("legacy-retry-video", NativeShortVideoActionState.Type.LIKE) == null,
      "legacy retry must use a new generation, restore active=true, and remain single-flight"
    );
    NativeShortVideoActionState.Completion success = state.completeSuccess(retry, true);
    check(success.accepted, "the retried legacy success must be accepted");
    check(
      state.drainAcknowledgedLegacy().size() == 1 && state.snapshot().isEmpty(),
      "a later legacy success must acknowledge migration and converge"
    );
  }

  private static void verifyStaleCompletionsAreRejected() {
    NativeShortVideoActionState state = new NativeShortVideoActionState(null);
    NativeShortVideoActionState.Mutation first = state.request(
      "ordering-video",
      NativeShortVideoActionState.Type.LIKE,
      false,
      true
    ).mutation;
    state.request("ordering-video", NativeShortVideoActionState.Type.LIKE, false, false);
    NativeShortVideoActionState.Completion firstCompletion = state.completeSuccess(first, true);
    NativeShortVideoActionState.Mutation latest = firstCompletion.next;
    check(firstCompletion.accepted && latest != null && !latest.active, "fixture must advance to the queued generation");

    NativeShortVideoActionState.Completion staleSuccess = state.completeSuccess(first, true);
    NativeShortVideoActionState.Completion staleFailure = state.completeFailure(first);
    check(
      !staleSuccess.accepted && staleSuccess.next == null && !staleSuccess.rolledBack,
      "a duplicated old success must be rejected"
    );
    check(
      !staleFailure.accepted && staleFailure.next == null && !staleFailure.rolledBack,
      "an out-of-order old failure must be rejected"
    );
    check(
      !state.active("ordering-video", NativeShortVideoActionState.Type.LIKE, true)
        && state.pending("ordering-video", NativeShortVideoActionState.Type.LIKE),
      "rejected stale completions must not alter the latest optimistic intent"
    );
    NativeShortVideoActionState.Completion latestCompletion = state.completeSuccess(latest, false);
    check(
      latestCompletion.accepted && !state.pending("ordering-video", NativeShortVideoActionState.Type.LIKE),
      "the actual in-flight generation must still be accepted and converge"
    );
  }

  private static void verifyNoOpsDoNotConsumeCapacity() {
    NativeShortVideoActionState state = new NativeShortVideoActionState(null);
    int noOpCount = NativeShortVideoActionState.MAX_STORED_ACTIONS + 64;
    for (int index = 0; index < noOpCount; index++) {
      NativeShortVideoActionState.RequestResult noOp = state.request(
        "already-liked-" + index,
        NativeShortVideoActionState.Type.LIKE,
        true,
        true
      );
      check(noOp.accepted && noOp.mutation == null, "requesting the confirmed value must remain an accepted no-op");
    }
    check(state.pendingCount() == 0 && state.snapshot().isEmpty(), "settled no-ops must be pruned immediately");
    NativeShortVideoActionState.Mutation real = state.request(
      "real-after-noops",
      NativeShortVideoActionState.Type.LIKE,
      false,
      true
    ).mutation;
    check(
      real != null && real.active,
      "more than the storage cap of no-ops must not block a later real action"
    );
  }

  private static void verifyCapacityRejectionIsExplicit() {
    NativeShortVideoActionState state = new NativeShortVideoActionState(null);
    for (int index = 0; index < NativeShortVideoActionState.MAX_STORED_ACTIONS; index++) {
      NativeShortVideoActionState.RequestResult accepted = state.request(
        "pending-capacity-" + index, NativeShortVideoActionState.Type.LIKE, false, true
      );
      check(accepted.accepted, "every intent through the bounded capacity must be retained");
    }
    NativeShortVideoActionState.RequestResult rejected = state.request(
      "pending-capacity-overflow", NativeShortVideoActionState.Type.LIKE, false, true
    );
    check(
      !rejected.accepted && rejected.mutation == null
        && !state.active("pending-capacity-overflow", NativeShortVideoActionState.Type.LIKE, false)
        && !state.pending("pending-capacity-overflow", NativeShortVideoActionState.Type.LIKE),
      "an overflow intent must be explicitly rejected instead of pretending to be pending"
    );
  }

  private static void verifyLegacyReconcilesWithoutDowngradingServerTruth() {
    NativeShortVideoActionState state = new NativeShortVideoActionState(Arrays.asList(
      new NativeShortVideoActionState.Stored(
        "video-3",
        NativeShortVideoActionState.Type.LIKE,
        false,
        true,
        true
      )
    ));
    state.observeServer("video-3", NativeShortVideoActionState.Type.LIKE, true);
    check(
      state.drainAcknowledgedLegacy().size() == 1,
      "server-true legacy match must acknowledge and clear the migration without a PUT"
    );
    check(state.snapshot().isEmpty(), "acknowledged legacy state must not remain a second authority");

    state.importLegacy("video-4", NativeShortVideoActionState.Type.COLLECT);
    state.observeServer("video-4", NativeShortVideoActionState.Type.COLLECT, false);
    NativeShortVideoActionState.Mutation pending = state.resume(
      "video-4",
      NativeShortVideoActionState.Type.COLLECT
    );
    check(
      pending != null && pending.active,
      "server-false legacy match must become an explicit active=true sync request"
    );
    NativeShortVideoActionState.Completion success = state.completeSuccess(pending, true);
    check(success.accepted, "the active legacy generation must accept its server response");
    check(
      state.drainAcknowledgedLegacy().size() == 1 && state.snapshot().isEmpty(),
      "successful migration must clear its pending record"
    );
  }

  private static void verifyCanonicalSnapshotsReachEveryInstance() {
    NativeShortVideoActionSnapshots canonical = new NativeShortVideoActionSnapshots();
    NativeShortVideoActionSnapshots.Snapshot accepted = canonical.accept(
      "canonical-video",
      snapshot(true, true, true, false, true, 101, true, 17)
    );
    check(accepted != null, "a valid accepted server response must become canonical");

    FakeTarget currentFeed = new FakeTarget("canonical-video");
    FakeTarget navigationStack = new FakeTarget("canonical-video");
    canonical.applyAll(Arrays.asList(currentFeed, navigationStack));
    assertTarget(currentFeed, true, false, 101, 17, "current feed instance");
    assertTarget(navigationStack, true, false, 101, 17, "navigation stack instance");

    FakeTarget restoredAuthorScreen = new FakeTarget("canonical-video");
    canonical.apply(restoredAuthorScreen);
    assertTarget(restoredAuthorScreen, true, false, 101, 17, "future restored screen instance");

    FakeTarget unrelated = new FakeTarget("different-video");
    canonical.apply(unrelated);
    check(unrelated.applyCount == 0, "a canonical snapshot must not leak to another video id");
  }

  private static void verifyCanonicalSnapshotsMergeMissingFields() {
    NativeShortVideoActionSnapshots canonical = new NativeShortVideoActionSnapshots();
    canonical.accept(
      "partial-video",
      snapshot(true, true, false, false, true, 88, false, 0)
    );
    NativeShortVideoActionSnapshots.Snapshot merged = canonical.accept(
      "partial-video",
      snapshot(false, false, true, true, false, 0, true, 12)
    );
    check(merged != null, "a partial accepted update must merge with its previous canonical state");
    check(
      merged.hasLiked && merged.liked && merged.hasLikes && merged.likes == 88,
      "missing liked/count fields must preserve the last accepted values"
    );
    check(
      merged.hasCollected && merged.collected && merged.hasCollects && merged.collects == 12,
      "present collected/count fields must replace the previous values"
    );

    FakeTarget target = new FakeTarget("partial-video");
    canonical.apply(target);
    assertTarget(target, true, true, 88, 12, "merged partial snapshot");

    NativeShortVideoActionSnapshots.Snapshot explicitFalse = canonical.accept(
      "partial-video",
      snapshot(true, false, false, false, false, 0, false, 0)
    );
    check(
      explicitFalse != null && explicitFalse.hasLiked && !explicitFalse.liked,
      "an explicit false action must not be mistaken for a missing field"
    );
    FakeTarget future = new FakeTarget("partial-video");
    canonical.apply(future);
    assertTarget(future, false, true, 88, 12, "future instance after explicit false");
  }

  private static void verifyCanonicalSnapshotsAreBounded() {
    NativeShortVideoActionSnapshots canonical = new NativeShortVideoActionSnapshots();
    for (int index = 0; index < 512; index++) {
      canonical.accept("bounded-" + index, snapshot(true, true, true, false, true, index, true, index));
    }
    FakeTarget recentlyUsed = new FakeTarget("bounded-0");
    canonical.apply(recentlyUsed);
    canonical.accept("bounded-512", snapshot(true, false, true, true, true, 512, true, 512));
    FakeTarget evicted = new FakeTarget("bounded-1");
    canonical.apply(evicted);
    check(evicted.applyCount == 0, "the least-recent canonical snapshot must be evicted at the fixed bound");
    FakeTarget retained = new FakeTarget("bounded-0");
    canonical.apply(retained);
    assertTarget(retained, true, false, 0, 0, "recent bounded snapshot");
  }

  private static void verifyFeedRevisionOrdering() {
    NativeShortVideoActionSnapshots canonical = new NativeShortVideoActionSnapshots();
    long oldRequestRevision = canonical.revision();
    canonical.acceptAction("revision-video", snapshot(true, true, true, false, true, 101, true, 9));
    FakeTarget oldResponse = target("revision-video", false, false, 100, 9);
    canonical.acceptFeed(Arrays.asList(oldResponse), oldRequestRevision);
    assertTarget(oldResponse, true, false, 101, 9, "feed response older than accepted action");
    FakeTarget afterOldResponse = new FakeTarget("revision-video");
    canonical.apply(afterOldResponse);
    assertTarget(afterOldResponse, true, false, 101, 9, "canonical state after old feed response");

    long freshRequestRevision = canonical.revision();
    FakeTarget freshResponse = target("revision-video", false, true, 100, 10);
    canonical.acceptFeed(Arrays.asList(freshResponse), freshRequestRevision);
    FakeTarget afterFreshResponse = new FakeTarget("revision-video");
    canonical.apply(afterFreshResponse);
    assertTarget(afterFreshResponse, false, true, 100, 10, "feed response started after accepted action");
  }

  private static void verifyRejectedStaleResponseCannotOverwriteRestoredScreen() {
    NativeShortVideoActionState state = new NativeShortVideoActionState(null);
    NativeShortVideoActionSnapshots canonical = new NativeShortVideoActionSnapshots();
    NativeShortVideoActionState.Mutation enabling = state.request(
      "old-screen-video",
      NativeShortVideoActionState.Type.LIKE,
      false,
      true
    ).mutation;
    state.request("old-screen-video", NativeShortVideoActionState.Type.LIKE, false, false);

    NativeShortVideoActionState.Completion enabled = state.completeSuccess(enabling, true);
    if (enabled.accepted) {
      canonical.accept("old-screen-video", snapshot(true, true, false, false, true, 101, false, 0));
    }
    check(enabled.next != null && !enabled.next.active, "fixture must dispatch the queued unlike intent");
    NativeShortVideoActionState.Completion disabled = state.completeSuccess(enabled.next, false);
    if (disabled.accepted) {
      canonical.accept("old-screen-video", snapshot(true, false, false, false, true, 100, false, 0));
    }
    check(disabled.accepted, "the latest unlike response must be accepted");

    NativeShortVideoActionState.Completion stale = state.completeSuccess(enabling, true);
    if (stale.accepted) {
      canonical.accept("old-screen-video", snapshot(true, true, false, false, true, 101, false, 0));
    }
    check(!stale.accepted, "the late enabling response must be rejected before canonical model writes");

    FakeTarget restoredOldScreen = new FakeTarget("old-screen-video");
    restoredOldScreen.liked = true;
    restoredOldScreen.likes = 101;
    canonical.apply(restoredOldScreen);
    check(
      restoredOldScreen.applyCount == 1 && !restoredOldScreen.liked && restoredOldScreen.likes == 100,
      "returning to an old screen instance must restore the latest canonical false state and count"
    );
  }

  private static NativeShortVideoActionSnapshots.Snapshot snapshot(
      boolean hasLiked,
      boolean liked,
      boolean hasCollected,
      boolean collected,
      boolean hasLikes,
      long likes,
      boolean hasCollects,
      long collects) {
    return new NativeShortVideoActionSnapshots.Snapshot(
      hasLiked,
      liked,
      hasCollected,
      collected,
      hasLikes,
      likes,
      hasCollects,
      collects
    );
  }

  private static void assertTarget(
      FakeTarget target,
      boolean liked,
      boolean collected,
      long likes,
      long collects,
      String label) {
    check(target.applyCount == 1, label + " must receive exactly one canonical apply");
    check(target.liked == liked, label + " must receive canonical liked state");
    check(target.collected == collected, label + " must receive canonical collected state");
    check(target.likes == likes, label + " must receive canonical like count");
    check(target.collects == collects, label + " must receive canonical collect count");
  }

  private static final class FakeTarget implements NativeShortVideoActionSnapshots.Target {
    private final String videoId;
    boolean liked;
    boolean collected;
    long likes = -1;
    long collects = -1;
    int applyCount;

    FakeTarget(String videoId) {
      this.videoId = videoId;
    }

    @Override
    public String actionVideoId() {
      return videoId;
    }

    @Override
    public NativeShortVideoActionSnapshots.Snapshot currentActionSnapshot() {
      return snapshot(true, liked, true, collected, true, likes, true, collects);
    }

    @Override
    public void applyActionSnapshot(NativeShortVideoActionSnapshots.Snapshot snapshot) {
      applyCount++;
      if (snapshot.hasLiked) liked = snapshot.liked;
      if (snapshot.hasCollected) collected = snapshot.collected;
      if (snapshot.hasLikes) likes = snapshot.likes;
      if (snapshot.hasCollects) collects = snapshot.collects;
    }
  }

  private static FakeTarget target(String id, boolean liked, boolean collected, long likes, long collects) {
    FakeTarget target = new FakeTarget(id);
    target.liked = liked;
    target.collected = collected;
    target.likes = likes;
    target.collects = collects;
    return target;
  }

  private static void check(boolean condition, String message) {
    if (!condition) throw new AssertionError(message);
  }
}
