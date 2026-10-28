package local.fanhao.library;
import java.io.*;import java.util.*;import java.net.*;import java.nio.file.*;import java.util.concurrent.*;import java.util.function.BooleanSupplier;import com.sun.net.httpserver.HttpServer;import org.json.*;import android.os.Bundle;import android.os.SystemClock;import android.util.Log;import android.net.Uri;import androidx.media3.exoplayer.ExoPlayer;import androidx.media3.common.MediaItem;import androidx.media3.common.PlaybackException;

final class CheckpointHost extends NativeShortVideoFeedPlaybackHost {
  /* ACTIVITY_CONSTANTS */
  static final int MODE_PRIVATE=0,FEED_PAGE_LIMIT=18;
  final Intent intent;final File directory;String apiBaseUrl;long createdAtMs;
  NativeShortVideoActionPreferences actionPreferences;
  final NativeShortVideoActionSnapshots actionSnapshots=new NativeShortVideoActionSnapshots();
  NativeShortVideoDeleteController deleteController;
  NativeShortVideoCheckpoint.Recovery checkpointRecovery;
  int networkReads;String lastStatus="";Runnable retryAction;
  final Map<Integer,PlayerView> playerViews=new HashMap<>();
  CheckpointHost(Intent intent,File directory){this.intent=intent;this.directory=directory;activityResumed=false;currentIndex=-1;}
  Intent getIntent(){return intent;}Object getSharedPreferences(String name,int mode){return new Object();}
  File getCacheDir(){return directory;}File getFilesDir(){return directory;}File getNoBackupFilesDir(){return directory;}
  void requestWindowFeature(int value){}void setRequestedOrientation(int value){}void readControlPreferences(){}void initializeAudioInterruptionHandling(){}void initializeVideoCache(){}
  void initializeScreenAwake(){}
  String pagedFeedUrl(String url,int offset,String cursor,int limit){return url;}
  String apiBase(){return apiBaseUrl==null?"":apiBaseUrl;}void buildUi(){adapter.notifyDataSetChanged();}
  String authorFeedUrl(ShortVideoItem seed,int offset,int limit,String sort){return "http://fixture.invalid:29998/api/short-videos?author="+seed.authorSecUid;}
  void loadFeedAsync(String url,int index){networkReads++;}void showStatus(String message){lastStatus=message;}
  void showPersistentDeleteStatus(String message,String label,Runnable retry){lastStatus=message;retryAction=retry;}void clearPersistentDeleteStatus(){retryAction=null;}void showTransientStatus(String message){lastStatus=message;}
  NativeShortVideoDeleteController createDeleteController(){return new NativeShortVideoDeleteController();}
  void acceptServerActionSnapshots(List<ShortVideoItem> items,long revision){actionSnapshots.acceptFeed(items,revision);}
  ExoPlayer preparePlayerAt(int index){if(videos.get(index).isGallery())return null;return playerCache.computeIfAbsent(index,key->{ExoPlayer value=new ExoPlayer();setPlayerMedia(value,videos.get(index));return value;});}
  /* ACTIVITY_METHODS */
  Bundle save(){Bundle out=new Bundle();onSaveInstanceState(out);return new Bundle(out);}
  void launch(Bundle saved){onCreate(saved);onResume();for(int i=0;i<4;i++)drain();}
  void select(int index){selectForTest(index);for(int i=0;i<3;i++)drain();}
  String id(){return currentIndex>=0&&currentIndex<videos.size()?videos.get(currentIndex).id:"";}
}
final class Intent {
  final Map<String,Object> values=new HashMap<>();
  Intent put(String key,Object value){values.put(key,value);return this;}
  String getStringExtra(String key){return (String)values.get(key);}int getIntExtra(String key,int fallback){return values.get(key) instanceof Number?((Number)values.get(key)).intValue():fallback;}
  boolean getBooleanExtra(String key,boolean fallback){return values.get(key) instanceof Boolean?(Boolean)values.get(key):fallback;}
}
final class Window{static final int FEATURE_NO_TITLE=1;}
final class ActivityInfo{static final int SCREEN_ORIENTATION_PORTRAIT=1;}
final class PlayerView{void setPlayer(ExoPlayer player){}}
final class NativeShortVideoActionPreferences{NativeShortVideoActionPreferences(Object prefs,String scope){}void reconcile(List<ShortVideoItem> items){}void clearDeleted(List<ShortVideoItem> items,Set<String> ids){}}
final class NativeShortVideoDeleteController{void restorePending(String scope){}}

public final class NativeShortVideoCheckpointHarness {
  static int cases;static final List<String> failures=new ArrayList<>();
  static void check(boolean value,String message){if(!value)throw new AssertionError(message);}
  interface Case{void run()throws Exception;}
  static void test(String name,Case work){String filter=System.getProperty("checkpoint.filter","");if(!filter.isEmpty()&&!name.contains(filter))return;cases++;try{work.run();}catch(Throwable error){failures.add(name+": "+error);}}
  static JSONObject row(String id){return new JSONObject().put("id",id).put("streamUrl","/media/short-video/"+id).put("title",id).put("author",new JSONObject().put("name","fixture").put("secUid","author"));}
  static Intent intent(JSONObject...rows){return new Intent().put("baseUrl","http://fixture.invalid:29998").put("feedUrl","http://fixture.invalid:29998/api/short-videos?source=authors").put("startId","A").put("videosJson",new JSONObject().put("schemaVersion",1).put("videos",new JSONArray(Arrays.asList(rows))).toString());}
  static JSONObject gallery(String id){return row(id).put("mediaType","gallery").put("galleryItems",new JSONArray().put(new JSONObject().put("type","image").put("url","/image/0")).put(new JSONObject().put("type","video").put("url","/segment/1").put("posterUrl","/poster/1"))).put("sound",new JSONObject().put("previewUrl","/sound/"+id).put("localAvailable",true));}
  static ShortVideoItem item(JSONObject row){return ShortVideoFeedContract.itemFromJson(row,"http://fixture.invalid:29998","");}
  static void requested(CheckpointHost host,boolean play){if(host.activePlayer.getPlayWhenReady()!=play)host.toggleActivePlayback();}
  static CheckpointHost launch(Intent intent,Bundle saved,File directory){CheckpointHost host=new CheckpointHost(intent,directory);host.launch(saved);return host;}
  static void blocked(CheckpointHost host){check(host.currentIndex<0&&host.activePlayer==null,"invalid checkpoint must not cold-start the original A");check(!host.lastStatus.isEmpty(),"invalid checkpoint must leave actionable feedback");}
  static File checkpointFile(CheckpointHost host,Bundle saved){return new File(host.checkpointDirectory(),saved.getString(CheckpointHost.CHECKPOINT_KEY)+".state");}
  static void waitFor(CheckpointHost host,BooleanSupplier ready)throws Exception{long until=System.nanoTime()+TimeUnit.SECONDS.toNanos(4);do{host.drain();if(ready.getAsBoolean())return;Thread.sleep(2);}while(System.nanoTime()<until);check(ready.getAsBoolean(),"controlled read/restore did not settle");}
  static final class PrivateHttp implements AutoCloseable{
    final HttpServer server;volatile int status=200;volatile JSONObject response=row("A");volatile String expectedId="A",envelope="video";volatile CountDownLatch entered,allow;
    final List<String> requests=Collections.synchronizedList(new ArrayList<>());
    PrivateHttp()throws Exception{server=HttpServer.create(new InetSocketAddress("127.0.0.1",0),0);server.createContext("/",exchange->{
      try{String request=exchange.getRequestMethod()+" "+exchange.getRequestURI().getRawPath()+(exchange.getRequestURI().getRawQuery()==null?"":"?"+exchange.getRequestURI().getRawQuery());requests.add(request);
        if(!request.equals("GET /api/short-videos/videos/"+Uri.encode(expectedId))){exchange.sendResponseHeaders(404,-1);return;}
        if(entered!=null)entered.countDown();if(allow!=null)allow.await(3,TimeUnit.SECONDS);JSONObject out=new JSONObject();if(!envelope.equals("missing"))out.put("video",envelope.equals("null")?JSONObject.NULL:response);
        byte[] body=out.toString().getBytes(java.nio.charset.StandardCharsets.UTF_8);exchange.sendResponseHeaders(status,body.length);exchange.getResponseBody().write(body);
      }catch(Exception ignored){}finally{exchange.close();}
    });server.start();}
    String base(){return "http://127.0.0.1:"+server.getAddress().getPort();}public void close(){server.stop(0);}
  }
  static Intent boundedIntent(PrivateHttp http){return intent(row("A").put("title","x".repeat(NativeShortVideoCheckpoint.MAX_STRING_BYTES+1))).put("baseUrl",http.base()).put("feedUrl",http.base()+"/api/short-videos?source=authors");}
  static CheckpointHost recovery(Intent original,File directory){CheckpointHost old=launch(original,null,directory);if(old.activePlayer!=null)old.activePlayer.seekTo(19000);if(old.gallerySoundPlayer!=null)old.gallerySoundPlayer.seekTo(9000);old.onPause();CheckpointHost restored=launch(original,old.save(),directory);blocked(restored);check(restored.checkpointRecovery!=null&&restored.retryAction!=null,"oversize state must offer explicit current-work recovery");return restored;}
  public static void main(String[] args){File directory=new File(args[0],"private-checkpoints");directory.mkdirs();
    for(String selected:List.of("A","B"))test("actual new instance video "+selected,()->{
      Intent original=intent(row("A"),row("B"));CheckpointHost old=launch(original,null,directory);old.select(selected.equals("A")?0:1);old.activePlayer.seekTo(19000);old.toggleActivePlayback();old.onPause();Bundle saved=old.save();
      CheckpointHost restored=launch(original,saved,directory);
      System.out.println("video before="+selected+"/19000/paused after="+restored.id()+"/"+restored.activePlayer.getCurrentPosition()+"/PWR="+restored.activePlayer.getPlayWhenReady());
      check(restored.id().equals(selected),"recreated current work differs");check(restored.activePlayer.getCurrentPosition()==19000,"recreated video lost position");check(!restored.activePlayer.getPlayWhenReady(),"recreated paused video autoplayed");
    });
    test("actual new instance gallery",()->{
      JSONObject gallery=row("A").put("mediaType","gallery").put("galleryItems",new JSONArray().put(new JSONObject().put("type","image").put("url","/image/0")).put(new JSONObject().put("type","image").put("url","/image/1"))).put("sound",new JSONObject().put("previewUrl","/sound/A").put("localAvailable",true));
      Intent original=intent(gallery);CheckpointHost old=launch(original,null,directory);old.galleryPositions.put("A",1);old.select(0);old.gallerySoundPlayer.seekTo(9000);old.gallerySoundPlayer.pause();old.onPause();Bundle saved=old.save();
      CheckpointHost restored=launch(original,saved,directory);System.out.println("gallery before=index1/sound9000/paused after=index"+restored.galleryPositions.getOrDefault("A",0)+"/sound"+restored.gallerySoundPlayer.getCurrentPosition()+"/PWR="+restored.gallerySoundPlayer.getPlayWhenReady());
      check(restored.galleryPositions.getOrDefault("A",0)==1,"recreated gallery lost media index");check(restored.gallerySoundPlayer.getCurrentPosition()==9000,"recreated sound lost position");check(!restored.gallerySoundPlayer.getPlayWhenReady(),"recreated paused sound autoplayed");
    });
    for(String selected:List.of("A","B","C"))for(long position:new long[]{0,19000})for(boolean playing:new boolean[]{false,true})for(boolean afterPause:new boolean[]{false,true})test("video matrix "+selected+" "+position+" "+playing+" "+afterPause,()->{
      Intent original=intent(row("A"),row("B"));CheckpointHost old=launch(original,null,directory);
      if(selected.equals("C")){old.videos.add(item(row("C")));old.adapter.notifyDataSetChanged();old.nextFeedOffset=54;old.nextFeedCursor="cursor-C";old.hasMoreVideos=true;}
      old.select(selected.equals("A")?0:selected.equals("B")?1:2);old.activePlayer.seekTo(position);requested(old,playing);if(afterPause)old.onPause();
      Bundle saved=old.save();CheckpointHost restored=launch(original,saved,directory);
      check(restored.id().equals(selected),"saved selected id must win over original Intent index");check(restored.activePlayer.getCurrentPosition()==position,"current exact position, including zero, was not restored");check(restored.activePlayer.getPlayWhenReady()==playing,"logical play/pause changed across new instance");
      check(restored.networkReads==0,"offline saved feed must not require network or fall back to initial A");
      if(selected.equals("C")){check(restored.nextFeedOffset==54&&restored.nextFeedCursor.equals("cursor-C")&&restored.hasMoreVideos,"saved page boundary must match restored rows");check(restored.videos.size()==3,"middle page rows cannot vanish behind the saved cursor");}
      for(Object value:saved.values.values())check(value instanceof String||value instanceof Integer||value instanceof Long||value instanceof Boolean,"Bundle must carry only small scalar references, never players/models");
      check(new JSONObject(saved.values).toString().getBytes(java.nio.charset.StandardCharsets.UTF_8).length<1024,"checkpoint Bundle metadata must remain under 1KiB JSON; this is not a Parcel measurement");
    });
    for(int mediaIndex:new int[]{0,1})for(boolean videoPlay:new boolean[]{false,true})for(boolean soundPlay:new boolean[]{false,true})test("independent gallery tracks "+mediaIndex+" "+videoPlay+" "+soundPlay,()->{
      Intent original=intent(gallery("A"));CheckpointHost old=launch(original,null,directory);old.galleryPositions.put("A",mediaIndex);old.select(0);
      if(mediaIndex==1){old.activePlayer.seekTo(19000);old.activePlayer.setPlayWhenReady(videoPlay);}
      old.gallerySoundPlayer.seekTo(9000);old.gallerySoundPlayer.setPlayWhenReady(soundPlay);old.onPause();Bundle saved=old.save();CheckpointHost restored=launch(original,saved,directory);
      check(restored.galleryPositions.getOrDefault("A",-1)==mediaIndex,"saved logical media index lost");check(restored.gallerySoundPlayer.getCurrentPosition()==9000,"sound position must not use segment position");check(restored.gallerySoundPlayer.getPlayWhenReady()==soundPlay,"sound intent must remain independent");
      if(mediaIndex==1){check(restored.activePlayer.getCurrentPosition()==19000,"segment position lost");check(restored.activePlayer.getPlayWhenReady()==videoPlay,"segment intent must remain independent");}else check(restored.activePlayer==null,"image must not inherit a stale segment player");
    });
    for(boolean afterPause:new boolean[]{false,true})test("noisy before recreation "+afterPause,()->{
      Intent original=intent(gallery("A"));CheckpointHost old=launch(original,null,directory);old.galleryPositions.put("A",1);old.select(0);old.activePlayer.seekTo(19000);old.gallerySoundPlayer.seekTo(9000);if(afterPause)old.onPause();
      // Media3 resolves playWhenReady before Activity's registered noisy callback.
      old.activePlayer.pause();old.gallerySoundPlayer.pause();old.handleAudioInterruption();if(!afterPause)old.onPause();CheckpointHost restored=launch(original,old.save(),directory);
      check(!restored.activePlayer.getPlayWhenReady()&&!restored.gallerySoundPlayer.getPlayWhenReady(),"noisy must not turn into fresh playback on a new instance");check(!restored.feedPlayback.allowsAutomaticAdvance(),"noisy automatic permission must survive rebasing to new audio epoch");
      check(restored.activePlayer.getCurrentPosition()==19000&&restored.gallerySoundPlayer.getCurrentPosition()==9000,"noisy must not erase independent positions");
    });
    for(boolean playing:new boolean[]{false,true})test("author overlay and real back "+playing,()->{
      Intent original=intent(row("A"),row("B"));CheckpointHost old=launch(original,null,directory);old.select(1);old.activePlayer.seekTo(19000);requested(old,playing);old.showAuthorPanel(old.videos.get(1));old.onPause();CheckpointHost restored=launch(original,old.save(),directory);
      check(restored.currentScreen instanceof AuthorScreenState&&restored.authorOverlay!=null,"author route must survive, without opening original A");check(restored.activePlayer==null||!restored.activePlayer.getPlayWhenReady(),"restored open author panel cannot start hidden feed audio");
      restored.navigateBack();restored.drain();check(restored.id().equals("B"),"author back must restore selected parent work");check(restored.activePlayer.getCurrentPosition()==19000&&restored.activePlayer.getPlayWhenReady()==playing,"author back must restore parent position and intent independently of paused overlay");
    });
    test("author video nested return points",()->{
      Intent original=intent(row("A"),row("B"));CheckpointHost old=launch(original,null,directory);old.select(1);old.activePlayer.seekTo(19000);requested(old,false);old.showAuthorPanel(old.videos.get(1));AuthorScreenState author=(AuthorScreenState)old.currentScreen;
      FeedPage page=new FeedPage();ShortVideoItem child=item(row("C"));page.items.add(child);old.openAuthorVideo(child,page,author);old.drain();old.activePlayer.seekTo(5000);old.onPause();CheckpointHost restored=launch(original,old.save(),directory);
      check(restored.id().equals("C")&&restored.activePlayer.getCurrentPosition()==5000,"current author video cannot be replaced by the original feed");restored.navigateBack();restored.drain();check(restored.currentScreen instanceof AuthorScreenState,"first back must return to author");restored.navigateBack();restored.drain();
      check(restored.id().equals("B")&&restored.activePlayer.getCurrentPosition()==19000&&!restored.activePlayer.getPlayWhenReady(),"second back must preserve distinct parent video pause/position");
    });
    test("latest zero after lifecycle snapshot",()->{
      Intent original=intent(row("A"));CheckpointHost old=launch(original,null,directory);old.activePlayer.seekTo(19000);old.onPause();old.activePlayer.seekTo(0);CheckpointHost restored=launch(original,old.save(),directory);check(restored.activePlayer.getCurrentPosition()==0,"zero must supersede an older lifecycle position");
    });
    test("terminal failed video has a paused checkpoint",()->{
      Intent original=intent(row("A"));CheckpointHost old=launch(original,null,directory);old.activePlayer.seekTo(19000);old.handlePlaybackError(0,old.activePlayer,new PlaybackException(PlaybackException.ERROR_CODE_IO_BAD_HTTP_STATUS));check(old.activePlayer==null&&old.failedVideoRetry!=null,"actual terminal error must release the native player");old.onPause();CheckpointHost restored=launch(original,old.save(),directory);
      check(restored.activePlayer.getCurrentPosition()==19000&&!restored.activePlayer.getPlayWhenReady(),"failed video checkpoint must retain paused intent and the terminal position");
    });
    test("fresh launch remains an ordinary cold open",()->{
      CheckpointHost fresh=launch(intent(row("A")),null,directory);check(fresh.id().equals("A")&&fresh.activePlayer.getCurrentPosition()==0&&fresh.activePlayer.getPlayWhenReady(),"new non-restoring launch must keep ordinary playback behavior");
    });
    for(String change:List.of("server","scope","source","start-id"))test("new launch identity rejects old checkpoint "+change,()->{
      Intent original=intent(row("A"),row("B"));CheckpointHost old=launch(original,null,directory);old.select(1);old.activePlayer.seekTo(19000);old.onPause();Bundle saved=old.save();
      Intent different=intent(row("A"),row("B"));if(change.equals("server"))different.put("baseUrl","http://other.fixture.invalid:29998");if(change.equals("scope"))different.put("feedUrl","http://fixture.invalid:29998/api/short-videos?source=liked");if(change.equals("source"))different=intent(row("A"),row("B").put("streamUrl","/media/short-video/B?v=new"));if(change.equals("start-id"))different.put("startId","B");
      blocked(launch(different,saved,directory));
    });
    for(String damage:List.of("checksum","missing","oversize","version","failed","invalid-key","expired","future","trailing","bad-length"))test("invalid saved state stays paused "+damage,()->{
      Intent original=intent(row("A"));CheckpointHost old=launch(original,null,directory);old.activePlayer.seekTo(19000);old.onPause();Bundle saved=old.save();File file=checkpointFile(old,saved);
      if(damage.equals("checksum")){byte[] bytes=Files.readAllBytes(file.toPath());bytes[bytes.length-2]^=1;Files.write(file.toPath(),bytes);}
      if(damage.equals("missing"))check(file.delete(),"controlled checkpoint removed");
      if(damage.equals("oversize"))try(RandomAccessFile large=new RandomAccessFile(file,"rw")){large.setLength(NativeShortVideoCheckpoint.MAX_BYTES+1L);}
      if(damage.equals("expired")||damage.equals("future"))try(RandomAccessFile header=new RandomAccessFile(file,"rw")){header.seek(8);header.writeLong(System.currentTimeMillis()+(damage.equals("future")?120000:-NativeShortVideoCheckpoint.MAX_AGE_MS-60000));}
      if(damage.equals("trailing"))try(FileOutputStream append=new FileOutputStream(file,true)){append.write(1);}
      if(damage.equals("bad-length"))try(RandomAccessFile header=new RandomAccessFile(file,"rw")){header.seek(16);header.readUTF();header.readUTF();header.writeInt(Integer.MAX_VALUE);}
      if(damage.equals("version"))saved.putInt(CheckpointHost.CHECKPOINT_VERSION,999);if(damage.equals("failed"))saved.putBoolean(CheckpointHost.CHECKPOINT_FAILED,true);if(damage.equals("invalid-key"))saved.putString(CheckpointHost.CHECKPOINT_KEY,"../outside");
      blocked(launch(original,saved,directory));
    });
    test("fresh new Intent never adopts a previous launch file",()->{
      CheckpointHost old=launch(intent(row("A")),null,directory);old.activePlayer.seekTo(19000);old.onPause();old.save();Intent different=intent(row("B")).put("startId","B");CheckpointHost restored=launch(different,null,directory);check(restored.id().equals("B")&&restored.activePlayer.getCurrentPosition()==0&&restored.activePlayer.getPlayWhenReady(),"new explicit launch must not restore old A");
    });
    test("saved file budget and count",()->{
      Intent original=intent(row("A"));CheckpointHost old=launch(original,null,directory);
      for(int i=0;i<NativeShortVideoCheckpoint.MAX_FILES+3;i++)old.save();File[] files=old.checkpointDirectory().listFiles((parent,name)->name.endsWith(".state"));check(files!=null&&files.length<=NativeShortVideoCheckpoint.MAX_FILES,"checkpoint retention must remain bounded");for(File file:files)check(file.length()<=NativeShortVideoCheckpoint.MAX_BYTES,"physical checkpoint file exceeds budget");
    });
    test("pruning reserves the current file even when old mtimes sort first",()->{
      Intent original=intent(row("A"));CheckpointHost old=launch(original,null,directory);for(int i=0;i<NativeShortVideoCheckpoint.MAX_FILES;i++)old.save();
      for(File file:old.checkpointDirectory().listFiles((parent,name)->name.endsWith(".state")))check(file.setLastModified(System.currentTimeMillis()+120000),"controlled mtime assigned");
      Bundle saved=old.save();check(checkpointFile(old,saved).isFile(),"new owned checkpoint cannot be pruned");check(old.checkpointDirectory().listFiles((parent,name)->name.endsWith(".state")).length<=NativeShortVideoCheckpoint.MAX_FILES,"old-first ordering must still retain no more than MAX_FILES");
    });
    for(String limit:List.of("rows","gallery","screens"))test("actual save budget fallback "+limit,()->{
      Intent original=intent(row("A"));CheckpointHost old=launch(original,null,directory);
      if(limit.equals("rows")){for(int i=0;i<NativeShortVideoCheckpoint.MAX_ITEMS;i++)old.videos.add(item(row("extra-"+i)));old.adapter.notifyDataSetChanged();}
      if(limit.equals("gallery")){JSONArray entries=new JSONArray();for(int i=0;i<=NativeShortVideoCheckpoint.MAX_GALLERY_ITEMS;i++)entries.put(new JSONObject().put("type","image").put("url","/image/"+i));old.renderFeedScreen(new FeedScreenState(List.of(item(gallery("A").put("galleryItems",entries))),old.pendingFeedUrl,1,"",false,0));old.drain();}
      if(limit.equals("screens"))for(int i=0;i<NativeShortVideoCheckpoint.MAX_SCREENS;i++)old.navigationStack.add(old.captureFeedScreen());
      old.onPause();Bundle saved=old.save();check(!saved.getBoolean(CheckpointHost.CHECKPOINT_FAILED),"bounded fallback must be serializable");check(checkpointFile(old,saved).length()<=NativeShortVideoCheckpoint.MAX_BYTES,"fallback file budget exceeded");CheckpointHost restored=launch(original,saved,directory);blocked(restored);check(restored.checkpointRecovery!=null,"oversize route must offer an explicit recovery rather than truncate metadata/URL");
    });
    test("storage failure produces paused recoverable marker",()->{
      File blockedDirectory=new File(args[0],"blocked-private-directory");check(blockedDirectory.createNewFile(),"controlled storage obstruction created");Intent original=intent(row("A"));CheckpointHost old=launch(original,null,blockedDirectory);Bundle saved=old.save();check(saved.getBoolean(CheckpointHost.CHECKPOINT_FAILED),"write failure must be recorded");check(saved.getString(CheckpointHost.CHECKPOINT_KEY)==null,"failed publication cannot expose a key");blocked(launch(original,saved,blockedDirectory));
    });
    for(boolean noisy:new boolean[]{false,true})test("selected pending holder has its own checkpoint "+noisy,()->{
      Intent original=intent(row("A"),row("B"));CheckpointHost old=launch(original,null,directory);old.activePlayer.seekTo(19000);old.attachedHolders.remove(1);old.pager.setCurrentItem(1,false);old.requestSelectedPlayback(1,0);old.drain();
      check(old.currentIndex==1&&old.playerCache.get(0)==old.activePlayer&&!old.attachedHolders.containsKey(1),"fixture must have selected B with the still-bound A player while B awaits holder");if(noisy){old.activePlayer.pause();old.handleAudioInterruption();}
      CheckpointHost restored=launch(original,old.save(),directory);check(restored.id().equals("B")&&restored.activePlayer.getCurrentPosition()==0,"checkpoint cannot capture previous active A as the selected pending work");check(restored.activePlayer.getPlayWhenReady()!=noisy,"pending request audio epoch must survive new instance rebasing");
    });
    for(String mismatch:List.of("other-work","same-id-new-source"))test("cached player logical binding rejects wrong source "+mismatch,()->{
      Intent original=intent(row("A"),row("B"));CheckpointHost old=launch(original,null,directory);old.activePlayer.seekTo(19000);requested(old,false);
      if(mismatch.equals("other-work")){old.pager.setCurrentItem(1,false);old.currentIndex=1;old.playerCache.put(1,old.activePlayer);}
      else old.videos.set(0,item(row("A").put("streamUrl","/media/short-video/A?v=changed")));
      CheckpointHost restored=launch(original,old.save(),directory);check(restored.id().equals(mismatch.equals("other-work")?"B":"A"),"selected work lost");check(restored.activePlayer.getCurrentPosition()==0,"wrong logical binding cannot persist the former source's 19 seconds");
    });
    for(boolean playing:new boolean[]{false,true})test("compatible rendition remains the same logical source "+playing,()->{
      Intent original=intent(row("A"));CheckpointHost old=launch(original,null,directory);old.activePlayer.seekTo(19000);requested(old,playing);Object binding=old.playbackFallback.bindingOwner(old.activePlayer);
      check(old.playbackFallback.handle(old.activePlayer,old.videos.get(0),new androidx.media3.common.PlaybackException(androidx.media3.common.PlaybackException.ERROR_CODE_DECODING_FAILED),()->playing),"actual fallback must switch the effective URL");
      check(binding==old.playbackFallback.bindingOwner(old.activePlayer)&&old.playbackFallback.isBoundToItem(old.activePlayer,old.videos.get(0)),"internal compatible URL retains logical source owner");old.onPause();CheckpointHost restored=launch(original,old.save(),directory);
      check(restored.activePlayer.getCurrentPosition()==19000&&restored.activePlayer.getPlayWhenReady()==playing,"internal rendition must not be mistaken for a new unrelated source");
    });
    for(String overlay:List.of("search","comments"))test("transient overlay checkpoint stays quiet "+overlay,()->{
      Intent original=intent(row("A"));CheckpointHost old=launch(original,null,directory);old.activePlayer.seekTo(19000);if(overlay.equals("search")){old.pausePlaybackForFeedSearch();}else{old.pauseForCommentsOverlay();old.comments=true;}
      old.onPause();CheckpointHost restored=launch(original,old.save(),directory);check(restored.activePlayer.getCurrentPosition()==19000&&!restored.activePlayer.getPlayWhenReady(),"a dismissed transient overlay cannot become autoplay on recreation");
    });
    test("accepted delete cannot be resurrected by original Intent",()->{
      Intent original=intent(row("A"),row("B"));CheckpointHost old=launch(original,null,directory);old.activePlayer.seekTo(19000);
      Map<String,Object> response=new HashMap<>();response.put("ok",true);response.put("accepted",true);response.put("pending",false);response.put("status","completed");response.put("logicalDeleteCommitted",true);response.put("physicalCleanupComplete",true);response.put("jobId","fixture");response.put("cleanupPendingFiles",0);response.put("ids",List.of("A"));response.put("count",1);response.put("deletedFiles",List.of());
      old.applyCommittedDelete(DeleteResult.fromHttp(200,response,"A"),false);old.drain();old.onPause();CheckpointHost restored=launch(original,old.save(),directory);
      check(restored.id().equals("B")&&restored.videos.stream().noneMatch(value->value.id.equals("A")),"new instance must keep accepted delete rather than re-read original launch row A");
    });
    for(String response:List.of("same-source","new-source","deleted","offline","missing","null","new-gallery","new-gallery-video"))test("oversize explicit recovery "+response,()->{
      try(PrivateHttp http=new PrivateHttp()){
        Intent original=boundedIntent(http);CheckpointHost restored=recovery(original,directory);
        if(response.equals("new-source"))http.response=row("A").put("streamUrl","/media/short-video/A?v=replaced");if(response.equals("deleted"))http.status=404;if(response.equals("offline"))http.close();
        if(response.equals("missing")||response.equals("null"))http.envelope=response;
        if(response.startsWith("new-gallery")){http.response=gallery("A");if(response.equals("new-gallery-video"))http.response.put("galleryItems",new JSONArray().put(new JSONObject().put("type","video").put("url","/segment/new")));}
        restored.retryAction.run();
        if(List.of("deleted","offline","missing","null").contains(response)){waitFor(restored,()->!restored.lastStatus.equals("正在恢复当前作品"));blocked(restored);check(restored.checkpointRecovery!=null&&restored.retryAction!=null,"failed recovery must remain retryable");}
        else if(response.startsWith("new-gallery")){waitFor(restored,()->restored.gallerySoundPlayer!=null);check(restored.galleryPositions.getOrDefault("A",-1)==0,"new role must use its first valid gallery media");check(restored.gallerySoundPlayer.getCurrentPosition()==0&&!restored.gallerySoundPlayer.getPlayWhenReady(),"new soundtrack without an old saved track must still start at zero and paused");if(restored.activePlayer!=null)check(restored.activePlayer.getCurrentPosition()==0&&!restored.activePlayer.getPlayWhenReady(),"new gallery video cannot inherit ordinary source position or autoplay");}
        else{waitFor(restored,()->restored.activePlayer!=null);check(restored.id().equals("A"),"recovery chose another work");check(restored.activePlayer.getCurrentPosition()==(response.equals("same-source")?19000:0),"source replacement must not inherit old progress");check(!restored.activePlayer.getPlayWhenReady()&&!restored.hasMoreVideos,"explicit recovery must keep paused, unknown adjacency until a complete list is opened");}
        restored.feedRequests.close();
      }
    });
    for(String id:List.of("A","A /汉?z","summary"))test("canonical recovery read route "+id,()->{
      try(PrivateHttp http=new PrivateHttp()){
        http.expectedId=id;http.response=row(id).put("streamUrl","/media/short-video/synthetic");
        JSONObject initial=row(id).put("streamUrl","/media/short-video/synthetic").put("title","x".repeat(NativeShortVideoCheckpoint.MAX_STRING_BYTES+1));
        Intent original=intent(initial).put("startId",id).put("baseUrl",http.base()).put("feedUrl",http.base()+"/api/short-videos?source=authors");CheckpointHost restored=recovery(original,directory);restored.retryAction.run();
        waitFor(restored,()->restored.activePlayer!=null||(restored.checkpointRecovery!=null&&!restored.lastStatus.equals("正在恢复当前作品")));check(restored.activePlayer!=null,"canonical detail route must restore current work");check(restored.id().equals(id),"encoded ID must be decoded as the same work");
        String expected=id.equals("A /汉?z")?"GET /api/short-videos/videos/A%20%2F%E6%B1%89%3Fz":"GET /api/short-videos/videos/"+id;check(http.requests.equals(List.of(expected)),"GET path/query/method must match the actual explicit detail contract, including percent encoding and reserved IDs");restored.feedRequests.close();
      }
    });
    test("recovery image without tracks becomes video and new sound",()->{
      try(PrivateHttp http=new PrivateHttp()){
        JSONObject oldRow=gallery("A").put("sound",new JSONObject()).put("galleryItems",new JSONArray().put(new JSONObject().put("type","image").put("url","/image/old"))).put("title","x".repeat(NativeShortVideoCheckpoint.MAX_STRING_BYTES+1));
        Intent original=intent(oldRow).put("baseUrl",http.base()).put("feedUrl",http.base()+"/api/short-videos?source=authors");CheckpointHost old=launch(original,null,directory);check(old.activePlayer==null&&old.gallerySoundPlayer==null,"old actual image binding must have neither video nor playable sound track");old.onPause();CheckpointHost restored=launch(original,old.save(),directory);blocked(restored);
        http.response=gallery("A").put("galleryItems",new JSONArray().put(new JSONObject().put("type","video").put("url","/segment/new-role")));restored.retryAction.run();waitFor(restored,()->restored.activePlayer!=null&&restored.gallerySoundPlayer!=null);
        check(restored.galleryPositions.getOrDefault("A",-1)==0,"new gallery role index must be valid");check(restored.activePlayer.getCurrentPosition()==0&&!restored.activePlayer.getPlayWhenReady(),"missing old video track must not make new role autoplay");check(restored.gallerySoundPlayer.getCurrentPosition()==0&&!restored.gallerySoundPlayer.getPlayWhenReady(),"missing old sound track must not make new soundtrack autoplay");restored.feedRequests.close();
      }
    });
    test("late recovery read cannot replace a newer feed",()->{
      try(PrivateHttp http=new PrivateHttp()){
        CheckpointHost restored=recovery(boundedIntent(http),directory);http.entered=new CountDownLatch(1);http.allow=new CountDownLatch(1);restored.retryAction.run();check(http.entered.await(2,TimeUnit.SECONDS),"actual private HTTP read dispatched");
        restored.renderFeedScreen(new FeedScreenState(List.of(item(row("B"))),http.base()+"/api/short-videos?source=liked",1,"",false,0));restored.drain();http.allow.countDown();Thread.sleep(80);restored.drain();check(restored.id().equals("B"),"late checkpoint read replaced a new selected work");restored.feedRequests.close();
      }
    });
    test("legacy full empty current checkpoint cannot load original feed",()->{
      Intent original=intent(row("A"));CheckpointHost old=launch(original,null,directory);Bundle full=old.save();String scope=old.checkpointScope(),key=full.getString(CheckpointHost.CHECKPOINT_KEY);File legacy=checkpointFile(old,full);
      int magic,version;long created;JSONObject payload;try(DataInputStream in=new DataInputStream(new FileInputStream(legacy))){magic=in.readInt();version=in.readInt();created=in.readLong();in.readUTF();in.readUTF();int length=in.readInt();payload=new JSONObject(new String(in.readNBytes(length),java.nio.charset.StandardCharsets.UTF_8));}
      for(String screen:List.of("feed","current"))payload.getJSONObject(screen).put("items",new JSONArray()).put("index",0).put("playback",JSONObject.NULL);
      byte[] bytes=payload.toString().getBytes(java.nio.charset.StandardCharsets.UTF_8);String hash=java.util.HexFormat.of().formatHex(java.security.MessageDigest.getInstance("SHA-256").digest(bytes));try(DataOutputStream out=new DataOutputStream(new FileOutputStream(legacy))){out.writeInt(magic);out.writeInt(version);out.writeLong(created);out.writeUTF(scope);out.writeUTF(hash);out.writeInt(bytes.length);out.write(bytes);}
      boolean rejected=false;try{NativeShortVideoCheckpoint.read(old.checkpointDirectory(),scope,key,System.currentTimeMillis(),0);}catch(IOException expected){rejected=true;}check(rejected,"legacy empty current checkpoint must be rejected before reloading initial feed");
      Bundle state=new Bundle();state.putInt(CheckpointHost.CHECKPOINT_VERSION,NativeShortVideoCheckpoint.VERSION);state.putString(CheckpointHost.CHECKPOINT_SCOPE,scope);state.putString(CheckpointHost.CHECKPOINT_KEY,key);CheckpointHost restored=launch(original,state,directory);blocked(restored);check(restored.networkReads==0,"legacy full empty checkpoint must not dispatch original feed load");
    });
    test("paused recovery descriptor survives another Home and system restore",()->{
      Intent original=intent(row("A").put("title","x".repeat(NativeShortVideoCheckpoint.MAX_STRING_BYTES+1)));CheckpointHost old=launch(original,null,directory);old.activePlayer.seekTo(19000);old.onPause();CheckpointHost recovery=launch(original,old.save(),directory);blocked(recovery);check(recovery.checkpointRecovery!=null,"oversize current work must provide a bounded recovery descriptor");
      recovery.onPause();CheckpointHost twice=launch(original,recovery.save(),directory);blocked(twice);check(twice.checkpointRecovery!=null&&twice.checkpointRecovery.itemId.equals("A")&&twice.retryAction!=null,"Home resave must retain current descriptor and explicit retry");check(twice.networkReads==0,"descriptor resave must stay paused without automatic network playback");
    });
    check(cases>0,"test filter must select actual cases");if(!failures.isEmpty()){for(String failure:failures)System.err.println("FAIL "+failure);throw new AssertionError("checkpoint failures="+failures.size()+" cases="+cases);}
    System.out.println("native-short-video-checkpoint: "+cases+" actual Activity save/new-instance restore groups passed");
  }
}
