package local.fanhao.library;

import android.app.DownloadManager;
import android.os.Bundle;
import android.os.Environment;
import android.net.Uri;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.URLUtil;
import android.widget.Toast;

import androidx.activity.OnBackPressedCallback;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
  @Override
  protected void onCreate(Bundle savedInstanceState) {
    registerPlugin(FanHaoPlayerPlugin.class);
    super.onCreate(savedInstanceState);

    configureWebViewPlayback();

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

      String fileName = URLUtil.guessFileName(url, contentDisposition, mimeType);
      DownloadManager.Request request = new DownloadManager.Request(Uri.parse(url));
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
}
