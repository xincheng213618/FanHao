package local.fanhao.library;

import android.net.Uri;

/** Server-baseline and UTF-8-safe endpoint helpers for native actions. */
final class NativeShortVideoActionClient {
  private NativeShortVideoActionClient() {}

  static boolean serverAction(ShortVideoItem item, NativeShortVideoActionState.Type type) {
    return item != null && (type == NativeShortVideoActionState.Type.LIKE ? item.userLiked : item.userCollected);
  }

  static String endpoint(String serverScope, String videoId, NativeShortVideoActionState.Type type) {
    if (!NativeShortVideoActionState.isServerVideoId(videoId) || serverScope == null || serverScope.length() == 0) return "";
    return serverScope + "/api/short-videos/" + Uri.encode(videoId) + "/actions/" + type.wireName;
  }
}
