package local.fanhao.library;

import android.content.Context;
import android.content.SharedPreferences;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.net.CookieHandler;
import java.net.HttpURLConnection;
import java.net.URI;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import org.json.JSONObject;

@CapacitorPlugin(name = "FanHaoAuth")
public class FanHaoAuthPlugin extends Plugin {
  private static final String PREFS = "fanhao.server-auth.v1";
  private static ServerAuthSession sessions;
  private final ExecutorService executor = Executors.newSingleThreadExecutor();
  private volatile boolean destroyed;
  private volatile HttpURLConnection activeLogin;

  public static synchronized ServerAuthSession install(Context context) {
    if (sessions == null) {
      sessions = new ServerAuthSession();
      for (Map.Entry<String, ?> entry : context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getAll().entrySet()) {
        if (!(entry.getValue() instanceof String)) continue;
        try { sessions.save(entry.getKey(), (String) entry.getValue()); } catch (IllegalArgumentException ignored) {}
      }
    }
    CookieHandler.setDefault(sessions);
    return sessions;
  }

  @PluginMethod public void getSession(PluginCall call) {
    getActivity().runOnUiThread(() -> {
      if (!localCaller(call)) return;
      JSObject result = new JSObject();
      result.put("token", install(getContext()).token(call.getString("serverUrl", "")));
      call.resolve(result);
    });
  }

  @PluginMethod public void login(PluginCall call) {
    getActivity().runOnUiThread(() -> startLogin(call, "/auth/login"));
  }

  @PluginMethod public void loginAccount(PluginCall call) {
    getActivity().runOnUiThread(() -> startLogin(call, "/api/accounts/login"));
  }

  @PluginMethod public void registerAccount(PluginCall call) {
    getActivity().runOnUiThread(() -> startLogin(call, "/api/accounts/register"));
  }

  @PluginMethod public void clearSession(PluginCall call) {
    getActivity().runOnUiThread(() -> {
      if (!localCaller(call)) return;
      String origin = ServerAuthSession.origin(call.getString("serverUrl", ""));
      if (origin.isEmpty()) { call.reject("服务地址无效"); return; }
      if (!getContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().remove(origin).commit()) {
        call.reject("无法清除保存的会话，请重试"); return;
      }
      install(getContext()).save(origin, "");
      call.resolve();
    });
  }

  private void startLogin(PluginCall call, String endpoint) {
    if (destroyed || call.isReleased()) return;
    if (!localCaller(call)) return;
    String value = call.getString("serverUrl", "");
    String origin = ServerAuthSession.origin(value);
    String password = call.getString("password", "");
    try {
      URI uri = new URI(value);
      if (origin.isEmpty() || (uri.getPath() != null && !uri.getPath().isEmpty() && !uri.getPath().equals("/"))
          || uri.getQuery() != null || uri.getFragment() != null || password.isEmpty()) throw new IllegalArgumentException();
    } catch (Exception ignored) { call.reject("请输入有效的服务地址和访问密码"); return; }
    executor.execute(() -> {
      if (destroyed || call.isReleased()) return;
      HttpURLConnection connection = null;
      try {
        connection = (HttpURLConnection) new URL(origin + endpoint).openConnection();
        activeLogin = connection;
        connection.setInstanceFollowRedirects(false);
        connection.setConnectTimeout(15000);
        connection.setReadTimeout(15000);
        connection.setRequestMethod("POST");
        connection.setRequestProperty("Content-Type", "application/json");
        connection.setRequestProperty("Accept", "application/json");
        connection.setDoOutput(true);
        JSONObject fields = new JSONObject().put("password", password).put("client", "android");
        if (!endpoint.equals("/auth/login")) {
          fields.put("username", call.getString("username", ""));
          if (!call.getString("displayName", "").isEmpty()) fields.put("displayName", call.getString("displayName"));
          fields.put("inviteCode", call.getString("inviteCode", ""));
        }
        byte[] body = fields.toString().getBytes(StandardCharsets.UTF_8);
        connection.setFixedLengthStreamingMode(body.length);
        try (java.io.OutputStream output = connection.getOutputStream()) { output.write(body); }
        int status = connection.getResponseCode();
        ByteArrayOutputStream buffer = new ByteArrayOutputStream();
        try (InputStream input = status >= 400 ? connection.getErrorStream() : connection.getInputStream()) {
          if (input == null) throw new IllegalArgumentException("Empty login response");
          byte[] bytes = new byte[4096];
          for (int count; (count = input.read(bytes)) != -1;) {
            if (buffer.size() + count > 16384) throw new IllegalArgumentException("Oversized login response");
            buffer.write(bytes, 0, count);
          }
        }
        JSONObject payload = new JSONObject(buffer.toString("UTF-8"));
        if (status != 200 && status != 201) {
          call.reject(payload.optString("error", "登录失败（" + status + "）")); return;
        }
        String token = payload.optString("token", "");
        if (!payload.optBoolean("ok") || token.isEmpty()) throw new IllegalArgumentException("Server does not support app login");
        if (destroyed || call.isReleased()) return;
        ServerAuthSession store = install(getContext());
        store.save(origin, token);
        SharedPreferences preferences = getContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        if (!preferences.edit().putString(origin, token).commit()) {
          store.save(origin, "");
          throw new IllegalStateException("Session could not be saved");
        }
        JSObject result = new JSObject();
        result.put("token", token);
        if (!destroyed && !call.isReleased()) call.resolve(result);
      } catch (Exception error) { if (!destroyed && !call.isReleased()) call.reject("无法完成登录，请检查网络和服务版本"); }
      finally { activeLogin = null; if (connection != null) connection.disconnect(); }
    });
  }

  private boolean localCaller(PluginCall call) {
    String current = getBridge() == null || getBridge().getWebView() == null ? "" : getBridge().getWebView().getUrl();
    if (!"http://localhost".equals(ServerAuthSession.origin(current))) {
      call.reject("只有应用内页面可以访问登录会话");
      return false;
    }
    return true;
  }

  @Override protected void handleOnDestroy() {
    destroyed = true;
    HttpURLConnection connection = activeLogin;
    if (connection != null) connection.disconnect();
    executor.shutdownNow();
    super.handleOnDestroy();
  }
}
