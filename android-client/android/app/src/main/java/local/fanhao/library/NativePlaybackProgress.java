package local.fanhao.library;

import org.json.JSONObject;
import java.io.IOException;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.RejectedExecutionException;

/** Serial, latest-only progress delivery that does not retain the player Activity. */
final class NativePlaybackProgress implements AutoCloseable {
  interface Sender {
    void send(Snapshot snapshot) throws Exception;
  }

  interface Committed {
    void onCommitted(Snapshot snapshot);
  }

  static final class Snapshot {
    final String url;
    final String workId;
    final double position;
    final double duration;

    Snapshot(String url, String workId, double position, double duration) {
      this.url = url;
      this.workId = workId;
      this.position = position;
      this.duration = duration;
    }
  }

  private final ExecutorService executor;
  private final Sender sender;
  private final Committed committed;
  private Snapshot pending;
  private boolean draining;
  private boolean closed;

  NativePlaybackProgress(String sourceUrl, String ownerToken, Committed committed) {
    this(Executors.newSingleThreadExecutor(), snapshot -> {
      try (ServerAuthSession.RequestScope ignored = ServerAuthSession.bindRequest(sourceUrl, snapshot.url, ownerToken)) {
        post(snapshot, ownerToken);
      }
    }, committed);
  }

  NativePlaybackProgress(ExecutorService executor, Sender sender) {
    this(executor, sender, null);
  }

  NativePlaybackProgress(ExecutorService executor, Sender sender, Committed committed) {
    this.executor = executor;
    this.sender = sender;
    this.committed = committed;
  }

  synchronized void report(String url, String workId, double position, double duration) {
    if (closed || !isHttpUrl(url)
      || !Double.isFinite(position) || position < 0
      || !Double.isFinite(duration) || duration <= 0) return;
    pending = new Snapshot(url, workId, position, duration);
    if (draining) return;
    draining = true;
    try {
      executor.execute(this::drain);
    } catch (RejectedExecutionException ignored) {
      pending = null;
      draining = false;
    }
  }

  private static boolean isHttpUrl(String value) {
    if (value == null || value.trim().isEmpty()) return false;
    try {
      URL url = new URL(value);
      return ("http".equalsIgnoreCase(url.getProtocol()) || "https".equalsIgnoreCase(url.getProtocol()))
        && !url.getHost().isEmpty();
    } catch (Exception ignored) {
      return false;
    }
  }

  private void drain() {
    while (true) {
      Snapshot snapshot;
      synchronized (this) {
        snapshot = pending;
        pending = null;
        if (snapshot == null) {
          draining = false;
          return;
        }
      }
      try {
        sender.send(snapshot);
      } catch (Exception ignored) {
        // A failed request must not discard a newer pending position.
        continue;
      }
      try {
        if (committed != null) committed.onCommitted(snapshot);
      } catch (RuntimeException ignored) {
        // An unavailable UI/bridge must not interrupt accepted final delivery.
      }
    }
  }

  @Override
  public synchronized void close() {
    if (closed) return;
    closed = true;
    // The accepted drain owns its final snapshot; do not interrupt or discard it.
    // No Activity/UI thread waits for network I/O here.
    executor.shutdown();
  }

  private static void post(Snapshot snapshot, String ownerToken) throws Exception {
    HttpURLConnection connection = null;
    try {
      JSONObject body = new JSONObject();
      body.put("workId", snapshot.workId);
      body.put("position", snapshot.position);
      body.put("duration", snapshot.duration);
      byte[] payload = body.toString().getBytes(StandardCharsets.UTF_8);

      connection = (HttpURLConnection) new URL(snapshot.url).openConnection();
      connection.setConnectTimeout(3500);
      connection.setReadTimeout(3500);
      connection.setInstanceFollowRedirects(false);
      connection.setRequestMethod("POST");
      connection.setDoOutput(true);
      connection.setRequestProperty("Content-Type", "application/json; charset=utf-8");
      if (!ownerToken.isEmpty()) connection.setRequestProperty("Authorization", "Bearer " + ownerToken);
      if (!ownerToken.startsWith("usr.")) connection.setRequestProperty("X-FanHao-Account-Owner", "guest");
      connection.setFixedLengthStreamingMode(payload.length);
      try (OutputStream output = connection.getOutputStream()) {
        output.write(payload);
      }
      int status = connection.getResponseCode();
      if (status < 200 || status >= 300) throw new IOException("Progress commit rejected: HTTP " + status);
    } finally {
      if (connection != null) connection.disconnect();
    }
  }
}
