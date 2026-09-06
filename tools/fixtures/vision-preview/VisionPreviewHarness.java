package local.fanhao.library;

import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Matrix;
import android.media.ExifInterface;
import java.io.File;

class PreviewHostBase {
  enum Step { ID_FRONT, ID_BACK, BANK_FRONT, FACE }
  Step step = Step.BANK_FRONT;
  int retried, accepted, ocr, qualityFailure;
  int handoffFailure;
  boolean synchronousHandoffRelease;
  Runnable qualityHook;
  final VisionCaptureLifecycle captureLifecycle = new VisionCaptureLifecycle();
  String quality = "光线与对比度正常";
  Bitmap handedOff;
  String assessImageQuality(Bitmap bitmap) {
    if (qualityHook != null) qualityHook.run();
    if (qualityFailure == 1) throw new OutOfMemoryError("fixture quality OOM");
    if (qualityFailure == 2) throw new IllegalArgumentException("fixture quality failure");
    return bitmap == null ? "无法读取预览。" : quality;
  }
  void retryDocumentAutomatically(File file, String message) { retried++; }
  void acceptCapturedDocument(File file) { accepted++; }
  void validateIdentityCardSide(File file, Bitmap bitmap, Step step) {
    ocr++;
    if (handoffFailure == 1) throw new OutOfMemoryError("fixture before OCR ownership OOM");
    if (handoffFailure == 2) throw new IllegalArgumentException("fixture before OCR ownership failure");
    handedOff = bitmap; if (synchronousHandoffRelease) bitmap.recycle();
  }
  boolean canUseUi(long token) { return captureLifecycle.accepts(token); }
}

class ProductionPreviewHost extends PreviewHostBase {
  /* PRODUCTION_METHODS */
}

public class VisionPreviewHarness {
  static int checks;
  static final File IMAGE = new File("fixture-only", "preview.jpg");
  static void check(boolean condition, String message) { if (!condition) throw new AssertionError(message); checks++; }
  static void reset(int width, int height, int orientation) {
    BitmapFactory.reset(width, height); ExifInterface.orientation = orientation; ExifInterface.failure = ExifInterface.reads = 0;
  }
  static void legacyEvidence() {
    reset(800, 20000, 1); Bitmap tall = new LegacyVisionPreviewHost().decodeForTest(IMAGE, 1100);
    check(BitmapFactory.lastSample == 1 && tall.getHeight() == 20000, "legacy width-only sampler decodes a 20000px tall image without sampling");
    for (int orientation : new int[] { 2, 4, 5, 7 }) {
      reset(3, 2, orientation); Bitmap wrong = new LegacyVisionPreviewHost().decodeForTest(IMAGE, 1100);
      check(Bitmap.transforms == 0 && "ABCDEF".equals(wrong.pixels), "legacy mirror EXIF orientation is returned unchanged");
    }
    for (int phase = 0; phase < 3; phase++) {
      reset(800, 1200, 6);
      if (phase == 0) BitmapFactory.boundsFailure = 1;
      else if (phase == 1) BitmapFactory.decodeFailure = 1;
      else Bitmap.transformFailure = 1;
      boolean escaped = false;
      try { new LegacyVisionPreviewHost().decodeForTest(IMAGE, 1100); } catch (OutOfMemoryError expected) { escaped = true; }
      check(escaped, "legacy bounds, decode and rotate OOM escapes Activity preview");
      if (phase == 2) check(Bitmap.allocated.size() == 1 && Bitmap.allocated.get(0).recycles == 0, "legacy rotate OOM leaves decoded source unrecycled");
    }
    reset(800, 1200, 1); LegacyVisionPreviewHost quality = new LegacyVisionPreviewHost(); quality.qualityFailure = 2;
    try { quality.confirmForTest(IMAGE); } catch (IllegalArgumentException expected) {}
    check(Bitmap.allocated.get(0).recycles == 0 && quality.retried == 0, "legacy quality failure loses preview ownership before OCR handoff");
    System.out.println("vision-preview-legacy-evidence: " + checks + " old unsafe decoding/ownership observations reproduced");
  }
  static void legacySafety(String scenario) {
    if (scenario.equals("tall")) {
      reset(800, 20000, 1); Bitmap result = new LegacyVisionPreviewHost().decodeForTest(IMAGE, 1100);
      check(Math.max(result.getWidth(), result.getHeight()) <= 4096, "old preview must bound both image dimensions");
    } else if (scenario.startsWith("mirror")) {
      int orientation = Integer.parseInt(scenario.substring(6)); reset(3, 2, orientation);
      Bitmap result = new LegacyVisionPreviewHost().decodeForTest(IMAGE, 1100);
      String expected = orientation == 2 ? "CBAFED" : orientation == 4 ? "DEFABC" : orientation == 5 ? "ADBECF" : "FCEBDA";
      check(expected.equals(result.pixels), "old preview must honor mirrored EXIF pixels");
    } else if (scenario.equals("quality")) {
      reset(800, 1200, 1); LegacyVisionPreviewHost host = new LegacyVisionPreviewHost(); host.qualityFailure = 2;
      try { host.confirmForTest(IMAGE); } catch (RuntimeException ignored) {}
      check(Bitmap.allocated.get(0).recycles == 1 && host.retried == 1, "old confirmation must release and retry on quality failure");
    } else {
      reset(800, 1200, 6);
      if (scenario.equals("bounds-oom")) BitmapFactory.boundsFailure = 1;
      else if (scenario.equals("decode-oom")) BitmapFactory.decodeFailure = 1;
      else Bitmap.transformFailure = 1;
      boolean escaped = false;
      try { new LegacyVisionPreviewHost().decodeForTest(IMAGE, 1100); } catch (OutOfMemoryError expected) { escaped = true; }
      check(!escaped, "old preview must contain allocation failure");
    }
  }
  static int expectedSample(int width, int height, int preferred) {
    if (width < 1 || height < 1 || preferred < 1) return 0;
    for (long sample = 1; sample <= (1L << 30); sample *= 2L) {
      long w = (width + sample - 1L) / sample, h = (height + sample - 1L) / sample;
      if (w <= (long) preferred * 3L / 2L && w <= 4096L && h <= 4096L && w * h <= 4L * 1024L * 1024L) return (int) sample;
    }
    return 0;
  }
  static void ownedOnly(Bitmap result) {
    for (Bitmap bitmap : Bitmap.allocated) check(bitmap.recycles == (bitmap == result ? 0 : 1), "every allocated non-output bitmap is released exactly once");
  }
  static void productionChecks() {
    int before = checks;
    int[] edges = { -1, 0, 1, 2, 3, 17, 1099, 1100, 1650, 1651, 2048, 2049, 3000, 4000, 4096, 4097, 8000, 20000, Integer.MAX_VALUE };
    int[] preferred = { -1, 0, 1, 2, 17, 1100, 1400, 4096, Integer.MAX_VALUE };
    for (int width : edges) for (int height : edges) {
      boolean memory = width > 0 && height > 0 && width <= 4096 && height <= 4096 && (long) width * height <= 4194304L;
      check(VisionPreviewDecoder.fitsMemory(width, height) == memory, "memory predicate handles both edges, pixels and integer extremes");
      for (int maxWidth : preferred) {
        int expected = expectedSample(width, height, maxWidth), sample = VisionPreviewDecoder.sampleSize(width, height, maxWidth);
        check(sample == expected, "sampling is the smallest expressible positive power of two satisfying width and hard memory limits");
        check(sample == 0 || (sample > 0 && (sample & (sample - 1)) == 0), "sampling cannot overflow into zero/negative invalid powers");
      }
    }
    check(VisionPreviewDecoder.sampleSize(4000, 3000, 1100) == 4 && VisionPreviewDecoder.sampleSize(3000, 4000, 1100) == 2, "ordinary 12MP preview/OCR keeps the prior preferred-width quality");
    check(VisionPreviewDecoder.sampleSize(Integer.MAX_VALUE, Integer.MAX_VALUE, 1) == 0, "impossible extreme sample returns failure instead of overflowing or looping");
    for (int[] shape : new int[][] { { 800, 20000 }, { 20000, 800 }, { 5000, 5000 }, { 4097, 1024 }, { 2049, 2049 } }) {
      reset(shape[0], shape[1], 1); Bitmap result = VisionPreviewDecoder.decode(IMAGE, 1100);
      check(result != null && result.getWidth() <= 1650 && result.getHeight() <= 4096 && (long) result.getWidth() * result.getHeight() <= 4194304L, "large landscape, portrait and square outputs satisfy decoded bounds");
      check(BitmapFactory.lastSample == expectedSample(shape[0], shape[1], 1100) && !BitmapFactory.lastScaled && BitmapFactory.lastConfig == Bitmap.Config.ARGB_8888, "decoder applies planned sample and explicit unscaled ARGB configuration"); ownedOnly(result);
    }
    String[] pixels = { "ABCDEF", "CBAFED", "FEDCBA", "DEFABC", "ADBECF", "DAEBFC", "FCEBDA", "CFBEAD" };
    for (int orientation = 1; orientation <= 8; orientation++) {
      reset(3, 2, orientation); Bitmap result = VisionPreviewDecoder.decode(IMAGE, 1100);
      check(result != null && pixels[orientation - 1].equals(result.pixels), "EXIF transform matches independent asymmetric 3x2 pixel oracle");
      check(result.getWidth() == (orientation >= 5 ? 2 : 3) && result.getHeight() == (orientation >= 5 ? 3 : 2), "EXIF transpose/quarter-turn output swaps dimensions");
      check(Bitmap.transforms == (orientation == 1 ? 0 : 1), "only non-identity EXIF requires a transformed output"); ownedOnly(result);
      check(Matrix.created == (orientation == 1 ? 0 : 1), "normal EXIF avoids even allocating an identity Matrix");
    }
    for (int orientation : new int[] { 0, -1, 9, Integer.MAX_VALUE }) {
      reset(3, 2, orientation); Bitmap result = VisionPreviewDecoder.decode(IMAGE, 1100);
      check(result != null && "ABCDEF".equals(result.pixels) && Bitmap.transforms == 0 && Matrix.created == 0, "unknown EXIF metadata is treated as allocation-free identity"); ownedOnly(result);
    }
    reset(1500, 2000, 6); Bitmap rotatedPortrait = VisionPreviewDecoder.decode(IMAGE, 1100);
    check(rotatedPortrait != null && rotatedPortrait.getWidth() == 2000 && BitmapFactory.lastSample == 1, "rotation checks hard memory limits without reapplying original width preference and lowering quality"); ownedOnly(rotatedPortrait);
    reset(800, 1200, 6); Bitmap.returnSame = true; Bitmap same = VisionPreviewDecoder.decode(IMAGE, 1100);
    check(same == Bitmap.allocated.get(0) && same.recycles == 0, "platform transform alias remains owned by successful caller"); ownedOnly(same);

    for (int[] invalid : new int[][] { { 0, 1200 }, { 800, -1 }, { -1, -1 } }) {
      reset(invalid[0], invalid[1], 1);
      check(VisionPreviewDecoder.decode(IMAGE, 1100) == null && BitmapFactory.pixelDecodes == 0, "invalid bounds never invoke pixel decode");
    }
    reset(800, 1200, 1);
    check(VisionPreviewDecoder.decode(null, 1100) == null && VisionPreviewDecoder.decode(IMAGE, 0) == null && BitmapFactory.boundsReads == 0, "invalid request arguments avoid all bitmap work");
    for (int failure = 1; failure <= 2; failure++) {
      reset(800, 1200, 1); BitmapFactory.boundsFailure = failure;
      check(VisionPreviewDecoder.decode(IMAGE, 1100) == null && BitmapFactory.pixelDecodes == 0, "bounds OOM/runtime errors return unavailable without pixel allocation");
      reset(800, 1200, 6); ExifInterface.failure = failure;
      check(VisionPreviewDecoder.decode(IMAGE, 1100) == null && BitmapFactory.pixelDecodes == 0, "EXIF OOM/IOException returns unavailable instead of uncorrected image");
    }
    reset(800, 1200, 1); BitmapFactory.returnNull = true;
    check(VisionPreviewDecoder.decode(IMAGE, 1100) == null && BitmapFactory.pixelDecodes == 1, "null codec output terminates gracefully");
    reset(800, 1200, 6); Bitmap.transformNull = true;
    check(VisionPreviewDecoder.decode(IMAGE, 1100) == null && BitmapFactory.pixelDecodes == 1, "null transform never falls back to wrongly oriented source"); ownedOnly(null);
    for (int phase = 0; phase < 2; phase++) {
      reset(800, 1200, 6);
      if (phase == 0) BitmapFactory.decodeFailure = 2; else Bitmap.transformFailure = 2;
      check(VisionPreviewDecoder.decode(IMAGE, 1100) == null && BitmapFactory.pixelDecodes == 1, "runtime codec or transform failure does not retry or expose wrong orientation"); ownedOnly(null);
    }
    for (int phase = 0; phase < 2; phase++) for (boolean persistent : new boolean[] { false, true }) {
      reset(800, 1200, 6);
      if (phase == 0) { BitmapFactory.decodeFailure = 1; BitmapFactory.decodeFailureAttempts = persistent ? Integer.MAX_VALUE : 1; }
      else { Bitmap.transformFailure = 1; Bitmap.transformFailureAttempts = persistent ? Integer.MAX_VALUE : 1; }
      Bitmap result = VisionPreviewDecoder.decode(IMAGE, 1100);
      check((result == null) == persistent && BitmapFactory.pixelDecodes == (persistent ? 3 : 2), "decode/transform OOM retries are bounded and can recover with less memory");
      for (int index = 1; index < BitmapFactory.samples.size(); index++) check(BitmapFactory.samples.get(index) == BitmapFactory.samples.get(index - 1) * 2, "each allocation retry doubles sampling");
      ownedOnly(result);
    }
    for (int budget = 0; budget < 4; budget++) for (boolean persistent : new boolean[] { false, true }) {
      reset(5000, 5000, budget >= 2 ? 6 : 1);
      int attempts = persistent ? Integer.MAX_VALUE : 1;
      if (budget == 0) BitmapFactory.oversizedAttempts = attempts;
      else if (budget == 1) BitmapFactory.extraAllocationAttempts = attempts;
      else if (budget == 2) Bitmap.transformOversizedAttempts = attempts;
      else Bitmap.transformExtraAllocationAttempts = attempts;
      Bitmap result = VisionPreviewDecoder.decode(IMAGE, 1100);
      check((result == null) == persistent && BitmapFactory.pixelDecodes == (persistent ? 3 : 2), "actual decoded/transformed geometry or allocation beyond budget retries and never escapes as success: budget=" + budget + ", persistent=" + persistent);
      if (result != null) check(result.getAllocationByteCount() <= 16777216, "successful bitmap allocation is bounded independently of requested config");
      ownedOnly(result);
    }
    reset(800, 1200, 6); BitmapFactory.extraAllocationAttempts = 1;
    Bitmap allocationBeforeTransform = VisionPreviewDecoder.decode(IMAGE, 1100);
    check(allocationBeforeTransform != null && BitmapFactory.pixelDecodes == 2 && Bitmap.transforms == 1, "oversized decoded allocation is rejected before allocating an oriented copy"); ownedOnly(allocationBeforeTransform);
    for (int allocation : new int[] { 0, -1, 16777216, 16777217 }) {
      reset(800, 1200, 1); BitmapFactory.forcedAllocation = allocation;
      Bitmap result = VisionPreviewDecoder.decode(IMAGE, 1100);
      check((result != null) == (allocation == 16777216), "actual allocation must be positive and no greater than the exact 16MiB boundary"); ownedOnly(result);
    }
    reset(1, 1, 1); BitmapFactory.decodeFailure = 1;
    check(VisionPreviewDecoder.decode(IMAGE, 1100) == null && BitmapFactory.pixelDecodes == 1, "one-pixel allocation failure cannot retry meaninglessly");

    reset(800, 1200, 1); ProductionPreviewHost accepted = new ProductionPreviewHost(); accepted.confirmCapturedDocument(IMAGE);
    check(accepted.accepted == 1 && accepted.retried == 0 && Bitmap.allocated.get(0).recycles == 1, "Activity accepted bank-card path releases its preview");
    for (int failure = 0; failure < 3; failure++) {
      reset(800, 1200, 1); ProductionPreviewHost bad = new ProductionPreviewHost();
      if (failure == 0) bad.quality = "光线偏暗"; else bad.qualityFailure = failure;
      bad.confirmCapturedDocument(IMAGE);
      check(bad.retried == 1 && bad.accepted == 0 && bad.ocr == 0 && Bitmap.allocated.get(0).recycles == 1, "quality rejection, OOM or runtime failure releases preview before retry without handoff");
    }
    reset(800, 1200, 1); BitmapFactory.decodeFailure = 1; ProductionPreviewHost absent = new ProductionPreviewHost(); absent.confirmCapturedDocument(IMAGE);
    check(absent.retried == 1 && absent.accepted == 0 && Bitmap.allocated.isEmpty(), "decoder exhaustion is handled as unavailable capture preview");
    for (boolean synchronous : new boolean[] { false, true }) {
      reset(800, 1200, 1); ProductionPreviewHost ocr = new ProductionPreviewHost(); ocr.step = PreviewHostBase.Step.ID_FRONT; ocr.synchronousHandoffRelease = synchronous;
      ocr.confirmCapturedDocument(IMAGE);
      check(ocr.ocr == 1 && ocr.retried == 0 && ocr.handedOff.recycles == (synchronous ? 1 : 0), "Activity transfers successful OCR preview ownership without premature or duplicate recycling");
      if (!synchronous) ocr.handedOff.recycle(); check(ocr.handedOff.recycles == 1, "OCR boundary owns exactly one eventual release");
    }
    for (int failure = 1; failure <= 2; failure++) {
      reset(800, 1200, 1); ProductionPreviewHost beforeHandoff = new ProductionPreviewHost(); beforeHandoff.step = PreviewHostBase.Step.ID_BACK; beforeHandoff.handoffFailure = failure;
      beforeHandoff.confirmCapturedDocument(IMAGE);
      check(beforeHandoff.retried == 1 && beforeHandoff.handedOff == null && Bitmap.allocated.get(0).recycles == 1, "failure before OCR takes ownership remains Activity cleanup responsibility");
    }
    reset(800, 1200, 1); ProductionPreviewHost paused = new ProductionPreviewHost(); paused.captureLifecycle.suspend(VisionCaptureLifecycle.BACKGROUND); paused.confirmCapturedDocument(IMAGE);
    check(BitmapFactory.boundsReads == 0 && paused.retried == 0 && paused.accepted == 0, "inactive capture rejects confirmation before decoding");
    reset(800, 1200, 1); ProductionPreviewHost pausedDuringQuality = new ProductionPreviewHost();
    pausedDuringQuality.qualityHook = () -> pausedDuringQuality.captureLifecycle.suspend(VisionCaptureLifecycle.BACKGROUND);
    pausedDuringQuality.confirmCapturedDocument(IMAGE);
    check(pausedDuringQuality.retried == 0 && pausedDuringQuality.accepted == 0 && pausedDuringQuality.ocr == 0 && Bitmap.allocated.get(0).recycles == 1, "ownership becoming stale during preparation releases preview without promoting or updating UI");
    System.out.println("vision-preview-verification: " + (checks - before) + " full decoder/plan/EXIF pixel/Activity ownership checks passed");
  }
  public static void main(String[] args) {
    if (args.length > 0) { legacySafety(args[0]); return; }
    legacyEvidence();
    productionChecks();
  }
}
