// Observable Android/Media3/UI leaf doubles for actual gallery ownership methods.
export function buildGalleryOwnershipDoubles(doubles, methods, firstFrame) {
  const method = name => methods[name].replace(/private (?:void|boolean)/, value => value.replace('private ', ''));
  doubles['android/os/SystemClock.java']='package android.os; public class SystemClock { public static long elapsedRealtime(){return 1000;} }';
  doubles['android/view/View.java']='package android.view; public class View { public static final int VISIBLE=0,GONE=8; public int visibility=VISIBLE; public void setVisibility(int value){visibility=value;} }';
  doubles['local/fanhao/library/GalleryMedia.java']='package local.fanhao.library; class GalleryMedia { boolean video=true; String url="http://synthetic.invalid/gallery.mp4"; boolean isVideo(){return video;} }';
  doubles['local/fanhao/library/GallerySound.java']='package local.fanhao.library; class GallerySound {}';
  doubles['local/fanhao/library/SurfaceCoverProbe.java']=`package local.fanhao.library;
    import android.view.View; import android.net.Uri; import android.os.Handler; import android.os.SystemClock; import android.util.Log; import androidx.annotation.Nullable;
    import androidx.media3.common.MediaItem; import androidx.media3.common.Player; import androidx.media3.exoplayer.ExoPlayer; import java.util.*;
    public class SurfaceCoverProbe {
      static class Animator {Animator alpha(float n){return this;}Animator translationX(float n){return this;}Animator setDuration(int n){return this;}void start(){}void cancel(){}}
      static class Visual extends View {Animator animate(){return new Animator();}void setAlpha(float n){}void setTranslationX(float n){}}
      static class Bitmap {}
      static class Color {static final int BLACK=0;}
      static class ImageView extends Visual {enum ScaleType{FIT_CENTER,CENTER_CROP}Object tag,drawable;void setScaleType(ScaleType t){}void setImageDrawable(Object x){drawable=x;}void setBackgroundColor(int c){}void setTag(Object x){tag=x;}Object getTag(){return tag;}void setImageBitmap(Bitmap x){drawable=x;}Object getDrawable(){return drawable;}}
      static class PlayerView extends Visual { ExoPlayer player; void setPlayer(ExoPlayer p){player=p;} void setResizeMode(int mode){} }
      static class ShortVideoHolder { int index,galleryIndex; ImageView cover=new ImageView(); PlayerView galleryVideo=new PlayerView();Visual playIndicator=new Visual(),galleryCounter=new Visual(),galleryProgress=new Visual(),progressTouch=new Visual(),galleryCurrentLayer=new Visual();boolean touchActive,galleryScaling,galleryPanning,galleryDragActive,galleryDragSettling;float galleryZoomScale=1;ShortVideoHolder(int index){this.index=index;} }
      static class Pager {void post(Runnable task){throw new AssertionError("unexpected unbound holder");}}
      static final String TAG="synthetic"; final NativeShortVideoFeedPlayback feedPlayback=new NativeShortVideoFeedPlayback();
      final Map<Integer,ExoPlayer> playerCache=new HashMap<>();final Map<Integer,ShortVideoHolder> attachedHolders=new HashMap<>();
      final Set<Integer> failedPlayerIndexes=new HashSet<>();
      final Map<String,Integer> galleryPositions=new HashMap<>();final List<ShortVideoItem> videos=new ArrayList<>();final Handler mainHandler=new Handler();final Pager pager=new Pager();
      int currentIndex=3,gallerySegmentFeedIndex=-1,gallerySegmentMediaIndex=-1,pageSelectedIndex=3;long pageSelectedAtMs=1,loggedFramePageSelectedAtMs,createdAtMs;
      ExoPlayer activePlayer,gallerySegmentPlayer,gallerySoundPlayer;PlayerView gallerySegmentView;String gallerySegmentUrl="";boolean activityResumed=true,framePrefetchEnabled,loggedFirstFrame,controlsHidden,videoFitMode,comments,finishing;Object authorOverlay,playbackToolbarOverlay;
      int imageLoads,videoFrameLoads,advances,lastAdvanceIndex=-1;Runnable galleryAutoAdvanceRunnable;int galleryAutoAdvanceFeedIndex=-1,galleryAutoAdvanceMediaIndex=-1;static final int GALLERY_IMAGE_AUTO_ADVANCE_MS=5000;
      SurfaceCoverProbe(){for(int i=0;i<4;i++){videos.add(new ShortVideoItem("synthetic-"+i));attachedHolders.put(i,new ShortVideoHolder(i));}videos.get(2).galleryItems.add(new GalleryMedia());ExoPlayer p=new ExoPlayer();p.playbackState=Player.STATE_READY;p.playWhenReady=true;playerCache.put(3,p);activePlayer=p;}
      int playerIndex(ExoPlayer player){for(var entry:playerCache.entrySet())if(entry.getValue()==player)return entry.getKey();return -1;}
      ExoPlayer ensureGallerySegmentPlayer(){if(gallerySegmentPlayer==null)gallerySegmentPlayer=new ExoPlayer();return gallerySegmentPlayer;}
      GalleryMedia galleryMediaAt(ShortVideoItem item,int index){return item.galleryItems.get(index);}
      Uri cachedMediaUri(String url){return Uri.parse(url);}int activeVideoResizeMode(){return 0;}int activeRepeatMode(){return 0;}float activeVolume(){return 1f;}
      boolean commentsOpen(){return comments;}boolean isFinishing(){return finishing;}
      void hideStatus(){}void scheduleVideoPrefetch(int index){}void preparePlayersAround(int index){}void loadMoreIfNeeded(int index){}void releaseDistantPlayers(int index){}
      void stopProgressUpdates(){}void startProgressUpdates(){}void resetHolderProgress(ShortVideoHolder h){}void playGallerySound(int index,ShortVideoItem item){}
      void resetGalleryZoom(ShortVideoHolder h,boolean b){}void syncGalleryZoomCounter(ShortVideoHolder h){}void rebuildGalleryProgress(ShortVideoHolder h,int n,int index){}
      String galleryCacheKey(ShortVideoItem i,int n){return i.id+":"+n;}void loadGalleryFrame(ShortVideoHolder h,ShortVideoItem i,int n,int d){videoFrameLoads++;h.cover.setTag(galleryCacheKey(i,n));}void loadGalleryImage(ShortVideoHolder h,ShortVideoItem i,int n,int d){imageLoads++;h.cover.setTag(galleryCacheKey(i,n));}
      void prefetchGalleryMedia(ShortVideoItem i,int n){}void advanceGallerySequence(int i,int n,String source){advances++;lastAdvanceIndex=n;}int dp(int n){return n;}
      void releaseGallerySoundPlayer(){gallerySoundPlayer=null;}void applyCachedFrame(ShortVideoHolder holder,ShortVideoItem item){}ExoPlayer preparePlayerAt(int index){return playerCache.get(index);}void ensurePlayerViewAt(int index){}
      ${methods.isBoundGallery ? method('isBoundGallery') : ''}
      ${method('playAt')}
      ${method('playGallerySegment')}
      ${method('stopGallerySegmentPlayback')}
      ${method('startActivePlaybackIfVisible')}
      ${method('bindGallery')}
      ${method('scheduleGalleryAutoAdvance')}
      ${method('cancelGalleryAutoAdvance')}
      ${method('showGalleryBitmap')}
      ${firstFrame.replace('public void onRenderedFirstFrame()', 'void firstFrame(ExoPlayer preparedPlayer)')}
      static void require(boolean v,String message){if(!v)throw new AssertionError(message);}
      static int checks;static String selected;
      static void check(String name,Runnable test){if(!"all".equals(selected)&&!name.equals(selected))return;checks++;try{test.run();}catch(AssertionError error){throw new AssertionError(name+": "+error.getMessage(),error);}}
      static ShortVideoItem gallery(SurfaceCoverProbe host,int index,boolean video){ShortVideoItem item=host.videos.get(index);item.galleryItems.clear();for(int n=0;n<2;n++){GalleryMedia m=new GalleryMedia();m.video=video;m.url="http://synthetic.invalid/"+index+"/"+n;item.galleryItems.add(m);}return item;}
      static Object restoreVideo(NativeShortVideoFeedPlayback playback){try{java.lang.reflect.Field f=NativeShortVideoFeedPlayback.class.getDeclaredField("video");f.setAccessible(true);return f.get(playback);}catch(Exception error){throw new AssertionError("fixture reflection failed",error);}}
      public static void main(String[] args){
        selected=args.length==0?"all":args[0];
        check("offscreen_segment_preserves_owner",()->{
          SurfaceCoverProbe h=new SurfaceCoverProbe();ExoPlayer before=h.activePlayer;h.playGallerySegment(h.attachedHolders.get(2),h.videos.get(2),0);
          require(h.activePlayer==before&&h.gallerySegmentPlayer==null,"offscreen segment created player or stole active owner");
          require(h.gallerySegmentView==null&&h.gallerySegmentFeedIndex==-1,"offscreen segment rebound the surface");
        });
        check("first_frame_remains_uncovered",()->{
          SurfaceCoverProbe h=new SurfaceCoverProbe();ExoPlayer video=h.activePlayer;h.firstFrame(video);h.playGallerySegment(h.attachedHolders.get(2),h.videos.get(2),0);h.playAt(3);
          require(h.activePlayer==video&&video.playWhenReady,"visible video lost playback");
          require(video.prepares==0&&h.attachedHolders.get(3).cover.visibility==View.GONE,"same current video was covered again after its first frame");
        });
        check("offscreen_video_static_preview_only",()->{
          SurfaceCoverProbe h=new SurfaceCoverProbe();ExoPlayer current=h.activePlayer;h.bindGallery(h.attachedHolders.get(2),h.videos.get(2),0,0);
          require(h.videoFrameLoads==1,"offscreen video preview disappeared");
          require(h.activePlayer==current&&h.gallerySegmentPlayer==null,"RecyclerView bind started offscreen video");
        });
        check("offscreen_image_preserves_timer",()->{
          SurfaceCoverProbe h=new SurfaceCoverProbe();ShortVideoItem current=gallery(h,3,false),offscreen=gallery(h,2,false);
          h.bindGallery(h.attachedHolders.get(3),current,0,0);Runnable timer=h.galleryAutoAdvanceRunnable;h.bindGallery(h.attachedHolders.get(2),offscreen,0,0);
          require(timer!=null&&h.galleryAutoAdvanceRunnable==timer&&h.mainHandler.pending.contains(timer),"offscreen image canceled current timer");
          require(h.imageLoads==2,"offscreen image preview disappeared");
        });
        check("offscreen_binding_preserves_restore_intent",()->{
          SurfaceCoverProbe h=new SurfaceCoverProbe();ShortVideoItem item=gallery(h,2,true);ExoPlayer restored=new ExoPlayer();
          h.feedPlayback.restore(NativeShortVideoFeedPlayback.capture(item.id,0,restored,null));Object restore=restoreVideo(h.feedPlayback);
          h.bindGallery(h.attachedHolders.get(2),item,1,0);require(restoreVideo(h.feedPlayback)==restore,"offscreen bind consumed media restoration intent");
        });
        check("retired_holder_segment_rejected",()->{
          SurfaceCoverProbe h=new SurfaceCoverProbe();h.currentIndex=2;ShortVideoHolder retired=h.attachedHolders.get(2);h.attachedHolders.put(2,new ShortVideoHolder(2));
          h.playGallerySegment(retired,h.videos.get(2),0);require(h.gallerySegmentPlayer==null,"retired same-index holder started a wrong surface");
        });
        check("retired_holder_bind_rejected",()->{
          SurfaceCoverProbe h=new SurfaceCoverProbe();h.currentIndex=2;ShortVideoHolder retired=h.attachedHolders.get(2);h.attachedHolders.put(2,new ShortVideoHolder(2));
          h.bindGallery(retired,h.videos.get(2),0,0);require(h.videoFrameLoads==0&&h.gallerySegmentPlayer==null,"retired holder was rebound");
        });
        check("replaced_item_segment_rejected",()->{
          SurfaceCoverProbe h=new SurfaceCoverProbe();h.currentIndex=2;ShortVideoItem retired=h.videos.get(2);ShortVideoItem replacement=new ShortVideoItem(retired.id);replacement.galleryItems.add(new GalleryMedia());h.videos.set(2,replacement);
          h.playGallerySegment(h.attachedHolders.get(2),retired,0);require(h.gallerySegmentPlayer==null,"same id but replaced item accepted old body/surface");
        });
        check("invalid_boundaries_rejected",()->{
          SurfaceCoverProbe h=new SurfaceCoverProbe();h.playGallerySegment(null,null,0);h.bindGallery(null,null,0,0);
          for(int index:new int[]{-1,99}){ShortVideoHolder invalid=new ShortVideoHolder(index);h.playGallerySegment(invalid,h.videos.get(2),0);h.bindGallery(invalid,h.videos.get(2),0,0);}
          require(h.gallerySegmentPlayer==null,"invalid holder created a player");
        });
        check("current_video_starts_normally",()->{
          SurfaceCoverProbe h=new SurfaceCoverProbe();h.currentIndex=2;h.bindGallery(h.attachedHolders.get(2),h.videos.get(2),0,0);
          require(h.activePlayer==h.gallerySegmentPlayer&&h.gallerySegmentPlayer.playWhenReady,"selected gallery did not start");
          require(h.gallerySegmentView==h.attachedHolders.get(2).galleryVideo&&h.gallerySegmentFeedIndex==2,"selected surface not bound");
        });
        check("current_video_changes_segment",()->{
          SurfaceCoverProbe h=new SurfaceCoverProbe();h.currentIndex=2;ShortVideoItem item=gallery(h,2,true);h.bindGallery(h.attachedHolders.get(2),item,0,0);ExoPlayer player=h.activePlayer;
          h.bindGallery(h.attachedHolders.get(2),item,1,1);require(h.activePlayer==player&&player.prepares==2&&h.gallerySegmentMediaIndex==1,"explicit segment change failed");
          require(h.gallerySegmentUrl.equals(item.galleryItems.get(1).url),"wrong next media selected");
        });
        check("paused_gallery_cannot_autoplay",()->{
          SurfaceCoverProbe h=new SurfaceCoverProbe();h.currentIndex=2;h.activityResumed=false;h.bindGallery(h.attachedHolders.get(2),h.videos.get(2),0,0);
          require(h.gallerySegmentPlayer!=null&&!h.gallerySegmentPlayer.playWhenReady,"background binding autoplayed");
          h.activityResumed=true;h.startActivePlaybackIfVisible();require(h.gallerySegmentPlayer.playWhenReady,"foreground selected gallery cannot resume");
        });
        check("overlay_gallery_cannot_autoplay",()->{
          for(int reason=0;reason<3;reason++){SurfaceCoverProbe h=new SurfaceCoverProbe();h.currentIndex=2;if(reason==0)h.authorOverlay=new Object();else if(reason==1)h.comments=true;else h.finishing=true;
            h.bindGallery(h.attachedHolders.get(2),h.videos.get(2),0,0);require(!h.gallerySegmentPlayer.playWhenReady,"overlay/finishing binding autoplayed");}
        });
        check("current_image_timer_and_change",()->{
          SurfaceCoverProbe h=new SurfaceCoverProbe();ShortVideoItem item=gallery(h,3,false);h.bindGallery(h.attachedHolders.get(3),item,0,0);Runnable first=h.galleryAutoAdvanceRunnable;
          require(first!=null&&h.mainHandler.pending.contains(first),"current image lacks automatic advance");
          h.bindGallery(h.attachedHolders.get(3),item,1,1);require(h.galleryAutoAdvanceRunnable!=null&&h.galleryAutoAdvanceRunnable!=first&&!h.mainHandler.pending.contains(first)&&h.galleryAutoAdvanceMediaIndex==1,"manual image change did not replace timer");
        });
        check("current_timer_advances_normally",()->{
          SurfaceCoverProbe h=new SurfaceCoverProbe();ShortVideoItem item=gallery(h,3,false);h.bindGallery(h.attachedHolders.get(3),item,1,0);h.mainHandler.runPending();
          require(h.advances==1&&h.lastAdvanceIndex==1&&h.galleryAutoAdvanceRunnable==null,"current image timer did not advance once");
        });
        check("offscreen_schedule_does_not_cancel",()->{
          SurfaceCoverProbe h=new SurfaceCoverProbe();ShortVideoItem item=gallery(h,3,false),offscreen=gallery(h,2,false);h.bindGallery(h.attachedHolders.get(3),item,0,0);Runnable timer=h.galleryAutoAdvanceRunnable;
          h.scheduleGalleryAutoAdvance(h.attachedHolders.get(2),offscreen,0);require(h.galleryAutoAdvanceRunnable==timer,"offscreen schedule canceled current timer");
        });
        check("retired_schedule_cannot_replace_timer",()->{
          SurfaceCoverProbe h=new SurfaceCoverProbe();ShortVideoItem item=gallery(h,3,false);ShortVideoHolder current=h.attachedHolders.get(3);h.bindGallery(current,item,0,0);Runnable timer=h.galleryAutoAdvanceRunnable;
          h.scheduleGalleryAutoAdvance(new ShortVideoHolder(3),item,1);require(h.galleryAutoAdvanceRunnable==timer,"retired schedule replaced current timer");
        });
        check("old_timer_cannot_consume_new_timer",()->{
          SurfaceCoverProbe h=new SurfaceCoverProbe();ShortVideoItem item=gallery(h,3,false);h.bindGallery(h.attachedHolders.get(3),item,0,0);Runnable old=h.galleryAutoAdvanceRunnable;
          h.bindGallery(h.attachedHolders.get(3),item,1,1);Runnable current=h.galleryAutoAdvanceRunnable;old.run();
          require(h.galleryAutoAdvanceRunnable==current&&h.galleryAutoAdvanceMediaIndex==1&&h.advances==0,"late old callback consumed current timer");
          current.run();require(h.advances==1,"current timer could not finish after stale callback");
        });
        check("timer_cannot_advance_recycled_holder",()->{
          SurfaceCoverProbe h=new SurfaceCoverProbe();ShortVideoItem item=gallery(h,3,false);h.bindGallery(h.attachedHolders.get(3),item,0,0);Runnable timer=h.galleryAutoAdvanceRunnable;
          h.attachedHolders.put(3,new ShortVideoHolder(3));timer.run();require(h.advances==0,"old timer advanced newly attached holder");
        });
        check("timer_cannot_advance_replaced_item",()->{
          SurfaceCoverProbe h=new SurfaceCoverProbe();ShortVideoItem item=gallery(h,3,false);h.bindGallery(h.attachedHolders.get(3),item,0,0);Runnable timer=h.galleryAutoAdvanceRunnable;
          ShortVideoItem replacement=new ShortVideoItem(item.id);replacement.galleryItems.addAll(item.galleryItems);h.videos.set(3,replacement);timer.run();require(h.advances==0,"old timer advanced replaced same-id item");
        });
        check("timer_after_page_change_does_not_advance",()->{
          SurfaceCoverProbe h=new SurfaceCoverProbe();ShortVideoItem item=gallery(h,3,false);h.bindGallery(h.attachedHolders.get(3),item,0,0);Runnable timer=h.galleryAutoAdvanceRunnable;h.currentIndex=2;timer.run();require(h.advances==0,"old page advanced offscreen");
        });
        check("late_bitmap_preserves_current_timer",()->{
          SurfaceCoverProbe h=new SurfaceCoverProbe();ShortVideoItem item=gallery(h,3,false),other=gallery(h,2,false);h.bindGallery(h.attachedHolders.get(2),other,0,0);h.bindGallery(h.attachedHolders.get(3),item,0,0);Runnable timer=h.galleryAutoAdvanceRunnable;
          Bitmap bitmap=new Bitmap();h.showGalleryBitmap(h.attachedHolders.get(2),other,0,bitmap,0);require(h.galleryAutoAdvanceRunnable==timer,"late preview canceled current timer");
          require(h.attachedHolders.get(2).cover.drawable==bitmap,"valid static preview was lost");
        });
        check("retired_bitmap_does_not_paint",()->{
          SurfaceCoverProbe h=new SurfaceCoverProbe();ShortVideoItem item=gallery(h,3,false);ShortVideoHolder old=h.attachedHolders.get(3);h.bindGallery(old,item,0,0);h.attachedHolders.put(3,new ShortVideoHolder(3));
          h.showGalleryBitmap(old,item,0,new Bitmap(),0);require(old.cover.drawable==null,"late bitmap painted a retired holder");
        });
        check("current_bitmap_and_tag_identity",()->{
          SurfaceCoverProbe h=new SurfaceCoverProbe();ShortVideoItem item=gallery(h,3,false);ShortVideoHolder holder=h.attachedHolders.get(3);h.bindGallery(holder,item,0,0);Bitmap bitmap=new Bitmap();h.showGalleryBitmap(holder,item,0,bitmap,0);require(holder.cover.drawable==bitmap,"current bitmap did not render");
          h.showGalleryBitmap(holder,item,1,new Bitmap(),0);require(holder.cover.drawable==bitmap,"stale index changed bitmap");
          holder.cover.setTag("wrong");h.showGalleryBitmap(holder,item,0,new Bitmap(),0);require(holder.cover.drawable==bitmap,"stale tag changed bitmap");
        });
        require(checks>0,"unknown selected case");System.out.println("native-gallery-ownership: "+checks+" actual-method cases passed");
      }
    }`;
  return doubles;
}
