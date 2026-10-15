package android.graphics;

import java.util.ArrayList;
import java.util.List;

public class BitmapFactory {
  public static class Options {
    public boolean inJustDecodeBounds;
    public boolean inScaled = true;
    public int outWidth, outHeight, inSampleSize = 1;
    public Bitmap.Config inPreferredConfig;
  }
  public static int width, height, lastSample, boundsReads, pixelDecodes, boundsFailure, decodeFailure;
  public static int decodeFailureAttempts, oversizedAttempts;
  public static int extraAllocationAttempts;
  public static Integer forcedAllocation;
  public static boolean lastScaled;
  public static Bitmap.Config lastConfig;
  public static final List<Integer> samples = new ArrayList<>();
  public static boolean returnNull;
  public static void reset(int sourceWidth, int sourceHeight) {
    width = sourceWidth; height = sourceHeight; lastSample = 0; boundsReads = pixelDecodes = boundsFailure = decodeFailure = oversizedAttempts = 0; returnNull = false;
    decodeFailureAttempts = Integer.MAX_VALUE; extraAllocationAttempts = 0; forcedAllocation = null; lastScaled = true; lastConfig = null; samples.clear(); Matrix.created = 0;
    Bitmap.reset();
  }
  public static Bitmap decodeFile(String path, Options options) {
    if (options.inJustDecodeBounds) {
      boundsReads++;
      if (boundsFailure == 1) throw new OutOfMemoryError("fixture bounds OOM");
      if (boundsFailure == 2) throw new IllegalArgumentException("fixture bounds failure");
      options.outWidth = width; options.outHeight = height; return null;
    }
    pixelDecodes++; lastSample = options.inSampleSize; samples.add(lastSample); lastScaled = options.inScaled; lastConfig = options.inPreferredConfig;
    if (pixelDecodes <= decodeFailureAttempts && decodeFailure == 1) throw new OutOfMemoryError("fixture decode OOM");
    if (pixelDecodes <= decodeFailureAttempts && decodeFailure == 2) throw new IllegalArgumentException("fixture decode failure");
    if (returnNull) return null;
    int sample = pixelDecodes <= oversizedAttempts ? 1 : Math.max(1, options.inSampleSize);
    Bitmap result = new Bitmap(Math.max(1, (int) (((long) width + sample - 1) / sample)), Math.max(1, (int) (((long) height + sample - 1) / sample)));
    if (pixelDecodes <= extraAllocationAttempts) result.allocation = 16 * 1024 * 1024 + 1;
    if (forcedAllocation != null) result.allocation = forcedAllocation;
    return result;
  }
}
