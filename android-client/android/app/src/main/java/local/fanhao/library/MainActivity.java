package local.fanhao.library;

import android.app.DownloadManager;
import android.content.Intent;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.view.View;
import android.view.Window;
import android.view.WindowInsets;
import android.view.WindowInsetsController;
import android.view.WindowManager;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.URLUtil;
import android.widget.Toast;

import androidx.activity.OnBackPressedCallback;

import com.getcapacitor.BridgeActivity;

import java.net.URLDecoder;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

public class MainActivity extends BridgeActivity {
  @Override
  protected void onCreate(Bundle savedInstanceState) {
    registerPlugin(FanHaoPlayerPlugin.class);
    registerPlugin(FanHaoUpdaterPlugin.class);
    registerPlugin(FanHaoNovelPlugin.class);
    FanHaoNovelPlugin.capturePendingTextIntent(this, getIntent());
    super.onCreate(savedInstanceState);

    showSystemBars();
    configureWebViewPlayback();
    dispatchTextIntentToWebView(getIntent());

    getOnBackPressedDispatcher().addCallback(
      this,
      new OnBackPressedCallback(true) {
        @Override
        public void handleOnBackPressed() {
          dispatchBackToWebView();
        }
      }
    );
  }

  @Override
  public void onBackPressed() {
    dispatchBackToWebView();
  }

  @Override
  public void onResume() {
    super.onResume();
    showSystemBars();
  }

  @Override
  protected void onNewIntent(Intent intent) {
    super.onNewIntent(intent);
    setIntent(intent);
    showSystemBars();
    FanHaoNovelPlugin.capturePendingTextIntent(this, intent);
    dispatchTextIntentToWebView(intent);
  }

  private void showSystemBars() {
    Window window = getWindow();
    if (window == null) return;

    window.clearFlags(WindowManager.LayoutParams.FLAG_FULLSCREEN);
    window.setStatusBarColor(Color.rgb(246, 247, 249));
    window.setNavigationBarColor(Color.WHITE);

    View decor = window.getDecorView();
    int flags = View.SYSTEM_UI_FLAG_LAYOUT_STABLE;
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
      flags |= View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR;
    }
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      flags |= View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR;
    }
    decor.setSystemUiVisibility(flags);

    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
      WindowInsetsController controller = window.getInsetsController();
      if (controller != null) {
        controller.show(WindowInsets.Type.statusBars() | WindowInsets.Type.navigationBars());
      }
    }
  }

  private void configureWebViewPlayback() {
    WebView webView = getBridge() == null ? null : getBridge().getWebView();
    if (webView == null) return;

    WebSettings settings = webView.getSettings();
    settings.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
    settings.setMediaPlaybackRequiresUserGesture(false);
    String userAgent = settings.getUserAgentString();
    if (userAgent == null || !userAgent.contains("FanHaoAndroidApp/")) {
      settings.setUserAgentString((userAgent == null ? "" : userAgent) + " FanHaoAndroidApp/1");
    }
    webView.setDownloadListener((url, userAgentValue, contentDisposition, mimeType, contentLength) -> {
      DownloadManager downloadManager = (DownloadManager) getSystemService(DOWNLOAD_SERVICE);
      if (downloadManager == null) {
        Toast.makeText(this, "无法启动系统下载", Toast.LENGTH_SHORT).show();
        return;
      }

      Uri uri = Uri.parse(url);
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
    });
  }

  private String resolveDownloadFileName(Uri uri, String contentDisposition, String mimeType) {
    String fromHeader = contentDispositionFileName(contentDisposition);
    if (fromHeader != null && !fromHeader.trim().isEmpty()) {
      return sanitizeDownloadFileName(fromHeader);
    }

    String fromQuery = uri.getQueryParameter("filename");
    if (fromQuery != null && !fromQuery.trim().isEmpty()) {
      return sanitizeDownloadFileName(fromQuery);
    }

    return sanitizeDownloadFileName(URLUtil.guessFileName(uri.toString(), contentDisposition, mimeType));
  }

  private String contentDispositionFileName(String contentDisposition) {
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

    Matcher quoted = Pattern
      .compile("filename\\s*=\\s*\"([^\"]+)\"", Pattern.CASE_INSENSITIVE)
      .matcher(contentDisposition);
    if (quoted.find()) return quoted.group(1);

    Matcher bare = Pattern
      .compile("filename\\s*=\\s*([^;]+)", Pattern.CASE_INSENSITIVE)
      .matcher(contentDisposition);
    if (bare.find()) return bare.group(1);

    return null;
  }

  private String sanitizeDownloadFileName(String fileName) {
    String clean = fileName == null ? "" : fileName.replaceAll("[\\\\/:*?\"<>|\\r\\n]+", "_").trim();
    return clean.isEmpty() ? "download.txt" : clean;
  }

  private void dispatchBackToWebView() {
    WebView webView = getBridge() == null ? null : getBridge().getWebView();
    if (webView == null) {
      moveTaskToBack(true);
      return;
    }

    webView.evaluateJavascript(
      "(function(){return !!(window.fanhaoHandleNativeBack && window.fanhaoHandleNativeBack());})()",
      handled -> {
        if (!"true".equals(handled)) {
          moveTaskToBack(true);
        }
      }
    );
  }

  private void dispatchTextIntentToWebView(Intent intent) {
    if (!FanHaoNovelPlugin.shouldHandleTextIntent(this, intent)) return;
    WebView webView = getBridge() == null ? null : getBridge().getWebView();
    if (webView == null) return;
    String script = "window.dispatchEvent(new CustomEvent('fanhaoNativeTextFile'));";
    int[] delays = new int[] { 0, 500, 1500, 3000, 6000, 10000, 15000 };
    for (int delay : delays) {
      webView.postDelayed(() -> webView.evaluateJavascript(script, null), delay);
    }
  }
}
