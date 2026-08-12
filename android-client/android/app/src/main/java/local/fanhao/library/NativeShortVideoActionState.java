package local.fanhao.library;

import java.net.URI;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;

/**
 * Per-server optimistic state for short-video actions.  This deliberately has
 * no Android dependencies so its ordering rules can be exercised on the JVM.
 */
final class NativeShortVideoActionState {
  static final int MAX_STORED_ACTIONS = 256;

  enum Type {
    LIKE("like"), COLLECT("collect");

    final String wireName;
    Type(String wireName) { this.wireName = wireName; }

    static Type fromWireName(String value) {
      return "collect".equals(value) ? COLLECT : LIKE;
    }
  }

  static final class Stored {
    final String videoId;
    final Type type;
    final boolean confirmed;
    final boolean desired;
    final boolean legacy;

    Stored(String videoId, Type type, boolean confirmed, boolean desired, boolean legacy) {
      this.videoId = cleanVideoId(videoId);
      this.type = type == null ? Type.LIKE : type;
      this.confirmed = confirmed;
      this.desired = desired;
      this.legacy = legacy;
    }
  }

  static final class Mutation {
    final String videoId;
    final Type type;
    final boolean active;
    final long generation;
    final boolean legacy;

    Mutation(String videoId, Type type, boolean active, long generation, boolean legacy) {
      this.videoId = videoId;
      this.type = type;
      this.active = active;
      this.generation = generation;
      this.legacy = legacy;
    }
  }

  static final class Completion {
    final Mutation next;
    final boolean rolledBack;
    final Stored acknowledgedLegacy;

    Completion(Mutation next, boolean rolledBack, Stored acknowledgedLegacy) {
      this.next = next;
      this.rolledBack = rolledBack;
      this.acknowledgedLegacy = acknowledgedLegacy;
    }
  }

  private static final class Entry {
    boolean confirmed;
    boolean desired;
    boolean legacy;
    long generation;
    long inFlightGeneration;

    Entry(boolean confirmed, boolean desired, boolean legacy) {
      this.confirmed = confirmed;
      this.desired = desired;
      this.legacy = legacy;
    }
  }

  private final Map<String, Entry> entries = new HashMap<>();
  private final List<Stored> acknowledgedLegacy = new ArrayList<>();

  NativeShortVideoActionState(List<Stored> restored) {
    if (restored == null) return;
    for (Stored stored : restored) {
      if (entries.size() >= MAX_STORED_ACTIONS || stored == null || stored.videoId.length() == 0) continue;
      entries.put(key(stored.videoId, stored.type), new Entry(stored.confirmed, stored.desired, stored.legacy));
    }
  }

  static String serverScope(String rawUrl) {
    try {
      URI uri = new URI(String.valueOf(rawUrl == null ? "" : rawUrl).trim());
      String scheme = String.valueOf(uri.getScheme()).toLowerCase(Locale.ROOT);
      String host = String.valueOf(uri.getHost()).toLowerCase(Locale.ROOT);
      if ((!"http".equals(scheme) && !"https".equals(scheme)) || host.length() == 0) return "";
      int port = uri.getPort();
      boolean defaultPort = port < 0 || ("http".equals(scheme) && port == 80) || ("https".equals(scheme) && port == 443);
      return scheme + "://" + host + (defaultPort ? "" : ":" + port);
    } catch (Exception ignored) {
      return "";
    }
  }

  boolean active(String videoId, Type type, boolean serverValue) {
    Entry entry = entries.get(key(videoId, type));
    return entry == null ? serverValue : entry.desired;
  }

  boolean pending(String videoId, Type type) {
    Entry entry = entries.get(key(videoId, type));
    return entry != null && (entry.inFlightGeneration != 0 || entry.desired != entry.confirmed || entry.legacy);
  }

  int pendingCount() {
    int count = 0;
    for (Entry entry : entries.values()) {
      if (entry.inFlightGeneration != 0 || entry.desired != entry.confirmed || entry.legacy) count++;
    }
    return count;
  }

  Mutation request(String videoId, Type type, boolean serverValue, boolean desired) {
    String cleanId = cleanVideoId(videoId);
    if (cleanId.length() == 0) return null;
    Entry entry = entry(cleanId, type, serverValue);
    if (entry == null) return null;
    entry.desired = desired;
    entry.generation++;
    return begin(cleanId, type, entry);
  }

  Mutation observeServer(String videoId, Type type, boolean serverValue) {
    String cleanId = cleanVideoId(videoId);
    if (cleanId.length() == 0) return null;
    Entry entry = entries.get(key(cleanId, type));
    if (entry == null) return null;
    entry.confirmed = serverValue;
    if (entry.legacy && entry.inFlightGeneration == 0 && entry.desired == serverValue) {
      entry.legacy = false;
      acknowledgedLegacy.add(new Stored(cleanId, type, serverValue, entry.desired, true));
      prune(cleanId, type, entry);
      return null;
    }
    return null;
  }

  Mutation resume(String videoId, Type type) {
    String cleanId = cleanVideoId(videoId);
    Entry entry = entries.get(key(cleanId, type));
    return entry == null ? null : begin(cleanId, type, entry);
  }

  List<Stored> drainAcknowledgedLegacy() {
    List<Stored> result = new ArrayList<>(acknowledgedLegacy);
    acknowledgedLegacy.clear();
    return result;
  }

  Completion completeSuccess(Mutation mutation, boolean serverValue) {
    Entry entry = entryFor(mutation);
    if (entry == null || entry.inFlightGeneration != mutation.generation) return new Completion(null, false, null);
    entry.inFlightGeneration = 0;
    entry.confirmed = serverValue;
    Stored acknowledged = null;
    if (entry.legacy && serverValue == mutation.active) {
      entry.legacy = false;
      acknowledged = new Stored(mutation.videoId, mutation.type, serverValue, entry.desired, true);
      acknowledgedLegacy.add(acknowledged);
    }
    Mutation next = begin(mutation.videoId, mutation.type, entry);
    prune(mutation.videoId, mutation.type, entry);
    return new Completion(next, false, acknowledged);
  }

  Completion completeFailure(Mutation mutation) {
    Entry entry = entryFor(mutation);
    if (entry == null || entry.inFlightGeneration != mutation.generation) return new Completion(null, false, null);
    entry.inFlightGeneration = 0;
    boolean currentIntentFailed = entry.generation == mutation.generation;
    if (currentIntentFailed) entry.desired = entry.confirmed;
    Mutation next = begin(mutation.videoId, mutation.type, entry);
    prune(mutation.videoId, mutation.type, entry);
    return new Completion(next, currentIntentFailed, null);
  }

  void importLegacy(String videoId, Type type) {
    if (entries.size() >= MAX_STORED_ACTIONS) return;
    String cleanId = cleanVideoId(videoId);
    if (cleanId.length() == 0 || entries.containsKey(key(cleanId, type))) return;
    entries.put(key(cleanId, type), new Entry(false, true, true));
  }

  void resolveLegacyId(String legacyId, String resolvedVideoId) {
    String oldId = cleanVideoId(legacyId);
    String newId = cleanVideoId(resolvedVideoId);
    if (oldId.length() == 0 || newId.length() == 0 || oldId.equals(newId)) return;
    for (Type type : Type.values()) {
      Entry old = entries.remove(key(oldId, type));
      if (old == null) continue;
      Entry existing = entries.get(key(newId, type));
      if (existing == null) entries.put(key(newId, type), old);
      else {
        existing.confirmed = existing.confirmed || old.confirmed;
        existing.desired = old.desired;
        existing.legacy = existing.legacy || old.legacy;
        existing.generation = Math.max(existing.generation, old.generation);
      }
    }
  }

  void removeVideo(String videoId) {
    String cleanId = cleanVideoId(videoId);
    for (Type type : Type.values()) entries.remove(key(cleanId, type));
  }

  List<Stored> snapshot() {
    List<Stored> result = new ArrayList<>();
    for (Map.Entry<String, Entry> row : entries.entrySet()) {
      int separator = row.getKey().indexOf('\u0000');
      if (separator < 1 || separator >= row.getKey().length() - 1) continue;
      Entry entry = row.getValue();
      if (entry.inFlightGeneration != 0 || entry.desired != entry.confirmed || entry.legacy) {
        result.add(new Stored(row.getKey().substring(separator + 1), Type.fromWireName(row.getKey().substring(0, separator)), entry.confirmed, entry.desired, entry.legacy));
      }
    }
    return result;
  }

  private Entry entry(String videoId, Type type, boolean serverValue) {
    String key = key(videoId, type);
    Entry entry = entries.get(key);
    if (entry != null) return entry;
    if (entries.size() >= MAX_STORED_ACTIONS) return null;
    entry = new Entry(serverValue, serverValue, false);
    entries.put(key, entry);
    return entry;
  }

  private Mutation begin(String videoId, Type type, Entry entry) {
    if (entry.inFlightGeneration != 0 || entry.desired == entry.confirmed || !isServerVideoId(videoId)) return null;
    entry.inFlightGeneration = entry.generation;
    return new Mutation(videoId, type, entry.desired, entry.generation, entry.legacy);
  }

  private void prune(String videoId, Type type, Entry entry) {
    if (entry.inFlightGeneration == 0 && entry.desired == entry.confirmed && !entry.legacy) entries.remove(key(videoId, type));
  }

  private Entry entryFor(Mutation mutation) {
    return mutation == null ? null : entries.get(key(mutation.videoId, mutation.type));
  }

  private static String key(String videoId, Type type) {
    return (type == null ? Type.LIKE : type).wireName + "\u0000" + cleanVideoId(videoId);
  }

  static boolean isServerVideoId(String videoId) {
    String clean = cleanVideoId(videoId);
    return clean.length() > 0 && !clean.startsWith("stream:") && !clean.startsWith("aweme:");
  }

  private static String cleanVideoId(String value) {
    String clean = String.valueOf(value == null ? "" : value).trim();
    return clean.length() <= 512 ? clean : "";
  }
}
