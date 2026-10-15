package android.media;

import java.io.IOException;

public class ExifInterface {
  public static final String TAG_ORIENTATION = "Orientation";
  public static final int ORIENTATION_UNDEFINED = 0, ORIENTATION_NORMAL = 1, ORIENTATION_FLIP_HORIZONTAL = 2,
    ORIENTATION_ROTATE_180 = 3, ORIENTATION_FLIP_VERTICAL = 4, ORIENTATION_TRANSPOSE = 5,
    ORIENTATION_ROTATE_90 = 6, ORIENTATION_TRANSVERSE = 7, ORIENTATION_ROTATE_270 = 8;
  public static int orientation = 1, failure, reads;
  public ExifInterface(String path) throws IOException {
    reads++;
    if (failure == 1) throw new OutOfMemoryError("fixture EXIF OOM");
    if (failure == 2) throw new IOException("fixture EXIF read failure");
  }
  public int getAttributeInt(String name, int fallback) { return orientation; }
}
