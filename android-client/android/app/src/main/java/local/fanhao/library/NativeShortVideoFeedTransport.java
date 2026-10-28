package local.fanhao.library;

import java.net.HttpURLConnection;
import java.net.URL;

final class NativeShortVideoFeedTransport {
  interface Cancellation {
    boolean isCancelled();
    boolean attach(HttpURLConnection connection);
    void detach(HttpURLConnection connection);
    default boolean publish(Runnable action) {
      if (isCancelled()) return false;
      action.run();
      return !isCancelled();
    }
  }
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
    return read(feedUrl, parser, null);
  }

  <T> NativeShortVideoFeedPaging.ReadResult<T> read(String feedUrl, Parser<T> parser, Cancellation cancellation) {
    HttpURLConnection connection = null;
    try {
      if (cancellation != null && cancellation.isCancelled()) return failure(NativeShortVideoFeedPaging.Failure.OFFLINE);
      connection = (HttpURLConnection) new URL(feedUrl).openConnection();
      if (cancellation != null && !cancellation.attach(connection)) return failure(NativeShortVideoFeedPaging.Failure.OFFLINE);
      connection.setConnectTimeout(connectTimeoutMs);
      connection.setReadTimeout(readTimeoutMs);
      connection.setRequestProperty("Accept", "application/json");
      if (cancellation != null && cancellation.isCancelled()) return failure(NativeShortVideoFeedPaging.Failure.OFFLINE);
      connection.connect();
      if (cancellation != null && cancellation.isCancelled()) return failure(NativeShortVideoFeedPaging.Failure.OFFLINE);
      int responseCode = connection.getResponseCode();
      if (responseCode < 200 || responseCode >= 300) return failure(NativeShortVideoFeedPaging.Failure.HTTP);
      String body = NativeShortVideoHttpResponse.readUtf8(connection, true);
      if (cancellation != null && cancellation.isCancelled()) return failure(NativeShortVideoFeedPaging.Failure.OFFLINE);
      Parsed<T> parsed = parser.parse(body);
      if (cancellation != null && cancellation.isCancelled()) return failure(NativeShortVideoFeedPaging.Failure.OFFLINE);
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
      if (cancellation != null && connection != null) cancellation.detach(connection);
      if (connection != null) connection.disconnect();
    }
  }

  private <T> NativeShortVideoFeedPaging.ReadResult<T> failure(NativeShortVideoFeedPaging.Failure failure) {
    return NativeShortVideoFeedPaging.ReadResult.failure(failure);
  }
}
