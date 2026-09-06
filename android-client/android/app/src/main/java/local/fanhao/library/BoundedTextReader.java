package local.fanhao.library;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;

/** Size gate shared by content-URI reads and the standalone JVM verifier. */
final class BoundedTextReader {
  static void requireAllowedKnownSize(long sizeBytes, long maximumBytes) {
    if (maximumBytes < 1L || maximumBytes > Integer.MAX_VALUE - 8L) {
      throw new IllegalArgumentException("文本读取上限无效");
    }
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
    int emptyReads = 0;
    while (true) {
      // Probe at most one byte beyond the limit, even when provider size is unknown.
      int requested = (int) Math.min(buffer.length, maximumBytes - total + 1L);
      int read = input.read(buffer, 0, requested);
      if (read == -1) break;
      if (read < -1 || read > requested) throw new IOException("文本提供方返回了无效的读取长度");
      if (read == 0) {
        if (++emptyReads >= 8) throw new IOException("文本提供方未返回内容，请稍后重试");
        continue;
      }
      emptyReads = 0;
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
