package local.fanhao.library;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.nio.charset.StandardCharsets;

final class NativeShortVideoHttpResponse {
  static final int MAX_JSON_BYTES = 1024 * 1024;

  static final class BodyTooLargeException extends IOException {
    BodyTooLargeException(int maxBytes) {
      super("HTTP response exceeds " + maxBytes + " bytes");
    }
  }

  private NativeShortVideoHttpResponse() {}

  static String readUtf8(HttpURLConnection connection, boolean success) throws IOException {
    return readUtf8(connection, success, MAX_JSON_BYTES);
  }

  static String readUtf8(HttpURLConnection connection, boolean success, int maxBytes) throws IOException {
    rejectDeclaredOverflow(connection, maxBytes);
    InputStream stream = success ? connection.getInputStream() : connection.getErrorStream();
    if (stream == null) return "";
    try (InputStream input = stream) {
      return readUtf8(input, maxBytes);
    }
  }

  static String readUtf8(InputStream input, int maxBytes) throws IOException {
    return new String(readBytes(input, maxBytes), StandardCharsets.UTF_8);
  }

  static byte[] readBytes(HttpURLConnection connection, boolean success, int maxBytes) throws IOException {
    rejectDeclaredOverflow(connection, maxBytes);
    InputStream stream = success ? connection.getInputStream() : connection.getErrorStream();
    if (stream == null) return new byte[0];
    try (InputStream input = stream) {
      return readBytes(input, maxBytes);
    }
  }

  static byte[] readBytes(InputStream input, int maxBytes) throws IOException {
    if (maxBytes < 1) throw new IllegalArgumentException("maxBytes must be positive");
    ByteArrayOutputStream output = new ByteArrayOutputStream(Math.min(maxBytes, 16 * 1024));
    byte[] buffer = new byte[8192];
    int total = 0;
    int read;
    while ((read = input.read(buffer)) >= 0) {
      if (read == 0) continue;
      if (read > maxBytes - total) throw new BodyTooLargeException(maxBytes);
      output.write(buffer, 0, read);
      total += read;
    }
    return output.toByteArray();
  }

  private static void rejectDeclaredOverflow(HttpURLConnection connection, int maxBytes) throws IOException {
    if (maxBytes < 1) throw new IllegalArgumentException("maxBytes must be positive");
    String value = connection.getHeaderField("Content-Length");
    if (value == null || value.trim().length() == 0) return;
    try {
      if (Long.parseLong(value.trim()) > maxBytes) throw new BodyTooLargeException(maxBytes);
    } catch (NumberFormatException ignored) {}
  }
}
