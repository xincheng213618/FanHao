package local.fanhao.library;

import android.os.Bundle;
import android.webkit.WebSettings;
import android.webkit.WebView;

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
