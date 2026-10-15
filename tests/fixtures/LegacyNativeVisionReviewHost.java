package local.fanhao.library;

import java.io.File;
import java.util.ArrayList;

// Frozen before review operation ownership/chooser result handling. Method bodies
// below are copied unchanged from NativeVisionExplorationActivity.java; only the
// enclosing test host and these public test adapters are synthetic.
class LegacyNativeVisionReviewHost extends ReviewHostBase {
  void exportForTest(String sessionId) { shareArchivedSession(sessionId); }
  void deleteForTest(String sessionId) { confirmDeleteArchivedSession(sessionId); }
  void finishForTest(boolean deleted) { finishReview(deleted); }

  private void shareArchivedSession(String sessionId) {
    try {
      JSONObject manifest = VisionExplorationStore.getCompletedSession(this, sessionId);
      File directory = VisionExplorationStore.resolveSessionDirectory(this, sessionId);
      JSONArray files = manifest.getJSONArray("files");
      ArrayList<Uri> uris = new ArrayList<>();
      for (int index = 0; index < files.length(); index++) {
        String fileName = files.getJSONObject(index).getString("name");
        File file = VisionExplorationStore.resolveSessionFile(directory, fileName);
        uris.add(FileProvider.getUriForFile(this, getPackageName() + ".fileprovider", file));
      }
      if (uris.isEmpty()) throw new IllegalStateException("本次记录没有可导出的照片");

      Intent share = new Intent(uris.size() == 1 ? Intent.ACTION_SEND : Intent.ACTION_SEND_MULTIPLE);
      share.setType("image/jpeg");
      share.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
      if (uris.size() == 1) share.putExtra(Intent.EXTRA_STREAM, uris.get(0));
      else share.putParcelableArrayListExtra(Intent.EXTRA_STREAM, uris);
      ClipData clipData = ClipData.newUri(getContentResolver(), "视觉技术探索照片", uris.get(0));
      for (int index = 1; index < uris.size(); index++) clipData.addItem(new ClipData.Item(uris.get(index)));
      share.setClipData(clipData);
      startActivity(Intent.createChooser(share, "导出本次演示照片"));
    } catch (Exception error) {
      new AlertDialog.Builder(this)
        .setTitle("无法导出")
        .setMessage(error.getMessage())
        .setPositiveButton("知道了", null)
        .show();
    }
  }

  private void confirmDeleteArchivedSession(String sessionId) {
    new AlertDialog.Builder(this)
      .setTitle("删除本次记录？")
      .setMessage("身份证、银行卡或人脸演示照片将从本机永久删除。")
      .setPositiveButton("删除", (dialog, which) -> {
        try {
          if (!VisionExplorationStore.deleteSession(this, sessionId)) {
            throw new IllegalStateException("记录不存在或已经删除");
          }
          finishReview(true);
        } catch (Exception error) {
          showFatal("无法删除本地演示记录：" + error.getMessage());
        }
      })
      .setNegativeButton("取消", null)
      .show();
  }

  private void finishReview(boolean deleted) {
    if (terminalResult) return;
    Intent data = new Intent();
    data.putExtra(RESULT_DELETED, deleted);
    terminalResult = true;
    setResult(Activity.RESULT_OK, data);
    finish();
  }

  protected void onPause() {
    suspendCapture(VisionCaptureLifecycle.BACKGROUND);
    dismissCaptureDialog();
    super.onPause();
  }

  private void suspendCapture(int reason) {
    captureLifecycle.suspend(reason);
    captureHandler.removeCallbacksAndMessages(null);
    unbindCamera();
  }

  private void dismissCaptureDialog() {
    AlertDialog dialog = captureDialog;
    captureDialog = null;
    if (dialog != null) dialog.dismiss();
  }

  protected void onDestroy() {
    if (captureLifecycle.destroy()) {
      captureHandler.removeCallbacksAndMessages(null);
      dismissCaptureDialog();
      unbindCamera();
      if (faceDetector != null) faceDetector.close();
      if (textRecognizer != null) textRecognizer.close();
      // Drain already queued analyzers: they see the destroyed owner and close their frames.
      if (cameraExecutor != null) cameraExecutor.shutdown();
      // Session files belong to the workflow, not this Activity instance. Only explicit
      // cancellation discards them; configuration/process recreation restores the checkpoint.
    }
    super.onDestroy();
  }
}
