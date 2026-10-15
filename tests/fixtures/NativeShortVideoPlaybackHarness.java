package local.fanhao.library;

import android.os.Handler;
import androidx.media3.common.PlaybackException;
import androidx.media3.common.Player;
import androidx.media3.exoplayer.ExoPlayer;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.AbstractExecutorService;
import java.util.concurrent.TimeUnit;
import java.util.function.BooleanSupplier;

public final class NativeShortVideoPlaybackHarness {
  private static final List<String> failures = new ArrayList<>();
  private static int cases;

  public static void main(String[] args) {
    check("foreground retry preserves playback and position", () -> {
      Fixture f = new Fixture(); f.schedule(); f.handler.runPending();
      require(f.player.getPlayWhenReady(), "visible playback must resume");
      require(f.player.position == 4567L, "retry must preserve position");
    });
    check("background during delayed retry stays paused", () -> {
      Fixture f = new Fixture(); f.schedule(); f.activityResumed = false; f.player.pause(); f.handler.runPending();
      require(!f.player.getPlayWhenReady(), "retry resumed playback after onPause");
    });
    check("manual pause during retry is retained", () -> {
      Fixture f = new Fixture(); f.schedule(); f.player.pause(); f.handler.runPending();
      require(!f.player.getPlayWhenReady(), "retry discarded the user's pause");
    });
    check("stage tap pauses playback intent while buffering", () -> {
      Fixture f = new Fixture(); f.schedule(); f.toggleActivePlayback(); f.handler.runPending();
      require(!f.player.getPlayWhenReady(), "tap during buffering must pause, not restart playback");
      f.toggleActivePlayback();
      require(f.player.getPlayWhenReady(), "second tap must resume the prepared fallback");
    });
    for (boolean playWhenReady : List.of(false, true)) {
      for (boolean bufferAfterEndedSeek : List.of(false, true)) {
        check("stage tap replays ended video: playWhenReady=" + playWhenReady
            + ", seek immediately buffers=" + bufferAfterEndedSeek, () -> {
          Fixture f = new Fixture(); f.player.playbackState = Player.STATE_ENDED;
          f.player.setPlayWhenReady(playWhenReady); f.player.bufferAfterEndedSeek = bufferAfterEndedSeek;
          int seeks = f.player.seeks, plays = f.player.plays, pauses = f.player.pauses;
          f.toggleActivePlayback();
          require(f.player.seeks == seeks + 1 && f.player.position == 0L, "ended video must seek to the start");
          require(f.player.plays == plays + 1 && f.player.getPlayWhenReady(), "ended video must explicitly play");
          require(f.player.pauses == pauses, "replay must not pause after seeking out of ENDED");
          require(f.player.playbackState == (bufferAfterEndedSeek ? Player.STATE_BUFFERING : Player.STATE_ENDED),
              "seek-state fixture must preserve the configured transition");
        });
      }
      for (int state : List.of(Player.STATE_READY, Player.STATE_BUFFERING)) {
        check("stage tap toggles non-ended playback: state=" + state + ", playWhenReady=" + playWhenReady, () -> {
          Fixture f = new Fixture(); f.player.playbackState = state; f.player.setPlayWhenReady(playWhenReady);
          int seeks = f.player.seeks, plays = f.player.plays, pauses = f.player.pauses;
          f.toggleActivePlayback();
          require(f.player.getPlayWhenReady() != playWhenReady, "stage tap must toggle non-ended playback intent");
          require(f.player.seeks == seeks && f.player.position == 4567L, "pause/resume must not rewind non-ended video");
          require(f.player.plays == plays + (playWhenReady ? 0 : 1), "resume must call play only for paused intent");
          require(f.player.pauses == pauses + (playWhenReady ? 1 : 0), "pause must respect playing intent even when buffering");
        });
      }
    }
    check("current video change blocks stale playback", () -> {
      Fixture f = new Fixture(); f.schedule(); f.currentIndex = 1; f.handler.runPending();
      require(!f.player.getPlayWhenReady(), "non-current player was restarted");
    });
    check("author overlay blocks delayed playback", () -> {
      Fixture f = new Fixture(); f.schedule(); f.authorOverlay = new Object(); f.handler.runPending();
      require(!f.player.getPlayWhenReady(), "overlay-hidden player was restarted");
    });
    check("comments overlay blocks delayed playback", () -> {
      Fixture f = new Fixture(); f.schedule(); f.comments = true; f.handler.runPending();
      require(!f.player.getPlayWhenReady(), "comments-hidden player was restarted");
    });
    check("finishing activity blocks playback", () -> {
      Fixture f = new Fixture(); f.schedule(); f.finishing = true; f.handler.runPending();
      require(!f.player.getPlayWhenReady(), "finishing activity restarted playback");
    });
    check("destroying activity blocks playback", () -> {
      Fixture f = new Fixture(); f.schedule(); f.destroying = true; f.handler.runPending();
      require(!f.player.getPlayWhenReady(), "destroying activity restarted playback");
    });
    check("replaced active player blocks old playback", () -> {
      Fixture f = new Fixture(); f.schedule(); f.activePlayer = new ExoPlayer(); f.handler.runPending();
      require(!f.player.getPlayWhenReady(), "old active player restarted playback");
    });
    check("removed cache binding blocks old playback", () -> {
      Fixture f = new Fixture(); f.schedule(); f.playerCache.clear(); f.handler.runPending();
      require(!f.player.getPlayWhenReady(), "unbound player restarted playback");
    });
    check("background error does not autoplay initial fallback", () -> {
      Fixture f = new Fixture(); f.activityResumed = false; f.player.pause(); f.handle();
      require(!f.player.getPlayWhenReady(), "initial fallback restarted background playback");
    });
    check("return before retry uses current resume intent", () -> {
      Fixture f = new Fixture(); f.schedule(); f.activityResumed = false; f.player.pause();
      f.activityResumed = true; f.player.play(); f.handler.runPending();
      require(f.player.getPlayWhenReady(), "normal lifecycle resume must keep playing");
    });
    check("return after background retry can play prepared media", () -> {
      Fixture f = new Fixture(); f.schedule(); f.activityResumed = false; f.player.pause(); f.handler.runPending();
      require(!f.player.getPlayWhenReady(), "must remain paused until resume");
      f.activityResumed = true; f.player.play();
      require(f.player.getPlayWhenReady() && f.player.prepares == 2, "resume must retain prepared fallback");
    });
    check("release cancels retry without touching released player", () -> {
      Fixture f = new Fixture(); f.schedule(); release(f.fallback, f.player);
      require(f.player.released, "controller must release the native player");
      require(f.handler.pending.isEmpty(), "release must remove the scheduled callback");
      int operations = f.player.operations; f.handler.runPending();
      require(f.player.operations == operations, "retry touched a released player");
      require(f.handler.pending.isEmpty(), "released retry must not be queued");
    });
    check("same-id rebind cancels obsolete retry", () -> {
      Fixture f = new Fixture(); f.schedule();
      f.fallback.mediaUri(f.player, new ShortVideoItem("other"));
      f.fallback.mediaUri(f.player, f.item);
      int prepares = f.player.prepares; f.handler.runPending();
      require(f.player.prepares == prepares, "A-to-B-to-A rebind replayed the old retry");
    });
    check("duplicate errors keep one bounded retry", () -> {
      Fixture f = new Fixture(); f.schedule(); f.handle();
      require(f.handler.pending.size() == 1, "same player must have only one pending retry");
      f.handler.runPending();
      for (int attempt = 2; attempt <= 4; attempt++) {
        require(f.handle(), "retry within budget must be accepted"); f.handler.runPending();
      }
      require(!f.handle(), "fifth automatic retry must be rejected");
    });
    for (String overlay : List.of("comments", "search")) {
      check(overlay + " restores buffering playback intent", () -> {
        Fixture f = new Fixture();
        require(!f.player.isPlaying(), "fixture must be buffering, not playing");
        Runnable close = f.openOverlay(overlay);
        require(!f.player.getPlayWhenReady(), "overlay must pause buffering playback");
        close.run();
        require(f.player.getPlayWhenReady(), "closing overlay lost buffering playback intent");
      });
      check(overlay + " closes before retry and preserves playback intent", () -> {
        Fixture f = new Fixture(); f.schedule();
        Runnable close = f.openOverlay(overlay); close.run(); f.handler.runPending();
        require(f.player.getPlayWhenReady(), "overlay round trip lost delayed-retry playback intent");
        require(f.player.position == 4567L && f.player.prepares == 2, "retry must retain media and position");
      });
      check(overlay + " closes after retry and resumes prepared fallback", () -> {
        Fixture f = new Fixture(); f.schedule();
        Runnable close = f.openOverlay(overlay); f.handler.runPending();
        require(!f.player.getPlayWhenReady(), "retry must stay paused under overlay");
        close.run();
        require(f.player.getPlayWhenReady(), "closing overlay must restore original playback intent");
        require(f.player.prepares == 2, "close must reuse the prepared fallback");
      });
      check(overlay + " preserves manual pause while buffering", () -> {
        Fixture f = new Fixture(); f.player.pause(); f.openOverlay(overlay).run();
        require(!f.player.getPlayWhenReady(), "overlay discarded manual pause");
      });
      for (boolean retryFirst : List.of(false, true)) {
        String order = retryFirst ? "retry first" : "close first";
        check(overlay + " preserves manual pause during retry: " + order, () -> {
          Fixture f = new Fixture(); f.schedule(); f.player.pause();
          Runnable close = f.openOverlay(overlay);
          if (retryFirst) f.handler.runPending();
          close.run();
          if (!retryFirst) f.handler.runPending();
          require(!f.player.getPlayWhenReady(), "overlay and retry discarded manual pause");
        });
        check(overlay + " does not restore in background: " + order, () -> {
          Fixture f = new Fixture(); f.schedule();
          Runnable close = f.openOverlay(overlay); f.activityResumed = false;
          if (retryFirst) f.handler.runPending();
          close.run();
          if (!retryFirst) f.handler.runPending();
          require(!f.player.getPlayWhenReady(), "overlay close restarted background playback");
        });
        check(overlay + " does not restore changed item: " + order, () -> {
          Fixture f = new Fixture(); f.schedule();
          Runnable close = f.openOverlay(overlay); f.currentIndex = 1;
          if (retryFirst) f.handler.runPending();
          close.run();
          require(!f.player.getPlayWhenReady(), "overlay close restarted a non-current item");
          if (!retryFirst) f.handler.runPending();
          require(!f.player.getPlayWhenReady(), "retry restarted a non-current item");
        });
      }
      check(overlay + " does not revive an ended video", () -> {
        Fixture f = new Fixture(); f.player.playbackState = Player.STATE_ENDED;
        f.openOverlay(overlay).run();
        require(!f.player.getPlayWhenReady(), "ended playback must not be revived");
      });
      check(overlay + " does not restore player reused for another item", () -> {
        Fixture f = new Fixture(); f.player.playbackState = Player.STATE_READY;
        Runnable close = f.openOverlay(overlay); f.currentIndex = 1; close.run();
        require(!f.player.getPlayWhenReady(), "same player identity must not override changed item");
      });
      check(overlay + " does not revive video ending under overlay", () -> {
        Fixture f = new Fixture(); f.player.playbackState = Player.STATE_READY;
        Runnable close = f.openOverlay(overlay); f.player.playbackState = Player.STATE_ENDED; close.run();
        require(!f.player.getPlayWhenReady(), "video that ended under overlay must not be revived");
      });
      check(overlay + " does not restore replaced player", () -> {
        Fixture f = new Fixture(); f.schedule();
        Runnable close = f.openOverlay(overlay); f.activePlayer = new ExoPlayer(); close.run(); f.handler.runPending();
        require(!f.player.getPlayWhenReady() && !f.activePlayer.getPlayWhenReady(), "overlay restarted replaced player");
      });
      check(overlay + " does not restore under author overlay", () -> {
        Fixture f = new Fixture(); f.schedule();
        Runnable close = f.openOverlay(overlay); f.authorOverlay = new Object(); close.run(); f.handler.runPending();
        require(!f.player.getPlayWhenReady(), "overlay close restarted author-hidden playback");
      });
    }
    check("comments dismissal without restore keeps video paused", () -> {
      Fixture f = new Fixture(); f.schedule(); f.openOverlay("comments");
      f.comments = false; f.resumeAfterCommentsOverlay(false); f.handler.runPending();
      require(!f.player.getPlayWhenReady(), "non-restoring dismissal restarted playback");
      require(f.commentsPausedVideo == null && !f.commentsResumeVideo, "dismissal must clear its saved intent");
    });
    for (int state : List.of(Player.STATE_READY, Player.STATE_BUFFERING, Player.STATE_ENDED)) {
      for (boolean requested : List.of(false, true)) {
        check("author return preserves video intent: state=" + state + ", requested=" + requested, () -> {
          FeedFixture f = new FeedFixture(false); ExoPlayer departed = f.activePlayer;
          departed.playbackState = state; departed.setPlayWhenReady(requested); departed.position = 12345L;
          f.showAuthorPanel(f.videos.get(0));
          require(!departed.getPlayWhenReady(), "author entry must pause the departed video");
          f.navigateBack(); f.drain();
          require(f.activePlayer != departed && departed.released, "return must exercise real player reconstruction");
          boolean expected = requested && state != Player.STATE_ENDED;
          require(f.activePlayer.getPlayWhenReady() == expected, "author return discarded pre-navigation intent");
          require(f.activePlayer.position == 12345L, "author return must restore the selected video's position");
          f.playAt(0); f.playAt(0);
          require(f.activePlayer.getPlayWhenReady() == expected, "duplicate page callbacks overwrote restored intent");
          f.toggleActivePlayback();
          require(f.activePlayer.getPlayWhenReady() != expected, "restored intent must not block explicit stage tap");
          f.playAt(0);
          require(f.activePlayer.getPlayWhenReady() != expected, "page callback reversed an explicit post-return tap");
        });
        check("author background return waits for foreground: state=" + state + ", requested=" + requested, () -> {
          FeedFixture f = new FeedFixture(false);
          f.activePlayer.playbackState = state; f.activePlayer.setPlayWhenReady(requested);
          f.showAuthorPanel(f.videos.get(0)); f.onPause(); f.navigateBack(); f.drain();
          require(!f.activePlayer.getPlayWhenReady(), "background return started playback");
          f.onResume(); f.drain();
          require(f.activePlayer.getPlayWhenReady() == (requested && state != Player.STATE_ENDED),
              "foreground failed to restore the author's saved playback intent");
        });
      }
    }
    for (boolean segment : List.of(false, true)) {
      for (boolean requested : List.of(false, true)) {
        check("author gallery return: segment=" + segment + ", requested=" + requested, () -> {
          FeedFixture f = new FeedFixture(true, segment);
          if (segment) { f.activePlayer.setPlayWhenReady(requested); f.activePlayer.position = 8123; }
          f.gallerySoundPlayer.setPlayWhenReady(requested); f.gallerySoundPlayer.position = 6789;
          f.showAuthorPanel(f.videos.get(0)); f.navigateBack(); f.drain(); f.playAt(0);
          require(f.gallerySoundPlayer.getPlayWhenReady() == requested, "gallery sound return lost pause intent");
          require(f.gallerySoundPlayer.position == 6789, "gallery sound return lost position");
          if (segment) {
            require(f.activePlayer.getPlayWhenReady() == requested, "gallery segment return lost pause intent");
            require(f.activePlayer.position == 8123, "gallery segment return lost position");
          }
        });
        check("author gallery background return: segment=" + segment + ", requested=" + requested, () -> {
          FeedFixture f = new FeedFixture(true, segment);
          if (segment) f.activePlayer.setPlayWhenReady(requested);
          f.gallerySoundPlayer.setPlayWhenReady(requested);
          f.showAuthorPanel(f.videos.get(0)); f.onPause(); f.navigateBack(); f.drain();
          require(!f.gallerySoundPlayer.getPlayWhenReady(), "gallery sound started in background");
          if (segment) require(!f.activePlayer.getPlayWhenReady(), "gallery segment started in background");
          f.onResume(); f.drain();
          require(f.gallerySoundPlayer.getPlayWhenReady() == requested, "foreground discarded gallery sound pause");
          if (segment) require(f.activePlayer.getPlayWhenReady() == requested, "foreground discarded gallery segment pause");
        });
      }
    }
    check("author saved pause does not leak into another video", () -> {
      FeedFixture f = new FeedFixture(false); f.activePlayer.pause();
      f.showAuthorPanel(f.videos.get(0)); f.navigateBack(); f.drain();
      f.videos.add(new ShortVideoItem("second")); f.adapter.notifyDataSetChanged(); f.playAt(1);
      require(f.activePlayer.getPlayWhenReady(), "newly selected video must keep existing autoplay behavior");
    });
    check("same index with another item ID invalidates the author snapshot", () -> {
      FeedFixture f = new FeedFixture(false); f.activePlayer.pause();
      f.showAuthorPanel(f.videos.get(0)); f.navigateBack(); f.drain();
      f.videos.set(0, new ShortVideoItem("replacement")); f.playAt(0);
      require(f.activePlayer.getPlayWhenReady(), "old item pause leaked through its reused feed index");
    });
    for (boolean deleteCurrent : List.of(false, true)) {
      check("author return resolves item identity after deletion: current deleted=" + deleteCurrent, () -> {
        FeedFixture f = new FeedFixture(false);
        f.videos.add(new ShortVideoItem("selected")); f.videos.add(new ShortVideoItem("after"));
        f.adapter.notifyDataSetChanged(); f.playAt(1); f.activePlayer.pause(); f.activePlayer.seekTo(27000);
        f.showAuthorPanel(f.videos.get(1));
        FeedScreenState previous = (FeedScreenState) f.navigationStack.get(0);
        previous.items.remove(deleteCurrent ? 1 : 0);
        f.navigateBack(); f.drain();
        require(f.videos.get(f.currentIndex).id.equals(deleteCurrent ? "after" : "selected"),
            "back-stack return chose a stale numeric index instead of the surviving selected item");
        require(f.activePlayer.getPlayWhenReady() == deleteCurrent,
            "deleted item's pause must be dropped, surviving item's pause must be retained");
        if (!deleteCurrent) require(f.activePlayer.position == 27000, "surviving item's playback position was lost");
      });
    }
    check("restored user seek and pause survive duplicate callbacks and lifecycle", () -> {
      FeedFixture f = new FeedFixture(false);
      f.showAuthorPanel(f.videos.get(0)); f.navigateBack(); f.drain();
      f.activePlayer.seekTo(23456); f.toggleActivePlayback(); f.playAt(0); f.onPause(); f.onResume(); f.drain();
      require(!f.activePlayer.getPlayWhenReady(), "lifecycle overwrote the user's new pause");
      require(f.activePlayer.position == 23456, "return snapshot overwrote the user's new seek");
      f.toggleActivePlayback(); f.onPause(); f.onResume(); f.drain();
      require(f.activePlayer.getPlayWhenReady(), "lifecycle discarded the user's explicit resume");
      require(f.activePlayer.position == 23456, "explicit resume rewound the user's seek");
    });
    check("paused author return refreshes progress when duration becomes ready", () -> {
      FeedFixture f = new FeedFixture(false); f.activePlayer.seekTo(30000); f.activePlayer.pause();
      f.showAuthorPanel(f.videos.get(0)); f.navigateBack(); f.drain(); f.drain();
      require(!f.activePlayer.getPlayWhenReady(), "progress refresh must not start the paused video");
      require(f.attachedHolders.get(0).progressTrack.alpha == 0f, "duration must initially be unknown");
      f.activePlayer.duration = 60000; f.activePlayer.playbackState = Player.STATE_READY;
      f.videoStateChanged(f.activePlayer, Player.STATE_READY); f.drain(); f.drain();
      require(f.attachedHolders.get(0).progressTrack.alpha == 1f, "paused restored progress remained invisible after READY");
      require(f.attachedHolders.get(0).progressFill.scaleX == 0.5f, "paused restored progress failed to show the saved position");
      require(!f.activePlayer.getPlayWhenReady(), "revealing paused progress changed playback intent");
    });
    check("pending author restore cannot start behind comments", () -> {
      FeedFixture f = new FeedFixture(false);
      f.showAuthorPanel(f.videos.get(0)); f.onPause(); f.navigateBack(); f.drain();
      f.comments = true; f.onResume(); f.playAt(0); f.drain();
      require(!f.activePlayer.getPlayWhenReady(), "pending restore bypassed the comments visibility gate");
      f.comments = false; f.onResume(); f.drain();
      require(f.activePlayer.getPlayWhenReady(), "hidden restore should remain pending until it is visible");
    });
    for (boolean gallery : List.of(false, true)) {
      check("restored ended seek cannot auto-advance: gallery=" + gallery, () -> {
        FeedFixture f = new FeedFixture(gallery);
        if (gallery) f.videos.get(0).galleryItems.add(new GalleryMedia(true));
        else { f.videos.add(new ShortVideoItem("next")); f.adapter.notifyDataSetChanged(); }
        f.autoNext = true;
        f.activePlayer.position = 4567; f.activePlayer.playbackState = Player.STATE_ENDED;
        f.activePlayer.setPlayWhenReady(true); f.nextPlayerEndAt = 4567;
        f.showAuthorPanel(f.videos.get(0)); f.navigateBack(); f.drain(); f.drain();
        require(f.activePlayer.getPlaybackState() == Player.STATE_ENDED, "seek must exercise a synchronous end callback");
        require(!f.activePlayer.getPlayWhenReady(), "ended snapshot was restarted by its state listener");
        require(f.pager.getCurrentItem() == 0, "restored end callback advanced the feed");
        if (gallery) require(f.attachedHolders.get(0).galleryIndex == 0, "restored end callback advanced gallery media");
        f.playAt(0); f.drain();
        require(f.activePlayer.position == 4567 && !f.activePlayer.getPlayWhenReady(),
            "duplicate page callback rewound a restored ended video");
        f.toggleActivePlayback();
        require(f.activePlayer.getPlayWhenReady() && f.activePlayer.position == 0, "explicit replay must still rewind and play");
      });
    }
    check("gallery segment and sound retain independent intent", () -> {
      FeedFixture f = new FeedFixture(true); f.activePlayer.pause();
      f.showAuthorPanel(f.videos.get(0)); f.navigateBack(); f.drain();
      require(!f.activePlayer.getPlayWhenReady() && f.gallerySoundPlayer.getPlayWhenReady(),
          "segment pause must not replace the independent soundtrack intent");
      f.onPause(); f.onResume(); f.drain();
      require(!f.activePlayer.getPlayWhenReady() && f.gallerySoundPlayer.getPlayWhenReady(),
          "lifecycle combined independent gallery playback intentions");
    });
    check("switching gallery media relinquishes the old segment snapshot", () -> {
      FeedFixture f = new FeedFixture(true); f.activePlayer.pause(); f.activePlayer.position = 17000;
      f.videos.get(0).galleryItems.add(new GalleryMedia(true));
      f.showAuthorPanel(f.videos.get(0)); f.navigateBack(); f.drain();
      f.bindGallery(f.attachedHolders.get(0), f.videos.get(0), 1, 1);
      require(f.activePlayer.getPlayWhenReady(), "new gallery media inherited the departed segment's pause");
      f.activePlayer.seekTo(29000);
      f.bindGallery(f.attachedHolders.get(0), f.videos.get(0), 0, -1);
      require(f.activePlayer.position == 29000, "returning to a gallery index revived an obsolete restore seek");
    });
    check("later player replacement keeps explicit retry behavior without stale seek", () -> {
      FeedFixture f = new FeedFixture(false); f.activePlayer.position = 18000; f.activePlayer.pause();
      f.showAuthorPanel(f.videos.get(0)); f.navigateBack(); f.drain();
      ExoPlayer departed = f.activePlayer; departed.release();
      f.activePlayer = null; f.playerCache.clear(); f.playAt(0);
      require(f.activePlayer.getPlayWhenReady(), "explicit retry should keep its existing autoplay policy");
      require(f.activePlayer.position == 4567, "replacement player received the obsolete author-return seek");
    });
    check("offscreen gallery binding cannot consume another item's restore", () -> {
      FeedFixture f = new FeedFixture(false); f.activePlayer.position = 22000; f.activePlayer.pause();
      f.showAuthorPanel(f.videos.get(0)); f.navigateBack();
      ShortVideoItem other = new ShortVideoItem("offscreen-gallery"); other.galleryItems.add(new GalleryMedia(true));
      f.videos.add(other); f.adapter.notifyDataSetChanged();
      f.bindGallery(f.attachedHolders.get(1), other, 0, 0); f.drain();
      require(!f.activePlayer.getPlayWhenReady(), "offscreen gallery stole the restored pause binding");
      require(f.activePlayer.position == 22000, "offscreen gallery consumed another item's restored position");
    });
    for (boolean gallery : List.of(false, true)) {
      check("released restored players are not read during lifecycle: gallery=" + gallery, () -> {
        FeedFixture f = new FeedFixture(gallery);
        f.showAuthorPanel(f.videos.get(0)); f.navigateBack(); f.drain();
        ExoPlayer released = f.activePlayer; f.releaseAllPlayers(); int operations = released.operations;
        f.onPause(); f.onResume(); f.drain();
        require(released.operations == operations, "return session touched its released player on lifecycle transition");
      });
    }
    check("back-stack snapshot is immutable across another feed's playback", () -> {
      FeedFixture f = new FeedFixture(false); f.activePlayer.position = 25000; f.activePlayer.pause();
      f.showAuthorPanel(f.videos.get(0));
      AuthorScreenState author = (AuthorScreenState) f.currentScreen;
      FeedPage page = new FeedPage(); page.items.add(new ShortVideoItem("author-work"));
      f.openAuthorVideo(page.items.get(0), page, author); f.drain();
      f.activePlayer.seekTo(32000);
      f.navigateBack(); f.navigateBack(); f.drain();
      require(f.videos.get(0).id.equals("feed-video") && !f.activePlayer.getPlayWhenReady(),
          "nested author work navigation overwrote the departed feed's pause");
      require(f.activePlayer.position == 25000, "nested author work navigation overwrote the departed feed's seek");
    });
    for (boolean segment : List.of(false, true)) {
      check("nested author feed preserves the outer gallery page: segment=" + segment, () -> {
        FeedFixture f = new FeedFixture(true, segment);
        ShortVideoItem item = f.videos.get(0); item.galleryItems.add(new GalleryMedia(segment));
        if (segment) { f.activePlayer.pause(); f.activePlayer.seekTo(26000); }
        f.gallerySoundPlayer.pause(); f.gallerySoundPlayer.seekTo(21000);
        f.showAuthorPanel(item); AuthorScreenState author = (AuthorScreenState) f.currentScreen;
        FeedPage page = new FeedPage(); page.items.add(item);
        f.openAuthorVideo(item, page, author); f.drain();
        f.bindGallery(f.attachedHolders.get(0), item, 1, 1);
        require(f.galleryPositions.get(item.id) == 1, "inner gallery must update the shared page map");
        f.navigateBack(); f.navigateBack(); f.drain();
        require(f.attachedHolders.get(0).galleryIndex == 0 && f.galleryPositions.get(item.id) == 0,
            "inner author feed overwrote the outer gallery page");
        require(!f.gallerySoundPlayer.getPlayWhenReady() && f.gallerySoundPlayer.position == 21000,
            "outer gallery soundtrack snapshot was lost");
        if (segment) require(!f.activePlayer.getPlayWhenReady() && f.activePlayer.position == 26000,
            "outer gallery segment snapshot was lost");
        f.bindGallery(f.attachedHolders.get(0), item, 1, 1);
        require(f.galleryPositions.get(item.id) == 1, "return snapshot must not block subsequent user page selection");
      });
    }
    check("direct author entry has no departed feed playback and selected work autoplays", () -> {
      FeedFixture f = new FeedFixture(false); f.activePlayer.pause();
      f.openInitialAuthorScreen(0);
      require(f.navigationStack.isEmpty(), "direct author entry must not create a phantom back-stack entry");
      AuthorScreenState author = (AuthorScreenState) f.currentScreen;
      require(!author.hasPlaybackContext, "direct author entry must not claim a playback context");
      FeedPage page = new FeedPage(); page.items.add(f.videos.get(0));
      f.openAuthorVideo(page.items.get(0), page, author); f.drain();
      require(f.activePlayer.getPlayWhenReady(), "explicit author work selection must autoplay");
    });
    if (!failures.isEmpty()) throw new AssertionError(String.join("\n", failures));
    System.out.println("native-short-video-playback: " + cases + " lifecycle/retry/replay cases passed");
  }

  private static void check(String name, Runnable action) {
    cases++;
    try { action.run(); } catch (Throwable error) { failures.add(name + ": " + error.getMessage()); }
  }

  private static void require(boolean value, String message) {
    if (!value) throw new AssertionError(message);
  }

  private static void release(NativeShortVideoPlaybackFallback fallback, ExoPlayer player) {
    fallback.releasePlayerResources(player);
  }

  private static final class Fixture extends NativeShortVideoPlaybackHost {
    final Handler handler = new Handler();
    final ExoPlayer player = new ExoPlayer();
    final ShortVideoItem item = new ShortVideoItem("fixture");
    final NativeShortVideoPlaybackFallback fallback = new NativeShortVideoPlaybackFallback(handler, new NoNetworkExecutor());
    final BooleanSupplier shouldPlay = () -> shouldResumeFallbackPlayback(0, player);

    Fixture() {
      activePlayer = player; playerCache.put(0, player);
      fallback.mediaUri(player, item); player.play();
    }
    boolean handle() { return fallback.handle(player, item, new PlaybackException(), shouldPlay); }
    void schedule() { require(handle(), "initial fallback required"); require(handle(), "retry required"); }
    Runnable openOverlay(String overlay) {
      if ("search".equals(overlay)) return pausePlaybackForFeedSearch();
      pauseForCommentsOverlay(); comments = true;
      return () -> { comments = false; resumeAfterCommentsOverlay(true); };
    }
  }

  private static final class FeedFixture extends NativeShortVideoFeedPlaybackHost {
    FeedFixture(boolean gallery) { this(gallery, true); }
    FeedFixture(boolean gallery, boolean segment) {
      ShortVideoItem item = new ShortVideoItem("feed-video");
      if (gallery) item.galleryItems.add(new GalleryMedia(segment));
      videos.add(item); adapter.notifyDataSetChanged();
      currentIndex = -1; currentScreen = captureFeedScreen(); startPlaybackAt(0); drain();
    }
  }

  private static final class NoNetworkExecutor extends AbstractExecutorService {
    public void shutdown() {}
    public List<Runnable> shutdownNow() { return List.of(); }
    public boolean isShutdown() { return false; }
    public boolean isTerminated() { return false; }
    public boolean awaitTermination(long time, TimeUnit unit) { return true; }
    public void execute(Runnable task) { /* The production report is intentionally not sent. */ }
  }
}
