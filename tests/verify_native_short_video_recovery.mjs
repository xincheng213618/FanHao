import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { serializeShortVideoForNative } from "../android-client/www/modules/short-videos/player/native-feed-contract.js";

// Actual fallback + Activity error/manual-retry methods and mobile URL contracts.
// PlaybackException and HTTP 503 causes are the installed Media3 1.10.1 classes.
// Player, Handler and report executor alone are controlled; no report is sent,
// service started, cache touched, or real media opened.
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"..");
const native=path.join(root,"android-client/android/app/src/main/java/local/fanhao/library");
const activity=fs.readFileSync(path.join(native,"NativeShortVideoActivity.java"),"utf8").replace(/\r\n/g,"\n");
const contract=fs.readFileSync(path.join(native,"ShortVideoFeedContract.java"),"utf8").replace(/\r\n/g,"\n");
const fallback=fs.readFileSync(path.join(native,"NativeShortVideoPlaybackFallback.java"),"utf8").replace(/\r\n/g,"\n");
function member(source,name){const found=new RegExp(`^  (?:private|protected) (?:static )?[^\\n]* ${name}\\([^\\n]*`,"m").exec(source);assert(found,name);const first=source.indexOf("{",found.index);let pos=first+1,depth=1;for(;pos<source.length&&depth;pos++){if(source[pos]==="{")depth++;else if(source[pos]==="}")depth--;}return source.slice(found.index,pos);}
const source=fs.readFileSync(path.join(root,"tests/verify_native_short_video_playback.mjs"),"utf8").replace(/\r\n/g,"\n");
const env=vm.createContext({});vm.runInContext(source.slice(source.indexOf("const doubles ="),source.indexOf("\n\ntry {"))+"\nglobalThis.values=doubles;",env);
const doubles=env.values;
delete doubles["androidx/media3/common/PlaybackException.java"];delete doubles["androidx/media3/datasource/HttpDataSource.java"];delete doubles["org/json/JSONObject.java"];
doubles["local/fanhao/library/ShortVideoItem.java"]=`package local.fanhao.library;final class ShortVideoItem{final String id,streamUrl;ShortVideoItem(String id,String url){this.id=id;streamUrl=url;}boolean isGallery(){return false;}}`;
doubles["android/net/Uri.java"]=doubles["android/net/Uri.java"].replace("public Builder clearQuery()","public Builder encodedPath(String value) { return path(value); } public Builder encodedQuery(String value) { query=value; return this; } public Builder clearQuery()");
doubles["androidx/media3/exoplayer/ExoPlayer.java"]=doubles["androidx/media3/exoplayer/ExoPlayer.java"].replace("public void clearMediaItems() { touch(); }","public void clearMediaItems() { touch(); media=null; position=0; }");
doubles["android/os/Bundle.java"]=`package android.os;public class Bundle{public static final Bundle EMPTY=new Bundle();}`;
doubles["android/os/RemoteException.java"]=`package android.os;public class RemoteException extends Exception{public RemoteException(String value){super(value);}}`;
doubles["androidx/media3/common/util/Util.java"]=`package androidx.media3.common.util;public class Util{public static String intToStringMaxRadix(int value){return Integer.toString(value,36);}}`;
doubles["androidx/media3/datasource/DataSpec.java"]=`package androidx.media3.datasource;public class DataSpec{}`;
const temp=fs.mkdtempSync(path.join(os.tmpdir(),"fanhao-native-recovery-"));
const javaHome=process.env.JAVA_HOME||"C:/Program Files/Android/openjdk/jdk-21.0.8";
const tool=name=>path.join(javaHome,"bin",`${name}.exe`);
const gradle=process.env.GRADLE_USER_HOME||path.join(os.homedir(),".gradle");
function artifact(group,name,version,extension){const base=path.join(gradle,"caches/modules-2/files-2.1",group,name,version);if(!fs.existsSync(base))return "";return fs.readdirSync(base).map(hash=>path.join(base,hash,`${name}-${version}.${extension}`)).find(value=>fs.existsSync(value))||"";}
function write(folder,name,text){const target=path.join(folder,name);fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,text);return target;}
try{
  const extractor=write(temp,"ExtractAar.java",`import java.io.*;import java.util.zip.*;import java.nio.file.*;class ExtractAar{public static void main(String[]args)throws Exception{try(ZipFile zip=new ZipFile(args[0]);InputStream input=zip.getInputStream(zip.getEntry("classes.jar"))){Files.copy(input,Path.of(args[1]));}}}`);
  const compiledExtractor=spawnSync(tool("javac"),["-d",temp,extractor],{encoding:"utf8",timeout:10000});assert.equal(compiledExtractor.status,0,compiledExtractor.stderr);
  const jars=[];
  for(const name of ["media3-common","media3-datasource"]){const aar=artifact("androidx.media3",name,"1.10.1","aar");assert(aar,`requires existing product dependency ${name}:1.10.1`);const jar=path.join(temp,`${name}.jar`);const extracted=spawnSync(tool("java"),["-cp",temp,"ExtractAar",aar,jar],{encoding:"utf8",timeout:10000});assert.equal(extracted.status,0,extracted.stderr);jars.push(jar);}
  const jsonRoot=path.join(gradle,"caches/modules-2/files-2.1/org.json/json");
  const jsonJar=fs.existsSync(jsonRoot)?fs.readdirSync(jsonRoot).sort((a,b)=>b.localeCompare(a,undefined,{numeric:true})).map(version=>artifact("org.json","json",version,"jar")).find(Boolean):"";
  assert(jsonJar,"requires cached org.json test runtime");jars.push(jsonJar);
  const payload=serializeShortVideoForNative({id:"work",streamUrl:"https://fixture.invalid/media/short-video/work.mp4",mobileStreamUrl:"https://fixture.invalid/media/short-video-smooth/work.mp4?rendition=mobile-2560-h264-v4-pinned&source=original%2Bkey&v=17&retry=99&retry=100&tag=a&tag=b#viewer"});
  function run(label,implementation){
    const folder=path.join(temp,label);fs.mkdirSync(folder,{recursive:true});const files=Object.entries(doubles).map(([name,text])=>write(folder,name,text));
    const fallbackFile=write(folder,"NativeShortVideoPlaybackFallback.java",implementation);
    files.push(write(folder,"local/fanhao/library/NativeRecoveryHarness.java",`package local.fanhao.library;
import java.util.*;import java.util.concurrent.*;import android.os.*;import android.net.Uri;import org.json.JSONObject;import android.util.Log;
import androidx.media3.common.*;import androidx.media3.exoplayer.ExoPlayer;import androidx.media3.datasource.HttpDataSource;
public final class NativeRecoveryHarness {
  static class Error extends PlaybackException {Error(int code,Throwable cause){super("controlled playback error",cause,code,Bundle.EMPTY,0L);}}
  static class Reports extends AbstractExecutorService {final List<Runnable> submitted=new ArrayList<>();public void execute(Runnable value){submitted.add(value);}public void shutdown(){}public List<Runnable> shutdownNow(){return List.of();}public boolean isShutdown(){return false;}public boolean isTerminated(){return false;}public boolean awaitTermination(long value,TimeUnit unit){return true;}}
  static class PlayerView{void setPlayer(ExoPlayer value){}}static class View{static final int VISIBLE=0;}static class Cover{void setVisibility(int value){}}static class ShortVideoHolder{final int index=0;final Cover cover=new Cover();}
  static class Pager{final Handler handler;Pager(Handler value){handler=value;}void post(Runnable value){handler.post(value);}int getCurrentItem(){return 0;}}
  static class Host {
    long screenAwakeRetryGeneration;
    final Handler handler=new Handler();final Reports reports=new Reports();final NativeShortVideoPlaybackFallback playbackFallback=new NativeShortVideoPlaybackFallback(handler,reports);
    final List<ShortVideoItem> videos=new ArrayList<>();final Map<Integer,ExoPlayer> playerCache=new HashMap<>();final Map<Integer,PlayerView> playerViews=new HashMap<>();final Map<Integer,ShortVideoHolder> attachedHolders=new HashMap<>();final Set<Integer> failedPlayerIndexes=new HashSet<>();
    final Pager pager=new Pager(handler);ExoPlayer activePlayer;int currentIndex=0;boolean activityResumed=true,destroying,comments,search;Object authorOverlay;String status="";static final String TAG="fixture";
    final NativeShortVideoFeedPlayback feedPlayback=new NativeShortVideoFeedPlayback();
    ${activity.match(/  private static final class FailedVideoRetry \{[\s\S]*?\n  \}/)[0].replace("private ", "")}
    FailedVideoRetry failedVideoRetry;
    Host(String url){videos.add(new ShortVideoItem("work",url));attachedHolders.put(0,new ShortVideoHolder());preparePlayerAt(0);}
    boolean isFinishing(){return false;}boolean commentsOpen(){return comments;}boolean feedSearchOpen(){return search;}void cancelVideoPrefetch(){}void scheduleVideoPrefetch(int index){}void stopProgressUpdates(){}void updateActiveProgress(){}void showStatus(String value){status=value;}void playAt(int index){}
    void releasePlayerAt(int index){ExoPlayer player=playerCache.remove(index);if(player!=null){playbackFallback.releasePlayerResources(player);if(activePlayer==player)activePlayer=null;}}
    ExoPlayer preparePlayerAt(int index){activePlayer=new ExoPlayer();activePlayer.setPlayWhenReady(true);activePlayer.setMediaItem(MediaItem.fromUri(playbackFallback.mediaUri(activePlayer,videos.get(index))));playerCache.put(index,activePlayer);return activePlayer;}
${member(activity,"handlePlaybackError")}
${member(activity,"retryPlaybackAt")}
${member(activity,"ownsVideoRetry")}
  }
${member(contract,"mobilePlaybackUrl")}
${member(contract,"absoluteUrl")}
  static void check(boolean value,String message){if(!value)throw new AssertionError(message);}
  static PlaybackException http(int status){return new Error(PlaybackException.ERROR_CODE_IO_BAD_HTTP_STATUS,new HttpDataSource.InvalidResponseCodeException(status,"controlled",null,Map.of(),null,new byte[0]));}
  static PlaybackException timeout(){return new Error(PlaybackException.ERROR_CODE_IO_NETWORK_CONNECTION_TIMEOUT,new java.net.SocketTimeoutException("controlled timeout"));}
  static PlaybackException decode(){return new Error(PlaybackException.ERROR_CODE_DECODING_FAILED,new IllegalStateException("controlled decode"));}
  static Uri uri(ExoPlayer player){return player.media.uri;}
  public static void main(String[]args)throws Exception{
    String compatible=mobilePlaybackUrl(new JSONObject(args[0]),"https://fixture.invalid");check(compatible.contains("/media/short-video-smooth/"),"actual JS/native contract starts compatible");
    PlaybackException sdk=http(503);check(sdk.getErrorCodeName().equals("ERROR_CODE_IO_BAD_HTTP_STATUS")&&((HttpDataSource.InvalidResponseCodeException)sdk.getCause()).responseCode==503,"actual installed SDK HTTP error boundary");int checks=0;
    String original="https://fixture.invalid/media/short-video/work.mp4?source=original%2Bkey&v=17&retry=99&retry=100&tag=a&tag=b#viewer";
    {
      Host host=new Host(compatible);ExoPlayer player=host.activePlayer;Object owner=host.playbackFallback.bindingOwner(player);host.handlePlaybackError(0,player,sdk);
      check(!host.failedPlayerIndexes.contains(0)&&!player.released&&host.handler.pending.size()==1,"initial compatible 503 must schedule retry and retain player");check(!host.status.contains("无法解码")&&host.reports.submitted.isEmpty(),"temporary compatible error is not a decode/transcode report");
      player.seekTo(98765);player.setPlayWhenReady(false);host.handler.runPending();Uri target=uri(player);
      check(player.position==98765&&!player.getPlayWhenReady(),"retry keeps latest seek and explicit pause");check(host.playbackFallback.bindingOwner(player)==owner,"internal retry keeps logical binding owner");
      check(target.getQueryParameters("retry").equals(List.of("1")),"retry replaces all prior duplicate values");check(target.getQueryParameters("rendition").equals(List.of("mobile-2560-h264-v4-pinned"))&&target.getQueryParameters("source").equals(List.of("original+key"))&&target.getQueryParameters("v").equals(List.of("17"))&&target.getQueryParameters("tag").equals(List.of("a","b")),"source/rendition/version/repeated parameters remain intact");
      check(Uri.parse(host.playbackFallback.playbackUrl(host.videos.get(0))).getQueryParameters("retry").equals(List.of("1")),"effective playback URL follows the compatible attempt for later cache/source users");
      check(target.toString().endsWith("#viewer"),"fragment preserved");checks++;
    }
    for(int status:new int[]{500,502,503,504}){
      Host host=new Host(compatible);host.handlePlaybackError(0,host.activePlayer,http(status));check(host.handler.pending.size()==1&&host.reports.submitted.isEmpty(),"explicit temporary HTTP status eligible: "+status);host.handler.runPending();checks++;
    }
    for(int code:new int[]{PlaybackException.ERROR_CODE_IO_NETWORK_CONNECTION_FAILED,PlaybackException.ERROR_CODE_IO_NETWORK_CONNECTION_TIMEOUT}){
      Host host=new Host(compatible);host.handlePlaybackError(0,host.activePlayer,new Error(code,code==PlaybackException.ERROR_CODE_IO_NETWORK_CONNECTION_TIMEOUT?new java.net.SocketTimeoutException("controlled"):new java.net.ConnectException("controlled")));check(host.handler.pending.size()==1,"transient IO eligible");host.handler.runPending();checks++;
    }
    for(int status:new int[]{500,502,503,504}){
      Host host=new Host(original);ExoPlayer player=host.activePlayer;Object owner=host.playbackFallback.bindingOwner(player);host.handlePlaybackError(0,player,http(status));
      check(host.handler.pending.size()==1&&host.reports.submitted.isEmpty()&&!host.status.contains("解码")&&!host.status.contains("生成"),"original temporary HTTP retries without a decode/transcode report: "+status);
      player.seekTo(12345);player.pause();host.handler.runPending();Uri target=uri(player);
      check(target.getPath().equals("/media/short-video/work.mp4")&&!target.toString().contains("/short-video-smooth/"),"original transport failure must retry the original representation");
      check(target.getQueryParameters("retry").equals(List.of("1"))&&target.getQueryParameters("source").equals(List.of("original+key"))&&target.getQueryParameters("v").equals(List.of("17"))&&target.getQueryParameters("tag").equals(List.of("a","b"))&&target.toString().endsWith("#viewer"),"original retry preserves source, version and repeated query parameters");
      check(player.position==12345&&!player.getPlayWhenReady()&&host.playbackFallback.bindingOwner(player)==owner,"original network retry preserves latest position, pause and logical binding");
      check(Uri.parse(host.playbackFallback.playbackUrl(host.videos.get(0))).getPath().equals("/media/short-video/work.mp4"),"effective URL remains original after network retry");checks++;
    }
    for(int code:new int[]{PlaybackException.ERROR_CODE_IO_NETWORK_CONNECTION_FAILED,PlaybackException.ERROR_CODE_IO_NETWORK_CONNECTION_TIMEOUT}){
      Host host=new Host(original);host.handlePlaybackError(0,host.activePlayer,new Error(code,new java.net.SocketTimeoutException("controlled")));check(host.handler.pending.size()==1&&host.reports.submitted.isEmpty(),"original transient IO gets a bounded retry");host.handler.runPending();check(uri(host.activePlayer).getPath().equals("/media/short-video/work.mp4"),"original IO keeps the active URL");checks++;
    }
    for(int status:new int[]{400,401,403,404,410,416}){
      Host host=new Host(original);ExoPlayer player=host.activePlayer;host.handlePlaybackError(0,player,http(status));
      check(host.failedPlayerIndexes.contains(0)&&player.released&&host.handler.pending.isEmpty()&&host.reports.submitted.isEmpty(),"original permanent HTTP fails without compatibility or a decode report: "+status);checks++;
    }
    for(int code:new int[]{PlaybackException.ERROR_CODE_PARSING_CONTAINER_UNSUPPORTED,PlaybackException.ERROR_CODE_DECODER_INIT_FAILED,PlaybackException.ERROR_CODE_DECODER_QUERY_FAILED,PlaybackException.ERROR_CODE_DECODING_FAILED,PlaybackException.ERROR_CODE_DECODING_FORMAT_EXCEEDS_CAPABILITIES,PlaybackException.ERROR_CODE_DECODING_FORMAT_UNSUPPORTED}){
      Host host=new Host(original);ExoPlayer player=host.activePlayer;Object owner=host.playbackFallback.bindingOwner(player);PlaybackException failure=new Error(code,new IllegalStateException("controlled codec/format"));
      check(!failure.getErrorCodeName().equals("invalid error code"),"actual installed SDK names this capability error");host.handlePlaybackError(0,player,failure);
      check(uri(player).getPath().equals("/media/short-video-smooth/work.mp4")&&host.reports.submitted.size()==1&&host.handler.pending.isEmpty()&&!host.failedPlayerIndexes.contains(0),"genuine codec/format failure still switches and reports: "+code);
      check(host.playbackFallback.bindingOwner(player)==owner,"codec switch preserves the logical binding");checks++;
    }
    for(int code:new int[]{PlaybackException.ERROR_CODE_UNSPECIFIED,PlaybackException.ERROR_CODE_IO_UNSPECIFIED,PlaybackException.ERROR_CODE_IO_FILE_NOT_FOUND,PlaybackException.ERROR_CODE_PARSING_CONTAINER_MALFORMED}){
      Host host=new Host(original);ExoPlayer player=host.activePlayer;host.handlePlaybackError(0,player,new Error(code,new IllegalStateException("controlled permanent/unclassified")));
      check(host.failedPlayerIndexes.contains(0)&&player.released&&host.handler.pending.isEmpty()&&host.reports.submitted.isEmpty(),"non-capability errors never request a compatible transcode: "+code);checks++;
    }
    for(int status:new int[]{400,401,403,404,410,416}){
      Host host=new Host(compatible);ExoPlayer player=host.activePlayer;host.handlePlaybackError(0,player,http(status));check(host.failedPlayerIndexes.contains(0)&&player.released&&host.handler.pending.isEmpty(),"permanent HTTP does not masquerade as decode: "+status);check(host.reports.submitted.isEmpty(),"permanent compatible HTTP never reports decode");checks++;
    }
    {
      Host host=new Host(compatible);host.handlePlaybackError(0,host.activePlayer,new Error(PlaybackException.ERROR_CODE_DECODING_FAILED,new IllegalStateException("decode")));check(host.failedPlayerIndexes.contains(0)&&host.handler.pending.isEmpty()&&host.reports.submitted.isEmpty(),"already compatible decode error does not recursively transcode");checks++;
    }
    {
      Host host=new Host(compatible);ExoPlayer player=host.activePlayer;host.handlePlaybackError(0,player,http(503));Runnable pending=host.handler.pending.get(0);host.handlePlaybackError(0,player,http(404));int operations=player.operations;pending.run();check(host.failedPlayerIndexes.contains(0)&&host.handler.pending.isEmpty()&&player.operations==operations,"permanent failure cancels a preceding temporary retry without touching a released player");checks++;
    }
    {
      Host host=new Host(original);ExoPlayer player=host.activePlayer;Object owner=host.playbackFallback.bindingOwner(player);host.handlePlaybackError(0,player,http(503));Runnable old=host.handler.pending.get(0);player.seekTo(6789);host.handlePlaybackError(0,player,decode());
      check(host.handler.pending.isEmpty()&&uri(player).getPath().equals("/media/short-video-smooth/work.mp4")&&player.position==6789&&host.reports.submitted.size()==1,"codec switch retires a queued original-network retry");
      int operations=player.operations;String next=uri(player).toString();old.run();check(player.operations==operations&&uri(player).toString().equals(next)&&host.playbackFallback.bindingOwner(player)==owner,"retained original callback cannot restore the old source after internal compatible switch");
      host.handlePlaybackError(0,player,http(503));host.handler.runPending();check(uri(player).getPath().equals("/media/short-video-smooth/work.mp4")&&uri(player).getQueryParameters("retry").equals(List.of("2")),"post-switch transient retry uses current compatible URL and shared four-attempt budget");checks++;
    }
    for(int status:new int[]{400,401,403,404,410,416}){
      Host host=new Host(original);ExoPlayer player=host.activePlayer;host.handlePlaybackError(0,player,decode());host.handlePlaybackError(0,player,http(status));check(host.failedPlayerIndexes.contains(0)&&player.released&&host.handler.pending.isEmpty()&&host.reports.submitted.size()==1,"post-fallback permanent HTTP fails without retry or another report: "+status);checks++;
    }
    {
      Host host=new Host(compatible);for(int attempt=1;attempt<=4;attempt++){
        for(int duplicate=0;duplicate<10;duplicate++)host.handlePlaybackError(0,host.activePlayer,http(503));check(host.handler.pending.size()==1,"repeat error callbacks share one pending retry");host.handler.runPending();check(uri(host.activePlayer).getQueryParameters("retry").equals(List.of(String.valueOf(attempt))),"exactly one retry value per bounded attempt");
      }
      ExoPlayer old=host.activePlayer;Object owner=host.playbackFallback.bindingOwner(old);host.handlePlaybackError(0,old,http(503));check(host.failedPlayerIndexes.contains(0)&&old.released&&host.handler.pending.isEmpty(),"fifth failure exhausts four automatic attempts");
      host.retryPlaybackAt(0);host.handler.runPending();check(!host.playbackFallback.isBound(old,owner)&&host.playbackFallback.bindingOwner(old)==null,"released player loses binding token");host.handlePlaybackError(0,host.activePlayer,http(503));check(host.handler.pending.size()==1,"explicit retry resets the bounded budget");host.handler.runPending();check(uri(host.activePlayer).getQueryParameters("retry").equals(List.of("1")),"explicit retry starts fresh attempt one");checks++;
    }
    for(String change:new String[]{"background","comments","search","author","new-current"}){
      Host host=new Host(compatible);ExoPlayer player=host.activePlayer;host.handlePlaybackError(0,player,timeout());
      if(change.equals("background"))host.activityResumed=false;if(change.equals("comments"))host.comments=true;if(change.equals("search"))host.search=true;if(change.equals("author"))host.authorOverlay=new Object();if(change.equals("new-current"))host.currentIndex=1;
      host.handler.runPending();check(!player.getPlayWhenReady(),"delayed retry rechecks live playback intent: "+change);checks++;
    }
    {
      Host host=new Host(compatible);ExoPlayer player=host.activePlayer;Object old=host.playbackFallback.bindingOwner(player);host.handlePlaybackError(0,player,http(503));Runnable callback=host.handler.pending.get(0);
      ShortVideoItem replacement=new ShortVideoItem("work",compatible.replace("v=17","v=18"));player.setMediaItem(MediaItem.fromUri(host.playbackFallback.mediaUri(player,replacement)));Object fresh=host.playbackFallback.bindingOwner(player);int prepares=player.prepares;String url=uri(player).toString();callback.run();
      check(old!=fresh&&!host.playbackFallback.isBound(player,old)&&host.playbackFallback.isBound(player,fresh),"same-id new logical source gets a fresh owner");check(player.prepares==prepares&&uri(player).toString().equals(url),"late old retry cannot steal same-id rebound source");checks++;
    }
    {
      Host host=new Host(compatible);ExoPlayer player=host.activePlayer;Object owner=host.playbackFallback.bindingOwner(player);host.handlePlaybackError(0,player,http(503));Runnable callback=host.handler.pending.get(0);host.playbackFallback.release(player);int operations=player.operations;callback.run();check(player.operations==operations&&!host.playbackFallback.isBound(player,owner),"release cancels even an already retained callback");checks++;
    }
    {
      Host host=new Host("https://fixture.invalid/media/short-video/work.mp4");ExoPlayer player=host.activePlayer;Object owner=host.playbackFallback.bindingOwner(player);host.handlePlaybackError(0,player,new Error(PlaybackException.ERROR_CODE_DECODING_FAILED,new IllegalStateException("decode")));
      check(uri(player).toString().contains("/media/short-video-smooth/")&&host.playbackFallback.bindingOwner(player)==owner,"real decode switch retains source binding owner");check(host.reports.submitted.size()==1,"existing source decode report remains unchanged and unexecuted");
      for(int attempt=0;attempt<4;attempt++){host.handlePlaybackError(0,player,http(503));check(host.handler.pending.size()==1,"existing post-decode compatible retry path retained");host.handler.runPending();check(host.playbackFallback.bindingOwner(player)==owner,"post-decode retries preserve owner");}host.handlePlaybackError(0,player,http(503));check(host.failedPlayerIndexes.contains(0),"existing post-decode budget still bounded");checks++;
    }
    {
      Host host=new Host(original);ExoPlayer player=host.activePlayer;for(int attempt=1;attempt<=4;attempt++){host.handlePlaybackError(0,player,http(503));host.handler.runPending();check(uri(player).getPath().equals("/media/short-video/work.mp4")&&uri(player).getQueryParameters("retry").equals(List.of(String.valueOf(attempt))),"original network attempts remain bounded on original URL");}
      host.handlePlaybackError(0,player,http(503));check(host.failedPlayerIndexes.contains(0)&&player.released&&host.reports.submitted.isEmpty(),"original network failure exhausts four retries without reporting decode");checks++;
    }
    System.out.println("native-short-video-recovery: "+checks+" actual SDK/Activity/fallback error classification, current-URL retry, query preservation, intent, binding and budget cases passed");
  }
}
`));
    const dependencies=[folder,...jars].join(path.delimiter);
    const compiled=spawnSync(tool("javac"),["-encoding","UTF-8","-cp",dependencies,"-d",folder,...files,fallbackFile,path.join(native,"NativeShortVideoFeedPlayback.java")],{encoding:"utf8",timeout:15000});assert.equal(compiled.status,0,compiled.stderr||compiled.error?.message);
    return spawnSync(tool("java"),["-Dfile.encoding=UTF-8","-Dstdout.encoding=UTF-8","-cp",dependencies,"local.fanhao.library.NativeRecoveryHarness",JSON.stringify(payload)],{encoding:"utf8",timeout:15000});
  }
  const current=run("current",fallback);assert.equal(current.status,0,current.stderr||current.error?.message);process.stdout.write(current.stdout);
  const unsafeCompatible=fallback.replace('if (isTemporaryNetworkError(error)) return scheduleRetry(player, item, shouldPlay, binding);','if (false) return scheduleRetry(player, item, shouldPlay, binding);');assert.notEqual(unsafeCompatible,fallback);const initial=run("network-retry-removed",unsafeCompatible);assert.notEqual(initial.status,0);assert.match(initial.stderr,/initial compatible 503 must schedule retry/);
  const unsafeQuery=fallback.replace('        if ("retry".equals(name)) continue;',"");assert.notEqual(unsafeQuery,fallback);const duplicate=run("retry-appended",unsafeQuery);assert.notEqual(duplicate.status,0);assert.match(duplicate.stderr,/retry replaces all prior duplicate values/);
  const unsafeClassification=fallback.replace('if (!isDecodeCapabilityError(error) || isCompatibleUrl(binding.url)) return false;','if (isCompatibleUrl(binding.url)) return false;');assert.notEqual(unsafeClassification,fallback);const classified=run("all-errors-decode",unsafeClassification);assert.notEqual(classified.status,0);assert.match(classified.stderr,/original permanent HTTP fails without compatibility or a decode report/);
  console.log("native-short-video-recovery: removed network retry, duplicate retry parameters and non-codec decode/transcode classification negative controls rejected");
}finally{const resolved=path.resolve(temp);assert(resolved.startsWith(path.resolve(os.tmpdir())+path.sep));fs.rmSync(resolved,{recursive:true,force:true});}
