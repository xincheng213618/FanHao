package local.fanhao.library;

import java.net.URI;
import java.net.URL;
import java.util.Collections;
import java.util.LinkedHashSet;
import java.util.Locale;
import java.util.Set;

final class AndroidUpdatePolicy {
  private static final String UPDATE_PATH_PREFIX = "/api/android/update/apk/";
  private static final int MAX_APK_SIZE_BYTES = 512 * 1024 * 1024;

  private AndroidUpdatePolicy() {}

  static String requireSha256(String value) {
    String normalized = value == null ? "" : value.trim().toLowerCase(Locale.ROOT);
    if (!normalized.matches("[0-9a-f]{64}")) {
      throw new IllegalArgumentException("APK 更新必须提供有效的 SHA-256");
    }
    return normalized;
  }

  static long requireExpectedVersionCode(Integer value) {
    if (value == null || value <= 0) {
      throw new IllegalArgumentException("APK 更新必须提供有效的 versionCode");
    }
    return value.longValue();
  }

  static String requireExpectedVersionName(String value) {
    String normalized = value == null ? "" : value.trim();
    if (normalized.isEmpty()) {
      throw new IllegalArgumentException("APK 更新必须提供有效的 versionName");
    }
    return normalized;
  }

  static long requireExpectedSize(Integer value) {
    if (value == null || value <= 0 || value > MAX_APK_SIZE_BYTES) {
      throw new IllegalArgumentException("APK 更新必须提供合理的文件大小");
    }
    return value.longValue();
  }

  static void requireInstallableUpdate(
    PackageIdentity installed,
    PackageIdentity archive,
    long expectedVersionCode,
    String expectedVersionName
  ) {
    if (!installed.packageName.equals(archive.packageName)) {
      throw new IllegalArgumentException("安装包不是当前 FanHao 应用");
    }
    if (archive.versionCode != expectedVersionCode || !archive.versionName.equals(expectedVersionName)) {
      throw new IllegalArgumentException("安装包版本与更新信息不一致");
    }
    if (archive.versionCode <= installed.versionCode) {
      throw new IllegalArgumentException("安装包版本必须高于当前版本");
    }
    if (!hasTrustedSigningIdentity(installed, archive)) {
      throw new IllegalArgumentException("安装包签名与当前应用不一致");
    }
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

  private static boolean hasTrustedSigningIdentity(PackageIdentity installed, PackageIdentity archive) {
    if (installed.currentSigners.isEmpty() || archive.currentSigners.isEmpty()) return false;
    if (installed.multipleSigners || archive.multipleSigners) {
      return installed.multipleSigners
        && archive.multipleSigners
        && installed.currentSigners.equals(archive.currentSigners);
    }
    return archive.signingHistory.containsAll(installed.currentSigners);
  }

  static final class PackageIdentity {
    final String packageName;
    final long versionCode;
    final String versionName;
    final Set<String> currentSigners;
    final Set<String> signingHistory;
    final boolean multipleSigners;

    PackageIdentity(
      String packageName,
      long versionCode,
      String versionName,
      Set<String> currentSigners,
      Set<String> signingHistory,
      boolean multipleSigners
    ) {
      this.packageName = packageName == null ? "" : packageName.trim();
      this.versionCode = versionCode;
      this.versionName = versionName == null ? "" : versionName;
      this.currentSigners = immutableCopy(currentSigners);
      this.signingHistory = immutableCopy(signingHistory);
      this.multipleSigners = multipleSigners;
    }

    private static Set<String> immutableCopy(Set<String> values) {
      return Collections.unmodifiableSet(new LinkedHashSet<>(values == null ? Collections.emptySet() : values));
    }
  }
}
