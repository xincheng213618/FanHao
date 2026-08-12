package local.fanhao.library;

import android.content.SharedPreferences;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.Collections;
import java.util.HashSet;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

/** Owns the bounded, server-scoped persistence and one-time legacy migration. */
final class NativeShortVideoActionPreferences {
  private static final String LEGACY_LIKED_KEYS = "likedVideoKeys";
  private static final String LEGACY_COLLECTED_KEYS = "collectedVideoKeys";
  private static final String LEGACY_SCOPE = "legacyActionScope.v1";
  private static final String STATE_PREFIX = "actionState.v1.";

  private final SharedPreferences preferences;
  private final String serverScope;
  private final NativeShortVideoActionState state;
  private final Map<String, Set<String>> legacyAliases = new HashMap<>();

  NativeShortVideoActionPreferences(SharedPreferences preferences, String serverUrl) {
    this.preferences = preferences;
    serverScope = NativeShortVideoActionState.serverScope(serverUrl);
    state = new NativeShortVideoActionState(readStored());
    if (serverScope.length() > 0 && preferences.getString(LEGACY_SCOPE, "").length() == 0) {
      // Old releases did not retain an origin. Bind their one-time migration
      // to the first current server; a later server can never reuse it.
      preferences.edit().putString(LEGACY_SCOPE, serverScope).apply();
    }
  }

  NativeShortVideoActionState state() {
    return state;
  }

  String serverScope() {
    return serverScope;
  }

  void reconcile(List<ShortVideoItem> items) {
    if (items == null || serverScope.length() == 0) return;
    boolean migrateLegacy = serverScope.equals(preferences.getString(LEGACY_SCOPE, ""));
    for (ShortVideoItem item : items) {
      if (item == null || item.id.length() == 0) continue;
      if (migrateLegacy) {
        rememberLegacyAliases(item, NativeShortVideoActionState.Type.LIKE, LEGACY_LIKED_KEYS);
        rememberLegacyAliases(item, NativeShortVideoActionState.Type.COLLECT, LEGACY_COLLECTED_KEYS);
      }
      state.observeServer(item.id, NativeShortVideoActionState.Type.LIKE, item.userLiked);
      state.observeServer(item.id, NativeShortVideoActionState.Type.COLLECT, item.userCollected);
    }
    clearAcknowledged(items);
    persist();
  }

  void clearAcknowledged(List<ShortVideoItem> items) {
    List<NativeShortVideoActionState.Stored> acknowledged = state.drainAcknowledgedLegacy();
    if (acknowledged.isEmpty()) return;
    Set<String> likes = preferenceSet(LEGACY_LIKED_KEYS);
    Set<String> collects = preferenceSet(LEGACY_COLLECTED_KEYS);
    for (NativeShortVideoActionState.Stored stored : acknowledged) {
      ShortVideoItem item = findVideo(items, stored.videoId);
      Set<String> target = stored.type == NativeShortVideoActionState.Type.LIKE ? likes : collects;
      Set<String> aliases = legacyAliases.remove(storedKey(stored.videoId, stored.type));
      if (aliases != null) target.removeAll(aliases);
      removeLegacyKeys(target, stored.videoId, item == null ? "" : item.awemeId);
    }
    SharedPreferences.Editor editor = preferences.edit()
      .putStringSet(LEGACY_LIKED_KEYS, likes)
      .putStringSet(LEGACY_COLLECTED_KEYS, collects);
    if (likes.isEmpty() && collects.isEmpty()) editor.remove(LEGACY_SCOPE);
    editor.apply();
  }

  void clearDeleted(List<ShortVideoItem> items, Set<String> ids) {
    if (items == null || ids == null || ids.isEmpty()) return;
    Set<String> likes = preferenceSet(LEGACY_LIKED_KEYS);
    Set<String> collects = preferenceSet(LEGACY_COLLECTED_KEYS);
    for (ShortVideoItem item : items) {
      if (item == null || !ids.contains(item.id)) continue;
      state.removeVideo(item.id);
      removeRememberedAliases(likes, item.id, NativeShortVideoActionState.Type.LIKE);
      removeRememberedAliases(collects, item.id, NativeShortVideoActionState.Type.COLLECT);
      removeLegacyKeys(likes, item.id, item.awemeId);
      removeLegacyKeys(collects, item.id, item.awemeId);
    }
    preferences.edit()
      .putStringSet(LEGACY_LIKED_KEYS, likes)
      .putStringSet(LEGACY_COLLECTED_KEYS, collects)
      .apply();
    persist();
  }

  void persist() {
    if (serverScope.length() == 0) return;
    JSONArray rows = new JSONArray();
    for (NativeShortVideoActionState.Stored stored : state.snapshot()) {
      try {
        JSONObject row = new JSONObject()
          .put("videoId", stored.videoId)
          .put("type", stored.type.wireName)
          .put("confirmed", stored.confirmed)
          .put("desired", stored.desired)
          .put("legacy", stored.legacy)
          .put("reconcileRequired", stored.reconcileRequired);
        JSONArray aliases = new JSONArray();
        Set<String> remembered = legacyAliases.get(storedKey(stored.videoId, stored.type));
        if (remembered != null) for (String alias : remembered) aliases.put(alias);
        row.put("legacyKeys", aliases);
        rows.put(row);
      } catch (Exception ignored) {}
    }
    preferences.edit().putString(STATE_PREFIX + serverScope, rows.toString()).apply();
  }

  private List<NativeShortVideoActionState.Stored> readStored() {
    List<NativeShortVideoActionState.Stored> stored = new ArrayList<>();
    if (serverScope.length() == 0) return stored;
    try {
      JSONArray rows = new JSONArray(preferences.getString(STATE_PREFIX + serverScope, "[]"));
      for (int index = 0; index < rows.length() && stored.size() < NativeShortVideoActionState.MAX_STORED_ACTIONS; index++) {
        JSONObject row = rows.optJSONObject(index);
        if (row == null) continue;
        boolean hasReconcileFlag = row.has("reconcileRequired");
        boolean confirmed = row.optBoolean("confirmed", false);
        boolean desired = row.optBoolean("desired", false);
        boolean legacy = row.optBoolean("legacy", false);
        NativeShortVideoActionState.Type type = NativeShortVideoActionState.Type.fromWireName(row.optString("type", ""));
        String videoId = row.optString("videoId", "");
        stored.add(new NativeShortVideoActionState.Stored(
          videoId,
          type,
          confirmed,
          desired,
          legacy,
          row.optBoolean("reconcileRequired", !hasReconcileFlag && !legacy && confirmed == desired)
        ));
        JSONArray aliases = row.optJSONArray("legacyKeys");
        if (aliases != null) {
          Set<String> remembered = new HashSet<>();
          for (int aliasIndex = 0; aliasIndex < aliases.length() && remembered.size() < 3; aliasIndex++) {
            String alias = aliases.optString(aliasIndex, "").trim();
            if (alias.length() > 0) remembered.add(alias);
          }
          if (!remembered.isEmpty()) legacyAliases.put(storedKey(videoId, type), remembered);
        }
      }
    } catch (Exception ignored) {}
    return stored;
  }

  private void rememberLegacyAliases(ShortVideoItem item, NativeShortVideoActionState.Type type, String key) {
    Set<String> legacy = preferenceSet(key);
    Set<String> matches = new HashSet<>();
    if (legacy.contains(item.id)) matches.add(item.id);
    if (item.awemeId.length() > 0 && legacy.contains(item.awemeId)) matches.add(item.awemeId);
    if (item.awemeId.length() > 0 && legacy.contains("aweme:" + item.awemeId)) matches.add("aweme:" + item.awemeId);
    if (matches.isEmpty() || !state.importLegacy(item.id, type)) return;
    legacyAliases.computeIfAbsent(storedKey(item.id, type), ignored -> new HashSet<>()).addAll(matches);
  }

  private Set<String> preferenceSet(String key) {
    Set<String> values = preferences.getStringSet(key, Collections.emptySet());
    return values == null ? new HashSet<>() : new HashSet<>(values);
  }

  private void removeRememberedAliases(Set<String> values, String videoId, NativeShortVideoActionState.Type type) {
    Set<String> aliases = legacyAliases.remove(storedKey(videoId, type));
    if (aliases != null) values.removeAll(aliases);
  }

  private static String storedKey(String videoId, NativeShortVideoActionState.Type type) {
    return type.wireName + "\u0000" + videoId;
  }

  private static void removeLegacyKeys(Set<String> values, String videoId, String awemeId) {
    values.remove(videoId);
    if (awemeId == null || awemeId.length() == 0) return;
    values.remove(awemeId);
    values.remove("aweme:" + awemeId);
  }

  private static ShortVideoItem findVideo(List<ShortVideoItem> items, String id) {
    if (items == null) return null;
    for (ShortVideoItem item : items) if (item != null && id.equals(item.id)) return item;
    return null;
  }
}
