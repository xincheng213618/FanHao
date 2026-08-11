package local.fanhao.library;

import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;

import java.io.IOException;
import java.net.InetSocketAddress;
import java.net.ServerSocket;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

public final class NativeShortVideoFeedPagingHarness {
  public static void main(String[] args) {
    verifyOldResponseCannotPolluteReplacement();
    verifyFailuresRemainRetryable();
    verifySuccessfulEmptyPageEndsFeed();
    verifyTransportFailures();
    System.out.println("native-short-video-feed-paging: ok (generation, stale, 503/offline/timeout/parse, retry, empty)");
  }

  private static void verifyOldResponseCannotPolluteReplacement() {
    NativeShortVideoFeedPaging paging = new NativeShortVideoFeedPaging();
    paging.replaceFeed("https://fixture.test/collections/a", "cursor-48", true);
    NativeShortVideoFeedPaging.Request oldRequest = requireRequest(
      paging.beginLoadMore("https://fixture.test/collections/a", "cursor-48", true),
      "old collection request"
    );

    paging.beginFeedReplacement("https://fixture.test/search?q=new");
    paging.replaceFeed("https://fixture.test/search?q=new", "search-48", true);
    paging.markPendingAutoAdvance(47);
    NativeShortVideoFeedPaging.Request newRequest = requireRequest(
      paging.beginLoadMore("https://fixture.test/search?q=new", "search-48", true),
      "new search request"
    );
    check(paging.isLoading(), "new request must be loading before the delayed old callback");

    NativeShortVideoFeedPaging.Completion oldCompletion = paging.complete(
      oldRequest,
      NativeShortVideoFeedPaging.ReadResult.success("old collection page", false, "old-end")
    );
    check(oldCompletion == NativeShortVideoFeedPaging.Completion.STALE, "delayed collection response must be stale");
    check(paging.isLoading(), "stale completion must not clear the newer request loading flag");
    check("search-48".equals(paging.cursor()), "stale completion must not replace the newer cursor");
    check(paging.hasMore(), "stale completion must not replace the newer hasMore state");
    check(paging.pendingAutoAdvanceIndex() == 47, "stale completion must not clear the newer feed auto-advance state");

    NativeShortVideoFeedPaging.Completion newCompletion = paging.complete(
      newRequest,
      NativeShortVideoFeedPaging.ReadResult.success("new search page", true, "search-96")
    );
    check(newCompletion == NativeShortVideoFeedPaging.Completion.APPLIED, "new request must still apply");
    check(!paging.isLoading(), "current completion must clear loading");
    check("search-96".equals(paging.cursor()), "current completion must advance only the new cursor");
  }

  private static void verifyFailuresRemainRetryable() {
    for (NativeShortVideoFeedPaging.Failure failure : NativeShortVideoFeedPaging.Failure.values()) {
      NativeShortVideoFeedPaging paging = new NativeShortVideoFeedPaging();
      paging.replaceFeed("https://fixture.test/collections/a", "cursor-96", true);
      paging.markPendingAutoAdvance(95);
      NativeShortVideoFeedPaging.Request request = requireRequest(
        paging.beginLoadMore("https://fixture.test/collections/a", "cursor-96", true),
        failure + " request"
      );
      NativeShortVideoFeedPaging.ReadResult<String> result = NativeShortVideoFeedPaging.ReadResult.failure(failure);
      check(paging.complete(request, result) == NativeShortVideoFeedPaging.Completion.FAILED, failure + " must be reported as failure");
      check(!paging.isLoading(), failure + " must release loading for retry");
      check("cursor-96".equals(paging.cursor()), failure + " must preserve the continuation cursor");
      check(paging.hasMore(), failure + " must preserve hasMore");
      check(paging.pendingAutoAdvanceIndex() == -1, failure + " must clear pending auto-advance");
      String message = result.publicMessage();
      check(message.contains("重试"), failure + " must expose a retryable user message");
      check(!message.contains("fixture.test") && !message.contains("503") && !message.toLowerCase().contains("json"), failure + " message must be sanitized");
      check(paging.beginLoadMore("https://fixture.test/collections/a", "cursor-96", true) != null, failure + " must allow a retry");
    }
  }

  private static void verifySuccessfulEmptyPageEndsFeed() {
    NativeShortVideoFeedPaging paging = new NativeShortVideoFeedPaging();
    paging.replaceFeed("https://fixture.test/collections/a", "cursor-last", true);
    NativeShortVideoFeedPaging.Request request = requireRequest(
      paging.beginLoadMore("https://fixture.test/collections/a", "cursor-last", true),
      "empty page request"
    );
    NativeShortVideoFeedPaging.Completion completion = paging.complete(
      request,
      NativeShortVideoFeedPaging.ReadResult.success("successful empty page", false, "")
    );
    check(completion == NativeShortVideoFeedPaging.Completion.APPLIED, "successful empty page must not be classified as an error");
    check(!paging.hasMore() && paging.cursor().isEmpty(), "successful empty page may end the feed");
    check(paging.beginLoadMore("https://fixture.test/collections/a", "", false) == null, "ended feed must not start another request");
  }

  private static void verifyTransportFailures() {
    HttpServer server = null;
    ExecutorService serverExecutor = Executors.newCachedThreadPool();
    try {
      server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
      server.createContext("/empty", exchange -> send(exchange, 200, "{\"videos\":[]}"));
      server.createContext("/unavailable", exchange -> send(exchange, 503, "private SQL detail must not escape"));
      server.createContext("/bad-json", exchange -> send(exchange, 200, "private malformed JSON detail"));
      server.createContext("/timeout", exchange -> {
        try {
          Thread.sleep(250);
          send(exchange, 200, "{\"videos\":[]}");
        } catch (InterruptedException error) {
          Thread.currentThread().interrupt();
        } catch (IOException ignored) {}
      });
      server.setExecutor(serverExecutor);
      server.start();
      String baseUrl = "http://127.0.0.1:" + server.getAddress().getPort();
      NativeShortVideoFeedTransport transport = new NativeShortVideoFeedTransport(1000, 1000);
      NativeShortVideoFeedTransport impatientTransport = new NativeShortVideoFeedTransport(1000, 50);
      NativeShortVideoFeedTransport.Parser<String> parser = body -> {
        if (!"{\"videos\":[]}".equals(body)) throw new IllegalArgumentException("invalid JSON fixture");
        return new NativeShortVideoFeedTransport.Parsed<>("empty", false, "");
      };

      assertFailure(transport.read(baseUrl + "/unavailable", parser), NativeShortVideoFeedPaging.Failure.HTTP, "HTTP 503");
      assertFailure(impatientTransport.read(baseUrl + "/timeout", parser), NativeShortVideoFeedPaging.Failure.TIMEOUT, "timeout");
      assertFailure(transport.read(baseUrl + "/bad-json", parser), NativeShortVideoFeedPaging.Failure.PARSE, "malformed JSON");
      NativeShortVideoFeedPaging.ReadResult<String> empty = transport.read(baseUrl + "/empty", parser);
      check(empty.succeeded() && "empty".equals(empty.value) && !empty.hasMore, "a real successful empty response must stay distinct from failure");

      int offlinePort;
      try (ServerSocket socket = new ServerSocket(0)) {
        offlinePort = socket.getLocalPort();
      }
      assertFailure(transport.read("http://127.0.0.1:" + offlinePort + "/offline", parser), NativeShortVideoFeedPaging.Failure.OFFLINE, "offline");
    } catch (IOException error) {
      throw new AssertionError("transport fixture failed to start", error);
    } finally {
      if (server != null) server.stop(0);
      serverExecutor.shutdownNow();
    }
  }

  private static void assertFailure(
    NativeShortVideoFeedPaging.ReadResult<?> result,
    NativeShortVideoFeedPaging.Failure expected,
    String label
  ) {
    check(!result.succeeded() && result.failure == expected, label + " must keep its failure category, got " + result.failure);
    String message = result.publicMessage();
    check(message.contains("重试"), label + " must remain visibly retryable");
    check(!message.contains("SQL") && !message.contains("503") && !message.toLowerCase().contains("json"), label + " must not leak transport or parser detail");
  }

  private static void send(HttpExchange exchange, int status, String body) throws IOException {
    byte[] bytes = body.getBytes(StandardCharsets.UTF_8);
    exchange.sendResponseHeaders(status, bytes.length);
    exchange.getResponseBody().write(bytes);
    exchange.close();
  }

  private static NativeShortVideoFeedPaging.Request requireRequest(NativeShortVideoFeedPaging.Request request, String label) {
    check(request != null, label + " must start");
    return request;
  }

  private static void check(boolean condition, String message) {
    if (!condition) throw new AssertionError(message);
  }
}
