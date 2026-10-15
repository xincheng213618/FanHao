package local.fanhao.library;

import android.content.SharedPreferences;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

public final class NativeShortVideoActionPreferencesHarness {
  private static final String LEGACY_LIKED_KEYS = "likedVideoKeys";
  private static final String LEGACY_COLLECTED_KEYS = "collectedVideoKeys";
  private static final String LEGACY_SCOPE = "legacyActionScope.v1";

  public static void main(String[] args) {
    verifyServerScopesDoNotSharePendingStateOrLegacyMigration();
    verifyLegacyAliasesSurviveRestartAndClearWithoutCurrentFeedItem();
    verifyServerTrueAcknowledgesLegacyWithoutDowngrade();
    System.out.println(
      "native-short-video-action-preferences: ok "
        + "(server scope, restart aliases, feed-independent ack cleanup, server-true reconciliation)"
    );
  }

  private static void verifyServerScopesDoNotSharePendingStateOrLegacyMigration() {
    FakeSharedPreferences preferences = new FakeSharedPreferences();
    preferences.edit()
      .putStringSet(LEGACY_LIKED_KEYS, setOf("scope-aweme", "aweme:scope-aweme"))
      .apply();

    NativeShortVideoActionPreferences serverA = new NativeShortVideoActionPreferences(
      preferences,
      "http://SERVER-A.test:80/api/short-videos"
    );
    ShortVideoItem item = item("scope-video", "scope-aweme", false, false);
    serverA.reconcile(Collections.singletonList(item));
    NativeShortVideoActionState.RequestResult collect = serverA.state().request(
      item.id,
      NativeShortVideoActionState.Type.COLLECT,
      false,
      true
    );
    check(collect.accepted && collect.mutation != null, "server A must retain its explicit collect intent");
    serverA.persist();

    NativeShortVideoActionPreferences serverB = new NativeShortVideoActionPreferences(
      preferences,
      "https://server-b.test/api/short-videos"
    );
    serverB.reconcile(Collections.singletonList(item("scope-video", "scope-aweme", false, false)));
    check(serverB.state().snapshot().isEmpty(), "server B must not restore server A pending actions");
    check(
      !serverB.state().pending("scope-video", NativeShortVideoActionState.Type.LIKE)
        && !serverB.state().pending("scope-video", NativeShortVideoActionState.Type.COLLECT),
      "server B must not import legacy keys already bound to server A"
    );
    check(
      "http://server-a.test".equals(preferences.getString(LEGACY_SCOPE, "")),
      "the one-time unscoped legacy set must remain bound to the first normalized server"
    );

    NativeShortVideoActionPreferences restoredA = new NativeShortVideoActionPreferences(
      preferences,
      "http://server-a.test/another/path"
    );
    check(
      restoredA.state().pending("scope-video", NativeShortVideoActionState.Type.LIKE)
        && restoredA.state().pending("scope-video", NativeShortVideoActionState.Type.COLLECT),
      "server A must restore both its legacy and explicit pending actions from its own scope"
    );
  }

  private static void verifyLegacyAliasesSurviveRestartAndClearWithoutCurrentFeedItem() {
    FakeSharedPreferences preferences = new FakeSharedPreferences();
    Set<String> aliases = setOf("alias-video", "alias-aweme", "aweme:alias-aweme");
    preferences.edit().putStringSet(LEGACY_LIKED_KEYS, aliases).apply();

    NativeShortVideoActionPreferences beforeRestart = new NativeShortVideoActionPreferences(
      preferences,
      "http://alias-server.test/api/short-videos"
    );
    ShortVideoItem item = item("alias-video", "alias-aweme", false, false);
    beforeRestart.reconcile(Collections.singletonList(item));
    check(
      beforeRestart.state().pending(item.id, NativeShortVideoActionState.Type.LIKE),
      "a server-false legacy like must persist as pending before restart"
    );

    NativeShortVideoActionPreferences afterRestart = new NativeShortVideoActionPreferences(
      preferences,
      "http://alias-server.test/after-restart"
    );
    NativeShortVideoActionState.Mutation mutation = afterRestart.state().resume(
      item.id,
      NativeShortVideoActionState.Type.LIKE
    );
    check(mutation != null && mutation.active && mutation.legacy, "restart must restore an explicit legacy active=true sync");
    NativeShortVideoActionState.Completion completion = afterRestart.state().completeSuccess(mutation, true);
    check(completion.accepted, "the restored legacy generation must accept its matching server response");

    afterRestart.clearAcknowledged(Collections.emptyList());
    afterRestart.persist();
    check(
      preferences.getStringSet(LEGACY_LIKED_KEYS, Collections.emptySet()).isEmpty(),
      "persisted aliases must clear all old preference spellings without a current feed item"
    );
    check(
      !preferences.contains(LEGACY_SCOPE),
      "the legacy scope marker must clear once no old liked or collected aliases remain"
    );
    check(
      afterRestart.state().snapshot().isEmpty(),
      "a successful restarted migration must leave no pending second authority"
    );
  }

  private static void verifyServerTrueAcknowledgesLegacyWithoutDowngrade() {
    FakeSharedPreferences preferences = new FakeSharedPreferences();
    preferences.edit()
      .putStringSet(LEGACY_LIKED_KEYS, setOf("true-aweme", "aweme:true-aweme"))
      .putStringSet(LEGACY_COLLECTED_KEYS, Collections.emptySet())
      .apply();

    NativeShortVideoActionPreferences scoped = new NativeShortVideoActionPreferences(
      preferences,
      "https://truth-server.test:443/api/short-videos"
    );
    ShortVideoItem serverTrue = item("true-video", "true-aweme", true, false);
    scoped.reconcile(Collections.singletonList(serverTrue));

    check(
      scoped.state().snapshot().isEmpty()
        && scoped.state().resume(serverTrue.id, NativeShortVideoActionState.Type.LIKE) == null,
      "server true must acknowledge the legacy like without scheduling any downgrade PUT"
    );
    check(
      scoped.state().active(serverTrue.id, NativeShortVideoActionState.Type.LIKE, true),
      "server true must remain the effective liked state after reconciliation"
    );
    check(
      preferences.getStringSet(LEGACY_LIKED_KEYS, Collections.emptySet()).isEmpty(),
      "server-true acknowledgement must clean the matched old aliases"
    );
  }

  private static ShortVideoItem item(
      String id,
      String awemeId,
      boolean liked,
      boolean collected) {
    return new ShortVideoItem(id, awemeId, liked, collected);
  }

  private static Set<String> setOf(String... values) {
    return new HashSet<>(Arrays.asList(values));
  }

  private static void check(boolean condition, String message) {
    if (!condition) throw new AssertionError(message);
  }

  private static final class FakeSharedPreferences implements SharedPreferences {
    private final Map<String, Object> values = new HashMap<>();
    private final Set<OnSharedPreferenceChangeListener> listeners = new HashSet<>();

    @Override
    public synchronized Map<String, ?> getAll() {
      return new HashMap<>(values);
    }

    @Override
    public synchronized String getString(String key, String fallback) {
      Object value = values.get(key);
      return value instanceof String ? (String) value : fallback;
    }

    @Override
    public synchronized Set<String> getStringSet(String key, Set<String> fallback) {
      Object value = values.get(key);
      if (!(value instanceof Set)) return fallback;
      Set<?> source = (Set<?>) value;
      Set<String> copy = new HashSet<>();
      for (Object entry : source) if (entry instanceof String) copy.add((String) entry);
      return copy;
    }

    @Override
    public synchronized int getInt(String key, int fallback) {
      Object value = values.get(key);
      return value instanceof Integer ? (Integer) value : fallback;
    }

    @Override
    public synchronized long getLong(String key, long fallback) {
      Object value = values.get(key);
      return value instanceof Long ? (Long) value : fallback;
    }

    @Override
    public synchronized float getFloat(String key, float fallback) {
      Object value = values.get(key);
      return value instanceof Float ? (Float) value : fallback;
    }

    @Override
    public synchronized boolean getBoolean(String key, boolean fallback) {
      Object value = values.get(key);
      return value instanceof Boolean ? (Boolean) value : fallback;
    }

    @Override
    public synchronized boolean contains(String key) {
      return values.containsKey(key);
    }

    @Override
    public synchronized Editor edit() {
      return new FakeEditor();
    }

    @Override
    public synchronized void registerOnSharedPreferenceChangeListener(OnSharedPreferenceChangeListener listener) {
      if (listener != null) listeners.add(listener);
    }

    @Override
    public synchronized void unregisterOnSharedPreferenceChangeListener(OnSharedPreferenceChangeListener listener) {
      listeners.remove(listener);
    }

    private final class FakeEditor implements Editor {
      private final Map<String, Object> writes = new HashMap<>();
      private final Set<String> removals = new HashSet<>();
      private boolean clear;

      @Override
      public Editor putString(String key, String value) {
        return put(key, value);
      }

      @Override
      public Editor putStringSet(String key, Set<String> value) {
        return put(key, value == null ? null : new HashSet<>(value));
      }

      @Override
      public Editor putInt(String key, int value) {
        return put(key, value);
      }

      @Override
      public Editor putLong(String key, long value) {
        return put(key, value);
      }

      @Override
      public Editor putFloat(String key, float value) {
        return put(key, value);
      }

      @Override
      public Editor putBoolean(String key, boolean value) {
        return put(key, value);
      }

      @Override
      public Editor remove(String key) {
        writes.remove(key);
        removals.add(key);
        return this;
      }

      @Override
      public Editor clear() {
        clear = true;
        writes.clear();
        removals.clear();
        return this;
      }

      @Override
      public boolean commit() {
        applyChanges();
        return true;
      }

      @Override
      public void apply() {
        applyChanges();
      }

      private Editor put(String key, Object value) {
        removals.remove(key);
        writes.put(key, value);
        return this;
      }

      private void applyChanges() {
        List<String> changed = new ArrayList<>();
        synchronized (FakeSharedPreferences.this) {
          if (clear) {
            changed.addAll(values.keySet());
            values.clear();
          }
          for (String key : removals) {
            if (values.remove(key) != null) changed.add(key);
          }
          for (Map.Entry<String, Object> write : writes.entrySet()) {
            if (write.getValue() == null) values.remove(write.getKey());
            else values.put(write.getKey(), copyValue(write.getValue()));
            changed.add(write.getKey());
          }
          for (OnSharedPreferenceChangeListener listener : new ArrayList<>(listeners)) {
            for (String key : changed) listener.onSharedPreferenceChanged(FakeSharedPreferences.this, key);
          }
        }
      }

      private Object copyValue(Object value) {
        return value instanceof Set ? new HashSet<>((Set<?>) value) : value;
      }
    }
  }
}

final class ShortVideoItem {
  final String id;
  final String awemeId;
  boolean userLiked;
  boolean userCollected;

  ShortVideoItem(String id, String awemeId, boolean userLiked, boolean userCollected) {
    this.id = id;
    this.awemeId = awemeId;
    this.userLiked = userLiked;
    this.userCollected = userCollected;
  }
}
