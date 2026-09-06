import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const root = path.resolve(import.meta.dirname, "..");
const nativeRoot = path.join(root, "android-client/android/app/src/main/java/local/fanhao/library");
const activity = fs.readFileSync(path.join(nativeRoot, "NativeVisionExplorationActivity.java"), "utf8").replace(/\r\n/g, "\n");
const plugin = fs.readFileSync(path.join(nativeRoot, "FanHaoVisionExplorationPlugin.java"), "utf8").replace(/\r\n/g, "\n");
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "fanhao-vision-lifecycle-"));
const javaHome = String(process.env.JAVA_HOME || "").trim();
const observeFaceOwnership = process.argv.includes("--face-ownership-probe");
const executable = (name) => javaHome && fs.existsSync(path.join(javaHome, "bin", `${name}.exe`))
  ? path.join(javaHome, "bin", `${name}.exe`) : name;

const productionMethod = (source, name) => source.match(new RegExp(`  (?:private|protected) [\\w.]+ ${name}\\([^]*?\\) \\{[^]*?\\n  \\}`))?.[0];
// These are deliberately narrow wiring guards, not execution of Android's
// Activity registry, CameraX builders, camera hardware, or window manager.
function verifyLifecycleWiring(source) {
  const create = productionMethod(source, "onCreate");
  assert.ok(create?.includes("initializeCaptureState(savedInstanceState);"), "onCreate must initialize deferred/background state");
  assert.ok(!create.includes("requestCameraAndStart()") && !create.includes("restoreRequestedSession("), "onCreate must not start capture before onResume");
  assert.ok(productionMethod(source, "initializeCaptureState")?.includes("captureLifecycle.suspend(VisionCaptureLifecycle.BACKGROUND);"), "initial capture must be background-suspended");
  assert.match(source, /registerForActivityResult\(\s*new ActivityResultContracts\.RequestPermission\(\),\s*this::onCameraPermissionResult\s*\)/, "permission registry must call the stateful result handler");
  const bind = productionMethod(source, "bindCamera");
  for (const face of [true, false]) assert.ok(bind?.includes(`imageAnalysis.setAnalyzer(cameraExecutor, createAnalyzer(token, ${face}));`), "CameraX binding must wire its fixed token to each analyzer");
  const futureGuard = "if (!canUseUi(token) || !captureLifecycle.canCapture(token)) return;";
  assert.ok(bind.includes("long token = captureLifecycle.generation();") && bind.includes(futureGuard)
    && bind.indexOf(futureGuard) < bind.indexOf("cameraProvider = future.get();"), "late camera-provider future must be rejected before touching binding fields");
  const unbind = productionMethod(source, "unbindCamera");
  assert.ok(unbind?.includes("if (imageAnalysis != null) imageAnalysis.clearAnalyzer();")
    && unbind.includes("cameraProvider.unbind(useCases.toArray(new UseCase[0]));")
    && !unbind.includes("unbindAll("), "camera cleanup must clear its analyzer and unbind only owned use cases");
  assert.ok(!productionMethod(source, "ensureFaceDetector")?.includes(".setExecutor("), "ML Kit must retain its independent default executor while CameraX owns exceptional waiting");
}
verifyLifecycleWiring(activity);
const disconnectedWiring = [
  ["deferred initialization", "    initializeCaptureState(savedInstanceState);", ""],
  ["background initialization", "    captureLifecycle.suspend(VisionCaptureLifecycle.BACKGROUND);", ""],
  ["permission registry", "this::onCameraPermissionResult", "granted -> {}"],
  ["face analyzer", "imageAnalysis.setAnalyzer(cameraExecutor, createAnalyzer(token, true));", "imageAnalysis.setAnalyzer(cameraExecutor, image -> analyzeFace(image, captureLifecycle.generation()));"],
  ["document analyzer", "imageAnalysis.setAnalyzer(cameraExecutor, createAnalyzer(token, false));", "imageAnalysis.setAnalyzer(cameraExecutor, image -> analyzeDocument(image, captureLifecycle.generation()));"],
  ["camera-provider future", "      if (!canUseUi(token) || !captureLifecycle.canCapture(token)) return;", ""],
  ["analyzer cleanup", "if (imageAnalysis != null) imageAnalysis.clearAnalyzer();", ""],
  ["owned camera cleanup", "cameraProvider.unbind(useCases.toArray(new UseCase[0]));", "cameraProvider.unbindAll();"],
  ["analysis worker ownership", "imageAnalysis.setAnalyzer(cameraExecutor, createAnalyzer(token, true));", "imageAnalysis.setAnalyzer(ContextCompat.getMainExecutor(this), createAnalyzer(token, true));"],
  ["independent ML Kit executor", "FaceDetectorOptions options = new FaceDetectorOptions.Builder()", "FaceDetectorOptions options = new FaceDetectorOptions.Builder().setExecutor(cameraExecutor)"]
];
for (const [name, from, to] of disconnectedWiring) {
  assert.ok(activity.includes(from), `missing targeted wiring mutation: ${name}`);
  assert.throws(() => verifyLifecycleWiring(activity.replace(from, to)), undefined, `disconnected ${name} must be detected`);
}

// Execute production Activity method bodies and the complete production helper.
// Android widgets, CameraX, ML Kit and the store boundary are deterministic
// doubles. Review action eligibility/state uses production methods; review button
// updates and dialog presentation are named, observable UI boundaries here. Full
// review action/dialog behavior is covered by verify_native_vision_review.mjs.
// Every photo below lives in this verifier's newly created temp directory.
// No device, native library, network, Gradle build, or real session is accessed.
const names = [
  "canUseUi", "postCaptureUi", "postCaptureDelayed", "analyzeFace", "awaitFaceTaskCompletion", "resetFaceTracking", "takePicture",
  "confirmCapturedDocument", "assessImageQuality", "validateIdentityCardSide", "countKeywords", "retryDocumentAutomatically", "acceptCapturedDocument",
  "showCompletion", "finishDocumentSession", "finishFaceSession", "deliverSuccess", "finishCanceled",
  "showFatal", "finishAfterError", "finishCapture", "confirmExit", "beginStep", "finishReview",
  "onSaveInstanceState", "restoreRequestedSession", "restoreCaptureSession", "resumeCaptureSession", "onDestroy",
  "initializeCaptureState", "onResume", "onPause", "canControlCapture", "suspendCapture", "dismissCaptureDialog",
  "resumeForegroundCapture", "onCameraPermissionResult", "requestCameraAndStart", "beginCaptureSession",
  "presentPendingDialog", "resumeAfterExitConfirmation", "showDocumentTypePicker", "createAnalyzer", "analyzeDocument",
  "initializeReviewState", "saveReviewState", "canReviewUi", "canStartReviewAction", "onArchiveShareResult"
];
const methods = names.map((name) => {
  const method = productionMethod(activity, name);
  assert(method, `missing production Activity method: ${name}`);
  return method.replace(/^  private /, "  final ");
}).join("\n");
const pluginMethods = ["resumeSession", "visionExplorationResult", "listSessions", "open"].map((name) => {
  const method = plugin.match(new RegExp(`  (?:private|public) void ${name}\\([^]*?\\) \\{[^]*?\\n  \\}`))?.[0];
  assert(method, `missing production Plugin method: ${name}`);
  return method.replace(/^  private /, "  final ");
}).join("\n");

// Frozen production method from before explicit face-task ownership. The optional
// observation mode uses this source, never the current worker-waiting method.
const faceBeforeOwnership = String.raw`  final void analyzeFace(ImageProxy imageProxy, long token) {
    FaceDetector detector = faceDetector;
    if (!captureLifecycle.canCapture(token) || step != Step.FACE || detector == null
      || faceCaptureStarted || !faceBusy.compareAndSet(false, true)) {
      imageProxy.close();
      return;
    }
    Runnable releaseFrame = VisionCaptureLifecycle.releaseOnce(imageProxy::close);
    try {
      Image mediaImage = imageProxy.getImage();
      if (mediaImage == null) {
        releaseFrame.run();
        faceBusy.set(false);
        return;
      }
      int rotation = imageProxy.getImageInfo().getRotationDegrees();
      int uprightWidth = rotation == 90 || rotation == 270 ? imageProxy.getHeight() : imageProxy.getWidth();
      int uprightHeight = rotation == 90 || rotation == 270 ? imageProxy.getWidth() : imageProxy.getHeight();
      InputImage input = InputImage.fromMediaImage(mediaImage, rotation);
      detector.process(input)
        .addOnCompleteListener(VisionCaptureLifecycle.RELEASE_EXECUTOR, task -> releaseFrame.run())
        .addOnCompleteListener(ContextCompat.getMainExecutor(this), task -> {
          try {
            if (!canUseUi(token) || !captureLifecycle.canCapture(token)) return;
            if (task.isSuccessful()) processFaces(task.getResult(), uprightWidth, uprightHeight);
            else if (!task.isCanceled()) updateFaceUi(0.04f, "人脸检测暂时失败，请调整位置", false);
          } finally {
            faceBusy.set(false);
          }
        });
    } catch (Exception error) {
      releaseFrame.run();
      faceBusy.set(false);
      postCaptureUi(token, () -> updateFaceUi(0.04f, "人脸检测暂时失败，请调整位置", false));
    }
  }`;

const harness = String.raw`package local.fanhao.library;
import java.io.*;
import java.nio.file.*;
import java.security.SecureRandom;
import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.*;
import java.util.function.*;

@interface NonNull {}
class Ui {
  static final ConcurrentLinkedQueue<Runnable> queue = new ConcurrentLinkedQueue<>();
  static boolean inline;
  static void drain() { Runnable action; while ((action = queue.poll()) != null) action.run(); }
}
class Handler {
  final ArrayList<Runnable> pending = new ArrayList<>();
  void postDelayed(Runnable action, long delay) { pending.add(action); }
  void removeCallbacksAndMessages(Object ignored) { pending.clear(); }
  void drain() { ArrayList<Runnable> copy = new ArrayList<>(pending); pending.clear(); copy.forEach(Runnable::run); }
}
class ContextCompat {
  static Executor getMainExecutor(Object ignored) { return Ui.queue::add; }
  static int checkSelfPermission(Host host, String permission) { return host.permissionGranted ? 1 : 0; }
}
class Manifest { static class permission { static final String CAMERA = "camera"; } }
class PackageManager { static final int PERMISSION_GRANTED = 1; }
class PermissionLauncher {
  int launches; boolean throwLaunch;
  void launch(String permission) { launches++; if (throwLaunch) throw new IllegalStateException("permission launch unavailable"); }
}
class ImageAnalysis { interface Analyzer { void analyze(ImageProxy image); } }
class DocumentAssessment {}
class Task<T> {
  final ArrayList<Runnable> listeners = new ArrayList<>();
  volatile boolean done; boolean canceled; T value; Exception error;
  int registrationAttempts, registeredCallbacks, failRegistrationAt;
  boolean failAfterRegistration; Throwable registrationFailure;
  final CountDownLatch completionPolled = new CountDownLatch(1);
  final CountDownLatch repeatedCompletionPolls = new CountDownLatch(3);
  CountDownLatch terminalPollEntered, allowTerminalPollReturn;
  CountDownLatch registrationRetained, allowRegistrationReturn;
  Task<T> addOnCompleteListener(Executor executor, Consumer<Task<T>> listener) {
    return register(() -> executor.execute(() -> listener.accept(this)));
  }
  Task<T> addOnSuccessListener(Executor executor, Consumer<T> listener) {
    return register(() -> { if (!canceled && error == null) executor.execute(() -> listener.accept(value)); });
  }
  Task<T> addOnFailureListener(Executor executor, Consumer<Exception> listener) {
    return register(() -> { if (!canceled && error != null) executor.execute(() -> listener.accept(error)); });
  }
  Task<T> addOnSuccessListener(Consumer<T> listener) { return addOnSuccessListener(Ui.queue::add, listener); }
  Task<T> addOnFailureListener(Consumer<Exception> listener) { return addOnFailureListener(Ui.queue::add, listener); }
  // Registration can fail before retaining a listener or after retaining it.
  // These explicit faults test partial setup; they do not claim the real Tasks
  // library throws at a particular allocation or exposes registration hooks.
  Task<T> register(Runnable listener) {
    boolean fail = ++registrationAttempts == failRegistrationAt;
    if (fail && !failAfterRegistration) Faults.raise(registrationFailure);
    add(listener); registeredCallbacks++;
    if (fail && failAfterRegistration && registrationRetained != null) {
      registrationRetained.countDown();
      try {
        if (!allowRegistrationReturn.await(3, TimeUnit.SECONDS)) throw new AssertionError("registration test barrier timed out");
      } catch (InterruptedException error) { Thread.currentThread().interrupt(); throw new AssertionError("registration barrier interrupted", error); }
    }
    if (fail && failAfterRegistration) Faults.raise(registrationFailure);
    return this;
  }
  Task<T> add(Runnable listener) {
    boolean alreadyComplete;
    synchronized (this) { alreadyComplete = done; if (!alreadyComplete) listeners.add(listener); }
    if (alreadyComplete) listener.run();
    return this;
  }
  boolean isComplete() {
    completionPolled.countDown();
    repeatedCompletionPolls.countDown();
    if (done && terminalPollEntered != null) {
      terminalPollEntered.countDown();
      try {
        if (!allowTerminalPollReturn.await(3, TimeUnit.SECONDS)) throw new AssertionError("terminal poll test barrier timed out");
      } catch (InterruptedException error) { Thread.currentThread().interrupt(); throw new AssertionError("unexpected terminal barrier interruption", error); }
    }
    return done;
  }
  boolean isCanceled() { return canceled; }
  boolean isSuccessful() { return done && !canceled && error == null; }
  T getResult() { return value; }
  void finish(T result, Exception failure, boolean cancel) {
    ArrayList<Runnable> pending;
    synchronized (this) {
      value = result; error = failure; canceled = cancel; done = true;
      pending = new ArrayList<>(listeners); listeners.clear();
    }
    pending.forEach(Runnable::run);
  }
}
class Image {}
class ImageProxy {
  volatile int closes; boolean noImage;
  Image getImage() { return noImage ? null : new Image(); }
  int getWidth() { return 640; } int getHeight() { return 480; }
  ImageProxy getImageInfo() { return this; } int getRotationDegrees() { return 90; }
  synchronized void close() { if (++closes != 1) throw new AssertionError("frame closed twice"); }
}
class Faults {
  static void raise(Throwable failure) {
    if (failure instanceof Error) throw (Error) failure;
    if (failure instanceof RuntimeException) throw (RuntimeException) failure;
    if (failure != null) throw new AssertionError("unsupported test-only failure", failure);
  }
}
class Bitmap {
  int releases, pixelReads; Throwable pixelFailure; Runnable beforePixelRead;
  int width = 4, height = 4, solidColor = -1;
  int getWidth() { return width; } int getHeight() { return height; }
  int getPixel(int x, int y) {
    if (releases != 0) throw new AssertionError("quality read a recycled bitmap");
    pixelReads++;
    if (beforePixelRead != null) { Runnable hook = beforePixelRead; beforePixelRead = null; hook.run(); }
    Faults.raise(pixelFailure);
    return solidColor >= 0 ? solidColor : (x + y) % 2 == 0 ? 0x404040 : 0xc0c0c0;
  }
  boolean isRecycled() { return releases != 0; }
  void recycle() { if (++releases != 1) throw new AssertionError("bitmap recycled twice"); }
}
class Color {
  static int red(int color) { return (color >> 16) & 255; }
  static int green(int color) { return (color >> 8) & 255; }
  static int blue(int color) { return color & 255; }
}
class InputImage {
  static Throwable bitmapFailure; static int bitmapCalls;
  static Throwable mediaFailure; static int mediaCalls;
  Bitmap bitmap;
  static InputImage fromMediaImage(Image image, int rotation) { mediaCalls++; Faults.raise(mediaFailure); return new InputImage(); }
  static InputImage fromBitmap(Bitmap image, int rotation) {
    bitmapCalls++; Faults.raise(bitmapFailure);
    if (image.releases != 0) throw new AssertionError("OCR received a recycled bitmap");
    InputImage input = new InputImage(); input.bitmap = image; return input;
  }
}
class Face {}
class FaceDetector {
  final Task<List<Face>> task = new Task<>(); int closes, processes; boolean throwProcess, nullTask; Throwable processFailure;
  Task<List<Face>> process(InputImage image) {
    processes++; if (throwProcess) throw new IllegalStateException("sync failure"); Faults.raise(processFailure); return nullTask ? null : task;
  }
  void close() { closes++; }
}
class Text { String getText() { return "姓名性别民族"; } }
class TextRecognizer {
  final Task<Text> task = new Task<>(); int closes, processes; Throwable processFailure; boolean nullTask;
  Bitmap receivedBitmap;
  Task<Text> process(InputImage image) {
    processes++; receivedBitmap = image.bitmap; Faults.raise(processFailure); return nullTask ? null : task;
  }
  void close() { closes++; }
}
class TextRecognition {
  static Throwable clientFailure; static int clientCalls;
  static TextRecognizer getClient(Object options) { clientCalls++; Faults.raise(clientFailure); return new TextRecognizer(); }
}
class ChineseTextRecognizerOptions { static class Builder { Object build() { return this; } } }
class ImageCaptureException extends Exception { ImageCaptureException(String message) { super(message); } }
class ImageCapture {
  static class OutputFileOptions { static class Builder { Builder(File file) {} OutputFileOptions build() { return new OutputFileOptions(); } } }
  static class OutputFileResults {}
  abstract static class OnImageSavedCallback {
    public abstract void onImageSaved(OutputFileResults result);
    public abstract void onError(ImageCaptureException error);
  }
  OnImageSavedCallback callback; boolean throwCapture;
  void takePicture(OutputFileOptions options, Executor executor, OnImageSavedCallback result) {
    if (throwCapture) throw new IllegalStateException("capture is unavailable");
    callback = result;
  }
}
class View {
  int writes;
  void setText(String text) { writes++; }
  void showFace(float progress, boolean success) { writes++; }
  void showDocument(int guide, String text) { writes++; }
  void updateDocument(float progress, String text, boolean success) { writes++; }
  void performHapticFeedback(int feedback) {}
}
class HapticFeedbackConstants { static final int LONG_PRESS = 0; }
class SystemClock { static long elapsedRealtime() { return 12345L; } }
class VisionScanOverlayView { static final int GUIDE_ID_PORTRAIT = 0, GUIDE_ID_EMBLEM = 1, GUIDE_BANK_CARD = 2; }
class AlertDialog {
  interface Click { void onClick(AlertDialog dialog, int which); }
  int dismissals; String positiveLabel, neutralLabel, title, message; Click positive, neutral, negative, items; Consumer<AlertDialog> canceled;
  boolean showing = true;
  void dismiss() { dismissals++; showing = false; }
  void click(Click action) { action.onClick(this, 0); Ui.queue.add(this::dismiss); }
  void cancel() { if (canceled != null) canceled.accept(this); Ui.queue.add(this::dismiss); }
  static class Builder {
    final AlertDialog dialog = new AlertDialog();
    Builder(Object context) {}
    Builder setTitle(String value) { dialog.title = value; return this; }
    Builder setMessage(String value) { dialog.message = value; return this; }
    Builder setPositiveButton(String label, Click action) { dialog.positiveLabel = label; dialog.positive = action; return this; }
    Builder setNeutralButton(String label, Click action) { dialog.neutralLabel = label; dialog.neutral = action; return this; }
    Builder setNegativeButton(String label, Click action) { dialog.negative = action; return this; }
    Builder setItems(String[] values, Click action) { dialog.items = action; return this; }
    Builder setOnCancelListener(Consumer<AlertDialog> action) { dialog.canceled = action; return this; }
    Builder setCancelable(boolean value) { return this; }
    AlertDialog show() { return dialog; }
  }
}
class Activity { static final int RESULT_OK = 1, RESULT_CANCELED = 0; }
class Intent {
  final Map<String, Object> extras = new HashMap<>();
  Intent() {} Intent(Object context, Class<?> activity) { if (context == null) throw new NullPointerException("detached Activity"); }
  void putExtra(String key, Object value) { extras.put(key, value); }
  String getStringExtra(String key) { return (String) extras.get(key); }
  boolean getBooleanExtra(String key, boolean fallback) { return extras.containsKey(key) ? (Boolean) extras.get(key) : fallback; }
  int getIntExtra(String key, int fallback) { return extras.containsKey(key) ? (Integer) extras.get(key) : fallback; }
}
class Bundle {
  final Map<String, String> values = new HashMap<>();
  final Map<String, Object> otherValues = new HashMap<>();
  void putString(String key, String value) { values.put(key, value); }
  String getString(String key, String fallback) { return values.getOrDefault(key, fallback); }
  void putBoolean(String key, boolean value) { otherValues.put(key, value); }
  boolean getBoolean(String key, boolean fallback) { return (Boolean) otherValues.getOrDefault(key, fallback); }
  void putInt(String key, int value) { otherValues.put(key, value); }
  int getInt(String key, int fallback) { return (Integer) otherValues.getOrDefault(key, fallback); }
}
class JSONObject {
  String kind, challenge, nextStep; int count;
  String optString(String key, String fallback) {
    String value = "kind".equals(key) ? kind : "challenge".equals(key) ? challenge : "nextStep".equals(key) ? nextStep : null;
    return value == null ? fallback : value;
  }
  JSONObject getJSONArray(String key) { return this; } int length() { return count; }
}
class VisionExplorationStore {
  static int discarded, completed, challengeSaves, creations, recoveries; static File directory, fixtureRoot;
  static JSONObject manifest, pendingManifest;
  static String savedChallenge, lastResolvedId;
  static IOException restoreError, commitError, recoverableError, challengeError, deleteError, listError;
  static boolean deleteResult = true, retainAfterDelete;
  static boolean deleteSession(Object context, String sessionId) throws IOException {
    discarded++;
    if (deleteError != null) throw deleteError;
    if (!deleteResult || directory == null || !directory.exists()) return false;
    Path target = directory.getCanonicalFile().toPath(), root = fixtureRoot.getCanonicalFile().toPath();
    if (!target.startsWith(root) || target.equals(root)) throw new AssertionError("delete outside verifier fixture");
    if (!retainAfterDelete) try (java.util.stream.Stream<Path> files = Files.walk(target)) {
      for (Path file : files.sorted(Comparator.reverseOrder()).toList()) Files.delete(file);
    }
    return true;
  }
  static File resolveSessionDirectory(Object context, String id) { lastResolvedId = id; return directory; }
  static JSONObject getCompletedSession(Object context, String id) throws IOException {
    if (restoreError != null) throw restoreError;
    if (manifest == null) throw new IllegalStateException("探索记录尚未完成"); return manifest;
  }
  static JSONObject getRecoverableSession(Object context, String id) throws IOException {
    recoveries++;
    if (recoverableError != null) throw recoverableError;
    if (manifest != null) throw new IllegalStateException("探索记录已完成，无需继续");
    if (pendingManifest != null) return pendingManifest;
    Host host = (Host) context;
    JSONObject pending = new JSONObject(); pending.kind = host.kind; pending.challenge = host.faceChallenge;
    pending.nextStep = VisionCaptureLifecycle.resumeStep(host.kind, directory); return pending;
  }
  static File createSession(Object context, String kind) { creations++; return directory; }
  static void saveChallenge(File session, String challenge) throws IOException {
    challengeSaves++;
    if (challengeError != null) throw challengeError;
    savedChallenge = challenge;
  }
  static Object listSessions(Object context) throws IOException { if (listError != null) throw listError; return new ArrayList<>(); }
  static void completeSession(File session, String kind, String challenge, String... files) throws IOException {
    if (commitError != null) throw commitError;
    for (String file : files) if (!new File(session, file).isFile()) throw new AssertionError("missing photo");
    completed++; manifest = new JSONObject(); manifest.kind = kind; manifest.challenge = challenge; manifest.count = files.length;
  }
}
class BaseHost {
  boolean finishing, destroyed; int result = -1, finishCalls; Intent data; final Intent launchIntent = new Intent();
  Intent getIntent() { return launchIntent; }
  boolean isFinishing() { return finishing; } boolean isDestroyed() { return destroyed; }
  void runOnUiThread(Runnable action) { if (Ui.inline) action.run(); else Ui.queue.add(action); }
  void finish() { finishing = true; finishCalls++; }
  void setResult(int code) { result = code; }
  void setResult(int code, Intent intent) { result = code; data = intent; }
  protected void onDestroy() { destroyed = true; }
  protected void onPause() {}
  protected void onResume() {}
  protected void onSaveInstanceState(Bundle state) {}
}
class Host extends BaseHost {
  enum Step { ID_FRONT, ID_BACK, BANK_FRONT, FACE }
  static final String MODE_FACE = "face", MODE_DOCUMENT = "document", MODE_REVIEW = "review", EXTRA_MODE = "mode", EXTRA_SESSION_ID = "sessionId", STATE_KIND = "kind", STATE_CHALLENGE = "challenge", STATE_SESSION = "session";
  static final String STATE_EXIT_CONFIRMATION = "exit", STATE_FATAL_MESSAGE = "fatal", STATE_PERMISSION_REQUEST = "permissionRequest", STATE_PERMISSION_RESULT = "permissionResult", STATE_COMPLETED_COUNT = "completedCount";
  static final String STATE_REVIEW_SESSION = "vision.review.session", STATE_REVIEW_DELETE = "vision.review.deletePending", STATE_REVIEW_SHARE = "vision.review.shareInFlight", STATE_REVIEW_ERROR = "vision.review.exportError";
  static final String RESULT_SESSION_ID = "id", RESULT_KIND = "kind", RESULT_CHALLENGE = "challenge", RESULT_FILE_COUNT = "count";
  static final String RESULT_DELETED = "deleted";
  static final String RESULT_PRESERVED = "preserved", RESULT_DISCARDED = "discarded";
  final SecureRandom secureRandom = new SecureRandom();
  final PermissionLauncher cameraPermissionLauncher = new PermissionLauncher();
  final VisionCaptureLifecycle captureLifecycle = new VisionCaptureLifecycle();
  final Handler captureHandler = new Handler(); final AtomicBoolean faceBusy = new AtomicBoolean();
  final View titleView = new View(), instructionView = new View(), statusView = new View(), stepBadge = new View(), scanOverlay = new View(), root = new View();
  ExecutorService cameraExecutor = Executors.newSingleThreadExecutor();
  FaceDetector faceDetector = new FaceDetector(); TextRecognizer textRecognizer = new TextRecognizer();
  ImageCapture imageCapture = new ImageCapture(); AlertDialog captureDialog;
  ImageAnalysis.Analyzer boundAnalyzer;
  File sessionDirectory; Step step = Step.FACE; String kind = "face-verification", mode = "face", faceChallenge = "微笑一下";
  boolean terminalResult, faceCaptureStarted, documentCaptureStarted, faceChallengeTurn; int completedFileCount, documentStableFrames, facePhase, stableFrames;
  Integer activeFaceTrackingId; String restoredCheckpoint;
  String pendingSessionId = "", fatalMessage; Bundle startupState;
  boolean startupPending, permissionRequestInFlight, exitConfirmationPending, permissionGranted = true;
  Boolean cameraPermissionResult;
  String reviewSessionId = "", reviewExportError;
  boolean reviewDeletePending, reviewDeleteInProgress, reviewShareInFlight;
  int reviewActionUpdates, reviewDialogPresentations;
  boolean reviewUiEligibleAtLastUpdate, reviewActionEligibleAtLastUpdate;
  Bitmap decodedPreview = new Bitmap(); Throwable decodeFailure; Runnable beforeDecode;
  int previewDecodes, requestedPreviewLimit;
  long documentStableSince, documentStepStartedAt, lastDocumentUiAt; int processedFaces, faceUi, unbound, starts; String fatal;
  // Observable UI-only boundaries: these do not show a dialog, launch sharing,
  // delete files, or stand in for any production lifecycle/eligibility method.
  void updateReviewActions() {
    reviewActionUpdates++;
    reviewUiEligibleAtLastUpdate = canReviewUi();
    reviewActionEligibleAtLastUpdate = canStartReviewAction(reviewSessionId);
  }
  void presentReviewDialog() { reviewDialogPresentations++; }
  // Explicit decoder boundary only: the complete VisionPreviewDecoder has a
  // separate suite. Confirmation and pixel-quality method bodies below are real.
  Bitmap decodePreview(File file, int maxDimension) {
    previewDecodes++; requestedPreviewLimit = maxDimension;
    if (beforeDecode != null) { Runnable hook = beforeDecode; beforeDecode = null; hook.run(); }
    Faults.raise(decodeFailure); return decodedPreview;
  }
  void unbindCamera() { unbound++; }
  Throwable faceResultFailure;
  void processFaces(List<Face> faces, int width, int height) { Faults.raise(faceResultFailure); processedFaces++; }
  void updateFaceUi(float value, String message, boolean success) { faceUi++; }
  void bindCamera() {
    if (step == Step.FACE && !faceChallenge.equals(VisionExplorationStore.savedChallenge)) throw new AssertionError("camera started before persisted face challenge");
    boundAnalyzer = createAnalyzer(captureLifecycle.generation(), step == Step.FACE);
    starts++;
  }
  void ensureFaceDetector() {}
  void analyzeFace(ImageProxy image) { analyzeFace(image, captureLifecycle.generation()); }
  int assessments, processedDocuments;
  DocumentAssessment assessDocumentFrame(ImageProxy image) { assessments++; return new DocumentAssessment(); }
  void processDocumentAssessment(DocumentAssessment assessment, long now) { processedDocuments++; }
  String fileNameForStep(Step step) { return step == Step.ID_FRONT ? "id-front.jpg" : step == Step.ID_BACK ? "id-back.jpg" : "bank-card-front.jpg"; }
  /* PRODUCTION_METHODS */
}
class NativeVisionExplorationActivity extends Host {}
class JSObject extends HashMap<String, Object> {}
class PluginCall {
  String id, rejected; Exception error; JSObject result;
  PluginCall(String sessionId) { id = sessionId; }
  String getString(String key) { return id; }
  void resolve(JSObject value) { result = value; }
  void reject(String message, Exception cause) { rejected = message; error = cause; }
}
class ActivityResult {
  int result; Intent data;
  ActivityResult(int code, Intent intent) { result = code; data = intent; }
  int getResultCode() { return result; } Intent getData() { return data; }
}
class PluginHost {
  Intent launched; String callback; int launches; boolean detached;
  Object getContext() { return this; } Object getActivity() { return detached ? null : this; }
  void startActivityForResult(PluginCall call, Intent intent, String name) { launched = intent; callback = name; launches++; }
  /* PLUGIN_METHODS */
}
public class VisionLifecycleVerifier {
  static int checks;
  static void check(boolean value, String message) { if (!value) throw new AssertionError(message); checks++; }
  static File photo(File file, String contents) throws Exception { Files.write(file.toPath(), contents.getBytes("UTF-8")); return file; }
  static JSONObject checkpoint(String kind, String challenge, String nextStep) {
    JSONObject pending = new JSONObject(); pending.kind = kind; pending.challenge = challenge; pending.nextStep = nextStep; return pending;
  }
  static Future<Boolean> faceWorker(Host host, ImageProxy frame, boolean preInterrupted, AtomicReference<Thread> workerThread) {
    return host.cameraExecutor.submit(() -> {
      workerThread.set(Thread.currentThread());
      if (preInterrupted) Thread.currentThread().interrupt();
      host.analyzeFace(frame);
      return Thread.currentThread().isInterrupted();
    });
  }
  static void awaitBarrier(CountDownLatch barrier, String failure) throws Exception {
    check(barrier.await(2, TimeUnit.SECONDS), failure);
  }
  static void seedTracking(Host host) { host.facePhase = 2; host.stableFrames = 9; host.activeFaceTrackingId = 73; }
  static boolean trackingReset(Host host) { return host.facePhase == 0 && host.stableFrames == 0 && host.activeFaceTrackingId == null; }
  static void verifyFaceOwnership(File root) throws Exception {
    Ui.inline = false;
    for (int setup = 0; setup < 6; setup++) {
      Host owner = host(root, "face-owned-setup-" + setup); seedTracking(owner);
      ImageProxy frame = new ImageProxy(); AtomicReference<Thread> worker = new AtomicReference<>();
      if (setup < 2) InputImage.mediaFailure = setup == 0 ? new IllegalStateException("media setup failed") : new OutOfMemoryError("media setup failed");
      else if (setup < 4) owner.faceDetector.processFailure = setup == 2 ? new IllegalStateException("model setup failed") : new OutOfMemoryError("model setup failed");
      else if (setup == 4) frame.noImage = true;
      else owner.faceDetector.nullTask = true;
      try {
        check(!faceWorker(owner, frame, false, worker).get(2, TimeUnit.SECONDS), "synchronous face failure does not invent an interruption");
        check(frame.closes == 1 && !owner.faceBusy.get(), "face setup RuntimeException, OOM, missing image or missing task closes frame and releases gate once");
        check(owner.faceDetector.task.completionPolled.getCount() == 1, "face setup failure never polls a task that did not start");
        Ui.drain();
        check(trackingReset(owner) && owner.faceUi == 1 && owner.processedFaces == 0, "face setup failure resets accumulated tracking only through current UI work");
      } finally { owner.onDestroy(); }
    }

    for (int outcome = 0; outcome < 4; outcome++) {
      Host owner = host(root, "face-owned-result-" + outcome); seedTracking(owner);
      if (outcome >= 2) owner.faceResultFailure = outcome == 2 ? new IllegalStateException("invalid face result") : new OutOfMemoryError("invalid face result");
      ImageProxy frame = new ImageProxy();
      try {
        faceWorker(owner, frame, false, new AtomicReference<>()).get(2, TimeUnit.SECONDS);
        check(frame.closes == 0 && owner.faceBusy.get() && owner.faceDetector.task.completionPolled.getCount() == 1,
          "normal face task retains frame and gate without entering fallback polling");
        owner.faceDetector.task.finish(new ArrayList<>(), outcome == 0 ? new Exception("model failed") : null, outcome == 1); Ui.drain();
        check(frame.closes == 1 && !owner.faceBusy.get() && trackingReset(owner) && owner.faceUi == 1,
          "face failure, cancellation or invalid result releases ownership and resets old tracking progress");
      } finally { if (!owner.faceDetector.task.done) owner.faceDetector.task.finish(null, null, true); owner.onDestroy(); }
    }

    for (int registration = 1; registration <= 2; registration++) {
      for (boolean afterRetention : new boolean[] { false, true }) {
        for (boolean outOfMemory : new boolean[] { false, true }) {
          for (int outcome = 0; outcome < 3; outcome++) {
            Host owner = host(root, "face-owned-registration-" + registration + "-" + afterRetention + "-" + outOfMemory + "-" + outcome);
            seedTracking(owner); ImageProxy frame = new ImageProxy(); FaceDetector oldDetector = owner.faceDetector;
            Task<List<Face>> task = oldDetector.task;
            task.failRegistrationAt = registration; task.failAfterRegistration = afterRetention;
            task.registrationFailure = outOfMemory ? new OutOfMemoryError("face listener failed") : new IllegalStateException("face listener failed");
            FaceDetector nextDetector = null;
            try {
              Future<Boolean> pendingWorker = faceWorker(owner, frame, false, new AtomicReference<>());
              awaitBarrier(task.completionPolled, "partial face registration must reach worker-owned completion waiting");
              check(frame.closes == 0 && owner.faceBusy.get() && !pendingWorker.isDone(), "partial face registration never closes an in-flight frame or releases its busy gate");
              ImageProxy blocked = new ImageProxy(); owner.analyzeFace(blocked);
              check(blocked.closes == 1 && oldDetector.processes == 1, "fallback wait rejects another frame without starting concurrent detection");
              task.finish(new ArrayList<>(), outcome == 1 ? new Exception("old model failed") : null, outcome == 2);
              check(!pendingWorker.get(2, TimeUnit.SECONDS) && frame.closes == 1 && !owner.faceBusy.get(),
                "terminal face task releases frame and gate once after partial registration");
              nextDetector = new FaceDetector(); owner.faceDetector = nextDetector;
              ImageProxy nextFrame = new ImageProxy(); faceWorker(owner, nextFrame, false, new AtomicReference<>()).get(2, TimeUnit.SECONDS);
              Ui.drain();
              check(nextFrame.closes == 0 && owner.faceBusy.get() && owner.processedFaces == 0,
                "abandoned face completion cannot process old tracking or clear a newer task's busy gate");
              nextDetector.task.finish(new ArrayList<>(), null, false); Ui.drain();
              check(nextFrame.closes == 1 && !owner.faceBusy.get() && owner.processedFaces == 1,
                "new face task remains usable after old partial registration cleanup");
            } finally {
              if (!task.done) task.finish(null, null, true);
              if (nextDetector != null && !nextDetector.task.done) nextDetector.task.finish(null, null, true);
              oldDetector.close(); owner.onDestroy(); Ui.drain();
            }
          }
        }
      }
    }

    for (int interruption = 0; interruption < 3; interruption++) {
      Host owner = host(root, "face-wait-interruption-" + interruption); Task<List<Face>> task = owner.faceDetector.task;
      task.failRegistrationAt = 1; task.registrationFailure = new OutOfMemoryError("first listener failed");
      ImageProxy frame = new ImageProxy(); AtomicReference<Thread> workerThread = new AtomicReference<>();
      try {
        Future<Boolean> pendingWorker = faceWorker(owner, frame, interruption == 1, workerThread);
        awaitBarrier(task.completionPolled, "face exceptional wait must begin on the analyzer worker");
        if (interruption == 2) workerThread.get().interrupt();
        awaitBarrier(task.repeatedCompletionPolls, "interrupt must not terminate face-task ownership waiting");
        check(frame.closes == 0 && owner.faceBusy.get() && !pendingWorker.isDone(), "interrupted face wait keeps frame and gate until the model is terminal");
        task.finish(null, new Exception("terminal failure"), false);
        check(pendingWorker.get(2, TimeUnit.SECONDS) == (interruption != 0), "face wait restores preexisting or mid-wait interruption without inventing one");
        Ui.drain(); check(frame.closes == 1 && !owner.faceBusy.get(), "interrupted fallback still explicitly closes its frame once after termination");
      } finally { if (!task.done) task.finish(null, null, true); owner.onDestroy(); Ui.drain(); }
    }

    Host noLock = host(root, "face-wait-no-callback-lock"); Task<List<Face>> unlockedTask = noLock.faceDetector.task;
    unlockedTask.failRegistrationAt = 2; unlockedTask.failAfterRegistration = true;
    unlockedTask.registrationFailure = new IllegalStateException("second listener failed");
    unlockedTask.terminalPollEntered = new CountDownLatch(1); unlockedTask.allowTerminalPollReturn = new CountDownLatch(1);
    ExecutorService callbackDriver = Executors.newSingleThreadExecutor(); ImageProxy lockedFrame = new ImageProxy();
    try {
      Future<Boolean> pendingWorker = faceWorker(noLock, lockedFrame, false, new AtomicReference<>());
      awaitBarrier(unlockedTask.completionPolled, "callback-lock case enters exceptional wait");
      unlockedTask.finish(new ArrayList<>(), null, false);
      awaitBarrier(unlockedTask.terminalPollEntered, "hold worker before terminal poll returns to fallback cleanup");
      try { callbackDriver.submit(Ui::drain).get(1, TimeUnit.SECONDS); }
      catch (TimeoutException blocked) { throw new AssertionError("face fallback wait must not retain the callback lock", blocked); }
      check(noLock.faceBusy.get() && !pendingWorker.isDone() && noLock.processedFaces == 0,
        "face fallback holds no callback lock and abandoned main listener cannot steal its busy cleanup");
      unlockedTask.allowTerminalPollReturn.countDown(); pendingWorker.get(2, TimeUnit.SECONDS); Ui.drain();
      check(lockedFrame.closes == 1 && !noLock.faceBusy.get(), "fallback and registered cleanup share one frame and gate release");
    } finally {
      unlockedTask.allowTerminalPollReturn.countDown(); if (!unlockedTask.done) unlockedTask.finish(null, null, true);
      callbackDriver.shutdownNow(); noLock.onDestroy(); Ui.drain();
    }

    Host publication = host(root, "face-registration-publication"); Task<List<Face>> publicationTask = publication.faceDetector.task;
    publicationTask.failRegistrationAt = 2; publicationTask.failAfterRegistration = true;
    publicationTask.registrationFailure = new OutOfMemoryError("failure after retaining complete callback");
    publicationTask.registrationRetained = new CountDownLatch(1); publicationTask.allowRegistrationReturn = new CountDownLatch(1);
    ExecutorService racingCallbacks = Executors.newSingleThreadExecutor(); ImageProxy publicationFrame = new ImageProxy();
    try {
      Future<Boolean> pendingWorker = faceWorker(publication, publicationFrame, false, new AtomicReference<>());
      awaitBarrier(publicationTask.registrationRetained, "hold second registration after callback retention");
      publicationTask.finish(new ArrayList<>(), null, false);
      CountDownLatch callbackDriverStarted = new CountDownLatch(1);
      Future<?> mainCallback = racingCallbacks.submit(() -> { callbackDriverStarted.countDown(); Ui.drain(); });
      awaitBarrier(callbackDriverStarted, "racing callback executor must start before testing publication exclusion");
      boolean publicationBlocked = false;
      try { mainCallback.get(75, TimeUnit.MILLISECONDS); } catch (TimeoutException expected) { publicationBlocked = true; }
      check(publicationBlocked && publication.processedFaces == 0, "face callback waits for atomic registration success or failure publication");
      publicationTask.allowRegistrationReturn.countDown(); pendingWorker.get(2, TimeUnit.SECONDS); mainCallback.get(2, TimeUnit.SECONDS); Ui.drain();
      check(publicationFrame.closes == 1 && !publication.faceBusy.get() && publication.processedFaces == 0,
        "registration failure is published before a racing completed task can update tracking");
    } finally {
      publicationTask.allowRegistrationReturn.countDown(); if (!publicationTask.done) publicationTask.finish(null, null, true);
      racingCallbacks.shutdownNow(); publication.onDestroy(); Ui.drain();
    }

    for (boolean canceled : new boolean[] { false, true }) {
      Host paused = host(root, "face-reset-paused-" + canceled); ImageProxy frame = new ImageProxy();
      faceWorker(paused, frame, false, new AtomicReference<>()).get(2, TimeUnit.SECONDS);
      paused.onPause(); seedTracking(paused); int priorUi = paused.faceUi;
      paused.faceDetector.task.finish(null, canceled ? null : new Exception("late failure"), canceled); Ui.drain();
      check(frame.closes == 1 && !paused.faceBusy.get() && paused.facePhase == 2 && paused.stableFrames == 9
        && paused.activeFaceTrackingId == 73 && paused.faceUi == priorUi, "stale face failure or cancellation cleans resources without resetting newer tracking state");
      paused.onDestroy();
    }
  }
  static Host host(File root, String suffix) throws Exception {
    Host host = new Host(); host.sessionDirectory = new File(root, suffix); check(host.sessionDirectory.mkdir(), "fixture mkdir");
    VisionExplorationStore.directory = host.sessionDirectory; VisionExplorationStore.manifest = null; VisionExplorationStore.pendingManifest = null;
    VisionExplorationStore.restoreError = null; VisionExplorationStore.commitError = null; VisionExplorationStore.recoverableError = null;
    VisionExplorationStore.challengeError = null; VisionExplorationStore.deleteError = null; VisionExplorationStore.listError = null;
    VisionExplorationStore.deleteResult = true; VisionExplorationStore.retainAfterDelete = false; VisionExplorationStore.savedChallenge = null;
    InputImage.bitmapFailure = null; InputImage.bitmapCalls = 0;
    InputImage.mediaFailure = null; InputImage.mediaCalls = 0;
    TextRecognition.clientFailure = null; TextRecognition.clientCalls = 0;
    return host;
  }
  // Optional readout of the frozen pre-ownership analyzeFace method above.
  // This diagnostic deliberately reports outcomes rather than blessing the old
  // unsafe behavior as a green safety assertion. The formal regressions above
  // always execute the current production frame-ownership contract instead.
  static void observeFaceOwnership(File root) throws Exception {
    for (String stage : new String[] { "media", "process" }) {
      for (boolean outOfMemory : new boolean[] { false, true }) {
        Host owner = host(root, "face-setup-observation-" + stage + "-" + outOfMemory);
        ImageProxy frame = new ImageProxy(); Throwable injected = outOfMemory
          ? new OutOfMemoryError("face setup injected") : new IllegalStateException("face setup injected");
        if ("media".equals(stage)) InputImage.mediaFailure = injected;
        else owner.faceDetector.processFailure = injected;
        String escaped = "none";
        try { owner.analyzeFace(frame); } catch (Throwable error) { escaped = error.getClass().getSimpleName(); }
        Ui.drain();
        System.out.println("face-ownership-observation: setup=" + stage + ", oom=" + outOfMemory
          + ", escaped=" + escaped + ", frameCloses=" + frame.closes + ", busy=" + owner.faceBusy.get()
          + ", modelCalls=" + owner.faceDetector.processes);
        owner.onDestroy();
      }
    }
    for (int registration = 1; registration <= 2; registration++) {
      for (boolean afterRetention : new boolean[] { false, true }) {
        for (boolean outOfMemory : new boolean[] { false, true }) {
          Host owner = host(root, "face-registration-observation-" + registration + "-" + afterRetention + "-" + outOfMemory);
          FaceDetector oldDetector = owner.faceDetector; ImageProxy oldFrame = new ImageProxy();
          oldDetector.task.failRegistrationAt = registration; oldDetector.task.failAfterRegistration = afterRetention;
          oldDetector.task.registrationFailure = outOfMemory ? new OutOfMemoryError("face listener injected")
            : new IllegalStateException("face listener injected");
          String escaped = "none";
          try { owner.analyzeFace(oldFrame); } catch (Throwable error) { escaped = error.getClass().getSimpleName(); }
          Ui.drain();
          int closesWhilePending = oldFrame.closes; boolean busyAfterFailure = owner.faceBusy.get();
          FaceDetector newDetector = new FaceDetector(); owner.faceDetector = newDetector;
          ImageProxy newFrame = new ImageProxy(); owner.analyzeFace(newFrame);
          int uiBeforeOld = owner.processedFaces;
          oldDetector.task.finish(new ArrayList<>(), null, false); Ui.drain();
          boolean busyAfterOld = owner.faceBusy.get();
          int staleFaceUpdates = owner.processedFaces - uiBeforeOld;
          ImageProxy thirdFrame = new ImageProxy(); owner.analyzeFace(thirdFrame);
          System.out.println("face-ownership-observation: registration=" + registration + ", after=" + afterRetention + ", oom=" + outOfMemory
            + ", escaped=" + escaped + ", retained=" + oldDetector.task.registeredCallbacks
            + ", closedWhilePending=" + closesWhilePending + ", busyAfterFailure=" + busyAfterFailure
            + ", closedAfterCompletion=" + oldFrame.closes + ", newModelCalls=" + newDetector.processes
            + ", busyAfterOld=" + busyAfterOld + ", staleFaceUpdates=" + staleFaceUpdates);
          newDetector.task.finish(new ArrayList<>(), null, false); Ui.drain();
          oldDetector.close(); owner.onDestroy();
        }
      }
    }
  }
  public static void main(String[] args) throws Exception {
    File root = new File(args[0]); VisionExplorationStore.fixtureRoot = root;
    if (args.length > 1 && "face-ownership-probe".equals(args[1])) { observeFaceOwnership(root); return; }
    Host confirmationGate = host(root, "confirmation-gate"); ImageProxy confirmationFrame = new ImageProxy();
    confirmationGate.analyzeFace(confirmationFrame); confirmationGate.confirmExit();
    confirmationGate.faceDetector.task.finish(new ArrayList<>(), null, false); Ui.drain();
    Host backgroundGate = host(root, "background-gate"); ImageProxy backgroundFrame = new ImageProxy();
    backgroundGate.analyzeFace(backgroundFrame); backgroundGate.onPause();
    backgroundGate.faceDetector.task.finish(new ArrayList<>(), null, false); Ui.drain();
    check(backgroundFrame.closes == 1 && backgroundGate.processedFaces == 0, "onPause blocks in-flight face result without dropping frame cleanup");
    check(confirmationFrame.closes == 1 && confirmationGate.processedFaces == 0, "exit confirmation blocks in-flight face result while still releasing its frame");
    check(confirmationGate.unbound == 1 && backgroundGate.unbound == 1, "pause and exit confirmation both withdraw owned camera use cases");
    confirmationGate.finishAfterError(); confirmationGate.onDestroy();
    backgroundGate.finishAfterError(); backgroundGate.onDestroy();
    for (boolean inline : new boolean[] { false, true }) {
      Ui.inline = inline;
      Host dialogRace = host(root, "exit-background-race-" + inline);
      dialogRace.facePhase = 2; dialogRace.stableFrames = 99; dialogRace.activeFaceTrackingId = 7;
      long preDialog = dialogRace.captureLifecycle.generation(); AtomicInteger staleUi = new AtomicInteger();
      dialogRace.postCaptureDelayed(preDialog, staleUi::incrementAndGet, 900);
      Runnable staleDelay = dialogRace.captureHandler.pending.get(0);
      dialogRace.confirmExit(); AlertDialog oldDialog = dialogRace.captureDialog;
      check(dialogRace.captureLifecycle.isSuspended(VisionCaptureLifecycle.EXIT_CONFIRMATION) && dialogRace.captureHandler.pending.isEmpty(), "exit confirmation suspends capture and withdraws delayed actions before showing UI");
      dialogRace.onPause(); oldDialog.negative.onClick(oldDialog, 0); staleDelay.run();
      check(dialogRace.captureLifecycle.isSuspended(VisionCaptureLifecycle.BACKGROUND) && dialogRace.exitConfirmationPending && dialogRace.starts == 0 && staleUi.get() == 0, "late dismissed dialog action cannot restart background capture or revive prior callbacks");
      dialogRace.onResume(); AlertDialog currentDialog = dialogRace.captureDialog;
      check(currentDialog != oldDialog && dialogRace.starts == 0 && dialogRace.captureLifecycle.isSuspended(VisionCaptureLifecycle.EXIT_CONFIRMATION), "returning foreground re-presents unresolved exit without scanning");
      currentDialog.click(currentDialog.negative); Ui.drain();
      check(!dialogRace.captureLifecycle.isSuspended() && dialogRace.starts == 1 && !dialogRace.exitConfirmationPending, "explicit continue releases only exit reason and resumes one checkpoint");
      check(dialogRace.facePhase == 0 && dialogRace.stableFrames == 0 && dialogRace.activeFaceTrackingId == null, "continuing resets face sequence and tracking identity");
      dialogRace.confirmExit(); dialogRace.captureDialog.cancel(); Ui.drain();
      check(dialogRace.starts == 2 && !dialogRace.captureLifecycle.isSuspended(), "backdrop or back cancellation follows the same explicit continue transition");
      dialogRace.confirmExit(); AlertDialog exitBeforeFatal = dialogRace.captureDialog;
      dialogRace.showFatal("checkpoint cannot be read"); Ui.drain(); AlertDialog fatalDialog = dialogRace.captureDialog;
      exitBeforeFatal.negative.onClick(exitBeforeFatal, 0);
      check(dialogRace.captureLifecycle.isSuspended(VisionCaptureLifecycle.FATAL_ERROR) && dialogRace.captureLifecycle.isSuspended(VisionCaptureLifecycle.EXIT_CONFIRMATION) && dialogRace.starts == 2, "a superseded exit control cannot clear an independent fatal reason");
      fatalDialog.click(fatalDialog.positive); Ui.drain();
      check(dialogRace.result == Activity.RESULT_CANCELED && dialogRace.finishCalls == 1 && dialogRace.sessionDirectory.isDirectory(), "fatal close remains reachable under stacked suspensions and preserves files"); dialogRace.onDestroy();
    }
    Ui.inline = false;

    Host preResume = host(root, "permission-before-resume"); preResume.sessionDirectory = null;
    preResume.initializeCaptureState(null); preResume.permissionGranted = true;
    int creationBeforeResume = VisionExplorationStore.creations;
    preResume.onCameraPermissionResult(true);
    check(preResume.captureLifecycle.isSuspended(VisionCaptureLifecycle.BACKGROUND) && preResume.starts == 0 && VisionExplorationStore.creations == creationBeforeResume, "permission grant before first resume is remembered without creating a session or camera");
    preResume.onResume();
    check(preResume.starts == 1 && preResume.cameraPermissionLauncher.launches == 0 && VisionExplorationStore.creations == creationBeforeResume + 1, "first foreground resume consumes early grant exactly once"); preResume.onDestroy();

    Host permissionRace = host(root, "permission-inflight-resume"); permissionRace.sessionDirectory = null;
    permissionRace.permissionGranted = false; permissionRace.initializeCaptureState(null); permissionRace.onResume();
    check(permissionRace.permissionRequestInFlight && permissionRace.cameraPermissionLauncher.launches == 1 && permissionRace.starts == 0, "foreground permission request is registered once without camera start");
    permissionRace.onPause(); permissionRace.onResume();
    check(permissionRace.cameraPermissionLauncher.launches == 1 && permissionRace.starts == 0, "resume while permission dialog remains pending does not launch another permission request");
    permissionRace.onPause(); permissionRace.permissionGranted = true; permissionRace.onCameraPermissionResult(true);
    check(permissionRace.starts == 0 && !permissionRace.permissionRequestInFlight, "background permission grant records outcome but cannot bind camera");
    permissionRace.onResume();
    check(permissionRace.starts == 1 && permissionRace.cameraPermissionLauncher.launches == 1, "recorded background grant starts camera only after foreground resumes"); permissionRace.onDestroy();

    Host denied = host(root, "permission-denied-rotation"); denied.sessionDirectory = null;
    denied.permissionGranted = false; denied.initializeCaptureState(null); denied.onResume(); denied.onPause(); denied.onCameraPermissionResult(false);
    check(denied.captureDialog == null && denied.captureLifecycle.isSuspended(VisionCaptureLifecycle.FATAL_ERROR), "denied permission while background stores fatal intent without presenting dialog");
    Bundle deniedState = new Bundle(); denied.onSaveInstanceState(deniedState); denied.onDestroy();
    Host deniedRestored = new Host(); deniedRestored.permissionGranted = false; deniedRestored.initializeCaptureState(deniedState); deniedRestored.onResume(); Ui.drain();
    check(deniedRestored.starts == 0 && deniedRestored.cameraPermissionLauncher.launches == 0 && Boolean.FALSE.equals(deniedRestored.cameraPermissionResult), "recreation preserves denial and does not silently ask again or scan");
    check(deniedRestored.captureDialog != null && "无法继续".equals(deniedRestored.captureDialog.title), "recreated denial presents its pending fatal dialog in foreground");
    deniedRestored.captureDialog.click(deniedRestored.captureDialog.positive); Ui.drain(); deniedRestored.onDestroy();

    Host pendingPermission = host(root, "permission-request-rotation"); pendingPermission.sessionDirectory = null;
    pendingPermission.permissionGranted = false; pendingPermission.initializeCaptureState(null); pendingPermission.onResume();
    Bundle permissionState = new Bundle(); pendingPermission.onSaveInstanceState(permissionState); pendingPermission.onDestroy();
    Host restoredPermission = new Host(); restoredPermission.permissionGranted = false; restoredPermission.initializeCaptureState(permissionState); restoredPermission.onResume();
    check(restoredPermission.permissionRequestInFlight && restoredPermission.cameraPermissionLauncher.launches == 0 && restoredPermission.starts == 0, "recreation waits for registered in-flight permission result instead of duplicate prompt");
    restoredPermission.permissionGranted = true; restoredPermission.onCameraPermissionResult(true);
    check(restoredPermission.starts == 1 && !restoredPermission.permissionRequestInFlight, "foreground result after recreation resumes the deferred capture"); restoredPermission.onDestroy();

    Host undecided = host(root, "exit-dialog-rotation"); undecided.kind = "id-card"; undecided.mode = Host.MODE_DOCUMENT;
    photo(new File(undecided.sessionDirectory, "id-front.jpg"), "accepted portrait");
    VisionExplorationStore.pendingManifest = checkpoint("id-card", "", "ID_BACK");
    undecided.confirmExit(); Bundle undecidedState = new Bundle(); undecided.onSaveInstanceState(undecidedState); undecided.onDestroy();
    Host undecidedRestored = new Host(); undecidedRestored.initializeCaptureState(undecidedState);
    Bundle beforeFirstResume = new Bundle(); undecidedRestored.onSaveInstanceState(beforeFirstResume);
    check(undecided.sessionDirectory.getName().equals(beforeFirstResume.getString(Host.STATE_SESSION, "")) && beforeFirstResume.getBoolean(Host.STATE_EXIT_CONFIRMATION, false) && "id-card".equals(beforeFirstResume.getString(Host.STATE_KIND, "")), "saving again before first resume retains deferred session metadata and undecided exit");
    undecidedRestored.onResume();
    check(undecidedRestored.sessionDirectory == null && undecidedRestored.starts == 0 && undecidedRestored.captureDialog != null, "restored exit presents decision before any checkpoint or camera restart");
    undecidedRestored.captureDialog.click(undecidedRestored.captureDialog.negative); Ui.drain();
    check(undecidedRestored.step == Host.Step.ID_BACK && undecidedRestored.starts == 1, "explicit continue after rotation restores confirmed document checkpoint"); undecidedRestored.onDestroy();

    for (boolean discard : new boolean[] { false, true }) {
      Host pausedDecision = host(root, "unresolved-decision-" + discard); pausedDecision.confirmExit();
      File decisionPhoto = photo(new File(pausedDecision.sessionDirectory, "id-front.jpg"), "confirmed photo");
      Bundle decisionState = new Bundle(); pausedDecision.onSaveInstanceState(decisionState); pausedDecision.onDestroy();
      Host restoredDecision = new Host(); restoredDecision.initializeCaptureState(decisionState); restoredDecision.onResume();
      AlertDialog decisionDialog = restoredDecision.captureDialog;
      decisionDialog.click(discard ? decisionDialog.positive : decisionDialog.neutral); Ui.drain();
      check(restoredDecision.result == Activity.RESULT_CANCELED && restoredDecision.starts == 0 && restoredDecision.data.getBooleanExtra(Host.RESULT_DISCARDED, false) == discard && restoredDecision.data.getBooleanExtra(Host.RESULT_PRESERVED, false) != discard, "unresolved recreated exit can truthfully preserve or delete correct deferred session without scanning");
      check(decisionPhoto.exists() != discard, "recreated decision targets only the saved session"); restoredDecision.onDestroy();
    }

    Host fatalRotation = host(root, "fatal-dialog-rotation");
    File fatalPhoto = photo(new File(fatalRotation.sessionDirectory, "id-front.jpg"), "saved before fatal");
    fatalRotation.showFatal("confirmed storage failure"); Ui.drain(); Bundle fatalState = new Bundle(); fatalRotation.onSaveInstanceState(fatalState); fatalRotation.onDestroy();
    Host fatalRestored = new Host(); fatalRestored.initializeCaptureState(fatalState); fatalRestored.onResume();
    check(fatalRestored.captureDialog != null && "confirmed storage failure".equals(fatalRestored.captureDialog.message) && fatalRestored.starts == 0, "configuration recreation preserves fatal message and blocks automatic recovery");
    fatalRestored.captureDialog.click(fatalRestored.captureDialog.positive); Ui.drain();
    check(fatalPhoto.isFile() && fatalRestored.data.getBooleanExtra(Host.RESULT_PRESERVED, false), "fatal close resolves preserved session reference even before capture restoration"); fatalRestored.onDestroy();

    Host inlineFailure = host(root, "inline-continue-error"); inlineFailure.confirmExit(); AlertDialog replacedExit = inlineFailure.captureDialog;
    VisionExplorationStore.recoverableError = new IOException("resume checkpoint unavailable"); Ui.inline = true;
    replacedExit.click(replacedExit.negative); AlertDialog newFatal = inlineFailure.captureDialog; Ui.drain();
    check(newFatal != null && newFatal != replacedExit && inlineFailure.captureDialog == newFatal && newFatal.showing && inlineFailure.captureLifecycle.isSuspended(VisionCaptureLifecycle.FATAL_ERROR), "delayed dismissal of continued exit dialog cannot dismiss inline recovery error dialog");
    newFatal.click(newFatal.positive); Ui.drain(); inlineFailure.onDestroy(); Ui.inline = false;

    for (boolean faceBinding : new boolean[] { true, false }) {
      Host binding = host(root, "binding-generation-" + faceBinding);
      if (!faceBinding) { binding.kind = "id-card"; binding.mode = Host.MODE_DOCUMENT; binding.step = Host.Step.ID_FRONT; }
      ImageAnalysis.Analyzer previousAnalyzer = binding.createAnalyzer(binding.captureLifecycle.generation(), faceBinding);
      binding.onPause(); binding.onResume(); ImageAnalysis.Analyzer currentAnalyzer = binding.boundAnalyzer;
      ImageProxy oldQueued = new ImageProxy(); previousAnalyzer.analyze(oldQueued); Ui.drain();
      check(oldQueued.closes == 1 && binding.faceDetector.processes == 0 && binding.assessments == 0, "old binding frame delivered only after resume is rejected using binding generation");
      ImageProxy newQueued = new ImageProxy(); currentAnalyzer.analyze(newQueued);
      if (faceBinding) binding.faceDetector.task.finish(new ArrayList<>(), null, false);
      Ui.drain();
      check(newQueued.closes == 1 && (faceBinding ? binding.processedFaces == 1 : binding.processedDocuments == 1), "new binding frame still reaches the current face or document pipeline"); binding.onDestroy();
    }
    Host busyResume = host(root, "busy-task-resume"); ImageProxy busyOld = new ImageProxy(); busyResume.analyzeFace(busyOld);
    FaceDetector priorDetector = busyResume.faceDetector; busyResume.onPause(); busyResume.onResume();
    ImageProxy earlyNew = new ImageProxy(); busyResume.boundAnalyzer.analyze(earlyNew);
    check(earlyNew.closes == 1 && busyResume.faceBusy.get() && priorDetector.processes == 1, "resume never clears a busy gate still owned by old model task");
    priorDetector.task.finish(new ArrayList<>(), null, false); Ui.drain();
    check(busyOld.closes == 1 && !busyResume.faceBusy.get() && busyResume.processedFaces == 0, "old task completion releases its gate without affecting restarted tracking");
    busyResume.faceDetector = new FaceDetector(); ImageProxy afterOld = new ImageProxy(); busyResume.boundAnalyzer.analyze(afterOld);
    check(busyResume.faceDetector.processes == 1 && busyResume.faceBusy.get(), "new model task starts after old ownership is released");
    busyResume.faceDetector.task.finish(new ArrayList<>(), null, false); Ui.drain();
    check(afterOld.closes == 1 && busyResume.processedFaces == 1 && !busyResume.faceBusy.get(), "resumed task is not permanently blocked or prematurely released"); busyResume.onDestroy();

    Host completedPause = host(root, "complete-background-window");
    photo(new File(completedPause.sessionDirectory, "face-verification.jpg"), "accepted face"); completedPause.finishFaceSession(new File(completedPause.sessionDirectory, "face-verification.jpg"));
    Runnable pausedCompletion = completedPause.captureHandler.pending.get(0); completedPause.onPause(); pausedCompletion.run();
    check(completedPause.result == -1 && completedPause.captureLifecycle.isCompleted(), "completed checkpoint is not delivered or finished while background");
    completedPause.onResume(); completedPause.captureHandler.drain();
    check(completedPause.result == Activity.RESULT_OK && completedPause.finishCalls == 1 && completedPause.starts == 0, "completed checkpoint returns exactly once at foreground resume without restarting camera"); completedPause.onDestroy();

    Host completedFatal = host(root, "complete-fatal-rotation");
    photo(new File(completedFatal.sessionDirectory, "face-verification.jpg"), "completed face"); completedFatal.finishFaceSession(new File(completedFatal.sessionDirectory, "face-verification.jpg"));
    completedFatal.showFatal("completion UI error"); Ui.drain(); Bundle completedFatalState = new Bundle(); completedFatal.onSaveInstanceState(completedFatalState); completedFatal.onDestroy();
    Host completedFatalRestored = new Host(); completedFatalRestored.initializeCaptureState(completedFatalState); completedFatalRestored.onResume();
    check(completedFatalRestored.starts == 0 && completedFatalRestored.captureDialog != null && completedFatalRestored.result == -1, "completed fatal decision survives rotation without automatic dismissal");
    completedFatalRestored.captureDialog.click(completedFatalRestored.captureDialog.positive); Ui.drain(); completedFatalRestored.captureHandler.drain();
    check(completedFatalRestored.result == Activity.RESULT_OK && completedFatalRestored.finishCalls == 1, "completed fatal close clears its control suspension and delivers preserved success exactly once"); completedFatalRestored.onDestroy();

    for (int invalidCompletion = 0; invalidCompletion < 3; invalidCompletion++) {
      Host completionHintFixture = host(root, "unverified-completion-hint-" + invalidCompletion);
      File survivingPhoto = photo(new File(completionHintFixture.sessionDirectory, "id-front.jpg"), "survives unverifiable completion");
      Bundle staleCompletion = new Bundle(); staleCompletion.putInt(Host.STATE_COMPLETED_COUNT, 1);
      staleCompletion.putString(Host.STATE_SESSION, completionHintFixture.sessionDirectory.getName());
      staleCompletion.putString(Host.STATE_FATAL_MESSAGE, "completion UI failed");
      if (invalidCompletion == 0) VisionExplorationStore.restoreError = new IOException("completed manifest is corrupt");
      else if (invalidCompletion == 1) {
        survivingPhoto.delete(); completionHintFixture.sessionDirectory.delete();
        VisionExplorationStore.restoreError = new IOException("completed session is missing");
      }
      // Third case is legitimate pending: the saved completed count is stale.
      Host unverifiedCompletion = new Host(); unverifiedCompletion.initializeCaptureState(staleCompletion); unverifiedCompletion.onResume();
      int deletesBeforeHint = VisionExplorationStore.discarded; AlertDialog hintDialog = unverifiedCompletion.captureDialog;
      hintDialog.click(hintDialog.positive); Ui.drain(); unverifiedCompletion.finishAfterError();
      check(unverifiedCompletion.result == Activity.RESULT_CANCELED && unverifiedCompletion.finishCalls == 1 && unverifiedCompletion.starts == 0 && unverifiedCompletion.completedFileCount == 0, "corrupt, missing or pending completion hint closes once without success, scan restart or fatal loop");
      check(VisionExplorationStore.discarded == deletesBeforeHint && !unverifiedCompletion.data.getBooleanExtra(Host.RESULT_DISCARDED, true)
        && unverifiedCompletion.data.getBooleanExtra(Host.RESULT_PRESERVED, false) == (invalidCompletion != 1), "unverified completion hint preserves remaining data and reports missing records truthfully");
      unverifiedCompletion.onDestroy(); completionHintFixture.onDestroy();
    }

    Host completeFatalBackground = host(root, "complete-fatal-background");
    photo(new File(completeFatalBackground.sessionDirectory, "face-verification.jpg"), "completed face"); completeFatalBackground.finishFaceSession(new File(completeFatalBackground.sessionDirectory, "face-verification.jpg"));
    completeFatalBackground.showFatal("late error"); Ui.drain(); completeFatalBackground.onPause(); completeFatalBackground.finishAfterError();
    check(completeFatalBackground.result == -1 && completeFatalBackground.captureLifecycle.isSuspended(VisionCaptureLifecycle.BACKGROUND), "completed error control never clears background or finishes behind another app");
    completeFatalBackground.onResume(); check(completeFatalBackground.result == Activity.RESULT_OK && completeFatalBackground.finishCalls == 1, "completed background decision is delivered on next foreground resume"); completeFatalBackground.onDestroy();

    for (String reviewFailure : new String[] { "read failed", "delete failed" }) {
      Host review = host(root, "review-foreground-" + reviewFailure.replace(" ", "-")); review.mode = Host.MODE_REVIEW;
      review.initializeCaptureState(null); int reviewCreations = VisionExplorationStore.creations, reviewRecoveries = VisionExplorationStore.recoveries;
      review.showFatal(reviewFailure); check(review.captureDialog == null, "review error before resume defers its dialog until foreground");
      review.onResume(); Ui.drain(); review.onPause(); review.onResume();
      check(review.starts == 0 && review.cameraPermissionLauncher.launches == 0 && VisionExplorationStore.creations == reviewCreations && VisionExplorationStore.recoveries == reviewRecoveries, "review lifecycle never enters capture or permission initialization");
      review.captureDialog.click(review.captureDialog.positive); Ui.drain();
      check(review.result == Activity.RESULT_OK && !review.data.getBooleanExtra(Host.RESULT_DELETED, true) && review.sessionDirectory.isDirectory(), "review read or deletion error can close with truthful not-deleted result"); review.onDestroy();
    }
    Host staleReview = host(root, "review-late-fatal-button"); staleReview.mode = Host.MODE_REVIEW;
    staleReview.showFatal("review error"); Ui.drain(); AlertDialog staleReviewDialog = staleReview.captureDialog;
    staleReview.onDestroy(); staleReviewDialog.positive.onClick(staleReviewDialog, 0);
    check(staleReview.captureDialog == null && staleReview.finishCalls == 0 && staleReview.result == -1, "destroy invalidates review fatal button identity before dialog dismissal callbacks");

    for (String captureMode : new String[] { Host.MODE_FACE, Host.MODE_DOCUMENT }) {
      Host captureOnly = host(root, "capture-review-isolation-" + captureMode); captureOnly.mode = captureMode;
      if (Host.MODE_DOCUMENT.equals(captureMode)) { captureOnly.kind = "id-card"; captureOnly.step = Host.Step.ID_FRONT; }
      captureOnly.launchIntent.putExtra(Host.EXTRA_SESSION_ID, captureOnly.sessionDirectory.getName());
      captureOnly.initializeCaptureState(null); captureOnly.onResume();
      check(captureOnly.starts == 1 && captureOnly.reviewDialogPresentations == 0, "capture resume never routes through the review dialog boundary");
      check(!captureOnly.canReviewUi() && !captureOnly.canStartReviewAction(captureOnly.reviewSessionId), "capture mode cannot become eligible for review UI or actions even with a session id");
      captureOnly.finishReview(false);
      check(captureOnly.result == -1 && captureOnly.finishCalls == 0 && !captureOnly.terminalResult, "review finish cannot terminate a capture-mode activity");
      // Simulate a late/misdirected registry result, not a launch from capture UI.
      captureOnly.reviewShareInFlight = true; int captureUpdates = captureOnly.reviewActionUpdates;
      captureOnly.onArchiveShareResult();
      check(captureOnly.reviewShareInFlight && captureOnly.reviewActionUpdates == captureUpdates, "review share callback cannot mutate capture-mode state");
      captureOnly.onPause(); captureOnly.onResume();
      check(captureOnly.starts == 2 && captureOnly.reviewDialogPresentations == 0 && !captureOnly.reviewActionEligibleAtLastUpdate, "capture checkpoint recovery remains independent of review state across pause and resume");
      captureOnly.onDestroy();
    }

    // Review widgets/actions have their own full production-method verifier.
    // Seed their three resumable control states here to test the actual shared
    // Activity lifecycle, Bundle wiring and registry-result handoff in isolation.
    for (String reviewState : new String[] { "delete", "share", "error" }) {
      Host reviewOwner = host(root, "review-capture-handoff-" + reviewState); reviewOwner.mode = Host.MODE_REVIEW;
      String reviewId = reviewOwner.sessionDirectory.getName();
      reviewOwner.launchIntent.putExtra(Host.EXTRA_SESSION_ID, reviewId); reviewOwner.initializeCaptureState(null);
      check(reviewId.equals(reviewOwner.reviewSessionId) && !reviewOwner.canReviewUi(), "capture initialization also initializes review identity before first resume");
      reviewOwner.reviewDeletePending = "delete".equals(reviewState);
      reviewOwner.reviewShareInFlight = "share".equals(reviewState);
      reviewOwner.reviewExportError = "error".equals(reviewState) ? "archive unavailable" : null;
      reviewOwner.reviewDeleteInProgress = true;
      Bundle reviewSaved = new Bundle(); reviewOwner.onSaveInstanceState(reviewSaved);
      check(reviewId.equals(reviewSaved.getString(Host.STATE_REVIEW_SESSION, ""))
        && reviewSaved.getBoolean(Host.STATE_REVIEW_DELETE, false) == "delete".equals(reviewState)
        && reviewSaved.getBoolean(Host.STATE_REVIEW_SHARE, false) == "share".equals(reviewState)
        && Objects.equals(reviewSaved.getString(Host.STATE_REVIEW_ERROR, null), reviewOwner.reviewExportError), "Activity save preserves review identity and the pending control state");
      reviewOwner.onDestroy();

      Host reviewRestored = new Host(); reviewRestored.mode = Host.MODE_REVIEW; reviewRestored.permissionGranted = false;
      reviewRestored.launchIntent.putExtra(Host.EXTRA_SESSION_ID, reviewId); reviewRestored.initializeCaptureState(reviewSaved);
      check(reviewId.equals(reviewRestored.reviewSessionId) && !reviewRestored.reviewDeleteInProgress
        && reviewRestored.reviewDeletePending == "delete".equals(reviewState)
        && reviewRestored.reviewShareInFlight == "share".equals(reviewState)
        && Objects.equals(reviewRestored.reviewExportError, reviewOwner.reviewExportError), "recreated Activity restores review control intent without replaying an in-progress deletion");
      reviewRestored.finishReview(false);
      check(reviewRestored.finishCalls == 0 && reviewRestored.result == -1, "review finish cannot deliver before its Activity becomes foreground");
      if ("share".equals(reviewState)) {
        reviewRestored.onArchiveShareResult();
        check(!reviewRestored.reviewShareInFlight && reviewRestored.captureLifecycle.isSuspended(VisionCaptureLifecycle.BACKGROUND)
          && !reviewRestored.reviewUiEligibleAtLastUpdate && !reviewRestored.reviewActionEligibleAtLastUpdate
          && reviewRestored.reviewDialogPresentations == 0, "early restored share result releases only its gate without presenting UI or clearing background suspension");
      }
      int reviewCreations = VisionExplorationStore.creations, reviewRecoveries = VisionExplorationStore.recoveries;
      reviewRestored.onResume();
      check(reviewRestored.reviewDialogPresentations == 1 && reviewRestored.canReviewUi()
        && reviewRestored.reviewActionEligibleAtLastUpdate == "share".equals(reviewState), "foreground review routes to its UI and updates action eligibility after clearing background");
      check(reviewRestored.starts == 0 && reviewRestored.cameraPermissionLauncher.launches == 0
        && VisionExplorationStore.creations == reviewCreations && VisionExplorationStore.recoveries == reviewRecoveries, "restored review controls never trigger capture restore, session creation or camera permission");
      AlertDialog reviewWindow = new AlertDialog(); reviewRestored.captureDialog = reviewWindow;
      int updatesBeforePause = reviewRestored.reviewActionUpdates;
      reviewRestored.onPause();
      check(reviewRestored.captureDialog == null && !reviewWindow.showing
        && reviewRestored.reviewActionUpdates == updatesBeforePause + 1
        && !reviewRestored.reviewUiEligibleAtLastUpdate && !reviewRestored.reviewActionEligibleAtLastUpdate, "review pause dismisses the old window and updates buttons after suspension");
      reviewRestored.onResume();
      check(reviewRestored.reviewDialogPresentations == 2 && reviewRestored.starts == 0, "review foreground return presents only review controls without binding a camera");
      reviewRestored.showFatal("review control failure"); Ui.drain();
      int presentationsBeforeFatalResume = reviewRestored.reviewDialogPresentations;
      reviewRestored.onPause(); reviewRestored.onResume();
      check(reviewRestored.reviewDialogPresentations == presentationsBeforeFatalResume
        && reviewRestored.captureDialog != null && "review control failure".equals(reviewRestored.captureDialog.message)
        && !reviewRestored.reviewActionEligibleAtLastUpdate, "fatal review control has priority over review presentation and keeps actions disabled");
      reviewRestored.captureDialog.click(reviewRestored.captureDialog.positive); Ui.drain();
      check(reviewRestored.finishCalls == 1 && reviewRestored.result == Activity.RESULT_OK
        && !reviewRestored.data.getBooleanExtra(Host.RESULT_DELETED, true)
        && !reviewRestored.reviewDeletePending && reviewRestored.reviewExportError == null
        && !reviewRestored.reviewUiEligibleAtLastUpdate, "review fatal close consumes pending control state and disables actions before its single truthful result");
      int terminalUpdates = reviewRestored.reviewActionUpdates;
      reviewRestored.onArchiveShareResult(); reviewRestored.finishReview(true); reviewRestored.onResume();
      check(reviewRestored.finishCalls == 1 && reviewRestored.reviewActionUpdates == terminalUpdates
        && !reviewRestored.data.getBooleanExtra(Host.RESULT_DELETED, true), "late review callbacks cannot reopen or overwrite a completed Activity result");
      reviewRestored.onDestroy();

      Host unrelatedReview = new Host(); unrelatedReview.mode = Host.MODE_REVIEW;
      unrelatedReview.launchIntent.putExtra(Host.EXTRA_SESSION_ID, reviewId + "-different"); unrelatedReview.initializeCaptureState(reviewSaved);
      check((reviewId + "-different").equals(unrelatedReview.reviewSessionId) && !unrelatedReview.reviewDeletePending
        && !unrelatedReview.reviewShareInFlight && unrelatedReview.reviewExportError == null, "review restore never imports another session's pending controls");
      unrelatedReview.onDestroy();
    }

    for (int outcome = 0; outcome < 3; outcome++) {
      Host host = host(root, "late-face-" + outcome); ImageProxy frame = new ImageProxy();
      host.analyzeFace(frame); check(frame.closes == 0 && host.faceBusy.get(), "frame retained while model runs");
      host.onDestroy(); host.onDestroy();
      check(host.cameraExecutor.isShutdown(), "analyzer executor stopped");
      check(host.faceDetector.closes == 1 && host.textRecognizer.closes == 1, "model cleanup idempotent");
      host.faceDetector.task.finish(new ArrayList<>(), outcome == 1 ? new Exception("failure") : null, outcome == 2);
      Ui.drain();
      check(frame.closes == 1 && !host.faceBusy.get(), "late model completion closes frame exactly once");
      check(host.processedFaces == 0 && host.faceUi == 0, "destroyed owner ignores model callbacks");
    }
    Host live = host(root, "live-face"); ImageProxy liveFrame = new ImageProxy(); live.analyzeFace(liveFrame);
    live.faceDetector.task.finish(new ArrayList<>(), null, false); Ui.drain();
    check(liveFrame.closes == 1 && live.processedFaces == 1, "live model result still works"); live.onDestroy();
    Host immediate = host(root, "immediate-face"); immediate.faceDetector.task.finish(new ArrayList<>(), null, false);
    ImageProxy first = new ImageProxy(), second = new ImageProxy(); immediate.analyzeFace(first); immediate.analyzeFace(second);
    check(first.closes == 1 && second.closes == 1 && immediate.faceBusy.get(), "frames release independently of pending business work");
    check(immediate.faceDetector.processes == 1, "second detection waits until first tracking result is processed");
    Ui.drain(); check(!immediate.faceBusy.get() && immediate.processedFaces == 1, "business completion releases serialization gate"); immediate.onDestroy();
    Host failing = host(root, "sync-face"); failing.faceDetector.throwProcess = true; ImageProxy bad = new ImageProxy();
    failing.analyzeFace(bad); Ui.drain(); check(bad.closes == 1 && !failing.faceBusy.get(), "synchronous model failure releases frame"); failing.onDestroy();

    Host queued = host(root, "queued-analyzer"); ImageProxy queuedFrame = new ImageProxy();
    CountDownLatch entered = new CountDownLatch(1), release = new CountDownLatch(1);
    queued.cameraExecutor.execute(() -> { entered.countDown(); try { release.await(); } catch (InterruptedException e) { throw new AssertionError(e); } });
    check(entered.await(3, TimeUnit.SECONDS), "analyzer queue started");
    queued.cameraExecutor.execute(() -> queued.analyzeFace(queuedFrame)); queued.onDestroy(); release.countDown();
    check(queued.cameraExecutor.awaitTermination(3, TimeUnit.SECONDS), "queued analyzer drained");
    check(queuedFrame.closes == 1, "shutdown does not drop an analyzer owning a frame");

    Host old = host(root, "camera-ownership"); old.mode = "document"; old.kind = "id-card"; old.step = Host.Step.ID_FRONT;
    File oldOutput = VisionCaptureLifecycle.temporaryCapture(old.sessionDirectory);
    old.takePicture(oldOutput, () -> old.acceptCapturedDocument(oldOutput), message -> { throw new AssertionError(message); });
    old.onDestroy();
    Host replacement = new Host(); replacement.sessionDirectory = old.sessionDirectory; replacement.mode = "document"; replacement.kind = "id-card"; replacement.step = Host.Step.ID_FRONT;
    File current = photo(VisionCaptureLifecycle.temporaryCapture(old.sessionDirectory), "new accepted portrait");
    replacement.acceptCapturedDocument(current);
    photo(oldOutput, "old delayed camera output"); old.imageCapture.callback.onImageSaved(new ImageCapture.OutputFileResults());
    check(!oldOutput.exists(), "late camera callback cleans only its own temporary photo");
    check(Files.readString(new File(old.sessionDirectory, "id-front.jpg").toPath()).equals("new accepted portrait"), "late camera cannot overwrite new accepted photo");
    check(VisionCaptureLifecycle.resumeStep("id-card", old.sessionDirectory).equals("ID_BACK"), "portrait checkpoint resumes back side");
    Runnable delayedOldStep = replacement.captureHandler.pending.get(0); replacement.onDestroy(); delayedOldStep.run();
    check(replacement.starts == 0, "already dequeued 900ms step callback ignores destroyed owner");

    Host ocr = host(root, "late-ocr"); ocr.mode = "document"; ocr.kind = "id-card"; ocr.step = Host.Step.ID_FRONT;
    File unconfirmed = photo(VisionCaptureLifecycle.temporaryCapture(ocr.sessionDirectory), "unvalidated card"); Bitmap bitmap = new Bitmap();
    ocr.validateIdentityCardSide(unconfirmed, bitmap, Host.Step.ID_FRONT);
    check(VisionCaptureLifecycle.resumeStep("id-card", ocr.sessionDirectory).equals("ID_FRONT"), "in-flight OCR is not a confirmed checkpoint");
    ocr.onDestroy(); ocr.textRecognizer.task.finish(new Text(), null, false); Ui.drain();
    check(bitmap.releases == 1 && !unconfirmed.exists(), "late OCR cleans bitmap and its own photo");
    check(!new File(ocr.sessionDirectory, "id-front.jpg").exists(), "late OCR cannot promote a photo");

    for (String failureStage : new String[] { "decode", "quality", "fromBitmap", "getClient", "process" }) {
      for (boolean outOfMemory : new boolean[] { false, true }) {
        Host failedPreview = host(root, "preview-failure-" + failureStage + "-" + outOfMemory);
        failedPreview.mode = Host.MODE_DOCUMENT; failedPreview.kind = "id-card"; failedPreview.step = Host.Step.ID_FRONT;
        failedPreview.documentCaptureStarted = true; failedPreview.documentStableFrames = 12; failedPreview.documentStableSince = 456L;
        File failedPhoto = photo(VisionCaptureLifecycle.temporaryCapture(failedPreview.sessionDirectory), "unconfirmed input");
        Bitmap failedBitmap = failedPreview.decodedPreview;
        Throwable injected = outOfMemory ? new OutOfMemoryError("injected " + failureStage) : new IllegalStateException("injected " + failureStage);
        if ("decode".equals(failureStage)) failedPreview.decodeFailure = injected;
        else if ("quality".equals(failureStage)) failedBitmap.pixelFailure = injected;
        else if ("fromBitmap".equals(failureStage)) InputImage.bitmapFailure = injected;
        else if ("getClient".equals(failureStage)) { failedPreview.textRecognizer = null; TextRecognition.clientFailure = injected; }
        else failedPreview.textRecognizer.processFailure = injected;
        failedPreview.confirmCapturedDocument(failedPhoto); Ui.drain();
        check(!failedPhoto.exists() && !failedPreview.documentCaptureStarted && failedPreview.documentStableFrames == 0
          && failedPreview.documentStableSince == 0L, "preview or OCR setup failure cleans its temporary photo and restores the current capture retry gate");
        check(failedBitmap.releases == ("decode".equals(failureStage) ? 0 : 1), "preview ownership is released exactly once after quality or OCR setup failure");
        check(!new File(failedPreview.sessionDirectory, "id-front.jpg").exists() && failedPreview.captureHandler.pending.isEmpty()
          && failedPreview.result == -1 && failedPreview.fatalMessage == null, "preview failure cannot promote, schedule a next step or turn a retry into terminal success");
        check(failedPreview.previewDecodes == 1 && failedPreview.requestedPreviewLimit == 1100, "document confirmation uses its bounded decoder entry once");
        failedPreview.onDestroy();
      }
    }

    for (int invalidQuality = 0; invalidQuality < 4; invalidQuality++) {
      Host rejected = host(root, "preview-quality-" + invalidQuality); rejected.mode = Host.MODE_DOCUMENT;
      rejected.kind = "id-card"; rejected.step = Host.Step.ID_FRONT; rejected.documentCaptureStarted = true;
      Bitmap rejectedBitmap = rejected.decodedPreview;
      if (invalidQuality == 0) rejected.decodedPreview = null;
      else rejectedBitmap.solidColor = invalidQuality == 1 ? 0x000000 : invalidQuality == 2 ? 0xffffff : 0x808080;
      File rejectedPhoto = photo(VisionCaptureLifecycle.temporaryCapture(rejected.sessionDirectory), "poor preview");
      rejected.confirmCapturedDocument(rejectedPhoto); Ui.drain();
      check(!rejectedPhoto.exists() && !rejected.documentCaptureStarted && InputImage.bitmapCalls == 0
        && rejected.textRecognizer.processes == 0, "null, dark, bright and flat previews retry without handing an image to OCR");
      check(rejectedBitmap.releases == (invalidQuality == 0 ? 0 : 1), "quality rejection releases only a returned preview once");
      rejected.onDestroy();
    }

    for (String directStage : new String[] { "fromBitmap", "getClient", "process" }) {
      for (boolean outOfMemory : new boolean[] { false, true }) {
        Host directOcr = host(root, "direct-ocr-failure-" + directStage + "-" + outOfMemory);
        directOcr.mode = Host.MODE_DOCUMENT; directOcr.kind = "id-card"; directOcr.step = Host.Step.ID_FRONT;
        directOcr.documentCaptureStarted = true;
        File directPhoto = photo(VisionCaptureLifecycle.temporaryCapture(directOcr.sessionDirectory), "direct OCR input");
        Bitmap directBitmap = new Bitmap();
        Throwable injected = outOfMemory ? new OutOfMemoryError("injected direct OCR") : new IllegalStateException("injected direct OCR");
        if ("fromBitmap".equals(directStage)) InputImage.bitmapFailure = injected;
        else if ("getClient".equals(directStage)) { directOcr.textRecognizer = null; TextRecognition.clientFailure = injected; }
        else directOcr.textRecognizer.processFailure = injected;
        directOcr.validateIdentityCardSide(directPhoto, directBitmap, Host.Step.ID_FRONT); Ui.drain();
        check(directBitmap.releases == 1 && !directPhoto.exists(), "OCR validation owns synchronous setup cleanup even without an enclosing confirmation caller");
        check(!directOcr.documentCaptureStarted && !new File(directOcr.sessionDirectory, "id-front.jpg").exists(),
          "synchronous OCR setup failure restores capture without promoting the failed input");
        directOcr.onDestroy();
      }
    }

    Host bankPreview = host(root, "bank-preview-ownership"); bankPreview.mode = Host.MODE_DOCUMENT;
    bankPreview.kind = "bank-card"; bankPreview.step = Host.Step.BANK_FRONT; bankPreview.documentCaptureStarted = true;
    File bankPhoto = photo(VisionCaptureLifecycle.temporaryCapture(bankPreview.sessionDirectory), "accepted bank input");
    bankPreview.confirmCapturedDocument(bankPhoto);
    check(bankPreview.decodedPreview.releases == 1 && bankPreview.decodedPreview.pixelReads > 0
      && bankPreview.textRecognizer.processes == 0 && new File(bankPreview.sessionDirectory, "bank-card-front.jpg").isFile()
      && !bankPhoto.exists(), "bank confirmation releases quality preview once while accepting the original photo without OCR");
    bankPreview.onDestroy();

    for (boolean completedBeforeRegistration : new boolean[] { false, true }) {
      for (int ocrOutcome = 0; ocrOutcome < 3; ocrOutcome++) {
        Host activeOcr = host(root, "current-ocr-ownership-" + completedBeforeRegistration + "-" + ocrOutcome);
        activeOcr.mode = Host.MODE_DOCUMENT; activeOcr.kind = "id-card"; activeOcr.step = Host.Step.ID_FRONT;
        activeOcr.documentCaptureStarted = true; activeOcr.documentStableFrames = 17; activeOcr.documentStableSince = 789L;
        File activePhoto = photo(VisionCaptureLifecycle.temporaryCapture(activeOcr.sessionDirectory), "current OCR photo");
        Bitmap ownedPreview = activeOcr.decodedPreview;
        if (completedBeforeRegistration) activeOcr.textRecognizer.task.finish(new Text(), ocrOutcome == 1 ? new Exception("OCR failed") : null, ocrOutcome == 2);
        activeOcr.confirmCapturedDocument(activePhoto);
        check(activeOcr.textRecognizer.processes == 1 && activeOcr.textRecognizer.receivedBitmap == ownedPreview
          && ownedPreview.pixelReads > 0, "document confirmation transfers its quality-checked preview to the real OCR validation method");
        if (!completedBeforeRegistration) {
          check(ownedPreview.releases == 0 && activePhoto.isFile() && activeOcr.documentCaptureStarted, "asynchronous OCR owns its preview until task completion without early recycle or promotion");
          activeOcr.textRecognizer.task.finish(new Text(), ocrOutcome == 1 ? new Exception("OCR failed") : null, ocrOutcome == 2);
        }
        check(ownedPreview.releases == 1 && activeOcr.documentCaptureStarted, "OCR resource completion releases bitmap before queued UI outcomes change the capture gate");
        Ui.drain();
        check(ownedPreview.releases == 1 && !activePhoto.exists(), "OCR success, failure and cancellation consume the preview and temporary photo exactly once");
        if (ocrOutcome == 0) {
          check(new File(activeOcr.sessionDirectory, "id-front.jpg").isFile() && activeOcr.captureHandler.pending.size() == 1,
            "successful current OCR promotes only its input and schedules one next step");
        } else {
          check(!activeOcr.documentCaptureStarted && activeOcr.documentStableFrames == 0 && activeOcr.documentStableSince == 0L
            && !new File(activeOcr.sessionDirectory, "id-front.jpg").exists() && activeOcr.captureHandler.pending.isEmpty(),
            "current failed or canceled OCR restores automatic capture instead of leaving the gate stuck");
        }
        activeOcr.onDestroy();
      }
    }

    for (String retiredBy : new String[] { "pause", "destroy", "step" }) {
      for (int ocrOutcome = 0; ocrOutcome < 3; ocrOutcome++) {
        Host retiredOcr = host(root, "retired-ocr-" + retiredBy + "-" + ocrOutcome);
        retiredOcr.mode = Host.MODE_DOCUMENT; retiredOcr.kind = "id-card"; retiredOcr.step = Host.Step.ID_FRONT;
        retiredOcr.documentCaptureStarted = true;
        File retiredPhoto = photo(VisionCaptureLifecycle.temporaryCapture(retiredOcr.sessionDirectory), "retired OCR photo");
        retiredOcr.confirmCapturedDocument(retiredPhoto);
        if ("pause".equals(retiredBy)) retiredOcr.onPause();
        else if ("destroy".equals(retiredBy)) retiredOcr.onDestroy();
        else retiredOcr.captureLifecycle.nextStep();
        File acceptedByNewOwner = photo(new File(retiredOcr.sessionDirectory, "id-front.jpg"), "new owner checkpoint");
        int retiredStatusWrites = retiredOcr.statusView.writes, retiredOverlayWrites = retiredOcr.scanOverlay.writes;
        retiredOcr.textRecognizer.task.finish(new Text(), ocrOutcome == 1 ? new Exception("late OCR failed") : null, ocrOutcome == 2);
        Ui.drain();
        check(retiredOcr.decodedPreview.releases == 1 && !retiredPhoto.exists()
          && "new owner checkpoint".equals(Files.readString(acceptedByNewOwner.toPath())), "retired OCR completion releases only its own bitmap and temporary photo");
        check(retiredOcr.statusView.writes == retiredStatusWrites && retiredOcr.scanOverlay.writes == retiredOverlayWrites
          && retiredOcr.documentCaptureStarted && retiredOcr.captureHandler.pending.isEmpty(), "retired OCR success, failure or cancellation cannot reset a newer gate or write stale UI");
        retiredOcr.onDestroy();
      }
    }

    Host noTask = host(root, "ocr-null-task"); noTask.mode = Host.MODE_DOCUMENT;
    noTask.kind = "id-card"; noTask.step = Host.Step.ID_FRONT; noTask.documentCaptureStarted = true;
    noTask.textRecognizer.nullTask = true;
    File noTaskPhoto = photo(VisionCaptureLifecycle.temporaryCapture(noTask.sessionDirectory), "no recognition task");
    noTask.confirmCapturedDocument(noTaskPhoto); Ui.drain();
    check(noTask.decodedPreview.releases == 1 && !noTaskPhoto.exists() && !noTask.documentCaptureStarted,
      "null recognition task leaves preview cleanup with the caller and restores retry");
    noTask.onDestroy();

    for (int registration = 1; registration <= 4; registration++) {
      for (boolean retainedBeforeFailure : new boolean[] { false, true }) {
        for (boolean outOfMemory : new boolean[] { false, true }) {
          for (int lateOutcome = 0; lateOutcome < 3; lateOutcome++) {
            String label = registration + "-" + retainedBeforeFailure + "-" + outOfMemory + "-" + lateOutcome;
            Host partialOcr = host(root, "partial-ocr-registration-" + label);
            partialOcr.mode = Host.MODE_DOCUMENT; partialOcr.kind = "id-card"; partialOcr.step = Host.Step.ID_FRONT;
            partialOcr.documentCaptureStarted = true;
            File abandonedPhoto = photo(VisionCaptureLifecycle.temporaryCapture(partialOcr.sessionDirectory), "abandoned OCR input");
            Bitmap stillInUse = partialOcr.decodedPreview;
            TextRecognizer abandonedRecognizer = partialOcr.textRecognizer;
            Task<Text> abandonedTask = abandonedRecognizer.task;
            abandonedTask.failRegistrationAt = registration; abandonedTask.failAfterRegistration = retainedBeforeFailure;
            abandonedTask.registrationFailure = outOfMemory ? new OutOfMemoryError("listener registration failed")
              : new IllegalStateException("listener registration failed");
            partialOcr.confirmCapturedDocument(abandonedPhoto); Ui.drain();
            check(abandonedRecognizer.processes == 1 && abandonedRecognizer.receivedBitmap == stillInUse
              && !abandonedTask.done && stillInUse.releases == 0,
              "listener registration failure never recycles an input still owned by a pending OCR task");
            check(abandonedTask.registrationAttempts == registration
              && abandonedTask.registeredCallbacks == registration - (retainedBeforeFailure ? 0 : 1),
              "registration fault lands before or after exactly the selected listener retention");
            check(!abandonedPhoto.exists() && !partialOcr.documentCaptureStarted && partialOcr.fatalMessage == null,
              "partial OCR registration failure discards only its photo and permits a fresh capture retry");

            // Start a real second confirmation in the same generation. This is
            // stricter than destruction: lifecycle/token guards alone cannot
            // prevent abandoned partial listeners from affecting this retry.
            partialOcr.textRecognizer = new TextRecognizer(); partialOcr.decodedPreview = new Bitmap();
            partialOcr.documentCaptureStarted = true;
            File retryPhoto = photo(VisionCaptureLifecycle.temporaryCapture(partialOcr.sessionDirectory), "retry OCR input");
            partialOcr.confirmCapturedDocument(retryPhoto);
            Bitmap retryPreview = partialOcr.decodedPreview;
            int retryStatusWrites = partialOcr.statusView.writes, retryOverlayWrites = partialOcr.scanOverlay.writes;
            abandonedTask.finish(new Text(), lateOutcome == 1 ? new Exception("abandoned OCR failed") : null, lateOutcome == 2);
            Ui.drain();
            boolean cleanupRetained = registration > 1 || retainedBeforeFailure;
            check(stillInUse.releases == (cleanupRetained ? 1 : 0),
              "registered OCR cleanup releases once; never-registered cleanup does not force recycle and remains GC-owned");
            check(partialOcr.documentCaptureStarted && retryPhoto.isFile() && "retry OCR input".equals(Files.readString(retryPhoto.toPath()))
              && retryPreview.releases == 0 && partialOcr.fatalMessage == null && partialOcr.captureHandler.pending.isEmpty()
              && partialOcr.statusView.writes == retryStatusWrites && partialOcr.scanOverlay.writes == retryOverlayWrites,
              "partial abandoned success, failure and cancellation cannot alter the fresh retry gate, UI or input");
            partialOcr.textRecognizer.task.finish(new Text(), null, false); Ui.drain();
            check(retryPreview.releases == 1 && !retryPhoto.exists()
              && "retry OCR input".equals(Files.readString(new File(partialOcr.sessionDirectory, "id-front.jpg").toPath()))
              && partialOcr.captureHandler.pending.size() == 1,
              "fresh OCR retry remains able to confirm its own photo after partial old listeners settle");
            // No System.gc() or collection claim: the no-cleanup-listener branch
            // intentionally leaves native input ownership to normal reachability.
            abandonedRecognizer.close(); partialOcr.onDestroy();
          }
        }
      }
    }

    for (String beforeTransfer : new String[] { "decode", "quality" }) {
      for (boolean outOfMemory : new boolean[] { false, true }) {
        Host stalePreview = host(root, "retired-preview-failure-" + beforeTransfer + "-" + outOfMemory);
        stalePreview.mode = Host.MODE_DOCUMENT; stalePreview.kind = "id-card"; stalePreview.step = Host.Step.ID_FRONT;
        stalePreview.documentCaptureStarted = true;
        Throwable injected = outOfMemory ? new OutOfMemoryError("stale preview") : new IllegalStateException("stale preview");
        if ("decode".equals(beforeTransfer)) {
          stalePreview.beforeDecode = () -> stalePreview.captureLifecycle.nextStep(); stalePreview.decodeFailure = injected;
        } else {
          stalePreview.decodedPreview.beforePixelRead = () -> stalePreview.captureLifecycle.nextStep(); stalePreview.decodedPreview.pixelFailure = injected;
        }
        File stalePreviewPhoto = photo(VisionCaptureLifecycle.temporaryCapture(stalePreview.sessionDirectory), "stale preview photo");
        int previewStatusWrites = stalePreview.statusView.writes, previewOverlayWrites = stalePreview.scanOverlay.writes;
        stalePreview.confirmCapturedDocument(stalePreviewPhoto); Ui.drain();
        check(!stalePreviewPhoto.exists() && stalePreview.decodedPreview.releases == ("decode".equals(beforeTransfer) ? 0 : 1),
          "pre-OCR failure after token retirement still releases its local resources");
        check(stalePreview.statusView.writes == previewStatusWrites && stalePreview.scanOverlay.writes == previewOverlayWrites
          && stalePreview.documentCaptureStarted && InputImage.bitmapCalls == 0, "pre-OCR failure cannot use a retired token to retry or update a newer step");
        stalePreview.onDestroy();
      }
    }

    for (boolean retireDuringQuality : new boolean[] { false, true }) {
      Host retiredReady = host(root, "retired-ready-preview-" + retireDuringQuality);
      retiredReady.mode = Host.MODE_DOCUMENT; retiredReady.kind = "id-card"; retiredReady.step = Host.Step.ID_FRONT;
      retiredReady.documentCaptureStarted = true;
      if (retireDuringQuality) retiredReady.decodedPreview.beforePixelRead = () -> retiredReady.captureLifecycle.nextStep();
      else retiredReady.beforeDecode = () -> retiredReady.captureLifecycle.nextStep();
      File retiredReadyPhoto = photo(VisionCaptureLifecycle.temporaryCapture(retiredReady.sessionDirectory), "valid but retired input");
      int readyStatusWrites = retiredReady.statusView.writes, readyOverlayWrites = retiredReady.scanOverlay.writes;
      retiredReady.confirmCapturedDocument(retiredReadyPhoto); Ui.drain();
      check(retiredReady.decodedPreview.releases == 1 && !retiredReadyPhoto.exists() && InputImage.bitmapCalls == 0,
        "confirmation rechecks token after successful decoding and quality before handing preview to OCR");
      check(retiredReady.documentCaptureStarted && retiredReady.statusView.writes == readyStatusWrites
        && retiredReady.scanOverlay.writes == readyOverlayWrites, "successfully decoded stale preview cannot touch the newer capture state");
      retiredReady.onDestroy();
    }

    Host backgroundPreview = host(root, "background-preview-entry"); backgroundPreview.mode = Host.MODE_DOCUMENT;
    backgroundPreview.kind = "id-card"; backgroundPreview.step = Host.Step.ID_FRONT; backgroundPreview.documentCaptureStarted = true;
    File backgroundPhoto = photo(VisionCaptureLifecycle.temporaryCapture(backgroundPreview.sessionDirectory), "background callback input");
    backgroundPreview.onPause(); int backgroundStatusWrites = backgroundPreview.statusView.writes;
    backgroundPreview.confirmCapturedDocument(backgroundPhoto);
    check(!backgroundPhoto.exists() && backgroundPreview.previewDecodes == 0 && InputImage.bitmapCalls == 0,
      "background confirmation rejects its temporary photo before bitmap decoding or OCR");
    check(backgroundPreview.documentCaptureStarted && backgroundPreview.statusView.writes == backgroundStatusWrites,
      "background confirmation cleanup does not reset capture state or write UI");
    backgroundPreview.onDestroy();

    Host completion = host(root, "complete-window"); photo(new File(completion.sessionDirectory, "face-verification.jpg"), "accepted face");
    int discardedBefore = VisionExplorationStore.discarded; Bundle saved = new Bundle();
    completion.onSaveInstanceState(saved); completion.finishFaceSession(new File(completion.sessionDirectory, "face-verification.jpg"));
    check(completion.captureLifecycle.isCompleted() && !completion.terminalResult, "disk completion protected before 1250ms result delay");
    Runnable delayedResult = completion.captureHandler.pending.get(0); completion.onDestroy(); delayedResult.run();
    check(VisionExplorationStore.discarded == discardedBefore && completion.result == -1, "destroy preserves completed session and invalidates old result");
    Host restored = new Host(); restored.sessionDirectory = null; restored.kind = saved.getString(Host.STATE_KIND, ""); restored.faceChallenge = saved.getString(Host.STATE_CHALLENGE, "");
    restored.launchIntent.putExtra(Host.EXTRA_SESSION_ID, "stale-launch-id");
    restored.restoreRequestedSession(saved);
    check(saved.getString(Host.STATE_SESSION, "").equals(VisionExplorationStore.lastResolvedId), "saved session takes precedence over original launch id");
    check(restored.captureLifecycle.isCompleted() && restored.starts == 0, "manifest completion wins over earlier Bundle snapshot");
    restored.finishCanceled();
    check(restored.result == Activity.RESULT_OK && VisionExplorationStore.discarded == discardedBefore, "close after completion returns success without deleting");
    check(restored.data.getBooleanExtra(Host.RESULT_PRESERVED, false) && !restored.data.getBooleanExtra(Host.RESULT_DISCARDED, true), "completed success truthfully reports retained files");
    restored.captureHandler.drain(); check(restored.finishCalls == 1, "completion delivered once"); restored.onDestroy();

    Host pending = host(root, "pending-restore"); pending.mode = "document"; pending.kind = "id-card"; pending.step = Host.Step.ID_FRONT;
    File front = photo(VisionCaptureLifecycle.temporaryCapture(pending.sessionDirectory), "accepted front"); pending.acceptCapturedDocument(front);
    Bundle checkpoint = new Bundle(); pending.onSaveInstanceState(checkpoint); pending.onDestroy();
    check(VisionExplorationStore.discarded == discardedBefore, "destroy does not discard incomplete workflow");
    Host resumed = new Host(); resumed.mode = "document"; resumed.kind = checkpoint.getString(Host.STATE_KIND, "");
    resumed.restoreCaptureSession(checkpoint.getString(Host.STATE_SESSION, ""));
    check(resumed.step == Host.Step.ID_BACK && resumed.starts == 1, "recreation resumes confirmed portrait instead of restarting");
    resumed.finishCanceled(); resumed.finishCanceled(); resumed.onDestroy();
    check(VisionExplorationStore.discarded == discardedBefore + 1 && resumed.result == Activity.RESULT_CANCELED, "only explicit pending cancellation discards once");
    check(resumed.data.getBooleanExtra(Host.RESULT_DISCARDED, false) && !resumed.data.getBooleanExtra(Host.RESULT_PRESERVED, true) && !resumed.sessionDirectory.exists(), "explicit cancel reports discarded only after directory actually disappears");

    for (boolean restoring : new boolean[] { true, false }) {
      Host errorHost = host(root, restoring ? "restore-rename-error" : "manifest-commit-error");
      File retainedPhoto = photo(new File(errorHost.sessionDirectory, "face-verification.jpg"), "confirmed face photo");
      File retainedManifest = photo(new File(errorHost.sessionDirectory, ".manifest.json.tmp"), "recoverable complete manifest");
      int beforeError = VisionExplorationStore.discarded; long errorToken = errorHost.captureLifecycle.generation();
      AtomicInteger lateUi = new AtomicInteger(); errorHost.postCaptureDelayed(errorToken, lateUi::incrementAndGet, 900);
      Runnable lateCallback = errorHost.captureHandler.pending.get(0);
      if (restoring) {
        VisionExplorationStore.restoreError = new IOException("Os.rename recovery failed");
        errorHost.restoreCaptureSession(errorHost.sessionDirectory.getName());
      } else {
        VisionExplorationStore.commitError = new IOException("manifest commit failed");
        errorHost.finishFaceSession(retainedPhoto);
      }
      Ui.drain();
      check("关闭".equals(errorHost.captureDialog.positiveLabel), "real fatal dialog exposes the close action");
      errorHost.captureDialog.positive.onClick(errorHost.captureDialog, 0); errorHost.finishAfterError();
      lateCallback.run(); errorHost.onDestroy();
      check(errorHost.result == Activity.RESULT_CANCELED && errorHost.finishCalls == 1, "error close terminates once without false success");
      check(errorHost.data.getBooleanExtra(Host.RESULT_PRESERVED, false) && !errorHost.data.getBooleanExtra(Host.RESULT_DISCARDED, true), "error exit reports preserved rather than discarded");
      check(VisionExplorationStore.discarded == beforeError && retainedPhoto.isFile() && retainedManifest.isFile(), "error close preserves confirmed photos and recoverable manifest temporary");
      check(lateUi.get() == 0 && errorHost.captureHandler.pending.isEmpty(), "error close invalidates pending UI callbacks");
    }
    Host completedError = host(root, "error-after-complete");
    photo(new File(completedError.sessionDirectory, "face-verification.jpg"), "completed face");
    completedError.finishFaceSession(new File(completedError.sessionDirectory, "face-verification.jpg"));
    int beforeCompletedClose = VisionExplorationStore.discarded;
    completedError.showFatal("later UI error"); Ui.drain();
    completedError.captureDialog.positive.onClick(completedError.captureDialog, 0);
    check(completedError.result == Activity.RESULT_OK && VisionExplorationStore.discarded == beforeCompletedClose, "error close after confirmed completion still returns success");
    completedError.onDestroy();

    Host fresh = host(root, "fresh-explicit-resume");
    File freshDirectory = fresh.sessionDirectory;
    File freshFront = photo(new File(freshDirectory, "id-front.jpg"), "confirmed portrait checkpoint");
    VisionExplorationStore.pendingManifest = checkpoint("id-card", "", "ID_BACK");
    fresh.sessionDirectory = null;
    fresh.launchIntent.putExtra(Host.EXTRA_SESSION_ID, freshDirectory.getName());
    check(fresh.restoreRequestedSession(null), "fresh launch with explicit session id takes restoration path");
    check("id-card".equals(fresh.kind) && Host.MODE_DOCUMENT.equals(fresh.mode) && fresh.faceChallenge.isEmpty(), "validated manifest overrides stale initial kind, mode and challenge");
    check(fresh.step == Host.Step.ID_BACK && fresh.starts == 1 && freshFront.isFile() && !new File(freshDirectory, "id-back.jpg").exists(), "fresh resume starts only the missing confirmed step without modifying photos");
    int beforePreserve = VisionExplorationStore.discarded; long preserveToken = fresh.captureLifecycle.generation();
    AtomicInteger afterPreserve = new AtomicInteger(); fresh.postCaptureUi(preserveToken, afterPreserve::incrementAndGet);
    fresh.confirmExit(); check("保留并退出".equals(fresh.captureDialog.neutralLabel), "exit dialog offers explicit preserve option");
    fresh.captureDialog.neutral.onClick(fresh.captureDialog, 0); Ui.drain(); fresh.finishCanceled();
    check(fresh.result == Activity.RESULT_CANCELED && fresh.finishCalls == 1 && afterPreserve.get() == 0, "preserve exit terminates once and invalidates prior callbacks");
    check(fresh.data.getBooleanExtra(Host.RESULT_PRESERVED, false) && !fresh.data.getBooleanExtra(Host.RESULT_DISCARDED, true) && freshDirectory.getName().equals(fresh.data.getStringExtra(Host.RESULT_SESSION_ID)), "preserve exit returns retained session identity");
    check(VisionExplorationStore.discarded == beforePreserve && freshFront.isFile(), "preserve exit never calls delete"); fresh.onDestroy();

    Host checkpointComplete = host(root, "fresh-complete-checkpoint");
    photo(new File(checkpointComplete.sessionDirectory, "bank-card-front.jpg"), "accepted bank card");
    VisionExplorationStore.pendingManifest = checkpoint("bank-card", "", "COMPLETE");
    checkpointComplete.launchIntent.putExtra(Host.EXTRA_SESSION_ID, checkpointComplete.sessionDirectory.getName());
    checkpointComplete.restoreRequestedSession(null);
    check(checkpointComplete.captureLifecycle.isCompleted() && checkpointComplete.starts == 0, "fully confirmed capturing checkpoint completes without reopening camera");
    checkpointComplete.captureHandler.drain(); checkpointComplete.finishCanceled();
    check(checkpointComplete.result == Activity.RESULT_OK && checkpointComplete.finishCalls == 1 && checkpointComplete.data.getIntExtra(Host.RESULT_FILE_COUNT, 0) == 1, "fresh complete checkpoint delivers success exactly once");
    checkpointComplete.onDestroy();

    Host corrupt = host(root, "corrupt-resume");
    File corruptPhoto = photo(new File(corrupt.sessionDirectory, "face-verification.jpg"), "photo without trusted action metadata");
    File corruptTemporary = photo(new File(corrupt.sessionDirectory, ".capture-00000000-0000-0000-0000-000000000000-22222222-2222-2222-2222-222222222222.jpg"), "unvalidated session temporary");
    VisionExplorationStore.recoverableError = new IOException("final face exists without valid challenge");
    corrupt.launchIntent.putExtra(Host.EXTRA_SESSION_ID, corrupt.sessionDirectory.getName());
    corrupt.restoreRequestedSession(null); Ui.drain();
    check(corrupt.starts == 0 && !corrupt.captureLifecycle.isCompleted() && corruptTemporary.isFile(), "corrupt checkpoint is rejected before camera start or temporary cleanup");
    corrupt.captureDialog.positive.onClick(corrupt.captureDialog, 0);
    check(corruptPhoto.isFile() && corrupt.data.getBooleanExtra(Host.RESULT_PRESERVED, false) && !corrupt.data.getBooleanExtra(Host.RESULT_DISCARDED, true), "corrupt checkpoint error close preserves recoverable material"); corrupt.onDestroy();

    for (boolean existingChallenge : new boolean[] { false, true }) {
      Host faceResume = host(root, existingChallenge ? "resume-saved-face-action" : "resume-new-face-action");
      faceResume.faceChallenge = "stale Bundle challenge";
      VisionExplorationStore.pendingManifest = checkpoint("face-verification", existingChallenge ? "缓慢转头" : "", "FACE");
      faceResume.launchIntent.putExtra(Host.EXTRA_SESSION_ID, faceResume.sessionDirectory.getName());
      int beforeSave = VisionExplorationStore.challengeSaves;
      faceResume.restoreRequestedSession(null);
      check(faceResume.starts == 1 && faceResume.step == Host.Step.FACE && VisionExplorationStore.challengeSaves == beforeSave + 1, "face resume persists its challenge before camera binding");
      check(faceResume.faceChallenge.equals(VisionExplorationStore.savedChallenge) && ("微笑一下".equals(faceResume.faceChallenge) || "缓慢转头".equals(faceResume.faceChallenge)), "face action shown to user matches persisted valid action");
      if (existingChallenge) check("缓慢转头".equals(faceResume.faceChallenge) && faceResume.faceChallengeTurn, "restored action is not randomized or replaced from Bundle");
      faceResume.finishAfterError(); faceResume.onDestroy();
    }
    Host actionError = host(root, "face-action-write-error");
    File actionManifest = photo(new File(actionError.sessionDirectory, "manifest.json"), "original pending manifest");
    actionError.faceChallenge = ""; VisionExplorationStore.challengeError = new IOException("atomic challenge write failed");
    actionError.beginStep(Host.Step.FACE); Ui.drain();
    check(actionError.starts == 0 && !actionError.captureLifecycle.isCompleted(), "failed challenge persistence prevents face camera start");
    actionError.captureDialog.positive.onClick(actionError.captureDialog, 0);
    check(actionManifest.isFile() && actionError.data.getBooleanExtra(Host.RESULT_PRESERVED, false), "challenge persistence error close preserves original pending record"); actionError.onDestroy();

    for (int deletion = 0; deletion < 3; deletion++) {
      Host deleteFailure = host(root, "delete-failure-" + deletion);
      File remaining = photo(new File(deleteFailure.sessionDirectory, "id-front.jpg"), "retained after delete failure");
      if (deletion == 0) VisionExplorationStore.deleteResult = false;
      else if (deletion == 1) VisionExplorationStore.retainAfterDelete = true;
      else VisionExplorationStore.deleteError = new IOException("delete blocked");
      int beforeDelete = VisionExplorationStore.discarded;
      deleteFailure.confirmExit(); deleteFailure.captureDialog.positive.onClick(deleteFailure.captureDialog, 0); deleteFailure.finishCanceled();
      check(deleteFailure.result == Activity.RESULT_CANCELED && deleteFailure.finishCalls == 1 && VisionExplorationStore.discarded == beforeDelete + 1, "explicit delete failure exits once without retrying destructive action");
      check(remaining.isFile() && deleteFailure.data.getBooleanExtra(Host.RESULT_PRESERVED, false) && !deleteFailure.data.getBooleanExtra(Host.RESULT_DISCARDED, true), "false return, dishonest success, or thrown delete never reports removed residual files");
      deleteFailure.onDestroy();
    }
    Host noSession = new Host(); int beforeEmptyDelete = VisionExplorationStore.discarded;
    noSession.confirmExit();
    check(noSession.data != null && !noSession.data.getBooleanExtra(Host.RESULT_PRESERVED, true) && !noSession.data.getBooleanExtra(Host.RESULT_DISCARDED, true), "cancel without a session still carries explicit false outcome flags");
    check(noSession.data.getStringExtra(Host.RESULT_SESSION_ID) == null && VisionExplorationStore.discarded == beforeEmptyDelete, "no-session cancel invents neither identity nor deletion"); noSession.onDestroy();

    Host pluginFixture = host(root, "plugin-fixture"); PluginHost plugin = new PluginHost();
    for (String resumeKind : new String[] { "face-verification", "id-card", "bank-card" }) {
      VisionExplorationStore.pendingManifest = checkpoint(resumeKind, "微笑一下", "FACE");
      PluginCall call = new PluginCall(pluginFixture.sessionDirectory.getName()); plugin.resumeSession(call);
      String expectedMode = "face-verification".equals(resumeKind) ? Host.MODE_FACE : Host.MODE_DOCUMENT;
      check(call.rejected == null && expectedMode.equals(plugin.launched.getStringExtra(Host.EXTRA_MODE)) && call.id.equals(plugin.launched.getStringExtra(Host.EXTRA_SESSION_ID)) && "visionExplorationResult".equals(plugin.callback), "plugin validates and routes pending record kind through shared capture result callback");
    }
    int launchedBeforeFailure = plugin.launches; VisionExplorationStore.recoverableError = new IOException("manifest is corrupt");
    PluginCall corruptCall = new PluginCall("corrupt-id"); plugin.resumeSession(corruptCall);
    check(corruptCall.rejected != null && plugin.launches == launchedBeforeFailure, "plugin rejects invalid recovery without opening Activity"); VisionExplorationStore.recoverableError = null;
    VisionExplorationStore.manifest = new JSONObject(); PluginCall completeCall = new PluginCall("completed-id"); plugin.resumeSession(completeCall);
    check(completeCall.rejected != null && plugin.launches == launchedBeforeFailure, "plugin refuses completed records in explicit pending resume entry");
    VisionExplorationStore.manifest = null; VisionExplorationStore.listError = new IOException("unreadable storage root");
    PluginCall listCall = new PluginCall(null); plugin.listSessions(listCall);
    check(listCall.rejected != null && listCall.result == null, "plugin exposes unreadable record root as error rather than empty history");
    plugin.detached = true; PluginCall detachedCall = new PluginCall(null); plugin.open(detachedCall, Host.MODE_DOCUMENT);
    check(detachedCall.rejected != null && plugin.launches == launchedBeforeFailure, "detached capture launch rejects even when Intent construction fails");
    PluginCall cancelResult = new PluginCall(null); plugin.visionExplorationResult(cancelResult, new ActivityResult(Activity.RESULT_CANCELED, fresh.data));
    check(Boolean.TRUE.equals(cancelResult.result.get("canceled")) && Boolean.TRUE.equals(cancelResult.result.get("preserved")) && Boolean.FALSE.equals(cancelResult.result.get("discarded")) && freshDirectory.getName().equals(cancelResult.result.get("sessionId")), "plugin retains canceled session identity and truthful preservation flags");
    PluginCall deletedResult = new PluginCall(null); plugin.visionExplorationResult(deletedResult, new ActivityResult(Activity.RESULT_CANCELED, resumed.data));
    check(Boolean.TRUE.equals(deletedResult.result.get("discarded")) && Boolean.FALSE.equals(deletedResult.result.get("preserved")), "plugin propagates confirmed deletion flags");
    PluginCall successResult = new PluginCall(null); plugin.visionExplorationResult(successResult, new ActivityResult(Activity.RESULT_OK, restored.data));
    check(Boolean.FALSE.equals(successResult.result.get("canceled")) && Boolean.TRUE.equals(successResult.result.get("preserved")) && Integer.valueOf(1).equals(successResult.result.get("fileCount")) && "face-verification".equals(successResult.result.get("kind")), "plugin preserves successful completion metadata alongside flags");
    PluginCall missingResult = new PluginCall(null); plugin.visionExplorationResult(missingResult, null);
    check(Boolean.TRUE.equals(missingResult.result.get("canceled")) && Boolean.FALSE.equals(missingResult.result.get("preserved")) && Boolean.FALSE.equals(missingResult.result.get("discarded")) && !missingResult.result.containsKey("sessionId"), "missing native result does not invent saved or deleted files"); pluginFixture.onDestroy();

    Host tokenHost = host(root, "step-token"); AtomicInteger ui = new AtomicInteger(); long token = tokenHost.captureLifecycle.generation();
    tokenHost.postCaptureUi(token, ui::incrementAndGet); tokenHost.postCaptureDelayed(token, ui::incrementAndGet, 900);
    tokenHost.captureLifecycle.nextStep(); Ui.drain(); tokenHost.captureHandler.drain();
    check(ui.get() == 0, "old step UI callbacks are ignored by a live replacement step"); tokenHost.onDestroy();
    AtomicInteger closed = new AtomicInteger(); Runnable once = VisionCaptureLifecycle.releaseOnce(closed::incrementAndGet);
    once.run(); once.run(); check(closed.get() == 1, "release helper is idempotent");
    File alive = photo(VisionCaptureLifecycle.temporaryCapture(root), "current process pending");
    File dead = photo(new File(root, ".capture-00000000-0000-0000-0000-000000000000-11111111-1111-1111-1111-111111111111.jpg"), "old process pending");
    File unknown = photo(new File(root, ".capture-user-note.jpg"), "unknown file");
    VisionCaptureLifecycle.discardAbandonedCaptures(root);
    check(alive.exists() && unknown.exists() && !dead.exists(), "restoration only cleans strict prior-process temporary photos");
    verifyFaceOwnership(root);
    System.out.println("vision-lifecycle-verification: " + checks + " production state, Activity callback, restoration, and cleanup checks passed");
  }
}
`.replace("  /* PRODUCTION_METHODS */", methods).replace("  /* PLUGIN_METHODS */", pluginMethods);

const actualTasksProbe = String.raw`package local.fanhao.library;
import com.google.android.gms.tasks.CancellationToken;
import com.google.android.gms.tasks.OnTokenCanceledListener;
import com.google.android.gms.tasks.TaskCompletionSource;
import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.*;
public class ActualGoogleTasksVerifier {
  static class Token extends CancellationToken {
    boolean canceled; OnTokenCanceledListener listener;
    public boolean isCancellationRequested() { return canceled; }
    public CancellationToken onCanceledRequested(OnTokenCanceledListener value) { listener = value; return this; }
    void dispatchCancellation() { canceled = true; listener.onCanceled(); }
  }
  static int checks;
  static void check(boolean value, String message) { if (!value) throw new AssertionError(message); checks++; }
  public static void main(String[] args) {
    for (int outcome = 0; outcome < 3; outcome++) {
      ExecutorService analyzer = Executors.newSingleThreadExecutor();
      VisionCaptureLifecycle owner = new VisionCaptureLifecycle(); long generation = owner.generation();
      ArrayList<Runnable> main = new ArrayList<>(); AtomicInteger released = new AtomicInteger(), business = new AtomicInteger();
      AtomicBoolean busy = new AtomicBoolean(true); Runnable release = VisionCaptureLifecycle.releaseOnce(released::incrementAndGet);
      Token cancellation = new Token(); TaskCompletionSource<String> source = new TaskCompletionSource<>(cancellation);
      source.getTask().addOnCompleteListener(VisionCaptureLifecycle.RELEASE_EXECUTOR, task -> release.run())
        .addOnCompleteListener(main::add, task -> {
          try { if (owner.accepts(generation)) business.incrementAndGet(); }
          finally { busy.set(false); }
        });
      owner.destroy(); analyzer.shutdown();
      if (outcome == 0) source.setResult("late success");
      else if (outcome == 1) source.setException(new Exception("late failure"));
      else cancellation.dispatchCancellation();
      check(released.get() == 1, "real task releases frame after analyzer shutdown");
      check(busy.get(), "real task keeps business busy until main completion");
      main.forEach(Runnable::run); release.run();
      check(!busy.get() && released.get() == 1 && business.get() == 0, "real task completion is stale-safe and exactly-once");
      check(source.getTask().isCanceled() == (outcome == 2), "real cancellation branch is exercised");
    }
    ExecutorService closed = Executors.newSingleThreadExecutor(); closed.shutdown();
    TaskCompletionSource<String> oldPattern = new TaskCompletionSource<>();
    oldPattern.getTask().addOnCompleteListener(closed, task -> {});
    boolean rejected = false;
    try { oldPattern.setResult("old callback pattern"); } catch (RejectedExecutionException expected) { rejected = true; }
    check(rejected, "negative control: actual Google Tasks rejects callbacks on a closed executor");
    System.out.println("vision-google-tasks-verification: " + checks + " actual dependency success/failure/cancellation and rejection checks passed");
  }
}
`;

try {
  const verifierPath = path.join(temporary, "VisionLifecycleVerifier.java");
  fs.writeFileSync(verifierPath, harness);
  const compile = spawnSync(executable("javac"), ["-encoding", "UTF-8", "-d", temporary,
    path.join(nativeRoot, "VisionCaptureLifecycle.java"), verifierPath], { encoding: "utf8", timeout: 30000 });
  assert.equal(compile.status, 0, compile.error?.message || `${compile.stdout}\n${compile.stderr}`);
  const run = spawnSync(executable("java"), ["-cp", temporary, "local.fanhao.library.VisionLifecycleVerifier", temporary],
    { encoding: "utf8", timeout: 15000 });
  assert.equal(run.status, 0, run.error?.message || `${run.stdout}\n${run.stderr}`);
  process.stdout.write(run.stdout);
  if (observeFaceOwnership) {
    const oldDirectory = path.join(temporary, "face-before-ownership"); fs.mkdirSync(oldDirectory);
    const oldPath = path.join(oldDirectory, "VisionLifecycleVerifier.java");
    fs.writeFileSync(oldPath, harness.replace(productionMethod(activity, "analyzeFace").replace(/^  private /, "  final "), faceBeforeOwnership));
    const oldCompile = spawnSync(executable("javac"), ["-encoding", "UTF-8", "-d", oldDirectory,
      path.join(nativeRoot, "VisionCaptureLifecycle.java"), oldPath], { encoding: "utf8", timeout: 30000 });
    assert.equal(oldCompile.status, 0, oldCompile.error?.message || `${oldCompile.stdout}\n${oldCompile.stderr}`);
    process.stdout.write("face-ownership-probe: executing frozen pre-ownership method only\n");
    const observed = spawnSync(executable("java"), ["-cp", oldDirectory, "local.fanhao.library.VisionLifecycleVerifier", oldDirectory, "face-ownership-probe"],
      { encoding: "utf8", timeout: 15000 });
    assert.equal(observed.status, 0, observed.error?.message || `${observed.stdout}\n${observed.stderr}`);
    process.stdout.write(observed.stdout);
  }

  // Keep executable negative controls for the original two Activity regressions,
  // plus camera withdrawal and the new capture/review lifecycle handoff.
  // These are Activity-source mutations only; the production helper stays intact.
  const cancelCompletion = `      .addOnCompleteListener(ContextCompat.getMainExecutor(this), task -> {
        if (resultAllowed.get() && task.isCanceled() && step == expectedStep && canUseUi(token) && captureLifecycle.canCapture(token)) {
          retryDocumentAutomatically(file, "面别识别已取消，正在自动重试");
        }
      })`;
  const faceMethod = productionMethod(activity, "analyzeFace").replace(/^  private /, "  final ");
  const resetTrackingMethod = productionMethod(activity, "resetFaceTracking").replace(/^  private /, "  final ");
  const regressionMutants = [
    ["exit-without-suspension", "    suspendCapture(VisionCaptureLifecycle.EXIT_CONFIRMATION);", "",
      /exit confirmation blocks in-flight face result/],
    ["background-without-suspension", "    suspendCapture(VisionCaptureLifecycle.BACKGROUND);", "",
      /onPause blocks in-flight face result/],
    ["suspension-without-camera-withdrawal",
      "  final void suspendCapture(int reason) {\n    captureLifecycle.suspend(reason);\n    captureHandler.removeCallbacksAndMessages(null);\n    unbindCamera();\n  }",
      "  final void suspendCapture(int reason) {\n    captureLifecycle.suspend(reason);\n    captureHandler.removeCallbacksAndMessages(null);\n  }",
      /pause and exit confirmation both withdraw owned camera use cases/],
    ["disconnected-review-initialization", "    initializeReviewState(savedInstanceState);", "",
      /capture initialization also initializes review identity/],
    ["disconnected-review-save", "    saveReviewState(outState);", "",
      /Activity save preserves review identity/],
    ["capture-routed-to-review-ui", "    if (MODE_REVIEW.equals(mode)) presentReviewDialog();\n    else resumeForegroundCapture();",
      "    presentReviewDialog();\n    resumeForegroundCapture();",
      /capture resume never routes through the review dialog boundary/],
    ["review-eligibility-without-mode", "return MODE_REVIEW.equals(mode) && canUseUi(captureLifecycle.generation());",
      "return canUseUi(captureLifecycle.generation());",
      /capture mode cannot become eligible for review UI or actions/],
    ["review-finish-without-mode",
      "    if (!canControlCapture() || !MODE_REVIEW.equals(mode)\n      || captureLifecycle.isSuspended(VisionCaptureLifecycle.BACKGROUND)) return;",
      "    if (!canControlCapture() || captureLifecycle.isSuspended(VisionCaptureLifecycle.BACKGROUND)) return;",
      /review finish cannot terminate a capture-mode activity/],
    ["review-finish-while-background",
      "    if (!canControlCapture() || !MODE_REVIEW.equals(mode)\n      || captureLifecycle.isSuspended(VisionCaptureLifecycle.BACKGROUND)) return;",
      "    if (!canControlCapture() || !MODE_REVIEW.equals(mode)) return;",
      /review finish cannot deliver before its Activity becomes foreground/],
    ["disconnected-review-pause-update", "    dismissCaptureDialog();\n    updateReviewActions();\n    super.onPause();",
      "    dismissCaptureDialog();\n    super.onPause();",
      /review pause dismisses the old window and updates buttons after suspension/],
    ["preview-without-finally-cleanup", "      if (preview != null) preview.recycle();", "",
      /preview ownership is released exactly once after quality or OCR setup failure/],
    ["confirmation-retains-ocr-ownership", "        preview = null;\n        return;", "        return;",
      /bitmap recycled twice/],
    ["confirmation-does-not-handle-memory-failure", "catch (RuntimeException | OutOfMemoryError invalidPreview)", "catch (RuntimeException invalidPreview)",
      /OutOfMemoryError: injected decode/],
    ["ocr-does-not-handle-memory-failure", "catch (Exception | OutOfMemoryError error) {\n      resultAllowed.set(false);",
      "catch (Exception error) {\n      resultAllowed.set(false);",
      /OutOfMemoryError: injected direct OCR/],
    ["canceled-ocr-never-retries", cancelCompletion, "",
      /current failed or canceled OCR restores automatic capture/],
    ["canceled-ocr-retries-off-main", cancelCompletion,
      cancelCompletion.replace("ContextCompat.getMainExecutor(this)", "VisionCaptureLifecycle.RELEASE_EXECUTOR"),
      /OCR resource completion releases bitmap before queued UI outcomes change the capture gate/],
    ["canceled-ocr-ignores-retired-token", cancelCompletion,
      cancelCompletion.replace("task.isCanceled() && step == expectedStep && canUseUi(token) && captureLifecycle.canCapture(token)", "task.isCanceled()"),
      /retired OCR success, failure or cancellation cannot reset a newer gate or write stale UI/],
    ["preview-failure-ignores-retired-token",
      "    } catch (RuntimeException | OutOfMemoryError invalidPreview) {\n      if (canUseUi(token) && captureLifecycle.canCapture(token)) {",
      "    } catch (RuntimeException | OutOfMemoryError invalidPreview) {\n      if (true) {",
      /pre-OCR failure cannot use a retired token to retry or update a newer step/],
    ["preview-handoff-skips-token-recheck",
      "      String quality = assessImageQuality(preview);\n      if (!canUseUi(token) || !captureLifecycle.canCapture(token)) {\n        VisionCaptureLifecycle.discardTemporary(file);\n        return;\n      }",
      "      String quality = assessImageQuality(preview);",
      /confirmation rechecks token after successful decoding and quality before handing preview to OCR/],
    ["ocr-completion-does-not-release-preview",
      "      recognition.addOnCompleteListener(VisionCaptureLifecycle.RELEASE_EXECUTOR, task -> {\n        releasePreview.run();",
      "      recognition.addOnCompleteListener(VisionCaptureLifecycle.RELEASE_EXECUTOR, task -> {",
      /late OCR cleans bitmap and its own photo/],
    ["partial-registration-recycles-pending-input", "if (!recognitionOwnsPreview) releasePreview.run();", "releasePreview.run();",
      /listener registration failure never recycles an input still owned by a pending OCR task/],
    ["partial-registration-keeps-business-results", "      resultAllowed.set(false);", "",
      /partial abandoned success, failure and cancellation cannot alter the fresh retry gate/],
    ["partial-registration-success-ignores-suppression", "if (!resultAllowed.get() || step != expectedStep || !canUseUi(token))",
      "if (step != expectedStep || !canUseUi(token))",
      /partial abandoned success, failure and cancellation cannot alter the fresh retry gate/],
    ["partial-registration-failure-ignores-suppression", "if (resultAllowed.get() && step == expectedStep && canUseUi(token))",
      "if (step == expectedStep && canUseUi(token))",
      /partial abandoned success, failure and cancellation cannot alter the fresh retry gate/],
    ["partial-registration-cancellation-ignores-suppression", cancelCompletion,
      cancelCompletion.replace("resultAllowed.get() && task.isCanceled()", "task.isCanceled()"),
      /partial abandoned success, failure and cancellation cannot alter the fresh retry gate/],
    ["partial-registration-suppresses-resource-cleanup",
      "      recognition.addOnCompleteListener(VisionCaptureLifecycle.RELEASE_EXECUTOR, task -> {\n        releasePreview.run();",
      "      recognition.addOnCompleteListener(VisionCaptureLifecycle.RELEASE_EXECUTOR, task -> {\n        if (resultAllowed.get()) releasePreview.run();",
      /registered OCR cleanup releases once; never-registered cleanup does not force recycle/],
    ["face-partial-setup-does-not-wait", "      if (detection != null) awaitFaceTaskCompletion(detection);", "",
      /partial face registration must reach worker-owned completion waiting/],
    ["face-wait-retains-callback-lock", "      if (detection != null) awaitFaceTaskCompletion(detection);",
      "      if (detection != null) synchronized (resultAllowed) { awaitFaceTaskCompletion(detection); }",
      /face fallback wait must not retain the callback lock/],
    ["face-wait-forgets-interruption", "      if (interrupted) Thread.currentThread().interrupt();", "",
      /face wait restores preexisting or mid-wait interruption/],
    ["face-wait-interruption-closes-inflight", "catch (InterruptedException interruption) { interrupted = true; }",
      "catch (InterruptedException interruption) { interrupted = true; break; }",
      /interrupt must not terminate face-task ownership waiting/],
    ["face-abandoned-main-result-is-allowed", "              synchronized (allowed) { if (!allowed.get()) return; }", "",
      /abandoned face completion cannot process old tracking or clear a newer task's busy gate/],
    ["face-setup-memory-failure-escapes", faceMethod,
      faceMethod.replace("} catch (RuntimeException | OutOfMemoryError error) {", "} catch (RuntimeException error) {"),
      /OutOfMemoryError: media setup failed/],
    ["face-reset-retains-challenge-phase", resetTrackingMethod, resetTrackingMethod.replace("    facePhase = 0;", ""),
      /face setup failure resets accumulated tracking/],
    ["face-reset-retains-stable-frames", resetTrackingMethod, resetTrackingMethod.replace("    stableFrames = 0;", ""),
      /face setup failure resets accumulated tracking/],
    ["face-reset-retains-tracking-id", resetTrackingMethod, resetTrackingMethod.replace("    activeFaceTrackingId = null;", ""),
      /face setup failure resets accumulated tracking/],
    ["face-cancellation-preserves-progress", "                else resetFaceTracking(task.isCanceled()",
      "                else if (!task.isCanceled()) resetFaceTracking(task.isCanceled()",
      /face failure, cancellation or invalid result releases ownership and resets old tracking progress/],
    ["face-normal-result-never-releases-gate", "                releaseBusy.run();", "",
      /resume never clears a busy gate still owned by old model task|old task completion releases its gate/],
    ["face-registration-is-not-atomically-published", "      synchronized (allowed) {\n        try {",
      "      if (true) {\n        try {",
      /face callback waits for atomic registration success or failure publication/]
  ];
  for (const [name, from, to, expectedFailure] of regressionMutants) {
    assert.ok(harness.includes(from), `missing targeted Activity regression mutation: ${name}`);
    const mutantDirectory = path.join(temporary, name);
    fs.mkdirSync(mutantDirectory);
    const mutantPath = path.join(mutantDirectory, "VisionLifecycleVerifier.java");
    fs.writeFileSync(mutantPath, harness.replace(from, to));
    const mutantCompile = spawnSync(executable("javac"), ["-encoding", "UTF-8", "-d", mutantDirectory,
      path.join(nativeRoot, "VisionCaptureLifecycle.java"), mutantPath], { encoding: "utf8", timeout: 30000 });
    assert.equal(mutantCompile.status, 0, mutantCompile.error?.message || `${mutantCompile.stdout}\n${mutantCompile.stderr}`);
    const mutantRun = spawnSync(executable("java"), ["-cp", mutantDirectory, "local.fanhao.library.VisionLifecycleVerifier", mutantDirectory],
      { encoding: "utf8", timeout: 15000 });
    assert.notEqual(mutantRun.status, 0, `${name} incorrectly passed production-method regression checks`);
    assert.match(mutantRun.stderr, expectedFailure, `${name} failed for an unrelated reason`);
  }
  process.stdout.write(`vision-lifecycle-negative-controls: ${regressionMutants.length} behavioral mutants and ${disconnectedWiring.length} static wiring mutants rejected\n`);

  // Separate real-library probe: no ML Kit model or Android device is claimed here.
  const gradleCaches = path.join(process.env.GRADLE_USER_HOME || path.join(os.homedir(), ".gradle"), "caches");
  const sdk = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT || path.join(os.homedir(), "AppData/Local/Android/Sdk");
  const cachedJar = (pattern) => fs.existsSync(gradleCaches)
    ? fs.globSync(pattern, { cwd: gradleCaches }).sort().map((name) => path.join(gradleCaches, name)).at(-1) : null;
  const tasksJar = cachedJar("*/transforms/*/transformed/play-services-tasks-*-runtime.jar");
  const basementJar = cachedJar("*/transforms/*/transformed/play-services-basement-*-runtime.jar");
  const androidJar = fs.existsSync(sdk)
    ? fs.globSync("platforms/android-*/android.jar", { cwd: sdk }).sort().map((name) => path.join(sdk, name)).at(-1) : null;
  assert.ok(tasksJar && basementJar && androidJar, "actual Google Tasks probe requires the project's cached Android/Google dependencies and Android SDK");
  const classpath = [temporary, tasksJar, basementJar, androidJar].join(path.delimiter);
  const actualProbePath = path.join(temporary, "ActualGoogleTasksVerifier.java");
  fs.writeFileSync(actualProbePath, actualTasksProbe);
  const actualCompile = spawnSync(executable("javac"), ["-encoding", "UTF-8", "-cp", classpath, "-d", temporary, actualProbePath],
    { encoding: "utf8", timeout: 30000 });
  assert.equal(actualCompile.status, 0, actualCompile.error?.message || `${actualCompile.stdout}\n${actualCompile.stderr}`);
  const actualRun = spawnSync(executable("java"), ["-cp", classpath, "local.fanhao.library.ActualGoogleTasksVerifier"],
    { encoding: "utf8", timeout: 15000 });
  assert.equal(actualRun.status, 0, actualRun.error?.message || `${actualRun.stdout}\n${actualRun.stderr}`);
  process.stdout.write(`${path.basename(tasksJar)}: ${actualRun.stdout}`);
} finally {
  const resolved = fs.realpathSync(temporary);
  const tempParent = fs.realpathSync(os.tmpdir());
  assert.equal(path.dirname(resolved).toLowerCase(), tempParent.toLowerCase(), "cleanup must stay in the temp directory");
  assert.ok(path.basename(resolved).startsWith("fanhao-vision-lifecycle-"), "cleanup requires the verifier-owned directory");
  if (process.platform === "win32") {
    const cleanup = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
      `Remove-Item -LiteralPath '${resolved.replaceAll("'", "''")}' -Recurse -Force`], { encoding: "utf8", timeout: 15000 });
    assert.equal(cleanup.status, 0, cleanup.stderr);
  } else fs.rmSync(resolved, { recursive: true, force: true });
}
