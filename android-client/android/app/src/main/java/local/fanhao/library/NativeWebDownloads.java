package local.fanhao.library;

import android.os.Bundle;
import androidx.lifecycle.SavedStateHandle;
import androidx.lifecycle.ViewModel;

/** Pending metadata survives recreation; hosts are used only for the current callback. */
public final class NativeWebDownloads extends ViewModel {
  interface Host {
    boolean isAvailable();
    boolean needsStoragePermission();
    boolean shouldExplainStoragePermission();
    void showStoragePermissionRationale();
    void requestStoragePermission();
    long enqueue(NativeWebDownloadRequest request);
    void showMessage(String message);
  }

  private static final String PENDING = "webDownload.pending";
  private static final String EXPLANATION = "webDownload.explanation";
  private final SavedStateHandle state;
  private boolean submitting;
  private boolean cleared;

  public NativeWebDownloads(SavedStateHandle state) {
    this.state = state;
  }

  void request(String url, String userAgent, String contentDisposition, String mimeType, Host host) {
    if (cleared || !host.isAvailable()) return;
    NativeWebDownloadRequest request;
    try {
      request = NativeWebDownloadRequest.create(url, userAgent, contentDisposition, mimeType);
    } catch (RuntimeException invalid) {
      host.showMessage("已阻止不受支持的下载地址");
      return;
    }
    if (submitting || pending() != null) {
      host.showMessage("请先完成当前下载的权限确认");
      return;
    }
    try {
      if (host.needsStoragePermission()) {
        state.set(PENDING, request.toBundle());
        boolean explain = host.shouldExplainStoragePermission();
        state.set(EXPLANATION, explain);
        if (explain) host.showStoragePermissionRationale();
        else host.requestStoragePermission();
      } else {
        submit(request, host);
      }
    } catch (RuntimeException failure) {
      clearPending();
      host.showMessage("无法启动下载，请检查存储权限和系统下载服务后重试");
    }
  }

  void onHostReady(Host host) {
    if (cleared || !host.isAvailable() || pending() == null || !Boolean.TRUE.equals(state.get(EXPLANATION))) return;
    try {
      host.showStoragePermissionRationale();
    } catch (RuntimeException failure) {
      clearPending();
      host.showMessage("无法显示下载权限说明，请重新点击下载");
    }
  }

  void onRationaleResult(boolean accepted, Host host) {
    if (cleared || !host.isAvailable() || pending() == null || !Boolean.TRUE.equals(state.get(EXPLANATION))) return;
    state.set(EXPLANATION, false);
    if (!accepted) {
      clearPending();
      host.showMessage("已取消下载");
      return;
    }
    try {
      host.requestStoragePermission();
    } catch (RuntimeException failure) {
      clearPending();
      host.showMessage("无法请求存储权限，请重新点击下载");
    }
  }

  void onPermissionResult(boolean granted, Host host) {
    if (cleared || !host.isAvailable()) return;
    if (Boolean.TRUE.equals(state.get(EXPLANATION))) return;
    NativeWebDownloadRequest request = pending();
    if (request == null) return;
    // Consume before any external work: duplicate delivery must never enqueue twice.
    clearPending();
    try {
      if (!granted || host.needsStoragePermission()) {
        host.showMessage("未获得存储权限，未开始下载；可在应用权限中开启后重试");
        return;
      }
      submit(request, host);
    } catch (RuntimeException failure) {
      host.showMessage("无法启动下载，请检查存储权限和系统下载服务后重试");
    }
  }

  private NativeWebDownloadRequest pending() {
    Object value = state.get(PENDING);
    if (value == null) return null;
    try {
      if (value instanceof Bundle) return NativeWebDownloadRequest.fromBundle((Bundle) value);
    } catch (RuntimeException invalid) {
      // Restored metadata must meet the same URI and filename policy as new input.
    }
    clearPending();
    return null;
  }

  private void clearPending() {
    state.remove(PENDING);
    state.remove(EXPLANATION);
  }

  private void submit(NativeWebDownloadRequest request, Host host) {
    submitting = true;
    try {
      long id = host.enqueue(request);
      host.showMessage(id > 0 ? "已加入下载队列" : "系统未接受下载，请稍后重试");
    } catch (RuntimeException failure) {
      host.showMessage("无法启动下载，请检查存储权限和系统下载服务后重试");
    } finally {
      submitting = false;
    }
  }

  @Override
  protected void onCleared() {
    cleared = true;
    clearPending();
  }
}
