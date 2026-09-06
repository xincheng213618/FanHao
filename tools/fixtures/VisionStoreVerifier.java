package local.fanhao.library;

import android.content.Context;
import android.system.Os;
import java.io.*;
import java.lang.reflect.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.*;
import org.json.JSONArray;
import org.json.JSONObject;

/** Real production store + real JSON runtime; only Context and OS rename are doubled. */
public final class VisionStoreVerifier {
  private static int checks;
  private static int scenarios;
  private static int skipped;
  private static File root;

  private static void check(boolean condition, String message) {
    if (!condition) throw new AssertionError(message);
    checks++;
  }

  private static JSONObject document(String marker) {
    return new JSONObject().put("schemaVersion", 1).put("status", "capturing")
      .put("sessionId", "synthetic-session").put("marker", marker);
  }

  private static File directory(String name) throws IOException {
    File path = new File(root, name);
    if (!path.mkdir()) throw new IOException("Cannot create synthetic case directory");
    return path;
  }

  private static File writeFixture(File file, String text) throws IOException {
    Files.write(file.toPath(), text.getBytes(StandardCharsets.UTF_8));
    return file;
  }

  private static String text(File file) throws IOException {
    return new String(Files.readAllBytes(file.toPath()), StandardCharsets.UTF_8);
  }

  private static File temporary(File manifest) { return new File(manifest.getParentFile(), ".manifest.json.tmp"); }

  private static JSONObject summary(Context context, File session) throws Exception {
    JSONArray entries = VisionExplorationStore.listSessions(context);
    for (int index = 0; index < entries.length(); index++) {
      JSONObject item = entries.getJSONObject(index);
      if (session.getName().equals(item.getString("sessionId"))) return item;
    }
    throw new AssertionError("Synthetic session missing from list: " + session.getName());
  }

  private static JSONObject checkpoint(File session) throws Exception {
    return read(new File(session, "manifest.json"));
  }

  private static void fixtureManifest(File session, JSONObject value) throws IOException {
    writeFixture(new File(session, "manifest.json"), value.toString());
  }

  private static void unavailable(Context context, File session, String reason) throws Exception {
    JSONObject item = summary(context, session);
    check("unavailable".equals(item.getString("status")), reason + ": bad record must remain explicitly visible");
    check(!item.getBoolean("canReview") && !item.getBoolean("canResume"), reason + ": invalid record offered an action");
    String issue = item.getString("issue");
    check(!issue.isEmpty() && issue.length() <= 48, reason + ": must have a short reason");
    check(item.has("kind") && item.has("createdAt") && item.has("completedAt") && item.has("bytes") && item.has("files"), "summary fields were lost");
    failure(() -> VisionExplorationStore.getCompletedSession(context, session.getName()), reason + ": invalid complete accepted");
    failure(() -> VisionExplorationStore.getRecoverableSession(context, session.getName()), reason + ": invalid pending accepted");
  }

  private static JSONObject recoverable(Context context, File session, String nextStep) throws Exception {
    JSONObject item = summary(context, session);
    check("capturing".equals(item.getString("status")), "pending record is not visible as capturing");
    check(item.getBoolean("canResume") && !item.getBoolean("canReview"), "pending flags are incorrect");
    check(nextStep.equals(item.getString("nextStep")), "summary nextStep mismatch");
    JSONObject pending = VisionExplorationStore.getRecoverableSession(context, session.getName());
    check(nextStep.equals(pending.getString("nextStep")), "recoverable manifest nextStep mismatch");
    check(session.getName().equals(pending.getString("sessionId")), "recovered physical ID mismatch");
    return pending;
  }

  private static void directoryLink(File link, File target) throws Exception {
    check(link.getCanonicalPath().startsWith(root.getPath() + File.separator), "synthetic link must be created inside the verifier root");
    check(target.getCanonicalPath().startsWith(root.getPath() + File.separator), "synthetic link target must stay inside the verifier root");
    if (System.getProperty("os.name").toLowerCase(Locale.ROOT).contains("win")) {
      String command = "$ErrorActionPreference = 'Stop'; New-Item -ItemType Junction -Path '"
        + link.getAbsolutePath().replace("'", "''") + "' -Target '" + target.getAbsolutePath().replace("'", "''") + "' | Out-Null";
      Process process = new ProcessBuilder("powershell.exe", "-NoProfile", "-NonInteractive", "-Command", command).redirectErrorStream(true).start();
      String output = new String(process.getInputStream().readAllBytes(), StandardCharsets.UTF_8);
      check(process.waitFor(10, TimeUnit.SECONDS) && process.exitValue() == 0, "cannot create synthetic junction: " + output);
    } else Files.createSymbolicLink(link.toPath(), target.toPath());
    check(link.isDirectory(), "synthetic directory link was not created");
    if (Boolean.getBoolean("vision.store.pathProbe")) {
      System.out.println("JUNCTION PROBE java=" + System.getProperty("java.version")
        + " absolute=" + link.getAbsolutePath() + " canonical=" + link.getCanonicalPath()
        + " real=" + link.toPath().toRealPath() + " target=" + target.getAbsolutePath());
    }
    File real = link.toPath().toRealPath().toFile();
    if (!real.equals(target.toPath().toRealPath().toFile())) throw new AssertionError("synthetic link points at the wrong target");
    if (!link.getCanonicalFile().equals(real)) {
      // Android canonicalization uses realpath. Windows JDK 21 instead preserves
      // junction names, so it cannot execute these two Android path-contract cases.
      // Probe the created link (not the JDK version), and never report this as PASS.
      if (System.getProperty("os.name").toLowerCase(Locale.ROOT).contains("win")
        && link.getCanonicalFile().equals(link.getAbsoluteFile())) {
        String reason = "Windows JDK " + System.getProperty("java.version")
          + " File.getCanonicalPath() preserves junction aliases although Path.toRealPath() resolves them; rerun on a junction-resolving JVM (verified with JDK 26)";
        if (Boolean.getBoolean("vision.store.requireCanonicalLinks")) throw new AssertionError("Required canonical-link coverage unavailable: " + reason);
        throw new HostCapabilityUnavailable(reason);
      }
      throw new AssertionError("host canonicalization unexpectedly differs from the resolved link target");
    }
  }

  private static void unlink(File link) throws IOException {
    // Delete only this explicit link entry, never its target or descendants.
    Files.deleteIfExists(link.toPath());
  }

  private static Object invoke(String methodName, Class<?>[] types, Object... values) throws Exception {
    Method method = VisionExplorationStore.class.getDeclaredMethod(methodName, types);
    method.setAccessible(true);
    try { return method.invoke(null, values); }
    catch (InvocationTargetException failure) {
      Throwable cause = failure.getCause();
      if (cause instanceof Exception) throw (Exception) cause;
      if (cause instanceof Error) throw (Error) cause;
      throw failure;
    }
  }

  private static void write(File file, JSONObject value) throws Exception {
    invoke("writeJson", new Class<?>[] {File.class, JSONObject.class}, file, value);
  }

  private static JSONObject read(File file) throws Exception {
    return (JSONObject) invoke("readJson", new Class<?>[] {File.class}, file);
  }

  @FunctionalInterface private interface ThrowingAction { void run() throws Exception; }

  private static Exception failure(ThrowingAction action, String message) throws Exception {
    try { action.run(); }
    catch (Exception expected) { checks++; return expected; }
    throw new AssertionError(message);
  }

  private static void scenario(String name, ThrowingAction body) throws Exception {
    Os.reset();
    try { body.run(); }
    catch (HostCapabilityUnavailable unsupportedHost) {
      skipped++;
      System.out.println("SKIP " + name + ": " + unsupportedHost.getMessage());
      return;
    }
    scenarios++;
    System.out.println("PASS " + name);
  }

  private static final class HostCapabilityUnavailable extends RuntimeException {
    HostCapabilityUnavailable(String reason) { super(reason); }
  }

  private static final class CrashAfterDelete extends File {
    int deletions;
    CrashAfterDelete(File source) { super(source.getAbsolutePath()); }
    @Override public boolean delete() {
      deletions++;
      if (!super.delete()) return false;
      throw new SimulatedProcessExit();
    }
  }

  private static final class SimulatedProcessExit extends RuntimeException {}

  public static void main(String[] arguments) throws Exception {
    root = new File(arguments[0]).getCanonicalFile();

    scenario("session creation and completion execute the production store", () -> {
      Context context = new Context(directory("create-complete"));
      File session = VisionExplorationStore.createSession(context, "bank-card");
      JSONObject pending = read(new File(session, "manifest.json"));
      check("capturing".equals(pending.getString("status")), "new manifest is a complete capturing checkpoint");
      File photo = writeFixture(new File(session, "bank-card-front.jpg"), "synthetic image bytes");
      JSONObject completed = VisionExplorationStore.completeSession(session, "bank-card", "", photo.getName());
      check("complete".equals(completed.getString("status")), "completion returns a committed manifest");
      check(VisionExplorationStore.getCompletedSession(context, session.getName()).getJSONArray("files").length() == 1, "completed manifest can be reopened");
      check(VisionExplorationStore.listSessions(context).length() == 1, "committed session is visible");
    });

    scenario("old manifest remains present until replacement with a complete new object", () -> {
      File manifest = writeFixture(new File(directory("atomic-replace"), "manifest.json"), document("old").toString());
      Os.beforeRename = () -> {
        try {
          check("old".equals(new JSONObject(text(manifest)).getString("marker")), "old object must still be readable immediately before rename");
          check("new".equals(new JSONObject(text(temporary(manifest))).getString("marker")), "replacement temp must already contain complete new JSON");
        } catch (IOException error) { throw new RuntimeException(error); }
      };
      write(manifest, document("new"));
      check("new".equals(read(manifest).getString("marker")), "new object visible after atomic replacement");
      check(!temporary(manifest).exists(), "successful rename consumes temporary manifest");
    });

    scenario("rename failure is reported and leaves byte-identical old committed state", () -> {
      Context context = new Context(directory("rename-failure"));
      File session = VisionExplorationStore.createSession(context, "bank-card");
      File manifest = new File(session, "manifest.json");
      String before = text(manifest);
      writeFixture(new File(session, "bank-card-front.jpg"), "synthetic accepted image");
      Os.failNextRename = true;
      Exception error = failure(() -> VisionExplorationStore.completeSession(session, "bank-card", "", "bank-card-front.jpg"), "failed commit reported success");
      check(error instanceof IOException, "native rename failure is propagated as an IO error");
      check(error.getCause() instanceof android.system.ErrnoException, "native cause is retained");
      check(before.equals(text(manifest)), "failed atomic replacement changed or deleted the old manifest");
      check("capturing".equals(read(manifest).getString("status")), "uncommitted complete temp must not shadow old capturing manifest");
      JSONObject pending = summary(context, session);
      check("capturing".equals(pending.getString("status")) && !pending.getBoolean("canReview"), "failed completion must not appear successful in session list");
      check(pending.getBoolean("canResume") && "COMPLETE".equals(pending.getString("nextStep")), "failed manifest commit must remain available to retry");
      VisionExplorationStore.completeSession(session, "bank-card", "", "bank-card-front.jpg");
      check("complete".equals(VisionExplorationStore.getCompletedSession(context, session.getName()).getString("status")), "retry after rename failure can commit normally");
    });

    scenario("temporary-file write failure preserves the old manifest", () -> {
      File manifest = writeFixture(new File(directory("write-failure"), "manifest.json"), document("old").toString());
      check(temporary(manifest).mkdir(), "synthetic obstruction created");
      failure(() -> write(manifest, document("new")), "opening a directory as a temp file unexpectedly succeeded");
      check("old".equals(read(manifest).getString("marker")), "temp open failure modified old manifest");
      check(Os.renameCalls == 0, "failed temp write must not attempt replacement");
    });

    scenario("an existing manifest wins over both complete and malformed orphan temps", () -> {
      File manifest = writeFixture(new File(directory("existing-wins"), "manifest.json"), document("committed").toString());
      writeFixture(temporary(manifest), document("uncommitted").toString());
      check("committed".equals(read(manifest).getString("marker")), "complete orphan temp hid committed manifest");
      writeFixture(temporary(manifest), "{\"marker\":");
      check("committed".equals(read(manifest).getString("marker")), "malformed orphan temp blocked committed manifest");
      check(Os.renameCalls == 0, "reads must not promote temp while manifest exists");
    });

    scenario("missing manifest recovers a complete legacy temp", () -> {
      File manifest = new File(directory("recover-missing"), "manifest.json");
      writeFixture(temporary(manifest), document("recoverable").toString());
      check("recoverable".equals(read(manifest).getString("marker")), "missing legacy manifest did not recover complete temp");
      check(manifest.isFile() && !temporary(manifest).exists(), "recovery atomically promotes the temp");
      check(Os.renameCalls == 1, "recovery commits once");
      check("recoverable".equals(read(manifest).getString("marker")) && Os.renameCalls == 1, "recovery is idempotent");
    });

    scenario("actual completed session is recoverable after the historical missing-manifest window", () -> {
      Context context = new Context(directory("recover-completed"));
      File session = VisionExplorationStore.createSession(context, "id-card");
      writeFixture(new File(session, "id-front.jpg"), "synthetic accepted front");
      writeFixture(new File(session, "id-back.jpg"), "synthetic accepted back");
      JSONObject completed = VisionExplorationStore.completeSession(session, "id-card", "", "id-front.jpg", "id-back.jpg");
      File manifest = new File(session, "manifest.json");
      check(manifest.delete(), "synthetic historical missing target prepared");
      writeFixture(temporary(manifest), completed.toString());
      check(VisionExplorationStore.getCompletedSession(context, session.getName()).getJSONArray("files").length() == 2, "getCompletedSession cannot recover the committed photograph checkpoint");
      check(new File(session, "id-front.jpg").isFile() && new File(session, "id-back.jpg").isFile(), "manifest recovery must not alter photographs");
    });

    scenario("capturing checkpoint can recover then complete normally", () -> {
      Context context = new Context(directory("recover-pending"));
      File session = VisionExplorationStore.createSession(context, "bank-card");
      File manifest = new File(session, "manifest.json");
      String checkpoint = text(manifest);
      check(manifest.delete(), "synthetic missing pending manifest prepared");
      writeFixture(temporary(manifest), checkpoint);
      Exception pending = failure(() -> VisionExplorationStore.getCompletedSession(context, session.getName()), "capturing checkpoint reported complete");
      check(pending instanceof IllegalStateException && "探索记录尚未完成".equals(pending.getMessage()), "recovered pending checkpoint must retain normal resume semantics");
      writeFixture(new File(session, "bank-card-front.jpg"), "synthetic accepted card");
      VisionExplorationStore.completeSession(session, "bank-card", "", "bank-card-front.jpg");
      check(VisionExplorationStore.getCompletedSession(context, session.getName()) != null, "recovered pending checkpoint cannot complete");
    });

    scenario("partial temporary JSON is rejected without fabricating a manifest", () -> {
      File manifest = new File(directory("partial-temp"), "manifest.json");
      writeFixture(temporary(manifest), "{\"status\":");
      failure(() -> read(manifest), "partial JSON was treated as a recovered checkpoint");
      check(!manifest.exists(), "partial JSON was promoted to manifest");
      check(temporary(manifest).exists() && Os.renameCalls == 0, "invalid temp must not be renamed or silently consumed");
    });

    scenario("recovery rename failure is reported and remains retryable", () -> {
      File manifest = new File(directory("recovery-rename-failure"), "manifest.json");
      writeFixture(temporary(manifest), document("recoverable").toString());
      Os.failNextRename = true;
      check(failure(() -> read(manifest), "recovery returned success without a committed file") instanceof IOException, "failed recovery reports IO error");
      check(!manifest.exists() && temporary(manifest).isFile(), "failed recovery lost the only complete checkpoint");
      check("recoverable".equals(read(manifest).getString("marker")), "recovery cannot be retried after transient rename failure");
    });

    scenario("a missing manifest without a temp is not silently recreated", () -> {
      File manifest = new File(directory("fully-missing"), "manifest.json");
      check(failure(() -> read(manifest), "nonexistent session manifest fabricated") instanceof IOException, "missing files retain an explicit IO failure");
      check(Os.renameCalls == 0, "missing state must not cause a rename");
    });

    scenario("production commit never invokes destination delete", () -> {
      File manifest = writeFixture(new File(directory("delete-trap-current"), "manifest.json"), document("old").toString());
      CrashAfterDelete trap = new CrashAfterDelete(manifest);
      write(trap, document("new"));
      check(trap.deletions == 0, "production commit still deletes before replacement");
      check("new".equals(read(manifest).getString("marker")), "production atomic replacement failed under the old delete-window trap");
    });

    scenario("historical executable control loses manifest after delete, then new read recovers it", () -> {
      File manifest = writeFixture(new File(directory("delete-trap-legacy"), "manifest.json"), document("old").toString());
      CrashAfterDelete trap = new CrashAfterDelete(manifest);
      try { LegacyVisionManifestCommit.writeJson(trap, document("new")); throw new AssertionError("legacy delete checkpoint was not reached"); }
      catch (SimulatedProcessExit expected) { checks++; }
      check(!manifest.exists() && temporary(manifest).isFile(), "negative control did not reproduce missing manifest window");
      check("new".equals(new JSONObject(text(temporary(manifest))).getString("marker")), "legacy interruption must leave the complete flushed temp");
      check("new".equals(read(manifest).getString("marker")), "new recovery cannot repair the actual old failure shape");
      System.out.println("CONTROL reproduced: old delete-before-rename destroys the only named manifest");
    });

    scenario("same-process writers serialize their fixed temporary manifest", () -> {
      File manifest = writeFixture(new File(directory("serialized-writers"), "manifest.json"), document("old").toString());
      CountDownLatch firstAtRename = new CountDownLatch(1), releaseFirst = new CountDownLatch(1), secondStarted = new CountDownLatch(1);
      AtomicReference<Throwable> failure = new AtomicReference<>();
      Os.beforeRename = () -> {
        Os.beforeRename = null;
        firstAtRename.countDown();
        try { if (!releaseFirst.await(5, TimeUnit.SECONDS)) throw new AssertionError("first writer timed out"); }
        catch (InterruptedException error) { throw new RuntimeException(error); }
      };
      Thread first = new Thread(() -> { try { write(manifest, document("first")); } catch (Throwable error) { failure.set(error); } });
      Thread second = new Thread(() -> { secondStarted.countDown(); try { write(manifest, document("second")); } catch (Throwable error) { failure.set(error); } });
      first.start();
      check(firstAtRename.await(5, TimeUnit.SECONDS), "first writer reached replacement gate");
      second.start();
      check(secondStarted.await(5, TimeUnit.SECONDS), "second writer started");
      long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(3);
      while (second.getState() != Thread.State.BLOCKED && second.isAlive() && System.nanoTime() < deadline) Thread.yield();
      boolean blocked = second.getState() == Thread.State.BLOCKED;
      String held = text(temporary(manifest));
      releaseFirst.countDown();
      first.join(5000); second.join(5000);
      check(!first.isAlive() && !second.isAlive() && failure.get() == null, "concurrent synthetic writers failed: " + failure.get());
      check(blocked && "first".equals(new JSONObject(held).getString("marker")), "second writer overwrote first writer's uncommitted temp");
      check("second".equals(read(manifest).getString("marker")), "serialized final manifest does not contain the second complete write");
    });

    scenario("pending ID checkpoints preserve every accepted step and offer completion retry", () -> {
      Context context = new Context(directory("pending-id-steps"));
      File session = VisionExplorationStore.createSession(context, "id-card");
      JSONObject first = recoverable(context, session, "ID_FRONT");
      check("id-card".equals(first.getString("kind")) && first.getJSONArray("files").length() == 0, "initial ID checkpoint lost its kind");
      writeFixture(new File(session, "id-front.jpg"), "accepted synthetic front");
      check(recoverable(context, session, "ID_BACK").getJSONArray("files").length() == 1, "front checkpoint must be retained");
      writeFixture(new File(session, "id-back.jpg"), "accepted synthetic back");
      check(recoverable(context, session, "COMPLETE").getJSONArray("files").length() == 2, "both pending photos must be retained for commit retry");
      VisionExplorationStore.completeSession(session, "id-card", "", "id-front.jpg", "id-back.jpg");
      JSONObject complete = summary(context, session);
      check("complete".equals(complete.getString("status")) && complete.getBoolean("canReview") && !complete.getBoolean("canResume"), "completed review flags are incorrect");
      check(complete.optLong("completedAt") > 0 && complete.optLong("createdAt") > 0, "completion lost summary timestamps");
      failure(() -> VisionExplorationStore.getRecoverableSession(context, session.getName()), "complete record should not be relaunched as pending");
      failure(() -> VisionExplorationStore.completeSession(session, "id-card", "", "id-front.jpg", "id-back.jpg"), "complete manifest was overwritten");
    });

    scenario("new bank and face sessions are resumable before any photos exist", () -> {
      Context context = new Context(directory("pending-kind-steps"));
      File bank = VisionExplorationStore.createSession(context, "bank-card");
      recoverable(context, bank, "BANK_FRONT");
      File face = VisionExplorationStore.createSession(context, "face-verification");
      JSONObject pending = recoverable(context, face, "FACE");
      check(pending.optString("challenge", "").isEmpty(), "new face session must not invent an action during listing");
      check(!checkpoint(face).has("challenge"), "read-only recovery persisted an invented action");
      failure(() -> VisionExplorationStore.createSession(context, "unknown"), "unknown kind should not create an unusable session");
      check(VisionExplorationStore.listSessions(context).length() == 2, "invalid creation left behind an orphan directory");
    });

    scenario("face action is durably saved before capture and survives recovery", () -> {
      Context context = new Context(directory("face-action"));
      File session = VisionExplorationStore.createSession(context, "face-verification");
      VisionExplorationStore.saveChallenge(session, "缓慢转头");
      check("缓慢转头".equals(checkpoint(session).getString("challenge")), "challenge did not reach committed manifest");
      check("缓慢转头".equals(recoverable(context, session, "FACE").getString("challenge")), "recovery changed the saved action");
      VisionExplorationStore.saveChallenge(session, "微笑一下");
      check("微笑一下".equals(checkpoint(session).getString("challenge")), "valid pre-capture retry action cannot be saved");
      writeFixture(new File(session, "face-verification.jpg"), "synthetic accepted face");
      check("微笑一下".equals(recoverable(context, session, "COMPLETE").getString("challenge")), "accepted photo lost its exact challenge");
      String before = text(new File(session, "manifest.json"));
      failure(() -> VisionExplorationStore.saveChallenge(session, "缓慢转头"), "action on already accepted face photo was altered");
      failure(() -> VisionExplorationStore.completeSession(session, "face-verification", "缓慢转头", "face-verification.jpg"), "completed face was associated with a different action");
      check(before.equals(text(new File(session, "manifest.json"))), "failed face action validation changed committed manifest");
      VisionExplorationStore.completeSession(session, "face-verification", "微笑一下", "face-verification.jpg");
      check("微笑一下".equals(VisionExplorationStore.getCompletedSession(context, session.getName()).getString("challenge")), "complete face action missing");
      failure(() -> VisionExplorationStore.saveChallenge(session, "微笑一下"), "completed record should be immutable through saveChallenge");
    });

    scenario("invalid or failed challenge writes leave the committed checkpoint intact", () -> {
      Context context = new Context(directory("face-action-failures"));
      File session = VisionExplorationStore.createSession(context, "face-verification");
      VisionExplorationStore.saveChallenge(session, "缓慢转头");
      String before = text(new File(session, "manifest.json"));
      for (String invalid : new String[] { null, "", "眨眼", "微笑一下 ", "../outside" }) {
        failure(() -> VisionExplorationStore.saveChallenge(session, invalid), "invalid action accepted: " + invalid);
      }
      check(before.equals(text(new File(session, "manifest.json"))), "invalid action changed the committed checkpoint");
      Os.failNextRename = true;
      failure(() -> VisionExplorationStore.saveChallenge(session, "微笑一下"), "rename failure was reported as saved action");
      check(before.equals(text(new File(session, "manifest.json"))), "failed action commit lost old checkpoint");
      check("缓慢转头".equals(recoverable(context, session, "FACE").getString("challenge")), "uncommitted challenge temp shadowed the old action");
      VisionExplorationStore.saveChallenge(session, "微笑一下");
      check("微笑一下".equals(checkpoint(session).getString("challenge")), "failed action commit cannot be retried");
      File bank = VisionExplorationStore.createSession(context, "bank-card");
      failure(() -> VisionExplorationStore.saveChallenge(bank, "微笑一下"), "non-face pending record accepted a face action");
    });

    scenario("accepted face without a valid saved action is unavailable rather than guessed", () -> {
      Context context = new Context(directory("face-no-action"));
      Object[] invalid = { null, "", "眨眼", 1, JSONObject.NULL };
      for (int index = 0; index < invalid.length; index++) {
        File session = VisionExplorationStore.createSession(context, "face-verification");
        JSONObject manifest = checkpoint(session);
        if (invalid[index] != null) manifest.put("challenge", invalid[index]);
        fixtureManifest(session, manifest);
        writeFixture(new File(session, "face-verification.jpg"), "synthetic accepted face");
        String before = text(new File(session, "manifest.json"));
        unavailable(context, session, "face action " + index);
        failure(() -> VisionExplorationStore.saveChallenge(session, "微笑一下"), "accepted face without history should not acquire a fabricated action");
        check(before.equals(text(new File(session, "manifest.json"))), "invalid face checkpoint was modified");
        check(new File(session, "face-verification.jpg").exists(), "invalid face photo was silently removed");
      }
    });

    scenario("malformed pending headers stay visible but neither reviewable nor resumable", () -> {
      Context context = new Context(directory("invalid-headers"));
      String[] keys = { "schemaVersion", "schemaVersion", "schemaVersion", "sessionId", "kind", "status", "status" };
      Object[] values = { 2, "1", JSONObject.NULL, "20260830-120000-00000000", "unknown", "complete-ish", JSONObject.NULL };
      for (int index = 0; index < keys.length; index++) {
        File session = VisionExplorationStore.createSession(context, "bank-card");
        JSONObject malformed = checkpoint(session).put(keys[index], values[index]);
        fixtureManifest(session, malformed);
        String before = text(new File(session, "manifest.json"));
        unavailable(context, session, "invalid " + keys[index] + "=" + values[index]);
        check(before.equals(text(new File(session, "manifest.json"))), "listing rewrote a malformed header");
      }
      check(VisionExplorationStore.listSessions(context).length() == keys.length, "bad headers were silently hidden");
    });

    scenario("missing corrupt oversized or trailing-garbage manifests remain explicit unavailable entries", () -> {
      Context context = new Context(directory("invalid-json"));
      String[] invalid = { "", "{\"status\":", "[]", "{\"padding\":\"" + "x".repeat(65536) + "\"}", "{} trailing" };
      for (String value : invalid) {
        File session = VisionExplorationStore.createSession(context, "bank-card");
        writeFixture(new File(session, "manifest.json"), value);
        unavailable(context, session, "corrupt JSON");
        check(value.equals(text(new File(session, "manifest.json"))), "corrupt data silently rewritten");
      }
      File missing = VisionExplorationStore.createSession(context, "bank-card");
      check(new File(missing, "manifest.json").delete(), "prepare missing synthetic manifest");
      unavailable(context, missing, "missing manifest");
      check(!new File(missing, "manifest.json").exists(), "missing invalid manifest was synthesized");
      check(VisionExplorationStore.listSessions(context).length() == invalid.length + 1, "broken records should not vanish from deletion list");
    });

    scenario("pending photo shape rejects zero bytes wrong kind and out-of-order ID checkpoints", () -> {
      Context context = new Context(directory("invalid-pending-photos"));
      File zero = VisionExplorationStore.createSession(context, "bank-card");
      writeFixture(new File(zero, "bank-card-front.jpg"), "");
      unavailable(context, zero, "empty accepted photo");
      File foreign = VisionExplorationStore.createSession(context, "bank-card");
      writeFixture(new File(foreign, "id-front.jpg"), "wrong kind photo");
      unavailable(context, foreign, "wrong kind photo");
      File backOnly = VisionExplorationStore.createSession(context, "id-card");
      writeFixture(new File(backOnly, "id-back.jpg"), "accepted back without front");
      unavailable(context, backOnly, "back without front");
      File nested = VisionExplorationStore.createSession(context, "bank-card");
      check(new File(nested, "bank-card-front.jpg").mkdir(), "prepare directory masquerading as photo");
      unavailable(context, nested, "photo is directory");
      check(zero.exists() && foreign.exists() && backOnly.exists() && nested.exists(), "validation silently deleted incomplete sessions");
    });

    scenario("complete records require exactly the expected named nonempty photos and matching lengths", () -> {
      Context context = new Context(directory("invalid-complete"));
      File session = VisionExplorationStore.createSession(context, "bank-card");
      File photo = writeFixture(new File(session, "bank-card-front.jpg"), "synthetic bank photo");
      VisionExplorationStore.completeSession(session, "bank-card", "", photo.getName());
      String original = text(new File(session, "manifest.json"));
      JSONObject damaged = new JSONObject(original);
      damaged.getJSONArray("files").getJSONObject(0).put("bytes", photo.length() + 1);
      fixtureManifest(session, damaged);
      unavailable(context, session, "wrong byte count");
      damaged = new JSONObject(original);
      damaged.getJSONArray("files").getJSONObject(0).put("bytes", String.valueOf(photo.length()));
      fixtureManifest(session, damaged);
      unavailable(context, session, "string byte count");
      damaged = new JSONObject(original);
      damaged.getJSONArray("files").put(new JSONObject(damaged.getJSONArray("files").getJSONObject(0).toString()));
      fixtureManifest(session, damaged);
      unavailable(context, session, "duplicate declared photo");
      fixtureManifest(session, new JSONObject(original).put("files", new JSONArray()));
      unavailable(context, session, "missing complete photo declaration");
      fixtureManifest(session, new JSONObject(original).put("files", "bank-card-front.jpg"));
      unavailable(context, session, "non-array photo declaration");
      damaged = new JSONObject(original);
      damaged.getJSONArray("files").getJSONObject(0).put("name", "../outside.jpg");
      fixtureManifest(session, damaged);
      unavailable(context, session, "traversing declaration");
      writeFixture(new File(session, "manifest.json"), original);
      check(photo.delete(), "prepare missing completed photo");
      unavailable(context, session, "missing completed photo");
      writeFixture(photo, "");
      unavailable(context, session, "empty completed photo");
      writeFixture(photo, "synthetic bank photo");
      check(summary(context, session).getBoolean("canReview"), "restored original complete record should be reviewable");
    });

    scenario("completion rejects mismatched kind duplicate missing and traversal names without committing", () -> {
      Context context = new Context(directory("complete-api-validation"));
      File session = VisionExplorationStore.createSession(context, "id-card");
      writeFixture(new File(session, "id-front.jpg"), "front");
      writeFixture(new File(session, "id-back.jpg"), "back");
      String before = text(new File(session, "manifest.json"));
      failure(() -> VisionExplorationStore.completeSession(session, "bank-card", "", "id-front.jpg", "id-back.jpg"), "kind mismatch committed");
      failure(() -> VisionExplorationStore.completeSession(session, null, "", "id-front.jpg", "id-back.jpg"), "null kind committed");
      failure(() -> VisionExplorationStore.completeSession(session, "id-card", "", "id-front.jpg"), "incomplete files committed");
      failure(() -> VisionExplorationStore.completeSession(session, "id-card", "", "id-front.jpg", "id-front.jpg"), "duplicate files committed");
      failure(() -> VisionExplorationStore.completeSession(session, "id-card", "", "../outside.jpg"), "path traversal committed");
      check(before.equals(text(new File(session, "manifest.json"))), "invalid completion changed original checkpoint");
      recoverable(context, session, "COMPLETE");
    });

    scenario("unknown user files are retained and counted without becoming accepted checkpoints", () -> {
      Context context = new Context(directory("unknown-files"));
      File session = VisionExplorationStore.createSession(context, "bank-card");
      File note = writeFixture(new File(session, "user-note.txt"), "private synthetic note");
      File photo = writeFixture(new File(session, "user-photo.jpg"), "unrecognized synthetic image");
      File pending = writeFixture(VisionCaptureLifecycle.temporaryCapture(session), "unpromoted camera bytes");
      JSONObject item = recoverable(context, session, "BANK_FRONT");
      check(item.getJSONArray("files").length() == 0, "unknown or temporary photo was treated as accepted capture");
      check(note.isFile() && photo.isFile() && pending.isFile(), "listing or recovery silently removed unknown/camera-owned files");
      long expected = note.length() + photo.length() + pending.length() + new File(session, "manifest.json").length();
      check(summary(context, session).getLong("bytes") == expected, "session byte count should include local preserved files");
    });

    scenario("unknown subdirectories stay unavailable and are never automatically cleaned", () -> {
      Context context = new Context(directory("unknown-directory"));
      File session = VisionExplorationStore.createSession(context, "bank-card");
      File nested = new File(session, "user-owned");
      check(nested.mkdir(), "prepare synthetic unknown directory");
      File note = writeFixture(new File(nested, "note.txt"), "synthetic nested bytes");
      unavailable(context, session, "unknown nested directory");
      check(note.isFile(), "unknown nested file silently deleted");
      check(summary(context, session).getLong("bytes") == note.length() + new File(session, "manifest.json").length(), "safe nested bytes should be counted");
    });

    scenario("only safe direct session-ID directories appear in the list", () -> {
      Context context = new Context(directory("directory-filter"));
      File session = VisionExplorationStore.createSession(context, "bank-card");
      File records = session.getParentFile();
      check(new File(records, "user-notes").mkdir(), "prepare unrelated directory");
      writeFixture(new File(records, "20260830-120000-01234567"), "ordinary file with ID-looking name");
      check(VisionExplorationStore.listSessions(context).length() == 1, "invalid directories or regular files listed as sessions");
      for (String invalid : new String[] { "../outside", session.getAbsolutePath(), "20260830-120000-ABCDEF01", "", null }) {
        failure(() -> VisionExplorationStore.getRecoverableSession(context, invalid), "invalid session ID accepted");
      }
      check(!VisionExplorationStore.deleteSession(context, "../outside"), "invalid session ID should not delete a path");
      check(new File(records, "user-notes").isDirectory(), "unrelated root directory silently removed");
    });

    scenario("unavailable sessions remain explicitly deletable without removing siblings", () -> {
      Context context = new Context(directory("delete-unavailable"));
      File broken = VisionExplorationStore.createSession(context, "bank-card");
      File preserved = VisionExplorationStore.createSession(context, "id-card");
      writeFixture(new File(broken, "manifest.json"), "broken JSON");
      writeFixture(new File(broken, "user-note.txt"), "owned by explicitly deleted session");
      unavailable(context, broken, "deleteable damaged manifest");
      check(VisionExplorationStore.deleteSession(context, broken.getName()), "explicit deletion did not report actual removal");
      check(!broken.exists() && preserved.isDirectory(), "deletion removed sibling data or left target present");
      check(!VisionExplorationStore.deleteSession(context, broken.getName()), "already missing target incorrectly reported deletion");
      recoverable(context, preserved, "ID_FRONT");
    });

    scenario("root absence is empty but malformed root is an explicit load failure", () -> {
      Context absent = new Context(directory("root-absent"));
      check(VisionExplorationStore.listSessions(absent).length() == 0, "new app root should show an empty list");
      Context invalid = new Context(directory("root-is-file"));
      File rootFile = writeFixture(new File(invalid.getFilesDir(), "vision-exploration"), "synthetic obstruction");
      failure(() -> VisionExplorationStore.listSessions(invalid), "non-directory root silently shown as no saved records");
      check(rootFile.isFile(), "invalid root was automatically cleared");
    });

    scenario("directory aliases and nested loops cannot escape the root or inflate record bytes", () -> {
      Context context = new Context(directory("link-containment"));
      File session = VisionExplorationStore.createSession(context, "bank-card");
      File external = directory("external-owned-synthetic-data");
      File sentinel = writeFixture(new File(external, "not-in-session.txt"), "outside synthetic private bytes".repeat(1000));
      File alias = new File(session.getParentFile(), "20260830-120000-abcdef01");
      File escaped = new File(session, "outside-link");
      File loop = new File(session, "loop");
      try {
        directoryLink(alias, external);
        check(VisionExplorationStore.listSessions(context).length() == 1, "root-level alias was followed and exposed as a session");
        failure(() -> VisionExplorationStore.getRecoverableSession(context, alias.getName()), "aliased session was opened");
        directoryLink(escaped, external);
        directoryLink(loop, session);
        unavailable(context, session, "links outside session and loop");
        check(summary(context, session).getLong("bytes") == new File(session, "manifest.json").length(), "out-of-session or loop bytes were counted");
        check(sentinel.isFile() && escaped.isDirectory() && loop.isDirectory(), "list validation deleted outside or unknown link data");
        check(VisionExplorationStore.deleteSession(context, session.getName()), "explicit session deletion failed to unlink unsafe children");
        check(sentinel.isFile() && external.isDirectory(), "explicit record deletion traversed an external link");
      } finally {
        unlink(loop); unlink(escaped); unlink(alias);
      }
    });

    scenario("an aliased record root is rejected rather than read or shown as empty", () -> {
      Context context = new Context(directory("root-link"));
      File external = directory("external-root-target");
      File sentinel = writeFixture(new File(external, "outside.txt"), "not an app record");
      File link = new File(context.getFilesDir(), "vision-exploration");
      try {
        directoryLink(link, external);
        failure(() -> VisionExplorationStore.listSessions(context), "root link failure silently shown as empty");
        failure(() -> VisionExplorationStore.createSession(context, "bank-card"), "session creation followed root alias");
        check(sentinel.isFile() && external.listFiles().length == 1, "root alias check touched outside data");
      } finally { unlink(link); }
    });

    System.out.println("vision-store-verification: " + scenarios + " passed scenarios / " + checks
      + " checks / " + skipped + " skipped host-specific scenarios (real store, resume, validation, containment, atomic commit and historical control)");
  }
}
