package local.fanhao.library;

import java.net.URI;
import java.net.URL;
import java.util.Locale;

final class AndroidUpdatePolicy {
  private static final String UPDATE_PATH_PREFIX = "/api/android/update/apk/";

  private AndroidUpdatePolicy() {}

  static String requireSha256(String value) {
    String normalized = value == null ? "" : value.trim().toLowerCase(Locale.ROOT);
    if (!normalized.matches("[0-9a-f]{64}")) {
      throw new IllegalArgumentException("APK 更新必须提供有效的 SHA-256");
    }
    return normalized;
  }

  static URL requireTrustedDownloadUrl(String rawUrl, String rawServiceBase) {
    URI download = requireHttpUri(rawUrl, "APK 下载地址");
    URI serviceBase = requireHttpUri(rawServiceBase, "服务地址");
    if (!sameOrigin(download, serviceBase)) {
      throw new IllegalArgumentException("APK 下载地址必须与当前服务同源");
    }

    String rawPath = download.getRawPath();
    String lowerPath = rawPath == null ? "" : rawPath.toLowerCase(Locale.ROOT);
    boolean expectedPath = lowerPath.matches("^/api/android/update/apk/(debug|release)/[^/]+\\.apk$");
    boolean encodedTraversal = lowerPath.contains("%2e")
      || lowerPath.contains("%2f")
      || lowerPath.contains("%5c")
      || lowerPath.contains("%00");
    if (!expectedPath || !lowerPath.startsWith(UPDATE_PATH_PREFIX) || lowerPath.contains("..") || encodedTraversal) {
      throw new IllegalArgumentException("APK 下载地址不属于受信任的更新路径");
    }
    if (download.getRawQuery() != null || download.getRawFragment() != null) {
      throw new IllegalArgumentException("APK 下载地址不能包含查询参数或片段");
    }

    try {
      return download.toURL();
    } catch (Exception error) {
      throw new IllegalArgumentException("APK 下载地址无效", error);
    }
  }

  private static URI requireHttpUri(String value, String label) {
    String normalized = value == null ? "" : value.trim();
    if (normalized.isEmpty()) throw new IllegalArgumentException("缺少" + label);
    try {
      URI uri = new URI(normalized);
      String scheme = uri.getScheme() == null ? "" : uri.getScheme().toLowerCase(Locale.ROOT);
      if (!("http".equals(scheme) || "https".equals(scheme))) {
        throw new IllegalArgumentException(label + "只支持 HTTP/HTTPS");
      }
      if (!uri.isAbsolute() || uri.getHost() == null || uri.getHost().trim().isEmpty() || uri.getUserInfo() != null) {
        throw new IllegalArgumentException(label + "无效");
      }
      return uri;
    } catch (IllegalArgumentException error) {
      throw error;
    } catch (Exception error) {
      throw new IllegalArgumentException(label + "无效", error);
    }
  }

  private static boolean sameOrigin(URI left, URI right) {
    return left.getScheme().equalsIgnoreCase(right.getScheme())
      && left.getHost().equalsIgnoreCase(right.getHost())
      && effectivePort(left) == effectivePort(right);
  }

  private static int effectivePort(URI uri) {
    if (uri.getPort() >= 0) return uri.getPort();
    return "https".equalsIgnoreCase(uri.getScheme()) ? 443 : 80;
  }
}
