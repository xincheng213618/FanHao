package local.fanhao.library;

import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebView;
import com.getcapacitor.Bridge;
import com.getcapacitor.BridgeWebViewClient;
import java.io.ByteArrayInputStream;
import java.io.FilterInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;

/** WebView images/media do not send cross-site Lax cookies. Stream only a signed-in origin. */
public final class AuthenticatedWebViewClient extends BridgeWebViewClient {
  private final ServerAuthSession sessions;
  public AuthenticatedWebViewClient(Bridge bridge, ServerAuthSession sessions) {
    super(bridge);
    this.sessions = sessions;
  }

  @Override public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
    String address = request.getUrl().toString();
    String token = sessions.token(address);
    if (request.isForMainFrame() || (!request.getMethod().equals("GET") && !request.getMethod().equals("HEAD"))
        || token.isEmpty()) return super.shouldInterceptRequest(view, request);
    HttpURLConnection connection = null;
    try {
      String origin = ServerAuthSession.origin(address);
      for (int redirect = 0; redirect < 5; redirect++) {
        connection = (HttpURLConnection) new URL(address).openConnection();
        connection.setInstanceFollowRedirects(false);
        connection.setConnectTimeout(15000);
        connection.setReadTimeout(30000);
        connection.setRequestMethod(request.getMethod());
        for (Map.Entry<String, String> header : request.getRequestHeaders().entrySet()) {
          String key = header.getKey().toLowerCase(Locale.ROOT);
          if (key.equals("cookie") || key.equals("authorization") || key.equals("host")
              || key.equals("if-none-match") || key.equals("if-modified-since") || key.equals("accept-encoding")) continue;
          connection.setRequestProperty(header.getKey(), header.getValue());
        }
        connection.setRequestProperty("Accept-Encoding", "identity");
        connection.setRequestProperty("Authorization", "Bearer " + token);
        int status = connection.getResponseCode();
        if (status >= 300 && status < 400) {
          String location = connection.getHeaderField("Location");
          if (location == null) throw new IOException("Invalid redirect");
          String next = new URL(new URL(address), location).toString();
          if (!origin.equals(ServerAuthSession.origin(next))) throw new IOException("Cross-origin redirect refused");
          connection.disconnect();
          connection = null;
          address = next;
          continue;
        }
        Map<String, List<String>> sourceHeaders = connection.getHeaderFields();
        Map<String, String> headers = AuthenticatedResponseHeaders.from(sourceHeaders);
        String contentType = AuthenticatedResponseHeaders.contentType(sourceHeaders);
        String mime = contentType == null ? "application/octet-stream" : contentType.split(";", 2)[0];
        String encoding = responseCharacterEncoding(contentType);
        InputStream input = status >= 400 ? connection.getErrorStream() : connection.getInputStream();
        if (input == null) input = new ByteArrayInputStream(new byte[0]);
        final HttpURLConnection owner = connection;
        InputStream stream = new FilterInputStream(input) {
          @Override public void close() throws IOException { try { super.close(); } finally { owner.disconnect(); } }
        };
        String reason = connection.getResponseMessage();
        WebResourceResponse response = new WebResourceResponse(mime, encoding, status,
          reason == null || reason.isEmpty() ? "Response" : reason, headers, stream);
        connection = null;
        return response;
      }
    } catch (Exception ignored) {
      // Never fall back to an unauthenticated request or forward a session to another origin.
    } finally { if (connection != null) connection.disconnect(); }
    return new WebResourceResponse("text/plain", "UTF-8", 502, "Request failed", new HashMap<>(),
      new ByteArrayInputStream(new byte[0]));
  }

  static String responseCharacterEncoding(String contentType) {
    if (contentType == null) return null;
    for (String parameter : contentType.split(";")) {
      String value = parameter.trim();
      int separator = value.indexOf('=');
      if (separator <= 0 || !value.substring(0, separator).trim().equalsIgnoreCase("charset")) continue;
      String charset = value.substring(separator + 1).trim();
      if (charset.length() >= 2 && charset.startsWith("\"") && charset.endsWith("\"")) {
        charset = charset.substring(1, charset.length() - 1).trim();
      }
      return charset.isEmpty() ? null : charset;
    }
    // Audio, video, images and other binary responses have no character encoding.
    return null;
  }
}
