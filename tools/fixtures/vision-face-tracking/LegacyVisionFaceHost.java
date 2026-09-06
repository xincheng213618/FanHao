package local.fanhao.library;

import java.util.List;

// Frozen actual Activity methods before face-sequence continuity validation.
// The synthetic host supplies only Face/Rect, detector, UI and camera boundaries.
class LegacyVisionFaceHost extends FaceHostBase {
  void frameForTest(List<Face> faces, int width, int height) { processFaces(faces, width, height); }
  void analyzeForTest(ImageProxy proxy) { analyzeFace(proxy, captureLifecycle.generation()); }

  private void processFaces(List<Face> faces, int width, int height) {
    if (faceCaptureStarted || step != Step.FACE) return;
    if (faces.size() != 1) {
      stableFrames = 0;
      updateFaceUi(0.05f, faces.isEmpty() ? "请将脸移入圆框" : "请保持只有一人入镜", false);
      return;
    }

    Face face = faces.get(0);
    Integer trackingId = face.getTrackingId();
    if (trackingId == null) {
      facePhase = 0;
      stableFrames = 0;
      activeFaceTrackingId = null;
      updateFaceUi(0.05f, "正在建立连续人脸跟踪，请保持正对镜头", false);
      return;
    }
    if (activeFaceTrackingId != null && !activeFaceTrackingId.equals(trackingId)) {
      facePhase = 0;
      stableFrames = 0;
      activeFaceTrackingId = trackingId;
      updateFaceUi(0.05f, "检测到人脸变化，请重新开始动作", false);
      return;
    }
    if (activeFaceTrackingId == null) activeFaceTrackingId = trackingId;

    Rect box = face.getBoundingBox();
    boolean centered = Math.abs(box.centerX() - width / 2f) < width * 0.20f
      && Math.abs(box.centerY() - height / 2f) < height * 0.22f
      && box.width() > width * 0.20f
      && box.width() < width * 0.78f;
    float yaw = face.getHeadEulerAngleY();
    float roll = face.getHeadEulerAngleZ();
    boolean frontal = centered && Math.abs(yaw) < 12f && Math.abs(roll) < 12f;
    Float smileProbability = face.getSmilingProbability();

    if (facePhase == 0) {
      boolean neutralReady = faceChallengeTurn
        || smileProbability != null && smileProbability < 0.45f;
      boolean ready = frontal && neutralReady;
      stableFrames = ready ? stableFrames + 1 : 0;
      float progress = 0.08f + Math.min(1f, stableFrames / 7f) * 0.24f;
      String message;
      if (!frontal) message = "请正对镜头并移到圆框中央";
      else if (!neutralReady) message = "请先放松表情，再按提示完成微笑";
      else message = "已锁定同一张人脸，请保持不动";
      updateFaceUi(progress, message, false);
      if (stableFrames >= 7) {
        facePhase = 1;
        stableFrames = 0;
        updateFaceUi(0.36f, "随机动作：" + faceChallenge, false);
      }
      return;
    }

    if (facePhase == 1) {
      boolean actionPassed = faceChallengeTurn
        ? Math.abs(yaw) > 19f
        : smileProbability != null && smileProbability > 0.72f;
      stableFrames = actionPassed ? stableFrames + 1 : 0;
      float progress = 0.38f + Math.min(1f, stableFrames / 4f) * 0.28f;
      updateFaceUi(progress, actionPassed ? "动作已识别，保持一下" : "请完成动作：" + faceChallenge, false);
      if (stableFrames >= 4) {
        facePhase = 2;
        stableFrames = 0;
        updateFaceUi(0.70f, "动作完成，请重新正对镜头", false);
      }
      return;
    }

    stableFrames = frontal ? stableFrames + 1 : 0;
    float progress = 0.72f + Math.min(1f, stableFrames / 7f) * 0.25f;
    updateFaceUi(progress, frontal ? "验证动作完成，正在定格" : "请重新正对镜头", false);
    if (stableFrames >= 7) captureVerifiedFace();
  }

  private void analyzeFace(ImageProxy imageProxy, long token) {
    FaceDetector detector = faceDetector;
    if (!captureLifecycle.canCapture(token) || step != Step.FACE || detector == null
      || faceCaptureStarted || !faceBusy.compareAndSet(false, true)) {
      imageProxy.close();
      return;
    }
    Runnable releaseFrame = VisionCaptureLifecycle.releaseOnce(imageProxy::close);
    try {
      Image mediaImage = imageProxy.getImage();
      if (mediaImage == null) {
        releaseFrame.run();
        faceBusy.set(false);
        return;
      }
      int rotation = imageProxy.getImageInfo().getRotationDegrees();
      int uprightWidth = rotation == 90 || rotation == 270 ? imageProxy.getHeight() : imageProxy.getWidth();
      int uprightHeight = rotation == 90 || rotation == 270 ? imageProxy.getWidth() : imageProxy.getHeight();
      InputImage input = InputImage.fromMediaImage(mediaImage, rotation);
      detector.process(input)
        .addOnCompleteListener(VisionCaptureLifecycle.RELEASE_EXECUTOR, task -> releaseFrame.run())
        .addOnCompleteListener(ContextCompat.getMainExecutor(this), task -> {
          try {
            if (!canUseUi(token) || !captureLifecycle.canCapture(token)) return;
            if (task.isSuccessful()) processFaces(task.getResult(), uprightWidth, uprightHeight);
            else if (!task.isCanceled()) updateFaceUi(0.04f, "人脸检测暂时失败，请调整位置", false);
          } finally {
            // Keep detections serialized until their tracking result has reached the UI.
            faceBusy.set(false);
          }
        });
    } catch (Exception error) {
      releaseFrame.run();
      faceBusy.set(false);
      postCaptureUi(token, () -> updateFaceUi(0.04f, "人脸检测暂时失败，请调整位置", false));
    }
  }
}
