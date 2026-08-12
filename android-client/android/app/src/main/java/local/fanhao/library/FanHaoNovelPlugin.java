package local.fanhao.library;

import android.app.Activity;
import android.content.ClipData;
import android.content.ContentResolver;
import android.content.Context;
import android.content.Intent;
import android.database.Cursor;
import android.net.Uri;
import android.provider.DocumentsContract;
import android.provider.OpenableColumns;
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

import java.io.InputStream;
import java.io.OutputStream;
import java.net.URLDecoder;
import java.nio.ByteBuffer;
import java.nio.charset.CharacterCodingException;
import java.nio.charset.Charset;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Locale;

@CapacitorPlugin(name = "FanHaoNovel")
public class FanHaoNovelPlugin extends Plugin {
  private static final String TAG = "FanHaoNovel";
  private static final long MAX_TEXT_BYTES = DocumentTreeScanner.MAX_TEXT_BYTES;
  private static final String[] DOCUMENT_PROJECTION = new String[] {
    DocumentsContract.Document.COLUMN_DOCUMENT_ID,
    DocumentsContract.Document.COLUMN_DISPLAY_NAME,
    DocumentsContract.Document.COLUMN_MIME_TYPE,
    DocumentsContract.Document.COLUMN_SIZE,
    DocumentsContract.Document.COLUMN_LAST_MODIFIED,
    DocumentsContract.Document.COLUMN_FLAGS
  };
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
  public void openTextDirectoryPicker(PluginCall call) {
    if (getActivity() == null) {
      call.reject("无法打开系统目录选择器");
      return;
    }

    Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT_TREE);
    intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_PREFIX_URI_PERMISSION);
    try {
      startActivityForResult(call, intent, "textDirectoryPickerResult");
    } catch (Exception error) {
      call.reject("无法打开系统目录选择器", error);
    }
  }

  @ActivityCallback
  private void textDirectoryPickerResult(PluginCall call, ActivityResult result) {
    if (call == null) return;
    Uri treeUri = result.getData() == null ? null : result.getData().getData();
    if (DocumentTreeScanner.isPickerCanceled(result.getResultCode() == Activity.RESULT_OK, treeUri != null)) {
      call.resolve(directoryScanResponse(true, null));
      return;
    }
    if (!isContentUri(treeUri)) {
      call.resolve(directoryRootFailureResponse("ROOT_INVALID"));
      return;
    }

    DocumentTreeScanner.Options options = new DocumentTreeScanner.Options(
      call.getInt("maxFiles"),
      call.getInt("maxDepth"),
      call.getInt("maxNodes")
    );
    new Thread(() -> {
      try {
        DocumentTreeScanner.Result scan = DocumentTreeScanner.scan(documentTreeSource(treeUri), options);
        Log.i(
          TAG,
          "document tree scan completed: files=" + scan.files.size()
            + ", nodes=" + scan.nodesVisited
            + ", errors=" + scan.errors.size()
            + ", truncated=" + scan.truncated()
        );
        resolvePluginCall(call, directoryScanResponse(false, scan));
      } catch (Exception error) {
        rejectPluginCall(call, "目录扫描失败", error);
      }
    }, "FanHaoDocumentTreeScan").start();
  }

  @PluginMethod
  public void readScannedTextFile(PluginCall call) {
    String rawUri = call.getString("uri", "");
    if (!isContentUriString(rawUri)) {
      call.reject("只能读取系统文件选择器返回的 content URI");
      return;
    }
    new Thread(() -> {
      try {
        Uri contentUri = Uri.parse(rawUri);
        ContentResolver resolver = getContext().getContentResolver();
        DocumentMetadata metadata = queryDocumentMetadata(resolver, contentUri);
        if (metadata.virtual) throw new IllegalArgumentException("虚拟文档不能作为 TXT 导入");
        String fileName = displayName(resolver, contentUri);
        String mime = resolver.getType(contentUri);
        if (!isTextFileName(fileName) && (mime == null || !mime.toLowerCase(Locale.ROOT).startsWith("text/"))) {
          throw new IllegalArgumentException("这个文档不是 TXT 文件");
        }
        if (metadata.sizeKnown) BoundedTextReader.requireAllowedKnownSize(metadata.sizeBytes, MAX_TEXT_BYTES);
        byte[] bytes = readAllBytes(resolver, contentUri);
        DecodedText decoded = decodeText(bytes);
        resolvePluginCall(call, textResult(fileName, mime, decoded.encoding, decoded.text, bytes.length, contentUri.toString()));
      } catch (Exception error) {
        rejectPluginCall(call, error.getMessage() == null ? "读取 TXT 失败" : error.getMessage(), error);
      }
    }, "FanHaoTextRead").start();
  }

  @PluginMethod
  public void exportTextFile(PluginCall call) {
    if (getActivity() == null) {
      call.reject("无法打开系统保存窗口");
      return;
    }

    String text = call.getString("text", "");
    byte[] bytes = text.getBytes(StandardCharsets.UTF_8);
    if (bytes.length > MAX_TEXT_BYTES) {
      call.reject("文本文件太大，暂时只支持 80MB 以内");
      return;
    }

    String fileName = sanitizeFileName(call.getString("fileName", "本地小说.txt"));
    Intent intent = new Intent(Intent.ACTION_CREATE_DOCUMENT);
    intent.addCategory(Intent.CATEGORY_OPENABLE);
    intent.setType("text/plain");
    intent.putExtra(Intent.EXTRA_TITLE, fileName);
    intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION);
    try {
      startActivityForResult(call, intent, "exportTextFileResult");
    } catch (Exception error) {
      call.reject("无法打开系统保存窗口", error);
    }
  }

  @ActivityCallback
  private void exportTextFileResult(PluginCall call, ActivityResult result) {
    if (call == null) return;
    if (result.getResultCode() != Activity.RESULT_OK || result.getData() == null || result.getData().getData() == null) {
      JSObject canceled = new JSObject();
      canceled.put("saved", false);
      canceled.put("canceled", true);
      call.resolve(canceled);
      return;
    }

    Uri uri = result.getData().getData();
    String fileName = sanitizeFileName(call.getString("fileName", "本地小说.txt"));
    String text = call.getString("text", "");
    new Thread(() -> {
      try {
        byte[] bytes = text.getBytes(StandardCharsets.UTF_8);
        if (bytes.length > MAX_TEXT_BYTES) throw new IllegalArgumentException("文本文件太大，暂时只支持 80MB 以内");
        ContentResolver resolver = getContext().getContentResolver();
        try (OutputStream output = resolver.openOutputStream(uri, "wt")) {
          if (output == null) throw new IllegalArgumentException("无法写入这个文件位置");
          output.write(bytes);
          output.flush();
        }
        JSObject response = new JSObject();
        response.put("saved", true);
        response.put("canceled", false);
        response.put("fileName", fileName);
        response.put("sizeBytes", bytes.length);
        response.put("uri", uri.toString());
        resolvePluginCall(call, response);
      } catch (Exception error) {
        rejectPluginCall(call, error.getMessage() == null ? "保存 TXT 失败" : error.getMessage(), error);
      }
    }, "FanHaoTextExport").start();
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
    intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
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
        for (Uri uri : uris) {
          try {
            if (!isContentUri(uri)) throw new IllegalArgumentException("只支持 content URI 文档");
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

    Uri uri = textIntentUri(intent);
    if (!isContentUri(uri)) return false;
    String type = intent.getType();
    if (type != null && type.toLowerCase(Locale.ROOT).startsWith("text/")) return true;
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
    if (!isContentUri(uri)) throw new IllegalArgumentException("只能读取 content URI 文本文件");

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
    Uri uri = textIntentUri(intent);
    if (uri != null && !isContentUri(uri)) return "FanHao 只读取系统提供的 content URI 文本。";
    String type = intent.getType();
    if (type == null || !"application/octet-stream".equalsIgnoreCase(type)) return "";
    return "这个文件不像 TXT 文本，FanHao 只会导入 .txt 文本。";
  }

  private void showToast(String message) {
    if (getActivity() == null || message == null || message.trim().isEmpty()) return;
    getActivity().runOnUiThread(() -> Toast.makeText(getActivity(), message.trim(), Toast.LENGTH_LONG).show());
  }

  private void resolvePluginCall(PluginCall call, JSObject result) {
    if (call == null || call.isReleased()) return;
    getBridge().executeOnMainThread(() -> {
      if (!call.isReleased()) call.resolve(result);
    });
  }

  private void rejectPluginCall(PluginCall call, String message, Exception error) {
    if (call == null || call.isReleased()) return;
    getBridge().executeOnMainThread(() -> {
      if (!call.isReleased()) call.reject(message, error);
    });
  }

  private DocumentTreeScanner.Source documentTreeSource(Uri treeUri) {
    ContentResolver resolver = getContext().getContentResolver();
    String authority = treeUri.getAuthority() == null ? "" : treeUri.getAuthority();
    return new DocumentTreeScanner.Source() {
      @Override
      public DocumentTreeScanner.Node readRoot() throws Exception {
        String rootDocumentId = DocumentsContract.getTreeDocumentId(treeUri);
        Uri rootUri = DocumentsContract.buildDocumentUriUsingTree(treeUri, rootDocumentId);
        try (Cursor cursor = resolver.query(rootUri, DOCUMENT_PROJECTION, null, null, null)) {
          if (cursor == null || !cursor.moveToFirst()) {
            throw new IllegalArgumentException("所选目录无法读取");
          }
          return documentNodeFromCursor(cursor, authority, treeUri);
        }
      }

      @Override
      public DocumentTreeScanner.ChildrenPage readChildren(
        DocumentTreeScanner.Node directory,
        int maximumChildren
      ) throws Exception {
        Uri childrenUri = DocumentsContract.buildChildDocumentsUriUsingTree(treeUri, directory.documentId);
        ArrayList<DocumentTreeScanner.Node> children = new ArrayList<>();
        boolean truncated = false;
        try (Cursor cursor = resolver.query(childrenUri, DOCUMENT_PROJECTION, null, null, null)) {
          if (cursor == null) throw new IllegalArgumentException("目录内容无法读取");
          while (cursor.moveToNext()) {
            if (children.size() >= maximumChildren) {
              truncated = true;
              break;
            }
            children.add(documentNodeFromCursor(cursor, authority, treeUri));
          }
        }
        return new DocumentTreeScanner.ChildrenPage(children, truncated);
      }
    };
  }

  private DocumentTreeScanner.Node documentNodeFromCursor(
    Cursor cursor,
    String authority,
    Uri treeUri
  ) {
    String documentId = cursorString(cursor, DocumentsContract.Document.COLUMN_DOCUMENT_ID);
    String displayName = cursorString(cursor, DocumentsContract.Document.COLUMN_DISPLAY_NAME);
    String mimeType = cursorString(cursor, DocumentsContract.Document.COLUMN_MIME_TYPE);
    boolean sizeKnown = !cursorNull(cursor, DocumentsContract.Document.COLUMN_SIZE);
    long sizeBytes = sizeKnown ? cursorLong(cursor, DocumentsContract.Document.COLUMN_SIZE) : -1L;
    long lastModified = cursorNull(cursor, DocumentsContract.Document.COLUMN_LAST_MODIFIED)
      ? 0L
      : cursorLong(cursor, DocumentsContract.Document.COLUMN_LAST_MODIFIED);
    long flags = cursorNull(cursor, DocumentsContract.Document.COLUMN_FLAGS)
      ? 0L
      : cursorLong(cursor, DocumentsContract.Document.COLUMN_FLAGS);
    boolean directory = DocumentsContract.Document.MIME_TYPE_DIR.equals(mimeType);
    boolean virtual = (flags & DocumentsContract.Document.FLAG_VIRTUAL_DOCUMENT) != 0L;
    String uri = documentId.isEmpty()
      ? ""
      : DocumentsContract.buildDocumentUriUsingTree(treeUri, documentId).toString();
    return new DocumentTreeScanner.Node(
      authority,
      documentId,
      uri,
      displayName,
      mimeType,
      sizeBytes,
      sizeKnown,
      lastModified,
      directory,
      virtual
    );
  }

  private JSObject directoryScanResponse(boolean canceled, DocumentTreeScanner.Result scan) {
    JSObject response = new JSObject();
    response.put("available", true);
    response.put("canceled", canceled);
    response.put("rootFailed", scan != null && scan.rootFailed);
    response.put("truncated", scan != null && scan.truncated());
    response.put("nodesVisited", scan == null ? 0 : scan.nodesVisited);
    response.put("duplicateNodes", scan == null ? 0 : scan.duplicateNodes);
    response.put("virtualNodesSkipped", scan == null ? 0 : scan.virtualNodes);
    response.put("invalidNodesSkipped", scan == null ? 0 : scan.invalidNodes);
    response.put("oversizedFilesSkipped", scan == null ? 0 : scan.oversizedFiles);

    JSArray items = new JSArray();
    if (scan != null) {
      for (DocumentTreeScanner.Node file : scan.files) {
        JSObject item = new JSObject();
        item.put("uri", file.uri);
        item.put("fileName", sanitizeFileName(file.displayName));
        item.put("sizeBytes", file.sizeKnown ? file.sizeBytes : -1L);
        item.put("sizeKnown", file.sizeKnown);
        item.put("lastModified", file.lastModified);
        item.put("modifiedAt", file.lastModified > 0L
          ? new java.text.SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSSZ", Locale.ROOT)
            .format(new java.util.Date(file.lastModified))
          : "");
        item.put("recommended", DocumentTreeScanner.isRecommended(file));
        item.put("hint", DocumentTreeScanner.hint(file));
        items.put(item);
      }
    }
    response.put("items", items);

    JSArray errors = new JSArray();
    if (scan != null) {
      for (DocumentTreeScanner.ScanError error : scan.errors) {
        JSObject item = new JSObject();
        item.put("code", error.code);
        item.put("directoryName", error.directoryName);
        errors.put(item);
      }
    }
    response.put("errors", errors);

    JSArray truncationReasons = new JSArray();
    if (scan != null) {
      for (String reason : scan.truncationReasons) truncationReasons.put(reason);
    }
    response.put("truncationReasons", truncationReasons);
    return response;
  }

  private JSObject directoryRootFailureResponse(String code) {
    DocumentTreeScanner.Result result = new DocumentTreeScanner.Result();
    result.rootFailed = true;
    result.errors.add(new DocumentTreeScanner.ScanError(code, "所选目录"));
    return directoryScanResponse(false, result);
  }

  private DocumentMetadata queryDocumentMetadata(ContentResolver resolver, Uri uri) throws Exception {
    try (Cursor cursor = resolver.query(
      uri,
      new String[] { OpenableColumns.SIZE, DocumentsContract.Document.COLUMN_FLAGS },
      null,
      null,
      null
    )) {
      if (cursor == null || !cursor.moveToFirst()) {
        throw new IllegalArgumentException("无法读取文档信息");
      }
      boolean sizeKnown = !cursorNull(cursor, OpenableColumns.SIZE);
      long sizeBytes = sizeKnown ? cursorLong(cursor, OpenableColumns.SIZE) : -1L;
      long flags = cursorNull(cursor, DocumentsContract.Document.COLUMN_FLAGS)
        ? 0L
        : cursorLong(cursor, DocumentsContract.Document.COLUMN_FLAGS);
      return new DocumentMetadata(
        sizeBytes,
        sizeKnown,
        (flags & DocumentsContract.Document.FLAG_VIRTUAL_DOCUMENT) != 0L
      );
    }
  }

  private String cursorString(Cursor cursor, String column) {
    int index = cursor.getColumnIndex(column);
    return index < 0 || cursor.isNull(index) ? "" : String.valueOf(cursor.getString(index)).trim();
  }

  private long cursorLong(Cursor cursor, String column) {
    int index = cursor.getColumnIndex(column);
    return index < 0 || cursor.isNull(index) ? 0L : cursor.getLong(index);
  }

  private boolean cursorNull(Cursor cursor, String column) {
    int index = cursor.getColumnIndex(column);
    return index < 0 || cursor.isNull(index);
  }

  private byte[] readAllBytes(ContentResolver resolver, Uri uri) throws Exception {
    try (InputStream input = resolver.openInputStream(uri)) {
      return BoundedTextReader.read(input, MAX_TEXT_BYTES);
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
    if (!isContentUri(uri)) return false;
    String value = uri == null ? "" : uri.toString().toLowerCase(Locale.ROOT);
    return value.endsWith(".txt") || value.contains(".txt?");
  }

  private static boolean isContentUri(Uri uri) {
    return uri != null
      && "content".equalsIgnoreCase(uri.getScheme())
      && uri.getAuthority() != null
      && !uri.getAuthority().trim().isEmpty();
  }

  private static boolean isTextDisplayName(ContentResolver resolver, Uri uri) {
    String name = queryDisplayName(resolver, uri);
    return isTextFileName(name);
  }

  private static boolean isTextFileName(String value) {
    return value != null && value.trim().toLowerCase(Locale.ROOT).endsWith(".txt");
  }

  private static boolean isContentUriString(String value) {
    try {
      return value != null && isContentUri(Uri.parse(value.trim()));
    } catch (Exception ignored) {
      return false;
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

  private static final class DocumentMetadata {
    final long sizeBytes;
    final boolean sizeKnown;
    final boolean virtual;

    DocumentMetadata(long sizeBytes, boolean sizeKnown, boolean virtual) {
      this.sizeBytes = sizeBytes;
      this.sizeKnown = sizeKnown;
      this.virtual = virtual;
    }
  }
}
