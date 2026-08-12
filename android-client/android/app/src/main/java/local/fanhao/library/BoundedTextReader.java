package local.fanhao.library;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;

/** Size gate shared by content-URI reads and the standalone JVM verifier. */
final class BoundedTextReader {
  static void requireAllowedKnownSize(long sizeBytes, long maximumBytes) {
    if (maximumBytes < 1L) throw new IllegalArgumentException("文本读取上限无效");
    if (sizeBytes > maximumBytes) {
      throw new IllegalArgumentException("文本文件太大，暂时只支持 80MB 以内");
    }
  }

  static byte[] read(InputStream input, long maximumBytes) throws Exception {
    if (input == null) throw new IllegalArgumentException("无法打开文本文件");
    if (maximumBytes < 1L || maximumBytes > Integer.MAX_VALUE - 8L) {
      throw new IllegalArgumentException("文本读取上限无效");
    }
    ByteArrayOutputStream output = new ByteArrayOutputStream();
    byte[] buffer = new byte[64 * 1024];
    long total = 0L;
    int read;
    while ((read = input.read(buffer)) >= 0) {
      if (read == 0) continue;
      total += read;
      if (total > maximumBytes) {
        throw new IllegalArgumentException("文本文件太大，暂时只支持 80MB 以内");
      }
      output.write(buffer, 0, read);
    }
    return output.toByteArray();
  }

  private BoundedTextReader() {}
}
