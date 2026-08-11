package local.fanhao.library;

import android.content.Intent;
import android.content.pm.PackageInfo;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;

import androidx.core.content.FileProvider;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.security.MessageDigest;
import java.util.Locale;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

@CapacitorPlugin(name = "FanHaoUpdater")
public class FanHaoUpdaterPlugin extends Plugin {
  private static final String APK_MIME = "application/vnd.android.package-archive";
  private final ExecutorService executor = Executors.newSingleThreadExecutor();

  @PluginMethod
  public void getInstalledVersion(PluginCall call) {
    try {
      PackageInfo info = getContext().getPackageManager().getPackageInfo(getContext().getPackageName(), 0);
      JSObject result = new JSObject();
      result.put("packageName", getContext().getPackageName());
      result.put("versionName", info.versionName == null ? "" : info.versionName);
      result.put("versionCode", installedVersionCode(info));
      result.put("sdkInt", Build.VERSION.SDK_INT);
      result.put("canRequestPackageInstalls", canRequestPackageInstalls());
      call.resolve(result);
    } catch (Exception error) {
      call.reject("读取应用版本失败", error);
    }
  }

  @PluginMethod
  public void openInstallPermissionSettings(PluginCall call) {
    try {
      openUnknownAppSourcesSettings();
      JSObject result = new JSObject();
      result.put("opened", true);
      call.resolve(result);
    } catch (Exception error) {
      call.reject("无法打开安装权限设置", error);
    }
  }

  @PluginMethod
  public void downloadAndInstall(PluginCall call) {
    String rawUrl = call.getString("url");
    String rawServiceBase = call.getString("serviceBase");
    URL trustedUrl;
    String expectedSha256;
    try {
      trustedUrl = AndroidUpdatePolicy.requireTrustedDownloadUrl(rawUrl, rawServiceBase);
      expectedSha256 = AndroidUpdatePolicy.requireSha256(call.getString("sha256"));
    } catch (IllegalArgumentException error) {
      call.reject(error.getMessage(), error);
      return;
    }

    if (!canRequestPackageInstalls()) {
      try {
        openUnknownAppSourcesSettings();
      } catch (Exception ignored) {
      }
      JSObject result = new JSObject();
      result.put("started", false);
      result.put("needsPermission", true);
      call.resolve(result);
      return;
    }

    String fileName = sanitizeApkFileName(call.getString("fileName"));

    executor.execute(() -> {
      try {
        File apk = downloadApk(trustedUrl, fileName, expectedSha256);
        getActivity().runOnUiThread(() -> {
          try {
            openInstaller(apk);
            JSObject result = new JSObject();
            result.put("started", true);
            result.put("fileName", apk.getName());
            call.resolve(result);
          } catch (Exception error) {
            call.reject("打开安装器失败", error);
          }
        });
      } catch (Exception error) {
        getActivity().runOnUiThread(() -> call.reject(error.getMessage() == null ? "下载安装包失败" : error.getMessage(), error));
      }
    });
  }

  private long installedVersionCode(PackageInfo info) {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) return info.getLongVersionCode();
    return info.versionCode;
  }

  private boolean canRequestPackageInstalls() {
    return Build.VERSION.SDK_INT < Build.VERSION_CODES.O || getContext().getPackageManager().canRequestPackageInstalls();
  }

  private void openUnknownAppSourcesSettings() {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
    Intent intent = new Intent(
      Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
      Uri.parse("package:" + getContext().getPackageName())
    );
    intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
    getActivity().startActivity(intent);
  }

  private File downloadApk(URL url, String fileName, String expectedSha256) throws Exception {
    File updateDir = new File(getContext().getCacheDir(), "updates");
    if (!updateDir.exists() && !updateDir.mkdirs()) {
      throw new IllegalStateException("无法创建更新缓存目录");
    }
    File apk = new File(updateDir, fileName);

    HttpURLConnection connection = (HttpURLConnection) url.openConnection();
    connection.setConnectTimeout(30000);
    connection.setReadTimeout(120000);
    connection.setInstanceFollowRedirects(false);
    connection.setRequestProperty("User-Agent", "FanHaoAndroidApp/Updater");
    connection.setRequestProperty("X-FanHao-Client", "android");
    connection.setRequestProperty("Accept", APK_MIME);

    try {
      int status = connection.getResponseCode();
      if (status < 200 || status >= 300) {
        throw new IllegalStateException("APK 下载失败：" + status);
      }

      MessageDigest digest = MessageDigest.getInstance("SHA-256");
      try (InputStream input = connection.getInputStream(); FileOutputStream output = new FileOutputStream(apk, false)) {
        byte[] buffer = new byte[64 * 1024];
        int read;
        while ((read = input.read(buffer)) >= 0) {
          if (read == 0) continue;
          digest.update(buffer, 0, read);
          output.write(buffer, 0, read);
        }
      }

      if (apk.length() <= 0) {
        throw new IllegalStateException("下载到的 APK 为空");
      }

      String actualSha256 = hex(digest.digest());
      if (!actualSha256.equalsIgnoreCase(expectedSha256)) {
        throw new IllegalStateException("APK 校验失败");
      }
      return apk;
    } catch (Exception error) {
      if (apk.exists()) apk.delete();
      throw error;
    } finally {
      connection.disconnect();
    }
  }

  private void openInstaller(File apk) {
    Uri uri = FileProvider.getUriForFile(
      getContext(),
      getContext().getPackageName() + ".fileprovider",
      apk
    );
    Intent intent = new Intent(Intent.ACTION_VIEW);
    intent.setDataAndType(uri, APK_MIME);
    intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
    intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
    getContext().startActivity(intent);
  }

  private String sanitizeApkFileName(String value) {
    String clean = value == null ? "" : value.replaceAll("[\\\\/:*?\"<>|\\r\\n]+", "_").trim();
    if (!clean.toLowerCase(Locale.ROOT).endsWith(".apk")) clean = clean + ".apk";
    return clean.isEmpty() || ".apk".equals(clean) ? "fanhao-update.apk" : clean;
  }

  private String hex(byte[] bytes) {
    StringBuilder builder = new StringBuilder(bytes.length * 2);
    for (byte value : bytes) {
      builder.append(String.format(Locale.ROOT, "%02x", value & 0xff));
    }
    return builder.toString();
  }
}
