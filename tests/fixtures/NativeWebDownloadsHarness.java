package local.fanhao.library;

import android.Manifest;
import android.app.AlertDialog;
import android.app.DownloadManager;
import android.content.pm.PackageManager;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.widget.Toast;
import androidx.activity.result.ActivityResultRegistry;
import androidx.lifecycle.SavedStateHandle;
import androidx.lifecycle.ViewModelStore;
import java.lang.reflect.Field;
import java.lang.reflect.Modifier;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Objects;

/** Runs production classes on deterministic platform-boundary doubles, without Android/Gradle/network. */
public final class NativeWebDownloadsHarness {
  private static final String URL = "https://download.test/original.txt?filename=query.txt";
  private static final String OTHER_URL = "https://download.test/second.txt";
  private static final String PENDING = "webDownload.pending";
  private static final String SUCCESS = "已加入下载队列";
  private static final List<String> failures = new ArrayList<>();
  private static int cases, reproducedLegacyBugs;

  public static void main(String[] args) {
    check("frozen old listener reproduces ungated API 28 SecurityException", () -> {
      LegacyNativeWebDownloadsHost old = new LegacyNativeWebDownloadsHost();
      Build.VERSION.SDK_INT = 28;
      DownloadManager.destinationFailure = new SecurityException("WRITE_EXTERNAL_STORAGE denied");
      boolean escaped = false;
      try { old.request(URL, "Agent", null, "text/plain"); }
      catch (SecurityException expected) { escaped = true; }
      require(escaped && old.testRegistry.launches == 0, "baseline no longer reproduces ungated exception");
      reproducedLegacyBugs++;
    });
    check("frozen old listener reproduces false success for rejected queue ID", () -> {
      LegacyNativeWebDownloadsHost old = new LegacyNativeWebDownloadsHost();
      old.testManager.nextId = 0;
      old.request(URL, "Agent", null, "text/plain");
      require(Toast.messages.contains(SUCCESS), "baseline no longer reproduces false success");
      reproducedLegacyBugs++;
    });

    for (int api : new int[] {24, 28}) {
      check("API " + api + " denied permission gates destination and grants exactly once", () -> {
        Activity host = activity(api, false);
        DownloadManager.destinationFailure = new SecurityException("denied before callback");
        host.request(URL);
        equal(host.testRegistry.launches, 1, "system permission prompt");
        equal(host.testRegistry.lastPermission, Manifest.permission.WRITE_EXTERNAL_STORAGE, "requested permission");
        equal(host.testManager.enqueueCalls, 0, "must not enqueue before grant");
        equal(successes(), 0L, "must not toast success before grant");
        require(host.testSavedStateHandle.get(PENDING) instanceof Bundle, "pending descriptor must be saved as Bundle");
        DownloadManager.destinationFailure = null;
        host.permissionResult(true, true);
        host.permissionResult(true, true);
        equal(host.testManager.enqueueCalls, 1, "duplicate permission callback enqueued twice");
        equal(successes(), 1L, "one positive queue ID gives one success");
        require(host.testSavedStateHandle.get(PENDING) == null, "successful result left pending intent");
      });
      check("API " + api + " already granted skips permission UI", () -> {
        Activity host = activity(api, true);
        host.request(URL);
        equal(host.testRegistry.launches, 0, "granted must not prompt");
        equal(host.testManager.enqueueCalls, 1, "granted download enqueue");
      });
    }
    for (int api : new int[] {29, 30, 35}) {
      check("API " + api + " never requests legacy storage permission", () -> {
        Activity host = activity(api, false);
        host.testRationale = true;
        host.request(URL);
        equal(host.testRegistry.launches, 0, "API 29+ must not prompt");
        equal(AlertDialog.shown.size(), 0, "API 29+ must not explain obsolete permission");
        equal(host.testManager.enqueueCalls, 1, "API 29+ enqueue");
      });
    }
    for (boolean permanent : new boolean[] {false, true}) {
      check((permanent ? "permanent" : "ordinary") + " denial consumes intent without auto-retry", () -> {
        Activity host = activity(28, false);
        host.request(URL);
        host.testRationale = !permanent;
        host.permissionResult(false, false);
        host.onResume();
        equal(host.testManager.enqueueCalls, 0, "denial must not enqueue");
        equal(host.testRegistry.launches, 1, "denial must not trigger prompt loop");
        equal(successes(), 0L, "denial must not report success");
        require(host.testSavedStateHandle.get(PENDING) == null, "denial left pending request");
        require(!Toast.messages.isEmpty(), "denial must give feedback");
        host.permissionResult(true, true);
        equal(host.testManager.enqueueCalls, 0, "late grant resurrected denied request");
      });
    }
    check("grant Boolean cannot bypass a still-denied current permission", () -> {
      Activity host = activity(28, false);
      host.request(URL);
      host.permissionResult(true, false);
      equal(host.testManager.enqueueCalls, 0, "grant callback must re-check current permission");
      require(host.testSavedStateHandle.get(PENDING) == null, "failed grant left pending");
      equal(successes(), 0L, "false success on stale grant");
    });
    check("synchronous permission callback observes pre-saved pending metadata", () -> {
      Activity host = activity(28, false);
      host.testRegistry.onLaunch = () -> host.permissionResult(true, true);
      host.request(URL);
      equal(host.testRegistry.launches, 1, "synchronous launch count");
      equal(host.testManager.enqueueCalls, 1, "synchronous grant lost pending request");
      require(host.testSavedStateHandle.get(PENDING) == null, "sync grant left pending state");
      host.permissionResult(true, true);
      equal(host.testManager.enqueueCalls, 1, "duplicate synchronous delivery");
    });
    check("duplicate and different requests cannot replace a permission-pending download", () -> {
      Activity host = activity(28, false);
      host.request(URL);
      host.request(URL);
      host.request(OTHER_URL);
      equal(host.testRegistry.launches, 1, "busy requests launched extra dialogs");
      host.permissionResult(true, true);
      equal(host.testManager.enqueueCalls, 1, "busy requests enqueued extra downloads");
      equal(host.testManager.requests.get(0).uri.toString(), URL, "busy request replaced original URL");
    });
    check("pending clears before enqueue and reentrant enqueue/request callbacks are blocked", () -> {
      Activity host = activity(28, false);
      host.request(URL);
      host.testManager.onEnqueue = () -> {
        require(host.testSavedStateHandle.get(PENDING) == null, "pending must be consumed before external enqueue");
        host.permissionResult(true, true);
        host.request(OTHER_URL);
      };
      host.permissionResult(true, true);
      equal(host.testManager.enqueueCalls, 1, "reentrant external callback duplicated work");
      equal(successes(), 1L, "reentrant callback duplicated success");
    });
    check("launch exception clears pending and a later explicit click can retry", () -> {
      Activity host = activity(28, false);
      host.testRegistry.launchFailure = new IllegalStateException("activity launch failed");
      host.request(URL);
      require(host.testSavedStateHandle.get(PENDING) == null, "launch error left request stuck");
      equal(successes(), 0L, "launch error reported success");
      host.testRegistry.launchFailure = null;
      host.request(OTHER_URL);
      host.permissionResult(true, true);
      equal(host.testManager.enqueueCalls, 1, "retry after launch error failed");
      equal(host.testManager.requests.get(0).uri.toString(), OTHER_URL, "retry resurrected prior request");
    });

    check("model uses no retained Activity, launcher, Host, callback or WebView references", () -> {
      for (Field field : NativeWebDownloads.class.getDeclaredFields()) {
        if (Modifier.isStatic(field.getModifiers())) continue;
        require(field.getType().isPrimitive() || field.getType() == SavedStateHandle.class,
          "unsafe retained model field: " + field);
      }
      require(Modifier.isFinal(NativeWebDownloadRequest.class.getModifiers()), "descriptor class must be final");
      for (Field field : NativeWebDownloadRequest.class.getDeclaredFields()) {
        if (!Modifier.isStatic(field.getModifiers())) require(Modifier.isFinal(field.getModifiers()), "mutable metadata field: " + field);
      }
    });
    check("unavailable callback does not consume intent; a new live Host can complete it", () -> {
      ModelFixture f = new ModelFixture();
      f.request(URL);
      f.host.available = false;
      f.host.needsPermission = false;
      f.model.onPermissionResult(true, f.host);
      require(f.state.get(PENDING) != null, "unavailable old host consumed pending request");
      equal(f.host.enqueued.size(), 0, "destroyed host received enqueue");
      FakeHost replacement = new FakeHost();
      replacement.needsPermission = false;
      f.model.onPermissionResult(true, replacement);
      equal(replacement.enqueued.size(), 1, "replacement host did not finish retained request");
      equal(f.host.enqueued.size(), 0, "old host received replacement callback");
    });
    check("configuration recreation rebinds registry result to retained ViewModel and new Activity", () -> {
      Activity old = activity(28, false);
      old.request(URL);
      ViewModelStore retained = old.testViewModelStore;
      ActivityResultRegistry registry = old.testRegistry;
      String key = old.key();
      old.testChangingConfiguration = true;
      old.stop();
      old.onDestroy();
      registry.testDeliver(key, true);
      Activity next = new Activity();
      next.testRegistry = registry;
      next.testViewModelStore = retained;
      next.testPermission = PackageManager.PERMISSION_GRANTED;
      next.create();
      equal(next.key(), key, "registry key must remain stable across recreation");
      equal(registry.launches, 1, "onCreate repeated system permission launch");
      equal(next.testManager.enqueueCalls, 0, "result must wait for STARTED owner");
      next.start();
      next.onResume();
      equal(next.testManager.enqueueCalls, 1, "recreated Activity lost permission result");
      equal(old.testManager.enqueueCalls, 0, "destroyed Activity received enqueue");
      require(Toast.owners.stream().noneMatch(owner -> owner == old), "destroyed Activity received UI work");
      registry.testDeliver(key, true);
      equal(next.testManager.enqueueCalls, 1, "recreated owner duplicate result");
    });
    check("saved-state recreation restores intent but starts only on system result", () -> {
      Activity old = activity(28, false);
      old.request(URL);
      Map<String,Object> snapshot = old.testSavedStateHandle.testSnapshot();
      String key = old.key();
      old.onDestroy();
      Activity next = new Activity();
      next.testSavedStateHandle = new SavedStateHandle(snapshot);
      next.testPermission = PackageManager.PERMISSION_GRANTED;
      next.create();
      next.start();
      next.onResume();
      equal(next.key(), key, "process recreation changed registry key");
      equal(next.testRegistry.launches, 0, "restore automatically opened permission dialog");
      equal(next.testManager.enqueueCalls, 0, "restore automatically started download");
      next.permissionResult(true, true);
      equal(next.testManager.enqueueCalls, 1, "restored system result lost saved metadata");
      next.permissionResult(true, true);
      equal(next.testManager.enqueueCalls, 1, "restored result enqueued twice");
    });
    check("pending system result delivered before recreation STARTED is retained by owner-aware registration", () -> {
      ModelFixture f = new ModelFixture();
      f.request(URL);
      Activity next = new Activity();
      next.testSavedStateHandle = new SavedStateHandle(f.state.testSnapshot());
      next.testPermission = PackageManager.PERMISSION_GRANTED;
      next.testRegistry.pendingResults.put("local.fanhao.library.web-download.storage", true);
      next.create();
      equal(next.testManager.enqueueCalls, 0, "onCreate delivered into unavailable host");
      next.start();
      equal(next.testManager.enqueueCalls, 1, "STARTED failed to deliver restored registry result");
      equal(next.testRegistry.launches, 0, "pending result caused new permission launch");
    });
    check("ViewModel clear cancels intent and suppresses all late host calls", () -> {
      ModelFixture f = new ModelFixture();
      f.request(URL);
      f.model.testClear();
      require(f.state.get(PENDING) == null, "onCleared left pending data");
      f.host.needsPermission = false;
      f.model.onPermissionResult(true, f.host);
      f.model.onHostReady(f.host);
      f.model.request(OTHER_URL, "", null, null, f.host);
      equal(f.host.enqueued.size(), 0, "cleared ViewModel accepted late work");
      equal(f.host.prompts, 1, "cleared ViewModel reopened permission");
    });
    check("stopped, finishing, and destroyed Activity listeners do no UI or download work", () -> {
      for (int condition = 0; condition < 3; condition++) {
        Activity host = activity(28, true);
        if (condition == 0) host.stop();
        if (condition == 1) host.testFinishing = true;
        if (condition == 2) host.onDestroy();
        host.request(URL);
        equal(host.testManager.enqueueCalls, 0, "unavailable Activity accepted download");
        equal(host.testRegistry.launches, 0, "unavailable Activity prompted");
      }
      equal(Toast.messages.size(), 0, "unavailable Activity showed feedback");
    });
    check("default saved-state factory is used but external Intent extras cannot seed a pending download", () -> {
      Activity host = new Activity();
      host.testIntentDefaults.putBundle(PENDING, NativeWebDownloadRequest.create(URL, "", null, null).toBundle());
      host.testIntentDefaults.putBoolean("webDownload.explanation", true);
      host.create();
      equal(host.testDefaultFactoryUses, 1, "must use default SavedState-capable factory");
      require(host.testReceivedDefaultArgs != null && host.testReceivedDefaultArgs.keySet().isEmpty(),
        "external Intent default args flowed into retained download state");
      host.start();
      host.onResume();
      host.permissionResult(true, true);
      equal(host.testManager.enqueueCalls, 0, "external extras caused unsolicited download");
      equal(AlertDialog.shown.size(), 0, "external extras caused unsolicited rationale");
      equal(host.testRegistry.launches, 0, "external extras caused unsolicited permission prompt");
    });
    check("permission grant without a pending user request never starts work", () -> {
      Activity host = activity(28, false);
      host.permissionResult(true, true);
      host.permissionResult(false, false);
      equal(host.testManager.enqueueCalls, 0, "unrelated result created download");
      equal(host.testRegistry.launches, 0, "unrelated result launched permission");
      equal(Toast.messages.size(), 0, "unrelated result produced UI");
    });

    check("rationale appears before a repeated request and confirmation launches exactly once", () -> {
      Activity host = activity(28, false);
      host.testRationale = true;
      host.request(URL);
      equal(AlertDialog.shown.size(), 1, "rationale not displayed");
      equal(host.testRegistry.launches, 0, "system permission launched before confirmation");
      host.onResume();
      host.request(OTHER_URL);
      equal(AlertDialog.shown.size(), 1, "duplicate rationale dialog");
      AlertDialog dialog = lastDialog();
      dialog.testPositive();
      dialog.testPositive();
      equal(host.testRegistry.launches, 1, "duplicate rationale confirmation launched twice");
      host.permissionResult(true, true);
      equal(host.testManager.requests.get(0).uri.toString(), URL, "rationale busy request replaced original");
    });
    for (boolean outsideCancel : new boolean[] {false, true}) {
      check("rationale " + (outsideCancel ? "back/outside" : "negative button") + " cancellation consumes request", () -> {
        Activity host = activity(28, false);
        host.testRationale = true;
        host.request(URL);
        if (outsideCancel) lastDialog().testCancel(); else lastDialog().testNegative();
        equal(host.testRegistry.launches, 0, "cancel launched system permission");
        require(host.testSavedStateHandle.get(PENDING) == null, "cancel retained intent");
        host.permissionResult(true, true);
        equal(host.testManager.enqueueCalls, 0, "cancelled rationale replayed on late result");
        host.onResume();
        equal(AlertDialog.shown.size(), 1, "cancelled rationale redisplayed");
      });
    }
    check("permission result cannot bypass an unconfirmed rationale", () -> {
      Activity host = activity(28, false);
      host.testRationale = true;
      host.request(URL);
      host.permissionResult(true, true);
      equal(host.testManager.enqueueCalls, 0, "unconfirmed rationale was bypassed");
      require(host.testSavedStateHandle.get(PENDING) != null, "unconfirmed intent was consumed");
      lastDialog().testPositive();
      host.permissionResult(true, true);
      equal(host.testManager.enqueueCalls, 1, "confirmed rationale failed to enqueue");
    });
    for (boolean processRecreated : new boolean[] {false, true}) {
      check("rationale survives " + (processRecreated ? "saved-state" : "configuration") + " recreation without automatic launch", () -> {
        Activity old = activity(28, false);
        old.testRationale = true;
        old.request(URL);
        AlertDialog firstDialog = lastDialog();
        Map<String,Object> snapshot = old.testSavedStateHandle.testSnapshot();
        old.testChangingConfiguration = !processRecreated;
        old.onDestroy();
        require(!firstDialog.isShowing(), "destroyed Activity retained dialog window");
        Activity next = new Activity();
        next.testRationale = true;
        if (processRecreated) next.testSavedStateHandle = new SavedStateHandle(snapshot);
        else next.testViewModelStore = old.testViewModelStore;
        next.create();
        next.start();
        next.onResume();
        equal(AlertDialog.shown.size(), 2, "rationale intent not restored to current Activity");
        equal(next.testRegistry.launches, 0, "restored rationale auto-launched OS dialog");
        equal(next.testManager.enqueueCalls, 0, "restored rationale auto-enqueued");
        require(lastDialog().owner == next, "restored rationale bound to stale Activity");
        firstDialog.testPositive();
        equal(old.testRegistry.launches, 0, "stale dialog callback launched from destroyed Activity");
        equal(next.testRegistry.launches, 0, "stale dialog callback consumed current confirmation");
        lastDialog().testPositive();
        equal(next.testRegistry.launches, 1, "restored rationale confirmation");
        next.permissionResult(true, true);
        equal(next.testManager.enqueueCalls, 1, "restored rationale grant");
        equal(old.testManager.enqueueCalls, 0, "old rationale host enqueued");
      });
    }
    check("rationale show failure clears pending and retry can show a fresh dialog", () -> {
      Activity host = activity(28, false);
      host.testRationale = true;
      AlertDialog.showFailure = new IllegalStateException("bad window token");
      host.request(URL);
      require(host.testSavedStateHandle.get(PENDING) == null, "failed rationale left pending");
      AlertDialog.showFailure = null;
      host.request(OTHER_URL);
      equal(AlertDialog.shown.size(), 1, "failed rationale poisoned next dialog");
      lastDialog().testPositive();
      host.permissionResult(true, true);
      equal(host.testManager.enqueueCalls, 1, "rationale failure prevented explicit retry");
    });

    String[] invalidUrls = {null, "", "file:///sdcard/private.txt", "content://provider/document/1",
      "javascript:alert(1)", "data:text/plain,hello", "blob:https://download.test/id", "ftp://download.test/file",
      "//download.test/file", "http:///missing-host", "https://", "https://user:password@download.test/file",
      "https://user@download.test/file", "https://@download.test/file"};
    for (String url : invalidUrls) {
      check("invalid URI rejected before permission: " + url, () -> {
        Activity host = activity(28, false);
        host.request(url);
        equal(host.testRegistry.launches, 0, "invalid URI opened permission dialog");
        equal(host.testManager.enqueueCalls, 0, "invalid URI enqueued");
        require(host.testSavedStateHandle.get(PENDING) == null, "invalid URI persisted");
        equal(successes(), 0L, "invalid URI reported success");
      });
    }
    check("uppercase HTTP(S) scheme normalizes before real DownloadManager request", () -> {
      Activity host = activity(29, false);
      host.request("HTTPS://download.test/file.txt");
      equal(host.testManager.enqueueCalls, 1, "uppercase HTTP scheme failed");
      equal(host.testManager.requests.get(0).uri.getScheme(), "https", "scheme not normalized");
    });
    check("content-disposition UTF-8 filename takes priority over plain header, query and path", () -> {
      metadata("attachment; filename=\"fallback.txt\"; filename*=UTF-8''%E6%B5%8B%E8%AF%95.txt", "测试.txt");
    });
    check("quoted content-disposition filename takes priority over query", () -> metadata("attachment; filename=\"quoted name.txt\"", "quoted name.txt"));
    check("bare content-disposition filename takes priority over query", () -> metadata("attachment; filename=bare.txt; size=12", "bare.txt"));
    check("malformed encoded filename safely falls back without crash", () -> metadata("attachment; filename*=UTF-8''bad%ZZ.txt", "bad%ZZ.txt"));
    check("filename query parameter remains supported", () -> metadata(null, "query.txt"));
    check("URL path remains filename fallback", () -> {
      NativeWebDownloadRequest request = NativeWebDownloadRequest.create("https://download.test/path-name.txt", "", null, "text/plain");
      equal(request.fileName, "path-name.txt", "path fallback");
    });
    check("forbidden filename path/control characters are sanitized", () -> {
      String unsafe = "../folder\\bad:name\r\n\t.txt";
      NativeWebDownloadRequest request = NativeWebDownloadRequest.create(URL, "", "attachment; filename=\"" + unsafe + "\"", "text/plain");
      require(!request.fileName.matches(".*[\\\\/:*?\"<>|\\p{Cntrl}].*"), "unsafe filename survived sanitization");
      require(!request.fileName.isEmpty(), "sanitization yielded empty destination");
    });
    for (String special : new String[] {".", ".."}) {
      check("special filename " + special + " cannot target a directory", () -> {
        equal(NativeWebDownloadRequest.create(URL, "", "filename=\"" + special + "\"", null).fileName,
          "download.txt", "special filename fallback");
      });
    }
    check("null/empty metadata uses MIME default and does not invent a User-Agent header", () -> {
      Activity host = activity(29, false);
      host.request(URL, null, null, null);
      DownloadManager.Request request = host.testManager.requests.get(0);
      equal(request.mimeType, "application/octet-stream", "MIME fallback");
      require(request.headers.isEmpty(), "null user agent must omit header");
      host.request(URL, "", null, "");
      equal(host.testManager.requests.get(1).mimeType, "application/octet-stream", "empty MIME fallback");
      require(host.testManager.requests.get(1).headers.isEmpty(), "empty user agent must omit header");
    });
    check("descriptor Bundle round-trip preserves metadata without object aliasing", () -> {
      NativeWebDownloadRequest original = NativeWebDownloadRequest.create(URL, "Roundtrip Agent", "filename=\"roundtrip.txt\"", "text/plain");
      Bundle bundle = original.toBundle();
      NativeWebDownloadRequest restored = NativeWebDownloadRequest.fromBundle(bundle);
      equal(restored.uri.toString(), original.uri.toString(), "restored URI");
      equal(restored.userAgent, original.userAgent, "restored user agent");
      equal(restored.fileName, original.fileName, "restored filename");
      equal(restored.mimeType, original.mimeType, "restored MIME");
      bundle.putString("fileName", "modified.txt");
      equal(original.fileName, "roundtrip.txt", "Bundle mutation changed immutable request");
      equal(restored.fileName, "roundtrip.txt", "Bundle mutation changed restored request");
    });
    check("tampered restored URI is rejected and malformed saved-state cannot replay", () -> {
      Bundle bad = NativeWebDownloadRequest.create(URL, "", null, null).toBundle();
      bad.putString("url", "file:///private");
      for (Object invalid : new Object[] {bad, "not a request Bundle", new Bundle()}) {
        SavedStateHandle state = new SavedStateHandle();
        state.set(PENDING, invalid);
        NativeWebDownloads model = new NativeWebDownloads(state);
        FakeHost host = new FakeHost();
        host.needsPermission = false;
        model.onPermissionResult(true, host);
        equal(host.enqueued.size(), 0, "tampered saved state replayed");
        require(state.get(PENDING) == null, "tampered state not cleared");
      }
    });
    check("restored filename revalidates traversal and empty fallback", () -> {
      Bundle bundle = NativeWebDownloadRequest.create(URL, "", null, null).toBundle();
      bundle.putString("fileName", "..");
      equal(NativeWebDownloadRequest.fromBundle(bundle).fileName, "download.txt", "restored dot-dot");
      bundle.putString("fileName", "   ");
      equal(NativeWebDownloadRequest.fromBundle(bundle).fileName, "download.txt", "restored empty");
    });

    for (String failure : new String[] {"null manager", "request constructor", "destination security", "destination illegal",
        "enqueue security", "enqueue illegal", "enqueue service failure", "header failure", "zero ID", "negative ID"}) {
      check(failure + " is contained and never reports queue success", () -> {
        Activity host = activity(29, false);
        DownloadManager manager = host.testManager;
        switch (failure) {
          case "null manager": host.testManager = null; break;
          case "request constructor": DownloadManager.requestFailure = new IllegalArgumentException("bad request"); break;
          case "destination security": DownloadManager.destinationFailure = new SecurityException("denied"); break;
          case "destination illegal": DownloadManager.destinationFailure = new IllegalArgumentException("bad destination"); break;
          case "enqueue security": manager.enqueueFailure = new SecurityException("revoked"); break;
          case "enqueue illegal": manager.enqueueFailure = new IllegalArgumentException("bad enqueue"); break;
          case "enqueue service failure": manager.enqueueFailure = new IllegalStateException("service unavailable"); break;
          case "header failure": DownloadManager.headerFailure = new IllegalArgumentException("bad header"); break;
          case "zero ID": manager.nextId = 0; break;
          case "negative ID": manager.nextId = -1; break;
        }
        host.request(URL);
        equal(successes(), 0L, failure + " reported success");
        require(!Toast.messages.isEmpty(), failure + " gave no feedback");
        require(host.testSavedStateHandle.get(PENDING) == null, failure + " left pending intent");
      });
    }
    check("permission-revoked enqueue failure consumes pending exactly once", () -> {
      Activity host = activity(28, false);
      host.request(URL);
      host.testManager.enqueueFailure = new SecurityException("permission revoked between check and enqueue");
      host.permissionResult(true, true);
      host.permissionResult(true, true);
      equal(host.testManager.enqueueCalls, 1, "failure replayed accepted descriptor");
      equal(successes(), 0L, "revocation reported success");
      host.testManager.enqueueFailure = null;
      host.request(OTHER_URL);
      equal(host.testManager.enqueueCalls, 2, "explicit retry after enqueue error failed");
      equal(successes(), 1L, "retry should succeed once");
    });
    check("non-positive queue ID never replays automatically and allows a fresh explicit retry", () -> {
      Activity host = activity(28, false);
      host.request(URL);
      host.testManager.nextId = -1;
      host.permissionResult(true, true);
      host.permissionResult(true, true);
      host.onResume();
      equal(host.testManager.enqueueCalls, 1, "rejected queue ID was replayed");
      equal(successes(), 0L, "rejected queue ID reported success");
      host.testManager.nextId = 104;
      host.request(OTHER_URL);
      equal(host.testManager.enqueueCalls, 2, "fresh retry did not enqueue");
      equal(successes(), 1L, "fresh retry did not report accepted ID");
    });

    require(reproducedLegacyBugs == 2, "both old-code bug witnesses must execute");
    if (!failures.isEmpty()) {
      for (String failure : failures) System.err.println("FAIL " + failure);
      throw new AssertionError(failures.size() + " / " + cases + " native WebView download cases failed");
    }
    System.out.println("Native WebView downloads: " + cases + " passed; 2 frozen legacy regressions reproduced.");
  }

  private static void metadata(String disposition, String expectedName) {
    Activity host = activity(29, false);
    host.request(URL, "FixtureAgent/7", disposition, "text/plain; charset=utf-8");
    equal(host.testManager.enqueueCalls, 1, "metadata request enqueue");
    DownloadManager.Request request = host.testManager.requests.get(0);
    equal(request.uri.toString(), URL, "source URI preserved");
    equal(request.headers.get("User-Agent"), "FixtureAgent/7", "User-Agent preserved");
    equal(request.fileName, expectedName, "filename precedence");
    equal(request.title, expectedName, "title uses resolved filename");
    equal(request.description, "FanHao 下载", "description preserved");
    equal(request.mimeType, "text/plain; charset=utf-8", "MIME preserved");
    equal(request.directory, Environment.DIRECTORY_DOWNLOADS, "must use public Downloads");
    equal(request.visibility, DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED, "notification policy");
    equal(successes(), 1L, "accepted queue ID must report success");
  }

  private static Activity activity(int api, boolean permission) {
    Build.VERSION.SDK_INT = api;
    Activity host = new Activity();
    host.testPermission = permission ? PackageManager.PERMISSION_GRANTED : PackageManager.PERMISSION_DENIED;
    host.create();
    host.start();
    host.onResume();
    return host;
  }
  private static AlertDialog lastDialog() { return AlertDialog.shown.get(AlertDialog.shown.size() - 1); }
  private static long successes() { return Toast.messages.stream().filter(SUCCESS::equals).count(); }
  private static void equal(Object actual, Object expected, String message) {
    require(Objects.equals(actual, expected), message + ": expected " + expected + ", got " + actual);
  }
  private static void require(boolean valid, String message) { if (!valid) throw new AssertionError(message); }
  private static void check(String name, Runnable test) {
    cases++;
    DownloadManager.reset();
    AlertDialog.reset();
    Toast.reset();
    Build.VERSION.SDK_INT = 28;
    try { test.run(); }
    catch (Throwable failure) { failures.add(name + ": " + failure); }
  }

  private static final class Activity extends MainActivity {
    void create() { onCreate(null); }
    void start() { super.onStart(); }
    void stop() { super.onStop(); }
    String key() {
      require(!testRegistry.keys.isEmpty(), "production Activity never registered permission callback");
      return testRegistry.keys.get(testRegistry.keys.size() - 1);
    }
    void request(String url) { request(url, "FixtureAgent/7", null, "text/plain"); }
    void request(String url, String agent, String disposition, String mime) {
      require(getBridge().getWebView().testDownloadListener != null, "WebView listener not installed");
      getBridge().getWebView().testDownloadListener.onDownloadStart(url, agent, disposition, mime, 123);
    }
    void permissionResult(boolean granted, boolean currentPermission) {
      testPermission = currentPermission ? PackageManager.PERMISSION_GRANTED : PackageManager.PERMISSION_DENIED;
      testRegistry.testDeliver(key(), granted);
    }
  }
  private static final class ModelFixture {
    final SavedStateHandle state = new SavedStateHandle();
    final NativeWebDownloads model = new NativeWebDownloads(state);
    final FakeHost host = new FakeHost();
    void request(String url) { model.request(url, "FixtureAgent/7", null, "text/plain", host); }
  }
  private static final class FakeHost implements NativeWebDownloads.Host {
    boolean available = true, needsPermission = true, rationale;
    int prompts, explanations;
    final List<NativeWebDownloadRequest> enqueued = new ArrayList<>();
    final List<String> messages = new ArrayList<>();
    public boolean isAvailable() { return available; }
    public boolean needsStoragePermission() { return needsPermission; }
    public boolean shouldExplainStoragePermission() { return rationale; }
    public void showStoragePermissionRationale() { require(available, "stale host explanation"); explanations++; }
    public void requestStoragePermission() { require(available, "stale host launch"); prompts++; }
    public long enqueue(NativeWebDownloadRequest request) { require(available, "stale host enqueue"); enqueued.add(request); return 71; }
    public void showMessage(String message) { require(available, "stale host message"); messages.add(message); }
  }
}
