package local.fanhao.library;
import java.io.*;import java.nio.file.*;import java.util.*;
import android.app.Activity;import android.app.ActivityManager;import android.os.Bundle;import android.os.Handler;
import androidx.lifecycle.Lifecycle;import com.getcapacitor.PluginCall;import org.json.*;

/** Platform delivery boundaries surround actual Plugin/Registry/Native methods. */
public final class NativeShortVideoSessionHarness {
  static final String NONCE="local.fanhao.shortVideo.session";
  static File directory;static int assertions;
  static void check(boolean value,String message){assertions++;if(!value)throw new AssertionError(message);}
  static void write(String name,Object value)throws Exception{try(ObjectOutputStream out=new ObjectOutputStream(new FileOutputStream(new File(directory,name)))){out.writeObject(value);}}
  @SuppressWarnings("unchecked")static <T>T read(String name)throws Exception{try(ObjectInputStream in=new ObjectInputStream(new FileInputStream(new File(directory,name)))){return (T)in.readObject();}}
  static Bundle delivered(Bundle state){if(state==null)return null;try{ByteArrayOutputStream bytes=new ByteArrayOutputStream();try(ObjectOutputStream out=new ObjectOutputStream(bytes)){out.writeObject(state);}try(ObjectInputStream in=new ObjectInputStream(new ByteArrayInputStream(bytes.toByteArray()))){return (Bundle)in.readObject();}}catch(Exception error){throw new AssertionError(error);}}
  static class Main {
    final MainActivity activity=new MainActivity();final FanHaoPlayerPlugin plugin=new FanHaoPlayerPlugin();
    Main(Bundle saved){activity.restoreRegistry(delivered(saved));plugin.activity=activity;plugin.load();
      // Actual Bridge bootstrap delivery occurs after plugin.load and before onStart.
      plugin.testIntent(activity.getIntent());activity.life.event(Lifecycle.Event.ON_CREATE);activity.life.event(Lifecycle.Event.ON_START);plugin.testStart();}
    void resume(){activity.life.event(Lifecycle.Event.ON_RESUME);plugin.testResume();}
    void pause(){plugin.testPause();activity.life.event(Lifecycle.Event.ON_PAUSE);}
    void destroy(){plugin.testDestroy();activity.testDestroyed=true;activity.life.event(Lifecycle.Event.ON_DESTROY);}
    void ui(){Handler.pump();}void tasks(){plugin.drainTasks();}
    void recoveryUi()throws Exception{java.lang.reflect.Field field=FanHaoPlayerPlugin.class.getDeclaredField("shortVideoRecovery");field.setAccessible(true);Object recovery=field.get(plugin);java.lang.reflect.Field handler=NativeShortVideoRecovery.class.getDeclaredField("handler");handler.setAccessible(true);((Handler)handler.get(recovery)).runPending();}
    Bundle save(){return activity.saveRegistry();}
    PluginCall call(String mode){PluginCall call=new PluginCall();JSONObject a=NativeShortVideoCheckpointHarness.row("A"),b=NativeShortVideoCheckpointHarness.row("B");
      if(mode.equals("gallery"))b=NativeShortVideoCheckpointHarness.gallery("B");
      if(mode.equals("oversize-descriptor"))b.put("title","x".repeat(NativeShortVideoCheckpoint.MAX_STRING_BYTES+1));
      call.values.put("videos",new JSONObject().put("schemaVersion",1).put("videos",new JSONArray().put(a).put(b)).toString());call.values.put("baseUrl","http://fixture.invalid:29998");call.values.put("feedUrl","http://fixture.invalid:29998/api/short-videos?source=authors");call.values.put("startId","A");
      // Plugin.invoke is a background queue. Its fresh+launch transaction must wait for UI.
      return call;}
    PluginCall open(String mode){PluginCall call=call(mode);plugin.execute(()->plugin.playShortFeed(call));tasks();return call;}
  }
  static NativeShortVideoActivity nativeFrom(android.content.Intent intent,Bundle saved){return new NativeShortVideoActivity(intent,saved,directory);}
  static void selected(NativeShortVideoActivity host,String mode){host.select(1);if(mode.equals("gallery")){host.galleryPositions.put("B",1);host.select(1);host.gallerySegmentPlayer.seekTo(19000);host.gallerySoundPlayer.seekTo(9000);host.gallerySegmentPlayer.pause();}else{host.activePlayer.seekTo(mode.equals("playing-zero")?0:19000);if(!mode.equals("playing-zero"))NativeShortVideoCheckpointHarness.requested(host,false);}}
  static void save(String mode)throws Exception{
    Main main=new Main(null);main.resume();PluginCall call=main.open(mode);check(main.activity.starts==0,"fresh launch must wait for UI dispatch");main.ui();check(main.activity.starts==1,"actual Plugin must launch explicit feed once");check(call.resolves==0&&call.rejects==0,"normal Plugin Promise must remain pending for native result");
    Bundle early=main.save(),components=early.getBundle("androidx.lifecycle.BundlableSavedStateRegistry.key");check(components!=null&&components.getBundle(NativeShortVideoRecovery.STATE_KEY)!=null,"actual SavedStateRegistry provider must carry recovery marker without last PluginCall");
    NativeShortVideoActivity host=nativeFrom(main.activity.started,null);host.save();selected(host,mode);host.onPause();Bundle nativeState=host.save();
    if(mode.equals("save-failure")){Path checkpoints=new File(directory,"short-video-checkpoints").toPath(),held=new File(directory,"held-checkpoints").toPath();Files.move(checkpoints,held);Files.writeString(checkpoints,"controlled write failure");nativeState=host.save();check(nativeState.getBoolean("shortVideo.checkpoint.failed",false)&&!nativeState.containsKey("shortVideo.checkpoint.key"),"failed physical checkpoint write must expose failed standard marker");Files.delete(checkpoints);Files.move(held,checkpoints);}
    if(mode.equals("closed"))host.exitForTest();
    write("main.bundle",early);write("native.bundle",nativeState);write("original.intent",main.activity.started);
    String nonce=main.activity.started.getStringExtra(NONCE);NativeShortVideoSession.Record record=new NativeShortVideoSession(new File(directory,"short-video-sessions")).read(main.activity.taskId,nonce,System.currentTimeMillis());
    check(record.phase.equals(mode.equals("closed")?"closed":mode.equals("save-failure")?"active":"parked"),"actual Native save/exit must publish parked/closed private authority");
    if(mode.equals("save-failure"))check(record.key.isEmpty(),"failed physical save must discard previous auxiliary checkpoint pointer");
    else if(!mode.equals("closed")){NativeShortVideoCheckpoint.State state=NativeShortVideoCheckpoint.read(new File(directory,"short-video-checkpoints"),record.scope,record.key,System.currentTimeMillis(),0);check(mode.equals("oversize-descriptor")?state.recovery!=null&&state.recovery.itemId.equals("B"):state.feed.currentIndex==1,"latest private checkpoint pointer must contain B, not original A");}
    System.out.println("session save "+mode+": "+assertions+" assertions, Native B checkpoint after earlier Main marker");
  }
  static void verifyRestored(NativeShortVideoActivity host,String mode){check(host.id().equals("B"),"two-JVM actual Native startup must restore selected B instead of original A");
    if(mode.equals("gallery")){check(host.galleryPositions.get("B")==1,"gallery media index must survive");check(host.gallerySegmentPlayer.getCurrentPosition()==19000&&!host.gallerySegmentPlayer.getPlayWhenReady(),"gallery video independent paused position must restore");check(host.gallerySoundPlayer.getCurrentPosition()==9000&&host.gallerySoundPlayer.getPlayWhenReady(),"gallery sound independent playing position must restore");}
    else{check(host.activePlayer.getCurrentPosition()==(mode.equals("playing-zero")?0:19000),"two-JVM latest exact position must restore");check(host.activePlayer.getPlayWhenReady()==mode.equals("playing-zero"),"two-JVM logical play/pause must restore");}}
  static void restore(String mode)throws Exception{
    Bundle saved=read("main.bundle"),nativeSaved=read("native.bundle");android.content.Intent original=read("original.intent");
    if(mode.equals("wrong-task"))ActivityManager.task++;
    if(mode.equals("missing-checkpoint")){for(File file:new File(directory,"short-video-checkpoints").listFiles())if(file.getName().endsWith(".state"))Files.delete(file.toPath());}
    if(mode.equals("corrupt-session"))Files.writeString(new File(directory,"short-video-sessions/task-41.session").toPath(),"{}");
    NativeShortVideoActivity systemNative=null;if(mode.equals("system-native")){systemNative=nativeFrom(original,nativeSaved);verifyRestored(systemNative,"paused");ActivityManager.top=new android.content.ComponentName("local.fanhao.library",NativeShortVideoActivity.class.getName());}
    Main main=new Main(mode.equals("cold")?null:saved);main.resume();check(main.activity.starts==0,"restore must wait for posted ownership/top-task check");
    if(mode.equals("paused-before-dispatch")){main.pause();main.ui();check(main.activity.starts==0,"pause must cancel queued recovery dispatch");main.resume();}
    if(mode.equals("unavailable-top"))ActivityManager.unavailable=true;
    if(mode.equals("top-native"))ActivityManager.top=new android.content.ComponentName("local.fanhao.library",NativeShortVideoActivity.class.getName());
    if(mode.equals("new-intent"))main.plugin.testIntent(new android.content.Intent().setAction(android.content.Intent.ACTION_VIEW));
    if(mode.equals("destroyed"))main.destroy();
    if(mode.equals("fresh-before-ui")){main.plugin.playShortFeed(main.call("paused"));main.recoveryUi();check(main.activity.starts==0,"pending fresh Plugin invocation must block older restore before UI fresh transaction");main.activity.ui.runPending();check(main.activity.starts==1&&main.activity.started.getStringExtra("local.fanhao.shortVideo.claim")==null,"fresh UI launch must retain original launch intent");return;}
    if(mode.equals("fresh")){PluginCall explicit=main.open("paused");main.activity.ui.runPending();check(main.activity.starts==1&&"A".equals(main.activity.started.getStringExtra("startId")),"fresh UI transaction must establish new A owner");main.ui();check(main.activity.starts==1,"older queued restoration must not cover fresh A");return;}
    if(mode.equals("launch-failure"))main.activity.failStart=true;
    main.ui();
    if(List.of("closed","new-intent","system-native","destroyed","cold","wrong-task","missing-checkpoint","corrupt-session","unavailable-top","save-failure").contains(mode)){check(main.activity.starts==0,"closed/cold/obsolete/system-live owner must not auto-launch");if(mode.equals("save-failure")){NativeShortVideoActivity failed=nativeFrom(original,nativeSaved);check(failed.currentIndex<0&&failed.activePlayer==null&&failed.networkReads==0,"standard carrier write failure must not restore prior good checkpoint or cold A");}if(systemNative!=null){ActivityManager.top=new android.content.ComponentName("local.fanhao.library",MainActivity.class.getName());main.resume();main.ui();check(main.activity.starts==0,"live Native blocks duplicate even if top-task probe temporarily says Main");}return;}
    if(mode.equals("top-native")){check(main.activity.starts==0,"Main behind Native must not auto-launch");ActivityManager.top=new android.content.ComponentName("local.fanhao.library",MainActivity.class.getName());main.resume();main.ui();}
    if(mode.equals("launch-failure")){check(main.activity.launchAttempts==1,"recover launch failure must attempt once");main.resume();main.ui();main.activity.failStart=false;main.destroy();Main again=new Main(saved);again.resume();again.ui();check(again.activity.starts==0,"durable claim prevents a launch-failure recreation loop");return;}
    check(main.activity.starts==1,"actual Plugin registry restore must launch parked Native exactly once");
    if(mode.equals("oversize-descriptor")){
      NativeShortVideoActivity descriptor=nativeFrom(main.activity.started,null);check(descriptor.currentIndex<0&&descriptor.activePlayer==null&&descriptor.checkpointRecovery!=null&&descriptor.checkpointRecovery.itemId.equals("B")&&descriptor.retryAction!=null,"oversize descriptor must remain paused on current B with explicit retry");descriptor.onPause();Bundle state=descriptor.save();descriptor.detachForTest();NativeShortVideoActivity system=nativeFrom(main.activity.started,state);check(system.currentIndex<0&&system.activePlayer==null&&system.networkReads==0&&system.checkpointRecovery!=null&&system.checkpointRecovery.itemId.equals("B")&&system.retryAction!=null,"resaved recovery descriptor must survive system restore without cold A or losing explicit retry");return;
    }
    if(mode.equals("lost-after-claim")){
      for(File file:new File(directory,"short-video-checkpoints").listFiles())if(file.getName().endsWith(".state"))Files.delete(file.toPath());
      NativeShortVideoActivity failed=nativeFrom(main.activity.started,null);check(failed.currentIndex<0&&failed.activePlayer==null,"lost claimed checkpoint must not cold-start original A");failed.onPause();Bundle errorState=failed.save();check(errorState.getBoolean("shortVideo.checkpoint.failed",false)&&!errorState.containsKey("shortVideo.checkpoint.key"),"failed empty Native save must invalidate reference instead of publishing a full empty state");NativeShortVideoSession.Record disarmed=new NativeShortVideoSession(new File(directory,"short-video-sessions")).read(41,original.getStringExtra(NONCE),System.currentTimeMillis());check(disarmed.key.isEmpty()&&disarmed.attempts>=1,"failed empty Native save must invalidate auxiliary reference and preserve bounded attempt");failed.detachForTest();main.destroy();Main next=new Main(saved);next.resume();next.ui();check(next.activity.starts==0,"failed/empty claimed Native save must not re-authorize a recovery loop");NativeShortVideoActivity systemFailed=nativeFrom(main.activity.started,errorState);check(systemFailed.currentIndex<0&&systemFailed.activePlayer==null&&systemFailed.networkReads==0,"system restore of failed/empty Native must remain actionable and must not load original feed A");return;
    }
    NativeShortVideoActivity host=nativeFrom(main.activity.started,null);verifyRestored(host,mode.equals("gallery")?mode:mode.equals("playing-zero")?mode:"paused");main.resume();main.ui();check(main.activity.starts==1,"repeated resume must coalesce recovery");
    if(mode.equals("optional-session-io")){
      Bundle state=host.save();android.content.Intent restoredIntent=main.activity.started;host.detachForTest();Path sessions=new File(directory,"short-video-sessions").toPath(),held=new File(directory,"held-sessions").toPath();Files.move(sessions,held);Files.writeString(sessions,"controlled unavailable private session directory");
      NativeShortVideoActivity independent=nativeFrom(restoredIntent,state);check(!independent.nativeSession.isRejected(),"optional session IO must not reject genuine system checkpoint with claim");verifyRestored(independent,"paused");Files.delete(sessions);Files.move(held,sessions);return;
    }
    if(mode.equals("rejected-live")){
      host.save();NativeShortVideoActivity rejected=nativeFrom(original,null);check(rejected.nativeSession.isRejected(),"obsolete original launch must be rejected");rejected.detachForTest();Main probe=new Main(saved);probe.resume();probe.ui();check(probe.activity.starts==0,"rejected obsolete Native must not evict accepted Native LIVE owner");return;
    }
    if(mode.equals("duplicate-main")){host.onPause();host.save();host.detachForTest();Main duplicate=new Main(saved);duplicate.resume();duplicate.ui();check(duplicate.activity.starts==1,"newer checkpoint should authorize one next recovery");Main third=new Main(saved);third.resume();third.ui();check(third.activity.starts==0,"two Main consumers must not claim same checkpoint twice");return;}
    if(mode.startsWith("result")){
      if(mode.equals("result-recreated")){Bundle rotated=main.save(),state=host.save();main.destroy();host.detachForTest();host=nativeFrom(main.activity.started,state);main=new Main(rotated);main.resume();}
      Bundle resultMarker=main.save();host.acknowledgedActionResult.accept("B",new NativeShortVideoActionSnapshots.Snapshot(true,false,true,true,true,3,true,4));host.exitForTest();main.activity.results.deliver(NativeShortVideoRecovery.LAUNCHER_KEY,Activity.RESULT_OK,host.resultData);
      check(main.plugin.events.isEmpty()&&!main.plugin.tasks.isEmpty(),"recovery result must wait on real independent Plugin task queue");
      if(mode.equals("result-stale")){main.plugin.playShortFeed(main.call("paused"));main.activity.ui.runPending();}
      if(mode.equals("result-destroyed"))main.destroy();
      main.tasks();check(main.plugin.events.size()==(mode.equals("result-recreated")?1:0),"queued restored receipt must be single and must not cross fresh/destroy owner");
      if(mode.equals("result-recreated")){check(main.plugin.eventNames.equals(List.of("shortFeedRestored")),"actual Plugin must retain restored result event");check("http://fixture.invalid:29998".equals(main.plugin.events.get(0).get("serverBase")),"event server scope must derive from private bootstrap");JSONArray rows=(JSONArray)main.plugin.events.get(0).get("snapshots");check(rows.length()==1&&!rows.getJSONObject(0).getBoolean("liked"),"actual acknowledged result must preserve false server value");main.activity.results.deliver(NativeShortVideoRecovery.LAUNCHER_KEY,Activity.RESULT_OK,host.resultData);main.tasks();check(main.plugin.events.size()==1,"duplicate restored result must not emit again");main.destroy();Main replay=new Main(resultMarker);replay.resume();replay.ui();replay.activity.results.deliver(NativeShortVideoRecovery.LAUNCHER_KEY,Activity.RESULT_OK,host.resultData);replay.tasks();check(replay.plugin.events.isEmpty(),"durably consumed restored result cannot re-emit after another Main recreation");}
    }
    System.out.println("session restore "+mode+": "+assertions+" assertions, actual Plugin/Registry/Native two-JVM chain");
  }
  public static void main(String[] args)throws Exception{directory=new File(args[1]);Activity.directory=directory;if(args[0].equals("save"))save(args[2]);else restore(args[2]);}
}
