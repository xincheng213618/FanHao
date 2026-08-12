package local.fanhao.library;

import java.io.IOException;
import java.net.HttpURLConnection;
import java.util.Locale;

final class NativeShortVideoImageLoader {
  static final int MAX_IMAGE_BYTES = 8 * 1024 * 1024;

  private NativeShortVideoImageLoader() {}

  static byte[] read(HttpURLConnection connection) throws IOException {
    int status = connection.getResponseCode();
    if (status < 200 || status >= 300) throw new IOException("Unexpected image HTTP status: " + status);
    String contentType = connection.getContentType();
    if (contentType == null || !contentType.trim().toLowerCase(Locale.ROOT).startsWith("image/")) {
      throw new IOException("Unexpected image Content-Type");
    }
    return NativeShortVideoHttpResponse.readBytes(connection, true, MAX_IMAGE_BYTES);
  }
}
