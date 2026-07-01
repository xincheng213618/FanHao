package local.fanhao.library;

import android.content.ContentResolver;
import android.content.Intent;
import android.database.Cursor;
import android.net.Uri;
import android.provider.OpenableColumns;
import android.view.Window;
import android.view.WindowManager;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.net.URLDecoder;
import java.nio.ByteBuffer;
import java.nio.charset.CharacterCodingException;
import java.nio.charset.Charset;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;
import java.util.Locale;

@CapacitorPlugin(name = "FanHaoNovel")
public class FanHaoNovelPlugin extends Plugin {
  private static final int MAX_TEXT_BYTES = 80 * 1024 * 1024;

  @PluginMethod
  public void setReaderBrightness(PluginCall call) {
    double rawBrightness = call.getDouble("brightness", 1.0);
    float brightness = (float) Math.max(0.05, Math.min(1.0, rawBrightness));
    if (getActivity() == null) {
      call.reject("无法调整屏幕亮度");
      return;
    }

    getActivity().runOnUiThread(() -> {
      try {
        Window window = getActivity().getWindow();
        WindowManager.LayoutParams attributes = window.getAttributes();
        attributes.screenBrightness = brightness;
        window.setAttributes(attributes);
        JSObject result = new JSObject();
        result.put("brightness", brightness);
        call.resolve(result);
      } catch (Exception error) {
        call.reject("调整屏幕亮度失败", error);
      }
    });
  }

  @PluginMethod
  public void clearReaderBrightness(PluginCall call) {
    if (getActivity() == null) {
      call.resolve(new JSObject());
      return;
    }

    getActivity().runOnUiThread(() -> {
      try {
        Window window = getActivity().getWindow();
        WindowManager.LayoutParams attributes = window.getAttributes();
        attributes.screenBrightness = WindowManager.LayoutParams.BRIGHTNESS_OVERRIDE_NONE;
        window.setAttributes(attributes);
        JSObject result = new JSObject();
        result.put("cleared", true);
        call.resolve(result);
      } catch (Exception error) {
        call.reject("恢复屏幕亮度失败", error);
      }
    });
  }

  @PluginMethod
  public void consumePendingTextFile(PluginCall call) {
    Intent intent = getActivity() == null ? null : getActivity().getIntent();
    if (!looksLikeTextIntent(intent)) {
      JSObject result = new JSObject();
      result.put("available", false);
      call.resolve(result);
      return;
    }

    try {
      JSObject result = readIntentText(intent);
      clearPendingIntent();
      call.resolve(result);
    } catch (Exception error) {
      clearPendingIntent();
      call.reject(error.getMessage() == null ? "读取本地文本失败" : error.getMessage(), error);
    }
  }

  static boolean looksLikeTextIntent(Intent intent) {
    if (intent == null) return false;
    String action = intent.getAction();
    if (!Intent.ACTION_VIEW.equals(action) && !Intent.ACTION_SEND.equals(action)) return false;

    String type = intent.getType();
    if (type != null && type.toLowerCase(Locale.ROOT).startsWith("text/")) return true;
    Uri data = intent.getData();
    if (data != null && isTextUri(data)) return true;
    Object stream = intent.getParcelableExtra(Intent.EXTRA_STREAM);
    return stream instanceof Uri && isTextUri((Uri) stream);
  }

  private JSObject readIntentText(Intent intent) throws Exception {
    String action = intent.getAction();
    if (Intent.ACTION_SEND.equals(action)) {
      CharSequence text = intent.getCharSequenceExtra(Intent.EXTRA_TEXT);
      if (text != null && text.length() > 0) {
        return textResult("shared-text.txt", "text/plain", "utf-8", text.toString(), text.length(), "");
      }
    }

    Uri uri = intent.getData();
    if (uri == null) {
      Object stream = intent.getParcelableExtra(Intent.EXTRA_STREAM);
      if (stream instanceof Uri) uri = (Uri) stream;
    }
    if (uri == null) throw new IllegalArgumentException("没有可读取的文本文件");

    ContentResolver resolver = getContext().getContentResolver();
    String mime = resolver.getType(uri);
    String fileName = displayName(resolver, uri);
    byte[] bytes = readAllBytes(resolver, uri);
    DecodedText decoded = decodeText(bytes);
    return textResult(fileName, mime, decoded.encoding, decoded.text, bytes.length, uri.toString());
  }

  private JSObject textResult(String fileName, String mime, String encoding, String text, long sizeBytes, String uri) {
    JSObject result = new JSObject();
    result.put("available", true);
    result.put("fileName", sanitizeFileName(fileName));
    result.put("mimeType", mime == null || mime.trim().isEmpty() ? "text/plain" : mime);
    result.put("encoding", encoding);
    result.put("sizeBytes", sizeBytes);
    result.put("text", text == null ? "" : text);
    result.put("uri", uri == null ? "" : uri);
    return result;
  }

  private byte[] readAllBytes(ContentResolver resolver, Uri uri) throws Exception {
    try (InputStream input = resolver.openInputStream(uri)) {
      if (input == null) throw new IllegalArgumentException("无法打开文本文件");
      ByteArrayOutputStream output = new ByteArrayOutputStream();
      byte[] buffer = new byte[64 * 1024];
      int total = 0;
      int read;
      while ((read = input.read(buffer)) >= 0) {
        if (read == 0) continue;
        total += read;
        if (total > MAX_TEXT_BYTES) throw new IllegalArgumentException("文本文件太大，暂时只支持 80MB 以内");
        output.write(buffer, 0, read);
      }
      return output.toByteArray();
    }
  }

  private DecodedText decodeText(byte[] bytes) {
    if (bytes.length >= 3 && (bytes[0] & 0xff) == 0xef && (bytes[1] & 0xff) == 0xbb && (bytes[2] & 0xff) == 0xbf) {
      return new DecodedText("utf-8-sig", new String(bytes, 3, bytes.length - 3, StandardCharsets.UTF_8));
    }
    if (bytes.length >= 2 && (bytes[0] & 0xff) == 0xff && (bytes[1] & 0xff) == 0xfe) {
      return new DecodedText("utf-16le", new String(bytes, 2, bytes.length - 2, Charset.forName("UTF-16LE")));
    }
    if (bytes.length >= 2 && (bytes[0] & 0xff) == 0xfe && (bytes[1] & 0xff) == 0xff) {
      return new DecodedText("utf-16be", new String(bytes, 2, bytes.length - 2, Charset.forName("UTF-16BE")));
    }
    try {
      String text = StandardCharsets.UTF_8
        .newDecoder()
        .onMalformedInput(CodingErrorAction.REPORT)
        .onUnmappableCharacter(CodingErrorAction.REPORT)
        .decode(ByteBuffer.wrap(bytes))
        .toString();
      return new DecodedText("utf-8", text);
    } catch (CharacterCodingException ignored) {
      return new DecodedText("gb18030", new String(bytes, Charset.forName("GB18030")));
    }
  }

  private String displayName(ContentResolver resolver, Uri uri) {
    if ("content".equalsIgnoreCase(uri.getScheme())) {
      try (Cursor cursor = resolver.query(uri, new String[] { OpenableColumns.DISPLAY_NAME }, null, null, null)) {
        if (cursor != null && cursor.moveToFirst()) {
          String value = cursor.getString(0);
          if (value != null && !value.trim().isEmpty()) return value;
        }
      } catch (Exception ignored) {
      }
    }

    String path = uri.getLastPathSegment();
    if (path == null || path.trim().isEmpty()) return "local-text.txt";
    int slash = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
    String value = slash >= 0 ? path.substring(slash + 1) : path;
    try {
      value = URLDecoder.decode(value, "UTF-8");
    } catch (Exception ignored) {
    }
    return value;
  }

  private String sanitizeFileName(String value) {
    String clean = value == null ? "" : value.replaceAll("[\\\\/:*?\"<>|\\r\\n]+", "_").trim();
    if (clean.isEmpty()) clean = "local-text.txt";
    if (!clean.toLowerCase(Locale.ROOT).endsWith(".txt")) clean += ".txt";
    return clean;
  }

  private void clearPendingIntent() {
    if (getActivity() == null) return;
    Intent clean = new Intent(Intent.ACTION_MAIN);
    clean.setPackage(getContext().getPackageName());
    getActivity().setIntent(clean);
  }

  private static boolean isTextUri(Uri uri) {
    String value = uri == null ? "" : uri.toString().toLowerCase(Locale.ROOT);
    return value.endsWith(".txt") || value.contains(".txt?");
  }

  private static final class DecodedText {
    final String encoding;
    final String text;

    DecodedText(String encoding, String text) {
      this.encoding = encoding;
      this.text = text;
    }
  }
}
