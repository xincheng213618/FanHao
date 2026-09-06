package local.fanhao.library;

import java.io.*;
import java.util.*;
import java.util.concurrent.*;
import java.util.function.*;

@interface NonNull {}
class Activity { static final int RESULT_OK = -1, RESULT_CANCELED = 0; }
class Uri {
  final String value;
  Uri(String value) { this.value = value; }
  public String toString() { return value; }
}
class FileProvider {
  static IOException error;
  static final List<File> receivedFiles = new ArrayList<>();
  static Uri getUriForFile(Object context, String authority, File file) throws IOException {
    if (error != null) throw error;
    receivedFiles.add(file);
    return new Uri("content://" + authority + "/" + file.getParentFile().getName() + "/" + file.getName());
  }
}
class ClipData {
  static class Item { final Uri uri; Item(Uri uri) { this.uri = uri; } }
  final List<Item> items = new ArrayList<>();
  static ClipData newUri(Object resolver, String label, Uri uri) { ClipData clip = new ClipData(); clip.addItem(new Item(uri)); return clip; }
  void addItem(Item item) { items.add(item); }
}
class Intent {
  static final String ACTION_SEND = "SEND", ACTION_SEND_MULTIPLE = "SEND_MULTIPLE", ACTION_CHOOSER = "CHOOSER", EXTRA_STREAM = "stream", EXTRA_INTENT = "intent";
  static final int FLAG_GRANT_READ_URI_PERMISSION = 1, FLAG_GRANT_WRITE_URI_PERMISSION = 2;
  String action, type; int flags; ClipData clipData; final Map<String, Object> extras = new HashMap<>();
  Intent() {} Intent(String value) { action = value; }
  void setType(String value) { type = value; }
  void addFlags(int value) { flags |= value; }
  void putExtra(String key, Object value) { extras.put(key, value); }
  void putParcelableArrayListExtra(String key, ArrayList<Uri> values) { extras.put(key, values); }
  void setClipData(ClipData value) { clipData = value; }
  boolean getBooleanExtra(String key, boolean fallback) { return (Boolean) extras.getOrDefault(key, fallback); }
  String getStringExtra(String key) { return (String) extras.get(key); }
  static Intent createChooser(Intent target, String title) {
    Intent chooser = new Intent(ACTION_CHOOSER); chooser.putExtra(EXTRA_INTENT, target); return chooser;
  }
}
class Bundle {
  final Map<String, Object> values = new HashMap<>();
  void putString(String key, String value) { values.put(key, value); }
  String getString(String key, String fallback) { return (String) values.getOrDefault(key, fallback); }
  void putBoolean(String key, boolean value) { values.put(key, value); }
  boolean getBoolean(String key, boolean fallback) { return (Boolean) values.getOrDefault(key, fallback); }
}
class Button {
  boolean enabled; String text;
  void setEnabled(boolean value) { enabled = value; }
  void setText(String value) { text = value; }
}
class ArchiveLauncher {
  final ReviewHostBase host;
  ArchiveLauncher(ReviewHostBase host) { this.host = host; }
  void launch(Intent intent) { host.startActivity(intent); }
}
class JSONObject {
  String name; JSONArray files;
  JSONArray getJSONArray(String key) { return files; }
  String getString(String key) { return name; }
}
class JSONArray {
  final List<JSONObject> entries = new ArrayList<>();
  int length() { return entries.size(); } JSONObject getJSONObject(int index) { return entries.get(index); }
}
class VisionExplorationStore {
  static int deleted, read; static boolean deleteResult = true, directoryExists = true, retainAfterDelete;
  static IOException readError, deleteError, resolveError, fileError;
  static Runnable deleteHook, readHook;
  static String lastReadId, lastDeleteId, resolvedSessionId;
  static final List<File> resolvedFileDirectories = new ArrayList<>();
  static class SessionFile extends File {
    SessionFile(String id) { super("fixture-only", id); }
    public boolean exists() { return directoryExists; }
  }
  static JSONArray files;
  static void reset(String... names) {
    deleted = 0; read = 0; deleteResult = true; directoryExists = true; retainAfterDelete = false;
    readError = null; deleteError = null; resolveError = null; fileError = null; deleteHook = null; readHook = null;
    FileProvider.error = null; FileProvider.receivedFiles.clear(); resolvedFileDirectories.clear();
    lastReadId = null; lastDeleteId = null; resolvedSessionId = null; files = new JSONArray();
    for (String name : names) { JSONObject entry = new JSONObject(); entry.name = name; files.entries.add(entry); }
  }
  static JSONObject getCompletedSession(Object context, String id) throws IOException {
    read++; lastReadId = id; if (readHook != null) readHook.run();
    if (readError != null) throw readError; JSONObject manifest = new JSONObject(); manifest.files = files; return manifest;
  }
  static File resolveSessionDirectory(Object context, String id) throws IOException {
    resolvedSessionId = id; if (resolveError != null) throw resolveError; return new SessionFile(id);
  }
  static File resolveSessionFile(File directory, String name) throws IOException {
    resolvedFileDirectories.add(directory); if (fileError != null) throw fileError; return new File(directory, name);
  }
  static boolean deleteSession(Object context, String id) throws IOException {
    deleted++; lastDeleteId = id; if (deleteHook != null) deleteHook.run();
    if (deleteError != null) throw deleteError;
    if (deleteResult && !retainAfterDelete) directoryExists = false;
    return deleteResult;
  }
}
class AlertDialog {
  interface Click { void onClick(AlertDialog dialog, int which); }
  static AlertDialog latest; String title, message; Click positive, negative, neutral; Consumer<AlertDialog> canceled, dismissed; boolean showing = true;
  void dismiss() { showing = false; if (dismissed != null) ReviewUi.queue.add(() -> dismissed.accept(this)); }
  void clickPositive() { if (positive != null) positive.onClick(this, 0); dismiss(); }
  void clickNegative() { if (negative != null) negative.onClick(this, 0); dismiss(); }
  void cancel() { if (canceled != null) canceled.accept(this); dismiss(); }
  boolean isShowing() { return showing; }
  static class Builder {
    final AlertDialog dialog = new AlertDialog();
    Builder(Object context) {}
    Builder setTitle(String value) { dialog.title = value; return this; }
    Builder setMessage(String value) { dialog.message = value; return this; }
    Builder setPositiveButton(String label, Click callback) { dialog.positive = callback; return this; }
    Builder setNegativeButton(String label, Click callback) { dialog.negative = callback; return this; }
    Builder setNeutralButton(String label, Click callback) { dialog.neutral = callback; return this; }
    Builder setOnCancelListener(Consumer<AlertDialog> callback) { dialog.canceled = callback; return this; }
    Builder setOnDismissListener(Consumer<AlertDialog> callback) { dialog.dismissed = callback; return this; }
    Builder setCancelable(boolean value) { return this; }
    AlertDialog show() { latest = dialog; return dialog; }
  }
}
class ReviewUi {
  static final Queue<Runnable> queue = new ArrayDeque<>();
  static void drain() { while (!queue.isEmpty()) queue.remove().run(); }
}
class Handler { void removeCallbacksAndMessages(Object token) {} }
class Model { void close() {} }
class ReviewHostBase {
  static final String MODE_REVIEW = "review", RESULT_DELETED = "deleted", EXTRA_SESSION_ID = "sessionId";
  final VisionCaptureLifecycle captureLifecycle = new VisionCaptureLifecycle();
  final Handler captureHandler = new Handler();
  AlertDialog captureDialog; Model faceDetector, textRecognizer; ExecutorService cameraExecutor;
  boolean terminalResult, finishing, destroyed; int finishes, result = 12345, launches, fatals; String fatal;
  Intent data, lastLaunch; final Intent launchIntent = new Intent(); boolean throwLaunch; Runnable launchHook;
  Intent getIntent() { return launchIntent; }
  boolean isFinishing() { return finishing; } boolean isDestroyed() { return destroyed; }
  void unbindCamera() {}
  String getPackageName() { return "fixture.local"; } Object getContentResolver() { return this; }
  void startActivity(Intent intent) {
    launches++; if (launchHook != null) launchHook.run();
    if (throwLaunch) throw new IllegalStateException("chooser unavailable"); lastLaunch = intent;
  }
  void setResult(int code, Intent value) { result = code; data = value; }
  void finish() { finishes++; finishing = true; }
  void showFatal(String message) { fatals++; fatal = message; }
  void runOnUiThread(Runnable action) { action.run(); }
  protected void onPause() {}
  protected void onResume() {}
  protected void onDestroy() { destroyed = true; }
}

class ProductionReviewHost extends ReviewHostBase {
  static final String STATE_REVIEW_SESSION = "review-session", STATE_REVIEW_DELETE = "review-delete", STATE_REVIEW_SHARE = "review-share", STATE_REVIEW_ERROR = "review-error";
  String mode = MODE_REVIEW, reviewSessionId = "", reviewExportError, fatalMessage;
  boolean reviewDeletePending, reviewDeleteInProgress, reviewShareInFlight, exitConfirmationPending;
  Button reviewExportButton = new Button(), reviewDeleteButton = new Button();
  final ArchiveLauncher archiveShareLauncher = new ArchiveLauncher(this);
  void resumeForegroundCapture() { throw new AssertionError("review must not enter capture startup"); }
  void finishCapture(boolean discard) { throw new AssertionError("review must not enter capture exit"); }
  void finishCanceled() { throw new AssertionError("review must not enter capture cancellation"); }
  /* PRODUCTION_METHODS */
}

public class NativeVisionReviewHarness {
  static int checks;
  static void check(boolean condition, String message) { if (!condition) throw new AssertionError(message); checks++; }
  static void legacyEvidence() {
    for (int scenario = 0; scenario < 4; scenario++) {
      VisionExplorationStore.reset("id-front.jpg"); LegacyNativeVisionReviewHost host = new LegacyNativeVisionReviewHost();
      host.deleteForTest("saved-record"); AlertDialog oldDialog = AlertDialog.latest;
      if (scenario == 0) host.onPause();
      else if (scenario == 1) host.onDestroy();
      else if (scenario == 2) oldDialog.clickPositive();
      else host.finishForTest(false);
      oldDialog.clickPositive();
      check(VisionExplorationStore.deleted == (scenario == 2 ? 2 : 1), "frozen legacy delete still executes after pause, destroy, repeated positive or prior result");
      if (scenario == 1) check(host.finishes == 1 && host.result == Activity.RESULT_OK, "frozen destroyed Activity can still publish a successful result");
    }
    VisionExplorationStore.reset("id-front.jpg"); LegacyNativeVisionReviewHost pausedShare = new LegacyNativeVisionReviewHost();
    pausedShare.onPause(); pausedShare.exportForTest("saved-record");
    check(pausedShare.launches == 1 && VisionExplorationStore.read == 1, "frozen legacy share launches while background");
    pausedShare.onDestroy(); pausedShare.exportForTest("saved-record");
    check(pausedShare.launches == 2, "frozen legacy share launches even after destruction");
    System.out.println("native-vision-review-legacy-evidence: " + checks + " old unsafe behavior observations reproduced");
  }
  static void legacySafetyRegression(String name) {
    VisionExplorationStore.reset("id-front.jpg"); LegacyNativeVisionReviewHost host = new LegacyNativeVisionReviewHost();
    if (name.equals("background-share") || name.equals("destroyed-share")) {
      if (name.equals("background-share")) host.onPause(); else host.onDestroy();
      host.exportForTest("saved-record");
      check(host.launches == 0 && VisionExplorationStore.read == 0, "old review must not share outside active foreground");
      return;
    }
    host.deleteForTest("saved-record"); AlertDialog oldDialog = AlertDialog.latest;
    if (name.equals("paused-delete")) host.onPause();
    else if (name.equals("destroyed-delete")) host.onDestroy();
    else if (name.equals("repeated-delete")) oldDialog.clickPositive();
    else host.finishForTest(false);
    int before = VisionExplorationStore.deleted; oldDialog.clickPositive();
    check(VisionExplorationStore.deleted == before, "old review must reject stale or duplicate deletion confirmation");
  }
  static ProductionReviewHost host(String id, Bundle state, boolean foreground) {
    ProductionReviewHost host = new ProductionReviewHost(); host.launchIntent.putExtra(ReviewHostBase.EXTRA_SESSION_ID, id);
    host.captureLifecycle.suspend(VisionCaptureLifecycle.BACKGROUND); host.initializeReviewState(state);
    if (foreground) host.onResume(); return host;
  }
  static void productionChecks() {
    int before = checks;
    for (int count = 1; count <= 3; count++) {
      String[] names = count == 1 ? new String[] { "face-verification.jpg" }
        : count == 2 ? new String[] { "id-front.jpg", "id-back.jpg" } : new String[] { "id-front.jpg", "id-back.jpg", "bank-card-front.jpg" };
      VisionExplorationStore.reset(names); ProductionReviewHost host = host("uri-record", null, true);
      host.shareArchivedSession("uri-record");
      check(host.reviewShareInFlight && host.launches == 1 && !host.reviewExportButton.enabled && !host.reviewDeleteButton.enabled, "share owns one busy gate and disables conflicting actions before chooser returns");
      check(Intent.ACTION_CHOOSER.equals(host.lastLaunch.action), "share dispatches chooser payload through the launcher boundary");
      Intent payload = (Intent) host.lastLaunch.extras.get(Intent.EXTRA_INTENT);
      check((count == 1 ? Intent.ACTION_SEND : Intent.ACTION_SEND_MULTIPLE).equals(payload.action) && "image/jpeg".equals(payload.type), "single and multiple images use matching MIME action");
      check(payload.flags == Intent.FLAG_GRANT_READ_URI_PERMISSION && (payload.flags & Intent.FLAG_GRANT_WRITE_URI_PERMISSION) == 0, "share payload requests read permission only");
      check(payload.clipData != null && payload.clipData.items.size() == count, "every exported URI appears in ClipData");
      check("uri-record".equals(VisionExplorationStore.lastReadId) && "uri-record".equals(VisionExplorationStore.resolvedSessionId), "manifest and session directory resolve exactly the selected review record");
      List<?> streams = count == 1 ? List.of(payload.extras.get(Intent.EXTRA_STREAM)) : (List<?>) payload.extras.get(Intent.EXTRA_STREAM);
      for (int index = 0; index < count; index++) {
        check(streams.get(index) == payload.clipData.items.get(index).uri
          && streams.get(index).toString().equals("content://fixture.local.fileprovider/uri-record/" + names[index]), "stream and ClipData retain exact same ordered, session-scoped provider URIs");
        File selectedDirectory = new File("fixture-only", "uri-record");
        check(VisionExplorationStore.resolvedFileDirectories.get(index).equals(selectedDirectory)
          && FileProvider.receivedFiles.get(index).equals(new File(selectedDirectory, names[index])), "photo resolver and FileProvider receive the selected session's complete file path");
      }
      host.shareArchivedSession("uri-record"); host.confirmDeleteArchivedSession("uri-record");
      check(host.launches == 1 && VisionExplorationStore.read == 1 && !host.reviewDeletePending && host.captureDialog == null, "repeated share or delete during chooser busy cannot start another operation");
      host.onPause(); host.onArchiveShareResult();
      check(!host.reviewShareInFlight && !host.reviewExportButton.enabled && host.finishes == 0 && host.result == 12345, "chooser return while background only releases busy and never reports successful backup");
      host.onResume(); host.onArchiveShareResult(); host.onArchiveShareResult();
      check(host.reviewExportButton.enabled && host.reviewDeleteButton.enabled && host.launches == 1 && host.finishes == 0, "foreground return and duplicate result events do not replay export or finish review"); host.onDestroy();
    }

    VisionExplorationStore.reset("id-front.jpg"); ProductionReviewHost gated = host("owned", null, false);
    gated.shareArchivedSession("owned"); gated.confirmDeleteArchivedSession("owned"); gated.finishReview(false);
    check(gated.launches == 0 && VisionExplorationStore.read == 0 && VisionExplorationStore.deleted == 0 && gated.finishes == 0, "pre-resume review cannot export, delete or finish");
    gated.onResume(); gated.shareArchivedSession("another-id"); gated.confirmDeleteArchivedSession("another-id");
    check(VisionExplorationStore.read == 0 && gated.captureDialog == null && !gated.reviewDeletePending, "review actions require the selected session identity");
    gated.mode = "face"; gated.shareArchivedSession("owned"); gated.confirmDeleteArchivedSession("owned"); gated.finishReview(false);
    check(gated.launches == 0 && gated.finishes == 0, "capture mode cannot accidentally execute review actions"); gated.mode = ReviewHostBase.MODE_REVIEW;
    gated.onDestroy(); gated.shareArchivedSession("owned"); gated.confirmDeleteArchivedSession("owned"); gated.finishReview(false); gated.onArchiveShareResult();
    check(gated.launches == 0 && gated.finishes == 0 && VisionExplorationStore.read == 0, "destroyed review ignores all retained export, deletion and result callbacks");

    VisionExplorationStore.reset("id-front.jpg"); ProductionReviewHost empty = host("", null, true);
    empty.shareArchivedSession(""); empty.confirmDeleteArchivedSession(""); empty.shareArchivedSession(null); empty.confirmDeleteArchivedSession(null);
    check(empty.launches == 0 && VisionExplorationStore.read == 0 && !empty.reviewDeletePending, "empty or null session identity never becomes a review action target"); empty.onDestroy();
    ProductionReviewHost noDialog = host("null-dialog", null, true);
    noDialog.reviewDeletePending = true; noDialog.deleteReviewedSession(null, "null-dialog"); noDialog.cancelReviewDelete(null);
    noDialog.reviewExportError = "pending error"; noDialog.dismissReviewExportError(null);
    check(noDialog.reviewDeletePending && noDialog.reviewExportError != null && VisionExplorationStore.deleted == 0, "null dialog reference cannot consume confirmation or error intent"); noDialog.onDestroy();
    ProductionReviewHost resetState = host("old-id", null, true);
    resetState.reviewDeletePending = true; resetState.reviewDeleteInProgress = true; resetState.reviewShareInFlight = true; resetState.reviewExportError = "old error";
    resetState.launchIntent.putExtra(ReviewHostBase.EXTRA_SESSION_ID, "new-id"); resetState.initializeReviewState(null);
    check(!resetState.reviewDeletePending && !resetState.reviewDeleteInProgress && !resetState.reviewShareInFlight && resetState.reviewExportError == null && "new-id".equals(resetState.reviewSessionId), "initialization clears prior transient state before considering matching saved session"); resetState.onDestroy();

    ProductionReviewHost irrelevantResult = host("result-owner", null, true); irrelevantResult.reviewShareInFlight = true;
    irrelevantResult.mode = "document"; irrelevantResult.onArchiveShareResult();
    check(irrelevantResult.reviewShareInFlight, "chooser result cannot mutate a non-review mode");
    irrelevantResult.mode = ReviewHostBase.MODE_REVIEW; irrelevantResult.onDestroy(); irrelevantResult.onArchiveShareResult();
    check(irrelevantResult.reviewShareInFlight && irrelevantResult.finishes == 0, "result delivered to destroyed review cannot revive or finish it");

    VisionExplorationStore.reset("id-front.jpg"); ProductionReviewHost synchronous = host("sync-result", null, true);
    synchronous.launchHook = () -> {
      check(synchronous.reviewShareInFlight, "busy is set before synchronous launcher callback");
      synchronous.onArchiveShareResult();
    };
    synchronous.shareArchivedSession("sync-result");
    check(!synchronous.reviewShareInFlight && synchronous.reviewExportButton.enabled && synchronous.finishes == 0, "synchronous chooser result is not overwritten by late busy initialization"); synchronous.onDestroy();

    VisionExplorationStore.reset("id-front.jpg"); ProductionReviewHost preparing = host("preparing", null, true);
    VisionExplorationStore.readHook = () -> {
      check(preparing.reviewShareInFlight, "busy covers URI preparation before external dispatch");
      preparing.shareArchivedSession("preparing"); preparing.confirmDeleteArchivedSession("preparing");
    };
    preparing.shareArchivedSession("preparing");
    check(preparing.launches == 1 && VisionExplorationStore.read == 1 && !preparing.reviewDeletePending, "reentrant actions during payload preparation cannot duplicate export or remove its input"); preparing.onDestroy();

    for (int failure = 0; failure < 6; failure++) {
      VisionExplorationStore.reset(failure == 5 ? new String[0] : new String[] { "id-front.jpg" });
      ProductionReviewHost exportError = host("export-error", null, true);
      if (failure == 0) VisionExplorationStore.readError = new IOException("bad manifest");
      else if (failure == 1) VisionExplorationStore.resolveError = new IOException("unsafe directory");
      else if (failure == 2) VisionExplorationStore.fileError = new IOException("missing image");
      else if (failure == 3) FileProvider.error = new IOException("provider unavailable");
      else if (failure == 4) exportError.throwLaunch = true;
      exportError.shareArchivedSession("export-error");
      check(!exportError.reviewShareInFlight && exportError.reviewExportError != null && exportError.captureDialog != null && !exportError.reviewDeleteButton.enabled, "manifest, path, URI, dispatch and empty-export errors release busy into a visible error decision");
      check(exportError.finishes == 0 && exportError.result == 12345 && VisionExplorationStore.deleted == 0, "export failures neither delete photos nor invent backup success");
      AlertDialog oldError = exportError.captureDialog;
      if (failure % 2 == 0) oldError.clickPositive(); else oldError.cancel();
      ReviewUi.drain();
      check(exportError.reviewExportError == null && exportError.captureDialog == null && exportError.reviewExportButton.enabled, "acknowledging or canceling export error restores available review actions");
      exportError.confirmDeleteArchivedSession("export-error"); AlertDialog newDelete = exportError.captureDialog;
      oldError.positive.onClick(oldError, 0);
      check(exportError.captureDialog == newDelete && exportError.reviewDeletePending, "old export-error callback cannot dismiss a replacement delete dialog");
      exportError.onDestroy();
    }

    VisionExplorationStore.reset("id-front.jpg"); ProductionReviewHost backgroundError = host("background-error", null, true);
    backgroundError.throwLaunch = true; backgroundError.launchHook = backgroundError::onPause;
    backgroundError.shareArchivedSession("background-error");
    check(backgroundError.reviewExportError != null && backgroundError.captureDialog == null && !backgroundError.reviewShareInFlight, "launch failure after background transition retains error without drawing over other apps");
    Bundle backgroundErrorState = new Bundle(); backgroundError.saveReviewState(backgroundErrorState); backgroundError.onDestroy();
    ProductionReviewHost restoredError = host("background-error", backgroundErrorState, true);
    check(restoredError.captureDialog != null && restoredError.reviewExportError != null && restoredError.launches == 0, "export error survives matching-session recreation without replaying chooser");
    restoredError.captureDialog.cancel(); ReviewUi.drain();
    check(restoredError.canStartReviewAction("background-error"), "restored export error can be dismissed normally"); restoredError.onDestroy();

    VisionExplorationStore.reset("id-front.jpg"); ProductionReviewHost awaiting = host("pending-share", null, true);
    awaiting.shareArchivedSession("pending-share"); awaiting.onPause(); Bundle awaitingState = new Bundle(); awaiting.saveReviewState(awaitingState); awaiting.onDestroy();
    ProductionReviewHost reconstructed = host("pending-share", awaitingState, false);
    check(reconstructed.reviewShareInFlight && reconstructed.launches == 0, "recreation restores chooser busy without launching a second chooser");
    reconstructed.onArchiveShareResult(); reconstructed.onResume();
    check(!reconstructed.reviewShareInFlight && reconstructed.reviewExportButton.enabled && reconstructed.launches == 0 && reconstructed.finishes == 0, "result delivered at START before RESUME clears restored busy permanently"); reconstructed.onDestroy();
    ProductionReviewHost stillWaiting = host("pending-share", awaitingState, true);
    stillWaiting.confirmDeleteArchivedSession("pending-share"); stillWaiting.shareArchivedSession("pending-share");
    Bundle waitingAgain = new Bundle(); stillWaiting.saveReviewState(waitingAgain);
    check(stillWaiting.reviewShareInFlight && !stillWaiting.reviewDeletePending && stillWaiting.launches == 0 && waitingAgain.getBoolean(ProductionReviewHost.STATE_REVIEW_SHARE, false), "recreated busy survives another save and blocks deletion until result arrives"); stillWaiting.onDestroy();
    ProductionReviewHost different = host("different-record", awaitingState, true);
    check(!different.reviewShareInFlight && !different.reviewDeletePending && different.reviewExportError == null && different.canStartReviewAction("different-record"), "saved operation state never migrates to a different intent session"); different.onDestroy();

    VisionExplorationStore.reset("id-front.jpg"); ProductionReviewHost dialogHost = host("dialog-record", null, true);
    dialogHost.confirmDeleteArchivedSession("dialog-record"); AlertDialog beforePause = dialogHost.captureDialog;
    dialogHost.shareArchivedSession("dialog-record"); dialogHost.confirmDeleteArchivedSession("dialog-record");
    check(dialogHost.captureDialog == beforePause && dialogHost.launches == 0 && dialogHost.reviewDeletePending, "unresolved deletion owns dialog and excludes duplicate delete or share");
    dialogHost.onPause(); beforePause.clickPositive(); beforePause.clickNegative(); beforePause.cancel();
    check(VisionExplorationStore.deleted == 0 && dialogHost.reviewDeletePending && dialogHost.captureDialog == null, "paused old positive, negative and cancel callbacks have no effect");
    dialogHost.onResume(); AlertDialog afterPause = dialogHost.captureDialog;
    beforePause.positive.onClick(beforePause, 0); beforePause.negative.onClick(beforePause, 0); beforePause.canceled.accept(beforePause); ReviewUi.drain();
    check(afterPause != beforePause && dialogHost.captureDialog == afterPause && dialogHost.reviewDeletePending && VisionExplorationStore.deleted == 0, "old dialog callbacks delivered after replacement do not consume new pending confirmation");
    afterPause.cancel(); ReviewUi.drain();
    check(!dialogHost.reviewDeletePending && dialogHost.captureDialog == null && dialogHost.reviewDeleteButton.enabled && VisionExplorationStore.deleted == 0, "current delete backdrop cancel resumes review without removal"); dialogHost.onDestroy();

    VisionExplorationStore.reset("id-front.jpg"); ProductionReviewHost rotateDelete = host("rotate-delete", null, true);
    rotateDelete.confirmDeleteArchivedSession("rotate-delete"); AlertDialog retiredDelete = rotateDelete.captureDialog;
    Bundle deleteState = new Bundle(); rotateDelete.saveReviewState(deleteState); rotateDelete.onDestroy();
    ProductionReviewHost newOwner = host("rotate-delete", deleteState, true);
    check(newOwner.reviewDeletePending && newOwner.captureDialog != null && VisionExplorationStore.deleted == 0 && !newOwner.reviewDeleteInProgress, "recreation re-presents undecided deletion without executing or persisting transient in-progress state");
    retiredDelete.clickPositive(); check(VisionExplorationStore.deleted == 0, "destroyed owner cannot consume new owner's confirmation");
    AlertDialog currentDelete = newOwner.captureDialog;
    VisionExplorationStore.deleteHook = () -> {
      check(newOwner.reviewDeleteInProgress && !newOwner.reviewDeletePending && newOwner.captureDialog == null, "confirmation identity and pending state are consumed before Store delete");
      currentDelete.positive.onClick(currentDelete, 0); newOwner.shareArchivedSession("rotate-delete");
    };
    currentDelete.clickPositive(); currentDelete.positive.onClick(currentDelete, 0); newOwner.finishReview(true);
    check(VisionExplorationStore.deleted == 1 && "rotate-delete".equals(VisionExplorationStore.lastDeleteId) && newOwner.launches == 0, "reentrant and repeated delete confirmations remove selected session once only");
    check(newOwner.finishes == 1 && newOwner.result == Activity.RESULT_OK && newOwner.data.getBooleanExtra(ReviewHostBase.RESULT_DELETED, false) && !newOwner.reviewDeleteInProgress, "confirmed absent directory returns deleted success once and releases transient operation gate"); newOwner.onDestroy();

    for (int failure = 0; failure < 4; failure++) {
      VisionExplorationStore.reset("id-front.jpg"); ProductionReviewHost deleteError = host("delete-error", null, true);
      if (failure == 0) VisionExplorationStore.deleteResult = false;
      else if (failure == 1) VisionExplorationStore.retainAfterDelete = true;
      else if (failure == 2) VisionExplorationStore.deleteError = new IOException("delete denied");
      else VisionExplorationStore.resolveError = new IOException("unsafe record path");
      deleteError.confirmDeleteArchivedSession("delete-error"); AlertDialog confirmation = deleteError.captureDialog;
      confirmation.clickPositive(); ReviewUi.drain();
      check(deleteError.fatalMessage != null && !deleteError.reviewDeleteInProgress && !deleteError.reviewDeletePending && deleteError.finishes == 0 && VisionExplorationStore.directoryExists, "false, partial or thrown deletion preserves failure truth and releases in-progress state");
      int calls = VisionExplorationStore.deleted; confirmation.positive.onClick(confirmation, 0);
      check(VisionExplorationStore.deleted == calls && deleteError.captureDialog != confirmation, "failed deletion cannot be retried by stale confirmation callback");
      deleteError.captureDialog.clickPositive(); ReviewUi.drain();
      check(deleteError.finishes == 1 && !deleteError.data.getBooleanExtra(ReviewHostBase.RESULT_DELETED, true), "deletion error closes review without reporting nonexistent deletion success"); deleteError.onDestroy();
    }

    VisionExplorationStore.reset("id-front.jpg"); ProductionReviewHost returned = host("returned", null, true);
    returned.confirmDeleteArchivedSession("returned"); AlertDialog priorResultDialog = returned.captureDialog;
    returned.finishReview(false); priorResultDialog.clickPositive(); returned.shareArchivedSession("returned"); returned.onArchiveShareResult();
    check(returned.finishes == 1 && VisionExplorationStore.deleted == 0 && returned.launches == 0 && !returned.data.getBooleanExtra(ReviewHostBase.RESULT_DELETED, true), "normal review close prevents retained deletion/export/result actions from mutating files or result"); returned.onDestroy();
    System.out.println("native-vision-review-verification: " + (checks - before) + " production method/state/URI payload checks passed");
  }
  public static void main(String[] args) throws Exception {
    if (args.length > 0) { legacySafetyRegression(args[0]); return; }
    legacyEvidence();
    productionChecks();
  }
}
