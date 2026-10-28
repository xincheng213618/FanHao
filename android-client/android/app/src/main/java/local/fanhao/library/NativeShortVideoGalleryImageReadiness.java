package local.fanhao.library;

/** One versioned image's visible reading budget; a zero budget stays expired. */
final class NativeShortVideoGalleryImageReadiness {
  final String key;
  boolean ready;
  boolean loading, failed, retrying;
  long attempt;
  long retryStatusGeneration;
  long remainingMs;

  NativeShortVideoGalleryImageReadiness(String key, long durationMs) {
    this.key = key;
    remainingMs = Math.max(0L, durationMs);
  }
}
