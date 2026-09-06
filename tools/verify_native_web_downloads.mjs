import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const nativeRoot = path.join(root, "android-client/android/app/src/main/java/local/fanhao/library");
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "fanhao-native-web-downloads-"));
const javaHome = String(process.env.JAVA_HOME || "").trim() || "C:\\Program Files\\Android\\openjdk\\jdk-21.0.8";
const executable = (name) => fs.existsSync(path.join(javaHome, "bin", `${name}.exe`))
  ? path.join(javaHome, "bin", `${name}.exe`) : name;

// Compile the complete production MainActivity, ViewModel and immutable descriptor.
// Doubles replace only Android, AndroidX and Capacitor boundaries. In particular,
// the registry delivers pending results only to a STARTED current owner, and the
// saved-state factory preserves descriptors without starting work on restoration.
// This is a deterministic JVM contract regression, not a substitute for device QA:
// Android's actual OS dialog, DownloadManager and framework lifecycle are not run.
const doubles = {
  "android/Manifest.java": `package android;
    public final class Manifest { public static final class permission {
      public static final String WRITE_EXTERNAL_STORAGE = "android.permission.WRITE_EXTERNAL_STORAGE";
    } }`,
  "android/os/Build.java": `package android.os;
    public final class Build {
      public static final class VERSION { public static int SDK_INT = 28; }
      public static final class VERSION_CODES {
        public static final int M = 23, N = 24, O = 26, P = 28, Q = 29, R = 30;
      }
    }`,
  "android/os/Environment.java": `package android.os;
    public final class Environment { public static final String DIRECTORY_DOWNLOADS = "Download"; }`,
  "android/os/Bundle.java": `package android.os;
    import java.util.*;
    public class Bundle {
      private final Map<String,Object> values = new LinkedHashMap<>();
      public Bundle() {}
      public Bundle(Bundle other) { if (other != null) values.putAll(other.values); }
      public void putString(String key, String value) { values.put(key, value); }
      public String getString(String key) { Object v = values.get(key); return v instanceof String ? (String) v : null; }
      public String getString(String key, String fallback) { String v = getString(key); return v == null ? fallback : v; }
      public void putBoolean(String key, boolean value) { values.put(key, value); }
      public boolean getBoolean(String key, boolean fallback) { Object v = values.get(key); return v instanceof Boolean ? (Boolean) v : fallback; }
      public void putBundle(String key, Bundle value) { values.put(key, value); }
      public Bundle getBundle(String key) { return (Bundle) values.get(key); }
      public Object get(String key) { return values.get(key); }
      public boolean containsKey(String key) { return values.containsKey(key); }
      public Set<String> keySet() { return values.keySet(); }
      public void remove(String key) { values.remove(key); }
      public void setClassLoader(ClassLoader loader) {}
    }`,
  "android/net/Uri.java": String.raw`package android.net;
    import java.net.URI;
    import java.net.URLDecoder;
    import java.nio.charset.StandardCharsets;
    import java.util.Locale;
    public final class Uri {
      private final String value;
      private Uri(String value) { if (value == null) throw new NullPointerException("uriString"); this.value = value; }
      public static Uri parse(String value) { return new Uri(value); }
      private URI parsed() { try { return URI.create(value); } catch (IllegalArgumentException error) { return null; } }
      public String getScheme() { URI uri = parsed(); return uri == null ? null : uri.getScheme(); }
      public String getHost() { URI uri = parsed(); return uri == null ? null : uri.getHost(); }
      public String getUserInfo() { URI uri = parsed(); return uri == null ? null : uri.getUserInfo(); }
      public String getAuthority() { URI uri = parsed(); return uri == null ? null : uri.getAuthority(); }
      public boolean isHierarchical() { URI uri = parsed(); return uri != null && !uri.isOpaque(); }
      public String getPath() { URI uri = parsed(); return uri == null ? null : uri.getPath(); }
      public String getLastPathSegment() {
        String path = getPath(); if (path == null || path.isEmpty() || path.endsWith("/")) return null;
        return path.substring(path.lastIndexOf('/') + 1);
      }
      public String getQueryParameter(String key) {
        URI uri = parsed(); String query = uri == null ? null : uri.getRawQuery();
        if (query == null) return null;
        for (String part : query.split("&")) {
          String[] pair = part.split("=", 2);
          if (decode(pair[0]).equals(key)) return pair.length == 2 ? decode(pair[1]) : "";
        }
        return null;
      }
      public static String decode(String value) { return URLDecoder.decode(value, StandardCharsets.UTF_8); }
      public Uri normalizeScheme() {
        String scheme = getScheme();
        return scheme == null ? this : parse(scheme.toLowerCase(Locale.ROOT) + value.substring(scheme.length()));
      }
      public Builder buildUpon() { return new Builder(this); }
      public String toString() { return value; }
      public static final class Builder {
        String value;
        Builder(Uri uri) { value = uri.value; }
        public Builder scheme(String scheme) { value = scheme + value.substring(value.indexOf(':')); return this; }
        public Uri build() { return Uri.parse(value); }
      }
    }`,
  "android/content/pm/PackageManager.java": `package android.content.pm;
    public class PackageManager { public static final int PERMISSION_GRANTED = 0, PERMISSION_DENIED = -1; }`,
  "android/content/Intent.java": "package android.content; public class Intent {}",
  "android/content/DialogInterface.java": `package android.content;
    public interface DialogInterface {
      interface OnClickListener { void onClick(DialogInterface dialog, int which); }
      interface OnCancelListener { void onCancel(DialogInterface dialog); }
      interface OnDismissListener { void onDismiss(DialogInterface dialog); }
    }`,
  "android/app/AlertDialog.java": `package android.app;
    import android.content.*;
    import java.util.*;
    public class AlertDialog implements DialogInterface {
      public static final List<AlertDialog> shown = new ArrayList<>();
      public static RuntimeException showFailure;
      public Context owner;
      public boolean showing;
      OnClickListener positive, negative;
      OnCancelListener cancel;
      OnDismissListener dismiss;
      public void show() { if (showFailure != null) throw showFailure; showing = true; shown.add(this); }
      public void dismiss() { showing = false; if (dismiss != null) dismiss.onDismiss(this); }
      public void setOnDismissListener(OnDismissListener listener) { dismiss = listener; }
      public boolean isShowing() { return showing; }
      public void testPositive() { positive.onClick(this, -1); dismiss(); }
      public void testNegative() { negative.onClick(this, -2); dismiss(); }
      public void testCancel() { if (cancel != null) cancel.onCancel(this); dismiss(); }
      public static void reset() { shown.clear(); showFailure = null; }
      public static class Builder {
        final AlertDialog dialog = new AlertDialog();
        public Builder(Context owner) { dialog.owner = owner; }
        public Builder setTitle(CharSequence value) { return this; }
        public Builder setMessage(CharSequence value) { return this; }
        public Builder setPositiveButton(CharSequence label, OnClickListener listener) { dialog.positive = listener; return this; }
        public Builder setNegativeButton(CharSequence label, OnClickListener listener) { dialog.negative = listener; return this; }
        public Builder setOnCancelListener(OnCancelListener listener) { dialog.cancel = listener; return this; }
        public AlertDialog create() { return dialog; }
      }
    }`,
  "android/content/Context.java": `package android.content;
    import android.app.DownloadManager;
    import android.content.pm.PackageManager;
    public class Context {
      public static final String DOWNLOAD_SERVICE = "download";
      public int testPermission = PackageManager.PERMISSION_DENIED;
      public DownloadManager testManager = new DownloadManager();
      public int checkSelfPermission(String permission) { return testPermission; }
      public Object getSystemService(String service) { return testManager; }
      public Context getApplicationContext() { return this; }
    }`,
  "android/app/DownloadManager.java": `package android.app;
    import android.net.Uri;
    import java.util.*;
    public class DownloadManager {
      public static RuntimeException requestFailure, destinationFailure, headerFailure;
      public RuntimeException enqueueFailure;
      public Runnable onEnqueue;
      public long nextId = 47;
      public int enqueueCalls;
      public final List<Request> requests = new ArrayList<>();
      public long enqueue(Request request) {
        enqueueCalls++; requests.add(request);
        if (onEnqueue != null) onEnqueue.run();
        if (enqueueFailure != null) throw enqueueFailure;
        return nextId;
      }
      public static void reset() { requestFailure = destinationFailure = headerFailure = null; }
      public static class Request {
        public static final int VISIBILITY_VISIBLE_NOTIFY_COMPLETED = 1;
        public final Uri uri;
        public final Map<String,String> headers = new LinkedHashMap<>();
        public String title, description, mimeType, directory, fileName;
        public int visibility;
        public Request(Uri uri) {
          if (requestFailure != null) throw requestFailure;
          if (!"http".equals(uri.getScheme()) && !"https".equals(uri.getScheme())) throw new IllegalArgumentException("scheme");
          this.uri = uri;
        }
        public Request addRequestHeader(String key, String value) {
          if (headerFailure != null) throw headerFailure;
          headers.put(key, value); return this;
        }
        public Request setTitle(CharSequence value) { title = value.toString(); return this; }
        public Request setDescription(CharSequence value) { description = value.toString(); return this; }
        public Request setMimeType(String value) { mimeType = value; return this; }
        public Request setNotificationVisibility(int value) { visibility = value; return this; }
        public Request setDestinationInExternalPublicDir(String directory, String name) {
          if (destinationFailure != null) throw destinationFailure;
          this.directory = directory; fileName = name; return this;
        }
      }
    }`,
  "android/widget/Toast.java": `package android.widget;
    import android.content.Context;
    import java.util.*;
    public class Toast {
      public static final int LENGTH_SHORT = 0;
      public static final List<String> messages = new ArrayList<>();
      public static final List<Context> owners = new ArrayList<>();
      final Context owner; final String message;
      private Toast(Context owner, String message) { this.owner = owner; this.message = message; }
      public static Toast makeText(Context owner, CharSequence message, int duration) { return new Toast(owner, message.toString()); }
      public void show() { owners.add(owner); messages.add(message); }
      public static void reset() { messages.clear(); owners.clear(); }
    }`,
  "android/webkit/URLUtil.java": `package android.webkit;
    import android.net.Uri;
    public final class URLUtil {
      public static String guessFileName(String url, String disposition, String mime) {
        String name = Uri.parse(url).getLastPathSegment();
        if (name == null || name.isEmpty()) name = "downloadfile";
        if (name.indexOf('.') < 0) name += "text/plain".equals(mime) ? ".txt" : ".bin";
        return name;
      }
    }`,
  "android/webkit/DownloadListener.java": `package android.webkit;
    public interface DownloadListener {
      void onDownloadStart(String url, String userAgent, String contentDisposition, String mimeType, long contentLength);
    }`,
  "android/webkit/WebSettings.java": `package android.webkit;
    public class WebSettings {
      public static final int MIXED_CONTENT_ALWAYS_ALLOW = 0;
      private String userAgent = "Fixture WebView";
      public void setMixedContentMode(int mode) {}
      public void setMediaPlaybackRequiresUserGesture(boolean value) {}
      public String getUserAgentString() { return userAgent; }
      public void setUserAgentString(String value) { userAgent = value; }
    }`,
  "android/webkit/ValueCallback.java": "package android.webkit; public interface ValueCallback<T> { void onReceiveValue(T value); }",
  "android/webkit/WebView.java": `package android.webkit;
    public class WebView extends android.view.View {
      public DownloadListener testDownloadListener;
      private final WebSettings settings = new WebSettings();
      public WebSettings getSettings() { return settings; }
      public void setDownloadListener(DownloadListener listener) { testDownloadListener = listener; }
      public void evaluateJavascript(String script, ValueCallback<String> callback) {}
      public boolean postDelayed(Runnable task, long delay) { return true; }
    }`,
  "android/graphics/Color.java": `package android.graphics;
    public class Color { public static final int WHITE = -1; public static int rgb(int r,int g,int b) { return 0; } }`,
  "android/view/View.java": `package android.view;
    public class View {
      public static final int OVER_SCROLL_NEVER = 2;
      public static final int SYSTEM_UI_FLAG_LAYOUT_STABLE = 1, SYSTEM_UI_FLAG_LIGHT_STATUS_BAR = 2,
        SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR = 4;
      public void setSystemUiVisibility(int flags) {}
      public void setOverScrollMode(int mode) {}
    }`,
  "android/view/Window.java": `package android.view;
    public class Window {
      public void clearFlags(int flags) {}
      public void setStatusBarColor(int color) {}
      public void setNavigationBarColor(int color) {}
      public View getDecorView() { return new View(); }
      public WindowInsetsController getInsetsController() { return new WindowInsetsController(); }
    }`,
  "android/view/WindowManager.java": `package android.view;
    public interface WindowManager { class LayoutParams { public static final int FLAG_FULLSCREEN = 1; } }`,
  "android/view/WindowInsets.java": `package android.view;
    public class WindowInsets { public static class Type { public static int statusBars() { return 1; } public static int navigationBars() { return 2; } } }`,
  "android/view/WindowInsetsController.java": `package android.view;
    public class WindowInsetsController { public void show(int types) {} }`,
  "androidx/annotation/NonNull.java": "package androidx.annotation; public @interface NonNull {}",
  "androidx/annotation/Nullable.java": "package androidx.annotation; public @interface Nullable {}",
  "androidx/core/content/ContextCompat.java": `package androidx.core.content;
    import android.content.Context;
    public class ContextCompat {
      public static int checkSelfPermission(Context context, String permission) { return context.checkSelfPermission(permission); }
    }`,
  "androidx/lifecycle/ViewModel.java": `package androidx.lifecycle;
    public abstract class ViewModel { protected void onCleared() {} public final void testClear() { onCleared(); } }`,
  "androidx/lifecycle/SavedStateHandle.java": `package androidx.lifecycle;
    import java.util.*;
    import android.os.Bundle;
    public class SavedStateHandle {
      private final Map<String,Object> values;
      public SavedStateHandle() { values = new LinkedHashMap<>(); }
      public SavedStateHandle(Map<String,Object> initial) { values = new LinkedHashMap<>(initial); }
      @SuppressWarnings("unchecked") public <T> T get(String key) { return (T) values.get(key); }
      public <T> void set(String key, T value) { values.put(key, value); }
      @SuppressWarnings("unchecked") public <T> T remove(String key) { return (T) values.remove(key); }
      public boolean contains(String key) { return values.containsKey(key); }
      public Set<String> keys() { return values.keySet(); }
      public Map<String,Object> testSnapshot() {
        Map<String,Object> snapshot = new LinkedHashMap<>();
        for (Map.Entry<String,Object> entry : values.entrySet()) {
          Object value = entry.getValue();
          if (!(value == null || value instanceof Bundle || value instanceof String || value instanceof Boolean)) {
            throw new AssertionError("SavedStateHandle must hold only serializable request data");
          }
          snapshot.put(entry.getKey(), value instanceof Bundle ? new Bundle((Bundle) value) : value);
        }
        return snapshot;
      }
    }`,
  "androidx/lifecycle/Lifecycle.java": `package androidx.lifecycle;
    public class Lifecycle {
      public enum State { DESTROYED, INITIALIZED, CREATED, STARTED, RESUMED;
        public boolean isAtLeast(State other) { return ordinal() >= other.ordinal(); }
      }
      private State state = State.INITIALIZED;
      public State getCurrentState() { return state; }
      public void testSetState(State value) { state = value; }
    }`,
  "androidx/lifecycle/LifecycleOwner.java": `package androidx.lifecycle;
    public interface LifecycleOwner { Lifecycle getLifecycle(); }`,
  "androidx/lifecycle/ViewModelStore.java": `package androidx.lifecycle;
    import java.util.*;
    public class ViewModelStore {
      public final Map<Class<?>,ViewModel> models = new LinkedHashMap<>();
      public void clear() { for (ViewModel model : models.values()) model.testClear(); models.clear(); }
    }`,
  "androidx/lifecycle/ViewModelStoreOwner.java": `package androidx.lifecycle;
    public interface ViewModelStoreOwner { ViewModelStore getViewModelStore(); }`,
  "androidx/lifecycle/ViewModelProvider.java": `package androidx.lifecycle;
    import com.getcapacitor.BridgeActivity;
    import androidx.lifecycle.viewmodel.CreationExtras;
    public class ViewModelProvider {
      public static final class Factory {
        final BridgeActivity owner;
        public Factory(BridgeActivity owner) { this.owner = owner; }
      }
      final BridgeActivity owner; final ViewModelStore store;
      public ViewModelProvider(ViewModelStore store, Factory factory, CreationExtras extras) {
        this.owner = factory.owner; this.store = store; owner.testDefaultFactoryUses++;
        // Boundary contract only: production must preserve both default owners.
        // SavedStateHandle restoration below remains a fixture-provided snapshot,
        // rather than an imitation of AndroidX's internal saved-state routing.
        if (extras.get(SavedStateHandleSupport.SAVED_STATE_REGISTRY_OWNER_KEY) != owner
            || extras.get(SavedStateHandleSupport.VIEW_MODEL_STORE_OWNER_KEY) != owner)
          throw new AssertionError("CreationExtras must preserve both current Activity owners");
        owner.testReceivedDefaultArgs = extras.get(SavedStateHandleSupport.DEFAULT_ARGS_KEY);
        if (owner.testReceivedDefaultArgs != null) {
          for (String key : owner.testReceivedDefaultArgs.keySet()) {
            if (!owner.testSavedStateHandle.contains(key))
              owner.testSavedStateHandle.set(key, owner.testReceivedDefaultArgs.get(key));
          }
        }
      }
      @SuppressWarnings("unchecked") public <T extends ViewModel> T get(Class<T> type) {
        return (T) store.models.computeIfAbsent(type, key -> {
          try { return type.getConstructor(SavedStateHandle.class).newInstance(owner.testSavedStateHandle); }
          catch (ReflectiveOperationException error) { throw new IllegalStateException(error); }
        });
      }
    }`,
  "androidx/lifecycle/viewmodel/CreationExtras.java": `package androidx.lifecycle.viewmodel;
    import java.util.*;
    public class CreationExtras {
      public interface Key<T> {}
      public final Map<Key<?>,Object> testValues = new LinkedHashMap<>();
      @SuppressWarnings("unchecked") public <T> T get(Key<T> key) { return (T) testValues.get(key); }
    }`,
  "androidx/lifecycle/viewmodel/MutableCreationExtras.java": `package androidx.lifecycle.viewmodel;
    public class MutableCreationExtras extends CreationExtras {
      public MutableCreationExtras(CreationExtras initial) { testValues.putAll(initial.testValues); }
      public <T> void set(Key<T> key, T value) { testValues.put(key, value); }
    }`,
  "androidx/lifecycle/SavedStateHandleSupport.java": `package androidx.lifecycle;
    import android.os.Bundle;
    import androidx.lifecycle.viewmodel.CreationExtras;
    public final class SavedStateHandleSupport {
      public static final CreationExtras.Key<Bundle> DEFAULT_ARGS_KEY = new CreationExtras.Key<Bundle>() {};
      public static final CreationExtras.Key<LifecycleOwner> SAVED_STATE_REGISTRY_OWNER_KEY = new CreationExtras.Key<LifecycleOwner>() {};
      public static final CreationExtras.Key<ViewModelStoreOwner> VIEW_MODEL_STORE_OWNER_KEY = new CreationExtras.Key<ViewModelStoreOwner>() {};
    }`,
  "androidx/activity/OnBackPressedCallback.java": `package androidx.activity;
    public abstract class OnBackPressedCallback {
      public OnBackPressedCallback(boolean enabled) {} public abstract void handleOnBackPressed();
    }`,
  "androidx/activity/OnBackPressedDispatcher.java": `package androidx.activity;
    public class OnBackPressedDispatcher { public void addCallback(Object owner, OnBackPressedCallback callback) {} }`,
  "androidx/activity/result/ActivityResultCallback.java": `package androidx.activity.result;
    public interface ActivityResultCallback<O> { void onActivityResult(O result); }`,
  "androidx/activity/result/ActivityResultLauncher.java": `package androidx.activity.result;
    public abstract class ActivityResultLauncher<I> { public abstract void launch(I input); public void unregister() {} }`,
  "androidx/activity/result/contract/ActivityResultContract.java": `package androidx.activity.result.contract;
    public abstract class ActivityResultContract<I,O> {}`,
  "androidx/activity/result/contract/ActivityResultContracts.java": `package androidx.activity.result.contract;
    public final class ActivityResultContracts {
      public static class RequestPermission extends ActivityResultContract<String,Boolean> {}
    }`,
  "androidx/activity/result/ActivityResultRegistry.java": `package androidx.activity.result;
    import androidx.activity.result.contract.ActivityResultContract;
    import androidx.lifecycle.*;
    import java.util.*;
    public class ActivityResultRegistry {
      private static final class Registration {
        LifecycleOwner owner; ActivityResultCallback<Object> callback;
      }
      private final Map<String,Registration> callbacks = new LinkedHashMap<>();
      public final Map<String,Object> pendingResults = new LinkedHashMap<>();
      public final List<String> keys = new ArrayList<>();
      public int launches, registrations;
      public String lastPermission;
      public Runnable onLaunch;
      public RuntimeException launchFailure;
      @SuppressWarnings("unchecked")
      public <I,O> ActivityResultLauncher<I> register(String key, LifecycleOwner owner,
          ActivityResultContract<I,O> contract, ActivityResultCallback<O> callback) {
        if (owner.getLifecycle().getCurrentState().isAtLeast(Lifecycle.State.STARTED))
          throw new IllegalStateException("Registration must precede STARTED");
        registrations++; keys.add(key);
        Registration registration = new Registration(); registration.owner = owner;
        registration.callback = (ActivityResultCallback<Object>) callback; callbacks.put(key, registration);
        return new ActivityResultLauncher<I>() {
          public void launch(I input) {
            if (owner.getLifecycle().getCurrentState() == Lifecycle.State.DESTROYED)
              throw new IllegalStateException("Destroyed registry owner");
            launches++; lastPermission = String.valueOf(input);
            if (launchFailure != null) throw launchFailure;
            if (onLaunch != null) onLaunch.run();
          }
          public void unregister() { if (callbacks.get(key) == registration) callbacks.remove(key); }
        };
      }
      public void testDeliver(String key, boolean result) {
        Registration registration = callbacks.get(key);
        if (registration != null && registration.owner.getLifecycle().getCurrentState().isAtLeast(Lifecycle.State.STARTED)) {
          registration.callback.onActivityResult(result);
        } else pendingResults.put(key, result);
      }
      public void testStart(LifecycleOwner owner) {
        for (Map.Entry<String,Registration> entry : new ArrayList<>(callbacks.entrySet())) {
          if (entry.getValue().owner == owner && pendingResults.containsKey(entry.getKey()))
            entry.getValue().callback.onActivityResult(pendingResults.remove(entry.getKey()));
        }
      }
      public void testDestroy(LifecycleOwner owner) {
        callbacks.entrySet().removeIf(entry -> entry.getValue().owner == owner);
      }
    }`,
  "com/getcapacitor/Bridge.java": `package com.getcapacitor;
    import android.webkit.WebView;
    public class Bridge {
      public final WebView webView = new WebView();
      public WebView getWebView() { return webView; }
      public void setWebViewClient(Object client) {}
    }`,
  "com/getcapacitor/BridgeActivity.java": `package com.getcapacitor;
    import android.content.*;
    import android.os.Bundle;
    import android.view.Window;
    import androidx.lifecycle.*;
    import androidx.activity.*;
    import androidx.activity.result.*;
    import androidx.lifecycle.viewmodel.*;
    public class BridgeActivity extends Context implements LifecycleOwner, ViewModelStoreOwner {
      public ActivityResultRegistry testRegistry = new ActivityResultRegistry();
      public ViewModelStore testViewModelStore = new ViewModelStore();
      public SavedStateHandle testSavedStateHandle = new SavedStateHandle();
      public Bundle testIntentDefaults = new Bundle(), testReceivedDefaultArgs;
      public int testDefaultFactoryUses;
      public boolean testFinishing, testDestroyed, testChangingConfiguration, testRationale;
      private final Lifecycle lifecycle = new Lifecycle();
      private final Bridge bridge = new Bridge();
      private Intent intent = new Intent();
      protected void onCreate(Bundle state) { lifecycle.testSetState(Lifecycle.State.CREATED); }
      protected void onStart() { lifecycle.testSetState(Lifecycle.State.STARTED); testRegistry.testStart(this); }
      protected void onStop() { lifecycle.testSetState(Lifecycle.State.CREATED); }
      public void onResume() { lifecycle.testSetState(Lifecycle.State.RESUMED); }
      protected void onDestroy() {
        testDestroyed = true; lifecycle.testSetState(Lifecycle.State.DESTROYED); testRegistry.testDestroy(this);
        if (!testChangingConfiguration) testViewModelStore.clear();
      }
      protected void onNewIntent(Intent intent) {}
      public boolean isFinishing() { return testFinishing; }
      public boolean isDestroyed() { return testDestroyed; }
      public boolean isChangingConfigurations() { return testChangingConfiguration; }
      public boolean shouldShowRequestPermissionRationale(String permission) { return testRationale; }
      public Lifecycle getLifecycle() { return lifecycle; }
      public ViewModelStore getViewModelStore() { return testViewModelStore; }
      public ViewModelProvider.Factory getDefaultViewModelProviderFactory() { return new ViewModelProvider.Factory(this); }
      public CreationExtras getDefaultViewModelCreationExtras() {
        MutableCreationExtras extras = new MutableCreationExtras(new CreationExtras());
        extras.set(SavedStateHandleSupport.DEFAULT_ARGS_KEY, testIntentDefaults);
        extras.set(SavedStateHandleSupport.SAVED_STATE_REGISTRY_OWNER_KEY, this);
        extras.set(SavedStateHandleSupport.VIEW_MODEL_STORE_OWNER_KEY, this);
        return extras;
      }
      public ActivityResultRegistry getActivityResultRegistry() { return testRegistry; }
      public OnBackPressedDispatcher getOnBackPressedDispatcher() { return new OnBackPressedDispatcher(); }
      public void registerPlugin(Class<?> plugin) {}
      public Bridge getBridge() { return bridge; }
      public Intent getIntent() { return intent; }
      public void setIntent(Intent value) { intent = value; }
      public Window getWindow() { return new Window(); }
      public boolean moveTaskToBack(boolean value) { return true; }
    }`,
};
for (const name of ["FanHaoPlayerPlugin", "FanHaoSystemPlugin", "FanHaoUpdaterPlugin", "FanHaoVisionExplorationPlugin"]) {
  doubles[`local/fanhao/library/${name}.java`] = `package local.fanhao.library; public class ${name} {}`;
}
doubles["local/fanhao/library/FanHaoAuthPlugin.java"] = `package local.fanhao.library;
  public class FanHaoAuthPlugin {
    public static Object install(Object owner) { return new Object(); }
  }`;
doubles["local/fanhao/library/AuthenticatedWebViewClient.java"] = `package local.fanhao.library;
  public class AuthenticatedWebViewClient {
    public AuthenticatedWebViewClient(Object bridge, Object sessions) {}
  }`;
doubles["local/fanhao/library/FanHaoNovelPlugin.java"] = `package local.fanhao.library;
  public class FanHaoNovelPlugin {
    public static void capturePendingTextIntent(Object owner, android.content.Intent intent) {}
    public static boolean shouldHandleTextIntent(Object owner, android.content.Intent intent) { return false; }
  }`;

try {
  const sources = [];
  for (const [relative, source] of Object.entries(doubles)) {
    const target = path.join(tempRoot, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, source);
    sources.push(target);
  }
  for (const file of ["MainActivity.java", "NativeWebDownloadRequest.java", "NativeWebDownloads.java"]) {
    sources.push(path.join(nativeRoot, file));
  }
  sources.push(path.join(root, "tools/fixtures/LegacyNativeWebDownloadsHost.java"));
  sources.push(path.join(root, "tools/fixtures/NativeWebDownloadsHarness.java"));
  const compiled = spawnSync(executable("javac"), ["-encoding", "UTF-8", "-d", tempRoot, ...sources], {
    cwd: root, encoding: "utf8", timeout: 30000
  });
  assert.equal(compiled.status, 0, `native WebView download regression must compile:\n${compiled.error || compiled.stderr || compiled.stdout}`);
  const executed = spawnSync(executable("java"), ["-cp", tempRoot, "local.fanhao.library.NativeWebDownloadsHarness"], {
    cwd: root, encoding: "utf8", timeout: 30000
  });
  assert.equal(executed.status, 0, `native WebView download regression must pass:\n${executed.error || ""}\n${executed.stderr}\n${executed.stdout}`);
  process.stdout.write(executed.stdout);
} finally {
  // Resolve the exact disposable child before cleanup; use a single native shell
  // with LiteralPath on Windows rather than passing computed paths between shells.
  const resolvedTemp = fs.realpathSync(tempRoot);
  assert.equal(path.dirname(resolvedTemp), fs.realpathSync(os.tmpdir()));
  assert(path.basename(resolvedTemp).startsWith("fanhao-native-web-downloads-"));
  if (process.platform === "win32") {
    const cleaned = spawnSync("powershell.exe", ["-NoProfile", "-Command",
      `Remove-Item -LiteralPath '${resolvedTemp.replace(/'/g, "''")}' -Recurse -Force`
    ], { encoding: "utf8", timeout: 10000 });
    assert.equal(cleaned.status, 0, `temporary fixture cleanup failed:\n${cleaned.error || cleaned.stderr}`);
  } else {
    fs.rmSync(resolvedTemp, { recursive: true, force: true });
  }
}
