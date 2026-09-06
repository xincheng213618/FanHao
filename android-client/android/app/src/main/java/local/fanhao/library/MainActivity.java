package local.fanhao.library;

import android.Manifest;
import android.app.AlertDialog;
import android.app.DownloadManager;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Color;
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
import android.widget.Toast;

import androidx.activity.OnBackPressedCallback;
import androidx.activity.result.ActivityResultLauncher;
import androidx.activity.result.contract.ActivityResultContracts;
import androidx.lifecycle.Lifecycle;
import androidx.lifecycle.SavedStateHandleSupport;
import androidx.lifecycle.ViewModelProvider;
import androidx.lifecycle.viewmodel.MutableCreationExtras;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
  private NativeWebDownloads webDownloads;
  private ActivityResultLauncher<String> downloadPermissionLauncher;
  private AlertDialog downloadPermissionExplanation;
  private final NativeWebDownloads.Host webDownloadHost = new NativeWebDownloads.Host() {
    @Override public boolean isAvailable() {
      return !isFinishing() && !isDestroyed() && getLifecycle().getCurrentState().isAtLeast(Lifecycle.State.STARTED);
    }

    @Override public boolean needsStoragePermission() {
      return Build.VERSION.SDK_INT <= Build.VERSION_CODES.P
        && checkSelfPermission(Manifest.permission.WRITE_EXTERNAL_STORAGE) != PackageManager.PERMISSION_GRANTED;
    }

    @Override public boolean shouldExplainStoragePermission() {
      return shouldShowRequestPermissionRationale(Manifest.permission.WRITE_EXTERNAL_STORAGE);
    }

    @Override public void showStoragePermissionRationale() {
      if (downloadPermissionExplanation != null) return;
      downloadPermissionExplanation = new AlertDialog.Builder(MainActivity.this)
        .setTitle("保存下载文件")
        .setMessage("安卓 9 及以下需要存储权限，才能将所选文件保存到系统“下载”目录。是否继续？")
        .setPositiveButton("继续", (dialog, which) -> webDownloads.onRationaleResult(true, webDownloadHost))
        .setNegativeButton("取消", (dialog, which) -> webDownloads.onRationaleResult(false, webDownloadHost))
        .setOnCancelListener(dialog -> webDownloads.onRationaleResult(false, webDownloadHost))
        .create();
      downloadPermissionExplanation.setOnDismissListener(dialog -> downloadPermissionExplanation = null);
      try {
        downloadPermissionExplanation.show();
      } catch (RuntimeException failure) {
        downloadPermissionExplanation.setOnDismissListener(null);
        downloadPermissionExplanation = null;
        throw failure;
      }
    }

    @Override public void requestStoragePermission() {
      downloadPermissionLauncher.launch(Manifest.permission.WRITE_EXTERNAL_STORAGE);
    }

    @Override public long enqueue(NativeWebDownloadRequest download) {
      DownloadManager manager = (DownloadManager) getSystemService(DOWNLOAD_SERVICE);
      if (manager == null) throw new IllegalStateException("Download service unavailable");
      DownloadManager.Request request = new DownloadManager.Request(download.uri);
      if (!download.userAgent.isEmpty()) request.addRequestHeader("User-Agent", download.userAgent);
      request.setTitle(download.fileName);
      request.setDescription("FanHao 下载");
      request.setMimeType(download.mimeType);
      request.setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);
      request.setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, download.fileName);
      return manager.enqueue(request);
    }

    @Override public void showMessage(String message) {
      Toast.makeText(MainActivity.this, message, Toast.LENGTH_SHORT).show();
    }
  };

  @Override
  protected void onCreate(Bundle savedInstanceState) {
    registerPlugin(FanHaoAuthPlugin.class);
    registerPlugin(FanHaoPlayerPlugin.class);
    registerPlugin(FanHaoSystemPlugin.class);
    registerPlugin(FanHaoUpdaterPlugin.class);
    registerPlugin(FanHaoNovelPlugin.class);
    registerPlugin(FanHaoVisionExplorationPlugin.class);
    FanHaoNovelPlugin.capturePendingTextIntent(this, getIntent());
    super.onCreate(savedInstanceState);
    if (getBridge() != null) getBridge().setWebViewClient(
      new AuthenticatedWebViewClient(getBridge(), FanHaoAuthPlugin.install(this))
    );

    // Keep restored state/owners, but never seed download state from this exported Activity's Intent.
    MutableCreationExtras downloadExtras = new MutableCreationExtras(getDefaultViewModelCreationExtras());
    downloadExtras.set(SavedStateHandleSupport.DEFAULT_ARGS_KEY, new Bundle());
    webDownloads = new ViewModelProvider(getViewModelStore(), getDefaultViewModelProviderFactory(), downloadExtras)
      .get(NativeWebDownloads.class);
    downloadPermissionLauncher = getActivityResultRegistry().register(
      "local.fanhao.library.web-download.storage", this, new ActivityResultContracts.RequestPermission(),
      granted -> webDownloads.onPermissionResult(Boolean.TRUE.equals(granted), webDownloadHost)
    );

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
  public void onResume() {
    super.onResume();
    showSystemBars();
    if (webDownloads != null) webDownloads.onHostReady(webDownloadHost);
  }

  @Override
  public void onDestroy() {
    if (downloadPermissionExplanation != null) {
      downloadPermissionExplanation.setOnDismissListener(null);
      downloadPermissionExplanation.dismiss();
      downloadPermissionExplanation = null;
    }
    super.onDestroy();
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

    // WebView edge stretch moves the whole surface, including CSS-fixed navigation.
    // Disable only this edge effect; normal page scrolling remains enabled.
    webView.setOverScrollMode(View.OVER_SCROLL_NEVER);

    WebSettings settings = webView.getSettings();
    settings.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
    settings.setMediaPlaybackRequiresUserGesture(false);
    String userAgent = settings.getUserAgentString();
    if (userAgent == null || !userAgent.contains("FanHaoAndroidApp/")) {
      settings.setUserAgentString((userAgent == null ? "" : userAgent) + " FanHaoAndroidApp/1");
    }
    webView.setDownloadListener((url, userAgentValue, contentDisposition, mimeType, contentLength) -> {
      webDownloads.request(url, userAgentValue, contentDisposition, mimeType, webDownloadHost);
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
