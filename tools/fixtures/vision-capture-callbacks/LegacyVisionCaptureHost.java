package local.fanhao.library;

import java.io.File;

// Frozen before explicit one-outcome CameraX callback ownership and face retry.
// Only method visibility changed so the same synthetic boundaries can execute it.
final class LegacyVisionCaptureHost extends CaptureHostBase {
  @Override
  void takePicture(File output, Runnable success, java.util.function.Consumer<String> failure) {
    long token = captureLifecycle.generation();
    if (!canUseUi(token) || !captureLifecycle.canCapture(token)) return;
    ImageCapture.OutputFileOptions options = new ImageCapture.OutputFileOptions.Builder(output).build();
    try {
      imageCapture.takePicture(options, ContextCompat.getMainExecutor(this), new ImageCapture.OnImageSavedCallback() {
      @Override
      public void onImageSaved(@NonNull ImageCapture.OutputFileResults outputFileResults) {
        if (canUseUi(token) && captureLifecycle.canCapture(token)) success.run();
        else VisionCaptureLifecycle.discardTemporary(output);
      }

      @Override
      public void onError(@NonNull ImageCaptureException exception) {
        VisionCaptureLifecycle.discardTemporary(output);
        if (canUseUi(token) && captureLifecycle.canCapture(token)) failure.accept("拍摄失败：" + exception.getMessage());
      }
      });
    } catch (Exception error) {
      VisionCaptureLifecycle.discardTemporary(output);
      if (canUseUi(token) && captureLifecycle.canCapture(token)) failure.accept("拍摄失败：" + error.getMessage());
    }
  }

  @Override
  void captureVerifiedFace() {
    if (faceCaptureStarted || !canUseUi(captureLifecycle.generation()) || captureLifecycle.isCompleted()) return;
    faceCaptureStarted = true;
    postCaptureUi(captureLifecycle.generation(), () -> {
      updateFaceUi(1f, "动作序列完成，正在保存演示照片", true);
      File output = VisionCaptureLifecycle.temporaryCapture(sessionDirectory);
      takePicture(output, () -> {
        try {
          VisionCaptureLifecycle.promote(output, sessionDirectory, "face-verification.jpg");
          finishFaceSession(new File(sessionDirectory, "face-verification.jpg"));
        } catch (Exception error) {
          VisionCaptureLifecycle.discardTemporary(output);
          showFatal("无法确认人脸演示照片：" + error.getMessage());
        }
      }, message -> {
        faceCaptureStarted = false;
        stableFrames = 0;
        updateFaceUi(0.72f, message + "，请重新正对镜头", false);
      });
    });
  }
}
