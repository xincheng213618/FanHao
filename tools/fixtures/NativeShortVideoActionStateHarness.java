package local.fanhao.library;

import java.util.Arrays;

public final class NativeShortVideoActionStateHarness {
  public static void main(String[] args) {
    verifyServerScopeIsolation();
    verifyLatestIntentWinsOverOldCompletion();
    verifyFailureRollsBackOnlyCurrentIntent();
    verifyLegacyReconcilesWithoutDowngradingServerTruth();
    System.out.println("native-short-video-action-state: ok (scope, single-flight, generation, rollback, legacy reconciliation)");
  }

  private static void verifyServerScopeIsolation() {
    check("http://example.test".equals(NativeShortVideoActionState.serverScope("http://EXAMPLE.test:80/api/short-videos")), "default HTTP port must normalize");
    check("https://example.test:9443".equals(NativeShortVideoActionState.serverScope("https://Example.Test:9443/path?q=1")), "non-default port must scope actions");
    check(NativeShortVideoActionState.serverScope("not a URL").isEmpty(), "invalid server address must never gain a shared action scope");
  }

  private static void verifyLatestIntentWinsOverOldCompletion() {
    NativeShortVideoActionState state = new NativeShortVideoActionState(null);
    NativeShortVideoActionState.Mutation first = state.request("video-1", NativeShortVideoActionState.Type.LIKE, false, true);
    check(first != null && first.active, "first like must start exactly one request");
    NativeShortVideoActionState.Mutation duplicate = state.request("video-1", NativeShortVideoActionState.Type.LIKE, false, false);
    check(duplicate == null && !state.active("video-1", NativeShortVideoActionState.Type.LIKE, false), "new intent must be immediate while old request stays single-flight");
    NativeShortVideoActionState.Completion oldSuccess = state.completeSuccess(first, true);
    check(oldSuccess.next != null && !oldSuccess.next.active, "old success must schedule the newer unlike intent instead of overwriting it");
    state.completeSuccess(oldSuccess.next, false);
    check(!state.active("video-1", NativeShortVideoActionState.Type.LIKE, false) && !state.pending("video-1", NativeShortVideoActionState.Type.LIKE), "latest server confirmation must converge after the queued request");
  }

  private static void verifyFailureRollsBackOnlyCurrentIntent() {
    NativeShortVideoActionState state = new NativeShortVideoActionState(null);
    NativeShortVideoActionState.Mutation first = state.request("video-2", NativeShortVideoActionState.Type.COLLECT, false, true);
    state.request("video-2", NativeShortVideoActionState.Type.COLLECT, false, false);
    NativeShortVideoActionState.Completion oldFailure = state.completeFailure(first);
    check(!oldFailure.rolledBack && oldFailure.next == null && !state.active("video-2", NativeShortVideoActionState.Type.COLLECT, false), "an old failure must preserve the newer intent when it already matches the confirmed server value");
    NativeShortVideoActionState.Mutation current = state.request("video-2", NativeShortVideoActionState.Type.COLLECT, false, true);
    NativeShortVideoActionState.Completion currentFailure = state.completeFailure(current);
    check(currentFailure.rolledBack && !state.active("video-2", NativeShortVideoActionState.Type.COLLECT, false), "the current failure must restore the last confirmed server value");
  }

  private static void verifyLegacyReconcilesWithoutDowngradingServerTruth() {
    NativeShortVideoActionState state = new NativeShortVideoActionState(Arrays.asList(
      new NativeShortVideoActionState.Stored("video-3", NativeShortVideoActionState.Type.LIKE, false, true, true)
    ));
    state.observeServer("video-3", NativeShortVideoActionState.Type.LIKE, true);
    check(state.drainAcknowledgedLegacy().size() == 1, "server-true legacy match must acknowledge and clear the migration without a PUT");
    check(state.snapshot().isEmpty(), "acknowledged legacy state must not remain a second authority");

    state.importLegacy("video-4", NativeShortVideoActionState.Type.COLLECT);
    state.observeServer("video-4", NativeShortVideoActionState.Type.COLLECT, false);
    NativeShortVideoActionState.Mutation pending = state.resume("video-4", NativeShortVideoActionState.Type.COLLECT);
    check(pending != null && pending.active, "server-false legacy match must become an explicit active=true sync request");
    state.completeSuccess(pending, true);
    check(state.drainAcknowledgedLegacy().size() == 1 && state.snapshot().isEmpty(), "successful migration must clear its pending record");
  }

  private static void check(boolean condition, String message) {
    if (!condition) throw new AssertionError(message);
  }
}
