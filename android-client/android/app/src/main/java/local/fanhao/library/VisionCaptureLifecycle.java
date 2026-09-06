package local.fanhao.library;

import java.io.File;
import java.io.IOException;
import java.util.UUID;
import java.util.concurrent.Executor;
import java.util.concurrent.atomic.AtomicBoolean;

/** Per-Activity callback ownership, separate from the durable session on disk. */
final class VisionCaptureLifecycle {
  static final int BACKGROUND = 1;
  static final int EXIT_CONFIRMATION = 2;
  static final int FATAL_ERROR = 4;
  // Frame cleanup must survive shutdown of the executor that supplies camera frames.
  static final Executor RELEASE_EXECUTOR = Runnable::run;
  private static final String UUID_PATTERN = "[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}";
  private static final String CAPTURE_PATTERN = "\\.capture-" + UUID_PATTERN + "-" + UUID_PATTERN + "\\.jpg";
  private static final String PROCESS_PREFIX = ".capture-" + UUID.randomUUID() + "-";

  private long generation;
  private boolean destroyed;
  private boolean completed;
  private boolean terminal;
  private int suspensionReasons;

  synchronized long generation() { return generation; }
  synchronized boolean isAlive() { return !destroyed && !terminal; }
  synchronized boolean accepts(long token) { return isAlive() && suspensionReasons == 0 && generation == token; }
  synchronized boolean canCapture(long token) { return accepts(token) && !completed; }
  synchronized boolean isCompleted() { return completed; }
  synchronized boolean isSuspended() { return suspensionReasons != 0; }

  synchronized boolean isSuspended(int reason) {
    validateReason(reason);
    return (suspensionReasons & reason) != 0;
  }

  // A caller may change only its own reason. Dismissing a dialog must not clear
  // the Activity's background state (or a failure that still needs attention).
  // Both edges invalidate callbacks: a pause/resume cycle never revives a token.
  synchronized boolean suspend(int reason) {
    validateReason(reason);
    if (!isAlive() || (suspensionReasons & reason) != 0) return false;
    suspensionReasons |= reason;
    generation++;
    return true;
  }

  synchronized boolean resume(int reason) {
    validateReason(reason);
    if (!isAlive() || (suspensionReasons & reason) == 0) return false;
    suspensionReasons &= ~reason;
    generation++;
    return true;
  }

  private static void validateReason(int reason) {
    if (reason != BACKGROUND && reason != EXIT_CONFIRMATION && reason != FATAL_ERROR) {
      throw new IllegalArgumentException("A capture pause requires one known owner reason");
    }
  }

  synchronized void nextStep() { generation++; }

  synchronized boolean markCompleted() {
    if (destroyed || terminal || suspensionReasons != 0) return false;
    if (!completed) generation++;
    completed = true;
    return true;
  }

  synchronized boolean deliver() {
    if (destroyed || terminal || !completed || suspensionReasons != 0) return false;
    terminal = true;
    generation++;
    return true;
  }

  synchronized boolean cancel() {
    if (destroyed || terminal || completed) return false;
    terminal = true;
    generation++;
    return true;
  }

  synchronized boolean destroy() {
    if (destroyed) return false;
    destroyed = true;
    generation++;
    return true;
  }

  static Runnable releaseOnce(Runnable release) {
    AtomicBoolean released = new AtomicBoolean();
    return () -> { if (released.compareAndSet(false, true)) release.run(); };
  }

  static File temporaryCapture(File session) {
    return new File(session, PROCESS_PREFIX + UUID.randomUUID() + ".jpg");
  }

  static void discardTemporary(File file) {
    if (file != null && file.getName().matches(CAPTURE_PATTERN)) file.delete();
  }

  static void discardAbandonedCaptures(File session) {
    File[] files = session.listFiles();
    if (files == null) return;
    for (File file : files) {
      String name = file.getName();
      // A previous process cannot still own CameraX/OCR work. This process can:
      // leave its output alone until the original operation's callback releases it.
      if (name.matches(CAPTURE_PATTERN) && !name.startsWith(PROCESS_PREFIX) && file.isFile()) file.delete();
    }
  }

  static void promote(File temporary, File session, String name) throws IOException {
    if (!temporary.getName().matches(CAPTURE_PATTERN)
      || !temporary.getCanonicalFile().getParentFile().equals(session.getCanonicalFile())
      || !name.matches("[a-z0-9-]+\\.jpg") || !temporary.isFile() || temporary.length() == 0L) {
      throw new IOException("探索照片临时文件无效");
    }
    File destination = new File(session, name);
    if (destination.exists() || !temporary.renameTo(destination)) {
      throw new IOException("无法确认本次探索照片");
    }
  }

  // Only promoted (validated) photos are checkpoints. Pending camera/OCR output is not.
  static String resumeStep(String kind, File session) {
    if ("id-card".equals(kind)) {
      if (!accepted(session, "id-front.jpg")) return "ID_FRONT";
      return accepted(session, "id-back.jpg") ? "COMPLETE" : "ID_BACK";
    }
    if ("bank-card".equals(kind)) return accepted(session, "bank-card-front.jpg") ? "COMPLETE" : "BANK_FRONT";
    if ("face-verification".equals(kind)) return accepted(session, "face-verification.jpg") ? "COMPLETE" : "FACE";
    throw new IllegalArgumentException("探索类型无效");
  }

  private static boolean accepted(File session, String name) {
    File file = new File(session, name);
    return file.isFile() && file.length() > 0L;
  }
}
