package local.fanhao.library;

import android.app.Activity;
import android.content.Intent;
import android.os.Bundle;
import android.os.Handler;
import android.os.ResultReceiver;
import com.getcapacitor.JSObject;
import com.getcapacitor.PluginCall;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.OutputStream;
import java.lang.ref.WeakReference;
import java.lang.reflect.Field;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLConnection;
import java.net.URLStreamHandler;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

/** Complete production writer/plugin plus extracted real Activity methods.
 * Android parcel transport, player and Capacitor queue are observable doubles.
 * No real HTTP, database, device, sleep, or claimed end-to-end WebView result. */
public final class NativeVideoProgressCommitHarness {
  private static final String URL_A="http://synthetic.invalid/api/progress/video-a";
  private static final List<String> failures=new ArrayList<>();
  private static int cases;
  public static void main(String[] args) throws Exception {
    java.net.CookieHandler.setDefault(new ServerAuthSession());
    URL.setURLStreamHandlerFactory(protocol->"http".equals(protocol)?new URLStreamHandler(){
      @Override protected URLConnection openConnection(URL url){Connection c=new Connection(url);connections.add(c);return c;}
    }:null);
    for(int code:new int[]{200,201,204,299,199,300,301,302,307,308,400,401,403,404,408,429,500,503}) {
      check("HTTP status "+code+" controls acknowledgement",()->{
        reset(code); AtomicInteger acks=new AtomicInteger();
        NativePlaybackProgress writer=new NativePlaybackProgress(URL_A,"",snapshot->acks.incrementAndGet());
        writer.report(URL_A,"work-a",190,600); writer.close(); settled(writer);
        require(acks.get()==(code>=200&&code<300?1:0),"non-2xx cannot acknowledge; 2xx must acknowledge");
        require(connections.size()==1,"failed HTTP must not auto-retry");
        require(connections.get(0).disconnected,"connection must disconnect");
        require(!connections.get(0).getInstanceFollowRedirects(),"redirect could acknowledge another endpoint");
      });
    }
    for(String failure:new String[]{"write-error","response-error"})check(failure+" cannot acknowledge",()->{
      reset(200);AtomicInteger acks=new AtomicInteger();
      NativePlaybackProgress writer=new NativePlaybackProgress(URL_A,"",snapshot->acks.incrementAndGet());
      writer.report(URL_A+"/"+failure,null,190,600);writer.close();settled(writer);
      require(acks.get()==0&&connections.size()==1&&connections.get(0).disconnected,"failed transport acknowledged or retried/leaked");
    });
    check("instant launch preserves all parameters and does not claim a commit",()->{
      FanHaoPlayerPlugin plugin=new FanHaoPlayerPlugin();PluginCall call=call("session-a");plugin.play(call);
      require(call.resolves==1&&Boolean.TRUE.equals(call.result.get("opened")),"play must still resolve immediately");
      require(plugin.events.isEmpty()&&plugin.tasks.isEmpty(),"launch is not a commit");
      Intent intent=plugin.activity.started;
      for(String key:new String[]{"url","fallbackUrl","title","subtitle","progressUrl","workId","videoId","mode","position","duration"})
        require(call.values.get(key).equals(intent.extras.get(key)),"play parameter lost: "+key);
      require(receiver(plugin)!=null,"Intent receipt endpoint missing");
    });
    check("commit crosses ResultReceiver then Capacitor task handler with immutable identity",()->{
      FanHaoPlayerPlugin plugin=opened("session-a");ResultReceiver receiver=receiver(plugin);
      Bundle forged=new Bundle();forged.putString("videoId","wrong");forged.putString("progressUrl","http://wrong.invalid");
      receiver.send(Activity.RESULT_OK,forged);
      require(plugin.events.isEmpty()&&plugin.tasks.isEmpty(),"receiver must use its platform handler");
      drainReceivers();require(plugin.events.isEmpty()&&plugin.tasks.size()==1,"notification bypassed Capacitor task handler");
      plugin.drainTasks();assertReceipt(plugin,"session-a");
      require(!plugin.events.get(0).containsKey("position"),"receipt must not pretend to be authoritative progress data");
    });
    check("non-success ResultReceiver messages cannot queue receipts",()->{
      FanHaoPlayerPlugin plugin=opened("session-a");receiver(plugin).send(Activity.RESULT_CANCELED,null);drainReceivers();plugin.drainTasks();
      require(plugin.events.isEmpty(),"non-success receiver result acknowledged");
    });
    check("new launch invalidates a queued older session receipt",()->{
      FanHaoPlayerPlugin plugin=opened("session-a");ResultReceiver old=receiver(plugin);old.send(Activity.RESULT_OK,null);drainReceivers();
      plugin.play(call("session-b"));plugin.drainTasks();require(plugin.events.isEmpty(),"queued old session reached new playback");
      receiver(plugin).send(Activity.RESULT_OK,null);drainReceivers();plugin.drainTasks();assertReceipt(plugin,"session-b");
    });
    check("same video and reused caller token still require current receiver identity",()->{
      FanHaoPlayerPlugin plugin=opened("same");ResultReceiver old=receiver(plugin);plugin.play(call("same"));
      old.send(Activity.RESULT_OK,null);drainReceivers();plugin.drainTasks();require(plugin.events.isEmpty(),"receiver identity replaced by value equality");
    });
    check("destroy invalidates pending and later receipt delivery",()->{
      FanHaoPlayerPlugin plugin=opened("session-a");ResultReceiver endpoint=receiver(plugin);endpoint.send(Activity.RESULT_OK,null);drainReceivers();
      plugin.handleOnDestroy();plugin.drainTasks();endpoint.send(Activity.RESULT_OK,null);drainReceivers();plugin.drainTasks();
      require(plugin.events.isEmpty()&&plugin.destroyCalls==1,"destroyed plugin emitted receipts");
      PluginCall call=call("session-b");plugin.play(call);require(call.rejects==1&&plugin.activity.starts==1,"destroyed plugin launched again");
    });
    check("failed launch preserves previous active receiver",()->{
      FanHaoPlayerPlugin plugin=opened("session-a");ResultReceiver endpoint=receiver(plugin);plugin.activity.failStart=true;
      PluginCall failed=call("session-b");plugin.play(failed);require(failed.rejects==1&&failed.resolves==0,"launch failure escaped or resolved");
      endpoint.send(Activity.RESULT_OK,null);drainReceivers();plugin.drainTasks();assertReceipt(plugin,"session-a");
    });
    check("detached launch is rejected and blank URL cannot launch",()->{
      FanHaoPlayerPlugin plugin=new FanHaoPlayerPlugin();plugin.activity=null;PluginCall a=call("session-a");plugin.play(a);require(a.rejects==1,"detached construction escaped");
      plugin=new FanHaoPlayerPlugin();a=call("session-a");a.values.put("url"," ");plugin.play(a);require(a.rejects==1&&plugin.activity.starts==0,"blank URL launched");
    });
    check("legacy callers without receipt identity still launch and invalidate previous receiver",()->{
      for(String key:new String[]{"progressSessionId","videoId","progressUrl"}){
        FanHaoPlayerPlugin plugin=opened("session-a");ResultReceiver endpoint=receiver(plugin);PluginCall legacy=call("session-b");legacy.values.remove(key);plugin.play(legacy);
        require(legacy.resolves==1&&receiver(plugin)==null,"legacy play requires optional receipt identity");
        endpoint.send(Activity.RESULT_OK,null);drainReceivers();plugin.drainTasks();require(plugin.events.isEmpty(),"legacy new launch retained old receiver");
      }
    });
    check("weak receiver owner does not retain the plugin",()->{
      FanHaoPlayerPlugin plugin=opened("session-a");ResultReceiver endpoint=receiver(plugin);
      Field owner=endpoint.getClass().getDeclaredField("owner");owner.setAccessible(true);
      require(owner.get(endpoint) instanceof WeakReference,"strong owner reference");((WeakReference<?>)owner.get(endpoint)).clear();
      endpoint.send(Activity.RESULT_OK,null);drainReceivers();plugin.drainTasks();require(plugin.events.isEmpty(),"cleared weak owner emitted receipt");
      for(Field field:endpoint.getClass().getDeclaredFields())require(!FanHaoPlayerPlugin.class.isAssignableFrom(field.getType())&&!Activity.class.isAssignableFrom(field.getType()),"receiver has strong Activity/plugin field");
    });
    check("bridge scheduling and listener exceptions do not escape",()->{
      FanHaoPlayerPlugin plugin=opened("session-a");plugin.failExecute=true;receiver(plugin).send(Activity.RESULT_OK,null);drainReceivers();
      plugin.failExecute=false;plugin.failNotify=true;receiver(plugin).send(Activity.RESULT_OK,null);drainReceivers();plugin.drainTasks();
      plugin.failNotify=false;receiver(plugin).send(Activity.RESULT_OK,null);drainReceivers();plugin.drainTasks();assertReceipt(plugin,"session-a");
    });
    check("Activity factory cannot acknowledge a different source URL",()->{
      reset(200);FanHaoPlayerPlugin plugin=opened("session-a");NativePlaybackProgress writer=NativeVideoProgressHost.createProgress(receiver(plugin),URL_A,"");
      writer.report("http://synthetic.invalid/api/progress/different-video",null,190,600);writer.close();settled(writer);drainReceivers();plugin.drainTasks();
      require(plugin.events.isEmpty(),"different source incorrectly acknowledged as original");
    });
    check("late final commit refreshes after Activity release without waiting for network",()->{
      reset(200);release=new CountDownLatch(1);FanHaoPlayerPlugin plugin=opened("session-a");
      NativePlaybackProgress writer=NativeVideoProgressHost.createProgress(receiver(plugin),URL_A,"");
      NativeVideoProgressHost host=new NativeVideoProgressHost(writer);host.progressUrl=URL_A;host.player.position=190000;host.player.duration=600000;
      host.onPause();require(entered.await(3,TimeUnit.SECONDS),"POST never entered");host.onDestroy();
      require(host.player==null&&plugin.events.isEmpty(),"Activity waited for commit or receipt arrived early");
      require(serverPosition==73,"controlled return GET must still see old position");
      release.countDown();settled(writer);require(serverPosition==190,"final POST did not commit");
      drainReceivers();plugin.drainTasks();require(!plugin.events.isEmpty(),"late commit cannot refresh returned page");
      assertReceipt(plugin,"session-a");
      Field callback=NativePlaybackProgress.class.getDeclaredField("committed");callback.setAccessible(true);
      for(Field field:callback.get(writer).getClass().getDeclaredFields())require(!Activity.class.isAssignableFrom(field.getType())&&!NativeVideoProgressHost.class.isAssignableFrom(field.getType()),"worker callback captures Activity");
    });
    check("listener failure cannot strand a newer accepted final position",()->{
      reset(200);AtomicInteger ack=new AtomicInteger();NativePlaybackProgress[] owner=new NativePlaybackProgress[1];
      owner[0]=new NativePlaybackProgress(URL_A,"",snapshot->{
        if(ack.incrementAndGet()==1){owner[0].report(URL_A,null,190,600);owner[0].close();throw new IllegalStateException("listener unavailable");}
      });
      owner[0].report(URL_A,null,150,600);
      try { settledAfterClose(owner[0]); } finally { owner[0].close(); settled(owner[0]); }
      require(ack.get()==2&&serverPosition==190,"failed listener interrupted final drain");
    });
    check("launch captures native session and never exposes it through bridge results",()->{
      reset(200);ServerAuthSession sessions=sessions();String token=accountToken('a');sessions.save(URL_A,token);
      PluginCall call=call("account-a");call.values.put("progressAuthToken",accountToken('b'));
      FanHaoPlayerPlugin plugin=new FanHaoPlayerPlugin();plugin.play(call);
      require(token.equals(plugin.activity.started.getStringExtra(NativePlayerActivity.EXTRA_PROGRESS_AUTH_TOKEN)),"play must capture native credentials, not trust caller token");
      require(!call.result.toString().contains(token)&&!call.result.containsKey("progressAuthToken"),"private token leaked in launch result");
      receiver(plugin).send(Activity.RESULT_OK,null);drainReceivers();plugin.drainTasks();
      require(plugin.events.size()==1&&!plugin.events.get(0).toString().contains(token),"private token leaked in commit receipt");
    });
    for(String initial:new String[]{"account","guest","legacy"})check(initial+" playback cannot commit after account switch",()->{
      reset(200);ServerAuthSession sessions=sessions();String token="guest".equals(initial)?"":"legacy".equals(initial)?legacyToken():accountToken('a');
      sessions.save(URL_A,token);FanHaoPlayerPlugin plugin=opened("owner-a");
      String captured=plugin.activity.started.getStringExtra(NativePlayerActivity.EXTRA_PROGRESS_AUTH_TOKEN);
      sessions.save(URL_A,accountToken('b'));
      NativePlaybackProgress writer=NativeVideoProgressHost.createProgress(receiver(plugin),URL_A,captured);
      writer.report(URL_A,"work-a",190,600);writer.close();settled(writer);drainReceivers();plugin.drainTasks();
      require(connections.isEmpty()&&plugin.events.isEmpty(),"changed account sent or acknowledged old progress");
    });
    check("logout blocks an old player's final progress instead of writing guest history",()->{
      reset(200);ServerAuthSession sessions=sessions();sessions.save(URL_A,accountToken('a'));
      FanHaoPlayerPlugin plugin=opened("owner-a");String captured=plugin.activity.started.getStringExtra(NativePlayerActivity.EXTRA_PROGRESS_AUTH_TOKEN);
      sessions.save(URL_A,"");NativePlaybackProgress writer=NativeVideoProgressHost.createProgress(receiver(plugin),URL_A,captured);
      writer.report(URL_A,"work-a",190,600);writer.close();settled(writer);
      require(connections.isEmpty(),"logged-out account became a guest write");
    });
    for(boolean guest:new boolean[]{false,true})check((guest?"guest":"account")+" cookie stays pinned during a concurrent login",()->{
      reset(200);ServerAuthSession sessions=sessions();String token=guest?"":accountToken('a');String nextToken=accountToken('b');sessions.save(URL_A,token);
      FanHaoPlayerPlugin plugin=opened("owner-a");String captured=plugin.activity.started.getStringExtra(NativePlayerActivity.EXTRA_PROGRESS_AUTH_TOKEN);
      beforeCookies=()->sessions.save(URL_A,nextToken);
      NativePlaybackProgress writer=NativeVideoProgressHost.createProgress(receiver(plugin),URL_A,captured);
      writer.report(URL_A,"work-a",190,600);writer.close();settled(writer);drainReceivers();plugin.drainTasks();
      require(connections.size()==1,"controlled request did not send");Connection sent=connections.get(0);
      require((guest?"":"fanhao_web_auth="+token).equals(sent.cookie),"CookieHandler attached another account during the request");
      require(guest?sent.getRequestProperty("Authorization")==null:("Bearer "+token).equals(sent.getRequestProperty("Authorization")),"bearer must use captured owner");
      require(guest?"guest".equals(sent.getRequestProperty("X-FanHao-Account-Owner")):sent.getRequestProperty("X-FanHao-Account-Owner")==null,"guest owner assertion changed");
      require(!sent.bytes.toString(java.nio.charset.StandardCharsets.UTF_8).contains("usr."),"credential leaked into progress JSON");
      require(plugin.events.isEmpty(),"successful old request refreshed a different account after switch");
      require(sessions.get(new java.net.URI(URL_A),java.util.Collections.emptyMap()).toString().contains(nextToken),"request cookie override escaped its worker");
    });
    check("legacy guest playback retains its original credential and guest assertion",()->{
      reset(200);ServerAuthSession sessions=sessions();String token=legacyToken();sessions.save(URL_A,token);
      NativePlaybackProgress writer=new NativePlaybackProgress(URL_A,token,null);writer.report(URL_A,"work-a",190,600);writer.close();settled(writer);
      require(connections.size()==1&&("Bearer "+token).equals(connections.get(0).getRequestProperty("Authorization")),"legacy session stopped working");
      require("guest".equals(connections.get(0).getRequestProperty("X-FanHao-Account-Owner")),"legacy session must remain in guest data");
    });
    check("missing private snapshot and cross-origin URL fail closed without blocking launch",()->{
      for(String captured:new String[]{null,""}){
        reset(200);sessions();FanHaoPlayerPlugin plugin=opened("owner-a");
        NativePlaybackProgress writer=NativeVideoProgressHost.createProgress(receiver(plugin),URL_A,captured);
        writer.report(captured==null?URL_A:"http://foreign.invalid/api/progress","work-a",190,600);writer.close();settled(writer);
        require(connections.isEmpty(),"missing or foreign owner sent progress");
      }
    });
    check("expired captured account fails closed even if the token still exists",()->{
      reset(200);ServerAuthSession sessions=sessions();String expired="usr.1."+repeat('e',43);
      Field tokens=ServerAuthSession.class.getDeclaredField("tokens");tokens.setAccessible(true);
      @SuppressWarnings("unchecked") java.util.Map<String,String> raw=(java.util.Map<String,String>)tokens.get(sessions);
      raw.put(ServerAuthSession.origin(URL_A),expired);
      require(expired.equals(ServerAuthSession.captureToken(URL_A)),"expired account was converted to guest at capture");
      NativePlaybackProgress writer=new NativePlaybackProgress(URL_A,expired,null);writer.report(URL_A,"work-a",190,600);writer.close();settled(writer);
      require(connections.isEmpty(),"expired account sent or fell back to guest");
    });
    if(!failures.isEmpty())throw new AssertionError(String.join("\n",failures));
    System.out.println("native-video-progress-commit: "+cases+" transport/receiver/plugin/lifecycle cases passed (no device or network)");
  }
  private static PluginCall call(String session){
    PluginCall call=new PluginCall();call.values.put("url","http://synthetic.invalid/stream/video-a");call.values.put("fallbackUrl","http://synthetic.invalid/fallback");
    call.values.put("title","Synthetic movie");call.values.put("subtitle","Synthetic subtitle");call.values.put("progressUrl",URL_A);call.values.put("workId","work-a");
    call.values.put("videoId","video-a");call.values.put("mode","gallery-media");call.values.put("progressSessionId",session);call.values.put("position",73.0);call.values.put("duration",600.0);return call;
  }
  private static FanHaoPlayerPlugin opened(String session){FanHaoPlayerPlugin plugin=new FanHaoPlayerPlugin();PluginCall call=call(session);plugin.play(call);require(call.resolves==1,"fixture launch failed");return plugin;}
  private static ResultReceiver receiver(FanHaoPlayerPlugin plugin){return plugin.activity.started.getParcelableExtra(NativePlayerActivity.EXTRA_PROGRESS_RECEIVER);}
  private static void drainReceivers(){for(Handler handler:new ArrayList<>(Handler.receiptHandlers))handler.runPending();}
  private static void assertReceipt(FanHaoPlayerPlugin plugin,String session){
    require(!plugin.events.isEmpty(),"receipt missing");JSObject receipt=plugin.events.get(plugin.events.size()-1);
    require(session.equals(receipt.get("progressSessionId"))&&"video-a".equals(receipt.get("videoId"))&&URL_A.equals(receipt.get("progressUrl"))&&"gallery-media".equals(receipt.get("mode")),"receipt identity mismatch");
  }
  private static ExecutorService executor(NativePlaybackProgress writer)throws Exception{Field field=NativePlaybackProgress.class.getDeclaredField("executor");field.setAccessible(true);return (ExecutorService)field.get(writer);}
  private static void settled(NativePlaybackProgress writer)throws Exception{require(executor(writer).awaitTermination(4,TimeUnit.SECONDS),"writer did not settle");}
  private static void settledAfterClose(NativePlaybackProgress writer)throws Exception{require(executor(writer).awaitTermination(4,TimeUnit.SECONDS),"callback close did not settle");}
  private static int responseStatus;private static volatile double serverPosition;
  private static volatile Runnable beforeCookies;
  private static CountDownLatch entered,release;
  private static final List<Connection> connections=new java.util.concurrent.CopyOnWriteArrayList<>();
  private static void reset(int status){responseStatus=status;serverPosition=73;connections.clear();entered=new CountDownLatch(1);release=new CountDownLatch(0);beforeCookies=null;}
  private static ServerAuthSession sessions(){ServerAuthSession value=new ServerAuthSession();java.net.CookieHandler.setDefault(value);return value;}
  private static String repeat(char value,int length){char[] chars=new char[length];java.util.Arrays.fill(chars,value);return new String(chars);}
  private static String accountToken(char value){return "usr."+(System.currentTimeMillis()/1000)+"."+repeat(value,43);}
  private static String legacyToken(){return "web."+(System.currentTimeMillis()/1000)+".abcdefghijklmnop."+repeat('l',43);}
  private static final class Connection extends HttpURLConnection {
    final ByteArrayOutputStream bytes=new ByteArrayOutputStream();boolean disconnected;String cookie="";
    Connection(URL url){super(url);}
    public void connect(){}public boolean usingProxy(){return false;}public void disconnect(){disconnected=true;}
    public OutputStream getOutputStream()throws IOException{
      entered.countDown();try{require(release.await(3,TimeUnit.SECONDS),"controlled POST not released");}catch(InterruptedException error){throw new IOException(error);}
      Runnable change=beforeCookies;beforeCookies=null;if(change!=null)change.run();
      try {java.util.List<String> values=java.net.CookieHandler.getDefault().get(url.toURI(),java.util.Collections.emptyMap()).get("Cookie");cookie=values==null?"":String.join("; ",values);}
      catch(java.net.URISyntaxException error){throw new IOException(error);}
      if(url.getPath().contains("write-error"))throw new IOException("synthetic write error");return bytes;
    }
    public int getResponseCode()throws IOException{
      if(url.getPath().contains("response-error"))throw new IOException("synthetic response error");
      if(responseStatus>=200&&responseStatus<300){java.util.regex.Matcher m=java.util.regex.Pattern.compile("\\\"position\\\":([0-9.]+)").matcher(bytes.toString(java.nio.charset.StandardCharsets.UTF_8));require(m.find(),"payload missing");serverPosition=Double.parseDouble(m.group(1));}
      return responseStatus;
    }
  }
  private interface Case{void run()throws Exception;}
  private static void check(String name,Case test){cases++;try{test.run();}catch(Throwable error){failures.add(name+": "+error);}finally{if(release!=null)release.countDown();}}
  private static void require(boolean value,String message){if(!value)throw new AssertionError(message);}
}
