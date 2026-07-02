package local.fanhao.library;

import android.Manifest;
import android.app.Activity;
import android.content.ClipData;
import android.content.ContentResolver;
import android.content.ContentUris;
import android.content.Context;
import android.content.Intent;
import android.database.Cursor;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.OpenableColumns;
import android.provider.MediaStore;
import android.provider.Settings;
import android.util.Log;
import android.view.View;
import android.view.Window;
import android.view.WindowManager;
import android.widget.Toast;

import androidx.activity.result.ActivityResult;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.ByteArrayOutputStream;
import java.io.BufferedReader;
import java.io.File;
import java.io.FileInputStream;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.net.URLDecoder;
import java.nio.ByteBuffer;
import java.nio.charset.CharacterCodingException;
import java.nio.charset.Charset;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.TimeUnit;

@CapacitorPlugin(name = "FanHaoNovel")
public class FanHaoNovelPlugin extends Plugin {
  private static final String TAG = "FanHaoNovel";
  private static final int MAX_TEXT_BYTES = 80 * 1024 * 1024;
  private static final int MIN_IMPORT_TEXT_BYTES = 10 * 1024;
  private static final int MAX_IMPORT_TEXT_BYTES = 50 * 1024 * 1024;
  private static final int DEFAULT_SCAN_LIMIT = 50000;
  private static final int MAX_SCAN_LIMIT = 50000;
  private static final int DEFAULT_SCAN_DEPTH = 64;
  private static Intent pendingTextIntent = null;

  static void capturePendingTextIntent(Context context, Intent intent) {
    if (!shouldHandleTextIntent(context, intent)) return;
    pendingTextIntent = new Intent(intent);
  }

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
  public void hasTextScanAccess(PluginCall call) {
    JSObject result = new JSObject();
    result.put("available", true);
    result.put("sdk", Build.VERSION.SDK_INT);
    result.put("requiresAllFilesAccess", Build.VERSION.SDK_INT >= Build.VERSION_CODES.R);
    result.put("hasAccess", hasExternalTextScanAccess());
    call.resolve(result);
  }

  @PluginMethod
  public void requestTextScanAccess(PluginCall call) {
    if (getActivity() == null) {
      call.reject("无法打开系统文件权限设置");
      return;
    }

    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) {
      JSObject result = new JSObject();
      result.put("opened", false);
      result.put("hasAccess", hasExternalTextScanAccess());
      call.resolve(result);
      return;
    }

    try {
      Intent intent = new Intent(Settings.ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION);
      intent.setData(Uri.parse("package:" + getContext().getPackageName()));
      getActivity().startActivity(intent);
      JSObject result = new JSObject();
      result.put("opened", true);
      result.put("hasAccess", Environment.isExternalStorageManager());
      call.resolve(result);
    } catch (Exception error) {
      try {
        getActivity().startActivity(new Intent(Settings.ACTION_MANAGE_ALL_FILES_ACCESS_PERMISSION));
        JSObject result = new JSObject();
        result.put("opened", true);
        result.put("hasAccess", Environment.isExternalStorageManager());
        call.resolve(result);
      } catch (Exception fallbackError) {
        call.reject("无法打开系统文件权限设置", fallbackError);
      }
    }
  }

  @PluginMethod
  public void scanTextFiles(PluginCall call) {
    if (!hasExternalTextScanAccess()) {
      JSObject result = new JSObject();
      result.put("available", true);
      result.put("hasAccess", false);
      result.put("message", "需要授予所有文件访问权限，才能扫描手机里的 TXT。");
      result.put("items", new JSArray());
      call.resolve(result);
      return;
    }

    int limit = clampInteger(call.getInt("maxFiles"), DEFAULT_SCAN_LIMIT, 1, MAX_SCAN_LIMIT);
    int maxDepth = clampInteger(call.getInt("maxDepth"), DEFAULT_SCAN_DEPTH, 1, 128);
    new Thread(() -> {
      try {
        List<ScannedTextCandidate> files = findTextFiles(limit, maxDepth);
        Log.i(TAG, "scanTextFiles found " + files.size() + " txt files");
        JSArray items = new JSArray();
        for (ScannedTextCandidate file : files) {
          JSObject item = new JSObject();
          item.put("path", file.path);
          item.put("uri", file.uri);
          item.put("fileName", sanitizeFileName(file.fileName));
          item.put("sizeBytes", file.sizeBytes);
          item.put("lastModified", file.lastModified);
          item.put("modifiedAt", new java.text.SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSSZ", Locale.ROOT).format(new java.util.Date(file.lastModified)));
          item.put("recommended", isImportableTextCandidate(file.path, file.fileName, file.sizeBytes));
          item.put("hint", scanCandidateHint(file.path, file.fileName, file.sizeBytes));
          items.put(item);
        }
        JSObject result = new JSObject();
        result.put("available", true);
        result.put("hasAccess", true);
        result.put("items", items);
        result.put("truncated", files.size() >= limit);
        resolvePluginCall(call, result);
      } catch (Exception error) {
        rejectPluginCall(call, error.getMessage() == null ? "扫描 TXT 失败" : error.getMessage(), error);
      }
    }, "FanHaoTextScan").start();
  }

  @PluginMethod
  public void readScannedTextFile(PluginCall call) {
    if (!hasExternalTextScanAccess()) {
      call.reject("需要授予所有文件访问权限，才能读取扫描到的 TXT。");
      return;
    }

    String uri = call.getString("uri", "");
    String path = call.getString("path", "");
    new Thread(() -> {
      try {
        if (isContentUriString(uri)) {
          Uri contentUri = Uri.parse(uri);
          ContentResolver resolver = getContext().getContentResolver();
          String fileName = displayName(resolver, contentUri);
          String mime = resolver.getType(contentUri);
          byte[] bytes = readAllBytes(resolver, contentUri);
          DecodedText decoded = decodeText(bytes);
          resolvePluginCall(call, textResult(fileName, mime, decoded.encoding, decoded.text, bytes.length, contentUri.toString()));
          return;
        }
        File file = safeTextFileFromPath(path);
        byte[] bytes = readAllBytes(file);
        DecodedText decoded = decodeText(bytes);
        resolvePluginCall(call, textResult(file.getName(), "text/plain", decoded.encoding, decoded.text, bytes.length, Uri.fromFile(file).toString()));
      } catch (Exception error) {
        rejectPluginCall(call, error.getMessage() == null ? "读取 TXT 失败" : error.getMessage(), error);
      }
    }, "FanHaoTextRead").start();
  }

  @PluginMethod
  public void openTextDocumentPicker(PluginCall call) {
    if (getActivity() == null) {
      call.reject("无法打开系统文件管理器");
      return;
    }

    Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT);
    intent.addCategory(Intent.CATEGORY_OPENABLE);
    intent.setType("*/*");
    intent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
    intent.putExtra(Intent.EXTRA_MIME_TYPES, new String[] {
      "text/plain",
      "text/*",
      "application/octet-stream",
      "application/x-fictionbook",
      "application/epub+zip"
    });
    intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION);
    try {
      startActivityForResult(call, Intent.createChooser(intent, "选择 TXT 小说"), "textDocumentPickerResult");
    } catch (Exception error) {
      call.reject("无法打开系统文件管理器", error);
    }
  }

  @ActivityCallback
  private void textDocumentPickerResult(PluginCall call, ActivityResult result) {
    if (call == null) return;
    if (result.getResultCode() != Activity.RESULT_OK || result.getData() == null) {
      JSObject canceled = new JSObject();
      canceled.put("canceled", true);
      canceled.put("items", new JSArray());
      call.resolve(canceled);
      return;
    }

    Intent data = result.getData();
    new Thread(() -> {
      JSArray items = new JSArray();
      JSArray errors = new JSArray();
      try {
        ArrayList<Uri> uris = new ArrayList<>();
        ClipData clipData = data.getClipData();
        if (clipData != null) {
          for (int index = 0; index < clipData.getItemCount(); index += 1) {
            Uri uri = clipData.getItemAt(index).getUri();
            if (uri != null) uris.add(uri);
          }
        } else if (data.getData() != null) {
          uris.add(data.getData());
        }

        ContentResolver resolver = getContext().getContentResolver();
        int flags = data.getFlags() & (Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION);
        for (Uri uri : uris) {
          try {
            try {
              resolver.takePersistableUriPermission(uri, flags & Intent.FLAG_GRANT_READ_URI_PERMISSION);
            } catch (Exception ignored) {
            }
            String fileName = displayName(resolver, uri);
            if (!isTextFileName(fileName) && !isTextUri(uri)) {
              JSObject skipped = new JSObject();
              skipped.put("uri", uri.toString());
              skipped.put("fileName", sanitizeFileName(fileName));
              skipped.put("message", "不是 TXT 文件");
              errors.put(skipped);
              continue;
            }
            String mime = resolver.getType(uri);
            byte[] bytes = readAllBytes(resolver, uri);
            DecodedText decoded = decodeText(bytes);
            items.put(textResult(fileName, mime, decoded.encoding, decoded.text, bytes.length, uri.toString()));
          } catch (Exception error) {
            JSObject failed = new JSObject();
            failed.put("uri", uri == null ? "" : uri.toString());
            failed.put("message", error.getMessage() == null ? "读取失败" : error.getMessage());
            errors.put(failed);
          }
        }

        JSObject response = new JSObject();
        response.put("canceled", false);
        response.put("items", items);
        response.put("errors", errors);
        resolvePluginCall(call, response);
      } catch (Exception error) {
        rejectPluginCall(call, error.getMessage() == null ? "文件管理器导入失败" : error.getMessage(), error);
      }
    }, "FanHaoDocumentPickerRead").start();
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
  public void setReaderImmersive(PluginCall call) {
    Boolean requested = call.getBoolean("immersive", true);
    boolean immersive = requested == null || requested;
    if (getActivity() == null) {
      call.resolve(new JSObject());
      return;
    }

    getActivity().runOnUiThread(() -> {
      try {
        Window window = getActivity().getWindow();
        View decor = window.getDecorView();
        if (immersive) {
          decor.setSystemUiVisibility(
            View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
              | View.SYSTEM_UI_FLAG_FULLSCREEN
              | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
              | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
              | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
              | View.SYSTEM_UI_FLAG_LAYOUT_STABLE
          );
        } else {
          decor.setSystemUiVisibility(View.SYSTEM_UI_FLAG_LAYOUT_STABLE);
        }
        JSObject result = new JSObject();
        result.put("immersive", immersive);
        call.resolve(result);
      } catch (Exception error) {
        call.reject("切换沉浸式阅读失败", error);
      }
    });
  }

  @PluginMethod
  public void consumePendingTextFile(PluginCall call) {
    Intent intent = pendingTextIntent != null
      ? pendingTextIntent
      : getActivity() == null ? null : getActivity().getIntent();
    if (!looksLikeTextIntent(getContext(), intent)) {
      String message = unsupportedTextIntentMessage(intent);
      JSObject result = unavailableResult(message);
      if (!message.isEmpty()) {
        showToast(message);
        clearPendingIntent();
      }
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
    return looksLikeTextIntent(null, intent);
  }

  static boolean looksLikeTextIntent(Context context, Intent intent) {
    if (intent == null) return false;
    String action = intent.getAction();
    if (!Intent.ACTION_VIEW.equals(action) && !Intent.ACTION_SEND.equals(action)) return false;
    if (Intent.ACTION_SEND.equals(action)) {
      CharSequence text = intent.getCharSequenceExtra(Intent.EXTRA_TEXT);
      if (text != null && text.length() > 0) return true;
    }

    String type = intent.getType();
    if (type != null && type.toLowerCase(Locale.ROOT).startsWith("text/")) return true;
    Uri uri = textIntentUri(intent);
    if (isTextUri(uri)) return true;
    return context != null && isTextDisplayName(context.getContentResolver(), uri);
  }

  static boolean shouldHandleTextIntent(Context context, Intent intent) {
    return looksLikeTextIntent(context, intent) || !unsupportedTextIntentMessage(intent).isEmpty();
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

  private JSObject unavailableResult(String message) {
    JSObject result = new JSObject();
    result.put("available", false);
    if (message != null && !message.trim().isEmpty()) {
      result.put("message", message.trim());
    }
    return result;
  }

  private static String unsupportedTextIntentMessage(Intent intent) {
    if (intent == null) return "";
    String action = intent.getAction();
    if (!Intent.ACTION_VIEW.equals(action) && !Intent.ACTION_SEND.equals(action)) return "";
    String type = intent.getType();
    if (type == null || !"application/octet-stream".equalsIgnoreCase(type)) return "";
    return "这个文件不像 TXT 文本，FanHao 只会导入 .txt 文本。";
  }

  private void showToast(String message) {
    if (getActivity() == null || message == null || message.trim().isEmpty()) return;
    getActivity().runOnUiThread(() -> Toast.makeText(getActivity(), message.trim(), Toast.LENGTH_LONG).show());
  }

  private void resolvePluginCall(PluginCall call, JSObject result) {
    if (getActivity() == null) {
      call.resolve(result);
      return;
    }
    getActivity().runOnUiThread(() -> call.resolve(result));
  }

  private void rejectPluginCall(PluginCall call, String message, Exception error) {
    if (getActivity() == null) {
      call.reject(message, error);
      return;
    }
    getActivity().runOnUiThread(() -> call.reject(message, error));
  }

  private boolean hasExternalTextScanAccess() {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
      return Environment.isExternalStorageManager();
    }
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
      return getContext().checkSelfPermission(Manifest.permission.READ_EXTERNAL_STORAGE) == android.content.pm.PackageManager.PERMISSION_GRANTED;
    }
    return true;
  }

  private int clampInteger(Integer value, int fallback, int min, int max) {
    int number = value == null ? fallback : value;
    return Math.max(min, Math.min(max, number));
  }

  private List<ScannedTextCandidate> findTextFiles(int limit, int maxDepth) throws Exception {
    File root = Environment.getExternalStorageDirectory();
    if (root == null || !root.exists()) throw new IllegalArgumentException("没有找到手机存储目录");

    LinkedHashMap<String, ScannedTextCandidate> found = new LinkedHashMap<>();
    addScannedFiles(found, findTextFilesWithMediaStore(root, limit), limit);
    addScannedFiles(found, findTextFilesWithSystemFind(root, limit), limit);

    ArrayDeque<ScanNode> queue = new ArrayDeque<>();
    Set<String> visited = new HashSet<>();
    queue.add(new ScanNode(root, 0));

    while (!queue.isEmpty() && found.size() < limit) {
      ScanNode node = queue.removeFirst();
      File dir = node.file;
      if (dir == null || !dir.isDirectory() || !dir.canRead()) continue;
      String canonical = dir.getCanonicalPath();
      if (!visited.add(canonical) || shouldSkipScanDirectory(dir)) continue;

      File[] children = dir.listFiles();
      if (children == null) continue;
      for (File child : children) {
        if (child == null) continue;
        if (child.isDirectory()) {
          if (node.depth < maxDepth && !shouldSkipScanDirectory(child)) queue.addLast(new ScanNode(child, node.depth + 1));
          continue;
        }
        if (isScannableTextFile(child)) addScannedFile(found, ScannedTextCandidate.fromFile(child), limit);
        if (found.size() >= limit) break;
      }
    }

    ArrayList<ScannedTextCandidate> files = new ArrayList<>(found.values());
    sortScannedFiles(files);
    return files;
  }

  private List<ScannedTextCandidate> findTextFilesWithMediaStore(File root, int limit) {
    ArrayList<ScannedTextCandidate> found = new ArrayList<>();
    Uri uri = MediaStore.Files.getContentUri("external");
    String idColumn = MediaStore.Files.FileColumns._ID;
    String dataColumn = MediaStore.Files.FileColumns.DATA;
    String nameColumn = MediaStore.Files.FileColumns.DISPLAY_NAME;
    String sizeColumn = MediaStore.Files.FileColumns.SIZE;
    String modifiedColumn = MediaStore.Files.FileColumns.DATE_MODIFIED;
    String[] projection = new String[] { idColumn, dataColumn, nameColumn, sizeColumn, modifiedColumn };
    String selection = dataColumn + " LIKE ? OR " + dataColumn + " LIKE ? OR " + nameColumn + " LIKE ? OR " + nameColumn + " LIKE ?";
    String[] args = new String[] { "%.txt", "%.TXT", "%.txt", "%.TXT" };
    try (Cursor cursor = getContext().getContentResolver().query(uri, projection, selection, args, null)) {
      if (cursor == null) return found;
      int idIndex = cursor.getColumnIndex(idColumn);
      int dataIndex = cursor.getColumnIndex(dataColumn);
      int nameIndex = cursor.getColumnIndex(nameColumn);
      int sizeIndex = cursor.getColumnIndex(sizeColumn);
      int modifiedIndex = cursor.getColumnIndex(modifiedColumn);
      while (cursor.moveToNext() && found.size() < limit) {
        long id = idIndex >= 0 ? cursor.getLong(idIndex) : 0;
        String path = dataIndex >= 0 ? cursor.getString(dataIndex) : "";
        String fileName = nameIndex >= 0 ? cursor.getString(nameIndex) : safeNameFromPath(path);
        long sizeBytes = sizeIndex >= 0 ? cursor.getLong(sizeIndex) : fileLength(path);
        long modifiedSeconds = modifiedIndex >= 0 ? cursor.getLong(modifiedIndex) : 0;
        long lastModified = modifiedSeconds > 0 ? modifiedSeconds * 1000L : fileLastModified(path);
        String contentUri = id > 0 ? ContentUris.withAppendedId(uri, id).toString() : "";
        ScannedTextCandidate candidate = ScannedTextCandidate.fromMediaStore(path, contentUri, fileName, sizeBytes, lastModified);
        if (isScannableTextCandidate(candidate)) found.add(candidate);
      }
    } catch (Exception error) {
      Log.w(TAG, "MediaStore txt scan failed", error);
      found.clear();
    }
    sortScannedFiles(found);
    Log.i(TAG, "MediaStore txt scan found " + found.size() + " files");
    return found;
  }

  private List<ScannedTextCandidate> findTextFilesWithSystemFind(File root, int limit) {
    ArrayList<ScannedTextCandidate> found = new ArrayList<>();
    Process process = null;
    try {
      process = new ProcessBuilder("find", root.getAbsolutePath(), "-type", "f", "-iname", "*.txt")
        .redirectErrorStream(true)
        .start();
      try (BufferedReader reader = new BufferedReader(new InputStreamReader(process.getInputStream(), StandardCharsets.UTF_8))) {
        String line;
        while ((line = reader.readLine()) != null && found.size() < limit) {
          File file = safeScanCandidate(root, line);
          if (file != null && isScannableTextFile(file)) found.add(ScannedTextCandidate.fromFile(file));
        }
      }
      process.waitFor(90, TimeUnit.SECONDS);
    } catch (Exception ignored) {
      found.clear();
    } finally {
      if (process != null) process.destroy();
    }
    sortScannedFiles(found);
    Log.i(TAG, "system find txt scan found " + found.size() + " files");
    return found;
  }

  private void addScannedFiles(Map<String, ScannedTextCandidate> target, List<ScannedTextCandidate> files, int limit) {
    for (ScannedTextCandidate file : files) {
      addScannedFile(target, file, limit);
      if (target.size() >= limit) return;
    }
  }

  private void addScannedFile(Map<String, ScannedTextCandidate> target, ScannedTextCandidate file, int limit) {
    if (target.size() >= limit || file == null) return;
    if (!isScannableTextCandidate(file)) return;
    target.putIfAbsent(file.dedupeKey(), file);
  }

  private File safeScanCandidate(File root, String path) {
    try {
      if (path == null || path.trim().isEmpty()) return null;
      File rootFile = root.getCanonicalFile();
      File file = new File(path.trim()).getCanonicalFile();
      String rootPath = rootFile.getAbsolutePath();
      String filePath = file.getAbsolutePath();
      if (!filePath.equals(rootPath) && !filePath.startsWith(rootPath + File.separator)) return null;
      return file;
    } catch (Exception ignored) {
      return null;
    }
  }

  private void sortScannedFiles(List<ScannedTextCandidate> files) {
    files.sort(Comparator
      .comparingLong((ScannedTextCandidate item) -> item.lastModified).reversed()
      .thenComparing(Comparator.comparingLong((ScannedTextCandidate item) -> item.sizeBytes).reversed())
      .thenComparing(item -> item.fileName, String.CASE_INSENSITIVE_ORDER));
  }

  private boolean shouldSkipScanDirectory(File dir) {
    String path = dir.getAbsolutePath().replace('\\', '/').toLowerCase(Locale.ROOT);
    return path.contains("/.thumbnails/");
  }

  private boolean isScannableTextFile(File file) {
    if (file == null || !file.isFile() || !file.canRead()) return false;
    long length = file.length();
    if (length <= 0 || length > MAX_TEXT_BYTES) return false;
    return isTextFileName(file.getName());
  }

  private boolean isImportableTextCandidate(File file) {
    if (!isScannableTextFile(file)) return false;
    return isImportableTextCandidate(file.getAbsolutePath(), file.getName(), file.length());
  }

  private boolean isScannableTextCandidate(ScannedTextCandidate candidate) {
    if (candidate == null) return false;
    long length = candidate.sizeBytes;
    if (length <= 0 || length > MAX_TEXT_BYTES) return false;
    return isTextFileName(candidate.fileName) || isTextFileName(candidate.path);
  }

  private boolean isImportableTextCandidate(String rawPath, String rawName, long length) {
    if (length < MIN_IMPORT_TEXT_BYTES || length > MAX_IMPORT_TEXT_BYTES) return false;
    String path = String.valueOf(rawPath).replace('\\', '/').toLowerCase(Locale.ROOT);
    if (isUserDownloadTextPath(path)) return true;
    if (path.contains("/miui/debug_log/")
      || path.contains("/debug_log/")
      || path.contains("/log/")
      || path.contains("/logs/")
      || path.contains("/cache/")
      || path.contains("/android/obb/")) {
      return false;
    }
    String name = String.valueOf(rawName).toLowerCase(Locale.ROOT);
    return !name.equals("netstats.txt")
      && !name.equals("fw_version.txt")
      && !name.equals("ip_rule.txt")
      && !name.equals("ip_route.txt")
      && !name.equals("dumpsys.txt")
      && !name.equals("modemdump_cache.txt")
      && !name.equals("985_game.txt")
      && !name.startsWith("fanhao-")
      && !name.contains("logcat")
      && !name.contains("bugreport")
      && !name.contains("trace")
      && !name.contains("crash")
      && !name.contains("dump");
  }

  private String scanCandidateHint(File file) {
    if (file == null) return "";
    return scanCandidateHint(file.getAbsolutePath(), file.getName(), file.length());
  }

  private String scanCandidateHint(String rawPath, String rawName, long length) {
    if (isImportableTextCandidate(rawPath, rawName, length)) return "推荐";
    String path = String.valueOf(rawPath).replace('\\', '/').toLowerCase(Locale.ROOT);
    String name = String.valueOf(rawName).toLowerCase(Locale.ROOT);
    if (length < MIN_IMPORT_TEXT_BYTES) return "文件较小";
    if (length > MAX_IMPORT_TEXT_BYTES) return "文件较大";
    if (isUserDownloadTextPath(path)) return "应用下载";
    if (path.contains("/debug_log/")
      || path.contains("/log/")
      || path.contains("/logs/")
      || name.contains("log")
      || name.contains("trace")
      || name.contains("crash")
      || name.contains("dump")) return "可能是日志";
    if (name.equals("netstats.txt")
      || name.equals("fw_version.txt")
      || name.equals("ip_rule.txt")
      || name.equals("ip_route.txt")
      || name.equals("dumpsys.txt")
      || name.equals("modemdump_cache.txt")) return "系统文件";
    return "可选";
  }

  private boolean isUserDownloadTextPath(String path) {
    if (path == null) return false;
    String normalized = path.replace('\\', '/').toLowerCase(Locale.ROOT);
    return normalized.contains("/micromsg/download/")
      || normalized.contains("/download/")
      || normalized.contains("/downloads/")
      || normalized.contains("/received from pc/")
      || normalized.contains("/qqfile_recv/");
  }

  private File safeTextFileFromPath(String path) throws Exception {
    if (path == null || path.trim().isEmpty()) throw new IllegalArgumentException("缺少 TXT 路径");
    File root = Environment.getExternalStorageDirectory().getCanonicalFile();
    File file = new File(path).getCanonicalFile();
    String rootPath = root.getAbsolutePath();
    String filePath = file.getAbsolutePath();
    if (!filePath.equals(rootPath) && !filePath.startsWith(rootPath + File.separator)) {
      throw new IllegalArgumentException("只能读取手机存储目录内的 TXT");
    }
    if (!isScannableTextFile(file)) throw new IllegalArgumentException("这个文件不是可导入的 TXT");
    return file;
  }

  private byte[] readAllBytes(File file) throws Exception {
    try (InputStream input = new FileInputStream(file)) {
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
    String name = queryDisplayName(resolver, uri);
    if (name != null && !name.trim().isEmpty()) return name;

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
    pendingTextIntent = null;
    if (getActivity() == null) return;
    Intent clean = new Intent(Intent.ACTION_MAIN);
    clean.setPackage(getContext().getPackageName());
    getActivity().setIntent(clean);
  }

  private static boolean isTextUri(Uri uri) {
    String value = uri == null ? "" : uri.toString().toLowerCase(Locale.ROOT);
    return value.endsWith(".txt") || value.contains(".txt?");
  }

  private static boolean isTextDisplayName(ContentResolver resolver, Uri uri) {
    String name = queryDisplayName(resolver, uri);
    return isTextFileName(name);
  }

  private static boolean isTextFileName(String value) {
    return value != null && value.trim().toLowerCase(Locale.ROOT).endsWith(".txt");
  }

  private static boolean isContentUriString(String value) {
    return value != null && value.trim().toLowerCase(Locale.ROOT).startsWith("content://");
  }

  private static String safeNameFromPath(String path) {
    if (path == null || path.trim().isEmpty()) return "local-text.txt";
    String value = path.trim();
    int slash = Math.max(value.lastIndexOf('/'), value.lastIndexOf('\\'));
    value = slash >= 0 ? value.substring(slash + 1) : value;
    return value == null || value.trim().isEmpty() ? "local-text.txt" : value.trim();
  }

  private static long fileLength(String path) {
    try {
      if (path == null || path.trim().isEmpty()) return 0;
      return new File(path.trim()).length();
    } catch (Exception ignored) {
      return 0;
    }
  }

  private static long fileLastModified(String path) {
    try {
      if (path == null || path.trim().isEmpty()) return 0;
      return new File(path.trim()).lastModified();
    } catch (Exception ignored) {
      return 0;
    }
  }

  private static String queryDisplayName(ContentResolver resolver, Uri uri) {
    if (resolver == null || uri == null || !"content".equalsIgnoreCase(uri.getScheme())) return "";
    try (Cursor cursor = resolver.query(uri, new String[] { OpenableColumns.DISPLAY_NAME }, null, null, null)) {
      if (cursor != null && cursor.moveToFirst()) {
        String value = cursor.getString(0);
        if (value != null && !value.trim().isEmpty()) return value;
      }
    } catch (Exception ignored) {
    }
    return "";
  }

  private static Uri textIntentUri(Intent intent) {
    if (intent == null) return null;
    Uri uri = intent.getData();
    if (uri != null) return uri;
    Object stream = intent.getParcelableExtra(Intent.EXTRA_STREAM);
    return stream instanceof Uri ? (Uri) stream : null;
  }

  private static final class DecodedText {
    final String encoding;
    final String text;

    DecodedText(String encoding, String text) {
      this.encoding = encoding;
      this.text = text;
    }
  }

  private static final class ScannedTextCandidate {
    final String path;
    final String uri;
    final String fileName;
    final long sizeBytes;
    final long lastModified;

    ScannedTextCandidate(String path, String uri, String fileName, long sizeBytes, long lastModified) {
      this.path = path == null ? "" : path;
      this.uri = uri == null ? "" : uri;
      this.fileName = fileName == null || fileName.trim().isEmpty() ? safeNameFromPath(path) : fileName.trim();
      this.sizeBytes = Math.max(0, sizeBytes);
      this.lastModified = Math.max(0, lastModified);
    }

    static ScannedTextCandidate fromFile(File file) {
      return new ScannedTextCandidate(
        file == null ? "" : file.getAbsolutePath(),
        "",
        file == null ? "local-text.txt" : file.getName(),
        file == null ? 0 : file.length(),
        file == null ? 0 : file.lastModified()
      );
    }

    static ScannedTextCandidate fromMediaStore(String path, String uri, String fileName, long sizeBytes, long lastModified) {
      return new ScannedTextCandidate(path, uri, fileName, sizeBytes, lastModified);
    }

    String dedupeKey() {
      if (path != null && !path.trim().isEmpty()) return "path:" + path.trim();
      if (uri != null && !uri.trim().isEmpty()) return "uri:" + uri.trim();
      return "name:" + fileName + ":" + sizeBytes + ":" + lastModified;
    }
  }

  private static final class ScanNode {
    final File file;
    final int depth;

    ScanNode(File file, int depth) {
      this.file = file;
      this.depth = depth;
    }
  }
}
