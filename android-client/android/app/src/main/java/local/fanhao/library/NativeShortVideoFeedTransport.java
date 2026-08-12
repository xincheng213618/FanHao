package local.fanhao.library;

import java.net.HttpURLConnection;
import java.net.URL;

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
      Parsed<T> parsed = parser.parse(NativeShortVideoHttpResponse.readUtf8(connection, true));
      if (parsed == null || parsed.value == null) return failure(NativeShortVideoFeedPaging.Failure.PARSE);
      return NativeShortVideoFeedPaging.ReadResult.success(parsed.value, parsed.hasMore, parsed.nextCursor);
    } catch (java.net.SocketTimeoutException error) {
      return failure(NativeShortVideoFeedPaging.Failure.TIMEOUT);
    } catch (NativeShortVideoHttpResponse.BodyTooLargeException error) {
      return failure(NativeShortVideoFeedPaging.Failure.PARSE);
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
