package local.fanhao.library;

/** Pure URL selection for original/open/share actions. */
final class NativeShortVideoLinks {
  private NativeShortVideoLinks() {}

  static String originalUrl(ShortVideoItem item) {
    if (item == null) return "";
    String awemeId = item.awemeId.length() > 0 ? item.awemeId : item.id;
    if (awemeId.matches("\\d{8,}")) return "https://www.douyin.com/video/" + awemeId;
    String url = item.originalUrl.length() > 0 ? item.originalUrl : item.shareUrl;
    return httpUrl(url) ? url : "";
  }

  static String shareUrl(ShortVideoItem item) {
    String original = originalUrl(item);
    if (original.length() > 0) return original;
    return item != null && httpUrl(item.streamUrl) ? item.streamUrl : "";
  }

  private static boolean httpUrl(String value) {
    return value != null && (value.startsWith("http://") || value.startsWith("https://"));
  }
}
