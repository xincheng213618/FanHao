import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createVerificationAdvisories } from "./verification_advisories.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const advisories = createVerificationAdvisories("native-short-video-playback");
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
  "android/os/SystemClock.java": "package android.os; public class SystemClock {public static long elapsedRealtime(){return 100;}public static long uptimeMillis(){return 100;}}",
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
      public java.util.Set<String> getQueryParameterNames() {
        java.util.Set<String> names = new java.util.LinkedHashSet<>(); String query = URI.create(value).getRawQuery();
        if (query != null) for (String part : query.split("&")) names.add(java.net.URLDecoder.decode(part.split("=", 2)[0], java.nio.charset.StandardCharsets.UTF_8));
        return names;
      }
      public java.util.List<String> getQueryParameters(String name) {
        java.util.List<String> values = new java.util.ArrayList<>(); String query = URI.create(value).getRawQuery();
        if (query != null) for (String part : query.split("&")) { String[] pair = part.split("=", 2);
          if (java.net.URLDecoder.decode(pair[0], java.nio.charset.StandardCharsets.UTF_8).equals(name)) values.add(pair.length > 1 ? java.net.URLDecoder.decode(pair[1], java.nio.charset.StandardCharsets.UTF_8) : ""); }
        return values;
      }
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
          query = (query == null || query.isEmpty() ? "" : query + "&") + java.net.URLEncoder.encode(key, java.nio.charset.StandardCharsets.UTF_8) + "=" + java.net.URLEncoder.encode(value, java.nio.charset.StandardCharsets.UTF_8); return this;
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
      public static final int ERROR_CODE_IO_NETWORK_CONNECTION_FAILED = 2001, ERROR_CODE_IO_NETWORK_CONNECTION_TIMEOUT = 2002, ERROR_CODE_IO_BAD_HTTP_STATUS = 2004,
        ERROR_CODE_PARSING_CONTAINER_UNSUPPORTED = 3003, ERROR_CODE_DECODER_INIT_FAILED = 4001, ERROR_CODE_DECODER_QUERY_FAILED = 4002,
        ERROR_CODE_DECODING_FAILED = 4003, ERROR_CODE_DECODING_FORMAT_EXCEEDS_CAPABILITIES = 4004, ERROR_CODE_DECODING_FORMAT_UNSUPPORTED = 4005;
      public final int errorCode;
      public PlaybackException() { errorCode = 4003; }
      public PlaybackException(int code) { errorCode = code; }
      public String getErrorCodeName() { return errorCode == ERROR_CODE_DECODING_FAILED ? "ERROR_CODE_DECODING_FAILED" : errorCode == ERROR_CODE_IO_NETWORK_CONNECTION_TIMEOUT ? "ERROR_CODE_IO_NETWORK_CONNECTION_TIMEOUT" : "ERROR_CODE_UNSPECIFIED"; }
    }`,
  "androidx/media3/datasource/HttpDataSource.java": `package androidx.media3.datasource;
    public interface HttpDataSource {
      class InvalidResponseCodeException extends java.io.IOException {
        public final int responseCode;
        public InvalidResponseCodeException(int code) { responseCode = code; }
      }
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
      public androidx.media3.common.PlaybackException error;
      public androidx.media3.common.PlaybackException getPlayerError() { touch(); return error; }
      public MediaItem getCurrentMediaItem() { touch(); return media; }
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
      public void prepare() { touch(); prepares++; error = null; playbackState = Player.STATE_BUFFERING; }
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
  doubles["local/fanhao/library/NativeShortVideoGalleryImageReadiness.java"] = fs.readFileSync(path.join(nativeRoot,"NativeShortVideoGalleryImageReadiness.java"),"utf8");
  const member = (name) => {
    const method = activity.match(new RegExp(`  (?:private|protected) (?:boolean|void|String|Object|Runnable|ScreenState|FeedScreenState|GallerySegmentCallback) ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n  \\}`))?.[0];
    assert(method, `missing production activity method: ${name}`);
    return method.replace(/private |protected /, "final ");
  };
  const livePredicate = activity.match(/\(\) -> NativeShortVideoPlaybackFallback\.shouldResume\([\s\S]*?\n    \)/)?.[0];
  assert(livePredicate, "fallback must receive the live host predicate");
  assert.equal((activity.match(/playbackFallback\.releasePlayerResources\(/g) || []).length, 4,
    "every cached-player release lane must delegate to the cancellation-aware controller");
  advisories.check(activity.split("\n").length <= 5600, `native short-video Activity is over 5600 lines (${activity.split("\n").length}); review its responsibilities`);
  doubles["local/fanhao/library/NativeShortVideoPlaybackHost.java"] = `package local.fanhao.library;
    import java.util.HashMap;
    import java.util.Map;
    import java.util.List;
    import java.util.ArrayList;
    import android.util.Log;
    import androidx.media3.common.Player;
    import androidx.media3.exoplayer.ExoPlayer;
    class NativeShortVideoPlaybackHost {
      static final long GALLERY_IMAGE_AUTO_ADVANCE_MS = ${activity.match(/GALLERY_IMAGE_AUTO_ADVANCE_MS = (\d+)L?;/)[1]};
      NativeShortVideoGalleryImageReadiness galleryAutoAdvanceReadiness;
      static final String TAG = "NativeShortVideoPlaybackHost";
      boolean activityResumed = true, destroying, finishing, comments;
      Object authorOverlay;
      Object gallerySearchAdvancePause;
      int currentIndex;
      ExoPlayer activePlayer, gallerySegmentPlayer, gallerySoundPlayer;
      ExoPlayer commentsPausedVideo, commentsPausedGallerySegment, commentsPausedGallerySound;
      boolean commentsResumeVideo, commentsResumeGallerySegment, commentsResumeGallerySound;
      long commentsAudioInterruptionGeneration;
      String commentsPausedItemId;
      ShortVideoHolder commentsPausedHolder;
      Object commentsVideoSourceOwner, commentsSegmentSourceOwner, commentsSoundSourceOwner;
      final NativeShortVideoFeedPlayback feedPlayback = new NativeShortVideoFeedPlayback();
      NativeShortVideoRecovery.NativeOwner nativeSession;
      NativeShortVideoFeedPlayback.Snapshot checkpointLifecyclePlayback, checkpointOverlayPlayback;
      ShortVideoItem checkpointLifecycleItem, checkpointOverlayItem;
      long screenAwakeRetryGeneration;
      void rememberCheckpointLifecycle() {}
      void rememberCheckpointOverlay() {}
      void refreshScreenAwake() {}
      final List<ShortVideoItem> videos = new ArrayList<>();
      final Map<Integer, ShortVideoHolder> attachedHolders = new HashMap<>();
      int commentsPausedIndex = -1;
      final Map<Integer, ExoPlayer> playerCache = new HashMap<>();
      boolean isFinishing() { return finishing; }
      void finish() { finishing = true; }
      boolean commentsOpen() { return comments; }
      boolean feedSearchOpen() { return false; }
      Object overlayPlaybackSourceOwner(ExoPlayer player) { return player; }
      void cancelProgressSeek() {}
      boolean hasOwnedProgressSeek() { return false; }
      long progressDuration(ExoPlayer player) { return player.getDuration(); }
      void clearProgressDuration() {}
      void cancelStageGestures() {}
      boolean retryGallerySegmentPlayback() { return false; }
      boolean retryGalleryImagePlayback() { return false; }
      boolean restoreGalleryImageFailureStatus() { return false; }
      boolean restoreGalleryPlaybackStatus() { return false; }
      void invalidateGalleryStageGesture(ShortVideoHolder holder, int mediaIndex) {}
      void refreshFrameLoadingWindow() {}
      void pauseFrameLoading() {}
      void resumeFrameLoading() {}
      void bindFrame(int index) {}
      void flushSelectedPlaybackRequest() {}
      void pauseSelectedPlaybackRequest() {}
      void cancelSelectedPlaybackRequest() {}
      boolean flushGalleryContinuation() { return false; }
      void cancelGalleryContinuation() {}
      void pauseGalleryContinuation() {}
      void invalidateGalleryContinuation() {}
      void beginGalleryContinuation(ShortVideoHolder holder, ShortVideoItem item, int mediaIndex) {}
      void updateActiveProgress() {}
      void startProgressUpdates() {}
      void stopProgressUpdates() {}
      void cancelGalleryAutoAdvance() {}
      Runnable pauseGalleryAutoAdvanceForSearch() { return null; }
      void invalidateGallerySearchAdvance(int index) {}
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
    }
    class NativeShortVideoRecovery {
      static NativeOwner attach(Object activity,Object saved){return new NativeOwner();}
      static class NativeOwner {
        <T> T restoreState(T saved){return saved;}
        boolean publish(String scope,String key){return true;}
        boolean isRejected(){return false;}void tagResult(Object result){}
        void invalidateCheckpoint(){}
        boolean resumed(){return true;}boolean close(){return true;}void destroy(){}
      }
    }`;
  // The navigation/lifecycle methods below come directly from the Activity. Only
  // platform UI construction, cache creation and network work are doubled.
  const authorPrelude = member("renderAuthorScreen").split("    FrameLayout overlay =")[0];
  const gallerySoundTail = member("playGallerySound").split("    boolean selectedNewWork =")[1];
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
    import android.os.SystemClock;
    import android.net.Uri;
    import android.util.Log;
    import androidx.media3.common.MediaItem;
    import androidx.media3.common.Player;
    import androidx.media3.exoplayer.ExoPlayer;
    class NativeShortVideoFeedPlaybackHost extends NativeShortVideoPlaybackHost {
      final List<ScreenState> navigationStack = new ArrayList<>();
      final Map<String, Integer> galleryPositions = new HashMap<>();
      final Handler mainHandler = new Handler();
      final NativeShortVideoPlaybackFallback playbackFallback = new NativeShortVideoPlaybackFallback(mainHandler, new NativeNoNetworkExecutor());
      final Pager pager = new Pager();
      final Adapter adapter = new Adapter();
      final ActionSnapshots actionSnapshots = new ActionSnapshots();
      final ActionPreferences actionPreferences = new ActionPreferences();
      final FeedPaging feedPaging = new FeedPaging();
      final ReadRequests feedRequests = new ReadRequests();
      ScreenState currentScreen;
      String pendingFeedUrl = "feed", nextFeedCursor = "", gallerySegmentUrl = "", gallerySoundUrl = "";
      long gallerySegmentGeneration;MediaItem gallerySegmentRenderedSource;
      String gallerySegmentItemId="";GallerySegmentCallback gallerySegmentRetryOwner;long gallerySegmentRetryStatusGeneration=-1;
      long gallerySoundGeneration;
      int nextFeedOffset, pendingPlayIndex = -1, pendingStartIndex, gallerySoundFeedIndex = -1;
      int gallerySegmentFeedIndex = -1, gallerySegmentMediaIndex = -1;
      boolean hasMoreVideos, loadingMoreVideos, framePrefetchEnabled, openAuthorPanelOnStart;
      boolean pausedForLifecycle, resumePlaybackAfterPause;
      boolean autoNext;
      boolean reuseActivePlayer;
      Object playbackToolbarOverlay;
      final Set<Integer> failedPlayerIndexes = new HashSet<>();
      ${activity.match(/  private static final class FailedVideoRetry \{[\s\S]*?\n  \}/)[0].replace("private ", "")}
      FailedVideoRetry failedVideoRetry;
      ${activity.match(/  private static final class PlaybackRequest \{[\s\S]*?\n  \}/)[0].replace("private ", "")}
      PlaybackRequest selectedPlaybackRequest;
      Runnable pendingPlaybackRunnable, pendingPrepareRunnable;
      long pageSelectedAtMs; int pageSelectedIndex;
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
      static class ReadRequests { void cancel() {} }
      void drain() { mainHandler.runPending(); }
      void selectForTest(int index) { pager.setCurrentItem(index, false); requestSelectedPlayback(index, 0); playAt(index); }
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
      ${member("schedulePrepareAround")}
      void prepareAround(int index) {}
      void runNeighborsDuringDrag(int index) {}
      ${member("pauseInactivePlayers")}
      void preparePlayersAround(int index) {}
      void releaseDistantPlayers(int index) {}
      void loadMoreIfNeeded(int index) {}
      void scheduleVideoPrefetch(int index) {}
      void cancelVideoPrefetch() {}
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
        if (reuseActivePlayer && activePlayer != null && !playerCache.containsKey(index)) {
          playerCache.clear(); playerCache.put(index, activePlayer);
          playbackFallback.mediaUri(activePlayer, videos.get(index)); activePlayer.prepare(); return activePlayer;
        }
        return playerCache.computeIfAbsent(index, key -> {
          prepared++; ExoPlayer player = new ExoPlayer(); player.endPosition = nextPlayerEndAt;
          playbackFallback.mediaUri(player, videos.get(index));
          player.endedListener = () -> videoStateChanged(player, Player.STATE_ENDED); return player;
        });
      }
      void releasePlayerAt(int index) {
        ExoPlayer player = playerCache.remove(index);
        if (player == activePlayer) activePlayer = null;
        playbackFallback.releasePlayerResources(player);
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
        else completeGalleryImageForTest(holder,item,galleryIndex);
      }
      void completeGalleryImageForTest(ShortVideoHolder holder,ShortVideoItem item,int index){holder.cover.setTag(galleryCacheKey(item,index));holder.cover.drawable=new Object();holder.galleryImageReadiness.ready=true;}
      ${member("galleryCacheKey")}
      ${member("isGalleryImageReady")}
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
        cancelSelectedPlaybackRequest(); failedVideoRetry = null;
        stopProgressUpdates();
        for (ExoPlayer player : playerCache.values()) player.release();
        playerCache.clear(); stopGallerySegmentPlayback(null, true); releaseGallerySoundPlayer(); activePlayer = null;
      }
      void playGallerySound(int feedIndex, ShortVideoItem item) {
        if (gallerySoundPlayer == null) gallerySoundPlayer = new ExoPlayer();
        boolean selectedNewWork =${gallerySoundTail}
      ${authorPrelude} authorOverlay = new Object(); }
      ${member("captureFeedScreen")}
      ${member("overlayPlaybackSourceOwner")}
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
      ${member("bindSelectedPlaybackAt")}
      ${member("playbackPageVisible")}
      ${member("isSelectedPlaybackItem")}
      ${member("pauseSelectedPlaybackRequest")}
      ${member("cancelSelectedPlaybackRequest")}
      ${member("requestSelectedPlayback")}
      ${member("flushSelectedPlaybackRequest")}
      ${member("handlePlaybackPageSelected")}
      ${member("handlePlaybackPageScrollStateChanged")}
      ${member("retryPlaybackAt")}
      ${member("ownsVideoRetry")}
      ${member("playGallerySegment")}
      ${member("isBoundGallery")}
      ${videoStateCallback}
      ${member("ownsPlayerCallback")}
      ${galleryStateCallback}
      ${activity.match(/  private final class GallerySegmentCallback \{[\s\S]*?\n  \}/)?.[0]}
      ${member("captureGallerySegmentCallback")}
      ${member("clearGallerySegmentRetryStatus")}
      ${member("advanceAfterEnded")}
      ${member("canAdvanceAfterEnded")}
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
    class ViewPager2 {static final int SCROLL_STATE_IDLE=0,SCROLL_STATE_DRAGGING=1;}
    class View { static final int VISIBLE = 0, GONE = 8; }
    class Surface {
      Object tag,drawable=new Object();void setTag(Object value){tag=value;}Object getTag(){return tag;}Object getDrawable(){return drawable;}
      float alpha, scaleX;
      int visibility;
      void setVisibility(int value) { visibility = value; }
      int getVisibility() { return visibility; }
      void setPlayer(ExoPlayer player) {}
      void setResizeMode(int value) {}
      void setAlpha(float value) { alpha = value; }
      void setScaleX(float value) { scaleX = value; }
    }
    class ShortVideoHolder {
      NativeShortVideoGalleryImageReadiness galleryImageReadiness;
      final int index;
      int galleryIndex;
      final Surface cover = new Surface(), galleryVideo = new Surface();
      final Surface progressTrack = new Surface(), progressFill = new Surface();
      ShortVideoHolder(int index) { this.index = index; }
    }
    class GalleryMedia {
      final String posterUrl="";
      final String url;
      final boolean video;
      GalleryMedia(boolean video) { this(video, "http://127.0.0.1/gallery"); }
      GalleryMedia(boolean video, String url) { this.video = video; this.url = url; }
      boolean isVideo() { return video; }
    }
    class GallerySound {
      final String previewUrl = "http://127.0.0.1/sound", title = "sound", previewSource = "fixture";
    }
    class NativeNoNetworkExecutor extends java.util.concurrent.AbstractExecutorService {
      public void shutdown() {}
      public List<Runnable> shutdownNow() { return List.of(); }
      public boolean isShutdown() { return false; }
      public boolean isTerminated() { return false; }
      public boolean awaitTermination(long time, java.util.concurrent.TimeUnit unit) { return true; }
      public void execute(Runnable task) {}
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
  const feedPlaybackLineCount = fs.readFileSync(path.join(nativeRoot, "NativeShortVideoFeedPlayback.java"), "utf8").split(/\r?\n/).length;
  advisories.check(feedPlaybackLineCount <= 180, `native feed playback intent owner is over 180 lines (${feedPlaybackLineCount}); review its responsibilities`);
  const playbackRegressions = `
    for (int state : List.of(Player.STATE_READY, Player.STATE_BUFFERING)) {
      for (boolean requested : List.of(false, true)) {
        check("ordinary same-page pager callback retains intent: state=" + state + ", requested=" + requested, () -> {
          FeedFixture f = new FeedFixture(false); ExoPlayer player = f.activePlayer;
          player.playbackState = state; player.seekTo(12000); player.setPlayWhenReady(requested);
          f.selectForTest(f.currentIndex); f.selectForTest(f.currentIndex);
          require(player.getPlayWhenReady() == requested, "duplicate same-page binding changed the user's playback intent");
          require(player.position == 12000, "duplicate binding changed the current position");
        });
      }
    }
    check("a new item on the reused physical player still autoplays", () -> {
      FeedFixture f = new FeedFixture(false); ExoPlayer player = f.activePlayer; player.pause();
      f.videos.add(new ShortVideoItem("next")); f.adapter.notifyDataSetChanged(); f.reuseActivePlayer = true; f.selectForTest(1);
      require(f.activePlayer == player && player.getPlayWhenReady(), "old pause leaked into the next item on the reused player");
    });
    for (boolean requested : List.of(false, true)) {
      for (long position : List.of(0L, 12000L)) {
        check("delayed compatibility retry retains latest seek and intent: requested=" + requested + ", position=" + position, () -> {
          Fixture f = new Fixture(); f.schedule(); f.player.seekTo(position); f.player.setPlayWhenReady(requested); f.handler.runPending();
          require(f.player.position == position, "delayed retry rewound the user's newer seek");
          require(f.player.getPlayWhenReady() == requested, "delayed retry changed current playback intent");
        });
      }
    }
    for (String change : List.of("seek-playing", "seek-paused", "paused", "comments", "none")) {
      check("queued end checks current state and intent: " + change, () -> {
        FeedFixture f = new FeedFixture(false); f.autoNext = true;
        f.videos.add(new ShortVideoItem("next")); f.adapter.notifyDataSetChanged();
        ExoPlayer player = f.activePlayer; player.playbackState = Player.STATE_ENDED; player.setPlayWhenReady(true);
        f.videoStateChanged(player, Player.STATE_ENDED);
        if (change.startsWith("seek")) { player.seekTo(1000); player.playbackState = Player.STATE_READY; }
        if (change.endsWith("paused")) player.pause();
        if (change.equals("comments")) f.comments = true;
        f.drain();
        require(f.pager.getCurrentItem() == (change.equals("none") ? 1 : 0), "obsolete end callback ignored newer seek, pause or overlay");
      });
    }
    for (boolean segment : List.of(false, true)) {
      for (boolean soundRequested : List.of(false, true)) {
        for (boolean videoRequested : segment ? List.of(false, true) : List.of(false)) {
          check("same gallery binding retains independent intent: segment=" + segment + ", sound=" + soundRequested + ", video=" + videoRequested, () -> {
            FeedFixture f = new FeedFixture(true, segment); ExoPlayer sound = f.gallerySoundPlayer, video = f.activePlayer;
            sound.seekTo(21000); sound.setPlayWhenReady(soundRequested);
            if (video != null) { video.seekTo(17000); video.setPlayWhenReady(videoRequested); }
            f.selectForTest(0); f.selectForTest(0);
            require(f.gallerySoundPlayer == sound && sound.getPlayWhenReady() == soundRequested && sound.position == 21000,
              "same gallery callback changed the soundtrack's pause or position");
            if (video != null) require(f.activePlayer == video && video.getPlayWhenReady() == videoRequested && video.position == 17000,
              "same gallery callback changed the segment's independent pause or position");
          });
        }
      }
    }
    for (boolean sameIndex : List.of(false, true)) {
      check("a new gallery still autoplays after paused gallery: same index=" + sameIndex, () -> {
        FeedFixture f = new FeedFixture(true, false); f.gallerySoundPlayer.pause();
        ShortVideoItem next = new ShortVideoItem("next-gallery"); next.galleryItems.add(new GalleryMedia(false));
        int index = sameIndex ? 0 : 1;
        if (sameIndex) f.videos.set(0, next); else f.videos.add(next);
        f.adapter.notifyDataSetChanged();
        ShortVideoHolder holder = f.attachedHolders.remove(index); f.selectForTest(index);
        f.attachedHolders.put(index, holder); f.drain();
        require(f.gallerySoundPlayer.getPlayWhenReady(), "the departed gallery's pause blocked the new gallery after a delayed holder bind");
      });
    }
    check("explicit gallery page selection remains playable after a paused rebound", () -> {
      FeedFixture f = new FeedFixture(true, true); ShortVideoItem item = f.videos.get(0);
      item.galleryItems.add(new GalleryMedia(true)); f.gallerySoundPlayer.pause(); f.activePlayer.pause();
      f.selectForTest(0); require(!f.activePlayer.getPlayWhenReady(), "rebound must retain segment pause");
      f.bindGallery(f.attachedHolders.get(0), item, 1, 1);
      require(f.activePlayer.getPlayWhenReady(), "the temporary rebound guard leaked into an explicit gallery page selection");
      require(!f.gallerySoundPlayer.getPlayWhenReady(), "starting a new segment changed the independent soundtrack pause");
    });
    for (boolean sourceChanged : List.of(false, true)) {
      check("paused gallery rebound preserves only the already painted source frame: source changed=" + sourceChanged, () -> {
        FeedFixture f = new FeedFixture(true, true); ExoPlayer video = f.activePlayer; video.pause(); f.gallerySoundPlayer.pause();
        ShortVideoHolder holder = f.attachedHolders.get(0); holder.cover.setVisibility(8); int prepares = video.prepares;
        if (sourceChanged) f.videos.get(0).galleryItems.set(0, new GalleryMedia(true, "http://127.0.0.1/new-source"));
        f.selectForTest(0);
        require(!video.getPlayWhenReady(), "keeping the cover accurate must not change paused intent");
        require(holder.cover.getVisibility() == (sourceChanged ? 0 : 8), "paused rebound hid a new-source poster or covered an already painted frame");
        require(video.prepares == prepares + (sourceChanged ? 1 : 0), "the cover case must exercise actual unchanged/new media binding");
      });
    }
    check("explicit Activity retry renews an exhausted compatibility budget", () -> {
      FeedFixture f = new FeedFixture(false); ExoPlayer old = f.activePlayer; ShortVideoItem item = f.videos.get(0);
      require(f.playbackFallback.handle(old, item, new PlaybackException(), () -> true), "initial compatibility fallback");
      for (int attempt = 1; attempt <= 4; attempt++) {
        require(f.playbackFallback.handle(old, item, new PlaybackException(PlaybackException.ERROR_CODE_IO_NETWORK_CONNECTION_TIMEOUT), () -> true), "automatic retry within budget"); f.drain();
      }
      require(!f.playbackFallback.handle(old, item, new PlaybackException(PlaybackException.ERROR_CODE_IO_NETWORK_CONNECTION_TIMEOUT), () -> true), "automatic retries must remain bounded");
      f.retryPlaybackAt(0); f.drain();
      require(f.activePlayer != old && old.released, "explicit retry must replace the failed player");
      require(f.playbackFallback.handle(f.activePlayer, item, new PlaybackException(PlaybackException.ERROR_CODE_IO_NETWORK_CONNECTION_TIMEOUT), () -> true), "explicit user retry must get a fresh automatic budget");
      require(f.playbackFallback.status().contains("1/4"), "fresh automatic retries must restart at attempt one");
      require(f.playbackFallback.playbackUrl(item).contains("mobile-2560-h264-v4-pinned"), "explicit retry must preserve the pinned compatibility rendition");
    });
  `;
  const harnessSource = fs.readFileSync(path.join(root, "tests/fixtures/NativeShortVideoPlaybackHarness.java"), "utf8")
    .replace("    if (!failures.isEmpty())", `${playbackRegressions}\n    if (!failures.isEmpty())`);
  const harnessPath = path.join(tempRoot, "local/fanhao/library/NativeShortVideoPlaybackHarness.java");
  fs.writeFileSync(harnessPath, harnessSource); sources.push(harnessPath);
  const compiled = spawnSync(executable("javac"), ["-encoding", "UTF-8", "-d", tempRoot, ...sources], {
    cwd: root, encoding: "utf8"
  });
  assert.equal(compiled.status, 0, `native playback harness must compile:\n${compiled.stderr || compiled.stdout}`);
  const executed = spawnSync(executable("java"), ["-cp", tempRoot, "local.fanhao.library.NativeShortVideoPlaybackHarness"], {
    cwd: root, encoding: "utf8"
  });
  assert.equal(executed.status, 0, `native playback harness must pass:\n${executed.stderr || executed.stdout}`);
  process.stdout.write(executed.stdout);
  advisories.flush();
} finally {
  const resolved = path.resolve(tempRoot);
  assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
  assert(path.basename(resolved).startsWith("fanhao-native-playback-"));
  fs.rmSync(resolved, { recursive: true, force: true });
}
