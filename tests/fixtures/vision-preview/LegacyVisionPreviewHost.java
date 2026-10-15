package local.fanhao.library;

import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Matrix;
import android.media.ExifInterface;
import java.io.File;

// Frozen real Activity method bodies before bounded preview decoding. Only the
// enclosing host and wrappers are fixtures; these methods retain their old code.
class LegacyVisionPreviewHost extends PreviewHostBase {
  Bitmap decodeForTest(File file, int maximum) { return decodePreview(file, maximum); }
  void confirmForTest(File file) { confirmCapturedDocument(file); }

  private Bitmap decodePreview(File file, int maxWidth) {
    BitmapFactory.Options bounds = new BitmapFactory.Options();
    bounds.inJustDecodeBounds = true;
    BitmapFactory.decodeFile(file.getAbsolutePath(), bounds);
    int sample = 1;
    while (bounds.outWidth / sample > maxWidth * 1.5f) sample *= 2;
    BitmapFactory.Options options = new BitmapFactory.Options();
    options.inSampleSize = Math.max(1, sample);
    options.inPreferredConfig = Bitmap.Config.ARGB_8888;
    Bitmap bitmap = BitmapFactory.decodeFile(file.getAbsolutePath(), options);
    if (bitmap == null) return null;
    try {
      int orientation = new ExifInterface(file.getAbsolutePath()).getAttributeInt(
        ExifInterface.TAG_ORIENTATION,
        ExifInterface.ORIENTATION_NORMAL
      );
      float rotation = 0f;
      if (orientation == ExifInterface.ORIENTATION_ROTATE_90) rotation = 90f;
      else if (orientation == ExifInterface.ORIENTATION_ROTATE_180) rotation = 180f;
      else if (orientation == ExifInterface.ORIENTATION_ROTATE_270) rotation = 270f;
      if (rotation != 0f) {
        Matrix matrix = new Matrix();
        matrix.postRotate(rotation);
        Bitmap rotated = Bitmap.createBitmap(bitmap, 0, 0, bitmap.getWidth(), bitmap.getHeight(), matrix, true);
        if (rotated != bitmap) bitmap.recycle();
        bitmap = rotated;
      }
    } catch (Exception ignored) {}
    return bitmap;
  }

  private void confirmCapturedDocument(File file) {
    Bitmap preview = decodePreview(file, 1100);
    String quality = assessImageQuality(preview);
    if (preview == null || !quality.startsWith("光线与对比度正常")) {
      if (preview != null) preview.recycle();
      retryDocumentAutomatically(file, quality + " 正在自动重试");
      return;
    }

    if (step == Step.ID_FRONT || step == Step.ID_BACK) {
      validateIdentityCardSide(file, preview, step);
      return;
    }
    preview.recycle();
    acceptCapturedDocument(file);
  }
}
