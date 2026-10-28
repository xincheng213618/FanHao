package local.fanhao.library;

import android.app.Activity;
import android.app.ActivityManager;
import android.content.ComponentName;
import android.content.Intent;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;
import androidx.appcompat.app.AppCompatActivity;
import androidx.lifecycle.Lifecycle;
import org.json.JSONObject;
import java.io.File;
import java.lang.ref.WeakReference;
import java.util.HashMap;
import java.util.Map;
import java.util.LinkedHashMap;
import java.util.function.Consumer;
import java.util.function.BooleanSupplier;

/** A saved Main nonce can resume only its own private, parked task session. */
final class NativeShortVideoRecovery {
  static final String STATE_KEY = "local.fanhao.short-video.task-session.v1";
  static final String LAUNCHER_KEY = "local.fanhao.short-video.task-recovery.v1";
  private static final String NONCE = "local.fanhao.shortVideo.session";
  private static final String CLAIM = "local.fanhao.shortVideo.claim";
  private static final String OWNER = "local.fanhao.shortVideo.owner";
  private static final String TAG = "NativeShortVideoRecovery";
  private static final Map<Integer, WeakReference<NativeOwner>> LIVE = new LinkedHashMap<>();
  private static final Map<Integer, String> DISABLED = new LinkedHashMap<>();
  interface Results { void completed(String expectedBase, int resultCode, Intent data); }
  private AppCompatActivity activity;
  private Consumer<Intent> launcher;
  private Results results;
  private BooleanSupplier externalBlocked;
  private final Handler handler = new Handler(Looper.getMainLooper());
  private final NativeShortVideoSession sessions;
  private String nonce = "";
  private NativeShortVideoSession.Record flight;
  private Runnable pending;
  private long generation;
  private boolean started, initialIntentSeen, resumed, destroyed, attempted;

  NativeShortVideoRecovery(AppCompatActivity activity, Consumer<Intent> launcher, Results results) {
    this(activity, launcher, results, () -> false);
  }
  NativeShortVideoRecovery(AppCompatActivity activity, Consumer<Intent> launcher, Results results, BooleanSupplier externalBlocked) {
    this.activity = activity; this.launcher = launcher; this.results = results; this.externalBlocked = externalBlocked; sessions = store(activity);
  }

  private static NativeShortVideoSession store(Activity activity) {
    return new NativeShortVideoSession(new File(activity.getNoBackupFilesDir(), "short-video-sessions"));
  }
  private static long now() { return System.currentTimeMillis(); }

  void restore(Bundle state) {
    if (state == null || state.getInt("version", -1) != NativeShortVideoSession.VERSION
      || state.getInt("task", -1) != activity.getTaskId()) return;
    String restored = state.getString("nonce", "");
    if (restored.matches("[a-f0-9]{32}") && !disabled(activity.getTaskId(), restored)) nonce = restored;
  }

  Bundle save() {
    Bundle state = new Bundle();
    if (destroyed || nonce.isEmpty()) return state;
    if (disabled(activity.getTaskId(), nonce)) { nonce = ""; return state; }
    try {
      NativeShortVideoSession.Record current = sessions.read(activity.getTaskId(), nonce, now());
      if ("closed".equals(current.phase)) { nonce = ""; return state; }
      state.putInt("version", NativeShortVideoSession.VERSION); state.putInt("task", current.taskId); state.putString("nonce", current.nonce);
    } catch (Exception unavailable) { nonce = ""; }
    return state;
  }

  void fresh(Intent intent) {
    invalidate(true);
    try {
      String bootstrap = bootstrap(intent);
      NativeShortVideoSession.Record record = sessions.begin(activity.getTaskId(), scope(intent), bootstrap, now());
      nonce = record.nonce; intent.putExtra(NONCE, nonce);
    } catch (Exception unavailable) {
      // Disk/session capacity is optional. A new explicit playback still launches normally.
      intent.removeExtra(NONCE); Log.w(TAG, "task recovery unavailable for new playback", unavailable);
    }
  }

  void failedOpen(Intent intent) {
    String opened = intent.getStringExtra(NONCE);
    if (opened != null && opened.equals(nonce)) invalidate(true);
  }
  void started() { started = true; }
  boolean newIntent(Intent intent) {
    if (!started && !initialIntentSeen) {
      initialIntentSeen = true;
      if (intent != null && (intent.getAction() == null || Intent.ACTION_MAIN.equals(intent.getAction()))
        && (intent.getCategories() == null || intent.getCategories().isEmpty() || (intent.getCategories().size() == 1 && intent.hasCategory(Intent.CATEGORY_LAUNCHER)))
        && intent.getData() == null && intent.getClipData() == null
        && (intent.getComponent() == null || activity.getComponentName().equals(intent.getComponent()))) return false;
    }
    invalidate(true);
    return true;
  }

  void resumed() {
    resumed = true;
    if (destroyed || attempted || nonce.isEmpty() || pending != null) return;
    final long owner = generation; final String expected = nonce;
    pending = new Runnable() {
      @Override public void run() {
        if (pending != this) return; pending = null;
        if (!current(owner, expected) || aliveNative(activity.getTaskId()) || !topMain()) return;
        attempted = true;
        try {
          NativeShortVideoSession.Record record = sessions.read(activity.getTaskId(), expected, now());
          if (!"parked".equals(record.phase) || record.key.isEmpty()) return;
          // Validate the actual immutable checkpoint before authorizing a new Activity.
          NativeShortVideoCheckpoint.read(new File(activity.getNoBackupFilesDir(), "short-video-checkpoints"), record.scope, record.key, now(), 0L);
          Intent launch = intent(record.bootstrap, activity);
          if (!record.scope.equals(scope(launch)) || !current(owner, expected) || aliveNative(record.taskId) || !topMain()) return;
          NativeShortVideoSession.Record claimed = sessions.claim(record.taskId, expected, record.sequence, now());
          if (claimed == null || !current(owner, expected) || aliveNative(record.taskId) || !topMain()) return;
          flight = claimed;
          launch.putExtra(NONCE, claimed.nonce).putExtra(CLAIM, claimed.claim);
          launcher.accept(launch);
        } catch (Exception failure) {
          // A claim is single-use until a newer Native checkpoint. Never create an auto-launch loop.
          flight = null; Log.w(TAG, "cannot resume native task session", failure);
        }
      }
    };
    handler.post(pending);
  }

  void paused() { resumed = false; cancelPending(); }
  void destroy() { destroyed = true; generation++; cancelPending(); flight = null; activity = null; launcher = null; results = null; externalBlocked = null; }

  void result(int resultCode, Intent data) {
    NativeShortVideoSession.Record expected = flight; flight = null;
    if (destroyed || nonce.isEmpty() || activity == null) return;
    try {
      if (expected == null) {
        // ActivityResultRegistry can restore an already launched recovery after
        // Main was recreated again. Authority comes from the private closed
        // claim and Native's owner tag, never from a result Intent alone.
        NativeShortVideoSession.Record restored = sessions.read(activity.getTaskId(), nonce, now());
        if (resultCode != Activity.RESULT_OK || restored.claim.isEmpty() || !"closed".equals(restored.phase) || !validResult(restored, data)) return;
        expected = restored;
      }
      if (!expected.nonce.equals(nonce)) return;
      NativeShortVideoSession.Record current = sessions.read(expected.taskId, expected.nonce, now());
      if (!current.claim.equals(expected.claim) || (resultCode == Activity.RESULT_OK
        && (!"closed".equals(current.phase) || !validResult(current, data)))) return;
      JSONObject boot = new JSONObject(current.bootstrap);
      String base = NativeShortVideoActionState.serverScope(boot.optString("base", ""));
      if (base.isEmpty()) return;
      results.completed(base, resultCode, data);
      if ("closed".equals(current.phase)) nonce = "";
    } catch (Exception unavailable) { Log.w(TAG, "obsolete task recovery result", unavailable); }
  }

  private boolean current(long owner, String expected) {
    return !destroyed && resumed && generation == owner && expected.equals(nonce) && activity != null
      && !externalBlocked.getAsBoolean() && !disabled(activity.getTaskId(), expected)
      && !activity.isFinishing() && !activity.isDestroyed() && activity.getLifecycle().getCurrentState().isAtLeast(Lifecycle.State.RESUMED);
  }
  private boolean topMain() {
    try {
      ActivityManager manager = (ActivityManager) activity.getSystemService(Activity.ACTIVITY_SERVICE);
      if (manager == null) return false;
      for (ActivityManager.AppTask task : manager.getAppTasks()) {
        ActivityManager.RecentTaskInfo info = task.getTaskInfo();
        if (info.id == activity.getTaskId()) return activity.getComponentName().equals(info.topActivity);
      }
    } catch (RuntimeException unavailable) { return false; }
    return false;
  }
  private void cancelPending() { if (pending != null) handler.removeCallbacks(pending); pending = null; }
  private void invalidate(boolean close) {
    generation++; cancelPending(); attempted = false; flight = null;
    String old = nonce; nonce = "";
    if (close && !old.isEmpty() && activity != null) {
      try { sessions.close(activity.getTaskId(), old, "", now()); }
      catch (Exception unavailable) { sessions.revoke(activity.getTaskId(), old); }
    }
  }

  private static boolean disabled(int task, String nonce) { synchronized (LIVE) { return nonce.equals(DISABLED.get(task)); } }
  private static void disable(int task, String nonce) {
    synchronized (LIVE) {
      DISABLED.remove(task); DISABLED.put(task, nonce);
      while (DISABLED.size() > NativeShortVideoSession.MAX_TASKS) DISABLED.remove(DISABLED.keySet().iterator().next());
    }
  }
  private static void enable(int task, String nonce) { synchronized (LIVE) { if (nonce.equals(DISABLED.get(task))) DISABLED.remove(task); } }

  boolean acceptsSystemResult(Intent data) {
    if (destroyed || nonce.isEmpty() || activity == null) return false;
    try { NativeShortVideoSession.Record record = sessions.read(activity.getTaskId(), nonce, now()); return "closed".equals(record.phase) && validResult(record, data); }
    catch (Exception unavailable) { return false; }
  }

  static final class ResultTicket {
    private final NativeShortVideoSession sessions;
    private final int task;
    private final String nonce, owner, claim;
    ResultTicket(NativeShortVideoSession sessions, NativeShortVideoSession.Record record) {
      this.sessions = sessions; task = record.taskId; nonce = record.nonce; owner = record.owner; claim = record.claim;
    }
    boolean isCurrent() {
      try { NativeShortVideoSession.Record current = sessions.read(task, nonce, now());
        return "closed".equals(current.phase) && owner.equals(current.owner) && claim.equals(current.claim);
      } catch (Exception unavailable) { return false; }
    }
    boolean consume() {
      try { return sessions.consumeResult(task, nonce, owner, claim, now()); }
      catch (Exception unavailable) { return false; }
    }
  }
  ResultTicket ticket(Intent data) {
    if (!acceptsSystemResult(data)) return null;
    try { return new ResultTicket(sessions, sessions.read(activity.getTaskId(), nonce, now())); }
    catch (Exception unavailable) { return null; }
  }

  private static boolean validResult(NativeShortVideoSession.Record record, Intent data) {
    return data != null && record.nonce.equals(data.getStringExtra(NONCE)) && record.owner.equals(data.getStringExtra(OWNER))
      && record.claim.equals(data.getStringExtra(CLAIM));
  }

  static final class NativeOwner {
    private final WeakReference<Activity> activity;
    private final NativeShortVideoSession sessions;
    private final int task;
    private final String nonce, owner, failedNonce;
    private final NativeShortVideoSession.Record attachment;
    private final boolean rejected;
    private boolean destroyed;
    NativeOwner(Activity activity, NativeShortVideoSession.Record attachment, String owner, boolean rejected, String failedNonce) {
      this.activity = new WeakReference<>(activity); this.sessions = store(activity); task = activity.getTaskId();
      this.attachment = attachment; this.nonce = attachment == null ? "" : attachment.nonce; this.owner = owner; this.rejected = rejected; this.failedNonce = failedNonce;
    }
    boolean isRejected() { return rejected; }
    void tagResult(Intent data) {
      if (attachment != null && !rejected && data != null) data.putExtra(NONCE, nonce).putExtra(OWNER, owner).putExtra(CLAIM, attachment.claim);
    }
    Bundle restoreState(Bundle systemState) {
      if (rejected) { Bundle failed = new Bundle(); failed.putInt("shortVideo.checkpoint.version", NativeShortVideoCheckpoint.VERSION);
        failed.putBoolean("shortVideo.checkpoint.failed", true); return failed; }
      if (systemState != null && systemState.containsKey("shortVideo.checkpoint.version")) return systemState;
      if (attachment == null || attachment.claim.isEmpty() || attachment.key.isEmpty()) return systemState;
      Bundle state = new Bundle(); state.putInt("shortVideo.checkpoint.version", NativeShortVideoCheckpoint.VERSION);
      state.putString("shortVideo.checkpoint.key", attachment.key); state.putString("shortVideo.checkpoint.scope", attachment.scope); return state;
    }
    boolean publish(String scope, String key) {
      if (destroyed || nonce.isEmpty() || rejected || !isLive()) return false;
      try { boolean published = sessions.publish(task, nonce, owner, scope, key, now()); if (published) enable(task, nonce); return published; }
      catch (Exception unavailable) { failAuxiliary(); Log.w(TAG, "cannot publish task checkpoint", unavailable); return false; }
    }
    boolean resumed() {
      if (!failedNonce.isEmpty()) return revokeFailed();
      if (destroyed || nonce.isEmpty() || rejected || !isLive()) return false;
      try { return sessions.resume(task, nonce, owner, now()); }
      catch (Exception unavailable) { failAuxiliary(); return false; }
    }
    boolean invalidateCheckpoint() {
      if (!failedNonce.isEmpty()) return revokeFailed();
      if (destroyed || nonce.isEmpty() || rejected || !isLive()) return false;
      try { return sessions.discardCheckpoint(task, nonce, owner, now()); }
      catch (Exception unavailable) { failAuxiliary(); return false; }
    }
    boolean close() {
      if (!failedNonce.isEmpty()) return revokeFailed();
      if (destroyed || nonce.isEmpty() || rejected || !isLive()) return false;
      try { return sessions.close(task, nonce, owner, now()); }
      catch (Exception unavailable) { Log.w(TAG, "cannot close task session", unavailable); return failAuxiliary(); }
    }
    private boolean isLive() { synchronized (LIVE) { WeakReference<NativeOwner> live = LIVE.get(task); return live != null && live.get() == this; } }
    private boolean failAuxiliary() { if (!isLive()) return false; disable(task, nonce); return sessions.revoke(task, nonce, owner); }
    private boolean revokeFailed() {
      if (destroyed || rejected) return false;
      synchronized (LIVE) { WeakReference<NativeOwner> live = LIVE.get(task); if (live == null || live.get() != this) return false; }
      return sessions.revoke(task, failedNonce);
    }
    void destroy() {
      destroyed = true;
      synchronized (LIVE) { WeakReference<NativeOwner> live = LIVE.get(task); if (live != null && live.get() == this) LIVE.remove(task); }
      activity.clear();
    }
  }

  static NativeOwner attach(Activity activity, Bundle systemState) {
    String nonce = activity.getIntent().getStringExtra(NONCE), claim = activity.getIntent().getStringExtra(CLAIM);
    NativeShortVideoSession.Record attached = null; String owner = NativeShortVideoSession.token(), failedNonce = ""; boolean rejected = false;
    if (nonce != null && !nonce.isEmpty()) {
      try {
        NativeShortVideoSession sessions = store(activity);
        NativeShortVideoSession.Record record = sessions.read(activity.getTaskId(), nonce, now());
        if (!record.scope.equals(scope(activity.getIntent()))) throw new NativeShortVideoSession.Obsolete("changed task bootstrap");
        attached = sessions.attach(activity.getTaskId(), nonce, claim == null ? "" : claim, systemState != null, owner, now());
      } catch (Exception unavailable) {
        boolean systemCheckpoint = systemState != null && systemState.containsKey("shortVideo.checkpoint.version");
        rejected = unavailable instanceof NativeShortVideoSession.Obsolete || (!systemCheckpoint && claim != null && !claim.isEmpty());
        if (!rejected) { failedNonce = nonce; disable(activity.getTaskId(), nonce); store(activity).revoke(activity.getTaskId(), nonce); }
        Log.w(TAG, "native task session unavailable", unavailable);
      }
    }
    NativeOwner result = new NativeOwner(activity, attached, owner, rejected, failedNonce);
    if (!rejected) synchronized (LIVE) {
      LIVE.entrySet().removeIf(entry -> entry.getValue().get() == null);
      LIVE.remove(activity.getTaskId()); LIVE.put(activity.getTaskId(), new WeakReference<>(result));
      while (LIVE.size() > NativeShortVideoSession.MAX_TASKS) LIVE.remove(LIVE.keySet().iterator().next());
    }
    return result;
  }

  private static boolean aliveNative(int task) {
    synchronized (LIVE) {
      WeakReference<NativeOwner> reference = LIVE.get(task); NativeOwner owner = reference == null ? null : reference.get();
      Activity activity = owner == null ? null : owner.activity.get();
      if (activity == null || owner.destroyed || activity.isDestroyed() || activity.isFinishing()) { LIVE.remove(task); return false; }
      return true;
    }
  }

  private static String scope(Intent intent) {
    return NativeShortVideoCheckpoint.scope(intent.getStringExtra(NativeShortVideoActivity.EXTRA_BASE_URL), intent.getStringExtra(NativeShortVideoActivity.EXTRA_FEED_URL),
      intent.getStringExtra(NativeShortVideoActivity.EXTRA_VIDEOS_JSON), intent.getStringExtra(NativeShortVideoActivity.EXTRA_START_ID), intent.getIntExtra(NativeShortVideoActivity.EXTRA_START_INDEX, 0));
  }
  private static String bootstrap(Intent intent) throws Exception {
    return new JSONObject().put("base", intent.getStringExtra(NativeShortVideoActivity.EXTRA_BASE_URL)).put("feed", intent.getStringExtra(NativeShortVideoActivity.EXTRA_FEED_URL))
      .put("videos", intent.getStringExtra(NativeShortVideoActivity.EXTRA_VIDEOS_JSON)).put("start", intent.getStringExtra(NativeShortVideoActivity.EXTRA_START_ID))
      .put("index", intent.getIntExtra(NativeShortVideoActivity.EXTRA_START_INDEX, 0)).put("offset", intent.getIntExtra(NativeShortVideoActivity.EXTRA_NEXT_OFFSET, 0))
      .put("cursor", intent.getStringExtra(NativeShortVideoActivity.EXTRA_NEXT_CURSOR)).put("more", intent.getBooleanExtra(NativeShortVideoActivity.EXTRA_HAS_MORE, false))
      .put("author", intent.getBooleanExtra(NativeShortVideoActivity.EXTRA_OPEN_AUTHOR_PANEL, false)).toString();
  }
  private static Intent intent(String text, Activity activity) throws Exception {
    JSONObject row = new JSONObject(text);
    return new Intent(activity, NativeShortVideoActivity.class).putExtra(NativeShortVideoActivity.EXTRA_BASE_URL, row.optString("base", ""))
      .putExtra(NativeShortVideoActivity.EXTRA_FEED_URL, row.optString("feed", "")).putExtra(NativeShortVideoActivity.EXTRA_VIDEOS_JSON, row.getString("videos"))
      .putExtra(NativeShortVideoActivity.EXTRA_START_ID, row.optString("start", "")).putExtra(NativeShortVideoActivity.EXTRA_START_INDEX, row.getInt("index"))
      .putExtra(NativeShortVideoActivity.EXTRA_NEXT_OFFSET, row.getInt("offset")).putExtra(NativeShortVideoActivity.EXTRA_NEXT_CURSOR, row.optString("cursor", ""))
      .putExtra(NativeShortVideoActivity.EXTRA_HAS_MORE, row.getBoolean("more")).putExtra(NativeShortVideoActivity.EXTRA_OPEN_AUTHOR_PANEL, row.getBoolean("author"));
  }
}
