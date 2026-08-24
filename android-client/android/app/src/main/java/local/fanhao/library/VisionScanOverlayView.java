package local.fanhao.library;

import android.content.Context;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.LinearGradient;
import android.graphics.Paint;
import android.graphics.Path;
import android.graphics.RectF;
import android.graphics.Shader;
import android.os.SystemClock;
import android.util.AttributeSet;
import android.view.View;

final class VisionScanOverlayView extends View {
  static final int GUIDE_ID_PORTRAIT = 1;
  static final int GUIDE_ID_EMBLEM = 2;
  static final int GUIDE_BANK_CARD = 3;

  private static final int MODE_DOCUMENT = 1;
  private static final int MODE_FACE = 2;
  private static final int BLUE = Color.rgb(64, 151, 255);
  private static final int GREEN = Color.rgb(54, 222, 158);

  private final Paint shadePaint = new Paint(Paint.ANTI_ALIAS_FLAG);
  private final Paint guidePaint = new Paint(Paint.ANTI_ALIAS_FLAG);
  private final Paint progressPaint = new Paint(Paint.ANTI_ALIAS_FLAG);
  private final Paint softPaint = new Paint(Paint.ANTI_ALIAS_FLAG);
  private final Paint labelPaint = new Paint(Paint.ANTI_ALIAS_FLAG);
  private final Paint smallPaint = new Paint(Paint.ANTI_ALIAS_FLAG);
  private int mode = MODE_DOCUMENT;
  private int documentGuide = GUIDE_ID_PORTRAIT;
  private float progress = 0f;
  private String label = "身份证 · 人像面";
  private String hint = "将证件完整放入框内";
  private boolean success = false;

  VisionScanOverlayView(Context context) {
    this(context, null);
  }

  VisionScanOverlayView(Context context, AttributeSet attrs) {
    super(context, attrs);
    shadePaint.setColor(Color.argb(192, 0, 0, 0));
    guidePaint.setStyle(Paint.Style.STROKE);
    guidePaint.setStrokeWidth(dp(2.2f));
    guidePaint.setColor(Color.WHITE);
    progressPaint.setStyle(Paint.Style.STROKE);
    progressPaint.setStrokeCap(Paint.Cap.ROUND);
    progressPaint.setStrokeWidth(dp(5f));
    labelPaint.setColor(Color.WHITE);
    labelPaint.setTextAlign(Paint.Align.CENTER);
    labelPaint.setTextSize(dp(13f));
    labelPaint.setFakeBoldText(true);
    smallPaint.setColor(Color.rgb(220, 228, 238));
    smallPaint.setTextAlign(Paint.Align.CENTER);
    smallPaint.setTextSize(dp(11f));
  }

  void showDocument(int guide, String value) {
    mode = MODE_DOCUMENT;
    documentGuide = guide;
    label = value == null ? "证卡" : value;
    hint = "将证件完整放入框内";
    progress = 0f;
    success = false;
    invalidate();
  }

  void updateDocument(float value, String message, boolean completed) {
    mode = MODE_DOCUMENT;
    progress = clamp(value);
    hint = message == null ? "自动识别中" : message;
    success = completed;
    invalidate();
  }

  void showFace(float value, boolean completed) {
    mode = MODE_FACE;
    progress = clamp(value);
    success = completed;
    invalidate();
  }

  @Override
  protected void onDraw(Canvas canvas) {
    super.onDraw(canvas);
    RectF opening = mode == MODE_FACE ? faceOpening() : documentOpening();
    drawMask(canvas, opening);
    if (mode == MODE_FACE) drawFaceScanner(canvas, opening);
    else drawDocumentScanner(canvas, opening);
    if (!success) postInvalidateOnAnimation();
  }

  private void drawMask(Canvas canvas, RectF opening) {
    Path shade = new Path();
    shade.setFillType(Path.FillType.EVEN_ODD);
    shade.addRect(0, 0, getWidth(), getHeight(), Path.Direction.CW);
    if (mode == MODE_FACE) shade.addOval(opening, Path.Direction.CW);
    else shade.addRoundRect(opening, dp(18f), dp(18f), Path.Direction.CW);
    canvas.drawPath(shade, shadePaint);
  }

  private void drawDocumentScanner(Canvas canvas, RectF opening) {
    int accent = success ? GREEN : mix(Color.WHITE, BLUE, progress);
    guidePaint.setColor(accent);
    guidePaint.setShadowLayer(success ? dp(13f) : dp(7f), 0, 0, Color.argb(180, Color.red(accent), Color.green(accent), Color.blue(accent)));
    canvas.drawRoundRect(opening, dp(18f), dp(18f), guidePaint);
    drawDocumentCorners(canvas, opening, accent);
    drawDocumentGuide(canvas, opening, accent);
    if (!success) drawDocumentBeam(canvas, opening);
    else drawSuccessMark(canvas, opening.centerX(), opening.centerY(), Math.min(opening.width(), opening.height()) * 0.13f);

    float labelY = opening.bottom + dp(33f);
    labelPaint.setColor(success ? GREEN : Color.WHITE);
    canvas.drawText(label, opening.centerX(), labelY, labelPaint);
    smallPaint.setColor(success ? Color.rgb(187, 255, 225) : Color.rgb(216, 225, 237));
    canvas.drawText(hint, opening.centerX(), labelY + dp(23f), smallPaint);
    drawDocumentProgress(canvas, opening);
  }

  private void drawDocumentGuide(Canvas canvas, RectF rect, int accent) {
    softPaint.setStyle(Paint.Style.STROKE);
    softPaint.setStrokeWidth(dp(1.5f));
    softPaint.setColor(Color.argb(success ? 170 : 112, Color.red(accent), Color.green(accent), Color.blue(accent)));
    float unit = rect.width() / 100f;
    if (documentGuide == GUIDE_ID_PORTRAIT) {
      float cx = rect.left + unit * 78f;
      float cy = rect.top + rect.height() * 0.40f;
      canvas.drawOval(new RectF(cx - unit * 7f, cy - unit * 9f, cx + unit * 7f, cy + unit * 9f), softPaint);
      Path shoulders = new Path();
      shoulders.moveTo(cx - unit * 15f, rect.top + rect.height() * 0.78f);
      shoulders.quadTo(cx, rect.top + rect.height() * 0.58f, cx + unit * 15f, rect.top + rect.height() * 0.78f);
      canvas.drawPath(shoulders, softPaint);
      drawGuideLine(canvas, rect.left + unit * 10f, rect.top + rect.height() * 0.28f, unit * 38f);
      drawGuideLine(canvas, rect.left + unit * 10f, rect.top + rect.height() * 0.43f, unit * 30f);
      drawGuideLine(canvas, rect.left + unit * 10f, rect.top + rect.height() * 0.58f, unit * 42f);
      drawGuideLine(canvas, rect.left + unit * 10f, rect.top + rect.height() * 0.73f, unit * 48f);
    } else if (documentGuide == GUIDE_ID_EMBLEM) {
      float cx = rect.left + unit * 24f;
      float cy = rect.centerY();
      float radius = unit * 12f;
      canvas.drawCircle(cx, cy, radius, softPaint);
      drawStar(canvas, cx, cy, radius * 0.58f, softPaint);
      drawGuideLine(canvas, rect.left + unit * 49f, rect.top + rect.height() * 0.34f, unit * 38f);
      drawGuideLine(canvas, rect.left + unit * 49f, rect.top + rect.height() * 0.50f, unit * 30f);
      drawGuideLine(canvas, rect.left + unit * 49f, rect.top + rect.height() * 0.69f, unit * 40f);
    } else {
      RectF chip = new RectF(
        rect.left + unit * 11f,
        rect.top + rect.height() * 0.25f,
        rect.left + unit * 29f,
        rect.top + rect.height() * 0.53f
      );
      canvas.drawRoundRect(chip, dp(5f), dp(5f), softPaint);
      canvas.drawLine(chip.centerX(), chip.top, chip.centerX(), chip.bottom, softPaint);
      canvas.drawLine(chip.left, chip.centerY(), chip.right, chip.centerY(), softPaint);
      for (int index = 0; index < 4; index++) {
        drawGuideLine(canvas, rect.left + unit * (11f + index * 21f), rect.top + rect.height() * 0.72f, unit * 15f);
      }
    }
  }

  private void drawGuideLine(Canvas canvas, float x, float y, float width) {
    canvas.drawRoundRect(new RectF(x, y, x + width, y + dp(2f)), dp(1f), dp(1f), softPaint);
  }

  private void drawStar(Canvas canvas, float cx, float cy, float radius, Paint paint) {
    Path star = new Path();
    for (int index = 0; index < 10; index++) {
      double angle = -Math.PI / 2d + index * Math.PI / 5d;
      float value = index % 2 == 0 ? radius : radius * 0.44f;
      float x = cx + (float) Math.cos(angle) * value;
      float y = cy + (float) Math.sin(angle) * value;
      if (index == 0) star.moveTo(x, y);
      else star.lineTo(x, y);
    }
    star.close();
    canvas.drawPath(star, paint);
  }

  private void drawDocumentBeam(Canvas canvas, RectF opening) {
    float phase = animationPhase(1750L);
    float y = opening.top + dp(16f) + phase * (opening.height() - dp(32f));
    softPaint.setStyle(Paint.Style.FILL);
    softPaint.setShader(new LinearGradient(
      opening.left + dp(10f), y, opening.right - dp(10f), y,
      new int[] { Color.TRANSPARENT, Color.argb(210, 84, 177, 255), Color.WHITE, Color.argb(210, 84, 177, 255), Color.TRANSPARENT },
      new float[] { 0f, 0.22f, 0.5f, 0.78f, 1f },
      Shader.TileMode.CLAMP
    ));
    softPaint.setShadowLayer(dp(12f), 0, 0, BLUE);
    canvas.drawRoundRect(new RectF(opening.left + dp(8f), y - dp(1.2f), opening.right - dp(8f), y + dp(1.2f)), dp(2f), dp(2f), softPaint);
    softPaint.clearShadowLayer();
    softPaint.setShader(null);
  }

  private void drawDocumentProgress(Canvas canvas, RectF opening) {
    float width = Math.min(opening.width() * 0.64f, dp(240f));
    float left = opening.centerX() - width / 2f;
    float top = opening.bottom + dp(73f);
    softPaint.setStyle(Paint.Style.FILL);
    softPaint.setColor(Color.argb(105, 255, 255, 255));
    canvas.drawRoundRect(new RectF(left, top, left + width, top + dp(4f)), dp(3f), dp(3f), softPaint);
    softPaint.setColor(success ? GREEN : BLUE);
    canvas.drawRoundRect(new RectF(left, top, left + width * Math.max(0.035f, progress), top + dp(4f)), dp(3f), dp(3f), softPaint);
  }

  private void drawFaceScanner(Canvas canvas, RectF opening) {
    int accent = success ? GREEN : BLUE;
    guidePaint.setColor(Color.argb(success ? 255 : 205, Color.red(accent), Color.green(accent), Color.blue(accent)));
    guidePaint.setShadowLayer(success ? dp(16f) : dp(9f), 0, 0, accent);
    canvas.drawOval(opening, guidePaint);

    progressPaint.setColor(accent);
    RectF ring = new RectF(opening);
    ring.inset(-dp(9f), -dp(9f));
    canvas.drawArc(ring, -90f, Math.max(0.025f, progress) * 360f, false, progressPaint);
    drawFaceAnchorPoints(canvas, opening, accent);
    if (!success) {
      drawFaceBeam(canvas, opening);
      drawOrbitParticles(canvas, ring, accent);
    } else {
      drawSuccessMark(canvas, opening.centerX(), opening.centerY(), opening.width() * 0.15f);
    }
  }

  private void drawFaceAnchorPoints(Canvas canvas, RectF opening, int accent) {
    softPaint.setStyle(Paint.Style.FILL);
    softPaint.setColor(Color.argb(success ? 240 : 155, Color.red(accent), Color.green(accent), Color.blue(accent)));
    float cx = opening.centerX();
    float cy = opening.centerY();
    float rx = opening.width() * 0.32f;
    float ry = opening.height() * 0.31f;
    float[][] points = new float[][] {
      { cx - rx * 0.55f, cy - ry * 0.35f }, { cx + rx * 0.55f, cy - ry * 0.35f },
      { cx, cy }, { cx - rx * 0.72f, cy + ry * 0.18f }, { cx + rx * 0.72f, cy + ry * 0.18f },
      { cx, cy + ry * 0.72f }
    };
    for (float[] point : points) canvas.drawCircle(point[0], point[1], dp(2.4f), softPaint);
  }

  private void drawFaceBeam(Canvas canvas, RectF opening) {
    float phase = animationPhase(1500L);
    float y = opening.top + dp(20f) + phase * (opening.height() - dp(40f));
    float normalized = Math.abs((y - opening.centerY()) / (opening.height() / 2f));
    float halfWidth = opening.width() / 2f * (float) Math.sqrt(Math.max(0f, 1f - normalized * normalized));
    softPaint.setStyle(Paint.Style.FILL);
    softPaint.setShader(new LinearGradient(
      opening.centerX() - halfWidth, y, opening.centerX() + halfWidth, y,
      new int[] { Color.TRANSPARENT, Color.argb(210, 73, 164, 255), Color.TRANSPARENT },
      null,
      Shader.TileMode.CLAMP
    ));
    softPaint.setShadowLayer(dp(12f), 0, 0, BLUE);
    canvas.drawRoundRect(new RectF(opening.centerX() - halfWidth, y - dp(1.2f), opening.centerX() + halfWidth, y + dp(1.2f)), dp(2f), dp(2f), softPaint);
    softPaint.clearShadowLayer();
    softPaint.setShader(null);
  }

  private void drawOrbitParticles(Canvas canvas, RectF ring, int accent) {
    float phase = animationPhase(2100L) * 360f;
    softPaint.setStyle(Paint.Style.FILL);
    softPaint.setColor(Color.argb(210, Color.red(accent), Color.green(accent), Color.blue(accent)));
    for (int index = 0; index < 7; index++) {
      double radians = Math.toRadians(phase + index * 360f / 7f);
      float x = ring.centerX() + (float) Math.cos(radians) * ring.width() / 2f;
      float y = ring.centerY() + (float) Math.sin(radians) * ring.height() / 2f;
      canvas.drawCircle(x, y, dp(index % 3 == 0 ? 2.8f : 1.8f), softPaint);
    }
  }

  private void drawSuccessMark(Canvas canvas, float cx, float cy, float radius) {
    softPaint.setStyle(Paint.Style.FILL);
    softPaint.setColor(Color.argb(205, 15, 43, 34));
    softPaint.setShadowLayer(dp(18f), 0, 0, GREEN);
    canvas.drawCircle(cx, cy, radius, softPaint);
    softPaint.clearShadowLayer();
    softPaint.setStyle(Paint.Style.STROKE);
    softPaint.setStrokeWidth(dp(5f));
    softPaint.setStrokeCap(Paint.Cap.ROUND);
    softPaint.setStrokeJoin(Paint.Join.ROUND);
    softPaint.setColor(Color.WHITE);
    Path check = new Path();
    check.moveTo(cx - radius * 0.48f, cy);
    check.lineTo(cx - radius * 0.10f, cy + radius * 0.34f);
    check.lineTo(cx + radius * 0.52f, cy - radius * 0.38f);
    canvas.drawPath(check, softPaint);
  }

  private RectF documentOpening() {
    float horizontal = dp(22f);
    float width = Math.max(0f, getWidth() - horizontal * 2f);
    float height = width / 1.586f;
    float top = Math.max(dp(190f), getHeight() * 0.285f);
    return new RectF(horizontal, top, horizontal + width, top + height);
  }

  private RectF faceOpening() {
    float width = Math.min(getWidth() * 0.72f, dp(310f));
    float height = width * 1.30f;
    float left = (getWidth() - width) / 2f;
    float top = Math.max(dp(145f), getHeight() * 0.205f);
    return new RectF(left, top, left + width, top + height);
  }

  private void drawDocumentCorners(Canvas canvas, RectF rect, int accent) {
    Paint corner = new Paint(guidePaint);
    corner.setColor(accent);
    corner.setStrokeWidth(dp(6f));
    corner.setStrokeCap(Paint.Cap.ROUND);
    float length = dp(28f);
    canvas.drawLine(rect.left, rect.top + length, rect.left, rect.top, corner);
    canvas.drawLine(rect.left, rect.top, rect.left + length, rect.top, corner);
    canvas.drawLine(rect.right - length, rect.top, rect.right, rect.top, corner);
    canvas.drawLine(rect.right, rect.top, rect.right, rect.top + length, corner);
    canvas.drawLine(rect.left, rect.bottom - length, rect.left, rect.bottom, corner);
    canvas.drawLine(rect.left, rect.bottom, rect.left + length, rect.bottom, corner);
    canvas.drawLine(rect.right - length, rect.bottom, rect.right, rect.bottom, corner);
    canvas.drawLine(rect.right, rect.bottom - length, rect.right, rect.bottom, corner);
  }

  private float animationPhase(long durationMs) {
    return (SystemClock.uptimeMillis() % durationMs) / (float) durationMs;
  }

  private int mix(int from, int to, float amount) {
    float value = clamp(amount);
    return Color.rgb(
      Math.round(Color.red(from) + (Color.red(to) - Color.red(from)) * value),
      Math.round(Color.green(from) + (Color.green(to) - Color.green(from)) * value),
      Math.round(Color.blue(from) + (Color.blue(to) - Color.blue(from)) * value)
    );
  }

  private float clamp(float value) {
    return Math.max(0f, Math.min(1f, value));
  }

  private float dp(float value) {
    return value * getResources().getDisplayMetrics().density;
  }
}
