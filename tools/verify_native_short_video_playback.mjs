import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const nativeRoot = path.join(root, "android-client/android/app/src/main/java/local/fanhao/library");
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "fanhao-native-playback-"));
const javaHome = String(process.env.JAVA_HOME || "").trim() || "C:\\Program Files\\Android\\openjdk\\jdk-21.0.8";
const executable = (name) => fs.existsSync(path.join(javaHome, "bin", `${name}.exe`))
  ? path.join(javaHome, "bin", `${name}.exe`) : name;

// Deterministic Android/Media3 doubles execute the real retry controller and Activity
// pause/resume methods without a device, network, Gradle, or wall-clock sleeps.
// stop() deliberately retains playWhenReady while isPlaying() reports false.
// An optional synchronous ENDED -> BUFFERING seek transition catches replay code
// that checks the ended state only after seeking back to the start.
const doubles = {
  "android/os/Handler.java": `package android.os;
    import java.util.ArrayList;
    public class Handler {
      public final ArrayList<Runnable> pending = new ArrayList<>();
      public boolean post(Runnable task) { pending.add(task); return true; }
      public boolean postDelayed(Runnable task, long delay) { pending.add(task); return true; }
      public void removeCallbacks(Runnable task) { pending.removeIf(value -> value == task); }
      public void runPending() {
        ArrayList<Runnable> batch = new ArrayList<>(pending); pending.clear();
        for (Runnable task : batch) task.run();
      }
    }`,
  "android/net/Uri.java": `package android.net;
    import java.net.URI;
    public class Uri {
      final String value;
      Uri(String value) { this.value = value; }
      public static Uri parse(String value) { return new Uri(value); }
      public String getPath() { return URI.create(value).getPath(); }
      public Builder buildUpon() { return new Builder(value); }
      public String toString() { return value; }
      public static class Builder {
        String scheme, authority, path, query, fragment;
        Builder(String value) {
          URI uri = URI.create(value); scheme = uri.getScheme(); authority = uri.getRawAuthority();
          path = uri.getRawPath(); query = uri.getRawQuery(); fragment = uri.getRawFragment();
        }
        public Builder path(String value) { path = value; return this; }
        public Builder clearQuery() { query = null; return this; }
        public Builder fragment(String value) { fragment = value; return this; }
        public Builder appendQueryParameter(String key, String value) {
          query = (query == null || query.isEmpty() ? "" : query + "&") + key + "=" + value; return this;
        }
        public Uri build() {
          return Uri.parse(scheme + "://" + authority + path + (query == null ? "" : "?" + query)
            + (fragment == null ? "" : "#" + fragment));
        }
      }
    }`,
  "android/util/Log.java": `package android.util;
    public class Log {
      public static int i(String tag, String message) { return 0; }
      public static int w(String tag, String message) { return 0; }
      public static int w(String tag, String message, Throwable error) { return 0; }
    }`,
  "androidx/media3/common/MediaItem.java": `package androidx.media3.common;
    import android.net.Uri;
    public class MediaItem {
      public final Uri uri;
      MediaItem(Uri uri) { this.uri = uri; }
      public static MediaItem fromUri(Uri uri) { return new MediaItem(uri); }
    }`,
  "androidx/media3/common/PlaybackException.java": `package androidx.media3.common;
    public class PlaybackException extends Exception {
      public String getErrorCodeName() { return "fixture-decode-error"; }
    }`,
  "androidx/media3/common/Player.java": `package androidx.media3.common;
    public interface Player {
      int STATE_IDLE = 1, STATE_BUFFERING = 2, STATE_READY = 3, STATE_ENDED = 4;
      int REPEAT_MODE_ONE = 1, REPEAT_MODE_OFF = 0;
    }`,
  "androidx/media3/exoplayer/ExoPlayer.java": `package androidx.media3.exoplayer;
    import androidx.media3.common.MediaItem;
    import androidx.media3.common.Player;
    public class ExoPlayer {
      public boolean playWhenReady, released, bufferAfterEndedSeek;
      public long position = 4567;
      public long duration = -1;
      public long endPosition = Long.MAX_VALUE;
      public Runnable endedListener;
      public int operations, prepares, seeks, plays, pauses, playbackState = Player.STATE_BUFFERING;
      public MediaItem media;
      void touch() { operations++; if (released) throw new IllegalStateException("released player"); }
      public long getCurrentPosition() { touch(); return position; }
      public long getDuration() { touch(); return duration; }
      public boolean getPlayWhenReady() { touch(); return playWhenReady; }
      public boolean isPlaying() { touch(); return playWhenReady && playbackState == Player.STATE_READY; }
      public int getPlaybackState() { touch(); return playbackState; }
      public void stop() { touch(); playbackState = Player.STATE_IDLE; }
      public void clearMediaItems() { touch(); }
      public void clearVideoSurface() { touch(); }
      public void setMediaItem(MediaItem value) { touch(); media = value; }
      public void seekTo(long value) {
        touch(); seeks++; position = value;
        if (bufferAfterEndedSeek && playbackState == Player.STATE_ENDED) playbackState = Player.STATE_BUFFERING;
        if (value >= endPosition) {
          playbackState = Player.STATE_ENDED;
          if (endedListener != null) endedListener.run();
        }
      }
      public void prepare() { touch(); prepares++; playbackState = Player.STATE_BUFFERING; }
      public void setPlayWhenReady(boolean value) { touch(); playWhenReady = value; }
      public void play() { plays++; setPlayWhenReady(true); }
      public void pause() { pauses++; setPlayWhenReady(false); }
      public void setRepeatMode(int value) {}
      public void setVolume(float value) {}
      public void release() { touch(); released = true; }
    }`,
  "org/json/JSONObject.java": `package org.json;
    public class JSONObject {
      public JSONObject put(String key, Object value) { return this; }
      public String toString() { return "{}"; }
    }`,
  "local/fanhao/library/ShortVideoItem.java": `package local.fanhao.library;
    final class ShortVideoItem {
      final String id, streamUrl;
      final String author = "author", authorSecUid = "author";
      final java.util.List<GalleryMedia> galleryItems = new java.util.ArrayList<>();
      final GallerySound sound = new GallerySound();
      ShortVideoItem(String id) { this.id = id; streamUrl = "http://127.0.0.1/media/short-video/" + id; }
      boolean isGallery() { return !galleryItems.isEmpty(); }
      boolean isSingleLivePhoto() { return galleryItems.size() == 1; }
    }`,
  "androidx/annotation/Nullable.java": "package androidx.annotation; public @interface Nullable {}",
  "android/widget/ScrollView.java": "package android.widget; public class ScrollView {}",
  "local/fanhao/library/FeedPage.java": `package local.fanhao.library;
    final class FeedPage {
      final java.util.List<ShortVideoItem> items = new java.util.ArrayList<>();
      String nextCursor = ""; boolean hasMore; int total;
      int nextOffset() { return items.size(); }
      FeedPage copy() { FeedPage copy = new FeedPage(); copy.items.addAll(items);
        copy.nextCursor = nextCursor; copy.hasMore = hasMore; copy.total = total; return copy; }
    }`,
  "local/fanhao/library/NativeShortVideoHttpResponse.java": `package local.fanhao.library;
    import java.net.HttpURLConnection;
    final class NativeShortVideoHttpResponse {
      static String readUtf8(HttpURLConnection connection, boolean success) { return ""; }
    }`
};

try {
  const sources = [];
  const activity = fs.readFileSync(path.join(nativeRoot, "NativeShortVideoActivity.java"), "utf8").replace(/\r\n/g, "\n");
  const member = (name) => {
    const method = activity.match(new RegExp(`  (?:private|protected) (?:boolean|void|Runnable|ScreenState|FeedScreenState) ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n  \\}`))?.[0];
    assert(method, `missing production activity method: ${name}`);
    return method.replace(/private |protected /, "final ");
  };
  const livePredicate = activity.match(/\(\) -> NativeShortVideoPlaybackFallback\.shouldResume\([\s\S]*?\n    \)/)?.[0];
  assert(livePredicate, "fallback must receive the live host predicate");
  assert.equal((activity.match(/playbackFallback\.releasePlayerResources\(/g) || []).length, 4,
    "every cached-player release lane must delegate to the cancellation-aware controller");
  assert(activity.split("\n").length <= 5600, "playback fixes must retain the Activity's 5600-line limit");
  doubles["local/fanhao/library/NativeShortVideoPlaybackHost.java"] = `package local.fanhao.library;
    import java.util.HashMap;
    import java.util.Map;
    import android.util.Log;
    import androidx.media3.common.Player;
    import androidx.media3.exoplayer.ExoPlayer;
    class NativeShortVideoPlaybackHost {
      static final String TAG = "NativeShortVideoPlaybackHost";
      boolean activityResumed = true, destroying, finishing, comments;
      Object authorOverlay;
      int currentIndex;
      ExoPlayer activePlayer, gallerySegmentPlayer, gallerySoundPlayer;
      ExoPlayer commentsPausedVideo, commentsPausedGallerySegment, commentsPausedGallerySound;
      boolean commentsResumeVideo, commentsResumeGallerySegment, commentsResumeGallerySound;
      int commentsPausedIndex = -1;
      final Map<Integer, ExoPlayer> playerCache = new HashMap<>();
      boolean isFinishing() { return finishing; }
      boolean commentsOpen() { return comments; }
      void updateActiveProgress() {}
      void startProgressUpdates() {}
      void stopProgressUpdates() {}
      void cancelGalleryAutoAdvance() {}
      void resumeGalleryAutoAdvanceIfNeeded() {}
      void syncPlayIndicator(int index, ExoPlayer player) {}
      void onResume() {}
      void onPause() {}
      final boolean shouldResumeFallbackPlayback(int index, ExoPlayer player) {
        java.util.function.BooleanSupplier predicate = ${livePredicate};
        return predicate.getAsBoolean();
      }
      ${member("toggleActivePlayback")}
      ${member("pausePlaybackForFeedSearch")}
      ${member("pauseForCommentsOverlay")}
      ${member("resumeAfterCommentsOverlay")}
    }`;
  // The navigation/lifecycle methods below come directly from the Activity. Only
  // platform UI construction, cache creation and network work are doubled.
  const authorPrelude = member("renderAuthorScreen").split("    FrameLayout overlay =")[0];
  const gallerySoundTail = member("playGallerySound").split("    gallerySoundFeedIndex = feedIndex;")[1];
  const galleryBindingPrelude = member("bindGallery").split("    holder.cover.setScaleType")[0];
  const stateCallbacks = [...activity.matchAll(/      public void onPlaybackStateChanged\(int playbackState\) \{[\s\S]*?\n      \}/g)];
  assert(stateCallbacks.length >= 2, "fixture requires the production video/gallery end callbacks");
  const videoStateCallback = stateCallbacks[0][0].replace("public void onPlaybackStateChanged(int playbackState)",
    "void videoStateChanged(ExoPlayer preparedPlayer, int playbackState)");
  const galleryStateCallback = stateCallbacks[1][0].replace("public void onPlaybackStateChanged(int playbackState)",
    "void galleryStateChanged(ExoPlayer player, int playbackState)");
  assert(gallerySoundTail, "gallery fixture needs the production sound activation tail");
  doubles["local/fanhao/library/NativeShortVideoFeedPlaybackHost.java"] = `package local.fanhao.library;
    import java.util.*;
    import android.os.Handler;
    import android.net.Uri;
    import android.util.Log;
    import androidx.media3.common.MediaItem;
    import androidx.media3.common.Player;
    import androidx.media3.exoplayer.ExoPlayer;
    class NativeShortVideoFeedPlaybackHost extends NativeShortVideoPlaybackHost {
      final List<ShortVideoItem> videos = new ArrayList<>();
      final List<ScreenState> navigationStack = new ArrayList<>();
      final Map<Integer, ShortVideoHolder> attachedHolders = new HashMap<>();
      final Map<String, Integer> galleryPositions = new HashMap<>();
      final Handler mainHandler = new Handler();
      final Pager pager = new Pager();
      final Adapter adapter = new Adapter();
      final ActionSnapshots actionSnapshots = new ActionSnapshots();
      final ActionPreferences actionPreferences = new ActionPreferences();
      final FeedPaging feedPaging = new FeedPaging();
      ScreenState currentScreen;
      final NativeShortVideoFeedPlayback feedPlayback = new NativeShortVideoFeedPlayback();
      String pendingFeedUrl = "feed", nextFeedCursor = "", gallerySegmentUrl = "", gallerySoundUrl = "";
      int nextFeedOffset, pendingPlayIndex = -1, pendingStartIndex, gallerySoundFeedIndex = -1;
      int gallerySegmentFeedIndex = -1, gallerySegmentMediaIndex = -1;
      boolean hasMoreVideos, loadingMoreVideos, framePrefetchEnabled, openAuthorPanelOnStart;
      boolean pausedForLifecycle, resumePlaybackAfterPause;
      boolean autoNext;
      Object playbackToolbarOverlay;
      final Set<Integer> failedPlayerIndexes = new HashSet<>();
      long nextPlayerEndAt = Long.MAX_VALUE;
      Surface gallerySegmentView;
      int prepared, progressStarts;
      Runnable progressRunnable;
      class Pager {
        int index;
        int getCurrentItem() { return index; }
        void setCurrentItem(int value, boolean smooth) { index = value; }
        void post(Runnable task) { mainHandler.post(task); }
      }
      class Adapter {
        void notifyDataSetChanged() {
          for (int i = 0; i < videos.size(); i++) {
            ShortVideoHolder holder = new ShortVideoHolder(i); resetHolderProgress(holder); attachedHolders.put(i, holder);
          }
        }
      }
      static class ActionSnapshots { void applyAll(List<ShortVideoItem> items) {} }
      static class ActionPreferences { void reconcile(List<ShortVideoItem> items) {} }
      static class FeedPaging {
        void replaceFeed(String url, String cursor, boolean more) {}
        void markPendingAutoAdvance(int index) {}
      }
      void drain() { mainHandler.runPending(); }
      void applyCanonicalActionSnapshots(ScreenState screen) {}
      void removeAuthorOverlay() { authorOverlay = null; }
      void dismissPlaybackToolbar() {}
      void finishWithActionResult() { finishing = true; }
      void updateTopSearchButton() {}
      void hideSystemBars() {}
      void startSystemInfoUpdates() {}
      void stopSystemInfoUpdates() {}
      void clearPendingStageTap() {}
      void hideStatus() {}
      void showStatus(String message) {}
      void loadFeedAsync(String url, int index) {}
      void schedulePrepareAround(int index, int delay) {}
      void preparePlayersAround(int index) {}
      void releaseDistantPlayers(int index) {}
      void loadMoreIfNeeded(int index) {}
      void scheduleVideoPrefetch(int index) {}
      void hideSeekPreview(ShortVideoHolder holder, boolean animate) {}
      void applyCachedFrame(ShortVideoHolder holder, ShortVideoItem item) {}
      void ensurePlayerViewAt(int index) {}
      void syncPendingVideoActions(boolean reload) {}
      String displayAuthor(ShortVideoItem item) { return item.author; }
      String currentFeedSort() { return "published"; }
      String authorFeedUrl(ShortVideoItem seed, int offset, int limit, String sort) { return "author-feed"; }
      static final int AUTHOR_PAGE_LIMIT = 30;
      boolean sameAuthor(ShortVideoItem first, ShortVideoItem second) { return first.author.equals(second.author); }
      int findVideoIndex(List<ShortVideoItem> items, String id) {
        for (int i = 0; i < items.size(); i++) if (items.get(i).id.equals(id)) return i; return -1;
      }
      int playerIndex(ExoPlayer player) {
        for (Map.Entry<Integer, ExoPlayer> item : playerCache.entrySet()) if (item.getValue() == player) return item.getKey();
        return -1;
      }
      int activeRepeatMode() { return 0; }
      int activeVideoResizeMode() { return 0; }
      float activeVolume() { return 1; }
      Uri cachedMediaUri(String url) { return Uri.parse(url); }
      ExoPlayer preparePlayerAt(int index) {
        if (videos.get(index).isGallery()) return null;
        return playerCache.computeIfAbsent(index, key -> {
          prepared++; ExoPlayer player = new ExoPlayer(); player.endPosition = nextPlayerEndAt;
          player.endedListener = () -> videoStateChanged(player, Player.STATE_ENDED); return player;
        });
      }
      ExoPlayer ensureGallerySegmentPlayer() {
        if (gallerySegmentPlayer == null) {
          gallerySegmentPlayer = new ExoPlayer(); gallerySegmentPlayer.endPosition = nextPlayerEndAt;
          ExoPlayer player = gallerySegmentPlayer;
          player.endedListener = () -> galleryStateChanged(player, Player.STATE_ENDED);
        }
        return gallerySegmentPlayer;
      }
      GalleryMedia galleryMediaAt(ShortVideoItem item, int index) { return item.galleryItems.get(index); }
      void resetGalleryZoom(ShortVideoHolder holder, boolean animate) {}
      void scheduleGalleryAutoAdvance(ShortVideoHolder holder, ShortVideoItem item, int index) {}
      ${galleryBindingPrelude}
        if (galleryMediaAt(item, galleryIndex).isVideo()) playGallerySegment(holder, item, galleryIndex);
      }
      void stopGallerySegmentPlayback(ShortVideoHolder holder, boolean release) {
        if (gallerySegmentPlayer == null) return;
        if (activePlayer == gallerySegmentPlayer) activePlayer = null;
        gallerySegmentPlayer.pause();
        if (release) { gallerySegmentPlayer.release(); gallerySegmentPlayer = null; gallerySegmentUrl = ""; }
      }
      void releaseGallerySoundPlayer() {
        if (gallerySoundPlayer != null) gallerySoundPlayer.release();
        gallerySoundPlayer = null; gallerySoundUrl = "";
      }
      void releaseAllPlayers() {
        stopProgressUpdates();
        for (ExoPlayer player : playerCache.values()) player.release();
        playerCache.clear(); stopGallerySegmentPlayback(null, true); releaseGallerySoundPlayer(); activePlayer = null;
      }
      void playGallerySound(int feedIndex, ShortVideoItem item) {
        if (gallerySoundPlayer == null) gallerySoundPlayer = new ExoPlayer();
        gallerySoundFeedIndex = feedIndex;
        ${gallerySoundTail}
      ${authorPrelude} authorOverlay = new Object(); }
      ${member("captureFeedScreen")}
      ${member("captureCurrentScreen")}
      ${member("pushCurrentScreen")}
      ${member("navigateBack")}
      ${member("syncAuthorReturnState")}
      ${member("renderScreen")}
      ${member("renderFeedScreen")}
      ${member("resetFeedScreen")}
      ${member("startPlaybackAt")}
      ${member("startActivePlaybackIfVisible")}
      ${member("playAt")}
      ${member("playGallerySegment")}
      ${member("isBoundGallery")}
      ${videoStateCallback}
      ${galleryStateCallback}
      ${member("advanceAfterEnded")}
      ${member("advanceGallerySequence")}
      ${member("startProgressUpdates")}
      ${member("stopProgressUpdates")}
      ${member("updateActiveProgress")}
      ${member("resetHolderProgress")}
      ${member("showAuthorPanel")}
      ${member("openInitialAuthorScreen")}
      ${member("openAuthorVideo")}
      ${member("onResume")}
      ${member("onPause")}
    }
    class View { static final int VISIBLE = 0; }
    class Surface {
      float alpha, scaleX;
      void setVisibility(int value) {}
      void setPlayer(ExoPlayer player) {}
      void setResizeMode(int value) {}
      void setAlpha(float value) { alpha = value; }
      void setScaleX(float value) { scaleX = value; }
    }
    class ShortVideoHolder {
      final int index;
      int galleryIndex;
      final Surface cover = new Surface(), galleryVideo = new Surface();
      final Surface progressTrack = new Surface(), progressFill = new Surface();
      ShortVideoHolder(int index) { this.index = index; }
    }
    class GalleryMedia {
      final String url = "http://127.0.0.1/gallery";
      final boolean video;
      GalleryMedia(boolean video) { this.video = video; }
      boolean isVideo() { return video; }
    }
    class GallerySound {
      final String previewUrl = "http://127.0.0.1/sound", title = "sound", previewSource = "fixture";
    }`;
  for (const [relative, source] of Object.entries(doubles)) {
    const target = path.join(tempRoot, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, source);
    sources.push(target);
  }
  sources.push(path.join(nativeRoot, "NativeShortVideoPlaybackFallback.java"));
  sources.push(path.join(nativeRoot, "NativeShortVideoScreenState.java"));
  sources.push(path.join(nativeRoot, "NativeShortVideoFeedPlayback.java"));
  assert(fs.readFileSync(path.join(nativeRoot, "NativeShortVideoFeedPlayback.java"), "utf8").split(/\r?\n/).length <= 180,
    "feed playback restoration must remain a bounded intent owner");
  sources.push(path.join(root, "tools/fixtures/NativeShortVideoPlaybackHarness.java"));
  const compiled = spawnSync(executable("javac"), ["-encoding", "UTF-8", "-d", tempRoot, ...sources], {
    cwd: root, encoding: "utf8"
  });
  assert.equal(compiled.status, 0, `native playback harness must compile:\n${compiled.stderr || compiled.stdout}`);
  const executed = spawnSync(executable("java"), ["-cp", tempRoot, "local.fanhao.library.NativeShortVideoPlaybackHarness"], {
    cwd: root, encoding: "utf8"
  });
  assert.equal(executed.status, 0, `native playback harness must pass:\n${executed.stderr || executed.stdout}`);
  process.stdout.write(executed.stdout);
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true });
}
