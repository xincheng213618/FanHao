package local.fanhao.library;

import java.util.Arrays;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

public final class AuthenticatedResponseHeadersHarness {
  public static void main(String[] args) {
    Map<String, List<String>> range = new LinkedHashMap<>();
    range.put(null, Arrays.asList("HTTP/1.1 206 Partial Content"));
    range.put("Content-Type", Arrays.asList("audio/mpeg", "audio/mpeg"));
    range.put("Content-Length", Arrays.asList("0", "2097152"));
    range.put("Content-Range", Arrays.asList("bytes 2097152-4194303/9356122"));
    range.put("Accept-Ranges", Arrays.asList("bytes"));
    range.put("ETag", Arrays.asList("fixture-etag"));
    range.put("Connection", Arrays.asList("keep-alive"));
    range.put("Keep-Alive", Arrays.asList("timeout=5"));
    range.put("Set-Cookie", Arrays.asList("secret"));
    range.put("X-Android-Response-Source", Arrays.asList("NETWORK 206"));

    Map<String, String> cleaned = AuthenticatedResponseHeaders.from(range);
    require("audio/mpeg".equals(AuthenticatedResponseHeaders.contentType(range)), "duplicate MIME type must be canonical");
    require(!contains(cleaned, "Content-Type"), "WebResourceResponse owns Content-Type");
    require("2097152".equals(value(cleaned, "Content-Length")), "range length must be canonical");
    require("bytes 2097152-4194303/9356122".equals(value(cleaned, "Content-Range")), "range must stay exact");
    require("bytes".equals(value(cleaned, "Accept-Ranges")), "Accept-Ranges must survive");
    require("fixture-etag".equals(value(cleaned, "ETag")), "ETag must survive");
    for (String forbidden : Arrays.asList("Connection", "Keep-Alive", "Set-Cookie", "X-Android-Response-Source")) {
      require(!contains(cleaned, forbidden), forbidden + " must not cross the interceptor boundary");
    }

    Map<String, List<String>> full = new LinkedHashMap<>();
    full.put("content-length", Arrays.asList("0, 9356122"));
    full.put("content-type", Arrays.asList("text/plain; charset=\"UTF-8\", text/plain"));
    require("9356122".equals(value(AuthenticatedResponseHeaders.from(full), "Content-Length")), "duplicate full length must select the body");
    require("text/plain; charset=\"UTF-8\"".equals(AuthenticatedResponseHeaders.contentType(full)), "MIME charset must stay canonical");

    Map<String, List<String>> empty = new LinkedHashMap<>();
    empty.put("CONTENT-LENGTH", Arrays.asList("0"));
    require("0".equals(value(AuthenticatedResponseHeaders.from(empty), "Content-Length")), "an empty response must stay empty");

    Map<String, List<String>> invalid = new LinkedHashMap<>();
    invalid.put("Content-Length", Arrays.asList("invalid", "-1"));
    invalid.put("Content-Range", Arrays.asList("bytes 9-2/10"));
    invalid.put("Content-Type", Arrays.asList("not a mime type"));
    Map<String, String> rejected = AuthenticatedResponseHeaders.from(invalid);
    require(!contains(rejected, "Content-Length"), "invalid length must be omitted");
    require(!contains(rejected, "Content-Range"), "invalid range must be omitted");
    require(AuthenticatedResponseHeaders.contentType(invalid) == null, "invalid MIME type must be omitted");

    System.out.println("authenticated-response-headers: ok");
  }

  private static boolean contains(Map<String, String> headers, String name) {
    return value(headers, name) != null;
  }

  private static String value(Map<String, String> headers, String name) {
    for (Map.Entry<String, String> entry : headers.entrySet()) if (entry.getKey().equalsIgnoreCase(name)) return entry.getValue();
    return null;
  }

  private static void require(boolean condition, String message) {
    if (!condition) throw new AssertionError(message);
  }
}
