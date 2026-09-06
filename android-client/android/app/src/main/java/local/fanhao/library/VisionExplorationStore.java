package local.fanhao.library;

import android.content.Context;
import android.system.ErrnoException;
import android.system.Os;

import org.json.JSONArray;
import org.json.JSONObject;
import org.json.JSONTokener;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.text.SimpleDateFormat;
import java.util.Arrays;
import java.util.ArrayList;
import java.util.Date;
import java.util.HashSet;
import java.util.Locale;
import java.util.Set;
import java.util.UUID;

final class VisionExplorationStore {
  private static final String ROOT_NAME = "vision-exploration";
  private static final String MANIFEST_NAME = "manifest.json";
  private static final int MAX_MANIFEST_BYTES = 65536;
  private static final String[] STANDARD_PHOTOS = {
    "id-front.jpg", "id-back.jpg", "bank-card-front.jpg", "face-verification.jpg"
  };

  private VisionExplorationStore() {}

  static File createSession(Context context, String kind) throws Exception {
    if (!validKind(kind)) throw new IllegalArgumentException("探索类型无效");
    File root = safeRoot(context);
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

  static synchronized JSONObject completeSession(File session, String kind, String challenge, String... fileNames) throws Exception {
    JSONObject manifest = validateManifest(session, readJson(new File(session, MANIFEST_NAME)));
    if (!"capturing".equals(manifest.getString("status"))) throw new IllegalStateException("探索记录已经完成");
    if (!validKind(kind) || !kind.equals(manifest.getString("kind"))) throw new IllegalStateException("探索类型与记录不一致");
    if ("face-verification".equals(kind)
      && (!validChallenge(challenge) || !challenge.equals(manifest.optString("challenge")))) {
      throw new IllegalStateException("人脸动作未保存或不一致");
    }
    manifest.put("schemaVersion", 1);
    manifest.put("sessionId", session.getName());
    manifest.put("kind", normalizedKind(kind));
    manifest.put("demoOnly", true);
    manifest.put("status", "complete");
    manifest.put("completedAt", System.currentTimeMillis());
    manifest.put("challenge", challenge == null ? "" : challenge);
    JSONArray files = new JSONArray();
    for (String name : fileNames) {
      File file = resolveSessionFile(session, name);
      JSONObject item = new JSONObject();
      item.put("name", name);
      item.put("bytes", file.length());
      files.put(item);
    }
    manifest.put("files", files);
    manifest.remove("nextStep");
    validateManifest(session, manifest);
    writeJson(new File(session, MANIFEST_NAME), manifest);
    return manifest;
  }

  static JSONArray listSessions(Context context) throws Exception {
    JSONArray result = new JSONArray();
    File root = safeRoot(context);
    if (!root.exists()) return result;
    if (!root.isDirectory()) throw new IOException("探索存档根目录异常");
    File[] directories = root.listFiles();
    if (directories == null) throw new IOException("探索存档列表无法读取");
    ArrayList<File> safeDirectories = new ArrayList<>();
    for (File directory : directories) {
      if (!validSessionId(directory.getName())) continue;
      try {
        safeDirectories.add(resolveSessionDirectory(context, directory.getName()));
      } catch (Exception unsafeDirectory) { continue; }
    }
    safeDirectories.sort((left, right) -> Long.compare(right.lastModified(), left.lastModified()));
    for (File directory : safeDirectories) {
      JSONObject summary = new JSONObject();
      try {
        summary.put("sessionId", directory.getName());
        summary.put("kind", "unknown");
        summary.put("createdAt", directory.lastModified());
        summary.put("completedAt", 0L);
        summary.put("files", new JSONArray());
        summary.put("status", "unavailable");
        summary.put("canReview", false);
        summary.put("canResume", false);
        summary.put("bytes", directoryBytes(directory));
        try {
          JSONObject manifest = readJson(new File(directory, MANIFEST_NAME));
          if (validKind(manifest.optString("kind"))) summary.put("kind", manifest.getString("kind"));
          if (manifest.opt("createdAt") instanceof Number) summary.put("createdAt", Math.max(0L, manifest.optLong("createdAt")));
          if (manifest.opt("completedAt") instanceof Number) summary.put("completedAt", Math.max(0L, manifest.optLong("completedAt")));
          JSONObject validated = validateManifest(directory, manifest);
          boolean completed = "complete".equals(validated.getString("status"));
          summary.put("status", completed ? "complete" : "capturing");
          summary.put("canReview", completed);
          summary.put("canResume", !completed);
          summary.put("files", validated.getJSONArray("files"));
          summary.put("challenge", validated.optString("challenge", ""));
          if (!completed) summary.put("nextStep", validated.getString("nextStep"));
          summary.put("issue", "");
        } catch (Exception invalidRecord) {
          summary.put("issue", recordIssue(invalidRecord));
        }
        result.put(summary);
      } catch (Exception invalidSummary) {
        // JSONObject writes above use only known serializable values.
      }
    }
    return result;
  }

  static JSONObject getCompletedSession(Context context, String sessionId) throws Exception {
    File directory = resolveSessionDirectory(context, sessionId);
    JSONObject manifest = validateManifest(directory, readJson(new File(directory, MANIFEST_NAME)));
    if (!"complete".equals(manifest.optString("status"))) {
      throw new IllegalStateException("探索记录尚未完成");
    }
    return manifest;
  }

  static JSONObject getRecoverableSession(Context context, String sessionId) throws Exception {
    File directory = resolveSessionDirectory(context, sessionId);
    JSONObject manifest = validateManifest(directory, readJson(new File(directory, MANIFEST_NAME)));
    if (!"capturing".equals(manifest.getString("status"))) throw new IllegalStateException("探索记录已完成，无需继续");
    return manifest;
  }

  static synchronized void saveChallenge(File session, String challenge) throws Exception {
    if (!validChallenge(challenge)) throw new IllegalArgumentException("人脸动作无效");
    JSONObject manifest = validateManifest(session, readJson(new File(session, MANIFEST_NAME)));
    if (!"capturing".equals(manifest.getString("status")) || !"face-verification".equals(manifest.getString("kind"))) {
      throw new IllegalStateException("此记录不能保存人脸动作");
    }
    if (new File(session, "face-verification.jpg").exists() && !challenge.equals(manifest.optString("challenge"))) {
      throw new IllegalStateException("已有照片的人脸动作不能更改");
    }
    manifest.put("challenge", challenge);
    manifest.remove("nextStep");
    writeJson(new File(session, MANIFEST_NAME), manifest);
  }

  static File resolveSessionDirectory(Context context, String sessionId) throws Exception {
    if (!validSessionId(sessionId)) throw new SecurityException("探索记录标识无效");
    File root = safeRoot(context);
    File target = directFile(root, sessionId);
    if (!target.isDirectory()) throw new IllegalStateException("探索记录不存在");
    return target;
  }

  static File resolveSessionFile(File session, String fileName) throws Exception {
    if (fileName == null || !fileName.matches("[a-z0-9-]+\\.jpg")) {
      throw new SecurityException("探索照片名称无效");
    }
    File target = directFile(session, fileName);
    if (!target.isFile() || target.length() <= 0L) throw new IllegalStateException("探索照片缺失或为空");
    return target;
  }

  static boolean deleteSession(Context context, String sessionId) throws Exception {
    if (!validSessionId(sessionId)) return false;
    File root = safeRoot(context);
    File target = directFile(root, sessionId);
    if (!target.isDirectory()) return false;
    deleteTree(root, target);
    return !target.exists();
  }

  static void discardSession(Context context, File session) {
    if (session == null) return;
    try {
      File root = safeRoot(context);
      File target = directFile(root, session.getName());
      if (validSessionId(session.getName()) && target.equals(session.getCanonicalFile())) deleteTree(root, target);
    } catch (Exception ignored) {}
  }

  private static String normalizedKind(String kind) {
    if (validKind(kind)) return kind;
    return "unknown";
  }

  private static boolean validSessionId(String sessionId) {
    return sessionId != null && sessionId.matches("[0-9]{8}-[0-9]{6}-[a-f0-9]{8}");
  }

  private static File safeRoot(Context context) throws IOException {
    return directFile(context.getFilesDir().getCanonicalFile(), ROOT_NAME);
  }

  private static File directFile(File directory, String name) throws IOException {
    File parent = directory.getCanonicalFile();
    File target = new File(parent, name).getAbsoluteFile();
    File canonical = target.getCanonicalFile();
    if (!canonical.equals(target) || !parent.equals(canonical.getParentFile())) {
      throw new SecurityException("探索记录包含不安全路径");
    }
    return target;
  }

  private static boolean validKind(String kind) {
    return "id-card".equals(kind) || "bank-card".equals(kind) || "face-verification".equals(kind);
  }

  private static boolean validChallenge(String challenge) {
    return "缓慢转头".equals(challenge) || "微笑一下".equals(challenge);
  }

  private static String[] expectedPhotos(String kind) {
    if ("id-card".equals(kind)) return new String[] { "id-front.jpg", "id-back.jpg" };
    return new String[] { "bank-card".equals(kind) ? "bank-card-front.jpg" : "face-verification.jpg" };
  }

  private static JSONObject validateManifest(File session, JSONObject manifest) throws Exception {
    if (!validSessionId(session.getName()) || !session.getCanonicalFile().equals(session.getAbsoluteFile())) {
      throw new SecurityException("探索记录标识或目录无效");
    }
    Object schema = manifest.opt("schemaVersion");
    if (!(schema instanceof Number) || ((Number) schema).doubleValue() != 1d) throw new IllegalStateException("探索清单版本无效");
    if (!session.getName().equals(manifest.optString("sessionId"))) throw new IllegalStateException("探索记录标识不一致");
    String kind = manifest.optString("kind");
    if (!validKind(kind)) throw new IllegalStateException("探索类型无效");
    String status = manifest.optString("status");
    if (!"complete".equals(status) && !"capturing".equals(status)) throw new IllegalStateException("探索记录状态无效");
    File[] children = session.listFiles();
    if (children == null) throw new IOException("探索记录无法读取");
    for (File child : children) {
      File safe = directFile(session, child.getName());
      if (safe.isDirectory()) throw new IllegalStateException("探索记录包含异常子目录");
    }
    Set<String> expected = new HashSet<>(Arrays.asList(expectedPhotos(kind)));
    Set<String> present = new HashSet<>();
    JSONArray actualFiles = new JSONArray();
    for (String name : STANDARD_PHOTOS) {
      File file = directFile(session, name);
      if (!file.exists()) continue;
      if (!expected.contains(name)) throw new IllegalStateException("探索照片与类型不一致");
      resolveSessionFile(session, name);
      present.add(name);
      actualFiles.put(new JSONObject().put("name", name).put("bytes", file.length()));
    }
    if ("id-card".equals(kind) && present.contains("id-back.jpg") && !present.contains("id-front.jpg")) {
      throw new IllegalStateException("身份证人像面照片缺失");
    }
    Object challengeValue = manifest.opt("challenge");
    String challenge = challengeValue instanceof String ? (String) challengeValue : "";
    if ("face-verification".equals(kind)
      && ((!challenge.isEmpty() && !validChallenge(challenge))
        || (challengeValue != null && challengeValue != JSONObject.NULL && !(challengeValue instanceof String))
        || (!present.isEmpty() && !validChallenge(challenge)))) {
      throw new IllegalStateException("人脸动作缺失或无效");
    }
    JSONArray declared = manifest.optJSONArray("files");
    if (manifest.has("files") && declared == null) throw new IllegalStateException("探索照片清单无效");
    Set<String> declaredNames = new HashSet<>();
    if (declared != null) {
      for (int index = 0; index < declared.length(); index++) {
        JSONObject item = declared.optJSONObject(index);
        String name = item == null ? "" : item.optString("name");
        if (!expected.contains(name) || !declaredNames.add(name)) throw new IllegalStateException("探索照片清单不匹配");
        File file = resolveSessionFile(session, name);
        Object bytes = item.opt("bytes");
        if (!(bytes instanceof Number) || ((Number) bytes).doubleValue() != (double) file.length()) {
          throw new IllegalStateException("探索照片大小与清单不一致");
        }
      }
    }
    if ("complete".equals(status)) {
      if (!present.equals(expected) || !declaredNames.equals(expected)) throw new IllegalStateException("已完成记录缺少预期照片");
    } else manifest.put("nextStep", VisionCaptureLifecycle.resumeStep(kind, session));
    manifest.put("files", actualFiles);
    return manifest;
  }

  private static String recordIssue(Exception error) {
    if (error instanceof IllegalStateException || error instanceof SecurityException) {
      String message = error.getMessage();
      if (message != null && message.length() <= 48) return message;
    }
    return "探索清单已损坏或无法读取";
  }

  private static synchronized JSONObject readJson(File file) throws Exception {
    directFile(file.getParentFile(), file.getName());
    // Older builds could stop after deleting the manifest but before renaming its
    // fully-written temporary. Recover only a missing manifest; an existing one
    // is the committed state and must never be shadowed by an unfinished update.
    if (!file.exists()) {
      File temporary = new File(file.getParentFile(), "." + file.getName() + ".tmp");
      directFile(temporary.getParentFile(), temporary.getName());
      if (temporary.isFile()) {
        JSONObject recovered = readJsonContents(temporary);
        replaceJson(temporary, file);
        return recovered;
      }
    }
    return readJsonContents(file);
  }

  private static JSONObject readJsonContents(File file) throws Exception {
    if (!file.isFile() || file.length() > MAX_MANIFEST_BYTES) throw new IOException("探索清单缺失或过大");
    try (FileInputStream input = new FileInputStream(file); ByteArrayOutputStream output = new ByteArrayOutputStream()) {
      byte[] buffer = new byte[8192];
      int read;
      while ((read = input.read(buffer)) >= 0) {
        if (output.size() + read > MAX_MANIFEST_BYTES) throw new IOException("探索清单过大");
        output.write(buffer, 0, read);
      }
      JSONTokener tokens = new JSONTokener(output.toString(StandardCharsets.UTF_8.name()));
      JSONObject document = new JSONObject(tokens);
      if (tokens.nextClean() != 0) throw new IOException("探索清单包含多余数据");
      return document;
    }
  }

  private static synchronized void writeJson(File file, JSONObject value) throws Exception {
    directFile(file.getParentFile(), file.getName());
    File temporary = new File(file.getParentFile(), "." + file.getName() + ".tmp");
    directFile(temporary.getParentFile(), temporary.getName());
    try (FileOutputStream output = new FileOutputStream(temporary)) {
      output.write(value.toString(2).getBytes(StandardCharsets.UTF_8));
      output.getFD().sync();
    }
    replaceJson(temporary, file);
    file.getParentFile().setLastModified(System.currentTimeMillis());
  }

  private static void replaceJson(File temporary, File file) throws IOException {
    try {
      // API 21+: same-directory rename atomically replaces the destination. Keep
      // the old complete manifest present until this operation succeeds.
      Os.rename(temporary.getAbsolutePath(), file.getAbsolutePath());
    } catch (ErrnoException error) {
      throw new IOException("无法提交探索存档", error);
    }
  }

  private static long directoryBytes(File directory) {
    try { return directoryBytes(directory.getCanonicalFile(), directory, new HashSet<>(), 0); }
    catch (Exception unreadable) { return 0L; }
  }

  private static long directoryBytes(File root, File directory, Set<String> visited, int depth) {
    if (depth > 32 || visited.size() >= 10000) return 0L;
    try {
      File canonical = directory.getCanonicalFile();
      if (!canonical.equals(directory.getAbsoluteFile()) || (!canonical.equals(root) && !isChild(root, canonical))
        || !visited.add(canonical.getPath())) return 0L;
    } catch (IOException unsafe) { return 0L; }
    long total = 0L;
    File[] children = directory.listFiles();
    if (children == null) return total;
    for (File child : children) {
      try {
        File canonical = child.getCanonicalFile();
        if (!canonical.equals(child.getAbsoluteFile()) || !isChild(root, canonical)) continue;
        long bytes = child.isDirectory() ? directoryBytes(root, child, visited, depth + 1) : child.isFile() ? child.length() : 0L;
        total = bytes > Long.MAX_VALUE - total ? Long.MAX_VALUE : total + bytes;
      } catch (IOException unsafe) { /* Never count paths that cannot be proved contained. */ }
    }
    return total;
  }

  private static boolean isChild(File root, File target) {
    return target.getPath().startsWith(root.getPath() + File.separator);
  }

  private static void deleteTree(File root, File target) throws Exception {
    if (!isChild(root, target.getAbsoluteFile())) throw new SecurityException("探索存档路径越界");
    File canonical = target.getCanonicalFile();
    if (!canonical.equals(target.getAbsoluteFile())) {
      if (!target.delete()) throw new IllegalStateException("无法删除探索目录链接");
      return;
    }
    if (!isChild(root, canonical)) throw new SecurityException("探索存档路径越界");
    File[] children = target.listFiles();
    if (children != null) {
      for (File child : children) {
        deleteTree(root, child);
      }
    }
    if (!target.delete()) throw new IllegalStateException("无法删除探索目录");
  }
}
