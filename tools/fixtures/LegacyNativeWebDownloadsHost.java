package local.fanhao.library;

import android.app.DownloadManager;
import android.net.Uri;
import android.os.Environment;
import android.webkit.URLUtil;
import android.widget.Toast;
import com.getcapacitor.BridgeActivity;
import java.net.URLDecoder;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/** Frozen MainActivity download-listener body and helpers from before the permission fix.
 * The executable verifier must reproduce its SecurityException and false-success bugs. */
final class LegacyNativeWebDownloadsHost extends BridgeActivity {
  void request(String url, String userAgentValue, String contentDisposition, String mimeType) {
    DownloadManager downloadManager = (DownloadManager) getSystemService(DOWNLOAD_SERVICE);
    if (downloadManager == null) {
      Toast.makeText(this, "无法启动系统下载", Toast.LENGTH_SHORT).show();
      return;
    }

    Uri uri = Uri.parse(url);
    if (!isSupportedWebDownloadUri(uri)) {
      Toast.makeText(this, "已阻止不受支持的下载地址", Toast.LENGTH_SHORT).show();
      return;
    }
    String fileName = resolveDownloadFileName(uri, contentDisposition, mimeType);
    DownloadManager.Request request = new DownloadManager.Request(uri);
    if (userAgentValue != null && !userAgentValue.isEmpty()) {
      request.addRequestHeader("User-Agent", userAgentValue);
    }
    request.setTitle(fileName);
    request.setDescription("FanHao 下载");
    request.setMimeType(mimeType == null || mimeType.isEmpty() ? "application/octet-stream" : mimeType);
    request.setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);
    request.setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, fileName);
    downloadManager.enqueue(request);
    Toast.makeText(this, "已加入下载队列", Toast.LENGTH_SHORT).show();
  }

  private boolean isSupportedWebDownloadUri(Uri uri) {
    if (uri == null) return false;
    String scheme = uri.getScheme();
    String host = uri.getHost();
    boolean supportedScheme = "http".equalsIgnoreCase(scheme) || "https".equalsIgnoreCase(scheme);
    return supportedScheme && host != null && !host.trim().isEmpty() && uri.getUserInfo() == null;
  }

  private String resolveDownloadFileName(Uri uri, String contentDisposition, String mimeType) {
    String fromHeader = contentDispositionFileName(contentDisposition);
    if (fromHeader != null && !fromHeader.trim().isEmpty()) return sanitizeDownloadFileName(fromHeader);
    String fromQuery = uri.getQueryParameter("filename");
    if (fromQuery != null && !fromQuery.trim().isEmpty()) return sanitizeDownloadFileName(fromQuery);
    return sanitizeDownloadFileName(URLUtil.guessFileName(uri.toString(), contentDisposition, mimeType));
  }

  private String contentDispositionFileName(String contentDisposition) {
    if (contentDisposition == null || contentDisposition.trim().isEmpty()) return null;
    Matcher encoded = Pattern
      .compile("filename\\*\\s*=\\s*(?:UTF-8'')?\"?([^\";]+)\"?", Pattern.CASE_INSENSITIVE)
      .matcher(contentDisposition);
    if (encoded.find()) {
      try { return URLDecoder.decode(encoded.group(1), "UTF-8"); }
      catch (Exception ignored) { return encoded.group(1); }
    }
    Matcher quoted = Pattern.compile("filename\\s*=\\s*\"([^\"]+)\"", Pattern.CASE_INSENSITIVE).matcher(contentDisposition);
    if (quoted.find()) return quoted.group(1);
    Matcher bare = Pattern.compile("filename\\s*=\\s*([^;]+)", Pattern.CASE_INSENSITIVE).matcher(contentDisposition);
    if (bare.find()) return bare.group(1);
    return null;
  }

  private String sanitizeDownloadFileName(String fileName) {
    String clean = fileName == null ? "" : fileName.replaceAll("[\\\\/:*?\"<>|\\r\\n]+", "_").trim();
    return clean.isEmpty() ? "download.txt" : clean;
  }
}
