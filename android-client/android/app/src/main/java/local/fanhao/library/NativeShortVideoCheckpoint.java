package local.fanhao.library;

import org.json.JSONArray;
import org.json.JSONObject;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.*;

/** Bounded, app-private recreation state. The Activity Bundle contains only its opaque key. */
final class NativeShortVideoCheckpoint {
  static final int VERSION = 1;
  static final int MAX_BYTES = 2 * 1024 * 1024;
  static final int MAX_ITEMS = 512;
  static final int MAX_SCREENS = 16;
  static final int MAX_GALLERY_ITEMS = 512;
  static final int MAX_STRING_BYTES = 16 * 1024;
  static final int MAX_FILES = 8;
  static final long MAX_AGE_MS = 7L * 24L * 60L * 60L * 1000L;
  private static final int MAGIC = 0x46485343;

  static final class State {
    final FeedScreenState feed;
    final ScreenState current;
    final List<ScreenState> backStack;
    final Recovery recovery;

    State(FeedScreenState feed, ScreenState current, List<ScreenState> backStack) {
      this.feed = feed; this.current = current;
      this.backStack = new ArrayList<>(backStack); this.recovery = null;
    }

    private State(Recovery recovery) {
      feed = null; current = null; backStack = Collections.emptyList(); this.recovery = recovery;
    }
  }

  static final class Recovery {
    final String itemId, sourceHash, feedUrl;
    final NativeShortVideoFeedPlayback.Snapshot playback;

    Recovery(String itemId, String sourceHash, String feedUrl, NativeShortVideoFeedPlayback.Snapshot playback) {
      this.itemId = itemId; this.sourceHash = sourceHash; this.feedUrl = feedUrl; this.playback = playback;
    }
  }

  private static final class Limit extends IOException {
    Limit() { super("short-video checkpoint exceeds its bounded storage budget"); }
  }

  static String scope(String base, String feed, String videos, String startId, int startIndex) {
    return digest((base == null ? "" : base) + "\u0000" + (feed == null ? "" : feed) + "\u0000"
      + (videos == null ? "" : videos) + "\u0000" + (startId == null ? "" : startId) + "\u0000" + startIndex);
  }

  static String sourceHash(ShortVideoItem item, int mediaIndex) {
    if (item == null) return "";
    if (item.id.length() > MAX_STRING_BYTES || item.streamUrl.length() > MAX_STRING_BYTES || item.sound.previewUrl.length() > MAX_STRING_BYTES) return "";
    if (!item.isGallery()) return digest("video\u0000" + item.id + "\u0000" + item.streamUrl);
    if (mediaIndex < 0 || mediaIndex >= item.galleryItems.size()) return "";
    GalleryMedia media = item.galleryItems.get(mediaIndex);
    if (media.url.length() > MAX_STRING_BYTES) return "";
    return digest("gallery\u0000" + item.id + "\u0000" + mediaIndex + "\u0000" + media.type + "\u0000"
      + media.url + "\u0000" + item.sound.previewUrl);
  }

  static synchronized String save(File directory, String scope, State state, long now) throws IOException {
    if (!scope.matches("[a-f0-9]{64}")) throw new IOException("invalid checkpoint scope");
    byte[] bytes;
    try { bytes = new Encoder().encode(state).toString().getBytes(StandardCharsets.UTF_8); }
    catch (Limit error) {
      try { bytes = fallback(state).toString().getBytes(StandardCharsets.UTF_8); }
      catch (Exception failure) { throw new IOException("cannot encode bounded recovery descriptor", failure); }
    }
    catch (Exception error) { throw new IOException("cannot encode short-video checkpoint", error); }
    if (bytes.length > MAX_BYTES - 256) {
      try { bytes = fallback(state).toString().getBytes(StandardCharsets.UTF_8); }
      catch (Exception error) { throw new IOException("cannot encode recovery descriptor", error); }
    }
    if (bytes.length > MAX_BYTES - 256) throw new Limit();
    if (!directory.isDirectory() && !directory.mkdirs()) throw new IOException("cannot create checkpoint directory");
    File[] abandoned = directory.listFiles((parent, name) -> name.matches("[a-f0-9]{32}\\.tmp"));
    if (abandoned != null) for (File file : abandoned) if (!file.delete()) throw new IOException("cannot remove abandoned checkpoint write");
    File[] existing = directory.listFiles((parent, name) -> name.matches("[a-f0-9]{32}\\.state"));
    // A failed filesystem rollback can leave one unpublished orphan. Refuse
    // further writes rather than accumulating more files under a broken store.
    if (existing != null && existing.length > MAX_FILES) throw new IOException("checkpoint store needs cleanup");
    String key = UUID.randomUUID().toString().replace("-", "");
    File target = new File(directory, key + ".state"), temporary = new File(directory, key + ".tmp");
    try {
      try (FileOutputStream file = new FileOutputStream(temporary); DataOutputStream out = new DataOutputStream(file)) {
        out.writeInt(MAGIC); out.writeInt(VERSION); out.writeLong(now); out.writeUTF(scope);
        out.writeUTF(digest(bytes)); out.writeInt(bytes.length); out.write(bytes); out.flush(); file.getFD().sync();
      }
      if (!temporary.renameTo(target)) throw new IOException("cannot publish checkpoint");
      try { prune(directory, key, now); }
      catch (IOException error) {
        if (!target.delete()) error.addSuppressed(new IOException("cannot roll back unpublished checkpoint"));
        throw error;
      }
      return key;
    } finally {
      if (temporary.exists()) temporary.delete();
    }
  }

  static String saveRecovery(File directory, String scope, Recovery recovery, long now) throws IOException {
    return save(directory, scope, new State(recovery), now);
  }

  static synchronized State read(File directory, String scope, String key, long now, long newGeneration) throws IOException {
    if (key == null || !key.matches("[a-f0-9]{32}") || scope == null || !scope.matches("[a-f0-9]{64}")) throw new IOException("invalid checkpoint reference");
    File file = new File(directory, key + ".state");
    if (!file.isFile() || file.length() > MAX_BYTES || file.length() < 128) throw new IOException("checkpoint missing or oversized");
    try (DataInputStream in = new DataInputStream(new FileInputStream(file))) {
      if (in.readInt() != MAGIC || in.readInt() != VERSION) throw new IOException("unsupported checkpoint version");
      long created = in.readLong();
      if (created > now + 60000L || now - created > MAX_AGE_MS) throw new IOException("checkpoint expired");
      if (!scope.equals(in.readUTF())) throw new IOException("checkpoint belongs to another launch");
      String expected = in.readUTF(); int length = in.readInt();
      if (length < 2 || length > MAX_BYTES - 256) throw new IOException("invalid checkpoint payload length");
      byte[] payload = new byte[length]; in.readFully(payload);
      if (in.read() != -1 || !expected.equals(digest(payload))) throw new IOException("checkpoint checksum mismatch");
      return decode(new JSONObject(new String(payload, StandardCharsets.UTF_8)), newGeneration);
    } catch (IOException error) { throw error; }
    catch (Exception error) { throw new IOException("corrupt short-video checkpoint", error); }
  }

  private static void prune(File directory, String ownedKey, long now) throws IOException {
    File[] files = directory.listFiles((parent, name) -> name.matches("[a-f0-9]{32}\\.state"));
    if (files == null) return;
    Arrays.sort(files, Comparator.comparingLong(File::lastModified).reversed());
    int retained = 1;
    for (File file : files) {
      if (file.getName().equals(ownedKey + ".state")) continue;
      if (now - file.lastModified() > MAX_AGE_MS || retained >= MAX_FILES) {
        if (!file.delete()) throw new IOException("cannot prune checkpoint storage budget");
      }
      else retained++;
    }
  }

  private static JSONObject fallback(State state) throws Exception {
    if (state.recovery != null) return writeRecovery(state.recovery);
    FeedScreenState feed = state.feed;
    if (feed == null || feed.items.isEmpty()) throw new IOException("no current work recovery descriptor");
    int index = feed.playbackIndex(); ShortVideoItem item = feed.items.get(index);
    if (item.id.length() > 512 || feed.feedUrl.length() > MAX_STRING_BYTES || feed.feedUrl.getBytes(StandardCharsets.UTF_8).length > MAX_STRING_BYTES) throw new Limit();
    NativeShortVideoFeedPlayback.Snapshot playback = feed.playback != null && item.id.equals(feed.playback.itemId) ? feed.playback : null;
    int media = playback == null ? (item.isGallery() ? 0 : -1) : playback.mediaIndex;
    String source = sourceHash(item, media); if (source.isEmpty()) throw new Limit();
    return writeRecovery(new Recovery(item.id, source, feed.feedUrl, playback));
  }

  private static JSONObject writeRecovery(Recovery value) throws Exception {
    if (value == null || value.itemId.isEmpty() || value.itemId.length() > 512 || !value.sourceHash.matches("[a-f0-9]{64}")
      || value.feedUrl.length() > MAX_STRING_BYTES || value.feedUrl.getBytes(StandardCharsets.UTF_8).length > MAX_STRING_BYTES
      || (value.playback != null && (!value.itemId.equals(value.playback.itemId)
        || (value.playback.gallerySourceKey != null && value.playback.gallerySourceKey.length() > MAX_STRING_BYTES + 8)))) throw new Limit();
    JSONObject recovery = new JSONObject().put("id", value.itemId).put("source", value.sourceHash).put("feed", value.feedUrl)
      .put("playback", writePlayback(value.playback, null));
    return new JSONObject().put("recovery", recovery);
  }

  private static final class Encoder {
    final IdentityHashMap<ShortVideoItem, Integer> refs = new IdentityHashMap<>();
    final JSONArray rows = new JSONArray(); int textBytes, screens;

    String text(String value) throws Limit {
      String actual = value == null ? "" : value;
      if (actual.length() > MAX_STRING_BYTES) throw new Limit();
      int bytes = actual.getBytes(StandardCharsets.UTF_8).length;
      textBytes += bytes;
      if (bytes > MAX_STRING_BYTES || textBytes > MAX_BYTES - 256) throw new Limit();
      return actual;
    }

    JSONObject encode(State state) throws Exception {
      if (state != null && state.recovery != null) return writeRecovery(state.recovery);
      if (state != null && state.current instanceof FeedScreenState && ((FeedScreenState) state.current).items.isEmpty()) throw new IOException("checkpoint has no current work");
      if (state == null || state.feed == null || state.current == null || state.backStack.size() + 2 > MAX_SCREENS) throw new Limit();
      JSONObject root = new JSONObject().put("feed", screen(state.feed)).put("current", screen(state.current));
      JSONArray stack = new JSONArray(); for (ScreenState entry : state.backStack) stack.put(screen(entry));
      return root.put("stack", stack).put("items", rows);
    }

    JSONArray items(List<ShortVideoItem> items) throws Exception {
      if (items.size() > MAX_ITEMS) throw new Limit();
      JSONArray indexes = new JSONArray(); for (ShortVideoItem item : items) indexes.put(item(item)); return indexes;
    }

    int item(ShortVideoItem item) throws Exception {
      Integer found = refs.get(item); if (found != null) return found;
      if (item == null || refs.size() >= MAX_ITEMS || item.galleryItems.size() > MAX_GALLERY_ITEMS) throw new Limit();
      int index = refs.size(); refs.put(item, index);
      JSONObject author = new JSONObject().put("id", text(item.authorId)).put("name", text(item.author)).put("secUid", text(item.authorSecUid))
        .put("uid", text(item.authorUid)).put("avatarUrl", text(item.authorAvatarUrl)).put("profileUrl", text(item.authorProfileUrl))
        .put("uniqueId", text(item.authorUniqueId)).put("shortId", text(item.authorShortId)).put("signature", text(item.authorSignature))
        .put("ipLocation", text(item.authorIpLocation)).put("followerCount", item.authorFollowerCount).put("followingCount", item.authorFollowingCount)
        .put("totalFavorited", item.authorTotalFavorited).put("awemeCount", item.authorAwemeCount).put("favoritingCount", item.authorFavoritingCount)
        .put("gender", item.authorGender).put("age", item.authorAge).put("verification", text(item.authorVerification))
        .put("profileCollectedAt", text(item.authorProfileCollectedAt)).put("following", item.authorFollowing);
      JSONObject sound = new JSONObject().put("key", text(item.sound.key)).put("id", text(item.sound.id)).put("title", text(item.sound.title))
        .put("author", text(item.sound.author)).put("coverUrl", text(item.sound.coverUrl)).put("previewUrl", text(item.sound.previewUrl))
        .put("previewSource", text(item.sound.previewSource)).put("localAvailable", item.sound.localAvailable).put("original", item.sound.original);
      JSONArray gallery = new JSONArray(); for (GalleryMedia media : item.galleryItems) gallery.put(new JSONObject()
        .put("type", text(media.type)).put("url", text(media.url)).put("posterUrl", text(media.posterUrl)));
      JSONObject row = new JSONObject().put("id", text(item.id)).put("awemeId", text(item.awemeId)).put("mediaType", text(item.mediaType))
        .put("streamUrl", text(item.streamUrl)).put("coverUrl", text(item.coverUrl)).put("galleryPresentation", text(item.galleryPresentation))
        .put("galleryItems", gallery).put("sound", sound).put("title", text(item.title)).put("author", author)
        .put("publishedAt", text(item.publishedAt)).put("durationMs", item.durationMs).put("size", item.sizeBytes).put("width", item.width).put("height", item.height)
        .put("stats", new JSONObject().put("likes", item.likes).put("comments", item.comments).put("collects", item.collects).put("shares", item.shares).put("plays", item.plays))
        .put("libraryLiked", item.libraryLiked).put("actions", new JSONObject().put("liked", item.userLiked).put("collected", item.userCollected))
        .put("shareUrl", text(item.shareUrl)).put("originalUrl", text(item.originalUrl));
      rows.put(row); return index;
    }

    JSONObject screen(ScreenState state) throws Exception {
      if (++screens > MAX_SCREENS) throw new Limit();
      if (state instanceof FeedScreenState) {
        FeedScreenState feed = (FeedScreenState) state;
        ShortVideoItem selected = feed.items.isEmpty() ? null : feed.items.get(feed.playbackIndex());
        NativeShortVideoFeedPlayback.Snapshot playback = feed.playback != null && selected != null && feed.playback.itemId.equals(selected.id) ? feed.playback : null;
        return new JSONObject().put("type", "feed").put("items", items(feed.items)).put("url", text(feed.feedUrl))
          .put("offset", feed.nextOffset).put("cursor", text(feed.nextCursor)).put("more", feed.hasMore).put("index", feed.playbackIndex())
          .put("playback", writePlayback(playback, selected));
      }
      if (!(state instanceof AuthorScreenState)) throw new IOException("unknown checkpoint route");
      AuthorScreenState author = (AuthorScreenState) state;
      JSONObject out = new JSONObject().put("type", "author").put("seed", item(author.seed))
        .put("selected", author.currentItem == null ? -1 : item(author.currentItem)).put("tab", text(author.activeTab))
        .put("sort", text(author.sort)).put("scroll", author.worksScrollY).put("context", author.hasPlaybackContext);
      if (author.page != null) out.put("page", new JSONObject().put("items", items(author.page.items)).put("offset", author.page.offset)
        .put("limit", author.page.limit).put("total", author.page.total).put("more", author.page.hasMore).put("cursor", text(author.page.nextCursor)));
      return out;
    }
  }

  private static JSONObject writePlayback(NativeShortVideoFeedPlayback.Snapshot value, ShortVideoItem item) throws Exception {
    if (value == null) return null;
    return new JSONObject().put("id", value.itemId).put("media", value.mediaIndex).put("auto", value.automaticAdvanceRequested)
      .put("video", value.hasVideo() ? new JSONObject().put("p", value.videoPosition()).put("r", value.videoRequested()) : JSONObject.NULL)
      .put("sound", value.hasSound() ? new JSONObject().put("p", value.soundPosition()).put("r", value.soundRequested()) : JSONObject.NULL)
      .put("gallerySource", value.gallerySourceKey).put("source", item == null ? "" : sourceHash(item, value.mediaIndex));
  }

  private static State decode(JSONObject root, long generation) throws Exception {
    JSONObject recovery = root.optJSONObject("recovery");
    if (recovery != null) {
      String id = recovery.getString("id"), source = recovery.getString("source"), feed = recovery.getString("feed");
      if (id.isEmpty() || id.length() > 512 || !source.matches("[a-f0-9]{64}") || feed.getBytes(StandardCharsets.UTF_8).length > MAX_STRING_BYTES) throw new IOException("invalid recovery descriptor");
      NativeShortVideoFeedPlayback.Snapshot playback = readPlayback(recovery.optJSONObject("playback"), null, generation);
      if (playback != null && !id.equals(playback.itemId)) throw new IOException("recovery work mismatch");
      return new State(new Recovery(id, source, feed, playback));
    }
    JSONArray array = root.getJSONArray("items"); if (array.length() > MAX_ITEMS) throw new Limit();
    List<ShortVideoItem> items = new ArrayList<>();
    for (int index = 0; index < array.length(); index++) {
      JSONObject row = array.getJSONObject(index);
      JSONArray gallery = row.optJSONArray("galleryItems"); if (gallery != null && gallery.length() > MAX_GALLERY_ITEMS) throw new Limit();
      ShortVideoItem item = ShortVideoFeedContract.itemFromJson(row, "", "");
      if (item == null || item.id.isEmpty()) throw new IOException("invalid checkpoint work"); items.add(item);
    }
    JSONArray entries = root.getJSONArray("stack"); if (entries.length() + 2 > MAX_SCREENS) throw new Limit();
    ScreenState underlying = readScreen(root.getJSONObject("feed"), items, generation);
    if (!(underlying instanceof FeedScreenState)) throw new IOException("missing underlying feed");
    List<ScreenState> stack = new ArrayList<>(); for (int index = 0; index < entries.length(); index++) stack.add(readScreen(entries.getJSONObject(index), items, generation));
    ScreenState current = readScreen(root.getJSONObject("current"), items, generation);
    if (current instanceof FeedScreenState && ((FeedScreenState) current).items.isEmpty()) throw new IOException("checkpoint has no current work");
    return new State((FeedScreenState) underlying, current, stack);
  }

  private static List<ShortVideoItem> readItems(JSONArray refs, List<ShortVideoItem> items) throws Exception {
    if (refs.length() > MAX_ITEMS) throw new Limit();
    List<ShortVideoItem> out = new ArrayList<>(); for (int index = 0; index < refs.length(); index++) {
      int ref = refs.getInt(index); if (ref < 0 || ref >= items.size()) throw new IOException("invalid checkpoint item reference"); out.add(items.get(ref));
    } return out;
  }

  private static ScreenState readScreen(JSONObject row, List<ShortVideoItem> items, long generation) throws Exception {
    if ("feed".equals(row.getString("type"))) {
      List<ShortVideoItem> feed = readItems(row.getJSONArray("items"), items); int index = row.getInt("index");
      if (index < 0 || (!feed.isEmpty() && index >= feed.size())) throw new IOException("invalid selected work");
      ShortVideoItem selected = feed.isEmpty() ? null : feed.get(index);
      return new FeedScreenState(feed, row.getString("url"), row.getInt("offset"), row.getString("cursor"), row.getBoolean("more"), index,
        readPlayback(row.optJSONObject("playback"), selected, generation));
    }
    if (!"author".equals(row.getString("type"))) throw new IOException("invalid checkpoint route");
    int seed = row.getInt("seed"), selected = row.getInt("selected");
    if (seed < 0 || seed >= items.size() || selected < -1 || selected >= items.size()) throw new IOException("invalid author route");
    FeedPage page = null; JSONObject savedPage = row.optJSONObject("page");
    if (savedPage != null) { page = new FeedPage(); page.items.addAll(readItems(savedPage.getJSONArray("items"), items));
      page.offset = savedPage.getInt("offset"); page.limit = savedPage.getInt("limit"); page.total = savedPage.getInt("total");
      page.hasMore = savedPage.getBoolean("more"); page.nextCursor = savedPage.getString("cursor"); page.stats = FeedStats.fromItems(page.items); }
    AuthorScreenState author = new AuthorScreenState(items.get(seed), page, row.getString("tab"), row.getString("sort"));
    author.currentItem = selected < 0 ? null : items.get(selected); author.worksScrollY = Math.max(0, row.getInt("scroll"));
    author.hasPlaybackContext = row.getBoolean("context"); return author;
  }

  private static NativeShortVideoFeedPlayback.Snapshot readPlayback(JSONObject value, ShortVideoItem item, long generation) throws Exception {
    if (value == null) return null;
    String id = value.getString("id"); int media = value.getInt("media");
    if (item != null && (!id.equals(item.id) || !value.getString("source").equals(sourceHash(item, media)))) throw new IOException("playback source mismatch");
    JSONObject video = value.optJSONObject("video"), sound = value.optJSONObject("sound");
    if ((video != null && video.getLong("p") < 0L) || (sound != null && sound.getLong("p") < 0L)) throw new IOException("invalid checkpoint position");
    return NativeShortVideoFeedPlayback.Snapshot.fromSaved(id, media, video == null ? null : video.getLong("p"), video != null && video.getBoolean("r"),
      sound == null ? null : sound.getLong("p"), sound != null && sound.getBoolean("r"), value.getBoolean("auto"),
      value.has("gallerySource") && !value.isNull("gallerySource") ? value.getString("gallerySource") : null, generation);
  }

  private static String digest(String value) { return digest(value.getBytes(StandardCharsets.UTF_8)); }
  private static String digest(byte[] bytes) {
    try { byte[] hash = MessageDigest.getInstance("SHA-256").digest(bytes); StringBuilder out = new StringBuilder(64);
      for (byte value : hash) out.append(String.format(Locale.ROOT, "%02x", value & 255)); return out.toString();
    } catch (Exception error) { throw new IllegalStateException(error); }
  }
}
