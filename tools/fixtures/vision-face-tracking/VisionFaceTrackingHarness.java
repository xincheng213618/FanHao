package local.fanhao.library;

import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.*;
import java.util.function.*;

class Rect {
  final int left, top, right, bottom;
  Rect(int left, int top, int right, int bottom) { this.left = left; this.top = top; this.right = right; this.bottom = bottom; }
  int centerX() { return (left + right) >> 1; } int centerY() { return (top + bottom) >> 1; }
  int width() { return right - left; } int height() { return bottom - top; }
}
class Face {
  final Rect box; final Integer tracking; final float yaw, roll; final Float smile;
  Face(Rect box, Integer tracking, float yaw, float roll, Float smile) { this.box = box; this.tracking = tracking; this.yaw = yaw; this.roll = roll; this.smile = smile; }
  Rect getBoundingBox() { return box; } Integer getTrackingId() { return tracking; }
  float getHeadEulerAngleY() { return yaw; } float getHeadEulerAngleZ() { return roll; }
  Float getSmilingProbability() { return smile; }
}
class Image {}
class ImageProxy {
  int closes, width = 640, height = 480, rotation; boolean noImage;
  Image getImage() { return noImage ? null : new Image(); }
  int getWidth() { return width; } int getHeight() { return height; }
  ImageProxy getImageInfo() { return this; } int getRotationDegrees() { return rotation; }
  void close() { if (++closes > 1) throw new AssertionError("frame closed twice"); }
}
class InputImage { static InputImage fromMediaImage(Image image, int rotation) { return new InputImage(); } }
class ContextCompat {
  static Executor getMainExecutor(Object host) {
    FaceHostBase owner = (FaceHostBase) host;
    return action -> { if (owner.deferMain) owner.mainQueue.add(action); else action.run(); };
  }
}
class Task<T> {
  boolean done, canceled; T result; Exception error;
  final List<Runnable> listeners = new ArrayList<>();
  Task<T> addOnCompleteListener(Executor executor, Consumer<Task<T>> listener) {
    Runnable dispatch = () -> executor.execute(() -> listener.accept(this));
    if (done) dispatch.run(); else listeners.add(dispatch); return this;
  }
  boolean isSuccessful() { return done && error == null && !canceled; }
  boolean isComplete() { return done; }
  boolean isCanceled() { return canceled; }
  T getResult() { return result; }
  void finish(T value, Exception failure, boolean cancel) {
    done = true; result = value; error = failure; canceled = cancel;
    new ArrayList<>(listeners).forEach(Runnable::run); listeners.clear();
  }
}
class FaceDetector {
  Task<List<Face>> task = new Task<>(); boolean throwProcess, throwOom; int processes;
  Task<List<Face>> process(InputImage image) {
    processes++;
    if (throwProcess) throw new IllegalArgumentException("synthetic detector failure");
    if (throwOom) throw new OutOfMemoryError("synthetic detector allocation failure");
    return task;
  }
}
class FaceHostBase {
  enum Step { FACE, ID_FRONT }
  Step step = Step.FACE;
  boolean faceCaptureStarted, faceChallengeTurn;
  String faceChallenge = "微笑一下", lastMessage;
  int facePhase, stableFrames, captures, uiUpdates;
  float lastProgress;
  Integer activeFaceTrackingId;
  final AtomicBoolean faceBusy = new AtomicBoolean();
  final VisionCaptureLifecycle captureLifecycle = new VisionCaptureLifecycle();
  final FaceDetector faceDetector = new FaceDetector();
  boolean deferMain;
  final ArrayDeque<Runnable> mainQueue = new ArrayDeque<>();
  void drainMain() { while (!mainQueue.isEmpty()) mainQueue.remove().run(); }
  boolean canUseUi(long token) { return captureLifecycle.accepts(token); }
  void postCaptureUi(long token, Runnable action) { if (canUseUi(token)) action.run(); }
  void updateFaceUi(float progress, String message, boolean success) { uiUpdates++; lastProgress = progress; lastMessage = message; }
  void captureVerifiedFace() { captures++; faceCaptureStarted = true; }
}

/* PRODUCTION_HOST */

public class VisionFaceTrackingHarness {
  static final Rect CENTER = new Rect(200, 100, 440, 380);
  static final Face NEUTRAL = new Face(CENTER, 11, 0, 0, 0.2f);
  static final Face SMILE = new Face(CENTER, 11, 0, 0, 0.9f);
  static int checks;
  static void check(boolean value, String message) { if (!value) throw new AssertionError(message); checks++; }
  static void feed(LegacyVisionFaceHost host, Face face, int count) {
    for (int index = 0; index < count; index++) host.frameForTest(List.of(face), 640, 480);
  }
  static LegacyVisionFaceHost challengeComplete() {
    LegacyVisionFaceHost host = new LegacyVisionFaceHost(); feed(host, NEUTRAL, 7); feed(host, SMILE, 4); return host;
  }
  static void legacyScenario(String name, boolean safeAssertion) {
    LegacyVisionFaceHost host;
    if (name.equals("zero-height")) {
      host = new LegacyVisionFaceHost(); Rect flat = new Rect(200, 240, 440, 240);
      feed(host, new Face(flat, 11, 0, 0, 0.2f), 7); feed(host, new Face(flat, 11, 0, 0, 0.9f), 4); feed(host, new Face(flat, 11, 0, 0, 0.2f), 7);
    } else if (name.equals("offscreen-action") || name.equals("nonfinite-action") || name.equals("invalid-probability")) {
      host = new LegacyVisionFaceHost();
      if (name.equals("nonfinite-action")) { host.faceChallengeTurn = true; host.faceChallenge = "缓慢转头"; }
      feed(host, name.equals("invalid-probability") ? new Face(CENTER, 11, 0, 0, -1f) : NEUTRAL, 7);
      Face invalidAction = name.equals("offscreen-action") ? new Face(new Rect(800, 100, 1040, 380), 11, 0, 0, 0.9f)
        : name.equals("nonfinite-action") ? new Face(CENTER, 11, Float.POSITIVE_INFINITY, Float.NaN, 0.2f)
        : new Face(CENTER, 11, 0, 0, 2f);
      feed(host, invalidAction, 4); feed(host, NEUTRAL, 7);
    } else {
      host = challengeComplete();
      if (name.equals("missing-face")) host.frameForTest(List.of(), 640, 480);
      else if (name.equals("multiple-faces")) host.frameForTest(List.of(NEUTRAL, NEUTRAL), 640, 480);
      else if (name.equals("out-of-frame")) feed(host, new Face(new Rect(800, 100, 1040, 380), 11, 0, 0, 0.2f), 1);
      else {
        ImageProxy frame = new ImageProxy();
        if (name.equals("detector-sync-failure")) host.faceDetector.throwProcess = true;
        if (name.equals("missing-image")) frame.noImage = true;
        host.analyzeForTest(frame);
        if (!frame.noImage && !host.faceDetector.throwProcess) host.faceDetector.task.finish(null, name.equals("detector-failure") ? new Exception("failure") : null, name.equals("detector-cancel"));
        check(frame.closes == 1 && !host.faceBusy.get(), "detector interruption releases frame despite retaining legacy progress");
      }
      feed(host, NEUTRAL, 7);
    }
    check(host.captures == (safeAssertion ? 0 : 1), safeAssertion
      ? "old face sequence must not capture using interrupted or invalid progress"
      : "legacy interrupted or invalid face sequence reaches capture: " + name);
  }
  static void legacyEvidence() {
    LegacyVisionFaceHost normal = challengeComplete(); feed(normal, NEUTRAL, 6);
    check(normal.facePhase == 2 && normal.captures == 0, "baseline neutral7 action4 frontal6 is not yet complete");
    feed(normal, NEUTRAL, 1); check(normal.captures == 1, "baseline neutral7 action4 frontal7 reaches one capture");
    for (String scenario : new String[] { "missing-face", "multiple-faces", "out-of-frame", "offscreen-action", "zero-height", "nonfinite-action", "invalid-probability", "detector-failure", "detector-cancel", "detector-sync-failure", "missing-image" }) legacyScenario(scenario, false);
    LegacyVisionFaceHost changed = challengeComplete(); feed(changed, new Face(CENTER, 22, 0, 0, 0.2f), 7);
    check(changed.captures == 0 && changed.facePhase == 0, "baseline already rejects a different tracking identity");
    System.out.println("vision-face-legacy-evidence: " + checks + " synthetic old sequence observations reproduced");
  }

  static void feed(ProductionVisionFaceHost host, Face face, int count) {
    for (int index = 0; index < count; index++) host.processFaces(Collections.singletonList(face), 640, 480);
  }
  static ProductionVisionFaceHost phase(int phase, boolean turn) {
    ProductionVisionFaceHost host = new ProductionVisionFaceHost();
    host.faceChallengeTurn = turn; host.faceChallenge = turn ? "缓慢转头" : "微笑一下";
    if (phase > 0) feed(host, NEUTRAL, 7);
    if (phase > 1) feed(host, turn ? turn(25f, 0f) : SMILE, 4);
    return host;
  }
  static Face turn(float yaw, float roll) { return new Face(CENTER, 11, yaw, roll, null); }
  static Face smile(Float probability) { return new Face(CENTER, 11, 0f, 0f, probability); }
  static void state(ProductionVisionFaceHost host, int phase, int frames, Integer id, String message) {
    check(host.facePhase == phase && host.stableFrames == frames && Objects.equals(host.activeFaceTrackingId, id)
      && host.captures == 0 && !host.faceCaptureStarted, message + " [phase=" + host.facePhase + ", frames=" + host.stableFrames + ", id=" + host.activeFaceTrackingId + ", captures=" + host.captures + "]");
  }
  static void restartAndComplete(ProductionVisionFaceHost host, String label) {
    feed(host, NEUTRAL, 7);
    state(host, 1, 0, 11, label + " must repeat seven neutral frames");
    feed(host, host.faceChallengeTurn ? turn(-25f, 0f) : SMILE, 4);
    state(host, 2, 0, 11, label + " must repeat four action frames");
    feed(host, NEUTRAL, 6); state(host, 2, 6, 11, label + " must wait for final seventh frame");
    feed(host, NEUTRAL, 1); check(host.captures == 1, label + " full fresh sequence is recoverable");
    feed(host, NEUTRAL, 20); check(host.captures == 1, label + " capture requested only once");
  }
  static void exactSequenceAndContinuity() {
    for (boolean turn : new boolean[] { false, true }) {
      ProductionVisionFaceHost host = phase(0, turn);
      feed(host, NEUTRAL, 6); state(host, 0, 6, 11, "six neutral frames insufficient");
      feed(host, NEUTRAL, 1); state(host, 1, 0, 11, "neutral seventh changes phase");
      Face action = turn ? turn(-25f, 0f) : SMILE;
      feed(host, action, 3); state(host, 1, 3, 11, "three action frames insufficient");
      feed(host, action, 1); state(host, 2, 0, 11, "action fourth changes phase");
      feed(host, NEUTRAL, 6); state(host, 2, 6, 11, "six return frames insufficient");
      feed(host, NEUTRAL, 1); check(host.captures == 1 && host.faceCaptureStarted, "7/4/7 requests one capture");
      feed(host, action, 20); check(host.captures == 1, "further frames cannot request duplicate capture");
      check(Float.isFinite(host.lastProgress) && host.lastProgress >= 0f && host.lastProgress <= 1f, "progress remains a finite fraction");

      host = phase(0, turn); feed(host, NEUTRAL, 6); feed(host, new Face(CENTER, 11, 12f, 0f, .2f), 1);
      state(host, 0, 0, 11, "non-frontal neutral breaks consecutive stability");
      feed(host, NEUTRAL, 6); state(host, 0, 6, 11, "neutral run restarts without accumulating");
      feed(host, NEUTRAL, 1); feed(host, action, 3); feed(host, NEUTRAL, 1);
      state(host, 1, 0, 11, "valid non-action retains challenge but resets consecutive frames");
      feed(host, action, 3); state(host, 1, 3, 11, "action run cannot accumulate across neutral frame");
      feed(host, action, 1); feed(host, NEUTRAL, 6); feed(host, turn(20f, 0f), 1);
      state(host, 2, 0, 11, "valid centered turned face waits in return phase");
      feed(host, NEUTRAL, 6); state(host, 2, 6, 11, "return run cannot accumulate across turned frame");
      feed(host, NEUTRAL, 1); check(host.captures == 1, "valid consecutive retries can finish");
    }
    ProductionVisionFaceHost wrongStep = phase(2, false); wrongStep.step = FaceHostBase.Step.ID_FRONT;
    int before = wrongStep.uiUpdates; feed(wrongStep, NEUTRAL, 20);
    check(wrongStep.captures == 0 && wrongStep.uiUpdates == before, "non-face step ignores face input");
  }
  record InvalidInput(String label, List<Face> faces, int width, int height) {}
  static InvalidInput faceInput(String label, Face face) { return new InvalidInput(label, Collections.singletonList(face), 640, 480); }
  static List<InvalidInput> invalidInputs() {
    List<InvalidInput> inputs = new ArrayList<>();
    inputs.add(new InvalidInput("null result", null, 640, 480));
    inputs.add(new InvalidInput("no person", List.of(), 640, 480));
    inputs.add(new InvalidInput("two persons", List.of(NEUTRAL, NEUTRAL), 640, 480));
    inputs.add(faceInput("null person", null));
    inputs.add(faceInput("missing tracking ID", new Face(CENTER, null, 0f, 0f, .2f)));
    inputs.add(faceInput("null bounding box", new Face(null, 11, 0f, 0f, .2f)));
    for (int[] dimensions : new int[][] { { 0, 480 }, { -1, 480 }, { 640, 0 }, { 640, -1 }, { Integer.MIN_VALUE, Integer.MAX_VALUE } })
      inputs.add(new InvalidInput("invalid dimensions " + Arrays.toString(dimensions), List.of(NEUTRAL), dimensions[0], dimensions[1]));
    Rect[] boxes = { new Rect(200, 240, 440, 240), new Rect(320, 100, 320, 380), new Rect(440, 100, 200, 380),
      new Rect(200, 380, 440, 100), new Rect(-1, 100, 440, 380), new Rect(200, -1, 440, 380),
      new Rect(200, 100, 641, 380), new Rect(200, 100, 440, 481), new Rect(800, 100, 1040, 380),
      new Rect(0, 100, 240, 380), new Rect(200, 0, 440, 200), new Rect(256, 100, 384, 380),
      new Rect(60, 100, 580, 380), new Rect(Integer.MIN_VALUE, 100, Integer.MAX_VALUE, 380) };
    for (int index = 0; index < boxes.length; index++) inputs.add(faceInput("invalid geometry " + index, new Face(boxes[index], 11, 0f, 0f, .2f)));
    for (float value : new float[] { Float.NaN, Float.POSITIVE_INFINITY, Float.NEGATIVE_INFINITY }) {
      inputs.add(faceInput("invalid yaw " + value, new Face(CENTER, 11, value, 0f, .2f)));
      inputs.add(faceInput("invalid roll " + value, new Face(CENTER, 11, 0f, value, .2f)));
    }
    return inputs;
  }
  static void interruptionsAndGeometry() {
    for (boolean turn : new boolean[] { false, true }) for (int currentPhase = 0; currentPhase <= 2; currentPhase++) {
      for (InvalidInput input : invalidInputs()) {
        ProductionVisionFaceHost host = phase(currentPhase, turn);
        feed(host, currentPhase == 1 ? (turn ? turn(25f, 0f) : SMILE) : NEUTRAL, currentPhase == 1 ? 3 : 6);
        host.processFaces(input.faces(), input.width(), input.height());
        state(host, 0, 0, null, input.label() + " resets all sequence state in phase " + currentPhase);
        check(host.lastProgress == .04f, input.label() + " reports reset, not stale action progress");
        restartAndComplete(host, input.label());
      }
      ProductionVisionFaceHost changed = phase(currentPhase, turn);
      feed(changed, new Face(CENTER, 22, 0f, 0f, .2f), 1);
      if (currentPhase == 0) state(changed, 0, 1, 22, "first tracking ID starts its own neutral run");
      else state(changed, 0, 0, 22, "different tracking ID cannot inherit action progress");
      feed(changed, new Face(CENTER, 11, 0f, 0f, .2f), 1);
      state(changed, 0, 0, 11, "returning prior ID cannot recover previous progress");
      restartAndComplete(changed, "tracking identity change");
    }
    // Exact geometric limits use integer-friendly 1000px inputs; inequalities are strict.
    for (Rect box : new Rect[] { new Rect(200, 300, 400, 700), new Rect(600, 300, 800, 700),
      new Rect(350, 80, 650, 480), new Rect(350, 520, 650, 920), new Rect(400, 300, 600, 700), new Rect(110, 300, 890, 700) }) {
      ProductionVisionFaceHost host = phase(2, false);
      host.processFaces(List.of(new Face(box, 11, 0f, 0f, .2f)), 1000, 1000);
      state(host, 0, 0, null, "exact center/width limit is not inside accepted region");
    }
    ProductionVisionFaceHost huge = phase(0, false);
    Face centeredHuge = new Face(new Rect(900000000, 900000000, 1500000000, 1500000000), 11, 0f, 0f, .2f);
    for (int index = 0; index < 7; index++) huge.processFaces(List.of(centeredHuge), Integer.MAX_VALUE, Integer.MAX_VALUE);
    state(huge, 1, 0, 11, "valid large positive coordinates must not overflow Rect center arithmetic");
    ProductionVisionFaceHost alternate = phase(2, false);
    for (int index = 0; index < 20; index++) {
      feed(alternate, NEUTRAL, 6); alternate.processFaces(List.of(), 640, 480);
      check(alternate.captures == 0 && alternate.facePhase == 0 && alternate.stableFrames == 0, "repeated interruptions never accumulate capture progress");
    }
  }
  static void probabilityAndPose() {
    Float[] invalid = { null, Float.NaN, Float.POSITIVE_INFINITY, Float.NEGATIVE_INFINITY, -.001f, 1.001f };
    for (int currentPhase = 0; currentPhase < 2; currentPhase++) for (Float probability : invalid) {
      ProductionVisionFaceHost host = phase(currentPhase, false); feed(host, currentPhase == 0 ? NEUTRAL : SMILE, 3);
      feed(host, smile(probability), 1); state(host, 0, 0, null, "required expression probability invalid " + probability);
      restartAndComplete(host, "invalid smile probability");
    }
    for (Float probability : invalid) {
      ProductionVisionFaceHost returning = phase(2, false); feed(returning, smile(probability), 7);
      check(returning.captures == 1, "return phase does not depend on optional smile probability " + probability);
      ProductionVisionFaceHost turning = phase(0, true); feed(turning, smile(probability), 7);
      feed(turning, new Face(CENTER, 11, 25f, 0f, probability), 4); feed(turning, smile(probability), 7);
      check(turning.captures == 1, "turn challenge does not depend on smile classification " + probability);
    }
    ProductionVisionFaceHost neutral = phase(0, false); feed(neutral, smile(.45f), 8);
    state(neutral, 0, 0, 11, "neutral probability threshold is strict");
    feed(neutral, smile(Math.nextDown(.45f)), 7); state(neutral, 1, 0, 11, "just below neutral threshold accepted");
    feed(neutral, smile(.72f), 8); state(neutral, 1, 0, 11, "smile action threshold is strict");
    feed(neutral, smile(Math.nextUp(.72f)), 4); state(neutral, 2, 0, 11, "just above smile threshold accepted");
    ProductionVisionFaceHost endpoints = phase(0, false); feed(endpoints, smile(0f), 7); feed(endpoints, smile(1f), 4);
    state(endpoints, 2, 0, 11, "probabilities 0 and 1 remain valid endpoints");
    for (float sign : new float[] { -1f, 1f }) {
      ProductionVisionFaceHost turned = phase(1, true); feed(turned, turn(sign * 19f, 0f), 6);
      state(turned, 1, 0, 11, "turn angle threshold is strict in both directions");
      feed(turned, turn(sign * Math.nextUp(19f), 0f), 4); state(turned, 2, 0, 11, "turn just above threshold accepted");
      for (boolean roll : new boolean[] { false, true }) {
        ProductionVisionFaceHost host = phase(1, false);
        Face notFrontalSmile = new Face(CENTER, 11, roll ? 0f : sign * 12f, roll ? sign * 12f : 0f, .9f);
        feed(host, notFrontalSmile, 4); state(host, 1, 0, 11, "smile must remain frontal and level");
        ProductionVisionFaceHost first = phase(0, false); feed(first, new Face(CENTER, 11, roll ? 0f : sign * 12f, roll ? sign * 12f : 0f, .2f), 7);
        state(first, 0, 0, 11, "neutral frontal limit is strict");
        ProductionVisionFaceHost last = phase(2, false); feed(last, notFrontalSmile, 7);
        state(last, 2, 0, 11, "return frontal limit is strict");
      }
      ProductionVisionFaceHost rolledTurn = phase(1, true); feed(rolledTurn, turn(sign * 25f, sign * 12f), 4);
      state(rolledTurn, 1, 0, 11, "turn still requires level roll");
      feed(rolledTurn, turn(sign * 25f, sign * Math.nextDown(12f)), 4);
      state(rolledTurn, 2, 0, 11, "turn just inside roll threshold accepted");
    }
  }
  static void detectionBridge() {
    for (String failure : new String[] { "failure", "cancel", "process-runtime", "process-oom", "no-image", "null-task", "null-result", "result-runtime", "result-oom" }) {
      ProductionVisionFaceHost host = phase(2, false); feed(host, NEUTRAL, 6);
      ImageProxy frame = new ImageProxy();
      host.faceDetector.throwProcess = failure.equals("process-runtime"); host.faceDetector.throwOom = failure.equals("process-oom");
      frame.noImage = failure.equals("no-image"); if (failure.equals("null-task")) host.faceDetector.task = null;
      host.analyzeFace(frame, host.captureLifecycle.generation());
      if (frame.closes == 0) {
        List<Face> result = failure.startsWith("result-") ? List.of(new Face(CENTER, 11, 0f, 0f, .2f) {
          @Override Rect getBoundingBox() {
            if (failure.equals("result-oom")) throw new OutOfMemoryError("synthetic result allocation");
            throw new IllegalArgumentException("synthetic result access");
          }
        }) : null;
        host.faceDetector.task.finish(result, failure.equals("failure") ? new Exception("synthetic asynchronous failure") : null, failure.equals("cancel"));
      }
      state(host, 0, 0, null, "current detection " + failure + " resets completed action");
      check(frame.closes == 1 && !host.faceBusy.get(), failure + " closes frame and releases model gate exactly once");
      restartAndComplete(host, failure + " allows fresh sequence");
    }
    // Retired callback resource release is unconditional; sequence/UI ownership is not.
    for (String result : new String[] { "success", "failure", "cancel" }) for (String retire : new String[] { "next-step", "pause-resume", "destroy" }) {
      ProductionVisionFaceHost host = phase(2, false); ImageProxy frame = new ImageProxy();
      host.analyzeFace(frame, host.captureLifecycle.generation());
      if (retire.equals("next-step")) host.captureLifecycle.nextStep();
      if (retire.equals("pause-resume")) { host.captureLifecycle.suspend(VisionCaptureLifecycle.BACKGROUND); host.captureLifecycle.resume(VisionCaptureLifecycle.BACKGROUND); }
      if (retire.equals("destroy")) host.captureLifecycle.destroy();
      host.resetFaceTracking("new sequence"); feed(host, NEUTRAL, 7); feed(host, SMILE, 2);
      int updates = host.uiUpdates;
      host.faceDetector.task.finish(result.equals("success") ? List.of(NEUTRAL) : null, result.equals("failure") ? new Exception("retired failure") : null, result.equals("cancel"));
      state(host, 1, 2, 11, "retired " + result + " cannot change newer sequence after " + retire);
      check(frame.closes == 1 && !host.faceBusy.get() && host.uiUpdates == updates, "retired result cleans up without UI mutation");
    }
    ProductionVisionFaceHost queued = phase(0, false); queued.deferMain = true;
    ImageProxy first = new ImageProxy(); queued.analyzeFace(first, queued.captureLifecycle.generation());
    queued.faceDetector.task.finish(List.of(NEUTRAL), null, false);
    check(first.closes == 1 && queued.faceBusy.get() && queued.stableFrames == 0, "direct release does not advance sequence before queued main result");
    ImageProxy second = new ImageProxy(); queued.analyzeFace(second, queued.captureLifecycle.generation());
    check(second.closes == 1 && queued.faceDetector.processes == 1, "queued result retains busy gate against out-of-order face processing");
    queued.drainMain(); state(queued, 0, 1, 11, "main result commits exactly one neutral observation");
    check(!queued.faceBusy.get(), "main result finally releases busy gate");
    for (int rotation : new int[] { 0, 90, 180, 270 }) {
      ProductionVisionFaceHost upright = phase(0, false); ImageProxy frame = new ImageProxy(); frame.rotation = rotation;
      if (rotation == 90 || rotation == 270) { frame.width = 480; frame.height = 640; }
      upright.analyzeFace(frame, upright.captureLifecycle.generation()); upright.faceDetector.task.finish(List.of(NEUTRAL), null, false);
      state(upright, 0, 1, 11, "analysis uses upright dimensions for rotation " + rotation);
      check(frame.closes == 1 && !upright.faceBusy.get(), "upright synthetic frame released once");
    }
    ProductionVisionFaceHost reset = phase(2, false); reset.faceCaptureStarted = true; int ui = reset.uiUpdates;
    reset.resetFaceTracking("retired phase");
    check(reset.facePhase == 0 && reset.stableFrames == 0 && reset.activeFaceTrackingId == null && reset.faceCaptureStarted && reset.uiUpdates == ui,
      "tracking reset does not reopen an already-owned camera capture or overwrite its UI");
  }
  static void productionChecks() {
    int start = checks;
    exactSequenceAndContinuity(); interruptionsAndGeometry(); probabilityAndPose(); detectionBridge();
    System.out.println("vision-face-tracking: " + (checks - start) + " real production-method synthetic sequence checks passed");
  }
  public static void main(String[] args) {
    if (args.length > 0) { legacyScenario(args[0], true); return; }
    legacyEvidence();
    productionChecks();
  }
}
