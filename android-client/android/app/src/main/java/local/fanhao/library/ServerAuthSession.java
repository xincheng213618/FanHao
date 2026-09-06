package local.fanhao.library;

import java.net.CookieHandler;
import java.net.URI;
import java.io.IOException;
import java.util.Collections;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

/** Only app-created FanHao sessions; never imports browser cookies. */
public final class ServerAuthSession extends CookieHandler {
  private final Map<String, String> tokens = new ConcurrentHashMap<>();
  private static final ThreadLocal<RequestScope> requestScope = new ThreadLocal<>();

  // A native player captures this only for its private Intent. Preserve expired
  // tokens here: turning an old account into an empty guest token is unsafe.
  static String captureToken(String url) {
    CookieHandler handler = CookieHandler.getDefault();
    if (!(handler instanceof ServerAuthSession)) return null;
    return ((ServerAuthSession) handler).tokens.getOrDefault(origin(url), "");
  }

  static RequestScope bindRequest(String sourceUrl, String targetUrl, String token) throws IOException {
    String source = origin(sourceUrl);
    if (source.isEmpty() || !source.equals(origin(targetUrl)) || token == null
        || (!token.isEmpty() && !isCurrent(token)) || !token.equals(captureToken(source))) {
      throw new IOException("Playback account session changed or expired");
    }
    RequestScope scope = new RequestScope(source, token, requestScope.get());
    requestScope.set(scope);
    return scope;
  }

  static final class RequestScope implements AutoCloseable {
    private final String origin;
    private final String token;
    private final RequestScope previous;

    private RequestScope(String origin, String token, RequestScope previous) {
      this.origin = origin;
      this.token = token;
      this.previous = previous;
    }

    @Override public void close() {
      if (previous == null) requestScope.remove();
      else requestScope.set(previous);
    }
  }

  public static String origin(String value) {
    try {
      URI uri = new URI(value);
      String scheme = uri.getScheme() == null ? "" : uri.getScheme().toLowerCase(Locale.ROOT);
      if ((!scheme.equals("http") && !scheme.equals("https")) || uri.getHost() == null || uri.getUserInfo() != null) return "";
      int port = uri.getPort();
      if (port == (scheme.equals("https") ? 443 : 80)) port = -1;
      return scheme + "://" + uri.getHost().toLowerCase(Locale.ROOT) + (port < 0 ? "" : ":" + port);
    } catch (Exception ignored) { return ""; }
  }

  public void save(String url, String token) {
    String key = origin(url);
    if (key.isEmpty()) throw new IllegalArgumentException("Invalid server URL");
    if (token == null || token.isEmpty()) tokens.remove(key);
    else if (isCurrent(token)) tokens.put(key, token);
    else throw new IllegalArgumentException("Invalid server session");
  }

  public String token(String url) {
    String token = tokens.get(origin(url));
    return isCurrent(token) ? token : "";
  }

  private static boolean isCurrent(String token) {
    if (token == null || !token.matches("(?:web\\.[0-9]{1,12}\\.[A-Za-z0-9_-]{16}\\.[A-Za-z0-9_-]{43}|usr\\.[0-9]{1,12}\\.[A-Za-z0-9_-]{43})")) return false;
    long age = System.currentTimeMillis() / 1000 - Long.parseLong(token.split("\\.")[1]);
    return age >= -60 && age <= 30L * 24 * 60 * 60;
  }

  @Override public Map<String, List<String>> get(URI uri, Map<String, List<String>> requestHeaders) {
    // A session may switch after bindRequest but before HttpURLConnection asks
    // for cookies. Pin this worker's cookie without changing any other thread.
    RequestScope scope = requestScope.get();
    String token = scope == null ? token(uri.toString())
      : scope.origin.equals(origin(uri.toString())) ? scope.token : "";
    return token.isEmpty() ? Collections.emptyMap()
      : Collections.singletonMap("Cookie", Collections.singletonList("fanhao_web_auth=" + token));
  }

  @Override public void put(URI uri, Map<String, List<String>> responseHeaders) {
    // Only a successful explicit password login may create a native session.
  }
}
