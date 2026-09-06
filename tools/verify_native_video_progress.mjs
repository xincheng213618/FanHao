import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { commitDoubles } from "./fixtures/native-video-progress-commit-doubles.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const nativeRoot = path.join(root, "android-client/android/app/src/main/java/local/fanhao/library");
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "fanhao-native-video-progress-"));
const javaHome = String(process.env.JAVA_HOME || "").trim() || "C:\\Program Files\\Android\\openjdk\\jdk-21.0.8";
const executable = (name) => fs.existsSync(path.join(javaHome, "bin", `${name}.exe`))
  ? path.join(javaHome, "bin", `${name}.exe`) : name;

// Execute the actual Activity lifecycle/timeline methods and actual delivery helper.
// Only Android UI, player, and JSON dependencies are doubled; no Gradle, device,
// network, or wall-clock sleep is used. The Java harness intercepts URL connections.
const doubles = {
  "android/os/Handler.java": `package android.os;
    import java.util.ArrayList;
    public class Handler {
      public static final ArrayList<Handler> receiptHandlers = new ArrayList<>();
      public Handler() {}
      public Handler(Looper looper) { receiptHandlers.add(this); }
      public final ArrayList<Runnable> pending = new ArrayList<>();
      public long lastDelay;
      public boolean post(Runnable task) { pending.add(task); lastDelay = 0; return true; }
      public boolean postDelayed(Runnable task, long delay) {
        pending.add(task); lastDelay = delay; return true;
      }
      public void removeCallbacks(Runnable task) { pending.removeIf(value -> value == task); }
      public void runPending() {
        ArrayList<Runnable> batch = new ArrayList<>(pending); pending.clear();
        for (Runnable task : batch) task.run();
      }
    }`,
  "androidx/media3/common/Player.java": `package androidx.media3.common;
    public interface Player {
      int STATE_IDLE = 1, STATE_BUFFERING = 2, STATE_READY = 3, STATE_ENDED = 4;
    }`,
  "androidx/media3/exoplayer/ExoPlayer.java": `package androidx.media3.exoplayer;
    import androidx.media3.common.Player;
    public class ExoPlayer {
      public long position = 12500, duration = 120000;
      public int playbackState = Player.STATE_READY;
      public boolean released, paused;
      public int reads, pauses, releases;
      private void touch() { if (released) throw new IllegalStateException("released player"); }
      public long getCurrentPosition() { touch(); reads++; return position; }
      public int getPlaybackState() { touch(); reads++; return playbackState; }
      public long getDuration() { touch(); reads++; return duration; }
      public void pause() { touch(); pauses++; paused = true; }
      public void release() { touch(); releases++; released = true; }
    }`,
  "org/json/JSONObject.java": String.raw`package org.json;
    import java.util.LinkedHashMap;
    import java.util.Map;
    public class JSONObject {
      private final Map<String, Object> values = new LinkedHashMap<>();
      public JSONObject put(String key, Object value) { values.put(key, value); return this; }
      private static String quote(String value) {
        return "\"" + value.replace("\\", "\\\\").replace("\"", "\\\"") + "\"";
      }
      public String toString() {
        StringBuilder result = new StringBuilder("{");
        for (Map.Entry<String, Object> entry : values.entrySet()) {
          if (result.length() > 1) result.append(',');
          Object value = entry.getValue();
          result.append(quote(entry.getKey())).append(':');
          result.append(value instanceof String ? quote((String) value) : String.valueOf(value));
        }
        return result.append('}').toString();
      }
    }`,
  "local/fanhao/library/NativeVideoProgressHostBase.java": `package local.fanhao.library;
    import android.os.Handler;
    import androidx.media3.exoplayer.ExoPlayer;
    abstract class NativeVideoProgressHostBase {
      final Handler handler = new Handler();
      final Runnable statusHideRunnable = () -> {};
      final Runnable overlayHideRunnable = () -> {};
      ExoPlayer player = new ExoPlayer();
      String progressUrl = "http://progress.test/api/progress", workId = "work-original";
      double probedDurationSeconds;
      long streamOffsetMs, lastProgressAt;
      int barsHidden, pauseCallbacks, resumeCallbacks, destroyCallbacks;
      abstract void reportProgress(boolean force);
      abstract Runnable ticker();
      protected void onPause() { pauseCallbacks++; }
      protected void onResume() { resumeCallbacks++; }
      protected void onDestroy() { destroyCallbacks++; }
      void hideSystemBars() { barsHidden++; }
    }`
};

try {
  const sources = [];
  const activity = fs.readFileSync(path.join(nativeRoot, "NativePlayerActivity.java"), "utf8").replace(/\r\n/g, "\n");
  const member = (name) => {
    const method = activity.match(new RegExp(`  (?:private|protected) (?:boolean|void|long) ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n  \\}`))?.[0];
    assert(method, `missing production Activity method: ${name}`);
    return method.replace("private ", "final ");
  };
  const ticker = activity.match(/  private final Runnable progressTicker = new Runnable\(\) \{[\s\S]*?\n  \};/)?.[0];
  assert(ticker, "missing production Activity progress ticker");
  const onCreate = activity.match(/  protected void onCreate\([^\n]+\) \{[\s\S]*?\n  \}/)?.[0];
  assert(onCreate, "missing production Activity creation method");
  assert(!onCreate.includes("post(progressTicker)"), "onResume alone must own ticker startup");
  const verifyReceiptWiring = source => {
    const create = source.match(/  protected void onCreate\([^\n]+\) \{[\s\S]*?\n  \}/)?.[0];
    assert(create, "Activity creation method missing");
    assert(source.includes('public static final String EXTRA_PROGRESS_RECEIVER = "progressReceiver";'), "Activity/Plugin Intent key must match the compiled boundary constant");
    assert(create.includes("getParcelableExtra(EXTRA_PROGRESS_RECEIVER)"), "Activity must read the Intent receipt endpoint");
    assert(create.includes("progress = createProgress(progressReceiver, progressUrl, getIntent().getStringExtra(EXTRA_PROGRESS_AUTH_TOKEN))"), "Activity must connect the captured session and receipt writer before playback");
    assert(create.indexOf("progress = createProgress") < create.indexOf("playUrl("), "receipt writer must exist before player startup");
  };
  verifyReceiptWiring(activity);
  for (const [name, before, after] of [
    ["Intent key disconnected", 'EXTRA_PROGRESS_RECEIVER = "progressReceiver"', 'EXTRA_PROGRESS_RECEIVER = "differentKey"'],
    ["onCreate receipt removed", "getParcelableExtra(EXTRA_PROGRESS_RECEIVER)", "getParcelableExtra(\"differentKey\")"],
    ["onCreate writer disconnected", "progress = createProgress(progressReceiver, progressUrl, getIntent().getStringExtra(EXTRA_PROGRESS_AUTH_TOKEN))", "progress = null"]
  ]) {
    assert(activity.includes(before), `wiring mutant anchor missing: ${name}`);
    assert.throws(() => verifyReceiptWiring(activity.replace(before, after)), assert.AssertionError, `wiring mutant must be rejected: ${name}`);
  }
  const createProgress = activity.match(/  private static NativePlaybackProgress createProgress\([^)]*\) \{[\s\S]*?\n  \}/)?.[0];
  assert(createProgress, "static Activity receipt factory must not capture the Activity");
  Object.assign(doubles, commitDoubles);
  doubles["local/fanhao/library/NativeVideoProgressHost.java"] = `package local.fanhao.library;
    import android.app.Activity;
    import android.os.ResultReceiver;
    import androidx.media3.common.Player;
    final class NativeVideoProgressHost extends NativeVideoProgressHostBase {
      final NativePlaybackProgress progress;
      NativeVideoProgressHost(NativePlaybackProgress progress) { this.progress = progress; }
      @Override Runnable ticker() { return progressTicker; }
      ${ticker}
      ${member("reportProgress")}
      ${member("onPause")}
      ${member("onResume")}
      ${member("onDestroy")}
      ${member("secondsToMs")}
      ${member("hasText")}
      ${createProgress.replace("private static", "static")}
    }`;
  for (const [relative, source] of Object.entries(doubles)) {
    const target = path.join(tempRoot, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, source);
    sources.push(target);
  }
  sources.push(path.join(nativeRoot, "NativePlaybackProgress.java"));
  sources.push(path.join(nativeRoot, "ServerAuthSession.java"));
  sources.push(path.join(nativeRoot, "FanHaoPlayerPlugin.java"));
  sources.push(path.join(root, "tools/fixtures/LegacyNativeVideoProgressHost.java"));
  sources.push(path.join(root, "tools/fixtures/NativeVideoProgressHarness.java"));
  sources.push(path.join(root, "tools/fixtures/NativeVideoProgressCommitHarness.java"));
  const compiled = spawnSync(executable("javac"), ["-encoding", "UTF-8", "-d", tempRoot, ...sources], {
    cwd: root, encoding: "utf8", timeout: 30000
  });
  assert.equal(compiled.status, 0, `native video progress harness must compile:\n${compiled.error || compiled.stderr || compiled.stdout}`);
  const executed = spawnSync(executable("java"), ["-cp", tempRoot, "local.fanhao.library.NativeVideoProgressHarness"], {
    cwd: root, encoding: "utf8", timeout: 30000
  });
  assert.equal(executed.status, 0, `native video progress harness must pass:\n${executed.error || ""}\n${executed.stderr}\n${executed.stdout}`);
  process.stdout.write(executed.stdout);
  const committed = spawnSync(executable("java"), ["-cp", tempRoot, "local.fanhao.library.NativeVideoProgressCommitHarness"], {
    cwd: root, encoding: "utf8", timeout: 30000
  });
  assert.equal(committed.status, 0, `native progress receipt harness must pass:\n${committed.error || ""}\n${committed.stderr}\n${committed.stdout}`);
  process.stdout.write(committed.stdout);
  const production = {
    helper: fs.readFileSync(path.join(nativeRoot, "NativePlaybackProgress.java"), "utf8").replace(/\r\n/g, "\n"),
    plugin: fs.readFileSync(path.join(nativeRoot, "FanHaoPlayerPlugin.java"), "utf8").replace(/\r\n/g, "\n"),
    activity: doubles["local/fanhao/library/NativeVideoProgressHost.java"]
  };
  const mutants = [
    ["HTTP status ignored", "helper", 'if (status < 200 || status >= 300) throw new IOException("Progress commit rejected: HTTP " + status);', "", "HTTP status 400 controls acknowledgement"],
    ["redirect followed", "helper", "connection.setInstanceFollowRedirects(false);", "connection.setInstanceFollowRedirects(true);", "redirect could acknowledge another endpoint"],
    ["successful send has no receipt", "helper", "if (committed != null) committed.onCommitted(snapshot);", "", "HTTP status 200 controls acknowledgement"],
    ["failed send still acknowledges", "helper", "continue;\n      }\n      try {", "\n      }\n      try {", "HTTP status 400 controls acknowledgement"],
    ["old session gate removed", "plugin", " || plugin.activeProgressReceiver != this", "", "new launch invalidates a queued older session receipt"],
    ["receipt retained without listener", "plugin", 'notifyListeners("progressCommitted", receipt, false)', 'notifyListeners("progressCommitted", receipt, true)', "receipts must not be retained"],
    ["Capacitor serialization bypassed", "plugin", "plugin.execute(this::deliver);", "deliver();", "notify must run on Capacitor task handler"],
    ["failed launch replaces current receiver", "plugin", "getActivity().startActivity(intent);\n      activeProgressReceiver = receiver;", "activeProgressReceiver = receiver;\n      getActivity().startActivity(intent);", "failed launch preserves previous active receiver"],
    ["destroy does not invalidate receiver", "plugin", "destroyed = true;\n    activeProgressReceiver = null;", "", "destroy invalidates pending and later receipt delivery"],
    ["source receipt fence removed", "activity", "receiver != null && snapshot.url.equals(expectedUrl)", "receiver != null", "Activity factory cannot acknowledge a different source URL"],
    ["receipt identity spoofed", "plugin", 'receipt.put("videoId", videoId);', 'receipt.put("videoId", "foreign-video");', "receipt identity mismatch"],
    ["listener failure strands final snapshot", "helper", "// An unavailable UI/bridge must not interrupt accepted final delivery.", "throw ignored;", "listener failure cannot strand a newer accepted final position"]
  ];
  for (const [index, [name, kind, before, after, expected]] of mutants.entries()) {
    assert(production[kind].includes(before), `behavior mutant anchor missing: ${name}`);
    const folder = path.join(tempRoot, `receipt-mutant-${index}`);
    const fileName = kind === "helper" ? "NativePlaybackProgress" : kind === "plugin" ? "FanHaoPlayerPlugin" : "NativeVideoProgressHost";
    const sourcePath = path.join(folder, "local/fanhao/library", `${fileName}.java`);
    fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
    fs.writeFileSync(sourcePath, production[kind].replace(before, after));
    const compiledMutant = spawnSync(executable("javac"), ["-encoding", "UTF-8", "-cp", tempRoot, "-d", folder, sourcePath], { cwd: root, encoding: "utf8", timeout: 30000 });
    assert.equal(compiledMutant.status, 0, `mutant must compile, not fail by syntax: ${name}\n${compiledMutant.stderr}`);
    const rejected = spawnSync(executable("java"), ["-cp", `${folder}${path.delimiter}${tempRoot}`, "local.fanhao.library.NativeVideoProgressCommitHarness"], { cwd: root, encoding: "utf8", timeout: 15000 });
    assert.equal(rejected.status, 1, `behavior mutant must exit on an assertion, not timeout/crash: ${name}\n${rejected.error || ""}\n${rejected.stderr}`);
    assert.match(rejected.stderr, /AssertionError/, `mutant must fail a safety assertion: ${name}`);
    assert(rejected.stderr.includes(expected), `mutant missed its specific safety oracle: ${name}\n${rejected.stderr}`);
  }
  console.log(`native-video-progress-commit: ${mutants.length} compiled behavior mutants and 3 Activity wiring mutants rejected`);
} finally {
  // Verify the exact disposable child before recursive cleanup, including on Windows.
  const resolvedTemp = fs.realpathSync(tempRoot);
  assert.equal(path.dirname(resolvedTemp), fs.realpathSync(os.tmpdir()));
  assert(path.basename(resolvedTemp).startsWith("fanhao-native-video-progress-"));
  if (process.platform === "win32") {
    const cleaned = spawnSync("powershell.exe", ["-NoProfile", "-Command",
      `Remove-Item -LiteralPath '${resolvedTemp.replace(/'/g, "''")}' -Recurse -Force`
    ], { encoding: "utf8", timeout: 10000 });
    assert.equal(cleaned.status, 0, `temporary fixture cleanup failed:\n${cleaned.error || cleaned.stderr}`);
  } else {
    fs.rmSync(resolvedTemp, { recursive: true, force: true });
  }
}
