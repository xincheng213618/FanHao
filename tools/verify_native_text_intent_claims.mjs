import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// Actual production capture/consume/clear bodies and the complete queue helper;
// only Android/Capacitor and the provider read boundary are replaced. This is a
// deterministic JVM contract test, not a full-plugin build or an Android test.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const nativeRoot = path.join(root, "android-client/android/app/src/main/java/local/fanhao/library");
const source = fs.readFileSync(path.join(nativeRoot, "FanHaoNovelPlugin.java"), "utf8");
const historical = JSON.parse(fs.readFileSync(path.join(root, "tools/fixtures/native-text-intents-before-claim.json"), "utf8"));
const legacy = process.argv.includes("--legacy");
function method(name) {
  if (legacy) return historical.methods[name];
  const found = source.match(new RegExp(`^  (?:private |public |protected )?(?:static )?[\\w<>\\[\\]]+ ${name}\\([^]*?\\n  \\}`, "m"));
  assert(found, `Missing production method: ${name}`);
  return found[0];
}
const field = legacy ? "private static Intent pendingTextIntent = null;"
  : source.match(/^  private static final PendingTextImportQueue<Intent> pendingTextIntents[^\r\n]+/m)?.[0];
assert(field, "Production queue field missing");
const production = `package local.fanhao.library;
import java.util.*;
import java.util.concurrent.*;
public class FanHaoNovelPlugin {
  ${field}
${method("capturePendingTextIntent")}
${method("consumePendingTextFile")}
${method("clearPendingIntent")}
  final Activity activity;
  final Context context = new Context();
  int reads;
  boolean failRead, blankFailure;
  CountDownLatch entered, release;
  FanHaoNovelPlugin(Activity activity) { this.activity = activity; }
  Activity getActivity() { return activity; }
  Context getContext() { return context; }
  static boolean shouldHandleTextIntent(Context context, Intent intent) { return intent != null && !Intent.ACTION_MAIN.equals(intent.action); }
  static boolean looksLikeTextIntent(Context context, Intent intent) { return shouldHandleTextIntent(context, intent) && !"UNSUPPORTED".equals(intent.action); }
  static String unsupportedTextIntentMessage(Intent intent) { return intent != null && "UNSUPPORTED".equals(intent.action) ? "Unsupported synthetic text" : ""; }
  JSObject unavailableResult(String message) { JSObject result = new JSObject(false, ""); if (!message.isEmpty()) result.put("message", message); return result; }
  void showToast(String message) {}
  JSObject readIntentText(Intent intent) throws Exception {
    reads++;
    if (entered != null) entered.countDown();
    if (release != null && !release.await(5, TimeUnit.SECONDS)) throw new AssertionError("Fixture read release timed out");
    if (failRead) throw new IllegalStateException(blankFailure ? "" : "Synthetic provider failure");
    return new JSObject(true, intent.text);
  }
  static void testReset() {
    ${legacy ? "pendingTextIntent = null;" : "if (pendingTextIntents.isBusy()) throw new AssertionError(\"Prior test leaked an active claim\"); PendingTextImportQueue.Claim<Intent> claim; while ((claim = pendingTextIntents.claim()) != null) pendingTextIntents.complete(claim);"}
  }
}
class Context { String getPackageName() { return "local.fanhao.library"; } }
class Intent {
  static final String ACTION_MAIN = "MAIN";
  final String action;
  String text = "";
  Intent(String action) { this.action = action; }
  Intent(Intent intent) { action = intent.action; text = intent.text; }
  Intent setPackage(String name) { return this; }
  static Intent text(String value) { Intent intent = new Intent("SEND"); intent.text = value; return intent; }
}
class Activity extends Context {
  private volatile Intent intent = new Intent(Intent.ACTION_MAIN);
  final Queue<Runnable> mainTasks = new ConcurrentLinkedQueue<>();
  final Thread mainThread = Thread.currentThread();
  int offMainIntentWrites;
  Intent getIntent() { return intent; }
  void setIntent(Intent value) { if (Thread.currentThread() != mainThread) offMainIntentWrites++; intent = value; }
  void runOnUiThread(Runnable task) { mainTasks.add(task); }
  void drainMain() { Runnable task; while ((task = mainTasks.poll()) != null) task.run(); }
}
class JSObject {
  final boolean available; final String text;
  final Map<String,Object> values = new LinkedHashMap<>();
  JSObject(boolean available, String text) { this.available = available; this.text = text; }
  JSObject put(String key, Object value) { values.put(key, value); return this; }
  Object get(String key) { return values.get(key); }
}
class PluginCall {
  JSObject result; String error; boolean released;
  void resolve(JSObject result) { this.result = result; }
  void reject(String message, Exception error) { this.error = message; }
  boolean isReleased() { return released; }
}
`;

const taskTemp = fs.mkdtempSync(path.join(os.tmpdir(), "fanhao-native-text-claims-"));
try {
  const javaHome = String(process.env.JAVA_HOME || "").trim() || "C:\\Program Files\\Android\\openjdk\\jdk-21.0.8";
  const javaTool = (name) => path.join(javaHome, "bin", `${name}${process.platform === "win32" ? ".exe" : ""}`);
  const pluginPath = path.join(taskTemp, "FanHaoNovelPlugin.java");
  fs.writeFileSync(pluginPath, production);
  const compile = spawnSync(javaTool("javac"), ["-encoding", "UTF-8", "-d", taskTemp,
    pluginPath, path.join(nativeRoot, "PendingTextImportQueue.java"),
    path.join(root, "tools/fixtures/NativeTextIntentClaimsHarness.java")], { encoding: "utf8", timeout: 30000 });
  assert.equal(compile.status, 0, compile.error || compile.stderr);
  const run = spawnSync(javaTool("java"), ["-cp", taskTemp, "local.fanhao.library.NativeTextIntentClaimsHarness", ...(legacy ? ["--legacy"] : [])], { encoding: "utf8", timeout: 30000 });
  process.stdout.write(run.stdout || "");
  process.stderr.write(run.stderr || "");
  assert.equal(run.status, 0, run.error || "Native claim fixture failed");
} finally {
  const exact = fs.realpathSync(taskTemp), parent = fs.realpathSync(os.tmpdir());
  assert.equal(path.dirname(exact), parent);
  assert(path.basename(exact).startsWith("fanhao-native-text-claims-"));
  if (process.platform === "win32") {
    const cleanup = spawnSync("powershell.exe", ["-NoProfile", "-Command", `Remove-Item -LiteralPath '${exact.replace(/'/g, "''")}' -Recurse -Force`], { encoding: "utf8", timeout: 10000 });
    assert.equal(cleanup.status, 0, cleanup.error || cleanup.stderr);
  } else fs.rmSync(exact, { recursive: true, force: true });
}
if (!legacy) {
  const control = spawnSync(process.execPath, [fileURLToPath(import.meta.url), "--legacy"], { cwd: root, encoding: "utf8", timeout: 30000 });
  process.stdout.write(control.stdout || "");
  process.stderr.write(control.stderr || "");
  assert.equal(control.status, 0, control.error || "Frozen legacy controls failed");
}
