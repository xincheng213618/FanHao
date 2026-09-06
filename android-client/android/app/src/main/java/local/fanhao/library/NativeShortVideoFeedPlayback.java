package local.fanhao.library;

import androidx.media3.common.Player;
import androidx.media3.exoplayer.ExoPlayer;
import java.util.Map;

/** Playback intent belongs to the departed feed item, not a rebuilt player. */
final class NativeShortVideoFeedPlayback {
  static final class Snapshot {
    final String itemId;
    final int mediaIndex;
    final Track video;
    final Track sound;

    Snapshot(String itemId, int mediaIndex, ExoPlayer video, ExoPlayer sound) {
      this.itemId = itemId;
      this.mediaIndex = mediaIndex;
      this.video = Track.capture(video);
      this.sound = Track.capture(sound);
    }
  }

  private static final class Track {
    final long position;
    final boolean requested;

    Track(long position, boolean requested) {
      this.position = position;
      this.requested = requested;
    }

    static Track capture(ExoPlayer player) {
      return player == null ? null : new Track(Math.max(0L, player.getCurrentPosition()),
        player.getPlayWhenReady() && player.getPlaybackState() != Player.STATE_ENDED);
    }
  }

  private static final class Restore {
    final Track track;
    ExoPlayer player;
    boolean awaitingForeground = true;
    boolean requested;

    Restore(Track track) {
      this.track = track;
      requested = track.requested;
    }

    boolean start(ExoPlayer target, boolean visible) {
      if (player != target) {
        player = target;
        target.seekTo(track.position);
      }
      if (!visible) return false;
      if (awaitingForeground) {
        awaitingForeground = false;
        target.setPlayWhenReady(requested);
      }
      // Repeated pager/binding callbacks must respect subsequent user actions.
      if (!target.getPlayWhenReady() || target.getPlaybackState() == Player.STATE_ENDED) return false;
      target.play();
      return true;
    }

    void pauseForLifecycle() {
      if (player == null || awaitingForeground) return;
      requested = player.getPlayWhenReady() && player.getPlaybackState() != Player.STATE_ENDED;
      awaitingForeground = true;
    }
  }

  private Snapshot snapshot;
  private Restore video;
  private Restore sound;

  static Snapshot capture(String itemId, int mediaIndex, ExoPlayer video, ExoPlayer sound) {
    return itemId == null ? null : new Snapshot(itemId, mediaIndex, video, sound);
  }

  void restore(Snapshot snapshot) {
    this.snapshot = snapshot;
    video = snapshot == null || snapshot.video == null ? null : new Restore(snapshot.video);
    sound = snapshot == null || snapshot.sound == null ? null : new Restore(snapshot.sound);
  }

  void restore(Snapshot snapshot, Map<String, Integer> galleryPositions) {
    restore(snapshot);
    if (snapshot != null && snapshot.mediaIndex >= 0) galleryPositions.put(snapshot.itemId, snapshot.mediaIndex);
  }

  void select(String itemId) {
    if (snapshot != null && !snapshot.itemId.equals(itemId)) restore(null);
  }

  void selectGalleryMedia(String itemId, int mediaIndex) {
    if (snapshot != null && snapshot.itemId.equals(itemId) && snapshot.mediaIndex != mediaIndex) video = null;
  }

  boolean awaitingVideo() {
    return video != null && video.awaitingForeground;
  }

  boolean allowsAutomaticPlayback(ExoPlayer player) {
    return video == null || video.player != player
      || (!video.awaitingForeground && player.getPlayWhenReady());
  }

  void rewindEndedIfAllowed(ExoPlayer player) {
    if (player.getPlaybackState() == Player.STATE_ENDED && allowsAutomaticPlayback(player)) player.seekTo(0);
  }

  void pauseForLifecycle(ExoPlayer activePlayer, ExoPlayer soundPlayer) {
    if (video != null && video.player == activePlayer) video.pauseForLifecycle();
    if (sound != null && sound.player == soundPlayer) sound.pauseForLifecycle();
  }

  boolean start(ExoPlayer player, boolean soundtrack, String itemId, boolean visible) {
    if (player == null) return false;
    Restore restore = soundtrack ? sound : video;
    if (snapshot != null && !snapshot.itemId.equals(itemId)) restore = null;
    // A later replacement is a new playback request (for example explicit retry),
    // not another author return. Never seek it back to an obsolete snapshot.
    if (restore != null && restore.player != null && restore.player != player) {
      if (soundtrack) sound = null;
      else video = null;
      restore = null;
    }
    if (restore != null) return restore.start(player, visible);
    if (!visible) return false;
    player.play();
    return true;
  }
}
