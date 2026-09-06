package local.fanhao.library;

import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Matrix;
import android.media.ExifInterface;

import java.io.File;
import java.io.IOException;

/** Bounded, EXIF-aware preview decoding. Returned bitmaps belong to the caller. */
final class VisionPreviewDecoder {
  static final int MAX_EDGE = 4096;
  static final long MAX_PIXELS = 4L * 1024L * 1024L;
  static final long MAX_BITMAP_BYTES = MAX_PIXELS * 4L;
  static final int MAX_ATTEMPTS = 3;
  private static final int MAX_SAMPLE = 1 << 30;

  private VisionPreviewDecoder() {}

  static boolean fitsMemory(int width, int height) {
    return width > 0 && height > 0 && width <= MAX_EDGE && height <= MAX_EDGE
      && (long) width * height <= MAX_PIXELS;
  }

  private static boolean fitsDecode(int width, int height, int preferredWidth) {
    // Preserve the existing preview/OCR width quality for ordinary camera photos,
    // while adding independent height and pixel limits for unusual aspect ratios.
    return preferredWidth > 0 && width <= (long) preferredWidth * 3L / 2L && fitsMemory(width, height);
  }

  private static boolean fitsBitmap(Bitmap bitmap) {
    long allocation = bitmap.getAllocationByteCount();
    return allocation > 0 && allocation <= MAX_BITMAP_BYTES
      && fitsMemory(bitmap.getWidth(), bitmap.getHeight());
  }

  private static int sampledEdge(int edge, int sample) {
    return (int) (((long) edge + sample - 1L) / sample);
  }

  static int sampleSize(int width, int height, int preferredWidth) {
    if (width <= 0 || height <= 0 || preferredWidth <= 0) return 0;
    int sample = 1;
    while (!fitsDecode(sampledEdge(width, sample), sampledEdge(height, sample), preferredWidth)) {
      if (sample == MAX_SAMPLE) return 0;
      sample *= 2;
    }
    return sample;
  }

  static Matrix orientationMatrix(int orientation) {
    if (orientation < ExifInterface.ORIENTATION_FLIP_HORIZONTAL
      || orientation > ExifInterface.ORIENTATION_ROTATE_270) return null;
    Matrix matrix = new Matrix();
    switch (orientation) {
      case ExifInterface.ORIENTATION_FLIP_HORIZONTAL:
        matrix.setScale(-1f, 1f); break;
      case ExifInterface.ORIENTATION_ROTATE_180:
        matrix.setRotate(180f); break;
      case ExifInterface.ORIENTATION_FLIP_VERTICAL:
        matrix.setScale(1f, -1f); break;
      case ExifInterface.ORIENTATION_TRANSPOSE:
        matrix.setRotate(90f); matrix.postScale(-1f, 1f); break;
      case ExifInterface.ORIENTATION_ROTATE_90:
        matrix.setRotate(90f); break;
      case ExifInterface.ORIENTATION_TRANSVERSE:
        matrix.setRotate(270f); matrix.postScale(-1f, 1f); break;
      case ExifInterface.ORIENTATION_ROTATE_270:
        matrix.setRotate(270f); break;
      default:
        return null;
    }
    return matrix;
  }

  static Bitmap decode(File file, int preferredWidth) {
    if (file == null || preferredWidth <= 0) return null;
    BitmapFactory.Options bounds;
    int sample;
    int orientation;
    try {
      bounds = new BitmapFactory.Options();
      bounds.inJustDecodeBounds = true;
      BitmapFactory.decodeFile(file.getAbsolutePath(), bounds);
      sample = sampleSize(bounds.outWidth, bounds.outHeight, preferredWidth);
      if (sample == 0) return null;
      orientation = new ExifInterface(file.getAbsolutePath()).getAttributeInt(
        ExifInterface.TAG_ORIENTATION, ExifInterface.ORIENTATION_NORMAL);
    } catch (IOException | RuntimeException | OutOfMemoryError unavailable) {
      return null;
    }

    for (int attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      Bitmap owned = null;
      try {
        BitmapFactory.Options options = new BitmapFactory.Options();
        options.inSampleSize = sample;
        options.inPreferredConfig = Bitmap.Config.ARGB_8888;
        options.inScaled = false;
        owned = BitmapFactory.decodeFile(file.getAbsolutePath(), options);
        if (owned == null) return null;
        // Decoders may round output dimensions; never trust header arithmetic alone.
        if (fitsDecode(owned.getWidth(), owned.getHeight(), preferredWidth) && fitsBitmap(owned)) {
          Matrix transform = orientationMatrix(orientation);
          if (transform != null) {
            Bitmap transformed = Bitmap.createBitmap(owned, 0, 0, owned.getWidth(), owned.getHeight(), transform, true);
            if (transformed == null) return null;
            if (transformed != owned) {
              Bitmap previous = owned;
              owned = transformed;
              previous.recycle();
            }
          }
          if (fitsBitmap(owned)) {
            Bitmap result = owned;
            owned = null;
            return result;
          }
        }
      } catch (OutOfMemoryError unavailable) {
        // Retry with less memory, but never hand out an incorrectly oriented image.
      } catch (RuntimeException invalidImage) {
        return null;
      } finally {
        if (owned != null) owned.recycle();
      }
      if (sample == MAX_SAMPLE || (sampledEdge(bounds.outWidth, sample) <= 1
        && sampledEdge(bounds.outHeight, sample) <= 1)) break;
      sample *= 2;
    }
    return null;
  }
}
