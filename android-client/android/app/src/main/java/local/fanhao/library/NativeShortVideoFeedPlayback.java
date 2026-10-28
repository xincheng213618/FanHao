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
    final long audioInterruptionGeneration;
    final boolean automaticAdvanceRequested;
    final String gallerySourceKey;

    Snapshot(String itemId, int mediaIndex, ExoPlayer video, ExoPlayer sound) {
      this(itemId, mediaIndex, video, sound, 0L);
    }

    Snapshot(String itemId, int mediaIndex, ExoPlayer video, ExoPlayer sound, long audioInterruptionGeneration) {
      this(itemId, mediaIndex, video, sound, audioInterruptionGeneration, true);
    }

    Snapshot(String itemId, int mediaIndex, ExoPlayer video, ExoPlayer sound, long audioInterruptionGeneration, boolean automaticAdvanceRequested) {
      this(itemId, mediaIndex, video, sound, audioInterruptionGeneration, automaticAdvanceRequested, null);
    }

    Snapshot(String itemId, int mediaIndex, ExoPlayer video, ExoPlayer sound, long audioInterruptionGeneration, boolean automaticAdvanceRequested, String gallerySourceKey) {
      this(itemId, mediaIndex, Track.capture(video), Track.capture(sound), audioInterruptionGeneration, automaticAdvanceRequested, gallerySourceKey);
    }

    private Snapshot(String itemId, int mediaIndex, Track video, Track sound, long audioInterruptionGeneration, boolean automaticAdvanceRequested, String gallerySourceKey) {
      this.itemId = itemId;
      this.mediaIndex = mediaIndex;
      this.video = video;
      this.sound = sound;
      this.audioInterruptionGeneration = audioInterruptionGeneration;
      this.automaticAdvanceRequested = automaticAdvanceRequested;
      this.gallerySourceKey = gallerySourceKey;
    }

    boolean hasVideo() { return video != null; }
    long videoPosition() { return video == null ? 0L : video.position; }
    boolean videoRequested() { return video != null && video.requested; }
    boolean hasSound() { return sound != null; }
    long soundPosition() { return sound == null ? 0L : sound.position; }
    boolean soundRequested() { return sound != null && sound.requested; }

    Snapshot resolvedAt(long generation) {
      boolean valid = audioInterruptionGeneration == generation;
      return new Snapshot(itemId, mediaIndex, video == null ? null : new Track(video.position, video.requested && valid),
        sound == null ? null : new Track(sound.position, sound.requested && valid), generation,
        automaticAdvanceRequested && valid, gallerySourceKey);
    }

    static Snapshot fromSaved(String itemId, int mediaIndex, Long videoPosition, boolean videoRequested,
        Long soundPosition, boolean soundRequested, boolean automaticAdvanceRequested, String gallerySourceKey, long newGeneration) {
      return new Snapshot(itemId, mediaIndex,
        videoPosition == null ? null : new Track(Math.max(0L, videoPosition), videoRequested),
        soundPosition == null ? null : new Track(Math.max(0L, soundPosition), soundRequested),
        newGeneration, automaticAdvanceRequested, gallerySourceKey);
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
  private String lifecycleSoundItemId;
  private String selectedItemId;
  private String selectedGalleryItemId;
  private int selectedGalleryMediaIndex = -1;
  private String selectedGallerySourceKey;
  private ExoPlayer bindingPausedVideo;
  private ExoPlayer bindingPausedSound;
  private boolean bindingWithoutAutoplay;
  private long audioInterruptionGeneration;
  private boolean automaticAdvanceRequested = true;

  static Snapshot capture(String itemId, int mediaIndex, ExoPlayer video, ExoPlayer sound) {
    return itemId == null ? null : new Snapshot(itemId, mediaIndex, video, sound);
  }

  Snapshot captureCurrent(String itemId, int mediaIndex, ExoPlayer video, ExoPlayer sound) {
    String sourceKey = itemId != null && itemId.equals(selectedGalleryItemId) && mediaIndex == selectedGalleryMediaIndex
      ? selectedGallerySourceKey : null;
    return itemId == null ? null : new Snapshot(itemId, mediaIndex, video, sound, audioInterruptionGeneration, automaticAdvanceRequested, sourceKey);
  }

  Snapshot captureForRecreation(String itemId, int mediaIndex, ExoPlayer videoPlayer, ExoPlayer soundPlayer) {
    if (itemId == null) return null;
    boolean same = itemId.equals(selectedItemId) || (snapshot != null && itemId.equals(snapshot.itemId));
    String sourceKey = itemId.equals(selectedGalleryItemId) && mediaIndex == selectedGalleryMediaIndex ? selectedGallerySourceKey : null;
    return new Snapshot(itemId, mediaIndex,
      recreationTrack(videoPlayer, same ? video : null), recreationTrack(soundPlayer, same ? sound : null),
      audioInterruptionGeneration, automaticAdvanceRequested, sourceKey);
  }

  private Track recreationTrack(ExoPlayer player, Restore pending) {
    if (pending != null && pending.awaitingForeground && (pending.player == null || pending.player == player)) {
      return new Track(player == null ? pending.track.position : Math.max(0L, player.getCurrentPosition()), pending.requested);
    }
    return Track.capture(player);
  }

  long audioInterruptionGeneration() { return audioInterruptionGeneration; }

  void interruptAudio() {
    audioInterruptionGeneration++;
    automaticAdvanceRequested = false;
    if (video != null) video.requested = false;
    if (sound != null) sound.requested = false;
  }

  boolean allowsAutomaticAdvance() { return automaticAdvanceRequested; }

  void requestExplicitPlayback() { automaticAdvanceRequested = true; }

  void restore(Snapshot snapshot) {
    this.snapshot = snapshot;
    selectedGalleryItemId = snapshot == null ? null : snapshot.itemId;
    selectedGalleryMediaIndex = snapshot == null ? -1 : snapshot.mediaIndex;
    selectedGallerySourceKey = snapshot == null ? null : snapshot.gallerySourceKey;
    if (snapshot != null) automaticAdvanceRequested = snapshot.automaticAdvanceRequested
      && snapshot.audioInterruptionGeneration == audioInterruptionGeneration;
    video = snapshot == null || snapshot.video == null ? null : new Restore(snapshot.video);
    sound = snapshot == null || snapshot.sound == null ? null : new Restore(snapshot.sound);
    if (snapshot != null && snapshot.audioInterruptionGeneration != audioInterruptionGeneration) {
      if (video != null) video.requested = false;
      if (sound != null) sound.requested = false;
    }
    lifecycleSoundItemId = null;
  }

  void restore(Snapshot snapshot, Map<String, Integer> galleryPositions) {
    restore(snapshot);
    if (snapshot != null && snapshot.mediaIndex >= 0) galleryPositions.put(snapshot.itemId, snapshot.mediaIndex);
  }

  boolean select(String itemId) {
    boolean repeated = itemId != null && itemId.equals(selectedItemId);
    boolean restoring = snapshot != null && snapshot.itemId.equals(itemId);
    selectedItemId = itemId;
    if (snapshot != null && !snapshot.itemId.equals(itemId)) restore(null);
    if (!repeated && snapshot == null) { video = null; sound = null; lifecycleSoundItemId = null; }
    if (!repeated && !restoring) { selectedGalleryItemId = null; selectedGalleryMediaIndex = -1; selectedGallerySourceKey = null; }
    if (!repeated && !restoring && !bindingWithoutAutoplay) automaticAdvanceRequested = true;
    return repeated;
  }

  void selectGalleryMedia(String itemId, int mediaIndex) {
    selectGalleryMedia(itemId, mediaIndex, null);
  }

  void selectGalleryMedia(String itemId, int mediaIndex, String sourceKey) {
    boolean sameGallery = itemId != null && itemId.equals(selectedGalleryItemId);
    boolean changedIndex = sameGallery
      && selectedGalleryMediaIndex >= 0 && selectedGalleryMediaIndex != mediaIndex;
    boolean changedSource = sameGallery && selectedGallerySourceKey != null && sourceKey != null
      && !selectedGallerySourceKey.equals(sourceKey);
    // An overlay/lifecycle restore can share the physical segment player with
    // the next gallery entry or source. The departed source owns its video intent;
    // the independent soundtrack still belongs to the complete gallery work.
    if (changedIndex || changedSource) video = null;
    if (!sameGallery || changedIndex || sourceKey != null) selectedGallerySourceKey = sourceKey;
    selectedGalleryItemId = itemId;
    selectedGalleryMediaIndex = mediaIndex;
  }

  boolean awaitingVideo() {
    return video != null && video.awaitingForeground;
  }

  boolean awaitingSound(ExoPlayer player, String itemId) {
    return sound != null && sound.awaitingForeground && (sound.player == null || sound.player == player)
      && (lifecycleSoundItemId != null ? lifecycleSoundItemId.equals(itemId) : snapshot != null && snapshot.itemId.equals(itemId));
  }

  boolean allowsAutomaticPlayback(ExoPlayer player) {
    return automaticAdvanceRequested && player != null && player.getPlayWhenReady()
      && (video == null || video.player != player || !video.awaitingForeground);
  }

  void rewindEndedIfAllowed(ExoPlayer player) {
    if (player.getPlaybackState() == Player.STATE_ENDED && allowsAutomaticPlayback(player)) player.seekTo(0);
  }

  void pauseForLifecycle(ExoPlayer activePlayer, ExoPlayer soundPlayer) {
    if (video != null && video.player == activePlayer) video.pauseForLifecycle();
    if (sound != null && sound.player == soundPlayer) sound.pauseForLifecycle();
    else if (soundPlayer != null && selectedItemId != null && snapshot == null) {
      sound = new Restore(Track.capture(soundPlayer));
      // This is the same native track, so lifecycle restore must not seek it
      // back to a snapshot after a later user position change.
      sound.player = soundPlayer;
      lifecycleSoundItemId = selectedItemId;
    }
  }

  void bindPreservingPause(ExoPlayer videoPlayer, ExoPlayer soundPlayer, Runnable binding) {
    ExoPlayer previousVideo = bindingPausedVideo, previousSound = bindingPausedSound;
    bindingPausedVideo = videoPlayer != null && !videoPlayer.getPlayWhenReady() ? videoPlayer : null;
    bindingPausedSound = soundPlayer != null && !soundPlayer.getPlayWhenReady() ? soundPlayer : null;
    try { binding.run(); }
    finally { bindingPausedVideo = previousVideo; bindingPausedSound = previousSound; }
  }

  void bindWithoutAutoplay(Runnable binding) {
    boolean previous = bindingWithoutAutoplay;
    bindingWithoutAutoplay = true;
    automaticAdvanceRequested = false;
    try { binding.run(); }
    finally { bindingWithoutAutoplay = previous; }
  }

  boolean restoreOverlayPlayback(ExoPlayer player, boolean soundtrack, String itemId,
      long capturedAudioGeneration, boolean requested) {
    if (player == null || itemId == null || !itemId.equals(selectedItemId)
      || capturedAudioGeneration != audioInterruptionGeneration) return false;
    if (requested && player.getPlaybackState() == Player.STATE_ENDED) return false;
    // The caller has checked its captured player/source/holder. This newer
    // overlay intent supersedes a lifecycle restore saved under that overlay;
    // consuming it must never seek back to the older snapshot position.
    Restore current = new Restore(new Track(Math.max(0L, player.getCurrentPosition()), requested));
    current.player = player;
    current.awaitingForeground = false;
    if (soundtrack) { sound = current; lifecycleSoundItemId = itemId; }
    else video = current;
    player.setPlayWhenReady(requested);
    return true;
  }

  boolean start(ExoPlayer player, boolean soundtrack, String itemId, boolean visible) {
    if (player == null) return false;
    Restore restore = soundtrack ? sound : video;
    if (snapshot != null && !snapshot.itemId.equals(itemId)) restore = null;
    if (soundtrack && lifecycleSoundItemId != null && !lifecycleSoundItemId.equals(itemId)) restore = null;
    // A later replacement is a new playback request (for example explicit retry),
    // not another author return. Never seek it back to an obsolete snapshot.
    if (restore != null && restore.player != null && restore.player != player) {
      if (soundtrack) { sound = null; lifecycleSoundItemId = null; }
      else video = null;
      restore = null;
    }
    if (bindingWithoutAutoplay) {
      if (restore != null) {
        restore.requested = false;
        restore.start(player, false);
        restore.awaitingForeground = false;
      }
      player.setPlayWhenReady(false);
      return false;
    }
    if (restore != null) return restore.start(player, visible);
    if (player == (soundtrack ? bindingPausedSound : bindingPausedVideo)) return false;
    if (!visible) {
      if (soundtrack && itemId != null && itemId.equals(selectedItemId)) {
        // An explicitly selected gallery may finish loading while backgrounded.
        // Its first start remains pending until this exact owner is foreground.
        sound = new Restore(new Track(Math.max(0L, player.getCurrentPosition()), true));
        sound.player = player;
        lifecycleSoundItemId = itemId;
      }
      return false;
    }
    player.play();
    return true;
  }
}
