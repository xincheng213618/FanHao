package local.fanhao.library;

import android.net.Uri;

import org.json.JSONObject;

import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.Collections;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Map;
import java.util.Set;

/** HTTP adapter for the existing durable short-video delete APIs. */
final class NativeShortVideoDeleteTransport implements NativeShortVideoDeleteController.Transport {
  private final Set<HttpURLConnection> activeConnections = Collections.synchronizedSet(new HashSet<>());

  @Override public DeleteResult delete(String url, String expectedVideoId) throws Exception {
    HttpURLConnection connection = open(url, "DELETE");
    try {
      connection.connect();
      int status = connection.getResponseCode();
      JSONObject data = responseJson(connection, status);
      return ShortVideoDeleteJson.parse(status, data, expectedVideoId);
    } finally {
      close(connection);
    }
  }

  @Override public NativeShortVideoDeleteJobState status(String apiBaseUrl, String jobId) throws Exception {
    String url = recoveryUrl(apiBaseUrl) + "?jobId=" + Uri.encode(jobId);
    return requestJob(url, "GET", null, jobId);
  }

  @Override public NativeShortVideoDeleteJobState recover(String apiBaseUrl, String jobId) throws Exception {
    JSONObject payload = new JSONObject().put("jobId", jobId);
    return requestJob(recoveryUrl(apiBaseUrl), "POST", payload, jobId);
  }

  @Override public void cancel() {
    HttpURLConnection[] connections;
    synchronized (activeConnections) {
      connections = activeConnections.toArray(new HttpURLConnection[0]);
      activeConnections.clear();
    }
    for (HttpURLConnection connection : connections) connection.disconnect();
  }

  private NativeShortVideoDeleteJobState requestJob(
    String url,
    String method,
    JSONObject payload,
    String expectedJobId
  ) throws Exception {
    HttpURLConnection connection = open(url, method);
    try {
      if (payload != null) {
        byte[] bytes = payload.toString().getBytes(StandardCharsets.UTF_8);
        connection.setDoOutput(true);
        connection.setRequestProperty("Content-Type", "application/json; charset=utf-8");
        connection.setFixedLengthStreamingMode(bytes.length);
        try (OutputStream output = connection.getOutputStream()) {
          output.write(bytes);
        }
      }
      int status = connection.getResponseCode();
      JSONObject data = responseJson(connection, status);
      if (status < 200 || status >= 300) {
        throw new IllegalArgumentException(data.optString("error", "删除恢复请求失败"));
      }
      JSONObject job = data.optJSONObject("job");
      if (job == null) throw new IllegalArgumentException("删除恢复接口没有返回任务状态");
      return NativeShortVideoDeleteJobState.fromMap(jobMap(job), expectedJobId);
    } finally {
      close(connection);
    }
  }

  private HttpURLConnection open(String url, String method) throws Exception {
    HttpURLConnection connection = (HttpURLConnection) new URL(url).openConnection();
    activeConnections.add(connection);
    connection.setRequestMethod(method);
    connection.setConnectTimeout(8000);
    connection.setReadTimeout(16000);
    connection.setRequestProperty("Accept", "application/json");
    return connection;
  }

  private JSONObject responseJson(HttpURLConnection connection, int status) throws Exception {
    String body = NativeShortVideoHttpResponse.readUtf8(connection, status >= 200 && status < 300);
    return body.length() > 0 ? new JSONObject(body) : new JSONObject();
  }

  private void close(HttpURLConnection connection) {
    activeConnections.remove(connection);
    connection.disconnect();
  }

  private String recoveryUrl(String apiBaseUrl) {
    String base = apiBaseUrl == null ? "" : apiBaseUrl.trim().replaceAll("/$", "");
    if (!base.startsWith("http://") && !base.startsWith("https://")) {
      throw new IllegalArgumentException("没有可用的删除恢复接口");
    }
    return base + "/api/short-videos/delete-jobs";
  }

  private Map<String, Object> jobMap(JSONObject job) {
    Map<String, Object> row = new HashMap<>();
    for (String key : new String[] {
      "id", "status", "phase", "pending", "recoverable", "requiresAttention", "error"
    }) {
      if (job.has(key) && !job.isNull(key)) row.put(key, job.opt(key));
    }
    return row;
  }
}
