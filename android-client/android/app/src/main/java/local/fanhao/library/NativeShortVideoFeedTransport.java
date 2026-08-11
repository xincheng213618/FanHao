package local.fanhao.library;

import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;

final class NativeShortVideoFeedTransport {
  interface Parser<T> {
    Parsed<T> parse(String body) throws Exception;
  }

  static final class Parsed<T> {
    final T value;
    final boolean hasMore;
    final String nextCursor;

    Parsed(T value, boolean hasMore, String nextCursor) {
      this.value = value;
      this.hasMore = hasMore;
      this.nextCursor = nextCursor;
    }
  }

  private final int connectTimeoutMs;
  private final int readTimeoutMs;

  NativeShortVideoFeedTransport(int connectTimeoutMs, int readTimeoutMs) {
    this.connectTimeoutMs = Math.max(1, connectTimeoutMs);
    this.readTimeoutMs = Math.max(1, readTimeoutMs);
  }

  <T> NativeShortVideoFeedPaging.ReadResult<T> read(String feedUrl, Parser<T> parser) {
    HttpURLConnection connection = null;
    try {
      connection = (HttpURLConnection) new URL(feedUrl).openConnection();
      connection.setConnectTimeout(connectTimeoutMs);
      connection.setReadTimeout(readTimeoutMs);
      connection.setRequestProperty("Accept", "application/json");
      connection.connect();
      int responseCode = connection.getResponseCode();
      if (responseCode < 200 || responseCode >= 300) return failure(NativeShortVideoFeedPaging.Failure.HTTP);
      StringBuilder builder = new StringBuilder();
      try (InputStream input = connection.getInputStream()) {
        byte[] buffer = new byte[8192];
        int read;
        while ((read = input.read(buffer)) >= 0) builder.append(new String(buffer, 0, read, StandardCharsets.UTF_8));
      }
      Parsed<T> parsed = parser.parse(builder.toString());
      if (parsed == null || parsed.value == null) return failure(NativeShortVideoFeedPaging.Failure.PARSE);
      return NativeShortVideoFeedPaging.ReadResult.success(parsed.value, parsed.hasMore, parsed.nextCursor);
    } catch (java.net.SocketTimeoutException error) {
      return failure(NativeShortVideoFeedPaging.Failure.TIMEOUT);
    } catch (java.io.IOException error) {
      return failure(NativeShortVideoFeedPaging.Failure.OFFLINE);
    } catch (Exception error) {
      return failure(NativeShortVideoFeedPaging.Failure.PARSE);
    } finally {
      if (connection != null) connection.disconnect();
    }
  }

  private <T> NativeShortVideoFeedPaging.ReadResult<T> failure(NativeShortVideoFeedPaging.Failure failure) {
    return NativeShortVideoFeedPaging.ReadResult.failure(failure);
  }
}
