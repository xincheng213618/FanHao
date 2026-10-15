package local.fanhao.library;

import java.io.*;
import java.net.*;
import java.nio.charset.StandardCharsets;
import java.util.*;

public final class ServerAuthSessionHarness {
  public static void main(String[] args) throws Exception {
    ServerAuthSession sessions = new ServerAuthSession();
    String token = "web." + (System.currentTimeMillis() / 1000) + ".abcdefghijklmnop." + repeat('s', 43);
    String root = "http://example.test:29998";
    sessions.save(root, token);
    require(sessions.token(root + "/media/a").equals(token), "same-origin media session");
    for (String other : Arrays.asList("http://example.test:29999", "https://example.test:29998", "http://other.test:29998",
        "http://example.test.evil:29998", "http://user@example.test:29998"))
      require(sessions.token(other).isEmpty(), "credentials isolated from " + other);
    require(ServerAuthSession.origin("https://EXAMPLE.test:443/path").equals("https://example.test"), "default port normalization");
    sessions.put(new URI("https://other.test"), Collections.singletonMap("Set-Cookie", Arrays.asList("fanhao_web_auth=" + token)));
    require(sessions.token("https://other.test").isEmpty(), "response cannot create a native session");
    boolean expired = false;
    try { sessions.save(root, "web.1.abcdefghijklmnop." + repeat('s', 43)); } catch (IllegalArgumentException expected) { expired = true; }
    require(expired, "expired session rejected");
    String accountToken = "usr." + (System.currentTimeMillis() / 1000) + "." + repeat('u', 43);
    sessions.save(root, accountToken);
    require(sessions.token(root + "/media/a").equals(accountToken), "account token reaches native media");
    require(sessions.token("https://example.test:29998").isEmpty(), "account token stays origin scoped");
    sessions.save(root, token);

    CookieHandler previous = CookieHandler.getDefault();
    try (TestServer destination = new TestServer(); TestServer source = new TestServer()) {
      source.redirect = destination.root() + "/target";
      sessions.save(source.root(), token);
      CookieHandler.setDefault(sessions);
      sessions.save(source.root(), accountToken);
      require(read(source.root() + "/range", true) == 206, "account-authenticated native range request");
      require(source.lastCookie.equals("fanhao_web_auth=" + accountToken), "native HTTP automatically sends account token");
      sessions.save(source.root(), token);
      require(read(source.root() + "/range", true) == 206, "media range request");
      require(source.lastCookie.equals("fanhao_web_auth=" + token), "native HTTP automatically sends its session");
      require(read(source.root() + "/same", false) == 200, "same-origin redirect works");
      require(source.lastCookie.equals("fanhao_web_auth=" + token), "same-origin redirect keeps session");
      require(read(source.root() + "/redirect", false) == 200, "cross-origin redirect follows normally");
      require(destination.lastCookie.isEmpty(), "cross-origin redirect MUST NOT forward session");
      sessions.save(source.root(), accountToken);
      String captured = ServerAuthSession.captureToken(source.root());
      try (ServerAuthSession.RequestScope ignored = ServerAuthSession.bindRequest(source.root(), source.root() + "/progress", captured)) {
        sessions.save(source.root(), token);
        read(source.root() + "/progress", false);
        require(source.lastCookie.equals("fanhao_web_auth=" + accountToken), "mid-request switch must keep the opening account cookie");
        read(destination.root() + "/target", false);
        require(destination.lastCookie.isEmpty(), "captured playback session must remain origin scoped");
        java.util.concurrent.atomic.AtomicReference<Throwable> threadFailure = new java.util.concurrent.atomic.AtomicReference<>();
        Thread other = new Thread(() -> {
          try {
            read(source.root() + "/other-thread", false);
            require(source.lastCookie.equals("fanhao_web_auth=" + token), "playback override must not change another thread's current login");
          } catch (Throwable error) { threadFailure.set(error); }
        });
        other.start(); other.join(5000);
        require(!other.isAlive() && threadFailure.get() == null, "parallel account request failed");
      }
      read(source.root() + "/after", false);
      require(source.lastCookie.equals("fanhao_web_auth=" + token), "closing owner scope must restore current login");
      boolean changed = false;
      try (ServerAuthSession.RequestScope ignored = ServerAuthSession.bindRequest(source.root(), source.root() + "/progress", captured)) {
        throw new AssertionError("old account was accepted after switch");
      } catch (IOException expected) { changed = true; }
      require(changed, "old account must fail before a new request");
      sessions.save(source.root(), "");
      try (ServerAuthSession.RequestScope ignored = ServerAuthSession.bindRequest(source.root(), source.root() + "/progress", "")) {
        sessions.save(source.root(), accountToken);
        read(source.root() + "/guest-progress", false);
        require(source.lastCookie.isEmpty(), "guest playback must not inherit a concurrent account cookie");
      }
      sessions.save(source.root(), "");
      read(source.root() + "/ok", false);
      require(source.lastCookie.isEmpty(), "cleared session stops native credentials");
    } finally { CookieHandler.setDefault(previous); }
    System.out.println("server-auth-native: ok (origin scope, expiry, range, redirects, session removal, pinned playback cookies and concurrent identity)");
  }

  static String repeat(char value, int length) { char[] data = new char[length]; Arrays.fill(data, value); return new String(data); }
  static void require(boolean condition, String message) { if (!condition) throw new AssertionError(message); }
  static int read(String url, boolean range) throws Exception {
    HttpURLConnection connection = (HttpURLConnection) new URL(url).openConnection();
    connection.setConnectTimeout(3000); connection.setReadTimeout(3000);
    if (range) connection.setRequestProperty("Range", "bytes=0-1");
    try {
      int status = connection.getResponseCode();
      try (InputStream input = connection.getInputStream()) { while (input.read() != -1) {} }
      return status;
    } finally { connection.disconnect(); }
  }

  static final class TestServer implements AutoCloseable {
    final ServerSocket server = new ServerSocket(0, 10, InetAddress.getByName("127.0.0.1"));
    volatile String redirect = "";
    volatile String lastCookie = "";
    TestServer() throws Exception {
      Thread thread = new Thread(() -> {
        while (!server.isClosed()) {
          try (Socket socket = server.accept()) {
            BufferedReader reader = new BufferedReader(new InputStreamReader(socket.getInputStream(), StandardCharsets.US_ASCII));
            String first = reader.readLine(); lastCookie = ""; boolean range = false;
            for (String line; (line = reader.readLine()) != null && !line.isEmpty();) {
              if (line.toLowerCase(Locale.ROOT).startsWith("cookie:")) lastCookie = line.substring(7).trim();
              if (line.equalsIgnoreCase("Range: bytes=0-1")) range = true;
            }
            String result = "HTTP/1.1 " + (range ? "206 Partial Content" : "200 OK") + "\r\n";
            if (first.contains(" /redirect ")) result = "HTTP/1.1 302 Found\r\nLocation: " + redirect + "\r\n";
            if (first.contains(" /same ")) result = "HTTP/1.1 302 Found\r\nLocation: /ok\r\n";
            if (range) result += "Content-Range: bytes 0-1/2\r\n";
            result += "Content-Length: 2\r\nConnection: close\r\n\r\nok";
            socket.getOutputStream().write(result.getBytes(StandardCharsets.US_ASCII));
          } catch (IOException failure) { if (!server.isClosed()) throw new RuntimeException(failure); }
        }
      });
      thread.setDaemon(true); thread.start();
    }
    String root() { return "http://127.0.0.1:" + server.getLocalPort(); }
    @Override public void close() throws IOException { server.close(); }
  }
}
