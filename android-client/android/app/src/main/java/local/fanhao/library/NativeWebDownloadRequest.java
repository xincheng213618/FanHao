package local.fanhao.library;

import android.net.Uri;
import android.os.Bundle;
import android.webkit.URLUtil;
import java.net.URLDecoder;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/** Immutable, validated metadata; no WebView or Activity survives a permission prompt. */
final class NativeWebDownloadRequest {
  final Uri uri;
  final String userAgent;
  final String fileName;
  final String mimeType;

  private NativeWebDownloadRequest(Uri uri, String userAgent, String fileName, String mimeType) {
    if (!isSupportedWebDownloadUri(uri)) throw new IllegalArgumentException("Unsupported download URI");
    this.uri = uri.normalizeScheme();
    this.userAgent = userAgent == null ? "" : userAgent;
    this.fileName = sanitizeDownloadFileName(fileName);
    this.mimeType = mimeType == null || mimeType.isEmpty() ? "application/octet-stream" : mimeType;
  }

  static NativeWebDownloadRequest create(String url, String userAgent, String contentDisposition, String mimeType) {
    Uri uri = url == null ? null : Uri.parse(url);
    if (!isSupportedWebDownloadUri(uri)) throw new IllegalArgumentException("Unsupported download URI");
    return new NativeWebDownloadRequest(uri, userAgent, resolveDownloadFileName(uri, contentDisposition, mimeType), mimeType);
  }

  Bundle toBundle() {
    Bundle bundle = new Bundle();
    bundle.putString("url", uri.toString());
    bundle.putString("userAgent", userAgent);
    bundle.putString("fileName", fileName);
    bundle.putString("mimeType", mimeType);
    return bundle;
  }

  static NativeWebDownloadRequest fromBundle(Bundle bundle) {
    String url = bundle.getString("url");
    return new NativeWebDownloadRequest(url == null ? null : Uri.parse(url), bundle.getString("userAgent"),
      bundle.getString("fileName"), bundle.getString("mimeType"));
  }

  private static boolean isSupportedWebDownloadUri(Uri uri) {
    if (uri == null) return false;
    String scheme = uri.getScheme();
    String host = uri.getHost();
    boolean supportedScheme = "http".equalsIgnoreCase(scheme) || "https".equalsIgnoreCase(scheme);
    return supportedScheme && host != null && !host.trim().isEmpty() && uri.getUserInfo() == null;
  }

  private static String resolveDownloadFileName(Uri uri, String contentDisposition, String mimeType) {
    String fromHeader = contentDispositionFileName(contentDisposition);
    if (fromHeader != null && !fromHeader.trim().isEmpty()) return sanitizeDownloadFileName(fromHeader);
    String fromQuery = uri.getQueryParameter("filename");
    if (fromQuery != null && !fromQuery.trim().isEmpty()) return sanitizeDownloadFileName(fromQuery);
    return sanitizeDownloadFileName(URLUtil.guessFileName(uri.toString(), contentDisposition, mimeType));
  }

  private static String contentDispositionFileName(String contentDisposition) {
    if (contentDisposition == null || contentDisposition.trim().isEmpty()) return null;
    Matcher encoded = Pattern
      .compile("filename\\*\\s*=\\s*(?:UTF-8'')?\"?([^\";]+)\"?", Pattern.CASE_INSENSITIVE)
      .matcher(contentDisposition);
    if (encoded.find()) {
      try {
        return URLDecoder.decode(encoded.group(1), "UTF-8");
      } catch (Exception ignored) {
        return encoded.group(1);
      }
    }
    Matcher quoted = Pattern.compile("filename\\s*=\\s*\"([^\"]+)\"", Pattern.CASE_INSENSITIVE).matcher(contentDisposition);
    if (quoted.find()) return quoted.group(1);
    Matcher bare = Pattern.compile("filename\\s*=\\s*([^;]+)", Pattern.CASE_INSENSITIVE).matcher(contentDisposition);
    return bare.find() ? bare.group(1) : null;
  }

  private static String sanitizeDownloadFileName(String fileName) {
    String clean = fileName == null ? "" : fileName.replaceAll("[\\\\/:*?\"<>|\\p{Cntrl}]+", "_").trim();
    return clean.isEmpty() || clean.equals(".") || clean.equals("..") ? "download.txt" : clean;
  }
}
