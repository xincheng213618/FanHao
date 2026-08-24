package local.fanhao.library;

import android.content.Context;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.nio.charset.StandardCharsets;
import java.text.SimpleDateFormat;
import java.util.Arrays;
import java.util.Date;
import java.util.Locale;
import java.util.UUID;

final class VisionExplorationStore {
  private static final String ROOT_NAME = "vision-exploration";
  private static final String MANIFEST_NAME = "manifest.json";

  private VisionExplorationStore() {}

  static File createSession(Context context, String kind) throws Exception {
    File root = root(context);
    if (!root.isDirectory() && !root.mkdirs()) {
      throw new IllegalStateException("无法创建探索存档目录");
    }
    String timestamp = new SimpleDateFormat("yyyyMMdd-HHmmss", Locale.US).format(new Date());
    String random = UUID.randomUUID().toString().replace("-", "").substring(0, 8);
    File session = new File(root, timestamp + "-" + random);
    if (!session.mkdir()) throw new IllegalStateException("无法创建本次探索目录");
    JSONObject pending = new JSONObject();
    pending.put("schemaVersion", 1);
    pending.put("sessionId", session.getName());
    pending.put("kind", normalizedKind(kind));
    pending.put("demoOnly", true);
    pending.put("status", "capturing");
    pending.put("createdAt", System.currentTimeMillis());
    writeJson(new File(session, MANIFEST_NAME), pending);
    return session;
  }

  static JSONObject completeSession(File session, String kind, String challenge, String... fileNames) throws Exception {
    JSONObject manifest = readJson(new File(session, MANIFEST_NAME));
    manifest.put("schemaVersion", 1);
    manifest.put("sessionId", session.getName());
    manifest.put("kind", normalizedKind(kind));
    manifest.put("demoOnly", true);
    manifest.put("status", "complete");
    manifest.put("completedAt", System.currentTimeMillis());
    manifest.put("challenge", challenge == null ? "" : challenge);
    JSONArray files = new JSONArray();
    for (String name : fileNames) {
      File file = new File(session, name);
      if (!file.isFile()) throw new IllegalStateException("探索照片缺失：" + name);
      JSONObject item = new JSONObject();
      item.put("name", name);
      item.put("bytes", file.length());
      files.put(item);
    }
    manifest.put("files", files);
    writeJson(new File(session, MANIFEST_NAME), manifest);
    return manifest;
  }

  static JSONArray listSessions(Context context) {
    JSONArray result = new JSONArray();
    File[] directories = root(context).listFiles(File::isDirectory);
    if (directories == null) return result;
    Arrays.sort(directories, (left, right) -> Long.compare(right.lastModified(), left.lastModified()));
    for (File directory : directories) {
      try {
        JSONObject manifest = readJson(new File(directory, MANIFEST_NAME));
        if (!"complete".equals(manifest.optString("status"))) continue;
        manifest.put("bytes", directoryBytes(directory));
        result.put(manifest);
      } catch (Exception ignored) {}
    }
    return result;
  }

  static JSONObject getCompletedSession(Context context, String sessionId) throws Exception {
    File directory = resolveSessionDirectory(context, sessionId);
    JSONObject manifest = readJson(new File(directory, MANIFEST_NAME));
    if (!"complete".equals(manifest.optString("status"))) {
      throw new IllegalStateException("探索记录尚未完成");
    }
    if (!directory.getName().equals(manifest.optString("sessionId"))) {
      throw new SecurityException("探索记录标识不一致");
    }
    JSONArray files = manifest.optJSONArray("files");
    if (files == null || files.length() == 0) throw new IllegalStateException("探索记录没有照片");
    for (int index = 0; index < files.length(); index++) {
      JSONObject item = files.optJSONObject(index);
      String name = item == null ? "" : item.optString("name");
      resolveSessionFile(directory, name);
    }
    return manifest;
  }

  static File resolveSessionDirectory(Context context, String sessionId) throws Exception {
    if (!validSessionId(sessionId)) throw new SecurityException("探索记录标识无效");
    File root = root(context).getCanonicalFile();
    File target = new File(root, sessionId).getCanonicalFile();
    if (!isChild(root, target) || !target.isDirectory()) throw new IllegalStateException("探索记录不存在");
    return target;
  }

  static File resolveSessionFile(File session, String fileName) throws Exception {
    if (fileName == null || !fileName.matches("[a-z0-9-]+\\.jpg")) {
      throw new SecurityException("探索照片名称无效");
    }
    File root = session.getCanonicalFile();
    File target = new File(root, fileName).getCanonicalFile();
    if (!isChild(root, target) || !target.isFile()) throw new IllegalStateException("探索照片不存在");
    return target;
  }

  static boolean deleteSession(Context context, String sessionId) throws Exception {
    if (!validSessionId(sessionId)) return false;
    File root = root(context).getCanonicalFile();
    File target = new File(root, sessionId).getCanonicalFile();
    if (!isChild(root, target) || !target.isDirectory()) return false;
    deleteTree(root, target);
    return !target.exists();
  }

  static void discardSession(Context context, File session) {
    if (session == null) return;
    try {
      File root = root(context).getCanonicalFile();
      File target = session.getCanonicalFile();
      if (isChild(root, target)) deleteTree(root, target);
    } catch (Exception ignored) {}
  }

  private static String normalizedKind(String kind) {
    if ("id-card".equals(kind) || "bank-card".equals(kind) || "face-verification".equals(kind)) return kind;
    return "unknown";
  }

  private static boolean validSessionId(String sessionId) {
    return sessionId != null && sessionId.matches("[0-9]{8}-[0-9]{6}-[a-f0-9]{8}");
  }

  private static File root(Context context) {
    return new File(context.getFilesDir(), ROOT_NAME);
  }

  private static JSONObject readJson(File file) throws Exception {
    try (FileInputStream input = new FileInputStream(file); ByteArrayOutputStream output = new ByteArrayOutputStream()) {
      byte[] buffer = new byte[8192];
      int read;
      while ((read = input.read(buffer)) >= 0) output.write(buffer, 0, read);
      return new JSONObject(output.toString(StandardCharsets.UTF_8.name()));
    }
  }

  private static void writeJson(File file, JSONObject value) throws Exception {
    File temporary = new File(file.getParentFile(), "." + file.getName() + ".tmp");
    try (FileOutputStream output = new FileOutputStream(temporary)) {
      output.write(value.toString(2).getBytes(StandardCharsets.UTF_8));
      output.getFD().sync();
    }
    if (file.exists() && !file.delete()) throw new IllegalStateException("无法更新探索存档");
    if (!temporary.renameTo(file)) throw new IllegalStateException("无法提交探索存档");
    file.getParentFile().setLastModified(System.currentTimeMillis());
  }

  private static long directoryBytes(File directory) {
    long total = 0L;
    File[] children = directory.listFiles();
    if (children == null) return total;
    for (File child : children) total += child.isDirectory() ? directoryBytes(child) : child.length();
    return total;
  }

  private static boolean isChild(File root, File target) {
    return target.getPath().startsWith(root.getPath() + File.separator);
  }

  private static void deleteTree(File root, File target) throws Exception {
    File canonical = target.getCanonicalFile();
    if (!isChild(root, canonical)) throw new SecurityException("探索存档路径越界");
    File[] children = canonical.listFiles();
    if (children != null) {
      for (File child : children) {
        File childCanonical = child.getCanonicalFile();
        if (child.isDirectory()) deleteTree(root, childCanonical);
        else if (isChild(root, childCanonical) && !childCanonical.delete()) throw new IllegalStateException("无法删除探索文件");
      }
    }
    if (!canonical.delete()) throw new IllegalStateException("无法删除探索目录");
  }
}
