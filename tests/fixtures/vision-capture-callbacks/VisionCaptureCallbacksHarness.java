package local.fanhao.library;

import java.io.*;
import java.nio.file.*;
import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.*;
import java.util.function.*;

@interface NonNull {}
class Faults {
  static void raise(Throwable error) {
    if (error instanceof RuntimeException) throw (RuntimeException) error;
    if (error instanceof Error) throw (Error) error;
  }
  static Throwable failure(boolean oom) {
    return oom ? new OutOfMemoryError("synthetic boundary allocation") : new IllegalStateException("synthetic boundary failure");
  }
}
class ContextCompat {
  static Executor getMainExecutor(Object host) { return Runnable::run; }
}
class ImageCaptureException extends Exception {
  ImageCaptureException(String message) { super(message); }
}
class ImageCapture {
  static Throwable builderFailure, optionsFailure;
  static class OutputFileOptions {
    final File file;
    OutputFileOptions(File file) { this.file = file; }
    static class Builder {
      final File file;
      Builder(File file) { Faults.raise(builderFailure); this.file = file; }
      OutputFileOptions build() { Faults.raise(optionsFailure); return new OutputFileOptions(file); }
    }
  }
  static class OutputFileResults {}
  abstract static class OnImageSavedCallback {
    public abstract void onImageSaved(OutputFileResults result);
    public abstract void onError(ImageCaptureException error);
  }
  static class Request {
    final File output;
    final OnImageSavedCallback callback;
    Request(File output, OnImageSavedCallback callback) { this.output = output; this.callback = callback; }
    void success() { callback.onImageSaved(new OutputFileResults()); }
    void error() { callback.onError(new ImageCaptureException("synthetic camera error")); }
  }
  final ArrayList<Request> requests = new ArrayList<>();
  Throwable launchFailure;
  boolean retainBeforeFailure, materializeImmediate;
  String immediate = "";
  int launches;
  void takePicture(OutputFileOptions options, Executor executor, OnImageSavedCallback callback) {
    launches++;
    if (!retainBeforeFailure) Faults.raise(launchFailure);
    Request request = new Request(options.file, callback);
    requests.add(request);
    if (materializeImmediate) {
      try { VisionCaptureCallbacksHarness.write(options.file); }
      catch (IOException error) { throw new UncheckedIOException(error); }
    }
    if (immediate.equals("success")) request.success();
    if (immediate.equals("error")) request.error();
    Faults.raise(launchFailure);
  }
  Request last() { return requests.get(requests.size() - 1); }
}

// Platform/UI/Store boundaries are deterministic doubles. The complete real
// VisionCaptureLifecycle supplies tokens, capture filenames, promotion and cleanup.
// No fake below impersonates takePicture, captureVerifiedFace or retry logic.
abstract class CaptureHostBase {
  enum Step { FACE, ID_FRONT }
  final VisionCaptureLifecycle captureLifecycle = new VisionCaptureLifecycle();
  final ArrayDeque<Runnable> queuedUi = new ArrayDeque<>();
  ImageCapture imageCapture = new ImageCapture();
  File sessionDirectory;
  Step step = Step.FACE;
  boolean terminalResult, finishing, destroyed, faceCaptureStarted;
  int facePhase = 2, stableFrames = 7;
  Integer activeFaceTrackingId = 11;
  int uiUpdates, completed, fatalCalls;
  String lastMessage, fatalMessage;
  float lastProgress;
  boolean lastSuccess;
  Throwable uiFailure, postFailure, finishFailure;
  boolean queueUi, retainUiBeforeFailure;
  boolean isFinishing() { return finishing; }
  boolean isDestroyed() { return destroyed; }
  void runOnUiThread(Runnable action) {
    Throwable failure = postFailure; postFailure = null;
    if (!retainUiBeforeFailure) Faults.raise(failure);
    if (queueUi) queuedUi.add(action); else action.run();
    Faults.raise(failure);
  }
  void drainUi() { while (!queuedUi.isEmpty()) queuedUi.remove().run(); }
  void updateFaceUi(float progress, String message, boolean success) {
    Throwable failure = uiFailure; uiFailure = null; Faults.raise(failure);
    uiUpdates++; lastProgress = progress; lastMessage = message; lastSuccess = success;
  }
  void finishFaceSession(File file) {
    Faults.raise(finishFailure);
    if (!file.isFile() || file.length() == 0L) throw new AssertionError("finish requires promoted synthetic photo");
    completed++; captureLifecycle.markCompleted();
  }
  void showFatal(String message) {
    fatalCalls++; fatalMessage = message; captureLifecycle.suspend(VisionCaptureLifecycle.FATAL_ERROR);
  }
  abstract void takePicture(File output, Runnable success, Consumer<String> failure);
  abstract void captureVerifiedFace();
  void retryFaceCapture(File output, long token, String message) { throw new UnsupportedOperationException("legacy has no centralized retry"); }
  /* SHARED_PRODUCTION_METHODS */
}

/* PRODUCTION_HOST */

public final class VisionCaptureCallbacksHarness {
  static File fixtureRoot;
  static int checks, sequences;
  static boolean legacy;
  static void check(boolean value, String message) {
    if (!value) throw new AssertionError("callback safety: " + message);
    checks++;
  }
  static CaptureHostBase host(String name) throws IOException {
    ImageCapture.builderFailure = null; ImageCapture.optionsFailure = null;
    CaptureHostBase host = legacy ? new LegacyVisionCaptureHost() : new ProductionVisionCaptureHost();
    host.sessionDirectory = new File(fixtureRoot, name);
    Files.createDirectory(host.sessionDirectory.toPath());
    sequences++;
    return host;
  }
  static void write(File file) throws IOException {
    Path resolved = file.getCanonicalFile().toPath();
    if (!resolved.startsWith(fixtureRoot.getCanonicalFile().toPath())) throw new AssertionError("synthetic file escaped fixture");
    Files.write(file.toPath(), new byte[] { 11, 22, 33, 44 });
  }
  static File output(CaptureHostBase host) throws IOException {
    File file = VisionCaptureLifecycle.temporaryCapture(host.sessionDirectory); write(file); return file;
  }
  static Throwable observe(Runnable action) {
    try { action.run(); return null; } catch (RuntimeException | OutOfMemoryError error) { return error; }
  }
  static void retired(CaptureHostBase host, String state) {
    switch (state) {
      case "background": host.captureLifecycle.suspend(VisionCaptureLifecycle.BACKGROUND); break;
      case "generation": host.captureLifecycle.nextStep(); break;
      case "destroyed": host.captureLifecycle.destroy(); host.destroyed = true; break;
      case "completed": host.captureLifecycle.markCompleted(); break;
      case "other-step": host.step = CaptureHostBase.Step.ID_FRONT; break;
      default: throw new AssertionError(state);
    }
  }
  static void assertRetry(CaptureHostBase host, String reason) {
    check(!host.faceCaptureStarted && host.facePhase == 0 && host.stableFrames == 0
      && host.activeFaceTrackingId == null && host.fatalCalls == 0 && host.completed == 0,
      reason + " resets the full action and releases only unsubmitted/failed capture");
  }

  static void duplicateSuccess() throws Exception {
    CaptureHostBase host = host("duplicate-success"); File file = output(host);
    AtomicInteger success = new AtomicInteger(), failure = new AtomicInteger();
    host.takePicture(file, success::incrementAndGet, ignored -> failure.incrementAndGet());
    ImageCapture.Request request = host.imageCapture.last();
    request.success(); request.success(); request.error();
    check(success.get() == 1 && failure.get() == 0 && file.exists(), "duplicate success/error cannot repeat or delete the success-owned OCR input");
    host.captureLifecycle.suspend(VisionCaptureLifecycle.BACKGROUND);
    request.success(); request.error();
    check(success.get() == 1 && failure.get() == 0 && file.exists(), "retired duplicate callbacks cannot delete an earlier success-owned input");
  }
  static void duplicateFailure() throws Exception {
    CaptureHostBase host = host("duplicate-failure"); File file = output(host);
    AtomicInteger success = new AtomicInteger(), failure = new AtomicInteger();
    host.takePicture(file, success::incrementAndGet, ignored -> failure.incrementAndGet());
    ImageCapture.Request request = host.imageCapture.last(); request.error(); request.error();
    check(success.get() == 0 && failure.get() == 1 && !file.exists(), "duplicate error is delivered once and releases its temporary output");
    write(file); request.success();
    check(success.get() == 0 && failure.get() == 1 && !file.exists(), "late success after error cleans its rewritten output without reviving the failed operation");
  }
  static void launchFailure(boolean oom, boolean retained) throws Exception {
    CaptureHostBase host = host("launch-" + oom + "-" + retained); File file = output(host);
    AtomicInteger success = new AtomicInteger(), failure = new AtomicInteger();
    host.imageCapture.launchFailure = Faults.failure(oom); host.imageCapture.retainBeforeFailure = retained;
    Throwable escaped = observe(() -> host.takePicture(file, success::incrementAndGet, ignored -> failure.incrementAndGet()));
    check(escaped == null && success.get() == 0 && failure.get() == 1 && !file.exists(), "launch exception/OOM reports one failure and removes its output");
    check(host.imageCapture.requests.size() == (retained ? 1 : 0), "launch fault really occurs on the selected side of callback retention");
    if (retained) {
      ImageCapture.Request abandoned = host.imageCapture.last();
      host.imageCapture.launchFailure = null;
      File fresh = output(host);
      host.takePicture(fresh, success::incrementAndGet, ignored -> failure.incrementAndGet());
      write(file); abandoned.success(); abandoned.error();
      check(success.get() == 0 && failure.get() == 1 && !file.exists() && fresh.exists(), "retained callbacks cannot revive failed launch or remove a newer request's output");
      host.imageCapture.last().success();
      check(success.get() == 1 && failure.get() == 1 && fresh.exists(), "fresh capture still completes after failed retained launch");
    }
  }
  static void optionsFailure(boolean oom, boolean constructor) throws Exception {
    CaptureHostBase host = host("options-" + oom + "-" + constructor); File file = output(host);
    AtomicInteger failure = new AtomicInteger();
    if (constructor) ImageCapture.builderFailure = Faults.failure(oom); else ImageCapture.optionsFailure = Faults.failure(oom);
    Throwable escaped = observe(() -> host.takePicture(file, () -> { throw new AssertionError("options failure succeeded"); }, ignored -> failure.incrementAndGet()));
    check(escaped == null && failure.get() == 1 && !file.exists() && host.imageCapture.launches == 0,
      "options constructor/build exception/OOM is handled before CameraX submission");
  }
  static void terminalDuringLaunch(boolean oom, String first) throws Exception {
    CaptureHostBase host = host("inline-" + oom + "-" + first); File file = output(host);
    AtomicInteger success = new AtomicInteger(), failure = new AtomicInteger();
    host.imageCapture.retainBeforeFailure = true; host.imageCapture.launchFailure = Faults.failure(oom); host.imageCapture.immediate = first;
    Throwable escaped = observe(() -> host.takePicture(file, success::incrementAndGet, ignored -> failure.incrementAndGet()));
    boolean succeeded = first.equals("success");
    check(escaped == null && success.get() == (succeeded ? 1 : 0) && failure.get() == (succeeded ? 0 : 1)
      && file.exists() == succeeded, "throw after synchronous terminal callback cannot reverse its ownership outcome");
    host.imageCapture.last().success(); host.imageCapture.last().error();
    check(success.get() == (succeeded ? 1 : 0) && failure.get() == (succeeded ? 0 : 1)
      && file.exists() == succeeded, "duplicates after synchronous callback plus launch throw remain inert");
  }
  static void handlerThrows(boolean oom, boolean synchronous, boolean successFirst) throws Exception {
    CaptureHostBase host = host("handler-" + oom + "-" + synchronous + "-" + successFirst); File file = output(host);
    AtomicInteger success = new AtomicInteger(), failure = new AtomicInteger(); Throwable injected = Faults.failure(oom);
    Runnable accepted = () -> { success.incrementAndGet(); if (successFirst) Faults.raise(injected); };
    Consumer<String> rejected = ignored -> { failure.incrementAndGet(); if (!successFirst) Faults.raise(injected); };
    host.imageCapture.immediate = synchronous ? successFirst ? "success" : "error" : "";
    observe(() -> host.takePicture(file, accepted, rejected));
    ImageCapture.Request request = host.imageCapture.last();
    if (!synchronous) observe(() -> { if (successFirst) request.success(); else request.error(); });
    observe(request::success); observe(request::error);
    check(success.get() == (successFirst ? 1 : 0) && failure.get() == (successFirst ? 0 : 1)
      && file.exists() == successFirst, "handler exception/OOM cannot redeliver, reverse outcome or delete success-owned OCR input");
  }
  static void lateOutcome(String state, boolean success) throws Exception {
    CaptureHostBase host = host("late-" + state + "-" + success); File file = output(host);
    AtomicInteger business = new AtomicInteger();
    host.takePicture(file, business::incrementAndGet, ignored -> business.incrementAndGet());
    retired(host, state);
    ImageCapture.Request request = host.imageCapture.last();
    if (success) request.success(); else request.error();
    check(business.get() == 0 && !file.exists(), "retired first callback only cleans its output without success or failure business");
  }
  static void invalidEntry(String state) throws Exception {
    CaptureHostBase host = host("invalid-" + state); File file = output(host); retired(host, state);
    AtomicInteger business = new AtomicInteger();
    host.takePicture(file, business::incrementAndGet, ignored -> business.incrementAndGet());
    check(!file.exists() && business.get() == 0 && host.imageCapture.launches == 0, "invalid entry discards only its supplied temporary output without launching");
  }

  static void faceUiFailure(boolean oom) throws Exception {
    CaptureHostBase host = host("face-ui-" + oom); host.uiFailure = Faults.failure(oom);
    Throwable escaped = observe(host::captureVerifiedFace);
    check(escaped == null && host.imageCapture.launches == 0, "face UI exception/OOM cannot escape or submit a camera request");
    assertRetry(host, "face UI setup failure");
  }
  static void faceScheduling(boolean oom, boolean retained, boolean inline) throws Exception {
    CaptureHostBase host = host("face-schedule-" + oom + "-" + retained + "-" + inline);
    host.postFailure = Faults.failure(oom); host.retainUiBeforeFailure = retained; host.queueUi = !inline;
    Throwable escaped = observe(host::captureVerifiedFace);
    check(escaped == null, "face scheduling exception/OOM is contained");
    if (retained && inline) {
      check(host.faceCaptureStarted && host.imageCapture.requests.size() == 1 && host.facePhase == 2,
        "post throw after UI entered cannot cancel an already submitted face capture");
      ImageCapture.Request request = host.imageCapture.last(); write(request.output); request.success();
      check(host.completed == 1 && host.fatalCalls == 0, "accepted face capture completes after scheduling return throws");
    } else {
      assertRetry(host, "face scheduling failure");
      host.drainUi();
      check(host.imageCapture.launches == 0 && !host.faceCaptureStarted, "retained abandoned UI action cannot start a camera after scheduling failure");
    }
  }
  static void faceSetupFailure(boolean oom, String stage) throws Exception {
    CaptureHostBase host = host("face-setup-" + oom + "-" + stage);
    if (stage.equals("options")) ImageCapture.optionsFailure = Faults.failure(oom);
    else { host.imageCapture.launchFailure = Faults.failure(oom); host.imageCapture.retainBeforeFailure = stage.equals("retained"); }
    Throwable escaped = observe(host::captureVerifiedFace);
    check(escaped == null, "face options/launch exception/OOM is contained");
    assertRetry(host, "face camera setup failure");
    if (stage.equals("retained")) {
      ImageCapture.Request abandoned = host.imageCapture.last(); host.imageCapture.launchFailure = null;
      host.captureVerifiedFace(); ImageCapture.Request fresh = host.imageCapture.last();
      check(host.faceCaptureStarted && fresh != abandoned, "fresh face request starts after failed retained request");
      write(abandoned.output); abandoned.success(); abandoned.error();
      check(host.faceCaptureStarted && !abandoned.output.exists() && host.completed == 0 && host.fatalCalls == 0,
        "late failed face callbacks cannot clear the fresh capture gate or promote a discarded photo");
      write(fresh.output); fresh.success(); check(host.completed == 1, "fresh face request still completes after late abandoned callbacks");
    }
  }
  static void faceMissingSession(boolean missingCamera) throws Exception {
    CaptureHostBase host = host("face-missing-" + missingCamera);
    if (missingCamera) host.imageCapture = null; else host.sessionDirectory = null;
    check(observe(host::captureVerifiedFace) == null, "missing camera/session is a contained setup error");
    assertRetry(host, "missing camera/session");
  }
  static void faceSuccess() throws Exception {
    CaptureHostBase host = host("face-success"); host.captureVerifiedFace();
    check(host.faceCaptureStarted && host.imageCapture.requests.size() == 1 && host.lastProgress < 1f && !host.lastSuccess,
      "pending face capture is gated without claiming a saved/complete photo");
    ImageCapture.Request request = host.imageCapture.last(); write(request.output); request.success();
    File accepted = new File(host.sessionDirectory, "face-verification.jpg");
    check(host.completed == 1 && accepted.length() == 4 && !request.output.exists() && host.fatalCalls == 0,
      "one successful face callback promotes actual synthetic bytes and completes once");
    request.success(); request.error();
    check(host.completed == 1 && accepted.length() == 4 && host.fatalCalls == 0,
      "post-completion duplicate face callbacks cannot retry, delete or report false failure");
  }
  static void faceError() throws Exception {
    CaptureHostBase host = host("face-error"); host.captureVerifiedFace();
    ImageCapture.Request failed = host.imageCapture.last(); write(failed.output); failed.error();
    assertRetry(host, "face camera callback failure");
    check(!failed.output.exists(), "failed face camera callback discards own output");
  }
  static void faceTerminalDuringLaunch(boolean oom, String first) throws Exception {
    CaptureHostBase host = host("face-inline-terminal-" + oom + "-" + first);
    host.imageCapture.immediate = first; host.imageCapture.materializeImmediate = true;
    host.imageCapture.retainBeforeFailure = true; host.imageCapture.launchFailure = Faults.failure(oom);
    check(observe(host::captureVerifiedFace) == null, "face synchronous outcome followed by launch exception/OOM is contained");
    ImageCapture.Request request = host.imageCapture.last();
    if (first.equals("success")) {
      check(host.completed == 1 && host.faceCaptureStarted && host.fatalCalls == 0
        && new File(host.sessionDirectory, "face-verification.jpg").length() == 4,
        "CameraX throw after inline face success cannot undo the saved checkpoint or retry");
    } else {
      assertRetry(host, "inline face camera failure");
      check(host.uiUpdates == 2 && !request.output.exists(), "CameraX throw after inline retry cannot invoke the failure consumer twice");
    }
    int updates = host.uiUpdates, completed = host.completed;
    request.success(); request.error();
    check(host.uiUpdates == updates && host.completed == completed && host.fatalCalls == 0,
      "duplicates after inline face outcome and launch throw cannot update or complete again");
  }
  static void faceCommitFailure(boolean oom) throws Exception {
    CaptureHostBase host = host("face-commit-" + oom); host.captureVerifiedFace();
    ImageCapture.Request request = host.imageCapture.last(); write(request.output);
    if (oom) host.finishFailure = new OutOfMemoryError("synthetic archive allocation");
    else write(new File(host.sessionDirectory, "face-verification.jpg"));
    check(observe(request::success) == null, "face promotion/commit failure is contained in its success owner");
    check(host.fatalCalls == 1 && host.completed == 0 && host.faceCaptureStarted && !request.output.exists(),
      "face promotion/commit failure becomes fatal and never silently starts another photo");
    File accepted = new File(host.sessionDirectory, "face-verification.jpg");
    check(accepted.length() == 4, "existing/promoted checkpoint is preserved after commit failure");
    request.error(); request.success();
    check(host.fatalCalls == 1 && host.faceCaptureStarted && accepted.length() == 4, "failed commit duplicates never change success-owned terminal handling");
  }
  static void faceRetired(String state, boolean success) throws Exception {
    CaptureHostBase host = host("face-retired-" + state + "-" + success); host.captureVerifiedFace();
    ImageCapture.Request old = host.imageCapture.last(); write(old.output); retired(host, state);
    host.faceCaptureStarted = true; host.facePhase = 1; host.stableFrames = 3; host.activeFaceTrackingId = 22;
    int updates = host.uiUpdates;
    if (success) old.success(); else old.error();
    check(!old.output.exists() && host.faceCaptureStarted && host.facePhase == 1 && host.stableFrames == 3
      && host.activeFaceTrackingId == 22 && host.uiUpdates == updates && host.completed == 0 && host.fatalCalls == 0,
      "retired face callback cleans old photo without altering the new action or gate");
  }
  static void directRetry(String state) throws Exception {
    CaptureHostBase host = host("direct-retry-" + state); File file = output(host); long token = host.captureLifecycle.generation();
    host.faceCaptureStarted = true; if (!state.equals("current")) retired(host, state);
    int updates = host.uiUpdates; host.retryFaceCapture(file, token, "retry");
    check(!file.exists(), "retry always discards only the supplied own temporary output");
    if (state.equals("current")) assertRetry(host, "current retry");
    else check(host.faceCaptureStarted && host.facePhase == 2 && host.stableFrames == 7 && host.activeFaceTrackingId == 11
      && host.uiUpdates == updates, "stale/non-face retry cannot reset a newer active capture");
  }
  static void queuedFaceRetired() throws Exception {
    CaptureHostBase host = host("queued-face-retired"); host.queueUi = true; host.captureVerifiedFace();
    host.captureLifecycle.suspend(VisionCaptureLifecycle.BACKGROUND); host.drainUi();
    check(host.imageCapture.launches == 0 && host.uiUpdates == 0, "background before queued face UI prevents initialization and submission");
  }
  static void runAll() throws Exception {
    duplicateSuccess(); duplicateFailure(); faceSuccess(); faceError(); queuedFaceRetired();
    for (boolean oom : new boolean[] { false, true }) {
      for (boolean retained : new boolean[] { false, true }) launchFailure(oom, retained);
      for (boolean constructor : new boolean[] { false, true }) optionsFailure(oom, constructor);
      for (String first : new String[] { "success", "error" }) {
        terminalDuringLaunch(oom, first); faceTerminalDuringLaunch(oom, first);
      }
      for (boolean synchronous : new boolean[] { false, true }) for (boolean first : new boolean[] { false, true }) handlerThrows(oom, synchronous, first);
      faceUiFailure(oom);
      for (boolean retained : new boolean[] { false, true }) for (boolean inline : new boolean[] { false, true }) faceScheduling(oom, retained, inline);
      for (String stage : new String[] { "options", "launch", "retained" }) faceSetupFailure(oom, stage);
      faceCommitFailure(oom);
    }
    for (String state : new String[] { "background", "generation", "destroyed", "completed" }) {
      for (boolean success : new boolean[] { false, true }) { lateOutcome(state, success); faceRetired(state, success); }
      if (!state.equals("generation")) invalidEntry(state);
    }
    for (boolean camera : new boolean[] { false, true }) faceMissingSession(camera);
    for (String state : new String[] { "current", "background", "generation", "destroyed", "completed", "other-step" }) directRetry(state);
  }
  public static void main(String[] args) throws Exception {
    fixtureRoot = new File(args[0]).getCanonicalFile();
    String scenario = args.length > 1 ? args[1] : "all"; legacy = args.length > 2 && args[2].equals("legacy");
    switch (scenario) {
      case "duplicate-success": duplicateSuccess(); break;
      case "duplicate-failure": duplicateFailure(); break;
      case "options": optionsFailure(false, false); break;
      case "launch-oom": launchFailure(true, false); break;
      case "retained-launch": launchFailure(false, true); break;
      case "success-then-throw": terminalDuringLaunch(false, "success"); break;
      case "success-handler": handlerThrows(false, true, true); break;
      case "face-ui": faceUiFailure(false); break;
      case "face-retry": faceError(); break;
      case "queued-post": faceScheduling(false, true, false); break;
      case "face-commit-oom": faceCommitFailure(true); break;
      case "invalid-entry": invalidEntry("background"); break;
      case "all": runAll(); break;
      default: throw new AssertionError("unknown scenario: " + scenario);
    }
    System.out.println("vision-capture-callbacks: " + checks + " checks in " + sequences + " synthetic sequences (" + scenario + ")");
  }
}
