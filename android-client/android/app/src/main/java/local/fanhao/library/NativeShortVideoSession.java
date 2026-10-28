package local.fanhao.library;

import org.json.JSONObject;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.*;

/** Private task-scoped authority. Neither a launcher Intent nor a scope hash is a session. */
final class NativeShortVideoSession {
  static final int VERSION = 1, MAX_BYTES = 2 * 1024 * 1024, MAX_TASKS = 8;
  static final long MAX_AGE_MS = 7L * 24L * 60L * 60L * 1000L;
  private static final Object LOCK = new Object();
  private final File directory;
  static final class Obsolete extends IOException { Obsolete(String message) { super(message); } }

  static final class Record {
    final int taskId, attempts;
    final String nonce, scope, bootstrap, key, phase, owner, claim;
    final long createdAt, updatedAt, sequence;
    Record(int taskId, String nonce, String scope, String bootstrap, String key, String phase,
        String owner, String claim, int attempts, long createdAt, long updatedAt, long sequence) {
      this.taskId = taskId; this.nonce = nonce; this.scope = scope; this.bootstrap = bootstrap;
      this.key = key; this.phase = phase; this.owner = owner; this.claim = claim; this.attempts = attempts;
      this.createdAt = createdAt; this.updatedAt = updatedAt; this.sequence = sequence;
    }
    Record change(String key, String phase, String owner, String claim, int attempts, long now, long sequence) {
      return new Record(taskId, nonce, scope, bootstrap, key, phase, owner, claim, attempts, createdAt, now, sequence);
    }
  }

  NativeShortVideoSession(File directory) { this.directory = directory; }
  static String token() { return UUID.randomUUID().toString().replace("-", ""); }
  private File file(int task) throws IOException {
    if (task < 0) throw new IOException("invalid task");
    return new File(directory, "task-" + task + ".session");
  }

  Record begin(int task, String scope, String bootstrap, long now) throws IOException {
    synchronized (LOCK) {
      if (scope == null || !scope.matches("[a-f0-9]{64}") || bootstrap == null || bootstrap.length() > MAX_BYTES / 2) throw new IOException("invalid session bootstrap");
      Record record = new Record(task, token(), scope, bootstrap, "", "opening", "", "", 0, now, now, 0L);
      File[] existing = directory.listFiles((parent, name) -> name.matches("task-[0-9]+\\.session(?:\\.bak|\\.new)?"));
      Set<String> tasks = new HashSet<>();
      if (existing != null) for (File entry : existing) tasks.add(entry.getName().replaceFirst("\\.(?:bak|new)$", ""));
      if (tasks.size() > MAX_TASKS) throw new IOException("session storage needs cleanup");
      write(record);
      try { prune(task, now); }
      catch (IOException error) { revoke(task, record.nonce); throw error; }
      return record;
    }
  }

  Record read(int task, String nonce, long now) throws IOException {
    synchronized (LOCK) {
      Record record = readCurrent(task, now);
      if (nonce == null || !nonce.matches("[a-f0-9]{32}") || !nonce.equals(record.nonce)) throw new Obsolete("obsolete session");
      return record;
    }
  }

  Record attach(int task, String nonce, String claim, boolean systemRecreation, String owner, long now) throws IOException {
    synchronized (LOCK) {
      Record record = read(task, nonce, now);
      if ("closed".equals(record.phase) || !owner.matches("[a-f0-9]{32}")) throw new Obsolete("closed session");
      if (!systemRecreation && !("opening".equals(record.phase) && claim.isEmpty())
        && !("claimed".equals(record.phase) && !claim.isEmpty() && claim.equals(record.claim))) throw new Obsolete("unowned native launch");
      if (!claim.isEmpty() && !claim.equals(record.claim)) throw new Obsolete("obsolete recovery claim");
      Record attached = record.change(record.key, "active", owner, record.claim, record.attempts, now, record.sequence);
      write(attached); return attached;
    }
  }

  boolean publish(int task, String nonce, String owner, String scope, String key, long now) throws IOException {
    synchronized (LOCK) {
      Record record = read(task, nonce, now);
      if (!owns(record, owner) || !record.scope.equals(scope) || key == null || !key.matches("[a-f0-9]{32}")) return false;
      write(record.change(key, "parked", owner, record.claim, key.equals(record.key) ? record.attempts : 0, now, record.sequence + 1L));
      return true;
    }
  }

  boolean resume(int task, String nonce, String owner, long now) throws IOException {
    synchronized (LOCK) {
      Record record = read(task, nonce, now); if (!owns(record, owner)) return false;
      if ("active".equals(record.phase)) return true;
      write(record.change(record.key, "active", owner, record.claim, record.attempts, now, record.sequence)); return true;
    }
  }

  boolean discardCheckpoint(int task, String nonce, String owner, long now) throws IOException {
    synchronized (LOCK) {
      Record record = read(task, nonce, now); if (!owns(record, owner)) return false;
      write(record.change("", "active", owner, record.claim, 1, now, record.sequence + 1L)); return true;
    }
  }

  Record claim(int task, String nonce, long expectedSequence, long now) throws IOException {
    synchronized (LOCK) {
      Record record = read(task, nonce, now);
      if (!"parked".equals(record.phase) || record.key.isEmpty() || record.sequence != expectedSequence || record.attempts >= 1) return null;
      Record claimed = record.change(record.key, "claimed", "", token(), record.attempts + 1, now, record.sequence);
      write(claimed); return claimed;
    }
  }

  boolean close(int task, String nonce, String owner, long now) throws IOException {
    synchronized (LOCK) {
      Record record = read(task, nonce, now);
      if (!owner.isEmpty() && !owns(record, owner)) return false;
      write(record.change("", "closed", record.owner, record.claim, record.attempts, now, record.sequence)); return true;
    }
  }

  boolean revoke(int task, String nonce) {
    return revoke(task, nonce, "");
  }
  boolean revoke(int task, String nonce, String owner) {
    synchronized (LOCK) {
      try {
        Record record = readCurrent(task, System.currentTimeMillis(), false);
        if (!nonce.equals(record.nonce) || (!owner.isEmpty() && !owner.equals(record.owner))) return false;
        boolean removed = true;
        for (String suffix : new String[] {"", ".bak", ".new"}) { File target = new File(file(task).getPath() + suffix); if (target.exists() && !target.delete()) removed = false; }
        return removed;
      } catch (Exception unavailable) { return false; }
    }
  }

  boolean consumeResult(int task, String nonce, String owner, String claim, long now) throws IOException {
    synchronized (LOCK) {
      Record record = read(task, nonce, now);
      if (!"closed".equals(record.phase) || owner.isEmpty() || !owner.equals(record.owner) || !claim.equals(record.claim)) return false;
      write(record.change("", "closed", "", record.claim, record.attempts, now, record.sequence)); return true;
    }
  }

  private boolean owns(Record record, String owner) {
    return !"closed".equals(record.phase) && !owner.isEmpty() && owner.equals(record.owner);
  }

  private Record readCurrent(int task, long now) throws IOException {
    return readCurrent(task, now, true);
  }
  private Record readCurrent(int task, long now, boolean checkAge) throws IOException {
    File base = file(task), backup = new File(base.getPath() + ".bak");
    if (backup.exists()) {
      if (base.exists() && !base.delete()) throw new IOException("cannot recover session transaction");
      if (!backup.renameTo(base)) throw new IOException("cannot recover session backup");
    }
    if (!base.isFile() || base.length() < 2 || base.length() > MAX_BYTES) throw new IOException("session missing or oversized");
    try {
      byte[] bytes;
      try (FileInputStream input = new FileInputStream(base); ByteArrayOutputStream out = new ByteArrayOutputStream()) {
        byte[] buffer = new byte[8192]; int count;
        while ((count = input.read(buffer)) != -1) { if (out.size() + count > MAX_BYTES) throw new IOException("session grew beyond budget"); out.write(buffer, 0, count); }
        bytes = out.toByteArray();
      }
      JSONObject envelope = new JSONObject(new String(bytes, StandardCharsets.UTF_8));
      String body = envelope.getString("body");
      if (!digest(body).equals(envelope.getString("sha256"))) throw new IOException("session checksum mismatch");
      JSONObject row = new JSONObject(body);
      long created = row.getLong("created"), updated = row.getLong("updated");
      String nonce = row.getString("nonce"), scope = row.getString("scope"), key = row.getString("key"), phase = row.getString("phase");
      if (row.getInt("version") != VERSION || row.getInt("task") != task || !nonce.matches("[a-f0-9]{32}")
        || !scope.matches("[a-f0-9]{64}") || (!key.isEmpty() && !key.matches("[a-f0-9]{32}"))
        || !Arrays.asList("opening", "active", "parked", "claimed", "closed").contains(phase)
        || updated < created || (checkAge && (created > now + 60000L || updated > now + 60000L || now - created > MAX_AGE_MS))) throw new IOException("invalid session authority");
      String owner = row.getString("owner"), claim = row.getString("claim");
      if ((!owner.isEmpty() && !owner.matches("[a-f0-9]{32}")) || (!claim.isEmpty() && !claim.matches("[a-f0-9]{32}"))
        || row.getInt("attempts") < 0 || row.getInt("attempts") > 1 || row.getLong("sequence") < 0) throw new IOException("invalid session owner");
      return new Record(task, nonce, scope, row.getString("bootstrap"), key, phase, owner, claim, row.getInt("attempts"), created, updated, row.getLong("sequence"));
    } catch (IOException error) { throw error; }
    catch (Exception error) { throw new IOException("invalid task session", error); }
  }

  private void write(Record record) throws IOException {
    File base = file(record.taskId), backup = new File(base.getPath() + ".bak"), temporary = new File(base.getPath() + ".new");
    try {
      JSONObject row = new JSONObject().put("version", VERSION).put("task", record.taskId).put("nonce", record.nonce).put("scope", record.scope)
        .put("bootstrap", record.bootstrap).put("key", record.key).put("phase", record.phase).put("owner", record.owner).put("claim", record.claim)
        .put("attempts", record.attempts).put("created", record.createdAt).put("updated", record.updatedAt).put("sequence", record.sequence);
      String body = row.toString(); if (body.length() > MAX_BYTES) throw new IOException("session exceeds budget");
      byte[] bytes = new JSONObject().put("body", body).put("sha256", digest(body)).toString().getBytes(StandardCharsets.UTF_8);
      if (bytes.length > MAX_BYTES) throw new IOException("session exceeds budget");
      if (!directory.isDirectory() && !directory.mkdirs()) throw new IOException("cannot create private session directory");
      if (backup.exists()) throw new IOException("unfinished session transaction");
      try (FileOutputStream output = new FileOutputStream(temporary)) { output.write(bytes); output.flush(); output.getFD().sync(); }
      if (base.exists() && !base.renameTo(backup)) throw new IOException("cannot retain session authority");
      if (!temporary.renameTo(base)) throw new IOException("cannot publish session authority");
      if (backup.exists() && !backup.delete()) throw new IOException("cannot commit session authority");
    } catch (IOException error) {
      if (backup.exists()) { if (base.exists()) base.delete(); backup.renameTo(base); }
      throw error;
    } catch (Exception error) { throw new IOException("cannot encode task session", error); }
    finally { if (temporary.exists()) temporary.delete(); }
  }

  private void prune(int ownedTask, long now) throws IOException {
    File[] files = directory.listFiles((parent, name) -> name.matches("task-[0-9]+\\.session(?:\\.bak|\\.new)?"));
    if (files == null) return;
    Map<String, List<File>> groups = new HashMap<>();
    for (File file : files) groups.computeIfAbsent(file.getName().replaceFirst("\\.(?:bak|new)$", ""), ignored -> new ArrayList<>()).add(file);
    List<String> names = new ArrayList<>(groups.keySet());
    names.sort((first, second) -> Long.compare(newest(groups.get(second)), newest(groups.get(first))));
    int retained = 1;
    for (String name : names) {
      if (name.equals("task-" + ownedTask + ".session")) continue;
      if (now - newest(groups.get(name)) > MAX_AGE_MS || retained >= MAX_TASKS) {
        for (File entry : groups.get(name)) if (entry.exists() && !entry.delete()) throw new IOException("cannot prune task sessions");
      } else retained++;
    }
  }
  private static long newest(List<File> files) { long time = 0L; for (File file : files) time = Math.max(time, file.lastModified()); return time; }

  private static String digest(String text) {
    try { byte[] value = MessageDigest.getInstance("SHA-256").digest(text.getBytes(StandardCharsets.UTF_8)); StringBuilder out = new StringBuilder(64);
      for (byte part : value) out.append(String.format(Locale.ROOT, "%02x", part & 255)); return out.toString();
    } catch (Exception error) { throw new IllegalStateException(error); }
  }
}
