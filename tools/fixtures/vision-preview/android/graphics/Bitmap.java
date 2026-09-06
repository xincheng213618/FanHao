package android.graphics;

import java.util.ArrayList;
import java.util.List;

public class Bitmap {
  public enum Config { ARGB_8888, RGB_565 }
  public static final List<Bitmap> allocated = new ArrayList<>();
  public static int transforms;
  public static int transformFailure;
  public static int transformFailureAttempts;
  public static int transformExtraAllocationAttempts, transformOversizedAttempts;
  public static boolean transformNull;
  public static boolean returnSame;
  public static Matrix lastMatrix;
  public final int width, height;
  public int recycles;
  public int allocation;
  public String pixels;
  public Bitmap(int width, int height) {
    this.width = width; this.height = height;
    allocation = (int) Math.min(Integer.MAX_VALUE, (long) width * height * 4L);
    if (width == 3 && height == 2) pixels = "ABCDEF";
    allocated.add(this);
  }
  public static void reset() {
    allocated.clear(); transforms = 0; transformFailure = 0; transformFailureAttempts = Integer.MAX_VALUE;
    transformExtraAllocationAttempts = transformOversizedAttempts = 0; transformNull = false; returnSame = false; lastMatrix = null;
  }
  public int getWidth() { return width; }
  public int getHeight() { return height; }
  public boolean isRecycled() { return recycles > 0; }
  public int getAllocationByteCount() { return allocation; }
  public void recycle() { if (++recycles > 1) throw new AssertionError("bitmap recycled twice"); }
  public static Bitmap createBitmap(Bitmap source, int left, int top, int width, int height, Matrix matrix, boolean filter) {
    transforms++; lastMatrix = matrix;
    if (transforms <= transformFailureAttempts && transformFailure == 1) throw new OutOfMemoryError("fixture transform OOM");
    if (transforms <= transformFailureAttempts && transformFailure == 2) throw new IllegalArgumentException("fixture transform failure");
    if (transformNull) return null;
    if (returnSame) return source;
    double[] xs = { 0, width - 1, 0, width - 1 }, ys = { 0, 0, height - 1, height - 1 };
    double minX = Double.POSITIVE_INFINITY, minY = minX, maxX = Double.NEGATIVE_INFINITY, maxY = maxX;
    for (int index = 0; index < 4; index++) {
      double x = matrix.a * xs[index] + matrix.b * ys[index], y = matrix.c * xs[index] + matrix.d * ys[index];
      minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y);
    }
    Bitmap result = transforms <= transformOversizedAttempts ? new Bitmap(4097, 1024)
      : new Bitmap((int) Math.round(maxX - minX + 1), (int) Math.round(maxY - minY + 1));
    if (transforms <= transformExtraAllocationAttempts) result.allocation = 16 * 1024 * 1024 + 1;
    if (source.pixels != null && width * height <= 64) {
      char[] pixels = new char[result.width * result.height];
      for (int y = 0; y < height; y++) for (int x = 0; x < width; x++) {
        int targetX = (int) Math.round(matrix.a * x + matrix.b * y - minX);
        int targetY = (int) Math.round(matrix.c * x + matrix.d * y - minY);
        pixels[targetY * result.width + targetX] = source.pixels.charAt(y * width + x);
      }
      result.pixels = new String(pixels);
    }
    return result;
  }
}
